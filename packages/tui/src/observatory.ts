/** Snapshot identity and pinned conversations. No transport or filesystem work in this model. */
import { backupFolderPath, herdrTabTitle, isSafeSessionId, paneAgentState, plainLabel, realSessionTitle, relTime, type ConversationEvent, type HerdrApi, type SyncStatusResult } from '@oak-observatory/core';
import type { DashState } from './frame';

/** One machine's line of oak sync's last run, as `oak sync status --json` gives it: `text` is what the CLI prints
 *  after the machine's label (an older CLI leaves it out). */
export type SyncLine = NonNullable<SyncStatusResult['last']>['machines'][number] & { text?: string };
/** `oak sync status --json`. */
export type SyncView = Omit<SyncStatusResult, 'last'> & { last: (Omit<NonNullable<SyncStatusResult['last']>, 'machines'> & { machines: SyncLine[] }) | null };

/** oak sync is in use here: a run set it up, a backup is chosen, or a conflict is open. Its rows show only then, so
 *  a machine that never chose to sync sees nothing of it. */
export function syncInUse(v: SyncView | undefined): v is SyncView {
  return !!v && (v.setUp || !!v.backup || v.conflicts.length > 0);
}

/** The backup folder's own line of the last run (`backup (<path>)`), while that folder is the backup: the line a run
 *  left for a folder no longer chosen says nothing of the backup now, nor which record to take over. */
export function syncBackupLine(v: SyncView): SyncLine | undefined {
  const b = v.backup;
  return b?.kind === 'folder' ? v.last?.machines.find((m) => m.label === `backup (${backupFolderPath(b.path)})`) : undefined;
}

/** What the last run did with one saved machine, by its label as the run names it, in the CLI's words, and whether that
 *  was a failure (a machine left out on purpose is none); null when sync is not in use. */
export function syncMachineText(v: SyncView | undefined, label: string, now: number): { text: string; failed: boolean } | null {
  if (!syncInUse(v)) return null;
  const line = v.last?.machines.find((m) => plainLabel(m.label) === plainLabel(label));
  if (!line || !v.last) return { text: v.last ? `not asked in the last run (${relTime(v.last.at, now)})` : 'not asked yet', failed: false };
  const text = line.text ?? line.detail ?? line.status;
  if (line.status === 'ok' && !line.errors.length) return { text: `pulled ${text} at ${relTime(v.last.at, now)}`, failed: false };
  return { text, failed: line.errors.length > 0 || !['ok', 'disabled', 'excluded', 'duplicate', 'shared'].includes(line.status) };
}

/** This machine's sync, in two lines: the last run (or the one running now) with the conflicts and warnings it left, and
 *  the backup with its state: a folder's key, and the folder's own line when the run could not use it. */
export function syncLocalText(v: SyncView, now: number): { run: string; backup: string } {
  const n = (k: number, one: string): string => `${k} ${one}${k === 1 ? '' : 's'}`;
  const run = [v.running ? 'running now' : v.last ? `last run ${relTime(v.last.at, now)} (${v.last.status})` : 'no run yet',
    ...(v.last?.error ? [`it stopped: ${v.last.error}`] : []),
    ...(v.conflicts.length ? [`${n(v.conflicts.length, 'conflict')} in the inbox`] : []),
    ...(v.last?.warnings.length ? [`${n(v.last.warnings.length, 'warning')} in the options`] : [])].join(' · ');
  const b = v.backup;
  const failed = syncBackupLine(v);
  const backup = !b ? 'none: each session stays on the machine that made it'
    : b.kind === 'machine' ? b.label
      : [b.path, v.key.present ? `key ${v.key.fingerprint}` : `no key here${v.key.error ? `: ${v.key.error}` : ''}`,
        ...(failed && failed.status !== 'ok' ? [failed.text ?? failed.detail ?? failed.status] : [])].join(' · ');
  return { run, backup };
}

/** How an open conflict is resolved, as `oak inbox` says it: a diverged session only by deleting the copy. */
export const syncConflictResolution = (reason: string): string => (reason === 'diverged' ? 'delete the copy to keep yours' : 'edit your file or delete the copy');

export interface ObservatoryMachine {
  id: string;
  label: string;
  local?: boolean;
  snapshot?: HerdrApi.SessionSnapshot;
  error?: string;
  /** Catalog read on this machine; never joined to a same-id row in the local catalog. `fromIndex`: read from this
   *  machine's local index (that machine's records, as oak sync brought them at `syncedAt`), not from that machine. */
  sessions?: { sessions: Record<string, any>[]; workers?: Record<string, any>[]; fromIndex?: boolean; syncedAt?: number };
  sessionsError?: string;
}
export interface ObservatorySelection {
  session: string;
  root: string;
  label: string;
  machineId?: string;
  paneId?: string;
  /** One of the session's workers, when the reader picked its row in the master: the master marks it, and its
   *  own log is what a pin opens. */
  agentId?: string;
  processId?: string;
  /** A row of the session's worker group the reader picked in the master: its summary (`all`), or the header of
   *  its workers in one state (`blocked`, `working`). */
  workers?: string;
}
export interface ObservatoryConversation {
  selection: ObservatorySelection;
  events: ConversationEvent[];
  feed?: import('@oak-observatory/core').FeedResult;
  processes?: ReturnType<typeof import('@oak-observatory/core').processView>;
  processError?: string;
  cursor: number | null;
  source?: string;
  transcriptPath?: string | null;
  agent?: string;
  loadedAt: number;
  loading?: boolean;
  error?: string;
  previews: Record<number, string>;
  /** Session-local worker/task facts survive browsing and cross-workspace view refreshes. */
  fleet?: Record<string, any>;
  reply?: { text: string; caret: number; focused: boolean; sending?: boolean; error?: string; commentIds?: string[] };
  /** Prompts stay visible until the transcript contains their next matching occurrence. */
  optimistic?: { event: ConversationEvent; previousMatches: number }[];
}
export interface ObservatoryState {
  machines: ObservatoryMachine[];
  machineError?: string;
  /** Last known owner survives an unavailable snapshot; a local pane removes the remote entry. */
  owners?: Record<string, string>;
  /** Each BSP leaf pins independently. The master cursor never overwrites these objects. */
  details: Record<string, ObservatoryConversation>;
  /** Unsent replies parked by `machineId:session` while their leaf shows another conversation. */
  drafts?: Record<string, NonNullable<ObservatoryConversation['reply']>>;
}
export interface ObservatorySession extends ObservatorySelection {
  machine: string;
  agent: string;
  pane?: HerdrApi.PaneInfo;
  meta: Record<string, any>;
  fleet: Record<string, any>;
}

/** Re-resolve the pin against the current snapshot: a saved pane id can have closed or moved. */
export function observatoryReply(state: DashState, paneId: string) {
  const detail = state.observatory?.details[paneId];
  const selection = detail?.selection;
  const session = selection && observatorySessions(state).find(s => s.session === selection.session
    && (!selection.machineId || s.machineId === selection.machineId));
  const machine = state.observatory?.machines.find(m => m.id === session?.machineId);
  // A Codex agent working with a question waiting is still herdr's blocked pane, which refuses a prompt: the reply
  // waits for the answer too, and says why in the words its row uses.
  const reason = !detail ? 'Pin a session to reply' : selection?.processId ? 'Process output is read-only' : selection?.agentId ? 'Worker log is read-only' : !session?.pane || !machine ? 'No live pane'
    : paneAgentState(session.pane, session.meta, state.now).question ? 'Question waiting · answer in herdr'
    : session.pane.agent_status === 'blocked' ? 'Blocked · answer in herdr'
    : detail.reply?.sending ? 'Sending…' : undefined;
  const target = machine?.snapshot?.agents.find(a => a.pane_id === session?.paneId)?.name || session?.paneId;
  return { detail, session, machine, target, reason };
}

/** Whether a session's row lists a worker still at it (core's `activeWorkers`: working, or waiting on a person). The
 *  Observatory keeps such a session as it keeps one with pending edits, and draws its worker group under it. */
export function hasActiveWorker(meta: Record<string, any> | undefined): boolean {
  return Array.isArray(meta?.activeWorkers) && meta.activeWorkers.some((w: any) => /^(working|awaiting-input|awaiting-permission)$/.test(String(w?.phase ?? '')));
}

export function observatorySessions(state: DashState): ObservatorySession[] {
  const store = (state.views?.sessions as { sessions?: Record<string, any>[] } | undefined)?.sessions ?? [];
  const fleet = (state.views?.multitask as { agents?: Record<string, any>[] } | undefined)?.agents ?? [];
  const byId = new Map(store.map(s => [s.id, s]));
  const workers = new Map(fleet.map(s => [s.session, s]));
  const joined = new Set<string>();
  const rows: ObservatorySession[] = [];
  for (const machine of state.observatory?.machines ?? []) {
    // ONE row per session per machine. herdr keeps a pane's `agent_session` after the agent left it,
    // so a session moved to another pane (a resume elsewhere) showed twice: the stale pane as
    // "unknown" beside the live one. The pane whose agent is alive wins; among
    // equals the later pane does, which is where the agent moved to.
    const best = new Map<string, HerdrApi.PaneInfo>();
    const liveness = (p: HerdrApi.PaneInfo): number => (p.agent ? 2 : 0) + (p.agent_status && p.agent_status !== 'unknown' ? 1 : 0);
    for (const pane of machine.snapshot?.panes ?? []) {
      const session = pane.agent_session?.value;
      if (!session) continue;
      const held = best.get(session);
      if (!held || liveness(pane) >= liveness(held)) best.set(session, pane);
    }
    const metadata = machine.local ? byId : new Map(machine.sessions?.sessions.map(s => [s.id, s]) ?? []);
    for (const [session, pane] of best) {
      joined.add(session);
      const meta = metadata.get(session) ?? {};
      const f = machine.sessions?.workers?.find(w => w.session === session) ?? (machine.local ? workers.get(session) ?? {} : {});
      rows.push({ session, machineId: machine.id, machine: machine.label, paneId: pane.pane_id, pane,
        // A placeholder ("New Claude session") is not a name: the pane's own title outranks it.
        root: f.worktree || pane.cwd || '', label: f.state ? f.title : herdrTabTitle(machine.snapshot, pane.tab_id) || realSessionTitle(meta.title) || f.title || pane.title || session.slice(0, 12),
        agent: pane.agent_session?.agent || pane.agent || meta.agent || 'unknown', meta, fleet: f });
    }
  }
  for (const machine of state.observatory?.machines ?? []) for (const w of machine.sessions?.workers ?? []) {
    if (!w.session || rows.some(r => r.machineId === machine.id && r.session === w.session)) continue;
    joined.add(w.session);
    const meta = (machine.local ? byId.get(w.session) : machine.sessions?.sessions.find(r => r.id === w.session)) ?? {};
    rows.push({ session: w.session, root: w.worktree, label: w.title, machineId: machine.id, machine: machine.label,
      agent: w.kind, meta: { ...meta, tokens: w.tokens, lastActiveMs: w.lastActiveMs }, fleet: w });
  }
  for (const machine of state.observatory?.machines ?? []) if (!machine.local) for (const meta of machine.sessions?.sessions ?? []) {
    if (rows.some(s => s.machineId === machine.id && s.session === meta.id)) continue;
    if (!state.allSessions && !(meta.pending > 0) && !meta.current && !hasActiveWorker(meta)) continue;
    rows.push({ session: meta.id, root: meta.workspacePath || '', label: realSessionTitle(meta.title) || meta.id.slice(0, 12),
      machineId: machine.id, machine: machine.label, agent: meta.agent || 'unknown', meta, fleet: {} });
  }
  // Store-only sessions retain OAK's own liveness, but liveness does not grant retention: D9 is
  // precisely has-pane OR pending. A quiet, resolved session appears only with show archived.
  for (const meta of store) {
    if (state.observatory?.owners?.[meta.id] || joined.has(meta.id) || (!state.allSessions && !(meta.pending > 0) && !meta.current && !hasActiveWorker(meta))) continue;
    const f = workers.get(meta.id) ?? {};
    rows.push({ session: meta.id, root: f.worktree || '', label: realSessionTitle(meta.title) || f.title || meta.id.slice(0, 12),
      machineId: 'unresolved', machine: meta.machine || 'local', agent: meta.agent || 'unknown', meta, fleet: f });
  }
  return rows;
}

export function observatorySelection(state: DashState, session: string, machineId?: string): ObservatorySelection {
  return observatorySessions({ ...state, allSessions: true }).find(s => s.session === session && (!machineId || s.machineId === machineId))
    ?? { session, machineId, root: '', label: session.slice(0, 12) };
}

/**
 * Where a session's store lives, by the Observatory's own pane mapping: the machine whose herdr pane
 * runs its agent, since the capture hooks write the store beside the agent. A pane on THIS machine
 * wins. Undefined when no snapshot shows a pane for it: a store-only session is this machine's by
 * construction, and a machine that is connecting or unreachable has no snapshot to show one.
 */
export function sessionMachine(state: DashState, session: string): ObservatoryMachine | undefined {
  let remote: ObservatoryMachine | undefined;
  for (const machine of state.observatory?.machines ?? []) {
    if (!machine.snapshot?.panes.some(p => p.agent_session?.value === session)) continue;
    if (machine.local) return machine;
    remote ??= machine;
  }
  return remote;
}

/**
 * A saved machine whose own session catalog (`sessions --json --machine`, which the Observatory reads
 * off the paint path) lists a session. For a session no pane shows; the caller asks first whether this
 * machine holds it, because a listing elsewhere never outranks a transcript or store here.
 */
export function listedMachine(state: DashState, session: string): ObservatoryMachine | undefined {
  return state.observatory?.machines.find(m => !m.local && m.sessions?.sessions.some(r => r.id === session));
}

/**
 * The most recently active session on any machine — this machine's own listing (`local`, every agent's
 * sessions) and each saved machine's catalog — when it is more recent than `current`, the session Review is
 * on, by when each last took a turn (`lastTurnMs`; a row from an older OAK, which has none, by `lastActiveMs`;
 * a session that never took a turn never wins). A saved machine's session comes with its machine; this machine's comes
 * without one. `current`'s own activity comes from any listing; with no current session, or one no listing
 * names once this machine's has been read, any session qualifies. Null when nothing is more recent; undefined
 * while `current` cannot be weighed yet (this machine's listing is still unread). Only the listings
 * `candidate` accepts are searched (this machine's is `undefined`); any listing can supply `current`'s
 * activity. The Review tab of a launch that named no session opens on it, whatever its agent
 * or machine.
 */
export function newestAnywhere(state: DashState, local: readonly Record<string, unknown>[] | undefined, current: string,
  candidate: (machine: ObservatoryMachine | undefined) => boolean = () => true): { session: string; machine?: ObservatoryMachine } | null | undefined {
  // Activity is the last TURN: a resume's bookkeeping moves the file, not the conversation.
  // `lastTurnMs` null is a session that never took a turn (a fresh one nobody has typed into yet): it never
  // wins. Absent, the turn is unknown (an older OAK, or a file past the reader's reach): the file's clock.
  const at = (row: Record<string, unknown>): number => row.lastTurnMs === undefined ? Number(row.lastActiveMs) || 0 : Number(row.lastTurnMs) || 0;
  const saved = (state.observatory?.machines ?? []).filter(m => !m.local);
  const mine = current ? local?.find(r => r.id === current) ?? saved.flatMap(m => m.sessions?.sessions ?? []).find(r => r.id === current) : undefined;
  if (current && !mine && !local) return undefined;
  const bar = mine ? at(mine) : 0;
  let best: { session: string; machine?: ObservatoryMachine; at: number } | undefined;
  const weigh = (rows: readonly Record<string, unknown>[], machine?: ObservatoryMachine): void => {
    for (const row of rows) {
      const when = at(row);
      if (typeof row.id === 'string' && isSafeSessionId(row.id) && when > bar && when > (best?.at ?? 0)) best = { session: row.id, machine, at: when };
    }
  };
  if (local && candidate(undefined)) weigh(local);
  for (const machine of saved) if (candidate(machine)) weigh(machine.sessions?.sessions ?? [], machine);
  return best ? { session: best.session, ...(best.machine ? { machine: best.machine } : {}) } : null;
}

/**
 * The session picker's rows across machines: this machine's own listing first, then each saved
 * machine's as its catalog last answered, in that catalog's order. A saved machine's rows carry its
 * label as `machine` (what the picker shows) and `owner` (where the session is reviewed). A machine
 * whose catalog has not answered yet, or could not be read, is one `note` row in its place, so a list
 * still being gathered never reads as a machine without sessions, and a failed read never shows its
 * last answer as current. So is a failure to read the list of saved machines itself.
 */
export function pickerSessionRows(state: DashState, local: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [...local];
  // herdr's list of saved machines itself failed: no machine can be named, so say that instead.
  const listError = state.observatory?.machineError;
  if (listError) rows.push({ id: '!machines', machine: 'saved machines', error: listError, note: `could not read the saved machines — ${listError}` });
  for (const m of state.observatory?.machines ?? []) {
    if (m.local) continue;
    // Read from this machine's index: said once, before its rows, with when oak sync brought them.
    if (m.sessions?.fromIndex === true && typeof m.sessions.syncedAt === 'number' && m.sessions.sessions.length) {
      rows.push({ id: `!${m.label}:records`, machine: m.label, owner: m.label, note: `${m.label}'s sessions as its records hold them, synced ${relTime(m.sessions.syncedAt)}` });
    }
    if (m.sessions) for (const row of m.sessions.sessions) rows.push({ ...row, machine: m.label, owner: m.label });
    else rows.push({ id: `!${m.label}`, machine: m.label, owner: m.label, error: m.sessionsError,
      note: m.sessionsError ? `could not list ${m.label}'s sessions — ${m.sessionsError.replace(/^oak: /, '')}`
        : `${m.label} has not answered yet — its sessions appear here when it does` });
  }
  return rows;
}

/** The one state transition used by herdr's prefix then M, openConversation, and plugin/review jumps.
 * Runtime switching/fetching wraps this pure transition; no drive is started by navigating. */
export function selectAndPin(state: DashState, session: string, paneId = 'obs-detail', machineId?: string, within?: Pick<ObservatorySelection, 'agentId' | 'workers' | 'processId'>): DashState {
  const selection = { ...observatorySelection(state, session, machineId), ...within };
  const observatory = state.observatory ?? { machines: [], details: {} };
  const old = observatory.details[paneId];
  const same = old?.selection.session === session && old.selection.machineId === selection.machineId && old.selection.agentId === selection.agentId && old.selection.processId === selection.processId;
  // A half-typed reply belongs to its conversation. Re-pinning the leaf — one click in the master —
  // parks it with its session, and pinning that session again brings it back; the other session is
  // never offered it. A reply already on its way has nothing left to park.
  const drafts = { ...observatory.drafts };
  const draftKey = (s: ObservatorySelection): string => `${s.machineId ?? ''}:${s.session}`;
  if (!same && old?.reply?.text && !old.reply.sending) drafts[draftKey(old.selection)] = { text: old.reply.text, caret: old.reply.caret,
    focused: false, ...(old.reply.commentIds ? { commentIds: old.reply.commentIds } : {}) };
  const parked = same || selection.agentId || selection.processId ? undefined : drafts[draftKey(selection)];
  if (parked) delete drafts[draftKey(selection)];
  const detail = same ? old : {
    selection, events: [], cursor: null, loadedAt: state.now, loading: true, previews: {}, ...(parked ? { reply: parked } : {}),
  };
  return { ...state, activeTab: Math.max(0, state.tabs?.findIndex(t => t.id === 'observatory') ?? 0),
    // Keep the end sentinel through loading paints; the renderer clamps it only when reading.
    treeScroll: detail === old ? state.treeScroll : { ...state.treeScroll, [paneId]: Number.MAX_SAFE_INTEGER },
    scopeWorker: selection, observatory: { ...observatory, drafts, details: { ...observatory.details, [paneId]: detail } } };
}
