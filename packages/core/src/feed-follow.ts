/** A selected worker's live log: watch its inputs, and stat them on a slow fallback tick.
 * Idle ticks never parse transcripts or emit snapshots. The caller owns printing and cancellation. */
import * as fs from 'fs';
import * as path from 'path';
import { liveFeed, workerFeedPaths, workerFeedStamp, type FeedResult } from './feed';

export function followWorkerFeed(cwd: string, session: string, id: string, opts: {
  onFeed(feed: FeedResult): void;
  onError(error: Error): void;
  limit?: number;
  pollMs?: number;
  /** Test seam for filesystems that refuse watches. */
  watch?: typeof fs.watch;
}): () => void {
  let files = workerFeedPaths(cwd, session, id);
  const watchers = new Map<string, fs.FSWatcher>();
  let timer: NodeJS.Timeout | undefined;
  let debounce: NodeJS.Timeout | undefined;
  let closed = false, stamp = '', shown = '';
  let sinceEntry: number | undefined;
  const stop = (): void => {
    closed = true;
    clearInterval(timer); clearTimeout(debounce);
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };
  const arm = (): void => {
    const dirs = new Set(files.map(file => path.dirname(file)));
    for (const [dir, watcher] of watchers) if (!dirs.has(dir)) { watcher.close(); watchers.delete(dir); }
    for (const dir of dirs) {
      if (watchers.has(dir)) continue;
      try {
        const watcher = (opts.watch ?? fs.watch)(dir, (_event, name) => {
          if (name !== null && !files.some(file => path.dirname(file) === dir && path.basename(file) === String(name))) return;
          if (!debounce) debounce = setTimeout(() => { debounce = undefined; refresh(); }, 75);
        });
        watcher.on('error', () => { watcher.close(); watchers.delete(dir); });
        watchers.set(dir, watcher);
      } catch { /* polling also discovers missing directories and re-arms replaced ones */ }
    }
  };
  const refresh = (): void => {
    if (closed) return;
    try {
      arm();
      const next = workerFeedStamp(files);
      if (next === stamp) return;
      const feed = liveFeed(cwd, session, { kind: 'agent', id }, { limit: opts.limit, sinceEntry });
      sinceEntry = feed.truncated + feed.entries.length;
      files = feed.sources ?? files;
      stamp = next;
      const json = JSON.stringify(feed);
      if (json !== shown) { shown = json; opts.onFeed(feed); }
      if (feed.endedTs) stop();
    } catch (error) { stop(); opts.onError(error instanceof Error ? error : new Error(String(error))); }
  };
  timer = setInterval(refresh, opts.pollMs ?? 2000);
  refresh();
  return stop;
}
