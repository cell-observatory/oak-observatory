/** Local focus routing only. Terminals and agent control are owned by herdr. */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import type { ClientOp, ServerEvent } from '@oak-observatory/core';
type Core = typeof import('@oak-observatory/core');

/** Run the private socket endpoint until stopped, or idle with no attached OAK clients. */
export function runServer(core: Core, opts: { idleExitMs?: number } = {}): void {
  const paths = core.daemonPaths();
  const log = (text: string): void => { process.stderr.write(`${new Date().toISOString()} ${text}\n`); };
  const die = (why: string): never => { log(why); process.exit(1); };
  for (const dir of new Set([paths.dir, paths.sockDir])) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      // The socket's fallback directory sits in a shared temp directory, where another user could plant the path
      // as a link to one of your own directories: stat would follow it and the chmod below would close it.
      const st = dir === paths.dir ? fs.statSync(dir) : fs.lstatSync(dir);
      if (dir !== paths.dir && !st.isDirectory()) die(`focus socket directory is not a plain directory: ${dir}`);
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) die(`focus socket directory is not owned by you: ${dir}`);
      fs.chmodSync(dir, 0o700);
    }
  }
  const existing = core.readDaemonPid();
  if (existing !== null && core.pidAlive(existing)) die(`already running (pid ${existing})`);
  core.reclaimStaleDaemon();
  const generation = crypto.randomUUID(), started = Date.now(), build = core.buildStamp();
  const clients = new Map<net.Socket, { hello: boolean; watch: boolean }>();
  const send = (sock: net.Socket, ev: ServerEvent): void => { if (!sock.destroyed) sock.write(JSON.stringify(ev) + '\n'); };
  let idle: NodeJS.Timeout | undefined;
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    if (idle) clearTimeout(idle);
    for (const sock of clients.keys()) { send(sock, { event: 'bye' }); sock.end(); }
    server.close();
    for (const file of [paths.pid, ...(process.platform === 'win32' ? [] : [paths.sock])]) {
      try { fs.unlinkSync(file); } catch { /* already removed */ }
    }
    setTimeout(() => process.exit(0), 50).unref();
  };
  const armIdle = (): void => {
    if (idle) clearTimeout(idle);
    if (!clients.size && !stopping) idle = setTimeout(shutdown, opts.idleExitMs ?? 30_000);
  };
  const server = net.createServer(sock => {
    if (idle) clearTimeout(idle);
    const client = { hello: false, watch: false };
    clients.set(sock, client);
    send(sock, { event: 'hello', protocol: core.DAEMON_PROTOCOL, pid: process.pid, generation, build, started });
    let buffer = '';
    sock.setEncoding('utf8');
    sock.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 64 * 1024) { sock.destroy(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let op: ClientOp;
        try { op = JSON.parse(line); } catch { send(sock, { event: 'error', why: 'expected a JSON operation' }); continue; }
        if (!op || typeof op !== 'object') continue;
        if (!client.hello) {
          if (op.op !== 'hello' || op.protocol !== core.DAEMON_PROTOCOL) {
            send(sock, { event: 'error', why: `protocol mismatch — this server speaks ${core.DAEMON_PROTOCOL}; restart oak server`, fatal: true });
            sock.end(); return;
          }
          client.hello = true; continue;
        }
        const re = 'id' in op && typeof op.id === 'number' ? op.id : undefined;
        const error = (why: string): void => send(sock, { event: 'error', re, why });
        if (op.op === 'watch') client.watch = true;
        else if (op.op === 'focus') {
          if (!core.isSafeSessionId(op.session) || !['observatory', 'review', 'herdr'].includes(op.tab)) { error('focus needs a session and tab: observatory | review | herdr'); continue; }
          const readers = [...clients].filter(([, c]) => c.hello && c.watch);
          if (!readers.length) { error('no OAK terminal is attached — open oak tui first'); continue; }
          for (const [reader] of readers) send(reader, { event: 'focus', session: op.session, tab: op.tab });
        } else if (op.op === 'shutdown') {
          if (re !== undefined) send(sock, { event: 'ok', re });
          shutdown(); return;
        } else { error(`unknown focus operation: ${op.op}`); continue; }
        if (re !== undefined) send(sock, { event: 'ok', re });
      }
    });
    sock.on('error', () => { /* close handles cleanup */ });
    sock.on('close', () => { clients.delete(sock); armIdle(); });
  });
  server.on('error', error => die(`cannot listen on ${paths.sock}: ${error.message}`));
  server.listen(paths.sock, () => {
    if (process.platform !== 'win32') fs.chmodSync(paths.sock, 0o600);
    fs.writeFileSync(paths.pid, String(process.pid), { mode: 0o600 });
    log(`focus endpoint listening on ${paths.sock}`); armIdle();
  });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGHUP', () => { /* independent of the launching terminal */ });
}
