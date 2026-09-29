/** Snapshot identity and pinned conversations. No transport or filesystem work in this model. */
import { isSafeSessionId, realSessionTitle, type ConversationEvent, type HerdrApi } from '@oak-observatory/core';
import type { DashState } from './frame';

export interface ObservatoryMachine {
  id: string;
  label: string;
  local?: boolean;
  snapshot?: HerdrApi.SessionSnapshot;
  error?: string;
  /** Catalog read on this machine; never joined to a same-id row in the local catalog. */
  sessions?: { sessions: Record<string, any>[] };
  sessionsError?: string;
}
export interface ObservatorySelection {
  session: string;
  root: string;
  label: string;
  machineId?: string;
  paneId?: string;
}
export interface ObservatoryConversation {
  selection: ObservatorySelection;
  events: ConversationEvent[];
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
  const reason = !detail ? 'Pin a session to reply' : !session?.pane || !machine ? 'No live pane'
    : session.pane.agent_status === 'blocked' ? 'Blocked · answer in herdr'
    : detail.reply?.sending ? 'Sending…' : undefined;
  const target = machine?.snapshot?.agents.find(a => a.pane_id === session?.paneId)?.name || session?.paneId;
  return { detail, session, machine, target, reason };
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
      const f = machine.local ? workers.get(session) ?? {} : {};
      rows.push({ session, machineId: machine.id, machine: machine.label, paneId: pane.pane_id, pane,
        // A placeholder ("New Claude session") is not a name: the pane's own title outranks it.
        root: f.worktree || pane.cwd || '', label: realSessionTitle(meta.title) || f.title || pane.title || session.slice(0, 12),
        agent: pane.agent_session?.agent || pane.agent || meta.agent || 'unknown', meta, fleet: f });
    }
  }
  // Store-only sessions retain OAK's own liveness, but liveness does not grant retention: D9 is
  // precisely has-pane OR pending. A quiet, resolved session appears only with show archived.
  for (const meta of store) {
    if (state.observatory?.owners?.[meta.id] || joined.has(meta.id) || (!state.allSessions && !(meta.pending > 0) && !meta.current)) continue;
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
    if (m.sessions) for (const row of m.sessions.sessions) rows.push({ ...row, machine: m.label, owner: m.label });
    else rows.push({ id: `!${m.label}`, machine: m.label, owner: m.label, error: m.sessionsError,
      note: m.sessionsError ? `could not list ${m.label}'s sessions — ${m.sessionsError.replace(/^oak: /, '')}`
        : `${m.label} has not answered yet — its sessions appear here when it does` });
  }
  return rows;
}

/** The one state transition used by ctrl+a o, openConversation, and plugin/review jumps.
 * Runtime switching/fetching wraps this pure transition; no drive is started by navigating. */
export function selectAndPin(state: DashState, session: string, paneId = 'obs-detail', machineId?: string): DashState {
  const selection = observatorySelection(state, session, machineId);
  const observatory = state.observatory ?? { machines: [], details: {} };
  const old = observatory.details[paneId];
  const same = old?.selection.session === session && old.selection.machineId === selection.machineId;
  // A half-typed reply belongs to its conversation. Re-pinning the leaf — one click in the master —
  // parks it with its session, and pinning that session again brings it back; the other session is
  // never offered it. A reply already on its way has nothing left to park.
  const drafts = { ...observatory.drafts };
  const draftKey = (s: ObservatorySelection): string => `${s.machineId ?? ''}:${s.session}`;
  if (!same && old?.reply?.text && !old.reply.sending) drafts[draftKey(old.selection)] = { text: old.reply.text, caret: old.reply.caret,
    focused: false, ...(old.reply.commentIds ? { commentIds: old.reply.commentIds } : {}) };
  const parked = same ? undefined : drafts[draftKey(selection)];
  if (parked) delete drafts[draftKey(selection)];
  const detail = same ? old : {
    selection, events: [], cursor: null, loadedAt: state.now, loading: true, previews: {}, ...(parked ? { reply: parked } : {}),
  };
  return { ...state, activeTab: Math.max(0, state.tabs?.findIndex(t => t.id === 'observatory') ?? 0),
    // Keep the end sentinel through loading paints; the renderer clamps it only when reading.
    treeScroll: detail === old ? state.treeScroll : { ...state.treeScroll, [paneId]: Number.MAX_SAFE_INTEGER },
    scopeWorker: selection, observatory: { ...observatory, drafts, details: { ...observatory.details, [paneId]: detail } } };
}
