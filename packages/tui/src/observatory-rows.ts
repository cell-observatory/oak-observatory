/** Conversation rows reuse the Agent's text and action renderer; all inputs are plain values. */
import * as path from 'path';
import { compactTokens, compactDuration, relTime, agentKindLabel, realSessionTitle, UNKNOWN_WORKSPACE, type ConversationEvent, type HerdrApi } from '@oak-observatory/core';
import { agentBlob, agentTextRows, animGlyph, boxAround, type DashState, type DashRow } from './frame';
import { agentStateFace, agentStateOf, currentTheme, promptGround, tint, type Glyphs, type ColorDepth, type StateKey } from './glyphs';
import { displayWidth, fuzzyMatch, sanitizeCell, sliceVisible, stripSgr, wrapVisible } from './textwidth';
import { observatoryReply, observatorySessions, type ObservatoryConversation, type ObservatoryMachine, type ObservatorySession } from './observatory';

/** Preserve ANSI and all content even when a single colored word exceeds the pane width. */
function wrapRows(value: string, width: number): string[] {
  const cols = Math.max(1, width);
  return value.split('\n').flatMap(line => {
    const rows: string[] = [];
    let tokens: string[] = sanitizeCell(line).match(/\x1b\[[0-9;:]*m|[\s\S]/gu) || [];
    let style = '';
    while (tokens.length) {
      let used = 0, end = 0, space = -1;
      for (; end < tokens.length; end++) {
        const token = tokens[end];
        const w = displayWidth(token);
        if (used + w > cols && used > 0) break;
        if (token === ' ' && used > 0) space = end;
        used += w;
      }
      const cut = end < tokens.length && space > 0 ? space : end;
      const part = tokens.slice(0, cut).join('');
      rows.push(style + part + (style || part.includes('\x1b[') ? '\x1b[0m' : ''));
      const consumed = cut === space ? cut + 1 : cut;
      for (const token of tokens.slice(0, consumed)) {
        if (token.startsWith('\x1b[')) style = /^\x1b\[(?:0)?m$/.test(token) ? '' : style + token;
      }
      tokens = tokens.slice(consumed);
    }
    return rows.length ? rows : [''];
  });
}

function chip(s: ObservatorySession, g: Glyphs, depth: ColorDepth, now?: number): string {
  // A live pane is authoritative, including explicit unknown/done. OAK's age heuristic belongs
  // only to un-paned sessions; agentStateOf would otherwise turn herdr's done into idle.
  const status = s.pane?.agent_status ?? agentStateOf(s.fleet.phase || s.meta.phase || '', {
    active: s.meta.active, waiting: s.meta.attention && s.meta.attention.kind !== 'idle-done',
  });
  const face = agentStateFace(status, g);
  return now === undefined ? tint(`${face.glyph} ${face.label}`, face.key, depth)
    : `${animGlyph(status, now, g, depth)} ${tint(face.label, face.key, depth)}`;
}

/** Stand-ins for the spinners of live sessions: one cell wide, as the glyphs are, and put in when the
 *  frame is drawn. */
const SPIN = { working: '\uE000', blocked: '\uE001' } as const;
const masterMemo = new Map<string, { inputs: unknown[]; rows: DashRow[]; live: [number, keyof typeof SPIN][] }>();

/**
 * The master, rebuilt only when what it shows changes — a pane, a session's facts, a fold, the filter,
 * the selection, the day — and never for an animation frame, which moves only the live sessions'
 * spinners. It was built twice a frame, every 150 ms while any pane worked: 20 ms a frame with Show
 * archived and its folds open.
 */
export function observatoryMasterRows(state: DashState, cols: number, g: Glyphs, depth: ColorDepth): DashRow[] {
  const views = state.views as { sessions?: { sessions?: unknown }; multitask?: { agents?: unknown } } | null | undefined;
  const inputs = [state.observatory?.machines, state.observatory?.owners, state.observatory?.machineError, views?.sessions, views?.sessions?.sessions,
    views?.multitask?.agents, state.open, state.filter, state.allSessions, state.scopeWorker, new Date(state.now).toDateString()];
  const key = `${cols}\u001f${depth}\u001f${currentTheme()}\u001f${JSON.stringify(g)}`;
  let memo = masterMemo.get(key);
  if (!memo || memo.inputs.some((v, i) => v !== inputs[i])) {
    if (masterMemo.size > 8) masterMemo.clear();
    masterMemo.set(key, memo = { inputs, ...buildMasterRows(state, cols, g, depth) });
  }
  if (!memo.live.length) return memo.rows;
  const rows = memo.rows.slice();
  for (const [at, status] of memo.live) rows[at] = { ...rows[at], cells: rows[at].cells.replace(SPIN[status], animGlyph(status, state.now, g, depth)) };
  return rows;
}

function buildMasterRows(state: DashState, cols: number, g: Glyphs, depth: ColorDepth): { rows: DashRow[]; live: [number, keyof typeof SPIN][] } {
  const rows: DashRow[] = [];
  const live: [number, keyof typeof SPIN][] = [];
  const machines = state.observatory?.machines ?? [];
  // WHICH WORKSPACE a session belongs to: the herdr workspace its pane lives in, named as herdr's own sidebar and
  // agents list name it. A paneless session (an agent run in a plain terminal) has no herdr workspace;
  // it goes under its project — its directory's name, else the project label OAK's session pickers
  // show — and a session with neither says so rather than borrowing a name.
  const paneWorkspace = (machine: ObservatoryMachine | undefined, pane: HerdrApi.PaneInfo) => {
    const ws = machine?.snapshot?.workspaces?.find(w => w.workspace_id === pane.workspace_id);
    return { id: `herdr:${pane.workspace_id}`, label: ws?.label || pane.workspace_id || UNKNOWN_WORKSPACE, number: ws?.number ?? Infinity };
  };
  // One key, whatever the payload holds: the project directory's name — from the fleet's worktree when
  // it has one, else from the path core's session row gives (`~/src/app`) — or core's own label for an
  // unknown one. The two sources used to name one project twice (`app` and `~/src/app`), and a made-up
  // "no workspace" stood in for core's label.
  const projectOf = (s: ObservatorySession): string => path.basename(s.root || s.meta.workspace || '') || UNKNOWN_WORKSPACE;
  const workspaceLabel = (s: ObservatorySession): string =>
    s.pane ? paneWorkspace(machines.find(m => m.id === s.machineId), s.pane).label : projectOf(s);
  const sessions = observatorySessions(state).filter(s => !state.filter
    || fuzzyMatch(`${s.label} ${s.session} ${s.machine} ${workspaceLabel(s)} ${s.agent}`, state.filter));
  const add = (key: string, cells: string, extra: Partial<DashRow> = {}) => {
    const prefix = cells.match(/^ */)![0];
    const indent = prefix.slice(0, Math.max(0, cols - 2));
    wrapRows(cells.slice(prefix.length), cols - indent.length).forEach((line, i) => rows.push({
      ids: [], key: i ? `${key}:wrap:${i}` : key, cells: indent + line, ...extra, ...(i ? { cont: true } : {}),
    }));
  };
  // A session's live status: a herdr pane is authoritative; a paneless (store-only) session earns it
  // from its own phase. WORKING or BLOCKED — or the one the reader has pinned — is surfaced; everything
  // else folds, so a machine's live agents are not lost among hundreds of quiet-but-unresolved sessions.
  const statusOf = (s: ObservatorySession): string => s.pane?.agent_status ?? agentStateOf(s.fleet.phase || s.meta.phase || '', {
    active: s.meta.active, waiting: s.meta.attention && s.meta.attention.kind !== 'idle-done',
  });
  const byRecency = (a: ObservatorySession, b: ObservatorySession) => (b.meta.lastActiveMs || 0) - (a.meta.lastActiveMs || 0);
  const storeOnly = sessions.filter(s => !s.pane);
  const surfaced = (s: ObservatorySession): boolean => {
    const st = statusOf(s);
    // The session OAK is watching right now (`current`) always shows under its machine, even between
    // turns when its phase reads idle — otherwise the running session vanishes into the fold below.
    // The reader's selection shows there too, unless its fold is open and already lists it: pulling it
    // out of the open fold moved it away from under the arrows that picked it.
    return st === 'working' || st === 'blocked' || s.meta.current === true
      || (state.scopeWorker?.session === s.session && !state.open.has(s.meta.pending > 0 ? 'earlier' : 'archived'));
  };
  // Post-pivot every store-only session is on this machine (remote session gather was retired), so a
  // live paneless session belongs under the local node.
  const liveLocal = storeOnly.filter(surfaced).sort(byRecency);
  // Newest first, with a LIVE agent counted as now: a working workspace rises and a quiet one sinks.
  // Two live agents tie and keep herdr's own order, so the list does not reshuffle under the pointer
  // while both write.
  type Entry = { pane?: HerdrApi.PaneInfo; session?: ObservatorySession };
  type Group = { id: string; label: string; number: number; entries: Entry[] };
  const desc = (a: number, b: number): number => (b > a ? 1 : b < a ? -1 : 0);
  const activity = ({ session: s }: Entry): number => {
    const st = s && statusOf(s);
    return !s ? 0 : st === 'working' || st === 'blocked' ? Infinity : s.meta.lastActiveMs || 0;
  };
  const newest = (group: Group): number => Math.max(...group.entries.map(activity));
  const watched = (group: Group): number => (group.entries.some(e => e.session?.meta.current === true) ? 1 : 0);
  for (const machine of machines) {
    const error = `  not reachable · ${machine.error}`;
    const compactError = machine.error && displayWidth(error) > cols;
    add(`machine:${machine.id}`, tint(`${machine.label}${compactError ? ' ✗' : ''}`, 'accent', depth));
    if (machine.error) { if (!compactError) add(`machine:${machine.id}:error`, error); }
    else if (!machine.snapshot) { add(`machine:${machine.id}:loading`, '  connecting…'); }
    const groups: Group[] = [];
    const join = (id: string, label: string, number: number, entry: Entry): void => {
      const group = groups.find(x => x.id === id);
      if (group) group.entries.push(entry);
      else groups.push({ id, label, number, entries: [entry] });
    };
    if (!machine.error) for (const pane of machine.snapshot?.panes ?? []) {
      if (!pane.agent && !pane.agent_session) continue;
      const ws = paneWorkspace(machine, pane);
      join(ws.id, ws.label, ws.number, { pane, session: sessions.find(s => s.machineId === machine.id && s.paneId === pane.pane_id) });
    }
    // This machine's LIVE agents that are not in a herdr pane — a claude/codex the user ran in a plain
    // terminal still shows under its machine, even while herdr is connecting or unreachable (store-only
    // sessions do not depend on the herdr snapshot), never buried in the fold below. A project that
    // shares a herdr workspace's name joins that workspace rather than repeating its header.
    if (machine.local) for (const s of liveLocal) {
      const label = projectOf(s);
      join(groups.find(x => x.label === label)?.id ?? `project:${label}`, label, Infinity, { session: s });
    }
    // The workspace of the session OAK is watching comes first on its machine.
    groups.sort((a, b) => watched(b) - watched(a) || desc(newest(a), newest(b)) || desc(b.number, a.number));
    for (const group of groups) {
      add(`workspace:${machine.id}:${group.id}`, `  ${tint(group.label, 'agent', depth)}`);
      for (const { pane, session } of group.entries.sort((a, b) => desc(activity(a), activity(b)))) {
        if (!pane) { renderSession(session!, '    '); continue; }
        // The pane line is part of its session's entry: a click on it pins that session too.
        add(`pane:${machine.id}:${pane.pane_id}`, `    ${g.open} ${agentKindLabel(pane.agent_session?.agent || pane.agent || 'unknown')} · ${pane.pane_id}`,
          session ? { scope: session } : {});
        if (session) renderSession(session, '      ');
        else if (!pane.agent_session) add(`pane:${machine.id}:${pane.pane_id}:identity`,
          cols >= 25 ? '      waiting for session' : '      no session yet');
      }
    }
  }
  if (!state.observatory?.machines.length) add('machine:loading', 'herdr · connecting…');
  if (state.observatory?.machineError) add('machines:error', 'machines ✗');
  // Everything else with pending edits — quiet, waiting to be reviewed — folds into one collapsed row.
  const earlier = storeOnly.filter(s => !surfaced(s) && s.meta.pending > 0).sort(byRecency);
  const foldGroup = (fold: string, label: string, group: ObservatorySession[], accent: 'accent' | 'undone') => {
    if (!group.length) return;
    const openGlyph = state.open.has(fold) ? g.open : g.closed;
    add(fold, tint(`${openGlyph} ${label} · ${group.length}`, accent, depth), { openPath: fold });
    if (state.open.has(fold)) group.forEach(s => renderSession(s, '  '));
  };
  foldGroup('earlier', 'earlier', earlier, 'accent');
  // Resolved sessions (nothing pending) only exist here under Show archived; they fold too.
  foldGroup('archived', 'archived', storeOnly.filter(s => !(s.meta.pending > 0)).sort(byRecency), 'undone');
  return { rows, live };

  function renderSession(s: ObservatorySession, indent: string): void {
    const key = `session:${s.machineId}:${s.paneId || ''}:${s.session}`;
    const selected = state.scopeWorker?.session === s.session && (!state.scopeWorker.machineId || state.scopeWorker.machineId === s.machineId);
    add(key, `${indent}${selected ? '>' : ' '} ${s.label}`, { scope: s });
    // The rich stat line the flat sessions list used to carry: a status, the model, the edit count and diffstat, the
    // token total, pending, and when it was last active — each tinted so the row reads at a glance. A
    // LIVE session shows its animated status word; a quiet one shows just a coloured dot, so the list is
    // not a column of "unknown" for every session whose agent is not running right now.
    const m = s.meta;
    const status = s.pane?.agent_status ?? agentStateOf(m.phase || s.fleet.phase || '', {
      active: m.active, waiting: m.attention && m.attention.kind !== 'idle-done',
    });
    const face = agentStateFace(status, g);
    const spinning = status === 'working' || status === 'blocked';
    // Show the status WORD when a pane vouches for it or the agent is live; a paneless quiet session
    // shows just its coloured dot, so an unknown phase does not print "unknown" on every row.
    const statusCell = spinning ? `${SPIN[status]} ${tint(face.label, face.key, depth)}`
      : s.pane ? tint(`${face.glyph} ${face.label}`, face.key, depth)
      : depth === 'none' ? face.glyph : tint(face.glyph, face.key, depth);
    const bits = [statusCell];
    if (m.model) bits.push(tint(String(m.model), 'agent', depth));
    if (m.edits) bits.push(`${m.edits} edit${m.edits === 1 ? '' : 's'}`);
    if (m.added || m.removed) bits.push(`${tint(`+${compactTokens(m.added || 0)}`, 'kept', depth)} ${tint(`−${compactTokens(m.removed || 0)}`, 'risk', depth)}`);
    if (m.tokens) bits.push(tint(`${compactTokens(m.tokens)} tok`, 'undone', depth));
    bits.push(`${m.pending ?? 0} pending`);
    // The clock time, as every other list shows it — never an age (0.10.0: "Timestamps now show the
    // exact time, not an age").
    const at = m.lastActiveMs ? tint(relTime(m.lastActiveMs, state.now), 'undone', depth) : '';
    // The spinner is the first cell after the indent, so it lands on the first of the rows this adds.
    if (spinning) live.push([rows.length, status]);
    add(`${key}:state`, `${indent}  ${bits.join(' · ')}${at ? ` · ${at}` : ''}`, { scope: s, cont: true });
    // No Workers fold here: its facts came from a whole-fleet read the Observatory never polls (it lists
    // sessions only), so it never showed. A pinned session's detail lists its Workers.
  }
}

// The transcript cache is distinct from the header cache. Moving an unpinned master selection
// changes its header only; pinned leaves retain both. No now bucket or views identity participates.
const detailMemo = new Map<string, { signature: string; detail?: ObservatoryConversation; open: ReadonlySet<string>; rows: DashRow[] }>();
const bodyMemo = new WeakMap<ConversationEvent[], Map<string, { open: ReadonlySet<string>; detail: ObservatoryConversation; rows: DashRow[] }>>();

/** Draft/caret/focus changes repaint only the reply row, not thousands of transcript rows. */
function sameBody(a: ObservatoryConversation | undefined, b: ObservatoryConversation | undefined): boolean {
  return a?.events === b?.events && a?.previews === b?.previews && a?.optimistic === b?.optimistic
    && a?.selection === b?.selection && a?.cursor === b?.cursor && a?.loadedAt === b?.loadedAt;
}

/** Fixed one-line input. A horizontal caret window retains the entire editable draft. */
export function observatoryReplyRow(state: DashState, paneId: string, cols: number, depth: ColorDepth): string | undefined {
  const { detail, reason } = observatoryReply(state, paneId);
  if (!detail || (reason && reason !== 'Sending…')) return undefined;
  const budget = Math.max(1, cols);
  const tier = (labels: string[]) => labels.find(s => displayWidth(s) <= budget) || labels.at(-1)!;
  if (reason) return tint(tier(['Sending…', 'Sending']), 'undone', depth);
  const reply = detail.reply;
  if (!reply?.focused) return tint(tier(['i reply · Enter sends · esc leaves', 'i reply · esc leaves', 'i reply']), 'undone', depth);
  const text = sanitizeCell(reply.text);
  const caret = displayWidth(sanitizeCell(reply.text.slice(0, reply.caret)));
  const room = Math.max(1, budget - 2);
  const start = Math.max(0, caret - room + 1);
  const before = sliceVisible(text, start, caret - start);
  const after = sliceVisible(text, caret, Math.max(0, room - displayWidth(before) - 1));
  return `> ${before}_${after}`;
}

export function observatoryDetailRows(state: DashState, cols: number, g: Glyphs, depth: ColorDepth): DashRow[] {
  const paneId = state.observatoryPane || 'obs-detail';
  const detail = state.observatory?.details[paneId];
  const selection = detail?.selection ?? state.scopeWorker;
  const sessions = observatorySessions({ ...state, allSessions: true });
  const session = sessions.find(s => s.session === selection?.session && (!selection.machineId || s.machineId === selection.machineId))
    ?? sessions.find(s => s.session === selection?.session && !s.pane);
  const meta = session?.meta ?? {};
  const fleet = detail?.fleet ?? session?.fleet ?? {};
  const title = realSessionTitle(meta.title) || selection?.label || 'Select a session';
  const machine = session?.machine || state.observatory?.machines.find(m => m.id === selection?.machineId)?.label || 'local';
  const status = session ? chip(session, g, depth) : '';
  const errors = (state.observatory?.machines || []).filter(m => m.error).map(m => `${m.label} · not reachable · ${m.error}`);
  if (state.observatory?.machineError) errors.push(`machines · not reachable · ${state.observatory.machineError}`);
  const signature = JSON.stringify([selection?.session, selection?.machineId, title, machine, status, meta.model, meta.tokens, meta.pending,
    fleet.subagents, fleet.todos, detail?.cursor, detail?.error, detail?.loading, detail?.reply?.error, errors]);
  // The theme is in the key: the rows carry its colours, and a theme saved from the options screen
  // must repaint a conversation that has not moved since.
  const key = `${paneId}\u001f${cols}\u001f${depth}\u001f${currentTheme()}\u001f${JSON.stringify(g)}`;
  const hit = detailMemo.get(key);
  if (hit?.signature === signature && sameBody(hit.detail, detail) && hit.open === state.open) return hit.rows;
  const rows: DashRow[] = [];
  // A wrapped row keeps its indent on every continuation, as the master's rows do, so a long worker or
  // task stays inside its list instead of running back to the pane's edge.
  const add = (key: string, cells: string, extra: Partial<DashRow> = {}) => {
    const prefix = cells.match(/^ */)![0];
    const indent = prefix.slice(0, Math.max(0, cols - 2));
    wrapRows(cells.slice(prefix.length), cols - indent.length).forEach((line, i) =>
      rows.push({ ids: [], key: i ? `${key}:wrap:${i}` : key, cells: indent + line, ...extra, ...(i ? { cont: true } : {}) }));
  };
  const header = [title, machine, status, meta.model, `${compactTokens(meta.tokens || 0)} tokens`, `${meta.pending || 0} pending`].filter(Boolean).join(' · ');
  wrapVisible(header, Math.max(8, cols)).forEach((line, i) => add(`detail:header:${i}`, line));
  errors.forEach((error, i) => add(`detail:machine-error:${i}`, error));
  const jumps = '↗ herdr   ⌕ review';
  if (selection) add('detail:jumps', jumps, { scope: selection, buttons: [
    { action: 'herdr', x: 0, w: displayWidth('↗ herdr') }, { action: 'review', x: displayWidth('↗ herdr   '), w: displayWidth('⌕ review') },
  ] });
  if (!detail) add('detail:preview', tint('A click or Enter pins this conversation · ↑↓ previews it here and in Review', 'undone', depth));
  else {
    if (detail.loading) add('detail:loading', 'loading conversation…');
    else if (detail.error) add('detail:error', detail.error);
    else if (!detail.events.length && !detail.optimistic?.length) add('detail:empty', 'No conversation events yet.');
    if (detail.reply?.error) add('detail:reply-error', `Reply failed: ${detail.reply.error}`);
    // A loop, not a spread: a long conversation's rows outnumber what one call may take as arguments.
    for (const row of conversationRows(state, detail, cols, g, depth)) rows.push(row);
    sections();
  }
  if (detailMemo.size > 64) detailMemo.clear();
  detailMemo.set(key, { signature, detail, open: state.open, rows });
  return rows;

  // Workers and Tasks list what is still going on and fold the rest. The header counts active/total; the fold
  // row under the listed entries opens to the rest in one click. Each entry wears its state's glyph and
  // colour: a worker's phase reads as both editors read it (working blue, waiting on a person orange,
  // errored red, done green, anything else grey), and ACTIVE is working or waiting, the editors'
  // Active-only rule. A task reads as the Tasks board reads it: in progress blue, pending amber, done
  // green; pending and in-progress tasks stay listed.
  function sections(): void {
    const workers = [...(fleet.subagents ?? [])].sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const workerFace = (entry: Record<string, any>) => {
      const st = entry.phase === 'done' ? 'done' : agentStateOf(entry.phase || '');
      return { ...agentStateFace(st, g), word: entry.phase || 'unknown', active: st === 'working' || st === 'blocked' };
    };
    const taskFace = (entry: Record<string, any>): { glyph: string; word: string; key: StateKey; active: boolean } =>
      entry.status === 'completed' ? { glyph: g.kept, word: 'done', key: 'kept', active: false }
        : entry.status === 'in_progress' ? { glyph: g.open, word: 'in progress', key: 'live', active: true }
        : { glyph: g.closed, word: 'pending', key: 'pending', active: true };
    section('Workers', workers, workerFace, 'active', 'finished', (entry, face, key) => {
      add(key, `  ${tint(face.glyph, face.key, depth)} ${entry.agentType || 'worker'} · ${entry.description || entry.currentTask || entry.agentId} · ${tint(face.word, face.key, depth)}`,
        { scope: { ...selection!, agentId: entry.agentId } });
      // Its stats wear the colours the session list's stats wear, one per kind, not its state's:
      // the diffstat green and red, the model and effort the agent colour, the clock, tokens
      // and duration grey, the edit count plain. Its state is the glyph and the word on the line above.
      const cost = [
        entry.model ? tint(String(entry.model), 'agent', depth) : '',
        entry.effort ? tint(String(entry.effort), 'agent', depth) : '',
        entry.ts ? tint(relTime(entry.ts, detail!.loadedAt), 'undone', depth) : '',
        `${entry.edits || 0} edit${entry.edits === 1 ? '' : 's'}`,
        tint(`↑${compactTokens(entry.tokensIn || 0)} ↓${compactTokens(entry.tokensOut || 0)} ↺${compactTokens(entry.tokensCacheRead || 0)}`, 'undone', depth),
        entry.durationMs ? tint(compactDuration(entry.durationMs), 'undone', depth) : '',
      ].filter(Boolean).join(' · ');
      add(`${key}:cost`, `    ${tint(`+${entry.added || 0}`, 'kept', depth)} ${tint(`−${entry.removed || 0}`, 'risk', depth)} · ${cost}`, { cont: true });
    });
    section('Tasks', fleet.todos ?? [], taskFace, 'open', 'done', (entry, face, key) =>
      add(key, `  ${tint(face.glyph, face.key, depth)} ${entry.content} · ${tint(face.word, face.key, depth)}`));
  }

  function section<F extends { key: StateKey; active: boolean }>(name: string, entries: Record<string, any>[], faceOf: (entry: Record<string, any>) => F,
    activeWord: string, restWord: string, render: (entry: Record<string, any>, face: F, key: string) => void): void {
    const fold = `detail:${paneId}:${selection?.session}:${name}`;
    const all = entries.map((entry, i) => ({ entry, face: faceOf(entry), key: `${fold}:${entry.agentId || i}` }));
    const active = all.filter(e => e.face.active);
    const rest = all.filter(e => !e.face.active);
    add(`${fold}:head`, all.length ? `${name} · ${active.length}/${all.length} ${activeWord}` : `${name} · 0`);
    active.forEach(e => render(e.entry, e.face, e.key));
    if (!rest.length) return;
    const open = state.open.has(fold);
    add(fold, `  ${tint(`${open ? g.open : g.closed} ${rest.length} ${restWord}`, 'undone', depth)}`, { openPath: fold });
    if (open) rest.forEach(e => render(e.entry, e.face, e.key));
  }
}

/** One rendered unit of a conversation — a prompt, a run of text or thought chunks, a plan, a tool call
 *  with every update merged into it, a turn's end — and the inputs it was drawn from. */
interface UnitRows {
  parts: number;
  open: boolean;
  previews: (string | undefined)[];
  day: string;
  syntax: boolean;
  selection: ObservatoryConversation['selection'];
  rows: DashRow[];
}
/**
 * Units by their first event, per width/depth/theme/glyphs. A delivered event is never rewritten — a tail
 * appends new objects, a reset replaces them all — so a unit whose inputs match draws the same rows, and
 * an append re-renders only what it touched. Every tail used to rebuild every row of the window on the
 * paint thread: 0.5 s a frame at 3,000 events, 1.6 s near the 10,000 that reloads it.
 */
const unitMemo = new Map<string, WeakMap<ConversationEvent, UnitRows>>();

/** Native transcript events share toolCallId updates; merge completions into their action box.
 * Adjacent text chunks join before line styling, preserving streamed markdown and tables. */
export function conversationRows(state: DashState, detail: ObservatoryConversation, cols: number, g: Glyphs, depth: ColorDepth): DashRow[] {
  let cache = bodyMemo.get(detail.events);
  if (!cache) bodyMemo.set(detail.events, cache = new Map());
  const key = `${cols}\u001f${depth}\u001f${currentTheme()}\u001f${JSON.stringify(g)}`;
  const hit = cache.get(key);
  if (hit && hit.open === state.open && sameBody(hit.detail, detail)) return hit.rows;
  let units = unitMemo.get(key);
  if (!units) {
    if (unitMemo.size > 8) unitMemo.clear();
    unitMemo.set(key, units = new WeakMap());
  }
  // Each merged action remembers the event that opened it and how many fed it: the pair names its unit
  // and says whether an update has arrived since it was drawn.
  const tools = new Map<string, { clone: any; parts: number }>();
  const events: { event: ConversationEvent; first: ConversationEvent }[] = [];
  for (const event of [...detail.events, ...(detail.optimistic || []).map(p => p.event)]) {
    const u = event.update;
    if (u.sessionUpdate === 'tool_call') {
      const tool = { clone: { ...u }, parts: 1 };
      tools.set(u.toolCallId, tool);
      events.push({ event: { ...event, update: tool.clone }, first: event });
    } else if (u.sessionUpdate === 'tool_call_update' && tools.has(u.toolCallId)) {
      const tool = tools.get(u.toolCallId)!;
      Object.assign(tool.clone, u, { sessionUpdate: 'tool_call' });
      tool.parts++;
    } else events.push({ event, first: event });
  }
  const rows: DashRow[] = [];
  const blobState = { ...state, now: detail.loadedAt, editPreviews: detail.previews };
  // What the rows read besides their events: the day (a clock time loses its date on the day it was
  // taken) and the syntax colouring of previews.
  const day = new Date(detail.loadedAt).toDateString();
  const syntax = state.syntax !== false;
  const width = Math.max(8, cols);
  const ground = promptGround(depth);
  for (let i = 0; i < events.length; i++) {
    const start = i;
    const { event: { update: u, ts }, first } = events[i];
    // A run of text (or of thought) is one unit: the chunks join before their lines are styled.
    if (u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'agent_thought_chunk')
      while (events[i + 1]?.event.update.sessionUpdate === u.sessionUpdate) i++;
    const tool = u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update' ? u as any : undefined;
    const parts = u.sessionUpdate === 'tool_call' ? tools.get((u as any).toolCallId)!.parts : i - start + 1;
    const fold = u.sessionUpdate === 'agent_thought_chunk' ? `thought:${detail.selection.session}:${ts}:${i}`
      : tool ? `conversation-tool:${detail.selection.session}:${tool.toolCallId}` : '';
    const open = fold !== '' && state.open.has(fold);
    const previews = tool ? [detail.previews[tool.editId]]
      : u.sessionUpdate === 'turn_end' ? u.records.slice(0, 8).map(r => detail.previews[r.id]) : [];
    const memo = units.get(first);
    if (memo && memo.parts === parts && memo.open === open && memo.day === day && memo.syntax === syntax
      && memo.selection === detail.selection && memo.previews.length === previews.length && memo.previews.every((p, n) => p === previews[n])) {
      for (const row of memo.rows) rows.push(row);
      continue;
    }
    const unit: DashRow[] = [];
    let sequence = 0;
    const add = (cells: string, extra: Partial<DashRow> = {}) => unit.push({ ids: [], key: `conversation:${detail.selection.session}:${start}:${sequence++}`, cells, ...extra });
    const text = (value: string) => value.split('\n').forEach(line => agentTextRows(line, cols, depth).forEach(styled =>
      wrapVisible(styled, Math.max(8, cols)).forEach(part => add(part))));
    if (u.sessionUpdate === 'user_prompt') {
      // The user's ask in the same box as the calls and edits around it:
      // who on the top edge, when on its right where every blob's time
      // rides, and inside, each of the ask's own lines wrapped, never cut, on the grey ground the claude
      // and codex CLIs paint behind a user's turn, a dim grey background across the entire
      // row. With no colour the box and its title carry the ask. The time gives way before the title
      // does. A drag copies the words, not the box (`copy`).
      const inner = width - 2;
      const at = ts ? relTime(ts, detail.loadedAt) : '';
      const stamp = at && displayWidth(`${g.box.tl}${g.box.h} You  ${at} ${g.box.tr}`) <= width ? at : '';
      const words = wrapRows(stripSgr(u.content.text), inner).map(line =>
        ground ? `${ground}${line}${' '.repeat(Math.max(0, inner - displayWidth(line)))}\x1b[0m` : line);
      const box = boxAround(tint('You', 'accent', depth), words, width, false, g, depth,
        stamp && depth !== 'none' ? `\x1b[2m${stamp}\x1b[0m` : stamp, true);
      box.forEach((line, n) => add(line, { copy: n === 0 || n === box.length - 1 ? null : [1, inner] }));
    } else if (u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'agent_thought_chunk') {
      let value = '';
      for (let n = start; n <= i; n++) {
        const chunk = events[n].event.update as typeof u;
        if (chunk.content.type === 'text') value += chunk.content.text;
      }
      if (u.sessionUpdate === 'agent_message_chunk') text(value);
      else {
        add(tint(`${open ? g.open : g.closed} thinking`, 'undone', depth), { openPath: fold });
        if (open) value.split('\n').forEach(line => text(`\u0002${line}`));
      }
    } else if (u.sessionUpdate === 'plan') {
      add(tint('Plan', 'accent', depth));
      u.entries.forEach(entry => text(`  ${entry.status === 'completed' ? g.kept : entry.status === 'in_progress' ? g.open : g.closed} ${entry.content}`));
    } else if (tool) {
      const input = tool.rawInput ?? {};
      const rawCommand = input.command || input.cmd || '';
      const command = Array.isArray(rawCommand) ? rawCommand.join(' ') : String(rawCommand);
      const content = (tool.content ?? []).map((c: any) => c.type === 'content' && c.content?.type === 'text' ? c.content.text : c.type === 'diff' ? c.path : '').filter(Boolean).join('\n');
      const target = command || input.file_path || input.path || '';
      const title = String(tool.title || tool.toolCallId);
      const label = target && title.endsWith(` ${target}`) ? title.slice(0, -target.length).trimEnd() : title;
      const entry = { kind: input.permission ? 'permission' : 'action', label, target,
        category: tool.kind === 'execute' ? 'exec' : tool.kind, detail: content, ts, editId: tool.editId,
        ok: tool.status === 'completed' ? true : tool.status === 'failed' ? false : undefined };
      const blob = agentBlob(blobState, entry, { g, depth, width: Math.max(8, cols), open: !open, box: true });
      blob.rows.forEach((line, n) => add(line, {
        ...(n === 0 ? { openPath: fold } : { cont: true }),
        ...(n === blob.moreRow && tool.editId ? { scope: detail.selection, buttons: [{ action: `conversation-diff:${tool.editId}`, x: 0, w: displayWidth(line) }] } : {}),
      }));
    } else if (u.sessionUpdate === 'turn_end') {
      text(`— turn ended · ${u.stopReason} · ${u.edits} edit${u.edits === 1 ? '' : 's'}`);
      for (const record of u.records.slice(0, 8)) {
        const blob = agentBlob(blobState, { kind: 'action', label: `Edit #${record.id}${record.partial ? ' partial' : ''}`, target: record.file,
          editId: record.id, ok: true }, { g, depth, width: Math.max(8, cols), open: true, box: true });
        blob.rows.forEach((line, n) => add(line, n === blob.moreRow ? {
          scope: detail.selection, buttons: [{ action: `conversation-diff:${record.id}`, x: 0, w: displayWidth(line) }],
        } : {}));
      }
      const more = u.records.length - 8;
      if (more > 0) text(`${more} more edit${more === 1 ? '' : 's'} · ⌕ review shows all`);
    }
    units.set(first, { parts, open, previews, day, syntax, selection: detail.selection, rows: unit });
    for (const row of unit) rows.push(row);
  }
  cache.set(key, { open: state.open, detail, rows });
  return rows;
}
