#!/usr/bin/env node
// Phase-0 probe for the herdr backend (2026-09-18). Executes the seams OAK will build on, against a
// SANDBOXED headless herdr server (its own XDG_CONFIG_HOME + HERDR_SOCKET_PATH), so it never touches
// the user's real herdr state. Skips LOUDLY when herdr is absent — a skipped probe must never read as
// a pass. Every check is a real execution: bootstrap a workspace over the socket, subscribe from this
// process, fire herdr's own claude hook script with a known session id, and read the join back.
//
// Run: node test/herdr-probe.js            (uses `herdr` on PATH, or HERDR_BIN)
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync, execFileSync } = require('child_process');

const bin = process.env.HERDR_BIN || 'herdr';
const which = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
if (which.status !== 0) {
  console.log('SKIP herdr-probe: no `herdr` binary on PATH (set HERDR_BIN). Nothing was verified.');
  process.exit(0);
}
const version = spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout.trim();
const py3 = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).status === 0;

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-probe-'));
const sock = path.join(T, 'herdr.sock');
const env = { ...process.env, XDG_CONFIG_HOME: path.join(T, 'cfg'), HERDR_SOCKET_PATH: sock };
fs.mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
const server = spawn(bin, ['server'], { env, stdio: 'ignore' });
const fails = [];
const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) fails.push(name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readLines = (c, onLine) => { let buf = ''; c.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) onLine(l); } }); };
let n = 0;
// The protocol is ONE request per connection (the server closes after the response); only
// events.subscribe keeps a connection open.
const one = (method, params = {}) => new Promise((res) => {
  const c = net.createConnection(sock);
  const t = setTimeout(() => { c.destroy(); res({ error: { code: 'timeout', message: method } }); }, 15000);
  c.on('error', (e) => { clearTimeout(t); res({ error: { code: 'socket', message: String(e.message) } }); });
  readLines(c, (l) => { clearTimeout(t); try { res(JSON.parse(l)); } catch { res({ error: { code: 'parse', message: l.slice(0, 80) } }); } c.end(); });
  c.once('connect', () => c.write(JSON.stringify({ id: 'p' + (++n), method, params }) + '\n'));
});

(async () => {
  console.log(`herdr-probe: ${version} (python3: ${py3 ? 'yes' : 'NO'})`);
  check('python3 present (the claude/codex hook scripts exit silently without it)', py3);
  for (let i = 0; i < 40 && !fs.existsSync(sock); i++) await sleep(250);
  check('sandboxed headless server came up', fs.existsSync(sock));
  const ping = await one('ping');
  check('ping → protocol 22', ping.result && ping.result.protocol === 22, JSON.stringify(ping.result || ping.error).slice(0, 120));

  const ws = await one('workspace.create', { cwd: os.tmpdir(), label: 'oak-probe', focus: true });
  const pane = ws.result && ws.result.root_pane && ws.result.root_pane.pane_id;
  check('workspace.create bootstraps a pane in a headless server', !!pane, pane);

  // Subscribe from THIS process (a persistent connection), then make a state change and expect the event.
  const events = [];
  const sc = net.createConnection(sock);
  sc.on('error', () => {});
  readLines(sc, (l) => { try { events.push(JSON.parse(l)); } catch { /* ignore */ } });
  await new Promise((r) => sc.once('connect', r));
  sc.write(JSON.stringify({ id: 'sub', method: 'events.subscribe', params: { subscriptions: [{ type: 'pane.agent_detected' }, { type: 'pane.agent_status_changed', pane_id: pane }] } }) + '\n');
  await sleep(300);
  check('events.subscribe started', events.some((e) => e.result && e.result.type === 'subscription_started'));
  events.length = 0;
  const rep = await one('pane.report_agent', { pane_id: pane, source: 'oak-probe', agent: 'claude', state: 'working' });
  await sleep(600);
  check('pane.report_agent accepted', rep.result && rep.result.type === 'ok');
  check('subscription delivered pane.agent_status_changed', events.some((e) => e.event === 'pane.agent_status_changed' && e.data && e.data.agent_status === 'working'), `${events.length} event(s)`);

  // The join: run herdr's OWN claude hook (the installed one if present, else the one bundled here is
  // not available — so we synthesize the same request it sends) with a known session id.
  const hook = path.join(os.homedir(), '.claude', 'hooks', 'herdr-agent-state.sh');
  if (fs.existsSync(hook) && py3) {
    const input = JSON.stringify({ session_id: 'oak-probe-session', transcript_path: '/tmp/oak-probe.jsonl', hook_event_name: 'SessionStart', source: 'startup' });
    const h = spawnSync('sh', [hook, 'session'], { input, env: { ...env, HERDR_ENV: '1', HERDR_PANE_ID: pane }, encoding: 'utf8' });
    check('installed claude hook ran', h.status === 0, (h.stderr || '').slice(0, 80));
  } else {
    const r = await one('pane.report_agent_session', { pane_id: pane, source: 'oak-probe', agent: 'claude', agent_session_id: 'oak-probe-session', agent_session_path: '/tmp/oak-probe.jsonl' });
    check('pane.report_agent_session accepted (hook not installed — synthesized its request)', r.result && r.result.type === 'ok');
  }
  const pg = await one('pane.get', { pane_id: pane });
  const sess = pg.result && pg.result.pane && pg.result.pane.agent_session;
  check('pane.get reports the session id (the OAK ⇄ herdr join)', sess && sess.value === 'oak-probe-session', JSON.stringify(sess));
  const snap = JSON.parse(execFileSync(bin, ['api', 'snapshot'], { env, encoding: 'utf8' })).result.snapshot;
  const p0 = snap.panes.find((p) => p.pane_id === pane);
  check('api snapshot carries the same agent_session on the pane', p0 && p0.agent_session && p0.agent_session.value === 'oak-probe-session');
  const cur = await one('pane.current', {});
  check('pane.current {} returns the focused pane (the leader-key query)', cur.result && cur.result.pane && cur.result.pane.pane_id === pane);

  sc.end();
  server.kill();
  fs.rmSync(T, { recursive: true, force: true });
  if (fails.length) { console.log(`herdr-probe: ${fails.length} FAILED — ${fails.join('; ')}`); process.exit(1); }
  console.log('herdr-probe: all checks passed');
  process.exit(0);
})().catch((e) => { console.log('herdr-probe: crashed —', e && e.stack || e); try { server.kill(); } catch {} process.exit(1); });
