// ANSI → HTML for the TUI recordings — the product's own truecolor palette, used verbatim.
//
// Shared by scripts/build-tui-shots.mjs (the docs PNGs) and scripts/build-tui-demo.mjs (the homepage
// interactive player), so the same terminal frame renders identically on both. It lived as two copies
// that had already drifted (dim opacity, reverse-video colors) — one source now.
const SGR = { 30: '#101010', 31: '#e5534b', 32: '#3fb950', 33: '#d9a441', 34: '#4c8bf5', 35: '#9a6ac2', 36: '#39c5cf', 37: '#cccccc' };

function xterm256(n) {
  if (n < 16) return SGR[30 + (n % 8)] || '#ccc';
  if (n < 232) {
    const i = n - 16, s = (v) => (v === 0 ? 0 : 55 + v * 40), r = s(Math.floor(i / 36)), g = s(Math.floor(i / 6) % 6), b = s(i % 6);
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  const v = (8 + (n - 232) * 10).toString(16).padStart(2, '0');
  return '#' + v + v + v;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function ansiToHtml(line) {
  // STATEFUL: SGR is a state machine, not a stack. `39`/`49` restore the default colour, `22` ends
  // bold AND dim, `27` ends inverse — the old converter ignored all four, so a cyan `oak demo --tour`
  // kept the rest of its sentence cyan and the active tab's inverse never ended (docs sweep).
  const st = { fg: null, bg: null, bold: false, dim: false, inverse: false };
  const style = () => {
    const parts = [];
    let fg = st.fg, bg = st.bg;
    if (st.inverse) { fg = st.bg ?? '#0d0d10'; bg = st.fg ?? '#c9cdd3'; }
    if (fg) parts.push(`color:${fg}`);
    if (bg) parts.push(`background:${bg}`);
    if (st.bold) parts.push('font-weight:700');
    if (st.dim) parts.push('opacity:.62');
    return parts.join(';');
  };
  let out = '', open = false, last = 0, m; const re = /\x1b\[([0-9;]*)m/g;
  const reopen = () => { if (open) { out += '</span>'; open = false; } const css = style(); if (css) { out += `<span style="${css}">`; open = true; } };
  while ((m = re.exec(line))) {
    out += esc(line.slice(last, m.index)); last = m.index + m[0].length;
    const codes = m[1].split(';').filter(Boolean).map(Number);
    if (!codes.length) codes.push(0);
    for (let k = 0; k < codes.length; k++) {
      const c = codes[k];
      if (c === 0) { st.fg = null; st.bg = null; st.bold = false; st.dim = false; st.inverse = false; }
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 7) st.inverse = true;
      else if (c === 22) { st.bold = false; st.dim = false; }
      else if (c === 27) st.inverse = false;
      else if (c === 39) st.fg = null;
      else if (c === 49) st.bg = null;
      else if (c === 38 && codes[k + 1] === 2) { st.fg = `rgb(${codes[k + 2] | 0},${codes[k + 3] | 0},${codes[k + 4] | 0})`; k += 4; }
      else if (c === 38 && codes[k + 1] === 5) { st.fg = xterm256(codes[k + 2] | 0); k += 2; }
      else if (c === 48 && codes[k + 1] === 2) { st.bg = `rgb(${codes[k + 2] | 0},${codes[k + 3] | 0},${codes[k + 4] | 0})`; k += 4; }
      else if (c === 48 && codes[k + 1] === 5) { st.bg = xterm256(codes[k + 2] | 0); k += 2; }
      else if (SGR[c]) st.fg = SGR[c];
      else if (c >= 40 && c <= 47 && SGR[c - 10]) st.bg = SGR[c - 10];
      else if (c >= 100 && c <= 107 && SGR[c - 10]) st.bg = SGR[c - 10];
    }
    reopen();
  }
  out += esc(line.slice(last));
  if (open) out += '</span>';
  return out;
}

/** A whole frame (trailing newline trimmed) as HTML, one converted line per row. */
export const frameHtml = (f) => f.replace(/\n$/, '').split('\n').map(ansiToHtml).join('\n');
export { SGR, xterm256, ansiToHtml };
