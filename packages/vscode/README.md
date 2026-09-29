# OAK

A running list of every file change **Claude Code** makes — each with its own **Keep** / **Undo** — right in the VS Code sidebar. Git-free, surgical, and it costs **zero extra Claude tokens** (edits are captured by local hooks, outside the model loop). It is built for **established and mission-critical codebases** rather than throwaway prototypes.

Think of it as the Cursor "keep/undo each change" experience, but for Claude Code, and shareable with your team.

![OAK in VS Code](https://raw.githubusercontent.com/cell-observatory/oak-observatory/main/docs/media/layout.png)

## Setup

1. Install the capture hooks once (this writes OAK's capture hooks into `~/.claude/settings.json`):

   ```bash
   oak init
   ```

   (No `oak` CLI yet? Use the [install one-liner](https://github.com/cell-observatory/oak-observatory#quickstart), or download `oak-observatory-<version>.tgz` from a [release](https://github.com/cell-observatory/oak-observatory/releases) and run `npm install -g --allow-scripts=node-pty ./oak-observatory-<version>.tgz`, then `oak doctor --fix`. Install the hooks while Claude Code is **not** running, then launch it.)
2. Open the **Observatory Traces** view in the Activity Bar (the microscope icon, badged with the pending-edit count). As Claude edits files, they appear in the **Review** list — one row per change, grouped by file.

> **Remote-SSH / devcontainers / WSL:** this extension runs on the **workspace host**, so install it — along with the `oak` CLI, the status line, and the capture hooks — **on the remote**, where `~/.claude` lives (not on your laptop). See the main repo's [Remote development guide](https://github.com/cell-observatory/oak-observatory#remote-development-ssh--devcontainers).

## Updates

The extension installs from a **GitHub Release** `.vsix` (the install one-liner, or `oak update`). A background check of GitHub Releases, when a window opens (at most once a day after a check that succeeds), offers a one-click **Update now** whenever your installed version *differs* from the channel you follow — trigger it anytime from the Command Palette: **“OAK: Check for updates.”** The Overview's version chip also reads the release list when the Overview or its menu opens, at most once an hour after a read that succeeds; a failed read is retried on the next open. The downloaded `.vsix` is sha256-verified and installs through the editor's own extension service, so nothing is needed on your `PATH`. GitHub Releases serve both the stable channel and the **Pre-release (dev) channel**.

## Views

The **review surfaces** live in the Activity Bar (icon-only tabs; the microscope icon is badged with the pending count); the **observatory dashboards** live side-by-side in the bottom panel (like Terminal/Problems). A **status-bar microscope** shows the pending count in realtime (amber while anything awaits review), with the full **review scoreboard** in its tooltip.

- **Overview** (bottom panel) — the flagship **master–detail** view. A left nav of **Sessions** (sessions grouped by workspace on the workspace host, the editor’s workspace first; rows ordered newest conversation first, with titles and statistics), **Workers** — every running agent across the repo's git **worktrees** (correlated git-free, without the git binary), each with a live phase (`~` marks an inferred one), an activity sparkline, ±lines, and risk, nested subagents included — then **Workflows** (orchestration runs), **Tasks** (Claude's own numbered to-dos, each with its ±lines / edits / pending rollup), and **Processes** (background shells this session left running). Selecting a local Sessions row pins what the whole observatory reviews; mirrored transcripts and bridge pointers without a local conversation are excluded. The other tabs re-point the panel alone. The right pane is the selected item's change map: a **Folders strip**, a churn-ranked **Files ledger** sized by ±lines and each file stamped with the exact time of its last change, and a summary bar; selecting a row opens that selection's **feed** in the Timeline's **Feed** tab — a live tail while the agent, run, task, or shell is still working, an audit log once it has finished. Its two-row toolbar steps the pending edits on four review axes — **Diff · File · Folder · Prompt** — and carries the session controls, among them an inline **Search** field (matched as a substring, or as a regex the moment the text carries regex syntax), a **Filter** dropdown (file-type buckets and extensions, its button naming what is applied), a **Sort** dropdown (four orders — newest, oldest, name A→Z, name Z→A; its label names the one in force), and **Active only**: on by default, remembered across hides and restarts, and hiding finished agents, runs, shells, and fully-reviewed work.
- **Feed** (Observatory Timeline) — the native conversation of the selected session (prompts, replies, thinking, tool calls, diffs), or the activity of the selected worker, task or shell. Prompts scope review; Observations and Actions retain the recap and audits. New Session starts an agent through herdr.
- **Review · File History** (Observatory Traces, Activity Bar) — the session's changes as one list, grouped by **file**: pending rows first-class with per-unit and per-file **Keep / Undo**, resolved rows greyed (undone offers **↻ redo**, kept offers **↺ revert**), **Open all in editor** for the pending work as one stacked inline view — the IDE's own syntax highlighting kept inside the green/red bands, lines wrapped to the window, **Keep · Undo** on every block (a decided block keeps its revert/redo), with **Spotlight** and a **Side by side** switch in its bar; an inline header toolbar — a **Search** field (substring, or a regex when the text carries regex syntax), a **Filter** dropdown (file-type / extension), and **Sort** (a dropdown of four orders — newest, oldest, A→Z, Z→A), each naming its own state — with each file header stamped with its last-change time; plus the active file's history. In the editor, each edit gets a **✨ gutter star**, a subtle green/red line tint, a coral ruler mark, and an inline **🔬 #N · +A −R · n/m** menu (**✓ Keep · ✗ Undo · 💬 Chat · ⧉ Diff · ⋯ Details**).
- **The floating review bar** — while the open file has edits awaiting review, a compact bar floats over the code at the current edit: a live **Claude edit #N · +A −R · Diff n/m · File i/k** title with **Keep · Undo · ⌃⌄ · ‹› · ⧉ Diff · 💬 Chat · 💡 Spotlight · ⌄** beside it. It follows as you keep, undo and step, and never steals focus. One axis runs the two surfaces: **⌄** opens the full **review bubble** (Claude's reasoning + the diff in git's own colors), and VS Code's own **^** — the same chevron rotated — goes back down, bubble → bar, then bar → hidden. `claudeObservatory.editorReviewSurface` picks the bar, the bubble, or neither.
- **Stats** (bottom panel) — a live **review scoreboard** over token/usage plots.
- **💬 Chat** — on any action, edit, subagent, or task: hands your own Claude a **context-preloaded** prompt (the target, Claude's reasoning, and the diff or command/result). **Zero-token** — Observatory never calls a model.

The review loop is keyboard-driven: **⌥⌘N** (`ctrl+alt+n`) jumps to the oldest pending edit, **⌥⌘Y** keeps it, **⌥⌘U** undoes it; **⌥⌘-** / **⌥⌘=** step a file's revisions. Keep/Undo operate on the same store as the `oak` CLI, so the two stay in sync.

Try it without Claude: `oak demo` replays a scripted session live through the real pipeline in an isolated `demo-*` session — every panel fills in, and review genuinely works. `oak demo --clean` removes every trace.

See the full feature tour in the [main README](https://github.com/cell-observatory/oak-observatory#the-observatory).

## What's captured

Tool edits (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) plus files changed by `Bash` commands (set `CLAUDE_OBSERVATORY_NO_BASH=1` to opt out). Text files over 5 MB and binary files over 25 MB are skipped; smaller binary files are captured as opaque blobs.

Agent terminals and lifecycle belong to **herdr** (`oak doctor --fix` installs the pinned backend).
Chat about an edit, review comments, and quote actions prepare an editable draft (**Edit first…** opens it
as a document) with an explicit **Send to agent** choice. OAK submits through core to the session's live herdr pane;
failed or unavailable sends retain the clipboard draft. Comments stay unsent until acknowledgement.
Machines are saved with `oak machine add`, which replaces the `remotes` command. Usage is measured on each
machine for itself. `oak server` is only the local TUI focus endpoint.

The Timeline’s **Feed** tab reads prompts, replies, reasoning, tool calls and captured
edits from the selected native transcript.
Run `oak machine add build-box user@host` to register a remote terminal host; review requires the
files and capture store on the editor backend. The editor lists and reviews the sessions of the machine
its workspace runs on; the machine tree, the jump to an agent's herdr pane and Review of a session on
another machine are in the terminal app (`oak`). `oak doctor --fix` repairs the local herdr setup.
