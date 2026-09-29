/* A scripted herdr for tests: a socket server that answers one NDJSON request per connection from a
   table of handlers and records every request, plus a `herdr` binary that turns the CLI verbs OAK sends
   to a saved machine (`--machine <label> pane process-info …`) into requests to the same server, so
   both transports share one script and one log. No real herdr is contacted. */
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

async function fakeHerdr(t, handlers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-fake-herdr-'));
  const socketPath = path.join(dir, 'herdr.sock');
  const requests = [];
  // What `session.snapshot` answers unless a test scripts it: the snapshot the pass under test was given
  // (`fake.snapshot = …`), so a driver that reads the server again sees the same server.
  const fake = {};
  handlers = { 'session.snapshot': () => {
    if (!fake.snapshot) throw Object.assign(new Error('unscripted session.snapshot'), { code: 'unknown_method' });
    return { type: 'session_snapshot', snapshot: { version: '0.9.1', protocol: 22, workspaces: [], tabs: [], panes: [], agents: [], ...fake.snapshot } };
  }, ...handlers };
  const server = net.createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const request = JSON.parse(buffer.slice(0, end));
      requests.push(request);
      let reply;
      try {
        const handler = handlers[request.method];
        if (!handler) throw Object.assign(new Error(`unscripted ${request.method}`), { code: 'unknown_method' });
        reply = { id: request.id, result: handler(request.params ?? {}) };
      } catch (error) { reply = { id: request.id, error: { code: error.code || 'failed', message: error.message } }; }
      socket.end(JSON.stringify(reply) + '\n');
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (!['EPERM', 'EACCES', 'EAFNOSUPPORT'].includes(error.code)) throw error;
    t.skip(`SKIP: Unix socket binding unavailable (${error.code}); nothing was verified.`);
    return null;
  }
  t.after(() => new Promise(resolve => server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); resolve(); })));

  // `herdr --machine <label> <verb…>` for the verbs a saved machine gets; prints the CLI's envelope.
  const binary = path.join(dir, 'herdr');
  fs.writeFileSync(binary, `#!${process.execPath}
const net = require('net');
const [, , flag, machine, ...argv] = process.argv;
const at = name => argv[argv.indexOf(name) + 1];
const verb = argv.slice(0, 2).join(' ');
const call = verb === 'api snapshot' ? ['session.snapshot', {}]
  : verb === 'pane process-info' ? ['pane.process_info', { pane_id: at('--pane') }]
  : verb === 'pane send-text' ? ['pane.send_text', { pane_id: argv[2], text: argv[3] }]
  : verb === 'tab create' ? ['tab.create', { workspace_id: at('--workspace'), label: at('--label') }]
  : verb === 'tab rename' ? ['tab.rename', { tab_id: argv[2], label: argv[3] }]
  : verb === 'pane rename' ? ['pane.rename', { pane_id: argv[2], label: argv[3] }]
  : null;
if (flag !== '--machine' || !call) { process.stderr.write('fake herdr: unsupported ' + process.argv.slice(2).join(' ')); process.exit(2); }
const socket = net.createConnection(${JSON.stringify(socketPath)});
let out = '';
socket.setEncoding('utf8');
socket.on('data', d => { out += d; });
socket.on('end', () => {
  const reply = JSON.parse(out);
  process.stdout.write(JSON.stringify(reply) + '\\n');
  process.exit(reply.error ? 1 : 0);
});
socket.on('connect', () => socket.write(JSON.stringify({ id: 'cli', method: call[0], params: { ...call[1], machine } }) + '\\n'));
`, { mode: 0o755 });

  return Object.assign(fake, {
    socketPath, binary, requests,
    sent: () => requests.filter(r => r.method === 'pane.send_text').map(r => r.params),
    calls: method => requests.filter(r => r.method === method).map(r => r.params),
  });
}

/** herdr's `pane.process_info` for a pane whose shell (pid 100) is idle, runs a command, or was replaced
 *  by `exec` — shaped like herdr 0.9.1's real answers on Linux and macOS. */
const processInfo = {
  idle: (pane, name = 'zsh') => ({ pane_id: pane, shell_pid: 100, foreground_process_group_id: 100, foreground_processes: [{ pid: 100, name, argv: [name] }] }),
  running: (pane, name = 'sleep') => ({ pane_id: pane, shell_pid: 100, foreground_process_group_id: 200, foreground_processes: [{ pid: 200, name, argv: [name, '30'] }] }),
  replaced: (pane, name = 'bpytop') => ({ pane_id: pane, shell_pid: 100, foreground_process_group_id: 100, foreground_processes: [{ pid: 100, name, argv: ['/usr/bin/python3', name] }] }),
};

/** A `pane.process_info` handler answering each pane from its list in order; the last answer repeats,
 *  and a pane with no list is running a command. */
function scripted(states) {
  const seen = {};
  return ({ pane_id }) => {
    const list = states[pane_id] ?? [processInfo.running(pane_id)];
    const at = Math.min(seen[pane_id] = (seen[pane_id] ?? -1) + 1, list.length - 1);
    return { type: 'pane_process_info', process_info: list[at] };
  };
}

module.exports = { fakeHerdr, processInfo, scripted };
