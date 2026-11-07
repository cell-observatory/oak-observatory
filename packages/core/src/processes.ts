/**
 * Background shells (zero-token): the commands Claude launched with `run_in_background` and left
 * running — what Claude Code's own Background panel lists, reconstructed from the transcript so the
 * observatory can show them with the detail that panel omits (runtime, exit code, output volume).
 *
 * Everything here is structural, recorded by the harness itself:
 *   · the spawn      — a Bash tool_use with `run_in_background: true`, and a tool_result whose
 *                      `toolUseResult.backgroundTaskId` names the shell.
 *   · the completion — a `queue-operation` record carrying a <task-notification> block with the same
 *                      task-id, a <status>, and a summary that quotes the exit code.
 *   · the output     — the file named in <output-file>, stat'd for size and last write.
 *
 * Deliberately NOT reported: the OS process id. The transcript never records one, and inferring it by
 * scanning local processes would be wrong the moment the agent runs somewhere else (SSH, devcontainer,
 * another worktree) — which is a supported setup. The harness's shell id is the honest identity, and it
 * is what the agent itself uses to read or kill the shell.
 */
import * as fs from 'fs';
import * as path from 'path';
import { findTranscript } from './observe';
import { transcriptFacts } from './derived-transcript';

export interface BackgroundProcess {
  /** The worker whose transcript named this shell, when it is not the parent session. */
  workerId?: string;
  /** Codex exposes output in exec/write_stdin results, without a task output file. */
  recordedOutput?: string;
  recordedBytes?: number;
  /** The harness's background shell id (e.g. `bpkyyxbff`) — how the agent reads or kills it. */
  id: string;
  /** The tool_use that launched it, so a renderer can jump to it in the action timeline. */
  toolUseId: string | null;
  /** The shell command, verbatim. */
  command: string;
  /** The agent's one-line description of what it is for, when it gave one. */
  description: string | null;
  startedTs: number;
  /** 0 while still running. */
  endedTs: number;
  running: boolean;
  /** Harness status when it finished ('completed', 'failed', …); 'running' until then. */
  status: string;
  /** Exit code parsed from the completion summary; null when it never reported one. */
  exitCode: number | null;
  /** Wall-clock so far (live) or total (finished). */
  runtimeMs: number;
  outputPath: string | null;
  /** Bytes written to the output file, 0 when absent/unreadable. */
  outputBytes: number;
  /** Last write to the output file (ms epoch) — a running shell that stopped writing shows here. */
  lastOutputTs: number;
  /** For a shell with no recorded end: the newest moment this session is known to have existed. Runtime
   *  is measured to here rather than to `now`, because "nobody told us it stopped" is not the same fact
   *  as "it is still running" — without this a shell in a week-old session reports a week of runtime. */
  lastEvidenceTs?: number;
}

/** ISO/epoch → ms epoch, 0 when absent. */
function toMs(v: unknown): number {
  if (typeof v === 'number' && isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  return 0;
}

/** Pull one tagged value out of a <task-notification> block: the first `<name>` that is closed. indexOf, not a
 *  lazy `<name>([\s\S]*?)</name>`, which read to the end of the text from every unclosed opener. */
function tag(text: string, name: string): string {
  const open = text.indexOf(`<${name}>`);
  const close = open < 0 ? -1 : text.indexOf(`</${name}>`, open + name.length + 2);
  return close < 0 ? '' : text.slice(open + name.length + 2, close).trim();
}

/**
 * Every background shell this session launched, oldest first. `nowMs` is injectable so a caller (and
 * the tests) can pin the live runtime of a still-running shell.
 */
/** A worker's last words and its shells' last output can trail its completion notice by this much. */
const WORKER_END_GRACE_MS = 120_000;

export function sessionProcesses(cwd: string, sessionId: string, nowMs?: number): BackgroundProcess[] {
  const transcript = findTranscript(cwd, sessionId);
  if (!transcript) return [];
  const now = nowMs ?? Date.now();
  // The transcript half is memoized (the Processes tab polls, and re-reading a 50MB transcript per tick
  // is exactly the cost this codebase keeps removing). The LIVE half deliberately is not: a running
  // shell's runtime advances with the clock, and its output file grows without touching the transcript,
  // so caching either would freeze the two numbers the tab exists to show.
  const processes = parseProcesses(transcript);
  const workers = path.join(path.dirname(transcript), sessionId, 'subagents');
  try {
    for (const file of fs.readdirSync(workers)) {
      const match = /^agent-(.+)\.jsonl$/.exec(file);
      if (match) processes.push(...parseProcesses(path.join(workers, file), true).map(p => ({ ...p, workerId: match[1] })));
    }
  } catch { /* no worker transcripts yet */ }
  // A background worker ends with its completion notice; a foreground one with its spawn's terminal tool result (meta).
  const workerFacts = transcriptFacts(transcript).subagents;
  const workerEndedTs = (id: string): number => workerFacts.ended.get(id)?.ts || workerFacts.meta.get(id)?.endedTs || 0;
  return processes.map((p) => {
    const out = { ...p };
    if (out.outputPath) {
      try {
        const st = fs.statSync(out.outputPath);
        out.outputBytes = st.size;
        // Whole milliseconds, as every other stamp: a fractional mtime made the runtime change once the clock passed
        // its fraction, so an idle follow emitted a snapshot nothing had changed.
        out.lastOutputTs = Math.floor(st.mtimeMs);
      } catch {
        /* the file is gone (tmp reaped) — leave the zeros, they are honest */
      }
    }
    // A worker's shell reports its end only to that worker. Once the parent holds the worker's own completion notice,
    // a shell of it with no end, no later turn of the worker and no output since can no longer report one: it is not
    // listed as running for good.
    const workerEnd = out.running && out.workerId ? workerEndedTs(out.workerId) : 0;
    if (workerEnd > 0 && Math.max(out.lastEvidenceTs || 0, out.lastOutputTs || 0) <= workerEnd + WORKER_END_GRACE_MS) {
      out.running = false;
      out.status = 'no end recorded';
    }
    // Finished → its real span. Still open → up to the newest evidence (its own output, the session's
    // last record), and never past now.
    const openUntil = Math.min(now, Math.max(out.lastOutputTs || 0, out.lastEvidenceTs || 0, out.startedTs));
    out.runtimeMs = Math.max(0, (out.endedTs || openUntil) - out.startedTs);
    return out;
  }).sort((a, b) => Number(b.running) - Number(a.running) || a.startedTs - b.startedTs);
}

export function processKey(p: BackgroundProcess): string { return p.workerId ? `${p.workerId}:${p.id}` : p.id; }

/** The transcript-derived skeleton of every background shell — pure, so it memoizes cleanly. */
function parseProcesses(transcript: string, includeSidechain = false): BackgroundProcess[] {
  return processesFromFacts(transcriptFacts(transcript, includeSidechain).processes);
}

/** Compact cursor state; pending completions and kills remain unresolved until projection. */
export interface ProcessFacts {
  byToolUse: Map<string, BackgroundProcess>;
  byId: Map<string, BackgroundProcess>;
  pendingEnd: { id: string; toolUseId: string; ts: number; status: string; summary: string; outputFile: string }[];
  stopped: Map<string, number>;
  codexPolls: Map<string, string>;
  lastRecordTs: number;
}
export function newProcessFacts(): ProcessFacts {
  return { byToolUse: new Map(), byId: new Map(), pendingEnd: [], stopped: new Map(), codexPolls: new Map(), lastRecordTs: 0 };
}

/** Fold one record, retaining the original parser's notification ordering. */
export function foldProcessFacts(facts: ProcessFacts, o: any): void {
  if (o?.type === 'api-request-blob') return;
  const { byToolUse, byId, pendingEnd, stopped } = facts;
  const ts = toMs(o.timestamp ?? o.ts);
  if (ts > facts.lastRecordTs) facts.lastRecordTs = ts;

  // The completion notification is its own record type, with no `message` at all. A worker's transcript records it
  // as a queued-command attachment instead; read both, or every worker shell stays "running" for good.
  const notice = typeof o.content === 'string' ? o.content
    : o?.type === 'attachment' && o.attachment?.type === 'queued_command' && typeof o.attachment.prompt === 'string' ? o.attachment.prompt : '';
  if (notice.includes('<task-notification>')) {
    o = { ...o, content: notice };
    const id = tag(o.content, 'task-id');
    const p = id ? byId.get(id) : undefined;
    if (!p) {
      pendingEnd.push({
        id,
        toolUseId: tag(o.content, 'tool-use-id'),
        ts,
        status: tag(o.content, 'status'),
        summary: tag(o.content, 'summary'),
        outputFile: tag(o.content, 'output-file'),
      });
      return;
    }
    // The harness logs each completion TWICE — `enqueue` when the shell finished, `remove` when the
    // next turn consumed the notification. The first is when it actually ended; taking the later one
    // inflated runtimes by the agent's own think-time (up to 10x on a busy run).
    if (p && !p.endedTs) {
      const status = tag(o.content, 'status');
      const summary = tag(o.content, 'summary');
      const code = /exit code (-?\d+)/.exec(summary);
      p.status = status || 'completed';
      p.running = false;
      p.endedTs = ts;
      p.exitCode = code ? Number(code[1]) : null;
      // A notification can also mean "killed"/"failed" — pass the harness's own word through.
      if (!p.outputPath) p.outputPath = tag(o.content, 'output-file') || null;
    }
    return;
  }

  const msg = o.message;
  if (!msg || !Array.isArray(msg.content)) return;

  if (msg.role === 'assistant') {
    for (const b of msg.content) {
      if (o.runtime === 'codex' && b?.type === 'tool_use' && b.name === 'write_stdin') {
        facts.codexPolls.set(b.id, `codex-${b.input?.session_id}`);
        continue;
      }
      if (b?.type === 'tool_use' && b.name === 'TaskStop') {
        const killed = b.input && typeof b.input === 'object' && typeof b.input.task_id === 'string' ? b.input.task_id : '';
        if (killed) stopped.set(killed, ts);
        continue;
      }
      if (b?.type !== 'tool_use' || b.name !== 'Bash') continue;
      const input = b.input && typeof b.input === 'object' ? b.input : {};
      if (input.run_in_background !== true && o.runtime !== 'codex') continue;
      const rec: BackgroundProcess = {
        id: '', // filled in from the result
        toolUseId: typeof b.id === 'string' ? b.id : null,
        command: typeof input.command === 'string' ? input.command : '',
        description: typeof input.description === 'string' ? input.description : null,
        startedTs: ts,
        endedTs: 0,
        running: true,
        status: 'running',
        exitCode: null,
        runtimeMs: 0,
        outputPath: null,
        outputBytes: 0,
        lastOutputTs: 0,
      };
      if (rec.toolUseId) byToolUse.set(rec.toolUseId, rec);
    }
    return;
  }

  if (msg.role === 'user') {
    if (o.runtime === 'codex') {
      for (const b of msg.content) {
        if (b?.type !== 'tool_result') continue;
        const text = typeof b.content === 'string' ? b.content : '';
        const poll = facts.codexPolls.get(b.tool_use_id);
        facts.codexPolls.delete(b.tool_use_id);
        const rec = poll ? byId.get(poll) : byToolUse.get(b.tool_use_id);
        if (!rec) continue;
        const running = /Process running with session ID (\d+)/.exec(text);
        if (!rec.id && !running) { byToolUse.delete(b.tool_use_id); continue; }
        if (running) { rec.id = `codex-${running[1]}`; byId.set(rec.id, rec); }
        const output = text.includes('\nOutput:\n') ? text.slice(text.indexOf('\nOutput:\n') + 9) : '';
        rec.recordedOutput = ((rec.recordedOutput || '') + output).slice(-16 * 1024);
        rec.recordedBytes = (rec.recordedBytes || 0) + Buffer.byteLength(output);
        rec.outputBytes = rec.recordedBytes;
        rec.lastOutputTs = ts;
        const ended = /Process exited with code (-?\d+)/.exec(text);
        if (ended) { rec.running = false; rec.status = 'completed'; rec.exitCode = Number(ended[1]); rec.endedTs = ts; }
      }
      return;
    }
    // The result names the shell: `toolUseResult.backgroundTaskId`, with the output path in its text.
    const bgId = o.toolUseResult && typeof o.toolUseResult.backgroundTaskId === 'string' ? o.toolUseResult.backgroundTaskId : '';
    if (!bgId) return;
    for (const b of msg.content) {
      if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      const rec = byToolUse.get(b.tool_use_id);
      if (!rec) continue;
      rec.id = bgId;
      const text = typeof b.content === 'string' ? b.content : '';
      const m = /Output is being written to: (\S+?)\.?(?:\s|$)/.exec(text);
      if (m) rec.outputPath = m[1];
      byId.set(bgId, rec);
    }
  }
}


/** Project onto copies: a read must not finalize pending ends in the persisted cursor. */
export function processesFromFacts(facts: ProcessFacts): BackgroundProcess[] {
  const copies = new Map<BackgroundProcess, BackgroundProcess>();
  const copy = (p: BackgroundProcess): BackgroundProcess => {
    if (!copies.has(p)) copies.set(p, { ...p });
    return copies.get(p)!;
  };
  const byToolUse = new Map([...facts.byToolUse].map(([id, p]) => [id, copy(p)]));
  const byId = new Map([...facts.byId].map(([id, p]) => [id, copy(p)]));
  const { pendingEnd, stopped, lastRecordTs } = facts;

  // Ends that arrived before their binding, now resolvable by task-id or by the tool_use they answer.
  for (const e of pendingEnd) {
    const p = (e.id && byId.get(e.id)) || (e.toolUseId && byToolUse.get(e.toolUseId)) || undefined;
    if (!p || p.endedTs) continue;
    p.status = e.status || 'completed';
    p.running = false;
    p.endedTs = e.ts;
    const code = /exit code (-?\d+)/.exec(e.summary);
    p.exitCode = code ? Number(code[1]) : null;
    if (!p.outputPath) p.outputPath = e.outputFile || null;
  }
  for (const [id, ts] of stopped) {
    const p = byId.get(id);
    if (!p || p.endedTs) continue;
    p.status = 'stopped';
    p.running = false;
    p.endedTs = ts;
  }
  const out = [...byToolUse.values()].filter((p) => p.id);
  // A shell that never reported an end is not evidence that it is STILL going — it is evidence that
  // nothing said otherwise. Stamp the last moment we can actually vouch for, so a renderer measures
  // against that instead of against the clock (a dead session was reporting 6.4-day runtimes).
  for (const p of out) if (p.running) p.lastEvidenceTs = Math.max(lastRecordTs, p.startedTs);
  // Running first: this is the only Overview tab that doesn't lead with active work, and the one shell
  // you might actually act on was sitting at the bottom of a narrow pane. Oldest-first within each group.
  return out.sort((a, b) => Number(b.running) - Number(a.running) || a.startedTs - b.startedTs);
}

/** Headline for the Processes tab: how many are still running, and how many ran in total. */
export function summarizeProcesses(list: BackgroundProcess[]): { total: number; running: number; failed: number } {
  return {
    total: list.length,
    running: list.filter((p) => p.running).length,
    failed: list.filter((p) => !p.running && p.exitCode !== null && p.exitCode !== 0).length,
  };
}

/**
 * A bounded TAIL of a background shell's output — what it has printed so far, which for a still-running
 * job is the only way to see what it is doing. Tail rather than head: a long-running build's interesting
 * part is always its last lines, and reading a multi-megabyte log whole to show 20 lines is the kind of
 * thing that makes a panel janky.
 */
export function processOutputTail(outputPath: string | null, maxBytes = 16 * 1024): string {
  if (!outputPath) return '';
  let fd: number | undefined;
  try {
    fd = fs.openSync(outputPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return '';
    if (st.size === 0) return '';
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8', 0, n);
    // A mid-character cut at the window start would render as U+FFFD — drop the partial first line.
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : text;
    }
    return plainProcessOutput(text);
  } catch {
    return ''; // the file is gone or unreadable — an empty preview, never a thrown panel
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/** Shell output is text, never a terminal program (including colours and unterminated strings). */
export function plainProcessOutput(text: string): string {
  // An OSC string runs to its terminator or the end of the text; one cut short by any other escape is left for the
  // passes below, as before. Taking the terminator as optional, instead of failing and retrying from each introducer
  // inside the string, keeps the pass linear.
  return text
    .replace(/(?:\x1b\]|\u009d)[^\x07\x1b\u009c]*(\x07|\x1b\\|\u009c)?/g, (s, end, at, all) => end !== undefined || at + s.length === all.length ? '' : s)
    .replace(/(?:\x1b[PX^_]|[\u0090\u0098\u009e\u009f])[^\x1b\u009c]*(?:\x1b\\|\u009c|$)/g, '')
    .replace(/(?:\x1b\[|\u009b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]?/g, '')
    .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, '')
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}
