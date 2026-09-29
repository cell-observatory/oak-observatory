# 🔬 OAK

[![Linux](https://github.com/cell-observatory/oak-observatory/actions/workflows/linux.yml/badge.svg)](https://github.com/cell-observatory/oak-observatory/actions/workflows/linux.yml)
[![macOS](https://github.com/cell-observatory/oak-observatory/actions/workflows/macos.yml/badge.svg)](https://github.com/cell-observatory/oak-observatory/actions/workflows/macos.yml)
[![Windows](https://github.com/cell-observatory/oak-observatory/actions/workflows/windows.yml/badge.svg)](https://github.com/cell-observatory/oak-observatory/actions/workflows/windows.yml)
[![VS Code](https://github.com/cell-observatory/oak-observatory/actions/workflows/vscode.yml/badge.svg)](https://github.com/cell-observatory/oak-observatory/actions/workflows/vscode.yml)
[![JetBrains](https://github.com/cell-observatory/oak-observatory/actions/workflows/jetbrains.yml/badge.svg)](https://github.com/cell-observatory/oak-observatory/actions/workflows/jetbrains.yml)
[![CodeQL](https://github.com/cell-observatory/oak-observatory/actions/workflows/codeql.yml/badge.svg)](https://github.com/cell-observatory/oak-observatory/actions/workflows/codeql.yml)
[![Pages](https://github.com/cell-observatory/oak-observatory/actions/workflows/pages.yml/badge.svg)](https://github.com/cell-observatory/oak-observatory/actions/workflows/pages.yml)
[![Release](https://github.com/cell-observatory/oak-observatory/actions/workflows/release.yml/badge.svg)](https://github.com/cell-observatory/oak-observatory/actions/workflows/release.yml)
[![Dependabot](https://img.shields.io/badge/dependabot-enabled-025E8C?logo=dependabot&logoColor=white)](https://github.com/cell-observatory/oak-observatory/blob/main/.github/dependabot.yml)
[![Version](https://img.shields.io/badge/version-v0.11.0--dev.0-blue)](https://github.com/cell-observatory/oak-observatory/releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/cell-observatory/oak-observatory/blob/main/LICENSE)



**[🔬 Live showcase →](https://cell-observatory.github.io/oak-observatory/)** &nbsp;·&nbsp; **[Interactive demo →](https://cell-observatory.github.io/oak-observatory/showcase.html#demo)** &nbsp;·&nbsp; [Changelog](CHANGELOG.md)

**Per-edit Keep / Undo for [Claude Code](https://claude.com/claude-code).** Every file change Claude makes
becomes a reviewable entry with its own surgical undo — in your **terminal**, **VS Code**, and **JetBrains
IDEs** — at **zero extra Claude tokens**. The review model resembles Cursor's per-change keep/undo, but it
is standalone, shareable, and git-free. It is built for **established and mission-critical codebases**
rather than throwaway prototypes.

OAK uses **herdr** as its required terminal backend. **Install oak, get herdr**: the installers
install the version pinned in `herdr.lock` (currently 0.9.1), verify its checksum, install the Claude
and Codex integrations, and link OAK’s herdr plugin. A newer installed herdr is preserved.
Run `oak doctor --fix` to repair the backend, native terminal helper permissions, or an outdated
OAK focus server. `oak doctor` also checks forwarding latency for saved machines, and (on Linux and
macOS) reports a herdr server that was started from inside a Claude Code session: its panes would
then run Claude Code agents as child sessions with transcript saving off. Stop it from a plain
terminal with `herdr server stop`, then `oak doctor --fix`. The installers, `oak update` and
`oak doctor --fix` also widen herdr's sidebar on the machine they run on (`ui.sidebar_min_width` 48 /
`ui.sidebar_max_width` 72 in herdr's `config.toml`, only when no width was set by hand) so the
session titles OAK gives herdr's tabs are not clipped, and set `theme.name = "gruvbox"` when no
theme name is set; herdr's divider drags between those two widths, and existing theme choices stay.

OAK names herdr's tabs after the sessions their panes run and renames them when a session's title
changes, never a tab you named yourself: each session's capture hooks and its status line rename its
own tab, and `oak tui` renames the tabs of this machine and of every saved machine while it runs. On
Linux and macOS, `oak tui` also keeps a `btop` tab running a system monitor (btop, bpytop or htop) in
the `home` workspace of this machine and of every saved machine. The tab is made again
whenever it is missing, and OAK types the monitor's command only into the monitor's own pane
(labelled `btop`) while its shell is idle at the prompt. That pane comes back as a plain shell when
herdr's server restarts, so OAK's herdr plugin starts the monitor again as the server starts, wherever
the installers, `oak update` or `oak doctor --fix` linked it ([herdr tab](https://cell-observatory.github.io/oak-observatory/tui-herdr.html#tab-names-and-the-btop-tab)).

## The observatory

![The observatory in VS Code: the Observatory Traces sidebar (Review · File History), the editor with the inline lens and the compact review bar, the Observatory Dashboards bottom panel (Overview · Stats), the Observatory Timeline panel (Feed · Prompts · Observations · Actions) with its session selector and Group tabs toggle, and the microscope scoreboard in the status bar](docs/media/layout.png)

## Why use it?

Claude can change dozens of files in one turn. On established and mission-critical codebases, a giant
diff skimmed at the end is not review. The observatory keeps you **in the loop on every edit**, deciding
one change at a time.

- **Surgical review of AI edits** — accept, undo, or diff each change individually; undo one edit while
  keeping later edits to the same file.
- **One change, however many tries** — repeated edits to the same lines or the same function collapse
  into one review unit showing the net diff, bounded by the prompt that produced them; a superseded
  intermediate state never asks for a decision. The editors' **Review** tab lists the session's
  pending changes — scoped to one ask when a prompt is selected — and opens them in the editor: one
  unit's net diff per row, or everything listed concatenated into a single view with per-diff
  Keep/Undo; in the terminal, opening a prompt scopes the Review list the same way. A file
  deleted and re-created is one decision, not two contradictory rows, and a chain that ends where it
  started — a file created then deleted, an edit put back — is nothing to review: those are named in
  one footer with a Dismiss rather than listed. Every count means the same thing by "pending", from
  the review list to the change map to the status bar.
- **Established and mission-critical codebases** — keep a human in the loop when Claude touches code whose
  failure is expensive.
- **Any surface** — the same store is read/written by the CLI, the VS Code sidebar, and the JetBrains
  plugin, so terminal and editor stay in sync (great for remote/SSH/devcontainers where Claude runs on a host).
- **Sessions by workspace** — Overview → Sessions in VS Code and JetBrains lists sessions on the
  workspace's machine, grouped by project with this workspace first. Each row shows its title,
  tokens, duration, model and edit count. Remote editor windows list sessions on their remote host.
- **Shareable & auditable** — a git-free content-addressed log of what the agent did and what you decided,
  that you own and can hand to a teammate.
- **Know when an agent needs you** — the hooks record what every session is waiting on (a permission
  prompt and its tool, a question, your input), so a raised hand reaches you as a desktop notification,
  a **needs you** list in every surface (terminal `i` on the Review tab, the editors' session selector
  and Sessions tab), and a one-key jump to the most urgent one (terminal `h` on the Review tab,
  VS Code's status-bar `⚠` chip, JetBrains ⌥⌘I, or Ctrl+Alt+I on Windows and Linux). On the
  Observatory tab, `i` replies and `h` focuses herdr. Nothing is ever answered for you; the
  notification says who is waiting. On macOS, when OAK runs in iTerm2, Ghostty, WezTerm or kitty, the
  terminal posts the notification under its own name, and clicking it brings the terminal forward.

Complements Claude Code's native `/rewind` (whole-turn) with **per-edit** control, and costs **zero extra
tokens** — capture runs in local hooks, entirely outside the model loop.

## Quickstart

**1 — Install** the CLI + editor extensions from the latest [release](https://github.com/cell-observatory/oak-observatory/releases)
(requires Node.js 20+, and `python3` on Linux and macOS; on Linux, also `make` and a C++ compiler for
node-pty, the terminal app's herdr tab, with `oak attach` as the route that needs no PTY; see
**Platforms** below):

```bash
# macOS / Linux (and Windows via Git Bash)
curl -fsSL https://raw.githubusercontent.com/cell-observatory/oak-observatory/main/scripts/bootstrap.sh | bash
```

```powershell
# Windows — native, no bash needed
irm https://raw.githubusercontent.com/cell-observatory/oak-observatory/main/install.ps1 | iex
```

Both install the CLI and then the extensions for whatever editors are on the machine — VS Code family
and/or JetBrains. For the rolling [pre-release channel](#keeping-up-to-date) — the choice is remembered,
so later updates follow it — a piped script needs its arguments passed through:

```bash
curl -fsSL https://raw.githubusercontent.com/cell-observatory/oak-observatory/main/scripts/bootstrap.sh | bash -s -- --channel dev
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/cell-observatory/oak-observatory/main/install.ps1))) -Channel dev
```

**2 — Wire the capture hooks** — with **Claude Code closed** (it snapshots hooks at session start):

```bash
oak init          # add --with-statusline for the 5h/week Usage bars
```

**3 — Launch Claude Code** and start working. Every edit is captured automatically; open the **🔬
Observatory Traces** view in your editor (or run `oak list`) to review.

**Try it without Claude** — the same scenario is clickable in the browser on the
**[interactive demo](https://cell-observatory.github.io/oak-observatory/showcase.html#demo)** on the
homepage, nothing to install. In your editor, run **Start Demo Mode** from the VS Code command palette or JetBrains Find Action, use
the buttons at the end of the Overview's nav bar, or click **Try the demo** in an empty panel. It replays a scripted
session through the real pipeline in an isolated `demo-*` session and an `observatory-demo/` folder it
creates in the current directory, then walks you through every panel. In the terminal the same replay is
`oak demo`, and `oak demo --tour` prints the tour as prose. Starting it
again resets it; **Exit Demo Mode** (or `oak demo --clean`) removes every trace.

![oak demo — the simulator narrates each beat (three prompts, the plan, tasks 1–4, a failed call, a subagent, a second agent on demo/hotfix, a workflow run, the recap) and ends with nine pending edits in observatory-demo/, pointing at demo --tour and demo --clean](docs/media/demo.png)

**Prefer to let Claude install it?** Paste this prompt into a Claude Code session:

```text
Please install OAK (github.com/cell-observatory/oak-observatory) for me:
run its installer with
  curl -fsSL https://raw.githubusercontent.com/cell-observatory/oak-observatory/main/scripts/bootstrap.sh | bash
then run `oak doctor` and show me the output. Note: the capture hooks only
take effect on a fresh session — after installing, tell me to quit you, run
`oak init` in a plain terminal, and relaunch you.
```

> Verify anytime with `oak doctor`. Update by re-running the one-liner or `oak update`.
> Full install options (Windows, build-from-source, per-editor, teams) are in [Install](#install) below;
> remote/SSH/devcontainer setup is in **[docs/REMOTE.md](docs/REMOTE.md)**.

## `.observatoryignore` — the edits not worth your attention

Lockfiles, `dist/`, snapshots, generated clients. Put them in a `.observatoryignore` and they are
**never recorded**: not captured, so not listed, not counted, and not revertible — there is nothing
to revert. It is `.gitignore` syntax, because that is the syntax you already know.

```gitignore
package-lock.json
dist/*
!dist/manifest.json
**/*.mp4
```

**One mode, and it is the sharp one.** There is no "hide but keep" — anything a rule matches simply
never enters the store. That makes this the one file in the product where a typo costs data rather
than visibility, which is why `ignore --check` names the rule that decided and why the linter below
reports a rule that can never fire. A rule you add later also applies to what is already recorded:
the matching edits are dropped on the next capture, and the count is reported.

Files nest like `.gitignore`: one in any directory governs its subtree, and the nearest wins.
There are **three tiers**, in git's own precedence order — highest first:

| Where | For |
| --- | --- |
| `.observatoryignore`, in any directory | rules everyone on the project should share (committed) |
| `.git/info/observatoryignore` | rules for *this checkout only* — never committed |
| `~/.claude/.observatoryignore` | your own rules, in every repo you work in |

That middle tier is git's `$GIT_DIR/info/exclude`, and it exists for the same reason: without it, the
only way to exclude something in one checkout is to commit that decision into a repo other people
work in.

Because a hand-written pattern can misfire, one verb explains any single path:

```console
$ oak ignore --check package-lock.json
ignored package-lock.json
  by  package-lock.json   (.observatoryignore:1)
  edits to it are never recorded — there is nothing to undo later
```

**And it tells you when a rule can never fire**, which `git check-ignore` does not. Write the trap —
`dist/` and then `!dist/manifest.json`, rather than the `dist/*` above — and the verb says so
unprompted, before you go looking:

```console
$ oak ignore
…
1 rule(s) can never match:
  !dist/manifest.json   (.observatoryignore:3)
    "dist/" on line 2 excludes dist/, and nothing beneath an
    excluded directory is ever consulted. Write "dist/*" there instead, then negate.
```

That is gitignore's most famous trap — the manual's own words are *"it is not possible to
re-include a file if a parent directory of that file is excluded"*. This follows git rather than
quietly diverging from it — git tried twice to relax the rule and reverted both times, for reasons
(directory pruning) that do not apply here but whose *other* justification, keeping one top-level
file consistent with nested ones, does. So the behaviour matches and the tool explains it instead.

For scripting, the verb takes git's flags and answers the way `git check-ignore` does — many paths or
`--stdin`, `-v` for the machine format `<source>:<line>:<pattern><TAB><path>`, `-n` to report
non-matching paths too, `-z` for NUL separators, `-q` for exit status only, and **exit 0 when a path
is ignored, 1 when none are**. Its `-v` output is verified byte-for-byte against real `git
check-ignore -v -n` in the test suite, so anything that already parses git parses this.

## Install

The one-liner in [Quickstart](#quickstart) covers most people. The details:

### Keeping up to date

`oak update` refreshes **everything installed** — the CLI, the VS Code extension, and
the JetBrains plugin — from the release channel you follow (add `--check` to preview without
installing, or `--json` for the same plan as data); re-running the [one-liner](#quickstart) does the
same. The CLI also nudges you once a day when your installed build differs from the channel's newest
(opt out with `CLAUDE_OBSERVATORY_NO_UPDATE_CHECK=1`).

**Following a channel means matching it.** A surface is refreshed whenever its version *differs*
from the channel's newest — not only when the release is higher. That is what makes switching
channels work in both directions, and it is what rescues a build that sits *above* the channel: a
local build, or anything installed from a `dev` checkout, reports `not on this channel` and is pulled
back onto it. (Before 0.9.5 such an install reported "up to date" on every channel, forever.)

There are **two release channels** (full story: [the Releases page](https://cell-observatory.github.io/oak-observatory/releases.html)):

- **Stable** (the default) — tagged releases, cut from `main`.
- **Pre-release** — a rolling build of the `dev` branch, republished on every push, versioned
  `<next>-dev.<n>`. Newest features, less soak time.

Switch from the **version chip** at the right edge of the Overview's toolbar in either editor (its
menu lists what each surface has installed — extension, CLI, plugin — and offers **Update now** and
the channel switch), or from the terminal: `oak update --channel dev` (back with
`--channel stable` — switching installs that channel's newest immediately, downgrades included, and
updates follow it from then on). Beyond that, each surface can keep **itself** current:

- **CLI** — `oak update`, or the daily nudge above; `oak version --check`
  shows your installed version next to the latest release at any time.
- **VS Code** — a background check (once a day) offers a one-click **Update now**; or run
  **“OAK: Check for updates”** from the Command Palette. Downloads are sha256-verified.
  The extension installs its own `.vsix` through the editor, so updating and switching channels need
  nothing on your `PATH` — no `code` shell command, and no CLI. The CLI is used only to refresh
  *itself* and the JetBrains plugin, and if it is absent the extension says so and updates anyway.
- **JetBrains** — add the self-hosted plugin repository **once** and the IDE auto-updates the plugin
  like any Marketplace plugin (see [the JetBrains guide](packages/jetbrains/README.md#auto-updates)):
  **Settings → Plugins → ⚙ → Manage Plugin Repositories → +**, then paste
  `https://github.com/cell-observatory/oak-observatory/releases/latest/download/updatePlugins.xml`
  (pre-release channel: the same path under `releases/download/dev-latest/` instead of
  `releases/latest/download/`).

**Platforms:** herdr is required on every platform and ships for Linux and macOS on x86_64 and arm64,
and Windows on x86_64 only; Windows-on-ARM has no herdr build. Windows support for herdr-backed pane
listing, replies and agent start is untested in this release. `oak machine add` targets must be POSIX hosts.
On **Linux**, npm compiles node-pty, the helper the terminal app's herdr tab runs herdr in, while it
installs OAK. That needs `python3`, `make` and a C++ compiler (`g++`, or whatever `$CXX` names;
`build-essential` on Debian and Ubuntu), an npm prefix with no space in its path, and, under npm 12,
`--allow-scripts=node-pty`, without which npm skips the build (the installers and `oak update` take
care of it). Without them the install still succeeds, but the herdr tab cannot start, and
`oak doctor` warns and names what is missing: fix that, then reinstall OAK (re-run its installer, or
`oak update --cli-only --force`).
Meanwhile `oak attach` opens herdr without it, handing the terminal to herdr's own client with OAK in
a pane. macOS and Windows use node-pty's prebuilt binaries.
On **Windows**, install with `install.ps1` in native PowerShell without bash or WSL. npm's
`.cmd` shims are handled through one launcher (`packages/core/src/spawn.ts`). Piping the bash one-liner
into PowerShell is the one thing to avoid: with WSL installed it silently installs everything *inside*
WSL, where Claude Code on the Windows side cannot see it. The **bundled status line**
is a bash script that parses its input with `jq` (and uses `python3` for the token estimates), so the
Usage bars need Git Bash + `jq` (`winget install jqlang.jq`) on PATH. Windows paths are canonicalized
for drive-letter case everywhere (capture, lookups, both editors); a store written by v0.8.9 or earlier
may hold phantom `+N −0` / `+0 −N` edit pairs from that bug — they heal on read, and
`oak clean --phantoms` removes them for good (#43).

**Build from source (contributors):**

```bash
./install.sh                 # deps → build → CLI on PATH → extensions → status line → offer `init`
./install.sh --jetbrains     # also build + install the JetBrains plugin (needs JDK 21 + Gradle)
```

Or step by step:

```bash
npm install                                        # workspace deps
npm run build                                      # build core + tui + cli
npm i -g --allow-scripts=node-pty ./packages/cli   # put `oak` on PATH  (or: npm link in packages/cli)
                                                   # upgrading from claude-observatory? npm uninstall -g claude-observatory first
oak doctor --fix                                   # install the pinned herdr, its integrations and OAK's herdr plugin
oak init --with-statusline                         # capture hooks + the bundled status line (backs settings up first)
```

Until `oak doctor --fix` has installed herdr, the terminal app's herdr tab cannot start it and says
`could not launch <path to herdr> — run oak doctor --fix`.

The [claude-statusline](https://github.com/cell-observatory/claude-statusline) status line is **bundled**
— `oak statusline` installs/refreshes it with no network (it powers the Usage bars; it's a
bash script and needs `jq` on the PATH, on every platform). Refresh the vendored copy with
`bash scripts/sync-statusline.sh`.

> **Important — install hooks _before_ launching Claude Code.** Claude Code snapshots your hooks at session
> start, so hooks added to a **running** session get reverted. Run `oak init` with Claude
> Code closed, then launch it. Verify with `oak status`.

**VS Code extension** (optional):

```bash
npm run build:vscode
cd packages/vscode && npm run package     # -> oak-observatory.vsix
code --install-extension oak-observatory.vsix
```

Fully quit VS Code (⌘Q) once after installing so the activity-bar icon refreshes. The extension then
keeps itself current — a daily background check offers a one-click **Update now** (see [Keeping up to
date](#keeping-up-to-date)).

**JetBrains / PyCharm plugin** (optional; needs JDK 21 + Gradle to build — or grab the `.zip` from a
[Release](https://github.com/cell-observatory/oak-observatory/releases)):

```bash
./scripts/install-jetbrains.sh   # build + install into your local JetBrains IDEs, then restart the IDE
```

Or manually: **Settings → Plugins → ⚙ → Install Plugin from Disk…** with the built/downloaded zip. Works in
every JetBrains IDE (platform-only APIs — PyCharm CE/Pro, IntelliJ, WebStorm, …). For hands-off updates
afterward, add the [plugin repository](packages/jetbrains/README.md#auto-updates) once. Details:
[packages/jetbrains/README.md](packages/jetbrains/README.md).

**Teams:** run `oak init --project` to write the hook into the repo's `./.claude/settings.json`
(checked in). Teammates then only need `oak` on their PATH.

### Remote development (SSH & devcontainers)

The extension runs on the **remote host** (where Claude, the
transcripts, and the store live). Full setup — Remote-SSH, JetBrains Gateway/Toolbox, the devcontainer
template, and relocating `CLAUDE_CONFIG_DIR` — is in **[docs/REMOTE.md](docs/REMOTE.md)**.

## How it works

| Piece | What it does |
| --- | --- |
| **Capture hook** (`capture`) | PreToolUse snapshots the file before an edit, PostToolUse commits before + after, and PostToolUseFailure does the same for a tool that failed (a Bash command that exits non-zero). Zero-dep, always `exit 0`, never writes to the model context. Captures `Edit` / `Write` / `MultiEdit` / `NotebookEdit` — and files changed by `Bash` (set `CLAUDE_OBSERVATORY_NO_BASH=1` to opt out). The same command sits on five *attention* events — `Notification`, `PermissionRequest`, `Stop`, `UserPromptSubmit`, `SessionEnd` — recording what each session is waiting on (a permission prompt and its tool, your input, a finished turn). It clears the wait when the agent moves on (an edit or Bash call starts, or the edit or Bash call a permission prompt was for returns), when a prompt answers it, or when the session ends; a permission prompt on any other tool (a web fetch, an MCP call) stays up until one of those, or until the turn ends. It never answers a permission and never writes to stdout. Inside a herdr pane, `Stop` and `UserPromptSubmit` also start a detached `oak __tab-sync`, which renames the session's herdr tab after its title. |
| **Store** | `~/.claude/claude-observatory/<session_id>/` — `log.jsonl` (append-only) + content-addressed `blobs/`. No network. |
| **Session resolution** | The active session is the newest transcript **that holds a real conversation**. Local commands (`/effort`, `/model`), interrupted commands, and bridge records write command-only transcript stubs; those never displace the session under review (0.8.4). When the current session has no edits yet, the panels say so honestly and offer a one-click switch to the previous session's work. |
| **Undo engine** | Position-anchored 3-way line merge (base = the file right after the edit; sides = current on-disk content and the pre-edit content). Later edits to other lines survive; a genuine overlap → clear conflict + per-file restore. Anchoring on line positions (not fuzzy text search) keeps it safe against duplicated content. |
| **Observations** | Correlates each edit with Claude's real reasoning + to-dos parsed from the session transcript — zero token. |
| **Front-ends** | The CLI (in-process), the VS Code sidebar (in-process `core`), and the JetBrains plugin (over the CLI + store) — all on the same store + engine. |
| **Agent backend** | herdr owns terminals and agents; OAK captures edits with hooks and transcript parsing and renders the conversation from transcripts. |
| **codex hooks** *(0.10.0)* | `init --codex` installs the same capture for codex ≥0.147.0, whose hook system speaks Claude Code's payload dialect. Shell edits land with real before/after content; codex's rollout file supplies prompts, tokens (with the cache split), model + effort. Installation checks configuration without starting a model; `status` re-checks trust and `integrity --session <id>` reports capture gaps. Sessions retain native IDs and model tags. Current contract and validation limits: [Codex/GPT support](docs/CODEX-SUPPORT.md). |

Architecture deep-dive: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Agents and conversations

OAK uses **herdr** for terminal sessions, agent lifecycle, and remote machines. Run `oak doctor --fix`
to install the pinned backend and integrations. `oak tui` has three primary tabs:
**herdr · Observatory · Review**. The herdr tab runs the real herdr client; in the terminal app a
session starts there, in herdr's own tab bar and sidebar on the selected machine, rather than from an
OAK control. OAK's outer bar has three fixed tabs — `ctrl+a` then `n`/`p` or `1`–`3` switches them (inside a
herdr pane, as `oak attach` runs it, there is no herdr tab: herdr is the host, and its own keys move between
its tabs); `ctrl+q`
twice quits from any tab, including while herdr owns the keyboard, and `ctrl+a q` twice does the same.
`ctrl+a ctrl+a` sends a `ctrl+a` to the program in the herdr tab, where both agents use it for line start.
From a plain terminal, `oak attach [machine]` hands the terminal to herdr the way `tmux attach`
does (detach with `ctrl+b` then `q`), `oak agent start --kind claude|codex [--machine <label>]`
starts an agent in a herdr pane (on a remote it provisions herdr, copies OAK to `~/.local/lib/oak`,
puts `~/.local/bin` on the remote's PATH and installs the capture hooks there), and `oak machine add
<label> <ssh-target>` does that provisioning alone. Provisioned remotes are updated by re-running
`oak machine add`. Observatory joins live panes with unresolved captured edits and lists live sessions by
machine and herdr workspace; pin a session to read its prompts, replies, reasoning, tools, and diffs. A click
on a session, or Enter, pins its conversation; cursor movement previews its header. Press `i` in that detail to draft a
reply; Enter submits it to the live pane. Resolved
inactive sessions are archived rather than deleted; Shift+A includes them again. Review follows a
session to the machine that runs it (its herdr pane's, or the saved machine whose session list
includes it): the review is read there, and every decision runs there over SSH with that machine's
own `oak`, so nothing is copied between machines. Review's session picker lists every saved
machine's sessions after this machine's, and the session under the Observatory's cursor, previewed or
pinned, is the one Review shows. Started outside any repo with no `--session` or `--root`, Review opens
on the session that most recently took a turn on any machine, this one or a saved one. Scripts use
`--machine <label>` on the review and conversation verbs ([docs/REMOTE.md](docs/REMOTE.md)).
Observatory reads a remote conversation, its metadata and edit previews on the owning machine,
with throttled refreshes and visible connection errors. Local sync mirrors never supply those reads.
`oak sessions --json --machine build-box` reads one saved machine's captured sessions.
`oak sessions --json` lists this machine's sessions in workspace order, leaving out sessions in which
nothing happened (no edit, no tokens, no reply from the model) unless they may still be running.

```sh
oak agent start --kind codex --cwd /path/to/project
oak machine add build-box user@host
oak machine list --json
oak conversation --session <id> --json
oak comment compose --session <id>          # draft only
oak comment send --session <id>             # explicit submission
oak quote --session <id>                    # draft a quoted reply
oak quote --session <id> --text "Please explain this" --send
```

Both editors retain Review, Overview, and the **Feed**, which reads the conversation. Their new-session action
starts an agent through herdr. Chat about an edit, review comments, and quote actions prepare a draft
and ask for an explicit send. If its session has no live pane, the clipboard draft remains available.
Comments are marked sent only after an acknowledged submission.
The herdr jump (`↗ herdr`, `h`) and live machine → workspace → pane → session tree are TUI-only.
Editors read transcripts and submit replies through herdr via `oak prompt`; herdr's **Open in OAK**
action requires an attached `oak` terminal.

`oak server` is a small **local focus endpoint** for `oak focus --session <id> --tab observatory|review`.
It does not own terminals. The `remotes` command and its SSH session scanner have been retired: machines
are saved in herdr (`oak machine add`), and OAK reads a saved machine by running that machine's own `oak`
over SSH (`--machine`, and the Observatory's automatic reads listed under Notes). Usage is measured
on each machine for itself. See [remote development](docs/REMOTE.md).

## Packages

One data layer, one backend, three front ends:

- `packages/core` — capture + store + surgical undo + transcript observations + shared installer (pure TS;
  runtime dependencies are `diff` and `smol-toml`). No model calls, and
  no rendering.
- `packages/cli` — the `oak` bin: installer, every verb, and the machine-readable
  `--json` surface **all three front ends read**. Bundles the [claude-statusline](https://github.com/cell-observatory/claude-statusline) installer.
- `packages/herdr-plugin` — OAK's herdr plugin: the **Open in OAK** action and the startup hook that
  restarts the `btop` monitor (see its [README](packages/herdr-plugin/README.md)).

…and the three front ends over it:

- `packages/tui` — the terminal app: the frame, layout, glyph sets, key decoder and options screen,
  plus the runtime the bare `oak` command opens.
- `packages/vscode` — the VS Code extension (bundled with esbuild).
- `packages/jetbrains` — the PyCharm/JetBrains plugin (Kotlin — see its
  [README](packages/jetbrains/README.md)).

## Contributing

New features **ship in every front end** — TUI, VS Code, and JetBrains — with shared logic in core/CLI.
Start here:

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — the practical "add a feature across all platforms" guide, with
  the file-by-file steps, the build/test cheat-sheet, and the cross-platform parity checklist.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how the pieces fit: core → CLI `--json` → both editors.
- **Have an idea?** Open a [feature request](https://github.com/cell-observatory/oak-observatory/issues/new?template=feature_request.yml).

```bash
npm test          # version, privacy and webview checks, the build, then the core, CLI, TUI and VS Code suites
npm run e2e       # end-to-end CLI + capture-hook integration harness
npm run release   # build shareable artifacts into ./release (CLI .tgz + .vsix + JetBrains .zip)
```

To cut a release: `git tag v0.5.0 && git push origin v0.5.0` — CI re-runs the suites (npm + e2e + Gradle)
and attaches the CLI `.tgz`, the VS Code `.vsix`, and the JetBrains `.zip` to a
[GitHub Release](https://github.com/cell-observatory/oak-observatory/releases). See
[docs/DEMO.md](docs/DEMO.md) for a feature-by-feature walkthrough, or the
**[visual showcase](https://cell-observatory.github.io/oak-observatory/showcase.html)**.
Adjacent work that informed the design is credited in the
[showcase's credits section](https://cell-observatory.github.io/oak-observatory/showcase.html#credits).

## Notes

- Text files over 5 MB and binary files over 25 MB are skipped (a binary file is stored as an opaque blob and shown as a size summary). **Bash-driven file changes are tracked too** — a Bash command
  snapshots the candidate tree under its cwd before/after and records one edit per changed file (bounded:
  skips vendor/build dirs, caps the file count). Opt out with `CLAUDE_OBSERVATORY_NO_BASH=1`.
- New-file creates are captured (undo deletes the file). No-op edits are not logged.
- **Multi-agent is git-free and path-only.** Agents running in separate git **worktrees** of one repo are
  unified into a single fleet by reading the `.git` pointer files (never shelling out to the git binary);
  the cross-agent views (the Overview's Workers tab, siblings, task log) are **path-only** — filenames, never contents — so
  nothing leaks between agents. Attribution stays **honest**: an edit belongs to a task only when it was
  captured while that task was in progress, and an edit outside every in-progress window stays unassigned
  rather than being swept into a neighboring task. `task-keep`, `task-undo`, and `task-clear` act on that
  strict span and on nothing else.
- Capture and observability cost **zero extra Claude tokens**, with no telemetry or model calls
  of OAK's own. Local views read transcripts and the local store. **Saved herdr machines (automatic)**:
  the terminal Observatory requests per-machine snapshots over herdr’s SSH tunnel, and over SSH reads
  each machine's session list and, for a session running there, its conversation, edit previews and
  workers, using that machine's own `oak`. Over the same SSH path it has that `oak` rename a session's
  herdr tab when the session's title changes (`oak __tab-sync`, which records the name on that
  machine), and over herdr's tunnel it keeps each machine's `btop` tab and renames the tabs that
  machine's OAK cannot name. Editor session listings read only the machine where the
  workspace runs. Transcripts and edit stores remain on their source machine. **Account usage
  (automatic)**: the Usage bars read your account's usage from `api.anthropic.com` with Claude Code's
  stored login, refreshing that login when it has expired. **Remote Control titles
  (automatic)**: at most every five minutes OAK reads your account's session list from
  `api.anthropic.com` with Claude Code's stored login, so sessions carry the names the Claude app
  shows; `oak titles --off` turns it off. **Codex quota (automatic)**: with the same refresh, a
  local `codex app-server` reads your Codex rate limits with Codex's own login. **Update checks
  (automatic)**: the CLI (in an interactive terminal) reads the release list from `api.github.com`
  at most once a day, and VS Code's update notifier (not for an install a marketplace updates, on the
  stable channel) once a day after a read that succeeds, retrying a failed one when the next window opens.
  Both editors' version chips read it up to once an hour while the Overview is open (after a failed
  read, VS Code reads again the next time the Overview or the chip's menu opens, and JetBrains every
  five minutes until a read succeeds); `CLAUDE_OBSERVATORY_NO_UPDATE_CHECK=1` turns off the CLI's.
  `oak models use <name>` has ollama pull a model it does not have yet. Deep analysis runs the local
  `claude` CLI only when requested. All network paths are listed in [SECURITY.md](SECURITY.md).
