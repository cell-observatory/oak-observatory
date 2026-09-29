/**
 * Change-map model (zero-token): the whole session's edits assembled as one bird's-eye review diagram.
 * Reuses the folder→file→class tree, flattens it to a per-edit list carrying churn (±lines), review
 * status, Claude's own reasoning, and subagent/risk overlays — with strict per-task attribution from
 * Claude's own plan (to-dos ∪ the task system) and per-prompt slices of everything an ask produced.
 * One assembly, so the Folders strip + Files ledger render identically in VS Code and JetBrains off
 * the CLI `changemap --json`.
 *
 * Everything here is derived from what the observatory already parses — no model calls, nothing stored.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EditStatus, EditRecord, readLog, minOf, maxOf, logPath, readScopeOverrides, rootDir, isSafeSessionId } from './store';
import { canonPath } from './paths';
import { fileExt, fileCategory, type FileCategory } from './filetype';
import { buildEditTree, EditTree, TreeEdit, TreeFolder, TreeFile } from './tree';
import { reasoningByEdit, transcriptInsights, sessionViewTitle, sessionTitleParts, findTranscript, flagsFor } from './observe';
import { isCodexTranscriptFile } from './codex-events';
import { remoteSessionTitle } from './remote-titles';
import { parseActions, summarizeActions, compactLabel } from './actions';
import { parseSubagents, allSessionTaskRows } from './subagents';
import { buildEgressReport } from './egress';
import { projectSessionIds, listRepoSiblings, SiblingSession, isFoldedAge } from './fleet';
import { parseWorkflows, workflowWindows, workflowForTs } from './workflows';
import { taskSnaps, digest12 } from './tasks';
import { sessionPrompts } from './prompts';
import { sessionProcesses } from './processes';
import { cachedByFiles } from './fscache';
import { derivedInventory, withDerivedInventory } from './derived';
import { projectDir } from './session';
import { transcriptFacts, TRANSCRIPT_FACTS_VERSION } from './derived-transcript';

/** One edit (review unit) placed in the map: where it landed, how big, how reviewed, why, and which goal. */
export interface ChangeMapEdit {
  id: number; // the review-unit's representative edit id — drills via claudeObservatory.viewChanges
  rel: string; // workspace-relative path, forward slashes
  module: string; // immediate parent dir (the treemap's module bucket); '' for a root file
  file: string; // basename
  cls: string | null; // class/function it fell in, or null (file scope)
  added: number;
  removed: number;
  status: EditStatus; // pending | kept | undone
  ts: number;
  agent: boolean; // best-effort: a subagent authored this edit (only set when correlated, never guessed)
  risk: string | null; // a warn-level flag (secret / debug / large deletion / deleted file), else null
  reasoning: string | null; // first line of Claude's words for this edit (from the transcript)
  taskId: string | null; // per-TASK: the stable taskId whose STRICT in_progress interval this edit fell in, else null (unassigned)
  subagentId: string | null; // per-SUBAGENT: the subagent (agentId) that authored this edit, else null (main-chain or unattributed)
  workflowId: string | null; // per-WORKFLOW: the wf_<id> whose agent ts-window this edit fell in, else null (none / ambiguous)
}

/** One touched file, rolled up — the row a "ranked ledger" renders. */
export interface ChangeMapFile {
  rel: string; // workspace-relative path (the identity)
  module: string; // its module bucket (immediate parent dir) — the filter key
  moduleLabel: string; // pre-rendered display label, so no front-end re-derives it
  file: string; // basename
  churn: number; // added+removed across this file's units
  cnt: number; // review units in this file
  added: number;
  removed: number;
  kept: number;
  pending: number;
  undone: number;
  /** Worst-unreviewed-wins rollup (see `fileStatus`) — what colours the row. */
  status: EditStatus;
  /** Most-recent edit id in this file — the drill-through target (open its diff / review). */
  maxId: number;
  /** Timestamp of the most-recent edit to this file — drives the "N min ago" column and the time sort. */
  maxTs: number;
  /** Bare lowercased extension ('ts', 'py', '') — the extension filter key. */
  ext: string;
  /** Which of the six type buckets this file falls in — the file-type filter key. */
  category: FileCategory;
  classes: string[]; // distinct classes/functions touched
  agent: boolean; // any edit subagent-authored
  risk: string | null; // first warn-level flag, if any
  reason: string | null; // first line of Claude's reasoning for this file
}

/** One module bucket (keyed by display LABEL) — the segment a "proportion strip" renders. */
export interface ChangeMapModule {
  module: string; // the bucket's identity — equals `label` (a renderer filters files by `f.moduleLabel`)
  label: string; // display label (see `moduleLabel`); one row per distinct label
  churn: number;
  cnt: number;
  added: number;
  removed: number;
  kept: number;
  pending: number;
  undone: number;
  status: EditStatus;
  files: number;
  /** Timestamp of the most-recent edit under this folder — for the "N min ago" column and time sort. */
  maxTs: number;
}

export interface ChangeMapSummary {
  session: string;
  title?: string; // human-readable session name (sessionViewTitle: a Codex session's own title, else preferredSessionTitle — a rename, else the claude.ai Remote Control title, else Claude's ai-title, else the first user prompt; '' when none) — the Overview session selector + the Stats panel show it instead of the raw id
  units: number; // edits after same-code collapse (what the map draws)
  rawEdits: number; // raw store edits
  pending: number;
  kept: number;
  undone: number;
  added: number;
  removed: number;
  actions: number;
  errors: number;
  subagents: number;
  fleet: number; // sibling sessions in this project
  egress: number; // off-machine destinations
  compactions: number; // context compactions the harness performed this session
  spanMs: number; // wall-clock span of the session's actions
  /** The workspace root `rel` paths are relative to — what lets a renderer resolve an
   *  outside-workspace `../..` rel back to the REAL path it names (additive, 0.10.0). */
  root: string;
}

/** Per-TASK rollup row (strict spans). `taskId: null` is the explicit unassigned bucket. */
export interface TaskRoll {
  taskId: string | null; // null = unassigned (edits in no strict in_progress interval)
  edits: number;
  added: number;
  removed: number;
  pending: number;
  kept: number;
  undone: number;
}

/**
 * A task identity from the STRICT-span model — the authoritative taskId↔content mapping that keys
 * `edit.taskId`, `rollupByTask`, task-scoped keep/undo, and the cross-agent task log. Built from the
 * to-dos that actually held an in_progress interval (so it joins `rollupByTask` by `taskId`), NOT from
 * the latest snapshot.
 */
export interface TaskInfo {
  taskId: string; // === taskId(content); the join key for rollupByTask / tasklog / the Tasks tab
  content: string; // the to-do text
  firstTs: number; // earliest in_progress start
  lastTs: number; // latest in_progress end
}

/** Per-SUBAGENT rollup row. `subagentId: null` is the main-chain (or unattributed) bucket. */
export interface SubagentRoll {
  subagentId: string | null; // null = main-chain / unattributed
  edits: number;
  added: number;
  removed: number;
  pending: number;
  kept: number;
  undone: number;
}

/** Per-WORKFLOW rollup row. `workflowId: null` is the not-a-workflow (main-chain / ambiguous) bucket. */
export interface WorkflowRoll {
  workflowId: string | null; // null = main-chain / no-workflow / ambiguous
  edits: number;
  added: number;
  removed: number;
  pending: number;
  kept: number;
  undone: number;
}

/** One workflow's Overview tab: its ts-window-attributed edits rolled up, its touched files, its identity. */
export interface ChangeMapWorkflow {
  id: string; // the wf_<id>
  name: string; // meta.name / script stem / the id (from parseWorkflows)
  running: boolean; // still in flight (from parseWorkflows)
  rollup: { edits: number; added: number; removed: number; pending: number; kept: number; undone: number };
  files: ChangeMapFile[]; // this workflow's touched files, churn-desc (a per-workflow rollupFiles)
  taskIds: string[]; // distinct non-null taskIds among this workflow's edits (cross-dimension join)
}

/**
 * One user PROMPT as a change-map slice: everything that ask produced, aggregated exactly the way a
 * workflow's slice is, so a renderer can swap one for the other and draw the same strip/ledger.
 *
 * This is the axis a PERSON reads a session by. Selecting a prompt narrows every other view to the
 * work that ask caused — its folders and files on the right; its subagents, workflow runs, tasks and
 * background shells on the left. Attribution is by START time (core's rule for prompts): a shell
 * launched by #4 stays #4's even when it exits during #7.
 */
export interface ChangeMapPrompt {
  id: string; // stable prompt id — the same one `prompts --json` emits
  index: number; // 1-based chronological position, the way a person counts their own turns
  /** The ask itself, whitespace-collapsed and COMPLETE — renderers wrap it; nothing here is clipped. */
  text: string;
  /** First line, capped — for one-line contexts (a button label, a tooltip head). */
  title: string;
  ts: number;
  endTs: number; // 0 while this is the ask still being answered
  rollup: { edits: number; added: number; removed: number; pending: number; kept: number; undone: number };
  files: ChangeMapFile[]; // this ask's touched files, churn-desc (a per-prompt rollupFiles)
  modules: ChangeMapModule[]; // …and their folder buckets, so the strip needs no re-aggregation
  /** This ask's DISPLAY-unit edit ids (same-code groups collapsed to their representative), capture
   *  order — the review scope of "accept this ask". Reverting a straddling group needs the raw members,
   *  which is what [checkpointScope] expands them to. */
  editIds: number[];
  /** Subagents spawned while answering (their own agentIds — what a fleet row is keyed by). */
  agentIds: string[];
  /** Workflow runs started while answering (wf_<id>). */
  workflowIds: string[];
  /** Background shells launched while answering (the harness shell id — what a Processes row shows). */
  processIds: string[];
  actions: number;
  errors: number;
  compactions: number;
  durationMs: number;
}

/** Per-AGENT (per-session) rollup row — one per built change-map, worktree-aware when fed siblings. */
export interface AgentRoll {
  session: string;
  edits: number;
  added: number;
  removed: number;
  pending: number;
  kept: number;
  undone: number;
  files: number;
}

/** A context compaction, ordered by time — the Actions timeline and the Stats readout render these. */
export interface CompactionMarker {
  ts: number;
  trigger: string;
  preTokens: number;
  postTokens: number;
  /** This event's own drop (pre − post), never the session-cumulative figure. */
  droppedTokens: number;
  /** The harness's running session total, for a "dropped so far" readout. */
  cumulativeDropped: number;
  durationMs: number;
  /** The one-line summary every surface prints (built once in core — see `compactLabel`). */
  label: string;
}

export interface ChangeMap {
  summary: ChangeMapSummary;
  edits: ChangeMapEdit[];
  /** Context compactions during this session, oldest first — the Actions timeline carries the same
   *  events as 'compact' rows, and Stats prints the one-line readout. */
  compactions: CompactionMarker[];
  /** Per-file rollup, churn-desc. Rendered directly — front-ends must not re-aggregate. */
  files: ChangeMapFile[];
  /** Per-module rollup, churn-desc. Rendered directly — front-ends must not re-aggregate. */
  modules: ChangeMapModule[];
  /** Per-TASK rollup (strict spans), incl. the explicit `taskId: null` unassigned bucket. */
  rollupByTask: TaskRoll[];
  /** Per-SUBAGENT rollup, incl. the `subagentId: null` main-chain bucket. */
  rollupBySubagent: SubagentRoll[];
  /** Per-WORKFLOW rollup, incl. the `workflowId: null` no-workflow/ambiguous bucket. */
  rollupByWorkflow: WorkflowRoll[];
  /** One entry per workflow that produced ts-window-attributed edits — the Overview's per-workflow tabs
   *  (edits rolled up + touched files), aggregated here so renderers stay thin. */
  workflows: ChangeMapWorkflow[];
  /**
   * The session partitioned by what the USER asked for — one slice per prompt, in order. Only built
   * when `opts.prompts` is set (the Prompts window's own scope source), because it costs one more
   * transcript pass and the fleet builds dozens of sibling maps per refresh that never need it.
   */
  prompts: ChangeMapPrompt[];
  /**
   * Strict-span task identities (taskId → content), the authoritative label + join source for
   * `rollupByTask`, the Tasks tab, and the cross-agent task log. Covers exactly the tasks that held
   * a real in_progress interval — so it joins `rollupByTask` by `taskId`.
   */
  tasks: TaskInfo[];
}

/** Immediate parent directory of a rel path (the module bucket); '' when the file sits at the root. */
function moduleOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i >= 0 ? rel.slice(0, i) : '';
}

/**
 * Display label for a module bucket: '' → '(root)', an out-of-workspace path → '(external)', else
 * strip the monorepo noise (a `packages/` prefix and a trailing `/src`) so `packages/core/src`
 * reads as `core`. Lives here, not in a renderer, so every front-end labels a bucket identically.
 */
export function moduleLabel(module: string): string {
  if (!module) return '(root)';
  if (module.startsWith('..')) return '(external)'; // edited outside the workspace root
  let s = module;
  if (s.startsWith('packages/')) s = s.slice('packages/'.length);
  if (s.endsWith('/src')) s = s.slice(0, -'/src'.length);
  return s;
}

/**
 * Roll a set of edit-status counts up to ONE status for a file/module — worst-unreviewed-wins, so a
 * parent never reads as reviewed while something under it is still pending. ('undone' surfaces as
 * "reverted" in the UIs; the vocabulary here stays EditStatus so there's only one status language.)
 */
export function fileStatus(c: { pending: number; undone: number }): EditStatus {
  if (c.pending > 0) return 'pending';
  if (c.undone > 0) return 'undone';
  return 'kept';
}

/** Group the placed edits into per-file rows (churn-desc). */
function rollupFiles(edits: ChangeMapEdit[]): ChangeMapFile[] {
  const by = new Map<string, ChangeMapFile>();
  const classes = new Map<string, Set<string>>();
  for (const e of edits) {
    let f = by.get(e.rel);
    if (!f) {
      f = {
        rel: e.rel, module: e.module, moduleLabel: moduleLabel(e.module), file: e.file,
        churn: 0, cnt: 0, added: 0, removed: 0,
        kept: 0, pending: 0, undone: 0, status: 'kept', maxId: -1, maxTs: 0,
        ext: fileExt(e.rel), category: fileCategory(e.rel), classes: [],
        agent: false, risk: null, reason: null,
      };
      by.set(e.rel, f);
      classes.set(e.rel, new Set());
    }
    f.churn += e.added + e.removed;
    f.added += e.added;
    f.removed += e.removed;
    f.cnt++;
    if (e.status === 'kept') f.kept++;
    else if (e.status === 'undone') f.undone++;
    else f.pending++;
    if (e.cls) classes.get(e.rel)!.add(e.cls);
    if (e.agent) f.agent = true;
    if (e.risk && !f.risk) f.risk = e.risk;
    if (e.reasoning && !f.reason) f.reason = e.reasoning;
    if (e.id > f.maxId) f.maxId = e.id; // newest edit = what a click on this row opens
    if (e.ts > f.maxTs) f.maxTs = e.ts; // most-recent edit time — the "N min ago" + time sort
  }
  const out = [...by.values()];
  for (const f of out) {
    f.classes = [...classes.get(f.rel)!];
    f.status = fileStatus(f);
  }
  out.sort((a, b) => b.churn - a.churn || a.rel.localeCompare(b.rel));
  return out;
}

/**
 * Roll the per-file rows up into module buckets (churn-desc). Keyed by the DISPLAY LABEL, not the raw
 * parent dir — so a package edited both at its root and under `src/` (`packages/vscode/package.json`
 * → `packages/vscode` and `packages/vscode/src/extension.ts` → `packages/vscode/src`) folds into ONE
 * `vscode` bucket instead of two same-named strip segments. On a module row `module === label` (the
 * bucket's identity); files keep their raw `module`, so a renderer filters by `f.moduleLabel`.
 */
function rollupModules(files: ChangeMapFile[]): ChangeMapModule[] {
  const by = new Map<string, ChangeMapModule>();
  for (const f of files) {
    const key = f.moduleLabel;
    let m = by.get(key);
    if (!m) {
      m = {
        module: key, label: key, churn: 0, cnt: 0, added: 0, removed: 0,
        kept: 0, pending: 0, undone: 0, status: 'kept', files: 0, maxTs: 0,
      };
      by.set(key, m);
    }
    if (f.maxTs > m.maxTs) m.maxTs = f.maxTs;
    m.churn += f.churn;
    m.cnt += f.cnt;
    m.added += f.added;
    m.removed += f.removed;
    m.kept += f.kept;
    m.pending += f.pending;
    m.undone += f.undone;
    m.files++;
  }
  const out = [...by.values()];
  for (const m of out) m.status = fileStatus(m);
  out.sort((a, b) => b.churn - a.churn || a.module.localeCompare(b.module));
  return out;
}

/** First non-blank line of some text, capped — the tooltip / drill-rail "why". */
function firstLine(s: string, cap = 160): string {
  const l = s.split('\n').find((x) => x.trim()) ?? '';
  const t = l.trim();
  return t.length > cap ? t.slice(0, cap - 1) + '…' : t;
}

/** Flatten the folder/file/class tree into (rel, class, edit) rows — the leaves the map places. */
function flattenTree(tree: EditTree): { rel: string; cls: string | null; edit: TreeEdit }[] {
  const out: { rel: string; cls: string | null; edit: TreeEdit }[] = [];
  const walk = (folders: TreeFolder[], files: TreeFile[]): void => {
    for (const f of files) {
      for (const c of f.classes) for (const e of c.edits) out.push({ rel: f.rel, cls: c.name, edit: e });
      for (const e of f.loose) out.push({ rel: f.rel, cls: null, edit: e });
    }
    for (const sub of folders) walk(sub.folders, sub.files);
  };
  walk(tree.folders, tree.files);
  return out;
}

interface TodoSnap {
  ts: number;
  /** src marks TASK-born items (tasks.ts snapshots) — provenance for the merged plan timeline. */
  todos: { content: string; status: string; src?: 'task' }[];
}

/**
 * The PLAN snapshots the strict-span model consumes: TodoWrite ∪ the task system (TaskCreate/TaskUpdate,
 * mined in tasks.ts), merged on one timeline into the same full-list shape — so task-planned sessions
 * get real per-task attribution through the identical machinery. Todos win duplicate titles (the
 * bundled demo plans both ways) so the two systems never mint twin tasks.
 */
function planSnaps(transcriptPath: string): TodoSnap[] {
  // Sort by ts: the merge below walks both lists as if they were ascending, and BOTH sources emit in
  // transcript LINE order — a transcript is not ts-ordered (one real session steps backwards 438
  // times). An inverted snapshot yields a task whose firstTs > lastTs, which silently attributes zero
  // edits and returns an empty feed for a task that did plenty — and worse, hands the edits that
  // belonged to it to the neighbouring task, so a task-scoped keep/undo acts on edits that were never
  // part of it. todoSnaps needs this exactly as much as taskSnaps does, and is the commoner path:
  // a session that never used the task system returns straight out of the `!tasks.length` branch below.
  const todos = todoSnaps(transcriptPath).slice().sort((a, b) => a.ts - b.ts);
  const tasks = taskSnaps(transcriptPath).slice().sort((a, b) => a.ts - b.ts);
  if (!tasks.length) return todos;
  if (!todos.length) return tasks;
  const norm = (s: string) => s.trim().toLowerCase();
  const out: TodoSnap[] = [];
  let i = 0;
  let j = 0;
  let curTodos: TodoSnap['todos'] = [];
  let curTasks: TodoSnap['todos'] = [];
  while (i < todos.length || j < tasks.length) {
    const tTs = i < todos.length ? todos[i].ts : Infinity;
    const kTs = j < tasks.length ? tasks[j].ts : Infinity;
    let ts: number;
    if (tTs <= kTs) {
      curTodos = todos[i].todos;
      ts = tTs;
      i++;
    } else {
      curTasks = tasks[j].todos;
      ts = kTs;
      j++;
    }
    const seen = new Set(curTodos.map((d) => norm(d.content)));
    out.push({ ts, todos: [...curTodos, ...curTasks.filter((k) => !seen.has(norm(k.content)))] });
  }
  return out;
}

/** Ordered TodoWrite snapshots from the main transcript (each carries its ts + the full list). */
function todoSnaps(transcriptPath: string): TodoSnap[] {
  return transcriptFacts(transcriptPath).todos;
}

export function foldTodoFacts(out: TodoSnap[], o: any): void {
  if (o.isSidechain === true) return; // a subagent's checklist is not the main plan
  const msg = o.message;
  if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) return;
  const ts = toMs(o.timestamp ?? o.ts);
  for (const b of msg.content) {
    if (b && b.type === 'tool_use' && b.name === 'TodoWrite' && b.input && Array.isArray(b.input.todos)) {
      const todos = b.input.todos
        .filter((td: any) => td && typeof td.content === 'string')
        .map((td: any) => ({ content: String(td.content).trim(), status: String(td.status || '') }));
      if (todos.length) out.push({ ts, todos });
    }
  }
}

function toMs(v: unknown): number {
  if (typeof v === 'number' && isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  return 0;
}

/** Stable per-task identity (first-seen wins), tracked while building strict spans. */
export type TaskIdentity = { taskId: string; content: string; firstTs: number };

/**
 * Stable task id — a content hash, NOT the old positional `ch${i}`. Reordering or inserting to-dos
 * never shifts it, and two to-dos with identical text deterministically share ONE id (an honest
 * collision → one task) instead of the old last-wins. `firstSeenTs` pins a task's first-seen time in
 * the identity map so its `firstTs` doesn't drift if the to-do reappears later; it does NOT enter the
 * hash (identical text must stay one id). The hash core is shared with tasks.taskIdForSubject() via
 * digest12(), so the two can't drift; `firstSeenTs` stays in the signature (callers + tests pass it
 * positionally) but remains intentionally unhashed.
 */
export function taskId(content: string, firstSeenTs: number): string {
  return digest12(content);
}

/** A REAL in_progress interval for the taskId model — no edge extension (cf. `Span`). */
interface StrictSpan {
  taskId: string;
  content: string;
  start: number; // ts the to-do ENTERED in_progress — the first span does NOT reach back to 0
  end: number; // ts it LEFT in_progress; an open (never-completed) span ends at its LAST observed in_progress mtime, NOT +∞
}

/**
 * The strict in_progress timeline for the taskId model, with NO edge fill. `start` is exactly when a
 * to-do entered in_progress; `end` is when it left (a later checkpoint no longer shows it
 * in_progress). A to-do that never completes ends at its LAST observed in_progress mtime, not +∞.
 * So an edit made before the first in_progress, or after the last one closed, falls in NO interval and
 * is honestly `unassigned` — never force-filed onto the head/tail task. This is the destructive-safety
 * rule: a task's keep/undo set must never include an edit that was never part of that task.
 */
function inProgressSpansStrict(snaps: TodoSnap[]): StrictSpan[] {
  const spans: StrictSpan[] = [];
  const identity = new Map<string, TaskIdentity>(); // first-seen wins: pins each task's firstTs + id
  let cur: StrictSpan | null = null;
  let lastSeen = 0; // last checkpoint ts at which `cur`'s to-do was still in_progress
  for (const s of snaps) {
    if (!s.ts) continue;
    const ip = s.todos.find((t) => t.status === 'in_progress');
    const content = ip ? ip.content : null;
    if (content === (cur ? cur.content : null)) {
      if (cur) lastSeen = s.ts; // same task still in_progress at this checkpoint
      continue;
    }
    if (cur) cur.end = s.ts; // it left in_progress here — a REAL end, never +∞
    if (content) {
      let id = identity.get(content);
      if (!id) {
        id = { taskId: taskId(content, s.ts), content, firstTs: s.ts };
        identity.set(content, id);
      }
      cur = { taskId: id.taskId, content, start: s.ts, end: s.ts };
      lastSeen = s.ts;
      spans.push(cur);
    } else {
      cur = null;
    }
  }
  if (cur) cur.end = lastSeen; // open span: end at its last observed in_progress mtime, never +∞
  return spans;
}

/** Strict ts→taskId lookup over pre-built strict spans (NO edge fill): a ts in no REAL interval → null. */
function strictTaskForTs(strictSpans: StrictSpan[], ts: number): string | null {
  if (!ts) return null;
  for (const sp of strictSpans) if (ts >= sp.start && ts < sp.end) return sp.taskId;
  return null;
}

/** Fold one edit's ±lines and review status into a running rollup accumulator. */
function foldStatus(
  acc: { edits: number; added: number; removed: number; pending: number; kept: number; undone: number },
  e: ChangeMapEdit,
): void {
  acc.edits++;
  acc.added += e.added;
  acc.removed += e.removed;
  if (e.status === 'kept') acc.kept++;
  else if (e.status === 'undone') acc.undone++;
  else acc.pending++;
}

/**
 * Per-TASK rollup keyed by stable `taskId` (strict spans). Edits in no strict in_progress interval
 * collect in an explicit `taskId: null` bucket — never swept into a neighbour. Edit-count desc, null last.
 */
export function rollupByTask(edits: ChangeMapEdit[]): TaskRoll[] {
  const by = new Map<string | null, TaskRoll>();
  for (const e of edits) {
    let r = by.get(e.taskId);
    if (!r) {
      r = { taskId: e.taskId, edits: 0, added: 0, removed: 0, pending: 0, kept: 0, undone: 0 };
      by.set(e.taskId, r);
    }
    foldStatus(r, e);
  }
  return [...by.values()].sort((a, b) => {
    if (a.taskId === null) return 1;
    if (b.taskId === null) return -1;
    return b.edits - a.edits || a.taskId.localeCompare(b.taskId);
  });
}

/**
 * Per-SUBAGENT rollup keyed by `subagentId` (the authoring subagent's agentId). Main-chain and
 * unattributed edits collect in the `subagentId: null` bucket. Edit-count desc, null last.
 */
export function rollupBySubagent(edits: ChangeMapEdit[]): SubagentRoll[] {
  const by = new Map<string | null, SubagentRoll>();
  for (const e of edits) {
    let r = by.get(e.subagentId);
    if (!r) {
      r = { subagentId: e.subagentId, edits: 0, added: 0, removed: 0, pending: 0, kept: 0, undone: 0 };
      by.set(e.subagentId, r);
    }
    foldStatus(r, e);
  }
  return [...by.values()].sort((a, b) => {
    if (a.subagentId === null) return 1;
    if (b.subagentId === null) return -1;
    return b.edits - a.edits || a.subagentId.localeCompare(b.subagentId);
  });
}

/**
 * Per-WORKFLOW rollup keyed by `workflowId` (the ts-window-attributed workflow). Main-chain and ambiguous
 * edits collect in the `workflowId: null` bucket. Edit-count desc, null last.
 */
export function rollupByWorkflow(edits: ChangeMapEdit[]): WorkflowRoll[] {
  const by = new Map<string | null, WorkflowRoll>();
  for (const e of edits) {
    let r = by.get(e.workflowId);
    if (!r) {
      r = { workflowId: e.workflowId, edits: 0, added: 0, removed: 0, pending: 0, kept: 0, undone: 0 };
      by.set(e.workflowId, r);
    }
    foldStatus(r, e);
  }
  return [...by.values()].sort((a, b) => {
    if (a.workflowId === null) return 1;
    if (b.workflowId === null) return -1;
    return b.edits - a.edits || a.workflowId.localeCompare(b.workflowId);
  });
}

/**
 * Per-AGENT (per-session) rollup — one row per built change-map, summing its edits. Fed the per-sibling
 * `buildChangeMap` results (§3), it renders a worktree fleet as one row per agent; aggregation stays here.
 */
export function rollupByAgent(maps: ChangeMap[]): AgentRoll[] {
  return maps.map((m) => {
    const r: AgentRoll = {
      session: m.summary.session,
      edits: 0, added: 0, removed: 0, pending: 0, kept: 0, undone: 0,
      files: m.files.length,
    };
    for (const e of m.edits) foldStatus(r, e);
    return r;
  });
}

/** Build the change-map for a session. `root` sets display-relative paths (defaults to cwd). */
export function buildChangeMap(
  cwd: string,
  session: string,
  opts: { root?: string; prompts?: boolean } = {},
): ChangeMap {
  const root = opts.root ?? cwd;
  const tree = buildEditTree(session, { root });
  const flat = flattenTree(tree);
  const log = readLog(session);
  const byId = new Map<number, EditRecord>(log.map((r) => [r.id, r]));
  const reasoning = reasoningByEdit(cwd, session);

  // Subagent-authored edit ids — best-effort, only where an agent action carried a correlated editId.
  const subs = parseSubagents(cwd, session);
  const agentEditIds = new Set<number>();
  const editIdToSubagent = new Map<number, string>(); // editId → the subagent (agentId) that authored it
  for (const s of subs) for (const a of s.actions) if (a.editId != null) {
    agentEditIds.add(a.editId);
    editIdToSubagent.set(a.editId, s.agentId);
  }

  const insights = transcriptInsights(cwd, session);
  const transcript = findTranscript(cwd, session);
  const snaps = transcript ? planSnaps(transcript) : [];
  const strictSpans = inProgressSpansStrict(snaps); // REAL intervals — the taskId model (rollups + task review ops)
  // Strict ts→taskId lookup — NO edge fill: an edit in no REAL interval → null (unassigned).
  const taskForTs = (ts: number): string | null => strictTaskForTs(strictSpans, ts);

  // Workflow ts-windows for workflow→edit attribution (§C): an edit whose ts lands in exactly one
  // workflow's agent-window is that workflow's; in two → ambiguous → null; in none → null.
  const wfWindows = workflowWindows(cwd, session);

  const edits: ChangeMapEdit[] = flat.map(({ rel, cls, edit }) => {
    const rec = byId.get(edit.id);
    const flags = rec ? flagsFor(session, rec, log) : [];
    const warn = flags.find((f) => f.level === 'warn');
    const rsn = reasoning.get(edit.id);
    return {
      id: edit.id,
      rel,
      module: moduleOf(rel),
      file: path.basename(rel),
      cls,
      added: edit.added,
      removed: edit.removed,
      status: edit.status,
      ts: edit.ts,
      agent: agentEditIds.has(edit.id),
      risk: warn ? warn.message : null,
      reasoning: rsn ? firstLine(rsn) : null,
      taskId: taskForTs(edit.ts),
      subagentId: editIdToSubagent.get(edit.id) ?? null,
      workflowId: workflowForTs(wfWindows, edit.ts),
    };
  });

  // Summary — headline counts, all from pieces already parsed above (+ one action scan for errors/egress).
  const actions = parseActions(cwd, session);
  const aSum = summarizeActions(actions);

  // Compactions ride that SAME action scan (they are 'compact' rows) — no extra transcript read, which
  // matters because buildChangeMap runs once per fleet sibling. Ordered by time; the Actions timeline
  // and the Stats readout render them.
  const compactions: CompactionMarker[] = actions
    .filter((a) => a.compact)
    .map((a) => ({ ...a.compact!, label: compactLabel(a.compact!) }))
    .sort((a, b) => a.ts - b.ts);

  const summary: ChangeMapSummary = {
    session,
    title: (sessionViewTitle(cwd, session, insights) ?? '').replace(/\s+/g, ' ').trim(),
    units: edits.length,
    rawEdits: log.length,
    pending: edits.filter((e) => e.status === 'pending').length,
    kept: edits.filter((e) => e.status === 'kept').length,
    undone: edits.filter((e) => e.status === 'undone').length,
    added: edits.reduce((n, e) => n + e.added, 0),
    removed: edits.reduce((n, e) => n + e.removed, 0),
    actions: aSum.total,
    errors: aSum.errors,
    subagents: subs.length,
    fleet: mapProjectSessionIds(cwd).filter((id) => id !== session).length,
    egress: buildEgressReport(actions).length,
    compactions: compactions.length,
    spanMs: aSum.lastTs && aSum.firstTs ? Math.max(0, aSum.lastTs - aSum.firstTs) : 0,
    root,
  };

  // Aggregate ONCE, here — every front-end (VS Code webview, JetBrains Swing) renders these rows as
  // given. Duplicating this per-editor is exactly the drift the "shared logic in core" rule prevents.
  const files = rollupFiles(edits);
  const modules = rollupModules(files);

  // Strict-span task identities — the authoritative taskId↔content join source (covers exactly the
  // edit-producing tasks, so `tasklog` labels + the Tasks tab join `rollupByTask` by taskId).
  const taskById = new Map<string, TaskInfo>();
  for (const sp of strictSpans) {
    const t = taskById.get(sp.taskId);
    if (!t) taskById.set(sp.taskId, { taskId: sp.taskId, content: sp.content, firstTs: sp.start, lastTs: sp.end });
    else {
      t.firstTs = Math.min(t.firstTs, sp.start);
      t.lastTs = Math.max(t.lastTs, sp.end);
    }
  }
  const tasks = [...taskById.values()].sort((a, b) => a.firstTs - b.firstTs);

  // Per-WORKFLOW Overview tabs (§D): group the workflow-attributed edits by workflowId — one entry per
  // workflow that produced attributed edits, carrying its name/running (from parseWorkflows) + a
  // per-workflow file rollup. Built HERE so the CLI/editors render tabs without re-aggregating.
  const wfMeta = new Map<string, { name: string; running: boolean }>();
  for (const w of parseWorkflows(cwd, session)) wfMeta.set(w.id, { name: w.name, running: w.running });
  const editsByWorkflow = new Map<string, ChangeMapEdit[]>();
  for (const e of edits) {
    if (e.workflowId === null) continue;
    if (!editsByWorkflow.has(e.workflowId)) editsByWorkflow.set(e.workflowId, []);
    editsByWorkflow.get(e.workflowId)!.push(e);
  }
  const workflows: ChangeMapWorkflow[] = [...editsByWorkflow.entries()].map(([id, wfEdits]) => {
    const rollup = { edits: 0, added: 0, removed: 0, pending: 0, kept: 0, undone: 0 };
    const taskIds = new Set<string>();
    for (const e of wfEdits) {
      foldStatus(rollup, e);
      if (e.taskId) taskIds.add(e.taskId);
    }
    const meta = wfMeta.get(id);
    return {
      id,
      name: meta ? meta.name : id,
      running: meta ? meta.running : false,
      rollup,
      files: rollupFiles(wfEdits),
      taskIds: [...taskIds],
    };
  });
  workflows.sort((a, b) => b.rollup.edits - a.rollup.edits || a.id.localeCompare(b.id));

  return {
    summary, edits, compactions, files, modules, tasks,
    rollupByTask: rollupByTask(edits),
    rollupBySubagent: rollupBySubagent(edits),
    rollupByWorkflow: rollupByWorkflow(edits),
    workflows,
    // Per-PROMPT slices are opt-in: they need the user's turns, which is one more transcript pass, and
    // the fleet builds a map per worktree sibling on every refresh — none of which is ever scoped by an
    // ask typed into THIS window. The self map asks for them; siblings don't.
    prompts: opts.prompts ? promptSlices(cwd, session, { edits, subs }) : [],
  };
}

/**
 * Group the session's work by the ask that caused it.
 *
 * Everything here is a fold over pieces `buildChangeMap` already computed — the only new reads are the
 * user's turns (`sessionPrompts`, memoized against the transcript + log) and the background shells,
 * whose ids are what a Processes row is keyed by. Attribution is by START time throughout, so a slice
 * answers "what did asking for this set in motion", not "what finished while I was typing".
 */
function promptSlices(
  cwd: string,
  session: string,
  ctx: {
    edits: ChangeMapEdit[];
    subs: { agentId: string; ts: number }[];
  }
): ChangeMapPrompt[] {
  const asks = sessionPrompts(cwd, session);
  if (!asks.length) return [];
  const slices: ChangeMapPrompt[] = asks.map((r) => ({
    id: r.id,
    index: r.index,
    text: r.text,
    title: r.title,
    ts: r.ts,
    endTs: r.endTs,
    rollup: { edits: 0, added: 0, removed: 0, pending: 0, kept: 0, undone: 0 },
    files: [],
    modules: [],
    editIds: r.editIds.slice(),
    agentIds: [],
    workflowIds: [],
    processIds: [],
    actions: r.actions,
    errors: r.errors,
    compactions: r.compactions,
    durationMs: r.durationMs,
  }));
  // Which ask owned a given moment — the same binary search `sessionPrompts` attributes with, over
  // ask times that are sorted and tile the session from the first prompt onward. A moment BEFORE the
  // first ask belongs to no prompt (session setup answers to nobody).
  const owner = (ts: number): number => {
    if (!ts || ts < slices[0].ts) return -1;
    let lo = 0;
    let hi = slices.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (slices[mid].ts <= ts) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  // 1. the edits, and with them the files/folders each ask touched. An `assign` override moves an
  //    edit's slot exactly as it moves `sessionPrompts`' editIds (copied above) — the rollups here
  //    are re-derived over ctx.edits, and the two attributions must never disagree. Everything
  //    non-edit (subagents, workflows, shells) stays temporal; overrides are per record id.
  const overrides = readScopeOverrides(session);
  const slotById = new Map(slices.map((s, i) => [s.id, i] as const));
  const editsByAsk = new Map<number, ChangeMapEdit[]>();
  for (const e of ctx.edits) {
    const want = overrides.get(e.id);
    const oi = want === undefined ? undefined : slotById.get(want);
    const i = oi !== undefined ? oi : owner(e.ts);
    if (i < 0) continue;
    let arr = editsByAsk.get(i);
    if (!arr) editsByAsk.set(i, (arr = []));
    arr.push(e);
  }
  // 2. subagents by SPAWN time — a fleet row is keyed by the subagent's own agentId, so resolve to that
  //    rather than to the spawning tool_use id (which only the action timeline speaks).
  for (const s of ctx.subs) {
    const i = owner(s.ts);
    if (i >= 0) slices[i].agentIds.push(s.agentId);
  }
  for (const w of parseWorkflows(cwd, session)) {
    const i = owner(w.startedTs || w.lastActivityMs);
    if (i >= 0) slices[i].workflowIds.push(w.id);
  }
  for (const p of sessionProcesses(cwd, session)) {
    const i = owner(p.startedTs);
    if (i >= 0) slices[i].processIds.push(p.id);
  }

  for (let i = 0; i < slices.length; i++) {
    const sl = slices[i];
    const mine = editsByAsk.get(i);
    if (!mine || !mine.length) continue;
    for (const e of mine) foldStatus(sl.rollup, e);
    sl.files = rollupFiles(mine);
    sl.modules = rollupModules(sl.files);
  }
  return slices;
}

/**
 * The RAW store edit ids whose commit ts falls inside a REAL (strict) in_progress interval for `taskId`
 * — the honest per-task attribution that backs task review ops, the cross-agent task log, and the
 * strict rollups. Reads raw store records (never the collapsed change-map units): an edit joins a
 * task's set ONLY via a real interval — never a start=0/end=+∞ edge fill. Composes the single
 * strict-span builder (inProgressSpansStrict), so it can't diverge from the change-map's own
 * attribution. Zero token.
 */
/**
 * Every taskId this session PUBLISHES — the set a task-scoped verb may legitimately be given. Lets a
 * caller tell "that task has no pending edits" apart from "that task does not exist": both come back
 * from keepTask/undoTask as a bare zero, so `task-keep <garbage>` printed a green success.
 *
 * The union of two sources, deliberately. The strict in_progress spans are what task-scoped edit sets
 * are built from — but the Tasks tab also publishes a row per background Agent run
 * (`allSessionTaskRows`), and those never enter an in_progress span, so validating against the spans
 * alone would hard-fail on an id the product itself put on screen. Those ids resolve to an empty edit
 * set, which is the honest answer for them: a quiet zero, not an error.
 */
export function sessionTaskIds(cwd: string, session: string): string[] {
  const transcript = findTranscript(cwd, session);
  const spans = inProgressSpansStrict(transcript ? planSnaps(transcript) : []);
  const ids = new Set(spans.map((s) => s.taskId));
  try {
    for (const row of allSessionTaskRows(cwd, session)) ids.add(row.taskId);
  } catch {
    /* the task/agent rows are a display source — never let them block a review verb */
  }
  return [...ids];
}

export function taskEditIds(cwd: string, session: string, taskId: string): number[] {
  const transcript = findTranscript(cwd, session);
  const strictSpans = inProgressSpansStrict(transcript ? planSnaps(transcript) : []);
  return readLog(session)
    .filter((r) => strictTaskForTs(strictSpans, r.ts) === taskId)
    .map((r) => r.id);
}

// --- cross-process change-map cache (the Overview's dominant cost) ---

/**
 * Bump to invalidate every persisted map after a shape or semantics change.
 *
 * It is folded into the cache FILENAME, not just the stamp inside it, so that two builds which disagree
 * about the stamp's shape use different files instead of fighting over one. They did: a VS Code extension
 * host bundling an older core wrote a 4-field `derivedInputsStamp` to the very same path the CLI wrote a
 * 5-field one to, and since a mismatched stamp means "rebuild, then overwrite", each process's write was
 * a permanent miss for the other — a guaranteed 0 % hit rate for as long as both were installed, with no
 * symptom beyond "the Overview is slow". Orphaned versions do linger (an entry is ~1.5 MB on a large
 * session); the directory is derived, disposable, and already reaped per-session when a session is dropped.
 */
// 3: sibling rows carry COLLAPSED edits/pending (fleet.ts). The stamp inputs did not change, so a v2
// entry stays "valid" while holding the old raw numbers — the fleet would report 2,800 pending against
// the Sessions row's 1,855, from cache, indefinitely. When the MEANING of a cached payload changes, the
// version is the only thing that can tell the two apart.
// 4: the payload was `.observatoryignore`-FILTERED and carried summary.hidden/hiddenFiles. Same
// hazard, same answer: a v3 entry is structurally valid and semantically wrong — it holds counts from
// before any ignore file existed, and lacks the two fields the surfaces read to say what they dropped.
// 5: those two fields are GONE, and the payload is no longer filtered at all — `.observatoryignore`
// became a capture-time rule with one mode, so a matching file is never recorded and there is nothing
// to filter or count on a read path. A v4 entry is once again structurally valid and semantically
// wrong: its `units` counts what a filter left behind, and the surfaces no longer read the two fields
// it carries. Not bumping this is invisible — it serves a stale number from disk, forever.
// Exported so `clean`'s test can plant a LIVE-version payload without hardcoding the number: a test
// that says `3|live` becomes a false alarm the moment this is bumped for a real reason, which is
// exactly what it did here. Deriving it keeps the assertion about the BEHAVIOUR (live survives,
// superseded is reaped) instead of about the current value.
// 6: pasted prompts (`<pasted_content>`) became asks (2026-09-22) — the ask slices are inputs no stamp saw.
// 7: summary.title follows preferredSessionTitle — a rename (`custom-title`), then the Remote Control
//    title from claude.ai, then the ai-title (2026-09-24).
// 8: a Codex session's summary.title is its own title (`codexSessionTitle`), no longer its first prompt
//    read the Claude way — and a build still on 7 must not share (and rebuild) the same files (2026-09-24).
// 9: summary.title is plain text — no markdown heading markers, no line breaks (`plainTitle`) (2026-09-24).
export const MAP_CACHE_VERSION = 9;

/** (mtimeMs:size) for a file, or '' when it can't be stat'd. */
/**
 * A digest of every file in `dir` (name, mtime, size) — the stamp for an input that is a DIRECTORY.
 *
 * A directory's own mtime moves when an entry is added or removed but not when one grows, and a
 * subagent's transcript grows for as long as that agent works. Stat-only, over a handful of files.
 */
function entryStamp(dir: string, name: string): string {
  try {
    const st = fs.statSync(path.join(dir, name));
    return `${name}:${st.mtimeMs}:${st.size}`;
  } catch {
    return `${name}:?`;
  }
}

function dirStamp(dir: string | null): string {
  if (!dir) return '';
  try {
    return fs
      .readdirSync(dir)
      .sort()
      .map((n) => entryStamp(dir, n))
      .join(',');
  } catch {
    return '';
  }
}

/**
 * `dirStamp` one level deeper — for an input directory whose entries are themselves DIRECTORIES.
 *
 * A directory's mtime moves when an entry is added or removed but not when one grows, which is exactly
 * what `dirStamp` exists to work around. Applied to `subagents/workflows/`, whose entries are `wf_<id>/`
 * directories, it hit that same wall one level up: `workflowWindows` reads `wf_<id>/agent-*.jsonl`, and
 * those files grow for as long as the workflow runs without moving their directory's stamp — so a RUNNING
 * workflow's window and its edits' `workflowId` attribution froze at whatever they were when the run's
 * first agent was created.
 */
function nestedDirStamp(dir: string | null): string {
  if (!dir) return '';
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((e) => (e.isDirectory() ? `${e.name}/[${dirStamp(path.join(dir, e.name))}]` : entryStamp(dir, e.name)))
      .join(',');
  } catch {
    return '';
  }
}

/**
 * Everything a change map is derived from, beyond the session's own transcript and store log.
 *
 * `buildChangeMap` also reads the session's subagent transcripts (summary.subagents, rollupBySubagent,
 * prompts[].agentIds), its workflow journals (workflows[]), and the project's OTHER session transcripts
 * (summary.fleet). Keying the cache on the transcript and log alone froze all of that: subagents that
 * only read, and siblings starting in other worktrees, changed no keyed file, so the Overview kept
 * reporting zero of them until something unrelated moved.
 */
function mapProjectSessionIds(cwd: string): string[] {
  return derivedInventory(`project:${cwd}`, () =>
    cachedByFiles('mapProjectInventory', [projectDir(cwd)], () => projectSessionIds(cwd)));
}

export function derivedInputsStamp(cwd: string, session: string, includeWorkspace: boolean): string {
  const transcript = findTranscript(cwd, session);
  const base = transcript ? transcript.replace(/\.jsonl$/, '') : null;
  const subs = base ? path.join(base, 'subagents') : null;
  return [
    derivedInventory(`subagents:${subs}`, () => dirStamp(subs)),
    derivedInventory(`sub-workflows:${subs}`, () => nestedDirStamp(subs ? path.join(subs, 'workflows') : null)),
    derivedInventory(`workflows:${base}`, () => nestedDirStamp(base ? path.join(base, 'workflows') : null)),
    // The project dir's ONLY contribution to a map is `summary.fleet`, a COUNT of the sibling session
    // ids in it (see the projectSessionIds call in buildChangeMap) — so the stamp IS that id list, and
    // never the entries' mtime/size. Stamping those made one session's append invalidate every OTHER
    // session's cached map in the project, because they all share the directory: measured on a repo
    // with 31 siblings, a single live transcript growing by one line rebuilt 33 cache files and cost
    // 14.2 s, against 0.12 s to serve the same Overview from disk. Both editors refresh on the
    // transcript watcher, so that fired on very nearly every tick — the cache almost never hit.
    // Deriving the stamp from the same call the map derives the value from is also what keeps the two
    // from drifting apart later.
    mapProjectSessionIds(cwd).join(','),
    // Only for the session being RENDERED. A sibling's map is the "finished session whose inputs never
    // change again" case this disk cache exists for, and siblings share files with the active session —
    // 14 of 30 on a real repo — so stamping their workspace too made one save rebuild all of them
    // (9.6 s cold, 542 ms warm), for a map whose class attribution nobody is looking at.
    includeWorkspace ? workspaceStamp(session, cwd) : '',
  ].join('|');
}

/** A map's summary.title can change without the transcript moving: the claude.ai title of the session's
 *  Remote Control session, or a Codex session's own title (a rename in Codex's index, an edited brief)
 *  — so the map caches stamp that title too, from cached reads (sidecar-cached parts for Claude; for
 *  Codex its index, cursor and brief), never a transcript scan. Kept out of `derivedInputsStamp`, whose
 *  other users never show a title. */
function titleStamp(cwd: string, session: string): string {
  const transcript = findTranscript(cwd, session);
  if (!transcript) return '';
  if (isCodexTranscriptFile(transcript)) return sessionViewTitle(cwd, session) ?? '';
  return remoteSessionTitle(sessionTitleParts(transcript, session)?.bridge) ?? '';
}


/**
 * (mtimeMs:size) of every WORKSPACE file the session edited — a third input, alongside the transcript
 * and the store log, that the map is genuinely derived from.
 *
 * buildChangeMap reads each edited file off disk to detect its classes and to place each edit in the
 * CURRENT text (buildEditTree → buildFile). Neither the transcript nor the log moves when the user
 * edits that file in their editor, so without this the cache kept serving class names and placements
 * for a version of the file that no longer exists — rename a class and the map still reported the old
 * one until something unrelated happened to touch the transcript.
 *
 * Stat-only, over the distinct files in the log (readLog is memoized), so it costs microseconds.
 */
function workspaceStamp(session: string, root: string): string {
  let files: string[];
  try {
    // ROOT-SCOPED, despite stamping "the workspace": a session's log can reference files outside the
    // worktree, and one of them being SELF-REWRITING makes the cache permanently cold — found live: a
    // session that edited ~/.claude/statusline-last.json, which the status line rewrites every few
    // seconds, so every warm pass rebuilt that session forever. Out-of-root churn is exactly the noise
    // this cache exists to ignore; out-of-root EDITS still invalidate through the log/transcript stamps
    // whenever the session itself acts.
    // canonPath on the root (#43): editors hand over workspace roots with a lower-cased Windows drive
    // letter, while readLog serves canonical record paths — a raw prefix compare would stamp nothing.
    const rootAbs = canonPath(path.resolve(root)) + path.sep;
    files = [...new Set(readLog(session).map((r) => r.file))].filter((f) => path.resolve(f).startsWith(rootAbs)).sort();
  } catch {
    return '';
  }
  const parts: string[] = [];
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      parts.push(`${st.mtimeMs}:${st.size}`);
    } catch {
      parts.push('-'); // absent (deleted or never created) is itself a stable state
    }
  }
  return parts.join(',');
}

function fileStamp(p: string | null): string {
  if (!p) return '';
  try {
    const st = fs.statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
}

/**
 * `buildChangeMap` for a FLEET SIBLING, memoized on disk.
 *
 * Why this exists: the Overview builds one full change map per sibling session, and a mature repo has
 * dozens (27 in this one) — nearly all finished sessions whose transcript and store log will never
 * change again. Each build re-parses that session's transcript, so one Overview refresh cost ~14.5s of
 * pure re-derivation, in a fresh CLI process every few seconds where the in-process memo can never
 * help. Keying the result to its (transcript, log) stamps turns every idle sibling into a file read.
 *
 * Deliberately NOT used for the session being viewed: that transcript is growing, so it would miss
 * every time regardless, and its live counts are the ones a user is watching.
 */
export function siblingChangeMap(cwd: string, session: string, opts: { root: string }): ChangeMap {
  return siblingOverview(cwd, session, opts).map;
}

/** Everything the fleet views derive per sibling that is a pure function of its files. */
export interface SiblingOverview {
  map: ChangeMap;
  /** Fixed-width activity histogram over the session's tool calls — the fleet row's sparkline. */
  sparkline: number[];
  /** The session's latest to-do list, for the fleet row's task line. */
  todos: { content: string; status: string }[];
}

/**
 * The session's own change map, memoized on disk exactly as a sibling's payload is.
 *
 * `changemap --json` runs in a FRESH process on every refresh tick, so the in-process memo never helps
 * it: rebuilding a finished session's map cost seconds of transcript parsing every time, which is what
 * made switching to a long session feel like a hang. The map is a pure function of the transcript and
 * the store log, so keying the result to their stamps is safe — either file changing rebuilds it.
 */
/**
 * Where a session's cached map lives: `<root>/changemap-cache/<sessionId>/<key>.json`.
 *
 * Filed under the session id, not flat, so dropping a session can reap its derived copies — a flat
 * key is a one-way hash of (cwd, session, root) and cannot be reversed to find them. The payload holds
 * the session's prompt text verbatim; leaving it behind after a drop would keep deleted content.
 */
function mapCachePath(session: string, key: string): string {
  const dir = isSafeSessionId(session)
    ? path.join(rootDir(), 'changemap-cache', session)
    : path.join(rootDir(), 'changemap-cache');
  return path.join(dir, `${key}.json`);
}

/**
 * Delete cached map payloads AND shared transcript facts left behind by an EARLIER cache version,
 * for one session.
 *
 * The version is part of the file NAME (see MAP_CACHE_VERSION), which is what stops two builds fighting
 * over one file — but it also means a bump orphans every old file instead of overwriting it. Measured
 * after the 1→2 bump on a real store: 33 unreachable files, 5.02 MB, against 4.46 MB live. More dead
 * cache than live, and `removeSession` only fires when a session is explicitly dropped, so the sessions
 * you actually work in keep theirs forever.
 *
 * Runs from the blob GC (`clean`), never on the read path: identifying an orphan costs a readdir plus a
 * read of each entry's stamp prefix, which is not a price a refresh should pay. Returns bytes reclaimed.
 */
/** Every session id holding a changemap-cache directory — including ids with NO store dir. The GC used
 *  to iterate store ids only, so caches minted for sessions this store no longer tracks were never even
 *  visited: 27 superseded-version payloads found surviving exactly that way, growing per version bump. */
export function cachedMapSessionIds(): string[] {
  try {
    return fs.readdirSync(path.join(rootDir(), 'changemap-cache')).filter((d) => isSafeSessionId(d));
  } catch {
    return []; // no cache tree yet
  }
}

export function pruneStaleMaps(session: string): { removed: number; bytes: number } {
  const out = { removed: 0, bytes: 0 };
  if (!isSafeSessionId(session)) return out;
  const dir = path.join(rootDir(), 'changemap-cache', session);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out; // no cache for this session
  }
  const live = `${MAP_CACHE_VERSION}|`;
  // The shared transcript facts are orphaned the same way the map payloads are, one dead generation
  // per schema bump, per transcript — 471 files / 47.6 MB measured on one real store. Only the LIVE
  // spelling is reachable: every other transcript-facts name, including the pre-versioning
  // `transcript-facts-<key>.json` this release replaced, is addressed by nothing. A publication in
  // flight ends in `.tmp`, never `.json`, so this cannot race the writer.
  const liveFacts = new RegExp(`^transcript-facts-v${TRANSCRIPT_FACTS_VERSION}-[0-9a-f]{64}\\.json$`);
  for (const n of names) {
    if (n.startsWith('transcript-facts-') && n.endsWith('.json')) {
      if (liveFacts.test(n)) continue;
      const p = path.join(dir, n);
      try {
        const size = fs.statSync(p).size;
        fs.unlinkSync(p);
        out.removed++;
        out.bytes += size;
      } catch { /* unreadable or already gone — leave it */ }
      continue;
    }
    // Only the hashed map/view payloads are versioned this way; the sibling caches beside them
    // (placements.json, deltas.json) are content-keyed and own their own version field.
    if (!/^[0-9a-f]{16}\.json$/.test(n)) continue;
    const p = path.join(dir, n);
    try {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(64);
      const read = fs.readSync(fd, buf, 0, 64, 0);
      fs.closeSync(fd);
      // `{"stamp":"<version>|…` — anything whose stamp does not start with the live version is
      // unreachable by construction: the key that would address it hashes to a different filename.
      const head = buf.subarray(0, read).toString('utf8');
      const m = /^\{"stamp":"(\d+)\|/.exec(head);
      if (!m || m[1] + '|' === live) continue;
      const size = fs.statSync(p).size;
      fs.unlinkSync(p);
      out.removed++;
      out.bytes += size;
    } catch {
      /* unreadable or already gone — leave it */
    }
  }
  return out;
}

export function cachedChangeMap(cwd: string, session: string, opts: { root: string; prompts?: boolean }): ChangeMap {
  const transcript = findTranscript(cwd, session);
  const tStamp = fileStamp(transcript);
  const lStamp = fileStamp(logPath(session));
  const build = (): ChangeMap => buildChangeMap(cwd, session, opts);
  if (!tStamp && !lStamp) return build(); // nothing stable to key on
  const stamp = `${MAP_CACHE_VERSION}|${tStamp}|${lStamp}|${opts.prompts ? 'p' : '-'}|${derivedInputsStamp(cwd, session, true)}|${titleStamp(cwd, session)}`;
  // `prompts` belongs in the KEY, not only the stamp: two callers disagreeing about it would otherwise
  // share one filename and each write would be a permanent miss for the other.
  //
  // The corollary bit us immediately: the Overview is the only thing that WRITES this cache, and it
  // always passes `prompts: true`, so any reader passing `false` addresses a filename nothing creates
  // and rebuilds the whole map — in-process, on the extension host, measured at 4.7 s / 1.1 GB on a
  // 7,912-edit session. A reader that wants the Overview's cached answer must ask for the Overview's
  // key. If a genuine prompts-free producer ever appears, this is safe again; until then, `true`.
  const key = crypto
    .createHash('sha256')
    .update(`map v${MAP_CACHE_VERSION} ${opts.prompts ? 'p' : '-'} ${cwd} ${session} ${opts.root}`)
    .digest('hex')
    .slice(0, 16);
  const p = mapCachePath(session, key);
  try {
    const hit = JSON.parse(fs.readFileSync(p, 'utf8')) as { stamp: string; map: ChangeMap };
    if (hit && hit.stamp === stamp && hit.map && hit.map.summary) return hit.map;
  } catch {
    /* absent or unreadable — rebuild */
  }
  const map = build();
  if (!fs.existsSync(logPath(session))) return map;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    // 0600/0700 like every other file in the store (SECURITY.md): this payload carries prompt text.
    fs.writeFileSync(tmp, JSON.stringify({ stamp, map }), { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch {
    /* cache is best-effort */
  }
  return map;
}

/**
 * One sibling's whole fleet payload, memoized on disk.
 *
 * The Overview derives several things per sibling — its change map, an activity sparkline, its current
 * to-dos — and a mature repo has dozens of siblings, nearly all FINISHED sessions whose transcript and
 * store log will never change again. All of it runs in a fresh CLI process every few seconds, where an
 * in-process memo can never help, so each refresh re-parsed every sibling transcript two or three more
 * times over. Keying the finished result to its (transcript, log) stamps turns that into one file read.
 *
 * Live facts (an agent's phase, its subagents' phases) are deliberately NOT cached here: they are
 * staleness-derived, so a frozen copy would report a working agent as done.
 */
/**
 * The Overview's whole payload: the active session's change map, one slice per worktree sibling, the
 * per-agent rollup and the unassigned bucket.
 *
 * This lived inside the CLI's `changemap` command, which meant the VS Code extension — which BUNDLES
 * this module and calls it in-process everywhere else — had to spawn a whole node process to get it.
 * Measured, that spawn cost 1.25 s wall / 1.51 s CPU / 486 MB peak RSS, roughly six times a minute
 * while Claude works, because the transcript watcher drives the refresh. A fresh process can also never
 * keep core's in-process memo, so the 30 sibling maps were re-read every time: 2847 ms on a cold pass
 * against 14 ms on a warm one in the same process.
 *
 * It is here, not there, so that both front-ends run the SAME composition. Duplicating fifty lines of
 * sibling projection into the extension is how the two quietly stop agreeing about what the Overview is.
 */
export function overviewChangeMap(cwd: string, session: string, opts: { root: string }): ChangeMap & {
  rollupByAgent: unknown;
  agents: unknown[];
  unassigned: unknown;
} {
  return withDerivedInventory(() => overviewChangeMapInBatch(cwd, session, opts));
}

function overviewChangeMapInBatch(cwd: string, session: string, opts: { root: string }): ReturnType<typeof overviewChangeMap> {
  const { root } = opts;
  // `prompts: true` — the per-ask slices the Prompts window scopes everything by. Only the ACTIVE
  // session builds them; a sibling worktree's map is never scoped by an ask typed into this window.
  const base = cachedChangeMap(cwd, session, { root, prompts: true });
  // One slice per worktree sibling (the Overview's per-agent tabs). `listRepoSiblings` includes self;
  // with no resolvable repo it returns [] and we degrade to self alone.
  const sibs = listRepoSiblings(cwd, session);
  const seed: SiblingSession[] = sibs.length
    ? sibs
    : [{ id: session, worktree: cwd, gitBranch: null, phase: null } as unknown as SiblingSession];
  const now = Date.now();
  const agents = seed.map((sib) => {
    const lastMs = (sib as { lastMs?: number }).lastMs ?? 0; // transcript mtime — drives tab order
    // The session being RENDERED is never folded, however old it is: the user picked it on purpose,
    // and the whole point of pinning an old session is to look at what it did.
    const self = sib.id === session && sib.worktree === cwd && root === cwd;
    // Fold by ID alone: `self` also demands worktree/root equality (that gate decides whether `base`
    // can be REUSED for the row), but a session launched from a subdirectory has worktree ≠ cwd — and
    // folding it would mark the very session the reader is looking at "not loaded" while the panels
    // around it render the map that was just built. cmdMultitask already folds id-only; now they agree.
    const folded = sib.id !== session && isFoldedAge(lastMs, now);
    const built = self
      ? base // reuse, never rebuild: half the work in the common single-agent case
      : folded
        ? siblingOverviewCached(sib.worktree, sib.id, { root: sib.worktree })?.map ?? null
        : siblingChangeMap(sib.worktree, sib.id, { root: sib.worktree });
    return {
      ...(built ?? unbuiltChangeMap(sib.id)),
      session: sib.id,
      worktree: sib.worktree,
      gitBranch: sib.gitBranch ?? null,
      phase: (sib as { phase?: string | null }).phase ?? null,
      lastMs,
      /** Collapsed in the fleet surfaces — a conversation older than FLEET_FOLD_MS. */
      folded,
      /** False ⇒ the numbers above are placeholders, not findings. Only ever false for a folded row. */
      loaded: built !== null,
    };
  }).sort((a: { lastMs: number }, b: { lastMs: number }) => b.lastMs - a.lastMs); // most recent first
  // The current session's `taskId: null` roll — edits inside no strict task interval — surfaced directly
  // so a renderer never has to dig it out of rollupByTask.
  const unassigned =
    base.rollupByTask.find((r) => r.taskId === null) ??
    { taskId: null, edits: 0, added: 0, removed: 0, pending: 0, kept: 0, undone: 0 };
  // Project each sibling down to what renderers read. The per-sibling `edits` arrays were 1.95 MB of a
  // 3.30 MB payload with nothing consuming them, and a sibling's `prompts` would serialize the SELF
  // entry's per-ask slices a second time in the same payload. The active session's own top-level
  // `edits` is untouched — that is the one tools actually read.
  const slimAgents = agents.map((a) => {
    const { edits: _dropped, prompts: _asks, ...rest } = a as typeof a & { edits?: unknown; prompts?: unknown };
    return rest;
  });
  return { ...base, rollupByAgent: rollupByAgent(agents), agents: slimAgents, unassigned };
}

/** Where a sibling's payload lives and what stamp it must carry, or null when there is nothing to key on. */
function siblingSlot(cwd: string, session: string, opts: { root: string; bins?: number }): { p: string; stamp: string } | null {
  const tStamp = fileStamp(findTranscript(cwd, session));
  const lStamp = fileStamp(logPath(session));
  if (!tStamp && !lStamp) return null; // neither input exists — nothing stable to key on
  const bins = opts.bins ?? 20;
  const stamp = `${MAP_CACHE_VERSION}|${tStamp}|${lStamp}|${bins}|${derivedInputsStamp(cwd, session, false)}|${titleStamp(cwd, session)}`;
  const key = crypto.createHash('sha256').update(`v${MAP_CACHE_VERSION} ${cwd} ${session} ${opts.root}`).digest('hex').slice(0, 16);
  return { p: mapCachePath(session, key), stamp };
}

function readSiblingSlot(slot: { p: string; stamp: string }): SiblingOverview | null {
  try {
    const hit = JSON.parse(fs.readFileSync(slot.p, 'utf8')) as { stamp: string; view: SiblingOverview };
    if (hit && hit.stamp === slot.stamp && hit.view && hit.view.map) return hit.view;
  } catch {
    /* absent or unreadable */
  }
  return null;
}

/**
 * A sibling's payload IF it is already on disk — never builds one.
 *
 * This is what a FOLDED sibling gets (see FLEET_FOLD_MS). A week-old finished conversation is worth
 * showing when the answer is already sitting in the cache, and is not worth seconds of transcript
 * parsing on a refresh nobody asked for. A null here means "not built", which a renderer must show as
 * such — reporting it as an empty session would be a lie with the same shape as the truth.
 */
export function siblingOverviewCached(cwd: string, session: string, opts: { root: string; bins?: number }): SiblingOverview | null {
  const slot = siblingSlot(cwd, session, opts);
  return slot ? readSiblingSlot(slot) : null;
}

export function siblingOverview(cwd: string, session: string, opts: { root: string; bins?: number }): SiblingOverview {
  const slot = siblingSlot(cwd, session, opts);
  const hit = slot ? readSiblingSlot(slot) : null;
  if (hit) return hit;
  const view: SiblingOverview = {
    map: buildChangeMap(cwd, session, opts),
    sparkline: activityBins(parseActions(cwd, session).map((a) => a.ts), opts.bins ?? 20),
    todos: transcriptInsights(cwd, session).todos,
  };
  if (slot && fs.existsSync(logPath(session))) {
    try {
      fs.mkdirSync(path.dirname(slot.p), { recursive: true, mode: 0o700 });
      const tmp = `${slot.p}.${process.pid}.tmp`; // pid-scoped so concurrent CLI processes can't collide
      fs.writeFileSync(tmp, JSON.stringify({ stamp: slot.stamp, view }), { mode: 0o600 });
      fs.renameSync(tmp, slot.p); // atomic: a concurrent reader sees old-or-new, never a torn view
    } catch {
      /* cache is best-effort */
    }
  }
  return view;
}

/**
 * The map shape a sibling occupies when it was NOT built (a folded session with a cold cache).
 *
 * Every field is present so renderers need no special case to walk it, but the agent row carries
 * `loaded: false` alongside — that flag, not these zeros, is what a renderer must read. "Nothing was
 * built" and "this session changed nothing" are different facts with identical numbers.
 */
function unbuiltChangeMap(session: string): ChangeMap {
  return {
    summary: {
      session, units: 0, rawEdits: 0, pending: 0, kept: 0, undone: 0, added: 0, removed: 0,
      actions: 0, errors: 0, subagents: 0, fleet: 0, egress: 0, compactions: 0, spanMs: 0, root: '',
    },
    edits: [], compactions: [], files: [], modules: [],
    rollupByTask: [], rollupBySubagent: [], rollupByWorkflow: [],
    workflows: [], prompts: [], tasks: [],
  };
}

/**
 * Bucket timestamps into a fixed-width activity histogram (the fleet + workflow sparklines). Loop-based
 * min/max, never Math.min(...ts): a long session's timestamp array is large enough to blow the call
 * stack when spread into arguments.
 */
export function activityBins(tsList: number[], bins = 20): number[] {
  const out = new Array(bins).fill(0);
  const ts = tsList.filter((t) => t > 0);
  if (ts.length === 0) return out;
  const min = minOf(ts);
  const max = maxOf(ts);
  if (max === min) {
    out[bins - 1] = ts.length; // all at one instant → a single trailing spike, not a divide-by-zero
    return out;
  }
  const span = max - min;
  for (const t of ts) {
    let i = Math.floor(((t - min) / span) * bins);
    if (i < 0) i = 0;
    if (i >= bins) i = bins - 1;
    out[i]++;
  }
  return out;
}
