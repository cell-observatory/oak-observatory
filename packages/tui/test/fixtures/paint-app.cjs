// The real terminal app over synthetic data, for paint-pty.js: what it writes while idle, after one change, and after
// whatever disturbs the screen. No user store, server, network or agent is used, and time is real: the refresh tick is
// the app's own (`--tick`). OAK_PAINT_TAB picks the tab it opens on; SIGUSR1 changes the status row, and only it.
// Each frame the app renders is appended to frames.jsonl, and each row a selection then bands to spans.jsonl, so a test
// can draw what a full repaint of the frame would show.
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.OAK_PAINT_DIR;
const coreReal = require('../../../core/dist');
const backend = require('../../dist/backend');
const frame = require('../../dist/frame');
const textwidth = require('../../dist/textwidth');
const { fixture, syncView } = require('./observatory');
const data = fixture();
data.observatory.machines = data.observatory.machines.slice(0, 1);
const session = data.views.sessions.sessions[0];
data.views.changemap = { summary: { title: session.title }, files: [] };
let state, rendered = 0, changes = 0, banding = false;
const draw = frame.renderDashFrame;
frame.renderDashFrame = (s, ...args) => {
  state = s;
  banding = false;
  const lines = draw(s, ...args);
  if (args[0]?.bottom) fs.appendFileSync(path.join(dir, 'frames.jsonl'), JSON.stringify({ n: ++rendered, cols: args[0].cols, rows: args[0].rows, lines }) + '\n');
  banding = !!args[0]?.bottom; // what the paint does to the frame's rows next is the selection's band
  return lines;
};
const band = textwidth.reverseVisibleSpan;
textwidth.reverseVisibleSpan = (line, ...args) => {
  const out = band(line, ...args);
  if (banding) fs.appendFileSync(path.join(dir, 'spans.jsonl'), JSON.stringify({ n: rendered, line, out }) + '\n');
  return out;
};
process.on('SIGUSR1', () => { state.status = `PAINT CHANGE ${++changes}`; });
// ^Z: the kernel discards a SIGTSTP to an orphaned process group — this app under a PTY its test spawned — so the app is
// not stopped, and, its terminal handed back and its timers cleared, would end with nothing left to wait for SIGCONT.
setInterval(() => {}, 1 << 30);
const transcript = path.join(dir, 'transcript.jsonl');
fs.writeFileSync(transcript, '\n');
let notify;
backend.createConversationReader = () => ({
  read: async () => ({ events: [], cursor: 1, transcriptPath: transcript, agent: 'claude' }),
  fleet: async () => ({ subagents: [], todos: [] }),
  workerFleet: async () => ({ sessions: [session], workers: [] }),
  sessions: async () => data.views.sessions,
  processes: async () => ({ processes: [], previews: {}, selected: null }),
  feed: async () => ({ ref: null, entries: [] }),
  diff: async () => '', close() {},
});
backend.createBackend = () => ({ close() {}, watcherMode: () => 'native', updateSkew: () => false,
  onData(fn) { notify = fn; },
  request(_names, id) { queueMicrotask(() => notify(data.views, null, Date.now(), id)); },
  diff: async () => '',
  run: async args => args[0] === 'sync' ? JSON.stringify(syncView({ last: null, conflicts: [], backup: null })) : '',
});
const core = { ...coreReal,
  takeAgentSetupNotice: () => null, readPrefs: () => ({ color: 'truecolor', glyphs: 'unicode' }), writePrefs() {},
  findHerdrBin: () => path.join(dir, 'herdr'), herdrPaneContext: async () => ({ nested: false }),
  defaultTuiSession: () => session.id, sessionWorkspace: () => dir,
  connectDaemon: async () => null, ensureDaemon: async () => ({ client: null, why: 'fixture' }),
  dueRemoteUsageGather: () => false, dueAccountUsagePull: () => false, kickMonthRefresh() {}, kickRemoteTitles() {}, kickMachineUsage() {},
  usageLine: () => null, usageBrief: () => null, siblingOverviewCached: () => null, subagentDigests: () => [],
  detectEditors: () => [], herdrMachines: async () => [], readHerdrPaneLink: () => null,
  herdrSnapshot: async () => data.observatory.machines[0].snapshot,
  herdrRequest: async () => ({ type: 'ok' }),
  herdrSubscribe: () => ({ close() {} }),
  createWatcher: () => ({ close() {} }),
  ensureHerdrTabs: async () => [],
  announceAttention() {},
};
require('../../dist').runTui(core, ['--session', session.id, '--root', dir, '--tab', process.env.OAK_PAINT_TAB || 'review', '--no-server',
  '--tick', process.env.OAK_PAINT_TICK || '1'], () => session.id);
