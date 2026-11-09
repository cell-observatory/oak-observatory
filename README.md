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
[![Version](https://img.shields.io/badge/version-v0.12.0--dev.0-blue)](https://github.com/cell-observatory/oak-observatory/releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/cell-observatory/oak-observatory/blob/main/LICENSE)

**[🔬 Live showcase →](https://cell-observatory.github.io/oak-observatory/)** &nbsp;·&nbsp; **[Interactive demo →](https://cell-observatory.github.io/oak-observatory/showcase.html#demo)** &nbsp;·&nbsp; [Changelog](CHANGELOG.md)

**OAK is an observatory for coding agents.** It follows every session that
[Claude Code](https://claude.com/claude-code) and [Codex](https://github.com/openai/codex) run, on this
machine and on the other machines you save with `oak machine add`, and turns each file change they make into a reviewable
entry with its own surgical undo. You review in the **terminal app**, in **VS Code**, or in **JetBrains
IDEs**; all three read and act on the same record. Capture runs in local hooks and reads the transcripts
the agents already write, so it costs **zero extra model tokens** and never changes what the agent sees.

OAK is built for **established and mission-critical codebases**, where a change accepted without being
understood is a liability, rather than for throwaway prototypes. The review model resembles Cursor's
per-change keep/undo, but it is standalone, shareable, and git-free.

<a id="the-observatory"></a>

![The observatory in VS Code: the Observatory Traces sidebar (Review · File History), the editor with the inline lens and the compact review bar, the Observatory Dashboards bottom panel (Overview · Stats), the Observatory Timeline panel (Feed · Prompts · Observations · Actions) with its session selector and Group tabs toggle, and the microscope scoreboard in the status bar](docs/media/layout.png)

Run several agents from briefs with `oak agent start --brief <file>`, here or with `--machine <saved-label>`.
`oak agent list` tracks those agents and their workers, and `oak agent wait` waits for completion or a blocked turn.
Review each agent's changes in the terminal app, VS Code or JetBrains, including sessions on saved machines. Merge
its branch with git, then use `oak agent close` to close its native CLI tab. The
[three-machine walkthrough](https://cell-observatory.github.io/oak-observatory/agents-across-machines.html)
shows the commands, worker logs, review and closure from a synthetic run.

## What you get

Agents can change dozens of files in one turn. On a codebase that matters, a large diff skimmed at the
end is not review. OAK keeps you **in the loop on every edit**, deciding one change at a time.

- **Surgical review of agent edits** — keep, undo, or diff each change individually; undo one edit
  while keeping later edits to the same file.
- **One change, however many tries** — repeated edits to the same lines or the same function collapse
  into one review unit showing the net diff, bounded by the prompt that produced them; a superseded
  intermediate state never asks for a decision. A file deleted and re-created is one decision, not two contradictory rows, and a
  chain that ends where it started (a file created then deleted, an edit put back) is nothing to
  review: those are named in one footer with a Dismiss rather than listed. Every count means the same
  thing by "pending", from the review list to the change map to the status bar.
- **Every session, on every machine** — the terminal app's Observatory lists live Claude Code and Codex
  sessions by machine and herdr workspace, with each session's prompts, replies, reasoning, tool calls
  and diffs. The terminal app and both editors follow a saved machine’s session and make each
  review decision there, so reviewing copies nothing between machines.
- **Know when an agent needs you** — the hooks record what every session is waiting on (a permission
  prompt and its tool, a question, your input), so a raised hand reaches you as a desktop notification,
  a **needs you** list in every surface (terminal `i`, the editors' session selector
  and Sessions tab), and a one-key jump to the most urgent one (terminal `h`, VS Code's status-bar
  `⚠` chip, or ⌥⌘X then `h` in either editor, Ctrl+Alt+X then `h` on Windows and Linux). On the
  Observatory tab, `c` replies and `t` focuses herdr. A notification does not answer the waiting prompt; it
  says who is waiting. On macOS, when OAK runs in iTerm2, Ghostty, WezTerm or kitty, the
  terminal posts the notification under its own name, and clicking it brings the terminal forward.
- **Any surface** — the CLI, the terminal app, the VS Code extension and the JetBrains plugin read and
  write the same store, so terminal and editor stay in sync, including over Remote-SSH and in
  devcontainers where the agent runs on another host.
- **Usage at a glance** — the Usage bars show your Claude plan's 5-hour and weekly usage and your Codex rate
  limits, read on each machine for itself; where this machine has no current reading of your Claude
  account's shares, they show a saved machine's reading of the same account (with no Claude Code login
  here, of the one account the saved machines name) and name that machine. The token and dollar
  estimates count each message of the account once, across this machine and every machine whose usage
  the local database holds (brought by `oak sync`, or read from each saved machine over SSH every five
  minutes), so machines of one account show the same budgets and month. An account with no five-hour
  limit, whose usage answer carries no 5-hour window (as a verified Ultra plan's does), shows no 5-hour
  readout. Terminal and editor status bars show weekly and monthly usage, with the month's dollars after the `mo`
  reset (`~` for an estimate, no tilde for an actual charge). Stats, `oak usage` and the Claude Code status line
  retain the five-hour window when the account has that limit; status bars omit it.
- **Shareable and auditable** — a git-free, content-addressed log of what the agent did and what you
  decided, which you own and can hand to a teammate.

OAK complements Claude Code's `/rewind`, which works a whole turn at a time, with **per-edit** control.

## Quickstart

**1 — Install** the CLI, the terminal app and the editor extensions from the latest
[release](https://github.com/cell-observatory/oak-observatory/releases) (requires Node.js 24 or newer, and
`python3` on Linux and macOS; on Linux, also `make` and a C++ compiler for node-pty, the
terminal app's herdr tab, with `oak attach` as the route that needs no PTY; see **Platforms** below):

```bash
# macOS / Linux (and Windows via Git Bash)
curl -fsSL https://raw.githubusercontent.com/cell-observatory/oak-observatory/main/scripts/bootstrap.sh | bash
```

```powershell
# Windows — native, no bash needed
irm https://raw.githubusercontent.com/cell-observatory/oak-observatory/main/install.ps1 | iex
```

Both install the CLI and the extensions for whatever editors are on the machine — VS Code family
and/or JetBrains — and then the pinned herdr backend the terminal app runs on. For the rolling
[pre-release channel](#keeping-up-to-date) — the choice is remembered, so later updates follow it — a
piped script needs its arguments passed through:

```bash
curl -fsSL https://raw.githubusercontent.com/cell-observatory/oak-observatory/main/scripts/bootstrap.sh | bash -s -- --channel dev
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/cell-observatory/oak-observatory/main/install.ps1))) -Channel dev
```

**2 — Wire the capture hooks** — with Claude Code **closed** (it snapshots hooks at session start):

```bash
oak init          # Claude Code, and Codex too when codex is on the PATH; add --with-statusline for the 5h/week Usage bars
oak init --codex  # Codex alone
```

When Codex has no model configured and local models are available, `oak init` also sets Codex to the
newest local model, with a backup of its config; a model you chose is never changed, and
`oak models use <name>` switches it.

**3 — Start working.** Run `oak` to open the terminal app, and start Claude Code or Codex in its herdr
tab (or with `oak agent start --kind claude|codex`); agents you launch the usual way are captured too.
Every edit is recorded automatically. Review it in the terminal app's **Review** tab, in the
**🔬 Observatory Traces** view in your editor, or with `oak list`.

**Try it without an agent** — the same scenario is clickable in the browser on the
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

## The terminal app

`oak` (or `oak tui`) opens the terminal app, which has three tabs: **herdr · Observatory · Review**.

- **herdr** runs the real herdr client, the terminal backend that owns OAK's terminals, agents and
  remote machines. A session starts there, in herdr's own tab bar and sidebar on the selected machine,
  rather than from an OAK control.
- **Observatory** joins live panes with unresolved captured edits and lists live sessions by machine
  and herdr workspace. Under a session whose workers are still at it, a row counts them by state and
  opens into their own rows, those waiting on a person first. A click on a session, or Enter, pins its
  conversation (prompts, replies, reasoning, tools, and diffs); cursor movement previews its header.
  Press `c` in that detail to draft a reply; Enter submits it to the live pane. `R` resolves a session
  and `X` stops its agent, each after asking (the `⚑ resolve` and `■ stop` buttons do the same).
  Resolved inactive sessions are archived rather than deleted; `B` includes them again.
- **Review** shows the session's change map, prompts and edits, grouped by file with pending ones
  marked; `a`/`u` keep and undo the selection, `U` redoes it, and `A`/`D` keep or undo everything
  listed. It follows a session to the machine that runs it
  (its herdr pane's, or the saved machine whose session list includes it): the review is read there,
  and every decision runs there over SSH with that machine's own `oak`, so reviewing copies nothing between
  machines. Review's session picker lists every saved machine's sessions after this machine's, and its
  search box matches session names and what was said in each, on every machine. The session under the
  Observatory's cursor, previewed or pinned, is the one Review shows. Started outside
  any repo with no `--session` or `--root`, Review opens on the session that most recently took a turn
  on any machine, this one or a saved one.

**Keys.** OAK's outer bar has three fixed tabs, each on its key: `F1` herdr, `F2` Observatory and `F3` Review,
from any tab, over any overlay (which closes first, with any text typed in it) and on the herdr tab before herdr
or the program sees them, unless herdr's config binds the key. On the Observatory and Review tabs `Tab` and
`shift+Tab` switch them too (so do `ctrl+n`/`ctrl+p` and `alt+1`–`alt+3`), and `F4` onward focus their panes. On the
herdr tab every other key, `ctrl+a` included, is the program's or herdr's: OAK listens on herdr's own prefix
(`ctrl+b` unless herdr's config sets another, or each of the prefixes it lists), and after it takes only `m`, back
to OAK's tabs, `M`, which pins herdr's focused session in the Observatory, and `V`, which opens Review on that
session, while herdr leaves them unbound (herdr binds `R` itself, to reload its config). Inside a herdr pane, as
`oak attach` runs it, there is no herdr tab: herdr is the host and keeps its prefix. `ctrl+q` twice quits from any
tab, or from OAK's own tabs when herdr's prefix is `ctrl+q`; pressed once on the herdr tab, it reaches the program
after the two seconds OAK waits for the second, or before the next key you press there. `:` opens the palette (every
command, and find anything); `?` lists every key from your own keymap.

**herdr.** OAK uses **herdr** as its required terminal backend. **Install oak, get herdr**: the
installers install the version pinned in `herdr.lock` (currently 0.9.1), verify its checksum, install
the Claude and Codex integrations, and link OAK’s herdr plugin. A newer installed herdr is preserved.
Run `oak doctor --fix` to repair the backend, native terminal helper permissions, or an outdated OAK
focus server. `oak doctor` also checks forwarding latency for saved machines, says why a saved machine
gave no Claude usage reading, and (on Linux and macOS) reports a herdr server that was started from
inside a Claude Code session: its panes would then run Claude Code agents as child sessions with
transcript saving off. Stop it from a plain terminal with
`herdr server stop`, then `oak doctor --fix`. The installers, `oak update` and `oak doctor --fix` also
widen herdr's sidebar on the machine they run on (`ui.sidebar_min_width` 48 / `ui.sidebar_max_width` 72
in herdr's `config.toml`, only when no width was set by hand) so the session titles OAK gives herdr's
tabs are not clipped, and set `theme.name = "gruvbox"` when no theme name is set; herdr's divider drags
between those two widths, and existing theme choices stay.

OAK names herdr's tabs after the sessions their panes run and renames them when a session's title
changes, never a tab you named yourself: each session's capture hooks and its status line rename its
own tab, and `oak tui` renames the tabs of this machine and of every saved machine while it runs. On
Linux and macOS, `oak tui` also keeps a `btop` tab running a system monitor (btop, bpytop or htop) in
the `home` workspace of this machine and of every saved machine. The tab is made again
whenever it is missing, and OAK types the monitor's command only into the monitor's own pane
(labelled `btop`) while its shell is idle at the prompt. That pane comes back as a plain shell when
herdr's server restarts, so OAK's herdr plugin starts the monitor again as the server starts, wherever
the installers, `oak update` or `oak doctor --fix` linked it ([herdr tab](https://cell-observatory.github.io/oak-observatory/tui-herdr.html#tab-names-and-the-btop-tab)).

**Other machines.** From a plain terminal, `oak attach [machine]` hands the terminal to herdr the way
`tmux attach` does (detach with `ctrl+b` then `q`), `oak agent start --kind claude|codex [--machine <label>]`
starts an agent in a herdr pane (on a remote it provisions herdr, copies OAK to `~/.local/lib/oak`,
puts `~/.local/bin` on the remote's PATH and installs the capture hooks there), and `oak machine add
<label> <ssh-target>` does that provisioning alone. An `oak` already on the remote's PATH that it did not
put there is left as it is. Where it copied OAK, `oak update` leaves the copied CLI alone, and re-running
`oak machine add` updates it. Scripts use `--machine <label>` on the
review and conversation verbs
([docs/REMOTE.md](docs/REMOTE.md)). Observatory reads a remote conversation, its metadata and edit
previews on the owning machine, with throttled refreshes and visible connection errors. Local sync
mirrors never supply those reads. `oak sessions --json --machine build-box` reads one saved machine's
captured sessions: from the local database, saying how fresh they are, when `oak sync` read that machine in the
last ten minutes and nothing there may be running (no session active in the last two hours, as its records and the
files that run saw say, no hand raised in the last day still up), and over SSH otherwise; `--synced` adds every other
machine's sessions the local database holds, by machine (`machines`). `oak sessions --json` lists this machine's sessions
in workspace order, leaving out sessions in which nothing happened (no edit, no tokens, no reply from the model) unless
they may still be running, and Codex's Auto-review threads unless `--all` is given or `--session` names one.

**Set up your agent to delegate.** Run `oak agent setup` to preview the managed guidance and choose model, effort,
and Codex build-cache defaults. Confirm the listed writes, or use `--yes`; `--check --json` reports installed and
outdated content. `--project` uses this repository's files. `--remove` removes OAK's content. Setup installs the
`oak-delegate` Claude skill, an `oak-builder` agent without nested delegation, a Codex instructions block, and the
Claude permission rule `Bash(oak agent:*)`. Existing choices and user-edited blocks remain intact. `oak update`
refreshes installed guidance; `oak uninstall` removes it. Run these commands from each repository with project setup.

Parents start agents of their own kind unless the brief or a flag specifies another kind. The guidance requires a
brief, uncommitted changes, a report with before/after test evidence, and a binary diff. Before work and shared-file
edits, agents check related files, conversations, agents and findings in the database, then coordinate on any edit-time note.

Add `--worktree [<base>]` to create a worktree beside a clean repository, from `HEAD` by default. OAK records its
path, branch, base and bounded Git readings, and shows files, added/removed lines and merge state in agent lists and
Workers on every surface. `--writable-root <dir>` is repeatable; Codex always receives its output folder. The parent
reviews and merges the diff, then uses `oak agent close --remove-worktree <id>` once the worktree is clean and merged.
`oak doctor` lists orphaned agent worktrees (ones OAK made, on an `oak/<id>` branch) without removing them.

**Agents from a brief.** `oak agent start --kind claude|codex --brief <file> [--machine <label>]` starts an agent in
its own herdr tab, labelled from the brief's `# Title`, here or on a saved machine, and hands it the brief.
`oak agent list` tracks every such agent with a state OAK derives itself (starting, working, waiting, blocked,
errored, done, gone) and when it began; `oak agent wait <id…> --until done|blocked|any` returns once that is reached,
and `oak agent close <id…>` closes the tabs and keeps the rows
([the workflow](https://cell-observatory.github.io/oak-observatory/agents-across-machines.html#start-the-agents)).

```sh
oak agent start --kind codex --cwd /path/to/project
oak agent start --kind claude --agent builder --brief fix-login-brief.md --cwd /path/to/tree
oak agent wait fix-login --until any
oak machine add build-box user@host
oak machine list --json
oak conversation --session <id> --json
oak comment compose --session <id>          # draft only
oak comment send --session <id>             # explicit submission
oak quote --session <id>                    # draft a quoted reply
oak quote --session <id> --text "Please explain this" --send
```

`oak server` is a small **local focus endpoint** for `oak focus --session <id> --tab observatory|review`.
It does not own terminals. The `remotes` command and its SSH session scanner have been retired: machines
are saved in herdr (`oak machine add`), and OAK reads a saved machine by running that machine's own `oak`
over SSH (`--machine`, and the Observatory's automatic reads listed under Notes). Usage is measured
on each machine for itself; where this machine has no current reading of the Claude account's 5-hour or
weekly share, the readouts show a saved machine's reading of the same account (with no Claude Code login
here, of the one account the saved machines name) and name it, and the token and dollar estimates count
each message of the account once across the machines whose usage the local database holds. See
[remote development](docs/REMOTE.md).

## In the editors

Both editors retain Review, Overview, and the **Feed**, which reads the
conversation. The editors' **Review** tab lists the session's pending changes — scoped to one ask when
a prompt is selected — and opens them in the editor: one unit's net diff per row, or everything listed
concatenated into a single view with per-diff Keep/Undo; in the terminal, opening a prompt scopes the
Review list the same way. The editors' new-session action starts an agent through herdr. Chat about an edit, review
comments, and quote actions prepare a draft and ask for an explicit send. If its session has no live
pane, the clipboard draft remains available. Comments are marked sent only after an acknowledged
submission. The herdr jump (`↗ herdr`, `t`) and live machine → workspace → pane → session tree are
TUI-only. Editors read transcripts and submit replies through herdr via `oak prompt`; herdr's **Open in
OAK** action requires an attached `oak` terminal. Overview → Sessions in VS Code and JetBrains lists
sessions on the workspace's machine, grouped by project with this workspace first; each row shows its
title, tokens, duration, model and edit count, and remote editor windows list sessions on their remote
host.

## The local database and `oak sync`

Each machine keeps a local database of its sessions: one SQLite file in `~/.claude/claude-observatory-index/`, beside the
store's configuration and never inside the store. It holds each session, every prompt and the answer to it, edit metadata
(never file contents), tool calls, workers, raised hands, review comments, plans, memories and skills, and the usage of
every message. OAK builds it from this machine's files with the SQLite built into Node.js and catches it up as each
command reads, and, once `oak sync` has run there, in the background as the capture hooks record, at most once a
minute and at once when a hook raised, changed or lowered a hand; the hooks never open it themselves. `oak sessions`,
`oak search`, `oak inbox` and `oak notify --watch` answer from it when it is caught up, with the same answers as from
the files, and `OAK_INDEX=off` makes OAK read the files instead. The other machines' raised hands, which only the database
holds, are read from it as it stands, caught up or not: `oak inbox` lists them and `oak notify --watch` announces them.
The database also keeps what a session did after its files are gone, as its archive. Only a deliberate delete forgets a
session: `oak sessions --delete`, and `oak demo --clean` and `oak uninstall --purge-store` for the sessions they remove.
It grows with the text of the prompts and answers, not with tool output: on a
synthetic machine whose 398 MB of transcripts held 38 MB of prompts and answers, the database took 123 MB.

`oak query` answers from it in JSON, for agents and scripts:

```bash
oak query sessions --since 7d                 # every machine's sessions the database holds, newest first
oak query search --text "flaky login test"    # prompts and answers, ranked (bm25; a prompt outranks its answer)
oak query edits --status pending              # pending edits, with their line counts
oak query sessions --archived                 # include sessions whose files are gone, marked with when and why
oak query sql "SELECT workspace, count(*) AS n FROM sessions GROUP BY workspace"   # one read-only SELECT
oak query schema                              # the tables and the named queries
oak usage --window week --by machine          # this week's tokens per machine, each message once
oak query usage --window bill --by model      # the bill cycle by model, as JSON
oak query readings --kind five                # each machine's 5-hour shares, newest first
```

`oak sync now` shares the agents' state with the machines in `oak machine list`. It pulls over SSH, and no machine
writes another's files. Claude Code's auto memory, plans, skills, agents and commands are kept on every machine and
merged three ways; changes to the same lines keep both copies, as a sync conflict for you to resolve. Each session's transcript or rollout and its OAK
snapshots stay on the machine that made it and on one backup, and any other machine fetches one with
`oak sync fetch <session>`. Each machine's record log, what its local database derives of its own sessions, is kept on
every machine. Every machine's database therefore lists and searches every machine's sessions and counts their usage,
each message once, and `oak inbox` lists the sessions waiting on you on every machine. The backup is a saved machine or a folder every machine reaches, such as a network share. Into a
backup folder, each machine writes its own files encrypted with a key the folder never holds (`oak sync setup`). The terminal app,
VS Code and JetBrains show its runs and its conflicts, and run it and set it up through the CLI. Every machine you sync with is
trusted with the skills, agents, commands, memories and plans your agents follow. The record log carries your prompts,
the answers to them and each tool call's target to each of those machines ([SECURITY.md](SECURITY.md#good-to-know)).

[The database across machines](https://cell-observatory.github.io/oak-observatory/database-across-machines.html) explains
the local databases, record logs and encrypted backup on shared storage.
[Database & sync](https://cell-observatory.github.io/oak-observatory/database-and-sync.html) provides commands, settings,
tables and worked examples. [docs/REMOTE.md](docs/REMOTE.md#sync-across-machines-oak-sync) is the reference for every sync command
and its JSON, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#the-local-database) for the database's schema and contracts.

Every agent can run `oak query` in its own shell. It sees what the agents on every machine you sync with were asked,
what they answered and which files they edited, as of the last sync.
[Multi-agent work across machines](https://cell-observatory.github.io/oak-observatory/agents-across-machines.html)
follows agents on three machines from starting them in herdr to reviewing their work. It states what an agent can and
cannot do, and gives a block to paste into `CLAUDE.md` or `AGENTS.md`.

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

`oak update` refreshes **everything OAK installed**, on this machine and then on each saved machine,
from the release channel you follow. On this machine that is the CLI; the extension in every VS Code,
VS Code Insiders, Cursor, VSCodium and Windsurf that has it, including their Remote-SSH servers
(`~/.vscode-server`, `~/.cursor-server`); the plugin in every JetBrains IDE that has it; the Claude
Code capture hooks in your user settings and the Codex capture hooks (an update that adds a hook event
repairs them, as `oak init --repair` does, and a Codex hook you turned off in Codex stays off); the
bundled status line, when it is OAK's; herdr at its pinned version with its integrations and OAK's
herdr plugin, as `oak doctor --fix` keeps them, where herdr publishes a build; and a focus server still
running an older build, which it stops. A project's own `.claude/settings.json` is shared through its
repository, so `oak update` never writes to it: one that needs a repair gets a row naming the
`oak init --repair` to run there. Each enabled saved machine (`oak machine list`) then runs its own
`oak update --here` over ssh, once for machines saved with the same ssh target, and downloads the
release itself; a machine without OAK, or with an OAK too old to have `--here`, gets a row that says
so. On a machine `oak machine add` provisioned, the CLI is the copy it pushed, which `oak update`
leaves alone: that machine's row names the `oak machine add` that updates it. `oak update` prints one
plan and one result table, leaves what is already current alone, and exits non-zero when anything it
found could not be updated. `--here` stops at this machine, `--check` prints the plan without
installing, and `--json` returns it as data.
It never replaces a status line that is not OAK's, and it leaves an extension a marketplace installed
to that marketplace on the stable channel. It also leaves alone a CLI linked to a source checkout
(`npm link`, `npm i -g ./packages/cli` or `./install.sh`), on this machine and on a saved machine:
installing a release over the link would replace it with a copy, which `oak` and the capture hooks
would then run instead of your builds. Its row names the checkout; update it there with `git pull`
and `npm run build`. It leaves alone a local build as well: a CLI, extension or plugin whose version
ends in `-dev.0`, which every build of a `dev` checkout carries and no release does; `--force` or
`--channel` replaces it with that channel's newest. Re-running the [one-liner](#quickstart) updates
this machine the same way. The CLI also nudges you once a day when your installed build differs from
the channel's newest, unless it runs from a checkout, is a local build, or is a copy `oak machine add`
pushed (opt out with `CLAUDE_OBSERVATORY_NO_UPDATE_CHECK=1`).

**Following a channel means matching it.** A surface is refreshed whenever its version *differs*
from the channel's newest — not only when the release is higher. That is what makes switching
channels work in both directions, and it is what rescues a build that sits *above* the channel, such
as a pre-release left installed after switching to stable: it reports `not on this channel` and is
pulled back onto it. (Before 0.9.5 such an install reported "up to date" on every channel, forever.)
A local build is the exception above: every surface calls it a `local build` and offers it nothing,
as it does a CLI linked to a checkout.

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
  shows your installed version next to the latest release at any time, or says that the CLI is
  linked to a checkout, copied by `oak machine add`, or a local build, which no release updates.
- **VS Code** — a background check (once a day) offers a one-click **Update now**, except to a local
  build; or run **“OAK: Check for updates”** from the Command Palette. Downloads are sha256-verified.
  The extension installs its own `.vsix` through the editor, so updating and switching channels need
  nothing on your `PATH` — no `code` shell command, and no CLI. The CLI is used to refresh
  everything else `oak update` covers, saved machines included, and if it is absent the extension
  says so and updates anyway.
- **JetBrains** — add the self-hosted plugin repository **once** and the IDE auto-updates the plugin
  like any Marketplace plugin (see [the JetBrains guide](packages/jetbrains/README.md#auto-updates)):
  **Settings → Plugins → ⚙ → Manage Plugin Repositories → +**, then paste
  `https://github.com/cell-observatory/oak-observatory/releases/latest/download/updatePlugins.xml`
  (pre-release channel: the same path under `releases/download/dev-latest/` instead of
  `releases/latest/download/`). That update check is the IDE's own: it reads the repository, not OAK,
  so it can offer the repository's build over a local build of the plugin, which OAK cannot prevent
  for one install. Decline it there to keep the local build.

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
./install.sh --jetbrains     # also build + install the JetBrains plugin (needs a JDK 17 or newer)
```

OAK needs Node.js 24 or newer: its local database uses the SQLite built into Node, with full-text search.

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

Both ways of putting `oak` on PATH, and `./install.sh`, link it to this checkout, so each
`npm run build` is what `oak` and the capture hooks run. `oak update` leaves the link alone and
updates the rest; `git pull` and `npm run build` update the CLI. The extensions a `dev` checkout
builds are local builds (`-dev.0`), which `oak update` and both editors' update checks leave alone.
`oak doctor` warns when a login shell, which Codex runs its hooks through, finds another `oak` first.

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
cd packages/vscode && npm run package     # -> oak-observatory.vsix (needs Node.js 24 or newer)
code --install-extension oak-observatory.vsix
```

Fully quit VS Code (⌘Q) once after installing so the activity-bar icon refreshes. The extension then
keeps itself current — a daily background check offers a one-click **Update now** (see [Keeping up to
date](#keeping-up-to-date)).

**JetBrains / PyCharm plugin** (optional; building it needs a JDK 17 or newer to run the Gradle
wrapper, which downloads Gradle, and a JDK 21 when the machine has none — or grab the `.zip` from a
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

Both editors also review sessions on saved machines from a local window: task decisions run on the owning machine, conversation search labels each machine's hits, and keyboard edit/file navigation opens remote patches. Review's reply box sends directly to the selected session's agent and keeps refused drafts. See [remote editor behavior](docs/REMOTE.md).

The extension runs on the **remote host** (where the agent, the
transcripts, and the store live). Full setup — Remote-SSH, JetBrains Gateway/Toolbox, the devcontainer
template, and relocating `CLAUDE_CONFIG_DIR` — is in **[docs/REMOTE.md](docs/REMOTE.md)**.

## How it works

| Piece | What it does |
| --- | --- |
| **Capture hook** (`capture`) | PreToolUse snapshots the file before an edit, PostToolUse commits before + after, and PostToolUseFailure does the same for a tool that failed (a Bash command that exits non-zero). Zero-dep, always `exit 0`, never writes to the model context. Captures `Edit` / `Write` / `MultiEdit` / `NotebookEdit` — and files changed by `Bash` (set `CLAUDE_OBSERVATORY_NO_BASH=1` to opt out). The same command sits on six *attention* events — `Notification`, `PermissionRequest`, `Stop`, `UserPromptSubmit`, `SessionEnd`, `SubagentStop` — recording what each session is waiting on (a permission prompt and its tool, your input, a finished turn). It clears the wait when the agent moves on (an edit or Bash call starts, or the edit or Bash call a permission prompt was for returns), when a prompt answers it, or when the session ends; a permission prompt on any other tool (a web fetch, an MCP call) stays up until one of those, or until the turn ends. A subagent shares its parent's session, so a permission prompt keeps the agent that asked for each of its calls: a call's start lowers only the calls its own agent asked for, a prompt that names no call (one raised by `Notification` alone) is lowered by any call's start, and a subagent's prompts come down when it finishes (`SubagentStop`). It never answers a permission and never writes to stdout. Inside a herdr pane, `Stop` and `UserPromptSubmit` also start a detached `oak __tab-sync`, which renames the session's herdr tab after its title. |
| **Store** | `~/.claude/claude-observatory/<session_id>/` — `log.jsonl` (append-only) + content-addressed `blobs/`. No network. |
| **Session resolution** | The active session is the newest transcript **that holds a real conversation**. Local commands (`/effort`, `/model`), interrupted commands, and bridge records write command-only transcript stubs; those never displace the session under review (0.8.4). When the current session has no edits yet, the panels say so honestly and offer a one-click switch to the previous session's work. |
| **Undo engine** | Position-anchored 3-way line merge (base = the file right after the edit; sides = current on-disk content and the pre-edit content). Later edits to other lines survive; a genuine overlap → clear conflict + per-file restore. Anchoring on line positions (not fuzzy text search) keeps it safe against duplicated content. |
| **Observations** | Correlates each edit with the agent's real reasoning + to-dos parsed from the session transcript — zero token. |
| **Front-ends** | The CLI and the terminal app (in-process), the VS Code sidebar (in-process `core`), and the JetBrains plugin (over the CLI + store) — all on the same store + engine. |
| **Agent backend** | herdr owns terminals and agents; OAK captures edits with hooks and transcript parsing and renders the conversation from transcripts. |
| **codex hooks** *(0.10.0)* | `init --codex` installs the same capture for codex ≥0.147.0, whose hook system speaks Claude Code's payload dialect. Shell edits land with real before/after content; codex's rollout file supplies prompts, tokens (with the cache split), model + effort. Installation checks configuration without starting a model; `status` re-checks trust and `integrity --session <id>` reports capture gaps. Sessions retain native IDs and model tags. Current contract and validation limits: [Codex/GPT support](docs/CODEX-SUPPORT.md). |

Architecture deep-dive: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

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

Releases are cut from a `release/X.Y.Z` branch and published by tagging `main`; *Cutting a release* in
[CONTRIBUTING.md](CONTRIBUTING.md) has the steps. CI re-runs the suites (npm + e2e + Gradle) and
attaches the CLI `.tgz`, the VS Code `.vsix`, and the JetBrains `.zip` to a
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
  the cross-agent views (the Overview's Workers tab, siblings, task log) are **path-only**: they show filenames, never
  contents. Any agent can still read the others' prompts and answers with `oak query`. Attribution stays **honest**: an
  edit belongs to a task only when it was
  captured while that task was in progress, and an edit outside every in-progress window stays unassigned
  rather than being swept into a neighboring task. `task-keep`, `task-undo`, and `task-clear` act on that
  strict span and on nothing else.
- Capture and observability cost **zero extra model tokens**, with no telemetry or model calls
  of OAK's own. Local views read transcripts and the local store. **Saved herdr machines (automatic)**:
  the terminal Observatory requests per-machine snapshots over herdr’s SSH tunnel, and over SSH reads
  each machine's session list (from the local database instead while `oak sync` keeps that machine's records
  current here and nothing there may be running) and, for a session running there, its conversation, edit
  previews and workers, using that machine's own `oak`. Over the same SSH path it has that `oak` rename a session's
  herdr tab when the session's title changes (`oak __tab-sync`, which records the name on that
  machine), and over herdr's tunnel it keeps each machine's `btop` tab and renames the tabs that
  machine's OAK cannot name. VS Code and JetBrains read each saved machine's session list
  over the same SSH path, and reviewing one of those sessions runs that machine's `oak` there. Both editors share
  these background reads across their session selectors and worker lists, and also list other machines' synced records from the local database. Edit stores and transcripts
  remain on their source machine unless `oak sync` copies
  them. **oak sync (once you run it)**: `oak sync now` pulls over SSH, from the saved machines, the memory,
  plans, skills, agents, commands, sessions, OAK edit logs and record logs this machine keeps, and with a backup folder set
  it writes this machine's own files there, encrypted with a key the folder never holds; the capture hooks and
  pollers repeat it at most every five minutes, and `"sync": { "auto": false }` in OAK's `prefs.json` stops the
  repeats. **Account usage
  (automatic)**: the Usage bars read your account's usage from `api.anthropic.com` with Claude Code's
  stored login, refreshing that login when it has expired. **Account usage from saved machines
  (automatic)**: at most every five minutes OAK runs `oak __usage-records --json` on each enabled saved
  machine over SSH (`oak __usage-brief --json` on one running an older OAK), so that a machine with no
  current reading of the Claude account's shares can show another's, and each machine's estimates count
  the usage of every machine once. It reads that machine's usage rows and readings since the last read,
  never its conversations, and skips a machine whose record log `oak sync` keeps current here;
  `"machineUsage": false` in OAK's `prefs.json` turns it off. **Remote Control titles
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
