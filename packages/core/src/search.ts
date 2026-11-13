/**
 * Search every conversation on this machine: the asks you typed and the
 * prose the agent answered with, across sessions and workspaces, ranked — what memex does for herdr,
 * over the transcripts oak already reads.
 *
 * A PERSISTED, INCREMENTAL INDEX. This machine holds 600 MB of transcripts; reading them on every
 * search took 21 s (measured), and the in-memory file cache is cold in every fresh CLI process. So
 * each session keeps `search-index-v3.json` among the derived caches (`changemap-cache/<session>/`):
 * the asks and their answers, built once and then extended from a BYTE CURSOR — transcripts are append-only, so a live session's index grows by
 * exactly the lines written since, never by a re-read. A shrunk or replaced file rebuilds from zero.
 * A Codex session is read through its derived transcript, so its replies are searched too. Sessions with
 * no transcript at all (driven ACP-only, a Codex session whose rollout is gone) contribute their asks
 * alone — the sidecar carries the questions, not the answers — and say so through `where`.
 *
 * Ranking: every term must appear (AND), a hit in the ASK outranks one in the answer, a rarer term
 * counts for more, and ties go to the newer ask. Read-only over the transcripts; the index is the
 * only thing written, and only in its owner's cache folder.
 */
import * as fs from 'fs';
import * as path from 'path';
import { findTranscript, fastSessionTitle, discoverListing, listingTranscripts } from './observe';
import { sessionPrompts } from './prompts';
import { storeDir, logPath, rootDir, allStoreSessionIds, hiddenSessions, isSafeSessionId } from './store';
import { sessionWorkspace, isMirroredTranscript, workspaceLabel } from './session';
import { readCodexAgentMeta, findCodexRollout, codexSessionTitle, codexSessionSources } from './codex';
import { codexTranscriptFile } from './codex-events';
import { PromptReader, PromptReaderState, toMs } from './asks';
import { pidAlive } from './daemon';
import { graphemeHead } from './graphemes';

/** A session the search consults: where its transcript is (a Codex one's derived transcript; null when
 *  there is none, and the asks come from the sidecar), and the little a hit needs to show. Enumerated
 *  HERE, not through `sessionMeta`: that listing also counts every session's pending edits, and for a
 *  live session with hundreds of captured edits that is ~14 s of scope detection whenever its
 *  transcript has grown (measured on a 97 MB transcript, 2026-09-15) — a cost a search must never pay. */
export interface SearchCandidate {
  id: string;
  transcript: string | null;
  workspace: string;
  title: string | null;
  agent: string;
  lastMs: number;
}

/** `known` supplies Claude metadata the local index just checked; a changed transcript is still read here. */
export function searchCandidates(known?: ReadonlyMap<string, SearchCandidate>): SearchCandidate[] {
  const hidden = hiddenSessions();
  const out = new Map<string, SearchCandidate>();
  const { byId, excluded } = discoverListing(listingTranscripts(), []);
  for (const [id, found] of byId) {
    if (hidden.has(id)) continue;
    const file = found.file;
    let lastMs = 0;
    try { lastMs = fs.statSync(file).mtimeMs; } catch { continue; }
    const cached = known?.get(id);
    if (cached?.transcript === file && cached.lastMs === lastMs) {
      out.set(id, { ...cached });
      continue;
    }
    let title: string | null = null;
    try { title = fastSessionTitle(file, id); } catch { /* no title */ }
    out.set(id, { id, transcript: file, workspace: found.workspace, title, agent: readCodexAgentMeta(id) ? 'codex' : 'claude', lastMs });
  }
  // Codex conversations, from the same rollouts the session lists show, read through the derived
  // transcript so the replies are searched as well as the asks. Newest first, so an archived copy loses.
  // Auto-review threads are left out, as the lists leave them out: each quotes the session it reviews.
  for (const source of codexSessionSources()) {
    if (source.review) { excluded.add(source.id); continue; }
    if (out.has(source.id) || hidden.has(source.id)) continue;
    out.set(source.id, { id: source.id, transcript: codexTranscriptFile(source.file), workspace: workspaceLabel(source.cwd),
      title: codexSessionTitle(source.file, source.id), agent: 'codex', lastMs: source.mtimeMs });
  }
  // Store sessions with no transcript here — driven (ACP-only) conversations, and Codex ones the
  // rollout scan above passed over (no prompt in its head, a temp workspace since removed).
  for (const id of allStoreSessionIds()) {
    if (out.has(id) || hidden.has(id) || excluded.has(id)) continue;
    const rollout = findCodexRollout(id);
    if (rollout && isMirroredTranscript(rollout).mirrored) continue;
    let lastMs = 0;
    try {
      lastMs = fs.statSync(logPath(id)).mtimeMs;
    } catch {
      /* a store with no log yet */
    }
    out.set(id, { id, transcript: rollout ? codexTranscriptFile(rollout) : null, workspace: workspaceLabel(sessionWorkspace(id) ?? ''), title: rollout ? codexSessionTitle(rollout, id) : null, agent: rollout || readCodexAgentMeta(id) ? 'codex' : 'claude', lastMs });
  }
  return [...out.values()].sort((a, b) => b.lastMs - a.lastMs);
}

export interface SearchHit {
  session: string;
  title: string | null;
  workspace: string;
  agent: string;
  /** When the ask was typed — how a surface finds the matching Prompts row. */
  ts: number;
  /** The ask itself, whitespace-collapsed. */
  prompt: string;
  /** An excerpt around the first matching term: `…` marks a cut end. */
  snippet: string;
  /** Where the excerpt came from. */
  where: 'prompt' | 'response';
  score: number;
}

export interface SearchResult {
  query: string;
  terms: string[];
  hits: SearchHit[];
  /** How many hits there were before `limit` cut them: more than `hits.length` means some were left out. */
  matched: number;
  /** Sessions consulted / asks scored / sessions whose index was (re)built this call. */
  sessions: number;
  asks: number;
  indexed: number;
  ms: number;
}

/** One ask and the prose that answered it, as the search reads them. */
export interface SearchDoc {
  ts: number;
  prompt: string;
  response: string;
}
type Doc = SearchDoc;

interface SessionIndex {
  /** 2: pasted prompts (`<pasted_content>`) are asks (2026-09-22); a v1 index folded past them. 4: every text block of an
   *  answer that spans several lines is folded, not only its first line's (2026-10-30). */
  v: 5;
  transcript: string;
  /** Bytes of the transcript already folded into `docs` (always at a line boundary). */
  bytes: number;
  docs: Doc[];
  prompts?: PromptReaderState;
}

/** Searchable prefix per answer, and per ask — an index that mirrored a 200 KB answer per turn would
 *  outgrow the transcript it came from. Each is cut where a character ends (graphemeHead): cut at a UTF-16
 *  index, a hit's ask or excerpt could end in half of an emoji's surrogate pair. */
const RESPONSE_CAP = 32 * 1024;
const PROMPT_CAP = 8 * 1024;

function indexPath(session: string): string {
  if (!isSafeSessionId(session)) throw new Error(`invalid session id: ${JSON.stringify(session)}`);
  // Versioned NAME: an older build still running beside this one keeps its own index. Among the derived
  // caches, never in the session's own folder: a session OAK had only read has no folder in the store, and
  // the index made it one, which `oak clean` then removed as an empty husk, the index with it, so the next
  // search read the whole transcript again.
  return path.join(rootDir(), 'changemap-cache', session, 'search-index-v5.json');
}

/** The search indexes in `dir` this build never reads: `search-index.json` and `search-index-v<N>.json`, but `keep`. */
function staleIndexNames(dir: string, keep: string | null): string[] {
  try {
    return fs.readdirSync(dir).filter((n) => n !== keep && /^search-index(?:-v\d+)?\.json$/.test(n));
  } catch {
    return []; // no such folder: a session OAK only read has none of its own
  }
}

/** A session's search indexes this build never reads: every one in the session's own folder, where versions before
 *  0.11.0 kept it, and those of an earlier version among the caches. `oak clean` reclaims them, as it does the change
 *  map's superseded caches. An older build still running beside this one builds its own again at its next search. */
export function pruneStaleSearchIndexes(session: string): { removed: number; bytes: number } {
  const out = { removed: 0, bytes: 0 };
  if (!isSafeSessionId(session)) return out;
  const live = indexPath(session);
  for (const [dir, keep] of [[path.dirname(live), path.basename(live)], [storeDir(session), null]] as const) {
    for (const n of staleIndexNames(dir, keep)) {
      const p = path.join(dir, n);
      try {
        const size = fs.statSync(p).size;
        fs.unlinkSync(p);
        out.removed++;
        out.bytes += size;
      } catch {
        /* gone already, or not ours to remove */
      }
    }
  }
  return out;
}

function readIndex(session: string): SessionIndex | null {
  try {
    const j = JSON.parse(fs.readFileSync(indexPath(session), 'utf8')) as SessionIndex;
    if (!j || j.v !== 5 || typeof j.transcript !== 'string' || typeof j.bytes !== 'number' || !Array.isArray(j.docs)) return null;
    return j;
  } catch {
    return null;
  }
}

/** Write the index; false when it could not be written. */
function writeIndex(session: string, idx: SessionIndex): boolean {
  try {
    const file = indexPath(session);
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A search stopped while it wrote (the terminal app's picker stops them routinely) leaves its temp
    // file behind, megabytes each: one whose writer is no longer running is removed, here and where the
    // index was kept until 0.11.0, whichever version's index it was writing.
    for (const at of [dir, storeDir(session)]) {
      let names: string[];
      try {
        names = fs.readdirSync(at);
      } catch {
        continue; // a session OAK only read has no folder of its own
      }
      for (const name of names) {
        const pid = /^search-index(?:-v\d+)?\.json\.(\d+)\.tmp$/.exec(name)?.[1];
        if (pid && Number(pid) !== process.pid && !pidAlive(Number(pid))) fs.rmSync(path.join(at, name), { force: true });
      }
    }
    const first = !fs.existsSync(file);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(idx), { mode: 0o600 });
    fs.renameSync(tmp, file);
    // The first index this build writes for a session retires the one an earlier version kept in the session's own
    // folder, of a format this build never reads, and that folder when the index was all it held (a session OAK only
    // read): left behind, `oak clean` removed it as an empty husk with the session's derived caches, this index among
    // them, and the next search read the whole transcript again. Only then, not at every write: an older build still
    // running beside this one writes its index there again, and removing that at each write made it read every
    // transcript from the start again. rmdir takes only an empty folder; a session's own stays.
    if (first) {
      const own = storeDir(session);
      try {
        for (const n of staleIndexNames(own, null)) fs.rmSync(path.join(own, n), { force: true });
        fs.rmdirSync(own);
      } catch {
        /* left behind it is never read, and the next `oak clean` reclaims it */
      }
    }
    return true;
  } catch {
    /* an unwritable index means the next search rebuilds — never a failed search */
    return false;
  }
}

/**
 * Fold `text` (whole lines of the transcript) into `docs`: an ask opens a doc, assistant prose joins the newest one.
 * Returns nothing; mutates `docs`. The search and the local index (index/ingest.ts) both fold with this.
 *
 * One answer spans several lines when it has several content blocks: Claude Code writes each block on a line of its own,
 * every one carrying the message's id, so a thinking block's line comes before the text it led to. Folding only the first
 * line of each id dropped that text, and with it most answers from a model that thinks first. Each distinct text of a
 * message is folded once instead, and a line that repeats an earlier one's text with more after it (a later snapshot of
 * the same block) adds only what is new. `seen` holds, per message id, the texts folded from it.
 */
export function foldSearchDocs(text: string, docs: SearchDoc[], seen: Map<string, string[]>, prompts = new PromptReader()): void {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o: { type?: string; message?: { role?: string; id?: string; content?: unknown }; isSidechain?: boolean; timestamp?: unknown; ts?: unknown };
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (o?.type === 'api-request-blob') continue;
    const ask = prompts.read(o);
    if (ask !== null) {
      docs.push({ ts: toMs(o.timestamp ?? o.ts), prompt: graphemeHead(ask, PROMPT_CAP), response: '' });
      continue;
    }
    const msg = o.message;
    if (!msg || msg.role !== 'assistant' || o.isSidechain === true || !docs.length) continue;
    const parts: string[] = [];
    if (typeof msg.content === 'string') parts.push(msg.content);
    else if (Array.isArray(msg.content)) {
      for (const b of msg.content as { type?: string; text?: string }[]) if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
    let seg = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (!seg) continue;
    if (typeof msg.id === 'string') {
      const folded = seen.get(msg.id) ?? [];
      if (folded.some((f) => f.startsWith(seg))) continue; // a repeat, or an earlier snapshot of a text already folded
      const grown = folded.findIndex((f) => seg.startsWith(f));
      if (grown >= 0) {
        const more = seg.slice(folded[grown].length).trim();
        folded[grown] = seg;
        seg = more;
      } else folded.push(seg);
      seen.set(msg.id, folded);
      if (!seg) continue;
    }
    const d = docs[docs.length - 1];
    if (d.response.length >= RESPONSE_CAP) continue;
    d.response = graphemeHead(d.response ? `${d.response} ${seg}` : seg, RESPONSE_CAP);
  }
}

/** Read `[from, size)` of a file as whole lines: a trailing partial line (a write in progress) is left
 *  for the next call. Returns the text and the byte offset the cursor may advance to. */
function readWholeLines(file: string, from: number, size: number): { text: string; upTo: number } {
  if (size <= from) return { text: '', upTo: from };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - from);
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    const end = buf.lastIndexOf(0x0a, got - 1);
    if (end < 0) return { text: '', upTo: from };
    return { text: buf.toString('utf8', 0, end + 1), upTo: from + end + 1 };
  } finally {
    fs.closeSync(fd);
  }
}

/** The session's index, current to the transcript's last complete line — read, extended from the
 *  cursor, or rebuilt. `built` says whether anything was (re)computed. */
export function sessionSearchIndex(cwd: string, session: string, knownTranscript?: string | null): { docs: Doc[]; built: boolean; transcript: string | null } {
  const transcript = knownTranscript !== undefined ? knownTranscript : findTranscript(cwd, session);
  if (!transcript) {
    // No transcript: the asks come from the drive sidecar / codex meta, answers are not recorded there.
    let asks: { ts: number; text: string }[] = [];
    try {
      asks = sessionPrompts(cwd, session);
    } catch {
      asks = [];
    }
    return { docs: asks.map((p) => ({ ts: p.ts, prompt: p.text, response: '' })), built: false, transcript: null };
  }
  let size = 0;
  try {
    size = fs.statSync(transcript).size;
  } catch {
    return { docs: [], built: false, transcript };
  }
  const prev = readIndex(session);
  const fresh = !prev || prev.transcript !== transcript || prev.bytes > size;
  const idx: SessionIndex = fresh ? { v: 5, transcript, bytes: 0, docs: [] } : prev!;
  if (idx.bytes === size) return { docs: idx.docs, built: false, transcript };
  // The per-message texts are rebuilt from nothing on an extension: an assistant message rarely
  // spans a write boundary, and a duplicated fragment costs a repeated sentence, not a wrong answer.
  const { text, upTo } = readWholeLines(transcript, idx.bytes, size);
  if (upTo === idx.bytes) return { docs: idx.docs, built: false, transcript };
  const prompts = new PromptReader(idx.prompts);
  foldSearchDocs(text, idx.docs, new Map(), prompts);
  idx.prompts = prompts.state();
  idx.bytes = upTo;
  writeIndex(session, idx);
  return { docs: idx.docs, built: true, transcript };
}

const SNIPPET_RADIUS = 70;

function snippetOf(text: string, term: string): string | null {
  const at = text.toLowerCase().indexOf(term);
  if (at < 0) return null;
  // Both ends where a character ends: an excerpt starting or stopping inside an emoji showed half of it.
  const from = graphemeHead(text, Math.max(0, at - SNIPPET_RADIUS)).length;
  const to = graphemeHead(text, Math.min(text.length, at + term.length + SNIPPET_RADIUS)).length;
  return `${from > 0 ? '…' : ''}${text.slice(from, to).replace(/\s+/g, ' ').trim()}${to < text.length ? '…' : ''}`;
}

function countOf(hay: string, term: string): number {
  let n = 0;
  let at = hay.indexOf(term);
  while (at >= 0) {
    n++;
    at = hay.indexOf(term, at + term.length);
  }
  return n;
}

/** Where a search finds a session's docs, and whether it (re)built anything to find them: the session's own search
 *  index (`sessionSearchIndex`), or the local index's prompts table (index/listing.ts). */
export type SearchDocsOf = (cwd: string, row: SearchCandidate) => { docs: SearchDoc[]; built: boolean };
const sidecarDocs: SearchDocsOf = (cwd, row) => sessionSearchIndex(cwd, row.id, row.transcript);

/** `perSession` keeps each session's best hit only, before the limit: one session with many matching
 *  asks then takes one row, not every row. `candidatesOf` names the sessions searched: this machine's
 *  (`searchCandidates`), or another machine's as the local index holds them (index/listing.ts). */
export function searchConversations(cwd: string, query: string, opts: { limit?: number; sinceMs?: number; perSession?: boolean } = {}, docsOf: SearchDocsOf = sidecarDocs,
  candidatesOf: () => SearchCandidate[] = searchCandidates): SearchResult {
  const t0 = Date.now();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const limit = Math.max(1, opts.limit ?? 50);
  if (!terms.length) return { query, terms, hits: [], matched: 0, sessions: 0, asks: 0, indexed: 0, ms: 0 };
  const rows = candidatesOf().filter((r) => opts.sinceMs === undefined || r.lastMs >= opts.sinceMs);
  type Scored = { row: SearchCandidate; doc: Doc; lp: string; lr: string };
  const all: Scored[] = [];
  let indexed = 0;
  for (const row of rows) {
    try {
      const { docs, built } = docsOf(cwd, row);
      if (built) indexed++;
      // A session with no recorded title reads as its first ask — the same fallback the listings use.
      if (!row.title && docs.length) row.title = graphemeHead(docs[0].prompt, 80);
      for (const doc of docs) all.push({ row, doc, lp: doc.prompt.toLowerCase(), lr: doc.response.toLowerCase() });
    } catch {
      /* an unreadable session contributes nothing */
    }
  }
  // Rarity per term across every ask, so a word every conversation uses ranks below a distinctive one.
  const idf = terms.map((term) => {
    const df = all.reduce((n, s) => n + (s.lp.includes(term) || s.lr.includes(term) ? 1 : 0), 0);
    return Math.log(1 + all.length / (1 + df));
  });
  const hits: SearchHit[] = [];
  for (const s of all) {
    let score = 0;
    let ok = true;
    for (let i = 0; i < terms.length; i++) {
      const inP = countOf(s.lp, terms[i]);
      const inR = countOf(s.lr, terms[i]);
      if (!inP && !inR) {
        ok = false;
        break;
      }
      score += (inP * 3 + Math.min(inR, 10)) * idf[i];
    }
    if (!ok) continue;
    const fromPrompt = snippetOf(s.doc.prompt, terms[0]);
    hits.push({
      session: s.row.id,
      title: s.row.title,
      workspace: s.row.workspace,
      agent: s.row.agent,
      ts: s.doc.ts,
      prompt: s.doc.prompt,
      snippet: fromPrompt ?? snippetOf(s.doc.response, terms[0]) ?? s.doc.prompt,
      where: fromPrompt ? 'prompt' : 'response',
      score,
    });
  }
  hits.sort((a, b) => b.score - a.score || b.ts - a.ts);
  const seen = new Set<string>();
  const ranked = opts.perSession ? hits.filter((h) => !seen.has(h.session) && !!seen.add(h.session)) : hits;
  return { query, terms, hits: ranked.slice(0, limit), matched: ranked.length, sessions: rows.length, asks: all.length, indexed, ms: Date.now() - t0 };
}
