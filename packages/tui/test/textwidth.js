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
