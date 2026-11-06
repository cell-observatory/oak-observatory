/**
 * Usage stats (edits, tokens, messages, thinking, output) over time — for the sidebar "Stats" tab.
 *
 * Transcripts total ~GBs, so a full rescan every refresh is out. We keep an incremental cache keyed by
 * each file's (mtime, size): unchanged files reuse their cached per-day aggregates, only changed/new
 * files are re-parsed. (mtime+size is the standard freshness heuristic — a same-size rewrite within
 * one mtime tick would be missed, which is acceptable for append-only transcripts.) Still meant to run
 * in a SUBPROCESS (the CLI `stats` command) so the first, expensive scan never blocks the extension host.
 *
 * Scope: main-chain transcripts only (~/.claude/projects/<proj>/<session>.jsonl). Subagent/sidechain
 * transcripts live under <proj>/<session>/subagents/*.jsonl and are intentionally NOT counted — their
 * assistant turns each carry a full usage block (huge cache reads) that would swamp the main-chain
 * numbers, and "messages" is meant to count the turns the user actually saw.
 */
import * as fs from 'fs';
import * as path from 'path';
import { listSessions, readLog, rootDir } from './store';
import { claudeConfigDir } from './paths';

export interface StatMetrics {
  edits: number;
  tokens: number; // input(+cache) + output
  messages: number; // assistant turns
  thinking: number; // estimated from thinking-block text (~chars/4)
  output: number; // exact output tokens
}
/** A chart bucket: edits split by current (folded) status + tokens split into input/output. */
export interface BucketStat {
  editsPending: number;
  editsKept: number;
  editsUndone: number;
  tokensInput: number; // input + cache (read + creation)
  tokensOutput: number; // exact output tokens
  messages: number;
  thinking: number;
}
export interface DayStat extends BucketStat {
  day: string; // YYYY-MM-DD (local)
}
export interface HourStat extends BucketStat {
  hour: number; // 0–23 (local), for today
}
export interface StatsResult {
  usageSource?: 'database' | 'local';
  daily: DayStat[]; // last 30 days, oldest → newest
  hourly: HourStat[]; // today, 24 local-hour buckets
  windows: { session: StatMetrics; day: StatMetrics; week: StatMetrics; month: StatMetrics };
  generatedAt: number;
}

interface DayAgg {
  msgs: number;
  out: number;
  think: number;
  inTok: number;
}
interface FileEntry {
  mtime: number;
  size: number;
  sid: string;
  days: Record<string, DayAgg>;
  /** Today's per-hour aggregates, cached alongside the days so an unchanged file modified today is
   *  not re-read on every refresh (today's files are the largest). Stale-day entries are pruned. */
  hourly?: { day: string; hours: Record<string, DayAgg> };
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Usage fields must be finite numbers — a malformed transcript line must not poison the sums
 *  (e.g. a string value would turn every subsequent `+=` into string concatenation). */
function num(v: unknown): number {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

const ZERO = (): StatMetrics => ({ edits: 0, tokens: 0, messages: 0, thinking: 0, output: 0 });

/** Bump when parseTranscript's aggregation changes so stale per-file caches (with the old, wrong
 *  numbers) are discarded instead of reused by their unchanged (mtime,size) key. 3: each message's
 *  tokens are its largest snapshot's, not its first's; and the first version in the cache's NAME. */
const CACHE_VERSION = 4;

/** The Stats cache, named by its version: an older build still running beside this one (an editor
 *  window not yet reloaded) keeps its own file. Kept in one, each build discarded the other's as
 *  another version's and parsed every transcript of the month again, at every `oak stats`, for as long
 *  as the old window stayed open. store.ts's rebuiltAtRoot knows these names, of any version, so a store
 *  move treats them as the caches they are. */
function statsCachePath(claudeOnly: boolean): string {
  return path.join(rootDir(), `stats-cache${claudeOnly ? '-claude' : ''}-v${CACHE_VERSION}.json`);
}

/** `oak clean`: remove the Stats caches of an earlier version, which nothing in this build reads — the
 *  ones named without a version (`stats-cache.json`, `stats-cache-claude.json`) and any `-v<N>` below
 *  CACHE_VERSION. Never this build's own, nor a newer build's. An older build still running writes its
 *  own again, and the next clean takes it again. */
export function pruneStaleStatsCaches(): { removed: number; bytes: number } {
  const out = { removed: 0, bytes: 0 };
  const root = rootDir();
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return out; // no store yet
  }
  for (const n of names) {
    const m = /^stats-cache(?:-claude)?(?:-v(\d+))?\.json$/.exec(n);
    if (!m || (m[1] !== undefined && Number(m[1]) >= CACHE_VERSION)) continue;
    const p = path.join(root, n);
    try {
      const size = fs.statSync(p).size;
      fs.rmSync(p, { force: true });
      out.removed++;
      out.bytes += size;
    } catch {
      /* gone meanwhile */
    }
  }
  return out;
}

/** Parse one transcript into per-day aggregates (assistant turns only), plus per-hour aggregates
 *  for messages timestamped on `hourlyDay` (pass null to skip the hourly pass). */
function parseTranscript(
  file: string,
  hourlyDay: string | null
): { sid: string; days: Record<string, DayAgg>; hours: Record<string, DayAgg> } {
  const days: Record<string, DayAgg> = {};
  const hours: Record<string, DayAgg> = {};
  let sid = path.basename(file).replace(/\.jsonl$/, '');
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return { sid, days, hours };
  }
  // Current Claude Code splits one logical assistant message into one JSONL line PER content block
  // (thinking / text / tool_use …), each stamped with the SAME message.id and the usage block as it
  // stood when that line was written: a later line can carry more output than the first, never less.
  // Count each message's turn exactly once (first line seen for that id) and its usage once, at its
  // LARGEST snapshot (input + output + cache creation, the status line's rule) — otherwise a 3-block
  // message triples its tokens/messages, and the first line alone misses what the later ones add. A
  // larger snapshot replaces the counted one in the buckets the message was counted in. `thinking`
  // still accrues from every line, since each thinking block lands on its own line.
  const counted = new Map<string, { d: DayAgg; h: DayAgg | null; out: number; inTok: number; unit: number }>();
  for (const line of content.split('\n')) {
    if (!line || line.indexOf('"assistant"') === -1) continue; // fast filter before JSON.parse
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.type === 'api-request-blob') continue;
    const m = o.message;
    if (!m || m.role !== 'assistant') continue;
    // Legacy transcripts inline sidechain (subagent) turns with isSidechain:true; current Claude Code
    // writes them to separate subagents/*.jsonl files. Either way they are out of scope here.
    if (o.isSidechain === true) continue;
    if (typeof o.sessionId === 'string') sid = o.sessionId;
    const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (isNaN(ts)) continue;
    const key = dayKey(ts);
    let d = days[key];
    if (!d) {
      d = { msgs: 0, out: 0, think: 0, inTok: 0 };
      days[key] = d;
    }
    let h: DayAgg | null = null;
    if (hourlyDay !== null && key === hourlyDay) {
      const hk = String(new Date(ts).getHours());
      h = hours[hk];
      if (!h) {
        h = { msgs: 0, out: 0, think: 0, inTok: 0 };
        hours[hk] = h;
      }
    }
    // First line for this message.id counts the turn + its usage; later lines of the same message
    // contribute their thinking, and their usage only by what a larger snapshot adds. A missing id
    // (older transcripts) can't be deduped → count it.
    const id = typeof m.id === 'string' ? m.id : null;
    const prev = id === null ? undefined : counted.get(id);
    const firstSeen = !prev;
    const u = m.usage || {};
    const out = num(u.output_tokens);
    const inTok = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
    const unit = num(u.input_tokens) + out + num(u.cache_creation_input_tokens);
    if (prev && unit > prev.unit) {
      prev.d.out += out - prev.out;
      prev.d.inTok += inTok - prev.inTok;
      if (prev.h) {
        prev.h.out += out - prev.out;
        prev.h.inTok += inTok - prev.inTok;
      }
      prev.out = out;
      prev.inTok = inTok;
      prev.unit = unit;
    }
    let think = 0;
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b && b.type === 'thinking') {
          const t = typeof b.thinking === 'string' ? b.thinking : typeof b.text === 'string' ? b.text : '';
          if (t) think += Math.ceil(t.length / 4); // rough token estimate
        }
      }
    }
    d.think += think;
    if (firstSeen && id !== null) counted.set(id, { d, h, out, inTok, unit });
    if (firstSeen) {
      if (!o.usageOnly) d.msgs++;
      d.out += out;
      d.inTok += inTok;
    }
    if (h) {
      h.think += think;
      if (firstSeen) {
        if (!o.usageOnly) h.msgs++;
        h.out += out;
        h.inTok += inTok;
      }
    }
  }
  return { sid, days, hours };
}

/** All transcript files under ~/.claude/projects (any project). `claudeOnly` omits codex's derived
 *  transcripts — the shared Stats charts blend both (R13), but the Claude plan-window fallback must
 *  not let codex tokens fill a Claude measured window. */
function transcriptFiles(claudeOnly = false): string[] {
  const root = path.join(claudeConfigDir(), 'projects');
  let out: string[] = [];
  if (!claudeOnly) {
    const { codexSessionSources } = require('./codex') as typeof import('./codex');
    const { codexTranscriptFile } = require('./codex-events') as typeof import('./codex-events');
    out = codexSessionSources().map((x) => codexTranscriptFile(x.file)).filter((x): x is string => !!x);
  }
  let projects: string[];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const proj of projects) {
    const dir = path.join(root, proj);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) if (f.endsWith('.jsonl')) out.push(path.join(dir, f));
  }
  return out;
}

/**
 * Scan transcripts (incrementally cached) + the edit store, and roll up the five metrics into a
 * 30-day daily series plus session / today / 7-day / 30-day windows. Pass `activeSessionId` for the
 * "current session" window; `nowMs` is injectable for tests.
 */
export function computeStats(activeSessionId?: string, nowMs?: number, claudeOnly = false): StatsResult {
  const now = nowMs ?? Date.now();
  const cutoff = now - 31 * 86400000;
  const cachePath = statsCachePath(claudeOnly);
  // The cache VALUE is per-day/per-hour aggregates keyed in the machine's LOCAL zone. If the zone
  // changes (travel, or a differing TZ between subprocess and host) an unchanged file's cached buckets
  // would be reinterpreted under the new zone — so stamp the offset and invalidate on mismatch.
  const tzOffset = new Date(now).getTimezoneOffset();
  const todayKey = dayKey(now);
  const startOfToday = (() => {
    const t = new Date(now);
    t.setHours(0, 0, 0, 0);
    return t.getTime();
  })();

  let prev: Record<string, FileEntry> = {};
  try {
    const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    // Reuse only a cache from the same agg version AND the same local TZ offset (else its local-day
    // buckets are wrong under the current zone).
    if (c && c.v === CACHE_VERSION && c.tz === tzOffset && c.files) prev = c.files;
  } catch {
    /* no cache yet */
  }

  let dirty = false;
  const files: Record<string, FileEntry> = {};
  // The active session's own transcript is always parsed (even if aged out), so its "current session"
  // token/message numbers stay consistent with its edit count, which has no cutoff.
  const activeFile = activeSessionId ? `${activeSessionId}.jsonl` : null;
  for (const file of transcriptFiles(claudeOnly)) {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoff && path.basename(file) !== activeFile) continue; // ignore transcripts older than the window
    const needHourly = st.mtimeMs >= startOfToday; // only today's files can hold today's messages
    const cached = prev[file];
    if (
      cached &&
      cached.mtime === st.mtimeMs &&
      cached.size === st.size &&
      (!needHourly || (cached.hourly && cached.hourly.day === todayKey))
    ) {
      if (!needHourly && cached.hourly) {
        delete cached.hourly; // prune a stale-day hourly block so the cache doesn't accrete them
        dirty = true;
      }
      files[file] = cached; // unchanged → reuse
    } else {
      const parsed = parseTranscript(file, needHourly ? todayKey : null);
      const entry: FileEntry = { mtime: st.mtimeMs, size: st.size, sid: parsed.sid, days: parsed.days };
      if (needHourly) entry.hourly = { day: todayKey, hours: parsed.hours };
      files[file] = entry;
      dirty = true;
    }
  }
  // Entries for deleted or aged-out files fall away because `files` is rebuilt from disk each run.
  if (!dirty) dirty = Object.keys(prev).length !== Object.keys(files).length;
  if (dirty) {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
      const tmp = cachePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, tz: tzOffset, files }), { mode: 0o600 });
      fs.renameSync(tmp, cachePath); // atomic: a concurrent reader never sees a torn cache
    } catch {
      /* cache is best-effort */
    }
  }

  // Edits come from the store (authoritative), bucketed by day (and by hour for today) and split by
  // current (folded) status. One readLog pass per session serves both series.
  type EditSplit = { pending: number; kept: number; undone: number };
  const zeroSplit = (): EditSplit => ({ pending: 0, kept: 0, undone: 0 });
  const statusKey = (st: string): keyof EditSplit => (st === 'kept' ? 'kept' : st === 'undone' ? 'undone' : 'pending');
  const editsByDay: Record<string, EditSplit> = {};
  const editsBySession: Record<string, number> = {};
  const hourEdits: EditSplit[] = Array.from({ length: 24 }, () => zeroSplit());
  for (const s of listSessions()) {
    // A session whose last activity predates the 31-day window holds only out-of-window edits, so its
    // day buckets never reach the 30-day series — skip its whole log (mirrors the transcript cutoff
    // above). The active session is always walked so its "current session" edit count stays exact.
    if (s.lastMs < cutoff && s.id !== activeSessionId) continue;
    for (const rec of readLog(s.id)) {
      const key = dayKey(rec.ts);
      if (!editsByDay[key]) editsByDay[key] = zeroSplit();
      editsByDay[key][statusKey(rec.status)]++;
      editsBySession[s.id] = (editsBySession[s.id] || 0) + 1;
      if (rec.ts >= startOfToday && key === todayKey) hourEdits[new Date(rec.ts).getHours()][statusKey(rec.status)]++;
    }
  }

  // 30-day daily series, oldest → newest. Day keys are derived from LOCAL NOON minus i*24h: stepping
  // back from `now` itself in fixed 24h hops lands on the wrong calendar day around DST transitions
  // (a fall-back day appears twice / a spring-forward day vanishes); noon is >11h from either
  // midnight, so a ±1h DST shift can never cross a date boundary.
  const noonToday = (() => {
    const t = new Date(now);
    t.setHours(12, 0, 0, 0);
    return t.getTime();
  })();
  const daily: DayStat[] = [];
  for (let i = 29; i >= 0; i--) {
    const key = dayKey(noonToday - i * 86400000);
    let out = 0;
    let think = 0;
    let msgs = 0;
    let inTok = 0;
    for (const f in files) {
      const d = files[f].days[key];
      if (d) {
        out += d.out;
        think += d.think;
        msgs += d.msgs;
        inTok += d.inTok;
      }
    }
    const es = editsByDay[key] || { pending: 0, kept: 0, undone: 0 };
    daily.push({
      day: key,
      editsPending: es.pending,
      editsKept: es.kept,
      editsUndone: es.undone,
      tokensInput: inTok,
      tokensOutput: out,
      messages: msgs,
      thinking: think,
    });
  }

  const sumLast = (n: number): StatMetrics =>
    daily.slice(daily.length - n).reduce((a, d) => {
      a.edits += d.editsPending + d.editsKept + d.editsUndone;
      a.tokens += d.tokensInput + d.tokensOutput;
      a.messages += d.messages;
      a.thinking += d.thinking;
      a.output += d.tokensOutput;
      return a;
    }, ZERO());

  const session = ZERO();
  if (activeSessionId) {
    for (const f in files) {
      // Match the transcript by FILENAME (== the session id resolveSessionId returns), not the last
      // message's parsed sessionId, which can diverge on a resumed/renamed session.
      if (path.basename(f) !== activeFile) continue;
      for (const key in files[f].days) {
        const d = files[f].days[key];
        session.output += d.out;
        session.thinking += d.think;
        session.messages += d.msgs;
        session.tokens += d.inTok + d.out;
      }
    }
    session.edits = editsBySession[activeSessionId] || 0;
  }

  // Today's 24 hourly buckets, straight from the per-file hourly caches (already re-parsed above if
  // the file changed) + the store edits bucketed in the session loop.
  const hourAgg: DayAgg[] = Array.from({ length: 24 }, () => ({ msgs: 0, out: 0, think: 0, inTok: 0 }));
  for (const f in files) {
    const hb = files[f].hourly;
    if (!hb || hb.day !== todayKey) continue;
    for (const h in hb.hours) {
      const idx = +h;
      if (!(idx >= 0 && idx <= 23)) continue;
      const a = hourAgg[idx];
      const s = hb.hours[h];
      a.msgs += s.msgs;
      a.out += s.out;
      a.think += s.think;
      a.inTok += s.inTok;
    }
  }
  const hourly: HourStat[] = hourAgg.map((a, h) => ({
    hour: h,
    editsPending: hourEdits[h].pending,
    editsKept: hourEdits[h].kept,
    editsUndone: hourEdits[h].undone,
    tokensInput: a.inTok,
    tokensOutput: a.out,
    messages: a.msgs,
    thinking: a.think,
  }));

  let usageSource: 'database' | 'local' = 'local';
  const ix = require('./index/api') as typeof import('./index/api');
  const database = process.env.OAK_INDEX === 'off' ? null : ix.useIndex({ kick: true });
  if (database?.ok) {
    try {
      const usage = require('./index/usage') as typeof import('./index/usage');
      const claudeAccount = usage.countedAccount(database.db).account;
      const codexAccount = (require('./codex') as typeof import('./codex')).codexAccountId() ?? usage.codexAccountOf(database.db);
      const rows = database.db.prepare(`SELECT ts, input + cache_create + cache_read AS input, output
        FROM usage_messages WHERE agent = ? AND ts >= ? AND ts <= ? AND (? IS NULL OR account IS NULL OR account = ?)`);
      const first = new Date(`${daily[0].day}T00:00:00`).getTime();
      for (const bucket of [...daily, ...hourly]) {
        bucket.tokensInput = 0; bucket.tokensOutput = 0; bucket.messages = 0; bucket.thinking = 0;
      }
      for (const agent of claudeOnly ? ['claude'] : ['claude', 'codex']) {
        const account = agent === 'claude' ? claudeAccount : codexAccount;
        for (const row of rows.all(agent, first, now, account, account) as { ts: number; input: number; output: number }[]) {
          const day = dayKey(row.ts);
          const bucket = daily.find((d) => d.day === day);
          for (const b of [bucket, day === todayKey ? hourly[new Date(row.ts).getHours()] : null]) {
            if (b) { b.tokensInput += row.input; b.tokensOutput += row.output; b.messages++; }
          }
        }
      }
      usageSource = 'database';
    } finally { database.close(); }
  }

  return {
    usageSource,
    daily,
    hourly,
    windows: { session, day: sumLast(1), week: sumLast(7), month: sumLast(30) },
    generatedAt: now,
  };
}
