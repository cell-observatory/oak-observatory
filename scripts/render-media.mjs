#!/usr/bin/env node
/**
 * Renders the README's feature images (docs/media/*.png) — faithful mockups of the extension UI,
 * rasterized with headless Chrome at 2x. Regenerate after UI changes: `node scripts/render-media.mjs`.
 */
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { resolveChrome, capturePng, fitToContent } from './chrome.mjs';
import { tmpdir } from 'os';
import { join } from 'path';

let CHROME;
if (!process.argv.includes('--html-only')) {
  try { CHROME = resolveChrome(); }
  catch (error) { console.error(error.message); process.exit(1); }
}
const OUT = new URL('../docs/media/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

// ---------- shared look (VS Code Dark Modern-ish + the extension's own colors) ----------
const CSS = `
  * { box-sizing: border-box; margin: 0; }
  :root {
    --bg:#1f1f1f; --side:#181818; --panel:#181818; --border:#2b2b2b; --border2:#3c3c3c;
    --ink:#cccccc; --dim:#9d9d9d; --faint:#6e6e6e;
    --pending:#d9a441; --kept:#3fb950; --reverted:#8b949e;
    --blue:#4c8bf5; --purple:#9a6ac2; --orange:#c9713f; --accent:#4c8bf5; --coral:#cc785c;
    /* The change bar is GREEN in the product and always has been — ADDED_BAR is rgba(88,166,100,0.9)
       used as the decoration's borderColor, over an ADDED_LINE_BG of the same green at 0.30. This
       said coral, so four published images (layout, inline-review, spotlight, map) advertised an
       edge colour the editor has never drawn. Coral is the brand accent, not the change bar. */
    --hl:rgba(88,166,100,0.30); --hlborder:#58a664; --delborder:#f85149; --delhl:rgba(248,81,73,0.09);
  }
  body { font-family:-apple-system,'Segoe UI',sans-serif; font-size:13px; color:var(--ink); background:#000; }
  .mono { font-family:'SF Mono',Menlo,monospace; }
  .window { background:var(--bg); border:1px solid #000; border-radius:10px; overflow:hidden;
            box-shadow:0 20px 60px rgba(0,0,0,.6); }
  .titlebar { height:36px; background:#2a2a2a; display:flex; align-items:center; padding:0 14px; gap:8px;
              border-bottom:1px solid var(--border); }
  .tl { width:12px; height:12px; border-radius:50%; }
  .titlebar .t { flex:1; text-align:center; color:var(--dim); font-size:12px; }
  .row { display:flex; align-items:center; }
  /* tree */
  .viewhead { font-size:11px; letter-spacing:.08em; color:var(--dim); padding:8px 14px 4px; font-weight:600; }
  .trow { display:flex; align-items:center; gap:7px; padding:3.5px 10px; font-size:13px; }
  .trow .tw { color:var(--faint); width:12px; font-size:10px; }
  .trow .ic { width:16px; text-align:center; }
  .trow .meta { margin-left:auto; color:var(--faint); font-size:11px; white-space:nowrap; }
  /* A file header carries the path AND its scope buttons. The panel WRAPS rather than truncating
     (the product's own rule), so the mock has to wrap too — clipping "✗ file" off the edge would
     depict a control the reader cannot see. */
  .trow.fhead { flex-wrap:wrap; row-gap:1px; }
  .trow.fhead b { overflow-wrap:anywhere; }
  .pill { font-size:10px; padding:1px 7px; border-radius:9px; border:1px solid currentColor; }
  .p-pending{color:var(--pending)} .p-kept{color:var(--kept)} .p-reverted{color:var(--reverted)}
  .strike { text-decoration:line-through; color:var(--faint); }
  .dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
  /* editor */
  .codeline { display:flex; font-family:'SF Mono',Menlo,monospace; font-size:12.5px; line-height:1.75; }
  .codeline > span:last-child { white-space:pre; }
  .codeline .ln { width:44px; text-align:right; padding-right:16px; color:#6e7681; user-select:none; }
  .codeline.hl { background:var(--hl); box-shadow:inset 3px 0 0 var(--hlborder); }
  /* deletion: red line highlight + bar with the removed line shown as red "ghost" text */
  .codeline.del { background:var(--delhl); box-shadow:inset 3px 0 0 var(--delborder); }
  .delnote { color:var(--delborder); font-style:italic; font-size:11.5px; margin-left:26px; }
  .codelens { font-size:11px; color:var(--dim); padding:2px 0 0 60px; font-family:-apple-system,sans-serif; }
  .codelens a { color:var(--dim); text-decoration:none; margin-right:15px; }
  .codelens a.why { font-style:italic; color:var(--faint); }
  /* the compact review BAR (0.10.0 default in-editor surface) — a comment thread with no body, so the
     widget collapses to one row: the live title on the left, its buttons on the right. Unresolved paints
     the frame + the arrow in the theme's needs-attention colour, so it reads as a band pointing AT the
     edit it is anchored to (the line directly above it). */
  .revbar { position:relative; display:flex; align-items:center; gap:16px; margin:5px 0 5px 44px; max-width:920px;
            padding:6px 13px; background:#252526; border:1px solid var(--border2); border-left:3px solid var(--pending);
            border-radius:5px; }
  .revbar::before { content:''; position:absolute; top:-6px; left:26px; border-left:6px solid transparent;
                    border-right:6px solid transparent; border-bottom:6px solid var(--pending); }
  .revbar .rb-t { font-family:'SF Mono',Menlo,monospace; font-size:12px; color:var(--ink); white-space:nowrap; }
  .revbar .rb-b { margin-left:auto; display:flex; align-items:center; gap:15px; font-size:13px; color:var(--dim); white-space:nowrap; }
  .tok-k{color:#569cd6} .tok-f{color:#dcdcaa} .tok-s{color:#ce9178} .tok-c{color:#6a9955} .tok-v{color:#9cdcfe}
  .gutstar { color:var(--coral); font-size:11px; margin-right:6px; }
  /* a diff body in git's colors (the diff tab and the stacked view) */
  .bb-diff { font-family:'SF Mono',Menlo,monospace; font-size:12px; line-height:1.7; padding:8px 0; }
  .bb-diff .dl { display:block; padding:0 13px; white-space:pre; }
  .bb-diff .add { background:rgba(63,185,80,0.15); color:#7ee787; }
  .bb-diff .rem { background:rgba(248,81,73,0.15); color:#ffa198; }
  .bb-diff .ctx { color:var(--dim); }
  .bb-diff .hunk { color:var(--blue); }
  /* The stacked view (stacked-diffs.png): the bands carry add/remove and the code keeps its syntax
     colours (no green/red foreground), and Spotlight, on by default, dims the unmodified lines. */
  .stk .dl.add, .stk .dl.rem, .stk .dl.ctx { color:var(--ink); }
  .stk .dl.ctx { opacity:.35; }
  .stk .dl.hunk { opacity:.65; }
  .stk-bar { display:flex; align-items:center; gap:8px; padding:6px 16px; background:var(--side); border-bottom:1px solid var(--border); font-size:12px; }
  .stk-bar .ttl { color:var(--dim); margin-right:auto; font-family:'SF Mono',Menlo,monospace; }
  .stk-bt { border:1px solid var(--border2); border-radius:3px; padding:2px 8px; font-size:11.5px; color:var(--ink); background:#313131; white-space:nowrap; }
  .stk-bt.on { background:#0e639c; border-color:#0e639c; color:#fff; }
  .stk-bt.keep { color:#3fb950; } .stk-bt.undo { color:#e5534b; }
  /* panel bits */
  .paneltabs { display:flex; gap:18px; padding:6px 16px 0; font-size:11px; letter-spacing:.05em; color:var(--faint);
               border-bottom:1px solid var(--border); background:var(--panel); }
  .paneltabs .on { color:var(--ink); border-bottom:1.5px solid var(--accent); padding-bottom:6px; }
  .paneltabs span { padding-bottom:6px; }
  .col { padding:8px 0; overflow:hidden; }
  .colhead { font-size:10.5px; letter-spacing:.09em; color:var(--dim); padding:4px 16px 6px; font-weight:600; }
  .obsrow { display:flex; gap:8px; padding:4px 16px; font-size:12.5px; align-items:baseline; }
  .obsrow .r { color:var(--dim); min-width:0; overflow-wrap:anywhere; }
  .obsrow .id { color:var(--ink); }
  /* stats */
  .seg { display:flex; border:1px solid var(--border2); border-radius:5px; overflow:hidden; margin:10px 16px; }
  .seg div { flex:1; text-align:center; font-size:10.5px; padding:4px 0; color:var(--dim); }
  .seg .on { background:var(--accent); color:#111; font-weight:600; }
  .plothead { display:flex; justify-content:space-between; padding:2px 16px 4px; }
  .pname { font-size:10px; letter-spacing:.1em; color:var(--dim); font-family:'SF Mono',Menlo,monospace; }
  .legend { display:flex; gap:9px; font-size:9.5px; color:var(--dim); }
  .legend i { width:9px; height:2.5px; display:inline-block; border-radius:1px; margin-right:4px; vertical-align:middle; }
  .plotbody { padding:0 16px 6px 46px; position:relative; }
  .yt { position:absolute; left:8px; width:32px; text-align:right; font-size:8.5px; color:var(--faint);
        font-family:'SF Mono',Menlo,monospace; transform:translateY(-50%); }
  .pax { display:flex; justify-content:space-between; font-size:9px; color:var(--faint); padding:2px 16px 8px 46px;
         font-family:'SF Mono',Menlo,monospace; }
  .uhead { font-size:10px; letter-spacing:.1em; color:var(--dim); padding:8px 16px 4px; font-family:'SF Mono',Menlo,monospace; }
  .urow { display:flex; align-items:center; gap:8px; padding:2px 16px; height:20px; font-family:'SF Mono',Menlo,monospace; font-size:11px; }
  .urow .lbl { width:24px; color:var(--dim); }
  .track { flex:1; height:5px; border-radius:3px; background:#333; overflow:hidden; }
  .fill { display:block; height:100%; border-radius:3px; }
  .pct { width:34px; text-align:right; }
  .sub { min-width:86px; color:var(--faint); }
  .uhead.uusage { display:flex; align-items:center; }
  .ulast { margin-left:auto; display:flex; align-items:center; gap:7px; font-size:8.5px; letter-spacing:0; color:var(--faint); }
  .ulast .uref { color:var(--dim); font-size:11px; }
  .uusage ~ .urow .lbl { width:36px; }
  /* status bar */
  .statusbar { height:24px; background:#181818; border-top:1px solid var(--border); display:flex; align-items:center;
               padding:0 10px; gap:14px; font-size:11.5px; color:var(--dim); }
  .sb-warn { background:#8a6d00; color:#fff; padding:1px 8px; border-radius:3px; display:flex; gap:5px; align-items:center; }
  .hovercard { background:#252526; border:1px solid #454545; border-radius:5px; padding:10px 12px;
               box-shadow:0 6px 24px rgba(0,0,0,.5); font-size:12px; width:340px; }
  .hovercard .actions { display:flex; gap:12px; margin-top:8px; }
  .hovercard .actions span { color:var(--accent); font-size:12px; }
  /* review scoreboard (Stats) */
  .scoreboard { display:flex; gap:6px; margin:2px 16px 8px; }
  .sc { flex:1; text-align:center; border:1px solid var(--border); border-radius:6px; padding:6px 2px; }
  .scn { font-size:18px; font-weight:600; line-height:1.05; font-family:'SF Mono',Menlo,monospace; }
  .scl { font-size:8.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); margin-top:2px; }
  .scmeta { display:flex; justify-content:space-between; font-size:9px; color:var(--dim); margin:5px 16px 0;
            font-family:'SF Mono',Menlo,monospace; }
  /* terminal (CLI + conflict scenes) — the terminal is a first-class front-end */
  .term { font-family:'SF Mono',Menlo,monospace; font-size:13px; line-height:1.9; padding:14px 20px; background:#141414; }
  .term .cmd { color:var(--ink); } .term .cmd .pr { color:var(--kept); margin-right:9px; } .term .cmd .fl { color:var(--blue); }
  .term .out { color:var(--dim); white-space:pre-wrap; overflow-wrap:anywhere; } .term .ok { color:var(--kept); } .term .warn { color:var(--pending); }
  .term .id2 { color:var(--coral); } .term .add2 { color:#7ee787; } .term .rem2 { color:#ffa198; } .term .file2 { color:var(--ink); }
  .term .cursor { background:var(--ink); color:#141414; }
  /* file spotlight: dim every unmodified line so Claude's edits spotlight */
  .codeline.dim { opacity:.3; }
  .difftab { display:flex; align-items:center; background:var(--side); border-bottom:1px solid var(--border); }
  .difftab .tab { padding:8px 16px; background:var(--bg); border-right:1px solid var(--border); font-size:12.5px; }
  .difftab .acts { margin-left:auto; padding:0 14px; color:var(--dim); font-size:11.5px; }
  .difftab .acts span { margin-left:15px; }
`;

const scene = (w, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head>
   <body style="width:${w}px;padding:24px;">${body}</body></html>`;

const microscope = '🔬';

// ---------- scene bits reused across images ----------
// REVIEW is the sidebar's one review surface (0.9.4 removed the Edits and Diffs trees). It holds no
// code: rows are GROUPED BY FILE under a header whose ✓/✗ act on exactly the pending work listed
// beneath it, one row per piece of code however many times it was revised, and the panel ends with
// the cancelled-out footer when the session has chains that go nowhere. Its own toolbar (an inline
// search field — regex is automatic when the query carries regex syntax — a file-type / extension
// filter, a sort toggle, prev/next, keep/undo/redo all, clear resolved, session, refresh, inline
// toggle) sits in the view title bar, which the platform draws — not part of this mock. Each file
// header shows how long ago it last changed, which IS in the tree body, so it appears here.
const reviewList = `
  <div class="viewhead">REVIEW <span style="float:right;color:var(--faint)">3 pending</span></div>
  <div class="trow" style="padding-left:10px;gap:5px;font-size:11px;color:var(--dim)">
    <span style="border:1px solid var(--line);border-radius:3px;padding:1px 5px">Open all in editor</span>
    <span style="border:1px solid var(--line);border-radius:3px;padding:1px 5px">Keep all (3)</span>
    <span style="border:1px solid var(--line);border-radius:3px;padding:1px 5px">Undo all</span>
  </div>
  <div class="trow mono fhead" style="padding-left:10px"><span style="color:var(--faint);font-size:10px;margin-right:6px">14:43:02</span><b>src/features.py</b><span class="meta">1 pending &nbsp;✓ file&nbsp; ✗ file</span></div>
  <div class="trow mono" style="padding-left:20px"><span class="dot" style="background:var(--pending)"></span>&nbsp;#1<span class="meta">+6 −1 &nbsp;✓&nbsp; ✗</span></div>
  <div class="trow mono fhead" style="padding-left:10px"><span style="color:var(--faint);font-size:10px;margin-right:6px">14:42:07</span><b>src/train.py</b><span class="meta">1 pending &nbsp;✓ file&nbsp; ✗ file</span></div>
  <div class="trow mono" style="padding-left:20px"><span class="dot" style="background:var(--pending)"></span>&nbsp;#2<span class="meta">+3 −2 &nbsp;✓&nbsp; ✗</span></div>
  <div class="trow mono fhead" style="padding-left:10px"><span style="color:var(--faint);font-size:10px;margin-right:6px">14:40:16</span><b>src/models/dataset.py</b><span class="meta">1 pending &nbsp;✓ file&nbsp; ✗ file</span></div>
  <div class="trow mono" style="padding-left:20px"><span class="dot" style="background:var(--pending)"></span>&nbsp;#3<span class="meta">+7 −0 &nbsp;✓&nbsp; ✗</span></div>
  <div class="trow mono" style="padding-left:10px;color:var(--faint)">2 cancelled-out chains — nothing to review<span class="meta">Dismiss</span></div>`;

// The inline lens row, verbatim from InlineLensProvider.provideCodeLenses: one lens per pending edit,
// shortened in 0.10.0 to `🔬 #N +A −R · n/m` (the Diff-axis position) plus the five verbs that fit a lens.
const lensRow = (id, add, rem, pos) =>
  `<div class="codelens"><a>${microscope} #${id}  +${add} −${rem}  ·  ${pos}</a><a>✓ Keep</a><a>✗ Undo</a><a>💬 Chat</a><a>⧉ Diff</a><a>⋯ Details</a></div>`;
// The compact review bar — `EditPeek` in `bar` mode: a comment thread with no comments, so the widget is
// one row. Its title is `✦ ` + the same label the bubble carries; its buttons are the `claudeNavBar` menu
// block, in group order (Keep · Undo · ↑↓ this file's edits · ←→ changed files · Diff · Details). The two
// stepper pairs are gated on `barMultiEdit` / `barMultiFile`, so a lone edit in the file hides ↑↓ — the bar
// floats over code, and a dead button there covers a line for nothing.
const reviewBar = (title, { steps = true, files = true } = {}) => `
  <div class="revbar">
    <span class="rb-t">✦ ${title}</span>
    <span class="rb-b">
      <span style="color:#3fb950">✓</span><span style="color:#e5534b">✗</span>
      ${steps ? `<span style="color:#4c8bf5">↑</span><span style="color:#4c8bf5">↓</span>` : ''}
      ${files ? `<span style="color:#4c8bf5">←</span><span style="color:#4c8bf5">→</span>` : ''}
      <span style="color:var(--accent)">⧉</span><span style="color:var(--accent)">⋯</span>
    </span>
  </div>`;

// features.py with its one pending edit (#1 +6 −1 — the demo's `scale()`), as the editor draws it: the
// lens row above the edit, the ✨ gutter star on its first line, every added/changed line tinted, and the
// review bar auto-shown under the anchor line. Line numbers and text are the demo workspace's own file.
const editorCode = () => `
  <div style="background:var(--bg);padding:10px 0 14px;">
    ${lensRow(1, 6, 1, '1/1')}
    <div class="codeline hl"><span class="ln">1</span><span class="gutstar">✦</span><span><span class="tok-k">from</span> <span class="tok-v">statistics</span> <span class="tok-k">import</span> <span class="tok-v">mean</span>, <span class="tok-v">stdev</span></span></div>
    ${reviewBar('Claude edit #1  ·  +6 −1  ·  Diff 1/1  ·  File 1/3', { steps: false })}
    <div class="codeline"><span class="ln">2</span><span></span></div>
    <div class="codeline"><span class="ln">3</span><span></span></div>
    <div class="codeline"><span class="ln">4</span><span><span class="tok-k">def</span> <span class="tok-f">summarize</span>(<span class="tok-v">values</span>):</span></div>
    <div class="codeline"><span class="ln">5</span><span>    <span class="tok-k">return</span> {<span class="tok-s">"count"</span>: <span class="tok-f">len</span>(values), <span class="tok-s">"mean"</span>: <span class="tok-f">mean</span>(values)}</span></div>
    <div class="codeline hl"><span class="ln">6</span><span></span></div>
    <div class="codeline hl"><span class="ln">7</span><span></span></div>
    <div class="codeline hl"><span class="ln">8</span><span><span class="tok-k">def</span> <span class="tok-f">scale</span>(<span class="tok-v">values</span>):</span></div>
    <div class="codeline hl"><span class="ln">9</span><span>    mu, sigma = <span class="tok-f">mean</span>(values), <span class="tok-f">stdev</span>(values)</span></div>
    <div class="codeline hl"><span class="ln">10</span><span>    <span class="tok-k">return</span> [(v - mu) / sigma <span class="tok-k">for</span> v <span class="tok-k">in</span> values]</span></div>
  </div>`;

// train.py's one pending edit (#2 +3 −2 — the demo wiring `scale()` into the entrypoint), the closeup for
// the inline-review figure. `locate` reports lines 1, 3 and 4 as this edit's changed lines and NO removed
// hunk (its two removed lines were replaced in place, not deleted), so every one of them is tinted green
// and there is no deletion ghost to draw here.
const editorCodeCombined = () => `
  <div style="background:var(--bg);padding:10px 0 14px;">
    ${lensRow(2, 3, 2, '1/1')}
    <div class="codeline hl"><span class="ln">1</span><span class="gutstar">✦</span><span><span class="tok-k">from</span> <span class="tok-v">features</span> <span class="tok-k">import</span> <span class="tok-v">summarize</span>, <span class="tok-v">scale</span></span></div>
    ${reviewBar('Claude edit #2  ·  +3 −2  ·  Diff 1/1  ·  File 3/3', { steps: false })}
    <div class="codeline"><span class="ln">2</span><span></span></div>
    <div class="codeline hl"><span class="ln">3</span><span>features = <span class="tok-f">scale</span>([<span class="tok-v">1.0</span>, <span class="tok-v">2.0</span>, <span class="tok-v">3.0</span>])</span></div>
    <div class="codeline hl"><span class="ln">4</span><span><span class="tok-f">print</span>(<span class="tok-f">summarize</span>(features))</span></div>
  </div>`;

// one diff line, for the diff tab (diffs.png) and the stacked view (stacked-diffs.png)
const dl = (kind, text) => `<span class="dl ${kind}">${text}</span>`;

// The Observations tab as VS Code's Timeline draws it (its rows are ObservationsProvider's tree items: a
// twistie column, the icon's glyph, the label, the description): the recap (◎), then the edits newest first.
// Adjacent same-file edits coalesce into a ×N run, which carries its review status and a plain tooltip in
// both editors, never an edit's ⚠ or file memory: those sit on single-edit rows, and on a run's own #id rows
// once it is expanded. VS Code gives a run its newest edit's reasoning.
const obsTw = (glyph = '') => `<span style="flex:none;width:9px;color:var(--faint);font-size:9px">${glyph}</span>`;
const observationsCol = `
  <div class="obsrow">${obsTw()}<span style="color:var(--blue);flex:none">◎</span><span class="id">Pipeline: scaling, validation, tests</span><span class="r" style="flex:none">session recap</span></div>
  <div class="obsrow">${obsTw('▸')}<span class="dot" style="background:var(--pending);flex:none"></span><span class="id mono" style="flex:none">14:03  train.py  ×2</span><span class="r">+5 −2 · Scaling the features in the training entrypoint before they reach the model.</span></div>
  <div class="obsrow">${obsTw()}<span style="color:var(--pending);flex:none">⚠</span><span class="id mono" style="flex:none">14:02  features.py</span><span class="r">+6 −1 · Adding scale() — z-score standardization so features share a range before training.</span></div>`;

const stepPlot = (name, legend, paths, yticks, H) => `
  <div class="plothead"><span class="pname">${name}</span><div class="legend">${legend}</div></div>
  <div class="plotbody">
    ${yticks.map(([label, y]) => `<span class="yt" style="top:${y + 6}px">${label}</span>`).join('')}
    <svg width="100%" height="${H}" viewBox="0 0 100 ${H}" preserveAspectRatio="none" style="display:block">
      <line x1="0" y1="${H - 0.5}" x2="100" y2="${H - 0.5}" stroke="#3c3c3c" stroke-width="1" vector-effect="non-scaling-stroke"/>
      ${paths}
    </svg>
  </div>
  <div class="pax"><span>7/1</span><span>7/2</span><span>7/3</span><span>7/4</span><span>7/5</span><span>7/6</span><span>7/7</span></div>`;

const step = (pts, color, H) => {
  // pts: value 0..1 per bucket → step-after path
  const n = pts.length;
  let d = '';
  pts.forEach((v, i) => {
    const y = (H - 3) * (1 - v) + 1.5;
    const x0 = (i * 100) / n, x1 = ((i + 1) * 100) / n;
    d += `${i ? 'L' : 'M'}${x0},${y}L${x1},${y}`;
  });
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`;
};

// Live review scoreboard: pending / accepted / reverted counts + a progress bar (reviewed / total).
const reviewBoard = `
  <div class="scoreboard">
    <div class="sc"><div class="scn" style="color:var(--pending)">3</div><div class="scl">pending</div></div>
    <div class="sc"><div class="scn" style="color:var(--kept)">42</div><div class="scl">accepted</div></div>
    <div class="sc"><div class="scn" style="color:var(--reverted)">5</div><div class="scl">reverted</div></div>
  </div>
  <div class="track" style="margin:0 16px"><span class="fill" style="width:94%;background:var(--blue)"></span></div>
  <div class="scmeta"><span>47 of 50 reviewed (94%)</span><span>89% accepted</span></div>`;

const statsCol = (H1 = 52, H2 = 52) => `
  ${reviewBoard}
  <div style="border-top:1px solid var(--border);margin:10px 16px 6px"></div>
  <div class="seg"><div>Today</div><div class="on">7 days</div><div>30 days</div></div>
  ${stepPlot('TOKENS',
    `<span><i style="background:var(--blue)"></i>total</span><span><i style="background:var(--purple)"></i>input</span><span><i style="background:var(--orange)"></i>output</span>`,
    step([0.55, 0.7, 0.6, 0.75, 0.65, 0.97, 0.9], 'var(--blue)', H2) +
    step([0.53, 0.68, 0.58, 0.73, 0.63, 0.95, 0.88], 'var(--purple)', H2) +
    step([0.2, 0.3, 0.25, 0.35, 0.3, 0.5, 0.45], 'var(--orange)', H2),
    [['1B', 4], ['1M', H2 * 0.45], ['1k', H2 * 0.85]], H2)}
  <div style="border-top:1px solid var(--border);margin:4px 16px 0"></div>
  <div class="uhead uusage">USAGE<span class="ulast">updated 14:43<span class="uref">↻</span></span></div>
  <div class="urow"><span class="lbl">ctx</span><span class="track"><span class="fill" style="width:39%;background:var(--kept)"></span></span><span class="pct" style="color:var(--kept)">39%</span><span class="sub">390k/1M</span></div>
  <div class="urow"><span class="lbl">5h</span><span class="track"><span class="fill" style="width:11%;background:var(--kept)"></span></span><span class="pct" style="color:var(--kept)">11%</span><span class="sub">1h30m · ~10M</span></div>
  <div class="urow"><span class="lbl">fable</span><span class="track"><span class="fill" style="width:22%;background:var(--kept)"></span></span><span class="pct" style="color:var(--kept)">22%</span><span class="sub">resets Mon</span></div>
  <div class="urow"><span class="lbl">wk</span><span class="track"><span class="fill" style="width:35%;background:var(--kept)"></span></span><span class="pct" style="color:var(--kept)">35%</span><span class="sub">1d2h · ~37M</span></div>
  <div class="urow"><span class="lbl">mo</span><span class="track"><span class="fill" style="width:48%;background:var(--kept)"></span></span><span class="pct" style="color:var(--kept)">48%</span><span class="sub">~240M · 12d</span></div>
  <div class="urow"><span class="lbl">$</span><span class="track"><span class="fill" style="width:45%;background:var(--kept)"></span></span><span class="pct" style="color:var(--kept)">45%</span><span class="sub">~$18 / ~$40</span></div>`;

// Actions — the Timeline's Actions tab: collapsed category groups (Subagents are the Overview's Workers),
// each counting its failed calls, then the two audits in the order the CLI reports them — the writes that
// landed outside the workspace (Risk's other half), then Egress. Live conflicts, when any, lead the list.
const actionsCol = `
  <div class="obsrow"><span>▸</span><span class="id">Edits</span><span class="r">185</span></div>
  <div class="obsrow"><span>▸</span><span class="id">Commands</span><span class="r">229 · <span style="color:var(--pending)">2 err</span></span></div>
  <div class="obsrow"><span>▸</span><span class="id">Reads</span><span class="r">142</span></div>
  <div class="obsrow"><span>▸</span><span class="id">Searches</span><span class="r">57</span></div>
  <div class="obsrow"><span>▸</span><span class="id">To-dos</span><span class="r">30</span></div>
  <div class="obsrow"><span style="color:var(--orange)">▸</span><span class="id">Outside the workspace</span><span class="r">1 file · 1 edit</span></div>
  <div class="obsrow"><span>▸</span><span class="id">Egress</span><span class="r">3</span></div>`;

// Change Map — two labeled sections (Folders strip · Files ledger) + a bottom summary
const cmCap = (label) => `<div style="font-size:9px;letter-spacing:.6px;text-transform:uppercase;color:var(--faint);margin:0 0 3px 1px">${label}</div>`;
// Mirrors renderSummary in the extension. Two shapes, and they differ in more than the name:
//   prompt-scoped:  #<index> · N pending · N accepted [· N reverted] · N EDITS · N files · N folders
//   folder/none:    [folder] · N pending · N accepted [· N reverted] · N files · N folders
// The prompt-scoped form names the ask by its INDEX only — the ask's text lives in the element's
// title attribute, because the scope bar above already spells it out. This mockup used to inline the
// full prompt text AND omit the mandatory edits term, so layout.png (the README's lead image)
// advertised a summary line the product cannot produce.
const cmSummary = (name, pending, accepted, edits, files, folders) => `
  <div style="border-top:1px solid var(--border);margin-top:8px;padding-top:6px;font-family:'SF Mono',Menlo,monospace;font-size:10.5px;color:var(--dim)">
${name ? `<b style="color:var(--accent)">${name}</b> · ` : ''}<b style="color:var(--pending)">${pending}</b> pending · <b style="color:var(--kept)">${accepted}</b> accepted${edits == null ? '' : ` · <b style="color:var(--ink)">${edits}</b> edits`} · <b style="color:var(--ink)">${files}</b> files · <b style="color:var(--ink)">${folders}</b> folders</div>`;
const cmSeg = (color, name) => `<span style="flex:1;min-width:0;background:${color};box-shadow:inset 1px 0 0 var(--panel);display:flex;align-items:center;justify-content:center;font-size:9px;color:rgba(0,0,0,.78);font-weight:600;overflow:hidden">${name}</span>`;
// No churn bar — the name takes the width; ⧉ is the row's stacked opener.
const cmRow = (color, file, mod, _barPct, num, pend, age = '') => `
  <div style="display:flex;align-items:center;gap:8px;font-size:11.5px;padding:2.5px 0">
    <span class="mono" style="font-size:9.5px;color:var(--faint);width:46px;text-align:right;flex:none;white-space:nowrap">${age}</span>
    <span style="width:6px;height:6px;border-radius:2px;background:${color};flex:none"></span>
    <span class="mono" style="color:var(--ink);flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:60px">${file}</span>
    <span style="font-size:9px;color:var(--faint);flex:none">${mod}</span>
    <span class="mono" style="font-size:10px;color:var(--faint);width:40px;text-align:right;flex:none">${num}</span>
    <span class="mono" style="font-size:10px;width:26px;text-align:right;flex:none;color:${pend ? 'var(--pending)' : 'var(--kept)'}">${pend || '✓'}</span>
    <span style="font-size:10px;color:var(--blue);flex:none">⧉</span>
  </div>`;

// The terminal front-end, quoted from a real `oak demo --fast` session: status → one file's list → a
// surgical undo that leaves the rest of the file alone.
const terminalBody = () => `
  <div class="term">
    <div class="cmd"><span class="pr">$</span>oak <span class="fl">status</span></div>
    <div class="out">capture hooks:   <span class="ok">installed</span></div>
    <div class="out">hook script:     oak (on PATH) <span class="ok">[ok]</span></div>
    <div class="out">oak server:      not running — starts with oak tui</div>
    <div class="out">codex hooks:     not installed (\`oak init --codex\` to capture codex sessions)</div>
    <div class="out">active session:  <span class="id2">demo-e60c9894</span></div>
    <div class="out">store:           /tmp/obs-demo/home/.claude/claude-observatory/demo-e60c9894</div>
    <div class="out">last capture:    13:21:40</div>
    <div class="out">edits:           9  (<span class="warn">9 pending</span> · 0 kept · 0 undone)</div>
    <div class="cmd"><span class="pr">$</span>oak <span class="fl">list --file features</span></div>
    <div class="out">2 edit(s)  ·  <span class="warn">2 pending</span>  ·  session <span class="id2">demo-e60c9894</span></div>
    <div class="out">&nbsp;</div>
    <div class="out"><span class="file2">observatory-demo/src/features.py</span></div>
    <div class="out">  <span class="id2">#3</span>  <span class="warn">pending</span>  <span class="add2">+8</span> <span class="rem2">-1</span>  Edit  13:21:40</div>
    <div class="out">  <span class="id2">#8</span>  <span class="warn">pending</span>  <span class="add2">+8</span> <span class="rem2">-0</span>  Edit  13:21:40</div>
    <div class="out">&nbsp;</div>
    <div class="out">diff &lt;id&gt; · keep &lt;id&gt; · undo &lt;id&gt;</div>
    <div class="cmd"><span class="pr">$</span>oak <span class="fl">undo 8</span></div>
    <div class="out"><span class="ok">✓</span> undid edit #8 (/tmp/obs-demo/ws/observatory-demo/src/features.py)</div>
    <div class="cmd"><span class="pr">$</span><span class="cursor">&nbsp;</span></div>
  </div>`;

// A surgical undo that would strand a later edit refuses, and --force falls back to the whole file
// (quoted from the same demo session).
const conflictBody = () => `
  <div class="term">
    <div class="cmd"><span class="pr">$</span>oak <span class="fl">undo --ids 1</span></div>
    <div class="out"><span class="warn">⚠</span> reverted 0 edit(s) in 1 selected edit(s) · <span class="warn">1 conflict(s) left</span> (undo individually with --force)</div>
    <div class="out">  ↳ edit #1 overlaps a later change to features.py. Run \`oak undo 1 --force\` to restore the file to its pre-edit-#1 state, which drops later edits #3, #8 and anything else changed in the file since.</div>
    <div class="cmd"><span class="pr">$</span>oak <span class="fl">undo 1 --force</span></div>
    <div class="out"><span class="ok">✓</span> restored /tmp/obs-demo/ws/observatory-demo/src/features.py to its pre-edit-#1 state (later edits to this file dropped)</div>
    <div class="cmd"><span class="pr">$</span><span class="cursor">&nbsp;</span></div>
  </div>`;

// a single edit opened as its own full diff tab (a row click in Review opens exactly this), git
// colors, title-bar Prev/Next
const diffTabBody = () => `
  <div class="difftab">
    <div class="tab">train.py  ⟷  Claude #2</div>
    <div class="acts"><span>⧉ #2 +3 −2</span><span>✓ Keep</span><span>✗ Undo</span><span>${icoChat} Chat</span><span>↑ Prev</span><span>↓ Next</span></div>
  </div>
  <div class="bb-diff" style="background:var(--bg);padding:12px 0;font-size:12.5px;line-height:1.85;">
    ${dl('hunk', '@@ -1,3 +1,4 @@')}
    ${dl('rem', '-from features import summarize')}
    ${dl('add', '+from features import summarize, scale')}
    ${dl('ctx', ' ')}
    ${dl('rem', '-print(summarize([1.0, 2.0, 3.0]))')}
    ${dl('add', '+features = scale([1.0, 2.0, 3.0])')}
    ${dl('add', '+print(summarize(features))')}
  </div>`;

// "Open all in editor" — the pending work as ONE concatenated view, each edit's diff stacked one below
// the next, each with its own Keep/Undo (the per-block Chat was dropped in 0.10.0 — chat stays on the
// inline lens, the review bar, the bubble, and JetBrains' viewer toolbars). One block per pending unit; a header
// naming the file, its edit number and churn, then that unit's net diff. This is the review surface's
// stacked-diff view, distinct from the single-edit diff tab above.
const stackDiff = (file, id, add, rem, lines) => `
  <div style="border-top:1px solid var(--border)">
    <div style="display:flex;align-items:center;gap:10px;background:var(--side);padding:6px 16px;font-size:12.5px;font-family:'SF Mono',Menlo,monospace">
      <span style="color:var(--dim)">#${id}</span>
      <b style="color:var(--ink)">${file}</b>
      <span style="color:var(--dim)">+${add} −${rem}</span>
      <span style="margin-left:auto;display:flex;gap:6px;font-family:-apple-system,'Segoe UI',sans-serif">
        <span class="stk-bt keep">✓ Keep</span><span class="stk-bt undo">✗ Undo</span>
      </span>
    </div>
    <div class="bb-diff stk" style="background:var(--bg);padding:11px 0;font-size:12.5px;line-height:1.8;">${lines}</div>
  </div>`;

// Python token colours for the stacked mock. The product tokenizes each line with the editor's own
// TextMate grammar and theme (tmLineHtml), so the bands keep the theme's syntax colours; this
// approximates Dark Modern for the mock's few Python lines.
const pyTok = (code) => code.replace(
  /(f?"[^"]*")|\b(\d+(?:\.\d+)?)\b|\b(from|import|def|return|for|in|if|raise)\b|\b([A-Za-z_]\w*)(?=\()/g,
  (m, s, n, k, fn) => s ? `<span class="tok-s">${s}</span>` : n ? `<span class="tok-v">${n}</span>`
    : k ? `<span class="tok-k">${k}</span>` : `<span class="tok-f">${fn}</span>`);
// One stacked-view line: the ± marker stays plain, the code after it is tokenized; hunk headers are not.
const sdl = (kind, text) => dl(kind, kind === 'hunk' ? text : text[0] + pyTok(text.slice(1)));

const stackedDiffsBody = () => `
  <div class="window">
    <div class="difftab">
      <div class="tab">session — 3 change(s) · stacked</div>
    </div>
    <div class="stk-bar"><span class="ttl">stacked — removed/added inline</span><span class="stk-bt on">Spotlight</span><span class="stk-bt">Side by side</span></div>
    ${stackDiff('src/features.py', 1, 6, 1, [
      sdl('hunk', '@@ -1,4 +1,10 @@'),
      sdl('ctx', ' from statistics import mean, stdev'),
      sdl('add', '+'),
      sdl('add', '+def scale(values):'),
      sdl('add', '+    mu, sigma = mean(values), stdev(values)'),
      sdl('add', '+    return [(v - mu) / sigma for v in values]'),
      sdl('add', '+'),
      sdl('ctx', ' def summarize(values):'),
      sdl('rem', '-    return {"count": len(values), "mean": mean(values)}'),
      sdl('add', '+    return {"count": len(values), "mean": mean(values), "stdev": stdev(values)}'),
    ].join(''))}
    ${stackDiff('src/train.py', 2, 3, 2, [
      sdl('hunk', '@@ -1,3 +1,4 @@'),
      sdl('rem', '-from features import summarize'),
      sdl('add', '+from features import summarize, scale'),
      sdl('ctx', ' '),
      sdl('rem', '-print(summarize([1.0, 2.0, 3.0]))'),
      sdl('add', '+features = scale([1.0, 2.0, 3.0])'),
      sdl('add', '+print(summarize(features))'),
    ].join(''))}
    ${stackDiff('src/models/dataset.py', 3, 7, 0, [
      sdl('hunk', '@@ -12,0 +13,7 @@'),
      sdl('add', '+    def validate(self):'),
      sdl('add', '+        n = len(self.features)'),
      sdl('add', '+        if len(self.labels) != n:'),
      sdl('add', '+            raise ValueError('),
      sdl('add', '+                f"features/labels mismatch: {n} vs {len(self.labels)}"'),
      sdl('add', '+            )'),
      sdl('add', '+        return n'),
    ].join(''))}
  </div>`;

// file spotlight — unmodified lines dimmed so the edit is a spotlight (the Spotlight toggle)
const spotlightEditor = () => `
  <div style="background:var(--bg);padding:10px 0 14px;">
    ${lensRow(1, 6, 1, '1/1')}
    <div class="codeline hl"><span class="ln">1</span><span class="gutstar">✦</span><span><span class="tok-k">from</span> <span class="tok-v">statistics</span> <span class="tok-k">import</span> <span class="tok-v">mean</span>, <span class="tok-v">stdev</span></span></div>
    <div class="codeline dim"><span class="ln">2</span><span></span></div>
    <div class="codeline dim"><span class="ln">3</span><span></span></div>
    <div class="codeline dim"><span class="ln">4</span><span><span class="tok-k">def</span> <span class="tok-f">summarize</span>(<span class="tok-v">values</span>):</span></div>
    <div class="codeline dim"><span class="ln">5</span><span>    <span class="tok-k">return</span> {<span class="tok-s">"count"</span>: <span class="tok-f">len</span>(values), <span class="tok-s">"mean"</span>: <span class="tok-f">mean</span>(values)}</span></div>
    <div class="codeline hl"><span class="ln">6</span><span></span></div>
    <div class="codeline hl"><span class="ln">7</span><span></span></div>
    <div class="codeline hl"><span class="ln">8</span><span><span class="tok-k">def</span> <span class="tok-f">scale</span>(<span class="tok-v">values</span>):</span></div>
    <div class="codeline hl"><span class="ln">9</span><span>    mu, sigma = <span class="tok-f">mean</span>(values), <span class="tok-f">stdev</span>(values)</span></div>
    <div class="codeline hl"><span class="ln">10</span><span>    <span class="tok-k">return</span> [(v - mu) / sigma <span class="tok-k">for</span> v <span class="tok-k">in</span> values]</span></div>
  </div>`;

// File History — a flat, chronological list of just the active file's edits (follows the editor)
const fileHistoryCol = `
  <div class="obsrow"><span class="dot" style="background:var(--pending)"></span><span class="id mono">#1</span><span class="r">14:02 · +6 −1 · <span style="color:var(--pending)">pending</span> · added scale() — z-score standardization</span></div>`;

// A numbered legend row for the per-window diagrams below.
const note = (n, name, desc) => `<div style="display:flex;gap:9px;align-items:flex-start"><span style="flex:none;width:19px;height:19px;border-radius:50%;background:var(--coral);color:#fff;font-size:10.5px;font-weight:700;display:flex;align-items:center;justify-content:center">${n}</span><div style="font-size:12.5px;line-height:1.45"><b style="color:var(--ink)">${name}</b> <span style="color:var(--dim)">— ${desc}</span></div></div>`;
// A per-window diagram: the real panel mockup in a titled frame (left) + a numbered legend (right).
const winDiag = (title, mock, notes) => `
  <div style="display:grid;grid-template-columns:1.5fr 1fr;gap:26px;align-items:start;font-family:-apple-system,'Segoe UI',sans-serif;">
    <div style="border:1px solid var(--border2);border-radius:10px;overflow:hidden;background:var(--bg);box-shadow:0 12px 40px -18px rgba(0,0,0,.6);">
      <div style="background:var(--panel);border-bottom:1px solid var(--border);padding:8px 15px;font-size:10.5px;letter-spacing:.09em;color:var(--coral);font-weight:700;">${title}</div>
      <div style="padding:8px 0;">${mock}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:13px;padding-top:4px;">${notes}</div>
  </div>`;

// ---------- 0.8.0: multitasking + per-agent overview tabs ----------
// Phase badge — colored by agent state (working blue · awaiting orange · errored red · done green · idle grey).
const phase = (label, color) => `<span style="font-size:9px;font-weight:700;letter-spacing:.02em;padding:1.5px 7px;border-radius:9px;color:${color};border:1px solid ${color};white-space:nowrap;text-transform:uppercase">${label}</span>`;
// A tiny activity sparkline (bars), like the real per-agent one.
// Emoji-free mini icons — tiny inline SVGs approximating the real codicons the product uses
// (search / lightbulb / comment-discussion / clear-all / checklist / timeline-view-icon).
const ico = (d, size = 13) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px">${d}</svg>`;
const icoSearch = ico('<circle cx="6.8" cy="6.8" r="4.5"/><path d="M10.2 10.2L14 14"/>');
const icoBulb = ico('<path d="M6 12.5h4M6.7 14.5h2.6M8 1.8a4.4 4.4 0 0 0-2.6 7.9c.7.5 1.1 1.1 1.1 1.8v.5h3v-.5c0-.7.4-1.3 1.1-1.8A4.4 4.4 0 0 0 8 1.8z"/>');
const icoChat = ico('<path d="M1.5 3h8.5v5.5H6L4 10.5V8.5H1.5z"/><path d="M12 6h2.5v5.5H13V13l-2-1.5H8.5"/>');
const icoSplit = ico('<rect x="1.6" y="3" width="12.8" height="10" rx="1.2"/><path d="M8 3v10"/>');
const spark = (bars, color) => `<span style="display:inline-flex;align-items:flex-end;gap:1.5px;height:13px">${bars.map(h => `<span style="width:2.5px;height:${Math.max(2, Math.round(h * 13))}px;background:${color};border-radius:1px"></span>`).join('')}</span>`;
const gADD = '#7ee787', gREM = '#ffa198';

// ---------- 0.10.0: the Observatory Timeline panel ----------
// ONE webview (`claudeObservatory.timeline`), whose own chrome is drawn below in the order `timelineShell`
// builds it: the SESSION SELECTOR leads the window, then the tab strip — Feed · Prompts · Observations · Actions,
// each with its badge — with the GROUP TABS toggle beside the strip it rearranges, then the forward tab's
// heading, its description, and its list. Every count and every ask below is the bundled demo session's
// own (`demo --fast`, then `prompts --json` / `observations` / `actions`): 3 asks · 8 review units, 9 edit
// rows in Observations, and 39 tool calls in the Actions tree — the CLI's 41 less the `agent` category the
// tree filters out and the uncurated `read` group, which contributes only its failures and had none.
const tlTab = (name, badge, on) =>
  `<span style="display:inline-flex;align-items:center;gap:6px;flex:none;border:1px solid var(--border2);border-bottom:2px solid ${on ? 'var(--blue)' : 'transparent'};border-radius:5px 5px 0 0;padding:4px 11px;font-size:11px;white-space:nowrap;color:var(--${on ? 'ink' : 'dim'});${on ? 'background:rgba(80,120,200,0.18);' : ''}">${name}${badge ? `<span class="mono" style="font-size:9px;opacity:.72">${badge}</span>` : ''}</span>`;
// One ask, as `renderPrompts` writes it: the facts line (± lines · edits/files/folders/pending · tokens ·
// what it produced · failures · compactions · how long), the response caret, then the ask itself WRAPPED.
const tlPromptRow = (ix, live, delta, edits, meta, dur, ask) => `
  <div style="border:1px solid var(--border2);border-radius:5px;margin-bottom:5px;padding:5px 8px">
    <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">
      <span class="mono" style="font-size:10px;color:var(--ink);flex:none">#${ix}</span>
      ${live ? `<span style="font-size:8.5px;font-weight:600;color:#fff;background:var(--blue);border-radius:99px;padding:0 6px;flex:none">now</span>` : ''}
      <span class="mono" style="font-size:9.5px;flex:none"><span style="color:${gADD}">${delta.split(' ')[0]}</span> <span style="color:${gREM}">${delta.split(' ')[1]}</span></span>
      <span class="mono" style="font-size:9px;color:var(--faint);flex:none">${edits}</span>
      <span class="mono" style="font-size:9px;color:var(--faint);flex:none">${meta}</span>
      <span class="mono" style="font-size:9px;color:var(--faint);flex:none">${dur}</span>
      <span style="margin-left:auto;flex:none;font-size:9px;border:1px solid var(--border2);border-radius:99px;padding:0 7px;color:var(--faint)">▸ response</span>
    </div>
    <div style="font-size:11.5px;line-height:1.4;color:var(--ink);margin-top:3px">${ask}</div>
  </div>`;
const timelinePanel = `
  <div style="padding:10px 14px 6px;font-size:11px;color:var(--dim);letter-spacing:.06em;">OBSERVATORY TIMELINE</div>
  <div style="padding:0 9px 5px;border-bottom:1px solid var(--border)">
    <div style="display:flex;align-items:center;gap:6px;border:1px solid var(--border2);border-radius:5px;padding:3px 8px;font-size:11px">
      <span style="color:var(--kept);font-size:10px;flex:none">●</span>
      <span style="flex:1;min-width:0;color:var(--ink)">Pipeline: scaling, validation, tests</span>
      <span style="color:var(--faint);font-size:9px;flex:none">▾</span>
    </div>
  </div>
  <div style="display:flex;align-items:flex-start;gap:6px;padding:5px 9px 0">
    <div style="display:flex;flex:1 1 auto;flex-wrap:wrap;gap:4px;min-width:0">
      ${tlTab('Feed', 0, false)}${tlTab('Prompts', 3, true)}${tlTab('Observations', 9, false)}${tlTab('Actions', 39, false)}
    </div>
    <span style="flex:none;display:inline-flex;align-items:center;gap:5px;border:1px solid var(--border2);border-radius:5px;padding:3px 9px;font-size:11px;color:var(--dim);white-space:nowrap"><span style="opacity:.3">${icoSplit}</span> Group tabs</span>
  </div>
  <div style="border-top:1px solid var(--border);padding:6px 9px 5px;display:flex;align-items:baseline;gap:8px">
    <span style="font-size:9px;letter-spacing:.6px;text-transform:uppercase;color:var(--dim)">Prompts</span>
    <span class="mono" style="font-size:10px;color:var(--faint)">3 asks · 3 with edits · 8 edits</span>
  </div>
  <div style="font-size:10px;line-height:1.45;color:var(--faint);padding:0 9px 6px;border-bottom:1px solid var(--border)">What you asked for, in order. Select one to scope the Overview beside it — its fleet, runs, tasks, shells and change map narrow to the work that ask caused.</div>
  <div style="padding:6px 9px 10px">
    ${tlPromptRow(3, true, '+17 −0', '2 edits · 2f · 2fo · 2⧗', '1k tok · 2 tasks', '~4m', 'Profile it and leave me the report somewhere outside the tree.')}
    ${tlPromptRow(2, false, '+24 −7', '3 edits · 3f · 3fo · 3⧗', '1k tok · 1 subagent · 1 workflow run · 3 tasks', '12m', 'Now the tests and the usage docs, and drop the legacy scaler.')}
    ${tlPromptRow(1, false, '+18 −3', '3 edits · 3f · 2fo · 3⧗', '7k tok · 2 tasks · <span style="color:#e5534b">✗ 1</span> · ⤺1', '18m', 'Add feature scaling and dataset validation to the training pipeline.')}
  </div>`;
// A compact fleet row for the Overview's LEFT master rail: phase dot · worktree ⑂branch · sparkline.
const cmFleetRow = (dot, name, branch, bars, sel) => `
  <div style="display:flex;align-items:center;gap:7px;font-size:11px;padding:3px 0${sel ? ';box-shadow:inset 2px 0 0 var(--accent);background:var(--hl)' : ''}">
    <span class="dot" style="background:${dot};flex:none"></span>
    <span class="mono" style="color:${sel ? 'var(--ink)' : 'var(--dim)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto">${name} <span style="color:var(--faint)">⑂${branch}</span></span>
    <span style="margin-left:auto;flex:none">${spark(bars, dot)}</span>
  </div>`;
// Overview (formerly Change Map) — now MASTER-DETAIL: a thin left rail (Fleet · Workflows tabs + a few
// agent rows) feeds the right change-map detail (Folders strip + churn-ranked file ledger).
const changeMapCol = `
  <div style="display:flex;align-items:stretch">
    <div style="flex:0 0 36%;min-width:0;padding:2px 12px 8px 16px;border-right:1px solid var(--border)">
      <div style="display:flex;gap:11px;font-size:9.5px;letter-spacing:.04em;margin-bottom:6px">
        <span style="color:var(--faint)">Sessions 4</span>
        <span style="color:var(--ink);border-bottom:1.5px solid var(--accent);padding-bottom:3px">Workers 3</span>
        <span style="color:var(--faint)">Workflows 1</span>
        <span style="color:var(--faint)">Tasks 3</span>
        <span style="color:var(--faint)">Processes <span style="color:var(--kept)">1/2</span></span>
      </div>
      ${cmFleetRow('var(--blue)', 'demo', 'demo/pipeline', [.3, .6, .4, .8, .5, .9, .7, 1], true)}
      ${cmFleetRow('var(--pending)', 'demo', 'feat-x', [.5, .7, .3, .6, .8, .4, .6, .5], false)}
      ${cmFleetRow('var(--kept)', 'demo', 'hotfix', [.4, .8, .6, .3, .7, .5, .2, .4], false)}
    </div>
    <div style="flex:1;min-width:0;padding:2px 16px 8px 14px">
      ${cmCap('Folders')}
      <div style="display:flex;height:16px;border-radius:3px;overflow:hidden;margin-bottom:9px">
        ${cmSeg('var(--kept)', 'src/models')}${cmSeg('var(--pending)', 'src')}${cmSeg('var(--pending)', 'tests')}${cmSeg('var(--kept)', 'docs')}
      </div>
      ${cmCap('Files')}
      ${cmRow('var(--kept)', 'USAGE.md', 'docs', 100, '+12', '', '14:42:07')}
      ${cmRow('var(--pending)', 'test_pipeline.py', 'tests', 96, '+12', '1⧗', '14:41:12')}
      ${cmRow('var(--kept)', 'dataset.py', 'src/models', 58, '+7', '', '14:38:55')}
      ${cmRow('var(--pending)', 'features.py', 'src', 55, '+6', '1⧗', '14:36:20')}
      ${cmSummary('#1', 2, 3, 5, 4, 3)}
    </div>
  </div>`;
// One agent (worktree) row: badge · worktree ⑂branch · self tag · sparkline · ± · ⚠risk · ⇄collisions.
const agentRow = (badge, name, branch, self, bars, sparkColor, added, removed, risk, coll) => `
  <div style="display:flex;align-items:center;gap:9px;padding:7px 16px;font-size:12.5px">
    ${badge}
    <span class="mono" style="color:var(--ink)">${name}</span>
    <span class="mono" style="color:var(--dim);font-size:11.5px">⑂${branch}</span>
    ${self ? `<span style="font-size:8.5px;font-weight:700;color:var(--coral);border:1px solid var(--coral);border-radius:8px;padding:0 6px">self</span>` : ''}
    <span style="margin-left:auto;display:flex;align-items:center;gap:13px">
      ${spark(bars, sparkColor)}
      <span class="mono" style="font-size:11px;white-space:nowrap"><span style="color:${gADD}">+${added}</span> <span style="color:${gREM}">−${removed}</span></span>
      ${risk != null ? `<span style="font-size:11px;color:var(--pending);white-space:nowrap">⚠ ${risk}</span>` : ''}
      ${coll != null ? `<span style="font-size:11px;color:var(--dim);white-space:nowrap">⇄ ${coll}</span>` : ''}
    </span>
  </div>`;
// A nested subagent row under an agent: badge · agentType + italic description · current task · ± · chat.
const subRow = (badge, type, desc, task, added, removed) => `
  <div style="display:flex;align-items:center;gap:8px;padding:4px 16px 4px 42px;font-size:11.5px">
    <span style="color:var(--faint)">└</span>
    ${badge}
    <span style="color:var(--purple);white-space:nowrap">${type}</span>
    <span style="color:var(--faint);font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto">${desc}</span>
    <span style="color:var(--dim);font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto">${task}</span>
    <span style="margin-left:auto;display:flex;align-items:center;gap:11px;white-space:nowrap">
      <span class="mono" style="font-size:10.5px"><span style="color:${gADD}">+${added}</span> <span style="color:${gREM}">−${removed}</span></span>
      <span style="color:var(--purple)">${icoChat}</span>
    </span>
  </div>`;
// One row of the Prompts window (0.8.7): the facts the ask produced on one line, then the ask itself
// WRAPPED — never clipped, because a truncated prompt is unrecognisable and the text is the row's whole
// identity. `sel` outlines the ask the Overview beside it is currently scoped to.
const promptRow = (ix, live, delta, edits, ask, extra, dur, sel, resp) => `
  <div style="border:1px solid var(--${sel ? 'accent' : 'border2'});border-radius:6px;margin:7px 16px;padding:7px 10px${sel ? ';background:var(--side)' : ''}">
    <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:11px">
      <span class="mono" style="color:var(--ink);flex:none">#${ix}</span>
      ${live ? `<span style="font-size:8.5px;font-weight:700;color:#fff;background:var(--blue);border-radius:99px;padding:0 6px;flex:none">${live}</span>` : ''}
      ${delta ? `<span class="mono" style="font-size:10px;flex:none"><span style="color:${gADD}">${delta.split(' ')[0]}</span> <span style="color:${gREM}">${delta.split(' ')[1]}</span></span>` : ''}
      ${edits ? `<span class="mono" style="font-size:9.5px;color:var(--faint);flex:none">${edits}</span>` : ''}
      ${!delta && !edits ? `<span style="font-size:10px;color:var(--faint);font-style:italic;flex:none">${extra}</span>` : (extra ? `<span class="mono" style="font-size:9.5px;color:var(--faint);flex:none">${extra}</span>` : '')}
      <span style="margin-left:auto;flex:none;font-size:9px;border:1px solid var(--${resp ? 'accent' : 'border2'});border-radius:99px;padding:0 8px;color:var(--${resp ? 'accent' : 'faint'})">${resp ? '▾' : '▸'} response</span>
      <span class="mono" style="flex:none;font-size:9.5px;color:var(--faint)">${dur}</span>
    </div>
    <div style="font-size:11.5px;line-height:1.45;color:var(--ink);margin-top:4px">${ask}</div>
    ${resp ? `<div style="margin-top:6px;border-top:1px dashed var(--border2);padding-top:6px">
      <div style="font-size:8px;letter-spacing:.6px;text-transform:uppercase;color:var(--faint);margin-bottom:4px">Claude's response · 4 turns</div>
      <div style="font-size:10.5px;line-height:1.5;color:var(--dim)">${resp}</div></div>` : ''}
  </div>`;

// One FEED entry — exactly what core.FeedEntry carries: a timestamp, the call as its label, its target
// as detail, and an error marker when the call reported one. No result column: the feed has no such field.
// Each entry is a BORDERED BLOCK with air between blocks (the TUI's boxed blobs), and an edit's inline
// diff reads as background BANDS, not text colour.
const feedRow = (ts, tool, target, failed, diff = []) => `
  <div style="margin:5px 12px;padding:3px 8px;border:1px solid var(--border);border-left:2px solid ${failed ? 'var(--pending)' : 'var(--border)'};border-radius:4px">
    <div style="display:flex;align-items:baseline;gap:9px;font-size:11.5px">
      <span class="mono" style="color:var(--faint);font-size:10px;flex:none">${ts}</span>
      ${tool === '$'
        ? `<span class="mono" style="color:var(--faint);flex:none">$</span><span class="mono" style="color:var(--blue);font-weight:600;flex:none">${target.split(' ')[0]}</span><span class="mono" style="color:var(--dim);min-width:0;overflow:hidden;white-space:nowrap">${target.split(' ').slice(1).join(' ')}</span>`
        : `<span style="color:var(--ink);flex:none">${tool}</span><span class="mono" style="color:var(--dim);min-width:0;overflow:hidden;white-space:nowrap">${target}</span>`}
      ${failed ? `<span style="margin-left:auto;color:var(--pending);font-size:10px;flex:none">✕ error</span>` : ''}
    </div>
    ${diff.map((l) => `<div class="mono" style="font-size:10px;white-space:pre;padding:0 6px;margin:0 -8px;background:${l.startsWith('+') ? 'rgba(46,160,67,.16)' : l.startsWith('-') ? 'rgba(229,83,75,.16)' : 'transparent'};color:${l.startsWith('@') ? 'var(--faint)' : 'var(--dim)'}">${l}</div>`).join('')}
  </div>`;

// The user's own ask — a grey band (the way the agent CLI paints user turns), the feed's prompt row.
const promptBand = (ts, ix, ask) => `
  <div style="margin:5px 12px;padding:4px 8px;border:1px solid var(--border);border-left:2px solid var(--faint);border-radius:4px;background:rgba(127,127,127,.14)">
    <div style="display:flex;align-items:baseline;gap:9px;font-size:11.5px">
      <span class="mono" style="color:var(--faint);font-size:10px;flex:none">${ts}</span>
      <span style="color:var(--blue);flex:none">you</span><span class="mono" style="color:var(--faint);font-size:10px">${ix}</span>
    </div>
    <div class="mono" style="font-size:11px;color:var(--ink);padding:2px 0 1px 2px">${ask}</div>
  </div>`;
// The agent's own words as a row (2026-09-23): a reply open as prose; its thinking folded to one line.
const saidRow = (ts, verb, words, folded) => `
  <div style="margin:5px 12px;padding:3px 8px;border:1px solid var(--border);border-left:2px solid ${verb === 'said' ? 'var(--purple)' : 'var(--border)'};border-radius:4px">
    <div style="display:flex;align-items:baseline;gap:9px;font-size:11.5px">
      <span style="color:var(--faint);font-size:9px;flex:none">${folded ? '▸' : '▾'}</span>
      <span class="mono" style="color:var(--faint);font-size:10px;flex:none">${ts}</span>
      <span class="mono" style="color:var(--purple);flex:none">${verb}</span>
      ${folded ? `<span style="color:var(--faint);font-size:10.5px;min-width:0;overflow-wrap:anywhere">· ${words.trim().split(/\s+/).length} words</span>` : ''}
    </div>
    ${folded ? '' : `<div style="font-size:11.5px;line-height:1.5;color:var(--ink);padding:2px 0 1px 18px">${words}</div>`}
  </div>`;

// One PROCESSES row: state · shell id · its description · runtime and output volume.
const procRow = (state, color, id, desc, meta) => `
  <div style="display:flex;align-items:baseline;gap:9px;padding:4px 16px;font-size:11.5px">
    <span style="color:${color};flex:none;font-size:10px;width:52px">${state}</span>
    <span class="mono" style="color:var(--ink);flex:none">${id}</span>
    <span style="color:var(--dim);min-width:0;overflow:hidden;white-space:nowrap">${desc}</span>
    <span class="mono" style="margin-left:auto;color:var(--faint);font-size:10px;flex:none">${meta}</span>
  </div>`;

// The Overview's Fleet tab — every agent (worktree) in this project, its subagents, and the collisions
// strip (0.8.0: folded in from the old Multitasking window; header is now the Fleet · Workflows nav).
const multitaskingBody = `
  <div style="display:flex;align-items:center;gap:14px;padding:9px 16px 0;border-bottom:1px solid var(--border);font-size:12px">
    <span style="color:var(--faint);padding-bottom:8px">Sessions 4</span>
    <span style="color:var(--ink);border-bottom:1.5px solid var(--accent);padding-bottom:8px">Workers 3</span>
    <span style="color:var(--faint);padding-bottom:8px">Workflows 1</span>
    <span style="color:var(--faint);padding-bottom:8px">Tasks 3</span>
    <span style="color:var(--faint);padding-bottom:8px;white-space:nowrap">Processes <span style="color:var(--kept)">1/2</span></span>
    <span style="margin-left:auto;display:flex;gap:14px;color:var(--faint);font-size:11px;padding-bottom:8px"><span>☐ Active only</span><span>Clear completed</span></span>
  </div>
  ${agentRow(phase('working', 'var(--blue)'), 'demo', 'main', true, [.3, .6, .4, .8, .5, .9, .7, 1], 'var(--blue)', 15, 0, 1, 1)}
  ${subRow(phase('working', 'var(--blue)'), 'Explore', 'maps the models layer', 'reading src/models/*.py', 0, 0)}
  ${subRow(phase('done', 'var(--kept)'), 'Explore', 'audits the import graph', '12 files scanned', 0, 0)}
  ${agentRow(phase('awaiting', 'var(--pending)'), 'demo-feat-x', 'feat-x', false, [.5, .7, .3, .6, .8, .4, .6, .5], 'var(--pending)', 42, 7, 2, 1)}
  ${agentRow(phase('done', 'var(--kept)'), 'demo-hotfix', 'hotfix', false, [.4, .8, .6, .3, .7, .5, .2, .4], 'var(--kept)', 6, 0, null, null)}`;

// One Sessions-tab row, as the Overview draws it: ● live / ○ past · the session's title · the agent (when
// it is not Claude) and model chips · ± lines · what is left to review, edits, tokens and duration, then
// the store size, which opens the store folder · the effort chip · when it was last active · and the row's
// conversation, resolve (only with pending edits) and 🗑 delete buttons.
const sChip = (text, color, ink = color) => `<span class="mono" style="flex:none;font-size:9.5px;border:1px solid ${color};color:${ink};border-radius:3px;padding:0 4px;white-space:nowrap">${text}</span>`;
const sBtn = (text) => `<span style="flex:none;font-size:9.5px;border:1px solid var(--border2);border-radius:3px;padding:0 5px;color:var(--dim);white-space:nowrap">${text}</span>`;
const sessionRow = (live, title, agent, model, stats, store, effort, when, reviewing, pending) => `
  <div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;padding:5px 16px;font-size:12px${reviewing ? ';background:var(--side);box-shadow:inset 2px 0 0 var(--accent)' : ''}">
    <span style="color:var(--${live ? 'blue' : 'faint'});flex:none">${live ? '●' : '○'}</span>
    <span style="color:var(--${reviewing ? 'ink' : 'dim'});min-width:0;overflow-wrap:anywhere">${title}</span>
    ${agent ? sChip(agent, 'var(--pending)') : ''}${sChip(model, 'var(--pending)')}
    <span class="mono" style="color:var(--faint);font-size:10px">${stats} · <span style="text-decoration:underline dotted;text-underline-offset:2px">${store}</span></span>
    ${effort ? sChip(effort + ' effort', 'var(--border2)', 'var(--dim)') : ''}
    <span class="mono" style="margin-left:auto;color:var(--faint);font-size:10.5px;flex:none">${when}${reviewing ? ' · reviewing' : ''}</span>
    ${sBtn('conversation')}${pending ? sBtn('resolve') : ''}${sBtn('🗑')}
  </div>`;
// Overview MASTER-DETAIL — a left nav (Fleet · Workflows · Tasks · Processes · Sessions) drives the
// right change-map detail (session chip + Folders strip + file ledger). Self/orchestrator selected.
const ovAgentRow = (dot, branch, self, bars, added, removed, sel) => `
  <div style="display:flex;align-items:center;gap:7px;padding:6px 12px;font-size:11.5px${sel ? ';background:var(--bg);box-shadow:inset 2px 0 0 var(--accent)' : ''}">
    <span class="dot" style="background:${dot};flex:none"></span>
    <span class="mono" style="color:${sel ? 'var(--ink)' : 'var(--dim)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;min-width:0">demo <span style="color:var(--faint)">⑂${branch}</span></span>
    ${self ? `<span style="font-size:8px;font-weight:700;color:var(--coral);border:1px solid var(--coral);border-radius:8px;padding:0 5px;flex:none">self</span>` : ''}
    <span style="margin-left:auto;display:flex;align-items:center;gap:7px;flex:none">${spark(bars, dot)}<span class="mono" style="font-size:9.5px"><span style="color:${gADD}">+${added}</span> <span style="color:${gREM}">−${removed}</span></span></span>
  </div>`;
const overviewTabsBody = `
  <div style="display:flex;align-items:stretch">
    <div style="flex:0 0 35%;min-width:0;background:var(--side);border-right:1px solid var(--border)">
      <div style="display:flex;flex-wrap:wrap;gap:4px 10px;padding:9px 12px 7px;border-bottom:1px solid var(--border);font-size:11px;line-height:1.5">
        <span style="color:var(--faint);white-space:nowrap">Sessions 4</span>
        <span style="color:var(--ink);border-bottom:1.5px solid var(--accent);padding-bottom:4px;white-space:nowrap">Workers 3</span>
        <span style="color:var(--faint);white-space:nowrap">Workflows 1</span>
        <span style="color:var(--faint);white-space:nowrap">Tasks 3</span>
        <span style="color:var(--faint);white-space:nowrap">Processes <span style="color:var(--kept)">1/2</span></span>
      </div>
      ${ovAgentRow('var(--blue)', 'demo/pipeline', true, [.3, .6, .4, .8, .5, .9, .7, 1], 40, 3, true)}
      ${ovAgentRow('var(--pending)', 'feat-x', false, [.5, .7, .3, .6, .8, .4, .6, .5], 42, 7, false)}
      ${ovAgentRow('var(--kept)', 'hotfix', false, [.4, .8, .6, .3, .7, .5, .2, .4], 6, 0, false)}
      <div style="font-size:9px;letter-spacing:.08em;color:var(--faint);font-weight:600;padding:9px 12px 2px;border-top:1px solid var(--border);margin-top:5px">WORKFLOWS</div>
      <div style="display:flex;align-items:center;gap:7px;padding:5px 12px;font-size:11px">
        <span class="dot" style="background:var(--blue);flex:none"></span>
        <span style="color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">ship-release <span style="color:var(--faint)">3/5</span></span>
        <span style="margin-left:auto;flex:none">${spark([.4, .5, .7, .6, .9, .5, .8, .6], 'var(--blue)')}</span>
      </div>
    </div>
    <div style="flex:1;min-width:0">
      <div style="display:flex;align-items:center;gap:9px;padding:10px 16px 6px;font-size:11.5px">
        <span style="background:var(--side);border:1px solid var(--border2);border-radius:12px;padding:2px 11px;display:inline-flex;flex-wrap:wrap;gap:2px 9px;align-items:center;min-width:0">
          <span class="mono" style="color:var(--ink)">demo <span style="color:var(--faint)">⑂demo/pipeline</span></span>
          <span style="color:var(--faint)">·</span><span>${microscope}</span><span class="mono" style="color:var(--ink)">Debug /effort &amp; optimize</span>
          <span style="color:var(--faint)">·</span><span style="color:var(--dim)">5 edits</span>
          <span style="color:var(--pending)">2⧗</span><span style="color:var(--kept)">3✓</span>
          <span style="color:var(--faint)">·</span><span style="color:var(--ink)">60%</span>
        </span>
      </div>
      <div style="padding:0 16px">${cmCap('Folders')}</div>
      <div style="display:flex;height:16px;border-radius:3px;overflow:hidden;margin:0 16px 10px">
        ${cmSeg('var(--kept)', 'src/models')}${cmSeg('var(--kept)', 'src')}${cmSeg('var(--pending)', 'tests')}${cmSeg('var(--pending)', 'docs')}
      </div>
      <div style="padding:0 16px 8px">
        ${cmCap('Files')}
        ${cmRow('var(--pending)', 'USAGE.md', 'docs', 100, '+12', '1⧗', '14:42:07')}
        ${cmRow('var(--pending)', 'test_pipeline.py', 'tests', 96, '+12', '1⧗', '14:41:12')}
        ${cmRow('var(--kept)', 'dataset.py', 'src/models', 58, '+7', '', '14:38:55')}
        ${cmRow('var(--kept)', 'features.py', 'src', 55, '+6', '', '14:36:20')}
        ${cmSummary('', 2, 3, null, 4, 4)}
      </div>
    </div>
  </div>`;

// The Overview's title-bar toolbar — TWO rows (the 0.8.4 layout): a controls row on top (session name +
// session-wide bulk + view controls), the four review AXES below. The controls row is labeled; the axes
// row is color-coded ICONS only, each naming its verb on hover.

// The Overview's Workflows tab — one row per multi-agent workflow run (informative name, state,
// per-phase progress groups, agents with tokens·time·edits) over a matching sparkline.
const wfRunRow = (dot, name, state, meta, bars, color) => `
  <div style="display:flex;align-items:center;gap:9px;padding:7px 16px;font-size:12.5px">
    <span class="dot" style="background:${dot};flex:none"></span>
    <span style="color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</span>
    ${state}
    <span style="margin-left:auto;display:flex;align-items:center;gap:13px;flex:none">
      <span class="mono" style="font-size:11px;color:var(--dim);white-space:nowrap">${meta}</span>
      ${spark(bars, color)}
    </span>
  </div>`;
const wfSubRow = (glyph, text, meta) => `
  <div style="display:flex;align-items:center;gap:8px;padding:3px 16px 3px 42px;font-size:11.5px">
    <span style="color:var(--faint)">└</span>${glyph}
    <span style="color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${text}</span>
    <span class="mono" style="margin-left:auto;color:var(--faint);font-size:10.5px;white-space:nowrap">${meta}</span>
  </div>`;
const workflowsBody = `
  <div style="display:flex;align-items:center;gap:14px;padding:9px 16px 0;border-bottom:1px solid var(--border);font-size:12px">
    <span style="color:var(--faint);padding-bottom:8px">Sessions 4</span>
    <span style="color:var(--faint);padding-bottom:8px">Workers 3</span>
    <span style="color:var(--ink);border-bottom:1.5px solid var(--accent);padding-bottom:8px">Workflows 2</span>
    <span style="color:var(--faint);padding-bottom:8px">Tasks 3</span>
    <span style="color:var(--faint);padding-bottom:8px;white-space:nowrap">Processes <span style="color:var(--kept)">1/2</span></span>
    <span style="margin-left:auto;display:flex;gap:14px;color:var(--faint);font-size:11px;padding-bottom:8px"><span>☐ Active only</span><span>Clear completed</span></span>
  </div>
  ${wfRunRow('var(--blue)', 'review-changes', phase('running', 'var(--blue)'), '3/5 phases · 41k tok · 12m', [.4, .5, .7, .6, .9, .5, .8, .6], 'var(--blue)')}
  ${wfSubRow(`<span style="color:var(--kept);font-size:10px">●</span>`, 'Review — 2 agents', '✓ done · 18k tok · 6 edits')}
  ${wfSubRow(`<span style="color:var(--blue);font-size:10px">●</span>`, 'Verify — verify:pipeline.py', 'running · 8k tok · 2m')}
  ${wfRunRow('var(--kept)', 'seed-demo-tasks', phase('done', 'var(--kept)'), '2/2 phases · 23k tok · 4m', [.6, .8, .4, .7, .5, .3, .2, .1], 'var(--kept)')}
  ${wfSubRow(`<span style="color:var(--kept);font-size:10px">●</span>`, 'Seed — 3 agents', '✓ done · 23k tok · 9 edits')}`;

// The Overview's Tasks tab — the session's numbered task list (TaskCreate/TaskUpdate), newest first,
// each row joined to its STRICT per-task rollup for live ± / edit counts; completed rows fold behind "N done".
const taskRow = (glyph, color, num, title, sub, meta, strike) => `
  <div style="display:flex;align-items:center;gap:9px;padding:6px 16px;font-size:12.5px">
    <span style="color:${color};flex:none">${glyph}</span>
    <span class="mono" style="color:var(--faint);font-size:11px;flex:none">#${num}</span>
    <span style="color:var(--${strike ? 'faint' : 'ink'});${strike ? 'text-decoration:line-through;' : ''}white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${title}</span>
    ${sub ? `<span style="color:var(--faint);font-style:italic;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto">${sub}</span>` : ''}
    <span class="mono" style="margin-left:auto;color:var(--faint);font-size:10.5px;flex:none;white-space:nowrap">${meta}</span>
  </div>`;
const tasksBody = `
  <div style="display:flex;align-items:center;gap:14px;padding:9px 16px 0;border-bottom:1px solid var(--border);font-size:12px">
    <span style="color:var(--faint);padding-bottom:8px">Sessions 4</span>
    <span style="color:var(--faint);padding-bottom:8px">Workers 3</span>
    <span style="color:var(--faint);padding-bottom:8px">Workflows 1</span>
    <span style="color:var(--ink);border-bottom:1.5px solid var(--accent);padding-bottom:8px">Tasks 3</span>
    <span style="color:var(--faint);padding-bottom:8px;white-space:nowrap">Processes <span style="color:var(--kept)">1/2</span></span>
    <span style="margin-left:auto;display:flex;gap:14px;color:var(--faint);font-size:11px;padding-bottom:8px"><span>☐ Active only</span><span>Clear completed</span></span>
  </div>
  <div style="font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);padding:8px 16px 2px">3 tasks · 2 done</div>
  ${taskRow('◐', 'var(--blue)', 3, 'Write pipeline tests', 'Writing pipeline tests…', '<span style="color:' + gADD + '">+12</span> −0 · 1⧗', false)}
  <div style="display:flex;align-items:center;gap:8px;padding:5px 16px;font-size:11px;color:var(--faint);border-top:1px solid var(--border)">
    <span>2 done · hide</span><span>clear resolved in completed tasks</span>
  </div>
  ${taskRow('✓', 'var(--kept)', 2, 'Dataset validation', '', '<span style="color:' + gADD + '">+7</span> −0 · 3 edits', true)}
  ${taskRow('✓', 'var(--kept)', 1, 'Feature scaling', '', '<span style="color:' + gADD + '">+6</span> <span style="color:' + gREM + '">−1</span> · 2 edits', true)}`;

// ---------- scenes ----------
const scenes = {
  // Per-window diagrams — the real panel mockup + a numbered legend of its parts.
  'win-actions': scene(1200, winDiag('ACTIONS', actionsCol, [
    note('1', 'Category groups', 'A tab of the Observatory Timeline panel (beside Feed, Prompts and Observations), collapsed by default — Edits · Commands · Reads · Searches · To-dos. Each counts its failed calls, and a risky command carries its flag. Live conflicts between agents, when there are any, lead the list.'),
    note('2', 'Outside the workspace', 'Risk&rsquo;s other half: the edits that landed outside the workspace, which a workspace-relative file list cannot show.'),
    note('3', 'Egress', 'Everywhere the session reached — web hosts, MCP servers, network shell commands, and files read from outside the workspace.'),
    note('4', 'Review links', 'A row with an edit links straight to its inline review.'),
  ].join(''))),
  'win-observations': scene(1180, winDiag('OBSERVATIONS', observationsCol, [
    note('1', 'Session recap', 'Claude Code&rsquo;s own title for the session (zero-token; ✦ to refine).'),
    note('2', 'Edits + reasoning', 'One row per edit, newest first, with the first line of Claude&rsquo;s own reasoning; adjacent same-file edits coalesce into a <b style="color:var(--ink)">×N</b> run. An edit to a file whose edits you keep reverting leads with ⚠, and the file&rsquo;s review memory across sessions (🧠) is on hover.'),
  ].join(''))),
  'win-stats': scene(1120, winDiag('STATS', statsCol(40, 40), [
    note('1', 'Review scoreboard', 'Live pending / accepted / reverted counts + a progress bar that fills as you review.'),
    note('2', 'Range toggle', 'Today · 7&nbsp;days · 30&nbsp;days for the plots below.'),
    note('3', 'Token plot', 'Total / input / output tokens over the window (log scale, crosshair tooltip).'),
    note('4', 'Usage bars', 'Context fill, plan usage (5-hour · weekly · monthly) and spend, plus the top-tier model&rsquo;s weekly cap — with reset countdowns, a last-refreshed stamp, and a &#8635; to refresh.'),
  ].join(''))),
  // The full observatory layout
  'layout': scene(1760, `
    <div class="window">
      <div class="titlebar"><span class="tl" style="background:#ff5f57"></span><span class="tl" style="background:#febc2e"></span><span class="tl" style="background:#28c840"></span><span class="t">demo — Visual Studio Code</span></div>
      <div class="row" style="align-items:stretch; height:472px;">
        <div style="width:48px;background:var(--side);border-right:1px solid var(--border);display:flex;flex-direction:column;align-items:center;padding-top:12px;gap:20px;">
          <span style="opacity:.4">🗎</span><span style="opacity:.4">${icoSearch}</span>
          <span style="position:relative;font-size:18px">${microscope}<span style="position:absolute;right:-7px;bottom:-5px;background:var(--accent);color:#fff;border-radius:8px;font-size:9px;padding:0 4px;">3</span></span>
          <span style="opacity:.4">⚙</span>
        </div>
        <div style="width:300px;background:var(--side);border-right:1px solid var(--border);">
          <div style="padding:10px 14px 2px;font-size:11px;color:var(--dim);letter-spacing:.06em;">OBSERVATORY TRACES</div>
          ${reviewList}
          <div class="viewhead" style="border-top:1px solid var(--border);">FILE HISTORY <span style="float:right;color:var(--faint)">features.py</span></div>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;">
          <div style="display:flex;background:var(--side);border-bottom:1px solid var(--border);">
            <div style="padding:8px 18px;background:var(--bg);border-right:1px solid var(--border);font-size:12.5px;">features.py</div>
          </div>
          ${editorCode()}
        </div>
        <div style="width:400px;background:var(--side);border-left:1px solid var(--border);">
          ${timelinePanel}
        </div>
      </div>
      <div style="border-top:1px solid var(--border);background:var(--panel);">
        <div class="paneltabs"><span>PROBLEMS</span><span>OUTPUT</span><span>TERMINAL</span><span class="on">OBSERVATORY DASHBOARDS</span></div>
        <div class="row" style="align-items:stretch;height:212px;">
          <div class="col" style="flex:1.55;border-right:1px solid var(--border);"><div class="colhead">OVERVIEW</div>${changeMapCol}</div>
          <div class="col" style="flex:1;"><div class="colhead">STATS</div>${statsCol(34, 34).replace(/<div class="uhead uusage">[\s\S]*$/, '<div class="urow"><span class="lbl">ctx</span><span class="track"><span class="fill" style="width:39%;background:var(--kept)"></span></span><span class="pct" style="color:var(--kept)">39%</span><span class="sub">390k/1M</span></div>')}</div>
        </div>
      </div>
      <div class="statusbar">
        <span class="sb-warn">${microscope} 3</span>
        <span>⎇ main</span><span style="margin-left:auto">Ln 8, Col 1&nbsp;&nbsp;UTF-8&nbsp;&nbsp;Python</span>
      </div>
    </div>`),

  // B. inline review closeup — the 0.10.0 default surfaces: the shortened lens row above the edit and the
  //    compact review BAR under its anchor line.
  'inline-review': scene(980, `
    <div class="window">
      <div style="display:flex;background:var(--side);border-bottom:1px solid var(--border);">
        <div style="padding:8px 18px;background:var(--bg);border-right:1px solid var(--border);font-size:12.5px;display:flex;align-items:center;gap:8px;">train.py<span style="font-size:10px;color:var(--pending)">1</span></div>
      </div>
      ${editorCodeCombined()}
      <div class="statusbar"><span class="sb-warn">${microscope} 3</span><span style="color:var(--faint)">⌥⌘N next · ⌥⌘Y keep · ⌥⌘U undo · ⌥⌘- / ⌥⌘= revisions</span></div>
    </div>`),

  // C. observations panel closeup, with the tooltip of the single-edit features.py row above it, line for
  //    line as VS Code builds it (a run's tooltip is only its file, count and delta)
  'observations': scene(980, `
    <div class="window" style="padding-bottom:8px;">
      <div class="paneltabs"><span>TERMINAL</span><span class="on">OBSERVATORY TIMELINE</span></div>
      <div class="colhead" style="padding-top:10px;">OBSERVATIONS</div>
      ${observationsCol}
      <div class="hovercard" style="margin:10px 16px 8px 40px;width:430px;">
        <span style="color:var(--dim)">💭 Adding scale() — z-score standardization so features share a range before training.</span><br>
        <span style="color:var(--pending)">⚠ history: edits to this file get reverted often (3 of 6 verdicts) — review carefully</span><br>
        <span style="color:var(--dim)">🧠 6 edits across sessions · 50% accepted · last reverted Aug 29 16:05</span><br>
        <span style="color:var(--faint)">Edit · pending · 14:02:14</span><br>
        <span style="color:var(--faint)">Click to open the full report.</span>
      </div>
    </div>`),

  // D. stats panel closeup
  'stats': scene(760, `
    <div class="window" style="padding-bottom:10px;">
      <div class="paneltabs"><span>TERMINAL</span><span class="on">OBSERVATORY DASHBOARDS</span></div>
      <div class="colhead" style="padding-top:10px;">STATS</div>
      ${statsCol(56, 56)}
    </div>`),

  // E. the terminal front-end — status, list, surgical undo
  'cli': scene(900, `
    <div class="window">
      <div class="titlebar"><span class="tl" style="background:#ff5f57"></span><span class="tl" style="background:#febc2e"></span><span class="tl" style="background:#28c840"></span><span class="t">demo — oak</span></div>
      ${terminalBody()}
    </div>`),

  // F. surgical-undo conflict → --force fallback
  'conflict': scene(880, `
    <div class="window">
      <div class="titlebar"><span class="tl" style="background:#ff5f57"></span><span class="tl" style="background:#febc2e"></span><span class="tl" style="background:#28c840"></span><span class="t">demo — oak</span></div>
      ${conflictBody()}
    </div>`),

  // G. one edit as its own diff tab — what a Review row opens
  'diffs': scene(980, `
    <div class="window">
      ${diffTabBody()}
      <div class="statusbar"><span class="sb-warn">${microscope} 3</span><span style="color:var(--faint)">Review — click any row for its before ⟷ after</span></div>
    </div>`),

  // G2. the stacked-diff view — "Open all in editor" reads every pending unit as one concatenated
  //     scroll, each diff with its own Keep/Undo (per-block Chat dropped in 0.10.0).
  'stacked-diffs': scene(980, stackedDiffsBody()),

  // G3. the Observatory Traces sidebar — every pending unit in the project tree, grouped by file,
  //     with per-row Keep/Undo and the file-level and open-all actions above. The header carries the
  //     inline toolbar the page describes: a search field, a filter dropdown, and a sort dropdown.
  'traces-sidebar': scene(380, `
    <div class="window" style="padding-bottom:10px;">
      <div style="display:flex;background:var(--side);border-bottom:1px solid var(--border);padding:8px 14px;font-size:11px;letter-spacing:.11em;text-transform:uppercase;color:var(--faint)">Observatory Traces</div>
      <div style="display:flex;align-items:center;gap:6px;background:var(--side);border-bottom:1px solid var(--border);padding:6px 12px;font-size:11px;color:var(--dim)">
        <span style="flex:1;display:flex;align-items:center;gap:5px;border:1px solid var(--line);border-radius:4px;padding:2px 7px;color:var(--faint)"><span>⌕</span>Search</span>
        <span style="border:1px solid var(--line);border-radius:4px;padding:2px 7px">Filter ▾</span>
        <span style="border:1px solid var(--line);border-radius:4px;padding:2px 7px">Sort: Newest ▾</span>
      </div>
      ${reviewList}
    </div>`),

  // H. file spotlight spotlight
  'spotlight': scene(980, `
    <div class="window">
      <div style="display:flex;background:var(--side);border-bottom:1px solid var(--border);">
        <div style="padding:8px 18px;background:var(--bg);border-right:1px solid var(--border);font-size:12.5px;">features.py</div>
      </div>
      ${spotlightEditor()}
      <div class="statusbar"><span class="sb-warn">${microscope} 3</span><span style="color:var(--faint)">${icoBulb} Spotlight on — every unmodified line dimmed</span></div>
    </div>`),

  // I. File History — the active file's edits, chronological, follows the editor
  'file-history': scene(720, `
    <div class="window" style="padding-bottom:8px;">
      <div class="viewhead" style="padding-top:12px;">FILE HISTORY <span style="float:right;color:var(--faint)">features.py</span></div>
      ${fileHistoryCol}
    </div>`),

  // J. 0.8.0 — the Overview's Fleet tab: every agent (worktree) in this project, its subagents, collisions.
  'multitasking': scene(820, `
    <div class="window" style="padding-bottom:8px;">
      ${multitaskingBody}
    </div>`),

  // J2. 0.8.7 — the Prompts window: the session as the conversation, one row per ask, each with what
  //     it produced. The ask is never clipped — it wraps over as many lines as it takes. Selecting one
  //     scopes the Overview beside it (the scoped row is outlined, and its scope bar appears there).
  'prompts': scene(700, `
    <div class="window" style="padding-bottom:8px;">
      <div class="viewhead" style="padding-top:12px;">OBSERVATORY TIMELINE: PROMPTS <span style="float:right;color:var(--faint)">6 asks · 4 with edits · 71 edits</span></div>
      <div style="font-size:10.5px;color:var(--faint);padding:0 16px 8px;line-height:1.45;border-bottom:1px solid var(--border)">What you asked for, in order. Select one to scope the Overview beside it — its fleet, runs, tasks, shells and change map narrow to the work that ask caused.</div>
      ${promptRow(6, '14:43:10', '', '', 'add a Processes tab so I can see the shells that are still running, and let me click one to follow its output', '2 tool calls · 41k tok', '~4m', false)}
      ${promptRow(5, '', '+412 −96', '31 edits · 8f · 3fo · 12 pending', 'the loader is still reading the whole file into memory — stream it instead, and add a test that fails on the old behaviour', '190k tok · 2 tasks · 1 subagent · 1 shell', '22m', true,
        'Right — the loader reads the file whole before yielding. I switched it to a streaming reader that emits one record at a time, and added a test that pins the old eager behaviour as a failure. Two call sites needed the iterator form; both updated.')}
      ${promptRow(4, '', '', '', 'yes, that reading is right', 'no edits — a question or a decision · 6k tok', '40s', false)}
      ${promptRow(3, '', '+188 −41', '18 edits · 5f · 2fo', 'split the training loop out of models.py — it has grown into two things', '120k tok · 3 tasks · 1 workflow run', '31m', false)}
      ${promptRow(2, '', '+94 −12', '9 edits · 3f · 1fo', 'add type hints to the dataset module', '58k tok · 1 task', '11m', false)}
      ${promptRow(1, '', '+220 −18', '13 edits · 6f · 4fo · 3 pending', 'set up the project: a package layout, a test runner, and the smallest CI that runs it', '210k tok · 4 tasks · 2 shells', '18m', false)}
    </div>`),

  // K. 0.8.0 — Overview master-detail: Fleet · Workflows left nav + the change-map detail (right).
  'overview-workflows': scene(820, workflowsBody),
  'overview-tasks': scene(820, tasksBody),
  'overview-tabs': scene(860, `
    <div class="window" style="padding-bottom:10px;">
      ${overviewTabsBody}
    </div>`),

  // L. the Sessions tab: the Auto row, which both editors put above every workspace header, then this
  //    machine's sessions grouped by workspace, this workspace first, the live one
  //    marked; stamps are clock times, as every surface prints them. Selecting a row switches what the whole observatory is reviewing. The listing is
  //    built from directory stats and cached titles, so it opens instantly however large the store is.
  'sessions': scene(900, `
    <div class="window" style="padding-bottom:10px;">
      <div class="viewhead" style="padding-top:12px;">OVERVIEW · SESSIONS <span style="float:right;color:var(--faint)">4 sessions · 2 workspaces</span></div>
      <div style="font-size:10.5px;color:var(--faint);padding:0 16px 8px;line-height:1.45;border-bottom:1px solid var(--border)">Sessions on this machine, grouped by workspace. This workspace is first; select a session to review its conversation and edits.</div>
      <div style="display:flex;align-items:center;gap:9px;padding:5px 16px;font-size:12px">
        <span style="color:var(--faint);flex:none">○</span>
        <span style="color:var(--dim)">Auto — newest session in this workspace</span>
      </div>
      <div style="padding:6px 16px;color:var(--faint);font-size:11px">~/projects/training · 3 sessions</div>
      ${sessionRow(true, 'Extend the training pipeline', '', 'Opus 5', '<span style="color:var(--kept)">+412</span> <span style="color:var(--reverted)">−96</span> · <span style="color:var(--pending)">5 pending</span> · 14 edits · 190k tok · 22m', '3.1 MB', 'xhigh', '14:43:10', true, true)}
      ${sessionRow(false, 'Split the training loop out of models.py', '', 'Opus 5', '<span style="color:var(--kept)">+188</span> <span style="color:var(--reverted)">−41</span> · <span style="color:var(--kept)">✓</span> · 8 edits · 120k tok · 31m', '1.4 MB', 'high', '12:41:07', false, false)}
      ${sessionRow(false, 'Add type hints to the dataset module', '', 'Sonnet 5', '<span style="color:var(--kept)">+94</span> <span style="color:var(--reverted)">−12</span> · <span style="color:var(--kept)">✓</span> · 4 edits · 58k tok · 11m', '640 KB', '', 'Sep 25 16:05', false, false)}
      <div style="padding:6px 16px;color:var(--faint);font-size:11px">~/projects/data-tools · 1 session</div>
      ${sessionRow(false, 'Explain the dataset validation rules', 'codex', 'gpt-6', '0 edits · 12k tok · 4m', '88 KB', '', 'Sep 25 09:32', false, false)}
    </div>`),

  // L2. 0.8.7 — the FEED under whatever the nav selected: a live tail while the thing is still working,
  //     an audit log the moment it has finished (fetched once, never re-polled).
  'feed': scene(820, `
    <div class="window" style="padding-bottom:10px;">
      <div class="viewhead" style="padding-top:12px;">TIMELINE · FEED <span style="float:right;color:var(--faint)">following: docs-writer</span></div>
      <div style="font-size:10.5px;color:var(--faint);padding:0 16px 8px;line-height:1.45;border-bottom:1px solid var(--border)">The Timeline Feed tab: the conversation as it happened — your prompts, the agent's replies and thinking, every tool call — or what the Overview's pick (an agent, run, task, or shell) is doing, read from the file it writes. A finished selection reads the same way and is labeled an audit log — it is fetched once, because a record that can no longer change costs nothing to keep.</div>
      <div style="display:flex;align-items:center;gap:9px;padding:8px 16px 4px;font-size:11.5px">
        <span class="dot" style="background:var(--blue)"></span><span style="color:var(--ink)">docs-writer</span>
        <span style="font-size:9px;border:1px solid var(--border2);border-radius:99px;padding:0 7px;color:var(--blue)">live · 14:41:12</span>
        <span style="margin-left:auto;color:var(--faint);font-size:10px" class="mono">18 entries · 3 not shown</span>
      </div>
      ${promptBand('14:40:58', '#2', 'Document the scaling change and run the tests.')}
      ${saidRow('14:41:00', 'thinking', 'The usage doc describes the old in-place behaviour; fix that first, then run the suite.', true)}
      ${saidRow('14:41:01', 'said', 'I will update the usage doc and run the tests.', false)}
      ${feedRow('14:41:02', 'Read', 'src/models/dataset.py', false)}
      ${feedRow('14:41:04', 'Grep', '"def scale\\("', false)}
      ${feedRow('14:41:09', 'Write', 'docs/USAGE.md', false, ['@@ -12,2 +12,3 @@', '-`scale(df)` normalises in place.', '+`scale(df)` returns a copy;', '+pass `inplace=True` to mutate.'])}
      ${feedRow('14:41:12', '$', 'python -m pytest -q', true)}
      ${saidRow('14:41:14', 'said', 'The doc now says <code>scale()</code> returns a copy. One test fails on the old in-place call — fixing it next.', false)}
    </div>`),

  // L3. 0.8.7 — background shells: what run_in_background left running, after the call scrolled away.
  'processes': scene(820, `
    <div class="window" style="padding-bottom:10px;">
      <div class="viewhead" style="padding-top:12px;">OVERVIEW · PROCESSES <span style="float:right;color:var(--faint)">1 running · 2 total</span></div>
      <div style="font-size:10.5px;color:var(--faint);padding:0 16px 8px;line-height:1.45;border-bottom:1px solid var(--border)">Shells Claude started with run_in_background and left running. Identity is the harness's own shell id — a transcript records no OS process id, and the agent may be running over SSH or in a container, so inferring one would be wrong.</div>
      ${procRow('running', 'var(--kept)', 'demo-serve', 'Serve the docs preview', '5s · 62 B out')}
      ${procRow('exit 0', 'var(--faint)', 'demo-tests', 'Watch the test suite', '1m · 51 B out')}
      <div style="display:flex;align-items:center;gap:8px;padding:7px 16px 2px;font-size:11px;color:var(--faint);border-top:1px solid var(--border);margin-top:6px">
        Running shells sort first · select one for its full command and a tail of its output
      </div>
    </div>`),

  // M. chat about an edit: VS Code builds the prompt (chatAboutEdit), puts it on the clipboard and asks
  //    before it goes to the session's live agent through herdr. Nothing is sent without Send to agent;
  //    Edit first… opens the draft to change before sending, and the modal adds its own Cancel.
  'chat': scene(860, `
    <div class="window">
      <div class="titlebar"><span class="tl" style="background:#ff5f57"></span><span class="tl" style="background:#febc2e"></span><span class="tl" style="background:#28c840"></span><span class="t">Chat about an edit — a draft, sent only when you choose</span></div>
      <div style="padding:16px 20px;font-size:12.5px;line-height:1.6">
        <div style="color:var(--ink);font-weight:600;margin-bottom:10px">Prompt about edit #2 is on the clipboard. Send it to this session’s live agent?</div>
        <div class="mono" style="color:var(--dim);white-space:pre-wrap;border:1px solid var(--border2);border-radius:6px;padding:10px 14px;background:var(--side);font-size:12px;line-height:1.55">I'm reviewing an agent change to \`src/train.py\` (edit #2, Edit).

--- before ---
from features import summarize

print(summarize([1.0, 2.0, 3.0]))

--- after ---
from features import summarize, scale

features = scale([1.0, 2.0, 3.0])
print(summarize(features))


Please explain what this change does and whether it looks correct.</div>
        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:14px;font-size:12px">
          <span style="padding:4px 14px;border-radius:3px;background:#0e639c;color:#fff">Send to agent</span>
          <span style="padding:4px 14px;border-radius:3px;border:1px solid var(--border2);color:var(--ink)">Edit first…</span>
          <span style="padding:4px 14px;border-radius:3px;border:1px solid var(--border2);color:var(--ink)">Cancel</span>
        </div>
      </div>
    </div>`),

  // N. the live demo: one command simulates a full session through the real pipeline (its real narration).
  'demo': scene(960, `
    <div class="window">
      <div class="titlebar"><span class="tl" style="background:#ff5f57"></span><span class="tl" style="background:#febc2e"></span><span class="tl" style="background:#28c840"></span><span class="t">demo — oak</span></div>
      <div class="term">
        <div class="cmd"><span class="pr">$</span>oak <span class="fl">demo</span></div>
        <div class="out">▸ prompt 1 — asking Claude to extend the training pipeline</div>
        <div class="out">▸ plan — the to-dos and the numbered task list</div>
        <div class="out">▸ task 1 — feature scaling (2 edits)</div>
        <div class="out">  … wiring it into the entrypoint</div>
        <div class="out">  … the sanity run FAILS — the failed call the audit counts</div>
        <div class="out">  … and the fix — a SECOND edit to the same file</div>
        <div class="out">▸ task 2 — dataset validation</div>
        <div class="out">  … three background shells: one finishes, one fails, one keeps running</div>
        <div class="out">▸ a second agent picks up a hotfix in a sibling worktree</div>
        <div class="out">  … context fills up and the harness compacts the conversation</div>
        <div class="out">▸ prompt 2 — asking for the tests, the docs, and the old scaler gone</div>
        <div class="out">▸ task 3 — tests, written by a subagent</div>
        <div class="out">  … the subagent's edit lands, attributed by its action window</div>
        <div class="out">▸ a workflow run starts — three phases, one level above the subagents</div>
        <div class="out">  … the docs phase writes the documentation</div>
        <div class="out">  … the review phase starts, and is still going when the replay ends</div>
        <div class="out">▸ task 4 — the legacy scaler is deleted (captured by the Bash path)</div>
        <div class="out">▸ prompt 3 — asking for a profiling report</div>
        <div class="out">  … a timing helper joins features.py, in a region of its own</div>
        <div class="out">  … the report lands OUTSIDE the workspace — what the Risk audit reports</div>
        <div class="out">▸ recap — and the next task is already under way</div>
        <div class="out"><span class="ok">✔</span> demo session <span class="id2">demo-e60c9894</span> — 9 captured edits across 21 beats (+ a sibling agent on demo/hotfix)</div>
        <div class="out"><span class="ok">✓</span> demo session <span class="id2">demo-e60c9894</span> is live — <span class="warn">9 pending edits</span> in observatory-demo, plus a second agent on demo/hotfix</div>
        <div class="out">  guided tour: <span class="fl">oak demo --tour</span>   ·   remove every trace: <span class="fl">oak demo --clean</span></div>
        <div class="cmd"><span class="pr">$</span><span class="cursor">&nbsp;</span></div>
      </div>
    </div>`),
};

// ---------- render ----------
// per-scene capture box (width = sceneW + 48px body padding; the height only has to exceed the window's)
const SIZE = {
  layout: '1808,910',
  'win-actions': '1248,360', 'win-observations': '1228,288', 'win-stats': '1168,548',
  stats: '808,540', 'inline-review': '1028,400', observations: '1028,368',
  cli: '948,760', conflict: '928,420', diffs: '1028,330', 'stacked-diffs': '1028,1040', 'traces-sidebar': '428,466', spotlight: '1028,400',
  'file-history': '768,130',
  multitasking: '868,480', 'overview-tabs': '908,400', prompts: '748,700',
  'overview-workflows': '868,320', 'overview-tasks': '868,300',
  sessions: '948,430', feed: '868,590', processes: '868,205', chat: '908,640', demo: '1008,900',
};
const tmp = mkdtempSync(join(tmpdir(), 'obs-media-')); // one per run: concurrent renders never share it
// Optional scene filter: `node scripts/render-media.mjs stacked-diffs diffs` renders only those.
const htmlOnly = process.argv.includes('--html-only');
const only = process.argv.slice(2).filter(arg => arg !== '--html-only');
for (const [name, html] of Object.entries(scenes)) {
  if (only.length && !only.includes(name)) continue;
  const src = join(tmp, `${name}.html`);
  writeFileSync(src, html);
  if (htmlOnly) { writeFileSync(join(OUT, `${name}.html`), html); console.log('rendered HTML', name); continue; }
  const png = capturePng(CHROME, [
    '--headless', '--disable-gpu', '--no-sandbox', '--ozone-platform=headless', '--use-mock-keychain', '--password-store=basic', '--default-background-color=00000000',
    '--force-device-scale-factor=2', '--hide-scrollbars',
    `--window-size=${SIZE[name] || '1028,344'}`,
    `file://${src}`,
  ]);
  writeFileSync(join(OUT, `${name}.png`), fitToContent(png, name));
  console.log('rendered', `${name}.png`);
}

// Full-window mockups authored as standalone .src.html (their own PyCharm/JetBrains New-UI styling,
// which the shared VS Code scene bits above don't cover). Each sets its own 1568x830 body size.
for (const name of ['pyc-layout']) {
  if (htmlOnly || (only.length && !only.includes(name))) continue;
  const png = capturePng(CHROME, [
    '--headless', '--disable-gpu', '--no-sandbox', '--ozone-platform=headless', '--use-mock-keychain', '--password-store=basic', '--default-background-color=00000000',
    '--force-device-scale-factor=2', '--hide-scrollbars',
    '--window-size=1900,860',
    `file://${join(OUT, `${name}.src.html`)}`,
  ]);
  writeFileSync(join(OUT, `${name}.png`), png);
  console.log('rendered', `${name}.png`);
}
rmSync(tmp, { recursive: true, force: true });
