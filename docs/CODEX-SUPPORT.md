# Codex and GPT support

Native Codex capture, transcripts, usage, and review use the shared OAK store. Agent terminals
and remote machines are owned by herdr; the ACP runtime has been retired. Historical validation
results summarized below describe the earlier implementation, not verification of the current backend.

## Runtime, model, and provider

Codex is a runtime. GPT is a model family. OAK observes native Codex through hooks and rollouts in VS Code, JetBrains, and the terminal UI. herdr runs the native agent terminal. A local model running through Codex does not acquire OpenAI pricing or account limits because of its model name.

The shared session descriptor keeps runtime, original conversation ID, workspace, machine, and reported provider/model distinct. Unknown provider or account identity remains unknown. Model and tool metadata on edit records describe the evidence available when capture happened; switching models does not relabel older edits. Existing Claude paths and CLI aliases remain compatible.

## Set up and continue

```sh
oak init --codex
oak sessions --json
oak agent start --kind codex --cwd <workspace>
oak prompt --session <session-id> --text "Continue the review"
oak integrity --session <session-id> --json
oak doctor --json
```

`init` installs Codex hooks when Codex is available, unless `--no-codex` is supplied. `--codex` explicitly requests that leg. Ordinary installation does not invoke a model. It preserves foreign hooks, mixed groups, unknown JSON metadata, and trust entries it does not own. Malformed TOML/JSON and explicitly disabled hooks are reported instead of overwritten or called healthy. Configuration changes use atomic file replacement and a scoped ownership ledger; backups contain configuration and must be treated as private.

The conversation viewer reads native transcript history. New sessions start through herdr; explicit
comment/quote sends target the pane whose reported native session identity matches the selected
conversation. With no available pane the prompt remains a clipboard draft. Permission answers,
model/mode selection, interruption, and terminal lifetime belong to herdr and the native CLI.

Optional `analyze` remains a model-invoking action. Codex analysis uses its native read-only resume command. Ordinary inspection, capture, integrity, and configuration verification are model-free. `models use` retains its separately described live verification behavior.

## What is captured

Native Codex rollouts feed the shared prompt, response, action, usage, feed, lifecycle, compaction, and session readers. Hooks retain native turn/tool/subagent identity, including `agent_id`, `agent_type`, and Interrupt. Hook lifecycle evidence is retained in `capture-events.jsonl`; edit capture keeps native turn identity.

| Evidence | Review behavior |
|---|---|
| Paired tool hooks and actual before/after snapshots | Tool-correlated transition; Keep/Undo/Redo use the shared store and safeguards |
| Historical ACP diff with trustworthy before-state | Reviewable transition; confirmed deletion is absence, empty-file truncation remains distinct, and fresh hook evidence deduplicates/enriches it |
| Worktree snapshots around a turn or shell command | Records actual disk changes with an interval label; precise authorship is unverified |
| Unknown or excluded before-state, overlapping ambiguous capture, or unsafe legacy creation | Review-only; Undo and forced Undo refuse to invent or delete prior content |

The candidate walk excludes ignored, secret-named, oversized (text over 5 MB, any file over 25 MB) and symlinked content; a binary file within the cap is stored as an opaque blob. Absence from the candidate list is not proof that a file did not exist. A proposed edit alone is not evidence that it was applied. Undo/Redo serialize OAK mutations of the same physical file across sessions and compare content to protect later changes. External editors do not participate in that lock; snapshots cannot prove which writer caused an interval change.

`oak integrity` and `oak views ... integrity` report missing blobs, uncertain before-state, disconnected transitions, duplicate source identity, reused prompt IDs, unfinished turns, deferred tools, skips, and parser health. The report does not rewrite history or guess repairs. Store or capture lock timeouts refuse the mutation and persist a separate capture-gap diagnostic even while maintenance owns the log; already-staged snapshots remain retained. No refused operation is reported as a successful capture. Review tooltips expose available capture/model/tool evidence. A clean configuration check is separate from lifecycle evidence and actual captured edits.

Native Codex 0.153.4 can emit PreToolUse without a terminal hook when its tool router rejects a patch. A later edit of the same file in that turn is then recorded as uncertain and ordinary Undo refuses it; the turn's `Stop` drops the abandoned snapshot, so edits in later turns are captured normally. Automatic recovery within the turn is not qualified (R27). Historical macOS validation confirmed capture and Undo/Redo but left recovery from this native hook failure unqualified. Unannounced background writes after the final tool notification cannot be reliably attributed. A retained baseline whose owner has died may be reclaimed by explicit maintenance after the staging retention period; later recovery then reports a gap. Cross-file moves are captured as their observed file transitions, not as an atomic filesystem transaction.

## Usage and pricing

Selected-session tokens and context come from that session's rollout. They never borrow Claude's cache or another Codex session's tokens. Claude account data and GPT account data have separate payloads and consumers, including the usage tabs.

Codex quota windows come from explicit quota events and their timestamps. No reported window means unavailable, not zero used. OAK does not manufacture a token allowance by dividing tokens by a quota percentage. A model-free `account/rateLimits/read` refresh runs through an owned Codex app-server process independently of Claude authentication. Only a response carrying a backend account ID matching the current login is published to the account cache. The account cache serves this machine only. Native local quota snapshots remain a fallback when the account endpoint is unavailable. The protocol is described in the [official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt); the optional response account ID was verified against the installed 0.153.4 schema and a live response. Local transcript totals describe the history present on that machine, not all usage billed to an account.

Historical GPT usage is allocated by event delta, active model, provider, and timestamp, with reset and replay handling. UTC calendar-month totals and their reset do not inherit a Claude billing anchor. Known weekly reset boundaries are used exactly; moving fallback windows query a cached event series without rounding away the boundary. Status bars can show measured month tokens while leaving an unreported allowance unavailable. Known pricing entries and dated aliases are distinguished from approximate family matches. Unpriced or non-OpenAI providers show unavailable cost while preserving token counts. The price table is an estimate, not a billing ledger. Copied history is deduplicated when native turn/usage identity survives; exports that erase that identity cannot establish a shared origin.

## Storage, privacy, and refresh

Raw rollouts under `CODEX_HOME/sessions` and `CODEX_HOME/archived_sessions` remain authoritative and are never rewritten by the parser. Derived version-4 transcripts/cursors live under the OAK store root in `runtime-transcripts/codex`. Source identity, offsets, and an anchor detect replacement/truncation; incomplete UTF-8/JSON tails wait for the next append. A complete JSON object without its final newline is previewed once. Invalid derived state rebuilds from raw history.

The parser reads 1 MiB chunks and caps individual native JSONL records at 4 MiB. Oversized/malformed records are counted, while surrounding records remain readable. Seen-message/usage identity windows are bounded at 20,000 entries each. On a warm append, raw I/O is incremental; derived view aggregation and source directory census still scale with the history they inspect. This is not a promise that every UI operation is constant time.

Unscoped `oak clean` prunes disposable Codex caches older than 30 days or beyond a combined 1 GiB budget, skipping active parser locks. This is explicit maintenance, not a background deletion policy. Raw Codex logs and authoritative edit records are outside this cache policy. Existing store cleanup commands retain their own documented behavior.

Hook journals and derived files use restrictive permissions. Path-bearing hook payloads for `.observatoryignore` matches are redacted before journaling; large event strings, arrays, and nesting are bounded. Prompts, replies, and arbitrary shell output can still contain private data. This is path-aware capture exclusion, not a general secret scrubber. Existing raw runtime logs remain governed by the runtime's storage and retention settings.

Watchers include native Codex roots, hook journals, attention, and agent metadata. Derived cache output is excluded to prevent refresh loops. JetBrains supplements filesystem notifications with bounded polling for native rollouts.

## Platforms and qualification

The editors' **Feed** tab reads the conversation through `oak feed --json`.
New agents start through `oak agent start`; explicit replies use `oak prompt` to reach herdr.
The core Feed test uses `conversation-codex.jsonl` to verify `said` and `thinking` rows. JetBrains
Feed tests cover prose wrapping, block markdown, folded thoughts and prompt navigation. These tests
do not establish a live native/herdr continuation, edit, Undo and Redo run.

The table below records historical results for an earlier backend. They do not qualify herdr control or the current editor viewer.

| Surface | Contract at the time | Verification scope |
|---|---|---|
| PyCharm / JetBrains | Shared core/CLI review policies, usage separation, watchers and legacy store reader | Historical 193 Java 21 tests; PyCharm 2026.1 Stats/usage inspection with the packaged plugin; Plugin Verifier for IntelliJ 2025.2 and PyCharm 2026.1. These checks predate the current Feed tab |
| Remote backend / containers | Backend-owned homes/store, `CODEX_HOME`, Python SSH scanner includes native and archived Codex | Real SSH discovery of native Claude/Codex histories in custom homes; full Remote-SSH/Gateway/WSL IDE qualification remains separate |
| Linux / Node | Node 20+ advertised; deterministic suites on 20, 22 and 24 | Historical checks covered those Node versions |
| macOS | Native arm64 runtime and client checks | 643 JavaScript tests, 193 JetBrains tests, Node 20/22 parity, actual VS Code host, successful native Claude/GPT capture and Undo/Redo; native failure-recovery limitation R27 remains open. These historical checks do not qualify the current backend |
| Windows | Existing CI lane and platform path/spawn implementation retained | No Windows runner used; Linux/macOS skip three Windows-only checks |

A backend must see the same `CODEX_HOME` as its Codex process. `CLAUDE_CONFIG_DIR` continues to select the shared OAK configuration base. The devcontainer template persists both directories. Set environment variables in the remote/container backend, not only in the desktop client. Configure remote machines with `oak machine add`; see [remote development](REMOTE.md).

The model-free native trust gate was run against Codex CLI **0.153.4** using app-server initialize and `hooks/list`: all 12 events trusted. The separate live suite then verified native GPT patch/shell hooks, native Claude hooks, same-conversation continuation and exact-byte Undo/Redo. The historical live suite covered the tested Claude/GPT configurations; model access failures limited its scope. Historical Codex 0.147.0/codex-acp 1.2.0 local-model measurements are not certification for all later releases or models.

## Agent controls

Use the native agent terminal in herdr for approvals, interruption, model selection, and other
interactive controls. OAK provides capture, conversation inspection, review, and explicit prompt
handoff. It does not host an additional agent runtime.
