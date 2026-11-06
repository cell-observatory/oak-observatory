/** Independent data lanes: herdr events refresh panes, store events publish review tokens, and
 * transcript cursors refresh only pinned leaves. None of these asks for all dashboard views. */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { realSessionTitle, snapshotFromCli, type HerdrApi, type Subscription } from '@oak-observatory/core';
import type { DashState } from './frame';
import { createConversationReader, type ConversationReader } from './backend';
import { observatoryReply, observatorySessions, sessionMachine, type ObservatoryConversation, type ObservatoryMachine, type ObservatorySelection } from './observatory';

type Core = typeof import('@oak-observatory/core');
type RemoteMachine = Awaited<ReturnType<Core['herdrMachines']>>[number];
const REMOTE_POLL_MS = 15000;
const REMOTE_READ_MS = 10000;
const NO_TRANSCRIPT_RETRY_MS = 15000;
/** The least time between two Workers reads of one pinned local session: the refresh tick's own
 *  cadence (a store write refreshes too), backing off to twice a read that took longer. */
const WORKERS_READ_MS = 3000;
/** How long herdr keeps a pane's review token without hearing from OAK again — so a token outlives an
 *  OAK that quit by at most this — and an unchanged token is sent again at half of it. A 30 s token sent
 *  every 15 s cost a saved machine one ssh round trip per pending pane every 15 s. */
const TOKEN_TTL_MS = 120000;
const REMOTE_BACKOFF_MAX_MS = 120000;
/** How long what a pane's screen showed stands before the pane is read again with no newer revision: herdr 0.9.1 gives
 *  every pane revision 0 whatever its screen does (measured on a sandboxed server, with a client attached and without),
 *  so the revision alone would never call for a second read. The saved machines' poll: a pane there costs at most one
 *  forwarded read per poll. */
const SCREEN_READ_MS = REMOTE_POLL_MS;
/** How long a saved machine whose OAK cannot name its own tabs (from before `__tab-sync`) has them named
 *  from here before it is asked again; and a session's tab there that its OAK cannot name, because it
 *  holds no herdr pane link for the session. */
const TAB_SYNC_RETRY_MS = 10 * 60_000;

/** Forwarded herdr commands make several sequential SSH round trips (measured at 21–25 seconds).
 * Set OAK_HERDR_REMOTE_TIMEOUT_MS=60000 before launching OAK to allow a slower connection.
 * Read once per runtime; applies to remote snapshot, focus, prompt and metadata commands only.
 * Default: 30000 ms. Accept decimal integers from 1 to 2147483647 ms (Node's timer limit);
 * unset, blank, malformed or out-of-range values use the default. Local requests retain 4000 ms. */
export function observatoryRemoteTimeoutMs(): number {
  const raw = process.env.OAK_HERDR_REMOTE_TIMEOUT_MS?.trim() || '';
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(value) && value > 0 && value <= 2147483647 ? value : 30000;
}

interface RemotePoll {
  flight?: Promise<void>;
  interval: number;
  nextAt: number;
  active: boolean;
  generation: number;
  config: string;
}

/** Share envelope/version validation with the CLI and editors. */
export function remoteSnapshot(value: unknown): HerdrApi.SessionSnapshot {
  const snapshot = snapshotFromCli(value);
  if (!Array.isArray(snapshot.agents)) throw new Error('remote returned an incompatible snapshot');
  return snapshot;
}

export function createObservatory(core: Core, state: DashState, opts: {
  cwd: string;
  changed(): void;
  visibleProcesses?(paneId: string): string[];
  processesVisible?(): boolean;
  workersVisible?(): boolean;
  status(message: string): void;
  /** Injection keeps runtime tests entirely in process, including watcher and timer behavior. */
  reader?: ConversationReader;
  watch?: boolean;
  timers?: boolean;
  /** A one-shot frame (`oak tui --once`): read herdr, never write to it — no tab tidy, no review
   *  tokens, no identity reports — and hold no event subscription. */
  readOnly?: boolean;
  /** True while the host keeps `state.views.sessions` current itself (the app's own poll reads this
   *  machine's catalog): a store write then needs no second listing from here. */
  catalogFresh?: () => boolean;
  /** Each session list read here, which the host keeps as this machine's: a saved machine's review payload carries it. */
  catalog?: (sessions: unknown) => void;
}) {
  let closed = false;
  const reader = opts.reader ?? createConversationReader(core, opts.cwd);
  const reads = new Map<string, { selection: ObservatorySelection; promise: Promise<void> }>();
  const processReads = new Map<string, Promise<void>>();
  const processNext = new Map<string, { selection: ObservatorySelection; label?: string; at: number }>();
  const workerLogs = new Map<string, { selection: ObservatorySelection; files: string[]; stamp: string }>();
  const sources = new Map<string, string | undefined>();
  const conversationErrors = new Map<string, string>();
  const mirrorNotices = new Map<string, string>();
  const metadataPolls = new Map<string, { flight?: Promise<void>; nextAt: number; workers?: boolean }>();
  const workerNextAt = new Map<string, number>();
  /** The Workers failure the status row last said for each detail: said once, not on every read. A conversation pinned
   *  from a saved machine that is down failed this read every REMOTE_READ_MS, each time over the status row. */
  const workersSaid = new Map<string, string>();
  const enrichments = new Map<string, Promise<void>>();
  // The worker refresh (every 3 s per pinned detail) spawned a whole-fleet `multitask` read — 8 MB and
  // ~1 s of CPU — to use one session's subagents/todos. Gate it on the session's own stamps: the
  // transcript (size + mtime) and its subagents directory. Unchanged → nothing to spawn.
  const fleetStamps = new Map<string, string>();
  // A Codex conversation's transcript is DERIVED from its rollout, and is rewritten only when read — so
  // its own stamp never moves on its own, and an idle pinned Codex session was re-read every 750 ms
  // forever (80 cold reads a minute). The rollout's stamp says whether anything moved.
  const rollouts = new Map<string, string | null>();
  const rolloutSeen = new Map<string, string>();
  const stampOf = (file: string): string => { try { const st = fs.statSync(file); return `${st.ino}:${st.size}:${st.mtimeMs}`; } catch { return '-'; } };
  const fleetStamp = (transcriptPath: string): string => {
    const stamp = (file: string): string => { try { const st = fs.statSync(file); return `${st.size}:${st.mtimeMs}`; } catch { return '-'; } };
    const subagents = path.join(path.dirname(transcriptPath), path.basename(transcriptPath, '.jsonl'), 'subagents');
    return `${stamp(transcriptPath)}|${stamp(subagents)}`;
  };
  // The store watcher used to recompute `core.sessionMeta` on the paint thread on EVERY store write
  // (~200 ms per call, 438 ms of event-loop lag per append measured 2026-09-19). It now rides the
  // reader's child, coalesced: one in flight, one queued rerun.
  let sessionsInFlight = false;
  let sessionsRerun = false;
  // When each session list held here was read (the start of the read): a tab pass leaves alone a tab
  // that a session's own sync renamed after its list was read (herdr-tabs.ts `listedAt`).
  const listedAt = new WeakMap<object, number>();
  const sessionsRead = (list: unknown, startedAt: number): void => { if (list && typeof list === 'object') listedAt.set(list, startedAt); };
  async function refreshSessions(): Promise<void> {
    if (sessionsInFlight) { sessionsRerun = true; return; }
    sessionsInFlight = true;
    try {
      do {
        sessionsRerun = false;
        const root = opts.cwd;
        // The session the listing is read for. Review moving to another while it was read (the first session to appear,
        // adopted, or the picker's) cleared the views for that session's own read. One on this machine lists the sessions
        // too: this listing, and a rerun asked for before the move, would land there as a payload of sessions alone, which
        // Review drew as "… has no data to draw" until that read came. A saved machine's read lists none of this
        // machine's: while Review reads there, only a store write lists them, and its payload carries the host's catalog
        // (until that read fails, after which the listing lands here, as it did).
        const session = state.session;
        let sessions: unknown;
        const started = Date.now();
        try { sessions = reader.sessions ? await reader.sessions(session, root) : core.sessionMeta(root, session); }
        catch (error) { opts.status(`session store: ${errorText(error)}`); break; }
        if (closed || (state.session !== session && opts.catalogFresh?.())) break;
        sessionsRead(sessions, started);
        opts.catalog?.(sessions);
        if (state.views !== null || !state.reviewMachine || state.reviewMachine.error) state.views = { ...state.views, sessions };
        changed();
      } while (sessionsRerun);
    } finally { sessionsInFlight = false; }
  }
  let localFlight: Promise<void> | undefined;
  let localAgain = false;
  let discoveryFlight: Promise<RemoteMachine[]> | undefined;
  const remotePolls = new Map<string, RemotePoll>();
  let publishFlight: Promise<void> | undefined;
  let publishAgain = false;
  let subscription: { close(): void } | undefined;
  let subscribed = '';
  const reported = new Map<string, { pending: number; at: number }>();
  const linked = new Set<string>();
  /** Per pane, the key of the report that took it back from Codex's memory thread (see publishStore). */
  const healed = new Map<string, string>();
  /** publishStore's reports that failed, by key: when each may go out again, its last wait, and the error the status
   *  row has said for it. A report waits REMOTE_POLL_MS after a failure, twice that after the next, up to
   *  REMOTE_BACKOFF_MAX_MS, and the same error is said once, not on every pass. A saved machine that cannot be
   *  reached is said nowhere here, since the Observatory marks the machine, and every report to it waits under the
   *  machine's own key: each would otherwise wait out a connection timeout on every pass. */
  const failedReports = new Map<string, { at: number; wait: number; said?: string }>();
  const reportDue = (key: string): boolean => Date.now() >= (failedReports.get(key)?.at ?? 0);
  function reportFailed(key: string, error: unknown, what?: string): void {
    const last = failedReports.get(key);
    const wait = last ? Math.min(last.wait * 2, REMOTE_BACKOFF_MAX_MS) : REMOTE_POLL_MS;
    const said = what ? `${what}: ${errorText(error)}` : undefined;
    failedReports.set(key, { at: Date.now() + wait, wait, said });
    if (said && said !== last?.said) opts.status(said);
  }
  /** A failure said on the status row, taken back once what failed works again, if the row still says it: said once,
   *  it stood there after the machine was back. Another report or read that failed in the same words says them again
   *  at its next failure: taken back, they are on the row no longer. */
  const unsay = (said: string | undefined): void => {
    if (!said || state.status !== said) return;
    opts.status('ready');
    for (const report of failedReports.values()) if (report.said === said) report.said = undefined;
    for (const [paneId, text] of workersSaid) if (text === said) workersSaid.delete(paneId);
  };
  /** A closed pane is no longer a target. Keep its session and pending edits, but only a fresh herdr
   *  snapshot may give it a pane again; a saved capture link must not restart the report loop. */
  function forgetMissingPane(machineId: string, paneId: string, error: unknown): boolean {
    if (!(error instanceof core.HerdrError) || error.code !== 'pane_not_found') return false;
    const m = state.observatory?.machines.find(m => m.id === machineId);
    if (closed || !m?.snapshot) return true;
    const key = `${machineId}:${paneId}`;
    reported.delete(key);
    for (const report of failedReports.keys()) {
      if (report !== key && !(m.local && report.startsWith(`${paneId}:`))) continue;
      unsay(failedReports.get(report)?.said);
      failedReports.delete(report);
    }
    if (m.local) {
      for (const report of linked) if (report.startsWith(`${paneId}:`)) linked.delete(report);
      healed.delete(paneId);
    }
    screens.delete(`${machineId}\n${paneId}`);
    const snapshot = { ...m.snapshot, panes: m.snapshot.panes.filter(p => p.pane_id !== paneId),
      agents: m.snapshot.agents.filter(a => a.pane_id !== paneId) };
    state.observatory = { ...state.observatory!, machines: state.observatory!.machines.map(x => x === m ? { ...m, snapshot } : x) };
    changed();
    return true;
  }
  const identities = new Map<string, { ino: number; size: number; mtimeMs: number }>();
  const retryAt = new Map<string, number>();
  // Media captures set OAK_MACHINE_LABEL to a neutral name; normal sessions use the host name.
  const localLabel = process.env.OAK_MACHINE_LABEL?.trim() || os.hostname();
  state.observatory ??= { machines: [{ id: 'local', label: localLabel, local: true }], details: {} };
  const options = { binary: core.findHerdrBin() ?? undefined, timeoutMs: 4000 };
  const remoteOptions = { ...options, timeoutMs: observatoryRemoteTimeoutMs() };
  // Keep herdr's tabs tidy on every refresh: a `btop` tab running a system monitor in each machine's
  // `home` workspace (made again whenever it is missing) and every other tab named by the session its
  // pane runs. Best-effort, off the paint path.
  const monitor = core.resolveMonitor?.() ?? null;
  const tidyingTabs = new Set<string>();
  const pendingTabs = new Map<string, HerdrApi.SessionSnapshot>();
  // A saved machine names its own sessions' tabs. Its hooks keep their claims in its own store; the claims
  // this app kept here for its tabs were a second record of one server, and once this app had renamed a
  // tab there, the machine's own sync took the label for a person's and stopped following the session's
  // title. So the app asks the machine (`oak __tab-sync <session>` there, through the
  // CLI's `--machine`) when a session's title differs from its tab's label: once per tab, label and title,
  // one ask at a time per machine. The machine names the tab by its own record and its own current title.
  // One whose OAK is from before `__tab-sync` has its tabs named from here, as before, for TAB_SYNC_RETRY_MS;
  // so has a session the machine holds no herdr pane link for (its hooks never ran in that pane: not
  // installed there, or the session began before they were), whose tab it answers it cannot name.
  // A tab still wearing a name this app recorded giving it (before the update, or while that machine's OAK
  // could not) is vouched for, so the machine takes that claim on instead of taking the name for a person's.
  const tabAsks = new Map<string, string>();
  const tabAskQueues = new Map<string, Promise<void>>();
  const tabSyncMissing = new Map<string, number>();
  const unlinkedUntil = new Map<string, number>();
  const namesOwnTabs = (label: string): boolean => typeof reader.syncTab === 'function' && Date.now() >= (tabSyncMissing.get(label) ?? 0);
  const namedHere = (label: string, session: string): boolean => Date.now() < (unlinkedUntil.get(`${label}\n${session}`) ?? 0);
  function askToName(label: string, snapshot: HerdrApi.SessionSnapshot, titleOf: (id: string) => string | undefined): void {
    let recorded: Record<string, string> | undefined;
    for (const agent of snapshot.agents ?? []) {
      const session = agent.agent_session?.value;
      const tabId = session ? snapshot.panes?.find(p => p.pane_id === agent.pane_id)?.tab_id : undefined;
      const tab = tabId === undefined ? undefined : snapshot.tabs?.find(t => t.tab_id === tabId);
      const title = session ? titleOf(session)?.trim() : undefined;
      if (!session || !tab || !title || tab.label === title || namedHere(label, session)) continue;
      const key = `${label}\n${tab.tab_id}`, asked = `${session}\n${tab.label}\n${title}`;
      if (tabAsks.get(key) === asked) continue;
      tabAsks.set(key, asked);
      recorded ??= core.herdrTabClaims?.(label) ?? {};
      const claimed = recorded[tab.tab_id] === tab.label ? tab.label : undefined;
      const forget = () => { if (tabAsks.get(key) === asked) tabAsks.delete(key); };
      tabAskQueues.set(label, (tabAskQueues.get(label) ?? Promise.resolve()).then(async () => {
        if (closed) return;
        if (!namesOwnTabs(label)) { forget(); return; }
        try {
          const answer = await reader.syncTab!(session, label, claimed);
          if (answer === 'unlinked') {
            unlinkedUntil.set(`${label}\n${session}`, Date.now() + TAB_SYNC_RETRY_MS);
            const latest = state.observatory?.machines.find(m => m.label === label)?.snapshot;
            if (latest) tidyHerdrTabs(label, latest);
            return;
          }
          if (answer) return;
          tabSyncMissing.set(label, Date.now() + TAB_SYNC_RETRY_MS);
          forget();
        } catch { forget(); /* not reachable: asked again on the next pass */ }
      }));
    }
  }
  function tidyHerdrTabs(machineLabel: string | undefined, snapshot: HerdrApi.SessionSnapshot): void {
    if (closed || opts.readOnly || typeof core.ensureHerdrTabs !== 'function') return;
    const key = machineLabel ?? 'local';
    pendingTabs.set(key, snapshot);
    if (tidyingTabs.has(key)) return;
    tidyingTabs.add(key);
    // Metadata can arrive while the snapshot's pass is still running. Coalesce one follow-up so
    // the new title is applied promptly without concurrent renames or duplicate monitor creation.
    void (async () => {
      while (!closed && pendingTabs.has(key)) {
        const next = pendingTabs.get(key)!;
        pendingTabs.delete(key);
        const list = (machineLabel ? state.observatory?.machines.find(m => m.label === machineLabel)?.sessions
          : state.views?.sessions) as { sessions?: { id: string; title?: string }[] } | undefined;
        // A placeholder title ("New Claude session") never names a tab: the tab keeps its label until
        // the session has a real name.
        const titleOf = (id: string): string | undefined => realSessionTitle(list?.sessions?.find(s => s.id === id)?.title) ?? undefined;
        const asks = machineLabel !== undefined && namesOwnTabs(machineLabel);
        try {
          await core.ensureHerdrTabs({ machine: machineLabel, snapshot: next, titleOf, monitor, transport: core,
            herdrOptions: machineLabel ? remoteOptions : options, ...(asks ? { names: false } : { listedAt: list && listedAt.get(list) }) });
          if (asks) {
            // The tab of each session that machine cannot name is named from here, one tab at a time, by
            // this app's own record as before.
            const here = new Set((next.agents ?? []).filter(a => a.agent_session?.value && namedHere(machineLabel!, a.agent_session.value))
              .map(a => next.panes?.find(p => p.pane_id === a.pane_id)?.tab_id));
            for (const tab of here) if (tab !== undefined) await core.ensureHerdrTabs({ machine: machineLabel, snapshot: next, titleOf, only: tab,
              transport: core, herdrOptions: remoteOptions, listedAt: list && listedAt.get(list) });
            askToName(machineLabel!, next, titleOf);
          }
        } catch { /* a tidy tab bar never fails a refresh */ }
      }
    })().finally(() => { tidyingTabs.delete(key); });
  }
  const changed = () => { if (!closed) opts.changed(); };
  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
  function owner(selection: ObservatorySelection): string | undefined {
    const pinned = state.observatory?.machines.find(m => m.id === selection.machineId);
    if (selection.agentId && pinned) return pinned.local ? undefined : pinned.label;
    const found = sessionMachine(state, selection.session);
    if (found?.local) return undefined;
    return (pinned && !pinned.local ? pinned.label : undefined) ?? found?.label
      ?? state.observatory?.owners?.[selection.session];
  }
  function detailError(paneId: string): string | undefined {
    const detail = state.observatory?.details[paneId];
    if (!detail) return undefined;
    const label = owner(detail.selection);
    const metadataError = label && state.observatory?.machines.find(m => m.label === label)?.sessionsError;
    return [conversationErrors.get(paneId), metadataError ? `${label} session metadata unavailable: ${metadataError}` : '',
      mirrorNotices.get(paneId)].filter(Boolean).join(' · ') || undefined;
  }
  function updateErrors(label: string): void {
    for (const [paneId, detail] of Object.entries(state.observatory?.details ?? {})) {
      if (owner(detail.selection) === label) setDetail(paneId, { ...detail, error: detailError(paneId) });
    }
  }
  function refreshMachineSessions(label: string): Promise<void> {
    const m = state.observatory?.machines.find(m => m.label === label && !m.local);
    if (!m || !reader.sessions || closed) return Promise.resolve();
    let poll = metadataPolls.get(m.id);
    if (!poll) { poll = { nextAt: 0 }; metadataPolls.set(m.id, poll); }
    if (poll.flight) return poll.flight;
    const workers = opts.workersVisible?.() ?? false;
    if (Date.now() < poll.nextAt && (!workers || poll.workers)) return Promise.resolve();
    poll.workers = workers;
    const started = Date.now();
    const current = () => !closed && state.observatory?.machines.some(x => x.id === m.id && x.label === label);
    poll.flight = (async () => {
      try {
        const sessions = await reader.sessions(state.session, m.snapshot?.panes[0]?.cwd || opts.cwd, label, workers) as ObservatoryMachine['sessions'];
        if (!sessions || !Array.isArray(sessions.sessions)) throw new Error('Sessions read returned invalid JSON');
        if (!current()) return;
        sessionsRead(sessions, started);
        state.observatory!.machines = state.observatory!.machines.map(x => x.id === m.id ? { ...x, sessions, sessionsError: undefined } : x);
        const snapshot = state.observatory!.machines.find(x => x.id === m.id)?.snapshot;
        if (snapshot) tidyHerdrTabs(label, snapshot);
      } catch (error) {
        if (!current()) return;
        // Do not present the last successful facts as current after a failed refresh.
        state.observatory!.machines = state.observatory!.machines.map(x => x.id === m.id ? { ...x, sessions: undefined, sessionsError: errorText(error) } : x);
      } finally {
        poll!.nextAt = Date.now() + Math.max(REMOTE_READ_MS, Date.now() - started);
        poll!.flight = undefined;
        if (current()) { updateErrors(label); changed(); }
      }
    })();
    return poll.flight;
  }
  async function readFailure(paneId: string, selection: ObservatorySelection, label: string | undefined, error: unknown): Promise<void> {
    const current = () => !closed && state.observatory?.details[paneId]?.selection === selection && owner(selection) === label;
    if (!current()) return;
    // The CLI's own `oak: ` prefix reads mid-sentence here; the Review panes drop it the same way.
    conversationErrors.set(paneId, label ? `${label} conversation unavailable: ${errorText(error).replace(/^oak: /, '')}` : errorText(error));
    setDetail(paneId, { ...state.observatory!.details[paneId], loading: false, error: detailError(paneId) });
    if (!label || !reader.mirror) return;
    try {
      const copy = await reader.mirror(selection.session, selection.root || opts.cwd);
      if (!current()) return;
      if (copy.mirrored && Number.isFinite(copy.syncedAt)) {
        const time = new Date(copy.syncedAt!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
        mirrorNotices.set(paneId, `Only a local mirror is available (last synced copy from ${time}); waiting for ${label}.`);
        setDetail(paneId, { ...state.observatory!.details[paneId], error: detailError(paneId) });
      }
    } catch { /* provenance failure cannot hide the original transport failure */ }
  }
  // A Codex pane whose state hangs on its screen (paneScreenDecides: herdr calls it blocked, its turn is open with no hand
  // raised, and its rollout has gone quiet, as during a long command) shows what its screen does (paneAgentState). Its
  // visible screen is read through herdr when a snapshot shows the pane at a newer revision or its last reading is
  // SCREEN_READ_MS old, off the listing's path, one read at a time per machine, the pane read longest ago first. The pass
  // that starts reads runs on each snapshot and every second between them, so a rollout that has just gone quiet, or a
  // session row that has just come in, is read at once. What a read found stays on the pane while its newer screen is
  // read, and through the rollout's writes while the turn stays open with no hand raised (codexTurnBlocked), so a
  // working pane does not blink to blocked at every poll or quiet spell; a pane that leaves that state, or a machine with
  // no snapshot, forgets it. A read that fails is no evidence, said nowhere: herdr's word stands.
  const screens = new Map<string, { revision: number; working: boolean; at: number }>();
  const screenFlights = new Map<string, Promise<void>>();
  /** While readScreens waits, a reading taken since it began stands, however long the reads take: each pane is read once. */
  let freshFrom = Infinity;
  /** `m` with what its panes' screens showed on them (`screenWorking`, the revision that showed Codex at work), the
   *  same object when nothing changes; a pane whose screen decides it and has not been read at its revision is read. */
  function withScreens(m: ObservatoryMachine): ObservatoryMachine {
    const panes = m.snapshot?.panes ?? [];
    const rows = (m.local ? (state.views?.sessions as ObservatoryMachine['sessions'])?.sessions : m.sessions?.sessions) ?? [];
    const now = Date.now(), live = new Set<string>();
    let due: HerdrApi.PaneInfo | undefined, dueAt = Infinity;
    const next = panes.map(pane => {
      const key = `${m.id}\n${pane.pane_id}`;
      let working: number | undefined;
      const row = pane.agent_status === 'blocked' ? rows.find(r => r.id === pane.agent_session?.value) : undefined;
      if (row && core.codexTurnBlocked(pane, row)) {
        live.add(key);
        const seen = screens.get(key);
        if (seen?.working) working = seen.revision;
        const fresh = seen && seen.revision === pane.revision && (now - seen.at < SCREEN_READ_MS || seen.at >= freshFrom);
        if (core.paneScreenDecides(pane, row, now) && !fresh && (seen?.at ?? 0) < dueAt) { due = pane; dueAt = seen?.at ?? 0; }
      }
      return (pane as { screenWorking?: number }).screenWorking === working ? pane : { ...pane, screenWorking: working };
    });
    for (const key of screens.keys()) if (key.startsWith(`${m.id}\n`) && !live.has(key)) screens.delete(key);
    if (due && !screenFlights.has(m.id)) {
      const flight = readScreen(m, due).finally(() => { screenFlights.delete(m.id); showScreens(m.id); });
      screenFlights.set(m.id, flight);
    }
    return next.every((pane, i) => pane === panes[i]) ? m : { ...m, snapshot: { ...m.snapshot!, panes: next } };
  }
  /** Read `pane`'s visible screen as text, as herdr's CLI does (`pane read --source visible --format text`), on a saved
   *  machine through that CLI with the remote budget, and keep what it shows with the revision it was read at. */
  async function readScreen(m: ObservatoryMachine, pane: HerdrApi.PaneInfo): Promise<void> {
    let working = false;
    try {
      const text = m.local
        ? (await core.herdrRequest('pane.read', { pane_id: pane.pane_id, source: 'visible', format: 'text', strip_ansi: true }, options)).read.text
        : await core.herdrOnMachine(m.label, ['pane', 'read', pane.pane_id, '--source', 'visible', '--format', 'text'], { ...remoteOptions, text: true });
      working = typeof text === 'string' && core.codexScreenWorking(text);
    } catch (error) { if (forgetMissingPane(m.id, pane.pane_id, error)) return; /* no evidence */ }
    screens.set(`${m.id}\n${pane.pane_id}`, { revision: pane.revision, working, at: Date.now() });
  }
  /** Put what the screens read show on machine `id` as the state holds it now, and start its next read. */
  function showScreens(id: string): void {
    const m = closed ? undefined : state.observatory?.machines.find(x => x.id === id);
    const next = m && withScreens(m);
    if (!m || next === m) return;
    state.observatory = { ...state.observatory!, machines: state.observatory!.machines.map(x => x === m ? next! : x) };
    changed();
  }
  /** The screen pass over every machine as the state holds it now. */
  const showAllScreens = (): void => { for (const m of state.observatory?.machines ?? []) showScreens(m.id); };
  /** Settles once every pane whose screen decides it has been read, so a one-shot frame shows what the live app shows. */
  async function readScreens(): Promise<void> {
    freshFrom = Date.now();
    try {
      showAllScreens();
      while (screenFlights.size) await Promise.all(screenFlights.values());
    } finally { freshFrom = Infinity; }
  }
  function machine(next: ObservatoryMachine): void {
    if (closed) return;
    const old = state.observatory!;
    const previous = old.machines.find(m => m.id === next.id && m.label === next.label);
    next = withScreens({ sessions: previous?.sessions, sessionsError: previous?.sessionsError, ...next });
    const owners = { ...old.owners };
    for (const pane of next.snapshot?.panes ?? []) {
      const session = pane.agent_session?.value;
      if (!session) continue;
      if (next.local) delete owners[session];
      else if (!sessionMachine(state, session)?.local) owners[session] = next.label;
    }
    const machines = old.machines.some(m => m.id === next.id)
      ? old.machines.map(m => m.id === next.id ? next : m) : [...old.machines, next];
    state.observatory = { ...old, machines, owners };
    followPanes(next);
    if (!next.local) void refreshMachineSessions(next.label);
    // A Codex pane herdr has just called blocked reads as a question waiting until its row shows the permission
    // prompt OAK's hook recorded first (paneAgentState): this machine's sessions are listed again now, not at the
    // app's next poll, or an approval prompt read as a question until then.
    else if (next.snapshot?.panes.some(p => p.agent_status === 'blocked' && (p.agent_session?.agent || p.agent) === 'codex'
      && previous?.snapshot?.panes.find(q => q.pane_id === p.pane_id)?.agent_status !== 'blocked')) void refreshSessions();
    changed();
  }
  /**
   * A detail pinned to a PANE follows the pane, not the session id it happened to hold when pinned.
   * The user restarts `claude` in the same pane (2026-09-22: three restarts in five minutes, chasing
   * a transcript-persistence flag) and the master row switches to the new session on the next
   * snapshot — but the detail kept tailing the OLD session's transcript, which no longer moves, and
   * a feed that stopped updating was the whole of what the reader saw. When the snapshot reports
   * a different session in the pinned pane, the detail retargets to it and reloads; a detail pinned
   * by session alone (no pane, `unresolved`) has nothing to follow and keeps its pin.
   */
  function followPanes(next: ObservatoryMachine): void {
    if (!next.snapshot) return;
    for (const [leafId, detail] of Object.entries(state.observatory!.details)) {
      const sel = detail.selection;
      if (sel.agentId) continue;
      if (!sel.paneId || sel.machineId !== next.id) continue;
      const pane = next.snapshot.panes.find(p => p.pane_id === sel.paneId);
      const session = pane?.agent_session?.value;
      if (!session || session === sel.session) continue;
      const selection: ObservatorySelection = { ...sel, session, root: pane!.cwd || sel.root, label: pane!.title || session.slice(0, 12) };
      identities.delete(leafId);
      fleetStamps.delete(leafId);
      rollouts.delete(leafId); rolloutSeen.delete(leafId); workerNextAt.delete(leafId);
      retryAt.delete(leafId);
      sources.delete(leafId);
      conversationErrors.delete(leafId);
      mirrorNotices.delete(leafId);
      // The half-typed reply is the person's; the scroll returns to the end so the new conversation
      // is followed from its tail: a leaf left scrolled up stops following once the
      // conversation outgrows the pane, which reads exactly like the defect this fixes.
      const reply = detail.reply ? { text: detail.reply.text, caret: detail.reply.caret, focused: detail.reply.focused } : undefined;
      setDetail(leafId, { selection, events: [], cursor: null, loadedAt: Date.now(), loading: true, previews: {}, ...(reply ? { reply } : {}) });
      state.treeScroll = { ...state.treeScroll, [leafId]: Number.MAX_SAFE_INTEGER };
      if (state.scopeWorker?.paneId === sel.paneId && state.scopeWorker.machineId === sel.machineId) state.scopeWorker = selection;
      void load(leafId);
    }
  }
  function subscribe(snapshot: HerdrApi.SessionSnapshot): void {
    if (opts.readOnly) return;
    const ids = snapshot.panes.map(p => p.pane_id).sort();
    const key = JSON.stringify(ids);
    if (subscription && key === subscribed) return;
    subscription?.close();
    subscribed = key;
    // A renamed workspace relabels its group at once rather than at the next pane event.
    const subscriptions: Subscription[] = [{ type: 'pane.created' }, { type: 'pane.closed' }, { type: 'pane.agent_detected' },
      { type: 'workspace.renamed' }, ...ids.map(pane_id => ({ type: 'pane.agent_status_changed' as const, pane_id }))];
    subscription = core.herdrSubscribe(subscriptions, () => { void refreshLocal(); }, {
      ...options,
      onStatus: status => { if (status === 'connected') void refreshLocal(); },
      onError: error => machine({ id: 'local', label: localLabel, local: true, error: errorText(error) }),
    });
  }
  let fleetFlight: Promise<void> | undefined;
  let fleetAt = 0;
  function refreshMachineWorkers(): void {
    if (!reader.workerFleet || closed || fleetFlight || Date.now() < fleetAt) return;
    fleetFlight = reader.workerFleet(state.session, opts.cwd).then(value => {
      const sessions = value as ObservatoryMachine['sessions'];
      if (closed || !Array.isArray(sessions?.workers)) return;
      state.observatory!.machines = state.observatory!.machines.map(m => m.local ? { ...m, sessions } : m);
      changed();
    }).catch(() => {
      if (!closed) state.observatory!.machines = state.observatory!.machines.map(m => m.local ? { ...m, sessions: undefined } : m);
    }).finally(() => { fleetAt = Date.now() + WORKERS_READ_MS; fleetFlight = undefined; });
  }
  function refreshLocal(): Promise<void> {
    if (closed) return Promise.resolve();
    refreshMachineWorkers();
    if (localFlight) { localAgain = true; return localFlight; }
    localFlight = (async () => {
      do {
        localAgain = false;
        try {
          const snapshot = await core.herdrSnapshot(options);
          if (closed) return;
          machine({ id: 'local', label: localLabel, local: true, snapshot });
          subscribe(snapshot);
          tidyHerdrTabs(undefined, snapshot);
          void publishStore();
        } catch (error) { machine({ id: 'local', label: localLabel, local: true, error: errorText(error) }); }
      } while (localAgain && !closed);
    })().finally(() => { localFlight = undefined; });
    return localFlight;
  }
  function discoverRemotes(): Promise<RemoteMachine[]> {
    if (discoveryFlight) return discoveryFlight;
    discoveryFlight = (async () => {
      const remotes = (await core.herdrMachines(options)).filter(m => m.enabled);
      if (closed) return [];
      for (const [id, poll] of remotePolls) {
        if (remotes.some(r => r.id === id)) continue;
        poll.active = false;
        // Retain the latch until the transport settles, even if the machine is re-enabled.
        if (!poll.flight) remotePolls.delete(id);
      }
      // A machine that left the list (removed, or disabled) takes its reports' waits with it: back, it starts again
      // from the first wait rather than the longest one it had reached.
      for (const key of failedReports.keys()) {
        const id = key.startsWith('machine:') ? key.slice('machine:'.length) : undefined;
        if (id !== undefined && !remotes.some(r => r.id === id)) failedReports.delete(key);
      }
      state.observatory = { ...state.observatory!, machineError: undefined,
        machines: state.observatory!.machines.filter(m => m.local || remotes.some(r => r.id === m.id)) };
      // Register every machine before its first poll settles. Absence of a result is loading,
      // never failure; later polls retain the last result while they are in flight.
      for (const remote of remotes) {
        const config = JSON.stringify([remote.label, remote.target, remote.session]);
        let poll = remotePolls.get(remote.id);
        if (!poll) {
          poll = { interval: REMOTE_POLL_MS, nextAt: 0, active: true, generation: 0, config };
          remotePolls.set(remote.id, poll);
        } else if (!poll.active || poll.config !== config) {
          Object.assign(poll, { interval: REMOTE_POLL_MS, nextAt: 0, active: true, generation: poll.generation + 1, config });
        }
        const previous = state.observatory!.machines.find(m => m.id === remote.id);
        if (!previous || previous.label !== remote.label) machine({ ...previous, id: remote.id, label: remote.label });
      }
      changed();
      return remotes;
    })().finally(() => { discoveryFlight = undefined; });
    return discoveryFlight;
  }
  function pollRemote(remote: RemoteMachine): Promise<void> | undefined {
    const poll = remotePolls.get(remote.id)!;
    // Skipped ticks never enqueue another request, change the result, or invalidate a late result.
    if (poll.flight || Date.now() < poll.nextAt) return;
    const generation = poll.generation;
    const current = () => !closed && poll.active && poll.generation === generation;
    const base = { id: remote.id, label: remote.label };
    poll.flight = (async () => {
      try {
        const snapshot = remoteSnapshot(await core.herdrOnMachine(remote.label, ['api', 'snapshot'], remoteOptions));
        if (!current()) return;
        poll.interval = REMOTE_POLL_MS;
        poll.nextAt = Date.now() + poll.interval;
        machine({ ...base, snapshot });
        tidyHerdrTabs(remote.label, snapshot);
        void publishStore();
      } catch (error) {
        if (!current()) return;
        // Cooldown starts when the failed command finishes, not when its slow SSH work began.
        poll.interval = Math.min(poll.interval * 2, REMOTE_BACKOFF_MAX_MS);
        poll.nextAt = Date.now() + poll.interval;
        machine({ ...base, error: errorText(error) });
      }
    })().finally(() => {
      poll.flight = undefined;
      if (!poll.active) remotePolls.delete(remote.id);
    });
    return poll.flight;
  }
  async function refreshRemotes(): Promise<void> {
    if (closed) return;
    try {
      const remotes = await discoverRemotes();
      if (closed) return;
      await Promise.allSettled(remotes.flatMap(remote => [pollRemote(remote), refreshMachineSessions(remote.label)]));
    } catch (error) {
      if (closed) return;
      state.observatory = { ...state.observatory!, machineError: errorText(error) };
      changed();
    }
  }

  /** Codex memory-writing threads among the sessions, by id, once each: publishStore runs on every refresh and
   *  read each linked Codex session's agent record again. A session with no record yet is asked again. */
  const memoryThreads = new Map<string, boolean>();
  const isMemoryThread = (id: string): boolean => {
    const known = memoryThreads.get(id);
    if (known !== undefined) return known;
    const memory = core.isCodexMemorySession(id);
    if (memory || core.readCodexAgentMeta(id)) memoryThreads.set(id, memory);
    return memory;
  };
  function publishStore(): Promise<void> {
    if (closed || opts.readOnly) return Promise.resolve();
    if (publishFlight) { publishAgain = true; return publishFlight; }
    publishFlight = (async () => {
      do {
        publishAgain = false;
        const local = state.observatory!.machines.find(m => m.local)?.snapshot;
        const store = (state.views?.sessions as { sessions?: { id: string; agent: string }[] } | undefined)?.sessions ?? [];
        // Multiple sessions may have used one pane. Only its newest explicit capture link can bind
        // it; never overwrite an identity herdr already reports or target a different server socket.
        // The one exception is Codex's memory-writing thread, which an OAK before 0.11.0 linked to the
        // pane of the session that ran it: its link binds nothing, and the pane goes back to that session.
        const latest = new Map<string, { session: string; kind: string; link: NonNullable<ReturnType<Core['readHerdrPaneLink']>> }>();
        for (const row of store) {
          const link = core.readHerdrPaneLink(row.id);
          if (!link || (link.socketPath && link.socketPath !== core.herdrSocketPath()) || (row.agent === 'codex' && isMemoryThread(row.id))) continue;
          if (!latest.has(link.paneId) || latest.get(link.paneId)!.link.at < link.at)
            latest.set(link.paneId, { session: row.id, kind: row.agent, link });
        }
        for (const pane of local?.panes ?? []) {
          if (!state.observatory!.machines.find(m => m.local)?.snapshot?.panes.some(p => p.pane_id === pane.pane_id)) continue;
          const item = latest.get(pane.pane_id);
          const held = pane.agent_session?.value;
          const replace = !!held && held !== item?.session && item?.kind === 'codex' && isMemoryThread(held);
          // Held by its session again, the pane can be taken again: the report that gave it back is forgotten,
          // so the next takeover is reported too. It was made once per thread and link, and a thread that took
          // the pane a second time kept it.
          if (item && held === item.session && healed.has(pane.pane_id)) {
            linked.delete(healed.get(pane.pane_id)!);
            healed.delete(pane.pane_id);
          }
          if (!item || (pane.agent_session && !replace) || !item.kind) continue;
          // Taking a pane back from a memory thread is a report of its own. This app may have reported the
          // session there itself before the thread took the pane (its snapshot did not yet show the hook's own
          // report), and having made that report once must not stop this one.
          const key = `${pane.pane_id}:${item.session}:${item.link.at}${replace ? `:${held}` : ''}`;
          if (linked.has(key) || !reportDue(key)) continue;
          try {
            await core.reportHerdrSession(item.session, item.kind, item.link, options, core, replace);
            linked.add(key);
            unsay(failedReports.get(key)?.said);
            failedReports.delete(key);
            if (replace) healed.set(pane.pane_id, key);
            void refreshLocal();
          } catch (error) { if (!forgetMissingPane('local', pane.pane_id, error)) reportFailed(key, error, 'herdr identity'); }
        }
        for (const session of observatorySessions(state)) {
          if (!session.paneId) continue;
          const pending = Number(session.meta.pending) || 0;
          const key = `${session.machineId}:${session.paneId}`;
          const old = reported.get(key);
          if ((!pending && !old) || (old?.pending === pending && Date.now() - old.at < TOKEN_TTL_MS / 2)) continue;
          const m = state.observatory!.machines.find(m => m.id === session.machineId)!;
          if (!m.snapshot?.panes.some(p => p.pane_id === session.paneId)) continue;
          const away = `machine:${m.id}`;
          if (!reportDue(key) || !reportDue(away)) continue;
          try {
            if (m.local) await core.herdrRequest('pane.report_metadata', {
              pane_id: session.paneId, source: 'oak', tokens: { pending: pending ? String(pending) : null }, ttl_ms: TOKEN_TTL_MS,
            }, options);
            else await core.herdrOnMachine(m.label, ['pane', 'report-metadata', session.paneId, '--source', 'oak',
              ...(pending ? ['--token', `pending=${pending}`] : ['--clear-token', 'pending']), '--ttl-ms', String(TOKEN_TTL_MS)], { ...remoteOptions, emptyOk: true });
            reported.set(key, { pending, at: Date.now() });
            unsay(failedReports.get(key)?.said);
            failedReports.delete(key);
            failedReports.delete(away);
          } catch (error) {
            if (forgetMissingPane(m.id, session.paneId, error)) continue;
            if (!m.local && core.herdrUnreachable(error)) reportFailed(away, error);
            else reportFailed(key, error, 'herdr review tokens');
          }
        }
      } while (publishAgain && !closed);
    })().finally(() => { publishFlight = undefined; });
    return publishFlight;
  }

  /** Edit previews, and — unless `workers` is false — the pinned session's Workers and Tasks. A tail
   *  asks for previews only: the Workers read (a whole-fleet `multitask`) re-ran after every tail that
   *  found new records, most of what a pinned, working session cost. It runs on
   *  the refresh tick, a store write and a load instead, at most once per WORKERS_READ_MS. */
  async function enrich(paneId: string, workers = true): Promise<void> {
    if (enrichments.has(paneId)) return enrichments.get(paneId);
    const detail = state.observatory?.details[paneId];
    if (!detail || detail.loading || !detail.transcriptPath || closed) return;
    if (detail.selection.agentId) return;
    const label = owner(detail.selection);
    if (sources.get(paneId) !== label) return;
    // The previews this read last published: the Workers read below must not take them for another read's.
    let published = detail.previews;
    const current = () => !closed && state.observatory?.details[paneId]?.selection === detail.selection
      && state.observatory.details[paneId].previews === published && owner(detail.selection) === label;
    const promise = (async () => {
      const ids = new Set<number>();
      for (const { update } of detail.events) {
        if (update.sessionUpdate === 'turn_end') update.records.slice(0, 8).forEach(r => ids.add(r.id));
        if (update.sessionUpdate === 'tool_call' && update.editId) ids.add(update.editId);
      }
      const missing = [...ids].filter(id => detail.previews[id] === undefined);
      const previews = { ...detail.previews };
      const unavailable = (why: unknown) => `(edit content unavailable${label ? ` on ${label}: ${errorText(why)}` : ' · open Review'})`;
      await Promise.all([(async () => {
        // A saved machine answers them all in one read: one ssh call each was 289 calls for one window of a
        // 2,600-edit session. An OAK there from before that read answers undefined, and each is asked alone.
        if (label && reader.diffs && missing.length) {
          try {
            const batch = await reader.diffs(detail.selection.session, [...missing], label);
            if (batch) for (const id of missing.splice(0)) previews[id] = batch.patches[id] ?? unavailable(batch.errors[id] ?? `no edit #${id}`);
          } catch (error) { for (const id of missing.splice(0)) previews[id] = unavailable(error); }
        }
        // A bounded queue avoids spawning one process per historical edit at the same instant.
        await Promise.all(Array.from({ length: Math.min(4, missing.length) }, async () => {
          while (missing.length && current()) {
            const id = missing.shift()!;
            try { previews[id] = await reader.diff(detail.selection.session, id, label); }
            catch (error) { previews[id] = unavailable(error); }
          }
        }));
        // Drawn now, not when the Workers read below ends: over ssh that read is the slower one.
        if (current() && Object.keys(previews).length > Object.keys(published).length) {
          setDetail(paneId, { ...state.observatory!.details[paneId], previews });
          published = previews;
        }
      })(), (async () => {
        if (!workers) return;
        try {
          if (Date.now() < (workerNextAt.get(paneId) ?? 0)) return;
          const stamp = label ? '' : fleetStamp(detail.transcriptPath!);
          const cached = state.observatory?.details[paneId]?.fleet;
          if (!label && cached && fleetStamps.get(paneId) === stamp) return; // nothing moved since the last read
          const started = Date.now();
          workerNextAt.set(paneId, Infinity);
          let fleet: Record<string, unknown>;
          try { fleet = await reader.fleet(detail.selection.session, detail.selection.root || opts.cwd, label); unsay(workersSaid.get(paneId)); workersSaid.delete(paneId); }
          finally {
            const took = Date.now() - started;
            workerNextAt.set(paneId, label ? Date.now() + Math.max(REMOTE_READ_MS, took) : started + Math.max(WORKERS_READ_MS, 2 * took));
          }
          if (current()) {
            fleetStamps.set(paneId, stamp);
            const next = state.observatory!.details[paneId];
            for (const event of next.events) if (event.update.sessionUpdate === 'plan') fleet.todos = event.update.entries;
            if (JSON.stringify(fleet) !== JSON.stringify(next.fleet)) setDetail(paneId, { ...next, fleet });
          }
        } catch (error) {
          const said = `Workers: ${errorText(error)}`;
          if (current() && workersSaid.get(paneId) !== said) { workersSaid.set(paneId, said); opts.status(said); }
        }
      })()]);
    })().finally(() => { enrichments.delete(paneId); });
    enrichments.set(paneId, promise);
    return promise;
  }
  function setDetail(paneId: string, detail: ObservatoryConversation): void {
    if (closed) return;
    state.observatory = { ...state.observatory!, details: { ...state.observatory!.details, [paneId]: detail } };
    changed();
  }
  function reconcile(detail: ObservatoryConversation): void {
    detail.optimistic = detail.optimistic?.filter(p => promptMatches(detail, p.event) <= p.previousMatches);
  }
  function promptMatches(detail: ObservatoryConversation, event: ObservatoryConversation['events'][number]): number {
    const update = event.update;
    return update.sessionUpdate === 'user_prompt' ? detail.events.filter(e => e.update.sessionUpdate === 'user_prompt'
      && e.update.content.text === update.content.text).length : 0;
  }
  function focusReply(paneId: string, focused = true): void {
    const { detail, reason } = observatoryReply(state, paneId);
    if (!detail) { opts.status(reason!); return; }
    if (focused && reason) { opts.status(reason); changed(); return; }
    if (focused) opts.status('ready');
    setDetail(paneId, { ...detail, reply: { text: '', caret: 0, ...detail.reply, focused } });
  }
  function editReply(paneId: string, text: string, caret = text.length): void {
    const { detail, reason } = observatoryReply(state, paneId);
    if (!detail || reason) return;
    setDetail(paneId, { ...detail, reply: { ...detail.reply, text, caret, focused: true, error: undefined } });
  }
  async function sendReply(paneId: string): Promise<void> {
    const { detail, machine, target, reason } = observatoryReply(state, paneId);
    if (reason || !detail || !machine || !target) { opts.status(reason || 'No live pane'); changed(); return; }
    const text = detail.reply?.text || '';
    if (!text.trim()) return;
    const event: ObservatoryConversation['events'][number] = { ts: Date.now(), update: { sessionUpdate: 'user_prompt', content: { type: 'text', text } } };
    const pending = { event, previousMatches: promptMatches(detail, event)
      + (detail.optimistic?.filter(p => p.event.update.sessionUpdate === 'user_prompt' && p.event.update.content.text === text).length || 0) };
    const reply = { ...detail.reply!, text: '', caret: 0, sending: true, error: undefined };
    setDetail(paneId, { ...detail, reply, optimistic: [...(detail.optimistic || []), pending] });
    try {
      if (machine.local) await core.herdrAgent.prompt({ target, text }, options);
      else {
        // Sent once the person pressed Enter: quitting the app, or closing its terminal, leaves it to finish.
        const result = await core.herdrOnMachine(machine.label, ['agent', 'prompt', target, text], { ...remoteOptions, keepOnExit: true }) as { error?: { message?: string } } | null;
        if (result?.error) throw new Error(result.error.message || 'remote prompt failed');
      }
      if (detail.reply?.commentIds?.length) {
        // The comments live beside the session: on its own machine when the pane is another's.
        try {
          if (machine.local) core.markCommentsSent(detail.selection.session, detail.reply.commentIds);
          else await reader.markCommentsSent(detail.selection.session, detail.reply.commentIds, machine.label);
        } catch (error) { opts.status(`Reply sent; could not mark review comments: ${errorText(error)}`); }
      }
      const current = state.observatory?.details[paneId];
      if (current?.selection === detail.selection)
        setDetail(paneId, { ...current, reply: { ...current.reply!, sending: false, commentIds: undefined } });
    } catch (error) {
      const current = state.observatory?.details[paneId];
      const message = errorText(error);
      if (current?.selection === detail.selection)
        setDetail(paneId, { ...current, optimistic: current.optimistic?.filter(p => p !== pending),
          reply: { ...current.reply!, text, caret: text.length, sending: false, error: message } });
      // Not sent: the text stays in the reply box, a draft, as `oak prompt` keeps it.
      opts.status(`Draft retained: ${message}`);
    }
  }
  function loadWorker(paneId: string): Promise<void> {
    const detail = state.observatory!.details[paneId];
    const selection = detail.selection, label = owner(selection);
    const flight = reads.get(paneId);
    if (flight?.selection === selection) return flight.promise;
    const files = label ? [] : core.workerFeedPaths(selection.root || opts.cwd, selection.session, selection.agentId!);
    const stamp = files.map(stampOf).join('|');
    const current = () => !closed && state.observatory?.details[paneId]?.selection === selection && owner(selection) === label;
    sources.set(paneId, label);
    const promise = (async () => {
      try {
        if (!reader.feed) throw new Error('Worker log reader is unavailable.');
        const feed = await reader.feed(selection.session, selection.root || opts.cwd, selection.agentId!, label);
        if (!current()) return;
        if (!Array.isArray(feed.entries) || feed.ref?.kind !== 'agent' || feed.ref.id !== selection.agentId) throw new Error('OAK returned an invalid worker log.');
        if (label && feed.workerLogVersion !== 1) throw new Error(`Update OAK on ${label} for live worker logs.`);
        workerLogs.set(paneId, { selection, files, stamp });
        setDetail(paneId, { ...state.observatory!.details[paneId], feed, loading: false, error: undefined, loadedAt: Date.now() });
      } catch (error) {
        if (current()) setDetail(paneId, { ...state.observatory!.details[paneId], loading: false, error: `Worker log unavailable: ${errorText(error)}` });
      } finally { if (current()) retryAt.set(paneId, Date.now() + (label ? REMOTE_READ_MS : 2000)); }
    })().finally(() => { if (reads.get(paneId)?.promise === promise) reads.delete(paneId); });
    reads.set(paneId, { selection, promise });
    return promise;
  }
  function refreshProcesses(paneId: string, force = false): Promise<void> {
    const detail = state.observatory?.details[paneId];
    if (!detail || closed || !reader.processes || opts.processesVisible?.() === false) return Promise.resolve();
    const flight = processReads.get(paneId);
    if (flight) return flight;
    const selection = detail.selection, label = owner(selection);
    const held = processNext.get(paneId);
    if (!force && held?.selection === selection && held.label === label && Date.now() < held.at) return Promise.resolve();
    const current = () => !closed && state.observatory?.details[paneId]?.selection === selection && owner(selection) === label;
    const promise = reader.processes(selection.session, selection.root || opts.cwd, selection.processId, opts.visibleProcesses?.(paneId) ?? [], label).then(processes => {
      if (!current()) return;
      if (!Array.isArray(processes.processes)) throw new Error('Invalid process list');
      setDetail(paneId, { ...state.observatory!.details[paneId], processes, processError: undefined,
        ...(selection.processId ? { loading: false } : {}) });
    }).catch(error => {
      if (current()) setDetail(paneId, { ...state.observatory!.details[paneId], processError: errorText(error), ...(selection.processId ? { loading: false } : {}) });
    }).finally(() => {
      processReads.delete(paneId);
      if (current()) processNext.set(paneId, { selection, label, at: Date.now() + (label ? 10000 : 2000) });
    });
    processReads.set(paneId, promise);
    return promise;
  }
  function load(paneId: string): Promise<void> {
    let previous = state.observatory?.details[paneId];
    if (!previous || closed) return Promise.resolve();
    const processes = refreshProcesses(paneId, true);
    if (previous.selection.processId) return processes;
    if (previous.selection.agentId) return loadWorker(paneId);
    const selection = previous.selection;
    const label = owner(selection);
    const changedOwner = sources.has(paneId) && sources.get(paneId) !== label;
    const flight = reads.get(paneId);
    if (!changedOwner && flight?.selection === selection) return flight.promise;
    if (changedOwner) {
      previous = { ...previous, events: [], cursor: null, source: undefined, transcriptPath: null, previews: {}, fleet: undefined, error: undefined };
      identities.delete(paneId); fleetStamps.delete(paneId); retryAt.delete(paneId); workerNextAt.delete(paneId);
      rollouts.delete(paneId); rolloutSeen.delete(paneId);
    }
    if (changedOwner || !previous.error) { conversationErrors.delete(paneId); mirrorNotices.delete(paneId); }
    sources.set(paneId, label);
    // Failed refreshes retain the error until a successful read, with no loading-message flicker.
    setDetail(paneId, { ...previous, loading: !previous.error, error: previous.error });
    if (label) void refreshMachineSessions(label);
    const started = Date.now();
    const current = () => !closed && state.observatory?.details[paneId]?.selection === selection && owner(selection) === label;
    const promise = (async () => {
      try {
        const result = await reader.read(selection.session, selection.root || opts.cwd, undefined, label);
        if (!current()) return;
        conversationErrors.delete(paneId); mirrorNotices.delete(paneId);
        if (!result.transcriptPath) conversationErrors.set(paneId, label
          ? `Conversation transcript is unavailable on ${label}.` : 'Conversation transcript is unavailable on this machine.');
        const detail: ObservatoryConversation = { ...state.observatory!.details[paneId], ...result, loadedAt: Date.now(), loading: false,
          error: detailError(paneId) };
        if (!result.transcriptPath) retryAt.set(paneId, Date.now() + NO_TRANSCRIPT_RETRY_MS);
        reconcile(detail);
        if (result.transcriptPath && !label) {
          const stat = fs.statSync(result.transcriptPath);
          identities.set(paneId, { ino: stat.ino, size: result.cursor ?? stat.size, mtimeMs: stat.mtimeMs });
          // Once per pin, and only for Codex: a lookup that misses walks the whole rollout tree. No
          // stamp is recorded yet, so the next tick reads once and records the one it read from.
          if (result.agent === 'codex' && !rollouts.has(paneId)) rollouts.set(paneId, core.findCodexRollout?.(selection.session) ?? null);
        }
        setDetail(paneId, detail);
        if (!result.transcriptPath && label) await readFailure(paneId, selection, label, 'Transcript is unavailable on the owning machine.');
        void enrich(paneId);
      } catch (error) {
        if (current()) {
          retryAt.set(paneId, Date.now() + NO_TRANSCRIPT_RETRY_MS);
          await readFailure(paneId, selection, label, error);
        }
      } finally {
        if (label && current()) retryAt.set(paneId, Math.max(retryAt.get(paneId) ?? 0, Date.now() + Math.max(REMOTE_READ_MS, Date.now() - started)));
      }
    })().finally(() => { if (reads.get(paneId)?.promise === promise) reads.delete(paneId); });
    reads.set(paneId, { selection, promise });
    return promise;
  }
  async function tail(): Promise<void> {
    await Promise.all(Object.entries(state.observatory?.details ?? {}).map(async ([paneId, detail]) => {
      if (closed) return;
      const processes = refreshProcesses(paneId);
      const label = owner(detail.selection);
      if (detail.selection.processId) { await processes; return; }
      if (sources.has(paneId) && sources.get(paneId) !== label) { await load(paneId); return; }
      if (reads.has(paneId)) return;
      if (detail.selection.agentId) {
        const held = workerLogs.get(paneId);
        if ((label || detail.error) && Date.now() < (retryAt.get(paneId) ?? 0)) return;
        if (!label && !detail.error && held?.selection === detail.selection && held.stamp === held.files.map(stampOf).join('|')) return;
        await loadWorker(paneId);
        return;
      }
      if (label) {
        void refreshMachineSessions(label);
        if (Date.now() < (retryAt.get(paneId) ?? 0)) return;
      }
      if (detail.loading || detail.cursor === null || !detail.transcriptPath) {
        if (detail.error && Date.now() < (retryAt.get(paneId) ?? 0)) return;
        await load(paneId);
        return;
      }
      const started = Date.now();
      const current = () => !closed && state.observatory?.details[paneId]?.selection === detail.selection && owner(detail.selection) === label;
      try {
        // Remote paths and byte cursors belong to the remote filesystem. Only local reads stat here.
        const stat = label ? undefined : fs.statSync(detail.transcriptPath);
        const old = identities.get(paneId);
        const rollout = stat && detail.agent === 'codex' ? rollouts.get(paneId) : undefined;
        const rolloutStamp = rollout ? stampOf(rollout) : undefined;
        if (rolloutStamp !== undefined && rolloutStamp === rolloutSeen.get(paneId)) return;
        if (stat && detail.agent !== 'codex' && old && stat.ino === old.ino && stat.size === old.size && stat.mtimeMs === old.mtimeMs) return;
        if (stat && (!old || stat.ino !== old.ino || stat.size < detail.cursor || (stat.size === old.size && stat.mtimeMs !== old.mtimeMs))) { await load(paneId); return; }
        const promise = (async () => {
          const result = await reader.read(detail.selection.session, detail.selection.root || opts.cwd, detail.cursor!, label, detail.source);
          if (!current()) return;
          const held = state.observatory!.details[paneId];
          const reset = result.reset === true;
          const events = reset ? result.events : [...held.events, ...result.events];
          if (((!label || !reset) && result.cursor !== null && result.cursor < detail.cursor!) || events.length > 10000 || (reset && !events.length)) {
            reads.delete(paneId); await load(paneId); return;
          }
          if (!result.transcriptPath && label) throw new Error('Transcript is unavailable on the owning machine.');
          // The derived Codex transcript was rewritten by this very read: its identity is the one after it.
          let read = stat;
          if (rolloutStamp !== undefined) try { read = fs.statSync(detail.transcriptPath!); } catch { /* keep the one before */ }
          if (read) identities.set(paneId, { ino: read.ino, size: result.cursor ?? read.size, mtimeMs: read.mtimeMs });
          if (rolloutStamp !== undefined) rolloutSeen.set(paneId, rolloutStamp);
          conversationErrors.delete(paneId); mirrorNotices.delete(paneId);
          if (!reset && result.cursor === detail.cursor && !result.events.length && !held.error) return;
          const next = { ...held, cursor: result.cursor, source: result.source, events, loadedAt: Date.now(), error: detailError(paneId),
            ...(reset ? { transcriptPath: result.transcriptPath, agent: result.agent, previews: {}, fleet: undefined } : {}) };
          reconcile(next);
          setDetail(paneId, next);
          void enrich(paneId, false);
        })();
        reads.set(paneId, { selection: detail.selection, promise });
        try { await promise; }
        catch (error) { if (current()) await readFailure(paneId, detail.selection, label, error); }
        finally { if (reads.get(paneId)?.promise === promise) reads.delete(paneId); }
      } catch (error) {
        if (current()) await readFailure(paneId, detail.selection, label, error);
      } finally {
        if (label && current()) retryAt.set(paneId, Date.now() + Math.max(REMOTE_READ_MS, Date.now() - started));
      }
    }));
  }
  /** Settles once every pinned leaf's workers, tasks and edit previews are read (a read already in
   *  flight is joined, not repeated), so a one-shot frame can wait for them. */
  function refreshWorkers(): Promise<void> {
    if (opts.workersVisible?.()) for (const m of state.observatory?.machines ?? []) {
      if (!m.local && !metadataPolls.get(m.id)?.workers) void refreshMachineSessions(m.label);
    }
    // A detail that closed takes the Workers failure it said with it, off the status row too (no read of it would work
    // again to take it back): opened again, its failure is said again.
    for (const [paneId, said] of workersSaid) if (!state.observatory?.details[paneId]) { unsay(said); workersSaid.delete(paneId); }
    return Promise.all(Object.keys(state.observatory?.details ?? {}).map(paneId => enrich(paneId))).then(() => undefined);
  }

  const watcher = opts.watch === false ? undefined : core.createWatcher({
    roots: core.observatoryRoots({ cwd: opts.cwd, session: state.session }).filter(root => root.kind === 'store').map(root => ({
      ...root, relevant: (file, dir) => file === null || path.basename(file) === 'herdr.json' || root.relevant(file, dir),
    })),
    onChange: () => {
      if (closed) return;
      if (!opts.catalogFresh?.()) void refreshSessions();
      void publishStore(); tail(); refreshWorkers(); changed();
    },
    onDegrade: (_dir, why) => opts.status(`Observatory store watcher: ${why}`),
  });
  const timers: NodeJS.Timeout[] = [];
  if (opts.timers !== false) {
    timers.push(setInterval(() => { void refreshLocal(); void refreshRemotes(); void publishStore(); }, REMOTE_POLL_MS));
    timers.push(setInterval(tail, 750));
    timers.push(setInterval(refreshWorkers, 3000));
    timers.push(setInterval(showAllScreens, 1000));
    timers.forEach(timer => timer.unref());
  }
  return {
    start: () => Promise.all([refreshLocal().then(() => fleetFlight), refreshRemotes()]), refreshLocal, refreshRemotes, refreshSessions, refreshWorkers, readScreens, publishStore, load, tail, refreshProcesses, focusReply, editReply, sendReply,
    /** The host read this machine's session list itself, starting at `startedAt` (see `listedAt`). */
    sessionsRead,
    async current(): Promise<ObservatorySelection> {
      const { pane } = await core.herdrRequest('pane.current', {}, options);
      if (!pane.agent_session?.value) throw new Error('The focused herdr pane has no session identity yet.');
      await refreshLocal();
      return { session: pane.agent_session.value, machineId: 'local', paneId: pane.pane_id, root: pane.cwd || '', label: pane.title || pane.agent_session.value.slice(0, 12) };
    },
    async focus(selection: ObservatorySelection): Promise<void> {
      const session = observatorySessions(state).find(s => s.session === selection.session && (!selection.machineId || s.machineId === selection.machineId));
      // A delegated agent's row names its pane and machine itself, before its session has a row of its own.
      const m = state.observatory?.machines.find(m => m.id === (session?.machineId ?? selection.machineId));
      const paneId = session?.paneId ?? selection.paneId;
      if (!paneId || !m) throw new Error('This session has no live herdr pane.');
      if (m.local) await core.herdrRequest('pane.focus', { pane_id: paneId }, options);
      else {
        // Protocol 22's CLI pane focus accepts a DIRECTION, not an id. agent focus accepts either
        // a name or pane id and forwards the correct pane.focus operation to the remote machine.
        const target = m.snapshot?.agents.find(a => a.pane_id === paneId)?.name || paneId;
        const result = await core.herdrOnMachine(m.label, ['agent', 'focus', target], remoteOptions) as { error?: { message?: string } } | null;
        if (result?.error) throw new Error(result.error.message || 'remote focus failed');
      }
    },
    close() { closed = true; reader.close(); subscription?.close(); watcher?.close(); timers.forEach(clearInterval); },
  };
}
