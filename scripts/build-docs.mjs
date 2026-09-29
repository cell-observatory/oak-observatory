// Build the OAK docs site: one HTML page per topic, all sharing a three-column shell
// (grouped left sidebar · centered prose · right "On this page" TOC · prev/next footer).
//
// The shell, the navigation manifest (NAV), and the ⌘K jump index live HERE so a sidebar edit
// lands on every page at once — the reason this is generated rather than 30 hand-kept copies.
// Page BODIES live as fragments in docs/_content/<slug>.html; this wraps each in the shell,
// auto-builds its TOC from the <h2>/<h3> headings, and links it to its neighbours in NAV order.
//
// Usage: node scripts/build-docs.mjs        (writes docs/<slug>.html for every page in NAV)
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DOCS = path.join(ROOT, 'docs');
const CONTENT = path.join(DOCS, '_content');
// Version + repo come from the root manifest — a literal here silently reverted the version
// scripts/version.mjs stamps into the pages every time the docs were rebuilt.
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = `v${PKG.version}`;
const REPO = PKG.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');

// --- the information architecture: groups → pages, in sidebar + prev/next order ------------------
// Decks are rendered as body copy (`<p class="deck">` + the meta description), so per
// docs/STYLE.md D2/X4 each one is a complete sentence, never a headline fragment.
const NAV = [
  { group: 'Start here', pages: [
    { slug: 'what-is-oak', title: 'What OAK is', deck: 'This is the two-minute picture of what the observatory records and why.' },
    { slug: 'install', title: 'Install', deck: 'Add OAK to a machine and its editors, and switch capture on.' },
    { slug: 'first-review', title: 'Your first review', deck: 'Walk from an agent session to a reviewed, kept change in a few minutes.' },
  ]},
  { group: 'The OAK model', pages: [
    { slug: 'sessions-agents', title: 'Sessions & agents', deck: 'A session is the one conversation everything hangs off; agents are who worked inside it.' },
    { slug: 'worktrees', title: 'Worktrees & siblings', deck: 'OAK correlates parallel agents across the git worktrees of one repository.' },
    { slug: 'subagents-roles', title: 'Subagents & roles', deck: 'Subagents are the agents an agent spawns; each one carries the job it was given.' },
    { slug: 'workflows-fleet', title: 'Workflows & the fleet', deck: 'Workflows are scripted fan-outs, and the fleet puts every running agent on one board.' },
  ]},
  { group: 'What OAK records', pages: [
    { slug: 'prompts', title: 'Prompts', deck: 'Prompts record what you asked for — the spine the rest of the record hangs on.' },
    { slug: 'tasks', title: 'Tasks', deck: 'Tasks are the to-dos an agent set itself, with the edits captured under each one.' },
    { slug: 'actions', title: 'Actions', deck: 'Actions record every tool call an agent made, in order, with its result.' },
    { slug: 'edits', title: 'Edits & the change map', deck: 'Edits are the reviewable unit; the change map summarizes them all.' },
    { slug: 'capture', title: 'Transcript, store & hook', deck: 'The transcript and the hook-fed store are the two token-free sources everything derives from.' },
  ]},
  { group: 'The surfaces', pages: [
    { slug: 'observations', title: 'Observations', deck: 'Observations pair each edit with the reasoning recorded near it, plus flags.' },
    { slug: 'actions-view', title: 'Actions view', deck: 'The Actions view shows the tool-call timeline and raises the conflicts that need attention first.' },
    { slug: 'feed', title: 'Feed', deck: 'The feed streams what an agent is doing as it works, oldest first.' },
    { slug: 'stats-spotlight', title: 'Stats & spotlight', deck: 'Stats plots the review scoreboard and token usage; Spotlight highlights the changed lines.' },
  ]},
  { group: 'Reviewing', pages: [
    { slug: 'review-units', title: 'The review unit', deck: 'This page explains why the unit of decision is what an agent changed for a prompt.' },
    { slug: 'keep-undo', title: 'Keep, undo, accept & reject', deck: 'Two verb pairs cover every decision, separated by how much they act on.' },
    { slug: 'conflicts', title: 'Conflicts', deck: 'When two agents touch one file, a guarded undo protects it.' },
  ]},
  { group: 'The audits', pages: [
    { slug: 'risk', title: 'Risk', deck: 'Risk shows what a session wrote outside the workspace — exercised, not merely permitted.' },
    { slug: 'egress', title: 'Egress', deck: 'Egress shows what a session read from outside the workspace, grouped by scope.' },
    { slug: 'compaction', title: 'Compaction & context', deck: 'Compaction shows what shaped a session and where its context was silently dropped.' },
  ]},
  { group: 'Working with agents', pages: [
    { slug: 'supported-agents', title: 'Supported agents', deck: 'OAK captures native Claude Code and Codex sessions.' },
    { slug: 'claude-code', title: 'Claude Code', deck: 'Claude Code is the hooks-native default, observed from outside the model loop.' },
    { slug: 'codex', title: 'Codex', deck: 'OAK captures native Codex hooks and rollout logs.' },
    { slug: 'models', title: 'Models', deck: 'Capture is model-independent; this page covers running open weights under an agent.' },
  ]},
  { group: 'Terminal app', pages: [
    { slug: 'tui', title: 'Terminal app', deck: 'The terminal app puts the whole observatory in your terminal — try it, then dig into each tab.' },
    { slug: 'tui-herdr', title: 'The herdr tab', deck: 'The herdr tab runs the real terminal client for agents and remote machines.' },
    { slug: 'tui-observatory', title: 'The observatory tab', deck: 'The observatory tab lists sessions beside a detail pane: a pinned conversation, workers, tasks and review links.' },
    { slug: 'tui-review', title: 'The review tab', deck: 'The review tab brings per-edit diffs and the keep and undo verbs to the terminal.' },
  ]},
  { group: 'Editor extensions', pages: [
    { slug: 'editors', title: 'Editor extensions', deck: 'The VS Code extension and the JetBrains plugin render one record in two editors.' },
    { slug: 'editors-overview', title: 'The Overview panel', deck: 'The Overview panel is the master-detail board: Sessions, Workers, Workflows, Tasks, and Processes.' },
    { slug: 'editors-traces', title: 'The Traces sidebar', deck: 'The Traces sidebar lists every pending edit, grouped by file, with Keep and Undo on each row.' },
    { slug: 'editors-inline', title: 'Inline review', deck: 'Inline review surfaces pending edits in the editor itself, under a floating review bar.' },
    { slug: 'editors-stacked', title: 'The stacked diff view', deck: '“Open all in editor” stacks every pending diff into one scroll, each with its own verbs.' },
    { slug: 'editors-timeline', title: 'The Timeline panel', deck: 'The Timeline panel gathers Feed, Prompts, Observations and Actions in one place.' },
  ]},
  { group: 'Reference', pages: [
    { slug: 'cli', title: 'CLI reference', deck: 'The CLI carries every command the editors render, usable on its own.' },
    { slug: 'ignore', title: '.observatoryignore', deck: 'An .observatoryignore rule keeps matches out of capture; this page covers how stored records are swept.' },
    { slug: 'releases', title: 'Releases & channels', deck: 'OAK ships on a stable and a dev channel; this page explains how updates reach you.' },
  ]},
];

// Flatten to prev/next order and a ⌘K jump index.
const FLAT = NAV.flatMap((g) => g.pages.map((p) => ({ ...p, group: g.group })));
const INDEX = FLAT.map((p) => ({ s: p.slug, t: p.title, g: p.group, d: p.deck }));

// --- heading → id, and TOC extraction ------------------------------------------------------------
// A heading's text is HTML, so its entities are decoded before it becomes an id or a TOC label — the TOC
// escapes its labels, and "Switching &amp; updating" otherwise read as "Switching &amp;amp; updating".
const textOf = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
const slugify = (s) =>
  textOf(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Inject ids + anchor links into h2/h3 and return the TOC entries, without a DOM. */
function processHeadings(html) {
  const toc = [];
  const out = html.replace(/<h([23])(\s[^>]*)?>([\s\S]*?)<\/h\1>/g, (m, lvl, attrs = '', inner) => {
    const idMatch = attrs && attrs.match(/\bid="([^"]+)"/);
    const id = idMatch ? idMatch[1] : slugify(inner);
    const cleanAttrs = (attrs || '').replace(/\s*id="[^"]*"/, '');
    toc.push({ lvl: Number(lvl), id, text: textOf(inner) });
    return `<h${lvl}${cleanAttrs} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to this section"></a>${inner}</h${lvl}>`;
  });
  return { html: out, toc };
}

// --- the shared shell ----------------------------------------------------------------------------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function sidebar(activeSlug) {
  return NAV.map((g) => {
    const items = g.pages.map((p) => {
      const on = p.slug === activeSlug;
      return `<li><a href="${p.slug}.html"${on ? ' class="on" aria-current="page"' : ''}>${esc(p.title)}</a></li>`;
    }).join('');
    return `<div class="grp"><span class="grp-h">${esc(g.group)}</span><ul>${items}</ul></div>`;
  }).join('\n');
}

function tocHtml(toc) {
  if (!toc.length) return '';
  const items = toc.map((t) => `<li class="l${t.lvl}"><a href="#${t.id}">${esc(t.text)}</a></li>`).join('');
  return `<aside class="toc"><div class="toc-h">On this page</div><ul>${items}</ul></aside>`;
}

function prevNext(i) {
  const prev = i > 0 ? FLAT[i - 1] : null;
  const next = i < FLAT.length - 1 ? FLAT[i + 1] : null;
  const card = (p, dir) =>
    p ? `<a class="pn ${dir}" href="${p.slug}.html"><span class="pn-d">${dir === 'prev' ? '← Previous' : 'Next →'}</span><span class="pn-t">${esc(p.title)}</span></a>` : '<span class="pn-sp"></span>';
  return `<nav class="prevnext">${card(prev, 'prev')}${card(next, 'next')}</nav>`;
}

function page(p, i, bodyHtml, toc) {
  const active = p.slug;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OAK — ${esc(p.title)}</title>
<meta name="description" content="${esc(p.deck)}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%94%AC%3C/text%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400..700;1,9..40,400..600&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="nav" id="nav">
  <div class="nav-in">
    <a class="brand" href="showcase.html"><span class="m">🔬</span> OAK <span class="ver" data-co-version>${VERSION}</span></a>
    <nav class="nav-links" aria-label="Primary">
      <a href="what-is-oak.html" class="on">Docs</a>
      <a href="releases.html">Releases</a>
      <a href="${REPO}">GitHub</a>
    </nav>
    <div class="nav-right">
      <button class="kbtn" id="ksearch" aria-label="Search docs">
        <span class="kmag">⌕</span><span class="klabel">Search</span><kbd>⌘K</kbd>
      </button>
      <button class="icon-btn" id="sidebtn" aria-label="Toggle navigation"><svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M2 5.5h18M2 11h18M2 16.5h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
      <button class="icon-btn" id="theme" aria-label="Toggle theme">◐</button>
      <a class="ghost" href="${REPO}">GitHub&nbsp;↗</a>
    </div>
  </div>
</header>

<div class="docs">
  <aside class="side" id="side">
    <button class="side-search" id="ksearch2"><span class="kmag">⌕</span> Search docs <kbd>⌘K</kbd></button>
    <nav class="side-nav" aria-label="Docs">
${sidebar(active)}
    </nav>
  </aside>

  <main class="content" id="main">
    <div class="crumb">${esc(p.group)}</div>
    <h1>${esc(p.title)}</h1>
    <p class="deck">${esc(p.deck)}</p>
    <div class="prose">
${bodyHtml}
    </div>
    ${prevNext(i)}
    <footer class="foot">
      <span>🔬 OAK is developed in the open by the <a href="https://github.com/cell-observatory">Cell Observatory</a></span>
      <a href="${REPO}">Edit on GitHub ↗</a>
    </footer>
  </main>

  ${tocHtml(toc)}
</div>

<div class="kmodal" id="kmodal" hidden>
  <div class="kback" id="kback"></div>
  <div class="kbox" role="dialog" aria-modal="true" aria-label="Search docs">
    <input id="kinput" type="text" placeholder="Search the docs…" autocomplete="off" spellcheck="false">
    <ul id="kresults"></ul>
    <div class="khint"><kbd>↑</kbd><kbd>↓</kbd> to navigate · <kbd>↵</kbd> to open · <kbd>esc</kbd> to close</div>
  </div>
</div>

<script>window.__DOCS_INDEX__=${JSON.stringify(INDEX)};</script>
<script>${JS}</script>
</body>
</html>`;
}

// --- CSS: Orca's three-column layout + Fumadocs component grammar, OAK's coral brand -------------
const CSS = `
:root{
  --bg:#fbfaf9; --bg-2:#f5f3f0; --panel:#ffffff; --card:#f7f5f2; --code-bg:#f1eeea;
  --ink:#17171a; --body:#3b3b42; --muted:#5c5c63; --faint:#8b8a92;
  --accent:#cf6440; --accent-ink:#a94e2c; --accent-soft:rgba(207,100,64,.10);
  --border:rgba(23,23,26,.12); --border-soft:rgba(23,23,26,.07);
  --info:#2f6fd8; --tip:#cf6440; --warn:#b8791f; --sel:rgba(207,100,64,.16);
  --font-head:'Space Grotesk',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  --font-body:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
  --font-mono:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace;
  --nav-h:56px; --side-w:264px; --toc-w:220px; --content-max:720px;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#0e0e11; --bg-2:#0b0b0d; --panel:#111114; --card:#17171b; --code-bg:#1b1b20;
  --ink:#ececef; --body:#c9c8cf; --muted:#a5a4ac; --faint:#76757d;
  --accent:#e08a63; --accent-ink:#ef9f7c; --accent-soft:rgba(224,138,99,.14);
  --border:rgba(255,255,255,.10); --border-soft:rgba(255,255,255,.055);
  --info:#5b9bff; --tip:#e08a63; --warn:#d9a441; --sel:rgba(224,138,99,.22);
}}
:root[data-theme="dark"]{
  --bg:#0e0e11; --bg-2:#0b0b0d; --panel:#111114; --card:#17171b; --code-bg:#1b1b20;
  --ink:#ececef; --body:#c9c8cf; --muted:#a5a4ac; --faint:#76757d;
  --accent:#e08a63; --accent-ink:#ef9f7c; --accent-soft:rgba(224,138,99,.14);
  --border:rgba(255,255,255,.10); --border-soft:rgba(255,255,255,.055);
  --info:#5b9bff; --tip:#e08a63; --warn:#d9a441; --sel:rgba(224,138,99,.22);
}
*{box-sizing:border-box}
html{scroll-behavior:smooth;overflow-x:clip}
body{margin:0;background:var(--bg);color:var(--body);
  font-family:var(--font-body);font-size:15.5px;line-height:1.7;-webkit-font-smoothing:antialiased;
  font-optical-sizing:auto;text-rendering:optimizeLegibility;}
::selection{background:var(--sel)}
a{color:var(--accent);text-decoration:none}
.skip{position:fixed;left:-999px;top:0;z-index:100;background:var(--accent);color:#fff;padding:8px 14px;border-radius:8px}
.skip:focus{left:12px;top:10px}

/* navbar */
.nav{position:sticky;top:0;z-index:40;height:var(--nav-h);background:color-mix(in srgb,var(--bg) 86%,transparent);
  backdrop-filter:saturate(1.4) blur(12px);border-bottom:1px solid var(--border-soft)}
.nav-in{max-width:none;height:100%;display:flex;align-items:center;gap:20px;padding:0 26px}
.brand{display:flex;align-items:center;gap:8px;font-family:var(--font-head);font-weight:700;color:var(--ink);font-size:17px;letter-spacing:-.01em}
.brand .m{filter:saturate(0)}
.brand .ver{font-family:var(--font-mono);font-size:10.5px;font-weight:500;color:var(--faint);letter-spacing:0}
.nav-links{display:flex;gap:4px;margin-left:8px}
.nav-links a{color:var(--muted);font-weight:500;font-size:14px;padding:7px 12px;border-radius:8px}
.nav-links a:hover{color:var(--ink);background:var(--bg-2)}
.nav-links a.on{color:var(--ink)}
.nav-right{margin-left:auto;display:flex;align-items:center;gap:10px}
.kbtn{display:inline-flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--border);
  color:var(--faint);border-radius:9px;padding:6px 9px;font-family:var(--font-body);font-size:13px;cursor:pointer}
.kbtn:hover{border-color:var(--accent)}
.kbtn .kmag{font-size:14px}.kbtn .klabel{margin-right:10px}
kbd{font-family:var(--font-mono);font-size:10.5px;background:var(--bg-2);border:1px solid var(--border);
  border-radius:5px;padding:1px 5px;color:var(--muted)}
.icon-btn{background:none;border:1px solid transparent;color:var(--muted);font-size:16px;cursor:pointer;
  width:34px;height:34px;border-radius:8px;line-height:1}
.icon-btn:hover{background:var(--bg-2);color:var(--ink)}
#sidebtn{display:none}
.ghost{border:1px solid var(--border);color:var(--ink);border-radius:9px;padding:6px 12px;font-size:13.5px;font-weight:500}
.ghost:hover{border-color:var(--accent)}

/* three-column layout */
.docs{max-width:none;display:grid;
  grid-template-columns:var(--side-w) minmax(0,1fr) var(--toc-w);gap:0;align-items:start}
.side{position:sticky;top:var(--nav-h);height:calc(100vh - var(--nav-h));overflow-y:auto;
  padding:22px 14px 60px 22px;border-right:1px solid var(--border-soft)}
.side::-webkit-scrollbar{width:8px}.side::-webkit-scrollbar-thumb{background:var(--border);border-radius:8px}
.side-search{display:flex;align-items:center;gap:8px;width:100%;background:var(--card);border:1px solid var(--border);
  color:var(--faint);border-radius:9px;padding:8px 10px;font:500 13px var(--font-body);cursor:pointer;margin-bottom:18px}
.side-search:hover{border-color:var(--accent)}.side-search kbd{margin-left:auto}
.grp{margin-bottom:16px}
.grp-h{display:block;font-family:var(--font-head);font-weight:600;font-size:12px;letter-spacing:.04em;
  text-transform:uppercase;color:var(--faint);padding:0 8px;margin-bottom:6px}
.side-nav ul{list-style:none;margin:0;padding:0}
.side-nav li a{display:block;color:var(--muted);font-size:13.5px;padding:5.5px 10px;border-radius:7px;
  border-left:2px solid transparent;margin-left:-2px}
.side-nav li a:hover{color:var(--ink);background:var(--bg-2)}
.side-nav li a.on{color:var(--accent-ink);background:var(--accent-soft);border-left-color:var(--accent);font-weight:600}

/* content column */
.content{min-width:0;padding:38px 56px 80px;width:100%}
.crumb{font-family:var(--font-head);font-size:12.5px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;color:var(--accent);margin-bottom:12px}
.content h1{font-family:var(--font-head);font-weight:700;font-size:2.05rem;line-height:1.12;letter-spacing:-.02em;color:var(--ink);margin:0 0 12px}
.deck{font-size:1.12rem;line-height:1.55;color:var(--muted);margin:0 0 8px;font-weight:400}
.prose{margin-top:26px}
.prose>*:first-child{margin-top:0}
.prose p{margin:0 0 18px}
.prose h2{font-family:var(--font-head);font-weight:600;font-size:1.42rem;letter-spacing:-.01em;color:var(--ink);
  margin:44px 0 14px;padding-top:8px;scroll-margin-top:calc(var(--nav-h) + 18px);position:relative}
.prose h3{font-family:var(--font-head);font-weight:600;font-size:1.12rem;color:var(--ink);
  margin:30px 0 10px;scroll-margin-top:calc(var(--nav-h) + 18px);position:relative}
.prose h2+p,.prose h3+p{margin-top:0}
.anchor{position:absolute;left:-22px;width:22px;height:100%;opacity:0}
.anchor::before{content:"#";color:var(--accent);font-weight:500}
.prose h2:hover .anchor,.prose h3:hover .anchor{opacity:1}
.prose a{color:var(--accent);text-decoration:underline;text-underline-offset:2px;text-decoration-color:color-mix(in srgb,var(--accent) 45%,transparent)}
.prose a:hover{text-decoration-color:var(--accent)}
.prose strong{color:var(--ink);font-weight:600}
.prose ul,.prose ol{margin:0 0 18px;padding-left:22px}
.prose li{margin:6px 0}
.prose li::marker{color:var(--faint)}
.prose code{font-family:var(--font-mono);font-size:.86em;background:var(--code-bg);border:1px solid var(--border-soft);
  border-radius:5px;padding:1.5px 5px;color:var(--accent-ink)}
.prose pre{background:var(--code-bg);border:1px solid var(--border);border-radius:11px;padding:16px 18px;
  overflow-x:auto;margin:0 0 20px;line-height:1.6}
.prose pre code{background:none;border:0;padding:0;font-size:13px;color:var(--body)}
.prose blockquote{margin:0 0 18px;padding:2px 0 2px 16px;border-left:3px solid var(--border);color:var(--muted)}
.prose hr{border:0;border-top:1px solid var(--border-soft);margin:32px 0}
.prose img{max-width:100%;border-radius:12px;border:1px solid var(--border);display:block}
.prose figure{margin:26px 0}
.prose figcaption{font-size:12.5px;color:var(--faint);margin-top:9px;text-align:center}
.prose table{width:100%;border-collapse:collapse;margin:0 0 20px;font-size:14px}
.prose th,.prose td{border:1px solid var(--border);padding:8px 12px;text-align:left;vertical-align:top}
.prose th{background:var(--bg-2);font-family:var(--font-head);font-weight:600;color:var(--ink);font-size:13px}
.tbl-wrap{overflow-x:auto;margin:0 0 20px}
.tbl-wrap table{margin:0}
.kbdrow kbd{margin-right:2px}

/* callouts (Fumadocs-style) */
.callout{display:flex;gap:12px;background:var(--card);border:1px solid var(--border);border-left-width:3px;
  border-radius:10px;padding:14px 16px;margin:0 0 20px}
.callout .ico{font-size:16px;line-height:1.5;flex:none}
.callout .ct{margin:0}
.callout .ctitle{font-family:var(--font-head);font-weight:600;color:var(--ink);display:block;margin-bottom:2px}
.callout.tip{border-left-color:var(--tip)}
.callout.info{border-left-color:var(--info)}.callout.info .ico{color:var(--info)}
.callout.warn{border-left-color:var(--warn)}.callout.warn .ico{color:var(--warn)}
.callout p{margin:0}.callout p+p{margin-top:8px}

/* prev / next */
.prevnext{display:flex;gap:14px;margin:48px 0 0;border-top:1px solid var(--border-soft);padding-top:26px}
.pn{flex:1;display:flex;flex-direction:column;gap:5px;border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.pn:hover{border-color:var(--accent);background:var(--bg-2)}
.pn.next{align-items:flex-end;text-align:right}
.pn-d{font-size:12px;color:var(--faint);font-weight:500}
.pn-t{font-family:var(--font-head);font-weight:600;color:var(--ink);font-size:15px}
.pn-sp{flex:1}
.foot{display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-top:40px;padding-top:20px;
  border-top:1px solid var(--border-soft);font-size:12.5px;color:var(--faint)}
.foot a{color:var(--muted)}

/* right TOC */
.toc{position:sticky;top:var(--nav-h);height:calc(100vh - var(--nav-h));overflow-y:auto;padding:38px 20px 60px 6px}
.toc-h{font-family:var(--font-head);font-weight:600;font-size:11.5px;letter-spacing:.05em;text-transform:uppercase;color:var(--faint);margin-bottom:12px}
.toc ul{list-style:none;margin:0;padding:0;border-left:1px solid var(--border-soft)}
.toc li a{display:block;color:var(--faint);font-size:12.75px;line-height:1.4;padding:4.5px 0 4.5px 14px;margin-left:-1px;border-left:2px solid transparent}
.toc li.l3 a{padding-left:26px}
.toc li a:hover{color:var(--ink)}
.toc li a.on{color:var(--accent-ink);border-left-color:var(--accent)}

/* ⌘K modal */
.kmodal{position:fixed;inset:0;z-index:60;display:flex;align-items:flex-start;justify-content:center;padding-top:12vh}
.kmodal[hidden]{display:none}
.kback{position:absolute;inset:0;background:rgba(0,0,0,.5);backdrop-filter:blur(3px)}
.kbox{position:relative;width:min(560px,92vw);background:var(--panel);border:1px solid var(--border);
  border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.4);overflow:hidden}
#kinput{width:100%;border:0;border-bottom:1px solid var(--border-soft);background:none;color:var(--ink);
  font:500 16px var(--font-body);padding:16px 18px;outline:none}
#kresults{list-style:none;margin:0;padding:8px;max-height:52vh;overflow-y:auto}
#kresults li{padding:9px 12px;border-radius:9px;cursor:pointer}
#kresults li .r-t{font-family:var(--font-head);font-weight:600;color:var(--ink);font-size:14px}
#kresults li .r-g{font-size:11.5px;color:var(--accent);margin-left:8px}
#kresults li .r-d{font-size:12.5px;color:var(--muted);margin-top:2px}
#kresults li.sel,#kresults li:hover{background:var(--accent-soft)}
.khint{border-top:1px solid var(--border-soft);padding:9px 14px;font-size:11.5px;color:var(--faint);display:flex;gap:6px;align-items:center}
.khint kbd{font-size:10px}

/* responsive */
@media (max-width:1180px){
  .docs{grid-template-columns:var(--side-w) minmax(0,1fr)}
  .toc{display:none}
}
/* Phones: drop the brand version chip and tighten padding so the sidebar toggle + theme stay on-screen. */
@media (max-width:560px){ .nav-in{padding:0 14px;gap:12px} .brand .ver{display:none} }
@media (max-width:900px){
  .docs{grid-template-columns:1fr}
  #sidebtn{display:inline-flex;align-items:center;justify-content:center}
  .nav-links{display:none}
  .kbtn .klabel,.kbtn kbd{display:none}
  .side{position:fixed;top:var(--nav-h);left:0;width:min(320px,84vw);z-index:45;background:var(--panel);
    border-right:1px solid var(--border);transform:translateX(-102%);transition:transform .18s ease}
  .side.open{transform:none;box-shadow:0 20px 60px rgba(0,0,0,.4)}
  .content{padding:28px 22px 70px}
}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}.side{transition:none}}
`;

// --- client JS: theme toggle, mobile sidebar, ⌘K palette, TOC scrollspy --------------------------
const JS = `
(function(){
  var root=document.documentElement;
  // theme (shared with the marketing site: same localStorage key, defaults to system)
  var KEY='oak-theme';
  try{var s=localStorage.getItem(KEY);if(s)root.setAttribute('data-theme',s);}catch(e){}
  var tbtn=document.getElementById('theme');
  if(tbtn)tbtn.addEventListener('click',function(){
    var cur=root.getAttribute('data-theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');
    var next=cur==='dark'?'light':'dark';root.setAttribute('data-theme',next);
    try{localStorage.setItem(KEY,next);}catch(e){}
  });
  // mobile sidebar
  var side=document.getElementById('side'),sb=document.getElementById('sidebtn');
  if(sb)sb.addEventListener('click',function(){side.classList.toggle('open');});
  document.addEventListener('click',function(e){
    if(side&&side.classList.contains('open')&&!side.contains(e.target)&&!sb.contains(e.target)){side.classList.remove('open');}
  });
  // ⌘K jump palette
  var idx=window.__DOCS_INDEX__||[];
  var modal=document.getElementById('kmodal'),input=document.getElementById('kinput'),
      results=document.getElementById('kresults'),back=document.getElementById('kback');
  var sel=0,cur=[];
  function open(){modal.hidden=false;input.value='';render('');input.focus();}
  function close(){modal.hidden=true;}
  function render(q){
    q=q.trim().toLowerCase();
    cur=idx.filter(function(p){return !q||(p.t+' '+p.g+' '+p.d).toLowerCase().indexOf(q)>=0;}).slice(0,8);
    sel=0;
    results.innerHTML=cur.map(function(p,i){
      return '<li data-i="'+i+'"'+(i===0?' class="sel"':'')+'><div><span class="r-t">'+p.t+'</span><span class="r-g">'+p.g+'</span></div><div class="r-d">'+p.d+'</div></li>';
    }).join('')||'<li class="r-none" style="color:var(--faint);cursor:default">No matches</li>';
  }
  function go(){if(cur[sel])location.href=cur[sel].s+'.html';}
  ['ksearch','ksearch2'].forEach(function(id){var b=document.getElementById(id);if(b)b.addEventListener('click',open);});
  if(back)back.addEventListener('click',close);
  if(input)input.addEventListener('input',function(){render(input.value);});
  document.addEventListener('keydown',function(e){
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();modal.hidden?open():close();return;}
    if(modal.hidden)return;
    if(e.key==='Escape')close();
    else if(e.key==='ArrowDown'){e.preventDefault();sel=Math.min(sel+1,cur.length-1);paintSel();}
    else if(e.key==='ArrowUp'){e.preventDefault();sel=Math.max(sel-1,0);paintSel();}
    else if(e.key==='Enter'){e.preventDefault();go();}
  });
  results.addEventListener('click',function(e){var li=e.target.closest('li[data-i]');if(li){sel=+li.dataset.i;go();}});
  function paintSel(){[].forEach.call(results.children,function(li,i){li.classList.toggle('sel',i===sel);});}
  // TOC scrollspy
  var links=[].slice.call(document.querySelectorAll('.toc a'));
  var heads=links.map(function(a){return document.getElementById(a.getAttribute('href').slice(1));}).filter(Boolean);
  if(heads.length){
    var spy=function(){
      var y=window.scrollY+90,best=0;
      for(var i=0;i<heads.length;i++){if(heads[i].offsetTop<=y)best=i;}
      links.forEach(function(a,i){a.classList.toggle('on',i===best);});
    };
    window.addEventListener('scroll',spy,{passive:true});spy();
  }
})();
`;

// --- build ---------------------------------------------------------------------------------------
let built = 0;
const missing = [];
FLAT.forEach((p, i) => {
  const frag = path.join(CONTENT, `${p.slug}.html`);
  if (!fs.existsSync(frag)) { missing.push(p.slug); return; }
  const raw = fs.readFileSync(frag, 'utf8');
  const { html, toc } = processHeadings(raw);
  fs.writeFileSync(path.join(DOCS, `${p.slug}.html`), page(p, i, html, toc));
  built++;
});
console.log(`built ${built}/${FLAT.length} docs pages`);
if (missing.length) console.log(`  no content fragment yet for: ${missing.join(', ')}`);

// Keep the homepage's ⌘K search index in sync with the nav — showcase.html isn't built from a
// fragment, so it carries its own copy of window.__DOCS_INDEX__ that would otherwise drift.
const showcasePath = path.join(DOCS, 'showcase.html');
if (fs.existsSync(showcasePath)) {
  const before = fs.readFileSync(showcasePath, 'utf8');
  const after = before.replace(/window\.__DOCS_INDEX__=\[[\s\S]*?\];/, `window.__DOCS_INDEX__=${JSON.stringify(INDEX)};`);
  if (after !== before) { fs.writeFileSync(showcasePath, after); console.log('  synced showcase.html __DOCS_INDEX__'); }
}
