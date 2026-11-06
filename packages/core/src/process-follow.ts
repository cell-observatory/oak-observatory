import * as fs from 'fs';
import * as path from 'path';
import { findTranscript } from './observe';
import { sessionProcesses, processKey, processOutputTail, plainProcessOutput, summarizeProcesses, type BackgroundProcess } from './processes';
import type { FeedResult } from './feed';
import { graphemeTail } from './graphemes';

export interface ProcessSnapshot extends FeedResult {
  processLogVersion: 1;
  session: string;
  process: BackgroundProcess;
  outputTail: string;
  outputDelta: string;
  cursor: number;
  source: string;
}

/** The only input path is the output named by a task in this session's transcript. */
export function processSnapshot(cwd: string, session: string, id: string, previous?: { cursor: number; source: string }, list = sessionProcesses(cwd, session)): ProcessSnapshot {
  const proc = list.find(p => processKey(p) === id);
  if (!proc) throw new Error(`no background shell "${id}" in session ${session}.`);
  let fd: number | undefined, cursor = 0, source = '', outputTail = '', outputDelta = '', note = '';
  try {
    if (!proc.outputPath && proc.recordedOutput !== undefined) {
      note = 'Codex output updates when the harness records an exec or write_stdin result; no output file is recorded.';
      outputTail = plainProcessOutput(proc.recordedOutput);
      cursor = proc.recordedBytes || 0;
      source = `codex:${session}:${id}`;
      outputDelta = previous?.source === source && previous.cursor <= cursor
        ? plainProcessOutput(Buffer.from(proc.recordedOutput).subarray(Math.max(0, Buffer.byteLength(proc.recordedOutput) - cursor + previous.cursor)).toString('utf8')) : outputTail;
    } else if (!proc.outputPath) note = 'The harness has not recorded an output file.';
    else {
      fd = fs.openSync(proc.outputPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      const st = fs.fstatSync(fd);
      if (!st.isFile()) throw new Error('not a regular output file');
      cursor = st.size;
      source = `${proc.outputPath}:${st.dev}:${st.ino}`;
      const start = Math.max(0, cursor - 16 * 1024);
      const buf = Buffer.alloc(cursor - start);
      const n = fs.readSync(fd, buf, 0, buf.length, start);
      cursor = start + n;
      let text = buf.toString('utf8', 0, n);
      if (start > 0 && text.includes('\n')) text = text.slice(text.indexOf('\n') + 1);
      outputTail = plainProcessOutput(text);
      const same = previous?.source === source && previous.cursor <= cursor;
      outputDelta = same ? plainProcessOutput(buf.toString('utf8', Math.max(0, previous!.cursor - start), n)) : outputTail;
      if (same && previous!.cursor < start) note = 'Output advanced beyond the 16 KiB tail; earlier bytes were skipped.';
    }
  } catch { note = 'Output file is unavailable.'; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return {
    processLogVersion: 1, session, process: proc, outputTail, outputDelta, cursor, source,
    ref: { kind: 'process', id }, title: plainProcessOutput(proc.description || proc.command),
    running: proc.running, mode: proc.running ? 'live' : 'audit',
    entries: outputTail.split('\n').map(label => ({ ts: 0, kind: 'output', label })),
    truncated: 0, lastTs: proc.lastOutputTs, note,
    ...(proc.endedTs ? { endedTs: proc.endedTs } : {}),
  };
}

/** One refresh: metadata for all shells, output only for the selected and visible running rows. */
export function processView(cwd: string, session: string, opts: { selected?: string; previews?: string[] } = {}) {
  const processes = sessionProcesses(cwd, session);
  const previews: Record<string, string> = {};
  for (const p of processes) {
    const id = processKey(p);
    if (id !== opts.selected && p.running && opts.previews?.slice(0, 20).includes(id))
      previews[id] = (p.recordedOutput !== undefined ? plainProcessOutput(graphemeTail(p.recordedOutput, 2048)) : processOutputTail(p.outputPath, 2048)).trimEnd().split('\n').slice(-3).join('\n');
  }
  return { session, summary: summarizeProcesses(processes), processes, previews,
    ...(opts.selected ? { selected: processSnapshot(cwd, session, opts.selected, undefined, processes) } : {}) };
}

/** Debounced directory watches survive output rotation. Idle fallback ticks only stat inputs. */
export function followProcessOutput(cwd: string, session: string, id: string, opts: {
  onSnapshot(snapshot: ProcessSnapshot): void;
  onError(error: Error): void;
  pollMs?: number;
  watch?: typeof fs.watch;
}): () => void {
  let closed = false, stamp = '', shown = '', previous: ProcessSnapshot | undefined;
  let files: string[] = [], timer: NodeJS.Timeout | undefined, debounce: NodeJS.Timeout | undefined;
  const watchers = new Map<string, fs.FSWatcher>();
  const stop = () => { closed = true; clearInterval(timer); clearTimeout(debounce); for (const w of watchers.values()) w.close(); watchers.clear(); };
  const refresh = () => {
    if (closed) return;
    try {
      const transcript = findTranscript(cwd, session);
      const workers = transcript ? path.join(path.dirname(transcript), session, 'subagents') : '';
      files = [transcript, previous?.process.workerId && workers ? path.join(workers, `agent-${previous.process.workerId}.jsonl`) : null, previous?.process.outputPath].filter((p): p is string => !!p);
      const next = files.map(file => { try { const s = fs.statSync(file); return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; } catch { return '-'; } }).join('|');
      if (previous && next === stamp) return;
      const before = files.join('\n');
      const snapshot = processSnapshot(cwd, session, id, previous);
      previous = snapshot;
      files = [transcript, snapshot.process.workerId && workers ? path.join(workers, `agent-${snapshot.process.workerId}.jsonl`) : null, snapshot.process.outputPath].filter((p): p is string => !!p);
      // Keep the pre-read stamp: a write during the read must cause another refresh.
      stamp = files.join('\n') === before ? next : '';
      const dirs = new Set(files.map(file => path.dirname(file)));
      for (const [dir, w] of watchers) if (!dirs.has(dir)) { w.close(); watchers.delete(dir); }
      for (const dir of dirs) if (!watchers.has(dir)) try {
        const watcher = (opts.watch ?? fs.watch)(dir, (_event, name) => {
          if (name !== null && !files.some(file => path.dirname(file) === dir && path.basename(file) === String(name))) return;
          if (!debounce) debounce = setTimeout(() => { debounce = undefined; refresh(); }, 75);
        });
        watcher.on('error', () => { watcher.close(); watchers.delete(dir); stamp = ''; });
        watchers.set(dir, watcher);
      } catch { /* stat fallback covers unavailable watches */ }
      const json = JSON.stringify({ ...snapshot, outputDelta: '' });
      if (json !== shown) { shown = json; opts.onSnapshot(snapshot); }
      if (!snapshot.process.running) stop();
    } catch (error) { stop(); opts.onError(error instanceof Error ? error : new Error(String(error))); }
  };
  timer = setInterval(refresh, opts.pollMs ?? 2000);
  refresh();
  return stop;
}
