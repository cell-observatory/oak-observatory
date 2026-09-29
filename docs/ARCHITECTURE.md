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
```

Derived caches live beside the sessions, never inside them (`RESERVED_STORE_DIRS` keeps the session
enumerator from mistaking one for a session):

```
<root>/changemap-cache/<session_id>/<key>.json   the session's change map / fleet payload
<root>/changemap-cache/<session_id>/placements.json  where each edit lands in the CURRENT file text
<root>/changemap-cache/<session_id>/deltas.json      per-blob-pair line deltas (+/- for each edit)
<root>/changemap-cache/<session_id>/transcript-facts-v<N>-<key>.json  the shared fold of one transcript
<root>/changemap-cache/<session_id>/conversation.json  resume state behind `conversation --since`
<root>/remote-cache/session-titles.json          claude.ai Remote Control titles by session id
<root>/session-meta/<session_id>.json            title + row counts + risk sidecars
<root>/session-meta/provenance/<path-hash>.json   transcript launch cwd + bridge classification
<root>/usage-cursors/<hash(transcript path)>.json  byte cursor for incremental usage parsing
```

Two rules keep these honest, both learned the hard way in 0.9.0:

- **A cache stamp must be the input, not a superset of it.** The change map's project-directory stamp
  carried every sibling transcript's `(mtime, size)` when the only thing derived from that directory is a
  *count of session ids* — so one session appending a line invalidated every other session's map in the
  project. The stamp is now `projectSessionIds(cwd)`, the very call the map derives the value from.
- **The cache version belongs in the file NAME.** Two builds that disagree about a stamp's shape used the
  same path, so each one's write was a permanent miss for the other, with no symptom but slowness.

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

- `rootDir()` = `<config>/claude-observatory`; `storeDir(session)` = `<root>/<session_id>`;
  `logPath(session)` = `<storeDir>/log.jsonl`.
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
never a fresh parse of either file. Titles come from
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

**Port-fidelity tests** guard the mirrors — "the Kotlin reader must never drift":

- `packages/jetbrains/src/test/kotlin/com/cellobservatory/observatory/core/StoreReaderTest.kt` —
  asserts append-only `log.jsonl` semantics: `EditRecord` lines + `{op:"status"}` folding (last op
  wins), tolerance of unparseable lines, and blob reads, against fixtures written in the TS format.
- `packages/jetbrains/src/test/kotlin/com/cellobservatory/observatory/model/SessionsRowsTest.kt` —
  verifies the CLI listing contract, workspace order, statistics and rejection of legacy remote rows.
- `packages/jetbrains/src/test/kotlin/com/cellobservatory/observatory/platform/SessionSelectionTest.kt` —
  proves an empty CLI listing cannot fall back to a mirrored transcript on disk.

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

- `repoRoot(cwd)` walks up to the nearest ancestor holding a `.git` entry (file *or* dir).
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
**working** if fresh, else **awaiting-permission** (a harness permission prompt writes *nothing* to the
transcript, so it's disambiguated only by staleness — a labeled `heuristic`). With no pending tool_use, a
trailing *error* result ⇒ **errored**; a trailing *non-error* `tool_result` ⇒ **working**, because a
conversation can never end on a tool_result — the turn is mid-flight (this is what keeps the live self
session reading "working" *between* tool calls instead of flickering to idle after each result), aging to
**done** once long-stale. A completed turn (assistant spoke and stopped) reads **idle** when recent,
**done** past `DONE_STALE_MS`. `agentPhaseDetail` also returns a `confidence` (`high` = structural,
`heuristic` = staleness-derived) so a front-end never asserts an inferred state as certain.

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

## The CLI `--json` contract

The machine-readable surface. Field names are a **stable contract** — the JetBrains parsers and the
VS Code renderers key on them by name. Add fields; don't rename them. (`emitJson` writes compact
`JSON.stringify` to stdout; commands below all take `--session <id>` to target a session.)

| Command | JSON shape | Primary consumer |
| --- | --- | --- |
| `list --json` | `{ session, edits: [{ id, ts, tool, file, status, added, removed }] }` | scripts / terminal; JetBrains reads the same records off-disk via `StoreReader` |
| `status --json` | `{ hooksInstalled, hookScript, session, store, lastCaptureTs, counts: { total, pending, kept, undone, cancelled } }` — counts exclude cancelled-out chains (reported separately), like every other surface | doctor / scripts / setup checks |
| `views [--views <a,b,c>] [--root <d>]` | `{ [name]: payload \| null }` over the READ-ONLY views — default `changemap, multitask, prompts, processes, sessions, observations, risk, egress`; `stats` is also accepted by name, though nothing batches it by default. Each payload is **byte-identical** to that view's own command (all eight defaults pinned by e2e); a view that throws is `null` rather than fatal to the batch, and a mutating verb is refused outright. One process instead of one per view | The eight views the JetBrains Overview polls — `ObservatoryCli`'s private `ViewBatch`, consulted by each `*Json` accessor. `feed`, `tree`, `stats` and `usage` answer their own triggers and still spawn separately. VS Code takes `changemap` + `multitask` + `processes` from one batched spawn |
| `sessions --json` | `{ active, sessions: [{ id, workspace, title, lastActiveMs, lastTurnMs, current, edits, pending, files, added, removed, tokens, durationMs, model, effort }] }` — sessions belonging to this machine, grouped by workspace, the editor root first, other workspaces and their rows ordered by conversation recency. Claude provenance compares its recorded cwd with the project slug; absent foreign platform paths also identify mirrors. Bridge pointers without assistant records are excluded. Codex titles prefer `session_index.jsonl` thread names, then rollout titles and the first real prompt. A title that only hands the task to a markdown brief (`Execute TASK.md`, a prompt that reads a brief and carries it out) takes the heading on the brief's first line, read from the first 8 KB of the file (relative to the rollout's `cwd`, absolute, or under `~`) and cached on its stamp; a missing brief keeps the title. A prompt that is itself a brief takes its heading, and an Auto-review (`guardian`) thread is titled after the session it reviews. Counts and usage use existing incremental caches; Codex recency uses the raw rollout's mtime. | Both editors consume `sessions --json` (or the `sessions` member of `views --json`). The Overview adds workspace headers, active filtering and week-old folds; pickers show the workspace column. No background remote gather. Remote workspace extension hosts naturally list the remote host's local sessions. |
| `tree [--root <d>] [--filter <q>]` | `EditTree` (`{ folders[], files[], hiddenIds[] }` → folder → file → class → edit w/ `added`/`removed`). `hiddenIds` is every record inside a cancelled-out chain, independent of `--filter` | The **JetBrains Review tree** (`TreeParser` → `EditsTreePanel`), plus scripts and the terminal. The plugin also derives its status bar, its File/Diff/Folder axes and its project-view badges from `hiddenIds`, so those counts agree with the tree they sit beside; VS Code renders the equivalent in-process |
| `conversation --session <id> [--limit N] [--since <cursor>] [--root <d>] --json` | `{ events: [{ ts, update }], turns, agent, transcriptPath, cursor, truncated, reset? }` — the transcript as renderer-ready session updates: `user_prompt`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`/`tool_call_update` (carrying the captured record's `editId` where one was attributed), `plan`, `usage_update` and `turn_end`. An initial read delivers the last **N turns** (`--limit`, default 50), counted backwards from the end of the file rather than parsed from its start, and `truncated` reports the bytes cut above them (`0` = the whole transcript). `--since <cursor>` continues from the byte cursor the previous read returned and delivers **every** record appended after it, whatever the limit, with `truncated: 0`; `cursor` is `null` only when the session has no transcript. `reset: true` means the transcript was REPLACED, not appended to — the events are a fresh bounded window and the consumer must redraw rather than append. A cursor OAK did not issue costs a replay of the preceding turn, never a wrong render | The terminal's Observatory detail takes a bounded first read and tails it with `--since`. Both editors read their conversation through `feed --json` |
| `observe` | `{ session, recap, insights, suggestions, edits: [{ id, ts, tool, file, status, summary, reasoning, flags, memory, analysis }] }` | Observations — the Timeline window's Observations tab in both editors (JetBrains `ObserveParser`; VS Code builds the equivalent in-process) |
| `actions [--all]` | `{ session, summary{ total, byCategory, errors, firstTs, lastTs }, actions: [{ ts, tool, category, target, detail, ok, isError, reasoning, editId }], groups: [{ category, label, count, errors, actions[] }], subagents, subagentsSummary, fleet, fleetSummary }` | Actions — the Timeline window's last tab in **both editors** — VS Code in-process `parseActions`/`buildActionGroups`; JetBrains reads the same curated `actions` section out of the shared `multitask` payload through `ActionsParser` → `ActionsPanel`. `groups` is curated by default; `--all` includes reads/searches/meta. `subagents`/`subagentsSummary`/`fleet`/`fleetSummary` are additive 0.7.0 fields (same shapes as the `subagents`/`siblings` commands); existing parsers ignore them |
| `subagents [--json]` (alias `agents`) | `{ session, summary, subagents: [{ agentId, agentType, description, status, ts, durationMs, tokens, toolUseCount, actions[], edits, summary }] }` | Subagents node in the Actions tab — **both editors**; each subagent's nested timeline is mined zero-token from `subagents/agent-<id>.jsonl` and correlated via the spawning tool call's `toolUseResult` |
| `siblings [--json]` (alias `fleet`) | `{ session, summary, siblings: [{ id, self, active, lastMs, edits, pending, files[], moreFiles, risk{ total, high } }] }` | Fleet node in the Actions tab — **both editors** — plus an agent-facing digest a run can poll mid-flight; READ-ONLY / PATH-ONLY (no file contents cross agents). `--json` = siblings only; `--all` includes self |
| `metrics [--json]` | `{ session, spanMs, actions{ total, errors, byCategory }, edits{ count, added, removed, pending, kept, undone }, subagents{…}, toolLatency{ count, medianMs, p95Ms, maxMs } }` | Session metrics roll-up — diff stats, action/error counts, per-subagent duration/tokens, and tool latency (from each `tool_use`→`tool_result` timestamp gap) |
| `changemap [--root <d>] [--json]` | `{ summary, edits[], compactions[], files[], modules[], tasks[], rollupByTask[], rollupBySubagent[], rollupByWorkflow[], workflows[], prompts[], rollupByAgent[], agents[], unassigned }` — `files`/`modules` are the churn + worst-unreviewed-wins rollups (pre-labeled, churn-sorted); `tasks[]` carries the strict-span identities `rollupByTask` joins by `taskId`, and `unassigned` surfaces that rollup's `taskId: null` row directly so a renderer never digs it out; the three `rollupBy*` each keep their explicit `null` strict-unassigned/main-chain bucket (scripts still see the honest strict view); `prompts[]` slices the session by the user's own turns and is built for the active session only; `agents[]` is one full change-map per worktree-sibling (the master-detail per-agent view, most-recently-active first) with its `edits`/`prompts` projected out — the top-level `edits[]` is the one tools read | Overview panel (master-detail; Fleet/Workflows nav → change-map detail) — JetBrains `ChangeMapPanel` via the CLI, VS Code via one `views` spawn carrying this plus `multitask` and `processes` (same payload; both render as-given). `core.overviewChangeMap` is the shared composition both paths run, so neither front-end owns a second copy of it |
| `prompts [--json]` \| `prompts --id <n> [--response] --json` | `{ session, summary{ total, withEdits, edits }, prompts: [{ id, index, ts, endTs, text, title, editIds[], edits, added, removed, pending, kept, undone, files, folders, tokens, tasks, actions, errors, agents[], workflows[], processes[], compactions, durationMs }] }`; `--id` narrows to `{ session, prompt }`, and `--response` returns `{ session, response: { promptId, index, text, turns, bytes, truncated } }` — Claude's own prose for that ask, its tool calls stripped, capped, with `truncated` reporting the bytes past the cap | Prompts — a Timeline window tab in both editors (JetBrains `PromptsParser`); selecting a row scopes the Overview to that ask, and the selection is shared with the nav bar's Prompt axis in both directions |
| `review --prompt <id> [--no-patch] [--json]` | `{ session, prompt{ id, index, ts, endTs, title, text }, units: [{ id, members[], file, rel, tool, status, ts, added, removed, patch? }], cancelled: [same shape], cancelledIds[], hiddenIds[], ids[], summary{ units, pending, cancelled, added, removed }, patchesOmittedFrom, errors[] }` — `cancelled` are the chains that end where they started (never rows; one footer with a Dismiss over `cancelledIds`), and `hiddenIds` is what a renderer must not draw at ANY status — ONE ask's work as review units, each `patch` the unit's NET unified diff; `members` are the unit's RAW record ids and `ids` is the whole ask's mutation set, group-expanded and ascending (what `keep --ids`/`undo --ids` take). Patches are budgeted (8 MB); past it, `patch` is absent, `patchesOmittedFrom` names the first cut and `errors[]` says so — never a silent hole. Deliberately NOT batchable via `views` (it needs a prompt id, and `views` hands one argument list to every view) | Review — the per-ask tab in all three surfaces (JetBrains `ReviewParser` → `ReviewPanel`; VS Code builds the same payload in-process; the terminal instead scopes its Edits list to the ask — the payload's consumers are the two editors). This is also where the JetBrains plugin consumes core's same-code collapse at all — everywhere else it reads raw records off disk |
| `multitask [--root <d>] [--json]` | `{ agents: [{ session, worktree, gitBranch, self, phase, phaseConfidence, sparkline[], todos, subagents[], files[], diff{ added, removed }, tokens, durationMs, risk, folded, loaded }], collisions: FileCollision[], worktrees[], workflows: WorkflowRun[], actions{ groups[], egress }, summary{ active, conflicts } }` | Overview Fleet/Workflows nav — **both editors** (render thin); assembled in the CLI from `listRepoSiblings` + per-agent `buildChangeMap` + `parseWorkflows`. Git-free / path-only. `folded` = quiet for over `FLEET_FOLD_MS` (a week) and collapsed in the nav; those rows are served from the disk cache but never rebuilt on the critical path, so `loaded: false` means **the numbers on this row are placeholders, not findings** — renderers must say "not loaded" rather than draw zeros. The session being viewed is never folded |
| `tasklog` (always JSON) | `TaskLogEntry[]` — `{ taskId, content, agentIds[], subagentIds[], firstTs, lastTs, edits, added, removed, status }`, one row per stable `taskId` unioned across worktrees + subagents (`unassigned` excluded) | Cross-agent task log — **CLI only**; neither editor invokes it (they read `multitask.tasks`, which is session-scoped). Folds every worktree sibling's *cached* change map — calling the raw builder here cost 12.4 s for a 12 KB answer |
| `task-keep <taskId> --json` / `task-undo <taskId> --json` / `task-clear <taskId> --json` | `{ kept, total, ids }` / `{ undone, conflicts, total, ids }` / `{ cleared, ids }` — each acts on the task's STRICT edit set (`taskEditIds`), so an edit made outside every `in_progress` interval is never in the scope; `task-clear --completed` clears every settled task and returns `{ cleared, ids, tasks[] }` | task-scoped Accept/Reject/Clear — both editors |
| `demo [--fast] [--speed <n>] [--dir <d>] [--clean] [--json]` | `{ session, workspace, transcript, edits, steps }` (`--clean` → `{ sessions[], workspaces[] }`) — replays a scripted session through the REAL pipeline in an isolated `demo-<hex>` session + marked folder | Live showcase + the e2e fixture (`demo.ts`); a fully reviewed demo auto-clears its store (`autoClearDemo`) |
| `clean [--session <id>] [--json]` · `--resolved [--under <p> \| --ids <a,b,c>]` · `--completed` · `--drop <id>` · `--older-than <Nd>` · `--all` | `{ removed, bytes }` for the blob GC; `{ cleared, ids }` for `--resolved`; `{ dropped[], sessions[] }` for `--completed`; `{ dropped[] }` for the rest | Store maintenance — both editors' **Clean Store** chooser. `--completed` drops sessions whose review is finished; the eligibility rules live in `core.reapableSessions` so neither editor owns a second definition of "completed". It refuses the current session, anything from another workspace, anything quiet for less than `REAP_QUIET_MS`, anything with a capture staged — and anything with pending edits until dead past the stale window (14d default, `--stale` ≥24h), after which those edits are discarded with counts shown first. `--older-than` likewise excludes the live session: it filters on the *store log's* mtime, which a long conversation that edited early makes look ancient |
| `chat-context [--tool-use-id <id> \| --edit <n> \| --agent <id> \| --task <id>]` | `{ prompt }` — a ready-to-paste chat prompt built by `assembleChatContext`; **never** spawns a process or calls a model | Chat handoff — both editors |
| `locate --file <f>` (buffer on stdin) | `{ file, placements: [{ id, lines: [int], removed: [{ anchor, lines: [string] }], delta?: { added, removed } }] }` — `removed` carries the deleted hunks a renderer paints as ghost text (`anchor` is the surviving line they now follow); `delta` is present only for placements that render, since it costs one whole-file diff per record | inline overlays — JetBrains `ObservatoryCli.locate`; VS Code computes in-process via `core.locateEditsInCurrent` (both compose the file's edit chain in one pass) |
| `usage` | `{ ...UsageLine, staleMs }` (`staleMs` = `USAGE_STALE_MS`, 300000) | the 5h/week Usage bars |
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
- **UI:** the TUI's herdr tab hosts the real herdr client in a local native terminal. herdr's
  server owns the agent terminals. Observatory shows active panes plus unresolved local history,
  with a pinned conversation detail. `i` focuses its thin reply composer. Editors expose the
  transcript conversation through `oak feed --json` in the Feed tab of both VS Code and
  JetBrains, alongside Review and Overview; new agents start in herdr-owned terminals.
- **Control:** herdr owns pane creation, agent start, prompt submission, waiting and focus. OAK
  submits through the single adapter; remote operations use herdr's machine forwarding. OAK adds
  session identity and review metadata without claiming the agent's lifecycle state.
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
retain the draft; comments are consumed only on acknowledgement. Usage reads local measurements;
machine configuration belongs to herdr, not OAK preferences.

`herdr.lock` pins the upstream version, protocol, asset URLs and SHA-256 checksums. Core embeds
that pin through `gen:herdr-lock`; `gen:herdr` regenerates the API declarations. The CLI distribution
ships `dist/herdr-plugin/`; the pin travels compiled into the bundle. `ensureHerdr()` owns installation and integration
setup and preserves newer installed binaries.

The focus endpoint reports its protocol and build stamp before accepting operations. The TUI
replaces an outdated endpoint at startup; `oak doctor --fix` performs the same repair and reports
it. herdr agent terminals remain owned by herdr. Doctor also spawns a bounded echo child through
node-pty, repairs a non-executable spawn helper with `--fix`, and retries the check.

Observatory retains active panes and unresolved store sessions. Resolved, inactive sessions are
archived rather than deleted; Shift+A includes them. Each machine groups its live sessions by herdr
workspace, and a paneless session by project. Cursor movement previews a header; a click or Enter
pins the transcript, and re-pinning a leaf parks its unsent draft with the session it was written for.
The composer submits only on Enter. Remote polling defaults to 30 seconds per
call (`OAK_HERDR_REMOTE_TIMEOUT_MS`), avoids overlapping requests and backs off after failures.

## See also

- [CONTRIBUTING.md](../CONTRIBUTING.md) — the step-by-step "add a feature across all platforms" guide.
- `packages/jetbrains/README.md` — the plugin's own install/remote-dev notes.
- The root `README.md` — user-facing overview, install, and the feature tour.
