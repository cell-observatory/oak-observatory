import { createDecoder, type InputEvent, type KeyEvent } from './input';

export interface NativeKeyEvent extends KeyEvent {
  super: boolean;
  hyper: boolean;
  meta: boolean;
  event: 'press' | 'repeat' | 'release';
}

/** Decode kitty keys before handing the rest to the legacy decoder. Keep modifiers which OAK does
 * not bind, so super+w can never turn into an ordinary w command in an overlay or after a leader. */
export function decodeNativeKey(raw: string): NativeKeyEvent | null {
  const match = /^\x1b\[(\d+(?::\d*){0,2})(?:;(\d*)(?::([123]))?)?(?:;[\d:]+)?([uA-DFHP-SZ~])$/.exec(raw);
  if (!match) return null;
  const codes = match[1].split(':').map(Number), mods = Math.max(1, Number(match[2]) || 1) - 1;
  let name: string;
  if (match[4] === 'u') {
    const code = codes[0];
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
    const named: Record<number, string> = { 9: 'tab', 13: 'enter', 27: 'escape', 127: 'backspace',
      57348: 'insert', 57349: 'delete', 57350: 'left', 57351: 'right', 57352: 'up', 57353: 'down',
      57354: 'pgup', 57355: 'pgdn', 57356: 'home', 57357: 'end' };
    name = named[code] ?? (code >= 57364 && code <= 57375 ? `f${code - 57363}` : String.fromCodePoint(code));
    if ((mods & 1) && !(mods & 4) && !named[code] && code < 57344) {
      name = codes[1] && codes[1] <= 0x10ffff ? String.fromCodePoint(codes[1]) : name.toUpperCase();
    }
    if (name === 'tab' && (mods & 1)) name = 'backtab';
  } else {
    const legacy = createDecoder().push(`\x1b[${codes[0]};${mods + 1}${match[4]}`)[0];
    if (legacy?.t !== 'key') return null;
    name = legacy.key;
  }
  return { t: 'key', key: name, shift: !!(mods & 1), alt: !!(mods & 2), ctrl: !!(mods & 4),
    super: !!(mods & 8), hyper: !!(mods & 16), meta: !!(mods & 32),
    event: match[3] === '3' ? 'release' : match[3] === '2' ? 'repeat' : 'press' };
}

export interface NativeInputPart { bytes: Buffer; events: (InputEvent | NativeKeyEvent)[] }

/** The bytes of one UTF-8 code point, from its lead byte. A continuation or illegal lead byte stands
 * alone, so a stray byte becomes one replacement character instead of eating the next key. ONE rule,
 * used by both branches that measure a character: the Alt branch measured two bytes and split Alt+e
 * with an acute accent into a corrupt Alt key plus a loose replacement character, which the reply
 * field then typed into the draft. */
function codePointBytes(lead: number): number {
  return lead >= 0xf0 && lead <= 0xf4 ? 4 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xc2 && lead <= 0xdf ? 2 : 1;
}

/**
 * Frame stdin once, before deciding whether a key belongs to OAK or the child. A read may contain
 * both, or just half a CSI. Paste and control strings remain opaque and UTF-8 stays byte-for-byte.
 *
 * TWO framers, deliberately, with one seam between them. This one measures BYTES, because its output
 * is what gets written to a child pty verbatim — it may never decode a byte it forwards, and it holds
 * a torn tail (`pending`, latin1, so the round trip is exact) until the read that completes it.
 * `createDecoder` measures CHARACTERS of decoded text and is the only place that says what a key
 * MEANS; it is used on its own elsewhere, so it keeps its own incremental buffer.
 *
 * The invariant that keeps them from disagreeing: every part handed to the decoder is one COMPLETE
 * key — a whole escape sequence, a whole control string, a whole paste, or exactly one whole UTF-8
 * code point (`codePointBytes`, including after ESC). The decoder therefore never sees a split
 * character, and byte preservation cannot diverge from key interpretation.
 */
export function createNativeInput() {
  let pending = '';
  const decoder = createDecoder();
  const part = (raw: string): NativeInputPart => {
    const bytes = Buffer.from(raw, 'latin1');
    const key = decodeNativeKey(raw);
    return { bytes, events: key ? [key] : decoder.push(bytes) };
  };
  return {
    push(chunk: Buffer): NativeInputPart[] {
      pending += chunk.toString('latin1');
      const out: NativeInputPart[] = [];
      while (pending) {
        let size = 1;
        if (pending[0] === '\x1b') {
          if (pending.length === 1) break;
          if (pending.startsWith('\x1b[200~')) {
            const end = pending.indexOf('\x1b[201~', 6);
            if (end < 0) break;
            size = end + 6;
          } else if (pending[1] === '[') {
            const csi = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(pending);
            if (!csi && /^\x1b\[[0-?]*[ -/]*$/.test(pending)) break;
            size = csi ? csi[0].length : 2;
          } else if (']PX^_'.includes(pending[1])) {
            const end = /\x07|\x1b\\/.exec(pending.slice(2));
            if (!end) break;
            size = 2 + end.index + end[0].length;
          } else if (pending[1] === 'O') {
            if (pending.length < 3) break;
            size = 3;
          } else if (pending.charCodeAt(1) < 0x20 && !'\r\n\t\b'.includes(pending[1])) {
            // A held ESC followed by an unrelated control is two keys, not Alt+ctrl+a.
            out.push({ bytes: Buffer.from('\x1b'), events: [{ t: 'key', key: 'escape', ctrl: false, alt: false, shift: false }] });
            pending = pending.slice(1);
            continue;
          } else {
            // ESC + one WHOLE code point: Alt+e-acute arrives as ESC c3 a9, and framing it as two
            // bytes handed the decoder half a character.
            size = 1 + codePointBytes(pending.charCodeAt(1));
            if (pending.length < size) break;
          }
        } else {
          size = codePointBytes(pending.charCodeAt(0));
          if (pending.length < size) break;
        }
        out.push(part(pending.slice(0, size)));
        pending = pending.slice(size);
      }
      return out;
    },
    pending: () => pending,
    flush(): NativeInputPart[] {
      if (pending !== '\x1b') return [];
      pending = '';
      const result = part('\x1b');
      result.events.push(...decoder.flush());
      return [result];
    },
  };
}

/** Translate terminal mouse coordinates into the native body's coordinates. All other bytes stay
 * opaque (including split UTF-8). The caller retains `pending` between reads and routes chrome
 * reports through OAK's hit test, in stream order, so a tab click cannot leak into the child. */
export function translateNativeMouse(
  chunk: Buffer,
  topRows: number,
  bodyRows: number,
  pending: Buffer = Buffer.alloc(0),
): { parts: { target: 'pty' | 'chrome'; bytes: Buffer }[]; pending: Buffer } {
  const parts: { target: 'pty' | 'chrome'; bytes: Buffer }[] = [];
  const put = (target: 'pty' | 'chrome', text: string) => {
    if (text) parts.push({ target, bytes: Buffer.from(text, 'latin1') });
  };
  // A held prefix is glued to the next read ONLY when that read continues it. A lone ESC followed by
  // an unrelated key (ESC, then ctrl+a within the hold window) is two keystrokes: gluing them made
  // `\x1b\x01n` one opaque part whose first byte is no longer the leader, so the leader went to the
  // child and the reader could not leave the tab. The prefix goes out on its own first.
  const held = pending.toString('latin1');
  const next = chunk.toString('latin1');
  const continues =
    !held ||
    (held === '\x1b' && next.startsWith('[')) ||
    (held === '\x1b[' && next.startsWith('<')) ||
    (/^\x1b\[<[\d;]*$/.test(held) && /^[\d;Mm]/.test(next));
  if (!continues) {
    put('pty', held);
    pending = Buffer.alloc(0);
  }
  const input = Buffer.concat([pending, chunk]).toString('latin1');
  let start = 0;
  for (let at = 0; at < input.length; at++) {
    if (input[at] !== '\x1b') continue;
    const tail = input.slice(at);
    const report = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(tail);
    if (report) {
      put('pty', input.slice(start, at));
      const row = Number(report[3]);
      if (row > 0 && row <= topRows) put('chrome', report[0]);
      else if (row > topRows && row <= topRows + bodyRows) {
        put('pty', `\x1b[<${report[1]};${report[2]};${row - topRows}${report[4]}`);
      }
      at += report[0].length - 1;
      start = at + 1;
    } else if (tail === '\x1b' || tail === '\x1b[' || /^\x1b\[<[\d;]*$/.test(tail)) {
      put('pty', input.slice(start, at));
      return { parts, pending: Buffer.from(tail, 'latin1') };
    }
  }
  put('pty', input.slice(start));
  return { parts, pending: Buffer.alloc(0) };
}
