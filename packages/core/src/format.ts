/**
 * Presentation helpers shared by front-ends: per-edit line deltas and a colored unified diff.
 * Uses the `diff` package, so it is loaded only by review commands — never by the capture hook.
 */
import { createPatch, diffLines, structuredPatch } from 'diff';
import { EditRecord, blobText as storeBlobText, hasBlob, readBlob } from './store';
import { notePairDelta, pairDelta, pairKeyOf } from './derived';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

function blobText(sessionId: string, sha: string | null): string {
  if (sha === null) return '';
  try {
    return storeBlobText(sessionId, sha);
  } catch {
    return ''; // a GC'd/deleted blob must not crash lineDelta/coloredDiff (matches groups.ts/tree.ts)
  }
}

/** Compact relative time, e.g. "5s ago", "12m ago", "3h ago", "2d ago", "3w ago", "2mo ago".
 *
 *  A timestamp of 0 is "no time recorded", not the epoch: rows that carry one — a remote host that
 *  could not be reached, a session whose transcript is gone — were rendering as "679mo ago", which
 *  reads as a real and very old measurement rather than as an absent one. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The EXACT wall-clock time of an event, in the reader's own zone (since 0.10.0,
 * every "3h ago" across the product became the actual time). Precision falls with distance, because
 * that is what the reader can use: today keeps the seconds, this year keeps the minute and gains
 * the date, older keeps only the date. `ts` 0 stays "—" — an event with no recorded time is never
 * given an invented one. (The name survives from the relative era so its ~50 call sites did not churn.)
 */
export function relTime(ts: number, now: number = Date.now()): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const n = new Date(now);
  const p = (x: number) => (x < 10 ? '0' : '') + x;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  if (d.getFullYear() === n.getFullYear()) return `${MONTHS[d.getMonth()]} ${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * A token count at a glance: `3.7M`, `812k`, `947`.
 *
 * The same thresholds and rounding the editors' `fmtTok` already uses, moved here so the terminal
 * cannot drift from what VS Code and JetBrains show for the same agent. (The webviews keep their own
 * inline copy: their script is a string, so it cannot import this. That duplication is deliberate and
 * pinned by a test rather than left to memory.)
 */
export function compactTokens(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}k`;
  return String(v);
}

/** On-disk size at a glance: `4.2MB`, `318KB`, `12B`. Base-1024, one decimal for the larger units. */
export function compactBytes(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  if (v >= 1024 * 1024 * 1024) return `${(v / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (v >= 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)}MB`;
  if (v >= 1024) return `${Math.round(v / 1024)}KB`;
  return `${Math.round(v)}B`;
}

/** A blob's byte length (0 when it cannot be read), and whether it is binary (a NUL in the first 8 KB,
 *  the same test capture uses). Byte-safe: `readBlob` returns the raw Buffer, never a lossy decode. */
function blobByteLen(sessionId: string, sha: string | null | undefined): number {
  if (!sha) return 0;
  try {
    return readBlob(sessionId, sha).length;
  } catch {
    return 0;
  }
}
function isBinaryBlob(sessionId: string, sha: string | null | undefined): boolean {
  if (!sha) return false;
  try {
    const buf = readBlob(sessionId, sha);
    const n = Math.min(buf.length, 8000);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * A binary change has no line diff — the review surfaces show this size summary instead of a text
 * patch. `rec.binary` is the fast path set at capture; the blob NUL-scan is a
 * defensive fallback that also covers a text→binary or binary→text edit whose flag reflects only one
 * side. Returns null for an all-text pair.
 */
export function binaryChange(sessionId: string, rec: EditRecord): { summary: string; beforeBytes: number; afterBytes: number } | null {
  const bin = rec.binary === true || isBinaryBlob(sessionId, rec.beforeBlob) || isBinaryBlob(sessionId, rec.afterBlob);
  if (!bin) return null;
  const beforeBytes = blobByteLen(sessionId, rec.beforeBlob);
  const afterBytes = blobByteLen(sessionId, rec.afterBlob);
  const verb = !rec.beforeBlob ? 'added' : !rec.afterBlob ? 'deleted' : 'changed';
  return { summary: `Binary file ${verb} — ${compactBytes(beforeBytes)} → ${compactBytes(afterBytes)}`, beforeBytes, afterBytes };
}

/** A duration at a glance: `23.4h`, `47m`, `12s`. Same rules as the editors' `fmtDur`. */
export function compactDuration(ms: number): string {
  const v = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const s = Math.round(v / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}

/** Added/removed line counts for an edit. New-file = all added; deletion = all removed. */
/** Memo for `lineDelta`, keyed by the two BLOB HASHES.
 *
 *  Blobs are content-addressed and immutable, so a (before, after) pair always yields the same delta —
 *  there is nothing to invalidate. This is worth caching because the change map computes a delta for
 *  every edit in the session on every build: at 1,100 edits the diff was ~1.6 s of a 3.5 s build, the
 *  single largest cost left, and the same pairs recur across the fleet/agent slices within one run. */
const deltaMemo = new Map<string, { added: number; removed: number }>();
const DELTA_MEMO_CAP = 20000; // bounded: a long-lived editor host must not grow without limit

export function lineDelta(sessionId: string, rec: EditRecord): { added: number; removed: number } {
  // Binary content has no line model — the review shows a byte-size summary, and the ± counts read
  // zero (the record is still tracked and reviewable). Flag-only on this hot path: capture always
  // sets `binary`, so there is no per-record blob scan on a big session.
  if (rec.binary) return { added: 0, removed: 0 };
  const key = `${rec.beforeBlob ?? ''}\u0000${rec.afterBlob ?? ''}`;
  const pk = pairKeyOf(rec.beforeBlob, rec.afterBlob);
  const hit = deltaMemo.get(key);
  if (hit) {
    // The memo is content-keyed ACROSS sessions — deliberately, because the bytes are the same
    // wherever they live — so a hit here can be the first time THIS session's store has seen the
    // pair. Publish it, or a session whose numbers happened to be computed under another session's
    // memo never builds a cache of its own and pays the full diff again in the next process. The
    // `hasBlob` guard is the same one below: a pair this session cannot read must never be filed
    // as though it could.
    if (pairDelta(sessionId, pk) === undefined && hasBlob(sessionId, rec.beforeBlob) && hasBlob(sessionId, rec.afterBlob)) {
      notePairDelta(sessionId, pk, [hit.added, hit.removed]);
    }
    return hit;
  }
  // …and the same answer from the LAST process. The read commands are spawned, so the memo above is
  // always empty on a poll: measured at 3.2s per `list` on a 978-record session, re-diffing blobs
  // whose bytes had not moved. The store is content-keyed, so a hit is exact by construction.
  const onDisk = pairDelta(sessionId, pk);
  if (onDisk) {
    const v = { added: onDisk[0], removed: onDisk[1] };
    deltaMemo.set(key, v);
    return v;
  }
  // Blobs are content-addressed, but READABILITY is per session — and the key above is not. `blobText`
  // yields '' for a snapshot this session lost, so memoizing that answer under a content key hands the
  // wrong delta to every other session holding the same bytes. observe's delta cache then persists it
  // under a `hasBlob` guard that only ever inspected the HEALTHY session, so the bad number outlives
  // the process in a store that never lost anything. Compute it and return it; never publish it.
  const intact = hasBlob(sessionId, rec.beforeBlob) && hasBlob(sessionId, rec.afterBlob);
  const before = blobText(sessionId, rec.beforeBlob);
  const after = blobText(sessionId, rec.afterBlob);
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    const lines = part.count ?? part.value.split('\n').length - 1;
    if (part.added) added += lines;
    else if (part.removed) removed += lines;
  }
  const out = { added, removed };
  if (intact) {
    if (deltaMemo.size >= DELTA_MEMO_CAP) deltaMemo.clear(); // simple bound; refills from the same blobs
    deltaMemo.set(key, out);
    // Only an INTACT pair is published. A blob that cannot be read yields '' from `blobText`, and
    // this would happily file "the whole file was removed" under the healthy sha — an entry nothing
    // could ever heal, because the key never changes.
    notePairDelta(sessionId, pk, [added, removed]);
  }
  return out;
}

/** A raw model id → a short human label, e.g. 'claude-opus-4-8' → 'Opus 4.8', 'claude-sonnet-5' → 'Sonnet 5'.
 *  Unknown shapes pass through unchanged so nothing is ever mislabeled. Shared: the Workflows rows label
 *  each agent's model with it, and the Stats panel labels the session's own model with it — one labeler,
 *  so the two surfaces can never disagree about what "Opus 4.8" is called. */
export function friendlyModel(m: string): string {
  if (!m) return '';
  const mm = /claude-([a-z]+)-(\d+)(?:-(\d+))?/i.exec(m);
  if (!mm) return m;
  const fam = mm[1].charAt(0).toUpperCase() + mm[1].slice(1);
  const ver = mm[3] ? `${mm[2]}.${mm[3]}` : mm[2];
  return `${fam} ${ver}${/\[1m\]|-1m\b/i.test(m) ? ' (1M)' : ''}`;
}

export interface DiffPreview {
  /** The windowed pair — a real diff of the part it shows, aligned by construction. */
  before: string;
  after: string;
  shownHunks: number;
  totalHunks: number;
  /** Changed lines left out. Zero means the preview IS the whole diff. */
  omittedLines: number;
}

/**
 * A BOUNDED window on one edit's diff: whole hunks until `maxLines` of changed lines, rebuilt into a
 * before/after pair.
 *
 * A unit that rewrote thousands of lines renders as a wall in any viewer that stacks diffs (VS
 * Code's multi-diff editor caps nothing per row), so the only lever left is the content handed to
 * it. Whole hunks are what keeps this honest: both sides are rebuilt from the same hunk lines, so
 * the window is a faithful diff of the part it shows rather than two independently truncated files
 * whose alignment is a coincidence. What is left out is NAMED — the caller renders `omittedLines`
 * beside the row, and one trailing marker line, identical on both sides so it can only ever read as
 * unchanged context, says the same thing inside the diff.
 */
export function previewPair(sessionId: string, rec: EditRecord, maxLines = 200): DiffPreview {
  // A binary change has no text diff; render the size on each side so the pair reads as an added,
  // removed or resized file rather than a garbage decode of its bytes.
  const bin = binaryChange(sessionId, rec);
  if (bin) {
    return {
      before: rec.beforeBlob ? `Binary file · ${compactBytes(bin.beforeBytes)}\n` : '',
      after: rec.afterBlob ? `Binary file · ${compactBytes(bin.afterBytes)}\n` : '',
      shownHunks: 0,
      totalHunks: 0,
      omittedLines: 0,
    };
  }
  const before = blobText(sessionId, rec.beforeBlob);
  const after = blobText(sessionId, rec.afterBlob);
  const hunks = structuredPatch(rec.file, rec.file, before, after, '', '', { context: 3 }).hunks;
  const changed = (h: { lines: string[] }) => h.lines.filter((l) => l.startsWith('+') || l.startsWith('-')).length;
  const total = hunks.reduce((n, h) => n + changed(h), 0);
  if (total <= maxLines) {
    return { before, after, shownHunks: hunks.length, totalHunks: hunks.length, omittedLines: 0 };
  }
  // Line-by-line rather than hunk-by-hunk: ONE hunk can be the whole rewrite (measured on a real
  // session: a single 13,083-line hunk), so a budget that only stops between hunks never stops.
  //
  // The budget is spent PER SIDE, half each. A unified hunk lists every `-` before every `+`, so a
  // single running counter spends the whole budget on removals and hands the reader a preview that
  // reads "−200 +0" for an edit the panel calls +500 −500 — Claude deleting a function and writing
  // nothing. Two counters make the window the first N removed lines against the first N added ones,
  // which is what the shape of a rewrite actually looks like.
  const half = Math.max(1, Math.floor(maxLines / 2));
  const b: string[] = [];
  const a: string[] = [];
  let spentDel = 0;
  let spentAdd = 0;
  let shown = 0;
  for (const h of hunks) {
    if (spentDel >= half && spentAdd >= half) break;
    let took = 0;
    for (const line of h.lines) {
      // `\ No newline at end of file` is diff METADATA, not content — emitting it would put a line
      // in the review that exists in neither blob.
      if (line.startsWith('\\')) continue;
      const text = line.slice(1);
      if (line.startsWith('-')) {
        if (spentDel >= half) continue;
        b.push(text);
        spentDel++;
      } else if (line.startsWith('+')) {
        if (spentAdd >= half) continue;
        a.push(text);
        spentAdd++;
      } else {
        // Context rides along only while there is still room on both sides, or a long tail of
        // unchanged lines would pad a preview whose changes are already cut.
        if (spentDel >= half && spentAdd >= half) continue;
        b.push(text);
        a.push(text);
      }
      took++;
    }
    if (took) shown++;
  }
  const omitted = total - spentDel - spentAdd;
  // Markers are IDENTICAL on both sides — one that differed would render as a change the agent never
  // made — and they carry what a windowed view otherwise loses: where in the file this starts (the
  // preview's own line numbers count from 1), and how much is not here.
  const head = `⋯ preview of #${rec.id} from line ${hunks[0]?.newStart ?? 1} — hunk${shown === 1 ? '' : 's'} 1–${shown} of ${hunks.length} ⋯`;
  const tail = `⋯ ${omitted.toLocaleString()} more changed line${omitted === 1 ? '' : 's'} — open the full diff for #${rec.id} ⋯`;
  return {
    before: [head, ...b, tail].join('\n') + '\n',
    after: [head, ...a, tail].join('\n') + '\n',
    shownHunks: shown,
    totalHunks: hunks.length,
    omittedLines: omitted,
  };
}

/** ANSI-colored unified diff for one edit, ready to print to a terminal. */
export function coloredDiff(sessionId: string, rec: EditRecord, color = true): string {
  // A binary change has no unified diff — one honest line naming the size transition stands in.
  const bin = binaryChange(sessionId, rec);
  if (bin) return color ? `${DIM}${bin.summary}${RESET}` : bin.summary;
  const before = blobText(sessionId, rec.beforeBlob);
  const after = blobText(sessionId, rec.afterBlob);
  const patch = createPatch(rec.file, before, after);
  if (!color) return patch;
  return patch
    .split('\n')
    .map((line) => {
      if (line.startsWith('+++') || line.startsWith('---')) return DIM + line + RESET;
      if (line.startsWith('@@')) return CYAN + line + RESET;
      if (line.startsWith('+')) return GREEN + line + RESET;
      if (line.startsWith('-')) return RED + line + RESET;
      return line;
    })
    .join('\n');
}


/**
 * A path relative to the workspace, for display.
 *
 * Renderers must never shorten a path by guessing. The terminal's guess kept the last two segments
 * at every width, so `packages/core/src/x.ts` and `packages/cli/src/x.ts` both read as `src/x.ts` —
 * two different files, indistinguishable, in a tool for deciding whether to revert one of them.
 * Outside the workspace the absolute path is returned UNCHANGED: it is genuinely elsewhere, and
 * saying so is the point.
 */
export function relPath(cwd: string, file: string): string {
  if (!file) return file;
  // The trailing-slash strip is a backwards scan, not `/\/+$/`: that shape re-tries from every
  // position, so a path ending in a long run of slashes is quadratic. This runs over transcript paths.
  const norm = (s: string) => {
    const f = s.replace(/\\/g, '/');
    let end = f.length;
    while (end > 0 && f[end - 1] === '/') end--;
    return end === f.length ? f : f.slice(0, end);
  };
  const root = norm(cwd);
  const f = norm(file);
  return f === root || f.startsWith(root + '/') ? f.slice(root.length + 1) || f : file;
}

// ── Markdown, the CLI's slice of it — ONE tokenizer, three renderers ──────────────────────────────
// The agent's prose (feed reasoning, the pinned "said" block, a drive's streamed reply) arrives as
// markdown, and every surface was printing it raw. This is the shared tokenizer; the TUI renders
// the spans as ANSI, the VS Code webview as HTML (a hand mirror — the script literal cannot import
// core), and the JetBrains plugin as SimpleColoredComponent fragments (model/Md.kt, a commented
// mirror). Deliberately the CLI's slice: **bold**, *italic*/_italic_, `code`, per-line #/##
// headings, -/*/• and "1." bullets, > quotes, and ``` fences — never a full HTML pipeline.

export interface MdSpan {
  t: string;
  b?: boolean;
  i?: boolean;
  c?: boolean;
}

/** Inline tokenize ONE line: bold/italic/code. Unclosed markers stay literal (a streamed chunk can
 *  end mid-**bold** — the CLI shows the marker until it closes, and so do we). */
export function mdInline(line: string): MdSpan[] {
  const out: MdSpan[] = [];
  let i = 0;
  let plain = '';
  const flush = (): void => {
    if (plain) out.push({ t: plain });
    plain = '';
  };
  while (i < line.length) {
    const rest = line.slice(i);
    if (rest.startsWith('`')) {
      const end = line.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ t: line.slice(i + 1, end), c: true });
        i = end + 1;
        continue;
      }
    }
    if (rest.startsWith('**')) {
      const end = line.indexOf('**', i + 2);
      if (end > i + 1) {
        flush();
        for (const s of mdInline(line.slice(i + 2, end))) out.push({ ...s, b: true });
        i = end + 2;
        continue;
      }
    }
    if ((rest.startsWith('*') && !rest.startsWith('**')) || rest.startsWith('_')) {
      const mark = line[i];
      const end = line.indexOf(mark, i + 1);
      // An italic run must close on the same line and not look like a bare asterisk in prose.
      if (end > i + 1 && line[i + 1] !== ' ' && line[end - 1] !== ' ') {
        flush();
        for (const s of mdInline(line.slice(i + 1, end))) out.push({ ...s, i: true });
        i = end + 1;
        continue;
      }
    }
    plain += line[i];
    i++;
  }
  flush();
  return out;
}

export interface MdLine {
  kind: 'h' | 'bullet' | 'quote' | 'p';
  /** heading level 1-6, or bullet indent depth (spaces/2). */
  depth: number;
  /** The line with its block marker stripped — what mdInline runs over. */
  text: string;
}

/** Classify ONE line's block role. Fences are the CALLER's state (a line of ``` toggles code mode,
 *  in which nothing here applies). */
export function mdClassify(line: string): MdLine {
  const h = /^(#{1,6})\s+(.*)$/.exec(line);
  if (h) return { kind: 'h', depth: h[1].length, text: h[2] };
  const b = /^(\s*)([-*•]|\d{1,2}[.)])\s+(.*)$/.exec(line);
  if (b) return { kind: 'bullet', depth: Math.floor(b[1].length / 2), text: b[3] };
  const q = /^>\s?(.*)$/.exec(line);
  if (q) return { kind: 'quote', depth: 0, text: q[1] };
  return { kind: 'p', depth: 0, text: line };
}

/** A fence line (``` or ```lang) — the caller toggles code mode on it and prints the body verbatim. */
export function mdIsFence(line: string): boolean {
  return /^\s*```/.test(line);
}

/**
 * A title as ONE line of plain text, whatever it was made from: a rename, a Codex thread name, a
 * rollout title, an ai-title, a first prompt. A markdown heading keeps its words and loses its markers
 * (`## Plan ##` reads `Plan`), a setext underline (`===`, `---`) goes, and every run of whitespace,
 * line breaks included, becomes one space. Every session-title producer ends here, so no list, tab or
 * header shows `## …` or a title broken across lines.
 */
export function plainTitle(raw: string): string {
  return raw
    .replace(/^[ \t]*#{1,6}(?=[ \t]|$)(.*?)(?:[ \t]+#+)?[ \t]*$/gm, '$1')
    .replace(/^[ \t]*(?:=+|-+)[ \t]*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Tables ─────────
// The CLI's slice again: pipe rows, one alignment separator under the header. Agents emit tables
// PRE-PADDED (each cell space-aligned), so a renderer that keeps cell padding and restyles the
// pipes reads aligned in any monospace context; block renderers with the whole text in hand
// (the webview, the said panes) can build a real table instead.

/** A table row: starts with `|` (after indent) and has at least one more pipe. */
export function mdIsTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith('|') && t.indexOf('|', 1) > 0;
}

/** The header/body divider (`|---|:--:|`): pipes, dashes, colons, spaces — nothing else. */
export function mdIsTableSep(line: string): boolean {
  const t = line.trim();
  return mdIsTableRow(line) && /-/.test(t) && /^[|\s:-]+$/.test(t);
}

/** Cell texts of one row, trimmed — for renderers building a REAL table (padding is theirs). */
export function mdTableCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}
