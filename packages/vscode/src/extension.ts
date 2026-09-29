/**
 * OAK — VS Code front-end.
 *
 * A sidebar over the SAME git-free store the CLI uses (~/.claude/claude-observatory/<session>/), so
 * undo/keep in either surface show up in the other. Reads the store + drives the shared surgical
 * undo engine from @oak-observatory/core. Capture itself is done by the hooks — this is review UI.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type * as cp from 'child_process'; // types only — every spawn goes through core/spawn
import * as https from 'https';
import * as os from 'os';
import * as crypto from 'crypto';
import * as core from '@oak-observatory/core';
import * as vsctm from 'vscode-textmate';
import * as oniguruma from 'vscode-oniguruma';
import { CODICON_STYLE } from './codicon';

const SCHEME = 'claude-edit'; // in-memory before/after blobs for vscode.diff

/** Sentinel for "no refresh has run yet" — distinct from `undefined`, which means "no session". */
const FIRST_REFRESH = Symbol('first-refresh');

// the agent's signature marker color for the overview ruler — a distinct coral so the agent's edits are
// recognizable at a glance and don't blend into VCS (green/blue/red) gutter markers.
const CLAUDE_MARK_COLOR = 'rgba(204, 120, 92, 0.85)';
// Whole-line tints for the inline overlay — strong enough to spot the agent's edits at a glance (green
// added, red removed), each backed by a bold matching change-bar so added vs removed read distinctly.
const ADDED_LINE_BG = 'rgba(88, 166, 100, 0.30)';
const REMOVED_LINE_BG = 'rgba(229, 83, 75, 0.30)';
// The left change-bar colors — near-opaque green/red so the edited region's edge is unmistakable.
const ADDED_BAR = 'rgba(88, 166, 100, 0.9)';
const REMOVED_BAR = 'rgba(229, 83, 75, 0.9)';

// --- inline (in-editor) overlay state ---
let inlineDecoration: vscode.TextEditorDecorationType | undefined; // gutter change-bar on changed lines
let deletionGhostDecoration: vscode.TextEditorDecorationType | undefined; // red "ghost" text showing removed lines
let annotationDecoration: vscode.TextEditorDecorationType | undefined; // right-side per-edit annotation
let heatmapDecoration: vscode.TextEditorDecorationType | undefined; // dims unmodified lines (spotlight edits)
let heatmapOn = false; // "file heatmap" toggle: dim everything except the agent's edited lines
let inlineLens: InlineLensProvider | undefined; // clickable Keep/Undo/Diff above each pending edit
const MAX_INLINE_LINES = 20000; // skip the overlay on very large files (perf)

type FolderNode = { kind: 'folder'; label: string; path: string; folders: core.TreeFolder[]; files: core.TreeFile[] };
type FileNode = { kind: 'file'; file: string; edits: core.TreeEdit[]; classes: core.TreeClass[]; loose: core.TreeEdit[] };
type ClassNode = { kind: 'class'; file: string; name: string; edits: core.TreeEdit[] };
type EditNode = { kind: 'edit'; rec: core.EditRecord; feed?: boolean }; // feed = top-level Timeline row (show file + time)
type TlRunNode = { kind: 'tlrun'; file: string; edits: core.EditRecord[] }; // Timeline run: adjacent same-file edits
type Node = FolderNode | FileNode | ClassNode | EditNode | TlRunNode;

// Active "Search edits" filter — matches on workspace-relative path; empty = show everything.
// Module-level so the Review list and the Overview ledger filter together (parity with the JetBrains service filter).
let editFilter = '';
// The rest of the filter control (extension/type narrowing) and the sort order. Module-level so the
// Overview ledger and the Traces list share one state; exts/cats are session-transient like the
// Search query, while the sort persists through core prefs. There is no regex flag: `editFilter`
// reads as a regex automatically when it carries regex syntax (core.isRegexQuery).
let filterExts: string[] = [];
let filterCats: core.FileCategory[] = [];
function currentSort(): core.SortKey {
  try {
    return core.normalizeSort(core.readPrefs(core.prefsPath()).sort) ?? 'time';
  } catch {
    return 'time';
  }
}
const filterSpecMsg = () => ({ exts: filterExts, categories: filterCats as string[] });

/** #43: `Uri.fsPath` LOWER-CASES the Windows drive letter, while store records are canonical
 *  (`C:\…`) — so a raw fsPath never matches a record path on Windows. Every record↔editor path
 *  join routes an editor-side path through here first; opening/displaying paths stays raw. */
function canonFsPath(uri: vscode.Uri): string {
  return core.canonPath(uri.fsPath);
}

function workspaceRoot(): string | undefined {
  const u = vscode.workspace.workspaceFolders?.[0]?.uri;
  return u ? canonFsPath(u) : undefined;
}

/** The active editor's file as a canonical store key (#43) — undefined when no editor is active. */
function activeEditorFile(): string | undefined {
  const u = vscode.window.activeTextEditor?.document.uri;
  return u ? canonFsPath(u) : undefined;
}

// Demo mode's session, held in MEMORY and never written to settings. Pinning through
// `claudeObservatory.session` would write .vscode/settings.json into the user's repository — a demo
// that dirties your worktree is a bug — and a pin left behind by a crash points at a session that
// demo cleanup has since deleted, leaving every panel permanently empty for a non-obvious reason.
// Auto-resolution already lands on the demo unaided (its transcript is the newest and carries
// assistant records), so this is only the guard against a real session starting mid-tour.
let demoSession: string | undefined;

/** The session the observatory shows: demo mode while it is on, else a pinned
 *  `claudeObservatory.session` override, else the newest Claude Code session for this workspace
 *  (mangled-path resolution lives in core). */
function currentSession(): string | undefined {
  if (demoSession) return demoSession;
  const pinned = vscode.workspace.getConfiguration('claudeObservatory').get<string>('session', '').trim();
  if (pinned) return pinned;
  const root = workspaceRoot();
  return root ? core.resolveSessionId(root) ?? undefined : undefined;
}

// --- session-scoped, SELF-VALIDATING caches ------------------------------------------------------
// Tree renders used to re-read log.jsonl at ~9 call sites and re-parse the session transcript (15MB
// ≈ 38ms) per NODE. These caches key every result on the source file's (mtimeMs, size), so a cache
// hit costs one stat() instead of a parse, and staleness is impossible by construction.

/**
 * The stamp of everything a CANCELLED-aware derivation depends on: the log, and the transcript that
 * fixes the ask boundaries the unit split reads.
 *
 * Caches keyed on the log alone served a stale hidden set: a boundary can appear BETWEEN existing
 * edits (a store seeded before its first ask lands, or a transcript rewrite) and change which chains
 * cancel out without the log moving a byte. `cachedTranscript` already stamps both files — this is
 * the same rule, named once so the next cache cannot forget half of it.
 */
function reviewKey(session: string): string {
  const t = core.findTranscript(workspaceRoot() ?? process.cwd(), session);
  return `${fileKey(logPath(session))}|${t ? fileKey(t) : 'none'}`;
}
function fileKey(p: string): string {
  try {
    const st = fs.statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}
function logPath(session: string): string {
  return path.join(core.storeDir(session), 'log.jsonl');
}

const logCache = new Map<string, { key: string; log: core.EditRecord[] }>();
/** readLog, memoized on log.jsonl's mtime+size. */
/**
 * The DISPLAY units — the same same-code collapse the change map draws and `sessionCounts` counts.
 *
 * Every number a reader SEES must come from here, and every id set an ACTION builds must come from
 * `cachedLog`. Mixing them is what made the activity-bar badge and the status bar say 3,067 while the
 * Overview said 2,052 for one session: `keep`/`undo` resolve a whole group, so the raw record count
 * is not the number of decisions anyone has to make. Core settled this in `sessionCounts` — these
 * three surfaces simply never followed.
 */
const reviewCache = new Map<string, { key: string; log: core.EditRecord[] }>();
function cachedReview(session: string): core.EditRecord[] {
  const key = reviewKey(session);
  const hit = reviewCache.get(session);
  if (hit && hit.key === key) return hit.log;
  const log = core.reviewEdits(session);
  reviewCache.set(session, { key, log });
  return log;
}

function cachedLog(session: string): core.EditRecord[] {
  const key = fileKey(logPath(session));
  const hit = logCache.get(session);
  if (hit && hit.key === key) return hit.log;
  const log = core.readLog(session);
  logCache.set(session, { key, log });
  return log;
}

interface TranscriptCacheEntry {
  key: string;
  reasoning: Map<number, string>;
  insights: core.TranscriptInsights;
}
const transcriptCache = new Map<string, TranscriptCacheEntry>();
/** reasoningByEdit + transcriptInsights, memoized on the transcript AND log files (correlation uses both). */
function cachedTranscript(cwd: string, session: string): TranscriptCacheEntry {
  const t = core.findTranscript(cwd, session);
  const key = `${t ? fileKey(t) : 'none'}|${fileKey(logPath(session))}`;
  const hit = transcriptCache.get(session);
  if (hit && hit.key === key) return hit;
  const entry: TranscriptCacheEntry = {
    key,
    reasoning: core.reasoningByEdit(cwd, session),
    insights: core.transcriptInsights(cwd, session),
  };
  transcriptCache.set(session, entry);
  return entry;
}

const deltaCache = new Map<string, { added: number; removed: number }>(); // an edit's delta never changes
function cachedDelta(session: string, rec: core.EditRecord): { added: number; removed: number } {
  const k = `${session}:${rec.id}`;
  let v = deltaCache.get(k);
  if (!v) {
    v = core.lineDelta(session, rec);
    if (deltaCache.size >= 2000) deltaCache.delete(deltaCache.keys().next().value!);
    deltaCache.set(k, v);
  }
  return v;
}

const blobCache = new Map<string, string>(); // content-addressed → immutable; bounded FIFO
function cachedBlob(session: string, sha: string | null): string {
  if (!sha) return '';
  const k = `${session}:${sha}`;
  let v = blobCache.get(k);
  if (v === undefined) {
    try {
      v = core.readBlob(session, sha).toString('utf8');
    } catch {
      v = '';
    }
    if (blobCache.size >= 500) blobCache.delete(blobCache.keys().next().value!);
    blobCache.set(k, v);
  }
  return v;
}

function statusIcon(status: string): vscode.ThemeIcon {
  if (status === 'kept') return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
  // 'circle-slash' (⊘) reads clearly as "reverted"; 'discard' (↩) looked like an undo *action*.
  if (status === 'undone')
    return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('descriptionForeground'));
  return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.yellow'));
}

/** Aggregate status icon for a file row: pending if any await review, else kept, else reverted. */
function aggregateIcon(edits: core.EditRecord[]): vscode.ThemeIcon {
  if (edits.some((e) => e.status === 'pending')) return statusIcon('pending');
  if (edits.some((e) => e.status === 'kept')) return statusIcon('kept');
  return statusIcon('undone');
}

/** Strike through text for reverted edits (combining long-stroke overlay — TreeItem has no strikethrough). */
function strike(s: string): string {
  return Array.from(s).map((c) => c + '̶').join('');
}

/** Synthetic per-edit URI so the FileDecorationProvider can grey kept/undone rows in every view. */
function editItemUri(rec: core.EditRecord): vscode.Uri {
  return vscode.Uri.from({ scheme: 'claude-change', path: `/${rec.id}`, query: `status=${rec.status}` });
}

/** Greys out kept + reverted edit rows across all three views (pending rows stay normal). */
class StatusDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _e = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this._e.event;
  /**
   * The reviewed session for ONE decoration pass. VS Code calls `provideFileDecoration` per visible row,
   * and resolving the session walks the project dir (~0.15 ms with 44 transcripts) — ~6 ms of blocking
   * extension-host syscalls per 40 rows, on every invalidation, even when nothing is pending. Undefined
   * means "not resolved this pass"; null means "resolved, and there is no session".
   *
   * Only the session id is cached. `pendingByFile` has its own log-stamp check, and caching THAT would
   * bypass it and leave a stale count on screen. The JetBrains plugin memoizes the same call for the same
   * reason ("currentSession() is hit per cell renderer").
   */
  private snapSession: string | null | undefined;
  refresh(): void {
    this.snapSession = undefined;
    this._e.fire(undefined);
  }
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    // Real workspace files: an amber count of edits still awaiting review, which VS Code draws in the
    // Explorer AND on the editor tab. The JetBrains plugin has shown this ("●N") since 0.8.x, and the
    // guided tour has always claimed it in both editors; here it was only ever true of the synthetic
    // tree scheme below.
    if (uri.scheme === 'file') {
      if (this.snapSession === undefined) this.snapSession = currentSession() ?? null;
      const session = this.snapSession;
      if (!session) return undefined;
      const n = pendingByFile(session).get(canonFsPath(uri))?.length ?? 0;
      if (n === 0) return undefined;
      return {
        // VS Code renders at most two characters, so past 99 the count stops being the useful part.
        badge: n > 99 ? '✦' : String(n),
        tooltip: `${n} pending agent edit${n === 1 ? '' : 's'}`,
        color: new vscode.ThemeColor('claudeObservatory.pendingBadge'),
        propagate: false, // files only — a folder badge would double-count the tree the Overview already maps
      };
    }
    if (uri.scheme !== 'claude-change') return undefined;
    const status = new URLSearchParams(uri.query).get('status');
    if (status === 'kept') return { color: new vscode.ThemeColor('disabledForeground'), tooltip: 'kept' };
    if (status === 'undone') return { color: new vscode.ThemeColor('disabledForeground'), tooltip: 'reverted' };
    return undefined; // pending -> normal
  }
}
const statusDecorations = new StatusDecorationProvider();


class BlobContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    const q = new URLSearchParams(uri.query);
    const session = q.get('s') || '';
    // `pv=<budget>` serves a BOUNDED window of the edit's diff instead of the whole blob — what the
    // "Open all in editor" rows use so one 13,000-line rewrite cannot become a wall to scroll past.
    // Both sides must be built from the same call, or their windows would not align.
    const pv = Number(q.get('pv') || 0);
    const id = editIdFromUri(uri);
    if (pv > 0 && id != null) {
      const rec = core.reviewEdits(session).find((r) => r.id === id) ?? core.findRecord(session, id);
      if (rec) {
        try {
          const p = core.previewPair(session, rec, pv);
          return uri.path.startsWith('/before/') ? p.before : p.after;
        } catch {
          /* fall through to the raw blob — a preview that cannot be built is not a reason to show nothing */
        }
      }
    }
    const blob = q.get('b') || 'empty';
    if (blob === 'empty') return '';
    try {
      return core.readBlob(session, blob).toString('utf8');
    } catch {
      return '';
    }
  }
}

/** First changed line of the DISPLAYED pair — the after document against its `pb=` before (the pair
 *  the diff is showing; resolving through reviewEdits mis-anchored raw diffs). Trim-compared,
 *  because the editor folds trim-whitespace-only lines as unchanged by default. This is where the
 *  per-diff review bar anchors: line 0 sits inside the leading hidden-unchanged fold. */
function firstChangedLine(doc: vscode.TextDocument): number {
  let line = 0;
  try {
    const q = new URLSearchParams(doc.uri.query);
    const session = q.get('s') || '';
    const pb = q.get('pb');
    // A PREVIEWED row displays a windowed pair, so the full `pb` blob is not what is on screen —
    // comparing against it mismatches at line 0 and hands back the one answer this function exists
    // to avoid. Build the same window the provider served and compare against that.
    const pv = Number(q.get('pv') || 0);
    const id = editIdFromUri(doc.uri);
    let before: string[] | null = null;
    if (pv > 0 && id != null) {
      const rec = core.reviewEdits(session).find((x) => x.id === id) ?? core.findRecord(session, id);
      if (rec) before = core.previewPair(session, rec, pv).before.split('\n');
    } else if (pb && pb !== 'empty') {
      before = core.readBlob(session, pb).toString('utf8').split('\n');
    }
    if (before) {
      const after = doc.getText().split('\n');
      while (line < after.length && before[line] !== undefined && before[line].trim() === after[line].trim()) line++;
      if (line >= after.length) line = Math.max(0, after.length - 1);
    }
  } catch {
    line = 0;
  }
  return line;
}

/**
 * Per-diff review bars INSIDE diff editors — one comment-thread band per visible claude-edit AFTER
 * document, the multi-diff ("Open all in editor") rows included: the same surface as the floating
 * review bar over a file.
 *
 * The placement was settled by elimination, and the eliminations are all verified rather than
 * assumed. The multi-diff row toolbar (`multiDiffEditor/resource/title`) and the divider hunk
 * toolbar (`diffEditor/gutter/hunk`, where VS Code draws its own → and + buttons — the placement
 * actually wanted) are BOTH proposed API in the shipped workbench source
 * (`proposed:"contribMultiDiffEditorMenus"`, `proposed:"contribDiffEditorGutterToolBarMenus"`), so a
 * published extension's entries there are dropped without a word. Code lenses render but were
 * rejected. That leaves this: a one-row band, anchored at the first CHANGED line of the displayed
 * pair so it never lands inside the leading "N hidden lines" fold.
 *
 * Threads are born with a throwaway comment and emptied immediately (the chevron trick EditPeek
 * documents at length) and never reply-able, which is what renders them as a bar rather than a
 * comment box.
 */
class DiffBars implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController('claudeObservatoryDiffBar', 'OAK Review');
  private readonly threads = new Map<string, vscode.CommentThread>();
  constructor() {
    this.controller.commentingRangeProvider = { provideCommentingRanges: () => [] };
  }
  /** Reconcile bars with the visible editors: one thread per after-doc on screen, none elsewhere. */
  sync(): void {
    const want = new Map<string, vscode.TextDocument>();
    for (const ed of vscode.window.visibleTextEditors) {
      const u = ed.document.uri;
      if (u.scheme === SCHEME && u.path.startsWith('/after/') && editIdFromUri(u) != null) want.set(u.toString(), ed.document);
    }
    for (const [k, t] of this.threads) {
      if (!want.has(k)) {
        t.dispose();
        this.threads.delete(k);
      }
    }
    for (const [k, doc] of want) {
      if (this.threads.has(k)) continue;
      const id = editIdFromUri(doc.uri)!;
      const line = firstChangedLine(doc);
      const thread = this.controller.createCommentThread(doc.uri, new vscode.Range(line, 0, line, 0), [
        { author: { name: '' }, body: '', mode: vscode.CommentMode.Preview } as vscode.Comment,
      ]);
      thread.comments = [];
      thread.canReply = false;
      // A PREVIEWED row says so on its bar and offers the whole thing — a bounded view that did not
      // announce itself would let a reviewer keep a change on the strength of a fraction of it.
      const pv = Number(new URLSearchParams(doc.uri.query).get('pv') || 0);
      thread.contextValue = pv > 0 ? 'claudeDiffEditPreview' : 'claudeDiffEdit';
      thread.label = pv > 0 ? `Agent edit #${id} — preview of the first ${pv} changed lines` : `Agent edit #${id}`;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      this.threads.set(k, thread);
    }
  }
  dispose(): void {
    for (const t of this.threads.values()) t.dispose();
    this.controller.dispose();
  }
}

/** The session a claude-edit diff URI belongs to (encoded as `s=` by `blobUri`). */
function sessionFromUri(uri: vscode.Uri | undefined): string | undefined {
  if (!uri || uri.scheme !== SCHEME) return undefined;
  const s = new URLSearchParams(uri.query).get('s');
  return s ? decodeURIComponent(s) : undefined;
}

/**
 * PER-LINE review comments on a pending edit. A second comment controller beside
 * the DiffBars button-bar: it opens the "+" on any line of a claude-edit AFTER document, stores each
 * comment through core (anchored on the URI's edit id + the line), and reloads them as threads when a
 * diff opens. "Send review comments" batches every unsent one into one prompt and DRAFTS it into the
 * Feed tab — never auto-sent, and marked sent so it never rides twice.
 */
class ReviewComments implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController('claudeObservatoryReview', 'OAK Review Comments');
  private readonly threads = new Map<string, vscode.CommentThread[]>();
  constructor() {
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) =>
        doc.uri.scheme === SCHEME && doc.uri.path.startsWith('/after/') && editIdFromUri(doc.uri) != null
          ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)]
          : [],
    };
  }
  private mk(c: core.ReviewComment): vscode.Comment {
    return { author: { name: c.sentAt ? 'you · sent' : 'you' }, body: c.text, mode: vscode.CommentMode.Preview, contextValue: c.id } as vscode.Comment;
  }
  /** One thread per stored comment on the visible after-docs; dispose threads whose doc left the screen. */
  sync(): void {
    const want = new Set<string>();
    for (const ed of vscode.window.visibleTextEditors) {
      const u = ed.document.uri;
      if (u.scheme === SCHEME && u.path.startsWith('/after/') && editIdFromUri(u) != null) {
        want.add(u.toString());
        if (!this.threads.has(u.toString())) this.load(u);
      }
    }
    for (const [k, ts] of this.threads) {
      if (!want.has(k)) {
        ts.forEach((t) => t.dispose());
        this.threads.delete(k);
      }
    }
  }
  private load(uri: vscode.Uri): void {
    const session = sessionFromUri(uri);
    const id = editIdFromUri(uri);
    if (!session || id == null) {
      this.threads.set(uri.toString(), []);
      return;
    }
    const ts: vscode.CommentThread[] = [];
    for (const c of core.listComments(session, { unit: id })) {
      const line = Math.max(0, c.line - 1);
      const t = this.controller.createCommentThread(uri, new vscode.Range(line, 0, line, 0), [this.mk(c)]);
      t.contextValue = 'claudeReviewComment';
      t.label = c.sentAt ? 'review comment · sent' : 'review comment';
      t.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      ts.push(t);
    }
    this.threads.set(uri.toString(), ts);
  }
  /** The reply-submit handler: store the typed comment and render it in its thread. */
  add(reply: vscode.CommentReply): void {
    const uri = reply.thread.uri;
    const session = sessionFromUri(uri);
    const id = editIdFromUri(uri);
    if (!session || id == null) {
      vscode.window.showWarningMessage('OAK: this line is not part of a reviewable agent edit.');
      return;
    }
    const line = (reply.thread.range?.start.line ?? 0) + 1; // core lines are 1-based; 0 = file-level
    const c = core.addComment(session, { unit: id, line, text: reply.text });
    if (!c) {
      vscode.window.showWarningMessage(`OAK: edit #${id} is no longer pending.`);
      return;
    }
    reply.thread.comments = [...reply.thread.comments, this.mk(c)];
    reply.thread.contextValue = 'claudeReviewComment';
    const key = uri.toString();
    const ts = this.threads.get(key) ?? [];
    if (!ts.includes(reply.thread)) ts.push(reply.thread);
    this.threads.set(key, ts);
  }
  dispose(): void {
    for (const ts of this.threads.values()) ts.forEach((t) => t.dispose());
    this.controller.dispose();
  }
}

// Git's own theme variables, exactly as the diff editor uses them. VS Code's markdown sanitizer allows
// style ONLY on <span>, ONLY `color;background-color;border-radius` in that order, hex or var(--vscode-*),
// and NO space after the colons — anything else silently strips the whole attribute (verified against the
// shipped workbench source; GitLens colors its +/− stats with these same vars).
const DIFF_SPAN: Record<string, string> = {
  '+': 'color:var(--vscode-gitDecoration-addedResourceForeground);background-color:var(--vscode-diffEditor-insertedTextBackground);',
  '-': 'color:var(--vscode-gitDecoration-deletedResourceForeground);background-color:var(--vscode-diffEditor-removedTextBackground);',
  '@': 'color:var(--vscode-descriptionForeground);',
};

/** A unified patch as sanitizer-safe HTML with git's diff colors: green/red text on the diff editor's
 *  translucent line fills. Lines are nbsp-padded to a common width so the fills read as full rows. */
function diffHtml(patch: string): string {
  const all = patch.split('\n');
  const start = all.findIndex((l) => l.startsWith('@@'));
  const lines = (start >= 0 ? all.slice(start) : all).join('\n').trimEnd().split('\n');
  const width = Math.min(100, Math.max(...lines.map((l) => l.length), 0) + 2);
  const html = lines.map((line) => {
    const text = (line.length < width ? line + ' '.repeat(width - line.length) : line)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/ /g, ' '); // HTML collapses runs of plain spaces — keep indentation + row padding
    const style = DIFF_SPAN[line[0] ?? ''];
    return style ? `<span style="${style}">${text}</span>` : text;
  });
  return `<code>${html.join('<br>')}</code>`;
}

/** The two review surfaces `EditPeek` renders, both as one comment thread on one controller.
 *  `bar` is the compact floating nav bar (empty body → the header row alone); `detail` is the full
 *  review bubble (diff + reasoning in the body). Only one thread is ever live, so the two can never be
 *  on screen at once — that is the whole reason they share a class instead of having one each. */
type PeekMode = 'bar' | 'detail';

/** Which review chrome auto-appears in the editor. Deliberately the same setting NAME as the JetBrains
 *  `editorReviewSurface`, and `floating`/`none` deliberately the same two spellings, so the words mean
 *  the same thing in both editors; only the VS-Code-only bubble gets a word of its own.
 *
 *  An UNRECOGNIZED value reads as the default rather than as "nothing" — the same reading
 *  `ObservatorySettings.floatingSurface` takes — because a hand-edited typo must not silently strip
 *  every review control out of the editor with no way to notice. */
function editorReviewSurface(): 'floating' | 'bubble' | 'none' {
  const v = vscode.workspace.getConfiguration('claudeObservatory').get<string>('editorReviewSurface', 'floating');
  return v === 'bubble' ? 'bubble' : v === 'none' ? 'none' : 'floating';
}

/** An inline review surface at an edit, built on the Comment API (the built-in dirty-diff peek is a closed
 *  widget: no custom buttons, broken nav; and VS Code exposes NO floating-widget API to extensions, so a
 *  comment thread is the only interactive surface that can float over code).
 *
 *  In `detail` mode it is the review bubble: the body carries the edit header + reasoning + the diff in
 *  git's colors (see diffHtml), with Keep / Undo / Chat / Prev / Next as real toolbar buttons via the
 *  comments/commentThread/title menu. In `bar` mode it is the compact floating review bar — an empty
 *  body, so the widget collapses to its header row: a live "Agent edit #12 · +8 −3 · Diff 2/5 · File 1/3"
 *  title with Keep / Undo / ⌃⌄ / ‹› / Diff / Details beside it, the VS Code answer to the PyCharm
 *  `editorFloatingToolbarProvider` bar. Prev/Next steps through the same file's pending edits. */
class EditPeek implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController('claudeObservatory', 'OAK');
  private thread: vscode.CommentThread | undefined;
  private edit: { id: number; file: string } | undefined;
  /** Which surface the live thread is. Survives `closeThread` on purpose: `afterResolve` follows in the
   *  mode it was in, and a resolve is exactly when the thread is being torn down and rebuilt. */
  private mode: PeekMode = 'detail';
  /**
   * How many `show()` calls are between their first `await` and their thread.
   *
   * `show()` awaits a document (and, when revealing, an editor), and the auto-show is re-entered on every
   * refresh and every tab switch — including the tab switch that `showTextDocument` itself causes. So a
   * Keep that carries the bar into another file can be racing an auto-sync that resolved its target from
   * a review cursor the in-flight `show()` has not parked yet, and whichever resumes last wins: the bar
   * lands on the wrong edit until the next refresh corrects it. An open in progress wins outright.
   */
  private showing = 0;
  /** The edit whose surface the reader dismissed. Cleared the moment the review moves elsewhere, so a
   *  dismissal is about THIS edit and never suppresses the bar for the rest of the session. */
  private dismissed: number | undefined;
  /**
   * Watches the live thread's collapsible state, because nothing else will.
   *
   * `followPlatformCollapse` polls — the Comment API raises no event when the reader clicks `^`. That
   * was fine only while something else was calling `syncSurface`, and the single caller runs on store
   * changes and tab switches. On a session with nothing writing — a finished review is exactly that —
   * clicking `^` produced no store change, no refresh, and therefore no poll: the bubble stayed
   * collapsed, which on screen is indistinguishable from having been hidden.
   *
   * So the surface watches itself while it is up. One enum read off an object already in memory, and
   * only while a thread exists — `closeThread` clears it, or a disposed thread keeps a timer alive.
   */
  private collapseWatch: ReturnType<typeof setInterval> | undefined;

  /**
   * Injected by `activate` (the review loop is closure-scoped, this class is not): pick the next pending
   * edit after `fromId`, session-wide and crossing files. Set only when the extension is fully wired.
   */
  pickNext: ((fromId: number) => core.EditRecord | undefined) | undefined;
  /** Injected: park the shared review cursor, so the keyboard loop and the Prompt axis continue from
   *  wherever the bubble is rather than from wherever they were left. */
  onShown: ((id: number) => void) | undefined;

  constructor() {
    // No user "add comment" affordance — we only place review threads programmatically.
    this.controller.commentingRangeProvider = { provideCommentingRanges: () => [] };
  }

  /** Pinned: the BUBBLE stays open after a resolve and carries itself to the next edit awaiting review.
   *  Governs the bubble only — the bar is a nav bar and is therefore ALWAYS pinned (see `follows`). */
  private get pinned(): boolean {
    return vscode.workspace.getConfiguration('claudeObservatory').get<boolean>('pinnedPeek', false);
  }

  /** Whether the live surface carries itself to the next pending edit after a resolve. The bar always
   *  does (a nav bar that vanished when you used it would be useless); the bubble does while pinned. */
  private get follows(): boolean {
    return this.mode === 'bar' || this.pinned;
  }

  /**
   * THE BAR IS BORN WITH A BODY, AND EMPTIED ONE STATEMENT LATER.
   *
   * What the bar wants to END as is a comment-less thread: that is what `CommentThreadWidget` renders
   * at its minimum — the header at a fixed one-row height, no body, no reply form (this class sets
   * `canReply` false). A band across the editor, which is what a review bar should be.
   *
   * Constructing it that way cost the header's dismiss glyph. VS Code picks that icon in
   * `CommentThreadHeader._fillHead`, re-read from the shipped bundle rather than trusted from an
   * older note (1.131.0, `workbench.desktop.main.js`):
   *
   *   function hOi(s){ return !!s && s.length > 0 }
   *   let o = hOi(this._commentThread.comments) ? bLo : i_n;   // chevron : TRASHCAN
   *   this._collapseAction = new tt("workbench.action.hideComment", …, o, !0, …);
   *   if (!hOi(this._commentThread.comments)) { …onDidChangeComments(() => {   // one-way upgrade
   *     hOi(this._commentThread.comments) && (this._collapseAction.class = bLo, r.clear()); }) }
   *
   * …so an empty thread got a bin that deletes nothing, on an action an extension cannot suppress or
   * restyle. The earlier note here concluded there was no third option, because "a thread outlives
   * its widget". Two facts it had wrong:
   *
   *   1. `updateCommentThread()` never re-evaluates that class — it re-reads only the label. The icon
   *      is decided once per WIDGET and never revisited, in either direction.
   *   2. This class disposes its thread and builds a fresh one on every `showInner` (see the
   *      `closeThread()` above), so no thread here outlives its widget.
   *
   * So the bar is constructed with one throwaway comment — `_fillHead` sees a non-empty thread, takes
   * the chevron, and does not even register the upgrade listener — and emptied immediately after, which
   * returns the widget to its one-row minimum with the chevron already won. The ordering is not a race:
   * `ExtHostCommentThread`'s constructor sends the initial comments INSIDE the `$createCommentThread`
   * RPC, while every later mutation goes out as a separate `$updateCommentThread`, so the renderer sees
   * a non-empty create and an empty update, in that order.
   *
   * Both halves are load-bearing and both are asserted; dropping either brings the bin back.
   */
  private barBody(): vscode.Comment[] {
    return [{ body: new vscode.MarkdownString(''), mode: vscode.CommentMode.Preview, author: { name: 'OAK' } }];
  }

  /**
   * After a resolve: either follow to the next pending edit or close (the historical bubble behaviour).
   * `resolvedId` is re-checked rather than assumed — a dirty-buffer refusal or a cancelled conflict leaves
   * the edit pending, and following away from an edit the user did not actually resolve would be a lie.
   */
  private async afterResolve(session: string, resolvedId: number): Promise<void> {
    const mode = this.mode; // closeThread() below leaves it set, but read it before anything can move it
    if (!this.follows || core.findRecord(session, resolvedId)?.status === 'pending') {
      this.closeThread();
      return;
    }
    const next = this.pickNext?.(resolvedId);
    if (!next) {
      this.closeThread();
      vscode.window.setStatusBarMessage('OAK: no pending edits to review 🎉', 3000);
      return;
    }
    await this.show(next.id, { mode });
  }

  /**
   * Open (or move) the review surface to edit `id`.
   *
   * `mode` defaults to `detail` so every existing caller keeps opening the bubble it always opened; the
   * bar is only ever requested explicitly. `reveal: false` suppresses BOTH the `showTextDocument` and the
   * `revealRange` — and with them the review-cursor park — because the auto-shown bar must not steal
   * focus or scroll the file out from under someone typing in another editor.
   */
  async show(id: number, opts?: { reveal?: boolean; mode?: PeekMode }): Promise<void> {
    this.showing++;
    try {
      await this.showInner(id, opts);
    } finally {
      this.showing--;
    }
  }

  private async showInner(id: number, opts?: { reveal?: boolean; mode?: PeekMode }): Promise<void> {
    const mode = opts?.mode ?? 'detail';
    const reveal = opts?.reveal !== false;
    const session = currentSession();
    const rec = session ? core.findRecord(session, id) : null;
    if (!session || !rec) return;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(rec.file));
    const editor = reveal ? await vscode.window.showTextDocument(doc) : undefined;
    const p = cachedPlacements(session, doc).find((pl) => pl.rec.id === id);
    const line = p ? Math.min(anchorLines(p)[0] ?? 0, Math.max(0, doc.lineCount - 1)) : 0;
    const range = new vscode.Range(line, 0, line, 0);
    this.closeThread();

    const d = cachedDelta(session, rec);
    // Nav-bar counters in the header: position among this file's pending edits (Diff axis) and among all
    // files with pending edits (File axis) — the same two axes the status-bar nav bar shows, off the same
    // two helpers, so the bar, the bubble and the status bar can never disagree about where you are.
    const filePending = pendingEditsInFile(session, rec.file);
    const diffIdx = filePending.findIndex((r) => r.id === id);
    const files = pendingFilesOf(session);
    const fileIdx = files.indexOf(rec.file);
    const diffPos = diffIdx >= 0 ? `Diff ${diffIdx + 1}/${filePending.length}` : '';
    const filePos = fileIdx >= 0 ? `File ${fileIdx + 1}/${files.length}` : '';
    // Show BOTH axes in the title (Diff n/m · File i/k), like the status-bar nav bar — File only when
    // more than one file has pending edits.
    const label =
      `Agent edit #${id}  ·  +${d.added} −${d.removed}` +
      (diffPos ? `  ·  ${diffPos}` : '') +
      (filePos && files.length > 1 ? `  ·  ${filePos}` : '');

    let body: vscode.Comment[];
    if (mode === 'bar') {
      // The bar builds NO body — which also means it never reads the transcript or runs coloredDiff.
      // That matters: this path runs on every tab switch and every store refresh, and the bubble's body
      // is by far the expensive half of this method.
      body = this.barBody();
    } else {
      const cwd = workspaceRoot();
      const why = cwd ? cachedTranscript(cwd, session).reasoning.get(id)?.trim() : undefined;
      const md = new vscode.MarkdownString();
      md.supportHtml = true; // the colored <span>s below survive the sanitizer only with this on
      md.isTrusted = false;
      md.appendMarkdown(
        `**✦ Agent edit #${id}**  ·  \`+${d.added} −${d.removed}\`  ·  ${rec.tool}` +
          (diffPos ? `  ·  ${diffPos}` : '') +
          (filePos ? `  ·  ${filePos}` : '') +
          `\n\n`
      );
      if (why) md.appendText(`💭 ${firstLine(why)}\n\n`);
      let patch = '';
      try {
        patch = core.coloredDiff(session, rec, false);
      } catch {
        patch = '';
      }
      md.appendMarkdown(diffHtml(patch));
      body = [{ body: md, mode: vscode.CommentMode.Preview, author: { name: 'OAK' } }];
    }

    const thread = this.controller.createCommentThread(doc.uri, range, body);
    // …and emptied right back out. The thread was CONSTRUCTED non-empty so the platform's appended
    // collapse action picks the chevron over the trashcan; nothing ever re-reads that choice, so
    // dropping the body now leaves a one-row header wearing the icon we wanted. See barBody().
    if (mode === 'bar') thread.comments = [];
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.canReply = false;
    thread.contextValue = mode === 'bar' ? 'claudeNavBar' : 'claudeEdit';
    // Unresolved paints the frame and the arrow in the theme's "needs attention" colour, so the bar reads
    // as a band pointing AT the edit instead of a floating rectangle. The bubble carries its own header.
    if (mode === 'bar') thread.state = vscode.CommentThreadState.Unresolved;
    thread.label = mode === 'bar' ? `✦ ${label}` : label;
    this.thread = thread;
    this.mode = mode;
    this.edit = { id, file: rec.file };
    this.watchCollapse();
    // The bar hides its steppers when there is nowhere to step, matching FloatingDiffStep.applies in
    // JetBrains: a floating widget sits on top of code, so a dead button there covers text for nothing.
    this.syncStepContext(filePending.length > 1, files.length > 1);
    if (reveal) {
      editor?.revealRange(range, vscode.TextEditorRevealType.InCenter);
      this.onShown?.(id); // an auto-show is not a navigation the reader asked for — it parks nothing
    }
  }

  /**
   * Drive the AUTO-SHOWN editor surface: park it on `id`, or close it when the active file has nothing
   * left to review (`id === undefined`). Which surface that is comes from `editorReviewSurface`.
   *
   * Re-entered on every refresh and every tab switch, so it is a no-op whenever the live thread is
   * already parked on the right edit — rebuilding the thread each tick makes it flicker.
   *
   * WHATEVER IS ALREADY PARKED ON THE TARGET EDIT IS LEFT ALONE, in whichever mode it is in. That is
   * what makes "⋯ Details" stick: the reader swapped the bar for the bubble at this edit, and the next
   * refresh must not swap it back. It is deliberately keyed on the EDIT and not on the mode — a mode
   * guard would strand a bubble the reader opened on an edit that has since been kept somewhere else,
   * suppressing the bar everywhere with no way to dismiss it (a programmatic comment thread has no close
   * button). Move to a different edit and the surface the setting names takes over again.
   *
   * Because there is exactly one `thread` field that every path funnels through, the bar and the bubble
   * can never be open at once — by construction rather than by convention.
   */
  async syncSurface(id: number | undefined): Promise<void> {
    if (this.showing > 0) return; // an open the reader triggered is in flight — see `showing`
    const surface = editorReviewSurface();
    if (surface === 'none') return; // nothing is the auto surface; explicit commands still work
    const mode: PeekMode = surface === 'bubble' ? 'detail' : 'bar';
    if (id === undefined) {
      if (this.thread) this.closeThread();
      return;
    }
    // THE COLLAPSE IS CHECKED FIRST, because it is newer information than a dismissal.
    //
    // These two were the other way round, and the `dismissed` guard swallowed the bubble's step-down:
    // `dismissed` is set whenever the BAR is collapsed, and neither `show` nor `swapTo` cleared it —
    // so once a reader had dismissed the bar at an edit, `^` on the bubble at that same edit returned
    // here and did nothing for the rest of the session. Ordering it this way costs the dismissal
    // nothing: a dismissed bar has no thread, so `followPlatformCollapse` returns false on its first
    // line and the guard below still holds.
    if (await this.followPlatformCollapse()) return;
    // A surface the reader dismissed stays dismissed until the review moves to a different edit.
    // Without this the next refresh — a keystroke away — puts it straight back, and "collapse" reads
    // as a button that does nothing.
    if (this.dismissed === id) return;
    if (this.thread && this.edit?.id === id) return;
    this.dismissed = undefined;
    await this.show(id, { reveal: false, mode });
  }

  /**
   * Honour the platform's own collapse chevron: `^` on the bubble steps DOWN to the review bar, and
   * on the bar it dismisses.
   *
   * The Comment API exposes no event for this, but the state does come back to us. Verified against
   * the shipped bundle rather than assumed — the main thread pushes it and the extension host stores
   * it on our own thread object:
   *
   *   workbench:  u.onDidChangeCollapsibleState(() => this.proxy.$updateCommentThread(
   *                 this.handle, u.commentThreadHandle, { collapseState: u.collapsibleState }))
   *   ext host:   $updateCommentThread(h, I) { … ("collapseState") && (x.collapsibleState = c(I.collapseState)) }
   *
   * So the value is polled here, on the refresh that already runs for every store change and tab
   * switch. `showInner` always creates threads Expanded, so Collapsed can only mean the reader
   * clicked it.
   *
   * Returns true when it handled the tick, so the caller does not immediately re-open what it closed.
   */
  /**
   * Poll the live thread's collapsible state, so `^` acts when it is clicked rather than whenever the
   * store next happens to change. See `collapseWatch`.
   *
   * Deliberately not `unref`'d and deliberately short: it exists for as long as a surface is on
   * screen, which is the only window in which the reader can click that chevron. `closeThread` is the
   * one exit, and `followPlatformCollapse` itself closes or re-shows, so each firing either does
   * nothing or ends this timer's reason to exist.
   */
  private watchCollapse(): void {
    if (this.collapseWatch) clearInterval(this.collapseWatch);
    this.collapseWatch = setInterval(() => {
      void this.followPlatformCollapse().catch(() => {
        /* the document went away under it; the next refresh re-resolves against whatever is open */
      });
    }, 250);
    // unref'd, like the status timer: this must never be the reason a process stays alive. The
    // extension host's lifetime is not ours to hold open, and in the test harness an un-unref'd
    // interval simply hangs the run forever — which is how this was noticed.
    this.collapseWatch.unref?.();
  }

  private async followPlatformCollapse(): Promise<boolean> {
    const t = this.thread;
    if (!t || t.collapsibleState !== vscode.CommentThreadCollapsibleState.Collapsed) return false;
    const id = this.edit?.id;
    if (this.mode === 'bar' || id === undefined) {
      // The bar is already the smallest surface, so collapsing it means "go away".
      this.dismissed = id;
      this.closeThread();
      return true;
    }
    await this.show(id, { reveal: false, mode: 'bar' });
    return true;
  }

  /** Swap the live surface to `mode` at the same edit — the bar's `⌄`. Reveals, because this one IS
   *  a click the reader made. The way back down is the platform's own `^`, via followPlatformCollapse. */
  async swapTo(mode: PeekMode): Promise<void> {
    // Clicking `⌄` is the reader asking for this surface, so a dismissal from earlier is stale. Without
    // this, swapping up to the bubble at an edit whose bar had been dismissed left `dismissed` standing
    // and the two flags disagreed about whether the surface was wanted.
    this.dismissed = undefined;
    const id = this.edit?.id;
    if (id === undefined) return;
    await this.show(id, { mode });
  }

  /** Drop whatever review chrome is on screen. Used when the reader changes `editorReviewSurface`: they
   *  just said which surface they want, so the next refresh should build that one from scratch. */
  resetSurface(): void {
    this.closeThread();
  }

  async keep(): Promise<void> {
    const s = currentSession();
    if (this.edit && s) {
      const id = this.edit.id;
      core.keepGroup(s, id); // keep the whole same-code review unit
      await this.afterResolve(s, id);
    }
  }

  async undo(): Promise<void> {
    const s = currentSession();
    if (this.edit && s) {
      const id = this.edit.id;
      await undoOne(s, id);
      await this.afterResolve(s, id);
    }
  }

  chat(): void {
    if (this.edit) void vscode.commands.executeCommand('claudeObservatory.chatEdit', this.edit.id);
  }

  /** Open THIS surface's edit as a full before ⟶ after diff tab. The bar has no diff in its body, so
   *  this is its only way to the patch; it routes through the id-based command rather than reimplementing
   *  `openDiff`, exactly as `chat()` does. */
  viewDiff(): void {
    if (this.edit) void vscode.commands.executeCommand('claudeObservatory.inlineDiff', this.edit.id);
  }

  /** Step to the prev (-1) / next (+1) pending edit in the same file, wrapping at the ends (Diff axis). */
  step(dir: 1 | -1): Promise<void> {
    const s = currentSession();
    if (!this.edit || !s) return Promise.resolve();
    const file = this.edit.file;
    const list = pendingEditsInFile(s, file);
    if (list.length === 0) return Promise.resolve();
    const idx = list.findIndex((r) => r.id === this.edit!.id);
    const target = list[((idx < 0 ? 0 : idx) + dir + list.length) % list.length];
    return this.show(target.id, { mode: this.mode }); // stepping must never change WHICH surface you are on
  }

  /** Step to the prev (-1) / next (+1) file with pending edits, opening its first pending edit (File axis). */
  stepFile(dir: 1 | -1): Promise<void> {
    const s = currentSession();
    if (!this.edit || !s) return Promise.resolve();
    const files = pendingFilesOf(s);
    if (files.length === 0) return Promise.resolve();
    const idx = files.indexOf(this.edit.file);
    const target = files[((idx < 0 ? 0 : idx) + dir + files.length) % files.length];
    const first = pendingEditsInFile(s, target)[0];
    return first ? this.show(first.id, { mode: this.mode }) : Promise.resolve();
  }

  /** Accept every pending edit in the bubble's file, then close it (Accept File). */
  acceptFile(): void {
    const s = currentSession();
    if (this.edit && s) {
      keepEditsInFile(s, this.edit.file, []);
      this.closeThread();
    }
  }

  /** Revert every pending edit in the bubble's file (dirty-guard + confirm inside), then close it. */
  async rejectFile(): Promise<void> {
    const s = currentSession();
    if (this.edit && s) {
      await undoEditsInFile(s, this.edit.file, []);
      this.closeThread();
    }
  }

  /** Publish whether the bar's Diff-axis (⌃⌄) and File-axis (‹›) steppers have anywhere to go. The two
   *  context keys are what the `claudeNavBar` menu block's when-clauses read. */
  private syncStepContext(multiEdit: boolean, multiFile: boolean): void {
    void vscode.commands.executeCommand('setContext', 'claudeObservatory.barMultiEdit', multiEdit);
    void vscode.commands.executeCommand('setContext', 'claudeObservatory.barMultiFile', multiFile);
  }

  private closeThread(): void {
    if (this.collapseWatch) {
      clearInterval(this.collapseWatch);
      this.collapseWatch = undefined;
    }
    this.thread?.dispose();
    this.thread = undefined;
    this.edit = undefined;
    this.syncStepContext(false, false);
  }

  dispose(): void {
    this.closeThread();
    this.controller.dispose();
  }
}

/** URI for one side of a diff. Path carries the real basename so VS Code picks the language mode;
 *  the optional editId rides in the query so the diff's title-bar actions can resolve their edit. */
/** `pairedBefore` (after-side only): the DISPLAYED before blob, so the code-lens anchor can find the
 *  first changed line of the exact pair on screen — resolving the before through reviewEdits instead
 *  put the lens at a line the RAW diffs (file history, revision stepping) never change, i.e. inside
 *  the hidden-unchanged fold, invisible. */
function blobUri(session: string, sha: string | null, file: string, side: string, editId?: number, pairedBefore?: string | null, preview?: number): vscode.Uri {
  const q = `s=${encodeURIComponent(session)}&b=${encodeURIComponent(sha ?? 'empty')}`
    + (editId != null ? `&e=${editId}` : '')
    + (pairedBefore !== undefined ? `&pb=${encodeURIComponent(pairedBefore ?? 'empty')}` : '')
    + (preview ? `&pv=${preview}` : '');
  return vscode.Uri.from({ scheme: SCHEME, path: `/${side}/${path.basename(file)}`, query: q });
}

/** Resolve whatever a diff toolbar handed its command — a plain URI, or a multi-diff resource object
 *  carrying one — to the URI that holds our `e=` edit id. Duck-typed (`scheme` string), NOT
 *  instanceof: the marshalled multi-diff argument is not guaranteed to be a real Uri instance, and
 *  the smoke harness's vscode mock has no Uri class at all. */
function diffArgUri(arg: unknown): vscode.Uri | undefined {
  const o = arg as { scheme?: unknown; modifiedUri?: vscode.Uri; resource?: vscode.Uri; uri?: vscode.Uri } | null | undefined;
  if (o && typeof o.scheme === 'string') return o as unknown as vscode.Uri;
  return o?.modifiedUri ?? o?.resource ?? o?.uri;
}

/** The edit id encoded in a claude-edit diff URI (the diff title-bar Keep/Undo/Chat commands get this URI). */
function editIdFromUri(uri: vscode.Uri | undefined): number | undefined {
  if (!uri || uri.scheme !== SCHEME) return undefined;
  const e = new URLSearchParams(uri.query).get('e');
  return e ? Number(e) : undefined;
}

async function openDiff(node: EditNode): Promise<void> {
  const session = currentSession();
  if (!session) return;
  const rec = node.rec;
  // Edit id on BOTH sides so the diff's title-bar commands resolve it whichever side VS Code hands them.
  const left = blobUri(session, rec.beforeBlob, rec.file, 'before', rec.id);
  const right = blobUri(session, rec.afterBlob, rec.file, 'after', rec.id, rec.beforeBlob);
  // the agent's reasoning rides in the diff title (VS Code truncates long titles, but shows what fits).
  const cwd = workspaceRoot();
  const why = cwd ? cachedTranscript(cwd, session).reasoning.get(rec.id)?.trim() : undefined;
  const head = why ? firstLine(why) : '';
  const short = head.length > 80 ? head.slice(0, 79) + '…' : head;
  const title = short ? `#${rec.id} · ${short}` : `${path.basename(rec.file)} · edit #${rec.id}`;
  // preview:false → the diff always gets its OWN tab instead of taking over the file's preview tab.
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: false });
  await applyInlineDiff();
}

/** GitLens-style unified inline diff: when enabled and the user's diff editor defaults to side-by-side,
 *  flip THIS freshly opened diff to the inline (red/green single-column) view. Uses VS Code's built-in
 *  per-editor toggle — internal + best-effort, so a missing command degrades to the global setting. */
async function applyInlineDiff(): Promise<void> {
  const on = vscode.workspace.getConfiguration('claudeObservatory').get<boolean>('inlineDiffView', true);
  if (!on) return;
  const sideBySide = vscode.workspace.getConfiguration('diffEditor').get<boolean>('renderSideBySide', true);
  if (!sideBySide) return; // already inline globally — nothing to flip
  try {
    await vscode.commands.executeCommand('toggle.diff.editorMode');
  } catch {
    /* internal command, absent on some builds — fall back to the user's global diff setting */
  }
}

/** Diff title-bar Prev/Next: from the edit id in the active diff's URI, step to the prev (-1) / next (+1)
 *  pending edit in the same file (wrapping at the ends). Cycles IN PLACE: opens the target's diff, then
 *  closes the diff tab the click came from — one diff tab no matter how far you step. */
async function stepDiffEdit(uri: vscode.Uri | undefined, dir: 1 | -1): Promise<void> {
  const s = currentSession();
  const id = editIdFromUri(uri);
  const rec = s && id != null ? core.findRecord(s, id) : null;
  if (!s || !rec) return;
  // The same stops the nav bar and the review loop use — off the raw log this walked onto a cancelled
  // chain, in a diff tab whose Keep button then acted on a change no panel admits exists.
  const stepHidden = core.cancelledMemberIds(s, 'pending');
  const list = cachedLog(s)
    .filter((r) => r.file === rec.file && r.status === 'pending' && !stepHidden.has(r.id))
    .sort((a, b) => a.id - b.id);
  if (!list.length) return;
  const idx = list.findIndex((r) => r.id === id);
  const prev = vscode.window.tabGroups?.activeTabGroup?.activeTab;
  await openDiff({ kind: 'edit', rec: list[((idx < 0 ? 0 : idx) + dir + list.length) % list.length] });
  const input = prev?.input as { modified?: vscode.Uri } | undefined;
  if (prev && input?.modified?.scheme === SCHEME) void vscode.window.tabGroups.close(prev);
}

// --- revision navigation: step a file's edit history in a current-vs-revision diff ---
const revisionCursor = new Map<string, number>(); // file fsPath -> edit id the current-vs-revision diff is parked on
let revisionFile: string | undefined; // file being stepped (survives focus landing on the diff's left pane)

/** LEFT = the full-file state EDIT produced (its afterBlob, served by BlobContentProvider); RIGHT = the
 *  live editable current file. `preview:true` reuses one diff tab across steps. */
async function openRevisionDiff(session: string, edit: core.EditRecord): Promise<void> {
  const left = blobUri(session, edit.afterBlob, edit.file, `rev-${edit.id}`);
  const right = vscode.Uri.file(edit.file);
  await vscode.commands.executeCommand('vscode.diff', left, right, `edit #${edit.id} ⟶ (this file)`, { preview: true });
}

/** Step the active file's edit revisions (dir +1 newer / -1 older), parking a per-file cursor and
 *  opening a current-vs-revision diff. Clamps at both ends — history is finite (no wrap). */
const diffRevisionStep = async (dir: 1 | -1): Promise<void> => {
  const s = currentSession();
  if (!s) return;
  const active = vscode.window.activeTextEditor?.document.uri;
  const file = active?.scheme === 'file' ? canonFsPath(active) : revisionFile; // keep target while the diff pane is focused
  if (!file) {
    vscode.window.setStatusBarMessage('OAK: open a file the agent edited to step its revisions', 3000);
    return;
  }
  revisionFile = file;
  const edits = cachedLog(s).filter((r) => r.file === file).sort((a, b) => a.id - b.id);
  if (edits.length === 0) {
    vscode.window.setStatusBarMessage('OAK: no agent edits recorded for this file', 3000);
    return;
  }
  const cur = revisionCursor.get(file);
  const base = cur === undefined ? edits.length : edits.findIndex((e) => e.id === cur); // undefined = parked "at current"
  const idx = Math.min(Math.max(base + dir, 0), edits.length - 1);
  const target = edits[idx];
  if (cur !== undefined && target.id === cur) {
    vscode.window.setStatusBarMessage(
      dir === 1 ? 'OAK: already at the latest revision' : 'OAK: already at the first revision',
      2500
    );
  }
  revisionCursor.set(file, target.id);
  await openRevisionDiff(s, target);
};

/** Open the file and scroll to where this edit currently sits, so the inline overlay is what you see. */
async function openFileAtEdit(node: EditNode): Promise<void> {
  const rec = node.rec;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(rec.file));
  const editor = await vscode.window.showTextDocument(doc);
  const session = currentSession();
  if (!session) return;
  // Take the placement the OVERLAY is already using, so the cursor lands where the decoration is. The
  // overlay composes the file's whole edit chain; placing this one edit on its own re-anchors it
  // directly against the buffer, which can pick a different line — and did, leaving the cursor on a
  // line that carries no lens (and JetBrains, which navigates through `locate`, on a third answer).
  // Prefer the added/changed lines; a pure deletion falls back to its ghost-text anchor (anchorLines).
  const placed = cachedPlacements(session, doc).find((p) => p.rec.id === rec.id);
  let targets: number[];
  if (placed) {
    targets = anchorLines(placed);
  } else {
    // Resolved (kept/undone) edits aren't in the pending overlay — place this one on its own.
    const before = rec.beforeBlob ? core.readBlob(session, rec.beforeBlob).toString('utf8') : '';
    const after = rec.afterBlob ? core.readBlob(session, rec.afterBlob).toString('utf8') : '';
    const lines = core.locateEditInCurrent(before, after, doc.getText());
    targets = lines.length
      ? lines
      : core.locateDeletionsInCurrent(before, after, doc.getText()).map((d) => d.anchor);
  }
  if (targets.length) {
    const pos = new vscode.Position(Math.min(targets[0], Math.max(0, doc.lineCount - 1)), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
}

/** True (and warns) if the file is open with unsaved edits — undoing writes to disk and would
 * either compute against stale content or be clobbered when the user next saves the buffer. */
async function blockedByDirtyBuffer(file: string): Promise<boolean> {
  const dirty = vscode.workspace.textDocuments.some((d) => canonFsPath(d.uri) === file && d.isDirty);
  if (dirty) {
    await vscode.window.showWarningMessage(
      `${path.basename(file)} has unsaved changes — save or revert it first. OAK undoes by writing to disk.`,
      { modal: true }
    );
  }
  return dirty;
}


/** The bulk-conflict note, NAMING the first refusal when the engine did (a dependent unit) — a bare
 *  count hides the one fact that tells the reader what to do next. */
function conflictNote(res: { conflicts: number; firstConflict?: string }, remedy: string): string {
  if (!res.conflicts) return '';
  const name = res.firstConflict ? ` — ${res.firstConflict.split('. ')[0]}` : '';
  return ` · ${res.conflicts} conflict(s) left (${remedy})${name}`;
}

/** A bulk revert/redo toast. Files rewritten whose status the store could not record make it a
 *  warning that names them and the command that records them — never a quiet success. */
function bulkToast(text: string, res: { unrecorded?: { message: string } }, ...items: string[]): Thenable<string | undefined> {
  return res.unrecorded
    ? vscode.window.showWarningMessage(`${text} ${res.unrecorded.message}`, ...items)
    : vscode.window.showInformationMessage(text, ...items);
}

async function undoOne(session: string, id: number): Promise<void> {
  const rec = core.findRecord(session, id);
  if (rec && (await blockedByDirtyBuffer(rec.file))) return;
  const res = core.undoGroup(session, id); // reverts the whole same-code review unit (collapsed group)
  if (res.status === 'conflict') {
    // A named-dependent refusal carries the closure (raw member ids) — offer it as ONE action
    // beside the force fallback. An ordinary conflict (manual change) keeps the single offer.
    const closure = res.closure ?? [];
    const buttons = closure.length ? ['Undo both', 'Force-restore file'] : ['Force-restore file'];
    const pick = await vscode.window.showWarningMessage(res.message, { modal: true }, ...buttons);
    if (pick === 'Undo both') {
      const r2 = core.undoScope(session, { ids: closure });
      // BOTH halves of the outcome — a phantom-guard refusal inside the closure must not read as a
      // bare "Nothing reverted" with no reason (and a conflict must not vanish either).
      const note =
        (r2.conflicts ? ` · ${r2.conflicts} conflict(s) left` : '') +
        (r2.errors ? ` · ${r2.errors} refused${r2.firstError ? ` — ${r2.firstError}` : ''}` : '');
      if (r2.undone) bulkToast(`Reverted ${r2.undone} edit(s) together${note}.`, r2);
      else vscode.window.showWarningMessage(`Nothing reverted${note}.`);
    } else if (pick === 'Force-restore file') {
      const r2 = core.restoreFile(session, id);
      // The force path can itself refuse (#43 phantom guard) — a refusal reads as a warning.
      if (!r2.ok) vscode.window.showWarningMessage(r2.message);
      else vscode.window.showInformationMessage(r2.message);
    }
    return;
  }
  // A refusal (status 'error' — e.g. the #43 phantom guard) is a warning, not an info toast: its
  // message carries the remediation pointer and must read as "this did not happen".
  if (!res.ok) vscode.window.showWarningMessage(res.message);
  else vscode.window.showInformationMessage(res.message);
}

async function redoOne(session: string, id: number): Promise<void> {
  const rec = core.findRecord(session, id);
  if (rec && (await blockedByDirtyBuffer(rec.file))) return;
  const res = core.redoGroup(session, id); // re-applies the whole review unit (collapsed group)
  if (res.status === 'conflict') {
    const pick = await vscode.window.showWarningMessage(res.message, { modal: true }, 'Force re-apply');
    if (pick === 'Force re-apply') {
      const r2 = core.reapplyFile(session, id);
      if (!r2.ok) vscode.window.showWarningMessage(r2.message);
      else vscode.window.showInformationMessage(r2.message);
    }
    return;
  }
  // As in undoOne: a refusal, or a re-apply whose status the store could not record, is a warning.
  if (!res.ok) vscode.window.showWarningMessage(res.message);
  else vscode.window.showInformationMessage(res.message);
}

/** Keep the draft on the clipboard; only the explicit Send choice submits through herdr. "Edit first…"
 *  opens the draft as a document to change before sending, as JetBrains' dialog and the TUI's
 *  composer allow; Send then submits what the document says. */
async function deliverChatPrompt(prompt: string, what: string, session = currentSession()): Promise<boolean> {
  await vscode.env.clipboard.writeText(prompt);
  const pick = await vscode.window.showInformationMessage(`${what} is on the clipboard. Send it to this session’s live agent?`, { modal: true, detail: prompt }, 'Send to agent', 'Edit first…');
  if (pick === 'Edit first…') {
    const doc = await vscode.workspace.openTextDocument({ content: prompt, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
    if ((await vscode.window.showInformationMessage(`${what}: edit the draft, then send it.`, 'Send to agent')) !== 'Send to agent' || !session) return false;
    prompt = doc.getText();
    await vscode.env.clipboard.writeText(prompt);
  } else if (pick !== 'Send to agent' || !session) return false;
  try {
    const result = await core.promptSession(session, prompt);
    if (result.sent) { void vscode.window.showInformationMessage(`${what} sent to the agent.`); return true; }
    void vscode.window.showInformationMessage(`${result.reason}. Draft kept on the clipboard.`);
  } catch (error) { void vscode.window.showErrorMessage(`Prompt failed: ${String(error)}. Draft kept on the clipboard.`); }
  return false;
}

/** Build a prompt about one edit and hand it to the reader's agent (Feed tab, else clipboard). */
async function chatAboutEdit(session: string, id: number): Promise<void> {
  const rec = core.findRecord(session, id);
  if (!rec) return;
  const before = rec.beforeBlob ? core.readBlob(session, rec.beforeBlob).toString('utf8') : '(new file)';
  const after = rec.afterBlob ? core.readBlob(session, rec.afterBlob).toString('utf8') : '(deleted)';
  const rel = vscode.workspace.asRelativePath(rec.file);
  const prompt =
    `I'm reviewing an agent change to \`${rel}\` (edit #${rec.id}, ${rec.tool}).\n\n` +
    `--- before ---\n${before}\n--- after ---\n${after}\n\n` +
    `Please explain what this change does and whether it looks correct.`;
  await deliverChatPrompt(prompt, `Prompt about edit #${rec.id}`, session);
}

/** Coerce a chatAction argument into a ChatContextRef. Accepts a bare ref (from the webview messages),
 *  an Actions action row (→ toolUseId, else its store editId), or a subagent row (→ its agentId). */
function refFromArg(arg: unknown): core.ChatContextRef | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const a = arg as {
    kind?: string;
    action?: core.ActionRecord;
    sub?: core.SubagentInfo;
    toolUseId?: string;
    editId?: number;
    agentId?: string;
    taskId?: string;
  };
  if (a.kind === 'action' && a.action)
    return a.action.toolUseId ? { toolUseId: a.action.toolUseId } : a.action.editId != null ? { editId: a.action.editId } : undefined;
  if (a.kind === 'subagent' && a.sub) return { agentId: a.sub.agentId };
  const ref: core.ChatContextRef = {};
  if (a.toolUseId) ref.toolUseId = a.toolUseId;
  if (typeof a.editId === 'number') ref.editId = a.editId;
  if (a.agentId) ref.agentId = a.agentId;
  if (a.taskId) ref.taskId = a.taskId;
  return ref.toolUseId || ref.editId != null || ref.agentId || ref.taskId ? ref : undefined;
}

/** Zero-token chat handoff for ANY action / edit / subagent / task (0.8.0): assemble the ready-to-paste
 *  prompt in-process via core's `assembleChatContext` (the SAME single-backend function the CLI's
 *  `chat-context --json` wraps — VS Code calls it directly, JetBrains shells to the CLI), copy it to the
 *  clipboard, then open the user's Claude sidebar. NEVER calls a model. */
async function chatAction(ref: core.ChatContextRef): Promise<void> {
  const session = currentSession();
  const cwd = workspaceRoot();
  if (!session || !cwd) return;
  let prompt = '';
  try {
    prompt = core.assembleChatContext(cwd, session, ref);
  } catch {
    prompt = '';
  }
  if (!prompt.trim()) {
    vscode.window.showWarningMessage('OAK: no chat context for that item.');
    return;
  }
  await deliverChatPrompt(prompt, 'Prompt', session);
}

/** Keep every pending edit in one file (shared by keepFile and keepOpenFile). Reads the RAW log so it
 *  covers every member of a collapsed review group, not just the reps the tree renders. */
function keepEditsInFile(session: string, file: string, _edits: core.EditRecord[]): void {
  // One parse, one append — a per-edit loop is quadratic and unusable on a long session.
  // Exactly what the Review list offers for this file — its header's ✓ acts on this same set. Acting
  // on more and then reporting "Kept 3 edit(s)" over a panel showing one is how a bulk verb becomes
  // untrustworthy; cancelled chains are cleared by the footer's Dismiss, which says what it does.
  const hidden = core.cancelledMemberIds(session, 'pending');
  const inFile = core.readLog(session).filter((e) => e.file === file && e.status === 'pending');
  const kept = core.setStatusMany(session, inFile.filter((e) => !hidden.has(e.id)).map((e) => e.id), 'kept').length;
  const skipped = inFile.length - kept;
  vscode.window.showInformationMessage(
    kept
      ? `Kept ${kept} edit(s) in ${path.basename(file)}.${skipped ? ` ${skipped} in cancelled-out chains left for Dismiss.` : ''}`
      : skipped
        ? `Nothing to keep in this file — its ${skipped} pending record(s) are cancelled-out chains (Dismiss clears them).`
        : 'No pending edits to keep in this file.'
  );
}

/** Surgically undo every PENDING edit in one file, newest-first, after a confirm + dirty-buffer
 *  guard (shared by undoFile and undoOpenFile). Accepted edits are left on disk — revert individually. */
async function undoEditsInFile(session: string, file: string, _edits: core.EditRecord[]): Promise<void> {
  // Raw log (not the collapsed reps) so we undo every member of a review group in the file, newest-first
  // — minus the cancelled-out chains, which are what the Review header's ✗ leaves alone too. Reverting
  // a chain that ends where it began writes the same bytes back and would still count itself out loud.
  const undoHidden = core.cancelledMemberIds(session, 'pending');
  const targets = core
    .readLog(session)
    .filter((e) => e.file === file && e.status === 'pending' && !undoHidden.has(e.id))
    .sort((a, b) => b.id - a.id);
  const base = path.basename(file);
  if (targets.length === 0) {
    vscode.window.showInformationMessage(`Nothing to undo in ${base}.`);
    return;
  }
  if (await blockedByDirtyBuffer(file)) return;
  const choice = await vscode.window.showWarningMessage(
    `Undo ${targets.length} edit(s) in ${base}? Later-overlapping edits may conflict.`,
    { modal: true },
    'Undo all'
  );
  if (choice !== 'Undo all') return;
  // By ids, not by path: `under` would sweep the cancelled members back in and undo more than the
  // dialog just counted.
  const res = core.undoScope(session, { ids: targets.map((e) => e.id) });
  bulkToast(
    `Undid ${res.undone} edit(s) in ${base}` +
      conflictNote(res, 'undo individually to force-restore') +
      (res.errors ? ` · ${res.errors} refused — ${res.firstError ?? ''}` : '') +
      '.',
    res
  );
}

/** Keep every pending edit in ONE folder bucket (exact immediate dir — the Folder axis, matching a strip
 *  tile; NOT the recursive subtree that keepEditsUnder covers). */
function keepEditsInFolder(session: string, folder: string): void {
  const kept = core.setStatusMany(
    session,
    core.readLog(session).filter((e) => e.status === 'pending' && folderLabelOf(e.file) === folder).map((e) => e.id),
    'kept'
  ).length;
  vscode.window.showInformationMessage(
    kept ? `Kept ${kept} edit(s) in ${folder || '(root)'}.` : 'No pending edits to keep in this folder.'
  );
}

/** Surgically undo every PENDING edit in ONE folder bucket (exact dir), newest-first, after a confirm +
 *  dirty-buffer guard. Uses undoScope's id set so it matches the strip tile exactly, not the subtree. */
async function undoEditsInFolder(session: string, folder: string): Promise<void> {
  const label = folder || '(root)';
  const targets = core
    .readLog(session)
    .filter((r) => r.status === 'pending' && folderLabelOf(r.file) === folder)
    .sort((a, b) => b.id - a.id);
  if (targets.length === 0) {
    vscode.window.showInformationMessage(`Nothing to undo in ${label}.`);
    return;
  }
  const dirty = [...new Set(targets.map((t) => t.file))].filter((f) =>
    vscode.workspace.textDocuments.some((d) => canonFsPath(d.uri) === f && d.isDirty)
  );
  if (dirty.length) {
    await vscode.window.showWarningMessage(
      `Save or revert unsaved changes first: ${dirty.map((f) => path.basename(f)).join(', ')}.`,
      { modal: true }
    );
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Undo ${targets.length} edit(s) in ${label}? Later-overlapping edits may conflict.`,
    { modal: true },
    'Undo all'
  );
  if (choice !== 'Undo all') return;
  const res = core.undoScope(session, { ids: targets.map((t) => t.id) });
  bulkToast(
    `Undid ${res.undone} edit(s) in ${label}` +
      conflictNote(res, 'undo individually to force-restore') +
      (res.errors ? ` · ${res.errors} refused — ${res.firstError ?? ''}` : '') +
      '.',
    res
  );
}

/**
 * Which session a toolbar bulk action acts on: the one the webview says it is scoped to, else the
 * reviewed one.
 *
 * Validated, not trusted. These verbs accept or revert every pending edit in a session, so an id
 * arriving from the webview is checked for shape before it becomes a store path, and then against the
 * set of sessions this window may actually act on. A named id that is not in that set is REFUSED, never
 * quietly redirected: falling back to the reviewed session would mean a bad id accepts or reverts a
 * DIFFERENT session's edits, which is worse than doing nothing. An empty string is the webview's own
 * "nothing selected" and resolves to the reviewed session, as the palette always did.
 */
function bulkSession(fromView: unknown): string | null {
  if (typeof fromView !== 'string' || !fromView) return currentSession() ?? null;
  if (!core.isSafeSessionId(fromView)) return null;
  const cwd = workspaceRoot();
  if (!cwd) return null;
  if (core.sessionMeta(cwd).sessions.some((r) => r.id === fromView)) return fromView;
  // The FLEET rows are sibling worktrees, and sessionMeta cannot see them: its provenance rail walks UP
  // from cwd, and a sibling worktree is never an ancestor. Validating against sessionMeta alone refused
  // every Fleet row's own Accept/Revert button while leaving it enabled — a control that can only fail.
  // The fleet listing is the same allowlist the user is looking at, so it is the right second rail.
  return core.listRepoSiblings(cwd).some((r) => r.id === fromView) ? fromView : null;
}

/** Set once in activate. Module-scope because the bulk verbs live here, outside activate's closure. */
let forceRefreshAll: (() => void) | null = null;

/** Run a bulk verb against a resolved scope, or say why it did not run. */
async function withBulkScope(sess: unknown, run: (session: string) => void | Promise<void>): Promise<void> {
  const s = bulkSession(sess);
  if (!s) {
    // Distinguish the two refusals: "you named a session I cannot act on" is a different problem from
    // "there is no session here at all", and the palette path only ever produces the second.
    vscode.window.showWarningMessage(
      typeof sess === 'string' && sess
        ? 'That session is not one of this workspace’s — nothing was changed.'
        : 'OAK: no active Claude Code session for this workspace.'
    );
    return;
  }
  await run(s);
  // force: this just changed the counts every panel is showing. An unforced refresh is dropped by the
  // Overview's 3s coalescing window, and the spawn already in flight was started BEFORE the mutation, so
  // it repaints pre-change numbers with nothing afterwards to correct them. The store watcher's own
  // unforced tick ~150ms later is exactly the case that is not enough — this is why withSession forced.
  forceRefreshAll?.();
}

function keepAllSession(session: string): void {
  // The one that mattered: 26,000 pending edits took eight minutes as a per-edit loop.
  const n = core.setStatusMany(
    session,
    core.readLog(session).filter((r) => r.status === 'pending').map((r) => r.id),
    'kept'
  ).length;
  vscode.window.showInformationMessage(n ? `Accepted ${n} edit(s).` : 'No pending edits to accept.');
}

/** Clear one session's resolved (kept/reverted) records, confirmed. Pending edits are kept.
 *
 *  A function rather than command-body code because the Overview toolbar now calls it with the session
 *  it is LABELLED with, which is not always the session `withSession` would resolve. */
async function clearResolvedSession(session: string): Promise<void> {
  const resolved = core.readLog(session).filter((r) => r.status !== 'pending').length;
  if (resolved === 0) {
    vscode.window.showInformationMessage('No resolved (kept/reverted) edits to clear.');
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Clear ${resolved} resolved (kept/reverted) edit(s)? Pending edits are kept.`,
    { modal: true },
    'Clear'
  );
  if (choice !== 'Clear') return;
  // Spawned, not in-process: clearResolved rewrites the whole log — measured ~0.8s at 8,000 records —
  // and it used to run on the host thread right after the modal closed, which is exactly when the user
  // is watching. Same seam clearCompletedTasks uses; the store watcher repaints when the file lands.
  await new Promise<void>((done) => {
    void vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Clearing resolved edits…' },
      () =>
        new Promise<void>((fin) => {
          spawnCliJson(['clean', '--resolved', '--session', session, '--json'], workspaceRoot() ?? process.cwd(), (data) => {
            // The verb's own JSON field is `cleared` (verified against the CLI, not assumed) — and a
            // null payload is a FAILED spawn (missing CLI, crash, timeout), which must never be dressed
            // as success with the precomputed count: nothing was cleared and the list will not change.
            if (data && typeof data === 'object' && 'cleared' in data)
              vscode.window.showInformationMessage(`Cleared ${(data as { cleared: number }).cleared} resolved edit(s).`);
            else vscode.window.showErrorMessage('Could not clear resolved edits — is the oak CLI installed?');
            fin();
            done();
          });
        })
    );
  });
}

async function undoAllSession(session: string): Promise<void> {
  const targets = core.readLog(session).filter((r) => r.status === 'pending').sort((a, b) => b.id - a.id);
  if (targets.length === 0) {
    vscode.window.showInformationMessage('Nothing to revert.');
    return;
  }
  const dirty = [...new Set(targets.map((t) => t.file))].filter((f) =>
    vscode.workspace.textDocuments.some((d) => canonFsPath(d.uri) === f && d.isDirty)
  );
  if (dirty.length) {
    await vscode.window.showWarningMessage(
      `Save or revert unsaved changes first: ${dirty.map((f) => path.basename(f)).join(', ')}.`,
      { modal: true }
    );
    return;
  }
  const fileCount = new Set(targets.map((t) => t.file)).size;
  const verb = `Revert ${targets.length} edit${targets.length === 1 ? '' : 's'}`;
  const choice = await vscode.window.showWarningMessage(
    `Revert all ${targets.length} edit(s) across ${fileCount} file(s) in this session?`,
    { modal: true, detail: 'This rewrites the files on disk. Overlapping edits may conflict (revert those individually to force-restore).' },
    verb
  );
  if (choice !== verb) return;
  const res = core.undoScope(session);
  bulkToast(
    `Reverted ${res.undone} edit(s)` +
      conflictNote(res, 'revert individually to force') +
      (res.errors ? ` · ${res.errors} refused — ${res.firstError ?? ''}` : '') +
      '.',
    res
  );
}

/** Re-apply every UNDONE edit in the session (the forward mirror of undoAllSession). */
async function redoAllSession(session: string): Promise<void> {
  const targets = core.readLog(session).filter((r) => r.status === 'undone').sort((a, b) => a.id - b.id);
  if (targets.length === 0) {
    vscode.window.showInformationMessage('Nothing to redo.');
    return;
  }
  const dirty = [...new Set(targets.map((t) => t.file))].filter((f) =>
    vscode.workspace.textDocuments.some((d) => canonFsPath(d.uri) === f && d.isDirty)
  );
  if (dirty.length) {
    await vscode.window.showWarningMessage(
      `Save or revert unsaved changes first: ${dirty.map((f) => path.basename(f)).join(', ')}.`,
      { modal: true }
    );
    return;
  }
  const fileCount = new Set(targets.map((t) => t.file)).size;
  const verb = `Redo ${targets.length} edit${targets.length === 1 ? '' : 's'}`;
  const choice = await vscode.window.showWarningMessage(
    `Re-apply all ${targets.length} undone edit(s) across ${fileCount} file(s)?`,
    { modal: true, detail: 'This rewrites the files on disk. Overlapping edits may conflict (redo those individually to force).' },
    verb
  );
  if (choice !== verb) return;
  const res = core.redoScope(session);
  bulkToast(
    `Re-applied ${res.redone} edit(s)` +
      conflictNote(res, 'redo individually to force') +
      '.',
    res
  );
}

// --- Task review actions — the Tasks tab's per-row Accept / Reject / Clear.
// Each resolves the task's STRICT edit set (core.taskEditIds via keepTask/undoTask): only edits made
// while the task was actually in progress are included — an edit that cannot be strictly placed is
// never swept into a task's destructive scope.

/** Accept — keep every PENDING edit in a task's strict in_progress span (task-keep). */
function keepTaskScope(session: string, taskId: string): void {
  const cwd = workspaceRoot();
  if (!cwd) return;
  const res = core.keepTask(cwd, session, taskId);
  vscode.window.showInformationMessage(
    res.kept ? `Accepted ${res.kept} edit(s) in this task.` : 'No pending edits to accept in this task.'
  );
}

/** Reject — revert every PENDING edit in a task's strict span, after a confirm + dirty-buffer
 *  guard (task-undo). Accepted edits are left on disk — revert individually. */
async function undoTaskScope(session: string, taskId: string): Promise<void> {
  const cwd = workspaceRoot();
  if (!cwd) return;
  const ids = new Set(core.taskEditIds(cwd, session, taskId));
  const targets = core.readLog(session).filter((r) => ids.has(r.id) && r.status === 'pending');
  if (targets.length === 0) {
    vscode.window.showInformationMessage('Nothing to reject in this task.');
    return;
  }
  const dirty = [...new Set(targets.map((t) => t.file))].filter((f) =>
    vscode.workspace.textDocuments.some((d) => canonFsPath(d.uri) === f && d.isDirty)
  );
  if (dirty.length) {
    await vscode.window.showWarningMessage(
      `Save or revert unsaved changes first: ${dirty.map((f) => path.basename(f)).join(', ')}.`,
      { modal: true }
    );
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Reject ${targets.length} edit(s) in this task? Overlapping edits may conflict.`,
    { modal: true },
    'Reject all'
  );
  if (choice !== 'Reject all') return;
  const res = core.undoTask(cwd, session, taskId);
  bulkToast(
    `Reverted ${res.undone} edit(s) in this task` +
      conflictNote(res, 'revert individually to force') +
      (res.errors ? ` · ${res.errors} refused — ${res.firstError ?? ''}` : '') +
      '.',
    res
  );
}

/** Clear — drop the RESOLVED (kept/undone) edits of a task's strict span (task-clear). */
function clearTaskScope(session: string, taskId: string): void {
  const cwd = workspaceRoot();
  if (!cwd) return;
  const res = core.clearResolvedIds(session, core.taskEditIds(cwd, session, taskId));
  vscode.window.showInformationMessage(
    res.cleared ? `Cleared ${res.cleared} resolved edit(s) in this task.` : 'No resolved edits to clear in this task.'
  );
}

// --- Prompt review actions — the same three ops, scoped to ONE of the user's own asks.
// A prompt owns the edits committed between it and the next one (core attributes by START time), and
// core.promptEditIds resolves the id — an index or the stable hash — to exactly that set. Same shape as
// the task ops above: resolve in core, act here, and never invent a scope the data doesn't name.

/**
 * Accept — keep every PENDING edit one prompt produced.
 *
 * `promptEditIds` answers in DISPLAY units — the representative of each review unit, not its members.
 * Acting on that set directly resolves the representative and strands the rest of its unit pending, at
 * an intermediate state no surface can name: the row disappears, the count does not. That is the exact
 * failure `core.test.js` pins as "an id set must be expanded, or a collapsed row half-resolves", and the
 * terminal already guards it (`tui/src/backend.ts`). Every id is expanded through `groupMembers` here
 * for the same reason.
 */
function keepPrompt(session: string, promptId: string): void {
  const cwd = workspaceRoot();
  if (!cwd) return;
  const ids = new Set(core.promptEditIds(cwd, session, promptId).flatMap((id) => core.groupMembers(session, id)));
  const kept = core.setStatusMany(
    session,
    core.readLog(session).filter((r) => ids.has(r.id) && r.status === 'pending').map((r) => r.id),
    'kept'
  ).length;
  vscode.window.showInformationMessage(
    kept ? `Accepted ${kept} edit(s) from this prompt.` : 'No pending edits to accept from this prompt.'
  );
}

/** Reject — revert every PENDING edit one prompt produced, after a confirm + dirty-buffer guard.
 *  Group-expanded for the same reason as `keepPrompt`: reverting a unit's representative alone leaves
 *  its earlier members applied, so the file keeps content the reader just rejected. */
async function undoPrompt(session: string, promptId: string): Promise<void> {
  const cwd = workspaceRoot();
  if (!cwd) return;
  const ids = new Set(core.promptEditIds(cwd, session, promptId).flatMap((id) => core.groupMembers(session, id)));
  const targets = core.readLog(session).filter((r) => ids.has(r.id) && r.status === 'pending');
  if (targets.length === 0) {
    vscode.window.showInformationMessage('Nothing to reject from this prompt.');
    return;
  }
  const dirty = [...new Set(targets.map((t) => t.file))].filter((f) =>
    vscode.workspace.textDocuments.some((d) => canonFsPath(d.uri) === f && d.isDirty)
  );
  if (dirty.length) {
    await vscode.window.showWarningMessage(
      `Save or revert unsaved changes first: ${dirty.map((f) => path.basename(f)).join(', ')}.`,
      { modal: true }
    );
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Reject ${targets.length} edit(s) from this prompt? Overlapping edits may conflict.`,
    { modal: true },
    'Reject all'
  );
  if (choice !== 'Reject all') return;
  const res = core.undoScope(session, { ids: targets.map((t) => t.id) });
  bulkToast(
    `Reverted ${res.undone} edit(s) from this prompt` +
      conflictNote(res, 'revert individually to force') +
      (res.errors ? ` · ${res.errors} refused — ${res.firstError ?? ''}` : '') +
      '.',
    res
  );
}

/**
 * Rewind — revert every PENDING edit from one ask ONWARD, not just the ask's own.
 *
 * The difference from Reject matters: Reject undoes what this prompt changed and leaves everything after
 * it standing, which for a prompt in the middle of a session means reverting a base that later edits were
 * built on. Rewind is the checkpoint semantic — put the tree back to before I asked for this — so it
 * takes the whole tail.
 *
 * Both counts come from `core.checkpointScope` and both are shown, because they legitimately differ: the
 * scope's ids are RAW records (a same-code group straddling the boundary is expanded whole, or it would
 * half-revert) while the Prompts rows count review units. Printing only one number would make this dialog
 * disagree with the row the reader clicked.
 */
async function rewindFromPrompt(session: string, promptId: string): Promise<void> {
  const cwd = workspaceRoot();
  if (!cwd) return;
  const scope = core.checkpointScope(cwd, session, promptId);
  // Name the ask in every message. Which ask a prompt-scoped action targets is resolved from either the
  // reader's pick or the edit under the cursor, and the two can disagree — so the most destructive verb in
  // the product states its target at the moment of commitment rather than leaving it inferable.
  const ask = core.promptWindows(cwd, session).find((r) => r.id === promptId);
  const label = ask ? `prompt #${ask.index}` : 'this prompt';
  if (scope.pending === 0) {
    vscode.window.showInformationMessage(`Nothing to rewind — no pending edits from ${label} onward.`);
    return;
  }
  const dirty = scope.files.filter((f) =>
    vscode.workspace.textDocuments.some((d) => canonFsPath(d.uri) === f && d.isDirty)
  );
  if (dirty.length) {
    await vscode.window.showWarningMessage(
      `Save or revert unsaved changes first: ${dirty.map((f) => path.basename(f)).join(', ')}.`,
      { modal: true }
    );
    return;
  }
  const units = `${scope.units} review unit${scope.units === 1 ? '' : 's'}`;
  const files = `${scope.files.length} file${scope.files.length === 1 ? '' : 's'}`;
  const choice = await vscode.window.showWarningMessage(
    `Rewind to before ${label}? This reverts ${scope.pending} pending edit(s) (${units}) across ${files} made from this ask onward — including asks after it${
      // A file deleted in one ask and re-created in the next is ONE unit, and a unit is the smallest
      // thing that can be reverted — so the rewind reaches back. The modal names it rather than
      // letting it be discovered afterwards.
      scope.fromEarlier ? `, and ${scope.fromEarlier} edit(s) from an EARLIER ask that cannot be separated from it` : ''
    } — by rewriting those files on disk. Redo can restore them. Overlapping edits may conflict.`,
    { modal: true },
    'Rewind'
  );
  if (choice !== 'Rewind') return;
  const res = core.undoScope(session, { ids: scope.ids });
  const restore = res.ids.slice(); // exactly what moved — a blanket redo would re-apply unrelated edits
  const action = await bulkToast(
    `Rewound ${res.undone} edit(s)` +
      conflictNote(res, 'revert individually to force') +
      (res.errors ? ` · ${res.errors} refused — ${res.firstError ?? ''}` : '') +
      '.',
    res,
    ...(restore.length ? ['Redo'] : [])
  );
  if (action === 'Redo') {
    const back = core.redoScope(session, { ids: restore });
    bulkToast(
      `Restored ${back.redone} edit(s)` + (back.conflicts ? ` · ${back.conflicts} conflict(s)` : '') + '.',
      back
    );
  }
}

/** Clear — drop the RESOLVED (kept/undone) edits one prompt produced. */
function clearPrompt(session: string, promptId: string): void {
  const cwd = workspaceRoot();
  if (!cwd) return;
  const res = core.clearResolvedIds(session, core.promptEditIds(cwd, session, promptId));
  vscode.window.showInformationMessage(
    res.cleared ? `Cleared ${res.cleared} resolved edit(s) from this prompt.` : 'No resolved edits to clear from this prompt.'
  );
}

/** Clear the resolved edits of EVERY settled task (edits present, none pending, none undone) — the
 *  Tasks tab's "clear completed" affordance (task-clear --completed). */
function clearCompletedTasks(session: string): void {
  const cwd = workspaceRoot();
  if (!cwd) return;
  // SPAWNED, not read in-process. A cached read is only cheap when the cache HITS, and this map's stamp
  // includes every edited file's mtime — so one save invalidates it and the "read" becomes a full
  // rebuild on the extension host: measured at 4.7 s and 1.1 GB on a 7,912-edit session, with the UI
  // frozen throughout. The Overview learned this already and spawns for exactly the same reason; a
  // subprocess blocks nothing, and this verb is rare enough that a few seconds of progress is fine.
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'OAK: finding completed tasks…' },
    () =>
      new Promise<void>((resolve) => {
        spawnCliJson(['changemap', '--json', '--root', cwd, '--session', session], cwd, (data) => {
          const map = data as { rollupByTask?: { taskId: string | null; edits: number; pending: number; undone: number }[] } | null;
          const rolls = map?.rollupByTask;
          if (!Array.isArray(rolls)) {
            vscode.window.showWarningMessage('Could not read this session’s tasks — the oak CLI did not answer.');
            resolve();
            return;
          }
          const settled = rolls.filter((t) => t.taskId !== null && t.edits > 0 && t.pending === 0 && t.undone === 0);
          if (settled.length === 0) {
            vscode.window.showInformationMessage('No completed tasks to clear.');
            resolve();
            return;
          }
          // The clear itself is a store write over an explicit id set — cheap, and safe in-process.
          let cleared = 0;
          for (const t of settled) cleared += core.clearResolvedIds(session, core.taskEditIds(cwd, session, t.taskId!)).cleared;
          vscode.window.showInformationMessage(
            cleared
              ? `Cleared ${cleared} resolved edit(s) across ${settled.length} completed task(s).`
              : 'No resolved edits to clear.'
          );
          void vscode.commands.executeCommand('claudeObservatory.refresh');
          resolve();
        });
      })
  );
}


function maybeInstallCodexHooksFromExtension(): string | null {
  try {
    const found = core.spawnToolSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], { encoding: 'utf8' });
    if (found.status !== 0 || !String(found.stdout ?? '').trim()) return null;
    const res = core.installCodexHooks(`oak capture --agent codex #${core.HOOK_MARKER}`, core.isOurCommand);
    return res.hooksJson === 'unchanged'
      ? 'codex hooks: already installed.'
      : `codex hooks ${res.hooksJson} — run \`oak init --codex\` in a terminal to live-verify they fire (codex skips untrusted hooks silently).`;
  } catch (e) {
    return `codex hooks could not be installed: ${String((e as Error)?.message || e)} — run \`oak init --codex\` in a terminal.`;
  }
}

/** Install the capture hooks into ~/.claude/settings.json (portable command), then offer a reload. */
function installHooksFromExtension(): void {
  try {
    const res = core.installHooks(`oak capture #${core.HOOK_MARKER}`);
    if (res.ledgerError) {
      // The install itself succeeded; the RECORD of it did not — and ledger-wide uninstall can
      // only clean what the ledger knows. The CLI says this out loud; so does this surface.
      vscode.window.showWarningMessage(`OAK: could not update the install ledger — ${res.ledgerError}`);
    }
    const codex = maybeInstallCodexHooksFromExtension();
    if (!res.changed) {
      vscode.window.showInformationMessage(`OAK: capture hooks are already installed.${codex ? ` ${codex}` : ''}`);
      return;
    }
    // The welcome views key on claudeObservatory.hooksInstalled — recompute without waiting for a reload.
    void vscode.commands.executeCommand('claudeObservatory.refresh');
    vscode.window
      .showInformationMessage(
        `OAK: capture hooks installed.${codex ? ` ${codex}` : ''} Reload the window so Claude Code picks them up.`,
        'Reload Window'
      )
      .then((s) => {
        if (s === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
      });
  } catch (e) {
    vscode.window.showErrorMessage(
      `Could not install hooks: ${String((e as Error)?.message || e)}. Run \`oak init\` in a terminal instead.`
    );
  }
}

function showSetup(): void {
  vscode.window
    .showInformationMessage(
      "OAK: capture hooks are not installed, so the agent's edits aren't being tracked. Install them (then reload).",
      'Install hooks',
      'Copy command'
    )
    .then((sel) => {
      if (sel === 'Install hooks') installHooksFromExtension();
      else if (sel === 'Copy command') vscode.env.clipboard.writeText('oak init');
    });
}

// --- inline overlay: gutter change-bars + right-side per-edit annotations with hover actions ---

function inlineEnabled(): boolean {
  return vscode.workspace.getConfiguration('claudeObservatory').get<boolean>('inlineReview', true);
}

interface Placement {
  rec: core.EditRecord;
  lines: number[]; // current line indices this edit occupies (empty if later fully rewritten)
  removed: core.Deletion[]; // removed hunks shown as red ghost text on their anchor line
}

/** The line to hang this edit's ✨ annotation / Keep·Undo actions on: its first changed line, or —
 *  for a pure deletion that occupies no line — the line beside its deletion ghost text. */
function anchorLines(p: Placement): number[] {
  return p.lines.length ? p.lines : p.removed.map((r) => r.anchor);
}

/** Per-file index over the session's PENDING edits — placementsFor ran an O(edits) scan of the whole
 *  log per keystroke burst; with many edits the scan dwarfed the diffs it fed. Rebuilt only when the
 *  log changes (keyed on its stamp). */
const pendingByFileCache = new Map<string, { key: string; byFile: Map<string, core.EditRecord[]> }>();
function pendingByFile(session: string): Map<string, core.EditRecord[]> {
  const key = reviewKey(session); // …and the transcript: this map now hides cancelled chains

  const hit = pendingByFileCache.get(session);
  if (hit && hit.key === key) return hit.byFile;
  const byFile = new Map<string, core.EditRecord[]>();
  // A chain that cancels out owns no line to annotate and no decision to offer, so it earns no
  // gutter mark, no ghost and no lens — the same rule the review list follows. Dropping its members
  // cannot disturb the composition below: the chain returns to the content it started from, so the
  // state before it and after it are the same text.
  const cancelled = core.cancelledMemberIds(session, 'pending');
  for (const rec of cachedLog(session)) {
    if (rec.status !== 'pending' || cancelled.has(rec.id)) continue;
    const arr = byFile.get(rec.file);
    if (arr) arr.push(rec);
    else byFile.set(rec.file, [rec]);
  }
  if (pendingByFileCache.size >= 8) pendingByFileCache.delete(pendingByFileCache.keys().next().value!);
  pendingByFileCache.set(session, { key, byFile });
  return byFile;
}

/** Every still-PENDING edit for `file`, with the current line indices it occupies. */
function placementsFor(session: string, file: string, text: string): Placement[] {
  // One composed pass over the file's whole edit chain, not two whole-buffer alignments per edit —
  // this runs on every keystroke burst. `pendingByFile` preserves log (chronological) order, which is
  // what keeps each hop one edit wide. Same core call the CLI `locate` verb makes, so both editors
  // place edits identically.
  const recs = pendingByFile(session).get(file) ?? [];
  const placed = core.locateEditsInCurrent(
    recs.length,
    (i) => ({ before: cachedBlob(session, recs[i].beforeBlob), after: cachedBlob(session, recs[i].afterBlob) }),
    text
  );
  return recs.map((rec, i) => ({ rec, lines: placed[i].lines, removed: placed[i].removed }));
}

/** placementsFor memoized per (buffer content, the file's own pending chain) — decorations, CodeLens, and hovers all ask
 *  for the same placements in the same tick, and a keystroke burst that ends where it started (undo,
 *  format-on-save round-trip) hits instead of re-diffing.
 *
 *  The content key is a full 32-bit rolling hash of the buffer, not a length+head+tail sample: editing
 *  a character in the MIDDLE of a line preserves the length, the first 32 characters and the last 32,
 *  so a sampled key could not see the change at all — and the cached placements would keep drawing a
 *  lens over a line the edit had moved. Hashing the text costs one linear pass over a file already in
 *  memory, against a diff-and-locate pass it saves. */
const placementsCache = new Map<string, { key: string; p: Placement[] }>();
function docContentKey(doc: vscode.TextDocument): string {
  const t = doc.getText();
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0; // djb2-xor, unsigned
  return `${t.length}:${h.toString(36)}`;
}
/** Wall-clock of the last real locate per file — feeds the adaptive keystroke debounce below. */
const placementCostMs = new Map<string, number>();
function cachedPlacements(session: string, doc: vscode.TextDocument): Placement[] {
  const file = canonFsPath(doc.uri); // #43: pendingByFile is keyed by canonical record paths
  // Keyed on the buffer content + THIS FILE's pending chain (ids + blob shas + count), NOT the whole
  // session log: with the log stamp in the key, a keep click in any file re-diffed every open file —
  // measured at ~353ms per hot file per click, for placements that could not have moved. The chain is
  // exactly what the placement is a function of (same identity core's locateCached uses), so a record
  // leaving pending re-diffs only the file it left.
  const recs = pendingByFile(session).get(file) ?? [];
  const chain = recs.map((r) => `${r.id}:${r.beforeBlob ?? '-'}:${r.afterBlob ?? '-'}`).join(',');
  const key = `${docContentKey(doc)}:${recs.length}:${chain}`;
  const hit = placementsCache.get(file);
  if (hit && hit.key === key) return hit.p;
  const t0 = Date.now();
  const p = placementsFor(session, file, doc.getText());
  placementCostMs.set(file, Date.now() - t0);
  if (placementsCache.size >= 50) placementsCache.delete(placementsCache.keys().next().value!);
  placementsCache.set(file, { key, p });
  return p;
}

/** The pending edit whose lines contain the active editor's cursor (for the keyboard review loop). */
function pendingAtCursor(session: string): core.EditRecord | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const line = editor.selection.active.line;
  return cachedPlacements(session, editor.document).find((p) => anchorLines(p).includes(line))?.rec;
}

/** Files with at least one pending edit, sorted by path — the nav bar's File axis (matches the Edits tree). */
function pendingFilesOf(session: string): string[] {
  const files = new Set<string>();
  for (const [file, recs] of pendingByFile(session)) if (recs.length) files.add(file);
  return [...files].sort();
}

/** One file's pending edits, oldest→newest — the nav bar's Diff axis. */
function pendingEditsInFile(session: string, file: string): core.EditRecord[] {
  // Through the same index the gutter uses, so the axis steps exactly what is annotated — a cancelled
  // chain is neither.
  return [...(pendingByFile(session).get(file) ?? [])].sort((a, b) => a.id - b.id);
}

/** A file's "folder" — the change-map's module-bucket DISPLAY LABEL (`(root)`, `(external)`, or the
 *  relative parent dir). Using the label (not the raw dir) means a Folder-axis position and a strip tile
 *  share one identity, so a tile click and the axis counter always agree. */
function folderLabelOf(file: string): string {
  const root = workspaceRoot();
  const d = path.dirname(root ? path.relative(root, file) : file);
  return core.moduleLabel(d === '.' ? '' : d);
}

/** Distinct folders (module-bucket labels) that still have pending edits, path-sorted — the Folder axis. */
function pendingFoldersOf(session: string): string[] {
  const folders = new Set<string>();
  // Through `pendingByFile`, like the File axis three lines up: two axes over the same session that
  // disagree about what is pending is the bug, not the feature.
  for (const [file, recs] of pendingByFile(session)) if (recs.length) folders.add(folderLabelOf(file));
  return [...folders].sort();
}

/** One folder's (exact bucket, not the subtree) pending edits, oldest→newest — the Folder axis members. */
function pendingEditsInFolder(session: string, folder: string): core.EditRecord[] {
  const out: core.EditRecord[] = [];
  for (const [file, recs] of pendingByFile(session)) if (folderLabelOf(file) === folder) out.push(...recs);
  return out.sort((a, b) => a.id - b.id);
}

/** A one-line red-ghost preview of removed lines: first non-blank line (trimmed, truncated), with a
 *  "…(+N)" tail when the hunk removed more than one line — VS Code can't render multi-line ghost text. */
function ghostText(lines: string[]): string {
  const head = (lines.find((l) => l.trim()) ?? '').trim();
  const shown = head.length > 60 ? head.slice(0, 59) + '…' : head;
  const more = lines.length - 1;
  return more > 0 ? `− ${shown} …(+${more})` : `− ${shown}`;
}

function decorateEditor(editor: vscode.TextEditor): void {
  if (!inlineDecoration || !annotationDecoration || !deletionGhostDecoration) return;
  const doc = editor.document;
  const session = currentSession();
  if (!inlineEnabled() || !session || doc.lineCount > MAX_INLINE_LINES) {
    editor.setDecorations(inlineDecoration, []);
    editor.setDecorations(deletionGhostDecoration, []);
    editor.setDecorations(annotationDecoration, []);
    if (heatmapDecoration) editor.setDecorations(heatmapDecoration, []);
    return;
  }
  const placements = cachedPlacements(session, doc);

  // green change-bar on every pending added/changed line
  const gutter: vscode.Range[] = [];
  const seen = new Set<number>();
  for (const p of placements) {
    for (const ln of p.lines) {
      if (ln < doc.lineCount && !seen.has(ln)) {
        seen.add(ln);
        gutter.push(doc.lineAt(ln).range);
      }
    }
  }
  editor.setDecorations(inlineDecoration, gutter);

  // removed lines shown as red "ghost" text after the surviving line they now sit on; hunks that
  // resolve to the same line merge onto one label.
  const lastLine = Math.max(0, doc.lineCount - 1);
  const ghostByLine = new Map<number, string[]>();
  for (const p of placements) {
    for (const del of p.removed) {
      const line = Math.min(del.anchor, lastLine);
      const acc = ghostByLine.get(line);
      if (acc) acc.push(ghostText(del.lines));
      else ghostByLine.set(line, [ghostText(del.lines)]);
    }
  }
  const ghosts: vscode.DecorationOptions[] = [];
  for (const [line, labels] of ghostByLine) {
    const eol = doc.lineAt(line).range.end;
    ghosts.push({
      range: new vscode.Range(eol, eol),
      renderOptions: {
        after: {
          contentText: labels.join('   '),
          color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
          fontStyle: 'italic',
          margin: '0 0 0 2ch',
        },
      },
    });
  }
  editor.setDecorations(deletionGhostDecoration, ghosts);

  // ✨ gutter icon at the START (first line) of each edit — the "Agent edited here" marker.
  const maxLine = Math.max(0, doc.lineCount - 1);
  const starLines: vscode.Range[] = [];
  const seenStar = new Set<number>();
  for (const p of placements) {
    const anchors = anchorLines(p);
    if (!anchors.length) continue;
    const first = Math.min(anchors[0], maxLine);
    if (!seenStar.has(first)) {
      seenStar.add(first);
      starLines.push(new vscode.Range(first, 0, first, 0));
    }
  }
  editor.setDecorations(annotationDecoration, starLines);

  // Heatmap / spotlight: dim every unmodified line so the agent's edited lines stand out. The "changed"
  // set is the added/changed lines (seen) plus the deletion-anchor lines.
  if (heatmapDecoration) {
    if (heatmapOn && (seen.size > 0 || ghostByLine.size > 0)) {
      const changed = new Set<number>(seen);
      for (const ln of ghostByLine.keys()) changed.add(ln);
      const dim: vscode.Range[] = [];
      let runStart = -1;
      for (let ln = 0; ln < doc.lineCount; ln++) {
        if (!changed.has(ln)) {
          if (runStart === -1) runStart = ln;
        } else if (runStart !== -1) {
          dim.push(new vscode.Range(runStart, 0, ln - 1, doc.lineAt(ln - 1).range.end.character));
          runStart = -1;
        }
      }
      if (runStart !== -1) {
        dim.push(new vscode.Range(runStart, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).range.end.character));
      }
      editor.setDecorations(heatmapDecoration, dim);
    } else {
      editor.setDecorations(heatmapDecoration, []);
    }
  }
}

/** The inline menu above each pending edit: "🔬 #N +A −R · n/m" (opens the floating review bar) ·
 *  ✓ Keep · ✗ Undo · 💬 Chat · ⧉ Diff (the same edit as a full diff tab) · ⋯ Details (the review bubble).
 *
 *  Deliberately terse. A CodeLens row can never carry a background and can never be sized: the only
 *  registered colour id is `editorCodeLens.foreground` (a dim grey), `.codelens-decoration .codicon`
 *  forces `color: currentColor !important` so a `$(codicon)` there is always that same grey, and the size
 *  comes from the global `editor.codeLensFontSize` with no per-extension override. So the row leads with
 *  an EMOJI — the one thing in a lens that escapes the dim foreground — and everything that needs to be
 *  legible (the File axis, the reasoning, the diff) lives on the bar and the bubble instead, where the
 *  font is the 13px workbench font. Each command carries a `tooltip`, which VS Code renders as a real
 *  `title=` on the lens link, so the shortened words still explain themselves. */
class InlineLensProvider implements vscode.CodeLensProvider {
  private readonly _c = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._c.event;
  refresh(): void {
    this._c.fire();
  }
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!inlineEnabled()) return [];
    const session = currentSession();
    if (!session || doc.lineCount > MAX_INLINE_LINES) return [];
    // Only the LATEST edit per anchor line gets an inline lens: several edits often land on one line
    // (a hunk edited twice), and stacking a menu per edit is noisy + ambiguous. Undoing the latest
    // surgically reveals the previous state (its lens then takes over); the full per-edit sequence for
    // a line lives in the Timeline. Keeps the inline surface to one clear action-row per line.
    const byLine = new Map<number, { rec: core.EditRecord; added: number; removed: number }>();
    for (const p of cachedPlacements(session, doc)) {
      const anchors = anchorLines(p);
      if (anchors.length === 0) continue; // later fully rewritten - no anchor line
      const line = Math.min(anchors[0], Math.max(0, doc.lineCount - 1));
      const cur = byLine.get(line);
      if (!cur || p.rec.id > cur.rec.id) {
        const d = cachedDelta(session, p.rec);
        byLine.set(line, { rec: p.rec, added: d.added, removed: d.removed });
      }
    }
    // Position counter — the Diff-axis number the status-bar nav bar shows, folded into the lens next to
    // the edit (the editor title bar can't render live text). The File axis moved to the review bar's
    // label: it needs the words "file 2 of 3" to mean anything, and there is room for them at 13px.
    const filePending = pendingEditsInFile(session, canonFsPath(doc.uri));
    const lenses: vscode.CodeLens[] = [];
    for (const [line, g] of byLine) {
      const range = new vscode.Range(line, 0, line, 0);
      const id = g.rec.id;
      const editIdx = filePending.findIndex((r) => r.id === id);
      const editPos = editIdx >= 0 ? `  ·  ${editIdx + 1}/${filePending.length}` : '';
      const where = editIdx >= 0 ? ` — edit ${editIdx + 1} of ${filePending.length} pending in this file` : '';
      // The header opens the floating review BAR (the default review surface); "⋯ Details" opens the
      // bubble, where the reasoning and the git-coloured diff live. Per-edit keep/undo is also on
      // ⌥⌘Y / ⌥⌘U and the Edits tree.
      lenses.push(new vscode.CodeLens(range, { title: `🔬 #${id}  +${g.added} −${g.removed}${editPos}`, command: 'claudeObservatory.showReviewBar', arguments: [id], tooltip: `Agent edit #${id}: +${g.added} −${g.removed}${where}. Show the review bar here.` }));
      lenses.push(new vscode.CodeLens(range, { title: `✓ Keep`, command: 'claudeObservatory.inlineKeep', arguments: [id], tooltip: `Keep edit #${id} and move on to the next one awaiting review` }));
      lenses.push(new vscode.CodeLens(range, { title: `✗ Undo`, command: 'claudeObservatory.inlineUndo', arguments: [id], tooltip: `Revert edit #${id} on disk and move on to the next one awaiting review` }));
      lenses.push(new vscode.CodeLens(range, { title: `💬 Chat`, command: 'claudeObservatory.chatEdit', arguments: [id], tooltip: `Chat about edit #${id} — copies its context, opens your agent` }));
      lenses.push(new vscode.CodeLens(range, { title: `⧉ Diff`, command: 'claudeObservatory.openDiff', arguments: [{ kind: 'edit', rec: g.rec }], tooltip: `Open edit #${id} as a before ⟶ after diff tab` }));
      lenses.push(new vscode.CodeLens(range, { title: `⋯ Details`, command: 'claudeObservatory.viewChanges', arguments: [id], tooltip: `Open the review bubble for edit #${id} — the agent's reasoning and the diff in git's colours` }));
    }
    return lenses;
  }
}

function refreshInline(): void {
  for (const ed of vscode.window.visibleTextEditors) decorateEditor(ed);
  inlineLens?.refresh();
}

// --- Observations + Suggestions tabs (reasoning from transcript + heuristics; opt-in claude -p) ---

const MD_SCHEME = 'claude-observation'; // virtual markdown docs

// One "Insights" view (was two): a "Next steps" group (heuristic suggestions + opt-in Claude) and an
// "Observations" group (one row per edit — reasoning surfaced inline, click opens the combined report).
// Observations (0.8.0, Timeline folded in) is timeline-STYLE: a recap on top, then the edit feed with
// adjacent same-file edits coalesced into ×N runs (reusing the Timeline's EditNode/TlRunNode so every
// shared Keep/Undo/Open command Just Works), then the Next-steps group at the end.
type ObsNode =
  | { kind: 'recap' }
  | { kind: 'steps' }
  | { kind: 'suggestion'; text: string }
  | { kind: 'ctxhead'; note: string; sources: core.ContextSource[] }
  | { kind: 'ctxsrc'; src: core.ContextSource }
  | EditNode
  | TlRunNode;

/** Context-source kind → codicon (tree icons: VS Code's full built-in set, not the webview subset). */
const CTX_ICON: Record<core.ContextSourceKind, string> = {
  'claude-md': 'book', memory: 'library', plan: 'checklist', skill: 'sparkle', 'compact-summary': 'fold-down',
};

/** The first non-empty line, whole: the rows that show it wrap it, as JetBrains' do (it was cut at 99
 *  characters with an ellipsis). Only the diff's tab title, which cannot wrap, shortens its own copy. */
function firstLine(s: string): string {
  return s.split('\n').find((x) => x.trim()) ?? '';
}

// 0.10.0: no longer a TreeDataProvider. The Timeline webview renders these rows (a panel container has
// no tab strip, so the three views became one window with tabs), and it renders them straight off the
// getChildren / getTreeItem below — the view-model, the grouping, the folds and the empty rows all stay
// exactly here.
class ObservationsProvider {
  /** Drop what is held for one render cycle. */
  refresh(): void {
    this.memo.clear();
    this.prefilled = false;
  }
  // Per-file review memory (cross-session), recomputed lazily each refresh cycle.
  private memo = new Map<string, core.FileMemory>();
  private prefilled = false;
  private mem(file: string): core.FileMemory {
    // Filled for the whole session in one pass on the first ask. The per-file form is memoized, but
    // each MISS still revalidates the cross-session index against every session log — a readdir, an
    // existsSync per session and a statSync per session log — which measured 383,830 stats for a
    // 3,957-file session, in the extension host, on every render. This provider asks about nearly
    // every one of those files, so it pays that whole bill unless the index is built once.
    if (!this.prefilled) {
      this.prefilled = true;
      const session = currentSession();
      if (session) {
        try {
          for (const [f, m] of core.fileMemories(new Set(cachedLog(session).map((r) => r.file)))) this.memo.set(f, m);
        } catch {
          /* fall through to the per-file path below — a slow render beats a broken one */
        }
      }
    }
    let m = this.memo.get(file);
    if (!m) {
      m = core.fileMemory(file);
      this.memo.set(file, m);
    }
    return m;
  }
  getChildren(node?: ObsNode): ObsNode[] {
    const session = currentSession();
    if (!session) return [];
    // A run expands to its per-edit rows (each with Keep/Undo + reasoning), like the Timeline did.
    if (node) {
      if (node.kind === 'tlrun') return node.edits.map((rec): EditNode => ({ kind: 'edit', rec }));
      if (node.kind === 'ctxhead') return node.sources.map((src): ObsNode => ({ kind: 'ctxsrc', src }));
      return [];
    }
    this.memo.clear(); // one memory computation per file per render cycle
    // Timeline-STYLE Observations (0.8.0): a one-line recap on top, then the edit feed newest-first with
    // adjacent same-file edits coalesced into ×N runs (each edit carrying the agent's reasoning inline),
    // then the still-open "Next steps" at the end — parity with `observations --json` and the JetBrains
    // Observations panel. The coalescing mirrors the (now folded-in) Timeline view exactly.
    const cwd = workspaceRoot();
    const log = cachedLog(session).slice().sort((a, b) => b.ts - a.ts); // newest first
    const feed: ObsNode[] = [{ kind: 'recap' }];
    for (let i = 0; i < log.length; ) {
      let j = i + 1;
      while (j < log.length && log[j].file === log[i].file) j++; // maximal same-file run
      const run = log.slice(i, j);
      feed.push(run.length === 1 ? { kind: 'edit', rec: run[0], feed: true } : { kind: 'tlrun', file: run[0].file, edits: run });
      i = j;
    }
    // What shaped this session — skills, plans, memory, instruction files. Called straight into core
    // rather than read off `observations --json`, because this view builds its whole feed in-process;
    // core memoizes the transcript fold, so what's left is a handful of existsSync probes.
    // Placed BEFORE Next steps, and its rows NEST under the header (unlike the two flat sections around
    // it), so a long list collapses as one unit instead of burying what comes after it — the same shape
    // `buildObservations` describes and the JetBrains panel draws.
    if (cwd) {
      try {
        const ctx = core.contextSources(cwd, session);
        if (ctx.sources.length) feed.push({ kind: 'ctxhead', note: ctx.note, sources: ctx.sources });
      } catch { /* unreadable transcript — the section simply doesn't appear */ }
    }
    const suggestions = [
      ...new Set([...(cwd ? core.transcriptSuggestions(cwd, session) : []), ...core.heuristicSuggestions(session)]),
    ];
    if (suggestions.length) {
      feed.push({ kind: 'steps' });
      for (const text of suggestions) feed.push({ kind: 'suggestion', text });
    }
    return feed;
  }
  /** Zero-token: Claude Code's own session title, or a Claude-refined recap once generated. */
  private recapText(): string {
    const session = currentSession();
    const cwd = workspaceRoot();
    const generated = session ? core.cachedAnalysis(session, 'recap')?.text : undefined;
    const title = cwd && session ? cachedTranscript(cwd, session).insights.title : null;
    return (generated || title || 'No recap yet — hit ✦ to generate one.').trim();
  }
  getTreeItem(node: ObsNode): vscode.TreeItem {
    const session = currentSession();
    const cwd = workspaceRoot();
    if (node.kind === 'recap') {
      // One clean line (the panel is wide; VS Code ellipsizes gracefully) with the full text on hover.
      const text = this.recapText().replace(/\s+/g, ' ');
      const item = new vscode.TreeItem(text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('compass', new vscode.ThemeColor('charts.blue'));
      item.description = 'session recap';
      const tip = new vscode.MarkdownString(
        `**Session recap**\n\n${this.recapText()}\n\n---\n\n_✦ refreshes this with a Claude-generated "what you did + where you left off" one-liner._`
      );
      item.tooltip = tip;
      item.contextValue = 'recap';
      return item; // refresh is the ✨ button (inline + view title), not a click
    }
    if (node.kind === 'steps') {
      const item = new vscode.TreeItem('Next steps', vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('lightbulb');
      item.description = "the agent's to-dos + heuristics";
      item.contextValue = 'steps';
      item.command = { command: 'claudeObservatory.showSuggestions', title: 'Suggestions' };
      return item;
    }
    if (node.kind === 'suggestion') {
      const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('arrow-small-right');
      item.tooltip = node.text;
      item.command = { command: 'claudeObservatory.showSuggestions', title: 'Suggestions' };
      return item;
    }
    if (node.kind === 'ctxhead') {
      // Folded once it runs past a handful of rows: expanded, a long Context list pushes the recap and
      // the edit feed off screen. The header keeps the count, so nothing is hidden silently.
      const count = node.sources.length;
      const item = new vscode.TreeItem(
        'Context',
        count > 5 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded
      );
      item.iconPath = new vscode.ThemeIcon('book');
      item.description = `${count} · ${node.note}`; // the caveat belongs next to the section, not buried in a hover
      item.tooltip = `${count} context source${count === 1 ? '' : 's'}\n${node.note}`;
      item.contextValue = 'ctxhead';
      return item;
    }
    if (node.kind === 'ctxsrc') {
      const src = node.src;
      const item = new vscode.TreeItem(src.label, vscode.TreeItemCollapsibleState.None);
      // The evidence tier leads the description: "transcript" rows are things the session demonstrably
      // did, "file-present" rows are files that merely sit where Claude Code auto-loads them. Blurring
      // the two would present an assumption as an observation.
      const seen = src.evidence === 'transcript' ? `transcript${src.count > 1 ? ` ×${src.count}` : ''}` : 'file-present';
      item.description = [seen, src.detail].filter(Boolean).join(' · ');
      item.iconPath = new vscode.ThemeIcon(
        CTX_ICON[src.kind] ?? 'file',
        src.evidence === 'transcript' ? new vscode.ThemeColor('charts.blue') : undefined
      );
      item.tooltip = [
        src.label,
        src.evidence === 'transcript'
          ? 'Recorded in this session’s transcript.'
          : 'Present where Claude Code auto-loads it — the injection itself is never recorded.',
        src.detail,
        src.path ? `${src.path} — click to open` : null,
      ]
        .filter(Boolean)
        .join('\n');
      item.contextValue = 'ctxsrc';
      if (src.path) item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(src.path), { preview: true }] };
      return item;
    }
    // Coalesced ×N run: adjacent same-file edits as one row (combined delta + the newest edit's reasoning).
    // Reuses the `file` context value so the run gets Keep-all / Undo-all / Clear / Open-file, like a file.
    if (node.kind === 'tlrun') {
      const newest = node.edits[0];
      const d = new Date(newest.ts);
      const hhmm = [d.getHours(), d.getMinutes()].map((x) => String(x).padStart(2, '0')).join(':');
      let added = 0;
      let removed = 0;
      if (session)
        for (const e of node.edits) {
          const dd = cachedDelta(session, e);
          added += dd.added;
          removed += dd.removed;
        }
      const reasoning = cwd && session ? cachedTranscript(cwd, session).reasoning.get(newest.id) : undefined;
      const summary = reasoning ? firstLine(reasoning) : session ? core.summarize(session, newest) : '';
      const item = new vscode.TreeItem(`${hhmm}  ${path.basename(node.file)}  ×${node.edits.length}`, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `+${added} −${removed}${summary ? ` · ${summary}` : ''}`;
      item.tooltip = `${node.file}\n${node.edits.length} edit${node.edits.length === 1 ? '' : 's'} · +${added} −${removed}${reasoning ? `\n\n${reasoning}` : ''}`;
      item.iconPath = aggregateIcon(node.edits);
      item.contextValue = 'file';
      item.resourceUri = vscode.Uri.file(node.file);
      return item;
    }
    // One observation row per edit — the agent's reasoning inline, cross-session file memory + flags on
    // hover. Click opens the single combined report (summary + reasoning + flags + analysis).
    const rec = node.rec;
    const { added, removed } = session ? cachedDelta(session, rec) : { added: 0, removed: 0 };
    const d = new Date(rec.ts);
    const hhmm = [d.getHours(), d.getMinutes()].map((n) => String(n).padStart(2, '0')).join(':');
    const flags = session ? core.flagsFor(session, rec, cachedLog(session)) : [];
    const reasoning = cwd && session ? cachedTranscript(cwd, session).reasoning.get(rec.id) : undefined;
    const summary = reasoning ? firstLine(reasoning) : session ? core.summarize(session, rec) : '';
    // Cross-session memory: this file's review track record sharpens the observation over time.
    const mem = this.mem(rec.file);
    const risky = core.isRiskyFile(mem);
    const history = core.memorySummary(mem);
    const warn = risky || flags.some((f) => f.level === 'warn');
    // Top-level (single-edit run) rows lead with `HH:MM file`; run children lead with `#id` (time in desc).
    const isFeed = node.feed === true;
    let label = isFeed ? `${hhmm}  ${path.basename(rec.file)}` : `#${rec.id}`;
    if (rec.status === 'undone') label = strike(label);
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    const timePart = isFeed ? '' : `${hhmm} · `;
    item.description = `${timePart}+${added} −${removed}${summary ? ` · ${summary}` : ''}`;
    item.iconPath = warn ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow')) : statusIcon(rec.status);
    item.tooltip = [
      reasoning ? `💭 ${reasoning}` : '',
      ...flags.map((f) => `${f.level === 'warn' ? '⚠' : 'ℹ'} ${f.message}`),
      risky ? `⚠ history: edits to this file get reverted often (${mem.undone} of ${mem.kept + mem.undone} verdicts) — review carefully` : '',
      history ? `🧠 ${history}` : '',
      `${rec.tool} · ${rec.status} · ${d.toLocaleTimeString()}`,
      'Click to open the full report.',
    ]
      .filter(Boolean)
      .join('\n');
    item.command = { command: 'claudeObservatory.showObservation', title: 'Observation', arguments: [rec.id] };
    // Reuse the shared edit/editUndone context menus (Keep / Undo / Redo / Chat / Open file).
    item.contextValue = rec.status === 'undone' ? 'editUndone' : 'edit';
    item.resourceUri = editItemUri(rec); // grey kept/undone observations, matching the other views
    return item;
  }
}

// --- Actions timeline (0.8.0 round 3) — the session's tool-call feed, MOVED out of Multitasking into
// the Observations panel as its second tab. Timeline-STYLE like Observations: collapsible category
// subsections (Edits · Commands · Reads · Searches · Egress · To-dos), each action TIMESTAMPED; an
// edit-action drills into its review. Backed by the SAME core aggregation the CLI's multitask uses
// (buildActionGroups minus the Subagents category — those are the Overview fleet's rows — + egress).
type ActNode =
  | { kind: 'agroup'; label: string; count: number; errors: number; icon: string; actions: core.ActionRecord[] }
  | { kind: 'ogroup'; writes: core.OutsideWrite[]; files: number; edits: number }
  | { kind: 'egroup'; channels: core.EgressChannel[] }
  | { kind: 'cgroup'; collisions: core.FileCollision[] }
  | { kind: 'arow'; rec: core.ActionRecord }
  | { kind: 'orow'; w: core.OutsideWrite }
  | { kind: 'erow'; ch: core.EgressChannel }
  | { kind: 'crow'; c: core.FileCollision };

/** Category → codicon for the timeline's collapsible subsection headers + rows. */
const ACTION_ICON: Record<string, string> = {
  edit: 'edit', exec: 'terminal', read: 'file', search: 'search', web: 'globe',
  agent: 'organization', todo: 'checklist', mcp: 'plug', meta: 'gear', compact: 'fold-down',
  other: 'circle-small',
};

/** Rows the out-of-workspace-writes section shows. A session that ran a script over a whole home
 *  directory can produce thousands; the header says how many the cap hid, so the list never reads as
 *  the whole story. */
const OUTSIDE_CAP = 50;

/** Core reports the paths it found outside the workspace home-shortened (`~/x`) for display; opening one
 *  needs the real path back. */
function expandHome(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

// 0.10.0: no longer a TreeDataProvider — the Timeline webview renders these rows off getChildren /
// getTreeItem. The aggregation, the per-cycle memo and the section order stay exactly here.
class ActionsProvider {
  /** The root feed, computed at most once per REFRESH CYCLE. `fleetConflicts(listRepoSiblings(…))` walks
   *  every sibling worktree's transcripts — ~100ms of SYNCHRONOUS extension-host work — and the renderer
   *  asks for the root more than once per render (the badge, the rows, a re-expand), so the answer is
   *  held here and dropped by refresh(). Deliberately NOT a stamp-keyed memo around listRepoSiblings: its
   *  `active` flag is derived from "how long ago did this agent last write", so freezing it across
   *  refreshes would keep reporting long-idle agents as live conflicts. */
  private cycle?: { groups: core.ActionGroup[]; egress: core.EgressChannel[]; outside: core.OutsideWrite[]; collisions: core.FileCollision[] };
  refresh(): void {
    this.cycle = undefined; // a new cycle re-walks the fleet (its `active` flags are time-derived)
  }
  /** Curated groups (Subagents dropped — they're the Overview fleet) + the two audits (risk's
   *  out-of-workspace writes, egress) + the live cross-agent file conflicts (moved here from the
   *  Overview's fleet nav — this is the audit surface). */
  private groups(): { groups: core.ActionGroup[]; egress: core.EgressChannel[]; outside: core.OutsideWrite[]; collisions: core.FileCollision[] } {
    if (this.cycle) return this.cycle;
    const session = currentSession();
    const cwd = workspaceRoot();
    if (!session || !cwd) return (this.cycle = { groups: [], egress: [], outside: [], collisions: [] });
    const actions = core.parseActions(cwd, session);
    return (this.cycle = {
      groups: core.buildActionGroups(actions).filter((g) => g.category !== 'agent'),
      // 0.8.7: the footprint folded into these two audits. Reading a file outside the workspace is reach,
      // exactly like a fetch — so those files are egress CHANNELS, not a second report; writing outside it
      // is risk, and the only surface that can state it (the ledger shows every path workspace-relative).
      // Both are folds over the action stream this method already parsed — no second scan, no CLI spawn.
      egress: [...core.buildEgressReport(actions), ...core.outsideReads(actions, cwd)],
      outside: core.outsideWrites(actions, cwd),
      collisions: core.fleetConflicts(core.listRepoSiblings(cwd, session)),
    });
  }
  getChildren(node?: ActNode): ActNode[] {
    if (!node) {
      const { groups, egress, outside, collisions } = this.groups();
      const feed: ActNode[] = groups.map((g): ActNode => ({
        kind: 'agroup', label: g.label, count: g.count, errors: g.errors,
        icon: ACTION_ICON[g.category] ?? 'circle-small', actions: g.actions,
      }));
      // …then the audits, in the order the CLI reports them: risk (what it did) before egress (where it reached).
      if (outside.length)
        feed.push({ kind: 'ogroup', writes: outside.slice(0, OUTSIDE_CAP), files: outside.length,
          edits: outside.reduce((n, w) => n + w.count, 0) });
      if (egress.length) feed.push({ kind: 'egroup', channels: egress });
      if (collisions.length) feed.unshift({ kind: 'cgroup', collisions }); // conflicts lead — they need eyes NOW
      return feed;
    }
    if (node.kind === 'agroup') return node.actions.slice().reverse().map((rec): ActNode => ({ kind: 'arow', rec })); // newest-first
    if (node.kind === 'ogroup') return node.writes.map((w): ActNode => ({ kind: 'orow', w }));
    if (node.kind === 'egroup') return node.channels.map((ch): ActNode => ({ kind: 'erow', ch }));
    if (node.kind === 'cgroup') return node.collisions.map((c): ActNode => ({ kind: 'crow', c }));
    return [];
  }
  getTreeItem(node: ActNode): vscode.TreeItem {
    if (node.kind === 'agroup') {
      // Collapsed by default — the panel opens as a compact list of category headers; expand on demand.
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
      const shown = node.actions.length < node.count ? `${node.actions.length} of ${node.count}` : `${node.count}`;
      item.description = `${shown}${node.errors ? ` · ${node.errors} err` : ''}`;
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.contextValue = 'actionGroup';
      return item;
    }
    if (node.kind === 'ogroup') {
      // Risk's other half: edits that landed OUTSIDE the workspace. Reported as an observation about
      // where the work went, not scored as a danger — and stated here because nothing else can: the file
      // ledger presents every path workspace-relative.
      const item = new vscode.TreeItem('Outside the workspace', vscode.TreeItemCollapsibleState.Collapsed);
      const hidden = node.files - node.writes.length;
      item.description = `${hidden ? `${node.writes.length} of ${node.files}` : node.files} file${node.files === 1 ? '' : 's'} · ${node.edits} edit${node.edits === 1 ? '' : 's'}`;
      item.iconPath = new vscode.ThemeIcon('link-external', new vscode.ThemeColor('charts.orange'));
      item.tooltip = [
        `${node.edits} edit(s) across ${node.files} file(s) landed outside this workspace.`,
        // A cap that hides rows silently would let the list read as the whole story.
        hidden ? `${hidden} file(s) not shown (the list is capped at ${OUTSIDE_CAP}).` : '',
        'The file ledger shows every path workspace-relative, so it cannot state these.',
      ].filter(Boolean).join('\n');
      item.contextValue = 'actionGroup';
      return item;
    }
    if (node.kind === 'orow') {
      const w = node.w;
      const dir = path.dirname(w.file);
      const item = new vscode.TreeItem(path.basename(w.file), vscode.TreeItemCollapsibleState.None);
      item.description = `${dir}${w.count > 1 ? ` · ×${w.count}` : ''}`;
      item.tooltip = `${w.file}\n${w.count} edit(s) landed here, outside this workspace — click to open`;
      item.iconPath = new vscode.ThemeIcon('file', new vscode.ThemeColor('charts.orange'));
      item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(expandHome(w.file)), { preview: true }] };
      return item;
    }
    if (node.kind === 'egroup') {
      const item = new vscode.TreeItem('Egress', vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${node.channels.length}`;
      item.iconPath = new vscode.ThemeIcon('radio-tower');
      item.tooltip = 'Where this session reached: web hosts, MCP servers, network commands — and the files it read from outside this workspace.';
      item.contextValue = 'actionGroup';
      return item;
    }
    if (node.kind === 'cgroup') {
      // Live cross-agent conflicts — expanded (unlike the calm categories): they need eyes NOW.
      const item = new vscode.TreeItem('Live conflicts', vscode.TreeItemCollapsibleState.Expanded);
      const pend = node.collisions.filter((c) => c.anyPending).length;
      item.description = `${node.collisions.length}${pend ? ` · ${pend} pending` : ''}`;
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'));
      return item;
    }
    if (node.kind === 'crow') {
      const c = node.c;
      const item = new vscode.TreeItem(path.basename(c.file), vscode.TreeItemCollapsibleState.None);
      item.description = `${c.agents.length} agents${c.anyPending ? ' · pending' : ''}`;
      item.tooltip = `${c.file}\ntouched by ${c.agents.map((a) => a.slice(0, 8)).join(', ')} — click to open`;
      item.iconPath = new vscode.ThemeIcon('files', new vscode.ThemeColor('charts.orange'));
      item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(c.file), { preview: true }] };
      return item;
    }
    if (node.kind === 'erow') {
      const ch = node.ch;
      const file = ch.kind === 'file'; // a file READ from outside the workspace (scope 'local')
      const item = new vscode.TreeItem(file ? path.basename(ch.target) : ch.target, vscode.TreeItemCollapsibleState.None);
      // 'local' is its own word — "outside", the same one the CLI prints. Never fold it into 'unknown':
      // this one stayed on the machine but left the workspace (a fact), where 'unknown' is an admission
      // that the destination could not be classified.
      const scope = ch.scope === 'local' ? 'outside' : ch.scope;
      item.description = `${file ? path.dirname(ch.target) + ' · ' : ''}${ch.kind} · ${scope}${ch.count > 1 ? ` ×${ch.count}` : ''}`;
      item.iconPath = new vscode.ThemeIcon(
        ch.scope === 'remote' ? 'radio-tower' : ch.scope === 'local' ? 'file-symlink-file' : 'plug',
        ch.scope === 'remote' ? new vscode.ThemeColor('charts.red')
          : ch.scope === 'local' ? new vscode.ThemeColor('charts.orange') : undefined
      );
      item.tooltip = file
        ? `${ch.target}\nread ${ch.count}× from outside this workspace — click to open`
        : `${ch.kind} egress → ${ch.target} (${scope})`;
      if (file) item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(expandHome(ch.target)), { preview: true }] };
      return item;
    }
    // One action row — timestamped, timeline-style; an edit-action drills into its review (viewChanges).
    const rec = node.rec;
    const d = new Date(rec.ts);
    const hhmm = rec.ts ? [d.getHours(), d.getMinutes()].map((x) => String(x).padStart(2, '0')).join(':') : '--:--';
    const edit = rec.editId != null;
    const item = new vscode.TreeItem(`${hhmm}  ${rec.tool}`, vscode.TreeItemCollapsibleState.None);
    const risk = rec.risk ? (rec.risk.level === 'high' ? ' · ⚠ HIGH' : ' · ⚠ medium') : '';
    item.description = `${rec.target}${rec.isError ? ' · error' : ''}${risk}`;
    item.tooltip = [
      `${rec.tool}${rec.detail ? ` · ${rec.detail}` : ''}`,
      rec.target,
      // WHY it was flagged, in place: core already scored the reasons, and making the user leave the
      // panel to find out what "⚠ HIGH" meant is the whole cost of the flag (JetBrains states it here).
      rec.risk ? `⚠ ${rec.risk.level} risk: ${rec.risk.reasons.join(' · ')}` : '',
      rec.reasoning ? `💭 ${rec.reasoning}` : '',
      rec.isError ? '⚠ errored' : '',
      edit ? 'Click to review this edit.' : '',
      rec.ts ? d.toLocaleTimeString() : '',
    ]
      .filter(Boolean)
      .join('\n');
    item.iconPath = rec.isError
      ? new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'))
      : new vscode.ThemeIcon(edit ? 'edit' : ACTION_ICON[rec.category] ?? 'circle-small');
    if (edit) {
      item.command = { command: 'claudeObservatory.viewChanges', title: 'Review edit', arguments: [rec.editId] };
      item.contextValue = 'actionEdit';
    }
    return item;
  }
}

/** Serves the readonly markdown docs for observations + suggestions from the store. */
class ObservationMarkdownProvider implements vscode.TextDocumentContentProvider {
  private readonly _c = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._c.event;
  bump(uri: vscode.Uri): void {
    this._c.fire(uri);
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    const q = new URLSearchParams(uri.query);
    const session = q.get('s') || '';
    const cwd = q.get('cwd') || '';
    if (uri.authority === 'sug') {
      const todos = cwd ? core.transcriptSuggestions(cwd, session) : [];
      let md = `# Suggestions\n\n`;
      if (todos.length) md += `## From the agent's notes (this session)\n\n` + todos.map((s) => `- ${s}`).join('\n') + `\n\n`;
      md += `## Heuristic next steps\n\n` + core.heuristicSuggestions(session).map((s) => `- ${s}`).join('\n');
      const a = core.cachedAnalysis(session, 'suggestions');
      md += a ? `\n\n## Generated by Claude\n\n${a.text}\n` : `\n\n_Ask Claude for a deeper, grounded list — it reuses this session's cached context._\n`;
      return md;
    }
    const id = parseInt((uri.path.match(/edit-(\d+)/) || [])[1] || '0', 10);
    const rec = core.findRecord(session, id);
    if (!rec) return '(edit not found)';
    let md = `# Edit #${id} — ${path.basename(rec.file)}\n\n**Summary:** ${core.summarize(session, rec)}\n`;
    const reasoning = cwd ? core.reasoningByEdit(cwd, session).get(id) : undefined;
    if (reasoning) md += `\n## the agent's reasoning\n\n${reasoning}\n`;
    const flags = core.flagsFor(session, rec);
    if (flags.length) md += `\n## Flags\n\n` + flags.map((f) => `- ${f.level === 'warn' ? '⚠️' : 'ℹ️'} ${f.message}`).join('\n') + '\n';
    // What the observatory remembers about this file from every past session (zero-token).
    const mem = core.fileMemory(rec.file);
    const history = core.memorySummary(mem);
    if (history) {
      md += `\n## File history (all sessions)\n\n- ${history}\n`;
      if (core.isRiskyFile(mem)) md += `- ⚠️ edits to this file get reverted often (${mem.undone} of ${mem.kept + mem.undone} verdicts) — review carefully\n`;
      if (mem.notes.length) md += mem.notes.map((n) => `- 🧠 prior analysis: ${n.text}`).join('\n') + '\n';
    }
    const a = core.cachedAnalysis(session, `edit-${id}`);
    md += a ? `\n## Deep analysis (Claude)\n\n${a.text}\n` : `\n_Run “Analyze with Claude” for a deeper look._\n`;
    return md;
  }
}
const obsMd = new ObservationMarkdownProvider();

function obsUri(kind: 'obs' | 'sug', file: string, session: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: MD_SCHEME,
    authority: kind,
    path: `/${file}`,
    query: `s=${encodeURIComponent(session)}&cwd=${encodeURIComponent(workspaceRoot() || '')}`,
  });
}
async function showObservationDoc(id: number): Promise<void> {
  const session = currentSession();
  if (!session) return;
  const uri = obsUri('obs', `edit-${id}.md`, session);
  obsMd.bump(uri);
  await vscode.commands.executeCommand('markdown.showPreview', uri);
}
async function showSuggestionsDoc(): Promise<void> {
  const session = currentSession();
  if (!session) return;
  const uri = obsUri('sug', 'suggestions.md', session);
  obsMd.bump(uri);
  await vscode.commands.executeCommand('markdown.showPreview', uri);
}

// --- Combined Stats + Usage tab: multi-series edits/tokens plots on top, usage bars at the bottom ---
// Scanning ~GBs of transcripts would block the UI, so the scan runs in a subprocess (the CLI `stats`
// command, which maintains an incremental mtime cache) and this view just renders the JSON it returns.

/** The globally-installed CLI bin (`oak`, falling back to the pre-rename `claude-observatory`
 *  install), resolved via core's shared candidate list. */
function resolveObservatoryBin(): string {
  const oak = core.resolveBin('oak', { env: 'CLAUDE_OBSERVATORY_BIN' });
  if (oak !== 'oak') return oak; // found at a known install location (or via the env override)
  const old = core.resolveBin('claude-observatory');
  if (old !== 'claude-observatory') return old; // pre-rename install, not yet migrated
  return 'oak'; // neither resolved — let PATH decide
}

/** Detached CLI spawn that survives a Dock-launched editor. `oak` is a `#!/usr/bin/env node`
 *  script, and a GUI editor's PATH often carries no node — the child died AT THE SHEBANG with
 *  stdio ignored, which read as "refresh does nothing" (measured on the Mac, 2026-09-09:
 *  `env: node: No such file or directory`). A script that shebangs node runs on the editor's
 *  OWN runtime instead (ELECTRON_RUN_AS_NODE); anything else spawns as before. */
function spawnOakDetached(args: string[]): void {
  try {
    const bin = resolveObservatoryBin();
    let target = bin;
    try {
      target = fs.realpathSync(bin);
    } catch {
      /* keep the unresolved path */
    }
    let viaNode = target.endsWith('.js');
    if (!viaNode) {
      try {
        const head = fs.readFileSync(target).subarray(0, 64).toString('utf8');
        viaNode = head.startsWith('#!') && head.includes('node');
      } catch {
        /* unreadable — spawn as-is */
      }
    }
    const child = viaNode
      ? core.spawnTool(process.execPath, [target, ...args], { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
      : core.spawnTool(bin, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => { /* a later refresh can retry when the CLI is available */ });
    child.unref();
  } catch {
    /* stays stale until a later poll */
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 24; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

/** The combined Stats + Usage webview. Rendered ONCE; the provider pushes the review counts, the stats
 *  series, and the usage snapshot via postMessage (no reload → no flash, toggle state preserved). Layout:
 *  live review scoreboard (pending/accepted/reverted + progress bar) on top, then the range toggle + Tokens
 *  step-line plot, then a "Usage" section (ctx / 5h / week) below. */
function combinedShell(): string {
  const nonce = getNonce();
  // font-src data: — the ↻ is the SAME refresh codicon the status bar shows (base64 @font-face).
  const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; script-src 'nonce-${nonce}';`;
  const PLOTS = [
    { id: 'tokens', name: 'Tokens', scale: 'log', series: [['tokensTotal', 'total', 'var(--c-total)'], ['tokensInput', 'input', 'var(--c-input)'], ['tokensOutput', 'output', 'var(--c-output)']] },
  ];
  const style = `<style>${CODICON_STYLE}
  :root { --acc: var(--vscode-charts-blue, #4c8bf5); --c-pending: var(--vscode-charts-yellow, #d9a441); --c-kept: var(--vscode-charts-green, #3fb950); --c-reverted: var(--vscode-descriptionForeground, #9aa0aa); --c-total: var(--vscode-charts-blue, #4c8bf5); --c-input: var(--vscode-charts-purple, #9a6ac2); --c-output: var(--vscode-charts-orange, #c9713f); --c-cached: var(--vscode-charts-green, #3fb950); }
  body { margin:0; padding:8px 12px 12px; font-family: var(--vscode-font-family); font-size:11px; color: var(--vscode-foreground); position:relative; }
  .dim { opacity:.75; }
  /* Guided tour: the ring on the control a step names. Outline, not border — it must not reflow the
     panel it is pointing at. */
  .ring { outline:2px solid var(--vscode-charts-blue, #4c8bf5); outline-offset:2px; border-radius:3px; }
  .empty { padding:12px 2px; color: var(--vscode-descriptionForeground); line-height:1.5; }
  .review { margin-bottom:14px; }
  .toksec { margin-bottom:14px; }
  .navbar { display:flex; align-items:center; gap:8px; padding:5px 0 9px; margin-bottom:9px; border-bottom:1px solid var(--vscode-widget-border, rgba(127,127,127,0.25)); }
  .nb-session { display:inline-flex; align-items:center; gap:4px; font-family: var(--vscode-editor-font-family, monospace); font-size:9.5px; color: var(--vscode-descriptionForeground); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .nb-session::before { content:"🔬"; font-size:10px; }
  .nb-chip { flex:none; border:1px solid var(--vscode-widget-border, rgba(127,127,127,0.25)); border-radius:99px; padding:1px 6px; font-size:9.5px; color: var(--vscode-descriptionForeground); white-space:nowrap; }
  .rvc-click { cursor:pointer; }
  .rvc-click:hover { border-color: var(--c-pending); background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.08)); }
  .rvcounts { display:flex; gap:6px; margin-bottom:9px; }
  .rvc { flex:1; text-align:center; padding:7px 3px; border:1px solid var(--vscode-widget-border, rgba(127,127,127,0.25)); border-radius:6px; }
  .rvn { display:block; font-size:19px; font-weight:600; font-variant-numeric:tabular-nums; line-height:1.05; }
  .rvl { display:block; font-size:9px; text-transform:uppercase; letter-spacing:0.07em; color: var(--vscode-descriptionForeground); margin-top:3px; }
  .rvbar { height:6px; border-radius:3px; background: var(--vscode-editorWidget-background, rgba(127,127,127,0.2)); overflow:hidden; }
  .rvfill { display:block; height:100%; width:0; border-radius:3px; background: var(--acc); transition: width .3s ease; }
  .rvmeta { display:flex; justify-content:space-between; font-size:9.5px; color: var(--vscode-descriptionForeground); margin-top:5px; font-variant-numeric:tabular-nums; }
  .ranges { display:flex; margin-bottom:12px; border:1px solid var(--vscode-widget-border, rgba(127,127,127,0.25)); border-radius:6px; overflow:hidden; }
  .seg { flex:1; background:transparent; color: var(--vscode-descriptionForeground); border:0; border-right:1px solid var(--vscode-widget-border, rgba(127,127,127,0.25)); padding:4px 0; font-size:10px; font-family:inherit; cursor:pointer; letter-spacing:0.03em; }
  .seg:last-child { border-right:0; }
  .seg.on { background: var(--acc); color: var(--vscode-editor-background, #1e1e1e); font-weight:600; }
  .plot { margin-bottom:18px; }
  .phead { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:4px; }
  .pname { font-family: var(--vscode-editor-font-family, monospace); text-transform:uppercase; letter-spacing:0.1em; font-size:10px; color: var(--vscode-descriptionForeground); }
  .legend { display:flex; gap:9px; flex-wrap:wrap; }
  .lg { display:inline-flex; align-items:center; gap:4px; font-size:9.5px; color: var(--vscode-descriptionForeground); }
  .lg .sw { width:9px; height:2.5px; border-radius:1px; }
  .pbody { position:relative; padding-left:34px; }
  .chart { width:100%; height:46px; display:block; overflow:visible; }
  .chart .ln { fill:none; stroke-width:1.6; vector-effect:non-scaling-stroke; stroke-linejoin:round; }
  .chart .base { stroke: var(--vscode-widget-border, rgba(127,127,127,0.35)); stroke-width:1; vector-effect:non-scaling-stroke; }
  .chart .cross { stroke: var(--vscode-foreground); stroke-width:1; vector-effect:non-scaling-stroke; }
  .yt { position:absolute; left:0; width:30px; text-align:right; font-size:8.5px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; transform:translateY(-50%); line-height:1; white-space:nowrap; }
  .pax { display:flex; justify-content:space-between; font-size:9px; color: var(--vscode-descriptionForeground); margin:3px 0 0 34px; font-variant-numeric: tabular-nums; }
  .divider { border-top:1px solid var(--vscode-widget-border, rgba(127,127,127,0.25)); margin:2px 0 10px; }
  .uhead { font-family: var(--vscode-editor-font-family, monospace); text-transform:uppercase; letter-spacing:0.1em; font-size:10px; color: var(--vscode-descriptionForeground); margin-bottom:6px; }
  /* One grid for the whole section: label · reset time · bar · % · detail. Grid columns make
     every row's bar the SAME width while it scales with the panel (a fixed
     width didn't track the pane; per-row flexing gave every bar a different length). The time
     sits before the bar; a long detail column wraps inside its own cell instead of colliding. */
  #ug { display:grid; grid-template-columns:auto minmax(48px,1fr) auto auto auto auto; grid-auto-rows:auto; align-items:end; column-gap:6px; row-gap:3px; font-family: var(--vscode-editor-font-family, monospace); }
  #upromo, #uhint { grid-column:1/-1; }
  #ug .row { display:contents; }
  /* Foldable sections: the header row is the toggle, the
     chevron mirrors the fold, and folded state persists through webview state like the range. */
  .shead { cursor:pointer; user-select:none; display:flex; align-items:center; gap:6px; }
  .shead .legend { margin-left:auto; }
  .scar { color: var(--vscode-descriptionForeground); width:10px; }
  .ulast { margin-left:6px; text-transform:none; letter-spacing:0; color: var(--vscode-descriptionForeground); font-variant-numeric:tabular-nums; }
  /* One tab per subscription — same row grammar under each. */
  .utabs { margin-left:8px; display:inline-flex; gap:2px; }
  .utab { padding:0 6px; border-radius:3px; cursor:pointer; color: var(--vscode-descriptionForeground); text-transform:none; letter-spacing:0; }
  .utab.on { background: var(--vscode-editorWidget-background, rgba(127,127,127,0.2)); color: var(--vscode-foreground); }
  .uref { margin-left:auto; cursor:pointer; color: var(--vscode-descriptionForeground); font-size:14px; line-height:10px; }
  .uref:hover { color: var(--vscode-foreground); }
  /* Pressed ↻: the glyph spins and the section dims until fresh numbers land. */
  @keyframes uspin { to { transform: rotate(360deg); } }
  .uref.busy { display:inline-block; animation: uspin 0.9s linear infinite; color: var(--vscode-foreground); }
  #ug.busy { opacity:0.55; transition: opacity .25s; }
  @media (prefers-reduced-motion: reduce) { .uref.busy { animation:none; } }
  .ssec.sfold .sbody { display:none !important; }
  .lbl { min-width:22px; color: var(--vscode-descriptionForeground); }
  /* The countdown rides directly above its bar; the numbers sit in shared
     spent/total/cached columns so they align down the section. An empty time collapses, keeping
     bar-only rows short. */
  .bcell { display:flex; flex-direction:column; justify-content:center; gap:1px; min-width:0; }
  /* min-height keeps the time slot even when empty — every row the same height, so the bars
     are evenly spaced down the section. */
  .btime { display:block; min-height:9px; font-size:9px; line-height:1; text-align:right; color: var(--vscode-editor-foreground); font-variant-numeric: tabular-nums; }
  .track { height:5px; border-radius:3px; background: var(--vscode-editorWidget-background, rgba(127,127,127,0.2)); overflow:hidden; }
  .fill { display:block; height:100%; border-radius:3px; width:0; }
  /* Left-aligned + tucked into the gap: right-aligning a short "6%" in this column left a wide
     void against its bar (no space between the % and the bar). */
  .pct { width:34px; margin-left:-3px; text-align:left; font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
  .ucol { text-align:right; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; white-space:nowrap; }
  .uch { font-size:9px; letter-spacing:0.05em; }
  .tip { position:absolute; pointer-events:none; opacity:0; background: var(--vscode-editorHoverWidget-background, #252526); color: var(--vscode-editorHoverWidget-foreground, #ccc); border:1px solid var(--vscode-editorHoverWidget-border, rgba(127,127,127,0.3)); border-radius:4px; padding:2px 7px; font-size:10px; font-variant-numeric: tabular-nums; white-space:nowrap; transform:translateY(-100%); z-index:5; }
</style>`;
  // The chart section's header carries the (single) plot's name + legend; the fold wraps the
  // range toggle and the plot together — the toggle only drives this chart.
  const legendHtml =
    `<div class="legend">` +
    PLOTS[0].series.map((sr) => `<span class="lg"><span class="sw" style="background:${sr[2]}"></span>${sr[1]}</span>`).join('') +
    `</div>`;
  const plotsHtml = PLOTS.map(
    (p) => `<div class="plot"><div class="pbody" id="b-${p.id}"></div><div class="pax" id="x-${p.id}"></div></div>`
  ).join('');
  const usageTips: Record<string, string> = {
    ctx: 'Context window — tokens in the current session’s context vs the model’s window size',
    '5h': '5-hour rolling plan usage — % of your 5-hour limit used · reset countdown · ~tokens used / estimated total for 100%',
    wk: 'Weekly plan usage — % of your weekly limit used · reset countdown · ~tokens used / estimated total for 100%',
    mo: 'Your bill cycle — tokens against four weekly cycles of budget, plus cache reads',
    '$': 'The cycle’s spend against its projected budget — Claude Code’s own figures, estimates',
    fable: 'Per-model weekly cap on the top-tier model, as the account reports it — share and reset only (no per-model token measurement exists)',
  };
  const usageHtml =
    `<div class="usagesec ssec" id="usage-sec">` +
    `<div class="uhead shead" data-sec="usage" title="Plan usage: the context window (live from the transcript) plus your 5-hour and weekly limits (from your account)"><span class="scar">▾</span>Usage<span id="ulast" class="ulast" title="When the usage cache was last refreshed — by your claude session, the once-a-minute account pull, or the ↻"></span><span class="utabs" id="utabs" style="display:none"><span class="utab" data-ut="claude">claude</span><span class="utab" data-ut="gpt">gpt</span></span><span id="uref" class="uref codicon codicon-refresh" title="Refresh now — pull your account usage"></span></div>` +
    `<div class="sbody" id="ug">` +
    `<div class="row"><span class="lbl"></span><span></span><span></span><span class="ucol uch">used</span><span class="ucol uch">total</span><span class="ucol uch">cached</span></div>` +
    ['ctx', '5h', 'fable', 'wk', 'mo', '$']
      .map((l) => `<div class="row" title="${usageTips[l]}"><span class="lbl" id="ul-${l}">${l}</span><span class="bcell"><span class="btime" id="ut-${l}"></span><span class="track"><span class="fill" id="uf-${l}"></span></span></span><span class="pct" id="up-${l}">—</span><span class="ucol" id="uc1-${l}"></span><span class="ucol" id="uc2-${l}"></span><span class="ucol" id="uc3-${l}"></span></div>`)
      .join('') +
    `<div id="upromo" class="dim" style="display:none"></div>` +
    `<div id="uhint" class="empty" style="display:none">5h / week plan usage needs <b>claude-statusline</b> writing on this host.<br><span class="dim">run <b>oak statusline</b> (bundled — no download), then start an agent session.</span></div>` +
    `</div>` +
    `</div>` +
    `<div id="ucredits" class="dim" style="display:none"></div>` +
    ``;
  const script = `
    const vscode = acquireVsCodeApi();
    const PLOTS = ${JSON.stringify(PLOTS)};
    var STATS = null;
    let range = ((vscode.getState()||{}).range) || 'week';
    var FOLDS = ((vscode.getState()||{}).folds) || {};
    var UTAB = ((vscode.getState()||{}).utab) || 'claude';
    function saveSt(){ try{ vscode.setState({range:range, folds:FOLDS, utab:UTAB}); }catch(e){} }
    function applyFolds(){ var hs=document.querySelectorAll('.shead'); for(var i=0;i<hs.length;i++){ var h=hs[i], k=h.getAttribute('data-sec'), sec=h.parentElement, on=!!FOLDS[k]; if(sec) sec.classList.toggle('sfold',on); var c=h.querySelector('.scar'); if(c) c.textContent = on ? '\u25b8' : '\u25be'; } }
    function human(n){ if(n<1000)return String(n); var v,suf; if(n<1e6){v=n/1e3;suf='k';}else if(n<1e9){v=n/1e6;suf='M';}else{v=n/1e9;suf='B';} var s=v.toFixed(v<10?1:0); if(s.slice(-2)==='.0')s=s.slice(0,-2); return s+suf; }
    function ymap(v,max,scale,H){ if(scale==='log'){ var lm=Math.log(Math.max(2,max)); return v<1 ? H : H - Math.log(v)/lm*(H-3); } return H - (max>0? v/max : 0)*(H-3); }
    function yticks(max,scale){ if(scale==='log'){ var top=Math.floor(Math.log(Math.max(1,max))/Math.LN10); var stride=Math.max(1,Math.ceil((top+1)/4)); var ts=[]; for(var e=top; e>=0; e-=stride) ts.push(Math.pow(10,e)); return ts; } var t=[]; if(max>0){ t.push(max); if(max>=4){ var h=Math.round(max/2); if(h>0&&h<max) t.push(h); } } return t; }
    function renderPlot(p){
      var series=(STATS&&STATS[range])||[], labels=series.map(function(d){return d.label;}), n=series.length;
      var W=100,H=46,max=1;
      p.series.forEach(function(sr){ series.forEach(function(d){ if(d[sr[0]]>max) max=d[sr[0]]; }); });
      var paths=''; p.series.forEach(function(sr){ var d=''; for(var i=0;i<n;i++){ var y=ymap(series[i][sr[0]],max,p.scale,H).toFixed(2); var x0=(i*W/n).toFixed(2),x1=((i+1)*W/n).toFixed(2); d+=(i===0?('M'+x0+','+y):('L'+x0+','+y))+'L'+x1+','+y; } paths+='<path d="'+d+'" class="ln" style="stroke:'+sr[2]+'"/>'; });
      var svg='<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" class="chart"><line class="base" x1="0" y1="'+H+'" x2="'+W+'" y2="'+H+'"/>'+paths+'<line class="cross" x1="0" y1="0" x2="0" y2="'+H+'" opacity="0"/><rect x="0" y="0" width="'+W+'" height="'+H+'" fill="transparent"/></svg>';
      var yl='', lastY=-99; yticks(max,p.scale).forEach(function(t){ var yy=ymap(t,max,p.scale,H); if(Math.abs(yy-lastY)<9) return; lastY=yy; yl+='<span class="yt" style="top:'+yy.toFixed(1)+'px">'+human(t)+'</span>'; });
      var body=document.getElementById('b-'+p.id); body.innerHTML=svg+yl;
      var m=Math.min(6,n), xs=''; for(var k=0;k<m;k++){ var idx=Math.round(k*(n-1)/Math.max(1,m-1)); xs+='<span>'+(labels[idx]||'')+'</span>'; }
      document.getElementById('x-'+p.id).innerHTML = n?xs:'';
      var svgEl=body.querySelector('svg'), cross=body.querySelector('.cross'), hit=body.querySelector('rect'), tip=document.getElementById('tip');
      hit.addEventListener('mousemove',function(e){ var r=svgEl.getBoundingClientRect(); var i=Math.floor((e.clientX-r.left)/r.width*n); i=Math.max(0,Math.min(n-1,i)); var cx=(i+0.5)/n*W; cross.setAttribute('x1',cx); cross.setAttribute('x2',cx); cross.setAttribute('opacity','0.5'); var parts=[labels[i]]; p.series.forEach(function(sr){ parts.push(sr[1]+' '+human(series[i][sr[0]])); }); var br=document.body.getBoundingClientRect(); tip.textContent=parts.join(' · '); tip.style.opacity='1'; tip.style.left=(e.clientX-br.left)+'px'; tip.style.top=(e.clientY-br.top-6)+'px'; });
      hit.addEventListener('mouseleave',function(){ cross.setAttribute('opacity','0'); document.getElementById('tip').style.opacity='0'; });
    }
    function drawStats(){ var segs=document.querySelectorAll('.seg'); for(var i=0;i<segs.length;i++) segs[i].classList.toggle('on', segs[i].getAttribute('data-r')===range); var g=document.getElementById('gathering'); if(g) g.style.display = STATS ? 'none' : 'block'; PLOTS.forEach(renderPlot); }
    function ucolor(p){ if(p>=80)return 'var(--vscode-charts-red,#e5534b)'; if(p>=50)return 'var(--vscode-charts-yellow,#d9a441)'; return 'var(--vscode-charts-green,#3fb950)'; }
    function until(ms){ if(ms==null)return ''; var d=ms-Date.now(); if(!isFinite(d)||d<=0)return ''; var mins=Math.round(d/60000),h=Math.floor(mins/60); if(h>=24)return Math.floor(h/24)+'d'+(h%24)+'h'; return h>0? h+'h'+(mins%60)+'m' : (mins%60)+'m'; }
    // tm renders as the countdown directly above the bar (full foreground); spent/total/cached
    // land in the shared columns. pct null still shows the columns — a measurement without a
    // quota share (Enterprise) is a value, not an empty row.
    function setRow(l,pct,spent,total,cached,tm){ var f=document.getElementById('uf-'+l),p=document.getElementById('up-'+l),t=document.getElementById('ut-'+l);
      var c1=document.getElementById('uc1-'+l),c2=document.getElementById('uc2-'+l),c3=document.getElementById('uc3-'+l);
      if(t) t.textContent=tm||''; if(c1) c1.textContent=spent||''; if(c2) c2.textContent=total||''; if(c3) c3.textContent=cached||'';
      if(pct==null){ f.style.width='0'; p.textContent='—'; p.style.color=''; return; }
      var c=ucolor(pct); f.style.width=Math.max(2,Math.min(100,pct))+'%'; f.style.background=c; p.textContent=Math.round(pct)+'%'; p.style.color=c; }
    function rowOf(l){ var e=document.getElementById('ul-'+l); return e? e.parentElement : null; }
    var STALE_MS = ${core.USAGE_STALE_MS};
    var LASTU = null;
    function atTime(ts){ if(!ts) return ''; var d=new Date(ts), n=new Date(); function p2(x){ return (x<10?'0':'')+x; }
      var MN=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      if(d.getFullYear()===n.getFullYear() && d.getMonth()===n.getMonth() && d.getDate()===n.getDate()) return p2(d.getHours())+':'+p2(d.getMinutes());
      if(d.getFullYear()===n.getFullYear()) return MN[d.getMonth()]+' '+d.getDate()+' '+p2(d.getHours())+':'+p2(d.getMinutes());
      return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate()); }
    function renderUsage(u){ LASTU=u; var hint=document.getElementById('uhint');
      if(!u){ setRow('ctx',null); setRow('5h',null); setRow('wk',null); setRow('mo',null); setRow('$',null); var fb0=rowOf('fable'); if(fb0) fb0.style.display='none'; if(hint) hint.style.display='none'; return; }
      // One tab per subscription: gpt appears only when codex reports windows.
      var tabs=document.getElementById('utabs');
      var hasGpt = u.gptFivePct!=null || u.gptWeekPct!=null || u.gptCtxPct!=null || u.gptMonthTok!=null;
      if(tabs) tabs.style.display = hasGpt ? 'inline-flex' : 'none';
      if(!hasGpt) UTAB='claude';
      var tEls=document.querySelectorAll('.utab');
      for(var tj=0;tj<tEls.length;tj++) tEls[tj].classList.toggle('on', tEls[tj].getAttribute('data-ut')===UTAB);
      if(UTAB==='gpt' && hasGpt){
        // Same grammar throughout: ctx from codex's own last-turn context vs
        // its model window; wk with reported quota and measured local tokens; mo/$
        // cycle-summed and list-priced from the rollouts. 5h appears only when codex still
        // reports one (current builds persist the weekly window alone — verified live). A row
        // codex gives no data for stays hidden rather than fabricated.
        var fbg=rowOf('fable'); if(fbg) fbg.style.display='none';
        var rcg=rowOf('ctx'); if(rcg) rcg.style.display = u.gptCtxPct!=null ? '' : 'none';
        if(u.gptCtxPct!=null) setRow('ctx', u.gptCtxPct, u.gptCtxTokens? human(u.gptCtxTokens):'', u.gptCtxSize? human(u.gptCtxSize):'', '');
        var s5g=rowOf('5h'); if(s5g) s5g.style.display = u.gptFivePct!=null ? '' : 'none';
        if(u.gptFivePct!=null) setRow('5h', u.gptFivePct, '', '', '', until(u.gptFiveReset||null));
        var s7g=rowOf('wk'); if(s7g) s7g.style.display='';
        setRow('wk', u.gptWeekPct, u.gptWeekTok? '~'+humanTok(u.gptWeekTok):'', u.gptWeekTotal? humanTok(u.gptWeekTotal):'', '', until(u.gptWeekReset||null));
        var gmp=(u.gptMonthTok&&u.gptMonthTokTotal)? Math.min(100, (u.gptMonthTok/u.gptMonthTokTotal)*100) : null;
        var rmg=rowOf('mo'); if(rmg) rmg.style.display = u.gptMonthTok? '' : 'none';
        if(u.gptMonthTok) setRow('mo', gmp, '~'+humanTok(u.gptMonthTok), u.gptMonthTokTotal? humanTok(u.gptMonthTokTotal):'', u.gptMonthReads? '+'+humanTok(u.gptMonthReads)+'\u21ba':'', until(u.gptMonthReset||null));
        var rdg=rowOf('$'); if(rdg) rdg.style.display = u.gptMonthCost? '' : 'none';
        if(u.gptMonthCost) setRow('$', gmp, '~'+usd(u.gptMonthCost), u.gptMonthCostTotal? '~'+usd(u.gptMonthCostTotal):'', '');
        var prg=document.getElementById('upromo'); if(prg) prg.style.display='none';
        if(hint) hint.style.display='none';
        return;
      }
      var showC=['ctx','mo','$'];
      for(var sc=0;sc<showC.length;sc++){ var sr=rowOf(showC[sc]); if(sr) sr.style.display=''; }
      // Estimated plan budget: infer the 100% total from the tokens observed against the reported percent
      // (tokens ÷ pct × 100), then show used/total like the ctx row. Needs ~1% burned to project a total;
      // below that we can only show the tokens used so far.
      // MEASURED across every configured machine, when we have it: added up from what each one
      // recorded, rather than projected from one machine's tokens against an account-wide percent.
      // The scope travels with the number — a total nobody can attribute is a total nobody trusts.
      // Money, exactly as the terminal renders it: two decimals under $100, none above.
      function usd(n){ var v=Math.max(0,n||0); if(v>=1000) return '$'+(v/1000).toFixed(1)+'k'; if(v>=100) return '$'+Math.round(v); if(v>0&&v<0.01) return '<$0.01'; return '$'+v.toFixed(2); }
      // The shell's own humaniser, TRUNCATING — the same one the statusline and the terminal use,
      // so one session cannot read two ways depending on which surface you look at.
      function humanTok(n){ var v=Math.trunc(n)||0;
        if(v>=1000000000){ var b=Math.trunc((v%1000000000)/100000000); return b===0 ? Math.trunc(v/1000000000)+'B' : Math.trunc(v/1000000000)+'.'+b+'B'; }
        if(v>=1000000){ var d=Math.trunc((v%1000000)/100000); return d===0 ? Math.trunc(v/1000000)+'M' : Math.trunc(v/1000000)+'.'+d+'M'; }
        if(v>=1000) return Math.trunc(v/1000)+'k'; return ''+v; }
      // USED OUT OF TOTAL, always — the statusline's own grammar. The cross-machine sum is a better
      // NUMERATOR when there is one, never a replacement for the whole form. The denominator is
      // derived when the cache lacks it: tokens ÷ percent × 100 is exactly the 100% budget the
      // statusline computes, not an approximation of it.
      function estPair(measured,total,tok,pct){
        // ONE set of numbers on every surface: the statusline's calibrated
        // account est/total is CANONICAL — deriving a second denominator from the measured sum
        // put ~25.6M/88.4M here beside ~28.3M/97.7M on the terminal for the same window. The
        // derived form survives only as the fallback when the cache has no estimate yet. And no
        // scope text on the rows, ever. Returned split, for the spent/total columns.
        var used = (tok && total) ? tok : (measured || tok);
        if(!used) return ['',''];
        var budget = (tok && total) ? total
          : (used && pct>=1 ? Math.round(used/pct*100) : 0);
        return ['~'+humanTok(used), budget? humanTok(budget) : ''];
      }
      // Money and credit, drawn wherever they apply — a plan with no rolling quota is billed in
      // dollars, and an account that reports a balance has one whether or not it has a quota.
      function creditText(u){ return u.creditsUnlimited ? 'credits unlimited' : (u.creditBalance!=null ? 'credits '+usd(u.creditBalance) : ''); }
      function showCredits(u){ var el=document.getElementById('ucredits'); if(!el) return;
        var t=creditText(u); el.textContent=t; el.style.display = t ? 'block' : 'none'; }
      setRow('ctx', u.ctx? u.ctx.pct : null, u.ctx? human(u.ctx.tokens) : '', u.ctx? human(u.ctx.size) : '', u.tokensCacheRead? '+'+human(u.tokensCacheRead)+'\u21ba' : '');
      // Claude Code sends rate_limits.* only for Claude.ai subscription plans. On Enterprise or an API
      // key these two bars can never fill, and an empty bar reads as "none of your quota used" rather
      // than "this plan has no rolling quota". Show what this machine CAN measure instead. No percentage
      // is drawn, deliberately: there is no denominator, and inventing one would be a confident guess.
      var moPct = (u.monthTokens && u.monthTokensTotal) ? Math.min(100,(u.monthTokens/u.monthTokensTotal)*100) : null;
      // The $ bar SHARES the month bar's percentage — one account, one share.
      var dPct = (u.monthCost && moPct!=null) ? moPct : null;
      if(u.rollingLimits===false){
        // No rolling quota (Enterprise/API): the 5h/wk slots say nothing such a plan can use —
        // the readout is ctx, the bill cycle's tokens, and its spend.
        var h5=rowOf('5h'), hw=rowOf('wk'), hf=rowOf('fable');
        if(h5) h5.style.display='none';
        if(hw) hw.style.display='none';
        if(hf) hf.style.display = u.fablePct!=null ? '' : 'none';
        if(u.fablePct!=null) setRow('fable', u.fablePct, '', '', '', until(u.fableReset||null));
        setRow('mo', null, '~'+human(u.monthTokens||0), '', '');
        var rmo=rowOf('mo'); if(rmo) rmo.title='tokens this bill cycle, measured from this machine';
        if(u.monthCost!=null){ setRow('$', null, '~'+usd(u.monthCost), '', ''); var rd=rowOf('$'); if(rd) rd.title='spent this cycle, as the client reports it'; }
        showCredits(u);
        if(hint) hint.style.display='none';   // nothing to install: the status line is not the gap here
        // ↻ and the "updated …" stamp must clear on THIS path too: pressing refresh on a quota-less
        // account still has to stop the spinner and land the timestamp (there is no cached percentage
        // bar to go stale here, so that is the only bookkeeping left to reset before the early return).
        var ulE=document.getElementById('ulast'); if(ulE) ulE.textContent = u.cachedAtMs? ('updated '+atTime(u.cachedAtMs)) : '';
        var urE=document.getElementById('uref'); if(urE) urE.classList.remove('busy');
        var ugE=document.getElementById('ug'); if(ugE) ugE.classList.remove('busy');
        return;
      }
      // Restore the quota labels: an account can start reporting limits between refreshes.
      var l5=document.getElementById('ul-5h'), lw2=document.getElementById('ul-wk');
      if(l5) l5.textContent='5h'; if(lw2) lw2.textContent='wk';
      var h5b=rowOf('5h'), hwb=rowOf('wk');
      if(h5b) h5b.style.display='';
      if(hwb) hwb.style.display='';
      var p5=estPair(u.fiveMeasuredAll,u.fiveTotal,u.fiveTokens,u.fiveHourPct);
      var p7=estPair(u.weekMeasuredAll,u.weekTotal,u.weekTokens,u.weekPct);
      setRow('5h', u.fiveHourPct, p5[0], p5[1], u.fiveReads? '+'+humanTok(u.fiveReads)+'\u21ba':'', until(u.fiveReset));
      setRow('wk', u.weekPct, p7[0], p7[1], u.weekReads? '+'+humanTok(u.weekReads)+'\u21ba':'', until(u.weekReset));
      // The per-model weekly cap (the account API's "Fable" row), with its own union-measured
      // ~est/total and cache reads — the same canon as the 5h/wk columns.
      var fbr=rowOf('fable');
      if(u.fablePct!=null){
        if(fbr) fbr.style.display='';
        var fl=document.getElementById('ul-fable'); if(fl) fl.textContent=(u.fableLabel? String(u.fableLabel):'fable').toLowerCase();
        setRow('fable', u.fablePct,
          u.fableTokens? '~'+humanTok(u.fableTokens):'',
          u.fableTotal? humanTok(u.fableTotal):'',
          u.fableReads? '+'+humanTok(u.fableReads)+'\u21ba':'',
          until(u.fableReset||null));
      } else if(fbr) fbr.style.display='none';
      setRow('mo', moPct, u.monthTokens? '~'+humanTok(u.monthTokens):'', u.monthTokensTotal? humanTok(u.monthTokensTotal):'', u.monthReads? '+'+humanTok(u.monthReads)+'\u21ba':'', until(u.monthReset||null));
      // The month's $ total is projected like its spent figure (list prices over an estimated month): both carry ~.
      setRow('$', dPct, u.monthCost? '~'+usd(u.monthCost):'', u.monthCostTotal? '~'+usd(u.monthCostTotal):'', '');
      // Only nudge when the statusline cache is truly absent — not on a fresh session whose rate_limits
      // haven't arrived yet (cache present, 5h/wk momentarily null), nor on non-subscription plans.
      showCredits(u);
      // The live limits promotion is part of these budgets — say so where the bars are read.
      var pr=document.getElementById('upromo');
      if(pr){ if(u.promo&&u.promo.label){ pr.textContent=(u.promo.label+' limit promotion '+(u.promo.dates||'')).trim(); pr.style.display='block'; } else pr.style.display='none'; }
      if(hint) hint.style.display = u.statuslineCache ? 'none' : 'block';
      // The freshness story lives on the SECTION TOOLTIP, not a banner: when
      // it was last refreshed, what refreshes it, and the no-credentials fallback.
      var ul=document.getElementById('ulast');
      if(ul) ul.textContent = u.cachedAtMs? ('updated '+atTime(u.cachedAtMs)) : '';
      var ur2=document.getElementById('uref'); if(ur2) ur2.classList.remove('busy');
      var ug2=document.getElementById('ug'); if(ug2) ug2.classList.remove('busy');
      var sh=document.querySelector('#usage-sec .shead');
      if(sh){
        if(!sh.getAttribute('data-tip0')) sh.setAttribute('data-tip0', sh.getAttribute('title')||'');
        var ft = u.cachedAtMs? ('\\n\\n5h / week last refreshed at '+atTime(u.cachedAtMs)+'. The panel pulls your account usage about once a minute when Claude Code credentials are readable; without them (or offline), keep a claude terminal open — its status line refreshes the same cache. ctx stays live from the transcript.') : '';
        sh.setAttribute('title', (sh.getAttribute('data-tip0')||'')+ft);
      }
    }
    setInterval(function(){ if(LASTU) renderUsage(LASTU); }, 60000); // the "Xm ago" stamp ticks between posts
    function renderCounts(c){ if(!c) return;
      document.getElementById('rv-pending').textContent=c.pending;
      document.getElementById('rv-kept').textContent=c.kept;
      document.getElementById('rv-undone').textContent=c.undone;
      var reviewed=c.kept+c.undone, total=c.pending+reviewed, pct= total? Math.round(reviewed/total*100):0;
      var fill=document.getElementById('rv-fill'); fill.style.width=pct+'%';
      fill.style.background = pct>=100 ? 'var(--c-kept)' : 'var(--acc)';
      document.getElementById('rv-progress').textContent = total ? (reviewed+' of '+total+' reviewed ('+pct+'%)') : 'no edits yet';
      document.getElementById('rv-rate').textContent = reviewed ? (Math.round(c.kept/reviewed*100)+'% accepted') : '';
    }
    function renderTokens(t){
      var i=document.getElementById('tk-in'), o=document.getElementById('tk-out'), c=document.getElementById('tk-cached'), l=document.getElementById('tk-cached-lbl');
      if(!i) return;
      if(!t || t.available===false){ i.textContent='—'; o.textContent='—'; c.textContent='—'; l.textContent='cached'; return; }
      i.textContent=human(t.input); o.textContent=human(t.output); c.textContent=human(t.cacheRead);
      l.textContent = t.hitPct==null ? 'cached' : 'cached · '+Math.round(t.hitPct)+'% hit';
      var cc=document.getElementById('tk-cached-cell');
      if(cc) cc.title = 'cache reads '+human(t.cacheRead)+' · cache writes '+human(t.cacheCreation)+(t.hitPct==null?'':' · hit rate = reads ÷ all context sent');
    }
    // Model + effort are structural facts the harness records, so an unknown one is left blank rather
    // than defaulted: no model recorded yet (fresh session) hides the chip outright, and an undeclared
    // effort simply drops its half — the default differs by build, so guessing it would be a fiction.
    function renderVitals(v){
      var el=document.getElementById('nb-model'); if(!el) return;
      if(!v||!v.model){ el.style.display='none'; el.textContent=''; el.title=''; return; }
      var ms=(v&&v.models)||[], more=ms.length>1 ? ' +'+(ms.length-1) : '';
      el.style.display='';
      el.textContent = v.model.label + (v.effort ? ' · '+v.effort.level+' effort' : '') + more;
      var tip=[];
      for(var i=0;i<ms.length;i++) tip.push(ms[i].label+' '+ms[i].turns+' turn'+(ms[i].turns===1?'':'s'));
      if(!tip.length) tip.push(v.model.label);
      if(v.effort) tip.push('effort '+v.effort.level+(v.effort.source==='stub'?' (from an /effort command in the transcript)':''));
      el.title = (ms.length>1 ? 'Models this session ran on: ' : 'Model serving this session: ')+tip.join(' · ');
    }
    // Compaction is a session vital, not a chart: when the harness summarizes older turns away, the
    // context that produced the earlier work is gone. The per-turn context SERIES (and its chart) were
    // removed, but the events themselves still ride vitals.compactions, so the count and the size of the
    // last drop stay stated. Absent data renders absent — no compactions, no chip.
    function renderCompactions(v){
      var el=document.getElementById('nb-compact'); if(!el) return;
      var cs=(v&&v.compactions)||[];
      if(!cs.length){ el.style.display='none'; el.textContent=''; el.title=''; return; }
      var last=cs[cs.length-1];
      el.style.display='';
      el.textContent='⤺ '+cs.length+' compaction'+(cs.length===1?'':'s')+' · last dropped '+human(last.droppedTokens||0);
      var lines=[];
      for(var i=0;i<cs.length;i++){ var c=cs[i];
        lines.push((c.trigger||'compact')+' · '+human(c.preTokens||0)+'→'+human(c.postTokens||0)+' · '+human(c.droppedTokens||0)+' dropped'+(c.ts? ' · '+new Date(c.ts).toLocaleTimeString():'')); }
      el.title='Context compacted '+cs.length+' time'+(cs.length===1?'':'s')+' — Claude Code summarised the conversation so far and continued on the summary:\\n'+lines.join('\\n');
    }
    // Guided tour: every tour-aware webview gets the anchor and rings it only if IT knows the name.
    // Anchor names are globally unique (a core test pins that), so a broadcast cannot ring two things.
    var TOUR_ANCHORS = { 'stats-model':'#nb-model', 'stats-compaction':'#nb-compact',
      'stats-tokens':'#tk-sec', 'stats-cache':'#tk-cached-cell', 'stats-usage':'#usage-sec',
      'stats-review':'#rv-sec' };
    function applyTour(anchor){
      var prev=document.querySelectorAll('.ring');
      for(var i=0;i<prev.length;i++) prev[i].classList.remove('ring');
      var sel = anchor ? TOUR_ANCHORS[anchor] : null;
      var el = sel ? document.querySelector(sel) : null;
      if(el){ var q=el, changed=false; while(q&&q!==document.body){ if(q.classList&&q.classList.contains('ssec')&&q.classList.contains('sfold')){ var hd=q.querySelector('.shead'); var k=hd?hd.getAttribute('data-sec'):null; if(k){ FOLDS[k]=false; changed=true; } } q=q.parentElement; }
        if(changed){ saveSt(); applyFolds(); drawStats(); }
        el.classList.add('ring'); if(el.scrollIntoView) el.scrollIntoView({block:'nearest'}); }
    }
    window.addEventListener('message', function(e){ var m=e.data||{};
      if(m.type==='tour'){ applyTour(m.anchor||null); return; }
      if(m.type==='usage'){ renderUsage(m.u); }
      else if(m.type==='counts'){ renderCounts(m.c); renderTokens(m.t); renderVitals(m.v); renderCompactions(m.v);
        // Show the human-readable session NAME (title / first prompt); the raw id stays in the tooltip.
        var se=document.getElementById('nb-session'); if(se && m.session!==undefined){ var nm=(m.sessionTitle||'').trim();
          se.textContent = nm || (m.session ? String(m.session).slice(0,8) : '—');
          se.title = m.session ? ((nm? nm+' — ' : '')+'session '+m.session) : 'No active Claude Code session'; }
      }
      else if(m.type==='stats'){ STATS=m.data; drawStats(); }
      else if(m.type==='statsError' && !STATS){ var g=document.getElementById('gathering'); if(g) g.innerHTML='⚠ stats need the <b>oak</b> CLI, which was not found.<br><span class="dim">install it with <b>./install.sh</b> (or <b>npm i -g ./packages/cli</b> from the repo), then reload.</span>'; }
    });
    (function(){ var segs=document.querySelectorAll('.seg'); for(var i=0;i<segs.length;i++){ segs[i].addEventListener('click',function(){ range=this.getAttribute('data-r'); saveSt(); drawStats(); }); }
      var pc=document.getElementById('rv-pending-cell'); if(pc){ pc.addEventListener('click',function(){ vscode.postMessage({type:'reviewFirst'}); }); }
      var hs=document.querySelectorAll('.shead'); for(var j=0;j<hs.length;j++){ hs[j].addEventListener('click',function(){ var k=this.getAttribute('data-sec'); FOLDS[k]=!FOLDS[k]; saveSt(); applyFolds(); if(k==='ch'&&!FOLDS[k]) drawStats(); }); }
      var ur=document.getElementById('uref'); if(ur){ ur.addEventListener('click',function(ev){ ev.stopPropagation(); ur.classList.add('busy'); var ug3=document.getElementById('ug'); if(ug3) ug3.classList.add('busy'); vscode.postMessage({type:'usageRefresh'}); }); }
      var tEls0=document.querySelectorAll('.utab');
      for(var tk=0;tk<tEls0.length;tk++){ tEls0[tk].addEventListener('click',function(ev){ ev.stopPropagation(); UTAB=this.getAttribute('data-ut')||'claude'; saveSt(); if(LASTU) renderUsage(LASTU); }); }
      applyFolds();
      drawStats(); vscode.postMessage({type:'ready'}); })();
  `;
  // This session's cumulative token split, updated live with the counts. "Session tokens" (not
  // "Tokens"/"Usage" — both already name other sections of this panel): the chart below is the
  // machine-wide day/hour series, the plan bars at the bottom are point-in-time limits.
  const tokensHtml =
    `<div class="toksec ssec" id="tk-sec">` +
    `<div class="uhead shead" data-sec="tk" title="This session’s cumulative tokens, split the way the API bills them. hit rate = cache reads ÷ all context sent (input + cache reads + cache writes)."><span class="scar">▾</span>Session tokens</div>` +
    `<div class="sbody">` +
    `<div class="rvcounts">` +
    `<div class="rvc" title="Uncached input tokens sent this session"><span class="rvn" id="tk-in" style="color:var(--c-input)">—</span><span class="rvl">input</span></div>` +
    `<div class="rvc" title="Output tokens generated this session"><span class="rvn" id="tk-out" style="color:var(--acc)">—</span><span class="rvl">output</span></div>` +
    `<div class="rvc" id="tk-cached-cell" title="Input tokens served from the prompt cache; hit rate = reads ÷ all context sent"><span class="rvn" id="tk-cached" style="color:var(--c-cached)">—</span><span class="rvl" id="tk-cached-lbl">cached</span></div>` +
    `</div>` +
    `</div>` +
    `</div>`;
  // Live review scoreboard (independent of the time range): current pending/accepted/reverted counts
  // and a progress bar that fills as edits get reviewed — updated on every store change via postMessage.
  const reviewHtml =
    `<div class="ssec" id="ed-sec">` +
    `<div class="uhead shead" data-sec="ed" title="This session’s captured edits, by review status"><span class="scar">▾</span>Edits</div>` +
    `<div class="sbody">` +
    `<div class="review" id="rv-sec">` +
    `<div class="rvcounts">` +
    `<div class="rvc rvc-click" id="rv-pending-cell" title="Jump to the first edit to review"><span class="rvn" id="rv-pending" style="color:var(--c-pending)">0</span><span class="rvl">pending</span></div>` +
    `<div class="rvc"><span class="rvn" id="rv-kept" style="color:var(--c-kept)">0</span><span class="rvl">accepted</span></div>` +
    `<div class="rvc"><span class="rvn" id="rv-undone" style="color:var(--c-reverted)">0</span><span class="rvl">reverted</span></div>` +
    `</div>` +
    `<div class="rvbar"><span class="rvfill" id="rv-fill"></span></div>` +
    `<div class="rvmeta"><span id="rv-progress">no edits yet</span><span id="rv-rate"></span></div>` +
    `</div>` +
    `</div>` +
    `</div>`;
  const navbarHtml =
    `<div class="navbar">` +
    `<span class="nb-session" id="nb-session" title="Active Claude Code session">—</span>` +
    `<span class="nb-chip" id="nb-model" style="display:none"></span>` +
    // Context compactions this session (count + last drop). No chart — just the fact, which nothing else
    // on this panel states now that the per-turn context series is gone.
    `<span class="nb-chip" id="nb-compact" style="display:none"></span>` +
    `</div>`;
  const body =
    navbarHtml +
    tokensHtml +
    reviewHtml +
    `<div class="divider"></div>` +
    `<div class="ssec" id="ch-sec">` +
    `<div class="uhead shead" data-sec="ch" title="Machine-wide token series over the selected range"><span class="scar">▾</span>Tokens${legendHtml}</div>` +
    `<div class="sbody">` +
    `<div class="ranges"><button class="seg" data-r="today">Today</button><button class="seg" data-r="week">7 days</button><button class="seg" data-r="month">30 days</button></div>` +
    `<div id="gathering" class="empty">Gathering stats… <span class="dim">(first scan of your transcripts; cached after)</span></div>` +
    plotsHtml +
    `</div>` +
    `</div>` +
    `<div class="divider"></div>` +
    usageHtml +
    `<div class="tip" id="tip"></div>` +
    `<script nonce="${nonce}">${script}</script>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">${style}</head><body>${body}</body></html>`;
}

/** Build the {today, week, month} series the webview plots from a StatsResult. */
function statsData(s: core.StatsResult): unknown {
  const dt = (d: string) => {
    const p = d.split('-');
    return `${+p[1]}/${+p[2]}`;
  };
  const bucket = (label: string, b: core.BucketStat) => ({
    label,
    editsPending: b.editsPending,
    editsKept: b.editsKept,
    editsUndone: b.editsUndone,
    tokensTotal: b.tokensInput + b.tokensOutput,
    tokensInput: b.tokensInput,
    tokensOutput: b.tokensOutput,
  });
  return {
    today: s.hourly.map((h) => bucket(`${h.hour}:00`, h)),
    week: s.daily.slice(-7).map((d) => bucket(dt(d.day), d)),
    month: s.daily.map((d) => bucket(dt(d.day), d)),
  };
}

// --- Change Map webview (0.7.5): the session as one compact, ranked read -------------------------
// A one-row proportion strip for "where did the work
// land", then every touched file ranked by churn (no per-row bar — dropped 2026-09-01 with the
// terminal map's reasoning: a proportional meter answers "which is biggest", which is what the
// ranking already does, and its track read as a block of empty space). Deliberately NOT a treemap: 2-D
// tiles degenerate the moment one file dwarfs the rest (a +921 write next to a +1 tweak), and their
// geometry fights a short panel column — clipped labels, stretched aspect. A sorted bar list reads at
// any width and never clips. Every row drills to the real edit review via viewChanges. Data comes from
// the CLI `changemap --json` (the single backend, so JetBrains renders the identical model), pushed in
// via postMessage; the shell HTML is set once.

// The webview client. Plain ES5 concatenation on purpose (no template literals / no ${…}) so this can
// live inside a TS template literal without escaping — the only interpolation is the script nonce.

/** The combined Overview webview (0.8.0 round 3): MASTER–DETAIL. LEFT NAV = two sub-tabs, Fleet
 *  (running agents + nested subagents) · Workflows (runs), rendered from the `multitask --json` payload
 *  (live phase, sparkline, ±lines, tokens, time, risk, collisions) with an Active-only toggle +
 *  Clear-completed. RIGHT DETAIL = the change-map (Folders strip · churn-ranked Files ledger)
 *  for the SELECTED nav item, from `changemap --json` — CM.agents[] joined by session, CM.workflows[] by
 *  id. Rendered ONCE; both payloads arrive via postMessage (no reload flash). */
function changeMapShell(): string {
  const nonce = getNonce();
  // font-src data: — the review nav bar renders VS Code codicons via a base64 data-URI @font-face (CODICON_STYLE),
  // matching the status-bar nav bar's glyphs. Self-contained; no localResourceRoots needed.
  const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; script-src 'nonce-${nonce}';`;
  const style = `<style>${CODICON_STYLE}
  :root {
    --cm-pending: var(--vscode-charts-yellow, #d9a441);
    --cm-kept: var(--vscode-charts-green, #3fb950);
    --cm-reverted: var(--vscode-descriptionForeground, #9aa0aa);
    --cm-risk: var(--vscode-charts-red, #e5534b);
    --cm-agent: var(--vscode-charts-purple, #9a6ac2);
    --cm-accent: var(--vscode-charts-blue, #4c8bf5);
    --cm-border: var(--vscode-widget-border, rgba(127,127,127,0.28));
    --cm-mono: var(--vscode-editor-font-family, monospace);
    --mt-working: var(--vscode-charts-blue, #4c8bf5);
    --mt-attn: var(--vscode-charts-orange, #d9822b);
    --mt-warn: var(--vscode-charts-red, #e5534b);
    --mt-idle: var(--vscode-descriptionForeground, #9aa0aa);
    --mt-done: var(--vscode-charts-green, #3fb950);
    --mt-agent: var(--vscode-charts-purple, #9a6ac2);
    --mt-spark: var(--vscode-charts-blue, #4c8bf5);
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:0; font-family: var(--vscode-font-family); font-size:11px; color: var(--vscode-foreground); height:100vh; display:flex; flex-direction:column; }
  /* top navbar — session selector + session-wide review actions (mirrors the Observations toolbar) */
  /* column-REVERSE renders the rows bottom-up (user swap 2026-07-17): the controls row (DOM-second) sits
     on TOP, the diff·file·folder·prompt AXES row (DOM-first) sits BELOW it. */
  .ov-toolbar { flex:none; display:flex; flex-direction:column-reverse; align-items:stretch; gap:6px; padding:6px 10px; border-bottom:1px solid var(--cm-border); }
  /* each toolbar row is one centered cluster of groups (dividers between); wraps if a group can't fit */
  .ov-tbrow { display:flex; align-items:center; justify-content:center; gap:10px; flex-wrap:wrap; }
  /* a split row pins its first child to the left edge and its last to the right (space-between) */
  .ov-tbrow.split { justify-content:space-between; }
  /* Not a control — the session under review, stated. ONE line, never wrapped, and NEVER clipped
     (user call 2026-07-28): the whole human-readable name shows; when the row runs short the BUTTONS
     wrap to the next line (the group is flex-wrap), never the title. Tooltip carries the raw id. */
  .ov-sesslabel { font-family: var(--cm-mono); font-size:11px; color: var(--vscode-foreground); white-space:nowrap; }
  /* The "about this extension" cluster closing the controls row: version chip + settings gear, and the
     version dropdown positioned against the pair (see the markup for why it anchors here and not to
     the chip or the group). The gap replaces the one .ov-navgrp used to give these two as siblings. */
  .ov-verwrap { position:relative; display:inline-flex; align-items:center; gap:6px; }
  .ov-verchip { font-family: var(--cm-mono); white-space:nowrap; }
  .ov-verchip.upd::before { content:''; width:6px; height:6px; border-radius:50%; background:var(--vscode-charts-yellow, #d9a441); display:inline-block; margin-right:4px; }
  .ov-vermenu { position:absolute; right:0; top:calc(100% + 4px); z-index:60; min-width:240px; background:var(--vscode-editorWidget-background, var(--cm-panel)); border:1px solid var(--cm-border); border-radius:4px; padding:4px; box-shadow:0 4px 14px rgba(0,0,0,.35); }
  .ov-vermenu .vm-row { display:flex; align-items:center; gap:7px; width:100%; padding:5px 8px; border-radius:3px; cursor:pointer; color:var(--vscode-foreground); font-size:11.5px; background:none; border:none; text-align:left; }
  .ov-vermenu .vm-row:hover:not([disabled]) { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.12)); }
  .ov-vermenu .vm-row[disabled] { opacity:.6; cursor:default; }
  .ov-vermenu .vm-sec { border-top:1px solid var(--cm-border); margin:4px 2px; }
  .ov-vermenu .vm-ver { margin-left:auto; font-family:var(--cm-mono); font-size:10.5px; color:var(--vscode-descriptionForeground); }
  .ov-vermenu .vm-note { padding:3px 8px 5px; font-size:10px; color:var(--vscode-descriptionForeground); }
  /* The per-surface rows read as a table, not as buttons — they are a report, nothing to click. */
  .ov-vermenu .vm-surf { display:flex; align-items:baseline; justify-content:space-between; gap:10px; padding:2px 8px; }
  .ov-tb { display:inline-flex; align-items:center; gap:5px; background:transparent; border:1px solid var(--cm-border); border-radius:5px; color: var(--vscode-descriptionForeground); font:inherit; font-size:11px; padding:3px 9px; cursor:pointer; white-space:nowrap; }
  .ov-tb:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); color: var(--vscode-foreground); }
  /* session chip: show the FULL name — let a long one wrap/break inside the chip instead of overflowing */
  /* Active-only toggle: dim + hollow when off, accent-outlined with a green check when on. */
  .ov-toggle .codicon { opacity:0.3; }
  .ov-toggle.on { color: var(--vscode-foreground); border-color: var(--cm-accent); background: var(--vscode-list-activeSelectionBackground, rgba(80,120,200,0.14)); }
  .ov-toggle.on .codicon { opacity:1; color: var(--cm-kept); }
  .ov-tb .cm-caret { font-size:9px; opacity:0.8; }
  /* compact step-through review nav bar (mirrors the status-bar nav bar) — File/Diff axes + per-edit/file actions */
  /* codicons (status-bar-matched glyphs) in the toolbar buttons — sized down to sit with the 11px labels */
  .ov-toolbar .codicon { font-size:14px; line-height:1; }
  .ov-navgrp { display:inline-flex; align-items:center; gap:6px; flex-wrap:wrap; min-width:0; }
  .ov-nb { display:inline-flex; align-items:center; justify-content:center; gap:4px; background:transparent; border:1px solid var(--cm-border); border-radius:4px; color: var(--vscode-descriptionForeground); font:inherit; font-size:11px; line-height:1; padding:3px 9px; cursor:pointer; white-space:nowrap; }
  .ov-nb:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); color: var(--vscode-foreground); }
  /* the inline filter/sort chrome: a search field, an anchored filter dropdown, and buttons whose
     labels carry their own state (sort mode · what the filter narrows by) — no pop-up leaves the panel */
  /* The right control cluster GROWS to fill the row (the search rides its slack), so the search field
     scales with the panel width instead of sitting at a fixed 180px. */
  .ov-navgrp-grow { flex:1 1 auto; }
  .ov-searchwrap { display:inline-flex; align-items:center; gap:4px; border:1px solid var(--cm-border); border-radius:4px; padding:2px 7px; color: var(--vscode-descriptionForeground); flex:1 1 auto; min-width:120px; }
  .ov-searchwrap .codicon { font-size:12px; color: var(--mt-agent); flex:none; }
  .ov-searchwrap:focus-within { border-color: var(--vscode-focusBorder); }
  .ov-search-inp { background:transparent; border:none; outline:none; color: var(--vscode-foreground); font:inherit; font-size:12px; line-height:1; flex:1 1 auto; width:auto; min-width:60px; padding:2px 0; }
  .ov-search-inp::placeholder { color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground)); }
  .ov-nb.on { border-color: var(--mt-agent); color: var(--vscode-foreground); }
  .ov-nb.on .codicon { color: var(--mt-agent); }
  #ov-filter-lbl, #ov-sort-lbl { max-width:42vw; overflow:hidden; text-overflow:ellipsis; }
  .ov-drop-anchor { position:relative; display:inline-flex; }
  .ov-filterdrop { position:absolute; top:100%; right:0; margin-top:4px; z-index:40; min-width:170px; max-height:60vh; overflow:auto;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border:1px solid var(--vscode-editorWidget-border, var(--cm-border));
    border-radius:5px; box-shadow:0 3px 10px rgba(0,0,0,0.35); padding:5px; text-align:left; }
  .ov-fd-head { font-size:9px; letter-spacing:.06em; text-transform:uppercase; color: var(--vscode-descriptionForeground); padding:5px 6px 2px; }
  .ov-fd-row { display:flex; align-items:center; gap:6px; padding:3px 6px; font-size:11px; color: var(--vscode-foreground); cursor:pointer; border-radius:3px; white-space:nowrap; }
  .ov-fd-row:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); }
  .ov-fd-row input { margin:0; }
  .ov-sortrow { cursor:pointer; }
  .ov-fd-ck { display:inline-block; width:14px; flex:none; color: var(--mt-agent); font-weight:600; }
  .ov-fd-empty { padding:8px 6px; font-size:11px; color: var(--vscode-descriptionForeground); }
  .ov-fd-foot { border-top:1px solid var(--cm-border); margin-top:5px; padding-top:5px; text-align:right; }
  #ov-fd-clear { background:transparent; border:1px solid var(--cm-border); border-radius:4px; color: var(--vscode-descriptionForeground); font:inherit; font-size:10px; padding:2px 8px; cursor:pointer; }
  #ov-fd-clear:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); }
  .ov-nc { font-family: var(--cm-mono); font-size:10px; color: var(--vscode-descriptionForeground); font-variant-numeric:tabular-nums; white-space:nowrap; padding:0 3px; }
  .ov-nbsep { width:1px; align-self:stretch; background: var(--cm-border); margin:1px 4px; }
  /* semantic tints on the nav-bar ICONS (labels stay neutral) — the --mt-/chart palette, matching the
     JetBrains ReviewNavBar: keep/accept GREEN · undo/reject RED · nav chevrons BLUE · clear ORANGE ·
     search/spotlight PURPLE. Same glance-grouping as the mockups/screenshots. */
  #ov-navkeep .codicon, #ov-acceptfile .codicon, #ov-acceptfolder .codicon, #ov-keepall .codicon, #ov-acceptprompt .codicon { color: var(--mt-done); }
  #ov-navundo .codicon, #ov-rejectfile .codicon, #ov-rejectfolder .codicon, #ov-undoall .codicon, #ov-rejectprompt .codicon, #ov-rewindprompt .codicon { color: var(--mt-warn); }
  #ov-fileprev .codicon, #ov-filenext .codicon, #ov-diffprev .codicon, #ov-diffnext .codicon, #ov-folderprev .codicon, #ov-foldernext .codicon, #ov-promptprev .codicon, #ov-promptnext .codicon { color: var(--mt-working); }
  #ov-reviewprompt .codicon, #ov-chatedit .codicon, #ov-viewdiff .codicon { color: var(--cm-accent); }
  #ov-clearres .codicon { color: var(--mt-attn); }
  #ov-search .codicon, #ov-spotlight .codicon, #ov-resetscope .codicon { color: var(--mt-agent); }
  /* The theme's dark charts-orange is muddy / low-contrast; brighten the Clear tint on dark themes. */
  body.vscode-dark #ov-clearres .codicon, body.vscode-dark .cm-tb.cl .codicon { color: #e6a44c; }
  /* master–detail: left NAV (Fleet · Workflows) | right change-map DETAIL for the selected nav item */
  .ov { display:flex; flex:1; min-height:0; align-items:stretch; }
  /* The master/detail split is the reader's to set: --ov-nav is the nav's size along the CURRENT axis
     (its width side by side, its height stacked), dragged on the gutter and kept in webview state. */
  .ov-nav { flex:0 0 var(--ov-nav, 25%); min-width:150px; display:flex; flex-direction:column; border-right:1px solid var(--cm-border); padding:6px 8px 7px; overflow:hidden; }
  .ov-gutter { flex:none; width:7px; margin:0 -3px; cursor:col-resize; position:relative; z-index:2; touch-action:none; }
  .ov-gutter::after { content:''; position:absolute; top:0; bottom:0; left:3px; width:1px; background:transparent; }
  .ov-gutter:hover::after, .ov-gutter.drag::after { background: var(--vscode-focusBorder, rgba(127,127,127,0.7)); }
  .ov-detail { flex:1; min-width:0; display:flex; flex-direction:column; padding:6px 8px 7px; overflow:hidden; }

  /* --- NARROW LAYOUT ------------------------------------------------------------------------------
     This panel is usually a wide bottom dock, but it is a movable view: dragged into a side bar it gets
     a fraction of that width, and a master-detail split then gives BOTH halves too little. Below the
     breakpoints the split becomes a stack, the chrome gives up its padding before the content does, and
     each row sheds its least-load-bearing column rather than squeezing the name that identifies it. */
  @media (max-width: 640px) {
    .ov { flex-direction:column; }                       /* nav ABOVE detail, each with the full width */
    .ov-nav { flex:0 0 var(--ov-navv, 45%); max-width:none; min-width:0; border-right:none; border-bottom:1px solid var(--cm-border); }
    .ov-gutter { width:auto; height:7px; margin:-3px 0; cursor:row-resize; }
    .ov-gutter::after { top:3px; bottom:auto; left:0; right:0; width:auto; height:1px; }
    .ov-nav .ov-list { overflow-y:auto; }
    /* Stacked, never shrunk: three 150px columns do not fit a side-bar width, and narrowing them would
       clip the names they exist to show. Each column keeps its own scrolling list. */
    .ov-group { flex-direction:column; }
    /* Stacked, the reader's dragged widths mean nothing (they are widths), so every column takes an
       equal share again and the dividers go away with them. */
    .ov-groupcol { min-width:0; flex:1 1 0; }
    .ov-cgutter { display:none; }
    .ov-group .ov-groupcol.rail { flex:0 0 auto; }
    .ov-groupcol.rail .ov-rail { writing-mode:horizontal-tb; height:auto; padding:4px 6px; }
    .ov-groupcol + .ov-groupcol { border-left:none; padding-left:0; border-top:1px solid var(--cm-border); padding-top:6px; }
    .ov-tab { padding:3px 8px; }
    .ov-toolbar { gap:3px; padding:4px 6px; }
    .ov-tb, .ov-nb { padding:2px 7px; }
    /* An inline-flex group is sized to its content and will overflow the panel rather than wrap inside
       itself — a percentage max-width does not clamp it (verified in a browser). Giving it the whole row
       does: below the breakpoint each axis takes a line and breaks between its own buttons. */
    .ov-navgrp { display:flex; flex:1 1 100%; }
    .ov-nbsep { display:none; }
    /* A duplicate age cell is still dropped, but the row's badges are NO LONGER shed at narrow widths:
       the mt-trow rule wraps them onto the next line instead, so every badge stays
       legible however far the panel is squeezed. */
    .mt-trow .mt-tct + .mt-tct { display:none; }
  }
  @media (max-width: 460px) {
    .ov-navtabs { gap:2px; }
    .ov-tab { padding:3px 6px; font-size:10.5px; }
    .ov-desc { display:none; }                           /* the pane's one-line description */
    .cm-caption { font-size:9px; margin-bottom:1px; }
  }
  /* left-nav sub-tabs (Fleet · Workflows) */
  /* wraps rather than clipping: a fourth tab (Processes) doesn't fit beside the others in a 25% column */
  /* …and a FIFTH (Prompts) makes it tighter still: the row is allowed to wrap onto as many lines as it
     needs, and each tab keeps its label whole rather than being squeezed into an ellipsis. */
  .ov-navtabs { display:flex; flex:none; flex-wrap:wrap; gap:4px; margin-bottom:6px; }
  /* The tab strip and the control that REARRANGES it, on one row (user call 2026-07-30): "Group tabs"
     was in the panel-wide toolbar, three rows away from the tabs it regroups. The tabs keep the row's
     slack and wrap within it; the toggle never wraps away from them. */
  .ov-navtabrow { display:flex; align-items:flex-start; gap:6px; flex:none; margin-bottom:6px; }
  .ov-navtabrow .ov-navtabs { flex:1 1 auto; margin-bottom:0; min-width:0; }
  .ov-navtabrow #ov-groupnav { flex:none; }
  /* Guided tour (0.8.9): the ring on the control a step names. An outline rather than a border so it
     costs no layout — a highlight that reflowed the panel it points at would move the very thing the
     reader is looking for. The step's TEXT lives in the tour window; repeating it in here as well was
     one sentence of duplication for seven pixels of every panel, so it is gone. */
  .ov-ring { outline:2px solid var(--vscode-charts-blue, #4c8bf5); outline-offset:1px; border-radius:3px; }
  .ov-tab { flex:none; display:flex; align-items:center; gap:6px; background:transparent; border:1px solid var(--cm-border); border-radius:5px 5px 0 0; border-bottom:2px solid transparent; color: var(--vscode-descriptionForeground); font:inherit; font-size:11px; padding:4px 12px; cursor:pointer; white-space:nowrap; }
  .ov-tab:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); }
  .ov-tab.on { color: var(--vscode-foreground); border-bottom-color: var(--mt-working); background: var(--vscode-list-activeSelectionBackground, rgba(80,120,200,0.18)); }
  .ov-tn { font-family: var(--cm-mono); font-size:9px; opacity:0.72; font-variant-numeric:tabular-nums; }
  /* running/total while a background shell is still going — the same green the "running" row badge uses. */
  .ov-tn.hot { color: var(--mt-done); opacity:1; }
  .ov-ctl { display:flex; align-items:center; gap:8px; margin-bottom:5px; flex:none; flex-wrap:wrap; }
  .ov-pane { flex:1; min-height:0; display:flex; flex-direction:column; }
  /* Grouped nav: one pane, its members side by side. min-width is the same 150px floor the nav itself
     uses — below it a session name cannot be read, and this product wraps or tooltips rather than
     truncating, so the narrow branch STACKS these columns instead of squeezing them.
     --ov-cw is the column's share of the group, dragged on the divider and remembered in webview state;
     the floor above is what the drag clamps against. */
  .ov-group { flex-direction:row; gap:8px; }
  .ov-groupcol { flex: var(--ov-cw, 1) 1 0; min-width:150px; min-height:0; display:flex; flex-direction:column; position:relative; }
  .ov-groupcol + .ov-groupcol { border-left:1px solid var(--cm-border); padding-left:8px; }
  /* The divider between two columns. An absolutely-positioned OVERLAY on the column's left edge rather
     than a sibling element, so the adjacent-sibling rule above still sees the columns as adjacent — a
     real element between them would silently drop every column's border and padding.
     (No backticks in this file's style/script literals: they would close the TS template.) */
  .ov-cgutter { position:absolute; left:-8px; top:0; bottom:0; width:9px; cursor:col-resize; z-index:3; touch-action:none; }
  .ov-cgutter::after { content:''; position:absolute; top:0; bottom:0; left:4px; width:1px; background:transparent; }
  .ov-cgutter:hover::after, .ov-cgutter.drag::after { background: var(--vscode-focusBorder, rgba(127,127,127,0.7)); }
  /* A folded column keeps its NAME and its badge on a rail you can click to bring it back — a column
     that vanished with no affordance is a bug the reader cannot even describe. Its remembered weight is
     untouched while folded, so restoring gives back the width they set rather than an equal share. */
  .ov-group .ov-groupcol.rail { flex:0 0 28px; min-width:28px; padding-left:0; overflow:hidden; }
  .ov-groupcol .ov-rail { display:none; }
  .ov-groupcol.rail .ov-rail { display:flex; align-items:center; justify-content:flex-start; gap:6px; width:100%; height:100%; background:transparent; border:0; color: var(--vscode-descriptionForeground); font:inherit; font-size:9px; letter-spacing:.6px; text-transform:uppercase; cursor:pointer; padding:6px 0; writing-mode:vertical-rl; }
  .ov-groupcol.rail .ov-rail:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); }
  .ov-groupcol.rail .ov-ghead, .ov-groupcol.rail .ov-list, .ov-groupcol.rail .ov-cgutter { display:none; }
  .ov-cfold { margin-left:auto; flex:none; background:transparent; border:0; color: var(--vscode-descriptionForeground); font:inherit; line-height:1; padding:0 2px; cursor:pointer; }
  .ov-cfold:hover { color: var(--vscode-foreground); }
  .ov-cfold .codicon { font-size:12px; vertical-align:middle; }
  .ov-ghead { flex:none; display:flex; align-items:center; gap:6px; font-size:9px; letter-spacing:.6px; text-transform:uppercase; color: var(--vscode-descriptionForeground); padding:0 2px 5px; margin-bottom:4px; border-bottom:1px solid var(--cm-border); }
  /* one-line description at the top of each nav pane (Fleet / Workflows / Tasks) — what the list shows */
  .ov-desc { flex:none; font-size:10px; line-height:1.4; color: var(--vscode-descriptionForeground); padding:0 2px 6px; margin-bottom:4px; border-bottom:1px solid var(--cm-border); }
  .ov-list { flex:1; overflow-y:auto; min-height:0; }
  .ov-empty { padding:12px 2px; color: var(--vscode-descriptionForeground); line-height:1.5; }
  .ov-empty b { color: var(--vscode-foreground); }
  /* display-filter controls (shared by Fleet + Workflows): Active-only toggle + Clear-completed */
  .mt-toggle { display:flex; align-items:center; gap:4px; font-size:10px; color: var(--vscode-descriptionForeground); cursor:pointer; white-space:nowrap; }
  .mt-toggle input { margin:0; cursor:pointer; }
  .mt-clear { background:transparent; border:1px solid var(--cm-border); border-radius:4px; color: var(--vscode-descriptionForeground); font:inherit; font-size:10px; padding:2px 8px; cursor:pointer; white-space:nowrap; }
  .mt-clear:hover:not(:disabled) { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); color: var(--vscode-foreground); }
  .mt-clear:disabled { opacity:0.45; cursor:default; }
  .mt-fbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:0 0 5px; font-family: var(--cm-mono); font-size:9.5px; color: var(--vscode-descriptionForeground); }
  .mt-fon { color: var(--mt-working); font-variant-numeric:tabular-nums; }
  .mt-fhide { cursor:pointer; text-decoration:underline; text-underline-offset:2px; }
  .mt-fhide:hover { color: var(--vscode-foreground); }
  /* Fleet: one row per running agent (worktree-sibling) + nested subagents; selected row is outlined */
  .mt-agent { border:1px solid var(--cm-border); border-radius:5px; margin-bottom:5px; padding:5px 7px; cursor:pointer; }
  .mt-agent:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.08)); }
  .mt-agent.sel { border-color: var(--cm-accent); background: var(--vscode-list-activeSelectionBackground, rgba(80,120,200,0.14)); }
  /* WRAPS rather than clipping (like the nav tabs above): in a 25%-wide column the tail of this row —
     which is where the outside-the-workspace suffix rides — otherwise renders hundreds of pixels past
     the right edge, i.e. not at all. A fact you cannot see is a fact not reported. */
  .mt-arow { display:flex; align-items:center; gap:7px; flex-wrap:wrap; }
  .mt-badge { color:#fff; font-size:9px; font-weight:600; padding:1px 6px; border-radius:99px; white-space:nowrap; flex:none; }
  .mt-badge.sm { font-size:8px; padding:0 5px; }
  .mt-badge.xs { padding:0; width:8px; height:8px; border-radius:99px; }
  .mt-wt { font-family: var(--cm-mono); font-size:11px; overflow-wrap:anywhere; flex:0 1 auto; min-width:40px; }
  .mt-self { font-size:8px; color: var(--vscode-editor-background,#1e1e1e); background: var(--mt-idle); border-radius:3px; padding:0 3px; margin-left:5px; }
  .mt-br { font-size:9px; color: var(--vscode-descriptionForeground); margin-left:5px; }
  .mt-spark { width:60px; height:16px; flex:none; margin-left:auto; }
  .mt-spark rect { fill: var(--mt-spark); }
  .mt-diff { font-family: var(--cm-mono); font-size:9.5px; flex:none; font-variant-numeric:tabular-nums; }
  .mt-diff.sm { font-size:9px; }
  .mt-add { color: var(--mt-done); }
  .mt-rem { color: var(--mt-warn); }
  .mt-meta { font-family: var(--cm-mono); font-size:9px; color: var(--vscode-descriptionForeground); flex:none; white-space:nowrap; }
  .mt-store { cursor:pointer; text-decoration:underline dotted; text-underline-offset:2px; }
  .mt-store:hover { color: var(--vscode-textLink-foreground); }
  #ov-store-size { font-family: var(--cm-mono); font-size:10px; opacity:.75; margin-left:2px; }
  .mt-risk { font-size:9px; color: var(--mt-attn); flex:none; }
  .mt-risk[data-high] { color: var(--mt-warn); font-weight:600; }
  .mt-col { font-size:9px; color: var(--mt-warn); flex:none; }
  /* flex-wrap + real minimums: the shrinkable description column used to be crushed to a few
     pixels by the fixed metric spans, and overflow-wrap:anywhere then broke it LETTER BY LETTER
     at narrow widths — tight widths now wrap whole columns to the next line. */
  .mt-sub { display:flex; flex-wrap:wrap; align-items:center; gap:2px 6px; padding:3px 0 0 10px; margin-top:3px; border-top:1px dashed var(--cm-border); }
  .mt-sub[data-agent] { cursor:pointer; }
  .mt-sub.sel { background: var(--vscode-list-activeSelectionBackground, rgba(80,120,200,0.14)); border-radius:3px; }
  .mt-st { font-size:10px; color: var(--mt-agent); flex:0 1 auto; min-width:130px; }
  .mt-sd { color: var(--vscode-descriptionForeground); margin-left:5px; font-style:italic; overflow-wrap:anywhere; }
  .mt-cur { font-size:9px; color: var(--vscode-foreground); overflow-wrap:anywhere; flex:0 1 auto; min-width:110px; }
  .mt-todo { font-size:9px; color: var(--vscode-descriptionForeground); flex:none; }
  .mt-chat { margin-left:auto; background:transparent; border:0; cursor:pointer; font-size:11px; padding:0 2px; flex:none; opacity:0.75; }
  .mt-chat:hover { opacity:1; }
  .mt-chead { font-family: var(--cm-mono); text-transform:uppercase; letter-spacing:0.08em; font-size:9px; color: var(--vscode-descriptionForeground); margin-bottom:4px; }
  /* "what you're looking at isn't what you selected" — deliberately NOT amber/red: those two colours mean
     outside-the-workspace and high-risk on this panel, and a third meaning would dilute both. */
  .mt-scope { font-size:9.5px; line-height:1.35; color: var(--vscode-descriptionForeground); border-left:2px solid var(--cm-border); padding:2px 0 2px 6px; margin-bottom:5px; }
  /* Tasks tab — the session's numbered task list */
  /* model · effort on a session row (0.9.0) — a quiet chip, not a status: it never means anything is wrong */
  .mt-resolve { flex:none; font-size:9px; background:transparent; border:1px solid var(--cm-border); border-radius:3px; color: var(--vscode-descriptionForeground); padding:0 5px; margin-left:4px; cursor:pointer; }
  .mt-resolve:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
  .mt-resolve.mt-del:hover { color: var(--vscode-errorForeground, #f14c4c); border-color: var(--vscode-errorForeground, #f14c4c); }
  .mt-schip { flex:none; font-family: var(--cm-mono); font-size:9px; color: var(--vscode-descriptionForeground); border:1px solid var(--cm-border); border-radius:3px; padding:0 4px; white-space:nowrap; }
  .mt-agentbadge { flex:none; font-family: var(--cm-mono); font-size:9px; color: var(--c-pending, #d19a66); border:1px solid var(--c-pending, #d19a66); border-radius:3px; padding:0 4px; white-space:nowrap; }
  /* WRAPS rather than clips: when the panel is too narrow to hold a row's cells on
     one line, they wrap to the next line instead of being clipped or shed — the name keeps the row's
     slack and every badge stays legible. */
  .mt-trow { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 7px; font-size:11px; padding:2px 2px; border-radius:3px; }
  .mt-trow .mt-tg { flex:none; }
  .mt-trow[data-feed] { cursor:pointer; }
  .mt-trow[data-feed]:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.10)); }
  .mt-trow.sel { background: var(--vscode-list-activeSelectionBackground, rgba(80,120,200,0.14)); }
  .mt-trow.done .mt-tg { color: var(--mt-done); }
  .mt-trow.wip .mt-tg { color: var(--mt-working); }
  .mt-trow.open .mt-tg { color: var(--vscode-descriptionForeground); }
  .mt-trow .mt-tid { flex:none; font-family: var(--cm-mono); color: var(--vscode-descriptionForeground); font-size:10px; }
  /* The name gets the row's slack, but never less than a readable column: with three fixed-width
     neighbours it was being squeezed to a few characters and wrapping one letter per line. */
  .mt-trow .mt-ts { min-width:12ch; flex:1 1 auto; overflow-wrap:anywhere; }
  .mt-trow.done .mt-ts { text-decoration: line-through; color: var(--vscode-descriptionForeground); }
  .mt-trow .mt-taf { flex:none; font-style:italic; color: var(--mt-working); font-size:10px; }
  .mt-trow .mt-tct { flex:none; font-family: var(--cm-mono); color: var(--vscode-descriptionForeground); font-size:10px; }
  .mt-trow .mt-pend { color: var(--mt-pending, var(--vscode-charts-yellow)); }
  .mt-trow .mt-done { color: var(--mt-done); }
  /* Per-task review chips — Accept / Reject / Clear over the task's STRICT in-progress span. Shown
     only on a row whose span actually holds edits: a chip that can act on nothing is noise. */
  .mt-trow .mt-tops { flex:none; display:inline-flex; gap:3px; opacity:0; transition:opacity .1s; }
  .mt-trow:hover .mt-tops, .mt-trow.sel .mt-tops { opacity:1; }
  .mt-trow .mt-top { background:transparent; border:1px solid var(--cm-border); border-radius:3px; color:inherit; font:inherit; font-size:10px; line-height:1; padding:1px 5px; cursor:pointer; }
  .mt-trow .mt-top:hover { border-color: var(--cm-accent); }
  .mt-trow .mt-top.keep { color: var(--mt-done); }
  .mt-trow .mt-top.undo { color: var(--mt-warn); }
  .mt-ttog { display:block; background:transparent; border:1px dashed var(--cm-border); border-radius:99px; color: var(--vscode-descriptionForeground); font:inherit; font-size:10px; padding:2px 9px; margin:4px 0 2px; cursor:pointer; }
  .mt-ttog:hover { color: var(--vscode-foreground); }
  .mt-trow .mt-tdep { flex:none; color: var(--mt-attn); font-size:10px; }
  .mt-none { padding:10px 2px; color: var(--vscode-descriptionForeground); font-size:11px; }
  /* folded group (0.9.0): week-old conversations, collapsed and not rebuilt */
  .mt-foldhdr { cursor:pointer; user-select:none; margin:6px 0 3px; padding:3px 4px; border-top:1px solid var(--vscode-panel-border); font-family: var(--cm-mono); font-size:9.5px; color: var(--vscode-descriptionForeground); }
  .mt-foldhdr:hover { color: var(--vscode-foreground); }
  .mt-agent.folded { opacity:.72; }
  .mt-unloaded { font-family: var(--cm-mono); font-size:9px; color: var(--vscode-descriptionForeground); font-style:italic; margin-left:6px; }
  /* Processes tab — one row per background shell (run_in_background). No pid column: the transcript
     records no OS pid, so the harness's shell id is the identity. */
  .mt-folded { color: var(--vscode-descriptionForeground); }
  .mt-proc { border:1px solid var(--cm-border); border-radius:5px; margin-bottom:5px; padding:5px 7px; cursor:pointer; }
  .mt-proc:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.08)); }
  .mt-proc.sel { border-color: var(--cm-accent); background: var(--vscode-list-activeSelectionBackground, rgba(80,120,200,0.14)); }
  .mt-pid { font-family: var(--cm-mono); font-size:10px; color: var(--vscode-foreground); flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; }
  .mt-pcmd { font-size:9.5px; color: var(--vscode-descriptionForeground); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  /* The prompt SCOPE bar — this panel is filtered to one ask (picked in the Prompts window beside it).
     The ask is named IN FULL and wraps over as many lines as it needs: the whole point of the bar is
     that you can see which question you are looking at the answer to. */
  /* Workflows: one row per run — informative name, per-phase progress, tokens/time/edits; selected outlined */
  .mt-wf { border:1px solid var(--cm-border); border-radius:5px; margin-bottom:5px; padding:5px 7px; cursor:pointer; }
  .mt-wf:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.08)); }
  .mt-wf.sel { border-color: var(--cm-accent); background: var(--vscode-list-activeSelectionBackground, rgba(80,120,200,0.14)); }
  /* A NEWLY-started run pulses twice as the nav auto-focuses it (class dropped after ~3s). */
  .mt-wf.flash { animation: ovwfpulse 1.3s ease-in-out 2; }
  @keyframes ovwfpulse { 50% { box-shadow: 0 0 0 2px var(--cm-accent) inset; } }
  .mt-wrow { display:flex; align-items:flex-start; gap:7px; padding:0; cursor:pointer; }
  .mt-wcar { background:transparent; border:0; color: var(--vscode-descriptionForeground); font:inherit; font-size:13px; line-height:1.25; width:18px; flex:none; cursor:pointer; padding:0; }
  /* The workflow name/description WRAPS to its full text (never clipped) — it's the run's identity and can be
     long; the metrics ride the .mt-wmet line below so nothing competes with it for width. */
  .mt-wname { font-weight:600; color: var(--vscode-foreground); white-space:normal; overflow-wrap:anywhere; flex:1 1 auto; min-width:0; line-height:1.3; }
  /* metrics line under the name: sparkline · ±diff · N ag · tokens · time · edits (indented past the caret) */
  .mt-wmet { display:flex; align-items:center; gap:7px; flex-wrap:wrap; padding:3px 3px 1px 22px; }
  .mt-wmet .mt-spark { margin-left:0; }
  .mt-wmeta { font-family: var(--cm-mono); font-size:10px; color: var(--vscode-descriptionForeground); white-space:nowrap; flex:none; }
  .mt-wsub { padding:0 3px 1px 21px; font-family: var(--cm-mono); font-size:9px; color: var(--vscode-descriptionForeground); opacity:0.8; }
  .mt-wphs { padding:1px 3px 2px 21px; font-size:9.5px; color: var(--vscode-descriptionForeground); font-variant-numeric:tabular-nums; }
  .mt-wphg { padding:3px 3px 1px 20px; font-size:9px; text-transform:uppercase; letter-spacing:0.05em; color: var(--vscode-foreground); }
  .mt-wpn { font-family: var(--cm-mono); opacity:0.75; text-transform:none; letter-spacing:0; }
  .mt-wag { display:flex; align-items:center; gap:6px; padding:1px 3px 1px 28px; font-size:11px; }
  .mt-wat { color: var(--vscode-foreground); overflow-wrap:anywhere; flex:0 1 auto; min-width:64px; }

  /* right DETAIL — the change-map for the selected nav item */
  /* section captions above the Folders strip and the Files ledger — small, muted, uppercase */
  .cm-caption { flex:none; font-size:9px; letter-spacing:.6px; text-transform:uppercase; color: var(--vscode-descriptionForeground); opacity:.85; margin:0 0 3px 1px; }
  .cm-rwrap { display:flex; flex-direction:column; gap:2px; }
  .cm-compact { font-size:9px; color: var(--vscode-descriptionForeground); border-top:1px dashed var(--cm-border); padding:3px 3px 1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  /* the fleet row's outside-the-workspace suffix (0.8.7: all that survives of the footprint badge row —
     the audits in the Actions panel own the rest, so this stays one glanceable fact per row) */
  .mt-cap { font-size:9px; color: var(--vscode-descriptionForeground); flex:none; }
  .mt-cap[data-attn] { color: var(--mt-attn); }
  .cm-done-list { margin-top:2px; }
  .cm-done-row { display:flex; gap:6px; margin-top:3px; }
  .cm-cg { width:9px; height:9px; border-radius:99px; flex:none; border:1.5px solid var(--vscode-descriptionForeground); }
  .cm-cg.kept { background: var(--cm-kept); border-color: var(--cm-kept); }
  .cm-cg.pending { border-color: var(--cm-pending); box-shadow: inset 0 -4px 0 var(--cm-pending); }
  .cm-cg.undone { background: var(--cm-reverted); border-color: var(--cm-reverted); }
  .cm-cg.todo { border-style:dashed; }
  .cm-ct { flex:1; min-width:0; font-size:12px; line-height:1.4; color: var(--vscode-descriptionForeground); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; }
  .cm-ce { font-family: var(--cm-mono); font-size:10px; color: var(--vscode-descriptionForeground); flex:none; }
  .cm-tbtns { display:flex; align-items:center; gap:1px; flex:none; margin-left:1px; opacity:0.55; }
  .cm-tb { background:transparent; border:0; color:inherit; font:inherit; font-size:14px; line-height:1; padding:2px 5px; cursor:pointer; opacity:0.85; }
  .cm-tb .codicon { font-size:14px; vertical-align:middle; }

  .cm-tb.ok .codicon { color: var(--mt-done); }
  .cm-tb.rj .codicon { color: var(--mt-warn); }
  .cm-tb.cl .codicon { color: var(--mt-attn); }
  .cm-tb.ch .codicon, .mt-chat .codicon { color: var(--mt-agent); font-size:12px; vertical-align:middle; }
  .cm-tb:hover { opacity:1; }
  .cm-tb.ok:hover { color: var(--cm-kept); }
  .cm-tb.rj:hover { color: var(--cm-risk); }
  .cm-tb.ch:hover { color: var(--cm-accent); }
  .cm-done-tog { display:inline-flex; align-items:center; gap:6px; background:transparent; border:1px dashed var(--cm-border); border-radius:99px; color: var(--vscode-descriptionForeground); font:inherit; font-size:12px; padding:3px 9px; cursor:pointer; }
  .cm-done-tog:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.14)); color: var(--vscode-foreground); }
  .cm-clear-done { display:inline-flex; align-items:center; background:transparent; border:1px dashed var(--cm-border); border-radius:99px; color: var(--vscode-descriptionForeground); font:inherit; font-size:11px; padding:3px 9px; cursor:pointer; }
  .cm-clear-done:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.14)); color: var(--vscode-foreground); }
  .cm-caret { font-size:9px; opacity:0.8; }
  /* proportion strip — where the work landed. It WRAPS: segments hold a readable floor width
     (~86px) and spill onto a second row rather than shrinking into unreadable slivers, which is what
     makes both a narrow panel and the expanded (all-folders) form legible. */
  .cm-strip { display:flex; flex-wrap:wrap; gap:1px; min-height:17px; border-radius:3px; overflow:hidden; flex:none; margin-bottom:6px; background: var(--vscode-editorWidget-background, rgba(127,127,127,0.15)); }
  /* Expanded, a repo-wide session runs to dozens of rows — cap it at five and scroll, so opening the
     folders never pushes the file ledger out of view. */
  .cm-strip.open { max-height:89px; overflow-y:auto; }
  .cm-sg { border:0; padding:0 4px; cursor:pointer; height:17px; flex:1 1 86px; display:flex; align-items:center; justify-content:center; overflow:hidden; min-width:0; }
  .cm-sgx { font-family: var(--cm-mono); font-size:9px; font-weight:600; color: var(--vscode-descriptionForeground); background: var(--vscode-editorWidget-background, rgba(127,127,127,0.22)); }
  .cm-sgx:hover { color: var(--vscode-foreground); }
  .cm-sg.sel { outline:1px solid var(--vscode-foreground); outline-offset:-1px; }
  .cm-sl { font-size:9px; color:rgba(0,0,0,.78); font-family: var(--cm-mono); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:600; }
  /* ranked ledger */
  .cm-ledger { flex:1; overflow-y:auto; min-height:0; }
  /* "N min ago" to the left of each file — dim, fixed width so the filenames align. */
  .cm-age { flex:none; width:66px; text-align:right; padding-right:8px; color:var(--vscode-descriptionForeground); opacity:.75; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .cm-row { display:flex; align-items:center; gap:6px; width:100%; background:transparent; border:0; color:inherit; font:inherit; padding:2px 3px; cursor:pointer; text-align:left; border-radius:3px; }
  .cm-row:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); }
  .cm-dot { width:6px; height:6px; border-radius:2px; flex:none; }
  /* WRAPS, never ellipses (the no-truncation rule; a narrow panel showed clipped
     names beside free width) — long names take a second line inside the row. */
  .cm-fn { font-family: var(--cm-mono); font-size:10px; white-space:normal; overflow-wrap:anywhere; flex:0 1 auto; min-width:120px; }
  .cm-ag { color: var(--cm-agent); font-size:7px; margin-left:3px; }
  .cm-rk { color: var(--cm-risk); font-size:9px; margin-left:3px; }
  .cm-md { font-size:8.5px; color: var(--vscode-descriptionForeground); white-space:nowrap; flex:none; }
  .cm-n { font-family: var(--cm-mono); font-size:9px; width:40px; text-align:right; flex:none; font-variant-numeric:tabular-nums; color: var(--vscode-descriptionForeground); }
  .cm-pd { font-family: var(--cm-mono); font-size:9px; width:30px; text-align:right; flex:none; font-variant-numeric:tabular-nums; }
  /* The name is the click target; the row is a container, so its two action buttons are valid markup. */
  .cm-open { display:flex; align-items:center; gap:6px; flex:1; min-width:0; background:transparent; border:0; color:inherit; font:inherit; padding:0; cursor:pointer; text-align:left; }
  /* Disabled rather than hidden when nothing is pending: a row that changes shape as its counts change
     makes the whole ledger jump, and the tooltip already says why the button will not act. */
  .cm-act { flex:none; width:20px; height:18px; padding:0; border:0; border-radius:3px; cursor:pointer; font:inherit; font-size:11px; line-height:1; background:transparent; color: var(--vscode-descriptionForeground); }
  .cm-act:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.2)); }
  .cm-act:disabled { opacity:.28; cursor:default; }
  .cm-keep:hover:not(:disabled) { color: var(--vscode-charts-green, #89d185); }
  .cm-undo:hover:not(:disabled) { color: var(--vscode-charts-red, #f14c4c); }
  .cm-stk:hover { color: var(--cm-accent); }
  .cm-none { padding:10px 4px; color: var(--vscode-descriptionForeground); }
  .cm-empty { padding:14px 4px; color: var(--vscode-descriptionForeground); line-height:1.5; }
  .cm-empty b { color: var(--vscode-foreground); }
  .cm-readout { font-family: var(--cm-mono); font-size:12px; color: var(--vscode-foreground); margin-top:6px; min-height:16px; flex:none; }
  /* bottom summary bar — pending/accepted edit · file · folder totals for the current change-map view */
  .cm-summary { font-family: var(--cm-mono); font-size:10.5px; color: var(--vscode-descriptionForeground); flex:none; padding-top:5px; margin-top:4px; border-top:1px solid var(--cm-border); font-variant-numeric:tabular-nums; }
  /* "N hidden" — what .observatoryignore removed. Deliberately quieter than the counts beside it:
     it describes what is NOT on screen, so it must be findable without competing with what is. */
  .cm-summary:empty { display:none; }
  .cm-summary b { color: var(--vscode-foreground); }
  .cm-readout b { color: var(--vscode-foreground); }
  /* (the .ov-f* live-feed rules lived here — the feed renders in the Timeline's Feed tab now, 0.10.0) */
  .cm-tip { position:fixed; pointer-events:none; opacity:0; z-index:9; max-width:300px; background: var(--vscode-editorHoverWidget-background, #252526); color: var(--vscode-editorHoverWidget-foreground, #ccc); border:1px solid var(--vscode-editorHoverWidget-border, rgba(127,127,127,0.3)); border-radius:5px; padding:7px 9px; font-size:10px; box-shadow:0 6px 20px -8px rgba(0,0,0,.6); }
  .cm-tip .tf { font-family: var(--cm-mono); font-weight:600; margin-bottom:2px; }
  .cm-tip .tf .ag { color: var(--cm-agent); }
  .cm-tip .tf .rk { color: var(--cm-risk); }
  .cm-tip .tm { font-family: var(--cm-mono); font-size:9px; color: var(--vscode-descriptionForeground); font-variant-numeric:tabular-nums; word-break:break-all; }
  .cm-tip .tc { font-size:9.5px; color: var(--vscode-descriptionForeground); margin:3px 0 4px; }
  .cm-tip .tw { font-style:italic; border-top:1px solid var(--cm-border); padding-top:4px; }
  .cm-tip .trk { color: var(--cm-risk); margin-top:3px; }
  .cm-tip .ta { color: var(--cm-accent); font-family: var(--cm-mono); font-size:8.5px; margin-top:5px; }
</style>`;
  const body =
    `<div class="ov-toolbar">` +
    // TWO rows, rendered bottom-up via .ov-toolbar{flex-direction:column-reverse} (user swap 2026-07-17):
    // this DOM-first row (the diff · file · folder · prompt AXES) shows on the BOTTOM; the DOM-second row
    // (session · bulk · export | search · active · spotlight · refresh controls) shows on TOP.
    // ICONS ONLY on this row. Each axis already names itself in its own n/m counter — "File 3/126",
    // "Folder 1/23" — so "Accept File" beside it restated the axis the reader is already looking at, and
    // between them the labels took most of the bar. Tooltips carry the verb. The row above KEEPS its
    // labels: those act on the whole session and are destructive, with no axis counter to say so.
    `<div class="ov-tbrow" id="ov-axesrow">` + // id: the guided tour rings this row for its "four axes" step
    // Diff axis + the per-edit pair it steps: n/m counters post to the existing nav commands.
    `<span class="ov-navgrp">` +
    `<button class="ov-nb" id="ov-diffprev" title="Previous edit in this file"><i class="codicon codicon-chevron-up"></i></button>` +
    `<span class="ov-nc" id="ov-diffcount">Diff –/–</span>` +
    `<button class="ov-nb" id="ov-diffnext" title="Next edit in this file"><i class="codicon codicon-chevron-down"></i></button>` +
    `<button class="ov-nb" id="ov-navkeep" title="Keep this edit"><i class="codicon codicon-check"></i></button>` +
    `<button class="ov-nb" id="ov-navundo" title="Undo this edit"><i class="codicon codicon-close"></i></button>` +
    `<button class="ov-nb" id="ov-chatedit" title="Chat about this edit — copies its context, opens your agent"><i class="codicon codicon-comment-discussion"></i></button>` +
    `<button class="ov-nb" id="ov-viewdiff" title="View this edit's diff — before / after"><i class="codicon codicon-diff"></i></button>` +
    `</span><span class="ov-nbsep"></span>` +
    // File axis + the per-file pair it steps.
    `<span class="ov-navgrp">` +
    `<button class="ov-nb" id="ov-fileprev" title="Previous changed file"><i class="codicon codicon-chevron-left"></i></button>` +
    `<span class="ov-nc" id="ov-filecount">File –/–</span>` +
    `<button class="ov-nb" id="ov-filenext" title="Next changed file"><i class="codicon codicon-chevron-right"></i></button>` +
    `<button class="ov-nb" id="ov-acceptfile" title="Accept every pending edit in this file"><i class="codicon codicon-check-all"></i></button>` +
    `<button class="ov-nb" id="ov-rejectfile" title="Reject (revert) every pending edit in this file"><i class="codicon codicon-close-all"></i></button>` +
    `</span><span class="ov-nbsep"></span>` +
    // Folder axis — step BETWEEN changed folders (the change-map's strip tiles); act on the whole bucket.
    `<span class="ov-navgrp">` +
    `<button class="ov-nb" id="ov-folderprev" title="Previous changed folder"><i class="codicon codicon-chevron-left"></i></button>` +
    `<span class="ov-nc" id="ov-foldercount">Folder –/–</span>` +
    `<button class="ov-nb" id="ov-foldernext" title="Next changed folder"><i class="codicon codicon-chevron-right"></i></button>` +
    `<button class="ov-nb" id="ov-acceptfolder" title="Accept every pending edit in this folder"><i class="codicon codicon-check-all"></i></button>` +
    `<button class="ov-nb" id="ov-rejectfolder" title="Reject (revert) every pending edit in this folder"><i class="codicon codicon-close-all"></i></button>` +
    `</span><span class="ov-nbsep"></span>` +
    // Prompt axis — the LAST axis, and the only one that slices the work the way the PERSON asked for it
    // rather than the way the agent organized it. Steps between your own asks; acts on everything one ask
    // produced ("accept everything from this ask"). Same glyphs as Accept File / Accept Folder: the same
    // three operations at a different scope.
    `<span class="ov-navgrp">` +
    `<button class="ov-nb" id="ov-promptprev" title="Previous prompt — the ask before this one that still has edits to review"><i class="codicon codicon-chevron-left"></i></button>` +
    `<span class="ov-nc" id="ov-promptcount" title="the prompt (your own ask) that produced the current edit">Prompt –/–</span>` +
    `<button class="ov-nb" id="ov-promptnext" title="Next prompt — the next ask that still has edits to review"><i class="codicon codicon-chevron-right"></i></button>` +
    `<button class="ov-nb" id="ov-reviewprompt" title="Review this prompt — step through the edits this ask produced, in order"><i class="codicon codicon-list-ordered"></i></button>` +
    `<button class="ov-nb" id="ov-acceptprompt" title="Accept every pending edit this prompt produced"><i class="codicon codicon-checklist"></i></button>` +
    `<button class="ov-nb" id="ov-rejectprompt" title="Reject (revert) every pending edit this prompt produced"><i class="codicon codicon-close-all"></i></button>` +
    `<button class="ov-nb" id="ov-rewindprompt" title="Rewind to before this prompt — revert every pending edit from this ask ONWARD, not just its own (Redo can restore them)"><i class="codicon codicon-debug-step-back"></i></button>` +
    `</span>` +
    `</div>` + // end ROW 1 (the diff · file · folder · prompt axes)
    // ROW 2 — split: the SESSION axis (selector + session-wide bulk) pinned LEFT; view controls (Search ·
    // Active only · Spotlight · Refresh) pinned RIGHT. Two flex children + space-between = edges.
    `<div class="ov-tbrow split">` +
    // Session-wide bulk (retargets to the picked prompt — see relabelBulk), led by the NAME of the
    // session these panels are showing. The name is a label, not a control: switching is a Sessions-tab
    // click now. It stays the left group's first child so the row keeps its two-children layout.
    `<span class="ov-navgrp">` +
    `<span class="ov-sesslabel" id="ov-sess-label" title="The session these panels are showing. Switch in the Sessions tab.">🔬 session —</span>` +
    `<button class="ov-tb" id="ov-keepall" title="Accept all edits in this session"><i class="codicon codicon-checklist"></i> Accept All</button>` +
    `<button class="ov-tb" id="ov-undoall" title="Reject (revert) every pending edit in this session"><i class="codicon codicon-close-all"></i> Reject All</button>` +
    `<button class="ov-tb" id="ov-clearres" title="Clear resolved (kept / reverted) edits"><i class="codicon codicon-clear-all"></i> Clear Resolved</button>` +
    `<button class="ov-tb" id="ov-export" title="Export — a shareable review summary (markdown), or the full session trace of everything recorded (JSON)"><i class="codicon codicon-export"></i> Export</button>` +
    `<button class="ov-tb" id="ov-store" title="Open this session’s store folder on disk — where every edit’s before/after blobs and the review log live"><i class="codicon codicon-folder-opened"></i> Store <span id="ov-store-size"></span></button>` +
    `</span>` +
    // Right cluster: search · active only | spotlight · refresh (view/utility controls). It GROWS to
    // fill the row after the left group, so the search field scales with the panel width.
    `<span class="ov-navgrp ov-navgrp-grow">` +
    // Inline search — types straight into the toolbar, no pop-up. The query reads as a regex the
    // moment it carries regex syntax (^ $ * + ? ( ) [ ] { } | \), a substring otherwise. It flexes to
    // take the free space in this cluster, so it is as wide as the window allows.
    `<span class="ov-searchwrap"><i class="codicon codicon-search"></i><input id="ov-search-input" class="ov-search-inp" type="text" placeholder="Search" title="Filter edits by path — a regex when it carries regex syntax, a substring otherwise"></span>` +
    // Reset scope, RIGHT BESIDE Search: one exit from every narrowing at once —
    // the Search filter, the folder-tile filter (webview-local MOD), and the prompt scope. Labelled
    // so it reads as "reset", not a window-close ×.
    `<button class="ov-nb" id="ov-resetscope" title="Reset scope — show every tracked edit (clears search, the folder filter, and the prompt scope)"><i class="codicon codicon-clear-all"></i> Reset scope</button>` +
    // Filter — an inline dropdown (anchored to this button, NOT a pop-up), its label naming what is
    // applied; Sort — a button whose label names the mode in force. Both live in the panel toolbar.
    `<span class="ov-drop-anchor"><button class="ov-nb" id="ov-filter" aria-expanded="false" title="Filter edits by file type and extension"><i class="codicon codicon-filter"></i> <span id="ov-filter-lbl">Filter</span></button><div class="ov-filterdrop" id="ov-filterdrop" hidden></div></span>` +
    `<span class="ov-drop-anchor"><button class="ov-nb" id="ov-sort" aria-expanded="false" title="Sort order — newest / oldest / name A→Z / name Z→A"><i class="codicon codicon-sort-precedence"></i> <span id="ov-sort-lbl">Sort: Newest</span></button><div class="ov-filterdrop" id="ov-sortdrop" hidden></div></span>` +
    // Active-only toggle — mirrors the left-nav checkbox: scopes the fleet/workflow nav AND the change-map
    // detail to work still awaiting review (pending edits / active agents / running workflows).
    `<button class="ov-tb ov-toggle" id="ov-activeonly" aria-pressed="false" title="Show only what's still active — agents/workflows running and edits awaiting review"><i class="codicon codicon-check"></i> Active only</button>` +
    // (Group tabs used to sit here. It rearranges the left-nav TAB STRIP, so it now lives beside it —
    // see #ov-groupnav below.)
    `<span class="ov-nbsep"></span>` +
    `<button class="ov-nb" id="ov-spotlight" title="Toggle spotlight — dim unedited lines to highlight the agent’s changes"><i class="codicon codicon-lightbulb"></i> Spotlight</button>` +
    `<button class="ov-tb" id="ov-refresh" title="Refresh the Overview"><i class="codicon codicon-refresh"></i> Refresh</button>` +
    // The version chip and the gear — the two "about this extension" controls — close the row, and
    // they share ONE wrapper because that wrapper is what `.ov-vermenu` positions against. Put the
    // gear beside it instead and the dropdown either stops being flush with the panel edge (anchored
    // to the chip) or, once the narrow-width media query gives .ov-navgrp the whole row and packs its
    // buttons left, opens ~190px away from the chip that spawned it (anchored to the group). Measured
    // both ways; keeping the cluster in one positioned span is the only option that is flush at full
    // width AND still under its trigger when the row is narrow.
    `<span class="ov-verwrap">` +
    // The installed Observatory version, opening the update / release-channel menu (Stable ⇄ Pre-release).
    `<button class="ov-tb ov-verchip" id="ov-version" title="OAK version — update, or switch between the stable and pre-release channels">v— <i class="codicon codicon-chevron-down"></i></button>` +
    // The gear LAST, i.e. hard against the row's right edge — the same place JetBrains puts it. The
    // terminal keeps its settings in its own file because it has no host to keep them in; here the
    // host owns them, so this opens VS Code's own settings scoped to this extension rather than
    // inventing a second place to store the same preferences.
    `<button class="ov-tb" id="ov-options" title="OAK settings"><i class="codicon codicon-settings-gear"></i></button>` +
    `<div class="ov-vermenu" id="ov-vermenu" hidden></div></span>` +
    `</span>` +
    `</div>` + // end ROW 2 (controls)
    `</div>` +
    `<div class="ov">` +
    `<div class="ov-nav">` +
    // The tab strip, and BESIDE it the control that regroups it: the five tabs collapse to two, each
    // showing its members as side-by-side columns the reader can resize and fold.
    `<div class="ov-navtabrow">` +
    `<div class="ov-navtabs" id="ov-navtabs"></div>` +
    `<button class="ov-tb ov-toggle" id="ov-groupnav" aria-pressed="false" title="Show every tab side by side in one group (Sessions · Workers · Workflows · Tasks · Processes)"><i class="codicon codicon-split-horizontal"></i> Group tabs</button>` +
    `</div>` +
    `<div class="ov-ctl">` +
    `<label class="mt-toggle" title="Show only active agents / running workflows"><input type="checkbox" id="mt-active"> Active only</label>` +
    `<button class="mt-clear" id="mt-clear" title="Hide completed agents &amp; finished workflows (observe-only — never deletes anything)">Clear completed</button>` +
    `</div>` +
    `<div class="ov-empty" id="ov-empty" style="display:none"></div>` +
    // No prompt-scope banner here: the Prompts WINDOW to the left of this panel already shows the
    // picked ask (highlighted, with its full text and a clear button), so repeating it in the Overview
    // was pure duplication. The scope is still visible where it matters — the panes note what they hid,
    // the bulk buttons read "…in #N", and the bottom summary names the ask — and cleared from that window.
    `<div class="ov-pane" id="ov-pane-fleet" style="display:none">` +
    `<div class="ov-desc">Every Claude agent working in this repo’s worktrees — live phase, tokens, and risk. Select one to map just its edits.</div>` +
    `<div class="ov-list" id="ov-fleet"></div>` +
    `</div>` +
    `<div class="ov-pane" id="ov-pane-workflows" style="display:none"><div class="ov-desc">Multi-agent runs (an orchestrator and its subagents) — each run’s phases and the edits attributed to it.</div><div class="ov-list" id="ov-workflows"></div></div>` +
    // The session's TASK LIST (TaskCreate/TaskUpdate — the newer numbered system next to TodoWrite).
    `<div class="ov-pane" id="ov-pane-tasks" style="display:none"><div class="ov-desc">This session’s numbered task list (the agent’s TaskCreate/TaskUpdate plan) — with live statuses; each row carries its strict task rollup.</div><div class="ov-list" id="ov-tasks"></div></div>` +
    // Background shells the agent launched with run_in_background and left running. The tab is always here
    // (JetBrains parity); the pane itself says which state it is in when the CLI could not answer.
    `<div class="ov-pane" id="ov-pane-processes" style="display:none"><div class="ov-desc">Background shells this session launched (<code>run_in_background</code>) — state, runtime and output volume. Select one to follow its output.</div><div class="ov-list" id="ov-processes"></div></div>` +
    `<div class="ov-pane" id="ov-pane-sessions"><div class="ov-desc">Sessions on this machine, grouped by workspace. This workspace is first; select a session to review its conversation and edits.</div><div class="ov-list" id="ov-sessions"></div></div>` +
    // Grouped mode's two panes. Their COLUMNS are composed by the script (one per member, each carrying
    // that member's own list node), so every list still has exactly one renderer whichever mode is on.
    `<div class="ov-pane ov-group" id="ov-group-all" style="display:none"></div>` +
    `</div>` +
    `<div class="ov-gutter" id="ov-gutter" title="Drag to resize the panes — double-click to reset"></div>` +
    `<div class="ov-detail">` +
    // 0.8.7: no footprint badge row here. It restated Risk, Egress and Subagents as a second set of
    // numbers; the two facts it alone reported — reads and writes that left the workspace — folded into
    // those audits (Actions panel), and the fleet row keeps the one-glance ↗ suffix.

    // Folders — the tiles below are folders (change-map modules); click one to jump the Folder axis.
    `<div class="cm-caption" id="cm-cap-folders" style="display:none" title="Folders — the directories the agent changed, ranked by lines changed; color is review status (amber pending · green kept · red reverted). Click a tile to filter the files below and open that folder in the nav bar; the tail chip opens the folders it folds.">Folders</div>` +
    `<div class="cm-strip" id="cm-strip"></div>` +
    `<div class="cm-empty" id="cm-detail-empty" style="display:none"></div>` +
    // Files — the churn-ranked ledger of changed files (the same data as the Folders strip, per file).
    `<div class="cm-caption" id="cm-cap-files" style="display:none" title="Files — every changed file, ranked by churn. Dot = review status, +N/−N = lines, ⧗/✓ = pending/reviewed; click a row to open the edit, ⧉ opens the file's changes stacked.">Files</div>` +
    `<div class="cm-ledger" id="cm-ledger"></div>` +
    `<div class="cm-readout" id="cm-readout"></div>` +
    // Bottom summary bar — pending/accepted edit + file + folder totals for whatever the change map shows
    // right now (the selected slice, narrowed by an active folder-tile filter / search / active-only).
    `<div class="cm-summary" id="cm-summary" title="Totals for the change map as currently shown (selected agent/workflow, folder filter, search)"></div>` +
    // (The selected row's feed used to render here, under the summary. It lives in the Timeline's
    // Feed tab now — 0.10.0 — so the change map keeps the whole detail height.)
    `</div>` +
    `</div>` +
    `<div class="cm-tip" id="cm-tip"></div>` +
    `<script nonce="${nonce}">${OVERVIEW_SCRIPT}</script>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">${style}</head><body>${body}</body></html>`;
}

/** File History: the ACTIVE editor's agent edits, oldest→newest (id · time · status · reasoning).
 *  A flat chronological list — a different data model from the folder/class Edits tree — that follows
 *  the active editor. Reuses EditNode so every existing edit command works on its rows unchanged. */
class FileHistoryProvider implements vscode.TreeDataProvider<EditNode> {
  private readonly _changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._changed.event;
  view?: vscode.TreeView<EditNode>;

  refresh(): void {
    this._changed.fire();
    if (this.view) {
      const f = activeEditorFile();
      this.view.description = f ? path.basename(f) : undefined; // name the file being followed
    }
  }

  getChildren(node?: EditNode): EditNode[] {
    if (node) return []; // flat list
    const session = currentSession();
    const file = activeEditorFile();
    if (!session || !file) return [];
    // The store read-primitive: a file's edits = readLog filtered by absolute-path equality.
    return cachedLog(session)
      .filter((r) => r.file === file)
      .sort((a, b) => a.ts - b.ts || a.id - b.id) // chronological
      .map((rec): EditNode => ({ kind: 'edit', rec }));
  }

  getTreeItem(node: EditNode): vscode.TreeItem {
    const rec = node.rec;
    const session = currentSession();
    const cwd = workspaceRoot();
    const d = new Date(rec.ts);
    const hhmm = [d.getHours(), d.getMinutes()].map((x) => String(x).padStart(2, '0')).join(':');
    const reasoning = cwd && session ? cachedTranscript(cwd, session).reasoning.get(rec.id) : undefined;
    const summary = reasoning ? firstLine(reasoning) : session ? core.summarize(session, rec) : '';
    let label = `#${rec.id}  ${hhmm}`;
    if (rec.status === 'undone') label = strike(label);
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = `${rec.status}${summary ? ` · ${summary}` : ''}`;
    item.tooltip = new vscode.MarkdownString(
      `**Edit #${rec.id}** · ${rec.tool} · ${rec.status} · ${d.toLocaleTimeString()}` +
        (reasoning ? `\n\n💭 ${reasoning}` : '')
    );
    item.iconPath = statusIcon(rec.status);
    item.contextValue = rec.status === 'undone' ? 'editUndone' : 'edit'; // reuse edit/editUndone menus
    item.resourceUri = editItemUri(rec); // greys kept/undone via StatusDecorationProvider
    item.command = { command: 'claudeObservatory.openFileAtEdit', title: 'Open File at Edit', arguments: [node] };
    return item;
  }
}

/** Spawn one CLI subcommand, parse its stdout as JSON, and hand the result (or null on any failure) to
 *  `cb` exactly once. Windows: the .cmd shim needs a shell. Shared by every panel that shells out. */
/** Hard ceiling on any CLI child. The Overview's refresh gate (`running`) is cleared in its done()
 *  callback — with no timeout, one child that hangs without exiting (a wedged filesystem, a debugger
 *  stop, an NFS stall) left `running` set forever and every later refresh silently dropped, until the
 *  window was reloaded. Generous on purpose: the slowest legitimate spawn measured is a cold-cold
 *  rebuild at ~16s; 120s only ever fires on a child that was never coming back. */
const CLI_SPAWN_TIMEOUT_MS = 120_000;
/** The setup check's deadline, the same in both editors (JetBrains' HEAVY_TIMEOUT_MS): doctor waits up
 *  to 30 s on each saved herdr machine in turn. */
const DOCTOR_TIMEOUT_MS = 180_000;
function spawnCliJson(args: string[], cwd: string, cb: (data: unknown | null) => void): void {
  let child: cp.ChildProcess;
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const once = (data: unknown | null) => {
    if (fired) return;
    fired = true;
    if (timer) clearTimeout(timer);
    cb(data);
  };
  try {
    // `--root <cwd>` carries a workspace path. The old shape passed an args ARRAY with shell:true,
    // which concatenates them UNQUOTED — so every panel here returned nothing on Windows for anyone
    // whose workspace sat under a spaced path (C:\Users\First Last\…). core/spawn quotes it.
    child = core.spawnTool(resolveObservatoryBin(), args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    once(null);
    return;
  }
  timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    once(null); // callers treat null as "this refresh failed" and clear their gates
  }, CLI_SPAWN_TIMEOUT_MS);
  let out = '';
  child.stdout?.on('data', (d) => (out += d));
  child.on('error', () => once(null));
  child.on('close', () => {
    try {
      once(JSON.parse(out));
    } catch {
      once(null);
    }
  });
}

/**
 * The PROMPTS window (0.8.7) — the bottom dock's left column, beside the Overview rather than inside it.
 *
 * Every other view organizes the session the way the AGENT saw it: worktrees, runs, to-dos, files. This
 * one is the session as the conversation actually went — one row per thing you asked for, in order,
 * each carrying what that ask produced. It is a window of its own, not a tab, because selecting a
 * prompt SCOPES the Overview next to it: its fleet, workflow runs, tasks, background shells and the
 * whole change map (folders · files) narrow to the work that ask caused. A tab could not do
 * that — you would lose sight of the list the moment you looked at what it filtered.
 *
 * Attribution is core's (`ChangeMapPrompt`): by START time, so a shell launched by #4 stays #4's even
 * when it exits during #7.
 */
/**
 * The guided tour's panel (0.8.9). A sidebar webview VIEW rather than a notification, a QuickPick or an
 * editor panel, for reasons that are all about where focus goes: every step deliberately moves focus to
 * the surface it is describing, which closes a QuickPick outright; a stack of twenty notifications is
 * the wrong shape for paragraphs and one stray click dismisses them; and an editor panel fights the
 * step that wants the editor itself. A view in the sidebar container survives all of that — focusing a
 * SIBLING view expands that view without hiding this one.
 *
 * The steps come from core (`demoTour`), so this renders the same script the CLI prints and the
 * JetBrains plugin shows.
 */
function tourShell(): string {
  const nonce = getNonce();
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  const style = `<style>
  body { margin:0; padding:10px 12px 12px; font-family: var(--vscode-font-family); font-size:12px; color: var(--vscode-foreground); }
  .count { font-family: var(--vscode-editor-font-family, monospace); font-size:9.5px; letter-spacing:.06em; text-transform:uppercase; color: var(--vscode-descriptionForeground); }
  h2 { font-size:13px; margin:3px 0 7px; font-weight:600; line-height:1.35; }
  /* Tour prose is the point of the panel — it wraps, it never clips. */
  p { margin:0 0 8px; line-height:1.55; overflow-wrap:anywhere; }
  .tip { border-left:2px solid var(--vscode-charts-blue, #4c8bf5); padding:3px 0 3px 8px; margin:0 0 8px; color: var(--vscode-descriptionForeground); line-height:1.5; }
  .try { color: var(--vscode-descriptionForeground); line-height:1.5; margin:0 0 10px; }
  .try::before { content:"try "; text-transform:uppercase; font-size:9px; letter-spacing:.07em; opacity:.8; }
  /* The two action blocks share one geometry and differ in exactly two things — the heading, and
     whether there is a waiting state. That similarity is what stops a mixed script reading as an
     inconsistent one. */
  .act { border:1px solid var(--vscode-widget-border, rgba(127,127,127,0.3)); border-radius:4px; padding:6px 9px; margin:0 0 10px; line-height:1.5; }
  .act .lbl { display:block; text-transform:uppercase; font-size:9px; letter-spacing:.08em; color: var(--vscode-descriptionForeground); margin-bottom:3px; }
  .act.wait { border-left:2px solid var(--vscode-charts-blue, #4c8bf5); }
  .act.auto { border-left:2px solid var(--vscode-charts-green, #3fb950); }
  .act .st { display:block; margin-top:4px; color: var(--vscode-descriptionForeground); }
  .act .st.pending::before { content:"\u25cc "; animation: pulse 1.4s ease-in-out infinite; display:inline-block; }
  .act .st.ok { color: var(--vscode-charts-green, #3fb950); }
  @keyframes pulse { 0%,100% { opacity:.35 } 50% { opacity:1 } }
  .row { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
  button { font-family:inherit; font-size:11px; padding:3px 10px; border:1px solid var(--vscode-widget-border, rgba(127,127,127,0.3)); border-radius:3px; background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-foreground); cursor:pointer; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  button:disabled { opacity:.4; cursor:default; }
  .spacer { flex:1; }
  .dots { display:flex; flex-wrap:wrap; gap:3px; margin-top:10px; }
  .dot { width:5px; height:5px; border-radius:50%; background: var(--vscode-descriptionForeground); opacity:.3; cursor:pointer; }
  .dot.on { opacity:1; background: var(--vscode-charts-blue, #4c8bf5); }
  .dot.seen { opacity:.6; }
  </style>`;
  // Plain string interpolation only: the step text is core's, and textContent keeps it inert.
  const tourScript = `
  const vs = acquireVsCodeApi();
  var N = 0, LAST = null, WAITING = false, PLAYING = true, AUTOSECS = 0;
  /** A wait step relabels Next to Skip. It is never DISABLED — nothing about an action can trap you. */
  function setNext(i, n){
    var nx = document.getElementById('next');
    nx.textContent = WAITING ? 'Skip \u25b8' : (i + 1 >= n ? 'Finish' : 'Next \u25b8');
    nx.classList.toggle('primary', !WAITING);
  }
  function renderAction(a, state){
    var box = document.getElementById('action');
    if(!a){ box.style.display='none'; WAITING=false; return; }
    box.style.display='block';
    // An unrecognized mode is treated as a WAIT with no watcher — inert text. Never as an auto step:
    // an editor must not execute something because it failed to recognize a value.
    // (No backticks in here: this script is inside a template literal.)
    var auto = a.mode === 'auto';
    // An auto step that did NOT run says so, and drops the past-tense line with it.
    var ranNothing = auto && state === 'vacated';
    box.className = 'act ' + (auto ? 'auto' : 'wait');
    document.getElementById('actionlabel').textContent = auto ? 'The tour did this' : 'Your turn';
    document.getElementById('actionhint').textContent = (!auto || ranNothing) ? a.hint : (a.done || a.hint);
    var st = document.getElementById('actionstate');
    if(ranNothing){ st.className='st pending'; st.textContent='\u2014 nothing left here to do it to'; WAITING=false; return; }
    if(auto || state==='satisfied'){ st.className='st ok'; st.textContent='\u2713 done'; WAITING=false; return; }
    if(state==='vacated'){ st.className='st ok'; st.textContent='\u2713 nothing left to review \u2014 the demo cleared its own records'; WAITING=false; return; }
    // Under autoplay, say plainly that it will apply itself — a reader who does nothing is not being
    // ignored, and one who wants to act can see exactly how long they have.
    st.className='st pending';
    st.textContent = (PLAYING && AUTOSECS > 0) ? ('applies automatically in ' + AUTOSECS + 's\u2026') : 'waiting\u2026';
    WAITING=true;
  }
  function send(t){ vs.postMessage({type:t}); }
  window.addEventListener('message', function(e){
    var m = e.data; if(!m) return;
    // The host reports a wait step's progress without re-sending the whole step.
    if(m.type==='action'){ if(!LAST) return; AUTOSECS=0; renderAction(LAST.step.action, m.state); setNext(LAST.i, LAST.n); return; }
    if(m.type==='auto'){ PLAYING=m.playing; AUTOSECS=m.secs;
      document.getElementById('play').textContent = m.playing ? '❚❚' : '▸';
      if(LAST) renderAction(LAST.step.action, LAST.actionState); return; }
    if(m.type!=='step') return;
    LAST = m;
    N = m.n;
    document.getElementById('count').textContent = (m.i+1) + ' / ' + m.n;
    document.getElementById('title').textContent = m.step.title;
    document.getElementById('body').textContent = m.step.body;
    var tip = document.getElementById('tip');
    tip.textContent = m.step.tip || ''; tip.style.display = m.step.tip ? 'block' : 'none';
    var t = document.getElementById('try');
    t.textContent = m.step.tryIt || ''; t.style.display = m.step.tryIt ? 'block' : 'none';
    renderAction(m.step.action, m.actionState);
    document.getElementById('back').disabled = m.i === 0;
    document.getElementById('dock').textContent = m.docked ? 'Float' : 'Dock';
    setNext(m.i, m.n);
    var d = ''; for (var k=0;k<m.n;k++) d += '<span class="dot' + (k===m.i?' on':(k<m.i?' seen':'')) + '" data-i="'+k+'"></span>';
    var host = document.getElementById('dots'); host.innerHTML = d;
    var ds = host.querySelectorAll('.dot');
    for (var j=0;j<ds.length;j++) ds[j].addEventListener('click', function(){ vs.postMessage({type:'goto', i:+this.getAttribute('data-i')}); });
  });
  document.getElementById('play').addEventListener('click', function(){ send('play'); });
  document.getElementById('dock').addEventListener('click', function(){ send('dock'); });
  document.getElementById('back').addEventListener('click', function(){ send('back'); });
  document.getElementById('next').addEventListener('click', function(){ send('next'); });
  document.getElementById('exit').addEventListener('click', function(){ send('exit'); });
  vs.postMessage({type:'ready', reduced: !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)});`;
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">${style}</head><body>` +
    `<div class="count" id="count">— / —</div>` +
    `<h2 id="title">Guided tour</h2>` +
    `<p id="body"></p>` +
    `<div class="tip" id="tip" style="display:none"></div>` +
    `<div class="act" id="action" style="display:none"><span class="lbl" id="actionlabel"></span><span id="actionhint"></span><span class="st" id="actionstate"></span></div>` +
    `<div class="try" id="try" style="display:none"></div>` +
    `<div class="row"><button id="back">◂ Back</button><button class="primary" id="next">Next ▸</button><span class="spacer"></span>` +
    `<button id="play" title="Pause or resume the tour. Any other control pauses it too.">❚❚</button>` +
    `<button id="dock" title="Move the tour between its own window and a tab beside your code">Dock</button>` +
    `<button id="exit">Exit demo</button></div>` +
    `<div class="dots" id="dots"></div>` +
    `<script nonce="${nonce}">${tourScript}</script></body></html>`
  );
}

/**
 * The guided tour's window. A webview PANEL: docked beside your code by default, and detachable into a
 * window of its own for a second screen. Either way it survives the focus changes the steps deliberately
 * cause, which is what a tour needs and what the alternatives could not give.
 *
 * A sidebar view was the obvious choice and the wrong one: it consumes a slot in the very container whose
 * other views the tour keeps asking you to look at. `Guided tour: move to its own window` detaches it;
 * which mode you last used is remembered, because that preference belongs to a person, not to a project.
 *
 * The steps come from core (`demoTour`), so this renders the same script the CLI prints and the
 * JetBrains plugin shows.
 */
class DemoTourPanel {
  private panel?: vscode.WebviewPanel;
  private last?: { i: number; n: number; step: core.DemoStep; actionState?: core.DemoActionState };
  /** true = docked as an editor tab (the default), false = floating in a window of its own. */
  private docked: boolean;
  /** Set while `setDocked` is tearing the panel down to rebuild it in the other mode, so the dispose it
   *  causes is not mistaken for the reader closing the tour. Without it, one dock↔float toggle mid-tour
   *  ends the tour: `onDidDispose` fires `tourClosed`, which calls `endTour`, and Next/Back go dead. */
  private moving = false;

  constructor(private readonly memento: vscode.Memento) {
    this.docked = memento.get<boolean>('tourDocked', true);
  }

  get isOpen(): boolean {
    return !!this.panel;
  }

  /** Open (or re-reveal) the tour. `float` overrides the remembered mode for this run. */
  async open(float?: boolean): Promise<void> {
    if (float !== undefined) {
      this.docked = !float;
      void this.memento.update('tourDocked', this.docked);
    }
    if (this.panel) {
      this.panel.reveal(undefined, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel('claudeObservatory.tour', 'OAK — guided tour', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true, // the tour keeps its step while every other view takes focus
    });
    panel.webview.html = tourShell();
    panel.webview.onDidReceiveMessage((m: { type?: string; i?: number; reduced?: boolean }) => {
      if (!m) return;
      if (m.type === 'ready') {
        if (m.reduced) void vscode.commands.executeCommand('claudeObservatory.tourReducedMotion');
        this.repost();
      }
      else if (m.type === 'next') void vscode.commands.executeCommand('claudeObservatory.tourNext');
      else if (m.type === 'back') void vscode.commands.executeCommand('claudeObservatory.tourBack');
      else if (m.type === 'goto' && typeof m.i === 'number') void vscode.commands.executeCommand('claudeObservatory.tourGoto', m.i);
      else if (m.type === 'exit') void vscode.commands.executeCommand('claudeObservatory.exitDemo');
      else if (m.type === 'dock') void vscode.commands.executeCommand(this.docked ? 'claudeObservatory.tourFloat' : 'claudeObservatory.tourDock');
      else if (m.type === 'play') void vscode.commands.executeCommand('claudeObservatory.tourPlayPause');
    });
    // Closing the tour window ends the tour: leaving `tourStep` advancing against a window nobody can
    // see would make Next/Back silently move a thing that is not there.
    panel.onDidDispose(() => {
      this.panel = undefined;
      if (this.moving) return; // a rebuild into the other mode, not the reader closing the tour
      void vscode.commands.executeCommand('claudeObservatory.tourClosed');
    });
    this.panel = panel;
    if (!this.docked) await this.detach();
    this.repost();
  }

  /**
   * Move the panel into a window of its own. VS Code exposes no API for creating a detached webview, so
   * this drives the editor command that moves the ACTIVE editor out — which is why the panel is created
   * focused first. If the command is unavailable (an older build, a remote host that refuses auxiliary
   * windows) the panel simply stays in the editor area: docked is a working tour, not a failure.
   */
  private async detach(): Promise<void> {
    try {
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
    } catch {
      this.docked = true;
      void this.memento.update('tourDocked', true);
    }
  }

  async setDocked(docked: boolean): Promise<void> {
    if (this.docked === docked && this.panel) return;
    this.docked = docked;
    void this.memento.update('tourDocked', docked);
    // Re-open in the other mode: a panel cannot be moved back from an auxiliary window by API.
    const step = this.last;
    this.moving = true;
    try {
      this.panel?.dispose();
      this.panel = undefined;
      await this.open();
    } finally {
      this.moving = false;
    }
    // …carrying the action state across. Dropping it re-renders a step the reader already satisfied
    // as "waiting", and the countdown text with it.
    if (step) this.show(step.i, step.n, step.step, step.actionState);
  }

  show(i: number, n: number, step: core.DemoStep, actionState?: core.DemoActionState): void {
    this.last = { i, n, step, actionState };
    this.repost();
  }

  /** Report a wait step's progress without re-sending the whole step. */
  postActionState(state: core.DemoActionState): void {
    if (this.last) this.last.actionState = state;
    void this.panel?.webview.postMessage({ type: 'action', state });
  }

  /** Autoplay state and the seconds left on this step, for the transport and the countdown. */
  postAuto(playing: boolean, secs: number): void {
    void this.panel?.webview.postMessage({ type: 'auto', playing, secs });
  }

  /** Bring the tour forward WITHOUT taking focus — every step has just focused something else. */
  reveal(): void {
    this.panel?.reveal(undefined, true);
  }

  close(): void {
    const p = this.panel;
    this.panel = undefined; // so onDidDispose does not re-enter the tour-ended command
    p?.dispose();
  }

  private repost(): void {
    if (this.last) void this.panel?.webview.postMessage({ type: 'step', ...this.last, docked: this.docked });
  }
}

// --- Timeline: the tree providers' rows, flattened for a webview ------------------------------------

/** One inline row action, mirroring what the tree carried in its `view/item/context` menu. */
interface TlAct {
  v: string; // the VERB — an index into TL_ROW_ACTS, never a command name from the webview
  g: string;
  t: string;
  tone: string;
}
/** One tree row, serialized. Everything on it comes from the provider's own `getTreeItem`. */
interface TlRow {
  key: string;
  label: string;
  desc: string;
  tip: string;
  glyph: string;
  tone: string;
  /** null = a leaf; true/false = the node's default expanded state. */
  open: boolean | null;
  act: boolean;
  acts: TlAct[];
}
/** What the Timeline needs of a tree provider — the two methods it renders from. */
type TlTreeProvider = { getChildren(node?: unknown): unknown[]; getTreeItem(node: unknown): vscode.TreeItem };

/**
 * How many EDIT rows one Observations level serializes before it says how many it left out.
 *
 * The tree this window replaced was virtualized BY VS CODE: whatever the feed's length, only the ~40
 * rows on screen were ever built, and none of them crossed a process boundary. A webview has neither
 * property — every row is built (a delta, a transcript lookup, a file-memory probe, a tooltip), posted,
 * and turned into DOM. Measured on a 3,000-edit session that is ~280ms of host thread and a 1.7MB
 * payload, paid on every Keep and on every watcher tick while the agent works; at this cap the same
 * session costs ~28ms and ~170KB, and a feed under the cap is untouched.
 *
 * 300 is ~6,000px of rows — far more than a sidebar shows at once, so the bound is invisible until a
 * session is genuinely enormous, and then it is STATED rather than swallowed (see the row postTree
 * inserts). Only edit rows are counted: the Context section and "Next steps" come after them.
 */
const EDIT_FEED_CAP = 300;

/**
 * ThemeIcon id → a text mark.
 *
 * The trees drew from VS Code's FULL built-in codicon set. A webview only has the subsetted font in
 * `src/codicon.ts`, where an unlisted name renders as a silent blank glyph — so these rows use text
 * marks, which is also what every other list in this window has always used. '?' is the deliberate
 * sentinel for an icon nobody mapped: a test asserts no shipped row wears it, because the alternative
 * is a missing icon that reports itself as nothing at all.
 */
const TL_GLYPH: Record<string, string> = {
  // review status (statusIcon / aggregateIcon)
  'circle-filled': '●', check: '✓', 'circle-slash': '⊘', warning: '⚠', error: '✗',
  // Observations
  compass: '◎', lightbulb: '✧', 'arrow-small-right': '›', book: '▤', library: '▤', checklist: '☑',
  sparkle: '✦', 'fold-down': '⤓', file: '▪',
  // Actions (ACTION_ICON + the audit sections)
  edit: '✎', terminal: '❯', search: '⌕', globe: '◍', organization: '⑂', plug: '⌁', gear: '⚙',
  'circle-small': '·', 'link-external': '↗', 'radio-tower': '⇢', files: '❐', 'file-symlink-file': '◧',
};
/** ThemeColor id → the tone class the shell styles. Anything unmapped renders in the row's own colour. */
const TL_TONE: Record<string, string> = {
  'charts.green': 'done', 'charts.yellow': 'pending', 'charts.orange': 'attn', 'charts.red': 'warn',
  'charts.blue': 'accent', 'charts.purple': 'agent', descriptionForeground: 'muted',
};
/**
 * The inline actions each tree `contextValue` offered, as webview buttons.
 *
 * A webview inherits no context menu, so dropping these would have quietly removed Keep / Undo / Redo /
 * Chat / Open / Analyze from the Observations rows — a functional regression, not a rendering change.
 * The webview posts the VERB; the host looks the row's node up in its own table and refuses a verb this
 * row does not offer, so a command name never crosses the boundary.
 */
const TL_ROW_ACTS: Record<string, TlAct[]> = {
  recap: [{ v: 'refreshRecap', g: '✦', t: 'Refresh the session recap with Claude', tone: 'agent' }],
  edit: [
    { v: 'keep', g: '✓', t: 'Keep this edit', tone: 'done' },
    { v: 'undo', g: '✗', t: 'Undo this edit', tone: 'warn' },
    { v: 'analyzeEdit', g: '✦', t: 'Analyze this edit with Claude', tone: 'agent' },
    { v: 'chatEdit', g: '❝', t: 'Chat about this edit — copies its context, opens your agent', tone: 'agent' },
    { v: 'openFile', g: '⧉', t: 'Open the file', tone: 'accent' },
  ],
  editUndone: [
    { v: 'redo', g: '↻', t: 'Redo this edit', tone: 'done' },
    { v: 'chatEdit', g: '❝', t: 'Chat about this edit — copies its context, opens your agent', tone: 'agent' },
    { v: 'openFile', g: '⧉', t: 'Open the file', tone: 'accent' },
  ],
  file: [
    { v: 'keepFile', g: '✓', t: 'Keep every edit in this file', tone: 'done' },
    { v: 'undoFile', g: '✗', t: 'Undo every edit in this file', tone: 'warn' },
    { v: 'redoFile', g: '↻', t: 'Re-apply every undone edit in this file', tone: 'done' },
    { v: 'openFile', g: '⧉', t: 'Open the file', tone: 'accent' },
  ],
};

/**
 * A row's key, stable across refreshes so the reader's expansions survive a repaint.
 *
 * EXPANDABLE nodes key on their own identity (a category label, an edit id); leaves key on their
 * position, which is all a leaf needs. Every key is separator-free, because a child's key is its
 * parent's plus '/' and a file path would otherwise split it.
 */
function tlNodeKey(node: unknown, i: number): string {
  const n = node as { kind?: string; label?: string; rec?: { id: number }; edits?: { id: number }[] };
  switch (n.kind) {
    case 'recap': case 'steps': case 'ctxhead': case 'ogroup': case 'egroup': case 'cgroup':
      return n.kind;
    case 'agroup': return 'g' + String(n.label ?? '').replace(/[^A-Za-z0-9]/g, '');
    case 'edit': return 'e' + (n.rec ? n.rec.id : i);
    case 'tlrun': return 'run' + (n.edits && n.edits[0] ? n.edits[0].id : i);
    default: return (n.kind ?? 'n') + i;
  }
}

/** Thousands-separated, with the SEPARATOR fixed rather than the host's locale: this number is asserted
 *  in a test and read beside plain counts everywhere else in the window. */
function tlGroupNum(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+$)/g, ',');
}

/**
 * The row a capped edit feed ends its run with.
 *
 * Not a tree node: no provider produced it, nothing opens it, and it carries no verbs — its whole job is
 * to state the number the cap left out, in the position the rows were dropped from, so the feed can
 * never read as the whole session. (Silently short lists are the defect this exists to prevent.)
 */
function tlMoreRow(key: string, shown: number, total: number): TlRow {
  return {
    key,
    label: `showing ${tlGroupNum(shown)} of ${tlGroupNum(total)} edits`,
    desc: 'the newest are listed — the Overview’s change map covers the whole session',
    tip: `This session has ${tlGroupNum(total)} edits. The feed draws the newest ${tlGroupNum(shown)} of them — enough to scroll, not enough to stall the panel on every refresh.\n\nNothing is lost: the tab badge counts all ${tlGroupNum(total)}, the Overview’s change map covers every file, and the bulk verbs (Accept All, Reject All, a prompt’s Accept/Reject) act on the whole session, never on what is drawn here.`,
    glyph: '…',
    tone: 'muted',
    open: null,
    act: false,
    acts: [],
  };
}

/** One `vscode.TreeItem` as a row. Nothing here re-derives a label, a description or a tooltip. */
function tlRowOf(key: string, item: vscode.TreeItem, acts: TlAct[]): TlRow {
  const icon = item.iconPath as { id?: string; color?: { id?: string } } | undefined;
  const tip = item.tooltip as string | vscode.MarkdownString | undefined;
  const state = item.collapsibleState;
  return {
    key,
    label: String(item.label ?? ''),
    desc: item.description === true ? '' : String(item.description ?? ''),
    tip: typeof tip === 'string' ? tip : tip ? String(tip.value ?? '') : '',
    glyph: (icon && icon.id && TL_GLYPH[icon.id]) || (icon && icon.id ? '?' : ''),
    tone: (icon && icon.color && TL_TONE[icon.color.id ?? '']) || '',
    open: state === undefined || state === vscode.TreeItemCollapsibleState.None
      ? null
      : state === vscode.TreeItemCollapsibleState.Expanded,
    act: !!item.command,
    acts,
  };
}

/**
 * The Timeline window's shell (0.10.0): ONE webview carrying a real tab strip — Prompts · Actions ·
 * Observations — over the session selector they all share.
 *
 * It replaces three stacked panel views. VS Code stacks views in a container under collapsible headers
 * and has no tab strip of its own, so the tabs had to be drawn; they are modelled on the Overview's
 * left-nav strip (.ov-navtabs), including its grouping toggle, its draggable column dividers and its
 * fold-to-a-rail control, so the two windows behave the same way for the same reason.
 *
 * Actions and Observations still come from `ActionsProvider` and `ObservationsProvider` — the same core
 * view-models, the same grouping, the same default folds, the same empty rows. Only the RENDERING moved,
 * and it renders off their own `getTreeItem`, so labels, descriptions, tooltips and icons keep exactly
 * one implementation between the tree they were and the rows they are now.
 */
function timelineShell(): string {
  const nonce = getNonce();
  const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; script-src 'nonce-${nonce}';`;
  const style = `<style>${CODICON_STYLE}
  :root {
    --cm-pending: var(--vscode-charts-yellow, #d9a441);
    --cm-kept: var(--vscode-charts-green, #3fb950);
    --cm-reverted: var(--vscode-descriptionForeground, #9aa0aa);
    --cm-accent: var(--vscode-charts-blue, #4c8bf5);
    --cm-border: var(--vscode-widget-border, rgba(127,127,127,0.28));
    --cm-mono: var(--vscode-editor-font-family, monospace);
    --mt-working: var(--vscode-charts-blue, #4c8bf5);
    --mt-agent: var(--vscode-charts-purple, #9a6ac2);
    --mt-attn: var(--vscode-charts-orange, #d9822b);
    --mt-warn: var(--vscode-charts-red, #e5534b);
    --mt-done: var(--vscode-charts-green, #3fb950);
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:0; font-family: var(--vscode-font-family); font-size:11px; color: var(--vscode-foreground); height:100vh; display:flex; flex-direction:column; }
  /* The session selector (P5): which conversation the whole observatory is reviewing. ● live · ○ quiet.
     Opens an in-webview list of the sessions still ACTIVE, plus the reviewed one however old it is; the
     full list stays in the Overview's Sessions tab, one row down. Names WRAP — a session title is content
     text, and core has already capped it at 64 characters, so clipping it here would lose the only copy. */
  .rq-sess { flex:none; padding:5px 9px; border-bottom:1px solid var(--cm-border); }
  /* THE selector — bigger, bolder, tinted, with a
     visible dropdown affordance; it is the one control the whole window keys on. */
  .rq-newanchor { flex:none; margin-left:6px; }
  .rq-newanchor .rq-nb { font-size:14px; padding:4px 9px; }
  /* basis 0, not auto: flex breaks lines on PRE-shrink sizes, so a long title's natural width
     used to push the + button onto its own line — with basis 0 the chip and + always share row 1
     (the dropdown still breaks below via its own flex-basis:100%). */
  .rq-schip { flex:1 1 0; min-width:0; display:flex; align-items:center; gap:8px; width:100%; text-align:left; background: color-mix(in srgb, var(--vscode-button-background) 12%, transparent); border:1px solid var(--vscode-focusBorder, var(--cm-accent)); border-radius:7px; color: var(--vscode-foreground); font:inherit; font-size:13px; font-weight:600; padding:6px 10px; cursor:pointer; }
  .rq-schip:hover { background: color-mix(in srgb, var(--vscode-button-background) 22%, transparent); }
  .rq-sdot { flex:none; font-size:10px; color: var(--vscode-descriptionForeground); }
  .rq-sdot.live { color: var(--mt-done); }
  .rq-sdot.wait { color: var(--mt-warn, #d6ae58); }
  .rq-swait { flex:none; color: var(--mt-warn, #d6ae58); font-weight:700; font-size:11px; }
  .tla-quest { border-color: var(--mt-warn, #d6ae58); }
  .tla-quest .tla-permrow { cursor:default; }
  .tla-questnote { font-size:calc(var(--tl-fs) - 2px); color: var(--vscode-descriptionForeground); font-style:italic; padding-top:3px; }
  .rq-sname { flex:1 1 auto; min-width:12ch; overflow-wrap:anywhere; }
  .rq-scar { flex:none; font-size:9px; color: var(--vscode-descriptionForeground); }
  /* flex:1 1 100% forces the list onto its OWN full-width line below the chip row — as a plain
     flex sibling it shared the row and got only the leftover width (the 1-char-per-line crush). */
  .rq-slist { flex:1 1 100%; min-width:0; margin-top:4px; border:1px solid var(--cm-border); border-radius:5px; overflow:hidden; }
  /* The Traces navbar's own control language: ov-nb buttons + ✓-row drops. */
  .rq-sbar { position:sticky; top:0; display:flex; gap:6px; padding:6px 8px; border-bottom:1px solid var(--cm-border); background: var(--vscode-dropdown-background, var(--vscode-editor-background)); z-index:2; }
  .rq-sbar input { flex:1 1 auto; min-width:0; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--cm-border)); border-radius:4px; font:inherit; font-size:11px; padding:2px 6px; }
  .rq-drop-anchor { position:relative; flex:none; }
  .rq-nb { display:inline-flex; align-items:center; gap:4px; background:transparent; border:1px solid var(--cm-border); border-radius:4px; color: var(--vscode-descriptionForeground); font:inherit; font-size:11px; line-height:1; padding:3px 9px; cursor:pointer; white-space:nowrap; }
  .rq-nb:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); }
  .rq-nb.on { color: var(--vscode-foreground); border-color: var(--cm-accent); }
  .rq-filterdrop { position:absolute; top:100%; right:0; margin-top:4px; z-index:40; min-width:150px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border:1px solid var(--vscode-editorWidget-border, var(--cm-border));
    border-radius:5px; box-shadow:0 3px 10px rgba(0,0,0,0.35); padding:5px; text-align:left; }
  .rq-fd-row { display:flex; align-items:center; gap:6px; padding:3px 6px; font-size:11px; color: var(--vscode-foreground); cursor:pointer; border-radius:3px; white-space:nowrap; }
  .rq-fd-row:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); }
  .rq-fd-ck { display:inline-block; width:14px; flex:none; color: var(--mt-agent); font-weight:600; }
  .rq-snone { padding:5px 10px; font-size:10.5px; color: var(--vscode-descriptionForeground); font-style:italic; }
  .rq-sgrp { padding:4px 10px 2px; font-size:10px; letter-spacing:.04em; text-transform:uppercase; color: var(--vscode-descriptionForeground); border-bottom:1px solid var(--cm-border); }
  .rq-shand { color: var(--mt-warn, #d6ae58); font-size:10.5px; }
  .rq-srow.hand { background: color-mix(in srgb, var(--mt-warn, #d6ae58) 8%, transparent); }
  .rq-srow.rq-ssearch .rq-sname { color: var(--vscode-textLink-foreground); }
  .rq-shit { flex-basis:100%; font-size:10.5px; color: var(--vscode-descriptionForeground); white-space:normal; overflow-wrap:anywhere; }
  /* flex-wrap + a name floor (a squeezed panel crushed the name column to one
     character per line — overflow-wrap:anywhere then stacked the title vertically): the chips
     flow to the next line instead, and the name never drops below a readable width. */
  .rq-srow { display:flex; flex-wrap:wrap; align-items:center; gap:3px 6px; width:100%; text-align:left; background:transparent; border:0; border-bottom:1px solid var(--cm-border); color: var(--vscode-foreground); font:inherit; font-size:11px; padding:4px 8px; cursor:pointer; }
  .rq-srow:last-child { border-bottom:0; }
  .rq-srow:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); }
  .rq-srow.on { background: var(--vscode-list-activeSelectionBackground, rgba(80,120,200,0.16)); }
  .rq-sago { flex:none; font-family: var(--cm-mono); font-size:9px; color: var(--vscode-descriptionForeground); }
  .rq-sdel { flex:none; font-size:11px; line-height:1; padding:0 2px; cursor:pointer; opacity:0; }
  .rq-srow:hover .rq-sdel, .rq-srow.on .rq-sdel { opacity:.6; }
  .rq-sdel:hover { opacity:1; }
  /* Workspace labels wrap in full. */
  .rq-sws { flex:none; max-width:100%; overflow-wrap:anywhere;
    font-family: var(--cm-mono); font-size:9px; opacity:.7; color: var(--vscode-descriptionForeground); }
  .rq-agentbadge { flex:none; font-family: var(--cm-mono); font-size:9px; white-space:nowrap;
    color: var(--c-pending, #d19a66); border:1px solid var(--c-pending, #d19a66); border-radius:3px; padding:0 4px; }
  /* The model tag: informational, not a warning — dim mono, no border, so the agent/tier badges keep
     their contrast while every row still names what served it. */
  .rq-smodel { flex:none; font-family: var(--cm-mono); font-size:9px; white-space:nowrap;
    color: var(--vscode-descriptionForeground); }
  .rq-head { flex:none; display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; padding:6px 9px 5px; border-bottom:1px solid var(--cm-border); }
  .rq-title { font-size:9px; letter-spacing:.6px; text-transform:uppercase; color: var(--vscode-descriptionForeground); }
  .rq-sum { font-family: var(--cm-mono); font-size:10px; color: var(--vscode-descriptionForeground); font-variant-numeric:tabular-nums; }
  .rq-clear { margin-left:auto; background:transparent; border:1px solid var(--cm-border); border-radius:99px; color: var(--vscode-descriptionForeground); font:inherit; font-size:10px; padding:1px 9px; cursor:pointer; }
  .rq-clear:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); }
  .rq-desc { flex:none; font-size:10px; line-height:1.45; color: var(--vscode-descriptionForeground); padding:5px 9px 6px; border-bottom:1px solid var(--cm-border); }
  .rq-list { flex:1; overflow-y:auto; min-height:0; padding:6px 9px 10px; }
  .rq-row { border:1px solid var(--cm-border); border-radius:5px; margin-bottom:5px; padding:5px 8px; cursor:pointer; }
  .rq-row:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.08)); }
  .rq-row.sel { border-color: var(--cm-accent); border-left:3px solid var(--cm-accent); background: var(--vscode-list-activeSelectionBackground, rgba(80,120,200,0.16)); }
  .rq-review { background:transparent; border:1px solid var(--cm-border); border-radius:99px; color: var(--vscode-descriptionForeground); font:inherit; font-size:9px; padding:0 8px; cursor:pointer; flex:none; }
  .rq-review.on { background: var(--cm-accent); border-color: var(--cm-accent); color: var(--vscode-editor-background, #1e1e1e); font-weight:600; }
  /* the row's facts line — wraps rather than clipping, like every other list in this product */
  .rq-facts { display:flex; align-items:center; gap:7px; flex-wrap:wrap; }
  .rq-ix { font-family: var(--cm-mono); font-size:10px; flex:none; font-variant-numeric:tabular-nums; }
  /* THE ASK, in full. No ellipsis, no line clamp: it wraps over as many lines as it takes — a clipped
     question is unrecognisable, and this text is the row's entire identity. */
  .rq-ask { font-size:11.5px; line-height:1.4; color: var(--vscode-foreground); white-space:pre-wrap; overflow-wrap:anywhere; margin-top:3px; }
  .rq-meta { font-family: var(--cm-mono); font-size:9px; color: var(--vscode-descriptionForeground); flex:none; }
  .rq-diff { font-family: var(--cm-mono); font-size:9.5px; flex:none; font-variant-numeric:tabular-nums; }
  .rq-add { color: var(--mt-done); }
  .rq-rem { color: var(--mt-warn); }
  .rq-none { font-size:9.5px; color: var(--vscode-descriptionForeground); font-style:italic; flex:none; }
  .rq-err { font-family: var(--cm-mono); font-size:10px; color: var(--mt-warn); flex:none; }
  .rq-cap { font-size:9px; color: var(--vscode-descriptionForeground); flex:none; }
  .rq-live { font-size:8.5px; font-weight:600; color:#fff; background: var(--mt-working); border-radius:99px; padding:0 6px; flex:none; }
  /* expand-response caret — a quiet text button on the facts line; tinted when open */
  .rq-exp { margin-left:auto; background:transparent; border:1px solid var(--cm-border); border-radius:99px; color: var(--vscode-descriptionForeground); font:inherit; font-size:9px; padding:0 8px; cursor:pointer; flex:none; }
  .rq-exp:hover { color: var(--vscode-foreground); }
  .rq-exp.on { color: var(--cm-accent); border-color: var(--cm-accent); }
  /* the agent's reply, expanded under the ask. The prose WRAPS and never clips — this is for reading. */
  .rq-resp { margin-top:6px; border-top:1px dashed var(--cm-border); padding-top:6px; }
  .rq-rhead { font-size:8.5px; letter-spacing:.5px; text-transform:uppercase; color: var(--vscode-descriptionForeground); margin-bottom:4px; }
  .rq-rtext { font-size:11px; line-height:1.5; color: var(--vscode-foreground); white-space:pre-wrap; overflow-wrap:anywhere; max-height:340px; overflow-y:auto; }
  .rq-rmore { font-size:9px; color: var(--vscode-descriptionForeground); font-style:italic; margin-top:4px; }
  .rq-rload { font-size:10px; color: var(--vscode-descriptionForeground); font-style:italic; }
  .rq-empty { padding:12px 9px; color: var(--vscode-descriptionForeground); line-height:1.5; }
  .rq-empty b { color: var(--vscode-foreground); }
  .rq-empty button { display:block; margin-top:7px; background:transparent; border:1px solid var(--cm-border); border-radius:5px; color: var(--cm-accent); font:inherit; font-size:11px; padding:3px 9px; cursor:pointer; }
  .rq-empty button:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); }
  /* Guided tour: the ring on the control a step names. The script has always ADDED this class here; the
     rule itself was missing, so a Prompts step rang nothing at all. */
  .ring { outline:2px solid var(--vscode-charts-blue, #4c8bf5); outline-offset:2px; border-radius:3px; }

  /* --- the tab strip -------------------------------------------------------------------------------
     Modelled on the Overview's .ov-navtabs, for the same reason it exists there: the container stacks
     views, so a window that holds three of them has to draw its own tabs. The GROUPING toggle sits on
     this row, beside the tabs it rearranges — never in a toolbar. */
  .tl-tabrow { flex:none; display:flex; align-items:flex-start; gap:6px; padding:5px 9px 0; }
  .tl-tabs { display:flex; flex:1 1 auto; flex-wrap:wrap; gap:4px; min-width:0; }
  .tl-tab { flex:none; display:flex; align-items:center; gap:6px; background:transparent; border:1px solid var(--cm-border); border-radius:5px 5px 0 0; border-bottom:2px solid transparent; color: var(--vscode-descriptionForeground); font:inherit; font-size:11px; padding:4px 12px; cursor:pointer; white-space:nowrap; }
  .tl-tab:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); }
  .tl-tab.on { color: var(--vscode-foreground); border-bottom-color: var(--mt-working); background: var(--vscode-list-activeSelectionBackground, rgba(80,120,200,0.18)); }
  .tl-tn { font-family: var(--cm-mono); font-size:9px; opacity:0.72; font-variant-numeric:tabular-nums; }
  .tl-toggle { flex:none; display:inline-flex; align-items:center; gap:5px; background:transparent; border:1px solid var(--cm-border); border-radius:5px; color: var(--vscode-descriptionForeground); font:inherit; font-size:11px; padding:3px 9px; cursor:pointer; white-space:nowrap; }
  .tl-toggle:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); color: var(--vscode-foreground); }
  .tl-toggle .codicon { font-size:14px; line-height:1; opacity:0.3; }
  .tl-toggle.on { color: var(--vscode-foreground); border-color: var(--cm-accent); background: var(--vscode-list-activeSelectionBackground, rgba(80,120,200,0.14)); }
  .tl-toggle.on .codicon { opacity:1; color: var(--cm-kept); }
  .tl-body { flex:1; min-height:0; display:flex; border-top:1px solid var(--cm-border); }
  .tl-pane { flex:1; min-width:0; min-height:0; display:flex; flex-direction:column; }
  /* every member's content is rendered INTO its host, so the host moves between the solo pane and a
     grouped column and the member keeps exactly one renderer */
  .tl-host { flex:1; min-height:0; display:flex; flex-direction:column; }

  /* --- grouped columns -----------------------------------------------------------------------------
     Prompts beside Observations and Actions, all three at once. Same mechanics as the Overview's
     grouped nav: --tl-cw is the column's dragged share, the floor is what a drag clamps against, and a
     folded column becomes a rail that still names itself. */
  .tl-group { flex-direction:row; gap:8px; padding:0 2px; }
  .tl-groupcol { flex: var(--tl-cw, 1) 1 0; min-width:190px; min-height:0; display:flex; flex-direction:column; position:relative; }
  .tl-groupcol + .tl-groupcol { border-left:1px solid var(--cm-border); }
  .tl-cgutter { position:absolute; left:-8px; top:0; bottom:0; width:9px; cursor:col-resize; z-index:3; touch-action:none; }
  .tl-cgutter::after { content:''; position:absolute; top:0; bottom:0; left:4px; width:1px; background:transparent; }
  .tl-cgutter:hover::after, .tl-cgutter.drag::after { background: var(--vscode-focusBorder, rgba(127,127,127,0.7)); }
  .tl-group .tl-groupcol.rail { flex:0 0 28px; min-width:28px; overflow:hidden; }
  .tl-groupcol .tl-rail { display:none; }
  .tl-groupcol.rail .tl-rail { display:flex; align-items:center; justify-content:flex-start; gap:6px; width:100%; height:100%; background:transparent; border:0; color: var(--vscode-descriptionForeground); font:inherit; font-size:9px; letter-spacing:.6px; text-transform:uppercase; cursor:pointer; padding:8px 0; writing-mode:vertical-rl; }
  .tl-groupcol.rail .tl-rail:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); }
  .tl-groupcol.rail .tl-ghead, .tl-groupcol.rail .tl-host, .tl-groupcol.rail .tl-cgutter { display:none; }
  .tl-ghead { flex:none; display:flex; align-items:center; gap:6px; font-size:9px; letter-spacing:.6px; text-transform:uppercase; color: var(--vscode-descriptionForeground); padding:5px 8px 4px; border-bottom:1px solid var(--cm-border); }
  .tl-cfold { margin-left:auto; flex:none; background:transparent; border:0; color: var(--vscode-descriptionForeground); font:inherit; line-height:1; padding:0 2px; cursor:pointer; }
  .tl-cfold:hover { color: var(--vscode-foreground); }
  .tl-cfold .codicon { font-size:12px; vertical-align:middle; }
  /* Below the breakpoint the columns STACK rather than shrink — three 190px columns do not fit a side
     bar, and squeezing them would clip names this product never truncates. The dragged widths are
     widths, so they mean nothing stacked: every column takes an equal share and the dividers go. */
  @media (max-width: 620px) {
    .tl-group { flex-direction:column; }
    .tl-groupcol { min-width:0; flex:1 1 0; }
    .tl-groupcol + .tl-groupcol { border-left:none; border-top:1px solid var(--cm-border); }
    .tl-cgutter { display:none; }
    .tl-group .tl-groupcol.rail { flex:0 0 auto; }
    .tl-groupcol.rail .tl-rail { writing-mode:horizontal-tb; height:auto; padding:4px 8px; }
    .tl-tab { padding:3px 8px; }
  }

  /* --- a flattened tree row (Actions · Observations) -----------------------------------------------
     The trees' own rows: a twisty where the node had a collapsible state, the icon as a text mark (the
     webview font is a SUBSET — an unlisted codicon draws nothing at all), the label, the description,
     and the inline actions the tree carried in its context menu. Everything WRAPS; the full tooltip
     rides the row's title, as it did on the tree item. */
  .tl-list { flex:1; overflow-y:auto; min-height:0; padding:5px 7px 10px; }
  /* Deliberately NOT content-visibility:auto. It is the obvious answer to "these rows are not
     virtualized", and measured in headless Chrome on 400 of these rows it reports a scrollHeight of
     10,867px against a true 20,740px — the rows it has not rendered yet are counted at their
     contain-intrinsic-size, not at the two lines they actually wrap to, so the scrollbar under-reports
     the feed by half and grows under the reader's thumb as they scroll. The row COUNT is bounded
     instead (EDIT_FEED_CAP), which costs nothing at render time and leaves the scrollbar honest. */
  .tl-row { display:flex; align-items:baseline; gap:6px; padding:2px 3px; border-radius:3px; }
  .tl-row:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.10)); }
  .tl-row.act { cursor:pointer; }
  .tl-tw { flex:none; width:13px; background:transparent; border:0; color: var(--vscode-descriptionForeground); font:inherit; font-size:9px; line-height:1.5; padding:0; cursor:pointer; text-align:left; }
  .tl-gl { flex:none; width:13px; text-align:center; font-size:10px; color: var(--vscode-descriptionForeground); }
  .tl-lb { flex:0 1 auto; min-width:0; font-size:11px; line-height:1.45; overflow-wrap:anywhere; }
  .tl-de { flex:1 1 auto; min-width:0; font-size:9.5px; line-height:1.45; color: var(--vscode-descriptionForeground); overflow-wrap:anywhere; }
  .tl-ops { flex:none; display:inline-flex; gap:2px; opacity:0; transition:opacity .1s; }
  .tl-row:hover .tl-ops { opacity:1; }
  .tl-op { background:transparent; border:1px solid var(--cm-border); border-radius:3px; color:inherit; font:inherit; font-size:10px; line-height:1; padding:1px 5px; cursor:pointer; }
  .tl-op:hover { border-color: var(--cm-accent); }
  .tl-load { font-size:9.5px; color: var(--vscode-descriptionForeground); font-style:italic; padding:1px 4px; }
  .t-done { color: var(--mt-done); }
  .t-warn { color: var(--mt-warn); }
  .t-attn { color: var(--mt-attn); }
  .t-pending { color: var(--cm-pending); }
  .t-accent { color: var(--cm-accent); }
  .t-agent { color: var(--mt-agent); }
  .t-muted { color: var(--vscode-descriptionForeground); }
  /* ---- the Feed tab — the TUI agent-feed port (0.10.0). Reads downward like a terminal
     (oldest at the top, newest at the bottom); entries render as BLOBS with a left rail. ---- */
  #tlf-wrap { display:flex; flex-direction:column; height:100%; min-height:0; }
  /* The entry list is the tab's scroller — renderFeedTab restores its scrollTop and tails it, and
     the ↓ newest pill is measured against it, none of which a content-sized div can do. */
  .tlf-body { flex:1; min-height:0; overflow-y:auto; }
  .tl-body { --tl-fs: var(--vscode-font-size, 13px); }
  /* Each entry is a bordered block with real air between blocks — the TUI's boxed blobs.
     The left edge stays the 2px status accent; the box is the quiet 1px border. */
  .tlf-blob { border:1px solid var(--cm-border); border-left:2px solid var(--cm-border); border-radius:4px; padding:3px 6px; margin:6px 0; }
  /* The user's own ask — a dim grey band, the way the agent CLI paints user turns. */
  .tlf-blob.user { background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,0.16)); border-left-color: var(--vscode-descriptionForeground); }
  .tlf-user-text { font-family: var(--cm-mono); font-size:calc(var(--tl-fs) - 2px); white-space:pre-wrap; overflow-wrap:anywhere; padding:2px 2px 3px 6px; }
  .tlf-blob.err { border-left-color: var(--mt-warn); }
  .tlf-blob.perm { border-left-color: var(--cm-pending); }
  .tlf-hrow { display:flex; align-items:baseline; gap:6px; padding:0 2px; cursor:pointer; border-radius:3px; }
  .tlf-hrow:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.10)); }
  .tlf-twig { flex:none; width:10px; font-size:calc(var(--tl-fs) - 3px); color: var(--vscode-descriptionForeground); }
  .tlf-verb { flex:none; font-family: var(--cm-mono); font-size:calc(var(--tl-fs) - 1px); color: var(--cm-accent); }
  .tlf-verb.exec { color: var(--mt-done); }
  .tlf-target { flex:1 1 auto; min-width:0; font-size:calc(var(--tl-fs) - 2px); color: var(--vscode-foreground); opacity:.85; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .tlf-target.mono { font-family: var(--cm-mono); }
  .tlf-mark { flex:none; width:9px; font-size:calc(var(--tl-fs) - 3px); }
  .tlf-mark.ok { color: var(--mt-done); }
  .tlf-mark.err { color: var(--mt-warn); }
  .tlf-mark.pend { color: var(--cm-pending); }
  .tlf-ts { flex:none; margin-left:auto; font-family: var(--cm-mono); font-size:calc(var(--tl-fs) - 3px); color: var(--vscode-descriptionForeground); font-variant-numeric:tabular-nums; }
  .tlf-think { font-size:calc(var(--tl-fs) - 2px); color: var(--vscode-descriptionForeground); font-style:italic; padding:1px 2px 1px 18px; overflow-wrap:anywhere; }
  .tlf-think .hd { color: var(--mt-agent); font-style:normal; font-size:calc(var(--tl-fs) - 4px); text-transform:uppercase; letter-spacing:.05em; margin-right:4px; }
  .tlf-sub { font-size:calc(var(--tl-fs) - 3px); color: var(--vscode-descriptionForeground); padding:0 2px 0 18px; overflow-wrap:anywhere; }
  .tlf-cmd { font-family: var(--cm-mono); font-size:calc(var(--tl-fs) - 2px); color: var(--vscode-foreground); white-space:pre-wrap; overflow-wrap:anywhere; padding:1px 2px 1px 18px; }
  .tlf-diffbtn { background:transparent; border:0; color: var(--cm-accent); font:inherit; font-size:calc(var(--tl-fs) - 3px); padding:0 2px 0 18px; cursor:pointer; display:block; text-align:left; }
  .tlf-diffbtn:hover { text-decoration:underline; }
  .tlf-out { font-family: var(--cm-mono); font-size:calc(var(--tl-fs) - 2px); color: var(--vscode-descriptionForeground); white-space:pre-wrap; overflow-wrap:anywhere; padding:0 2px; }
  /* shell syntax (the TUI tokenizer's four classes): program · flags · strings · operators */
  .tlf-sh-prog { color: var(--cm-accent); font-weight:600; }
  .tlf-sh-flag { color: var(--cm-pending); }
  .tlf-sh-str { color: var(--mt-done); }
  .tlf-sh-op { color: var(--vscode-descriptionForeground); }
  /* the inline diff preview — the CLI's own colours: @@ hunks dim-blue, adds green, removes red */
  .tlf-diff { font-family: var(--cm-mono); font-size:calc(var(--tl-fs) - 2px); margin:2px 0 2px 18px; border:1px solid var(--cm-border); border-radius:3px; padding:2px 6px; overflow-x:auto; }
  .tlf-dl { white-space:pre; margin:0 -6px; padding:0 6px; }
  /* Added/removed read as BANDS, the way a diff editor paints them — background fills at the
     theme's own diff tokens, foreground stays the default text colour. */
  .tlf-dl.add { background: var(--vscode-diffEditor-insertedTextBackground, rgba(46,160,67,0.18)); }
  .tlf-dl.rem { background: var(--vscode-diffEditor-removedTextBackground, rgba(248,81,73,0.18)); }
  .tlf-dl.hunk { color: var(--cm-accent); opacity:.8; }
  .tlf-dl.ctx { color: var(--vscode-descriptionForeground); }
  .tlf-file { cursor:pointer; }
  .tlf-file:hover { text-decoration:underline; color: var(--cm-accent); opacity:1; }
  /* the way back to the tail once the reader scrolls up — floats over the body's bottom-right */
  .tlf-jump { position:absolute; right:14px; bottom:8px; z-index:5; display:inline-flex; align-items:center; gap:3px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); color: var(--cm-accent);
    border:1px solid var(--cm-accent); border-radius:99px; font:inherit; font-size:calc(var(--tl-fs) - 1px); padding:2px 9px; cursor:pointer;
    box-shadow:0 2px 8px rgba(0,0,0,0.35); }
  .tlf-jump:hover { color: var(--vscode-foreground); }
  .tla-bodywrap { flex:1; min-height:0; position:relative; display:flex; flex-direction:column; }
  .tla-text { font-size:var(--tl-fs); color: var(--vscode-foreground); white-space:pre-wrap; overflow-wrap:anywhere; padding:1px 2px; line-height:1.45; }
  .tla-meta { font-size:calc(var(--tl-fs) - 2px); color: var(--vscode-descriptionForeground); padding:1px 2px; overflow-wrap:anywhere; }
  /* markdown, the CLI's slice: code chips, headings, bullets, quotes, fenced blocks */
  .tla-md div { min-height:1em; }
  .tla-md .tla-mdgap { min-height:0.5em; }
  .tla-code { font-family: var(--cm-mono); font-size:0.92em; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.14)); border-radius:3px; padding:0 3px; }
  .tla-mdh { margin-top:2px; }
  .tla-mdq { border-left:2px solid var(--cm-border); padding-left:6px; color: var(--vscode-descriptionForeground); }
  .tla-mdcode { font-family: var(--cm-mono); font-size:0.92em; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.10)); white-space:pre-wrap; padding:0 6px; }
  .tla-mdfence { color: var(--vscode-descriptionForeground); font-family: var(--cm-mono); font-size:0.85em; }
  .tla-mdt { border-collapse:collapse; margin:3px 0; font-size:calc(var(--tl-fs) - 1px); }
  .tla-mdt th, .tla-mdt td { border:1px solid var(--cm-border); padding:1px 8px; text-align:left; }
  .tla-mdt th { font-weight:600; background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.08)); }
  .tlf-think.tla-md { font-style:normal; }
  .tlf-think.tla-md i { font-style:italic; }
  /* The agent's own words as rows: a reply in the editor's normal face, its thinking folded. */
  .tlf-blob.said { border-left-color: var(--mt-agent); }
  .tlf-blob.said .tla-text { padding:2px 2px 3px 18px; }
  .tlf-verb.agent { color: var(--mt-agent); }
  </style>`;
  const body =
    // The selector leads the WINDOW, above the tabs: which session these belong to precedes every
    // question any of the three tabs answers.
    `<div class="rq-sess" id="rq-sess" style="display:flex;align-items:center;flex-wrap:wrap;">` +
    `<button class="rq-schip" id="rq-schip" title="The session the observatory is reviewing — click to switch session"><span class="rq-sdot" id="rq-sdot">○</span><span class="rq-sname" id="rq-sname">session —</span><span class="rq-swait" id="rq-swait" style="display:none" title="Sessions waiting on you — click to jump to the most urgent one"></span><span class="rq-scar">▾</span></button>` +
    `<span class="rq-drop-anchor rq-newanchor"><button class="rq-nb" id="rq-newsess" title="Start a NEW agent session — its CLI opens in the terminal, the observatory picks it up">＋</button><div class="rq-filterdrop" id="rq-newdrop" hidden></div></span>` +
    `<div class="rq-slist" id="rq-slist" hidden></div>` +
    `</div>` +
    `<div class="tl-tabrow"><div class="tl-tabs" id="tl-tabs"></div>` +
    `<button class="tl-toggle" id="tl-grouptabs" aria-pressed="false" title="Group these tabs side by side (Feed · Prompts · Observations · Actions)"><i class="codicon codicon-split-horizontal"></i> Group tabs</button>` +
    `</div>` +
    `<div class="tl-body">` +
    `<div class="tl-pane" id="tl-pane-prompts" style="display:none"><div class="tl-host" id="tl-prompts"></div></div>` +
    `<div class="tl-pane" id="tl-pane-observations" style="display:none"><div class="tl-host" id="tl-observations"></div></div>` +
    `<div class="tl-pane" id="tl-pane-actions" style="display:none"><div class="tl-host" id="tl-actions"></div></div>` +
    `<div class="tl-pane" id="tl-pane-feed" style="display:none"><div class="tl-host" id="tl-feed"></div></div>` +
    // Grouped mode's one pane. Its COLUMNS are composed by the script (one per member, each carrying
    // that member's own host node), so every member still has exactly one renderer in either mode.
    `<div class="tl-pane tl-group" id="tl-group" style="display:none"></div>` +
    `</div>` +
    `<script nonce="${nonce}">${TIMELINE_SCRIPT}</script>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">${style}</head><body>${body}</body></html>`;
}

const TIMELINE_SCRIPT = `
(function(){
  "use strict";
  var vscode=acquireVsCodeApi();
  var RQ=null, SEL=null, SEEN=false;
  // --- this window's own layout ---------------------------------------------------------------------
  // Which tab is forward, whether the four sit side by side, which tree rows are expanded, and the
  // grouped columns' widths + folded set. Every one of these is a LAYOUT choice belonging to this panel,
  // so they ride the webview state object — the same call the Overview makes for its groupedNav — and
  // never a workspace setting. Nothing here is ever recomputed from a payload: a badge arriving on a
  // later tick must not reset a width or a fold the reader set seconds earlier.
  var WVSTATE=(vscode.getState&&vscode.getState())||{};
  // Accept retired tab keys from development builds. The Feed keeps its own column fold state.
  if(WVSTATE.tab==='agent'||WVSTATE.tab==='conversation') WVSTATE.tab='feed';
  if(WVSTATE.colC){ delete WVSTATE.colC.agent; delete WVSTATE.colC.conversation; }
  // The Feed leads — the conversation as it happened — followed by the audits.
  var TABS=[['feed','Feed'],['prompts','Prompts'],['observations','Observations'],['actions','Actions']];
  function isTab(t){ for(var i=0;i<TABS.length;i++) if(TABS[i][0]===t) return true; return false; }
  var TAB=isTab(WVSTATE.tab)? WVSTATE.tab : 'feed';
  var GROUPED=!!WVSTATE.groupedTabs;
  var OPEN=(WVSTATE.open&&typeof WVSTATE.open==='object')?WVSTATE.open:{};
  var COLW=(Array.isArray(WVSTATE.colW) && WVSTATE.colW.length===TABS.length)?WVSTATE.colW.slice():[1,1,1,1];
  var COLC=(WVSTATE.colC&&typeof WVSTATE.colC==='object')?WVSTATE.colC:{};
  var COL_MIN=190; // the floor a column drag clamps against — below it these rows would have to clip
  function saveState(){ try{ vscode.setState({ tab:TAB, groupedTabs:GROUPED, open:OPEN, colW:COLW, colC:COLC }); }catch(e){} }
  var TAB_TIP={
    prompts:'Prompts — what you asked for, in order. Selecting one scopes the Overview beside it.',
    observations:'Observations — why each change was made, in the agent’s own words, plus the session recap and the context it was working from.',
    actions:'Actions — every tool call by category, then the two audits: what landed outside your workspace, and where the session reached.',
    feed:'Feed — the conversation as it happened: your prompts, the agent’s replies and thinking, every tool call with its diff. Follows whatever the Overview selects.'
  };
  var TAB_DESC={
    prompts:'What you asked for, in order. Select one to scope the Overview beside it — its fleet, runs, tasks, shells and change map narrow to the work that ask caused.',
    observations:'Why each change was made, in the agent’s own words, lifted from the transcript rather than regenerated — with the session recap, the context it was working from, and what is still open.',
    actions:'Every tool call this session made, by category and timestamped. Below them: the writes that landed outside your workspace, and where the session reached.'
  };
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function fmtDur(ms){ ms=ms||0; var s=Math.round(ms/1000); if(s<60) return s+'s'; var m=Math.round(s/60); if(m<60) return m+'m'; return (m/60).toFixed(1)+'h'; }
  function fmtTok(n){ n=n||0; if(n>=1e6) return (n/1e6).toFixed(1)+'M'; if(n>=1e3) return Math.round(n/1e3)+'k'; return ''+n; }
  function fmtBytes(n){ n=n||0; if(n<1024) return n+' B'; if(n<1048576) return (n/1024).toFixed(n<10240?1:0)+' KB'; return (n/1048576).toFixed(1)+' MB'; }
  // EXP = which asks are expanded to show the agent's reply; RESP = the fetched responses, cached client-side
  // so re-expanding a row is instant. The response is fetched lazily (it can be large) via the host.
  var EXP={}, RESP={};
  // Toggle a prompt's response open/closed. Opening one it hasn't fetched asks the host for it.
  function toggleResp(id){ if(!id) return;
    if(EXP[id]){ delete EXP[id]; } else {
      EXP[id]=1;
      if(!RESP[id]) vscode.postMessage({type:'expand', id:id});
      // Reading the response also scrolls the Feed tab's feed to where the agent ANSWERED
      // — the prompt click already jumps to where the ask began.
      vscode.postMessage({type:'respJump', id:id});
    }
    renderPrompts();
  }
  // The response block for a row: the prose (wrapped, never clipped), a truncation note, or a loading /
  // "no prose" line — the three honest states of a lazily-fetched, possibly-empty response.
  function respHtml(r){
    var d=RESP[r.id];
    if(!d) return '<div class="rq-rload">Reading the agent’s response…</div>';
    if(!d.text) return '<div class="rq-rload">the agent wrote no prose for this ask — it may have only run tools.</div>';
    return '<div class="rq-rhead">'+d.turns+' turn'+(d.turns===1?'':'s')+'</div>'+
      '<div class="rq-rtext">'+esc(d.text)+'</div>'+
      (d.truncated?('<div class="rq-rmore">… '+fmtBytes(d.truncated)+' more not shown</div>'):'');
  }
  // Everything the ask produced, one wrapping facts line: edits (±lines · files · folders · pending),
  // tokens, subagents/runs/tasks/shells, failed calls, compactions. An ask with NO edits is normal —
  // and WHY it produced none is the honest part: a question/decision (no tools) vs work that ran plenty
  // but didn't land in the tree.
  function facts(r){
    var f=[];
    if(r.edits){
      if(r.added||r.removed) f.push('<span class="rq-diff"><span class="rq-add">+'+(r.added||0)+'</span> <span class="rq-rem">−'+(r.removed||0)+'</span></span>');
      f.push('<span class="rq-meta" title="edits · files · folders this ask touched">'+r.edits+' edit'+(r.edits===1?'':'s')+' · '+(r.files||0)+'f · '+(r.folders||0)+'fo'+(r.pending?' · '+r.pending+'⧗':'')+(r.undone?' · '+r.undone+'✗':'')+'</span>');
    } else {
      f.push('<span class="rq-none">'+(r.actions ? ('no edits · '+r.actions+' tool call'+(r.actions===1?'':'s')) : 'no edits — a question or a decision')+'</span>');
    }
    if(r.tokens) f.push('<span class="rq-meta" title="tokens processed once — input + output + cache writes. Cache READS are excluded: the prompt is re-read every turn, so counting them made the same context accumulate per turn.">'+fmtTok(r.tokens)+' tok</span>');
    var w=[];
    if((r.agents||[]).length) w.push(r.agents.length+' subagent'+(r.agents.length===1?'':'s'));
    if((r.workflows||[]).length) w.push(r.workflows.length+' workflow run'+(r.workflows.length===1?'':'s'));
    if(r.tasks) w.push(r.tasks+' task'+(r.tasks===1?'':'s'));
    if((r.processes||[]).length) w.push(r.processes.length+' shell'+(r.processes.length===1?'':'s'));
    if(w.length) f.push('<span class="rq-meta">'+esc(w.join(' · '))+'</span>');
    if(r.errors) f.push('<span class="rq-err" title="'+r.errors+' tool call(s) failed while answering this prompt">✗ '+r.errors+'</span>');
    if(r.compactions) f.push('<span class="rq-cap" title="context compacted ×'+r.compactions+' while answering this prompt">⤺'+r.compactions+'</span>');
    return f.join('');
  }
  // --- where a tab's content currently lives --------------------------------------------------------
  // Grouped mode composes its own host per column, so this is the ONE thing that moves between layouts —
  // every renderer below stays the single renderer for its tab rather than growing a second, grouped
  // variant that could drift from it. (Same shape as the Overview's paneHost.)
  function paneHost(k){ var g=GROUPED? document.getElementById('tl-g-'+k):null; return g||document.getElementById('tl-'+k); }
  function colOpen(k){ return !COLC[k]; }
  function openCols(){ var n=0; for(var i=0;i<TABS.length;i++) if(colOpen(TABS[i][0])) n++; return n; }
  /** Whether a tab is ON SCREEN right now — the solo tab that is forward, or an unfolded grouped column. */
  function shows(k){ return GROUPED? colOpen(k) : (TAB===k); }

  // --- the flattened trees (Actions · Observations) --------------------------------------------------
  // rows[''] is the root level; rows[key] is that row's children, fetched from the host the first time it
  // is opened. A root payload drops the lot: the children it served belong to the payload before it, and
  // an expanded group must never keep showing the previous tick's rows.
  var TREE={ observations:{ rows:{}, req:{}, count:0, err:null, hooks:true, seen:false },
             actions:{ rows:{}, req:{}, count:0, err:null, hooks:true, seen:false } };
  function isOpen(tab,r){ var v=OPEN[tab+'/'+r.key]; return (v===undefined)? !!r.open : !!v; }
  function needChildren(tab,key){ var st=TREE[tab];
    if(st.rows[key]!==undefined || st.req[key]) return;
    st.req[key]=1; vscode.postMessage({type:'children', tab:tab, key:key}); }
  function findRow(tab,key){ var st=TREE[tab];
    for(var p in st.rows){ var l=st.rows[p]; for(var i=0;i<l.length;i++) if(l[i].key===key) return l[i]; }
    return null; }
  function toggleRow(tab,key){
    var r=findRow(tab,key), now=r? isOpen(tab,r):false;
    OPEN[tab+'/'+key] = !now;
    // Expansion is remembered across a hide/show, so bound it: a long-lived window that has walked a lot
    // of sessions would otherwise carry every key it ever opened.
    var ks=Object.keys(OPEN); if(ks.length>200) OPEN={};
    if(!now) needChildren(tab,key);
    saveState(); renderTree(tab);
  }
  function opsHtml(r){ var a=r.acts||[]; if(!a.length) return '';
    var h='<span class="tl-ops">';
    for(var i=0;i<a.length;i++) h+='<button class="tl-op'+(a[i].tone?' t-'+a[i].tone:'')+'" data-verb="'+esc(a[i].v)+'" title="'+esc(a[i].t)+'">'+esc(a[i].g)+'</button>';
    return h+'</span>'; }
  function rowsHtml(tab,parent,depth){
    var st=TREE[tab], list=st.rows[parent]||[], h='';
    for(var i=0;i<list.length;i++){ var r=list[i], open=(r.open!==null)&&isOpen(tab,r);
      // Label, description and tooltip are the tree item's own — no second implementation of any of them.
      // Both text columns WRAP; the whole tooltip rides the row's title, exactly as it did on the tree.
      h+='<div class="tl-row'+(r.act?' act':'')+'" data-key="'+esc(r.key)+'" title="'+esc(r.tip)+'" style="padding-left:'+(3+depth*13)+'px">'+
        (r.open===null? '<span class="tl-tw"></span>'
                      : '<button class="tl-tw" data-tw="'+esc(r.key)+'" title="'+(open?'Collapse':'Expand')+'">'+(open?'▾':'▸')+'</button>')+
        '<span class="tl-gl'+(r.tone?' t-'+r.tone:'')+'">'+esc(r.glyph)+'</span>'+
        '<span class="tl-lb">'+esc(r.label)+'</span>'+
        '<span class="tl-de">'+esc(r.desc||'')+'</span>'+
        opsHtml(r)+
        '</div>';
      if(open){
        if(st.rows[r.key]===undefined){ needChildren(tab,r.key); h+='<div class="tl-load" style="padding-left:'+(16+depth*13)+'px">reading…</div>'; }
        else h+=rowsHtml(tab,r.key,depth+1);
      }
    }
    return h;
  }
  // The empty states the two removed views carried as viewsWelcome entries, moved here with them. The
  // demo offer is a BUTTON that posts to the host — a webview never names a command itself.
  function emptyHtml(tab){
    if(tab==='actions')
      return '<div class="rq-empty">No tool calls in this session yet.<br>Edits, commands, reads, searches, egress, and to-dos appear here as the agent works.</div>';
    return '<div class="rq-empty">'+(TREE.observations.hooks
      ? 'No edits in this session yet.'
      : 'No tracked agent edits in this workspace yet.')+
      '<button data-demo="1">Try the demo — no agent session needed</button></div>';
  }
  function sumText(tab){ var n=TREE[tab].count||0;
    return tab==='actions'? (n+' tool call'+(n===1?'':'s')) : (n+' edit'+(n===1?'':'s')); }
  function renderTree(tab){
    var host=paneHost(tab); if(!host) return;
    var st=TREE[tab], body;
    // The same three states the Prompts tab keeps apart: nothing read yet · the read FAILED · this
    // session genuinely has none. A feed that could not be built says so rather than reading as an
    // empty session.
    if(st.err) body='<div class="rq-empty">Could not read this session’s '+tab+' — <b>'+esc(st.err)+'</b></div>';
    else if(!st.seen) body='<div class="rq-empty">Reading this session’s '+tab+'…</div>';
    else if(!(st.rows['']||[]).length) body=emptyHtml(tab);
    else body=rowsHtml(tab,'',0);
    host.innerHTML=
      '<div class="rq-head"><span class="rq-title">'+(tab==='actions'?'Actions':'Observations')+'</span>'+
      '<span class="rq-sum">'+((st.seen&&!st.err)? esc(sumText(tab)) : '')+'</span></div>'+
      '<div class="rq-desc">'+esc(TAB_DESC[tab])+'</div>'+
      '<div class="tl-list">'+body+'</div>';
    var rows=host.querySelectorAll('.tl-row');
    for(var i=0;i<rows.length;i++) rows[i].addEventListener('click', function(ev){
      var t=ev.target;
      var tw=(t&&t.closest)? t.closest('.tl-tw') : null;
      if(tw && tw.getAttribute('data-tw')){ ev.stopPropagation(); toggleRow(tab, tw.getAttribute('data-tw')); return; }
      var op=(t&&t.closest)? t.closest('.tl-op') : null;
      // A row button posts its VERB, never a command name: the host holds the node this row was built
      // from and decides which claudeObservatory.* command that verb is allowed to reach.
      if(op){ ev.stopPropagation(); vscode.postMessage({type:'rowAct', tab:tab, key:this.getAttribute('data-key'), verb:op.getAttribute('data-verb')}); return; }
      vscode.postMessage({type:'row', tab:tab, key:this.getAttribute('data-key')});
    });
    var demo=host.querySelector('[data-demo]');
    if(demo) demo.addEventListener('click', function(){ vscode.postMessage({type:'startDemo'}); });
    // Tree panes have no tour anchors; Prompts and Feed reapply their rings after rendering.
  }

  // --- the Feed renderer: conversation prose and tool-call blobs -------------------------------
  // mode comes from CORE and decides everything: live keeps polling on the host tick and the head
  // states the age of the newest evidence (never a realtime claim); audit is a RECORD — labelled as
  // one and no longer polled. Entries render as BLOBS, expanded by default: the head row carries
  // verb + target (a shell call shows dollar + its command), marks by shape, and the clock; an open
  // blob adds reasoning (only where it CHANGED), the tool note, the full multi-line command, and
  // the edit's bounded inline diff.
  // FCLOSED records the reader's fold toggles for the current Feed subject.
  var FCLOSED={};
  function ago(ts){ if(!ts) return '—'; var d=new Date(ts), n=new Date(); function p2(x){ return (x<10?'0':'')+x; }
    var MN=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if(d.getFullYear()===n.getFullYear() && d.getMonth()===n.getMonth() && d.getDate()===n.getDate()) return p2(d.getHours())+':'+p2(d.getMinutes())+':'+p2(d.getSeconds());
    if(d.getFullYear()===n.getFullYear()) return MN[d.getMonth()]+' '+d.getDate()+' '+p2(d.getHours())+':'+p2(d.getMinutes());
    return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate()); }
  function clock(ts){ var d=new Date(ts); function p(n){ return (n<10?'0':'')+n; } return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds()); }
  // Colour one SHELL command line — the TUI tokenizer (syntax.ts highlightShell), ported to HTML
  // spans. Mark only what is unambiguous: the program being run (the first word of the line and of
  // every command an operator starts), its flags, its quoted strings, and the operators joining the
  // commands. Everything else is an argument and stays plain — an argument mis-coloured as a flag is
  // a lie about what the agent ran. FOO=bar assignments do not spend program position.
  function shellHtml(line){
    var out='', i=0, program=true;
    while(i<line.length){
      var rest=line.slice(i);
      var ws=/^\\s+/.exec(rest); if(ws){ out+=esc(ws[0]); i+=ws[0].length; continue; }
      var op=/^(\\|\\||&&|>>|[|;&()<>])/.exec(rest);
      if(op){ out+='<span class="tlf-sh-op">'+esc(op[0])+'</span>'; i+=op[0].length; program=true; continue; }
      var q=/^(['"])/.exec(rest);
      if(q){ var quote=q[1], j=1;
        while(j<rest.length && rest[j]!==quote) j+=(rest[j]==='\\\\')?2:1;
        var tok=rest.slice(0, Math.min(j+1, rest.length));
        out+='<span class="tlf-sh-str">'+esc(tok)+'</span>'; i+=tok.length; program=false; continue; }
      var word=/^[^\\s|;&()<>'"]+/.exec(rest);
      if(!word){ out+=esc(line[i]); i+=1; continue; }
      var t=word[0];
      var assignment=program && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t);
      if(program && !assignment){ out+='<span class="tlf-sh-prog">'+esc(t)+'</span>'; program=false; }
      else if(!program && t.charAt(0)==='-') out+='<span class="tlf-sh-flag">'+esc(t)+'</span>';
      else out+=esc(t);
      i+=t.length;
    }
    return out;
  }
  function feedEntryHtml(e, key, prevReasoning, patchMap){
    var PM=patchMap||AGPATCH;
    if(e.kind==='output') return '<div class="tlf-out">'+esc(e.label)+'</div>';
    // THE AGENT'S OWN WORDS (2026-09-23, the Conversation tab folded in): a reply is prose in the
    // editor's normal face, rendered as markdown and never clipped; its thinking is the same block
    // folded by default (the twig opens it whole). The fold map records the reader's TOGGLE, so a
    // thinking row reads it inverted. the reasoning field here is the exact string the calls after it carry,
    // which is what keeps those rows from repeating this one (see the prevReasoning rule below).
    if(e.kind==='reasoning'){
      var thinking=e.reasoningKind==='thinking', ropen=thinking?!!FCLOSED[key]:!FCLOSED[key];
      var words=String(e.reasoning||'');
      var rh='<div class="tlf-blob'+(thinking?'':' said')+'" data-fkey="'+esc(key)+'" data-ts="'+String(e.ts||0)+'">'+
        '<div class="tlf-hrow"><span class="tlf-twig">'+(ropen?'▾':'▸')+'</span><span class="tlf-verb agent">'+(thinking?'thinking':'said')+'</span>'+
        '<span class="tlf-target">'+(ropen?'':'· '+(words.trim()?words.trim().split(/\\s+/).length:0)+' words')+'</span>'+
        '<span class="tlf-mark"></span><span class="tlf-ts">'+(e.ts?ago(e.ts):'')+'</span></div>';
      if(ropen) rh+='<div class="'+(thinking?'tlf-think':'tla-text')+' tla-md">'+mdHtml(words)+'</div>';
      if(e.detail) rh+='<div class="tlf-sub">'+esc(e.detail)+'</div>';
      return rh+'</div>';
    }
    // The user's own ask, on its grey band — the prompt-jump's landing pad (its ts IS the ask's start).
    if(e.kind==='prompt') return '<div class="tlf-blob user" data-fkey="'+esc(key)+'" data-ts="'+String(e.ts||0)+'">'+
      '<div class="tlf-hrow"><span class="tlf-verb">you</span><span class="tlf-target">'+esc(e.label||'')+'</span>'+
      '<span class="tlf-mark"></span><span class="tlf-ts">'+(e.ts?ago(e.ts):'')+'</span></div>'+
      '<div class="tlf-user-text">'+esc(e.promptText||'')+'</div></div>';
    var open=!FCLOSED[key];
    var isExec=e.category==='exec';
    // Display id is editId or previewId; only a real editId can be acted on elsewhere — here both
    // only ever OPEN things (the file in the editor, the diff), which is display.
    var did=(e.editId!=null?e.editId:e.previewId);
    var mark=e.ok===false?'<span class="tlf-mark err">✗</span>':(e.ok===true?'<span class="tlf-mark ok">✓</span>':(e.kind==='permission'?'<span class="tlf-mark pend">?</span>':'<span class="tlf-mark"></span>'));
    var h='<div class="tlf-blob'+(e.ok===false?' err':'')+(e.kind==='permission'?' perm':'')+'" data-fkey="'+esc(key)+'" data-ts="'+String(e.ts||0)+'">';
    // HEAD ROW — the verb in accent and the TARGET on the same row: the collapsed row is the one
    // that most needs the target. Shell calls read as shell calls — dollar + the command, SYNTAX
    // HIGHLIGHTED (program · flags · strings · operators), not a tool name. An edit's target is the
    // FILE, and clicking it opens that file's changes STACKED (like the Review list's filename).
    // A target that reads as a FILE PATH is a door: an edit's opens that file's changes stacked,
    // any other path opens the file itself. Queries and prose stay plain — a Grep pattern is not a path.
    var pathish=!!e.target && /^[^\\s"']+$/.test(e.target) && (e.target.indexOf('/')>=0 || /\\.[A-Za-z0-9]{1,8}$/.test(e.target));
    h+='<div class="tlf-hrow"><span class="tlf-twig">'+(open?'▾':'▸')+'</span>'+
      (isExec?'<span class="tlf-verb exec">$</span><span class="tlf-target mono" title="'+esc(e.target||e.label)+'">'+shellHtml(e.target||e.label)+'</span>'
             :'<span class="tlf-verb">'+esc(e.label)+'</span>'+
              (e.target?(did!=null
                ?'<span class="tlf-target tlf-file" data-openedit="'+did+'" title="Open this file’s changes, stacked — '+esc(e.target)+'">'+esc(e.target)+'</span>'
                :(pathish
                  ?'<span class="tlf-target tlf-file" data-openpath="'+esc(e.target)+'" title="Open this file — '+esc(e.target)+'">'+esc(e.target)+'</span>'
                  :'<span class="tlf-target" title="'+esc(e.target)+'">'+esc(e.target)+'</span>'))
               :'<span class="tlf-target"></span>'))+
      mark+'<span class="tlf-ts">'+(e.ts?ago(e.ts):'')+'</span></div>';
    if(open){
      // Reasoning is carried FORWARD per message by core, so consecutive calls share it — print it
      // only where it changed, labelled by its kind (thinking vs what the agent said out loud).
      if(e.reasoning && e.reasoning!==prevReasoning)
        h+='<div class="tlf-think tla-md"><span class="hd">'+(e.reasoningKind==='thinking'?'thinking':'said')+'</span>'+mdHtml(e.reasoning)+'</div>';
      if(e.note) h+='<div class="tlf-sub">'+esc(e.note)+'</div>';
      if(e.detail) h+='<div class="tlf-sub">'+esc(e.detail)+'</div>';
      // The full command, never clipped: the head shows the capped one-line form; the body owns the
      // rest — highlighted line by line, so a heredoc or a pipeline reads like it does in a terminal.
      if(isExec && e.cmd && e.cmd!==e.target){
        var cls=String(e.cmd).split('\\n');
        h+='<div class="tlf-cmd">';
        for(var ci=0;ci<cls.length;ci++) h+=(ci?'\\n':'')+shellHtml(cls[ci]);
        h+='</div>';
      }
      if(did!=null){
        // THE DIFF ITSELF, inline — the way the agent CLI's own transcript shows an edit. Bounded to
        // a preview; the overflow line is a door to the full diff. The +++/--- file header is skipped
        // (the head row already names the file); @@ hunks, adds and removes keep the CLI's colours.
        var patch=PM[did];
        if(patch){
          var pls=String(patch).split('\\n'), shown=0, total=0, dh='';
          for(var pi=0;pi<pls.length;pi++){
            var pl=pls[pi];
            if(pi<2 || pl.indexOf('+++')===0 || pl.indexOf('---')===0 || pl.indexOf('\\ No newline')===0) continue;
            if(pl==='' && pi===pls.length-1) continue;
            total++;
            if(shown>=14) continue;
            shown++;
            var cls2 = pl.indexOf('@@')===0?'hunk':(pl.charAt(0)==='+'?'add':(pl.charAt(0)==='-'?'rem':'ctx'));
            dh+='<div class="tlf-dl '+cls2+'">'+esc(pl)+'</div>';
          }
          if(dh){
            h+='<div class="tlf-diff">'+dh+
              (total>shown?'<button class="tlf-diffbtn" data-edit="'+did+'">+'+(total-shown)+' more line'+((total-shown)===1?'':'s')+' — view the full diff</button>':'')+
              '</div>';
          }
        }
        // The edit item's two doors: the FILE with its edits in the editor (the primary — same as
        // clicking the target above), and the unit's own diff.
        h+='<button class="tlf-diffbtn" data-openedit="'+did+'">⧉ open this file’s changes · stacked</button>'+
           '<button class="tlf-diffbtn" data-edit="'+did+'">view the diff — edit #'+did+'</button>';
      }
    }
    return h+'</div>';
  }
  // The Feed payload — the selected session or Overview subject's activity.
  var AGFEED=null, AGPATCH={}, AGFEEDSESS='', AGHEADFP='', AGFOLLOWED='', AGSCROLLTS=0, AGSCROLLMODE='start';
  var BT=String.fromCharCode(96);
  function mdSpansHtml(text){
    var out='', i=0, plain='';
    function flush(){ if(plain){ out+=esc(plain); plain=''; } }
    while(i<text.length){
      var ch=text.charAt(i);
      if(ch===BT){
        var ce=text.indexOf(BT, i+1);
        if(ce>i){ flush(); out+='<code class="tla-code">'+esc(text.slice(i+1,ce))+'</code>'; i=ce+1; continue; }
      }
      if(ch==='*'&&text.charAt(i+1)==='*'){
        var be=text.indexOf('**', i+2);
        if(be>i+1){ flush(); out+='<b>'+mdSpansHtml(text.slice(i+2,be))+'</b>'; i=be+2; continue; }
      }
      if((ch==='*'||ch==='_')&&text.charAt(i+1)!==ch){
        var ie=text.indexOf(ch, i+1);
        if(ie>i+1&&text.charAt(i+1)!==' '&&text.charAt(ie-1)!==' '){ flush(); out+='<i>'+mdSpansHtml(text.slice(i+1,ie))+'</i>'; i=ie+1; continue; }
      }
      plain+=ch; i++;
    }
    flush();
    return out;
  }
  function mdIsTRow(l){ var t=l.trim(); return t.charAt(0)==='|'&&t.indexOf('|',1)>0; }
  function mdIsTSep(l){ var t=l.trim(); return mdIsTRow(l)&&/-/.test(t)&&/^[|\\s:-]+$/.test(t); }
  function mdCells(l){ var t=l.trim();
    if(t.charAt(0)==='|') t=t.slice(1);
    if(t.charAt(t.length-1)==='|') t=t.slice(0,-1);
    var out=t.split('|'), i=0;
    for(i=0;i<out.length;i++) out[i]=out[i].trim();
    return out; }
  function mdHtml(text){
    var lines=String(text==null?'':text).split('\\n');
    var h='', fence=false;
    for(var li=0; li<lines.length; li++){
      var l=lines[li];
      if(l.replace(/^\\s*/,'').indexOf(BT+BT+BT)===0){ fence=!fence; h+='<div class="tla-mdfence">'+esc(l)+'</div>'; continue; }
      if(fence){ h+='<div class="tla-mdcode">'+esc(l)+'</div>'; continue; }
      // Tables — this renderer holds the whole block, so it builds a REAL
      // table: consecutive pipe rows, the header decided by the separator row beneath it.
      if(mdIsTRow(l)&&!fence){
        var rows=[]; var te=li;
        while(te<lines.length&&mdIsTRow(lines[te])){ rows.push(lines[te]); te++; }
        var hasHead=rows.length>1&&mdIsTSep(rows[1]);
        var t='<table class="tla-mdt">';
        for(var ri=0;ri<rows.length;ri++){
          if(mdIsTSep(rows[ri])) continue;
          var tag=(hasHead&&ri===0)?'th':'td';
          var cs=mdCells(rows[ri]);
          t+='<tr>';
          for(var ci=0;ci<cs.length;ci++) t+='<'+tag+'>'+mdSpansHtml(cs[ci])+'</'+tag+'>';
          t+='</tr>';
        }
        h+=t+'</table>';
        li=te-1;
        continue;
      }
      var hm=/^(#{1,6})\\s+(\\S.*|)$/.exec(l);
      if(hm){ h+='<div class="tla-mdh"><b>'+mdSpansHtml(hm[2])+'</b></div>'; continue; }
      var bm=/^(\\s*)([-*•]|\\d{1,2}[.)])\\s+(\\S.*|)$/.exec(l);
      if(bm){ h+='<div class="tla-mdli" style="padding-left:'+(8+Math.floor(bm[1].length/2)*10)+'px">• '+mdSpansHtml(bm[3])+'</div>'; continue; }
      var qm=/^>\\s?(.*)$/.exec(l);
      if(qm){ h+='<div class="tla-mdq">'+mdSpansHtml(qm[1])+'</div>'; continue; }
      h+=(l.length? '<div>'+mdSpansHtml(l)+'</div>' : '<div class="tla-mdgap"></div>');
    }
    return h;
  }
  /* The ↓ newest pill IS the way back to the tail, so it exists only while the reader has left it —
     the same 6px band the tail-follow uses below. Parked permanently it does nothing and floats over
     the last line. (TUI: the hint only on a scrolled session-detail; JetBrains: FeedPanel's link.) */
  function syncJump(body,jump){
    if(!body||!jump) return;
    var want=(body.scrollTop+body.clientHeight<body.scrollHeight-6)?'':'none';
    if(jump.style.display!==want) jump.style.display=want; // this runs per scroll event — no needless invalidation
  }
  var FEEDFP='';
  function renderFeedTab(){
    var host=paneHost('feed'); if(!host)return;
    var fp=AGFEEDSESS+':'+JSON.stringify(AGFEED)+':'+JSON.stringify(AGPATCH)+':'+JSON.stringify(FCLOSED);
    if(fp===FEEDFP&&host.querySelector('#tlf-body'))return;
    FEEDFP=fp;
    var old=host.querySelector('#tlf-body'), at=old?old.scrollTop:0, tail=!old||old.scrollTop+old.clientHeight>=old.scrollHeight-6;
    var h='',prev=Object.create(null),lastTs=-1,run=0;
    if(AGFEED&&AGFEED.entries) for(var i=0;i<AGFEED.entries.length;i++){
      var entry=AGFEED.entries[i],agent=entry.detail||'';
      run=entry.ts===lastTs?run+1:0;lastTs=entry.ts;
      h+=feedEntryHtml(entry,AGFEEDSESS+':'+entry.ts+':'+run,prev[agent],AGPATCH);
      if(entry.reasoning!=null)prev[agent]=entry.reasoning;
    }
    var heading=esc(AGFOLLOWED||(AGFEED&&AGFEED.title)||'Session activity'), framing='';
    if(AGFEED){
      var live=AGFEED.mode==='live', stamp=AGFEED.lastTs?ago(AGFEED.lastTs):'no activity recorded';
      heading+=' · '+(live?'● live':'▣ audit log')+' · '+(live?'updated ':'last activity ')+esc(stamp);
      if(AGFEED.recap) framing+='<div class="tla-meta" style="white-space:pre-wrap;overflow-wrap:anywhere" title="'+esc(AGFEED.recapSource?'recap · from the '+AGFEED.recapSource:'recap')+'">'+esc(AGFEED.recap)+'</div>';
      if(AGFEED.note) framing+='<div class="tla-meta" style="white-space:pre-wrap;overflow-wrap:anywhere">'+esc(AGFEED.note)+'</div>';
      if(AGFEED.truncated>0) framing+='<button class="tlf-diffbtn" data-feedmore="1">… '+Number(AGFEED.truncated)+' earlier entr'+(AGFEED.truncated===1?'y':'ies')+' not shown — load more</button>';
    }
    host.innerHTML='<div class="rq-head" style="white-space:normal;overflow-wrap:anywhere">'+heading+'</div><div class="tla-bodywrap"><div class="tlf-body" id="tlf-body">'+framing+(h||(!AGFEED||!AGFEED.note?'<div class="rq-empty">No activity available for this selection.</div>':''))+'</div><button class="tlf-jump" id="tlf-jump" data-feedjump="1" style="display:none">↓ newest</button></div>';
    host.onclick=function(ev){
      var t=ev.target,b=t&&t.closest?t.closest('[data-feedmore],[data-feedjump],[data-openedit],[data-edit],[data-openpath],.tlf-twig,.tlf-hrow'):null;if(!b)return;
      if(b.hasAttribute('data-feedjump')){var fb=host.querySelector('#tlf-body');if(fb)fb.scrollTop=fb.scrollHeight;syncJump(fb,host.querySelector('#tlf-jump'));}
      else if(b.hasAttribute('data-feedmore'))vscode.postMessage({type:'agentFeedMore'});
      else if(b.classList&&(b.classList.contains('tlf-twig')||b.classList.contains('tlf-hrow'))){var blob=b.closest('[data-fkey]'),key=blob&&blob.getAttribute('data-fkey');if(key){FCLOSED[key]=!FCLOSED[key];renderFeedTab();}}
      else if(b.hasAttribute('data-openpath'))vscode.postMessage({type:'openPath',path:b.getAttribute('data-openpath')});
      else vscode.postMessage({type:b.hasAttribute('data-openedit')?'agentOpenEditFile':'agentOpenEdit',id:Number(b.getAttribute('data-openedit')||b.getAttribute('data-edit'))});
    };
    var body=host.querySelector('#tlf-body');if(body)body.scrollTop=tail&&!AGSCROLLTS?body.scrollHeight:at;
    if(AGSCROLLTS&&body&&body.querySelectorAll){
      var nodes=body.querySelectorAll('[data-ts]'),hit=null;
      for(var ni=0;ni<nodes.length;ni++){
        var ts=Number(nodes[ni].getAttribute('data-ts'));
        if(AGSCROLLMODE==='end'){if(ts<AGSCROLLTS)hit=nodes[ni];}
        else if(ts>=AGSCROLLTS){hit=nodes[ni];break;}
      }
      if(!hit&&nodes.length)hit=AGSCROLLMODE==='end'?nodes[0]:nodes[nodes.length-1];
      if(hit){hit.scrollIntoView({block:'start'});AGSCROLLTS=0;}
    }
    // The pill only while the reader is away from the tail. The host is rebuilt on every render, so
    // both are re-bound here.
    if(body)body.onscroll=function(){syncJump(body,host.querySelector('#tlf-jump'));};
    syncJump(body,host.querySelector('#tlf-jump'));
    reTour();
  }
  var GROUP_BUILT=null; // 'on' once the grouped columns exist in the DOM; null while solo tabs are shown
  // A LAYOUT SWITCH moves every member into a fresh host, but the built-once caches (the feed body,
  // the agent fingerprints) describe the OLD host's DOM — matching them against a brand-new empty
  // wrap rendered both tabs blank until the next data change, and the abandoned wrap kept duplicate
  // element ids alive. Reset them wherever the layout is invalidated.
  function resetLayoutCaches(){ FEEDFP=''; }
  function badgeOf(k){
    if(k==='prompts') return (RQ&&RQ.summary)? String(RQ.summary.total) : '';
    if(k==='feed') return AGFEED&&AGFEED.entries?String(AGFEED.entries.length):'';
    var st=TREE[k]; return (st.seen&&!st.err)? String(st.count) : ''; }
  function renderTabs(){
    var host=document.getElementById('tl-tabs'); if(!host) return;
    var h='';
    if(GROUPED){
      // One tab, because all four are on screen. It still names them, in the order the columns run.
      h+='<button class="tl-tab on" data-tab="g" title="All four side by side — each column has its own header; drag a divider to resize a pair, or fold a column to a rail.">'+
        'Feed · Prompts · Observations · Actions</button>';
    } else {
      for(var i=0;i<TABS.length;i++){ var k=TABS[i][0], b=badgeOf(k);
        h+='<button class="tl-tab'+(TAB===k?' on':'')+'" data-tab="'+k+'" title="'+esc(TAB_TIP[k])+'">'+TABS[i][1]+
          (b!==''?('<span class="tl-tn">'+esc(b)+'</span>'):'')+'</button>'; }
    }
    host.innerHTML=h;
    var bs=host.querySelectorAll('.tl-tab');
    for(var q=0;q<bs.length;q++) bs[q].addEventListener('click', function(){
      var k=this.getAttribute('data-tab');
      if(k==='g' || !isTab(k)) return; // the group tab already shows everything it names
      TAB=k; saveState(); applyPanes(); renderTabs(); renderAll(); tellHost(); });
    var tg=document.getElementById('tl-grouptabs');
    if(tg){ tg.classList.toggle('on', GROUPED); tg.setAttribute('aria-pressed', GROUPED?'true':'false'); }
  }
  function applyPanes(){
    for(var i=0;i<TABS.length;i++){ var el=document.getElementById('tl-pane-'+TABS[i][0]);
      if(el) el.style.display=(!GROUPED && TAB===TABS[i][0])?'flex':'none'; }
    var g=document.getElementById('tl-group'); if(g) g.style.display=GROUPED?'flex':'none';
  }
  /** Write each expanded column's share as its flex-grow weight. A rail is sized by CSS and exempt from
   *  both this and the minimum width — it is not showing content to clip. */
  function applyColWidths(){
    for(var i=0;i<TABS.length;i++){ var el=document.getElementById('tl-gc-'+TABS[i][0]);
      if(el&&el.style&&el.style.setProperty) el.style.setProperty('--tl-cw', String(COLW[i])); } }
  function paintColBadges(){
    for(var i=0;i<TABS.length;i++){ var el=document.getElementById('tl-gb-'+TABS[i][0]);
      if(el) el.textContent=badgeOf(TABS[i][0]); } }
  /**
   * Fold a column to its rail, or bring it back.
   *
   * The LAST expanded column never folds: a group with every column folded is an empty pane, and the
   * only affordance to undo it would be the rail the reader just lost track of. The button is not
   * rendered in that case either — this guard is the second line, for a click that raced a repaint.
   *
   * The column's WEIGHT is deliberately untouched, so expanding restores the width the reader set rather
   * than an equal share; while folded the rail is sized by CSS and the siblings divide the rest.
   */
  function toggleCol(k){
    if(colOpen(k) && openCols()<=1) return;
    if(colOpen(k)) COLC[k]=1; else delete COLC[k];
    GROUP_BUILT=null; resetLayoutCaches(); saveState(); renderTabs(); ensureGroup(); renderAll(); tellHost();
  }
  function renderGroupCols(){
    var host=document.getElementById('tl-group'); if(!host) return;
    var h='', n=openCols(), seenOpen=false;
    for(var i=0;i<TABS.length;i++){ var k=TABS[i][0], nm=TABS[i][1];
      if(!colOpen(k)){
        // The rail still NAMES the column and carries its badge, and the whole thing is the button that
        // brings it back — a column that vanished with no affordance is a bug nobody can describe.
        h+='<div class="tl-groupcol rail" id="tl-gc-'+k+'">'+
          '<button class="tl-rail" id="tl-cc-'+k+'" title="'+esc(nm+' — folded. Click to bring it back at the width you set.')+'">'+
          '<i class="codicon codicon-chevron-right"></i><span>'+nm+'</span>'+
          '<span class="tl-tn" id="tl-gb-'+k+'"></span></button></div>';
        continue;
      }
      h+='<div class="tl-groupcol" id="tl-gc-'+k+'">'+
        (seenOpen? '<div class="tl-cgutter" id="tl-cg-'+k+'" title="Drag to resize these columns — double-click to split them evenly"></div>':'')+
        '<div class="tl-ghead" title="'+esc(TAB_TIP[k])+'">'+nm+'<span class="tl-tn" id="tl-gb-'+k+'"></span>'+
        (n>1? '<button class="tl-cfold" id="tl-cc-'+k+'" title="Fold '+nm+' to a rail — the other columns take the space, and it comes back at the width you set"><i class="codicon codicon-chevron-left"></i></button>':'')+
        '</div><div class="tl-host" id="tl-g-'+k+'"></div></div>';
      seenOpen=true;
    }
    host.innerHTML=h;
    wireGroupCols();
    applyColWidths();
  }
  /** Wire the dividers and fold buttons. Called once per column build, like the columns themselves. */
  function wireGroupCols(){
    for(var m=0;m<TABS.length;m++) (function(m){
      var k=TABS[m][0];
      var fold=document.getElementById('tl-cc-'+k);
      if(fold) fold.addEventListener('click', function(ev){ if(ev&&ev.stopPropagation) ev.stopPropagation(); toggleCol(k); });
      var gut=document.getElementById('tl-cg-'+k);
      if(!gut) return;
      // The pair this divider sizes is (nearest EXPANDED column to its left, this one): a folded rail
      // between them is skipped rather than dragged, and with nothing expanded to the left there is no pair.
      var p=-1; for(var q=m-1;q>=0;q--) if(colOpen(TABS[q][0])){ p=q; break; }
      if(p<0) return;
      var a=document.getElementById('tl-gc-'+TABS[p][0]), b=document.getElementById('tl-gc-'+k);
      if(!a||!b) return;
      function setFrom(ev){
        var ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
        var span=(rb.right-ra.left)||1, sum=COLW[p]+COLW[m];
        // The floor, as a fraction of THIS pair. Capped at .45 so a pair too narrow to hold two floors
        // still leaves a usable range instead of an impossible clamp (below the breakpoint the whole
        // group stacks and the dividers are hidden anyway).
        var floor=Math.min(0.45, COL_MIN/span);
        var frac=(ev.clientX-ra.left)/span;
        if(!isFinite(frac)) return;
        frac=Math.max(floor, Math.min(1-floor, frac));
        COLW[p]=sum*frac; COLW[m]=sum*(1-frac);
        applyColWidths();
      }
      gut.addEventListener('pointerdown', function(ev){
        if(ev&&ev.preventDefault) ev.preventDefault();
        gut.classList.add('drag');
        try{ gut.setPointerCapture(ev.pointerId); }catch(e){}
        function move(e2){ setFrom(e2); }
        function up(){
          gut.classList.remove('drag');
          try{ gut.releasePointerCapture(ev.pointerId); }catch(e){}
          gut.removeEventListener('pointermove', move); gut.removeEventListener('pointerup', up); gut.removeEventListener('pointercancel', up);
          saveState();
        }
        gut.addEventListener('pointermove', move); gut.addEventListener('pointerup', up); gut.addEventListener('pointercancel', up);
      });
      gut.addEventListener('dblclick', function(){ var s=COLW[p]+COLW[m]; COLW[p]=s/2; COLW[m]=s/2; applyColWidths(); saveState(); });
    })(m);
  }
  /** Build the grouped columns once per mode, or re-assert the widths on a later tick. Leaving grouped
   *  mode blanks the pane so ids inside it (the tour's #rq-list) never exist twice. */
  function ensureGroup(){
    var g=document.getElementById('tl-group');
    if(!GROUPED){ GROUP_BUILT=null; if(g) g.innerHTML=''; return; }
    if(GROUP_BUILT!=='on'){ renderGroupCols(); GROUP_BUILT='on'; }
    else applyColWidths();
    paintColBadges();
  }
  /** Render only what is on screen. */
  function renderAll(){
    if(shows('prompts')) renderPrompts();
    if(shows('observations')) renderTree('observations');
    if(shows('actions')) renderTree('actions');
    if(shows('feed')) renderFeedTab();
  }
  /**
   * Tell the host which tabs are on screen. It serves ONLY those: building the Actions root walks every
   * sibling worktree for live conflicts (~100 ms of synchronous extension-host work), and paying for
   * that while the reader is looking at Prompts is exactly what the tree's visible-only refresh avoided.
   */
  function tellHost(){ vscode.postMessage({type:'view', tab:TAB, grouped:GROUPED,
    shows:{ prompts:shows('prompts'), observations:shows('observations'), actions:shows('actions'), feed:shows('feed') } }); }

  // The Prompts tab draws its OWN heading, description and list into whatever host it currently occupies
  // (the solo pane, or its column in grouped mode), so the tab has exactly one renderer in either layout
  // and its summary + clear-scope button follow the list instead of being stranded in fixed chrome.
  function renderPrompts(){
    var host=paneHost('prompts'); if(!host) return;
    var body='', sum='';
    // Three states kept apart, as everywhere else in this product: nothing read yet · the CLI answered
    // nothing · this session genuinely has no recorded ask. Only the last is an observation.
    if(!RQ){
      body='<div class="rq-empty">'+(SEEN
        ? 'No answer for <b>prompts</b> — the <b>oak</b> CLI on PATH didn’t return them (a CLI older than 0.8.8 has no <code>prompts</code> command).'
        : 'Reading this session’s prompts…')+'</div>';
    } else {
      var rs=RQ.prompts||[], s=RQ.summary||{total:rs.length,withEdits:0,edits:0};
      sum = s.total+' ask'+(s.total===1?'':'s')+' · '+s.withEdits+' with edits · '+s.edits+' edit'+(s.edits===1?'':'s');
      if(!rs.length) body='<div class="rq-empty">No prompts recorded yet — this fills in with every prompt you send in this session.</div>';
      else {
        // Newest ask FIRST: it is the one you are still thinking about. Each row keeps its own #index, so
        // the chronological numbering a person counts by is never renumbered by the sort.
        for(var i=rs.length-1;i>=0;i--){ var r=rs[i]; var sel=(SEL===r.id); var open=!!EXP[r.id];
          body+='<div class="rq-row'+(sel?' sel':'')+'" data-idx="'+i+'" data-id="'+esc(r.id)+'">'+
            '<div class="rq-facts"><span class="rq-ix">#'+r.index+'</span>'+
            (r.endTs?'':'<span class="rq-live" title="this is the ask still being answered">now</span>')+
            facts(r)+
            '<span class="rq-meta" title="'+(r.endTs?'from this ask to the next one':'still being answered — elapsed so far')+'">'+(r.endTs?'':'~')+fmtDur(r.durationMs)+'</span>'+
            // Two row buttons: put the ask under review (the Review view lists its changes; diffs open
            // in the editor), and expand the agent's reply to it.
            '<button class="rq-review'+(sel?' on':'')+'" data-rev="'+esc(r.id)+'" title="'+(sel?'Under review — open the Review view':'Review this prompt: the Review view lists its changes, diffs open in the editor')+'">'+(sel?'▸ reviewing':'review')+'</button>'+
            '<button class="rq-exp'+(open?' on':'')+'" data-exp="'+esc(r.id)+'" title="'+(open?'Hide':'Read')+' the agent’s response to this prompt">'+(open?'▾':'▸')+' response</button>'+
            '</div>'+
            // The ask itself, whole and wrapped — never clipped.
            '<div class="rq-ask">'+esc(r.text||r.title)+'</div>'+
            (open?('<div class="rq-resp">'+respHtml(r)+'</div>'):'')+
            '</div>';
        }
      }
    }
    host.innerHTML=
      '<div class="rq-head"><span class="rq-title">Prompts</span><span class="rq-sum" id="rq-sum">'+esc(sum)+'</span>'+
      (SEL? '<button class="rq-clear" id="rq-clear" title="Clear the prompt scope — the Overview goes back to the whole session">clear scope</button>' : '')+
      '</div>'+
      '<div class="rq-desc">'+esc(TAB_DESC.prompts)+'</div>'+
      '<div class="rq-list" id="rq-list">'+body+'</div>';
    var list=host.querySelector('.rq-list');
    var rows=list? list.querySelectorAll('.rq-row') : [];
    for(var q=0;q<rows.length;q++){
      rows[q].addEventListener('click', function(ev){
        // The review button first: it PICKS the ask (never toggles it off) and opens the Review view.
        var rv=ev.target && ev.target.closest ? ev.target.closest('.rq-review') : null;
        if(rv){ ev.stopPropagation(); SEL=rv.getAttribute('data-rev'); renderPrompts(); renderTabs(); vscode.postMessage({type:'review', id:SEL}); return; }
        // A click on the expand caret toggles the response, never the scope selection.
        var e=ev.target && ev.target.closest ? ev.target.closest('.rq-exp') : null;
        if(e){ ev.stopPropagation(); toggleResp(e.getAttribute('data-exp')); return; }
        var id=this.getAttribute('data-id');
        SEL = (SEL===id)? null : id;            // clicking the selected ask again clears the scope
        renderPrompts(); renderTabs();
        vscode.postMessage({type:'select', id:SEL});
      });
    }
    var clr=host.querySelector('.rq-clear');
    if(clr) clr.addEventListener('click', function(){ SEL=null; renderPrompts(); vscode.postMessage({type:'select', id:null}); });
    reTour(); // this repaint just replaced the node a tour step may be ringing
  }

  // --- the session selector -------------------------------------------------------------------------
  // SESSROWS are the rows the HOST chose: the sessions still being written, plus the reviewed one whatever
  // its age, already in display order and already stamped active — the 60 s liveness rule is core's
  // (FLEET_ACTIVE_MS) and is never re-derived here. Picking one switches the WHOLE observatory, not this
  // window's scope, which is why it goes through a command rather than a local filter.
  // (No backticks in this region: it is inside the TS template literal, which they would close.)
  var SESSROWS=[], SESSCUR='', SESSOPEN=false, SESSSEEN=false;
  var SESSQ='', SESSSORT='new', SESSACT=false;
  // Conversation search: {q, hits|null} — null hits = the host is still searching.
  var SEARCHRES=null;
  function ago(ts){ if(!ts) return '—'; var d=new Date(ts), n=new Date(); function p2(x){ return (x<10?'0':'')+x; }
    var MN=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if(d.getFullYear()===n.getFullYear() && d.getMonth()===n.getMonth() && d.getDate()===n.getDate()) return p2(d.getHours())+':'+p2(d.getMinutes())+':'+p2(d.getSeconds());
    if(d.getFullYear()===n.getFullYear()) return MN[d.getMonth()]+' '+d.getDate()+' '+p2(d.getHours())+':'+p2(d.getMinutes());
    return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate()); }
  function sessName(r){ return (r&&r.title)? r.title : ('session '+String((r&&r.id)||'').slice(0,8)); }
  function sessWhere(r){ return r.workspace||'Unknown workspace'; }
  function sessCurRow(){ for(var i=0;i<SESSROWS.length;i++) if(String(SESSROWS[i].id)===String(SESSCUR)) return SESSROWS[i]; return null; }
  function renderSess(){
    var dot=document.getElementById('rq-sdot'), nm=document.getElementById('rq-sname'),
        chip=document.getElementById('rq-schip'), list=document.getElementById('rq-slist');
    if(!dot||!nm||!chip||!list) return;
    var r=sessCurRow(), live=!!(r&&r.active);
    dot.className='rq-sdot'+(live?' live':'');
    dot.textContent=live?'●':'○';
    // With no row for it (no listing yet, or a session pinned from another workspace) the chip still names
    // the id it is reviewing — an unnamed selector over a session that IS being reviewed says nothing.
    nm.textContent = SESSCUR? sessName(r||{id:SESSCUR}) : (SESSSEEN? 'no session selected' : 'session —');
    // Raised hands ride the chip: how many sessions are waiting on the reader.
    var waitN=0;
    for(var wi=0;wi<SESSROWS.length;wi++){ var wa=SESSROWS[wi].attention;
      if(wa&&wa.kind!=='idle-done') waitN++; }
    var wEl=document.getElementById('rq-swait');
    if(wEl){ wEl.textContent=waitN?('⚠ '+waitN):''; wEl.style.display=waitN?'':'none'; }
    // The supplied title, full id and conversation recency.
    chip.title=(r&&r.title? r.title+' — ':'')+'session '+(SESSCUR||'—')+
      (r? ' · '+(live?'active · ':'')+ago(r.lastActiveMs):'')+' · click to switch session';
    if(!SESSOPEN){ list.hidden=true; list.innerHTML=''; return; }
    // ONE string per paint, bar + rows + footer — except while the reader is TYPING in the
    // search box: a full rebuild would blow the input focus mid-keystroke, so only the rows
    // container updates then (the input path below calls renderSessRowsOnly directly).
    var focused=document.activeElement&&document.activeElement.id==='rq-sq';
    if(focused){ renderSessRowsOnly(); list.hidden=false; return; }
    var sortLbl=SESSSORT==='old'?'Oldest':SESSSORT==='az'?'Name A→Z':SESSSORT==='za'?'Name Z→A':'Newest';
    var fltN=(SESSACT?1:0);
    list.innerHTML=
      '<div class="rq-sbar">'+
        '<input id="rq-sq" placeholder="search title, id, workspace…" value="'+esc(SESSQ)+'">'+
        '<span class="rq-drop-anchor"><button class="rq-nb'+(fltN?' on':'')+'" id="rq-sfilter" title="Filter the sessions list">Filter'+(fltN?' ('+fltN+')':'')+'</button>'+
          '<div class="rq-filterdrop" id="rq-filterdrop" hidden>'+
            '<div class="rq-fd-row" data-sflt="act"><span class="rq-fd-ck">'+(SESSACT?'✓':'')+'</span>Active now</div>'+
          '</div></span>'+
        '<span class="rq-drop-anchor"><button class="rq-nb" id="rq-ssort" title="Sort order — newest / oldest / name A→Z / name Z→A">Sort: '+sortLbl+'</button>'+
          '<div class="rq-filterdrop" id="rq-sortdrop" hidden>'+
            '<div class="rq-fd-row" data-ssort="new"><span class="rq-fd-ck">'+(SESSSORT==='new'?'✓':'')+'</span>Newest</div>'+
            '<div class="rq-fd-row" data-ssort="old"><span class="rq-fd-ck">'+(SESSSORT==='old'?'✓':'')+'</span>Oldest</div>'+
            '<div class="rq-fd-row" data-ssort="az"><span class="rq-fd-ck">'+(SESSSORT==='az'?'✓':'')+'</span>Name A→Z</div>'+
            '<div class="rq-fd-row" data-ssort="za"><span class="rq-fd-ck">'+(SESSSORT==='za'?'✓':'')+'</span>Name Z→A</div>'+
          '</div></span>'+
      '</div>'+
      '<div id="rq-srows">'+sessRowsHtml()+'</div>'+
      '<button class="rq-srow" data-sall="1" title="Every session on this machine, from every workspace — the Overview’s Sessions tab is the full browser">'+
        '<span class="rq-sdot">☰</span><span class="rq-sname">All sessions…</span></button>';
    list.hidden=false;
    if(!list.addEventListener) return; // a stubbed DOM (tests) renders the string and stops here
    if(!list.__wired){
      list.__wired=1;
      list.addEventListener('click', function(ev){
        var t=ev.target;
        // Delete BEFORE switch: the 🗑 sits inside the row's [data-sid] button, so its click must be
        // claimed here first. The dropdown stays OPEN — the delete's refresh re-posts the rows and the
        // deleted one drops out in place.
        var del=(t&&t.closest)? t.closest('[data-sdel]') : null;
        if(del){ ev.stopPropagation(); vscode.postMessage({type:'deleteSession', id:del.getAttribute('data-sdel')}); return; }
        var ss=(t&&t.closest)? t.closest('[data-ssearch]') : null;
        if(ss){ var sq=ss.getAttribute('data-ssearch')||''; SEARCHRES={q:sq,hits:null}; renderSessRowsOnly(); vscode.postMessage({type:'searchConversations', q:sq}); return; }
        var b=(t&&t.closest)? t.closest('[data-sid]') : null;
        if(b){ SESSOPEN=false; renderSess(); vscode.postMessage({type:'pickSession', id:b.getAttribute('data-sid')}); return; }
        if((t&&t.closest)? t.closest('[data-sall]') : null){ SESSOPEN=false; renderSess(); vscode.postMessage({type:'allSessions'}); return; }
        var sr=(t&&t.closest)? t.closest('[data-ssort]') : null;
        if(sr){ SESSSORT=sr.getAttribute('data-ssort'); renderSess(); return; }
        var sf=(t&&t.closest)? t.closest('[data-sflt]') : null;
        if(sf){ var w=sf.getAttribute('data-sflt'); if(w==='act') SESSACT=!SESSACT; renderSess(); return; }
        var so=(t&&t.closest)? t.closest('#rq-ssort') : null;
        if(so){ var sd=document.getElementById('rq-sortdrop'); var fd0=document.getElementById('rq-filterdrop'); if(fd0) fd0.hidden=true; if(sd) sd.hidden=!sd.hidden; return; }
        var sa=(t&&t.closest)? t.closest('#rq-sfilter') : null;
        if(sa){ var fd=document.getElementById('rq-filterdrop'); var sd0=document.getElementById('rq-sortdrop'); if(sd0) sd0.hidden=true; if(fd) fd.hidden=!fd.hidden; return; }
      });
      list.addEventListener('input', function(ev){
        var t=ev.target;
        if(t&&t.id==='rq-sq'){ SESSQ=t.value||''; renderSessRowsOnly(); }
      });
      list.addEventListener('keydown', function(ev){
        var t=ev.target; if(!t||t.id!=='rq-sq') return;
        // Enter opens the first matching session; with none, it runs the conversation search instead.
        if(ev.key==='Enter'){ var f=list.querySelector('#rq-srows [data-sid]')||list.querySelector('#rq-srows [data-ssearch]'); if(f&&f.click) f.click(); ev.preventDefault(); }
        if(ev.key==='Escape'){ SESSOPEN=false; renderSess(); ev.preventDefault(); }
      });
    }
  }
  /** The dropdown's rows as ONE html string — search/sort/filter applied, current always kept. */
  function sessRowsHtml(){
    var q=(SESSQ||'').toLowerCase();
    var out=[];
    for(var i=0;i<SESSROWS.length;i++){ var s=SESSROWS[i];
      var isCur=(String(s.id)===String(SESSCUR));
      if(SESSACT&&!s.active&&!isCur) continue;
      if(q&&!isCur){
        var hay=((s.title||'')+' '+s.id+' '+(s.workspace||'')+' '+(s.model||'')+' '+(s.agent||'')).toLowerCase();
        if(hay.indexOf(q)<0) continue;
      }
      out.push(s);
    }
    if(SESSSORT!=='new') out.sort(function(a,b){
      if(String(a.id)===String(SESSCUR)) return -1;
      if(String(b.id)===String(SESSCUR)) return 1;
      if(SESSSORT==='old') return (a.lastActiveMs||0)-(b.lastActiveMs||0);
      var an=String(a.title||a.id).toLowerCase(), bn=String(b.title||b.id).toLowerCase();
      var c=an<bn?-1:an>bn?1:0;
      return SESSSORT==='za'?-c:c;
    });
    var h='';
    function waitOf(s){ var a=s.attention; return (a&&a.kind&&a.kind!=='idle-done')? a : null; }
    function srow(s){ var on=(String(s.id)===String(SESSCUR)), wa=waitOf(s);
      return '<button class="rq-srow'+(on?' on':'')+(wa?' hand':'')+'" data-sid="'+esc(s.id)+'" title="'+
        esc(sessName(s)+' — session '+s.id+' · '+sessWhere(s)+' · '+(s.active?'active · ':'')+ago(s.lastActiveMs))+'">'+
        '<span class="rq-sdot'+(wa?' wait':(s.active?' live':''))+'">'+(wa?'⚠':(s.active?'●':'○'))+'</span>'+
        '<span class="rq-sname">'+esc(sessName(s))+'</span>'+
        // The raised hand said in full (2026-09-15): what kind of wait, on what, for how long.
        (wa?'<span class="rq-shand" title="What this session is waiting on, and for how long">'+esc(wa.kind+(wa.message?' · '+wa.message:'')+(wa.ts?' · '+fmtDur(Date.now()-wa.ts):''))+'</span>':'')+
        ((s.agent&&s.agent!=='claude')?'<span class="rq-agentbadge" title="The agent that ran this session">'+esc(s.agent)+'</span>':'')+
        '<span class="rq-smodel">'+esc(s.model||'model unknown')+'</span>'+
        '<span class="rq-sago">'+(s.edits||0)+(s.edits===1?' edit · ':' edits · ')+fmtTok(s.tokens||0)+' tok · '+fmtDur(s.durationMs||0)+'</span>'+ 
        '<span class="rq-sws">'+esc(s.workspace||'')+'</span>'+
        '<span class="rq-sago">'+esc(ago(s.lastActiveMs))+(on?' · reviewing':'')+'</span>'+
        // Delete straight from the selector. A SPAN, not a nested button (invalid
        // inside this row's button); the list listener catches [data-sdel] before the row's [data-sid]
        // so the click deletes rather than switches. 🗑 emoji, not a webview codicon — the trash glyph is
        // outside the whitelisted subset and would render a silent blank in a webview.
        '<span class="rq-sdel" data-sdel="'+esc(s.id)+'" title="Delete this session from OAK — removes it from every picker and purges its captured edits for good. The transcript itself is not deleted; oak sessions --undelete '+esc(s.id)+' lists it again, without its edits">🗑</span></button>';
    }
    // NEEDS YOU: the raised hands lead the list under their own header,
    // ordered by the rank the host stamped on each row (core.HAND_RANK: permission, question, input;
    // oldest first) — the same order as the inbox and the terminal app. The rest keep the reader's sort.
    var hands=[], rest=[];
    for(var r2=0;r2<out.length;r2++){ (waitOf(out[r2])?hands:rest).push(out[r2]); }
    hands.sort(function(a,b){ var d=(a.handRank||9)-(b.handRank||9); return d||((a.attention.ts||0)-(b.attention.ts||0)); });
    if(hands.length){ h+='<div class="rq-sgrp">needs you ('+hands.length+')</div>'; for(var hi=0;hi<hands.length;hi++) h+=srow(hands[hi]); if(rest.length) h+='<div class="rq-sgrp">sessions</div>'; }
    for(var ri=0;ri<rest.length;ri++) h+=srow(rest[ri]);
    if(!out.length) h='<div class="rq-snone">no session matches'+(q?' “'+esc(SESSQ)+'”':'')+(SESSACT?' (a filter is on)':'')+'</div>';
    else if(out.length<SESSROWS.length) h+='<div class="rq-snone">'+(SESSROWS.length-out.length)+' hidden by the search/filter</div>';
    // SEARCH THE CONVERSATIONS: with words typed, one more row asks the host to search
    // every session's asks and answers; the hits land beneath as rows that pick the session.
    if(q.length>=2){
      h+='<button class="rq-srow rq-ssearch" data-ssearch="'+esc(SESSQ)+'" title="Search the asks you typed and the answers you got, in every session on this machine"><span class="rq-sdot">⌕</span><span class="rq-sname">search conversations for “'+esc(SESSQ)+'”</span><span class="rq-sago">asks and answers, every session</span></button>';
      if(SEARCHRES&&SEARCHRES.q===SESSQ){
        var hits=SEARCHRES.hits;
        if(hits===null) h+='<div class="rq-snone">searching… (the first search builds the index)</div>';
        else if(SEARCHRES.error) h+='<div class="rq-snone">could not search the conversations — '+esc(SEARCHRES.error)+'</div>';
        else if(!hits.length) h+='<div class="rq-snone">nothing matches “'+esc(SESSQ)+'” in any conversation</div>';
        else {
          h+='<div class="rq-sgrp">in conversations ('+hits.length+')</div>';
          for(var si=0;si<hits.length;si++){ var ht=hits[si];
            h+='<button class="rq-srow" data-sid="'+esc(ht.session)+'" title="'+esc((ht.title||ht.session)+' — '+ago(ht.ts)+' · click to review this session')+'">'+
              '<span class="rq-sdot">'+(ht.where==='prompt'?'?':'≡')+'</span>'+
              '<span class="rq-sname">'+esc(ht.title||('session '+String(ht.session).slice(0,8)))+'</span>'+
              ((ht.agent&&ht.agent!=='claude')?'<span class="rq-agentbadge">'+esc(ht.agent)+'</span>':'')+
              '<span class="rq-sago">'+esc(ago(ht.ts))+' · '+(ht.where==='prompt'?'ask':'answer')+'</span>'+
              '<span class="rq-shit">'+esc(ht.snippet)+'</span></button>';
          }
        }
      }
    }
    return h;
  }
  function renderSessRowsOnly(){
    var re=document.getElementById('rq-srows');
    if(re) re.innerHTML=sessRowsHtml();
  }
  var schip=document.getElementById('rq-schip');
  // The ⚠ count on the chip is a door of its own: a click on it jumps to the next raised hand instead
  // of opening the list (the host applies core's ranking).
  if(schip) schip.addEventListener('click', function(ev){ var t=ev.target; if(t&&t.closest&&t.closest('#rq-swait')){ ev.stopPropagation(); vscode.postMessage({type:'nextAttention'}); return; } SESSOPEN=!SESSOPEN; renderSess(); });
  // The + NEW SESSION menu: the installed agent CLIs; picking one opens that
  // CLI in a herdr terminal; the Feed shows its captured conversation.
  var NEWCLIS=null;
  var newBtn=document.getElementById('rq-newsess'), newDrop=document.getElementById('rq-newdrop');
  function renderNewDrop(){
    if(!newDrop) return;
    if(NEWCLIS===null){ newDrop.innerHTML='<div class="rq-fd-row">listing installed agents…</div>'; return; }
    if(!NEWCLIS.length){ newDrop.innerHTML='<div class="rq-fd-row">no agent CLIs found on PATH</div>'; return; }
    var h='';
    for(var ni=0;ni<NEWCLIS.length;ni++){ var nc=NEWCLIS[ni];
      h+='<div class="rq-fd-row" data-newcli="'+esc(nc.command)+'"><span class="rq-fd-ck">▸</span>'+esc(nc.name)+' <span style="color:var(--vscode-descriptionForeground)">· '+esc(nc.command)+'</span></div>'; }
    newDrop.innerHTML=h;
  }
  if(newBtn&&newDrop){
    newBtn.addEventListener('click', function(){
      if(newDrop.hidden){ newDrop.hidden=false; renderNewDrop(); if(NEWCLIS===null) vscode.postMessage({type:'newSessionMenu'}); }
      else newDrop.hidden=true;
    });
    newDrop.addEventListener('click', function(ev){
      var t=ev.target; var row=(t&&t.closest)? t.closest('[data-newcli]') : null;
      if(!row) return;
      newDrop.hidden=true;
      vscode.postMessage({type:'newSession', command:row.getAttribute('data-newcli')});
    });
  }

  var TOUR_ANCHORS = { 'prompts-list':'#rq-list', 'session-picker':'#rq-sess', 'feed':'#tlf-body' };
  /**
   * The anchor a tour step is currently pointing at, HELD.
   *
   * Two reasons it cannot be a one-shot: the host broadcasts the anchor BEFORE it names the tab (a step
   * naming the Prompts list arrives while the Actions tab may still be forward, so #rq-list does not
   * exist yet), and every repaint rebuilds the node the ring was on. So each render re-applies it.
   */
  var TOUR_ANCHOR=null;
  function applyTour(anchor){
    TOUR_ANCHOR = anchor;
    reTour();
  }
  function reTour(){
    var prev=document.querySelectorAll('.ring');
    for(var i=0;i<prev.length;i++) prev[i].classList.remove('ring');
    var sel = TOUR_ANCHOR ? TOUR_ANCHORS[TOUR_ANCHOR] : null;
    var el = sel ? document.querySelector(sel) : null;
    if(el) el.classList.add('ring');
  }
  var gtog=document.getElementById('tl-grouptabs');
  if(gtog) gtog.addEventListener('click', function(){
    GROUPED=!GROUPED; GROUP_BUILT=null; resetLayoutCaches(); saveState(); renderTabs(); applyPanes(); ensureGroup(); renderAll(); tellHost(); });

  window.addEventListener('message', function(ev){ var m=ev.data||{};
    if(m.type==='tour'){ applyTour(m.anchor||null); return; }
    if(m.type==='newSessionAgents'){ NEWCLIS=m.items||[]; renderNewDrop(); return; }
    if(m.type==='sessions'){ SESSROWS=m.rows||[]; SESSCUR=m.current||''; SESSSEEN=true; renderSess(); return; }
    if(m.type==='searchResults'){ SEARCHRES={q:String(m.q||''), hits:Array.isArray(m.hits)?m.hits:[], error:String(m.error||'')}; renderSessRowsOnly(); return; }
    // A tour step (or a command) naming a tab brings it forward. Grouped, everything it could name is
    // already on screen — except a column the reader folded, which is brought back rather than left
    // pointing at nothing.
    if(m.type==='tab' && isTab(m.tab)){
      if(GROUPED){ if(!colOpen(m.tab)){ delete COLC[m.tab]; GROUP_BUILT=null; } }
      TAB=m.tab; saveState(); renderTabs(); applyPanes(); ensureGroup(); renderAll(); tellHost(); return;
    }
    if(m.type==='rows'){ var st=TREE[m.tab]; if(!st) return;
      if(!m.parent){
        // A root payload replaces the whole tree: the children already held were built from the payload
        // before it, and an open group must never keep showing the previous tick's rows.
        //
        // Keeping the children of groups that are still open was considered and cannot be done here: the
        // HOST drops its whole node table for this tab on a root post, so a held child row's key no
        // longer resolves to anything — its click and its Keep/Undo buttons would silently do nothing,
        // which is worse than the re-fetch. Preserving them means the host re-serializing them anyway.
        // What the re-fetch storm cost is paid for instead by the host's tree throttle, which bounds
        // this whole exchange to once per 3s while the agent works.
        st.rows={}; st.req={}; st.rows['']=m.rows||[];
        st.count=m.count||0; st.err=m.err||null; st.seen=true;
        if(typeof m.hooks==='boolean') st.hooks=m.hooks;
      } else { st.rows[m.parent]=m.rows||[]; delete st.req[m.parent]; }
      renderTabs(); paintColBadges(); renderTree(m.tab); return; }
    if(m.type==='prompts'){ RQ=m.rq||null; SEEN=true; if(m.selected!==undefined) SEL=m.selected; renderPrompts(); renderTabs(); paintColBadges(); }
    else if(m.type==='response'){ RESP[m.id]=m.response||{text:'',turns:0,truncated:0}; renderPrompts(); }
    // The tab's feed head. A payload for a connection the reader already left is dropped.
    else if(m.type==='agentFeed'){
      FEEDFP='';
      var subject=String(m.session||'')+':'+JSON.stringify(m.feed&&m.feed.ref||null);
      var previousSubject=AGFEEDSESS+':'+JSON.stringify(AGFEED&&AGFEED.ref||null);
      if(subject!==previousSubject)FCLOSED={};
      AGFEED=m.feed||null; AGPATCH=m.patches||{}; AGFEEDSESS=String(m.session||'');
      AGFOLLOWED=String(m.followed||'');
      AGSCROLLTS=(typeof m.scrollTs==='number'&&m.scrollTs>0)?m.scrollTs:0;
      AGSCROLLMODE=(m.scrollMode==='end')?'end':'start';
      if(shows('feed')) renderFeedTab();
    }
    else if(m.type==='error'){ RQ=null; SEEN=true; renderPrompts(); renderTabs(); }
  });
  renderTabs();
  applyPanes();
  ensureGroup();
  renderAll();
  renderSess();
  tellHost();
  vscode.postMessage({type:'ready'});
})();
`;

/**
 * The listing the Overview's `views` batch built last. With the Timeline visible too, every refresh tick
 * computed the same listing twice: in that batch, and again in the Timeline's own `sessions --json`
 * (about 0.6 s of CPU per 3 s tick on a large session). An UNFORCED Timeline refresh reuses a batch that
 * landed within 3 s. A forced refresh (every review verb and mutation) raises `listingFloor`, and only a
 * batch that STARTED after it is reused. The batch also carries the store's stamp from when it started —
 * `storeStamp`, which every store-watcher event bumps — so a change this window did not make (a keep or
 * undo from the TUI or the CLI, a capture, a raised hand) retires it too: the watcher's refresh is
 * unforced, and it posted the listing from before the change.
 */
let sharedListing: { key: string; startedAt: number; landedAt: number; stamp: number; listing: core.SessionMeta } | null = null;
let listingFloor = 0;
let storeStamp = 0;
const listingKey = (cwd: string, session: string | null | undefined): string => `${cwd}\u0000${session ?? ''}`;
function reusableListing(cwd: string, session: string | null | undefined): core.SessionMeta | null {
  const s = sharedListing;
  return s && s.key === listingKey(cwd, session) && s.startedAt >= listingFloor && s.stamp === storeStamp && Date.now() - s.landedAt < 3000 ? s.listing : null;
}

/** Session discovery and ordering belong to the CLI running on this workspace's host. */
function readSessionListing(cwd: string, session?: string | null): Promise<core.SessionMeta | null> {
  return new Promise((resolve) => spawnCliJson(['sessions', '--json', '--root', cwd, ...(session ? ['--session', session] : [])], cwd,
    (data) => { const listing = data as core.SessionMeta | null; resolve(Array.isArray(listing?.sessions) ? listing : null); }));
}

function allSessionRows(rows: core.SessionMetaRow[], current: string | null | undefined): core.SessionMetaRow[] {
  return [...rows.filter((r) => r.id === current), ...rows.filter((r) => r.id !== current)];
}

function activeSessionRows(rows: core.SessionMetaRow[], current: string | null | undefined): core.SessionMetaRow[] {
  // Two-clock liveness (matches JetBrains + core fleet): a driven session between message boundaries
  // keeps a fresh liveMs even when its transcript clock (lastActiveMs) has momentarily gone quiet, so
  // filtering on lastActiveMs alone dropped a working session out of the active picker.
  const keep = rows.filter((r) => core.isFleetActive(Math.max(r.lastActiveMs, r.liveMs)) || r.id === current);
  return [...keep.filter((r) => r.id === current), ...keep.filter((r) => r.id !== current)];
}

/** The folder-reveal button a session picker row carries — a QuickPick row cannot link
 *  its store-size TEXT, so this opens the store folder instead (see revealStoreFolder). Shared by both
 *  selectors, so they can never disagree about the affordance. */
const revealStoreBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('folder-opened'), tooltip: 'Reveal this session’s store folder on disk' };
/**
 * Open a session's store folder — the ONE body behind every store affordance: the Overview's Store
 * button, a Sessions row's size, and both session pickers' folder button.
 *
 * The manifest pins this extension to the workspace side, so in a remote window (Remote-SSH, WSL, a dev
 * container) it runs on the remote host and the store is on THAT machine. `openExternal` then hands the
 * machine showing the UI a `vscode-remote://` URL no application there can open (Cursor on a Mac logs
 * "No application found to open URL"), and `revealFileInOS` ignores remote resources. So a remote store
 * opens as a folder in a new window on the remote host — the one file browser that can reach it; locally
 * the OS file manager opens it. A session with no folder yet, or an open that fails, is said out loud.
 */
function revealStoreFolder(id: string): void {
  let dir = '';
  try {
    dir = core.storeDir(id);
  } catch {
    /* not a session id — reported below as having no folder */
  }
  if (!dir || !fs.existsSync(dir)) {
    void vscode.window.showWarningMessage(id
      ? `OAK: session ${id.slice(0, 8)} has no store folder yet — nothing from it has been captured.`
      : 'OAK: no session is selected, so there is no store folder to open.');
    return;
  }
  const uri = vscode.Uri.file(dir);
  const opened: Thenable<unknown> = vscode.env.remoteName
    ? vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true, noRecentEntry: true })
    : vscode.env.openExternal(uri);
  opened.then(
    (ok) => { if (ok === false) void vscode.window.showWarningMessage(`OAK: could not open the store folder ${dir}`); },
    (e) => void vscode.window.showWarningMessage(`OAK: could not open the store folder ${dir} — ${e instanceof Error ? e.message : String(e)}`)
  );
}

/** The trash button a session picker ROW carries (delete a cluttering session straight
 *  from the list, the way JetBrains' Sessions pane does, without connecting to it first). The QuickPick's
 *  button-side twin of the webview lists' 🗑; `confirmAndDeleteSession` is the shared body behind all three. */
const deleteSessionBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete this session from OAK' };

/**
 * Confirm, then delete a session from OAK — the ONE body behind every per-row delete affordance (the
 * Agent-tab 🗑, the Overview Sessions-tab rows, the Timeline selector rows and the switch-session
 * QuickPick), so the confirm text and the pinned-fallback can never drift between them. It matches the
 * session delete's wording verbatim.
 *
 * `core.deleteSession` HIDES the session from every picker AND purges its captured edits for good; the agent's
 * own transcript/rollout is left untouched, and `oak sessions --undelete <id>` lists the session again, without
 * its edits. The confirm names the edits still pending review — the purge drops their before-snapshots, so
 * those changes can no longer be undone — and the delete then purges no more than it named. Deleting the
 * PINNED session would leave the pin pointing at a purged/hidden id, so the pin is moved forward to the
 * newest that remains (or Auto when none); otherwise a forced refresh re-resolves — which core already
 * filters hidden sessions out of, so Auto lands on the newest visible one.
 *
 * Returns the deleted session's display name on success, or null when the user cancelled, the id was not
 * a real session, or core refused the delete. Callers do their own view-specific follow-up (dropping the
 * row at once, etc.); the forced refresh here is the shared path that repaints every session list.
 */
async function confirmAndDeleteSession(id: string): Promise<string | null> {
  if (!id || !core.isSafeSessionId(id)) {
    vscode.window.setStatusBarMessage('OAK: no conversation selected to delete', 3000);
    return null;
  }
  const root = workspaceRoot() ?? process.cwd();
  const meta = (await readSessionListing(root, currentSession()))?.sessions.find((r) => r.id === id);
  const name = meta?.title || `session ${id.slice(0, 8)}`;
  // The listing's count, as the row shows it and as the CLI computed it off this thread, and the newest
  // edit that listing saw (`lastEdit`; absent from an older CLI's rows, which leaves the count check alone).
  const pending = Math.max(0, Number(meta?.pending) || 0);
  const seenThrough = typeof meta?.lastEdit === 'number' ? meta.lastEdit : undefined;
  const verb = pending ? `Delete and purge ${pending} pending edit${pending === 1 ? '' : 's'}` : 'Delete';
  const ok = await vscode.window.showWarningMessage(
    `Delete “${name}” from OAK?`,
    {
      modal: true,
      detail:
        'The conversation transcript itself is NOT deleted — this removes the session from ' +
        'Observatory’s session pickers and views and purges its captured edits for good.' +
        (pending ? `\n\n${pending === 1 ? '1 of those edits is' : `${pending} of those edits are`} still pending review: the purge drops ` +
          `${pending === 1 ? 'its before-snapshot' : 'their before-snapshots'}, so OAK can no longer undo ${pending === 1 ? 'that change' : 'those changes'}.` : '') +
        `\n\noak sessions --undelete ${id} lists the session again, without its edits.`,
    },
    verb
  );
  if (ok !== verb) return null;
  // Purges no more pending edits than this confirm named, and none captured after the listing it counted
  // from: such an edit is refused, not purged unseen, even one that joined a change the count included.
  try {
    core.deleteSession(id, { confirmedPending: pending, seenThrough });
  } catch (e) {
    void vscode.window.showErrorMessage(`OAK: could not delete “${name}” — ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  const pinned = vscode.workspace.getConfiguration('claudeObservatory').get<string>('session') || '';
  if (pinned === id) {
    const next = (await readSessionListing(root))?.sessions[0]?.id ?? '';
    await vscode.commands.executeCommand('claudeObservatory.pinSession', next);
  } else {
    await vscode.commands.executeCommand('claudeObservatory.refresh');
  }
  vscode.window.setStatusBarMessage(`OAK: deleted “${name}” and purged its edits — oak sessions --undelete ${id} lists it again, without them`, 5000);
  return name;
}

/** The badge prefix a session row leads with — agent · tier · model · store size — shared so the two
 *  selectors can never drift on it (a fifth badge added to one but not its sibling is exactly the parity
 *  bug this guards). Only the trailing recency + active/reviewing suffix differs, so that stays inline. */
function sessionBadgePrefix(r: core.SessionMetaRow): string {
  return [r.agent !== 'claude' ? r.agent : '', r.model || 'model unknown', r.workspace || 'Unknown workspace',
    `${r.edits} edit${r.edits === 1 ? '' : 's'}`, `${core.compactTokens(r.tokens)} tok`, core.compactDuration(r.durationMs),
    r.storeBytes ? core.compactBytes(r.storeBytes) : ''].filter(Boolean).join(' · ') + ' · ';
}

/**
 * Host side of the Timeline window.
 *
 * Three jobs, one webview: the Prompts list (spawns `prompts --json`, owns the picked ask and hands it
 * to the Overview), and the Actions + Observations feeds, served a level at a time straight off
 * `ActionsProvider` / `ObservationsProvider` — the same view-models the trees used, kept in those
 * classes rather than copied here.
 *
 * The prompt selection lives HERE, not in either webview, so a panel that reloads — or one that was
 * hidden while the pick was made — comes back to the same scope both windows agree on.
 */
class TimelineViewProvider implements vscode.WebviewViewProvider {
  constructor(
    readonly observations: ObservationsProvider,
    readonly actions: ActionsProvider
  ) {}
  private view?: vscode.WebviewView;
  private connectedSession: string | null = null;
  private reviewedSession: string | null | undefined;
  conversationSelection(): string | null { return this.connectedSession ?? currentSession() ?? this.sessionShown; }
  connectSession(session: string | null): void { this.connectedSession = session; this.reviewedSession = currentSession() ?? this.sessionShown; this.followHead(null); }
  /** Guided tour: ring the control a step names, if this panel is the one that owns it. */
  setTour(anchor: string | null): void {
    this.view?.webview.postMessage({ type: 'tour', anchor });
  }
  /** Bring one tab forward — the tour's `view: 'actions' | 'observations' | 'prompts' | 'feed'`
   *  steps, and the palette commands that reveal a tab. Grouped, the webview un-folds the column. */
  setTab(tab: 'prompts' | 'actions' | 'observations' | 'feed'): void {
    this.view?.webview.postMessage({ type: 'tab', tab });
  }
  private run = 0;
  /** The tree block's OWN coalescing stamp — see `refresh`. */
  private treeRun = 0;
  private running = false;
  private rerun = false;
  private everLoaded = false;
  /** Which tabs are on screen, as the webview last reported. Serving a tab nobody is looking at would
   *  put back the cost the trees' visible-only refresh removed — the Actions root alone walks every
   *  sibling worktree. All start true so the first refresh (before the webview has answered) still
   *  fills whichever tab the persisted layout restores. */
  private showing: Record<'observations' | 'actions' | 'feed', boolean> = { observations: true, actions: true, feed: true };
  /** The nodes behind the rows currently on screen, per tab, with the command and the verbs each row is
   *  allowed to reach. A click posts a KEY; what it may run is decided here, never by the webview. */
  private nodes = new Map<string, { node: unknown; cmd?: vscode.Command; acts: TlAct[] }>();
  /** Told the selection changed (the Overview is the listener). */
  onSelect?: (id: string | null) => void;
  /** The last payload that parsed — so a repaint forced from outside (a cleared scope) has rows to draw. */
  private last: unknown = null;
  private selected: string | null = null;
  get selection(): string | null {
    return this.selected;
  }
  /** Drop the scope from outside (the Overview's scope bar) and repaint this window with it cleared. */
  clearSelection(): void {
    if (!this.selected) return;
    this.selected = null;
    this.onSelect?.(null);
    this.view?.webview.postMessage({ type: 'prompts', rq: this.last, selected: null });
  }
  /**
   * Push a selection made OUTSIDE this window — the nav bar's Prompt axis, Review prompt, Rewind — into
   * the list, so the picked ask is highlighted in the same place the reader picks one by hand. Without
   * this the two surfaces disagreed about which ask was chosen.
   *
   * Deliberately does NOT call `onSelect`: the caller is the one that scoped the Overview, and echoing
   * it back would run select → notify → select. The webview does not answer a pushed selection either
   * (it sets its own SEL and repaints), so the loop is closed at both ends.
   */
  setSelection(id: string | null): void {
    if (this.selected === id) return;
    this.selected = id;
    this.view?.webview.postMessage({ type: 'prompts', rq: this.last, selected: id });
  }
  /** A feed edit item's file opener — the stacked layout, wired in activate() to the Review
   *  provider (which owns the stacked panel). (session, editId); session is the head's own. */
  onOpenEditFile?: (session: string, editId: number) => void;
  /** Bounded inline diffs for a feed payload, in-process — the Feed tab's head rides these. */
  private buildFeedPatches(session: string, entries: { editId?: number; previewId?: number }[]): Record<number, string> {
    const patches: Record<number, string> = {};
    let took = 0;
    for (let i = entries.length - 1; i >= 0 && took < 40; i--) {
      const id = entries[i].editId ?? entries[i].previewId;
      if (typeof id !== 'number' || patches[id] !== undefined) continue;
      try {
        const rec = core.findRecord(session, id);
        if (!rec) continue;
        patches[id] = core.coloredDiff(session, rec, false).split('\n').slice(0, 80).join('\n');
        took++;
      } catch {
        /* a torn blob shows no preview — the diff door still opens the real thing */
      }
    }
    return patches;
  }
  /** The Feed's poll state — shared by the session and Overview selections.
   *  Settles on an audit answer; forced by connect/subject/turn events. */
  private agentFeedKey = '';
  private agentFeedSettled = false;
  /** When the head settled: the feed's own newest stamp (re-armed by fresh transcript activity)
   *  and the wall clock (a 30s heartbeat for sessions the listing does not carry). */
  private settledFeedTs = 0;
  private settledAt = 0;
  /** The head's fetch depth — 60 normally; a jump to an older prompt deepens it once (reset on
   *  any connection/subject change). */
  private agentFeedLimit = 60;
  private lastHeadOldestTs = 0;
  private pendingScrollTs: number | null = null;
  private pendingScrollMode: 'start' | 'end' = 'start';
  /** Scroll the head to the entry where a PROMPT began (its ts) — or, mode 'end', to the last
   *  entry BEFORE ts (the agent's answer at the end of an ask's span): deepen the window when the
   *  target predates what is loaded, then let the payload carry the scroll target down. */
  scrollHeadTo(ts: number, mode: 'start' | 'end' = 'start'): void {
    this.pendingScrollTs = ts;
    this.pendingScrollMode = mode;
    if (this.lastHeadOldestTs && ts < this.lastHeadOldestTs && this.agentFeedLimit < 400) this.agentFeedLimit = 400;
    this.agentFeedSettled = false;
    this.fetchAgentFeed(true);
  }
  /** A NON-SESSION Overview pick (a workflow run, a task, a shell) the head follows — the old
   *  Feed tab's job. Null = the connected session's own feed. */
  headRef: { kind: string; id: string; label: string } | null = null;
  followHead(ref: { kind: string; id: string; label?: string } | null): void {
    this.headRef = ref ? { kind: ref.kind, id: ref.id, label: ref.label ?? '' } : null;
    this.agentFeedLimit = 60;
    this.pendingScrollTs = null;
    this.agentFeedSettled = false;
    this.fetchAgentFeed(true);
  }
  fetchAgentFeed(force = false): void {
    if (!this.view?.visible || !this.showing.feed) return;
    const cwd = workspaceRoot();
    const session = this.conversationSelection() ?? currentSession();
    if (!cwd || !session) return;
    const ref = this.headRef;
    const key = ref ? `${ref.kind}\u0000${ref.id}\u0000${session}` : session;
    if (!force && this.agentFeedKey === key && this.agentFeedSettled) {
      // An audit reading is a MOMENT, not a terminal state, for a session head: the worker the
      // reader clicked settles between its turns, then starts the next one — and the permanent
      // latch froze the head there. Re-arm from the listing already in hand — fresh transcript
      // activity since the settled snapshot means the subject is speaking again — with a slow
      // heartbeat for a session the listing does not carry. Non-session subjects (a workflow
      // run, a task) stay settled: their records do not resume.
      if (ref && ref.kind !== 'session') return;
      const row = this.sessRowsCache.find((r) => r.id === session);
      const rearm = row ? (row.liveMs || row.lastActiveMs) > this.settledFeedTs : Date.now() - this.settledAt > 30_000;
      if (!rearm) return;
      this.agentFeedSettled = false;
    }
    if (this.agentFeedKey !== key) this.agentFeedSettled = false;
    this.agentFeedKey = key;
    const args = ['feed', '--json', '--root', cwd, '--session', session, '--kind', ref?.kind ?? 'session',
      '--feed-limit', String(this.agentFeedLimit), '--limit', String(this.agentFeedLimit)];
    if (ref && ref.kind !== 'session' && ref.id) args.push('--id', ref.id);
    const followed = ref?.label ?? '';
    spawnCliJson(args, cwd, (data) => {
      if (this.agentFeedKey !== key) return; // the connection moved while the spawn ran
      const d = data as { entries?: unknown[]; mode?: string; lastTs?: number } | null;
      const ok = !!(d && Array.isArray(d.entries) && (d.mode === 'live' || d.mode === 'audit'));
      this.agentFeedSettled = ok && d!.mode === 'audit';
      if (this.agentFeedSettled) {
        this.settledFeedTs = Number(d!.lastTs ?? 0);
        this.settledAt = Date.now();
      }
      const patches = ok ? this.buildFeedPatches(session, d!.entries as { editId?: number; previewId?: number }[]) : {};
      if (ok) {
        const ents = d!.entries as { ts?: number }[];
        this.lastHeadOldestTs = ents.find((e2) => Number(e2.ts ?? 0) > 0)?.ts ?? 0;
      }
      const scrollTs = this.pendingScrollTs;
      const scrollMode = this.pendingScrollMode;
      this.pendingScrollTs = null;
      this.pendingScrollMode = 'start';
      this.view?.webview.postMessage({ type: 'agentFeed', session: key, feed: ok ? d : null, patches, followed, scrollTs, scrollMode });
    });
  }
  /**
   * Serialize ONE level of a tree provider and hand it to the webview.
   *
   * Level at a time, like the tree it replaces: a big session's Actions feed is ~1000 rows across its
   * categories, and every one of them carries a tooltip — building the lot on every refresh would post
   * hundreds of kilobytes for rows nobody has opened. A root payload drops that tab's node table first:
   * the rows the webview holds are about to be replaced, and a stale key must never resolve to a node
   * from the previous payload.
   *
   * One level of Observations is still unbounded — one row per edit run — so the EDIT rows are capped
   * at `EDIT_FEED_CAP` and the overflow is reported in a row of its own. Only the edit rows: this feed
   * ends with the Context section and "Next steps", and a head-N slice over the whole level would
   * delete both without a word. The cap decides what to SERIALIZE, before `getTreeItem` is called on a
   * node, so a dropped row costs nothing — and `kids` stays whole, so the badge below still counts
   * every edit the session made.
   */
  private postTree(tab: 'observations' | 'actions', parentKey: string): void {
    const view = this.view;
    if (!view) return;
    const prov = (tab === 'actions' ? this.actions : this.observations) as unknown as TlTreeProvider;
    if (!parentKey) for (const k of [...this.nodes.keys()]) if (k.startsWith(tab + '/')) this.nodes.delete(k);
    let rows: TlRow[] = [];
    let err: string | null = null;
    let count = 0;
    try {
      const parent = parentKey ? this.nodes.get(tab + '/' + parentKey)?.node : undefined;
      if (parentKey && parent === undefined) return; // the row went away with the last refresh
      const kids = prov.getChildren(parent) ?? [];
      const cap = tab === 'observations' ? EDIT_FEED_CAP : Infinity;
      let editRows = 0; // edit ROWS serialized — the cap is on rows, and a coalesced run is one row
      let editsKept = 0; // …and the EDITS those rows hold, which is what the notice and the badge count
      let editsHidden = 0;
      let noticeAt = -1; // where the "showing N of M" row goes — right after the last edit row kept
      for (let i = 0; i < kids.length; i++) {
        const node = kids[i];
        const kind = (node as { kind?: string }).kind;
        if (kind === 'edit' || kind === 'tlrun') {
          const held = (node as { edits?: unknown[] }).edits?.length ?? 1;
          if (editRows >= cap) {
            if (noticeAt < 0) noticeAt = rows.length;
            editsHidden += held;
            continue;
          }
          editRows++;
          editsKept += held;
        }
        const key = (parentKey ? parentKey + '/' : '') + tlNodeKey(node, i);
        const item = prov.getTreeItem(node);
        const acts = TL_ROW_ACTS[String(item.contextValue ?? '')] ?? [];
        this.nodes.set(tab + '/' + key, { node, cmd: item.command, acts });
        rows.push(tlRowOf(key, item, acts));
      }
      // A dropped row is SAID, never swallowed: the numbers are EDITS, so the total the notice states is
      // the same one the badge shows rather than a second, smaller count of rows; and the sections that
      // follow the feed are still below it.
      if (editsHidden)
        rows.splice(noticeAt, 0, tlMoreRow((parentKey ? parentKey + '/' : '') + 'more', editsKept, editsKept + editsHidden));
      // The tab's badge, counted off the SAME roots that were just serialized — never a second parse.
      // `kids`, not `rows`: the cap above changes how much is DRAWN, never what the session did.
      if (!parentKey)
        for (const k of kids) {
          const n = k as { kind?: string; count?: number; edits?: unknown[] };
          if (tab === 'actions') count += n.kind === 'agroup' ? n.count ?? 0 : 0;
          else count += n.kind === 'edit' ? 1 : n.kind === 'tlrun' ? (n.edits ?? []).length : 0;
        }
    } catch (e) {
      // Never a silent empty list: a feed that could not be built is SAID so, or the panel reads as a
      // session that did nothing.
      rows = [];
      err = String((e as Error)?.message || e) || 'unreadable';
    }
    void view.webview.postMessage({
      type: 'rows', tab, parent: parentKey, rows, count, err,
      // Which empty state Observations shows — the two `viewsWelcome` variants the removed view carried.
      hooks: core.hooksInstalled(),
    });
  }
  /** The selector consumes the same CLI listing as the Overview and JetBrains. `reuse` takes the
   *  Overview batch's copy when a fresh one exists (see sharedListing). */
  private async postSessions(cwd: string, session: string | null | undefined, reuse = false): Promise<void> {
    const listing = (reuse ? reusableListing(cwd, session) : null) ?? await readSessionListing(cwd, session);
    if (currentSession() !== session) return; // a switch raced the CLI
    const rows = allSessionRows(listing?.sessions ?? [], session).map((r) => ({
      ...r, active: core.isFleetActive(r.liveMs || r.lastActiveMs),
    }));
    this.sessRowsCache = rows;
    this.sessListingOk = listing !== null;
    // ATTENTION: toast once per raised hand — keyed by the
    // attention ts, so a session asks ONCE, not every tick — with Open pinning it and bringing
    // the Feed tab forward. idle-done stays quiet (shown, never toasted).
    // …and the DESKTOP announcement: core's claim file fires it once per
    // machine whichever surface sees the hand first, filtered by the reader's notification prefs
    // (which is why idle-done goes through too — the pref decides, not this loop).
    for (const r of rows) core.announceAttention(r as core.SessionMetaRow);
    this.onHandsChanged?.(rows.filter((r) => { const a = (r as core.SessionMetaRow).attention; return !!a && a.kind !== 'idle-done'; }).length);
    for (const r of rows) {
      const a = (r as core.SessionMetaRow).attention;
      if (!a || a.kind === 'idle-done') continue;
      if ((this.attnToasted.get(r.id) ?? 0) >= a.ts) continue;
      this.attnToasted.set(r.id, a.ts);
      const label = a.kind === 'question' ? 'has a question for you' : a.kind === 'permission' ? 'needs your permission' : 'is waiting for your input';
      const name = (r as core.SessionMetaRow).title || `session ${r.id.slice(0, 8)}`;
      void vscode.window.showWarningMessage(`OAK: “${name}” ${label}${a.message ? ` — ${a.message}` : ''}`, 'Open').then((act) => {
        if (act !== 'Open') return;
        void (async () => {
          await vscode.commands.executeCommand('claudeObservatory.pinSession', r.id);
          await vscode.commands.executeCommand('claudeObservatory.timeline.focus');
          this.followHead(null);
          this.setTab('feed');
        })();
      });
    }
    // DEFAULT TO THE LATEST SESSION: with nothing pinned and nothing resolved
    // for this workspace, the selector — and everything keyed on "current" — points at the
    // newest-activity local row instead of saying "no session selected" over a full listing.
    const shown = session ?? rows[0]?.id ?? null;
    this.sessionShown = shown;
    // The Timeline's own top session selector is THE selector: when the
    // pinned session moves, an explicit connection to an older session must not shadow it.
    if (this.reviewedSession !== shown) { this.connectedSession = null; this.headRef = null; this.reviewedSession = shown; }
    // Rows carry core's hand RANK so the webview's "needs you" group orders by the same rule as the
    // inbox and the terminal app, without a copy of it in the webview.
    const posted = rows.map((r) => ({ ...r, handRank: (r as core.SessionMetaRow).attention ? core.HAND_RANK[(r as core.SessionMetaRow).attention!.kind] : 9 }));
    this.view?.webview.postMessage({ type: 'sessions', rows: posted, current: shown ?? '' });

  }
  /** The + menu's CLI list, host-detected — the launch validates against exactly this. */
  private newSessionClis: { id: string; name: string; command: string }[] | null = null;
  /** One toast per raised hand: session id → the attention ts already announced. */
  private attnToasted = new Map<string, number>();
  /** How many sessions are waiting on the reader, after every sessions read — the status-bar chip. */
  onHandsChanged?: (n: number) => void;
  /** Jump to the next session waiting on you: core's ranking — permission,
   *  then question, then input, oldest first — cycling from the session shown; pin it and bring the
   *  Feed tab forward, the same landing the raised-hand toast's Open uses. */
  jumpToNextHand(): void {
    const id = core.nextAttention(this.sessRowsCache, this.sessionShown);
    if (!id) {
      // An empty cache after a listing that failed says nothing about who is waiting.
      if (!this.sessListingOk) void vscode.window.showWarningMessage('OAK: could not read which sessions are waiting — the session list did not load');
      else void vscode.window.showInformationMessage('OAK: nobody is waiting on you');
      return;
    }
    const row = this.sessRowsCache.find((r) => r.id === id);
    void (async () => {
      await vscode.commands.executeCommand('claudeObservatory.pinSession', id);
      await vscode.commands.executeCommand('claudeObservatory.timeline.focus');
      this.followHead(null);
      this.setTab('feed');
      if (row?.attention) void vscode.window.setStatusBarMessage(`OAK: “${row.title || `session ${id.slice(0, 8)}`}” ${core.attentionLabel(row.attention.kind)}${row.attention.message ? ` — ${row.attention.message}` : ''}`, 6000);
    })();
  }
  /** The default the selector shows when nothing is pinned — newest local row. */
  private sessionShown: string | null = null;
  /** The last sessions listing, host-side — the settle re-arm consults its lastActiveMs. */
  private sessRowsCache: Array<core.SessionMetaRow & { active: boolean }> = [];
  /** Whether that listing loaded: an empty cache from a failed read is not "nobody waiting". */
  private sessListingOk = false;
  /** Fetch the agent's prose reply to one ask and post it back to the row that asked to expand. */
  private fetchResponse(id: string): void {
    const cwd = workspaceRoot() ?? process.cwd();
    const session = currentSession();
    if (!session) return;
    spawnCliJson(['prompts', '--id', id, '--response', '--json', '--session', session], cwd, (data) => {
      const d = data as { response?: unknown } | null;
      this.view?.webview.postMessage({ type: 'response', id, response: d && d.response ? d.response : { text: '', turns: 0, truncated: 0 } });
    });
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = timelineShell();
    view.webview.onDidReceiveMessage((m: { type?: string; id?: string | null; tab?: string; key?: string; verb?: string; shows?: Record<string, boolean>; q?: string }) => {
      if (!m) return;
      const treeTab = m.tab === 'actions' || m.tab === 'observations' ? m.tab : null;
      // Pick the ask that scopes the Overview; lazily fetch the agent's reply when a row is expanded (the
      // response can be large, so it never rides the list payload); and serve the two trees a level at
      // a time as the reader opens them.
      if (m.type === 'ready') {

        // wholly from this push (the head feed follows on the fetch below).
        this.refresh(true);
      } else if (m.type === 'select') {
        this.selected = typeof m.id === 'string' && m.id ? m.id : null;
        this.onSelect?.(this.selected);
        // A picked ask also scrolls the Feed tab's feed head to where it began
        // — only when the head is on the reviewed session's own feed, and never for a clear.
        if (this.selected) {
          const cwd0 = workspaceRoot();
          const cur = currentSession();
          const eff = this.conversationSelection() ?? cur;
          if (cwd0 && cur && eff === cur && !this.headRef) {
            try {
              const pr = core.sessionPrompts(cwd0, cur).find((x) => x.id === this.selected);
              if (pr && pr.ts) this.scrollHeadTo(pr.ts);
            } catch {
              /* an unreadable transcript scrolls nothing */
            }
          }
        }
      } else if (m.type === 'review') {
        // The row's Review button: pick the ask (a pick, never a toggle) and bring the Review view
        // forward. Selection flows through the same onSelect as a row click, so nothing forks.
        this.selected = typeof m.id === 'string' && m.id ? m.id : null;
        this.onSelect?.(this.selected);
        void vscode.commands.executeCommand('claudeObservatory.reviewList.focus');
      } else if (m.type === 'expand' && typeof m.id === 'string') this.fetchResponse(m.id);
      else if (m.type === 'respJump' && typeof m.id === 'string') {
        // Scroll the feed head to the agent's ANSWER: the last entry of that ask's span (its endTs
        // is the next ask's start, so the seat walks back from there). Same guard as the prompt
        // jump: only on the reviewed session's own feed.
        const cwd0 = workspaceRoot();
        const cur = currentSession();
        const eff = this.conversationSelection() ?? cur;
        if (cwd0 && cur && eff === cur && !this.headRef) {
          try {
            const pr = core.sessionPrompts(cwd0, cur).find((x) => x.id === m.id);
            if (pr) this.scrollHeadTo(pr.endTs ? pr.endTs : Date.now(), 'end');
          } catch {
            /* an unreadable transcript scrolls nothing */
          }
        }
      }
      // Which tabs are on screen. A tab that has just come forward is served immediately — waiting for
      // the next store change would leave it on "Reading…" for as long as nothing happened.
      else if (m.type === 'view' && m.shows) {
        for (const t of ['observations', 'actions'] as const) {
          const on = !!m.shows[t];
          const was = this.showing[t];
          this.showing[t] = on;
          if (on && !was) this.postTree(t, '');
        }
        // The Feed is served at once when its tab comes forward.
        const feedOn = !!m.shows.feed;
        if (feedOn && !this.showing.feed) { this.showing.feed = true; this.fetchAgentFeed(true); }
        this.showing.feed = feedOn;
      }
      else if (m.type === 'agentFeedMore') {
        this.agentFeedLimit += 200;
        this.fetchAgentFeed(true);
      }
      else if (m.type === 'agentOpenEditFile' && typeof (m as { id?: unknown }).id === 'number') {
        const cs = this.conversationSelection() ?? currentSession();
        if (cs) this.onOpenEditFile?.(cs, (m as unknown as { id: number }).id);
      }
      else if (m.type === 'agentOpenEdit' && typeof (m as { id?: unknown }).id === 'number') {
        const cs = this.conversationSelection() ?? currentSession();
        const rec = cs ? core.findRecord(cs, (m as unknown as { id: number }).id) : null;
        if (rec) void openDiff({ rec } as unknown as EditNode);
      }
      // The head chip's ✕: back to the connected session's own feed. No reveal — the reader is here.
      else if (m.type === 'agentHeadClear') this.followHead(null);
      // Any path-like target: open the file itself. Resolved against the workspace when relative; a
      // target that is not a file on this machine gets a status note, never a silent nothing.
      else if (m.type === 'openPath' && typeof (m as { path?: unknown }).path === 'string') {
        const raw = (m as unknown as { path: string }).path;
        const cwd = workspaceRoot();
        const abs = path.isAbsolute(raw) ? raw : cwd ? path.join(cwd, raw) : raw;
        if (fs.existsSync(abs) && fs.statSync(abs).isFile())
          void vscode.window.showTextDocument(vscode.Uri.file(abs), { preview: true });
        else vscode.window.setStatusBarMessage(`OAK: ${raw} is not a file on this machine`, 3000);
      }
      else if (m.type === 'children' && treeTab && typeof m.key === 'string') this.postTree(treeTab, m.key);
      // A row's click command, taken from the host's OWN table — the webview posted only a key.
      else if (m.type === 'row' && treeTab && typeof m.key === 'string') {
        const hit = this.nodes.get(treeTab + '/' + m.key);
        if (hit?.cmd) void vscode.commands.executeCommand(hit.cmd.command, ...(hit.cmd.arguments ?? []));
      }
      // …and a row action: the verb must be one this row actually offers, or it is refused. The node
      // itself is what the command receives, exactly as the tree passed it.
      else if (m.type === 'rowAct' && treeTab && typeof m.key === 'string' && typeof m.verb === 'string') {
        const hit = this.nodes.get(treeTab + '/' + m.key);
        const verb = m.verb;
        if (hit && hit.acts.some((a) => a.v === verb))
          void vscode.commands.executeCommand('claudeObservatory.' + verb, hit.node);
      } else if (m.type === 'startDemo') void vscode.commands.executeCommand('claudeObservatory.startDemo');
      // The selector switches the WHOLE observatory (the user's call), so it goes through pinSession —
      // which is also what keeps a switch made mid-demo out of the user's settings.json.
      else if (m.type === 'nextAttention') this.jumpToNextHand();
      else if (m.type === 'pickSession' && typeof m.id === 'string') {
        // AWAITED: the pin is an async config write, and firing the re-reads before it landed
        // fetched the OLD session's feed — with the tick stamp-gated on store changes, nothing
        // ever corrected it.
        void (async () => {
          await vscode.commands.executeCommand('claudeObservatory.pinSession', m.id);
          // The TOP selector switches the whole observatory — the Feed tab follows it too:
          // an explicit connection is superseded and the Feed re-reads.
          this.postSessions(workspaceRoot() ?? process.cwd(), currentSession());
          this.fetchAgentFeed(true);
        })();
      }
      // The 🗑 on a selector row: confirm + core.deleteSession (hide + purge; transcript untouched),
      // shared with the session delete and the Overview so the wording and pinned-fallback never drift.
      // The row is dropped from the OPEN dropdown at once (postSessions is not spawn-coalesced the way the
      // shared refresh is). Only when the deleted conversation was the one on screen does the Feed tab
      // follow the fallback the way a selector pick does. Deleting another row leaves the current
      // selection intact, so `wasShown` is read before the delete re-resolves `currentSession()`.
      else if (m.type === 'searchConversations' && typeof m.q === 'string' && m.q.trim()) {
        // Every conversation's asks and answers — in-host over the persisted index
        // core keeps per session, so a search costs a few hundred ms, not a transcript scan.
        const q = m.q.trim();
        let hits: core.SearchHit[] = [];
        let error = '';
        try {
          hits = core.searchConversations(workspaceRoot() ?? process.cwd(), q, { limit: 30 }).hits;
        } catch (e) {
          // A search that threw learned nothing about any conversation: "nothing matches" would claim it had.
          error = String((e as Error)?.message || e) || 'the search could not run';
        }
        void this.view?.webview.postMessage({ type: 'searchResults', q, error, hits: hits.map((h) => ({ session: h.session, title: h.title, agent: h.agent, ts: h.ts, snippet: h.snippet, where: h.where })) });
      }
      else if (m.type === 'deleteSession' && typeof m.id === 'string' && m.id) {
        const id = m.id;
        const wasShown = id === (this.conversationSelection() ?? this.sessionShown ?? currentSession());
        void (async () => {
          const name = await confirmAndDeleteSession(id);
          if (name === null) return;
          this.postSessions(workspaceRoot() ?? process.cwd(), currentSession());
          if (wasShown) this.fetchAgentFeed(true);
        })();
      }
      // The way out to the full browser is the Overview's Sessions tab — the deprecated QuickPick is no
      // longer where this hands over to.
      else if (m.type === 'newSessionMenu') {
        try {
          this.newSessionClis = ['claude', 'codex'].map((kind) => ({ id: kind, name: kind, command: kind }));
        } catch {
          this.newSessionClis = [];
        }
        void this.view?.webview.postMessage({ type: 'newSessionAgents', items: this.newSessionClis });
      }
      else if (m.type === 'newSession' && typeof (m as { command?: unknown }).command === 'string') {
        // VALIDATED against the host's own detection — a webview string is never executed as-is.
        const wanted = (m as unknown as { command: string }).command;
        const hit = (this.newSessionClis ?? []).find((c) => c.command === wanted);
        if (hit) {
          void core.startAgentSession(hit.id, workspaceRoot() ?? process.cwd()).then(
            () => vscode.window.showInformationMessage(`Started ${hit.name} in herdr. Open herdr to interact with it.`),
            (error: Error) => vscode.window.showWarningMessage(error.message)
          );
        }
      }
      else if (m.type === 'allSessions') void vscode.commands.executeCommand('claudeObservatory.showSessions');
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) this.refresh(true);
    });
  }
  refresh(force = false): void {
    if (force) listingFloor = Date.now();
    if (!this.view?.visible) return;
    const now = Date.now();
    // The two in-process feeds, on their OWN 3s stamp. They used to ride every refresh unthrottled
    // because they "cost no spawn" — true while they were VS Code TREES, which the platform virtualized
    // down to the rows on screen and never serialized. Rendered by a webview they cost a full build +
    // postMessage + repaint per tick, so an unforced tick that correctly decides no spawn is worth doing
    // must not pay them either.
    //
    // A stamp of their own rather than moving them below the spawn throttle: that would also put them
    // below the in-flight gate, which returns EARLY, so a Keep landing during a `prompts --json` spawn
    // would leave the feed showing pre-Keep statuses until that spawn's callback re-ran the refresh.
    // Forced refreshes (every review verb) still post immediately, in flight or not. Only the tabs on
    // screen are built.
    if (force || now - this.treeRun >= 3000) {
      this.treeRun = now;
      this.actions.refresh(); // a new cycle re-walks the fleet (its `active` flags are time-derived)
      this.observations.refresh();
      if (this.showing.observations) this.postTree('observations', '');
      if (this.showing.actions) this.postTree('actions', '');
      // The Feed rides the same stamp: live sessions poll, finished ones settle.
      this.fetchAgentFeed(force);
    }
    // Same coalescing discipline the Overview uses: one spawn at a time, and a forced refresh that
    // arrives mid-flight re-runs once the current one lands (its payload predates the change).
    if (this.running) {
      if (force) this.rerun = true;
      return;
    }
    if (!force && now - this.run < 3000) return;
    this.run = now;
    const cwd = workspaceRoot() ?? process.cwd();
    const session = currentSession();
    this.postSessions(cwd, session, !force);
    if (!session) {
      this.view.webview.postMessage({ type: 'prompts', rq: null, selected: this.selected });
      return;
    }
    this.running = true;
    spawnCliJson(['prompts', '--json', '--session', session], cwd, (data) => {
      this.running = false;
      if (this.rerun) {
        this.rerun = false;
        setTimeout(() => this.refresh(true), 0);
      }
      const d = data as { prompts?: unknown[]; summary?: unknown } | null;
      const rq = d && Array.isArray(d.prompts) && d.summary ? d : null;
      if (rq) {
        this.everLoaded = true;
        this.last = rq;
      }
      // An ask that no longer exists (a session switch, a cleared store) must not keep scoping the
      // Overview to nothing — drop the selection and tell the listener, rather than leaving both
      // windows filtered by an id neither can name.
      if (this.selected && rq) {
        const still = (rq.prompts as { id?: string }[]).some((r) => r && r.id === this.selected);
        if (!still) {
          this.selected = null;
          this.onSelect?.(null);
        }
      }
      if (!rq && !this.everLoaded) this.view?.webview.postMessage({ type: 'error' });
      else this.view?.webview.postMessage({ type: 'prompts', rq, selected: this.selected });
    });
  }
}

class StatsUsageViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  /** Guided tour: ring the control a step names, if this panel is the one that owns it. */
  setTour(anchor: string | null): void {
    this.view?.webview.postMessage({ type: 'tour', anchor });
  }
  private statsRun = 0;
  private statsRunning = false;
  private statsEverLoaded = false; // gates the "CLI missing" hint: only before the first good payload
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = combinedShell(); // set once; both sections update via postMessage (no flash)
    view.webview.onDidReceiveMessage((m: { type?: string }) => {
      if (!m) return;
      if (m.type === 'ready') this.refresh();
      else if (m.type === 'reviewFirst') void vscode.commands.executeCommand('claudeObservatory.reviewFirst');
      else if (m.type === 'usageRefresh') void vscode.commands.executeCommand('claudeObservatory.usageRefresh');
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) this.refresh();
    });
    // A visible panel keeps itself current (the section sat on stale numbers
    // between store events — JB's panel already ticks the same way). 60s matches the pull cadence.
    const tick = setInterval(() => {
      if (view.visible) this.refresh();
    }, 60_000);
    (tick as unknown as { unref?: () => void }).unref?.();
    (view as { onDidDispose?: (cb: () => void) => void }).onDidDispose?.(() => clearInterval(tick));
  }
  refresh(): void {
    this.postCounts();
    this.postUsage();
    this.refreshStats();
  }
  /** Cheap + sync: post the live review scoreboard (pending/accepted/reverted) for the counts + progress
   *  bar. Runs on every store change so the bar fills live as the user keeps/undoes edits. */
  private postCounts(): void {
    if (!this.view) return;
    const session = currentSession();
    // DISPLAY units, like every other surface. This read raw records while the Sessions rows, the
    // Overview summary and sessionMetrics all collapsed same-code chains, so one window showed 2,800
    // pending in the Stats panel and 1,855 for the same session two panels away. reviewEdits is ~120ms
    // cold on that session and ~1ms after, so the scoreboard can still ride every store change.
    // …minus the chains that cancel out, for the same reason: one meaning per word, everywhere.
    const skip = session ? core.cancelledMemberIds(session) : new Set<number>();
    const log = session ? core.reviewEdits(session).filter((r) => !skip.has(r.id)) : [];
    const c = {
      pending: log.filter((r) => r.status === 'pending').length,
      kept: log.filter((r) => r.status === 'kept').length,
      undone: log.filter((r) => r.status === 'undone').length,
    };
    let sessionTitle = '';
    // Session-total token split for the "Session tokens" cells. sessionUsage keeps an incremental
    // per-transcript cursor, so this is a stat() when nothing changed and a delta-parse otherwise —
    // cheap enough to ride along with every counts push.
    let t: core.SessionTokens | null = null;
    // Model / effort / compactions ride the SAME cursor sessionUsage just advanced, so this second call
    // re-reads nothing — but it stays its own try below, since a throw here must not take the token
    // cells down with it.
    let v: core.SessionVitals | null = null;
    const cwd = workspaceRoot();
    if (session && cwd) {
      try {
        sessionTitle = (core.sessionViewTitle(cwd, session) ?? '').replace(/\s+/g, ' ').trim();
      } catch { /* fall back to the id */ }
      try {
        t = core.sessionUsage(cwd, session);
      } catch { /* unreadable transcript — the cells stay "—" */ }
      try {
        v = core.sessionVitals(cwd, session);
      } catch { /* unknown — the model/effort chip stays hidden */ }
    }
    this.view.webview.postMessage({ type: 'counts', c, session: session ?? '', sessionTitle, t, v });
  }
  /** Cheap + sync: post the current usage snapshot for the bars. */
  private postUsage(): void {
    if (!this.view) return;
    const session = currentSession();
    const cwd = workspaceRoot();
    const u0 = cwd ? core.usageLine(cwd, '') : null;
    // The gpt tab's windows (codex's own rollout rate limits) ride the same post.
    let u: unknown = u0;
    if (u0) {
      try {
        const g = core.gptUsagePanel(session && core.describeSession(session).runtime.includes('codex') ? session : undefined);
        u = g
          ? { ...u0, gptFivePct: g.fivePct, gptFiveReset: g.fiveReset, gptWeekPct: g.weekPct, gptWeekReset: g.weekReset,
              gptCtxPct: g.ctxPct, gptCtxTokens: g.ctxTokens, gptCtxSize: g.ctxSize,
              gptWeekTok: g.weekTok, gptWeekTotal: g.weekTotal,
              gptMonthStart: g.monthStart, gptMonthReset: g.monthReset,
              gptMonthTok: g.monthTok, gptMonthTokTotal: g.monthTokTotal, gptMonthReads: g.monthReads,
              gptMonthCost: g.monthCost, gptMonthCostTotal: g.monthCostTotal }
          : u0;
      } catch { u = u0; }
    }
    this.view.webview.postMessage({ type: 'usage', u });
  }
  /** Throttled subprocess scan (visible-only); posts the stats series when it returns. */
  private refreshStats(): void {
    if (!this.view?.visible) return;
    const now = Date.now();
    if (this.statsRunning || now - this.statsRun < 20000) return;
    this.statsRunning = true;
    this.statsRun = now;
    const args = ['stats', '--json'];
    const session = currentSession();
    if (session) args.push('--session', session);
    let child: cp.ChildProcess;
    try {
      // Windows: npm installs the CLI as a .cmd shim, which needs cmd.exe — see core/spawn.
      child = core.spawnTool(resolveObservatoryBin(), args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      this.statsRunning = false;
      this.postStatsError();
      return;
    }
    let out = '';
    child.stdout?.on('data', (d) => (out += d));
    child.on('error', () => {
      this.statsRunning = false;
      this.postStatsError();
    });
    child.on('close', () => {
      this.statsRunning = false;
      let data: unknown;
      try {
        const s = JSON.parse(out) as core.StatsResult;
        // Guard against a foreign process answering to `claude-observatory` on PATH: any
        // valid-but-wrong JSON on stdout (e.g. a launch.json) would otherwise sail past the
        // parse and throw inside statsData() — an *unhandled* exception in this callback that
        // crashes the extension host and surfaces the raw payload. Require the StatsResult shape,
        // and build the series inside the try so any throw routes to the clean error hint.
        if (!s || !Array.isArray(s.daily) || !Array.isArray(s.hourly)) throw new Error('not a StatsResult');
        data = statsData(s);
      } catch {
        this.postStatsError();
        return;
      }
      this.statsEverLoaded = true;
      this.view?.webview.postMessage({ type: 'stats', data });
    });
  }
  /** The #1 teammate-onboarding trap: .vsix installed but the global CLI missing → the panel used to
   *  say "Gathering stats…" forever. Surface an actionable hint instead (only before first data). */
  private postStatsError(): void {
    if (!this.statsEverLoaded) this.view?.webview.postMessage({ type: 'statsError' });
  }
}

/**
 * The Review view — the session's changes as a LIST, in the Traces sidebar; selecting a prompt
 * scopes the list to that ask. Every diff opens in the editor (a row's net pair, or the whole
 * scope concatenated via the multi-diff editor).
 *
 * Repeated edits to the same code arrive here already combined: each row is a review UNIT (core's
 * collapse), its net change the unit's whole story, so a superseded intermediate state never asks
 * for a decision. The pick has exactly one owner — `ChangeMapViewProvider` — and this view READS it
 * through the injected getter rather than keeping a second copy a reload could disagree with.
 *
 * Data is built in-process (this extension bundles core); JetBrains renders the same payload from
 * `review --prompt --json`, which is the contract that keeps the three surfaces identical.
 */
/**
 * FALLBACK syntax tokens for the stacked review blocks — a tiny regex lexer (string, comment,
 * number, keyword) that serves whenever the real pipeline below cannot: no `extensions` namespace
 * (the test harness), a theme file that will not parse, a language with no contributed grammar.
 * Each diff line is tokenized alone, so a multi-line construct falls back to plain text outside its
 * opening line — never to a wrong color on the change itself. The palette is the theme-aware charts
 * set. Output is fully HTML-escaped here; callers must not escape again.
 */
const HL_KEYWORDS: Record<string, Set<string>> = {
  js: new Set('abstract any as async await boolean break case catch class const continue debugger declare default delete do else enum export extends false finally for from function if implements import in infer instanceof interface is keyof let namespace never new null number object of override private protected public readonly return satisfies static string super switch this throw true try type typeof undefined unknown var void while with yield'.split(' ')),
  py: new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return self try while with yield'.split(' ')),
  jvm: new Set('abstract as break by catch class companion const constructor continue data do else enum extends false final finally for fun get if implements import in init inline interface internal is lateinit new null object open out override package private protected public return sealed set static super suspend this throw true try typealias val var when where while'.split(' ')),
  sh: new Set('case do done echo elif else esac exit export fi for function if in local read return set shift source then trap until while'.split(' ')),
  c: new Set('auto bool break case char class const constexpr continue default delete do double else enum extern false float for goto if inline int long namespace new nullptr private protected public return short signed sizeof static struct switch template this true typedef typename union unsigned using virtual void volatile while'.split(' ')),
  go: new Set('break case chan const continue default defer else fallthrough false for func go goto if import interface map nil package range return select struct switch true type var'.split(' ')),
  rs: new Set('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self static struct super trait true type unsafe use where while'.split(' ')),
  data: new Set('true false null yes no on off'.split(' ')),
};
/** Comment regex sources — matched per LINE, so `$` is the line end. `''` = no comment syntax. */
const HL_C_COMMENT = '\\/\\/.*$|\\/\\*.*?(?:\\*\\/|$)';
const HL_EXT: Record<string, { kw: string; cm: string }> = {
  js: { kw: 'js', cm: HL_C_COMMENT }, jsx: { kw: 'js', cm: HL_C_COMMENT }, ts: { kw: 'js', cm: HL_C_COMMENT },
  tsx: { kw: 'js', cm: HL_C_COMMENT }, mjs: { kw: 'js', cm: HL_C_COMMENT }, cjs: { kw: 'js', cm: HL_C_COMMENT },
  vue: { kw: 'js', cm: HL_C_COMMENT }, svelte: { kw: 'js', cm: HL_C_COMMENT },
  py: { kw: 'py', cm: '#.*$' }, pyi: { kw: 'py', cm: '#.*$' }, rb: { kw: 'py', cm: '#.*$' },
  kt: { kw: 'jvm', cm: HL_C_COMMENT }, kts: { kw: 'jvm', cm: HL_C_COMMENT }, java: { kw: 'jvm', cm: HL_C_COMMENT },
  scala: { kw: 'jvm', cm: HL_C_COMMENT }, groovy: { kw: 'jvm', cm: HL_C_COMMENT },
  sh: { kw: 'sh', cm: '#.*$' }, bash: { kw: 'sh', cm: '#.*$' }, zsh: { kw: 'sh', cm: '#.*$' },
  c: { kw: 'c', cm: HL_C_COMMENT }, h: { kw: 'c', cm: HL_C_COMMENT }, cc: { kw: 'c', cm: HL_C_COMMENT },
  cpp: { kw: 'c', cm: HL_C_COMMENT }, hpp: { kw: 'c', cm: HL_C_COMMENT }, cs: { kw: 'c', cm: HL_C_COMMENT },
  swift: { kw: 'c', cm: HL_C_COMMENT },
  go: { kw: 'go', cm: HL_C_COMMENT }, rs: { kw: 'rs', cm: HL_C_COMMENT },
  json: { kw: 'data', cm: '' }, jsonc: { kw: 'data', cm: HL_C_COMMENT },
  yaml: { kw: 'data', cm: '#.*$' }, yml: { kw: 'data', cm: '#.*$' }, toml: { kw: 'data', cm: '#.*$' },
  ini: { kw: 'data', cm: '[;#].*$' },
  css: { kw: 'data', cm: '\\/\\*.*?(?:\\*\\/|$)' }, scss: { kw: 'data', cm: HL_C_COMMENT }, less: { kw: 'data', cm: HL_C_COMMENT },
  html: { kw: 'data', cm: '<!--.*?(?:-->|$)' }, xml: { kw: 'data', cm: '<!--.*?(?:-->|$)' }, svg: { kw: 'data', cm: '<!--.*?(?:-->|$)' },
};
const hlReCache = new Map<string, RegExp>();
function hlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function hlLine(code: string, ext: string): string {
  // Own-property lookup, NOT plain indexing: a file extension of `constructor` or `__proto__`
  // otherwise answers from Object.prototype — truthy, so the plain-text fallback is skipped and
  // `HL_KEYWORDS[cfg.kw]` is undefined, throwing before the tab ever renders (the same threat the
  // Review script's null-proto file grouping guards ten lines away).
  const cfg = Object.prototype.hasOwnProperty.call(HL_EXT, ext) ? HL_EXT[ext] : undefined;
  // Unknown language: PLAIN, not "strings and numbers only" — on prose (.md, .txt) a stray quote
  // would paint half the line as a string, which reads as a rendering bug, not an aid.
  if (!cfg) return hlEscape(code);
  let re = hlReCache.get(ext);
  if (!re) {
    const str = '"(?:\\\\.|[^"\\\\])*"?|\'(?:\\\\.|[^\'\\\\])*\'?|`(?:\\\\.|[^`\\\\])*`?';
    // String FIRST (a // inside one is not a comment), comment second (keywords inside stay grey);
    // `(?!)` keeps the group numbering when the language has no comment syntax.
    re = new RegExp(`(${str})|(${cfg.cm || '(?!)'})|\\b(\\d[\\w.]*)\\b|\\b([A-Za-z_$][\\w$]*)\\b`, 'g');
    hlReCache.set(ext, re);
  }
  const kws = HL_KEYWORDS[cfg.kw];
  const parts: string[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m.index > last) parts.push(hlEscape(code.slice(last, m.index)));
    const t = m[0];
    if (m[1] != null) parts.push(`<span class="tk-s">${hlEscape(t)}</span>`);
    else if (m[2] != null) parts.push(`<span class="tk-c">${hlEscape(t)}</span>`);
    else if (m[3] != null) parts.push(`<span class="tk-n">${hlEscape(t)}</span>`);
    else parts.push(kws.has(t) ? `<span class="tk-k">${hlEscape(t)}</span>` : hlEscape(t));
    last = m.index + t.length;
    if (t.length === 0) re.lastIndex++; // a zero-width match must never loop forever
  }
  parts.push(hlEscape(code.slice(last)));
  return parts.join('');
}

// ── IDE-true tokens for the stacked view ──────────────────────────────────────────────────
// The webview cannot borrow the editor's renderer, but the extension host CAN run the editor's own
// tokenization pipeline: every language extension (built-ins included) contributes its TextMate
// grammar through `contributes.grammars`, the active color theme contributes its token rules, and
// vscode-textmate + vscode-oniguruma are the libraries VS Code itself tokenizes with. Semantic
// (LSP) coloring is the one layer this cannot reproduce — TM tokens are what the editor shows
// before a language server refines them. Every failure path falls back to the regex lexer above.

let tmStarted = false;
let tmRegistry: vsctm.Registry | null = null;
let tmColorMap: string[] = [];
const tmExtToScope = new Map<string, string>(); // "ts" → "source.ts"
const tmScopeToPath = new Map<string, string>(); // scopeName → grammar file on disk
const tmGrammars = new Map<string, Promise<vsctm.IGrammar | null>>();

/** JSONC the way theme files are written: comments and trailing commas allowed. Null on defeat. */
function tmParseJsonc(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    let out = '';
    let inStr = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        out += c;
        if (c === '\\') {
          out += text[++i] ?? '';
          continue;
        }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        out += c;
        continue;
      }
      if (c === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++;
        out += '\n';
        continue;
      }
      if (c === '/' && text[i + 1] === '*') {
        i += 2;
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i++;
        continue;
      }
      out += c;
    }
    try {
      return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

/** Index every contributed grammar and language→extension mapping, built-ins included. */
function tmScan(): void {
  const all = vscode.extensions?.all;
  if (!all) return;
  const langExts = new Map<string, string[]>();
  const langScope = new Map<string, string>();
  for (const e of all) {
    const c = ((e.packageJSON as { contributes?: unknown })?.contributes ?? {}) as {
      languages?: Array<{ id?: string; extensions?: string[] }>;
      grammars?: Array<{ language?: string; scopeName?: string; path?: string }>;
    };
    for (const l of c.languages ?? []) {
      if (!l?.id || !Array.isArray(l.extensions)) continue;
      const arr = langExts.get(l.id) ?? [];
      arr.push(...l.extensions.filter((x): x is string => typeof x === 'string'));
      langExts.set(l.id, arr);
    }
    for (const g of c.grammars ?? []) {
      if (!g?.scopeName || !g.path) continue;
      if (!tmScopeToPath.has(g.scopeName)) tmScopeToPath.set(g.scopeName, path.join(e.extensionPath, g.path));
      // First contributor wins, matching the platform's own registration order.
      if (g.language && !langScope.has(g.language)) langScope.set(g.language, g.scopeName);
    }
  }
  for (const [lang, scope] of langScope) {
    for (const x of langExts.get(lang) ?? []) {
      const key = x.replace(/^\./, '').toLowerCase();
      if (key && !tmExtToScope.has(key)) tmExtToScope.set(key, scope);
    }
  }
}

/** The ACTIVE theme's token rules, include-chain resolved parent-first (children win ties — the
 *  workbench's own precedence). Null when the theme cannot be found or parsed. */
function tmThemeSettings(): vsctm.IRawTheme | null {
  const all = vscode.extensions?.all;
  const name = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme', '');
  if (!all || !name) return null;
  let file: string | null = null;
  for (const e of all) {
    const themes = (((e.packageJSON as { contributes?: { themes?: unknown } })?.contributes?.themes ?? []) as Array<{
      id?: string;
      label?: string;
      path?: string;
    }>);
    for (const t of themes) {
      if ((t.id === name || t.label === name) && t.path) {
        file = path.join(e.extensionPath, t.path);
        break;
      }
    }
    if (file) break;
  }
  if (!file) return null;
  const settings: Array<vsctm.IRawTheme['settings'][number]> = [];
  let defaultFg: string | undefined;
  const load = (p: string, depth: number): void => {
    if (depth > 5) return;
    let doc: unknown;
    try {
      doc = tmParseJsonc(fs.readFileSync(p, 'utf8'));
    } catch {
      return;
    }
    const d = doc as {
      include?: string;
      tokenColors?: unknown;
      settings?: unknown;
      colors?: Record<string, string>;
    } | null;
    if (!d) return;
    if (typeof d.include === 'string') load(path.join(path.dirname(p), d.include), depth + 1);
    defaultFg = d.colors?.['editor.foreground'] ?? defaultFg;
    const rules = Array.isArray(d.tokenColors) ? d.tokenColors : Array.isArray(d.settings) ? d.settings : [];
    for (const r of rules) {
      if (r && typeof r === 'object' && (r as { settings?: unknown }).settings) settings.push(r as vsctm.IRawTheme['settings'][number]);
    }
  };
  load(file, 0);
  if (!settings.length) return null;
  // A no-scope FIRST rule pins color id 1 to the theme's default foreground; the renderer SKIPS
  // that id, so default-colored tokens inherit the page's live CSS variable instead of a baked hex.
  return { name, settings: [{ settings: { foreground: defaultFg ?? '#000001' } }, ...settings] };
}

/** Build the registry once. Idempotent; leaves [tmRegistry] null when any piece is missing. */
function tmInit(): void {
  if (tmStarted) return;
  tmStarted = true;
  try {
    tmScan();
    const theme = tmThemeSettings();
    if (!tmScopeToPath.size || !theme) return;
    // esbuild inlines the wasm as a Uint8Array (--loader:.wasm=binary) — no file to ship or locate.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const wasm = require('vscode-oniguruma/release/onig.wasm') as Uint8Array;
    const onigLib = oniguruma
      .loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer)
      .then(() => ({
        createOnigScanner: (sources: string[]) => new oniguruma.OnigScanner(sources),
        createOnigString: (s: string) => new oniguruma.OnigString(s),
      }));
    tmRegistry = new vsctm.Registry({
      onigLib,
      loadGrammar: async (scopeName) => {
        const p = tmScopeToPath.get(scopeName);
        if (!p) return null;
        try {
          // parseRawGrammar dispatches on the file name: JSON grammars and plist .tmLanguage both load.
          return vsctm.parseRawGrammar(await fs.promises.readFile(p, 'utf8'), p);
        } catch {
          return null;
        }
      },
    });
    tmRegistry.setTheme(theme);
    tmColorMap = tmRegistry.getColorMap();
  } catch {
    tmRegistry = null; // any missing piece — the regex lexer serves instead
  }
}

/** The user switched themes: re-resolve the rules on the SAME registry (the wasm must load only
 *  once per process), or allow a fresh init when the first attempt never got off the ground. */
function tmOnThemeChanged(): void {
  if (!tmRegistry) {
    tmStarted = false;
    return;
  }
  const theme = tmThemeSettings();
  if (theme) {
    tmRegistry.setTheme(theme);
    tmColorMap = tmRegistry.getColorMap();
  }
}

function tmGrammarFor(ext: string): Promise<vsctm.IGrammar | null> {
  tmInit();
  if (!tmRegistry) return Promise.resolve(null);
  const scope = tmExtToScope.get(ext);
  if (!scope) return Promise.resolve(null);
  let p = tmGrammars.get(scope);
  if (!p) {
    p = tmRegistry.loadGrammar(scope).catch(() => null);
    tmGrammars.set(scope, p);
  }
  return p;
}

// vscode-textmate packs token attributes into one 32-bit word — these are its published
// EncodedTokenAttributes offsets (languageId 0-7, tokenType 8-10, fontStyle 11-14 as
// italic|bold|underline|strikethrough, foreground 15-23, background 24-31).
const TM_FG_MASK = 0b00000000111111111000000000000000;
const TM_FG_OFFSET = 15;
const TM_STYLE_MASK = 0b00000000000000000111100000000000;
const TM_STYLE_OFFSET = 11;

/** One line of code → theme-colored, escaped HTML + the tokenizer state the NEXT line continues
 *  from (diff lines are fed through as one pseudo-document, the standard diff-highlighter
 *  compromise). Tokens wearing the default color (id 1) stay unstyled so they follow the page's
 *  live editor-foreground variable. */
function tmLineHtml(
  grammar: vsctm.IGrammar,
  code: string,
  state: vsctm.StateStack | null
): { html: string; next: vsctm.StateStack } {
  const r = grammar.tokenizeLine2(code, state);
  const t = r.tokens;
  let html = '';
  for (let i = 0; i < t.length; i += 2) {
    const start = t[i];
    const end = i + 2 < t.length ? t[i + 2] : code.length;
    const chunk = hlEscape(code.slice(start, end));
    if (!chunk) continue;
    const meta = t[i + 1];
    const fg = (meta & TM_FG_MASK) >>> TM_FG_OFFSET;
    const st = (meta & TM_STYLE_MASK) >>> TM_STYLE_OFFSET;
    const style: string[] = [];
    if (fg > 1 && tmColorMap[fg]) style.push(`color:${tmColorMap[fg]}`);
    if (st & 1) style.push('font-style:italic');
    if (st & 2) style.push('font-weight:bold');
    if (st & 4) style.push('text-decoration:underline');
    html += style.length ? `<span style="${style.join(';')}">${chunk}</span>` : chunk;
  }
  return { html, next: r.ruleStack };
}

class ReviewViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly getPrompt: () => string | null) {}
  private view?: vscode.WebviewView;
  /** Fires after a webview-initiated mutation, wired to `refreshAll` in activate — the same "one
   *  refresh, every surface" rule every other mutation path follows. */
  onMutate?: () => void;
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = reviewShell();
    // The stacked page's token colors are RESOLVED from the active theme at render time (inline
    // hex, not CSS vars — the theme's token rules have no variable form), so a theme switch must
    // re-render an open stacked tab or its code keeps the old theme's colors under the new chrome.
    // (Optional call: the smoke harness has no theme event.)
    vscode.window.onDidChangeActiveColorTheme?.(() => {
      tmOnThemeChanged();
      if (this.stackedPanel && this.stackedSession) void this.renderStacked(this.stackedSession);
    });
    view.webview.onDidReceiveMessage((m: { type?: string; id?: number; file?: string; ids?: unknown }) => {
      if (!m) return;
      if (m.type === 'ready') this.refresh();
      else if (m.type === 'open' && typeof m.id === 'number') {
        const s = currentSession();
        if (!s) return;
        const rec = core.reviewEdits(s).find((r) => r.id === m.id) ?? core.findRecord(s, m.id);
        // The native diff for the row that was clicked — the collapsed record, so the two sides ARE
        // the unit's whole change. The panel itself shows no code; the editor is the diff surface.
        if (rec) void openDiff({ rec } as unknown as EditNode);
      } else if (m.type === 'keep' && typeof m.id === 'number') {
        const s = currentSession();
        if (!s) return;
        core.keepGroup(s, m.id);
        this.onMutate?.();
      } else if (m.type === 'undo' && typeof m.id === 'number') {
        const s = currentSession();
        if (!s) return;
        void undoOne(s, m.id).then(() => this.onMutate?.());
      } else if (m.type === 'keepAll') {
        const s = currentSession();
        if (!s) return;
        const p = this.getPrompt();
        // Session scope reuses the SAME command the status bar's Accept/Reject All run, so the
        // confirmation dialogs and counts are identical wherever the gesture starts.
        if (p) {
          keepPrompt(s, p);
          this.onMutate?.();
        } else void vscode.commands.executeCommand('claudeObservatory.keepAll', s).then(() => this.onMutate?.());
      } else if (m.type === 'undoAll') {
        const s = currentSession();
        if (!s) return;
        const p = this.getPrompt();
        if (p) void undoPrompt(s, p).then(() => this.onMutate?.());
        else void vscode.commands.executeCommand('claudeObservatory.undoAll', s).then(() => this.onMutate?.());
      } else if (m.type === 'openAllStacked') {
        const s = currentSession();
        if (s) this.openAllStackedInEditor(s, this.getPrompt());
      } else if (m.type === 'dismissCancelled' && Array.isArray(m.ids)) {
        // They were never a decision: keeping them is how the ledger records "seen, nothing to do".
        const s = currentSession();
        if (!s || !m.ids.length) return;
        const n = core.setStatusMany(s, m.ids as number[], 'kept').length;
        vscode.window.setStatusBarMessage(`OAK: dismissed ${n} cancelled-out edit(s)`, 3000);
        this.onMutate?.();
      } else if (m.type === 'clearResolved') {
        // The SAME command the Overview toolbar runs — its confirm dialog and counts included.
        const s = currentSession();
        if (s) void vscode.commands.executeCommand('claudeObservatory.clearResolved', s).then(() => this.onMutate?.());
      } else if (m.type === 'setQuery') {
        // The inline toolbar's search field — the same shared state the Overview writes, so both
        // navbars filter as one (see the applyQuery/applyFilterSpec commands).
        void vscode.commands.executeCommand('claudeObservatory.applyQuery', String((m as { q?: unknown }).q ?? ''));
      } else if (m.type === 'setFilterSpec') {
        void vscode.commands.executeCommand('claudeObservatory.applyFilterSpec', m as { exts?: unknown; categories?: unknown });
      } else if (m.type === 'setSort') {
        void vscode.commands.executeCommand('claudeObservatory.applySort', String((m as { sort?: unknown }).sort ?? ''));
      } else if (m.type === 'cycleSort') {
        void vscode.commands.executeCommand('claudeObservatory.cycleSort');
      } else if (m.type === 'redo' && typeof m.id === 'number') {
        // Review is the ONLY review surface now — the redo verb the Edits tree used to carry lives
        // on the greyed undone rows here. Through redoOne, NOT core.redoGroup directly: the shared
        // path carries the dirty-buffer guard and the conflict "Force re-apply" offer.
        const s = currentSession();
        if (!s) return;
        void redoOne(s, m.id).then(() => this.onMutate?.());
      } else if (m.type === 'openFile' && typeof m.file === 'string' && m.file) {
        // The FILENAME opens the file itself — the row heads open diffs. Two different asks, and
        // the filename was the one dead element on the header. Missing files get the editor's own
        // error, which names the path — honest enough without a second message layer.
        void vscode.window.showTextDocument(vscode.Uri.file(m.file), { preview: true }).then(undefined, (e) => {
          vscode.window.showWarningMessage(`Could not open ${m.file}: ${String((e as Error)?.message ?? e)}`);
        });
      } else if (m.type === 'redoFile' && typeof m.file === 'string') {
        // The forward mirror of undoFile, through core's own path scope — ONE call backed by
        // `redoScope`, exactly as the CLI's `redo --under` and the terminal's [ Redo ] button use,
        // so the three front ends cannot drift about what "this file" means.
        const s = currentSession();
        if (!s) return;
        const file = m.file;
        const ids = core
          .reviewEdits(s)
          .filter((rec) => rec.status === 'undone' && rec.file === file)
          .map((rec) => rec.id);
        if (!ids.length) return;
        void (async () => {
          if (await blockedByDirtyBuffer(file)) return;
          const choice = await vscode.window.showWarningMessage(
            `Re-apply ${ids.length} undone edit(s) in ${path.basename(file)}? This rewrites the file on disk.`,
            { modal: true },
            'Redo'
          );
          if (choice !== 'Redo') return;
          const res = core.redoScope(s, { ids });
          bulkToast(`Re-applied ${res.redone} edit(s)` + conflictNote(res, 'redo individually to force') + '.', res);
          this.onMutate?.();
        })();
      } else if ((m.type === 'keepFile' || m.type === 'undoFile') && typeof m.file === 'string') {
        // The structural scope the tree's file nodes used to carry: act on every PENDING record in
        // ONE file, group-safe because the id set is raw records, not display units.
        const s = currentSession();
        if (!s) return;
        const file = m.file;
        // EXACTLY the view's scope — the listed pending units' members, never a session-wide file
        // sweep: with Review scoped to one ask, a whole-log filter would silently accept OTHER
        // asks' pending edits in the same file, beyond what the header's count claimed.
        const ids = this.scopedPendingIdsForFile(s, file);
        if (!ids.length) return;
        if (m.type === 'keepFile') {
          const n = core.setStatusMany(s, ids, 'kept').length;
          vscode.window.showInformationMessage(`Accepted ${n} edit(s) in ${path.basename(file)}.`);
          this.onMutate?.();
        } else {
          void (async () => {
            // Same dirty-buffer guard as every sibling revert path: reverting under an unsaved
            // buffer means the user's next save silently re-applies the rejected content.
            if (await blockedByDirtyBuffer(file)) return;
            const choice = await vscode.window.showWarningMessage(
              `Reject ${ids.length} pending edit(s) in ${path.basename(file)}?`, { modal: true }, 'Reject');
            if (choice !== 'Reject') return;
            const res = core.undoScope(s, { ids });
            bulkToast(`Reverted ${res.undone} edit(s)` + conflictNote(res, 'revert individually to force') + '.', res);
            this.onMutate?.();
          })();
        }
      }
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) this.refresh();
    });
  }
  /**
   * The whole scope in ONE editor view — the selected ask's units, or every unit in the session when
   * no prompt is picked: the native multi-diff editor (`vscode.changes`) fed each unit's net blob
   * pair — the same URIs the per-unit header opens, concatenated the way VS Code itself renders a
   * changeset. Falls back to a single `.diff` document when the command is missing (an older fork),
   * so the gesture never dies silently.
   */
  /** The rows an "open all" acts on: the picked ask's units or the whole session — pending only,
   *  never a cancelled-out chain (the panel hides those; a view that disagreed with the panel's own
   *  count taught the reader to distrust both). One derivation for BOTH open-all views. */
  private pendingScope(session: string, promptId: string | null): { r: core.SessionPrompt | null; recs: core.EditRecord[] } {
    const root = workspaceRoot() ?? process.cwd();
    const r = promptId ? (core.sessionPrompts(root, session).find((x) => x.id === promptId) ?? null) : null;
    const byId = new Map(core.reviewEdits(session).map((rec) => [rec.id, rec]));
    const cancelled = core.cancelledGroups(session);
    const recs = (r ? r.editIds : [...byId.keys()])
      .map((id) => byId.get(id))
      .filter((x): x is core.EditRecord => !!x && x.status === 'pending' && !cancelled.has(x.id));
    return { r, recs };
  }
  private async openAllInEditor(session: string, promptId: string | null): Promise<void> {
    // Exactly the rows the panel lists: pending, and never a cancelled-out chain — opening "all"
    // over units the list hides would put empty-vs-empty diffs in the tab and make its "N change(s)"
    // title disagree with the panel beside it.
    const { r, recs } = this.pendingScope(session, promptId);
    if (!recs.length) {
      vscode.window.setStatusBarMessage(`OAK: nothing pending ${r ? 'from this ask' : 'in this session'}`, 3000);
      return;
    }
    // The EXACT triple shape the multi-diff editor is proven to render (real file as the row
    // resource, the same /before//after blob URIs the single diff uses). A "nicer" shared-path
    // variant shipped once and broke the view — this shape is load-bearing; per-row actions ride in
    // as comment-thread review bars on the after documents instead (DiffBars).
    // Long diffs are PREVIEWED here — bounded to the budget, with what is missing named inside the
    // row and on its bar — because the multi-diff editor caps nothing per row and one wholesale
    // rewrite otherwise buries every other change in the ask.
    const budget = Math.max(0, vscode.workspace.getConfiguration('claudeObservatory').get<number>('openAllPreviewLines', 50));
    const resources = recs.map((rec) => {
      const d = core.lineDelta(session, rec);
      const pv = budget > 0 && d.added + d.removed > budget ? budget : undefined;
      return [
        vscode.Uri.file(rec.file),
        blobUri(session, rec.beforeBlob, rec.file, 'before', rec.id, undefined, pv),
        blobUri(session, rec.afterBlob, rec.file, 'after', rec.id, rec.beforeBlob, pv),
      ];
    });
    const title = `${r ? `prompt #${r.index}` : 'session'} — ${recs.length} change(s)`;
    try {
      await vscode.commands.executeCommand('vscode.changes', title, resources);
      // Rows stay EXPANDED and lean on the diff editor's own hidden-unchanged folds ("N hidden
      // lines", with the chevron that reveals them) — the shape the reader asked for. Collapsing
      // every row was tried and hid the changes behind a second click; the folds bound the height
      // where there IS unchanged text, and a wholesale rewrite is honestly tall.
    } catch {
      const patch = recs.map((rec) => core.coloredDiff(session, rec, false)).join('\n');
      const doc = await vscode.workspace.openTextDocument({ content: patch, language: 'diff' });
      await vscode.window.showTextDocument(doc, { preview: false });
    }
  }
  /**
   * The STACKED open-all view: the same scope as [openAllInEditor], but each
   * change rendered INLINE — removed and added lines interleaved, one column, read top to bottom —
   * with the Spotlight toggle that dims the unmodified context so the changes carry the page. A
   * webview, because the native multi-diff owns its editors and offers no seam for either the
   * inline layout or the dim. This is THE "Open all in editor" view (one opener,
   * stacked by default; the bar's Side-by-side button beside Spotlight opens the native multi-diff).
   * Blocks carry ✓ Keep / ✗ Undo; a decided block stays visible under its verdict with its one
   * remaining verb (kept → ↺ Revert, reverted → ↻ Redo) rather than going inert mid-read. Code
   * keeps its IDE syntax colors inside the green/red bands (the editor's own TextMate grammar +
   * active theme, per tmGrammarFor), lines wrap to the window, and a tall block scrolls inside its
   * own box.
   */
  private stackedPanel?: vscode.WebviewPanel;
  private stackedIds: number[] = [];
  /** The snapshot's session, held for re-renders the panel itself does not initiate (theme switch). */
  private stackedSession?: string;
  private openAllStackedInEditor(session: string, promptId: string | null): void {
    const { r, recs } = this.pendingScope(session, promptId);
    if (!recs.length) {
      vscode.window.setStatusBarMessage(`OAK: nothing pending ${r ? 'from this ask' : 'in this session'}`, 3000);
      return;
    }
    this.openStacked(session, recs, `${r ? `prompt #${r.index}` : 'session'} — ${recs.length} change(s) · stacked`, promptId);
  }
  /** The feed's edit-item opener: a file's edits open as the STACKED layout,
   *  scoped to that file — every non-cancelled unit, decided ones included, since the blocks carry
   *  verdicts and their remaining verb. Not pendingScope: a fully decided file would open empty. */
  openFileStacked(session: string, editId: number): void {
    const rec0 = core.findRecord(session, editId);
    if (!rec0) {
      vscode.window.setStatusBarMessage('OAK: that edit is no longer in the log', 3000);
      return;
    }
    const cancelled = core.cancelledGroups(session);
    const recs = core.reviewEdits(session).filter((x) => x.file === rec0.file && !cancelled.has(x.id));
    if (!recs.length) {
      vscode.window.setStatusBarMessage('OAK: nothing to review for that file', 3000);
      return;
    }
    this.openStacked(session, recs, `${path.basename(rec0.file)} — ${recs.length} change(s) · stacked`, null);
  }
  private openStacked(session: string, recs: core.EditRecord[], title: string, promptId: string | null): void {
    // A snapshot, like the side-by-side view: the blocks are decided-from, not live-tracked. Ids are
    // pinned so a keep/undo re-render shows the SAME blocks with fresh verdicts.
    this.stackedIds = recs.map((x) => x.id);
    this.stackedSession = session;
    this.stackedPanel?.dispose();
    const panel = vscode.window.createWebviewPanel(
      'claudeObservatory.reviewAllStacked',
      title,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.stackedPanel = panel;
    panel.onDidDispose(() => {
      if (this.stackedPanel === panel) this.stackedPanel = undefined;
    });
    panel.webview.onDidReceiveMessage((m: { type?: string; id?: number }) => {
      if (!m) return;
      if (m.type === 'keep' && typeof m.id === 'number') {
        core.keepGroup(session, m.id);
        this.onMutate?.();
        this.patchStacked(session, m.id);
      } else if (m.type === 'undo' && typeof m.id === 'number') {
        const id = m.id;
        void undoOne(session, id).then(() => {
          this.onMutate?.();
          this.patchStacked(session, id);
        });
      } else if (m.type === 'redo' && typeof m.id === 'number') {
        // The forward verb for a block already reverted — through redoOne, the same shared path the
        // Review panel's ↻ rides (dirty-buffer guard + the conflict "Force re-apply" offer).
        const id = m.id;
        void redoOne(session, id).then(() => {
          this.onMutate?.();
          this.patchStacked(session, id);
        });
      } else if (m.type === 'sideBySide') void this.openAllInEditor(session, promptId);
    });
    this.renderStacked(session);
  }
  /** One block's action row — buttons while pending, verdict + the remaining verb once decided:
   *  kept → revert (the ↺ undo arrow), reverted → redo — instead of going inert the moment it is
   *  decided (the per-block Chat button is gone too — chat stays on
   *  the inline lens, the review bar and the bubble). The glyph and the word are separate spans:
   *  below the block's icon-width threshold the words hide and the glyphs alone remain, so the verb
   *  pair NEVER leaves its one line (a window too small shows just the
   *  icons; the tooltips carry the words). Shared by the full render and the per-click patch, so
   *  the two can never disagree about what a status offers. */
  private stackedActs(rec: core.EditRecord): string {
    return rec.status === 'pending'
      ? `<button class="bt keep" data-keep="${rec.id}" title="Keep this edit">✓<span class="lbl"> Keep</span></button><button class="bt undo" data-undo="${rec.id}" title="Revert this edit on disk">✗<span class="lbl"> Undo</span></button>`
      : rec.status === 'kept'
        ? `<span class="vd keep">✓<span class="lbl"> kept</span></span><button class="bt undo" data-undo="${rec.id}" title="Revert this kept edit — its change comes off disk">↺<span class="lbl"> Revert</span></button>`
        : `<span class="vd undo">✗<span class="lbl"> reverted</span></span><button class="bt redo" data-redo="${rec.id}" title="Re-apply this reverted edit">↻<span class="lbl"> Redo</span></button>`;
  }
  /** A decision's targeted update: swap the ONE clicked block's action row (and its done dim) via
   *  postMessage instead of reassigning webview.html — the full document reload measured 3–5 s per
   *  click at a real session's 378 blocks, and it also reset scroll and Spotlight, which the
   *  save-restore only papered over. The block's DIFF never changes on keep/undo/redo (it renders
   *  the edit's own before→after, not the file), so the action row is the whole delta. */
  private patchStacked(session: string, id: number): void {
    const panel = this.stackedPanel;
    if (!panel) return;
    const rec = core.reviewEdits(session).find((r) => r.id === id) ?? core.findRecord(session, id);
    if (!rec) return; // cleared mid-flight — the block keeps its last verbs, and a click on them fails loud
    void panel.webview.postMessage({ type: 'acts', id, done: rec.status !== 'pending', html: this.stackedActs(rec) });
  }
  private async renderStacked(session: string): Promise<void> {
    const panel = this.stackedPanel;
    if (!panel) return;
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const byId = new Map(core.reviewEdits(session).map((rec) => [rec.id, rec]));
    // The same per-block bound the side-by-side view budgets with — a patch mixes both sides, so the
    // allowance is doubled — and what is cut is named in the block, never silently.
    const budget = Math.max(0, vscode.workspace.getConfiguration('claudeObservatory').get<number>('openAllPreviewLines', 50)) * 2;
    const blocks: string[] = [];
    for (const id of this.stackedIds) {
      const rec = byId.get(id);
      if (!rec) continue;
      const d = core.lineDelta(session, rec);
      const patch = core.coloredDiff(session, rec, false);
      const all = patch.split('\n');
      const start = all.findIndex((l) => l.startsWith('@@'));
      let lines = (start >= 0 ? all.slice(start) : all).filter((l, i, a) => l.length > 0 || i < a.length - 1);
      let more = '';
      if (budget > 0 && lines.length > budget) {
        const n = lines.length - budget;
        more = `+${n} more diff line${n === 1 ? '' : 's'} — this block is previewed; open its full diff from the Review panel`;
        lines = lines.slice(0, budget);
      }
      // Syntax colors INSIDE the bands: the ± marker stays plain, the code after
      // it is tokenized per the file's language — with the EDITOR'S OWN pipeline (the contributed
      // TextMate grammar + the active theme's rules) when it resolves, the regex lexer otherwise.
      // The add/del backgrounds carry the diff reading either way.
      const ext = path.extname(rec.file).slice(1).toLowerCase();
      const grammar = await tmGrammarFor(ext);
      let tmState: vsctm.StateStack | null = grammar ? vsctm.INITIAL : null;
      const body = lines
        .map((line) => {
          const k = line.startsWith('@@') ? 'hunk' : line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx';
          let html: string;
          if (k === 'hunk') html = esc(line);
          else if (grammar) {
            const res = tmLineHtml(grammar, line.slice(1), tmState);
            tmState = res.next;
            html = esc(line[0] ?? ' ') + res.html;
          } else {
            html = esc(line[0] ?? ' ') + hlLine(line.slice(1), ext);
          }
          return `<div class="ln ${k}">${html || '&nbsp;'}</div>`;
        })
        .join('');
      blocks.push(
        `<section class="blk${rec.status === 'pending' ? '' : ' done'}">` +
        `<header><span class="id">#${rec.id}</span><span class="file" title="${esc(rec.file)}">${esc(core.relPath(workspaceRoot() ?? process.cwd(), rec.file))}</span>` +
        `<span class="delta">+${d.added} −${d.removed}</span><span class="sp"></span>` +
        // The action row is addressable (data-acts) so a decision can PATCH this one block in place
        // — see patchStacked; re-rendering the whole document per click measured 3–5 s on a real
        // 378-block session, nearly all of it webview reload.
        `<span class="acts" data-acts="${rec.id}">${this.stackedActs(rec)}</span></header>` +
        `<pre class="diff">${body}</pre>` +
        // OUTSIDE the scroll box: appended inside it, the note was invisible until the reader had
        // already scrolled the box to its bottom — the one place it carries no news.
        (more ? `<div class="fold">${esc(more)}</div>` : '') +
        `</section>`
      );
    }
    // The grammar awaits yield the loop — a panel disposed or replaced mid-render must not be
    // written to (a disposed webview throws; a replaced one would show the wrong scope).
    if (this.stackedPanel !== panel) return;
    const nonce = getNonce();
    panel.webview.html =
      `<!DOCTYPE html><html><head><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">` +
      `<style>` +
      `body{font-family:var(--vscode-editor-font-family,monospace);font-size:var(--vscode-editor-font-size,13px);padding:0 0 24px;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background)}` +
      // flex-wrap: whole BUTTONS may flow to a second bar row at extreme widths — a button's label
      // never splits (nowrap on .bt), and clipping the switch away would be worse.
      `.bar{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:6px 10px;background:var(--vscode-editorGroupHeader-tabsBackground,var(--vscode-editor-background));border-bottom:1px solid var(--vscode-panel-border)}` +
      `.bar .ttl{opacity:.75;margin-right:auto}` +
      // One size for every button (they drifted): same font, same line box —
      // the emoji glyphs that inflated some of them are gone from the labels too.
      `.bt{cursor:pointer;border:1px solid var(--vscode-button-border,transparent);border-radius:3px;padding:2px 8px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);font-family:var(--vscode-font-family,sans-serif);font-size:12px;line-height:16px;height:22px;box-sizing:border-box;white-space:nowrap}` +
      `.bt:hover{background:var(--vscode-button-secondaryHoverBackground)}` +
      `.bt[aria-pressed="true"]{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}` +
      `.blk{margin:12px 10px;border:1px solid var(--vscode-panel-border);border-radius:4px;overflow:hidden;container-type:inline-size}` +
      // ONE line, always: the header never wraps, the action row never shrinks,
      // and the FILE PATH is the only thing that gives — it ellipsizes (its title attribute carries
      // the full path, the same clip-with-tooltip the JetBrains stacked header uses).
      `.blk header{display:flex;flex-wrap:nowrap;gap:10px;align-items:center;padding:5px 10px;background:var(--vscode-editorGroupHeader-tabsBackground,transparent);border-bottom:1px solid var(--vscode-panel-border)}` +
      `.blk.done header{opacity:.75}` +
      `.blk .id{opacity:.6}.blk .delta{opacity:.75;white-space:nowrap}.blk .sp{margin-left:auto}` +
      `.blk .file{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}` +
      // The action row is ONE span (so a decision can patch it), so the header's flex gap cannot
      // separate its buttons — it spaces them itself (Keep and Undo touched).
      `.acts{display:inline-flex;gap:6px;align-items:center;flex:none}` +
      // The icon-width fallback: in a narrow block the words hide and the ✓/✗/↺/↻ glyphs alone
      // remain — the pair stays on its line instead of wrapping or clipping away.
      `@container (max-width:460px){.lbl{display:none}}` +
      `.vd.keep{color:var(--vscode-charts-green)}.vd.undo{color:var(--vscode-charts-red)}` +
      `.bt.keep{color:var(--vscode-charts-green)}.bt.undo{color:var(--vscode-charts-red)}.bt.redo{color:var(--vscode-charts-blue)}` +
      // Each box scrolls ITSELF when tall — the page stays a stack of bounded
      // blocks — and lines WRAP to the window: horizontal scrolling never, per-box vertical when needed.
      `pre.diff{margin:0;padding:6px 0;max-height:60vh;overflow-y:auto;overflow-x:hidden}` +
      // Hanging indent: the ± marker owns the first column and wrapped continuations align UNDER
      // the code, not under the marker — one line of CSS, verified in Blink during review.
      `.ln{padding:0 10px 0 calc(10px + 1ch);text-indent:-1ch;white-space:pre-wrap;overflow-wrap:anywhere}` +
      // The bands carry add/del (no foreground override any more — the tokens below keep their
      // syntax colors inside the green/red, which was the ask).
      `.ln.add{background:var(--vscode-diffEditor-insertedLineBackground,rgba(60,180,90,.15))}` +
      `.ln.del{background:var(--vscode-diffEditor-removedLineBackground,rgba(220,80,80,.15))}` +
      `.ln.hunk{opacity:.65;color:var(--vscode-charts-blue)}` +
      `.fold{opacity:.6;font-style:italic;padding:3px 10px;border-top:1px solid var(--vscode-panel-border)}` +
      `.tk-k{color:var(--vscode-charts-purple,#b180d7)}` +
      `.tk-s{color:var(--vscode-charts-orange,#d19a66)}` +
      `.tk-n{color:var(--vscode-charts-blue,#61afef)}` +
      `.tk-c{color:var(--vscode-descriptionForeground,#8b949e);font-style:italic}` +
      // THE SPOTLIGHT: dim what was not modified, so the changes carry the page.
      `body.spot .ln.ctx{opacity:.35}` +
      `</style></head><body class="spot">` +
      `<div class="bar"><span class="ttl">stacked — removed/added inline</span>` +
      // Spotlight is ON by default — server-rendered on, so there is no flash;
      // the saved state below only ever turns it OFF (st.spot === false is the reader's own choice).
      `<button class="bt" id="spot" aria-pressed="true" title="Dim the unmodified context lines">Spotlight</button>` +
      `<button class="bt" id="sbs" title="The same changes in the native side-by-side multi-diff">Side by side</button></div>` +
      blocks.join('') +
      `<script nonce="${nonce}">` +
      `const vscode=acquireVsCodeApi();` +
      // A keep/undo re-renders the whole document — restore the reader's place and their Spotlight,
      // or every decision teleports them back to the top with the dim reset.
      `const st=vscode.getState()||{};` +
      `if(st.spot===false){document.body.classList.remove('spot');document.getElementById('spot').setAttribute('aria-pressed','false')}` +
      `if(st.y)window.scrollTo(0,st.y);` +
      `window.addEventListener('scroll',function(){const s=vscode.getState()||{};s.y=window.scrollY;vscode.setState(s)});` +
      `document.getElementById('spot').onclick=function(){const on=document.body.classList.toggle('spot');this.setAttribute('aria-pressed',String(on));const s=vscode.getState()||{};s.spot=on;vscode.setState(s)};` +
      `document.getElementById('sbs').onclick=function(){vscode.postMessage({type:'sideBySide'})};` +
      `document.body.addEventListener('click',function(e){const t=e.target.closest?e.target.closest('[data-keep],[data-undo],[data-redo]'):null;if(!t)return;` +
      `if(t.dataset.keep)vscode.postMessage({type:'keep',id:Number(t.dataset.keep)});` +
      `else if(t.dataset.undo)vscode.postMessage({type:'undo',id:Number(t.dataset.undo)});` +
      `else vscode.postMessage({type:'redo',id:Number(t.dataset.redo)})});` +
      // The per-click patch: swap ONE block's action row and its done dim — scroll and Spotlight
      // are untouched because the document never reloads.
      `window.addEventListener('message',function(ev){var m=ev.data||{};if(m.type!=='acts')return;` +
      `var el=document.querySelector('[data-acts="'+m.id+'"]');if(!el)return;el.innerHTML=m.html;` +
      `var blk=el.closest('section.blk');if(blk)blk.classList.toggle('done',!!m.done)});` +
      `</script></body></html>`;
  }

  /** The raw member ids behind THIS view's pending units for one file — prompt-scoped when a prompt
   *  is picked. The file headers' bulk verbs act on exactly these, so a click never reaches beyond
   *  what the header's count displayed. */
  private scopedPendingIdsForFile(session: string, file: string): number[] {
    const root = workspaceRoot() ?? process.cwd();
    const promptId = this.getPrompt();
    const r = promptId ? (core.sessionPrompts(root, session).find((x) => x.id === promptId) ?? null) : null;
    const byId = new Map(core.reviewEdits(session).map((rec) => [rec.id, rec]));
    const hidden = core.cancelledMemberIds(session, 'pending');
    const ids = (r ? r.editIds : [...byId.keys()])
      .map((id) => byId.get(id))
      .filter((x): x is core.EditRecord => !!x && x.status === 'pending' && x.file === file && !hidden.has(x.id))
      .flatMap((x) => core.groupMembers(session, x.id));
    return [...new Set(ids)];
  }

  // The panel shows NO code — it is the list (id, path, ±counts, keep/undo); every diff renders in
  // the editor, one unit per row click or the whole scope at once. So the payload here is rows only:
  // no patch HTML, no size budget. The DEFAULT scope is the whole session — a tab with no prompt
  // picked loses nothing — and selecting a prompt filters it to that ask.
  refresh(): void {
    if (!this.view) return;
    const session = currentSession();
    // The badge's whole job is signaling while you are NOT looking at the view — set it BEFORE the
    // visibility gate (cheap: reviewEdits is memoized), or an Accept All with the container closed
    // freezes the count until the next reveal. (A webview view resolves lazily, so before its first
    // reveal there is still no badge at all — a platform limit, noted rather than hidden.)
    // Cancelled chains are excluded here for the same reason the list excludes them: a badge that
    // counts rows the panel refuses to show sends you to look for work that is not there.
    const badgeHidden = session ? core.cancelledMemberIds(session, 'pending') : new Set<number>();
    const badgeCount = session
      ? core.reviewEdits(session).filter((x) => x.status === 'pending' && !badgeHidden.has(x.id)).length
      : 0;
    this.view.badge = badgeCount ? { value: badgeCount, tooltip: `${badgeCount} pending edit(s)` } : undefined;
    if (!this.view.visible) return;
    if (!session) {
      this.view.webview.postMessage({ type: 'review', data: null });
      return;
    }
    const root = workspaceRoot() ?? process.cwd();
    const promptId = this.getPrompt();
    // The title bar's bulk verbs are SESSION-wide; the body's are scoped to the picked ask. Offering
    // both at once put a one-click "accept everything" directly above a button reading "Keep all (7)"
    // — same words, a different blast radius. While a prompt is picked, the scoped ones are the only
    // ones shown, so the count on screen is the work the button acts on.
    void vscode.commands.executeCommand('setContext', 'claudeObservatory.reviewScoped', !!promptId);
    // A stale pick (a prompt id the session no longer answers) falls back to the session-wide list
    // rather than a blank panel.
    const r = promptId ? (core.sessionPrompts(root, session).find((x) => x.id === promptId) ?? null) : null;
    const byId = new Map(core.reviewEdits(session).map((rec) => [rec.id, rec]));
    const unitIds = r ? r.editIds : [...byId.keys()];
    const errors: string[] = [];
    // Chains that go nowhere (created then deleted, or put back) are not rows — they are one footer
    // line with a Dismiss, because a row that costs a decision and shows an empty diff says nothing.
    const cancelledMap = core.cancelledGroups(session);
    // …and one that was already dismissed is still nothing to look at: `cancelledGroups` answers the
    // PENDING question (what Dismiss acts on), so without this the same chains came straight back as
    // greyed rows the moment they were kept — thousands of them on a real session.
    const hidden = core.cancelledMemberIds(session);
    const cancelledIds: number[] = [];
    let cancelledUnits = 0;
    const units = unitIds.flatMap((id) => {
      const rec = byId.get(id);
      if (!rec) {
        // A display id with no record behind it is a bug upstream, not an empty unit — say so rather
        // than posting a hole the panel would draw as "no changes" (same rule as the CLI's review).
        errors.push(`unit #${id} is named by this prompt but has no record in the log`);
        return [];
      }
      const cancelledMembers = cancelledMap.get(id);
      if (cancelledMembers) {
        cancelledUnits++;
        cancelledIds.push(...cancelledMembers);
        return [];
      }
      if (hidden.has(id)) return []; // a cancelled chain that has already been decided
      const d = core.lineDelta(session, rec);
      const members = core.groupMembers(session, id);
      const rel = core.relPath(root, rec.file);
      return [{
        id,
        rel,
        file: rec.file,
        status: rec.status,
        added: d.added,
        removed: d.removed,
        members: members.length,
        ext: core.fileExt(rel), // for the extension filter
        category: core.fileCategory(rel), // for the file-type filter
        ts: rec.ts, // for the "N min ago" column + the time sort


        // reader acts, not explained after undo refuses.
        ...((rec.partial || core.uncertainCreation(rec)) ? { partial: true } : {}),
        capture: core.captureSummary(rec),
      }];
    });
    // Search-edits narrows THIS list too — with the trees gone, a search that skipped the one
    // review surface would search everywhere except where you review. Bulk actions hide while a
    // filter is active (they act on prompt/session scope, wider than what a filtered list shows).
    const spec = { query: editFilter, exts: filterExts, categories: filterCats };
    const anyFilter = !!editFilter || filterExts.length > 0 || filterCats.length > 0;
    const listed = anyFilter ? units.filter((u) => core.matchesFileFilter(u.rel, u.ext, u.category, spec)) : units;
    const pending = listed.filter((u) => u.status === 'pending').length;
    // The filter rides the payload: without it the renderer could not tell "this session has no
    // changes" from "your search matched none of them", and its bulk buttons showed the FILTERED
    // count while acting on the whole scope — the comment above claimed they hid, and nothing did it.
    const filter = editFilter || '';
    this.view.webview.postMessage({
      type: 'review',
      data: {
        scoped: !!r,
        filter,
        sort: currentSort(),
        // The inline toolbar's own state: what type/extension narrowing is on, and which types and
        // extensions this session actually has (so the dropdown offers only what can match).
        filterSpec: { exts: filterExts, categories: filterCats as string[] },
        presentCats: core.FILE_CATEGORIES.filter((c) => units.some((u) => u.category === c)),
        presentExts: [...new Set(units.map((u) => u.ext).filter(Boolean))].sort(),
        index: r ? r.index : null,
        title: r ? r.title : '',
        pending,
        // The FILTERED rows, matching the counts beside them: posting every unit under a narrowed
        // "Keep all (N)" made the buttons act on more than the list showed.
        units: listed,
        cancelled: cancelledUnits,
        cancelledIds,
        errors,
      },
    });
  }
}

const REVIEW_SCRIPT = `
(function(){
  var vscode = acquireVsCodeApi();
  var DATA = null;
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function glyph(st){ return st==='kept' ? '✓' : st==='undone' ? '✗' : '●'; }
  function render(){
    var host = document.getElementById('rv');
    if(!DATA){
      host.innerHTML = '<div class="rv-empty">No session is under observation yet. Once an agent works in this workspace, this panel lists the session’s changes — repeated edits to the same code read as ONE change. Click a row for its net diff, or open the whole list as one editor view; picking a prompt (the review button on its <b>Prompts</b> row, or the nav bar’s Prompt axis) scopes the list to that ask.</div>';
      return;
    }
    var scope = DATA.scoped ? 'this ask produced' : 'in this session';
    var h = (DATA.scoped
        ? '<div class="rv-head"><span class="rv-ix">#'+esc(DATA.index)+'</span><span class="rv-title">'+esc(DATA.title)+'</span></div>'
        : '<div class="rv-head"><span class="rv-title">Changes this session</span><span class="rv-hint">pick a prompt to scope</span></div>')+
      (DATA.units.length && !DATA.filter?
        '<div class="rv-acts">'+
        // ONE opener: stacked is the default view, and the stacked tab itself
        // carries the side-by-side switch next to Spotlight — two buttons here made one decision
        // (read the changes) look like two.
        '<button class="rv-btn" data-act="openAllStacked" title="Every pending change '+scope+' in one editor tab — stacked (removed/added lines inline) with a Spotlight toggle; the bar up top switches to the side-by-side view">Open all in editor</button>'+
        (DATA.pending?
          '<button class="rv-btn" data-act="keepAll" title="Keep every pending edit '+scope+'">Keep all ('+DATA.pending+')</button>'+
          '<button class="rv-btn" data-act="undoAll" title="Revert every pending edit '+scope+'">Undo all</button>' : '')+
        (DATA.units.some(function(u){return u.status!=='pending';})?
          '<button class="rv-btn" data-act="clearResolved" title="Drop the kept/reverted records and keep the pending ones — shortens a long session">Clear resolved</button>' : '')+
        '</div>'
        : (DATA.units.length && DATA.filter
            ? '<div class="rv-filter">filtered by <b>'+esc(DATA.filter)+'</b> — bulk actions act on the whole '+(DATA.scoped?'ask':'session')+', so they are hidden while a filter is on</div>'
            : ''));
    if(!DATA.units.length && !(DATA.errors&&DATA.errors.length)) h += '<div class="rv-empty">'+(DATA.filter
      ? 'No changes match <b>'+esc(DATA.filter)+'</b>. Clear the search to see the rest.'
      : 'No changes '+(DATA.scoped?'from this ask':'in this session')+' yet.')+'</div>';
    for(var j=0;j<(DATA.errors||[]).length;j++) h += '<div class="rv-err">'+esc(DATA.errors[j])+'</div>';
    // Grouped by FILE — the structural scope the old Edits tree carried. Rows keep log order inside
    // their file; a PENDING unit is first-class, a resolved record renders greyed with the verb that
    // still applies to it (kept → undo, undone → redo). This list is the ONLY review surface.
  function relAge(ts){ if(!ts) return '—'; var d=new Date(ts), n=new Date(); function p2(x){ return (x<10?'0':'')+x; }
    var MN=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if(d.getFullYear()===n.getFullYear() && d.getMonth()===n.getMonth() && d.getDate()===n.getDate()) return p2(d.getHours())+':'+p2(d.getMinutes())+':'+p2(d.getSeconds());
    if(d.getFullYear()===n.getFullYear()) return MN[d.getMonth()]+' '+d.getDate()+' '+p2(d.getHours())+':'+p2(d.getMinutes());
    return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate()); }
    var groups = Object.create(null); var order = []; /* null-proto: a file named "constructor" must not collide with Object.prototype */
    for(var i=0;i<DATA.units.length;i++){ var u0=DATA.units[i]; if(!groups[u0.rel]){ groups[u0.rel]=[]; order.push(u0.rel); } groups[u0.rel].push(u0); }
    // Per-file freshest edit time — the "N min ago" value and the time-sort key.
    var gTs=Object.create(null); for(var gi=0;gi<order.length;gi++){ var mx=0; var gu=groups[order[gi]]; for(var gj=0;gj<gu.length;gj++){ if((gu[gj].ts||0)>mx) mx=gu[gj].ts||0; } gTs[order[gi]]=mx; }
    if((DATA.sort||'time')==='name') order.sort(function(a,b){ return a.localeCompare(b); });
    else order.sort(function(a,b){ return (gTs[b]||0)-(gTs[a]||0) || a.localeCompare(b); }); // 'time' (default)
    for(var g=0;g<order.length;g++){
      var rel = order[g]; var us = groups[rel];
      var pend = 0, undone = 0;
      for(var p=0;p<us.length;p++){ if(us[p].status==='pending') pend++; else if(us[p].status==='undone') undone++; }
      h += '<div class="rv-file"><span class="rv-age" title="last edited '+relAge(gTs[rel])+'">'+relAge(gTs[rel])+'</span><span class="rv-frel" data-openfile="'+esc(us[0].file)+'" title="Open this file in the editor">'+esc(rel)+'</span><span class="rv-fmeta">'+(pend?pend+' pending':'resolved')+'</span>'+
        (pend? '<span class="rv-ubtns">'+
          '<button class="rv-btn" data-keepfile="'+esc(us[0].file)+'" title="Keep every pending edit in this file">✓ file</button>'+
          '<button class="rv-btn" data-undofile="'+esc(us[0].file)+'" title="Revert every pending edit in this file">✗ file</button></span>' : '')+
        // A file with nothing pending but something REVERTED offers the one verb left: putting it
        // back. Without it, undoing a file was a one-way door in this panel — the terminal and the
        // per-edit row both offer redo, and the file scope silently did not.
        (!pend && undone? '<span class="rv-ubtns">'+
          '<button class="rv-btn" data-redofile="'+esc(us[0].file)+'" title="Re-apply every undone edit in this file">↻ file</button></span>' : '')+
        '</div>';
      for(var k=0;k<us.length;k++){
        var u = us[k];
        var mem = (u.status==='pending' && u.members>1) ? '<span class="rv-mem" title="'+u.members+' edits to the same code, combined — its diff is their net change">'+u.members+' edits</span>' : '';
        var evidence = u.capture ? '<span class="rv-part" title="'+esc(u.capture)+'">'+esc(u.capture)+'</span>' : '';
        var part = u.partial ? '<span class="rv-part" title="Review-only: the before-state of this edit is uncertain (an overlapping hook capture), so its diff shows the new text against nothing and undo refuses (keep works).">review-only</span>' : '';
        var acts = u.status==='pending'
          ? '<span class="rv-ubtns"><button class="rv-btn" data-keep="'+u.id+'" title="Keep this change">✓</button>'+
            '<button class="rv-btn" data-undo="'+u.id+'" title="Surgically revert this change">✗</button></span>'
          : u.status==='undone'
            ? '<span class="rv-ubtns"><button class="rv-btn" data-redo="'+u.id+'" title="Re-apply this reverted edit">↻</button></span>'
            // The undo/revert arrow, not ✗: on a KEPT row the verb is "take it
            // back", and the reject glyph read as a second reject. ↺ reverts / ↻ re-applies.
            : '<span class="rv-ubtns"><button class="rv-btn" data-undo="'+u.id+'" title="Revert this kept edit">↺</button></span>';
        h += '<div class="rv-unit'+(u.status==='pending'?'':' rv-res')+'">'+
          '<div class="rv-uhead" data-open="'+u.id+'" title="Open this change’s diff in the editor">'+
            '<span class="rv-st rv-'+esc(u.status)+'">'+glyph(u.status)+'</span>'+
            '<span class="rv-id">#'+u.id+'</span>'+
            '<span class="rv-delta"><span class="rv-add">+'+u.added+'</span> <span class="rv-del">−'+u.removed+'</span></span>'+mem+part+evidence+acts+
          '</div>'+
          '</div>';
      }
    }
    // The footer: cancelled-out chains are accounted for, never silently dropped, and one click
    // clears them all.
    if(DATA.cancelled){
      h += '<div class="rv-cancel">'+DATA.cancelled+' cancelled-out chain'+(DATA.cancelled===1?'':'s')+
        ' <span class="rv-fmeta">created then deleted, or put back — nothing to review</span>'+
        '<button class="rv-btn" data-act="dismissCancelled" title="Mark these kept — they were never a decision">Dismiss</button></div>';
    }
    host.innerHTML = h;
  }
  document.addEventListener('click', function(ev){
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-act],[data-keep],[data-undo],[data-redo],[data-keepfile],[data-undofile],[data-redofile],[data-openfile],[data-open]') : null;
    if(!t) return;
    // The FILENAME opens the file itself — the row heads beneath it open diffs; two different asks.
    var of = t.getAttribute('data-openfile');
    if(of!=null){ ev.stopPropagation(); vscode.postMessage({type:'openFile', file:of}); return; }
    // Buttons FIRST: they sit inside the header, and the header click means "open the diff".
    var keep = t.getAttribute('data-keep');
    if(keep!=null){ ev.stopPropagation(); vscode.postMessage({type:'keep', id:+keep}); return; }
    var undo = t.getAttribute('data-undo');
    if(undo!=null){ ev.stopPropagation(); vscode.postMessage({type:'undo', id:+undo}); return; }
    var redo = t.getAttribute('data-redo');
    if(redo!=null){ ev.stopPropagation(); vscode.postMessage({type:'redo', id:+redo}); return; }
    var kf = t.getAttribute('data-keepfile');
    if(kf!=null){ ev.stopPropagation(); vscode.postMessage({type:'keepFile', file:kf}); return; }
    var uf = t.getAttribute('data-undofile');
    if(uf!=null){ ev.stopPropagation(); vscode.postMessage({type:'undoFile', file:uf}); return; }
    var rf = t.getAttribute('data-redofile');
    if(rf!=null){ ev.stopPropagation(); vscode.postMessage({type:'redoFile', file:rf}); return; }
    var act = t.getAttribute('data-act');
    if(act === 'dismissCancelled'){ vscode.postMessage({type:act, ids:(DATA&&DATA.cancelledIds)||[]}); return; }
    if(act){ vscode.postMessage({type:act}); return; }
    var open = t.getAttribute('data-open');
    if(open!=null) vscode.postMessage({type:'open', id:+open});
  });
  // ---- the inline filter/sort toolbar (static, outside #rv, so typing survives a re-render) --------
  var RVCATLBL={ code:'Code', tests:'Tests', config:'Config', docs:'Docs', styles:'Styles', other:'Other' };
  // A regex the moment the query carries regex syntax — char-set test, matching core.isRegexQuery.
  function rvIsRegexQ(q){ for(var i=0;i<q.length;i++){ if('^$*+?()[]{}|\\\\'.indexOf(q.charAt(i))>=0) return true; } return false; }
  function rvFilterSummary(){ if(!DATA) return ''; var bits=[],q=(''+(DATA.filter||'')).trim(); if(q) bits.push(rvIsRegexQ(q)?('/'+q+'/'):('"'+q+'"')); var fs=DATA.filterSpec||{},cs=fs.categories||[],es=fs.exts||[]; for(var i=0;i<cs.length;i++) bits.push(RVCATLBL[cs[i]]||cs[i]); for(var j=0;j<es.length;j++) bits.push('.'+es[j]); return bits.join(', '); }
  var RV_SORT_OPTS=[['time','Time (newest first)','Newest'],['time-asc','Time (oldest first)','Oldest'],['name','Name (A→Z)','A→Z'],['name-desc','Name (Z→A)','Z→A']];
  function rvSortShort(k){ for(var i=0;i<RV_SORT_OPTS.length;i++) if(RV_SORT_OPTS[i][0]===k) return RV_SORT_OPTS[i][2]; return 'Newest'; }
  function syncRvToolbar(){
    var sl=document.getElementById('rv-sort-lbl'); if(sl) sl.textContent='Sort: '+rvSortShort(DATA&&DATA.sort);
    var sum=rvFilterSummary();
    var fl=document.getElementById('rv-filter-lbl'); if(fl) fl.textContent= sum ? sum : 'Filter';
    var fb=document.getElementById('rv-filter-btn'); if(fb){ if(sum) fb.classList.add('on'); else fb.classList.remove('on'); }
    var si=document.getElementById('rv-search-input'); if(si && document.activeElement!==si) si.value=(DATA&&DATA.filter)||'';
  }
  function renderRvSortDrop(){
    var d=document.getElementById('rv-sort-drop'); if(!d) return;
    var cur=(DATA&&DATA.sort)||'time',html='<div class="rv-dh">Sort by</div>';
    for(var i=0;i<RV_SORT_OPTS.length;i++){ var k=RV_SORT_OPTS[i][0]; html+='<div class="rv-dr rv-sortrow" data-sort="'+k+'"><span class="rv-ck">'+(cur===k?'✓':'')+'</span>'+RV_SORT_OPTS[i][1]+'</div>'; }
    d.innerHTML=html;
  }
  function renderRvDrop(){
    var d=document.getElementById('rv-filter-drop'); if(!d||!DATA) return;
    var cats=DATA.presentCats||[],exts=DATA.presentExts||[],fs=DATA.filterSpec||{},html='';
    if(cats.length){ html+='<div class="rv-dh">File type</div>'; for(var i=0;i<cats.length;i++){ var c=cats[i],on=(fs.categories||[]).indexOf(c)>=0; html+='<label class="rv-dr"><input type="checkbox" data-cat="'+c+'"'+(on?' checked':'')+'>'+(RVCATLBL[c]||c)+'</label>'; } }
    if(exts.length){ html+='<div class="rv-dh">Extension</div>'; for(var j=0;j<exts.length;j++){ var e=exts[j],one=(fs.exts||[]).indexOf(e)>=0; html+='<label class="rv-dr"><input type="checkbox" data-ext="'+e+'"'+(one?' checked':'')+'>.'+e+'</label>'; } }
    d.innerHTML=(html||'<div class="rv-dh">No files to filter yet.</div>')+'<div class="rv-df"><button type="button" id="rv-fd-clear">Clear filter</button></div>';
  }
  var RV_DROP_OPEN=false, RV_SORT_OPEN=false, RV_ST=null;
  function rvCloseDrop(){ RV_DROP_OPEN=false; var d=document.getElementById('rv-filter-drop'); if(d) d.hidden=true; var b=document.getElementById('rv-filter-btn'); if(b) b.setAttribute('aria-expanded','false'); }
  function rvCloseSort(){ RV_SORT_OPEN=false; var d=document.getElementById('rv-sort-drop'); if(d) d.hidden=true; var b=document.getElementById('rv-sort-btn'); if(b) b.setAttribute('aria-expanded','false'); }
  (function wireRvToolbar(){
    var si=document.getElementById('rv-search-input');
    if(si){ si.addEventListener('input', function(){ if(RV_ST) clearTimeout(RV_ST); RV_ST=setTimeout(function(){ vscode.postMessage({type:'setQuery', q:si.value}); }, 200); });
      si.addEventListener('keydown', function(ev){ if(ev.key==='Escape'){ si.value=''; vscode.postMessage({type:'setQuery', q:''}); } }); }
    var fb=document.getElementById('rv-filter-btn');
    if(fb){ fb.addEventListener('click', function(ev){ ev.stopPropagation(); var d=document.getElementById('rv-filter-drop'); if(!d) return; rvCloseSort(); RV_DROP_OPEN=!RV_DROP_OPEN; if(RV_DROP_OPEN){ renderRvDrop(); d.hidden=false; fb.setAttribute('aria-expanded','true'); } else rvCloseDrop(); }); }
    var d=document.getElementById('rv-filter-drop');
    if(d){ d.addEventListener('click', function(ev){ ev.stopPropagation(); if(ev.target&&ev.target.id==='rv-fd-clear') vscode.postMessage({type:'setFilterSpec', exts:[], categories:[]}); });
      d.addEventListener('change', function(ev){ var t=ev.target; if(!t||!DATA) return; var fs=DATA.filterSpec||{},cats=(fs.categories||[]).slice(),exts=(fs.exts||[]).slice();
        var cat=t.getAttribute&&t.getAttribute('data-cat'),ext=t.getAttribute&&t.getAttribute('data-ext');
        if(cat){ var ci=cats.indexOf(cat); if(t.checked&&ci<0) cats.push(cat); else if(!t.checked&&ci>=0) cats.splice(ci,1); }
        else if(ext){ var ei=exts.indexOf(ext); if(t.checked&&ei<0) exts.push(ext); else if(!t.checked&&ei>=0) exts.splice(ei,1); }
        vscode.postMessage({type:'setFilterSpec', exts:exts, categories:cats}); }); }
    // Sort — the same anchored dropdown, its four rows the orders (a check on the one in force).
    var sb=document.getElementById('rv-sort-btn');
    if(sb){ sb.addEventListener('click', function(ev){ ev.stopPropagation(); var sd=document.getElementById('rv-sort-drop'); if(!sd) return; rvCloseDrop(); RV_SORT_OPEN=!RV_SORT_OPEN; if(RV_SORT_OPEN){ renderRvSortDrop(); sd.hidden=false; sb.setAttribute('aria-expanded','true'); } else rvCloseSort(); }); }
    var sd=document.getElementById('rv-sort-drop');
    if(sd){ sd.addEventListener('click', function(ev){ ev.stopPropagation(); var r=ev.target; while(r && r!==sd && !(r.getAttribute&&r.getAttribute('data-sort'))) r=r.parentNode; if(r&&r.getAttribute){ var k=r.getAttribute('data-sort'); if(k){ vscode.postMessage({type:'setSort', sort:k}); rvCloseSort(); } } }); }
    document.addEventListener('click', function(){ if(RV_DROP_OPEN) rvCloseDrop(); if(RV_SORT_OPEN) rvCloseSort(); });
  })();
  window.addEventListener('message', function(ev){
    var m = ev.data || {};
    if(m.type==='review'){ DATA = m.data; render(); syncRvToolbar(); if(RV_DROP_OPEN) renderRvDrop(); if(RV_SORT_OPEN) renderRvSortDrop(); }
  });
  render();
  vscode.postMessage({type:'ready'});
})();
`;

function reviewShell(): string {
  const nonce = getNonce();
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  const style = `<style>
  body { margin:0; padding:8px 10px 12px; font-family: var(--vscode-font-family); font-size:11.5px; color: var(--vscode-foreground); }
  .rv-filter { padding:4px 2px 10px; color: var(--vscode-descriptionForeground); font-size:11px; }
  .rv-empty { padding:10px 2px; color: var(--vscode-descriptionForeground); line-height:1.55; }
  .rv-head { display:flex; align-items:baseline; gap:7px; margin-bottom:6px; }
  .rv-ix { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-charts-blue, #4c8bf5); font-weight:600; }
  .rv-title { white-space:pre-wrap; overflow-wrap:anywhere; }
  .rv-hint { color: var(--vscode-descriptionForeground); font-size:10px; white-space:nowrap; }
  /* Whole buttons flow to the next row in a narrow sidebar; a label never splits mid-word into a
     two-line button (the same-line rule the stacked blocks follow). */
  .rv-acts { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-bottom:10px; }
  .rv-btn { background: var(--vscode-button-secondaryBackground, rgba(127,127,127,0.15)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border:1px solid var(--vscode-widget-border, rgba(127,127,127,0.25)); border-radius:4px; padding:2px 8px; font-size:10.5px; font-family:inherit; cursor:pointer; white-space:nowrap; }
  .rv-btn:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,0.25)); }
  .rv-unit { margin-bottom:5px; }
  .rv-uhead { display:flex; align-items:center; gap:6px; padding:3px 4px; border:1px solid var(--vscode-widget-border, rgba(127,127,127,0.25)); border-radius:5px; background: var(--vscode-editorWidget-background, rgba(127,127,127,0.07)); cursor:pointer; }
  .rv-uhead:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); }
  .rv-st.rv-pending { color: var(--vscode-charts-yellow, #d9a441); }
  .rv-st.rv-kept { color: var(--vscode-charts-green, #3fb950); }
  .rv-st.rv-undone { color: var(--vscode-descriptionForeground); }
  .rv-id { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-charts-blue, #4c8bf5); }
  .rv-delta { font-family: var(--vscode-editor-font-family, monospace); font-size:10.5px; }
  .rv-add { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .rv-del { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .rv-mem { font-size:9.5px; color: var(--vscode-descriptionForeground); border:1px solid var(--vscode-widget-border, rgba(127,127,127,0.25)); border-radius:99px; padding:0 6px; white-space:nowrap; }
  .rv-part { font-size:9.5px; color:#d19a66; border:1px solid #d19a66; border-radius:99px; padding:0 6px; white-space:nowrap; }
  .rv-ubtns { display:flex; gap:3px; }
  .rv-err { color: var(--vscode-errorForeground, #f14c4c); font-size:10.5px; padding:2px 0 6px; }
  .rv-file { display:flex; align-items:center; gap:7px; margin:10px 0 4px; padding:2px 0; border-bottom:1px solid var(--vscode-widget-border, rgba(127,127,127,0.25)); }
  .rv-frel { font-weight:600; overflow-wrap:anywhere; cursor:pointer; }
  .rv-age { color:var(--vscode-descriptionForeground); opacity:.75; font-variant-numeric:tabular-nums; white-space:nowrap; margin-right:8px; font-weight:400; }
  .rv-frel:hover { text-decoration:underline; }
  .rv-fmeta { color: var(--vscode-descriptionForeground); font-size:10px; white-space:nowrap; flex:1; }
  .rv-res { opacity:.55; }
  .rv-cancel { display:flex; align-items:center; gap:7px; margin-top:12px; padding-top:8px; border-top:1px solid var(--vscode-widget-border, rgba(127,127,127,0.25)); color: var(--vscode-descriptionForeground); font-size:10.5px; }
  /* the inline filter/sort toolbar — a search field + a filter dropdown + a sort toggle, in the
     panel itself (no pop-up). Buttons carry their own state: the sort mode, and what the filter
     narrows by. Static (outside #rv), so typing never loses focus to a re-render. */
  .rv-toolbar { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:8px; }
  .rv-swrap { display:inline-flex; align-items:center; gap:4px; border:1px solid var(--vscode-widget-border, rgba(127,127,127,0.25)); border-radius:4px; padding:2px 6px; flex:1; min-width:90px; }
  .rv-swrap:focus-within { border-color: var(--vscode-focusBorder); }
  .rv-sicon { color: var(--vscode-descriptionForeground); font-size:11px; }
  .rv-sinp { background:transparent; border:none; outline:none; color: var(--vscode-foreground); font:inherit; font-size:11px; width:100%; padding:1px 0; }
  .rv-sinp::placeholder { color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground)); }
  .rv-cb { position:relative; }
  .rv-tbb { background:transparent; border:1px solid var(--vscode-widget-border, rgba(127,127,127,0.25)); border-radius:4px; color: var(--vscode-descriptionForeground); font:inherit; font-size:10.5px; padding:2px 7px; cursor:pointer; white-space:nowrap; max-width:60vw; overflow:hidden; text-overflow:ellipsis; }
  .rv-tbb:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); }
  .rv-tbb.on { border-color: var(--vscode-focusBorder); color: var(--vscode-foreground); }
  .rv-drop { position:absolute; top:100%; right:0; margin-top:4px; z-index:40; min-width:150px; max-height:55vh; overflow:auto; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border:1px solid var(--vscode-editorWidget-border, rgba(127,127,127,0.25)); border-radius:5px; box-shadow:0 3px 10px rgba(0,0,0,0.35); padding:5px; }
  .rv-dh { font-size:9px; letter-spacing:.06em; text-transform:uppercase; color: var(--vscode-descriptionForeground); padding:5px 6px 2px; }
  .rv-dr { display:flex; align-items:center; gap:6px; padding:3px 6px; font-size:11px; cursor:pointer; border-radius:3px; }
  .rv-dr:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); }
  .rv-sortrow { cursor:pointer; }
  .rv-ck { display:inline-block; width:14px; flex:none; color: var(--vscode-textLink-foreground, #4c8bf5); font-weight:600; }
  .rv-df { border-top:1px solid var(--vscode-widget-border, rgba(127,127,127,0.25)); margin-top:5px; padding-top:5px; text-align:right; }
  .rv-df button { background:transparent; border:1px solid var(--vscode-widget-border, rgba(127,127,127,0.25)); border-radius:4px; color: var(--vscode-descriptionForeground); font:inherit; font-size:10px; padding:2px 8px; cursor:pointer; }
  </style>`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">${style}</head>
  <body><div class="rv-toolbar">` +
    `<span class="rv-swrap"><span class="rv-sicon">⌕</span><input id="rv-search-input" class="rv-sinp" type="text" placeholder="Search" title="Filter edits by path — a regex when it carries regex syntax, a substring otherwise"></span>` +
    `<span class="rv-cb"><button class="rv-tbb" id="rv-filter-btn" aria-expanded="false" title="Filter by file type and extension"><span id="rv-filter-lbl">Filter</span> ▾</button><div class="rv-drop" id="rv-filter-drop" hidden></div></span>` +
    `<span class="rv-cb"><button class="rv-tbb" id="rv-sort-btn" aria-expanded="false" title="Sort order — newest / oldest / name A→Z / name Z→A"><span id="rv-sort-lbl">Sort: Newest</span> ▾</button><div class="rv-drop" id="rv-sort-drop" hidden></div></span>` +
  `</div><div id="rv"></div><script nonce="${nonce}">${REVIEW_SCRIPT}</script></body></html>`;
}

/** The combined Overview panel (0.8.0 round 3): shells out to BOTH `multitask --json` (the left-nav
 *  Fleet/Workflows payload) AND `changemap --json` (the right-detail change-map) — throttled,
 *  visible-only — and posts both to the master–detail webview, which joins them by session/workflowId.
 *  Clicks come back as {openEdit,id} → the existing edit-review command, {chatAction,ref} → the
 *  zero-token handoff, and {taskKeep|taskUndo|taskClear|clearCompletedTasks} → the strict task ops. */
interface NavPos {
  diff: { i: number; n: number; time: string } | null;
  file: { i: number; n: number; name: string; edits: number } | null;
  folder: { i: number; n: number; name: string; files: number; edits: number } | null;
  // The user's own turn that produced the current edit. Every other axis slices the work the way the
  // AGENT saw it (a file, a folder); this one slices it the way the person asked for it.
  prompt: { i: number; n: number; id: string; index: number; title: string; files: number; edits: number } | null;
}
/**
 * What the Overview needs from whatever is hosting it. A `WebviewView` (the bottom panel) and a
 * `WebviewPanel` (an editor tab) both satisfy this, and the provider touches nothing else — which is
 * what lets the same renderer live in either place without a second copy of it.
 */
type OverviewHost = { readonly webview: vscode.Webview; readonly visible: boolean };

class ChangeMapViewProvider implements vscode.WebviewViewProvider {
  /** The host currently DRIVING refreshes. Exactly one, ever: an editor tab wins while it is open, and
   *  the panel view takes over again when it closes. Two hosts both ticking would double every spawn. */
  private view?: OverviewHost;
  private panelView?: vscode.WebviewView;
  private editorPanel?: vscode.WebviewPanel;
  private run = 0;
  private running = false;
  private everLoaded = false;
  // The live Diff/File step-through position, mirrored into the title-bar nav-bar counters. Set by the
  // status bar's updateStatusItem (single source of truth); rides the next overview message + a live push.
  private navPos: NavPos | null = null;
  /** A forced refresh arrived while a spawn was in flight — re-run as soon as it finishes. */
  private rerun = false;
  /** A feed subject was picked in this panel's webview (a fleet/workflow/task/process row) — or
   *  cleared. The Timeline provider is the listener: it owns the feed fetch and the Feed tab
   *  (0.10.0 — the feed moved there from under the change map). */
  onFeedSelect?: (ref: { kind: string; id: string; label: string } | null) => void;
  /** Wired in activate(): a ledger row's ⧉ opens that file's changes as the STACKED layout —
   *  through the Review provider that owns the stacked panel (the feed's opener, same rule). */
  onOpenFileStacked?: (session: string, editId: number) => void;
  /** The ask picked in the Prompts window — this panel filters everything it draws to that prompt. */
  private promptId: string | null = null;
  /** The picked ask, for the nav bar's Prompt axis — the pick outranks the edit anchor there. */
  getPrompt(): string | null {
    return this.promptId;
  }
  setPrompt(id: string | null): void {
    this.promptId = id;
    // Push it now (a click must feel like a click); the next refresh carries it again for a panel that
    // was hidden just then and so never saw this message.
    if (this.view?.visible) this.view.webview.postMessage({ type: 'prompt', id });
  }
  /** Push the Diff/File step-through position into the title-bar nav counters (live, visible-only). */
  setNavPos(pos: NavPos): void {
    this.navPos = pos;
    if (this.view?.visible) this.view.webview.postMessage({ type: 'navpos', pos });
  }
  /** Guided tour: bring a left-nav tab forward and ring the one control the step is talking about.
   *  Passing nulls clears both (the tour moved on, or ended). The step's text stays in the tour window. */
  setTour(tab: string | null, anchor: string | null): void {
    this.view?.webview.postMessage({ type: 'tour', tab, anchor });
  }
  /** Guided tour: suspend the Active-only display filter for the duration, and restore it after. The
   *  tour narrates rows that filter hides — five of the demo's six tasks are completed — so leaving it
   *  on makes the text describe a screen the reader is not looking at. The webview restores the reader's
   *  own setting rather than a hard-coded default, so someone who had it OFF keeps it off. */
  setShowAll(on: boolean): void {
    this.view?.webview.postMessage({ type: 'showall', on });
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.panelView = view;
    if (!this.editorPanel) this.view = view; // an open editor tab keeps the wheel
    this.wire(view);
    view.onDidChangeVisibility(() => {
      if (view.visible && this.view === view) this.refresh(true);
    });
  }

  /** Give a host the shell and the message wiring. Shared so an editor tab is the SAME Overview, not a
   *  second implementation that drifts. */
  private wire(host: OverviewHost): void {
    host.webview.options = { enableScripts: true };
    host.webview.html = changeMapShell(); // set once; data arrives via postMessage (no reload flash)
    // A host that is NOT driving never receives a payload, so it would sit on "Reading sessions…"
    // forever with no explanation. Say where the Overview went instead of looking broken.
    if (this.editorPanel && host !== this.editorPanel)
      setTimeout(() => host.webview.postMessage({ type: 'elsewhere', where: 'editor' }), 0);
    host.webview.onDidReceiveMessage((m: { type?: string; id?: number | string; kind?: string; taskId?: string; promptId?: string; folder?: string; ref?: core.ChatContextRef; session?: string; name?: string; pending?: string | number; channel?: string; act?: string; rel?: string }) => {
      if (!m) return;
      if (m.type === 'ready') {
        this.refresh(true);
        void versionChipInfo().then((v) => host.webview.postMessage({ type: 'version', v }));
      }
      // The version chip's menu opened — (re)send release info; the 1h cache absorbs repeat opens.
      else if (m.type === 'versionMenuOpen')
        void versionChipInfo().then((v) => host.webview.postMessage({ type: 'version', v }));
      else if (m.type === 'openSettings')
        // VS Code's own settings UI, filtered to this extension. Not a webview of our own: the host
        // already owns these values, and a second editor for them would be a second place they can
        // disagree.
        // The id is DERIVED, never typed: `@ext:` silently filters to nothing when the string is
        // wrong, so a hand-written "publisher.name" would open an empty settings page and look like
        // the button had done nothing.
        void vscode.commands.executeCommand(
          'workbench.action.openSettings',
          `@ext:${EXTENSION_ID}`
        );
      else if (m.type === 'versionUpdate') void vscode.commands.executeCommand('claudeObservatory.updateNow');
      else if (m.type === 'switchChannel' && (m.channel === 'stable' || m.channel === 'dev'))
        void vscode.commands.executeCommand('claudeObservatory.switchChannel', m.channel);
      // A feed subject was picked (or cleared — a session switch posts the bare form). The feed lives
      // in the Timeline's Feed tab now (0.10.0), so this only names the subject; the activate() wiring
      // hands it to the Timeline provider, which owns the fetch, and reveals the tab.
      else if (m.type === 'feed')
        this.onFeedSelect?.(
          typeof m.kind === 'string' && m.kind
            ? { kind: m.kind, id: typeof m.id === 'string' ? m.id : '', label: typeof (m as { label?: unknown }).label === 'string' ? (m as { label: string }).label : '' }
            : null
        );
      else if (m.type === 'openEdit' && typeof m.id === 'number')
        void vscode.commands.executeCommand('claudeObservatory.viewChanges', m.id);
      // A ledger row's ⧉: that file's changes as the STACKED layout — the same
      // opener the feed's edit clicks use, keyed by any of the file's edit ids.
      else if (m.type === 'mapScope' && m.act === 'stack' && typeof m.id === 'number') {
        const session = currentSession();
        if (session) this.onOpenFileStacked?.(session, m.id);
      }
      // Keep / Undo scoped to one change-map row. `--under <path>` is the CLI's own file-or-folder
      // scope, so this shares an exact rule with the terminal's map and with the folder actions in the
      // trees, rather than re-deriving an id set here that the three could disagree about.
      else if (m.type === 'mapScope' && (m.act === 'keep' || m.act === 'undo') && typeof m.rel === 'string' && m.rel) {
        const act = m.act as 'keep' | 'undo';
        const rel = m.rel as string;
        const name = typeof m.name === 'string' && m.name ? m.name : rel;
        const pending = Number(m.pending) || 0;
        void (async () => {
          const cwd = workspaceRoot();
          const session = currentSession();
          if (!cwd || !session) return;
          // Undo REWRITES FILES ON DISK, so it asks first with the real number. Keep records a verdict
          // and changes nothing, so it does not — the same asymmetry every other surface here uses.
          if (act === 'undo') {
            const ok = await vscode.window.showWarningMessage(
              `Undo ${pending} pending edit(s) in ${name}?`,
              { modal: true, detail: 'This reverts them on disk. Keeping instead records a verdict and changes no file.' },
              'Undo'
            );
            if (ok !== 'Undo') return;
          }
          // Spawned, like every other bulk verb here: `--under` can resolve to hundreds of records on a
          // folder, and doing that in-process froze the host the last time a bulk path took that route.
          spawnCliJson([act, '--under', rel, '--session', session, '--json'], cwd, (data) => {
            const r = (data ?? {}) as Record<string, unknown>;
            const n = Number(r[act === 'keep' ? 'kept' : 'undone'] ?? 0);
            // CONFLICTS and REFUSALS are separate numbers and both have to be said. The CLI exits 0
            // while returning `{"undone":0,"conflicts":2}` — an undo that reverted nothing because
            // every file had changed on disk — and reporting only `undone` turned that into a
            // 3-second "undid 0 edit(s)", which reads as "there was nothing to do". A refusal
            // (`errors`, with its reason in `firstError`) was invisible the same way.
            const conflicts = Number(r.conflicts ?? 0) || 0;
            const errors = Number(r.errors ?? 0) || 0;
            const first = typeof r.firstError === 'string' ? r.firstError : '';
            const firstC = typeof r.firstConflict === 'string' ? r.firstConflict.split('. ')[0] : '';
            const unrecorded = (r.unrecorded as { message?: unknown } | undefined)?.message;
            if (data === null) {
              vscode.window.showErrorMessage(`Could not ${act} ${name} — is the oak CLI installed?`);
            } else if (conflicts || errors || typeof unrecorded === 'string') {
              // A modal, not a status-bar flash: nothing moved, or not all of it did, and the reader
              // has to act on that rather than catch it in three seconds of peripheral vision.
              void vscode.window.showWarningMessage(
                `OAK: ${act === 'keep' ? 'kept' : 'undid'} ${n} edit(s) in ${name}` +
                  (conflicts ? ` · ${conflicts} conflict(s) left — revert those individually to force${firstC ? ` — ${firstC}` : ''}` : '') +
                  (errors ? ` · ${errors} refused${first ? ` — ${first}` : ''}` : '') +
                  (typeof unrecorded === 'string' ? ` · ${unrecorded}` : '')
              );
            } else {
              vscode.window.setStatusBarMessage(
                `OAK: ${act === 'keep' ? 'kept' : 'undid'} ${n} edit(s) in ${name}`,
                3000
              );
            }
            void vscode.commands.executeCommand('claudeObservatory.refresh');
          });
        })();
      }
      // (No openPath branch: the footprint drill-down was its last sender, and the file rows that replaced
      // it live in the Actions tree, which opens paths itself.)
      else if (m.type === 'showReason' && typeof m.id === 'number')
        void vscode.commands.executeCommand('claudeObservatory.showObservation', m.id);
      else if (m.type === 'chatAction' && m.ref)
        void vscode.commands.executeCommand('claudeObservatory.chatAction', m.ref);
      // Resolve one session from its own row: accept what is pending, then drop its records. Confirmed,
      // because clearing the records is not undoable — the accept itself changes no file on disk.
      else if (m.type === 'resolveSession' && typeof m.session === 'string') {
        const sess = m.session;
        const nm = typeof m.name === 'string' && m.name ? m.name : sess.slice(0, 8);
        const pend = Number(m.pending) || 0;
        void (async () => {
          const ok = await vscode.window.showWarningMessage(
            `Resolve “${nm}”?`,
            {
              modal: true,
              detail:
                `Accepts its ${pend} pending edit(s), then clears this session's review records.\n\n` +
                `Accepting changes NO file on disk — it records a verdict. Clearing the records cannot be undone, ` +
                `and the session itself is kept.`,
            },
            'Resolve session'
          );
          if (ok !== 'Resolve session') return;
          // Validated like every other bulk verb. resolveSession is the MOST destructive of them — it
          // accepts everything then drops the records — so it gets the same rails, not fewer, even
          // though the only sender today is this workspace's own Sessions list.
          const target = bulkSession(sess);
          if (!target || target !== sess) {
            vscode.window.showWarningMessage('That session is not one of this workspace’s — nothing was changed.');
            return;
          }
          // Spawned: resolveSession = accept-everything + rewrite-the-log, measured ~0.8s at 8k
          // records — in-process it froze the host right after the user confirmed. `resolve` is the
          // same core call behind the CLI seam.
          void vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Resolving ${nm}…` },
            () =>
              new Promise<void>((fin) => {
                spawnCliJson(['resolve', '--session', target, '--json'], workspaceRoot() ?? process.cwd(), (data) => {
                  const r = data as { accepted?: number; cleared?: number } | null;
                  if (r && typeof r.accepted === 'number')
                    vscode.window.showInformationMessage(`Resolved ${nm} — accepted ${r.accepted} edit(s), cleared ${r.cleared ?? 0} record(s).`);
                  else vscode.window.showErrorMessage(`Could not resolve ${nm} — is the oak CLI installed?`);
                  void vscode.commands.executeCommand('claudeObservatory.refresh');
                  fin();
                });
              })
          );
        })();
      }
      // Task review actions from the Tasks tab's per-row chips (strict edit sets).
      else if (m.type === 'taskKeep' && typeof m.taskId === 'string')
        void vscode.commands.executeCommand('claudeObservatory.taskKeep', m.taskId);
      else if (m.type === 'taskUndo' && typeof m.taskId === 'string')
        void vscode.commands.executeCommand('claudeObservatory.taskUndo', m.taskId);
      else if (m.type === 'taskClear' && typeof m.taskId === 'string')
        void vscode.commands.executeCommand('claudeObservatory.taskClear', m.taskId);
      // Prompt (user-turn) review actions — the Prompts window's selected row retargets the bulk
      // buttons; core resolves the id to that ask's edit set.
      else if (m.type === 'promptKeep' && typeof m.promptId === 'string')
        void vscode.commands.executeCommand('claudeObservatory.promptKeep', m.promptId);
      else if (m.type === 'promptUndo' && typeof m.promptId === 'string')
        void vscode.commands.executeCommand('claudeObservatory.promptUndo', m.promptId);
      else if (m.type === 'promptRewind' && typeof m.promptId === 'string')
        void vscode.commands.executeCommand('claudeObservatory.promptRewind', m.promptId);
      else if (m.type === 'promptClear' && typeof m.promptId === 'string')
        void vscode.commands.executeCommand('claudeObservatory.promptClear', m.promptId);
      else if (m.type === 'reviewPrompt' && typeof m.promptId === 'string')
        void vscode.commands.executeCommand('claudeObservatory.reviewPrompt', m.promptId);
      else if (m.type === 'revealFolder' && typeof m.folder === 'string')
        void vscode.commands.executeCommand('claudeObservatory.revealFolder', m.folder);
      else if (m.type === 'clearCompletedTasks')
        void vscode.commands.executeCommand('claudeObservatory.clearCompletedTasks');
      // Top-navbar review actions — the session selector + the same bulk actions the Observations toolbar has.
      else if (m.type === 'switchSession')
        void vscode.commands.executeCommand('claudeObservatory.switchSession');
      // The Sessions tab: selecting a row PINS that session (a different selection semantic from every
      // other tab, which only re-slices the detail).
      else if (m.type === 'switchToSession' && typeof m.id === 'string')
        void vscode.commands.executeCommand('claudeObservatory.pinSession', m.id);
      // The 🗑 on a Sessions-tab row: confirm, then core.deleteSession (hide + purge captured edits;
      // transcript untouched) and re-pin to the newest remaining if the deleted one was pinned. The
      // shared body's forced refresh re-posts this tab's session list (as `resolveSession` above relies
      // on) — the deleted row drops out on the next paint, the reused refresh path.
      else if (m.type === 'deleteSession' && typeof m.id === 'string')
        void confirmAndDeleteSession(m.id);
      // The webview names the session these act on (a selected Fleet row, else the reviewed one). Passing
      // it explicitly is what stops "Accept All" from accepting a different session than the toolbar is
      // labelled with — the same defect class as a badge that counts a list its pane is not showing.
      else if (m.type === 'keepAll')
        void vscode.commands.executeCommand('claudeObservatory.keepAll', m.session);
      else if (m.type === 'undoAll')
        void vscode.commands.executeCommand('claudeObservatory.undoAll', m.session);
      else if (m.type === 'clearResolved')
        void vscode.commands.executeCommand('claudeObservatory.clearResolved', m.session);
      else if (m.type === 'refresh')
        // The sweep for a newly-added `.observatoryignore` lives in the `claudeObservatory.refresh`
        // command handler now, so EVERY user refresh route gets it (this button, the palette, the
        // post-mutation refreshes) — not just this one message.
        void vscode.commands.executeCommand('claudeObservatory.refresh');
      // Step-through review nav bar (mirrors the status-bar nav bar) — passthrough to the existing commands.
      else if (m.type === 'navFilePrev') void vscode.commands.executeCommand('claudeObservatory.navFilePrev');
      else if (m.type === 'navFileNext') void vscode.commands.executeCommand('claudeObservatory.navFileNext');
      else if (m.type === 'navFolderPrev') void vscode.commands.executeCommand('claudeObservatory.navFolderPrev');
      else if (m.type === 'navFolderNext') void vscode.commands.executeCommand('claudeObservatory.navFolderNext');
      else if (m.type === 'acceptCurrentFolder') void vscode.commands.executeCommand('claudeObservatory.acceptCurrentFolder');
      else if (m.type === 'rejectCurrentFolder') void vscode.commands.executeCommand('claudeObservatory.rejectCurrentFolder');
      else if (m.type === 'navDiffPrev') void vscode.commands.executeCommand('claudeObservatory.navDiffPrev');
      else if (m.type === 'navDiffNext') void vscode.commands.executeCommand('claudeObservatory.navDiffNext');
      else if (m.type === 'filterMenu') void vscode.commands.executeCommand('claudeObservatory.filterMenu');
      else if (m.type === 'cycleSort') void vscode.commands.executeCommand('claudeObservatory.cycleSort');
      else if (m.type === 'navPromptPrev') void vscode.commands.executeCommand('claudeObservatory.navPromptPrev');
      else if (m.type === 'navPromptNext') void vscode.commands.executeCommand('claudeObservatory.navPromptNext');
      else if (m.type === 'acceptCurrentPrompt') void vscode.commands.executeCommand('claudeObservatory.acceptCurrentPrompt');
      else if (m.type === 'rejectCurrentPrompt') void vscode.commands.executeCommand('claudeObservatory.rejectCurrentPrompt');
      else if (m.type === 'reviewCurrentPrompt') void vscode.commands.executeCommand('claudeObservatory.reviewCurrentPrompt');
      else if (m.type === 'rewindCurrentPrompt') void vscode.commands.executeCommand('claudeObservatory.rewindCurrentPrompt');
      else if (m.type === 'navKeep') void vscode.commands.executeCommand('claudeObservatory.navKeep');
      else if (m.type === 'navUndo') void vscode.commands.executeCommand('claudeObservatory.navUndo');
      else if (m.type === 'chatCurrentEdit') void vscode.commands.executeCommand('claudeObservatory.chatCurrentEdit');
      else if (m.type === 'viewCurrentDiff') void vscode.commands.executeCommand('claudeObservatory.viewCurrentDiff');
      else if (m.type === 'keepOpenFile') void vscode.commands.executeCommand('claudeObservatory.keepOpenFile');
      else if (m.type === 'undoOpenFile') void vscode.commands.executeCommand('claudeObservatory.undoOpenFile');
      else if (m.type === 'exportSummary') void vscode.commands.executeCommand('claudeObservatory.exportSummary');
      else if (m.type === 'exportMenu') void vscode.commands.executeCommand('claudeObservatory.exportMenu');
      else if (m.type === 'openStore') revealStoreFolder(String(m.id || currentSession() || ''));
      // A session row opens its conversation in the Feed tab.
      else if (m.type === 'openConversation' && typeof m.id === 'string' && m.id)
        void vscode.commands.executeCommand('claudeObservatory.openConversation', m.id);
      else if (m.type === 'toggleHeatmap') void vscode.commands.executeCommand('claudeObservatory.toggleHeatmap');
      else if (m.type === 'searchEdits') void vscode.commands.executeCommand('claudeObservatory.searchEdits');
      // The inline toolbar controls (the webview's own search field + filter dropdown) set the shared
      // state through two internal commands — registered where `refreshAll` is in scope — so the
      // Overview and Traces refresh in lockstep off the same state the palette Search / Filter write,
      // just without the pop-up. (A plain `refresh` would re-run the .observatoryignore sweep, a store
      // write, on every keystroke; these only re-render.)
      else if (m.type === 'setQuery') void vscode.commands.executeCommand('claudeObservatory.applyQuery', String((m as { q?: unknown }).q ?? ''));
      else if (m.type === 'setFilterSpec') void vscode.commands.executeCommand('claudeObservatory.applyFilterSpec', m as { exts?: unknown; categories?: unknown });
      else if (m.type === 'setSort') void vscode.commands.executeCommand('claudeObservatory.applySort', String((m as { sort?: unknown }).sort ?? ''));
      else if (m.type === 'resetScope') void vscode.commands.executeCommand('claudeObservatory.resetScope');
    });
  }

  /**
   * Open (or reveal) the Overview as an EDITOR TAB, and hand it the wheel.
   *
   * The bottom panel stays the default; this is for readers who want the Overview beside their code at
   * full height. While the tab is open it drives the refresh and the panel view goes quiet — one host
   * ticking, never two — and closing it hands control back.
   */
  openInEditor(): void {
    if (this.editorPanel) {
      this.editorPanel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'claudeObservatory.overviewEditor',
      'OAK — Overview',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.editorPanel = panel;
    this.view = panel;
    this.wire(panel);
    // The panel view is usually resolved FIRST (the reader opens the tab from it), so wire() already ran
    // on it back when there was no editorPanel to notice — it would never be told, and would sit on its
    // last-painted counts forever. Tell it now; the notice lifts when its next payload arrives.
    this.panelView?.webview.postMessage({ type: 'elsewhere', where: 'editor' });
    panel.onDidChangeViewState(() => {
      if (panel.visible && this.view === panel) this.refresh(true);
    });
    panel.onDidDispose(() => {
      this.editorPanel = undefined;
      this.view = this.panelView; // the panel view takes the wheel back
      if (this.panelView) this.refresh(true);
      // …and if there is no panel view to take it — `overviewLocation: "editor"` on a fresh window, where
      // the dock was never opened — closing the tab would otherwise leave the Overview with no host at
      // all, silently, until the reader found the palette. Reveal the dock instead.
      else void vscode.commands.executeCommand('claudeObservatory.changemap.focus');
    });
    this.refresh(true);
  }
  /** Spawn one CLI subcommand, parse its stdout as JSON, and hand the result (or null on any failure)
   *  to `cb` exactly once. See `spawnCliJson` — this panel's spawns all go through it. */
  /** When this workspace's recent sessions were last pre-built, so an idle panel does not loop on it. */
  private warmedAt = 0;

  /**
   * Pre-build the change maps of sessions active in the last day, detached, after a refresh has landed.
   *
   * Switching to a session nothing had built was measured at 6.2 s against 1.5 s once its caches existed,
   * and nothing built a session until you switched to it — so that cost fell on the reader every time.
   * This spends idle time instead. Detached and unwatched: it must never delay the panel that triggered
   * it, and a failure here costs a slow switch, not a broken view.
   */
  private warmRecent(cwd: string): void {
    const now = Date.now();
    if (now - this.warmedAt < 10 * 60_000) return; // at most once every ten minutes
    this.warmedAt = now;
    try {
      // Also `--root <cwd>`: same unquoted-concatenation defect as spawnCliJson above.
      const child = core.spawnTool(resolveObservatoryBin(), ['warm', '--root', cwd, '--since', '24h'], {
        cwd,
        stdio: 'ignore',
        detached: true,
      });
      child.on('error', () => {
        /* no CLI on PATH — switching stays slow, which is the pre-0.9.0 behaviour, not a failure */
      });
      child.unref();
    } catch {
      /* best-effort by construction */
    }
  }

  private spawnJson(args: string[], cwd: string, cb: (data: unknown | null) => void): void {
    spawnCliJson(args, cwd, cb);
  }
  /** `force` bypasses the coalescing throttle (used on first-open / became-visible). */
  refresh(force = false): void {
    if (force) listingFloor = Date.now();
    if (!this.view?.visible) return;
    const now = Date.now();
    // A forced refresh that lands mid-spawn cannot simply be dropped: the in-flight payload was
    // gathered before whatever forced it (a clear, an accept), so letting it win leaves the panel
    // showing numbers that are already wrong. Remember it and re-run once the current spawn lands.
    if (this.running) {
      if (force) this.rerun = true;
      return;
    }
    if (!force && now - this.run < 3000) return;
    const session = currentSession();
    const cwd = workspaceRoot();
    if (!cwd) return;
    if (!session) {
      this.run = now;
      void readSessionListing(cwd).then((sessions) => { if (!currentSession()) this.view?.webview.postMessage({ type: 'sessions', sessions }); });
      return;
    }
    this.running = true;
    this.run = now;
    let cm: unknown = undefined;
    let mt: unknown = undefined;
    let pr: unknown = undefined;
    let sessions: core.SessionMeta | null = null;
    const done = () => {
      if (cm === undefined || mt === undefined || pr === undefined) return; // wait for every spawn
      this.running = false;
      // The reader switched sessions while these spawns were in flight. This payload describes the
      // session they LEFT — painting it would relabel the panel with the new session's name over the
      // old session's edits — so drop it and go get the right one.
      if (currentSession() !== session) {
        this.rerun = false;
        setTimeout(() => this.refresh(true), 0);
        return;
      }
      // A forced refresh arrived while this spawn was in flight (a clear, an accept — something that
      // changed the very numbers being painted). Its payload predates that change, so re-run once this
      // paint lands, or the panel keeps showing counts that are already wrong.
      if (this.rerun) {
        this.rerun = false;
        setTimeout(() => this.refresh(true), 0);
      }
      if (cm === null && mt === null) {
        this.postError();
        return;
      }
      this.everLoaded = true;
      // The per-agent tab model (host-derived so the webview stays a pure renderer). Both payloads ride
      // along; the webview joins CM.agents[]/CM.workflows[] to the MT nav by session/workflowId. The
      // active session rides along too so the top navbar's session selector shows what it's viewing.
      // The Search-edits filter reaches the detail ledger too — not only the sidebar trees.
      // `prompt` = the ask picked in the Prompts window (host-held). It rides every payload so a panel
      // that was hidden when the pick happened comes back already scoped to it.
      // `pinned` is the SETTING, not the resolved session: the Sessions tab marks its Auto row from it,
      // and "following" is only true when nothing is pinned.
      const pinned = vscode.workspace.getConfiguration('claudeObservatory').get<string>('session') || '';
      // The bar names the session under review; the listing already carries every session's title, so
      // this costs a lookup rather than another transcript scan.
      const sessionTitle = sessions?.sessions.find((r) => r.id === session)?.title ?? undefined;
      // Send everything EXCEPT the per-edit array. It is 0.72 MB of a 2.45 MB payload — 30% — and this
      // webview never reads it: every `.edits` in the Overview script is a scalar rollup count, and
      // `CM.edits` appears nowhere. It still leaves the CLI, because tools and the other front-ends do
      // read it; it just stops crossing postMessage to a renderer that throws it away.
      const cmLean = cm ? { ...cm, edits: [] } : cm;
      this.view?.webview.postMessage({ type: 'overview', cm: cmLean, mt, pr, sessions, session, sessionTitle, pinned, prompt: this.promptId, navPos: this.navPos, filter: editFilter, filterSpec: filterSpecMsg(), sort: currentSort() });
    };
    // ONE spawn for the three heavy views, and it stays a SPAWN on purpose.
    //
    // These were three separate `changemap` / `multitask` / `processes` processes per tick — measured at
    // 3.5 s of CPU and ~1.4 GB transient RSS, roughly six times a minute while the agent works. I briefly
    // moved the change map in-process instead, since core is already bundled here. That was wrong, and
    // ARCHITECTURE.md says why in the line that justifies the seam: the transcript-wide scans are
    // spawned "so a multi-gigabyte parse never runs on the UI thread". Measured after the fact, an
    // in-process build blocked the extension host for 2.8 s on the worst session in this workspace, and
    // ~700 ms on EVERY tick for the active one — whose cache invalidates each time its transcript grows.
    // A spawn costs more total CPU and blocks nothing; that is the trade this seam exists to make.
    //
    // `views` gets all three from ONE process, which is the part that was actually wasteful: three node
    // start-ups, and three separate re-derivations of the same transcript parse that core memoizes
    // per-process. Each view is produced by its own command inside that process, so the payloads are
    // identical to asking for them separately (pinned by §E2E 23).
    const startedAt = Date.now();
    const stamp = storeStamp;
    this.spawnJson(
      ['views', '--views', 'changemap,multitask,processes,sessions', '--json', '--root', cwd, '--session', session],
      cwd,
      (data) => {
        const all = data as { sessions?: core.SessionMeta; changemap?: unknown; multitask?: unknown; processes?: unknown; __problems?: Record<string, string>; __ignoreProblems?: string[] } | null;
        // A view the CLI could not build arrives as `null`, which renders as an empty panel — the same
        // frame a session that did nothing produces. `views` now says which views failed and why, and
        // an unreadable ignore file rides along; surfacing it here is what keeps "could not read" from
        // looking like "nothing happened" in the editors as well as the terminal.
        const problems = all?.__problems && typeof all.__problems === 'object' ? Object.entries(all.__problems) : [];
        if (problems.length) {
          void vscode.window.showWarningMessage(
            `OAK: ${problems.length === 1 ? `the ${problems[0][0]} view` : `${problems.length} views`} could not be read — ${problems[0][1]}`
          );
        }
        for (const why of all?.__ignoreProblems ?? []) void vscode.window.showWarningMessage(`OAK: ${why}`);
        sessions = all?.sessions && Array.isArray(all.sessions.sessions) ? all.sessions : null;
        if (sessions) sharedListing = { key: listingKey(cwd, session), startedAt, landedAt: Date.now(), stamp, listing: sessions };
        const d = (all?.changemap ?? null) as (core.ChangeMap & { agents?: unknown[] }) | null;
        cm = d && d.summary && Array.isArray(d.edits) && Array.isArray(d.files) && Array.isArray(d.modules) && Array.isArray(d.agents) ? d : null;
        const m = (all?.multitask ?? null) as { agents?: unknown[]; collisions?: unknown[] } | null;
        mt = m && Array.isArray(m.agents) && Array.isArray(m.collisions) ? m : null;
        // An older CLI has no `processes`; that lands here as null, which HIDES the tab rather than
        // breaking the panel.
        const q = (all?.processes ?? null) as { processes?: unknown[]; summary?: unknown } | null;
        pr = q && Array.isArray(q.processes) && q.summary ? q : null;
        // ONE call. The old code had three callbacks each setting one variable, so only the last
        // got past `done`'s guard; this one sets all three first, so three calls each ran the whole
        // body — three `sessionMeta` reads and three ~1.7 MB postMessages per tick, inside the very
        // change whose point was to cut per-tick cost.
        done();
        this.warmRecent(cwd);
      }
    );
    // (No `prompts --json` spawn here since 0.8.7: the Prompts WINDOW fetches the list itself, and the
    // per-ask slices this panel filters by ride the changemap payload it already asks for. The feed
    // no longer rides this tick either — it lives in the Timeline's Feed tab, which owns its fetch.)
  }
  private postError(): void {
    if (this.everLoaded) return;
    this.view?.webview.postMessage({ type: 'error', sessions: null });
    const root = workspaceRoot();
    if (root) void readSessionListing(root, currentSession()).then((sessions) => {
      if (!this.everLoaded) this.view?.webview.postMessage({ type: 'sessions', sessions });
    });
  }
}

// --- Overview left-nav filter (0.8.0 round 3): real-time multi-agent observability --------------
// The combined Overview panel's LEFT NAV renders `multitask --json` (the single backend): one row per
// running agent across every worktree of this repo (live phase incl. awaiting-permission, worktree+
// branch, a 20-bin activity sparkline, ±diff, tokens/time, risk count, a collision warning), each with
// its nested subagents, plus the Workflows runs — a THIN renderer (no client aggregation) that rides the
// transcript watcher's refreshAll. Subagent rows hand off a zero-token chat via claudeObservatory.chatAction.

/** The Overview nav's two DISPLAY filters — Active-only + Clear-completed — as ONE pure function over
 *  the raw `multitask --json` payload. Single source of truth for BOTH the smoke test (which drives it
 *  off fabricated payloads) AND the webview: the client keeps the transient toggle / dismissed-set
 *  state and calls THIS SAME function (embedded verbatim via .toString() into OVERVIEW_SCRIPT), so the
 *  filter the test verifies is byte-for-byte the one the UI runs — no drift. Zero-token, no core/CLI
 *  change (a thin renderer on top of agent.phase / subagent.phase / workflow.running).
 *
 *  Classification is PURE from the payload: an agent is "active" when its own phase is
 *  working/awaiting-input/awaiting-permission OR any of its subagents is; a workflow is active when
 *  `running`. `activeOnly` hides the inactive; `dismissed*` hides completed items the user cleared — but
 *  a dismissed item REAPPEARS the moment it goes active again (dismissal only bites while inactive). */
export interface MultitaskFilterState {
  activeOnly?: boolean;
  dismissedAgents?: Record<string, unknown>;
  dismissedWorkflows?: Record<string, unknown>;
}
export const multitaskFilter = (
  data:
    | {
        agents?: Array<{ session?: string; phase?: string | null; subagents?: Array<{ phase?: string | null }> }>;
        workflows?: Array<{ id?: string; running?: boolean }>;
      }
    | null
    | undefined,
  state: MultitaskFilterState | null | undefined
) => {
  const st = state || {};
  const activeOnly = !!st.activeOnly;
  const dAg = st.dismissedAgents || {};
  const dWf = st.dismissedWorkflows || {};
  const isActive = (p: string | null | undefined) =>
    p === "working" || p === "awaiting-input" || p === "awaiting-permission";
  const agentActive = (a: { phase?: string | null; subagents?: Array<{ phase?: string | null }> }) => {
    if (isActive(a && a.phase)) return true;
    const subs = (a && a.subagents) || [];
    for (let i = 0; i < subs.length; i++) if (isActive(subs[i] && subs[i].phase)) return true;
    return false;
  };
  const allAg = (data && data.agents) || [];
  const agents: typeof allAg = [];
  const completedAgents: string[] = [];
  let activeAgents = 0;
  let hiddenAgents = 0;
  for (let i = 0; i < allAg.length; i++) {
    const a = allAg[i];
    const act = agentActive(a);
    if (act) activeAgents++;
    else completedAgents.push(String(a && a.session));
    if (activeOnly && !act) continue; // active-only hides the inactive outright
    if (!act && dAg[String(a && a.session)]) {
      hiddenAgents++;
      continue;
    } // dismissed — but only while still inactive (reappears when it goes active)
    agents.push(a);
  }
  const allWf = (data && data.workflows) || [];
  const workflows: typeof allWf = [];
  const completedWorkflows: string[] = [];
  let activeWorkflows = 0;
  let hiddenWorkflows = 0;
  for (let j = 0; j < allWf.length; j++) {
    const w = allWf[j];
    const run = !!(w && w.running);
    if (run) activeWorkflows++;
    else completedWorkflows.push(String(w && w.id));
    if (activeOnly && !run) continue;
    if (!run && dWf[String(w && w.id)]) {
      hiddenWorkflows++;
      continue;
    }
    workflows.push(w);
  }
  return {
    agents,
    workflows,
    completedAgents,
    completedWorkflows,
    totalAgents: allAg.length,
    activeAgents,
    hiddenAgents,
    totalWorkflows: allWf.length,
    activeWorkflows,
    hiddenWorkflows,
  };
};

// Plain ES5 concatenation (no template literals / no ${…}) so this lives inside a TS template literal
// without escaping — the only interpolation is the embedded multitaskFilter source (see below).
const OVERVIEW_SCRIPT = `
(function(){
  "use strict";
  var vscode=acquireVsCodeApi();
  // Combined Overview (0.8.0 round 3) — MASTER–DETAIL. LEFT NAV: Fleet (running agents + subagents) ·
  // Workflows (runs), rendered from the multitask --json payload (MT). RIGHT DETAIL: the change-map
  // (Folders strip · churn-ranked Files ledger) for the SELECTED nav item, from changemap
  // --json (CM) — CM.agents[] joined by session, CM.workflows[] by id. Default select = the orchestrator.
  // A missing CLI is a LATCHED diagnosis, not something to re-derive from an empty payload: without
  // this the next repaint replaced "the CLI was not found" with "No agents yet", which is false.
  var CLI_ERR=false, CLI_ERR_HTML='Needs the <b>oak</b> CLI, which was not found. <span style="opacity:.75">Install it (./install.sh), then reload.</span>';
  var PINNED=''; // the pinned session id from settings ('' = following the newest, i.e. Auto)
  var CM=null, MT=null, SEL=null, NAV='sessions', PAL={}, WF_OPEN={}, MOD=null, ROWS=[], RIB_OPEN=false, SELF_KEY=null, SEEN_WF=null, FLASH_WF=null;
  // PR = the processes --json payload behind the Processes tab. Null when the CLI on PATH couldn't
  // answer it (a missing command must never break the panel). OV_SEEN records whether ANY overview
  // payload has arrived yet, so "nothing read yet" and "the CLI answered nothing" stay two different
  // sentences.
  var PR=null, OV_SEEN=false;
  // PR_ID = the picked prompt (Prompts window) — scopes the whole panel to one ask.
  // REQ_ID = the request picked in the REQUESTS WINDOW beside this panel (0.8.7). It is a different kind
  // An ask narrows the WHOLE panel — fleet, runs, shells and the change map all show only what that
  // ask caused.
  // NAVPOS = the live Diff/File step-through position for the nav-bar counters.
  var PR_ID=null, NAVPOS=null;
  // The picked ask's slice, aggregated in core (CM.prompts) — its own files and folders plus the
  // id sets that filter the left nav. Null when nothing is picked, or when the payload predates the
  // pick (an older CLI, or a request that vanished with a session switch).
  function prSlice(){ if(!PR_ID||!CM) return null; var rs=CM.prompts||[];
    for(var i=0;i<rs.length;i++) if(rs[i].id===PR_ID) return rs[i];
    return null; }
  function has(list, id){ if(!list) return false; for(var i=0;i<list.length;i++) if(list[i]===id) return true; return false; }
  // Active-only defaults ON (0.8.8) and persists across hide/show via the webview state API.
  var WVSTATE=(vscode.getState&&vscode.getState())||{};
  var ACTIVE_ONLY=(WVSTATE.activeOnly!==undefined)?!!WVSTATE.activeOnly:true, DISMISS_AG={}, DISMISS_WF={}, DISMISS_PR={};
  // Week-old conversations start collapsed (0.9.0). Not persisted: "expanded" is a look-at-this-now
  // intent, and restoring it across reloads would quietly re-enter the state the fold exists to avoid.
  var SHOW_FOLDED=false;
  // Older sessions in the Sessions tab, same rule as the fleet fold: collapsed by default, not persisted.
  var SHOW_OLDSESS=false;
  // The reader's own Active-only value, parked while the guided tour runs. null = no tour is holding it.
  var TOUR_FILTER=null;
  /** The nav tab the reader was on before the tour moved them. null = no tour is holding it. */
  var TOUR_NAV=null;
  // The pane split, as a percentage of the panel along each axis — one value for the side-by-side layout,
  // one for the stacked one, because a good height is not a good width.
  var NAV_W=(typeof WVSTATE.navW==='number')?WVSTATE.navW:25, NAV_H=(typeof WVSTATE.navH==='number')?WVSTATE.navH:45;
  // Grouped mode is a LAYOUT preference of this panel, not a workspace setting — the same call navW/navH
  // made. It needs its own remembered split, because two or three columns want more of the panel than one
  // list does; both modes drive the SAME custom properties, so the reader's drag still works either way.
  var GROUPNAV=!!WVSTATE.groupedNav;
  var NAV_WG=(typeof WVSTATE.navWG==='number')?WVSTATE.navWG:45, NAV_HG=(typeof WVSTATE.navHG==='number')?WVSTATE.navHG:60;
  // Grouped-mode column layout: one flex-grow weight per column per group (COLW), and the set of columns
  // folded to a rail (COLC). Both are the reader's, and NOTHING recomputes them from a payload — the
  // Processes column is always present and its BADGE arrives on a later tick, so re-deriving either on
  // data arrival would throw away a drag or a fold made seconds earlier.
  var COLW=(WVSTATE.colW&&typeof WVSTATE.colW==='object')?WVSTATE.colW:{};
  var COLC=(WVSTATE.colC&&typeof WVSTATE.colC==='object')?WVSTATE.colC:{};
  var COL_MIN=150; // the floor a drag clamps against — the same 150px below which a name cannot be read
  function saveState(){ try{ vscode.setState({ activeOnly:ACTIVE_ONLY, navW:NAV_W, navH:NAV_H, groupedNav:GROUPNAV, navWG:NAV_WG, navHG:NAV_HG, colW:COLW, colC:COLC }); }catch(e){} }
  // --- the pane splitter -----------------------------------------------------------------------
  // A fixed 25% nav is wrong on a laptop: docked short and wide, the change map takes the panel and the
  // nav's own rows wrap a word at a time. The gutter drags, double-click restores the default, and the
  // size is remembered per axis across hide/show and reload.
  // Assigned by the splitter IIFE below; the grouped-nav toggle re-applies the split when the mode flips,
  // which is why it cannot stay private to that closure.
  var applySplit=function(){};
  (function(){
    var g=document.getElementById('ov-gutter'), ov=document.querySelector('.ov'), root=document.documentElement;
    if(!g||!ov) return;
    function stacked(){ return window.matchMedia('(max-width: 640px)').matches; }
    applySplit=function(){ root.style.setProperty('--ov-nav', (GROUPNAV?NAV_WG:NAV_W)+'%'); root.style.setProperty('--ov-navv', (GROUPNAV?NAV_HG:NAV_H)+'%'); };
    function clamp(p){ return Math.max(12, Math.min(80, p)); }
    function setFrom(ev){
      var r=ov.getBoundingClientRect();
      var pct = stacked() ? ((ev.clientY-r.top)/(r.height||1))*100 : ((ev.clientX-r.left)/(r.width||1))*100;
      if(!isFinite(pct)) return;
      // The drag writes the value for the mode that is on, so switching modes restores the size the
      // reader chose FOR that mode rather than carrying a two-column width onto a one-list pane.
      if(stacked()){ if(GROUPNAV) NAV_HG=clamp(pct); else NAV_H=clamp(pct); }
      else { if(GROUPNAV) NAV_WG=clamp(pct); else NAV_W=clamp(pct); }
      applySplit();
    }
    applySplit();
    g.addEventListener('pointerdown', function(ev){
      ev.preventDefault(); g.classList.add('drag');
      try{ g.setPointerCapture(ev.pointerId); }catch(e){}
      function move(e2){ setFrom(e2); }
      function up(e2){
        g.classList.remove('drag');
        try{ g.releasePointerCapture(ev.pointerId); }catch(e){}
        g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', up);
        saveState();
      }
      g.addEventListener('pointermove', move); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
    });
    g.addEventListener('dblclick', function(){
      if(stacked()){ if(GROUPNAV) NAV_HG=60; else NAV_H=45; } else { if(GROUPNAV) NAV_WG=45; else NAV_W=25; }
      applySplit(); saveState(); });
  })();
  var tip=document.getElementById('cm-tip');
  // The one DISPLAY filter (Active-only / Clear-completed), embedded VERBATIM from the host's exported
  // multitaskFilter so the UI runs the exact code the smoke test verifies. Pure over the MT payload.
  var MTFILTER = ${multitaskFilter.toString()};
  function fstate(){ return { activeOnly:ACTIVE_ONLY, dismissedAgents:DISMISS_AG, dismissedWorkflows:DISMISS_WF }; }
  // Where a member's list currently lives. Grouped mode composes its own list node per column, so this is
  // the ONE thing that moves between modes — every renderer below stays the single renderer for its member
  // rather than growing a second, grouped variant that could drift from it. Falls back to the solo pane's
  // node, so a renderer called before the columns exist still writes somewhere real.
  function paneHost(k){ var g=GROUPNAV? document.getElementById('ov-g-'+k) : null; return g || document.getElementById('ov-'+k); }
  // Blank a member's list without asserting anything about it — used where the payload went away and the
  // rows on screen belong to a session/state that no longer exists.
  function clearNavLists(keys){ for(var i=0;i<keys.length;i++){ var el=paneHost(keys[i]); if(el) el.innerHTML=''; } }
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function base(p){ if(!p) return ''; var s=String(p); var i=s.lastIndexOf('/'); return i>=0? s.slice(i+1): s; }
  function readPal(){ var cs=getComputedStyle(document.documentElement); function v(n,d){ return (cs.getPropertyValue(n)||'').trim()||d; }
    PAL={ pending:v('--cm-pending','#d9a441'), kept:v('--cm-kept','#3fb950'), reverted:v('--cm-reverted','#9aa0aa'), risk:v('--cm-risk','#e5534b'), agent:v('--cm-agent','#9a6ac2'), accent:v('--cm-accent','#4c8bf5'),
      working:v('--mt-working','#4c8bf5'), attn:v('--mt-attn','#d9822b'), warn:v('--mt-warn','#e5534b'), idle:v('--mt-idle','#9aa0aa'), done:v('--mt-done','#3fb950') }; }
  var PHASE={ 'working':'working', 'awaiting-input':'awaiting input', 'awaiting-permission':'awaiting permission', 'idle':'idle', 'errored':'errored', 'done':'done' };
  function phaseColor(p){ if(p==='working') return PAL.working; if(p==='awaiting-input'||p==='awaiting-permission') return PAL.attn; if(p==='errored') return PAL.warn; if(p==='done') return PAL.done; return PAL.idle; }
  function phaseLabel(p){ return PHASE[p] || (p||'—'); }
  function fmtTok(n){ n=n||0; if(n>=1e6) return (n/1e6).toFixed(1)+'M'; if(n>=1e3) return Math.round(n/1e3)+'k'; return ''+n; }
  function fmtDur(ms){ ms=ms||0; var s=Math.round(ms/1000); if(s<60) return s+'s'; var m=Math.round(s/60); if(m<60) return m+'m'; return (m/60).toFixed(1)+'h'; }
  function spark(arr){ arr=arr||[]; var n=arr.length||1, max=1; for(var i=0;i<arr.length;i++) if(arr[i]>max) max=arr[i];
    var w=100,h=16,bw=w/n,g=''; for(var j=0;j<arr.length;j++){ var bh=arr[j]>0? Math.max(1.2, arr[j]/max*h):0; g+='<rect x="'+(j*bw).toFixed(2)+'" y="'+(h-bh).toFixed(2)+'" width="'+(bw*0.72).toFixed(2)+'" height="'+bh.toFixed(2)+'"/>'; }
    return '<svg class="mt-spark" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none">'+g+'</svg>'; }
  function riskCount(r){ if(r==null) return 0; if(typeof r==='number') return r; return r.total||0; }
  function riskHigh(r){ return (r&&typeof r==='object')? (r.high||0):0; }
  function agentCollisions(a){ var c=(MT&&MT.collisions)||[]; var hit=0; for(var i=0;i<c.length;i++){ var ags=c[i].agents||[]; if(ags.indexOf(a.session)>=0) hit++; } return hit; }

  // --- selection + detail slice (join the MT nav to the CM detail by session / workflowId) -----------
  function selfSession(){ var ag=(MT&&MT.agents)||[]; for(var i=0;i<ag.length;i++){ if(ag[i].self) return ag[i].session; } return ag.length?ag[0].session:''; }
  function cmAgent(s){ var ag=(CM&&CM.agents)||[]; for(var i=0;i<ag.length;i++) if(ag[i].session===s) return ag[i]; return null; }
  function wfById(id){ var ws=(CM&&CM.workflows)||[]; for(var i=0;i<ws.length;i++) if(ws[i].id===id) return ws[i]; return null; }
  function selAgentSess(){ return SEL&&SEL.kind==='agent'?SEL.session:null; }
  function selWf(){ return SEL&&SEL.kind==='workflow'?SEL.id:null; }
  // Default DETAIL = the orchestrator (the self agent), else the first agent, else the first workflow.
  function ensureSel(){
    if(SEL){ if(SEL.kind==='agent' && cmAgent(SEL.session)) return; if(SEL.kind==='workflow' && wfById(SEL.id)) return; }
    var s=selfSession(); if(s && cmAgent(s)){ SEL={kind:'agent', session:s}; return; }
    var ag=(CM&&CM.agents)||[]; if(ag.length){ SEL={kind:'agent', session:ag[0].session}; return; }
    var wf=(CM&&CM.workflows)||[]; if(wf.length){ SEL={kind:'workflow', id:wf[0].id}; return; }
    SEL = s ? {kind:'agent', session:s} : null;
  }
  // A synthetic per-workflow detail slice: its rollup → chips, files → strip/ledger.
  function workflowSlice(id){ var w=wfById(id); if(!w) return CM;
    var r=w.rollup||{edits:0,added:0,removed:0,pending:0,kept:0,undone:0};
    return { summary:{ session:w.name, units:r.edits, pending:r.pending, kept:r.kept, undone:r.undone, added:r.added, removed:r.removed, subagents:0, errors:0 }, files:w.files||[], modules:[], rollupByTask:[] }; }
  // The picked ask as a change-map slice — the same shape as a workflow's, so the strip/ledger below
  // render it unchanged. Core aggregated it (per-prompt files and folders); nothing is re-derived here.
  function promptSliceView(){ var r=prSlice(); if(!r) return null;
    return { summary:{ session:'#'+r.index, units:r.rollup.edits, pending:r.rollup.pending, kept:r.rollup.kept, undone:r.rollup.undone, added:r.rollup.added, removed:r.rollup.removed, subagents:(r.agentIds||[]).length, errors:r.errors },
      files:r.files||[], modules:r.modules||[], rollupByTask:[],
      compactions:((CM&&CM.compactions)||[]).filter(function(c){ return c.ts>=r.ts && (!r.endTs || c.ts<r.endTs); }) }; }
  // A not-found agent yields an EMPTY slice (not the whole self change-map) so a stale/lagging selection shows
  // "no edits yet" rather than silently falling back to the orchestrator's map.
  // A picked PROMPT outranks the nav selection: it is the coarser scope and the more explicit choice —
  // the reader named an ask, and every pane on this panel is filtered to it. Selecting a row in the
  // filtered nav still re-points the FEED (what is it doing), which doesn't conflict with that.
  function detailSlice(){ var rq=promptSliceView(); if(rq) return rq;
    if(!SEL) return CM; if(SEL.kind==='workflow') return workflowSlice(SEL.id); return cmAgent(SEL.session)||{ summary:null, files:[], modules:[], rollupByTask:[] }; }

  // --- right DETAIL rendering (change-map for the selected nav item) ---------------------------------
  function colorOf(st){ return st==='pending'?PAL.pending:(st==='undone'?PAL.reverted:PAL.kept); }
  function weight(o){ return Math.max(1,o.churn); }
  function modLabel(m){ var ms=(detailSlice()||{}).modules||[]; for(var i=0;i<ms.length;i++) if(ms[i].module===m) return ms[i].label; return m; }
  function rankedFiles(){ return ((detailSlice()||{}).files||[]).slice(); }
  function rankedModules(){ return ((detailSlice()||{}).modules||[]).slice(); }
  // Active-only (shared with the fleet/workflow nav toggle) also scopes the change-map DETAIL to work still
  // awaiting review — a file with no pending edits drops out, so a fully-reviewed slice reads empty.
  var FILTER='';
  // The filter/sort control's state, pushed from the host. FSPEC narrows by extension/type on top of
  // the Search query (FILTER); SORT orders the ledger (time = most recent first, name = A→Z).
  var FSPEC={ exts:[], categories:[] };
  var SORT='time';
  // The query reads as a regex the moment it carries regex syntax — a char-set test (not a regex, to
  // dodge escaping), matching core.isRegexQuery: a dot or slash is NOT a signal.
  function isRegexQ(q){ for(var i=0;i<q.length;i++){ if('^$*+?()[]{}|\\\\'.indexOf(q.charAt(i))>=0) return true; } return false; }
  // relTime, the webview copy (core.relTime runs host-side; the webview has only the payload's maxTs).
  function relAge(ts){ if(!ts) return '—'; var d=new Date(ts), n=new Date(); function p2(x){ return (x<10?'0':'')+x; }
    var MN=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if(d.getFullYear()===n.getFullYear() && d.getMonth()===n.getMonth() && d.getDate()===n.getDate()) return p2(d.getHours())+':'+p2(d.getMinutes())+':'+p2(d.getSeconds());
    if(d.getFullYear()===n.getFullYear()) return MN[d.getMonth()]+' '+d.getDate()+' '+p2(d.getHours())+':'+p2(d.getMinutes());
    return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate()); }
  function queryOk(rel){ if(!FILTER) return true; var q=(''+FILTER).trim(); if(isRegexQ(q)){ try{ return new RegExp(q,'i').test(rel); }catch(e){ return rel.toLowerCase().indexOf(q.toLowerCase())>=0; } } return rel.toLowerCase().indexOf(q.toLowerCase())>=0; }
  // ---- the inline filter/sort toolbar (search field + filter dropdown + sort label) ----------------
  var CATLBL={ code:'Code', tests:'Tests', config:'Config', docs:'Docs', styles:'Styles', other:'Other' };
  // The unfiltered files of the current detail — the dropdown offers only the types/extensions present,
  // and reads them BEFORE the filter so unchecking a bucket still shows its option.
  function detailFiles(){ return (detailSlice()||{}).files||[]; }
  function presentCats(){ var order=['code','tests','config','docs','styles','other'],files=detailFiles(),out=[]; for(var i=0;i<order.length;i++){ for(var j=0;j<files.length;j++){ if((files[j].category||'other')===order[i]){ out.push(order[i]); break; } } } return out; }
  function presentExts(){ var files=detailFiles(),seen={},out=[]; for(var j=0;j<files.length;j++){ var e=files[j].ext||''; if(e&&!seen[e]){ seen[e]=1; out.push(e); } } out.sort(); return out; }
  // What the filter is narrowing by — the query (shown /…/ when it is a live regex, quoted when
  // literal), then the buckets and extensions. '' when nothing is applied.
  function filterSummaryStr(){ var bits=[],q=(''+(FILTER||'')).trim(); if(q) bits.push(isRegexQ(q)?('/'+q+'/'):('"'+q+'"')); var cs=FSPEC.categories||[]; for(var i=0;i<cs.length;i++) bits.push(CATLBL[cs[i]]||cs[i]); var es=FSPEC.exts||[]; for(var j=0;j<es.length;j++) bits.push('.'+es[j]); return bits.join(', '); }
  // Push the current state onto the toolbar chrome: the sort label names the mode, the filter label
  // names what is applied (and lights up), the search field mirrors the query unless it is being typed.
  // The sort control's four choices — a direction each way on two axes — with a compact label for the
  // toolbar button. A dropdown (not a two-way toggle) so every order is one click, like VS Code's own
  // "Sort by" menu.
  var SORT_OPTS=[['time','Time (newest first)','Newest'],['time-asc','Time (oldest first)','Oldest'],['name','Name (A→Z)','A→Z'],['name-desc','Name (Z→A)','Z→A']];
  function sortShort(k){ for(var i=0;i<SORT_OPTS.length;i++) if(SORT_OPTS[i][0]===k) return SORT_OPTS[i][2]; return 'Newest'; }
  function syncFilterUI(){
    var sl=document.getElementById('ov-sort-lbl'); if(sl) sl.textContent='Sort: '+sortShort(SORT);
    var sum=filterSummaryStr();
    var fl=document.getElementById('ov-filter-lbl'); if(fl) fl.textContent= sum ? sum : 'Filter';
    var fb=document.getElementById('ov-filter'); if(fb){ if(sum) fb.classList.add('on'); else fb.classList.remove('on'); }
    var si=document.getElementById('ov-search-input'); if(si && document.activeElement!==si) si.value=(FILTER||'');
  }
  function renderSortDrop(){
    var d=document.getElementById('ov-sortdrop'); if(!d) return;
    var html='<div class="ov-fd-head">Sort by</div>';
    for(var i=0;i<SORT_OPTS.length;i++){ var k=SORT_OPTS[i][0]; html+='<div class="ov-fd-row ov-sortrow" data-sort="'+k+'"><span class="ov-fd-ck">'+(SORT===k?'✓':'')+'</span>'+SORT_OPTS[i][1]+'</div>'; }
    d.innerHTML=html;
  }
  function applySort(k){ SORT=k; vscode.postMessage({type:'setSort', sort:k}); paint(); syncFilterUI(); }
  var SDROP_OPEN=false;
  function closeSortDrop(){ SDROP_OPEN=false; var d=document.getElementById('ov-sortdrop'); if(d) d.hidden=true; var b=document.getElementById('ov-sort'); if(b) b.setAttribute('aria-expanded','false'); }
  function renderFilterDrop(){
    var d=document.getElementById('ov-filterdrop'); if(!d) return;
    var cats=presentCats(),exts=presentExts(),html='';
    if(cats.length){ html+='<div class="ov-fd-head">File type</div>'; for(var i=0;i<cats.length;i++){ var c=cats[i],on=(FSPEC.categories||[]).indexOf(c)>=0; html+='<label class="ov-fd-row"><input type="checkbox" data-cat="'+c+'"'+(on?' checked':'')+'>'+(CATLBL[c]||c)+'</label>'; } }
    if(exts.length){ html+='<div class="ov-fd-head">Extension</div>'; for(var j=0;j<exts.length;j++){ var e=exts[j],one=(FSPEC.exts||[]).indexOf(e)>=0; html+='<label class="ov-fd-row"><input type="checkbox" data-ext="'+e+'"'+(one?' checked':'')+'>.'+e+'</label>'; } }
    html = (html||'<div class="ov-fd-empty">No files to filter yet.</div>') + '<div class="ov-fd-foot"><button type="button" id="ov-fd-clear">Clear filter</button></div>';
    d.innerHTML=html;
  }
  // Apply the picked buckets/extensions: locally (immediate) AND to the host (so Traces stays in step).
  function applyFilterSpec(){ vscode.postMessage({type:'setFilterSpec', exts:FSPEC.exts, categories:FSPEC.categories}); paint(); syncFilterUI(); }
  var FDROP_OPEN=false, SEARCH_T=null;
  function closeFilterDrop(){ FDROP_OPEN=false; var d=document.getElementById('ov-filterdrop'); if(d) d.hidden=true; var b=document.getElementById('ov-filter'); if(b) b.setAttribute('aria-expanded','false'); }
  function wireFilterUI(){
    var si=document.getElementById('ov-search-input');
    if(si){ si.value=(FILTER||''); si.addEventListener('input', function(){ FILTER=si.value; paint(); syncFilterUI(); if(SEARCH_T) clearTimeout(SEARCH_T); SEARCH_T=setTimeout(function(){ vscode.postMessage({type:'setQuery', q:si.value}); }, 200); });
      si.addEventListener('keydown', function(ev){ if(ev.key==='Escape'){ si.value=''; FILTER=''; paint(); syncFilterUI(); vscode.postMessage({type:'setQuery', q:''}); } }); }
    var fb=document.getElementById('ov-filter');
    if(fb){ fb.addEventListener('click', function(ev){ ev.stopPropagation(); var d=document.getElementById('ov-filterdrop'); if(!d) return; closeSortDrop(); FDROP_OPEN=!FDROP_OPEN; if(FDROP_OPEN){ renderFilterDrop(); d.hidden=false; fb.setAttribute('aria-expanded','true'); } else closeFilterDrop(); }); }
    var d=document.getElementById('ov-filterdrop');
    if(d){ d.addEventListener('click', function(ev){ ev.stopPropagation(); }); // clicks inside stay inside
      d.addEventListener('change', function(ev){ var t=ev.target; if(!t) return;
        var cat=t.getAttribute&&t.getAttribute('data-cat'), ext=t.getAttribute&&t.getAttribute('data-ext');
        if(cat){ var cs=(FSPEC.categories||[]).slice(),ci=cs.indexOf(cat); if(t.checked&&ci<0) cs.push(cat); else if(!t.checked&&ci>=0) cs.splice(ci,1); FSPEC.categories=cs; applyFilterSpec(); }
        else if(ext){ var es=(FSPEC.exts||[]).slice(),ei=es.indexOf(ext); if(t.checked&&ei<0) es.push(ext); else if(!t.checked&&ei>=0) es.splice(ei,1); FSPEC.exts=es; applyFilterSpec(); } });
      d.addEventListener('click', function(ev){ if(ev.target&&ev.target.id==='ov-fd-clear'){ FSPEC.categories=[]; FSPEC.exts=[]; renderFilterDrop(); applyFilterSpec(); } }); }
    // Sort — the same anchored dropdown shape, but its rows are the four orders (radio, not checkbox).
    var sb=document.getElementById('ov-sort');
    if(sb){ sb.addEventListener('click', function(ev){ ev.stopPropagation(); var sd=document.getElementById('ov-sortdrop'); if(!sd) return; closeFilterDrop(); SDROP_OPEN=!SDROP_OPEN; if(SDROP_OPEN){ renderSortDrop(); sd.hidden=false; sb.setAttribute('aria-expanded','true'); } else closeSortDrop(); }); }
    var sd=document.getElementById('ov-sortdrop');
    if(sd){ sd.addEventListener('click', function(ev){ ev.stopPropagation(); var r=ev.target; while(r && r!==sd && !(r.getAttribute&&r.getAttribute('data-sort'))) r=r.parentNode; if(r&&r.getAttribute){ var k=r.getAttribute('data-sort'); if(k){ applySort(k); closeSortDrop(); } } }); }
    // A click anywhere else closes whichever dropdown is open — the inline analogue of dismissing a pop-up.
    document.addEventListener('click', function(){ if(FDROP_OPEN) closeFilterDrop(); if(SDROP_OPEN) closeSortDrop(); });
    syncFilterUI();
  }
  function visible(f){ if(MOD!==null && f.moduleLabel!==MOD) return false; if(ACTIVE_ONLY && !(f.pending>0)) return false;
    var rel=String(f.rel||f.file||'');
    if(!queryOk(rel)) return false;
    if(FSPEC.exts&&FSPEC.exts.length&&FSPEC.exts.indexOf(f.ext||'')<0) return false;
    if(FSPEC.categories&&FSPEC.categories.length&&FSPEC.categories.indexOf(f.category||'other')<0) return false;
    return true; }
  function sortFiles(a){ var s=a.slice(); if(SORT==='name') s.sort(function(x,y){ return String(x.rel||'').localeCompare(String(y.rel||'')); });
    else s.sort(function(x,y){ return (y.maxTs||0)-(x.maxTs||0) || String(x.rel||'').localeCompare(String(y.rel||'')); }); return s; }
  // Relabel the top-navbar bulk buttons to reflect the current scope: a selected prompt → "…in #N",
  // else session-wide. Tooltips carry the FULL prompt title — content text is not truncated.
  function relabelBulk(){
    var rq=prSlice();
    var scoped = rq, nm = rq ? ('#'+rq.index) : '';
    var what = rq ? ('prompt #'+rq.index+' — “'+rq.title+'”') : '';
    // innerHTML (not textContent) so the codicon <i> survives; esc() the label since it's user content.
    function set(id, icon, base, scoped2, tip, tipScoped){ var b=document.getElementById(id); if(!b) return; b.innerHTML='<i class="codicon codicon-'+icon+'"></i> '+esc(scoped?scoped2:base); b.title=scoped?tipScoped:tip; }
    set('ov-keepall','checklist','Accept All','Accept All in '+nm,'Accept all edits in this session','Accept all pending edits in the '+what);
    set('ov-undoall','close-all','Reject All','Reject All in '+nm,'Reject (revert) every pending edit in this session','Reject (revert) all pending edits in the '+what);
    set('ov-clearres','clear-all','Clear Resolved','Clear in '+nm,'Clear resolved (kept / reverted) edits','Clear resolved edits in the '+what);
  }
  // Is the folder strip showing every folder, or the top movers plus a tail chip? Collapsed by default:
  // a busy session spans dozens of folders and the ranked head is what carries the session's shape.
  // The state is keyed by SCOPE (JetBrains parity): picking another agent, workflow, or prompt starts
  // folded again, while a refresh of the same scope leaves the strip as the reader left it.
  var STRIP_ALL=false, STRIP_SCOPE=null;
  function renderStrip(){ var mods=rankedModules();
    var scope = PR_ID ? ('p:'+PR_ID) : (SEL ? (SEL.kind+':'+(SEL.session||SEL.id||'')) : '');
    if(scope!==STRIP_SCOPE){ STRIP_SCOPE=scope; STRIP_ALL=false; }
    // Cap the strip: a busy session can span dozens of modules, and even wrapped they push the ledger
    // off-screen — keep the top movers, fold the tail into one "+K more" chip that EXPANDS to the rest.
    var MAXSEG=11, extra=null;
    if(!STRIP_ALL && mods.length>MAXSEG){ var tail=mods.slice(MAXSEG); mods=mods.slice(0,MAXSEG);
      var tw=0, tf=0; for(var t=0;t<tail.length;t++){ tw+=weight(tail[t]); tf+=tail[t].files; }
      extra={n:tail.length,lines:tw,files:tf}; }
    var h='';
    for(var j=0;j<mods.length;j++){ var m=mods[j];
      var sel=(MOD===m.module), op=(MOD!==null&&!sel)?0.35:0.9;
      h+='<button class="cm-sg'+(sel?' sel':'')+'" data-mod="'+esc(m.module)+'" style="background:'+colorOf(m.status)+';opacity:'+op+'" title="folder '+esc(m.label)+' · '+weight(m)+' lines · '+m.files+' file(s) — click to open it in the Folder axis">'+
        '<span class="cm-sl">'+esc(m.label)+'</span></button>';
    }
    if(extra) h+='<button class="cm-sg cm-sgx" data-more="1" title="'+extra.n+' more folder(s) · '+extra.lines+' lines · '+extra.files+' file(s) — click to show them all">'+
      '+'+extra.n+' more</button>';
    else if(STRIP_ALL && mods.length>MAXSEG) h+='<button class="cm-sg cm-sgx" data-less="1" title="Show only the top '+MAXSEG+' folders by lines changed">show fewer</button>';
    var host=document.getElementById('cm-strip'); host.innerHTML=h;
    host.className='cm-strip'+(STRIP_ALL?' open':'');
    var cap=document.getElementById('cm-cap-folders'); if(cap) cap.style.display=(mods.length||extra)?'block':'none';
    var bs=host.querySelectorAll('.cm-sg');
    // Click a folder tile → filter the ledger to it AND jump the nav-bar Folder axis there (open its first
    // pending edit). The tail chips carry no data-mod: they only open or re-fold the strip.
    for(var b=0;b<bs.length;b++) bs[b].addEventListener('click', function(){
      if(this.getAttribute('data-more')){ STRIP_ALL=true; renderStrip(); return; }
      if(this.getAttribute('data-less')){ STRIP_ALL=false; renderStrip(); return; }
      var m=this.getAttribute('data-mod'); MOD=(MOD===m)?null:m; if(MOD!==null && m!==null) vscode.postMessage({type:'revealFolder', folder:m}); paintDetail(); });
  }
  // Bottom summary bar. Scope precedence: the picked PROMPT → a folder-tile filter → the visible
  // ledger. A prompt scope shows the ask's own counts; a folder filter shows the folder name; the whole
  // view shows unnamed totals.
  function renderSummary(){ var sumEl=document.getElementById('cm-summary'); if(!sumEl) return;
    // A picked REQUEST outranks every other scope — it is the most explicit thing the reader did, and
    // since 0.8.7 core aggregates that ask's own files and folders, so this reports the ask's real
    // footprint rather than omitting it. A folder-tile filter still narrows it further (below).
    var rq=prSlice();
    if(rq && !MOD){
      sumEl.title=rq.text||rq.title; // the ask itself is named in full by the scope bar above
      var rp=['<b style="color:'+PAL.accent+'">'+esc('#'+rq.index)+'</b>',
        '<b style="color:'+PAL.pending+'">'+rq.rollup.pending+'</b> pending',
        '<b style="color:'+PAL.kept+'">'+rq.rollup.kept+'</b> accepted'];
      if(rq.rollup.undone) rp.push('<b style="color:'+PAL.reverted+'">'+rq.rollup.undone+'</b> reverted');
      rp.push('<b>'+rq.rollup.edits+'</b> edit'+(rq.rollup.edits===1?'':'s'),
        '<b>'+(rq.files||[]).length+'</b> file'+((rq.files||[]).length===1?'':'s'),
        '<b>'+(rq.modules||[]).length+'</b> folder'+((rq.modules||[]).length===1?'':'s'));
      sumEl.innerHTML=rp.join(' · ');
      return;
    }
    var a=detailSlice()||{}, sp=0, sk=0, su=0, folders={}, nfiles=0, name=null;
    // the visible ledger; name it after an active folder filter.
    for(var si=0;si<ROWS.length;si++){ var sf=ROWS[si]; sp+=sf.pending||0; sk+=sf.kept||0; su+=sf.undone||0; folders[sf.moduleLabel]=1; }
    nfiles=ROWS.length;
    if(MOD) name=MOD;
    var nfo=0; for(var fk in folders) nfo++;
    if(name==null && !nfiles){ sumEl.innerHTML=''; return; }
    var parts=[];
    if(name!=null) parts.push('<b style="color:'+PAL.accent+'">'+esc(name)+'</b>');
    parts.push('<b style="color:'+PAL.pending+'">'+sp+'</b> pending', '<b style="color:'+PAL.kept+'">'+sk+'</b> accepted');
    if(su) parts.push('<b style="color:'+PAL.reverted+'">'+su+'</b> reverted');
    parts.push('<b>'+nfiles+'</b> file'+(nfiles===1?'':'s'), '<b>'+nfo+'</b> folder'+(nfo===1?'':'s'));
    // Nothing here about .observatoryignore: under one mode a matching path is never recorded, so
    // there is no count to report — the summary describes what the session HAS, and an ignored file
    // was never part of it.
    sumEl.innerHTML=parts.join(' · ');
  }
  function renderLedger(){
    var files=rankedFiles(), shown=[];
    for(var i=0;i<files.length;i++) if(visible(files[i])) shown.push(files[i]);
    shown=sortFiles(shown);
    ROWS=shown;
    var h='';
    for(var k=0;k<shown.length;k++){ var f=shown[k];
      // A ROW, not a button: it carries two buttons of its own now, and a button inside a button is
      // invalid markup that browsers resolve by dropping one of them. The name is the click target.
      h+='<div class="cm-row" data-idx="'+k+'">'+
        // "N min ago" to the LEFT of the file — the most-recent edit time, dim.
        '<span class="cm-age" title="last edited '+relAge(f.maxTs)+'">'+relAge(f.maxTs)+'</span>'+
        '<button class="cm-open" data-idx="'+k+'" title="Open the diff for this file">'+
          '<span class="cm-dot" style="background:'+colorOf(f.status)+'"></span>'+
          '<span class="cm-fn">'+esc(f.file)+(f.agent?'<span class="cm-ag">●</span>':'')+(f.risk?'<span class="cm-rk">⌐</span>':'')+'</span>'+
          '<span class="cm-md">'+esc(f.moduleLabel)+'</span>'+
        '</button>'+
        // NO churn bar — the terminal's map made the
        // same call (changemap.ts: a proportional meter answers "which is biggest", which is what
        // SORTING is for). The name takes the freed width instead of a track of empty space.
        // Added and removed, APART — the same change the terminal's map made. +900/−4 and +4/−900 are
        // the same churn and are not remotely the same change to review.
        '<span class="cm-n" title="lines added"><span style="color:'+PAL.kept+'">+'+(f.added||0)+'</span></span>'+
        '<span class="cm-n" title="lines removed"><span style="color:'+PAL.reverted+'">−'+(f.removed||0)+'</span></span>'+
        // Pending and accepted as NUMBERS. "How much is left to review here" is what this ledger is
        // for, and a proportional bar cannot answer it.
        '<span class="cm-pd" title="pending edits"><span style="color:'+PAL.pending+'">'+(f.pending||0)+'⧗</span></span>'+
        '<span class="cm-pd" title="accepted edits"><span style="color:'+PAL.kept+'">'+(f.kept||0)+'✓</span></span>'+
        // The stacked opener: every change in this file as the stacked layout —
        // the same view the feed's edit clicks open.
        '<button class="cm-act cm-stk" data-idx="'+k+'" data-act="stack" title="Open this file&#39;s changes stacked">⧉</button>'+
        // The two actions, on the row that names what they act on. Disabled — not hidden — when there
        // is nothing pending, so the row keeps its shape and the reason is in the tooltip.
        '<button class="cm-act cm-keep" data-idx="'+k+'" data-act="keep"'+(f.pending?'':' disabled title="nothing pending in this file"')+(f.pending?' title="Keep the '+f.pending+' pending edit(s) in this file"':'')+'>✓</button>'+
        '<button class="cm-act cm-undo" data-idx="'+k+'" data-act="undo"'+(f.pending?'':' disabled title="nothing pending in this file"')+(f.pending?' title="Undo the '+f.pending+' pending edit(s) in this file"':'')+'>✗</button>'+
        '</div>';
    }
    var host=document.getElementById('cm-ledger');
    host.innerHTML=h||'<div class="cm-none">nothing matches this filter</div>';
    var fcap=document.getElementById('cm-cap-files'); if(fcap) fcap.style.display=shown.length?'block':'none';
    renderSummary();
    // An active Search filter narrows this ledger too — say so, or an emptied list reads as a bug.
    if(FILTER) document.getElementById('cm-readout').innerHTML='search “'+esc(FILTER)+'” · '+shown.length+' file(s) — Search again (empty) to clear';
    var rs=host.querySelectorAll('.cm-row');
    for(var r=0;r<rs.length;r++){
      rs[r].addEventListener('mousemove', function(ev){ showTip(ev, ROWS[+this.getAttribute('data-idx')]); });
      rs[r].addEventListener('mouseleave', hideTip);
    }
    var os=host.querySelectorAll('.cm-open');
    for(var o=0;o<os.length;o++){
      os[o].addEventListener('click', function(){ var f=ROWS[+this.getAttribute('data-idx')]; if(f&&f.maxId>=0){ vscode.postMessage({type:'openEdit', id:f.maxId}); document.getElementById('cm-readout').innerHTML='→ <b>open diff</b> · '+esc(f.file)+' (edit #'+f.maxId+')'; } });
    }
    // Keep / Undo, scoped to the FILE the row names. The host resolves the edit set through the CLI's
    // own --under scope, so the ledger, the terminal's change map and the folder actions in the trees
    // all act on exactly the same rule instead of three id sets that could disagree.
    // (No backticks in this comment: it lives inside the webview template literal, where one would
    // terminate the string and take the rest of the script with it.)
    var as=host.querySelectorAll('.cm-act');
    for(var a=0;a<as.length;a++){
      as[a].addEventListener('click', function(ev){
        ev.stopPropagation();
        var f=ROWS[+this.getAttribute('data-idx')]; if(!f) return;
        var act=this.getAttribute('data-act');
        // The stacked opener works on DECIDED files too (the blocks carry verdicts) — no pending gate.
        if(act==='stack'){ if(f.maxId>=0) vscode.postMessage({type:'mapScope', act:'stack', id:f.maxId}); return; }
        if(!f.pending) return;
        vscode.postMessage({type:'mapScope', act:act, rel:f.rel, pending:f.pending, name:f.file});
      });
    }
  }
  function tipHtml(f){ var cls=f.classes||[];
    var clsline=cls.length? cls.slice(0,4).join(', ')+(cls.length>4?' +'+(cls.length-4):'') : 'file scope';
    return '<div class="tf">'+(f.agent?'<span class="ag">●</span> ':'')+esc(f.file)+(f.risk?' <span class="rk">⌐risk</span>':'')+'</div>'+
      '<div class="tm">'+esc(f.rel)+'</div>'+
      '<div class="tm">+'+f.churn+' · '+f.cnt+' unit'+(f.cnt===1?'':'s')+' · '+f.kept+'✓ '+f.pending+'⧗ '+f.undone+'✗</div>'+
      '<div class="tc">'+esc(clsline)+'</div>'+
      (f.reason?'<div class="tw">“'+esc(f.reason)+'”</div>':'')+
      (f.risk?'<div class="trk">⚠ '+esc(f.risk)+'</div>':'')+
      '<div class="ta">click → open the real diff</div>';
  }
  function showTip(ev,f){ if(!f) return; tip.innerHTML=tipHtml(f); tip.style.opacity='1';
    var pad=12, tw=tip.offsetWidth, th=tip.offsetHeight, x=ev.clientX+pad, y=ev.clientY+pad;
    if(x+tw>window.innerWidth) x=ev.clientX-tw-pad; if(y+th>window.innerHeight) y=ev.clientY-th-pad;
    tip.style.left=x+'px'; tip.style.top=y+'px'; }
  function hideTip(){ tip.style.opacity='0'; }
  function updateReadout(){ var ro=document.getElementById('cm-readout'), bits=[];
    if(MOD!==null) bits.push('module <b>'+esc(modLabel(MOD))+'</b>');
    ro.innerHTML = bits.length? ('filtered by '+bits.join(' + ')+' — click again to clear') : '';
  }
  function paintDetail(){ var a=detailSlice(); var empty=document.getElementById('cm-detail-empty');
    // Renderable if the slice has files OR an unassigned strict bucket — an agent/workflow can carry
    // an unassigned rollup with no file ledger yet.
    var hasFiles=!!(a && a.files && a.files.length);
    var hasUn=!!(a && a.rollupByTask && a.rollupByTask.some(function(t){ return t.taskId===null && t.edits>0; }));
    if(!hasFiles && !hasUn){ empty.style.display='block';
      empty.innerHTML=prSlice()? ('Prompt #'+prSlice().index+' changed no files. <span style="opacity:.75">It may have asked, read, or run something instead.</span>')
        : (SEL&&SEL.kind==='workflow')? 'No attributed edits for this workflow yet.'
        : 'No edits for this agent yet. <span style="opacity:.75">This fills in as agent edits files.</span>';
      document.getElementById('cm-strip').innerHTML=''; document.getElementById('cm-ledger').innerHTML=''; document.getElementById('cm-readout').innerHTML='';
      document.getElementById('cm-cap-folders').style.display='none'; document.getElementById('cm-cap-files').style.display='none';
      // A picked PROMPT is scoped to the SESSION, not to this slice — let renderSummary keep naming the ask.
      ROWS=[]; relabelBulk(); renderSummary(); return; }
    empty.style.display='none';
    renderStrip(); renderLedger(); updateReadout(); relabelBulk();
  }

  // --- left NAV: display filter (shared by Fleet + Workflows) ----------------------------------------
  function filterBar(kind, F){
    var wf=kind==='workflows';
    var act=wf?F.activeWorkflows:F.activeAgents, tot=wf?F.totalWorkflows:F.totalAgents, hid=wf?F.hiddenWorkflows:F.hiddenAgents;
    var h='';
    if(ACTIVE_ONLY) h+='<span class="mt-fon" title="Active-only filter is on">'+(wf?'running':'active')+' only · '+act+'/'+tot+'</span>';
    if(hid>0) h+='<span class="mt-fhide" data-tab="'+kind+'" title="Un-hide the completed items you cleared">'+hid+' hidden · show all</span>';
    return h?('<div class="mt-fbar">'+h+'</div>'):'';
  }
  function wireFilterBar(host){ var hb=host.querySelectorAll('.mt-fhide');
    for(var i=0;i<hb.length;i++) hb[i].addEventListener('click', function(){ var t=this.getAttribute('data-tab');
      if(t==='workflows') DISMISS_WF={}; else if(t==='processes') DISMISS_PR={}; else DISMISS_AG={}; paint(); }); }
  // The Active-only controls show a SETTING, not a payload, and since 0.8.8 that setting defaults ON —
  // so they are synced on their own, before any fleet data exists. Leaving them inside syncControls
  // drew them unchecked over an already-filtered panel until the first payload landed.
  function syncToggles(){
    var cb=document.getElementById('mt-active'); if(cb) cb.checked=ACTIVE_ONLY;
    var tg=document.getElementById('ov-activeonly'); if(tg){ tg.classList.toggle('on', ACTIVE_ONLY); tg.setAttribute('aria-pressed', ACTIVE_ONLY?'true':'false'); }
    var gn=document.getElementById('ov-groupnav'); if(gn){ gn.classList.toggle('on', GROUPNAV); gn.setAttribute('aria-pressed', GROUPNAV?'true':'false'); }
  }
  function syncControls(F){
    syncToggles();
    var btn=document.getElementById('mt-clear');
    var donePs=(((PR&&PR.processes)||[]).filter(function(p){return !p.running;}));
    if(btn) btn.disabled = F.completedAgents.every(function(s){return DISMISS_AG[s];})
      && F.completedWorkflows.every(function(i){return DISMISS_WF[i];})
      && donePs.every(function(p){return DISMISS_PR[p.id];});
  }
  function clearCompleted(){
    var F=MTFILTER(MT, fstate());
    for(var i=0;i<F.completedAgents.length;i++) DISMISS_AG[F.completedAgents[i]]=1;
    for(var j=0;j<F.completedWorkflows.length;j++) DISMISS_WF[F.completedWorkflows[j]]=1;
    // A shell that has exited is finished work exactly like a done agent or run, so it folds away with
    // them. Running shells are never dismissed — they are the reason to look at the tab.
    var ps=(PR&&PR.processes)||[];
    for(var k=0;k<ps.length;k++) if(!ps[k].running) DISMISS_PR[ps[k].id]=1;
    paint();
  }

  // A fleet row is one line wide, so the one audit fact that earns a place on it is that the session
  // reached OUTSIDE the workspace you gave it. (0.8.7: the rest of the old footprint row folded into the
  // Risk and Egress audits in the Actions panel, which name the actual files; the row keeps only the
  // glance.) Risk already has its own ⚠ cell here, so this never restates it. Compactions ride along —
  // they happened TO the session and nothing else on the row says so.
  var EXERCISED_NOTE = ' — ${core.EXERCISED_NOTE}';
  function outsideSuffix(a){
    var o=(a&&a.outside)||null, parts=[], tips=[];
    // Reads and writes are ONE glance-level fact ("it went outside"), never one number: a read out there
    // is reach (Egress) and a write is damage (Risk), and a sum would hide which of the two happened.
    var rd=o? (o.reads||0) : 0, wr=o? (o.writes||0) : 0;
    if(rd||wr){ var bits=[];
      if(rd) bits.push(rd+' read');
      if(wr) bits.push(wr+' written');
      parts.push('↗ '+bits.join(' · ')+' outside');
      if(rd) tips.push(rd+' file(s) read outside this workspace — Actions ▸ Egress names them');
      if(wr) tips.push(wr+' file(s) written outside this workspace — Actions ▸ Risk names them'); }
    var nc=a&&a.compactions; nc=(typeof nc==='number')? nc : ((nc&&nc.length)||0);
    if(nc){ parts.push('⤺'+nc); tips.push('context compacted ×'+nc); }
    if(!parts.length) return '';
    return '<span class="mt-cap"'+((rd||wr)?' data-attn="1"':'')+' title="'+esc(tips.join(' · ')+EXERCISED_NOTE)+'">'+esc(parts.join(' · '))+'</span>';
  }
  // --- Fleet: running agents (worktree-siblings) + nested subagents; click selects the DETAIL ---------
  function renderFleet(){ var host=paneHost('fleet'); if(!host) return;
    var F=MTFILTER(MT, fstate()); var vis=F.agents; syncControls(F);
    var h=filterBar('fleet', F);
    // Under an ask scope: only THIS window's session can own your request (a sibling worktree's session
    // answers to nobody who typed here), and its subagent rows narrow to the ones that ask spawned.
    var rqf=prSlice(), fleetHidden=0, subsHidden=0;
    if(rqf){ var keep=[];
      for(var fi=0;fi<vis.length;fi++){ var ag=vis[fi];
        if(SELF_KEY && ag.session!==SELF_KEY){ fleetHidden++; continue; }
        var subs0=ag.subagents||[], kept=[];
        for(var si=0;si<subs0.length;si++) if(has(rqf.agentIds, subs0[si].agentId)) kept.push(subs0[si]);
        subsHidden+=subs0.length-kept.length;
        // A shallow copy: the payload is shared with the other panes and must not be mutated.
        keep.push({ session:ag.session, worktree:ag.worktree, gitBranch:ag.gitBranch, self:ag.self, phase:ag.phase,
          phaseConfidence:ag.phaseConfidence, sparkline:ag.sparkline, diff:ag.diff, tokens:ag.tokens, durationMs:ag.durationMs,
          risk:ag.risk, outside:ag.outside, compactions:ag.compactions, subagents:kept });
      }
      vis=keep;
      if(fleetHidden||subsHidden){ var bits=[];
        if(fleetHidden) bits.push(fleetHidden+' sibling session'+(fleetHidden===1?'':'s'));
        if(subsHidden) bits.push(subsHidden+' subagent'+(subsHidden===1?'':'s'));
        h+='<div class="mt-scope" title="Filtered to prompt #'+rqf.index+' — ‘'+esc(rqf.text||rqf.title)+'’. A sibling worktree’s session is its own conversation; only subagents this prompt spawned belong to it.">'+
          esc(bits.join(' · '))+' hidden — not started by prompt #'+rqf.index+'</div>'; }
    }
    // FOLDED (0.9.0): conversations older than a week sink into a collapsed group. The Overview stopped
    // rebuilding their change maps on every refresh — 24 of 33 sibling sessions in a mature repo — so a
    // folded row often has no numbers to show. That is loaded:false, and it is NOT the same as zero.
    // (No backticks in this region: it is inside the webview template literal, which they would close.)
    var live=[], old=[];
    for(var pi=0;pi<vis.length;pi++) (vis[pi].folded?old:live).push(vis[pi]);
    var rows0=live.concat(old);
    for(var i=0;i<rows0.length;i++){ var a=rows0[i];
      if(old.length && i===live.length){
        h+='<div class="mt-foldhdr" title="Conversations that have been quiet for over a week. They are not rebuilt on refresh — expanding one is what asks for it.">'+
          (SHOW_FOLDED?'▾ ':'▸ ')+old.length+' older session'+(old.length===1?'':'s')+'</div>';
        if(!SHOW_FOLDED) break;
      }
      var col=agentCollisions(a); var sel=(a.session===selAgentSess());
      h+='<div class="mt-agent'+(sel?' sel':'')+(a.folded?' folded':'')+'" data-sess="'+esc(a.session)+'" data-wt="'+esc(a.worktree||'')+'">';
      h+='<div class="mt-arow">';
      h+='<span class="mt-badge" style="background:'+phaseColor(a.phase)+'"'+(a.phaseConfidence==='heuristic'?' title="inferred from inactivity — no structural marker for this state">~':'>')+esc(phaseLabel(a.phase))+'</span>';
      h+='<span class="mt-wt">'+esc(base(a.worktree))+(a.self?'<span class="mt-self">self</span>':'')+(a.gitBranch?'<span class="mt-br">⑂'+esc(a.gitBranch)+'</span>':'')+'</span>';
      if(a.loaded===false){
        // Never draw +0/−0/0 tok for a map nobody built — that reads as "this session did nothing".
        // No apostrophe in this title: the TS template literal would unescape it and break the JS string.
        h+='<span class="mt-unloaded" title="Folded — the change map for this session was not rebuilt, so there are no numbers to show. Open it from the Sessions tab to build one.">not loaded</span>';
      } else {
      h+=spark(a.sparkline);
      h+='<span class="mt-diff"><span class="mt-add">+'+((a.diff&&a.diff.added)||0)+'</span> <span class="mt-rem">−'+((a.diff&&a.diff.removed)||0)+'</span></span>';
      h+='<span class="mt-meta">'+fmtTok(a.tokens)+' tok · '+fmtDur(a.durationMs)+'</span>';
      var rc=riskCount(a.risk); if(rc) h+='<span class="mt-risk"'+(riskHigh(a.risk)?' data-high="1"':'')+' title="'+rc+' risk flag(s)">⚠ '+rc+'</span>';
      if(col) h+='<span class="mt-col" title="'+col+' file(s) also touched by another agent">⇄ '+col+'</span>';
      h+=outsideSuffix(a);
      }
      h+='</div>';
      var subs=a.subagents||[];
      for(var k=0;k<subs.length;k++){ var su=subs[k];
        // A subagent row is feed-selectable: its own transcript is what "what is it doing" means for it.
        var fsel=(FEED&&FEED.kind==='agent'&&su.agentId&&FEED.id===String(su.agentId));
        h+=su.agentId? ('<div class="mt-sub'+(fsel?' sel':'')+'" data-agent="'+esc(su.agentId)+'" data-label="'+esc(su.description||su.agentType||'')+'" title="Follow what this subagent is doing">') : '<div class="mt-sub">';
        h+='<span class="mt-badge sm" style="background:'+phaseColor(su.phase)+'"'+(su.phaseConfidence==='heuristic'?' title="inferred — no completion notice or structural marker for this state yet">~':'>')+esc(phaseLabel(su.phase))+'</span>';
        h+='<span class="mt-st">'+esc(su.agentType||'subagent')+(su.description?'<span class="mt-sd">'+esc(su.description)+'</span>':'')+'</span>';
        if(su.currentTask) h+='<span class="mt-cur" title="'+esc(su.currentTask)+'">▶ '+esc(su.currentTask)+'</span>';
        var td=su.todos||[]; if(td.length) h+='<span class="mt-todo">'+td.length+' todo'+(td.length===1?'':'s')+'</span>';
        h+='<span class="mt-diff sm"><span class="mt-add">+'+(su.added||0)+'</span> <span class="mt-rem">−'+(su.removed||0)+'</span></span>';
        // The spawn's OWN model/effort and its ↑input·↓output·↺cache-read token split + runtime — the same
        // metrics the terminal's detail pane shows next to each spawn agent.
        var sm=[];
        if(su.model) sm.push(esc(su.model)+(su.effort?' · '+esc(su.effort):'')); else if(su.effort) sm.push(esc(su.effort));
        if(su.tokensIn||su.tokensOut||su.tokensCacheRead) sm.push('↑'+fmtTok(su.tokensIn)+' ↓'+fmtTok(su.tokensOut)+' ↺'+fmtTok(su.tokensCacheRead));
        if(su.durationMs) sm.push(fmtDur(su.durationMs));
        if(sm.length) h+='<span class="mt-meta sm">'+sm.join(' · ')+'</span>';
        h+='<button class="mt-chat" data-agent="'+esc(su.agentId)+'" title="Chat about this subagent — copies context, opens your agent"><i class="codicon codicon-comment-discussion"></i></button>';
        h+='</div>';
      }
      h+='</div>';
    }
    if(!vis.length) h+='<div class="mt-none">'+(rqf?('Prompt #'+rqf.index+' started no agent of its own — clear the scope to see the fleet.'):(ACTIVE_ONLY?'No active agents.':'No agents to show.'))+'</div>';
    host.innerHTML=h; wireFilterBar(host);
    var fh=host.querySelector('.mt-foldhdr');
    if(fh) fh.addEventListener('click', function(){ SHOW_FOLDED=!SHOW_FOLDED; renderFleet(); });
    // Live conflicts moved to the Actions panel (0.8.3) — the audit surface owns them now.
    var rows=host.querySelectorAll('.mt-agent');
    // Selecting a fleet row picks its change-map slice AND follows what that session is doing. A sibling
    // agent is a whole SESSION, so its feed is the session kind (a subagent row below is the agent kind).
    for(var r=0;r<rows.length;r++) rows[r].addEventListener('click', function(ev){ if(ev.target && String(ev.target.className||'').indexOf('mt-chat')>=0) return; var s=this.getAttribute('data-sess'); SEL={kind:'agent', session:s}; setFeed('session', s, base(this.getAttribute('data-wt')||'')); paint(); });
    var subs2=host.querySelectorAll('.mt-sub[data-agent]');
    for(var s3=0;s3<subs2.length;s3++) subs2[s3].addEventListener('click', function(ev){ ev.stopPropagation(); setFeed('agent', this.getAttribute('data-agent'), this.getAttribute('data-label')||''); renderFleet(); });
    var bs=host.querySelectorAll('.mt-chat');
    for(var b=0;b<bs.length;b++) bs[b].addEventListener('click', function(ev){ ev.stopPropagation(); var id=this.getAttribute('data-agent'); vscode.postMessage({type:'chatAction', ref:{agentId:id}}); });
  }

  // --- Workflows: the runs — informative name, per-phase progress, tokens/time/edits; click selects ---
  function phaseSummary(w){ var pg=(w&&w.phaseGroups)||[]; if(!pg.length) return '';
    var parts=[]; for(var i=0;i<pg.length;i++) parts.push(esc(pg[i].title)+' '+pg[i].done+'/'+pg[i].total);
    return parts.join(' · '); }
  // NOTE the doubled backslash: this function's body lives inside a TS template literal, so a lone \d
  // is eaten before it ever reaches the webview (this shipped as /^vd+:/ for a while, matching nothing).
  function wagRow(a){ var sid=String(a.agentId||'').replace(/^v\\d+:/,'').slice(0,6);
    // A running workflow's label is DERIVED from the agent's prompt (labelDerived — shown with '~', the
    // heuristic marker); the runner's real labels replace it once the state file lands at completion.
    var lbl=a.label?(a.label+(a.labelDerived?'~':'')):((a.agentType||'agent')+(sid?' '+sid:''));
    // Each agent row carries the same "extras" as the run header: activity sparkline · ±diff · model · tokens · time · edits.
    return '<div class="mt-wag"><span class="mt-badge xs" style="background:'+(a.done?PAL.done:PAL.working)+'"></span>'+
      '<span class="mt-wat">'+esc(lbl)+'</span>'+
      spark(a.sparkline)+
      '<span class="mt-diff sm"><span class="mt-add">+'+(a.added||0)+'</span> <span class="mt-rem">−'+(a.removed||0)+'</span></span>'+
      // Model AND effort — the pair, like the Sessions row's chip. An unknown effort is left OUT
      // rather than guessed: the default differs by build and by model, so a placeholder is fiction.
      '<span class="mt-wmeta">'+(a.model?esc(a.model)+(a.effort?' · '+esc(a.effort):'')+' · ':(a.effort?esc(a.effort)+' · ':''))+fmtTok(a.tokens)+' tok · '+fmtDur(a.durationMs)+' · '+(a.edits||0)+' edit'+(a.edits===1?'':'s')+'</span></div>'; }
  function renderWorkflows(){ var host=paneHost('workflows'); if(!host) return;
    var all=(MT&&MT.workflows)||[];
    if(!all.length){ host.innerHTML='<div class="mt-none">No workflow runs in this session yet.</div>'; return; }
    var F=MTFILTER(MT, fstate()), wf=F.workflows;
    var h=filterBar('workflows', F);
    var wfF=reqFilter(wf, 'workflowIds', function(w){ return w.id; }); wf=wfF.rows; h+=reqNote(wfF, 'workflow run', 'workflow runs');
    if(!wf.length){ host.innerHTML=h+'<div class="mt-none">'+(wfF.scoped?('Prompt #'+prSlice().index+' started no workflow run.'):(ACTIVE_ONLY?'No running workflows.':'No workflow runs to show.'))+'</div>'; wireFilterBar(host); return; }
    for(var i=0;i<wf.length;i++){ var w=wf[i]; var open=(WF_OPEN[w.id]!==false); var ps=phaseSummary(w); var sel=(w.id===selWf());
      h+='<div class="mt-wf'+(sel?' sel':'')+(w.id===FLASH_WF?' flash':'')+'">';
      // Header line: caret · badge · FULL name (wraps, never clipped). Metrics ride their own line below so
      // the long workflow description stays fully readable in the narrow nav.
      h+='<div class="mt-wrow" data-wf="'+esc(w.id)+'" data-name="'+esc(w.description||w.name||'')+'" title="Show this workflow’s change-map">';
      h+='<button class="mt-wcar" data-car="'+esc(w.id)+'" title="'+(open?'collapse':'expand')+' agents">'+(open?'▾':'▸')+'</button>';
      h+='<span class="mt-badge sm" style="background:'+(w.running?PAL.working:PAL.done)+'">'+(w.running?'running':'done')+'</span>';
      h+='<span class="mt-wname">'+esc(w.description||w.name)+'</span>';
      h+='</div>';
      h+='<div class="mt-wmet">'+spark(w.sparkline)+
        '<span class="mt-diff sm"><span class="mt-add">+'+(w.added||0)+'</span> <span class="mt-rem">−'+(w.removed||0)+'</span></span>'+
        '<span class="mt-meta">'+(w.agentCount||(w.agents||[]).length)+' ag · '+fmtTok(w.tokens)+' tok · '+fmtDur(w.durationMs)+' · '+(w.edits||0)+' edit'+(w.edits===1?'':'s')+'</span></div>';
      if(w.description&&w.name&&w.description!==w.name) h+='<div class="mt-wsub">'+esc(w.name)+'</div>';
      if(ps) h+='<div class="mt-wphs">'+ps+'</div>';
      if(open){ var ags=w.agents||[], pg=(w.phaseGroups||[]), placed={};
        for(var g=0;g<pg.length;g++){ var title=pg[g].title;
          h+='<div class="mt-wphg">'+esc(title)+' <span class="mt-wpn">'+pg[g].done+'/'+pg[g].total+'</span></div>';
          for(var kk=0;kk<ags.length;kk++){ if(ags[kk].phase===title){ placed[kk]=1; h+=wagRow(ags[kk]); } }
        }
        var rest=''; for(var k2=0;k2<ags.length;k2++){ if(!placed[k2]) rest+=wagRow(ags[k2]); }
        if(rest){ if(pg.length) h+='<div class="mt-wphg">other</div>'; h+=rest; }
      }
      h+='</div>';
    }
    host.innerHTML=h; wireFilterBar(host);
    var cars=host.querySelectorAll('.mt-wcar');
    for(var r=0;r<cars.length;r++) cars[r].addEventListener('click', function(ev){ ev.stopPropagation(); var id=this.getAttribute('data-car'); WF_OPEN[id]=(WF_OPEN[id]===false); renderWorkflows(); });
    var wrows=host.querySelectorAll('.mt-wrow');
    // Clicking the workflow selects it (→ change-map on the right) AND expands its per-agent list (→ left),
    // so the agents are discoverable without hunting for the ▸ caret. The caret still toggles collapse.
    for(var q=0;q<wrows.length;q++) wrows[q].addEventListener('click', function(){ var id=this.getAttribute('data-wf'); if(id){ SEL={kind:'workflow', id:id}; WF_OPEN[id]=true; setFeed('workflow', id, this.getAttribute('data-name')||''); paint(); } });
  }

  // Tasks and Processes are read for the ACTIVE session ONLY: multitask --json / processes --json only
  // answer for the session this window is capturing, never for whichever sibling worktree the fleet row
  // selected. Selecting a sibling re-points the change map and the feed but NOT these two — so both panes
  // say so, rather than presenting one session's plan and shells under another session's selection.
  function offSession(){ var s=selAgentSess(); return (s && SELF_KEY && s!==SELF_KEY) ? s : null; }

  // --- the ask filter, applied identically by every pane --------------------------------------------
  // While an ask is picked, a row is shown only when THAT ask started it (core's START-time rule). Two
  // rules keep this honest: without a slice to filter BY (an older CLI), nothing is filtered — a panel
  // that quietly showed everything under a scope banner would be lying; and a pane whose rows all drop
  // says so, because an empty list under a filter must never read as "there are none".
  function reqFilter(list, key, idOf){ var r=prSlice();
    if(!r) return { rows:list, hidden:0, scoped:false };
    var ids=r[key]||[], out=[];
    for(var i=0;i<list.length;i++) if(has(ids, idOf(list[i]))) out.push(list[i]);
    return { rows:out, hidden:list.length-out.length, scoped:true };
  }
  function reqNote(f, one, many){ if(!f.scoped || !f.hidden) return '';
    var r=prSlice(); if(!r) return '';
    return '<div class="mt-scope" title="Filtered to prompt #'+r.index+' — ‘'+esc(r.text||r.title)+'’. Work belongs to the prompt that STARTED it; clear the scope in the bar above to see the rest.">'+
      f.hidden+' '+esc(f.hidden===1?one:many)+' hidden — not started by prompt #'+r.index+'</div>'; }
  function scopeNote(what){ var s=offSession(); if(!s) return '';
    return '<div class="mt-scope" title="'+esc(what)+' are only read for the session this window is capturing. The fleet selection ('+esc(s)+') re-points the change map and the feed, not this tab.">'+
      esc(what)+' are this window’s session — not the selected agent '+esc(String(s).slice(0,8))+'</div>'; }

  // --- Tasks: the session's numbered task list (TaskCreate/TaskUpdate), live from the task dir ------
  var TASKS_OPEN=false; // the "N done · show all" collapse — same dismiss pattern the fleet uses
  function renderTasks(){ var host=paneHost('tasks'); if(!host) return;
    var ts=(MT&&MT.tasks)||[];
    // The prompt scope does not filter tasks (a prompt's slice carries no task-id set); the scope
    // note below still says the list is session-wide while an ask is picked.
    // A picked ask filters the fleet, the runs and the shells — but NOT this list, because a prompt
    // slice carries no task-id set. reqNote() only speaks when rows were dropped, so the disclosure is
    // written here: silence would read as "these are the ask's tasks".
    var rqT=prSlice();
    var tNote=rqT?('<div class="mt-scope" title="A prompt names no tasks, so this list is never narrowed to one. Everything else on this panel is.">the task list is session-wide — a prompt names no tasks</div>'):'';
    // The list is never prompt-filtered, so an empty one always means the same thing: no plan was made.
    if(!ts.length){ host.innerHTML=scopeNote('Tasks')+tNote+
      '<div class="mt-none">No tasks — this session plans with a task list only when Claude creates one.</div>'; return; }
    // Join each row to its STRICT rollup (rollupByTask, keyed by the row's content-hash taskId) for
    // live per-task edit counts.
    var chBy={}; var chs=(CM&&CM.rollupByTask)||[]; for(var c=0;c<chs.length;c++) if(chs[c].taskId!=null) chBy[chs[c].taskId]=chs[c];
    function trow(t){
      var st=t.status==='completed'?'done':(t.status==='in_progress'?'wip':'open');
      var glyph=st==='done'?'●':(st==='wip'?'◐':'○');
      var ch=t.taskId?chBy[t.taskId]:null;
      var counts=(ch&&ch.edits>0)?('<span class="mt-tct"><span class="mt-add">+'+ch.added+'</span> <span class="mt-rem">−'+ch.removed+'</span> · '+ch.edits+' edit'+(ch.edits===1?'':'s')+(ch.pending?' · '+ch.pending+'⧗':'')+'</span>'):'';
      var dep=(t.blockedBy&&t.blockedBy.length)?'<span class="mt-tdep" title="blocked by #'+esc(t.blockedBy.join(', #'))+'">⛓ '+t.blockedBy.length+'</span>':'';
      // A task's feed is the main chain's calls inside its real in_progress window, keyed by the
      // STRICT content-hash taskId.
      var fid=t.taskId||'';
      var fsel=(fid&&FEED&&FEED.kind==='task'&&FEED.id===String(fid));
      // Accept / Reject / Clear act on the task's STRICT span — exactly the edits counted on this row.
      // Reject and Clear appear only while there is something to act on, so no chip can be a no-op.
      var ops=(fid&&ch&&ch.edits>0)?('<span class="mt-tops">'+
        (ch.pending?'<button class="mt-top keep" data-tkeep="'+esc(fid)+'" title="Accept — keep the '+ch.pending+' pending edit(s) captured while this task was in progress">✓</button>':'')+
        (ch.pending?'<button class="mt-top undo" data-tundo="'+esc(fid)+'" title="Reject — revert those '+ch.pending+' pending edit(s) on disk">✗</button>':'')+
        ((ch.kept||ch.undone)?'<button class="mt-top" data-tclear="'+esc(fid)+'" title="Clear — drop the resolved edits of this task from the log (files on disk are unchanged)">🧹</button>':'')+
        '</span>'):'';
      return '<div class="mt-trow '+st+(fsel?' sel':'')+'"'+(fid?' data-feed="'+esc(fid)+'"':'')+' title="'+esc(t.description||t.subject)+'">'+
        '<span class="mt-tg">'+glyph+'</span><span class="mt-tid">#'+esc(t.id)+'</span>'+
        '<span class="mt-ts">'+esc(t.subject)+'</span>'+counts+dep+
        (st==='wip'&&t.activeForm?'<span class="mt-taf">'+esc(t.activeForm)+'…</span>':'')+ops+
        '</div>';
    }
    var act=[], done=[];
    for(var i=0;i<ts.length;i++) (ts[i].status==='completed'?done:act).push(ts[i]);
    var h=scopeNote('Tasks')+tNote+'<div class="mt-chead">'+ts.length+' task'+(ts.length===1?'':'s')+' · '+done.length+' done</div>';
    for(var a2=0;a2<act.length;a2++) h+=trow(act[a2]);
    // Active-only hides completed entirely (fleet semantics); otherwise they collapse behind a toggle.
    // Active only hid a plan that is finished, not absent: say which, or the count header sits over an
    // empty list. (Mirrors the JetBrains empty text.)
    if(ACTIVE_ONLY && !act.length && done.length)
      h+='<div class="mt-none">Every task is finished — Active only is hiding '+done.length+' completed task'+(done.length===1?'':'s')+'.</div>';
    if(!ACTIVE_ONLY && done.length){
      h+='<button class="mt-ttog">'+done.length+' done · '+(TASKS_OPEN?'hide':'show all')+'</button>'+
        '<button class="mt-ttog mt-tclrall" title="Clear the resolved edits of every settled task — files on disk are unchanged">clear resolved in completed tasks</button>';
      if(TASKS_OPEN) for(var d2=0;d2<done.length;d2++) h+=trow(done[d2]);
    }
    host.innerHTML=h;
    var tog=host.querySelector('.mt-ttog');
    if(tog) tog.addEventListener('click', function(){ TASKS_OPEN=!TASKS_OPEN; renderTasks(); });
    var tclr=host.querySelector('.mt-tclrall');
    if(tclr) tclr.addEventListener('click', function(){ vscode.postMessage({type:'clearCompletedTasks'}); });
    var trs=host.querySelectorAll('.mt-trow[data-feed]');
    for(var r2=0;r2<trs.length;r2++) trs[r2].addEventListener('click', function(){ setFeed('task', this.getAttribute('data-feed'), this.querySelector('.mt-ts').textContent); renderTasks(); });
    // The chips act on the task, not on the row: stop the click before it re-points the feed.
    var tops=[['data-tkeep','taskKeep'],['data-tundo','taskUndo'],['data-tclear','taskClear']];
    for(var o=0;o<tops.length;o++){ (function(attr,msg){
      var bs=host.querySelectorAll('['+attr+']');
      for(var b=0;b<bs.length;b++) bs[b].addEventListener('click', function(ev){
        ev.stopPropagation(); vscode.postMessage({type:msg, taskId:this.getAttribute(attr)}); });
    })(tops[o][0],tops[o][1]); }
  }

  // --- the prompt SCOPE: one ask picked in the Prompts window filters this whole panel -------------
  // Rendered as a bar above the nav panes, naming the ask IN FULL (wrapped — a clipped question is
  // unrecognisable) with what it produced. Everything below it is filtered to that ask's own work; the
  // bar is also the way out. The ask is picked in the neighbouring window, so this never owns the
  // selection — it only reports and clears it.
  // Apply (or drop) the ask scope. Called by the host when the neighbouring Prompts window's selection
  // changes. There is no banner to repaint: the Prompts window owns the visible selection.
  function setPromptScope(id){ PR_ID = id || null; paint(); }

  // --- Processes: the background shells this session launched with run_in_background ------------------
  // There is deliberately NO pid column: the transcript never records an OS pid, and inferring one from
  // local processes would be wrong the moment the agent runs over SSH or inside a devcontainer. The
  // harness's shell id IS the identity — it is what the agent itself uses to read or kill the shell.
  function fmtBytes(n){ n=n||0; if(n<1024) return n+' B'; if(n<1048576) return (n/1024).toFixed(n<10240?1:0)+' KB'; return (n/1048576).toFixed(1)+' MB'; }
  function procState(p){ if(p.running) return {txt:'running', col:PAL.done};
    if(p.exitCode==null) return {txt:p.status||'ended', col:PAL.idle};
    return p.exitCode===0 ? {txt:'exit 0', col:PAL.idle} : {txt:'exit '+p.exitCode, col:PAL.warn}; }
  // --- Sessions: this workspace's sessions, newest conversation first — clicking SWITCHES the review --
  var SESS=null;
  // Switching sessions costs a round trip through the host and several CLI builds. Until the new payload
  // lands, everything on this panel belongs to the session you just LEFT, so it is cleared rather than
  // left standing: showing one session's edits under another session's name is worse than showing none.
  function switchTo(id){
    var rows=(SESS&&SESS.sessions)||[];
    var row=null; for(var i=0;i<rows.length;i++) if(String(rows[i].id)===String(id)) row=rows[i];
    SELF_KEY=id||null; PINNED=id||'';
    setSessLabel(id, row&&row.title);
    CM=null; MT=null; PR=null; SEL=null; PR_ID=null; FEED=null; ROWS=[];
    renderSessions(); renderNavTabs(); applyPanes(); renderFleet(); renderWorkflows(); renderTasks(); renderProcesses();
    var empty=document.getElementById('ov-empty');
    if(empty){ empty.style.display='block';
      empty.innerHTML='Reading '+esc((row&&row.title)||(id? 'session '+String(id).slice(0,8) : 'the newest session'))+'…'; }
    document.getElementById('cm-strip').innerHTML=''; document.getElementById('cm-ledger').innerHTML='';
    document.getElementById('cm-summary').innerHTML=''; document.getElementById('cm-readout').innerHTML='';
    vscode.postMessage({type:'switchToSession', id:id});
  }

  // The session under review, named on the bar. Read-only: the Sessions tab is where it changes.
  // Version chip state + renderer — TOP-LEVEL, beside the other renderers: the message listener that
  // feeds VERINFO is a sibling of the wiring IIFE, so anything scoped inside it is unreachable here.
  var VERINFO=null;
  (function(){ var b=document.getElementById('ov-options'); if(b) b.addEventListener('click', function(){ vscode.postMessage({type:'openSettings'}); }); })();
  function renderVersion(){ var chip=document.getElementById('ov-version'); var menu=document.getElementById('ov-vermenu'); if(!chip||!menu) return; var v=VERINFO||{};
    chip.innerHTML='v'+esc(v.current||'—')+' <i class="codicon codicon-chevron-down"></i>';
    chip.classList.toggle('upd', !!v.updateAvailable);
    chip.title=(v.updateAvailable?'Update available — ':'')+'OAK version — update, or switch between the stable and pre-release channels';
    var chLatest=v.channel==='dev'?(v.devLatest||v.stableLatest):v.stableLatest;
    var h='';
    // WHAT IS INSTALLED, per surface — the chip's own number is only the extension, while "Update
    // now" moves the extension, the CLI and the JetBrains plugin. Showing one number for three
    // things is what made the dropdown disagree with reality; so does showing the RUNNING build
    // after an install has already landed, which is why 'pending reload' is its own state.
    if(v.surfaces&&v.surfaces.length){ h+='<div class="vm-sec"></div>';
      for(var si=0;si<v.surfaces.length;si++){ var sf=v.surfaces[si];
        h+='<div class="vm-note vm-surf"><span>'+esc(sf.label)+'</span><span class="vm-ver">'+(sf.version?'v'+esc(sf.version):'—')+
           (sf.reason&&sf.reason!=='current'?' · '+esc(sf.reason):'')+'</span></div>'; }
      h+='<div class="vm-sec"></div>'; }
    // ALWAYS present (user call 2026-07-28): a menu whose main action appears only sometimes reads
    // as broken. Clicking while current is a safe no-op — the host shows the up-to-date toast with
    // no reload offer — and doubles as a manual re-check. "up to date" is only claimed when the
    // release feed was actually consulted; with no data (offline, first paint) the slot shows '—'.
    h+='<button class="vm-row" data-va="update"><i class="codicon codicon-cloud-download"></i> Update now<span class="vm-ver">'+(v.updateAvailable&&chLatest?'v'+esc(chLatest):(chLatest?'up to date':'—'))+'</span></button><div class="vm-sec"></div>';
    h+='<button class="vm-row" data-va="stable"'+(v.channel!=='dev'?' disabled':'')+'><i class="codicon codicon-check" style="visibility:'+(v.channel!=='dev'?'visible':'hidden')+'"></i> Stable<span class="vm-ver">'+(v.stableLatest?'v'+esc(v.stableLatest):'—')+'</span></button>';
    h+='<button class="vm-row" data-va="dev"'+(v.channel==='dev'?' disabled':'')+'><i class="codicon codicon-check" style="visibility:'+(v.channel==='dev'?'visible':'hidden')+'"></i> Pre-release<span class="vm-ver">'+(v.devLatest?'v'+esc(v.devLatest):'none yet')+'</span></button>';
    if(v.offline) h+='<div class="vm-note">release info unavailable — offline?</div>';
    menu.innerHTML=h;
    var rows=menu.querySelectorAll('.vm-row');
    for(var i=0;i<rows.length;i++){ rows[i].addEventListener('click', function(){ if(this.hasAttribute('disabled')) return; var a=this.getAttribute('data-va'); menu.hidden=true;
      if(a==='update') vscode.postMessage({type:'versionUpdate'});
      else vscode.postMessage({type:'switchChannel', channel:a}); }); }
  }
  function setSessLabel(s, title){ var el=document.getElementById('ov-sess-label'); if(!el) return;
    var nm=(title||'').trim();
    el.textContent='🔬 '+(nm || ('session '+(s? String(s).slice(0,8) : '—')));
    el.title=(nm? nm+' — ' : '')+'session '+(s||'—')+' · switch in the Sessions tab'; }

  function renderSessions(){ var host=paneHost('sessions'); if(!host) return;
    var rows=(SESS&&SESS.sessions)||[];
    var under=SELF_KEY||'', seen=false;
    // The one thing a list of sessions cannot say by itself: follow whichever session is newest, rather
    // than any particular one. Without it, pinning would be a one-way door.
    var auto='<div class="mt-trow'+(PINNED?'':' sel')+'" data-sess-auto="1" title="Follow this workspace’s newest session automatically, instead of staying on one you picked">'+
      '<span class="mt-tg">'+(PINNED?'○':'●')+'</span><span class="mt-ts">Auto — newest session in this workspace</span>'+
      '<span class="mt-tct">'+(PINNED?'':'following')+'</span></div>';
    // Pinned to a session the listing has no row for. The listing spans every workspace on this
    // machine, so that means deleted, empty, or a mirrored copy. Said BEFORE the early return: an empty
    // listing under a pinned session is exactly when the reader most needs to know what the panels are
    // showing them.
    var elsewhere=(under&&SESS)?'<div class="mt-scope" title="The session under review is not in this machine’s session list — the panels are showing it anyway. Pick a row to review a listed session instead.">reviewing '+esc(String(under).slice(0,8))+' — not in this machine’s session list (deleted, empty, or a copy mirrored from another machine)</div>':'';
    if(!rows.length){ host.__sessHtml=null; host.innerHTML=(SESS?elsewhere+auto:'')+'<div class="mt-none">'+(SESS?'No sessions on this machine yet.':'Reading sessions…')+'</div>'; return; }
    var h=auto, now=Date.now(), WEEK=7*86400000;
    var groups=[];
    rows.forEach(function(r){ var label=r.workspace||'Unknown workspace';
      var group=groups.find(function(g){return g.label===label;});
      if(!group){group={label:label,rows:[]};groups.push(group);} group.rows.push(r); });
    for(var gi=0;gi<groups.length;gi++){
      var group=groups[gi];
      h+='<div class="mt-foldhdr mt-workspace" style="cursor:default">'+esc(group.label)+' · '+group.rows.length+(group.rows.length===1?' session':' sessions')+'</div>';
      var recent=[], older=[], hidden=0;
      for(var q=0;q<group.rows.length;q++){var rw=group.rows[q];
        var kept=String(rw.id)===String(under)||rw.current||rw.pending||(rw.attention&&rw.attention.kind!=='idle-done');
        if(ACTIVE_ONLY&&!kept&&now-(rw.liveMs||rw.lastActiveMs)>60000){hidden++;continue;}
        if(String(rw.id)===String(under)||rw.current||(rw.attention&&rw.attention.kind!=='idle-done')||now-rw.lastActiveMs<=WEEK) recent.push(rw);
        else older.push(rw);
      }
      var rows0=recent.concat(older);
    // Two different facts, two different marks: the DOT says which session is live (the one still being
    // written), the HIGHLIGHT says which one you are reviewing. They are usually the same row and
    // sometimes not — conflating them told you the wrong thing exactly when it mattered.
    for(var i=0;i<rows0.length;i++){ var r=rows0[i];
      if(older.length && i===recent.length){
        h+='<div class="mt-foldhdr" data-oldsess="1" title="Sessions last active more than a week ago.">'+
          (SHOW_OLDSESS?'▾ ':'▸ ')+older.length+' older sessions</div>';
        if(!SHOW_OLDSESS) break;
      }
      var name=r.title||('session '+String(r.id).slice(0,8));
      var mine=(String(r.id)===String(under)); if(mine) seen=true;
      // The same badge set a FLEET row carries (0.9.0), in the same order and the same classes: what it
      // changed, what it cost, and what it ran on. A session that changed nothing shows no diff rather
      // than +0 −0 — but still shows its tokens, because asking and reading is work the row should own.
      var diff=(r.added||r.removed)
        ? '<span class="mt-diff"><span class="mt-add">+'+(r.added||0)+'</span> <span class="mt-rem">−'+(r.removed||0)+'</span></span>' : '';
      // No "Ne · Nf" (edits · files): the ± lines beside it already say how much this session changed,
      // and two more bare counts in the same row read as noise rather than as information.
      var bits=[];
      if(r.pending) bits.push('<span class="mt-pend">'+r.pending+' pending</span>');
      else if(r.edits) bits.push('<span class="mt-done">✓</span>');
      bits.push((r.edits||0)+(r.edits===1?' edit':' edits'));
      bits.push(fmtTok(r.tokens||0)+' tok');
      bits.push(fmtDur(r.durationMs||0));
      // The store's on-disk footprint, clickable: the same fact the session
      // pickers carry, missing only from this panel — and the click opens the folder, everywhere.
      if(r.storeBytes) bits.push('<span class="mt-store" data-store="'+esc(String(r.id))+'" title="This session’s store on disk — every edit’s before/after blobs and the review log. Click to open the folder.">'+fmtBytes(r.storeBytes)+'</span>');
      var meta=bits.length? '<span class="mt-meta">'+bits.join(' · ')+'</span>' : '';
      var chip=r.effort? '<span class="mt-schip">'+esc(r.effort)+' effort</span>' : '';
      // WHO ran it: Claude stays the unmarked default; any other agent is
      // named on the row — with the model chip beside it, agent + model read at a glance.
      var agentTag=(r.agent&&r.agent!=='claude')
        ? '<span class="mt-agentbadge" title="The agent that ran this session">'+esc(r.agent)+'</span>' : '';
      // The model chip, beside the agent — the one selector that lacked it.
      var modelTag='<span class="mt-agentbadge">'+esc(r.model||'model unknown')+'</span>';
      h+='<div class="mt-trow'+(mine?' sel':'')+'" data-sess-switch="'+esc(r.id)+'" title="'+esc((r.title||r.id)+' — session '+r.id+' · '+(r.workspace||'Unknown workspace')+(r.current?' · live':'')+(mine?' · the session you are reviewing':' · click to review it'))+'">'+
        '<span class="mt-tg">'+(r.attention&&r.attention.kind!=='idle-done'?'⚠':r.current?'●':'○')+'</span>'+
        '<span class="mt-ts">'+esc(name)+'</span>'+agentTag+modelTag+
        (r.attention&&r.attention.kind!=='idle-done'?'<span class="mt-pend">'+esc(r.attention.kind+(r.attention.message?' · '+r.attention.message:''))+'</span>':'')+
        diff+meta+chip+
        '<span class="mt-tct">'+esc(ago(r.lastActiveMs))+(mine?' · reviewing':'')+'</span>'+
        '<button class="mt-resolve" data-conversation="'+esc(r.id)+'" title="Read this conversation">conversation</button>'+ 
        // Resolve: accept what is left and stop carrying the history. Only offered where there IS
        // something to resolve, so the row never advertises a no-op.
        (r.pending? '<button class="mt-resolve" data-resolve="'+esc(r.id)+'" data-name="'+esc(name)+'" data-pending="'+r.pending+'" title="Resolve this session — accept its '+r.pending+' pending edit(s), then clear its records. Files on disk are NOT changed.">resolve</button>' : '')+
        // Delete: drop a cluttering session straight from the list — offered on every
        // row (like the row-switch), the id validated host-side. The 🗑 emoji, not a webview codicon: the
        // trash glyph is outside the whitelisted subset and would render a silent blank in a webview.
        '<button class="mt-resolve mt-del" data-sess-del="'+esc(r.id)+'" title="Delete this conversation from OAK — removes it from every session picker and purges its captured edits for good. The transcript itself is not deleted; oak sessions --undelete '+esc(r.id)+' lists it again, without its edits">🗑</button>'+
        '</div>'; }
      if(hidden) h+='<div class="mt-scope">'+hidden+' hidden by Active only</div>';
    }
    // Pinned to a session the listing has no row for: say so rather than leaving every row
    // unhighlighted with no explanation.
    if(under && !seen) h=elsewhere+h;
    // Every overview payload re-renders this list, once per refresh tick. Unchanged markup is left in
    // place: rebuilding it between a click's press and its release swallowed the click.
    if(host.__sessHtml===h) return;
    host.__sessHtml=h;
    host.innerHTML=h;
    var bs=host.querySelectorAll('[data-sess-switch]');
    for(var b=0;b<bs.length;b++) bs[b].addEventListener('click', function(){ switchTo(this.getAttribute('data-sess-switch')); });
    var sst=host.querySelectorAll('[data-store]');
    for(var s2=0;s2<sst.length;s2++) sst[s2].addEventListener('click', function(ev){ ev.stopPropagation(); vscode.postMessage({type:'openStore', id:this.getAttribute('data-store')}); });
    var db=host.querySelectorAll('[data-conversation]');
    for(var d2=0;d2<db.length;d2++) db[d2].addEventListener('click', function(ev){ ev.stopPropagation(); vscode.postMessage({type:'openConversation', id:this.getAttribute('data-conversation')}); });
    // The toolbar chip beside Export mirrors the reviewed session's store size.
    var szEl=document.getElementById('ov-store-size');
    if(szEl){ var cur=null; for(var c2=0;c2<rows.length;c2++){ if(String(rows[c2].id)===String(under)||(!under&&rows[c2].current)){ cur=rows[c2]; break; } }
      szEl.textContent = cur&&cur.storeBytes ? fmtBytes(cur.storeBytes) : ''; }
    var ab=host.querySelector('[data-sess-auto]');
    if(ab) ab.addEventListener('click', function(){ switchTo(''); });
    var rb=host.querySelectorAll('[data-resolve]');
    for(var rq=0;rq<rb.length;rq++) rb[rq].addEventListener('click', function(ev){ ev.stopPropagation();
      vscode.postMessage({type:'resolveSession', session:this.getAttribute('data-resolve'), name:this.getAttribute('data-name'), pending:this.getAttribute('data-pending')}); });
    var sd=host.querySelectorAll('[data-sess-del]');
    for(var sq=0;sq<sd.length;sq++) sd[sq].addEventListener('click', function(ev){ ev.stopPropagation();
      vscode.postMessage({type:'deleteSession', id:this.getAttribute('data-sess-del')}); });
    var oh=host.querySelectorAll('[data-oldsess]');
    for(var oi=0;oi<oh.length;oi++) oh[oi].addEventListener('click', function(){ SHOW_OLDSESS=!SHOW_OLDSESS; renderSessions(); renderNavTabs(); });
  }

  function renderProcesses(){ var host=paneHost('processes'); if(!host) return;
    // Three genuinely different states, which must not share one sentence: nothing has been read yet ·
    // the CLI answered nothing · this session truly started no background shell. Only the last one is an
    // observation about the session; saying it in the other two would assert something never observed.
    if(!PR){ host.innerHTML=scopeNote('Background shells')+'<div class="mt-none">'+(OV_SEEN
        ? 'No answer for background shells — the <b>oak</b> CLI on PATH didn’t return them (a CLI older than 0.8.7 has no <code>processes</code> command). Nothing else on this panel is affected.'
        : 'Reading this session’s background shells…')+'</div>'; return; }
    var all=PR.processes||[], sum=PR.summary||{total:all.length,running:0,failed:0};
    if(!all.length){ host.innerHTML=scopeNote('Background shells')+'<div class="mt-none">No background shells — Claude starts one only when it runs a command with <code>run_in_background</code>.</div>'; return; }
    // Under an ask scope: the shells that ask launched. A shell it started but which is still running now
    // stays its own — attribution is by START, so a long-lived shell doesn't migrate to a later ask.
    var pF=reqFilter(all, 'processIds', function(p){ return p.id; });
    var pNote=reqNote(pF, 'shell', 'shells'); all=pF.rows;
    if(!all.length){ host.innerHTML=scopeNote('Background shells')+pNote+'<div class="mt-none">Prompt #'+(prSlice()||{}).index+' launched no background shell.</div>'; return; }
    // Active only (the shared toggle) hides shells that have EXITED — exactly as it hides finished agents
    // and runs — so the pane shows only what is still going. How many it dropped is remembered, so an
    // emptied list reads as a consequence of the filter, never as "this session ran none".
    var exitedHidden=0;
    if(ACTIVE_ONLY){ var running=[]; for(var af=0;af<all.length;af++){ if(all[af].running) running.push(all[af]); else exitedHidden++; } all=running; }
    if(!all.length && ACTIVE_ONLY){ host.innerHTML=scopeNote('Background shells')+pNote+'<div class="mt-none">No running shells'+(exitedHidden?(' — clear <b>Active only</b> to see the '+exitedHidden+' that '+(exitedHidden===1?'has':'have')+' exited'):'')+'.</div>'; return; }
    // Folded by "Clear completed" — dismissed, never deleted, and the header says how many are hidden
    // so a shrunken list never reads as "these never happened".
    var ps=[], folded=0;
    for(var f=0;f<all.length;f++){ if(DISMISS_PR[all[f].id]) folded++; else ps.push(all[f]); }
    var h=scopeNote('Background shells')+pNote+'<div class="mt-chead">'+(pF.scoped?(all.length+' from this ask'):(sum.running+' running · '+sum.total+' total'+(sum.failed?' · '+sum.failed+' failed':'')))+(folded?' · <span class="mt-folded" title="Cleared from this list — click the Processes tab header to bring them back">'+folded+' cleared</span>':'')+'</div>';
    if(!ps.length){ host.innerHTML=h+'<div class="mt-none">Every shell has been cleared from this list — click the <b>Processes</b> tab header to bring them back.</div>'; return; }
    for(var i=0;i<ps.length;i++){ var p=ps[i], st=procState(p);
      var sel=(FEED&&FEED.kind==='process'&&FEED.id===p.id);
      h+='<div class="mt-proc'+(sel?' sel':'')+'" data-proc="'+esc(p.id)+'" title="'+esc(p.command)+'">'+
        '<div class="mt-arow">'+
        '<span class="mt-badge sm" style="background:'+st.col+'">'+esc(st.txt)+'</span>'+
        '<span class="mt-pid">'+esc(p.id)+'</span>'+
        '<span class="mt-meta" style="margin-left:auto">'+fmtDur(p.runtimeMs)+(p.outputBytes?' · '+fmtBytes(p.outputBytes)+' out':'')+'</span>'+
        '</div>'+
        '<div class="mt-pcmd">'+esc(p.description||p.command)+'</div>'+
        '</div>';
    }
    host.innerHTML=h;
    var rows=host.querySelectorAll('.mt-proc');
    for(var r=0;r<rows.length;r++) rows[r].addEventListener('click', function(){ setFeed('process', this.getAttribute('data-proc'), ''); renderProcesses(); });
  }

  // --- the feed SUBJECT: which row's activity the Timeline's Feed tab follows ------------------------
  // The feed itself renders THERE now (0.10.0 — it used to be a pane under the change map here). This
  // panel only NAMES the subject: FEED keeps the picked ref so the row highlights below still work,
  // and the post hands it to the host, whose activate() wiring re-points and reveals the Feed tab.
  var FEED=null;
  function setFeed(kind, id, label){
    if(FEED && FEED.kind===kind && FEED.id===id) return;
    FEED={kind:kind, id:String(id==null?'':id), label:label||''};
    vscode.postMessage({type:'feed', kind:FEED.kind, id:FEED.id, label:FEED.label});
  }
  function ago(ts){ if(!ts) return '—'; var d=new Date(ts), n=new Date(); function p2(x){ return (x<10?'0':'')+x; }
    var MN=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if(d.getFullYear()===n.getFullYear() && d.getMonth()===n.getMonth() && d.getDate()===n.getDate()) return p2(d.getHours())+':'+p2(d.getMinutes())+':'+p2(d.getSeconds());
    if(d.getFullYear()===n.getFullYear()) return MN[d.getMonth()]+' '+d.getDate()+' '+p2(d.getHours())+':'+p2(d.getMinutes());
    return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate()); }

  // --- nav sub-tabs (Fleet · Workflows · Tasks · Processes) -----------------------------------------
  // Prompts is NOT among them any more (0.8.7): it is the window to the left, so the list of asks and
  // what one of them filtered stay visible at the same time.
  // The tab badges count what the tab WILL SHOW. Under an ask scope that is the filtered set — a tab
  // reading "Workflows 10" that opens onto "this ask started none" contradicts itself, and the badge is
  // what a reader trusts without opening the tab.
  // Shown/total, because this pane deliberately hides rows: the last day plus whatever the reader
  // expanded. "34" over a list of 3 is the same lie the Fleet badge told.
  function sessionsBadge(){
    var rows=(SESS&&SESS.sessions)||[], now=Date.now(), under=SELF_KEY||'', shown=0;
    for(var i=0;i<rows.length;i++){ var r=rows[i];
      var kept=String(r.id)===String(under)||r.current||r.pending||(r.attention&&r.attention.kind!=='idle-done');
      if(ACTIVE_ONLY&&!kept&&now-(r.liveMs||r.lastActiveMs)>60000) continue;
      if(String(r.id)===String(under)||r.current||(r.attention&&r.attention.kind!=='idle-done')||now-r.lastActiveMs<=7*86400000||SHOW_OLDSESS) shown++;
    }
    return shown===rows.length? String(rows.length) : (shown+'/'+rows.length);
  }

  /** True when a fleet row for a session OTHER than the one under review is selected. */
  function otherAgentSelected(){
    var s=selAgentSess(); if(!s) return false;
    var viewing=SELF_KEY? String(SELF_KEY) : selfSession();
    return String(s)!==String(viewing);
  }
  function navCounts(){
    var ag=(MT&&MT.agents)||[], wf=(MT&&MT.workflows)||[], ts=(MT&&MT.tasks)||[], r=prSlice();
    // The badge counts the rows the pane will actually RENDER — after Active-only and the fold — not
    // every session ever recorded here. "1/31" read as "1 of 31 agents in this session"; the 31 is every
    // session in this repo's history, of which one was live and 24 were finished over a week ago. A
    // count that needs that paragraph to be understood is the wrong count to put on a tab.
    // Exactly what renderFleet draws: the shared filter, MINUS the rows sitting inside a collapsed
    // fold. The fold is applied in the renderer rather than in multitaskFilter (which both editors
    // share and which has no folded clause), so the badge has to subtract it the same way. (No backticks
    // in this region: it is inside the webview template literal, which they would close.)
    var visRows=(MTFILTER&&MT)? (MTFILTER(MT, fstate()).agents||[]) : ag;
    var visN=0;
    for(var vi=0;vi<visRows.length;vi++) if(!visRows[vi].folded || SHOW_FOLDED) visN++;
    var fleetLabel=String(visN);
    // A badge must count THE LIST ITS PANE RENDERS. The Tasks pane renders MT.tasks (every planned task
    // plus each agent run, for the session under review); the change map's per-agent tasks[] is the
    // STRICT edit-producing subset, so scoping the badge to it put "Tasks 0" over a pane listing 13.
    // (No backticks in this region: it is inside the webview template literal, which they would close.)
    // With a sibling selected the panes still show the reviewed session — its tasks, workflows and
    // shells are not in this payload — so those badges say nothing rather than describe another session.
    if(otherAgentSelected()) return { fleet:fleetLabel, workflows:'', tasks:'' };
    if(!r) return { fleet:fleetLabel, workflows:wf.length, tasks:ts.length };
    var fleet=0;
    for(var i=0;i<ag.length;i++) if(!SELF_KEY || ag[i].session===SELF_KEY) fleet++;
    var runs=0; for(var j=0;j<wf.length;j++) if(has(r.workflowIds, wf[j].id)) runs++;
    // The Tasks pane is NOT prompt-filtered (a prompt slice carries no task-id set), so its badge must
    // keep counting the whole list — a 0 over a pane listing every task is worse than no badge at all.
    return { fleet:fleet, workflows:runs, tasks:ts.length };
  }
  // --- grouped nav (P6): five tabs, or two tabs of side-by-side members ------------------------------
  // NAV always names a MEMBER, in both modes: the tour, the badges, the detail selection and applyPanes
  // all speak member keys, and resolveTab is the only place that knows a member is currently reachable
  // through a group tab. Membership is fixed — these are the pairs the panel already reads together.
  var GROUP_BUILT=null; // 'on' once the grouped columns exist in the DOM; null while solo tabs are shown
  // ONE group (group ALL the tabs together, never two groups) — every
  // member side by side; folding columns is how a reader narrows it.
  var NAV_GROUPS=[['all','Sessions · Workers · Workflows · Tasks · Processes',['sessions','fleet','workflows','tasks','processes']]];
  function groupOf(member){ for(var i=0;i<NAV_GROUPS.length;i++) if(NAV_GROUPS[i][2].indexOf(member)>=0) return NAV_GROUPS[i]; return null; }
  function groupById(id){ for(var i=0;i<NAV_GROUPS.length;i++) if(NAV_GROUPS[i][0]===id) return NAV_GROUPS[i]; return null; }
  // --- the grouped columns: widths the reader drags, and columns they can fold ----------------------
  /** This group's per-column weights, defaulted to an equal share. Re-seeded only when the group's SHAPE
   *  changes (a member added or removed), never when a payload arrives. */
  function colWeights(gr){ var w=COLW[gr[0]];
    if(!Array.isArray(w) || w.length!==gr[2].length){ w=[]; for(var i=0;i<gr[2].length;i++) w.push(1); COLW[gr[0]]=w; }
    return w; }
  function colOpen(k){ return !COLC[k]; }
  function openCols(gr){ var n=0; for(var i=0;i<gr[2].length;i++) if(colOpen(gr[2][i])) n++; return n; }
  /**
   * Fold a column to its rail, or bring it back.
   *
   * The LAST expanded column in a group never folds: a group with every column folded is an empty pane,
   * and the affordance to undo it would be the very rail the reader just lost track of. The button is
   * not rendered in that case either — this guard is the second line, for a click that raced a repaint.
   *
   * The column's WEIGHT is deliberately untouched, so expanding restores the width the reader set rather
   * than an equal share; while it is folded the rail is sized by CSS and the siblings divide the rest.
   */
  function toggleCol(k){
    var gr=groupOf(k); if(!gr) return;
    if(colOpen(k) && openCols(gr)<=1) return;
    if(colOpen(k)) COLC[k]=1; else delete COLC[k];
    GROUP_BUILT=null; saveState(); paint(); // the rail and the column are different markup, so rebuild
  }
  /** Write each expanded column's share as its flex-grow weight. A rail is sized by CSS and exempt from
   *  both this and the minimum width — it is not showing content to clip. */
  function applyColWidths(){
    for(var g=0;g<NAV_GROUPS.length;g++){ var gr=NAV_GROUPS[g], w=colWeights(gr);
      for(var i=0;i<gr[2].length;i++){ var el=document.getElementById('ov-gc-'+gr[2][i]);
        if(el&&el.style&&el.style.setProperty) el.style.setProperty('--ov-cw', String(w[i])); } } }
  /** Wire one group's dividers and fold buttons. Called once per column build, like the columns themselves. */
  function wireGroupCols(gr){
    var ks=gr[2];
    for(var m=0;m<ks.length;m++) (function(m){
      var k=ks[m];
      var fold=document.getElementById('ov-cc-'+k);
      if(fold) fold.addEventListener('click', function(ev){ if(ev&&ev.stopPropagation) ev.stopPropagation(); toggleCol(k); });
      var gut=document.getElementById('ov-cg-'+k);
      if(!gut) return;
      // The pair this divider sizes is (nearest EXPANDED column to the left, this one) — a rail between
      // them is skipped rather than dragged, and with nothing expanded to its left there is no pair.
      var p=-1; for(var q=m-1;q>=0;q--) if(colOpen(ks[q])){ p=q; break; }
      if(p<0) return;
      var a=document.getElementById('ov-gc-'+ks[p]), b=document.getElementById('ov-gc-'+k);
      if(!a||!b) return;
      function setFrom(ev){
        var ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
        var span=(rb.right-ra.left)||1;
        var w=colWeights(gr), sum=w[p]+w[m];
        // The 150px floor, expressed as a fraction of THIS pair. Capped at .45 so a pair too narrow to
        // hold two floors still leaves a usable range instead of an impossible clamp (below 640px the
        // whole group stacks anyway, and the dividers are hidden there).
        var floor=Math.min(0.45, COL_MIN/span);
        var frac=(ev.clientX-ra.left)/span;
        if(!isFinite(frac)) return;
        frac=Math.max(floor, Math.min(1-floor, frac));
        w[p]=sum*frac; w[m]=sum*(1-frac);
        applyColWidths();
      }
      gut.addEventListener('pointerdown', function(ev){
        if(ev&&ev.preventDefault) ev.preventDefault();
        gut.classList.add('drag');
        try{ gut.setPointerCapture(ev.pointerId); }catch(e){}
        function move(e2){ setFrom(e2); }
        function up(){
          gut.classList.remove('drag');
          try{ gut.releasePointerCapture(ev.pointerId); }catch(e){}
          gut.removeEventListener('pointermove', move); gut.removeEventListener('pointerup', up); gut.removeEventListener('pointercancel', up);
          saveState();
        }
        gut.addEventListener('pointermove', move); gut.addEventListener('pointerup', up); gut.addEventListener('pointercancel', up);
      });
      gut.addEventListener('dblclick', function(){
        var w=colWeights(gr), s=w[p]+w[m]; w[p]=s/2; w[m]=s/2; applyColWidths(); saveState(); });
    })(m);
  }
  /** The tab key that is actually clickable for a member right now — itself, or the group holding it. */
  function resolveTab(key){ if(!GROUPNAV) return key; var g=groupOf(key); return 'g:'+(g? g[0] : NAV_GROUPS[0][0]); }
  function applyPanes(){ var ids=['sessions','fleet','workflows','tasks','processes'];
    var cur=resolveTab(NAV);
    for(var i=0;i<ids.length;i++){ var el=document.getElementById('ov-pane-'+ids[i]); if(el) el.style.display=(!GROUPNAV && NAV===ids[i])?'flex':'none'; }
    for(var g=0;g<NAV_GROUPS.length;g++){ var ge=document.getElementById('ov-group-'+NAV_GROUPS[g][0]);
      if(ge) ge.style.display=(GROUPNAV && cur===('g:'+NAV_GROUPS[g][0]))?'flex':'none'; } }
  // Guided tour: which DOM node each anchor name points at. Anything not listed here is unknown to this
  // build and simply does not ring — never an error, so core can name a control this build lacks.
  var TOUR_ANCHORS = { 'nav-tabs':'#ov-navtabs', 'folders-strip':'#cm-strip', 'files-ledger':'#cm-ledger',
    'summary-bar':'#cm-summary', 'nav-axes':'#ov-axesrow', 'accept-prompt':'#ov-acceptprompt',
    'session-label':'#ov-sess-label', 'spotlight':'#ov-spotlight' };
  function applyTour(tab, anchor){
    // Remember where the reader was BEFORE the first step moved them, so the tour hands the Overview back
    // on the tab they had rather than wherever its last overview step happened to stop.
    if(tab && tab!==NAV){ if(TOUR_NAV===null) TOUR_NAV=NAV; NAV=tab; renderNavTabs(); applyPanes(); }
    var prev=document.querySelectorAll('.ov-ring');
    for(var i=0;i<prev.length;i++) prev[i].classList.remove('ov-ring');
    var sel = anchor ? TOUR_ANCHORS[anchor] : null;
    var el = sel ? document.querySelector(sel) : null;
    if(el){ el.classList.add('ov-ring'); if(el.scrollIntoView) el.scrollIntoView({block:'nearest'}); }
  }
  function renderNavTabs(){ var c=navCounts();
    var defs=[
      // Sessions leads: which session you are reviewing is the question that precedes every other one.
      ['sessions','Sessions', SESS&&SESS.sessions? sessionsBadge() : '',
        'Sessions on this machine, grouped by workspace. Selecting one switches the whole review to it.', false],
      ['fleet','Workers',String(c.fleet),'Workers — the sessions this pane is showing; pick one to map just its edits. A WORKER is a session doing work, not a live process, and the badge counts the rows this pane draws under the current filter — so it never implies that every session ever recorded here is running.',false],
      ['workflows','Workflows',String(c.workflows),'Workflows — multi-agent runs (orchestrator + subagents) with their phases and attributed edits',false],
      ['tasks','Tasks',String(c.tasks),'Tasks — the REVIEWED session’s numbered task list (the agent’s TaskCreate/TaskUpdate plan), with live statuses. A sibling agent’s tasks are not in this payload, so while one is selected this pane still shows the reviewed session and the badge shows no count rather than another session’s.',false]];
    // The Processes tab is always present: a tab that silently vanishes when the CLI can't answer hides
    // the failure instead of reporting it (the pane itself says which of the three states it is in). The
    // badge is running/total — tinted while a shell is still going, so a live shell is visible from here
    // without opening the pane — and stays blank when there is no payload to count.
    var psum=(PR&&PR.summary)||null, rsl=prSlice();
    // …and the same for shells: while scoped the badge counts the ones THIS ask launched.
    if(psum && rsl){ var ps=(PR.processes||[]), tot=0, run=0;
      for(var p2=0;p2<ps.length;p2++) if(has(rsl.processIds, ps[p2].id)){ tot++; if(ps[p2].running) run++; }
      psum={ running:run, total:tot, failed:0 }; }
    // Shells are read for the session under review only, and the payload carries none per sibling. With
    // another agent selected the honest badge is NO badge: showing the reviewed session's count beside a
    // pane the reader believes is scoped to their selection is the one thing worse than showing nothing.
    var otherAgent=otherAgentSelected(); // one definition of "a sibling is selected", shared with navCounts
    defs.push(['processes','Processes', otherAgent? '' : (psum? (psum.running+'/'+psum.total) : ''),
      otherAgent
        ? 'Processes — background shells are read for the session under review, never for a selected sibling agent, so no count is shown while one is selected. Open that session from the Sessions tab to see its shells.'
        : 'Processes — background shells the ACTIVE session launched with run_in_background: state, runtime and output volume (shell ids are the harness’s own; a transcript records no OS pid).',
      !otherAgent && !!(psum && psum.running>0)]);
    var cur=resolveTab(NAV);
    var h='';
    if(GROUPNAV){
      // Two tabs. The badge is the members' own badges in member order — the column headers repeat them
      // beside the names, so the tab needs only to carry the counts while the group is closed.
      for(var gi=0;gi<NAV_GROUPS.length;gi++){ var gr=NAV_GROUPS[gi], parts=[], hot=false;
        for(var mi=0;mi<gr[2].length;mi++){ var dm=defByKey(defs, gr[2][mi]);
          if(dm && dm[2]!=='') parts.push(dm[2]); if(dm && dm[4]) hot=true; }
        h+='<button class="ov-tab'+(cur===('g:'+gr[0])?' on':'')+'" data-nav="g:'+gr[0]+'" title="'+
          esc(gr[1]+' — these lists side by side, each column with its own badge and description in its header.')+'">'+gr[1]+
          (parts.length?('<span class="ov-tn'+(hot?' hot':'')+'">'+esc(parts.join(' · '))+'</span>'):'')+'</button>'; }
    } else {
      for(var i=0;i<defs.length;i++){ var d=defs[i];
        h+='<button class="ov-tab'+(d[0]===NAV?' on':'')+'" data-nav="'+d[0]+'" title="'+esc(d[3])+'">'+d[1]+
          (d[2]!==''?('<span class="ov-tn'+(d[4]?' hot':'')+'"'+(d[4]?' title="a background shell is still running"':'')+'>'+esc(d[2])+'</span>'):'')+'</button>'; }
    }
    var host=document.getElementById('ov-navtabs'); host.innerHTML=h;
    var bs=host.querySelectorAll('.ov-tab'); for(var b=0;b<bs.length;b++) bs[b].addEventListener('click', function(){
      var k=this.getAttribute('data-nav');
      // A group tab resolves to its FIRST member, so NAV keeps naming a member and the detail selection,
      // the tour and the badges all keep the one vocabulary they had before grouping existed.
      if(k && k.indexOf('g:')===0){ var gr2=groupById(k.slice(2)); k=gr2? gr2[2][0] : NAV; }
      NAV=k; renderNavTabs(); applyPanes(); });
    // The columns are composed ONCE per mode, not per tick: rebuilding them would throw away the lists
    // (and the reader's scroll) that the member renderers are about to fill in this same paint.
    if(GROUPNAV){
      if(GROUP_BUILT!=='on'){ renderGroupCols(defs); GROUP_BUILT='on'; }
      // A later payload re-stamps only the badges, and then re-asserts the widths: the layout is the
      // reader's and no arriving count may reset it (the Processes badge is the standing example).
      else { paintGroupBadges(defs); applyColWidths(); }
    }
    else GROUP_BUILT=null; }

  /** Which tab definition belongs to a member key. */
  function defByKey(defs, k){ for(var i=0;i<defs.length;i++) if(defs[i][0]===k) return defs[i]; return null; }
  /** Build each group pane's columns: one per member, each a header (name · badge) over that member's own
   *  list node. The list ids are ov-g-<member>, which paneHost resolves to — so the member's single
   *  renderer fills this column with no knowledge that grouping exists. */
  function renderGroupCols(defs){
    for(var g=0;g<NAV_GROUPS.length;g++){ var gr=NAV_GROUPS[g], host=document.getElementById('ov-group-'+gr[0]);
      if(!host) continue;
      var h='', nOpen=openCols(gr), seenOpen=false;
      for(var m=0;m<gr[2].length;m++){ var k=gr[2][m], d=defByKey(defs,k), nm=d?d[1]:k;
        if(!colOpen(k)){
          // The rail: still NAMES the column and carries its badge, and the whole thing is the button
          // that brings it back at the width the reader had set.
          h+='<div class="ov-groupcol rail" id="ov-gc-'+k+'">'+
            '<button class="ov-rail" id="ov-cc-'+k+'" title="'+esc(nm+' — folded. Click to bring it back at the width you set.')+'">'+
            '<i class="codicon codicon-chevron-right"></i><span class="ov-railname">'+esc(nm)+'</span>'+
            '<span class="ov-tn" id="ov-gb-'+k+'"></span></button></div>';
          continue;
        }
        h+='<div class="ov-groupcol" id="ov-gc-'+k+'">'+
          // A divider only where there is an expanded column to its left to size against.
          (seenOpen? '<div class="ov-cgutter" id="ov-cg-'+k+'" title="Drag to resize these columns — double-click to split them evenly"></div>' : '')+
          '<div class="ov-ghead" title="'+esc(d?d[3]:'')+'">'+esc(nm)+
          '<span class="ov-tn" id="ov-gb-'+k+'"></span>'+
          // Never offered on the last expanded column: folding it would leave an empty pane.
          (nOpen>1? '<button class="ov-cfold" id="ov-cc-'+k+'" title="Fold '+esc(nm)+' to a rail — the other columns take the space, and it comes back at the width you set"><i class="codicon codicon-chevron-left"></i></button>' : '')+
          '</div>'+
          '<div class="ov-list" id="ov-g-'+k+'"></div></div>';
        seenOpen=true;
      }
      host.innerHTML=h;
      wireGroupCols(gr);
    }
    applyColWidths();
    paintGroupBadges(defs);
  }
  /** Re-stamp the column badges on the panel's tick (the counts move; the columns do not). */
  function paintGroupBadges(defs){
    for(var i=0;i<defs.length;i++){ var d=defs[i], el=document.getElementById('ov-gb-'+d[0]);
      if(!el) continue;
      el.textContent=d[2];
      el.className='ov-tn'+(d[4]?' hot':'');
      el.title=d[4]? 'a background shell is still running' : '';
    }
  }

  function paint(){
    var empty=document.getElementById('ov-empty');
    if(MT && MT.agents){ empty.style.display='none'; renderNavTabs(); applyPanes(); renderFleet(); renderWorkflows(); renderTasks(); }
    else {
      renderNavTabs(); applyPanes();
      if(CLI_ERR){ empty.style.display='block'; empty.innerHTML=CLI_ERR_HTML; }
      else if(!CM){ empty.style.display='block'; empty.innerHTML='No agents yet. <span style="opacity:.75">This fills in as the agent works across your worktrees.</span>';
        clearNavLists(['fleet','workflows','tasks']); }
      else empty.style.display='none';
    }
    syncToggles(); // the filter's controls state the setting, whatever has or hasn't been fetched
    // Sessions rides its OWN payload, not the fleet's: a workspace whose agents have all exited still
    // has sessions to review, and gating this on the fleet payload left the tab on "Reading sessions…".
    renderSessions();
    // Processes is independent of the fleet payload; it paints in every state (including "no answer"),
    // so it always says what it knows rather than sitting on stale markup.
    renderProcesses();
    ensureSel();
    paintDetail();
  }

  // Paint the nav-bar Diff/File position counters from the host-pushed NAVPOS (live step-through position).
  function renderNavPos(){ var p=NAVPOS||{};
    var d=document.getElementById('ov-diffcount'); if(d) d.textContent='Diff '+(p.diff? (p.diff.i+'/'+p.diff.n+(p.diff.time?' · '+p.diff.time:'')) : '–/–');
    var f=document.getElementById('ov-filecount'); if(f){ var fe=(p.file&&p.file.edits>0)?' · '+p.file.edits+' edit'+(p.file.edits===1?'':'s'):''; f.textContent='File '+(p.file? ((p.file.i||'–')+'/'+p.file.n+(p.file.name?' · '+p.file.name:'')+fe) : '–/–'); }
    var fo=document.getElementById('ov-foldercount'); if(fo){ if(p.folder){ var fon=p.folder.name||''; if(fon.length>24) fon='…'+fon.slice(-23);
        var ft=[]; if(p.folder.files>0) ft.push(p.folder.files+' file'+(p.folder.files===1?'':'s')); if(p.folder.edits>0) ft.push(p.folder.edits+' edit'+(p.folder.edits===1?'':'s'));
        var fts=(ft.length?' · '+ft.join(' · '):''); fo.textContent='Folder '+(p.folder.i||'–')+'/'+p.folder.n+(fon?' · '+fon:'')+fts; fo.title=p.folder.name||''; } else { fo.textContent='Folder –/–'; fo.title='the current file’s folder'; } }
    // Prompt axis: i/n is its place among the asks that still have something to review; #k is the ask's
    // OWN number in the whole session — the one a person counts by. Both are shown because they differ,
    // and the ask's text is the counter's tooltip (it is too long for the bar).
    var rq=document.getElementById('ov-promptcount'); if(rq){ if(p.prompt){
        var rt=[]; if(p.prompt.files>0) rt.push(p.prompt.files+' file'+(p.prompt.files===1?'':'s')); if(p.prompt.edits>0) rt.push(p.prompt.edits+' edit'+(p.prompt.edits===1?'':'s'));
        var rs=(rt.length?' · '+rt.join(' · '):'');
        rq.textContent='Prompt '+(p.prompt.i||'–')+'/'+p.prompt.n+(p.prompt.index?' · #'+p.prompt.index:'')+rs;
        rq.title=p.prompt.title||'the prompt (your own ask) that produced the current edit'; }
      else { rq.textContent='Prompt –/–'; rq.title='the prompt (your own ask) that produced the current edit'; } }
    renderSummary(); // the bottom summary tracks the scope — refresh it as the axis moves
  }

  window.addEventListener('message', function(ev){ var m=ev.data||{};
    // This host is not the one driving (the Overview is in an editor tab). It will never receive a
    // payload, so say so rather than sit on a loading message that will never resolve.
    if(m.type==='elsewhere'){
      // An OVERLAY, never innerHTML on .ov-wrap. Replacing the wrap deletes the DOM every render
      // function draws into, so when this host takes the wheel back its payload arrives and each
      // renderer bails on the missing node: the panel stays stuck on a message about a tab the reader
      // already closed, recoverable only by re-resolving the view. The overlay lifts instead.
      var ovl=document.getElementById('ov-elsewhere');
      if(!ovl){ ovl=document.createElement('div'); ovl.id='ov-elsewhere';
        ovl.setAttribute('style','position:fixed;inset:0;z-index:50;padding:14px;overflow:auto;background:var(--vscode-sideBar-background,var(--vscode-editor-background))');
        document.body.appendChild(ovl); }
      ovl.innerHTML='<div class="mt-none">The Overview is open in an editor tab, which is driving it.'+
        '<br><br>Close that tab to bring the Overview back here, or set <b>claudeObservatory.overviewLocation</b> to <b>panel</b>.</div>';
      return;
    }
    if(m.type==='version'){ VERINFO=m.v||null; renderVersion(); return; }
    if(m.type==='sessions'){ SESS=m.sessions||null; renderNavTabs(); renderSessions(); return; }
    if(m.type==='overview'){ var oe=document.getElementById('ov-elsewhere'); if(oe&&oe.parentNode) oe.parentNode.removeChild(oe); CLI_ERR=false; PINNED=m.pinned||''; setSessLabel(m.session, m.sessionTitle); CM=m.cm||null; MT=m.mt||null; PR=m.pr||null; SESS=m.sessions||SESS; OV_SEEN=true; NAVPOS=m.navPos||null; FILTER=m.filter||''; if(m.filterSpec) FSPEC=m.filterSpec; if(m.sort) SORT=m.sort;
      // Reset dismissals only when the actual session changes — key on the stable host-provided session id,
      // NOT selfSession() (which falls back to agents[0].session and flips whenever the fleet re-sorts,
      // wiping the user's "clear completed" on every refresh).
      // The selection has to move WITH the session: the fleet lists every sibling session in the repo, so
      // the previous pick still resolves against CM.agents and ensureSel() would keep painting the old
      // session's detail.
      var k=m.session||SELF_KEY; if(k!==SELF_KEY){ SELF_KEY=k; DISMISS_AG={}; DISMISS_WF={}; DISMISS_PR={}; SEEN_WF=null;
        // The picked prompt belonged to the old session's conversation — it goes with it.
        // (The host drops it too, on the same signal, so the Prompts window agrees.)
        SEL = k ? {kind:'agent', session:k} : null; PR_ID=null;
        // The followed feed belonged to the old session too — drop it, and tell the host to stop fetching it.
        if(FEED){ FEED=null; vscode.postMessage({type:'feed'}); } }
      // The host owns the ask selection (the Prompts window sets it), so every payload carries it — that
      // way a panel that was hidden when the pick happened comes back already scoped. Applied AFTER the
      // session-change branch above, which clears the scope: a fresh webview starts with SELF_KEY null,
      // so its FIRST payload always takes that branch and would otherwise discard the scope the host
      // sent with it. On a real session change the host drops the ask too, so nothing stale survives.
      if(m.prompt!==undefined){ PR_ID=m.prompt||null; }
      // Auto-focus a NEW workflow run: the first payload only SEEDS the seen-set (opening the panel never
      // steals focus); after that, a newly-appeared RUNNING run switches the nav to Workflows, selects it,
      // and pulses its row — the detail then tracks the run's agents/phases/edits live via the watchers.
      var wfs=(MT&&MT.workflows)||[];
      if(SEEN_WF===null){ SEEN_WF={}; for(var sw=0;sw<wfs.length;sw++) SEEN_WF[wfs[sw].id]=1; }
      else { var freshWf=null;
        for(var nw=0;nw<wfs.length;nw++){ if(!SEEN_WF[wfs[nw].id]){ SEEN_WF[wfs[nw].id]=1; if(wfs[nw].running) freshWf=wfs[nw].id; } }
        if(freshWf){ NAV='workflows'; SEL={kind:'workflow', id:freshWf}; WF_OPEN[freshWf]=true; FLASH_WF=freshWf;
          setTimeout(function(){ FLASH_WF=null; }, 3200); } }
      ensureSel(); readPal(); paint(); renderNavPos(); syncFilterUI(); }
    else if(m.type==='navpos'){ NAVPOS=m.pos||null; renderNavPos(); }
    // (No 'feed' intake any more: feed payloads go to the Timeline webview, which renders them.)
    // The host answered — with a failure. OV_SEEN flips so the Processes pane stops saying "reading…" and
    // starts saying the CLI returned nothing, which is what actually happened.
    // The Prompts window's selection, relayed by the host the moment it changes (the payload above
    // carries it too, but that only arrives on the next refresh tick — this is what makes a click feel
    // like a click).
    else if(m.type==='prompt'){ setPromptScope(m.id||null); }
    // Guided tour (0.8.9): select the tab the step is about, show its tip beside the panel it is
    // describing, and ring the named control. An anchor this build does not know simply does not ring —
    // the step still reads, which is what lets core add a step an older editor has never heard of.
    else if(m.type==='tour'){ applyTour(m.tab||null, m.anchor||null); }
    // The guided tour asks for every row to be visible while it runs, then hands the filter back exactly
    // as it found it (TOUR_FILTER remembers the reader's own value, not a default).
    else if(m.type==='showall'){
      if(m.on){ if(TOUR_FILTER===null){ TOUR_FILTER=ACTIVE_ONLY; ACTIVE_ONLY=false; saveState(); paint(); } }
      else {
        if(TOUR_NAV!==null){ NAV=TOUR_NAV; TOUR_NAV=null; renderNavTabs(); applyPanes(); }
        if(TOUR_FILTER!==null){ ACTIVE_ONLY=TOUR_FILTER; TOUR_FILTER=null; saveState(); paint(); }
      }
    }
    else if(m.type==='error'){ CLI_ERR=true; CM=null; MT=null; PR=null; OV_SEEN=true; FEED=null; SESS=m.sessions||null; renderNavTabs(); applyPanes(); renderProcesses(); renderSessions();
      var em=document.getElementById('ov-empty'); em.style.display='block';
      em.innerHTML=CLI_ERR_HTML;
      clearNavLists(['fleet','workflows']);
      document.getElementById('cm-strip').innerHTML=''; document.getElementById('cm-ledger').innerHTML=''; document.getElementById('cm-detail-empty').style.display='none'; document.getElementById('cm-readout').innerHTML='';
      document.getElementById('cm-cap-folders').style.display='none'; document.getElementById('cm-cap-files').style.display='none'; document.getElementById('cm-summary').innerHTML=''; }
  });

  (function wireControls(){
    var cb=document.getElementById('mt-active'); if(cb) cb.addEventListener('change', function(){ ACTIVE_ONLY=!!cb.checked; saveState(); paint(); });
    var aotg=document.getElementById('ov-activeonly'); if(aotg) aotg.addEventListener('click', function(){ ACTIVE_ONLY=!ACTIVE_ONLY; saveState(); paint(); });
    // Grouping changes the SHAPE of the nav, so the columns are dropped and the split re-applied for the
    // mode being entered before the repaint rebuilds them.
    var gntg=document.getElementById('ov-groupnav'); if(gntg) gntg.addEventListener('click', function(){
      GROUPNAV=!GROUPNAV; GROUP_BUILT=null; saveState(); applySplit(); paint(); });
    var btn=document.getElementById('mt-clear'); if(btn) btn.addEventListener('click', function(){ clearCompleted(); });
    // top-navbar review actions — each posts to the host, which runs the matching command (zero-token).
    function tbtn(id, type){ var b=document.getElementById(id); if(b) b.addEventListener('click', function(){ vscode.postMessage({type:type}); }); }
    // Bulk actions scope to the SELECTED prompt (Prompts window) if there is one, else act session-wide —
    // the scoped path reuses the id-scoped ops, which resolve the edit set in core (destructive-safe).
    // The order matches relabelBulk's, so the button always does what its label says.
    // Scope is exactly one of two things: the selected PROMPT, else the selected SESSION. The session
    // used to be implicit — the host resolved "the reviewed session" — so picking a sibling agent in
    // Fleet left these acting on a different session than the one named beside them.
    function bulk(id, sess, pr){ var b=document.getElementById(id); if(b) b.addEventListener('click', function(){
      if(PR_ID) vscode.postMessage({type:pr, promptId:PR_ID});
      else vscode.postMessage({type:sess, session:selAgentSess()||''}); }); }
    tbtn('ov-refresh','refresh'); // the session is chosen in the Sessions tab, not from a dropdown
    bulk('ov-keepall','keepAll','promptKeep'); bulk('ov-undoall','undoAll','promptUndo'); bulk('ov-clearres','clearResolved','promptClear');
    // the step-through review nav bar — posts to the existing nav commands the status-bar nav bar drives.
    tbtn('ov-fileprev','navFilePrev'); tbtn('ov-filenext','navFileNext');
    tbtn('ov-diffprev','navDiffPrev'); tbtn('ov-diffnext','navDiffNext');
    // Prompt axis — review affordances scoped to one of the user's own asks.
    tbtn('ov-promptprev','navPromptPrev'); tbtn('ov-promptnext','navPromptNext');
    tbtn('ov-reviewprompt','reviewCurrentPrompt');
    tbtn('ov-acceptprompt','acceptCurrentPrompt'); tbtn('ov-rejectprompt','rejectCurrentPrompt');
    tbtn('ov-rewindprompt','rewindCurrentPrompt');
    tbtn('ov-navkeep','navKeep'); tbtn('ov-navundo','navUndo');
    tbtn('ov-chatedit','chatCurrentEdit'); tbtn('ov-viewdiff','viewCurrentDiff');
    tbtn('ov-acceptfile','keepOpenFile'); tbtn('ov-rejectfile','undoOpenFile');
    tbtn('ov-folderprev','navFolderPrev'); tbtn('ov-foldernext','navFolderNext');
    tbtn('ov-acceptfolder','acceptCurrentFolder'); tbtn('ov-rejectfolder','rejectCurrentFolder');
    tbtn('ov-export','exportMenu'); tbtn('ov-store','openStore');
    tbtn('ov-spotlight','toggleHeatmap');
    // Search is an inline field and Filter an inline dropdown now (not the palette pop-ups) — wired here.
    wireFilterUI();
    // Reset scope clears the webview-local narrowings NOW (MOD is this script's own state; PR_ID
    // comes back cleared in the next payload) and asks the host to drop the rest.
    (function(){ var b=document.getElementById('ov-resetscope'); if(b) b.onclick=function(){ MOD=null; vscode.postMessage({type:'resetScope'}); }; })();
    // Version chip (pinned right) — wiring only; VERINFO/renderVersion live at the SCRIPT top level,
    // because the message listener that feeds them is a SIBLING of this IIFE, not a child (learned
    // the hard way: declared in here, every 'version' message threw ReferenceError under strict mode
    // and the chip stayed at v— forever).
    (function(){ var chip=document.getElementById('ov-version'); var menu=document.getElementById('ov-vermenu'); if(!chip||!menu) return;
      chip.addEventListener('click', function(e){ e.stopPropagation(); menu.hidden=!menu.hidden; if(!menu.hidden){ renderVersion(); vscode.postMessage({type:'versionMenuOpen'}); } });
      document.addEventListener('click', function(ev){ if(!menu.hidden && !menu.contains(ev.target)) menu.hidden=true; });
    })();
    relabelBulk(); renderNavPos();
  })();
  readPal();
  // Paint the Processes pane once BEFORE the first payload so it already says "reading…" rather than
  // sitting blank the moment its tab becomes reachable. Deliberately not a full paint(): the other tabs
  // would then show counts of 0, which asserts "there are none" before anything has been read.
  renderProcesses();
  // …and the Active-only controls, which state a SETTING rather than a payload. Until this ran, they
  // rendered OFF while the filter was ON, and a click in that window silently persisted the opposite
  // of what the reader asked for.
  syncToggles();
  vscode.postMessage({type:'ready'});
})();
`;

// --- marketplace-free update nudge -------------------------------------------------------------
// VS Code has no custom-repository / self-hosted auto-update mechanism (JetBrains does — this plugin
// ships an updatePlugins.xml repo). The closest equivalent is a throttled background check of GitHub
// Releases that points the user at the new .vsix. It never silent-installs and never nags on error.
const RELEASE_REPO = 'cell-observatory/oak-observatory';
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // at most once a day in the background

/** How this install got here — read once at activation from the editor's OWN install registry
 *  (`extensions.json` beside the extensions dir). 'gallery' = a marketplace manages its
 *  updates; 'vsix' = sideloaded. Our updater's installs are vsix installs too, and the editor pins
 *  them — so a single dev-channel takeover flips the registry entry to 'vsix' and the stand-down
 *  guard permanently gets out of the way. Any read/parse/shape miss → 'unknown', which behaves
 *  exactly like 'vsix' (the pre-marketplace status quo). */
let INSTALL_SOURCE: 'gallery' | 'vsix' | 'unknown' = 'unknown';
/** The pure classifier (exported for tests): read `<extensionsDir>/extensions.json` and report how the
 *  extension at `basename` (id `id`, version `version`) got installed. Any read/parse/shape miss →
 *  'unknown', which behaves exactly like 'vsix' (the pre-marketplace status quo). */
export function classifyInstallSource(extensionsDir: string, basename: string, id: string, version: string): 'gallery' | 'vsix' | 'unknown' {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(extensionsDir, 'extensions.json'), 'utf8'));
    if (!Array.isArray(list)) return 'unknown';
    const ours =
      list.find((e: any) => String(e?.relativeLocation ?? '') === basename) ??
      list.find(
        (e: any) => String(e?.identifier?.id ?? '').toLowerCase() === id.toLowerCase() && e?.version === version
      );
    const src = String(ours?.metadata?.source ?? '');
    return src === 'gallery' ? 'gallery' : src === 'vsix' ? 'vsix' : 'unknown';
  } catch {
    return 'unknown';
  }
}
function readInstallSource(context: vscode.ExtensionContext): 'gallery' | 'vsix' | 'unknown' {
  const extDir = context.extensionPath;
  if (!extDir) return 'unknown';
  return classifyInstallSource(path.dirname(extDir), path.basename(extDir), EXTENSION_ID, extensionVersion);
}
/** True when a marketplace owns THIS install's updates on the followed channel. The gallery serves
 *  stable builds only, so the guard stands down exactly there; the dev channel is a GitHub-only,
 *  explicitly chosen stream where the built-in updater still acts (with a word of warning). */
function marketplaceManaged(channel?: core.UpdateChannel): boolean {
  return INSTALL_SOURCE === 'gallery' && (channel ?? core.getUpdateChannel()) !== 'dev';
}

/** GET the latest-release JSON from GitHub. Rejects on any network/HTTP/parse error (no deps — the
 *  extension host is Node). GitHub requires a User-Agent. */
/** The releases LIST (newest first) — one fetch answers both channels; `fetchLatestRelease` picks
 *  the FOLLOWED channel's newest from it (stable = what `releases/latest` serves; dev = the rolling
 *  pre-release), so the daily notifier and the Update flow track whatever channel the user switched
 *  to — the same resolution the CLI performs (core.resolveReleaseFromList, the shared backend). */
function fetchReleaseList(): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=100`,
      { headers: { 'User-Agent': 'oak-observatory-vscode', Accept: 'application/vnd.github+json' } },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          return reject(new Error(`github api ${res.statusCode}`));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            const list = JSON.parse(body);
            resolve(Array.isArray(list) ? list : []);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
  });
}

async function fetchLatestRelease(channel?: core.UpdateChannel): Promise<any> {
  const release = core.resolveReleaseFromList(await fetchReleaseList(), channel ?? core.getUpdateChannel());
  if (!release) throw new Error('no published release found');
  return release;
}

/** Run the CLI once, resolving to its stdout — or to an Error. Windows: the CLI is an npm `.cmd`
 *  shim, which needs cmd.exe; core/spawn handles that, and the quoting, for every CLI spawn here. */
function runCli(args: string[], timeoutMs = 300000): Promise<string> {
  return new Promise((resolve, reject) => {
    core.execFileTool(resolveObservatoryBin(), args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      // core.cliFailureMessage, not `stderr || stdout`: that ordering is what put a Node deprecation
      // warning in this toast instead of the reason (#45).
      if (err) reject(new Error(core.cliFailureMessage(stdout, stderr, err.message)));
      else resolve(String(stdout || ''));
    });
  });
}

/** The CLI's own view of the world, network-free: its version and the channel it follows. Null when
 *  the CLI cannot be found or run — which is a normal state (the extension installs fine on its own)
 *  and must be reported as "not found", never as a failed update. */
async function cliVersionInfo(): Promise<{ current: string; channel: core.UpdateChannel } | null> {
  try {
    // Seconds, not the install timeout: this runs while a webview waits to paint, and it does no
    // network at all — anything slower than this is a wedged process, not a slow answer.
    const out = await runCli(['version', '--json'], 10000);
    const j = JSON.parse(out);
    return { current: String(j?.current ?? ''), channel: j?.channel === 'dev' ? 'dev' : 'stable' };
  } catch {
    return null;
  }
}

/** Ask the CLI for the whole update plan as data. `--json` never installs anything, so this is safe
 *  to call from a chip render. Null = the CLI is absent or the release feed was unreachable. */
async function fetchUpdatePlan(channel?: core.UpdateChannel): Promise<any | null> {
  try {
    // One release-feed fetch, so a minute is generous; the 5-minute install budget is not for a read.
    return JSON.parse(await runCli(channel ? ['update', '--json', '--channel', channel] : ['update', '--json'], 60000));
  } catch {
    return null;
  }
}

/**
 * Apply an update, or switch channels — the ONE path behind both buttons.
 *
 * The .vsix is installed BY THIS EXTENSION, through VS Code's own extension service, and never by
 * shelling `code --install-extension`. That distinction is the whole bug: the notifier's installer
 * needs nothing on PATH (see installVsixUpdate), while the CLI's needs the editor's shell command,
 * which a Dock-launched editor frequently does not have — so the button people actually press was
 * the one that failed.
 *
 * The CLI is still asked to refresh ITSELF and the JetBrains plugin. Its absence is a PARTIAL
 * result, reported as such, not a failure: an extension-only install is a supported way to run this.
 *
 * Success is never inferred from the CLI's prose. We install what we install, and read the plan back
 * to see what actually moved.
 */
async function applyUpdate(target: core.UpdateChannel | null): Promise<void> {
  const switching = target !== null && target !== core.getUpdateChannel();
  const label = target === 'dev' ? 'Pre-release' : 'Stable';
  const title = switching
    ? `OAK: switching to the ${label} channel…`
    : 'OAK: updating…';
  const done: string[] = [];
  const skipped: string[] = []; // could not be done, and the user may be able to fix it
  const notes: string[] = []; // deliberately not done — a supported setup, not a failure
  let extensionMoved = false;

  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, async () => {
    const plan = await fetchUpdatePlan(target ?? undefined);
    // 1. This extension, in-process — unless a marketplace owns this install on the target channel:
    //    the editor's gallery updates it there, and two updaters acting on one install
    //    ping-pong versions. The CLI + JetBrains legs below run either way.
    if (marketplaceManaged(target ?? undefined)) {
      notes.push('extension is marketplace-managed — your editor updates it in the Extensions view');
    } else {
      // The plan tells us the target; if the CLI could not produce one we fall back to our own
      // release lookup, so a missing CLI never blocks our own update.
      let release: any = null;
      try {
        release = await fetchLatestRelease(target ?? undefined);
      } catch {
        /* offline — reported below */
      }
      const latest = core.versionOfRelease(release) ?? '';
      if (!latest) {
        skipped.push('could not reach the release feed');
      } else if (core.compareVersions(latest, extensionVersion) !== 0 || switching) {
        const vsix = core.assetFor((release.assets || []) as { name?: string }[], 'vscode') as any;
        if (!vsix) skipped.push(`release ${latest} has no .vsix asset`);
        else {
          try {
            await installVsix(vsix.browser_download_url, latest, vsix.digest);
            done.push(`extension → ${latest}`);
            extensionMoved = true;
          } catch (e) {
            skipped.push(`extension: ${String((e as Error)?.message || e)}`);
          }
        }
      } else {
        done.push(`extension already ${extensionVersion}`);
      }
    }

    // 2. Persist the channel ourselves. The CLI used to own this and wrote it BEFORE installing, so
    //    a blocked install left the config naming one channel and the binaries from the other.
    if (switching && target) {
      try {
        core.setUpdateChannel(target);
      } catch (e) {
        skipped.push(String((e as Error)?.message || e));
      }
    }

    // 3. The CLI and the JetBrains plugin, via the CLI. `--force` is unnecessary: the CLI now acts on
    //    any DIFFERENCE from the channel, in either direction.
    //
    //    A machine with no CLI is a SUPPORTED setup, not a failed update — the extension installs and
    //    updates itself. So "not installed" is a note; only a CLI that exists and then FAILED is a
    //    problem worth a warning.
    //
    //    Whether the CLI EXISTS is asked network-free (`version --json`), never inferred from the
    //    plan: `update --json` also fails when the release feed is unreachable, so keying off it
    //    reported "CLI not found" to people whose CLI was installed and whose network was not.
    const cli = await cliVersionInfo();
    if (!cli) {
      notes.push('CLI not found — the extension updated on its own');
    } else if (plan === null || (plan.surfaces || []).some((s: any) => s.surface !== 'vscode' && s.reason !== 'current')) {
      // plan === null: the CLI is there but could not tell us the plan. Run it anyway and let it
      // report its own reason, rather than skipping on a guess.
      try {
        await runCli(target ? ['update', '--channel', target] : ['update']);
        done.push('CLI and JetBrains plugin refreshed');
      } catch (e) {
        skipped.push(`CLI: ${String((e as Error)?.message || e)}`);
      }
    } else {
      done.push('CLI and JetBrains plugin already current');
    }
    versionInfoCache = null; // the chip must re-learn the world after an install
  });

  // What MOVED, per surface — never one verdict for three things. A reload is offered exactly when
  // this extension's own bits changed, which is the only case a reload is what fixes.
  const headline = switching ? `Switched to the ${label} channel.` : 'OAK update:';
  const detail = [done.join('; '), notes.join('; '), skipped.length ? `not done — ${skipped.join('; ')}` : '']
    .filter(Boolean)
    .join(' · ');
  if (extensionMoved) {
    const pick = await vscode.window.showInformationMessage(`${headline} ${detail}`, 'Reload Window');
    if (pick === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow');
  } else if (skipped.length) {
    vscode.window.showWarningMessage(`${headline} ${detail}`);
  } else {
    vscode.window.showInformationMessage(`${headline} ${detail}`);
  }
}

/** The version chip's payload: the running extension's own version, the followed channel, and both
 *  channels' newest tags (1h in-memory cache — the chip renders instantly, the menu stays honest). */
let versionInfoCache: { at: number; stableLatest: string | null; devLatest: string | null } | null = null;
let extensionVersion = ''; // set once in activate() from the extension's own manifest
/**
 * A newer build is ON DISK but this extension host is still running the old one.
 *
 * `extensionVersion` comes from `context.extension.packageJSON` at activation and can never change
 * for the life of the host — so after an install the chip kept reporting the pre-update number with
 * nothing to say that the update had, in fact, worked. That read as "the dropdown shows a different
 * version to what's installed". The chip now says "installed, pending reload" instead of lying.
 */
let pendingReloadVersion: string | null = null;
/** `publisher.name` for this extension, read from the host at activation. Used to scope VS Code's
 *  settings UI — `@ext:` with a wrong id filters to nothing and reads as a dead button, so it is
 *  never spelled out by hand. Empty under the smoke-test mock, which has no `context.extension`. */
let EXTENSION_ID = '';

async function versionChipInfo(): Promise<{
  current: string;
  channel: core.UpdateChannel;
  stableLatest: string | null;
  devLatest: string | null;
  updateAvailable: boolean;
  offline?: boolean;
  pendingReload?: string | null;
  surfaces?: { label: string; version: string | null; reason: string }[];
}> {
  const current = extensionVersion;
  const channel = core.getUpdateChannel();
  // No own version (the smoke-test mock, or a mangled install) → nothing to compare against, so no
  // fetch either: the chip renders v— and stays inert, and tests never touch the network.
  if (!current) return { current, channel, stableLatest: null, devLatest: null, updateAvailable: false, offline: true };
  let cached = versionInfoCache;
  if (!cached || Date.now() - cached.at > 60 * 60 * 1000) {
    try {
      const list = await fetchReleaseList();
      // resolveReleaseFromList for BOTH rows, not a raw `.find(prerelease)` for the dev one. The two
      // disagree right after a promote — when the freshly-tagged stable outranks the rolling build
      // and IS what the dev channel serves — so the menu advertised a pre-release that "Update now"
      // would not have installed. Null when dev degraded to stable, so the row can say "none yet".
      const dev = core.resolveReleaseFromList(list, 'dev');
      cached = {
        at: Date.now(),
        stableLatest: core.versionOfRelease(core.resolveReleaseFromList(list, 'stable')),
        devLatest: dev && (dev as any).prerelease === true ? core.versionOfRelease(dev) : null,
      };
      versionInfoCache = cached;
    } catch {
      // Offline / rate-limited is NOT "up to date". Both used to render identically, so a user behind
      // a 403 saw a confident green chip. `offline` is its own state and the menu says so.
      if (!cached) return { current, channel, stableLatest: null, devLatest: null, updateAvailable: false, offline: true };
    }
  }
  const latest = channel === 'dev' ? cached.devLatest ?? cached.stableLatest : cached.stableLatest;
  // EVERY surface the update touches, each with its own installed version — because "Update now"
  // updates three things and the chip used to show the number for exactly one of them. The CLI's is
  // network-free (`version --json`); a missing CLI is reported as missing, not as a failure.
  const surfaces: { label: string; version: string | null; reason: string }[] = [
    {
      label: 'Extension',
      version: pendingReloadVersion ?? current,
      reason: pendingReloadVersion
        ? 'pending reload'
        : marketplaceManaged(channel)
          ? 'marketplace-managed' // the gallery updates it — excluded from updateAvailable below
          : latest && core.compareVersions(latest, current) !== 0
            ? core.isNewer(latest, current)
              ? 'update available'
              : 'not on this channel'
            : 'current',
    },
  ];
  const cli = await cliVersionInfo();
  surfaces.push({
    label: 'CLI',
    version: cli?.current ?? null,
    reason: !cli
      ? 'not found'
      : latest && core.compareVersions(latest, cli.current) !== 0
        ? core.isNewer(latest, cli.current)
          ? 'update available'
          : 'not on this channel'
        : 'current',
  });
  return {
    current,
    channel,
    stableLatest: cached.stableLatest,
    devLatest: cached.devLatest,
    // Any DIFFERENCE from the channel, in either direction — an install sitting ABOVE the channel is
    // the case that silently stranded people, and it is precisely the one isNewer called "current".
    updateAvailable: surfaces.some((s) => s.reason === 'update available' || s.reason === 'not on this channel'),
    pendingReload: pendingReloadVersion,
    surfaces,
  };
}

/** Download `url` (following redirects) to `dest`. Rejects on any non-200 / network error. */
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const get = (u: string, redirs: number): void => {
      https
        .get(u, { headers: { 'User-Agent': 'oak-observatory-vscode' } }, (res) => {
          const code = res.statusCode || 0;
          if (code >= 300 && code < 400 && res.headers.location && redirs > 0) {
            res.resume();
            return get(res.headers.location, redirs - 1);
          }
          if (code !== 200) {
            res.resume();
            return reject(new Error(`http ${code}`));
          }
          const file = fs.createWriteStream(dest);
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
          file.on('error', reject);
        })
        .on('error', reject);
    };
    get(url, 5);
  });
}

/** Verify a downloaded .vsix against GitHub's per-asset sha256 `digest` before we install it — parity
 *  with the CLI's assertDigest. Throws on mismatch (the caller catches it and offers a manual download);
 *  a release that published no checksum is allowed through with a console note, same as the CLI. */
function verifyVsixDigest(file: string, digest?: string): void {
  const expected = typeof digest === 'string' && digest.startsWith('sha256:') ? digest.slice(7) : null;
  if (!expected) {
    console.warn('[oak-observatory] no published checksum for the .vsix — skipping integrity check');
    return;
  }
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (actual !== expected) throw new Error(`integrity check failed (sha256 ${actual} ≠ ${expected})`);
}

/**
 * Download the .vsix and install it through VS Code's OWN extension service. Throws on any failure.
 *
 * This is the install path that works everywhere: `workbench.extensions.installExtension` is served
 * by the running editor, so it needs nothing on PATH — no `code`, no `cursor`, no `code-insiders`.
 * It also installs in either direction, which is what makes a downgrade to the stable channel land.
 */
async function installVsix(url: string, latest: string, digest?: string): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-observatory-'));
  const dest = path.join(dir, `oak-observatory-${latest}.vsix`);
  await downloadFile(url, dest);
  verifyVsixDigest(dest, digest); // sha256 parity with the CLI — refuse a tampered .vsix
  await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(dest));
  pendingReloadVersion = latest;
  versionInfoCache = null;
}

/** The notifier's install: `installVsix` wrapped in its own progress + reload prompt. Falls back to
 *  opening the download in a browser if anything fails. */
async function installVsixUpdate(url: string, latest: string, digest?: string): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Installing OAK ${latest}…` },
      () => installVsix(url, latest, digest)
    );
    const reload = await vscode.window.showInformationMessage(
      `OAK ${latest} installed. Reload the window to activate it.`,
      'Reload Window'
    );
    if (reload === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow');
  } catch (e) {
    const pick = await vscode.window.showWarningMessage(
      `Couldn't auto-install the update (${String((e as Error)?.message || e)}). Download the .vsix instead?`,
      'Download .vsix'
    );
    if (pick === 'Download .vsix') void vscode.env.openExternal(vscode.Uri.parse(url));
  }
}

/** Compare the running extension version against the newest GitHub Release; if newer, offer to install
 *  the .vsix. `manual` = triggered from the command palette (report up-to-date / errors; ignore throttle
 *  + "skip this version"). */
async function checkForUpdate(context: vscode.ExtensionContext, manual: boolean): Promise<void> {
  // `context.extension` is only present in a real extension host (absent under the smoke-test mock) —
  // bail before any network call if we can't read our own version.
  const current = context.extension?.packageJSON?.version ? String(context.extension.packageJSON.version) : undefined;
  if (!current) {
    if (manual) vscode.window.showWarningMessage('OAK: cannot determine the installed version.');
    return;
  }
  // A gallery install on the stable channel is updated by the editor itself — this
  // updater stands down there rather than fight the gallery over one install.
  if (marketplaceManaged()) {
    if (manual)
      vscode.window.showInformationMessage(
        "OAK: this install is managed by your editor's marketplace — updates arrive in the Extensions view. Switching to the Pre-release channel hands updates to this built-in updater instead."
      );
    return;
  }
  if (!manual) {
    const last = context.globalState.get<number>('updateCheck.lastMs') || 0;
    if (Date.now() - last < UPDATE_CHECK_INTERVAL_MS) return;
  }
  let release: any;
  try {
    release = await fetchLatestRelease();
  } catch (e) {
    if (manual)
      vscode.window.showWarningMessage(
        `OAK: couldn't check for updates (${String((e as Error)?.message || e)}).`
      );
    return;
  }
  context.globalState.update('updateCheck.lastMs', Date.now());
  const latest = core.versionOfRelease(release) ?? '';
  // Follow the channel: act on any DIFFERENCE, not only on a higher number. A build sitting ABOVE
  // the channel (a local build, or a channel switched downward) is exactly what the old isNewer gate
  // reported as "up to date" — permanently, and with a green checkmark.
  const cmp = latest ? core.compareVersions(latest, current) : 0;
  if (!latest || cmp === 0) {
    if (manual) vscode.window.showInformationMessage(`OAK is up to date (${current}).`);
    return;
  }
  const stranded = cmp < 0;
  if (!manual && context.globalState.get<string>('updateCheck.skip') === latest) return; // dismissed
  const vsix = core.assetFor((release.assets || []) as { name?: string }[], 'vscode') as any;
  const downloadUrl = vsix?.browser_download_url || release.html_url;
  // One-click install goes through VS Code's own extension service (no `code` CLI needed); if the
  // release has no .vsix asset we fall back to opening the download + manual "Install from VSIX…".
  const canInstall = Boolean(vsix);
  const primary = canInstall ? (stranded ? 'Install it' : 'Update now') : 'Download .vsix';
  // Reaching here with a gallery install means the dev channel was explicitly chosen — this prompt
  // IS the one confirmation before our updater takes the install over from the marketplace.
  const galleryNote =
    INSTALL_SOURCE === 'gallery'
      ? ' (Installed from the marketplace — updating here switches it to GitHub-managed pre-release builds; reinstall from the marketplace to switch back.)'
      : '';
  const choice = await vscode.window.showInformationMessage(
    (stranded
      ? `You have OAK ${current}, which is not on the ${core.getUpdateChannel() === 'dev' ? 'Pre-release' : 'Stable'} channel (${latest}) — probably a local build. Move onto the channel?`
      : `OAK ${latest} is available (you have ${current}).`) + galleryNote,
    primary,
    'Release notes',
    'Skip this version'
  );
  if (choice === 'Update now' || choice === 'Install it') {
    await installVsixUpdate(vsix.browser_download_url, latest, vsix.digest);
  } else if (choice === 'Download .vsix') {
    vscode.env.openExternal(vscode.Uri.parse(downloadUrl));
    vscode.window.showInformationMessage(
      'After it downloads: Extensions view → ⋯ → “Install from VSIX…”, then pick the file (reload when prompted).'
    );
  } else if (choice === 'Release notes') {
    vscode.env.openExternal(vscode.Uri.parse(release.html_url));
  } else if (choice === 'Skip this version') {
    context.globalState.update('updateCheck.skip', latest);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  // The running build's own version — what the Overview's version chip shows ('' under the smoke
  // mock, which has no `context.extension`; the chip then renders v— and stays inert).
  extensionVersion = String(context.extension?.packageJSON?.version ?? '');
  EXTENSION_ID = String(context.extension?.id ?? '');
  INSTALL_SOURCE = readInstallSource(context); // after EXTENSION_ID — the fallback match keys on it
  // Renames changed the extension id twice — 0.8.6 moved the publisher (claude-observatory →
  // cell-observatory) and 0.10.0 renamed the product (claude-observatory-vscode →
  // oak-observatory-vscode) — and editors treat a pre-rename install as a SEPARATE extension, so
  // both can be installed at once, racing to register the same commands and views (the loser's
  // activate() throws). Don't fight it: BEFORE registering anything, remove every old id, ask for
  // one reload, and let whichever build owns this window keep serving it until then. Must stay
  // ahead of every registerCommand / createTreeView call. (Optional chain: the smoke-test mock has
  // no `extensions` namespace.)
  const OLD_EXT_IDS = ['claude-observatory.claude-observatory-vscode', 'cell-observatory.claude-observatory-vscode'];
  const stale = OLD_EXT_IDS.filter((id) => vscode.extensions?.getExtension?.(id));
  if (stale.length) {
    void (async () => {
      try {
        for (const id of stale) await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', id);
        const pick = await vscode.window.showInformationMessage(
          'Claude Observatory is OAK now — the old install was removed. Reload to finish.',
          'Reload Window'
        );
        if (pick === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow');
      } catch {
        void vscode.window.showWarningMessage(
          'OAK is installed twice (the extension id changed in a rename). Please uninstall the older "Claude Observatory"/"OAK" entry in the Extensions view, then reload.'
        );
      }
    })();
    return; // activate for real on the next load — this window stays with the already-active build
  }
  // 0.9.4: the Edits and Diffs trees are GONE — Review is the one review surface (greyed resolved
  // rows carry redo/undo; file headers carry the structural scopes). The raw records stay in the
  // backend; File History still reads them per file.
  // 0.10.0: Observations and Actions are no longer views of their own. VS Code stacks panel views under
  // collapsible headers and offers no tab strip, so the three timeline surfaces became ONE webview with
  // real tabs — these two providers still own the feeds it renders.
  const insightsProvider = new ObservationsProvider();
  const actionsProvider = new ActionsProvider();
  const fileHistoryProvider = new FileHistoryProvider();
  const fileHistoryView = vscode.window.createTreeView('claudeObservatory.fileHistory', { treeDataProvider: fileHistoryProvider });
  fileHistoryProvider.view = fileHistoryView;
  const statsProvider = new StatsUsageViewProvider();
  const changeMapProvider = new ChangeMapViewProvider();
  // Honour the reader's preferred home for the Overview. Deferred to the next tick so the view provider
  // is registered first — opening the tab before the panel view exists would leave nothing to hand the
  // wheel back to when the tab is closed.
  if (vscode.workspace.getConfiguration('claudeObservatory').get<string>('overviewLocation') === 'editor')
    setTimeout(() => changeMapProvider.openInEditor(), 0);
  // The Timeline window (Prompts · Actions · Observations, one webview with tabs): picking an ask on the
  // Prompts tab scopes the Overview beside it.
  const promptsProvider = new TimelineViewProvider(insightsProvider, actionsProvider);
  // Review reads the pick through the owner's getter — one owner, no second copy to disagree after a
  // reload. It refreshes on every pick from EITHER path (the list click below, pickPrompt beside it).
  const reviewProvider = new ReviewViewProvider(() => changeMapProvider.getPrompt());
  promptsProvider.onSelect = (id) => {
    changeMapProvider.setPrompt(id);
    reviewProvider.refresh();
    updateStatusItem(); // the nav bar's Prompt counter must move with the click, not the next refresh
  };
  // The reverse direction: an Overview row named a subject (worker · workflow · task · shell).
  // Reveal the Feed for that subject. A session pick connects the Feed to its conversation;
  // other kinds select their own activity. A null ref returns to the connected session's feed.
  // A head edit item opens its file's changes as the STACKED layout, through
  // the Review provider that owns the stacked panel.
  promptsProvider.onOpenEditFile = (session, editId) => reviewProvider.openFileStacked(session, editId);
  // The Overview ledger's ⧉ — the same stacked opener, from the change map.
  changeMapProvider.onOpenFileStacked = (session, editId) => reviewProvider.openFileStacked(session, editId);
  changeMapProvider.onFeedSelect = (ref) => {
    if (ref && ref.kind === 'session' && ref.id) {
      promptsProvider.connectSession(ref.id);
      promptsProvider.followHead(null);
    } else {
      promptsProvider.followHead(ref);
    }
    if (ref) {
      void (async () => {
        await vscode.commands.executeCommand('claudeObservatory.timeline.focus');
        promptsProvider.setTab('feed');
      })();
    }
  };
  /**
   * Pick an ask from OUTSIDE the Prompts list — the nav bar's Prompt axis, Review prompt, Rewind.
   *
   * Both surfaces have to move: scoping the Overview without selecting the row left the two disagreeing
   * about which ask was picked, with the nav bar's counter naming one and the list highlighting another.
   * The Timeline's own setter deliberately does not notify back, so this cannot start a select loop.
   */
  const pickPrompt = (id: string | null) => {
    changeMapProvider.setPrompt(id);
    promptsProvider.setSelection(id);
    reviewProvider.refresh();
  };
  const tourPanel = new DemoTourPanel(context.globalState);
  // Per-diff review bars in every claude-edit diff (multi-diff rows included) — synced to the
  // visible editors, initial sweep included.
  const diffBars = new DiffBars();
  diffBars.sync();
  const reviewComments = new ReviewComments();
  reviewComments.sync();

  // --- demo mode + the guided tour (0.8.9) ---------------------------------------------------------
  // The steps are core's, so this renders the same script the CLI prints and the JetBrains plugin
  // shows. `tourStep` is -1 when no tour is running.
  let TOUR: core.DemoStep[] = core.demoTour();
  let tourTrack: core.DemoTrack = 'everything';
  let tourStep = -1;
  /** The wait step currently armed, if any. No timer and no new watcher: `refreshAll` already runs on
   *  every store change, and the verdict itself is core's so both editors reach the same one. */
  let tourWatch:
    | { kind: core.DemoActionKind; before: core.DemoActionSnapshot; state: core.DemoActionState; session?: string }
    | undefined;
  /** Whether the last `editor` step actually got a file open — what makes its auto action honest. */
  let tourOpenedFile = false;
  /** Set when the tour turned Spotlight on, so it can turn it back off when the step is left. */
  let tourLitSpotlight = false;
  /**
   * Autoplay. ONE timer per step, which is also a wait step's countdown — that single timer is what
   * makes pausing actually pause. (The site's browser demo keeps them separate, so pausing there clears
   * the step timer but not the gate countdown and a paused demo still drifts forward.)
   */
  let tourPlaying = true;
  let tourTimer: NodeJS.Timeout | undefined;
  let tourTick: NodeJS.Timeout | undefined;
  let tourReducedMotion = false;

  /** Bumped by every schedule and every stop, so a timer that outlived its moment cannot act. */
  let tourAdvanceTok = 0;
  const stopAutoplay = () => {
    tourAdvanceTok++;
    if (tourTimer) clearTimeout(tourTimer);
    if (tourTick) clearInterval(tourTick);
    tourTimer = undefined;
    tourTick = undefined;
  };
  /**
   * Schedule the beat between an action landing and the tour moving on — the ONE place that does it.
   *
   * Two paths reach this moment: `advanceAutoplay` performs an unanswered action, which refreshes, which
   * makes `checkTourWatch` see the state change and want to move on too. Arming a timer at each site
   * left two in flight for the same moment, relying on their index guards to make the second inert.
   * They did — but a scheduler that cancels first, plus a token, does not depend on that reasoning
   * holding the next time either guard is touched.
   */
  const scheduleAdvance = (from: number) => {
    stopAutoplay();
    const tok = tourAdvanceTok;
    tourTimer = setTimeout(() => {
      if (tok === tourAdvanceTok && tourPlaying && tourStep === from) void applyTourStep(from + 1);
    }, 1400);
    tourTimer.unref?.();
  };
  /** Pause and tell the panel. Every manual control routes through here — taking the wheel is explicit. */
  const pauseAutoplay = () => {
    if (!tourPlaying && !tourTimer) return;
    tourPlaying = false;
    stopAutoplay();
    tourPanel.postAuto(false, 0);
  };
  const armAutoplay = (step: core.DemoStep) => {
    stopAutoplay();
    if (!tourPlaying || tourStep < 0) return;
    // A wait step gets the countdown instead of the reading dwell: the reader is being asked to do
    // something, and nine seconds is the grace before the tour does it for them.
    const waiting = step.action?.mode === 'wait';
    const ms = waiting ? core.DEMO_ACTION_COUNTDOWN_MS : core.demoStepDwellMs(step);
    const until = Date.now() + ms;
    const post = () => tourPanel.postAuto(true, Math.max(0, Math.ceil((until - Date.now()) / 1000)));
    post();
    const tok = tourAdvanceTok;
    tourTick = setInterval(post, 1000);
    tourTick.unref?.();
    tourTimer = setTimeout(() => {
      if (tok === tourAdvanceTok) void advanceAutoplay(step);
    }, ms);
    tourTimer.unref?.();
  };
  /** The timer ran out. A reading step moves on; an unanswered ask is performed, then moves on. */
  const advanceAutoplay = async (step: core.DemoStep) => {
    stopAutoplay();
    if (!tourPlaying || tourStep < 0) return;
    if (step.action?.mode === 'wait' && tourWatch?.state === 'waiting') {
      await runTourAction(step.action.kind);
      refreshAll(true);
      // Show the result before moving — the point of doing it was that the reader sees it happen.
      // Re-check: the reader can have hit Exit, or moved on, while the action was in flight.
      if (tourStep < 0 || TOUR[tourStep]?.id !== step.id) return;
      // Report what ACTUALLY happened. runTourAction is a deliberate no-op when there is nothing left to
      // accept, and a hard-coded "done" would then claim an action the reader can see did not occur.
      const after = tourWatch
        ? core.demoActionState(tourWatch.kind, tourWatch.before, reviewSnapshot(tourWatch.session))
        : 'satisfied';
      if (tourWatch) tourWatch.state = after;
      tourPanel.postActionState(after);
      scheduleAdvance(tourStep);
      return;
    }
    await applyTourStep(tourStep + 1);
  };

  const reviewSnapshot = (session?: string): core.DemoActionSnapshot => {
    // Keyed to ONE session. Comparing a count taken against the demo with one taken after Exit Demo
    // switched the view back to a real session is a comparison of two different logs.
    const s = session ?? currentSession();
    const log = s ? cachedLog(s) : [];
    return {
      kept: log.filter((r) => r.status === 'kept').length,
      undone: log.filter((r) => r.status === 'undone').length,
      pending: log.filter((r) => r.status === 'pending').length,
      total: log.length,
    };
  };
  const disarmTourWatch = () => {
    tourWatch = undefined;
  };
  /** Called from refreshAll AFTER autoClearDemo — a fully reviewed demo drops its records, and that
   *  emptied log is the `vacated` verdict rather than a reason to keep waiting. */
  const checkTourWatch = () => {
    if (!tourWatch) return;
    // The session moved out from under the watch (Exit Demo, a switch): the counts are no longer
    // comparable, so stop watching rather than reporting a verdict drawn from someone else's log.
    if (currentSession() !== tourWatch.session) {
      tourWatch = undefined;
      return;
    }
    const state = core.demoActionState(tourWatch.kind, tourWatch.before, reviewSnapshot(tourWatch.session));
    if (state === tourWatch.state) return; // only post on a CHANGE, so a refresh tick is not 20 messages
    tourWatch.state = state;
    tourPanel.postActionState(state);
    // The reader did it. Cancel the countdown and move on after the same beat the timer would have used,
    // so doing it yourself and letting it happen feel like the same tour.
    if (state !== 'waiting' && tourPlaying) scheduleAdvance(tourStep);
  };
  /** Run an `auto` step's action, reusing the handler the product already ships. */
  const runTourAction = async (kind: core.DemoActionKind): Promise<boolean> => {
    const s = currentSession();
    const root = workspaceRoot();
    // Belt and braces: this function ACCEPTS AND REVERTS EDITS, and a `wait` step does it on a timer
    // with nobody watching. It must never touch a session the reader actually cares about, whatever
    // route got us here.
    if (kind !== 'toggle-spotlight' && kind !== 'open-demo-file' && (!s || !core.isDemoSession(s))) return false;
    if (kind === 'toggle-spotlight') {
      // Turn it ON, never merely flip it: a reader who already had Spotlight lit would otherwise watch it
      // go OUT under a panel announcing that it came on.
      if (heatmapOn) return true;
      await vscode.commands.executeCommand('claudeObservatory.toggleHeatmap');
      tourLitSpotlight = true; // only ours to put back if we were the one who lit it
      return true;
    }
    // The `editor` view branch already opened it — and reports whether it found anything it could open.
    if (kind === 'open-demo-file') return tourOpenedFile;
    if (!s) return false;
    // Autoplay applies an unanswered ask itself, so every WAIT kind has to be performable too — always
    // through the command the product already ships, never a second implementation of keep or undo.
    if (kind === 'keep-edit' || kind === 'undo-edit') {
      const rec = cachedLog(s).find((r) => r.status === 'pending');
      if (!rec) return false; // nothing left to review; the panel's line says so rather than a no-op running
      // These commands take the TREE NODE, not an id — they are the same handlers the Edits tree calls.
      await vscode.commands.executeCommand(
        kind === 'keep-edit' ? 'claudeObservatory.keep' : 'claudeObservatory.undo',
        { kind: 'edit', rec } as EditNode
      );
      return true;
    }
    if (kind === 'keep-prompt' && root) {
      try {
        // The ask that still has work outstanding — resolved from the data, never a hard-coded index.
        const p = core.promptWindows(root, s).find((r) => r.pending > 0);
        if (!p) return false;
        await vscode.commands.executeCommand('claudeObservatory.promptKeep', p.id);
        return true;
      } catch {
        return false; // nothing pending under any ask
      }
    }
    if (kind === 'keep-task' && root) {
      // The task is resolved from the data, never hard-coded: a script that names task ids would go
      // stale the moment the scenario changed.
      try {
        const m = core.cachedChangeMap(root, s, { root, prompts: true }); // in-process on the extension host — read, never rebuild
        const row = m.rollupByTask.find((r) => r.taskId !== null && r.pending > 0);
        if (!row?.taskId) return false;
        await vscode.commands.executeCommand('claudeObservatory.taskKeep', row.taskId);
        return true;
      } catch {
        return false; // nothing pending to accept
      }
    }
    return false;
  };
  // True while a replay is in flight. The paint timer flips `demoPresent` on within a second of the
  // first beat, which unlocks Exit and Restart while the run is still writing the very files Exit would
  // delete — and Start has no re-entrancy guard of its own.
  let demoReplaying = false;
  /** The tree views a tour step can bring forward. `actions` and `observations` are NOT here: they are
   *  tabs of the Timeline webview now, brought forward by focusing it and naming the tab. */
  const TOUR_TREES: Record<string, unknown> = {
    fileHistory: fileHistoryView,
  };
  /** The tour views that are Timeline TABS. Core's anchor/view set is closed and not ours to extend —
   *  these names already exist there, and this is where they resolve now (feed joined in 0.10.0). */
  const TOUR_TIMELINE_TABS: Record<string, 'prompts' | 'actions' | 'observations' | 'feed'> = {
    prompts: 'prompts',
    actions: 'actions',
    observations: 'observations',
    feed: 'feed',
  };
  const clearTourTips = () => {
    changeMapProvider.setTour(null, null);
    statsProvider.setTour(null);
    promptsProvider.setTour(null);
  };
  const applyTourStep = async (i: number) => {
    if (i < 0 || i >= TOUR.length) return;
    disarmTourWatch();
    // Leaving a Spotlight step turns it back off — a tour that dimmed your editor and walked away
    // would have changed your workspace to make a point.
    if (tourLitSpotlight) {
      tourLitSpotlight = false;
      await vscode.commands.executeCommand('claudeObservatory.toggleHeatmap');
    }
    tourStep = i;
    const step = TOUR[i];
    // Keep the fleet inside its 60s active window while the tour explains it. On step advance ONLY:
    // this touches watched files, and a heartbeat driven by a refresh would re-trigger itself forever.
    try {
      const root = workspaceRoot();
      if (root && demoSession) core.demoHeartbeat({ cwd: root });
    } catch {
      /* a heartbeat is a nicety; a step must never fail to show because of one */
    }
    clearTourTips();
    // BROADCAST the anchor to every tour-aware panel; each rings it only if its own map knows the name,
    // and the names are globally unique (a core test pins that). Routing by view instead would be wrong
    // in both directions: a Stats anchor sent to the Overview rings nothing, and a Prompts step that
    // names "Accept Prompt" — a control that lives in the Overview beside it — has to reach the Overview.
    const anchor = step.anchor ?? null;
    if (step.view !== 'overview') changeMapProvider.setTour(null, anchor);
    statsProvider.setTour(anchor);
    promptsProvider.setTour(anchor);
    if (step.view === 'overview') {
      await vscode.commands.executeCommand('claudeObservatory.changemap.focus');
      changeMapProvider.setTour(step.tab ?? null, anchor);
    } else if (TOUR_TIMELINE_TABS[step.view]) {
      // Prompts, Actions and Observations are one window now: reveal it, then bring the step's TAB
      // forward instead of revealing a view that no longer exists.
      await vscode.commands.executeCommand('claudeObservatory.timeline.focus');
      promptsProvider.setTab(TOUR_TIMELINE_TABS[step.view]);
    } else if (step.view === 'review') {
      // The Review view narrates the PICKED ask. The step lands right after prompt-scope invited a
      // pick, but a reader who skipped it (or autoplay) must not face the empty state mid-tour — pick
      // the demo's second ask, the one prompt-scope talks about, exactly as the review button would.
      if (!changeMapProvider.getPrompt()) {
        const s = currentSession();
        const root = workspaceRoot();
        const second = s && root ? core.promptWindows(root, s)[1] : undefined;
        if (second) pickPrompt(second.id);
      }
      await vscode.commands.executeCommand('claudeObservatory.reviewList.focus');
    } else if (step.view === 'stats') {
      await vscode.commands.executeCommand(`claudeObservatory.${step.view}.focus`);
    } else if (step.view === 'editor') {
      // Open the newest pending edit that is actually openable: inside the workspace (the scenario's
      // last edit is the report written OUTSIDE it) and still on disk (one edit is a DELETION, and it
      // becomes the newest pending as soon as the reader accepts anything the tour invited them to).
      const s = currentSession();
      const root = workspaceRoot();
      const rec = s
        ? cachedLog(s)
            .filter((r) => r.status === 'pending' && (!root || r.file.startsWith(root + path.sep)) && fs.existsSync(r.file))
            .pop()
        : undefined;
      tourOpenedFile = false;
      if (rec) {
        try {
          await openFileAtEdit({ kind: 'edit', rec });
          tourOpenedFile = true;
        } catch {
          /* a step that cannot open its file still reads — never let it strand the tour */
        }
      }
    } else {
      const view = TOUR_TREES[step.view];
      if (view) await vscode.commands.executeCommand(`claudeObservatory.${step.view}.focus`);
    }
    // Bring the tour forward LAST, and WITHOUT focus: the step has just deliberately focused a panel,
    // and stealing it back would undo the thing the step exists to show.
    // Arm a wait step, or run an auto one — after the view is focused, so the reader can see the thing
    // before being asked to act on it.
    let actionState: core.DemoActionState | undefined;
    if (step.action?.mode === 'auto') {
      // An auto step that no-ops (nothing pending, no demo pinned, no openable file) must not print its
      // past-tense line: the reader can see that nothing moved, and "✓ done" over that is a lie.
      actionState = (await runTourAction(step.action.kind)) ? 'satisfied' : 'vacated';
      refreshAll(true);
    } else if (step.action) {
      const watched = currentSession();
      tourWatch = { kind: step.action.kind, before: reviewSnapshot(watched), state: 'waiting', session: watched };
      // A session with no records at all resolves immediately rather than waiting forever.
      tourWatch.state = core.demoActionState(tourWatch.kind, tourWatch.before, reviewSnapshot(watched));
      actionState = tourWatch.state;
    }
    tourPanel.reveal();
    tourPanel.show(i, TOUR.length, step, actionState);
    // The last step is an offer, not a frame — autoplay stops there rather than looping.
    if (i + 1 < TOUR.length) armAutoplay(step);
    else pauseAutoplay();
  };
  /** Ask which track to walk, then open the tour. `track` skips the question (a restart keeps yours). */
  const startTour = async (track?: core.DemoTrack) => {
    // The tour ACTS on the session under review — it accepts and reverts edits, some on a timer. So it
    // may only ever run against the demo. `demoPresent` is true whenever a demo exists on disk, which
    // is deliberately weaker: one real Claude turn after a demo makes that the newest session, and a
    // window reload drops the in-memory pin. Re-pin here, and refuse outright if there is nothing to pin.
    const root0 = workspaceRoot();
    if (!demoSession || !core.isDemoSession(demoSession)) {
      const found = root0 ? core.demoSessionsFor({ cwd: root0 })[0] : undefined;
      if (!found) {
        void vscode.window.showWarningMessage(
          'OAK: the guided tour runs against the demo session, and there is no demo recorded for this folder. Start Demo Mode first.'
        );
        return;
      }
      demoSession = found;
      refreshAll(true);
    }
    const sizes = core.demoTrackSizes();
    let chosen = track;
    if (!chosen) {
      const pick = await vscode.window.showQuickPick(
        [
          { label: `$(zap) Essentials`, description: `${sizes.essentials} steps`, detail: 'The review model, the agents, and the audits — the short way through.', track: 'essentials' as const },
          { label: `$(book) Everything`, description: `${sizes.everything} steps`, detail: 'Every panel and every named feature, in order.', track: 'everything' as const },
        ],
        { title: 'OAK — guided tour', placeHolder: 'How much of it would you like to see?' }
      );
      if (!pick) return; // dismissed — no tour, and no half-opened window
      chosen = pick.track;
    }
    TOUR = core.demoTour(chosen);
    tourTrack = chosen;
    // A reader who has asked their OS not to animate things has not asked for a tour that advances
    // itself either. The webview reports the media query; until it does, assume motion is fine.
    tourPlaying = !tourReducedMotion;
    // The tour describes rows that Active only — ON by default — hides: five of the demo's six tasks are
    // completed, so "Accept task 1" would name a row the reader cannot see. Show everything for the
    // duration and put the filter back in endTour, exactly as the Spotlight step already does.
    changeMapProvider.setShowAll(true);
    await vscode.commands.executeCommand('setContext', 'claudeObservatory.demoTour', true);
    await tourPanel.open();
    await applyTourStep(0);
  };
  /**
   * The end of a track. After the short one, offer its exact complement rather than just closing: the
   * reader chose Essentials without knowing what was in the other half, and this is the only place they
   * are told. Any other track ends the tour.
   */
  const finishTour = async () => {
    if (tourTrack !== 'essentials') return endTour();
    pauseAutoplay();
    const rest = core.demoTrackSizes().remainder;
    const go = `See the other ${rest}`;
    const pick = await vscode.window.showInformationMessage(core.demoTrackBlurb('essentials'), go, 'Done');
    // Dismissed (Escape) ends it too — an unanswered offer is not consent to keep going.
    if (pick !== go) return endTour();
    TOUR = core.demoTour('remainder');
    tourTrack = 'remainder';
    tourPlaying = !tourReducedMotion;
    await applyTourStep(0);
  };
  const endTour = async () => {
    tourStep = -1;
    stopAutoplay();
    disarmTourWatch();
    changeMapProvider.setShowAll(false);
    if (tourLitSpotlight) {
      tourLitSpotlight = false;
      await vscode.commands.executeCommand('claudeObservatory.toggleHeatmap');
    }
    clearTourTips();
    tourPanel.close();
    updateEmptyStateContext();
    await vscode.commands.executeCommand('setContext', 'claudeObservatory.demoTour', false);
  };


  // A SUBTLE whole-line green tint + GREEN change-bar on the agent's added/changed lines — deliberately
  // low-alpha (not the default diff green) so a file where agent edited many lines doesn't drown in
  // color, while still showing at a glance what changed.
  inlineDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: ADDED_LINE_BG,
    overviewRulerColor: CLAUDE_MARK_COLOR,
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: ADDED_BAR,
  });
  // ✨ gutter icon at the START of each edit — the "Agent edited here" marker; click the CodeLens
  // above (or, in JetBrains, the gutter icon itself) to open the inline diff.
  annotationDecoration = vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'star.svg'),
    gutterIconSize: 'contain',
  });
  // Deleted lines don't exist in the buffer, so show the removed text as red ghost text on the surviving
  // anchor line, over a subtle red tint + red gutter bar (the toned-down mirror of the added-line fill).
  deletionGhostDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: REMOVED_LINE_BG,
    overviewRulerColor: CLAUDE_MARK_COLOR,
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: REMOVED_BAR,
  });
  // File heatmap: fade unmodified lines to ~40% so the agent's edited lines read at full contrast.
  heatmapDecoration = vscode.window.createTextEditorDecorationType({ opacity: '0.4' });
  inlineLens = new InlineLensProvider();
  const editPeek = new EditPeek();

  // Realtime observatory readout: a status-bar microscope with the pending count — always visible,
  // amber while edits await review. Click = jump to the next pending edit.
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusItem.command = 'claudeObservatory.reviewNext';
  // The nav bar: a compact review toolbar beside the microscope, shown only while edits await review so
  // the bottom bar stays quiet when you're caught up. Two tiers (adopted from Void's editor review bar):
  //   • session tier  — Search, File axis (← n/m →), Accept All / Reject All, Clear resolved, Spotlight — whenever ANY edit is pending
  //   • active-file tier — Diff axis (↑ n/m ↓), Keep/Undo this edit, Accept/Reject File — when the OPEN file
  //     has pending edits (mirrors the per-file bar Void pins at the bottom of the editor).
  // navEditId is the pending edit the Diff axis is parked on within the open file.
  let navEditId: number | undefined;
  // Review-loop cursor: id of the pending edit last opened, so ←/→ step backward/forward through every
  // pending edit (wrapping at the ends) instead of always reopening the oldest. Declared HERE, well
  // above the loop that owns it, because `updateStatusItem` — which runs once during activation, before
  // that loop is reached — parks the auto-shown review bar on it.
  let reviewCursorId: number | undefined;
  // Every action button carries its SHORT label beside the icon (the icon-only bar read as cryptic)
  // plus the nav bar's semantic tint (keep/accept green · undo/reject red · chevrons blue · clear
  // orange · search/spotlight purple — the Overview toolbar's palette). The four chevrons stay
  // arrow-only: they frame the labeled File n/m / Diff n/m counters (same treatment as the Overview).
  const mkStatusBtn = (text: string, tooltip: string, command: string, priority: number, tint?: string) => {
    const b = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
    b.text = text;
    b.tooltip = tooltip;
    b.command = command;
    if (tint) b.color = new vscode.ThemeColor(tint);
    return b;
  };
  // A passive group divider — mirrors the Overview navbar's .ov-nbsep so the status-bar nav bar reads as
  // the SAME spaced groups. No command (non-interactive); the padding widens the gap between groups.
  const mkStatusSep = (priority: number) => {
    const s = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
    s.text = '  │  ';
    s.color = new vscode.ThemeColor('descriptionForeground');
    return s;
  };
  // ORDER + GROUPING mirror the Overview navbar (higher priority = further left):
  //   Search │ Diff axis · Keep · Undo │ File axis · Accept/Reject File │ Accept All · Reject All · Clear │ Spotlight
  // Search leads every nav bar (user rule 2026-07-16 — same position on every surface).
  const searchBtn = mkStatusBtn('$(search) Search', 'OAK: search edits', 'claudeObservatory.searchEdits', 100, 'charts.purple');
  // The USAGE READOUT (matched to the reference screenshot): per agent a
  // bordered group — │ icon  bar share window  time … │ — the icon in the agent's color
  // (✳ orange claude, ⬡ gpt), each window chunk `▰▰▰▱▱ 58% 5h` in its usage hue, the time-left
  // its own WHITE item, dim │ pipes fencing each agent so the numbers read as one belonging
  // (VS Code items are single-color, so every differently-colored piece is its own item; PyCharm

  const usageItems: vscode.StatusBarItem[] = [];
  const mkUsageItem = (priority: number): vscode.StatusBarItem => {
    const it = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, priority);
    it.command = 'claudeObservatory.stats.focus';
    usageItems.push(it);
    return it;
  };
  // Priorities descend left→right: claude icon, claude windows ×3, gpt icon, gpt windows ×3, refresh.
  const claudeIcon = mkUsageItem(4.98);
  // claude's three windows in reading order: 5h · wk · mo, as the TUI's one-line readout (frame.ts
  // win3). The account's per-model weekly cap has no slot: the tooltip names it.
  const claudeWin = [mkUsageItem(4.9), mkUsageItem(4.8), mkUsageItem(4.7)];
  const gptIcon = mkUsageItem(4.58);
  const gptWin = [mkUsageItem(4.5), mkUsageItem(4.45), mkUsageItem(4.4)];
  const refreshItem = mkUsageItem(4.2);
  const usageHue = (worst: number): vscode.ThemeColor =>
    new vscode.ThemeColor(worst >= 80 ? 'charts.red' : worst >= 50 ? 'charts.yellow' : 'charts.green');

  const usageHuman = (n: number): string => {
    if (n >= 1_000_000_000) { const b = Math.floor((n % 1_000_000_000) / 100_000_000); return b ? `${Math.floor(n / 1_000_000_000)}.${b}B` : `${Math.floor(n / 1_000_000_000)}B`; }
    if (n >= 1_000_000) { const d = Math.floor((n % 1_000_000) / 100_000); return d ? `${Math.floor(n / 1_000_000)}.${d}M` : `${Math.floor(n / 1_000_000)}M`; }
    if (n >= 1000) return `${Math.floor(n / 1000)}k`;
    return String(n);
  };
  const usageUntil = (ms: number | null): string => {
    if (!ms) return '';
    const d = Math.floor((ms - Date.now()) / 1000);
    if (d <= 0) return 'now';
    if (d >= 86400) return `${Math.floor(d / 86400)}d ${Math.floor((d % 86400) / 3600)}h`;
    if (d >= 3600) return `${Math.floor(d / 3600)}h ${Math.floor((d % 3600) / 60)}m`;
    return `${Math.floor(d / 60)}m`;
  };
  // ONE item per window, timer INSIDE it (separate time items floated apart
  // and nothing said which timer belonged to which window). The item gaps now fall only BETWEEN
  // windows, which is the grouping. An item is one color, so the time wears its window's hue
  // here; PyCharm's single label keeps the grey-label/white-time styling exactly.
  const setWin = (win: vscode.StatusBarItem, label: string, pct: number | null, reset: number | null, tip: string): boolean => {
    if (pct === null) {
      win.hide();
      return false;
    }
    const until = usageUntil(reset);
    // Unified window chunk: `<label>: N% <reset>`, one shape for BOTH providers
    // (claude AND gpt) — label first, then the percent, then the time-left. Every window that goes
    // through here (claude 5h/wk/mo, gpt 5h/wk/mo) reads identically.
    win.text = `${label}: ${Math.round(pct)}%${until ? ` ${until}` : ''}`;
    win.color = usageHue(Math.round(pct));
    win.tooltip = tip;
    win.show();
    return true;
  };
  const usageTip = (label: string, pct: number | null, reset: number | null, est: number | null, tot: number | null): string => {
    if (pct === null) return '';
    const bits = [`${Math.trunc(pct)}%`];
    const until = usageUntil(reset);
    if (until) bits.push(`resets in ${until}`);
    if (est) bits.push(`~${usageHuman(est)}${tot ? ` of ~${usageHuman(tot)}` : ''}`);
    return `\n${label} ${bits.join(' \u00b7 ')}`;
  };
  const updateUsageBar = () => {
    let anyShown = false;
    try {
      // The status bar is the one poller that ALWAYS runs (60s, visibility-independent), but it
      // reads core in-process — it never passed through the CLI, so on a machine living in
      // VS Code nothing ever kicked the account pull.
      // The kick rides here now; a fired pull gets a quick re-render to land visibly.
      try {
        if (core.dueAccountUsagePull()) {
          // IN-HOST, not a spawned child (2026-09-09): the extension host is a GUI-descended
          // process with fetch and core bundled — a detached CLI child kept dying on the Mac
          // (no node at the shebang; then no keychain from a setsid'd child). Async, so the
          // render below never waits on the network.
          void core.pullProviderAccountUsage().then((ok) => {
            if (ok) updateUsageBar();
          });
        }
      } catch { /* best-effort — the bar still renders the cache */ }
      const cwd = workspaceRoot() ?? process.cwd();
      // The bill-cycle month is scanned only by the statusline, which never runs when the machine is
      // driven from VS Code — so kick a throttled refresh here too, the same way the account pull rides
      // this path. Detached + claim-throttled; never blocks.
      try { core.kickMonthRefresh(cwd); } catch { /* best-effort */ }
      // Remote Control titles from claude.ai ride this poll too — in-host and async, like the account
      // pull above and for the same reason (a detached child on the Mac cannot read the keychain login).
      // The next sessions refresh shows what it cached.
      try { if (core.claimRemoteTitlesRefresh()) void core.refreshRemoteTitles(); } catch { /* best-effort */ }
      const u = core.usageLine(cwd, '');
      const moPct = u.monthTokens && u.monthTokensTotal ? Math.min(100, (u.monthTokens / u.monthTokensTotal) * 100) : null;
      const musd = (v: number): string => (v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(1)}`);
      // The per-model weekly cap the account reports (its "Fable" row) is named in the tooltip, after
      // the week it narrows, and never gets a window of its own on the bar.
      const tip = 'OAK: Claude plan usage — the statusline’s own readout' +
        usageTip('5h', u.fiveHourPct, u.fiveReset, u.fiveTokens, u.fiveTotal) +
        usageTip('wk', u.weekPct, u.weekReset, u.weekTokens, u.weekTotal) +
        usageTip(u.fableLabel || 'Fable', u.fablePct, u.fableReset, u.fableTokens, u.fableTotal) +
        usageTip('mo', moPct, u.monthReset ?? null, u.monthTokens, u.monthTokensTotal) +
        (u.monthReads ? `\nmo cache reads +${usageHuman(u.monthReads)}\u21ba` : '') +
        (u.monthCost ? `\nmo ~${musd(u.monthCost)} spent${u.monthCostTotal ? ` of ~${musd(u.monthCostTotal)}` : ''}` : '') +
        '\nClick for the Stats panel.';
      let shown = [
        setWin(claudeWin[0], '5h', u.fiveHourPct, u.fiveReset, tip),
        setWin(claudeWin[1], 'wk', u.weekPct, u.weekReset, tip),
        setWin(claudeWin[2], 'mo', moPct, u.monthReset ?? null, tip),
      ].some(Boolean);
      // A quota-less plan (Enterprise/API) fills no rolling bar, so all three windows hide and the
      // whole claude group + ↻ would vanish. Mirror the PyCharm widget (ObservatoryUsageWidgetFactory)
      // and show the bill-cycle spend instead, so the group stays visible. No %: there is no denominator.
      if (!shown && u.rollingLimits === false && u.monthCost != null) {
        claudeWin[2].text = `mo: ~${musd(u.monthCost)}`;
        claudeWin[2].color = undefined;
        claudeWin[2].tooltip = tip;
        claudeWin[2].show();
        shown = true;
      }
      if (shown) {
        claudeIcon.text = '\u2733';
        claudeIcon.color = new vscode.ThemeColor('charts.orange');
        claudeIcon.tooltip = tip;
        claudeIcon.show();
        anyShown = true;
      } else claudeIcon.hide();
    } catch {
      claudeIcon.hide();
      for (const it of claudeWin) it.hide();
    }
    let gptShown = false;
    try {
      const g = core.gptUsagePanel();
      const gtip = 'OAK: GPT quota snapshots and local usage.' +
        usageTip('5h', g?.fivePct ?? null, g?.fiveReset ?? null, null, null) +
        usageTip('wk', g?.weekPct ?? null, g?.weekReset ?? null, g?.weekTok ?? null, null) +
        (g?.monthTok ? `\nmo ${usageHuman(g.monthTok)} local tokens · UTC calendar month · ${usageUntil(g.monthReset)}` : '') +
        '\nClick for the Stats panel.';
      // 5h · wk · mo, the same three windows claude shows. gpt's 5h was omitted here even though it is
      // a real quota window every other surface renders (stats panel, PyCharm tooltip); setWin hides it
      // when the snapshot has no 5h reading.
      const gpt5 = setWin(gptWin[0], '5h', g?.fivePct ?? null, g?.fiveReset ?? null, gtip);
      const gptWk = setWin(gptWin[1], 'wk', g?.weekPct ?? null, g?.weekReset ?? null, gtip);
      gptShown = gpt5 || gptWk;
      // gpt month now carries a monthly total (core back-derives monthTokTotal from the weekly fill),
      // so its % is computed exactly as claude's mo — monthTok / monthTokTotal, capped at 100 — and
      // routed through the SAME setWin helper: `mo: N% <reset>` in its threshold hue, not the bare
      // white token count it used to show. No total reported yet → fall back to
      // the token-count readout (no %), carrying the reset so it still reads like claude's.
      const gmoPct = g?.monthTok && g?.monthTokTotal ? Math.min(100, (g.monthTok / g.monthTokTotal) * 100) : null;
      if (gmoPct !== null) {
        if (setWin(gptWin[2], 'mo', gmoPct, g?.monthReset ?? null, gtip)) gptShown = true;
      } else if (g?.monthTok) {
        const gmu = usageUntil(g.monthReset);
        gptWin[2].text = `mo: ${usageHuman(g.monthTok)}${gmu ? ` ${gmu}` : ''}`;
        gptWin[2].color = undefined;
        gptWin[2].tooltip = gtip;
        gptWin[2].show();
        gptShown = true;
      } else gptWin[2].hide();
      if (gptShown) {
        gptIcon.text = '\u2b21';
        gptIcon.color = new vscode.ThemeColor('charts.blue'); // gpt's icon is BLUE, like claude's orange \u2733 \u2014 not the default white
        gptIcon.tooltip = gtip;
        gptIcon.show();
        anyShown = true;
      } else gptIcon.hide();
    } catch {
      gptIcon.hide();
      for (const it of gptWin) it.hide();
    }
    // No fences — the agent icons themselves mark the group starts.
    if (anyShown) {
      refreshItem.text = '$(refresh)';
      refreshItem.command = 'claudeObservatory.usageRefresh';
      refreshItem.tooltip = 'OAK: refresh usage now';
      refreshItem.show();
    } else refreshItem.hide();
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeObservatory.usageRefresh', () => {
      // ONE refresh, everywhere: the account pull + the remote gather, then
      // the status bar AND the stats section re-render as each lands.
      void core.pullProviderAccountUsage().then((ok) => {
        if (ok) updateUsageBar();
      });
      updateUsageBar();
      for (const ms of [5_000, 20_000]) {
        const t = setTimeout(updateUsageBar, ms);
        t.unref?.();
      }
      for (const ms of [2_500, 6_000, 21_000]) {
        const t = setTimeout(() => statsProvider.refresh(), ms);
        t.unref?.();
      }
    })
  );
  updateUsageBar(); // startup render — and, when the cache is stale, the startup account pull
  // The stats section should show the startup pull's numbers without waiting for its 60s tick.
  for (const ms of [5_000, 12_000]) {
    const su = setTimeout(() => statsProvider.refresh(), ms);
    su.unref?.();
  }
  const usageBarTimer = setInterval(updateUsageBar, 60_000);
  usageBarTimer.unref?.(); // node-side timers must never keep a test-run process alive
  context.subscriptions.push(...usageItems, { dispose: () => clearInterval(usageBarTimer) });

  // The hands chip: how many sessions are waiting on the reader — hidden
  // at zero, amber otherwise; a click jumps to the most urgent one. Fed by the Timeline's sessions
  // read, so it needs no timer of its own.
  const handsBtn = mkStatusBtn('', 'OAK: sessions waiting on you — click jumps to the next (permission, then question, then input)', 'claudeObservatory.nextAttention', 93.6);
  promptsProvider.onHandsChanged = (n) => {
    if (!n) return handsBtn.hide();
    handsBtn.text = `$(warning) ${n}`;
    handsBtn.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    handsBtn.show();
  };
  context.subscriptions.push(handsBtn);
  // Diff group (Overview G2) — the OPEN file's edit axis + per-edit Keep/Undo.
  const diffPrevBtn = mkStatusBtn('$(chevron-up)', 'OAK: previous edit in this file', 'claudeObservatory.navDiffPrev', 98, 'charts.blue');
  const diffCountBtn = mkStatusBtn('', 'OAK: this file’s pending edits — click to open the floating review bubble', 'claudeObservatory.navViewDiff', 97);
  const diffNextBtn = mkStatusBtn('$(chevron-down)', 'OAK: next edit in this file', 'claudeObservatory.navDiffNext', 96, 'charts.blue');
  const keepEditBtn = mkStatusBtn('$(check) Keep', 'OAK: keep this edit', 'claudeObservatory.navKeep', 95, 'charts.green');
  const undoEditBtn = mkStatusBtn('$(close) Undo', 'OAK: undo this edit', 'claudeObservatory.navUndo', 94, 'charts.red');
  // File group (Overview G3) — the pending-file axis + per-file Accept/Reject.
  const filePrevBtn = mkStatusBtn('$(chevron-left)', 'OAK: previous changed file', 'claudeObservatory.navFilePrev', 92, 'charts.blue');
  const fileCountBtn = mkStatusBtn('', 'OAK: files with pending edits — click to open the Review view', 'claudeObservatory.reviewList.focus', 91);
  const fileNextBtn = mkStatusBtn('$(chevron-right)', 'OAK: next changed file', 'claudeObservatory.navFileNext', 90, 'charts.blue');
  const acceptFileBtn = mkStatusBtn('$(check-all) Accept File', 'OAK: accept every pending edit in this file', 'claudeObservatory.keepOpenFile', 89, 'charts.green');
  const rejectFileBtn = mkStatusBtn('$(close-all) Reject File', 'OAK: reject (revert) every pending edit in this file', 'claudeObservatory.undoOpenFile', 88, 'charts.red');
  // Bulk group (Overview G4) — session-wide Accept All · Reject All · Clear Resolved.
  const acceptAllBtn = mkStatusBtn('$(checklist) Accept All', 'OAK: accept all edits in this session', 'claudeObservatory.keepAll', 86, 'charts.green');
  const revertAllBtn = mkStatusBtn('$(close-all) Reject All', 'OAK: reject (revert) every pending edit in this session', 'claudeObservatory.undoAll', 85, 'charts.red');
  const clearBtn = mkStatusBtn('$(clear-all) Clear Resolved', 'OAK: clear resolved (kept/reverted) edits', 'claudeObservatory.clearResolved', 84);
  // Spotlight (Overview G5).
  const spotlightBtn = mkStatusBtn('$(lightbulb) Spotlight', 'OAK: toggle spotlight — dim unedited lines to highlight the agent’s changes', 'claudeObservatory.toggleHeatmap', 82, 'charts.purple');
  // Four dividers slot between the five groups (priority lands each between the groups it separates).
  // sep1/sep3/sep4 ride the session tier (always flanked by a visible group when pending); sep2 rides
  // the active-file tier, so it hides together with the Diff group when no changed file is open.
  const sep1 = mkStatusSep(99); // Search | Diff
  const sep2 = mkStatusSep(93); // Diff | File
  const sep3 = mkStatusSep(87); // File | bulk
  const sep4 = mkStatusSep(83); // bulk | Spotlight
  const activeFileBtns = [diffPrevBtn, diffCountBtn, diffNextBtn, keepEditBtn, undoEditBtn, acceptFileBtn, rejectFileBtn, sep2];
  const sessionBtns = [searchBtn, filePrevBtn, fileCountBtn, fileNextBtn, acceptAllBtn, revertAllBtn, clearBtn, spotlightBtn, sep1, sep3, sep4];
  const navCluster = [...activeFileBtns, ...sessionBtns];
  // Clear Resolved keeps the amber "attention" tint, but the theme's dark charts-orange reads muddy —
  // use the brighter amber on dark themes (parity with the Overview webview), the theme orange on light.
  const applyClearTint = () => {
    const k = vscode.window.activeColorTheme.kind;
    const dark = k === vscode.ColorThemeKind.Dark || k === vscode.ColorThemeKind.HighContrast;
    clearBtn.color = dark ? '#e6a44c' : new vscode.ThemeColor('charts.orange');
  };
  applyClearTint();
  context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(applyClearTint));

  /** The user's own asks that still have pending edits, chronologically — the model for the Prompt axis.
   *  A prompt with no edits at all is a normal, honest thing (a question, a decision), but it is not a
   *  review stop: the axis walks what is left to review. Indexed by id (one Map build) rather than a
   *  nested log scan per editId — the old shape was O(N²) per refresh AND per tab switch. */
  const pendingPrompts = (s: string) => {
    // promptWindows, not sessionPrompts: the axis reads windows + edit ids + pending only, and this
    // runs on every refresh and every keep click — the full view (deltas, attribution, tokens) re-read
    // the whole transcript per click and grew linearly with it. The pending count rides the window, so
    // the per-call byId Map build went with it.
    return core.promptWindows(workspaceRoot() ?? process.cwd(), s).filter((r) => r.pending > 0);
  };

  const updateStatusItem = () => {
    const session = currentSession();
    // DISPLAY units — the same collapse the Overview and the Sessions rows use. See `cachedReview`.
    const skip = session ? core.cancelledMemberIds(session) : new Set<number>();
    const log = session ? cachedReview(session).filter((r) => !skip.has(r.id)) : [];
    const pendingRecs = log.filter((r) => r.status === 'pending');
    const pending = pendingRecs.length;
    const kept = log.filter((r) => r.status === 'kept').length;
    const undone = log.filter((r) => r.status === 'undone').length;
    statusItem.text = pending ? `🔬 ${pending}` : '🔬';
    // The review scoreboard lives here (not in the Stats webview): always one glance away.
    const reviewed = kept + undone;
    const rate = reviewed ? ` · ${Math.round((kept / reviewed) * 100)}% accepted` : '';
    const oldest = pending ? Math.min(...pendingRecs.map((r) => r.ts)) : null;
    const age = oldest ? ` · oldest ${core.relTime(oldest)}` : '';
    const tip = new vscode.MarkdownString(
      `**OAK — review scoreboard**\n\n` +
        `${pending} pending · ${kept} accepted · ${undone} reverted${rate}${age}\n\n` +
        (pending ? `_Click to review the next pending edit_` : `_All caught up_`)
    );
    statusItem.tooltip = tip;
    statusItem.backgroundColor = pending ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    statusItem.show();

    // Nav-bar counters: the File axis spans every pending file; the Diff axis spans the OPEN file's edits.
    const activeFile = activeEditorFile();
    const files = session ? pendingFilesOf(session) : [];
    const inFile = session && activeFile ? pendingEditsInFile(session, activeFile) : [];
    const activeHasPending = inFile.length > 0;
    // Anchor navEditId to a still-pending edit in the OPEN file (default: the edit under the cursor, else
    // the file's first pending edit); cleared when the open file has nothing to review.
    if (activeHasPending) {
      if (navEditId === undefined || !inFile.some((r) => r.id === navEditId)) {
        const atCursor = session ? pendingAtCursor(session)?.id : undefined;
        navEditId = atCursor !== undefined && inFile.some((r) => r.id === atCursor) ? atCursor : inFile[0].id;
      }
    } else {
      navEditId = undefined;
    }
    const diffIdx = activeHasPending ? inFile.findIndex((r) => r.id === navEditId) : -1;
    diffCountBtn.text = activeHasPending ? `Diff ${diffIdx + 1}/${inFile.length}` : '';
    const fileIdx = activeFile ? files.indexOf(activeFile) : -1;
    fileCountBtn.text = files.length ? `File ${fileIdx >= 0 ? fileIdx + 1 : '–'}/${files.length}` : '';
    // Relative time of the edit under the Diff cursor, and the basename of the file the File axis is on —
    // shown next to their counters in the Overview nav bar.
    const curDiffRec = activeHasPending ? inFile.find((r) => r.id === navEditId) : undefined;
    const diffTime = curDiffRec ? core.relTime(curDiffRec.ts) : '';
    const fileName = activeFile ? path.basename(activeFile) : '';
    // Folder axis position: which changed folder (relative parent dir = a change-map strip tile) the open
    // file sits in, and that folder's file/edit totals — "Folder i/n · <dir> · N files · N edits".
    const folders = session ? pendingFoldersOf(session) : [];
    const curFolder = activeFile ? folderLabelOf(activeFile) : '';
    const folderIdx = folders.indexOf(curFolder);
    const inFolder = session && folderIdx >= 0 ? pendingEditsInFolder(session, curFolder) : [];
    const folderFiles = inFolder.length ? new Set(inFolder.map((r) => r.file)).size : 0;
    // Prompt axis position: which of YOUR asks produced the current edit — "Prompt i/n · #k · N edits".
    // `index` is the ask's own 1-based number in the whole session, which is how a person counts their
    // turns; `i/n` is its place among the asks that still have something to review, so the two differ and
    // both are shown rather than picking one and implying the other.
    let promptPos: { i: number; n: number; id: string; index: number; title: string; files: number; edits: number } | null = null;
    if (session && pending) {
      const reqs = pendingPrompts(session);
      if (reqs.length) {
        const byId = new Map(log.map((r) => [r.id, r]));
        const anchorId = navEditId;
        // The PICKED prompt wins: selecting a row in the Prompts window is an explicit scope, and the
        // axis not moving with it read as a bug. The edit anchor is the fallback; a picked prompt with
        // nothing pending falls through to it (this axis walks pending review).
        const picked = changeMapProvider.getPrompt();
        const cur =
          (picked ? reqs.find((r) => r.id === picked) : undefined) ??
          (anchorId !== undefined ? reqs.find((r) => r.editIds.includes(anchorId)) : undefined);
        const curFiles = cur ? cur.editIds.map((id) => byId.get(id)?.file).filter((f): f is string => !!f) : [];
        promptPos = {
          i: cur ? reqs.indexOf(cur) + 1 : 0,
          n: reqs.length,
          id: cur ? cur.id : '',
          index: cur ? cur.index : 0,
          title: cur ? cur.title : '',
          files: new Set(curFiles).size,
          edits: cur ? cur.editIds.length : 0,
        };
      }
    }
    // Mirror the Diff/File/Folder/Prompt position into the Overview title-bar nav-bar counters (live).
    changeMapProvider.setNavPos({
      diff: activeHasPending ? { i: diffIdx + 1, n: inFile.length, time: diffTime } : null,
      file: files.length ? { i: fileIdx >= 0 ? fileIdx + 1 : 0, n: files.length, name: fileName, edits: inFile.length } : null,
      folder: folders.length ? { i: folderIdx >= 0 ? folderIdx + 1 : 0, n: folders.length, name: folderIdx >= 0 ? curFolder || '(root)' : '', files: folderFiles, edits: inFolder.length } : null,
      prompt: promptPos,
    });

    // Session-tier buttons show whenever anything is pending; active-file-tier only inside a changed file.
    for (const b of sessionBtns) pending ? b.show() : b.hide();
    for (const b of activeFileBtns) activeHasPending ? b.show() : b.hide();
    void vscode.commands.executeCommand('setContext', 'claudeObservatory.hasPending', pending > 0);
    syncActiveFileContext();

    // The floating review bar (or, per `editorReviewSurface`, the bubble): park it on the edit THIS file's
    // review is currently about, and close it when the file has nothing left to review. Hung off
    // updateStatusItem because that is the one function every path that can change the answer already
    // calls — store changes, tab switches, every nav-bar step — so the bar cannot drift from the counters
    // beside it. `syncSurface` is a no-op when it is already in the right place, which is the common case.
    //
    // The target is the same rule JetBrains' ReviewSelection.currentEditIn uses: the review cursor when it
    // is parked in this file (so the bar agrees with ⌥⌘N, with the bar's own ‹/›, and with an auto-advance
    // that just landed), else the file's oldest pending edit. `inFile` above is already that file's
    // pending edits, so this costs no extra scan.
    const barTarget =
      !activeHasPending
        ? undefined
        : reviewCursorId !== undefined && inFile.some((r) => r.id === reviewCursorId)
          ? reviewCursorId
          : inFile[0].id;
    void editPeek.syncSurface(barTarget).catch(() => {
      /* the active document went away mid-refresh (deleted, or a demo folder reaped) — the next refresh
         re-tries against whatever is open then, and every other surface has already been updated. */
    });
  };
  // The per-file surfaces (editor tab-bar / editor banner) light up only when the ACTIVE file has a
  // pending edit — its own context key, refreshed on store changes and on tab switches.
  const syncActiveFileContext = () => {
    const s = currentSession();
    const file = activeEditorFile();
    // Through `pendingByFile`, not the raw log: a file whose only pending records sit in a cancelled
    // chain shows no rows, no gutter mark and an empty Diff counter — but this key lit the whole
    // per-file toolbar for it, and its Prev/Next/Keep/Undo verbs then returned silently because the
    // nav cursor had nothing to point at. An enabled control that does nothing is the worst of both.
    const has = Boolean(s && file && (pendingByFile(s).get(file) ?? []).length > 0);
    void vscode.commands.executeCommand('setContext', 'claudeObservatory.activeFileHasPending', has);
  };
  updateStatusItem(); // visible from activation, not just after the first store event
  context.subscriptions.push(...navCluster);

  // "Review this …" scope (cascaded edits): when set, the review loop walks only these edits — one
  // one PROMPT's, in capture order across files — until that scope is fully resolved.
  // Both axes narrow the same loop, so they share one cursor scope: entering either replaces the other.
  let reviewScopeIds: number[] | null = null;

  /**
   * Pick the previous (dir -1) or next (dir +1) pending edit relative to the review cursor, park the
   * cursor on it, and return it — WITHOUT opening anything.
   *
   * Separated from `reviewStep` because three surfaces now need the same choice with different follow-up:
   * the ⌥⌘N/⌥⌘P loop opens it, the pinned review bubble re-shows itself on it, and auto-advance reveals
   * it after a resolve. Reimplementing this per caller is how the three cursors drifted apart before
   * (see the comment on `openFileAtEdit`), so there is exactly one copy.
   *
   * `fromId` overrides the parked cursor — a resolve knows which edit it just settled, which is a better
   * anchor than wherever the cursor happens to sit.
   */
  const pickNextPending = (dir: 1 | -1, fromId?: number): core.EditRecord | undefined => {
    const s = currentSession();
    // DISPLAY units, not raw records — the walk visits one stop per review decision, exactly what
    // the terminal's rows and the JetBrains stepPendingEdit walk. Stepping the raw log visited every
    // member of every collapsed unit individually (3,001 stops where the surfaces show 151).
    // A cancelled chain is not a stop: the loop would park on an empty diff with nothing to decide.
    const skip = s ? core.cancelledMemberIds(s, 'pending') : new Set<number>();
    let pending = s
      ? core.reviewEdits(s).filter((r) => r.status === 'pending' && !skip.has(r.id)).sort((a, b) => a.id - b.id)
      : [];
    if (reviewScopeIds) {
      const inScope = new Set(reviewScopeIds);
      const scoped = pending.filter((r) => inScope.has(r.id));
      if (scoped.length) pending = scoped;
      else reviewScopeIds = null; // scope fully reviewed → fall back to the whole session
    }
    if (pending.length === 0) {
      reviewCursorId = undefined;
      return undefined;
    }
    const cursor = fromId ?? reviewCursorId;
    const idx = cursor === undefined ? -1 : pending.findIndex((r) => r.id === cursor);
    let next: core.EditRecord;
    if (idx >= 0) {
      next = pending[(idx + dir + pending.length) % pending.length]; // step ±1, wrapping at the ends
    } else if (cursor === undefined) {
      next = dir === 1 ? pending[0] : pending[pending.length - 1]; // first review: oldest (→) / newest (←)
    } else {
      // cursor's edit was resolved — resume just past it in the step direction
      next =
        dir === 1
          ? pending.find((r) => r.id > cursor) ?? pending[0]
          : [...pending].reverse().find((r) => r.id < cursor) ?? pending[pending.length - 1];
    }
    reviewCursorId = next.id;
    return next;
  };

  // Step to the previous (dir -1) or next (dir +1) pending edit and open it, advancing the cursor.
  const reviewStep = async (dir: 1 | -1) => {
    const next = pickNextPending(dir);
    if (!next) {
      vscode.window.setStatusBarMessage('OAK: no pending edits to review 🎉', 3000);
      return;
    }
    await openFileAtEdit({ kind: 'edit', rec: next });
  };

  /**
   * After a SINGLE edit is kept or reverted, carry the reader to the next one still awaiting review —
   * crossing into another file when that is where it is.
   *
   * Gated on the edit having actually left `pending`: a dirty-buffer refusal and a cancelled conflict
   * both leave it pending, and jumping away from an edit the user did NOT resolve would lose their place
   * for no reason. Bulk operations, `redo`, and the review bubble are deliberately excluded — a bulk op
   * has no single "next", and the bubble owns its own follow behaviour when pinned.
   */
  const advanceAfterResolve = async (session: string, id: number): Promise<void> => {
    if (!vscode.workspace.getConfiguration('claudeObservatory').get<boolean>('revealNextOnResolve', true)) return;
    if (core.findRecord(session, id)?.status === 'pending') return;
    const next = pickNextPending(1, id);
    if (next) await openFileAtEdit({ kind: 'edit', rec: next });
  };

  // The review bubble is a module-level class but the loop is closure-scoped, so its two hooks are
  // injected here: one lets a pinned bubble carry itself to the next edit, the other keeps the keyboard
  // loop and the Prompt axis anchored wherever the bubble currently is.
  editPeek.pickNext = (fromId: number) => pickNextPending(1, fromId);
  editPeek.onShown = (id: number) => {
    reviewCursorId = id;
  };
  // Drives which of pin/unpin the bubble's toolbar offers.
  const syncPeekPinned = () =>
    void vscode.commands.executeCommand(
      'setContext',
      'claudeObservatory.peekPinned',
      vscode.workspace.getConfiguration('claudeObservatory').get<boolean>('pinnedPeek', false)
    );
  syncPeekPinned();

  // The review loop scoped to ONE of the user's asks: open the first pending edit that ask produced and
  // walk only its edits, in the order Claude made them, across files. "Show me everything from when I
  // asked for X" — the one review scope no other axis can express.
  const reviewPrompt = async (promptId: string) => {
    const s = currentSession();
    if (!s) return;
    const root = workspaceRoot() ?? process.cwd();
    const req = core.promptWindows(root, s).find((r) => r.id === promptId || String(r.index) === promptId);
    const pendingIds = core
      .promptEditIds(root, s, promptId)
      .filter((id) => core.findRecord(s, id)?.status === 'pending');
    if (!pendingIds.length) {
      vscode.window.setStatusBarMessage('OAK: no pending edits from this prompt', 3000);
      return;
    }
    // Reviewing an ask picks it: the Prompts list and the Overview both scope to the ask being walked.
    if (req) pickPrompt(req.id);
    reviewScopeIds = pendingIds;
    reviewCursorId = pendingIds[0];
    const rec = core.findRecord(s, pendingIds[0]);
    if (rec) await openFileAtEdit({ kind: 'edit', rec });
    vscode.window.setStatusBarMessage(
      `OAK: reviewing prompt ${req ? `#${req.index} “${req.title}”` : promptId} — ${pendingIds.length} edit(s); ⌥⌘N steps through them`,
      4000
    );
  };

  // Prompt axis: step BETWEEN the user's own asks — open the previous/next prompt's first pending edit
  // and flash "Prompt i/n · #k — <the ask>" (wrapping, anchored on the current edit), over the one list
  // a person recognizes: their own turns, in the order they took them. The flash names the ask's OWN
  // number (#k) as well as its place in the review queue.
  const navPrompt = async (dir: 1 | -1) => {
    const s = currentSession();
    if (!s) return;
    const reqs = pendingPrompts(s);
    if (!reqs.length) {
      vscode.window.setStatusBarMessage('OAK: no prompts left to review', 2500);
      return;
    }
    const byId = new Map(cachedLog(s).map((r) => [r.id, r]));
    const anchor = navEditId ?? reviewCursorId;
    // Same order as the counter: picked first, anchor fallback — and the step BECOMES the pick below,
    // or the counter would snap back to the old prompt on the next repaint while the pick-scoped panes
    // disagreed with the axis that just moved.
    const picked = changeMapProvider.getPrompt();
    let curIdx = picked ? reqs.findIndex((r) => r.id === picked) : -1;
    if (curIdx < 0 && anchor !== undefined) curIdx = reqs.findIndex((r) => r.editIds.includes(anchor));
    const target = reqs[((curIdx < 0 ? (dir === 1 ? -1 : 0) : curIdx) + dir + reqs.length) % reqs.length];
    // Both surfaces move: the Overview rescopes through its existing 'prompt' message, and the Prompts
    // list highlights the same ask — stepping the axis without it left the two naming different asks.
    pickPrompt(target.id);
    const first = target.editIds.find((id) => byId.get(id)?.status === 'pending');
    if (first === undefined) return;
    navEditId = first;
    reviewCursorId = first;
    const rec = core.findRecord(s, first);
    if (rec) await openFileAtEdit({ kind: 'edit', rec });
    vscode.window.setStatusBarMessage(
      `OAK: Prompt ${reqs.indexOf(target) + 1}/${reqs.length} · #${target.index} — ${target.title}`,
      3500
    );
    updateStatusItem();
  };

  /** The prompt the CURRENT edit came from — the anchor every nav-bar Prompt action resolves against.
   *  Returns null when nothing is open to anchor on. */
  const currentPrompt = (): core.PromptWindow | null => {
    const s = currentSession();
    const anchor = navEditId ?? reviewCursorId;
    if (!s || anchor === undefined) return null;
    return core.promptWindows(workspaceRoot() ?? process.cwd(), s).find((r) => r.editIds.includes(anchor)) ?? null;
  };

  /**
   * The ask a PROMPT-SCOPED action should target: the one the reader picked, else the one owning the edit
   * the nav bar is parked on.
   *
   * `currentPrompt` above resolves only from the edit anchor, and `navEditId` is re-derived from the ACTIVE
   * FILE every tick — so with ask #5 picked and a file open whose edits belong to ask #2, the counter beside
   * these buttons reads #5 while the anchor says #2. For Accept and Reject that is a misaddressed action;
   * for Rewind, which takes the picked ask AND EVERY ASK AFTER IT, resolving to an earlier one silently
   * widens the blast radius past what the reader asked for. The picked ask therefore wins.
   *
   * That agrees with the Prompt-axis counter, `navPrompt` and the JetBrains nav bar for any ask that still
   * has pending edits, which is every ask those three can be ON: all of them walk `pendingPrompts`, and a
   * pick with nothing left to review falls THROUGH to the edit anchor there. This does not — it resolves
   * the pick against every prompt window in the session — so for a FULLY REVIEWED pick the two editors
   * diverge: JetBrains' Rewind shares `currentPrompt` with its axis, so it retargets to the anchor's
   * pending ask (and is disabled outright when no ask has anything pending), while this one rewinds from
   * the reviewed ask's boundary, taking every pending edit after it.
   *
   * That difference is deliberate and it is on Rewind's side: rewinding is the verb that reverts work
   * already accepted, so "this ask has nothing pending" is not a reason to aim somewhere else — and
   * falling through would move the boundary to whichever ask the cursor's file happens to belong to,
   * silently reverting a different set than the one picked. The confirmation modal names the ask this
   * resolved to (`rewindFromPrompt`), which is what keeps the wider scope honest.
   */
  const targetPrompt = (): core.PromptWindow | null => {
    const s = currentSession();
    const picked = changeMapProvider.getPrompt();
    if (s && picked) {
      const hit = core.promptWindows(workspaceRoot() ?? process.cwd(), s).find((r) => r.id === picked);
      if (hit) return hit;
    }
    return currentPrompt();
  };

  /** Newest OTHER session with tracked edits — the switch target when this session is empty.
   *  listSessions() is store-GLOBAL, so intersect with THIS workspace's transcript ids or the
   *  empty state would advertise (and one-click-pin) an unrelated repo's session. */
  const previousSessionWithEdits = (session: string | undefined) => {
    const root = workspaceRoot();
    if (!root) return undefined;
    let here: Set<string>;
    try {
      here = new Set(
        fs
          .readdirSync(core.projectDir(root))
          .filter((n) => n.endsWith('.jsonl'))
          .map((n) => n.slice(0, -'.jsonl'.length))
      );
    } catch {
      return undefined; // no project dir ⇒ no prior sessions for this workspace
    }
    return core
      .listSessions()
      .filter((s) => s.id !== session && s.edits > 0 && here.has(s.id))
      .sort((a, b) => b.lastMs - a.lastMs)[0];
  };

  // The empty state must never claim the hooks are broken when they're not: three mutually
  // exclusive viewsWelcome variants keyed on these contexts (hooks missing / fresh session with
  // prior work / fresh workspace), plus a dynamic message naming the actual switch target.
  const updateEmptyStateContext = () => {
    const session = currentSession();
    const log = session ? cachedLog(session) : [];
    const prior = log.length === 0 ? previousSessionWithEdits(session) : undefined;
    void vscode.commands.executeCommand('setContext', 'claudeObservatory.hooksInstalled', core.hooksInstalled());
    void vscode.commands.executeCommand('setContext', 'claudeObservatory.priorSessionWithEdits', !!prior);
    // Offer Exit Demo whenever a demo EXISTS for this folder — not merely while one is the session
    // being reviewed. Session resolution follows the newest transcript, so one real Claude turn after a
    // demo (or a window that crashed mid-demo) would otherwise take the only way out away at exactly
    // the moment it is needed, leaving the folder and two sessions behind with nothing offering to
    // remove them. Demo mode holds no persisted state, so the disk is the honest signal.
    const root = workspaceRoot();
    let demoOnDisk = !!demoSession || (!!session && core.isDemoSession(session));
    if (!demoOnDisk && root) {
      try {
        demoOnDisk = core.demoSessionsFor({ cwd: root }).length > 0;
      } catch {
        /* unreadable project dir — fall back to what resolution says */
      }
    }
    void vscode.commands.executeCommand('setContext', 'claudeObservatory.demoPresent', demoOnDisk);
  };
  updateEmptyStateContext(); // correct welcome variant from activation, matching updateStatusItem above

  // `force` is set only by the explicit Refresh command: it bypasses the Overview's coalescing throttle
  // and re-fetches the followed feed even if it had settled, so a pane stuck on a failed spawn (an older
  // CLI on PATH, since upgraded) is recoverable without reloading the window.
  /** The session the last refresh ran for — see the cache drop in refreshAll. `undefined` is a real
   *  value here (no session resolves yet), so it starts as a sentinel no session id can equal. */
  let lastRefreshedSession: string | undefined | symbol = FIRST_REFRESH;
  const refreshAll = (force = false) => {
    // Demo sessions leave no residue (0.8.0): once every demo edit is reviewed (e.g. Accept All), the
    // resolved records are dropped so the panels empty out. No-op for real sessions; the resulting
    // store change re-enters here once and then no-ops (the log is empty).
    const s = currentSession();
    // Switching sessions drops core's per-process file caches — the SAME rule `oak warm`
    // applies between sessions in the CLI. This host is the one long-lived core consumer: the shared
    // raw-text layer beneath the derivation memos is byte-budgeted, so it can never run away, but
    // without this the budget stays FULL of the session you just left while you read the next one.
    if (s !== lastRefreshedSession) {
      lastRefreshedSession = s;
      core.clearFsCache();
    }
    if (s) core.autoClearDemo(s);
    // AFTER the auto-clear: a fully reviewed demo has just dropped its records, and that empty log is
    // the verdict a wait step is looking for.
    checkTourWatch();
    updateEmptyStateContext();
    // The two feeds the Timeline window renders. Dropped HERE as well as in that window's own refresh:
    // this is the one place that knows the store changed, and the Actions cycle carries time-derived
    // "active" flags that must never survive a change. Both drops are free and idempotent.
    insightsProvider.refresh();
    actionsProvider.refresh();
    fileHistoryProvider.refresh();
    statsProvider.refresh();
    promptsProvider.refresh(force);
    reviewProvider.refresh();
    changeMapProvider.refresh(force);
    statusDecorations.refresh();
    updateStatusItem();
    refreshInline();
  };
  forceRefreshAll = () => refreshAll(true); // the bulk verbs run outside this closure
  // FORCED, like every other mutation path (withSession/withBulkScope force too): the Overview drops
  // unforced refreshes while a spawn is in flight, so an unforced tick here could leave it painting
  // pre-mutation counts with nothing to correct them.
  reviewProvider.onMutate = () => refreshAll(true);


  // --- nav bar handlers (drive the status-bar review toolbar built above) ---
  // The pending edit the Diff axis is parked on, resolved to a live (still-pending) record.
  const navCurrentRec = (): { s: string; rec: core.EditRecord } | undefined => {
    const s = currentSession();
    if (!s || navEditId === undefined) return undefined;
    const rec = core.findRecord(s, navEditId);
    return rec && rec.status === 'pending' ? { s, rec } : undefined;
  };
  // Diff axis: step the OPEN file's pending edits (wrapping) and reveal the target in the editor.
  const navDiff = async (dir: 1 | -1) => {
    const s = currentSession();
    const file = activeEditorFile();
    if (!s || !file) return;
    const list = pendingEditsInFile(s, file);
    if (!list.length) return;
    const idx = navEditId !== undefined ? list.findIndex((r) => r.id === navEditId) : -1;
    const target = list[((idx < 0 ? 0 : idx) + dir + list.length) % list.length];
    navEditId = target.id;
    await openFileAtEdit({ kind: 'edit', rec: target });
    updateStatusItem();
  };
  // File axis: step across files with pending edits (wrapping), opening the target's first pending edit.
  const navFile = async (dir: 1 | -1) => {
    const s = currentSession();
    if (!s) return;
    const files = pendingFilesOf(s);
    if (!files.length) return;
    const active = activeEditorFile();
    const idx = active ? files.indexOf(active) : -1;
    const target = files[((idx < 0 ? 0 : idx) + dir + files.length) % files.length];
    const first = pendingEditsInFile(s, target)[0];
    if (!first) return;
    navEditId = first.id;
    await openFileAtEdit({ kind: 'edit', rec: first });
    updateStatusItem();
  };
  // Folder axis: step BETWEEN changed folders (relative parent dirs), opening the target's first pending edit.
  const navFolder = async (dir: 1 | -1) => {
    const s = currentSession();
    if (!s) return;
    const folders = pendingFoldersOf(s);
    if (!folders.length) return;
    const active = activeEditorFile();
    const idx = active ? folders.indexOf(folderLabelOf(active)) : -1;
    const target = folders[((idx < 0 ? 0 : idx) + dir + folders.length) % folders.length];
    const first = pendingEditsInFolder(s, target)[0];
    if (!first) return;
    navEditId = first.id;
    await openFileAtEdit({ kind: 'edit', rec: first });
    updateStatusItem();
  };
  // Jump the Folder axis straight to a named folder (a strip-tile click) — opens its first pending edit.
  const revealFolder = async (folder: string) => {
    const s = currentSession();
    if (!s) return;
    const first = pendingEditsInFolder(s, folder)[0];
    if (!first) return;
    navEditId = first.id;
    await openFileAtEdit({ kind: 'edit', rec: first });
    updateStatusItem();
  };
  context.subscriptions.push(
    fileHistoryView,
    statusItem,
    inlineDecoration,
    deletionGhostDecoration,
    annotationDecoration,
    heatmapDecoration,
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, inlineLens),
    vscode.window.registerWebviewViewProvider('claudeObservatory.stats', statsProvider),
    vscode.window.registerWebviewViewProvider('claudeObservatory.timeline', promptsProvider),
    vscode.window.registerWebviewViewProvider('claudeObservatory.reviewList', reviewProvider),
    vscode.window.registerWebviewViewProvider('claudeObservatory.changemap', changeMapProvider),
    vscode.window.registerFileDecorationProvider(statusDecorations),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new BlobContentProvider()),
    diffBars,
    reviewComments,
    vscode.window.onDidChangeVisibleTextEditors(() => {
      diffBars.sync();
      reviewComments.sync();
    }),
    vscode.commands.registerCommand('claudeObservatory.addReviewComment', (reply: vscode.CommentReply) => reviewComments.add(reply)),
    vscode.commands.registerCommand('claudeObservatory.sendReviewComments', async () => {
      const session = currentSession();
      if (!session) return;
      const cwd = workspaceRoot() ?? process.cwd();
      const p = core.composeCommentPrompt(session, { cwd });
      if (!p) {
        vscode.window.showInformationMessage('OAK: no review comments to send — add some with the “+” on a line in an edit diff.');
        return;
      }
      if (await deliverChatPrompt(p.text, `${p.ids.length} review comment(s)`, session)) core.markCommentsSent(session, p.ids);
      reviewComments.sync();
    }),
    vscode.commands.registerCommand('claudeObservatory.quoteLastReply', async () => {
      const session = currentSession();
      if (!session) return;
      const q = core.quoteAgentOutput(session);
      if (!q) {
        vscode.window.showInformationMessage('OAK: the agent has not replied yet in this session — nothing to quote.');
        return;
      }
      const note = await vscode.window.showInputBox({ title: "Add a note to the quoted reply", prompt: "The quote stays on the clipboard if you cancel." });
      await vscode.env.clipboard.writeText(q);
      if (note !== undefined) await deliverChatPrompt(q + note, "The quoted reply", session);
    }),
    vscode.workspace.registerTextDocumentContentProvider(MD_SCHEME, obsMd),
    editPeek
  );

  // The context bar drifts as the session grows; refresh it on a slow tick (unref'd so it never
  // holds the process open in tests). Tree/inline refresh is event-driven via the log watcher below.
  const statusTimer = setInterval(() => {
    statsProvider.refresh();
  }, 45000);
  statusTimer.unref?.();
  context.subscriptions.push({ dispose: () => clearInterval(statusTimer) });

  // Refresh on panel-visible / window-focus (covers new sessions the watcher may miss), on active
  // editor change, and on buffer edits (debounced) so decorations track the live buffer.
  for (const v of [fileHistoryView]) {
    v.onDidChangeVisibility((e) => e.visible && refreshAll());
  }
  let debounce: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((s) => s.focused && refreshAll()),
    vscode.window.onDidChangeActiveTextEditor(() => {
      refreshInline();
      updateStatusItem(); // recompute nav-bar counters + active-file context for the newly-active file
      fileHistoryProvider.refresh(); // re-query for the newly-active file
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!vscode.window.visibleTextEditors.some((ed) => ed.document === e.document)) return;
      if (debounce) clearTimeout(debounce);
      // Adaptive: a file whose last locate was expensive (long edit chain × big buffer — measured
      // ~353ms on a 46-edit chain in 152KB) coalesces at 1.2s instead of stalling every 250ms burst.
      // Cheap files keep the tight cadence; the cost map is fed by cachedPlacements itself.
      const cost = placementCostMs.get(canonFsPath(e.document.uri)) ?? 0;
      debounce = setTimeout(refreshInline, cost > 150 ? 1200 : 250);
    })
  );

  const withSession = (fn: (session: string) => void | Promise<void>) => async () => {
    const s = currentSession();
    if (!s) {
      vscode.window.showWarningMessage('OAK: no active Claude Code session for this workspace.');
      return;
    }
    await fn(s);
    // force: this just changed the counts the panels are showing. An unforced refresh is dropped by the
    // Overview's 3s coalescing window — and the spawn already in flight was started BEFORE the mutation,
    // so it repaints pre-change numbers and nothing else fires afterwards to correct them.
    refreshAll(true);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeObservatory.refresh', () => {
      // A user Refresh applies a newly-added `.observatoryignore`. Adding the file fires
      // no capture hook, so the sweep that drops now-ignored records (capture.ts, the WRITE path) never
      // runs, and Refresh — a pure read — left them in the store. This command's callers are ALL user
      // actions (the Refresh button, install-hooks, and the keep/undo/resolve/clear mutations); the
      // auto-pollers call `refreshAll` directly and bypass this, which is exactly the invariant that keeps
      // the sweep off a read/poll path. `dropIgnored` is self-gating — a no-op when nothing matches.
      const s = currentSession();
      if (s) { try { core.dropIgnored(s); } catch { /* a torn store still refreshes */ } }
      refreshAll(true);
    }),
    // Step backward / forward through pending edits (⏮ prev · ⏭ next), keyboard-friendly.
    vscode.commands.registerCommand('claudeObservatory.reviewNext', () => reviewStep(1)),
    vscode.commands.registerCommand('claudeObservatory.reviewPrev', () => reviewStep(-1)),
    // Stats navbar: jump to the FIRST (oldest) pending edit, and filter edits from the Stats search box.
    vscode.commands.registerCommand('claudeObservatory.reviewFirst', async () => {
      const s = currentSession();
      // Same set the review loop walks (`pickNextPending`) — off the raw log these two entry points
      // answered differently for one session: "review first" opened a cancelled chain that "review
      // next" correctly skipped.
      const skipFirst = s ? core.cancelledMemberIds(s, 'pending') : new Set<number>();
      const pending = s
        ? cachedLog(s).filter((r) => r.status === 'pending' && !skipFirst.has(r.id)).sort((a, b) => a.id - b.id)
        : [];
      if (!pending.length) {
        vscode.window.setStatusBarMessage('OAK: no pending edits to review 🎉', 3000);
        return;
      }
      reviewCursorId = pending[0].id; // so a subsequent review-next continues from here
      await openFileAtEdit({ kind: 'edit', rec: pending[0] });
    }),
    // Nav bar: Diff axis (within the open file), File axis (across pending files), and per-edit actions.
    vscode.commands.registerCommand('claudeObservatory.navDiffPrev', () => navDiff(-1)),
    vscode.commands.registerCommand('claudeObservatory.navDiffNext', () => navDiff(1)),
    // Prompt axis — the nav bar's LAST group: step between the user's own asks, and act on everything
    // ONE ask produced. Each action anchors on the current edit's prompt and routes to the id-scoped
    // ops (core resolves the id to the edit set).
    vscode.commands.registerCommand('claudeObservatory.navPromptPrev', () => navPrompt(-1)),
    vscode.commands.registerCommand('claudeObservatory.navPromptNext', () => navPrompt(1)),
    vscode.commands.registerCommand('claudeObservatory.acceptCurrentPrompt', () => {
      const r = currentPrompt();
      if (r) void vscode.commands.executeCommand('claudeObservatory.promptKeep', r.id);
      else vscode.window.setStatusBarMessage('OAK: open an agent edit to accept its prompt', 2500);
    }),
    vscode.commands.registerCommand('claudeObservatory.rejectCurrentPrompt', () => {
      const r = currentPrompt();
      if (r) void vscode.commands.executeCommand('claudeObservatory.promptUndo', r.id);
      else vscode.window.setStatusBarMessage('OAK: open an agent edit to reject its prompt', 2500);
    }),
    // Rewind lives on the Prompt AXIS, not on a Prompts row: both editors' prompt lists deliberately
    // carry no review actions ("the window's only job is picking the ask"), and this is a review action —
    // the most destructive one on the axis.
    vscode.commands.registerCommand('claudeObservatory.rewindCurrentPrompt', () => {
      // targetPrompt, not currentPrompt: rewinding the ask under the CURSOR when the reader has picked a
      // different one would revert from an earlier boundary than they chose — strictly more than they asked
      // for. See targetPrompt for why the two can disagree.
      const r = targetPrompt();
      // Select what is about to be rewound, so the list shows the boundary the verb resolved to rather
      // than leaving the reader to infer it from the counter.
      if (r) {
        pickPrompt(r.id);
        void vscode.commands.executeCommand('claudeObservatory.promptRewind', r.id);
      } else vscode.window.setStatusBarMessage('OAK: pick an ask, or open an agent edit, to rewind to it', 2500);
    }),
    vscode.commands.registerCommand('claudeObservatory.reviewCurrentPrompt', () => {
      const r = currentPrompt();
      if (r) void reviewPrompt(r.id);
      else vscode.window.setStatusBarMessage('OAK: open an agent edit to review its prompt', 2500);
    }),
    // …and the id-scoped ops themselves (the Prompts window's row buttons drive these directly).
    // Clearing the ask scope goes through the window that OWNS the selection, so both it and the
    // Overview end up agreeing — whichever of the two the user clicked to clear it.
    vscode.commands.registerCommand('claudeObservatory.clearPromptScope', () => {
      promptsProvider.clearSelection();
    }),
    vscode.commands.registerCommand('claudeObservatory.promptKeep', (promptId: string) => withSession((s) => keepPrompt(s, promptId))()),
    vscode.commands.registerCommand('claudeObservatory.promptUndo', (promptId: string) => withSession((s) => undoPrompt(s, promptId))()),
    vscode.commands.registerCommand('claudeObservatory.promptRewind', (promptId: string) => withSession((s) => rewindFromPrompt(s, promptId))()),
    vscode.commands.registerCommand('claudeObservatory.promptClear', (promptId: string) => withSession((s) => clearPrompt(s, promptId))()),
    vscode.commands.registerCommand('claudeObservatory.reviewPrompt', (promptId: string) => reviewPrompt(promptId)),
    vscode.commands.registerCommand('claudeObservatory.navFilePrev', () => navFile(-1)),
    vscode.commands.registerCommand('claudeObservatory.navFileNext', () => navFile(1)),
    // Folder axis — step between changed folders; a strip-tile click reveals a folder; act on the whole bucket.
    vscode.commands.registerCommand('claudeObservatory.navFolderPrev', () => navFolder(-1)),
    vscode.commands.registerCommand('claudeObservatory.navFolderNext', () => navFolder(1)),
    vscode.commands.registerCommand('claudeObservatory.revealFolder', (folder: string) => revealFolder(folder)),
    vscode.commands.registerCommand('claudeObservatory.acceptCurrentFolder', () => {
      const s = currentSession();
      const file = activeEditorFile();
      if (!s || !file) {
        vscode.window.setStatusBarMessage('OAK: open a file with edits to accept its folder', 2500);
        return;
      }
      keepEditsInFolder(s, folderLabelOf(file));
    }),
    vscode.commands.registerCommand('claudeObservatory.rejectCurrentFolder', async () => {
      const s = currentSession();
      const file = activeEditorFile();
      if (!s || !file) {
        vscode.window.setStatusBarMessage('OAK: open a file with edits to reject its folder', 2500);
        return;
      }
      await undoEditsInFolder(s, folderLabelOf(file));
    }),
    vscode.commands.registerCommand('claudeObservatory.navViewDiff', () => {
      const cur = navCurrentRec();
      if (cur) void editPeek.show(cur.rec.id); // open the floating review bubble at the current edit
    }),
    // Nav-bar "View diff" — open the CURRENT edit as a real side-by-side diff editor (before ⟶ after),
    // not the floating bubble (that's what the status-bar Diff counter uses).
    vscode.commands.registerCommand('claudeObservatory.viewCurrentDiff', () => {
      const cur = navCurrentRec();
      if (cur) void openDiff({ kind: 'edit', rec: cur.rec });
      else vscode.window.setStatusBarMessage('OAK: open an agent edit to view its diff', 2500);
    }),
    // Zero-token chat handoff about the CURRENT edit (Diff-axis Chat button) — copies its context, opens your agent.
    vscode.commands.registerCommand('claudeObservatory.chatCurrentEdit', () => {
      const cur = navCurrentRec();
      if (!cur) {
        vscode.window.setStatusBarMessage('OAK: open an agent edit to chat about it', 2500);
        return;
      }
      void vscode.commands.executeCommand('claudeObservatory.chatAction', { editId: cur.rec.id });
    }),
    vscode.commands.registerCommand('claudeObservatory.navKeep', async () => {
      const cur = navCurrentRec();
      if (!cur) return;
      core.keepGroup(cur.s, cur.rec.id);
      refreshAll();
      await advanceAfterResolve(cur.s, cur.rec.id);
    }),
    vscode.commands.registerCommand('claudeObservatory.navUndo', async () => {
      const cur = navCurrentRec();
      if (!cur) return;
      await undoOne(cur.s, cur.rec.id);
      refreshAll();
      await advanceAfterResolve(cur.s, cur.rec.id);
    }),
    // Revision navigation: step the active file's edit history in a current-vs-revision diff.
    vscode.commands.registerCommand('claudeObservatory.diffPrevRevision', () => diffRevisionStep(-1)),
    vscode.commands.registerCommand('claudeObservatory.diffNextRevision', () => diffRevisionStep(1)),
    // Export a shareable review summary (kept/reverted per file) as markdown in a new editor tab.
    vscode.commands.registerCommand('claudeObservatory.exportSummary', async () => {
      const s = currentSession();
      if (!s) {
        vscode.window.showWarningMessage('OAK: no active Claude Code session to summarize.');
        return;
      }
      const md = core.reviewSummaryMarkdown(core.reviewSummary(s));
      const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
      await vscode.window.showTextDocument(doc);
    }),
    // The FULL session trace — everything the observatory recorded, as one JSON document
    // (core.buildSessionTrace; the CLI `export` verb and JetBrains produce the identical shape).
    vscode.commands.registerCommand('claudeObservatory.exportTrace', async () => {
      const s = currentSession();
      if (!s) {
        vscode.window.showWarningMessage('OAK: no active Claude Code session to export.');
        return;
      }
      const cwd = workspaceRoot() ?? process.cwd();
      const trace = core.buildSessionTrace(cwd, s, {
        root: cwd,
        toolVersion: String(context.extension?.packageJSON?.version ?? ''),
      });
      const doc = await vscode.workspace.openTextDocument({
        content: JSON.stringify(trace, null, 2) + '\n',
        language: 'json',
      });
      await vscode.window.showTextDocument(doc);
      if (trace.errors.length)
        vscode.window.showWarningMessage(`OAK: trace sections that failed to build: ${trace.errors.join(', ')}`);
    }),
    // The Overview's Export button: one button, both exports (the expansion issue asked for).
    vscode.commands.registerCommand('claudeObservatory.exportMenu', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'Review summary', description: 'kept / reverted per file — markdown', cmd: 'claudeObservatory.exportSummary' },
          { label: 'Full session trace', description: 'everything recorded — every edit with its diff, prompts, actions, tasks, subagents, egress, observations, usage — JSON', cmd: 'claudeObservatory.exportTrace' },
        ],
        { title: 'Export', placeHolder: 'What to export' }
      );
      if (pick) void vscode.commands.executeCommand(pick.cmd);
    }),
    // Filter menu: narrow by file type and extension. The Search command owns the query text (which
    // reads as a regex automatically when it carries regex syntax — there is no mode to pick). This
    // is the COMPACT picker the native Traces title-bar button opens; the Overview panel has its own
    // inline dropdown in the webview toolbar and does not route here.
    vscode.commands.registerCommand('claudeObservatory.filterMenu', async () => {
      const cwd = workspaceRoot() ?? process.cwd();
      const s = currentSession();
      // The types and extensions actually present in this session — so the menu offers only what can match.
      const files = s ? (core.overviewChangeMap(cwd, s, { root: cwd }).files ?? []) : [];
      const catsPresent = core.FILE_CATEGORIES.filter((c) => files.some((f) => f.category === c));
      const extsPresent = [...new Set(files.map((f) => f.ext).filter(Boolean))].sort();
      type FItem = vscode.QuickPickItem & { pk?: 'cat' | 'ext'; val?: string };
      const sep = (label: string): FItem => ({ label, kind: vscode.QuickPickItemKind.Separator });
      const menu: FItem[] = [];
      if (catsPresent.length) {
        menu.push(sep('File type'));
        for (const c of catsPresent) menu.push({ label: core.FILE_CATEGORY_LABEL[c], picked: filterCats.includes(c), pk: 'cat', val: c });
      }
      if (extsPresent.length) {
        menu.push(sep('Extension'));
        for (const e of extsPresent) menu.push({ label: '.' + e, picked: filterExts.includes(e), pk: 'ext', val: e });
      }
      const picked = await vscode.window.showQuickPick(menu, {
        title: 'Filter edits',
        placeHolder: 'Narrow by file type and extension — the Search box sets the text (regex is automatic)',
        canPickMany: true,
      });
      if (!picked) return; // cancelled — leave the filter unchanged
      filterCats = picked.filter((p) => (p as FItem).pk === 'cat').map((p) => (p as FItem).val as core.FileCategory);
      filterExts = picked.filter((p) => (p as FItem).pk === 'ext').map((p) => (p as FItem).val as string);
      refreshAll();
    }),
    // Sort: cycle time ⇄ name (persisted through core prefs, shared with the terminal app).
    vscode.commands.registerCommand('claudeObservatory.cycleSort', () => {
      // Steps through all four orders — the palette / keyboard peer of the inline Sort dropdown.
      const keys = core.SORT_KEYS;
      const next: core.SortKey = keys[(keys.indexOf(currentSort()) + 1) % keys.length];
      try {
        const p = core.readPrefs();
        core.writePrefs({ ...p, sort: next });
      } catch {
        /* prefs unwritable — the order still applies for this session via the payload */
      }
      vscode.window.setStatusBarMessage(`OAK: sorted by ${core.SORT_LABEL[next]}`, 2500);
      refreshAll();
    }),
    // Internal setters for the Overview's inline search field + filter dropdown (not contributed to the
    // palette). They write the same module-level state the palette Search / Filter commands do, then
    // refresh both panels — the mechanism that keeps the two navbars showing one filter.
    vscode.commands.registerCommand('claudeObservatory.applyQuery', (q: unknown) => {
      editFilter = String(q ?? '');
      refreshAll();
    }),
    vscode.commands.registerCommand('claudeObservatory.applyFilterSpec', (spec: unknown) => {
      const s = (spec ?? {}) as { exts?: unknown; categories?: unknown };
      filterExts = Array.isArray(s.exts) ? s.exts.map((e) => String(e)) : [];
      filterCats = Array.isArray(s.categories)
        ? (s.categories as unknown[]).map((c) => String(c)).filter((c): c is core.FileCategory => (core.FILE_CATEGORIES as readonly string[]).includes(c))
        : [];
      refreshAll();
    }),
    // The inline Sort dropdown picks one of the four orders directly (the palette cycleSort still steps
    // through them). An unknown key is ignored rather than written, so a stale webview cannot corrupt prefs.
    vscode.commands.registerCommand('claudeObservatory.applySort', (key: unknown) => {
      const next = core.normalizeSort(String(key ?? ''));
      if (!next) return;
      try {
        const p = core.readPrefs();
        core.writePrefs({ ...p, sort: next });
      } catch {
        /* prefs unwritable — the order still applies for this session via the payload */
      }
      refreshAll();
    }),
    // Setup check: run `doctor` and open the diagnostics (hooks, PATH, config, session, status line) in a tab.
    vscode.commands.registerCommand('claudeObservatory.doctor', async () => {
      // ASYNC and bounded. Doctor times forwarding to every saved herdr machine (up to 30 s each), and
      // the synchronous spawn this was froze the whole extension host for as long as that took. Doctor
      // exits non-zero when a check fails but still prints its report, so stdout is kept either way.
      // Through the launcher: on Windows the CLI is a .cmd shim that only cmd.exe can run.
      const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'OAK: running the setup check…' }, () =>
        new Promise<{ stdout: string; timedOut: boolean }>((resolve) => {
          try {
            core.execFileTool(resolveObservatoryBin(), ['doctor', '--markdown'], { cwd: workspaceRoot(), timeout: DOCTOR_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
              (err, stdout) => resolve({ stdout: String(stdout || ''), timedOut: !!err?.killed }));
          } catch {
            resolve({ stdout: '', timedOut: false });
          }
        }));
      if (!res.stdout.trim()) {
        vscode.window.showErrorMessage(res.timedOut
          ? `OAK: the setup check did not finish within ${DOCTOR_TIMEOUT_MS / 60_000} minutes. A saved herdr machine that does not answer is the usual cause — run \`oak doctor\` in a terminal to see which check is waiting.`
          : 'OAK: could not run doctor — is the oak CLI installed?');
        return;
      }
      const doc = await vscode.workspace.openTextDocument({ content: res.stdout, language: 'markdown' });
      await vscode.window.showTextDocument(doc);
    }),
    // Reset scope: one exit from every narrowing — the Search filter and the
    // prompt scope together. The prompt scope is cleared through the window that OWNS the selection,
    // same as the Prompts panel's own clear; the Overview's folder filter is webview state and clears
    // at the click that sent this.
    vscode.commands.registerCommand('claudeObservatory.resetScope', () => {
      editFilter = '';
      filterExts = [];
      filterCats = [];
      void vscode.commands.executeCommand('claudeObservatory.clearPromptScope');
      refreshAll();
    }),
    // Search: filter the Review list by file path (and the Overview's ledger). Empty input clears it.
    vscode.commands.registerCommand('claudeObservatory.searchEdits', async () => {
      const q = await vscode.window.showInputBox({
        title: 'Search edits',
        prompt: 'Filter edits by file path — leave empty to clear',
        value: editFilter,
        placeHolder: 'e.g. src/api or User.ts',
      });
      if (q === undefined) return; // cancelled — leave the filter unchanged
      editFilter = q.trim();
      refreshAll();
    }),
    // --- demo mode (0.8.9) ---
    // Replay the scripted session LIVE, then take the guided tour. The replay runs IN-PROCESS (this
    // extension bundles core), so it works with the capture hooks uninstalled — which is what makes it
    // an honest first-run affordance in the empty state.
    // `startDemo` and `restartDemo` share this handler: a run RESETS the demo in core (a previous demo
    // for this folder is cleared before the replay), so starting again IS starting over. Two command
    // ids exist only so the title bar can say "Start" before one is running and "Restart" after.
    ...(() => {
      const runDemoCommand = async () => {
      if (demoReplaying) {
        void vscode.window.showInformationMessage('OAK: the demo is still replaying — cancel it from the progress notification first.');
        return;
      }
      const root = workspaceRoot();
      if (!root) {
        void vscode.window.showWarningMessage('OAK: open a folder first — the demo records against a workspace.');
        return;
      }
      await endTour(); // a restart mid-tour starts the tour over too
      let noRepo = false;
      try {
        noRepo = core.commonDir(root) === null;
      } catch {
        /* treat as a repo and let the Fleet step speak for itself */
      }
      // The replay is in-process, so it works with no CLI on PATH — but the Overview, Prompts and Stats
      // panels shell out for their data, and 16 of the tour's steps are about those three. Say so
      // BEFORE the tour walks a reader into panels that can only report a missing binary.
      // PROBE it, never stat it: resolveBin returns the bare name as its PATH fallback, and statting that
      // against the extension host's cwd is false for every perfectly good install outside its fixed
      // candidate list. Spawning is the only check that answers the question actually being asked.
      const probe = core.spawnToolSync(resolveObservatoryBin(), ['--version'], { encoding: 'utf8', timeout: 5000 });
      if (probe.error || probe.status !== 0) {
        const go = await vscode.window.showWarningMessage(
          'OAK: the oak CLI is not on PATH. The demo will replay and the sidebar will fill, but the Overview, Prompts and Stats panels read their data through the CLI and will stay empty.',
          'Replay anyway',
          'Cancel'
        );
        if (go !== 'Replay anyway') return;
      }
      let res: core.DemoResult;
      demoReplaying = true;
      try {
        res = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'OAK: replaying a demo session', cancellable: true },
          async (progress, token) => {
            // Paint on a timer rather than from the `log` callback: a beat NARRATES before it writes, so
            // refreshing from the callback would always paint one beat behind what is being announced.
            // …but not faster than a refresh COMPLETES. At 500 ms with `force`, every tick landed while
            // the previous spawn was still running, which sets `rerun` and re-fires on completion — a
            // continuous back-to-back spawn chain for the whole replay, during the one feature whose
            // whole job is to look effortless. A spawn was measured at 1.25–1.35 s.
            const paint = setInterval(() => refreshAll(true), 1500);
            try {
              return await core.runDemo({
                cwd: root,
                log: (line) => progress.report({ message: line.trim() }),
                shouldStop: () => token?.isCancellationRequested === true,
              });
            } finally {
              clearInterval(paint);
            }
          }
        );
      } catch (e) {
        // A read-only or virtual workspace, a vanished root, a permission error. Report it as ours and
        // leave the way out visible — a half-seeded folder is still removable by Exit Demo.
        demoReplaying = false;
        updateEmptyStateContext();
        refreshAll(true);
        void vscode.window.showErrorMessage(
          `OAK: the demo could not be written to this folder — ${e instanceof Error ? e.message : String(e)}`
        );
        return;
      }
      // Only adopt a session that actually recorded something. Stopping in the first beat returns an id
      // with no transcript behind it; making THAT the session under review empties every panel and hides
      // the user's real session for the life of the window.
      demoReplaying = false;
      if (res.steps > 0) demoSession = res.session;
      updateEmptyStateContext(); // derives demoPresent from what is on disk
      refreshAll(true);
      if (res.cancelled) {
        // Stopping is not a failure and not a dead end: say what landed and name both ways out.
        const pick = await vscode.window.showInformationMessage(
          `OAK: demo stopped after ${res.edits} edit(s). What landed is real and reviewable.`,
          'Restart demo',
          'Exit demo'
        );
        if (pick === 'Restart demo') await vscode.commands.executeCommand('claudeObservatory.restartDemo');
        else if (pick === 'Exit demo') await vscode.commands.executeCommand('claudeObservatory.exitDemo');
        return;
      }
      if (noRepo) {
        void vscode.window.showInformationMessage(
          'OAK: this folder is not a git repository, so the Fleet tab has no worktrees to correlate. Every other panel is populated.'
        );
      }
      await startTour();
      };
      return [
        vscode.commands.registerCommand('claudeObservatory.startDemo', runDemoCommand),
        vscode.commands.registerCommand('claudeObservatory.restartDemo', runDemoCommand),
      ];
    })(),
    vscode.commands.registerCommand('claudeObservatory.startTour', () => startTour()),
    vscode.commands.registerCommand('claudeObservatory.tourDock', () => tourPanel.setDocked(true)),
    vscode.commands.registerCommand('claudeObservatory.tourFloat', () => tourPanel.setDocked(false)),
    // The reader closed the tour's window. Ending the tour here keeps Next/Back from stepping a thing
    // nobody can see, and puts the panels' borrowed tips back.
    vscode.commands.registerCommand('claudeObservatory.tourClosed', () => {
      if (tourStep >= 0) void endTour();
    }),
    // Every manual control hands over the wheel: autoplay stops and only the play button restarts it.
    // That is the rule both of the site's demo engines use, so the muscle memory carries over.
    vscode.commands.registerCommand('claudeObservatory.tourNext', async () => {
      pauseAutoplay();
      if (tourStep + 1 >= TOUR.length) return finishTour();
      await applyTourStep(tourStep + 1);
    }),
    vscode.commands.registerCommand('claudeObservatory.tourBack', () => {
      pauseAutoplay();
      return applyTourStep(tourStep - 1);
    }),
    vscode.commands.registerCommand('claudeObservatory.tourGoto', (i: number) => {
      pauseAutoplay();
      return applyTourStep(i);
    }),
    vscode.commands.registerCommand('claudeObservatory.tourReducedMotion', () => {
      tourReducedMotion = true;
      pauseAutoplay();
    }),
    vscode.commands.registerCommand('claudeObservatory.tourPlayPause', () => {
      if (tourPlaying) return pauseAutoplay();
      tourPlaying = true;
      if (tourStep >= 0) armAutoplay(TOUR[tourStep]);
    }),
    // Leave demo mode and remove every trace of it: both sessions, their stores, the demo folder, and
    // the report the scenario wrote outside the workspace.
    vscode.commands.registerCommand('claudeObservatory.exitDemo', async () => {
      if (demoReplaying) {
        void vscode.window.showInformationMessage('OAK: the demo is still replaying — cancel it from the progress notification, then exit.');
        return;
      }
      const root = workspaceRoot();
      await endTour();
      demoSession = undefined;
      // Close the demo's files FIRST. The tour deliberately opens one, and a buffer saved after the
      // folder is deleted recreates a file inside it — taking the `.observatory-demo` sentinel's tree
      // with it, so nothing may ever delete that folder again. Closing beats warning here: there is
      // nothing in a demo file worth keeping.
      const ws = root ? path.join(root, 'observatory-demo') : null;
      if (ws) {
        for (const group of vscode.window.tabGroups.all) {
          for (const tab of group.tabs) {
            const uri = (tab.input as { uri?: vscode.Uri } | undefined)?.uri;
            if (uri && canonFsPath(uri).startsWith(ws + path.sep)) {
              try {
                await vscode.window.tabGroups.close(tab, false);
              } catch {
                /* a tab that will not close is not a reason to abandon cleanup */
              }
            }
          }
        }
      }
      let removed: core.DemoCleanResult | null = null;
      try {
        removed = core.cleanDemo({ cwd: root ?? process.cwd() });
      } catch {
        /* reported below from what actually came back */
      }
      await vscode.commands.executeCommand('setContext', 'claudeObservatory.demoPresent', false);
      updateEmptyStateContext(); // re-derives demoPresent from what is actually on disk
      refreshAll(true);
      // Report what was REMOVED, not what removal was attempted: `cleanDemo` is best-effort per item,
      // so a locked or read-only folder leaves the claim "the observatory-demo folder is gone" false.
      const parts: string[] = [];
      if (removed?.sessions.length) parts.push(`${removed.sessions.length} session(s)`);
      if (removed?.workspaces.length) parts.push('the observatory-demo folder');
      if (removed?.scratch.length) parts.push('the report it wrote outside the workspace');
      void vscode.window.showInformationMessage(
        parts.length
          ? `OAK: demo removed — ${parts.join(', ')}.`
          : 'OAK: nothing to remove — no demo is recorded for this folder.'
      );
    }),
    // Pin which session the observatory shows (e.g. a demo session) instead of the auto-resolved
    // newest one — a QuickPick over every session in the store.
    // Pin a session by id (the Sessions tab's row click and other programmatic switches).
    // The config change fires onDidChangeConfiguration, which already runs refreshAll — no second call.
    vscode.commands.registerCommand('claudeObservatory.pinSession', async (id: string) => {
      // While demo mode is on, switching sessions moves the in-memory override instead of writing
      // .vscode/settings.json — clicking a Sessions row mid-tour must not dirty the user's repository.
      if (demoSession) {
        demoSession = id || undefined;
        refreshAll(true);
        vscode.window.setStatusBarMessage(id ? `OAK: showing session ${id}` : 'OAK: session set to auto', 3000);
        return;
      }
      // A pinned id is PERSISTED to .vscode/settings.json, so an unusable one is not a bad refresh —
      // it is a bad refresh that survives a restart. The session list can carry rows that are not
      // openable ids at all: an unreachable remote host is rendered as a row whose id is `!<name>`
      // with the error as its title, and `core.storeDir` throws on it, which would then throw on
      // every tick. Refuse it here, at the one place that writes.
      if (id && !core.isSafeSessionId(id)) {
        vscode.window.showWarningMessage(
          `OAK: “${id}” is not a session — that row is a host that could not be reached.`
        );
        return;
      }

      const cfg = vscode.workspace.getConfiguration('claudeObservatory');
      await cfg.update('session', id ?? '', vscode.ConfigurationTarget.Workspace);
      // Refresh from HERE rather than leaning on the configuration event: re-picking the session that
      // is already pinned writes an identical value, which fires no event at all, and the panel would
      // sit on its "Reading …" placeholder forever. Forced, so the 3 s tick throttle cannot drop it.
      refreshAll(true);
      vscode.window.setStatusBarMessage(
        id ? `OAK: showing session ${id}` : 'OAK: session set to auto',
        3000
      );
    }),
    vscode.commands.registerCommand('claudeObservatory.switchSession', async () => {
      // The list is cheap by construction (0.8.8): ids + stats only, titles from the bounded
      // sidecar-cached scan, sorted by CONVERSATION recency (transcript mtime) — no per-session log
      // parse, no whole-transcript reads, and only THIS workspace's sessions.
      const root = workspaceRoot();
      const meta = await readSessionListing(root ?? process.cwd(), currentSession()) ?? { active: null, sessions: [] };
      type Item = vscode.QuickPickItem & { id: string };
      const row = (r: core.SessionMetaRow): Item => ({
        label: (r.current ? '$(circle-filled) ' : '') + (r.title || `session ${r.id.slice(0, 8)}`),
        // agent · tier · model · store size (shared prefix — see sessionBadgePrefix), then recency + active.
        description: sessionBadgePrefix(r) + core.relTime(r.lastActiveMs) + (r.current ? ' · active' : ''),
        detail: r.id, // matchOnDetail below — pasting an id finds its row
        id: r.id,
        buttons: r.storeBytes ? [revealStoreBtn, deleteSessionBtn] : [deleteSessionBtn],
      });
      // LIVE session first, then the rest by recency; the Auto row leads for un-pinning.
      const active = meta.sessions.filter((r) => r.current).map(row);
      const rest = meta.sessions.filter((r) => !r.current).map(row);
      const items: Item[] = [
        { label: '$(sync) Auto — newest for this workspace', description: meta.active ?? 'none', id: '' },
        ...active,
        ...rest,
      ];
      // Preselect what is IN EFFECT — the pinned session, or the Auto row when nothing is pinned — not
      // simply the live one: a picker that opens on a row you are not looking at invites a mis-click.
      const pinned = vscode.workspace.getConfiguration('claudeObservatory').get<string>('session') || '';
      const qp = vscode.window.createQuickPick<Item>();
      qp.items = items;
      qp.title = 'OAK — review which session?';
      qp.placeholder = 'newest conversation first · type to filter by name or id';
      qp.matchOnDetail = true;
      const inEffect = pinned ? items.find((i) => i.id === pinned) : items[0];
      if (inEffect) qp.activeItems = [inEffect];
      else if (active.length) qp.activeItems = [active[0]]; // pinned elsewhere — fall back to the live one
      let alive = true;
      const pick = await new Promise<Item | undefined>((resolve) => {
        qp.onDidAccept(() => resolve(qp.selectedItems[0]));
        qp.onDidHide(() => { alive = false; resolve(undefined); });
        // Two row buttons: 🗑 deletes the session (shared confirm + core.deleteSession), 📁 reveals its
        // store folder in the OS file manager WITHOUT switching the review to it.
        // Delete keeps the picker OPEN — ignoreFocusOut holds it through the modal confirm's focus theft,
        // then the accepted row is dropped from the live item list; the `alive` guard skips the mutation
        // if the picker closed anyway.
        qp.onDidTriggerItemButton(async (e) => {
          const it = e.item as Item;
          if (e.button !== deleteSessionBtn) { revealStoreFolder(it.id); return; }
          const prev = qp.ignoreFocusOut;
          qp.ignoreFocusOut = true;
          const name = await confirmAndDeleteSession(it.id);
          if (alive) { qp.ignoreFocusOut = prev; if (name) qp.items = qp.items.filter((x) => x.id !== it.id); }
        });
        qp.show();
      });
      qp.dispose();
      if (!pick) return;
      await vscode.commands.executeCommand('claudeObservatory.pinSession', pick.id);
    }),
    /**
     * The full session browser: the Overview's Sessions tab.
     *
     * Every "All sessions…" row points here now. It used to run the `switchSession` QuickPick, which the
     * product deprecated as a browser — the Sessions tab lists the same sessions with their edits,
     * tokens, model and recency, and selecting a row switches the whole review.
     *
     * Deliberately routed through the TOUR's own path (`setTour`, which the tour uses to bring a left-nav
     * tab forward) rather than a second mechanism: one code path moves that tab strip, so a tour step and
     * this command can never disagree about how it is done.
     */
    vscode.commands.registerCommand('claudeObservatory.showSessions', async () => {
      await vscode.commands.executeCommand('claudeObservatory.changemap.focus');
      changeMapProvider.setTour('sessions', null);
    }),

    /**
     * Where the observatory keeps its data — shown, and changeable.
     *
     * The move is `core.moveStore`, shared with the terminal's options window, because a setting that
     * changed where NEW data goes while leaving the old data behind would strand a session's history
     * somewhere the product no longer looks.
     */
    vscode.commands.registerCommand('claudeObservatory.storeLocation', async () => {
      const current = core.rootDir();
      const prefs = core.readPrefs();
      const MOVE = 'Move it…';
      const DEFAULT = 'Restore the default location';
      const pick = await vscode.window.showQuickPick(
        [
          { label: current, description: prefs.storeDir ? 'moved' : 'default', detail: 'Where this session\u2019s edits, snapshots and caches are kept' },
          { label: MOVE, detail: 'Pick a new directory — your existing sessions move with it' },
          ...(prefs.storeDir ? [{ label: DEFAULT, detail: 'Move it back beside your agent config' }] : []),
        ],
        { title: 'OAK — store location' }
      );
      if (!pick || pick.label === current) return;
      let target = '';
      if (pick.label === MOVE) {
        const chosen = await vscode.window.showOpenDialog({
          canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Move the store here',
        });
        if (!chosen?.length) return;
        target = chosen[0].fsPath;
      } else {
        target = path.join(core.claudeConfigDir(), 'claude-observatory');
      }
      const res = core.moveStore(target);
      if ('error' in res) {
        void vscode.window.showErrorMessage(`OAK: store not moved — ${res.error}`);
        return;
      }
      const next = { ...prefs };
      if (pick.label === MOVE) next.storeDir = target;
      else delete next.storeDir;
      core.writePrefs(next);
      void vscode.window.showInformationMessage(`OAK: store moved to ${res.to}`);
      void vscode.commands.executeCommand('claudeObservatory.refresh');
    }),
    // The Timeline's selector as a command, so the Prompts tab's chip and the palette drive one
    // implementation. ACTIVE sessions only — switching between two live conversations is the thing this
    // is for; the last row hands over to the full browser.
    vscode.commands.registerCommand('claudeObservatory.switchActiveSession', async () => {
      const root = workspaceRoot() ?? process.cwd();
      const current = currentSession();
      type Item = vscode.QuickPickItem & { id: string; all?: boolean };
      // The store size is clickable via a folder button (see switchSession) — a QuickPick row cannot link
      // part of its text, so the store's affordance reveals it in the OS file manager. Only on rows with one.
      const items: Item[] = activeSessionRows((await readSessionListing(root, current))?.sessions ?? [], current).map((r) => ({
        label: (core.isFleetActive(Math.max(r.lastActiveMs, r.liveMs)) ? '● ' : '○ ') + (r.title || `session ${r.id.slice(0, 8)}`),
        // Same shared prefix as switchSession (see sessionBadgePrefix), then recency + reviewing.
        description: sessionBadgePrefix(r) + core.relTime(r.lastActiveMs) + (r.id === current ? ' · reviewing' : ''),
        detail: r.id, // matchOnDetail below — pasting an id finds its row
        id: r.id,
        buttons: r.storeBytes ? [revealStoreBtn, deleteSessionBtn] : [deleteSessionBtn],
      }));
      // Never a dead end: an active-only list can be empty, or the one you want can be an hour old.
      items.push({ label: '$(list-unordered) All sessions…', description: 'every session recorded for this workspace', id: '', all: true });
      const qp = vscode.window.createQuickPick<Item>();
      qp.items = items;
      qp.title = 'OAK — switch to an active session';
      qp.placeholder = 'sessions still being written, plus the one under review · the full list is the last row';
      qp.matchOnDetail = true;
      let alive = true;
      const pick = await new Promise<Item | undefined>((resolve) => {
        qp.onDidAccept(() => resolve(qp.selectedItems[0]));
        qp.onDidHide(() => { alive = false; resolve(undefined); });
        // 🗑 deletes the session (shared confirm + core.deleteSession); 📁 reveals its store folder in the
        // OS file manager without switching the review. Delete keeps the picker OPEN —
        // ignoreFocusOut holds it through the modal confirm, then the row is dropped from the live list
        // (the `alive` guard skips that if the picker closed anyway). The "All sessions…" row has no
        // buttons, so it is never a delete target.
        qp.onDidTriggerItemButton(async (e) => {
          const it = e.item as Item;
          if (e.button !== deleteSessionBtn) { revealStoreFolder(it.id); return; }
          const prev = qp.ignoreFocusOut;
          qp.ignoreFocusOut = true;
          const name = await confirmAndDeleteSession(it.id);
          if (alive) { qp.ignoreFocusOut = prev; if (name) qp.items = qp.items.filter((x) => x.id !== it.id); }
        });
        qp.show();
      });
      qp.dispose();
      if (!pick) return;
      if (pick.all) {
        // The full browser is the Overview's Sessions TAB, not the deprecated QuickPick.
        await vscode.commands.executeCommand('claudeObservatory.showSessions');
        return;
      }
      // Through pinSession, so a switch made during a demo moves the in-memory override instead of
      // writing the user's settings.json.
      await vscode.commands.executeCommand('claudeObservatory.pinSession', pick.id);
    }),
    // One-click escape from a fresh session's empty panel: pin the newest session that HAS edits.
    vscode.commands.registerCommand('claudeObservatory.switchToPreviousSession', async () => {
      const prior = previousSessionWithEdits(currentSession());
      if (!prior) {
        void vscode.window.showInformationMessage('OAK: no previous session with tracked edits.');
        return;
      }
      // Through pinSession, so the demo guard applies here too: this command sits one line above "Try
      // the demo" in the same welcome view, and a pin written during a demo is both invisible (the
      // override wins) and outlives it (Exit deletes the session the pin then points at).
      await vscode.commands.executeCommand('claudeObservatory.pinSession', prior.id);
    }),
    // A hand-edited `claudeObservatory.session` in settings.json should re-render immediately.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeObservatory.session')) refreshAll(true);
    }),
    // Keep / undo the pending edit under the cursor — the review loop never has to leave the keyboard.
    vscode.commands.registerCommand('claudeObservatory.keepAtCursor', () =>
      withSession(async (s) => {
        const rec = pendingAtCursor(s);
        if (!rec) {
          vscode.window.setStatusBarMessage('OAK: no pending edit under the cursor', 3000);
          return;
        }
        core.keepGroup(s, rec.id);
        vscode.window.setStatusBarMessage(`OAK: kept edit #${rec.id}`, 3000);
        await advanceAfterResolve(s, rec.id);
      })()
    ),
    vscode.commands.registerCommand('claudeObservatory.undoAtCursor', () =>
      withSession(async (s) => {
        const rec = pendingAtCursor(s);
        if (!rec) {
          vscode.window.setStatusBarMessage('OAK: no pending edit under the cursor', 3000);
          return;
        }
        await undoOne(s, rec.id);
        await advanceAfterResolve(s, rec.id);
      })()
    ),
    vscode.commands.registerCommand('claudeObservatory.setup', showSetup),
    vscode.commands.registerCommand('claudeObservatory.installHooks', installHooksFromExtension),
    vscode.commands.registerCommand('claudeObservatory.openDiff', (n: EditNode) => openDiff(n)),
    vscode.commands.registerCommand('claudeObservatory.openFileAtEdit', (n: EditNode) => openFileAtEdit(n)),
    vscode.commands.registerCommand('claudeObservatory.openFile', (n: Node) => {
      const file =
        n.kind === 'edit'
          ? n.rec.file
          : n.kind === 'file' || n.kind === 'class' || n.kind === 'tlrun'
            ? n.file
            : undefined;
      if (file) vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
    }),
    // Session-wide bulk actions (view-title buttons).
    // The Overview toolbar passes the session it is LABELLED with; the palette passes nothing and
    // gets the reviewed one. bulkSession validates either way — these verbs touch every pending edit.
    vscode.commands.registerCommand('claudeObservatory.keepAll', (sess?: unknown) => withBulkScope(sess, keepAllSession)),
    vscode.commands.registerCommand('claudeObservatory.undoAll', (sess?: unknown) => withBulkScope(sess, (s) => undoAllSession(s))),
    vscode.commands.registerCommand('claudeObservatory.redoAll', () => withSession((s) => redoAllSession(s))()),
    // Task review actions — the Tasks tab's per-row Accept / Reject / Clear + a "clear every completed
    // task" affordance. The webview posts {taskKeep|taskUndo|taskClear,taskId}; sets are STRICT.
    vscode.commands.registerCommand('claudeObservatory.taskKeep', (taskId: string) => withSession((s) => keepTaskScope(s, taskId))()),
    vscode.commands.registerCommand('claudeObservatory.taskUndo', (taskId: string) => withSession((s) => undoTaskScope(s, taskId))()),
    vscode.commands.registerCommand('claudeObservatory.taskClear', (taskId: string) => withSession((s) => clearTaskScope(s, taskId))()),
    vscode.commands.registerCommand('claudeObservatory.clearCompletedTasks', () => withSession((s) => clearCompletedTasks(s))()),
    vscode.commands.registerCommand('claudeObservatory.clearResolved', (sess?: unknown) => withBulkScope(sess, (s) => clearResolvedSession(s))),
    // Store maintenance (parity with the CLI `clean`): reclaim disk (GC orphaned blobs) or drop the
    // whole session. Previously editor-only users had to drop to a terminal for these.
    // The Overview, as an editor tab. Default stays the bottom panel; this is opt-in per invocation or
    // via claudeObservatory.overviewLocation.
    vscode.commands.registerCommand('claudeObservatory.openOverviewInEditor', () => changeMapProvider.openInEditor()),
    vscode.commands.registerCommand('claudeObservatory.cleanStore', () =>
      withSession(async (s) => {
        const pick = await vscode.window.showQuickPick(
          [
            // No bin glyph anywhere in this product, deliberately. Every control here sits within reach
            // of buttons that keep or undo real code, and a trash can next to those reads as "discard my
            // changes" — the one meaning they must never carry. This reclaims space from orphaned blobs;
            // it changes no file on disk. `$(clear-all)` is what the Clear Resolved command already uses.
            { label: '$(clear-all) Reclaim disk', description: 'garbage-collect orphaned blobs in this session', act: 'gc' as const },
            { label: '$(history) Clear completed sessions…', description: 'drop finished sessions with nothing left to review', act: 'completed' as const },
            { label: '$(close) Drop this session…', description: "delete this session's captured edits + blobs (files on disk are NOT changed)", act: 'drop' as const },
          ],
          { placeHolder: 'Clean the OAK store' }
        );
        if (!pick) return;
        if (pick.act === 'completed') {
          // Spelled out, never a bare "Clear": this drops whole sessions, not resolved edits.
          const doomed = core.reapableSessions(workspaceRoot() ?? process.cwd());
          if (doomed.length === 0) {
            vscode.window.showInformationMessage('No completed sessions to clear — every other session is still live, still has pending edits, or only just went quiet.');
            return;
          }
          const fin = doomed.filter((d) => d.reason === 'finished').length;
          const aband = doomed.filter((d) => d.reason === 'abandoned');
          const lost = aband.reduce((n, d) => n + d.pending, 0);
          const names = doomed.slice(0, 5).map((d) => d.title || d.id).join(', ');
          // The abandoned half DISCARDS UNREVIEWED EDITS. That is the whole reason this dialog exists,
          // so it leads with that number rather than burying it under a session count.
          const ok = await vscode.window.showWarningMessage(
            `Clear ${doomed.length} session(s)?` +
              (aband.length ? ` ${lost} edit(s) have never been reviewed and will be discarded.` : ' All of them are fully reviewed.'),
            {
              modal: true,
              detail:
                `${fin} finished (nothing left to review)` +
                (aband.length ? `, ${aband.length} abandoned (no activity for over two weeks, ${lost} unreviewed edit(s))` : '') +
                `\n\n${names}${doomed.length > 5 ? `, and ${doomed.length - 5} more` : ''}` +
                `\n\nThis deletes their captured edits + blobs. Files on disk are NOT changed. Never included: the session you are in, anything mid-capture, anything from another workspace, anything reviewed-and-quiet for under a day, or anything with pending edits that is under two weeks old.`,
            },
            'Clear sessions'
          );
          if (ok !== 'Clear sessions') return;
          // Spawned: the delete loop is one recursive rm per session on the host thread otherwise —
          // the same class of post-confirm freeze this release removed from resolve/clear-resolved.
          // (The preview above stays in-process: reapableSessions measures ~6ms.) The CLI applies the
          // SAME rails, so the sets cannot drift.
          void vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Clearing completed sessions…' },
            () =>
              new Promise<void>((fin2) => {
                spawnCliJson(['clean', '--completed', '--json'], workspaceRoot() ?? process.cwd(), (data) => {
                  const dropped = data && typeof data === 'object' && Array.isArray((data as { dropped?: unknown }).dropped)
                    ? ((data as { dropped: unknown[] }).dropped.length)
                    : null;
                  if (dropped !== null) vscode.window.showInformationMessage(`Cleared ${dropped} completed session(s).`);
                  else vscode.window.showErrorMessage('Could not clear sessions — is the oak CLI installed?');
                  refreshAll(true);
                  fin2();
                });
              })
          );
          return;
        }
        if (pick.act === 'gc') {
          const r = core.gcSession(s);
          vscode.window.showInformationMessage(`Reclaimed ${r.removed} orphaned blob(s) (${(r.bytes / 1024).toFixed(1)} KB).`);
        } else {
          const ok = await vscode.window.showWarningMessage(
            `Drop session ${s}? This deletes its captured edits + blobs. Files on disk are NOT changed.`,
            { modal: true },
            'Drop session'
          );
          if (ok !== 'Drop session') return;
          core.removeSession(s);
          vscode.window.showInformationMessage(`Dropped session ${s}.`);
        }
      })()
    ),
    // Chat about a specific edit (from a tree node or an edit id).
    vscode.commands.registerCommand('claudeObservatory.chatEdit', (arg: EditNode | number) => {
      const s = currentSession();
      if (!s) return undefined;
      return chatAboutEdit(s, typeof arg === 'number' ? arg : arg.rec.id);
    }),
    // Zero-token chat about ANY action / edit / subagent / task (0.8.0). Accepts a bare ChatContextRef
    // (from the Multitasking + Overview webviews) or an Actions tree node (action / subagent row).
    vscode.commands.registerCommand('claudeObservatory.chatAction', (arg: unknown) => {
      const ref = refFromArg(arg);
      if (!ref) return undefined;
      return chatAction(ref);
    }),
    // Insights (observations + suggestions)
    vscode.commands.registerCommand('claudeObservatory.showObservation', (id: number) => showObservationDoc(id)),
    vscode.commands.registerCommand('claudeObservatory.showSuggestions', () => showSuggestionsDoc()),
    vscode.commands.registerCommand('claudeObservatory.analyzeEdit', (arg: ObsNode | number) => {
      const s = currentSession();
      if (!s) return undefined;
      const id = typeof arg === 'number' ? arg : (arg as { id?: number; rec?: core.EditRecord }).id ?? (arg as { rec?: core.EditRecord }).rec?.id;
      if (typeof id !== 'number') return undefined;
      if (core.cachedAnalysis(s, `edit-${id}`)) return showObservationDoc(id); // already analyzed -> just view
      return vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Analyzing edit #${id} with Claude…` },
        async () => {
          try {
            const bin = core.resolveClaudeBin(vscode.workspace.getConfiguration('claudeObservatory').get<string>('claudeBin'));
            const cwd = workspaceRoot();
            const reasoning = cwd ? core.reasoningByEdit(cwd, s).get(id) : undefined;
            await core.analyzeEdit(s, id, { claudeBin: bin, reasoning });
          } catch (e) {
            vscode.window.showErrorMessage(`Analyze failed: ${String((e as Error)?.message || e)}`);
            return;
          }
          // Through the WINDOW that draws these rows: dropping the provider's memo alone repaints
          // nothing now that Observations is a webview tab rather than a tree with its own event.
          promptsProvider.refresh(true);
          await showObservationDoc(id);
        }
      );
    }),
    vscode.commands.registerCommand('claudeObservatory.refreshRecap', () => {
      const s = currentSession();
      if (!s) return undefined;
      return vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Refreshing the session recap with Claude…' },
        async () => {
          try {
            const bin = core.resolveClaudeBin(vscode.workspace.getConfiguration('claudeObservatory').get<string>('claudeBin'));
            await core.analyzeRecap(s, { claudeBin: bin });
          } catch (e) {
            vscode.window.showErrorMessage(`Recap failed: ${String((e as Error)?.message || e)}`);
            return;
          }
          promptsProvider.refresh(true); // see analyzeEdit above — the window is what repaints

        }
      );
    }),
    vscode.commands.registerCommand('claudeObservatory.keep', (n: EditNode) =>
      withSession(async (s) => {
        core.keepGroup(s, n.rec.id);
        await advanceAfterResolve(s, n.rec.id);
      })()
    ),
    vscode.commands.registerCommand('claudeObservatory.undo', (n: EditNode) =>
      withSession(async (s) => {
        await undoOne(s, n.rec.id);
        await advanceAfterResolve(s, n.rec.id);
      })()
    ),
    vscode.commands.registerCommand('claudeObservatory.redo', (n: EditNode) =>
      withSession((s) => redoOne(s, n.rec.id))()
    ),
    // Inline overlay hover actions — take an edit id instead of a tree node.
    vscode.commands.registerCommand('claudeObservatory.inlineDiff', (id: number) => {
      const s = currentSession();
      const rec = s ? core.findRecord(s, id) : null;
      if (rec) openDiff({ kind: 'edit', rec });
    }),
    // "View changes" → the inline review bubble at the edit: the diff in git's colors + reasoning +
    // line counts, with Keep/Undo/Chat/Prev/Next as toolbar buttons (comments/commentThread/title).
    vscode.commands.registerCommand('claudeObservatory.viewChanges', (id: number) => editPeek.show(id)),
    // The floating review bar at an edit: the compact nav surface over the code (Keep · Undo · ⌃⌄ · ‹› ·
    // Diff · Details) with a live "Agent edit #12 · +8 −3 · Diff 2/5 · File 1/3" title. Takes an optional
    // id (the CodeLens header passes its own edit); with none it opens at whatever the open file's review
    // is currently about — which is what makes it a usable command-palette entry and the way back when
    // `editorReviewSurface` is set to `none`.
    vscode.commands.registerCommand('claudeObservatory.showReviewBar', async (id?: number) => {
      const s = currentSession();
      const file = activeEditorFile();
      // navEditId is the Diff axis's own anchor and is always a pending edit in the OPEN file (or unset),
      // so the bar and the status-bar counters open on the same edit.
      const target = id ?? navEditId ?? (s && file ? pendingEditsInFile(s, file)[0]?.id : undefined);
      if (target === undefined) {
        vscode.window.setStatusBarMessage('OAK: open a file with pending edits to review it', 2500);
        return;
      }
      await editPeek.show(target, { mode: 'bar' });
    }),
    // The two swaps between the review surfaces, at the SAME edit: the bar's "⋯ Details" opens the bubble
    // (reasoning + the git-coloured diff), and the bubble's "Collapse" returns to the bar.
    vscode.commands.registerCommand('claudeObservatory.barDetails', () => editPeek.swapTo('detail')),
    // The bar has no diff in its body — this is its way to the patch.
    vscode.commands.registerCommand('claudeObservatory.peekViewDiff', () => editPeek.viewDiff()),
    // Pin/unpin the review bubble. One setting, two commands, so the bubble's toolbar can show the
    // action that is actually available rather than a checkbox nobody can see inside a comment thread.
    vscode.commands.registerCommand('claudeObservatory.peekPin', async () => {
      await vscode.workspace
        .getConfiguration('claudeObservatory')
        .update('pinnedPeek', true, vscode.ConfigurationTarget.Global);
      syncPeekPinned();
      vscode.window.setStatusBarMessage('OAK: review bubble pinned — Keep/Undo now carries it to the next edit', 4000);
    }),
    vscode.commands.registerCommand('claudeObservatory.peekUnpin', async () => {
      await vscode.workspace
        .getConfiguration('claudeObservatory')
        .update('pinnedPeek', false, vscode.ConfigurationTarget.Global);
      syncPeekPinned();
      vscode.window.setStatusBarMessage('OAK: review bubble unpinned — it closes after Keep/Undo', 4000);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeObservatory.pinnedPeek')) syncPeekPinned();
      // Which review chrome the editor shows just changed: drop what is on screen and let the refresh
      // below build the surface that was actually asked for (or, for `none`, leave the editor clean).
      if (e.affectsConfiguration('claudeObservatory.editorReviewSurface')) {
        editPeek.resetSurface();
        updateStatusItem();
      }
    }),
    // Both RETURN their promise: keeping can now carry the bubble to the next edit, and a caller (VS Code
    // itself, or a test) has to be able to wait for that to finish.
    vscode.commands.registerCommand('claudeObservatory.peekKeep', () => editPeek.keep()),
    vscode.commands.registerCommand('claudeObservatory.peekUndo', () => editPeek.undo()),
    vscode.commands.registerCommand('claudeObservatory.peekChat', () => editPeek.chat()),
    vscode.commands.registerCommand('claudeObservatory.peekPrev', () => editPeek.step(-1)),
    vscode.commands.registerCommand('claudeObservatory.peekNext', () => editPeek.step(1)),
    // Floating bubble = the full nav bar: File axis + per-file Accept/Reject alongside the Diff axis above.
    vscode.commands.registerCommand('claudeObservatory.peekPrevFile', () => void editPeek.stepFile(-1)),
    vscode.commands.registerCommand('claudeObservatory.peekNextFile', () => void editPeek.stepFile(1)),
    vscode.commands.registerCommand('claudeObservatory.peekAcceptFile', () => editPeek.acceptFile()),
    vscode.commands.registerCommand('claudeObservatory.peekRejectFile', () => void editPeek.rejectFile()),
    // Prev/Next on the diff title bar (diff tabs from the Diffs tree / revision nav): step the file's
    // pending edits (wrapping). The command gets the diff's resource URI, which carries the edit id.
    vscode.commands.registerCommand('claudeObservatory.diffPrevEdit', (uri?: vscode.Uri) => stepDiffEdit(uri, -1)),
    vscode.commands.registerCommand('claudeObservatory.diffNextEdit', (uri?: vscode.Uri) => stepDiffEdit(uri, 1)),
    // `advance: false` is how the DIFF title bar opts out of auto-advance. Its buttons route here, and a
    // diff tab is a viewer the reader opened on purpose: revealing the next edit would leave them staring
    // at a text editor behind a diff of something else. In the editor itself, advancing is the point.
    vscode.commands.registerCommand('claudeObservatory.inlineKeep', (id: number, opts?: { advance?: boolean }) =>
      withSession(async (s) => {
        core.keepGroup(s, id);
        if (opts?.advance !== false) await advanceAfterResolve(s, id);
      })()
    ),
    vscode.commands.registerCommand('claudeObservatory.inlineUndo', (id: number, opts?: { advance?: boolean }) =>
      withSession(async (s) => {
        await undoOne(s, id);
        if (opts?.advance !== false) await advanceAfterResolve(s, id);
      })()
    ),
    // Keep/Undo/Chat for a claude-edit diff, invoked from the single diff's title bar or from a
    // per-diff review bar (a comment-thread title command receives its THREAD, which carries the
    // after URI). Argument shapes vary by invoker — resolve every known shape to the URI whose
    // query carries our edit id, and no-op on anything else.
    vscode.commands.registerCommand('claudeObservatory.diffKeep', (arg?: unknown) => {
      const id = editIdFromUri(diffArgUri(arg));
      if (id != null) void vscode.commands.executeCommand('claudeObservatory.inlineKeep', id, { advance: false });
    }),
    vscode.commands.registerCommand('claudeObservatory.diffUndo', (arg?: unknown) => {
      const id = editIdFromUri(diffArgUri(arg));
      if (id != null) void vscode.commands.executeCommand('claudeObservatory.inlineUndo', id, { advance: false });
    }),
    vscode.commands.registerCommand('claudeObservatory.diffChat', (arg?: unknown) => {
      const id = editIdFromUri(diffArgUri(arg));
      if (id != null) void vscode.commands.executeCommand('claudeObservatory.chatEdit', id);
    }),
    // The whole diff behind a previewed row — the ordinary single-diff editor, unbounded.
    vscode.commands.registerCommand('claudeObservatory.diffOpenFull', (arg?: unknown) => {
      const id = editIdFromUri(diffArgUri(arg));
      const s = currentSession();
      if (id == null || !s) return;
      const rec = core.reviewEdits(s).find((r) => r.id === id) ?? core.findRecord(s, id);
      if (rec) void openDiff({ rec } as unknown as EditNode);
    }),
    vscode.commands.registerCommand('claudeObservatory.toggleInline', async () => {
      const cfg = vscode.workspace.getConfiguration('claudeObservatory');
      const next = !cfg.get<boolean>('inlineReview', true);
      await cfg.update('inlineReview', next, vscode.ConfigurationTarget.Global);
      refreshInline();
      vscode.window.setStatusBarMessage(`OAK: inline review ${next ? 'on' : 'off'}`, 2500);
    }),
    // Spotlight: dim every unmodified line so only the agent's edits read at full contrast.
    vscode.commands.registerCommand('claudeObservatory.toggleHeatmap', () => {
      heatmapOn = !heatmapOn;
      refreshInline();
      vscode.window.setStatusBarMessage(`OAK: spotlight ${heatmapOn ? 'on' : 'off'}`, 2500);
    }),
    vscode.commands.registerCommand('claudeObservatory.keepFile', (n: FileNode) =>
      withSession((s) => keepEditsInFile(s, n.file, n.edits))()
    ),
    vscode.commands.registerCommand('claudeObservatory.undoFile', (n: FileNode) =>
      withSession((s) => undoEditsInFile(s, n.file, n.edits))()
    ),
    // (clearFile removed in 0.8.3 — the session-wide Clear Resolved covers it; this was the last
    // leftover wiring, JetBrains never had it.)
    // N15: the folder-row actions went with the Edits tree (their only invokers were its context
    // menus); folder-scoped ops live on the Overview's change map.
    // Accept / revert every pending edit in the ACTIVE editor's file — what the per-file surfaces use.
    vscode.commands.registerCommand('claudeObservatory.keepOpenFile', () =>
      withSession((s) => {
        const file = activeEditorFile();
        if (!file) return void vscode.window.showInformationMessage('OAK: no active file.');
        keepEditsInFile(s, file, cachedLog(s).filter((r) => r.file === file));
      })()
    ),
    vscode.commands.registerCommand('claudeObservatory.undoOpenFile', () =>
      withSession(async (s) => {
        const file = activeEditorFile();
        if (!file) return void vscode.window.showInformationMessage('OAK: no active file.');
        await undoEditsInFile(s, file, cachedLog(s).filter((r) => r.file === file));
      })()
    )
  );

  // Live updates: watch the store's log files.
  //
  // TWO ROOTS, resolved SEPARATELY. These were both derived from `path.dirname(rootDir())`, which
  // equalled the Claude config dir only while the store was always `<config>/claude-observatory`.
  // The store-location setting breaks that invariant: after a move, dirname() is the parent of
  // wherever the reader put it, so the store pattern pointed at a sibling that does not exist AND
  // the transcript pattern — which has nothing to do with the store — pointed somewhere with no
  // transcripts in it. Both watchers went silent, and the log watcher is the ONLY live path (see the
  // note at updateStatusItem), so every view stopped updating while the agent worked.
  // core/src/watch.ts already resolves them independently; this is the same rule.
  const storeRoot = vscode.Uri.file(core.rootDir());
  const configRoot = vscode.Uri.file(core.claudeConfigDir());
  const watcher = vscode.workspace.createFileSystemWatcher(
    // Narrowed from machine-wide '*/log.jsonl' (0.8.8): any session anywhere used to wake every
    // window for a full refresh. Watch the whole store dir but debounce-filter in the handler below.
    new vscode.RelativePattern(storeRoot, '*/{log.jsonl,capture-events.jsonl,attention.json,agent.json}')
  );
  // Capture writes land in bursts (PreToolUse + PostToolUse per edit) — debounce so one refresh
  // covers the burst instead of re-rendering every view per file event.
  let watchDebounce: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = () => {
    if (watchDebounce) clearTimeout(watchDebounce);
    watchDebounce = setTimeout(refreshAll, 150);
  };
  // Relevance filter (0.8.8): the glob is store-wide, so a session ANY other window is capturing used
  // to wake this one for a full refresh. Only the session under review (or a workspace-resolvable one)
  // is worth a repaint here; everything else is another project's traffic.
  const relevantStoreEvent = (uri: vscode.Uri): boolean => {
    const sid = path.basename(path.dirname(uri.fsPath));
    if (sid === currentSession()) return true;
    const root = workspaceRoot();
    if (!root) return false;
    try {
      return core.findTranscript(root, sid) !== null;
    } catch {
      return true; // when in doubt, refresh — stale panels are worse than one extra repaint
    }
  };
  const onStoreEvent = (uri: vscode.Uri) => {
    storeStamp++; // any session's change can move the shared listing's rows (see sharedListing)
    if (relevantStoreEvent(uri)) scheduleRefresh();
  };
  watcher.onDidChange(onStoreEvent);
  watcher.onDidCreate(onStoreEvent);
  watcher.onDidDelete(onStoreEvent);
  context.subscriptions.push(watcher);

  // `workspaceRoot()` is `folders[0]`, and EVERY caller reads it live — so adding, removing or
  // reordering folders silently changes which session the whole extension is about. Nothing announced
  // that: the panels kept rendering the previous root's session until some unrelated event happened to
  // refresh them, and in a multi-root window "unrelated event" can be minutes away. The store watcher
  // above cannot cover this — it is scoped to ~/.claude, so no file event fires when the WORKSPACE
  // changes. The caches need no clearing: each is keyed by session id and validated against its
  // source's (mtime, size), so a new root simply misses instead of returning the old root's answer.
  // JetBrains has no counterpart — a project's basePath is fixed for the life of the project.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => refreshAll(true))
  );

  // The store only changes on EDITS, but Actions / Observations / Timeline / Overview are mined from
  // the session TRANSCRIPT, which grows on every read / command / subagent / to-do. Watch it too so
  // those views update in real time as the agent works — not just when it happens to edit a file. A
  // gentler debounce (the transcript is rewritten far more often than the store) coalesces the churn.
  const transcriptWatcher = vscode.workspace.createFileSystemWatcher(
    // The CONFIG root, never the store root — transcripts live beside the config wherever the store
    // is, and a store the reader moved must not take this watcher with it.
    new vscode.RelativePattern(configRoot, 'projects/**/*.jsonl')
  );
  // ~/.claude/projects holds EVERY project on the machine, so that pattern also fires for repos this
  // window knows nothing about — and each spurious wake costs a full refreshAll (two CLI spawns). Keep
  // the broad pattern (worktrees come and go, so re-registering watchers would be its own bug) and
  // filter arrivals instead: only this workspace's project dir and those of its worktree siblings are
  // this window's business. The set is cached, and any failure to compute it falls back to accepting
  // everything — a stale extra refresh is far better than a panel that stops updating.
  let relevantDirs: Set<string> | null = null;
  let relevantAt = 0;
  const relevantProjectDirs = (): Set<string> | null => {
    const now = Date.now();
    if (relevantDirs && now - relevantAt < 30_000) return relevantDirs;
    const cwd = workspaceRoot();
    if (!cwd) return null;
    try {
      const dirs = new Set<string>([core.canonPath(path.resolve(core.projectDir(cwd)))]);
      for (const sib of core.listRepoSiblings(cwd, currentSession() ?? '')) dirs.add(core.canonPath(path.resolve(core.projectDir(sib.worktree))));
      relevantDirs = dirs;
      relevantAt = now;
      return dirs;
    } catch {
      return null; // can't tell → treat every transcript as ours
    }
  };
  let txDebounce: ReturnType<typeof setTimeout> | undefined;
  const scheduleTxRefresh = (uri?: vscode.Uri) => {
    if (uri) {
      const dirs = relevantProjectDirs();
      // Containment, not equality: a session's subagent and workflow transcripts live NESTED under the
      // project dir (<project>/<session>/subagents/**.jsonl), and those are exactly the writes that keep
      // a live agent fleet's phase current.
      const p = core.canonPath(path.resolve(uri.fsPath)); // #43: watcher URIs carry the lower-cased drive
      if (dirs && ![...dirs].some((d) => p === d || p.startsWith(d + path.sep))) return; // another project's session
    }
    if (txDebounce) clearTimeout(txDebounce);
    txDebounce = setTimeout(refreshAll, 700);
  };
  transcriptWatcher.onDidChange(scheduleTxRefresh);
  transcriptWatcher.onDidCreate(scheduleTxRefresh);
  context.subscriptions.push(transcriptWatcher);
  const codexWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(core.codexHome()), '{sessions,archived_sessions}/**/*.jsonl')
  );
  // Codex paths are sharded by date, not workspace. Discovery decides relevance on refresh.
  const onCodexEvent = () => scheduleTxRefresh();
  codexWatcher.onDidChange(onCodexEvent);
  codexWatcher.onDidCreate(onCodexEvent);
  codexWatcher.onDidDelete(onCodexEvent);
  context.subscriptions.push(codexWatcher);

  refreshInline(); // paint the currently-open editor on activation

  // Nudge at most once, and only when nothing's set up: no hooks AND no tracked edits for this
  // workspace (so browsing the demo / an already-captured session never nags).
  const nudgeSession = currentSession();
  const hasEdits = nudgeSession ? core.readLog(nudgeSession).length > 0 : false;
  if (!core.hooksInstalled() && !hasEdits && !context.globalState.get('setupNudged')) {
    context.globalState.update('setupNudged', true);
    showSetup();
  }

  // Reveal the Timeline window on one of its tabs. VS Code auto-registers a `<viewId>.focus` command for
  // every contributed view; running it un-collapses and focuses the pane. These commands wrap it under
  // friendly palette titles, and `showPrompts` is what the first-run nudge below invokes.
  const showTimelineTab = async (tab: 'prompts' | 'actions' | 'observations' | 'feed') => {
    await vscode.commands.executeCommand('claudeObservatory.timeline.focus');
    promptsProvider.setTab(tab);
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeObservatory.showPrompts', () => showTimelineTab('prompts')),
    // Reveal the Review view. With no ask picked it opens on its empty state, which says how to pick one.
    vscode.commands.registerCommand('claudeObservatory.showReview', () =>
      vscode.commands.executeCommand('claudeObservatory.reviewList.focus')
    ),
    vscode.commands.registerCommand('claudeObservatory.showActions', () => showTimelineTab('actions')),
    vscode.commands.registerCommand('claudeObservatory.showObservations', () => showTimelineTab('observations')),

    vscode.commands.registerCommand('claudeObservatory.openConversation', async (id: string) => {
      if (typeof id !== 'string' || !core.isSafeSessionId(id)) return;
      promptsProvider.connectSession(id);
      await showTimelineTab('feed');
    }),
    vscode.commands.registerCommand('claudeObservatory.showFeed', () => showTimelineTab('feed')),
    // Needs you: the next session waiting on the reader, by core's ranking.
    vscode.commands.registerCommand('claudeObservatory.nextAttention', () => promptsProvider.jumpToNextHand()),
  );
  // When a view container's contents change on upgrade, VS Code keeps the pre-upgrade panel layout and
  // does NOT surface a newly-added view — so an existing user upgrading INTO 0.8.7 never sees the new
  // Prompts window until they reveal it by hand. Point them at it exactly once (a non-modal toast,
  // globalState-guarded so it never nags), with a button that reveals it. A fresh install lays the
  // panel out from the manifest and shows Prompts already, so this is purely upgrade-friction relief.
  // `context.globalState` is real in VS Code but absent in the smoke-test mock — guard so activation
  // never depends on it (the nudge is pure UX; skipping it in a headless run changes nothing).
  // An UPGRADE is what this nudge is for. A brand-new install has an empty globalState, which the
  // version key alone cannot distinguish from an upgrade — and telling a first-time user that we
  // renamed a window they never had is noise. The 0.8.7 key is the evidence of a prior install.
  const upgraded = !!(context.globalState && context.globalState.get('requestsRevealed.0.8.7'));
  if (context.globalState && !context.globalState.get('promptsRevealed.0.8.8')) {
    context.globalState.update('promptsRevealed.0.8.8', true);
  }
  if (upgraded && context.globalState && !context.globalState.get('promptsToldRenamed')) {
    context.globalState.update('promptsToldRenamed', true);
    void vscode.window
      .showInformationMessage(
        'OAK 0.8.8 renames the Requests window to Prompts — the session as the list of things you asked for. Reveal it?',
        'Show Prompts'
      )
      .then((pick) => {
        if (pick === 'Show Prompts') void vscode.commands.executeCommand('claudeObservatory.showPrompts');
      });
  }

  // Marketplace-free update nudge: a manual command + a throttled background check on activation.
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeObservatory.checkForUpdates', () => checkForUpdate(context, true)),
    // Switch release channels (stable ⇄ the rolling pre-release). `applyUpdate` installs THIS
    // extension itself and asks the CLI only for the CLI and the JetBrains plugin, so a machine
    // without the shell `code` command — or without the CLI at all — still switches.
    vscode.commands.registerCommand('claudeObservatory.switchChannel', async (ch?: string) => {
      let target: 'stable' | 'dev' | undefined = ch === 'stable' || ch === 'dev' ? ch : undefined;
      if (!target) {
        const pick = await vscode.window.showQuickPick(
          [
            { label: 'Stable', description: 'tagged releases', ch: 'stable' as const },
            { label: 'Pre-release', description: 'rolling build of the dev branch — newest features, less soak', ch: 'dev' as const },
          ],
          { title: 'Switch release channel', placeHolder: `Currently: ${core.getUpdateChannel() === 'dev' ? 'Pre-release' : 'Stable'}` }
        );
        if (!pick) return;
        target = pick.ch;
      }
      // Already on it is NOT a no-op offer: the channel can say one thing while the bits say another
      // (a blocked install, a local build), and refusing to act was how people got stuck. Re-running
      // the same channel reconciles it.
      await applyUpdate(target);
    }),
    // The chip's Update now: the FULL update — this extension + CLI + JetBrains plugin + status line.
    vscode.commands.registerCommand('claudeObservatory.updateNow', () => applyUpdate(null))
  );
  // The demo offer takes precedence for this activation. Two unsolicited notifications on the first
  // launch after an update is precisely the noise "Never ask" exists to stop, and the update check is
  // throttled anyway — it simply runs next time.
  // `startDemo` replays AND then tours: there is no demo yet, so offering the tour alone would walk the
  // reader through an empty product.
  // …and hands back the update check if the four-second re-check ends up suppressing the offer, so a
  // reader who was mid-session at activation is not left with neither notification.
  if (!offerDemo(context, () => void vscode.commands.executeCommand('claudeObservatory.startDemo'), () => void checkForUpdate(context, false))) {
    void checkForUpdate(context, false);
  }
}

/**
 * Offer the demo on a first install and after an update, once, with a way to decline for good.
 *
 * Returns true when an offer was scheduled, so activation can stand the update nudge down for this run.
 *
 * Every gate here is load-bearing, and the last one especially: an unsolicited notification that
 * interrupts a live agent session is worse than never offering at all, so a busy workspace is skipped
 * WITHOUT stamping the version — it gets offered next launch, when the reader is idle.
 */
function offerDemo(context: vscode.ExtensionContext, run: () => void, standDown: () => void): boolean {
  const g = context.globalState;
  // `context.extension` is absent under the smoke-test mock and in headless hosts. This is the proven
  // guard `checkForUpdate` already uses, and it is what keeps the offer out of automated runs.
  const current = context.extension?.packageJSON?.version ? String(context.extension.packageJSON.version) : undefined;
  if (!current) return false;
  if (g.get<boolean>('demoOffer.never')) return false;
  const last = g.get<string>('demoOffer.lastSeenVersion');
  if (last === current) return false;
  const root = workspaceRoot();
  if (!root) return false; // nothing to record a demo against
  // The demo writes into the reader's repository. Never offer that in a workspace they have not trusted.
  if (vscode.workspace.isTrusted === false) return false;

  // Install vs update: a brand-new install has an empty globalState, which a version key alone cannot
  // tell from an upgrade — so look for any key a previous version would have written.
  // NOT `promptsRevealed.0.8.8`: activation writes that key unconditionally, several lines before this
  // runs, so it is true on a brand-new install too — with it in the list `hadPrior` was ALWAYS true and
  // the first-install copy at the bottom of this function could never be reached. Every key below is
  // written only by something a reader actually did. (JetBrains had the identical bug in `everRan`.)
  const hadPrior = !!(
    g.get('requestsRevealed.0.8.7') ||
    g.get('setupNudged') ||
    g.get('updateCheck.lastMs') ||
    g.get('tourDocked')
  );
  const kind: 'install' | 'update' = last || hadPrior ? 'update' : 'install';

  const busy = () => {
    try {
      const id = core.resolveSessionId(root);
      if (!id || core.isDemoSession(id)) return false;
      const t = core.findTranscript(root, id);
      return !!t && Date.now() - fs.statSync(t).mtimeMs <= core.SESSION_BUSY_MS;
    } catch {
      return false;
    }
  };
  if (busy()) return false; // and deliberately NOT stamped — try again next launch

  // A toast at t=0 on a cold window is hostile; activation is already doing enough.
  const timer = setTimeout(() => {
    if (busy()) {
      standDown(); // they started working in the meantime — leave them alone, and re-offer later
      return;
    }
    // A demo already recorded here means they have found it. Stamp so this version stops asking, and give
    // the update check its turn back rather than spending the activation on nothing.
    if (core.demoSessionsFor({ cwd: root }).length > 0) {
      void g.update('demoOffer.lastSeenVersion', current);
      standDown();
      return;
    }
    void g.update('demoOffer.lastSeenVersion', current); // stamp BEFORE showing: an ignored toast never re-asks
    const message =
      kind === 'install'
        ? 'OAK is installed. There is nothing to set up to look around: the demo replays a real agent session through the real capture pipeline in about twenty seconds, every button in it works, and leaving removes every trace.'
        : `OAK is now ${current}. The guided tour walks what changed alongside everything else — the demo replays in about twenty seconds and removes every trace when you leave.`;
    void vscode.window.showInformationMessage(message, 'Take the tour', 'Never ask').then((pick) => {
      if (pick === 'Take the tour') run();
      else if (pick === 'Never ask') void g.update('demoOffer.never', true);
    });
  }, 4000);
  timer.unref?.();
  context.subscriptions.push({ dispose: () => clearTimeout(timer) });
  return true;
}


export function deactivate(): void {
  /* disposables handled via context.subscriptions */
  // …except core's caches, which are module state in an imported package and nothing disposes them.
  // The raw-text layer can be holding up to its byte budget of transcript text at this point.
  core.clearFsCache();
  // Belt-and-braces for the one LONG-LIVED child: subscriptions dispose it too, but an adapter
  // outliving the editor is the drive's worst failure mode, so it is ended here as well. (The
  // serve's own stdin-EOF shutdown — refusal-answering any pending ask — is the real protection
  // when the whole host dies without running this.)
}
