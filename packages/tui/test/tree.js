/**
 * The BSP carve — Milestone 1: a tree tiles a rectangle into one box per leaf, disjoint, in bounds,
 * each at least its view's minimum, with the arrangement a tree tab needs.
 *
 * The observatory tab itself is a two-pane MASTER/DETAIL now — too simple to exercise
 * the engine's multi-seam carve, fold-under-minimum and per-pane auto-hide. So those ENGINE behaviours are
 * pinned against a synthetic `BOARD` fixture (a sidebar over a stacked board — the observatory's own former
 * shape), and the real `OBSERVATORY_TREE` gets its own block pinning the two-pane arrangement it ships.
 */
const assert = require('node:assert');
const path = require('node:path');

const tui = require(path.join(__dirname, '..', 'dist', 'index.js'));
const { carve, resolveTree, minExtent, VIEW, OBSERVATORY_TREE } = tui;
const { pane: herdrPane, snapshot: herdrSnapshot } = require('./fixtures/observatory');
const observatory = () => ({ machines: [{ id: 'local', label: 'laptop', local: true,
  snapshot: herdrSnapshot([herdrPane('p1', 's1', 'working')]) }], details: {} });

const REGION = { x: 0, y: 0, w: 100, h: 24 };
const overlaps = (a, b) =>
  a.rect.x < b.rect.x + b.rect.w &&
  b.rect.x < a.rect.x + a.rect.w &&
  a.rect.y < b.rect.y + b.rect.h &&
  b.rect.y < a.rect.y + a.rect.h;

// A synthetic multi-pane tree for the ENGINE tests: a narrow sidebar beside a board that stacks three
// panes, the bottom two auto-hiding to a strip when empty. This is the shape the observatory used to be,
// kept HERE so the carve/seam/fold/auto-hide/hit-test coverage survives the observatory's redesign.
const BOARD = {
  kind: 'split', dir: 'h', ratio: 0.2,
  first: { kind: 'pane', id: 'b-side', view: 'agents-mini' },
  second: {
    kind: 'split', dir: 'v', ratio: 0.42,
    first: { kind: 'pane', id: 'b-workers', view: 'workers' },
    second: {
      kind: 'split', dir: 'v', ratio: 0.55,
      first: { kind: 'pane', id: 'b-tasks', view: 'tasks' },
      second: {
        kind: 'split', dir: 'v', ratio: 0.5,
        first: { kind: 'pane', id: 'b-workflows', view: 'workflows' },
        second: { kind: 'pane', id: 'b-processes', view: 'processes' },
      },
    },
  },
};

// ── the engine carves a sidebar plus a four-pane board, disjoint and in bounds ─────────────────────
{
  const p = carve(BOARD, REGION);
  const by = Object.fromEntries(p.map((x) => [x.view, x]));
  assert.strictEqual(p.length, 5, 'five leaves — the sidebar plus the four board panes');
  assert.deepStrictEqual(
    p.map((x) => x.view).sort(),
    ['agents-mini', 'processes', 'tasks', 'workers', 'workflows'],
    'the sidebar, then workers, tasks, workflows, processes'
  );

  // The narrow SIDEBAR owns the left edge, full height; the board fills the column to its right.
  assert.strictEqual(by['agents-mini'].rect.x, 0, 'the sidebar starts at the left edge');
  assert.strictEqual(by['agents-mini'].rect.y, 0, 'the sidebar is at the top');
  assert.strictEqual(by['agents-mini'].rect.y + by['agents-mini'].rect.h, REGION.h, 'the sidebar spans the full height');
  assert.ok(by['agents-mini'].rect.w < by.workers.rect.w, 'and it is narrower than the board beside it');

  // Workers on top of the RIGHT (board) column; Processes at its bottom; Tasks and Workflows between.
  const col = by.workers.rect.x; // the board column starts right of the sidebar seam
  assert.ok(col >= by['agents-mini'].rect.x + by['agents-mini'].rect.w, 'the board sits to the right of the sidebar');
  assert.strictEqual(by.workers.rect.y, 0, 'workers is on top of the board column');
  assert.strictEqual(by.workers.rect.w, REGION.w - col, 'workers spans the board column');

  assert.strictEqual(by.processes.rect.x, col, 'processes shares the board column');
  assert.strictEqual(by.processes.rect.w, REGION.w - col, 'processes spans the board column');
  assert.strictEqual(by.processes.rect.y + by.processes.rect.h, REGION.h, 'processes reaches the bottom edge');

  // Tasks, Workflows and Processes STACK below Workers, each spanning the board column, in order.
  assert.strictEqual(by.tasks.rect.x, col, 'tasks shares the board column');
  assert.strictEqual(by.tasks.rect.w, REGION.w - col, 'tasks spans the board column');
  assert.strictEqual(by.workflows.rect.x, col, 'workflows shares the board column');
  assert.strictEqual(by.workflows.rect.w, REGION.w - col, 'workflows spans the board column');
  assert.ok(by.workers.rect.y + by.workers.rect.h <= by.tasks.rect.y, 'tasks sits below workers');
  assert.ok(by.tasks.rect.y + by.tasks.rect.h <= by.workflows.rect.y, 'workflows below tasks');
  assert.ok(by.workflows.rect.y + by.workflows.rect.h <= by.processes.rect.y, 'processes below workflows');

  // Every box is in bounds, at least its minimum, and disjoint from every other.
  for (const x of p) {
    assert.ok(x.rect.x >= 0 && x.rect.y >= 0, `${x.view} is within the region (origin)`);
    assert.ok(x.rect.x + x.rect.w <= REGION.w, `${x.view} is within the region (right)`);
    assert.ok(x.rect.y + x.rect.h <= REGION.h, `${x.view} is within the region (bottom)`);
    assert.ok(x.rect.h >= VIEW[x.view].minRows, `${x.view} keeps its minimum rows`);
    assert.ok(x.rect.w >= VIEW[x.view].minCols, `${x.view} keeps its minimum cols`);
  }
  for (let i = 0; i < p.length; i++) {
    for (let j = i + 1; j < p.length; j++) {
      assert.ok(!overlaps(p[i], p[j]), `${p[i].view} and ${p[j].view} do not overlap`);
    }
  }
}

// ── focus flows to the named leaf, and to no other ─────────────────────────────────────────────────
{
  const p = carve(BOARD, REGION, 'b-workflows');
  assert.deepStrictEqual(
    p.filter((x) => x.focused).map((x) => x.id),
    ['b-workflows'],
    'exactly the focused leaf is marked'
  );
}

// ── minExtent sums along the split axis and takes the max across it ────────────────────────────────
{
  // A vertical stack of Workflows over Processes needs both minRows plus a seam down, but only the
  // wider minCols across. That split is the deepest node in the board column.
  const lower = BOARD.second.second.second; // the Workflows/Processes 'v' split
  assert.strictEqual(
    minExtent(lower, 'rows'),
    VIEW.workflows.minRows + VIEW.processes.minRows + 1,
    'a column sums minRows and a seam'
  );
  assert.strictEqual(
    minExtent(lower, 'cols'),
    Math.max(VIEW.workflows.minCols, VIEW.processes.minCols),
    'a column takes the max minCols'
  );
}

// ── every split becomes one seam, bounded to its own region ────────────────────────────────────────
{
  const { seams, notes } = resolveTree(BOARD, REGION);
  assert.deepStrictEqual(notes, [], 'nothing folds at a comfortable size');
  assert.strictEqual(seams.length, 4, 'four splits, four seams — the sidebar divider plus three in the board');

  const byPath = (p) => seams.find((s) => JSON.stringify(s.path) === JSON.stringify(p));

  const p = carve(BOARD, REGION);
  const by = Object.fromEntries(p.map((x) => [x.view, x]));
  const col = by.workers.rect.x; // the board column's left edge

  // The ROOT split is VERTICAL: the sidebar-to-board divider, full height, one column thick, seated at
  // the sidebar's right edge.
  const sb = byPath([]);
  assert.strictEqual(sb.axis, 'v', 'the sidebar divider is vertical');
  assert.strictEqual(sb.y0, 0, 'spanning from the top edge');
  assert.strictEqual(sb.y1, REGION.h, 'to the bottom edge');
  assert.strictEqual(sb.x0, by['agents-mini'].rect.x + by['agents-mini'].rect.w, 'seated at the sidebar right edge');
  assert.strictEqual(sb.x1, sb.x0 + 1, 'one column thick');

  // The THREE board dividers are horizontal (the board stacks): under Workers, under Tasks, and under
  // Workflows — each spanning the board column, one row thick, bounded to its own region.
  for (const [pth, above] of [[[1], 'workers'], [[1, 1], 'tasks'], [[1, 1, 1], 'workflows']]) {
    const s = byPath(pth);
    assert.strictEqual(s.axis, 'h', `the ${above} divider is horizontal`);
    assert.strictEqual(s.x0, col, 'spanning from the board column left edge');
    assert.strictEqual(s.x1, REGION.w, 'to the right edge');
    assert.strictEqual(s.y0, by[above].rect.y + by[above].rect.h, `it sits under ${above}`);
    assert.strictEqual(s.y1, s.y0 + 1, 'one row thick');
  }
}

// ── a region under the minimum FOLDS a pane, and says which ────────────────────────────────────────
{
  // 8 rows cannot hold the board's 14-row vertical stack. The board folds to Workers; the sidebar
  // survives beside it (the root is a horizontal split, unaffected by the vertical fold). The fold is
  // reported, never silent.
  const short = resolveTree(BOARD, { x: 0, y: 0, w: 100, h: 8 });
  assert.strictEqual(short.placements.length, 2, 'the sidebar and the folded-to-Workers board survive');
  const wk = short.placements.find((x) => x.view === 'workers');
  assert.ok(wk, 'Workers is the surviving board pane');
  assert.strictEqual(wk.rect.h, 8, 'given the whole height');
  assert.ok(short.placements.some((x) => x.view === 'agents-mini'), 'the sidebar survives the fold');
  assert.strictEqual(short.seams.length, 1, 'only the sidebar divider remains; the folded stack leaves none');
  assert.ok(short.notes.length >= 1 && /folded/.test(short.notes[0]), 'the fold is announced');
  assert.ok(/Processes/.test(short.notes[0]), 'and names what it hid');
}

// ── AUTO-HIDE: an empty leaf collapses to a title strip; its sibling takes the freed rows ───────────
{
  const empty = new Set(['b-workflows', 'b-processes']);
  const full = resolveTree(BOARD, REGION, 'b-workers');
  const hidden = resolveTree(BOARD, REGION, 'b-workers', [], empty);
  const byF = Object.fromEntries(full.placements.map((x) => [x.view, x]));
  const byH = Object.fromEntries(hidden.placements.map((x) => [x.view, x]));
  assert.strictEqual(hidden.placements.length, 5, 'all five panes still resolve — collapsed, never dropped');
  assert.strictEqual(byH.workflows.rect.h, 1, 'an empty workflows collapses to a 1-row strip');
  assert.strictEqual(byH.processes.rect.h, 1, 'and so does an empty processes');
  assert.ok(byH.tasks.rect.h > byF.tasks.rect.h, 'tasks takes the rows they gave up');
  // No empties -> byte-identical to before auto-hide existed (the mechanism is opt-in per pane).
  assert.deepStrictEqual(
    resolveTree(BOARD, REGION, 'b-workers', [], new Set()).placements,
    full.placements,
    'an empty set changes nothing'
  );
}

// ── the OBSERVATORY tab: a two-pane MASTER / DETAIL over sessions ────────────────
{
  const { leafViews, VIEW_SCREEN, firstLeafId, paneCount, parseTree } = tui;
  const p = carve(OBSERVATORY_TREE, REGION);
  const by = Object.fromEntries(p.map((x) => [x.view, x]));
  assert.strictEqual(p.length, 2, 'two leaves — the sessions master and the session detail');
  assert.deepStrictEqual(
    p.map((x) => x.view).sort(),
    ['session-detail', 'sessions-nav'],
    'the sessions master on the left, its detail on the right'
  );
  // The MASTER owns the left edge, full height, narrower than the DETAIL, which fills the rest.
  assert.strictEqual(by['sessions-nav'].rect.x, 0, 'the master starts at the left edge');
  assert.strictEqual(by['sessions-nav'].rect.y, 0, 'the master is at the top');
  assert.strictEqual(by['sessions-nav'].rect.y + by['sessions-nav'].rect.h, REGION.h, 'the master spans the full height');
  assert.ok(by['sessions-nav'].rect.w < by['session-detail'].rect.w, 'and it is narrower than the detail beside it');
  assert.ok(by['session-detail'].rect.x >= by['sessions-nav'].rect.x + by['sessions-nav'].rect.w, 'the detail sits right of the master');
  assert.strictEqual(by['session-detail'].rect.y, 0, 'the detail is at the top');
  assert.strictEqual(by['session-detail'].rect.y + by['session-detail'].rect.h, REGION.h, 'the detail spans the full height');
  for (const x of p) {
    assert.ok(x.rect.h >= VIEW[x.view].minRows, `${x.view} keeps its minimum rows`);
    assert.ok(x.rect.w >= VIEW[x.view].minCols, `${x.view} keeps its minimum cols`);
  }
  assert.ok(!overlaps(p[0], p[1]), 'the master and detail do not overlap');

  // The fetch bridge: a tree tab asks the backend for exactly its leaves' views, and each ViewId maps to
  // the ScreenId whose producer/allow-list it uses. Both leaves read `multitask` (via those screens).
  assert.deepStrictEqual(leafViews(OBSERVATORY_TREE).slice().sort(), ['session-detail', 'sessions-nav'], 'the tree renders these two views');
  assert.strictEqual(VIEW_SCREEN['sessions-nav'], 'sessions-nav', 'the master rides its own screen');
  assert.strictEqual(VIEW_SCREEN['session-detail'], 'session-detail', 'and the detail its own');

  // Its ONE seam is the vertical master/detail divider, addressed by path [].
  const { seams } = resolveTree(OBSERVATORY_TREE, REGION);
  assert.strictEqual(seams.length, 1, 'one seam — the master/detail divider');
  assert.strictEqual(seams[0].axis, 'v', 'the divider is vertical');
  assert.deepStrictEqual(seams[0].path, [], 'addressed at the root');

  // Identity + persistence for the real tree.
  assert.strictEqual(firstLeafId(OBSERVATORY_TREE), 'obs-sessions', 'firstLeafId is the first leaf in tree order — the master');
  assert.strictEqual(paneCount(OBSERVATORY_TREE), 2, 'two panes');
  assert.ok(parseTree(OBSERVATORY_TREE), 'the real tree parses');
  assert.strictEqual(paneCount(parseTree(OBSERVATORY_TREE)), 2, 'and comes back intact');
}

// ── a tree tab RENDERS: the observatory's master + detail, bodies from the real producers ──────────
{
  const { renderTreeBody, glyphs } = tui;
  const g = glyphs('ascii'); // pin the tier so assertions do not depend on the runner's locale
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

  // A realistic-enough DashState: one self session on branch feat/acp with a title and a spawned agent,
  // so the master lists it (by TITLE) and the detail shows its spawn agents.
  const state = {
    observatory: observatory(),
    views: {
      multitask: {
        agents: [
          {
            session: 's1', self: true, gitBranch: 'feat/acp', worktree: '/w/acp', title: 'Wire the palette',
            phase: 'working', loaded: true, diff: { added: 56, removed: 30 }, edits: 7, tokens: 1000, durationMs: 60000,
            subagents: [{ agentId: 'x1', agentType: 'Explore', description: 'scout the grid', phase: 'done', edits: 0 }], todos: [],
          },
        ],
        tasks: [], workflows: [],
      },
      sessions: { sessions: [{ id: 's1', agent: 'claude', model: 'Opus 5', effort: 'high' }] },
    },
    screen: 'edits', cursor: 0, scroll: 0, session: 's1', sessionTitle: 't', filter: '',
    status: 'ready', error: null, confirm: null, now: 1_000_000, open: new Set(), marked: new Set(),
    sort: 'recent', syntax: true, keys: {}, watcherMode: 'native', promptScope: null, overlay: null,
    drive: null, doneUnseen: new Set(), panes: null, tabs: [], activeTab: 0, hoverTab: null, treeScroll: {}, scopeWorker: null,
  };

  Object.assign(state, tui.selectAndPin(state, 's1'));
  state.observatory.details['obs-detail'].loading = false;
  state.open = new Set(['detail:obs-detail:s1:Workers']);

  const body = renderTreeBody(state, OBSERVATORY_TREE, 200, 24, 'obs-sessions', g, 'none');
  assert.strictEqual(body.length, 24, 'the body fills exactly the region height');
  for (const line of body) assert.strictEqual(strip(line).length, 200, 'every row is exactly the region width');

  const text = body.map(strip);
  const whole = text.join('\n');
  assert.ok(whole.includes('Sessions'), 'the master pane draws its title');
  assert.ok(whole.includes('Session '), 'the detail pane draws its title');
  // The master (left column) groups the session under its agent kind and lists it BY TITLE.
  const left = text.map((r) => r.slice(0, 50)).join('\n');
  assert.ok(/laptop/.test(left) && /claude · p1/.test(left), 'the master nests the agent pane under its machine');
  assert.ok(/Wire the palette/.test(left), 'and lists it by its session TITLE, not its branch');
  // The detail (right column) shows the selected session and its workers ("spawn agents" until
  // 2026-08-18 — renamed by the user).
  const right = text.map((r) => r.slice(51)).join('\n');
  assert.ok(/Workers/.test(right), 'the detail names the Workers section');
  assert.ok(!/Spawn agents/.test(right), 'the old "Spawn agents" label is gone');
  assert.ok(/scout the grid/.test(right), "and lists the session's worker");

  // Focus is CORAL, not a '>' marker: render in colour and confirm the accent lands on
  // the focused pane's title and not on the unfocused one. Both titles ride the same top row (side by
  // side), so split at the master's top-right corner.
  const CORAL = '\x1b[38;2;204;120;92m';
  const raw = renderTreeBody(state, OBSERVATORY_TREE, 200, 24, 'obs-sessions', g, 'truecolor');
  const top = raw.find((r) => strip(r).includes('Sessions'));
  const cut = top.indexOf('┐') >= 0 ? top.indexOf('┐') : top.indexOf('+'); // ascii tier boxes with +
  assert.ok(top.slice(0, cut).includes(CORAL), 'the focused master title wears the coral accent');
  assert.ok(!top.slice(cut).includes(CORAL), 'the unfocused detail title does not');
}

// ── renderDashFrame DISPATCHES on tab.root: tree tab vs dock tab, one state, one switch ────────────
{
  const { renderDashFrame, glyphs } = tui;
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const pane = () => ({ minimized: new Set(), zoom: null, focus: 'traces', tab: {}, cursor: {}, scroll: {}, sizes: {} });
  const mk = (activeTab) => ({
    observatory: observatory(),
    views: {
      multitask: { agents: [{ session: 's1', self: true, gitBranch: 'feat/acp', worktree: '/w', title: 'Wire the palette', phase: 'working', loaded: true, diff: { added: 56, removed: 30 }, edits: 3, subagents: [], todos: [] }], tasks: [], workflows: [] },
      sessions: { sessions: [{ id: 's1', agent: 'claude', model: 'Opus 5' }] },
    },
    screen: 'edits', cursor: 0, scroll: 0, session: 's1', sessionTitle: 'wire palette', filter: '', filterOpen: false,
    status: 'ready', error: null, confirm: null, now: 1_000_000, open: new Set(), marked: new Set(), sort: 'recent',
    syntax: true, keys: {}, watcherMode: 'native', promptScope: null, overlay: null, goto: null, drive: null, doneUnseen: new Set(), scopeWorker: null,
    panes: pane(),
    tabs: [
      { id: 'observatory', kind: 'panes', name: 'observatory', panes: pane(), root: OBSERVATORY_TREE, treeFocus: 'obs-sessions' },
      { id: 'review', kind: 'panes', name: 'review', panes: pane() },
    ],
    activeTab, hoverTab: null,
  });
  const opts = { cols: 100, rows: 30, color: 'none' };

  const obs = renderDashFrame(mk(0), opts).map(strip);
  const rev = renderDashFrame(mk(1), opts).map(strip);
  assert.strictEqual(obs.length, 30, 'the tree frame is exactly the terminal height');
  assert.strictEqual(rev.length, 30, 'the dock frame is too');

  // Both share the single-row tab bar (row 0, no rules); observatory is the bracketed active tab on row 0.
  assert.ok(/\[ observatory \]/.test(obs[0]), 'observatory is the bracketed tab');

  // The tree tab drops the window bar AND the session row: row 1 (right under the tab bar) is already the
  // tree body — the Sessions master title — and the session producer rendered its title through it.
  assert.ok(obs[1].includes('Sessions'), 'the tree body starts right under the 1-row tab bar — no window bar');
  assert.ok(obs.join('\n').includes('Wire the palette'), 'the producer rendered the session through renderDashFrame');
  assert.ok(obs.join('\n').includes('Session '), 'the detail pane is present');

  // The DOCK tab really took the other branch: it shows the Dashboards window-bar chip / pane, a
  // dock-only name the tree tab never renders.
  assert.ok(!obs.some((r) => r.includes('Dashboards')), 'the tree frame shows no window bar / dashboards pane');
  assert.ok(rev.some((r) => r.includes('Dashboards')), 'the dock frame does — the dispatch really branched');
  assert.ok(!rev[1].includes('Sessions'), 'and the dock frame row 1 is chrome (the tab bar), not a tree pane');
}

// ── select→detail: master rows carry a scope target, and a selection is named on screen ────────────
{
  const { rowsFor, glyphs, renderDashFrame } = tui;
  const g = glyphs('ascii');
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const base = () => ({
    observatory: observatory(),
    views: { multitask: { agents: [{ session: 's1', self: true, gitBranch: 'feat/acp', worktree: '/w/acp', title: 'Wire the palette', phase: 'working', loaded: true, diff: { added: 5, removed: 3 }, edits: 2, subagents: [], todos: [] }], tasks: [], workflows: [] }, sessions: { sessions: [{ id: 's1', agent: 'claude' }] } },
    screen: 'edits', cursor: 0, scroll: 0, session: 'term', sessionTitle: 't', filter: '', now: 1e6, open: new Set(), marked: new Set(),
    sort: 'recent', syntax: true, keys: {}, watcherMode: 'native', promptScope: null, scopeWorker: null, overlay: null, doneUnseen: new Set(), drive: null,
  });

  // The click reads a scope (selection) target straight off a master row.
  const rows = rowsFor({ ...base(), screen: 'sessions-nav' }, 100, g, 'none');
  const picked = rows.find((r) => r.scope);
  assert.ok(picked, 'a Sessions master row carries a scope target');
  assert.strictEqual(picked.scope.session, 's1', "the session (what the detail retargets to)");
  assert.strictEqual(picked.scope.root, '/w/acp', "the worktree (the --root)");
  assert.ok(/Wire the palette/.test(picked.scope.label), 'and a human label — the title');

  // With a selection active, the Sessions pane names it AND how to clear it — never a silent narrowing.
  const pane = () => ({ minimized: new Set(), zoom: null, focus: 'traces', tab: {}, cursor: {}, scroll: {}, sizes: {} });
  const scoped = {
    ...base(), scopeWorker: { session: 's1', root: '/w/acp', label: 'Wire the palette' }, filterOpen: false, status: 'ready', error: null, confirm: null, goto: null,
    panes: pane(), tabs: [{ id: 'observatory', kind: 'panes', name: 'observatory', panes: pane(), root: OBSERVATORY_TREE, treeFocus: 'obs-sessions' }], activeTab: 0, hoverTab: null,
  };
  const frame = renderDashFrame(scoped, { cols: 140, rows: 26, color: 'none' }).map(strip);
  assert.ok(frame.some((r) => /Sessions.*esc clears/.test(r)), 'the Sessions pane names that a selection is active and how to clear it');
}

// ── tree body scroll: each pane scrolls independently and names the remainder ──────────────────────
{
  const { renderTreeBody, glyphs } = tui;
  const g = glyphs('ascii');
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const agents = Array.from({ length: 20 }, (_, i) => ({ session: 's' + i, gitBranch: 'BR' + i, worktree: '/w' + i, phase: 'working', diff: { added: i, removed: 0 }, sparkline: [1, 2] }));
  const st = (scroll) => ({
    views: { multitask: { agents, tasks: [], workflows: [] }, sessions: { sessions: [] }, processes: { processes: [] } },
    screen: 'edits', cursor: 0, scroll: 0, session: 's', sessionTitle: 't', filter: '', now: 1e6, open: new Set(), marked: new Set(),
    sort: 'recent', syntax: true, keys: {}, watcherMode: 'native', promptScope: null, scopeWorker: null, overlay: null, doneUnseen: new Set(), drive: null, treeScroll: scroll,
  });
  // Read the WORKERS pane in the synthetic BOARD (the board column, right of the 0.2-wide sidebar). The
  // sidebar lists branches too, but it scrolls on its own key, not b-workers — so match only col 21+.
  const firstWorker = (rows) => { for (const r of rows) { const m = r.slice(21).match(/BR\d+/); if (m) return m[0]; } return ''; };
  const b0 = renderTreeBody(st({}), BOARD, 100, 24, 'b-workers', g, 'none').map(strip);
  const b3 = renderTreeBody(st({ 'b-workers': 3 }), BOARD, 100, 24, 'b-workers', g, 'none').map(strip);
  assert.strictEqual(firstWorker(b0), 'BR0', 'unscrolled, the first worker in the Workers pane is BR0');
  // Scrolled by 3 the pane drops its first three body rows — the agent group header (── claude ──) plus
  // BR0 and BR1 — so BR2 is now on top (the agents producer groups by agent kind).
  assert.strictEqual(firstWorker(b3), 'BR2', 'scrolled by 3, the Workers pane advances past its group header to BR2');
  assert.ok(b0.some((r) => /more/.test(r.slice(21))), 'and the rows past the bottom are named, not hidden');
  // A stale offset past the end clamps rather than blanking the pane.
  const bBig = renderTreeBody(st({ 'b-workers': 9999 }), BOARD, 100, 24, 'b-workers', g, 'none').map(strip);
  assert.ok(bBig.some((r) => /BR\d+/.test(r.slice(21))), 'a huge offset clamps to the last page, never blank');
}

// ── the tree hit-test: seams by their own bounds, panes by dynamic id (on the BOARD engine fixture) ─
{
  const { resolveTree, hitTreeBody, setRatioAt } = tui;
  const lay = resolveTree(BOARD, REGION); // 100x24
  const by = Object.fromEntries(carve(BOARD, REGION).map((x) => [x.view, x]));
  const wx = by.workers.rect.x + 3; // a column inside the board, clear of the sidebar

  // A click on the Workers title row (in the board column).
  const t = hitTreeBody(lay, wx, 0);
  assert.strictEqual(t?.kind, 'pane');
  assert.strictEqual(t.id, 'b-workers');
  assert.ok(t.titleRow, 'row 0 of a pane is its title');

  // A click one row down is the Workers BODY, row 0 (title excluded).
  const b = hitTreeBody(lay, wx, 1);
  assert.strictEqual(b.kind, 'pane');
  assert.strictEqual(b.id, 'b-workers');
  assert.ok(!b.titleRow && b.row === 0, 'the first body row is row 0, not the title');

  // The ROOT split is the VERTICAL sidebar divider, addressed by path [].
  const root = hitTreeBody(lay, by['agents-mini'].rect.w, 5);
  assert.strictEqual(root.kind, 'seam');
  assert.strictEqual(root.axis, 'v');
  assert.deepStrictEqual(root.path, [], 'the root split');

  // The horizontal divider under Workers (inside the board) is a seam, addressed by path [1].
  const h = hitTreeBody(lay, wx, by.workers.rect.y + by.workers.rect.h);
  assert.strictEqual(h.kind, 'seam');
  assert.strictEqual(h.axis, 'h');
  assert.deepStrictEqual(h.path, [1], 'the workers/rest split');

  // The Tasks/rest seam is addressed by path [1, 1].
  const v = hitTreeBody(lay, wx, by.tasks.rect.y + by.tasks.rect.h);
  assert.strictEqual(v.kind, 'seam');
  assert.strictEqual(v.axis, 'h');
  assert.deepStrictEqual(v.path, [1, 1], 'the tasks/rest split');

  // A click inside Workflows resolves to it, not its neighbour.
  const w = hitTreeBody(lay, by.workflows.rect.x + 3, by.workflows.rect.y + 1);
  assert.strictEqual(w.id, 'b-workflows', 'the click lands in workflows, not tasks');

  // A click in the left sidebar column resolves to the sidebar, never the board.
  const s = hitTreeBody(lay, 5, 0);
  assert.strictEqual(s.id, 'b-side', 'the sidebar column hits the sidebar pane');

  // setRatioAt returns a NEW tree with the addressed split's ratio changed; the original is untouched.
  // The Workflows/Processes split is the deepest node, at path [1, 1, 1].
  const before = BOARD.second.second.second.ratio;
  const moved = setRatioAt(BOARD, [1, 1, 1], 0.3);
  assert.strictEqual(moved.second.second.second.ratio, 0.3, 'the workflows/processes ratio moved');
  assert.strictEqual(BOARD.second.second.second.ratio, before, 'the original tree is unmutated');
  assert.strictEqual(setRatioAt(BOARD, [], 2).ratio, 0.95, 'a ratio is clamped below 1');
  assert.strictEqual(setRatioAt(BOARD, [], -1).ratio, 0.05, 'and above 0');

  // The REAL observatory seam drags too: its one root divider moves and the original is untouched.
  const obsMoved = setRatioAt(OBSERVATORY_TREE, [], 0.5);
  assert.strictEqual(obsMoved.ratio, 0.5, 'the master/detail ratio moved');
  assert.notStrictEqual(OBSERVATORY_TREE.ratio, 0.5, 'the shipped tree is unmutated');
}

// ── reader-created splits: split adds a pane, close removes it, the original is never mutated ──────
{
  const { splitPane, closePane, paneCount, firstLeafId } = tui;
  const t2 = splitPane(OBSERVATORY_TREE, 'obs-sessions', 'h', 'obs-feed', 'feed');
  assert.strictEqual(paneCount(t2), paneCount(OBSERVATORY_TREE) + 1, 'a split adds exactly one pane');
  const v2 = carve(t2, REGION);
  assert.ok(v2.some((x) => x.id === 'obs-feed' && x.view === 'feed'), 'the new pane shows the picked view');
  assert.ok(v2.some((x) => x.id === 'obs-sessions'), 'the split pane keeps its own view');
  const ss = v2.find((x) => x.id === 'obs-sessions');
  const fd = v2.find((x) => x.id === 'obs-feed');
  assert.strictEqual(ss.rect.y, fd.rect.y, 'an h-split seats them side by side (same band)');

  const t3 = closePane(t2, 'obs-feed');
  assert.strictEqual(paneCount(t3), paneCount(OBSERVATORY_TREE), 'closing removes the pane again');
  const v3 = carve(t3, REGION);
  assert.ok(!v3.some((x) => x.id === 'obs-feed'), 'the closed pane is gone');
  assert.ok(v3.some((x) => x.id === 'obs-sessions'), 'and its sibling survives, taking the space');

  assert.strictEqual(firstLeafId(OBSERVATORY_TREE), 'obs-sessions', 'firstLeafId is the first leaf in tree order — the master');
  assert.strictEqual(paneCount(OBSERVATORY_TREE), 2, 'and the original tree was never mutated');
}

// ── persistence: an untrusted tree is validated + rebuilt clean, or refused (never a blank frame) ──
{
  const { parseTree, paneCount } = tui;
  assert.ok(parseTree(OBSERVATORY_TREE), 'a valid tree parses');
  assert.strictEqual(paneCount(parseTree(OBSERVATORY_TREE)), 2, 'and comes back intact');
  assert.strictEqual(parseTree({ kind: 'pane', id: 'x', view: 'NOPE' }), null, 'an unknown view is refused');
  assert.strictEqual(parseTree({ kind: 'split', dir: 'h', ratio: 2, first: { kind: 'pane', id: 'a', view: 'feed' }, second: { kind: 'pane', id: 'b', view: 'tasks' } }), null, 'a ratio outside (0,1) is refused');
  assert.strictEqual(parseTree({ kind: 'split', dir: 'h', ratio: 0.5, first: { kind: 'pane', id: 'a', view: 'feed' }, second: { kind: 'pane', id: 'a', view: 'tasks' } }), null, 'a duplicate pane id is refused');
  assert.strictEqual(parseTree(null), null, 'null is refused');
  assert.strictEqual(parseTree('nonsense'), null, 'garbage is refused');
  const clean = parseTree({ kind: 'pane', id: 'a', view: 'feed', evil: 'x' });
  assert.deepStrictEqual(Object.keys(clean).sort(), ['id', 'kind', 'view'], 'parse REBUILDS clean, dropping unknown fields');
}

console.log('tree: carve, seams, render, dispatch, select, scroll, split/close, and parse/persist — all pinned');

// PANE MOVES: the pure ops the title drag, ctrl+a H/J/K/L and the view
// picker apply. Each keeps every OTHER leaf where it was, never invents or drops a pane, and is a no-op
// on a bad id — a drop that lands nowhere must leave the layout exactly as it stood.
{
  const { swapPanes, movePane, setPaneView, leafIds, leafPanes, paneCount } = tui;
  const T = {
    kind: 'split', dir: 'h', ratio: 0.3,
    first: { kind: 'pane', id: 'a', view: 'workers' },
    second: { kind: 'split', dir: 'v', ratio: 0.5, first: { kind: 'pane', id: 'b', view: 'feed' }, second: { kind: 'pane', id: 'c', view: 'tasks' } },
  };
  const swapped = swapPanes(T, 'a', 'c');
  assert.deepEqual(leafIds(swapped), ['c', 'b', 'a'], 'swap trades PLACES');
  assert.deepEqual(leafPanes(swapped).map((p) => p.view), ['tasks', 'feed', 'workers'], 'each pane keeps its own view');
  assert.deepEqual(swapPanes(T, 'a', 'zz'), T, 'a missing id is a no-op');
  assert.deepEqual(swapPanes(T, 'a', 'a'), T, 'the same pane twice is a no-op');
  const moved = movePane(T, 'a', 'c', 'bottom');
  assert.equal(paneCount(moved), 3, 'move never drops or invents a pane');
  assert.deepEqual(leafIds(moved), ['b', 'c', 'a'], 'a now sits after c…');
  assert.equal(moved.kind, 'split');
  assert.equal(moved.first.id, 'b', '…the old sibling absorbed a\'s space');
  assert.deepEqual(moved.second, { kind: 'split', dir: 'v', ratio: 0.5, first: { kind: 'pane', id: 'c', view: 'tasks' }, second: { kind: 'pane', id: 'a', view: 'workers' } }, 'bottom = a stacked split with the mover second');
  const left = movePane(T, 'c', 'a', 'left');
  assert.deepEqual(leafIds(left), ['c', 'a', 'b'], 'left = side by side, the mover first');
  assert.equal(left.first.dir, 'h');
  assert.deepEqual(movePane(T, 'a', 'zz', 'left'), T, 'a missing target is a no-op');
  assert.deepEqual(movePane({ kind: 'pane', id: 'solo', view: 'feed' }, 'solo', 'solo', 'left'), { kind: 'pane', id: 'solo', view: 'feed' }, 'a lone pane cannot move');
  const viewed = setPaneView(T, 'b', 'prompts');
  assert.deepEqual(leafPanes(viewed).map((p) => p.view), ['workers', 'prompts', 'tasks'], 'the view changes in place');
  assert.deepEqual(leafIds(viewed), leafIds(T), 'and nothing else does');
  for (const p of tui.carve(moved, REGION)) assert.ok(p.rect.w > 0 && p.rect.h > 0, 'a moved tree still carves');
}
console.log('tree: pane swap, move and set-view — pinned');
