/**
 * Workflow-run tracking (zero-token): one level ABOVE subagents. A Claude Code *workflow run* is a
 * scripted fan-out of agents recorded under <session>/subagents/workflows/wf_<id>/ — a `journal.jsonl`
 * (started/result per agent, keyed by the runner's phase/label group), one `agent-<id>.jsonl`
 * transcript per workflow agent (SAME format the subagent parser reads), and an `agent-<id>.meta.json`
 * sidecar.
 *
 * PRIMARY source (when present): the rich per-run state file <session>/workflows/wf_<id>.json — a SIBLING
 * of subagents/ — carrying the run's informative name/summary, declared phases, and a `workflowProgress`
 * stream of phase markers + labeled agent entries (label, real phaseTitle, tokens, toolCalls, state,
 * durationMs). It's far richer than the journal, so we read it first and derive name/description/phases,
 * per-agent tokens/time + label/phase, and phaseGroups (agents grouped by phase, per-phase done/total)
 * from it. FALLBACK (older runs with no state file): the journal + naming script under
 * <session>/workflows/scripts/<name>-wf_<id>.js (`export const meta = {…}`), the pre-state-file behavior.
 *
 * parseSubagents (subagents.ts) reads only subagents/agent-*.jsonl and SKIPS this subdir, so a
 * workflow's agents are otherwise invisible. This aggregates them: per-agent + run-level tokens, wall-clock
 * (durationMs), and edits. Per-agent EDITS (and ±lines) ALWAYS come from each agent's own transcript
 * (reusing the subagent action parser) — the state file doesn't carry them; run-level tokens/durationMs
 * prefer the state file. Honest: when a field can't be recovered it's 0/null, never fabricated. No model
 * calls, no network.
 */
import * as fs from 'fs';
import * as path from 'path';
import { diffLines } from 'diff';
import { parseTranscriptActions } from './actions';
import { findSubagentsDir } from './subagents';
import { cachedByFiles, readLines, readText } from './fscache';
import { friendlyModel } from './format';
import { graphemeHead } from './graphemes';
/**
 * Freshness window for a workflow's `running` gate. Deliberately WIDER than the fleet's 60s
 * FLEET_ACTIVE_MS: a workflow agent deep in a long reasoning turn appends nothing to its transcript for
 * minutes, and a 60s gate made live runs flap to "not running" mid-think. 5 minutes matches
 * DONE_STALE_MS (actions.ts) — the same "long turn" bound the phase classifier uses. A killed or
 * abandoned run still ages out; `lastActivityMs` lets renderers say "active 3m ago" instead of
 * trusting the boolean alone.
 */
export const WORKFLOW_ACTIVE_MS = 5 * 60_000;

/** One workflow agent's metrics, mined from its OWN agent-<id>.jsonl transcript. */
export interface WorkflowAgent {
  agentId: string;
  /** The runner's per-agent label (e.g. 'S11-vscode') from the rich state file; in the journal fallback
   *  (a LIVE run — the state file only lands at completion) a label DERIVED from the agent's own prompt
   *  (see derivePromptLabels), marked by [labelDerived]; null when neither source yields one. */
  label: string | null;
  /** True when [label] is heuristic (prompt-derived on a live run) — renderers mark it (trailing '~'),
   *  never assert it. Always false for state-file labels. */
  labelDerived: boolean;
  /** The agent's phase — a REAL phase title (e.g. 'Implement') from the state file, else the journal `key`; null when neither. */
  phase: string | null;
  /** From the agent-<id>.meta.json sidecar (e.g. "workflow-subagent"); null when absent. */
  agentType: string | null;
  /** True once the journal recorded a `result` for this agent. */
  done: boolean;
  /** Sum of input+cache+output tokens across the agent's assistant messages (deduped by message id). */
  tokens: number;
  /** Wall-clock span of the agent's transcript (lastTs − firstTs), ms. */
  durationMs: number;
  /** Tool calls that edited a file (same classification the subagent panel uses). */
  edits: number;
  /** ±lines from the agent's OWN Edit/Write/MultiEdit inputs (the store can't attribute workflow agents). */
  added: number;
  removed: number;
  /** The agent's model as a short label (e.g. 'Opus 4.8'), '' when unknown. */
  model: string;
  /** The agent's declared reasoning effort ('high', 'max'), '' when the transcript never said it.
   *  Shown beside the model, never guessed — the default differs by build and model. */
  effort: string;
  /** 20-bin activity histogram over the agent's own assistant turns — the same sparkline the run header
   *  draws, per agent. */
  sparkline: number[];
}

/** Agents grouped by phase title, with per-phase progress — the state file's `workflowProgress` collapsed. */
export interface WorkflowPhaseGroup {
  /** The phase title (a real name like 'Implement' from the state file, or the journal key in fallback). */
  title: string;
  /** Agents in this phase that are done. */
  done: number;
  /** Total agents in this phase. */
  total: number;
}

export interface WorkflowRun {
  /** The wf_<id> directory name. */
  id: string;
  /** state-file `workflowName`, else meta.name from the script, else the script filename stem, else the wf_<id> id. */
  name: string;
  /** The INFORMATIVE description — state-file `summary`, else the script's meta.description. */
  description?: string;
  /** Declared phase titles from the state file's `phases[].title`, else the script's `meta.phases` (empty when neither). */
  phases: string[];
  agents: WorkflowAgent[];
  /** Agents grouped by phase, in phase order, with per-phase done/total (only phases that have agents). */
  phaseGroups: WorkflowPhaseGroup[];
  /** An agent is started-without-result AND the run was touched within WORKFLOW_ACTIVE_MS. */
  running: boolean;
  /** Newest mtime across the run's state file / journal / agent transcripts (ms epoch, 0 when none) —
   *  the freshness signal behind `running`, exposed so renderers can show "active Nm ago". */
  lastActivityMs: number;
  agentCount: number;
  tokens: number;
  durationMs: number;
  edits: number;
  added: number;
  removed: number;
  /** Earliest agent transcript timestamp (ms epoch), 0 when none. */
  startedTs: number;
  /** Latest agent transcript timestamp (ms epoch) — the sort key. */
  lastTs: number;
  /** 20-bin activity histogram across all the run's agents (assistant turns, span-normalized) — mirrors
   *  the fleet agent sparkline so the Workflows rows render with the identical mini-chart. */
  sparkline: number[];
}

const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0);

/** Parse ISO/epoch → ms epoch, 0 when absent. (Local copy so this file stays standalone, like subagents.ts.) */
function toMs(v: unknown): number {
  if (typeof v === 'number' && isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  return 0;
}

/** Added/removed lines between two strings, computed exactly as store `lineDelta` does (reused via diff). */
function diffCount(oldStr: unknown, newStr: unknown): { added: number; removed: number } {
  const before = typeof oldStr === 'string' ? oldStr : '';
  const after = typeof newStr === 'string' ? newStr : '';
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    const n = part.count ?? part.value.split('\n').length - 1;
    if (part.added) added += n;
    else if (part.removed) removed += n;
  }
  return { added, removed };
}

interface AgentMetrics {
  tokens: number;
  durationMs: number;
  edits: number;
  added: number;
  removed: number;
  firstTs: number;
  lastTs: number;
  /** One timestamp per counted assistant turn — the run buckets these into its activity sparkline. */
  activityTs: number[];
  /** The model the agent ran on (raw id, e.g. 'claude-opus-4-8'), '' when none seen. */
  model: string;
  /** The agent's declared reasoning effort ('low'…'max'), '' when the transcript never said. Never
   *  guessed: the default differs by build and by model, so a placeholder here would be fiction. */
  effort: string;
}

/** Bucket activity timestamps into a fixed-width sparkline (counts per bin, span-normalized) — the same
 *  shape the fleet sparkline uses, so the Workflows rows render identically. Loop-based min/max (not
 *  Math.min(...ts)) so a long-running workflow's timestamp array can't blow the call stack. */
function activitySparkline(tsList: number[], bins = 20): number[] {
  const out = new Array(bins).fill(0);
  const ts = tsList.filter((t) => t > 0);
  if (ts.length === 0) return out;
  let min = ts[0];
  let max = ts[0];
  for (const t of ts) {
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (max === min) {
    out[bins - 1] = ts.length; // all at one instant → a single trailing spike, not a divide-by-zero
    return out;
  }
  const span = max - min;
  for (const t of ts) {
    let i = Math.floor(((t - min) / span) * bins);
    if (i >= bins) i = bins - 1;
    out[i]++;
  }
  return out;
}

/**
 * Metrics for one workflow agent from its transcript. Edits reuse the subagent action parser; tokens
 * (input+cache+output per deduped message id, same formula as Stats), wall-clock (last−first timestamp),
 * and ±lines (from the agent's own Edit/Write/MultiEdit inputs) come from a single pass here — workflow
 * agents have no parent toolUseResult carrying these the way spawned subagents do.
 */
function agentMetrics(jsonlPath: string): AgentMetrics {
  // Memoized per (mtime,size) — parseWorkflows and workflowWindows both walk every run agent transcript.
  return cachedByFiles('agentMetrics', [jsonlPath], () => agentMetricsUncached(jsonlPath));
}

function agentMetricsUncached(jsonlPath: string): AgentMetrics {
  const edits = parseTranscriptActions(jsonlPath, { includeSidechain: true }).filter((a) => a.category === 'edit').length;
  let lines: string[];
  try {
    lines = readLines(jsonlPath);
  } catch {
    return { tokens: 0, durationMs: 0, edits, added: 0, removed: 0, firstTs: 0, lastTs: 0, activityTs: [], model: '', effort: '' };
  }
  let tokens = 0;
  let added = 0;
  let removed = 0;
  let firstTs = 0;
  let lastTs = 0;
  let model = '';
  let effort = '';
  const activityTs: number[] = [];
  const seen = new Map<string, number>(); // each message id counted, with the tokens it counts
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (o?.type === 'api-request-blob') continue;
    const ts = toMs(o.timestamp ?? o.ts);
    if (ts > 0) {
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (ts > lastTs) lastTs = ts;
    }
    // The effort rides the RECORD, not the message — the same place `metrics.ts` reads it. Taken
    // before the assistant filter below for exactly one reason: a `/effort` turn is not an assistant
    // record, and on builds that predate the field it is the only place the level is ever stated.
    if (typeof o.effort === 'string' && o.effort) effort = o.effort;
    const m = o.message;
    if (!m || m.role !== 'assistant') continue;
    if (typeof m.model === 'string' && m.model) model = m.model; // the agent's model (last non-empty wins)
    // Claude Code splits one assistant message across lines sharing a message.id, each with the usage
    // as it stood when the line was written (a later one can carry more output, never less) — count
    // each id's usage once, at its largest snapshot (same dedupe Stats uses) so a multi-block message
    // isn't multiplied, and a larger later snapshot adds only the difference.
    const id = typeof m.id === 'string' ? m.id : null;
    const u = m.usage || {};
    // NEW tokens only. Adding the cache counters made the same context count once per turn,
    // so this row reported millions where Claude Code's own view reported ~128k for the very
    // same agent. Two tools reporting different numbers for one run is worse than either being
    // slightly off — the reader cannot tell which to trust. Cache traffic is surfaced
    // separately (SessionTokens.cacheRead/cacheCreation), never folded in here.
    const tk = num(u.output_tokens) + num(u.input_tokens) + num(u.cache_creation_input_tokens);
    const prev = id === null ? undefined : seen.get(id);
    if (prev === undefined) {
      if (id !== null) seen.set(id, tk);
      tokens += tk;
      if (ts > 0) activityTs.push(ts); // one tick per assistant turn → the run's activity sparkline
    } else if (tk > prev) {
      tokens += tk - prev;
      seen.set(id as string, tk);
    }
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!b || b.type !== 'tool_use' || !b.input) continue;
      if (b.name === 'Edit') {
        const d = diffCount(b.input.old_string, b.input.new_string);
        added += d.added;
        removed += d.removed;
      } else if (b.name === 'Write' && typeof b.input.content === 'string') {
        added += b.input.content.split('\n').length; // full-file write: prior content isn't in the transcript
      } else if (b.name === 'MultiEdit' && Array.isArray(b.input.edits)) {
        for (const e of b.input.edits) {
          const d = diffCount(e && e.old_string, e && e.new_string);
          added += d.added;
          removed += d.removed;
        }
      }
    }
  }
  return { tokens, durationMs: firstTs && lastTs ? Math.max(0, lastTs - firstTs) : 0, edits, added, removed, firstTs, lastTs, activityTs, model, effort };
}

/** The journal `key` USED to be a phase name, but newer workflow runtimes put a per-agent content HASH
 *  there ("v2:<hex>", or a bare long hex) — that is an agent identifier, never a phase, so it must NOT be
 *  used to group agents (else every agent becomes its own bogus "phase"). */
function isHashKey(k: string): boolean {
  return /^v\d+:/.test(k) || /^[0-9a-f]{24,}$/i.test(k);
}

/** The first prompt text of one workflow agent's transcript (its first `user` line), or null.
 *  Reads only the leading bytes — transcripts grow to MBs but the prompt is always the first line. */
function readAgentPrompt(transcriptPath: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(transcriptPath, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(262144);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const chunk = buf.toString('utf8', 0, n);
    const nl = chunk.indexOf('\n');
    if (nl < 0) return null; // first line longer than the window — skip rather than mis-parse
    const o = JSON.parse(chunk.slice(0, nl));
    // Only the agent's PROMPT (its first user line) identifies it — never assistant output.
    if (o?.type === 'api-request-blob' || (o?.type !== 'user' && o?.message?.role !== 'user')) return null;
    const content = o?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      for (const b of content) if (b && b.type === 'text' && typeof b.text === 'string') return b.text;
    }
    return null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** LIVE-RUN label fallback: newer runtimes write journal entries with only a content-hash key — no
 *  label/phaseTitle — so until the completion-time state file lands, an agent's only on-disk identity is
 *  its own prompt. Fan-out prompts share their preamble and diverge at the task line, so each agent's
 *  label is its first prompt line NOT shared with a sibling (first line as a last resort). Heuristic —
 *  callers mark it via labelDerived, and the state file's real labels replace it at completion. */
function derivePromptLabels(wfDir: string, agentIds: Iterable<string>): Map<string, string> {
  const perAgent = new Map<string, string[]>();
  for (const id of agentIds) {
    const text = readAgentPrompt(path.join(wfDir, `agent-${id}.jsonl`));
    if (!text) continue;
    // A wide window: fan-out preambles (shared context pasted into every sibling) can run kilobytes
    // before the line that actually distinguishes the agent.
    const lines = graphemeHead(text, 48000)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length >= 8)
      .slice(0, 400);
    if (lines.length) perAgent.set(id, lines);
  }
  const freq = new Map<string, number>();
  for (const lines of perAgent.values()) for (const l of new Set(lines)) freq.set(l, (freq.get(l) ?? 0) + 1);
  const total = perAgent.size;
  const out = new Map<string, string>();
  for (const [id, lines] of perAgent) {
    // Siblings: first line unique to this agent, else first non-universal line. NO fallback to a shared
    // line — identical labels are worse than the agentType+id rows the caller renders without one.
    const pick = total > 1
      ? lines.find((l) => freq.get(l) === 1) ?? lines.find((l) => (freq.get(l) ?? 0) < total)
      : lines[0];
    if (pick) out.set(id, pick.length > 72 ? graphemeHead(pick, 71) + '…' : pick);
  }
  return out;
}

/** Per-agentId: its journal phase + label (when the runtime records them) + whether a `result` fired.
 *  Prefers an explicit `phaseTitle`/`label`; falls back to the `key` for phase ONLY when it's a real phase
 *  name (not a hash). A running workflow's journal typically carries none of these — the rich per-run
 *  state file (written at completion) is where labels/phases become available; until then the run degrades
 *  to a flat, unlabeled agent list rather than showing hash "phases". */
function readJournal(journalPath: string): Map<string, { phase: string | null; phaseFromKey: boolean; label: string | null; done: boolean }> {
  const out = new Map<string, { phase: string | null; phaseFromKey: boolean; label: string | null; done: boolean }>();
  let lines: string[];
  try {
    lines = readLines(journalPath);
  } catch {
    return out;
  }
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (typeof o.agentId !== 'string') continue;
    let e = out.get(o.agentId);
    if (!e) {
      e = { phase: null, phaseFromKey: false, label: null, done: false };
      out.set(o.agentId, e);
    }
    if (o.type === 'started') {
      if (e.phase === null && typeof o.phaseTitle === 'string' && o.phaseTitle) {
        e.phase = o.phaseTitle;
        e.phaseFromKey = false;
      } else if (e.phase === null && typeof o.key === 'string' && !isHashKey(o.key)) {
        // A key-derived phase is only a GUESS (marked so the caller can structurally validate it —
        // a future runtime's hash format could slip past the isHashKey regex).
        e.phase = o.key;
        e.phaseFromKey = true;
      }
      if (e.label === null && typeof o.label === 'string' && o.label) e.label = o.label;
    }
    if (o.type === 'result') e.done = true;
  }
  return out;
}

/** Pull a quoted string field (single/double/backtick) out of a JS object body, `undefined` when absent.
 *  Backslash escapes are resolved (`\"` → `"`) so display strings never show the source escaping. */
function metaStr(body: string, key: string): string | undefined {
  const re = new RegExp("(?:^|[^A-Za-z0-9_])" + key + "\\s*:\\s*(['\"`])((?:\\\\.|(?!\\1)[\\s\\S])*)\\1");
  const m = re.exec(body);
  return m ? m[2].replace(/\\(.)/g, '$1') : undefined;
}

/** Best-effort parse of a workflow script's `export const meta = {name, description, phases}` — never
 *  executes the script; brace-matches the object literal (string- and comment-aware, so a brace inside
 *  `description: "notes {see}"` or a // comment can't mis-slice the body), then regex-extracts fields.
 *  Empty phases on any parse miss (honest — the filename stem still names the run). */
function parseScriptMeta(text: string): { name?: string; description?: string; phases: string[] } {
  const head = /export\s+const\s+meta\s*=\s*\{/.exec(text);
  if (!head) return { phases: [] };
  const open = head.index + head[0].length - 1; // index of the '{'
  let depth = 0;
  let close = -1;
  for (let j = open; j < text.length; j++) {
    const ch = text[j];
    if (ch === "'" || ch === '"' || ch === '`') {
      // Skip the whole string literal (meta is a pure literal — nested template interpolation is
      // disallowed by the workflow contract, so a plain escape-aware scan to the closing quote is safe).
      for (j++; j < text.length; j++) {
        if (text[j] === '\\') j++; // skip the escaped char
        else if (text[j] === ch) break;
      }
    } else if (ch === '/' && text[j + 1] === '/') {
      const nl = text.indexOf('\n', j);
      j = nl < 0 ? text.length : nl;
    } else if (ch === '/' && text[j + 1] === '*') {
      const end = text.indexOf('*/', j + 2);
      j = end < 0 ? text.length : end + 1;
    } else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      close = j;
      break;
    }
  }
  if (close < 0) return { phases: [] };
  const body = text.slice(open, close + 1);
  const phases: string[] = [];
  const arr = /phases\s*:\s*\[([\s\S]*?)\]/.exec(body);
  if (arr) {
    // Object phases (`{ title: '…' }`) → titles; else a plain string array (`['…']`) → the strings.
    // The key may itself be quoted (`{"title":"Scope"}` — newer harnesses serialize meta phases as
    // JSON), so tolerate an optional quote around it; without this every string in the array leaks
    // into `phases` ("title","Scope","detail",…) via the plain-string fallback below.
    const titleRe = /['"`]?title['"`]?\s*:\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g;
    let t: RegExpExecArray | null;
    while ((t = titleRe.exec(arr[1]))) phases.push(t[2]);
    if (phases.length === 0) {
      const strRe = /(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g;
      let s: RegExpExecArray | null;
      while ((s = strRe.exec(arr[1]))) phases.push(s[2]);
    }
  }
  return { name: metaStr(body, 'name'), description: metaStr(body, 'description'), phases };
}

/** Resolve a run's name/description/phases from <scriptsDir>/<name>-<wfId>.js. Falls back to the filename
 *  stem for the name, then to the wfId itself when there's no script at all. */
function resolveMeta(scriptsDir: string, wfId: string): { name: string; description?: string; phases: string[] } {
  let file: string | undefined;
  try {
    file = fs.readdirSync(scriptsDir).find((f) => f.endsWith(`-${wfId}.js`));
  } catch {
    /* no scripts dir */
  }
  if (!file) return { name: wfId, phases: [] };
  const stem = file.slice(0, file.length - `-${wfId}.js`.length) || wfId;
  let meta: { name?: string; description?: string; phases: string[] } = { phases: [] };
  try {
    meta = parseScriptMeta(fs.readFileSync(path.join(scriptsDir, file), 'utf8'));
  } catch {
    /* unreadable script — keep the filename stem */
  }
  return { name: meta.name || stem, description: meta.description, phases: meta.phases };
}

/** The agentType from a workflow agent's `agent-<id>.meta.json` sidecar, or null when absent/unreadable. */
function readAgentType(wfDir: string, agentId: string): string | null {
  try {
    // Unmemoized and called from four places per pass — 863 reads of 220 sidecars in one cold run.
    // The parse stays per-call (callers get a fresh object); only the read is shared.
    const s = JSON.parse(readText(path.join(wfDir, `agent-${agentId}.meta.json`)));
    return s && typeof s.agentType === 'string' ? s.agentType : null;
  } catch {
    return null; // no sidecar
  }
}

/** The rich per-run state file, or null when absent/unparseable (older runs → the journal fallback). */
function readWorkflowState(stateFile: string): any | null {
  try {
    const o = JSON.parse(readText(stateFile));
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

/**
 * Build a run from the rich state file (PRIMARY). name/summary/phases come straight from it; per-agent
 * label/phase/tokens/state come from its `workflowProgress` agent entries; per-agent EDITS/±lines are
 * still mined from each agent's transcript (the state file doesn't carry them). Run tokens/durationMs
 * prefer the state file's totals; running = status !== 'completed'.
 */
function buildRunFromState(state: any, wfDir: string, wfId: string, stateFile: string, now: number): WorkflowRun {
  const progress: any[] = Array.isArray(state.workflowProgress) ? state.workflowProgress : [];
  // Ordered phase titles: `workflow_phase` markers first (runtime order), then any declared-but-unmarked phase.
  const phaseOrder: string[] = [];
  const seen = new Set<string>();
  for (const p of progress) {
    if (p && p.type === 'workflow_phase' && typeof p.title === 'string' && !seen.has(p.title)) {
      seen.add(p.title);
      phaseOrder.push(p.title);
    }
  }
  const phases: string[] = [];
  if (Array.isArray(state.phases)) {
    for (const p of state.phases) {
      if (p && typeof p.title === 'string') {
        phases.push(p.title);
        if (!seen.has(p.title)) {
          seen.add(p.title);
          phaseOrder.push(p.title);
        }
      }
    }
  }

  const agents: WorkflowAgent[] = [];
  let startedTs = 0;
  let lastTs = 0;
  const allActivityTs: number[] = [];
  for (const e of progress) {
    if (!e || e.type !== 'workflow_agent' || typeof e.agentId !== 'string') continue;
    const met = agentMetrics(path.join(wfDir, `agent-${e.agentId}.jsonl`));
    if (met.firstTs && (!startedTs || met.firstTs < startedTs)) startedTs = met.firstTs;
    if (met.lastTs > lastTs) lastTs = met.lastTs;
    for (const t of met.activityTs) allActivityTs.push(t);
    agents.push({
      agentId: e.agentId,
      label: typeof e.label === 'string' ? e.label : null,
      labelDerived: false,
      phase: typeof e.phaseTitle === 'string' ? e.phaseTitle : null,
      agentType: readAgentType(wfDir, e.agentId),
      done: e.state === 'done' || e.state === 'completed', // the state file uses 'done' for finished agents
      tokens: typeof e.tokens === 'number' && isFinite(e.tokens) ? e.tokens : met.tokens, // prefer the state file
      durationMs: typeof e.durationMs === 'number' && isFinite(e.durationMs) ? e.durationMs : met.durationMs,
      edits: met.edits, // edits/±lines/model/sparkline are never in the state file — always from the transcript
      added: met.added,
      removed: met.removed,
      model: friendlyModel(met.model),
      effort: met.effort,
      sparkline: activitySparkline(met.activityTs),
    });
  }

  // phaseGroups: agents grouped by phaseTitle, in phase order, per-phase done/total (only phases with agents).
  const phaseGroups: WorkflowPhaseGroup[] = [];
  for (const title of phaseOrder) {
    const inPhase = agents.filter((a) => a.phase === title);
    if (inPhase.length === 0) continue;
    phaseGroups.push({ title, done: inPhase.filter((a) => a.done).length, total: inPhase.length });
  }

  const startTimeMs = toMs(state.startTime);
  if (!startedTs && startTimeMs) startedTs = startTimeMs;
  const stateDuration = typeof state.durationMs === 'number' && isFinite(state.durationMs) ? state.durationMs : undefined;
  if (!lastTs) lastTs = startTimeMs ? startTimeMs + (stateDuration ?? 0) : 0;

  // The state file reads status:'running' until the runner writes 'completed' — but a killed / interrupted /
  // crashed run NEVER writes that, so status alone would mark a long-dead run as running forever (the exact
  // "shows two running things that aren't" bug). Gate on recent activity — the SAME freshness signal the
  // journal path uses: the newest mtime among the state file + the agent transcripts.
  let runMtime = 0;
  try {
    runMtime = Math.max(runMtime, fs.statSync(stateFile).mtimeMs);
  } catch {
    /* state file vanished */
  }
  try {
    for (const f of fs.readdirSync(wfDir)) {
      if (f.startsWith('agent-') && f.endsWith('.jsonl')) {
        try {
          runMtime = Math.max(runMtime, fs.statSync(path.join(wfDir, f)).mtimeMs);
        } catch {
          /* file vanished mid-scan */
        }
      }
    }
  } catch {
    /* no run dir (state-file-only run) */
  }
  const fresh = runMtime > 0 && now - runMtime <= WORKFLOW_ACTIVE_MS;

  return {
    id: wfId,
    name: typeof state.workflowName === 'string' && state.workflowName ? state.workflowName : wfId,
    description: typeof state.summary === 'string' ? state.summary : undefined,
    phases,
    agents,
    phaseGroups,
    running: state.status !== 'completed' && fresh,
    lastActivityMs: runMtime,
    agentCount: agents.length,
    tokens: typeof state.totalTokens === 'number' && isFinite(state.totalTokens) ? state.totalTokens : agents.reduce((n, a) => n + a.tokens, 0),
    durationMs: stateDuration ?? agents.reduce((n, a) => n + a.durationMs, 0),
    edits: agents.reduce((n, a) => n + a.edits, 0),
    added: agents.reduce((n, a) => n + a.added, 0),
    removed: agents.reduce((n, a) => n + a.removed, 0),
    startedTs,
    lastTs,
    sparkline: activitySparkline(allActivityTs),
  };
}

/**
 * Build a run from the journal + naming script (FALLBACK, used while a run is live — before its rich state
 * file is written at completion). Agents are keyed by the journal group; per-agent tokens/time/edits/±lines
 * come from each agent's transcript. Label + phase come from the journal ONLY if the runtime recorded real
 * ones (a hash `key` is ignored — see readJournal); otherwise both are null and the run renders as a flat,
 * agentType-labeled list until completion fills in the real names/phases. Running = a started-without-result
 * agent AND recent activity (a dangling `started` on a stale run is a crashed/abandoned run, not a live one).
 */
function buildRunFromJournal(wfDir: string, wfId: string, scriptsDir: string, now: number): WorkflowRun {
  const journal = readJournal(path.join(wfDir, 'journal.jsonl'));
  let files: string[] = [];
  try {
    files = fs.readdirSync(wfDir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'));
  } catch {
    /* dir vanished */
  }
  const agentIds = new Set<string>(journal.keys());
  for (const f of files) agentIds.add(f.replace(/^agent-/, '').replace(/\.jsonl$/, ''));

  const { name, description, phases } = resolveMeta(scriptsDir, wfId);

  // Structural check on key-derived phase guesses (belt over the isHashKey regex): a journal `key` is
  // trusted as a phase only when it matches a DECLARED phase title from the script meta (slug-compared,
  // so the runtime's 'phase-plan' matches a declared 'Plan') or is shared by 2+ agents (a grouping key).
  // A per-agent-unique key matching nothing declared is an agent identifier (e.g. a new runtime's
  // content-hash format the regex didn't recognize), never a phase — drop it rather than render a
  // bogus one-agent "phase" per agent. (Hex hashes can't slug-contain a real word: they have no
  // letters past 'f', so this can't resurrect what isHashKey already rejects.)
  const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const declaredSlugs = phases.map(slugOf).filter((s) => s.length >= 3);
  const matchesDeclared = (k: string) => {
    const ks = slugOf(k);
    return declaredSlugs.some((d) => ks.includes(d) || d.includes(ks));
  };
  const keyShare = new Map<string, number>();
  for (const e of journal.values()) if (e.phaseFromKey && e.phase) keyShare.set(e.phase, (keyShare.get(e.phase) ?? 0) + 1);
  for (const e of journal.values()) {
    if (e.phaseFromKey && e.phase && !matchesDeclared(e.phase) && (keyShare.get(e.phase) ?? 0) < 2) e.phase = null;
  }
  // Live runs: the journal carries no labels (hash keys only) — derive per-agent identity from the
  // prompts, used only where the journal has none (state-file labels replace these at completion).
  const derived = derivePromptLabels(wfDir, agentIds);
  const agents: WorkflowAgent[] = [];
  let startedTs = 0;
  let lastTs = 0;
  const allActivityTs: number[] = [];
  for (const agentId of agentIds) {
    const j = journal.get(agentId);
    const met = agentMetrics(path.join(wfDir, `agent-${agentId}.jsonl`));
    if (met.firstTs && (!startedTs || met.firstTs < startedTs)) startedTs = met.firstTs;
    if (met.lastTs > lastTs) lastTs = met.lastTs;
    for (const t of met.activityTs) allActivityTs.push(t);
    const journalLabel = j ? j.label : null;
    agents.push({
      agentId,
      label: journalLabel ?? derived.get(agentId) ?? null,
      labelDerived: !journalLabel && derived.has(agentId),
      phase: j ? j.phase : null,
      agentType: readAgentType(wfDir, agentId),
      done: j ? j.done : false,
      tokens: met.tokens,
      durationMs: met.durationMs,
      edits: met.edits,
      added: met.added,
      removed: met.removed,
      model: friendlyModel(met.model),
      effort: met.effort,
      sparkline: activitySparkline(met.activityTs),
    });
  }

  // phaseGroups from the journal-key groups (fallback has no real phase names — the key IS the grouping).
  const byPhase = new Map<string, { done: number; total: number }>();
  const order: string[] = [];
  for (const a of agents) {
    if (a.phase === null) continue;
    let g = byPhase.get(a.phase);
    if (!g) {
      g = { done: 0, total: 0 };
      byPhase.set(a.phase, g);
      order.push(a.phase);
    }
    g.total++;
    if (a.done) g.done++;
  }
  const phaseGroups: WorkflowPhaseGroup[] = order.map((title) => ({ title, done: byPhase.get(title)!.done, total: byPhase.get(title)!.total }));

  // Freshness keys off the newest agent-transcript/journal mtime — the SAME transcript-freshness signal
  // the fleet uses — not the dir's own mtime, which doesn't advance as agents append to their transcripts.
  const hasUnfinished = [...journal.values()].some((e) => !e.done);
  let runMtime = 0;
  for (const f of [...files, 'journal.jsonl']) {
    try {
      runMtime = Math.max(runMtime, fs.statSync(path.join(wfDir, f)).mtimeMs);
    } catch {
      /* file vanished */
    }
  }
  const fresh = runMtime > 0 && now - runMtime <= WORKFLOW_ACTIVE_MS;
  return {
    id: wfId,
    name,
    description,
    phases,
    agents,
    phaseGroups,
    running: hasUnfinished && fresh,
    lastActivityMs: runMtime,
    agentCount: agents.length,
    tokens: agents.reduce((n, a) => n + a.tokens, 0),
    durationMs: agents.reduce((n, a) => n + a.durationMs, 0),
    edits: agents.reduce((n, a) => n + a.edits, 0),
    added: agents.reduce((n, a) => n + a.added, 0),
    removed: agents.reduce((n, a) => n + a.removed, 0),
    startedTs,
    lastTs,
    sparkline: activitySparkline(allActivityTs),
  };
}

/**
 * Every workflow run in this session — each with its agents (phase-grouped) and per-agent + run-level
 * tokens / wall-clock / edits / ±lines — newest run first (by last transcript activity). Reads the rich
 * per-run state file <session>/workflows/wf_<id>.json when present, else falls back to the journal +
 * naming script. Empty when the session has no workflow runs at all. Zero token, git-free, path-only.
 */
export function parseWorkflows(cwd: string, sessionId: string): WorkflowRun[] {
  const subDir = findSubagentsDir(cwd, sessionId);
  if (!subDir) return [];
  const wfRoot = path.join(subDir, 'workflows'); // <proj>/<session>/subagents/workflows — the wf_<id>/ run dirs
  const stateRoot = path.join(path.dirname(subDir), 'workflows'); // <proj>/<session>/workflows — rich state files + scripts/
  const scriptsDir = path.join(stateRoot, 'scripts');
  // A run is discoverable by its run dir (transcripts/journal) OR its rich state file — union both.
  const ids = new Set<string>();
  try {
    for (const d of fs.readdirSync(wfRoot)) if (d.startsWith('wf_') && fs.statSync(path.join(wfRoot, d)).isDirectory()) ids.add(d);
  } catch {
    /* no run dir yet */
  }
  try {
    for (const f of fs.readdirSync(stateRoot)) if (f.startsWith('wf_') && f.endsWith('.json')) ids.add(f.slice(0, -'.json'.length));
  } catch {
    /* no state dir */
  }
  if (ids.size === 0) return [];
  const now = Date.now();
  const out: WorkflowRun[] = [];
  for (const wfId of ids) {
    const wfDir = path.join(wfRoot, wfId);
    const stateFile = path.join(stateRoot, `${wfId}.json`);
    const state = readWorkflowState(stateFile);
    out.push(state ? buildRunFromState(state, wfDir, wfId, stateFile, now) : buildRunFromJournal(wfDir, wfId, scriptsDir, now));
  }
  out.sort((a, b) => b.lastTs - a.lastTs || a.id.localeCompare(b.id));
  return out;
}

// --- workflow → store-edit attribution (0.8.0 r2) ----------------------------------------------
// A workflow's agents edit REAL files that the capture hooks land in the store under the parent session
// (the store has no author column). Attribution reuses the subagent ts-window approach (actions.ts): a
// parent-session store edit belongs to a workflow when its ts falls inside one of that workflow's agents'
// action windows (the [min,max] ts of that agent's tool_uses). Ambiguity — a ts inside TWO different
// workflows' windows — is honestly unassigned (null), never guessed.

/** Per-workflow ts-windows over its agents' tool_uses — the attribution spans workflowForTs consults. */
export interface WorkflowWindows {
  id: string; // the wf_<id> directory name
  windows: [number, number][]; // one [lo,hi] per agent that has ≥1 timestamped tool_use
}

/**
 * The ts-windows for every workflow run in this session — one [lo,hi] per agent (over that agent's
 * tool_use timestamps), reusing the transcript action parser. An agent with no timestamped tool_use
 * contributes no window (never claims an edit); a workflow with no windowed agent is omitted. Empty when
 * the session has no subagents/workflows dir. Zero token, git-free, path-only.
 */
export function workflowWindows(cwd: string, sessionId: string): WorkflowWindows[] {
  const subDir = findSubagentsDir(cwd, sessionId);
  if (!subDir) return [];
  const wfRoot = path.join(subDir, 'workflows');
  let entries: string[];
  try {
    entries = fs.readdirSync(wfRoot).filter((d) => d.startsWith('wf_') && fs.statSync(path.join(wfRoot, d)).isDirectory());
  } catch {
    return [];
  }
  const out: WorkflowWindows[] = [];
  for (const wfId of entries) {
    const wfDir = path.join(wfRoot, wfId);
    let files: string[] = [];
    try {
      files = fs.readdirSync(wfDir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'));
    } catch {
      continue; // dir vanished
    }
    const windows: [number, number][] = [];
    for (const f of files) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const a of parseTranscriptActions(path.join(wfDir, f), { includeSidechain: true })) {
        if (a.ts <= 0) continue;
        if (a.ts < lo) lo = a.ts;
        if (a.ts > hi) hi = a.ts;
      }
      if (lo <= hi) windows.push([lo, hi]);
    }
    if (windows.length) out.push({ id: wfId, windows });
  }
  return out;
}

/**
 * The workflow whose agent-window contains `ts`, or null when NONE — or when more than one DIFFERENT
 * workflow's window contains it (ambiguous → honestly unassigned, never guessed). Bounds are inclusive
 * on both ends, matching the subagent editId windows (actions.ts).
 */
export function workflowForTs(wf: WorkflowWindows[], ts: number): string | null {
  if (!ts) return null;
  let found: string | null = null;
  for (const w of wf) {
    if (w.windows.some(([lo, hi]) => ts >= lo && ts <= hi)) {
      if (found !== null && found !== w.id) return null; // in two workflows → ambiguous
      found = w.id;
    }
  }
  return found;
}
