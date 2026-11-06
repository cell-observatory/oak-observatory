// A separate event loop serves synchronous capture hooks as well as the interactive app.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
if (!isMainThread) {
  const net = require('node:net');
  const fs = require('node:fs');
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let input = '';
    socket.on('data', chunk => {
      input += chunk;
      if (!input.includes('\n')) return;
      const { id, method, params } = JSON.parse(input.split('\n')[0]);
      fs.appendFileSync(workerData.log, JSON.stringify({ method, params, at: Date.now() }) + '\n');
      if (workerData.scenario === 'timeout' && method === 'pane.process_info') return;
      const reply = () => {
        const info = { pane_id: 'w1:p1', shell_pid: workerData.pid, tty: workerData.tty };
        if (workerData.scenario === 'foreign') { info.shell_pid = 2147483647; info.tty = '/dev/oak-foreign'; }
        if (workerData.scenario === 'wrong-tty') info.tty = '/dev/oak-foreign';
        if (workerData.scenario === 'tty') info.shell_pid = 2147483647;
        const error = workerData.scenario === 'stale' ? { code: 'pane_not_found', message: 'no such pane' } : null;
        const result = method === 'pane.process_info' ? { type: 'pane_process_info', process_info: info }
          : method === 'session.snapshot' ? { type: 'session_snapshot', snapshot: { version: '0.9.1', protocol: 22, workspaces: [], tabs: [], panes: [], agents: [] } }
          : { type: 'ok' };
        socket.end(JSON.stringify({ id, ...(error ? { error } : { result }) }) + '\n');
      };
      // `awaitPid`: a test that learns the pane's pid only after starting its client holds the answer until it is set,
      // so a slow machine cannot answer for a pane with no process yet.
      const answer = () => workerData.awaitPid && workerData.pid === undefined && Date.now() - asked < 10000 ? setTimeout(answer, 10) : reply();
      const asked = Date.now();
      if (workerData.delay) setTimeout(answer, workerData.delay); else answer();
    });
  });
  server.on('error', error => parentPort.postMessage({ error: error.message }));
  // Where herdr's clients connect: the marker itself, or on Windows the named pipe it names.
  server.listen(require('../../dist/herdr').herdrConnectPath({ HERDR_SOCKET_PATH: workerData.socketPath }), () => parentPort.postMessage({ ready: true }));
  parentPort.on('message', message => Object.assign(workerData, message));
} else {
  module.exports = async function paneServer(t, dir, scenario, options = {}) {
    const path = require('node:path');
    const fs = require('node:fs');
    const socketPath = path.join(dir, 'herdr.sock'), log = path.join(dir, 'requests');
    fs.mkdirSync(dir, { recursive: true });
    const worker = new Worker(__filename, { workerData: { socketPath, log, scenario, pid: options.awaitPid ? undefined : process.pid, ...options } });
    t.after(() => worker.terminate());
    await new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.once('message', msg => msg.error ? reject(new Error(msg.error)) : resolve());
    });
    return { socketPath, update: data => worker.postMessage(data), calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] };
  };
}
