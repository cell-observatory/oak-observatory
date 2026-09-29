// Generate packages/vscode/src/codicon.ts — the codicon webview font embedded as a base64 data-URI,
// plus the glyph classes the Overview navbar uses. Self-contained (data: URI) so the webview needs no
// localResourceRoots — only `font-src data:` in the CSP. Regenerate after bumping @vscode/codicons.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const ttf = fs.readFileSync(path.join(root, 'node_modules/@vscode/codicons/dist/codicon.ttf'));
const b64 = ttf.toString('base64');

// glyph name -> PUA codepoint (from node_modules/@vscode/codicons/dist/codicon.css)
const glyphs = {
  'chevron-left': 'eab5', 'chevron-right': 'eab6', 'chevron-up': 'eab7', 'chevron-down': 'eab4',
  'check': 'eab2', 'discard': 'eae2', 'check-all': 'ebb1', 'close-all': 'eac1', 'clear-all': 'eabf',
  'close': 'ea76', // undo/reject one edit — the ✗ of the standard vocabulary (✓ accept · ✗ reject · ↺ redo)
  'lightbulb': 'ea61', 'search': 'ea6d', 'refresh': 'eb37',
  'checklist': 'eab3', 'comment-discussion': 'eac7',
  'list-ordered': 'eb16', // Prompt axis Review: step through one prompt's edits in order
  'diff': 'eae1', // nav bar: open the current edit as a full diff tab
  'export': 'ebac', // nav bar: export a shareable review summary
  'folder-opened': 'eaf7', // Overview toolbar: open this session's store folder on disk (beside Export)
  'cloud-download': 'eac2', // version dropdown: Update now
  'debug-step-back': 'eb8f', // Prompt axis Rewind: revert this ask and everything after it
  'split-horizontal': 'eb56', // left-nav toggle: pair related sections side by side
  'settings-gear': 'eb51', // Overview controls: open this extension's settings, beside the version chip
  'filter': 'eaf1', // Overview toolbar: the filter menu (regex / file type / extension)
  'filter-filled': 'ebce', // …the same button when a filter is active
  'sort-precedence': 'eb55', // Overview toolbar: cycle the sort order (time / name)
};

let rules = '';
for (const [name, code] of Object.entries(glyphs)) {
  rules += '.codicon-' + name + ':before{content:"\\' + code + '"}';
}

const css =
  '@font-face{font-family:"codicon";src:url(data:font/ttf;base64,' + b64 + ') format("truetype")}' +
  '.codicon{font:normal normal normal 15px/1 codicon;display:inline-block;text-align:center;' +
  'text-decoration:none;text-rendering:auto;-webkit-font-smoothing:antialiased;' +
  '-moz-osx-font-smoothing:grayscale;user-select:none;vertical-align:middle}' +
  rules;

const header = [
  '// AUTO-GENERATED from @vscode/codicons by scripts/gen-codicon.js — do not edit by hand.',
  '// The codicon webview font (base64 data-URI) + the glyph classes the Overview navbar uses.',
  '// Self-contained: no localResourceRoots needed, only `font-src data:` in the webview CSP.',
  'export const CODICON_STYLE = ' + JSON.stringify(css) + ';',
  '',
].join('\n');

fs.writeFileSync(path.join(root, 'packages/vscode/src/codicon.ts'), header);
console.log('wrote packages/vscode/src/codicon.ts —', (header.length / 1024).toFixed(0) + 'KB,', Object.keys(glyphs).length, 'glyphs');
