/**
 * Prompts (zero-token): the session broken into what the USER actually asked for.
 *
 * Every other axis in this product organizes work the way the agent saw it — rollups come from
 * files, folders, tasks, subagents and workflow runs. None of them
 * answer the question a person actually has: *what happened when I asked for X?* A long session is a
 * conversation, and the honest unit of that conversation is the user's turn.
 *
 * A prompt owns everything that happened between it and the next one: the edits committed, the tool
 * calls made, the subagents and workflow runs spawned, the background shells started, the compactions
 * suffered. Attribution is by START time, not completion — a shell launched by prompt #4 belongs to #4
 * even when it exits during #7, because #4 is what caused it. Attributing by completion would credit
 * whatever you happened to be typing when a job finished.
 */
import * as path from 'path';
import * as crypto from 'crypto';
import { findTranscript } from './observe';
import { parseActions } from './actions';
import { parseWorkflows } from './workflows';
import { groupMembers, reviewEdits } from './groups';
import { cancelledMemberIds } from './units';
import { lineDelta } from './format';
import { captureEventsPath, readCaptureEvents } from './capture-events';
import { cachedByFiles, readLines } from './fscache';
import { EditRecord, logPath, readLog, readScopeOverrides } from './store';
import { taskIdForSubject, taskNamings } from './tasks';
import { askScan, toMs } from './asks';
import { fileMark, persisted } from './derived';
import { derivedInputsStamp } from './changemap';

export interface SessionPrompt {
  /** Stable id (content+time hash) — safe to key UI state and review ops on. */
  id: string;
  /** 1-based chronological position, the way a person counts their own turns. */
  index: number;
  /** When it was asked (ms epoch). */
  ts: number;
  /** When the NEXT prompt arrived; 0 while this is still the current one. */
  endTs: number;
  /** The prompt itself, whitespace-collapsed. */
  text: string;
  /** First line, capped — what a row shows. */
  title: string;
  /** DISPLAY-unit edit ids committed in this window, capture order: attribution runs over `reviewEdits`,
   *  so a same-code group appears once, as its representative. [checkpointScope] expands them. */
  editIds: number[];
  edits: number;
  added: number;
  removed: number;
  pending: number;
  kept: number;
  undone: number;
  /** Distinct files and folders those edits touched. */
  files: number;
  folders: number;
  /** Main-chain assistant tokens spent answering this ask (input + output + cache, deduped by message
   *  id) — the same total the Stats panel sums, attributed to the window it fell in. */
  tokens: number;
  /** Distinct to-dos this prompt WORKED, keyed by the same content digest tasks use everywhere, so an
   *  item planned both ways counts once. Evidence of work is a TodoWrite item marked in progress or a
   *  TaskUpdate naming the task; writing a plan (TaskCreate) is not. Two limits follow from reading
   *  actions rather than plan snapshots: a TodoWrite that only marks its last item complete leaves no
   *  in-progress item to name, and a TaskUpdate that edits a description counts like one that moves the
   *  task. Both err toward the plan's current state, and neither invents a task that was never named. */
  tasks: number;
  /** Tool calls made while answering, and how many reported an error. */
  actions: number;
  errors: number;
  /** Subagents spawned by this prompt (by spawn time). */
  agents: string[];
  /** Workflow runs started by this prompt. */
  workflows: string[];
  /** Background shells started by this prompt — they often outlive it. */
  processes: string[];
  /** Context compactions that happened while answering. */
  compactions: number;
  /** Wall-clock from the ask to the next one (or to the last thing that happened, if it is current). */
  durationMs: number;
}

/** Stable per-prompt id: the ask's time plus its opening words. */
function promptId(ts: number, text: string): string {
  // The separator is a literal NUL by ESCAPE, never a raw byte: a raw one makes this a "binary" file
  // to git, ripgrep and every review tool, which hides the diff of the module they most need to read.
  return crypto.createHash('sha256').update(`${ts}\u0000${text.slice(0, 200)}`).digest('hex').slice(0, 12);
}

/**
 * The session as a list of the user's asks, each carrying what it produced. Memoized against the
 * transcript AND the store log, since both feed it.
 */
/** One row of the prompt AXIS: an ask's window plus its DISPLAY-unit edit ids and pending count. */
export interface PromptWindow {
  id: string;
  index: number;
  ts: number;
  title: string;
  editIds: number[];
  pending: number;
}

/**
 * Attribution with `assign` overrides: the temporal owner, unless an override moves this DISPLAY
 * record elsewhere. Overrides are recorded per RAW id (the CLI writes every member of a unit, rep
 * included), and a display record follows ITS OWN id's entry — the rep's, since display records are
 * unit reps. An override naming a prompt id that is not in this session falls back to the temporal
 * window rather than dropping the record; `prompts --json` surfaces the mismatch as `assignErrors`.
 *
 * UNITS STAY TEMPORAL: `runsOf` keeps splitting on `windowOf(ts)`. Assign moves ATTRIBUTION only,
 * never the unit boundary — a unit that re-derived under an override would change shape when the
 * reader relabels history, and the blob-pair contract (first.before, rep.after) must never depend
 * on labels. This one helper is the ONLY place overrides apply, used by BOTH attribution passes —
 * two paths that could disagree is the exact bug class the unit rework just finished killing.
 */
function ownerWithOverrides<T extends { id: string }>(
  overrides: Map<number, string>,
  byPromptId: Map<string, T>,
  temporal: (ts: number) => T | null
): (rec: { id: number; ts: number; promptId?: string; nativeTurnId?: string }) => T | null {
  return (rec) => {
    const want = overrides.get(rec.id);
    if (want !== undefined) {
      const target = byPromptId.get(want);
      if (target) return target;
    }
    if (rec.promptId && byPromptId.has(rec.promptId)) return byPromptId.get(rec.promptId)!;
    if (rec.nativeTurnId && byPromptId.has(rec.nativeTurnId)) return byPromptId.get(rec.nativeTurnId)!;
    return temporal(rec.ts);
  };
}

/**
 * The prompt-axis slice of a session — what the status bar and the nav bar's Prompt group step over.
 *
 * `sessionPrompts` computes far more than the axis reads: a lineDelta per display record, transcript-wide
 * action/task/agent attribution, token windows. The axis needs the windows, their edit ids and which are
 * pending — and it asks on EVERY refresh and every keep click. The asks come from the transcript-keyed
 * `askScan`, so a log-only change (a keep) re-pays only reviewEdits + a binary-search ownership pass,
 * never a transcript read.
 */
export function promptWindows(cwd: string, sessionId: string): PromptWindow[] {
  const transcript = findTranscript(cwd, sessionId);

  if (!transcript) {
    return hookSessionPrompts(sessionId).map((p) => ({
      id: p.id, index: p.index, ts: p.ts, title: p.title, editIds: p.editIds, pending: p.pending,
    }));
  }
  return cachedByFiles('promptWindows', [transcript, logPath(sessionId), captureEventsPath(sessionId)], () => {
    const { asks } = askScan(transcript);
    if (!asks.length) return [];
    const reqs: PromptWindow[] = asks.map((a, i) => ({
      id: a.id ? a.id : promptId(a.ts, a.text),
      index: i + 1,
      ts: a.ts,
      title: a.text.length > 96 ? a.text.slice(0, 95) + '…' : a.text,
      editIds: [],
      pending: 0,
    }));
    // Same ownership rule as sessionPrompts: an edit belongs to the ask whose window its ts falls in.
    const owner = (ts: number): PromptWindow | null => {
      if (!ts || ts < reqs[0].ts) return null;
      let lo = 0;
      let hi = reqs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (reqs[mid].ts <= ts) lo = mid;
        else hi = mid - 1;
      }
      return reqs[lo];
    };
    const resolve = ownerWithOverrides(readScopeOverrides(sessionId), new Map(reqs.map((r) => [r.id, r])), owner);
    // `editIds` stays FULL — a rewind to before this ask must reach every record it produced, cancelled
    // or not — while the COUNT skips chains that cancel out, so an ask's "N pending" matches the rows
    // the review surfaces will actually offer under it. PENDING-only: the count it gates is `pending`,
    // and asking for all three statuses walked the log twice more for an answer it cannot use.
    const cancelled = cancelledMemberIds(sessionId, 'pending');
    for (const rec of reviewEdits(sessionId)) {
      const r = resolve(rec);
      if (!r) continue;
      r.editIds.push(rec.id);
      if (cancelled.has(rec.id)) continue;
      if (rec.status === 'pending') r.pending++;
    }
    return reqs;
  });
}

export function sessionPrompts(cwd: string, sessionId: string): SessionPrompt[] {
  const transcript = findTranscript(cwd, sessionId);


  // prompt-scoped review serve driven sessions too (full-parity ask, 2026-08-20).
  if (!transcript) return hookSessionPrompts(sessionId);
  // This finished projection is reused across fresh view processes too. Its input stamp includes
  // workflow/subagent inventories, so a child starting without a main-transcript append still moves it.
  // 2: pasted prompts (`<pasted_content>`) became asks (2026-09-22) — a projection built before that
  // holds none of them, and its inputs did not move.
  const stamp = [3, cwd, fileMark(transcript), fileMark(logPath(sessionId)), fileMark(captureEventsPath(sessionId)),
    derivedInputsStamp(cwd, sessionId, false)].join('|');
  // v2 in the NAME as well as the stamp: an older build still running beside this one keeps its own
  // file rather than the two rewriting one projection at each other's version on every append.
  const name = `prompts-v3-${crypto.createHash('sha256').update(`${cwd}\0${transcript}`).digest('hex').slice(0, 16)}`;
  return persisted(sessionId, name, stamp, () => sessionPromptsUncached(transcript, cwd, sessionId), (value) =>
    Array.isArray(value) && value.every((p) => p && typeof p.id === 'string' && typeof p.text === 'string' &&
      Number.isFinite(p.ts) && Array.isArray(p.editIds) && Array.isArray(p.agents) && Array.isArray(p.workflows)));
}


function hookSessionPrompts(sessionId: string): SessionPrompt[] {
  return cachedByFiles('hookSessionPrompts', [captureEventsPath(sessionId), logPath(sessionId)], () => {
    const turns = readCaptureEvents(sessionId, ['turn_start']);
    if (!turns.length) return [];
    const ends = readCaptureEvents(sessionId, ['turn_end']);
    const recs = reviewEdits(sessionId);
    let lastTs = 0;
    for (const u of ends) if (u.ts > lastTs) lastTs = u.ts;
    return turns.map((t, i) => {
      const p = t.payload as { promptId?: string; prompt?: string } | undefined;
      const text = String(p?.prompt ?? '').replace(/\s+/g, ' ').trim();
      const id = String(p?.promptId ?? `hook-${i + 1}`);
      const endTs = i + 1 < turns.length ? turns[i + 1].ts : 0;
      const mine = recs.filter((r) => r.promptId === id);
      let added = 0;
      let removed = 0;
      let pending = 0;
      let kept = 0;
      let undone = 0;
      const files = new Set<string>();
      const folders = new Set<string>();
      for (const r of mine) {
        const d = lineDelta(sessionId, r);
        added += d.added;
        removed += d.removed;
        if (r.status === 'pending') pending++;
        else if (r.status === 'kept') kept++;
        else undone++;
        files.add(r.file);
        folders.add(path.dirname(r.file));
      }
      return {
        id,
        index: i + 1,
        ts: t.ts,
        endTs,
        text,
        title: text.length > 96 ? text.slice(0, 95) + '…' : text,
        editIds: mine.map((r) => r.id),
        edits: mine.length,
        added,
        removed,
        pending,
        kept,
        undone,
        files: files.size,
        folders: folders.size,
        tokens: 0,
        tasks: 0,
        actions: 0,
        errors: 0,
        agents: [],
        workflows: [],
        processes: [],
        compactions: 0,
        durationMs: Math.max(0, (endTs || lastTs || t.ts) - t.ts),
      };
    });
  });
}

function sessionPromptsUncached(transcript: string, cwd: string, sessionId: string): SessionPrompt[] {
  const { asks, tokenAt } = askScan(transcript);
  if (!asks.length) return [];

  const reqs: SessionPrompt[] = asks.map((a, i) => ({
    id: a.id ? a.id : promptId(a.ts, a.text),
    index: i + 1,
    ts: a.ts,
    endTs: i + 1 < asks.length ? asks[i + 1].ts : 0,
    text: a.text,
    title: a.text.length > 96 ? a.text.slice(0, 95) + '…' : a.text,
    editIds: [],
    edits: 0,
    added: 0,
    removed: 0,
    pending: 0,
    kept: 0,
    undone: 0,
    files: 0,
    folders: 0,
    tokens: 0,
    tasks: 0,
    actions: 0,
    errors: 0,
    agents: [],
    workflows: [],
    processes: [],
    compactions: 0,
    durationMs: 0,
  }));

  /** Which prompt owned a given moment. Binary search over the ask times. */
  const owner = (ts: number): SessionPrompt | null => {
    if (!ts || ts < reqs[0].ts) return null; // before the first ask — setup, not an answer to anything
    let lo = 0;
    let hi = reqs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (reqs[mid].ts <= ts) lo = mid;
      else hi = mid - 1;
    }
    return reqs[lo];
  };

  // 2. the work, attributed by when it STARTED
  const filesByReq = new Map<string, Set<string>>();
  const foldersByReq = new Map<string, Set<string>>();
  const tasksByReq = new Map<string, Set<string>>();
  // A TaskUpdate names its task by display number alone, so the number has to be resolved to a subject.
  // Resolve it AS OF the update: the namings timeline is append-only, so a task renamed (or deleted)
  // later cannot rewrite what an earlier prompt was credited with.
  const namings = transcript ? taskNamings(transcript) : [];
  const subjectAt = (taskId: string, ts: number): string | null => {
    let found: string | null = null;
    for (const n of namings) {
      if (n.id !== taskId) continue;
      if (n.ts > ts && found !== null) break; // later renames belong to later moments
      found = n.subject;
      if (n.ts > ts) break; // the first naming can post-date a 0-timestamp update — take it, then stop
    }
    return found;
  };
  /** A status that is evidence of WORK. An update carrying only a new description moves nothing. */
  const WORKED = new Set(['in_progress', 'completed', 'done']);
  const bump = (m: Map<string, Set<string>>, id: string, v: string) => {
    let s = m.get(id);
    if (!s) m.set(id, (s = new Set()));
    s.add(v);
  };
  // DISPLAY units: an ask's rollup must not count records the change map collapsed away.
  const resolve = ownerWithOverrides(readScopeOverrides(sessionId), new Map(reqs.map((r) => [r.id, r])), owner);
  // Same split as `promptWindows`: every id stays reachable for a rewind, and nothing that cancels out
  // is counted as this ask's work.
  const cancelled = cancelledMemberIds(sessionId);
  for (const rec of reviewEdits(sessionId)) {
    const r = resolve(rec);
    if (!r) continue;
    r.editIds.push(rec.id);
    if (cancelled.has(rec.id)) continue;
    r.edits++;
    const d = lineDelta(sessionId, rec);
    r.added += d.added;
    r.removed += d.removed;
    if (rec.status === 'pending') r.pending++;
    else if (rec.status === 'kept') r.kept++;
    else if (rec.status === 'undone') r.undone++;
    if (rec.file) {
      bump(filesByReq, r.id, rec.file);
      bump(foldersByReq, r.id, path.dirname(rec.file));
    }
  }

  // Workflow runs are attributed by when the run STARTED, from the run model itself — the `Workflow`
  // tool call alone would only give a spawn id, and a run's identity is its wf_<id>.
  for (const w of parseWorkflows(cwd, sessionId)) {
    const r = owner(w.startedTs || w.lastActivityMs);
    if (r) r.workflows.push(w.id);
  }

  let lastTs = 0;
  for (const a of parseActions(cwd, sessionId)) {
    if (a.ts > lastTs) lastTs = a.ts;
    const r = owner(a.ts);
    if (!r) continue;
    r.actions++;
    if (a.isError) r.errors++;
    if (a.compact) r.compactions++;
    if (a.category === 'agent' && a.toolUseId) r.agents.push(a.toolUseId);
    // A backgrounded shell is a Bash call the harness kept running; its id arrives with the result, so
    // the spawn is what we can attribute here — which is the correct owner anyway.
    if (a.category === 'exec' && a.toolUseId && /run_in_background/.test(a.detail ?? '')) r.processes.push(a.toolUseId);
    // A to-do this action names as in progress (actionTarget puts the active item's content there) —
    // the distinct set is "tasks worked on" for this prompt. The fallback string "N to-do(s)" (nothing
    // was in progress) is not a task, so it is excluded. Identity is the SAME content digest tasks are
    // keyed by everywhere else, so a session that plans twice — a TodoWrite and a TaskCreate naming the
    // same item — counts one task here, exactly as the change map does.
    // Tasks WORKED, not tasks named — read from the call's own plan facts, never from `target`, which
    // is a display string clipped at 160 characters. A TodoWrite names its in-progress item outright; a
    // TaskUpdate names a number and a status, so the number is resolved to the subject it stood for at
    // that moment and only a status that means work counts. TaskCreate is deliberately NOT counted:
    // writing a plan is not doing it. Everything is keyed by the same content digest tasks use
    // everywhere, so an item planned both ways counts once.
    if (a.category === 'todo' && a.plan) {
      if (a.tool === 'TodoWrite' && a.plan.subject) {
        bump(tasksByReq, r.id, taskIdForSubject(a.plan.subject));
      } else if (a.tool === 'TaskUpdate' && a.plan.taskId && a.plan.status && WORKED.has(a.plan.status)) {
        const subject = a.plan.subject ?? subjectAt(a.plan.taskId, a.ts);
        if (subject) bump(tasksByReq, r.id, taskIdForSubject(subject)); // unanchorable → not guessed
      }
    }
  }

  // Tokens: attribute each assistant message's usage to the ask whose window it fell in.
  for (const ev of tokenAt) {
    const r = owner(ev.ts);
    if (r) r.tokens += ev.tokens;
  }

  for (const r of reqs) {
    r.files = filesByReq.get(r.id)?.size ?? 0;
    r.folders = foldersByReq.get(r.id)?.size ?? 0;
    r.tasks = tasksByReq.get(r.id)?.size ?? 0;
    const end = r.endTs || Math.max(lastTs, r.ts);
    r.durationMs = Math.max(0, end - r.ts);
  }
  return reqs;
}

/** The store edit ids a prompt produced — the review scope for "accept everything I asked for here". */
export function promptEditIds(cwd: string, sessionId: string, promptId: string): number[] {
  const r = sessionPrompts(cwd, sessionId).find((x) => x.id === promptId || String(x.index) === promptId);
  return r ? r.editIds.slice() : [];
}

/** What a rewind to before one prompt would revert — [checkpointScope]'s answer. */
export interface CheckpointScope {
  /** Every RAW store id in scope, group-expanded and ascending. This is what `undo`/`redo` act on. */
  ids: number[];
  /** How many of [ids] are pending right now — the count an undo would actually revert. */
  pending: number;
  /** How many REVIEW UNITS those PENDING records collapse to (what the Prompts rows count). Computed over
   *  the pending set because its job is making a rewind's confirmation honest; it is therefore meaningless
   *  on the redo path, where the same records are already undone. */
  units: number;
  /** How many of the pending records PREDATE the ask this rewind was pointed at. A unit can span two
   *  asks when the file was absent in between (`units.ts` PASS 1), and a unit is the smallest thing
   *  that can be reverted — so a rewind reaches back. Never zero silently: every caller states it. */
  fromEarlier: number;
  /** Distinct files among the pending records. Group expansion can never add one (groups are per-file). */
  files: string[];
}

/**
 * Everything a prompt and every prompt after it produced — the "rewind to before this ask" scope.
 *
 * Two properties are load-bearing and neither is obvious:
 *
 * 1. RAW ids, not display units. `promptWindows` (like `sessionPrompts`) attributes over `reviewEdits`,
 *    so its `editIds` are same-code GROUP REPRESENTATIVES. `undoScope({ids})` is group-unaware and acts
 *    on raw records, so a chain that straddles the boundary would half-revert — the rep undone, its
 *    earlier members left pending at an intermediate state no other surface can name. Every id is
 *    therefore expanded through [groupMembers] (once per group, not once per member).
 * 2. Because of (1), the raw count and the count on screen DIVERGE whenever a targeted group has two or
 *    more pending members. Both numbers are returned so one caller cannot print a different total than
 *    another for the same destructive operation.
 *
 * Records whose `ts` precedes the first ask (or is missing) are deliberately excluded: they precede every
 * possible boundary, so no rewind owns them. The "unassigned" loop below is provably empty for a
 * well-formed session — `owner()` only declines a record for exactly that reason — but it is written and
 * unit-tested anyway, so "an edit no window claims is never silently dropped" is enforced by code rather
 * than by an argument about code.
 *
 * Returns an empty scope for an unknown prompt id, and for a real prompt with nothing left to revert;
 * callers that must tell those apart check the prompt id themselves.
 */
export function checkpointScope(cwd: string, sessionId: string, promptId: string): CheckpointScope {
  const empty: CheckpointScope = { ids: [], pending: 0, units: 0, fromEarlier: 0, files: [] };
  const windows = promptWindows(cwd, sessionId);
  const from = windows.find((w) => w.id === promptId || String(w.index) === promptId);
  if (!from) return empty;

  // This ask and every later one, by the same rule the Prompts rows display.
  const units = new Set<number>();
  const claimed = new Set<number>();
  for (const w of windows) {
    for (const id of w.editIds) {
      claimed.add(id);
      if (w.index >= from.index) units.add(id);
    }
  }
  // No window claims it, yet it happened at or after the boundary ⇒ it still belongs to this rewind.
  for (const rec of reviewEdits(sessionId)) {
    if (!claimed.has(rec.id) && rec.ts >= from.ts) units.add(rec.id);
  }

  // Expand each review unit to its whole same-code group, visiting a group once however many of its
  // members are in the set.
  const ids: number[] = [];
  const groups: number[][] = [];
  const seen = new Set<number>();
  for (const id of units) {
    if (seen.has(id)) continue;
    const members = groupMembers(sessionId, id);
    groups.push(members);
    for (const m of members) {
      if (seen.has(m)) continue;
      seen.add(m);
      ids.push(m);
    }
  }
  ids.sort((a, b) => a - b);
  if (!ids.length) return empty;

  const byId = new Map<number, EditRecord>();
  for (const rec of readLog(sessionId)) byId.set(rec.id, rec);
  const isPending = (id: number) => byId.get(id)?.status === 'pending';
  const pending = ids.filter(isPending);
  /**
   * Records this rewind will revert that were made BEFORE the ask it was pointed at.
   *
   * A unit is the smallest thing that can be reverted, and one unit may now span two asks: a file
   * deleted in one and re-created in the next has no reviewable state in between, so both hops are
   * one decision (`units.ts`, PASS 1). Expanding the scope by group therefore reaches back past the
   * boundary — the file would otherwise land on content neither ask produced. That is the right
   * revert and the wrong silence, so the number is reported and every caller says it out loud.
   */
  const fromEarlier = pending.filter((id) => {
    const ts = byId.get(id)?.ts ?? 0;
    return ts < from.ts;
  }).length;
  // Cancelled-out chains are not rows anywhere, so they are not this dialog's unit COUNT either —
  // while `ids` and `pending` stay complete, because the rewind really does revert those records.
  const cancelled = cancelledMemberIds(sessionId);
  return {
    ids,
    pending: pending.length,
    units: groups.filter((g) => g.some(isPending) && g.some((m) => !cancelled.has(m))).length,
    fromEarlier,
    files: [...new Set(pending.map((id) => byId.get(id)?.file ?? ''))].filter(Boolean),
  };
}

/** Claude's own prose in reply to one ask — the assistant TEXT it wrote while answering, its tool calls
 *  stripped out, so a reader gets the narrative (the plan, the explanations, the summary) not the
 *  mechanics. Lazily fetched: it can be large, so it never rides the Prompts list payload. */
export interface PromptResponse {
  promptId: string;
  index: number;
  /** The concatenated assistant text, turns separated by a blank line, capped at [RESPONSE_CAP]. */
  text: string;
  /** How many assistant text turns were joined. */
  turns: number;
  /** Total bytes of prose before the cap. */
  bytes: number;
  /** Bytes past the cap that are not shown (0 when the whole response fits). */
  truncated: number;
}

/** A response can be enormous (hundreds of turns of prose); keep it reviewable, and say when clipped. */
const RESPONSE_CAP = 200_000;

/**
 * Claude's response to one ask, assembled from the main-chain assistant TEXT blocks whose timestamp
 * falls in that ask's window. Sidechains (subagents) are excluded — they are their own conversation —
 * and tool_use / tool_result blocks are skipped, leaving the prose a person actually reads. Memoized
 * against the transcript, so re-expanding a row is free. Null when the ask (or transcript) is unknown.
 */
export function promptResponse(cwd: string, sessionId: string, promptId: string): PromptResponse | null {
  const reqs = sessionPrompts(cwd, sessionId);
  const r = reqs.find((x) => x.id === promptId || String(x.index) === promptId);
  if (!r) return null;
  const transcript = findTranscript(cwd, sessionId);
  if (!transcript) return null;
  return cachedByFiles(`promptResponse:${r.id}`, [transcript], () => buildResponse(transcript, r));
}

function buildResponse(transcript: string, r: SessionPrompt): PromptResponse {
  const end = r.endTs || Number.MAX_SAFE_INTEGER;
  let lines: string[];
  try {
    lines = readLines(transcript);
  } catch {
    return { promptId: r.id, index: r.index, text: '', turns: 0, bytes: 0, truncated: 0 };
  }
  const segments: string[] = [];
  const seen = new Set<string>(); // an assistant message split across lines shares message.id — join once
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const msg = o.message;
    if (!msg || msg.role !== 'assistant' || o.isSidechain === true) continue;
    const ts = toMs(o.timestamp ?? o.ts);
    if (!ts || ts < r.ts || ts >= end) continue; // outside this ask's window
    if (typeof msg.id === 'string') {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);
    }
    // The prose only: text blocks, in order; skip tool_use / tool_result / thinking.
    const parts: string[] = [];
    if (typeof msg.content === 'string') parts.push(msg.content);
    else if (Array.isArray(msg.content)) {
      for (const b of msg.content) if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
    const seg = parts.join('\n').trim();
    if (seg) segments.push(seg);
  }
  const full = segments.join('\n\n');
  const bytes = Buffer.byteLength(full, 'utf8');
  const text = full.length > RESPONSE_CAP ? full.slice(0, RESPONSE_CAP) : full;
  return {
    promptId: r.id,
    index: r.index,
    text,
    turns: segments.length,
    bytes,
    truncated: Math.max(0, bytes - Buffer.byteLength(text, 'utf8')),
  };
}

/** Headline for the Prompts window. */
export function summarizePrompts(reqs: SessionPrompt[]): { total: number; withEdits: number; edits: number } {
  return {
    total: reqs.length,
    withEdits: reqs.filter((r) => r.edits > 0).length,
    edits: reqs.reduce((n, r) => n + r.edits, 0),
  };
}
