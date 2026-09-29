/** Local focus endpoint client. Unix socket (0600) in a private directory, or a Windows named pipe. */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { rootDir } from './store';
import { spawnTool } from './spawn';
import type { Check } from './diagnose';

/** Bump when the wire shapes change incompatibly. A client and server of different protocols refuse
 *  each other on hello — the ONE fatal mismatch, by design cheaper than any migration. */
export const DAEMON_PROTOCOL = 2;

export interface DaemonPaths {
  dir: string;
  sock: string;
  /** The directory the socket file lives in — the store root, or the runtime fallback when the root
   *  is too deep for a unix socket path. The server keeps it 0700 and owned by the user. */
  sockDir: string;
  pid: string;
  log: string;
}

/** Linux caps a unix socket path at 108 bytes (macOS at 104); a store root nested a few directories
 *  deep is already past it, and `listen` answers EINVAL. Past this many bytes the socket moves to a
 *  per-user runtime directory, named by a hash of the root so two roots never share one. */
const SOCK_PATH_MAX = 96;

/** Where the server lives for THIS store root. Keyed on the root (which follows CLAUDE_CONFIG_DIR),
 *  so two config dirs get two servers and the test suite's sandboxes never share one. */
export function daemonPaths(): DaemonPaths {
  const dir = rootDir();
  const hash = crypto.createHash('sha1').update(dir).digest('hex').slice(0, 16);
  let sock: string;
  let sockDir = dir;
  if (process.platform === 'win32') {
    sock = `\\\\.\\pipe\\oak-${hash}`;
  } else {
    sock = path.join(dir, 'oak.sock');
    if (Buffer.byteLength(sock) > SOCK_PATH_MAX) {
      const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
      sockDir = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), `oak-${uid}`);
      sock = path.join(sockDir, `${hash}.sock`);
    }
  }
  return { dir, sock, sockDir, pid: path.join(dir, 'oak-server.pid'), log: path.join(dir, 'oak-server.log') };
}

/** Focus is the only application operation; herdr owns terminals and agents. */
export type FocusTab = 'observatory' | 'review' | 'herdr';
export type ClientOp =
  | { op: 'hello'; protocol: number; client: string }
  | { op: 'watch'; id?: number }
  | { op: 'focus'; id?: number; session: string; tab: FocusTab }
  | { op: 'shutdown'; id?: number };
export type ServerEvent =
  | { event: 'hello'; protocol: number; pid: number; generation: string; build: string; started: number }
  | { event: 'focus'; session: string; tab: FocusTab }
  | { event: 'ok'; re: number }
  | { event: 'error'; re?: number; why: string; fatal?: boolean }
  | { event: 'bye' };

export type HelloEvent = Extract<ServerEvent, { event: 'hello' }>;

/** A stamp of the running build — the same mtime:size the app's own `updateSkew` compares, so a
 *  client can say "the server is an older oak" without a version field the payloads never carried. */
export function buildStamp(file = process.argv[1] ?? ''): string {
  try {
    const st = fs.statSync(file);
    return `${Math.trunc(st.mtimeMs)}:${st.size}`;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------------

export interface DaemonClient {
  hello: HelloEvent;
  alive: boolean;
  send(op: ClientOp): void;
  /** Send an op that carries an `id` and resolve on the event that answers it (`re` === id). An
   *  `error` answering it rejects. A dead connection rejects at once. */
  request<T extends ServerEvent = ServerEvent>(op: ClientOp & { id?: number }, timeoutMs?: number): Promise<T>;
  on(fn: (ev: ServerEvent) => void): () => void;
  onClose(fn: () => void): void;
  /** End this focus connection. */
  close(): void;
}

/** Parse one NDJSON stream into objects; a garbage line is skipped, never fatal. */
function lineParser(onLine: (o: Record<string, unknown>) => void): (chunk: Buffer) => void {
  let buf = '';
  const decoder = new StringDecoder('utf8');
  return (chunk: Buffer) => {
    buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as unknown;
        if (o && typeof o === 'object') onLine(o as Record<string, unknown>);
      } catch {
        /* one bad line — ignored, the stream goes on */
      }
    }
  };
}

/** Connect to the local focus endpoint, or return null if it is absent or incompatible. */
export function connectDaemon(opts: { client: string; timeoutMs?: number; inspect?: boolean } = { client: 'oak' }): Promise<DaemonClient | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: DaemonClient | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let wire: net.Socket;
    try {
      wire = net.connect(daemonPaths().sock);
    } catch {
      return done(null);
    }
    const listeners = new Set<(ev: ServerEvent) => void>();
    const closers = new Set<() => void>();
    const pending = new Map<number, { resolve: (ev: ServerEvent) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
    let nextId = 1;
    let alive = false;
    const client: DaemonClient = {
      hello: undefined as unknown as HelloEvent,
      get alive() {
        return alive;
      },
      send(op) {
        if (!alive) return;
        try {
          wire.write(JSON.stringify(op) + '\n');
        } catch {
          /* the wire died between the check and the write — onClose reports it */
        }
      },
      request(op, timeoutMs = 10_000) {
        return new Promise((res, rej) => {
          if (!alive) return rej(new Error('the oak server is not connected'));
          const id = nextId++;
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error(`the oak server did not answer ${op.op} within ${timeoutMs} ms`));
          }, timeoutMs);
          pending.set(id, { resolve: res as (ev: ServerEvent) => void, reject: rej, timer });
          client.send({ ...op, id } as ClientOp);
        });
      },
      on(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      onClose(fn) {
        closers.add(fn);
      },
      close() {
        alive = false;
        wire.end();
        wire.destroy();
      },
    };
    const timer = setTimeout(() => {
      if (!alive) {
        wire.destroy();
        done(null);
      }
    }, opts.timeoutMs ?? 5_000);
    wire.on('error', () => {
      if (!alive) done(null);
    });
    wire.on('close', () => {
      const was = alive;
      alive = false;
      clearTimeout(timer);
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error('the oak server closed the connection'));
      }
      pending.clear();
      if (!was) return done(null);
      for (const fn of closers) {
        try {
          fn();
        } catch {
          /* a listener's fault stays its own */
        }
      }
    });
    wire.on('data', 
      lineParser((o) => {
        const ev = o as unknown as ServerEvent;
        if (!alive) {
          // The first line MUST be the server's hello; anything else (or the wrong protocol) is a
          // server this client cannot talk to. Refuse cleanly and let the caller decide.
          if (ev.event !== 'hello' || !Number.isSafeInteger(ev.protocol) || (!opts.inspect && ev.protocol !== DAEMON_PROTOCOL)) {
            clearTimeout(timer);
            wire.destroy();
            return done(null);
          }
          client.hello = ev as HelloEvent;
          alive = true;
          clearTimeout(timer);
          if (!opts.inspect) wire.write(JSON.stringify({ op: 'hello', protocol: DAEMON_PROTOCOL, client: opts.client }) + '\n');
          return done(client);
        }
        const re = (ev as { re?: number }).re;
        if (typeof re === 'number' && pending.has(re)) {
          const p = pending.get(re)!;
          pending.delete(re);
          clearTimeout(p.timer);
          if (ev.event === 'error') p.reject(new Error((ev as { why: string }).why));
          else p.resolve(ev);
          // An answered request is still an event — focus acknowledgements also reach listeners.
        }
        for (const fn of listeners) {
          try {
            fn(ev);
          } catch {
            /* a listener's fault stays its own */
          }
        }
      })
    );
  });
}

export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readDaemonPid(): number | null {
  try {
    const n = Number(fs.readFileSync(daemonPaths().pid, 'utf8').trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Reap what a dead server left behind: a pidfile whose process is gone, and its socket file. A
 * live pid is never touched, and on Windows the pipe vanishes with its process, so only the pidfile
 * is reclaimed there. Returns true when something was removed.
 */
export function reclaimStaleDaemon(): boolean {
  const p = daemonPaths();
  const pid = readDaemonPid();
  if (pid !== null && pidAlive(pid)) return false;
  let removed = false;
  for (const f of [p.pid, ...(process.platform === 'win32' ? [] : [p.sock])]) {
    try {
      fs.unlinkSync(f);
      removed = true;
    } catch {
      /* not there */
    }
  }
  return removed;
}

/** How the server is launched: the running oak entry by default, or an explicit file + args (the
 *  editors pass the CLI they resolved rather than their own host binary). */
export interface DaemonLaunch {
  file: string;
  args: string[];
  /** The launcher product version. */
  version?: string;
}

export function defaultDaemonLaunch(): DaemonLaunch {
  return { file: process.execPath, args: [process.argv[1] ?? '', 'server', '--daemon'] };
}

/** Start the server detached, its stdio on the log file, and return its pid (or null when the spawn
 *  itself failed). The caller polls `connectDaemon` — the process announces itself by listening. */
export function spawnDaemon(launch: DaemonLaunch = defaultDaemonLaunch()): number | null {
  const p = daemonPaths();
  try {
    fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
    const out = fs.openSync(p.log, 'a', 0o600);
    const child = spawnTool(launch.file, launch.args, {
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
      env: { ...process.env, OAK_SERVER_LAUNCHER: String(process.pid), ...(launch.version ? { OAK_VERSION: launch.version } : {}) },
    });
    child.on('error', () => {
      /* reported by the connect that never succeeds */
    });
    child.unref();
    try {
      fs.closeSync(out);
    } catch {
      /* the child holds its own copy */
    }
    return child.pid ?? null;
  } catch {
    return null;
  }
}

/**
 * Connect to a running server, or spawn one and wait for it — the door every client uses. Null when
 * no server could be reached within the window, with the reason on `why`.
 */
export async function ensureDaemon(opts: { client: string; spawn?: boolean; launch?: DaemonLaunch; timeoutMs?: number; repairOutdated?: boolean } = { client: 'oak' }): Promise<{ client: DaemonClient | null; why: string; spawned: boolean }> {
  if (opts.repairOutdated) {
    const check = await diagnoseFocusServer(true);
    if (check.level === 'fail') return { client: null, why: check.detail, spawned: false };
  }
  const first = await connectDaemon({ client: opts.client, timeoutMs: 1500 });
  if (first) return { client: first, why: '', spawned: false };
  if (opts.spawn === false) return { client: null, why: 'no oak server is running', spawned: false };
  reclaimStaleDaemon();
  const pid = spawnDaemon(opts.launch);
  if (pid === null) return { client: null, why: 'the oak server could not be started', spawned: false };
  const deadline = Date.now() + (opts.timeoutMs ?? 6000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 120));
    const c = await connectDaemon({ client: opts.client, timeoutMs: 1000 });
    if (c) return { client: c, why: '', spawned: true };
    if (!pidAlive(pid)) break; // it died — its log says why
  }
  return { client: null, why: `the oak server did not start (see ${daemonPaths().log})`, spawned: true };
}

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  protocol: number | null;
  build: string;
  generation: string;
  started: number;
  sock: string;
  log: string;
  /** A pidfile whose process is gone — `oak server start` reclaims it. */
  stale: boolean;
}

export async function daemonStatus(): Promise<DaemonStatus> {
  const p = daemonPaths();
  const pid = readDaemonPid();
  const base: DaemonStatus = { running: false, pid, protocol: null, build: '', generation: '', started: 0, sock: p.sock, log: p.log, stale: pid !== null && !pidAlive(pid) };
  const c = await connectDaemon({ client: 'status', timeoutMs: 1500, inspect: true });
  if (!c) return base;
  try {
    return { ...base, running: true, pid: c.hello.pid, protocol: c.hello.protocol, build: c.hello.build, generation: c.hello.generation, started: c.hello.started, stale: false };
  } finally {
    c.close();
  }
}

/** Stop the focus endpoint. Agent and terminal lifetimes belong to herdr. */
export async function stopDaemon(timeoutMs = 5000): Promise<{ stopped: boolean; why: string }> {
  const c = await connectDaemon({ client: 'stop', timeoutMs: 1500, inspect: true });
  const pid = c?.hello.pid ?? readDaemonPid();
  if (!c && (pid === null || !pidAlive(pid))) {
    reclaimStaleDaemon();
    return { stopped: false, why: 'no oak server is running' };
  }
  if (c) {
    await new Promise<void>((r) => {
      const t = setTimeout(r, timeoutMs);
      c.onClose(() => {
        clearTimeout(t);
        r();
      });
      c.send({ op: 'hello', protocol: c.hello.protocol, client: 'stop' });
      c.send({ op: 'shutdown' });
    });
    c.close();
  }
  const deadline = Date.now() + timeoutMs;
  while (pid !== null && pidAlive(pid) && Date.now() < deadline) {
    if (Date.now() > deadline - timeoutMs / 2) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  reclaimStaleDaemon();
  return pid !== null && pidAlive(pid) ? { stopped: false, why: `the oak server (pid ${pid}) did not stop` } : { stopped: true, why: '' };
}

/** A focus endpoint owns no terminals. Replace a mismatched build before a TUI attaches to it. */
export async function diagnoseFocusServer(fix = false): Promise<Check> {
  const row = { id: 'focus-server', label: 'OAK focus server' };
  const status = await daemonStatus();
  if (!status.running) return { ...row, level: 'ok', detail: 'not running; starts when a terminal opens' };
  const build = buildStamp();
  const mismatch = status.protocol !== DAEMON_PROTOCOL || (!!build && status.build !== build);
  if (!mismatch) return { ...row, level: 'ok', detail: `current build, protocol ${status.protocol}` };
  const detail = `outdated server (pid ${status.pid}, protocol ${status.protocol})`;
  if (!fix) return { ...row, level: 'warn', detail, fix: 'oak doctor --fix' };
  const result = await stopDaemon();
  return result.stopped
    ? { ...row, level: 'ok', detail: `stopped ${detail}; the next terminal starts the current build` }
    : { ...row, level: 'fail', detail: `could not stop ${detail}: ${result.why}`, fix: 'oak server stop' };
}
