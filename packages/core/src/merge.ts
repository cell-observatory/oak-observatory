/**
 * The line-merge primitives shared by the undo engine and the review-unit derivation.
 *
 * These lived inside `undo.ts` until `units.ts` needed `tokenizeLines` for its hop-shape diffs.
 * Importing `undo.ts` from `units.ts` would have closed a cycle — `undo.ts` already imports the
 * grouping layer — so the primitives moved here instead of being copied. There is exactly one
 * implementation of "merge two line-deltas onto a common base" in this product; `undo.ts` is its
 * caller, and `capture.ts` reads `blankLineOnlyChange` from the same toolbox.
 *
 * Pure text + the `diff` package. No filesystem, no store, no model calls.
 */
import { diffArrays } from 'diff';

/** Split into lines that KEEP their trailing "\n" (last line may lack one); join('') round-trips. */
export function tokenizeLines(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) || [];
}

/**
 * True when the ONLY difference between two texts is blank lines being added or removed.
 *
 * A reviewer does not have a decision to make about a blank line. Recording one costs a row, a pending
 * count, a diff to open and a keep/undo click, and it tells them nothing — and agents produce them
 * constantly while reformatting around an edit they later revert. So a change that survives nothing but
 * blank-line churn is not tracked at all, the same way an edit that nets out to identical content is
 * already not tracked (`capture.ts`).
 *
 * "Blank" means empty or whitespace-only: a line of stray indentation reads as empty to the person
 * looking at it, and treating it otherwise would put the row back for a change they cannot see. This
 * compares the two texts with their blank lines removed — so an edit that ALSO changes real content is
 * unaffected and rides through with its whitespace intact.
 */
export function blankLineOnlyChange(before: string, after: string): boolean {
  if (before === after) return false; // no change at all is a different case, handled by its own check
  // A file's FINAL NEWLINE is not a blank line. Splitting on '\n' makes a trailing terminator look
  // like an empty last element, so stripping blanks compared "…two\n" equal to "…two" — and adding
  // or removing a file's last newline vanished entirely: no record, no marker, nothing to undo,
  // while git renders it as `\ No newline at end of file` and linters fail the build on it.
  if (before.endsWith('\n') !== after.endsWith('\n')) return false;
  const strip = (s: string) => s.split('\n').filter((l) => l.trim() !== '').join('\n');
  return strip(before) === strip(after);
}

export interface LineChange {
  start: number; // base token index
  del: number; // base tokens removed
  ins: string[]; // tokens inserted
}

/** Changes base->other in base-token coordinates, via diffArrays over newline-terminated lines. */
export function lineChanges(base: string, other: string): LineChange[] {
  return tokenChanges(tokenizeLines(base), tokenizeLines(other));
}

function tokenChanges(baseTok: string[], otherTok: string[]): LineChange[] {
  const parts = diffArrays(baseTok, otherTok);
  const out: LineChange[] = [];
  let baseIdx = 0;
  let i = 0;
  while (i < parts.length) {
    if (!parts[i].added && !parts[i].removed) {
      baseIdx += parts[i].value.length;
      i++;
      continue;
    }
    const start = baseIdx;
    let del = 0;
    const ins: string[] = [];
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      if (parts[i].removed) {
        del += parts[i].value.length;
        baseIdx += parts[i].value.length;
      } else {
        ins.push(...parts[i].value);
      }
      i++;
    }
    out.push({ start, del, ins });
  }
  return out;
}

/**
 * Position-anchored 3-way line merge. base = after_N; ours = current (base + later edits);
 * theirs = before_N (base with edit N undone). Returns merged text, or null on a genuine overlap.
 *
 * Anchoring on base line positions (not fuzzy text search) makes it safe against duplicated content;
 * zero-context change regions avoid the spurious "nearby edits" conflicts that a patch-level merge
 * produces when two edits fall within a context window of each other.
 *
 * A file's final newline belongs to the file, not to its last line, and it is merged that way. Merged
 * as part of the last line, a side that dropped it left that line unterminated, and whatever the
 * other side added after it was glued on: a redo turned `build --release` plus an appended `deploy`
 * into `build --releasedeploy`, and an appended blank line vanished into the missing terminator. So
 * each text's last line is terminated before the lines are merged, and the result ends with a newline
 * when the side that changed that says so, or else when the base did.
 *
 * When both sides changed it, they overlap, as two sides that change one line do. Taking it from both
 * gave that newline two owners: an undo whose only change was the newline wrote the file unchanged and
 * reported success, and the redo after it dropped the newline a later edit had put back.
 */
export function threeWayMerge(base: string, ours: string, theirs: string): string | null {
  const [b, o, t] = [base, ours, theirs].map((s) => (s === '' ? undefined : s.endsWith('\n'))); // an empty text has no last line
  if (b !== undefined && o !== undefined && t !== undefined && o !== b && t !== b) return null;
  const eol = lineEnding(base) ?? lineEnding(ours) ?? lineEnding(theirs) ?? '\n';
  const merged = mergeLines(terminated(base, base, eol), terminated(base, ours, eol), terminated(base, theirs, eol));
  if (merged === null || merged === '') return merged;
  const finalNewline = o !== undefined && o !== b ? o : t !== undefined && t !== b ? t : b;
  if (finalNewline) return merged;
  // The last line's own terminator comes off, whichever it is. A blank last line keeps it: without it,
  // the line is not there at all.
  const unterminated = merged.slice(0, merged.endsWith('\r\n') ? -2 : -1);
  return unterminated === '' || unterminated.endsWith('\n') ? merged : unterminated;
}

/**
 * For a caller about to run `threeWayMerge(base, ours, theirs)` on many `ours`: a test that is false
 * when that merge must refuse. Every run of lines `theirs` takes out of `base` has to be in `ours`
 * whole, or the two sides overlap. The diff of `base` and `theirs` is paid once and each `ours` costs
 * a text search; an `ours` that passes may still conflict.
 */
export function mergeGuard(base: string, theirs: string): (ours: string) => boolean {
  const eol = lineEnding(base);
  if (eol === undefined) return () => true; // one line: how it is terminated depends on `ours`
  const baseTok = tokenizeLines(terminated(base, base, eol));
  const runs = tokenChanges(baseTok, tokenizeLines(terminated(base, theirs, eol)))
    .filter((c) => c.del > 0)
    .map((c) => baseTok.slice(c.start, c.start + c.del).join(''));
  return (ours) => {
    const lines = terminated(base, ours, eol);
    return runs.every((run) => lines.startsWith(run) || lines.includes('\n' + run));
  };
}

/**
 * The terminator for an unterminated last line that base does not hold (see `terminated`): `\r\n` or `\n`
 * as the text's last terminated line ends, the line a rewritten last line most likely replaced, or
 * undefined for one line.
 */
function lineEnding(s: string): string | undefined {
  const i = s.lastIndexOf('\n');
  return i < 0 ? undefined : i > 0 && s[i - 1] === '\r' ? '\r\n' : '\n';
}

/**
 * The text with its last line terminated, so every line of it is a whole line. The line takes the
 * terminator it has where `base` holds it, nearest base's end: a side that drops the final newline, or
 * deletes the last line and drops it, leaves a line base still terminates, and that terminator makes the
 * two equal again. One terminator for every file made that line a change of its own in a file whose lines
 * end differently (a shebang written with `\n` above a body in `\r\n`), merged into the result. A line
 * base does not hold takes `eol`. One that ends in a bare `\r` takes `\r\n`: with `\n` it would read as a
 * CRLF line, and taking that terminator off again would take the `\r` with it.
 */
function terminated(base: string, s: string, eol: string): string {
  if (s === '' || s.endsWith('\n')) return s;
  if (s.endsWith('\r')) return s + '\r\n';
  const last = s.slice(s.lastIndexOf('\n') + 1);
  const lf = lineAt(base, last + '\n');
  const crlf = lineAt(base, last + '\r\n');
  return s + (lf < 0 && crlf < 0 ? eol : crlf > lf ? '\r\n' : '\n');
}

/** Where `line`, its terminator included, starts as a whole line of `text`, nearest the end; -1 if nowhere. */
function lineAt(text: string, line: string): number {
  const i = text.lastIndexOf('\n' + line);
  return i >= 0 ? i + 1 : text.startsWith(line) ? 0 : -1;
}

/** The merge itself, over texts whose every line is terminated. */
function mergeLines(base: string, ours: string, theirs: string): string | null {
  const baseTok = tokenizeLines(base);
  const A = tokenChanges(baseTok, tokenizeLines(ours));
  const B = tokenChanges(baseTok, tokenizeLines(theirs));
  for (const a of A) {
    for (const b of B) {
      const a0 = a.start,
        a1 = a.start + a.del,
        b0 = b.start,
        b1 = b.start + b.del;
      const overlap = a0 < b1 && b0 < a1;
      const bothInsertSamePoint = a.del === 0 && b.del === 0 && a0 === b0;
      const insertInsideReplace =
        (a.del === 0 && a0 > b0 && a0 < b1) || (b.del === 0 && b0 > a0 && b0 < a1);
      if (overlap || bothInsertSamePoint || insertInsideReplace) return null;
    }
  }
  const all = [...A, ...B].sort((x, y) => x.start - y.start || x.del - y.del);
  const res: string[] = [];
  let i = 0;
  for (const ch of all) {
    while (i < ch.start) res.push(baseTok[i++]);
    res.push(...ch.ins);
    i = ch.start + ch.del;
  }
  while (i < baseTok.length) res.push(baseTok[i++]);
  return res.join('');
}
