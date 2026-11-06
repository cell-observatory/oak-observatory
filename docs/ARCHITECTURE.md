# Architecture

The "how it really works" companion to [CONTRIBUTING.md](../CONTRIBUTING.md). CONTRIBUTING tells you
*where to put code*; this file tells you *why the pieces fit together* — the dependency graph, the
on-disk store, the shared view-models, the hand-mirrored Kotlin ports, and the exact `--json`
contract the machine-readable surface guarantees. Every claim below is grounded in the real files.

## Dependency graph

```
   packages/core  ──(re-exported from src/index.ts)──►  packages/cli
   pure TS engine                                        `oak` bin
   runtime dependencies: `diff`, `smol-toml`            main() = switch(argv[0]) → emitJson
        │                                                        │
        │ import * as core                                       │ subprocess:  … --json
        ▼  (in-process)                                          ▼
   packages/vscode                                        packages/jetbrains (Kotlin)
   renders core's view-models directly;                   never imports core.
   spawns the CLI for sessions and heavy scans            • mutations + views + sessions → ObservatoryCli (over CLI)
                                                           • store reads → StoreReader (off disk)
```

- **`core` → `cli`.** The CLI imports `@oak-observatory/core` and is the single source of truth
  both editors consume. `packages/cli/src/index.ts` is one `main()` with a `switch` on `argv[0]`;
  each `case` calls a `core` function and, for the machine surface, serializes with
  `emitJson(v) = process.stdout.write(JSON.stringify(v))`.
- **`cli` → `vscode` (in-process).** `packages/vscode/src/extension.ts` does
  `import * as core from '@oak-observatory/core'` and calls `core.buildEditTree`,
  `core.undoEdit`, `core.setStatus`, `core.readLog`, `core.fileMemory`, … directly. It *spawns* the CLI
  for session listings and transcript-wide scans — `sessions`, `stats`, `prompts`, `feed`, and one
  `views` call carrying the Overview's payloads (`changemap` + `multitask` + `processes` + `sessions`) — so a multi-gigabyte parse
  never runs on the UI thread.

  That last reason is load-bearing, not habit. Building the change map in-process was tried and
  reverted: measured, it blocked the extension host for **2.8 s** on the largest session in a real
  workspace, and ~700 ms on *every* tick for the active one, whose cache invalidates each time its
  transcript grows. A spawn costs more total CPU and blocks nothing, which is the trade this seam
  exists to make. What WAS wasteful is paying for three processes to get three views: `views` runs
  them in one, each produced by its own command, so the payloads are identical to asking separately.
- **`cli` → `jetbrains` (over the CLI).** The Kotlin plugin never links `core`. It shells out to
  `oak … --json` via `core/ObservatoryCli.kt` for every **mutation**
  (`keep`/`undo`/`redo`/`clean`) and every **diff-dependent read** (`locate`, `tree`, `observe`,
  `stats`). Session lists and automatic selection also come from `sessions --json`; there is no
  independent transcript-selection fallback. It reads the raw store **off disk** via Kotlin ports
  (`StoreReader`, `ClaudePaths`). The undo engine's correctness lives in the TS core.

## The store

Everything lives under `CLAUDE_CONFIG_DIR` (default `~/.claude`), resolved by
`claudeConfigDir()` in `packages/core/src/paths.ts`. Per session
(`packages/core/src/store.ts`):

```
~/.claude/claude-observatory/<session_id>/
  log.jsonl            append-only: EditRecord lines + status-op lines
  blobs/<sha256>       whole-file snapshots, content-addressed (deduped)
  staging/<pathHash>   transient "before" snapshot between PreToolUse and PostToolUse
  comments.json        the session's review comments: written by a person, so kept with its log
  sync-generation      oak sync's id of this folder's generation (16 hex digits), written by sync and by a
                       rewrite of the log, never by a capture (see below)
```

Derived caches live beside the sessions, never inside them (`RESERVED_STORE_DIRS` keeps the session
enumerator from mistaking one for a session):

```
<root>/changemap-cache/<session_id>/<key>.json   the session's change map / fleet payload
<root>/changemap-cache/<session_id>/placements.json  where each edit lands in the CURRENT file text
<root>/changemap-cache/<session_id>/deltas.json      per-blob-pair line deltas (+/- for each edit)
<root>/changemap-cache/<session_id>/transcript-facts-v<N>-<key>.json  the shared fold of one transcript
<root>/changemap-cache/<session_id>/conversation.json  resume state behind `conversation --since`
<root>/changemap-cache/<session_id>/search-index-v5.json  conversation search's index, also of a session OAK only read
<root>/remote-cache/session-titles.json          claude.ai Remote Control titles by session id
<root>/remote-cache/machine-usage.json           saved machines' latest Claude readings, machine ids, clock offsets, last outcomes (the usage pull)
<root>/session-meta/<session_id>.json            title + row counts + risk sidecars
<root>/session-meta/provenance/<path-hash>.json   transcript launch cwd + bridge classification
<root>/usage-cursors/<hash(transcript path)>.v<N>.json  byte cursor for incremental usage parsing
<root>/stats-cache-v<N>.json                     Stats' per-transcript aggregates (`stats-cache-claude-v<N>.json`: Claude's alone)
```

The record log (`<root>/records/<machine id>/`, see [The local database](#the-local-database)) is kept beside them under the
same reservation. It is not a cache: it is what this machine published of its sessions, and the copies oak sync keeps of
every other machine's. The record logs' folder and oak sync's state (`<root>/sync/`) each hold `blobs/README`: OAK
0.10's `oak clean` takes a store-root folder it does not know for an empty session and removes it, unless its `blobs/`
holds anything (`keepFromOldClean` in `store.ts`, made with each folder, and in one an earlier build made by every
catch-up and sync run).

Two rules keep these honest, both learned the hard way in 0.9.0:

- **A cache stamp must be the input, not a superset of it.** The change map's project-directory stamp
  carried every sibling transcript's `(mtime, size)` when the only thing derived from that directory is a
  *count of session ids* — so one session appending a line invalidated every other session's map in the
  project. The stamp is now `projectSessionIds(cwd)`, the very call the map derives the value from.
- **The cache version belongs in the file NAME.** Two builds that disagree about a stamp's shape used the
  same path, so each one's write was a permanent miss for the other, with no symptom but slowness. The
  usage cursors and the Stats caches kept it inside the file until 0.11.0. The session sidecar
  (`session-meta/<id>.json`) still does, one stamp per field, so two builds whose stamps differ rebuild
  those fields after each other's writes. A bump leaves the files of the version before addressed by
  nothing, and `oak clean` removes them: transcript facts and map payloads of any other version (a write of
  the facts sweeps those too, so two builds whose facts versions differ also rebuild each other's), and the
  asks scan, the prompts projection, the usage cursors and the Stats caches of an older version only, and
  only there, never as they are read: an editor still running an older build reads and writes its own.

`placements.json` and `deltas.json` are safe to persist only because their keys are fully
content-identified — the current file text is hashed, and blobs are immutable and content-addressed — so
there is no staleness window, and changed content is simply a different key rather than a stale hit.

- **Never persist a derived total you cannot check.** A running line-delta total was tried and removed in
  0.9.0: resuming from it means inheriting it, so a single wrong entry survives every later pass and no
  amount of versioning or boundary-checking can detect it. Cache the *inputs* keyed by content and redo
  the fold; the fold is cheap, and a content key cannot lie.

`transcript-facts-v<N>-<key>.json` (`derived-transcript.ts`) is one transcript folded once and read by every
view that needs actions, tasks, todos, subagents, processes, insights or reasoning, instead of each one
re-parsing the file. Since version 7 it stores prose as timestamped byte offsets and lengths (version 8,
the current one, adds the session's rename to the insights); the Feed selects
its window before reading those source lines. Action reasoning and summaries remain in the facts,
but full replies and thoughts are not duplicated there. The key hashes the schema version (`TRANSCRIPT_FACTS_VERSION`), the SOURCE of the fold
functions themselves, the transcript path and whether sidechains are included — so an edited fold, like a
bumped schema, addresses a different file instead of serving a stale hit, and the version also rides the
file name, which is how `oak clean` reclaims the generation a bump supersedes. The record is checksummed
and written tmp+rename at `0600` under a `0700` directory, and it is accepted only while the transcript's
`(dev, ino, size, mtime, ctime)` and the sampled guard windows over the parsed region all still match.
Retained facts are capped at 64 MiB in memory, and `withoutTranscriptFactsCache` re-runs the same folds
from byte zero with no cache I/O — the seam the equality tests compare the cached answer against.

`conversation.json` is the same idea for the conversation reader: the parser state that its byte
cursor stands for, revalidated against the file's identity and a 64-byte prefix/suffix guard. A cold or
foreign checkpoint costs a replay of the preceding turn; a guard that disagrees, or a cursor past the end
of the file, means the transcript was REPLACED, and the read answers a fresh bounded window with
`reset: true` instead of continuing a conversation that no longer exists.

- `rootDir()` = `<config>/claude-observatory`, or `prefs.storeDir` once the store has been moved (`oak store
  --move`, the terminal app's Options, either editor's Store location); `storeDir(session)` = `<root>/<session_id>`;
  `logPath(session)` = `<storeDir>/log.jsonl`. The root is memoized on `prefs.json`'s inode, size and modification
  time, checked with one `stat` per turn of the event loop, so a process that outlives a move (the terminal app's
  views worker, the VS Code extension host) reads and writes where the store went. A `prefs.json` written in the
  last two seconds is read once a turn whatever its stamp, since a file system with coarse times (FAT, HFS+) can
  date two writes alike, and one that does not parse leaves a process on the root it knows. While a store move holds
  its lock, a process whose answer is a folder that is gone (the store renamed, its new location not yet recorded)
  waits for the move and looks again, once a turn; a move from the default location brings that folder back in one
  rename, `prefs.json` in it already naming where the store went (or, when a process that had not followed the
  store made that folder again meanwhile, moves `prefs.json` into it).
- **A move pauses capture and every decision.** `moveStore` is the one move every surface runs. It takes the store
  move lock in `<config>/claude-observatory-move/lock`, beside the default root rather than in any store, because a
  move from the default location renames that folder away. It then waits for the captures and decisions already being
  written to finish (8 s at most, less than a writer waits, so a move that cannot begin costs no capture), renames
  the store (or, across file systems, copies it entry by entry without its lock files or the focus server's socket,
  keeping the lock fresh through each entry), records the new location in `prefs.json`, removes the original (the
  default folder keeps `prefs.json`), and lets go. A writer registers there (`writer-<id>`) BEFORE it looks for the
  lock, and the move takes the lock BEFORE it looks for registrations, so one always sees the other: either the move
  waits for the writer, or the writer waits for the move, unregistered, and then writes where the store went. The
  capture hooks do it once for their whole run (`captureOutsideMoves`, around `runCapture` and `runCodexCapture`);
  everything else that records a decision, or anything that cannot be rebuilt, does it through `outsideStoreMoves`:
  the session log lock (`withLock`, behind every status, skip, sweep and clean, and each change to the session's
  comments) and the file mutation lock (`withFileMutation`, behind undo, redo, session deletion and the list of
  hidden sessions) take it, and so do the writes no lock runs, each around its whole read and write: a dropped
  session, the update channel and the install ledger. The CLI's decision verbs (keep, undo, redo, resolve, oplog,
  assign, the task verbs, clean, ignore)
  run whole inside it, their reads too: registered only at their first write, one that read before a move renamed the
  store and wrote after found nothing to decide. The terminal app and JetBrains decide through those verbs; VS Code
  calls core in place. A guard inside another runs inside its registration, and the moving process's own writes take
  none. Either waits up to 10 s; past that a capture (a Post, or a Bash command's Pre, whose Post finds no snapshot
  of the tree and records nothing) leaves a `missed-<id>.json` note, which the move (or whoever breaks a crashed
  move's lock) records as a skip in its session, and a decision throws `StoreMovingError` having written nothing. The
  lock and registrations hold `pid:token:monotonic-ms` and are judged stale by the session lock's rules, and the lock
  also once it has gone a minute without a refresh (`MOVE_LOCK_ABANDONED_MS`), whatever its pid says, so a crashed move
  whose pid another process took holds nothing up for more than a minute. A move whose lock was taken that way (it was
  stopped, or one file took a minute to copy) finds its token gone, before it moves anything, once it has copied or
  renamed the store, or once it has recorded a copy's location, and refuses, undoing what it did: the copy is removed,
  the rename reversed, the location put back. A renamed store whose old folder a writer let in meanwhile made again
  stays where it went, and the move says what that folder holds (`left`). A writer that finds the lock stale writes
  once it has broken it or the lock is gone; one whose break the move outran, dating its lock again, waits for the
  move. A location `prefs.json` cannot record undoes the move. Caches and other state OAK rebuilds as it reads
  (`rebuiltAtRoot`) are not guarded: one written where the store was is removed with the original, or, written after
  that, by the next move into that folder, which does not count it as data.
- **Blobs are content-addressed:** `writeBlob` hashes the bytes with sha256 and writes
  `blobs/<sha>` only if absent — identical file states dedupe automatically. `readBlob(session, sha)`
  returns the raw `Buffer` (the `blob <sha>` CLI command streams it).
- **Staging** is the two-phase capture handshake: `PreToolUse` writes a `StagingRecord` (the file's
  pre-edit `beforeBlob`); `PostToolUse` (`PostToolUseFailure` when the tool failed) reads it, snapshots
  the after state, appends the `EditRecord`,
  and deletes the staging file. Bash-driven changes use a per-Pre `__bash__<token>.json` manifest
  instead, keyed by the tree that Pre walked: Bash calls overlap constantly, so one shared manifest had
  a command's Post diffing its walk against another command's snapshot. Whatever a Post records
  advances every other pending snapshot whose tree CONTAINS that file, so no change is recorded twice.
- **Skip markers** are the no-silent-fail escape hatch. When a capture *must* drop a real change — a
  oversized file (text over 5 MB, binary over 25 MB), a missing before-snapshot (Pre didn't run), or a Bash working tree over
  the file cap — `appendSkip` writes a one-line `{op:"skip", file, reason, ts}` op instead of swallowing
  it. `readSkips(session)` folds them out separately and `status` surfaces the gap, so a dropped change is
  loud, not lost.

### Why append-only

From the header of `store.ts`:

> The log is strictly append-only — status changes are appended as ops and folded in on read, so a
> front-end updating a status never rewrites the file and so cannot race-drop a record the capture
> hook appends concurrently.

A status change is a one-line op, not an in-place edit:

```jsonc
{"op":"status","id":3,"status":"kept","ts":1710000000000}
```

`readLog(session)` streams the file, pushes each `EditRecord`, and folds each `{op:"status"}` line
onto the matching record (last op wins). Because writers only ever *append*, the capture hook and an
editor marking an edit "kept" can run concurrently without either clobbering the other. `setStatus`
appends the op (skipping a redundant no-op) and never rewrites. Two paths do rewrite: `clearResolved`
compacts the log to just the pending records and GCs the orphaned blobs, and `clearResolvedIds` does the
same for an explicit id set (`clean --resolved --ids <a,b,c>`). That id set is the scope one prompt or
one task names, which no path can express.

Two more op-line kinds ride the same append-only stream (beside `status`, `skip` and the cumulative
`swept` marker):

```jsonc
{"op":"batch","kind":"undo","ids":[3,4],"prev":{"3":"pending","4":"pending"},"ts":1710000000000}
{"op":"scope","ids":[7],"prompt":"p_ab12","ts":1710000000000}
```

`batch` is the reviewer's own operation journal — `setStatusMany` writes it in the same append as
any ≥2-record status flip, carrying each record's before-status, and `oplog` lists and reverts them.
`scope` is an `assign` attribution override (last op wins per id; an absent `prompt` clears). Both
survive log rewrites via `retainedOpLines`. **Contract: every op kind BEYOND the legacy `status` op
uses `ids` arrays, and no op line ever carries `id` and `file` together.** Readers give `op`
precedence over `id` (core's `parseLogFile` and the Kotlin `StoreReader` both treat any op line as a
control line), but an op carrying both `id` and `file` would have been indistinguishable from an
edit record to older readers.

A rewrite (`clearResolved`, `clearResolvedIds`, the `.observatoryignore` sweep, the case-phantom
repair) writes one more op as the log's first line:

```jsonc
{"op":"id-floor","next":42}
```

`next` is the id the next record would have taken before the rewrite dropped anything, and `nextId`
never allocates below it. Without it, dropping the newest records handed their ids to the next capture,
and a delete confirmed with `--seen-through <newest id it counted>` treated that later edit as one it
had counted. A log with no floor line (never rewritten, or rewritten by an earlier build) allocates from
its newest record, as before.

### A session folder's generation (oak sync)

A session's folder can be lost with no cleanup and made again by its next capture, with a log that starts over. oak
sync (`packages/core/src/sync-store.ts`) tells that folder from the one it replaced by its generation, so no copy of
the earlier one is replaced by it:

- `<session>/sync-generation`: the folder's generation, 16 lower-case hex digits. A run gives an unmarked folder the
  hash of its log's first line (or a random one before it has a log), a push the one its record names it by, and a
  restore the one of the copy its log came from, once that log is back. A folder without one reports that hash,
  unwritten, until a run marks it; a rewrite of the log (a clear, an ignore sweep) writes it down first, so the folder
  keeps it (`keepGeneration` in `store.ts`). A folder made again by a capture after this machine cleaned it up, before
  a run saw it, goes on from the generation of the folder cleaned up (`sessionGeneration`).
- `sync/evicted.jsonl`: a line for a session of this machine's own removed (`noteStoreEviction` in `store.ts`) gains
  `gen`, the generation of the folder it removed.
- `SyncFile.gen` (the inventory `oak __sync-inventory` prints): the generation of the folder each file of OAK's store
  is in, on its log, hook events, comments and agent record (not on its snapshots).
- The backup folder's record (`sync-folder.ts`): each file entry carries `g`, the generation it was written from, and
  each part carries `writer`, the writer id of the machine that wrote it (`sync/writer`, 32 hex digits), sealed with
  the part. A record under this machine's name whose last part carries another writer, or one this machine has not
  taken over, is neither read for a restore nor written. `sync/folder/<folder id>/wrote.json`, `{ mid, seq }`: the
  last part of its record this machine wrote, noted before the part itself; a later part that carries this machine's
  writer id was written by a machine with a copy of its sync state, and the record is refused the same way.
- `<session>_earlier-<generation>`: the session the earlier history of a folder made anew is kept as, in a replica
  and in the backup folder's record (`earlierGenerationId` in `store.ts`), put back like any session and listed as a
  store-only row titled `earlier history of session <its session's id>`, from its own store alone, so the local database
  lists it as the files do. `sync/audit.jsonl` gains the op `earlier` for each copy set apart so.
- `oak sync setup --json` gains `record: { state, lastWrite?, claimed? }`.

## Core data shapes

### `EditRecord` — one captured edit (`store.ts`)

```ts
interface EditRecord {
  id: number;              // monotonic per-session integer — typeable for `diff <id>` / `undo <id>`
  ts: number;              // ms epoch, committed at PostToolUse
  tool: string;            // Edit | Write | MultiEdit | NotebookEdit
  file: string;            // absolute path
  beforeBlob: string | null; // sha256 before (null = new-file Write)
  afterBlob: string | null;  // sha256 after  (null = the edit deleted the file)
  status: EditStatus;      // 'pending' | 'kept' | 'undone'
}
```

### `EditTree` — the folder → file → class → edit view-model (`tree.ts`)

The single structure both editors render, built by
`buildEditTree(session, { root?, filter? }): EditTree`. Folder-chain compaction (`src/utils/…`),
class grouping (line geometry from `ranges.ts` + `classes.ts`), exact `added`/`removed` deltas, and
Search filtering are **all computed here** so neither editor reimplements them:

```ts
interface TreeEdit  { id; ts; tool; file; status; beforeBlob; afterBlob; added; removed }
interface TreeClass { name: string; edits: TreeEdit[] }
interface TreeFile  { rel: string; file: string; classes: TreeClass[]; loose: TreeEdit[] }
interface TreeFolder{ label: string; folders: TreeFolder[]; files: TreeFile[] }
interface EditTree  { folders: TreeFolder[]; files: TreeFile[] }
```

### The observe payload (`cmdObserve` in the CLI, over `observe.ts`)

One JSON blob for an Observations-style view — `{ session, recap, insights, suggestions, edits[] }`,
where each edit carries `{ id, ts, tool, file, status, summary, reasoning, flags, memory, analysis }`.
`reasoning`/`insights` are parsed from the Claude Code session transcript (zero tokens); `memory` is
the observatory's cross-session accept/revert history for the file; `flags` mark revert-risk.

### `StatsResult` — usage trends (`stats.ts`)

```ts
interface StatsResult {
  daily: DayStat[];   // last 30 days, oldest → newest
  hourly: HourStat[]; // today, 24 local-hour buckets
  windows: { session: StatMetrics; day: StatMetrics; week: StatMetrics; month: StatMetrics };
  generatedAt: number;
}
```

Computed by `computeStats(session?)` with an incremental on-disk cache keyed on each transcript's
`(mtime, size)` — only changed files are re-parsed. Meant to run in the `stats` subprocess.

### `SessionMeta` — the fast session listing (`observe.ts`)

```ts
interface SessionMetaRow {
  id: string;
  title: string | null;   // preferredSessionTitle: a rename, else the claude.ai Remote Control title, else the latest ai-title, else the first user prompt (Codex: codexSessionTitle); else "New Claude session" / "New Codex session"
  lastActiveMs: number;   // conversation recency: the TRANSCRIPT's mtime (log.jsonl's when it vanished)
  lastTurnMs?: number | null; // when it last took a turn: its newest user/assistant record (Codex: response item); a resume's bookkeeping never moves it. Null: it never took one; absent: unknown (no readable file, or no turn in its last 8 MB)
  turnOpen?: boolean;     // Codex: the rollout's last task_started has no task_complete or turn_aborted after it (the rollout's derivation keeps it, `codexDerivedTurnOpen`; else `codexTurnOpen` reads back from the end); asked for a session active in the last two hours, absent for Claude. paneAgentState reads it with lastActiveMs
  current: boolean;       // the session `resolveSessionId(cwd)` currently answers with
  edits: number;          // captured edits, from the store log
  pending: number;        // …of which still awaiting review
  files: number;          // distinct files they touched
}
interface SessionMeta { active: string | null; sessions: SessionMetaRow[] }
```

`sessionMeta(cwd, reviewing?)` lists this machine's sessions grouped by workspace, the editor root first
and the newest conversation first within each group, plus the
session being reviewed (a conversation that only asked and read has no store, and would otherwise be
missing from its own workspace's list). Each row costs one `stat` of the transcript plus cached facts,
never a fresh parse of either file, and a listing of its `subagents/` directory with one `stat` per agent
transcript (`activeWorkers`; only one written in the last two hours is read). Titles come from
`fastSessionTitle`, a bounded scan — the transcript's last 4 MB for the newest `custom-title` (a rename
made with `/rename`, or on claude.ai or the Claude app), the newest `ai-title` and the newest
`bridge-session` id, then its first 256 KB for the first real user prompt. `preferredSessionTitle` states
the order every surface uses: the rename, then the title claude.ai holds for the session's Remote Control
id, then the `ai-title`, then the prompt. A Codex session is titled by `codexSessionTitle` instead, and
`sessionViewTitle` gives the change map's summary and the Stats headers that same title. The sidecar
caches the scan's parts, never the answer, because
the claude.ai title comes from its own cache (`<root>/remote-cache/session-titles.json`, `remote-titles.ts`):
a detached `oak titles --refresh --if-due` (in VS Code, an in-host refresh) fills it from
`GET /v1/code/sessions` at most every five minutes, locked and throttled, and nothing on a read path
touches the network. Each scan's result is cached in a per-session sidecar at
`<root>/session-meta/<id>.json`, keyed to the transcript's `(mtime, size)` exactly as the stats cache is,
and written through a pid-scoped temp file plus a rename, so a concurrent reader sees old-or-new and
never a torn file. A cold CLI process answers a listing from those stats plus one sidecar read per
session, and pays the bounded scan only where a transcript changed since its last scan.

That sidecar is now the general mechanism, not a title cache: `sidecarMemo(sessionId, field, stamp, fn)`
holds one derived fact per field with **its own** stamp, so a fact keyed to the store log survives a
transcript that grew, and the other way round. Four facts live there — the title (transcript stamp), the
row counts (log stamp), a sibling's risk tally (transcript stamp), and the subagent digests (the
subagent directory's stamps). Every editor surface runs in fresh CLI processes seconds apart, where an
in-process memo can never survive, so anything derived from a finished session's files was otherwise
recomputed forever: re-parsing every sibling's transcript for its risk count was most of what made a
session switch slow. Liveness-derived facts are deliberately excluded — an agent's phase comes from how
long ago its file was written, and a remembered phase would report a working agent as done.

## The hand-mirrored Kotlin models

The JetBrains plugin **hand-mirrors** the TS types field-for-field (Gson has no shared schema), so
they must never drift. The mirrors:

| TS source | Kotlin mirror | What it holds |
| --- | --- | --- |
| `core/src/store.ts` (`EditRecord`, `readLog`, blobs) | `core/StoreReader.kt` + `model/Models.kt` | reads `log.jsonl` off disk, folds `{op:"status"}` ops, reads blobs |
| `core/src/observe.ts` (`sessionMeta`) | `model/Sessions.kt` | parses `sessions --json`; preserves workspace order and uses its `active` id for automatic selection |
| `core/src/paths.ts` (`claudeConfigDir`) | `core/ClaudePaths.kt` | resolves the config dir + store paths |
| `core/src/tree.ts` (`EditTree` et al.) | `model/Tree.kt` (`EditTree` + `TreeParser`) | parses `tree --json` into `TreeFolderNode`/`TreeFileNode`/`TreeClassNode`/`TreeEditNode` |
| `cmdObserve` payload | `model/Observe.kt` (`ObservePayload` + `ObserveParser`) | parses `observe` |
| `core/src/sync-engine.ts` (`SyncStatusResult`, `SyncNowResult`) and the CLI's `sync setup --json` | `model/Sync.kt` (`SyncStatusParser`, `SyncNowParser`, `SyncSetupParser`) | parses `sync status`, `sync now` and `sync setup` for the status bar widget, the Settings page and the Sessions tab |

**Port-fidelity tests** guard the mirrors — "the Kotlin reader must never drift":

- `packages/jetbrains/src/test/kotlin/com/cellobservatory/observatory/core/StoreReaderTest.kt` —
  asserts append-only `log.jsonl` semantics: `EditRecord` lines + `{op:"status"}` folding (last op
  wins), tolerance of unparseable lines, and blob reads, against fixtures written in the TS format.
- `packages/jetbrains/src/test/kotlin/com/cellobservatory/observatory/model/SessionsRowsTest.kt` —
  verifies the CLI listing contract, workspace order, statistics and rejection of legacy remote rows.
- `packages/jetbrains/src/test/kotlin/com/cellobservatory/observatory/platform/SessionSelectionTest.kt` —
  proves an empty CLI listing cannot fall back to a mirrored transcript on disk.
- `packages/jetbrains/src/test/kotlin/com/cellobservatory/observatory/model/SyncModelTest.kt` and
  `platform/SyncSurfaceTest.kt` — parse oak sync's answers, the second through this tree's CLI.

If you change a store or session read, update the port **and** these tests in the same PR.

### `ChangeMap` — the session's changes, rolled up (`changemap.ts`)

`buildChangeMap(cwd, session, { root, prompts })` places every review-unit edit as
`module → file → class`, then rolls it up **once** so no front-end re-aggregates: `files[]` and
`modules[]` arrive churn-sorted, each with a pre-rendered `moduleLabel`, a worst-unreviewed-wins
`status`, and `maxId` — the drill-through target a click opens. Tasks come from Claude's own plan: the
`TodoWrite` checkpoints merged with the numbered task list `tasks.ts` mines from the same transcript.
Attribution to them is **strict** — an edit joins a task only when its commit timestamp falls inside a
real `in_progress` interval — so an edit outside every interval carries `taskId: null` and collects in
the explicit unassigned bucket. Setting `prompts: true` costs one more transcript pass and fills
`prompts[]`, the same session sliced by the user's own turns. The fleet leaves that flag off, because no
ask typed into this window scopes a sibling worktree's map.

0.8.0 adds **three per-edit attribution dimensions** on top of that — every `ChangeMapEdit` gains a
stable-content-hash `taskId` (`sha1(todo-content).slice(0,12)`), a `subagentId` (the subagent that
authored it, only set when correlated — never guessed), and a `workflowId` (the `wf_<id>` whose agent
ts-window it fell in, `null` when none or ambiguous). They roll up **four ways**: `rollupByTask`,
`rollupBySubagent`, and `rollupByWorkflow` on the map itself (each carries its explicit `null`
unassigned / main-chain / no-workflow bucket), plus `rollupByAgent(maps[])` — a per-session roll that
unions the subagent rolls across a whole fleet of change-maps. The mechanism (strict `in_progress`
intervals, the honest unassigned rule, and the cross-worktree fold) is detailed in
[Multi-agent](#multi-agent-080-worktree-correlation-honest-attribution-real-time) below.

```ts
interface ChangeMap {
  summary: ChangeMapSummary; edits: ChangeMapEdit[]; compactions: CompactionMarker[];
  files: ChangeMapFile[]; modules: ChangeMapModule[];
  tasks: TaskInfo[];                 // strict-span task identities: stable taskId → to-do content
  rollupByTask: TaskRoll[];          // per-task rollup (strict spans); taskId:null = the unassigned bucket
  rollupBySubagent: SubagentRoll[];  // per-subagent rollup; subagentId:null = main-chain / unattributed
  rollupByWorkflow: WorkflowRoll[];  // per-workflow rollup; workflowId:null = no-workflow / ambiguous
  workflows: ChangeMapWorkflow[];    // per-workflow Overview slice: rollup + files + its taskIds
  prompts: ChangeMapPrompt[];        // per-prompt slice; built only when `prompts: true`, else empty
}
interface ChangeMapFile {
  rel: string; module: string; moduleLabel: string; file: string;
  churn: number; cnt: number; added: number; removed: number;
  kept: number; pending: number; undone: number;
  status: EditStatus;        // worst-unreviewed-wins: pending > undone > kept
  maxId: number;             // newest edit id — what a click on this row opens
  classes: string[];
  agent: boolean; risk: string | null; reason: string | null;
}
interface ChangeMapModule {
  module: string; label: string; churn: number; cnt: number;
  added: number; removed: number;
  kept: number; pending: number; undone: number;
  status: EditStatus; files: number;
}
interface ChangeMapPrompt {
  id: string;                        // stable prompt id — the same one `prompts --json` emits
  index: number;                     // 1-based chronological position, the way a person counts turns
  text: string;                      // the ask itself, whitespace-collapsed and COMPLETE — renderers wrap it
  title: string;                     // its first line, capped — for a button label or a tooltip head
  ts: number; endTs: number;         // endTs is 0 while this is the ask still being answered
  rollup: { edits: number; added: number; removed: number; pending: number; kept: number; undone: number };
  files: ChangeMapFile[]; modules: ChangeMapModule[];
  editIds: number[];                 // raw store ids this ask committed — the scope its review ops act on
  agentIds: string[];                // subagents spawned while answering
  workflowIds: string[];             // workflow runs started while answering
  processIds: string[];              // background shells launched while answering
  actions: number; errors: number; compactions: number; durationMs: number;
}
```

### `WorkflowRun` — a multi-agent workflow run, rolled up (`workflows.ts`)

A Claude Code **workflow run** is a scripted fan-out of agents one level *above* subagents — and
`parseSubagents` deliberately skips the `workflows/` subdir, so without this aggregator a workflow's
agents are invisible. `parseWorkflows(cwd, session)` returns the runs newest-first (by last transcript
activity). It reads the **rich per-run state file** `<session>/workflows/wf_<id>.json` when present — the
run's informative name/summary, declared phases, and a `workflowProgress` stream of phase markers +
labeled agent entries — and **falls back** to the run dir's `journal.jsonl` + naming script
(`scripts/<name>-wf_<id>.js`, brace-matched and regex-read, never executed) for older runs. Per-agent
**edits and ±lines are always mined from each agent's own `agent-<id>.jsonl` transcript** (reusing
`parseTranscriptActions` + a single diff pass — the store can't attribute workflow agents, and the state
file doesn't carry them); run-level tokens/`durationMs` prefer the state file's totals. Honest by
construction: an unrecoverable field is `0`/`null`, never fabricated.

```ts
interface WorkflowRun {
  id: string; name: string; description?: string; phases: string[];
  agents: WorkflowAgent[];            // per-agent label/phase/agentType/done/tokens/durationMs/edits/±lines
  phaseGroups: WorkflowPhaseGroup[];  // agents grouped by phase title, in order, per-phase done/total
  running: boolean;                   // freshness-gated (see below)
  agentCount; tokens; durationMs; edits; added; removed; startedTs; lastTs: number;
  sparkline: number[];                // 20-bin activity histogram over all agents' assistant turns
}
```

The `sparkline` is a 20-bin, span-normalized activity histogram — one tick per counted assistant turn,
bucketed with a loop-based min/max (not `Math.min(...ts)`, which a long run's timestamp array could blow
the stack on) — built **identically to the Fleet-row sparkline** so Workflows rows render the same
mini-chart. `running` is **freshness-gated**: the state file reads `status:'running'` until the runner
writes `'completed'`, but a killed/interrupted/crashed run never writes that — so `running` is `true` only
when the run is *also* fresh (the newest mtime among the state file + agent transcripts is within
`FLEET_ACTIVE_MS`). An interrupted run that never completed is therefore **not** shown running (the exact
"shows two running things that aren't" bug). A parallel `workflowWindows` / `workflowForTs` pair attributes
parent-session store edits to a workflow by ts-window — a ts inside two *different* workflows' windows is
honestly `null`, never guessed — and is the source of `edit.workflowId`.

## Multi-agent (0.8.0): worktree correlation, honest attribution, real-time

0.8.0 turns the single-agent store into a **fleet view** — still zero extra Claude tokens, still fully
local, and the git part is **git-free**: it reads the `.git` **pointer files** git already keeps on
disk, never shelling out to the git binary.

**Worktree correlation (`session.ts`).** Concurrent Claude sessions launched from different git
**worktrees** of one repo mangle to *different* project dirs, so nothing links them by path.
`repoKeyForSession` recovers the link from those plain files:

- `repoRoot(cwd)` walks up to a valid `.git` directory or `gitdir: ` file. It checks HEAD in the worktree admin directory and accessible objects/refs in its common directory, follows `commondir`, and honors `GIT_CEILING_DIRECTORIES`. An empty directory or arbitrary file named `.git` is not a repository.
- Read `<root>/.git`: a **directory** ⇒ a main working tree, key = `realpath(<root>/.git)`; a **file**
  ⇒ a linked worktree holding `gitdir: <admindir>` — read `<admindir>/commondir`, which points back at
  the **shared** repo, and key on that. Bare repos and pruned/unreadable worktree admin files return
  `null` — never a guess, and a null key never unions unrelated sessions.

`listRepoSiblings(cwd)` (`fleet.ts`) unions every session whose `repoKeyForSession` matches, so a fleet
spread across worktrees resolves to one set. It is strictly **read-only and path-only**: `fleetConflicts`
intersects each sibling's **uncapped** `allFiles` set to surface `FileCollision`s (same file, 2+
agents), comparing only paths so no file contents ever cross between agents. Each sibling carries its
live `phase` (`agentPhase` — a bounded transcript tail-read) and `gitBranch`.

**Live phase detection (`agentPhase` / `agentPhaseDetail`, `actions.ts`).** A row's phase is a bounded,
structural, zero-token read of only the transcript's **tail** (the last 64 KB — never the whole 20-34 MB
file), classified in one pass into `working | awaiting-input | awaiting-permission | idle | errored |
done`. It walks the tail tracking tool_uses still awaiting a result and the trailing event's kind: a
pending `AskUserQuestion`/`ExitPlanMode` ⇒ **awaiting-input** (structural); any *other* pending tool_use ⇒
**awaiting-permission** while the session's raised hand says a permission prompt waits on that agent (a harness
permission prompt writes *nothing* to the transcript; the capture hooks raise the hand, and no hook reports the answer:
a call the person allowed reads awaiting-permission until it returns), **awaiting-input** while the main agent's hand is
an input wait, read as a completed turn (below) once the hand says the main agent's turn ended (idle-done: a Stop, or
Codex's SessionEnd or Interrupt; a worker runs on past it), else **working**, however long the call runs. A hand raised
before the newest pending call's record (its `timestamp`) is not about that call, which reads **working**: the prompt
was answered and the agent went on (Claude Code's capture matcher leaves the result of a call outside it unreported, so
its prompt's hand stays up until that agent starts a captured call, a prompt arrives or the turn stops), or a turn the
hooks saw stop went on (another hook refused the stop). The session listing names the session whose hand it reads, as a
Codex session's transcript is OAK's derivation of its rollout, named for neither. Only a session no hook records (it has
no store), and a Codex subagent's own thread (its hooks write to its parent's store), is disambiguated by staleness:
**working** if fresh, else **awaiting-permission**, a labeled `heuristic`. With no pending tool_use, a trailing *error*
result ⇒ **errored**; a trailing *non-error* `tool_result` ⇒ **working**, because a conversation can never end on a
tool_result — the turn is mid-flight (this is what keeps the live self session reading "working" *between* tool calls
instead of flickering to idle after each result), aging to **done** once long-stale. A completed turn (assistant spoke
and stopped) reads **working** while its child agents still write, else **idle** when recent, **done** past
`DONE_STALE_MS`. `agentPhaseDetail` also returns a `confidence` (`high` = structural, `heuristic` = staleness-derived)
so a front-end never asserts an inferred state as certain.

**Honest, content-hashed attribution (`changemap.ts`).** The Overview's Tasks tab and every task-scoped
op key on a **stable `taskId`** — `taskId(content) = sha1(content).slice(0,12)` — so reordering or
inserting to-dos never renumbers a task, and two identical to-dos deterministically share one id.
Attribution uses **strict `in_progress` intervals** (`inProgressSpansStrict`) with **no edge fill**: a
span starts exactly when a to-do enters `in_progress` (the first span does *not* reach back to time 0)
and an open, never-completed span ends at its **last observed** `in_progress` mtime, never `+∞`. An edit
whose commit ts falls in **no** real interval is honestly `taskId: null` — the explicit **unassigned**
bucket — never force-filed onto the head/tail task. That is the destructive-safety invariant behind
`task-keep` / `task-undo` / `task-clear`, `tasklog`, and the strict rollups: `taskEditIds` selects raw
store ids by the same strict rule, so an edge edit is never in a task's set. The rollup runs **once**,
four ways — `rollupByTask` (`taskId: null` sorted last), `rollupBySubagent`, `rollupByWorkflow`, and
`rollupByAgent` (unions the subagent rolls across a fleet of change-maps).
`crossAgentTaskLog` (`taskLog.ts`) folds every worktree-sibling's change-map by `taskId`, so one logical
task spanning agents/worktrees is a single `TaskLogEntry`; `unassigned` edits are excluded, never swept in.

**Workflow-run tracking (`workflows.ts`).** One level *above* subagents, `parseWorkflows` aggregates each
scripted multi-agent run (`<session>/subagents/workflows/wf_<id>/` transcripts + the rich
`<session>/workflows/wf_<id>.json` state file) into a `WorkflowRun` — per-run and per-agent
tokens/time/edits, phase groups, a freshness-gated `running` flag, and a 20-bin activity sparkline (see the
[`WorkflowRun` shape](#workflowrun--a-multi-agent-workflow-run-rolled-up-workflowsts) above). It surfaces
in the Overview's **Workflows** tab and in `multitask` / `changemap --json` (`edit.workflowId` +
`rollupByWorkflow`). Same terms as everything else here: zero token, git-free, path-only.

**Real-time (`multitask` + JetBrains `TranscriptWatcher`).** The `multitask` payload assembles the
per-agent rows (phase, sparkline, ±diff, tokens·time, nested subagents), the workflow runs, and the
`FileCollision`s in the CLI, so both editors render it thin. To make "live" honest, JetBrains gained a
`TranscriptWatcher` that watches the Claude Code **transcripts** — not just the edit store — bounded to the
fleet's worktree-sibling project dirs, so every panel (Overview and the Timeline's four tabs) rebuilds on **any**
tool call — reads, bash, subagent spawns, to-dos — not only when Claude writes a file. (VS Code already
rebuilt on transcript
change; this brings JetBrains to parity — a window that silently updated on edits alone would be a
no-silent-fail violation.) On macOS it uses a 2s mtime poll (the JDK's default `WatchService` is a slow
poller); on Linux/Windows it uses native inotify/RDC and falls back to the poll on watch exhaustion,
degrading loudly-but-functionally.

**Hot-path memoization (`fscache.ts`, 0.8.0).** One Overview refresh derives several views that each
re-read the same multi-megabyte transcripts, so the pure parsers (`parseTranscriptActions`, `todoSnaps`,
`transcriptInsights`, `reasoningByEdit`, `subagentMeta`, `agentMetrics`) are memoized per
`(path, mtimeMs, size)` — one parse per file per process, revalidated on every call so a long-lived host
(the VS Code extension calls core in-process) can never serve a stale parse. Cached values are treated as
immutable; `parseTranscriptActions` hands out per-call record copies because editId attribution mutates
them. `clearFsCache()` is exported for hosts and tests. On the same principle, JetBrains'
`ObservatoryService` shares one throttled fetch per CLI view (multitask/changemap/observations, ≥3s apart)
across all panels.

**The demo simulator (`demo.ts`, 0.8.0).** `runDemo` replays a scripted session through the REAL
pipeline — transcript lines appended to the real project dir, edits captured via the same
`handleHookPayload` logic the hooks run, a subagent transcript, and a workflow run — inside an isolated
`demo-<hex>` session and a marker-gated `observatory-demo/` folder. It doubles as the live showcase
(`oak demo`) and the e2e fixture (`--fast`); `autoClearDemo` drops a fully reviewed demo
session's store so reviewing the demo leaves no residue, and `cleanDemo` removes every trace.

## The local database

Each machine keeps a SQLite database of what its files hold (`packages/core/src/index/`, the only SQL in OAK). It is a cache
of those files, never their replacement: the transcripts, rollouts and OAK's store stay the truth, a deleted database file
loses nothing they still hold, and the next read rebuilds it. The one exception is the archive (below).

**Where.** `~/.claude/claude-observatory-index/index-v<format>-<key>.sqlite` (beside the store's config, under
`CLAUDE_CONFIG_DIR` when that is set), where `<key>` is the first 16 hex digits of a sha256 of the store's folder. Never
inside the store's own folder: `oak clean` deletes store-root folders it does not know, a store moved onto a network
share would put SQLite's write-ahead log where it is unsafe, and a store move would copy a live database. The folder is
`0700`, the file and SQLite's `-wal` and `-shm` files beside it `0600`, and `PRAGMA secure_delete` is on.

**Runtime.** Node's built-in `node:sqlite`, loaded the first time the database is asked for (never when core loads, and
never by the capture hook, which does not open SQLite). The database needs FTS5, which the Node releases before 22.16 lack
(22.13, 22.14 and 22.15 were checked) and 22.16 has, and no Node 23 release has (each was checked; those before 23.11
also lack `StatementSync.columns`, which every query reads its columns with), so OAK needs Node.js 22 (22.16 or newer)
or 24 or newer (`INDEX_NODES` in `runtime.ts`, which the CLI startup guard, install checks, `engines` and
`oak machine add` follow). The CLI refuses unsupported Node versions before dispatch, including `help`; the capture
hooks alone still record there (the capture bundle runs on Node 20), with the same warning on stderr. An editor
embedding core can still fall back to file readers when its host lacks SQLite. A Node built against the system's SQLite has whatever that has, so FTS5 is probed rather than assumed. Node 22 prints an
ExperimentalWarning as `node:sqlite` loads, which would land on the terminal app's frame: exactly that warning is
dropped while the module loads. Where the database is unavailable (no `node:sqlite`, no FTS5, or `OAK_INDEX=off`), every
reader lists the way it did before the database existed.

**Schema** (version 9, `PRAGMA user_version`). Ordinary tables are STRICT. Session records carry the source machine
(machineHostTag), so a session id can repeat across machines; usage messages are deduplicated by message id. Times are epoch milliseconds; every field a query filters or
sorts on is a typed column with an index; text is searched through FTS5, and a row's whole record rides beside its
columns for display only.

| Table | Holds |
| --- | --- |
| `machines` | This machine and every machine whose rows the database holds: `label`, the name each gives itself (`this machine` for this one), and since version 4 `saved_label`, the label this machine saved it under (herdr's list, which `--machine` takes), as oak sync's last run or the usage pull reached it by; null where it saved none |
| `sessions` (+ `sessions_fts` on title and first prompt) | One row per session with the facts the session listing derives from its files (`SessionListingFacts`), the archive columns `archived_ms` and `archived_reason`, and the stamp of the files the facts came from |
| `session_live` | The inputs of a session's phase; the phase itself is the view `session_phase`, never stored, because it depends on the time it is asked. Since version 4 the view follows a raised hand first, this machine's or one another machine's records brought: `awaiting-permission`, `awaiting-input` (an input or a question) or `done` (a turn's end), never `working` while a hand is up. Since version 3 also its native tab's link (`tab`, from `tab.json`) and the workers found finished, each by its transcript's name with the stamp it was judged at (`workers`; null where no folder of workers is beside the session's transcript) |
| `prompts` (+ `prompts_fts` on the ask and its answer) | Each ask and the prose that answered it, folded by the search's own fold, on every machine |
| `delegated` | Agents started from a brief, their machine, native tab, linked session, report path and OAK-derived state (schema 5), and the agent's worktree with its git state (`worktree_json`, schema 8); these rows travel in the record log |
| `actions`, `agents`, `workflow_runs` | Tool calls (with project key and path within the project), workers and workflow runs |
| `edits`, `edit_ops`, `capture_gaps`, `units`, `edit_facts`, `blobs` | One row per captured record (read with the views' fold, its duplicate ids re-keyed), the oplog, capture gaps, review units and line counts (computed here, where the blobs are), and the blob inventory |
| `attention`, `waits` | Raised hands and the waits the attention ledger recorded; since version 4 every machine's hands, another machine's marked with `synced_ms` |
| `comments` (+ `comments_fts`), `notes` (+ `notes_fts`) | Review comments; plans, memories and skills |
| `tombstones`, `ingest_state`, `meta`, `lease` | Deliberate deletes, each file's cursor and stamp, the database's own records, and the catch-up lease |
| `usage_messages`, `usage_daily` | One row per assistant message at its largest snapshot, kept for ever, and its rollup by day (version 2; see Usage, below). Schema 6 adds `cache_create_1h` and `cost_approx` to both tables, and `worker`, `provider`, `speed`, `geo` and `priced` to messages. `cache_create` holds total cache writes; its one-hour subset is priced separately from the remainder. `priced` identifies the price-table version, so an upgrade reprices old messages and rebuilds their rollups |
| `usage_readings`, `usage_spend`, `accounts` | The shares each machine read of an account's windows and the Claude account's answers on its five-hour limit, the spend Claude Code reported per session, and the accounts seen (version 2) |
| `account_bill_days` | Each account's bill day for Claude and for GPT, as the machine that set it last recorded it with the time it did (schema 7); the rows travel with the usage records and sync, so every machine counts the same month |
| `findings`, `finding_resolutions` | Short facts an agent posted for other agents (`oak finding add`), with the posting session and machine, repository and paths, and their retirements (schema 9); untrusted text, shown quoted, and carried to every machine in the record log |

Rows another machine's record log filled (below) carry `synced_ms`, when they arrived, and their session's `origin` is
`synced`; `local` rows are this machine's own, `pulled` ones a session oak sync copied here into the folder named after
the directory it ran in (once that copy goes before this machine's retention would sweep it, evicted or removed, a
session this machine kept no store of is its machine's again, `synced`, and never archived here), and `replica` ones
what the database read of another machine's store logs; a session pulled here and resumed here keeps this machine's own
capture under its key, which neither that machine's records nor the copy of its store log replace. (An answer's
`freshness.sources[].origin` is another thing: `replica` there marks every machine but this one.) A copy from a machine
that names that directory differently, which the listing leaves out as the files do, is filed nowhere here: its machine's
records describe it, and nothing of it is published as this machine's.

A change a migration can make is a step that raises `user_version`; an OAK that finds a higher version than it knows
writes nothing to that file. So does one that finds facts derived by a newer `INGEST_VERSION` (recorded in `meta`):
deriving them again would only be undone by the newer OAK, and the two would take turns on every read. Either reads the
files as before, and `oak doctor` names the update. A change none can make raises the format in the file's name, and a
new file is built.

**Derivation version.** `INGEST_VERSION` is 5. A Codex rollout is published only after the same file stamp still holds after derivation. If it grows or is replaced while being read, the catch-up defers it without publishing partial facts or advancing its saved stamp; a later pass retries it. Upgrading to version 5 derives older facts again, including prompt cursors whose source files have not changed.

**Catching up.** A read first catches the database up with the files on disk (`ingest.ts`):

- One pass of directory listings and stats finds what changed since the last catch-up, by each file's device, inode,
  size and modification time; nothing unchanged is read.
- What changed is derived with core's own readers, so the database cannot disagree with the views about what a file says:
  the listing's facts (`listingFacts`), the search's fold (`foldSearchDocs`), the log's fold with its re-keying
  (`readLog`), and the transcript facts behind actions, workers and workflow runs.
- A transcript's asks and answers are folded from a byte cursor kept beside a hash of the file's head and of the bytes
  before the cursor. A new inode, a shorter file or a changed hash means the file was replaced or rewritten, and its rows
  are rebuilt from the start. Rows and cursor are written in one transaction, so a catch-up killed partway resumes where
  its last commit left it, with nothing twice. A line still being written waits for its newline.
- Writers use `BEGIN IMMEDIATE` with a 5-second busy timeout (a deferred `BEGIN` fails with SQLITE_BUSY rather than
  waiting) and hold each transaction to at most 5,000 rows or about 50 ms.
- One process at a time catches up: it holds the lease, a row naming it that expires, which a process that has died or
  stopped renewing loses. A reader that finds the lease held answers from what the database holds and says so
  (`caughtUp: false`). OAK's cleanup, which must record the sessions it removes, asks for the lease instead: the holder
  hands it over at its next session, and the cleanup says so when it could not record them (the lease still held after
  30 seconds, or the database not writable).
- A listing's catch-up re-reads a changing session's tool calls and workers, which no listing shows, at most every
  30 seconds: each read parses the whole transcript. `oak query` reads them whenever they changed.
- A reader gives the catch-up two seconds, checked between sessions, and never waits for a first build that would read
  more than 64 MB of transcripts: it
  starts `oak __index-build` detached (at most once a minute, never under `OAK_NO_BACKGROUND`), which builds newest
  sessions first and can be stopped and resumed. The hooks never write SQLite: once oak sync has run on the machine
  (`sync/status.json`), each hook starts that same build, under the same once-a-minute claim (`build.kick`, one stat
  when none is due, nothing that reads SQLite loaded), so what the agents do is published to the record log while they
  work, whether or not anything reads there. A hook that raised, changed or lowered a hand starts one whatever the claim
  (the build the claim stands for may have read the hand before it moved), and a build running then takes another pass
  for the claim that hook wrote. None starts under `OAK_INDEX=off`, and a build that cannot open the database
  (this Node cannot run it, a newer OAK wrote it, its file is damaged) dates the claim an hour ahead, which holds the next
  ones off. A permission prompt still inside its wait is published by a later pass (the build waits it out, 95 seconds
  at most, and ends once the prompt is down, whose hook started a build of its own; any catch-up after it publishes it
  too): `ingestAttention` marks its unit deferred until then.
- A catch-up that finds nothing to do (every file's stamp the one it recorded, no record log to read, nothing to
  publish, archive or compact; a session's tool calls a listing's catch-up put off count as read) writes nothing and
  takes no lease. It records when it caught up (`caught_up_ms`) at most every 30 seconds, and is not taken while
  another process holds the lease, whose writes may span several transactions.
- `PRAGMA data_version` changes whenever another process commits, so a long-lived reader knows when to ask again
  without watching files. Since a catch-up with nothing to do writes nothing, it changes only when something did, or
  when a catch-up records its time.
- A value is fitted to its column where it is written, since every table is STRICT: a fractional number in an integer
  column is rounded, true and false become 1 and 0, numeric text a number, and a number or a structure in a text column
  its text. A value that cannot be fitted keeps its session out of that catch-up, named with its column in the
  catch-up's `problems`, in `oak query --status` (`failed: [{ id, problem, at }]`) and in `oak doctor`, which warns. The
  database never says it is caught up while a session is failing, so the listings read the files until that session's
  files change.

**The archive.** The database keeps what a session did after its files are gone. A session whose transcript, rollout and
store are all gone is archived, never removed: `archived_ms` says when and `archived_reason` why — `cleaned` when OAK's
own cleanup removed it, `retention` when it was older than Claude Code keeps transcripts (`cleanupPeriodDays`, else 30
days), else `missing`. Every cleanup OAK makes first catches the database up on the sessions it removes and publishes them
to the record log, from whichever surface makes it, since core's store does it before it removes a session or clears
records: `oak clean`, the editors' Clean Store and Drop, and the terminal app's cleanups. The demo's own cleanup and `oak
uninstall --purge-store` leave nothing behind instead. Where the Node a surface runs has no `node:sqlite` (an older VS
Code), there is no database to catch up: what the database and the log already hold stands, and what the session did since
they last caught up goes with its files. Its rows stay: edit metadata (never blob content), actions, asks and answers, workers and
comments. A record `oak clean --resolved` drops from a live session's log stays too, marked cleared. So do the records
and comments of a store `oak clean` removed when the session then goes on (its new store begins its ids at 1 again;
the earlier records, operations, capture gaps and review units keep ids below zero), and the title, first ask and vitals of a session whose transcript Claude
Code swept while its store stays. Named queries leave the archive out unless asked (`--archived` or `--all`) and mark
each archived row with its time and reason.

Only a deliberate delete forgets: `oak sessions --delete` purges every row of the session at once, its full-text
entries with them (its usage rows stay, without the session), in every database file in the folder (a superseded one is kept
until `oak clean` removes it), and oak sync's tombstone for a delete made on another machine does the same at the next
catch-up. So does a delete made in the terminal app or VS Code, which delete in-process through core (JetBrains runs
`oak sessions --delete`); one where that Node has no `node:sqlite` is purged at the next catch-up. The demo's cleanup and
`oak uninstall --purge-store` forget the sessions they remove the same way here, the demo's usage rows with them (the
simulator's turns were never billed); a session whose transcript `--purge-store` leaves is added to the database again from it. Each of
these then checkpoints SQLite's write-ahead log into the file, whose freed pages `secure_delete` zeroes, and truncates
it: otherwise the pages the session was written in stay in the log while any process keeps the database open. A read in
progress in another process holds the log until it ends, and until the next checkpoint the file keeps the session's old
pages.

The purge another machine's record log carries, including the purge retained in a compacted base, is applied as a delete
here is: the session's rows of that machine go from every
database file in the folder (the one applying it keeps their usage, without the session), and the write-ahead log is
checkpointed. That is how the other machines forget what the stores `--purge-store` removes held. They let their copies
of those stores go, as after any cleanup, once a run there reads this machine's inventory, which lists them as cleaned
up (`sync/evicted.jsonl`, which the purge keeps while oak sync has other state here). A machine that does not read it
again keeps its copies.

The archive's source of truth is this machine's record log (below), which oak sync replicates and backs up: a new database
file (a new format, or the store moved) reads it back. A new file also copies what only the database holds from the
previous file before anything else is written: the archived sessions' rows, and of the sessions that are not archived
the records `oak clean --resolved` dropped, the review comments, and what was read of a conversation whose file has
gone. It copies by the columns both files have, verifies the copy by counting, and records it. The previous file is
kept; `oak clean` removes it only once a newer file recorded a verified copy of it. A file of a newer format belongs to
a newer OAK, and an older one never copies from it or removes it. (The copy predates the log; it costs a read of one
`meta` row per open once made, and stays until a release has published every archive to a log.) Archived rows hold
metadata and text, never blob content, and an archived session
costs what it did live. Measured on a synthetic machine of 1,000 sessions whose home folder's path was under 40
characters long: about 1 KB per edit (its row, its seven indexes and its record), 0.4 KB per tool call, and each ask
with its answer (capped at 8 KB and 32 KB, as the search keeps them) about 1.5 times its text in its table plus 0.6
times again in the full-text index. Its 100,000 asks (78 MB of ask and answer text), 100,000 tool calls and 10,000 edits
made a 298 MB database beside 265 MB of transcripts. Paths repeat in every row and its indexes: with a home path of 130
characters the same machine took 1.25 KB per edit, 0.7 KB per tool call and 1.75 times the text, 352 MB in all beside
320 MB of transcripts. Real transcripts are mostly tool output, which the database does not keep. Those figures were taken
while each transcript's cursor carried the texts of its last 64 answers; it now carries its last 4, which on a 2.1 GB
synthetic store of 1,257 sessions took the database from 342 MB to 303 MB.

Usage and the record log, measured on a synthetic machine of 1,200 Claude Code sessions (396 MB of transcripts, 16,000
asks, 40,000 tool calls, 2,400 edits in 300 stores, 69,000 assistant messages, most written as two lines, and 240
worker transcripts) and 60 Codex rollouts: a first build took 24.6 s where the database without usage took 14.3 s (back to
back; the first build reads every transcript once more for its usage, writes the log, and then writes it again as a
base), and the database grew from 98 MB to 122 MB, about a third of a kilobyte per message. The record log it wrote is
84 MB, which another machine applied in 16 s into a 112 MB database. A new database file on the same machine, reading its files
and its own log back, took 47 s. After one more turn, `oak sessions --json` took 596 ms where it took 589 ms without the
log, and the log grew by 1.3 KB (5 KB at most when the session's own row and newest ask were published again). `oak
usage` took 160 ms where it took 147 ms; the status line's own read, which takes no totals between two scans, 136 ms
where it took 128 ms; and a status line render 317 ms where it took 400 ms, and 342 ms where it took 1,830 ms when its
scan was due, with the same figures. On a machine of 20 sessions the renders took 304 ms against 301 ms, and 333 ms
against 336 ms. The capture hook took 113 ms per edit either way. A usage pull of the whole machine is four pages of
at most 5.5 MB, each answered in under half a second; the next, after one more turn, 0.3 s and 461 bytes.

**Usage.** The database keeps the usage of every machine whose rows it holds (schema version 2). `usage_messages` has one
row per assistant message, Claude Code's message id or a Codex turn's, at its largest snapshot: a message Claude Code
writes as several lines while it streams counts once, at the line with the most input, output and cache-creation tokens
(the earlier of two equal ones), with its cache reads, model, list-price cost (`pricing.ts`), session, account and the
machine it was first seen on. A message two machines hold, such as a transcript oak sync copied, is one row. Rows are
kept for ever, and `usage_daily` rolls them up by UTC day, machine, agent, account and model, kept in step by triggers,
so a window longer than 35 days is summed from the rollup. `usage_readings` keeps each share a machine read of an
account's windows (the 5-hour, weekly and per-model weekly shares, and the bill-cycle month its status line projected)
with its reset and when it was measured, once per measurement, and the Claude account's answers on its five-hour limit
(kind `limit`), each kept with when the account answered with no five-hour window (`no_limit` 1) or with one
(`no_limit` 0): the newest of each are the two times a machine's brief carries, which decide alike from either
(`noFiveHourLimitIfNewest`, in `observe.ts`); `usage_spend` the spend Claude Code reported for each session (the status line's ledger) with what each
report added, a report that added nothing not kept; `accounts` each account tag with the machines and agents seen on it.
Readings and spend reports are kept whole for 35 days; older, each machine keeps one reading of each machine, agent,
kind and hour (the hour's last, and of the answers the hour's last of each) and one report of each session and UTC day (the day's last, its delta what that day's
reports added, so a span of whole days sums to the same spend), and every machine downsamples alike once a day. A day
that took another machine's rows in the last day waits, so that a log read again is whole before it folds, and a usage
pull leaves alone an old day this database already holds, which the sending machine may have folded already. A session deleted on purpose keeps its usage
rows, without the session: the account was billed for its turns. The catch-up reads them from each transcript's own byte cursor (worker transcripts included), each Codex
rollout's token counts and rate limits, and the status line's and Codex's usage caches. It reads no credentials: the
account tag is the hash `claudeAccountTag` makes of the account id in `.claude.json`.

Tokens are input + output + cache creation, as Claude Code counts them; cache reads are counted apart. A window of the
account counts this machine's rows and the rows of other machines billed to the account this machine is logged in to
(with no login here, the one account the other machines name). `oak usage --json` carries the 5-hour, weekly and
bill-cycle windows as `usageTotals`, each placed by the reset its readout shows. `oak usage --window` and `oak query
usage` break one window down by machine, model, session, day, agent or account, from the database's rows alone (a saved
machine that answers only with its readings is in `usageTotals` and the estimates, but in no breakdown), and `oak query
readings` lists the shares each machine read and the account's answers on its five-hour limit. The readouts' rule for another machine's share, the freshest measured inside the latest
window, is a query over `usage_readings`. The status line keeps its estimator, tokens per percent calibrated on this
machine's shares once a scan interval (ten minutes), and takes its totals from `usageTotals` when they are whole
(`caughtUp`: a catch-up of everything finished in the last 15 minutes, and no session failing) and of the windows it
anchors on (a reset within half a period of its own, and the same bill cycle). It then reads no transcript, keeps no
file map, and adds no other machine's figures, which the totals already count. Otherwise (an OAK without the database, a
database still building, or a window that turned over between the two reads) it scans the transcripts as before. Its own
`oak usage` read (`OAK_STATUSLINE`) asks for the totals only when its scan is due, so a render between two opens no
database; `oak usage`'s catch-up of the session and the usage caches writes nothing when nothing changed.

**The record log.** Each machine publishes what its database derives of its own sessions to an append-only log in its store,
`records/<machine id>/`, which oak sync keeps on every machine and in the backup (the `oak-records` family, placed
everywhere), so every machine's database holds every machine's sessions. A segment is named by the time it was begun and a
random suffix (`<13-digit ms>-<8 hex>.jsonl`) and grows to 8 MB. Each catch-up appends what it changed as one batch,
under the log's lock and before it commits: a batch line (`{"t":"batch","at","v":1,"label","platform"}`), then one line
per row (`{"t":<table>,"r":{…}}`), per deleted key (`"d"`), per table cleared for a session (`"clear"`) and per
deliberate delete (`{"t":"purge","s":<session>}`). The log carries sessions; each ask with its answer; edit metadata,
the oplog, capture gaps, review units and line counts; tool calls; workers and workflow runs; raised hands (each
session's kind, message and time, published as the hooks raise and lower them) and waits; comments; plans, memories and
skills; and the usage rows, readings, spend and accounts. Each record is keyed as its table is, so a log
applied twice changes nothing. It never carries blob content, nor the demo simulator's sessions. A session's own row and
its newest ask, which change with every turn, are published at most once a minute, and a change of what a session is (its
title, model, workspace or archive) at once. OAK's cleanup publishes a session's last rows before it removes its files.

Another machine's records are applied under that machine's id. A session this machine also has from its own files (a
transcript oak sync copied here) keeps the conversation it reads from them. A base's first line names its machine as a
batch line does, so a machine whose log was compacted into a base is still listed by its label. A new database file reads
this machine's own log back, and a database that holds this machine's rows from before it kept a log publishes them
whole. A local append receipt (`records/<machine>/.writer`, never synced) records its writer lifetime and the exact
segment length it wrote. Only that segment can be extended. Rotation, an actual sync run and a publishing inventory
close it with a final seal
naming its byte length; subsequent appends start another segment. Compaction may replace a segment only when its
local receipt proves the length or its final seal is present and valid. A complete-line prefix and a legacy unsealed
segment can still supply rows, but local EOF alone never authorizes covering them. Compaction waits when it has read
rows from such an unclosed prefix, so those incomplete rows cannot become authoritative base rows either.

Once a log holds 32 MB and twice what its last base held, or a deliberate delete asks for it, the machine writes a base
(`-base.jsonl`): a padded header with its body length, writer lifetime, lower history bound (`from`) and coverage count
(`parts`), followed by `cover` records, current rows and retained `purge` records. Each `cover` names a verified complete
segment; inherited coverage is carried forward too. This explicit membership also protects a missing old segment whose
clock put its filename between `from` and the new base. Bases from earlier development builds, without `parts`, retain
their `from` interval semantics (without `from`, all earlier names). A base is written in one write transaction, only
from a database that read everything available; uncertain segments remain outside its coverage. A peer drops and stops
pulling only covered segments once it holds the entire base. Legacy unsealed segments remain until independent
completion evidence is available; they are never silently treated as closed.

A machine set up again with the same host name and home starts a new writer lifetime. Its old log stays on peers and
in the backup, and returns with its archive even if the new log was compacted first. Records from unrelated lifetimes
are replayed before the selected base; only that base's writer can supersede it with later appends. This prevents an
old segment named by a clock ahead of the reinstalled machine from overwriting the base's newer text. There is no
provable chronological order between disconnected bases: an existing database keeps its selected base unless another
covers it or continues that writer; a fresh database uses filename order as a deterministic choice. Such conflicts keep
the underlying uncovered logs, and are not a claim that the clock identifies the latest lifetime.

A reader checkpoints each segment. Late-arriving earlier history causes the later records in this replay order to be
read again, including across a bounded catch-up; an incomplete base waits. A base retains session purge records even
after repeated compaction or database rebuilding, so replay of uncovered history cannot revive a deleted session merely
because the separate sync tombstone has not arrived. An explicitly restored session's current rows supersede its old
purge. Replaying a purge over restored local history requests compaction so the old text leaves the log once those
segments are complete. Thus deletion reaches peers through the record log on its own, while sync's tombstones also
coordinate removal and restoration of session files. A backup folder keeps the segments the compaction replaced, sealed, since nothing is
removed from it. A log in a newer format is applied up to where it begins, and the catch-up says to update OAK. The
capture hook never writes it: like the database, it is written by the catch-ups, which the hooks start in the background
(above). A machine asked for its inventory by another machine's `oak sync now` (`oak __sync-inventory --publish`)
catches its database up first, for up to `SYNC_PUBLISH_MS` (5 seconds), so the run that asked takes what it published, and
starts a background build for what that leaves; it records its own session deletes and undeletes first too, as a run of
its own does (`recordSessionDeletes`), so that a machine that runs no `oak sync now` passes them on; an OAK from before
the flag ignores it, and `oak sync plan` never asks for it. A raised hand is published as the surfaces read it (a
question its transcript holds unanswered, by its header), at once, but a permission prompt only once it has stood its
wait (`announceDelayMs`), as the machine announces it; the other machines list another machine's hand for a day at most
(`SYNCED_HAND_MS`).

`oak sessions --json --machine <label>` answers from the database when oak sync read that machine in the last ten minutes,
the database has read all of its records, and nothing there may be running: none of its sessions was active in the last two
hours, as its records say and as the files the last run saw there say (a machine publishes its records from its own
catch-ups, which can lag behind its files), and no hand raised there in the last day is still up (an open wait in its
records). The answer says so (`fromIndex`, `syncedAt`, `publishedAt`) and lists the sessions oak sync brought here from
that machine, as it lists them itself, each with the raised hand its records brought and the phase that hand gives; in
the terminal app's warm worker it also lists the session under review whatever it is, as that machine lists the one
`--session` names. Otherwise that machine is asked over ssh, as before: what is true of a session right now (whether
one with no hand up is working, its running workers) is not in the records. `oak search
--machine <label>` searches that machine's asks and answers in its records, its sessions oak sync brought here included,
ranked as `oak search` ranks them there, when oak sync read it in the last ten minutes and the database has read all of its
records (an ask typed there is found once that machine has published it and a run has brought it), and over ssh
otherwise. `oak sessions --json --synced` adds every machine whose sessions the database holds from its records
(`machines`), whatever their age; a session oak sync brought here is listed with this machine's, unless it came from a
machine that names its directory differently, which this machine's listing leaves out as a copy.

**The usage pull.** A machine that does not use oak sync still counts its saved machines' usage. At most every five
minutes (`oak usage --pull-machines`, started by the pollers, as before) it asks each enabled saved machine over ssh for
its own usage rows since the last pull (`oak __usage-records --since <cursor>`, pages of at most 20,000 rows of each kind, never conversation
text) and applies them as records, with that machine's clock offset as measured during the round trip. A machine whose
record log oak sync keeps here, with a segment written in the last 15 minutes, is not asked. An older OAK there, which
has no `__usage-records`, and one whose database does not open (it answers why), are asked for their readings instead
(`oak __usage-brief`), which the readouts show as before. No records arrive from such a machine, so what its brief says
it measured of its own turns is added to the windows it shares with this one, as before the database (`usageTotals` and
`machineMeasured`, by the rules of `measuredFromMachines`), until the database holds any of its usage since the earliest
of those windows began: a machine moving to the usage pull is counted by its rows from then on, never twice. `oak
doctor` says so, as information. A turn of such a machine whose transcript this machine also holds through a sync other
than oak sync is counted twice, since the database files that copy as this machine's own.
Where this machine's own database does not open (no `node:sqlite`, a file a newer OAK wrote, a damaged one), it asks every
saved machine for its readings, as before the database. The cache under `remote-cache/machine-usage.json` keeps, per machine, its latest
readings (`brief`, as the database holds them) with its machine id (`host`) and clock offset, and each outcome's status:
`ok`, `synced` (not asked: oak sync brings its records), `unreachable`, `timeout`, `no-oak`, `old-oak`, `not-reading`
or `failed`, with `briefOnly` for a machine that gave its readings alone.

**`oak query`.** Named queries (`sessions`, `edits`, `files`, `prompts`, `search`, `workers`, `delegated`, `sync`, `notes`, `usage`,
`readings`, `schema`)
and one read-only SQL statement (`oak query sql`), in one JSON contract (version 1): `{ v, query, params, columns, rows,
rowCount, truncated, freshness: { indexedAt, caughtUp, sources[] }, elapsedMs, problems }`; `--arrays` returns rows as
arrays, `--table` prints each row as a block for a person, and `oak query --serve` answers one NDJSON request per line.
A failure is `{ v, error: { code, message } }` with exit status 2 for a query that cannot run, 3 when there is no database
here, and 124 when raw SQL ran past its deadline. `search` ranks with bm25, an ask weighted three times its answer,
every word required and the last one also a prefix; `oak search` keeps its own substring semantics and ranking. Fields
are added, never renamed. node:sqlite on Node 22 returns a text value only up to the first NUL character it holds (Node
24 returns all of it): the listings and `oak search` read such an ask and its answer as bytes, so they are whole on
both, but an `oak query` row on Node 22 can show one cut at its NUL.

Raw SQL is guarded in layers, because a read-only connection is not a sandbox (ATTACH still opens another database and
VACUUM INTO still writes a copy): it runs in a child process killed with SIGKILL at the deadline (node:sqlite has no
interrupt), which also ends itself a second later from a worker thread's timer, should the parent that was to stop it
have been killed while it waited; the connection is read-only with `PRAGMA query_only`, under which VACUUM INTO fails
before it copies anything (SQLite still creates its empty target file); one statement only (`sourceSQL` shows where the
first ends); no statement that returns no columns (ATTACH, DETACH, VACUUM, a pragma that sets something); a keyword
check on every Node; and on Node 24.10 and newer SQLite's authorizer, which allows reading and nothing else (SQLite
never consults it for VACUUM, which the layers before stop). An answer whose rows come to more than 128 MB of JSON is
cut there (`truncated`, with a problem saying so), and on a Node that can set SQLite's length limit a text or blob
longer than 64 MB is refused; within its deadline a statement can still spend memory and temporary disk.

**The listings served from it.** `oak sessions --json`, `oak search`, `oak inbox` and `oak notify --watch` are composed
by the same code as before, with the database answering what that code would read from disk (`index/listing.ts`): the
listing's facts per session, the search's asks and answers, and the inbox's listing. The database also holds what the
listing read of every session's files on every call (schema version 3): its raised hand and native tab, read again when
`attention.json` or `tab.json` changes, and the workers found finished, which only a write to their own transcript can
bring back. So a listing from a caught-up database asks only what can change without a catch-up seeing it: a session's
phase (from its transcript's tail, and from its raised hand where a call has no result yet) and a Codex turn in flight
(only of a session active in the last two hours), whether it is current or running,
the question behind a raised hand (from its transcript's tail), and each worker written in the last two hours that was
not found finished at its stamp. They are served from the database only when it is
caught up, and listed the old way otherwise. Parity is a test, not a hope: the session-listing suite and the core tests
that call the listing, the search or the inbox run again with each call answered from the database and checked against the
old answer, and e2e compares the CLI's output with `OAK_INDEX=off` and an editor's in-process reading with the CLI's.
`OAK_INDEX=shadow` lists the old way and records where the database would have differed in `shadow.jsonl` beside it.

Where the surfaces read it:

- **Terminal app.** Its listings, inbox and search go through the CLI or its warm view worker (one long-lived
  `oak views` process), which serve them from the database. A saved machine's sessions are listed from the database
  (`sessions --machine` in the worker) when oak sync read that machine lately and nothing there may be running (above),
  and its conversations are searched in its records whenever oak sync read it lately; otherwise that machine is asked
  over ssh, as before. The "a newer session is live" hint, outside any
  workspace, reads the newest session from the database (`indexedNewestSession`) instead of walking every transcript every
  30 seconds; inside one it resolves the workspace's session as before. Whether a session has a local copy of another
  machine's transcript is answered by the worker instead of a process per check.
- **VS Code.** The listings it runs through the CLI (`sessions --json`, the Overview's `views` batch) are served from
  the database. Where the extension host's Node has `node:sqlite` with FTS5 it also reads the database in-process, read-only
  and never catching it up (`openIndexReadOnly`): a session it is asked to act on in bulk is looked up in the listing
  the last catch-up left (`readIndexedListing`) before the files are listed; the other machines' sessions it lists come
  from `readMachineListings`, else (another machine's records are here, and its Node cannot read them) from `oak
  sessions --json --synced`; and a write to a Codex rollout refreshes the panels only when the database says that session
  ran in this workspace's folder, a worktree of its repository that its sessions are known in, or below one of them, or
  is a session the window shows (`indexedRollouts`, reloaded when `PRAGMA data_version` moves), or when the database does
  not know it. Its conversation search still reads the files in-process: from the database it was not faster (271 ms from
  the files, 328 ms from the database, on 1,260 synthetic sessions).
- **JetBrains.** Its session picker lists this machine's sessions and the other machines' from one `oak sessions
  --json --synced`; its search and next-hand jump run the CLI, which serves them from the database. Off the EDT, the check
  that a pinned session still exists asks one long-lived `oak query --serve` (the `sessions` query by `id`) before
  reading the head of every rollout, which it still does to prove an absence. Any Codex session's write on the machine
  refreshed every open project: the sum of every rollout's stamp, every two seconds, stays the trigger, and when it
  moves one read of the serve (the newest Codex sessions, each with the folder it ran in) says whether one that ran in
  this project's folder, a worktree of its repository that its sessions are known in, or below one of them, or the
  session under review, moved; only then, or when it cannot say, is the project refreshed. Asking the database every two
  seconds instead would cost its catch-up (75 ms on 1,260 synthetic sessions, against 1.5 ms for the sum).

Both editors list saved machines through `oak sessions --machine <label>` and review a selected remote session on its machine. Timeline and Overview reads, keep, undo, redo, comments, quotes and prompts use that machine's CLI. Opening a remote edit shows its patch. Workspace decorations, inlays and the Review tree still use local files. A session known only through synced records, with no saved machine to contact, opens as a read-only record with an offer to fetch it here.

Agents started with `oak agent start --brief` keep their control record in `delegated/<id>.json`; the first capture hook links the native session through `<id>.session`. OAK derives starting, working, waiting, blocked, errored, done or gone from the report, process and pane, raised hand, transcript or rollout and `claude agents --json`, independently of herdr's status. A nonempty report written since the start marks completion. `agent list`, `wait` and `close` use these records; in-process workers keep their own log and have no tab.

**The editors' floor.** VS Code's `engines.vscode` stays `^1.85`, and the Node inside its older hosts has no
`node:sqlite`. Core feature-detects in-process (`indexRuntime`), so an extension host without it loads core as before,
reads without the database in-process, and asks the CLI (whose own Node runs the database) for the other machines' sessions.
JetBrains uses `oak query --serve`. Which VS Code release first ships a Node with FTS5 is not verified here.

## The CLI `--json` contract

The machine-readable surface. Field names are a **stable contract** — the JetBrains parsers and the
VS Code renderers key on them by name. Add fields; don't rename them. (`emitJson` writes compact
`JSON.stringify` to stdout; commands below all take `--session <id>` to target a session.)

| Command | JSON shape | Primary consumer |
| --- | --- | --- |
| `list --json` | `{ session, edits: [{ id, ts, tool, file, status, added, removed }] }` | scripts / terminal; JetBrains reads the same records off-disk via `StoreReader` |
| `status --json` | `{ hooksInstalled, hookScript, session, store, lastCaptureTs, counts: { total, pending, kept, undone, cancelled } }` — counts exclude cancelled-out chains (reported separately), like every other surface | doctor / scripts / setup checks |
| `views [--views <a,b,c>] [--root <d>]` | `{ [name]: payload \| null }` over the READ-ONLY views — default `changemap, multitask, prompts, processes, sessions, observations, risk, egress`; `stats` is also accepted by name, though nothing batches it by default. Each payload is **byte-identical** to that view's own command (all eight defaults pinned by e2e), but for `sessions --machine <label>`, which in a batch answers only from the local database (null, with the reason in `__problems`, where the command would ask that machine over ssh); a view that throws is `null` rather than fatal to the batch, and a mutating verb is refused outright. One process instead of one per view | The eight views the JetBrains Overview polls — `ObservatoryCli`'s private `ViewBatch`, consulted by each `*Json` accessor. `feed`, `tree`, `stats` and `usage` answer their own triggers and still spawn separately. VS Code takes `changemap` + `multitask` + `processes` from one batched spawn |
| `sessions --json` | `{ active, sessions: [{ id, workspace, title, lastActiveMs, lastTurnMs, current, edits, pending, files, added, removed, tokens, durationMs, model, effort, activeWorkers[] }] }` — sessions belonging to this machine, grouped by workspace, the editor root first, other workspaces and their rows ordered by conversation recency. Claude provenance compares its recorded cwd with the project slug; absent foreign platform paths also identify mirrors. Bridge pointers without assistant records are excluded. Codex titles prefer `session_index.jsonl` thread names, then rollout titles and the first real prompt. A title that only hands the task to a markdown brief (`Execute TASK.md`, a prompt that reads a brief and carries it out) takes the heading on the brief's first line, read from the first 8 KB of the file (relative to the rollout's `cwd`, absolute, or under `~`) and cached on its stamp; a missing brief keeps the title. A prompt that is itself a brief takes its heading, and an Auto-review (`guardian`) thread is titled after the session it reviews. Auto-review threads (session_meta `thread_source: guardian_review` or `source.subagent.other: guardian`) are left out of the listing and of workspace resolution unless `--session` names one; `--all` lists them, and usage still counts them. Counts and usage use existing incremental caches; Codex recency uses the raw rollout's mtime. `activeWorkers` lists each subagent still at it (`workerPhase` says working, awaiting input or awaiting permission) with its title, phase, model, tokens, last write and its share of the session's review units, matched by the tool-call id the capture recorded (`unitsByCall`); only an agent transcript written in the last two hours is asked, and one found finished is not read again until it changes. With `--machine <label>` and neither `--session` nor `--root`, a machine oak sync read in the last ten minutes, whose records the database has read whole, none of whose sessions was active in the last two hours (as its records and the files that run saw say) and none of which has a hand raised in the last day still up, is listed from the local database in the same shape (`active` null, each session's `tab` and `activeWorkers` empty, which the records do not carry, and its `attention` the raised hand its records brought, with the `phase` that hand gives) plus `fromIndex: true`, `host` (its machine id), `syncedAt` (when the last oak sync run that read it whole began, this machine's clock) and `publishedAt` (when its last records were written, its clock); any other is that machine's own answer over ssh, unchanged. With `--synced`, a `machines` member is added: `[{ label, host, syncedAt, publishedAt, sessions[] }]`, every machine whose sessions the local database holds from its records, by label (the saved machine's, else its records', else its id), each session in the listing's shape with `origin: 'synced'` and `machine` its label; `syncedAt` is when the oak sync run that last read it began (else when its records last arrived in this database; this machine's clock), `publishedAt` when it last wrote records (its clock); a session oak sync brought here is listed with this machine's instead, unless it came from a machine that names its directory differently (a copy, which the listing leaves out); `[]` without a database or with `OAK_INDEX=off`. Such a session carries the raised hand its records brought (`attention`), and then the `phase` it gives, with `phaseConfidence: 'high'`. `syncedHands` (absent when there are none) is every other machine's raised hand its records brought, each an `inbox --json` hand with `origin: 'synced'`: every surface that polls the listing lists and announces them. | Both editors consume `sessions --json` (or the `sessions` member of `views --json`). The Overview adds workspace headers, active filtering and week-old folds; pickers show the workspace column. Both editors also gather every enabled saved machine's sessions in parallel in the background. Session selectors, Sessions and Workers share one cache per machine, with a ten-second refresh interval, a 45-second deadline, answer age and visible failures. Switch Session can also add `--synced` records that have no saved machine to contact. Remote workspace extension hosts naturally list the remote host's local sessions. |
| `query <name> [--<param> <v>…] [--archived\|--all] [--arrays]` · `query sql "<SELECT>" [--param <v>…] [--timeout <ms>]` · `oak query --serve` | `{ v: 1, query, params, columns, rows, rowCount, truncated, freshness: { indexedAt, caughtUp, sources: [{ machine, label, savedLabel, origin, throughTs, stale }] }, elapsedMs, problems }` (`label` the name each machine gives itself, `savedLabel` the label this machine saved it under or null, and `origin` `local` for this machine and `replica` for every other one, unlike a session's `origin`, where `replica` marks a row read from a copy of another machine's edit log), or `{ v: 1, error: { code, message } }` with exit 2 (`bad_query`, `bad_param`, `unsafe_sql`, `sql_error`), 3 (`index_unavailable`) or 124 (`timeout`). `usage` adds the window it placed to `params` (`start`, `end`, `reset`, and `countedAccount` when it counts one account), and its rows are `{ key, messages, tokens, input, output, cache_create, cache_read, cost, first_ts, last_ts }` (`first_day`, `last_day` for a window longer than 35 days, summed by day), with `label` by machine and `machine`, `session`, `title` by session; `readings` rows are `{ machine, machine_label, agent, kind, no_limit, label, account, pct, reset_ms, measured_ms, tokens, budget, reads, cost, cost_budget, source, synced_ms }`. `query --status` is `IndexStatus`, whose `failed: [{ id, problem, at }]` lists the sessions the database could not bring up to date. `sessions` also takes `id` and gives each row's `cwd`. The rows of `sessions`, `edits`, `prompts`, `search`, `workers` and `notes` end with `machine_label`, the label this machine knows the row's machine by (its `saved_label`, else its `label`, else its id); `files` is one row per git repository (the repository's part of the project key) and path from the repository's root (an edit outside any git repository by its absolute path), so a file in clones at different paths, or edited from sessions in different folders of the repository, is one row whose `machines` counts both; `edits --path` takes an absolute path inside a git repository one of this machine's sessions ran in as its path from that repository's root, `params` saying what it matched, and refuses any other absolute path with `bad_param`. See [The local database](#the-local-database) | Agents and scripts; JetBrains' pin check and Codex filter (`sessions` by `id`, and the newest by `agent`), through `oak query --serve` |
| `tree [--root <d>] [--filter <q>]` | `EditTree` (`{ folders[], files[], hiddenIds[] }` → folder → file → class → edit w/ `added`/`removed`). `hiddenIds` is every record inside a cancelled-out chain, independent of `--filter` | The **JetBrains Review tree** (`TreeParser` → `EditsTreePanel`), plus scripts and the terminal. The plugin also derives its status bar, its File/Diff/Folder axes and its project-view badges from `hiddenIds`, so those counts agree with the tree they sit beside; VS Code renders the equivalent in-process |
| `conversation --session <id> [--limit N] [--since <cursor>] [--root <d>] --json` | `{ events: [{ ts, update }], turns, agent, transcriptPath, cursor, truncated, reset? }` — the transcript as renderer-ready session updates: `user_prompt`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`/`tool_call_update` (carrying the captured record's `editId` where one was attributed), `plan`, `usage_update` and `turn_end`. An initial read delivers the last **N turns** (`--limit`, default 50), counted backwards from the end of the file rather than parsed from its start, and `truncated` reports the bytes cut above them (`0` = the whole transcript). `--since <cursor>` continues from the byte cursor the previous read returned and delivers **every** record appended after it, whatever the limit, with `truncated: 0`; `cursor` is `null` only when the session has no transcript. `reset: true` means the transcript was REPLACED, not appended to — the events are a fresh bounded window and the consumer must redraw rather than append. A cursor OAK did not issue costs a replay of the preceding turn, never a wrong render | The terminal's Observatory detail takes a bounded first read and tails it with `--since`. Both editors read their conversation through `feed --json` |
| `observe` | `{ session, recap, insights, suggestions, edits: [{ id, ts, tool, file, status, summary, reasoning, flags, memory, analysis }] }` | Observations — the Timeline window's Observations tab in both editors (JetBrains `ObserveParser`; VS Code builds the equivalent in-process) |
| `actions [--all]` | `{ session, summary{ total, byCategory, errors, firstTs, lastTs }, actions: [{ ts, tool, category, target, detail, ok, isError, reasoning, editId }], groups: [{ category, label, count, errors, actions[] }], subagents, subagentsSummary, fleet, fleetSummary }` | Actions — the Timeline window's last tab in **both editors** — VS Code in-process `parseActions`/`buildActionGroups`; JetBrains reads the same curated `actions` section out of the shared `multitask` payload through `ActionsParser` → `ActionsPanel`. `groups` is curated by default; `--all` includes reads/searches/meta. `subagents`/`subagentsSummary`/`fleet`/`fleetSummary` are additive 0.7.0 fields (same shapes as the `subagents`/`siblings` commands); existing parsers ignore them |
| `subagents [--json]` (alias `agents`) | `{ session, summary, subagents: [{ agentId, agentType, description, status, ts, durationMs, tokens, toolUseCount, actions[], edits, summary }] }` | Subagents node in the Actions tab — **both editors**; each subagent's nested timeline is mined zero-token from `subagents/agent-<id>.jsonl` and correlated via the spawning tool call's `toolUseResult` |
| `fleet --json` / `sessions --json --workers` | Session listing plus `workers: [{ session, title, machine, kind, state, tokens, lastActiveMs, subagents }]` | Both editors and the terminal Observatory read named workers in a background CLI: herdr agents and panes, OAK-started agents, and recent Claude/Codex worktree sessions. Saved machines use the shared session cache and deadline. |
| `siblings [--json]` | `{ session, summary, siblings: [{ id, self, active, lastMs, edits, pending, files[], moreFiles, risk{ total, high } }] }` | Fleet node in the Actions tab — **both editors** — plus an agent-facing digest a run can poll mid-flight; READ-ONLY / PATH-ONLY (no file contents cross agents). `--json` = siblings only; `--all` includes self. A transcript oak sync copied here from another machine is no sibling. With `--repo`, `machines: [{ machine, host, syncedAt, sessions: [{ id, title, agent, model, workspace, lastMs, edits, pending, machine, host, readOnly: true }] }]` adds the other machines' sessions of the same git repository from the local database, newest first (none archived), each machine with when oak sync last brought its records |
| `metrics [--json]` | `{ session, spanMs, actions{ total, errors, byCategory }, edits{ count, added, removed, pending, kept, undone }, subagents{…}, toolLatency{ count, medianMs, p95Ms, maxMs } }` | Session metrics roll-up — diff stats, action/error counts, per-subagent duration/tokens, and tool latency (from each `tool_use`→`tool_result` timestamp gap) |
| `changemap [--root <d>] [--json]` | `{ summary, edits[], compactions[], files[], modules[], tasks[], rollupByTask[], rollupBySubagent[], rollupByWorkflow[], workflows[], prompts[], rollupByAgent[], agents[], unassigned }` — `files`/`modules` are the churn + worst-unreviewed-wins rollups (pre-labeled, churn-sorted); `tasks[]` carries the strict-span identities `rollupByTask` joins by `taskId`, and `unassigned` surfaces that rollup's `taskId: null` row directly so a renderer never digs it out; the three `rollupBy*` each keep their explicit `null` strict-unassigned/main-chain bucket (scripts still see the honest strict view); `prompts[]` slices the session by the user's own turns and is built for the active session only; `agents[]` is one full change-map per worktree-sibling (the master-detail per-agent view, most-recently-active first) with its `edits`/`prompts` projected out — the top-level `edits[]` is the one tools read | Overview panel (master-detail; Fleet/Workflows nav → change-map detail) — JetBrains `ChangeMapPanel` via the CLI, VS Code via one `views` spawn carrying this plus `multitask` and `processes` (same payload; both render as-given). `core.overviewChangeMap` is the shared composition both paths run, so neither front-end owns a second copy of it |
| `prompts [--json]` \| `prompts --id <n> [--response] --json` | `{ session, summary{ total, withEdits, edits }, prompts: [{ id, index, ts, endTs, text, title, editIds[], edits, added, removed, pending, kept, undone, files, folders, tokens, tasks, actions, errors, agents[], workflows[], processes[], compactions, durationMs }] }`; `--id` narrows to `{ session, prompt }`, and `--response` returns `{ session, response: { promptId, index, text, turns, bytes, truncated } }` — Claude's own prose for that ask, its tool calls stripped, capped, with `truncated` reporting the bytes past the cap | Prompts — a Timeline window tab in both editors (JetBrains `PromptsParser`); selecting a row scopes the Overview to that ask, and the selection is shared with the nav bar's Prompt axis in both directions |
| `review --prompt <id> [--no-patch] [--json]` | `{ session, prompt{ id, index, ts, endTs, title, text }, units: [{ id, members[], file, rel, tool, status, ts, added, removed, patch? }], cancelled: [same shape], cancelledIds[], hiddenIds[], ids[], summary{ units, pending, cancelled, added, removed }, patchesOmittedFrom, errors[] }` — `cancelled` are the chains that end where they started (never rows; one footer with a Dismiss over `cancelledIds`), and `hiddenIds` is what a renderer must not draw at ANY status — ONE ask's work as review units, each `patch` the unit's NET unified diff; `members` are the unit's RAW record ids and `ids` is the whole ask's mutation set, group-expanded and ascending (what `keep --ids`/`undo --ids` take). Patches are budgeted (8 MB); past it, `patch` is absent, `patchesOmittedFrom` names the first cut and `errors[]` says so — never a silent hole. Deliberately NOT batchable via `views` (it needs a prompt id, and `views` hands one argument list to every view) | Review — the per-ask tab in all three surfaces (JetBrains `ReviewParser` → `ReviewPanel`; VS Code builds the same payload in-process; the terminal instead scopes its Edits list to the ask — the payload's consumers are the two editors). This is also where the JetBrains plugin consumes core's same-code collapse at all — everywhere else it reads raw records off disk |
| `multitask [--root <d>] [--json]` | `{ agents: [{ session, worktree, gitBranch, self, phase, phaseConfidence, sparkline[], todos, subagents[], files[], diff{ added, removed }, tokens, durationMs, risk, folded, loaded }], collisions: FileCollision[], worktrees[], workflows: WorkflowRun[], actions{ groups[], egress }, summary{ active, conflicts } }` | Overview Fleet/Workflows nav — **both editors** (render thin); assembled in the CLI from `listRepoSiblings` + per-agent `buildChangeMap` + `parseWorkflows`. Git-free / path-only. `folded` = quiet for over `FLEET_FOLD_MS` (a week) and collapsed in the nav; those rows are served from the disk cache but never rebuilt on the critical path, so `loaded: false` means **the numbers on this row are placeholders, not findings** — renderers must say "not loaded" rather than draw zeros. The session being viewed is never folded |
| `tasklog` (always JSON) | `TaskLogEntry[]` — `{ taskId, content, agentIds[], subagentIds[], firstTs, lastTs, edits, added, removed, status }`, one row per stable `taskId` unioned across worktrees + subagents (`unassigned` excluded) | Cross-agent task log — **CLI only**; neither editor invokes it (they read `multitask.tasks`, which is session-scoped). Folds every worktree sibling's *cached* change map — calling the raw builder here cost 12.4 s for a 12 KB answer |
| `task-keep <taskId> --json` / `task-undo <taskId> --json` / `task-clear <taskId> --json` | `{ kept, total, ids }` / `{ undone, conflicts, total, ids }` / `{ cleared, ids }` — each acts on the task's STRICT edit set (`taskEditIds`), so an edit made outside every `in_progress` interval is never in the scope; `task-clear --completed` clears every settled task and returns `{ cleared, ids, tasks[] }` | task-scoped Accept/Reject/Clear — both editors |
| `demo [--fast] [--speed <n>] [--dir <d>] [--clean] [--json]` | `{ session, workspace, transcript, edits, steps }` (`--clean` → `{ sessions[], workspaces[], scratch[] }`) — replays a scripted session through the REAL pipeline in an isolated `demo-<hex>` session + marked folder | Live showcase + the e2e fixture (`demo.ts`); a fully reviewed demo auto-clears its store (`autoClearDemo`) |
| `clean [--session <id>] [--json]` · `--resolved [--under <p> \| --ids <a,b,c>]` · `--completed` · `--drop <id>` · `--older-than <Nd>` · `--all` | `{ removed, bytes }` for the blob GC; `{ cleared, ids }` for `--resolved`; `{ dropped[], sessions[] }` for `--completed`; `{ dropped[] }` for the rest | Store maintenance — both editors' **Clean Store** chooser. `--completed` drops sessions whose review is finished; the eligibility rules live in `core.reapableSessions` so neither editor owns a second definition of "completed". It refuses the current session, anything from another workspace, anything quiet for less than `REAP_QUIET_MS`, anything with a capture staged — and anything with pending edits until dead past the stale window (14d default, `--stale` ≥24h), after which those edits are discarded with counts shown first. `--older-than` likewise excludes the live session: it filters on the *store log's* mtime, which a long conversation that edited early makes look ancient |
| `chat-context [--tool-use-id <id> \| --edit <n> \| --agent <id> \| --task <id>]` | `{ prompt }` — a ready-to-paste chat prompt built by `assembleChatContext`; **never** spawns a process or calls a model | Chat handoff — both editors |
| `locate --file <f>` (buffer on stdin) | `{ file, placements: [{ id, lines: [int], removed: [{ anchor, lines: [string] }], delta?: { added, removed } }] }` — `removed` carries the deleted hunks a renderer paints as ghost text (`anchor` is the surviving line they now follow); `delta` is present only for placements that render, since it costs one whole-file diff per record | inline overlays — JetBrains `ObservatoryCli.locate`; VS Code computes in-process via `core.locateEditsInCurrent` (both compose the file's edit chain in one pass) |
| `usage` | `{ ...UsageLine, staleMs, usageTotals }` (`staleMs` = `USAGE_STALE_MS`, 300000). `usageTotals` is the account's windows from the local database, or `null` where there is none, with `"machineUsage": false`, and for the status line's own read (`OAK_STATUSLINE`) between two of its scans: `{ account, unmatched, five, week, month, machines: [{ machine, label, self, syncedAt, briefOnly? }], caughtUp, indexedAt }` (`caughtUp`: a catch-up of everything finished in the last 15 minutes with no session failing; `indexedAt`: when), each window `{ start, end, reset, messages, tokens, input, output, cacheCreate, cacheRead, cost, spend, topTier: { tokens, cacheRead }, others: { tokens, cacheRead, cost, spend, topTier, machines[] } }` (tokens = input + output + cache creation; `others` = the rows of machines other than this one; `account` = the account tag counted, `unmatched` when it stands for the one account other machines name). `UsageLine.sessionTokens` describes the session’s own turns and `sessionTreeTokens` includes its agents. `claudeMonthUsd` and `gptMonthUsd` supply the status bars’ monthly dollars; `claudeAccount.monthSpend` is reported spend. `UsageLine.fiveNoneAt` is when the account answered that it has no five-hour limit (epoch ms), while that is its newest answer on any of its machines (`null` otherwise); while it is set, the 5-hour share, reset, estimate and spend fields are `null`, and `usageTotals.five` counts the last five hours. A saved machine that answers only with its readings adds what it measured of its own turns to each window and its `others` (`tokens`, `cacheRead`, `topTier`, and `spend` or, for the month, `cost`; never `messages`, `input`, `output` or `cacheCreate`), and is listed in `machines` with `briefOnly: true`. `usage --window <5h\|week\|bill\|month\|day\|all> [--by machine\|model\|session\|day\|agent\|account] [--json]` prints the `oak query usage` answer | Stats and the bundled status line retain the 5h window; terminal/editor status bars show week and month, with the month’s dollars after its reset. The bundled status line reads `usageTotals` |
| `__usage-records [--since <cursor>] --json` (hidden) | `{ usageRecords: 1, host, hosts[], at, cursor, more, messages[], readings[], spend[], accounts[], purged: [{ session, at }] }` — this machine's own usage rows since the cursor (`<database epoch>:<write sequence>:<purge time>`; another database file starts over), at most 20,000 of each kind a page (`more` says another follows), each row as its record (no machine id, write sequence or arrival time); or `{ usageRecords: 1, error }` where there is no database | `usage --pull-machines` on a saved machine (`machine-usage.ts`) |
| `sync status [--root <d>] --json` | `{ syncStatus: 1, setUp, auto, running, last, backup, placements, exclude, conflicts, index, cache, key, project }` ([REMOTE.md](REMOTE.md#json) has it whole). For the surfaces: each line of `last.machines` carries `text`, what `oak sync status` prints after its label; a backup folder's line that refused its record under this machine's name carries `record: unclaimed\|other` (as in `sync now --json`); each conflict carries `file`, this machine's file of it (null where sync does not reach it); `project: { folder, key, excluded } \| null` is the project in `--root` (else the folder it runs in), keyed as `sync exclude` keys it | The terminal app's Observatory, `i` list and options window; VS Code's status bar item, its picker and the Timeline's session list; JetBrains' status bar widget, its menu, the Settings page and the Overview's Sessions tab (`model/Sync.kt`) |
| `sync setup (--none \| --machine <l> \| --folder <p>) [--key-from <m> \| --import-key] [--restore] --json` | `{ syncSetup: 1, backup, key, record?, plan, planError? }`; for a folder holding a backup this machine's key does not open, exit 1 with `{ syncSetup: 1, needsKey: true, folder, error, keyHere }`, nothing changed (`keyHere`: the fingerprint of another key kept here, which a key brought for the folder replaces only with `--replace`, or null) | Both editors' setup, which then asks where the key comes from (`--key-from`, or pasted to `--import-key` on standard input, with `--replace` when `keyHere` is set) and, for a `record` this machine has not written, whether it is a reinstall (`--restore`) |
| `sync resolve <conflict> --json` | `{ syncResolve: 1, id, family, name, from, trash, closed }` — the other machine's copy moved to sync's trash (`trash` null when it was gone already), and the conflicts this closed; refused while a run or a store move holds sync's lock | Each surface's "delete the copy" |
| `inbox --json` | `{ hands, next, generatedAt, sync: [{ id, family, name, from, copy, at, reason, file }] }` — `file` as in `sync status`; `hands` include the other machines' raised hands as their records brought them, each with `origin: 'synced'`, `host` (that machine's id), `machine` (the label this machine knows it by), `syncedAt` and `publishedAt`, and no `question`; `next` is this machine's own. `inbox --next [--after <id>] --json` is `{ next, hand, elsewhere }`: the session to jump to among this machine's, its row, and how many hands wait on other machines (a turn's end aside), which a jump never goes to | the terminal app's `i` list reads `sync status` for its conflicts; scripts |
| `stats --json` | `StatsResult` (`{ daily[30], hourly[24], windows{session,day,week,month}, generatedAt }`) | Stats panel (both spawn a subprocess) |
| `keep <id> --json` / `keep --all --json` | `{ kept, ids: [int] }` | JetBrains `ObservatoryCli.keep` / `keepAll` |
| `undo <id> --json` / `redo <id> --json` | `{ ok, status, message }` — `status` ∈ `undone` \| `redone` \| `conflict` \| `noop` \| `error`. On an undo conflict caused by later units that rewrote this change's lines, two ADDITIVE fields: `dependents` (their unit reps) and `closure` (the raw id set `undo --ids` takes to revert them together, newest first) — absent on ordinary conflicts | JetBrains `ObservatoryCli.undo` / `redo` → `UndoResult`; front-ends branch on `.status`, never on prose; both editors offer the closure as "Undo both" beside the force fallback |
| `oplog [--json]` / `oplog --revert-last [--json]` | list: `{ session, operations: [{ kind, label, ids[], ts }] }`, newest first; revert: `{ session, reverted{ kind, label, ids, ts }, restored? , result? }` — `restored` for a keep (statuses put back), `result` (the scoped undo/redo shape) when files were rewritten | CLI only; neither editor invokes it (same precedent as `tasklog`) |
| `assign --ids <a,b,c> --prompt <id\|index> [--json]` / `assign --ids … --clear` | `{ assigned, ids[], prompt }` — ids are group-expanded; every read side (prompts, change map, review, rewind scopes) follows the override; units keep their temporal boundaries. `prompts --json` gains additive `assignErrors[]` when an override names a prompt this session does not have | CLI only in 0.9.4; the editors' move-to-prompt gesture is deferred |
| `undo --all\|--file\|--under\|--ids --json` (and `redo` likewise) | `{ undone, conflicts, errors, firstError, total, ids: [int] }` / `{ redone, conflicts, total, ids: [int] }` — `ids` names which edits actually moved, so a caller can offer a precise Redo instead of a blanket one | scoped Accept/Reject — both editors; `task-undo` shares the shape |
| `undo --from-prompt <id> --json` | the scoped shape above **plus `units`** — the rewind of one ask and everything after it. `ids` are RAW store ids (a same-code group straddling the boundary is expanded whole, or it would half-revert); `units` is the same set counted the way the Prompts rows count it, so no two surfaces print different totals for one destructive operation. Unknown prompt → exit 1; a real prompt with nothing pending → exit 0 and `undone: 0` | "Rewind to before this prompt" — both editors, via `core.checkpointScope` |
| `undo --from-prompt <id> --dry-run --json` | `{ dryRun: true, pending, units, files: [str], ids: [int] }` — counts the rewind WITHOUT touching disk, so a confirmation can name what it would rewrite. Refused on any other scope, where it would mean nothing. This exists for parity: an editor that shells out has no other way to obtain those numbers before committing (every other exposure of the scope performs the revert), so without it one editor could show counts and the other could not | the rewind confirmation — both editors state the same three numbers before committing |
| `redo --from-prompt <id> --json` | the scoped `redo` shape over the ask's WINDOW: every **undone** record from that ask onward. Narrower than `redo --all`, which reaches edits the ask never touched, but **wider than one rewind** — `checkpointScope` reports every id in the window whatever its status, so an edit rejected *before* the rewind is undone-and-in-window and is re-applied too. There is no way to make the verb narrower: the window is all a prompt id can name. **No `units`**: the scope counts review units over the PENDING records, which are undone by the time anything is redone, so the number would always be 0 | scripts re-applying an ask's window. A Redo offered beside a rewind uses `redo --ids` with that rewind's own `ids` instead — both editors, so neither resurrects a rejection |
| `blob <sha>` | raw bytes (not JSON) | diff panes / chat prompts |

The undo/redo `--json` exit codes mirror the human path exactly: `conflict` → exit 1, `ok` → 0. A
front-end branches on the structured `status` to, e.g., offer `--force` on a conflict instead of
string-matching the message. The e2e harness (`test/e2e.sh`, section 14) asserts each of these shapes
with `jq`; the rewind scope has its own section 24.

The three 0.7.0 commands are backed by new `core` modules — `subagents.ts`, `fleet.ts`, and
`metrics.ts` — each deriving purely from the Claude Code transcript + the content-addressed store
(no model calls, no network). 0.7.5 adds `changemap.ts` on the same terms, and takes the rule one step
further: it ships the *rendered* rollups (`files[]` / `modules[]`), so the VS Code webview and the
JetBrains Swing panel are both pure renderers with no aggregation logic of their own to drift. `parseActions` was refactored to share `parseTranscriptActions`, so
every subagent's `subagents/agent-<id>.jsonl` transcript parses through exactly the same code as the
main session's action timeline.

0.8.0 continues the pattern with `taskLog.ts`, `workflows.ts`, and the worktree-correlation helpers in
`session.ts` / `fleet.ts` — all pure derivations of the same Claude Code transcript + content-addressed
store, with **no model calls, no network, and no git binary** (the fleet reads `.git` pointer files
directly). Every 0.8.0 surface — the Overview's master-detail Fleet/Workflows nav, the per-agent
change-maps, the four-way rollups, workflow-run tracking, the cross-agent task log, task-scoped
keep/undo, and the context-preloaded chat handoff — costs **zero extra Claude tokens**.

**0.10.0: one Timeline window, two floating bars.** VS Code's three timeline-shaped views —
`claudeObservatory.prompts`, `claudeObservatory.actions`, `claudeObservatory.observations` — were
consolidated into a single `claudeObservatory.timeline` webview whose tab strip carries Feed · Prompts ·
Observations · Actions. The three view ids no longer exist, which is the one breaking change in the
release: VS Code stores view placement per profile, so anyone who had dragged those views somewhere gets
a reset panel layout once. JetBrains already had the tabbed shape and keeps it, now as a single tool-window
content with four tabs. Neither window's tab layout is a workspace setting: which tab is forward,
whether the tabs are grouped into columns, and each column's width and fold state are **layout** choices,
so VS Code rides them on the webview state object and JetBrains on the application-level
`claude-observatory.xml`. The one shared *behaviour* setting, `editorReviewSurface`, is deliberately the
same key in both editors with `floating` and `none` spelled the same; only the surfaces that genuinely
differ get words of their own (`bubble` in VS Code, `banner` and `both` in JetBrains). VS Code's floating
bar is the same `EditPeek` comment thread as the review bubble in a body-less `bar` mode — one thread
field, so the two surfaces cannot be on screen at once by construction.

## Agent and conversation planes

- **Data:** `core/src/herdr.ts` owns the typed socket adapter, protocol/version gate, snapshot,
  subscriptions, agent start/prompt/focus operations, and machine forwarding. `herdr-api.d.ts`
  is generated from the pinned schema. `herdr-install.ts` installs the pin; `herdr-link.ts`
  joins pane identities with OAK sessions. `herdr-tabs.ts` names herdr's tabs by one set of rules:
  the terminal app's pass over every machine, and `syncSessionTab` for one session's own tab, which
  the capture hooks and the Claude Code status line start detached (`oak __tab-sync`) when the title
  may have changed. On a saved machine the app's pass keeps the `btop` tab and has the machine run
  `oak __tab-sync` itself (`--machine`), so one server's names are recorded once, by the OAK on the
  machine that runs it. A session that machine holds no pane link for (its hooks never ran in the pane)
  it cannot name: `__tab-sync` answers `unlinked`, and the app's pass names that tab by the app's own
  record, as before. A name the app's own record says it gave a tab there (before the update, while that
  machine's OAK lacked the verb, or while it held no link for the session) goes along as `--claimed`,
  and the machine takes that claim on while the tab wears it. Both write `<root>/herdr-tabs.json` under
  its lock, each only the claims it changed, and before it `<root>/herdr-tabs.at.json`, when the title
  each claim names was read: a pass leaves alone a tab whose claim is newer than the session list it
  works from, and one that reads between the two writes never sees a new claim with an old time.
  Renames run under a lock of the machine's own, `<root>/herdr-names.<machine>.lock`, held until the
  claims are saved, and each only while its tab's claim is still the one the pass read; the record's lock
  is held for the read and the write alone, so a saved machine's slow renames never hold up another's.
- **UI:** the TUI's herdr tab hosts the real herdr client in a local native terminal. herdr's
  server owns the agent terminals. Observatory shows active panes plus unresolved local history,
  with a pinned conversation detail. `c` focuses its thin reply composer. Editors expose the
  transcript conversation through `oak feed --json` in the Feed tab of both VS Code and
  JetBrains, alongside Review and Overview; new agents start in herdr-owned terminals.
- **Control:** herdr owns native terminals, pane creation, prompt submission and focus. OAK
  submits through the single adapter; remote operations use herdr's machine forwarding. For agents started
  from briefs, OAK derives its own lifecycle states and implements `agent list`, `wait` and `close` above.
- **Review:** Claude hooks and Codex hooks/transcript parsing produce the existing edit store.
  `conversation.ts` reads native transcripts and joins tools with captured edits. Hook-only
  lifecycle evidence lives in `capture-events.jsonl` for prompt attribution, permissions, and
  workers; it is not an agent protocol replay. Legacy edit provenance remains readable so
  uncertain before-states continue to refuse unsafe Undo.
- **`core/src/codex.ts`** — Codex-native hooks (Codex ≥0.147.0 speaks Claude Code's payload
  dialect): the payload adapter funnels into the same `handleHookPayload` pipeline
  (`apply_patch` becomes per-file edit payloads), lifecycle events land in the hook journal,
  and the rollout miner supplies prompts/tokens (with the cache split)/model/effort. The
  installer replicates Codex's trust hash because Codex skips untrusted hooks.
- **`core/src/models.ts`** — the `oak models` verb's engine: list what the local Ollama serves and
  wire Codex to one (`rewireCodexConfigText` edits only the top-level model keys, append-only,
  with a `.bak`; a live Codex probe confirms the wiring answers).

`daemon.ts` and `tui/server.ts` implement only the local focus endpoint: versioned hello,
watch, focus, and shutdown. `oak focus --session <id> --tab observatory|review|herdr` forwards to
an attached OAK TUI. The endpoint has no terminal or agent ownership and no SSH transport.

Comments and quotes remain drafts until an explicit send. Core locates the session's live pane,
then calls the local prompt API or herdr's machine forwarding. Failed/unavailable submissions
retain the draft; comments are consumed only on acknowledgement. Usage reads the local database: this
machine's measurements and every other machine's usage it holds (by oak sync's record logs, or by the usage
pull `machine-usage.ts` runs, a detached `oak usage --pull-machines`), and where this machine has no current
Claude share, a saved machine's reading of the same account, or of the one account the saved machines name
where this machine has no login; machine configuration belongs to herdr, not OAK preferences.

`herdr.lock` pins the upstream version, protocol, asset URLs and SHA-256 checksums. Core embeds
that pin through `gen:herdr-lock`; `gen:herdr` regenerates the API declarations. The CLI distribution
ships `dist/herdr-plugin/`; the pin travels compiled into the bundle. `ensureHerdr()` owns installation and integration
setup and preserves newer installed binaries.

The focus endpoint reports its protocol and build stamp before accepting operations. The TUI
replaces an outdated endpoint at startup; `oak doctor --fix` performs the same repair and reports
it. herdr agent terminals remain owned by herdr. Doctor also spawns a bounded echo child through
node-pty, repairs a non-executable spawn helper with `--fix`, and retries the check.

Observatory retains active panes and unresolved store sessions. Resolved, inactive sessions are
archived rather than deleted; `B` includes them. Each machine groups its live sessions by herdr
workspace, and a paneless session by project. Cursor movement previews a header; a click or Enter
pins the transcript, and re-pinning a leaf parks its unsent draft with the session it was written for.
The composer submits only on Enter. Remote polling defaults to 30 seconds per
call (`OAK_HERDR_REMOTE_TIMEOUT_MS`), avoids overlapping requests and backs off after failures.

## See also

- [CONTRIBUTING.md](../CONTRIBUTING.md) — the step-by-step "add a feature across all platforms" guide.
- `packages/jetbrains/README.md` — the plugin's own install/remote-dev notes.
- The root `README.md` — user-facing overview, install, and the feature tour.


Claude Code human `queued_command` attachments are asks at the attachment timestamp, using `attachment.prompt`.
Queue removals link `commandUuid` and `deliveryId` to the attachment's `source_uuid` and `delivery_id`; ordinary
user records join through `uuid` or `promptId`. The prompt readers persist those identities across append cursors.
Task and peer deliveries, meta user entries and `api-request-blob` replay copies contribute no asks. Replay copies
also contribute no usage, actions or answer prose. Database prompt cursors carry the derivation version, so a
version bump rebuilds their rows even when the source bytes have not changed. Synced record logs carry those corrections.
Codex can deliver several human messages during one native turn: each has an ask identity, and hook edits sharing
that turn are attributed by ask time. The mirrored `user_message`/`response_item` pair is consumed once per delivery.
