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
const { fixture, pane } = require(repo + '/packages/tui/test/fixtures/observatory');
const data = fixture();
// A raised hand in this machine's catalog: its toast names the keys that act on it.
if (process.env.OAK_APP_FIX_CHECK?.startsWith('hand-')) data.views.sessions.sessions[1].attention = { kind: 'permission', message: 'Bash(npm test)', ts: Date.now() };
// The newest edit the listing counted this row's pending edits from: the delete confirmed from the row carries it.
if (process.env.OAK_APP_FIX_CHECK === 'delete') data.views.sessions.sessions[0].lastEdit = 7;
process.env.OAK_MACHINE_LABEL = 'workstation';
let lastFrame;
let state, spawns = [], bytes = [], saves = [], requests = [], notify, submit, focusRemote;
const prompts = [], forwarded = [], viewRequests = [], starts = [], deleted = [];
const check = process.env.OAK_APP_FIX_CHECK;
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
}
const transcript = path.join(home, 'fixture.jsonl'); fs.writeFileSync(transcript, '\n');
let refuseFocus = false;
const draw = frame.renderDashFrame;
frame.renderDashFrame = (s, ...rest) => { state = s; lastFrame = draw(s, ...rest); return lastFrame; };
native.nativeAvailable = () => true;
native.spawnNative = (...args) => {
  const client = { ended: false, label: 'herdr', pid: 123, resize() {}, grid: () => ['fake native herdr'],
    write: b => bytes.push(b.toString('hex')), close() { this.ended = true; }, onUpdate() {}, onExit(fn) { this.exit = fn; } };
  spawns.push({ args, client }); return client;
};
backend.createBackend = () => ({ close() {}, watcherMode: () => 'native', updateSkew: () => false,
  onData(fn) { notify = fn; }, request(names, session) { viewRequests.push(names); queueMicrotask(() => notify(data.views, null, Date.now(), session)); }, diff: async () => '' });
// Every interval the app starts, by its period: the poll's comes from `--tick` or the saved preference.
const intervals = [];
// A Claude Code session's identity in the app's own environment: the herdr tab's client must not carry it.
if (check === 'identity') Object.assign(process.env, { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'fixture-session', CLAUDE_CODE_USE_BEDROCK: '1' });
if (check?.startsWith('tick-')) { const every = global.setInterval; global.setInterval = (fn, ms, ...rest) => { intervals.push(ms); return every(fn, ms, ...rest); }; }
const core = { ...realCore, readPrefs: () => ({ color: 'none', glyphs: 'ascii', layout: { active: 'observatory' }, ...(check === 'tick-pref' ? { refreshSeconds: 5 } : {}) }), writePrefs: p => saves.push(p),
  findHerdrBin: () => check === 'fallback' ? null : '/fake/herdr',
  herdrInstallPath: (userHome, platform) => { assert.equal(userHome, os.homedir()); assert.equal(platform, process.platform); return '/fixture/herdr.exe'; },
  startAgentSession: (kind, cwd) => { starts.push({ kind, cwd }); throw Error('outer tabs must not start agents'); },
  deleteSession: (id, opts) => deleted.push([id, opts]), sessionWorkspace: () => home, defaultTuiSession: () => 'claude-conversation', announceAttention() {},
  connectDaemon: async () => null, ensureDaemon: async () => ({ client: null, why: 'disabled in probe' }),
  dueRemoteUsageGather: () => false, dueAccountUsagePull: () => false, kickMonthRefresh() {},
  usageLine: () => check !== 'usage' ? null : { usageFrom: 'claude', weekPct: 71, fablePct: 83, fableLabel: 'Fable', fableReset: null },
  usageBrief: () => check !== 'usage' ? null : { claude: { five: { pct: 12 }, week: { pct: 71 }, month: { pct: 50 } }, gpt: null },
  siblingOverviewCached: () => null, subagentDigests: () => [],
  spawnTool: (_command, args) => {
    const { EventEmitter } = require('events'), child = new EventEmitter(); child.stdout = new EventEmitter();
    child.kill = () => { child.killed = true; child.emit('close', null); };
    // The conversation reader's warm worker: with no stdin it takes no requests, and every read below runs cold.
    if (args[2] === '--serve') return child;
    if (args[1] === 'views') viewRequests.push(args[args.indexOf('--views') + 1].split(','));
    queueMicrotask(() => {
      if (child.killed) return;
      // A remote session's metadata comes from its own machine's catalog (`sessions --json --machine`).
      const machine = args.includes('--machine') ? data.observatory.machines.find(m => m.label === args[args.indexOf('--machine') + 1]) : null;
      const payload = args[1] === 'conversation' ? core.conversationEvents('claude-conversation')
        : args[1] === 'multitask' ? { agents: [] } : args[1] === 'subagents' ? { subagents: [] }
        : args[1] === 'sessions' && machine ? machine.sessions : data.views;
      child.stdout.emit('data', Buffer.from(JSON.stringify(payload))); child.emit('close', 0);
    });
    return child;
  },
  detectEditors: () => [], herdrSnapshot: async () => data.observatory.machines[0].snapshot,
  herdrMachines: async () => [{ id: 'build', label: 'build-box', enabled: true }],
  herdrOnMachine: async (label, argv) => {
    forwarded.push({ label, argv });
    if (argv[0] === 'api') return { result: { snapshot: data.observatory.machines[1].snapshot } };
    if (argv[1] === 'focus') return refuseFocus ? { error: { message: 'remote focus refused' } }
      : new Promise(resolve => { focusRemote = resolve; });
    return { result: { type: 'ok' } };
  },
  herdrAgent: { prompt: params => { prompts.push(params); return new Promise(resolve => { submit = resolve; }); } },
  herdrRequest: async (method, params) => { requests.push({method,params}); return { type: 'pane_current', pane: data.observatory.machines[0].snapshot.panes[0] }; },
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
/** The selection band in the last frame written, per 1-based row: its first and last column and its text. */
const bands = () => {
  const plain = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  const parts = (written.filter(w => w.startsWith('\x1b[?2026h')).at(-1) ?? '').split(/\x1b\[(\d+);1H\x1b\[K/);
  const out = {};
  for (let i = 1; i < parts.length; i += 2) {
    const line = parts[i + 1], open = line.indexOf('\x1b[7m');
    if (open < 0) continue;
    const text = plain(line.slice(open + 4, line.indexOf('\x1b[27m', open)));
    const from = textwidth.displayWidth(plain(line.slice(0, open))) + 1;
    out[Number(parts[i])] = { from, to: from + textwidth.displayWidth(text) - 1, text: text.trimEnd() };
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
    ...(check === 'tick-flag' ? ['--tick', '7'] : [])], () => 'claude-conversation');
  await wait();
  assert.equal(active(), 'observatory'); assert.equal(spawns.length, 0, 'lazy native startup');
  if (check) {
    if (check === 'once') {
      assert.deepEqual(viewRequests, [['sessions']]);
      assert.equal(state.observatory.details['obs-detail'].selection.session, 'claude-conversation');
      assert.match(lastFrame.join('\n'), /Fixture conversation/);
      assert.doesNotMatch(lastFrame.join('\n'), /Select a session/);
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
      await key('\x01'+'3');
      assert.ok(viewRequests.at(-1).includes('changemap'), 'Review still gets its map');
      await key('\x01'+'2'); assert.deepEqual(viewRequests.at(-1), ['sessions']);
      state.tabs[state.activeTab].root = tui.setPaneView(state.tabs[state.activeTab].root, 'obs-detail', 'processes');
      await key('\x01'+'3'); await key('\x01'+'2');
      assert.ok(viewRequests.at(-1).includes('processes'), 'a custom Observatory pane still gets the view it renders');
    } else if (check === 'fallback') {
      await key('\x01'+'1'); assert.equal(spawns[0].args[0], '/fixture/herdr.exe');
    } else if (check === 'identity') {
      // The herdr tab's client auto-starts herdr's server when none runs; a server born with a session's
      // identity hands it to every pane (only the server start was pinned).
      await key('\x01'+'1');
      const overlay = spawns[0].args[6];
      for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID']) assert.ok(k in overlay && overlay[k] === undefined, `${k} is removed from the client's environment`);
      assert.ok(!('CLAUDE_CODE_USE_BEDROCK' in overlay), 'a person\'s own setting still reaches it');
      assert.match(overlay.OAK_TAB, /^herdr@/);
    } else if (check === 'hand-observatory') {
      // The Observatory takes i (reply) and h (the selection's pane): its toast names Review's keys.
      assert.equal(active(), 'observatory');
      assert.match(state.toast?.text ?? '', /^Run checks needs your permission — Bash\(npm test\) · on Review, h jumps there · i lists every hand$/);
    } else if (check === 'tick-pref') {
      // The saved "Refresh every" was ignored at startup: the poll ran every 3 s.
      assert.ok(intervals.includes(5000), `the poll runs every 5 s: ${intervals}`);
    } else if (check === 'tick-flag') {
      assert.ok(intervals.includes(7000) && !intervals.includes(5000), `--tick 7 wins: ${intervals}`);
    } else if (check === 'launch-failed') {
      // herdr is not installed: the client's exec fails and it dies at once, leaving only node-pty's own
      // report on its screen.
      await key('\x01'+'1');
      Object.assign(spawns[0].client, { ended: true, grid: () => ['execvp(3) failed.: No such file or directory', ''] });
      spawns[0].client.exit(1); await wait();
      const screen = lastFrame.join('\n');
      assert.match(screen, /could not launch \/fake\/herdr — run oak doctor --fix/, 'the tab says what failed and what to do');
      assert.doesNotMatch(screen, /exited|execvp/);
      await key('\x01'+'2'); await key('\x01'+'1');
      assert.equal(spawns.length, 2, 'coming back to the tab tries again');
    } else if (check === 'launch-refused') {
      // herdr started, said why it would not run, and quit at once: its words stay on screen, not "could
      // not launch" (a generic note replaced them).
      await key('\x01'+'1');
      Object.assign(spawns[0].client, { ended: true, grid: () => ['herdr: the server speaks protocol 23; this client speaks 22 — upgrade herdr', ''] });
      spawns[0].client.exit(3); await wait();
      const screen = lastFrame.join('\n');
      assert.match(screen, /herdr: the server speaks protocol 23; this client speaks 22 — upgrade herdr/, "herdr's own reason is on screen");
      assert.match(screen, /herdr exited — ctrl\+a then n\/p leaves/);
      assert.doesNotMatch(screen, /could not launch/);
      await key('\x01'+'2'); await key('\x01'+'1');
      assert.equal(spawns.length, 2, 'coming back to the tab tries again');
    } else if (check === 'native-mouse') {
      await key('\x011');
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
      // The account reports its per-model weekly cap; the bottom line still reads 5h · wk · mo.
      assert.equal(state.usage.fablePct, 83, 'control: the app holds usage that carries the cap');
      assert.match(lastFrame.join('\n'), /claude 5h: 12% · wk: 71% · mo: 50%/);
      assert.doesNotMatch(lastFrame.join('\n'), /Fable/);
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
      assert.doesNotMatch(lastFrame.join('\n'), /Reply disabled|i reply · Enter sends/);
      const borderRow = lastFrame.findLastIndex(line => line.includes('+---'));
      const borderCol = lastFrame[borderRow].indexOf('+---') + 2;
      await key(`\x1b[<0;${borderCol};${borderRow + 1}M`); await key(`\x1b[<0;${borderCol};${borderRow + 1}m`);
      assert.equal(state.status, 'ready', 'the bottom border is not an invisible reply button');
    } else if (check.startsWith('ctrl-q-')) {
      const mode = check.slice('ctrl-q-'.length);
      if (mode === 'herdr' || mode === 'timeout' || mode === 'leader') await key('\x011');
      if (mode === 'review') await key('\x013');
      if (mode === 'reply') {
        await key('\x1b[B'); await key('\x1b[B'); await key('d'); await key('\x1b[C'); await key('i');
        assert.equal(state.observatory.details['obs-detail'].reply.focused, true);
      }
      if (mode === 'overlay') { await key('?'); assert.ok(state.overlay); }
      if (mode === 'palette') { await key('\x0f'); assert.ok(state.overlay); }
      if (mode === 'confirm') state.confirm = { verb: 'delete', ids: [], session: 'fixture-session', label: 'fixture' };
      if (mode === 'leader') {
        await key('\x01');
        assert.match(state.status, /ctrl\+q ×2 quit/);
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
        }
        await key('\x11');
        assert.deepEqual(exits, [0]);
        assert.equal(rawModes.at(-1), false, 'confirmed quit restores terminal mode');
        assert.equal(bytes.length, 0);
        if (spawns.length) assert.equal(spawns[0].client.ended, true, 'confirmed quit closes the native client');
      } finally { process.exit = exit; Date.now = now; }
    } else if (check === 'leader-quit') {
      const exits = [], exit = process.exit;
      process.exit = code => { exits.push(code); };
      try {
        await key('\x011'); bytes.length = 0;
        await key('\x01');
        assert.match(state.status, /q quit/);
        await key('q');
        assert.deepEqual(exits, [], 'the first leader quit must confirm like ordinary quit');
        assert.match(state.status, /press ctrl\+a q again to exit/);
        assert.equal(rawModes.at(-1), true, 'first press keeps the terminal active');
        assert.equal(bytes.length, 0, 'leader quit never reaches herdr');
        await key('\x01q');
        assert.deepEqual(exits, [0]);
        assert.equal(rawModes.at(-1), false, 'confirmed quit restores terminal mode');
        assert.equal(spawns[0].client.ended, true, 'confirmed quit closes the native client');
      } finally { process.exit = exit; }
    } else if (check === 'repeat-keys') {
      // A kitty AUTO-REPEAT is the same press still held down. It may move and it may type; it may
      // never run a command — a held ctrl+q used to answer its own quit confirmation.
      await key('\x1b[97;5:1u');
      assert.match(state.status, /q quit/);
      await key('\x1b[110;1:2u');
      assert.equal(active(), 'observatory', 'a repeat is not the leader command');
      await key('\x1b[110;1:1u');
      assert.equal(active(), 'review', 'the leader stays armed for the next real press');
      await key('\x01' + '2'); assert.equal(active(), 'observatory');
      // Navigation commands are commands too: a held ctrl+n must not cycle tabs, a press still does.
      await key('\x1b[110;5:2u');
      assert.equal(active(), 'observatory', 'a repeated ctrl+n does not cycle tabs');
      await key('\x1b[110;5:1u');
      assert.equal(active(), 'review', 'a pressed ctrl+n still cycles');
      await key('\x01' + '2'); assert.equal(active(), 'observatory');
      const selected = () => state.scopeWorker?.session ?? null;
      const before = selected();
      await key('\x1b[1;1:2B');
      assert.notEqual(selected(), before, 'a repeated arrow still moves the session selection');
      await key('\x1b[B'); await key('d'); await key('\x1b[C'); await key('i');
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
      await key('\x011'); bytes.length = 0;
      const raw = '\x1b[119;9u\x1b[119;9:2u\x1b[119;9:3u\x1b[1;5:3A';
      for (const ch of raw) process.stdin.emit('data', Buffer.from(ch));
      await wait();
      assert.equal(Buffer.from(bytes.join(''), 'hex').toString(), raw, 'modified press/repeat/release reaches the child verbatim');
      bytes.length = 0;
      const paste = '\x1b[200~\x01\x11\x1b[113;5u\x1b[<0;9;8Mλ\x1b[201~';
      await key(paste);
      assert.equal(Buffer.from(bytes.join(''), 'hex').toString(), paste, 'paste payload is opaque, including mouse-like bytes');
      await key('\x1b[97;5:3u'); await key('n');
      assert.equal(active(), 'herdr', 'a released leader cannot arm navigation');
      const before = state.status;
      await key('\x1b[113;5:3u'); await key('\x1b[113;5:3u');
      assert.equal(state.status, before, 'quit releases cannot arm or confirm quit');
      await key('\x1b[97;5u');
      await key('\x1b[110;9u'); await key('\x1b[110;1:3u');
      assert.equal(active(), 'herdr', 'super+n and released n cannot consume the leader');
      await key('\x1b[110;1:2u'); assert.equal(active(), 'herdr', 'a repeat cannot consume the leader either');
      await key('\x1b[110;1u'); assert.equal(active(), 'observatory', 'the held leader still answers the next press');
      await key('\x01p'); assert.equal(active(), 'herdr');
      // The leader is recognized even after an ordinary child key in the same read.
      await key('x\x1b[97;5u\x1b[51u'); assert.equal(active(), 'review');
      await key('\x01' + '1'); assert.equal(active(), 'herdr');
      await key('x\x01n'); assert.equal(active(), 'observatory');
    } else if (check === 'native-keys') {
      await key('\x011'); bytes.length = 0;
      await key('\x02?'); await key('?'); await key('+');
      assert.equal(Buffer.from(bytes.join(''), 'hex').toString(), '\x02??+');
      assert.equal(state.overlay, null, 'herdr owns question mark and plus');
      await key('\x01'); await key('\x1b');
      assert.equal(state.status, 'ready', 'escape cancels OAK leader mode');
      assert.equal(Buffer.from(bytes.join(''), 'hex').toString(), '\x02??+', 'leader escape stays out of the child');
      await key('\x01'); await key('n'); assert.equal(active(), 'observatory');
      await key('\x01p'); assert.equal(active(), 'herdr');
      await key('\x013'); assert.equal(active(), 'review');
      await key('\x012'); assert.equal(active(), 'observatory');
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
      assert.match(help, /options \(editor, display, store, keys\)/);
      assert.doesNotMatch(help, /store, machines/);
    } else if (check === 'delete') {
      // ^D in the session picker names the edits still pending review that the purge takes for good, and
      // says what undelete brings back: the session, not its edits ("Restore it later").
      await key('\x01' + '3'); await key('b');
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
      assert.equal(copied().at(-1), 'workstation\n  demo\n    v claude · p1\n        Fix the demo');
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
      // this frame's, and the escape goes to this terminal, whichever machine runs the session.
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
      const reply = at('i reply · Enter sends', c => c > masterCols);
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
      await key('\x01' + '2');
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
      await key('\x01' + '3');
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
      await click('done · GPT');
      assert.deepEqual([pinned()?.session, pinned()?.machineId], ['remote-done', 'build'], 'the stat line under a title pins its session, on its machine');
      await click('codex · p2');
      assert.equal(pinned()?.session, 'unknown', 'the pane line above a session pins the session it runs');
      // A half-typed reply is parked with its session by the click that leaves it, and comes back with it.
      await key('i'); await key('draft for unknown');
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
  await key('\x01'+'1'); assert.equal(active(), 'herdr'); assert.equal(spawns.length,1);
  assert.equal(spawns[0].args[0], '/fake/herdr');
  await key('\x02'); assert.ok(bytes.includes('02'), 'ctrl+b reaches herdr');
  await key('\x01o'); assert.equal(active(), 'observatory');
  assert.ok(requests.some(r=>r.method==='pane.current'));
  assert.equal(state.observatory.details['obs-detail'].selection.session, 'claude-conversation');
  await key('\x1b[B'); await key('d'); assert.equal(active(), 'observatory');
  assert.equal(state.observatory.details['obs-detail'].selection.session, 'working');
  await key('\x1bOQ'); assert.equal(state.tabs[state.activeTab].treeFocus,'obs-detail');
  await key('\x1bOQ'); assert.equal(state.tabs[state.activeTab].treeZoom,'obs-detail');
  await key('\x1bOQ'); assert.equal(state.tabs[state.activeTab].treeZoom,null);
  await key('i');
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
  await key('i');
  assert.equal(state.observatory.details['obs-detail'].reply.focused, false);
  assert.match(lastFrame.join('\n'), /blocked.*herdr/i);
  data.observatory.machines[0].snapshot.panes[1].agent_status = 'idle';
  await key('i'); await key('\x1b');
  const replyRow = lastFrame.findIndex(line => line.includes('i reply · Enter sends'));
  assert.ok(replyRow >= 0, lastFrame.join('\n'));
  const replyCol = lastFrame[replyRow].indexOf('i reply') + 1;
  await key(`\x1b[<0;${replyCol};${replyRow + 1}M`); await key(`\x1b[<0;${replyCol};${replyRow + 1}m`);
  assert.equal(state.observatory.details['obs-detail'].reply.focused, true, 'the fixed footer hit test matches its paint');
  await key('\x1b');
  await key('\x1b[D'); await key('\x1b[B'); await key('\x1b[B'); await key('d'); await key('\x1b[C');
  assert.equal(state.observatory.details['obs-detail'].selection.session, 'remote-done');
  refuseFocus = true; await key('h');
  assert.equal(active(), 'observatory'); assert.match(state.status, /remote focus refused/);
  refuseFocus = false;
  // The actual ↗ herdr button dispatches remote focus and switches only on success.
  const jumpRow = lastFrame.findIndex(line => line.includes('↗ herdr'));
  const jumpCol = lastFrame[jumpRow].indexOf('↗ herdr') + 1;
  await key(`\x1b[<0;${jumpCol};${jumpRow + 1}M`); await key(`\x1b[<0;${jumpCol};${jumpRow + 1}m`);
  assert.equal(active(), 'observatory'); assert.equal(typeof focusRemote, 'function');
  assert.deepEqual(forwarded.filter(c => c.argv[1] === 'focus').at(-1), { label: 'build-box', argv: ['agent', 'focus', 'remote-done'] });
  focusRemote({ result: { type: 'ok' } }); await wait(); assert.equal(active(), 'herdr');
  await key('\x01'+'1'); assert.equal(spawns.length,1,'switch back retains native PTY');
  await key('\x01'+'2');
  await key('\x01'+'1');
  spawns[0].client.ended = true; spawns[0].client.exit(0); await wait();
  assert.equal(active(), 'observatory', 'detached herdr client leaves its fixed tab available');
  await key('\x01'+'1'); assert.equal(spawns.length, 2, 'later switch reattaches with a new herdr client');
  await key('\x01o'); await key('\x1bOQ'); await key('\x01x');
  assert.ok(!state.observatory.details['obs-detail'], 'closed leaf releases its conversation');
  await key('d'); assert.ok(state.observatory.details['obs-detail'], 'direct pin restores a closed detail');
  fs.writeSync(2, 'PASS: lazy herdr PTY, fixed tabs, ctrl+b forwarding, ctrl+a o select+pin, d select+pin, F2 focus/zoom/restore, reply keys/paste/send/escape/blocked/click, remote focus button and tab switch, PTY reuse/relaunch, closed-detail restoration.\n');
  process.emit('exit', 0);
  fs.rmSync(home, { recursive: true, force: true });
})().catch(error=>{ fs.writeSync(2,error.stack+'\n'); process.exitCode=1; process.emit('exit',1); });
