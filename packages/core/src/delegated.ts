/**
 * Delegated agents: agents OAK starts from a brief, each a full Claude Code or Codex session in its own herdr tab
 * (`oak agent start --brief`), tracked with a state OAK derives itself.
 *
 * Each agent is one record, `<store>/delegated/<id>.json`, which the index mirrors (its `delegated` table). The agent's
 * session id arrives by the agent's own hooks: the tab's shell exports `OAK_DELEGATED=<id>`, the agent inherits it, and
 * the first hook its session runs writes `<id>.session` (linkDelegated), first one wins.
 *
 * The state is never herdr's `agent_status` (it said `unknown` for Codex agents that had finished and for one still
 * working). It comes from what OAK reads already (deriveDelegatedState):
 * - done: the report the agent was told to write exists, written since it started;
 * - gone: its process or its pane ended without that report;
 * - blocked: its session's raised hand (a permission prompt, a question, a wait for input);
 * - errored: its last turn stopped on an error (Codex's `error` event, Claude Code's API error message), with the error's
 *   text: it sits at its composer until someone sends again;
 * - starting: no session yet;
 * - working: a turn in progress (Claude Code's `claude agents` says busy, or its transcript; Codex's rollout);
 * - waiting: the turn ended, and there is no report.
 * Each state carries when it began (`since`), from the evidence where it has a time (the report's write, the hand),
 * else when OAK first saw it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { keepFromOldClean, isSafeSessionId, rootDir, withFileMutation, withPrefsMutation } from './store';
import { claudeConfigDir } from './paths';
import { graphemeHead } from './graphemes';
import { delegatedDir, delegatedSessionPath, isDelegatedId } from './delegated-link';
import type { HerdrOptions } from './herdr';
export { linkDelegated, delegatedDir, isDelegatedId } from './delegated-link';
import type { PaneProcessInfo, SessionSnapshot } from './herdr-api';

export const DELEGATED_KINDS = ['claude', 'codex'] as const;
export type DelegatedKind = (typeof DELEGATED_KINDS)[number];
export const DELEGATED_STATES = ['queued', 'starting', 'working', 'waiting', 'blocked', 'errored', 'done', 'gone'] as const;
export type DelegatedState = (typeof DELEGATED_STATES)[number];

export interface DelegatedAgent {
  id: string;
  /** The brief's `# Title`, or its file name. */
  title: string;
  brief: string;
  /** The tree it works in. */
  cwd: string;
  worktree?: import('./agent-worktree').AgentWorktree;
  out: string;
  /** The report it was told to write, which marks it done. */
  report: string;
  kind: DelegatedKind;
  /** Claude Code's agent type (`--agent`). */
  agentType: string | null;
  model: string | null;
  effort: string | null;
  sandbox: string | null;
  /** The saved machine it runs on; null for this machine. */
  machine: string | null;
  workspace: string | null;
  tab: string | null;
  pane: string | null;
  /** The name herdr knows the agent by. */
  herdrName: string | null;
  pid: number | null;
  session: string | null;
  /** The delegated agent or session that started it. */
  parent: string | null;
  startedMs: number;
  /** When it reached done or gone. */
  endedMs: number | null;
  /** When `oak agent close` closed its tab; the row stays. */
  closedMs: number | null;
  state: DelegatedState;
  since: number;
  /** Why it did not start, or the error its last turn stopped on (`errored`). */
  error?: string;
  after?: string[];
  afterAny?: boolean;
  queuedMs?: number;
  /** Saved until the detached start has run. Paths on a saved machine stay that machine's paths. */
  launch?: Omit<DelegatedStartOptions, 'herdr' | 'sleep' | 'patience' | 'log'>;
  lastMessageMs?: number | null;
  messages?: { id: string; from: string; at: number; text: string }[];
  /** For an agent started from here on a saved machine (`machine`): its id there, and what was last read of it there
   *  (from this machine's index when oak sync keeps that machine current, else over ssh), and when. */
  remoteId?: string;
  remote?: { via: 'index' | 'ssh'; readMs: number; tokens: number | null; cost: number | null; workers: DelegatedWorker[] };
}

/** What deriveDelegatedState reads. Each field is null when it cannot be told. */
export interface DelegatedEvidence {
  session: string | null;
  report: { mtimeMs: number; size: number } | null;
  /** The session's raised hand (capture.ts AttentionState). */
  hand: { kind: string; ts: number } | null;
  /** The transcript or rollout: a turn in progress (`open`) or ended. */
  turn: 'open' | 'ended' | null;
  /** Claude Code's own status for the session (`claude agents --json`). */
  native: 'busy' | 'idle' | null;
  /** The agent's process and pane: false once either has ended. */
  alive: boolean | null;
  /** The last write to its transcript or rollout. */
  lastActiveMs: number | null;
  /** The error its last turn stopped on, and when (turnError). */
  turnError?: { message: string; ts: number } | null;
}

const recordPath = (id: string): string => path.join(delegatedDir(), `${id}.json`);

function readSessionLink(id: string): string | null {
  try {
    const s = fs.readFileSync(delegatedSessionPath(id), 'utf8').trim();
    return isSafeSessionId(s) ? s : null;
  } catch {
    return null;
  }
}

function parseRecord(raw: unknown): DelegatedAgent | null {
  const r = raw as Partial<DelegatedAgent> | null;
  if (!r || typeof r !== 'object' || !isDelegatedId(r.id) || !DELEGATED_KINDS.includes(r.kind as DelegatedKind)) return null;
  if (typeof r.startedMs !== 'number' || !DELEGATED_STATES.includes(r.state as DelegatedState)) return null;
  return r as DelegatedAgent;
}

export function readDelegated(id: string): DelegatedAgent | null {
  if (!isDelegatedId(id)) return null;
  try {
    const rec = parseRecord(JSON.parse(fs.readFileSync(recordPath(id), 'utf8')));
    if (rec && !rec.session) rec.session = readSessionLink(id);
    return rec;
  } catch {
    return null;
  }
}

/** Every record, newest first. */
export function listDelegatedRecords(): DelegatedAgent[] {
  let names: string[];
  try {
    names = fs.readdirSync(delegatedDir());
  } catch {
    return [];
  }
  const out: DelegatedAgent[] = [];
  for (const n of names) if (n.endsWith('.json')) { const r = readDelegated(n.slice(0, -5)); if (r) out.push(r); }
  return out.sort((a, b) => b.startedMs - a.startedMs || a.id.localeCompare(b.id));
}

export function writeDelegated(rec: DelegatedAgent): void {
  const dir = delegatedDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  keepFromOldClean(dir);
  withFileMutation(recordPath(rec.id), () => {
    // A refresh may have read before a tell finished. Keep every delivered message in the record.
    const previous = readDelegated(rec.id);
    if (previous?.closedMs != null) {
      rec.closedMs = previous.closedMs;
      if (rec.state !== 'done') Object.assign(rec, { state: previous.state === 'done' ? 'done' : 'gone',
        endedMs: previous.endedMs ?? previous.closedMs, since: isTerminalDelegated(previous.state) ? previous.since : previous.closedMs });
    }
    if (previous?.messages?.length) {
      rec.messages = [...new Map([...previous.messages, ...(rec.messages ?? [])].map(m => [m.id, m])).values()].sort((a, b) => a.at - b.at);
      rec.lastMessageMs = rec.messages[rec.messages.length - 1].at;
    }
    const tmp = `${recordPath(rec.id)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, recordPath(rec.id));
  });
}

/** A free id from a name: the name itself, else the name with the first free `-<n>`. */
export function delegatedIdFor(name: string): string {
  const base = graphemeHead(name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, ''), 56) || `agent-${randomBytes(3).toString('hex')}`;
  if (!fs.existsSync(recordPath(base))) return base;
  for (let n = 2; ; n++) if (!fs.existsSync(recordPath(`${base}-${n}`))) return `${base}-${n}`;
}

/** A brief's title: its first `# ` heading, else its file name. */
export function briefTitle(text: string, file: string): string {
  const m = /^#[ \t]+(.+?)[ \t#]*$/m.exec(graphemeHead(text, 16384));
  return (m?.[1] ?? path.basename(file).replace(/\.md$/i, '')).replace(/\s+/g, ' ').trim();
}

/** What the agent is handed: its brief, its tree and folder, and the report that ends it. */
export function delegatedPrompt(rec: Pick<DelegatedAgent, 'id' | 'title' | 'brief' | 'cwd' | 'out' | 'report'>): string {
  return `# ${rec.id}: ${rec.title}\n\nYour brief is ${rec.brief}. Read it and follow it. Work only in ${rec.cwd} and write to ${rec.out}/. ` +
    `When you finish, write ${rec.report} and end your last message with DONE.`;
}

const HAND_BLOCKS = new Set(['permission', 'question', 'input']);
const TERMINAL = new Set<DelegatedState>(['done', 'gone']);
export const isTerminalDelegated = (s: DelegatedState): boolean => TERMINAL.has(s);

/** The state the evidence shows, and when it began: the evidence's own time where it has one (the report's write, the
 *  hand's), the previous `since` while the state holds, else `now`. Done and gone are final. */
export function deriveDelegatedState(rec: Pick<DelegatedAgent, 'state' | 'since' | 'startedMs'>, e: DelegatedEvidence, now: number): { state: DelegatedState; since: number; error?: string } {
  const keep = (state: DelegatedState, at?: number | null): { state: DelegatedState; since: number } =>
    ({ state, since: rec.state === state ? rec.since : Math.round(Math.min(now, Math.max(rec.startedMs, at ?? now))) });
  if (TERMINAL.has(rec.state)) return { state: rec.state, since: rec.since };
  if (rec.state === 'queued') return { state: rec.state, since: rec.since };
  if (e.report && e.report.size > 0 && e.report.mtimeMs >= rec.startedMs) return keep('done', e.report.mtimeMs);
  if (e.alive === false) return keep('gone');
  if (e.hand && HAND_BLOCKS.has(e.hand.kind)) return keep('blocked', e.hand.ts);
  if (e.turnError) return { ...keep('errored', e.turnError.ts), error: e.turnError.message };
  if (!e.session) return keep('starting', rec.startedMs);
  if (e.native === 'busy') return keep('working');
  // The Stop hook's hand: the turn ended, whatever a transcript tail still shows.
  if (e.hand?.kind === 'idle-done') return keep('waiting', e.hand.ts);
  if (e.native === 'idle' || e.turn === 'ended') return keep('waiting', e.lastActiveMs);
  return keep('working');
}

/** The process herdr shows in a pane's foreground that is the agent: its CLI by name or argument. */
export function agentPid(info: PaneProcessInfo | null | undefined, kind: DelegatedKind): number | null {
  const shell = info?.shell_pid;
  for (const p of info?.foreground_processes ?? []) {
    if (p.pid === shell) continue;
    const words = [p.name, p.argv0 ?? '', ...(p.argv ?? [])].map((w) => path.basename(String(w)));
    if (words.some((w) => w === kind || w.startsWith(`${kind}-`) || w === `${kind}.js`)) return p.pid;
  }
  return null;
}

/** Whether a recorded pid still runs the agent: alive, and on Linux its command line still names the agent's CLI (a
 *  pid the system has since given to another program is not the agent). */
export function agentAlive(pid: number, kind: DelegatedKind): boolean {
  if (!(require('./daemon') as typeof import('./daemon')).pidAlive(pid, { reaped: true })) return false;
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(kind);
  } catch {
    return true; // no /proc (macOS): the pid is all there is
  }
}

/** Claude Code's registry changes when an agent starts or stops. Revalidate it even inside the memo window. */
function nativeRegistryStamp(): string {
  const dir = path.join(claudeConfigDir(), 'sessions');
  try {
    return fs.readdirSync(dir).filter(n => /^\d+\.json$/.test(n)).sort().map(n => {
      const st = fs.statSync(path.join(dir, n));
      return `${n}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    }).join('|');
  } catch { return ''; }
}

/** Claude Code's running sessions, shared by CLI and editor processes for ten seconds. Process liveness and
 *  transcripts are still read each refresh; a registry change also expires this answer immediately. */
export function claudeNativeStatus(bin = process.env.CLAUDE_BIN || 'claude'): Map<string, { status: 'busy' | 'idle'; pid: number | null }> {
  type Status = { status: 'busy' | 'idle'; pid: number | null };
  const key = createHash('sha256').update(JSON.stringify([bin, process.env.PATH, claudeConfigDir()])).digest('hex');
  const file = path.join(rootDir(), 'native-status', `${key}.json`);
  const stamp = nativeRegistryStamp();
  const cached = (): Map<string, Status> | undefined => {
    try {
      const c = JSON.parse(fs.readFileSync(file, 'utf8'));
      const age = Date.now() - c.at;
      if (age >= 0 && age < 10_000 && c.stamp === stamp && Array.isArray(c.rows)) return new Map(c.rows);
    } catch { /* absent, expired or incomplete */ }
    return undefined;
  };
  const read = (): Map<string, Status> => {
    const out = new Map<string, Status>();
    const r = (require('./spawn') as typeof import('./spawn')).spawnToolSync(bin, ['agents', '--json', '--all'], { encoding: 'utf8', timeout: 5000 });
    if (r.error || r.status !== 0) return out;
    let rows: unknown;
    try { rows = JSON.parse(String(r.stdout || '[]')); } catch { return out; }
    for (const row of Array.isArray(rows) ? rows : []) {
      const o = row as Record<string, unknown>;
      const id = typeof o?.sessionId === 'string' ? o.sessionId : null;
      const status = o?.status === 'busy' || o?.status === 'idle' ? o.status : null;
      if (id && status) out.set(id, { status, pid: typeof o.pid === 'number' ? o.pid : null });
    }
    return out;
  };
  const hit = cached();
  if (hit) return hit;
  try {
    // Recheck under the lock: simultaneous windows share the first reader's command too.
    return withPrefsMutation(file, () => {
      const hit = cached();
      if (hit) return hit;
      const at = Date.now(), rows = read();
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify({ at, stamp, rows: [...rows] }), { mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch { /* an unwritable cache does not discard the command's answer */ }
      finally { try { fs.unlinkSync(tmp); } catch { /* renamed or unwritable */ } }
      return rows;
    }, 6000);
  } catch { return read(); } // an unavailable cache must not prevent a live read
}

/** How much of a transcript's or rollout's end turnError reads: an error ends the turn, so it is among the last records. */
const ERROR_TAIL_BYTES = 64 * 1024;
/** The text each agent's error record holds: a tail without it has no error, and is read no further. */
const ERROR_MARK: Record<DelegatedKind, string> = { codex: '"type":"error"', claude: '"isApiErrorMessage":true' };

/**
 * The error a session's last turn stopped on, from the end of its file: Codex's `error` event (`event_msg`, a provider's
 * "Selected model is at capacity", say), or Claude Code's API error message (an assistant record with
 * `isApiErrorMessage`), with its text and when it was written. Null when the turn after it began (a prompt sent again:
 * Codex's `task_started`, a person's message to Claude Code) or a reply followed it, and when there is none.
 */
export function turnError(file: string, kind: DelegatedKind): { message: string; ts: number } | null {
  let text: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - ERROR_TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      text = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, start));
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  // From the line of the last error on: what came after it says whether the turn went on.
  const at = text.lastIndexOf(ERROR_MARK[kind]);
  if (at < 0) return null;
  let err: { message: string; ts: number } | null = null;
  for (const line of text.slice(text.lastIndexOf('\n', at) + 1).split('\n')) {
    if (!line.includes(kind === 'codex' ? '"type":"' : '"role":"')) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(o?.timestamp) || 0;
    if (kind === 'codex') {
      const p = o?.type === 'event_msg' ? o.payload : null;
      if (p?.type === 'error') err = { message: String(p.message ?? 'error'), ts };
      else if (p?.type === 'task_started' || p?.type === 'agent_message') err = null;
    } else if (o?.type === 'assistant') {
      const said = Array.isArray(o.message?.content) ? o.message.content.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text)).join(' ') : '';
      err = o.isApiErrorMessage === true ? { message: said.trim() || 'API error', ts } : null;
    } else if (o?.type === 'user' && !o.isMeta && !(Array.isArray(o.message?.content) && o.message.content.some((b: any) => b?.type === 'tool_result'))) err = null;
  }
  return err;
}

/** One session's evidence from this machine's files: its report, raised hand, and turn. */
function fileEvidence(rec: DelegatedAgent): Omit<DelegatedEvidence, 'native' | 'alive'> {
  const e: Omit<DelegatedEvidence, 'native' | 'alive'> = { session: rec.session, report: null, hand: null, turn: null, lastActiveMs: null };
  try {
    const st = fs.statSync(rec.report);
    if (st.isFile()) e.report = { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    /* not written yet */
  }
  if (!rec.session || rec.machine) return e;
  const capture = require('./capture') as typeof import('./capture');
  const hand = capture.readAttention(rec.session);
  if (hand) e.hand = { kind: hand.kind, ts: hand.ts };
  if (rec.kind === 'codex') {
    const { findCodexRollout, codexTurnOpen } = require('./codex') as typeof import('./codex');
    const rollout = findCodexRollout(rec.session);
    if (rollout) {
      const open = codexTurnOpen(rollout);
      e.turn = open === null ? null : open ? 'open' : 'ended';
      e.turnError = turnError(rollout, 'codex');
      try { e.lastActiveMs = fs.statSync(rollout).mtimeMs; } catch { /* gone meanwhile */ }
    }
  } else {
    const { transcriptForSession } = require('./asks') as typeof import('./asks');
    const transcript = transcriptForSession(rec.session);
    if (transcript) {
      const { agentPhaseDetail } = require('./actions') as typeof import('./actions');
      const phase = agentPhaseDetail(transcript, rec.session).phase;
      e.turn = phase === 'working' || phase === 'awaiting-permission' || phase === 'awaiting-input' ? 'open' : 'ended';
      e.turnError = turnError(transcript, 'claude');
      try { e.lastActiveMs = fs.statSync(transcript).mtimeMs; } catch { /* gone meanwhile */ }
    }
  }
  return e;
}

/** What a herdr snapshot says of the agents it holds: each pane that is there, and each pane's reported session. */
export interface PaneEvidence {
  /** Panes herdr has, by id, with the session herdr knows for each. Null when herdr could not be asked. */
  panes: Map<string, { session: string | null }> | null;
}

export function paneEvidence(snapshot: Pick<SessionSnapshot, 'panes'> | null): PaneEvidence {
  if (!snapshot) return { panes: null };
  return { panes: new Map((snapshot.panes ?? []).map((p) => [p.pane_id, { session: p.agent_session?.value ?? null }])) };
}

export interface DelegatedRefreshOptions {
  now?: number;
  /** Records already read by the caller, updated in place as they are when read here. */
  records?: DelegatedAgent[];
  /** herdr's snapshot of each machine (`local` for this one), where it was read; a machine absent was not asked. */
  herdr?: Map<string, PaneEvidence>;
  /** Claude Code's own status; asked only when a live Claude agent needs it. */
  native?: () => Map<string, { status: 'busy' | 'idle'; pid: number | null }>;
}

/**
 * Every record with its state derived now, written back where it changed. A record in a final state (done, gone) is
 * read and not asked again. An agent started from here on a saved machine is derived there: its row here keeps what was
 * last read of it (applyRemoteDelegated).
 */
export function refreshDelegated(opts: DelegatedRefreshOptions = {}): DelegatedAgent[] {
  const now = opts.now ?? Date.now();
  const records = opts.records ?? listDelegatedRecords();
  let native: Map<string, { status: 'busy' | 'idle'; pid: number | null }> | null = null;
  let treeBudget = 1;
  for (const rec of [...records].sort((a, b) => (a.worktree?.state?.readMs ?? 0) - (b.worktree?.state?.readMs ?? 0))) {
    // At most one bounded worktree read per refresh; saved timestamps also throttle new CLI processes.
    if (!rec.machine && rec.worktree && !rec.worktree.removedMs && treeBudget > 0 && now - (rec.worktree.state?.readMs ?? 0) >= 30000) {
      treeBudget--;
      rec.worktree.state = (require('./agent-worktree') as typeof import('./agent-worktree')).readAgentWorktree(rec.worktree, now);
      try { writeDelegated(rec); } catch { /* the next refresh retries */ }
    }
    // An agent on a saved machine is derived there, and read from there (applyRemoteDelegated).
    if (TERMINAL.has(rec.state) || rec.state === 'queued' || rec.machine) continue;
    const panes = opts.herdr?.get('local')?.panes ?? null;
    const pane = panes && rec.pane ? panes.get(rec.pane) : undefined;
    let changed = false;
    if (!rec.session && pane?.session && isSafeSessionId(pane.session)) {
      rec.session = pane.session;
      changed = true;
    }
    const e: DelegatedEvidence = { ...fileEvidence(rec), native: null, alive: null };
    // A closed tab ended its agent with it; a pane herdr no longer has did too.
    if (rec.closedMs !== null || (panes && rec.pane && !pane)) e.alive = false;
    if (!rec.machine && e.alive !== false) {
      if (rec.kind === 'claude' && rec.session) {
        native ??= (opts.native ?? claudeNativeStatus)();
        const n = native.get(rec.session);
        if (n) {
          e.native = n.status;
          if (n.pid && n.pid !== rec.pid) { rec.pid = n.pid; changed = true; }
        }
      }
      if (rec.pid !== null) e.alive = agentAlive(rec.pid, rec.kind);
    }
    const next = deriveDelegatedState(rec, e, now);
    if (next.state !== rec.state || next.since !== rec.since || (next.state === 'errored' && next.error !== rec.error)) {
      if (next.state === 'errored') rec.error = next.error;
      else if (rec.state === 'errored') delete rec.error;
      rec.state = next.state;
      rec.since = next.since;
      if (TERMINAL.has(next.state)) rec.endedMs = next.since;
      changed = true;
    }
    if (changed) {
      try { writeDelegated(rec); } catch { /* shown as derived; written by the next refresh */ }
    }
  }
  return records;
}

/** The settings `oak agent start` takes its defaults from (prefs.json `agents`), each overridden by its flag. */
export function delegatedDefaults(kind: DelegatedKind, cwd = process.cwd()): import('./prefs').AgentStartPrefs {
  const prefs = require('./prefs') as typeof import('./prefs');
  const root = (require('./session') as typeof import('./session')).repoRoot(cwd);
  const local = root ? prefs.readPrefs(path.join(root, '.claude', 'claude-observatory', 'prefs.json')).agents?.[kind] : undefined;
  return { ...prefs.readPrefs().agents?.[kind], ...local };
}

/** The arguments herdr starts each CLI with. */
export function delegatedArgs(kind: DelegatedKind, o: { model?: string | null; effort?: string | null; sandbox?: string | null; permissionMode?: string | null; agentType?: string | null; out?: string; cwd?: string; args?: string[]; writableRoots?: string[] }): string[] {
  const args: string[] = [];
  if (kind === 'claude') {
    if (o.agentType) args.push('--agent', o.agentType);
    if (o.permissionMode) args.push('--permission-mode', o.permissionMode);
    if (o.model) args.push('--model', o.model);
    if (o.effort) args.push('--effort', o.effort);
  } else {
    if (o.model) args.push('-c', `model=${JSON.stringify(o.model)}`);
    if (o.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(o.effort)}`);
    args.push('-c', 'check_for_update_on_startup=false');
    if (o.sandbox) args.push('-s', o.sandbox);
    // The output folder is outside the tree: a sandbox that writes only the workspace must be let write it too.
    const roots = [...new Set([...(o.writableRoots ?? []), ...(o.out ? [o.out] : [])].map(p => path.resolve(o.cwd ?? process.cwd(), p.startsWith('~/') || p.startsWith('~\\') ? path.join(require('os').homedir(), p.slice(2)) : p)))];
    if (roots.length) args.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`);
  }
  return [...args, ...(o.args ?? [])];
}

/** Words on a pane's screen. */
const TRUST = /Is this a project you created or one you trust|trust the (?:files|contents) (?:in|of) this|allow Codex to work in this folder/i;
const READY: Record<DelegatedKind, RegExp> = { claude: /for shortcuts/, codex: /Ask Codex|\? for shortcuts/ };
const WORKING = /esc to interrupt/;

export interface DelegatedStartOptions {
  kind: DelegatedKind;
  brief: string;
  cwd: string;
  name?: string;
  title?: string;
  out?: string;
  report?: string;
  agentType?: string | null;
  model?: string | null;
  effort?: string | null;
  sandbox?: string | null;
  permissionMode?: string | null;
  args?: string[];
  writableRoots?: string[];
  worktree?: string | boolean;
  workspace?: string | null;
  parent?: string | null;
  herdr?: HerdrOptions;
  /** Waits between polls (tests pass a short one). */
  sleep?: (ms: number) => Promise<void>;
  /** Scales every wait (tests pass a small one). */
  patience?: number;
  log?: (line: string) => void;
}

function prepareDelegatedAgent(o: DelegatedStartOptions, machine: string | null = null): DelegatedAgent {
  const brief = machine ? o.brief : path.resolve(o.brief);
  const cwd = machine ? o.cwd : path.resolve(o.cwd);
  const id = delegatedIdFor(o.name || path.basename(brief).replace(/(?:-brief)?\.md$/i, ''));
  // With --worktree the repository is checked now (a dirty or missing one is refused before anything is recorded), and
  // the output folder sits beside its root, as the agent's worktree will.
  const root = !machine && o.worktree ? (require('./agent-worktree') as typeof import('./agent-worktree')).checkAgentRepository(cwd) : cwd;
  const out = o.out ?? path.join(path.dirname(root), `${id}-out`);
  const now = Date.now();
  return {
    id, title: o.title || (machine ? path.basename(brief) : briefTitle(fs.readFileSync(brief, 'utf8'), brief)), brief, cwd,
    out: machine ? out : path.resolve(out), report: o.report ? (machine ? o.report : path.resolve(o.report)) : path.join(machine ? out : path.resolve(out), 'report.md'),
    kind: o.kind, agentType: o.agentType ?? null, model: o.model ?? null, effort: o.effort ?? null,
    sandbox: o.kind === 'codex' ? o.sandbox ?? null : null, machine, workspace: o.workspace ?? null, tab: null, pane: null,
    herdrName: `oak-${id}`, pid: null, session: null, parent: o.parent ?? null, startedMs: now, endedMs: null, closedMs: null,
    state: 'starting', since: now, lastMessageMs: null,
  };
}

/** Refuse unknown dependencies and cycles before creating a row or starting a process. */
export function queueDelegatedAgent(o: NonNullable<DelegatedAgent['launch']>, after: string[], afterAny = false, machine: string | null = null): DelegatedAgent {
  const rec = prepareDelegatedAgent(o, machine);
  if (!after.length) throw new Error('--after needs at least one delegated agent id');
  const visiting = new Set([rec.id]), visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`dependency cycle at ${id}`);
    if (visited.has(id)) return;
    const dep = readDelegated(id);
    if (!dep) throw new Error(`unknown dependency ${id} (oak agent list shows them)`);
    visiting.add(id);
    for (const parent of dep.after ?? []) visit(parent);
    visiting.delete(id); visited.add(id);
  };
  for (const id of after) visit(id);
  rec.state = 'queued'; rec.queuedMs = rec.since; rec.after = [...new Set(after)]; rec.afterAny = afterAny;
  rec.launch = { ...o, brief: rec.brief, cwd: rec.cwd, out: rec.out, report: rec.report, name: rec.id };
  writeDelegated(rec);
  return rec;
}

/** A queued start's decision from refreshed records, including saved machines' records from the database. */
export function delegatedDependencies(rec: DelegatedAgent, records: readonly DelegatedAgent[]): { ready: boolean; error?: string } {
  for (const id of rec.after ?? []) {
    const dep = records.find(r => r.id === id);
    if (!dep) return { ready: false, error: `Dependency ${id} no longer exists` };
    if (dep.state === 'gone' && !rec.afterAny) return { ready: false, error: `Dependency ${id} is gone; ${rec.id} will not start` };
  }
  return { ready: (rec.after ?? []).every(id => records.some(r => r.id === id && (r.state === 'done' || (rec.afterAny && r.state === 'gone')))) };
}

/** Shared by the initial brief and follow-up messages: herdr pastes text, then submits the composer. */
async function sendDelegatedPrompt(target: string, text: string, opts: HerdrOptions, sleep: (ms: number) => Promise<void>): Promise<void> {
  const herdr = require('./herdr') as typeof import('./herdr');
  await herdr.herdrRequest('agent.prompt', { target, text }, opts);
  await sleep(1000);
  await herdr.herdrRequest('agent.send_keys', { target, keys: ['Enter'] }, opts);
}

export function validateDelegatedMessage(text: string): void {
  if (!text.trim()) throw new Error('agent tell: the message is empty');
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text)) throw new Error('agent tell: control characters are not allowed (only tabs and newlines)');
}

/** Check every recipient before touching a composer. A shell, a trust prompt or a question is never a chatbox. */
export async function checkDelegatedTell(ids: readonly string[], opts: HerdrOptions = {}): Promise<DelegatedAgent[]> {
  const records = ids.map(id => {
    const rec = readDelegated(id);
    if (!rec) throw new Error(`no delegated agent "${id}" (oak agent list shows them)`);
    if (isTerminalDelegated(rec.state) || rec.closedMs != null || rec.state === 'queued') throw new Error(`${id} is ${rec.closedMs != null ? 'closed' : rec.state}; cannot tell it`);
    if (rec.machine) throw new Error(`${id} runs on ${rec.machine}`);
    return rec;
  });
  const herdr = require('./herdr') as typeof import('./herdr');
  const snapshot = await herdr.herdrSnapshot(opts);
  refreshDelegated({ records, herdr: new Map([['local', paneEvidence(snapshot)]]) });
  for (const rec of records) {
    if (isTerminalDelegated(rec.state) || rec.closedMs != null || rec.state === 'queued') throw new Error(`${rec.id} is ${rec.closedMs != null ? 'closed' : rec.state}; cannot tell it`);
    if (!rec.pane || !rec.herdrName) throw new Error(`${rec.id} has no running chatbox`);
    const pane = snapshot.panes.find(p => p.pane_id === rec.pane);
    if (!pane) throw new Error(`${rec.id} is gone; its pane no longer exists`);
    const info = await herdr.herdrRequest('pane.process_info', { pane_id: rec.pane }, opts);
    if (agentPid(info.process_info, rec.kind) === null) throw new Error(`${rec.id} is gone; ${rec.kind} no longer runs in its pane`);
    const screen = (await herdr.herdrRequest('pane.read', { pane_id: rec.pane, source: 'visible', format: 'text', strip_ansi: true }, opts)).read.text;
    if (pane.agent_status === 'blocked' || rec.state === 'blocked' || TRUST.test(screen) || !(READY[rec.kind].test(screen) || WORKING.test(screen))) {
      throw new Error(`${rec.id}: ${rec.kind}'s composer is not available; open its herdr tab`);
    }
  }
  return records;
}

/** Record only after submission. A failed acknowledgement names the pane, so an uncertain send is not retried blindly. */
export async function tellDelegatedAgent(id: string, text: string, from: string, opts: HerdrOptions = {}): Promise<DelegatedAgent> {
  validateDelegatedMessage(text);
  const [rec] = await checkDelegatedTell([id], opts);
  try {
    await sendDelegatedPrompt(rec.herdrName!, text, opts, ms => new Promise(r => setTimeout(r, ms)));
  } catch (e) {
    throw new Error(`${id}: delivery was not confirmed; check pane ${rec.pane} before retrying (${String((e as Error).message || e)})`);
  }
  const latest = readDelegated(id) ?? rec;
  const at = Date.now();
  latest.messages = [...(latest.messages ?? []), { id: randomBytes(12).toString('hex'), from, at, text }];
  latest.lastMessageMs = at;
  try { writeDelegated(latest); }
  catch (e) { throw new Error(`${id}: message sent, but its record could not be saved: ${String((e as Error).message || e)}`); }
  return latest;
}

/**
 * Start an agent from a brief in a new herdr tab on this machine, and record it:
 * 1. The tab, labelled `<id>: <title>`, with `DISABLE_AUTO_UPDATE=true` (oh-my-zsh's update prompt ate the first keys)
 *    and `OAK_DELEGATED=<id>` (the hooks' link to its session), opened without focus.
 * 2. Once its shell holds the pane idle, herdr starts the CLI. herdr's start can time out while the agent has in fact
 *    started, so a failure is checked against the pane's own processes before it is believed.
 * 3. Until the CLI's composer shows, a folder-trust prompt (Claude Code's, Codex's) is answered with Enter, which takes
 *    its first choice, to trust the folder the agent was started in.
 * 4. The brief is handed over, and an Enter follows (the prompt sat in the composer until one was sent).
 */
export async function startDelegatedAgent(o: DelegatedStartOptions, queued?: DelegatedAgent): Promise<DelegatedAgent> {
  const herdr = require('./herdr') as typeof import('./herdr');
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const patience = o.patience ?? 1;
  const log = o.log ?? (() => undefined);
  const rec = queued ?? prepareDelegatedAgent(o);
  const { id, title, out } = rec;
  let cwd = rec.cwd;
  fs.mkdirSync(out, { recursive: true });
  const req = <M extends import('./herdr').Method>(method: M, params: import('./herdr').Params<M>, timeoutMs?: number) =>
    herdr.herdrRequest(method, params, { ...o.herdr, ...(timeoutMs ? { timeoutMs } : {}) });
  const cancelled = (): boolean => !!queued && readDelegated(id)?.closedMs != null;
  await herdr.herdrSnapshot(o.herdr); // the protocol gate, before anything changes
  if (cancelled()) throw new Error(`${id}: queued start cancelled`);
  // The worktree is made at launch, so a queued agent starts from its base as it is when it starts.
  const trees = require('./agent-worktree') as typeof import('./agent-worktree');
  const worktree = o.worktree ? trees.createAgentWorktree(cwd, id, typeof o.worktree === 'string' ? o.worktree : 'HEAD') : trees.detectAgentWorktree(cwd);
  if (worktree) { rec.worktree = worktree; cwd = rec.cwd = worktree.path; }
  const created = await req('tab.create', {
    cwd, label: `${id}: ${title}`, focus: false, env: { DISABLE_AUTO_UPDATE: 'true', OAK_DELEGATED: id },
    ...(o.workspace ? { workspace_id: o.workspace } : {}),
  });
  const pane = created.root_pane.pane_id;
  if (cancelled()) {
    await req('tab.close', { tab_id: created.tab.tab_id });
    if (o.worktree && rec.worktree) { try { trees.removeAgentWorktree(rec.worktree); } catch { /* it keeps changes: left for review */ } }
    throw new Error(`${id}: queued start cancelled`);
  }
  Object.assign(rec, { workspace: created.tab.workspace_id ?? null, tab: created.tab.tab_id ?? null, pane,
    startedMs: Date.now(), since: Date.now(), state: 'starting' });
  delete rec.launch;
  writeDelegated(rec);
  const info = async () => (await req('pane.process_info', { pane_id: pane }).catch(() => null))?.process_info ?? null;
  const screen = async () => (await req('pane.read', { pane_id: pane, source: 'visible', format: 'text', strip_ansi: true }).catch(() => null))?.read.text ?? '';
  const giveUp = (why: string): never => {
    Object.assign(rec, { state: 'gone', since: Date.now(), endedMs: Date.now(), error: why });
    writeDelegated(rec);
    throw new Error(`${why}. The tab stays open in herdr (pane ${pane}).`);
  };
  const { paneForeground } = require('./herdr-tabs') as typeof import('./herdr-tabs');
  // 1. The shell, at its prompt.
  for (let i = 0; i < 60 * patience && paneForeground(await info()) !== 'idle'; i++) await sleep(500);
  // 2. The CLI.
  const args = delegatedArgs(o.kind, { ...o, out, cwd });
  try {
    await req('agent.start', { kind: o.kind, name: rec.herdrName!, pane_id: pane, args, timeout_ms: 90000 }, 95000);
  } catch (error) {
    let pid: number | null = null;
    for (let i = 0; i < 10 * patience && pid === null; i++) { pid = agentPid(await info(), o.kind); if (pid === null) await sleep(1000); }
    if (pid === null) giveUp(`${o.kind} did not start: ${String((error as Error).message || error)}`);
    log(`herdr's start said "${String((error as Error).message || error)}", but ${o.kind} runs in the pane`);
  }
  rec.pid = agentPid(await info(), o.kind);
  // 3. The composer, past a folder-trust prompt.
  let ready = false;
  for (let i = 0; i < 240 * patience && !ready; i++) {
    const s = await screen();
    if (TRUST.test(s)) {
      log('answered the folder-trust prompt');
      await req('pane.send_keys', { pane_id: pane, keys: ['Enter'] });
    } else if (READY[o.kind].test(s)) ready = true;
    if (!ready) await sleep(500);
  }
  if (!ready) giveUp(`${o.kind}'s composer never appeared`);
  if (cancelled()) throw new Error(`${id}: queued start cancelled`);
  // 4. The brief.
  await sendDelegatedPrompt(rec.herdrName!, delegatedPrompt(rec), o.herdr ?? {}, sleep);
  let working = false;
  for (let i = 0; i < 60 * patience && !working; i++) { working = WORKING.test(await screen()); if (!working) await sleep(1000); }
  if (!working) log(`${o.kind} has not shown a turn at work yet; \`oak agent list\` follows it`);
  rec.pid = agentPid(await info(), o.kind) ?? rec.pid;
  if (cancelled()) return readDelegated(id)!;
  writeDelegated(rec);
  return rec;
}

/** Close an agent's herdr tab and keep its row, marked closed (its state then follows: done with its report, else gone). */
export async function closeDelegatedAgent(id: string, opts: HerdrOptions & { removeWorktree?: boolean } = {}): Promise<DelegatedAgent> {
  let rec = readDelegated(id);
  if (!rec && opts.removeWorktree) {
    const worktree = (require('./agent-worktree') as typeof import('./agent-worktree')).closeOrphanAgentWorktree(id);
    const now = Date.now();
    rec = { id, title: id, brief: '', cwd: worktree.path, out: '', report: '', kind: 'claude', agentType: null, model: null, effort: null, sandbox: null,
      machine: null, workspace: null, tab: null, pane: null, herdrName: null, pid: null, session: null, parent: null, startedMs: now,
      endedMs: now, closedMs: now, state: 'gone', since: now, worktree };
  }
  if (!rec) throw new Error(`no delegated agent "${id}" (oak agent list shows them)`);
  if (rec.state === 'queued' && rec.launch) {
    Object.assign(rec, { closedMs: Date.now(), endedMs: Date.now(), since: Date.now(), state: 'gone', error: 'Queued start cancelled' });
    delete rec.launch;
    writeDelegated(rec);
    return rec;
  }
  if (rec.machine) throw new Error(`${id} runs on ${rec.machine}: its tab is closed there (oak agent close does that)`);
  if (rec.tab) {
    const herdr = require('./herdr') as typeof import('./herdr');
    try {
      await herdr.herdrRequest('tab.close', { tab_id: rec.tab }, opts);
    } catch (error) {
      // A tab herdr no longer has is closed already.
      if (!/not.?found|no such|unknown tab/i.test(String((error as Error).message || error))) throw error;
    }
  }
  if (opts.removeWorktree) {
    if (!rec.worktree) throw new Error(`${id} has no recorded worktree`);
    (require('./agent-worktree') as typeof import('./agent-worktree')).removeAgentWorktree(rec.worktree);
  }
  rec.closedMs = Date.now();
  writeDelegated(rec);
  return refreshDelegated().find((r) => r.id === id) ?? rec;
}

/** One of a delegated agent's in-process workers (a Claude Code subagent of its session) still at it. */
export interface DelegatedWorker {
  id: string;
  /** The delegated agent whose session spawned it. */
  parent: string;
  session: string;
  title: string;
  state: 'working' | 'blocked';
  model: string | null;
  tokens: number;
  lastActiveMs: number;
}

/** A delegated agent as the list shows it: its record, its session's tokens and list-price cost (null where the index
 *  cannot say), and its workers still at it. */
export interface DelegatedRow extends DelegatedAgent {
  tokens: number | null;
  cost: number | null;
  workers: DelegatedWorker[];
}

/** Each session's tokens (input + output + cache creation) and list-price cost, from the local index, read without a
 *  catch-up. Empty where there is no index. */
export function delegatedUsage(sessions: readonly string[]): Map<string, { tokens: number; cost: number; model: string; effort: string }> {
  const out = new Map<string, { tokens: number; cost: number; model: string; effort: string }>();
  if (!sessions.length) return out;
  const api = require('./index/api') as typeof import('./index/api');
  const ix = api.openIndexReadOnly();
  if (!ix.ok) return out;
  try {
    const usage = ix.db.prepare('SELECT sum(input + output + cache_create) AS tokens, sum(cost) AS cost FROM usage_messages WHERE machine_id IN (SELECT machine_id FROM machines) AND session_id = ?');
    const meta = ix.db.prepare("SELECT model, effort FROM sessions WHERE session_id = ? ORDER BY last_active_ms DESC LIMIT 1");
    for (const s of sessions) {
      const u = usage.get(s) as { tokens: number | null; cost: number | null } | undefined;
      const m = meta.get(s) as { model: string; effort: string } | undefined;
      out.set(s, { tokens: u?.tokens ?? 0, cost: u?.cost ?? 0, model: m?.model ?? '', effort: m?.effort ?? '' });
    }
  } catch {
    /* an index without these columns answers nothing */
  } finally {
    ix.close();
  }
  return out;
}

/** The workers of a Claude agent's session still at it (subagents.ts activeWorkers). */
function workersOf(rec: DelegatedAgent, now: number): DelegatedWorker[] {
  if (rec.kind !== 'claude' || !rec.session || rec.machine) return [];
  const transcript = (require('./asks') as typeof import('./asks')).transcriptForSession(rec.session);
  if (!transcript) return [];
  return (require('./subagents') as typeof import('./subagents')).activeWorkers(transcript, rec.session, now).map((w) => ({
    id: w.agentId, parent: rec.id, session: rec.session!, title: w.title, state: w.phase === 'working' ? 'working' as const : 'blocked' as const,
    model: w.model || null, tokens: w.tokens, lastActiveMs: w.lastActiveMs,
  }));
}

/** The agents started from here on saved machines, read from this machine's index where oak sync keeps that machine
 *  current (index/api.ts indexedMachineDelegated): the machines read so, by label. The rest are read over ssh by the
 *  CLI (`oak agent list`, `wait`), or keep what was last read of them. */
export function refreshRemoteFromIndex(records: readonly DelegatedAgent[], now = Date.now()): Set<string> {
  const done = new Set<string>();
  const byMachine = new Map<string, DelegatedAgent[]>();
  for (const r of records) if (r.machine && !r.launch && !isTerminalDelegated(r.state)) {
    const group = byMachine.get(r.machine);
    if (group) group.push(r);
    else byMachine.set(r.machine, [r]);
  }
  if (!byMachine.size) return done;
  const api = require('./index/api') as typeof import('./index/api');
  for (const [label, recs] of byMachine) {
    const indexed = api.indexedMachineDelegated(label, now);
    if (!indexed) continue;
    done.add(label);
    const byId = new Map<string, DelegatedAgent>();
    for (const agent of indexed.agents) {
      const id = agent.id;
      if (!byId.has(id)) byId.set(id, agent);
    }
    for (const rec of recs) {
      const there = byId.get(rec.remoteId ?? rec.id);
      if (there) applyRemoteDelegated(rec, there, 'index', now);
    }
  }
  return done;
}

/** The list every surface shows: the records refreshed (refreshDelegated, and refreshRemoteFromIndex), those whose tab
 *  was closed left out unless `all`, each with its usage and its workers. A caller that already refreshed its records
 *  remotely passes `refreshRemote: false`. */
export function listDelegated(opts: DelegatedRefreshOptions & { all?: boolean; refreshRemote?: boolean } = {}): DelegatedRow[] {
  const now = opts.now ?? Date.now();
  const recs = refreshDelegated({ ...opts, now }).filter((r) => opts.all || r.closedMs === null);
  if (opts.refreshRemote !== false) refreshRemoteFromIndex(recs, now);
  const usage = delegatedUsage(recs.map((r) => r.session).filter((s): s is string => !!s));
  return recs.map((r) => {
    const u = r.session ? usage.get(r.session) : undefined;
    // An agent on a saved machine: its usage as this index holds it (oak sync brought that machine's), else as read there.
    const tokens = u?.tokens || r.remote?.tokens || (u ? u.tokens : null);
    const cost = u?.cost || r.remote?.cost || (u ? u.cost : null);
    return {
      ...r, lastMessageMs: r.lastMessageMs ?? null, model: r.model ?? (u?.model || null), effort: r.effort ?? (u?.effort || null), tokens: tokens ?? null, cost: cost ?? null,
      workers: isTerminalDelegated(r.state) ? [] : r.machine ? r.remote?.workers ?? [] : workersOf(r, now),
    };
  });
}

/** herdr's snapshot of each machine that has a live delegated agent (this one over its socket, a saved machine through
 *  herdr's forwarding), as refreshDelegated reads it. A machine that could not be asked is left out: its agents keep
 *  the evidence of their files and processes. */
export async function delegatedPanes(records: readonly DelegatedAgent[], opts: HerdrOptions = {}): Promise<Map<string, PaneEvidence>> {
  const herdr = require('./herdr') as typeof import('./herdr');
  const out = new Map<string, PaneEvidence>();
  if (!records.some((r) => !isTerminalDelegated(r.state) && r.pane && !r.machine)) return out;
  try {
    out.set('local', paneEvidence(await herdr.herdrSnapshot(opts)));
  } catch {
    /* herdr is not running here: the agents' processes and files still say */
  }
  return out;
}

/** A row of the index's `delegated` table (another machine's, as oak sync brought it) as a record. */
export function delegatedFromRow(row: Record<string, unknown>): DelegatedAgent {
  const str = (k: string): string | null => (typeof row[k] === 'string' ? (row[k] as string) : null);
  const num = (k: string): number | null => (typeof row[k] === 'number' ? (row[k] as number) : null);
  return {
    ...(str('worktree_json') ? { worktree: (require('./agent-worktree') as typeof import('./agent-worktree')).parseAgentWorktree(str('worktree_json')!) } : {}),
    id: str('id') ?? '', title: str('title') ?? '', brief: str('brief') ?? '', cwd: str('cwd') ?? '', out: str('out') ?? '', report: str('report') ?? '',
    kind: (str('kind') ?? 'claude') as DelegatedKind, agentType: str('agent_type'), model: str('model'), effort: str('effort'), sandbox: str('sandbox'),
    machine: str('machine'), workspace: str('workspace'), tab: str('tab'), pane: str('pane'), herdrName: null, pid: null, session: str('session_id'),
    parent: str('parent'), startedMs: num('started_ms') ?? 0, endedMs: num('ended_ms'), closedMs: num('closed_ms'),
    state: (str('state') ?? 'starting') as DelegatedState, since: num('since_ms') ?? 0, ...(str('error') ? { error: str('error')! } : {}),
  };
}

/** Take what a saved machine says of an agent started there from here (its own row, from its `oak agent list --json` or
 *  from this machine's index) into the row here, and write it. Closed is this machine's to say as well. */
export function applyRemoteDelegated(rec: DelegatedAgent, there: Partial<DelegatedRow> & DelegatedAgent, via: 'index' | 'ssh', now = Date.now()): DelegatedAgent {
  for (const k of ['state', 'since', 'endedMs', 'session', 'model', 'effort', 'workspace', 'tab', 'pane', 'title', 'lastMessageMs', 'messages'] as const) {
    if (there[k] !== undefined && there[k] !== null) (rec as unknown as Record<string, unknown>)[k] = there[k];
  }
  if (there.closedMs !== null && there.closedMs !== undefined) rec.closedMs ??= there.closedMs;
  if (there.worktree) rec.worktree = there.worktree;
  if (there.error) rec.error = there.error;
  else delete rec.error;
  rec.remote = { via, readMs: now, tokens: there.tokens ?? null, cost: there.cost ?? null, workers: (there.workers ?? []).map((w) => ({ ...w, parent: rec.id })) };
  writeDelegated(rec);
  return rec;
}

/** What a wait watches so a change shows at once (watch.ts createWatcher, which polls where it cannot watch): the
 *  records' folder (a session linked, a row written), and for each of this machine's live agents its report's folder,
 *  its transcript's or rollout's folder, and its session's store (a raised hand). */
export function delegatedWatchRoots(records: readonly DelegatedAgent[]): import('./watch').WatchRoot[] {
  const roots = new Map<string, import('./watch').WatchRoot>();
  const add = (dir: string, kind: 'store' | 'activity', relevant: (name: string | null) => boolean): void => {
    const key = `${kind}:${path.resolve(dir)}`;
    const had = roots.get(key);
    // Two agents in one folder: either's file is worth a look.
    roots.set(key, { dir, kind, relevant: had ? (n) => had.relevant(n, dir) || relevant(n) : (n) => relevant(n), fanout: (d) => [d] });
  };
  const named = (file: string) => (n: string | null): boolean => n === null || path.basename(n) === path.basename(file);
  add(delegatedDir(), 'store', () => true);
  for (const r of records) {
    if (r.machine || isTerminalDelegated(r.state)) continue;
    add(path.dirname(r.report), 'store', named(r.report));
    if (!r.session) continue;
    add((require('./store') as typeof import('./store')).storeDir(r.session), 'store', (n) => n === null || /attention/.test(n));
    const file = r.kind === 'codex' ? (require('./codex') as typeof import('./codex')).findCodexRollout(r.session) : (require('./asks') as typeof import('./asks')).transcriptForSession(r.session);
    if (file) add(path.dirname(file), 'activity', named(file));
  }
  return [...roots.values()];
}
