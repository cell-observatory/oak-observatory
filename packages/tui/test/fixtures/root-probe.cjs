// `oak tui --root <dir>` in the INTERACTIVE app: every session it picks on its own is the named workspace's
// (core.defaultTuiSession(dir, true)), never the newest one anywhere: the first one it adopts with none at
// launch, the newer one it hints at once a review lands, and the one it moves to when the reader deletes the
// session under review. herdr, the backend, the conversation reader and the CLI children are faked; prints the
// defaultTuiSession calls, each with the step it was made in, and what the app did with the answers, as JSON.
const fs = require('fs'), os = require('os'), path = require('path');
const repo = path.resolve(__dirname, '../../../..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-root-probe-'));
Object.assign(process.env, { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
  XDG_CONFIG_HOME: path.join(home, '.config'), HERDR_SOCKET_PATH: path.join(home, 'no-herdr.sock'), OAK_MACHINE_LABEL: 'workstation' });
for (const key of ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_ENV', 'HERDR_BIN_PATH', 'TMUX', 'CLAUDE_OBSERVATORY_SESSION', 'CLAUDE_CHANGES_SESSION']) delete process.env[key];
const realCore = require(repo + '/packages/core/dist');
const tui = require(repo + '/packages/tui/dist');
const backend = require(repo + '/packages/tui/dist/backend');
const frame = require(repo + '/packages/tui/dist/frame');
let state;
const draw = frame.renderDashFrame;
frame.renderDashFrame = (s, ...rest) => { state = s; return draw(s, ...rest); };
// The views reads land only when the probe says: `notify` is the app's listener.
let notify;
backend.createBackend = () => ({ close() {}, watcherMode: () => 'native', updateSkew: () => false, onData(fn) { notify = fn; },
  request() {}, diff: async () => '', run: async () => '{}' });
// The conversation reader too: the real one keeps a warm reader child working in the named folder, which Windows will not
// remove while that child runs. Its session listings never land.
backend.createConversationReader = () => ({
  sessions: () => new Promise(() => {}), read: async () => ({ events: [], cursor: null }), diff: async () => '',
  fleet: async () => ({ subagents: [], todos: [] }), markCommentsSent: async () => {}, close() {},
});
// Each step's answer: the named workspace's session, then a newer one of it.
let step = 'launch', answer = 'root-first';
const calls = [], deleted = [];
const core = { ...realCore, readPrefs: () => ({ color: 'none', glyphs: 'ascii', layout: { active: 'review' } }), writePrefs() {},
  defaultTuiSession: (...args) => { calls.push([step, ...args]); return answer; }, deleteSession: (id) => deleted.push(id),
  findHerdrBin: () => null, connectDaemon: async () => null, ensureDaemon: async () => ({ client: null, why: 'probe' }),
  dueRemoteUsageGather: () => false, dueAccountUsagePull: () => false, kickMonthRefresh() {}, usageLine: () => null, usageBrief: () => null,
  herdrMachines: async () => [], herdrSubscribe: () => ({ close() {} }), createWatcher: () => ({ close() {} }), detectEditors: () => [] };
Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
process.stdin.setRawMode = () => {};
Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
Object.defineProperty(process.stdout, 'rows', { value: 30, configurable: true });
process.stdout._refreshSize = () => {};
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = () => true;
const exit = process.exit.bind(process);
process.exit = () => {};
const named = path.join(home, 'named');
fs.mkdirSync(named);
const wait = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms));
const key = async text => { process.stdin.emit('data', Buffer.from(text)); await wait(); };
const sessions = ids => ({ sessions: { sessions: ids.map(id => ({ id, title: id, agent: 'claude', pending: 0, lastEdit: 1 })) } });
(async () => {
  // `inline`: the `--root=dir` form, which the app read as no --root at all.
  tui.runTui(core, [...(process.argv[2] === 'inline' ? ['--root=' + named] : ['--root', named]), '--tab', 'review', '--no-server'], () => '');
  await wait(1500);
  const adopted = state.session;
  // Its review lands; the workspace has a newer session by then.
  step = 'newer'; answer = 'root-newer';
  notify(sessions(['root-first', 'root-newer']), null, Date.now(), 'root-first');
  await wait();
  const hint = state.status;
  // The reader deletes the session under review: the app moves to the workspace's newest one left.
  step = 'delete';
  await key('b'); await key('\x04'); await key('y');
  write(JSON.stringify({ named, calls, adopted, hint, deleted, after: state.session }) + '\n');
  fs.rmSync(home, { recursive: true, force: true });
  exit(0);
})().catch(error => { process.stderr.write(String(error?.stack || error) + '\n'); exit(1); });
