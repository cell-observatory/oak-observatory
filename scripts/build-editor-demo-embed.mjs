// Assemble docs/embed-editor-demo.html — the homepage's self-playing editor demo as a STANDALONE page,
// so the docs "Editor extensions" pages can iframe the EXACT same widget (full CSS isolation, no drift).
//
// It copies three verbatim slices out of docs/showcase.html — the <style> block, the #stage markup, and
// the demo IIFE — guarded by marker assertions so a drift in showcase fails loudly instead of silently
// extracting the wrong lines. Re-run whenever the homepage demo changes: node scripts/build-editor-demo-embed.mjs
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const src = fs.readFileSync(path.join(ROOT, 'docs', 'showcase.html'), 'utf8').split('\n');

// Locate the slices by MARKERS, not line numbers, so edits to showcase.html can't silently shift them.
const findLine = (needle, from = 0) => {
  for (let i = from; i < src.length; i++) if (src[i].includes(needle)) return i;
  throw new Error(`marker not found in showcase.html: ${JSON.stringify(needle)}`);
};

// the <style> block
const sStart = findLine('<style>');
const styleBlock = src.slice(sStart, findLine('</style>', sStart + 1) + 1).join('\n');

// the #stage markup — depth-count <section> so the nested panes don't end it early
const mStart = findLine('id="stage"');
let depth = 0, mEnd = -1;
for (let i = mStart; i < src.length; i++) {
  depth += (src[i].match(/<section\b/g) || []).length - (src[i].match(/<\/section>/g) || []).length;
  if (depth === 0) { mEnd = i; break; }
}
if (mEnd < 0) throw new Error('#stage <section> never closes in showcase.html');
let markup = src.slice(mStart, mEnd + 1).join('\n');

// the demo IIFE — from its comment banner to the last `})();` before the enclosing </script>
const jStart = findLine('the detailed scripted demo');
let jEnd = findLine('</script>', jStart) - 1;
while (jEnd > jStart && !src[jEnd].includes('})();')) jEnd--;
if (!src[jEnd].includes('})();')) throw new Error('demo IIFE close `})();` not found before </script>');
const demoJs = src.slice(jStart, jEnd + 1).join('\n');

// standalone: the .ide's homepage click-through has no place here
markup = markup.replace(` onclick="location.href='editors.html'" style="cursor:pointer"`, '');

const fonts = src.filter((l) => l.includes('fonts.googleapis') || l.includes('preconnect')).join('\n');

const out = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OAK editor demo</title>
${fonts}
${styleBlock}
<style>
  /* embed overrides: fill the iframe, blend into the host docs page, kill homepage chrome spacing */
  html,body{margin:0;background:transparent}
  #stage{padding:0!important;z-index:auto!important}
  .wrap.wide{max-width:none;margin:0;padding:10px 14px 16px}
  .ide{cursor:default!important;margin-top:14px}
  .rv,.stagger>*{opacity:1!important;transform:none!important}
  /* The homepage collapses the IDE's side rails below 900px; the docs content column is ~780px, so
     keep all three rails down to there and only collapse on a genuinely narrow viewport. */
  @media (max-width:900px){ .ide-top{grid-template-columns:1fr 2fr 2fr} .ide-top .side{display:flex} }
  @media (max-width:660px){ .ide-top{grid-template-columns:1fr} .ide-top .side{display:none} }
</style>
</head>
<body class="embed-demo">
${markup}
<script>
${demoJs}
</script>
<script>
  // theme sync + auto-height: the host docs page drives the theme and reads our height back.
  (function(){
    var root=document.documentElement;
    function setTheme(t){ if(t==='dark'||t==='light') root.dataset.theme=t; else delete root.dataset.theme; }
    var m=(location.hash.match(/theme=(dark|light|system)/)||[])[1]; if(m) setTheme(m);
    addEventListener('message',function(e){ if(e.data&&e.data.oakTheme) setTheme(e.data.oakTheme); });
    var last=0;
    function report(){ var h=Math.ceil(document.body.getBoundingClientRect().height); if(h&&h!==last){ last=h; parent.postMessage({oakDemoHeight:h},'*'); } }
    if('ResizeObserver'in window) new ResizeObserver(report).observe(document.body);
    addEventListener('load',report); setInterval(report,500); report();
  })();
</script>
</body></html>
`;

const outPath = path.join(ROOT, 'docs', 'embed-editor-demo.html');
fs.writeFileSync(outPath, out);
console.log(`✓ docs/embed-editor-demo.html — ${(out.length / 1024).toFixed(0)} KB (style ${styleBlock.length}b, markup ${markup.length}b, js ${demoJs.length}b)`);
