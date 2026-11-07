// Separate listers and a transcript writer. The converter barrier widens a real lock window.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const DIST = process.env.OAK_INDEX_TEST_DIST || path.resolve(__dirname, '../../dist');
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (process.argv[2] === 'child') {
  const core = require(DIST);
  let opened;
  process.on('message', async ({ cmd, dir, mode, release }) => {
    try {
      if (dir) {
        process.env.HOME = process.env.USERPROFILE = dir;
        process.env.CLAUDE_CONFIG_DIR = path.join(dir, '.claude');
        process.env.CODEX_HOME = path.join(dir, '.codex');
        core.clearRootMemo(); core.clearFsCache(); core.resetIndexRuntime();
      }
      const work = path.join(process.env.HOME, 'work');
      const parent = '0199a000-0000-7000-8000-00000000c0de';
      const review = '0199a000-0000-7000-8000-00000000a0a0';
      const rollout = id => path.join(process.env.CODEX_HOME, 'sessions/2026/10/01', `rollout-2026-10-01T10-00-00-${id}.jsonl`);
      const claude = path.join(core.projectDir(work), `${parent}.jsonl`);
      const line = o => JSON.stringify({ timestamp: '2026-10-01T10:00:01Z', ...o }) + '\n';
      const prompt = text => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
      const claudePrompt = line({ type: 'user', cwd: work, sessionId: parent, message: { role: 'user', content: 'Fix the synthetic exporter' } });
      if (cmd === 'seed') {
        fs.mkdirSync(work, { recursive: true });
        if (mode === 'claude') {
          fs.mkdirSync(path.dirname(claude), { recursive: true });
          fs.writeFileSync(claude, line({ type: 'system', cwd: work, sessionId: parent }) + claudePrompt.slice(0, -16));
          process.send({ ok: true });
          return;
        }
        fs.mkdirSync(path.dirname(rollout(parent)), { recursive: true });
        const records = line({ type: 'session_meta', payload: { id: parent, cwd: work } }) + line(prompt('# AGENTS.md instructions\nSynthetic context'));
        fs.writeFileSync(rollout(parent), records);
        if (mode === 'review') fs.writeFileSync(rollout(review), line({ type: 'session_meta', payload: { id: review, cwd: work, thread_source: 'guardian_review', parent_thread_id: parent } }) + line(prompt('Assess the synthetic action.')));
        process.send({ ok: true });
      } else if (cmd === 'finish') {
        if (mode === 'claude') fs.appendFileSync(claude, claudePrompt.slice(-16));
        else fs.appendFileSync(rollout(parent), line(prompt('Fix the synthetic exporter')));
        process.send({ ok: true });
      } else if (cmd === 'lease') {
        opened = core.openIndex();
        if (!opened.ok || !core.tryLease(opened.db)) throw new Error('no lease');
        process.send({ ok: true });
      } else if (cmd === 'convert') {
        const open = fs.openSync;
        const read = fs.readSync;
        let held = false;
        let claudeFd;
        const target = createHash('sha256').update(path.resolve(rollout(parent))).digest('hex');
        const hold = () => {
          held = true;
          process.send({ held: true });
          const end = Date.now() + 30000;
          while (!fs.existsSync(release)) { if (Date.now() > end) throw new Error('reader barrier timed out'); sleep(2); }
        };
        fs.openSync = function(file, flags, ...rest) {
          const fd = open.call(this, file, flags, ...rest);
          if (String(file) === claude) claudeFd = fd;
          if (!held && flags === 'wx' && String(file).endsWith(path.join(target, '.lock'))) {
            hold();
          }
          return fd;
        };
        fs.readSync = function(fd, ...args) {
          const n = read.call(this, fd, ...args);
          if (mode === 'claude' && !held && fd === claudeFd) hold();
          return n;
        };
        try {
          // Like the CLI: while the first lister owns catch-up, use the files listing.
          const ix = core.useIndex({ budgetMs: Infinity, inlineBytes: Infinity });
          if (!ix.ok) throw new Error(ix.reason);
          const rows = ix.catchUp.caughtUp ? core.indexedSessionMeta(ix.db, work, review) : core.sessionMeta(work, review);
          ix.close();
          process.send({ ok: true, held, rows: rows.sessions });
        } finally { fs.openSync = open; fs.readSync = read; }
      } else if (cmd === 'list' || cmd === 'again') {
        if (!opened) { opened = core.openIndex(); if (!opened.ok) throw new Error(opened.reason); }
        const caught = core.catchUp(opened.db, { budgetMs: Infinity });
        const stored = opened.db.prepare('SELECT session_id, title, listed FROM sessions ORDER BY session_id').all();
        const rows = caught.caughtUp ? core.indexedSessionMeta(opened.db, work, review) : core.sessionMeta(work, review);
        opened.close(); opened = null;
        process.send({ ok: true, caught, stored, rows: rows.sessions });
      } else throw new Error(`bad command ${cmd}`);
    } catch (e) { process.send({ error: e.stack }); }
  });
} else {
  function worker() {
    const child = cp.fork(__filename, ['child'], { env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let errors = '';
    child.stderr.on('data', b => errors += b);
    const messages = [], waits = [];
    child.on('message', m => { const w = waits.shift(); if (w) w(m); else messages.push(m); });
    const receive = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child timed out: ${errors}`)), 35000);
      const done = m => { clearTimeout(timer); m.error ? reject(new Error(m.error)) : resolve(m); };
      if (messages.length) done(messages.shift()); else waits.push(done);
    });
    return { child, receive, send: m => child.send(m), call(m) { child.send(m); return receive(); } };
  }
  async function race(dir, mode, workers) {
    const [a, b, writer] = workers;
    const release = path.join(dir, 'release');
    try {
      await writer.call({ cmd: 'seed', dir, mode });
      await a.call({ cmd: 'lease', dir });
      b.send({ cmd: 'convert', dir, release, mode });
      const held = await b.receive();
      if (!held.held) throw new Error(`converter did not hold: ${JSON.stringify(held)}`);
      await writer.call({ cmd: 'finish', mode });
      const during = await a.call({ cmd: 'list' });
      fs.writeFileSync(release, '');
      const other = await b.receive();
      const after = await a.call({ cmd: 'again' });
      return { during, other, after };
    } finally { fs.writeFileSync(release, ''); }
  }
  module.exports = { worker, race };
}
