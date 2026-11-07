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
export function userPrompt(o: any, collapseWhitespace = true): string | null {
  if (!o || o.type === 'api-request-blob' || o.isSidechain === true || o.isCompactSummary === true || o.isMeta === true) return null;
  const a = o.type === 'attachment' ? o.attachment : null;
  if (a?.type === 'queued_command') {
    if (a.isMeta === true || a.commandMode !== 'prompt' || a.origin?.kind === 'peer' ||
      a.origin?.kind === 'task-notification' || (a.origin?.kind !== 'human' && a.humanTurn !== true)) return null;
    const text = typeof a.prompt === 'string' ? a.prompt.trim() : '';
    return text ? (collapseWhitespace ? text.replace(/\s+/g, ' ') : text) : null;
  }
  const msg = o.message;
  if (!msg || msg.role !== 'user') return null;
  const clean = personPromptOf(msg);
  return clean === null ? null : collapseWhitespace ? clean.replace(/\s+/g, ' ') : clean;
}

/** Delivery identities survive append cursors; words and times are never deduplication keys. */
export interface PromptReaderState { links: [string, string][]; seen: string[] }
export class PromptReader {
  private links: Map<string, string>;
  private seen: Set<string>;
  constructor(state?: PromptReaderState) {
    this.links = new Map(state?.links);
    this.seen = new Set(state?.seen);
  }
  state(): PromptReaderState { return { links: [...this.links], seen: [...this.seen] }; }
  private root(id: string): string {
    const next = this.links.get(id);
    if (!next || next === id) return id;
    const root = this.root(next);
    this.links.set(id, root);
    return root;
  }
  read(o: any): string | null {
    if (!o || o.type === 'api-request-blob' || o.isSidechain === true) return null;
    const text = userPrompt(o);
    const removal = o.type === 'queue-operation' && o.operation === 'remove';
    if (text === null && !removal) return null;
    const a = o.attachment;
    const ids = (removal ? [o.commandUuid, o.deliveryId]
      : o.runtime === 'codex' ? [o.message?.id]
      : a?.type === 'queued_command' ? [a.source_uuid, a.delivery_id, o.uuid]
      : [o.uuid, o.promptId]).filter((id): id is string => typeof id === 'string' && !!id);
    const roots = ids.map(id => this.root(id));
    const duplicate = roots.some(id => this.seen.has(id));
    const root = roots[0];
    if (root) {
      for (const id of roots) { this.links.set(id, root); this.seen.delete(id); }
      if (duplicate || text !== null) this.seen.add(root);
    }
    return duplicate ? null : text;
  }
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

/** The wrapper around pasted text removed, its contents kept in place. The same result as replacing
 *  `/<pasted_content\b([^>]{0,256})>([\s\S]*?)<\/pasted_content\1>/g` with `$2`, found by a scan: that
 *  regex rescanned the rest of the text for each unclosed opener, quadratic in a record full of them. */
export function unwrapPastedContent(text: string): string {
  const OPEN = '<pasted_content', CLOSE = '</pasted_content';
  if (!text.includes(OPEN)) return text;
  // The closing tag repeats the opener's attributes (`</pasted_content id="358a">`); requiring the same
  // ones keeps a paste that merely CONTAINS the literal `</pasted_content>` intact. Every closer is
  // indexed once by its attributes, so each opener finds its own in one lookup.
  // The first `>` after a tag name is remembered while it still lies ahead: a run of tags with no `>`
  // between them would otherwise search the same stretch once per tag.
  let gt = -1;
  const closers = new Map<string, number[]>();
  for (let at = text.indexOf(CLOSE); at >= 0; at = text.indexOf(CLOSE, at + 1)) {
    if (gt < at + CLOSE.length) gt = text.indexOf('>', at + CLOSE.length);
    if (gt < 0) break;
    if (gt - at - CLOSE.length > 256) continue; // longer than any opener's attributes can be
    const attrs = text.slice(at + CLOSE.length, gt);
    const list = closers.get(attrs);
    if (list) list.push(at); else closers.set(attrs, [at]);
  }
  const next = new Map<string, number>(); // per attribute run, the first closer not yet passed
  let out = '';
  let done = 0;
  gt = -1;
  for (let at = text.indexOf(OPEN); at >= 0; at = text.indexOf(OPEN, at + 1)) {
    if (at < done || /\w/.test(text[at + OPEN.length] ?? '')) continue; // `\b`: `<pasted_contents` is not one
    if (gt < at + OPEN.length) gt = text.indexOf('>', at + OPEN.length);
    if (gt < 0) break;
    if (gt - at - OPEN.length > 256) continue;
    const attrs = text.slice(at + OPEN.length, gt);
    const list = closers.get(attrs);
    if (!list) continue;
    let i = next.get(attrs) ?? 0;
    while (i < list.length && list[i] <= gt) i++;
    next.set(attrs, i);
    if (i === list.length) continue;
    out += text.slice(done, at) + text.slice(gt + 1, list[i]);
    done = list[i] + CLOSE.length + attrs.length + 1;
  }
  return done ? out + text.slice(done) : text;
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
type Ask = { ts: number; text: string; id?: string; nativeTurnId?: string };
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
// would never scan it again. 3: a paste whose contents open with `<` counts too. 4: a message's tokens
// are its largest snapshot's, and `seen` carries what each id counted and where. In the file NAME too, so `oak clean`
// removes the names of the versions before (changemap.ts, pruneSupersededCaches).
// Human queued deliveries are asks; replay blobs and meta notes are not.
export const ASKS_CACHE_VERSION = 5;
const HEAD_BYTES = 64;
interface AskCache {
  version: number;
  transcript: string;
  cursor: number;
  head: string;
  asks: Ask[];
  tokenAt: TokenAt[];
  /** Each message id counted: [its tokens as counted, the index of its tokenAt entry, or -1 for none]. */
  seen: [string, number, number][];
  prompts: PromptReaderState;
}

/** What scanChunk keeps per message id counted: its tokens as counted, and its tokenAt entry (-1: none). */
type SeenMsg = Map<string, [number, number]>;

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
 *  IO). One assistant message can span several lines that share a message.id, each with the usage as
 *  it stood when the line was written (a later one can carry more output, never less); count each id
 *  once, at its largest snapshot, exactly as the Stats cursor does: a larger one replaces the tokens
 *  of the moment the message was counted at. */
function scanChunk(text: string, asks: Ask[], tokenAt: TokenAt[], seenMsg: SeenMsg, prompts: PromptReader): void {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (o?.type === 'api-request-blob') continue;
    const msg = o?.message;
    if (msg && msg.role === 'assistant' && o.isSidechain !== true && msg.usage && typeof msg.id === 'string') {
      const u = msg.usage;
      // NEW tokens only. Adding the cache counters made the same context count once per turn,
      // so this row reported millions where Claude Code's own view reported ~128k for the very
      // same agent. Two tools reporting different numbers for one run is worse than either being
      // slightly off — the reader cannot tell which to trust. Cache traffic is surfaced
      // separately (SessionTokens.cacheRead/cacheCreation), never folded in here.
      const tk = num(u.input_tokens) + num(u.output_tokens) + num(u.cache_creation_input_tokens);
      const prev = seenMsg.get(msg.id);
      if (!prev || tk > prev[0]) {
        let at = prev ? prev[1] : -1;
        const ts = toMs(o.timestamp ?? o.ts);
        // A new object, never the counted one changed in place: the unterminated tail is scanned into a copy.
        if (at >= 0) tokenAt[at] = { ...tokenAt[at], tokens: tk };
        else if (ts && tk) at = tokenAt.push({ ts, tokens: tk }) - 1;
        seenMsg.set(msg.id, [tk, at]);
      }
    }
    const text2 = prompts.read(o);
    if (text2 === null) continue;
    const ts = toMs(o.timestamp ?? o.ts);
    if (!ts) continue; // an undated ask cannot own a window
    asks.push({ ts, text: text2, ...(o.runtime === 'codex' && o.nativeTurnId ? { id: o.promptId || o.nativeTurnId, nativeTurnId: o.nativeTurnId } : {}) });
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
    const asks = cache ? cache.asks.slice() : [];
    const tokenAt = cache ? cache.tokenAt.slice() : [];
    const seen: SeenMsg = new Map((cache ? cache.seen : []).filter(Array.isArray)
      .map(([id, tk, at]): [string, [number, number]] => [String(id), [num(tk), Number.isInteger(at) && at >= 0 && at < tokenAt.length ? at : -1]]));
    const prompts = new PromptReader(cache?.prompts);
    if (completeEnd > 0) scanChunk(buf.subarray(0, completeEnd).toString('utf8'), asks, tokenAt, seen, prompts);
    // Persist the complete-line prefix — beside a store that exists (a dropped session is never
    // resurrected, the rule every derived file follows), and only when something moved.
    if (where && (cache === null || completeEnd > 0) && fs.existsSync(logPath(where.sid))) {
      try {
        fs.mkdirSync(path.dirname(where.file), { recursive: true, mode: 0o700 });
        const tmp = `${where.file}.${process.pid}.tmp`;
        const rec: AskCache = { version: ASKS_CACHE_VERSION, transcript, cursor: from + completeEnd, head, asks, tokenAt, prompts: prompts.state(), seen: [...seen].map(([id, [tk, at]]): [string, number, number] => [id, tk, at]) };
        fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
        fs.renameSync(tmp, where.file);
      } catch {
        /* best effort — a cache that cannot be written costs a re-read next time, never an error */
      }
    }
    // The unterminated tail: part of THIS answer, never of the persisted state.
    const outAsks = asks.slice();
    const outTok = tokenAt.slice();
    if (got > completeEnd) scanChunk(buf.subarray(completeEnd, got).toString('utf8'), outAsks, outTok, new Map(seen), new PromptReader(prompts.state()));
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
