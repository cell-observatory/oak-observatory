/**
 * The user's asks, read from a session transcript — the one place that decides what counts as a turn.
 *
 * This lives below the grouping layer on purpose. Review units are bounded by the ask that produced
 * them (see `units.ts`), and `prompts.ts` builds the prompt axis from the same scan; putting the scan
 * in `prompts.ts` would have meant `units.ts` importing it, and `prompts.ts` imports the grouping layer
 * — a cycle. One scan, memoized against the transcript, two consumers, no drift about what a turn is.
 */
import * as fs from 'fs';
import * as path from 'path';
import { claudeConfigDir } from './paths';
import { cachedByFiles } from './fscache';
import { isSafeSessionId, logPath, rootDir } from './store';

/**
 * Is this transcript record a REAL user prompt?
 *
 * The transcript is full of records that wear the user's role without being anything the user typed:
 * tool results, `<command-name>` / `<local-command-stdout>` wrappers from slash commands, injected
 * system reminders, the synthesized summary after a compaction, and the harness's own queue records.
 * Counting any of them would invent turns the person never took.
 */
export function userPrompt(o: any): string | null {
  if (!o || o.isSidechain === true || o.isCompactSummary === true || o.isMeta === true) return null;
  const msg = o.message;
  if (!msg || msg.role !== 'user') return null;
  const clean = personPromptOf(msg);
  return clean === null ? null : clean.replace(/\s+/g, ' ');
}

/**
 * The person's words in a user message, or null: a string body, or the FIRST text block that is the
 * person's — not the first text block there is. An editor prepends its own blocks (VS Code sends
 * `[<ide_opened_file>…, the typed prompt]`), and reading only the first one dropped those prompts
 * A turn made only of tool_results is the harness, not a person.
 */
export function personPromptOf(msg: any): string | null {
  if (!msg) return null;
  if (typeof msg.content === 'string') return personPromptText(msg.content);
  if (!Array.isArray(msg.content)) return null;
  for (const b of msg.content) {
    if (!b || b.type !== 'text' || typeof b.text !== 'string') continue;
    const clean = personPromptText(b.text);
    if (clean !== null) return clean;
  }
  return null;
}

/**
 * The person's words in a user record's text, or null when the record is the harness talking:
 * `<command-name>`, `<local-command-stdout>`, `<system-reminder>`, `<task-notification>` … all open
 * with a tag, and "Caveat:" is the harness's own preamble to a command's output. Text the person
 * PASTED arrives wrapped — `<pasted_content id="…">…</pasted_content id="…">` — so a prompt that was
 * nothing but a paste opened with a tag too and was dropped as harness noise (2026-09-22: a session
 * whose only prompt was pasted showed no prompts, no asks and no user turn on any surface). The
 * wrapper is the harness's; the words inside are the person's — whatever they start with, an HTML
 * snippet included. The tag rule is judged on the record BEFORE unwrapping, so it sees the harness's
 * tags and the paste wrapper, never the paste's own first character. Trimmed; whitespace inside is
 * the caller's business (titles normalize it, asks collapse it).
 */
export function personPromptText(text: string): string | null {
  const raw = text.trim();
  if (!raw) return null;
  const pasted = raw.startsWith('<pasted_content');
  if (!pasted && (raw.startsWith('<') || /^caveat:/i.test(raw))) return null;
  const clean = unwrapPastedContent(raw).trim();
  return clean ? clean : null;
}

/** The wrapper around pasted text removed, its contents kept in place. Attribute runs are bounded
 *  so a record full of unclosed openers cannot make the match quadratic. */
export function unwrapPastedContent(text: string): string {
  if (!text.includes('<pasted_content')) return text;
  // The closing tag repeats the opener's attributes (`</pasted_content id="358a">`); requiring the same
  // ones keeps a paste that merely CONTAINS the literal `</pasted_content>` intact.
  return text.replace(/<pasted_content\b([^>]{0,256})>([\s\S]*?)<\/pasted_content\1>/g, '$2');
}

/** A finite number, or 0 — for token-usage fields that may be absent/malformed. */
export function num(v: unknown): number {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

/** ISO/epoch → ms epoch, 0 when absent. */
export function toMs(v: unknown): number {
  if (typeof v === 'number' && isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  return 0;
}

/** Phase 1 of the prompt views — the asks and the per-moment assistant token usage — memoized on the
 *  TRANSCRIPT alone. Everything else the prompt views derive is keyed on the log too, so before this
 *  split a keep click (a log-only change) re-read and re-parsed the whole transcript to recover facts
 *  that had not moved: ~60ms per click at 10MB, growing linearly with the conversation. */
type Ask = { ts: number; text: string; id?: string };
type TokenAt = { ts: number; tokens: number };

export function askScan(transcript: string): { asks: Ask[]; tokenAt: TokenAt[] } {
  return cachedByFiles('promptAsks', [transcript], () => scanTranscript(transcript));
}

/**
 * The persisted scan state, so a transcript that only GREW is read from where the last scan stopped.
 *
 * MEASURED 2026-09-16: a 97 MB transcript was re-read in full on every listing while the agent worked
 * — 780 ms of a 2 s `oak sessions --json`, for a handful of new lines. Keyed by the transcript's own
 * basename (the session id for a Claude transcript; any other file is not persisted and scans in full,
 * as before). `head` re-checks the file's first bytes: a transcript is append-only, and a file that was
 * rewritten from the start must not be resumed mid-way. Only COMPLETE lines advance the cursor; an
 * unterminated tail is scanned for this answer and read again next time, so a record still being
 * appended is never half-parsed into the persisted state.
 */
// 2: pasted prompts (`<pasted_content>`) became asks (2026-09-22); a cursor that already passed one
// would never scan it again. 3: a paste whose contents open with `<` counts too.
const ASKS_CACHE_VERSION = 3;
const HEAD_BYTES = 64;
interface AskCache {
  version: number;
  transcript: string;
  cursor: number;
  head: string;
  asks: Ask[];
  tokenAt: TokenAt[];
  seen: string[];
}

function asksCachePath(transcript: string): { file: string; sid: string } | null {
  const sid = path.basename(transcript).replace(/\.jsonl$/, '');
  if (!isSafeSessionId(sid)) return null;
  // The version is in the NAME: an older build still running beside this one (an editor window not
  // yet reloaded) keeps its own file instead of the two rewriting one file at each other's version
  // on every append.
  return { file: path.join(rootDir(), 'changemap-cache', sid, `asks-v${ASKS_CACHE_VERSION}.json`), sid };
}

/** One chunk of transcript lines into the running result. The asks themselves — and, in the SAME
 *  pass, the assistant token usage per moment (the bytes are already in hand, so tokens cost no extra
 *  IO). One assistant message can span several lines that share a message.id and repeat the usage;
 *  count each id once, exactly as the Stats cursor does. */
function scanChunk(text: string, asks: Ask[], tokenAt: TokenAt[], seenMsg: Set<string>): void {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const msg = o.message;
    if (msg && msg.role === 'assistant' && o.isSidechain !== true && msg.usage && typeof msg.id === 'string' && !seenMsg.has(msg.id)) {
      seenMsg.add(msg.id);
      const u = msg.usage;
      // NEW tokens only. Adding the cache counters made the same context count once per turn,
      // so this row reported millions where Claude Code's own view reported ~128k for the very
      // same agent. Two tools reporting different numbers for one run is worse than either being
      // slightly off — the reader cannot tell which to trust. Cache traffic is surfaced
      // separately (SessionTokens.cacheRead/cacheCreation), never folded in here.
      const tk = num(u.input_tokens) + num(u.output_tokens) + num(u.cache_creation_input_tokens);
      const ts = toMs(o.timestamp ?? o.ts);
      if (ts && tk) tokenAt.push({ ts, tokens: tk });
    }
    const text2 = userPrompt(o);
    if (text2 === null) continue;
    const ts = toMs(o.timestamp ?? o.ts);
    if (!ts) continue; // an undated ask cannot own a window
    asks.push({ ts, text: text2, ...(o.runtime === 'codex' && o.nativeTurnId ? { id: o.nativeTurnId } : {}) });
  }
}

function scanTranscript(transcript: string): { asks: Ask[]; tokenAt: TokenAt[] } {
  let st: fs.Stats;
  try {
    st = fs.statSync(transcript);
  } catch {
    return { asks: [], tokenAt: [] };
  }
  const where = asksCachePath(transcript);
  let cache: AskCache | null = null;
  if (where) {
    try {
      const j = JSON.parse(fs.readFileSync(where.file, 'utf8')) as AskCache;
      if (
        j && j.version === ASKS_CACHE_VERSION && j.transcript === transcript && Number.isInteger(j.cursor) && j.cursor >= 0 && j.cursor <= st.size &&
        typeof j.head === 'string' && Array.isArray(j.asks) && Array.isArray(j.tokenAt) && Array.isArray(j.seen)
      ) cache = j;
    } catch {
      /* absent, unreadable, another version — scan from the start */
    }
  }
  let fd: number;
  try {
    fd = fs.openSync(transcript, 'r');
  } catch {
    return { asks: [], tokenAt: [] };
  }
  try {
    const headBuf = Buffer.alloc(Math.min(HEAD_BYTES, st.size));
    if (headBuf.length) fs.readSync(fd, headBuf, 0, headBuf.length, 0);
    const head = headBuf.toString('base64');
    if (cache && cache.head !== head) cache = null;
    const from = cache ? cache.cursor : 0;
    const len = st.size - from;
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    const lastNl = got > 0 ? buf.lastIndexOf(0x0a, got - 1) : -1;
    const completeEnd = lastNl >= 0 ? lastNl + 1 : 0;
    const seen = new Set<string>(cache ? cache.seen : []);
    const asks = cache ? cache.asks.slice() : [];
    const tokenAt = cache ? cache.tokenAt.slice() : [];
    if (completeEnd > 0) scanChunk(buf.subarray(0, completeEnd).toString('utf8'), asks, tokenAt, seen);
    // Persist the complete-line prefix — beside a store that exists (a dropped session is never
    // resurrected, the rule every derived file follows), and only when something moved.
    if (where && (cache === null || completeEnd > 0) && fs.existsSync(logPath(where.sid))) {
      try {
        fs.mkdirSync(path.dirname(where.file), { recursive: true, mode: 0o700 });
        const tmp = `${where.file}.${process.pid}.tmp`;
        const rec: AskCache = { version: ASKS_CACHE_VERSION, transcript, cursor: from + completeEnd, head, asks, tokenAt, seen: [...seen] };
        fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
        fs.renameSync(tmp, where.file);
      } catch {
        /* best effort — a cache that cannot be written costs a re-read next time, never an error */
      }
    }
    // The unterminated tail: part of THIS answer, never of the persisted state.
    const outAsks = asks.slice();
    const outTok = tokenAt.slice();
    if (got > completeEnd) scanChunk(buf.subarray(completeEnd, got).toString('utf8'), outAsks, outTok, new Set(seen));
    outAsks.sort((a, b) => a.ts - b.ts);
    return { asks: outAsks, tokenAt: outTok };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

/** Resolved transcript paths, keyed by config dir + session. Positives only: a found transcript never
 *  moves, but a miss must re-scan because a store is sometimes seeded before its first ask lands. The
 *  config dir is part of the key because tests swap HOME mid-process. */
const transcriptPathMemo = new Map<string, string>();

/**
 * This session's transcript, found from the SESSION ID alone.
 *
 * `findTranscript` walks up from a cwd, which the grouping layer does not have — `pendingGroups(session)`
 * is called from every surface, several of them with no workspace in hand. Session ids are UUIDs, so a
 * scan of the project folders resolves one unambiguously.
 *
 * Exported so the unit memos can stamp the transcript file alongside the log: the unit split depends on
 * ask boundaries, so a new ask with no accompanying edit must invalidate it too. That puts this scan on
 * the warm path of every refresh — hence the positive cache above.
 */
export function transcriptForSession(sessionId: string): string | null {
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(sessionId)) return null;
  const { findCodexRollout } = require('./codex') as typeof import('./codex');
  const raw = findCodexRollout(sessionId);
  if (raw) return (require('./codex-events') as typeof import('./codex-events')).codexTranscriptFile(raw);
  const base = path.join(claudeConfigDir(), 'projects');
  const memoKey = `${base}|${sessionId}`;
  const hit = transcriptPathMemo.get(memoKey);
  if (hit) return hit;
  let names: string[];
  try {
    names = fs.readdirSync(base);
  } catch {
    return null;
  }
  for (const slug of names) {
    const p = path.join(base, slug, `${sessionId}.jsonl`);
    try {
      if (fs.statSync(p).isFile()) {
        transcriptPathMemo.set(memoKey, p);
        return p;
      }
    } catch {
      /* not this project folder */
    }
  }
  return null;
}

/**
 * The ask timestamps that bound this session's turns, ascending.
 *
 * Empty when there is no transcript — a store read with no conversation beside it (a test fixture, a
 * copied store, another machine's session). Callers must treat empty as "one unbounded window" rather
 * than "no asks", because the alternative is refusing to group anything at all.
 */
export function askBoundaries(sessionId: string): number[] {
  const transcript = transcriptForSession(sessionId);
  if (!transcript) return [];
  return cachedByFiles('askBoundaries', [transcript], () => askScan(transcript).asks.map((a) => a.ts));
}

/** Which turn a moment belongs to: the index of the newest ask at or before `ts`, or -1 before the
 *  first ask. `-1` is a real answer — work that predates every ask belongs to no turn. */
export function windowOf(boundaries: number[], ts: number): number {
  if (!boundaries.length || !ts || ts < boundaries[0]) return -1;
  let lo = 0;
  let hi = boundaries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (boundaries[mid] <= ts) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
