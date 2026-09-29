// Keys that must not act by accident, driven through the INTERACTIVE app: real key bytes in, the backend's
// mutations, the bytes sent to the herdr client, the palette and the confirm out. The core is the real one
// with herdr, the CLI children and prefs writes faked. `OAK_KEYS_CHECK` picks the scenario; prints `PASS: <check>`.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const repo = path.resolve(__dirname, '../../../..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-keys-'));
process.env.HOME = home; process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude'); process.env.CODEX_HOME = path.join(home, '.codex');
for (const key of ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_ENV', 'HERDR_BIN_PATH', 'HERDR_SESSION', 'TMUX']) delete process.env[key];
process.env.HERDR_SOCKET_PATH = path.join(home, 'no-herdr.sock'); process.env.XDG_CONFIG_HOME = path.join(home, '.config');
process.env.OAK_MACHINE_LABEL = 'workstation';
const realCore = require(repo + '/packages/core/dist');
const tui = require(repo + '/packages/tui/dist');
const frame = require(repo + '/packages/tui/dist/frame');
const native = require(repo + '/packages/tui/dist/native');
const backend = require(repo + '/packages/tui/dist/backend');
const { fixture } = require('./observatory');
const data = fixture();
// One file with ONE pending edit: Review's first row addresses exactly [7].
data.views.list = { edits: [{ id: 7, file: '/workspace/a.ts', rel: 'a.ts', status: 'pending', ts: Date.now() - 1000, added: 1, removed: 0 }] };
const check = process.env.OAK_KEYS_CHECK;
let state, lastFrame;
const spawns = [], bytes = [], saves = [], mutations = [];
const draw = frame.renderDashFrame;
frame.renderDashFrame = (s, ...rest) => { state = s; lastFrame = draw(s, ...rest); return lastFrame; };
native.nativeAvailable = () => true;
native.spawnNative = (...args) => {
  const client = { ended: false, label: 'herdr', pid: 123, resize() {}, grid: () => ['fake native herdr'],
    write: b => bytes.push(Buffer.from(b).toString('hex')), close() { this.ended = true; }, onUpdate() {}, onExit(fn) { this.exit = fn; }, setHostActive() {} };
  spawns.push({ args, client }); return client;
};
let notify, releaseStatus = () => { throw new Error('status was never asked for'); }, releaseSearch = () => { throw new Error('search was never asked for'); };
const ok = { ok: true, json: { ids: [] }, err: null };
backend.createBackend = () => ({ close() {}, watcherMode: () => 'native', updateSkew: () => false,
  onData(fn) { notify = fn; }, request(names, session) { queueMicrotask(() => notify(data.views, null, Date.now(), session)); }, diff: async () => '',
  mutate: async (verb, ids) => { mutations.push({ verb, ids }); return ok; },
  mutateAll: async (verb) => { mutations.push({ verb, all: true }); return ok; },
  resolveAll: async () => { mutations.push({ verb: 'resolveAll' }); return ok; },
  // `stale-row-menu` holds `:status`'s answer until the probe releases it.
  run: (args) => check === 'stale-row-menu' && args[0] === 'status' ? new Promise(resolve => { releaseStatus = resolve; })
    : check.startsWith('search-') && args[0] === 'search' ? new Promise(resolve => { releaseSearch = resolve; }) : Promise.resolve('{}') });
const rebind = process.env.OAK_KEYS_REBIND ? JSON.parse(process.env.OAK_KEYS_REBIND) : undefined;
const deleted = [];
const core = { ...realCore, readPrefs: () => ({ color: 'none', glyphs: 'ascii', layout: { active: 'observatory' }, ...(rebind ? { keys: rebind } : {}) }), writePrefs: p => saves.push(p),
  findHerdrBin: () => '/fake/herdr', startAgentSession: () => { throw Error('no agents'); },
  deleteSession: (id) => deleted.push(id), sessionWorkspace: () => home, defaultTuiSession: () => 'claude-conversation', announceAttention() {},
  connectDaemon: async () => null, ensureDaemon: async () => ({ client: null, why: 'probe' }),
  dueRemoteUsageGather: () => false, dueAccountUsagePull: () => false, kickMonthRefresh() {}, usageLine: () => null, usageBrief: () => null,
  siblingOverviewCached: () => null, subagentDigests: () => [], findAgentPid: () => null, dropIgnored: () => ({ dropped: 0, files: [] }),
  spawnTool: (_c, args) => { const { EventEmitter } = require('events'), child = new EventEmitter(); child.stdout = new EventEmitter(); child.kill = () => {};
    if (args[2] === '--serve') return child;
    queueMicrotask(() => { child.stdout.emit('data', Buffer.from(JSON.stringify(args[1] === 'multitask' ? { agents: [] } : args[1] === 'subagents' ? { subagents: [] } : data.views))); child.emit('close', 0); });
    return child; },
  detectEditors: () => [], herdrSnapshot: async () => data.observatory.machines[0].snapshot,
  herdrMachines: async () => [], herdrOnMachine: async () => ({ result: { type: 'ok' } }),
  herdrAgent: { prompt: () => new Promise(() => {}) },
  herdrRequest: async () => ({ type: 'pane_current', pane: data.observatory.machines[0].snapshot.panes[0] }),
  herdrSubscribe: () => ({ close() {} }), createWatcher: () => ({ close() {} }), readHerdrPaneLink: () => null, ensureHerdrTabs: async () => [],
  conversationEvents: () => ({ events: [{ ts: 1, update: { sessionUpdate: 'user_prompt', content: { type: 'text', text: 'Fixture conversation' } } }], cursor: 1, transcriptPath: null, agent: 'claude' }),
};
Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
process.stdin.setRawMode = () => {};
Object.defineProperty(process.stdout, 'columns', { value: 140, configurable: true });
Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
process.stdout._refreshSize = () => {};
process.stdout.write = () => true;
const exit = process.exit.bind(process);
process.exit = () => {}; // a quit the probe presses must not end it
const wait = (ms = 90) => new Promise(resolve => setTimeout(resolve, ms));
const key = async text => { process.stdin.emit('data', Buffer.from(text)); await wait(); if (text === '\x1b') await wait(); };
const tab = () => state.tabs[state.activeTab].id;
const toReview = async () => { await key('\x01' + '3'); await wait(200); assert.equal(tab(), 'review'); };
const actions = () => (state.overlay?.lines ?? []).filter(l => /^..action\s/.test(l)).map(l => l.replace(/^..action\s+/, '').replace(/\s{2}.*$/, ''));

(async () => {
  tui.runTui(core, ['--session', 'claude-conversation', '--no-server'], () => 'claude-conversation');
  await wait(200);
  if (check === 'overlay-verbs') {
    // With the help or the go-to-file list open, a letter is the overlay's: it never keeps, undoes or re-sorts
    // the review behind it.
    await toReview();
    await key('?');
    assert.ok(state.overlay, 'control: the help is open');
    await key('u'); await key('a'); await key('s'); await wait();
    assert.deepEqual(mutations, []);
    assert.equal(saves.filter(p => p.sort).length, 0, 'no sort saved');
    const scroll = state.overlay.scroll;
    await key('\x1b[B');
    assert.ok(state.overlay && state.overlay.scroll > scroll, 'the arrows still scroll it');
    const cursor = state.cursor;
    await key('G');
    assert.ok(state.overlay.scroll > scroll + 1, 'G scrolls the help to its end');
    assert.equal(state.cursor, cursor, 'the review behind it did not move');
    await key('?');
    assert.equal(state.overlay, null);
    await key('P');
    assert.ok(state.overlay, 'control: the go-to-file list is open');
    await key('a'); await wait();
    assert.deepEqual(mutations, []);
    await key('\x1b');
    assert.equal(state.overlay, null);
    await key('u'); await wait();
    assert.deepEqual(mutations, [{ verb: 'undo', ids: [7] }], 'control: with nothing open, u undoes the edit');
  } else if (check === 'overlay-rebind') {
    // A verb rebound to a scrolling letter (here undo on k) still never acts behind an overlay.
    await toReview();
    await key('?');
    await key('\x1b[B'); await key('\x1b[B');
    const down = state.overlay.scroll;
    await key('k'); await wait();
    assert.ok(state.overlay, 'the help is still open');
    assert.equal(state.overlay.scroll, down - 1, 'k scrolls the help up');
    assert.deepEqual(mutations, []);
    await key('?');
    await key('k'); await wait();
    assert.deepEqual(mutations, [{ verb: 'undo', ids: [7] }], 'control: the rebind is live');
  } else if (check === 'row-menu-key') {
    // The row menu prints each row's key: pressing one chooses that row, as Enter does.
    await toReview();
    const y = lastFrame.findIndex(l => l.includes('a.ts'));
    assert.ok(y >= 0, 'control: the row is on screen');
    const x = lastFrame[y].indexOf('a.ts') + 1;
    const menu = async () => { await key(`\x1b[<2;${x};${y + 1}M`); await key(`\x1b[<2;${x};${y + 1}m`); assert.match(state.overlay?.title ?? '', /this row/); };
    // q and ? close it, acting on nothing, and ? does not open the help.
    for (const closer of ['q', '?']) {
      await menu();
      await key(closer); await wait();
      assert.equal(state.overlay, null, `${closer} closes the menu`);
      assert.deepEqual(mutations, []);
    }
    await menu();
    await key('a'); await wait();
    assert.equal(state.overlay, null);
    assert.deepEqual(mutations, [{ verb: 'keep', ids: [7] }]);
  } else if (check === 'row-menu-rebind') {
    // A printed key chooses its own row (not the highlighted one) even when it is a key that scrolls or closes:
    // here undo rebound to k, on the menu's second row, and keep rebound to q.
    await toReview();
    const y = lastFrame.findIndex(l => l.includes('a.ts'));
    const x = lastFrame[y].indexOf('a.ts') + 1;
    const menu = async () => { await key(`\x1b[<2;${x};${y + 1}M`); await key(`\x1b[<2;${x};${y + 1}m`); assert.match(state.overlay?.title ?? '', /this row/); };
    await menu();
    assert.ok(state.overlay.lines.some(l => /^\s*k\s+Undo/.test(l)) && state.overlay.lines.some(l => /^\s*q\s+Keep/.test(l)), JSON.stringify(state.overlay.lines));
    await key('\x1bk'); await wait();
    assert.match(state.overlay?.title ?? '', /this row/, 'an alt chord chooses nothing');
    assert.deepEqual(mutations, []);
    await key('k'); await wait();
    assert.equal(state.overlay, null);
    assert.deepEqual(mutations, [{ verb: 'undo', ids: [7] }]);
    await menu();
    await key('q'); await wait();
    assert.deepEqual(mutations, [{ verb: 'undo', ids: [7] }, { verb: 'keep', ids: [7] }]);
  } else if (check === 'row-menu-unbound') {
    // keep rebound to u leaves undo without a key: the menu offers no row for it, rather than a '?' that
    // opened the help.
    await toReview();
    const y = lastFrame.findIndex(l => l.includes('a.ts'));
    const x = lastFrame[y].indexOf('a.ts') + 1;
    await key(`\x1b[<2;${x};${y + 1}M`); await key(`\x1b[<2;${x};${y + 1}m`);
    assert.ok(state.overlay.lines.some(l => /^\s*u\s+Keep/.test(l)), 'control: keep is on u');
    assert.ok(!state.overlay.lines.some(l => /Undo/.test(l)), JSON.stringify(state.overlay.lines));
    await key('?'); await wait();
    assert.equal(state.overlay, null, '? closes the menu');
    assert.deepEqual(mutations, []);
  } else if (check === 'search-under-overlay') {
    // A conversation search answered while the reader has another overlay open leaves that overlay alone: the
    // go-to-file list stays, and Enter still jumps.
    await toReview();
    await key('\x0f'); for (const c of 'zzq') await key(c); await key('\r');
    assert.match(state.overlay?.title ?? '', /searching/, 'control: the search is running');
    await key('\x1b');
    await key('P');
    assert.match(state.overlay?.title ?? '', /go to file/);
    releaseSearch(JSON.stringify({ hits: [] })); await wait(150);
    assert.match(state.overlay?.title ?? '', /go to file/, 'the answer did not take the list down');
    assert.match(state.status, /search for “zzq” finished/);
    await key('\r'); await wait();
    assert.equal(state.overlay, null);
    assert.equal(state.panes?.focus, 'traces', 'Enter jumped to the file');
    assert.deepEqual(mutations, []);
  } else if (check === 'search-help-filter') {
    // …and the help's own filter with it: closing the help ends its filter, so the next overlay's keys are its own.
    await toReview();
    await key('\x0f'); for (const c of 'zzq') await key(c); await key('\r');
    await key('\x1b');
    await key('?'); await key('/');
    assert.match(state.overlay?.title ?? '', /filters/, 'control: the help search is engaged');
    releaseSearch(JSON.stringify({ hits: [] })); await wait(150);
    assert.match(state.overlay?.title ?? '', /filters/, 'the answer did not take the help down');
    await key('\x1b'); await key('\x1b');
    assert.equal(state.overlay, null);
    const y = lastFrame.findIndex(l => l.includes('a.ts'));
    const x = lastFrame[y].indexOf('a.ts') + 1;
    await key(`\x1b[<2;${x};${y + 1}M`); await key(`\x1b[<2;${x};${y + 1}m`);
    await key('a'); await wait();
    assert.deepEqual(mutations, [{ verb: 'keep', ids: [7] }]);
  } else if (check === 'stale-row-menu') {
    // A command's answer that lands over the row menu leaves none of the menu's keys live.
    await toReview();
    await key(':'); for (const c of 'status') await key(c); await key('\r');
    const y = lastFrame.findIndex(l => l.includes('a.ts'));
    const x = lastFrame[y].indexOf('a.ts') + 1;
    await key(`\x1b[<2;${x};${y + 1}M`); await key(`\x1b[<2;${x};${y + 1}m`);
    assert.match(state.overlay?.title ?? '', /this row/, 'control: the menu is open while the command runs');
    releaseStatus(Array.from({ length: 80 }, (_, i) => `status line ${i}`).join('\n')); await wait(150);
    assert.match(state.overlay?.title ?? '', /^status/, 'control: the answer replaced the menu');
    await key('a'); await key('u'); await wait();
    assert.deepEqual(mutations, []);
    assert.match(state.overlay?.title ?? '', /^status/);
  } else if (check === 'esc-picker-delete') {
    // Esc under the session picker's delete question puts the picker back and deletes nothing.
    await toReview();
    await key('b');
    const picker = state.overlay?.title ?? '';
    assert.ok(picker, 'control: the picker is open');
    await key('\x04');
    assert.equal(state.confirm?.verb, 'delete');
    await key('\x1b');
    assert.equal(state.confirm, null);
    assert.equal(state.overlay?.title, picker, 'the picker is back');
    await key('y'); await wait();
    assert.deepEqual(deleted, []);
  } else if (check === 'alt-verb') {
    // alt+u (or esc then u typed quickly, which decodes the same) is not u.
    await toReview();
    await key('\x1bu'); await wait();
    assert.deepEqual(mutations, []);
    await key('u'); await wait();
    assert.deepEqual(mutations, [{ verb: 'undo', ids: [7] }], 'control: a plain u undoes the edit');
  } else if (check === 'herdr-leader') {
    // ctrl+a ctrl+a sends ctrl+a to the program; ctrl+a ctrl+k (readline's line start, kill line) kills nothing.
    // Off the herdr tab the refusal names no pass-through: there is no program to send it to.
    await key('\x01'); await key('\x0b');
    assert.equal(state.status, 'ctrl+a takes a plain key next');
    await key('\x01' + '1'); await wait(200);
    assert.equal(tab(), 'herdr');
    const client = spawns[0].client;
    bytes.length = 0;
    await key('\x01'); await key('\x01');
    assert.deepEqual(bytes, ['01']);
    bytes.length = 0;
    await key('\x01'); await key('\x0b');
    assert.equal(client.ended, false, 'the herdr client is still running');
    assert.deepEqual(bytes, []);
    assert.match(state.status, /ctrl\+a ctrl\+a sends ctrl\+a/);
    // …and neither do alt+k, or ctrl+k as the kitty keyboard protocol reports it.
    for (const chord of ['\x1bk', '\x1b[107;5u']) {
      await key('\x01'); await key(chord);
      assert.equal(client.ended, false, `the herdr client survives ctrl+a ${JSON.stringify(chord)}`);
    }
    assert.deepEqual(bytes, []);
    await key('\x01'); await key('k');
    assert.equal(client.ended, true, 'control: ctrl+a then a plain k still ends it');
  } else if (check === 'palette-tabs') {
    // The palette offers Review's verbs only on Review: on the Observatory its keys mean resolve and stop.
    await key('\x0f');
    assert.ok(state.overlay, 'control: the palette is open on the Observatory');
    assert.deepEqual(actions().sort(), ['Browse sessions', 'Filter', 'Keys', 'Options']);
    await key('\x1b');
    await toReview();
    await key('\x0f');
    assert.ok(actions().includes('Keep the selection') && actions().includes('Mark the row for a bulk keep or undo'), JSON.stringify(actions()));
  } else if (check === 'esc-confirm') {
    // Esc answers a standing question first, whatever else is selected.
    await key('\x1b[B');
    assert.ok(state.scopeWorker, 'control: a session is selected');
    await key('x');
    assert.match(state.confirm?.label ?? '', /stop the running agent/);
    await key('\x1b');
    assert.equal(state.confirm, null);
    assert.equal(state.status, 'cancelled');
    assert.ok(state.scopeWorker, 'the selection stays');
  } else throw new Error(`unknown check ${check}`);
  fs.writeSync(2, `PASS: ${check}\n`);
  process.emit('exit', 0);
  process.chdir(os.tmpdir());
  fs.rmSync(home, { recursive: true, force: true });
  exit(0);
})().catch(error => { fs.writeSync(2, (error && error.stack) + '\n'); try { process.chdir(os.tmpdir()); fs.rmSync(home, { recursive: true, force: true }); } catch {} exit(1); });
