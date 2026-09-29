// The Review tab on sessions that live on saved machines, driven through the INTERACTIVE app: real key
// bytes in, the painted frame and the backend's calls out. The core is the real one with herdr, the
// CLI children and the store faked; `OAK_REVIEW_CHECK` picks the scenario. Prints `PASS: <check>`.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const repo = path.resolve(__dirname, '../../../..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-review-remote-'));
process.env.HOME = home; process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude'); process.env.CODEX_HOME = path.join(home, '.codex');
// herdr too: every call this probe makes is faked, and anything that slips past a fake meets a socket that
// does not exist — never the person's live server, which a probe run from a herdr pane otherwise names.
for (const key of ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_ENV', 'HERDR_BIN_PATH', 'HERDR_SESSION']) delete process.env[key];
process.env.HERDR_SOCKET_PATH = path.join(home, 'no-herdr.sock'); process.env.XDG_CONFIG_HOME = path.join(home, '.config');
process.env.OAK_MACHINE_LABEL = 'workstation';
const realCore = require(repo + '/packages/core/dist');
const tui = require(repo + '/packages/tui/dist');
const frame = require(repo + '/packages/tui/dist/frame');
const backend = require(repo + '/packages/tui/dist/backend');
const { pane, snapshot } = require('./observatory');
const check = process.env.OAK_REVIEW_CHECK;

const now = Date.now();
const row = (id, title, pending, extra = {}) => ({ id, title, pending, agent: 'claude', model: 'Opus', tokens: 900,
  lastActiveMs: now - 60000, phase: 'idle', machine: 'this machine', workspace: '~/work', ...extra });
// This machine: one session, in a pane here. build-box: one session in a pane there and one with no
// pane at all (only its own catalog knows it). far-box answers only when the probe says so
// (`answerFar`); down-box cannot be reached.
// `launch-no-local`: this machine has no session at all. `launch-codex-only`: no Claude session, so no launch
// session, but a Codex session that took a turn after every other machine's.
const codexOnly = check === 'launch-codex-only';
// `launch-listing-fails`: no launch session either, and this machine's listing answers with something not JSON.
const noLocal = check === 'launch-no-local' || codexOnly || check === 'launch-listing-fails';
const localCatalog = { sessions: codexOnly ? [row('local-codex', 'Local codex', 1, { agent: 'codex', lastActiveMs: now + 10000, lastTurnMs: now + 10000 })]
  : noLocal ? [] : [row('local-a', 'Local work', 1), ...(check === 'switch-forgets' ? [row('local-b', 'Local other', 0)] : []),
  // `launch-local-newest`: a Codex session here, newer than every machine's.
  ...(check === 'launch-local-newest' ? [row('local-codex', 'Local codex', 1, { agent: 'codex', lastActiveMs: now + 10000 })] : [])] };
// `launch-newest`: build-box's live session is the newest on any machine.
const buildCatalog = { sessions: [row('remote-live', 'Remote live', 2, check.startsWith('launch-') ? { lastActiveMs: now } : {}),
  row('remote-quiet', 'Remote quiet', 3, { storeBytes: 2048, ...(check === 'launch-enter-quiet' || check === 'launch-feed-quiet' ? { lastActiveMs: now + 1000 } : {}) }), row('twin-id', 'Twin', 1)] };
const localSnapshot = snapshot(noLocal ? [] : [pane('p1', 'local-a', 'idle')]);
const buildSnapshot = snapshot([pane('p1', 'remote-live', 'idle')], { w1: 'review' });
// What each machine answers for a review read: its own edits, and — for build-box — the catalog it
// lists the session in. The map carries no title, as an older OAK there answers a forwarded read.
const review = (session, file) => ({
  changemap: { summary: { session, title: '', pending: 1, root: '/remote/work' }, files: [] },
  list: { edits: [{ id: 7, file, rel: path.basename(file), tool: 'Edit', status: 'pending', added: 1, removed: 1, ts: now - 1000 }] },
  risk: {}, egress: {}, multitask: { agents: [] },
  ...(check === 'promptscope-switch' ? { prompts: { prompts: [{ index: 1, id: 'p1', text: 'ask one', ts: now - 2000, edits: 1, editIds: [7] }] } } : {}),
});

let state, lastFrame;
const requests = [], mutations = [], runs = [], runMachines = [], swept = [], commented = [];
// `launch-late-local*`: this machine's own listing is held back until the probe lets it through; `holdRemote`
// holds a saved machine's review reads the same way.
let holdLocal = check === 'launch-late-local' || check === 'launch-late-local-review';
let holdRemote = false;
const heldLocal = [], heldRemote = [];
// `launch-codex-only`: this machine's own listing (`oak sessions --json`, read by the launch rule) is held until
// the probe calls `answerListing`.
let answerListing = () => { throw new Error('this machine\'s listing was never asked for'); };
const draw = frame.renderDashFrame;
frame.renderDashFrame = (s, ...rest) => { state = s; lastFrame = draw(s, ...rest); return lastFrame; };
backend.createBackend = () => {
  let notify;
  return { close() {}, watcherMode: () => 'native', updateSkew: () => check === 'update-skew', onData(fn) { notify = fn; },
    request(names, session, extra, force, machine) {
      requests.push({ names: [...names], session, extra: [...(extra || [])], machine });
      const payload = machine === 'build-box' ? { ...review(session, '/remote/work/a.txt'), sessions: buildCatalog }
        : session === 'local-b' ? { ...review(session, '/local/work/c.txt'), list: { edits: [] }, sessions: localCatalog }
        : { ...review(session, '/local/work/b.txt'), sessions: localCatalog };
      const send = () => notify(payload, null, Date.now(), session, machine);
      if (holdLocal && !machine) heldLocal.push(send);
      else if (holdRemote && machine) heldRemote.push(send);
      else queueMicrotask(send);
    },
    mutate: async (verb, ids, session, machine) => { mutations.push({ verb, ids: [...ids], session, machine }); return { ok: true, json: { status: 'kept', ids, message: 'kept' }, err: null }; },
    // An edit whose diff numbers lines 10–13 (a context line, a replaced line and one added, a context line).
    diff: async () => check === 'comment-line' ? '--- a/b.txt\n+++ b/b.txt\n@@ -10,3 +10,4 @@\n before\n-old\n+new\n+more\n after\n' : '',
    // This machine's listing, asked for by a picker that has none yet.
    run: async (args, machine) => { runs.push([...args]); runMachines.push(machine);
      if (args[0] === 'sessions') {
        if (check === 'launch-listing-fails') return 'oak: the listing failed';
        if (codexOnly) await new Promise(resolve => { answerListing = resolve; });
        return JSON.stringify({ active: null, ...localCatalog });
      }
      return args[0] === 'views' ? JSON.stringify({ sessions: localCatalog }) : args[0] === 'ignore' ? JSON.stringify({ droppedNow: 2 }) : ''; },
  };
};
const catalogs = { 'build-box': buildCatalog };
const deleted = [];
let answerFar = () => { throw new Error('far-box was never asked'); };
// `launch-leave-review`: build-box's catalog is held until the probe calls `answerBuild`.
const holdBuild = check === 'launch-leave-review' || check === 'launch-mouse-switch';
let answerBuild = () => { throw new Error('build-box was never asked'); };
/** Every CLI child the Observatory started, by its arguments. */
const spawned = [];
/** This machine's newest session, as the launch default and the newer-session hint read it. */
let defaultSession = noLocal ? null : 'local-a';
const core = { ...realCore,
  readPrefs: () => ({ color: 'none', glyphs: 'ascii', layout: { active: ['pin', 'cursor', 'launch-newest', 'launch-late-local', 'launch-no-local', 'launch-r-key', 'launch-mouse-switch', 'launch-resolve-remote', 'launch-enter-quiet', 'launch-feed-quiet', 'launch-local-newest', 'launch-codex-only', 'launch-listing-fails'].includes(check) ? 'observatory' : 'review' } }), writePrefs() {},
  findHerdrBin: () => '/fake/herdr', ensureHerdrTabs: undefined, resolveMonitor: () => null,
  sessionWorkspace: () => null, defaultTuiSession: () => defaultSession, startAgentSession() { throw Error('no agents in this probe'); },
  deleteSession: (id) => deleted.push(id), dropIgnored: (id) => { swept.push(id); return { dropped: 0, files: [] }; },
  addComment: (session, o) => { commented.push({ session, ...o }); return { id: 'c1' }; }, pendingCommentCount: () => 1,
  connectDaemon: async () => null, ensureDaemon: async () => ({ client: null, why: 'disabled in probe' }),
  dueRemoteUsageGather: () => false, dueAccountUsagePull: () => false, kickMonthRefresh() {}, usageLine: () => null, usageBrief: () => null,
  siblingOverviewCached: () => null, subagentDigests: () => [], detectEditors: () => [],
  herdrSnapshot: async () => localSnapshot,
  herdrMachines: async () => ['build-box', 'far-box', 'down-box'].map((label) => ({ id: label, label, enabled: true })),
  herdrOnMachine: async (label, argv) => {
    if (argv[0] === 'api' && label === 'build-box') return { result: { snapshot: buildSnapshot } };
    if (argv[0] === 'api') throw new Error(`${label} snapshot unavailable`);
    return { result: { type: 'ok' } };
  },
  herdrRequest: async () => ({ type: 'ok' }), herdrSubscribe: () => ({ close() {} }), createWatcher: () => ({ close() {} }), readHerdrPaneLink: () => null,
  // The Observatory's CLI children: a saved machine's catalog (`sessions --json --machine <label>`) and
  // conversation reads. far-box answers when the probe calls `answerFar`; down-box fails the way ssh does.
  spawnTool: (_command, args) => {
    const { EventEmitter } = require('events'), child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; child.emit('close', null); };
    const machine = args.includes('--machine') ? args[args.indexOf('--machine') + 1] : undefined;
    spawned.push([...args]);
    queueMicrotask(() => {
      if (child.killed) return;
      if (holdBuild && machine === 'build-box' && args[1] === 'sessions') {
        answerBuild = () => { child.stdout.emit('data', Buffer.from(JSON.stringify(buildCatalog))); child.emit('close', 0); };
        return;
      }
      if (machine === 'far-box') {
        answerFar = (catalog) => { child.stdout.emit('data', Buffer.from(JSON.stringify(catalog))); child.emit('close', 0); };
        return;
      }
      if (machine === 'down-box') {
        child.stderr.emit('data', Buffer.from('oak: down-box is not reachable over ssh (fixture.invalid): Connection refused'));
        return child.emit('close', 255);
      }
      const payload = args[1] === 'sessions' ? (machine ? catalogs[machine] : localCatalog)
        : args[1] === 'conversation' ? { events: [], cursor: 0, transcriptPath: null }
        : args[1] === 'multitask' ? { agents: [] } : args[1] === 'subagents' ? { subagents: [] } : { sessions: localCatalog };
      child.stdout.emit('data', Buffer.from(JSON.stringify(payload))); child.emit('close', 0);
    });
    return child;
  },
};
Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
process.stdin.setRawMode = () => {};
Object.defineProperty(process.stdout, 'columns', { value: 160, configurable: true });
Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
process.stdout._refreshSize = () => {};
process.stdout.write = () => true;
const wait = (ms = 90) => new Promise(resolve => setTimeout(resolve, ms));
const key = async text => { process.stdin.emit('data', Buffer.from(text)); await wait(); };
const text = () => lastFrame.join('\n');
const tab = () => state.tabs[state.activeTab].id;
const lastRequest = () => requests[requests.length - 1];

(async () => {
  // `launch`: `oak tui --session remote-quiet`, which the CLI let through because this machine does not
  // hold it and saved machines exist.
  const launch = check === 'launch' ? { session: 'remote-quiet', elsewhere: true } : check === 'first-run-root' || noLocal ? '' : 'local-a';
  // `launch-*` names neither a session nor a workspace, and runs outside any repo (the probe's own home).
  // `first-run-root`: `oak tui --root <dir>` whose launch resolved no session, while that workspace has one.
  if (check.startsWith('launch-')) process.chdir(home);
  // `hint-legacy-pin`: the session is pinned by the legacy variable alone, not by --session.
  if (check === 'hint-legacy-pin') process.env.CLAUDE_CHANGES_SESSION = 'local-a';
  tui.runTui(core, check.startsWith('launch-') || check.startsWith('hint-') ? ['--no-server'] : check === 'first-run-root' ? ['--root', home, '--no-server']
    : ['--session', typeof launch === 'string' ? launch : launch.session, '--no-server'], () => launch);
  if (check === 'launch') {
    // Before any saved machine has answered, nothing is read from this machine's store for it.
    assert.match(state.reviewFinding ?? '', /looking for this session on/);
    assert.ok(requests.every(r => r.session !== 'remote-quiet' || r.machine), 'never read here');
  }
  await wait(300); // discovery, then each saved machine's catalog
  if (check === 'launch') {
    assert.equal(tab(), 'review');
    assert.equal(state.reviewFinding, undefined, 'build-box listed it; far-box, still silent, is not waited for');
    assert.deepEqual([lastRequest().session, lastRequest().machine], ['remote-quiet', 'build-box']);
    assert.ok(requests.every(r => r.session !== 'remote-quiet' || r.machine === 'build-box'), 'never read here');
    await wait();
    assert.match(text(), /Remote quiet  remote-q  on build-box/);
    // No local read has happened, so the picker asks this machine for its listing and says so meanwhile.
    await key('b');
    assert.deepEqual(runs.at(-1)?.slice(0, 3), ['views', '--views', 'sessions']);
    await wait();
    const lines = state.overlay.lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));
    assert.ok(lines.findIndex(l => l.includes('Local work')) === 0, lines.join('\n'));
    assert.match(lines.find(l => l.includes('Remote quiet')), /^>?\s*\*/, 'the session in effect is marked on its own machine');
  } else if (check === 'picker') {
    assert.equal(tab(), 'review');
    await key('b');
    const lines = state.overlay.lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));
    const at = needle => lines.findIndex(l => l.includes(needle));
    // Every saved machine's sessions, this machine's first, each named by its machine.
    assert.ok(at('Local work') >= 0 && at('Remote live') > at('Local work') && at('Remote quiet') > at('Local work'), lines.join('\n'));
    assert.match(lines[at('Remote quiet')], /build-box/);
    assert.match(lines[at('Local work')], /this machine/);
    assert.match(lines[at('Remote quiet')], /2KB|2\.0KB|2 KB/i, 'a remote store reports its own size');
    // A machine still answering, and one that cannot, say so in their own place.
    assert.match(lines.join('\n'), /far-box has not answered yet/);
    assert.match(lines.join('\n'), /could not list down-box's sessions — down-box is not reachable over ssh/);
    assert.ok(at('far-box has not answered') > at('Remote quiet'), 'machine groups keep the discovery order');
    // A session on another machine is deleted there, never from this machine's store.
    await key('\x1b[B'); await key('\x1b[B');
    assert.match(lines[state.overlay.cursor], /Remote quiet/);
    await key('\x04');
    assert.match(state.status, /that session is on build-box — delete it there: oak sessions --delete remote-quiet --machine build-box/);
    assert.deepEqual(deleted, []);
    assert.equal(state.confirm, null);
    // A machine that answers while the picker is open fills its place in the list; the highlight stays
    // on the row the reader was on.
    await key('\x1b[A');
    answerFar({ sessions: [row('far-one', 'Far session', 1), row('twin-id', 'Twin', 1)] });
    await wait();
    const after = state.overlay.lines.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));
    assert.ok(after.some(l => /Far session\s.*far-box/.test(l)), after.join('\n'));
    assert.ok(!after.some(l => /far-box has not answered/.test(l)));
    assert.match(after[state.overlay.cursor], /Remote live/, 'the highlighted row is kept');
    // Two machines list one id: the row picked decides where it is reviewed, not the first listing.
    await key('Twin'); await key('\x1b[B');
    assert.match(state.overlay.lines[state.overlay.cursor].replace(/\x1b\[[0-9;]*m/g, ''), /Twin.*far-box/);
    await key('\r');
    assert.deepEqual([state.session, lastRequest().session, lastRequest().machine], ['twin-id', 'twin-id', 'far-box']);
    await key('b');
    // Choosing a row reviews the session THERE: every read goes through --machine build-box.
    await key('Remote quiet'); await key('\r');
    assert.equal(state.session, 'remote-quiet');
    assert.deepEqual([lastRequest().session, lastRequest().machine], ['remote-quiet', 'build-box']);
    await wait();
    assert.match(text(), /Remote quiet  remote-q  on build-box/, 'the header names the machine, and the catalog title stands in for an untitled map');
    // …and a decision goes there too.
    await key('a');
    assert.deepEqual(mutations.at(-1), { verb: 'keep', ids: [7], session: 'remote-quiet', machine: 'build-box' });
    // Back to this machine's session: read here again, no machine named.
    await key('b'); await key('Local work'); await key('\r');
    assert.deepEqual([lastRequest().session, lastRequest().machine], ['local-a', undefined]);
    await wait();
    assert.doesNotMatch(text(), /on build-box/);
    // A note row is not a session; choosing it says what it says.
    await key('b'); await key('down-box'); await key('\r');
    assert.equal(state.session, 'local-a');
    assert.match(state.status, /could not list down-box's sessions — down-box is not reachable over ssh/);
  } else if (check === 'pin') {
    assert.equal(tab(), 'observatory');
    const masterCols = Math.floor(160 * 0.3);
    const click = async (needle) => {
      const r = lastFrame.findIndex(line => { const c = line.indexOf(needle); return c >= 0 && c < masterCols; });
      assert.ok(r >= 0, `"${needle}" is painted in the master:\n${text()}`);
      const c = lastFrame[r].indexOf(needle) + 1;
      await key(`\x1b[<0;${c};${r + 1}M`); await key(`\x1b[<0;${c};${r + 1}m`);
    };
    // A session on build-box, pinned in the Observatory, is the one Review shows — read there.
    await click('Remote live');
    assert.equal(state.observatory.details['obs-detail']?.selection.session, 'remote-live');
    await key('\x01' + '3');
    assert.equal(tab(), 'review');
    assert.equal(state.session, 'remote-live');
    assert.deepEqual([lastRequest().session, lastRequest().machine], ['remote-live', 'build-box']);
    await wait();
    assert.match(text(), /on build-box/);
    // …and a session on this machine, pinned, is read here.
    await key('\x01' + '2');
    await click('Local work');
    await key('\x01' + '3');
    assert.equal(state.session, 'local-a');
    assert.deepEqual([lastRequest().session, lastRequest().machine], ['local-a', undefined]);
    // The find palette offers every saved machine's sessions too, and opens one where it lives.
    await key('\x0f'); await key('Remote quiet');
    assert.ok(state.overlay.lines.some(l => /session\s+Remote quiet\s.*build-box/.test(l.replace(/\x1b\[[0-9;]*m/g, ''))), state.overlay.lines.join('\n'));
    await key('\r');
    assert.deepEqual([state.session, lastRequest().session, lastRequest().machine], ['remote-quiet', 'remote-quiet', 'build-box']);
  } else if (check === 'cursor') {
    // The Observatory cursor, not only a pin, is what Review shows.
    assert.equal(tab(), 'observatory');
    await key('\x1b[B'); await key('\x1b[B');
    assert.equal(state.scopeWorker?.session, 'remote-live', text());
    assert.equal(state.observatory.details['obs-detail'], undefined, 'previewed, not pinned');
    await key('\x01' + '3');
    assert.equal(tab(), 'review');
    assert.equal(state.session, 'remote-live');
    assert.deepEqual([lastRequest().session, lastRequest().machine], ['remote-live', 'build-box']);
    await wait();
    assert.match(text(), /Remote live  remote-l  on build-box/);
    // Back on this machine's row: read here again.
    await key('\x01' + '2'); await key('\x1b[A'); await key('\x01' + '3');
    assert.equal(state.session, 'local-a');
    assert.deepEqual([lastRequest().session, lastRequest().machine], ['local-a', undefined]);
  } else if (check === 'launch-newest') {
    // No session named, outside any repo: once build-box answers, Review is on its newer session.
    assert.equal(tab(), 'observatory');
    assert.match(state.status, /Review is on Remote live on build-box, active more recently/);
    await key('\x01' + '3');
    assert.equal(state.session, 'remote-live');
    assert.deepEqual([lastRequest().session, lastRequest().machine], ['remote-live', 'build-box']);
    // The launch session is no newcomer: the hint stays quiet after Review moved off it… Each step is one
    // read past the hint's 30-second throttle, and the status is read before another key can replace it.
    const real = Date.now;
    let skew = 31_000;
    Date.now = () => real() + skew;
    await key('\x01' + '2'); await wait();
    assert.doesNotMatch(state.status, /a newer session is live/);
    // …and still names one that starts later (the same step, so the check above did run).
    defaultSession = 'local-new';
    skew = 62_000;
    await key('\x01' + '3'); await wait();
    assert.match(state.status, /a newer session is live — press b to switch/);
  } else if (check === 'launch-late-local') {
    // build-box answered first: nothing is decided until this machine's own listing, the bar, is read…
    assert.ok(heldLocal.length > 0, 'control: this machine’s listing was asked for and held');
    assert.doesNotMatch(state.status ?? '', /Review is on/);
    assert.equal(state.tabs.find(t => t.id === 'review').session, 'local-a');
    // …and it is decided as soon as that listing lands, not at the next refresh of a saved machine.
    holdLocal = false;
    heldLocal.splice(0).forEach(send => send());
    await wait();
    assert.match(state.status, /Review is on Remote live on build-box, active more recently/);
    assert.equal(state.tabs.find(t => t.id === 'review').session, 'remote-live');
  } else if (check === 'launch-late-local-review') {
    // Review is up at launch and build-box answers before this machine's own listing: the move
    // never paints this machine's rows under build-box's header, and a key cannot decide on them.
    assert.equal(tab(), 'review');
    assert.ok(heldLocal.length > 0, 'control: this machine’s listing was held');
    holdRemote = true; // the adopted session's own read is still on its way
    holdLocal = false;
    heldLocal.splice(0).forEach(send => send());
    await wait();
    assert.equal(state.session, 'remote-live');
    assert.ok(!JSON.stringify(state.views?.list ?? null).includes('/local/work/b.txt'), 'no local rows under the remote header');
    await key('u'); await wait();
    assert.deepEqual(mutations, [], 'nothing was decided on rows that were never build-box’s');
    holdRemote = false;
    heldRemote.splice(0).forEach(send => send());
    await wait();
    assert.match(text(), /Remote live  remote-l  on build-box/);
  } else if (check === 'launch-no-local') {
    // No session here: a saved machine's list is asked for without one (the CLI refuses `--session ''`), and
    // Review opens on its session.
    const asks = spawned.filter(a => a[1] === 'sessions' && a.includes('--machine'));
    assert.ok(asks.length > 0, 'control: the saved machines were asked for their sessions');
    assert.ok(asks.every(a => !a.includes('--session')), JSON.stringify(asks));
    assert.equal(state.tabs.find(t => t.id === 'review').session, 'remote-live');
  } else if (check === 'launch-two-review') {
    // Review is up; a machine answering later with a more recent session still moves it (the
    // first machine's answer used to settle it while Review was up, and not while the Observatory was).
    assert.equal(state.session, 'remote-live');
    answerFar({ sessions: [row('far-new', 'Far newest', 1, { lastActiveMs: now + 5000 })] });
    await wait();
    assert.deepEqual([state.session, lastRequest().session, lastRequest().machine], ['far-new', 'far-new', 'far-box']);
  } else if (check === 'launch-leave-review') {
    // Leaving Review before build-box answers is not acting in it: build-box's answer still moves it.
    assert.equal(tab(), 'review');
    assert.equal(state.tabs.find(t => t.id === 'review').session, 'local-a');
    await key('\x01' + '2');
    assert.equal(tab(), 'observatory');
    answerBuild();
    await wait();
    assert.equal(state.tabs.find(t => t.id === 'review').session, 'remote-live');
  } else if (check === 'promptscope-switch') {
    // A prompt's scope names edits of the session it was chosen in: a switch drops it, the Observatory's
    // cursor included (the new session's Traces read "nothing yet").
    await key('\x1bOQ'); await wait();
    await key('\r'); await wait();
    assert.ok(state.promptScope, 'control: a prompt scope is set');
    await key('\x01' + '2'); await key('\x1b[B'); await key('\x1b[B'); await key('\x01' + '3'); await wait();
    assert.equal(state.session, 'remote-live');
    assert.equal(state.promptScope, null);
  } else if (check === 'launch-r-key') {
    // The launch rule moved Review off this machine's session while the Observatory was up; `r` with nothing
    // selected opens Review on the session it moved to, read there (it reopened the launch session).
    assert.equal(state.tabs.find(t => t.id === 'review').session, 'remote-live');
    assert.equal(state.scopeWorker, null, 'control: nothing is selected');
    await key('r'); await wait();
    assert.equal(tab(), 'review');
    assert.deepEqual([state.session, lastRequest().session, lastRequest().machine], ['remote-live', 'remote-live', 'build-box']);
  } else if (check === 'launch-local-newest') {
    // Any session, any machine: this machine's own Codex session, the newest anywhere, is
    // the one Review opens on, read here; build-box's newer-than-the-default session does not win.
    assert.equal(state.tabs.find(t => t.id === 'review').session, 'local-codex');
    assert.match(state.status, /^Review is on Local codex, active more recently$/);
    await key('\x01' + '3'); await wait();
    assert.deepEqual([state.session, lastRequest().session, lastRequest().machine], ['local-codex', 'local-codex', undefined]);
  } else if (check === 'launch-resolve-remote') {
    // With nothing selected, `a` and `x` act on the session Review is on, which the rule put on build-box:
    // the confirmation names the machine, and an agent there is stopped there.
    assert.equal(state.tabs.find(t => t.id === 'review').session, 'remote-live');
    await key('a');
    assert.match(state.confirm?.label ?? '', /accept every pending edit in .* on build-box and clear its store/);
    await key('n');
    assert.equal(state.confirm, null);
    await key('x');
    assert.equal(state.confirm, null, 'nothing to confirm: this machine cannot stop it');
    assert.match(state.status, /runs on build-box: stop its agent there/);
  } else if (check === 'launch-enter-quiet' || check === 'launch-feed-quiet') {
    // The rule put Review on remote-quiet, which has no pane (build-box's catalog alone lists it). Enter (or f)
    // with nothing selected pins it on build-box, where its conversation is read (it was read here).
    assert.equal(state.tabs.find(t => t.id === 'review').session, 'remote-quiet');
    await key(check === 'launch-enter-quiet' ? '\r' : 'f'); await wait(300);
    const pinned = state.observatory.details['obs-detail']?.selection;
    assert.deepEqual([pinned?.session, pinned?.machineId], ['remote-quiet', 'build-box']);
    // Conversation reads, not the mirror check (`--source-info`, which looks here for a sync copy's time).
    const reads = spawned.filter(a => a[1] === 'conversation' && !a.includes('--source-info'))
      .map(a => [a[a.indexOf('--session') + 1], a.includes('--machine') ? a[a.indexOf('--machine') + 1] : 'here']);
    assert.ok(reads.some(([s, m]) => s === 'remote-quiet' && m === 'build-box'), JSON.stringify(reads));
    assert.ok(!reads.some(([s, m]) => s === 'remote-quiet' && m === 'here'), JSON.stringify(reads));
  } else if (check === 'launch-mouse-switch') {
    // A click on the Review tab before build-box answers: its release lands on Review but is part of the
    // click that switched tabs, so build-box's answer still moves Review.
    const c = lastFrame[0].indexOf('review');
    assert.ok(c > 0, lastFrame[0]);
    await key(`\x1b[<0;${c + 2};1M`); await key(`\x1b[<0;${c + 2};1m`);
    assert.equal(tab(), 'review');
    answerBuild();
    await wait();
    assert.deepEqual([state.session, lastRequest().session, lastRequest().machine], ['remote-live', 'remote-live', 'build-box']);
  } else if (check === 'launch-codex-only') {
    // No launch session: the rule reads this machine's listing itself (every agent), and decides nothing until
    // it has answered, even once every saved machine has (this machine's sessions went unweighed).
    answerFar({ sessions: [] }); await wait();
    assert.ok(state.observatory.machines.every(m => m.local || m.sessions || m.sessionsError), 'control: every saved machine answered');
    assert.ok(runs.some(a => a.join(' ') === 'sessions --json'), JSON.stringify(runs));
    assert.doesNotMatch(state.status ?? '', /Review is on/);
    assert.equal(state.tabs.find(t => t.id === 'review').session || '', '');
    answerListing(); await wait();
    assert.equal(state.tabs.find(t => t.id === 'review').session, 'local-codex');
    assert.match(state.status, /^Review is on Local codex, active more recently$/);
    await key('\x01' + '3'); await wait();
    assert.deepEqual([state.session, lastRequest().session, lastRequest().machine], ['local-codex', 'local-codex', undefined]);
  } else if (check === 'launch-listing-fails') {
    // This machine's listing failed: the rule still decides, on the saved machines' sessions.
    assert.ok(runs.some(a => a.join(' ') === 'sessions --json'), JSON.stringify(runs));
    assert.equal(state.tabs.find(t => t.id === 'review').session, 'remote-live');
    assert.match(state.status, /Review is on Remote live on build-box/);
  } else if (check === 'hint-codex') {
    // A Codex session is weighed by Codex's own turns: reattached after launch, no hint; a turn
    // after launch, the hint.
    const id = '00000000-0000-4000-8000-0000000000d1';
    const dir = path.join(home, '.codex', 'sessions', '2026', '09', '28');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-09-28T12-00-00-${id}.jsonl`), ago = (ms) => new Date(Date.now() - ms).toISOString();
    const line = (o) => JSON.stringify(o) + '\n';
    fs.writeFileSync(file, line({ timestamp: ago(2 * 86400000), type: 'session_meta', payload: { id, cwd: home, originator: 'codex-tui', source: 'cli', model_provider: 'openai' } })
      + line({ timestamp: ago(2 * 86400000), type: 'event_msg', payload: { type: 'user_message', message: 'Tidy the notes.' } })
      + line({ timestamp: ago(2 * 86400000), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Tidied.' }] } })
      + line({ timestamp: ago(0), type: 'event_msg', payload: { type: 'thread_settings_applied' } }));
    assert.equal(realCore.describeSession(id).transcript, file, 'control: the probe\'s rollout is the one read');
    const real = Date.now;
    let skew = 31_000;
    Date.now = () => real() + skew;
    defaultSession = id;
    await key('\x01' + '2'); await wait();
    assert.doesNotMatch(state.status ?? '', /a newer session is live/);
    fs.appendFileSync(file, line({ timestamp: new Date(real()).toISOString(), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'And the index.' }] } }));
    skew = 62_000;
    await key('\x01' + '3'); await wait();
    assert.match(state.status, /a newer session is live — press b to switch/);
  } else if (check === 'hint-resumed') {
    // A session that only reopened after launch (herdr restoring its pane runs `claude --resume`) is newest by
    // its file, but took no turn since launch: no hint. A turn after launch is one.
    const project = path.join(home, '.claude', 'projects', '-probe-work');
    fs.mkdirSync(project, { recursive: true });
    const file = path.join(project, 'local-resumed.jsonl'), ago = (ms) => new Date(Date.now() - ms).toISOString();
    const line = (o) => JSON.stringify({ sessionId: 'local-resumed', cwd: '/probe/work', ...o }) + '\n';
    fs.writeFileSync(file, line({ type: 'user', timestamp: ago(2 * 86400000), message: { role: 'user', content: 'Tidy the notes.' } })
      + line({ type: 'assistant', timestamp: ago(2 * 86400000 - 1000), message: { role: 'assistant', content: [{ type: 'text', text: 'Tidied.' }] } })
      + line({ type: 'system', timestamp: ago(0) }) + line({ type: 'bridge-session', timestamp: ago(0) }));
    assert.equal(realCore.describeSession('local-resumed').transcript, file, 'control: the probe\'s transcript is the one read');
    const real = Date.now;
    let skew = 31_000;
    Date.now = () => real() + skew;
    defaultSession = 'local-resumed';
    await key('\x01' + '2'); await wait();
    assert.doesNotMatch(state.status ?? '', /a newer session is live/);
    fs.appendFileSync(file, line({ type: 'user', timestamp: new Date(real()).toISOString(), message: { role: 'user', content: 'And the index.' } }));
    skew = 62_000;
    await key('\x01' + '3'); await wait();
    assert.match(state.status, /a newer session is live — press b to switch/);
  } else if (check === 'hint-legacy-pin') {
    // The legacy session variable pins the session as --session does, so no newcomer is hinted at.
    const real = Date.now;
    Date.now = () => real() + 31_000;
    defaultSession = 'local-new';
    await key('\x01' + '2'); await wait();
    assert.doesNotMatch(state.status ?? '', /a newer session is live/);
  } else if (check === 'first-run-root') {
    // The first read adopts the workspace's session instead of crashing the app at startup.
    assert.equal(state.session, 'local-a');
    assert.ok(requests.some(r => r.session === 'local-a' && !r.machine), 'and reads it here');
  } else if (check === 'comment-line') {
    // `:comment 12: note` anchors to line 12, as the editors' gutter and the CLI's --line do, and only to a
    // line the edit's diff numbers. A number without the colon is the note's own text
    // (`:comment 3 tests fail` became "tests fail" on line 3, and line 9999 of a short edit was taken).
    await wait(300);
    // Pick the edit (Traces, then a cursor move): its diff is fetched and shown.
    await key('\x1bOR'); await key('\x1b[B'); await key('\x1b[A'); await wait(300);
    assert.equal(state.diffMeta?.id, 7, 'control: the edit\'s diff is shown');
    await key(':comment 12: guard the empty case\r');
    assert.deepEqual(commented.at(-1), { session: 'local-a', unit: 7, line: 12, text: 'guard the empty case' });
    assert.match(state.status, /comment added on #7 line 12/);
    await key(':comment 3 tests fail here\r');
    assert.deepEqual(commented.at(-1), { session: 'local-a', unit: 7, line: 0, text: '3 tests fail here' }, 'a leading number without a colon is not a line');
    const written = commented.length;
    await key(':comment 9999: past the end\r');
    assert.equal(commented.length, written, 'a line outside the edit is refused, not written');
    assert.equal(state.status, 'line 9999 is not in this edit\'s diff, which shows lines 10–13');
    await key(':comment the whole edit\r');
    assert.deepEqual(commented.at(-1), { session: 'local-a', unit: 7, line: 0, text: 'the whole edit' }, 'no number: the whole edit');
    // A session on another machine: the same anchor, written there by its own oak.
    await key('b'); await key('Remote quiet'); await key('\r'); await wait(300);
    await key('\x1bOR'); await key('\x1b[B'); await key('\x1b[A'); await wait(300);
    await key(':comment 13: there too\r'); await wait();
    assert.deepEqual(runs.find(a => a[0] === 'comment'), ['comment', 'add', '--session', 'remote-quiet', '--edit', '7', '--line', '13', '--text=there too', '--json']);
  } else if (check === 'refresh-remote') {
    // Refresh applies a new .observatoryignore where the session's store is: on its own machine.
    await key('b'); await key('Remote quiet'); await key('\r'); await wait();
    assert.equal(state.session, 'remote-quiet');
    await key('r'); await wait();
    const at = runs.findIndex(a => a[0] === 'ignore');
    assert.deepEqual([runs[at], runMachines[at]], [['ignore', '--session', 'remote-quiet', '--json'], 'build-box']);
    assert.deepEqual(swept, [], 'nothing is swept on this machine for it');
    assert.match(state.status, /dropped 2 now-ignored edits/);
    // Control: this machine's session is swept here, as before.
    await key('b'); await key('Local work'); await key('\r'); await wait();
    await key('r'); await wait();
    assert.deepEqual(swept, ['local-a']);
  } else if (check === 'switch-forgets') {
    // A selection is the session's it was made in: marks and the shown diff made on one session must not
    // follow a switch to another on the same machine, where `u` would revert whatever has that id there.
    assert.equal(tab(), 'review');
    await wait();
    await key('x');
    assert.deepEqual([...state.marked], [7], 'control: local-a\'s edit is marked');
    await key('b'); await key('Local other'); await key('\r'); await wait();
    assert.equal(state.session, 'local-b');
    assert.deepEqual([...state.marked], [], 'the marks stayed with local-a');
    assert.equal(state.diffMeta, undefined, 'and so did the diff it showed');
    await key('u'); await key('y');
    assert.deepEqual(mutations, [], 'nothing was undone in local-b');
  } else if (check === 'update-skew') {
    // An app started before an update runs the old build until it is started again: the notice names the
    // command that starts it (it said `restart dash`, a command OAK does not have).
    assert.equal(state.status, 'the CLI was updated — restart oak tui to pick up the new build');
    assert.match(text(), /the CLI was updated — restart oak tui to pick up the new build/);
  } else throw new Error(`unknown check ${check}`);
  fs.writeSync(2, `PASS: ${check}\n`);
  process.emit('exit', 0);
  // Out of the probe's home first (`launch-*` runs in it): Windows cannot remove a process's working directory.
  process.chdir(os.tmpdir());
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(0);
})().catch(error => { fs.writeSync(2, error.stack + '\n'); process.exitCode = 1; process.exit(1); });
