/**
 * Real tabs: the strip, the hit test, hover, and the stored layout.
 *
 * These pin the properties that make tabs feel real rather than painted on — a click landing on the
 * tab it was drawn over, a hover that reveals a model without inventing one, and a saved layout that
 * degrades to the defaults instead of to a blank frame.
 */
const assert = require('node:assert/strict');
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
  assert.equal(tabLabel(tab, 2, glyphs('ascii')), 'F3 review');
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
// the line is `wk · mo` whatever the cap reports (a shared or a distinct reset, a
// zero share, another model's name), and wk keeps its own countdown throughout. No bar shows the 5-hour
// window, for any plan (the fixture has one).
test('TUI usage: the bar is wk · mo with no 5h or per-model cap chip, and wk keeps its countdown', () => {
  const now = Date.parse('2026-09-19T12:00:00Z');
  const at = (ms) => tui.untilStr(ms, now);
  const week = now + 2 * 86400000 + 5 * 3600000, month = now + 10 * 86400000;
  // The whole line, as the reader sees it with both providers (a cap that reports the week's own
  // reset).
  const state = usageFixture();
  state.usageBoth.gpt = { five: { pct: 4, resetMs: now + 3600000 }, week: { pct: 22, resetMs: now + 6 * 86400000 }, month: { pct: 33, resetMs: month } };
  assert.equal(usageRow(state)[0].trimEnd(),
    `✳ claude wk: 71% ${at(week)} · mo: 50% ${at(month)}  |  ⬡ gpt wk: 22% ${at(now + 6 * 86400000)} · mo: 33% ${at(month)}`);
  for (const over of [{ fableReset: week + 59000 }, { fableReset: week + 86400000 }, { fablePct: 0 }, { fablePct: 12, fableLabel: 'Opus' }]) {
    const [line] = usageRow(usageFixture(over));
    assert.ok(line.includes(`✳ claude wk: 71% ${at(week)} · mo: 50% ${at(month)}`), line);
    assert.doesNotMatch(line, /Fable|Opus|5h:/, line);
  }
  // Compacted for a narrow terminal: the same windows, without their countdowns.
  assert.match(usageRow(usageFixture(), 34)[0], /^✳ claude wk: 71% · mo: 50% *$/);
  // A GPT reading with a 5-hour window alone has nothing for the bar, so it draws no gpt group, as the editors hide it.
  state.usageBoth.gpt = { five: { pct: 4, resetMs: now + 3600000 }, week: { pct: null, resetMs: null }, month: { pct: null, resetMs: null } };
  assert.equal(usageRow(state)[0].trimEnd(), `✳ claude wk: 71% ${at(week)} · mo: 50% ${at(month)}`);
});

// The month ends with its dollar figure, after its reset, as core's monthUsd writes it (the Claude Code status line's
// text): `~` where it is the estimate at list prices, none where it is the charge Claude Code reported. No figure,
// nothing drawn (the test above).
test('TUI usage: the month ends with its dollar figure, for Claude and GPT', () => {
  const now = Date.parse('2026-09-19T12:00:00Z');
  const at = (ms) => tui.untilStr(ms, now);
  const week = now + 2 * 86400000 + 5 * 3600000, month = now + 10 * 86400000, gweek = now + 22 * 3600000;
  const state = usageFixture();
  state.usageBoth.claude.month.usd = '~$10.0k';
  state.usageBoth.gpt = { five: { pct: 4, resetMs: now + 3600000 }, week: { pct: 9, resetMs: gweek }, month: { pct: 2, resetMs: month, usd: '~$13' } };
  assert.equal(usageRow(state)[0].trimEnd(),
    `✳ claude wk: 71% ${at(week)} · mo: 50% ${at(month)} ~$10.0k  |  ⬡ gpt wk: 9% ${at(gweek)} · mo: 2% ${at(month)} ~$13`);
  // Compacted, the countdowns go and the figures stay; narrower still, the figures go before any is cut short.
  assert.match(usageRow(state, 70)[0], /^✳ claude wk: 71% · mo: 50% ~\$10\.0k  \|  ⬡ gpt wk: 9% · mo: 2% ~\$13 *$/);
  assert.match(usageRow(state, 64)[0], /^✳ claude wk: 71% · mo: 50%  \|  ⬡ gpt wk: 9% · mo: 2% *$/);
  // A plan with no rolling windows (pay-as-you-go API): the month is its charge alone.
  state.usageBoth.claude = { five: { pct: null, resetMs: null }, week: { pct: null, resetMs: null }, month: { pct: null, resetMs: null, usd: '$12' } };
  state.usageBoth.gpt = null;
  assert.equal(usageRow(state)[0].trimEnd(), '✳ claude mo: $12');
});

// Where this machine had no current share, the readout is a saved machine's reading of the account, and says so.
test('TUI usage: a reading from a saved machine names that machine after the provider, at every width', () => {
  const now = Date.parse('2026-09-19T12:00:00Z');
  const at = (ms) => tui.untilStr(ms, now);
  const week = now + 2 * 86400000 + 5 * 3600000, month = now + 10 * 86400000;
  const state = usageFixture();
  assert.match(usageRow(state)[0], /^✳ claude wk: 71%/, 'control: this machine\'s own reading names no machine');
  state.usageBoth.claude.machine = 'build-box';
  assert.equal(usageRow(state)[0].trimEnd(), `✳ claude (build-box) wk: 71% ${at(week)} · mo: 50% ${at(month)}`);
  assert.match(usageRow(state, 46)[0], /^✳ claude \(build-box\) wk: 71% · mo: 50% *$/, 'compacted, it keeps the name');
  state.usageBoth.claude.machine = 'build-box: wk';
  assert.match(usageRow(state)[0], /^✳ claude \(build-box: wk\) wk: 71% /, 'a machine that supplied some windows names them');
  // Where the name and every window cannot share the row, the name gives up its room first: no window loses its
  // share, with GPT's on the row too, and the reading still says it is another machine's.
  state.usageBoth.claude.machine = 'gpu-build-server-in-the-basement-lab-rack-7';
  for (const width of [40, 50]) {
    const [row] = usageRow(state, width);
    assert.match(row, /^✳ claude \(gpu-[^)]*\) wk: 71% · mo: 50% *$/, `${width} columns: ${row}`);
  }
  state.usageBoth.gpt = { five: { pct: 4, resetMs: null }, week: { pct: 37, resetMs: null }, month: { pct: 12, resetMs: null } };
  for (const width of [64, 80]) {
    const [row] = usageRow(state, width);
    assert.match(row, /^✳ claude \(gpu-[^)]*\) wk: 71% · mo: 50%  \|  ⬡ gpt wk: 37% · mo: 12% *$/, `${width} columns: ${row}`);
  }
});

// The bar shows wk and mo, and names a saved machine by those windows alone; the machine's herdr label shows
// without its hidden characters. Drawn from core's own reading of a saved machine's cache, as the app reads it.
test('TUI usage: the bar names a saved machine only for the windows it shows, by a label with nothing hidden in it', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const crypto = require('node:crypto');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-tabs-usage-'));
  const was = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(`${file}.tmp`, JSON.stringify(value)); fs.renameSync(`${file}.tmp`, file); };
  try {
    process.env.HOME = process.env.USERPROFILE = home;
    process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
    const now = Date.now(), nowS = Math.floor(now / 1000);
    put(path.join(home, '.claude', '.claude.json'), { oauthAccount: { accountUuid: 'acct-1' } });
    // This machine's 5-hour and weekly shares are live, its month too; the per-model cap comes from the saved machine.
    put(path.join(home, '.claude', 'statusline-last.json'), { v: 3, five_pct: 9, five_at: nowS - 30, five_reset: nowS + 3600, week_pct: 30, week_at: nowS - 30, week_reset: nowS + 86400,
      month_tok: 1000000, month_tok_total: 50000000, month_reset: nowS + 5 * 86400 });
    const machine = (label, brief) => ({ label, target: 'me@build-box', brief: { brief: 1, account: crypto.createHash('sha256').update('acct-1').digest('hex').slice(0, 12), at: now,
      five: null, week: null, fable: { pct: 9, reset: now + 2 * 86400000, at: now - 60000, tok: null, total: null, label: 'Fable' }, month: null, ...brief } });
    put(core.machineUsageCachePath(), { version: 1, attemptedAt: now, machines: [machine('build-box', {})] });
    const row = () => usageRow({ ...usageFixture(), now, usageBoth: core.usageBrief(home) })[0].trimEnd();
    assert.equal(core.usageLine(home, '').machineNote, 'build-box: fable', 'control: the cap is the saved machine\'s');
    assert.match(row(), /^✳ claude wk: 30% .* · mo: 2% /, 'the bar names no machine: none of its windows is one\'s');
    // Its 5-hour share alone: the bar shows no 5h, so it names no machine either, where the Stats panels, which show the
    // 5h, name it.
    const five = { pct: 4, reset: now + 3 * 3600000, at: now - 30000, tok: null, total: null };
    put(path.join(home, '.claude', 'statusline-last.json'), { v: 3, week_pct: 30, week_at: nowS - 30, week_reset: nowS + 86400, month_tok: 1000000, month_tok_total: 50000000, month_reset: nowS + 5 * 86400 });
    put(core.machineUsageCachePath(), { version: 1, attemptedAt: now, machines: [machine('build-box', { fable: null, five })] });
    assert.deepEqual([core.usageLine(home, '').machineNote, core.usageLine(home, '').machineBarNote, core.usageLine(home, '').machineTipNote], ['build-box: 5h', '', ''],
      'control: the 5h is the saved machine\'s');
    assert.match(row(), /^✳ claude wk: 30% .* · mo: 2% /, row());
    // Its week, from a label with bidi controls and zero-width characters in it: named, and nothing hidden.
    const week = { pct: 4, reset: now + 2 * 86400000, at: now - 30000, tok: null, total: null };
    put(path.join(home, '.claude', 'statusline-last.json'), { v: 3, month_tok: 1000000, month_tok_total: 50000000, month_reset: nowS + 5 * 86400 });
    put(core.machineUsageCachePath(), { version: 1, attemptedAt: now, machines: [machine('build\u202e-\u200bbox\u2066\u200f\ufeff', { week })] });
    assert.match(row(), /^✳ claude \(build-box: wk\) wk: 4% /, row());
    assert.doesNotMatch(row(), /[\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u);
  } finally {
    for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// No bar shows the 5-hour window, for any plan: an account with one keeps it on the status line port (the Claude Code
// status line's own readout), and an account with no five-hour limit (its newest usage answer carries no 5h window, as
// a verified Ultra account's does) has no 5h segment there either, and leaves no gap where it was, whatever 5h share the
// cache holds. Drawn from core's own reading of the cache, as the app reads it.
test('TUI usage: the bar never shows the 5h window; the status line port shows it where the account has one', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-tabs-no5h-'));
  const was = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  try {
    process.env.HOME = process.env.USERPROFILE = home;
    process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
    fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
    const now = Date.now(), nowS = Math.floor(now / 1000);
    // A 5h share measured half a minute ago, after the account answered, a minute ago, that it has no five-hour limit.
    const cache = { v: 3, five_pct: 12, five_at: nowS - 30, five_reset: nowS + 3600, week_pct: 30, week_at: nowS - 60, week_reset: nowS + 86400,
      month_tok: 1000000, month_tok_total: 50000000, month_reset: nowS + 5 * 86400 };
    const put = (c) => fs.writeFileSync(path.join(home, '.claude', 'statusline-last.json'), JSON.stringify(c));
    const row = () => usageRow({ ...usageFixture(), now, usageBoth: core.usageBrief(home) })[0].trimEnd();
    const port = () => tui.statuslineGauges(tui.statuslineDataFor({ now, usage: core.usageLine(home, ''), views: {}, session: '' }), 'none', false);
    put(cache);
    assert.equal(core.usageLine(home, '').fiveHourPct, 12, 'control: the account has a 5-hour window');
    assert.match(port(), /^5h \[[^\]]+\] 12% ·/, 'the status line port shows it');
    assert.match(row(), /^✳ claude wk: 30% \S.* · mo: 2% /, `the bar does not, and leaves no gap — got ${JSON.stringify(row())}`);
    assert.doesNotMatch(row(), /5h:/);
    put({ ...cache, five_none_at: nowS - 60 });
    assert.match(row(), /^✳ claude wk: 30% \S.* · mo: 2% /, `no 5h chip, and no gap — got ${JSON.stringify(row())}`);
    assert.match(port(), /^wk \[[^\]]+\] 30% ·/, `no 5h segment — got ${JSON.stringify(port())}`);
    assert.doesNotMatch(port(), /5h/);
    // Control: an answer with a 5h window since brings the segment back, and still no chip.
    put({ ...cache, five_none_at: nowS - 60, five_seen_at: nowS - 40 });
    assert.match(row(), /^✳ claude wk: 30% \S.* · mo: 2% /, 'an answer with a 5h window since: still no 5h chip');
    assert.match(port(), /^5h \[[^\]]+\] 12% ·/, 'and the 5h segment');
  } finally {
    for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── the Diff face with nothing selected ──────────────────────────────────────────────────────────
// The rich-diff renderer heads every patch with `● Verb(path)`; with no patch and no edit that header
// came out as a bare `● Edit()` — a phantom edit on a session that had none. Nothing
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

// ── Prompts for a session whose transcript is gone ───────────────────────────────────────────────
// The CLI answers `{"transcript":null,"error":…}` when it has nothing to list; the pane gives that reason, never
// "yet". When the local index kept the asks, they are listed with the note that says where they came from.
{
  const tabs = TABS();
  tabs[1].panes = panes({ focus: 'prompts', zoom: 'prompts' });
  const state = mkState(tabs, 1);
  state.screen = 'prompts';
  const base = { list: { edits: [] }, changemap: { files: [], summary: {} }, sessions: { sessions: [] }, multitask: { agents: [] } };
  const draw = (prompts) => { state.views = { ...base, prompts }; return renderDashFrame(state, { cols: 120, rows: 40, color: 'none' }).map(strip).join('\n'); };
  const refused = draw({ session: 'abc', transcript: null, error: 'no transcript found for this session under this directory' });
  assert.match(refused, /nothing on Prompts — the oak CLI answered: no transcript found for this session under this directory/, 'the refusal, in the CLI\'s words');
  assert.doesNotMatch(refused, /fills in as the agent works/, '…not "yet"');
  assert.match(draw({ session: 'abc', summary: { total: 0 }, prompts: [] }), /nothing on Prompts yet — it fills in as the agent works/, 'control: a real empty list is still "yet"');
  const kept = draw({ session: 'abc', fromIndex: true, note: 'the transcript is gone; these asks and answers are what the local database kept of it',
    summary: { total: 1 }, prompts: [{ id: 'p1', index: 1, text: 'Teach the zebracorn lexer', ts: 1, endTs: 2, edits: 0 }] });
  assert.match(kept, /the transcript is gone; these asks and answers are what the local database kept of it/, 'an index-kept list says so');
  assert.match(kept, /Teach the zebracorn lexer/, '…above the asks it kept');
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
  assert.match(strip(folded.join('\n')), /more rows.*F8 again/);
});

// Keys driven through the interactive app: nothing acts by accident (a letter behind an open overlay, an
// alt chord, a Review verb on the Observatory, a palette action on the wrong tab, esc under a question),
// and every 0.11.0 mapping and confirm is pressed for real: herdr's prefix, Tab, R/X, U, D, :, r, reset.
const KEY_CHECK_ENV = {
  'overlay-rebind': { OAK_KEYS_REBIND: JSON.stringify({ undo: 'k' }) },
  'row-menu-rebind': { OAK_KEYS_REBIND: JSON.stringify({ undo: 'k', keep: 'q' }) },
  'row-menu-unbound': { OAK_KEYS_REBIND: JSON.stringify({ keep: 'u' }) },
  'hints-rebind': { OAK_KEYS_REBIND: JSON.stringify({ keep: 'k' }) },
  'refresh-confirm': { OAK_KEYS_WOULD_DROP: '3' },
  'herdr-prefix-config': { OAK_KEYS_HERDR_CONFIG: '[keys]\nprefix = "ctrl+g"\ndetach = "prefix+m"\n' },
  'herdr-prefix-legacy': { OAK_KEYS_HERDR_CONFIG: 'keys.prefix = "ctrl+space"\n' },
  'herdr-prefix-none': { OAK_KEYS_HERDR_CONFIG: '[keys]\nprefix = "super+b"\n' },
  'herdr-prefix-upper': { OAK_KEYS_HERDR_CONFIG: '[keys]\nprefix = "Ctrl+A"\n' },
  'herdr-prefix-ctrl-q': { OAK_KEYS_HERDR_CONFIG: '[keys]\nprefix = "ctrl+q"\n' },
  'rebind-blocked': { OAK_KEYS_REBIND: JSON.stringify({ keep: 'c' }) },
  'rebind-blocked-first-run': { OAK_KEYS_REBIND: JSON.stringify({ keep: ' ' }) },
  'kept-prefs-blocked': { OAK_KEYS_REBIND: JSON.stringify({ keep: ' ' }) },
  'palette-unbound': { OAK_KEYS_REBIND: JSON.stringify({ redo: 'D' }) },
  'palette-unbound-obs': { OAK_KEYS_REBIND: JSON.stringify({ session: 'r' }), OAK_KEYS_WOULD_DROP: '1' },
};
// Where a check's launch runs besides here, a repository: the first run's notice from a folder in no repository too,
// where Review takes the newest session on any machine and says so (it said so over the notice, and only a run from a
// tree without a .git saw it).
const KEY_CHECK_OUTSIDE_REPO = new Set(['rebind-blocked-first-run']);
for (const check of ['overlay-verbs', 'overlay-rebind', 'row-menu-key', 'row-menu-rebind', 'row-menu-unbound', 'stale-row-menu', 'search-under-overlay',
  'search-help-filter', 'alt-verb', 'herdr-prefix', 'herdr-prefix-config', 'herdr-prefix-motion', 'herdr-prefix-legacy', 'herdr-prefix-none', 'herdr-prefix-upper',
  'herdr-prefix-kitty-shift', 'herdr-prefix-ctrl-q', 'herdr-prefix-switch', 'obs-jk', 'confirm-tab-note', 'rebind-blocked', 'rebind-blocked-first-run', 'kept-prefs-first-run',
  'kept-prefs-blocked', 'palette-unbound', 'palette-unbound-obs', 'tab-keys', 'obs-keys', 'obs-buttons', 'redo-key', 'palette-tabs',
  'refresh-confirm', 'options-reset', 'store-back', 'reset-keeps-elsewhere', 'rebind-reserved', 'filter-per-tab', 'overlay-close', 'hints-rebind', 'esc-confirm', 'esc-picker-delete']) require('node:test').test(`keys, driven: ${check}`, (t) => {
  const fs = require('node:fs'), os = require('node:os');
  const outside = KEY_CHECK_OUTSIDE_REPO.has(check) ? fs.mkdtempSync(path.join(os.tmpdir(), 'oak-keys-cwd-')) : null;
  if (outside) t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  if (outside) assert.equal(core.repoRoot(outside), null, `control: ${outside} is in no repository`);
  for (const cwd of [undefined, outside].filter((d) => d !== null)) for (const platform of check === 'herdr-prefix-none' ? ['linux', 'darwin'] : [null]) {
    const probe = path.join(__dirname, 'fixtures/keys-probe.cjs');
    const args = platform ? ['-e', `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} }); process.argv[1] = ${JSON.stringify(probe)}; require(process.argv[1]);`] : [probe];
    const result = require('child_process').spawnSync(process.execPath, args, {
      encoding: 'utf8', timeout: 30000, cwd, env: { ...process.env, NODE_TEST_CONTEXT: '', OAK_KEYS_CHECK: check, ...(KEY_CHECK_ENV[check] ?? {}) },
    });
    assert.equal(result.status, 0, `${cwd ? 'outside every repository' : 'here'}: ${result.stderr || result.error?.message}`);
    assert.match(result.stderr, new RegExp(`PASS: ${check}`));
  }
});

// Account totals keep the same text on both machines; hovering names the measured union or local fallback.
{
  const state = mkState(TABS());
  state.usageBoth = { claude: { five: { pct: null }, week: { pct: null }, month: { pct: null }, machine: '' },
    gpt: { five: { pct: null }, week: { pct: 20 }, month: { pct: 11, tok: 10_000_000, usd: '~$18' }, measuredMachines: 'work-box, build-box' } };
  const line = tui.statuslineFor(state, 200, {}, 'none', 1)[0].trim();
  assert.equal(line, '⬡ gpt wk: 20% · mo: 11% ~$18');
  state.hoverUsage = true;
  assert.match(tui.statusWithToast('ready', state, 200), /GPT estimates include usage measured on work-box, build-box/);
  state.usageBoth.gpt.usageFreshness = 'Usage received — build-box: 2026-11-04T12:00:00.000Z (stale; unreachable)';
  assert.match(tui.statusWithToast('ready', state, 100), /12:00:00.000Z.*stale; unreachable/);
  state.usageBoth.gpt.usageFreshness = '';
  state.usageBoth.gpt.measuredMachines = 'this machine alone';
  assert.match(tui.statusWithToast('ready', state, 200), /GPT estimates include usage measured on this machine alone/);
}
