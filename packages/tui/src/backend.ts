/**
 * The data hub behind a live CLI surface: spawn, coalesce, mutate, and notice when the world changed.
 *
 * Every read re-executes THIS CLI's own verbs in a child process rather than calling core in-process.
 * That is not caution about speed in the average case — it is that the worst case blocks. A cold
 * change-map build is measured in seconds on a real session, and the on-disk cache is keyed to the
 * transcript and log stamps, so every new edit invalidates it — continuously, in exactly the scenario
 * a live dashboard exists for. In an editor that cost showed up as a frozen host; in a terminal UI it
 * is a dead keyboard.
 */
import * as fs from 'fs';
import * as path from 'path';

type Core = typeof import('@oak-observatory/core');

/**
 * `machine` (every read and verb below takes one): the label of the saved machine that holds the
 * session's store and files, or undefined for this machine. A session on another machine is read and
 * decided THERE — its store never leaves it, and keep/undo revert its files — through the CLI's own
 * `--machine <label>`, which runs that machine's `oak` over ssh and hands back its output unchanged.
 * So a remote call is this CLI's argv plus that pair, never through the warm worker or an in-process
 * read of this machine's store; a local call is exactly what it always was.
 */
export interface Backend {
  /** Ask for a set of views. Identical in-flight requests are dropped; a different one queues. */
  /** Ask for a fresh read. `force` marks a request that FOLLOWS A WRITE: it must not be coalesced
   *  with an identical read already in flight, because that one was taken before the write. */
  request(views: string[], session: string, extra?: string[], force?: boolean, machine?: string): void;
  /** `startedAt` is when the read that produced this payload BEGAN, not when it landed. A caller
   *  that changed the store meanwhile needs it to tell an answer that predates its write from one
   *  that reflects it. `machine` is the one the payload was read from (undefined: this one). */
  onData(fn: (payload: Record<string, unknown> | null, err: string | null, startedAt: number, session: string, machine?: string) => void): void;
  /** Serialized, and never dropped. Resolves with the CLI's own JSON. */
  mutate(verb: 'keep' | 'undo' | 'redo', ids: number[], session: string, machine?: string): Promise<{ ok: boolean; json: unknown; err: string | null }>;
  /** Keep or undo everything pending at-or-beneath one path — the change map's file/folder action.
   *  `--under` is the CLI's own scope, so file-scope and folder-scope share one exact rule with the
   *  editors instead of this surface re-deriving an id set the two could disagree about. */
  mutateUnder(verb: 'keep' | 'undo' | 'redo', under: string, session: string, machine?: string): Promise<{ ok: boolean; json: unknown; err: string | null }>;
  /** Keep, undo or redo EVERYTHING in the session — the change map's toolbar. `--all` is the CLI's
   *  own session scope, so this shares one rule with the editors instead of the TUI deriving an id
   *  set from rows that carry none. */
  mutateAll(verb: 'keep' | 'undo' | 'redo', session: string, machine?: string): Promise<{ ok: boolean; json: unknown; err: string | null }>;
  /** Accept what is still pending AND clear the resolved history — the finishing verb. */
  resolveAll(session: string, machine?: string): Promise<{ ok: boolean; json: unknown; err: string | null }>;
  /** The coloured unified patch for one edit, as the `diff` verb prints it. */
  diff(id: number, session: string, machine?: string): Promise<string>;
  /** True once the CLI on disk is no longer the one this process is running. */
  updateSkew(): boolean;
  /** What `version --check` reports. Spawned, because it reaches the network and a dashboard that
   *  blocked its repaint on a release lookup would read as hung. */
  check(): Promise<string>;
  /** Run one CLI verb and hand back its plain output — command mode's door. The caller passes an
   *  ALLOW-LISTED argv, never a user string: this spawns a process, and a text field that reaches a
   *  process is how a prompt becomes a shell. */
  run(args: readonly string[], machine?: string): Promise<string>;
  watcherMode(): string;
  close(): void;
}

/** Never below this between reads, even under a storm of filesystem events. */
const MIN_TICK_MS = 3000;
/** The same floor for a session on another machine, which no watcher here can see change: each read
 *  is an ssh round trip and a cold CLI there, so an unforced poll runs at most this often. A switch
 *  (a different read) and a read after a write (forced) still go at once. */
const REMOTE_TICK_MS = 10_000;

export function createBackend(opts: {
  core: Core;
  cwd: string;
  session: string;
  onDegrade: (why: string) => void;
}): Backend {
  const { core } = opts;
  const listeners: ((p: Record<string, unknown> | null, e: string | null, startedAt: number, session: string, machine?: string) => void)[] = [];
  let inflight: string | null = null;
  let rerun: { views: string[]; session: string; extra: string[]; machine?: string; force: boolean } | null = null;
  let lastStart = 0;
  let lastDuration = 0;
  // The last read taken from another machine: its key, when it began, and how long it took.
  let remote = { key: '', start: 0, duration: 0 };
  /** The CLI's own `--machine <label>` pair, or nothing for this machine. */
  const on = (machine?: string): string[] => (machine ? ['--machine', machine] : []);
  let closed = false;
  let mode = 'native';
  let queue: Promise<unknown> = Promise.resolve();

  // The CLI can be replaced underneath a long-running dashboard (`update` rewrites it in place), after
  // which every child is a different build from the parent. Stat-ing argv[1] costs nothing and is the
  // only signal available — the payloads deliberately carry no version, because adding one would break
  // their byte-identity with the standalone commands.
  const selfPath = process.argv[1];
  const stampSelf = (): string => {
    try {
      const st = fs.statSync(selfPath);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return '';
    }
  };
  const bootStamp = stampSelf();

  /**
   * Run one of our own verbs in a child.
   *
   * `process.execPath` sidesteps every Windows spawn rule at once: it ends in `.exe`, so the launcher
   * takes the direct path — no shell, no quoting, no PATH lookup, and a genuine ENOENT if it is wrong.
   * It also guarantees the child is the same build as the parent.
   */
  const spawnSelf = (args: string[]): Promise<{ out: string; err: string; code: number | null }> =>
    new Promise((resolve) => {
      const child = core.spawnTool(process.execPath, [selfPath, ...args], {
        cwd: opts.cwd,
        // stdin 'ignore': with 'inherit' the child competes for the parent's raw-mode stdin and eats
        // keystrokes. stderr 'pipe': `views` never redirects stderr, so 'inherit' would paint a failing
        // view's red text straight onto the alternate screen — and 'ignore' would swallow the reason.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1' },
      });
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      child.stdout?.on('data', (d: Buffer) => outChunks.push(d));
      child.stderr?.on('data', (d: Buffer) => errChunks.push(d));
      child.on('error', (e: Error) => resolve({ out: '', err: String(e.message || e), code: null }));
      child.on('close', (code: number | null) =>
        resolve({ out: Buffer.concat(outChunks).toString('utf8'), err: Buffer.concat(errChunks).toString('utf8').trim(), code })
      );
    });

  const emit = (p: Record<string, unknown> | null, e: string | null, startedAt: number, session: string, machine?: string) => {
    for (const fn of listeners) fn(p, e, startedAt, session, machine);
  };

  // The warm views worker (see createServeWorker). One request at a time: `inflight` below serializes.
  const worker = createServeWorker(core, opts.cwd, selfPath);
  const serveRequest = worker.request;

  const run = async (views: string[], session: string, extra: string[], force = false, machine?: string) => {
    const key = `${views.join(',')}|${session}|${extra.join(',')}${machine ? `|@${machine}` : ''}`;
    if (inflight) {
      // An identical POLL while one is running is redundant; a DIFFERENT one is the newest truth,
      // so it replaces whatever was queued rather than joining a backlog. A FORCED request is
      // neither: it follows a write, and the read in flight predates that write — dropping it left
      // the surface showing counts the store no longer had.
      // The force rides along: a queued read that follows a write must not meet the remote floor.
      if (force || inflight !== key) rerun = { views, session, extra, machine, force: force || rerun?.force === true };
      return;
    }
    if (machine && !force && key === remote.key && Date.now() - remote.start < Math.max(REMOTE_TICK_MS, remote.duration * 2)) return;
    inflight = key;
    const t0 = Date.now();
    if (machine) remote = { key, start: t0, duration: remote.duration };
    else lastStart = t0;
    // Captured per RUN so the payload can say which store state it was taken from — a caller that
    // wrote to the store meanwhile needs to know whether this answer predates its write.
    const startedAt = t0;
    // THROUGH THE WARM WORKER first — same code paths, same stat-revalidated caches, ~50× less work
    // per poll on a big session (measured). A missing/dead/wedged worker falls back to the cold spawn.
    // Never for another machine's session: the worker reads THIS machine's store.
    let out: string;
    let err: string;
    let code: number | null;
    const warm = machine ? null : await serveRequest(views, ['--session', session, ...extra]);
    if (warm !== null) {
      out = warm;
      err = '';
      code = 0;
    } else {
      ({ out, err, code } = await spawnSelf(['views', '--views', views.join(','), '--json', '--session', session, ...extra, ...on(machine)]));
    }
    if (machine) remote.duration = Date.now() - t0;
    else lastDuration = Date.now() - t0;
    inflight = null;
    if (!closed) {
      let parsed: Record<string, unknown> | null = null;
      let problem: string | null = null;
      try {
        // This is a READ, not an undo result: a timeout may follow even a complete-looking JSON
        // prefix. Failed transports and non-object envelopes never become an empty review.
        if (code !== 0) throw new Error('failed read');
        const value = out.trim() ? JSON.parse(out) : null;
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid envelope');
        parsed = value as Record<string, unknown>;
      } catch {
        problem = err || `views exited ${code ?? '?'} without valid JSON`;
      }
      if (!parsed && !problem) problem = err || 'views produced no output';
      // A serve-side request failure arrives as `__fatal` — a reason, never a payload.
      if (parsed && typeof parsed.__fatal === 'string') {
        problem = parsed.__fatal;
        parsed = null;
      }
      // A payload can arrive whole and still carry broken views: `views` emits `__problems` naming
      // each one it could not build. Without this the dashboard painted those views as zeros and said
      // "ready" — "could not read" and "nothing happened" produced byte-identical frames, which is the
      // failure this project's no-silent-fail rule exists to prevent.
      if (parsed && parsed.__problems && typeof parsed.__problems === 'object') {
        const bad = Object.entries(parsed.__problems as Record<string, string>);
        if (bad.length && !problem) {
          problem = bad.length === 1
            ? `${bad[0][0]} could not be read — ${bad[0][1]}`
            : `${bad.length} views could not be read (${bad.map(([k]) => k).join(', ')}) — ${bad[0][1]}`;
        }
      }
      emit(parsed, problem, startedAt, session, machine);
    }
    const next = rerun;
    rerun = null;
    if (next && !closed) void run(next.views, next.session, next.extra, next.force, next.machine);
  };

  let lastRequest: { views: string[]; session: string; extra: string[]; machine?: string } | null = null;

  const watcher = core.createWatcher({
    roots: core.observatoryRoots({ cwd: opts.cwd, session: opts.session }),
    onChange: () => {
      if (closed || !lastRequest) return;
      // Back off to twice the last build when that is slower than the floor: a cold six-second read on
      // a fixed three-second tick queues children faster than they finish.
      const floor = Math.max(MIN_TICK_MS, lastDuration * 2);
      if (Date.now() - lastStart < floor) return;
      void run(lastRequest.views, lastRequest.session, lastRequest.extra, false, lastRequest.machine);
    },
    onDegrade: (dir, why) => {
      mode = 'poll';
      opts.onDegrade(`watching ${path.basename(dir)} degraded: ${why}`);
    },
  });
  mode = watcher.stats().every((s) => s.mode === 'poll') ? 'poll' : watcher.stats()[0]?.mode ?? 'native';

  return {
    request(views, session, extra = [], force = false, machine) {
      lastRequest = { views, session, extra, machine };
      void run(views, session, extra, force, machine);
    },
    onData(fn) {
      listeners.push(fn);
    },
    mutate(verb, ids, session, machine) {
      // Serialized: the undo engine appends to a shared log, and two concurrent bulk verbs would
      // interleave. Mutations are never deduped and never dropped — a reviewer's decision is not
      // something to coalesce.
      const p = queue.then(async () => {
        // ONE unit selected → the single-id verb, not `--ids`. The single path is where the engine's
        // whole-unit semantics live: `undo <rep>` sums the chain into one merge (it cannot stop
        // half-reverted) and a refusal arrives as the full named message — dependents, closure and
        // all — instead of a bare conflict count. `--ids` stays for multi-selections, where a
        // per-record scope is the honest semantics.
        if (ids.length === 1 && (verb === 'undo' || verb === 'redo')) {
          const { out, err, code } = await spawnSelf([verb, String(ids[0]), '--session', session, '--json', ...on(machine)]);
          let json: unknown = null;
          try {
            json = (code === 0 || code === 1) && out.trim() ? JSON.parse(out) : null;
          } catch {
            /* reported through err below */
          }
          return { ok: json !== null, json, err: json === null ? err || `${verb} exited ${code ?? '?'}` : null };
        }
        // EXPAND EVERY ID TO ITS REVIEW GROUP FIRST. What a surface displays as one row is often
        // several raw records: `reviewEdits` collapses a same-code chain (a→ab→a) into a single unit
        // and shows the most recent member's id. `--ids` is group-UNAWARE — it acts on raw records —
        // so sending the displayed id alone keeps or reverts one member and leaves the rest pending,
        // at an intermediate state no surface can name. Measured on a real session: 365 raw records
        // collapse to 323 units, 35 of them multi-member, so roughly one row in ten was affected.
        // The single-id CLI verbs already expand via keepGroup/undoGroup; this is the same rule for
        // the id-set path. `groupMembers` returns [id] for an ungrouped edit, so this is safe for all,
        // and `undoScope` sorts newest-first, which is the order a chained group must be reverted in.
        // Another machine's session is expanded THERE (`--units`): this machine's store has no
        // record of its units, so `groupMembers` here would answer [id] and act on one member.
        const expanded: number[] = [];
        const seen = new Set<number>();
        for (const id of ids) {
          for (const m of machine ? [id] : core.groupMembers(session, id)) {
            if (!seen.has(m)) {
              seen.add(m);
              expanded.push(m);
            }
          }
        }
        const { out, err, code } = await spawnSelf([verb, '--ids', expanded.join(','), ...(machine ? ['--units'] : []), '--session', session, '--json', ...on(machine)]);
        let json: unknown = null;
        try {
          json = (code === 0 || code === 1) && out.trim() ? JSON.parse(out) : null;
        } catch {
          /* reported through err below */
        }
        // A conflict exits 1 WITH a full payload, so `ok` follows the JSON, not the exit code.
        return { ok: json !== null, json, err: json === null ? err || `${verb} exited ${code ?? '?'}` : null };
      });
      queue = p.catch(() => undefined);
      return p;
    },
    mutateUnder(verb, under, session, machine) {
      // Same queue as `mutate`: two decisions must not interleave, whichever scope they came from.
      // No id expansion here — `--under` resolves its own set inside the CLI, over whole records, so
      // a review group cannot be half-acted-on the way an `--ids` list could.
      const p = queue.then(async () => {
        const { out, err, code } = await spawnSelf([verb, '--under', under, '--session', session, '--json', ...on(machine)]);
        let json: unknown = null;
        try {
          json = (code === 0 || code === 1) && out.trim() ? JSON.parse(out) : null;
        } catch {
          /* reported through err below */
        }
        return { ok: json !== null, json, err: json === null ? err || `${verb} --under exited ${code ?? '?'}` : null };
      });
      queue = p.catch(() => undefined);
      return p;
    },
    mutateAll(verb, session, machine) {
      // Same queue as the scoped verbs: two decisions must never interleave.
      const p = queue.then(async () => {
        const { out, err, code } = await spawnSelf([verb, '--all', '--session', session, '--json', ...on(machine)]);
        let json: unknown = null;
        try {
          json = (code === 0 || code === 1) && out.trim() ? JSON.parse(out) : null;
        } catch {
          /* reported through err below */
        }
        return { ok: json !== null, json, err: json === null ? err || `${verb} --all exited ${code ?? '?'}` : null };
      });
      queue = p.catch(() => undefined);
      return p;
    },
    resolveAll(session, machine) {
      const p = queue.then(async () => {
        const { out, err, code } = await spawnSelf(['resolve', '--session', session, '--json', ...on(machine)]);
        let json: unknown = null;
        try {
          json = (code === 0 || code === 1) && out.trim() ? JSON.parse(out) : null;
        } catch {
          /* reported through err below */
        }
        return { ok: json !== null, json, err: json === null ? err || `resolve exited ${code ?? '?'}` : null };
      });
      queue = p.catch(() => undefined);
      return p;
    },
    async diff(id, session, machine) {
      // Another machine's session: its blobs are there, and so is the patch.
      if (machine) {
        const { out, err } = await spawnSelf(['diff', String(id), '--patch', '--session', session, ...on(machine)]);
        return out || err;
      }
      // IN-PROCESS first: a spawn per selection (node boot + module load, hundreds of ms) was the
      // whole of "the diff takes forever to appear". `coloredDiff` IS the function the CLI's `diff`
      // verb prints, so the dashboard still shows exactly what `oak diff <id>` shows —
      // one implementation, no drift, and now at blob-read speed.
      //
      // `color: false` IS LOAD-BEARING. The TUI is not a printer, it is a RE-RENDERER: richdiff
      // classifies each line by a literal `+`/`-`/`@@` prefix and paints the full-width background
      // bands from that. A pre-coloured line starts with `\x1b[31m`, so every changed line fell
      // through to `kind:'ctx'` — no band, foreground-only text, `---`/`+++` headers leaking into
      // the pane, and the gutter numbering every line as context. The old spawn path passed raw
      // bytes only by accident (a child's stdout is a pipe, so the CLI's isTTY() was false), which
      // is why this looked like a regression with no obvious cause. Colour belongs to whoever
      // PRINTS the patch; this caller renders it.
      try {
        const rec = opts.core.readLog(session).find((r) => r.id === id);
        if (rec) return opts.core.coloredDiff(session, rec, false);
      } catch {
        /* a torn store still answers — through the CLI below */
      }
      // The spawn survives as the fallback (an id the in-process read cannot see, a mid-write log):
      // `--patch` because the verb's human trailer ("keep #5 · undo #5") is not diff content.
      const { out, err } = await spawnSelf(['diff', String(id), '--patch', '--session', session]);
      return out || err;
    },
    async check() {
      const { out, err } = await spawnSelf(['version', '--check']);
      const text = (out || err || '').trim();
      // No silent fail: an empty answer is reported as one, never as "up to date".
      return text.split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'no update information came back';
    },
    updateSkew() {
      return bootStamp !== '' && stampSelf() !== bootStamp;
    },
    async run(args, machine) {
      const { out, err, code } = await spawnSelf([...args, ...on(machine)]);
      return code === 0 ? out : (err || out || `exited ${code}`);
    },
    watcherMode() {
      return mode;
    },
    close() {
      closed = true;
      watcher.close();
      worker.close(); // the warm worker dies with the dashboard — never an orphan
    },
  };
}

/** One long-lived `views --serve` child. */
export interface ServeWorker {
  /** One batch of views; the payload line, or null when the worker cannot answer (the caller falls back to
   *  a cold spawn). Requests queue: one is in flight at a time. */
  request(views: string[], args: string[]): Promise<string | null>;
  close(): void;
}

const SERVE_TIMEOUT_MS = 60_000;

/**
 * When a warm worker is retired, so the next request starts a fresh one. A worker keeps what its reads
 * parsed: after a cold-cache listing of real-size sessions each held 1.5–1.8 GB for the TUI's whole life
 * while a worker started on the caches that listing persisted stays near 100–500 MB.
 * So a worker is retired after `idleMs` without a request, or when an answer leaves it above `rssBytes`
 * resident — checked at most every `checkEveryMs`, and acted on at most every `rssEveryMs`, so a working
 * set that is simply that large (a huge live transcript) is re-read now and then, not after every read.
 * Retirement waits for the request in flight: nothing is killed mid-answer.
 */
export interface ServeRecycle {
  idleMs: number;
  rssBytes: number;
  checkEveryMs: number;
  rssEveryMs: number;
  /** The worker's resident size in bytes, null when unknown: by default the size it reported with its
   *  last answer (`views --serve` leads each one with `{"__rss":<bytes>`), so no probe is spawned. */
  rss(pid: number): Promise<number | null>;
}
// Idle is minutes, not seconds: a pinned conversation whose transcript went quiet asks nothing, and the
// first read after a retirement starts a worker (~1 s more for that read, measured 2026-09-26).
const RECYCLE: Omit<ServeRecycle, 'rss'> = { idleMs: 5 * 60_000, rssBytes: 1024 ** 3, checkEveryMs: 5_000, rssEveryMs: 10 * 60_000 };

/** The resident size a `views --serve` answer reports at its head, without parsing the payload. */
function reportedRss(line: string): number | null {
  if (!line.startsWith('{"__rss":')) return null;
  const bytes = parseInt(line.slice(9, 29), 10);
  return Number.isFinite(bytes) ? bytes : null;
}

/**
 * The WARM views worker (perf, 2026-08-19). A cold `views` spawn per poll re-derived everything
 * from zero — node start, six transcript parses, the store's blob diffs — measured at 2.9s per
 * batch on a 39 MB session, which throttled the poll to ~6s and pegged a core half the time. One
 * long-lived `views --serve` child keeps fscache warm (it revalidates every lookup by stat, so
 * answers stay exact); the same batch answers in ~60 ms. Requests are one JSON line in, one JSON
 * payload line out, strictly one at a time. A dead or wedged child is killed and the request FALLS
 * BACK to a cold spawn — slow truth over no truth. A spawner whose children have no stdin pipe is not
 * asked again; a child whose stdin closed is replaced on the next request.
 */
export function createServeWorker(core: Core, cwd: string, selfPath: string, recycle: Partial<ServeRecycle> = {}): ServeWorker {
  /** The current worker's resident size, from its last answer. */
  let reported: number | null = null;
  const policy: ServeRecycle = { ...RECYCLE, rss: async () => reported, ...recycle };
  let serve: import('child_process').ChildProcess | null = null;
  // Pending serve-child output as CHUNKS, framed per chunk. Accumulating a string and searching it for
  // `\n` on every 64 KB read flattened the whole 10 MB payload once per chunk — O(n²), ~1.4 s of blocked
  // event loop per dashboard poll on a big session (measured 2026-09-19). A newline is found in the chunk
  // that carries it; the parts are joined once, when a line completes.
  let parts: Buffer[] = [];
  let waiter: ((line: string | null) => void) | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let usable = true;
  let idle: NodeJS.Timeout | undefined;
  let checkedAt = 0;
  let rssRetiredAt = -Infinity;
  /** A worker found over the RSS bound while it was answering: retired once that answer is in. */
  let over: import('child_process').ChildProcess | null = null;
  /** Kill the worker and fail its pending request. Only the CURRENT worker: a late event from one
   *  already replaced must not kill its successor or answer the successor's request. */
  const retire = (child: import('child_process').ChildProcess | null): void => {
    if (!child || child !== serve) return;
    if (idle) clearTimeout(idle);
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    serve = null;
    parts = [];
    const w = waiter;
    waiter = null;
    w?.(null);
  };
  const ensure = (): import('child_process').ChildProcess | null => {
    if (serve && serve.exitCode === null && !serve.killed) return serve;
    parts = [];
    reported = null;
    let child: import('child_process').ChildProcess;
    try {
      child = core.spawnTool(process.execPath, [selfPath, 'views', '--serve'], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1' },
      });
    } catch {
      serve = null;
      return null;
    }
    serve = child;
    // A spawner that gives the child no stdin pipe cannot serve: stop asking, rather than spawn per request.
    if (!child.stdin?.writable) usable = false;
    child.stdout?.on('data', (d: Buffer) => {
      if (child !== serve) return;
      let rest = d;
      let nl: number;
      while ((nl = rest.indexOf(10)) >= 0) {
        parts.push(rest.subarray(0, nl));
        const line = Buffer.concat(parts).toString('utf8');
        parts = [];
        rest = rest.subarray(nl + 1);
        reported = reportedRss(line);
        // A line with no waiter is a late answer to a request already timed out — dropped; the
        // fallback spawn answered it.
        const w = waiter;
        waiter = null;
        w?.(line);
      }
      if (rest.length) parts.push(rest);
    });
    child.stderr?.on('data', () => {
      /* a view's stderr is reported per batch via __problems; the pipe just keeps it off the screen */
    });
    child.on('exit', () => retire(child));
    child.on('error', () => retire(child));
    // A write to a worker that died between the check and the write is an EPIPE on the STREAM — an
    // unhandled stream error is an uncaughtException that took the whole dashboard down (TUI sweep).
    child.stdin?.on('error', () => retire(child));
    return child;
  };
  const once = (views: string[], args: string[]): Promise<string | null> =>
    new Promise((resolve) => {
      const child = usable ? ensure() : null;
      if (!child) return resolve(null);
      // A worker whose stdin has closed (it is exiting) answers nothing: retire it, so the next request
      // starts another. This one falls back.
      if (!child.stdin?.writable) {
        retire(child);
        return resolve(null);
      }
      // A wedged worker must not stall its caller forever — kill it; the cold path answers.
      const timer = setTimeout(() => retire(child), SERVE_TIMEOUT_MS);
      timer.unref?.();
      waiter = (line) => {
        clearTimeout(timer);
        resolve(line);
        answered(child);
      };
      try {
        child.stdin.write(JSON.stringify({ views, args }) + '\n');
      } catch {
        clearTimeout(timer);
        waiter = null;
        retire(child);
        resolve(null);
      }
    });
  /** After an answer (see ServeRecycle): retire a worker flagged over the bound, re-arm the idle rule, and
   *  now and then ask how much the worker holds. */
  const answered = (child: import('child_process').ChildProcess): void => {
    if (child !== serve) return;
    if (over === child) {
      over = null;
      return retire(child);
    }
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => { if (child === serve && !waiter) retire(child); }, policy.idleMs);
    idle.unref?.();
    const now = Date.now();
    if (now - checkedAt < policy.checkEveryMs || now - rssRetiredAt < policy.rssEveryMs || typeof child.pid !== 'number') return;
    checkedAt = now;
    void policy.rss(child.pid).then((bytes) => {
      if (bytes === null || bytes <= policy.rssBytes || child !== serve) return;
      rssRetiredAt = Date.now();
      if (waiter) over = child;
      else retire(child);
    });
  };
  return {
    request(views, args) {
      const p = queue.then(() => once(views, args));
      queue = p.catch(() => undefined);
      return p;
    },
    close() {
      usable = false;
      retire(serve);
    },
  };
}

/** Conversation I/O uses the same CLI boundary as dashboard views, off the paint thread. This machine's
 * reads go through one warm `views --serve` child; another machine's, and anything the worker cannot
 * answer, run as a child of their own. Closing a tab/runtime discards answers without blocking input. */
export interface ConversationReader {
  read(session: string, root: string, cursor?: number, machine?: string, source?: string): Promise<import('@oak-observatory/core').ConversationResult>;
  diff(session: string, id: number, machine?: string): Promise<string>;
  fleet(session: string, root: string, machine?: string): Promise<Record<string, unknown>>;
  /** The `sessions` view for one session — the master rows' facts — computed in the child, not on the
   *  paint thread (`core.sessionMeta` is ~200 ms on a 300-session store; measured 2026-09-19). */
  sessions(session: string, root: string, machine?: string): Promise<unknown>;
  /** Records review comments as sent on the saved machine that holds them: a reply delivered to its
   *  pane through herdr leaves that machine's ledger untouched otherwise, and the same comments
   *  would be drafted again. Rejects with the CLI's reason. */
  markCommentsSent(session: string, ids: string[], machine: string): Promise<void>;
  mirror?(session: string, root: string): Promise<{ mirrored: boolean; syncedAt?: number }>;
  /** Has a saved machine name the herdr tab of one of its sessions itself (`oak __tab-sync` there), by
   *  its own record and its own current title; `claimed`, a name this app recorded giving that tab, is
   *  taken on there while the tab wears it. False when its OAK is from before that verb; `'unlinked'` when
   *  that machine holds no herdr pane link for the session, so cannot name its tab; rejects when the
   *  machine cannot be reached. */
  syncTab?(session: string, machine: string, claimed?: string): Promise<boolean | 'unlinked'>;
  close(): void;
}
export function createConversationReader(core: Core, cwd: string): ConversationReader {
  const children = new Set<import('child_process').ChildProcess>();
  let closed = false;
  const on = (machine?: string): string[] => machine ? ['--machine', machine] : [];
  // A pinned, working session read its conversation, workers, previews and the session list with a cold
  // `oak` start each: 180+ processes and over a core a minute. One warm child
  // answers this machine's reads; a view it could not build is asked of a cold child, whose error
  // message is the one worth showing.
  const warm = createServeWorker(core, cwd, process.argv[1]);
  const view = async (name: string, args: string[]): Promise<unknown> => {
    if (closed) return undefined;
    const line = await warm.request([name], args);
    try {
      const payload = line === null ? null : JSON.parse(line) as Record<string, unknown> | null;
      return payload && typeof payload.__fatal !== 'string' && payload[name] != null ? payload[name] : undefined;
    } catch {
      return undefined;
    }
  };
  const run = (args: string[], machine?: string): Promise<string> => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('Conversation reader is closed')); return; }
    const child = core.spawnTool(process.execPath, [process.argv[1], ...args, ...on(machine)], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1', ...(machine ? { OAK_MACHINE_TIMEOUT_MS: '45000' } : {}) },
    });
    children.add(child);
    const out: Buffer[] = [], err: Buffer[] = [];
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      reject(new Error(machine ? `${machine} conversation read timed out` : 'Conversation read timed out'));
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); killTimer.unref?.();
      child.kill();
    }, 60_000);
    timer.unref?.();
    const done = () => { clearTimeout(timer); clearTimeout(killTimer); children.delete(child); };
    child.stdout?.on('data', (data: Buffer) => out.push(data));
    child.stderr?.on('data', (data: Buffer) => err.push(data));
    child.on('error', error => { done(); reject(error); });
    child.on('close', code => {
      done();
      if (code !== 0) reject(new Error(Buffer.concat(err).toString('utf8').trim() || `Conversation read exited ${code ?? '?'}`));
      else resolve(Buffer.concat(out).toString('utf8'));
    });
  });
  return {
    async read(session, root, cursor, machine, source) {
      const window = cursor === undefined ? ['--limit', '50'] : ['--since', String(cursor)];
      const result = (machine ? undefined : await view('conversation', ['--session', session, '--root', root, ...window]) as import('@oak-observatory/core').ConversationResult | undefined)
        ?? JSON.parse(await run(['conversation', '--json', '--session', session, '--root', root, ...window,
          ...(machine ? ['--with-source', ...(cursor !== undefined && source ? ['--source', source] : [])] : [])], machine));
      if (!result || !Array.isArray(result.events) || !(result.cursor === null || Number.isSafeInteger(result.cursor)))
        throw new Error('Conversation read returned invalid JSON');
      return result;
    },
    async diff(session, id, machine) {
      // The patch `oak diff <id> --patch` prints, trailing newline included.
      const warmPatch = machine ? undefined : await view('diff', [String(id), '--session', session]) as { patch?: unknown } | undefined;
      return typeof warmPatch?.patch === 'string' ? `${warmPatch.patch}\n` : run(['diff', String(id), '--patch', '--session', session], machine);
    },
    async fleet(session, root, machine) {
      const result = (machine ? undefined : await view('multitask', ['--session', session, '--root', root]) as { agents?: { session: string }[] } | undefined)
        ?? JSON.parse(await run(['multitask', '--json', '--session', session, '--root', root], machine));
      const agent = result.agents?.find((row: { session: string }) => row.session === session);
      // An uncaptured session can be absent from the fleet; its subagents are still discoverable.
      if (agent) return { subagents: agent.subagents, todos: agent.todos };
      const workers = JSON.parse(await run(['subagents', '--json', '--session', session, '--root', root], machine));
      return { subagents: workers.subagents ?? [], todos: [] };
    },
    async sessions(session, root, machine) {
      if (machine) {
        const result = JSON.parse(await run(['sessions', '--json', ...(session ? ['--session', session] : []), '--root', root], machine));
        if (!Array.isArray(result?.sessions)) throw new Error(`${machine} sessions read returned invalid JSON`);
        return result;
      }
      const listed = await view('sessions', ['--session', session, '--root', root]);
      if (listed !== undefined) return listed;
      const result = JSON.parse(await run(['views', '--views', 'sessions', '--json', '--session', session, '--root', root], machine));
      if (!result || typeof result !== 'object' || !('sessions' in result)) throw new Error('Sessions read returned invalid JSON');
      return result.sessions;
    },
    mirror: async (session, root) => JSON.parse(await run(['conversation', '--source-info', '--json', '--session', session, '--root', root])),
    async markCommentsSent(session, ids, machine) {
      const result = JSON.parse(await run(['comment', 'mark-sent', '--session', session, '--ids', ids.join(','), '--json'], machine));
      if (typeof result?.marked !== 'number') throw new Error('mark-sent returned invalid JSON');
    },
    async syncTab(session, machine, claimed) {
      let out: string;
      try { out = await run(['__tab-sync', session, ...(claimed ? [`--claimed=${claimed}`] : [])], machine); }
      catch (error) {
        if (/unknown command "__tab-sync"/.test(error instanceof Error ? error.message : String(error))) return false;
        throw error;
      }
      // The verb prints nothing, or `unlinked` for a session it holds no pane link for: an OAK that answers
      // with anything else (help text) did not run it.
      return out.trim() === 'unlinked' ? 'unlinked' : out.trim() === '';
    },
    close() { closed = true; warm.close(); for (const child of children) child.kill(); children.clear(); },
  };
}
