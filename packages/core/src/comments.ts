/**
 * Line comments on a pending edit, batched into ONE prompt for the agent.
 *
 * The review loop that mattered most in the herdr ecosystem: mark up an agent's pending edits with
 * line comments, then hand them all back as a single prompt. Anchored on oak's own review-unit id
 * plus a line number — no git-line rebasing — and DRAFTED into the composer, never auto-submitted
 * (the human presses send). A comment is "sent" once it has been batched into a delivered prompt, so
 * the same note never rides two prompts. Human comments only; nothing here calls a model.
 *
 * Store: `changemap-cache/<session>/comments.json`, written directly (tmp+rename), NOT through the
 * `persisted()` recompute cache — a comment is authored, not derived. It is per-session review-state:
 * dropped with the session (a dropped session has no pending edits to comment on), and the same
 * dropped-session guard the derived caches use keeps a read from resurrecting a cleaned store.
 */
import * as fs from 'fs';
import * as path from 'path';
import { isSafeSessionId, logPath, rootDir, findRecord, blobText, type EditRecord } from './store';
import { reviewEdits } from './groups';
import { pairKeyOf } from './derived';
import { relPath } from './format';

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
  return path.join(rootDir(), 'changemap-cache', session, 'comments.json');
}

export function readComments(session: string): ReviewComment[] {
  const file = commentsPath(session);
  if (!file) return [];
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as CommentStore;
    if (j && j.version === COMMENTS_VERSION && Array.isArray(j.comments)) return j.comments;
  } catch {
    /* absent, truncated, or from another version — no comments */
  }
  return [];
}

function writeComments(session: string, comments: ReviewComment[]): void {
  const file = commentsPath(session);
  // A DROPPED SESSION IS NEVER RESURRECTED (mirrors derived.ts): `clean --drop` removes the store and
  // its caches together; a write that followed would recreate the directory behind it.
  if (!file || !fs.existsSync(logPath(session))) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: COMMENTS_VERSION, comments } satisfies CommentStore), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    /* best effort — a session whose comments cannot be written simply keeps what it had */
  }
}

/** The unit record a comment attaches to: the collapsed REVIEW unit (its synthetic net pair), or the
 *  raw record if it is not a pending unit (resolved/ungrouped). */
function unitRec(session: string, unit: number): EditRecord | null {
  return reviewEdits(session).find((r) => r.id === unit) ?? findRecord(session, unit);
}

/** Add a line comment on a pending edit. `line` 0 (or absent) is a whole-edit note. Returns null if
 *  the text is empty or the unit is unknown. */
export function addComment(session: string, opts: { unit: number; line?: number; text: string }): ReviewComment | null {
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
  const all = readComments(session);
  all.push(c);
  writeComments(session, all);
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
  const all = readComments(session);
  const next = all.filter((c) => c.id !== id);
  if (next.length === all.length) return false;
  writeComments(session, next);
  return true;
}

/** Clear all comments, or (with `sentOnly`) just the ones already delivered. Returns how many went. */
export function clearComments(session: string, opts: { sentOnly?: boolean } = {}): number {
  const all = readComments(session);
  const next = opts.sentOnly ? all.filter((c) => !c.sentAt) : [];
  writeComments(session, next);
  return all.length - next.length;
}

/** THE LEDGER WRITE: mark comments delivered so a later compose never re-sends them. */
export function markCommentsSent(session: string, ids: string[], at = Date.now()): void {
  const set = new Set(ids);
  const all = readComments(session);
  let changed = false;
  for (const c of all)
    if (set.has(c.id) && !c.sentAt) {
      c.sentAt = at;
      changed = true;
    }
  if (changed) writeComments(session, all);
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
    return t !== undefined ? t.trim().slice(0, 160) : '';
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
