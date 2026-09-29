/** herdr's data plane. One NDJSON request per connection; only subscriptions stay open. */
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { execFileTool } from './spawn';
import { compareVersions } from './semver';
import { readHerdrLock } from './herdr-install';
import { performance } from 'perf_hooks';
import type { Check } from './diagnose';
import type { Method, Params, Result, Protocol, Subscription, HerdrEvent, SessionSnapshot } from './herdr-api';

export type { Method, Params, Result, Subscription, HerdrEvent, AgentStatus, PaneAgentState } from './herdr-api';
// Names such as TabInfo already belong to other core APIs. All generated types remain accessible.
export type * as HerdrApi from './herdr-api';
export const HERDR_PROTOCOL: Protocol = 22;

export interface HerdrOptions {
  socketPath?: string;
  timeoutMs?: number;
  /** Also used by the binary helpers, so sandboxed callers never need to change process.env. */
  env?: NodeJS.ProcessEnv;
  binary?: string;
}

export class HerdrError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'HerdrError';
  }
}

export class HerdrServerNotRunningError extends HerdrError {
  constructor(message = 'herdr server is not running; run oak doctor --fix') {
    super('server_not_running', message);
    this.name = 'HerdrServerNotRunningError';
  }
}

export class HerdrTimeoutError extends HerdrError {
  constructor(method: string, timeoutMs: number) {
    super('timeout', `herdr ${method} timed out after ${timeoutMs} ms`);
    this.name = 'HerdrTimeoutError';
  }
}

/** Filesystem marker used by herdr's CLI and inherited HERDR_SOCKET_PATH. */
export function herdrSocketPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const config = env.XDG_CONFIG_HOME || (platform === 'win32'
    ? env.APPDATA || (env.USERPROFILE ? paths.join(env.USERPROFILE, 'AppData', 'Roaming') : undefined)
    : undefined) || paths.join(env.HOME || os.homedir(), '.config');
  const session = env.HERDR_SESSION;
  const dir = paths.join(config, 'herdr');
  return session && session !== 'default' && session !== '.' && session !== '..' && /^[A-Za-z0-9._-]{1,64}$/.test(session)
    ? paths.join(dir, 'sessions', session, 'herdr.sock')
    : paths.join(dir, 'herdr.sock');
}

/** Windows IPC uses a named pipe derived from the marker, not the marker file itself. */
export function herdrConnectPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const marker = herdrSocketPath(env, platform);
  return platform === 'win32' ? `\\\\.\\pipe\\${marker}` : marker;
}

function socketError(error: NodeJS.ErrnoException): HerdrError {
  return error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
    ? new HerdrServerNotRunningError()
    : new HerdrError(error.code || 'socket_error', error.message);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function responseError(value: unknown): HerdrError {
  if (!record(value) || typeof value.code !== 'string' || typeof value.message !== 'string') {
    return new HerdrError('invalid_response', 'Malformed herdr error response');
  }
  return value.code === 'server_not_running'
    ? new HerdrServerNotRunningError(value.message)
    : new HerdrError(value.code, value.message);
}

/** Decode split/coalesced UTF-8 lines. A malformed frame terminates this connection. */
function readFrames(socket: net.Socket, onFrame: (frame: Record<string, unknown>) => void, fail: (error: HerdrError) => void): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    while (!socket.destroyed) {
      const end = buffer.indexOf('\n');
      if ((end < 0 ? buffer.length : end) > 16 * 1024 * 1024) {
        fail(new HerdrError('invalid_response', 'herdr frame exceeds 16 MiB'));
        return;
      }
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let frame: unknown;
      try { frame = JSON.parse(line); } catch {
        fail(new HerdrError('invalid_response', 'herdr sent invalid NDJSON'));
        return;
      }
      if (!record(frame)) {
        fail(new HerdrError('invalid_response', 'herdr sent a non-object frame'));
        return;
      }
      onFrame(frame);
    }
  });
}

function requestTimeout(method: Method, params: unknown, opts: HerdrOptions): number {
  if (opts.timeoutMs !== undefined) return opts.timeoutMs;
  const p = record(params) ? params : {};
  const wait = record(p.wait) ? p.wait : p;
  if (typeof wait.timeout_ms === 'number') return Math.max(15000, wait.timeout_ms + 1000);
  // herdr's default wait is 30 seconds; leave time for transport and response encoding.
  return method === 'agent.wait' || method === 'events.wait' || method === 'pane.wait_for_output' || record(p.wait) ? 35000 : 15000;
}

/** No retry: replaying a failed mutation could start or prompt an agent twice. */
export function herdrRequest<M extends Method>(method: M, params: Params<M>, opts: HerdrOptions = {}): Promise<Result<M>> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timeoutMs = requestTimeout(method, params, opts);
    const socket = net.createConnection(herdrConnectPath(opts.socketPath ? { ...opts.env, HERDR_SOCKET_PATH: opts.socketPath } : opts.env));
    let settled = false;
    const finish = (error?: HerdrError, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value as Result<M>);
    };
    const timer = setTimeout(() => finish(new HerdrTimeoutError(method, timeoutMs)), timeoutMs);
    socket.once('error', error => finish(socketError(error)));
    socket.once('close', () => finish(new HerdrError('connection_closed', `herdr closed before answering ${method}`)));
    readFrames(socket, frame => {
      if (frame.id !== id) return finish(new HerdrError('invalid_response', 'herdr response id does not match the request'));
      if ('error' in frame) return finish(responseError(frame.error));
      if (!record(frame.result) || typeof frame.result.type !== 'string') {
        return finish(new HerdrError('invalid_response', 'herdr response has no result'));
      }
      finish(undefined, frame.result);
    }, finish);
    socket.once('connect', () => {
      try { socket.write(JSON.stringify({ id, method, params }) + '\n'); }
      catch (error) { finish(new HerdrError('invalid_request', String(error))); }
    });
  });
}

export interface HerdrSubscribeOptions extends HerdrOptions {
  onStatus?: (status: 'connected' | 'reconnecting') => void;
  onError?: (error: HerdrError) => void;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

/** Re-subscribes after a restart. A connected status means the server acknowledged the subscription.
 * Events lost during a disconnect are not replayed; refresh the snapshot on reconnection. */
export function herdrSubscribe(
  subscriptions: readonly Subscription[], onEvent: (event: HerdrEvent) => void, opts: HerdrSubscribeOptions = {}
): { close(): void } {
  let closed = false;
  let socket: net.Socket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let handshake: ReturnType<typeof setTimeout> | undefined;
  const initialDelay = Math.max(1, opts.reconnectDelayMs ?? 250);
  const maxDelay = Math.max(initialDelay, opts.maxReconnectDelayMs ?? 10000);
  let delay = initialDelay;
  const params = JSON.stringify({ subscriptions });

  const connect = () => {
    if (closed) return;
    const id = randomUUID();
    const current = socket = net.createConnection(herdrConnectPath(opts.socketPath ? { ...opts.env, HERDR_SOCKET_PATH: opts.socketPath } : opts.env));
    let ready = false;
    let failed = false;
    const fail = (error: HerdrError) => {
      if (failed || closed) return;
      failed = true;
      clearTimeout(handshake);
      current.destroy();
      opts.onError?.(error);
    };
    const timeoutMs = opts.timeoutMs ?? 15000;
    handshake = setTimeout(() => fail(new HerdrTimeoutError('events.subscribe', timeoutMs)), timeoutMs);
    current.once('connect', () => current.write(`{"id":${JSON.stringify(id)},"method":"events.subscribe","params":${params}}\n`));
    current.once('error', error => fail(socketError(error)));
    current.once('close', () => {
      clearTimeout(handshake);
      if (closed) return;
      retry = setTimeout(connect, delay);
      delay = Math.min(maxDelay, delay * 2);
      opts.onStatus?.('reconnecting');
    });
    readFrames(current, frame => {
      if ('error' in frame) return fail(responseError(frame.error));
      if (!ready) {
        if (frame.id !== id || !record(frame.result) || frame.result.type !== 'subscription_started') {
          return fail(new HerdrError('invalid_response', 'herdr did not acknowledge the subscription'));
        }
        ready = true;
        delay = initialDelay;
        clearTimeout(handshake);
        opts.onStatus?.('connected');
      } else if (typeof frame.event === 'string' && record(frame.data)) {
        onEvent(frame as unknown as HerdrEvent);
      } else {
        fail(new HerdrError('invalid_response', 'Malformed herdr event'));
      }
    }, fail);
  };
  connect();
  return { close() {
    closed = true;
    clearTimeout(retry);
    clearTimeout(handshake);
    socket?.destroy();
  } };
}

export interface HerdrVersion {
  version: string;
  protocol: number;
  compatible: boolean;
  running?: boolean;
  warnings: string[];
  /** While a server runs, `version` and `protocol` are the SERVER's. Either side can be the one that
   *  fails, and each has a different fix, so both verdicts are kept: the herdr binary's own, the
   *  server's against the pin, and herdr's word on whether that server can serve this binary. */
  binary?: { version: string; protocol: number; compatible: boolean };
  serverCompatible?: boolean;
  paired?: boolean;
}

export interface HerdrVersionOptions extends HerdrOptions {
  /** Directory from which to search upward for herdr.lock; useful for bundled distributions. */
  lockDir?: string;
  onWarning?: (message: string) => void;
}

function checkVersion(version: string, protocol: number, opts: HerdrVersionOptions): HerdrVersion {
  const result: HerdrVersion = { version, protocol, compatible: protocol === HERDR_PROTOCOL, warnings: [] };
  try {
    const lock = readHerdrLock(opts.lockDir);
    result.compatible &&= protocol === lock.protocol && compareVersions(version, lock.version) >= 0;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('herdr.lock not found')) throw error;
    const warning = 'herdr.lock not found; skipping the pinned version check';
    result.warnings.push(warning);
    (opts.onWarning || console.warn)(warning);
  }
  return result;
}

function runHerdr(argv: readonly string[], opts: HerdrOptions, textOutput = false): Promise<unknown> {
  const env = opts.socketPath ? { ...(opts.env || process.env), HERDR_SOCKET_PATH: opts.socketPath } : opts.env;
  const binary = opts.binary || env?.HERDR_BIN || process.env.HERDR_BIN || 'herdr';
  return new Promise((resolve, reject) => {
    let force: NodeJS.Timeout | undefined;
    let settled = false;
    const child = execFileTool(binary, argv, { env, timeout: opts.timeoutMs ?? 15000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      settled = true;
      if (force) clearTimeout(force);
      let value: unknown;
      try { value = JSON.parse(stdout); } catch { /* command errors are more useful than a JSON error */ }
      if (record(value) && 'error' in value) return reject(responseError(value.error));
      if (error) {
        if (error.code === 'ENOENT') return reject(new HerdrError('binary_not_found', 'herdr is missing; run oak doctor --fix'));
        if (error.killed) return reject(new HerdrTimeoutError(argv.join(' '), opts.timeoutMs ?? 15000));
        return reject(new HerdrError('command_failed', stderr.trim() || error.message));
      }
      if (textOutput) return resolve(stdout);
      if (value === undefined) return reject(new HerdrError('invalid_response', 'herdr command did not return JSON'));
      resolve(value);
    });
    // execFile sends only SIGTERM at its deadline. A stuck bridge must not own the gather forever.
    if (!settled) {
      force = setTimeout(() => child?.kill?.('SIGKILL'), Math.min(2147483647, (opts.timeoutMs ?? 15000) + 500));
      force.unref();
    }
  });
}

/** Works without a running server. When running, gate both the binary and the server against OAK. */
export async function herdrVersion(opts: HerdrVersionOptions = {}): Promise<HerdrVersion> {
  const status = await runHerdr(['status', '--json'], opts);
  if (!record(status) || !record(status.client) || !record(status.server)
      || typeof status.client.version !== 'string' || typeof status.client.protocol !== 'number'
      || typeof status.server.running !== 'boolean') {
    throw new HerdrError('invalid_response', 'Malformed herdr status');
  }
  const client = checkVersion(status.client.version, status.client.protocol, opts);
  if (!status.server.running) return { ...client, running: false };
  const server = status.server;
  if (typeof server.version !== 'string' || typeof server.protocol !== 'number') {
    throw new HerdrError('invalid_response', 'Running herdr server did not report its version/protocol');
  }
  const result = checkVersion(server.version, server.protocol, { ...opts, onWarning: () => {} });
  const paired = server.compatible === true && server.endpoint_compatible !== false;
  return {
    ...result, running: true,
    compatible: result.compatible && client.compatible && paired,
    binary: { version: client.version, protocol: client.protocol, compatible: client.compatible },
    serverCompatible: result.compatible, paired,
  };
}

/** Startup snapshot includes the server's version, so the gate needs no extra socket round trip. */
export async function herdrSnapshot(opts: HerdrVersionOptions = {}): Promise<SessionSnapshot> {
  const { snapshot } = await herdrRequest('session.snapshot', {}, opts);
  return snapshotFromCli(snapshot, opts);
}

/** Normalize CLI envelopes and gate the same snapshot for local and remote consumers. */
export function snapshotFromCli(value: unknown, opts: HerdrVersionOptions = {}): SessionSnapshot {
  if (record(value) && 'error' in value) throw responseError(value.error);
  const result = record(value) && record(value.result) ? value.result : value;
  const snapshot = record(result) && record(result.snapshot) ? result.snapshot : result;
  if (!record(snapshot) || typeof snapshot.version !== 'string' || typeof snapshot.protocol !== 'number' || !Array.isArray(snapshot.panes)) {
    throw new HerdrError('invalid_response', 'herdr snapshot has no version/protocol/panes');
  }
  if (!checkVersion(snapshot.version, snapshot.protocol, opts).compatible) {
    throw new HerdrError('incompatible_version', `herdr ${snapshot.version} (protocol ${snapshot.protocol}) is incompatible; run oak doctor --fix`);
  }
  return snapshot as unknown as SessionSnapshot;
}

/** Machines are a binary API, absent from the socket schema. */
export interface HerdrMachine {
  id: string;
  label: string;
  target: string;
  session: string;
  enabled: boolean;
  selected: boolean;
}

export async function herdrMachines(opts: HerdrOptions = {}): Promise<HerdrMachine[]> {
  const value = await runHerdr(['machine', 'list', '--json'], opts);
  if (!Array.isArray(value) || !value.every(v => record(v)
      && ['id', 'label', 'target', 'session'].every(k => typeof v[k] === 'string')
      && typeof v.enabled === 'boolean' && typeof v.selected === 'boolean')) {
    throw new HerdrError('invalid_response', 'Malformed herdr machine list');
  }
  return value as HerdrMachine[];
}

/** Returns the command's JSON envelope unchanged. Choose a JSON-producing verb, e.g. api snapshot. */
export function herdrOnMachine(label: string, argv: readonly string[], opts: HerdrOptions = {}): Promise<unknown> {
  return runHerdr(['--machine', label, ...argv], opts);
}

/** herdr's two transports: the socket (this machine) and the CLI (a saved machine). This module is one;
 *  a caller that injects its own (a test's fake core) hands it to every helper that talks to herdr for
 *  it, so no helper reaches a server the caller did not choose. */
export interface HerdrTransport {
  herdrRequest: typeof herdrRequest;
  herdrOnMachine: typeof herdrOnMachine;
}

/** One bounded, read-only forwarded command per saved machine, including disabled entries. */
export async function diagnoseHerdrForwarding(opts: HerdrOptions & { now?: () => number } = {}): Promise<Check[]> {
  let machines: HerdrMachine[];
  try { machines = await herdrMachines(opts); }
  catch (error) { return [{ id: 'herdr-machines', label: 'herdr machines', level: 'warn', detail: String(error) }]; }
  const checks: Check[] = [];
  const now = opts.now ?? (() => performance.now());
  const configured = Number((opts.env ?? process.env).OAK_HERDR_REMOTE_TIMEOUT_MS);
  const timeoutMs = opts.timeoutMs ?? (Number.isFinite(configured) && configured > 0 ? configured : 30000);
  for (const machine of machines) {
    const start = now();
    let failure = '';
    try { await runHerdr(['--machine', machine.label, 'pane', 'list'], { ...opts, timeoutMs }, true); }
    catch (error) { failure = String(error); }
    const elapsed = now() - start;
    const slow = elapsed > 8000;
    const host = machine.target.replace(/^.*@/, '');
    checks.push({
      id: `herdr-forwarding:${machine.label}`, label: `herdr forwarding: ${machine.label}`,
      level: slow || failure ? 'warn' : 'ok',
      detail: `pane list took ${(elapsed / 1000).toFixed(1)} s${failure ? `; ${failure}` : ''}`,
      // A FAILED probe is slow by construction (a connect timeout is seconds long): the access advice
      // comes first, and multiplexing is offered only as the second thought — for a host that did not
      // answer at all, multiplexing alone sent the person to the wrong file.
      ...(failure ? { fix: `Check SSH access to ${machine.target} and that herdr is running there.${slow ? ` If the connection merely took long, set ControlMaster auto, ControlPath ~/.ssh/cm-%r@%h:%p, and ControlPersist 10m in ~/.ssh/config for Host ${host}.` : ''}` }
        : slow ? { fix: `In ~/.ssh/config for Host ${host}, set ControlMaster auto, ControlPath ~/.ssh/cm-%r@%h:%p, and ControlPersist 10m.` } : {}),
    });
  }
  return checks;
}

function agentMethod<M extends Method>(method: M) {
  return (params: Params<M>, opts?: HerdrOptions): Promise<Result<M>> => herdrRequest(method, params, opts);
}

/** Thin verbs: start returns launch_pending on agent; callers wait before prompting. */
export const herdrAgent = {
  start: agentMethod('agent.start'),
  waitFor: agentMethod('agent.wait'),
  prompt: agentMethod('agent.prompt'),
  read: agentMethod('agent.read'),
  sendKeys: agentMethod('agent.send_keys'),
  focus: agentMethod('agent.focus'),
  get: agentMethod('agent.get'),
  list: (opts?: HerdrOptions) => herdrRequest('agent.list', {}, opts),
};

/** Submit only after an explicit user send. Missing panes leave the caller's draft intact. */
/** The budget for one FORWARDED herdr command, by the terminal app's rule (observatory-runtime.ts):
 *  OAK_HERDR_REMOTE_TIMEOUT_MS when it is a whole number of ms, else 30 s. Forwarding without ssh
 *  multiplexing was measured at 21–25 s, which the 15 s local default refused on a healthy machine. */
function remoteTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OAK_HERDR_REMOTE_TIMEOUT_MS?.trim() || '';
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(value) && value > 0 && value <= 2147483647 ? value : 30000;
}

export async function promptSession(session: string, text: string, opts: HerdrOptions & { machine?: string } = {}): Promise<{ sent: boolean; reason?: string; machine?: string; pane?: string }> {
  if (!text.trim()) return { sent: false, reason: 'The prompt is empty' };
  // Forwarded commands get the remote budget; a caller's own timeoutMs still wins.
  const remote = { ...opts, timeoutMs: opts.timeoutMs ?? remoteTimeoutMs(opts.env ?? process.env) };
  const submit = async (snapshot: SessionSnapshot, machine?: string) => {
    const pane = snapshot.panes.find(p => p.agent_session?.value === session);
    if (!pane) return null;
    if (pane.agent_status === 'blocked') return { sent: false, reason: 'The agent is blocked — answer it in herdr first' };
    const target = snapshot.agents?.find(a => a.pane_id === pane.pane_id)?.name || pane.pane_id;
    if (machine) {
      let result: { error?: { message?: string } } | null;
      try { result = await herdrOnMachine(machine, ['agent', 'prompt', target, text], remote) as typeof result; }
      catch (error) {
        // The forwarded command can time out AFTER the text reached the pane. Calling that a plain
        // failure invited the reader to send the same draft twice.
        if (!(error instanceof HerdrTimeoutError)) throw error;
        return { sent: false, machine, pane: pane.pane_id, reason: `herdr on ${machine} did not confirm the prompt within ${Math.round(remote.timeoutMs / 1000)} s — it may already be in pane ${pane.pane_id}; check that pane before sending the draft again` };
      }
      if (result?.error) throw new Error(result.error.message || 'Remote prompt failed');
    } else await herdrAgent.prompt({ target, text }, opts);
    return { sent: true, machine: machine ?? 'local', pane: pane.pane_id };
  };
  let local: SessionSnapshot | undefined;
  let reason = 'No live pane for this session';
  if (!opts.machine) {
    try { local = await herdrSnapshot(opts); } catch (error) { reason = String((error as Error).message || error); }
    if (local) { const result = await submit(local); if (result) return result; }
  }
  const machines = opts.machine ? [{ label: opts.machine, enabled: true }] : await herdrMachines(opts).catch(() => []);
  for (const machine of machines.filter(m => m.enabled)) {
    let snapshot: SessionSnapshot;
    try {
      const result = await herdrOnMachine(machine.label, ['api', 'snapshot'], remote);
      snapshot = snapshotFromCli(result, opts);
    } catch (error) {
      reason = error instanceof HerdrError && error.code === 'incompatible_version'
        ? `herdr on ${machine.label} is incompatible; run oak doctor --fix there`
        : String((error as Error).message || error);
      continue;
    }
    const result = await submit(snapshot, machine.label);
    if (result) return result;
  }
  return { sent: false, reason };
}

/** Start a supported native agent in a new herdr tab. The server owns the terminal. */
export async function startAgentSession(kind: string, cwd: string, opts: HerdrOptions = {}): Promise<{ pane: string; name: string }> {
  if (kind !== 'claude' && kind !== 'codex') throw new Error(`Unsupported agent kind: ${kind}`);
  await herdrSnapshot(opts); // protocol/version gate before mutating the server
  const tab = await herdrRequest('tab.create', { cwd, label: kind, focus: true }, opts);
  const pane = tab.root_pane.pane_id;
  const name = `oak-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  try { await herdrAgent.start({ kind, name, pane_id: pane }, opts); }
  catch (error) { throw new Error(`Agent did not start in herdr pane ${pane}: ${String((error as Error).message || error)}. The shell remains available in herdr.`); }
  return { pane, name };
}
