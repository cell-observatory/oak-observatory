/** Inherited pane markers are hints: an editor launched in herdr keeps them in its own terminals. */
import { spawnToolSync } from './spawn';
import type { PaneProcessInfo } from './herdr-api';
import type { Check } from './diagnose';

/** `unknown`: the process table could not be read in time, so membership is undecided: neither nested nor stale, and
 *  never cached, so the next check decides. */
export interface HerdrPaneContext { nested: boolean; stale: boolean; unknown?: boolean; paneId?: string; socketPath?: string }
const outside: HerdrPaneContext = { nested: false, stale: false };
/** The pane check's bounds, and a Codex hook's identity report's (herdr-link.ts), are short: a capture hook waits on
 *  them. OAK_HERDR_CHECK_MS replaces each of them, for the test suite on a loaded machine, where the probe's own Node
 *  start can outlast 400 ms and a test that needs the check to succeed would fail. */
export function herdrCheckMs(ms: number): number {
  const set = Number(process.env.OAK_HERDR_CHECK_MS);
  return set > 0 ? set : ms;
}
const decisions = new Map<string, HerdrPaneContext>();
const pending = new Map<string, Promise<HerdrPaneContext>>();
const keyFor = (pane: string, socket: string): string => JSON.stringify([pane, socket]);
const ttyName = (tty?: string | null): string => !tty || /^(?:\?+|-)$/.test(tty) ? '' : tty.replace(/^\/dev\//, '');

function belongs(info: PaneProcessInfo, psTimeout: number): boolean | null {
  const roots = new Set([info.shell_pid, ...(info.foreground_processes ?? []).map(p => p.pid)]);
  if (roots.has(process.pid)) return true;
  if (process.platform === 'win32') return false;
  // One bounded process-table read, no command lines. ps reports the controlling tty even when a hook's
  // stdin is a pipe. Stop at a different tty: an editor can still descend from the old pane's shell.
  const result = spawnToolSync('ps', ['-axo', 'pid=,ppid=,tty='], { encoding: 'utf8', timeout: psTimeout, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024, direct: true });
  if (result.status !== 0 || result.error) return null; // a slow or failed read decides nothing
  const rows = new Map<number, { parent: number; tty: string }>();
  for (const line of String(result.stdout).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (match) rows.set(Number(match[1]), { parent: Number(match[2]), tty: ttyName(match[3]) });
  }
  const own = rows.get(process.pid);
  if (!own) return false;
  const paneTty = ttyName(info.tty);
  if (paneTty) return !!own.tty && own.tty === paneTty;
  const seen = new Set<number>();
  for (let pid = process.pid; pid > 1 && !seen.has(pid);) {
    seen.add(pid);
    const row = rows.get(pid);
    if (!row || (own.tty && row.tty !== own.tty)) return false;
    if (roots.has(pid)) return true;
    pid = row.parent;
  }
  return false;
}

function answer(paneId: string, socketPath: string, result: unknown, psTimeout: number): HerdrPaneContext {
  const value = result as { type?: string; process_info?: PaneProcessInfo } | undefined;
  if (value?.type !== 'pane_process_info' || !value.process_info) return outside;
  if (value.process_info.pane_id !== paneId) return { nested: false, stale: true };
  const member = belongs(value.process_info, psTimeout);
  if (member === null) return { nested: false, stale: false, unknown: true };
  return { nested: member, stale: !member, ...(member ? { paneId, socketPath } : {}) };
}
function failed(error: unknown): HerdrPaneContext {
  const code = (error as { code?: string })?.code;
  return { nested: false, stale: code === 'pane_not_found' || code === 'not_found' };
}

/** One request per pane/socket for this process's life, shared by concurrent callers and capture hooks. */
export function herdrPaneContext(env: NodeJS.ProcessEnv = process.env): Promise<HerdrPaneContext> {
  const pane = env.HERDR_PANE_ID;
  if (!pane) return Promise.resolve(outside);
  const { herdrRequest, herdrSocketPath } = require('./herdr') as typeof import('./herdr');
  const socket = herdrSocketPath(env), key = keyFor(pane, socket);
  const cached = decisions.get(key);
  if (cached) return Promise.resolve(cached);
  const running = pending.get(key);
  if (running) return running;
  const request = herdrRequest('pane.process_info', { pane_id: pane }, { socketPath: socket, timeoutMs: herdrCheckMs(400) })
    // Off the first paint, so the process-table read can take a loaded machine's second.
    .then(result => answer(pane, socket, result, herdrCheckMs(1000))).catch(failed).then(result => {
      // A synchronous hook may have had to settle the same context while this request was pending.
      if (!decisions.has(key) && !result.unknown) decisions.set(key, result);
      pending.delete(key);
      return decisions.get(key) ?? result;
    });
  pending.set(key, request);
  return request;
}

// Capture exits immediately after its synchronous handler. A small Node child asks the same read-only
// RPC without depending on a herdr executable (and cannot start a server). The parent caps its lifetime.
const probe = `
const net = require('net');
const socket = net.createConnection(process.argv[1]);
let data = '';
socket.on('error', () => process.exit(1));
socket.on('connect', () => socket.write(JSON.stringify({ id: 'oak-pane', method: 'pane.process_info', params: { pane_id: process.argv[2] } }) + '\\n'));
socket.on('data', chunk => {
  data += chunk;
  if (data.length > 1024 * 1024) process.exit(1);
  const end = data.indexOf('\\n');
  if (end >= 0) { socket.destroy(); process.stdout.write(data.slice(0, end)); }
});
`;
export function herdrPaneContextSync(env: NodeJS.ProcessEnv = process.env): HerdrPaneContext {
  const pane = env.HERDR_PANE_ID;
  if (!pane) return outside;
  const { herdrSocketPath, herdrConnectPath } = require('./herdr') as typeof import('./herdr');
  const socket = herdrSocketPath(env), key = keyFor(pane, socket);
  const cached = decisions.get(key);
  if (cached) return cached;
  let result = outside;
  try {
    const child = spawnToolSync(process.execPath, ['-e', probe, herdrConnectPath(env), pane], {
      encoding: 'utf8', timeout: herdrCheckMs(400), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, direct: true,
    });
    if (child.status === 0 && !child.error) {
      const reply = JSON.parse(String(child.stdout));
      if (reply.id === 'oak-pane') result = reply.error ? failed(reply.error) : answer(pane, socket, reply.result, herdrCheckMs(100));
    }
  } catch { /* Unknown is outside, silently. */ }
  if (!result.unknown) decisions.set(key, result);
  return result;
}

export async function diagnoseHerdrPane(env: NodeJS.ProcessEnv = process.env): Promise<Check[]> {
  return (await herdrPaneContext(env)).stale ? [{ id: 'herdr-pane', label: 'herdr pane', level: 'warn',
    detail: 'HERDR_PANE_ID names a pane this terminal is not in; started from a herdr pane?' }] : [];
}
