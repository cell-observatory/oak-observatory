/**
 * Search every conversation on this machine: the asks you typed and the
 * prose the agent answered with, across sessions and workspaces, ranked — what memex does for herdr,
 * over the transcripts oak already reads.
 *
 * A PERSISTED, INCREMENTAL INDEX. This machine holds 600 MB of transcripts; reading them on every
 * search took 21 s (measured), and the in-memory file cache is cold in every fresh CLI process. So
 * each session keeps `search-index.json` in its store: the asks and their answers, built once and
 * then extended from a BYTE CURSOR — transcripts are append-only, so a live session's index grows by
 * exactly the lines written since, never by a re-read. A shrunk or replaced file rebuilds from zero.
 * A Codex session is read through its derived transcript, so its replies are searched too. Sessions with
 * no transcript at all (driven ACP-only, a Codex session whose rollout is gone) contribute their asks
 * alone — the sidecar carries the questions, not the answers — and say so through `where`.
 *
 * Ranking: every term must appear (AND), a hit in the ASK outranks one in the answer, a rarer term
 * counts for more, and ties go to the newer ask. Read-only over the transcripts; the index is the
 * only thing written, and only its owner's session dir.
 */
import * as fs from 'fs';
import * as path from 'path';
import { findTranscript, fastSessionTitle } from './observe';
import { sessionPrompts } from './prompts';
import { storeDir, logPath, allStoreSessionIds, hiddenSessions, isSafeSessionId } from './store';
import { listWorkspaces, sessionWorkspace, isMirroredTranscript, isBridgePointer, workspaceLabel } from './session';
import { readCodexAgentMeta, findCodexRollout, codexSessionTitle, codexSessionSources } from './codex';
import { codexTranscriptFile } from './codex-events';
import { userPrompt, toMs } from './asks';

/** A session the search consults: where its transcript is (a Codex one's derived transcript; null when
 *  there is none, and the asks come from the sidecar), and the little a hit needs to show. Enumerated
 *  HERE, not through `sessionMeta`: that listing also counts every session's pending edits, and for a
 *  live session with hundreds of captured edits that is ~14 s of scope detection whenever its
 *  transcript has grown (measured on a 97 MB transcript, 2026-09-15) — a cost a search must never pay. */
interface Candidate {
  id: string;
  transcript: string | null;
  workspace: string;
  title: string | null;
  agent: string;
  lastMs: number;
}

function candidateSessions(): Candidate[] {
  const hidden = hiddenSessions();
  const out = new Map<string, Candidate>();
  const excluded = new Set<string>();
  for (const w of listWorkspaces()) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(w.dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const id = n.slice(0, -6);
      if (!isSafeSessionId(id) || out.has(id) || hidden.has(id)) continue;
      const file = path.join(w.dir, n);
      const provenance = isMirroredTranscript(file);
      if (provenance.mirrored || isBridgePointer(file)) { excluded.add(id); continue; }
      let lastMs = 0;
      try {
        lastMs = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      let title: string | null = null;
      try {
        title = fastSessionTitle(file, id);
      } catch {
        title = null;
      }
      out.set(id, { id, transcript: file, workspace: provenance.recordedCwd ? workspaceLabel(provenance.recordedCwd) : w.label, title, agent: readCodexAgentMeta(id) ? 'codex' : 'claude', lastMs });
    }
  }
  // Codex conversations, from the same rollouts the session lists show, read through the derived
  // transcript so the replies are searched as well as the asks. Newest first, so an archived copy loses.
  for (const source of codexSessionSources()) {
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
  /** Sessions consulted / asks scored / sessions whose index was (re)built this call. */
  sessions: number;
  asks: number;
  indexed: number;
  ms: number;
}

interface Doc {
  ts: number;
  prompt: string;
  response: string;
}

interface SessionIndex {
  /** 2: pasted prompts (`<pasted_content>`) are asks (2026-09-22); a v1 index folded past them. */
  v: 3;
  transcript: string;
  /** Bytes of the transcript already folded into `docs` (always at a line boundary). */
  bytes: number;
  docs: Doc[];
}

/** Searchable prefix per answer, and per ask — an index that mirrored a 200 KB answer per turn would
 *  outgrow the transcript it came from. */
const RESPONSE_CAP = 32 * 1024;
const PROMPT_CAP = 8 * 1024;

function indexPath(session: string): string {
  // Versioned NAME: an older build still running beside this one keeps its own index.
  return path.join(storeDir(session), 'search-index-v3.json');
}

function readIndex(session: string): SessionIndex | null {
  try {
    const j = JSON.parse(fs.readFileSync(indexPath(session), 'utf8')) as SessionIndex;
    if (!j || j.v !== 3 || typeof j.transcript !== 'string' || typeof j.bytes !== 'number' || !Array.isArray(j.docs)) return null;
    return j;
  } catch {
    return null;
  }
}

function writeIndex(session: string, idx: SessionIndex): void {
  try {
    const dir = storeDir(session);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${indexPath(session)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(idx), { mode: 0o600 });
    fs.renameSync(tmp, indexPath(session));
  } catch {
    /* an unwritable index means the next search rebuilds — never a failed search */
  }
}

/** Fold `text` (whole lines of the transcript) into `docs`: an ask opens a doc, assistant prose joins
 *  the newest one. Returns nothing; mutates `docs`. */
function fold(text: string, docs: Doc[], seen: Set<string>): void {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o: { message?: { role?: string; id?: string; content?: unknown }; isSidechain?: boolean; timestamp?: unknown; ts?: unknown };
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const ask = userPrompt(o);
    if (ask !== null) {
      docs.push({ ts: toMs(o.timestamp ?? o.ts), prompt: ask.length > PROMPT_CAP ? ask.slice(0, PROMPT_CAP) : ask, response: '' });
      continue;
    }
    const msg = o.message;
    if (!msg || msg.role !== 'assistant' || o.isSidechain === true || !docs.length) continue;
    if (typeof msg.id === 'string') {
      if (seen.has(msg.id)) continue; // one message split across lines shares its id — fold once
      seen.add(msg.id);
    }
    const parts: string[] = [];
    if (typeof msg.content === 'string') parts.push(msg.content);
    else if (Array.isArray(msg.content)) {
      for (const b of msg.content as { type?: string; text?: string }[]) if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
    const seg = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (!seg) continue;
    const d = docs[docs.length - 1];
    if (d.response.length >= RESPONSE_CAP) continue;
    d.response = (d.response ? `${d.response} ${seg}` : seg).slice(0, RESPONSE_CAP);
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
  const idx: SessionIndex = fresh ? { v: 3, transcript, bytes: 0, docs: [] } : prev!;
  if (idx.bytes === size) return { docs: idx.docs, built: false, transcript };
  // The message-id dedup set is rebuilt from nothing on an extension: an assistant message never
  // spans a write boundary in practice, and a duplicated fragment costs a repeated sentence, not a
  // wrong answer.
  const { text, upTo } = readWholeLines(transcript, idx.bytes, size);
  if (upTo === idx.bytes) return { docs: idx.docs, built: false, transcript };
  fold(text, idx.docs, new Set());
  idx.bytes = upTo;
  writeIndex(session, idx);
  return { docs: idx.docs, built: true, transcript };
}

const SNIPPET_RADIUS = 70;

function snippetOf(text: string, term: string): string | null {
  const at = text.toLowerCase().indexOf(term);
  if (at < 0) return null;
  const from = Math.max(0, at - SNIPPET_RADIUS);
  const to = Math.min(text.length, at + term.length + SNIPPET_RADIUS);
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

export function searchConversations(cwd: string, query: string, opts: { limit?: number; sinceMs?: number } = {}): SearchResult {
  const t0 = Date.now();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const limit = Math.max(1, opts.limit ?? 50);
  if (!terms.length) return { query, terms, hits: [], sessions: 0, asks: 0, indexed: 0, ms: 0 };
  const rows = candidateSessions().filter((r) => opts.sinceMs === undefined || r.lastMs >= opts.sinceMs);
  type Scored = { row: Candidate; doc: Doc; lp: string; lr: string };
  const all: Scored[] = [];
  let indexed = 0;
  for (const row of rows) {
    try {
      const { docs, built } = sessionSearchIndex(cwd, row.id, row.transcript);
      if (built) indexed++;
      // A session with no recorded title reads as its first ask — the same fallback the listings use.
      if (!row.title && docs.length) row.title = docs[0].prompt.length > 80 ? docs[0].prompt.slice(0, 80) : docs[0].prompt;
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
  return { query, terms, hits: hits.slice(0, limit), sessions: rows.length, asks: all.length, indexed, ms: Date.now() - t0 };
}
