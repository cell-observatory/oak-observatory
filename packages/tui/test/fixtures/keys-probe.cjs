// Keys that must not act by accident, driven through the INTERACTIVE app: real key bytes in, the backend's
// mutations, the bytes sent to the herdr client, the palette and the confirm out. The core is the real one
// with herdr, the CLI children and prefs writes faked. `OAK_KEYS_CHECK` picks the scenario; prints `PASS: <check>`.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const repo = path.resolve(__dirname, '../../../..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-keys-'));
process.env.HOME = home; process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude'); process.env.CODEX_HOME = path.join(home, '.codex');
for (const key of ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_ENV', 'HERDR_BIN_PATH', 'HERDR_SESSION', 'HERDR_CONFIG_PATH', 'TMUX']) delete process.env[key];
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
const spawns = [], bytes = [], saves = [], mutations = [], ran = [];
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
  run: (args) => (ran.push(args), check === 'stale-row-menu' && args[0] === 'status' ? new Promise(resolve => { releaseStatus = resolve; })
    : check.startsWith('search-') && args[0] === 'search' ? new Promise(resolve => { releaseSearch = resolve; }) : Promise.resolve('{}')) });
const rebind = process.env.OAK_KEYS_REBIND ? JSON.parse(process.env.OAK_KEYS_REBIND) : undefined;
// `rebind-blocked-first-run`: a machine with no agent session yet, in a terminal 100 columns wide.
const firstRun = check === 'rebind-blocked-first-run' || check === 'kept-prefs-first-run' || check === 'kept-prefs-blocked';
const deleted = [], swept = [];
let keptTaken = 0; // how often the app took the restore notice (`kept-prefs-…`), which is said once wherever it is taken
let keptUpkeep = 0; // and how often it asked core to write back what an older OAK dropped (keptPrefs(true))
// The refresh's ignore sweep: how many recorded edits it would drop, and each sweep that ran.
let wouldDrop = Number(process.env.OAK_KEYS_WOULD_DROP || 0);
// herdr's own config, when a check names one: the prefix OAK listens on and the keys herdr binds after it.
if (process.env.OAK_KEYS_HERDR_CONFIG) {
  fs.mkdirSync(path.join(home, '.config', 'herdr'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'herdr', 'config.toml'), process.env.OAK_KEYS_HERDR_CONFIG);
}
// The rebinds go through the real reader, as a prefs file holds them (a reserved key is kept aside there).
const prefsFile = path.join(home, 'prefs.json');
if (rebind) fs.writeFileSync(prefsFile, JSON.stringify({ keys: rebind }));
// What prefs.json is given after the app read it (another writer, while the app runs), and the moves the Store row made.
let given = {};
const moves = [];
const core = { ...realCore, readPrefs: () => ({ color: 'none', glyphs: 'ascii', layout: { active: 'observatory' }, ...(rebind ? realCore.readPrefs(prefsFile) : {}), ...given }), writePrefs: p => saves.push(p),
  // Recorded in prefs.json by the move itself, as core's records it while captures wait for it.
  moveStore: (to) => { moves.push(to); if (to === path.join(home, '.claude', 'claude-observatory')) delete given.storeDir; else given.storeDir = to; return { moved: true, from: '/moved/elsewhere', to }; },
  findHerdrBin: () => '/fake/herdr', startAgentSession: () => { throw Error('no agents'); },
  deleteSession: (id) => deleted.push(id), sessionWorkspace: () => home, defaultTuiSession: () => (firstRun ? null : 'claude-conversation'), announceAttention() {},
  connectDaemon: async () => null, ensureDaemon: async () => ({ client: null, why: 'probe' }),
  dueRemoteUsageGather: () => false, dueAccountUsagePull: () => false, kickMonthRefresh() {}, usageLine: () => null, usageBrief: () => null,
  siblingOverviewCached: () => null, subagentDigests: () => [], findAgentPid: () => null,
  countIgnored: () => wouldDrop, dropIgnored: (session) => { swept.push(session); const dropped = wouldDrop; wouldDrop = 0; return { dropped, files: [] }; },
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
  // `kept-prefs-first-run`: oak sync's settings were put back in prefs.json from its copy, not said yet (core keptPrefs).
  ...(check.startsWith('kept-prefs-') ? { keptPrefs: (upkeep) => ((keptUpkeep += upkeep === true ? 1 : 0), {}), takeKeptPrefsNotice: () => (keptTaken++ ? null : 'prefs.json had lost oak sync\'s settings, so OAK put them back from oak sync\'s copy') } : {}),
};
Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
process.stdin.setRawMode = () => {};
Object.defineProperty(process.stdout, 'columns', { value: firstRun ? 100 : 140, configurable: true });
Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
process.stdout._refreshSize = () => {};
process.stdout.write = () => true;
const exit = process.exit.bind(process);
process.exit = () => {}; // a quit the probe presses must not end it
const wait = (ms = 90) => new Promise(resolve => setTimeout(resolve, ms));
const key = async text => { process.stdin.emit('data', Buffer.from(text)); await wait(); if (text === '\x1b') await wait(); };
const tab = () => state.tabs[state.activeTab].id;
// alt+3: the third tab. (Tab from the Observatory reaches it too.)
const toReview = async () => { await key('\x1b3'); await wait(200); assert.equal(tab(), 'review'); };
const actions = () => (state.overlay?.lines ?? []).filter(l => /^..action\s/.test(l)).map(l => l.replace(/^..action\s+/, '').replace(/\s{2}.*$/, ''));

(async () => {
  tui.runTui(core, firstRun ? ['--no-server'] : ['--session', 'claude-conversation', '--no-server'], () => (firstRun ? '' : 'claude-conversation'));
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
    await key(':'); for (const c of 'zzq') await key(c); await key('\r');
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
    await key(':'); for (const c of 'zzq') await key(c); await key('\r');
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
  } else if (check === 'herdr-prefix') {
    // OAK has no leader: ctrl+a is the program's. On the herdr tab OAK listens on herdr's own prefix, and
    // takes only m, M and V, and its tab keys, after it; every other key after the prefix, and the prefix twice, is herdr's.
    await key('\x1b1'); await wait(200);
    assert.equal(tab(), 'herdr', 'alt+1 reaches the herdr tab');
    const client = spawns[0].client;
    bytes.length = 0;
    await key('\x01');
    assert.deepEqual(bytes, ['01'], 'ctrl+a goes straight to the program');
    bytes.length = 0;
    await key('\x02');
    assert.deepEqual(bytes, [], 'the prefix waits for the key after it');
    assert.match(state.status, /ctrl\+b — m OAK tabs · M Observatory · V Review · F1–F3/);
    await key('n');
    assert.deepEqual(bytes, ['02', '6e'], "a key herdr binds goes to herdr behind its prefix");
    bytes.length = 0;
    await key('\x02'); await key('\x02');
    assert.deepEqual(bytes, ['02', '02'], 'the prefix twice is herdr’s literal prefix');
    bytes.length = 0;
    // The prefix as the kitty keyboard protocol reports it, with its release before the next key.
    await key('\x1b[98;5u'); await key('\x1b[98;5:3u'); await key('q');
    assert.equal(Buffer.from(bytes.join(''), 'hex').toString(), '\x1b[98;5u\x1b[98;5:3uq', 'herdr gets the prefix, its release and q, unchanged');
    assert.equal(client.ended, false);
    bytes.length = 0;
    // ctrl+shift+b is not ctrl+b to herdr (0.9.1 and 0.9.3), and not to OAK: it and the m after it are the program's.
    await key('\x1b[98;6u'); await key('m');
    assert.equal(tab(), 'herdr');
    assert.equal(Buffer.from(bytes.join(''), 'hex').toString(), '\x1b[98;6um');
    bytes.length = 0;
    await key('\x02'); await key('m');
    assert.equal(tab(), 'observatory', 'the prefix then m goes back to the OAK tab last used');
    assert.deepEqual(bytes, [], 'and herdr sees neither key');
    await key('\x1b3'); await key('\x1b1'); await key('\x02'); await key('m');
    assert.equal(tab(), 'review', '…which is Review when Review was last');
    await key('\x1b1'); bytes.length = 0;
    await key('\x02'); await key('M'); await wait(150);
    assert.equal(tab(), 'observatory', 'the prefix then M pins herdr’s focused session');
    assert.ok(state.observatory.details['obs-detail'], 'a conversation is pinned');
    assert.deepEqual(bytes, []);
    // Off the herdr tab ctrl+a and ctrl+b are not a leader: ctrl+a does nothing, ctrl+b pages.
    const before = state.status;
    await key('\x01'); await key('1');
    assert.equal(tab(), 'observatory', 'ctrl+a then 1 does not switch tabs');
    assert.equal(state.status, before);
  } else if (check === 'herdr-prefix-config') {
    // herdr's config wins: its prefix is the one OAK listens on, and a key the reader bound after it is herdr's.
    await key('\x1b1'); await wait(200);
    bytes.length = 0;
    await key('\x02');
    assert.deepEqual(bytes, ['02'], 'ctrl+b is an ordinary key when herdr’s prefix is ctrl+g');
    bytes.length = 0;
    await key('\x07');
    assert.deepEqual(bytes, [], 'ctrl+g is held');
    await key('m');
    assert.deepEqual(bytes, ['07', '6d'], 'm is herdr’s: the config binds prefix+m');
    assert.equal(tab(), 'herdr');
    bytes.length = 0;
    await key('\x07'); await key('M');
    assert.deepEqual(bytes, [], 'M is still OAK’s');
    await wait(150);
    assert.equal(tab(), 'observatory');
  } else if (check === 'herdr-prefix-motion') {
    // The pointer moving, the wheel or a focus change between the prefix and m decide nothing: they reach
    // herdr, the prefix stays held, and m still goes back to OAK's tabs.
    await key('\x1b1'); await wait(200);
    bytes.length = 0;
    await key('\x02');
    const motion = ['\x1b[<35;20;10M', '\x1b[<65;20;10M', '\x1b[O', '\x1b[I'];
    for (const m of motion) await key(m);
    // Each reaches herdr (the pointer's row moved to the pane's own), and the prefix is still held.
    assert.equal(bytes.length, motion.length, `${bytes}`);
    assert.deepEqual(bytes.slice(2), ['1b5b4f', '1b5b49']);
    assert.ok(bytes.slice(0, 2).every(b => b.startsWith('1b5b3c')), `${bytes}`);
    await key('m');
    assert.equal(tab(), 'observatory', 'm after the motion goes back to the OAK tab');
    assert.equal(Buffer.from(bytes.join(''), 'hex').toString().includes('m'), false, 'herdr never saw m');
    // A click decides: the prefix goes to herdr ahead of it.
    await key('\x1b1'); await wait(200); bytes.length = 0;
    await key('\x02'); await key('\x1b[<0;20;10M');
    assert.equal(bytes[0], '02', `a click releases the prefix to herdr first: ${bytes}`);
  } else if (check === 'herdr-prefix-legacy') {
    // Without the kitty protocol ctrl+space is NUL, which the decoder names ctrl+`: the prefix still matches.
    await key('\x1b1'); await wait(200);
    bytes.length = 0;
    await key('\x00');
    assert.deepEqual(bytes, [], 'ctrl+space is held as the prefix');
    assert.match(state.status, /ctrl\+space — m OAK tabs/);
    await key('m');
    assert.equal(tab(), 'observatory');
    assert.deepEqual(bytes, []);
  } else if (check === 'herdr-prefix-none') {
    // A super chord reaches the app only through the kitty keyboard protocol, so the key row offers no key back and says to
    // click the tab bar. herdr takes kitty's super+b (98;9u) as its prefix, and so does OAK: m after it goes to OAK's tabs.
    await key('\x1b1'); await wait(200);
    assert.equal(state.herdrBack, null);
    const prefix = process.platform === 'darwin' ? 'cmd' : 'super';
    assert.match(lastFrame.join('\n'), new RegExp(`${prefix}\\+b is herdr's prefix · click OAK's tab bar to leave`));
    bytes.length = 0;
    await key('\x1b[98;9u');
    assert.deepEqual(bytes, [], 'super+b is held as the prefix');
    assert.match(state.status, new RegExp(`^${prefix}\\+b — m OAK tabs`));
    await key('m');
    assert.equal(tab(), 'observatory');
    assert.deepEqual(bytes, []);
  } else if (check === 'herdr-prefix-upper') {
    // herdr reads `Ctrl+A` as ctrl+shift+a, which the kitty keyboard protocol reports as `a` with shift (97;6u) or as `A`
    // (65;5u, 65;6u). Without the protocol it is 0x01, the byte of ctrl+a, which herdr does not take for its prefix: OAK
    // cannot tell the two apart there, so its key row names no key back, as for a prefix it cannot follow at all.
    await key('\x1b1'); await wait(200);
    assert.equal(state.herdrBack, null);
    assert.match(lastFrame.join('\n'), /ctrl\+shift\+a is herdr's prefix · click OAK's tab bar to leave/, 'named as herdr names it');
    // ctrl+a, from either kind of terminal, is the program's: it and the m after it go on unchanged.
    for (const ctrlA of ['\x01', '\x1b[97;5u']) {
      bytes.length = 0;
      await key(ctrlA); await key('m');
      assert.equal(tab(), 'herdr', JSON.stringify(ctrlA));
      assert.equal(Buffer.from(bytes.join(''), 'hex').toString(), `${ctrlA}m`, JSON.stringify(ctrlA));
    }
    // ctrl+shift+a as the protocol reports it is the prefix, as herdr takes it.
    for (const prefix of ['\x1b[97;6u', '\x1b[65;5u', '\x1b[65;6u']) {
      await key('\x1b1'); await wait(200);
      bytes.length = 0;
      await key(prefix);
      assert.deepEqual(bytes, [], `${JSON.stringify(prefix)} is held as the prefix`);
      assert.match(state.status, /^ctrl\+shift\+a — m OAK tabs/);
      await key('m');
      assert.equal(tab(), 'observatory', JSON.stringify(prefix));
      assert.deepEqual(bytes, []);
    }
  } else if (check === 'herdr-prefix-kitty-shift') {
    // kitty's report-all-keys flag sends shift on its own before M: that is still the prefix being pressed.
    await key('\x1b1'); await wait(200);
    bytes.length = 0;
    await key('\x1b[98;5u'); await key('\x1b[98;5:3u'); await key('\x1b[57441;2u'); await key('\x1b[109:77;2u'); await wait(150);
    assert.equal(tab(), 'observatory', 'the prefix, shift, then M pins herdr’s focused session');
    assert.deepEqual(bytes, [], 'herdr sees none of it');
    // The right shift key too.
    await key('\x1b1'); await wait(200);
    await key('\x1b[98;5u'); await key('\x1b[57447;2u'); await key('\x1b[109:77;2u'); await wait(150);
    assert.equal(tab(), 'observatory');
    assert.deepEqual(bytes, []);
  } else if (check === 'herdr-prefix-ctrl-q') {
    // herdr's prefix set to ctrl+q: pressed twice it is herdr's literal prefix, never OAK's quit.
    await key('\x1b1'); await wait(200);
    bytes.length = 0;
    await key('\x11'); await key('\x11');
    assert.deepEqual(bytes, ['11', '11'], 'herdr gets its prefix twice');
    assert.doesNotMatch(state.status, /again to exit/, 'no quit is armed');
    await key('\x11');
    assert.deepEqual(bytes, ['11', '11'], 'a third press is the prefix again');
    assert.match(lastFrame.join('\n'), /quit on OAK's tabs/, 'the hint says where quit is');
  } else if (check === 'herdr-prefix-switch') {
    // A prefix held when the tab changes under it (herdr's client exits) is not carried back to the new client.
    await key('\x1b1'); await wait(900);
    await key('\x02');
    spawns[0].client.ended = true; spawns[0].client.exit(0); await wait();
    assert.equal(tab(), 'observatory', 'control: the exit went back to the Observatory');
    await key('\x1b1'); await wait(200);
    assert.equal(spawns.length, 2, 'control: a new herdr client');
    bytes.length = 0;
    await key('n');
    assert.deepEqual(bytes, ['6e'], 'n alone reaches the new client');
  } else if (check === 'obs-jk') {
    // j and k move through the Observatory's sessions as ↓ and ↑ do.
    await key('\x1b[B');
    const down = state.scopeWorker?.session;
    assert.ok(down, 'control: ↓ selects a session');
    await key('\x1b[B');
    const second = state.scopeWorker?.session;
    await key('k');
    assert.equal(state.scopeWorker?.session, down, 'k moves up');
    await key('j');
    assert.equal(state.scopeWorker?.session, second, 'j moves down');
  } else if (check === 'confirm-tab-note') {
    // A tab switch under the resolve or stop question names the question, not a keep/undo.
    await key('\x1b[B'); await key('X');
    assert.equal(state.confirm?.verb, 'kill');
    const x = lastFrame[0].indexOf('review') + 1;
    assert.ok(x > 0, `control: the tab bar names Review: ${lastFrame[0]}`);
    await key(`\x1b[<0;${x};1M`); await key(`\x1b[<0;${x};1m`);
    assert.equal(tab(), 'observatory', 'the question keeps the tab');
    assert.match(state.status, /answer the pending question first/);
  } else if (check === 'rebind-blocked') {
    // A rebind an older build saved onto a key now reserved (keep on c) is not live, is written back rather
    // than deleted, is said once, and the Options row names it.
    assert.equal(state.status, 'Options (o): choose another key for Keep the selection — the frame now keeps your saved c');
    await toReview();
    const saved = saves.at(-1);
    assert.ok(saved, 'control: the tab switch saved the layout');
    const out = path.join(home, 'saved.json');
    realCore.writePrefs(saved, out);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')).keys, { keep: 'c' }, 'the saved key survives the write');
    await key('a'); await wait();
    assert.deepEqual(mutations, [{ verb: 'keep', ids: [7] }], 'a, the default, keeps meanwhile');
    await key('o');
    for (let i = 0; i < 80 && !lastFrame.some(l => /^ {2}[^ ] Keep the selection/.test(l)); i++) await key('\x1b[B');
    assert.match(lastFrame.join('\n'), /your saved key c is now kept for the frame itself, so a runs this/);
  } else if (check === 'rebind-blocked-first-run') {
    // What to do comes first and the row holds it whole at 100 columns; a first run's own status, set on
    // every read, does not replace it.
    const notice = 'Options (o): choose another key for Keep the selection — the frame now keeps your saved space';
    await wait(300);
    assert.equal(state.status, notice);
    assert.ok(lastFrame.some(l => l.trimEnd() === notice), lastFrame.join('\n'));
  } else if (check === 'kept-prefs-first-run') {
    // oak sync's settings put back from its copy: said on the first status row, what to do first; a first run's own
    // status, set on every read, does not replace it.
    await wait(300);
    assert.match(state.status, /^Quit or update that older OAK \(`oak doctor` says where it may be running\): prefs\.json had lost oak sync's settings/);
    assert.ok(lastFrame.some(l => l.startsWith('Quit or update that older OAK')), lastFrame.join('\n'));
    assert.ok(keptUpkeep > 0, 'the launch wrote back what an older OAK dropped, which is what it says');
  } else if (check === 'kept-prefs-blocked') {
    // A rebind to ask about takes the first status row: the restore is left untaken, for the next `oak` command run in a
    // terminal to say (and `oak doctor`).
    await wait(300);
    assert.equal(state.status, 'Options (o): choose another key for Keep the selection — the frame now keeps your saved space');
    assert.equal(keptTaken, 0, 'the restore is not taken where it is not shown');
    assert.ok(keptUpkeep > 0, 'though the launch wrote back what an older OAK dropped');
  } else if (check === 'palette-unbound') {
    // redo rebound onto D leaves undo-all with no key: its palette row still runs it (it asks first), where
    // it pressed '?' and opened the help.
    await toReview();
    await key(':'); for (const c of 'Undo everything') await key(c);
    assert.match(state.overlay.lines[0], /Undo everything listed/);
    await key('\r'); await wait();
    assert.equal(state.confirm?.verb, 'undo', 'the row asks to undo everything listed');
    assert.doesNotMatch(state.overlay?.title ?? '', /^keys/, 'not the help');
  } else if (check === 'palette-unbound-obs') {
    // The same on the Observatory: session rebound onto r leaves Refresh with no key, and its row still runs it.
    assert.equal(tab(), 'observatory');
    await key(':'); for (const c of 'Refresh') await key(c);
    assert.match(state.overlay.lines[0], /Refresh/);
    await key('\r'); await wait();
    assert.equal(state.confirm?.verb, 'refresh', 'the row refreshes, asking first to drop what .observatoryignore covers');
  } else if (check === 'tab-keys') {
    // Tab and shift+Tab switch OAK tabs; ctrl+n and ctrl+p too, even from the reply box.
    await key('\t'); await wait(200);
    assert.equal(tab(), 'review');
    await key('\x1b[Z'); await wait(200);
    assert.equal(tab(), 'observatory', 'shift+Tab goes back');
    await key('\x1b[B'); await key('\x1b[B'); await key('d'); await key('\x1b[C'); await key('c');
    assert.equal(state.observatory.details['obs-detail'].reply.focused, true, 'control: the reply box has the keys');
    await key('\t');
    assert.equal(tab(), 'observatory', 'Tab is the reply box’s');
    await key('\x0e'); await wait(200);
    assert.equal(tab(), 'review', 'ctrl+n leaves the reply box for the next tab');
  } else if (check === 'obs-keys') {
    // No letter means one thing on Review and another here: a and x (keep and mark on Review) do nothing,
    // and neither do Review's other verbs; R and X resolve and stop, each asking first.
    await key('\x1b[B');
    assert.ok(state.scopeWorker, 'control: a session is selected');
    const reviewPanes = JSON.stringify(state.tabs.find(t => t.id === 'review').panes ?? null);
    for (const k of ['a', 'x', 'u', 'U', 'A', 'D', 'm', 'n', 'p', 'w', 'e', 's', '1', '2', '\\']) {
      await key(k);
      assert.equal(state.confirm, null, `${k} asks nothing here`);
    }
    assert.equal(state.goto ?? null, null, 'digits name no edit here');
    assert.equal(state.overlay?.title?.includes('needs you') ? 'inbox' : null, null);
    assert.deepEqual(mutations, []);
    assert.equal(JSON.stringify(state.tabs.find(t => t.id === 'review').panes ?? null), reviewPanes, 'Review’s windows did not move');
    await key('R');
    assert.equal(state.confirm?.verb, 'resolve');
    assert.match(state.confirm.label, /accept every pending edit in .* and clear its store/);
    await key('\x1b');
    assert.equal(state.confirm, null);
    assert.equal(state.status, 'cancelled');
    await key('X');
    assert.equal(state.confirm?.verb, 'kill');
    assert.match(state.confirm.label, /stop the running agent/);
    await key('n');
    assert.equal(state.confirm, null);
    assert.deepEqual(mutations, [], 'nothing was resolved');
    await key('R'); await key('y'); await wait();
    assert.deepEqual(mutations, [{ verb: 'resolveAll' }], 'control: yes resolves');
  } else if (check === 'obs-buttons') {
    // The session's own buttons, beside ↗ herdr and ⌕ review: ⚑ resolve and ■ stop, each asking first.
    await key('\x1b[B'); await key('d');
    for (const [label, verb] of [['⚑ resolve', 'resolve'], ['■ stop', 'kill']]) {
      const y = lastFrame.findIndex(l => l.includes(label));
      assert.ok(y >= 0, `${label} is drawn:\n${lastFrame.join('\n')}`);
      const x = lastFrame[y].indexOf(label) + 1;
      await key(`\x1b[<0;${x};${y + 1}M`); await key(`\x1b[<0;${x};${y + 1}m`);
      assert.equal(state.confirm?.verb, verb, `${label} asks`);
      await key('\x1b');
      assert.equal(state.confirm, null);
    }
    assert.deepEqual(mutations, []);
  } else if (check === 'redo-key') {
    // U redoes the selection; ctrl+r does nothing; D asks to undo everything listed.
    await toReview();
    await key('\x12'); await wait();
    assert.deepEqual(mutations, [], 'ctrl+r does nothing on Review');
    await key('U'); await wait();
    assert.deepEqual(mutations, [{ verb: 'redo', ids: [7] }], 'U redoes the one edit at once');
    await key('D');
    assert.equal(state.confirm?.verb, 'undo', 'D asks first');
    await key('n');
    assert.deepEqual(mutations, [{ verb: 'redo', ids: [7] }]);
  } else if (check === 'palette-tabs') {
    // `:` is the palette and the command line: it lists the tab's actions, and a typed command runs.
    await key('\x0f');
    assert.equal(state.overlay, null, 'ctrl+o opens nothing');
    await key(':');
    assert.ok(state.overlay, 'control: the palette is open on the Observatory');
    const obs = actions();
    for (const want of ['Browse sessions', 'Filter', 'Keys', 'Options', 'Refresh', 'Resolve the session: keep its pending edits and clear its store', 'Close the focused pane'])
      assert.ok(obs.includes(want), `${want} is offered: ${JSON.stringify(obs)}`);
    assert.ok(!obs.includes('Keep the selection') && !obs.includes('Mark the row for a bulk keep or undo'), 'Review’s verbs are not');
    await key('\x1b');
    await toReview();
    await key(':');
    assert.ok(actions().includes('Keep the selection') && actions().includes('Redo the selection'), JSON.stringify(actions()));
    for (const c of 'version') await key(c);
    assert.match(state.overlay.lines[0], /command\s+version/, 'the typed command leads the list');
    await key('\r'); await wait();
    assert.equal(ran.at(-1)?.[0], 'version', 'Enter runs it');
  } else if (check === 'refresh-confirm') {
    // r asks first when the ignore sweep would drop records, and says how many; n refreshes and drops nothing.
    await toReview();
    await key('r');
    assert.equal(state.confirm?.verb, 'refresh');
    assert.match(state.confirm.label, /drop the 3 recorded edits/);
    assert.match(lastFrame.join('\n'), /refresh — drop the 3 recorded edits .*\[y\/n\]/, 'the question is on screen');
    await key('n');
    assert.deepEqual(swept, [], 'no sweep ran');
    assert.match(state.status, /kept the 3/);
    await key('r'); await key('y');
    assert.equal(swept.length, 1, 'yes sweeps');
    assert.match(state.status, /dropped 3 now-ignored edits/);
    await key('r');
    assert.equal(state.confirm, null, 'with nothing to drop it refreshes without asking');
    assert.equal(swept.length, 1);
  } else if (check === 'options-reset') {
    // Options → "Reset every option" asks first.
    await key('o');
    for (let i = 0; i < 40; i++) await key('\x1b[6~');
    await key('\r');
    assert.equal(state.confirm?.verb, 'reset');
    assert.match(lastFrame.join('\n'), /reset every option to its default.*\[y\/n\]/, 'the question is on screen');
    await key('\x1b');
    assert.equal(state.confirm, null);
    assert.equal(saves.filter(p => Object.keys(p).length === 0).length, 0, 'esc reset nothing');
    await key('\r'); await key('y');
    assert.equal(saves.filter(p => Object.keys(p).length === 0).length, 1, 'yes resets');
    await key('q');
    assert.equal(state.status, 'ready', 'q closes the options window');
  } else if (check === 'rebind-reserved') {
    // A Review verb cannot take a key the frame keeps for itself (here R, the Observatory's resolve).
    await key('o');
    const onKeep = () => lastFrame.some(l => /^ {2}[^ ] Keep the selection/.test(l));
    for (let i = 0; i < 80 && !onKeep(); i++) await key('\x1b[B');
    assert.ok(onKeep(), 'control: the cursor is on the Keep row');
    await key('\r'); await key('R');
    assert.match(state.status, /R is kept for the frame itself/);
    assert.equal(saves.length, 0, 'nothing was saved');
    await key('\r'); await key('k');
    assert.deepEqual(saves.at(-1)?.keys, { keep: 'k' }, 'control: an ordinary key is saved');
  } else if (check === 'filter-per-tab') {
    // A filter typed on one tab stays on that tab.
    await key('/'); for (const c of 'zz') await key(c); await key('\r');
    assert.equal(state.filter, 'zz');
    await toReview();
    assert.equal(state.filter, '', 'Review is not filtered by the Observatory’s filter');
    await key('\x1b2'); await wait(200);
    assert.equal(state.filter, 'zz', 'and the Observatory keeps its own');
  } else if (check === 'overlay-close') {
    // One rule for the list overlays: j/k move, esc or q closes, any other key is swallowed.
    await key('v');
    assert.match(state.overlay?.title ?? '', /what should this pane show/);
    const at = state.overlay.cursor;
    await key('j');
    assert.equal(state.overlay.cursor, at + 1, 'j moves');
    await key('x'); await key('a');
    assert.match(state.overlay?.title ?? '', /what should this pane show/, 'other keys are swallowed');
    await key('q');
    assert.equal(state.overlay, null, 'q closes');
  } else if (check === 'hints-rebind') {
    // The key row and the help name the reader's own keys.
    await toReview();
    const row = lastFrame[lastFrame.length - 1];
    assert.match(row, /\bk\/u\/U\b/, row);
    assert.doesNotMatch(row, /\ba\/u\b/);
    await key('?');
    const help = state.overlay.lines.join('\n');
    assert.match(help, /Keep \/ Undo {4}k \/ u/);
    assert.match(help, /^ {4}k {14}keep the selection/m);
  } else if (check === 'esc-confirm') {
    // Esc answers a standing question first, whatever else is selected.
    await key('\x1b[B');
    assert.ok(state.scopeWorker, 'control: a session is selected');
    await key('X');
    assert.match(state.confirm?.label ?? '', /stop the running agent/);
    await key('\x1b');
    assert.equal(state.confirm, null);
    assert.equal(state.status, 'cancelled');
    assert.ok(state.scopeWorker, 'the selection stays');
  } else if (check === 'store-back') {
    // `oak store --move` gave prefs.json a location after the app read its copy. Options → Store, left blank, moves the
    // store back to the default. The move records that itself, and the app saves nothing over it, then or at its next
    // save, although its copy never had the location.
    given = { storeDir: '/moved/elsewhere', billDay: 12 };
    await toReview();
    const before = saves.length;
    await key('o'); await key('\x1b[B'); await key('\r'); await key('\r');
    assert.deepEqual(moves, [path.join(home, '.claude', 'claude-observatory')], `control: the store moved back to the default (${state.status})`);
    assert.deepEqual(saves.slice(before), [], 'the app saves nothing of its own over what the move recorded');
    await key('\x1b'); await key('\x1b2'); await wait(200);
    assert.ok(saves.length > before, 'control: the tab switch saved the layout');
    assert.equal(saves.at(-1).storeDir, undefined, `prefs.json names no moved location: ${JSON.stringify(saves.at(-1))}`);
    assert.equal(saves.at(-1).billDay, 12, 'and keeps what else it was given');
  } else if (check === 'reset-keeps-elsewhere') {
    // Options → Reset every option resets what the app sets, and keeps what was set outside it: the bill day, and the
    // switches for claude.ai titles and the saved machines' usage, which a reset would otherwise turn back on.
    given = { billDay: 12, gptBillDay: 4, remoteTitles: false, machineUsage: false, theme: 'mono', sort: 'name', storeDir: '/moved/elsewhere' };
    await key('o');
    for (let i = 0; i < 40; i++) await key('\x1b[6~');
    await key('\r'); await key('y');
    assert.equal(state.status, 'every option is back to its default', 'control: the reset ran');
    assert.deepEqual(saves.at(-1), { billDay: 12, gptBillDay: 4, remoteTitles: false, machineUsage: false });
  } else throw new Error(`unknown check ${check}`);
  fs.writeSync(2, `PASS: ${check}\n`);
  process.emit('exit', 0);
  process.chdir(os.tmpdir());
  fs.rmSync(home, { recursive: true, force: true });
  exit(0);
})().catch(error => { fs.writeSync(2, (error && error.stack) + '\n'); try { process.chdir(os.tmpdir()); fs.rmSync(home, { recursive: true, force: true }); } catch {} exit(1); });
