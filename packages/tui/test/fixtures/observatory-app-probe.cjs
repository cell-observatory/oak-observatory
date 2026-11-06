const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const repo = path.resolve(__dirname, '../../../..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-phase2-app-'));
process.env.HOME = home; process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude'); process.env.CODEX_HOME = path.join(home, '.codex');
// herdr too: every call this probe makes is faked, and anything that slips past a fake meets a socket that
// does not exist — never the person's live server, which a probe run from a herdr pane otherwise names.
for (const key of ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_ENV', 'HERDR_BIN_PATH', 'HERDR_SESSION']) delete process.env[key];
process.env.HERDR_SOCKET_PATH = path.join(home, 'no-herdr.sock'); process.env.XDG_CONFIG_HOME = path.join(home, '.config');
const realCore = require(repo + '/packages/core/dist');
const tui = require(repo + '/packages/tui/dist');
const frame = require(repo + '/packages/tui/dist/frame');
const native = require(repo + '/packages/tui/dist/native');
const textwidth = require(repo + '/packages/tui/dist/textwidth');
const backend = require(repo + '/packages/tui/dist/backend');
const { fixture, pane, syncView } = require(repo + '/packages/tui/test/fixtures/observatory');
const data = fixture();
// A raised hand in this machine's catalog: its toast names the keys that act on it. A permission prompt
// toasts once it has stood for the desktop's wait: this one has, unless the check is the wait itself.
if (process.env.OAK_APP_FIX_CHECK?.startsWith('hand-')) data.views.sessions.sessions[1].attention = { kind: 'permission', message: 'Bash(npm test)',
  ts: Date.now() - (process.env.OAK_APP_FIX_CHECK === 'hand-wait' ? 0 : realCore.PERMISSION_GRACE_MS + 1000) };
// Another machine's raised hand, as the listing carries it from that machine's records (`syncedHands`).
const syncedHand = { id: 's-remote', title: 'Profile the import', agent: 'claude', workspace: 'app', machine: 'build-box', kind: 'permission', message: 'Bash', ts: Date.now() - 1000,
  waitingMs: 1000, waitedTodayMs: 1000, question: null, current: false, origin: 'synced', host: 'aaaaaaaaaaaa', syncedAt: Date.now(), publishedAt: Date.now() };
if (process.env.OAK_APP_FIX_CHECK === 'synced-hand') data.views.sessions.syncedHands = [syncedHand];
// …and one whose machine this one has not saved (its records came through another machine).
if (process.env.OAK_APP_FIX_CHECK === 'synced-hand-unsaved') data.views.sessions.syncedHands = [{ ...syncedHand, machine: 'gpu-box', host: 'bbbbbbbbbbbb' }];
// The newest edit the listing counted this row's pending edits from: the delete confirmed from the row carries it.
if (process.env.OAK_APP_FIX_CHECK === 'delete') data.views.sessions.sessions[0].lastEdit = 7;
process.env.OAK_MACHINE_LABEL = 'workstation';
let lastFrame;
let state, spawns = [], bytes = [], saves = [], requests = [], notify, submit, focusRemote;
const prompts = [], forwarded = [], viewRequests = [], starts = [], deleted = [], due = [], announced = [];
// Each CLI verb the app ran through its backend, and its answer: none, unless a sync check sets sync's state, which
// `oak sync status --json` answers; the sync verbs answer as the CLI does.
const cliRuns = [];
// The conflict's copy, on disk for the inbox check, whose first way out opens it.
const conflictCopy = process.env.OAK_APP_FIX_CHECK === 'sync-inbox' ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oak-probe-sync-')), 'm.md') : null;
if (conflictCopy) fs.writeFileSync(conflictCopy, 'one\nright\n');
let syncState = process.env.OAK_APP_FIX_CHECK === 'sync-inbox' ? syncView({ conflicts: syncView().conflicts.map(c => ({ ...c, copy: conflictCopy })) })
  : process.env.OAK_APP_FIX_CHECK === 'sync-options' || process.env.OAK_APP_FIX_CHECK === 'sync-stamp' ? syncView()
  : process.env.OAK_APP_FIX_CHECK === 'sync-cursor' ? syncView({ exclude: { machines: [], projects: ['git:github.com/org/lib'] } })
  : process.env.OAK_APP_FIX_CHECK === 'sync-saved' ? syncView({ setUp: false, last: null, backup: null, conflicts: [] }) : null;
const cliAnswer = (args) => {
  if (args[0] !== 'sync') return '';
  if (args[1] === 'status') return !syncState ? '' : args.includes('--json') ? JSON.stringify(syncState) : 'oak sync: last run 14:00:30 (partial)\n  build-box   3 files, 1KB\n';
  if (args[1] === 'resolve') return JSON.stringify({ syncResolve: 1, id: args[2], family: 'plans', name: 'm.md', from: 'build-box', trash: '/home/u/trash/m.md', closed: [args[2]] });
  if (args[1] === 'include' || args[1] === 'exclude') {
    // As the CLI keeps it: the next status names the machine (by its label) or the project (by its key) excluded, or not.
    const kind = /^(?:git|home|share|path):/.test(args[2]) ? 'projects' : 'machines';
    if (syncState && (kind === 'projects' || args[2] === 'build-box')) {
      const list = new Set(syncState.exclude[kind]);
      if (args[1] === 'include') list.delete(args[2]); else list.add(args[2]);
      syncState = { ...syncState, exclude: { ...syncState.exclude, [kind]: [...list] } };
    }
    return JSON.stringify({ syncExclude: syncState?.exclude ?? { machines: args[1] === 'exclude' ? [args[2]] : [], projects: [] } });
  }
  if (args[1] === 'setup') return JSON.stringify({ syncSetup: 1, backup: syncState?.backup ?? null, key: null, record: { state: 'unclaimed', lastWrite: 'last written by laptop', claimed: true }, plan: null });
  if (args[1] === 'now') return 'oak sync: nothing to pull\n  build-box   0 files, 0B\n';
  return '';
};
// Every program the app started through the launcher other than its own views: an editor, or `oak sync setup` on the terminal.
const toolCalls = [];
const check = process.env.OAK_APP_FIX_CHECK;
if (check?.endsWith('tab-labels')) {
  for (const machine of data.observatory.machines) {
    machine.snapshot.tabs = machine.snapshot.panes.map((p, i) => {
      p.tab_id = `tab-${i}`;
      return { tab_id: p.tab_id, workspace_id: p.workspace_id, number: i + 8, label: i === 0 ? '1' : i === 1 ? 'My checks' : '   ' };
    });
  }
  data.views.changemap = { summary: { title: 'Fix the demo' }, files: [] };
  // build-box's pane under the placeholder tab `1` still runs: a done session folds, and one frame cannot open it (df1 brief).
  data.observatory.machines[1].snapshot.panes[0].agent_status = 'idle';
}
// Inside a herdr pane (`oak attach`) the app has no herdr tab.
if (check === 'tab-keys-nested') {
  process.env.HERDR_PANE_ID = 'fixture-pane';
  require(repo + '/packages/core/dist/herdr-context').herdrPaneContext = async () => ({ nested: true });
}
if (check === 'worker-rows' || check === 'worker-preview' || check === 'worker-vanish') {
  // Workers still at it under two sessions: seven under a local one (three waiting on a person, four working), one
  // under a remote one, which its own machine's listing names.
  const worker = (agentId, title, phase) => ({ agentId, title, phase, phaseConfidence: 'high', model: 'Opus 5.5', edits: 3, pending: 1,
    added: 30, removed: 2, tokens: 4200, lastActiveMs: Date.parse('2026-09-18T14:00:30Z') });
  data.views.sessions.sessions[1].activeWorkers = Array.from({ length: 7 }, (_, i) => worker(`w${i + 1}`, `Local worker ${i + 1}`, i % 2 ? 'awaiting-permission' : 'working'));
  data.observatory.machines[1].sessions.sessions[0].activeWorkers = [worker('r1', 'Remote worker', 'working')];
}
// A Codex agent ten minutes into a long command with a question waiting: herdr calls its pane blocked, its rollout has
// gone quiet, and its screen (herdr's `pane.read`) shows Codex's timer above its prompt.
const codexScreen = 'Working (10m 4s • esc to interrupt) · Running hook\n\n• Queued follow-up inputs\n  ? 1 question\n\n› Ask Codex to do anything\n';
if (check === 'once-screen') {
  data.observatory.machines[0].snapshot.panes.push(pane('p5', 'codex-quiet', 'blocked', 'codex'));
  data.views.sessions.sessions.push({ id: 'codex-quiet', title: 'Long build', pending: 0, agent: 'codex', model: 'GPT', tokens: 900,
    lastActiveMs: Date.now() - 600_000, phase: 'working', machine: 'laptop', turnOpen: true, attention: null });
}
if (check === 'done-fold') data.observatory.machines[0].snapshot.panes[2].agent_status = 'done';
if (check === 'workspace-nav') {
  // Twelve quiet sessions in the `docs` workspace make the master taller than its pane.
  for (let i = 0; i < 12; i++) {
    data.observatory.machines[0].snapshot.panes.push(pane(`q${i}`, `extra-${i}`, 'idle', 'claude', 'w2'));
    data.views.sessions.sessions.push({ id: `extra-${i}`, title: `Extra session ${i}`, pending: 0, agent: 'claude', model: 'Opus',
      tokens: 900, lastActiveMs: Date.parse('2026-09-18T13:00:00Z') - i * 60000, phase: 'idle', machine: 'laptop' });
  }
  const row = (id, title, pending, lastActive, extra = {}) => data.views.sessions.sessions.push({ id, title, pending, agent: 'claude',
    model: 'Opus', tokens: 900, lastActiveMs: Date.parse(lastActive), phase: 'idle', machine: 'laptop', ...extra });
  // The session OAK watches, run outside herdr with nothing pending: its `notes` project leads the
  // machine, and it is listed again in the archived fold.
  row('current-plain', 'Current terminal session', 0, '2026-09-18T12:00:00Z', { current: true, workspace: 'notes' });
  // A second, older unresolved session, so the earlier fold holds two.
  row('unresolved-2', 'Older recovery', 1, '2026-09-18T11:00:00Z');
  // build-box's first session is quiet, not done, so it is listed under its workspace for the walk (df1 brief: done folds).
  data.observatory.machines[1].snapshot.panes[0].agent_status = 'idle';
}
const transcript = path.join(home, 'fixture.jsonl'); fs.writeFileSync(transcript, '\n');
let refuseFocus = false;
// herdr's `pane.current` answer, held back while a check holds this (review-key's late answer).
let paneGate = null;
// The pane herdr's `pane.current` answers with: the first local pane unless a check focuses another.
let currentPane = data.observatory.machines[0].snapshot.panes[0];
const draw = frame.renderDashFrame;
frame.renderDashFrame = (s, ...rest) => { state = s; lastFrame = draw(s, ...rest); return lastFrame; };
native.nativeAvailable = () => true;
native.spawnNative = (...args) => {
  // `update` repaints as herdr drawing would; `clipboard` copies as herdr does through OSC 52.
  const client = { ended: false, label: 'herdr', pid: 123, resize() {}, grid: () => ['fake native herdr'],
    write: b => bytes.push(b.toString('hex')), close() { this.ended = true; }, onUpdate(fn) { this.update = fn; },
    onClipboard(fn) { this.clipboard = fn; }, onExit(fn) { this.exit = fn; } };
  spawns.push({ args, client }); return client;
};
/** Stand-ins for the tools a copy runs (tmux, wl-copy, xclip, pbcopy), for the checks that name them in `clipTools`. Each
 *  run records what it was given; `exit` is its code, `hold` keeps it running until the check calls its `end`, and
 *  `missing` fails to start, as a tool that is not installed does (`exits`: and reports an exit after the error too, which
 *  Node says may happen). A run that is killed says so (`killed`) and exits as a killed process does, with no code. */
const clipTools = {}, runs = [];
const tool = (name, { exit = 0, hold = false, missing = false, exits = false } = {}) => args => {
  const { EventEmitter } = require('events'), child = new EventEmitter();
  child.stdin = new EventEmitter();
  if (missing) {
    child.stdin.end = () => {};
    queueMicrotask(() => {
      child.emit('error', Object.assign(new Error(`spawn ${name} ENOENT`), { code: 'ENOENT' }));
      if (exits) child.emit('exit', -2, null);
    });
    return child;
  }
  const run = { name, args, text: '', end: (code = exit) => child.emit('exit', code) };
  runs.push(run);
  child.stdin.end = text => { run.text = String(text); if (!hold) queueMicrotask(() => run.end()); };
  child.kill = () => { run.killed = true; queueMicrotask(() => child.emit('exit', null, 'SIGTERM')); return true; };
  return child;
};
// A copy too large for OSC 52 goes to the system's tools only on a terminal of this machine, which these checks decide.
if (check?.startsWith('copy-')) for (const k of ['SSH_CONNECTION', 'SSH_TTY', 'WSL_DISTRO_NAME', 'WSLENV']) delete process.env[k];
if (check?.startsWith('copy-remote')) process.env.SSH_CONNECTION = '192.0.2.1 50000 192.0.2.2 22';
// A keep fails here as one the store refuses does (copy-remote-ready).
const keepFailed = 'keep failed: the store is locked by another oak process';
backend.createBackend = () => ({ close() {}, watcherMode: () => 'native', updateSkew: () => false,
  onData(fn) { notify = fn; }, request(names, session) { viewRequests.push(names); queueMicrotask(() => notify(data.views, null, Date.now(), session)); }, diff: async () => '',
  // The CLI verbs the app runs itself (`oak sync status --json` on every start): answered by the checks that need one.
  // `oak sync now` in the sync-options check runs until it is stopped, as an hour-long run does: its signal answers it.
  run: async (args, machine, opts) => {
    cliRuns.push(args);
    if (check === 'sync-options' && args.join(' ') === 'sync now' && !cliRuns.some(a => a.join(' ') === 'sync now' && a !== args)) {
      return new Promise((resolve) => opts?.signal?.addEventListener('abort', () => resolve('cancelled')));
    }
    return cliAnswer(args);
  },
  ...(check === 'copy-remote-ready' ? { mutate: async () => ({ ok: false, json: null, err: keepFailed }) } : {}),
  // The conversation search the palette's last row runs (`oak search`): one hit.
  ...(check === 'tab-keys-overlays' ? { run: async (args) => args[0] === 'search' ? JSON.stringify({ hits: [{ session: 'working', title: 'Run checks',
    agent: 'claude', ts: Date.now(), prompt: 'Run checks', snippet: 'the checks', where: 'prompt' }] }) : '' } : {}) });
// Every interval the app starts, by its period: the poll's comes from `--tick` or the saved preference.
const intervals = [];
// A Claude Code session's identity in the app's own environment: the herdr tab's client must not carry it.
if (check === 'identity') Object.assign(process.env, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'fixture-session', CLAUDE_CODE_USE_BEDROCK: '1' });
if (check?.startsWith('tick-')) { const every = global.setInterval; global.setInterval = (fn, ms, ...rest) => { intervals.push(ms); return every(fn, ms, ...rest); }; }
const core = { ...realCore, takeAgentSetupNotice: () => null, readPrefs: () => ({ color: 'none', glyphs: 'ascii', layout: { active: 'observatory' }, ...(check === 'tick-pref' ? { refreshSeconds: 5 } : {}) }), writePrefs: p => saves.push(p),
  findHerdrBin: () => check === 'fallback' ? null : '/fake/herdr',
  herdrInstallPath: (userHome, platform) => { assert.equal(userHome, os.homedir()); assert.equal(platform, process.platform); return '/fixture/herdr.exe'; },
  startAgentSession: (kind, cwd) => { starts.push({ kind, cwd }); throw Error('outer tabs must not start agents'); },
  deleteSession: (id, opts) => deleted.push([id, opts]), sessionWorkspace: () => home, defaultTuiSession: () => 'claude-conversation', announceAttention(row) { announced.push(row); },
  // The wait itself is core's (its own test): here the toast waits until the check says the hand is due.
  ...(check === 'hand-wait' ? { whenHandDue: (id, a, show) => due.push({ id, a, show }) } : {}),
  connectDaemon: async () => null, ensureDaemon: async () => ({ client: null, why: 'disabled in probe' }),
  dueRemoteUsageGather: () => false, dueAccountUsagePull: () => false, kickMonthRefresh() {},
  usageLine: () => check !== 'usage' ? null : { usageFrom: 'claude', weekPct: 71, fablePct: 83, fableLabel: 'Fable', fableReset: null },
  usageBrief: () => check !== 'usage' ? null : { claude: { five: { pct: 12 }, week: { pct: 71 }, month: { pct: 50 } }, gpt: null },
  siblingOverviewCached: () => null, subagentDigests: () => [],
  spawnTool: (_command, args, opts) => {
    if (clipTools[_command]) return clipTools[_command](args);
    if (_command === 'code' || args[1] === 'sync') toolCalls.push({ command: _command, args, stdio: opts?.stdio, detached: opts?.detached });
    if (_command === 'code') return { on() {}, unref() {} };
    const { EventEmitter } = require('events'), child = new EventEmitter(); child.stdout = new EventEmitter();
    child.kill = () => { child.killed = true; child.emit('close', null); };
    // The conversation reader's warm worker: with no stdin it takes no requests, and every read below runs cold.
    if (args[2] === '--serve') return child;
    if (args[1] === 'views') viewRequests.push(args[args.indexOf('--views') + 1].split(','));
    queueMicrotask(() => {
      if (child.killed) return;
      // A remote session's metadata comes from its own machine's catalog (`sessions --json --machine`).
      const machine = args.includes('--machine') ? data.observatory.machines.find(m => m.label === args[args.indexOf('--machine') + 1]) : null;
      const workerFeed = { ref: { kind: 'agent', id: args[args.indexOf('--id') + 1] }, workerLogVersion: 1, mode: 'live', title: 'Fixture worker log', entries: [{ ts: 1, kind: 'reasoning', label: 'said', reasoning: 'Worker-only activity' }] };
      const payload = args[1] === 'feed' ? workerFeed : args[1] === 'views' && args[args.indexOf('--views') + 1] === 'feed' ? { feed: workerFeed } : args[1] === 'conversation' ? core.conversationEvents('claude-conversation')
        : args[1] === 'multitask' ? { agents: [] } : args[1] === 'subagents' ? { subagents: [] }
        : args[1] === 'sessions' && machine ? machine.sessions : data.views;
      child.stdout.emit('data', Buffer.from(JSON.stringify(payload))); child.emit('close', 0);
    });
    return child;
  },
  detectEditors: () => [], herdrSnapshot: async () => data.observatory.machines[0].snapshot,
  herdrMachines: async () => check === 'sync-none' ? [] : [{ id: 'build', label: 'build-box', enabled: true }],
  // The delete's wording follows the backup: a folder keeps its copy of the session's store.
  deleteWords: () => realCore.deleteWords({ backup: check === 'delete-folder' ? { kind: 'folder', path: '/mnt/share/oak-backup' } : null }),
  herdrOnMachine: async (label, argv) => {
    forwarded.push({ label, argv });
    if (argv[0] === 'api') return { result: { snapshot: data.observatory.machines[1].snapshot } };
    if (argv[1] === 'focus') return refuseFocus ? { error: { message: 'remote focus refused' } }
      : new Promise(resolve => { focusRemote = resolve; });
    return { result: { type: 'ok' } };
  },
  herdrAgent: { prompt: params => { prompts.push(params); return new Promise(resolve => { submit = resolve; }); } },
  herdrRequest: async (method, params) => {
    requests.push({method,params});
    if (method === 'pane.read') return { type: 'pane_read', read: { pane_id: params.pane_id, text: codexScreen } };
    if (paneGate) await paneGate; return { type: 'pane_current', pane: currentPane };
  },
  herdrSubscribe: () => ({ close() {} }), createWatcher: () => ({ close() {} }), readHerdrPaneLink: () => null,
  // No tab tidying here: its verbs would join the requests this probe records (observatory.js covers it).
  ensureHerdrTabs: async () => [],
  conversationEvents: session => ({ events: check === 'detail-scroll' || check === 'once-newest' || check === 'drag-detail'
    // A drag crosses one ask of two lines, so its copy runs through a box's rows, not only its edges.
    ? Array.from({ length: 80 }, (_, i) => ({ ts: 1, update: { sessionUpdate: 'user_prompt', content: { type: 'text',
      text: check === 'drag-detail' && i === 75 ? 'History message 76\nwith its second line' : `History message ${i + 1}` } } }))
    : [{ts:1,update:{sessionUpdate:'user_prompt',content:{type:'text',text:'Fixture conversation'}}}],
    cursor: 1, transcriptPath: check?.startsWith('once') || check === 'detail-scroll' ? transcript : null, agent: 'claude' }),
};
Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
const rawModes = [];
process.stdin.setRawMode = value => rawModes.push(value);
Object.defineProperty(process.stdout, 'columns', { value: 140, configurable: true });
Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
process.stdout._refreshSize = () => {};
// Everything the app writes to the terminal: the drag-to-copy checks read the clipboard escape and the band.
const written = [];
process.stdout.write = s => { written.push(String(s)); return true; };
const wait = () => new Promise(resolve => setTimeout(resolve, 90));
const key = async text => { process.stdin.emit('data', Buffer.from(text)); await wait(); if (text === '\x1b') await wait(); };
const active = () => state.tabs[state.activeTab].id;
/** An SGR mouse report at a 1-based `{row, col}`: button 0 pressed or released, 32 a drag with it held. */
const mouse = (button, at, up = false) => key(`\x1b[<${button};${at.col};${at.row}${up ? 'm' : 'M'}`);
/** Every text the app put on the clipboard through OSC 52, in order. */
const copied = () => [...written.join('').matchAll(/\x1b\]52;c;([^\x07]*)\x07/g)].map(m => Buffer.from(m[1], 'base64').toString('utf8'));
/** The selection band on the screen, per 1-based row: its first and last column and its text. A paint writes only the
 *  rows that changed, so each row reads as the last frame that wrote it. */
const bands = () => {
  const plain = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const screen = {};
  for (const w of written.filter(w => w.startsWith('\x1b[?2026h'))) {
    const parts = w.split(/\x1b\[(\d+);1H\x1b\[K/);
    for (let i = 1; i < parts.length; i += 2) screen[parts[i]] = parts[i + 1];
  }
  const out = {};
  for (const [row, line] of Object.entries(screen)) {
    const open = line.indexOf('\x1b[7m');
    if (open < 0) continue;
    const text = plain(line.slice(open + 4, line.indexOf('\x1b[27m', open)));
    const from = textwidth.displayWidth(plain(line.slice(0, open))) + 1;
    out[Number(row)] = { from, to: from + textwidth.displayWidth(text) - 1, text: text.trimEnd() };
  }
  return out;
};
/** Where `text` is painted, 1-based as the mouse reports it, on the first row where it starts at a 0-based column `where` accepts. */
const at = (text, where = () => true) => {
  const row = lastFrame.findIndex(line => { const c = line.indexOf(text); return c >= 0 && where(c); });
  assert.ok(row >= 0, `"${text}" is painted:\n${lastFrame.join('\n')}`);
  return { row: row + 1, col: lastFrame[row].indexOf(text) + 1 };
};
const masterCols = Math.floor(140 * 0.3); // the Observatory master's width at 140 columns; the conversation starts past it
(async () => {
  tui.runTui(core, ['--session','claude-conversation','--no-server', ...(check?.startsWith('once') ? ['--once'] : []), ...(check === 'fixed-tabs' ? ['--native', 'unused-command'] : []),
    ...(check === 'tick-flag' ? ['--tick', '7'] : []), ...(check === 'sync-stamp' ? ['--tick', '1'] : [])], () => 'claude-conversation');
  await wait();
  assert.equal(active(), 'observatory'); assert.equal(spawns.length, 0, 'lazy native startup');
  if (check) {
    if (check?.endsWith('tab-labels')) {
      const master = lastFrame.map(line => line.slice(0, masterCols)).join('\n');
      assert.match(master, /Fix the demo/);
      assert.match(master, /My checks/);
      assert.match(master, /Waiting for prompt/);
      assert.match(master, /Remote review/);
      if (check.startsWith('live')) { await key('\x1b[B'); await key('d'); }
      assert.equal(state.observatory.details['obs-detail'].selection.label, 'Fix the demo');
      assert.equal(tui.statuslineDataFor(state).title, 'Fix the demo');
      if (check.startsWith('once')) assert.equal(requests.some(r => r.method === 'tab.rename'), false);
      else {
        await key('\x1b3');
        assert.equal(active(), 'review');
        assert.equal(state.sessionTitle, 'Fix the demo');
        assert.match(lastFrame.join('\n'), /Fix the demo/);
      }
    } else if (check === 'once') {
      assert.deepEqual(viewRequests, [['sessions']]);
      assert.equal(state.observatory.details['obs-detail'].selection.session, 'claude-conversation');
      assert.match(lastFrame.join('\n'), /Fixture conversation/);
      assert.doesNotMatch(lastFrame.join('\n'), /Select a session/);
    } else if (check === 'once-screen') {
      // A one-shot frame shows such a pane as the live app does: its screen is read, once, and Codex's timer on it reads
      // working with the question beside it, not herdr's blocked.
      assert.deepEqual(requests.filter(r => r.method === 'pane.read').map(r => r.params), [{ pane_id: 'p5', source: 'visible', format: 'text', strip_ansi: true }]);
      const row = lastFrame.findIndex(line => line.slice(0, masterCols).includes('Long build'));
      assert.ok(row >= 0, `the session is listed:\n${lastFrame.join('\n')}`);
      assert.match(lastFrame.slice(row + 1, row + 3).map(line => line.slice(0, masterCols)).join('\n'), / working · \? question/);
    } else if (check === 'once-newest') {
      // A one-shot frame cannot take a key press, so it must LAND on the newest event rather than
      // print the top of the transcript and offer a scroll affordance nobody can use.
      const text = lastFrame.join('\n');
      assert.match(text, /History message 80/, 'a pinned conversation opens at its newest event');
      assert.doesNotMatch(text, /History message 1\b/);
      assert.doesNotMatch(text, /\u2193 newest/, 'no scroll affordance in a frame that takes no keys');
    } else if (check === 'views') {
      assert.deepEqual(viewRequests[0], ['sessions']);
      assert.ok(viewRequests.every(names => names.length === 1 && names[0] === 'sessions'));
      await key('\x1b3');
      assert.ok(viewRequests.at(-1).includes('changemap'), 'Review still gets its map');
      await key('\x1b2'); assert.deepEqual(viewRequests.at(-1), ['sessions']);
      state.tabs[state.activeTab].root = tui.setPaneView(state.tabs[state.activeTab].root, 'obs-detail', 'processes');
      await key('\x1b3'); await key('\x1b2');
      assert.ok(viewRequests.at(-1).includes('processes'), 'a custom Observatory pane still gets the view it renders');
    } else if (check === 'fallback') {
      await key('\x1b1'); assert.equal(spawns[0].args[0], '/fixture/herdr.exe');
    } else if (check === 'identity') {
      // The herdr tab's client auto-starts herdr's server when none runs; a server born with a session's
      // identity hands it to every pane (only the server start was pinned).
      await key('\x1b1');
      const overlay = spawns[0].args[6];
      for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID']) assert.ok(k in overlay && overlay[k] === undefined, `${k} is removed from the client's environment`);
      assert.ok(!('CLAUDE_CODE_USE_BEDROCK' in overlay), 'a person\'s own setting still reaches it');
      assert.match(overlay.OAK_TAB, /^herdr@/);
    } else if (check === 'hand-observatory') {
      // h and i mean the same on both OAK tabs, so the toast names them plainly.
      assert.equal(active(), 'observatory');
      assert.match(state.toast?.text ?? '', /^Run checks needs your permission — Bash\(npm test\) · h jumps there · i lists every hand$/);
    } else if (check === 'hand-wait') {
      // A permission prompt inside its wait raises its hand in the list at once, and toasts only when core
      // says it is due, once however many reads land meanwhile, painted then.
      assert.doesNotMatch(state.toast?.text ?? '', /needs your permission/);
      await key('r');
      assert.deepEqual(due.map((d) => [d.id, d.a.kind, d.a.message]), [[data.views.sessions.sessions[1].id, 'permission', 'Bash(npm test)']]);
      due[0].show(); await wait();
      assert.match(state.toast?.text ?? '', /^Run checks needs your permission — Bash\(npm test\) · h jumps there · i lists every hand$/);
      assert.match(lastFrame.join('\n'), /Run checks needs your permission/, 'and the frame shows it');
    } else if (check === 'synced-hand') {
      // Another machine's hand toasts naming that machine, and once; `h` jumps to this machine's own only.
      assert.match(state.toast?.text ?? '', /^Profile the import on build-box needs your permission — Bash · i lists every hand$/);
      assert.deepEqual(announced.filter((r) => r.host).map((r) => [r.id, r.host, r.machine, r.attention.kind]), [['s-remote', 'aaaaaaaaaaaa', 'build-box', 'permission']]);
      await key('\x1b3');
      assert.match(lastFrame.join('\n'), /\S 1 need you/, 'Review\'s top bar counts it');
      await key('\x1b2');
      await key('r');
      assert.equal(announced.filter((r) => r.host).length, 1, 'once, however many reads land');
      await key('h');
      assert.equal(state.status, 'nobody here is waiting on you · 1 on other machine: i lists it', 'and says where that one is');
      // The inbox lists it on its machine, and Enter opens it there.
      await key('i');
      assert.match(state.overlay.title, /^needs you — 1 waiting/);
      assert.match(state.overlay.lines[0], /^> \S permission Profile the import — Bash · \S+ · on build-box$/);
      await key('\r');
      assert.equal(state.session, 's-remote');
      assert.equal(state.status, 'Profile the import needs your permission — Bash · on build-box');
      // From Review's inbox too, where the session is then reviewed on that machine, through `--machine`.
      await key('\x1b3'); await wait(); await key('i'); await wait(); await key('\r'); await wait(); await wait();
      assert.equal(state.session, 's-remote');
      assert.equal(state.reviewMachine?.label, 'build-box', JSON.stringify(state.reviewMachine));
    } else if (check === 'synced-hand-unsaved') {
      // A hand whose machine is not saved here cannot be read there through `--machine`: Enter says it is answered there,
      // and switches to nothing.
      const before = state.session;
      await key('i');
      assert.match(state.overlay.lines[0], /^> \S permission Profile the import — Bash · \S+ · on gpu-box$/);
      await key('\r');
      assert.equal(state.session, before);
      assert.equal(state.status, 'Profile the import needs your permission · on gpu-box, which is not saved here (oak machine add): it is answered there');
    } else if (check === 'tick-pref') {
      // The saved "Refresh every" was ignored at startup: the poll ran every 3 s.
      assert.ok(intervals.includes(5000), `the poll runs every 5 s: ${intervals}`);
    } else if (check === 'tick-flag') {
      assert.ok(intervals.includes(7000) && !intervals.includes(5000), `--tick 7 wins: ${intervals}`);
    } else if (check === 'launch-failed') {
      // herdr is not installed: the client's exec fails and it dies at once, leaving only node-pty's own
      // report on its screen.
      await key('\x1b1');
      Object.assign(spawns[0].client, { ended: true, grid: () => ['execvp(3) failed.: No such file or directory', ''] });
      spawns[0].client.exit(1); await wait();
      const screen = lastFrame.join('\n');
      assert.match(screen, /could not launch \/fake\/herdr — run oak doctor --fix/, 'the tab says what failed and what to do');
      assert.doesNotMatch(screen, /exited|execvp/);
      await key('\x1b2'); await key('\x1b1');
      assert.equal(spawns.length, 2, 'coming back to the tab tries again');
    } else if (check === 'launch-refused') {
      // herdr started, said why it would not run, and quit at once: its words stay on screen, not "could
      // not launch" (a generic note replaced them).
      await key('\x1b1');
      Object.assign(spawns[0].client, { ended: true, grid: () => ['herdr: the server speaks protocol 23; this client speaks 22 — upgrade herdr', ''] });
      spawns[0].client.exit(3); await wait();
      const screen = lastFrame.join('\n');
      assert.match(screen, /herdr: the server speaks protocol 23; this client speaks 22 — upgrade herdr/, "herdr's own reason is on screen");
      assert.match(screen, /herdr exited — Tab or ctrl\+n goes to OAK's tabs/);
      assert.doesNotMatch(screen, /could not launch/);
      await key('\x1b2'); await key('\x1b1');
      assert.equal(spawns.length, 2, 'coming back to the tab tries again');
    } else if (check === 'native-mouse') {
      await key('\x1b1');
      bytes.length = 0;
      await key('\x1b[<0;10;8M\x1b[<32;11;9M\x1b[<35;12;10M\x1b[<0;10;8m');
      assert.equal(Buffer.from(bytes.join(''), 'hex').toString(), '\x1b[<0;10;7M\x1b[<32;11;8M\x1b[<35;12;9M\x1b[<0;10;7m');
      bytes.length = 0;
      await key('\x1b[<0;10;'); assert.equal(bytes.length, 0, 'hold partial reports');
      await key('8M');
      assert.equal(Buffer.from(bytes.join(''), 'hex').toString(), '\x1b[<0;10;7M');
      bytes.length = 0;
      for (const row of [1, 38, 39, 40]) await key(`\x1b[<35;10;${row}M`);
      assert.equal(bytes.length, 0, 'outer chrome never reaches the child');
      const col = lastFrame[0].indexOf('observatory') + 1;
      await key('\x1b['); await key(`<0;${col};1M`);
      assert.equal(active(), 'observatory', 'a split click switches the outer tab');
    } else if (check === 'usage') {
      // The account reports its per-model weekly cap and a 5-hour window; the bottom line still reads wk · mo.
      assert.equal(state.usage.fablePct, 83, 'control: the app holds usage that carries the cap');
      assert.equal(state.usageBoth.claude.five.pct, 12, 'control: and a 5-hour share');
      assert.match(lastFrame.join('\n'), /claude wk: 71% · mo: 50%/);
      assert.doesNotMatch(lastFrame.join('\n'), /Fable|5h:/);
    } else if (check === 'detail-scroll') {
      await key('\x1b[B'); await key('\x1b[B'); await key('d'); await key('\x1b[C');
      assert.equal(state.observatory.details['obs-detail'].selection.session, 'working');
      const event = text => ({ ts: 1, update: { sessionUpdate: 'user_prompt', content: { type: 'text', text } } });
      assert.equal(state.observatory.details['obs-detail'].loading, false);
      assert.match(lastFrame.join('\n'), /History message 80/);
      await key('\x1b[A'); const up = state.treeScroll['obs-detail'];
      assert.ok(up > 0 && up < Number.MAX_SAFE_INTEGER);
      assert.match(lastFrame.join('\n'), /↓ newest · End/);
      await key('\x1b[5~'); assert.equal(state.treeScroll['obs-detail'], up - 10, 'PgUp retains its ten-row step');
      await key('\x1b[6~'); assert.equal(state.treeScroll['obs-detail'], up, 'PgDn retains its ten-row step');
      const hintRow = lastFrame.findIndex(line => line.includes('↓ newest'));
      const hintCol = lastFrame[hintRow].indexOf('↓ newest') + 1;
      await key(`\x1b[<64;${hintCol};${hintRow + 1}M`);
      assert.equal(state.treeScroll['obs-detail'], up - 3, 'wheel up retains its three-row step');
      await key(`\x1b[<65;${hintCol};${hintRow + 1}M`);
      assert.equal(state.treeScroll['obs-detail'], up, 'wheel down retains its three-row step');
      const held = state.treeScroll['obs-detail'];
      state.observatory.details['obs-detail'] = { ...state.observatory.details['obs-detail'],
        events: [...state.observatory.details['obs-detail'].events, event('New tail while reading')] };
      await key('\x1b[C'); assert.equal(state.treeScroll['obs-detail'], held);
      await key('\x1b[F');
      assert.match(lastFrame.join('\n'), /New tail while reading/);
      assert.doesNotMatch(lastFrame.join('\n'), /↓ newest/);
      await key('\x1b[A'); await key('\x1b[B');
      assert.equal(state.treeScroll['obs-detail'], Number.MAX_SAFE_INTEGER, 'scrolling back to bottom resumes follow');
      state.observatory.details['obs-detail'] = { ...state.observatory.details['obs-detail'],
        events: [...state.observatory.details['obs-detail'].events, event('Following again')] };
      await key('\x1b[C'); assert.match(lastFrame.join('\n'), /Following again/);
      await key('\x1b[5~'.repeat(4));
      const row = lastFrame.findIndex(line => line.includes('↓ newest'));
      const col = lastFrame[row].indexOf('↓ newest') + 1;
      await key(`\x1b[<0;${col};${row + 1}M`); await key(`\x1b[<0;${col};${row + 1}m`);
      assert.equal(state.treeScroll['obs-detail'], Number.MAX_SAFE_INTEGER, 'newest hint click resumes follow');
      assert.match(lastFrame.join('\n'), /Following again/);
      assert.doesNotMatch(lastFrame.join('\n'), /↓ newest/);
      data.observatory.machines[0].snapshot.panes[1].agent_status = 'blocked';
      state.status = 'ready'; await key('\x1b[C');
      assert.doesNotMatch(lastFrame.join('\n'), /Reply disabled|c reply · Enter sends/);
      const borderRow = lastFrame.findLastIndex(line => line.includes('+---'));
      const borderCol = lastFrame[borderRow].indexOf('+---') + 2;
      await key(`\x1b[<0;${borderCol};${borderRow + 1}M`); await key(`\x1b[<0;${borderCol};${borderRow + 1}m`);
      assert.equal(state.status, 'ready', 'the bottom border is not an invisible reply button');
    } else if (check.startsWith('ctrl-q-')) {
      const mode = check.slice('ctrl-q-'.length);
      if (mode === 'herdr' || mode === 'timeout' || mode === 'prefix') await key('\x1b1');
      if (mode === 'review') await key('\x1b3');
      if (mode === 'reply') {
        await key('\x1b[B'); await key('\x1b[B'); await key('d'); await key('\x1b[C'); await key('c');
        assert.equal(state.observatory.details['obs-detail'].reply.focused, true);
      }
      if (mode === 'overlay') { await key('?'); assert.ok(state.overlay); }
      if (mode === 'palette') { await key(':'); assert.ok(state.overlay); }
      if (mode === 'confirm') state.confirm = { verb: 'delete', ids: [], session: 'fixture-session', label: 'fixture' };
      if (mode === 'prefix') {
        // herdr's prefix is held for the key after it; ctrl+q is still OAK's, and the held prefix is dropped.
        await key('\x02');
        assert.match(state.status, /any other key is herdr's/);
      }
      const exits = [], exit = process.exit, now = Date.now;
      let clock = now(); Date.now = () => clock;
      process.exit = code => { exits.push(code); };
      try {
        bytes.length = 0;
        if (mode === 'herdr') {
          await key('z\x02\x1b[A');
          assert.equal(Buffer.from(bytes.join(''), 'hex').toString(), 'z\x02\x1b[A');
          bytes.length = 0;
          assert.match(lastFrame.join('\n'), /ctrl\+q ×2 quit/);
        }
        await key(mode === 'shared' ? '\x03' : '\x11');
        assert.deepEqual(exits, [], 'one quit press must only arm confirmation');
        assert.match(state.status, /press ctrl\+[cq] again to exit/);
        assert.equal(rawModes.at(-1), true, 'the terminal stays in raw mode while confirmation is pending');
        assert.equal(bytes.length, 0, 'Ctrl+Q never reaches the native child');
        if (mode === 'timeout') {
          clock += 2001; await key('\x11');
          assert.deepEqual(exits, [], 'an expired confirmation only re-arms');
          assert.equal(rawModes.at(-1), true);
          // On the herdr tab a single ctrl+q is the program's once its window has passed: the first goes on to it.
          assert.equal(Buffer.from(bytes.join(''), 'hex').toString(), '\x11', 'the expired ctrl+q reaches the program');
          bytes.length = 0;
        }
        await key('\x11');
        assert.deepEqual(exits, [0]);
        assert.equal(rawModes.at(-1), false, 'confirmed quit restores terminal mode');
        assert.equal(bytes.length, 0);
        if (spawns.length) assert.equal(spawns[0].client.ended, true, 'confirmed quit closes the native client');
      } finally { process.exit = exit; Date.now = now; }
    } else if (check === 'prefix-quit') {
      // OAK has no quit behind a leader: on the herdr tab, the prefix then q is herdr's (detach), and ctrl+q
      // twice is OAK's.
      const exits = [], exit = process.exit;
      process.exit = code => { exits.push(code); };
      try {
        await key('\x1b1'); bytes.length = 0;
        await key('\x02'); await key('q');
        assert.equal(Buffer.from(bytes.join(''), 'hex').toString(), '\x02q', 'herdr gets its prefix and q');
        assert.deepEqual(exits, [], 'OAK does not quit on it');
        bytes.length = 0;
        await key('\x11');
        assert.deepEqual(exits, [], 'the first ctrl+q only asks');
        assert.match(state.status, /press ctrl\+q again to exit/);
        assert.equal(bytes.length, 0, 'ctrl+q never reaches herdr');
        await key('\x11');
        assert.deepEqual(exits, [0]);
        assert.equal(rawModes.at(-1), false, 'confirmed quit restores terminal mode');
        assert.equal(spawns[0].client.ended, true, 'confirmed quit closes the native client');
      } finally { process.exit = exit; }
    } else if (check === 'repeat-keys') {
      // A kitty AUTO-REPEAT is the same press still held down. It may move and it may type; it may
      // never run a command — a held ctrl+q used to answer its own quit confirmation.
      await key('\x1b1');
      await key('\x1b[98;5:1u');
      assert.match(state.status, /m OAK tabs/);
      await key('\x1b[109;1:2u');
      assert.equal(active(), 'herdr', 'a repeat is not the key after the prefix');
      await key('\x1b[109;1:1u');
      assert.equal(active(), 'observatory', 'the prefix stays held for the next real press');
      // Navigation commands are commands too: a held ctrl+n must not cycle tabs, a press still does.
      await key('\x1b[110;5:2u');
      assert.equal(active(), 'observatory', 'a repeated ctrl+n does not cycle tabs');
      await key('\x1b[110;5:1u');
      assert.equal(active(), 'review', 'a pressed ctrl+n still cycles');
      await key('\x1b2'); assert.equal(active(), 'observatory');
      const selected = () => state.scopeWorker?.session ?? null;
      const before = selected();
      await key('\x1b[1;1:2B');
      assert.notEqual(selected(), before, 'a repeated arrow still moves the session selection');
      await key('\x1b[B'); await key('d'); await key('\x1b[C'); await key('c');
      assert.equal(state.observatory.details['obs-detail'].reply.focused, true);
      await key('\x1b[97;1:2u'); await key('\x1b[97;1:2u');
      assert.equal(state.observatory.details['obs-detail'].reply.text, 'aa', 'a held key still TYPES into the reply');
      // A paste loses its C1 controls as well as C0 (U+009B is a one-character escape).
      await key('\x1b[200~X\u0085Y\u009b2JZ\x1b[201~');
      assert.equal(state.observatory.details['obs-detail'].reply.text, 'aaXY2JZ', 'a paste keeps its text and drops C1 controls');
      await key('\x1b');
      const exits = [], exit = process.exit, now = Date.now;
      let clock = now(); Date.now = () => clock;
      process.exit = code => { exits.push(code); };
      try {
        await key('\x1b[113;5:1u');
        assert.deepEqual(exits, [], 'one quit press must only arm confirmation');
        assert.match(state.status, /press ctrl\+q again to exit/);
        await key('\x1b[113;5:2u'); await key('\x1b[113;5:2u');
        assert.deepEqual(exits, [], 'a held ctrl+q never answers its own confirmation');
        assert.match(state.status, /press ctrl\+q again to exit/);
        assert.equal(rawModes.at(-1), true, 'a repeat leaves the terminal in raw mode');
        await key('\x1b[113;5:1u');
        assert.deepEqual(exits, [0], 'a second real press still confirms');
        assert.equal(rawModes.at(-1), false, 'confirmed quit restores terminal mode');
      } finally { process.exit = exit; Date.now = now; }
    } else if (check === 'native-kitty') {
      await key('\x1b1'); bytes.length = 0;
      const raw = '\x1b[119;9u\x1b[119;9:2u\x1b[119;9:3u\x1b[1;5:3A';
      for (const ch of raw) process.stdin.emit('data', Buffer.from(ch));
      await wait();
      assert.equal(Buffer.from(bytes.join(''), 'hex').toString(), raw, 'modified press/repeat/release reaches the child verbatim');
      bytes.length = 0;
      const paste = '\x1b[200~\x01\x11\x1b[113;5u\x1b[<0;9;8Mλ\x1b[201~';
      await key(paste);
      assert.equal(Buffer.from(bytes.join(''), 'hex').toString(), paste, 'paste payload is opaque, including mouse-like bytes');
      await key('\x1b[98;5:3u'); await key('m');
      assert.equal(active(), 'herdr', 'a released prefix holds nothing');
      const before = state.status;
      await key('\x1b[113;5:3u'); await key('\x1b[113;5:3u');
      assert.equal(state.status, before, 'quit releases cannot arm or confirm quit');
      bytes.length = 0;
      await key('\x1b[98;5u');
      await key('\x1b[109;9u');
      assert.equal(active(), 'herdr', 'super+m is not m');
      assert.equal(Buffer.from(bytes.join(''), 'hex').toString(), '\x1b[98;5u\x1b[109;9u', 'herdr gets the prefix and super+m');
      await key('\x1b[98;5u'); await key('\x1b[109;1:3u'); await key('\x1b[109;1:2u');
      assert.equal(active(), 'herdr', 'a release or a repeat is not the key after the prefix');
      await key('\x1b[109;1u'); assert.equal(active(), 'observatory', 'the held prefix still answers the next press');
      // The prefix is recognized after an ordinary child key in the same read.
      await key('\x1b1'); bytes.length = 0;
      await key('x\x1b[98;5u\x1b[109u'); assert.equal(active(), 'observatory');
      assert.equal(Buffer.from(bytes.join(''), 'hex').toString(), 'x', 'only the ordinary key reached herdr');
      await key('\x1b1');
      await key('x\x02m'); assert.equal(active(), 'observatory');
    } else if (check === 'native-keys') {
      await key('\x1b1'); bytes.length = 0;
      await key('\x02?'); await key('?'); await key('+');
      assert.equal(Buffer.from(bytes.join(''), 'hex').toString(), '\x02??+');
      assert.equal(state.overlay, null, 'herdr owns question mark and plus');
      await key('\x01');
      assert.equal(Buffer.from(bytes.join(''), 'hex').toString(), '\x02??+\x01', 'ctrl+a is the program’s');
      await key('\x02'); await key('\x1b');
      assert.equal(Buffer.from(bytes.join(''), 'hex').toString(), '\x02??+\x01\x02\x1b', 'esc after the prefix is herdr’s');
      await key('\x02'); await key('m'); assert.equal(active(), 'observatory');
      await key('\x1b3'); assert.equal(active(), 'review');
      await key('\x1b[Z'); assert.equal(active(), 'observatory');
    } else if (check === 'tab-keys') {
      // F1, F2 and F3 raise herdr, the Observatory and Review: from each tab to each, and on the herdr tab before herdr
      // or the program sees them.
      const F = { herdr: '\x1bOP', observatory: '\x1bOQ', review: '\x1bOR' };
      for (const from of Object.keys(F)) for (const to of Object.keys(F)) {
        await key(F[from]); assert.equal(active(), from);
        bytes.length = 0;
        await key(F[to]);
        assert.equal(active(), to, `${to}'s key from ${from}`);
        assert.deepEqual(bytes, [], `${to}'s key from ${from}: herdr gets nothing`);
      }
      // Every form a terminal sends: xterm's SS3, rxvt's CSI ~, CSI with no or an empty modifier (xterm, and the kitty
      // protocol's), the kitty protocol's press with its event type, and the Linux console's ESC [ [. Each from the herdr
      // tab, where a form OAK did not read would reach herdr.
      const forms = { observatory: ['\x1b[12~', '\x1b[Q', '\x1b[1;1Q', '\x1b[1;1:1Q', '\x1b[[B'], review: ['\x1b[13~', '\x1b[13;1~', '\x1b[13;1:1~', '\x1b[[C'],
        herdr: ['\x1b[11~', '\x1b[P', '\x1b[1;1:1P', '\x1b[[A'] };
      for (const [to, seqs] of Object.entries(forms)) for (const seq of seqs) {
        await key(to === 'herdr' ? F.review : F.herdr);
        bytes.length = 0;
        await key(seq);
        assert.equal(active(), to, JSON.stringify(seq));
        assert.deepEqual(bytes, [], `${JSON.stringify(seq)}: herdr gets nothing`);
      }
      // The kitty protocol's release (and auto-repeat) of a tab key on the herdr tab reaches no one either.
      await key(F.herdr); bytes.length = 0;
      await key('\x1b[1;1:1P'); await key('\x1b[1;1:2P'); await key('\x1b[1;1:3P');
      assert.equal(active(), 'herdr'); assert.deepEqual(bytes, [], 'F1 pressed, held and let go on its own tab');
      // After herdr's prefix a tab key is OAK's too, and the prefix goes with it.
      await key('\x02'); await key(F.review);
      assert.equal(active(), 'review'); assert.deepEqual(bytes, [], 'the prefix never reached herdr');
      // With shift, ctrl, alt, super or meta an F-key is another key: it reaches the program unchanged, in its own bytes.
      await key(F.herdr); bytes.length = 0;
      const chords = ['\x1b[1;2Q', '\x1b[1;5P', '\x1b[13;3~', '\x1b[1;9Q', '\x1b[1;2:1R', '\x1b[1;33P'];
      for (const chord of chords) await key(chord);
      assert.equal(active(), 'herdr');
      assert.equal(Buffer.from(bytes.join(''), 'hex').toString('latin1'), chords.join(''));
      // On OAK's tabs a shifted one is not a tab key: Review says it is no window key, and stays.
      await key(F.review); await key('\x1b[1;2Q');
      assert.equal(active(), 'review'); assert.match(state.status, /^F2 is not a window key/);
    } else if (check === 'tab-keys-overlays') {
      // Over an overlay or a box that types, a tab key closes it first, as esc would, and raises its tab; a box's typed text
      // goes with it. A standing question holds it back.
      const F = { herdr: '\x1bOP', observatory: '\x1bOQ', review: '\x1b[13~' };
      await key(F.review);
      await key('?'); assert.ok(state.overlay); await key(F.observatory);
      assert.equal(active(), 'observatory'); assert.equal(state.overlay, null, 'the help closed');
      await key(':'); assert.ok(state.overlay); await key(F.review);
      assert.equal(active(), 'review'); assert.equal(state.overlay, null, 'the empty palette closed');
      await key(':'); await key('x'); assert.match(state.overlay?.title ?? '', /^: x▏/, 'control: the palette holds x');
      await key(F.herdr);
      assert.equal(active(), 'herdr', 'text in the palette holds no key back'); assert.equal(state.overlay, null, 'the palette closed');
      assert.equal(state.status, 'ready');
      await key(F.review); assert.doesNotMatch(lastFrame.join('\n'), /: x▏/, 'back on Review, the x is drawn nowhere');
      await key(F.herdr); assert.equal(active(), 'herdr');
      await key(F.review); await key('b'); assert.ok(state.overlay); await key(F.observatory);
      assert.equal(active(), 'observatory'); assert.equal(state.overlay, null, 'the session picker, with nothing typed, closed');
      await key('b'); await key('w'); assert.match(state.overlay?.head ?? '', /^search w▏/, 'control: its search holds w');
      await key(F.review);
      assert.equal(active(), 'review'); assert.equal(state.overlay, null, 'the session picker closed, its search typed');
      await key(F.observatory); assert.doesNotMatch(lastFrame.join('\n'), /search w▏/, 'back on the Observatory, the search is drawn nowhere');
      await key('v'); assert.match(state.overlay?.title ?? '', /what should this pane show/);
      await key(F.review); assert.equal(active(), 'review'); assert.equal(state.overlay, null, 'the view picker closed');
      await key(F.observatory); assert.equal(state.overlay, null, 'and stays closed on its tab');
      await key(F.review); await key('\\'); assert.ok(state.filterMenu); await key(F.observatory);
      assert.equal(active(), 'observatory'); assert.equal(state.filterMenu, null, 'the filter options closed');
      await key(F.review); await key('o'); assert.match(lastFrame.join('\n'), /options {2}— {2}↑↓ move/);
      await key(F.observatory); assert.equal(active(), 'observatory'); assert.doesNotMatch(lastFrame.join('\n'), /options {2}— {2}↑↓ move/, 'the options closed');
      // With nothing open a tab key leaves the status as it stood; what it closes takes the status it wrote with it.
      await key(F.review); state.status = 'fixture status'; await key(F.review);
      assert.equal(state.status, 'fixture status', 'nothing was open: the status stands');
      await key("'"); assert.match(state.status, /^set mark: press a letter/);
      await key(F.observatory); assert.equal(active(), 'observatory'); assert.equal(state.status, 'ready', 'the mark\'s prompt went with it');
      // The `/` filter keeps its text on its tab, typing ended.
      await key(F.review); await key('/'); await key('x'); await key(F.observatory); await key(F.review);
      assert.equal(state.filter, 'x'); assert.equal(state.filterOpen, false);
      // A standing question holds every tab key, and the question stays.
      state.confirm = { verb: 'keep', ids: [1], label: 'fixture' };
      await key(F.observatory);
      assert.equal(active(), 'review'); assert.ok(state.confirm, 'the question still stands');
      await key('n'); assert.equal(state.confirm, null);
      // So does one asked over an overlay, the session picker's delete, which closing the picker would take down with it.
      await key('b'); await key('\x04');
      assert.equal(state.confirm?.verb, 'delete', 'control: the delete question stands over the picker');
      await key(F.observatory);
      assert.equal(active(), 'review'); assert.equal(state.confirm?.verb, 'delete'); assert.ok(state.overlay, 'and the picker under it');
      await key('n'); assert.equal(state.confirm, null); await key('\x1b');
      // An options entry and the help's filter close with their text too, empty or not.
      await key(F.review); await key('o'); await key('\x1b[B'); await key('\r');
      assert.match(state.overlay?.title ?? '', /^Store: _ +— +enter saves · esc cancels$/, 'control: the store entry is open, empty');
      await key(F.observatory); assert.equal(active(), 'observatory'); assert.equal(state.overlay, null, 'the empty entry closed');
      await key(F.review); await key('o'); await key('\x1b[B'); await key('\r');
      await key('x'); assert.match(state.overlay?.title ?? '', /^Store: x_ /, 'control: the entry holds x');
      await key(F.observatory);
      assert.equal(active(), 'observatory'); assert.equal(state.overlay, null, 'the entry closed, its text typed');
      assert.doesNotMatch(lastFrame.join('\n'), /options {2}— {2}↑↓ move/, 'and the options with it');
      await key(F.review); await key('o'); await key('\x1b[B'); await key('\r');
      assert.match(state.overlay?.title ?? '', /^Store: _ /, 'opened again, the entry is empty: the x went with it, unsaved');
      await key('\x1b'); await key('\x1b'); assert.doesNotMatch(lastFrame.join('\n'), /options {2}— {2}↑↓ move/, 'control: esc, esc closed them');
      await key('?'); await key('/'); await key('e'); assert.match(state.overlay?.title ?? '', /\/e_ filters/, "control: the help's filter holds e");
      await key(F.observatory);
      assert.equal(active(), 'observatory'); assert.equal(state.overlay, null, 'the help closed, its filter typed');
      await key(F.review); assert.doesNotMatch(lastFrame.join('\n'), /\/e_ filters/, 'back on Review, the filter is drawn nowhere');
      await key(F.observatory); assert.equal(active(), 'observatory'); assert.equal(state.overlay, null);
      // The inbox and the conversation search's results close as the others do: the next key is the new tab's, not theirs.
      state.views.sessions.sessions[1].attention = { kind: 'permission', message: 'Bash(npm test)', ts: Date.now() - realCore.PERMISSION_GRACE_MS - 1000 };
      await key('i'); assert.ok(state.overlay, 'control: the inbox is open');
      await key(F.review); assert.equal(active(), 'review'); assert.equal(state.overlay, null, 'the inbox closed');
      await key('?'); assert.match(state.overlay?.title ?? '', /esc or \? to close/, 'the key after it is Review\'s'); await key('\x1b');
      state.views.sessions.sessions[1].attention = null;
      await key(':'); await key('zqxj'); await key('\r'); await wait();
      assert.match(state.overlay?.title ?? '', /1 matching ask/, 'control: the search results are open');
      await key(F.observatory); assert.equal(active(), 'observatory'); assert.equal(state.overlay, null, 'the results closed');
      await key('?'); assert.match(state.overlay?.title ?? '', /esc or \? to close/, 'the key after them is the Observatory\'s'); await key('\x1b');
      // The reply box keeps its draft, and its focus, across the tabs.
      currentPane = data.observatory.machines[0].snapshot.panes[1];
      await key(F.herdr); await key('\x02M'); await wait();
      assert.equal(active(), 'observatory');
      assert.equal(state.observatory.details['obs-detail'].selection.session, 'working');
      await key('c'); await key('abc'); assert.equal(state.observatory.details['obs-detail'].reply.text, 'abc');
      await key(F.review); assert.equal(active(), 'review');
      await key(F.observatory);
      assert.deepEqual([state.observatory.details['obs-detail'].reply.text, state.observatory.details['obs-detail'].reply.focused], ['abc', true]);
      assert.deepEqual(prompts, [], 'and nothing was sent');
    } else if (check === 'tab-keys-herdr-config') {
      // A tab key herdr's config binds is herdr's on its tab: on its own, as its prefix, or after its prefix.
      const config = path.join(home, '.config', 'herdr', 'config.toml');
      fs.mkdirSync(path.dirname(config), { recursive: true });
      let stamp = Date.now() / 1000;
      const herdrConfig = (text) => { fs.writeFileSync(config, text); stamp += 10; fs.utimesSync(config, stamp, stamp); };
      await key('\x1b1'); bytes.length = 0;
      herdrConfig('[keys]\nnext_tab = "f2"\n');
      await key('\x1bOQ');
      assert.equal(active(), 'herdr'); assert.equal(Buffer.from(bytes.join(''), 'hex').toString('latin1'), '\x1bOQ', 'F2 went on to herdr');
      await key('\x1bOR'); assert.equal(active(), 'review', 'F3 is still OAK\'s');
      await key('\x1b1'); bytes.length = 0;
      herdrConfig('[keys]\nprefix = "f3"\n');
      await key('\x1bOR'); assert.equal(active(), 'herdr', 'F3 is herdr\'s prefix, held for the key after it');
      await key('m'); assert.equal(active(), 'review', 'its m went back to the OAK tab left last'); assert.deepEqual(bytes, []);
      await key('\x1b1'); bytes.length = 0;
      herdrConfig('[keys]\nnew_tab = "prefix+f2"\n');
      await key('\x02'); await key('\x1bOQ');
      assert.equal(active(), 'herdr'); assert.equal(Buffer.from(bytes.join(''), 'hex').toString('latin1'), '\x02\x1bOQ', 'after the prefix F2 is herdr\'s');
      bytes.length = 0; await key('\x1bOQ'); assert.equal(active(), 'observatory', 'without the prefix it is still OAK\'s');
      fs.rmSync(config);
    } else if (check === 'tab-keys-nested') {
      // Inside a herdr pane there is no herdr tab: F1 says so, and F2 and F3 still raise OAK's tabs.
      assert.deepEqual(state.tabs.map(t => t.id), ['observatory', 'review']);
      assert.match(lastFrame[0], /F2 observatory .*F3 review/); assert.doesNotMatch(lastFrame[0], /F1/);
      await key('\x1bOR'); assert.equal(active(), 'review');
      await key('\x1bOP'); assert.equal(active(), 'review'); assert.match(state.status, /^F1: no herdr tab here/);
      await key('\x1bOQ'); assert.equal(active(), 'observatory');
    } else if (check === 'review-key') {
      // herdr's prefix, then V, opens Review on the session in herdr's focused pane, read where OAK's herdr snapshots show
      // it running: this machine's pane here, a saved machine's pane there.
      await key('\x1b1'); bytes.length = 0;
      currentPane = data.observatory.machines[0].snapshot.panes[1]; // `working`, on this machine
      await key('\x02V'); await wait();
      assert.equal(active(), 'review');
      assert.equal(state.tabs.find(t => t.id === 'review').session, 'working');
      assert.equal(state.session, 'working');
      assert.equal(state.reviewMachine, undefined, 'a pane on this machine is reviewed here');
      assert.deepEqual(bytes, [], 'herdr got neither key');
      assert.ok(requests.some(r => r.method === 'pane.current'));
      // A saved machine's pane: the Observatory's snapshot of build-box shows `remote-done` running there.
      currentPane = data.observatory.machines[1].snapshot.panes[0];
      await key('\x1b1'); await key('\x02V'); await wait();
      assert.equal(active(), 'review');
      assert.equal(state.tabs.find(t => t.id === 'review').session, 'remote-done');
      assert.equal(state.reviewMachine?.label, 'build-box', 'reviewed on the machine that runs it');
      // A pane with no session goes to OAK's tabs, says why, and leaves Review on what it had.
      currentPane = { ...data.observatory.machines[0].snapshot.panes[2], agent_session: null };
      await key('\x1b1'); await key('\x02V'); await wait();
      assert.notEqual(active(), 'herdr');
      assert.match(state.status, /no session identity/);
      assert.equal(state.tabs.find(t => t.id === 'review').session, 'remote-done');
      // The status after the prefix names V, and the tab keys.
      await key('\x1b1'); await key('\x02');
      assert.match(state.status, /^ctrl\+b — m OAK tabs · M Observatory · V Review · F1–F3 herdr\/Observatory\/Review · any other key is herdr's$/);
      await key('\x1b'); bytes.length = 0;
      // herdr's config binds V: it is herdr's, the prefix ahead of it, and the status leaves it out.
      const config = path.join(home, '.config', 'herdr', 'config.toml');
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(config, '[keys]\nnew_tab = "prefix+shift+v"\n');
      await key('\x02');
      assert.match(state.status, /^ctrl\+b — m OAK tabs · M Observatory · F1–F3 herdr\/Observatory\/Review · any other key is herdr's$/);
      await key('V');
      assert.equal(active(), 'herdr'); assert.equal(Buffer.from(bytes.join(''), 'hex').toString('latin1'), '\x02V');
      fs.rmSync(config);
      // A late answer under a standing question moves nothing: Review keeps its session, and the tab on screen its views.
      currentPane = data.observatory.machines[0].snapshot.panes[1];
      await key('\x1b1'); let release; paneGate = new Promise(resolve => { release = resolve; });
      await key('\x02V'); await key('\x1bOQ');
      const reviewing = state.tabs.find(t => t.id === 'review').session;
      state.confirm = { verb: 'kill', ids: [], session: 'claude-conversation', label: 'fixture' };
      release(); paneGate = null; await wait(); await wait();
      assert.equal(active(), 'observatory');
      assert.equal(state.tabs.find(t => t.id === 'review').session, reviewing, 'Review keeps its session');
      assert.ok(state.views, 'and the Observatory its views');
      assert.match(state.status, /^answer the pending question first/);
      state.confirm = null;
    } else if (check === 'fixed-tabs') {
      assert.deepEqual(state.tabs.map(tab => tab.id), ['herdr', 'observatory', 'review']);
      assert.doesNotMatch(lastFrame[0], /\+/);
      await key('+'); assert.equal(state.overlay, null);
      const col = lastFrame[0].indexOf('review') + 'review'.length + 5;
      await key(`\x1b[<0;${col};1M`);
      assert.equal(state.overlay, null, 'blank strip cells do not start agents');
      assert.equal(starts.length, 0);
    } else if (check === 'help') {
      await key('?');
      const help = state.overlay.lines.join('\n');
      assert.match(help, /herdr's tab bar starts agents/);
      assert.match(help, /ctrl\+q twice.*every tab/);
      assert.doesNotMatch(help, /1-9|\+ starts/);
      assert.match(help, /options \(editor, display, store, sync, keys\)/);
      assert.doesNotMatch(help, /store, machines/);
    } else if (check === 'delete') {
      // ^D in the session picker names the edits still pending review that the purge takes for good, and
      // says what undelete brings back: the session, not its edits ("Restore it later").
      await key('\x1b3'); await key('b');
      assert.ok(state.overlay?.cursor !== undefined, 'the session picker is open, on the session in effect');
      await key('\x04');
      const body = state.overlay.lines.join('\n');
      assert.match(body, /2 of those edits are still pending review: the purge drops their before-snapshots,\n\s+so OAK can no longer undo those changes/);
      assert.match(body, /oak sessions --undelete claude-conversation lists the session again, without its edits/);
      assert.doesNotMatch(body, /[Rr]estore/);
      assert.match(body, /y — delete and purge the 2 pending edits {4}n — cancel/);
      assert.match(state.confirm.label, /and purge its 2 pending edits$/);
      await key('y');
      // Core is told how many the question named, never to force past whatever is pending when it runs, so
      // an edit captured while the question was open is refused, not purged unseen —
      // and the newest edit of the listing it counted from, so one that joined a counted change is refused
      // too.
      assert.deepEqual(deleted, [['claude-conversation', { confirmedPending: 2, seenThrough: 7 }]], 'the purge takes no more than the edits the question named, and none newer');
      assert.match(state.status, /^deleted claude-c and purged its edits — oak sessions --undelete claude-conversation lists it again, without them$/);
      // Nothing pending when asked: none confirmed, so an edit that lands before the answer is refused, not purged unseen.
      state.confirm = { verb: 'delete', ids: [], session: 'demo-full-session-identifier', label: 'fixture' };
      await key('y');
      assert.deepEqual(deleted.at(-1), ['demo-full-session-identifier', { confirmedPending: 0, seenThrough: undefined }]);

    } else if (check === 'delete-folder') {
      // With a backup folder set, which keeps its copy of the session's store, the delete says what the CLI says: the
      // edits are purged here, and an undelete then the next `oak sync now` brings back what of them the folder holds.
      await key('\x1b3'); await key('b');
      await key('\x04');
      const body = state.overlay.lines.join('\n');
      assert.match(body, /its stored edits are purged here \(the backup folder keeps its copy\)\./);
      assert.match(body, /so OAK can no longer undo those changes here, unless the backup folder brings them back\./);
      assert.match(body, /oak sessions --undelete claude-conversation lists the session again, and the next oak sync now brings back what of its edits the backup folder holds\./);
      assert.doesNotMatch(body, /for good|without its edits/);
      await key('y');
      assert.match(state.status, /^deleted claude-c and purged its edits — oak sessions --undelete claude-conversation lists it again, and the next oak sync now brings back what of its edits the backup folder holds$/);
    } else if (check === 'sync-inbox') {
      // sync's status is read through the CLI as the app starts, and its last run shows under this machine.
      assert.ok(cliRuns.some(a => a.join(' ') === 'sync status --json'), 'the app read sync\'s status');
      const master = lastFrame.map(l => l.slice(1, masterCols).trim()).join(' ');
      assert.match(master, /workstation sync · last run [^(]+ \(partial\) · 1 conflict in the inbox · 1 warning in the options backup · \/mnt\/share\/oak-backup · key a11b-f2dc-f733-a548 · failed: the backup folder holds a record/);
      // The open conflict follows the hands in the inbox, said as `oak inbox` says it.
      await key('i');
      assert.match(state.overlay.title, /^needs you — \d+ waiting · 1 sync conflict · /);
      assert.match(state.overlay.lines.at(-1), /^[> ] \S conflict {3}plans m\.md from build-box — edit your file or delete the copy$/);
      const toConflict = async () => { await key('i'); for (let i = 0; i < state.overlay.lines.length; i++) await key('j'); await key('\r'); };
      for (let i = 0; i < state.overlay.lines.length; i++) await key('j');
      await key('\r');
      // Enter opens it: its two copies and the two ways out.
      assert.match(state.overlay.title, /^sync conflict — /);
      const body = state.overlay.lines.join('\n');
      assert.match(body, /^> open both copies in your editor\n  delete build-box's copy, so yours stands$/m);
      assert.ok(body.includes(`yours: /home/u/.claude/plans/m.md\n  build-box's copy: ${conflictCopy}`), body);
      // esc goes back to the inbox; Enter on the first way opens both copies in the editor, beside each other.
      await key('\x1b');
      assert.match(state.overlay.title, /^needs you/);
      process.env.VISUAL = 'code';
      await key('\r'); await key('\r');
      assert.deepEqual(toolCalls.at(-1), { command: 'code', args: ['/home/u/.claude/plans/m.md', conflictCopy], stdio: 'ignore', detached: true });
      assert.equal(state.status, 'opened in code');
      // A copy deleted by hand since the run is a conflict resolved: said, and the status read again, not opened.
      fs.rmSync(conflictCopy);
      const calls = toolCalls.length, before = cliRuns.filter(a => a.join(' ') === 'sync status --json').length;
      await toConflict(); await key('\r');
      assert.equal(toolCalls.length, calls, 'no editor for a copy that is gone');
      assert.equal(state.status, "build-box's copy of m.md is gone: the conflict is resolved");
      assert.ok(cliRuns.filter(a => a.join(' ') === 'sync status --json').length > before);
      // The second deletes the other machine's copy through `oak sync resolve`, once asked.
      await toConflict();
      await key('j'); await key('\r');
      assert.equal(state.confirm?.verb, 'keep yours');
      assert.equal(state.confirm.conflict, 'c0ffee000001');
      assert.match(lastFrame.join('\n'), /keep yours — delete build-box's copy of plans m\.md \(it goes to sync's trash\)\? {2}\[y\/n\]/);
      const reads = cliRuns.filter(a => a.join(' ') === 'sync status --json').length;
      await key('y');
      assert.deepEqual(cliRuns.filter(a => a[1] === 'resolve'), [['sync', 'resolve', 'c0ffee000001', '--json']]);
      assert.equal(state.status, "resolved: build-box's copy of m.md is in sync's trash, and yours stands");
      assert.ok(cliRuns.filter(a => a.join(' ') === 'sync status --json').length > reads, 'and sync\'s status is read again');
    } else if (check === 'sync-stamp') {
      // sync's status is read again on the tick once one of its files moved (its status, conflicts, run lock or key, or
      // prefs.json), and not while none did: five stats a tick, and a child only on a change.
      const reads = () => cliRuns.filter(a => a.join(' ') === 'sync status --json').length;
      const dir = path.join(realCore.rootDir(), 'sync');
      fs.mkdirSync(dir, { recursive: true });
      await new Promise(r => setTimeout(r, 1500));
      const quiet = reads();
      assert.ok(quiet >= 1, 'read as the app starts');
      await new Promise(r => setTimeout(r, 2500));
      assert.equal(reads(), quiet, 'nothing moved: no read on the ticks');
      for (const f of ['status.json', 'key']) {
        const before = reads();
        fs.writeFileSync(path.join(dir, f), `${f} ${Date.now()}`);
        await new Promise(r => setTimeout(r, 1600));
        assert.equal(reads(), before + 1, `${f} moved: read again, once`);
      }
      // A new day reads again too, so the run's clock time then carries its date.
      const day = Date.prototype.toDateString, before = reads();
      Date.prototype.toDateString = () => 'the next day';
      try {
        await new Promise(r => setTimeout(r, 1600));
      } finally {
        Date.prototype.toDateString = day;
      }
      assert.ok(reads() > before, 'a new day: read again');
    } else if (check === 'sync-options' || check === 'sync-none' || check === 'sync-saved' || check === 'sync-cursor') {
      // The options window's SYNC section: shown while sync is in use or a machine is saved, never to a machine with
      // neither; each row runs the CLI, which keeps sync's settings.
      const lines = () => state.overlay?.lines ?? [];
      const selected = () => lines().find(l => /^ {2}\S /.test(l)) ?? '';
      // From wherever the window's cursor is (opening the window when it is closed): a page at a time until the row is
      // on screen (the SYNC rows are the last but the keys'), then a row at a time toward it.
      const seek = async (label) => {
        if (!/^options/.test(state.overlay?.title ?? '')) {
          if (state.overlay) await key('\x1b');
          await key('o');
        }
        const shown = () => lines().findIndex(l => l.includes(label));
        for (let i = 0; i < 30 && shown() < 0; i++) await key('\x1b[6~');
        for (let i = 0; i < 40 && !selected().includes(label); i++) await key(shown() < lines().indexOf(selected()) ? '\x1b[A' : '\x1b[B');
        assert.ok(selected().includes(label), `${label} is reachable:\n${lines().join('\n')}`);
      };
      await key('o');
      const seen = [];
      for (let i = 0; i < 12; i++) { seen.push(...lines()); await key('\x1b[6~'); }
      seen.push(...lines());
      // Back to the top, so each seek starts from one place.
      for (let i = 0; i < 12; i++) await key('\x1b[5~');
      if (check === 'sync-cursor') {
        // A row's action reads the status again, which can take rows away: one above the cursor (a run that no longer
        // refuses the folder's record), or the cursor's own (a project included again, listed only while excluded). The
        // cursor stays on the row it acted on, or moves to the row above the one that went: never onto another.
        await seek('Sync with build-box');
        syncState = { ...syncState, last: { ...syncState.last, machines: syncState.last.machines.map(m => ({ ...m, record: undefined, status: 'ok', text: '0 files, 0B' })) } };
        await key('\r'); await wait();
        assert.deepEqual(cliRuns.findLast(a => a[1] === 'exclude'), ['sync', 'exclude', 'build-box', '--json']);
        assert.ok(!lines().some(l => /This machine is a reinstall/.test(l)), 'the row above it went');
        assert.match(selected(), /Sync with build-box +off/, 'the cursor stays on the row it acted on');
        await seek('Sync the project');
        await key('\x1b[A');
        const above = selected();
        await key('\x1b[B');
        assert.match(selected(), /Sync the project/);
        await key('\r'); await wait();
        assert.deepEqual(cliRuns.findLast(a => a[1] === 'include'), ['sync', 'include', 'git:github.com/org/lib', '--json']);
        assert.ok(!lines().some(l => /Sync the project/.test(l)), 'its row went with its exclusion');
        assert.equal(selected(), above, 'the cursor is on the row above it');
      } else if (check === 'sync-none') {
        assert.ok(!seen.some(l => /SYNC|Sync now|Backup/.test(l)), 'no SYNC section');
        assert.doesNotMatch(lastFrame.join('\n'), /sync ·|backup ·/);
      } else if (check === 'sync-saved') {
        // A saved machine and nothing set up: the section offers setup, and the Observatory shows nothing of sync.
        assert.ok(seen.some(l => /Backup +none/.test(l)) && seen.some(l => /Sync with build-box +on/.test(l)), seen.join('\n'));
        await key('\x1b');
        assert.doesNotMatch(lastFrame.join('\n'), /sync ·|backup ·/);
      } else {
        assert.ok(seen.some(l => /^ {2}SYNC$/.test(l.trimEnd())), 'the section is there');
        // Exclude a saved machine.
        await seek('Sync with build-box');
        await key('\r');
        assert.deepEqual(cliRuns.findLast(a => a[1] === 'exclude'), ['sync', 'exclude', 'build-box', '--json']);
        assert.equal(state.status, 'not syncing build-box any more');
        // This machine is a reinstall: take the folder's record over.
        // This machine is a reinstall: asked first, as the editors ask; no, and nothing is run.
        await seek('This machine is a reinstall');
        await key('\r');
        assert.equal(state.confirm?.verb, 'take over');
        assert.ok(!cliRuns.some(a => a[1] === 'setup'), 'nothing before the answer');
        await key('n');
        assert.ok(!cliRuns.some(a => a[1] === 'setup'), 'and nothing on a no');
        await key('\r'); await key('y');
        assert.deepEqual(cliRuns.findLast(a => a[1] === 'setup'), ['sync', 'setup', '--folder', '/mnt/share/oak-backup', '--restore', '--json']);
        assert.equal(state.status, 'this machine took the folder\'s record over: Sync now restores its sessions from it');
        // Backup: `oak sync setup` gets the terminal, asks its own questions, and its last words stay until Enter.
        await seek('Backup');
        const from = written.length;
        await key('\r');
        assert.deepEqual(toolCalls.at(-1), { command: process.execPath, args: [process.argv[1], 'sync', 'setup'], stdio: 'inherit', detached: undefined });
        assert.ok(written.slice(from).join('').includes('\x1b[?1049l'), 'the alternate screen was handed over');
        await wait();
        assert.ok(written.slice(from).join('').endsWith('Press Enter to go back to OAK. '), 'held until Enter');
        await key('x');
        assert.ok(written.slice(from).join('').endsWith('Press Enter to go back to OAK. '), 'any other key keeps it');
        await key('\r');
        assert.equal(state.status, 'back from oak sync setup');
        // Sync now: the run's answer in an overlay of its own.
        // Sync now: a run that goes on is stopped by Enter on the row again, and said; the next one answers.
        await seek('Sync now');
        await key('\r'); await wait();
        assert.deepEqual(cliRuns.findLast(a => a[0] === 'sync' && a[1] !== 'status'), ['sync', 'now']);
        assert.match(state.status, /^running oak sync now… \(o, then Enter on Sync now, stops it\)$/);
        await seek('Sync now');
        await key('\r'); await wait();
        assert.equal(state.status, 'oak sync now: stopped');
        await seek('Sync now');
        await key('\r'); await wait();
        assert.equal(cliRuns.filter(a => a.join(' ') === 'sync now').length, 2);
        assert.match(state.overlay.lines.join('\n'), /oak sync: nothing to pull\n +build-box +0 files, 0B/);
        // The last run, whole, in an overlay that scrolls.
        await seek('The last run');
        await key('\r'); await wait();
        assert.deepEqual(cliRuns.findLast(a => a[0] === 'sync' && a[1] === 'status'), ['sync', 'status']);
        assert.match(state.overlay.title, /^oak sync status/);
        assert.match(state.overlay.lines.join('\n'), /oak sync: last run 14:00:30 \(partial\)\n +build-box +3 files, 1KB/);
      }
    } else if (check === 'drag-master') {
      // Press, drag and release selects text in the Observatory as it does in the herdr tab:
      // cell to cell, held to the pane it began in, on the clipboard (OSC 52) at the release.
      // The press's own click never runs, and the status line stays put so no pane loses a row mid-drag.
      delete process.env.TMUX; // inside tmux the copy goes through `tmux load-buffer`; this reads the escape
      const master = c => c < masterCols;
      const pinned = () => state.observatory.details['obs-detail']?.selection;
      const folds = [...state.open].sort();
      const status = state.status;
      const title = at('Fix the demo', master);
      const end = { row: title.row, col: title.col + 'Fix the demo'.length - 1 };
      await mouse(0, title); await mouse(32, end);
      assert.deepEqual(bands(), { [title.row]: { from: title.col, to: end.col, text: 'Fix the demo' } }, 'the band covers exactly the cells dragged over');
      assert.equal(state.status, status, 'the drag says nothing on the status line');
      await mouse(0, end, true);
      assert.deepEqual(copied(), ['Fix the demo'], 'released, the dragged text is on the clipboard');
      assert.equal(state.toast?.text, 'copied 12 chars to clipboard');
      assert.equal(pinned(), undefined, 'a drag that starts on a session title never pins it');
      assert.deepEqual(bands(), {}, "released, the band clears, as herdr's does");
      // Down several rows: each row is cut to the master's text columns, so the conversation beside it
      // never rides along, and each line starts at its own first character (the gutter is not text).
      const machine = at('workstation', master);
      await mouse(0, machine); await mouse(32, end);
      const band = bands();
      assert.deepEqual(Object.keys(band).map(Number), Array.from({ length: end.row - machine.row + 1 }, (_, i) => machine.row + i));
      for (const b of Object.values(band)) assert.ok(b.from >= 2 && b.to <= masterCols, `banded inside the master only: ${JSON.stringify(band)}`);
      await mouse(0, end, true);
      assert.equal(copied().at(-1), 'workstation\n  demo [W window]\n    v claude · p1\n        Fix the demo');
      // Past the last row of text: the blank rows below it are padding, not content.
      const earlier = at('earlier · 1', master);
      await mouse(0, earlier); await mouse(32, { row: 39, col: 5 }); await mouse(0, { row: 39, col: 5 }, true);
      assert.equal(copied().at(-1), 'earlier · 1');
      assert.deepEqual([...state.open].sort(), folds, 'no drag toggled a fold');
      assert.equal(pinned(), undefined);
    } else if (check === 'drag-detail') {
      // The same selection in the pinned conversation: its own rows only, even when the pointer leaves the
      // pane. Its rows stay put mid-drag: a status line that starts speaking takes a row from the panes,
      // which slid this conversation, following its tail, one line under the anchor.
      delete process.env.TMUX;
      const detail = c => c > masterCols;
      const run = at('Run checks', c => c < masterCols);
      await mouse(0, run); await mouse(0, run, true);
      assert.equal(state.observatory.details['obs-detail']?.selection.session, 'working');
      // One finished worker, so the detail has a fold to start a drag on: finished workers fold behind one row.
      state.observatory.details['obs-detail'].fleet = { subagents: [{ agentId: 'scout', agentType: 'Explore', description: 'Inspect the grid', phase: 'done', ts: 1, edits: 1 }], todos: [] };
      state.status = 'ready'; await key('\x1b[C'); // an idle status line: the panes have every row
      const foot = lastFrame.findLastIndex(line => line.includes('+---'));
      // Each ask is a box: the drag bands and copies its words, never its borders or
      // the edges between the asks, as a Review pane's drag leaves its pane's box out.
      const words = ['History message 75', 'History message 76', 'with its second line', 'History message 77'];
      const m75 = at('History message 75', detail), m77 = at('History message 77', detail);
      assert.equal(lastFrame[m75.row - 1][m75.col - 2], '|', 'control: the ask sits inside its box, one cell from its border');
      const end = { row: m77.row, col: m77.col + 'History message 77'.length - 1 };
      await mouse(0, m75); await mouse(32, end);
      assert.equal(lastFrame.findLastIndex(line => line.includes('+---')), foot, 'mid-drag the panes keep every row');
      for (const b of Object.values(bands())) assert.ok(b.from >= masterCols + 4 && b.to <= 139, `banded inside the conversation only: ${JSON.stringify(bands())}`);
      assert.deepEqual(Object.values(bands()).map(b => b.text), words, 'only the words are banded: no edge row, no border cell');
      await mouse(0, end, true);
      assert.equal(copied().length, 1, 'released, the dragged rows are on the clipboard');
      assert.deepEqual(copied()[0].split('\n'), words);
      // Out of the pane, back up into the master: the selection holds at the conversation's edge, which
      // is a box's border here — the copy still starts at the words. (The toast now speaks, so the rows
      // moved: find them again.)
      const n75 = at('History message 75', detail), n77 = at('History message 77', detail);
      await mouse(0, { row: n77.row, col: n77.col + 2 }); await mouse(32, { row: n75.row, col: 5 }); await mouse(0, { row: n75.row, col: 5 }, true);
      assert.deepEqual(copied().at(-1).split('\n'), [...words.slice(0, 3), 'His']);
      const folds = [...state.open].sort();
      const finished = at('> 1 finished', detail);
      await mouse(0, finished); await mouse(32, { row: finished.row, col: finished.col + 11 }); await mouse(0, { row: finished.row, col: finished.col + 11 }, true);
      assert.equal(copied().at(-1), '> 1 finished');
      assert.deepEqual([...state.open].sort(), folds, 'a drag that starts on a fold never toggles it');
      await mouse(0, finished); await mouse(0, finished, true);
      assert.ok(state.open.has('detail:obs-detail:working:Workers'), 'control: a click on that row opens the fold');
      // A session on another machine (read over herdr's machine bridge) copies the same way: the text is
      // this frame's, and the escape goes to this terminal, whichever machine runs the session. It is done, so it is
      // listed once its machine's done fold is opened (df1 brief).
      const fold = at('1 done · 3 pending', c => c < masterCols);
      await mouse(0, fold); await mouse(0, fold, true);
      assert.ok(state.open.has('done:build'), 'control: the click opens the done fold');
      const remote = at('Remote review', c => c < masterCols);
      await mouse(0, remote); await mouse(0, remote, true);
      assert.deepEqual([state.observatory.details['obs-detail']?.selection.session, state.observatory.details['obs-detail']?.selection.machineId], ['remote-done', 'build']);
      // Dragged on past the words, onto the box's right border: the border stays behind.
      const r80 = at('History message 80', detail), border = lastFrame[r80.row - 1].indexOf('|', r80.col) + 1;
      await mouse(0, r80); await mouse(32, { row: r80.row, col: border }); await mouse(0, { row: r80.row, col: border }, true);
      assert.equal(copied().at(-1), 'History message 80');
    } else if (check === 'drag-button') {
      // A drag that starts on a button selects text and never fires the button; a press that never moves
      // still fires it, once.
      delete process.env.TMUX;
      const run = at('Run checks', c => c < masterCols);
      await mouse(0, run); await mouse(0, run, true);
      const jump = at('↗ herdr', c => c > masterCols), review = at('⌕ review', c => c > masterCols);
      const end = { row: review.row, col: review.col + '⌕ review'.length - 1 };
      const sent = requests.length;
      await mouse(0, jump); await mouse(32, end); await mouse(0, end, true); await wait();
      assert.equal(copied().at(-1), '↗ herdr   ⌕ review');
      assert.equal(active(), 'observatory', 'a drag that starts on ↗ herdr never jumps to herdr');
      assert.equal(requests.length, sent, 'and asks herdr for nothing');
      await mouse(0, review); await mouse(0, review, true);
      assert.equal(active(), 'review', 'clicked without moving, ⌕ review scopes Review to the session');
    } else if (check === 'click-release') {
      // A press that never moves is the click, acted on at the release: the press alone does nothing (it
      // may still become a drag), and the release acts once.
      const pinned = () => state.observatory.details['obs-detail']?.selection;
      const run = at('Run checks', c => c < masterCols);
      await mouse(0, run);
      assert.equal(pinned(), undefined, 'the press alone has not pinned: it may still become a drag');
      await mouse(0, run, true);
      assert.equal(pinned()?.session, 'working', 'released without moving, one click pins');
      const earlier = at('earlier · 1', c => c < masterCols);
      await mouse(0, earlier);
      assert.equal(state.open.has('earlier'), false);
      await mouse(0, earlier, true);
      assert.equal(state.open.has('earlier'), true, 'a fold opens on the release');
      const reply = at('c reply · Enter sends', c => c > masterCols);
      await mouse(0, reply);
      assert.equal(state.observatory.details['obs-detail'].reply?.focused ?? false, false);
      await mouse(0, reply, true);
      assert.equal(state.observatory.details['obs-detail'].reply.focused, true, 'the reply row focuses on the release');
      assert.deepEqual(copied(), [], 'no click copied anything');
    } else if (check === 'lost-release') {
      // A release the terminal never reported: the next report with no button held (any-motion tracking
      // sends button 3) ends the drag as the release would have.
      delete process.env.TMUX;
      const pinned = () => state.observatory.details['obs-detail']?.selection;
      const run = at('Run checks', c => c < masterCols);
      await mouse(0, run); await mouse(35, { row: run.row + 3, col: run.col + 2 });
      assert.equal(pinned()?.session, 'working', 'a press whose release was lost is still the click');
      await mouse(35, { row: run.row + 5, col: run.col });
      assert.deepEqual(bands(), {}, 'hovering after it selects nothing');
      // A drag whose release is lost copies what it covered, up to where the button was last held.
      const title = at('Fix the demo', c => c < masterCols);
      const end = { row: title.row, col: title.col + 'Fix the demo'.length - 1 };
      await mouse(0, title); await mouse(32, end); await mouse(35, { row: end.row + 4, col: 3 });
      assert.equal(copied().at(-1), 'Fix the demo');
      await mouse(35, { row: end.row + 6, col: 8 });
      assert.deepEqual(bands(), {}, 'and no phantom selection follows the pointer');
    } else if (check === 'stale-press') {
      // A press whose release never arrived, with no button-less motion after it (a terminal that does not
      // report any-motion): the next press is its own. The stale one never clicks late and never copies
      // (a Review-tab click ended on the Observatory with a session pinned).
      delete process.env.TMUX;
      const pinned = () => state.observatory.details['obs-detail']?.selection;
      await mouse(0, at('Run checks', c => c < masterCols));
      const tab = { row: 1, col: lastFrame[0].indexOf('review') + 1 };
      await mouse(0, tab); await mouse(0, tab, true);
      assert.equal(active(), 'review', 'the click on the tab bar switched tabs');
      assert.equal(pinned(), undefined, 'the stale press never pinned its session');
      // Back on the Observatory, a stale press, then a seam drag: the divider moves and nothing is copied.
      await key('\x1b2');
      await mouse(0, at('Run checks', c => c < masterCols));
      const seam = { row: 10, col: masterCols + 1 }, moved = { row: 10, col: masterCols + 21 };
      await mouse(0, seam); await mouse(32, moved); await mouse(0, moved, true);
      assert.ok(state.tabs[state.activeTab].root.ratio > 0.4, `the divider followed the pointer: ratio ${state.tabs[state.activeTab].root.ratio}`);
      assert.deepEqual(copied(), [], 'no text was copied');
      assert.equal(pinned(), undefined, 'and still nothing was pinned');
    } else if (check === 'drag-review') {
      // Review's drag-to-copy: a status while dragging, the selection kept highlighted after the release
      // — and held to the pane it began in. A drag across side-by-side panes copied a row of
      // every pane beside it, interleaved.
      delete process.env.TMUX;
      await key('\x1b3');
      assert.equal(active(), 'review');
      const from = at('Traces has no data'), to = { row: from.row + 1, col: from.col + 5 };
      const beside = at('‹ prev');
      assert.ok(beside.row >= from.row && beside.row <= to.row && beside.col > from.col, 'control: the pane beside it has text on the rows this drag crosses');
      await mouse(0, from); await mouse(32, { row: to.row, col: beside.col + 3 });
      assert.equal(state.status, 'selecting — release to copy');
      await mouse(0, { row: to.row, col: beside.col + 3 }, true);
      const clip = state.selSpan?.clip;
      assert.ok(clip, 'the kept selection carries its pane');
      const plain = lastFrame.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''));
      assert.equal(copied().at(-1), tui.sliceSpan(plain, { row: from.row - 1, col: from.col - 1 }, { row: to.row - 1, col: clip.x1 }, clip));
      assert.match(copied().at(-1), /Traces has no data/);
      assert.doesNotMatch(copied().at(-1), /‹ prev/, 'nothing of the pane beside it');
      assert.ok(Object.keys(bands()).length > 0, 'the selection stays banded after the release');
      for (const b of Object.values(bands())) assert.ok(b.from >= clip.x0 + 1 && b.to <= clip.x1 + 1, `banded inside its pane only: ${JSON.stringify(bands())}`);
    } else if (check === 'drag-seam-pane') {
      // The Observatory's seam and pane drags keep their presses: a text selection never takes them.
      const root = () => state.tabs[state.activeTab].root;
      const seam = { row: 10, col: masterCols + 1 }, moved = { row: 10, col: masterCols + 21 };
      await mouse(0, seam); await mouse(32, moved); await mouse(0, moved, true);
      assert.ok(root().ratio > 0.4, `the divider followed the pointer: ratio ${root().ratio}`);
      const title = at('Sessions'), over = { row: 20, col: 110 };
      await mouse(0, title); await mouse(32, over); await mouse(0, over, true);
      assert.equal(root().first.id, 'obs-detail', 'the master, dragged by its title onto the conversation, swapped with it');
      assert.deepEqual(copied(), [], 'neither drag copied anything');

    } else if (check === 'click-pin') {
      // ONE click opens a session's conversation. Every target is found in the painted
      // frame, inside the master's columns, so the click lands where the reader would aim.
      const masterCols = Math.floor(140 * 0.3);
      const at = (text) => {
        const row = lastFrame.findIndex(line => { const c = line.indexOf(text); return c >= 0 && c < masterCols; });
        assert.ok(row >= 0, `"${text}" is painted in the master:\n${lastFrame.join('\n')}`);
        return { row: row + 1, col: lastFrame[row].indexOf(text) + 1 };
      };
      const click = async (text) => { const p = at(text); await key(`\x1b[<0;${p.col};${p.row}M`); await key(`\x1b[<0;${p.col};${p.row}m`); };
      const pinned = () => state.observatory.details['obs-detail']?.selection;
      assert.equal(pinned(), undefined, 'nothing is pinned before the click');
      await click('Run checks');
      assert.equal(pinned()?.session, 'working', 'one click on the title pins that session');
      assert.equal(pinned()?.machineId, 'local');
      assert.match(lastFrame.join('\n'), /Fixture conversation/, 'and its conversation is on screen');
      // remote-done is done: it is listed once build-box's done fold is opened (df1 brief).
      await click('1 done · 3 pending');
      assert.ok(state.open.has('done:build'), 'the done fold opens');
      await click('done · GPT');
      assert.deepEqual([pinned()?.session, pinned()?.machineId], ['remote-done', 'build'], 'the stat line under a title pins its session, on its machine');
      await click('codex · p2');
      assert.equal(pinned()?.session, 'unknown', 'the pane line above a session pins the session it runs');
      // A half-typed reply is parked with its session by the click that leaves it, and comes back with it.
      await key('c'); await key('draft for unknown');
      assert.equal(state.observatory.details['obs-detail'].reply.text, 'draft for unknown');
      await click('Run checks');
      assert.equal(pinned()?.session, 'working');
      assert.equal(state.observatory.details['obs-detail'].reply, undefined, 'the draft is not offered to another session');
      await click('codex · p2');
      assert.equal(state.observatory.details['obs-detail'].reply?.text, 'draft for unknown', 'the draft returns with its session');
      await click('earlier · 1');
      assert.ok(state.open.has('earlier'), 'the earlier fold opens');
      assert.equal(pinned()?.session, 'unknown', 'a fold is not a pin');
      await click('Recover edits');
      assert.deepEqual([pinned()?.session, pinned()?.machineId], ['unresolved', 'unresolved'], 'a folded paneless session pins in one click');
      assert.ok(at('Recover edits').row > at('earlier').row, 'and stays in the open fold it was clicked in');
      await click('build-box');
      assert.equal(pinned()?.session, 'unresolved', 'a machine header is not a session');
      // The keyboard keeps its model: arrows preview without pinning, Enter pins.
      await key('\x1b[A');
      assert.equal(pinned()?.session, 'unresolved', 'an arrow previews; the pin holds');
      const previewed = state.scopeWorker.session;
      assert.notEqual(previewed, 'unresolved');
      await key('\r');
      assert.equal(pinned()?.session, previewed, 'Enter pins the previewed session');
    } else if (check === 'click-split') {
      // Two conversation leaves: a click fills the leaf the reader focused, and the next click the same
      // one, so the other leaf keeps its pin.
      const masterCols = Math.floor(140 * 0.3);
      const at = (text) => {
        const row = lastFrame.findIndex(line => { const c = line.indexOf(text); return c >= 0 && c < masterCols; });
        assert.ok(row >= 0, `"${text}" is painted in the master:\n${lastFrame.join('\n')}`);
        return { row: row + 1, col: lastFrame[row].indexOf(text) + 1 };
      };
      const press = async (col, row) => { await key(`\x1b[<0;${col};${row}M`); await key(`\x1b[<0;${col};${row}m`); };
      const click = async (text) => { const p = at(text); await press(p.col, p.row); };
      const pinnedIn = leaf => state.observatory.details[leaf]?.selection.session;
      state.tabs[state.activeTab].root = { kind: 'split', dir: 'h', ratio: 0.3, first: { kind: 'pane', id: 'obs-sessions', view: 'sessions-nav' },
        second: { kind: 'split', dir: 'v', ratio: 0.5, first: { kind: 'pane', id: 'obs-detail', view: 'session-detail' },
          second: { kind: 'pane', id: 'split-9', view: 'session-detail' } } };
      await click('Run checks');
      assert.equal(pinnedIn('obs-detail'), 'working', 'with no leaf chosen, the first');
      const boxes = lastFrame.flatMap((line, i) => (/^[+┌][-─] Session/.test(line.slice(masterCols + 1)) ? [i] : []));
      assert.equal(boxes.length, 2, `two conversation leaves are painted\n${lastFrame.join('\n')}`);
      await press(masterCols + 30, boxes[1] + 6);
      assert.equal(state.tabs[state.activeTab].treeFocus, 'split-9', 'a click in the lower leaf focuses it');
      await click('Fix the demo');
      assert.equal(pinnedIn('split-9'), 'claude-conversation', 'a click fills the leaf the reader focused');
      assert.equal(pinnedIn('obs-detail'), 'working', 'the other leaf keeps its pin');
      await click('Waiting for prompt');
      assert.equal(pinnedIn('split-9'), 'idle', 'and the next click fills the same leaf');
      assert.equal(pinnedIn('obs-detail'), 'working');
    } else if (check === 'herdr-hold') {
      // Who holds a press on the herdr tab: herdr's screen as far as OAK shows it, or OAK's rows and tabs (2026-10-13).
      delete process.env.TMUX;
      await key('\x1b1'); assert.equal(active(), 'herdr');
      const client = spawns[0].client;
      const sent = () => Buffer.from(bytes.join(''), 'hex').toString('latin1');
      const reports = () => sent().match(/\x1b\[<[\d;]+[Mm]/g) ?? [];
      const painted = async () => { client.update(); await wait(); };
      const divider = () => lastFrame.findIndex((line, i) => i > 0 && /^-{100,}$/.test(line.replace(/\x1b\[[0-9;:]*m/g, '').trimEnd()));
      state.status = 'ready'; await painted();
      assert.equal(divider(), 37, 'control: with the status row silent herdr shows all 36 of its rows');
      // The status row speaks: herdr's last row lies under OAK's divider. A drag in herdr's screen let go over OAK's rows
      // ends on the last row herdr shows, and a click on the divider is OAK's: herdr selected the row nobody saw.
      state.status = 'herdr review tokens: pane p1 not found'; await painted();
      assert.equal(divider(), 36);
      bytes.length = 0;
      await mouse(0, { row: 5, col: 7 }); await mouse(32, { row: 40, col: 9 }); await mouse(0, { row: 40, col: 9 }, true);
      assert.deepEqual(reports(), ['\x1b[<0;7;4M', '\x1b[<32;9;35M', '\x1b[<0;9;35m'], 'held to the 35 rows herdr shows');
      bytes.length = 0;
      const focus = state.panes.focus;
      await mouse(0, { row: 37, col: 9 }); await mouse(0, { row: 37, col: 9 }, true);
      assert.deepEqual(reports(), [], 'a click on the divider never reaches the row under it');
      assert.deepEqual([state.panes.focus, state.status], [focus, 'herdr review tokens: pane p1 not found'], 'nor a window the tab does not draw');
      // A selection of OAK's on the bottom rows whose release was lost: the pointer back over herdr's screen with no
      // button ends it as its release would, and the motion after it is herdr's again.
      const copies = copied().length;
      bytes.length = 0;
      await mouse(0, { row: 40, col: 3 }); await mouse(32, { row: 40, col: 8 }); await mouse(35, { row: 6, col: 8 });
      assert.equal(copied().length, copies + 1, 'the motion with no button copied the selection');
      await mouse(35, { row: 7, col: 9 });
      assert.deepEqual(reports(), ['\x1b[<35;9;6M'], 'and the next motion reaches herdr');
      // herdr holds the button and the reader leaves the tab (its prefix, then m): herdr gets the release, where it last
      // had the button. The rest of that gesture is no one's: no copy and no click on the Observatory.
      bytes.length = 0;
      await mouse(0, { row: 5, col: 7 }); await mouse(32, { row: 6, col: 9 });
      await key('\x02'); await key('m');
      assert.equal(active(), 'observatory');
      assert.deepEqual(reports(), ['\x1b[<0;7;4M', '\x1b[<32;9;5M', '\x1b[<0;9;5m'], 'herdr\'s press is paired with a release');
      const run = at('Run checks', c => c < masterCols), pinned = () => state.observatory.details['obs-detail']?.selection;
      await mouse(32, run); await mouse(0, run, true);
      assert.deepEqual([copied().length, pinned()], [copies + 1, undefined], 'the release on the Observatory neither copies nor clicks');
      // Left by key and back with the button still down: its motion and release reach herdr no more.
      await key('\x1b1'); bytes.length = 0;
      await mouse(0, { row: 5, col: 7 }); await key('\x02'); await key('m'); await key('\x1b1');
      await mouse(32, { row: 8, col: 9 }); await mouse(0, { row: 8, col: 9 }, true);
      assert.deepEqual(reports(), ['\x1b[<0;7;4M', '\x1b[<0;7;4m']);
      // A selection begun on the Observatory and held across a switch to the herdr tab: its release there copies nothing
      // (it copied the herdr tab's text, here herdr's rows), and herdr gets none of a drag it never saw begin.
      client.grid = () => Array.from({ length: 36 }, (_, i) => `herdr row ${i + 1}, words under the selection`);
      await key('\x02'); await key('m'); assert.equal(active(), 'observatory');
      const title = at('Fix the demo', c => c < masterCols);
      await mouse(0, title); await mouse(32, { row: title.row, col: title.col + 6 });
      state.toast = null;
      await key('\x1b1'); assert.equal(active(), 'herdr');
      assert.match(lastFrame[title.row - 1], /herdr row \d+, words under the selection/, 'control: herdr has text where the selection lay');
      bytes.length = 0;
      await mouse(32, { row: 8, col: 9 }); await mouse(0, { row: 8, col: 9 }, true);
      assert.deepEqual(reports(), [], 'herdr gets none of it');
      assert.deepEqual([copied().length, state.toast ?? null], [copies + 1, null], 'and nothing is copied, or said');
      // Two buttons: herdr holds the left one, and the right one lands on OAK's tab bar. herdr gets the left one's release
      // first, then the tab changes.
      bytes.length = 0;
      await mouse(0, { row: 5, col: 7 });
      await key(`\x1b[<2;${lastFrame[0].indexOf('review') + 1};1M`);
      assert.equal(active(), 'review');
      assert.deepEqual(reports(), ['\x1b[<0;7;4M', '\x1b[<0;7;4m']);
      await key(`\x1b[<2;${lastFrame[0].indexOf('review') + 1};1m`); await mouse(0, { row: 5, col: 7 }, true);
      // The right one on OAK's key row instead: herdr gets the left one's release, and nothing more of that button, which
      // it would take for a drag after the release.
      await key('\x1b1'); assert.equal(active(), 'herdr');
      bytes.length = 0;
      await mouse(0, { row: 5, col: 7 }); await key('\x1b[<2;5;40M'); await key('\x1b[<2;5;40m');
      await mouse(32, { row: 6, col: 9 }); await mouse(0, { row: 6, col: 9 }, true);
      assert.deepEqual(reports(), ['\x1b[<0;7;4M', '\x1b[<0;7;4m']);
      await mouse(0, { row: 6, col: 9 }); await mouse(0, { row: 6, col: 9 }, true);
      assert.deepEqual(reports().slice(2), ['\x1b[<0;9;5M', '\x1b[<0;9;5m'], 'its next press is herdr\'s as ever');
      // The left one's release lost: its next press ends the let-go. After that press, a motion of the button that OAK saw no
      // press for reaches herdr, as it does with nothing let go.
      bytes.length = 0;
      await mouse(0, { row: 5, col: 7 }); await key('\x1b[<2;5;40M'); await key('\x1b[<2;5;40m');
      await mouse(0, { row: 6, col: 9 }); await mouse(0, { row: 6, col: 9 }, true);
      await mouse(32, { row: 7, col: 9 }); await mouse(0, { row: 7, col: 9 }, true);
      assert.deepEqual(reports(), ['\x1b[<0;7;4M', '\x1b[<0;7;4m', '\x1b[<0;9;5M', '\x1b[<0;9;5m', '\x1b[<32;9;6M', '\x1b[<0;9;6m']);
      // So does the pointer back over herdr's screen with no button held: that motion reaches herdr, and so does a motion of
      // the button after it.
      bytes.length = 0;
      await mouse(0, { row: 5, col: 7 }); await key('\x1b[<2;5;40M'); await key('\x1b[<2;5;40m');
      await mouse(35, { row: 6, col: 9 });
      await mouse(32, { row: 7, col: 9 }); await mouse(0, { row: 7, col: 9 }, true);
      assert.deepEqual(reports(), ['\x1b[<0;7;4M', '\x1b[<0;7;4m', '\x1b[<35;9;5M', '\x1b[<32;9;6M', '\x1b[<0;9;6m']);
      // Another button pressed in herdr's screen while the let-go one is still held does not end the let-go: herdr got that
      // button's release, and its drag and release after are no one's. herdr got them as a drag after the release.
      bytes.length = 0;
      await mouse(0, { row: 5, col: 7 }); await key('\x1b[<2;5;40M'); await key('\x1b[<2;5;40m');
      await key('\x1b[<2;9;6M'); await key('\x1b[<2;9;6m');
      await mouse(32, { row: 7, col: 9 }); await mouse(0, { row: 7, col: 9 }, true);
      assert.deepEqual(reports(), ['\x1b[<0;7;4M', '\x1b[<0;7;4m', '\x1b[<2;9;5M', '\x1b[<2;9;5m']);
      // herdr's prefix pressed while herdr holds the button: the release let go over OAK's rows reaches herdr, so the
      // prefix goes on before it, as it does before any press or release of herdr's. It was dropped.
      await key('\x1b2'); await key('\x02'); await key('m'); await key('\x1b1');
      state.status = 'ready'; await painted();
      bytes.length = 0;
      await mouse(0, { row: 5, col: 7 }); await key('\x02'); await mouse(32, { row: 40, col: 9 }); await mouse(0, { row: 40, col: 9 }, true);
      assert.equal(sent(), '\x1b[<0;7;4M\x1b[<32;9;35M\x02\x1b[<0;9;35m');
      // So does a ctrl+q held for its second press, which then quits nothing.
      state.status = 'ready'; await painted();
      bytes.length = 0;
      await mouse(0, { row: 5, col: 7 }); await key('\x11'); await mouse(32, { row: 40, col: 9 }); await mouse(0, { row: 40, col: 9 }, true);
      assert.equal(sent(), '\x1b[<0;7;4M\x1b[<32;9;35M\x11\x1b[<0;9;35m');
      assert.notEqual(state.status, 'press ctrl+q again to exit');
    } else if (check === 'copy-outcomes') {
      // A copy says how it went in a toast, which goes: a refused copy stood on the status row while the session was
      // open, hid herdr's last row there, and a later copy's toast showed beside it (2026-10-13). What the row said stays.
      delete process.env.TMUX;
      const toast = () => (state.toast && state.toast.until > Date.now() ? state.toast.text : '');
      const stands = () => state.toast.until - Date.now();
      // Colour written with colons passes onto the row as colour does, and a copy of the row leaves it out as it leaves
      // out the other form: it copied the escape's bytes.
      state.status = 'kept \x1b[4:3mone\x1b[0m edit'; await key('\x1b[C');
      const kept = lastFrame.findIndex(line => line.startsWith('kept \x1b[4:3mone')) + 1;
      assert.ok(kept > 30, 'control: the status row carries the colon form');
      await mouse(0, { row: kept, col: 1 }); await mouse(32, { row: kept, col: 8 }); await mouse(0, { row: kept, col: 8 }, true);
      assert.equal(copied().at(-1), 'kept one');
      state.toast = null;
      state.status = 'kept 1 edit';
      // A drag over the master's padding alone.
      const earlier = at('earlier · 1', c => c < masterCols);
      await mouse(0, { row: earlier.row + 3, col: 3 }); await mouse(32, { row: earlier.row + 4, col: 9 }); await mouse(0, { row: earlier.row + 4, col: 9 }, true);
      assert.equal(toast(), 'nothing under that selection — it was all padding');
      assert.ok(stands() > 2500 && stands() <= 8000, `a toast that says nothing was copied stands longer: ${stands()} ms`);
      assert.equal(state.status, 'kept 1 edit');
      const title = at('Fix the demo', c => c < masterCols);
      await mouse(0, title); await mouse(32, { row: title.row, col: title.col + 2 }); await mouse(0, { row: title.row, col: title.col + 2 }, true);
      assert.deepEqual([toast(), state.status], ['copied 3 chars to clipboard', 'kept 1 edit'], 'a copy replaces the toast before it');
      assert.ok(stands() <= 2500);
      // The terminal changes size under a selection.
      await mouse(0, title); await mouse(32, { row: title.row, col: title.col + 4 });
      Object.defineProperty(process.stdout, 'columns', { value: 130, configurable: true }); process.stdout.emit('resize'); await wait();
      assert.deepEqual([toast(), state.status], ['nothing copied: the terminal changed size during the selection', 'kept 1 edit']);
      await mouse(0, { row: title.row, col: title.col + 4 }, true);
      Object.defineProperty(process.stdout, 'columns', { value: 140, configurable: true }); process.stdout.emit('resize'); await wait();
      // The bottom rows move under a selection held on them: the status row goes silent before the release.
      await key('\x1b1');
      const client = spawns[0].client;
      client.update(); await wait();
      const statusRow = lastFrame.findIndex(line => line.startsWith('kept 1 edit')) + 1;
      assert.ok(statusRow > 30, 'control: the status row speaks');
      await mouse(0, { row: statusRow, col: 1 }); await mouse(32, { row: statusRow, col: 6 });
      state.status = 'ready'; state.toast = null; client.update(); await wait();
      await mouse(0, { row: statusRow, col: 6 }, true);
      assert.deepEqual([toast(), state.status], ['nothing copied: the rows under the selection moved before its release', 'ready']);
      // A drag on Review says what release does while it runs, and that goes with the release.
      await key('\x02'); await key('m'); await key('\x1b3'); assert.equal(active(), 'review');
      const from = at('Traces has no data'), to = { row: from.row, col: from.col + 5 };
      await mouse(0, from); await mouse(32, to);
      assert.equal(state.status, 'selecting — release to copy');
      await mouse(0, to, true);
      assert.deepEqual([toast(), state.status], ['copied 6 chars to clipboard', 'ready']);
      // The selection Review keeps after the release is that tab's: ctrl+c on the next tab copied that tab's text there.
      assert.ok(state.selSpan, 'control: Review keeps it');
      await key('\x1b2');
      assert.equal(active(), 'observatory');
      assert.deepEqual([state.selSpan, bands()], [null, {}], 'the tab switch drops it');
    } else if (check === 'copy-lanes') {
      // herdr's copies start one process at a time on each path, and the newest text waiting goes next: a program in its
      // pane that writes the clipboard on every change started a process for every write (2026-10-13).
      await key('\x1b1');
      const client = spawns[0].client;
      process.env.TMUX = '/fixture/tmux,1,0';
      clipTools.tmux = tool('tmux', { hold: true });
      client.clipboard('one'); client.clipboard('two'); client.clipboard('three'); await wait();
      assert.deepEqual(runs.map(r => [r.name, r.text]), [['tmux', 'one']], 'one process while it runs');
      runs[0].end(); await wait();
      assert.deepEqual(runs.map(r => r.text), ['one', 'three'], 'then the newest text that waited');
      runs[1].end(); await wait();
      assert.equal(runs.length, 2);
      assert.equal(state.toast ?? null, null, 'herdr says it copied: OAK adds no toast');
      // OAK's own copy through tmux says so.
      await key('\x02'); await key('m');
      const title = at('Fix the demo', c => c < masterCols);
      await mouse(0, title); await mouse(32, { row: title.row, col: title.col + 2 }); await mouse(0, { row: title.row, col: title.col + 2 }, true);
      runs[2].end(); await wait();
      assert.deepEqual([runs[2].text, state.toast?.text], ['Fix', 'copied 3 chars to clipboard via tmux']);
      // The system's tools, for copies too large for OSC 52, the same way.
      delete process.env.TMUX; runs.length = 0;
      clipTools['wl-copy'] = tool('wl-copy', { hold: true });
      const big = ch => ch.repeat(60 * 1024);
      client.clipboard(big('a')); client.clipboard(big('b')); client.clipboard(big('c')); await wait();
      assert.deepEqual(runs.map(r => r.text[0]), ['a']);
      runs[0].end(); await wait();
      assert.deepEqual(runs.map(r => r.text[0]), ['a', 'c']);
      runs[1].end(); await wait();
      assert.equal(runs.length, 2);
      assert.equal(runs[1].text, big('c'));
      // A process that never finishes holds its path for ten seconds, no longer.
      const setTimer = global.setTimeout, valves = [];
      global.setTimeout = (fn, ms, ...rest) => (ms === 10_000 ? (valves.push(fn), { unref() {} }) : setTimer(fn, ms, ...rest));
      try {
        client.clipboard(big('d')); client.clipboard(big('e')); await wait();
      } finally { global.setTimeout = setTimer; }
      assert.deepEqual(runs.map(r => r.text[0]), ['a', 'c', 'd']);
      valves[0](); await wait();
      assert.deepEqual(runs.map(r => r.text[0]), ['a', 'c', 'd', 'e'], 'its ten seconds up, the newest waiting goes');
    } else if (check === 'copy-stuck') {
      // A copy's process that has not finished in ten seconds is stopped, and what it does after is not heard: failing late,
      // it ran the next tool with its older text after a newer copy, and finishing late, its toast said it had copied
      // (2026-10-13).
      await key('\x1b1');
      const client = spawns[0].client;
      delete process.env.TMUX;
      clipTools['wl-copy'] = tool('wl-copy', { hold: true }); clipTools.xclip = tool('xclip', { hold: true });
      const big = ch => ch.repeat(60 * 1024);
      const setTimer = global.setTimeout, valves = [];
      const stuck = async go => {
        global.setTimeout = (fn, ms, ...rest) => (ms === 10_000 ? (valves.push(fn), { unref() {} }) : setTimer(fn, ms, ...rest));
        try { await go(); } finally { global.setTimeout = setTimer; }
      };
      await stuck(async () => { client.clipboard(big('d')); await wait(); });
      valves.shift()(); await wait();
      assert.equal(runs[0].killed, true, 'its ten seconds up, wl-copy is stopped');
      assert.equal(state.toast?.text, "herdr's copy did not reach the clipboard: wl-copy did not finish in 10 s", 'and a toast says so');
      assert.ok(state.toast.until - Date.now() > 2500, 'for as long as a refusal stands');
      client.clipboard(big('e')); await wait();
      runs[1].end(0); await wait();
      runs[0].end(1); await wait();
      assert.deepEqual(runs.map(r => [r.name, r.text[0]]), [['wl-copy', 'd'], ['wl-copy', 'e']], 'and failing late, it runs no other tool with the older text');
      // Inside tmux, OAK's own copy: tmux is stopped at ten seconds, herdr's newer copy goes, and the stopped one says nothing
      // when it finishes.
      process.env.TMUX = '/fixture/tmux,1,0';
      clipTools.tmux = tool('tmux', { hold: true });
      await key('\x02'); await key('m');
      const title = at('Fix the demo', c => c < masterCols);
      await stuck(async () => { await mouse(0, title); await mouse(32, { row: title.row, col: title.col + 2 }); await mouse(0, { row: title.row, col: title.col + 2 }, true); });
      const fix = runs.at(-1);
      assert.deepEqual([fix.name, fix.text], ['tmux', 'Fix']);
      valves.shift()(); await wait();
      assert.equal(fix.killed, true, 'its ten seconds up, tmux is stopped');
      assert.equal(state.toast?.text, 'nothing copied: tmux did not finish in 10 s');
      client.clipboard('newer'); await wait();
      assert.equal(runs.at(-1).text, 'newer');
      runs.at(-1).end(0); await wait();
      state.toast = null;
      fix.end(0); await wait();
      assert.deepEqual([state.toast ?? null, copied()], [null, []], 'and finishing late, it says nothing');
    } else if (check === 'copy-messages') {
      // herdr's copy too large for OSC 52, on a terminal of this machine: the tools that ran and failed (no display) are
      // named, and those not installed are named to install.
      await key('\x1b1');
      const client = spawns[0].client;
      delete process.env.TMUX;
      Object.assign(clipTools, { 'wl-copy': tool('wl-copy', { exit: 1 }), xclip: tool('xclip', { exit: 1 }), pbcopy: tool('pbcopy', { missing: true }) });
      client.clipboard('a'.repeat(60 * 1024)); await wait();
      assert.equal(state.toast?.text, "herdr's copy is too large for the terminal (80KB, limit ~73KB), and wl-copy and xclip failed");
      Object.assign(clipTools, { 'wl-copy': tool('wl-copy', { missing: true }), xclip: tool('xclip', { missing: true }) });
      client.clipboard('a'.repeat(60 * 1024)); await wait();
      assert.equal(state.toast?.text, "herdr's copy is too large for the terminal (80KB, limit ~73KB) — install wl-copy or xclip for big copies");
      // One that failed is named, and one that is not installed is named to install: on X11 wl-copy has no Wayland display,
      // and xclip would copy. The advice went with any tool that failed (2026-10-13).
      Object.assign(clipTools, { 'wl-copy': tool('wl-copy', { exit: 1 }), xclip: tool('xclip', { missing: true }) });
      client.clipboard('a'.repeat(60 * 1024)); await wait();
      assert.equal(state.toast?.text, "herdr's copy is too large for the terminal (80KB, limit ~73KB), and wl-copy failed — install xclip for big copies");
      // A tool that fails to start can report an exit after its error, as Node allows: the first decides, so it is named to
      // install, and the next tool runs once.
      runs.length = 0;
      Object.assign(clipTools, { 'wl-copy': tool('wl-copy', { missing: true, exits: true }), xclip: tool('xclip', { exit: 1 }) });
      client.clipboard('a'.repeat(60 * 1024)); await wait();
      assert.deepEqual(runs.map(r => r.name), ['xclip']);
      assert.equal(state.toast?.text, "herdr's copy is too large for the terminal (80KB, limit ~73KB), and xclip failed — install wl-copy for big copies");
      // A paste counts characters as a copy does: it said `pasted 2 chars` for one emoji.
      await key('\x02'); await key('m'); await key('/');
      const pasting = text => args => {
        const { EventEmitter } = require('events'), child = new EventEmitter();
        child.stdout = new EventEmitter();
        queueMicrotask(() => { child.stdout.emit('data', Buffer.from(text)); child.emit('exit', 0); });
        return child;
      };
      clipTools['wl-paste'] = pasting('\u{1F600}');
      await key('\x16');
      assert.equal(state.status, 'pasted 1 char');
      clipTools['wl-paste'] = pasting('café');
      await key('\x16');
      assert.equal(state.status, 'pasted 4 chars');
    } else if (check === 'copy-remote') {
      // Over ssh the system's tools would copy to the remote machine's clipboard: herdr's copy too large for OSC 52 is
      // said to be so, and nobody is told to select less, which they did not select.
      await key('\x1b1');
      spawns[0].client.clipboard('a'.repeat(60 * 1024)); await wait();
      assert.equal(state.toast?.text, "herdr's copy is too large for the terminal (80KB, limit ~73KB)");
      assert.deepEqual(runs, [], 'and no tool runs');
    } else if (check === 'copy-remote-narrow') {
      // A refusal's toast stands eight seconds: on 80 columns the quit hint and a confirmation said after it were cut
      // under it (2026-10-13). What is said after it shows whole.
      Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true }); process.stdout.emit('resize'); await wait();
      await key('\x1b1');
      const client = spawns[0].client;
      const plain = () => lastFrame.map(l => l.replace(/\x1b\[[0-9;:]*m/g, '').trimEnd());
      client.clipboard('a'.repeat(60 * 1024)); await wait();
      assert.ok(plain().some(l => l.endsWith("herdr's copy is too large for the terminal (80KB, limit ~73KB)")), 'control: the toast stands');
      await key('\x11'); client.update(); await wait();
      assert.ok(plain().includes('press ctrl+q again to exit'), plain().slice(-4).join('\n'));
      await new Promise(resolve => setTimeout(resolve, 2200)); // the quit window ends
      await key('\x02'); await key('m'); await key('\x1b3'); assert.equal(active(), 'review');
      // Said before the toast, a status the row cannot hold beside it gives way, as ever.
      state.status = 'a status said before the refusal, too long to stand beside it';
      await new Promise(resolve => setTimeout(resolve, 5));
      client.clipboard('a'.repeat(60 * 1024)); await wait();
      assert.ok(plain().some(l => l.endsWith("herdr's copy is too large for the terminal (80KB, limit ~73KB)")), plain().slice(-4).join('\n'));
      // As A asks it (this fixture lists no edits).
      state.confirm = { verb: 'keep', ids: [1, 2, 3], label: 'everything listed' }; process.stdout.emit('resize'); await wait();
      assert.ok(plain().includes('keep 3 edit(s) — everything listed?  [y/n]'), plain().slice(-4).join('\n'));
      state.confirm = null;
    } else if (check === 'copy-remote-ready') {
      // Only a status said after a toast takes its row: closing the help says `ready` again, and an error standing on the
      // row then hid herdr's refusal. A key's answer said again and a keep that failed after the toast lost the row to it
      // (2026-10-13).
      Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true }); process.stdout.emit('resize'); await wait();
      await key('\x1b1');
      const client = spawns[0].client;
      await key('\x02'); await key('m'); assert.equal(active(), 'observatory');
      const plain = () => lastFrame.map(l => l.replace(/\x1b\[[0-9;:]*m/g, '').trimEnd());
      const refusal = "herdr's copy is too large for the terminal (80KB, limit ~73KB)";
      state.error = 'a read of the conversation failed: the machine could not be reached';
      await key('?'); assert.ok(state.overlay, 'control: the help is open');
      client.clipboard('a'.repeat(60 * 1024)); await wait();
      assert.ok(plain().some(l => l.endsWith(refusal)), `control: the toast stands\n${plain().slice(-4).join('\n')}`);
      const said = state.statusAt;
      await key('q'); assert.ok(!state.overlay, 'control: the help is closed');
      assert.equal(state.statusAt, said, '`ready` said again is not said after the toast');
      assert.ok(plain().some(l => l.endsWith(refusal)), `the toast keeps the row:\n${plain().slice(-4).join('\n')}`);
      state.error = null;
      // A key's answer said again is said after the toast: `y` with still nothing to copy, as a quit hint re-armed after
      // its window ended is, which the toast hid until the next press quit.
      await key('\x1b3'); assert.equal(active(), 'review');
      const nothing = 'nothing here to copy — select an edit, or open its diff';
      await key('y'); assert.ok(plain().includes(nothing), `control: y answers\n${plain().slice(-4).join('\n')}`);
      client.clipboard('a'.repeat(60 * 1024)); await wait();
      assert.ok(plain().some(l => l.endsWith(refusal)), `control: the newer toast takes the row\n${plain().slice(-4).join('\n')}`);
      await key('y');
      assert.ok(plain().includes(nothing), `y's answer said again shows whole:\n${plain().slice(-4).join('\n')}`);
      // The quit hint re-armed after its window ended: on Review the hint stays when the window ends, so ctrl+q says the
      // same text again.
      const hint = 'press ctrl+q again to exit';
      await key('\x11'); assert.ok(plain().includes(hint), `control: ctrl+q asks\n${plain().slice(-4).join('\n')}`);
      await new Promise(resolve => setTimeout(resolve, 2200)); // the quit window ends
      client.clipboard('a'.repeat(60 * 1024)); await wait();
      assert.ok(!plain().includes(hint) && plain().some(l => l.endsWith(refusal)), `control: the newer toast takes the row\n${plain().slice(-4).join('\n')}`);
      await key('\x11');
      assert.ok(plain().includes(hint), `the quit hint re-armed shows whole:\n${plain().slice(-4).join('\n')}`);
      // A keep that fails after the toast says so whole (actionFailed stamps when it failed); as A asks it.
      state.confirm = { verb: 'keep', ids: [1, 2, 3], label: 'everything listed' };
      await key('y');
      assert.ok(plain().includes(`! ${keepFailed}`), `a keep that failed after the toast shows whole:\n${plain().slice(-4).join('\n')}`);
    } else if (check === 'copy-remote-toast-ends') {
      // A refusal's toast goes by itself at the end of its eight seconds on the herdr tab, on Review and under an overlay,
      // where nothing else paints: the app paints when it ends (2026-10-13).
      await key('\x1b1');
      const client = spawns[0].client;
      const shown = () => lastFrame.some(l => l.includes("herdr's copy is too large for the terminal"));
      const setTimer = global.setTimeout, ends = [];
      global.setTimeout = (fn, ms, ...rest) => (ms === 8100 ? (ends.push(fn), { unref() {} }) : setTimer(fn, ms, ...rest));
      try {
        for (const [where, keys, here] of [['the herdr tab', [], () => active() === 'herdr'], ['Review', ['\x02', 'm', '\x1b3'], () => active() === 'review'],
          ['the help over the Observatory', ['\x1b2', '?'], () => active() === 'observatory' && state.overlay?.title.startsWith('keys')]]) {
          for (const k of keys) await key(k);
          assert.ok(here(), `control: ${where}`);
          client.clipboard('a'.repeat(60 * 1024)); await wait();
          assert.ok(shown() && ends.length === 1, `control: the toast shows (${where})`);
          state.toast.until = Date.now(); // its eight seconds are up
          ends.shift()(); await wait();
          assert.ok(!shown(), `the toast goes by itself (${where}):\n${lastFrame.slice(-4).join('\n')}`);
        }
      } finally { global.setTimeout = setTimer; }
    } else if (check === 'done-fold') {
      const masterRows = () => tui.treePaneRows(state, 'sessions-nav', masterCols, tui.glyphs('ascii'), 'none', 'obs-sessions');
      const visible = () => masterRows().some(r => r.scope?.session === 'idle');
      assert.equal(visible(), false);
      for (let i = 0; i < 8 && state.observatoryFold !== 'done:local'; i++) {
        await key('\x1b[B');
        assert.notEqual(state.scopeWorker?.session, 'idle', 'arrows never select a hidden session');
      }
      assert.equal(state.observatoryFold, 'done:local', 'the keyboard can select the done fold');
      await key('\x1b[C');
      assert.ok(state.open.has('done:local')); assert.equal(visible(), true);
      await key('\r');
      assert.ok(!state.open.has('done:local')); assert.equal(visible(), false);
      const clickFold = async () => { const pos = at('1 done', c => c < masterCols); await mouse(0, pos); await mouse(0, pos, true); };
      await clickFold(); assert.equal(visible(), true);
      await key('\x1b[B'); assert.equal(state.scopeWorker?.session, 'idle');
      await key('\r'); assert.equal(state.observatory.details['obs-detail'].selection.session, 'idle');
      await clickFold(); assert.equal(visible(), true, 'closing keeps the pinned session on screen');
      assert.ok(masterRows().some(r => r.scope?.session === state.scopeWorker?.session) || state.observatoryFold);
    } else if (check === 'worker-rows') {
      // A session's workers sit in one group under it, closed until → , Enter or a click opens it; ←, Enter or a second
      // click closes it. Its summary, each state's header and each worker are rows the arrows and the mouse pick; a
      // worker's row pins its session, into the leaf the reader focused, on the machine the row names.
      const masterCols = Math.floor(140 * 0.3);
      const at = (text) => {
        const row = lastFrame.findIndex(line => { const c = line.indexOf(text); return c >= 0 && c < masterCols; });
        assert.ok(row >= 0, `"${text}" is painted in the master:\n${lastFrame.join('\n')}`);
        return { row: row + 1, col: lastFrame[row].indexOf(text) + 1 };
      };
      const painted = text => lastFrame.some(line => { const c = line.indexOf(text); return c >= 0 && c < masterCols; });
      const press = async (col, row) => { await key(`\x1b[<0;${col};${row}M`); await key(`\x1b[<0;${col};${row}m`); };
      const click = async (text) => { const p = at(text); await press(p.col, p.row); };
      const pinnedIn = leaf => state.observatory.details[leaf]?.selection;
      const picked = () => [state.scopeWorker?.session, state.scopeWorker?.workers ?? state.scopeWorker?.agentId ?? null];
      const fold = 'workers:local:working';
      state.tabs[state.activeTab].root = { kind: 'split', dir: 'h', ratio: 0.3, first: { kind: 'pane', id: 'obs-sessions', view: 'sessions-nav' },
        second: { kind: 'split', dir: 'v', ratio: 0.5, first: { kind: 'pane', id: 'obs-detail', view: 'session-detail' },
          second: { kind: 'pane', id: 'split-9', view: 'session-detail' } } };
      await click('Fix the demo');
      assert.equal(pinnedIn('obs-detail')?.session, 'claude-conversation');
      const boxes = lastFrame.flatMap((line, i) => (/^[+┌][-─] Session/.test(line.slice(masterCols + 1)) ? [i] : []));
      assert.equal(boxes.length, 2, `two conversation leaves are painted\n${lastFrame.join('\n')}`);
      // Closed at first: one summary row under the session, counting them by state.
      assert.ok(at('7 workers').row > at('Run checks').row && !painted('Local worker'), 'closed: the summary alone');
      assert.match(lastFrame[at('7 workers').row - 1], /> 7 workers · . 4 working · . 3/);
      // A click opens it and picks it; a second closes it. Neither pins anything.
      await click('7 workers');
      assert.ok(state.open.has(fold) && painted('blocked (3)') && painted('Local worker 2'), 'a click opens it');
      assert.deepEqual(picked(), ['working', 'all']);
      assert.ok(at('blocked (3)').row < at('Local worker 2').row && at('Local worker 6').row < at('working (4)').row, 'those waiting on a person first');
      await click('7 workers');
      assert.ok(!state.open.has(fold) && !painted('Local worker'), 'a second click closes it');
      assert.equal(pinnedIn('split-9'), undefined, 'a summary is not a pin');
      // The keyboard: ↓ from the session picks its summary, → opens it, the arrows walk its headers and workers.
      await key('\x1b[A');
      assert.deepEqual(picked(), ['working', null], '↑ from the summary picks its session');
      await key('\x1b[B');
      assert.deepEqual(picked(), ['working', 'all']);
      await key('\x1b[C');
      assert.ok(state.open.has(fold), '→ opens it');
      assert.equal(state.tabs[state.activeTab].treeFocus, 'obs-sessions', 'and keeps the master focused');
      await key('\x1b[B'); assert.deepEqual(picked(), ['working', 'blocked'], 'the blocked header');
      await key('\x1b[B'); assert.deepEqual(picked(), ['working', 'w2']);
      assert.match(lastFrame[at('Local worker 2').row - 1], /> Local worker 2/, 'marked where it is drawn');
      await key('\x1b[B'); await key('\x1b[B'); await key('\x1b[B');
      assert.deepEqual(picked(), ['working', 'working'], 'past the waiting workers, the working header');
      // ← from inside it closes it and leaves its summary picked; Enter opens and closes it.
      await key('\x1b[B'); assert.deepEqual(picked(), ['working', 'w1']);
      await key('\x1b[D');
      assert.ok(!state.open.has(fold));
      assert.deepEqual(picked(), ['working', 'all'], '← closes the group, its summary picked');
      await key('\r'); assert.ok(state.open.has(fold), 'Enter opens it');
      await key('\r'); assert.ok(!state.open.has(fold), 'Enter closes it');
      await key('\x1b[B'); assert.deepEqual(picked(), ['idle', null], 'closed, ↓ goes on to the next session');
      // A worker's row: one click pins its session into the leaf the reader focused, and picks it; Enter on it pins.
      await key('\x1b[A'); await key('\x1b[C');
      await press(masterCols + 30, boxes[1] + 6);
      assert.equal(state.tabs[state.activeTab].treeFocus, 'split-9');
      await click('Local worker 3');
      assert.deepEqual([pinnedIn('split-9')?.session, pinnedIn('split-9')?.machineId], ['working', 'local'], 'a worker row pins its session into the leaf the reader focused');
      assert.equal(pinnedIn('obs-detail')?.session, 'claude-conversation', 'the other leaf keeps its pin');
      assert.deepEqual(picked(), ['working', 'w3'], 'and the worker stays picked');
      await key('\x1b[B'); await key('\r');
      assert.deepEqual(picked(), ['working', 'w5'], 'Enter on a worker pins its session and keeps it picked');
      assert.equal(pinnedIn('split-9')?.session, 'working');
      assert.equal(pinnedIn('split-9')?.agentId, 'w5');
      assert.match(JSON.stringify(state.observatory.details['split-9'].feed), /Worker-only activity/);
      // A saved machine's session: its group from that machine's listing, its worker pinned on that machine.
      for (let i = 0; i < 12 && state.scopeWorker.session !== 'remote-done'; i++) await key('\x1b[B');
      await key('\x1b[B');
      assert.deepEqual(picked(), ['remote-done', 'all']);
      await key('\r'); await key('\x1b[B'); await key('\x1b[B');
      assert.deepEqual(picked(), ['remote-done', 'r1']);
      await click('Remote worker');
      const remote = Object.values(state.observatory.details).map(d => d.selection).find(sel => sel.session === 'remote-done');
      assert.equal(remote?.machineId, 'build', 'a remote worker row pins its log on its machine');
      assert.equal(remote?.agentId, 'r1');
      assert.ok(!requests.some(r => r.method === 'tab.create'));
      assert.equal(prompts.length, 0);
      assert.deepEqual(picked(), ['remote-done', 'r1']);
    } else if (check === 'worker-preview') {
      const masterCols = Math.floor(140 * 0.3);
      const at = (text) => {
        const row = lastFrame.findIndex(line => { const c = line.indexOf(text); return c >= 0 && c < masterCols; });
        assert.ok(row >= 0, `"${text}" is painted in the master:\n${lastFrame.join('\n')}`);
        return { row: row + 1, col: lastFrame[row].indexOf(text) + 1 };
      };
      const press = async (col, row) => { await key(`\x1b[<0;${col};${row}M`); await key(`\x1b[<0;${col};${row}m`); };
      const click = async (text) => { const p = at(text); await press(p.col, p.row); };
      const picked = () => [state.scopeWorker?.session, state.scopeWorker?.workers ?? state.scopeWorker?.agentId ?? null];
      const fold = 'workers:local:working';
      // A worker picked by the arrows, nothing pinned: the detail previews its SESSION, and a click on the blank part
      // of the preview's button row pins nothing, as it does for a session. The worker is reached from below, so the
      // preview is first drawn for it rather than for its session.
      await click('workstation');
      for (let i = 0; i < 6 && picked()[1] !== 'all'; i++) await key('\x1b[B');
      assert.deepEqual(picked(), ['working', 'all']);
      await key('\x1b[C');
      for (let i = 0; i < 12 && picked()[0] !== 'idle'; i++) await key('\x1b[B');
      assert.deepEqual(picked(), ['idle', null]);
      await key('\x1b[A');
      assert.deepEqual(picked(), ['working', 'w7'], 'up from the next session: the last worker of the open group');
      const preview = lastFrame.findIndex(line => line.indexOf('worker log') > masterCols);
      assert.ok(preview >= 0, `the preview names the worker log\n${lastFrame.join('\n')}`);
      assert.ok(!lastFrame.some(line => line.indexOf('■ stop') > masterCols), 'a worker preview offers no parent process action');
      await press(masterCols + 30, preview + 1);
      assert.equal(state.observatory.details['obs-detail'], undefined, 'a click beside the preview pins nothing');
      assert.deepEqual(picked(), ['working', 'w7']);
      // The click focused the detail: ← focuses the list again, and the next ← closes the group.
      await key('\x1b[D');
      assert.equal(state.tabs[state.activeTab].treeFocus, 'obs-sessions');
      await key('\x1b[D');
      assert.ok(!state.open.has(fold));
    } else if (check === 'worker-vanish') {
      // The group's last worker finishes while a row of it is picked: the mark falls back to the session, and so do the
      // keys. Enter pins the session and → focuses the detail, rather than opening or closing a group no longer drawn.
      const picked = () => [state.scopeWorker?.session, state.scopeWorker?.workers ?? state.scopeWorker?.agentId ?? null];
      const masterCols = Math.floor(140 * 0.3);
      const painted = text => lastFrame.some(line => { const c = line.indexOf(text); return c >= 0 && c < masterCols; });
      const listing = workers => { data.views = { ...data.views, sessions: { ...data.views.sessions, sessions: data.views.sessions.sessions.map((r, i) => (i === 1 ? { ...r, activeWorkers: workers } : { ...r })) } }; };
      const all = data.views.sessions.sessions[1].activeWorkers;
      const p = at('Fix the demo');
      await key(`\x1b[<0;${p.col};${p.row}M`); await key(`\x1b[<0;${p.col};${p.row}m`);
      for (let i = 0; i < 6 && picked()[1] !== 'all'; i++) await key('\x1b[B');
      await key('\x1b[C');
      for (let i = 0; i < 8 && picked()[1] !== 'w3'; i++) await key('\x1b[B');
      assert.deepEqual(picked(), ['working', 'w3']);
      // The picked worker finishes; its group stays: the arrows go on from its session, to the group's summary.
      listing(all.filter(w => w.agentId !== 'w3')); await key('r');
      assert.ok(!painted('Local worker 3') && painted('Local worker 1'), 'w3 is gone, the group stays');
      await key('\x1b[B');
      assert.deepEqual(picked(), ['working', 'all'], 'from a worker that is gone, the arrows go on from its session');
      await key('\x1b[D');
      assert.ok(!state.open.has('workers:local:working'), '← closes the group');
      // Every worker finishes with the summary picked: the group is gone and the keys act on the session.
      listing([]); await key('r');
      assert.ok(!painted('workers'), 'no group is drawn');
      await key('\x1b[C');
      assert.equal(state.tabs[state.activeTab].treeFocus, 'obs-detail', '→ focuses the detail, as on a session');
      await key('\x1b[D');
      assert.equal(state.tabs[state.activeTab].treeFocus, 'obs-sessions');
      await key('\r');
      assert.equal(state.observatory.details['obs-detail']?.selection.session, 'working', 'Enter pins the session the mark is on');
    } else if (check === 'workspace-nav') {
      // The arrows walk every session across the workspace and machine headers,
      // in a master taller than its pane: no header stops them, the pick's whole entry is painted
      // (never under the `+N more` hint), and moving up paints the headers directly above it.
      const masterCols = Math.floor(140 * 0.3);
      const g = tui.glyphs('ascii');
      const view = () => {
        const title = lastFrame.findIndex(line => line.startsWith(' Sessions'));
        const divider = lastFrame.findIndex((line, i) => i > title && /^-{100,}$/.test(line.trimEnd()));
        const body = lastFrame.slice(title + 1, divider).map(line => line.slice(0, masterCols).trimEnd());
        const rows = tui.treePaneRows(state, 'sessions-nav', masterCols, g, 'none', 'obs-sessions');
        const scroll = Math.max(0, Math.min(state.treeScroll?.['obs-sessions'] ?? 0, Math.max(0, rows.length - body.length)));
        return { body, rows, scroll };
      };
      const painted = k => { const { body, rows, scroll } = view(); return body[k - scroll] === (' ' + rows[k].cells).trimEnd(); };
      // A session's entry: its first listing and the rows that follow it without a break.
      const entry = session => {
        const { rows } = view();
        const first = rows.findIndex(r => r.scope?.session === session);
        let last = first;
        while (rows[last + 1]?.scope?.session === session) last++;
        return [first, last];
      };
      const whole = (session, how) => {
        const [first, last] = entry(session);
        for (let k = first; k <= last; k++) assert.ok(painted(k), `row ${k} of ${session} is painted after ${how}\n${lastFrame.join('\n')}`);
      };
      const order = ['current-plain', 'claude-conversation', 'working', 'idle', ...Array.from({ length: 12 }, (_, i) => `extra-${i}`), 'remote-done', 'unknown'];
      // The current session is listed again in the open archived fold; its entry is still the first listing.
      state.open = new Set([...state.open, 'archived']);
      assert.ok(view().rows.length > view().body.length + 20, 'the master is taller than its pane');
      // ↑ first, while no status line has taken the tree's last row yet: the last session is painted whole.
      assert.equal(tui.treeReclaimsRow(state, 140, 'none'), false, 'no status row before the first key');
      await key('\x1b[A');
      assert.equal(state.scopeWorker.session, 'unknown');
      whole('unknown', 'the first ↑');
      state.scopeWorker = null;
      const down = [];
      for (let i = 0; i <= order.length; i++) {
        await key('\x1b[B');
        down.push(state.scopeWorker.session);
        whole(state.scopeWorker.session, '↓');
      }
      assert.deepEqual(down, [...order, 'unknown'], 'every session once, in painted order; the last one holds');
      const up = [];
      for (let i = 0; i < order.length; i++) {
        await key('\x1b[A');
        const session = state.scopeWorker.session; up.push(session);
        whole(session, '↑');
        const { rows } = view();
        const [first] = entry(session);
        for (let k = first - 1; k >= 0 && !rows[k].scope; k--) assert.ok(painted(k), `"${rows[k].cells.trim()}" above ${session} is painted after ↑\n${lastFrame.join('\n')}`);
      }
      assert.deepEqual(up, [...order].reverse().slice(1).concat('current-plain'), 'back up the same way; the first one holds');
      // Scrolled (as the wheel leaves it) so the first `docs` session is the top row with its header
      // just above: ↑ onto that session, already in view, still brings its header into view.
      for (let i = 0; i < 30 && state.scopeWorker.session !== 'extra-0'; i++) await key('\x1b[B');
      assert.equal(state.scopeWorker.session, 'extra-0');
      const [idleFirst] = entry('idle');
      state.treeScroll = { ...state.treeScroll, 'obs-sessions': idleFirst };
      await key('\x1b[A');
      assert.equal(state.scopeWorker.session, 'idle');
      assert.ok(painted(idleFirst - 1) && view().rows[idleFirst - 1].key === 'workspace:local:herdr:w2', `the docs header is painted\n${lastFrame.join('\n')}`);
      // An open `earlier` fold: the arrows walk into it and through it, and a selected session stays
      // where it is listed instead of jumping under its machine.
      state.open = new Set([...state.open, 'earlier']);
      for (let i = 0; i < 30 && state.scopeWorker.session !== 'unknown'; i++) await key('\x1b[B');
      const walk = [];
      for (let i = 0; i < 3; i++) {
        await key('\x1b[B');
        const session = state.scopeWorker.session; walk.push(session);
        whole(session, '↓ in the fold');
        const fold = view().rows.findIndex(r => r.key === 'earlier');
        assert.ok(fold >= 0 && entry(session)[0] > fold, `${session} stays in the open fold\n${lastFrame.join('\n')}`);
      }
      assert.deepEqual(walk, ['unresolved', 'unresolved-2', 'unresolved-2'], 'into the fold, through it, and the last one holds');
      await key('\x1b[A'); assert.equal(state.scopeWorker.session, 'unresolved');
      await key('\x1b[A'); assert.equal(state.scopeWorker.session, 'unknown');
      assert.equal(state.observatory.details['obs-detail'], undefined, 'the arrows preview; they never pin');
    }
    fs.writeSync(2, `PASS: ${check}\n`);
    process.emit('exit', 0); fs.rmSync(home, { recursive: true, force: true }); return;
  }
  assert.deepEqual(state.tabs.map(t=>t.id), ['herdr','observatory','review']);
  await key('\x1b1'); assert.equal(active(), 'herdr'); assert.equal(spawns.length,1);
  assert.equal(spawns[0].args[0], '/fake/herdr');
  await key('\x02'); await key('w'); assert.ok(bytes.includes('02') && bytes.includes('77'), 'ctrl+b then w reaches herdr');
  await key('\x02M'); assert.equal(active(), 'observatory');
  assert.ok(requests.some(r=>r.method==='pane.current'));
  assert.equal(state.observatory.details['obs-detail'].selection.session, 'claude-conversation');
  await key('\x1b[B'); await key('d'); assert.equal(active(), 'observatory');
  assert.equal(state.observatory.details['obs-detail'].selection.session, 'working');
  await key('\x1b[15~'); assert.equal(state.tabs[state.activeTab].treeFocus,'obs-detail');
  await key('\x1b[15~'); assert.equal(state.tabs[state.activeTab].treeZoom,'obs-detail');
  await key('\x1b[15~'); assert.equal(state.tabs[state.activeTab].treeZoom,null);
  await key('c');
  assert.equal(state.observatory.details['obs-detail'].reply.focused, true);
  await key('h/r ax?');
  await key('\x1b[200~ pasted\ntext\x1b[201~');
  assert.equal(state.observatory.details['obs-detail'].reply.text, 'h/r ax? pasted text', 'typing and paste stay inside the one-line reply');
  await key('\x1b[D'); await key('\x7f'); await key('X'); await key('\x05');
  assert.equal(state.observatory.details['obs-detail'].reply.text, 'h/r ax? pasted teXt');
  await key('\r');
  assert.deepEqual(prompts, [{ target: 'working', text: 'h/r ax? pasted teXt' }]);
  assert.equal(active(), 'observatory');
  assert.match(lastFrame.join('\n'), /\+- You .*\n.*\|h\/r ax\? pasted teXt +\|/, 'the sent reply shows at once, in its own box');
  assert.equal(state.observatory.details['obs-detail'].reply.sending, true);
  await key('\x1b');
  assert.equal(state.observatory.details['obs-detail'].reply.focused, false);
  submit({ type: 'agent_prompted' }); await wait();
  assert.equal(state.observatory.details['obs-detail'].reply.sending, false);
  data.observatory.machines[0].snapshot.panes[1].agent_status = 'blocked';
  await key('c');
  assert.equal(state.observatory.details['obs-detail'].reply.focused, false);
  assert.match(lastFrame.join('\n'), /blocked.*herdr/i);
  data.observatory.machines[0].snapshot.panes[1].agent_status = 'idle';
  await key('c'); await key('\x1b');
  const replyRow = lastFrame.findIndex(line => line.includes('c reply · Enter sends'));
  assert.ok(replyRow >= 0, lastFrame.join('\n'));
  const replyCol = lastFrame[replyRow].indexOf('c reply') + 1;
  await key(`\x1b[<0;${replyCol};${replyRow + 1}M`); await key(`\x1b[<0;${replyCol};${replyRow + 1}m`);
  assert.equal(state.observatory.details['obs-detail'].reply.focused, true, 'the fixed footer hit test matches its paint');
  await key('\x1b');
  // remote-done is done: the arrows reach build-box's done fold, → opens it and ↓ picks it there (df1 brief).
  await key('\x1b[D'); await key('\x1b[B'); await key('\x1b[B'); await key('\x1b[B');
  assert.equal(state.observatoryFold, 'done:build');
  await key('\x1b[C'); assert.ok(state.open.has('done:build'));
  await key('\x1b[B'); await key('d'); await key('\x1b[C');
  assert.equal(state.observatory.details['obs-detail'].selection.session, 'remote-done');
  refuseFocus = true; await key('t');
  assert.equal(active(), 'observatory'); assert.match(state.status, /remote focus refused/);
  refuseFocus = false;
  // The actual ↗ herdr button dispatches remote focus and switches only on success.
  const jumpRow = lastFrame.findIndex(line => line.includes('↗ herdr'));
  const jumpCol = lastFrame[jumpRow].indexOf('↗ herdr') + 1;
  await key(`\x1b[<0;${jumpCol};${jumpRow + 1}M`); await key(`\x1b[<0;${jumpCol};${jumpRow + 1}m`);
  assert.equal(active(), 'observatory'); assert.equal(typeof focusRemote, 'function');
  assert.deepEqual(forwarded.filter(c => c.argv[1] === 'focus').at(-1), { label: 'build-box', argv: ['agent', 'focus', 'remote-done'] });
  focusRemote({ result: { type: 'ok' } }); await wait(); assert.equal(active(), 'herdr');
  await key('\x1b1'); assert.equal(spawns.length,1,'switch back retains native PTY');
  await key('\x1b2');
  await key('\x1b1');
  spawns[0].client.ended = true; spawns[0].client.exit(0); await wait();
  assert.equal(active(), 'observatory', 'detached herdr client leaves its fixed tab available');
  await key('\x1b1'); assert.equal(spawns.length, 2, 'later switch reattaches with a new herdr client');
  await key('\x02M'); await key('\x1b[15~'); await key(':'); await key('Close the focused pane'); await key('\r');
  assert.ok(!state.observatory.details['obs-detail'], 'closed leaf releases its conversation');
  await key('d'); assert.ok(state.observatory.details['obs-detail'], 'direct pin restores a closed detail');
  fs.writeSync(2, 'PASS: lazy herdr PTY, fixed tabs, ctrl+b forwarding, ctrl+b M select+pin, d select+pin, F5 focus/zoom/restore, reply keys/paste/send/escape/blocked/click, remote focus button and tab switch, PTY reuse/relaunch, closed-detail restoration.\n');
  process.emit('exit', 0);
  fs.rmSync(home, { recursive: true, force: true });
})().catch(error=>{ fs.writeSync(2,error.stack+'\n'); process.exitCode=1; process.emit('exit',1); });
