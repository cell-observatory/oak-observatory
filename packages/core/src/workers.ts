/** Workers on one machine. herdr supplies identity; OAK derives state from the process and conversation. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeConfigDir } from './paths';
import { commonDir } from './session';
import { sessionMeta, discoverListing, listingTranscripts, realSessionTitle } from './observe';
import { codexSessionSources, codexTurnOpen } from './codex';
import { agentPhaseDetail } from './actions';
import { subagentDigests, findSubagentsDir } from './subagents';
import { agentAlive, agentPid, claudeNativeStatus, deriveDelegatedState, listDelegated, paneEvidence, turnError, type DelegatedKind, type DelegatedState } from './delegated';
import { herdrSnapshot, herdrRequest } from './herdr';
import { herdrTabTitle } from './herdr-tabs';
import type { SessionSnapshot, PaneInfo, AgentInfo } from './herdr-api';
import { spawnToolSync } from './spawn';
import { FLEET_FOLD_MS } from './fleet';

export type WorkerSubagent = Omit<ReturnType<typeof subagentDigests>[number], 'phase'> & { phase: string; state: DelegatedState; lastActiveMs: number; kind: DelegatedKind; machine: string };

export interface WorkerRow {
  key: string;
  session: string;
  title: string;
  machine: string;
  remote?: string;
  kind: DelegatedKind;
  state: DelegatedState;
  since: number;
  worktree: string;
  self: boolean;
  active: boolean;
  phase: string;
  phaseConfidence: string;
  lastActiveMs: number;
  tokens: number;
  durationMs: number;
  diff: { added: number; removed: number };
  subagents: WorkerSubagent[];
  pane?: string;
  error?: string;
  after?: string[];
}

export const activeWorkerState = (state: string): boolean => ['queued', 'working', 'waiting', 'blocked'].includes(state);
export const workerStatePhase = (state: DelegatedState): string => ({ queued: 'idle', starting: 'idle', working: 'working', waiting: 'idle', blocked: 'awaiting-input', errored: 'errored', done: 'done', gone: 'gone' })[state];

/** Machine-qualified keys and the reviewed machine first; a cached answer never borrows another machine's self flag. */
export function workersByMachine(local: readonly WorkerRow[], machines: readonly { label: string; workers?: readonly WorkerRow[] | null }[], reviewingMachine?: string | null, session?: string | null): WorkerRow[] {
  const groups = [{ label: '', workers: local }, ...machines];
  if (reviewingMachine) groups.sort((a, b) => Number(b.label === reviewingMachine) - Number(a.label === reviewingMachine));
  return groups.flatMap(m => (m.workers ?? []).map(w => ({ ...w, machine: m.label || w.machine,
    subagents: w.subagents.map(s => ({ ...s, machine: m.label || s.machine })),
    key: `${m.label || w.machine}:${w.session || w.pane || w.key}`, remote: m.label, self: m.label === (reviewingMachine || '') && w.session === session })));
}

/** One process inventory per read, not one ps per historical session. Claude's registry also identifies launches
 * without a session id in argv. On Linux an unregistered Codex launch can be matched by its working directory. */
function processEvidence(newest: Map<string, string>): (session: string, kind: DelegatedKind, cwd: string) => boolean | null {
  const known = new Map<string, boolean>();
  const dir = path.join(claudeConfigDir(), 'sessions');
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^\d+\.json$/.test(name)) continue;
      try { const r = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (typeof r.sessionId === 'string' && typeof r.pid === 'number') known.set(r.sessionId, agentAlive(r.pid, 'claude'));
      } catch { /* registry changed */ }
    }
  } catch { /* no registry */ }
  const ps = spawnToolSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 3000 });
  const processes: { command: string; cwd: string; kind: DelegatedKind }[] = [];
  if (!ps.error && ps.status === 0) for (const line of String(ps.stdout).split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || Number(m[1]) === process.pid || /observatory|capture\.(js|ts)|-acp\b/.test(m[2])) continue;
    const words = m[2].trim().split(/\s+/);
    const bin = path.basename(words[0]);
    const executable = bin === 'node' ? path.basename(words[1] || '') : bin;
    const kind = /^(claude|codex)(?:\.js)?$/.exec(executable)?.[1] as DelegatedKind | undefined;
    if (!kind) continue;
    let cwd = '';
    try { cwd = fs.readlinkSync(`/proc/${m[1]}/cwd`); } catch {
      if (process.platform === 'darwin') {
        const r = spawnToolSync('lsof', ['-a', '-p', m[1], '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 1000 });
        cwd = String(r.stdout || '').split('\n').find(line => line.startsWith('n'))?.slice(1) || '';
      }
    }
    processes.push({ command: m[2], cwd, kind });
  }
  return (session, kind, cwd) => known.get(session) ?? (ps.error || ps.status !== 0 ? null
    : processes.some(p => p.kind === kind && (p.command.includes(session) || (!!cwd && p.cwd === cwd && newest.get(`${kind}:${cwd}`) === session))) ? true
      : processes.some(p => p.kind === kind && !p.cwd) ? null : false);
}

export interface WorkerReadOptions {
  snapshot?: SessionSnapshot | null;
  allRecent?: boolean;
  native?: ReturnType<typeof claudeNativeStatus>;
  alive?: (session: string, kind: DelegatedKind, cwd: string) => boolean | null;
}

/** Called in a background CLI, locally or on the saved machine. No SSH and no changes to herdr. */
export async function readWorkerFleet(cwd: string, reviewing: string | null, opts: WorkerReadOptions = {}) {
  let snapshot = opts.snapshot;
  let workerError: string | undefined;
  if (snapshot === undefined) {
    try { snapshot = await herdrSnapshot({ timeoutMs: 4000 }); }
    catch (e) { snapshot = null; workerError = String((e as Error).message); }
  }
  const meta = sessionMeta(cwd, reviewing);
  const found = discoverListing(listingTranscripts(), codexSessionSources()).byId;
  const byId = new Map(meta.sessions.map(r => [r.id, r]));
  const now = Date.now(), repo = commonDir(cwd);
  const machine = process.env.OAK_MACHINE_LABEL?.trim() || os.hostname();
  const newest = new Map<string, string>();
  for (const row of [...meta.sessions].sort((a, b) => b.lastActiveMs - a.lastActiveMs)) {
    const key = `${row.agent.startsWith('codex') ? 'codex' : 'claude'}:${found.get(row.id)?.cwd}`;
    if (!newest.has(key)) newest.set(key, row.id);
  }
  const alive = opts.alive ?? processEvidence(newest);
  const native = opts.native ?? (meta.sessions.some(r => r.agent === 'claude') ? claudeNativeStatus() : new Map());
  const delegated = listDelegated({ all: true, refreshRemote: false, native: () => native, herdr: new Map([['local', paneEvidence(snapshot)]]) }).filter(d => !d.machine || d.launch);
  const records = new Map(delegated.filter(d => d.session).map(d => [d.session!, d]));
  const panes = new Map<string, PaneInfo | AgentInfo>();
  for (const p of [...(snapshot?.panes ?? []), ...(snapshot?.agents ?? [])]) {
    if (!['claude', 'codex'].includes(p.agent || p.agent_session?.agent || '')) continue;
    const id = p.agent_session?.value || `pane:${p.pane_id}`;
    const old = panes.get(id);
    if (!old || p.agent || !old.agent) panes.set(id, p);
  }
  const ids = new Set<string>([...panes.keys(), ...records.keys()]);
  for (const r of meta.sessions) {
    const launch = found.get(r.id)?.cwd;
    if (r.id === reviewing || (now - r.lastActiveMs <= FLEET_FOLD_MS && (opts.allRecent || (launch && (repo ? commonDir(launch) === repo : launch === cwd))))) ids.add(r.id);
  }
  const workers: WorkerRow[] = await Promise.all([...ids].map(async id => {
    const row = byId.get(id), source = found.get(id), pane = panes.get(id), rec = records.get(id);
    const session = id.startsWith('pane:') ? '' : id;
    const kind: DelegatedKind = (pane?.agent || pane?.agent_session?.agent || rec?.kind || row?.agent || '').startsWith('codex') ? 'codex' : 'claude';
    const worktree = source?.cwd || pane?.foreground_cwd || pane?.cwd || rec?.cwd || cwd;
    const lastActiveMs = row?.lastActiveMs || rec?.since || 0;
    const file = source?.source || source?.file;
    const pd = kind === 'claude' && file ? agentPhaseDetail(file, id) : null;
    const open = kind === 'codex' && file ? codexTurnOpen(file) : null;
    let lives = session ? alive(session, kind, worktree) : null;
    if (pane && !opts.alive) {
      try {
        const info = await herdrRequest('pane.process_info', { pane_id: pane.pane_id }, { timeoutMs: 1500 });
        lives = agentPid(info.process_info, kind) !== null || (info.process_info.foreground_processes ?? []).some(p => [p.name, p.argv0, ...(p.argv ?? [])].some(w => w && [kind, `${kind}.js`].includes(path.basename(w))));
      } catch { /* Keep the process inventory's evidence when the pane cannot answer. */ }
    }
    const status = native.get(id);
    if (status?.pid != null) lives = agentAlive(status.pid, kind);
    else if (status && lives !== false) lives = true;
    const turn = open !== null ? (open ? 'open' : 'ended') : pd ? (['working', 'awaiting-input', 'awaiting-permission'].includes(pd.phase) ? 'open' : 'ended') : null;
    const result = rec ? { state: rec.state, since: rec.since, error: rec.error } : deriveDelegatedState({ state: 'starting', startedMs: 0, since: 0 }, {
      session, report: null, alive: lives, native: native.get(id)?.status ?? null,
      hand: row?.attention ?? null, turn, lastActiveMs, turnError: file ? turnError(file, kind) : null,
    }, now);
    // An unfinished transcript alone cannot vouch for a process. Cleanly ended conversations stay ended.
    if (result.state === 'working' && lives !== true) result.state = 'gone';
    if (lives === false && !['done', 'gone'].includes(result.state)) result.state = 'gone';
    if (!rec && result.state === 'gone' && turn === 'ended') result.state = 'done';
    const title = herdrTabTitle(snapshot, pane?.tab_id) || realSessionTitle(row?.title) || rec?.title || path.basename(worktree) || id;
    const subdir = session ? findSubagentsDir(worktree, session) : null;
    const subs: WorkerSubagent[] = session ? subagentDigests(worktree, session).map(s => {
      const state: DelegatedState = s.phase === 'done' ? 'done' : result.state === 'gone' ? 'gone'
        : s.phase === 'awaiting-permission' || s.phase === 'awaiting-input' ? 'blocked'
          : s.phase === 'errored' ? 'errored' : s.phase === 'working' ? 'working' : 'waiting';
      let lastActiveMs = s.ts ?? 0;
      try { if (subdir) lastActiveMs = fs.statSync(path.join(subdir, `agent-${s.agentId}.jsonl`)).mtimeMs; } catch { /* disappeared */ }
      return { ...s, phase: workerStatePhase(state), state, kind, machine, lastActiveMs, running: activeWorkerState(state) };
    }) : [];
    return { key: `${machine}:${id}`, session, title, machine, kind, state: result.state, since: result.since,
      worktree, self: session === reviewing, active: activeWorkerState(result.state), phase: workerStatePhase(result.state), phaseConfidence: 'high',
      lastActiveMs, tokens: row?.tokens ?? rec?.tokens ?? 0, durationMs: row?.durationMs ?? 0,
      diff: { added: row?.added ?? 0, removed: row?.removed ?? 0 }, subagents: subs,
      ...(pane ? { pane: pane.pane_id } : {}), ...(result.error ? { error: result.error } : {}) } satisfies WorkerRow;
  }));
  // Agents OAK started before their first session hook still have a named row.
  for (const d of delegated) if (!d.session && (!d.pane || !workers.some(w => w.pane === d.pane))) workers.push({
    key: `${machine}:delegated:${d.id}`, session: '', title: d.title, machine, kind: d.kind, state: d.state, since: d.since,
    worktree: d.cwd, self: false, active: activeWorkerState(d.state), phase: workerStatePhase(d.state), phaseConfidence: 'high',
    after: d.after, error: d.error, lastActiveMs: d.since, tokens: d.tokens ?? 0, durationMs: 0, diff: { added: 0, removed: 0 }, subagents: [], ...(d.pane ? { pane: d.pane } : {}),
  });
  return { ...meta, machine, workers, ...(workerError ? { workerError } : {}) };
}
