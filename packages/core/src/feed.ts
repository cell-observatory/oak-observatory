/**
 * Live feed (zero-token): what one thing in the Overview is doing RIGHT NOW.
 *
 * The panels answer "who is working and on what" at a glance; this answers the question that always
 * follows — "so what is it actually doing?" — for whichever row you clicked, from the file that thing
 * writes as it works:
 *
 *   agent    → its own `subagents/agent-<id>.jsonl` (its tool calls and its reasoning)
 *   workflow → its agents' transcripts, merged in time order and tagged by agent
 *   task     → the main chain's tool calls inside that task's real in_progress window
 *   process  → the background shell's output file, tailed
 *   session  → the main transcript: the user's asks, the agent's replies and thinking, its tool calls
 *
 * Everything is a bounded TAIL — a feed is about the newest activity, and a panel that re-reads a 50MB
 * transcript per tick is a panel nobody leaves open. `lastTs` is the newest evidence found, so a
 * renderer can say "updated 3s ago" instead of implying live-ness it cannot verify.
 */
import * as fs from 'fs';
import * as path from 'path';
import { findTranscript, transcriptInsightsAt } from './observe';
import { readLog } from './store';
import { transcriptFacts } from './derived-transcript';
import { parseTranscriptActions, readTranscriptProse, ProseIndex, ActionRecord, agentPhaseDetail, linkEditIds } from './actions';
import { findSubagentsDir } from './subagents';
import { parseWorkflows } from './workflows';
import { listRepoSiblings } from './fleet';
import { cachedChangeMap } from './changemap';
import { readCaptureEvents } from './capture-events';
import { sessionProcesses, processOutputTail } from './processes';

export type FeedKind = 'session' | 'agent' | 'workflow' | 'task' | 'process';

export interface FeedRef {
  kind: FeedKind;
  /** agentId · wf_<id> · taskId · background shell id; ignored for 'session'. */
  id: string;
}

export interface FeedEntry {
  /** ms epoch; 0 for raw output lines, which carry no timestamp of their own. */
  ts: number;

  /** 'reasoning' is the agent's OWN words as a row of their own — what it said (`reasoningKind`
   *  'text') or thought ('thinking'), carried in `reasoning`. The feed is the whole conversation, so
   *  a reply that called no tool is a row here and not a lost message. */
  kind: 'action' | 'output' | 'reasoning' | 'permission' | 'prompt';
  /** The headline: a tool call, one line of output, or — for 'reasoning' — 'said' | 'thinking'. */
  label: string;
  /** kind 'prompt' only: the user's ask, COMPLETE — renderers wrap it; nothing here is clipped. */
  promptText?: string;
  /** WHAT the call acted on — the path, the command, the query.
   *
   *  Split out of `detail` so it can sit on the HEAD row beside the verb. A row naming only its
   *  tool ("Edit") tells a reader nothing they can act on, and it is the collapsed row — the one
   *  most in need of the target — that lost it entirely. Every agent CLI surveyed puts the target
   *  on the head row; none puts it on a second line. */
  target?: string;
  /** Secondary context — which agent produced it. Never the target: that has its own field. */
  detail?: string;
  /** The call's coarse kind, straight from `ActionRecord.category` — 'edit' · 'exec' · 'read' ·
   *  'search' · 'web' · 'agent' · 'todo' · 'mcp' · 'meta' · 'compact' · 'other'.
   *
   *  A renderer that wants to draw a shell call as a shell call needs to KNOW it is one, and
   *  matching the tool name against a list of spellings is the guess this field exists to avoid —
   *  core already made this determination once, for the timeline. */
  category?: string;
  /** The tool's OWN secondary context: a Bash command's description, a Grep's path. Distinct from
   *  `detail` (which agent) and from `target` (what it acted on). */
  note?: string;
  /** What the agent said or thought immediately before this call — or, on a 'reasoning' row, the
   *  words themselves.
   *
   *  Carried forward per message by the transcript parser, so consecutive calls from one message
   *  share it — a renderer must show it only where it CHANGES, or every row repeats the paragraph
   *  above it. A 'reasoning' row carries the SAME string the calls after it carry, so that rule also
   *  keeps the row from being repeated under them. */
  reasoning?: string;
  /** 'thinking' for a real thinking block, 'text' for prose the agent addressed to the reader. */
  reasoningKind?: 'text' | 'thinking';
  /** A shell call's FULL command (bounded upstream) — the blob renders it whole on expand. */
  cmd?: string;
  /** false when the call reported an error; undefined when not applicable. */
  ok?: boolean;
  /** The store edit this action produced, when it produced one (the four file tools do; Bash does
   *  not — its changes are found by snapshot, with no 1:1 row). It is what lets a surface open the
   *  DIFF behind a feed row instead of only naming the tool that made it. */
  editId?: number;
  /** A DISPLAY-ONLY store id for the diff, set only when the strict `editId` is null because this edit
   *  interleaved with a subagent's edits to the same file (attribution refuses to guess there, §6.3).
   *  Matched by nearest ts — accurate enough to SHOW the change, never to keep/undo it (those key on
   *  `editId`). Lets the Agent screen render the code it otherwise dropped. */
  previewId?: number;
}

export interface FeedResult {
  ref: FeedRef;
  /** What is being watched, ready to render as the pane's heading. */
  title: string;
  /** Whether the source still looks alive (an agent's phase, a shell's completion, a run's activity). */
  running: boolean;
  /** What this feed IS, which is a different thing depending on whether its source is still going:
   *  'live'  — still writing, so follow the tail and keep polling;
   *  'audit' — finished, so it is a record of what happened, not a stream. Renderers label and behave
   *  accordingly (a completed run should stop being polled, and should not pretend to be live). */
  mode: 'live' | 'audit';
  /** Chronological, OLDEST first — a feed reads downward, like a terminal. */
  entries: FeedEntry[];
  /** How many older entries were dropped to honour `limit` (0 when none were). */
  truncated: number;
  /** Newest evidence seen (ms epoch, 0 when none) — renderers show the age rather than claim "live". */
  lastTs: number;
  /** Set when the feed can only be partial, and why. */
  note?: string;
}

const DEFAULT_LIMIT = 60;
/** Output tail per process feed — enough scrollback to be useful, small enough to post every tick. */
const OUTPUT_TAIL_BYTES = 16 * 1024;

function empty(ref: FeedRef, title: string, note?: string): FeedResult {
  return { ref, title, running: false, mode: 'audit', entries: [], truncated: 0, lastTs: 0, note };
}

/** Newest `limit` records, oldest-first, plus how many were dropped. */
function tail<T>(all: T[], limit: number): { rows: T[]; truncated: number } {
  if (all.length <= limit) return { rows: all, truncated: 0 };
  return { rows: all.slice(all.length - limit), truncated: all.length - limit };
}

/** One tool call → one feed row. */
function fromAction(a: ActionRecord, agentLabel?: string): FeedEntry {
  return {
    ts: a.ts,
    ...(typeof a.editId === 'number' ? { editId: a.editId } : {}),
    ...(typeof a.previewId === 'number' ? { previewId: a.previewId } : {}),
    kind: 'action',
    label: a.tool === 'CompactBoundary' ? 'context compacted' : a.tool,
    ...(a.target ? { target: a.target } : {}),
    ...(a.category ? { category: a.category } : {}),
    ...(a.detail ? { note: a.detail } : {}),
    ...(a.reasoning ? { reasoning: a.reasoning, reasoningKind: a.reasoningKind ?? 'text' } : {}),
    ...(a.cmd ? { cmd: a.cmd } : {}),
    detail: agentLabel || undefined,
    ok: a.isError ? false : true,
  };
}

/** The agent's replies and thoughts as rows of their own, in transcript order. Listed BEFORE the
 *  actions when the merge is stable-sorted by time, because within one message the words precede
 *  the calls they explain. */
interface PendingEntry extends FeedEntry { prose?: { file: string; index: ProseIndex } }
function proseEntries(transcript: string, includeSidechain: boolean, agentLabel?: string): PendingEntry[] {
  return transcriptFacts(transcript, includeSidechain).actions.proseIndex.map((p) => ({
    ts: p.ts,
    kind: 'reasoning' as const,
    label: p.kind === 'thinking' ? 'thinking' : 'said',
    reasoningKind: p.kind,
    detail: agentLabel || undefined,
    prose: { file: transcript, index: p },
  }));
}

/** Select the window before reading prose: other views never load it, and a feed reads at most
 *  `limit` source lines, even when many agents contribute to a workflow. */
function feedTail(all: PendingEntry[], limit: number): { rows: FeedEntry[]; truncated: number } {
  const { rows, truncated } = tail(all, limit);
  const byFile = new Map<string, PendingEntry[]>();
  for (const e of rows) if (e.prose) {
    const group = byFile.get(e.prose.file) ?? [];
    group.push(e); byFile.set(e.prose.file, group);
  }
  for (const [file, group] of byFile) {
    const words = readTranscriptProse(file, group.map(e => e.prose!.index));
    group.forEach((e, i) => { e.reasoning = words[i]?.text ?? ''; delete e.prose; });
  }
  return { rows, truncated };
}

/** Resolve a session's transcript even when it belongs to a SIBLING WORKTREE.
 *
 *  `findTranscript` only walks up from cwd, but both editors pin cwd to the workspace root while the
 *  fleet deliberately unions in sessions from every worktree of the repo — so clicking one of those
 *  rows produced an empty feed whose own note ("no transcript for this session") was false. The sibling
 *  scan runs ONLY on the miss path, so the common case still costs one existsSync walk.
 *  Returns the [transcript, cwd] pair, because everything downstream re-resolves from that cwd. */
function resolveSession(cwd: string, sessionId: string): { transcript: string; cwd: string } | null {
  const direct = findTranscript(cwd, sessionId);
  if (direct) return { transcript: direct, cwd };
  for (const sib of listRepoSiblings(cwd, sessionId)) {
    if (sib.id !== sessionId) continue;
    const t = findTranscript(sib.worktree, sessionId);
    if (t) return { transcript: t, cwd: sib.worktree };
  }
  return null;
}

/** An agent's human label from its cached sidecar — deliberately NOT parseSubagents, which re-parses
 *  every agent transcript in the session and would run on each live poll. */
function subagentLabel(dir: string, agentId: string): string {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `agent-${agentId}.meta.json`), 'utf8'));
    const d = typeof meta?.description === 'string' ? meta.description.trim() : '';
    const t = typeof meta?.agentType === 'string' ? meta.agentType.trim() : '';
    return d || t || '';
  } catch {
    return '';
  }
}

/** mtime of a file, 0 when it can't be stat'd. */
function mtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * The feed for one Overview row. `nowMs` is injectable for tests.
 */
export function liveFeed(cwd: string, sessionId: string, ref: FeedRef, opts: { limit?: number } = {}): FeedResult {
  const limit = opts.limit ?? DEFAULT_LIMIT;

  // A fleet row can name a session in another worktree; re-point cwd so every branch below resolves.
  const owner = resolveSession(cwd, sessionId);
  if (owner) cwd = owner.cwd;

  if (ref.kind === 'process') {
    const proc = sessionProcesses(cwd, sessionId).find((p) => p.id === ref.id);
    if (!proc) return empty(ref, ref.id, 'no such background shell in this session');
    const text = processOutputTail(proc.outputPath, OUTPUT_TAIL_BYTES);
    const lines = text.split('\n').filter((l) => l.length > 0);
    // The output file lives in a temp dir that gets reaped. "No output yet" and "the log is gone" look
    // identical once it is deleted, and only one of them is true of a shell that already finished.
    let gone = false;
    if (proc.outputPath && !lines.length) {
      try {
        gone = !fs.existsSync(proc.outputPath);
      } catch {
        gone = false;
      }
    }
    const { rows, truncated } = tail(lines, limit);
    return {
      ref,
      title: proc.description || proc.command,
      running: proc.running,
      mode: proc.running ? 'live' : 'audit',
      // Output lines carry no timestamps of their own — the file's mtime is the only honest clock here.
      entries: rows.map((l) => ({ ts: 0, kind: 'output' as const, label: l })),
      truncated,
      lastTs: proc.lastOutputTs || proc.endedTs || proc.startedTs,
      // `truncated` can only count lines INSIDE the tail window, so on a large log it reads 0 while
      // megabytes sit unseen. State the window against the real file size instead of implying the tail
      // is the whole story.
      note: gone
        ? 'the output file has been cleaned up — nothing left to read'
        : !proc.outputPath
        ? 'this shell has no output file to follow'
        : proc.outputBytes > OUTPUT_TAIL_BYTES
          ? `showing the last ${Math.round(OUTPUT_TAIL_BYTES / 1024)} kB of ${(proc.outputBytes / 1048576).toFixed(1)} MB`
          : undefined,
    };
  }

  if (ref.kind === 'agent') {
    const dir = findSubagentsDir(cwd, sessionId);
    const file = dir ? path.join(dir, `agent-${ref.id}.jsonl`) : null;
    if (!file || !fs.existsSync(file)) return empty(ref, ref.id, 'no transcript for this agent yet');
    const actions = parseTranscriptActions(file, { includeSidechain: true });
    const merged = [...proseEntries(file, true), ...actions.map((a) => fromAction(a))].sort((x, y) => x.ts - y.ts);
    const { rows, truncated } = feedTail(merged, limit);
    const { phase } = agentPhaseDetail(file);
    const agentLive = phase === 'working' || phase === 'awaiting-input' || phase === 'awaiting-permission';
    return {
      ref,
      // Prefer the agent's own description over its id: the id is what the reader just clicked.
      title: (dir ? subagentLabel(dir, ref.id) : '') || ref.id,
      running: agentLive,
      mode: agentLive ? 'live' : 'audit',
      entries: rows,
      truncated,
      lastTs: mtime(file),
    };
  }

  if (ref.kind === 'workflow') {
    const run = parseWorkflows(cwd, sessionId).find((w) => w.id === ref.id);
    const dir = findSubagentsDir(cwd, sessionId);
    if (!run || !dir) return empty(ref, ref.id, 'no such workflow run in this session');
    // Merge every agent's stream so the run reads as one story, each row tagged with who did it.
    const merged: FeedEntry[] = [];
    let newest = 0;
    for (const a of run.agents) {
      const file = path.join(dir, 'workflows', run.id, `agent-${a.agentId}.jsonl`);
      if (!fs.existsSync(file)) continue;
      newest = Math.max(newest, mtime(file));
      const label = a.label ?? a.phase ?? a.agentId.slice(0, 8);
      merged.push(...proseEntries(file, true, label));
      for (const act of parseTranscriptActions(file, { includeSidechain: true })) merged.push(fromAction(act, label));
    }
    merged.sort((x, y) => x.ts - y.ts);
    const { rows, truncated } = feedTail(merged, limit);
    return { ref, title: run.name, running: run.running, mode: run.running ? 'live' : 'audit', entries: rows, truncated, lastTs: newest || run.lastActivityMs || 0 };
  }

  if (ref.kind === 'task') {
    // The strict-span task model lives on the change map, which the Overview has already built — so read
    // the CACHED one. This said the same thing while calling the raw builder, which re-derived the whole
    // map (seconds on a large session) on every feed poll to look up one task's interval.
    const task = cachedChangeMap(cwd, sessionId, { root: cwd, prompts: true }).tasks.find((t) => t.taskId === ref.id);
    if (!task) return empty(ref, ref.id, 'no such task in this session');
    // A task owns a real interval, so its feed is the main chain's calls inside that window.
    const end = task.lastTs || Number.MAX_SAFE_INTEGER;
    const taskTranscript = findTranscript(cwd, sessionId) ?? '';
    const inWindow = (e: { ts: number }) => e.ts >= task.firstTs && e.ts <= end;
    const within = [
      ...proseEntries(taskTranscript, false).filter(inWindow),
      ...parseTranscriptActions(taskTranscript, { includeSidechain: false }).filter(inWindow).map((a) => fromAction(a)),
    ].sort((x, y) => x.ts - y.ts);
    const { rows, truncated } = feedTail(within, limit);
    return {
      ref,
      title: task.content,
      running: !task.lastTs,
      mode: task.lastTs ? 'audit' : 'live',
      entries: rows,
      truncated,
      lastTs: rows.length ? rows[rows.length - 1].ts : task.lastTs,
      // An empty task feed has two very different causes, and a bare "nothing recorded yet" hides which.
      note: rows.length
        ? undefined
        : task.firstTs > (task.lastTs || Number.MAX_SAFE_INTEGER)
          ? 'this task has no usable window (its recorded start is after its end)'
          : 'no tool calls fell inside this task’s window',
    };
  }

  let resolved = resolveSession(cwd, sessionId);
  const permissions = hookPermissionEntries(sessionId);
  if (!resolved) {
    // THE EDITS THE AGENT MADE, not only the permissions it asked for.
    //
    // A driven session has no transcript, so this branch listed the permission log and nothing
    // else — and a session where every call was pre-approved listed nothing at all. The edits were
    // in the store the whole time, reviewable, invisible here. They are rows now, each carrying its
    // record id, which is what lets a surface open the diff behind one.
    // The window is the last `limit` rows by time, and the log is already in time order — so only
    // its tail can reach the window. Mapping and sorting the whole log to keep sixty rows cost
    // 10ms per poll on a long session, in a subprocess that starts cold every three seconds.
    const log = readLog(sessionId);
    const edits: FeedEntry[] = log.slice(Math.max(0, log.length - limit)).map((rec) => {
      const file = rec.file ?? '';
      // Anchored at the workspace, like every other path this product shows a reader: the absolute
      // form wrapped across two rows of a narrow feed to say what the row above already said.
      const rel = file && cwd && file.startsWith(cwd) ? file.slice(cwd.length).replace(/^[/\\]+/, '') : file;
      return {
        ts: rec.ts,
        kind: 'action' as const,
        label: String(rec.tool ?? 'Edit'),
        ...(rel ? { target: rel } : {}),
        category: 'edit',
        ok: true,
        editId: rec.id,
      };
    });
    // …and the TOOL CALLS it made: the drive journals every update, so a read
    // is a row and a shell call reads as a shell call here too — not only the edits and the asks.
    const all = [...permissions, ...edits].sort((x, y) => x.ts - y.ts);
    if (!all.length) return empty(ref, sessionId, 'no transcript for this session');
    const { rows, truncated } = tail(all, limit);
    const lastTs = rows.length ? rows[rows.length - 1].ts : 0;
    // The same 60 s liveness rule every other surface uses: a drive that asked for a permission
    // seconds ago is LIVE, and labeling it an audit log would tell the reader to stop watching
    // exactly when watching matters.
    const live = lastTs > 0 && Date.now() - lastTs < 60_000;
    return {
      ref,
      title: sessionId,
      running: live,
      mode: live ? 'live' : 'audit',
      entries: rows,
      truncated,
      lastTs,
      note: 'no transcript — showing captured edits and hook events',
    };
  }
  const transcript = resolved.transcript;
  const actions = parseTranscriptActions(transcript, { includeSidechain: false });
  // ATTRIBUTION, so each file-edit row can name the store record it produced. It is a separate
  // pass by design (it reads the log), and the feed skipped it — which left `editId` declared and
  // never populated. Failure here is not fatal: a feed without ids still lists what happened.
  try {
    // Through the SAME helper the Actions view uses — subagent-aware. Attributing with the main
    // chain as the only author makes the positional pass consume a subagent's record for the same
    // file, and the feed row then opens (and keeps, and undoes) somebody else's edit.
    linkEditIds(cwd, sessionId, actions);
  } catch {
    /* a torn log still yields a readable feed — the rows simply cannot open their diffs */
  }
  // DISPLAY-ONLY diff recovery. The
  // strict pass above leaves an edit UNLINKED when it interleaves with a subagent's edits to the same
  // file — attribution refuses to guess THERE, because a wrong id would keep/undo the wrong change. But
  // the store still holds that edit's diff, and its ts is effectively unique, so for DISPLAY we match the
  // nearest still-unclaimed store record by (file, ts) and hang a `previewId` on the row. The Agent
  // screen renders that diff; keep/undo stay disabled (they key on the strict `editId`, still null). One
  // record per row, and records the strict pass already claimed are off the table, so no two rows share a
  // diff and no row borrows an attributed edit's.
  try {
    const claimed = new Set<number>(actions.map((a) => a.editId).filter((x): x is number => typeof x === 'number'));
    const byFile = new Map<string, { id: number; ts: number }[]>();
    for (const r of readLog(sessionId)) {
      const k = path.resolve(r.file);
      if (!byFile.has(k)) byFile.set(k, []);
      byFile.get(k)!.push({ id: r.id, ts: r.ts });
    }
    for (const a of actions) {
      if (a.category !== 'edit' || typeof a.editId === 'number') continue;
      const recs = (byFile.get(path.resolve(a.target)) ?? []).filter((r) => !claimed.has(r.id));
      if (!recs.length) continue;
      let best = recs[0];
      for (const r of recs) if (Math.abs(r.ts - a.ts) < Math.abs(best.ts - a.ts)) best = r;
      a.previewId = best.id;
      claimed.add(best.id);
    }
  } catch {
    /* best-effort display aid — its absence just leaves the row without its diff, as before */
  }
  // THE USER'S OWN TURNS — every ask
  // is a row of its own, so the feed reads ask → work → ask, and a prompt click lands on the ask
  // itself rather than the nearest tool call. Same source as the Prompts tab (the change map's
  // prompt axis), so the two surfaces agree on index and time.
  let asks: FeedEntry[] = [];
  try {
    asks = cachedChangeMap(cwd, sessionId, { root: cwd, prompts: true }).prompts.map((pr) => ({
      ts: pr.ts,
      kind: 'prompt' as const,
      label: `#${pr.index}`,
      promptText: pr.text,
    }));
  } catch {
    /* a torn map loses the ask rows, never the feed */
  }
  // THE AGENT'S OWN WORDS (one Timeline surface with all the info) — its replies
  // and its thinking are rows of their own, so the feed reads ask → thought → said → calls → said,
  // the whole conversation, and the answer that closes a turn is on the surface and not only pinned
  // beside it. Prose goes first so the stable sort keeps a message's words ahead of its calls.
  const merged = [...proseEntries(transcript, false), ...actions.map((a) => fromAction(a)), ...permissions, ...asks].sort((x, y) => x.ts - y.ts);
  const { rows, truncated } = feedTail(merged, limit);
  const { phase } = agentPhaseDetail(transcript);
  const live = phase === 'working' || phase === 'awaiting-input' || phase === 'awaiting-permission';
  return {
    ref,
    title: sessionId,
    running: live,
    mode: live ? 'live' : 'audit',
    entries: rows,
    truncated,
    lastTs: mtime(transcript),
  };
}

/** Latest native transcript reply, resolved by session even outside the current workspace. */
export function lastAgentMessage(sessionId: string): { lastMessage?: string; lastMessageTs?: number } {
  const transcript = (require('./asks') as typeof import('./asks')).transcriptForSession(sessionId);
  if (!transcript) return {};
  const lastMessage = transcriptInsightsAt(transcript).lastSummary;
  return lastMessage ? { lastMessage, lastMessageTs: mtime(transcript) } : {};
}

/** The sidecar's permission round-trips as feed rows: the ask, then the answer by its human name.
 *  Answers pair by toolCallId (two asks can be in flight), with append order as the fallback for
 *  sidecars from before the id rode the outcome. Wire payloads are agent-controlled: every field
 *  is guarded, because a malformed option must not take the whole feed down. */
export function hookPermissionEntries(sessionId: string): FeedEntry[] {
  const out: FeedEntry[] = [];
  type Ask = { title: string; toolCallId: string; options: Map<string, string> };
  const byTc = new Map<string, Ask>();
  /** Each ask's own row, so its outcome can mark it settled rather than leaving it pending forever. */
  const askRow = new Map<Ask, FeedEntry>();
  const fifo: Ask[] = [];
  for (const e of readCaptureEvents(sessionId, ['permission_request', 'permission_outcome'])) {
    if (e.kind === 'permission_request') {
      const p = e.payload as { toolCall?: { title?: unknown; toolCallId?: unknown }; options?: unknown[] };
      const ask: Ask = {
        title: String(p?.toolCall?.title ?? 'tool call'),
        toolCallId: String(p?.toolCall?.toolCallId ?? ''),
        options: new Map(
          (Array.isArray(p?.options) ? p.options : [])
            .filter((o): o is { optionId?: unknown; name?: unknown } => !!o && typeof o === 'object')
            .map((o) => [String(o.optionId ?? ''), String(o.name ?? o.optionId ?? '')])
        ),
      };
      if (ask.toolCallId) byTc.set(ask.toolCallId, ask);
      fifo.push(ask);
      // The row is kept so its outcome can settle it below; an ask nothing ever answered keeps the
      // pending mark, which is the truth about it.
      askRow.set(ask, { ts: e.ts, kind: 'permission', label: 'permission asked', target: ask.title });
      out.push(askRow.get(ask)!);
    } else if (e.kind === 'permission_outcome') {
      const o = e.payload as { optionId?: unknown; toolCallId?: unknown };
      const tc = String(o?.toolCallId ?? '');
      const ask = (tc && byTc.get(tc)) || fifo[0];
      if (!ask) continue; // an answer with no recorded ask — a torn sidecar; skip, never crash
      byTc.delete(ask.toolCallId);
      const at = fifo.indexOf(ask);
      if (at >= 0) fifo.splice(at, 1);
      const asked = askRow.get(ask);
      if (asked) asked.ok = true; // it was answered — it is no longer pending
      out.push({
        ts: e.ts,
        kind: 'permission',
        label: `permission answered: ${ask.options.get(String(o?.optionId ?? '')) ?? String(o?.optionId ?? '?')}`,
        target: ask.title,
        ok: true,
      });
    }
  }
  return out;
}
