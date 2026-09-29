/** Hook lifecycle evidence that supplements transcripts (permissions, prompts, workers). */
import * as fs from 'fs';
import * as path from 'path';
import { storeDir, rootDir, ensureStore } from './store';
import { isSafeSessionId } from './store';
import { ignoreContext } from './ignore';
import { cachedByFiles, readLines } from './fscache';

export function captureEventsPath(session: string): string {
  return path.join(storeDir(session), 'capture-events.jsonl');
}


/** Sessions whose store this process has already ensured — an append per streamed chunk must not
 *  pay 4 mkdir/chmod syscalls each time (measured: they dominate the append). */
const ensuredStores = new Set<string>();

/** Hook lifecycle evidence is retained with the session. Ignored file content and oversized event values
 * are redacted with a marker; capture still interprets the original bounded protocol message. */
export function appendCaptureEvent(session: string, kind: string, payload: unknown, cwd?: string): void {
  const ensuredKey = `${rootDir()}:${session}`;
  if (!ensuredStores.has(ensuredKey)) { ensureStore(session); ensuredStores.add(ensuredKey); }
  const clean = (v: unknown, depth = 0): unknown => {
    if (typeof v === 'string') return v.length > 262144 ? v.slice(0, 262144) + '\n[Observatory: oversized event value truncated]' : v;
    if (!v || typeof v !== 'object') return v;
    if (depth > 30) return { redacted: 'nesting limit' };
    if (Array.isArray(v)) return v.slice(0, 10000).map(x => clean(x, depth + 1));
    const obj = v as Record<string, unknown>;
    // Every path this node names — directly, or via a `locations: [{path}]` / `location` list.
    const resolvesIgnored = (p: unknown): boolean =>
      typeof p === 'string' && (path.isAbsolute(p) || cwd != null) && ignoreContext().ignored(path.resolve(cwd ?? '.', p));
    const locs = obj.locations ?? obj.location;
    const locPaths = Array.isArray(locs) ? locs.map(l => (l && typeof l === 'object') ? (l as Record<string, unknown>).path : undefined) : [];
    const touchesIgnored = [obj.path, obj.file_path, obj.notebook_path, obj.abs_path, ...locPaths].some(resolvesIgnored);
    if (touchesIgnored) {
      // The node names an ignored file. Redacting only the path-bearing key leaked the file's CONTENT
      // when it rode in a SIBLING field — a tool_call's read result / diff in `content`, `rawOutput`,
      // `oldText`/`newText`, while the path sat in `locations`. Keep the structural keys (the filename
      // may stay, as before) and drop every content-bearing field of this update.
      const CONTENT_KEYS = new Set(['content', 'rawOutput', 'output', 'text', 'oldText', 'newText', 'newString', 'oldString', 'new_string', 'old_string', 'lines', 'diff', 'rawInput', 'input', 'newContent', 'oldContent']);
      const kept = Object.fromEntries(Object.entries(obj).filter(([k]) => !CONTENT_KEYS.has(k)).map(([k, x]) => [k, clean(x, depth + 1)]));
      return { ...kept, redacted: 'observatoryignore' };
    }
    return Object.fromEntries(Object.entries(obj).map(([k, x]) => [k, clean(x, depth + 1)]));
  };
  fs.appendFileSync(captureEventsPath(session), JSON.stringify({ ts: Date.now(), kind, payload: clean(payload) }) + '\n', { mode: 0o600 });
}

export interface CaptureEvent {
  ts: number;
  kind: string;
  payload: unknown;
}

/** Hook events, cached by file state. A torn trailing line is ignored; kinds narrow the parse. */
export function readCaptureEvents(session: string, kinds?: readonly string[]): CaptureEvent[] {
  if (!isSafeSessionId(session)) return [];
  const file = captureEventsPath(session);
  return cachedByFiles(`capture-events:${kinds?.join(',') ?? '*'}`, [file], () => {
    const needles = kinds?.map(k => `"kind":"${k}"`), out: CaptureEvent[] = [];
    let lines: readonly string[]; try { lines = readLines(file); } catch { return []; }
    for (const line of lines) {
      if (!line.trim() || needles && !needles.some(n => line.includes(n))) continue;
      try { const v = JSON.parse(line); if (v && typeof v.kind === 'string' && (!kinds || kinds.includes(v.kind))) out.push(v); } catch {}
    }
    return out;
  });
}

