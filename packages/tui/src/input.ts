/**
 * The terminal input decoder: bytes in, typed events out.
 *
 * This exists because scanning a chunk for escape sequences with a regex is not merely imprecise, it is
 * DANGEROUS in an application whose single-letter keys revert code. A terminal sends more than
 * keystrokes down stdin — mouse reports, bracketed-paste wrappers, focus notifications, and unsolicited
 * replies to capability queries — and it splits them across reads wherever it likes. Every one of these
 * was measured reaching a keymap as ordinary letters:
 *
 *   \x1b[<0;12;34M   an SGR mouse click        → `<` `0` `;` `1` `2` … four screen switches
 *   \x1b]11;rgb:…\x07  a background-colour reply → twenty-four keys, including `1`
 *   \x1b[?2026;2$y   a synchronised-output reply → three screen switches
 *   ["\x1b[", "A"]   an arrow split across reads → `A`, which is keep-everything
 *   ["\x1bO", "R"]   the same in SS3 form        → `R`, redo, with no confirm
 *
 * So the rules here are absolute: a sequence is consumed WHOLE or held until it completes; anything
 * that is not a keystroke leaves as its own event kind and can never be mistaken for one; and a
 * partial tail is buffered rather than guessed at.
 *
 * Pure and incremental, so the whole surface is testable without a terminal: feed the same bytes split
 * at every possible boundary and the event stream must be identical.
 */

export type MouseKind = 'down' | 'up' | 'move' | 'wheel-up' | 'wheel-down';

export interface KeyEvent {
  t: 'key';
  /** A single character, or a name: 'up' 'down' 'left' 'right' 'home' 'end' 'pgup' 'pgdn' 'enter'
   *  'backspace' 'tab' 'backtab' 'escape' 'delete' 'insert' 'f1'…'f12'. */
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}
export interface MouseEvent {
  t: 'mouse';
  kind: MouseKind;
  /** ZERO-BASED cell coordinates. The wire protocol is 1-based; converting once here means no caller
   *  can forget to. */
  col: number;
  row: number;
  button: number;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}
/** A bracketed paste, delivered as ONE event however many reads it arrived in. Never keys: in raw mode
 *  a paste is otherwise indistinguishable from typing, and this application binds single letters to
 *  destructive verbs. */
export interface PasteEvent {
  t: 'paste';
  text: string;
}
/** A reply to a capability query, or any other sequence we recognise but do not act on. Surfaced as a
 *  distinct kind so it is impossible to route into the keymap by accident. */
export interface ReplyEvent {
  t: 'reply';
  raw: string;
}
export interface FocusEvent {
  t: 'focus';
  focused: boolean;
}
export type InputEvent = KeyEvent | MouseEvent | PasteEvent | ReplyEvent | FocusEvent;

const ESC = '\x1b';
const key = (k: string, mods = 0): KeyEvent => ({
  t: 'key',
  key: k,
  // xterm modifier encoding: the parameter is a bitmask plus one — 1 shift, 2 alt, 4 ctrl.
  shift: (mods & 1) !== 0,
  alt: (mods & 2) !== 0,
  ctrl: (mods & 4) !== 0,
});

const CSI_LETTER: Record<string, string> = {
  A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end',
  P: 'f1', Q: 'f2', R: 'f3', S: 'f4', Z: 'backtab',
};
const CSI_TILDE: Record<string, string> = {
  '1': 'home', '2': 'insert', '3': 'delete', '4': 'end', '5': 'pgup', '6': 'pgdn',
  '11': 'f1', '12': 'f2', '13': 'f3', '14': 'f4', '15': 'f5', '17': 'f6', '18': 'f7',
  '19': 'f8', '20': 'f9', '21': 'f10', '23': 'f11', '24': 'f12',
};
const CTRL_NAME: Record<string, string> = {
  '\r': 'enter', '\n': 'enter', '\t': 'tab', '\x7f': 'backspace', '\b': 'backspace',
};

export interface Decoder {
  /** Feed a read. Returns every COMPLETE event in it; an unfinished tail is retained. */
  push(chunk: string | Uint8Array): InputEvent[];
  /** Bytes held back awaiting completion — for tests, and for the lone-ESC timer. */
  pending(): string;
  /**
   * Resolve a held tail that turned out to be all there was: a lone ESC is the Escape KEY only after
   * nothing follows it. Call on a short timer after a read that left `pending()` equal to ESC.
   */
  flush(): InputEvent[];
}

export function createDecoder(): Decoder {
  let buf = '';
  let pasting = false;
  let paste = '';

  /**
   * Try to take one event off the front of `buf`.
   * Returns null when the front is a valid PREFIX and we must wait for more bytes — the distinction
   * that makes split sequences safe.
   */
  function step(): InputEvent[] | null {
    if (buf.length === 0) return [];

    // --- inside a bracketed paste: everything is text until the end marker ------------------------
    if (pasting) {
      const end = buf.indexOf(`${ESC}[201~`);
      if (end === -1) {
        // Hold back a possible partial end marker rather than swallowing it as pasted text — losing it
        // strands the decoder in paste mode forever, and every later keystroke goes silently dead.
        const keep = partialTailLength(buf, `${ESC}[201~`);
        paste += buf.slice(0, buf.length - keep);
        buf = buf.slice(buf.length - keep);
        return [];
      }
      paste += buf.slice(0, end);
      buf = buf.slice(end + 6);
      pasting = false;
      const text = paste;
      paste = '';
      return [{ t: 'paste', text }];
    }

    const c = buf[0];

    if (c !== ESC) {
      buf = buf.slice(1);
      // C0 controls: ^A..^Z arrive as 0x01..0x1a. Enter/Tab/Backspace have names of their own.
      if (CTRL_NAME[c]) return [key(CTRL_NAME[c])];
      const code = c.charCodeAt(0);
      if (code < 0x20) return [{ t: 'key', key: String.fromCharCode(code + 96), ctrl: true, alt: false, shift: false }];
      // A multi-byte character may be split across reads; JS strings are UTF-16, so a lone high
      // surrogate means the pair is not all here yet.
      if (code >= 0xd800 && code <= 0xdbff) {
        if (buf.length === 0) {
          buf = c;
          return null;
        }
        const pair = c + buf[0];
        buf = buf.slice(1);
        return [key(pair)];
      }
      return [key(c)];
    }

    // --- an escape sequence ------------------------------------------------------------------------
    if (buf.length === 1) return null; // lone ESC so far: wait, then flush() decides
    const c1 = buf[1];

    // OSC / DCS / APC / PM / SOS — string sequences, terminated by BEL or ST. These carry query
    // REPLIES, which is how a background-colour answer used to arrive as two dozen keystrokes.
    if (c1 === ']' || c1 === 'P' || c1 === 'X' || c1 === '^' || c1 === '_') {
      const bel = buf.indexOf('\x07', 2);
      const st = buf.indexOf(`${ESC}\\`, 2);
      if (bel === -1 && st === -1) return null; // still arriving
      const end = bel !== -1 && (st === -1 || bel < st) ? bel + 1 : st + 2;
      const raw = buf.slice(0, end);
      buf = buf.slice(end);
      return [{ t: 'reply', raw }];
    }

    if (c1 === '[') {
      // SGR mouse: ESC [ < b ; col ; row (M|m). Checked before the generic CSI parse because its
      // final byte is a letter that would otherwise read as a key.
      const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(buf);
      if (m) {
        buf = buf.slice(m[0].length);
        return [sgrMouse(Number(m[1]), Number(m[2]), Number(m[3]), m[4] === 'M')];
      }
      if (/^\x1b\[<[\d;]*$/.test(buf)) return null; // a mouse report still arriving

      if (buf.startsWith(`${ESC}[200~`)) {
        buf = buf.slice(6); // ESC [ 2 0 0 ~ — six, and a five would put the ~ into the pasted text
        pasting = true;
        paste = '';
        return [];
      }
      if (isPrefixOf(buf, `${ESC}[200~`)) return null;

      if (buf.startsWith(`${ESC}[I`)) {
        buf = buf.slice(3);
        return [{ t: 'focus', focused: true }];
      }
      if (buf.startsWith(`${ESC}[O`)) {
        buf = buf.slice(3);
        return [{ t: 'focus', focused: false }];
      }

      // Generic CSI: ESC [ params intermediates final. A final byte is 0x40-0x7e.
      // `!` was in BOTH classes — it is 0x21, inside the 0x20-0x2F intermediate range — so the two
      // adjacent stars could split a run of `!` in many ways and the match became polynomial on
      // hostile input. This decoder exists precisely because bytes arriving on stdin are not input we
      // choose. Per ECMA-48 `!` is an INTERMEDIATE byte, not a parameter byte, so dropping it from
      // the parameter class is also the more correct reading.
      const csi = /^\x1b\[([\d;:?<>]*)([ -\/]*)([@-~])/.exec(buf);
      if (!csi) {
        // Everything so far must still be a legal CSI body, or this is junk we drop one byte at a time
        // rather than re-interpreting as keys.
        if (/^\x1b\[[\d;:?<>]*[ -\/]*$/.test(buf)) return null;
        buf = buf.slice(1);
        return [];
      }
      const [all, params, , final] = csi;
      buf = buf.slice(all.length);
      // A private-mode or device reply (they carry ? > or $ and are never keys).
      if (/[?>]/.test(params) || final === 'y' || final === 'c' || final === 'n') {
        return [{ t: 'reply', raw: all }];
      }
      const parts = params.split(';');
      const mods = parts.length > 1 ? Number(parts[1]) - 1 || 0 : 0;
      if (final === '~') {
        const name = CSI_TILDE[parts[0] ?? ''];
        return name ? [key(name, mods)] : [{ t: 'reply', raw: all }];
      }
      const named = CSI_LETTER[final];
      return named ? [key(named, mods)] : [{ t: 'reply', raw: all }];
    }

    if (c1 === 'O') {
      // SS3 — the application-cursor-mode form of the arrows. A previous program may well have left
      // that mode on, so this is not optional.
      if (buf.length === 2) return null;
      const f = buf[2];
      buf = buf.slice(3);
      const named = CSI_LETTER[f];
      return named ? [key(named)] : [{ t: 'reply', raw: `${ESC}O${f}` }];
    }

    // ESC followed by an ordinary character is Alt+that. A CONTROL character keeps the name the
    // unprefixed form gets — alt+Tab arrives as ESC TAB, and returning the raw `\t` made it a
    // different key from `tab`, so every consumer written against the name silently never fired.
    buf = buf.slice(2);
    return [{ t: 'key', key: CTRL_NAME[c1] ?? c1, ctrl: false, alt: true, shift: false }];
  }

  function drain(): InputEvent[] {
    const out: InputEvent[] = [];
    for (;;) {
      const before = buf.length;
      const evs = step();
      if (evs === null) return out; // waiting for more bytes
      out.push(...evs);
      if (buf.length === 0) return out;
      if (buf.length === before && evs.length === 0) return out; // no progress: hold
    }
  }

  return {
    push(chunk) {
      buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return drain();
    },
    pending() {
      return buf;
    },
    flush() {
      if (buf === ESC) {
        buf = '';
        return [key('escape')];
      }
      return drain();
    },
  };
}

function sgrMouse(b: number, col: number, row: number, press: boolean): MouseEvent {
  const shift = (b & 4) !== 0;
  const alt = (b & 8) !== 0;
  const ctrl = (b & 16) !== 0;
  const motion = (b & 32) !== 0;
  const wheel = (b & 64) !== 0;
  const button = b & 3;
  let kind: MouseKind;
  if (wheel) kind = button === 0 ? 'wheel-up' : 'wheel-down';
  else if (motion) kind = 'move';
  else kind = press ? 'down' : 'up';
  // The wire is 1-based; every caller wants cells.
  return { t: 'mouse', kind, col: col - 1, row: row - 1, button, ctrl, alt, shift };
}

/** Is `s` a strict prefix of `full` (so more bytes could still complete it)? */
function isPrefixOf(s: string, full: string): boolean {
  return s.length < full.length && full.startsWith(s);
}

/** How many trailing bytes of `s` could be the start of `marker`. */
function partialTailLength(s: string, marker: string): number {
  const max = Math.min(s.length, marker.length - 1);
  for (let n = max; n > 0; n--) if (marker.startsWith(s.slice(s.length - n))) return n;
  return 0;
}
