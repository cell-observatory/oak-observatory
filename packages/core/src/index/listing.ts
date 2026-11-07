/**
 * The listings the CLI serves from the index: `oak sessions --json`, `oak search` and `oak inbox`. Each is composed by
 * the same code as the listing it replaces, with the index answering what that listing would read from disk:
 *
 * - sessions: each session's listing facts (`composeSessionMeta` over the facts the index holds); what is true of a
 *   session right now (its attention, tab, phase and workers, whether it is current or running) is still read live;
 * - search: the asks and answers (`searchConversations` over the index's prompts, folded by the search's own fold);
 * - inbox: the hands raised across the sessions listing above.
 *
 * A listing is served from the index only when the index is caught up with the files on disk; otherwise, and whenever
 * the index is unavailable, the caller lists the old way. `OAK_INDEX=shadow` serves the old listing and records any
 * difference from the index's in `shadow.jsonl` beside the index (the parity gate run on a real machine).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { composeSessionMeta, normalizeSessionTitle, preferredSessionTitle, UNKNOWN_WORKSPACE, type ListingLive, type SessionListingFacts, type SessionMeta, type SessionMetaRow } from '../observe';
import { searchCandidates, searchConversations, sessionSearchIndex, type SearchCandidate, type SearchDoc, type SearchDocsOf, type SearchResult } from '../search';
import { attentionInbox, byHand, HAND_KINDS, type HandKind, type Inbox, type InboxRow } from '../notify';
import { goneTempWorkspace } from '../codex';
import { graphemeHead } from '../graphemes';
import { indexDir } from './location';
import { utf8 } from './ingest';
import { WORKERS_NONE } from './schema';

/** The listing facts of the sessions whose files are on this machine, as the index holds them: its own, and those oak
 *  sync pulled here (which the index files under the machine they came from, and the listing shows as it always has);
 *  and what it read of each one's store and workers when it caught up (`ListingLive`). */
export function indexedListing(db: DatabaseSync): { facts: Map<string, SessionListingFacts | null>; live: ListingLive } {
  const facts = new Map<string, SessionListingFacts | null>();
  const hands = new Map<string, ReturnType<ListingLive['attention']>>();
  const tabs = new Map<string, string>();
  const workers = new Map<string, Map<string, string> | null>();
  // A hand this machine's hooks raised: one another machine's records brought (a session oak sync pulled here) waits on
  // that machine, and its inbox row says so (syncedHands).
  for (const row of db.prepare(`SELECT s.session_id, s.listed, s.facts, l.tab, l.workers, a.kind, a.message, a.ts FROM sessions s
    LEFT JOIN session_live l ON l.machine_id = s.machine_id AND l.session_id = s.session_id
    LEFT JOIN attention a ON a.machine_id = s.machine_id AND a.session_id = s.session_id AND a.synced_ms IS NULL
    WHERE s.origin IN ('local', 'pulled') AND s.archived_ms IS NULL`).all() as {
      session_id: string; listed: number; facts: string | null; tab: string | null; workers: string | null; kind: string | null; message: string | null; ts: number | null }[]) {
    let f: SessionListingFacts | null = null;
    if (row.listed && row.facts) {
      try {
        f = JSON.parse(row.facts) as SessionListingFacts;
      } catch {
        f = null;
      }
    }
    // A Codex run found by its rollout, whose temp-dir workspace went after the index read it: hidden now, as the old
    // listing hides it, though nothing it was read from changed.
    if (f?.source && f.cwd && goneTempWorkspace(f.cwd)) f = null;
    facts.set(row.session_id, f);
    if (row.kind && row.ts !== null) hands.set(row.session_id, { kind: row.kind as 'permission' | 'input' | 'idle-done', message: row.message ?? '', ts: row.ts });
    if (row.tab) tabs.set(row.session_id, row.tab);
    // None read yet (a file from before schema 3, a catch-up that stopped part way): not set, so the listing asks every
    // worker, as the files' listing does.
    if (row.workers === WORKERS_NONE) workers.set(row.session_id, null);
    else if (row.workers) {
      try {
        workers.set(row.session_id, new Map(Object.entries(JSON.parse(row.workers) as Record<string, string>)));
      } catch {
        /* unread: asked, as above */
      }
    }
  }
  return { facts, live: { attention: (id) => hands.get(id) ?? null, tab: (id) => tabs.get(id) ?? null, workers: (id) => workers.get(id) } };
}

/** `sessionMeta` composed over the index's facts, reading live only a session's workers that may be running. */
export function indexedSessionMeta(db: DatabaseSync, cwd: string, reviewing?: string | null, opts: { includeEmpty?: boolean; includeReviews?: boolean } = {}): SessionMeta {
  const { facts, live } = indexedListing(db);
  return composeSessionMeta(cwd, reviewing, opts, facts.keys(), (id) => facts.get(id) ?? null, live);
}

/** The search's docs for one session from the index, when the index folded them from the file the search would read;
 *  else the session's own search index, as before. Every session's docs are read in one pass, the first time any is
 *  asked for: the search reads them all anyway (each term's rarity counts every ask), and one statement per session cost
 *  more than the reading. */
export function indexedDocs(db: DatabaseSync): SearchDocsOf & { fallbacks: number } {
  let bySession: Map<string, { ts: number; text: string; response: string; source: string }[]> | null = null;
  const load = (): Map<string, { ts: number; text: string; response: string; source: string }[]> => {
    const out = new Map<string, { ts: number; text: string; response: string; source: string }[]>();
    // The asks of the sessions whose files are here (this machine's, and the copies oak sync pulled), in key order, as
    // arrays where this Node returns them so: the other machines' asks, which only their records hold, stay in the index,
    // unread. An ask or answer holding a NUL is read as bytes: node:sqlite on Node 22 returns such a text cut at the NUL.
    const stmt = db.prepare(`SELECT p.session_id, p.ts, CASE WHEN p.nul = 1 THEN CAST(p.text AS BLOB) ELSE p.text END,
      CASE WHEN p.nul = 1 THEN CAST(p.response AS BLOB) ELSE p.response END, p.source FROM prompts p
      WHERE EXISTS (SELECT 1 FROM sessions s WHERE s.machine_id = p.machine_id AND s.session_id = p.session_id AND s.origin IN ('local', 'pulled'))
      ORDER BY p.machine_id, p.session_id, p.idx`) as StatementSync & { setReturnArrays?: (on: boolean) => void };
    const arrays = typeof stmt.setReturnArrays === 'function';
    if (arrays) stmt.setReturnArrays!(true);
    for (const raw of stmt.iterate() as Iterable<unknown>) {
      const [id, ts, text, response, source] = (arrays ? raw : Object.values(raw as Record<string, unknown>)) as [string, number, string | Uint8Array, string | Uint8Array, string];
      let list = out.get(id);
      if (!list) out.set(id, (list = []));
      list.push({ ts, text: utf8(text), response: utf8(response), source });
    }
    return out;
  };
  const fn = ((cwd: string, row: SearchCandidate) => {
    bySession ??= load();
    const rows = bySession.get(row.id) ?? [];
    const want = row.transcript ?? 'hooks';
    if (rows.length && rows.every((r) => r.source === want)) return { docs: rows.map((r): SearchDoc => ({ ts: r.ts, prompt: r.text, response: r.response })), built: false };
    if (!rows.length && row.transcript === null) return { docs: [], built: false };
    fn.fallbacks++;
    return sessionSearchIndex(cwd, row.id, row.transcript);
  }) as SearchDocsOf & { fallbacks: number };
  fn.fallbacks = 0;
  return fn;
}

/** A session another machine's records hold, as the listing's rows need it. */
interface SyncedSessionRow {
  session_id: string; agent: string; title: string | null; workspace: string; last_active_ms: number; last_turn_ms: number | null; capture_ms: number; tokens: number;
  cached: number; duration_ms: number; model: string; effort: string; edits: number; pending: number; files: number; added: number; removed: number; last_edit_id: number;
  store_bytes: number;
  /** Its raised hand, as its records brought it. */
  hand_kind: string | null; hand_message: string | null; hand_ts: number | null;
}

/** Another machine's sessions as its own listing shows them, from its records: none in which nothing happened (no edit,
 *  no tokens, no reply), no archived one and no Auto-review thread, grouped by workspace (the workspace with the latest
 *  session first), each newest first. `pulled`: with its sessions oak sync brought here, which this machine's own
 *  listing shows as well. `reviewing`: one of them listed whatever it is, as that machine lists the one `--session`
 *  names. */
export function syncedSessionRows(db: DatabaseSync, host: string, pulled = false, reviewing: string | null = null): SyncedSessionRow[] {
  const rows = db.prepare(`SELECT s.session_id, s.agent, s.title, s.workspace, s.last_active_ms, s.last_turn_ms, s.capture_ms, s.tokens, s.cached, s.duration_ms, s.model,
    s.effort, s.edits, s.pending, s.files, s.added, s.removed, s.last_edit_id, s.store_bytes, a.kind AS hand_kind, a.message AS hand_message, a.ts AS hand_ts FROM sessions s
    LEFT JOIN attention a ON a.machine_id = s.machine_id AND a.session_id = s.session_id AND a.synced_ms IS NOT NULL
    WHERE s.machine_id = ? AND s.origin IN ('synced', ?) AND s.archived_ms IS NULL
    AND (s.review = 0 OR s.session_id = ?) ORDER BY s.last_active_ms DESC, s.session_id`).all(host, pulled ? 'pulled' : 'synced', reviewing) as unknown as SyncedSessionRow[];
  // A model's reply names its model.
  const shown = rows.filter((r) => r.edits > 0 || r.tokens > 0 || r.cached > 0 || r.model !== '' || r.session_id === reviewing);
  const firstOf = new Map<string, number>();
  shown.forEach((r, i) => { if (!firstOf.has(r.workspace)) firstOf.set(r.workspace, i); });
  return shown.sort((x, y) => firstOf.get(x.workspace)! - firstOf.get(y.workspace)! || y.last_active_ms - x.last_active_ms || (x.session_id < y.session_id ? -1 : 1));
}

/** A raised hand's phase, as the session said it: never `working` while a hand is up. */
const HAND_PHASE: Record<string, string> = { permission: 'awaiting-permission', input: 'awaiting-input', question: 'awaiting-input', 'idle-done': 'done' };

/** One of those sessions in the listing's row shape, less what only its own machine can see now (its current session,
 *  tab and running workers). Its raised hand is the one its records brought, and its phase follows that hand (none while
 *  no hand is up: whether it works now is its machine's to say). `origin` and `machine` name where it is: `local` and
 *  THIS_MACHINE as its own machine prints it, or `synced` and that machine's label in this machine's listing of every
 *  machine. */
export function syncedSessionRow(r: SyncedSessionRow, origin: 'local' | 'synced', machine: string): SessionMetaRow {
  const hand = r.hand_kind && r.hand_ts !== null && HAND_PHASE[r.hand_kind] ? { kind: r.hand_kind as NonNullable<SessionMetaRow['attention']>['kind'], message: r.hand_message ?? '', ts: r.hand_ts } : null;
  return {
    id: r.session_id, workspace: r.workspace || UNKNOWN_WORKSPACE, workspacePath: r.workspace, origin, machine, title: r.title, lastActiveMs: r.last_active_ms,
    // As the listing says it: absent where unknown, null where it never took a turn.
    ...(r.last_turn_ms === null ? {} : { lastTurnMs: r.last_turn_ms || null }),
    liveMs: Math.max(r.last_active_ms, r.capture_ms), attention: hand, tab: null, current: false, edits: r.edits, pending: r.pending,
    files: r.files, added: r.added, removed: r.removed, lastEdit: r.last_edit_id, tokens: r.tokens, cached: r.cached, durationMs: r.duration_ms, storeBytes: r.store_bytes,
    storePath: '', model: r.model, effort: r.effort, agent: r.agent, activeWorkers: [],
    ...(hand ? { phase: HAND_PHASE[hand.kind], phaseConfidence: 'high' } : {}),
  };
}

/** Every other machine's sessions this index holds from its records (`oak sessions --json --synced`). */
export interface MachineListing {
  /** The saved machine's label oak sync reads it by, else the label its records carry, else its id. */
  label: string;
  /** Its machine id (its records' folder). */
  host: string;
  /** When oak sync last brought its records here: the start of the last run that read it (this machine's clock), else
   *  when its records last arrived in this index; null when neither is known. */
  syncedAt: number | null;
  /** When it last wrote records (its clock), as they say. */
  publishedAt: number | null;
  /** Its sessions as its own listing shows them (syncedSessionRows), each `origin: 'synced'` and `machine` its label. */
  sessions: SessionMetaRow[];
}

/** Every machine whose sessions this index holds from its records, by label: what each surface lists under it, read from
 *  the index alone. `status` is oak sync's last run (sync-engine.ts readSyncStatusFile), which names the machines it read. */
export function indexedMachineListings(db: DatabaseSync, status: { at: number; machines: { label: string; host?: string; status: string; lastOkAt?: number }[] } | null): MachineListing[] {
  const out: MachineListing[] = [];
  // When its records last arrived here (`synced_ms`, this machine's clock): its log's files carry its own clock's times.
  const hosts = (db.prepare(`SELECT s.machine_id AS host, coalesce(m.saved_label, m.label) AS label, m.synced_through_ms AS published, max(s.synced_ms) AS landed FROM sessions s
    LEFT JOIN machines m ON m.machine_id = s.machine_id WHERE s.origin = 'synced' GROUP BY s.machine_id`)
    .all() as { host: string; label: string | null; published: number | null; landed: number | null }[]);
  for (const h of hosts) {
    const run = status?.machines.find((m) => m.host === h.host);
    const rows = syncedSessionRows(db, h.host);
    if (!rows.length) continue;
    const label = run?.label || h.label || h.host;
    out.push({ label, host: h.host, syncedAt: run?.lastOkAt ?? (run?.status === 'ok' && status ? status.at : null) ?? h.landed ?? null,
      publishedAt: h.published ?? null, sessions: rows.map((r) => syncedSessionRow(r, 'synced', label)) });
  }
  return out.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.host < b.host ? -1 : 1));
}

/** Another machine's conversations searched from its records, ranked as `oak search` ranks them there: its sessions the
 *  records hold, and those oak sync brought here (none archived, no Auto-review thread), newest first, and their asks and
 *  answers. */
export function indexedMachineSearch(db: DatabaseSync, host: string, query: string, opts: { limit?: number; sinceMs?: number; perSession?: boolean } = {}): SearchResult {
  const candidates = (db.prepare(`SELECT session_id, title, workspace, agent, last_active_ms FROM sessions WHERE machine_id = ? AND origin IN ('synced', 'pulled') AND archived_ms IS NULL
    AND review = 0 ORDER BY last_active_ms DESC, session_id`).all(host) as { session_id: string; title: string | null; workspace: string; agent: string; last_active_ms: number }[])
    .map((r): SearchCandidate => ({ id: r.session_id, transcript: null, workspace: r.workspace, title: r.title, agent: r.agent, lastMs: r.last_active_ms }));
  const docs = new Map<string, SearchDoc[]>();
  // An ask or answer holding a NUL is read as bytes: node:sqlite on Node 22 returns a text cut at a NUL.
  for (const r of db.prepare(`SELECT session_id, ts, CASE WHEN nul = 1 THEN CAST(text AS BLOB) ELSE text END AS text,
    CASE WHEN nul = 1 THEN CAST(response AS BLOB) ELSE response END AS response FROM prompts WHERE machine_id = ? ORDER BY session_id, idx`).iterate(host) as Iterable<{ session_id: string; ts: number; text: string | Uint8Array; response: string | Uint8Array }>) {
    let list = docs.get(r.session_id);
    if (!list) docs.set(r.session_id, (list = []));
    list.push({ ts: r.ts, prompt: utf8(r.text), response: utf8(r.response) });
  }
  return searchConversations('', query, opts, (_cwd, row) => ({ docs: docs.get(row.id) ?? [], built: false }), () => candidates);
}

export function indexedSearch(db: DatabaseSync, cwd: string, query: string, opts: { limit?: number; sinceMs?: number; perSession?: boolean } = {}): SearchResult {
  const known = new Map<string, SearchCandidate>();
  for (const row of db.prepare("SELECT facts FROM sessions WHERE origin IN ('local', 'pulled') AND archived_ms IS NULL AND agent = 'claude' AND facts IS NOT NULL").all() as { facts: string }[]) {
    try {
      const f = JSON.parse(row.facts) as SessionListingFacts;
      // Only a Claude transcript whose provenance and title the catch-up checked. Codex and store-only candidates
      // follow their own discovery rules; Remote Control titles are still resolved from their live cache.
      if (f.agent !== 'claude' || f.shape !== 'transcript' || !f.transcript || f.rollout || !f.titleParts) continue;
      const p = f.titleParts;
      const title = normalizeSessionTitle(preferredSessionTitle({ customTitle: p.rename, bridgeSessionId: p.bridge, title: p.aiTitle, firstUserPrompt: p.prompt }) ?? '');
      known.set(f.id, { id: f.id, transcript: f.transcript, workspace: f.workspace, title, agent: f.agent, lastMs: f.lastActiveMs });
    } catch {
      /* unreadable facts: the candidate is read from its files */
    }
  }
  return searchConversations(cwd, query, opts, indexedDocs(db), () => searchCandidates(known));
}

/** How long another machine's hand is listed here: one up longer than a day is taken for abandoned, as the hands a machine
 *  is judged live by (api.ts HAND_WINDOW_MS) and the desktop's once-per-hand claims (notify.ts) are. */
export const SYNCED_HAND_MS = 24 * 60 * 60_000;

/** The hands other machines raised, as their record logs brought them here (`attention` rows another machine's log
 *  filled): one row each, labelled with the label this machine knows that machine by, and how fresh it is, most urgent
 *  first (notify.ts byHand). Their sessions (those oak sync pulled here too, whose archive here is of this machine's copy
 *  alone), none archived there and no Codex Auto-review thread, as the listing leaves them out; none raised more than
 *  SYNCED_HAND_MS ago; a turn's end only with `includeDone`. `status` is oak sync's last run (sync-engine.ts
 *  readSyncStatusFile), which says when it last brought each machine's records. */
export function syncedHands(db: DatabaseSync, now: number, includeDone: boolean, status: { at: number; machines: { host?: string; status: string; lastOkAt?: number }[] } | null): InboxRow[] {
  const since = now - 86_400_000;
  const rows = db.prepare(`SELECT a.machine_id, a.session_id, a.kind, a.message, a.ts, a.synced_ms, s.title, s.agent, s.workspace,
      coalesce(m.saved_label, m.label, a.machine_id) AS label, m.synced_through_ms,
      (SELECT total(max(0, min(coalesce(w.end_ms, ?1), ?1) - max(w.start_ms, ?2))) FROM waits w
        WHERE w.machine_id = a.machine_id AND w.session_id = a.session_id AND coalesce(w.end_ms, ?1) >= ?2) AS waited
    FROM attention a JOIN sessions s ON s.machine_id = a.machine_id AND s.session_id = a.session_id
    LEFT JOIN machines m ON m.machine_id = a.machine_id
    WHERE a.synced_ms IS NOT NULL AND a.ts >= ?3 AND s.origin IN ('synced', 'pulled') AND (s.archived_ms IS NULL OR s.origin = 'pulled') AND s.review = 0
      AND coalesce(m.is_self, 0) = 0${includeDone ? '' : " AND a.kind <> 'idle-done'"}`).all({ '?1': now, '?2': since, '?3': now - SYNCED_HAND_MS }) as {
      machine_id: string; session_id: string; kind: string; message: string; ts: number; synced_ms: number; title: string | null; agent: string; workspace: string;
      label: string; synced_through_ms: number | null; waited: number }[];
  const out: InboxRow[] = [];
  for (const r of rows) {
    if (!(HAND_KINDS as readonly string[]).includes(r.kind)) continue;
    const kind = r.kind as HandKind;
    const run = status?.machines.find((m) => m.host === r.machine_id);
    out.push({
      id: r.session_id, title: r.title, agent: r.agent, workspace: r.workspace || UNKNOWN_WORKSPACE, machine: r.label, kind, message: r.message, ts: r.ts,
      waitingMs: kind === 'idle-done' ? 0 : Math.max(0, now - r.ts), waitedTodayMs: Math.round(r.waited), question: null, current: false,
      origin: 'synced', host: r.machine_id, syncedAt: run?.lastOkAt ?? (run?.status === 'ok' && status ? status.at : null) ?? r.synced_ms, publishedAt: r.synced_through_ms,
    });
  }
  return out.sort(byHand);
}

/** This machine's inbox from the index, as from its files (attentionInbox). The other machines' hands, which only the
 *  index holds, are added by the caller whichever way it read this machine's (syncedHands; the CLI's `oak inbox`). */
export function indexedInbox(db: DatabaseSync, cwd: string, opts: { includeDone?: boolean; now?: number } = {}): Inbox {
  return attentionInbox(cwd, { ...opts, meta: indexedSessionMeta(db, cwd) });
}

/** What the index's listing and the old one disagree on, for shadow mode: null when they agree. */
export function listingDifference(a: unknown, b: unknown, path = '$'): string | null {
  if (Object.is(a, b)) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return `${path}: ${graphemeHead(JSON.stringify(a) ?? 'undefined', 120)} != ${graphemeHead(JSON.stringify(b) ?? 'undefined', 120)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return `${path}: ${a.length} items != ${bb.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = listingDifference(a[i], bb[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    const d = listingDifference(ao[k], bo[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

/** Record a shadow-mode difference beside the index (private: it names sessions). Kept under 1 MB. */
export function recordShadow(kind: string, difference: string): void {
  try {
    const file = path.join(indexDir(), 'shadow.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(file).size > 1024 * 1024) fs.rmSync(file, { force: true });
    } catch {
      /* first record */
    }
    fs.appendFileSync(file, JSON.stringify({ at: Date.now(), kind, difference }) + '\n', { mode: 0o600 });
  } catch {
    /* shadow records are a convenience */
  }
}

