/**
 * Line comments on a pending edit, batched into ONE prompt for the agent.
 *
 * The review loop that mattered most in the herdr ecosystem: mark up an agent's pending edits with
 * line comments, then hand them all back as a single prompt. Anchored on oak's own review-unit id
 * plus a line number — no git-line rebasing — and DRAFTED into the composer, never auto-submitted
 * (the human presses send). A comment is "sent" once it has been batched into a delivered prompt, so
 * the same note never rides two prompts. Human comments only; nothing here calls a model.
 *
 * Store: `<store>/<session>/comments.json`, beside the session's log, written directly (tmp+rename), NOT
 * through the `persisted()` recompute cache — a comment is authored, not derived, so it lives with the
 * session's own data rather than among the caches, and goes wherever the session goes (a store move).
 * Until 0.11.0 it lived in `changemap-cache/<session>/comments.json`, where an older build still running beside
 * this one (an editor not yet reloaded) goes on writing: the comments there are read with the session's own, and a
 * change carries them into it and removes that file. It is per-session
 * review-state: dropped with the session (a dropped session has no pending edits to comment on), and a
 * write never makes the folder of a session whose log is gone.
 */
import * as fs from 'fs';
import * as path from 'path';
import { isSafeSessionId, logPath, rootDir, storeDir, findRecord, blobText, outsideStoreMoves, withSessionLock, type EditRecord } from './store';
import { reviewEdits } from './groups';
import { pairKeyOf } from './derived';
import { relPath } from './format';
import { graphemeHead } from './graphemes';

const COMMENTS_VERSION = 1;

export interface ReviewComment {
  /** Stable id (time+rand), the handle for remove/mark-sent. */
  id: string;
  /** The review-unit (EditRecord) id this comment is on, at creation. */
  unit: number;
  /** `pairKeyOf(before, after)` of the unit — the content key, so a comment survives id churn. */
  pair: string;
  /** Absolute path of the commented file. */
  file: string;
  /** 1-based line in the edit's AFTER text; 0 = a whole-edit (file-level) note. */
  line: number;
  /** The human's comment, verbatim. */
  text: string;
  createdAt: number;
  /** The LEDGER: set once this comment has been batched into a delivered prompt, so it is never
   *  re-sent. Absent = still pending. */
  sentAt?: number;
}

interface CommentStore {
  version: number;
  comments: ReviewComment[];
}

/** Default batch template. Tokens: `{comments}` (the rendered, file-grouped list), `{count}` (how
 *  many), `{file}` (the single file's path, or "N files"). Overridable by callers later. */
const DEFAULT_TEMPLATE = 'Please address these {count} review comment(s) on {file}:\n\n{comments}';

function commentsPath(session: string): string | null {
  if (!isSafeSessionId(session)) return null;
  return path.join(storeDir(session), 'comments.json');
}

/** Where a session's comments were kept until 0.11.0, among the derived caches. */
function legacyCommentsPath(session: string): string {
  return path.join(rootDir(), 'changemap-cache', session, 'comments.json');
}

/** The comments the file `at` holds: null when it is absent, none when it is truncated or another version's. */
function commentFile(at: string): ReviewComment[] | null {
  let text: string;
  try {
    text = fs.readFileSync(at, 'utf8');
  } catch {
    return null;
  }
  try {
    const j = JSON.parse(text) as CommentStore;
    if (j && j.version === COMMENTS_VERSION && Array.isArray(j.comments)) return j.comments;
  } catch {
    /* truncated, or from another version — no comments */
  }
  return [];
}

/** The session's comments: its own file's, then those of the file kept until 0.11.0 that its own lacks. An older build
 *  still running beside this one adds there after the comments moved, and each was never shown again. */
export function readComments(session: string): ReviewComment[] {
  const file = commentsPath(session);
  if (!file) return [];
  const own = commentFile(file);
  const older = commentFile(legacyCommentsPath(session));
  if (!own) return older ?? [];
  if (!older?.length) return own;
  const ids = new Set(own.map((c) => c.id));
  return [...own, ...older.filter((c) => !ids.has(c.id))];
}

/** Write the session's comments whole. A failure throws: written "best effort", a comment that could not be saved was
 *  reported as added (`oak comment add` printed its id) and was gone at the next read. */
function writeComments(session: string, comments: ReviewComment[]): void {
  const file = commentsPath(session);
  // A DROPPED SESSION IS NEVER RESURRECTED (mirrors derived.ts): `clean --drop` removes the store and
  // its caches together; a write that followed would recreate the directory behind it.
  if (!file || !fs.existsSync(logPath(session))) throw new Error(`session ${session} has no store, so its review comments were not saved`);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: COMMENTS_VERSION, comments } satisfies CommentStore), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* the error below says what failed */
    }
    throw new Error(`the review comments of session ${session} could not be saved: ${String((e as Error)?.message || e)}`);
  }
  written++;
}

/** The writes writeComments has made: changeComments learns from it whether a change wrote the comments it read. */
let written = 0;

/** The file at `p` as a stamp that a write over it changes (a new inode, as every writer's rename makes), or null. */
function fileStamp(p: string): string | null {
  try {
    const st = fs.statSync(p);
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

/**
 * Change the session's comments: read them, let `change` work on them (it writes them when it changes them), all under
 * the session's lock, so two writers cannot both read the same comments and the second write drop what the first added.
 * Outside any store move as well, the look for the log too: read where the store had been, the comments came back
 * empty, and the write dropped every other comment. A session with no log has no comments, and none are written for it.
 *
 * The comments of the file kept until 0.11.0 are read with the session's own, so a change written carries them over,
 * and that file then goes. Not when an older build wrote it during the change (it takes no lock): what it wrote stays
 * there, for the next change to carry.
 */
function changeComments<T>(session: string, none: T, change: (all: ReviewComment[]) => T): T {
  return outsideStoreMoves(() => {
    if (!isSafeSessionId(session) || !fs.existsSync(logPath(session))) return none;
    return withSessionLock(session, () => {
      const older = legacyCommentsPath(session);
      const read = fileStamp(older);
      const writes = written;
      const out = change(readComments(session));
      if (read !== null && written !== writes && fileStamp(older) === read) {
        try {
          fs.rmSync(older, { force: true });
        } catch {
          /* left behind, it is read again: a comment it held that this change removed comes back */
        }
      }
      return out;
    });
  });
}

/** The unit record a comment attaches to: the collapsed REVIEW unit (its synthetic net pair), or the
 *  raw record if it is not a pending unit (resolved/ungrouped). */
function unitRec(session: string, unit: number): EditRecord | null {
  return reviewEdits(session).find((r) => r.id === unit) ?? findRecord(session, unit);
}

/** Add a line comment on a pending edit. `line` 0 (or absent) is a whole-edit note. Returns null if
 *  the text is empty or the unit is unknown. */
export function addComment(session: string, opts: { unit: number; line?: number; text: string }): ReviewComment | null {
  return outsideStoreMoves(() => addCommentUnguarded(session, opts));
}

/** Every comment write reads the session's comments and writes them back whole, so both happen outside any store move
 *  (outsideStoreMoves): read where the store had been, they came back empty, and the write dropped every other comment.
 *  The unit is looked up there too, and the comment added under the session's lock (changeComments). */
function addCommentUnguarded(session: string, opts: { unit: number; line?: number; text: string }): ReviewComment | null {
  const text = opts.text.trim();
  if (!text) return null;
  const rec = unitRec(session, opts.unit);
  if (!rec) return null;
  const c: ReviewComment = {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    unit: opts.unit,
    pair: pairKeyOf(rec.beforeBlob, rec.afterBlob),
    file: rec.file,
    line: opts.line && opts.line > 0 ? Math.trunc(opts.line) : 0,
    text,
    createdAt: Date.now(),
  };
  // A unit found means a log: a session whose log went since saves nothing, and says so rather than return the comment.
  const saved = changeComments(session, false, (all) => {
    all.push(c);
    writeComments(session, all);
    return true;
  });
  if (!saved) throw new Error(`session ${session} has no store, so the comment was not saved`);
  return c;
}

/** Comments, filtered and ordered by file → line → creation (the order the batch reads in). */
export function listComments(session: string, opts: { unit?: number; file?: string; unsentOnly?: boolean } = {}): ReviewComment[] {
  let cs = readComments(session);
  if (opts.unit !== undefined) cs = cs.filter((c) => c.unit === opts.unit);
  if (opts.file) cs = cs.filter((c) => c.file === opts.file);
  if (opts.unsentOnly) cs = cs.filter((c) => !c.sentAt);
  return cs.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.createdAt - b.createdAt);
}

/** How many comments are still unsent — the badge count. */
export function pendingCommentCount(session: string): number {
  return readComments(session).filter((c) => !c.sentAt).length;
}

export function removeComment(session: string, id: string): boolean {
  return changeComments(session, false, (all) => {
    const next = all.filter((c) => c.id !== id);
    if (next.length === all.length) return false;
    writeComments(session, next);
    return true;
  });
}

/** Clear all comments, or (with `sentOnly`) just the ones already delivered. Returns how many went. */
export function clearComments(session: string, opts: { sentOnly?: boolean } = {}): number {
  return changeComments(session, 0, (all) => {
    const next = opts.sentOnly ? all.filter((c) => !c.sentAt) : [];
    writeComments(session, next);
    return all.length - next.length;
  });
}

/** THE LEDGER WRITE: mark comments delivered so a later compose never re-sends them. */
export function markCommentsSent(session: string, ids: string[], at = Date.now()): void {
  changeComments(session, undefined, (all) => {
    const set = new Set(ids);
    let changed = false;
    for (const c of all)
      if (set.has(c.id) && !c.sentAt) {
        c.sentAt = at;
        changed = true;
      }
    if (changed) writeComments(session, all);
  });
}

/** Render a set of comments into one prompt body via the template. File-grouped; each comment names
 *  its line and quotes that line's current text when it can be read (best-effort). */
export function renderCommentBatch(session: string, comments: ReviewComment[], cwd: string, template = DEFAULT_TEMPLATE): string {
  const rel = (f: string) => (cwd ? relPath(cwd, f) : path.basename(f));
  const byFile = new Map<string, ReviewComment[]>();
  for (const c of comments) {
    const a = byFile.get(c.file) ?? [];
    a.push(c);
    byFile.set(c.file, a);
  }
  const afterLines = new Map<number, string[]>();
  const lineText = (c: ReviewComment): string => {
    if (c.line <= 0) return '';
    let lines = afterLines.get(c.unit);
    if (!lines) {
      const rec = unitRec(session, c.unit);
      lines = rec?.afterBlob ? blobText(session, rec.afterBlob).split('\n') : [];
      afterLines.set(c.unit, lines);
    }
    const t = lines[c.line - 1];
    return t !== undefined ? graphemeHead(t.trim(), 160) : '';
  };
  const blocks: string[] = [];
  for (const [file, cs] of byFile) {
    const rows = cs.map((c) => {
      const where = c.line > 0 ? `line ${c.line}` : 'file';
      const ctx = lineText(c);
      return ctx ? `  ${where}  \`${ctx}\`\n    ${c.text}` : `  ${where}: ${c.text}`;
    });
    blocks.push(`${rel(file)}:\n${rows.join('\n')}`);
  }
  const files = [...byFile.keys()];
  const fileTok = files.length === 1 ? rel(files[0]) : `${files.length} files`;
  return template
    .replace(/\{comments\}/g, blocks.join('\n\n'))
    .replace(/\{count\}/g, String(comments.length))
    .replace(/\{file\}/g, fileTok);
}

/**
 * Batch the UNSENT comments (optionally scoped to one unit or file) into one prompt. Returns the
 * text plus the ids it covers (for the caller to `markCommentsSent` once delivered) — or null when
 * there is nothing unsent. Does NOT mark sent itself: delivery is the caller's, so a failed hand-off
 * never spends a comment.
 */
/**
 * Quote the agent's last reply as a `> ` block for the composer (#6 quote-back; #7 annotate = quote
 * then type your note, the composer left editable after it). Reads the journalled reply, so it works
 * the same from every surface. Returns null when the agent has said nothing yet.
 */
export function quoteAgentOutput(session: string): string | null {
  const said = (require('./feed') as typeof import('./feed')).lastAgentMessage(session).lastMessage;
  if (!said || !said.trim()) return null;
  return (
    said
      .trimEnd()
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n') + '\n\n'
  );
}

export function composeCommentPrompt(
  session: string,
  opts: { unit?: number; file?: string; cwd?: string; template?: string } = {}
): { text: string; ids: string[]; files: string[] } | null {
  const cs = listComments(session, { unit: opts.unit, file: opts.file, unsentOnly: true });
  if (!cs.length) return null;
  return {
    text: renderCommentBatch(session, cs, opts.cwd ?? '', opts.template),
    ids: cs.map((c) => c.id),
    files: [...new Set(cs.map((c) => c.file))],
  };
}
