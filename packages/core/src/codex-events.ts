/** Versioned Codex rollout adapter. Raw rollouts remain authoritative; this append-only derived
 * transcript uses the shared message/tool envelope consumed by Observatory's existing readers.
 * The cursor retains only parser state. Warm refresh reads appended bytes, with crash recovery
 * truncating uncommitted derived output before replay. No inference/model invocation is involved. */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { rootDir } from './store';
import { cachedByFiles, readLines } from './fscache';
import type { UsageSplit } from './pricing';

const VERSION = 6;
const CHUNK = 1024 * 1024;
const MAX_LINE = 4 * CHUNK;
const digest = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const num = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
interface Cursor {
  preview?: Cursor;
  title: string; firstPrompt: string;
  version: number; source: string; ino: number; offset: number; sourceSize: number; mtime: number;
  outputBytes: number; anchor: string; sessionId: string; cwd: string; originator: string;
  model: string; provider: string; effort: string; turnId: string; tokens: number[] | null;
  seenUsage: string[]; seenMessages: string[]; unsupported: number; malformed: number;
  firstTs: number; lastTs: number; modelWindow: number | null; discarding: boolean;
  rateLimits: Record<string, unknown> | null; quotaTs: number | null; contextTokens: number | null;
}
function initial(source: string, ino: number): Cursor {
  return { title: '', firstPrompt: '', version: VERSION, source, ino, offset: 0, sourceSize: 0, mtime: 0, outputBytes: 0, anchor: '',
    sessionId: '', cwd: '', originator: '', model: '', provider: '', effort: '', turnId: '', tokens: null,
    seenUsage: [], seenMessages: [], unsupported: 0, malformed: 0, firstTs: 0, lastTs: 0, modelWindow: null, discarding: false, rateLimits: null, quotaTs: null, contextTokens: null };
}
function loadCursor(file: string, source: string, ino: number): Cursor {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c?.version === VERSION && c.source === source &&
        ['offset', 'sourceSize', 'outputBytes', 'mtime', 'ino', 'malformed', 'unsupported'].every(k => Number.isFinite(c[k]) && c[k] >= 0) &&
        Array.isArray(c.seenUsage) && Array.isArray(c.seenMessages) && typeof c.anchor === 'string') return c;
  } catch { /* derived state is disposable; raw history remains authoritative */ }
  return initial(source, ino);
}
function anchor(fd: number, offset: number): string {
  const n = Math.min(256, offset); const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, offset - n); return digest(b);
}
function safeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file);
}
// O(1) membership over the same bounded FIFO array. `xs` stays the serialized form (cursor.json); a
// companion Set keyed by the array identity gives has/add in constant time instead of a linear
// Array.includes per line (which was O(n²) over a rollout and dominated large-session derive cost).
const seenSets = new WeakMap<string[], Set<string>>();
function remember(xs: string[], key: string): boolean {
  let set = seenSets.get(xs);
  if (!set) { set = new Set(xs); seenSets.set(xs, set); }
  if (set.has(key)) return false;
  set.add(key); xs.push(key);
  if (xs.length > 20000) { for (const d of xs.splice(0, xs.length - 20000)) set.delete(d); }
  return true;
}
function contentText(p: any): string {
  if (typeof p.message === 'string') return p.message;
  if (typeof p.content === 'string') return p.content;
  return (Array.isArray(p.content) ? p.content : []).map((b: any) => typeof b.text === 'string' ? b.text : '').filter(Boolean).join('\n');
}
/** Codex injects these user-role context records before the person's prompt. */
export function codexPromptText(text: string): string | null {
  const clean = text.trim();
  if (!clean || /^#\s*AGENTS\.md instructions\b/i.test(clean) ||
      /^<(?:INSTRUCTIONS|environment_context|user_instructions|permissions|skills_instructions|recommended_plugins|turn_aborted)\b/i.test(clean)) return null;
  return clean;
}

function normalize(rec: any, c: Cursor, position: number): Record<string, unknown>[] {
  const p = rec?.payload ?? {}; const kind = String(p.type ?? rec.type ?? 'unknown');
  const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : num(rec.timestamp);
  if (Number.isFinite(ts) && ts > 0) { c.firstTs ||= ts; c.lastTs = Math.max(c.lastTs, ts); }
  if (rec.type === 'session_meta') {
    c.sessionId = String(p.id ?? p.session_id ?? c.sessionId); c.cwd = String(p.cwd ?? c.cwd);
    c.provider = String(p.model_provider ?? c.provider); c.originator = String(p.originator ?? c.originator);
  }
  if (rec.type === 'session_meta' || ['thread_name_updated', 'thread_name', 'thread_renamed', 'session_title'].includes(kind)) {
    const title = p.thread_name ?? p.title ?? (kind === 'thread_name_updated' ? p.name : undefined);
    if (typeof title === 'string' && title.trim()) c.title = title.trim();
  }
  const settings = p.thread_settings ?? p;
  if (typeof settings.model === 'string') c.model = settings.model;
  if (typeof settings.model_provider_id === 'string') c.provider = settings.model_provider_id;
  if (typeof settings.model_provider === 'string') c.provider = settings.model_provider;
  if (typeof (settings.model_reasoning_effort ?? settings.effort ?? settings.reasoning_effort) === 'string')
    c.effort = settings.model_reasoning_effort ?? settings.effort ?? settings.reasoning_effort;
  if (typeof (p.turn_id ?? p.turnId) === 'string') c.turnId = p.turn_id ?? p.turnId;
  const window = num(p.model_context_window ?? p.info?.model_context_window);
  if (window) c.modelWindow = window;
  if (Object.prototype.hasOwnProperty.call(p, 'rate_limits')) {
    c.rateLimits = p.rate_limits; c.quotaTs = Number.isFinite(ts) && ts > 0 ? ts : null;
  }
  if (p.info?.last_token_usage) c.contextTokens = num(p.info.last_token_usage.total_tokens);
  const base: Record<string, unknown> = { timestamp: Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : undefined,
    sessionId: c.sessionId, cwd: c.cwd, runtime: 'codex', provider: c.provider || null,
    nativeTurnId: c.turnId || null, sourceEvent: kind, sourceOffset: position };
  const message = (role: string, content: unknown, id = `codex-${position}`, extra: object = {}): Record<string, unknown> =>
    ({ ...base, type: role, uuid: role === 'user' && c.turnId ? c.turnId : id,
      message: { id, role, content, model: c.model || undefined, effort: c.effort || undefined, ...extra } });
  const text = contentText(p);
  // Known non-conversation records in Codex 0.153.x. token_count already accounts for
  // token_usage_record, and item_completed duplicates response_item tool/message content.
  if ((kind === 'message' && ['system', 'developer'].includes(p.role)) ||
      ['world_state', 'item_completed', 'token_usage_record'].includes(kind)) return [];
  if (kind === 'user_message' || kind === 'agent_message' || (kind === 'message' && ['user', 'assistant'].includes(p.role))) {
    const role = kind === 'user_message' ? 'user' : kind === 'agent_message' ? 'assistant' : p.role;
    if (!text) return [];
    if (role === 'user' && !c.firstPrompt) c.firstPrompt = codexPromptText(text) || '';
    // Codex may expose the same message in response_item and event_msg; fold only a matching
    // native turn + role + text. Identical prompts in distinct turns remain distinct.
    const key = digest(`${c.turnId || ts}:${role}:${text}`);
    if (!remember(c.seenMessages, key)) return [];
    return [message(role, [{ type: 'text', text }], `codex-message-${key}`)];
  }
  if (kind === 'function_call' || kind === 'custom_tool_call') {
    let input: any = p.arguments ?? p.input ?? {};
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { input }; } }
    const original = String(p.name ?? 'unknown');
    const name = ['exec_command','shell','shell_command','unified_exec'].includes(original) ? 'Bash' : original;
    if (original === 'apply_patch') {
      const { extractPatchText, parseCodexPatch } = require('./codex') as typeof import('./codex');
      const patch = extractPatchText(input); if (patch) input = { ...input, file_path: parseCodexPatch(patch)[0]?.file };
    }
    if (name === 'Bash') input = { ...input, command: input.command ?? input.cmd ?? input.input };
    return [message('assistant', [{ type: 'tool_use', id: String(p.call_id ?? p.id ?? position), name, originalName: original, input }])];
  }
  if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
    const output = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? null);
    const failed = p.is_error === true || (typeof p.exit_code === 'number' && p.exit_code !== 0) || /Process exited with code [1-9]/.test(output);
    return [message('user', [{ type: 'tool_result', tool_use_id: String(p.call_id ?? p.id ?? ''), content: output, is_error: failed }])];
  }
  if (kind === 'reasoning') {
    const summary = (Array.isArray(p.summary) ? p.summary : []).map((x: any) => x.text ?? '').filter(Boolean).join('\n');
    return summary ? [message('assistant', [{ type: 'thinking', thinking: summary }])] : [];
  }
  if (kind === 'token_count' || p.info?.total_token_usage) {
    const t = p.info?.total_token_usage;
    if (!t) return [];
    const next = [num(t.input_tokens), num(t.output_tokens), num(t.cached_input_tokens), num(t.cache_write_input_tokens)];
    const usageId = digest(`${c.turnId || c.sessionId}:${c.provider}:${next.join(':')}`);
    if (!remember(c.seenUsage, usageId)) return [];
    const reset = c.tokens !== null && next.some((v, i) => v < c.tokens![i]);
    const last = p.info?.last_token_usage;
    // First event of this rollout (c.tokens === null) or a counter reset: take the delta from THIS
    // turn's own last_token_usage when present, never the cumulative total. A FORKED rollout's first
    // total_token_usage is the PARENT's running total, so counting it as a fresh delta re-added the
    // entire parent history to every week/month figure. For a non-forked file total==last on the first
    // event, so this is lossless there; only the inherited cumulative is excluded.
    // Only trust last_token_usage when it carries the per-category breakdown; some shapes (and the
    // test fixtures) send only total_tokens there, which would zero the delta. Otherwise fall back to
    // the cumulative `next` — the original behavior for a genuine first/fresh event.
    const lastHasBreakdown = last != null && (last.input_tokens != null || last.output_tokens != null);
    const lastDelta = lastHasBreakdown ? [num(last.input_tokens), num(last.output_tokens), num(last.cached_input_tokens), num(last.cache_write_input_tokens)] : null;
    const delta = c.tokens === null || reset ? (lastDelta ?? next)
      : next.map((v, i) => Math.max(0, v - c.tokens![i]));
    c.tokens = next;
    if (!delta.some(Boolean)) return [];
    return [{ ...message('assistant', [], `codex-usage-${usageId}`, { usage: {
      input_tokens: Math.max(0, delta[0] - delta[2]), output_tokens: delta[1], cache_read_input_tokens: delta[2], cache_creation_input_tokens: delta[3],
    } }), usageOnly: true, usageId, usageReset: reset, modelContextWindow: c.modelWindow,
      contextTokens: num(last?.total_tokens) || null }];
  }
  if (kind === 'context_compacted' || kind === 'compacted') return [{ ...base, type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' } }];
  const known = ['session_meta','turn_context','thread_settings_applied','task_started','task_complete','turn_aborted','token_count'];
  if (!known.includes(kind)) c.unsupported++;
  return [{ ...base, type: 'system', subtype: kind, model: c.model || undefined,
    agentId: p.agent_id, agentType: p.agent_type, reason: p.reason }];
}

const derivedRoot = (): string => path.join(rootDir(), 'runtime-transcripts', 'codex');

/** Whether `file` is one of `codexTranscriptFile`'s outputs: how a caller holding only a transcript
 *  path tells a Codex session from a Claude one without searching Codex's tree. */
export function isCodexTranscriptFile(file: string): boolean {
  return path.dirname(path.dirname(path.resolve(file))) === path.resolve(derivedRoot());
}

/** Returns a derived transcript, never the raw rollout with an incompatible message schema. */
export function codexTranscriptFile(source: string): string | null {
  let st: fs.Stats; try { st = fs.statSync(source); } catch { return null; }
  const dir = path.join(derivedRoot(), digest(path.resolve(source)));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const output = path.join(dir, 'events.jsonl'), statePath = path.join(dir, 'cursor.json'), lock = path.join(dir, '.lock');
  let c = loadCursor(statePath, source, st.ino);
  if (c.version === VERSION && c.source === source && c.ino === st.ino && c.sourceSize === st.size && c.mtime === st.mtimeMs && fs.existsSync(output)) return output;
  let owner: number;
  try { owner = fs.openSync(lock, 'wx', 0o600); fs.writeSync(owner, String(process.pid)); }
  catch {
    try { const pid = Number(fs.readFileSync(lock, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) fs.unlinkSync(lock); }
      else process.kill(pid, 0); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') { try { fs.unlinkSync(lock); } catch {} } }
    return fs.existsSync(output) ? output : null;
  }
  let fd: number | undefined;
  try {
    // Reload after acquiring ownership: another process may have advanced the cursor.
    c = loadCursor(statePath, source, st.ino);
    delete c.preview;
    fd = fs.openSync(source, 'r'); st = fs.fstatSync(fd);
    if (c.version !== VERSION || c.ino !== st.ino || c.offset > st.size ||
        (c.offset && c.anchor !== anchor(fd, c.offset)) || !fs.existsSync(output) ||
        (c.sourceSize === st.size && c.mtime !== st.mtimeMs)) c = initial(source, st.ino);
    if (!fs.existsSync(output)) fs.writeFileSync(output, '', { mode: 0o600 });
    fs.truncateSync(output, c.outputBytes);
    let carry = Buffer.alloc(0), readAt = c.offset;
    while (readAt < st.size) {
      const buf = Buffer.alloc(Math.min(CHUNK, st.size - readAt)); const n = fs.readSync(fd, buf, 0, buf.length, readAt); if (!n) break;
      readAt += n; carry = Buffer.concat([carry, buf.subarray(0, n)]);
      let start = 0, end: number; const rows: string[] = [];
      while ((end = carry.indexOf(10, start)) >= 0) {
        const line = carry.subarray(start, end); const pos = c.offset;
        c.offset += end + 1 - start; start = end + 1;
        if (c.discarding) { c.discarding = false; continue; }
        if (line.length > MAX_LINE) { c.malformed++; continue; }
        if (!Buffer.from(line.toString('utf8')).equals(line)) { c.malformed++; continue; }
        try { for (const row of normalize(JSON.parse(line.toString('utf8')), c, pos)) rows.push(JSON.stringify(row)); }
        catch { c.malformed++; }
      }
      carry = carry.subarray(start);
      if (carry.length > MAX_LINE || c.discarding) {
        if (!c.discarding) c.malformed++;
        c.discarding = true; c.offset += carry.length; carry = Buffer.alloc(0);
      }
      if (rows.length) { const chunk = rows.join('\n') + '\n'; fs.appendFileSync(output, chunk, { mode: 0o600 }); c.outputBytes += Buffer.byteLength(chunk); }
    }
    // A complete final JSON object may precede its newline. Preview it without committing its
    // offset/counters: the next append truncates this preview and consumes the full line once.
    if (carry.length && !c.discarding) {
      try {
        if (!Buffer.from(carry.toString('utf8')).equals(carry)) throw new Error('incomplete UTF-8 tail');
        const preview: Cursor = JSON.parse(JSON.stringify(c));
        const rows = normalize(JSON.parse(carry.toString('utf8')), preview, c.offset);
        if (rows.length) fs.appendFileSync(output, rows.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
        c.preview = preview;
      } catch { /* a partial UTF-8/JSON tail remains pending */ }
    }
    c.sourceSize = st.size; c.mtime = st.mtimeMs; c.anchor = anchor(fd, c.offset);
    safeAtomic(statePath, JSON.stringify(c));
    // Derived refresh timestamps track source activity, never the time an idle view was opened.
    fs.utimesSync(output, st.atime, st.mtime);
    return output;
  } finally { if (fd !== undefined) fs.closeSync(fd); fs.closeSync(owner); try { fs.unlinkSync(lock); } catch {} }
}

export interface CodexUsageDelta { id: string; ts: number; model: string; provider: string | null; usage: UsageSplit; reset: boolean }
const isUsageDelta = (d: any): d is CodexUsageDelta => !!d && typeof d.id === 'string' && Number.isFinite(d.ts) && !!d.usage &&
  ['input', 'output', 'cacheRead', 'cacheWrite'].every((k) => Number.isFinite(d.usage[k]));
export function codexUsageDeltas(source: string): CodexUsageDelta[] {
  const file = codexTranscriptFile(source); if (!file) return [];
  return cachedByFiles('codexUsageDeltas-v1', [file], () => {
    // Kept beside the derived transcript, keyed to its exact state: a one-shot `oak usage` starts with
    // an empty memo, and reading every derived transcript whole to find its usage rows was 300 ms of a
    // 400 ms call on 51 rollouts. Only a transcript that changed is read again.
    const kept = path.join(path.dirname(file), 'usage-v1.json');
    let stamp = '';
    try { const st = fs.statSync(file); stamp = `${VERSION}|${st.mtimeMs}:${st.size}:${st.ino}`; } catch { /* raced away: compute, keep nothing */ }
    try {
      const j = JSON.parse(fs.readFileSync(kept, 'utf8'));
      if (stamp && j?.stamp === stamp && Array.isArray(j.rows) && j.rows.every(isUsageDelta)) return j.rows as CodexUsageDelta[];
    } catch { /* absent or unreadable: derive */ }
    const rows: CodexUsageDelta[] = [];
    for (const line of readLines(file)) {
      try { const o = JSON.parse(line); if (!o.usageOnly) continue; const u = o.message.usage;
        const ts = Date.parse(o.timestamp); if (!Number.isFinite(ts)) continue;
        rows.push({ id: o.usageId, ts, model: o.message.model ?? '', provider: o.provider, reset: o.usageReset === true,
          usage: { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens) } });
      } catch { /* malformed derived line; next source change rebuilds recoverable state */ }
    }
    if (stamp) try { safeAtomic(kept, JSON.stringify({ stamp, rows })); } catch { /* a cache we cannot keep is recomputed */ }
    return rows;
  });
}

export function codexParserHealth(source: string): { malformed: number; unsupported: number; pendingBytes: number } | null {
  const file = codexTranscriptFile(source); if (!file) return null;
  try { const c: Cursor = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'cursor.json'), 'utf8'));
    return { malformed: c.malformed, unsupported: c.unsupported, pendingBytes: c.sourceSize - c.offset };
  } catch { return null; }
}

/** Latest explicit account/context evidence, maintained by the same incremental pass as the feed. */
export function codexUsageState(source: string): { title: string; firstPrompt: string; rateLimits: Record<string, unknown> | null; quotaTs: number | null;
  tokens: number[] | null; modelWindow: number | null; contextTokens: number | null; provider: string } | null {
  const file = codexTranscriptFile(source); if (!file) return null;
  try { const c: Cursor = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'cursor.json'), 'utf8')); return c.preview ?? c; } catch { return null; }
}

/** Explicit cache maintenance: raw Codex history and authoritative edit stores are never removed. */
export function pruneCodexDerivedCache(maxBytes = 1024 * 1024 * 1024, maxAgeMs = 30 * 86400000): { removed: number; bytes: number } {
  const root = path.join(rootDir(), 'runtime-transcripts', 'codex');
  const rows: { dir: string; bytes: number; at: number }[] = [];
  try { for (const n of fs.readdirSync(root)) {
    if (!/^[a-f0-9]{64}$/.test(n)) continue;
    const dir = path.join(root, n); if (fs.existsSync(path.join(dir, '.lock'))) continue;
    try { const s = fs.statSync(path.join(dir, 'cursor.json')), e = fs.statSync(path.join(dir, 'events.jsonl'));
      rows.push({ dir, bytes: s.size + e.size, at: s.mtimeMs }); } catch {}
  } } catch {}
  rows.sort((a,b) => a.at - b.at);
  let total = rows.reduce((n,r) => n + r.bytes, 0), removed = 0, bytes = 0;
  for (const r of rows) if (total > maxBytes || Date.now() - r.at > maxAgeMs) {
    const lock = path.join(r.dir, '.lock'); let fd: number | undefined;
    try {
      fd = fs.openSync(lock, 'wx', 0o600); fs.writeSync(fd, String(process.pid));
      fs.rmSync(r.dir, { recursive:true }); total -= r.bytes; removed++; bytes += r.bytes;
    } catch { /* another parser or maintenance process acquired the directory */ }
    finally { if (fd !== undefined) { fs.closeSync(fd); try { if (fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock); } catch {} } }
  }
  return { removed, bytes };
}
