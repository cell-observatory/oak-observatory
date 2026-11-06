// Real app and native PTY, synthetic data providers. No user store, server, network or agent is used.
const fs = require('node:fs'), path = require('node:path');
const dir = process.env.OAK_FLASH_DIR;
const realNow = Date.now.bind(Date), start = realNow(), scale = Number(process.env.OAK_FLASH_SCALE || 20);
const later = global.setTimeout, every = global.setInterval;
Date.now = () => start + (realNow() - start) * scale;
for (const [name, original] of [['setTimeout', later], ['setInterval', every]]) {
  global[name] = (fn, ms, ...args) => original(fn, ms >= 750 ? Math.max(35, ms / scale) : ms, ...args);
}
let state, offset = 0;
const log = (kind, more = {}) => fs.appendFileSync(path.join(dir, 'sources.jsonl'), JSON.stringify({
  ms: realNow() - start, virtualMs: Date.now() - start, kind, tab: state?.tabs[state.activeTab]?.id, ...more,
}) + '\n');
const stdout = process.stdout.write.bind(process.stdout), sync = fs.writeSync.bind(fs);
const trace = data => {
  const bytes = Buffer.from(data);
  log('write', { offset, length: bytes.length, base64: bytes.toString('base64'), stack: new Error().stack.split('\n').slice(2, 10) });
  offset += bytes.length;
};
process.stdout.write = (data, ...args) => { trace(data); return stdout(data, ...args); };
fs.writeSync = (fd, data, ...args) => { if (fd === 1) trace(data); return sync(fd, data, ...args); };

const coreReal = require('../../../core/dist');
const backend = require('../../dist/backend');
const frame = require('../../dist/frame');
const { fixture, syncView } = require('./observatory');
const data = fixture();
data.observatory.machines = data.observatory.machines.slice(0, 1);
data.views.sessions.sessions = data.views.sessions.sessions.slice(0, 1);
const session = data.views.sessions.sessions[0];
session.title = 'TITLE\x07TEXT';
session.pending = 0;
data.views.changemap = { summary: { title: session.title }, files: [] };
const transcript = path.join(dir, 'transcript.jsonl');
fs.writeFileSync(transcript, '\n');
const draw = frame.renderDashFrame;
frame.renderDashFrame = (s, ...args) => { state = s; return draw(s, ...args); };
let revision = 0, notify, subscription, watcher;
const worker = () => ({ agentId: 'worker1', agentType: 'Explore', description: 'WORKER\x07TEXT',
  title: 'WORKER\x07TEXT', phase: revision % 4 < 2 ? 'working' : 'done', ts: Date.now(), edits: 0, pending: 0 });
const proc = () => ({ id: 'shell-1', session: session.id, command: 'printf PROCESS\\aTEXT', description: 'PROCESS\x07NAME',
  running: true, status: 'running', exitCode: null, runtimeMs: Date.now() - start, startedAt: start, outputFile: path.join(dir, 'process.output') });
const conversation = () => ({ events: [{ ts: Date.now(), update: { sessionUpdate: 'user_prompt',
  content: { type: 'text', text: `CONVERSATION\x07TEXT ${revision}` } } }], cursor: fs.statSync(transcript).size, transcriptPath: transcript, agent: 'claude' });
backend.createConversationReader = () => ({
  read: async () => { log('conversation-read'); return conversation(); },
  fleet: async () => ({ subagents: [worker()], todos: [] }),
  workerFleet: async () => ({ sessions: [session], workers: [] }),
  sessions: async () => data.views.sessions,
  processes: async (_session, _root, selected) => {
    log('process-read', { selected });
    return { processes: [proc()], previews: { 'shell-1': 'PROCESS\x07PREVIEW' },
      selected: selected ? { process: proc(), outputTail: `PROCESS\x07TEXT ${revision}`, note: null } : null };
  },
  feed: async () => ({ ref: { kind: 'agent', id: 'worker1' }, workerLogVersion: 1, mode: 'live', title: 'WORKER\x07TITLE',
    entries: [{ ts: Date.now(), kind: 'reasoning', label: 'said', reasoning: `WORKER\x07TEXT ${revision}` }] }),
  diff: async () => '', close() {},
});
backend.createBackend = () => ({ close() {}, watcherMode: () => 'native', updateSkew: () => revision >= 2,
  onData(fn) { notify = fn; },
  request(_names, id) { log('refresh'); queueMicrotask(() => notify(data.views, null, Date.now(), id)); },
  diff: async () => '',
  run: async args => {
    log('backend-run', { args });
    if (args[0] === 'sync') return JSON.stringify(syncView({ last: null, conflicts: [], backup: null }));
    return 'COMMAND\x07TEXT\nCOMMAND\x1b[2JERASE\n';
  },
});
const core = { ...coreReal,
  takeAgentSetupNotice: () => null, readPrefs: () => ({ color: 'none', glyphs: 'ascii' }), writePrefs() {},
  findHerdrBin: () => path.join(dir, 'herdr'), herdrPaneContext: async () => ({ nested: false }),
  defaultTuiSession: () => session.id, sessionWorkspace: () => dir,
  connectDaemon: async () => null, ensureDaemon: async () => ({ client: null, why: 'fixture' }),
  dueRemoteUsageGather: () => false, dueAccountUsagePull: () => false, kickMonthRefresh() {}, kickRemoteTitles() {}, kickMachineUsage() {},
  usageLine: () => null, usageBrief: () => null, siblingOverviewCached: () => null, subagentDigests: () => [],
  detectEditors: () => [], herdrMachines: async () => [], readHerdrPaneLink: () => null,
  herdrSnapshot: async () => { log('herdr-snapshot'); return data.observatory.machines[0].snapshot; },
  herdrRequest: async method => { log('herdr-request', { method }); return { type: 'ok' }; },
  herdrSubscribe: (_topics, fn) => { subscription = fn; return { close() {} }; },
  createWatcher: opts => { watcher = opts.onChange; return { close() {} }; },
  ensureHerdrTabs: async () => { log('tab-housekeeping'); return []; },
  announceAttention(row) { log('attention', { id: row.id }); },
};
const syncDir = path.join(core.rootDir(), 'sync');
fs.mkdirSync(syncDir, { recursive: true });
every(() => {
  if (fs.existsSync(path.join(dir, 'hold-updates'))) return;
  revision++;
  session.activeWorkers = worker().phase === 'working' ? [worker()] : [];
  session.lastActiveMs = Date.now();
  data.views.multitask.agents[0].subagents = [worker()];
  fs.appendFileSync(transcript, `${revision}\n`);
  fs.writeFileSync(path.join(syncDir, 'status.json'), JSON.stringify({ revision }));
  log('fixture-update', { revision, worker: worker().phase });
  subscription?.({ type: 'pane.agent_status_changed' });
  watcher?.({ type: 'change' });
}, 300);
require('../../dist').runTui(core, ['--session', session.id, '--root', dir, '--tab', 'herdr', '--no-server', '--tick', '1'], () => session.id);
