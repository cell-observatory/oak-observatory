# OAK for JetBrains IDEs

Per-edit **Keep / Undo** for [Claude Code](https://claude.com/claude-code) on established and
mission-critical codebases, in PyCharm, IntelliJ, WebStorm, GoLand, and every other JetBrains IDE
(platform-only APIs — no language plugin required).
The same store, engine, and review model as the CLI and the VS Code extension: all three front-ends
stay in sync because they read and write the same `~/.claude/claude-observatory` store.

![OAK in PyCharm](../../docs/media/pyc-layout.png)

See the full feature tour in the [main README](../../README.md#the-observatory); the notes below are
JetBrains-specific.

## Requirements

- A JetBrains IDE **2025.2+**
- The `oak` CLI on this machine (the plugin drives it for every store mutation —
  undo/redo correctness lives there, deliberately). Install it via the [one-command bootstrap](https://github.com/cell-observatory/oak-observatory#install), or from a release tarball: `npm i -g --allow-scripts=node-pty ./oak-observatory-<ver>.tgz`, then `oak doctor --fix`
- Capture hooks installed: `oak init --with-statusline` (with Claude Code closed;
  `--with-statusline` also enables the 5h/week Usage bars)

## Install

**With the CLI (any platform, no bash needed):**

```bash
oak install-extensions --jetbrains-only     # downloads + installs, then restart the IDE
```

**From a GitHub Release, by hand:** download `oak-observatory-jetbrains-<ver>.zip` → Settings →
Plugins → ⚙ → **Install Plugin from Disk…** → restart.

**From this repo:**

```bash
./scripts/install-jetbrains.sh   # builds, then installs via the CLI, then restart the IDE
```

IDE detection lives in the CLI, which covers macOS (`~/Library/Application Support/JetBrains`), desktop
Linux (`~/.local/share/JetBrains`), Windows (`%APPDATA%\JetBrains` — natively, from PowerShell or cmd,
not only Git Bash), and JetBrains Remote Development backends (`~/.config/JetBrains/RemoteDev-*`), so it
also works when run on an SSH host.

## Auto-updates

Install-from-Disk (and `install-jetbrains.sh`) is a one-time side-load — it does **not** auto-update.
To have the IDE keep the plugin current on its own, add the self-hosted plugin repository **once**:

**Settings → Plugins → ⚙ → Manage Plugin Repositories → +**, then paste:

```
https://github.com/cell-observatory/oak-observatory/releases/latest/download/updatePlugins.xml
```

New releases then appear under **Settings → Plugins → Updates**, exactly like a Marketplace plugin —
this repository descriptor is regenerated and attached to every GitHub Release. To follow the
**pre-release channel** (the rolling build of the `dev` branch) instead, subscribe to its descriptor
rather than the one above:

```text
https://github.com/cell-observatory/oak-observatory/releases/download/dev-latest/updatePlugins.xml
```

(Prefer the terminal or the Overview's version chip? `oak update` refreshes the plugin
in place from your channel's newest release — `--channel dev` / `--channel stable` switches channels —
and the chip at the right edge of the Overview toolbar does the same from inside the IDE; restart the
IDE afterward. To show whether an update is available, the chip runs `oak version --check`, which
reads the release list from GitHub, about once an hour while the Overview is open, and every five
minutes until a read succeeds. The full channel story: [Releases & channels](https://cell-observatory.github.io/oak-observatory/releases.html).)

## Remote development (Gateway / Toolbox over SSH)

The plugin runs **on the host** — platform-only APIs, no JCEF — which is exactly where `~/.claude`,
the store, and Claude Code live; the tool windows and status bar are remoted to the JetBrains
Client. Install it on the host with the script above (in the remote terminal), and install the
CLI + hooks + status line on the remote too. One caveat: the backend isn't a login shell, so
`CLAUDE_CONFIG_DIR`/PATH exports in shell profiles don't reach it — if the CLI or store isn't
found, set both explicitly in **Settings → Tools → OAK**. Full walkthrough:
[main README → Remote development](../../README.md#remote-development-ssh--devcontainers).

## What you get

| Surface | Where |
| --- | --- |
| **Review / File History** (the **Review** tab is THE review surface: the session's changes as a **tree** — folder → file → class → unit — with a counts header (carrying an inline **Search** field — substring, or a regex when the text carries regex syntax — a **Filter** dropdown for file-type / extension, and a **Sort** dropdown (four orders — newest, oldest, A→Z, Z→A), the Filter and Sort buttons each naming their own state), Open all / Keep all / Undo all / Clear resolved above it, each file stamped with its last-change time, a labelled Keep · Undo · Redo · Chat · Diff toolbar for the selected row, and a cancelled-out footer with Dismiss; resolved rows stay greyed with redo/revert, and **Open all in editor** stacks the pending work as one hunks-only view (VS Code shows the same units as a flat list grouped by file — the model is shared, the presentation follows each IDE); **File History** is a flat, chronological list of just the active file's edits that follows the editor) | "Observatory Traces" tool window, left stripe |
| **Feed · Prompts · Observations · Actions** — the Feed reads the native conversation with reasoning, tools and captured diffs, and follows the selected worker, task or shell. Prompts scope review, and Group Tabs shows the readers side by side. New Session starts an agent in herdr. | Observatory Timeline |
| **Overview · Stats** side-by-side panes. The **Overview** is the flagship **master–detail** view: a **Sessions · Workers · Workflows · Tasks · Processes** nav on the left (running agents across the repo's git **worktrees** — live phase with `~` marking inferred ones, sparkline, ±lines, risk, nested subagents; orchestration runs; Claude's own numbered to-dos with their ±lines / edits / pending rollups; the background shells this session left running; and sessions grouped by workspace on the workspace host, the editor’s workspace first; rows ordered newest conversation first, with titles and statistics), and the selected item's change map on the right (a Folders strip, a churn-ranked Files ledger with each file's last-change time, and a summary bar; selecting a row opens that selection's feed in the Timeline's **Feed** tab — a live tail while the agent, run, task, or shell is still working, an audit log once it has finished). Selecting a local **Sessions** row pins what the whole observatory reviews; mirrored transcripts and bridge pointers without a local conversation are excluded. The other nav tabs only re-point this panel. Stats leads with a live **review scoreboard** — pending / accepted / reverted counts + a progress bar — over the tokens plot | "Observatory Dashboards" tool window, bottom stripe |
| **Review nav bar** — a top row of session controls (the name of the session under review, as a label — the **Sessions** tab and the Timeline's selector are where it changes · Accept All · Reject All · Clear Resolved · Export · an inline **Search** field (substring, or a regex when the text carries regex syntax) · **Filter** (file-type / extension, its button naming what is applied) · **Sort** (four orders — newest, oldest, A→Z, Z→A; its label names the one in force) · **Active only**, on by default and remembered · Clear completed · Spotlight · Refresh) over a bottom row of four review axes — **Diff · File · Folder · Prompt** — that step the pending edits at four granularities. The Prompt axis carries **Rewind to before this prompt**, which reverts every unreviewed edit from that ask *onward*; its confirmation states the records and the review units it will revert, and the toast that follows offers **Redo the rewind** for exactly those edits | Overview pane, above the change map |
| **Floating review bar** — a true overlay on the platform's own `editorFloatingToolbarProvider` layer, over any editor whose file still has unreviewed edits: **Keep · Undo · Chat · View diff · ‹ `Diff n/m` › · Accept File · Reject File · Spotlight · Clear Resolved**. It stays up while the file has pending edits rather than hiding on pointer-exit, and it is the **default** in-editor surface since 0.10.0 — `editorReviewSurface` chooses it, the notification banner it replaced, both, or neither | every main editor |
| **Inline menu** — `✦ #N  +A −R  ·  edit n/m in file  ·  file i/k  view changes` (opens the edit's inline diff) then `✓ Keep · ✗ Undo · ❝ Chat · ⧉ View diff` on the lens above each pending edit; a **✨ gutter star** (click to open the diff), a subtle green/red line tint, removed lines drawn as italic **ghost text**, a **Claude-coral error-stripe** marker | every editor |
| **Click → inline diff** — the edit's before ⟷ after opens **unified**, with Claude's reasoning in the title and `Keep · Undo · Chat` on the diff toolbar; **Spotlight** dims the unedited lines (the floating review bar, the status-bar nav bar, the Overview toolbar — and the editor banner when `editorReviewSurface` enables it) | every editor |
| **🔬 scoreboard** — pending count, accept rate, oldest pending; click = review next | status bar |
| **Keyboard loop** — `⌥⌘N` review next · `⌥⌘Y` keep at cursor · `⌥⌘U` undo at cursor · `⌥⌘[` / `⌥⌘]` step file revisions in a diff (`Ctrl+Alt` on Windows/Linux) | global |

The sidebar window's tabs carry an icon and a label, and the tool-window stripe shows a **pending
badge**. The plugin tracks the VS Code extension **feature-for-feature** — every surface (the
master–detail Overview, the Fleet across worktrees, the Prompts window and its prompt-scoped
review, the context-preloaded **💬 Chat** handoff) ships in both. All panels refresh in **real time**
on any tool call — a `TranscriptWatcher` watches the session transcripts — and share throttled CLI
fetches (≤1 spawn per view per ~3s), so live views stay cheap.

Try it without Claude: `oak demo` replays a scripted session live through the real
pipeline in an isolated `demo-*` session — every panel fills in, and review genuinely works.
`oak demo --clean` removes every trace.

Undo is surgical (position-anchored 3-way merge, via the CLI): reverting one edit preserves later
edits to the same file; genuine overlaps surface a conflict dialog with a **Force-restore** option.
Unsaved files prompt **Save & Continue** before any disk-writing operation.

## Settings

**Settings → Tools → OAK**: paths for the `oak` and `claude` CLIs
(blank = auto-detect), a `CLAUDE_CONFIG_DIR` override (for relocated config dirs, for example
devcontainer volumes), a pinned session (blank = auto-resolve the newest), the inline-overlay toggle,
and a **unified diff** toggle (open edit diffs in the inline red/green viewer instead of side-by-side).

Three more arrived in 0.10.0:

- **Review controls in the editor** — *Floating bar over the code* (the default), *Banner above the
  editor* (the pre-0.10 behaviour), *Both*, or *Neither*. Stored as `editorReviewSurface`; an
  unrecognized value reads as the floating bar rather than as nothing.
- **After keeping or reverting one edit, open the next edit still awaiting review** — on by default.
  It crosses into another file when that is where the next edit is. Bulk operations, task operations
  and redo never move you, and neither does a resolve that did not happen (a refusal, an unsaved
  buffer, a cancelled conflict). Turning it off also stops the floating review bar from following.
- **Group all tabs side by side (Sessions · Workers · Workflows · Tasks · Processes)** — off by
  default; it trades change-map width for seeing all five of the Overview's nav tabs at once. The
  Timeline's own four-column mode is a separate toggle, **Group Tabs**, beside that window's tab strip.

## Architecture (for contributors)

The plugin is a Kotlin **front-end over the TypeScript core**, never a re-implementation:

- **Mutations & diff-dependent reads** → the `oak` CLI (`undo/redo --json`,
  `locate` for live-buffer line mapping, `stats/usage/observe --json`). The 3-way undo engine is
  correctness-critical and lives in one place.
- **Cheap reads** → straight off disk (`log.jsonl` + status-op folding, content-addressed blobs,
  session resolution) — schemas match core's `store.ts`/`session.ts`, locked in by the unit tests
  in `src/test/kotlin` (`./gradlew test`).
- **Live refresh** → a `TranscriptWatcher` (per-directory `nio` watches with dynamic new-dir handling
  and an ENOSPC→poll fallback) refreshes every panel on any tool call; panels share one throttled CLI
  fetch per view (≤1 spawn per view per ~3s), mirroring VS Code's webview throttle.
- **Stats plots** → native Swing (no JCEF): step-line charts + usage bars that track pane width.

```bash
./gradlew test buildPlugin   # unit tests + build/distributions/oak-observatory-jetbrains-<ver>.zip
./gradlew runIde             # throwaway sandbox IDE with the plugin preloaded
./scripts/install-jetbrains.sh   # (from repo root) build + install into your real IDE
```

Agent terminals and lifecycle belong to **herdr** (`oak doctor --fix` installs the pinned backend).
Chat about an edit, review comments, and quote actions prepare an editable draft, in a dialog, with an
explicit **Send to agent** choice. OAK submits through core to the session's live herdr pane;
failed or unavailable sends retain the clipboard draft. Comments stay unsent until acknowledgement.
Machines are saved with `oak machine add`, which replaces the `remotes` command. Usage is measured on each
machine for itself. `oak server` is only the local TUI focus endpoint.

The Timeline’s **Feed** tab reads prompts, replies, reasoning, tool calls and captured
edits from the selected native transcript.
Run `oak machine add build-box user@host` to register a remote terminal host; review requires the
files and capture store on the editor backend. The editor lists and reviews the sessions of the machine
its workspace runs on; the machine tree, the jump to an agent's herdr pane and Review of a session on
another machine are in the terminal app (`oak`). `oak doctor --fix` repairs the local herdr setup.
