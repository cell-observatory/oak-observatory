const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// The driver records which tab labels OAK owns under the store: keep that private even when this file
// runs without test/bootstrap.cjs.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-herdr-tabs-'));
process.on('exit', () => fs.rmSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true, force: true }));
const { reconcileHerdrTabs, ensureHerdrTabs, paneForeground, BTOP_LABEL, MONITOR_LAUNCH } = require('../dist/herdr-tabs');
// The driver's transport: core's own, pointed at the scripted server below by `herdrOptions`.
const transport = require('../dist/herdr');
const { fakeHerdr, processInfo, scripted } = require('./fake-herdr');

// A snapshot with one workspace, its tabs, panes and joined agents.
const snap = (tabs, panes = [], agents = [], workspaces) => ({ tabs, panes, agents, ...(workspaces ? { workspaces } : {}) });
const tab = (n, label, ws = 'w1') => ({ tab_id: `${ws}:t${n}`, workspace_id: ws, number: n, label });
const pane = (n, tabN, ws = 'w1') => ({ pane_id: `${ws}:p${n}`, tab_id: `${ws}:t${tabN}` });
/** The pane OAK labelled `btop`: the monitor's. */
const monitor = (n, tabN, ws = 'w1') => ({ ...pane(n, tabN, ws), label: BTOP_LABEL });
const agent = (paneN, session, ws = 'w1', kind) => ({ pane_id: `${ws}:p${paneN}`, ...(kind ? { agent: kind } : {}), agent_session: { value: session } });
const workspace = (id, label) => ({ workspace_id: id, label });
const titles = (m) => (id) => m[id];
const launch = (tabN, paneN, ws = 'w1') => ({ kind: 'launch-monitor', tab_id: `${ws}:t${tabN}`, pane_id: `${ws}:p${paneN}`, label: BTOP_LABEL });
const create = (ws = 'w1') => ({ kind: 'create-btop', workspace_id: ws, label: BTOP_LABEL });

test('herdr tabs: a workspace with no btop tab gets one', () => {
  const { actions } = reconcileHerdrTabs(snap([tab(1, '1')]), () => null, {});
  assert.deepEqual(actions, [create()]);
});

test('herdr tabs: an existing btop tab is not duplicated, and never renamed — its monitor pane is checked', () => {
  const s = snap([tab(1, BTOP_LABEL), tab(2, '2')], [monitor(1, 1), pane(2, 2)], [agent(2, 'sess-a')]);
  const { actions } = reconcileHerdrTabs(s, titles({ 'sess-a': 'Refactor the parser' }), {});
  assert.deepEqual(actions, [launch(1, 1), { kind: 'rename', tab_id: 'w1:t2', label: 'Refactor the parser' }]);
});

test('herdr tabs: btop is left alone entirely when the pass turns it off (no monitor on this machine)', () => {
  assert.deepEqual(reconcileHerdrTabs(snap([tab(1, '1')]), () => null, {}, { btop: false }).actions, []);
  assert.deepEqual(reconcileHerdrTabs(snap([tab(1, BTOP_LABEL)], [monitor(1, 1)]), () => null, {}, { btop: false }).actions, []);
});

test('herdr tabs: only the pane labelled btop is the monitor\'s — a pane split off beside it, or left when it closed, is the person\'s', () => {
  // The person split the btop tab; their pane is listed first.
  const split = snap([tab(1, BTOP_LABEL)], [pane(2, 1), monitor(1, 1)], [], [workspace('w1', 'home')]);
  assert.deepEqual(reconcileHerdrTabs(split, () => null, {}).actions, [launch(1, 1)]);
  // The monitor quit and herdr closed its pane: the person's pane is all that is left. It is never a
  // launch target; the driver may only adopt it if it runs the monitor (it does not), then makes a tab.
  const left = snap([tab(1, BTOP_LABEL)], [pane(2, 1)], [], [workspace('w1', 'home')]);
  assert.deepEqual(reconcileHerdrTabs(left, () => null, {}).actions,
    [{ kind: 'adopt-monitor', workspace_id: 'w1', tab_id: 'w1:t1', pane_id: 'w1:p2', label: BTOP_LABEL }]);
  // Two unlabelled panes: nothing there to adopt; a new btop tab is made.
  const two = snap([tab(1, BTOP_LABEL)], [pane(1, 1), pane(2, 1)], [], [workspace('w1', 'home')]);
  assert.deepEqual(reconcileHerdrTabs(two, () => null, {}).actions, [create()]);
  // An agent in the person's pane beside the monitor leaves the tab the monitor's, with its name.
  const beside = snap([tab(1, BTOP_LABEL)], [monitor(1, 1), { ...pane(2, 1), agent: 'claude' }], [agent(2, 'sess-a', 'w1', 'claude')], [workspace('w1', 'home')]);
  assert.deepEqual(reconcileHerdrTabs(beside, titles({ 'sess-a': 'Fix the sidebar' }), {}).actions, [launch(1, 1)]);
});

test('herdr tabs: a default-numbered tab is renamed to its session title', () => {
  const s = snap([tab(1, BTOP_LABEL), tab(2, '2')], [pane(2, 2)], [agent(2, 'sess-a')]);
  const { actions, owned } = reconcileHerdrTabs(s, titles({ 'sess-a': 'Add feature scaling' }), {}, { btop: false });
  assert.deepEqual(actions, [{ kind: 'rename', tab_id: 'w1:t2', label: 'Add feature scaling' }]);
  assert.equal(owned['w1:t2'], 'Add feature scaling');
});

test('herdr tabs: herdr numbers an unnamed tab by POSITION, not by its tab number — such a tab is renamed (2026-09-24)', () => {
  // A home workspace after a reboot: btop is tab #3, the person's tab is #8 in second place, so
  // herdr shows it as `2`. The rule "label === tab number" called that the person's own name.
  const s = snap([tab(3, BTOP_LABEL), tab(8, '2')], [monitor(3, 3), pane(8, 8)],
    [agent(8, 'fixture-session', 'w1', 'claude')], [workspace('w1', 'home')]);
  const { actions, owned } = reconcileHerdrTabs(s, titles({ 'fixture-session': 'Tune the fixture parser' }), {}, { btop: false });
  assert.deepEqual(actions, [{ kind: 'rename', tab_id: 'w1:t8', label: 'Tune the fixture parser' }]);
  assert.deepEqual(owned, { 'w1:t8': 'Tune the fixture parser' });
  // herdr 0.9.1's own listing after `tab.move` put tab #5 first: labels follow the listing order.
  const moved = snap([tab(5, '1'), tab(2, BTOP_LABEL), tab(3, '3'), tab(4, '4')], [pane(5, 5), monitor(2, 2), pane(3, 3), pane(4, 4)],
    [agent(5, 's5'), agent(3, 's3'), agent(4, 's4')]);
  assert.deepEqual(reconcileHerdrTabs(moved, titles({ s5: 'Five', s3: 'Three', s4: 'Four' }), {}, { btop: false }).actions.map(a => a.label), ['Five', 'Three', 'Four']);
});

test('herdr tabs: a number that is not the tab\'s position is a name somebody chose, and is left alone', () => {
  // herdr's own label for tab #2 in second place would be `2`: `2024` and `7` were typed by a person.
  for (const label of ['2024', '7']) {
    const s = snap([tab(1, BTOP_LABEL), tab(2, label)], [pane(2, 2)], [agent(2, 'sess-a')]);
    assert.deepEqual(reconcileHerdrTabs(s, titles({ 'sess-a': 'Add feature scaling' }), {}, { btop: false }).actions, [], label);
  }
});

test('herdr tabs: a tab the USER renamed is left alone', () => {
  // label is neither a number nor a value OAK owns → the user set it.
  const s = snap([tab(1, BTOP_LABEL), tab(2, 'my monitoring')], [pane(2, 2)], [agent(2, 'sess-a')]);
  const { actions, owned } = reconcileHerdrTabs(s, titles({ 'sess-a': 'Add feature scaling' }), {}, { btop: false });
  assert.deepEqual(actions, []);
  assert.equal('w1:t2' in owned, false, 'a user-renamed tab is not tracked as OAK-owned');
});

test('herdr tabs: a tab OAK previously named follows the session title when it changes', () => {
  const s = snap([tab(1, BTOP_LABEL), tab(2, 'Old title')], [pane(2, 2)], [agent(2, 'sess-a')]);
  const owned = { 'w1:t2': 'Old title' }; // OAK set it last time
  const { actions, owned: next } = reconcileHerdrTabs(s, titles({ 'sess-a': 'New better title' }), owned, { btop: false });
  assert.deepEqual(actions, [{ kind: 'rename', tab_id: 'w1:t2', label: 'New better title' }]);
  assert.equal(next['w1:t2'], 'New better title');
});

test('herdr tabs: a tab whose label already reads its session title is OAK\'s — kept, and followed when the title changes', () => {
  // Owned already, or named by another OAK (or by a rename that reported failure but landed).
  for (const owned of [{ 'w1:t2': 'Add scaling' }, {}]) {
    const s = snap([tab(1, BTOP_LABEL), tab(2, 'Add scaling')], [pane(2, 2)], [agent(2, 'sess-a')]);
    const now = reconcileHerdrTabs(s, titles({ 'sess-a': 'Add scaling' }), owned, { btop: false });
    assert.deepEqual(now.actions, []);
    assert.deepEqual(now.owned, { 'w1:t2': 'Add scaling' });
    const later = reconcileHerdrTabs(s, titles({ 'sess-a': 'Add scaling to the parser' }), now.owned, { btop: false });
    assert.deepEqual(later.actions, [{ kind: 'rename', tab_id: 'w1:t2', label: 'Add scaling to the parser' }]);
  }
});

test('herdr tabs: a tab with no joined session and no title is not touched', () => {
  const s = snap([tab(2, '2')], [pane(2, 2)], []); // pane has no agent
  const { actions } = reconcileHerdrTabs(s, () => 'anything', {});
  assert.deepEqual(actions.filter(a => a.kind === 'rename'), []);
});

test('herdr tabs: an empty/whitespace title is ignored', () => {
  const s = snap([tab(2, '2')], [pane(2, 2)], [agent(2, 'sess-a')]);
  const { actions } = reconcileHerdrTabs(s, titles({ 'sess-a': '   ' }), {});
  assert.deepEqual(actions.filter(a => a.kind === 'rename'), []);
});

test('herdr tabs: the btop tab belongs in the workspace labelled home — a btop elsewhere does not count, and is left alone', () => {
  const s = snap([tab(1, BTOP_LABEL, 'wA'), tab(1, '1', 'wH')], [monitor(1, 1, 'wA'), pane(1, 1, 'wH')], [],
    [workspace('wA', 'oak'), workspace('wH', 'Home')]);
  assert.deepEqual(reconcileHerdrTabs(s, () => null, {}).actions, [create('wH')]);
});

test('herdr tabs: without a home workspace, the btop tab lives in the first workspace', () => {
  const listed = snap([tab(1, '1', 'wX'), tab(1, '1', 'wY')], [], [], [workspace('wX', 'scratch'), workspace('wY', 'oak')]);
  assert.deepEqual(reconcileHerdrTabs(listed, () => null, {}).actions, [create('wX')]);
  const unlisted = snap([tab(1, '1', 'w1'), tab(1, '1', 'wW')]); // no workspace list: the first tab's workspace
  assert.deepEqual(reconcileHerdrTabs(unlisted, () => null, {}).actions, [create('w1')]);
});

test('herdr tabs: OAK never closes a tab — a second btop tab is left alone and the first one is the monitor', () => {
  const s = snap([tab(1, BTOP_LABEL), tab(2, BTOP_LABEL)], [monitor(1, 1), monitor(2, 2)], [], [workspace('w1', 'home')]);
  assert.deepEqual(reconcileHerdrTabs(s, () => null, {}).actions, [launch(1, 1)]);
});

test('herdr tabs: a btop tab an agent took over is never the monitor — a fresh btop tab is made, and the taken tab follows its session', () => {
  const s = snap([tab(1, BTOP_LABEL)], [{ ...monitor(1, 1), agent: 'claude' }], [agent(1, 'sess-a', 'w1', 'claude')], [workspace('w1', 'home')]);
  const titled = reconcileHerdrTabs(s, titles({ 'sess-a': 'Fix the sidebar' }), {});
  assert.deepEqual(titled.actions, [create(), { kind: 'rename', tab_id: 'w1:t1', label: 'Fix the sidebar' }]);
  assert.deepEqual(titled.owned, { 'w1:t1': 'Fix the sidebar' });
  // No title yet: the agent's kind names the tab, so two tabs never both read `btop`.
  const untitled = reconcileHerdrTabs(s, titles({}), {});
  assert.deepEqual(untitled.actions, [create(), { kind: 'rename', tab_id: 'w1:t1', label: 'claude' }]);
  // herdr detected the agent (a pane `agent`) before any session joined: same answer.
  const detected = reconcileHerdrTabs(snap([tab(1, BTOP_LABEL)], [{ ...monitor(1, 1), agent: 'codex' }], [], [workspace('w1', 'home')]), titles({}), {});
  assert.deepEqual(detected.actions.map(a => a.kind === 'rename' ? a.label : a.kind), ['create-btop', 'codex']);
  // An agent herdr reports without a kind still holds the tab; with no title there is nothing to name it by.
  const unknown = reconcileHerdrTabs(snap([tab(1, BTOP_LABEL)], [monitor(1, 1)], [agent(1, 'sess-a')], [workspace('w1', 'home')]), titles({}), {});
  assert.deepEqual(unknown.actions, [create()]);
  // A btop tab from before OAK labelled panes, with an agent in it: taken the same way.
  const old = reconcileHerdrTabs(snap([tab(1, BTOP_LABEL)], [{ ...pane(1, 1), agent: 'claude' }], [], [workspace('w1', 'home')]), titles({}), {});
  assert.deepEqual(old.actions, [create(), { kind: 'rename', tab_id: 'w1:t1', label: 'claude' }]);
  // The kind is a placeholder: once the session has a title, the tab follows it.
  const later = reconcileHerdrTabs(snap([tab(1, 'claude'), tab(2, BTOP_LABEL)], [{ ...monitor(1, 1), agent: 'claude' }, monitor(2, 2)],
    [agent(1, 'sess-a', 'w1', 'claude')], [workspace('w1', 'home')]), titles({ 'sess-a': 'Fix the sidebar' }), untitled.owned);
  assert.deepEqual(later.actions, [launch(2, 2), { kind: 'rename', tab_id: 'w1:t1', label: 'Fix the sidebar' }]);
});

test('herdr tabs: OAK keeps its claim on a tab it named while the pane has no session or no title yet', () => {
  // Session A was titled and the tab renamed; then claude restarted in the pane as session B, which has
  // no title for a while. Dropping the claim in that gap left the tab wearing A's title forever.
  const owned = { 'w1:t2': 'Refactor the parser' };
  const s = snap([tab(1, BTOP_LABEL), tab(2, 'Refactor the parser')], [pane(2, 2)], [agent(2, 'sess-b')]);
  const untitled = reconcileHerdrTabs(s, titles({}), owned, { btop: false });
  assert.deepEqual(untitled.actions, [], 'nothing to rename yet');
  assert.deepEqual(untitled.owned, owned, 'the claim survives the gap');
  // No session in the pane at all (the agent exited): the claim survives too.
  const empty = reconcileHerdrTabs(snap([tab(1, BTOP_LABEL), tab(2, 'Refactor the parser')], [pane(2, 2)], []), titles({}), owned, { btop: false });
  assert.deepEqual(empty.owned, owned);
  // Once B has a title, the tab follows it.
  const titled = reconcileHerdrTabs(s, titles({ 'sess-b': 'Fix the sidebar' }), untitled.owned, { btop: false });
  assert.deepEqual(titled.actions, [{ kind: 'rename', tab_id: 'w1:t2', label: 'Fix the sidebar' }]);
  assert.deepEqual(titled.owned, { 'w1:t2': 'Fix the sidebar' });
  // A tab the PERSON renamed meanwhile is theirs: the claim lapses.
  const theirs = reconcileHerdrTabs(snap([tab(1, BTOP_LABEL), tab(2, 'my notes')], [pane(2, 2)], [agent(2, 'sess-b')]), titles({ 'sess-b': 'Fix the sidebar' }), owned, { btop: false });
  assert.deepEqual(theirs.actions, []);
  assert.deepEqual(theirs.owned, {});
});

test('herdr tabs: a tab labelled with the agent kind (what `oak agent start` gives it) is renamed to the session title (2026-09-23)', () => {
  const s = snap([tab(1, BTOP_LABEL), tab(2, 'claude'), tab(3, 'Codex')], [pane(2, 2), pane(3, 3)], [agent(2, 'sess-a'), agent(3, 'sess-b')]);
  const { actions, owned } = reconcileHerdrTabs(s, titles({ 'sess-a': 'Fix the sidebar', 'sess-b': 'Port the feed' }), {}, { btop: false });
  assert.deepEqual(actions, [{ kind: 'rename', tab_id: 'w1:t2', label: 'Fix the sidebar' }, { kind: 'rename', tab_id: 'w1:t3', label: 'Port the feed' }]);
  assert.deepEqual(owned, { 'w1:t2': 'Fix the sidebar', 'w1:t3': 'Port the feed' });
  // A label the person chose is still theirs.
  const theirs = reconcileHerdrTabs(snap([tab(1, BTOP_LABEL), tab(2, 'my notes')], [pane(2, 2)], [agent(2, 'sess-a')]), titles({ 'sess-a': 'Fix the sidebar' }), {}, { btop: false });
  assert.deepEqual(theirs.actions, []);
});

test('herdr tabs: a tab labelled with its agent\'s own terminal title follows the session title, with no record of OAK naming it (2026-09-27)', () => {
  // Claude Code titles its terminal with its ai-title. OAK named the tab with it before claude.ai's
  // title for the session arrived, and the record of that was lost.
  const titled = (n, tabN, title) => ({ ...pane(n, tabN), terminal_title_stripped: title });
  const s = snap([tab(1, BTOP_LABEL), tab(2, 'Claude Code UI bugs')], [titled(2, 2, 'Claude Code UI bugs')], [agent(2, 'sess-a')]);
  const { actions, owned } = reconcileHerdrTabs(s, titles({ 'sess-a': 'Cursor and panel issues' }), {}, { btop: false });
  assert.deepEqual(actions, [{ kind: 'rename', tab_id: 'w1:t2', label: 'Cursor and panel issues' }]);
  assert.deepEqual(owned, { 'w1:t2': 'Cursor and panel issues' });
  // A label the person chose stays theirs, whatever the terminal title reads.
  const theirs = snap([tab(1, BTOP_LABEL), tab(2, 'my notes')], [titled(2, 2, 'Claude Code UI bugs')], [agent(2, 'sess-a')]);
  assert.deepEqual(reconcileHerdrTabs(theirs, titles({ 'sess-a': 'Cursor and panel issues' }), {}, { btop: false }).actions, []);
  // Only the pane holding the session speaks for it: a shell beside it, titled like the tab, does not.
  const shell = snap([tab(1, BTOP_LABEL), tab(2, 'user@host: ~')], [titled(3, 2, 'user@host: ~'), titled(2, 2, 'Claude Code UI bugs')], [agent(2, 'sess-a')]);
  assert.deepEqual(reconcileHerdrTabs(shell, titles({ 'sess-a': 'Cursor and panel issues' }), {}, { btop: false }).actions, []);
});

test('herdr tabs: a claim made from a title read after the pass\'s list is left as it is until the list catches up', () => {
  // The terminal app read its list at 100. The session's own sync read a newer title at 150, renamed the
  // tab and claimed it. The app's next pass still has the list from 100: renaming by it put the old
  // title back until the list refreshed.
  const s = snap([tab(1, BTOP_LABEL), tab(2, 'New title')], [pane(2, 2)], [agent(2, 'sess-a')]);
  const owned = { 'w1:t2': 'New title' };
  const claimedAt = { 'w1:t2': 150 };
  assert.deepEqual(reconcileHerdrTabs(s, titles({ 'sess-a': 'Old title' }), owned, { btop: false, claimedAt, listedAt: 100 }), { actions: [], owned });
  // A snapshot from before the sync's rename still shows the placeholder: the newer claim holds there too.
  const stale = snap([tab(1, BTOP_LABEL), tab(2, '2')], [pane(2, 2)], [agent(2, 'sess-a')]);
  assert.deepEqual(reconcileHerdrTabs(stale, titles({ 'sess-a': 'Old title' }), owned, { btop: false, claimedAt, listedAt: 100 }), { actions: [], owned });
  // A list read after the claim's title (or at the same moment) names the tab, as ever.
  for (const listedAt of [150, 200]) {
    assert.deepEqual(reconcileHerdrTabs(s, titles({ 'sess-a': 'Newer title' }), owned, { btop: false, claimedAt, listedAt }),
      { actions: [{ kind: 'rename', tab_id: 'w1:t2', label: 'Newer title' }], owned: { 'w1:t2': 'Newer title' } }, String(listedAt));
  }
  // A claim with no time, or a pass that cannot say when its list was read: as before.
  assert.equal(reconcileHerdrTabs(s, titles({ 'sess-a': 'Old title' }), owned, { btop: false, listedAt: 100 }).actions.length, 1);
  assert.equal(reconcileHerdrTabs(s, titles({ 'sess-a': 'Old title' }), owned, { btop: false, claimedAt }).actions.length, 1);
  // A label the person chose ends the claim, however new.
  const theirs = snap([tab(1, BTOP_LABEL), tab(2, 'my notes')], [pane(2, 2)], [agent(2, 'sess-a')]);
  assert.deepEqual(reconcileHerdrTabs(theirs, titles({ 'sess-a': 'Old title' }), owned, { btop: false, claimedAt, listedAt: 100 }), { actions: [], owned: {} });
});

test('herdr tabs: a pane counts as idle only while a POSIX shell itself holds the foreground (herdr pane.process_info)', () => {
  assert.equal(paneForeground(processInfo.idle('p')), 'idle');
  assert.equal(paneForeground(processInfo.idle('p', 'bash')), 'idle');
  // macOS login shells: argv0 `-zsh`; herdr reports the name with or without the dash.
  assert.equal(paneForeground({ ...processInfo.idle('p'), foreground_processes: [{ pid: 100, name: '-zsh', argv: ['-zsh'] }] }), 'idle');
  assert.equal(paneForeground(processInfo.running('p')), 'busy', 'a command in the foreground');
  assert.equal(paneForeground(processInfo.running('p', 'claude')), 'busy', 'an agent in the foreground');
  // The shell is the group leader but a child shares its group (a command substitution in the rc files).
  assert.equal(paneForeground({ ...processInfo.idle('p'), foreground_processes: [{ pid: 100, name: 'zsh' }, { pid: 101, name: 'python3' }] }), 'busy');
  assert.equal(paneForeground(processInfo.replaced('p')), 'replaced', 'the shell exec\'d the monitor (Linux)');
  assert.equal(paneForeground(processInfo.replaced('p', 'python3.10')), 'replaced', 'bpytop on macOS reports as the interpreter');
  assert.equal(paneForeground(processInfo.idle('p', 'fish')), 'replaced', 'not a POSIX shell: the launch line is not its syntax');
  for (const missing of [undefined, null, {}, { shell_pid: 100 }, { ...processInfo.idle('p'), foreground_processes: [] }]) {
    assert.equal(paneForeground(missing), 'busy', JSON.stringify(missing));
  }
});

// --- the driver, against a scripted herdr ------------------------------------------------------------

let terminals = 0;
/** Unique per use: OAK remembers the terminals it typed into for the life of the process. */
const terminal = () => `term-fixture-${++terminals}`;
const homeSnap = (tabs, panes, agents = []) => snap(tabs, panes, agents, [workspace('w1', 'home')]);
const fast = { readyMs: 400, confirmMs: 20, pollMs: 10, recreateMs: 0 };
function pass(herdr, snapshot, extra = {}) {
  herdr.snapshot = snapshot; // the server, as the pass's snapshot shows it, when the driver reads it again
  return ensureHerdrTabs({ snapshot, titleOf: () => undefined, monitor: '/usr/bin/htop', timing: fast, transport,
    herdrOptions: { socketPath: herdr.socketPath, binary: herdr.binary, timeoutMs: 5000 }, ...extra });
}
const ok = () => ({ type: 'ok' });
const created = (tabId, paneId, term) => () => ({ type: 'tab_created', tab: { tab_id: tabId, workspace_id: 'w1', number: 9, label: BTOP_LABEL }, root_pane: { pane_id: paneId, tab_id: tabId, terminal_id: term } });
const labelled = ({ pane_id, label }) => ({ type: 'pane_info', pane: { pane_id, label } });

test('herdr tabs driver: an idle shell in the btop tab gets the monitor — once per terminal, again after herdr restores the pane', async t => {
  const herdr = await fakeHerdr(t, { 'pane.process_info': scripted({ 'w1:p1': [processInfo.idle('w1:p1')] }), 'pane.send_text': ok });
  if (!herdr) return;
  const first = homeSnap([tab(1, BTOP_LABEL)], [{ ...monitor(1, 1), terminal_id: terminal() }]);
  const done = await pass(herdr, first);
  assert.deepEqual(herdr.sent(), [{ pane_id: 'w1:p1', text: MONITOR_LAUNCH }]);
  assert.deepEqual(done, [launch(1, 1)]);
  assert.equal(herdr.calls('pane.process_info').length, 2, 'idle, and still idle a moment later');
  // Still idle on the next pass (no monitor installed there, say): never typed into twice.
  await pass(herdr, first);
  assert.equal(herdr.sent().length, 1);
  // herdr restored the pane (new terminal, same pane id and label): its shell gets the monitor again.
  await pass(herdr, homeSnap([tab(1, BTOP_LABEL)], [{ ...monitor(1, 1), terminal_id: terminal() }]));
  assert.equal(herdr.sent().length, 2);
});

test('herdr tabs driver: a btop tab an agent took over gets no keys; a fresh btop tab is made at the front, its pane labelled, and gets the monitor', async t => {
  const herdr = await fakeHerdr(t, {
    'pane.process_info': scripted({ 'w1:p9': [processInfo.idle('w1:p9')] }),
    'tab.create': created('w1:t9', 'w1:p9', terminal()), 'pane.rename': labelled, 'tab.move': ok, 'tab.rename': ok, 'pane.send_text': ok,
  });
  if (!herdr) return;
  const s = homeSnap([tab(1, BTOP_LABEL)], [{ ...monitor(1, 1), agent: 'claude', terminal_id: terminal() }], [agent(1, 'sess-a', 'w1', 'claude')]);
  await pass(herdr, s, { titleOf: titles({ 'sess-a': 'Fix the sidebar' }) });
  assert.deepEqual(herdr.calls('tab.create'), [{ workspace_id: 'w1', label: BTOP_LABEL }]);
  assert.deepEqual(herdr.calls('pane.rename'), [{ pane_id: 'w1:p9', label: BTOP_LABEL }]);
  assert.deepEqual(herdr.calls('tab.move'), [{ tab_id: 'w1:t9', insert_index: 0 }]);
  assert.deepEqual(herdr.sent(), [{ pane_id: 'w1:p9', text: MONITOR_LAUNCH }], 'only the new pane is typed into');
  assert.ok(herdr.calls('pane.process_info').every(p => p.pane_id === 'w1:p9'), 'the agent\'s pane is not even probed');
  assert.deepEqual(herdr.calls('tab.rename'), [{ tab_id: 'w1:t1', label: 'Fix the sidebar' }]);
});

test('herdr tabs driver: the person\'s shell left in a btop tab (the monitor pane closed) is never typed into — a new btop tab is made', async t => {
  const herdr = await fakeHerdr(t, {
    'pane.process_info': scripted({ 'w1:p2': [processInfo.idle('w1:p2')], 'w1:p9': [processInfo.idle('w1:p9')] }),
    'tab.create': created('w1:t9', 'w1:p9', terminal()), 'pane.rename': labelled, 'tab.move': ok, 'pane.send_text': ok,
  });
  if (!herdr) return;
  await pass(herdr, homeSnap([tab(1, BTOP_LABEL)], [{ ...pane(2, 1), terminal_id: terminal() }]));
  assert.deepEqual(herdr.sent(), [{ pane_id: 'w1:p9', text: MONITOR_LAUNCH }]);
  assert.deepEqual(herdr.calls('pane.rename'), [{ pane_id: 'w1:p9', label: BTOP_LABEL }], 'the person\'s pane is not labelled');
});

test('herdr tabs driver: a btop tab from before OAK labelled panes is adopted while its one pane runs the monitor', async t => {
  const herdr = await fakeHerdr(t, { 'pane.process_info': scripted({ 'w1:p1': [processInfo.replaced('w1:p1')] }), 'pane.rename': labelled });
  if (!herdr) return;
  const term = terminal();
  const done = await pass(herdr, homeSnap([tab(1, BTOP_LABEL)], [{ ...pane(1, 1), terminal_id: term }]));
  assert.deepEqual(done, [{ kind: 'adopt-monitor', workspace_id: 'w1', tab_id: 'w1:t1', pane_id: 'w1:p1', label: BTOP_LABEL }]);
  assert.deepEqual(herdr.calls('pane.rename'), [{ pane_id: 'w1:p1', label: BTOP_LABEL }]);
  // Labelled now, and known to run the monitor: later passes leave it alone without probing.
  await pass(herdr, homeSnap([tab(1, BTOP_LABEL)], [{ ...monitor(1, 1), terminal_id: term }]));
  assert.deepEqual(herdr.requests.map(r => r.method), ['pane.process_info', 'pane.rename']);
});

test('herdr tabs driver: a missing btop tab is made, and the monitor is typed only once its new shell reaches the prompt', async t => {
  const fresh = terminal();
  const herdr = await fakeHerdr(t, {
    // The new shell is still running its rc files (a child in the foreground), then idles.
    'pane.process_info': scripted({ 'w1:p9': [processInfo.running('w1:p9', 'python3'), processInfo.running('w1:p9', 'python3'), processInfo.idle('w1:p9')] }),
    'tab.create': created('w1:t9', 'w1:p9', fresh), 'pane.rename': labelled, 'tab.move': ok, 'pane.send_text': ok,
  });
  if (!herdr) return;
  const done = await pass(herdr, homeSnap([tab(1, '1')], [pane(1, 1)]));
  assert.deepEqual(done.map(a => a.kind), ['create-btop', 'launch-monitor']);
  assert.equal(herdr.calls('pane.process_info').length, 3);
  assert.deepEqual(herdr.sent(), [{ pane_id: 'w1:p9', text: MONITOR_LAUNCH }]);
  // Each pass, not once per run: the tab is gone again (the monitor quit and herdr closed it) → made again.
  await pass(herdr, homeSnap([tab(1, '1')], [pane(1, 1)]));
  assert.equal(herdr.calls('tab.create').length, 2);
});

test('herdr tabs driver: a new btop tab whose pane could not be labelled still gets the monitor (adopted on a later pass)', async t => {
  const herdr = await fakeHerdr(t, {
    'tab.create': created('w1:t9', 'w1:p9', terminal()), 'pane.rename': () => { throw new Error('herdr is busy'); },
    'tab.move': ok, 'pane.process_info': scripted({ 'w1:p9': [processInfo.idle('w1:p9')] }), 'pane.send_text': ok,
  });
  if (!herdr) return;
  await pass(herdr, homeSnap([tab(1, '1')], [pane(1, 1)]));
  assert.deepEqual(herdr.sent(), [{ pane_id: 'w1:p9', text: MONITOR_LAUNCH }]);
});

test('herdr tabs driver: a monitor that dies at once is not re-made more than once per recreate interval', async t => {
  const herdr = await fakeHerdr(t, { 'tab.create': created('w1:t9', 'w1:p9', terminal()), 'pane.rename': labelled, 'tab.move': ok, 'pane.process_info': scripted({}) });
  if (!herdr) return;
  const missing = homeSnap([tab(1, '1')], [pane(1, 1)]);
  // Its own machine key: the interval is kept per machine for the life of the process.
  const slow = { ...fast, readyMs: 0, recreateMs: 60000 };
  for (let i = 0; i < 3; i++) await pass(herdr, missing, { machine: 'backoff-box', monitor: null, timing: slow });
  assert.equal(herdr.calls('tab.create').length, 1);
});

test('herdr tabs driver: nothing is typed into a btop pane running anything else', async t => {
  const herdr = await fakeHerdr(t, {
    'pane.process_info': scripted({ 'w1:p1': [processInfo.running('w1:p1', 'vim')], 'w1:p2': [processInfo.replaced('w1:p2')] }),
    'pane.send_text': ok,
  });
  if (!herdr) return;
  const busy = homeSnap([tab(1, BTOP_LABEL)], [{ ...monitor(1, 1), terminal_id: terminal() }]);
  assert.deepEqual(await pass(herdr, busy), []);
  assert.deepEqual(await pass(herdr, busy), [], 'checked again next pass, still nothing typed');
  assert.equal(herdr.calls('pane.process_info').length, 2);
  // The monitor already owns the pane (exec'd into the shell): nothing typed, and never probed again.
  const running = homeSnap([tab(2, BTOP_LABEL)], [{ ...monitor(2, 2), terminal_id: terminal() }]);
  await pass(herdr, running);
  await pass(herdr, running);
  assert.equal(herdr.calls('pane.process_info').length, 3);
  assert.deepEqual(herdr.sent(), []);
});

test('herdr tabs driver: an idle btop shell that stops being idle a moment later (another launcher got there first) gets nothing', async t => {
  const herdr = await fakeHerdr(t, { 'pane.process_info': scripted({ 'w1:p1': [processInfo.idle('w1:p1'), processInfo.replaced('w1:p1')] }), 'pane.send_text': ok });
  if (!herdr) return;
  await pass(herdr, homeSnap([tab(1, BTOP_LABEL)], [{ ...monitor(1, 1), terminal_id: terminal() }]));
  assert.deepEqual(herdr.sent(), []);
});

test('herdr tabs driver: two passes at once type the launch line once', async t => {
  const herdr = await fakeHerdr(t, { 'pane.process_info': scripted({ 'w1:p1': [processInfo.idle('w1:p1')] }), 'pane.send_text': ok });
  if (!herdr) return;
  const s = homeSnap([tab(1, BTOP_LABEL)], [{ ...monitor(1, 1), terminal_id: terminal() }]);
  await Promise.all([pass(herdr, s), pass(herdr, s), pass(herdr, s)]);
  assert.equal(herdr.sent().length, 1);
});

test('herdr tabs driver: a failed rename keeps OAK\'s claim, so the next pass renames the tab', async t => {
  let fail = true;
  const herdr = await fakeHerdr(t, { 'tab.rename': () => { if (fail) throw Object.assign(new Error('herdr is busy'), { code: 'busy' }); return ok(); } });
  if (!herdr) return;
  const titleOf = titles({ 'sess-a': 'Fix the sidebar and header' });
  // OAK named the tab `Fix the sidebar` earlier; the session's title changed since.
  const s = homeSnap([tab(1, 'Fix the sidebar')], [pane(1, 1)], [agent(1, 'sess-a')]);
  fs.mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'claude-observatory'), { recursive: true });
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'claude-observatory', 'herdr-tabs.json'), JSON.stringify({ local: { 'w1:t1': 'Fix the sidebar' } }));
  assert.deepEqual(await pass(herdr, s, { monitor: null, titleOf }), []);
  fail = false;
  assert.deepEqual(await pass(herdr, s, { monitor: null, titleOf }), [{ kind: 'rename', tab_id: 'w1:t1', label: 'Fix the sidebar and header' }]);
});

test('herdr tabs driver: the local server without a monitor is left alone; renames still happen', async t => {
  const herdr = await fakeHerdr(t, { 'tab.rename': ok });
  if (!herdr) return;
  const s = homeSnap([tab(1, '1')], [pane(1, 1)], [agent(1, 'sess-a')]);
  const done = await pass(herdr, s, { monitor: null, titleOf: titles({ 'sess-a': 'Port the feed' }) });
  assert.deepEqual(done, [{ kind: 'rename', tab_id: 'w1:t1', label: 'Port the feed' }]);
  assert.deepEqual(herdr.requests.map(r => r.method), ['tab.rename']);
});

test('herdr tabs driver: a saved machine gets the same rules over herdr\'s CLI (`--machine`)', async t => {
  const herdr = await fakeHerdr(t, {
    'pane.process_info': scripted({ 'w1:p9': [processInfo.idle('w1:p9')] }),
    'tab.create': created('w1:t9', 'w1:p9', terminal()), 'pane.rename': labelled, 'tab.rename': ok, 'pane.send_text': ok,
  });
  if (!herdr) return;
  const s = homeSnap([tab(1, BTOP_LABEL)], [{ ...monitor(1, 1), agent: 'claude', terminal_id: terminal() }], [agent(1, 'sess-a', 'w1', 'claude')]);
  // A saved machine needs no local monitor: its own shell resolves one.
  await pass(herdr, s, { machine: 'build-box', monitor: null });
  assert.deepEqual(herdr.requests.map(r => [r.method, r.params.machine]), [
    // The server is asked again right before a tab is made (another OAK may have just made one).
    ['session.snapshot', 'build-box'], ['tab.create', 'build-box'], ['pane.rename', 'build-box'], ['pane.process_info', 'build-box'], ['pane.send_text', 'build-box'], ['tab.rename', 'build-box'],
  ]);
  assert.deepEqual(herdr.sent(), [{ pane_id: 'w1:p9', text: MONITOR_LAUNCH, machine: 'build-box' }]);
  assert.deepEqual(herdr.calls('pane.rename'), [{ pane_id: 'w1:p9', label: BTOP_LABEL, machine: 'build-box' }]);
  assert.deepEqual(herdr.calls('tab.rename'), [{ tab_id: 'w1:t1', label: 'claude', machine: 'build-box' }]);
});

// Two OAKs reconciling one server — two terminals on this machine, or this one and `oak attach`'s — each
// made a btop tab from the same snapshot, and OAK never closes one, so the duplicate stayed.
// Each OAK is its own process: its own module state, one store.
test('herdr tabs driver: two OAKs reconciling one server at once make one btop tab, not two (2026-09-26)', async t => {
  const tabs = [tab(1, '1')];
  let made = 0;
  const herdr = await fakeHerdr(t, {
    // The server as it is NOW: a tab one OAK made is there when the other asks.
    'session.snapshot': () => ({ type: 'session_snapshot', snapshot: { version: '0.9.1', protocol: 22, ...homeSnap(tabs, [pane(1, 1)]) } }),
    'tab.create': () => {
      made++;
      tabs.push(tab(8 + made, BTOP_LABEL));
      return { type: 'tab_created', tab: { tab_id: `w1:t${8 + made}`, workspace_id: 'w1', number: 8 + made, label: BTOP_LABEL }, root_pane: { pane_id: `w1:p${8 + made}`, tab_id: `w1:t${8 + made}`, terminal_id: terminal() } };
    },
    'pane.rename': labelled, 'tab.move': ok, 'pane.process_info': scripted({}),
  });
  if (!herdr) return;
  const modulePath = require.resolve('../dist/herdr-tabs');
  delete require.cache[modulePath];
  const other = require('../dist/herdr-tabs');
  const stale = homeSnap([tab(1, '1')], [pane(1, 1)]);
  const run = drive => drive({ snapshot: stale, titleOf: () => undefined, monitor: '/usr/bin/htop', transport, timing: { ...fast, readyMs: 0 },
    herdrOptions: { socketPath: herdr.socketPath, binary: herdr.binary, timeoutMs: 5000 } });
  await Promise.all([run(ensureHerdrTabs), run(other.ensureHerdrTabs)]);
  assert.equal(made, 1, 'one btop tab');
  // Control: once it is gone, the next pass makes it again.
  tabs.splice(1);
  await run(ensureHerdrTabs);
  assert.equal(made, 2, 'a missing btop tab is made again');
});

// Another OAK's new btop tab, seen between its `tab.create` and the `pane.rename` that labels its pane
// (seconds on a saved machine), is an unlabelled btop tab whose shell is not the monitor. Taken for a
// person's at once, it got a second btop tab beside it, and OAK never closes one.
test('herdr tabs driver: another OAK\'s btop tab seen before its pane is labelled gets no second tab; a bare shell that stays gets one', async t => {
  const herdr = await fakeHerdr(t, {
    'pane.process_info': scripted({ 'w1:p8': [processInfo.idle('w1:p8')], 'w1:p9': [processInfo.idle('w1:p9')] }),
    'tab.create': created('w1:t9', 'w1:p9', terminal()), 'pane.rename': labelled, 'tab.move': ok, 'pane.send_text': ok,
  });
  if (!herdr) return;
  // Its own machine key: the grace and the recreate interval are kept per machine for the life of the process.
  const grace = { machine: 'grace-box', timing: { ...fast, readyMs: 0, recreateMs: 300 } };
  const term = terminal();
  const making = homeSnap([tab(1, '1'), tab(8, BTOP_LABEL)], [pane(1, 1), { ...pane(8, 8), terminal_id: term }]);
  assert.deepEqual(await pass(herdr, making, grace), [], 'mid-create, nothing is made');
  // The other OAK labels its pane: from then on it is the monitor's tab.
  await pass(herdr, homeSnap([tab(1, '1'), tab(8, BTOP_LABEL)], [pane(1, 1), { ...monitor(8, 8), terminal_id: term }]), grace);
  assert.equal(herdr.calls('tab.create').length, 0, 'one btop tab');
  // Control: a bare shell that stays unlabelled past the grace is a person's, and a btop tab is made beside it.
  const person = homeSnap([tab(1, '1'), tab(8, BTOP_LABEL)], [pane(1, 1), { ...pane(8, 8), terminal_id: terminal() }]);
  await pass(herdr, person, grace);
  assert.equal(herdr.calls('tab.create').length, 0, 'not at first sight');
  await new Promise(resolve => setTimeout(resolve, 350));
  await pass(herdr, person, grace);
  assert.equal(herdr.calls('tab.create').length, 1, 'but once it has stayed a bare shell past the grace');
});

test('herdr tabs driver: a store that cannot take the create lock still makes the btop tab, in one try (2026-09-26)', async t => {
  // A full or read-only store refuses the lock file for a reason other than a lock someone holds. The
  // pass then runs unlocked, as before the lock existed. Retrying such a file never yielded to the event
  // loop, so the pass spun and froze the TUI.
  const tabs = [tab(1, '1')];
  let made = 0;
  const herdr = await fakeHerdr(t, {
    'session.snapshot': () => ({ type: 'session_snapshot', snapshot: { version: '0.9.1', protocol: 22, ...homeSnap(tabs, [pane(1, 1)]) } }),
    'tab.create': () => {
      made++;
      tabs.push(tab(9, BTOP_LABEL));
      return { type: 'tab_created', tab: { tab_id: 'w1:t9', workspace_id: 'w1', number: 9, label: BTOP_LABEL }, root_pane: { pane_id: 'w1:p9', tab_id: 'w1:t9', terminal_id: terminal() } };
    },
    'pane.rename': labelled, 'tab.move': ok, 'pane.process_info': scripted({}),
  });
  if (!herdr) return;
  let tries = 0;
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', function (file, ...rest) {
    // After 50 refusals the store "recovers", so a build that retries cannot hang this test. The btop
    // create lock only: the ownership record has a lock of its own.
    if (/^herdr-btop\..*\.lock$/.test(path.basename(String(file))) && ++tries <= 50) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    return write.call(this, file, ...rest);
  });
  await ensureHerdrTabs({ snapshot: homeSnap([tab(1, '1')], [pane(1, 1)]), titleOf: () => undefined, monitor: '/usr/bin/htop', transport,
    timing: { ...fast, readyMs: 0 }, herdrOptions: { socketPath: herdr.socketPath, binary: herdr.binary, timeoutMs: 5000 } });
  assert.equal(made, 1, 'the btop tab is made');
  assert.equal(tries, 1, 'one refused lock, then unlocked');
});

test('herdr tabs driver: a create lock that is being written, or cannot be removed, is waited out, never spun on (2026-09-26)', async t => {
  const tabs = [tab(1, '1')];
  let made = 0;
  const herdr = await fakeHerdr(t, {
    'session.snapshot': () => ({ type: 'session_snapshot', snapshot: { version: '0.9.1', protocol: 22, ...homeSnap(tabs, [pane(1, 1)]) } }),
    'tab.create': () => {
      made++;
      tabs.push(tab(9, BTOP_LABEL));
      return { type: 'tab_created', tab: { tab_id: 'w1:t9', workspace_id: 'w1', number: 9, label: BTOP_LABEL }, root_pane: { pane_id: 'w1:p9', tab_id: 'w1:t9', terminal_id: terminal() } };
    },
    'pane.rename': labelled, 'tab.move': ok, 'pane.process_info': scripted({}),
  });
  if (!herdr) return;
  const lock = path.join(require('../dist/store').rootDir(), 'herdr-btop.local.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  t.after(() => fs.rmSync(lock, { force: true }));
  const pass = () => ensureHerdrTabs({ snapshot: homeSnap([tab(1, '1')], [pane(1, 1)]), titleOf: () => undefined, monitor: '/usr/bin/htop', transport,
    timing: { ...fast, readyMs: 0, lockMs: 300 }, herdrOptions: { socketPath: herdr.socketPath, binary: herdr.binary, timeoutMs: 5000 } });
  // An empty lock is one another OAK has just created and not yet written: it is held, not dead.
  fs.writeFileSync(lock, '');
  await pass();
  assert.equal(made, 0, 'no tab while another OAK holds the lock');
  assert.ok(fs.existsSync(lock), 'and its fresh lock is left alone');
  // A dead holder's lock on a store that cannot delete it (read-only now) is waited out, not retried
  // at once forever. After 50 refusals the delete "works", so a build that spins cannot hang this test.
  fs.writeFileSync(lock, '999999999:0.5');
  let removes = 0;
  const unlink = fs.unlinkSync;
  const refuse = t.mock.method(fs, 'unlinkSync', function (file, ...rest) {
    if (String(file) === lock && ++removes <= 50) throw Object.assign(new Error('read-only file system'), { code: 'EROFS' });
    return unlink.call(this, file, ...rest);
  });
  const started = Date.now();
  await pass();
  assert.equal(made, 0, 'no tab while the dead lock cannot go');
  assert.ok(removes >= 2 && removes <= 10, `one try per wait, within the wait (${removes})`);
  assert.ok(Date.now() - started < 3000, 'the wait is bounded');
  // Control: with the lock gone, the same pass makes the tab.
  refuse.mock.restore();
  fs.rmSync(lock);
  await pass();
  assert.equal(made, 1, 'the btop tab is made once the lock is free');
});

// --- a session's own tab sync: `oak __tab-sync`, started by its hooks and its status line (2026-09-27) ---
// The user runs Claude Code and Codex straight in herdr panes and seldom opens the terminal app, whose pass
// was the only thing that renamed tabs: a tab kept its first name while its session's title moved on.

const { syncSessionTab } = require('../dist/herdr-tabs');
const { linkHerdrPane, kickTabSync, TAB_SYNC_KICK_MS } = require('../dist/herdr-link');
const { rootDir, storeDir } = require('../dist/store');
const { setOakCliEntry } = require('../dist/cli-entry');
const spawn = require('../dist/spawn');
const OAK = path.resolve(__dirname, '../../cli/dist/index.js');
const record = () => path.join(rootDir(), 'herdr-tabs.json');
const owned = () => { try { return JSON.parse(fs.readFileSync(record(), 'utf8')); } catch { return {}; } };
/** Forget every claim: each test below starts from a record no other test wrote. */
const resetOwned = () => fs.rmSync(record(), { force: true });
/** Record `session`'s pane link the way its capture hook does inside herdr. */
function linkPane(session, paneId, socketPath) {
  const saved = { HERDR_PANE_ID: process.env.HERDR_PANE_ID, HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH };
  Object.assign(process.env, { HERDR_PANE_ID: paneId, HERDR_SOCKET_PATH: socketPath });
  try { linkHerdrPane(session); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const syncOf = herdr => (session, title) => syncSessionTab({ session, title, transport, herdrOptions: { timeoutMs: 5000 } });
const until = async (check, ms = 10000) => { for (const end = Date.now() + ms; !check() && Date.now() < end;) await new Promise(r => setTimeout(r, 50)); return check(); };

test('herdr tab sync: a session\'s own sync names its tab after its title and follows a new one, leaving btop, every other tab and a person\'s label alone', async t => {
  const herdr = await fakeHerdr(t, { 'tab.rename': ok });
  if (!herdr) return;
  resetOwned();
  // btop's tab (its monitor idle), this session's tab under herdr's own number, another session's numbered
  // tab, a tab a person named, and a second `btop` tab an agent took over. The terminal app's pass WOULD
  // rename that one (to its agent's kind) and claim it.
  const layout = mine => homeSnap([tab(1, BTOP_LABEL), tab(2, mine), tab(3, '3'), tab(4, 'my notes'), tab(5, BTOP_LABEL)],
    [{ ...monitor(1, 1), terminal_id: terminal() }, pane(2, 2), pane(3, 3), pane(4, 4), { ...monitor(5, 5), agent: 'codex' }],
    [agent(2, 'sess-a', 'w1', 'claude'), agent(3, 'sess-b', 'w1', 'claude'), agent(4, 'sess-c', 'w1', 'codex'), agent(5, 'sess-d', 'w1', 'codex')]);
  fs.mkdirSync(path.dirname(record()), { recursive: true });
  fs.writeFileSync(record(), JSON.stringify({ local: { 'w1:t3': 'Old OAK title' } }));
  const sync = syncOf(herdr);
  linkPane('sess-a', 'w1:p2', herdr.socketPath);
  herdr.snapshot = layout('2');
  assert.deepEqual(await sync('sess-a', 'Fix the sidebar'), [{ kind: 'rename', tab_id: 'w1:t2', label: 'Fix the sidebar' }]);
  assert.deepEqual(herdr.requests.map(r => r.method), ['session.snapshot', 'tab.rename'], 'one read, one rename: no btop, no other tab');
  assert.deepEqual(owned().local, { 'w1:t2': 'Fix the sidebar', 'w1:t3': 'Old OAK title' }, 'the claim is recorded, and no other tab\'s claim is touched');
  // Control: the terminal app's pass over the same server renames the taken btop tab and claims it (tab 3
  // wears a placeholder, so its claim stays).
  assert.deepEqual(reconcileHerdrTabs(layout('Fix the sidebar'), titles({ 'sess-a': 'Fix the sidebar' }), owned().local, { btop: false }),
    { actions: [{ kind: 'rename', tab_id: 'w1:t5', label: 'codex' }], owned: { 'w1:t2': 'Fix the sidebar', 'w1:t3': 'Old OAK title', 'w1:t5': 'codex' } });
  // The title changes (a rename, a new ai-title, claude.ai's title): the tab follows it.
  herdr.snapshot = layout('Fix the sidebar');
  assert.deepEqual(await sync('sess-a', 'Fix the sidebar and header'), [{ kind: 'rename', tab_id: 'w1:t2', label: 'Fix the sidebar and header' }]);
  assert.deepEqual(owned().local, { 'w1:t2': 'Fix the sidebar and header', 'w1:t3': 'Old OAK title' });
  // Unchanged: nothing is renamed, and the record is not even rewritten.
  herdr.snapshot = layout('Fix the sidebar and header');
  const written = fs.statSync(record()).ino;
  assert.deepEqual(await sync('sess-a', 'Fix the sidebar and header'), []);
  assert.equal(fs.statSync(record()).ino, written, 'no write when nothing changed');
  // The pane moved with its tab, so the id the link recorded is stale: the tab is found by the session.
  linkPane('sess-a', 'w1:p9', herdr.socketPath);
  assert.deepEqual(await sync('sess-a', 'Fix the header'), [{ kind: 'rename', tab_id: 'w1:t2', label: 'Fix the header' }]);
  // A person renamed the tab: their label stays, and OAK's claim on it lapses.
  herdr.snapshot = layout('my label');
  assert.deepEqual(await sync('sess-a', 'A newer title'), []);
  assert.deepEqual(owned().local, { 'w1:t3': 'Old OAK title' });
  // …and the person's own tab is left alone by its session's sync too.
  linkPane('sess-c', 'w1:p4', herdr.socketPath);
  assert.deepEqual(await sync('sess-c', 'Port the feed'), []);
  assert.ok(herdr.calls('tab.rename').every(c => c.tab_id === 'w1:t2'), 'only the session\'s own tab was ever renamed');
  assert.deepEqual(herdr.requests.filter(r => !['session.snapshot', 'tab.rename'].includes(r.method)), [], 'btop is never probed, made or typed into');
  // No title yet, or no link (the session never ran in herdr): not even the server is asked.
  const asked = herdr.requests.length;
  assert.deepEqual(await sync('sess-a', null), []);
  assert.deepEqual(await sync('sess-never-linked', 'Anything'), []);
  assert.equal(herdr.requests.length, asked, 'nothing asked of herdr');
  // A session herdr does not hold in any pane: no tab is its to name.
  linkPane('sess-gone', 'w1:p2', herdr.socketPath);
  assert.deepEqual(await sync('sess-gone', 'Old session'), []);
  assert.equal(herdr.calls('tab.rename').length, 3);
});

test('herdr tab sync: `oak __tab-sync` takes the title the session list shows — a rename over an ai-title, Codex\'s thread name — and prints nothing', async t => {
  const herdr = await fakeHerdr(t, { 'tab.rename': ok });
  if (!herdr) return;
  resetOwned();
  const core = require('../dist');
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-tabsync-codex-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-tabsync-work-'));
  t.after(() => { fs.rmSync(codexHome, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true }); });
  const env = { ...process.env, CODEX_HOME: codexHome };
  for (const k of ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_ENV', 'HERDR_BIN_PATH']) delete env[k];
  // Asynchronously: the scripted herdr answers from this process, which must keep running meanwhile.
  const run = session => new Promise(resolve => require('node:child_process').execFile(process.execPath, [OAK, '__tab-sync', session],
    { env, encoding: 'utf8', timeout: 20000 }, (error, stdout, stderr) => {
      assert.deepEqual([error?.code ?? 0, stdout, stderr], [0, '', ''], 'exits 0 and prints nothing');
      resolve();
    }));
  const rec = o => JSON.stringify(o) + '\n';
  // A Claude session titled by Claude Code (ai-title) in tab 2, a Codex thread in tab 3.
  const S = 'fixture-claude-session', X = 'fixture-codex-thread';
  const proj = core.projectDir(work);
  fs.mkdirSync(proj, { recursive: true });
  const transcript = path.join(proj, `${S}.jsonl`);
  fs.writeFileSync(transcript, rec({ type: 'user', cwd: work, sessionId: S, message: { role: 'user', content: 'Tidy the fixture parser please' } })
    + rec({ type: 'assistant', cwd: work, sessionId: S, message: { id: 'fixture-answer', role: 'assistant', model: 'claude-opus-4-1', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 10, output_tokens: 5 } } })
    + rec({ type: 'ai-title', aiTitle: 'Parser tidy-up', sessionId: S }));
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'sessions', `${X}.jsonl`), rec({ type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { id: X, cwd: work } })
    + rec({ type: 'response_item', timestamp: '2026-01-01T00:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Port the feed to the new reader' }] } }));
  fs.writeFileSync(path.join(codexHome, 'session_index.jsonl'), rec({ id: X, thread_name: 'Feed reader port', updated_at: '2026-01-01' }));
  herdr.snapshot = homeSnap([tab(1, '1'), tab(2, '2'), tab(3, 'codex')], [pane(1, 1), pane(2, 2), pane(3, 3)],
    [agent(2, S, 'w1', 'claude'), agent(3, X, 'w1', 'codex')]);
  linkPane(S, 'w1:p2', herdr.socketPath);
  linkPane(X, 'w1:p3', herdr.socketPath);
  // What the session list shows, as the terminal app's pass would apply it.
  const listed = id => { const saved = process.env.CODEX_HOME; process.env.CODEX_HOME = codexHome; core.clearFsCache();
    try { return core.realSessionTitle(core.sessionMeta(work).sessions.find(r => r.id === id)?.title); } finally { process.env.CODEX_HOME = saved; core.clearFsCache(); } };
  assert.equal(listed(S), 'Parser tidy-up', 'fixture: the list reads the ai-title');
  await run(S);
  assert.deepEqual(herdr.calls('tab.rename'), [{ tab_id: 'w1:t2', label: listed(S) }]);
  // A rename (/rename, or one made in the Claude app) outranks the ai-title, as it does in the list.
  fs.appendFileSync(transcript, rec({ type: 'custom-title', customTitle: 'Release blockers', sessionId: S }));
  herdr.snapshot.tabs[1].label = 'Parser tidy-up';
  await run(S);
  assert.equal(listed(S), 'Release blockers');
  assert.deepEqual(herdr.calls('tab.rename').at(-1), { tab_id: 'w1:t2', label: 'Release blockers' });
  // Unchanged title: nothing renamed.
  herdr.snapshot.tabs[1].label = 'Release blockers';
  await run(S);
  assert.equal(herdr.calls('tab.rename').length, 2);
  // Codex: the thread's own name, which its list row shows.
  assert.equal(listed(X), 'Feed reader port', 'fixture: the list reads the thread name');
  await run(X);
  assert.deepEqual(herdr.calls('tab.rename').at(-1), { tab_id: 'w1:t3', label: 'Feed reader port' });
  assert.deepEqual(owned().local, { 'w1:t2': 'Release blockers', 'w1:t3': 'Feed reader port' });
  // A session with no pane link here asks herdr nothing, and answers `unlinked` (a terminal app on another
  // machine that asked names that tab itself).
  const requests = herdr.requests.length;
  const unlinked = await new Promise(resolve => require('node:child_process').execFile(process.execPath, [OAK, '__tab-sync', 'fixture-unlinked-session'],
    { env, encoding: 'utf8', timeout: 20000 }, (error, stdout, stderr) => resolve([error?.code ?? 0, stdout, stderr])));
  assert.deepEqual(unlinked, [0, 'unlinked\n', '']);
  assert.equal(herdr.requests.length, requests, 'nothing asked of herdr');
});

// --- the hooks start it: inside herdr only, throttled, detached, silent -----------------------------

function hookSandbox(t) {
  const keys = ['HERDR_PANE_ID', 'HERDR_SOCKET_PATH', 'HERDR_BIN_PATH', 'CODEX_HOME', 'CODEX_THREAD_ID', 'OAK_TAB'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-tabsync-hooks-'));
  Object.assign(process.env, { HERDR_PANE_ID: 'w1:p2', HERDR_SOCKET_PATH: path.join(dir, 'herdr.sock'), HERDR_BIN_PATH: path.join(dir, 'herdr'), CODEX_HOME: path.join(dir, 'codex') });
  delete process.env.CODEX_THREAD_ID; delete process.env.OAK_TAB;
  const spawned = [];
  t.mock.method(spawn, 'spawnTool', (file, args, options) => {
    spawned.push({ file, args, detached: options?.detached, stdio: options?.stdio });
    return Object.assign(new (require('node:events').EventEmitter)(), { unref() {} });
  });
  // A Codex hook reports the pane's identity through herdr's binary: never a real one here.
  t.mock.method(spawn, 'spawnToolSync', () => ({ status: 0 }));
  // stdout is watched only while a (synchronous) hook runs: the test runner reports through it too.
  const writes = [];
  const silent = fn => {
    const write = process.stdout.write;
    process.stdout.write = (...a) => { writes.push(String(a[0])); return true; };
    try { return fn(); } finally { process.stdout.write = write; }
  };
  setOakCliEntry('/fixture/oak/dist/cli.js');
  t.after(() => {
    setOakCliEntry(undefined);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { spawned, writes, silent, started: () => spawned.map(s => s.args[2]) };
}
/** Age a session's throttle past its window, as if its last sync started long ago. */
const pastWindow = session => { const f = path.join(storeDir(session), 'herdr-tab.kick'); const old = (Date.now() - TAB_SYNC_KICK_MS - 1000) / 1000; fs.utimesSync(f, old, old); };

test('herdr tab sync: Claude\'s hooks start it at turn boundaries — inside herdr only, throttled per session, detached and silent', t => {
  const b = hookSandbox(t);
  const { handleHookPayload } = require('../dist/capture');
  const hook = (session, event, extra = {}) => b.silent(() => handleHookPayload({ session_id: session, cwd: os.tmpdir(), hook_event_name: event, ...extra }));
  hook('fixture-claude-a', 'UserPromptSubmit');
  assert.deepEqual(b.spawned, [{ file: process.execPath, args: ['/fixture/oak/dist/cli.js', '__tab-sync', 'fixture-claude-a'], detached: true, stdio: 'ignore' }],
    'the registered oak CLI, detached, with its output ignored');
  hook('fixture-claude-a', 'Stop');
  assert.deepEqual(b.started(), ['fixture-claude-a'], 'a second boundary inside the window starts nothing');
  hook('fixture-claude-b', 'Stop');
  assert.deepEqual(b.started(), ['fixture-claude-a', 'fixture-claude-b'], 'the window is per session');
  pastWindow('fixture-claude-a');
  hook('fixture-claude-a', 'Stop');
  assert.deepEqual(b.started(), ['fixture-claude-a', 'fixture-claude-b', 'fixture-claude-a'], 'once the window passed, the next boundary starts one');
  // A file time can read a moment past Date.now() (it keeps sub-millisecond digits Date.now() drops):
  // that stamp still throttles. One far ahead — the clock was set back since — does not.
  const stamp = (session, aheadMs) => { const f = path.join(storeDir(session), 'herdr-tab.kick'); const at = (Date.now() + aheadMs) / 1000; fs.utimesSync(f, at, at); };
  stamp('fixture-claude-a', 800);
  hook('fixture-claude-a', 'Stop');
  assert.equal(b.spawned.length, 3, 'a stamp a moment ahead still throttles');
  stamp('fixture-claude-a', 60 * 60_000);
  hook('fixture-claude-a', 'UserPromptSubmit');
  assert.equal(b.spawned.length, 4, 'a stamp an hour ahead throttles nothing');
  // Only turn boundaries: tool calls, notifications and a session's end start nothing.
  for (const event of ['PreToolUse', 'PostToolUse', 'Notification', 'PermissionRequest', 'SessionEnd']) hook('fixture-claude-c', event, { tool_name: 'Read', tool_input: {} });
  assert.equal(b.spawned.length, 4, 'no tool call or notification starts a sync');
  // Outside herdr, nothing.
  delete process.env.HERDR_PANE_ID;
  hook('fixture-claude-d', 'Stop');
  hook('fixture-claude-d', 'UserPromptSubmit');
  assert.equal(b.spawned.length, 4, 'outside herdr no sync is started');
  assert.ok(!fs.existsSync(path.join(storeDir('fixture-claude-d'), 'herdr-tab.kick')), '…and no throttle stamp is written');
  process.env.HERDR_PANE_ID = 'w1:p2';
  // A process that registered no oak CLI (a harness running core directly) starts nothing.
  setOakCliEntry(undefined);
  hook('fixture-claude-e', 'Stop');
  assert.equal(b.spawned.length, 4);
  setOakCliEntry('/fixture/oak/dist/cli.js');
  // A spawn that fails throws nothing, and the rest of the turn's capture still runs.
  spawn.spawnTool.mock.mockImplementation(() => { throw new Error('EAGAIN: fork failed'); });
  assert.doesNotThrow(() => hook('fixture-claude-f', 'Stop'));
  assert.equal(require('../dist/capture').readAttention('fixture-claude-f')?.kind, 'idle-done', 'the Stop was still recorded');
  assert.doesNotThrow(() => b.silent(() => kickTabSync('../not a session id')));
  assert.deepEqual(b.writes, [], 'nothing reaches stdout (UserPromptSubmit feeds it to the model)');
  // Control: the spy does see a write made while a hook runs.
  b.silent(() => process.stdout.write('probe'));
  assert.deepEqual(b.writes, ['probe'], 'control: the stdout spy works');
});

test('herdr tab sync: Codex\'s hooks start it at turn boundaries and on a resumed thread — inside herdr only, throttled, silent', t => {
  const b = hookSandbox(t);
  const { handleCodexHookPayload } = require('../dist/codex');
  const hook = (session, event, extra = {}) => b.silent(() => handleCodexHookPayload({ session_id: session, cwd: os.tmpdir(), hook_event_name: event, model: 'fixture-model', ...extra }));
  hook('fixture-codex-a', 'SessionStart', { source: 'startup' });
  assert.deepEqual(b.spawned, [], 'a new thread has no title yet: its start starts nothing');
  hook('fixture-codex-a', 'UserPromptSubmit', { turn_id: 'turn-1', prompt: 'Port the feed' });
  assert.deepEqual(b.spawned, [{ file: process.execPath, args: ['/fixture/oak/dist/cli.js', '__tab-sync', 'fixture-codex-a'], detached: true, stdio: 'ignore' }]);
  hook('fixture-codex-a', 'Stop');
  assert.deepEqual(b.started(), ['fixture-codex-a'], 'throttled inside the window');
  pastWindow('fixture-codex-a');
  hook('fixture-codex-a', 'Stop');
  hook('fixture-codex-b', 'SessionStart', { source: 'resume' });
  assert.deepEqual(b.started(), ['fixture-codex-a', 'fixture-codex-a', 'fixture-codex-b'], 'a later Stop, and a thread resumed in a pane');
  for (const event of ['PreToolUse', 'PostToolUse', 'PermissionRequest', 'PreCompact', 'SubagentStop', 'SessionEnd']) hook('fixture-codex-c', event, { tool_name: 'Read', tool_input: {} });
  assert.equal(b.spawned.length, 3, 'no tool call or other event starts a sync');
  delete process.env.HERDR_PANE_ID;
  hook('fixture-codex-d', 'Stop');
  assert.equal(b.spawned.length, 3, 'outside herdr no sync is started');
  assert.deepEqual(b.writes, [], 'nothing reaches stdout (a PermissionRequest reply is a decision)');
});

test('herdr tab sync: the capture bundle itself starts the sync and returns at once, printing nothing — Claude and Codex', async t => {
  const herdr = await fakeHerdr(t, { 'tab.rename': ok });
  if (!herdr) return;
  resetOwned();
  const cp = require('node:child_process');
  const core = require('../dist');
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-tabsync-bundle-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const rec = o => JSON.stringify(o) + '\n';
  const S = 'fixture-bundle-claude', X = 'fixture-bundle-codex';
  const proj = core.projectDir(codexHome);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, `${S}.jsonl`), rec({ type: 'user', cwd: codexHome, sessionId: S, message: { role: 'user', content: 'Tidy it' } })
    + rec({ type: 'ai-title', aiTitle: 'Bundle tidy-up', sessionId: S }));
  const rollout = path.join(codexHome, 'sessions', `${X}.jsonl`);
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, rec({ type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { id: X, cwd: codexHome } }));
  fs.writeFileSync(path.join(codexHome, 'session_index.jsonl'), rec({ id: X, thread_name: 'Bundle thread', updated_at: '2026-01-01' }));
  herdr.snapshot = homeSnap([tab(1, '1'), tab(2, '2')], [pane(1, 1), pane(2, 2)], [agent(1, S, 'w1', 'claude'), agent(2, X, 'w1', 'codex')]);
  const env = pane => ({ ...process.env, CODEX_HOME: codexHome, HERDR_PANE_ID: pane, HERDR_SOCKET_PATH: herdr.socketPath, HERDR_BIN_PATH: herdr.binary });
  // The hook runs synchronously here, so this process's scripted herdr cannot answer anything until it
  // has exited: a hook that waited for the sync would hang to its timeout instead of returning at once.
  const hook = (args, pane, payload) => {
    const started = Date.now();
    const r = cp.spawnSync(process.execPath, [OAK, 'capture', ...args], { input: JSON.stringify(payload), env: env(pane), encoding: 'utf8', timeout: 20000 });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], `${args.join(' ') || 'capture'} exits 0 and prints nothing`);
    return Date.now() - started;
  };
  const ms = hook([], 'w1:p1', { session_id: S, cwd: codexHome, hook_event_name: 'Stop' });
  assert.equal(herdr.requests.length, 0, 'nothing reached herdr while the hook ran');
  // A sync that held the hook's stdout would keep it open until herdr answered or it gave up (4 s),
  // and the agent waits for that pipe to close.
  assert.ok(ms < 3000, `the hook returned at once, its output closed (${ms} ms)`);
  assert.ok(await until(() => herdr.calls('tab.rename').length === 1), 'the detached sync renamed the tab');
  assert.deepEqual(herdr.calls('tab.rename'), [{ tab_id: 'w1:t1', label: 'Bundle tidy-up' }]);
  hook(['--agent', 'codex'], 'w1:p2', { session_id: X, cwd: codexHome, hook_event_name: 'Stop', transcript_path: rollout, model: 'fixture-model' });
  assert.ok(await until(() => herdr.calls('tab.rename').length === 2), 'the Codex hook\'s sync renamed its tab');
  assert.deepEqual(herdr.calls('tab.rename')[1], { tab_id: 'w1:t2', label: 'Bundle thread' });
});

// --- the ownership record under concurrency -----------------------------------------------------------
// herdr-tabs.json is written by the terminal app's pass (per machine) and by every session's own sync,
// each from what it read when it began. Writing a machine's whole map back erased the claims the others
// had made meanwhile, and a lost claim leaves its tab stuck on an old OAK-given title.

test('herdr tabs record: two terminal-app passes at once keep each other\'s claims (2026-09-27)', async t => {
  const herdr = await fakeHerdr(t, { 'tab.rename': ok });
  if (!herdr) return;
  resetOwned();
  // Two OAK processes (their own module state, one store) whose catalogs name different sessions.
  const modulePath = require.resolve('../dist/herdr-tabs');
  delete require.cache[modulePath];
  const other = require('../dist/herdr-tabs');
  const s = homeSnap([tab(1, '1'), tab(2, '2')], [pane(1, 1), pane(2, 2)], [agent(1, 'sess-a'), agent(2, 'sess-b')]);
  const run = (drive, titleOf) => drive({ snapshot: s, titleOf, monitor: null, transport, herdrOptions: { socketPath: herdr.socketPath, timeoutMs: 5000 } });
  await Promise.all([run(ensureHerdrTabs, titles({ 'sess-a': 'Alpha' })), run(other.ensureHerdrTabs, titles({ 'sess-b': 'Beta' }))]);
  assert.equal(herdr.calls('tab.rename').length, 2, 'both tabs were renamed');
  assert.deepEqual(owned().local, { 'w1:t1': 'Alpha', 'w1:t2': 'Beta' }, 'and both claims are recorded');
});

test('herdr tabs record: the terminal app\'s pass and a session\'s own sync at once keep each other\'s claims, and each still drops a lapsed one (2026-09-27)', async t => {
  const herdr = await fakeHerdr(t, { 'tab.rename': ok });
  if (!herdr) return;
  resetOwned();
  // A claim a person has since overridden (tab 3 now reads their own label) lapses as before.
  fs.mkdirSync(path.dirname(record()), { recursive: true });
  fs.writeFileSync(record(), JSON.stringify({ local: { 'w1:t3': 'Old OAK title' }, 'build-box': { 'w1:t1': 'Remote title' } }));
  const s = homeSnap([tab(1, '1'), tab(2, '2'), tab(3, 'my notes')], [pane(1, 1), pane(2, 2), pane(3, 3)],
    [agent(1, 'sess-a'), agent(2, 'sess-b'), agent(3, 'sess-c')]);
  herdr.snapshot = s;
  linkPane('sess-b', 'w1:p2', herdr.socketPath);
  // The app knows sess-a's title and not yet sess-b's (its catalog lags); sess-b's own sync knows its own.
  await Promise.all([
    ensureHerdrTabs({ snapshot: s, titleOf: titles({ 'sess-a': 'Alpha' }), monitor: null, transport, herdrOptions: { socketPath: herdr.socketPath, timeoutMs: 5000 } }),
    syncSessionTab({ session: 'sess-b', title: 'Beta', transport, herdrOptions: { timeoutMs: 5000 } }),
  ]);
  assert.deepEqual(owned(), { local: { 'w1:t1': 'Alpha', 'w1:t2': 'Beta' }, 'build-box': { 'w1:t1': 'Remote title' } },
    'both claims kept, the lapsed one dropped, another machine\'s untouched');
});

test('herdr tabs record: the terminal app\'s pass over a snapshot from before a session\'s own sync named the tab keeps that claim, and the tab follows later titles', async t => {
  const herdr = await fakeHerdr(t, { 'tab.rename': ok });
  if (!herdr) return;
  resetOwned();
  const layout = label => homeSnap([tab(1, label)], [pane(1, 1)], [agent(1, 'sess-a', 'w1', 'claude')]);
  // The app read the server while the new session's tab still wore herdr's own number, and its session
  // list does not show that session yet. Meanwhile the session's own sync names the tab.
  const stale = layout('1');
  herdr.snapshot = stale;
  linkPane('sess-a', 'w1:p1', herdr.socketPath);
  const sync = syncOf(herdr);
  const app = (snapshot, titleOf) => ensureHerdrTabs({ snapshot, titleOf, monitor: null, transport, herdrOptions: { socketPath: herdr.socketPath, timeoutMs: 5000 } });
  assert.deepEqual(await sync('sess-a', 'Start the build farm work'), [{ kind: 'rename', tab_id: 'w1:t1', label: 'Start the build farm work' }]);
  herdr.snapshot = layout('Start the build farm work');
  assert.deepEqual(await app(stale, titles({})), []);
  assert.deepEqual(owned().local, { 'w1:t1': 'Start the build farm work' }, 'the sync\'s claim survives the app\'s stale pass');
  // The title changes: the session's sync renames the tab, and the app's next pass agrees.
  assert.deepEqual(await sync('sess-a', 'Build farm scheduling'), [{ kind: 'rename', tab_id: 'w1:t1', label: 'Build farm scheduling' }]);
  herdr.snapshot = layout('Build farm scheduling');
  assert.deepEqual(await app(herdr.snapshot, titles({ 'sess-a': 'Build farm scheduling' })), []);
  assert.deepEqual(owned().local, { 'w1:t1': 'Build farm scheduling' });
  // Control: a label the person chose ends the claim, even in a pass that knows no title.
  assert.deepEqual(await app(layout('my notes'), titles({})), []);
  assert.deepEqual(owned().local, {});
});

test('herdr tabs record: syncs in separate processes at once lose no claim (2026-09-27)', async t => {
  const herdr = await fakeHerdr(t, { 'tab.rename': ok });
  if (!herdr) return;
  resetOwned();
  const cp = require('node:child_process');
  const n = 8;
  const ids = Array.from({ length: n }, (_, i) => `fixture-proc-${i + 1}`);
  herdr.snapshot = homeSnap(ids.map((_, i) => tab(i + 1, String(i + 1))), ids.map((_, i) => pane(i + 1, i + 1)), ids.map((id, i) => agent(i + 1, id)));
  ids.forEach((id, i) => linkPane(id, `w1:p${i + 1}`, herdr.socketPath));
  // Every process loads core, then waits for one shared instant, so their writes land together.
  const at = Date.now() + 1500;
  const script = `const core = require(${JSON.stringify(path.resolve(__dirname, '../dist'))});
    setTimeout(() => core.syncSessionTab({ session: process.argv[1], title: 'Title ' + process.argv[1], transport: core, herdrOptions: { timeoutMs: 5000 } })
      .then(() => process.exit(0), e => { console.error(e); process.exit(1); }), Math.max(0, ${at} - Date.now()));`;
  const runs = ids.map(id => new Promise(resolve => cp.execFile(process.execPath, ['-e', script, id], { env: process.env, timeout: 20000 },
    (error, stdout, stderr) => resolve({ id, code: error?.code ?? 0, stderr }))));
  const done = await Promise.all(runs);
  assert.deepEqual(done.filter(r => r.code !== 0), [], 'every sync exits cleanly');
  assert.equal(herdr.calls('tab.rename').length, n, 'every tab was renamed');
  assert.deepEqual(owned().local, Object.fromEntries(ids.map((id, i) => [`w1:t${i + 1}`, `Title ${id}`])), 'and every claim survived');
});

// A saved machine's own hooks keep their claims in ITS store. The terminal app on another machine kept its
// own claims for the same tabs in its store: two records of one server, and once the app had renamed a tab
// there, the machine's own sync took the label for a person's and stopped following the session's title
// Such a machine now names its own sessions' tabs; the app's pass keeps its btop.
test('herdr tabs driver: a pass that leaves naming to the machine\'s own OAK renames no session\'s tab there and keeps no record of names for it, and still keeps btop', async t => {
  const herdr = await fakeHerdr(t, {
    'pane.process_info': scripted({ 'w1:p9': [processInfo.idle('w1:p9')] }),
    'tab.create': created('w1:t9', 'w1:p9', terminal()), 'pane.rename': labelled, 'tab.rename': ok, 'pane.send_text': ok,
  });
  if (!herdr) return;
  resetOwned();
  // A record this app kept for that machine before: it is neither read nor written now.
  fs.mkdirSync(path.dirname(record()), { recursive: true });
  const kept = { 'names-box': { 'w1:t2': 'Named from here' } };
  fs.writeFileSync(record(), JSON.stringify(kept));
  // An agent took over the btop tab; a tab this app named before; a numbered tab. Every session has a title.
  const s = homeSnap([tab(1, BTOP_LABEL), tab(2, 'Named from here'), tab(3, '3')],
    [{ ...monitor(1, 1), agent: 'claude', terminal_id: terminal() }, pane(2, 2), pane(3, 3)],
    [agent(1, 'sess-a', 'w1', 'claude'), agent(2, 'sess-b'), agent(3, 'sess-c')]);
  const named = titles({ 'sess-a': 'Fix the sidebar', 'sess-b': 'Port the feed', 'sess-c': 'Tune the parser' });
  const done = await pass(herdr, s, { machine: 'names-box', monitor: null, titleOf: named, names: false });
  assert.deepEqual(done.map(a => a.kind), ['create-btop', 'launch-monitor', 'rename'], 'btop is kept as ever');
  assert.deepEqual(herdr.calls('tab.rename'), [{ tab_id: 'w1:t1', label: 'claude', machine: 'names-box' }],
    'only the taken btop tab, by its agent\'s kind: no session\'s title names a tab from here');
  assert.deepEqual(owned(), kept, 'no record of names for that machine is read or written here');
  // Control: the same pass naming the tabs itself renames them all by its titles and records them.
  await pass(herdr, s, { machine: 'names-box', monitor: null, titleOf: named, timing: { ...fast, readyMs: 0 } });
  assert.deepEqual(herdr.calls('tab.rename').slice(1).map(c => c.label), ['Fix the sidebar', 'Port the feed', 'Tune the parser']);
  assert.deepEqual(owned()['names-box'], { 'w1:t1': 'Fix the sidebar', 'w1:t2': 'Port the feed', 'w1:t3': 'Tune the parser' });
});

// The terminal app open, its session list a moment behind: the session's own sync renamed the tab to its
// new title, then the app's next pass (a herdr event, at the same turn boundary) took the tab for OAK's
// and put the old title back until its list caught up.
test('herdr tabs record: the terminal app\'s pass leaves alone a tab its session\'s own sync renamed after the app read its list, and follows once the list catches up', async t => {
  let server;
  const herdr = await fakeHerdr(t, { 'tab.rename': ({ tab_id, label }) => { server.tabs.find(x => x.tab_id === tab_id).label = label; return ok(); } });
  if (!herdr) return;
  resetOwned();
  server = homeSnap([tab(1, '1')], [pane(1, 1)], [agent(1, 'sess-f', 'w1', 'claude')]);
  herdr.snapshot = server;
  linkPane('sess-f', 'w1:p1', herdr.socketPath);
  const labels = () => herdr.calls('tab.rename').map(c => c.label);
  const later = () => new Promise(resolve => setTimeout(resolve, 20));
  const app = (title, listedAt) => ensureHerdrTabs({ snapshot: JSON.parse(JSON.stringify(server)), titleOf: titles({ 'sess-f': title }), monitor: null,
    listedAt, transport, herdrOptions: { socketPath: herdr.socketPath, timeoutMs: 5000 } });
  // The app read its list, then named the tab by it.
  const listed = Date.now();
  await later();
  assert.deepEqual(await app('Old title', listed), [{ kind: 'rename', tab_id: 'w1:t1', label: 'Old title' }]);
  // The title changes; the session's own sync (its Stop hook) renames the tab.
  await later();
  const synced = Date.now();
  assert.deepEqual(await syncSessionTab({ session: 'sess-f', title: 'New title', transport, herdrOptions: { timeoutMs: 5000 } }),
    [{ kind: 'rename', tab_id: 'w1:t1', label: 'New title' }]);
  // The app's next pass still works from the list it read before that: the tab keeps the newer title.
  assert.deepEqual(await app('Old title', listed), []);
  assert.deepEqual(labels(), ['Old title', 'New title'], 'the old title is never put back');
  // The record keeps its format (plain labels, what an OAK from before claim times reads); each claim's
  // time, when the title it names was read, is kept beside it.
  assert.deepEqual(owned(), { local: { 'w1:t1': 'New title' } });
  const at = JSON.parse(fs.readFileSync(path.join(rootDir(), 'herdr-tabs.at.json'), 'utf8')).local['w1:t1'];
  assert.ok(at >= synced && at <= Date.now(), `the sync's claim carries when it read its title (${at})`);
  // A list read after the sync agrees; the next change of title there is followed as ever.
  await later();
  assert.deepEqual(await app('New title', Date.now()), []);
  assert.deepEqual(await app('Newest title', Date.now()), [{ kind: 'rename', tab_id: 'w1:t1', label: 'Newest title' }]);
  assert.deepEqual(owned(), { local: { 'w1:t1': 'Newest title' } });
  // Control: a pass that cannot say when its list was read renames as before.
  await syncSessionTab({ session: 'sess-f', title: 'Title from the sync', transport, herdrOptions: { timeoutMs: 5000 } });
  assert.deepEqual(await app('Newest title', undefined), [{ kind: 'rename', tab_id: 'w1:t1', label: 'Newest title' }]);
});

// The same race inside the sync's save: the claim and its time are two files. A pass that read the new
// claim after the sync wrote it, but that claim's time before, took the claim for one older than its list
// and put the old title back.
test('herdr tabs record: a pass that reads the record while a session\'s own sync is writing its claim never puts the old title back', async t => {
  let server;
  const herdr = await fakeHerdr(t, { 'tab.rename': ({ tab_id, label }) => { server.tabs.find(x => x.tab_id === tab_id).label = label; return ok(); } });
  if (!herdr) return;
  resetOwned();
  server = homeSnap([tab(1, 'Old title')], [pane(1, 1)], [agent(1, 'sess-o', 'w1', 'claude')]);
  herdr.snapshot = server;
  fs.mkdirSync(path.dirname(record()), { recursive: true });
  fs.writeFileSync(record(), JSON.stringify({ local: { 'w1:t1': 'Old title' } }));
  linkPane('sess-o', 'w1:p1', herdr.socketPath);
  const listed = Date.now(); // the app read its list: the title was 'Old title'
  await new Promise(resolve => setTimeout(resolve, 20));
  // The session's own sync, in its own process, renames the tab and then holds between the two files it writes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-claim-order-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const between = path.join(dir, 'between'), go = path.join(dir, 'go');
  const script = `const fs = require('fs'), rename = fs.renameSync;
    fs.renameSync = function (a, b) {
      rename.call(this, a, b);
      if (globalThis.held || !/herdr-tabs(\\.at)?\\.json$/.test(String(b))) return;
      globalThis.held = true;
      fs.writeFileSync(${JSON.stringify(between)}, '');
      for (const end = Date.now() + 10000; !fs.existsSync(${JSON.stringify(go)}) && Date.now() < end;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    };
    const core = require(${JSON.stringify(path.resolve(__dirname, '../dist'))});
    core.syncSessionTab({ session: 'sess-o', title: 'New title', transport: core, herdrOptions: { timeoutMs: 5000 } }).then(() => process.exit(0), () => process.exit(1));`;
  const synced = new Promise(resolve => require('node:child_process').execFile(process.execPath, ['-e', script], { env: process.env, timeout: 20000 },
    (error, stdout, stderr) => resolve([error?.code ?? 0, stderr])));
  for (const end = Date.now() + 10000; !fs.existsSync(between) && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(fs.existsSync(between), 'the sync holds between its two writes');
  assert.equal(server.tabs[0].label, 'New title', 'having renamed the tab');
  // The app's pass, from its older list, reads the record there and then; the sync goes on once it has.
  let read = false;
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (file, ...rest) {
    try { return readFileSync.call(this, file, ...rest); } finally { if (String(file).endsWith('herdr-tabs.at.json')) read = true; }
  });
  const pass = ensureHerdrTabs({ snapshot: JSON.parse(JSON.stringify(server)), titleOf: titles({ 'sess-o': 'Old title' }), monitor: null,
    listedAt: listed, transport, herdrOptions: { socketPath: herdr.socketPath, timeoutMs: 5000 } });
  for (const end = Date.now() + 10000; !read && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(read, 'the pass read the record while the sync held');
  fs.writeFileSync(go, '');
  assert.deepEqual(await pass, [], 'the pass leaves the tab alone');
  assert.deepEqual(await synced, [0, '']);
  assert.deepEqual(herdr.calls('tab.rename').map(c => c.label), ['New title'], 'the old title is never put back');
  // Its list read again, the app agrees: the tab and its claim follow the session as ever.
  assert.deepEqual(await ensureHerdrTabs({ snapshot: JSON.parse(JSON.stringify(server)), titleOf: titles({ 'sess-o': 'New title' }), monitor: null,
    listedAt: Date.now(), transport, herdrOptions: { socketPath: herdr.socketPath, timeoutMs: 5000 } }), []);
  assert.deepEqual(owned(), { local: { 'w1:t1': 'New title' } });
});

test('herdr tabs record: a claim\'s time holds back a pass with an older list, but not one taken before the clock was set back', async t => {
  const herdr = await fakeHerdr(t, { 'tab.rename': ok });
  if (!herdr) return;
  resetOwned();
  fs.mkdirSync(path.dirname(record()), { recursive: true });
  fs.writeFileSync(record(), JSON.stringify({ local: { 'w1:t1': 'Fix the sidebar' } }));
  const times = path.join(rootDir(), 'herdr-tabs.at.json');
  const s = homeSnap([tab(1, 'Fix the sidebar')], [pane(1, 1)], [agent(1, 'sess-a')]);
  const app = listedAt => ensureHerdrTabs({ snapshot: s, titleOf: titles({ 'sess-a': 'Fix the sidebar and header' }), monitor: null,
    listedAt, transport, herdrOptions: { socketPath: herdr.socketPath, timeoutMs: 5000 } });
  // The claim's title was read after the list: the pass leaves the tab alone.
  fs.writeFileSync(times, JSON.stringify({ local: { 'w1:t1': Date.now() - 1000 } }));
  assert.deepEqual(await app(Date.now() - 2000), []);
  // Stamped an hour ahead of the clock, it was taken before the clock was set back: it holds nothing back.
  fs.writeFileSync(times, JSON.stringify({ local: { 'w1:t1': Date.now() + 3_600_000 } }));
  assert.deepEqual(await app(Date.now() - 2000), [{ kind: 'rename', tab_id: 'w1:t1', label: 'Fix the sidebar and header' }]);
  assert.deepEqual(owned(), { local: { 'w1:t1': 'Fix the sidebar and header' } });
});

// The hand-over: a saved machine's tab that a terminal app elsewhere named, and recorded in ITS store, before
// the machine named its own tabs. The app vouches for that name when it asks the machine to sync the tab.
test('herdr tab sync: a name the asking terminal app recorded giving the tab is taken on while the tab wears it, and never a person\'s label', async t => {
  let server;
  const herdr = await fakeHerdr(t, { 'tab.rename': ({ tab_id, label }) => { server.tabs.find(x => x.tab_id === tab_id).label = label; return ok(); } });
  if (!herdr) return;
  resetOwned();
  server = homeSnap([tab(1, 'Named from there')], [pane(1, 1)], [agent(1, 'sess-v', 'w1', 'claude')]);
  herdr.snapshot = server;
  linkPane('sess-v', 'w1:p1', herdr.socketPath);
  const sync = (title, claimed) => syncSessionTab({ session: 'sess-v', title, claimed, transport, herdrOptions: { timeoutMs: 5000 } });
  // Control: unvouched, a name this machine did not give is a person's.
  assert.deepEqual(await sync('Fix the sidebar'), []);
  // Vouched for, while the tab wears it: renamed by this machine's title, and the claim is this record's now.
  assert.deepEqual(await sync('Fix the sidebar', 'Named from there'), [{ kind: 'rename', tab_id: 'w1:t1', label: 'Fix the sidebar' }]);
  assert.deepEqual(owned(), { local: { 'w1:t1': 'Fix the sidebar' } });
  // …so this machine's own sync follows the next title with no one vouching.
  assert.deepEqual(await sync('Fix the sidebar and header'), [{ kind: 'rename', tab_id: 'w1:t1', label: 'Fix the sidebar and header' }]);
  // A claim of this machine's own that the tab no longer wears (the app renamed the tab after it) gives way.
  server.tabs[0].label = 'Renamed by the app';
  assert.deepEqual(await sync('Fix the header', 'Renamed by the app'), [{ kind: 'rename', tab_id: 'w1:t1', label: 'Fix the header' }]);
  assert.deepEqual(owned(), { local: { 'w1:t1': 'Fix the header' } });
  // A vouch never unseats the name this machine gave the tab and it still wears.
  assert.deepEqual(await sync('Fix the header', 'Some other name'), []);
  assert.deepEqual(owned(), { local: { 'w1:t1': 'Fix the header' } });
  // A vouch for a name the tab no longer wears (a person renamed it since) takes nothing.
  resetOwned();
  server.tabs[0].label = 'my notes';
  assert.deepEqual(await sync('Another title', 'Fix the sidebar and header'), []);
  assert.deepEqual(owned(), {}, 'nothing is recorded');
});
