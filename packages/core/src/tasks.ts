/**
 * The session TASK LIST — Claude Code's newer task system (TaskCreate/TaskUpdate: numbered tasks with
 * statuses and dependencies), distinct from the older TodoWrite to-dos.
 * State lives OUTSIDE the transcript as one JSON file per task under
 * `<claudeConfigDir()>/tasks/<sessionId>/<id>.json` — this reader is the single backend for the
 * Overview's Tasks tab in both editors (zero token, no model calls, read-only).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { transcriptFacts } from './derived-transcript';
import { findTranscript } from './observe';
import { claudeConfigDir } from './paths';
import { isSafeSessionId } from './store';

/** One task from the session's task list, as Claude Code wrote it. */
export interface SessionTask {
  /** Numeric-string id ("1", "2", …) — display order is numeric by id (creation order). */
  id: string;
  subject: string;
  /** Longer body; '' when absent. */
  description: string;
  /** 'pending' | 'in_progress' | 'completed' (deleted tasks have no file). Unknown values pass through. */
  status: string;
  /** Present-continuous spinner label while in_progress; null when absent. */
  activeForm: string | null;
  /** Ids of tasks this one blocks / is blocked by (dependencies), [] when absent. */
  blocks: string[];
  blockedBy: string[];
}

/** Roll-up for the tab badge / recap line. */
export interface SessionTaskSummary {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
}

const asStrArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Read the session's task list, ordered numerically by id. Missing dir (a session that never used
 *  the task system) → []. A malformed task file is skipped — one bad write must not blank the tab. */
export function readSessionTasks(sessionId: string): SessionTask[] {
  // Task dirs are keyed by the RAW session id — never a path. Refuse anything that could traverse;
  // isSafeSessionId also rejects '.'/'..' (and caps length), which the bare class would let through.
  if (!isSafeSessionId(sessionId)) return [];
  const dir = path.join(claudeConfigDir(), 'tasks', sessionId);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const out: SessionTask[] = [];
  for (const f of files) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!o || typeof o.subject !== 'string') continue;
      out.push({
        id: typeof o.id === 'string' ? o.id : f.replace(/\.json$/, ''),
        subject: o.subject,
        description: typeof o.description === 'string' ? o.description : '',
        status: typeof o.status === 'string' ? o.status : 'pending',
        activeForm: typeof o.activeForm === 'string' && o.activeForm ? o.activeForm : null,
        blocks: asStrArray(o.blocks),
        blockedBy: asStrArray(o.blockedBy),
      });
    } catch {
      /* skip the malformed file, keep the rest */
    }
  }
  out.sort((a, b) => Number(a.id) - Number(b.id));
  return out;
}

/** One full-list snapshot of the task list at a moment — the SAME shape as changemap's TodoWrite
 *  snapshots, so tasks ride the identical strict-span attribution machinery. */
export interface TaskSnap {
  ts: number;
  todos: { content: string; status: string }[];
}

interface MinedTask {
  id: string;
  subject: string;
  description: string;
  activeForm: string | null;
  status: string;
}

/** The single sha1→12-hex digest core, shared with changemap.taskId() so the two can't drift on
 *  algorithm or truncation. changemap imports this; importing changemap back here would be a cycle. */
export function digest12(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

/** The same digest changemap.taskId() computes for a task's content — kept in LOCKSTEP so a task
 *  row can join rollupByTask. Both route through digest12(), so the hash core stays in one place.
 *  The `.trim()` is deliberate and NOT shared: taskId() hashes the raw content, so the two ids match
 *  only for already-trimmed text; folding the trim into the core would change one hash, so it stays
 *  each function's own pre-processing. */
export function taskIdForSubject(subject: string): string {
  return digest12(subject.trim());
}

/** TaskCreate/TaskUpdate events mined from the MAIN transcript → (a) full-list snapshots for the
 *  strict span model, (b) the task history — which survives the runtime archiving completed task
 *  files, unlike the live dir. Memoized per (mtime,size) like todoSnaps. */
function mineTasks(transcriptPath: string): { snaps: TaskSnap[]; history: MinedTask[] } {
  const facts = transcriptFacts(transcriptPath).tasks;
  return { snaps: facts.snaps, history: [...facts.state.values()].sort((a, b) => Number(a.id) - Number(b.id)) };
}

export interface TaskFacts {
  state: Map<string, MinedTask>;
  pendingCreate: Map<string, { t: MinedTask; ts: number }>;
  snaps: TaskSnap[];
  namings: TaskNaming[];
  pendingNames: Map<string, { ts: number; subject: string }>;
  known: Map<string, string>;
}

export function newTaskFacts(): TaskFacts {
  return { state: new Map(), pendingCreate: new Map(), snaps: [], namings: [], pendingNames: new Map(), known: new Map() };
}

export function foldTaskFacts(facts: TaskFacts, o: any): void {
  foldTaskNames(facts, o);
  const { state, pendingCreate, snaps } = facts;
  const toMs = (v: unknown): number => {
    if (typeof v === 'number' && isFinite(v)) return v > 1e12 ? v : v * 1000;
    if (typeof v === 'string') {
      const t = Date.parse(v);
      return isNaN(t) ? 0 : t;
    }
    return 0;
  };
  const snap = (ts: number) => {
    const todos = [...state.values()]
      .sort((a, b) => Number(a.id) - Number(b.id))
      // src marks the item TASK-born (plan-timeline provenance).
      .map((t) => ({ content: t.subject, status: t.status, src: 'task' as const }));
    snaps.push({ ts, todos });
  };
  const resultText = (c: unknown): string => {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((b: any) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
    return '';
  };
  if (o.isSidechain === true) return; // a subagent's tasks are not the main plan
  const msg = o.message;
  if (!msg || !Array.isArray(msg.content)) return;
  const ts = toMs(o.timestamp ?? o.ts);
  for (const b of msg.content) {
    if (!b) continue;
    if (b.type === 'tool_use' && b.name === 'TaskCreate' && b.input && typeof b.input.subject === 'string') {
      pendingCreate.set(String(b.id ?? ''), {
        ts,
        t: {
          id: '',
          subject: String(b.input.subject).trim(),
          description: typeof b.input.description === 'string' ? b.input.description : '',
          activeForm: typeof b.input.activeForm === 'string' && b.input.activeForm ? b.input.activeForm : null,
          status: 'pending',
        },
      });
    } else if (b.type === 'tool_use' && b.name === 'TaskUpdate' && b.input && b.input.taskId != null) {
      const cur = state.get(String(b.input.taskId));
      if (!cur) continue; // an update we can't anchor (create's result never parsed) — skip, never guess
      if (b.input.status === 'deleted') state.delete(cur.id);
      else {
        if (typeof b.input.status === 'string') cur.status = b.input.status;
        if (typeof b.input.subject === 'string' && b.input.subject) cur.subject = b.input.subject.trim();
        if (typeof b.input.description === 'string') cur.description = b.input.description;
        if (typeof b.input.activeForm === 'string' && b.input.activeForm) cur.activeForm = b.input.activeForm;
      }
      snap(ts);
    } else if (b.type === 'tool_result' && b.tool_use_id != null && pendingCreate.has(String(b.tool_use_id))) {
      const pc = pendingCreate.get(String(b.tool_use_id))!;
      pendingCreate.delete(String(b.tool_use_id));
      const m = resultText(b.content).match(/Task #(\d+) created/);
      if (!m) continue; // creation failed (or an unrecognized runtime message) — no task to track
      pc.t.id = m[1];
      state.set(pc.t.id, pc.t);
      snap(ts || pc.ts);
    }
  }
}

/** The task-list snapshots for the strict span model — changemap merges these with the TodoWrite
 *  snapshots (todos win on duplicate titles) so task-planned sessions get real per-task attribution. */
export function taskSnaps(transcriptPath: string): TaskSnap[] {
  return mineTasks(transcriptPath).snaps;
}

/** One moment at which a task number came to stand for a subject. */
export interface TaskNaming {
  ts: number;
  id: string;
  subject: string;
}

/**
 * When each task NUMBER acquired the subject it then stood for, oldest first.
 *
 * A TaskUpdate names its task by display number and nothing else, so a reader that wants the task's
 * identity has to resolve that number — and resolving it against the plan's CURRENT state lets a later
 * rename, or a deletion, silently rewrite what an earlier moment meant. This timeline is append-only:
 * every naming stays in it, so resolving as of a given timestamp answers what the number meant THEN.
 */
export function taskNamings(transcriptPath: string): TaskNaming[] {
  return transcriptFacts(transcriptPath).tasks.namings.slice().sort((a, b) => a.ts - b.ts);
}

function foldTaskNames(facts: TaskFacts, o: any): void {
  const { namings: out, pendingNames: pendingCreate, known } = facts;
  const stamp = (v: unknown): number => {
    if (typeof v === 'number' && isFinite(v)) return v > 1e12 ? v : v * 1000;
    if (typeof v === 'string') {
      const t = Date.parse(v);
      return isNaN(t) ? 0 : t;
    }
    return 0;
  };
  const text = (c: unknown): string => {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map((b: any) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
    return '';
  };
  if (o.isSidechain === true) return; // a subagent's tasks are not the main plan
  const msg = o.message;
  if (!msg || !Array.isArray(msg.content)) return;
  const ts = stamp(o.timestamp ?? o.ts);
  for (const b of msg.content) {
    if (!b) continue;
    if (b.type === 'tool_use' && b.name === 'TaskCreate' && b.input && typeof b.input.subject === 'string') {
      pendingCreate.set(String(b.id ?? ''), { ts, subject: String(b.input.subject).trim() });
    } else if (
      b.type === 'tool_use' &&
      b.name === 'TaskUpdate' &&
      b.input &&
      b.input.taskId != null &&
      typeof b.input.subject === 'string' &&
      b.input.subject.trim()
    ) {
      // A rename: from here on the number stands for the new text, and every earlier resolution keeps
      // pointing at the old one.
      const id = String(b.input.taskId);
      const subject = b.input.subject.trim();
      if (known.get(id) !== subject) {
        known.set(id, subject);
        out.push({ ts, id, subject });
      }
    } else if (b.type === 'tool_result' && b.tool_use_id != null && pendingCreate.has(String(b.tool_use_id))) {
      const pc = pendingCreate.get(String(b.tool_use_id))!;
      pendingCreate.delete(String(b.tool_use_id));
      const m = text(b.content).match(/Task #(\d+) created/);
      if (!m) continue; // creation failed — the number never came to mean anything
      known.set(m[1], pc.subject);
      out.push({ ts: ts || pc.ts, id: m[1], subject: pc.subject });
    }
  }
}

/** A task enriched for the Overview's Tasks tab: [taskId] joins it to rollupByTask / taskEditIds
 *  (per-task edits/± and click-to-scope in the renderers). */
export interface SessionTaskRow extends SessionTask {
  taskId: string;
}

/** The Tasks-tab list: transcript HISTORY (complete — the runtime archives completed task files)
 *  overlaid with the live dir state (the runtime's current truth for tasks still on disk). */
export function sessionTaskRows(cwd: string, sessionId: string): SessionTaskRow[] {
  const byId = new Map<string, SessionTask>();
  const transcript = findTranscript(cwd, sessionId);
  if (transcript) for (const t of mineTasks(transcript).history) byId.set(t.id, { ...t, blocks: [], blockedBy: [] });
  for (const t of readSessionTasks(sessionId)) byId.set(t.id, t); // dir wins — it carries dependencies too
  return [...byId.values()]
    .sort((a, b) => Number(b.id) - Number(a.id)) // newest first — the current work tops the tab
    .map((t) => ({ ...t, taskId: taskIdForSubject(t.subject) }));
}

/** Counts for the tab badge ("7 done · 1 in progress") and the Observations recap. */
export function summarizeTasks(tasks: SessionTask[]): SessionTaskSummary {
  let completed = 0;
  let inProgress = 0;
  let pending = 0;
  for (const t of tasks) {
    if (t.status === 'completed') completed++;
    else if (t.status === 'in_progress') inProgress++;
    else pending++;
  }
  return { total: tasks.length, completed, inProgress, pending };
}
