// The INTERACTIVE app with no session at launch, in a repository, adopts the first session to appear. A session listing read
// before the adoption (the poll lists every session while there is none) can land after it, once the adoption has cleared the
// views for the session's own read; so can a rerun of that listing asked for before it. herdr, the backend's views reads and
// the conversation reader are faked, and each read lands when the probe says. Prints, as JSON, the sessions each listing was
// read for and what Review drew while the session's own read was outstanding.
const fs = require('fs'), os = require('os'), path = require('path');
const { gitDir: makeGitDir } = require('../../../../test/fixtures/git.cjs');
const repo = path.resolve(__dirname, '../../../..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-listing-race-'));
Object.assign(process.env, { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
  XDG_CONFIG_HOME: path.join(home, '.config'), HERDR_SOCKET_PATH: path.join(home, 'no-herdr.sock'), OAK_MACHINE_LABEL: 'workstation' });
for (const key of ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_ENV', 'HERDR_BIN_PATH', 'TMUX', 'CLAUDE_OBSERVATORY_SESSION', 'CLAUDE_CHANGES_SESSION']) delete process.env[key];
const realCore = require(repo + '/packages/core/dist');
const tui = require(repo + '/packages/tui/dist');
const backend = require(repo + '/packages/tui/dist/backend');
const frame = require(repo + '/packages/tui/dist/frame');
let state, drawn = '';
const draw = frame.renderDashFrame;
frame.renderDashFrame = (s, ...rest) => {
  state = s;
  const lines = draw(s, ...rest);
  drawn = lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  return lines;
};
// The session's own views read lands only when the probe says: `notify` is the app's listener.
let notify;
const asked = [];
backend.createBackend = () => ({ close() {}, watcherMode: () => 'native', updateSkew: () => false, onData(fn) { notify = fn; },
  request(views, session) { asked.push(session); }, diff: async () => '', run: async () => '{}' });
// Each session listing waits for the probe too.
const listings = [];
backend.createConversationReader = () => ({
  sessions: (session) => new Promise((resolve) => listings.push({ session, resolve })),
  read: async () => ({ events: [], cursor: null }), diff: async () => '', fleet: async () => ({ subagents: [], todos: [] }),
  markCommentsSent: async () => {}, close() {},
});
let answer = null;
const core = { ...realCore, readPrefs: () => ({ color: 'none', glyphs: 'ascii', layout: { active: 'review' } }), writePrefs() {},
  defaultTuiSession: () => answer, findHerdrBin: () => null, connectDaemon: async () => null, ensureDaemon: async () => ({ client: null, why: 'probe' }),
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
const ws = path.join(home, 'ws');
makeGitDir(path.join(ws, '.git'));
process.chdir(ws);
const wait = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms));
const listing = { sessions: [{ id: 'elsewhere', title: 'elsewhere', agent: 'claude', pending: 0, lastEdit: 1 }] };
const review = () => (state.views === null ? 'none' : Object.keys(state.views).join(','));
const says = () => (/no data to draw/.test(drawn) ? 'no data to draw' : /building…/.test(drawn) ? 'building…' : /no session to review/.test(drawn) ? 'no session to review' : 'other');
(async () => {
  tui.runTui(core, ['--tab', 'review', '--tick', '1', '--no-server'], () => '');
  await wait(400);
  const before = { says: says(), listings: listings.map((l) => l.session) };
  // A session appears in the workspace while that listing is still being read; the next poll adopts it.
  answer = 'fresh-session';
  for (let i = 0; i < 50 && state.session !== 'fresh-session'; i++) await wait(100);
  await wait();
  const adopted = { session: state.session, views: review(), says: says(), asked: [...asked] };
  // The listing read before the adoption lands, and then any listing asked for after it.
  listings[0].resolve(listing);
  await wait();
  const stale = { views: review(), says: says() };
  for (let i = 1; i < listings.length; i++) listings[i].resolve(listing);
  await wait();
  const rerun = { views: review(), says: says() };
  // The session's own read lands.
  notify({ sessions: listing, list: { edits: [] } }, null, Date.now(), 'fresh-session');
  await wait();
  write(JSON.stringify({ before, adopted, stale, rerun, listings: listings.map((l) => l.session), landed: { views: review(), says: says() } }) + '\n');
  fs.rmSync(home, { recursive: true, force: true });
  exit(0);
})().catch(error => { process.stderr.write(String(error?.stack || error) + '\n'); exit(1); });
