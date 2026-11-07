// Compile the webview JS. tsc checks that the template literal is well-formed TypeScript (the backtick
// trap) but never looks INSIDE the string, so a syntax error in webview JS ships green and the panel is
// blank at runtime with nothing in the build to point at it.
import fs from 'fs';
const src = fs.readFileSync('packages/vscode/src/extension.ts', 'utf8');

// Which identifiers get injected into a <script> tag?
const names = [...new Set([...src.matchAll(/<script nonce="\$\{nonce\}">\$\{(\w+)\}<\/script>/g)].map((m) => m[1]))];
if (!names.length) { console.log('INSTRUMENT BROKEN: no <script nonce> injections found'); process.exit(2); }

// Pull each one's template literal out by scanning to the matching unescaped backtick.
function literalFor(name) {
  // TWO definitions under one injected name means every copy after the first ships UNCHECKED — the
  // tour webview did exactly that (both shells used a local `script`), provably green with broken JS
  // planted inside. Refuse to vouch for what was not parsed.
  const defs = [...src.matchAll(new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=]*)?=\\s*\``, 'g'))];
  if (defs.length > 1) return { duplicate: defs.length };
  const m = defs[0];
  if (!m) return null;
  let i = m.index + m[0].length, depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '$' && src[i + 1] === '{') { depth++; i++; continue; }
    if (c === '}' && depth > 0) { depth--; continue; }
    if (c === '`' && depth === 0) break;
  }
  return src.slice(m.index + m[0].length, i);
}

let ok = 0; const fails = [];
for (const n of names) {
  const body = literalFor(n);
  if (body == null) { fails.push(`${n}: could not locate its template literal`); continue; }
  if (typeof body === 'object') {
    fails.push(`${n}: defined ${body.duplicate} times — every copy after the first ships unchecked; give each webview its own name`);
    continue;
  }
  const neutral = body.replace(/\$\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '0'); // host-side interpolation → a literal
  // EVALUATE the template literal before parsing it. The engine resolves its escapes first, so the
  // text that ships is not the text in the source: `\'` here is a valid escape and reaches the browser
  // as a bare apostrophe, which terminates the JS string it was sitting in. Parsing the raw source
  // called that script healthy and it shipped broken — the exact failure this gate exists to catch.
  let js;
  try {
    // The body is the source text between the backticks, escapes intact, so it goes back between backticks
    // unchanged: the engine then resolves exactly the escapes the extension's own build resolves. Escaping
    // its backslashes first would turn each escape back into literal text, and the gate would parse the
    // source rather than what ships (a planted `'it\'s'` passed).
    js = new Function('return `' + neutral + '`')();
  } catch (e) {
    fails.push(`${n}: its template literal does not even evaluate: ${e.message}`);
    continue;
  }
  try { new Function(js); ok++; } catch (e) { fails.push(`${n} (${js.length}b): ${e.message}`); }
}
console.log(`  webview scripts: ${names.join(', ')}`);
console.log(`  parsed: ${ok}   failed: ${fails.length}`);
for (const f of fails) console.log('  FAIL ' + f);
process.exit(fails.length ? 1 : 0);
