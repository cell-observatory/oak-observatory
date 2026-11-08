/** herdr's data plane. One NDJSON request per connection; only subscriptions stay open. */
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { execFileTool } from './spawn';
import { sshMuxOptions } from './prefs';
import { rootDir } from './store';
import { compareVersions } from './semver';
import { parseHerdrVersion, readHerdrLock } from './herdr-install';
import { performance } from 'perf_hooks';
import type { Check } from './diagnose';
import type { Method, Params, Result, Protocol, Subscription, HerdrEvent, SessionSnapshot, AgentStatus } from './herdr-api';

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
    let settled = false, sentAt = 0;
    const finish = (error?: HerdrError, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value as Result<M>);
    };
    // The budget is herdr's time, not this process's: count from the write, and read an answer that arrived while this
    // event loop was busy before calling it late.
    const expire = () => setImmediate(() => {
      if (settled) return;
      const left = sentAt ? sentAt + timeoutMs - Date.now() : 0;
      if (left > 0) timer = setTimeout(expire, left); else finish(new HerdrTimeoutError(method, timeoutMs));
    });
    let timer = setTimeout(expire, timeoutMs);
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
      sentAt = Date.now();
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

/** The `ssh` herdr runs for a saved machine, put first on its PATH by machineSsh: herdr 0.9.1 runs the `ssh`
 *  it finds there and takes no other program, nor more options, from anywhere else. herdr 0.9.2 and later
 *  give that ssh a connection of their own (`-F`, `-S` and `-o ControlMaster=auto -o ControlPersist=600`),
 *  kept in the background, where no stop of OAK's reaches it: the shim runs it as herdr asked, since an
 *  option put first wins and `ControlMaster=no` would make each command connect anew. */
const SSH_SHIM = '#!/bin/sh\n# OAK runs herdr\'s ssh to a saved machine through this, with the options OAK_SSH_EXTRA adds.\n' +
  '# A connection herdr keeps itself (herdr 0.9.2 and later) is used as herdr asked.\n' +
  'case " $* " in *" ControlPersist="*) exec "$OAK_REAL_SSH" "$@" ;; esac\n' +
  'exec "$OAK_REAL_SSH" $OAK_SSH_EXTRA "$@"\n';

/** The first herdr that gives the ssh of a saved machine a connection of its own (see SSH_SHIM). */
const HERDR_OWN_SSH_CONNECTION = '0.9.2';

/** Where SSH_SHIM is kept: a directory of the store's that only this user can write to. */
function sshShimDir(): string {
  return path.join(rootDir(), 'herdr-ssh');
}

/** Write SSH_SHIM as `ssh` in sshShimDir (0700), unless it is there already. It is replaced whole (a
 *  temporary file renamed over it), so processes that write it at once each leave it complete. Undefined once
 *  it is in place and can run, else why it is not: it cannot be written, the directory is not this user's
 *  alone, or it cannot be run there (a noexec mount: herdr would pass over it to the next `ssh` on PATH). */
function writeSshShim(dir: string): string | undefined {
  const file = path.join(dir, 'ssh');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const own = fs.lstatSync(dir);
    if (!own.isDirectory() || own.uid !== process.getuid?.() || own.mode & 0o022) return `${dir} is not a directory that only you can write to`;
    let current = false;
    try { current = fs.readFileSync(file, 'utf8') === SSH_SHIM && !!(fs.statSync(file).mode & 0o100); } catch { /* written below */ }
    if (!current) {
      const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      fs.writeFileSync(tmp, SSH_SHIM, { mode: 0o700, flag: 'wx' });
      try { fs.renameSync(tmp, file); } catch (error) { fs.rmSync(tmp, { force: true }); throw error; }
    }
  } catch (error) { return `${file} could not be written (${(error as Error).message})`; }
  try { fs.accessSync(file, fs.constants.X_OK); } catch { return `${file} cannot be run there; the store may be on a noexec mount`; }
  return undefined;
}

/** Why a saved machine's last command ran without SSH_SHIM although its ssh needed it, by label, for
 *  `oak doctor` (diagnoseHerdrForwarding). */
const sshShimProblems = new Map<string, string>();

/** The first `ssh` on `pathVar` that can run, as herdr finds it, other than the shim in `dir`. Empty PATH
 *  entries are skipped, where herdr would take one as the current directory; this is deliberate. */
function firstSsh(pathVar: string | undefined, dir: string): string | undefined {
  for (const entry of (pathVar ?? '').split(path.delimiter)) {
    if (!entry || path.resolve(entry) === dir) continue;
    const file = path.resolve(entry, 'ssh');
    try { if (fs.statSync(file).isFile()) { fs.accessSync(file, fs.constants.X_OK); return file; } } catch { /* the next */ }
  }
  return undefined;
}

/** What machineSsh decided for a saved machine, by the real ssh and the label, kept for SSH_DECIDED_MS: the
 *  terminal app forwards a command to each saved machine every 15 s, and a `herdr machine list` and an
 *  `ssh -G` before each one tripled the processes it starts. Only an answer `ssh -G` printed is kept; a
 *  lookup that failed is asked again, and a send kept past its caller (keepOnExit) never reads it. */
const sshDecided = new Map<string, { extra: string[]; at: number }>();
const SSH_DECIDED_MS = 60_000;

/** For the tests: forget every decision machineSsh kept. */
export function clearSshDecisions(): void {
  sshDecided.clear();
}

/** herdr's environment for a command for saved machine `label`, given the one it would have. Where
 *  sshMuxOptions decides, from `ssh -G` for that machine's target (`machine list`), that an ssh to it needs
 *  `-o ControlMaster=no`, SSH_SHIM comes first on PATH and runs the `ssh` herdr would have found there with it;
 *  with no target to ask about, or no answer, it is added, as sshMuxOptions adds it. A send kept past the
 *  terminal app (`keepOnExit`) gets it unasked. Otherwise, and with no ssh on PATH, nothing changes, so a
 *  persisted master (ControlPersist) is still shared. A decision is kept for a minute (sshDecided). POSIX
 *  only: Windows runs the command under execFile, whose deadline ends herdr alone (OAK never stops herdr's
 *  ssh there). */
async function machineSsh(label: string, env: NodeJS.ProcessEnv, opts: HerdrOnMachineOptions): Promise<NodeJS.ProcessEnv> {
  const dir = sshShimDir();
  const real = process.platform === 'win32' ? undefined : firstSsh(env.PATH, dir);
  if (!real) return env;
  const key = `${real}\n${label}`;
  const known = opts.keepOnExit ? undefined : sshDecided.get(key);
  const extra = known && Date.now() - known.at < SSH_DECIDED_MS ? known.extra : await lookUpSsh(label, real, env, opts, key);
  // A store path with the PATH separator in it cannot be one entry of PATH.
  const problem = !extra.length ? undefined
    : dir.includes(path.delimiter) ? `the store's path has a "${path.delimiter}" in it, which PATH cannot hold (${dir})` : writeSshShim(dir);
  if (problem) sshShimProblems.set(label, problem); else sshShimProblems.delete(label);
  if (!extra.length || problem) return env;
  return { ...env, PATH: `${dir}${path.delimiter}${env.PATH}`, OAK_REAL_SSH: real, OAK_SSH_EXTRA: extra.join(' ') };
}

/** machineSsh's lookup: the machine's target from herdr's list, then the options sshMuxOptions reads from what
 *  `ssh -G` prints for it. Kept under `key` only when `ssh -G` printed an answer. */
async function lookUpSsh(label: string, real: string, env: NodeJS.ProcessEnv, opts: HerdrOnMachineOptions, key: string): Promise<string[]> {
  let target: string | undefined;
  // A send kept past its caller (keepOnExit) starts at once, unasked: the terminal app may end right after it,
  // before `machine list` and `ssh -G` answered. ControlMaster=no still uses a master that is already open.
  if (!opts.keepOnExit) {
    try {
      // herdr takes an id before a label: a label that is another machine's id names that other machine.
      const machines = await herdrMachines({ ...opts, timeoutMs: Math.min(opts.timeoutMs ?? 15000, 15000) });
      target = (machines.find((m) => m.id === label) ?? machines.find((m) => m.label === label))?.target;
    } catch { /* added below, unasked */ }
  }
  const printed = target === undefined ? { status: null } : await new Promise<{ status: number | null; stdout: string }>((resolve) => {
    execFileTool(real, ['-G', target], { env, timeout: Math.min(5000, opts.timeoutMs || 15000) }, (error, stdout) =>
      resolve({ status: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout }));
  });
  const extra = sshMuxOptions(printed);
  if (target !== undefined && printed.status === 0) sshDecided.set(key, { extra, at: Date.now() });
  return extra;
}

/** What herdr wrote when a command failed, as its message. herdr (0.9.1, 0.9.3) ends a failed command with Rust's
 *  Debug form of the error, `Error: Custom { kind: ConnectionAborted, error: "machine 'box' (session default):
 *  remote SSH connection failed: ssh: connect to host box port 22: Operation timed out" }`, whose quoted string is
 *  the message in Rust's escapes. A line in that form reads as the message: a quote and a backslash as themselves, a
 *  tab as a space, its lines joined by ` — ` so that it stays one line, and any other escaped character left written
 *  out, so that what a machine's ssh printed cannot drive the terminal it is shown on. Other lines are kept, and so is
 *  one whose message reads as nothing (`error: ""`). */
function herdrErrorText(text: string): string {
  return text.split('\n').map((line) => {
    const debug = /^Error: Custom \{ kind: \w+, error: "((?:[^"\\]|\\.)*)" \}\r?$/.exec(line);
    if (!debug) return line;
    const message = debug[1].replace(/\\(r\\n|[rnt"'\\])/g, (_escape, ch: string) => ch === 't' ? ' ' : ch.length > 1 || ch === 'r' || ch === 'n' ? '\n' : ch);
    return message.split('\n').map((part) => part.trim()).filter(Boolean).join(' — ') || line;
  }).join('\n');
}

/** Whether a herdr command for a saved machine failed because the machine could not be reached: herdr's ssh to it
 *  failed at one of the steps that need it, which herdr 0.9.1 and 0.9.3 name in their message, or OAK's deadline for
 *  the command passed first. A machine whose herdr is too old for machine API forwarding answered, and someone has to
 *  update herdr there: herdr 0.9.2 and 0.9.3 say so under `remote binary discovery failed`. */
export function herdrUnreachable(error: unknown): boolean {
  return error instanceof HerdrTimeoutError || (error instanceof HerdrError
    && /remote (SSH connection|platform detection|binary discovery) failed|SSH authentication failed|SSH command timed out|ssh bridge exited/.test(error.message)
    && !error.message.includes('does not support machine API forwarding'));
}

/** `json` (the default) rejects a success that printed nothing; `empty` resolves null for it, for the
 *  verbs herdr 0.9.1 runs silently; `text` returns stdout as it is.
 *
 *  A command for a saved machine (`--machine`) runs herdr's ssh to it, and through a jump host in the
 *  person's ssh configuration, the jump host's ssh, which gets none of herdr's options: it could ask for a
 *  passphrase on the caller's terminal (the terminal app's, on every Observatory read) or, with none, in
 *  the desktop's askpass dialog. So that command runs with `SSH_ASKPASS_REQUIRE=never` (and nothing else of
 *  machineSshEnv's: herdr reads XDG_CONFIG_HOME and HERDR_SOCKET_PATH) and `detached`: on POSIX in a
 *  session of its own, which no terminal belongs to, whose whole process group its deadline stops,
 *  herdr's ssh and a jump host's with it (execFileTool), as do the CLI and the terminal app when they end
 *  (stopDetachedChildren), except a send marked `keepOnExit`. herdr 0.9.1 gives its ssh options of its own
 *  (RemoteSsh::new_noninteractive), none of which says whether to share a connection, so the person's ssh
 *  configuration decides: with ControlMaster on and ControlPersist off, that ssh became the master the
 *  person's own sessions to the machine shared, and stopping it ended them. Where OAK's own ssh would get
 *  `-o ControlMaster=no` (sshMuxOptions), herdr's gets it too (machineSsh). The master herdr keeps
 *  in the background (ControlPersist=yes, in <TMPDIR or /tmp>/herdr-ssh-<pid>-<n>), and closes only on its
 *  own way out, is that of `herdr machine add` and `herdr --remote`, which OAK does not run this way. */
async function runHerdr(argv: readonly string[], opts: HerdrOnMachineOptions, output: 'json' | 'empty' | 'text' = 'json'): Promise<unknown> {
  const local = opts.socketPath ? { ...(opts.env || process.env), HERDR_SOCKET_PATH: opts.socketPath } : opts.env;
  const remote = argv[0] === '--machine';
  const env = remote ? await machineSsh(argv[1], { ...(local || process.env), SSH_ASKPASS_REQUIRE: 'never' }, opts) : local;
  const binary = opts.binary || env?.HERDR_BIN || process.env.HERDR_BIN || 'herdr';
  return new Promise((resolve, reject) => {
    let force: NodeJS.Timeout | undefined;
    let settled = false;
    // windowsHide: a caller with no console of its own (a detached refresh) would otherwise open one for herdr on Windows.
    const child = execFileTool(binary, argv, { env, timeout: opts.timeoutMs ?? 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, ...(remote ? { detached: true, keepOnExit: opts.keepOnExit } : {}) }, (error, stdout, stderr) => {
      settled = true;
      if (force) clearTimeout(force);
      let value: unknown;
      try { value = JSON.parse(stdout); } catch { /* command errors are more useful than a JSON error */ }
      if (record(value) && 'error' in value) return reject(responseError(value.error));
      if (error) {
        if (error.code === 'ENOENT') return reject(new HerdrError('binary_not_found', 'herdr is missing; run oak doctor --fix'));
        if (error.killed) return reject(new HerdrTimeoutError(argv.join(' '), opts.timeoutMs ?? 15000));
        // The CLI can put its error envelope on stderr, including forwarded pane commands.
        let failure: unknown;
        try { failure = JSON.parse(stderr); } catch { /* plain stderr is handled below */ }
        if (record(failure) && 'error' in failure) return reject(responseError(failure.error));
        return reject(new HerdrError('command_failed', herdrErrorText(stderr.trim()) || error.message));
      }
      if (output === 'text') return resolve(stdout);
      if (output === 'empty' && !stdout.trim()) return resolve(null);
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

export interface HerdrOnMachineOptions extends HerdrOptions {
  /** The verb prints nothing when it succeeds (herdr 0.9.1: `pane report-metadata`, `pane send-text`):
   *  exit 0 with empty stdout resolves null instead of failing as a response that is not JSON. */
  emptyOk?: boolean;
  /** The verb prints text, not JSON (herdr 0.9.1: `pane read`, which prints the pane's text as it reads it): the
   *  command's stdout is resolved as it is. */
  text?: boolean;
  /** A send the person asked for (the terminal app's reply): it starts at once, with `-o ControlMaster=no`
   *  for its ssh unasked (machineSsh), and stopDetachedChildren, which the terminal app calls as it ends,
   *  leaves it to finish. Its deadline stops it only while the app runs: after the app ends, the send runs
   *  until herdr ends it, as a send from VS Code does when its window closes. */
  keepOnExit?: boolean;
}

/** Returns the command's JSON envelope unchanged. Choose a JSON-producing verb, e.g. api snapshot, or
 *  pass `emptyOk` for one that prints nothing on success, or `text` for one that prints text. */
export function herdrOnMachine(label: string, argv: readonly string[], opts: HerdrOnMachineOptions = {}): Promise<unknown> {
  return runHerdr(['--machine', label, ...argv], opts, opts.text ? 'text' : opts.emptyOk ? 'empty' : 'json');
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
  catch (error) { return [{ id: 'herdr-machines', label: 'herdr machines', level: 'warn', detail: error instanceof Error ? error.message : String(error) }]; }
  const checks: Check[] = [];
  const now = opts.now ?? (() => performance.now());
  const configured = Number((opts.env ?? process.env).OAK_HERDR_REMOTE_TIMEOUT_MS);
  const timeoutMs = opts.timeoutMs ?? (Number.isFinite(configured) && configured > 0 ? configured : 30000);
  // A herdr that keeps its ssh's connection itself (SSH_SHIM) gets no option from OAK, so a shim that could
  // not be put in place costs nothing there. Asked once, and only when a shim is missing.
  let ownConnection: Promise<boolean> | undefined;
  const herdrKeepsItsSsh = (): Promise<boolean> => (ownConnection ??= new Promise((resolve) => {
    const binary = opts.binary || opts.env?.HERDR_BIN || process.env.HERDR_BIN || 'herdr';
    execFileTool(binary, ['--version'], { env: opts.env, timeout: 5000 }, (error, stdout) => {
      const version = error ? null : parseHerdrVersion(String(stdout ?? ''));
      resolve(!!version && compareVersions(version, HERDR_OWN_SSH_CONNECTION) >= 0);
    });
  }));
  for (const machine of machines) {
    const start = now();
    let failure = '';
    try { await runHerdr(['--machine', machine.label, 'pane', 'list'], { ...opts, timeoutMs }, 'text'); }
    catch (error) { failure = error instanceof Error ? error.message : String(error); }
    const elapsed = now() - start;
    const slow = elapsed > 8000;
    const host = machine.target.replace(/^.*@/, '');
    const shim = sshShimProblems.has(machine.label) && !(await herdrKeepsItsSsh()) ? sshShimProblems.get(machine.label) : undefined;
    checks.push({
      id: `herdr-forwarding:${machine.label}`, label: `herdr forwarding: ${machine.label}`,
      level: slow || failure || shim ? 'warn' : 'ok',
      detail: `pane list took ${(elapsed / 1000).toFixed(1)} s${failure ? `; ${failure}` : ''}${shim
        ? `; herdr's ssh ran without -o ControlMaster=no, which OAK adds for ${host} (ControlMaster on with no ControlPersist, or a configuration \`ssh -G\` could not print): ${shim}. OAK stops a herdr command at its deadline and when it quits, and your own ssh sessions to ${host} that share that ssh's connection end with it` : ''}`,
      // A FAILED probe is slow by construction (a connect timeout is seconds long): the access advice
      // comes first, and multiplexing is offered only as the second thought — for a host that did not
      // answer at all, multiplexing alone sent the person to the wrong file. A machine whose herdr is too
      // old to forward answered: only a newer herdr there fixes it.
      ...(failure.includes('does not support machine API forwarding')
        ? { fix: `Update herdr on ${machine.label}: run \`oak doctor --fix\` there, or OAK's installer where OAK is not installed.` }
        : failure ? { fix: `Check SSH access to ${machine.target} and that herdr is running there.${slow ? ` If the connection merely took long, set ControlMaster auto, ControlPath ~/.ssh/cm-%r@%h:%p, and ControlPersist 10m in ~/.ssh/config for Host ${host}.` : ''}` }
        : slow || shim ? { fix: `In ~/.ssh/config for Host ${host}, set ControlMaster auto, ControlPath ~/.ssh/cm-%r@%h:%p, and ControlPersist 10m.` } : {}),
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

/** How long a Codex turn may write nothing to its rollout and still count as running while herdr calls its pane
 *  blocked. Longer than a saved machine's listing can be old when it arrives (its 15 s poll plus a forwarded read of
 *  up to 30 s) and than most gaps a working turn leaves between records (a model call, a short command); a turn
 *  quiet for longer than this is taken to be waiting, as herdr says, unless its pane's screen shows Codex at work
 *  (codexScreenWorking). A saved machine's rollout time is read against this machine's clock: a clock there that runs
 *  ahead lengthens the window by the difference, and one that runs behind by more than the window leaves its panes to
 *  their screens. */
export const CODEX_QUESTION_WINDOW_MS = 90_000;

/** A pane as paneAgentState reads it. `screenWorking` is the pane revision whose screen showed Codex at work
 *  (codexScreenWorking): the terminal app reads the screen of a pane in the state paneScreenDecides names, and puts
 *  what it found on the pane. */
type AgentPane = { agent_status: AgentStatus; agent?: string | null; agent_session?: { agent?: string | null } | null; screenWorking?: number };
/** The session row paneAgentState reads for a pane: sessionMeta's, the row whose id is the pane's
 *  `agent_session.value`, which Codex's hooks report to herdr as `herdr:codex`. */
type AgentRow = { turnOpen?: unknown; lastActiveMs?: unknown; attention?: { kind?: unknown } | null } | null | undefined;

/** herdr calls a Codex pane blocked while its session's row shows the turn still open (`turnOpen`) and no hand raised:
 *  a permission prompt OAK's hooks recorded means Codex is stopped. The terminal app keeps what such a pane's screen
 *  showed while this holds, through the rollout's writes, and forgets it once it does not. */
export function codexTurnBlocked(pane: AgentPane, session: AgentRow): boolean {
  const hand = !!session?.attention && session.attention.kind !== 'idle-done';
  return pane.agent_status === 'blocked' && (pane.agent_session?.agent || pane.agent) === 'codex' && session?.turnOpen === true && !hand;
}
/** The session's rollout was written within CODEX_QUESTION_WINDOW_MS (`lastActiveMs`). */
const rolloutRecent = (session: AgentRow, now: number): boolean =>
  typeof session?.lastActiveMs === 'number' && now - session.lastActiveMs <= CODEX_QUESTION_WINDOW_MS;

/**
 * A herdr pane's agent state as OAK shows it: herdr's own word, except for a Codex agent working with a question
 * waiting. herdr 0.9.1 calls a Codex pane blocked whenever Codex's terminal title says "Action Required" (its Codex
 * rule `osc_title_blocked`, which outranks the rules that see Codex working), and Codex keeps that title while a
 * question it asked waits, as its turn runs on. Such a pane is `working` with `question` set when its session's row
 * shows the turn still open and no hand raised (codexTurnBlocked), and either the rollout was written within
 * CODEX_QUESTION_WINDOW_MS or the pane's screen showed Codex at work (`screenWorking`): a long command writes nothing
 * to the rollout while it runs. A Claude pane, a pane with no row, and every other state are herdr's.
 */
export function paneAgentState(pane: AgentPane, session?: AgentRow, now = Date.now()): { status: AgentStatus; question: boolean } {
  const question = codexTurnBlocked(pane, session) && (rolloutRecent(session, now) || pane.screenWorking !== undefined);
  return question ? { status: 'working', question } : { status: pane.agent_status, question };
}

/** Whether what a pane's screen shows decides its state (paneAgentState): herdr calls a Codex pane blocked, its
 *  session's turn is open with no hand raised, and the rollout has been quiet past CODEX_QUESTION_WINDOW_MS. Only
 *  such a pane's screen is worth reading. */
export function paneScreenDecides(pane: AgentPane, session?: AgentRow, now = Date.now()): boolean {
  return codexTurnBlocked(pane, session) && !rolloutRecent(session, now);
}

/** Codex's live status row, as herdr's Codex manifest matches it (rule `screen_working_fallback`, from the manifest
 *  that makes the interrupt hint optional): a timer row such as `Working (5m 2s • esc to interrupt) · Running hook`,
 *  maybe after a `•` or `◦`, followed to the end of the text only by lines that are no response, interruption or
 *  prompt (queued inputs, a question waiting, a `›` line whose space a sparkle replaced), and blank lines. herdr's Rust
 *  pattern, with `(?m)^` as a lookbehind for the start or a newline and `\z` as `$`, which a pattern with no `m` flag
 *  matches only at the end of the text, reads in JavaScript as
 *  `/(?<![^\n])(?:[•◦][ \t]+)?[^\s›•◦■✗✓─][^\r\n]* \((?:[0-9]+[hm] )*[0-9]+s(?: • [^\r\n]+? to interrupt)?\)(?: · [^\r\n]*)?(?:\r?\n(?:[^•◦›■✗✓─\r\n][^\r\n]*|•[ \t]+(?:Queued\s+follow-up\s+inputs|Messages\s+to\s+be\s+submitted\s+after\s+next\s+tool\s+call(?:\s+\(press\s+[^\r\n]+?\s+to\s+interrupt\s+and\s+send\s+immediately\))?|Messages\s+to\s+be\s+submitted\s+at\s+end\s+of\s+turn)|›[⠁⠂⠄⠈⠐⠠⡀⢀][^\r\n]*)?)*\s*$/u`.
 *  Rust's engine runs it in linear time; JavaScript's backtracks, and the `\s+` of a queued line can also take the
 *  line breaks between such lines, which makes it exponential. This function decides that pattern in linear time,
 *  with JavaScript's `\s` and `u`'s code points. It visits the line starts from the last up and records for each
 *  whether the text from there is lines the pattern's loop accepts and then whitespace (`rest`); a timer row then
 *  matches when its line's end has `rest` true. */
function codexWorkingRow(text: string): boolean {
  const n = text.length, blank = text.trimEnd().length; // `\s*$` matches from `blank` on.
  const space = (i: number): boolean => i < n && /\s/.test(text[i]);
  const skipSpace = (i: number): number => { while (space(i)) i++; return i; };
  const lineEnd = (i: number): number => { while (i < n && text[i] !== '\r' && text[i] !== '\n') i++; return i; };
  // Where `list`, its words joined by `\s+`, ends when it starts at i, or -1.
  const words = (i: number, ...list: string[]): number => {
    for (const [k, word] of list.entries()) {
      const at = k ? skipSpace(i) : i;
      if (k && at === i || !text.startsWith(word, at)) return -1;
      i = at + word.length;
    }
    return i;
  };
  const ok = new Uint8Array(n + 1); // At a line start after `\n`: the loop's optional line, then `rest`, match there.
  const rest = (i: number): boolean => i >= blank || text[i] === '\n' && ok[i + 1] === 1 || text.startsWith('\r\n', i) && ok[i + 2] === 1;
  // `\s+\(press\s+[^\r\n]+?\s+to\s+interrupt\s+and\s+send\s+immediately\)`, then `rest`, from i. The `\s+[^\r\n]+?\s+`
  // before `to` lies inside the whitespace after `(press`, which then holds a character other than CR or LF before its
  // last, or runs from that whitespace to whitespace that starts on the same line.
  const press = (i: number): boolean => {
    const at = skipSpace(i), q = at + 6, w = skipSpace(q);
    if (at === i || !text.startsWith('(press', at) || w === q) return false;
    const send = (t: number): boolean => { const c = words(t, 'to', 'interrupt', 'and', 'send', 'immediately)'); return c >= 0 && rest(c); };
    for (let k = q + 1; k < w - 1; k++) if (text[k] !== '\r' && text[k] !== '\n') { if (send(w)) return true; break; }
    for (let s = w + 1, stop = lineEnd(w); s <= stop; s++) if (space(s) && !space(s - 1) && send(skipSpace(s))) return true;
    return false;
  };
  // The loop's queued line at a line start j: `•[ \t]+` and one of the queued-input phrases, then `rest`.
  const queued = (j: number): boolean => {
    let a = j + 1;
    while (text[a] === ' ' || text[a] === '\t') a++;
    if (text[j] !== '•' || a === j + 1) return false;
    const inputs = words(a, 'Queued', 'follow-up', 'inputs'), call = words(a, 'Messages', 'to', 'be', 'submitted', 'after', 'next', 'tool', 'call');
    const turn = words(a, 'Messages', 'to', 'be', 'submitted', 'at', 'end', 'of', 'turn');
    return inputs >= 0 && rest(inputs) || call >= 0 && (rest(call) || press(call)) || turn >= 0 && rest(turn);
  };
  // The timer row from the line start p to its line's end.
  const row = (p: number, end: number): boolean => {
    let f = p;
    if (text[p] === '•' || text[p] === '◦') {
      do f++; while (text[f] === ' ' || text[f] === '\t');
      if (f === p + 1) return false;
    }
    if (f >= end || space(f) || '›•◦■✗✓─'.includes(text[f])) return false;
    const after = (c: number): boolean => c === end || c >= blank || text.startsWith(' · ', c); // `(?: · [^\r\n]*)?`
    let hint = -1; // The last ` to interrupt)` on the line that `after` accepts.
    for (let v = end - 14; v > f && hint < 0; v--) if (text.startsWith(' to interrupt)', v) && after(v + 14)) hint = v;
    for (let h = f + 1; h < end; h++) {
      if (text[h] !== ' ' || text[h + 1] !== '(') continue;
      let u = h + 2, timer = false; // `(?:[0-9]+[hm] )*[0-9]+s`
      for (;;) {
        const d = u;
        while (text[u] >= '0' && text[u] <= '9') u++;
        if (u === d) break;
        if (text[u] === 's') { u++; timer = true; break; }
        if (text[u] !== 'h' && text[u] !== 'm' || text[u + 1] !== ' ') break;
        u += 2;
      }
      if (timer && (text[u] === ')' ? after(u + 1) : text.startsWith(' • ', u) && hint >= u + 4)) return true;
    }
    return false;
  };
  for (let p = n; p >= 0; p--) {
    if (p > 0 && text[p - 1] !== '\n') continue;
    const end = lineEnd(p), tail = rest(end);
    if (p > 0) ok[p] = rest(p) || tail && p < end && (!'•◦›■✗✓─'.includes(text[p]) || text[p] === '›' && '⠁⠂⠄⠈⠐⠠⡀⢀'.includes(text[p + 1])) || queued(p) ? 1 : 0;
    if (tail && row(p, end)) return true;
  }
  return false;
}
/** The row Codex shows when it lost its connection, which reads as a timer row too: the same rule's `not`. */
const CODEX_RECONNECT_ROW = /^(?:[•◦][ \t]+)?Reconnect failed — check the endpoint, then relaunch \([0-9hms ]+\)$/u;

/** The screen above Codex's current prompt, as herdr's engine finds it (`before_current_prompt_marker`): the text
 *  before the last line that is `›` alone or `›` and a space, unless a later line opens with a response mark (`•`,
 *  `■`, `✗` or `✓`), which makes it a prompt already sent. Undefined with no current prompt, where herdr reads the
 *  whole screen: OAK claims no working pane without one. A line's trailing `\r` is not its text, as for herdr. */
function aboveCodexPrompt(screen: string): string | undefined {
  const lines = screen.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].replace(/\r$/, '');
    if (/^[•■✗✓]/u.test(line)) return undefined;
    if (line === '›' || line.startsWith('› ')) return lines.slice(0, i).join('\n') + (i ? '\n' : '');
  }
  return undefined;
}

/** Whether a Codex pane's screen (herdr's `pane.read`, as text) shows Codex at work: its live status row above its
 *  current prompt (codexWorkingRow), with no Reconnect failed row there. herdr's own rule, which herdr 0.9.1 ranks
 *  below the "Action Required" title that a question waiting gives the pane. */
export function codexScreenWorking(screen: string): boolean {
  const above = aboveCodexPrompt(screen);
  return above !== undefined && (above.includes(' to interrupt)') || above.includes('s)')) && codexWorkingRow(above)
    && !above.split('\n').some(line => CODEX_RECONNECT_ROW.test(line.replace(/\r$/, '')));
}

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
    // Also a Codex agent working with a question waiting (paneAgentState): herdr rejects a prompt to any pane it
    // calls blocked (`agent_blocked`, before sending input), and Codex takes the answer in its own question view.
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
