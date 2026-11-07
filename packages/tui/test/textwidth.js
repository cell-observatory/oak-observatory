const { test } = require('node:test');
const assert = require('node:assert/strict');
const { wrapVisible, stripSgr, displayWidth } = require('../dist/textwidth');

test('wrapVisible bounds SGR replay for dense colored words', () => {
  for (const n of [8000, 20000]) for (const reset of ['', '\x1b[0m', '\x1b[m']) {
    const input = Array.from({ length: n }, (_, i) => i % 9 ? 'X' : '\x1b[38;5;208mX' + reset).join('');
    const output = wrapVisible(input, 80).join('\n');
    assert.ok(output.length <= input.length * 2, String({ input: input.length, output: output.length }));
    assert.equal(stripSgr(output).replace(/\n/g, ''), 'X'.repeat(n));
  }
});

// A deterministic terminal-state model, adapted from a repeat/drop fuzz harness.
function styled(rows) {
  const result = [], state = {};
  for (const row of rows) {
    const tokens = row.match(/\x1b\[[0-9;:]*m|[\s\S]/gu) || [];
    for (const token of tokens) {
      if (!token.startsWith('\x1b[')) { if (token !== ' ') result.push([token, Object.entries(state).sort()]); continue; }
      const params = token.slice(2, -1).split(/[;:]/).map(Number);
      for (let i = 0; i < params.length; i++) {
        const p = params[i];
        if (!p) { for (const key of Object.keys(state)) delete state[key]; }
        else if (p === 1 || p === 2) state[p] = true;
        else if (p === 22) { delete state[1]; delete state[2]; }
        else if (p === 3) state.italic = true;
        else if (p === 23) delete state.italic;
        else if (p === 4) state.underline = true;
        else if (p === 24) delete state.underline;
        else if (p === 39) delete state.fg;
        else if (p === 49) delete state.bg;
        else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) state.fg = String(p);
        else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) state.bg = String(p);
        else if (p === 38 || p === 48) {
          const count = params[i + 1] === 2 ? 4 : 2;
          state[p === 38 ? 'fg' : 'bg'] = params.slice(i, i + count + 1).join(';'); i += count;
        }
      }
    }
  }
  return result;
}

test('wrapVisible fuzz preserves every visible character, width and SGR state', () => {
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const choose = a => a[Math.floor(rnd() * a.length)];
  const sgr = ['\x1b[1m', '\x1b[2m', '\x1b[22m', '\x1b[3m', '\x1b[23m', '\x1b[31m', '\x1b[39m', '\x1b[44m', '\x1b[49m', '\x1b[0m', '\x1b[m', '\x1b[38;5;208m', '\x1b[48;2;3;4;5m', '\x1b[1;31m', '\x1b[4m', '\x1b[24m'];
  for (let n = 0; n < 20000; n++) {
    let input = '';
    for (let j = 0; j < 40; j++) input += rnd() < .3 ? choose(sgr) : choose(['a', ' ', '字', '😀', 'é', '\u0301', 'xxxxx']);
    const cols = 1 + Math.floor(rnd() * 12), rows = wrapVisible(input, cols);
    assert.equal(rows.map(stripSgr).join('').replace(/ /g, ''), stripSgr(input).replace(/ /g, ''));
    for (const row of rows) assert.ok(displayWidth(row) <= cols || (cols === 1 && [...stripSgr(row)].filter(c => displayWidth(c) > 0).length === 1));
    assert.deepEqual(styled(rows), styled([input]), 'case ' + n + ': ' + JSON.stringify(input));
  }
});

// C1 controls are escapes too: U+009B is a one-character CSI that xterm.js and other terminals act on, so
// untrusted text (a model's output, a path, a remote title) could erase or overwrite what OAK draws.
test('sanitizeCell drops C1 control characters as well as C0 and DEL', () => {
  const { sanitizeCell } = require('../dist/textwidth');
  const out = sanitizeCell('safe.txt\u009b2K\u009b1GFAKE\u009dtitle\u009c\u0085');
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(out), false, JSON.stringify(out));
  assert.ok(out.startsWith('safe.txt') && out.includes('FAKE'));
  assert.equal(sanitizeCell('\x1b[31mred\x1b[0m é ✓'), '\x1b[31mred\x1b[0m é ✓', 'colour and ordinary text pass unchanged');
});

// Text from outside (a session's title, a label someone typed, a pane's title) can carry bidirectional controls, which
// reorder the text around them, the rest of the row included, in a terminal that lays out right-to-left text, and
// zero-width characters, which hide in it. This measure gave most of them a column the terminal does not draw. The
// joiner (U+200D) an emoji family or an Indic letter is built with stays: it reorders nothing and measures nothing.
test('sanitizeCell drops bidi controls and zero-width characters, and keeps the joiner emoji sequences need', () => {
  const { sanitizeCell, displayWidth } = require('../dist/textwidth');
  const hidden = '\u061c\u200b\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\ufeff';
  assert.equal(sanitizeCell(`Fix${hidden} the${hidden} demo`), 'Fix the demo');
  assert.equal(sanitizeCell(`\x1b[31m\u202ered${hidden}\x1b[0m done`), '\x1b[31mred\x1b[0m done', 'colour passes, around them');
  assert.equal(displayWidth(sanitizeCell('a\u200eb\u2066c\u2069')), 3, 'measured as the terminal draws it');
  // An emoji family, a flag, one with a skin tone, one with a presentation selector: each keeps its joiners, whole.
  for (const emoji of ['\u{1F468}\u200d\u{1F469}\u200d\u{1F467}', '\u{1F3F3}\ufe0f\u200d\u{1F308}', '\u{1F469}\u{1F3FD}\u200d\u{1F4BB}', '\u2764\ufe0f\u200d\u{1F525}']) {
    assert.equal(sanitizeCell(`team ${emoji} ok`), `team ${emoji} ok`, `${JSON.stringify(emoji)} stays whole`);
  }
  assert.equal(sanitizeCell('\u0915\u094d\u200d\u0937'), '\u0915\u094d\u200d\u0937', 'an Indic half form keeps its joiner');
  // The zero-width non-joiner stays as well: Persian words are written with it.
  assert.equal(sanitizeCell('\u06a9\u062a\u0627\u0628\u200c\u0647\u0627'), '\u06a9\u062a\u0627\u0628\u200c\u0647\u0627');
});

test('sanitizeText keeps line breaks and tabs, and filters everything else as a cell', () => {
  const { sanitizeText } = require('../dist/textwidth');
  const out = sanitizeText('a\x1b]0;PWNED\x07b\x1b]52;c;ZXZpbA==\x1b\\c\x1b[2J\x1b[1;1Hd\u009b31me\rf\x07\n\tg\r\nh');
  assert.equal(out, 'abcd 31me f \n\tg\r\nh', JSON.stringify(out));
  assert.equal(sanitizeText('\x1b[1mbold\x1b[0m\n'), '\x1b[1mbold\x1b[0m\n', 'colour passes');
});

// A combining accent has no width of its own: it belongs to the letter before it. A span that ended on that letter copied
// `café` (written with U+0301) as `cafe` (2026-10-13).
test('sliceSpan keeps a combining mark with the character it follows, at the span\'s end too', () => {
  const { sliceSpan } = require('../dist/textwidth');
  const cafe = 'café au lait';
  assert.equal(sliceSpan([cafe], { row: 0, col: 0 }, { row: 0, col: 3 }), 'café');
  assert.equal(sliceSpan([cafe], { row: 0, col: 3 }, { row: 0, col: 3 }), 'é');
  assert.equal(sliceSpan([cafe], { row: 0, col: 4 }, { row: 0, col: 6 }), ' au', 'a mark whose letter is not selected stays out');
  assert.equal(sliceSpan(['字́x'], { row: 0, col: 0 }, { row: 0, col: 1 }), '字́', 'after a wide character too');
  assert.equal(sliceSpan([cafe, 'next'], { row: 0, col: 2 }, { row: 1, col: 1 }), 'fé au lait\nne');
  // An emoji joined to others is one character: a span over any of its cells takes all of it, joiners included. A span
  // that ended inside it copied part of the family, and a joiner that joined whatever was pasted after it (2026-10-13).
  const family = 'ab\u{1F468}\u200d\u{1F469}\u200d\u{1F467}cd';
  assert.equal(sliceSpan([family], { row: 0, col: 0 }, { row: 0, col: 2 }), 'ab\u{1F468}\u200d\u{1F469}\u200d\u{1F467}');
  assert.equal(sliceSpan([family], { row: 0, col: 0 }, { row: 0, col: 5 }), 'ab\u{1F468}\u200d\u{1F469}\u200d\u{1F467}');
  assert.equal(sliceSpan([family], { row: 0, col: 0 }, { row: 0, col: 1 }), 'ab', 'a span that ends before it leaves it out whole');
  assert.equal(sliceSpan([family], { row: 0, col: 0 }, { row: 0, col: 9 }), family, 'whole, it keeps every joiner');
  assert.equal(sliceSpan(['\u2764\ufe0f ok'], { row: 0, col: 0 }, { row: 0, col: 0 }), '\u2764\ufe0f', 'a variation selector still comes along');
});

// The session picker and the pinned ask showed a family emoji cut mid-sequence (`\ud83d\udc68\u200d\ud83d\udc69\u200d\ufffd\u2026`). Every width cut in the terminal app
// ends where a character does: never inside a sequence joined by zero-width joiners, a flag's pair of regional indicators,
// an emoji and its skin tone, a keycap, or a letter and its combining marks. Checked at every width, with colour around it.
test('every width cut ends where a character does: emoji families, flags, skin tones, keycaps and combining marks, at every width', () => {
  const { fitVisible, wrapVisible, sliceVisible, sliceSpan, reverseVisibleSpan } = require('../dist/textwidth');
  const { graphemes } = require('../../core/dist/graphemes');
  // `piece` is a run of whole characters of `text`.
  const whole = (piece, text) => {
    const p = graphemes(piece), all = graphemes(text);
    for (let i = 0; i + p.length <= all.length; i++) if (p.every((c, k) => c === all[i + k])) return true;
    return false;
  };
  for (const ch of ['\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}', '\u{1F1EF}\u{1F1F5}', '\u{1F44D}\u{1F3FD}', '\u{1F469}\u{1F3FD}\u200d\u{1F4BB}', '1\ufe0f\u20e3', 'e\u0301\u0302', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}']) {
    for (const s of [`ab${ch}cd${ch}`, `\x1b[31mab\x1b[0m${ch}\x1b[32mcd\x1b[0m${ch}`]) {
      const plain = stripSgr(s), w = displayWidth(s);
      for (let c = 0; c <= w + 1; c++) {
        const fit = stripSgr(fitVisible(s, c)).trimEnd();
        assert.ok(plain.startsWith(fit) && whole(fit, plain), `fitVisible(${JSON.stringify(s)}, ${c}) = ${JSON.stringify(fit)}`);
        const rows = wrapVisible(s, Math.max(1, c)).map(stripSgr);
        assert.equal(rows.join(''), plain, `wrapVisible keeps every character at ${c}`);
        assert.ok(rows.every((r) => whole(r, plain)), `wrapVisible(${JSON.stringify(s)}, ${c}) = ${JSON.stringify(rows)}`);
        for (let from = 0; from <= w; from++) {
          const slice = sliceVisible(plain, from, c);
          assert.ok(whole(slice, plain), `sliceVisible(${JSON.stringify(plain)}, ${from}, ${c}) = ${JSON.stringify(slice)}`);
          const span = sliceSpan([plain], { row: 0, col: from }, { row: 0, col: from + c });
          assert.ok(whole(span, plain), `sliceSpan(${JSON.stringify(plain)}) from ${from} to ${from + c} = ${JSON.stringify(span)}`);
          const band = reverseVisibleSpan(s, from, from + c);
          assert.ok(band.split(/\x1b\[[0-9;:]*m/).every((part) => whole(part, plain)), `the band from ${from} to ${from + c} opens or closes inside a character: ${JSON.stringify(band)}`);
        }
      }
    }
  }
  // fitVisible keeps the longest run of whole characters that fits, then pads: exactly, on texts drawn from joiners,
  // marks, selectors, regional indicators, controls, lone surrogates and the characters around them. A colour escape
  // ends a character, as it ends the run of text a terminal draws.
  const pool = ['a', '\x7f', '\x85', '\u0301', '\u200d', '\ufe0f', '\u20e3', '1', '\u{1F468}', '\u{1F469}', '\u{1F3FD}', '\u{1F1EF}', '\u{1F1F5}', '\u2502', '\u6f22',
    '\u{E0067}', '\u{E007F}', '\ud83d', '\x1b[31m', '\x1b[0m'];
  let seed = 3;
  const rand = (n) => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % n; };
  for (let n = 0; n < 3000; n++) {
    let s = '';
    for (let k = 1 + rand(10); k > 0; k--) s += pool[rand(pool.length)];
    const chars = s.split(/(\x1b\[[0-9;:]*m)/).flatMap((part, i) => (i % 2 ? [] : graphemes(part)));
    for (let c = 1; c <= 12; c++) { // at 0 columns it is '' (fitVisible's contract)
      let head = '', w = 0;
      for (const ch of chars) { if (w + displayWidth(ch) > c) break; head += ch; w += displayWidth(ch); }
      assert.equal(stripSgr(fitVisible(s, c)), head + ' '.repeat(c - w), `fitVisible(${JSON.stringify(s)}, ${c})`);
    }
  }
});

// A joiner between two letters joins neither, as in UAX #29: a word with one between each of its letters wraps and fits
// a letter at a time. When a joiner joined whatever followed it, the word was one character wider than the row, which the
// pane's fit then left out whole: the row showed nothing of it.
test('a word with a joiner between its letters wraps and fits a letter at a time', () => {
  const { fitVisible } = require('../dist/textwidth');
  const word = Array.from('curl_evil.sh|sh').join('\u200d');
  const rows = wrapVisible(`ok then ${word} done`, 10);
  assert.ok(rows.every((r) => displayWidth(r) <= 10), `every row fits: ${JSON.stringify(rows)}`);
  assert.ok(rows.join('').replace(/\u200d/g, '').includes('curl_evil.sh|sh'), `every letter is on a row: ${JSON.stringify(rows)}`);
  assert.equal(fitVisible(word, 10).replace(/\u200d/g, ''), 'curl_evil.');
});

// Colour written with colons (`ESC[4:3m`, `ESC[38:2::255:0:0m`) passes into a frame as colour does (sanitizeCell); the
// band measured its bytes as text, so the band and the copy fell out of step after it (2026-10-13).
test('reverseVisibleSpan reads colour written with colons as colour', () => {
  const { reverseVisibleSpan } = require('../dist/textwidth');
  assert.equal(reverseVisibleSpan('ab\x1b[4:3mcd\x1b[0mef', 2, 3), 'ab\x1b[4:3m\x1b[7mcd\x1b[0m\x1b[7m\x1b[27mef');
  assert.equal(reverseVisibleSpan('ab\x1b[38:2::255:0:0mcd', 0, 1), '\x1b[7mab\x1b[38:2::255:0:0m\x1b[7m\x1b[27mcd');
});

// The status row cuts its text at the terminal's edge, and a selection from that text to the edge takes the whole
// status. A toast took that rule too: a selection of a toast beside a cut status, or of a toast covering the row,
// copied the status nobody could see (2026-10-13).
test('selectedText: a selection from the status the row shows to its edge takes the whole status; a toast is copied as shown', () => {
  const { selectedText } = require('../dist/textwidth');
  const cols = 30, first = 1, status = 'herdr review tokens: pane w1:p3 not found';
  const frame = (row) => ['body text', row.padEnd(cols), 'usage line'];
  const span = (rows, a, b, bottom = { first, status }) => selectedText(rows, a, b, undefined, bottom, cols);
  const cut = frame(status.slice(0, cols));
  assert.equal(span(cut, { row: 1, col: 0 }, { row: 1, col: cols - 1 }), status, 'from its start to the edge: the whole status');
  assert.equal(span(cut, { row: 1, col: cols - 1 }, { row: 1, col: 6 }), status.slice(6), 'either way round');
  assert.equal(span(cut, { row: 1, col: 6 }, { row: 2, col: 4 }), `${status.slice(6)}\nusage`, 'and on past the row');
  assert.equal(span(cut, { row: 1, col: 0 }, { row: 1, col: 4 }), 'herdr', 'short of the edge: what was selected');
  assert.equal(span(cut, { row: 0, col: 0 }, { row: 1, col: cols - 1 }), `body text\n${status}`, 'from the row above');
  // A toast beside the cut status: from the status to the edge, the whole status; from the toast, the toast.
  const toast = 'copied 5 chars';
  const beside = frame(`${status.slice(0, cols - toast.length - 2)}  ${toast}`);
  assert.equal(span(beside, { row: 1, col: 0 }, { row: 1, col: cols - 1 }), status);
  assert.equal(span(beside, { row: 1, col: cols - toast.length }, { row: 1, col: cols - 1 }), toast);
  // A toast covering the row: no status shows, and none is copied, from that row or from above it.
  const covered = frame('copied 41 chars to clipboard');
  assert.equal(span(covered, { row: 1, col: 0 }, { row: 1, col: cols - 1 }), 'copied 41 chars to clipboard');
  assert.equal(span(covered, { row: 0, col: 0 }, { row: 1, col: cols - 1 }), 'body text\ncopied 41 chars to clipboard');
  // A status the row shows whole, a toast beside it: the selection is what the row shows.
  const short = 'refreshed';
  const whole = frame(`${short}${' '.repeat(cols - short.length - toast.length)}${toast}`);
  assert.equal(span(whole, { row: 1, col: 0 }, { row: 1, col: cols - 1 }, { first, status: short }), whole[1].trimEnd());
  assert.equal(span(cut, { row: 1, col: 0 }, { row: 1, col: cols - 1 }, null), status.slice(0, cols), 'no bottom rows, no rule');
});

// The copy's toast counted UTF-16 units and said `copied 1 chars`, then each part of an emoji built from several (a
// family counted 5, its joiners included). Intl.Segmenter is no help: on a Node built with
// small-icu and no full ICU data (Fedora's and RHEL's without nodejs-full-i18n) it exists, and its `segment` ends the
// process (SIGSEGV), so a copy's toast or ctrl+v crashed the app (2026-10-13). Here it throws if anything touches it.
test('charCount counts characters as a reader does, with the word for one or many, and no Intl.Segmenter', () => {
  const file = require.resolve('../dist/textwidth');
  const { Segmenter } = Intl;
  Intl.Segmenter = function () { throw new Error('Intl.Segmenter was used'); };
  delete require.cache[file];
  try {
    const { charCount } = require('../dist/textwidth');
    assert.equal(charCount('x'), '1 char');
    assert.equal(charCount('café'), '4 chars', 'a letter and its accent are one');
    assert.equal(charCount('😀'), '1 char', 'an emoji is one, not two UTF-16 units');
    assert.equal(charCount('ab\ncd'), '5 chars', 'a line break is one');
    assert.equal(charCount('ab\r\ncd'), '5 chars', 'and so is a CRLF one, as Intl.Segmenter counted it');
    assert.equal(charCount('\u0301x'), '2 chars', 'an accent with no letter before it is one');
    // An emoji built from several is one character, as every cut keeps it: it counted each of its parts.
    for (const emoji of ['\u{1F468}\u200d\u{1F469}\u200d\u{1F467}', '\u{1F1EF}\u{1F1F5}', '\u{1F44B}\u{1F3FD}', '\u{1F3F3}\ufe0f\u200d\u{1F308}'])
      assert.equal(charCount(`a${emoji}b`), '3 chars', `${JSON.stringify(emoji)} is one`);
    assert.equal(charCount('a\u200db'), '2 chars', 'a joiner between two letters joins neither: the a keeps it, the b is its own');
  } finally {
    Intl.Segmenter = Segmenter;
    delete require.cache[file];
  }
});

// CodeQL js/polynomial-redos alert 33: `/\s+$/` retried the end-of-line test from every blank of a long
// run (7 s for a 100k-cell row); trimEnd is linear. The bound is far from both, so it cannot flake.
test('sliceSpan trims a row\'s trailing blanks in linear time', () => {
  const { sliceSpan } = require('../dist/textwidth');
  const row = ' '.repeat(100_000) + 'x';
  const began = process.hrtime.bigint();
  const got = sliceSpan([row + '   '], { row: 0, col: 0 }, { row: 0, col: 200_000 });
  const ms = Number(process.hrtime.bigint() - began) / 1e6;
  assert.equal(got, row, 'the trailing blanks go, the leading ones stay');
  assert.ok(ms < 500, `sliceSpan must stay linear (took ${ms.toFixed(1)} ms)`);
});

// The wraps and cuts the terminal app makes outside textwidth: a diff line broken at the pane's width, a long name broken
// across a Map row and its continuation, and the sort and filter readout set into the Map's toolbar before its buttons.
test('the diff, a Map name and the Map toolbar\'s readout break a character whole', () => {
  const tui = require('../dist');
  const fam = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}';
  // Half a surrogate pair, or some of the family's members without the rest.
  const cutInside = (t) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(t) || (/[\u{1F466}-\u{1F469}]/u.test(t) && !t.includes(fam));
  for (let k = 8; k <= 24; k++) {
    const patch = ['--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@', `-${'a'.repeat(k)}${fam}tail`, `+${'b'.repeat(k)}${fam}tail`].join('\n');
    for (const cols of [24, 30, 36]) {
      const rows = tui.renderRichDiff(patch, { cols, color: 'none', header: false }).map(stripSgr);
      assert.ok(rows.every((r) => !cutInside(r)), `the diff at ${cols} columns, the family at ${k}: ${JSON.stringify(rows)}`);
      assert.equal(rows.filter((r) => r.includes(fam)).length, 2, 'both lines still show it');
    }
    const tree = tui.buildMapTree([{ rel: `${'n'.repeat(k)}${fam}.ts`, file: `${'n'.repeat(k)}${fam}.ts`, cnt: 1, added: 1, removed: 0, pending: 1, kept: 0, undone: 0, risk: 0 }]);
    for (const cols of [40, 50, 60]) {
      const painted = tui.mapRows(tree, new Set()).flatMap((r) => tui.renderMapRow(r, cols, tui.glyphs('ascii'), 'none'));
      assert.ok(painted.every((l) => !cutInside(l)) && painted.some((l) => l.includes(fam)), `a Map name at ${cols} columns, the family at ${k}: ${JSON.stringify(painted)}`);
    }
  }
  // The readout is measured in columns, so a wide character in a typed filter cannot push the buttons off their places.
  const tree = tui.buildMapTree([{ rel: 'a.ts', file: 'a.ts', cnt: 1, added: 1, removed: 0, pending: 1, kept: 0, undone: 0, risk: 0 }]);
  for (const filter of [`ab${fam}${fam}cd`, '漢字テスト漢字テスト']) {
    for (let cols = 60; cols <= 110; cols++) {
      const line = stripSgr(tui.renderMapToolbar(tree, cols, 'none', true, 'time', filter));
      assert.ok(!cutInside(line), `the readout at ${cols} columns: ${JSON.stringify(line)}`);
      for (const b of tui.mapToolbar(tree, cols)) assert.equal(tui.sliceVisible(line, b.x, b.w), b.label, `at ${cols} columns, ${b.action} is drawn where it is pressed`);
    }
  }
});

// The zero-width non-joiner is part of how Persian and Indic text is written: a file name with one, printed without it
// by `oak list` or drawn without it in the Traces pane, named no file when it was copied. It reorders nothing.
test('sanitizeCell keeps the zero-width non-joiner, and measures it as nothing', () => {
  const { sanitizeCell, displayWidth } = require('../dist/textwidth');
  const persian = 'کتاب\u200cها.txt';
  assert.equal(sanitizeCell(persian), persian);
  assert.equal(displayWidth(persian), 10);
  assert.equal(sanitizeCell('क्\u200cष'), 'क्\u200cष', 'an Indic half form held apart keeps its non-joiner');
  assert.equal(require(require('node:path').join(__dirname, '..', '..', 'core', 'dist', 'index.js')).plainLabel(`lab ${persian}`), `lab ${persian}`, 'so does a saved machine\'s label');
});

// A Trojan Source line: a right-to-left override and isolates make a check read as part of a comment, and a zero-width
// space hides in a name. The frame drops them from every cell (sanitizeCell), which is right for a title, and hid them
// in a diff, where the line then reads differently from how it runs. The diff shows each as a dim mark that names it.
test('a hidden character in a diff shows as a dim mark that names it, and a title still drops it', () => {
  const tui = require('../dist');
  const { sanitizeCell } = require('../dist/textwidth');
  const evil = '    /*\u202e } \u2066if (isAdmin)\u2069 \u2066 begin admins only */';
  const patch = ['--- a/x.js', '+++ b/x.js', '@@ -1,2 +1,2 @@', ' const a = 1;', '-    /* } if (isAdmin)  begin admins only */', `+${evil}`, ' zw\u200bsp = "a\u200bb"; // bom\ufeff'].join('\n');
  const marks = ['⟨U+202E⟩', '⟨U+2066⟩', '⟨U+2069⟩', '⟨U+2066⟩', '⟨U+200B⟩', '⟨U+200B⟩', '⟨U+FEFF⟩'];
  for (const color of ['none', '16', '256', 'truecolor']) for (const syntax of [false, true]) for (const cols of [30, 44, 120]) {
    // As the frame draws them: each row through sanitizeCell.
    const rows = tui.renderRichDiff(patch, { cols, color, syntax, header: false }).map(sanitizeCell);
    const what = `${color}, syntax ${syntax}, ${cols} columns: ${JSON.stringify(rows.map(stripSgr))}`;
    assert.deepEqual(rows.map(stripSgr).join('').match(/⟨U\+[0-9A-F]{4}⟩/g), marks, `every hidden character shows, whole, in order (${what})`);
    assert.ok(rows.every((r) => displayWidth(r) <= cols), `each row fits (${what})`);
    // Dim where colour is on: each mark's run of text starts after an SGR 2 that nothing has ended.
    if (color !== 'none') for (const r of rows) for (const m of r.matchAll(/⟨U\+[0-9A-F]{4}⟩/g)) {
      const before = r.slice(0, m.index);
      assert.ok(before.lastIndexOf('\x1b[2m') > Math.max(before.lastIndexOf('\x1b[22m'), before.lastIndexOf('\x1b[0m')), `the mark is dim (${what})`);
    }
  }
  assert.equal(sanitizeCell(`a title${evil}`), 'a title    /* } if (isAdmin)  begin admins only */', 'a title drops them');
  // The syntax colours never split a mark.
  const lit = tui.highlightSource('x = a\u202e;'.replace('\u202e', '⟨U+202E⟩'), 'truecolor');
  assert.ok(lit.includes('\x1b[2m⟨U+202E⟩\x1b[22m'), JSON.stringify(lit));
});

// More characters a terminal draws as nothing or as a blank: the soft hyphen, the combining grapheme joiner, the Mongolian
// vowel separator, the Hangul fillers (U+3164 is a name in JavaScript), and the tag characters, which spell out text no
// one sees unless they finish a flag. A title drops each, and a diff shows each as its mark, a tag's with five digits;
// a flag, an emoji, Hangul written as syllables or as jamo, and a variation selector stay as they are in both.
test('a title drops the soft hyphen, the Hangul fillers and stray tag characters, and a diff shows each as its mark', () => {
  const tui = require('../dist');
  const { sanitizeCell } = require('../dist/textwidth');
  const core = require('../../core/dist');
  const hidden = ['\u00ad', '\u17b4', '\u115f', '\u1160', '\u17b5', '\u3164', '\uffa0', '\u{E0001}', '\u{E0020}', '\u{E0041}', '\u{E007F}'];
  const scotland = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
  const kept = [`go ${scotland} team`, '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}', '\u2764\ufe0f', '\ud55c\uad6d\uc5b4', '\u1112\u1161\u11ab\u1100\u1173\u11af', '\u3131\u314f', '\u8fba\u{E0100}'];
  assert.equal(sanitizeCell(`Fix${hidden.join('')} the demo`), 'Fix the demo', 'a title drops each');
  for (const text of kept) assert.equal(sanitizeCell(text), text, `a title keeps ${JSON.stringify(text)}`);
  const read = `s = "${scotland} \u1112\u1161\u11ab \u2764\ufe0f";`;
  const patch = ['--- a/x.js', '+++ b/x.js', '@@ -1 +1,2 @@', '-let x = 1;', `+let x${hidden.join('x')} = 1;`, `+${read}`].join('\n');
  const marks = hidden.map((ch) => core.hiddenMark(ch));
  assert.ok(marks.includes('⟨U+E0041⟩') && marks.includes('⟨U+00AD⟩'), `control: ${marks}`);
  for (const color of ['none', 'truecolor']) for (const syntax of [false, true]) for (const cols of [30, 120]) {
    const rows = tui.renderRichDiff(patch, { cols, color, syntax, header: false }).map(sanitizeCell);
    const plain = rows.map(stripSgr).join('');
    const what = `${color}, syntax ${syntax}, ${cols} columns: ${JSON.stringify(rows.map(stripSgr))}`;
    assert.deepEqual(plain.match(/⟨U\+[0-9A-F]{4,5}⟩/g), marks, `each shows, whole, in order (${what})`);
    assert.ok(cols < 120 || rows.some((r) => stripSgr(r).includes(read)), `the flag, the jamo and the emoji stay (${what})`);
    assert.ok(rows.every((r) => displayWidth(r) <= cols), `each row fits (${what})`);
    if (color !== 'none') for (const r of rows) for (const m of r.matchAll(/⟨U\+[0-9A-F]{4,5}⟩/g)) {
      const before = r.slice(0, m.index);
      assert.ok(before.lastIndexOf('\x1b[2m') > Math.max(before.lastIndexOf('\x1b[22m'), before.lastIndexOf('\x1b[0m')), `the mark is dim (${what})`);
    }
  }
});

// A diff's long line is wrapped around its marks, and the syntax colours dim the marks in each comment and string: both
// built their RegExp of the marks on every call, each line of every frame. Drawing a diff builds none.
test('drawing a diff with marks, wrapped and coloured, builds no RegExp for each line', () => {
  const tui = require('../dist');
  const made = (fn) => {
    const Real = RegExp;
    let n = 0;
    globalThis.RegExp = new Proxy(Real, { construct: (t, args, nt) => (n++, Reflect.construct(t, args, nt)), apply: (t, self, args) => (n++, Reflect.apply(t, self, args)) });
    try { fn(); } finally { globalThis.RegExp = Real; }
    return n;
  };
  const lines = Array.from({ length: 40 }, (_, i) => `+const s${i} = "a\u202eb"; // c\u200bd ${'x'.repeat(60)}`);
  const patch = ['--- a/x.js', '+++ b/x.js', `@@ -0,0 +1,${lines.length} @@`, ...lines].join('\n');
  let rows = [];
  assert.equal(made(() => { rows = tui.renderRichDiff(patch, { cols: 40, color: 'truecolor', syntax: false, header: false }); }), 0, 'wrapped');
  assert.ok(rows.length > lines.length && rows.join('').includes('⟨U+202E⟩'), `control: the lines wrap around their marks (${rows.length} rows)`);
  assert.equal(made(() => tui.renderRichDiff(patch, { cols: 40, color: 'truecolor', syntax: true, header: false })), 0, 'and coloured');
  assert.ok(made(() => new RegExp('x')) === 1, 'control: a RegExp built is counted');
});

// A pane's border is a row of `─`, drawn on every frame, and each character of it asked the combining-mark regex
// whether it extends the one before it: a border row took twice as long to fit. The blocks of symbols (arrows to box
// drawing), the CJK ideographs, Hangul and the emoji hold no mark, and they never reach the regex.
test('a pane border, a CJK row and an emoji row are fitted without asking the combining-mark regex, and those blocks hold no mark', () => {
  const { fitVisible, wrapVisible } = require('../dist/textwidth');
  const asks = (fn) => {
    const real = RegExp.prototype.test;
    let n = 0;
    RegExp.prototype.test = function (s) { n++; return real.call(this, s); };
    try { fn(); } finally { RegExp.prototype.test = real; }
    return n;
  };
  for (const row of ['─'.repeat(200), `┌${'─'.repeat(198)}┐`, '│ ▸ ✓ ⚠ ★ → '.repeat(16), '漢字中文한국'.repeat(20), '\u{1F600}\u{1F680}'.repeat(50)])
    assert.equal(asks(() => { fitVisible(row, 120); wrapVisible(row, 50); }), 0, JSON.stringify(row.slice(0, 12)));
  assert.ok(asks(() => fitVisible('é'.repeat(50), 120)) > 0, 'control: a row with combining accents does ask it');
  for (let cp = 0x2100; cp <= 0x2bff; cp++) assert.ok(!/\p{M}/u.test(String.fromCodePoint(cp)), `U+${cp.toString(16)} is no mark`);
});

// A zero-width joiner or non-joiner hides inside an identifier as well (`is` + U+200D + `admin` is not `isadmin`): between
// two ASCII letters, digits, `_` or `$` it shows as its mark. An emoji family, an Indic conjunct and a Persian word are built
// with them, and keep them as they are.
test('a joiner inside an identifier shows in a diff as its mark, and one in an emoji, a conjunct or a Persian word does not', () => {
  const tui = require('../dist');
  const { sanitizeCell } = require('../dist/textwidth');
  const shown = ['if (is\u200dadmin) {}', 'foo\u200cbar = 1', 'a\u200d1 += 2'];
  const kept = ['family = "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}"', 'ksha = "क्\u200dष"', 'kitab = "کتاب\u200cها"'];
  const patch = ['--- a/x.js', '+++ b/x.js', '@@ -1,1 +1,6 @@', ...[...shown, ...kept].map((l) => `+${l}`)].join('\n');
  for (const color of ['none', '256', 'truecolor']) for (const syntax of [false, true]) {
    const text = tui.renderRichDiff(patch, { cols: 120, color, syntax, header: false }).map(sanitizeCell).map(stripSgr).join('\n');
    for (const l of shown) assert.ok(text.includes(l.replace(/[\u200c\u200d]/g, (c) => `⟨U+${c.codePointAt(0).toString(16).toUpperCase()}⟩`)), `${JSON.stringify(l)} shows its joiner (${color}, syntax ${syntax}): ${text}`);
    for (const l of kept) assert.ok(text.includes(l), `${JSON.stringify(l)} keeps its joiner (${color}, syntax ${syntax}): ${text}`);
  }
});
