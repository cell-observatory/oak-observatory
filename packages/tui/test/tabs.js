/**
 * Real tabs: the strip, the hit test, hover, and the stored layout.
 *
 * These pin the properties that make tabs feel real rather than painted on — a click landing on the
 * tab it was drawn over, a hover that reveals a model without inventing one, and a saved layout that
 * degrades to the defaults instead of to a blank frame.
 */
const assert = require('node:assert');
const path = require('node:path');

const tui = require(path.join(__dirname, '..', 'dist', 'index.js'));
const { renderDashFrame, resolveLayout, hitTest, WORKERS_ROLLUP_W } = tui;
const core = require(path.join(__dirname, '..', '..', 'core', 'dist', 'index.js'));

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const panes = (over = {}) => ({
  minimized: new Set(), zoom: null, focus: 'traces', tab: {}, cursor: {}, scroll: {}, sizes: {}, ...over,
});
const TABS = () => [
  { id: 'observatory', kind: 'panes', name: 'observatory', panes: panes({ focus: 'dashboards' }) },
  { id: 'review', kind: 'panes', name: 'review', panes: panes(), session: 'abc', model: 'Opus 5', phase: 'working', active: true },
  { id: 'agent', kind: 'agent', name: 'agent', panes: panes({ focus: 'claude' }), session: 'abc', model: 'gpt-oss:20b' },
];
function mkState(tabs, active = 0, hoverTab = null) {
  return {
    views: null, screen: 'edits', cursor: 0, scroll: 0, session: 'abc', sessionTitle: 't',
    filter: '', status: 'ready', error: null, confirm: null, now: 0, open: new Set(),
    marked: new Set(), sort: 'recent', syntax: true, keys: {}, watcherMode: 'native',
    promptScope: null, overlay: null, goto: null,
    tabs, activeTab: active, hoverTab,
    get panes() { return tabs[this.activeTab].panes; },
    set panes(v) { if (v) tabs[this.activeTab].panes = v; },
  };
}
const req = (tabs, active) => ({
  cols: 100, rows: 30, minimized: new Set(), zoom: null, focus: 'traces',
  tabs: tabs.map((t, i) => tui.tabLabel(t, i, tui.glyphs('ascii'))), activeTab: active,
});

// ── the strip ────────────────────────────────────────────────────────────────────────────────────
{
  const tabs = TABS();
  // The active tab is a FILLED BLOCK at colour (a selection ground) and BRACKETED with no colour (as
  // in the herdr tab bar). The tabs sit on ROW 0 — a single-row bar with no rules.
  const bgSpan = (raw) => { const m = /\x1b\[7m\x1b\[48;2;[^m]*m([\s\S]*?)\x1b\[(?:0|49)/.exec(raw); return m ? strip(m[1]) : null; };
  for (const i of [0, 1, 2]) {
    const raw = renderDashFrame(mkState(tabs, i), { cols: 100, rows: 30, color: 'truecolor' })[0];
    const block = bgSpan(raw);
    assert.ok(block, `tab ${i}: the selected tab is a filled block (selection ground) at colour`);
    assert.ok(block.includes(tabs[i].name), `tab ${i} (${tabs[i].name}) is the filled-block one, got "${block}"`);
  }
  // …and at 'none', where hue carries nothing at all, the selection is BRACKETED.
  const mono = strip(renderDashFrame(mkState(TABS(), 1), { cols: 100, rows: 30, color: 'none' })[0]);
  assert.ok(/\[.*review.*\]/.test(mono), 'selection survives with no colour, bracketed');
}

// ── the frame still fills exactly ────────────────────────────────────────────────────────────────
for (const rows of [24, 30, 44, 60]) {
  const out = renderDashFrame(mkState(TABS(), 1), { cols: 100, rows, color: 'truecolor' });
  assert.strictEqual(out.length, rows, `a tab bar must not change the row count at ${rows} rows`);
}

// ── no tabs = the layout this engine always produced ─────────────────────────────────────────────
{
  const base = { cols: 100, rows: 30, minimized: new Set(), zoom: null, focus: 'traces' };
  const without = resolveLayout(base);
  assert.strictEqual(without.chrome.top, 2, 'no tabs keeps the two-row top chrome');
  assert.deepStrictEqual(without.tabbar, [], 'and an empty tab bar');
  const with_ = resolveLayout({ ...base, tabs: ['a', 'b'], activeTab: 0 });
  assert.strictEqual(with_.chrome.top, 3, 'a single-row tab bar costs one row (no rules)');
  // Everything below the chrome shifts by exactly those rows, and nothing else changes.
  assert.strictEqual(with_.bodyH, without.bodyH - 1, 'the body gives up the one row the tab bar took');
}

// ── a click lands on the tab it was DRAWN over ───────────────────────────────────────────────────
{
  const tabs = TABS();
  const lay = resolveLayout(req(tabs, 0));
  assert.ok(lay.tabbar.length === 3, 'three spans');
  for (const s of lay.tabbar) {
    // Every column the span covers must hit that span — the off-by-one that puts a click on a
    // neighbouring tab lives exactly here.
    for (const c of [s.x, s.x + Math.floor(s.w / 2), s.x + s.w - 1]) {
      // The tabs sit on ROW 0 — a single-row bar with no rules.
      const h = hitTest(lay, c, 0);
      assert.strictEqual(h?.t, 'tabbar', `column ${c} is on the tab bar`);
      assert.strictEqual(h.index, s.index, `column ${c} belongs to tab ${s.index}`);
    }
  }
  // The right end of the tabs row is the Workers rollup, which navigates rather than switching tabs.
  const far = hitTest(lay, 100 - 1, 0);
  assert.strictEqual(far?.t, 'chrome', 'the row end is chrome');
  assert.strictEqual(far.part, 'workers', 'and specifically the Workers rollup');
  // Rows 1 and 2 are the window bar and session row, pushed down by the 1-row tab bar.
  assert.strictEqual(hitTest(lay, 0, 1)?.t, 'windowbar', 'the window bar moved to row 1');
  assert.deepStrictEqual(hitTest(lay, 0, 2), { t: 'chrome', part: 'session' }, 'the session row to row 2');
  // NEGATIVE CONTROL: with no tab bar those rows must go back where they were.
  const plain = resolveLayout({ cols: 100, rows: 30, minimized: new Set(), zoom: null, focus: 'traces' });
  assert.strictEqual(hitTest(plain, 0, 0)?.t, 'windowbar', 'without tabs the window bar is row 0 again');
}

// ── hover reveals a model, and NEVER invents one ─────────────────────────────────────────────────
{
  const tabs = TABS();
  // The model rides the tabs row (row 0) of the single-row tab bar.
  const row = (h) => strip(renderDashFrame(mkState(tabs, 0, h), { cols: 100, rows: 30, color: 'truecolor' })[0]);
  assert.ok(!row(null).includes('Opus 5'), 'no hover, no model');
  assert.ok(row(1).includes('Opus 5'), 'hovering review shows its model');
  assert.ok(row(2).includes('gpt-oss:20b'), 'hovering the agent tab shows ITS model, not the last one');
  // observatory has no session. The honest answer is nothing at all — not an em dash, not "unknown".
  const obs = row(0);
  assert.ok(!/—|unknown|null/.test(obs.slice(0, 60)), `a tab with no session shows no placeholder: "${obs.slice(0, 60)}"`);
}

// ── the stored layout is validated, never trusted ────────────────────────────────────────────────
{
  const os = require('node:os'), fs = require('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-layout-'));
  const file = path.join(dir, 'prefs.json');
  const round = (obj) => {
    fs.writeFileSync(file, JSON.stringify(obj));
    return core.readPrefs(file);
  };
  // A good record survives.
  const good = round({ layout: { version: core.LAYOUT_VERSION, active: 'review', tabs: { review: { minimized: ['claude'], focus: 'traces', sizes: { traces: 50 } } } } });
  assert.strictEqual(good.layout?.active, 'review', 'a valid layout round-trips');
  assert.deepStrictEqual(good.layout?.tabs?.review?.sizes, { traces: 50 }, 'and keeps its sizes');
  // A future version is IGNORED whole — not partially applied.
  assert.strictEqual(round({ layout: { version: core.LAYOUT_VERSION + 1, active: 'review' } }).layout, undefined,
    'a newer schema version is ignored rather than half-read');
  // Garbage degrades to nothing, which the runtime reads as "use the defaults".
  for (const bad of [
    { layout: 'nonsense' },
    { layout: { version: core.LAYOUT_VERSION, tabs: { review: { sizes: { traces: NaN } } } } },
    { layout: { version: core.LAYOUT_VERSION, tabs: { review: { sizes: { traces: -8 } } } } },
    { layout: { version: core.LAYOUT_VERSION, tabs: { review: 42 } } },
  ]) {
    const got = round(bad);
    const sizes = got.layout?.tabs?.review?.sizes;
    assert.ok(!sizes || Object.keys(sizes).length === 0, `a bad size is dropped: ${JSON.stringify(bad)}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── a stored layout can never restore a BLANK FRAME ──────────────────────────────────────────────
{
  // The premise: every pane minimized resolves to no boxes at all, and the resolver does NOT
  // complain — rightly, since `blocked` is for panes the SIZE refused, not ones the reader closed.
  // So nothing on the frame would tell a reader how to get out of it.
  const all = new Set(['claude', 'prompts', 'traces', 'map', 'detail', 'dashboards']);
  const dead = resolveLayout({ cols: 100, rows: 30, minimized: all, zoom: null, focus: 'traces', tab: {} });
  assert.strictEqual(dead.boxes.length, 0, 'all-minimized really does resolve to an empty frame');
  assert.deepStrictEqual(dead.notes, [], 'and says nothing about it');
  assert.deepStrictEqual(dead.blocked, [], 'and reports nothing blocked');

  // Which is why the restore path must refuse it. This is a SOURCE CONTRACT because the guard lives
  // inside `runTui`, which needs a TTY, a store and a backend to construct — the same reason the
  // accessor test models its wiring. If the guard is ever removed, a reader who minimizes every
  // pane and quits gets an empty terminal at every launch afterwards, with no visible way back.
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.ts'), 'utf8');
  // `[^}]*` cannot be used here: the request contains `tab: {}`, so a brace-excluding class stops
  // dead at it and the pattern silently never matches — a green-looking check that is really an
  // always-failing one. Match the two ends and require them close together instead.
  const guard = /if \(!resolveLayout\([\s\S]{0,200}?minimized: out\.minimized[\s\S]{0,200}?\)\.boxes\.length\) \{\s*return base;/;
  assert.ok(guard.test(src),
    'restoredPanes must discard a stored workspace that renders no boxes and fall back to the default');
}

// Native GPT usage has its own quota source; an absent Claude statusline must not replace it.
{
  const { statuslineFor } = require('../dist/frame');
  const { glyphs } = require('../dist/glyphs');
  const state = mkState(TABS());
  state.now = Date.parse('2026-09-11T12:00:00Z');
  // A codex-focused machine: gpt quota + measured month tokens, no claude statusline cache. The dual
  // readout shows the gpt row and does NOT nag about a claude statusline this machine never uses.
  state.usageBoth = {
    claude: { five: { pct: null, resetMs: null }, week: { pct: null, resetMs: null }, month: { pct: null, resetMs: null, tok: null } },
    gpt: { five: { pct: null, resetMs: null }, week: { pct: 20, resetMs: state.now + 86400000 }, month: { pct: null, resetMs: Date.parse('2026-10-01T00:00:00Z'), tok: 12000 } },
  };
  const native = statuslineFor(state, 180, glyphs('ascii'), 'none', 4).join('\n');
  assert.ok(!native.includes('run oak statusline'), native);
  assert.match(native, /20%/, 'the provider quota survives');
  assert.match(native, /12(?:\.0)?k/i, 'the measured calendar-month tokens survive');
  // No gpt data AND no claude cache → the claude row carries the install hint.
  state.usageBoth.gpt = null;
  assert.match(statuslineFor(state, 180, glyphs('ascii'), 'none', 4).join('\n'), /run oak statusline/);
  // An installed status line with nothing to show yet (a window just reset) is not told to install one.
  state.usage = { ...(state.usage || {}), statuslineCache: true };
  const empty = statuslineFor(state, 180, glyphs('ascii'), 'none', 4).join('\n');
  assert.ok(!empty.includes('run oak statusline') && /claude —/.test(empty), empty);
}

// A quota-less Claude plan (Enterprise, API): no window has a share, but the month's tokens are measured.
// With gpt data too, the whole Claude group vanished; it shows its tokens.
{
  const { statuslineFor } = require('../dist/frame');
  const { glyphs } = require('../dist/glyphs');
  const state = mkState(TABS());
  state.now = Date.parse('2026-09-11T12:00:00Z');
  state.usageBoth = {
    claude: { five: { pct: null, resetMs: null }, week: { pct: null, resetMs: null }, month: { pct: null, resetMs: Date.parse('2026-09-20T00:00:00Z'), tok: 11000000 } },
    gpt: { five: { pct: null, resetMs: null }, week: { pct: 41, resetMs: state.now + 3 * 86400000 }, month: { pct: null, resetMs: Date.parse('2026-10-01T00:00:00Z'), tok: 2400000 } },
  };
  const both = statuslineFor(state, 180, glyphs('ascii'), 'none', 1).join('\n');
  assert.match(both, /claude mo: 11(?:\.0)?M/, both);
  assert.match(both, /gpt wk: 41%/, both);
  assert.ok(!both.includes('run oak statusline'), both);
}

// The outer labels stay fixed while a session is pinned or changes its title/provider.
{
  const { tabLabel, glyphs } = tui;
  const tab = { id: 'review', kind: 'panes', name: 'review', panes: panes(),
    session: 'fixture', autoTitle: 'A conversation title', agent: 'claude', phase: 'working', active: true };
  assert.equal(tabLabel(tab, 2, glyphs('ascii')), 'review');
}

console.log('tabs: strip, row budget, hit test, hover, stored layout, native usage, fixed labels, and the blank-frame guard — all pinned');

// POINTER SHAPES: the bytes and the classification, without a terminal.
{
  const { pointerSeq, pointerForTreeHit, pointerForDockHit, dropZone } = tui;
  assert.equal(pointerSeq('ew-resize', false), '\x1b]22;ew-resize\x1b\\', 'OSC 22, ST-terminated');
  assert.equal(pointerSeq('grab', true), '\x1bPtmux;\x1b\x1b]22;grab\x1b\x1b\\\x1b\\', 'inside tmux: DCS passthrough with every ESC doubled');
  assert.equal(pointerForTreeHit({ kind: 'seam', axis: 'v' }), 'ew-resize', 'a vertical rule drags left/right');
  assert.equal(pointerForTreeHit({ kind: 'seam', axis: 'h' }), 'ns-resize', 'a horizontal rule drags up/down');
  assert.equal(pointerForTreeHit({ kind: 'pane', titleRow: true }), 'grab', 'a pane title is the drag handle');
  assert.equal(pointerForTreeHit({ kind: 'pane', titleRow: false }), 'text', 'a pane body is copyable text');
  assert.equal(pointerForTreeHit(null), 'default');
  assert.equal(pointerForDockHit({ t: 'seam' }, 'h'), 'ns-resize');
  assert.equal(pointerForDockHit({ t: 'seam' }, 'v'), 'ew-resize');
  assert.equal(pointerForDockHit({ t: 'tabbar' }), 'pointer');
  assert.equal(pointerForDockHit({ t: 'title' }), 'default', 'dock panes are not draggable');
  assert.equal(pointerForDockHit(null), 'default');
  assert.equal(dropZone(0.5, 0.5), 'swap', 'the middle swaps');
  assert.equal(dropZone(0.05, 0.5), 'left');
  assert.equal(dropZone(0.95, 0.5), 'right');
  assert.equal(dropZone(0.5, 0.02), 'top');
  assert.equal(dropZone(0.5, 0.98), 'bottom');
  assert.equal(dropZone(0.1, 0.05), 'top', 'the nearest edge wins a corner');
}
console.log('tabs: pointer shapes — pinned');

const { test } = require('node:test');
const usageFixture = (over = {}) => {
  const now = Date.parse('2026-09-19T12:00:00Z');
  const state = mkState(TABS()); state.now = now;
  state.usage = { fiveHourPct: 12, weekPct: 71, fablePct: 83, fableLabel: 'Fable',
    fiveReset: now + 3 * 3600000, weekReset: now + 2 * 86400000 + 5 * 3600000,
    fableReset: now + 2 * 86400000 + 5 * 3600000, ...over };
  state.usageBoth = { claude: {
    five: { pct: 12, resetMs: state.usage.fiveReset }, week: { pct: 71, resetMs: state.usage.weekReset },
    month: { pct: 50, resetMs: now + 10 * 86400000 },
  }, gpt: null };
  return state;
};
const usageRow = (state, width = 180) => tui.statuslineFor(state, width, tui.glyphs('ascii'), 'none', 1);

// The account's per-model weekly cap (its "Fable" row) is detail, not a window of the bar:
// the line is `5h · wk · mo` whatever the cap reports (a shared or a distinct reset, a
// zero share, another model's name), and wk keeps its own countdown throughout.
test('TUI usage: the bar is 5h · wk · mo with no per-model cap chip, and wk keeps its countdown', () => {
  const now = Date.parse('2026-09-19T12:00:00Z');
  const at = (ms) => tui.untilStr(ms, now);
  const five = now + 3 * 3600000, week = now + 2 * 86400000 + 5 * 3600000, month = now + 10 * 86400000;
  // The whole line, as the reader sees it with both providers (the 2026-09-24 screenshot's case: the
  // cap reports the week's own reset).
  const state = usageFixture();
  state.usageBoth.gpt = { five: { pct: null, resetMs: null }, week: { pct: 22, resetMs: now + 6 * 86400000 }, month: { pct: 33, resetMs: month } };
  assert.equal(usageRow(state)[0].trimEnd(),
    `✳ claude 5h: 12% ${at(five)} · wk: 71% ${at(week)} · mo: 50% ${at(month)}  |  ⬡ gpt wk: 22% ${at(now + 6 * 86400000)} · mo: 33% ${at(month)}`);
  for (const over of [{ fableReset: week + 59000 }, { fableReset: week + 86400000 }, { fablePct: 0 }, { fablePct: 12, fableLabel: 'Opus' }]) {
    const [line] = usageRow(usageFixture(over));
    assert.ok(line.includes(`claude 5h: 12% ${at(five)} · wk: 71% ${at(week)} · mo: 50% ${at(month)}`), line);
    assert.doesNotMatch(line, /Fable|Opus/, line);
  }
  // Compacted for a narrow terminal: the same three windows, without their countdowns.
  assert.match(usageRow(usageFixture(), 44)[0], /claude 5h: 12% · wk: 71% · mo: 50% *$/);
});

// ── the Diff face with nothing selected ──────────────────────────────────────────────────────────
// The rich-diff renderer heads every patch with `● Verb(path)`; with no patch and no edit that header
// came out as a bare `● Edit()` — a phantom edit on a session that had none (2026-09-22). Nothing
// selected draws nothing but the pane's own instruction.
{
  const tabs = TABS();
  tabs[1].panes = panes({ focus: 'detail' });
  const state = mkState(tabs, 1);
  // A LOADED session with no edits — `views: null` is "building…" on every face, a different state.
  state.views = { list: { edits: [] }, changemap: { files: [], summary: {} }, sessions: { sessions: [] }, prompts: { prompts: [] }, multitask: { agents: [] } };
  state.diffPatch = undefined; state.diffMeta = undefined;
  const text = renderDashFrame(state, { cols: 120, rows: 40, color: 'none' }).map(strip).join('\n');
  assert.ok(text.includes('select an edit in Traces to see its diff'), 'the empty Diff face says what to do');
  assert.ok(!text.includes('● Edit()') && !/●\s*\w+\(\)/.test(text), 'no phantom `● Edit()` header over an empty pane');
  // …and a real patch still gets its header.
  state.diffPatch = '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n';
  state.diffMeta = { id: 7, path: 'x.ts', added: 1, removed: 1, verb: 'Update' };
  const withPatch = renderDashFrame(state, { cols: 120, rows: 40, color: 'none' }).map(strip).join('\n');
  assert.ok(withPatch.includes('Update(x.ts)'), 'a selected edit keeps its header');
}

// One of a thing reads in the singular (the change map said "1 files · 1 edits").
require('node:test').test('TUI counts: one file and one edit read in the singular', () => {
  assert.strictEqual(tui.mapHeaderText({ files: 1, edits: 1 }), '  CHANGE MAP  1 file · 1 edit');
  assert.strictEqual(tui.mapHeaderText({ files: 2, edits: 3 }), '  CHANGE MAP  2 files · 3 edits');
});

require('node:test').test('Feed wrapping consumes ANSI source bytes without repeating long words', () => {
  const { wrapVisible, stripSgr, displayWidth } = require('../dist/textwidth');
  for (const word of ['transcription'.repeat(9), '猫😀'.repeat(25)]) {
    const styled = '\x1b[1m' + word + '\x1b[22m';
    for (const cols of [1, 34]) {
      const rows = wrapVisible(styled, cols);
      assert.equal(rows.map(stripSgr).join(''), word);
      assert.ok(rows.every(row => displayWidth(row) <= Math.max(cols, 2)), 'only a wide glyph may exceed a one-column viewport');
      assert.ok(rows.every(row => !/\x1b/.test(stripSgr(row))), 'no partial escape sequences');
    }
  }
});

require('node:test').test('Feed tail renders reply words normally, folds thoughts, and deduplicates each agent', () => {
  const { rowsFor } = require('../dist/frame');
  const state = { ...mkState(TABS()), screen: 'claude', views: { feed: { entries: [] } } };
  const render = entries => {
    state.views = { ...state.views, sessions: { sessions: [{ id: state.session, active: true }] }, feed: { entries } };
    return rowsFor(state, 70, tui.glyphs('ascii'), 'truecolor').filter(r => r.key.startsWith('clf') || r.key.startsWith('agent:')).map(r => r.cells);
  };
  const said = (ts, detail, reasoning) => ({ ts, detail, kind: 'reasoning', label: 'said', reasoningKind: 'text', reasoning });
  const words = 'Before **bold** after';
  const reply = render([said(1, 'alpha', words)]).join('\n');
  assert.match(strip(reply), /Before bold after/);
  assert.match(reply, /\x1b\[2m\[alpha\]/, 'the agent label is a separate dimmed tag');
  assert.doesNotMatch(reply, /\x1b\[22m\x1b\[2m/, 'closing bold must not dim the rest of a reply');
  const entries = [said(1, 'alpha', 'Alpha words'), said(2, 'beta', 'Beta words'),
    { ts: 3, detail: 'alpha', kind: 'action', label: 'Read', reasoning: 'Alpha words' },
    { ts: 4, detail: 'beta', kind: 'action', label: 'Read', reasoning: 'Beta words' }];
  const text = strip(render(entries).join('\n'));
  for (const words of ['Alpha words', 'Beta words']) assert.equal(text.split(words).length - 1, 1);
  const folded = render([{ ...said(1, '', 'Long thought '.repeat(100)), label: 'thinking', reasoningKind: 'thinking' }]);
  assert.equal(folded.length, 3);
  assert.match(strip(folded.join('\n')), /more rows.*F1 again/);
});

// Keys that must not act by accident, driven through the interactive app: a
// letter behind an open overlay, an alt chord, ctrl+a ctrl+k in the herdr tab, a palette action on the
// Observatory, and esc under a standing question.
for (const check of ['overlay-verbs', 'overlay-rebind', 'row-menu-key', 'row-menu-rebind', 'row-menu-unbound', 'stale-row-menu', 'search-under-overlay', 'search-help-filter', 'alt-verb', 'herdr-leader', 'palette-tabs', 'esc-confirm', 'esc-picker-delete']) require('node:test').test(`keys, driven: ${check}`, () => {
  const result = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'fixtures/keys-probe.cjs')], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, NODE_TEST_CONTEXT: '', OAK_KEYS_CHECK: check,
      ...(check === 'overlay-rebind' ? { OAK_KEYS_REBIND: JSON.stringify({ undo: 'k' }) } : check === 'row-menu-rebind' ? { OAK_KEYS_REBIND: JSON.stringify({ undo: 'k', keep: 'q' }) }
        : check === 'row-menu-unbound' ? { OAK_KEYS_REBIND: JSON.stringify({ keep: 'u' }) } : {}) },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stderr, new RegExp(`PASS: ${check}`));
});
