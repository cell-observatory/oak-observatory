# Changelog

All notable changes to OAK are recorded here, following
[Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).
Each tagged release's artifacts are on the
[Releases page](https://github.com/cell-observatory/oak-observatory/releases), with its section below as
the release notes.

## [Unreleased]

**claude-observatory is now OAK.** The command is `oak`, the npm package is `oak-observatory`, the
VS Code extension is `cell-observatory.oak-observatory-vscode`, the JetBrains plugin is
`com.cell-observatory.oak-observatory`, and the repository is
[cell-observatory/oak-observatory](https://github.com/cell-observatory/oak-observatory). The terminal
app now runs on [herdr](https://github.com/herdrdev/herdr), which OAK installs and manages.

### Upgrading from claude-observatory

- **Reinstall once with the installer.** claude-observatory 0.9.5 and earlier, and the 0.10.0
  pre-releases published under that name, cannot update themselves across the rename:
  `claude-observatory update` stops with an npm `EEXIST` error (the old packages keep working), the
  old VS Code extension's update notifier does not see this release, and JetBrains custom-repository
  users are offered a new plugin id rather than an update. Run the installer, which removes the old
  npm package first:
  `curl -fsSL https://raw.githubusercontent.com/cell-observatory/oak-observatory/main/scripts/bootstrap.sh | bash`
  (Windows: `irm https://raw.githubusercontent.com/cell-observatory/oak-observatory/main/install.ps1 | iex`).
  If you install by hand, first download this release's CLI tarball, so a failed download leaves the
  old CLI in place (npm 12 will not install the tarball from its URL):
  `curl -fLO https://github.com/cell-observatory/oak-observatory/releases/download/v0.10.0/oak-observatory-0.10.0.tgz`
  (in Windows PowerShell 5.1, type `curl.exe`: `curl` there is an alias of `Invoke-WebRequest`).
  Then run `npm uninstall -g claude-observatory`, install the downloaded file with
  `npm install -g --allow-scripts=node-pty ./oak-observatory-0.10.0.tgz`, and run `oak doctor --fix`
  and `oak install-extensions`, which installs the renamed VS Code extension and JetBrains plugin.
- **The new extension and plugin retire the old ones.** VS Code uninstalls
  `cell-observatory.claude-observatory-vscode`; the JetBrains plugin disables
  `com.cell-observatory.claude-observatory` and offers a restart. JetBrains users who subscribed to
  the custom plugin repository should replace its URL with
  `https://github.com/cell-observatory/oak-observatory/releases/latest/download/updatePlugins.xml`.
- **Requirements:** Node.js 20 or newer (was 18). Linux and macOS also need `python3`, for herdr's
  agent hooks and OAK's herdr plugin. Linux needs `make` and a C++ compiler as well (`g++`, or
  whatever `$CXX` names): npm compiles node-pty, which the terminal app's herdr tab runs herdr in,
  and npm 12 runs that build only when it is allowed (`--allow-scripts=node-pty`). Without node-pty
  the herdr tab cannot start; `oak attach` works without it.
  The installers, `oak update` and `oak doctor --fix` install the herdr version pinned in `herdr.lock`
  (0.9.1, checksum-verified) when a machine has none or an older one; a newer herdr is left in place.
- **Run `oak init` with Claude Code closed**, even if you ran `init` on a pre-release. It rewrites
  the capture hooks to the new command and hooks six events beside `PreToolUse` and `PostToolUse`:
  `PostToolUseFailure`, `Notification`, `Stop`, `PermissionRequest`, `UserPromptSubmit` and
  `SessionEnd`. Until `PostToolUseFailure` is hooked, the file changes of a Bash command that fails
  are not recorded. `oak doctor` names the events that are not hooked, and `oak status` shows the
  hook count with the command to run. When `codex` is on the PATH, `oak init` installs Codex capture
  too (`--no-codex` skips it).
- **Unchanged:** the store (`~/.claude/claude-observatory`), prefs, editor settings
  (`claudeObservatory.*`) and `.observatoryignore` files. `claude-observatory` remains a deprecated
  alias of `oak`.
- **Machines configured for SSH session listing** (`prefs.remotes`, `claude-observatory remotes`) are
  no longer read. Add each machine again with `oak machine add <label> <ssh-target>`.
- Saved Timeline column widths reset once in both editors, because the Timeline gains a fourth tab.

### Added

- **The terminal app runs on herdr.** Its tabs are **herdr · Observatory · Review**: herdr's own
  client, where agents run in panes; a live view of every session; and the review workspace. `ctrl+a`
  then `n`/`p` or `1`–`3` switches tabs, `--tab <id>` opens a named tab, and `ctrl+q` twice quits from
  any tab (`ctrl+c` twice and `ctrl+a` `q` twice share the same confirmation). Inside a herdr pane the
  bar is Observatory · Review. The herdr tab passes the program's keyboard protocol, bracketed paste,
  focus reports, mouse, text attributes and cursor through to the terminal. The terminal app opens on
  the tab you used last, the Observatory the first time, or the herdr tab while the machine has no
  session yet.
- **The Observatory.** Sessions are grouped by machine, then by herdr workspace (sessions outside
  herdr under their project, or under "Unknown workspace" when the project is unknown), with each
  session's pane, agent kind, model, edits, tokens and last activity. Clicking a session, or Enter,
  pins its conversation beside the list: prompts, replies, thinking, tool calls with their captured
  diffs, Workers and Tasks. The pinned conversation follows its newest message until you scroll back
  (`End` or `↓ newest` returns), follows its pane when the agent restarts, and has a reply box (`i`)
  that sends through herdr. `h` jumps to the session's herdr pane and `r` scopes the Review tab to it.
  The Review tab shows the session under the cursor, previewed or pinned.
  Your prompts sit in boxes like the tool calls around them, on a grey ground that follows the colour
  theme, as the Claude Code and Codex CLIs show them. Workers and Tasks list what is still going on
  (working or waiting workers, with their model, effort and token split; pending and in-progress
  tasks), each marked in its state's colour with its stats in the session list's colours, under a
  header that counts the active entries out of the total, such as `Workers · 1/3 active`; the finished
  ones fold behind one row. A background agent counts as working until Claude Code logs it finished
  (failed, killed or stopped reads as errored) and again once it is resumed; with no such notice, it is
  done after it, its session and the session's other agents have all been quiet for five minutes, unless
  it stopped on a tool call or a question, which reads as waiting. This holds in the terminal app and
  both editors. `Shift+A` shows archived sessions.
- **herdr tab housekeeping.** Each herdr tab is named after the session running in it unless you named
  it yourself, and follows the session's title when it changes. A session's capture hooks and OAK's
  Claude Code status line rename its own tab even when `oak tui` is closed; while `oak tui` runs, it
  names the tabs of every machine. On Linux and macOS, `oak tui` also keeps a `btop` tab running a
  system monitor (btop, bpytop or htop) in every machine's `home` workspace, and OAK's herdr plugin
  restarts the monitor when herdr's server starts. The plugin adds an **Open in OAK** action, which
  selects the pane's conversation in the Observatory. OAK never closes a tab. The installers,
  `oak update` and `oak doctor --fix` set herdr's sidebar width (48–72 columns) and the gruvbox theme
  when you have not chosen them.
- **Other machines.** `oak machine add <label> <ssh-target>` provisions a machine (herdr, OAK in
  `~/.local/lib/oak`, `~/.local/bin` on its PATH, the capture hooks); `oak machine list` lists them.
  `oak attach [machine]` hands the terminal to herdr on that machine, and `oak agent start --machine
  <label>` starts an agent there. `--machine <label>` runs `views`, `review`, `list`, `sessions`,
  `conversation`, `feed`, `multitask`, `subagents`, `diff`, `keep`, `undo`, `redo`, `resolve`,
  `comment`, `quote` and `ignore` on that machine over SSH, with that machine's own `oak` in the
  session's own workspace, so the Review tab reviews a remote session where its store and files are;
  nothing is copied between machines. The Review tab's session picker (`b`) and the find palette list
  each saved machine's sessions under its name, read from that machine about every 15 seconds (a
  machine that cannot be reached says so), and `oak tui --tab review --session <id>` reviews a session
  that runs on a saved machine. Started outside any repo with no `--session` or `--root`, the Review
  tab opens on the session that most recently took a turn on any machine, this one or a saved one (on a
  machine running this version, a resume alone does not count), as the machines first answer and until you choose a session or act in
  the tab. `oak sessions --json` rows carry that time as `lastTurnMs`. `OAK_MACHINE_TIMEOUT_MS` (default 120 s) and
  `OAK_HERDR_REMOTE_TIMEOUT_MS` (default 30 s) extend the deadlines. The editors list and review the
  sessions of the machine their workspace runs on.
- **Codex support.** `oak init` (or `oak init --codex` alone) installs capture for Codex 0.147.0 or
  newer and pre-trusts only OAK's own hook commands in Codex's trust store. Codex sessions appear in
  every session list with their thread names (or the heading of the brief a prompt hands off to, a
  long one shortened to its first phrase),
  their rollout's workspace, model and effort, and their token usage with the cache split.
  `oak statusline` also turns on Codex's built-in status line items, and leaves a `status_line` you
  set alone.
- **New commands.** `oak agent start` starts a Claude Code or Codex agent in a herdr pane; `oak prompt`
  submits text to a session's live pane and keeps a draft when it cannot; `oak conversation` reads a
  transcript from its tail (`--limit`, `--since <cursor>`); `oak search` searches conversations;
  `oak integrity` reports capture gaps without rewriting records; `oak models` lists the local ollama
  models and `oak models use <name>` switches Codex to one; `oak titles` shows or refreshes session
  titles; `oak focus` selects a session in an attached terminal app. Plain `oak init` wires a local
  model into Codex only when Codex has no model choice at all (no top-level `model`,
  `model_provider` or `profile`, no `[profiles]` table, no profile `*.config.toml`); it marks the
  lines it writes, `oak uninstall` removes exactly those, and `oak machine add` never wires one.
- Both editors' Timeline gains a **Feed** tab, first in **Feed · Prompts · Observations · Actions**:
  the selected session's prompts, replies, thinking, tool calls (each naming the file it acted on,
  which opens in the editor), captured diffs and permission requests. An Overview selection shows that
  worker's, run's, task's or shell's activity. `oak feed --json` carries the same `reasoning` rows
  (`said`, `thinking`) in session, agent, workflow and task feeds.
- **Review comments and quotes.** Comment on a pending edit's lines, then send the batch to the agent
  as one prompt; quote the agent's last reply into a prompt to annotate it. Both prepare a draft that
  is sent through herdr only when you choose, and a failed send keeps the draft: `oak comment` and
  `oak quote`, VS Code's comment threads and commands, JetBrains' *Add Review Comment* (⌥⌘C on macOS,
  Ctrl+Alt+C elsewhere) and *Quote Agent's Last Reply*.
- **Needs you.** A desktop notification when a session waits on you (a permission prompt, a question,
  an input request; a finished turn is opt-in), fired once per machine. An inbox of every waiting
  session, most urgent first: `oak inbox`, the `i` overlay on the terminal's Review tab, a "needs
  you" group in VS Code's session selector, and ⚠ on the waiting rows of JetBrains' Sessions tab. A
  jump to the next one: the terminal's `h` on the Review tab, VS Code's status-bar `⚠ N` chip,
  JetBrains' ⌥⌘I (Ctrl+Alt+I elsewhere), `oak inbox --next`. `oak notify --watch` announces from a
  plain terminal. On macOS, OAK running in iTerm2, Ghostty, WezTerm or kitty has the terminal post the
  notification, so it carries the terminal's name and a click brings the terminal forward. Nothing is
  answered for you.
- **Session titles from claude.ai.** A session renamed in the Claude app or on claude.ai under Remote
  Control shows that title. OAK reads your account's session titles from `api.anthropic.com` with
  Claude Code's stored login, at most every five minutes, and caches only session ids and titles;
  `oak titles --off` (or `"remoteTitles": false`) turns it off. See SECURITY.md.
- **Usage for both providers.** The terminal's usage line and both editors' status bars show `5h`,
  `wk` and `mo` for Claude and for GPT (Codex) with their resets, coloured by threshold. `mo` is your
  bill cycle, read from the account's subscription date (`oak usage --bill-day N` overrides it). The
  account's per-model weekly cap (`Fable`) is not a status-bar item: both editors' status-bar tooltips
  and Stats panels list it, and the shell status line keeps its `fable` segment. Usage refreshes
  without a running Claude session: while an OAK view is open, OAK reads your account's usage from
  `api.anthropic.com` once the last reading is a minute old, and when Claude Code's stored login has
  expired it renews it and writes it back where Claude Code keeps it. Codex's quota comes from its own
  reports and, with Codex's login, from `codex app-server` (see SECURITY.md). In both editors,
  Enterprise and API-key accounts, which report no rolling limits, show their spend; an account with
  credits shows its balance, and a stale reading says its age. The Stats panels gain `mo` and `$` rows
  and fold per section.
- **`oak usage --breakdown`**: tokens, cache reads and estimated dollars by week, bill-cycle month,
  model or session, for Claude and Codex. Window spend comes from Claude Code's own cost figures;
  month and breakdown dollars price token counts at API list prices, are marked `~`, and are never a
  bill.
- **VS Code opens all edits in a stacked view**, with the editor's own syntax highlighting inside the
  added and removed bands, lines that wrap, a Keep/Undo pair per block, Spotlight, and a Side by side
  switch to the native multi-diff. In both editors a decided block shows its verdict and offers
  **↺ Revert** or **↻ Redo**.
- **Reset scope**, beside Search in both editors' Overview nav bars, clears the search, folder and
  prompt scopes at once.
- **Store size** in both editors' session lists and pickers and in the terminal's session picker. In
  the editors, a click on a Sessions row's size opens that session's store folder, and a store button
  sits beside Export in the review toolbar. The folder opens in the system file manager, or, when
  VS Code or Cursor is connected to another machine (Remote-SSH, WSL, a dev container), in a new
  editor window on that machine. A session with no store folder yet says so.
- **The terminal's change map acts.** Pending rows carry `[ ✓ ]` keep and `[ ✗ ]` undo buttons,
  reverted rows `[ ↺ ]` redo, and the heading carries keep-all, undo-all and resolve; each asks its
  question on the same row. Both editors gained scoped redo (VS Code `↻ file`; JetBrains Redo All in
  File / in Folder).
- **Terminal panes.** On the Observatory tab, `ctrl+a` splits, closes, zooms and swaps panes,
  `ctrl+a v` picks what a pane shows, and dragging a pane's title moves it. Drag across text on the
  Observatory and Review tabs to copy it exactly, as in the herdr tab: the drag highlights the text
  it covers, stays within the pane where it began, and copies on release (OSC 52, or tmux's buffer
  inside tmux; past OSC 52's size limit a local terminal uses the system clipboard). In the
  Observatory, a click that does not move acts when the button is released. `ctrl+c` copies a
  selection and `ctrl+v` pastes. The mouse pointer shows what a spot does (OSC 22). Pane borders are
  drawn by default (`OBSERVATORY_BOXES=0` turns them off).
- **Terminal review.** The Traces list folds each file to one row (`F` folds or unfolds all), the
  change map groups files outside the workspace under their real paths, Map and Diff are separate
  panes (`F4`, `F5`), and `e` opens GUI editors without suspending the terminal app.
- **`oak undo --ids <a,b,c> --record-only`** and `oak redo --ids … --record-only` record an undo or
  redo that already changed the files, without touching them again. When the store stays busy for
  10 s after an undo or redo has changed files, the CLI, the terminal app and both editors name the
  edits whose status was not recorded and show this command.
- **`oak init --repair`** replaces duplicated hook entries, and `oak uninstall` removes the hooks
  from every settings file OAK recorded writing.
- **`oak sessions --delete`** hides a session and purges its stored edits; `--undelete` lists it
  again, without the purged edits. Both editors' Sessions tabs, VS Code's session pickers and the
  terminal's session picker offer delete.
- **`oak doctor`** reports a herdr server started from inside a Claude Code session (its agents would
  run as child sessions, and `git commit` in its shells would abort), times forwarding to each
  machine and suggests SSH connection sharing when it is slow, warns when the terminal app cannot
  spawn a PTY (on Linux naming what node-pty's build lacked: a build tool, or npm 12's
  `--allow-scripts=node-pty`), names the most frequent capture skip reason, and says when the
  claude.ai titles were last read.

### Changed

- **Session lists show the sessions of the machine the workspace is on**, grouped by workspace with
  your own first, in both editors' session lists and pickers; a Remote-SSH, devcontainer or Gateway
  window lists the remote machine's sessions. Transcripts copied in from another machine by a sync
  tool are not listed as local sessions. Sessions in which nothing happened (no edit, no tokens, no
  reply) are left out of every list unless they may still be running.
- **Session titles follow Claude Code's order**: a rename (`/rename`, or on claude.ai) first, then the
  claude.ai title, then Claude Code's automatic title. Titles are one line of plain text.
- **Timestamps show the time, not an age**: in session lists, edit lists and feeds, `14:32:05` today,
  `Aug 31 14:32` this year, `2026-08-31` before that.
- **One icon vocabulary**: ✓ keeps and ✗ undoes or rejects in the terminal, VS Code and JetBrains.
  Revert and redo are arrows: in VS Code a kept edit's revert is ↺ and redo is ↻; the terminal's map
  marks redo ↺.
- **Redo restores the decision that was reverted**: a kept edit that is reverted and redone is kept
  again instead of pending.
- **In the terminal app, syntax colour applies to every diff line**, added and removed included, and
  is on by default.
- **The change map dropped its per-file churn bars**; each row has a button that opens the file's
  changes stacked.
- **Binary files are captured**, up to 25 MB, and shown as a size summary; a text file over 5 MB and
  any file over 25 MB are recorded as skipped.
- **The Bash capture walk skips what `.gitignore` excludes** (`.observatoryignore` still decides
  first), and it counts files before snapshotting, so a working tree over the 4,000-file cap costs no
  blobs. A Bash command that exits with an error has its file changes recorded as that command's own
  edits; 0.9.5 recorded them only when the next Bash command finished, and attributed them to it.
- **The capture hook starts faster**, because `oak capture` loads only the capture code: about 45 ms
  per hook on a Linux workstation, against 52 ms in 0.9.5.
- **`.observatoryignore` takes effect on a Refresh** in the terminal and both editors, for this
  machine's sessions. In the terminal it also takes effect for a session reviewed on another machine,
  where the Refresh runs the sweep with that machine's `oak`.
- **The status line** (installed by `oak statusline`) draws each bar as a rule under its figures,
  wraps at the terminal width instead of being cut off, always prints `used/total` and cache reads,
  adds a bill-cycle month segment and a `fable` segment, dedups messages across transcripts, keeps its
  reset countdowns when Claude Code omits them, and refuses to replace another tool's status line
  unless you pass `--force`.
- The Overview's **Group tabs** makes one group of all five tabs.
- `oak export` names the exporter `oak <version>` in its JSON `tool` field; it was
  `claude-observatory <version>`.

### Removed

- `claude-observatory remotes` and SSH session listing (`prefs.remotes`); use `oak machine add`,
  `oak machine list` and `--machine`, which the old `remotes` command now names instead of answering
  "unknown command". Usage is read on each machine for itself.
- The per-block Chat button in JetBrains' stacked review tab. Chat stays on the inline lens, the
  review bar and the viewer toolbars.

### Fixed

- After a 5-hour or weekly window resets, usage no longer shows the last window's share as this one's
  (it stood for hours after the weekly reset). Until a session or the account pull brings a fresh figure,
  the window shows no share or token estimate, in the terminal app, both editors and `oak usage`. When the
  status line reads the account's usage, it now keeps the account's own shares, not only the reset times,
  and an account with no per-model weekly cap no longer empties the status line's cache.
- The terminal app strips C1 control characters (U+0080 to U+009F) from the text it draws, as it already
  did C0 ones, so text an agent wrote cannot move the cursor or erase what OAK drew.
- Keys in the terminal app no longer act by accident. With the help or another overlay open, a letter
  no longer runs its verb on the review behind it (`u` reverted an edit there). An `alt` chord, or Esc
  and a letter typed quickly, no longer runs the letter's verb. In the herdr tab, `ctrl+a ctrl+a` sends
  a `ctrl+a` to the program (line start in Claude Code and Codex), and the leader takes a plain key
  next, so `ctrl+a ctrl+k` no longer ends the herdr client. The `ctrl+o` palette offers Review's
  actions only on the Review tab, and Esc cancels a pending confirmation first.
- The status line renders correctly on Windows. A working directory such as `C:\Users\you\code` no
  longer cuts the first row short and hides the second (its backslashes were read as escape codes),
  and figures read through a native `jq` or `python` under Git Bash no longer carry a stray carriage
  return that broke the context, usage and reset countdowns.
- A prompt pasted into Claude Code (`<pasted_content>`) is no longer dropped from prompts, asks and
  titles.
- Keep and undo can no longer act on another session's edit after switching sessions.
- Redoing a change after undoing it, while a later edit to the same file stays, puts the file back as
  it was, and an undo followed at once by a redo puts it back exactly. Both `oak redo <id>` and
  `oak redo --ids` used to report a conflict when the change and the later edit had both added lines
  at the same place, such as the end of the file, and a redo could put a line back on the other side
  of lines that a later edit had added right next to it. A conflict that remains now names the later
  edits the suggested `--force` would drop. A forced undo or redo now acts on the whole change, as
  `oak undo <id>` does: `oak undo <id> --force` on a change made of several edits, and Force-restore
  in VS Code and JetBrains, restore the file to its state before the whole change and mark all of its
  edits reverted, where they restored the state before the change's last edit and left its earlier
  edits in the file and pending; a forced redo restores every reverted edit of that change instead of
  leaving some marked reverted. The conflict message names the edit the file goes back to.
- Undo and redo no longer join two lines into one. When the file had lost its final newline on one
  side of the merge and a line was added at its end on the other, the added line was glued onto the
  last line and the undo or redo reported success: a redo turned `build --release` plus an appended
  `deploy` into `build --releasedeploy`, and an appended blank line could disappear. The final newline
  is now merged as a property of the file, so every line stays whole, and a change that only adds or
  removes the final newline is undone and redone alongside later edits.
- A keep or undo in the terminal app shows at once and no longer reappears when a slower read lands.
- Terminal app: when a terminal loses a mouse release, the next click is handled on its own. The
  selection still waiting for that release is dropped. Before, a seam drag or tab click that followed
  a lost release copied text nobody had selected.
- Diff lines that begin with `--` or `++` are no longer dropped from renders.
- Opening `$EDITOR` from the terminal app no longer corrupts the screen, and drilling into an edit
  no longer falls back to the map on the next refresh.
- `oak tui --tick <s>` and the saved "Refresh every" option now set how often the terminal app
  refreshes. Both were ignored, and the app refreshed every 3 s.
- The Review header shows `—` for a count it has not read, instead of reporting 0 pending, 0 kept,
  0 high risk and 0 conflicts while a read is loading or has failed. A single conflict reads
  "1 conflict".
- The JetBrains stacked tab renders stacked, a stale session pin no longer blanks every JetBrains
  panel, an empty Review tree names a failed CLI fetch, and one panel that fails to build no longer
  stops the others from painting.
- VS Code's session selector wraps in a narrow panel instead of crushing titles.
- VS Code: a click on a row of the Overview's Sessions list is no longer lost when a refresh arrives
  between the press and the release. The list is rebuilt only when what it shows has changed.
- VS Code's Observations view shows the agent's reasoning line in full and wraps it, instead of
  cutting it at 99 characters with an ellipsis.
- VS Code's Revert All and Redo All confirmations name a single edit in the singular ("Revert 1 edit",
  not "Revert 1 edits").
- JetBrains: the plugin now looks for the `oak` CLI in every location VS Code checks, including
  `/usr/bin` and bun, pnpm, asdf and fnm installs, so an IDE started from the dock or a launcher finds
  a CLI installed there.
- The Bash capture's file-stat cache no longer keeps entries for files that were deleted or are now
  excluded by `.gitignore` or `.observatoryignore`. It only grew, and every Bash command read and
  rewrote all of it.
- A capture's session lock is no longer taken over by another capture. Two captures that found the
  same crashed hook's lock no longer both proceed; both used to remove the lock, and two edits could
  then be recorded with the same id. A capture that holds the lock while the machine sleeps or its
  clock changes keeps it: a lock's age is now read on the machine's monotonic clock, so another
  capture no longer takes the lock over and records beside it.
- `oak ignore --stdin` given no paths reports that none is ignored. It used to fall through to the
  sweep and drop the session's records that match an ignore rule.
- Running OAK from a deeply nested directory finds that directory's Claude Code sessions, in the
  terminal, VS Code and JetBrains. Claude Code shortens a project folder name longer than 200
  characters and appends a hash of the path; OAK looked for the full name.
- `oak update` deletes the release files it downloads once the update succeeds; each update left
  about 600 KB in the temporary directory.
- On the pre-release channel, `oak update` no longer says "no pre-release published yet" when a
  pre-release exists and the stable release outranks it.
- Right after the status line is installed, `oak doctor` and `oak init` no longer advise installing it
  again; doctor reports it as installed until Claude Code first draws it.
- `oak doctor`'s "update channel persists" check tests the file the channel is stored in, inside the
  store folder that `oak store --move` can relocate.
- `install.ps1` parses when Windows PowerShell 5.1 runs it as a file; characters its default encoding
  misreads broke it.
- The curl installer (`scripts/bootstrap.sh`) verifies the CLI tarball's published sha256 before
  installing it, as `install.ps1` and `oak update` already did.
- JetBrains: a coalesced ×N run in Observations shows the reasoning of its newest edit, as VS Code's run
  row does, instead of its oldest edit's. When the newest edit recorded none, the row shows none.

## [0.9.5] — 2026-08-12

### Fixed

- **Updating and switching release channels now works in both directions, and stops going quiet.**
  A surface is refreshed whenever its version *differs* from the channel's newest — not only when the
  release is higher. The old `isNewer` gate could not express the downgrade half of a channel switch,
  and it silently ignored anything sitting *above* the channel line: a build installed from a `dev`
  checkout is newer than every `-dev.<n>` the pre-release channel publishes, so every surface
  reported a green "up to date", forever, on both channels. Such an install is now named
  (`not on this channel`) and pulled back onto it. One decision serves every front end
  (`core.resolveUpdatePlan`), replacing three call sites that compared three different ways.
- **The VS Code extension installs its own `.vsix`, so updating needs nothing on `PATH`.** *Update
  now* and *Switch release channel* went through the CLI, whose install step needs the editor's shell
  command (`code`, `cursor`, `code-insiders`); a Dock-launched editor often has none, so the buttons
  people actually press were the ones that failed. They now use the editor's own extension service —
  the path the background notifier already used. The CLI is asked only to refresh itself and the
  JetBrains plugin, and its absence is reported as a partial result rather than a failed update.
- **The version dropdown names what is actually installed, per surface.** *Update now* moves the
  extension, the CLI and the JetBrains plugin, which carry independent versions — the menu showed one
  number, so whenever they differed it described something other than what the button changed. Each
  surface now carries its own version and verdict, a CLI that cannot be found says so, and a build
  that is installed but not yet loaded reads `pending reload` instead of reporting the old version.
- **A channel switch can no longer half-apply.** The choice is persisted *after* the installs are
  attempted, not before, so a blocked install cannot leave the config naming one channel while the
  binaries came from another.
- **The editors stop inferring success from the CLI's prose.** `claude-observatory update --json`
  reports the whole plan as data — every surface, its version, and why it will or will not be touched
  — and installs nothing. Both editors read that instead of searching stdout for
  `everything is up to date`, a string that also occurs inside a message meaning the opposite.
- **VS Code Insiders is detected.** It has its own extensions directory and its own CLI name, and
  having neither in the table made every Insiders user invisible to `update` and `install-extensions`.
- **A leftover extension folder can no longer re-strand an install.** Editors keep the previous
  version's folder after installing, and detection took the highest folder it found — so after a
  switch *down* to stable, the abandoned higher folder kept being reported as installed. The editor's
  own `extensions.json` registry decides now, with the folder scan as the fallback.
- **"Couldn't check" no longer looks like "up to date".** The release feed is queried anonymously and
  can rate-limit; that state is now its own, in both the chip and the CLI.
- **The CLI is found in more places.** `resolveBin` also looks in bun, pnpm, fnm, asdf and
  `/usr/bin` — an editor launched from a Dock icon inherits none of them on `PATH`, which reads to
  the user as a button that does nothing.
- **The terminal's Workflows tab renders the per-phase breakdown**, carrying the same fields VS Code
  and PyCharm do: the run's phase summary, its metrics (activity sparkline, ±lines, agents, tokens,
  time, edits), its name when the description differs, then one heading per phase with its agents
  nested beneath — each with its own sparkline, ±lines, model, effort, tokens, time and edits — and an
  `other` heading for agents in no declared phase. It had been rendering one flat line built from
  `w.phase` — a field `WorkflowRun` does not have — so the column was always empty, and its edit
  count came from a different source than the editors', giving three front ends two answers.
- **A wrapped dashboard row keeps its indent.** Nesting is carried by leading spaces, and the wrapper
  splits on spaces — so any indented row long enough to wrap came back flush against the margin and
  read as a top-level row. Latent across every nested list; reachable as soon as a row got long.

### Changed

- **`dev`'s committed version is now a prerelease of its target** (`0.10.0-dev.0`, not `0.10.0`).
  By semver a prerelease sorts below its release, so the plain form outranked every rolling build CI
  publishes and put anyone who built locally above the channel line. CI strips the suffix before
  re-stamping, so nothing downstream changes.

## [0.9.4] — 2026-08-07

### Added

- **A refused undo now names WHY, when the reason is later work.** Units track line-range ancestry:
  when a later unit rewrote lines an earlier one produced, the earlier unit's undo already conflicts —
  and the refusal now names the depending unit(s) and carries the exact `undo --ids` closure that
  reverts them together, offered as one action ("Undo both") in both editors beside the force
  fallback, and surfaced on the terminal's status row. A conflict with no dependent unit keeps its
  original wording. (The dependency model follows GitButler's hunk-locking research.)
- **`oplog` — the reviewer's own operations, journaled and reversible.** Every bulk keep, revert or
  redo (≥2 records) is journaled in the same append as its status flips, carrying each record's
  before-status. `oplog` lists them newest first; `oplog --revert-last` reverses the most recent one —
  statuses restored for a keep, files actually rewritten for an undo/redo — and the revert is itself
  journaled, so reverting twice round-trips. CLI-only, like `tasklog`. (The operations-log design also
  follows the GitButler comparison.)
- **`assign` — move edits' prompt attribution.** `assign --ids <a,b,c> --prompt <id|index>` records
  an exact override keyed by immutable record ids (`--clear` restores the recorded window); prompts,
  the change map's per-ask rollups, `review --prompt`, and rewind scopes all follow — the prompt
  surfaces through one shared helper, the change map through the same override table at its own
  attribution site. Units are NOT re-derived — boundaries stay temporal; only the label moves. The
  editors' drag/menu gesture is deferred to 0.10; the mechanism ships now.
- **`review --prompt <id>` — one ask's work as review units, each with its net patch.** The payload
  every Review surface renders, and the seam that finally gives the JetBrains plugin core's collapse
  (it reads raw records off disk everywhere else). Patches are budgeted and omissions are NAMED in the
  payload, never silently absent; `--no-patch` fetches metadata alone.
- **Overlapping Bash commands no longer invent edits.** The whole-tree snapshot a `Bash` capture
  diffs against lived in ONE file per session, so a backgrounded command's PostToolUse diffed its
  walk against whatever snapshot the next command had just written: every file outside that
  snapshot's directory read as CREATED, the mirror image read as DELETED, and the partner command
  then found no snapshot at all and captured nothing. On the session that reported it, **3,050 of
  3,378 records sat in chains that cancel out**, 3,211 of them written by Bash, including a
  `.gitignore` that alternated created/deleted sixteen times without being touched. Each Pre now
  writes its own snapshot keyed by
  the tree it walked, each Post consumes the oldest one taken of ITS tree, stale snapshots are
  reaped (by the collector too, not only when the next Bash command runs), and the blob reaper
  honours all of them (a blob a command is mid-flight against must not be collected). Two commands
  overlapping record their change once, not twice: whatever a Post writes to the log advances every
  other pending snapshot whose tree CONTAINS that file, because both snapshots genuinely straddle the
  change and a duplicate row makes undoing the first refuse as a conflict. Containment, not an equal
  root — a command in `packages/jetbrains` running beside one at the repo root left the repo-root
  snapshot holding pre-change content, and it recorded the same edit a second time. A file is only
  ever added to a snapshot whose tree contains it: writing a key for a file outside that tree would
  make its own Post walk, never see it, and report it deleted.
  Existing logs keep their phantoms — the cancelled-chain rule below folds most of them away — but
  no new ones are recorded. Two further holes closed with it: a snapshot is never told about a file
  its own walk cannot reach (the walk skips `node_modules`, `build`, symlinked and unreadable
  directories, so a change recorded by a command inside one of those made an ancestor's Post report
  the file DELETED — and the resulting pair made the real change refuse to undo), and a previous
  build's rootless `__bash__.json` no longer answers for a subdirectory (it matched any cwd and
  sorted first, so the first command after an upgrade could report every file outside its own
  directory as deleted). A truncated post-walk now says that it dropped deletions instead of
  dropping them in silence, and an edit captured by `Edit`/`Write` advances the pending Bash
  snapshots too, so a Bash window straddling it no longer records the same change a second time.
- **A change captured by a tool call is no longer recorded a second time by a Bash command.** The
  snapshot a `Bash` capture diffs is taken before the command runs and walked after it, so a
  backgrounded command's PostToolUse routinely lands in the MIDDLE of an `Edit`/`Write` — its walk
  sees the new content, records it, and then that edit's own Post records it again. Two rows, byte-
  identical before AND after, consecutive ids, one of them attributed to `Bash` — and undoing the
  first refuses as a conflict with the second. The EDIT is the side that yields, never the walk: the
  walk's snapshot is consumed and cannot be replayed, so a capture declined there is a change lost
  outright — and edits are declined and abandoned routinely (PreToolUse fires before the permission
  prompt, PostToolUse only on success, so every denied or failed edit leaves its before-snapshot
  behind). So the walk records what it saw, attributing it to the edit tool that is mid-flight rather
  than to `Bash`, and that call's own commit declines when the file has already reached the content it
  was going to report. Matching on the END STATE also covers the walk recording a WIDER transition
  than the edit did, where appending the narrower one would break the file's chain. Pinned by five
  hand-written interleavings and a seeded fuzz over randomised ones — mutation-checked: with the
  dedupe removed the fuzz reports 22 duplicate pairs.
- **The Review view has its toolbar back**, and its bulk verbs no longer overlap the scoped ones. Removing the Edits and Diffs views took their title-bar
  nav with them, and a webview view cannot draw its own — so Search edits, previous/next edit, Keep
  all, Undo all, Redo all, Clear resolved, Switch session, Refresh, Toggle inline review, and the
  export/diagnostics overflow (Export summary, Export trace, Doctor, Clean store) had no home at all
  and were reachable only from the command palette. They are back on Review, in the order they had — with Keep all / Undo all / Redo all hidden while a
  prompt is picked, because those are session-wide and the panel's own buttons one row below are
  scoped to that ask: one click reading "accept everything" above a button reading "Keep all (7)" is
  the same word for a forty-times-larger action. While a search filter is active the bulk buttons hide
  and say why (they act on the whole scope, not the filtered rows), and a filter that matches nothing
  now says so instead of claiming the session has no changes.
- **The review split stops re-deriving on every message.** Its memo was stamped on the transcript
  FILE, and a transcript grows with each message rather than each ask — so a live session paid a full
  re-derivation about ten times a minute for an input that could not change the answer (measured:
  ~200 ms of core work per message on a 3,468-record session with a 24 MB transcript). It now keys on
  the ask BOUNDARIES it actually reads, and the block text a move-detection compares is memoized per
  hop instead of re-splitting whole files — 94% of records took that path on a Bash-heavy session,
  re-tokenizing 1.8 million lines every time. Same answers, **~200 ms → 59 ms per message**, and the
  two hottest callers (an ask's rollup, and the per-sibling fleet scan that runs in a fresh process)
  ask only for the status they read. The editor caches that hide cancelled chains now stamp the
  transcript as well as the log, so a boundary that appears between existing edits cannot serve a
  stale set.
- **A file's final newline is an edit again.** Blank-line churn is deliberately not tracked, and
  splitting on `\n` made a trailing terminator look like an empty last line — so adding or removing
  the newline at the end of a file compared equal to no change at all and was never recorded, never
  shown, never undoable, while git renders it as `\ No newline at end of file` and linters fail on
  it. Real blank-line churn still earns no row.
- **Review is THE review surface.** The Edits and Diffs trees are gone from Observatory Traces in
  both editors — the raw records stay in the backend; File History still reads them per file and
  carries the first-run demo offers. What remains is one list: Review sits FIRST (the default
  surface), shows the whole session by default, and scopes to one ask when a prompt is picked
  (`review` without `--prompt` answers the session-wide units; `--pending` filters to the
  undecided). One row per piece of code, however many times Claude revised it — the same-code
  collapse, now MOVE-aware: a block deleted in one edit and re-inserted verbatim in another
  collapses into the same unit (rotation-tolerant matching, because the diff attributes a slid
  window when a block's boundary line repeats beside it). **A file being ABSENT is no longer a unit
  boundary**, which is the other half of the same idea: `null` is not content, so a deletion and the
  re-create that follows it have no state in between for anyone to decide about, and they are one
  unit whose diff is the real before→after. Splitting them produced rows that lied in both
  directions — "+0 −133" for a file that still exists, then "+133 −0" for one that was never gone —
  and the delete-first ordering was worse than cosmetic: on every file whose chain alternated, the
  FIRST and LAST record were stranded as two contradictory pending rows no matter how many cycles
  sat between them. Chains that CANCEL OUT collapse too, and
  they are the one thing allowed to cross an ask boundary: a file created in one ask and deleted in
  a later one — or an edit put back exactly — is not a change at all, and listing it as two
  contradictory rows (`+16 −0` then `+0 −16`) asked for two decisions about nothing. Such a chain is
  no longer a row in any surface: **Review ends with one line naming them — "N cancelled-out chains
  (nothing to review)" — and a Dismiss that keeps every record behind it at once** (the terminal's
  footer is a row, so its ordinary `a` does the same job). `review --json` carries them as
  `cancelled` / `cancelledIds` beside `units` (plus `hiddenIds`, everything a renderer must not
  draw), and `list --json` marks the rows, so nothing is hidden from a count — only from the
  decisions you are asked to make. A dismissed chain stays hidden rather than returning as a greyed
  row, and **every count now means the same thing**: the review list, the change map, the Sessions
  row, the Stats scoreboard, the status bar, the nav bar's File/Folder/Diff axes, the gutter marks
  and the next-pending walk all skip these chains, where several of them used to count the raw log.
  A rewind names what it reaches: one unit can span two asks when the file was absent in between, and
  a unit is the smallest thing that can be reverted, so "rewind to before this ask" can revert an
  edit from the ask before it — `review`'s dry run and both editors' confirmations now count those
  records out loud instead of letting them be discovered afterwards.
  A log written before the capture fix keeps whatever its chains say: where a real edit's recorded
  "before" post-dates a phantom deletion, the chain is genuinely broken and no display rule can
  repair it — this folds the pairs, it does not rewrite history. VS Code lists rows grouped by FILE, each
  header carrying Keep/Undo over exactly the pending work listed under it; JetBrains renders the
  same units as the classic folder → file → class TREE (virtualized, so a 3,000-unit session is
  instant, no pagination) with Keep/Undo/Redo/Diff on every row's context menu. Resolved rows stay
  listed, greyed — an undone row offers redo, a kept row can still be reverted — with **Clear
  resolved** beside Keep all/Undo all on both; Search Edits narrows the list; and the activity-bar
  pending badge rides the Review view. The list holds no code: a row opens that unit's NET diff in
  the editor, and **Open all in editor** reads the pending work as one concatenated view (VS Code:
  the native multi-diff editor; JetBrains: the plugin's own stacked review tab, ten hunks-only
  diffs at a time, sized to the window). Each diff carries its own Keep/Undo/Chat — VS Code as a
  review bar at the first CHANGED line of each diff (its rows keep the editor's own hidden-unchanged
  folds, so a diff reads as its hunks with the rest one chevron away), JetBrains on each block's
  header and on the embedded viewer's toolbar. A diff longer than
  `claudeObservatory.openAllPreviewLines` (default 50 changed lines) opens there as a **bounded
  preview** — whole hunks up to the budget, both sides windowed together so it stays a faithful diff
  of what it shows, with markers naming where the window starts and how many changed lines are not
  in it, and **Open full diff** on that row's bar. One 13,000-line rewrite no longer buries every
  other change in the ask. To make diffs read as hunks rather than whole files, the VS
  Code extension ships a `configurationDefaults` for `diffEditor.hideUnchangedRegions.enabled` —
  an APPLICATION-WIDE default (git diffs included); a user's own explicit setting always wins. The picked ask is
  marked in every Prompts list (VS Code: a review button and a "reviewing" pill on the row;
  JetBrains: a Review action on the panel toolbar). The terminal's Traces window holds the same
  unit-backed list — one review surface, not a separate tab (the window keeps the editors' name so a
  reader moving between the two does not learn two words for one thing): opening a prompt (`↵`, or
  its `[review]` cell) scopes the list to exactly that ask, `esc` clears. The guided tour reshaped with it (42 steps, 14 essential).
- **`F1` in the terminal is Claude.** A thin status strip above Prompts — model, effort, liveness,
  pending count, the newest ask — and pressing `F1` again hands the whole terminal to
  `claude --resume <session>` in that session's own workspace, restoring the dashboard on exit with a
  report of what moved while you were away. A LIVE session asks first (resume opens a second writer on
  the same transcript) and offers `--fork-session`; a session whose workspace is not on this machine is
  refused rather than resumed from the wrong directory. Window keys renumber to `F1`–`F6` (Claude ·
  Prompts · Traces · Map · Diff · Dashboards); the strip yields to every workspace when rows run short
  and keeps its chip and launch gesture while folded.
- **Drag to copy, in the terminal.** With mouse reporting on, the terminal's native text selection
  never reaches the app's rows — so the app does it itself: drag across any window's body and the
  visible span lands on the system clipboard (OSC 52, so it works over SSH and tmux), with a
  "copied N line(s)" receipt. A plain click still selects instantly.
- **The terminal front door opens on the session that is actually live.** Launched inside a repo it
  scopes to that workspace's newest session, as every verb always has; launched OUTSIDE any repo (a
  shell at `$HOME`) it used to walk up to whatever stale session an ancestor directory once launched —
  now it opens the machine-wide newest, and a long-running dashboard says — once — when a newer
  session appears (`b` switches; it never auto-switches under an open review).
- **The Claude window shows the session LIVE, and resizes like any window.** Beneath its status row
  it tails the session feed — Claude's own activity as it lands, tool calls dim, the agent's words at
  full weight, failures tinted — following the newest entry unless you are reading inside the pane
  (`G` follows again). It opens at ten rows, grows or shrinks with its seam or `<`/`>`, zooms full
  screen with `z`, and an `F1` restore the terminal is too small for now says exactly how many rows
  it needs instead of silently staying folded.

### Changed

- **The review unit is redesigned: repeated edits to the same code are ONE change.** Agents revise a
  region, move on, and come back to it; the old collapse only merged *adjacent* records in a file's
  chain, so a superseded edit — one that no longer owns a single line on disk — still demanded its own
  decision as a phantom row. Units are now contiguous **spans** of a file's records, merged when a
  later edit rewrites lines an earlier one produced (same-lines) or when both changed the same detected
  function (same-function — new per-language detection in core, regex + brace/indent at git's own
  `xfuncname` fidelity, deliberately no parser dependency), and **bounded by the prompt that produced
  them** — a unit never spans two asks, so every ask reports its own work and a rewind from ask N can
  never drag in an edit ask N−1 made. Every surface's *pending* count changes once, together: on the
  bench workload that used to render 3,001 rows for ~150 regions of real change, the list now shows
  151, and the end-to-end refresh is ~38% faster because everything downstream handles 20× fewer rows.
  `diff <id>` now renders the unit the row names — its whole net change — rather than the raw last
  hop; a hand-typed member id still answers the single record it names.
- **Blank-line-only churn is no longer captured.** An edit whose only difference is added or removed
  blank (or whitespace-only) lines records nothing, the same way an identical rewrite already recorded
  nothing. The check fails closed: creates, deletes, unreadable snapshots and non-UTF-8 content are
  always captured.
- **Undoing a review unit is ONE merge, not a member-by-member walk.** A unit's members are
  contiguous, so its net change IS the blob pair `(first before, newest after)` — the same pair every
  diff surface renders. The old walk paid one file read, one whole-file merge and one locked append
  per member, and could conflict against the unit's *own* chain, stopping half-reverted; that state
  is now impossible for a unit acted on AS a unit — its verb sums the chain, so a conflict means a
  later unrelated edit or a manual change, never the chain itself. (An explicit multi-selection still
  reverts record by record; that scope's per-record conflicts are its honest semantics.) Scoped bulk
  reverts batch their ledger writes the same way (one status flush instead of one append per record,
  which had made every next step re-parse the whole log).

### Fixed

- **Enter on an ask with no edits now says so** instead of silently doing nothing.
- **A path-scoped confirm no longer reads "keep 0 edit(s)".** The `[y/n]` question for a file or
  folder action counted an id list that is empty by design for path scopes; it now shows only the
  real count ("keep — 12 edit(s) under everything in src?").
- **VS Code's per-prompt Accept/Reject half-resolved collapsed units.** `keepPrompt`/`undoPrompt`
  filtered the raw log by the prompt's *display* ids — unit representatives — so acting on an ask
  resolved each unit's newest member and stranded the earlier ones pending, at an intermediate state no
  surface can name. Both now expand through `groupMembers`, as the terminal always did.
- **The terminal's vertical seams tracked the wrong rows with two top panes.** `hitTest` computed the
  column band's top as "below the Prompts box" — true only while the top dock held exactly one pane.
  It now sums every top-dock box, and the layout test that recomputed it the same wrong way (and so
  passed while both were wrong) derives it the way the product does.
- **The terminal read the wrong workspace, and three panes went quietly empty.** Fleet showed nothing,
  Prompts showed nothing, and the session picker listed ids instead of names — with no error anywhere.
  All three are transcript-derived, and a transcript is found under its session's *mangled launch cwd*;
  the views were resolving that from `process.cwd()`, so a dashboard opened anywhere but inside the
  workspace — or pointed at another workspace's session by the picker — had no transcript to read.
  Traces kept working the whole time, because it reads the store by session id, which is what made it
  look like missing data rather than a bug.

  The terminal now asks for the session's own workspace (`core.sessionWorkspace`, taken from the first
  line of its append-only transcript), and every view honours `--root`. Five did not: `prompts`,
  `feed`, `risk`, `egress` and `processes` — and a shared `noTranscript()` guard ignored it for all of
  them, short-circuiting before any caller's root could matter. An end-to-end test now asserts the
  property rather than the instances: **the same query from a foreign directory must answer exactly
  what it answers from inside the workspace**, for all nine views, with a control proving `--root` is
  what does it. That test found two more (`changemap`, `sessions`) the by-hand audit had missed.
- **Fleet showed a fraction of what the editors show.** No tokens, no runtime, no model or effort, and
  no subagents — a flat list where the editors show a tree. Everything but model and effort was
  already on the payload; the row just never read it. Subagents now nest under the agent that spawned
  them, as continuation rows so the cursor still steps between agents, and the token/duration
  formatters moved into core so the terminal cannot drift from what the editors print for the same
  agent.
- **The session picker leads with the NAME, and carries what the session cost.** The name sat last,
  past four columns of metadata. Titles come from a session's first ask, so several genuinely share
  one — five rows here read the same thing — and a repeated title now carries its short id, while
  unique ones stay clean. `b` also joined the key row; it was reachable and documented in the keys
  screen, but the row never named it.

  Each row now also shows `±lines`, `tokens · elapsed` and `model · effort`, the same fields the
  editors' Sessions row shows. All of it was already on the payload and none of it was displayed, so
  choosing a session to review meant choosing on a name and an age alone, with its size, spend and
  model one keystroke out of reach.
- **Every session was costed from the reader's directory, not its own.** The picker lists *every*
  workspace's sessions, but `sessionMeta` re-resolved each transcript from the caller's cwd — and that
  lookup only walks *up*. So from any directory that was not a session's own workspace, its tokens,
  duration, model and effort all came back empty: on this machine, 82 of 107 rows. It already knew the
  exact file (it scanned every workspace to build the list); it just did not pass it. This is core, so
  it lands in both editors' Sessions tab as well as the terminal — and each row is now costed from the
  same file its own workspace label names, which was not previously guaranteed.
- **A wrapped row moved the selection highlight to a different row.** The overlay expands each logical
  line into as many visual lines as it needs, then compared the cursor — an index into the *logical*
  lines — against a position in the *expanded* ones. Every wrap above the cursor shifted the highlight
  down by one. It was latent while picker rows fit on one line, which is why it survived; it now
  tracks the row it belongs to, and marks every visual line of it.
- **The picker drops whole columns on a narrow terminal instead of re-flowing.** A table is the one
  thing the overlay must not wrap: a two-line row in a list you are arrowing through costs the
  alignment that made it a table. Columns now go in the order a reader needs them least — workspace,
  then ±lines, then model, then cost, then machine — with the name, review state and age never
  dropped. Nothing is cut mid-word either way; a column is present in full or not at all.
- **The terminal's dashboards showed identifiers where names belong.** The Tasks pane listed rows of
  `a3f21c9de4b7…` and nothing else, because it read `content`/`title` — the spellings the plan
  harness used before tasks gained `subject`. Both editors were already right (VS Code reads
  `t.subject`; JetBrains reads it with a `task #N` fallback), so this was the terminal drifting away
  from them, and nothing noticed because falling back to an id is *silent*: the pane still rendered,
  still filtered, still scrolled. It just stopped answering "what is this".

  Every dashboard now goes through one resolver, and its fallback names the KIND rather than printing
  a digest: an unnamed task reads `task 3`, an unnamed workflow is named as a workflow, and an agent
  with no branch or worktree is named as a session rather than shown as a bare identifier. The older
  `content`/`title` spellings are still read, so an archived session does not turn into a wall of
  hashes the moment it is opened.

### Build / CI

- **The rolling pre-release channel cannot go backwards any more.** `dev`'s committed version is the
  next stable target, and a promote could pull it back without a word: `main` carries the release it
  just cut, and because main contains dev afterwards, merging main into dev is a fast-forward — no
  conflict, no warning, and dev's `0.10.0` quietly becomes `0.9.3`. `version:check` still passed,
  because it only proves the files agree with each other, and they agreed perfectly at the wrong
  number. The first symptom would have been a `0.9.3-dev.N` published over a live `0.10.0-dev.M`,
  stranding every pre-release install above the version line with auto-update quietly finding nothing
  newer. The dev workflow now refuses to publish a version that does not outrank what is already
  live, compared with core's own `isNewer` rather than a constant.

## [0.9.3] — 2026-08-05

### Added
- **`tui` — a terminal app with the editors' review actions.** **Four windows** over one
  session — **Prompts** across the top, **Traces** on the left, a centre **Detail** window and
  **Dashboards** along the bottom — named on the top row so what exists is visible before you press
  anything, with the counts that matter beside the session on the row below (pending, kept, high-risk
  commands, remote egress, live conflicts, active agents), so nothing safety-critical is behind a
  window you have to think to open. Keep and undo work here as they do in the editors: `a`/`u` act on
  the selection, `A`/`U` on everything the focused window currently lists, and every scope wider than
  one edit asks first with the real count. Windows whose rows are observations rather than edits say
  so instead of quietly doing nothing.

  **Detail is one window with two faces**, `F3` Map and `F4` Diff, because you are only ever looking
  at one of them; it opens on the Map when nothing is selected, and its title always says which face
  is up, with that face's own key. `↵` or a second click zooms it to full screen — the same window,
  the same colours, its navbar and an `edit #N · path` status bar — rather than a second, plainer
  diff renderer.

  **The Map** is the change map as a folder tree, rolled up by path prefix so nothing is hidden
  behind a top-N cut: whatever is off screen is still counted by a visible ancestor. Each row carries
  lines added, lines removed, edits pending and edits kept, plus a **✓ / ↩** pair that accepts or
  reverts everything beneath it. On a real session it reported in one row that 99.98% of the churn
  was outside the workspace, which a flat churn-ranked ledger had buried behind long paths.

  **The mouse works** — drag a seam to resize, click a window to focus it, click its twig to
  minimize, click a tab, click a row, click it again to open it, scroll with the wheel — using SGR
  extended reporting, so columns past 223 are addressed correctly. `--no-mouse` hands click-drag back
  to the terminal's own text selection.

  `F1`–`F5` focus a window and, pressed twice, zoom it; `0`–`9` jump to a numbered edit; arrows move
  (there is no `j`/`k`); `space` folds a folder; `e` hands the terminal to `$VISUAL`/`$EDITOR` until
  it exits; `o` opens an options window for the editor, the display and the keybinds, which names the
  file it writes. Selection is carried by colour — a solid band in the focused window, a fainter one
  elsewhere — and the `>` marker returns only with colour off, where nothing else could carry it.

  `dash --once` prints one plain frame and exits, which is also what a pipe or any non-TTY gets.
  `NO_COLOR` is honoured. The glyph set is chosen by what fonts actually ship: no box drawing (absent
  from Menlo Bold, VS Code's default terminal font) and no braille (absent from every monospace font
  on macOS, where the substitute is 13.5% wider than the cell and silently breaks the grid). Review
  states carry a distinct **shape** as well as a colour, and pending/kept/undone are one hue's
  lightness ramp rather than three hues, so accept and reject never depend on colour vision.

  The terminal is restored — alternate screen, cursor, mouse, focus, paste mode and raw mode — on
  every exit path including SIGINT, SIGTERM and SIGHUP, which do not run ordinary exit handlers.

- **`.observatoryignore` — say which edits are never recorded.** A session on a real repo is mostly
  noise: lockfiles, `dist/`, snapshots, generated clients. This is a `.gitignore`-shaped file that
  says which — same patterns, same `!` negations, same "last matching rule wins", including git's
  rule that a negation cannot re-include anything beneath an excluded directory.

  **One mode.** A path that matches is **never recorded**: not captured, so not listed, not counted,
  and not revertible, because there is nothing to revert. There is no "hide but keep" — which makes
  this the one file in the product where a typo costs data rather than visibility, and why the verb
  below names the rule that decided and reports any rule that can never fire. `#` lines are ordinary
  comments, as they are to git, so the file stays portable.

  **A rule you add later reaches back.** Records captured before the rule existed are the one case a
  capture-time refusal cannot cover, so they are swept from the store — automatically, on the next
  capture, gated on a fingerprint of the ignore files the session's directories can see, so the log
  is rewritten once per rule change rather than once per edit. The sweep never runs from a read path,
  does nothing at all when nothing matches, takes the same lock and GC as `clear`, and records what it
  destroyed. `claude-observatory ignore` runs it too, and prints the count and the files.

  Files nest like `.gitignore` (one in any directory governs its subtree, nearest wins),
  `.git/info/observatoryignore` holds rules for one checkout, and `~/.claude/.observatoryignore` is a
  personal outermost layer so your own noise rules need not be committed into someone else's repo.

  `claude-observatory ignore --check <path>` names the rule, its file and its line — including the
  excluded ancestor when that is what decided, which is gitignore's most famous trap — and takes
  `git check-ignore`'s own flags and exit codes, with `-v` output verified byte-for-byte against real
  git in the test suite. The bare verb additionally reports any rule that can never fire, the
  diagnostic git's own tooling leaves you to work out.

- **A settings gear in both editors' Overview, at the far right of its toolbar.** JetBrains had a
  settings screen registered under Settings ▸ Tools and no way in the tool window to open it, so the
  only way to find it was to already know it was there; VS Code had the button but sat it before the
  version chip rather than at the end of the row. Both now close the row with the version chip and
  the gear, in that order.

- **A shared filesystem watcher in core (`watch.ts`).** One implementation of what both editors had
  each grown separately: 150 ms store debounce, 700 ms activity debounce, a 30-second cache of which
  project directories are relevant, and filters that fail open because a stale panel is worse than a
  missed one. Recursion is selected by platform rather than by `try`/`catch` — Node does not throw for
  a recursive watch on Linux, it substitutes a per-file watcher, so a `catch` waiting to pick the poll
  fallback never fires and quietly opens one handle per file instead. Any degradation is reported to
  the caller rather than leaving a surface that has silently stopped updating.

- **A terminal input decoder in core (`tui/input.ts`).** Terminals send more than keystrokes down
  stdin — mouse reports, paste wrappers, and unsolicited replies to capability queries — and they
  split them across reads wherever they like. A per-chunk scan mistakes all of it for typing, which in
  an application whose single letters keep or revert code is not a cosmetic bug: a background-colour
  reply arrived as two dozen keys, a split arrow arrived as `A` (keep everything), and a split paste
  containing `U` arrived as bulk undo. The decoder buffers partial sequences and emits typed events, so
  a reply can never be a key. Over 3,000 randomised split points the old scanner leaked a destructive
  key 886 times; this leaks none.

- **Display-width primitives in core (`textwidth.ts`).** `displayWidth`, `fitVisible`, `wrapVisible`
  and `sanitizeCell`. `String.length` is the wrong ruler for anything a terminal draws — a coloured
  `✓ ok` is 13 characters and 4 columns, `漢字テスト` is 5 and 10 — and nothing here measured properly
  before. `sanitizeCell` strips the escapes that move the cursor or erase the screen while keeping
  colour, because transcript-derived text reaches a rendered cell raw.

- **`views` can batch `feed` and `list`.** Both are read-only and both were missing from the
  allow-list, so asking for either fell through to the unknown-view path and was swallowed into a
  `null` — a caller batching them got a silently empty pane rather than an error.

- **The settings gear reaches JetBrains, and moves to the far right in both editors.** JetBrains had
  a settings screen registered under Settings ▸ Tools and no way in the tool window to open it, so the
  only way to find it was to already know it was there.

- **Sessions on other machines, over SSH.** Configure a host in the terminal's options window
  (`o` → REMOTES) and the session picker lists that machine's Claude Code sessions beside the local
  ones, each labelled with the host it came from. It is **read-only and deliberately so**: every
  command it runs there is `ls`, `stat` or `head`, one round trip per host, and nothing is ever
  reverted on a machine whose working tree this one cannot see. A host that is down, one with no
  Claude Code on it, and one with no sessions yet are three different answers, and the picker says
  which — a failing host becomes a row carrying its own error rather than quietly vanishing. Remote
  sessions are listed but cannot be pinned for review, because their store and files are elsewhere;
  the picker says so instead of blanking every window.

- **Cross-process caching for remote listings.** The per-host cache was in-process only, and every
  CLI-driven surface spawns a fresh process per refresh — so it never hit once, and JetBrains' 3-second
  poll paid a full synchronous `ssh` per tick while a comment claimed the cache absorbed it.

### Changed
- **The terminal app gained the ten things every comparable TUI has.** Surveyed against the tools in
  `awesome-tuis` — lazygit, k9s, gitui, delta, fzf, btop, yazi — and grounded in what was already
  there rather than added twice:
  - **`y` copies** the selected path, or the whole patch when the Diff face is focused. Over
    **OSC-52**, so it works over SSH — which matters, because this app lists sessions on other
    machines and there is no local clipboard tool to shell out to there.
  - **The filter matches scattered letters** (fzf's rule): `pcsi` finds
    `packages/core/src/index.ts`. A literal query still matches contiguously first, so `.ts` behaves
    exactly as it did.
  - **`/` on the Diff face searches the patch**, with `n`/`p` for the next match. The list filter
    could never help inside a 341-line diff — it narrows rows, and the diff is one row's contents.
  - **`g`/`G`** jump to the ends, and **`j`/`k`** move. j/k are bound but deliberately **not**
    advertised: the key row still teaches arrows, because that is what someone who has never used vi
    will try — but a vim user pressing them into a dead keymap concludes the app is broken.
  - **`:` opens command mode**, k9s-style, over an **allow-list** of read-only verbs (`help`,
    `remotes`, `store`, `ignore`, `doctor`, `status`, `version`). Never a shell: this is a text field
    inside an app whose other keys revert files, so the list is closed on **arguments** as well as
    verbs — each entry runs its bare reading form, and nothing the reader types after the verb is
    forwarded.
  - **`s` cycles the sort** — newest first, by path, or by churn. A 546-file session is not read
    chronologically. It is reachable three ways, because a key nothing names is a key nobody finds:
    the key row, the keys screen, and an **Order the list by** row in the options window beside the
    other stored settings.
  - **`w` swaps wrapping for horizontal panning** on the Diff face. Wrapping stays the default and
    nothing is ever truncated; on a wide patch, column alignment can be easier to read.
  - **The keys screen is built from your own keymap**, so a rebind shows there the moment you make it
    instead of the screen advertising a letter the runtime no longer dispatches.
  - **The mouse wheel scrolls the window under the pointer**, not the focused one, and focus follows.
  - **An empty pane says what to do next** — whether it is waiting for Claude or hiding rows behind a
    filter — rather than only that it is empty.
- **…and the eight the survey said were still missing.** Same catalogues (`awesome-tuis`,
  `awesome-ratatui`), same rule — grounded in what was already there rather than added twice.
  - **`x` marks a row, and `a`/`u` then act on every marked edit at once.** Reviewing is "read six
    files, then accept them together", which used to be six keeps and six confirmations. A file header
    marks every edit in its file, the same scope `a` on a header already had. Marked rows are drawn
    marked — a selection you cannot see is one you act on by accident — and `esc` clears them.
  - **A theme setting**, beside Colour and Glyph set. `default` is the palette this has always used;
    `colorblind` swaps the red/green verdict pair — the one most colour-blind readers cannot separate
    — for blue/orange; `mono` leaves the diff the only coloured thing on screen. An unknown name in a
    hand-edited prefs file falls back rather than blanking the UI.
  - **Marks.** `’` then a letter sets one on the selected edit, `` ` `` then that letter goes back.
    vim's `m` is taken here (it minimizes a window), so both of vim's *jump* keys take the work. A mark
    holds the EDIT ID, so a re-sort or a filter cannot leave one pointing at a different file.
  - **Find-in-diff MARKS its matches**, instead of only scrolling to them. The lines it marks are the
    rich diff's own output — banding plus a per-character intra-line pass — so the highlighter walks the
    escapes rather than the bytes: `38;5;71m` contains both "m" and "5", and a naive search marks them
    and splits the sequence, which renders as garbage rather than as a wrong colour.
  - **`^Z` suspends**, through the same terminal handover `e` already performs for `$EDITOR`, so the
    shell you land in is not drawing into our alternate buffer with echo off. `fg` brings it back.
  - **A file's path stays on screen while you scroll its edits**, and returning from `$EDITOR` says
    what moved while you were away.
  - **Right-click opens the row's verbs** — Keep, Undo, Mark, Copy, `$EDITOR` — each labelled with the
    key that already runs it, so the menu is a door rather than a second implementation. **`P` jumps to
    a file** rather than narrowing to it: the filter answers "show me only these", and a 546-file
    session needs "take me there" as well.
  - **Syntax colour on a diff's CONTEXT lines**, off by default. Added and removed lines keep the
    review colours — that is the signal, and a second colour language on the same row costs the reader
    the one that matters. It runs on the ~40 rows actually drawn rather than on the patch, which is
    what makes it affordable: **+0.04 ms per keystroke on a 4,000-line patch**, against 0.34 ms plain.

- **The terminal frame built every row eight times per keystroke.** `rowsFor` enumerates the whole
  session — 2,730 rows for the 546-file session this is sized against — and a pane draws about 43.
  That would be tolerable once; it was **eight times per frame**, because `paneVisible` and
  `paneRowCount` each need the list for every pane, on a frame that re-renders on every keystroke.

  It is memoised now, on what the function actually reads — the payload, screen, filter, sort, prompt
  scope, open folders, glyph set and width — and deliberately **not** on the cursor or the scroll,
  which is the point: moving the selection and scrolling are what a reader does continuously, and
  neither changes a single row. `now` is in the key bucketed to the second, because rows carry ages
  and a memo that ignored it would freeze every timestamp on screen. A full frame went **2.50 ms →
  0.49 ms**.

- **Marking a find's matches was quadratic in them.** The highlighter tested every match span against
  every character, so a one-character needle — an ordinary thing to type — cost 0.43 ms on a line with
  200 matches and 39.9 ms at 3,200, which at 45 drawn rows was about 19 ms of a single keystroke. A
  mask replaces the scan: **39.9 ms → 0.18 ms**, and a test asserts the SHAPE (4× the input must not
  cost ~16× the time) rather than a wall-clock threshold that would be flaky on shared CI.

- **JetBrains recomputed the file axis once per bar button per tick.** `log()` was cached but its
  derived views were not, so a filter, a distinct and a **sort** over every record in the session ran
  for each of the floating bar's fourteen actions, again for the status-bar nav bar, and again for the
  editor banner — three of which carried their own copy of the expression. It is derived once beside
  `pendingByFile`, on the same cache key as the log, and the three copies are now one call.

- **The terminal app is `tui`, and lives in its own package.** The verb is `claude-observatory tui`
  (the bare command still opens it), and `packages/tui` now holds the terminal's frame, layout, glyph
  sets, key decoder, options screen and runtime — moved out of `core` and `cli`. Nothing outside that
  package ever imported any of it. `packages/` now reads as what the product is: **core** (data),
  **cli** (the one backend every front end reads), then **tui**, **vscode** and **jetbrains** beside
  each other as the three front ends. No behaviour changed, and `dash` was never released, so the
  rename carries no alias.
- **Nav-bar parity, both directions.** PyCharm's floating review bar gained the **File axis** (‹›) it
  never had — it could step through one file's edits and never leave it — and VS Code's compact bar
  gained **Chat** and **Spotlight**, which JetBrains' bar has carried since it shipped. Each gap was
  invisible from inside the editor that had the feature; a test now asserts the compact bar's full
  verb set.
- **A session's transcript is now read once per process instead of once per derivation.** Every panel
  is built from the same few multi-megabyte transcripts, and each derivation — actions, todo
  snapshots, mined tasks, subagent metadata, background shells, prompt asks, insights — opened and
  split the file for itself. Measured on one cold `views changemap`: 5,458 whole-file reads over 2,085
  paths, 1,739 MiB delivered for 482 MiB of unique bytes (3.61x), with the five largest transcripts
  opened six to nine times each. A shared, stat-validated, byte-budgeted text layer underneath the
  existing per-derivation memo brings that to 2,158 reads and 485 MiB — **1.008x, every file read
  exactly once** — and takes the cold change map from 5.6 s to 4.6 s and the multi-agent view from
  5.7 s to 4.6 s. Peak memory goes *down* on both (780 -> 767 MiB, 755 -> 739 MiB): the transient
  decode garbage it stops producing outweighs the text it retains. Views that read a transcript once
  (Observations, Prompts) hold more resident in exchange for nothing, which is the cost of the budget
  being simple; the cap is 192 MiB of retained text, evicted least-recently-used, so it can never grow
  the way an uncapped cache would (unbounded measured 1,272 MiB). Every `views --json` payload is
  byte-for-byte unchanged. The VS Code extension — the one long-lived consumer — now drops the caches
  when you switch sessions and on deactivate, which is what the CLI's `warm` already did between
  sessions; over twelve sessions in-process that is 700 -> 525 MiB.
- **BREAKING (panel layout): VS Code's `claudeObservatory.actions` and `claudeObservatory.observations`
  views no longer exist, and neither does `claudeObservatory.prompts`.** The three were consolidated into a
  single `claudeObservatory.timeline` webview in the **Observatory Timeline** panel, whose tab strip
  carries Prompts · Observations · Actions — the shape JetBrains already had. VS Code remembers view
  placement per profile, so **anyone who had dragged those three views somewhere will get a reset panel
  layout once**: the Timeline reappears in the Observatory Timeline panel and has to be dragged where you
  want it again. Nothing else is lost — every row, action and payload is unchanged, and the palette
  commands **Show the Timeline: Prompts / Actions / Observations** open the window on the tab they name.
- **JetBrains: the Timeline's session selector moved out of the tool-window title bar into the window
  content**, on its own row above the tabs, beside the line "Every tab below reads this session." A title
  action is drawn by the platform in a strip the reader does not associate with the window's contents; the
  session these tabs read is part of the contents.

### Fixed
- **Three raw NUL bytes were committed into `store.ts`.** `grep` and `ripgrep` classify a file with a
  NUL as binary, so the module defining `readLog`, `appendLog` and `EditRecord` returned **zero hits**
  for every one of them — 47 real occurrences invisible to any search. `git diff` did not show it
  either: git only scans the first ~8000 bytes for NUL, and the first one sat at byte 42,758. This is
  a recurrence of a scar `ignore.ts` already documents; the separator is now written as an escape.
- **A `.observatoryignore` created BELOW the directory a command ran in never took effect on existing
  records.** The sweep's stamp covered only the directory the hook was invoked from, while the Bash
  walk records at any depth beneath it — so the rule refused new captures immediately while the
  records it covered stayed forever, with nothing that could move the stamp. The walk now reports the
  directories it actually wrote into.
- **`e` ignored the editor you chose.** `openInEditor` read only `$VISUAL`/`$EDITOR`, so the options
  window's editor row was decorative: you could pick one, it persisted, and `e` still answered "no
  $EDITOR set". The preference now wins, and the message points at the options window first.
- **Moving the store destroyed every other setting.** `prefs.json` lives inside the default store
  directory, so a move renamed the preferences away with it and the write that recorded the new
  location left a file holding only the location. Reproduced: one configured machine went in, and
  `remotes` reported none afterwards. The file is now carried across explicitly.
- **JetBrains pinned a remote session from two of its three pickers.** The refusal existed only in the
  Overview's Sessions tab; the Timeline popup and "All sessions…" routed straight past it, persisting
  a pin to a session whose store is on another machine — and an unreachable host's synthetic row could
  be pinned at all, whose id throws inside `storeDir`. One shared guard now covers all three.
- **The machine highlight painted nothing in VS Code's Sessions tab.** Its `.mt-smc` colour rules were
  declared in the Timeline webview's stylesheet while only the Overview's script emits that class —
  two documents, two `<style>` blocks. A smoke assertion now fails if a class a webview emits has no
  rule in its own shell.
- **Removing the last configured machine left its sessions in both selectors.** VS Code returned early
  on an empty remote list rather than posting it, and the terminal's refetch was gated on there being
  at least one machine — so rows for a machine `prefs.json` no longer contains stayed listed,
  clickable, and refused on click.
- **"Pending" meant two different numbers.** The VS Code status bar and activity-bar badge counted raw
  records while the Overview, the Sessions rows and the Stats scoreboard counted collapsed review
  units: one session read 3,067 in one place and 2,052 two panels away. `keep`/`undo` resolve a whole
  same-code group, so the display units are the number of decisions — every surface counts those now.
- **JetBrains reported "no machines configured" when the CLI could not answer.** `prefs.json` is
  written by the VS Code extension and the terminal app, neither of which needs the CLI on PATH.

### Changed
- **The terminal's Traces pane groups by file**, matching the editors' trees: one header carrying the
  path and its edit and pending counts, with the file's edits nested beneath it. Every edit used to
  print its own full path, so a file touched a dozen times produced a dozen identical headers.
- **The options window shows WHERE the data is kept, and can move it** — the resolved store root on
  its own always-visible line, `enter` to move it, blank to restore the default. Same in both editors
  and as `claude-observatory store [--move <dir>|--default]`. The move takes the existing sessions.
- **Workflow agent rows show the reasoning effort** beside the model, in both editors. An agent that
  never declared one shows nothing rather than a guessed default.
- **Adding a machine to browse sessions on worked in exactly one of the three front ends.**
  `prefs.remotes` was editable only from the terminal app's options window — a feature the VS
  Code selector and the JetBrains popup both RENDER, and neither could change. There is now a
  `remotes` verb (`--add`, `--remove`, `--enable`, `--disable`, `--json`) and a **Machines…** entry
  in both editors' session pickers, all three driving the same validator. Parsing and validation moved
  into one exported function because both fields are interpolated into a shell that runs on *another*
  computer, and a second copy of that guard is a second chance to get it wrong.
- **A `configDir` that could smuggle a command onto the remote was stored and then silently dropped.**
  It was validated on READ, which kept it out of the shell but meant the reader configured a path and
  the tool quietly used a different one. It is now refused where it is entered, with the reason.
- **The session pickers named the machine but did not highlight it.** It rendered in the same grey as
  every column beside it. A remote now carries the palette's `egress` purple — the hue the ⇅ chip
  already uses for "off this machine" — an unreachable host red, and the bridge a muted grey, so a
  session you cannot review from here is obvious before you pick it. All three front ends.
- **The recorded terminal demo was not the terminal.** It contained exactly one saturated colour, and
  none of the product's eight palette colours — measured from the GIF's own colour table. The recorder
  asked for `color: true`, which resolves to 256-colour depth, and its ANSI→HTML step understood only
  the eight basic SGR codes, so every `38;5;N` became an empty span. It now records at truecolor and
  reads `38;2;R;G;B`, carrying the product's own palette verbatim rather than an approximation.
- **A Bash command run from your home directory snapshotted the whole home directory.** The Bash
  capture infers edits by diffing the tree under `cwd` before and after the command, which is right
  for a project directory and wrong for `$HOME`: one real session (`install neovim`, run from `~`)
  recorded **2,445 Bash "edits"** — `.Xauthority`, `.CFUserTextEncoding`, `.bash_history`, shell
  state, a whole postgres data directory — against **one** real Write. None were changes the agent
  made. `$HOME` and the filesystem root are now refused outright, with a marker saying so rather than
  silence, and the stale manifest is cleared so the next command cannot diff against it.
- **Zero-byte files created by a Bash command were recorded as edits with nothing in them.** In that
  same session **2,241 of 2,446 records** had an empty snapshot and rendered as `+0 −0` with no diff
  behind them — 91.6% of the review list was rows with nothing to review. A file that appears or
  vanishes at zero bytes during a Bash command is now counted and reported, not recorded. A zero-byte
  file Claude writes *deliberately* is still a real edit; only the tree walk's inferred side effects
  are filtered.
- **The inline review bar's two collapse controls did the same thing.** `^` (the platform's own
  chevron) now steps the bubble **down to the review bar**, and `−` **dismisses** the surface and
  keeps it dismissed until the review moves to another edit. The Comment API raises no event for a
  collapse, but the workbench does push the state back to the extension host, so the value is polled
  on the refresh that already runs.
- **`esc` in the terminal app had no way back to the change map.** It now unselects as its last
  step, which returns the centre window to the map — the view the dashboard opens on — and says so.
- **The editor setting was free text only.** The options window now offers the editors actually
  present on this machine, each with its wait flag (`code -w`, not `code`, which returns the moment
  the window opens and lets the dashboard repaint over it). `←→` steps the list, `enter` still types
  any command, and nothing is offered whose binary is absent.
- **No session picker said which machine a session was on.** All three now do, in their own column —
  the terminal, the VS Code selector and Sessions tab, and the JetBrains popup and Sessions tab. The
  remote's name previously rode on the front of the workspace label and was truncated to fit, which
  answers the question no better than not asking it.
- **A view that failed inside `views` rendered as a zero with the status bar reading "ready".** An
  unreadable store and a session that changed nothing produced byte-identical frames; the payload now
  carries which views failed and why, and the dashboard raises it.
- **Folder Keep/Undo dropped conflicts and refusals in both editors** — an undo that refused every
  edit reported "undid 0 edit(s)" in VS Code and "No pending edits to reject" in JetBrains.
- **The remote shell fallback never worked.** `sh` cannot expand a quoted `~`, so every host without
  python3 reported "reachable, no sessions"; nothing had ever run the script. An ssh timeout reported
  "ssh exited ?", and a login banner made a healthy host look empty.
- **Both editors pinned a remote session silently**, persisting a choice that blanks every panel and
  then explains the emptiness wrongly; an unreachable host's row could be pinned at all, and its id
  throws inside `storeDir`.
- **Change-map keys resolved rows at a hard-coded 100 columns** while the pane drew at its own width,
  so Enter folded a different folder than the highlighted one and wrapped rows were unreachable.
- **A `$EDITOR` that fails to launch reported "back from <editor>"** — the error was written where the
  next refresh clears it.
- **A `.observatoryignore` that exists but cannot be read was treated as absent**, so a whole rule set
  silently stopped applying. It is now named, with the consequence stated — and under one mode this
  fails in the safe direction: more is captured, not less.

- **The Observations flag cache held every edit's added text, and re-scanned it on every call.** The
  memo is keyed on the blob pair, which is immutable, so the answer could never change — but what it
  stored was the raw text, and both callers re-ran their regexes over all of it each time. On a
  7,922-record session that was **803 MB retained inside the editor's extension host**, and a fully
  warm pass still cost 2.1 s. It now caches the verdicts instead: the same session holds 13.5 MB and a
  warm pass takes 1.2 ms. (The two TODO patterns are deliberately kept as separate flags — the flag
  matches `TODO|FIXME|XXX|HACK` and the follow-up step only `TODO|FIXME`, and collapsing them would
  have invented 38 follow-ups on one real session.)

- **A surface that shows one row could resolve only half of it.** What the review surfaces display as
  a single edit is often several raw records — a same-code chain collapses into one unit labelled with
  the most recent member's id. The `--ids` verbs are group-unaware by design, so sending that
  displayed id kept or reverted one member and left the rest pending, in an intermediate state no view
  can name. Measured on a real session, 365 raw records collapse to 323 units with 35 of them
  multi-member, so roughly one row in ten was affected. Ids are now expanded to their whole review
  group at the mutation site, using the same rule the single-id verbs already followed.

- **The compact review bar's dismiss button rendered as a trash can.** VS Code appends its own
  "Collapse" action to a comment thread's header and picks the glyph from whether the thread has any
  comments — chevron if it does, **trash can if it does not** — and the bar is a comment-less thread by
  design, which is what keeps it to three editor lines. The action only ever collapses; it deletes
  nothing. But it sat beside buttons that genuinely revert code, where a bin reads as "discard my
  changes" — the one meaning these controls must never carry, and a rule this project already pinned
  for the sibling review bubble.

  The extension cannot suppress or restyle a platform-appended action, but that icon is chosen **once,
  per widget, and never revisited** — `updateCommentThread` re-reads the label and nothing else. So the
  bar is now *constructed* with one throwaway comment, which is what the header reads when it picks the
  glyph, and emptied immediately afterwards, keeping its three-line height. The order is not a race:
  the initial comments travel inside the `$createCommentThread` call itself, while every later change
  is a separate update, so the editor sees a non-empty create and an empty update, in that order. Both
  halves are asserted, because dropping either one silently brings the bin back — the first returns the
  bin, the second leaves a permanent empty box two editor lines tall. No trash-can glyph is used
  anywhere in the product; `Reclaim disk` in the store-cleanup menu now uses the same `clear-all` icon
  as Clear Resolved.

- **The review surfaces had two collapse controls, and now have one axis.** The bar carried our own
  **−** *beside* the platform's **^**, both of which hid it — one button's worth of meaning drawn twice.
  It could not be fixed by moving ours somewhere else: VS Code appends its own collapse action after
  every contributed one and gives an extension no way to suppress or restyle it, so any "hide" button
  we ship always renders next to the platform's.

  So ours is gone entirely — `claudeObservatory.peekCollapse` is removed, along with the `dismiss()` it
  called — and **Details** became the surface's one contributed control: **⌄**, the platform's chevron
  rotated 180°, and retitled **Expand to the review bubble**. The two glyphs now read as a single axis:
  **⌄** goes up a surface (bar → bubble) and **^** goes down (bubble → bar, then bar → hidden). The
  chevron is deliberately not `$(arrow-down)`, which is the Diff stepper's tailed arrow two buttons
  along; the test pins both so they cannot converge.

  …and **^** on the bubble now actually steps down, which it did not. Two separate faults, either of
  which alone made it look like a hide button. The Comment API raises no event for a collapse, so the
  state is polled — and the only thing calling that poll ran on store changes and tab switches, so on
  a session with nothing writing (a finished review is exactly that) the click produced no refresh, no
  poll, and a bubble that simply stayed collapsed. The surface watches its own state while it is on
  screen now. Separately, the dismissal guard was checked BEFORE the collapse, and dismissing the
  **bar** at an edit left that flag standing — so from then on **^** on the bubble at that same edit
  returned early and did nothing for the rest of the session. A collapse the reader just performed
  outranks a dismissal from earlier, and an explicit re-open clears the flag. Both halves are driven by
  tests, one of which deliberately does NOT refresh, because the existing test hand-delivered the very
  tick whose absence was the bug.

- **The version stamper had never heard of `packages/tui`.** It was a declared workspace absent from
  the stamper's package list, its core-pin list and its lockfile keys — so `node scripts/version.mjs
  <v>` moved every other package and left tui behind, pinned to a `@claude-observatory/core` build
  that no longer existed. `version:check` reported "all versions consistent" throughout, because it
  only compares the files it already knows about. The failure surfaces two steps later: the dev
  pre-release workflow stamps and then runs `npm ci`, which resolves that stale pin from the registry,
  where core has never been published, and 404s. A test now asserts the stamper covers every entry in
  the root `workspaces` list — by list, not by naming tui, because the next package added would have
  had exactly the same problem.

- **The "adds a debug statement" flag could never see Rust's `dbg!`, or a no-argument `print()`.** One
  trailing word-boundary applied to every branch of the pattern, and `!` and `(` are not word
  characters — so a boundary after them required a word character to follow. `dbg!` is always written
  `dbg!(…)`, which meant that branch never matched in any form. Boundaries now sit only on the
  branches that end in a word character, so `debuggerish` and `sprint(` are still correctly ignored.

- **`observe --json` built the entire Observations view model to read one string.** The recap is now
  read through a dedicated core accessor, so the per-edit reasoning, flag and file-memory walk no
  longer runs just to produce a recap line. Core still owns the single definition, so the surfaces
  cannot drift.

- **`fileMemory` revalidated its cross-session index on every call.** The index is memoized, but
  proving the memo valid costs a readdir, an `existsSync` per session and a `statSync` per session
  log. Per file that is invisible; Observations asks about every file a session touched, and at 3,957
  files against a 47-session store it measured **383,830 stat calls** to revalidate an index that had
  not changed. A new `fileMemories(files)` builds it once — 97 stats for the same work. Together these
  three take `observe --json` on that session from 5.9 s to 2.6 s.

- **Published screenshots showed a change bar the product does not draw.** `layout.png` — the README's
  lead image — plus `inline-review.png` and `spotlight.png` drew the change bar in the brand's coral;
  VS Code has always drawn it green. `pyc-layout.png` drew one at all, and the JetBrains plugin draws
  no bar whatsoever (its added-line highlighter carries a background only), so that element is gone
  rather than recoloured. `layout.png` also showed a summary line the product cannot produce — the
  prompt's full text inlined where the product shows only `#1`, and missing the `N edits` term it
  always emits. An orphaned mockup that invented a `Prompt 2/6` counter was deleted along with the
  images nothing referenced.

## [0.9.2] — 2026-07-30

<!-- Written from the tag: v0.9.2 was cut while these entries still sat under "Unreleased", so the
     released changelog had no section naming the version it shipped. Recovered here from
     `git show v0.9.2:CHANGELOG.md` rather than rewritten, so the notes are the ones that shipped. -->

### Added
- **The review bar comes into the editor, in both editors.** In JetBrains IDEs a **floating toolbar** now
  sits over the editor while the open file has edits awaiting review — Keep, Undo, Chat, View diff, the
  `Diff n/m` counter and its steppers, Accept / Reject File, Spotlight, Clear Resolved — drawn on the
  platform's own `editorFloatingToolbarProvider` layer. VS Code gets a **compact floating review bar**
  carrying Keep · Undo · edit steppers · file steppers · Diff · Details under a live title
  (`✦ Claude edit #12 · +8 −3 · Diff 2/5 · File 1/3`). It auto-shows while the active file has edits
  awaiting review and never steals focus.

  The API limitation people ask about is unchanged and worth stating plainly: **VS Code exposes no
  floating-widget API to extensions** — the Copilot-style bar is drawn by the workbench itself, on the same
  private layer as the Find widget ([microsoft/vscode#139374](https://github.com/microsoft/vscode/issues/139374)) —
  so a comment thread is still the only interactive surface an extension can float over code. What is new
  is that the extension now gives that surface a **bar** form: a thread with no body, which collapses to
  its header row. It is not an overlay widget and does not pretend to be one; it is the same `EditPeek`
  thread as the review bubble in a second mode, so the two can never be on screen at once.
- **`claudeObservatory.editorReviewSurface` — one setting name in both editors.** VS Code takes
  `floating` (the default — the bar), `bubble` (the full review bubble: Claude's reasoning and the diff in
  git's colors, roughly 15–25 lines tall), or `none`. JetBrains takes `floating` (also the default),
  `banner`, `both`, or `none`. `floating` and `none` are deliberately spelled the same and mean the same
  thing in each; only the surface that genuinely exists in one editor and not the other gets a word of its
  own. An unrecognized value reads as `floating` in both, rather than silently stripping every review
  control out of the editor. **Details** and the platform's **^** swap VS Code's two surfaces at any
  time, and **Show the review bar at this edit** opens the bar on demand even under `none`.
- **The inline lens row was shortened** to what a lens can actually carry. In VS Code it now reads
  `🔬 #12  +8 −3 · 2/5 │ ✓ Keep │ ↩ Undo │ 💬 Chat │ ⧉ Diff │ ⋯ Details`; in JetBrains
  `✦ #12  +8 −3 · edit 2/5 in file · file 1/3  view changes  ✓ Keep  ↩ Undo  ❝ Chat  ⧉ View diff`. A lens
  row can carry no background, no color of its own and no size, so everything that has to be legible —
  the File axis, the reasoning, the diff — moved to the bar and the bubble, where the font is the
  workbench font rather than the lens's dim grey.
- **Group tabs, beside both tab strips, in both editors.** A toggle beside the Overview's and the
  Timeline's tab strips replaces the tabs with side-by-side columns: Prompts · Observations · Actions in
  the Timeline, and in the Overview **Sessions · Fleet** and **Workflows · Tasks · Processes** — which
  conversation and who is working in it, then what the work is doing. Off by default, remembered per
  window.
- **Grouped columns are resizable and collapsible.** Dragging the divider between two columns trades
  width; double-clicking it resets that pair. Each column folds away to a narrow **rail** that keeps its
  name and its badge, turned sideways, and the rail is itself the button that brings the column back at
  the width you set. The last expanded column will not fold — a group with every column folded is an empty
  pane whose only way out is the rail the reader just lost track of — and below the width two columns need
  to stay legible they stack rather than shrink.
- **Resolving an edit carries you to the next one.** Keeping or reverting a *single* edit opens the next
  edit still awaiting review, crossing into another file when that is where it is
  (`claudeObservatory.revealNextOnResolve` in VS Code; in JetBrains the settings checkbox "After keeping or
  reverting one edit, open the next edit still awaiting review" — on by default in both). Bulk
  actions and redo never move you — they have no single "next" — and neither do the diff editor's own
  buttons, since a diff is something you opened deliberately to read.
- **Pending badges on files, in both editors.** A file with edits awaiting review carries the count in the
  editor's project tree in both editors, and on the editor tab in VS Code. JetBrains has shown the tree badge
  since 0.8.x; in VS Code the decoration
  only ever applied to the observatory's own tree rows, so the guided tour's "a badge in the editor's own
  project tree" step is true in both editors for the first time.
- **Rewind to before a prompt** (`undo --from-prompt <id>`, plus the Prompt axis's Rewind action in both
  editors). Reverts every unreviewed edit from one ask **onward**, not just the edits that ask produced —
  the difference between undoing a prompt and undoing the state it created, since rejecting a middle
  prompt reverts a base that later edits were built on. The **Redo** offered beside a rewind's result
  restores exactly the ids that rewind moved. The CLI's `redo --from-prompt <id>` is the wider verb — it
  re-applies every undone edit from that ask onward, including any rejected before the rewind — because a
  prompt id can only name the whole window; pass a rewind's `ids` to `redo --ids` for the button's scope.
  The confirmation names two counts, because they genuinely differ: same-code edits collapse
  into one review unit for reading, but reverting acts on the underlying records, and a unit straddling the
  boundary is reverted whole rather than left half-applied.
- **A session selector leading the Timeline window**, above the tabs, listing the sessions still active in
  the workspace, so moving between two live conversations is one click. Picking one switches the whole
  observatory, not just the Timeline — there is one reviewed session at a time and every panel agrees on
  it. Its last row, **All sessions…**, hands over to that editor's full list: the Overview's Sessions tab
  in VS Code, and the plugin's existing every-session popup chooser in JetBrains, which the selector falls
  through to rather than growing a second browser of its own. In VS Code the same short list is also a
  command, **Switch to an active session** (`claudeObservatory.switchActiveSession`), alongside **Show all
  sessions** (`claudeObservatory.showSessions`), which reveals that Sessions tab.
- **One prompt selection, shared by every surface.** Picking an ask on the nav bar's Prompt axis — or via
  Review prompt, or Rewind — now selects it in the Prompts list and scrolls it into view, and picking one
  in the list moves the axis. Before, the two could disagree about which ask was current.
- **JetBrains renders removed lines as ghost text, and the `+A −R` churn in its lens** — two parity gaps
  where the shared `locate` payload had been carrying data the plugin never read. A pure deletion is now
  navigable there too.
- `undo`/`redo` scope `--json` now report **`ids`** (which edits actually moved, so a caller can offer a
  precise Redo instead of a blanket one), and `task-undo --json` reports `errors`/`firstError` like every
  other path — one core result, one JSON shape. `locate --json` placements carry a **`delta`** for the
  placements that render, sparing a renderer a second round trip for the lens's churn.
- `undo --from-prompt <id> --dry-run --json` counts a rewind (`pending`, `units`, `files`) **without
  touching disk**, so a confirmation can name what it is about to rewrite. It exists for parity rather than
  convenience: every other exposure of that scope performs the revert, so an editor that shells out could
  not otherwise state the numbers before the user commits — one editor would show them and the other
  would not. Both now state the same three numbers at the point of commitment.

- **The Observations feed states a bound instead of rendering a whole session.** Moving Observations and
  Actions out of VS Code's native tree views lost the platform's virtualization — every row was serialized
  and re-rendered on each refresh, measured at 237–258 ms per refresh on a 3,000-edit session and paid again
  on every Keep. The feed now serves the most recent edits and names the total (`showing 300 of 3,007
  edits`), which is 60–68 ms; the recap, context and next-step rows are never truncated, and the badge still
  counts every edit.

### Changed
- **BREAKING (panel layout): VS Code's `claudeObservatory.actions` and `claudeObservatory.observations`
  views no longer exist, and neither does `claudeObservatory.prompts`.** The three were consolidated into a
  single `claudeObservatory.timeline` webview in the **Observatory Timeline** panel, whose tab strip
  carries Prompts · Observations · Actions — the shape JetBrains already had. VS Code remembers view
  placement per profile, so **anyone who had dragged those three views somewhere will get a reset panel
  layout once**: the Timeline reappears in the Observatory Timeline panel and has to be dragged where you
  want it again. Nothing else is lost — every row, action and payload is unchanged, and the palette
  commands **Show the Timeline: Prompts / Actions / Observations** open the window on the tab they name.
- **JetBrains: the Timeline's session selector moved out of the tool-window title bar into the window
  content**, on its own row above the tabs, beside the line "Every tab below reads this session." A title
  action is drawn by the platform in a strip the reader does not associate with the window's contents; the
  session these tabs read is part of the contents.
- **JetBrains: the Timeline is one tool-window content instead of three**, and its tab order is now
  Prompts · Observations · Actions.
- **JetBrains: the floating review bar replaces the editor notification banner by default.** The banner
  and the bar over the same file is the one thing worse than neither; `editorReviewSurface` chooses the
  bar, the banner, both, or neither, and the old behaviour is `banner`.
- **`claudeObservatory.pinnedPeek` now governs the review bubble only.** VS Code's bar is a navigation bar
  and therefore always follows — a nav bar that vanished the moment you used it would be useless — so
  pinning is a question only the bubble has to answer. JetBrains' floating bar follows on
  `revealNextOnResolve` like every other JetBrains surface, so turning that off leaves it in place.
- `⌥⌘,` and `⌥⌘.` (freed when the Chapter axis went in 0.8.8) stay free. Nothing added here is a
  high-frequency keyboard operation — pinning is a mode toggle, rewinding is destructive and confirmed, the
  session selector is a pointer surface — and following-on-resolve reduces the pressure on the review keys
  rather than adding a new one.

### Fixed
- **`clean --all --dry-run` deleted every session in the store and reported success.** `--dry-run` is real
  on `clean --completed`, which is exactly why a reader tries it on a sibling scope; on every other scope
  `clean` dropped the flag on the floor and performed the deletion it had been asked to describe. The same
  guard this release gave `keep`, `undo` and `redo` now covers `clean`, permitting `--dry-run` only on
  `--completed` and refusing it elsewhere with the two scopes that preview named in the message. Present
  since `--dry-run` was introduced in 0.9.0.
- **VS Code: a webview button whose host branch was never written.** The Overview's new Prompt-axis Rewind
  button posted a message the host had no case for, so it did nothing at all — found by writing the test
  that now guards it, not by using it. Worth recording because the class of bug is invisible by
  construction: the webview cannot know whether anything is listening, so an unhandled message is silence
  rather than an error.

- **Windows: `update` never updated the editor extension, and said the wrong thing about why**
  ([#45](https://github.com/cell-observatory/claude-observatory/issues/45)). Reported as a Node
  deprecation warning in the failure toast; the warning was not the bug, it was what got displayed
  *instead* of the bug. Three separate defects, all in how child processes were spawned:
  - `code --install-extension` (and the 0.8.6 publisher cleanup) were spawned **without a shell**, so
    on Windows they could never run at all: libuv only extension-searches `.com`/`.exe`, and Node
    refuses to launch a `.cmd`/`.bat` without one. The extension half of `update` had therefore never
    worked on Windows. The same omission made **Setup check (doctor)** from the VS Code palette always
    report "is the claude-observatory CLI installed?", and **Start Demo Mode** always warn "the CLI is
    not on PATH" — both on perfectly good installs.
  - `shell: true` with an args array concatenates the arguments **unquoted**, so `--root C:\Users\First
    Last\repo` arrived as two arguments and the **Overview, Prompts and Stats panels silently returned
    nothing** for anyone whose workspace path contains a space. Nobody had reported this; nothing
    surfaces it.
  - The failure message preferred `stderr` over `stdout`, and the CLI wrote its reason to stdout while
    stderr held only the deprecation warning. Now `core.cliFailureMessage` drops runtime warning noise,
    prefers the real reason, and falls back to the *tail* of stdout rather than the head of a progress
    log — mirrored in the JetBrains plugin so both editors behave the same.

  Every child process in the project now goes through one launcher
  (`packages/core/src/spawn.ts`) that builds a single quoted command string for `cmd.exe` instead of
  passing an args array alongside `shell: true` — which is both the DEP0190 deprecation and the
  unquoted-concatenation bug. A test walks the source tree and fails if any file reaches
  `child_process` directly. `node 24` joined the CI matrix because DEP0190 is not a runtime warning on
  20 or 22, so no existing lane could have caught this.
- **Windows: the bundled status line was invisible to `update`, and `uninstall --all` orphaned it.**
  The installer is bash, so it wrote `bash /c/Users/…/statusline.sh`; detection compared that against a
  native `C:\Users\…\statusline.sh`, which never matches. `update` silently never refreshed the status
  line, and `uninstall --all` deleted the script while leaving `settings.json` pointing at it, so Claude
  Code errored on every render. Drive prefixes are now folded for Git Bash, WSL and Cygwin, and the
  script is only removed once nothing references it. The installer also **quotes** the path it writes —
  unquoted, any config dir containing a space (every Windows box with a spaced username) produced a
  command Claude Code ran as `bash` with two arguments, on every platform.

### Added
- **`claude-observatory install-extensions`** — installs the editor extensions into whatever editors are
  on the machine (VS Code family and/or JetBrains), the counterpart to `update`, which refreshes only
  what is already installed. `--check [--json]` reports without installing;
  `--vsix`/`--jetbrains-zip` install local build outputs with no network; `--channel stable|dev` picks
  and persists the release channel.
- **A native Windows installer, `install.ps1`** — `irm …/install.ps1 | iex`. There was no bash-free
  install path before: piping the bash one-liner into PowerShell fails, or with WSL present silently
  installs everything *inside* WSL where Claude Code cannot see it. It verifies the CLI tarball's
  sha256 before npm runs install scripts, and is explicit that the bundled status line still needs
  Git Bash + `jq`.
- **Channel choice at install time.** `scripts/bootstrap.sh --channel stable|dev` and
  `install.ps1 -Channel dev`; the choice is persisted, so later updates follow it.

### Changed
- **Every installer now delegates to the CLI.** `scripts/bootstrap.sh` previously curled the `.vsix`
  itself with no integrity check and, for JetBrains, only downloaded the zip and printed
  "Settings → Plugins → Install Plugin from Disk" — so the one-command installer never actually
  installed the JetBrains plugin. `install.sh` ignored JetBrains entirely (it now takes `--jetbrains`),
  and `scripts/install-jetbrains.sh` reimplemented IDE detection in bash around `unzip`, which only
  worked from Git Bash on Windows. All of it is one `install-extensions` call now, which also means the
  release assets get the sha256 verification the bash downloads never had.
- **`npm run build:vscode` builds core first.** The extension bundles core from `core/dist`, so editing
  the launcher and running the natural rebuild shipped the previous one, silently.

## [0.9.1] — 2026-07-29

### Fixed
- **The version chip's Update now stays in the menu.** It only rendered when the followed channel had
  something newer — so the moment you were up to date, the update button you'd been told about was
  simply missing, and a menu whose main action comes and goes reads as broken. It is always present
  now: with an update available it reads "Update now — vX" (dot on the chip, restart/reload pop-up
  after installing); current, it reads "up to date" and stays clickable — a safe no-op that reports
  up to date, re-checks the release feed, and never offers a restart. And "up to date" is only
  claimed when the release feed actually answered — with no data (offline, first paint) the row
  stays but claims nothing. Both editors. (This release uses the hotfix path: cherry-picked onto
  `main` from `dev` and tagged `v0.9.1`, while the same fix rolls on the pre-release channel — see
  CONTRIBUTING's "Hotfixes".)

### Changed
- **The site's interactive demo moved to the homepage and caught up with the product.** The full
  step-by-step demo now lives on the front page (the old demo page redirects), replacing the smaller
  autoplay film, and its mock finally matches today's layout: the Observatory Traces
  sidebar, the editor, and the Claude session with the Observatory Timeline share the top row, the
  Overview carries the product's two-row review bar (axes, session bulk actions, and the version
  chip) over a fleet showing parallel agents and a workflow run with its tasks, the Stats pane leads
  with Edits and Session tokens, and the
  **Observatory Dashboards** dock below holds the Overview and Stats. The feature tour reads
  navigation → title → text → image, every page shares one navigation bar (Install always lands on
  the homepage's install section, the reference page is labeled **Docs**, the current page is
  highlighted), the current release number is shown live in the brand and footer chips, and the
  Releases page links the full changelog.

## [0.9.0] — 2026-07-28

**The Overview's cache almost never hit.** Opening an older session and watching it take twelve seconds
to draw, every few seconds, was not the cache being cold — it was the cache being thrown away on nearly
every tick. Measured on a real 4.6 MB / 2,800-edit / 405-file session in a repo with 31 sibling sessions:
a cache hit served the whole Overview in **0.12 s**, and a miss cost **14.25 s** and rewrote **33 cache
files across 31 session directories**. Almost every refresh was a miss.

The cause was one line of the cache stamp. Everything a change map derives from the project directory is
`summary.fleet` — a *count of sibling session ids* — but the stamp carried `mtime:size` for every file in
that directory. Since every session in a project shares that directory, **one session appending a single
line invalidated every other session's cached map**, and both editors refresh on the transcript watcher,
so the thing that triggered the refresh was the same thing that guaranteed it would miss. The stamp is now
the id list itself, taken from the same call the map derives the value from so the two cannot drift apart.
A refresh taken while another session is actively appending went from **16.0 s to 2.4 s**, and from
rewriting **32 cache files to 1** — that one being the appending session's own map, which genuinely has to
rebuild. With nothing appending the same refresh costs 1.9 s and rewrites nothing. (These figures come
from an independent re-measurement against a frozen clone of the store, which put the before-case at
16.0–16.5 s rather than the 14.25 s first recorded here: the improvement is larger than first claimed, and
"rewrites nothing" was only ever true of the idle case.)

**Edit placement is memoized on disk.** Profiling what remained showed 75 % of `buildEditTree` was the
Myers diff inside `locateEditsInCurrent` — 1.74 s of 2.27 s — against 22 ms of actually reading those 405
files. That result was already memoized per file, keyed on the current file text's hash and the edit
chain's blob SHAs, but only within one process, and the Overview runs in a fresh CLI process every tick.
The memo now has a disk tier. Because every input is content-identified there is no staleness window: a
changed file is simply a different key, so saving one file re-diffs one file where the map's own cache
would discard all 405. **`buildEditTree` in a fresh process: 2.27 s → 0.28 s**, byte-identical output. A
placement computed from a blob that could not be read is deliberately never persisted.

**Sessions quiet for over a week are folded.** The Overview built a full change map for every sibling
session in the repo, without bound — 24 of the 33 here were more than a week old, finished conversations
nobody was looking at. Those now collapse into one group in both editors and are served from the cache
when it is already warm, never rebuilt on the critical path. The session you are *viewing* is never
folded, however old it is; pinning an old session is precisely the case for building it. A folded row with
no cached map reports **not loaded** rather than `+0 −0`, because "nothing was built" and "this session
changed nothing" are different facts with identical numbers. **Cold Overview 15.9 s → 9.1 s.**

Note what that buys and what it costs: the cold saving comes from *not computing* 24 of the 31 rows, and
nothing on the refresh path ever builds them afterwards. On a store whose cache was never warm those rows
stay **not loaded** until you open one of those sessions (or run a CLI verb that walks them all, such as
`tasklog`). Showing them costs about 0.5 s a tick, which is the trade the fold exists to let you decline.

**Clear completed sessions.** `clean --completed`, and a *Clear completed sessions…* entry in both
editors' Clean Store chooser, drop the stored edits and blobs of sessions whose review is finished.
Refusal rails guard it, each with its own fixture in one test: never the session you are in, never one
whose conversation moved in the last 24 hours, never one with a capture in flight — and one with pending
edits only once its conversation has been dead past the stale window (14 days by default, `--stale` ≥24h),
in which case those unreviewed edits are DISCARDED and every confirm dialog leads with that count — plus a fifth, added after review found it missing: never a session recorded for a DIFFERENT
workspace. (Session resolution walks up to the filesystem root, so a session launched in `~` or a monorepo
root resolves from any subdirectory of it; listing such a session is right, deleting it is not.) Files on
disk are never touched.

**A sweep for the same bug elsewhere.** The cause above — an expensive derivation reached through the
wrong door — was not unique to the Overview, so every caller of the raw change-map builder was audited and
every read-only command was timed against the same real session. Five call sites were bypassing the disk
cache entirely: the cross-agent task log rebuilt *every* worktree sibling's map from scratch on each run
(**`tasklog` 12.42 s → 0.11 s**), the task feed rebuilt the whole map to look up one task's interval — under
a comment claiming it reused what the Overview had already built — and three more, two of which run
**in-process on the VS Code extension host**, which is precisely where a raw build was previously measured
freezing the UI for 2.8 s. All five now read the cache.

Separately, `fileMemory` walked every session's entire log once *per file*, so a caller asking about a
session's 405 files paid 405 × 40 log scans — and it got slower with every session ever recorded, because
the scan is over the store rather than the session. It now builds one file-keyed index per pass:
**6.6x faster per file** and `insights` **~4x faster**, with byte-identical output verified file by file
against the previous implementation. (Absolute per-file figures vary with store size and disk state: this
machine measured 4.7 ms → 1.13 ms, an independent run on a frozen clone 10.69 ms → 1.63 ms.)

**Session rows carry the fleet's badges.** A session row said its name, its edit counts and how long ago
it ran; a fleet row said what it changed, what it cost and what it ran on. They are now the same row:
lines added/removed, pending, tokens, wall-clock, and a model · effort chip, keeping the last-active
time and the "reviewing" mark. Bare edit and file counts were tried and dropped: the ± lines beside them
already say how much a session changed, and two more numbers in the same row read as noise. A session
that changed nothing shows no diff at all rather than `+0 −0`, but still shows its tokens — asking and
reading is work the row should own. Model and effort are structural facts the harness records — an
unknown one is left out rather than defaulted, because the default effort differs by build and model.

Line deltas cost two content-blob reads per edit, which is the one thing the session listing was built to
avoid. Caching the total alone was not enough — a live log grows constantly, so the whole-log sum re-paid
**+0.17 s per refresh at 1,732 edits and +0.71 s at 7,914**, worse the longer a session ran. The sum is
now recomputed in full every time but from a cache keyed by each edit's **blob pair**, which costs 0.08 s
on that same 7,914-edit session. A running total was tried first and rejected: see below.

**A tab badge counts the pane it labels, or says nothing.** Picking a sibling agent in Fleet left Tasks
and Workflows counting the session under review — a different session's numbers under a pane the reader
had just scoped. The fix is not to scope those panes: their contents are not in the payload, because
tasks, workflows and shells are read only for the session under review. So with a sibling selected those
badges go **blank** rather than describing a session the pane is not showing. Selecting a *prompt* does
scope Workflows, which is filtered from the prompt's own slice; the Tasks pane is not prompt-filtered, so
its badge keeps counting the whole list — a `0` over a pane listing thirteen tasks is worse than no badge.
The Fleet badge counts the rows the pane actually draws, after the Active-only filter and the fold: `1/31`
read as "one of 31 agents in this session" when the 31 was every session in the repo's history.

**A measured optimization sweep, both editors and the CLI.** Four measurement agents profiled every hot
path against a real 45-session store; each fix below carries its before/after from that store, not an
estimate. The multitask view parsed every sibling's full transcript on every ~3s tick for two integers
per row (458MB of reads, 88% of the view's CPU) — the boundary-crossing counts are now memoized per
transcript state like the risk counts already were: **multitask 1.4–2.2s → 0.38s, the idle Overview tick
1.43s → 0.33s**, peak RSS roughly halved. Change-map builds were quadratic in session length — a
per-edit rebuild of the session's file set inside `flagsFor` — and are now linear: **the 12k-edit warm
build 1.56s → 36ms**. In VS Code, inline placements re-diffed every open file on every keep click
(~350ms per hot file) because their cache keyed on the whole session log; they now key on each file's
own pending chain, and typing in a file whose last locate was expensive coalesces at 1.2s instead of
stalling every burst. The status bar's prompt axis re-read the whole transcript per keep click (60ms and
growing with the conversation; ~290ms by the time it was fixed) — the ask list is now cached against the
transcript alone, so a click re-pays ~4ms. The Edits and Diffs trees rebuild once per refresh cycle
instead of 2–4×, Clear Resolved and per-session Resolve spawn the CLI instead of freezing the host
~0.8s at the moment the user confirms, and one hung CLI child can no longer stop Overview refreshes
forever (spawns now carry a 120s kill timeout). In JetBrains, the clear-completed preview no longer
spawns the CLI on the UI thread, the usage readout is throttled like its stats sibling, and the
sessions-row **resolve** link is hit-tested against the drawn text itself rather than a fixed pixel
column that disagreed with it at any other UI scale.

**The bundled status line renders in half the time.** One jq pass instead of sixteen, and the session
title comes from a 4MB tail of the transcript instead of a whole-file scan that grew with the
conversation: **777ms → 412ms warm** on a real 10MB-transcript session. On plans with no rolling limits
(Enterprise / API) the local token scan's week window now quantizes to the hour, so its file cache can
actually hit — the scan was silently re-parsing ~300MB of transcripts every ten minutes, forever. A scan
that hits its 12s safety timeout now still records that it ran, instead of re-paying the full timeout on
every later render.

**The GC reaches its blind spots.** `clean` iterated store directories, so cache directories for
sessions with no store dir were never visited — 27 superseded-version payloads survived on a real store,
a set that grew with every cache-version bump. The GC now sweeps the cache tree itself (superseded
versions only; a live cache for a transcript-only session is a working cache). Usage cursors are keyed
by a hash of the transcript path, which nothing could reverse — new cursors record their transcript so
the GC can reap ones whose transcript is gone, and path-less legacy cursors go after 30 quiet days. And
a 3.7MB `blob-memo.json` written by a build that never shipped is now cleaned up.

**One meaning for "pending".** Two panels in the same window reported different numbers for the same
session — 2,800 against 1,855 — because some surfaces counted raw records and others counted the display
units the change map draws, after chained edits to the same code collapse into one review unit. Every
counting surface now uses the collapsed units: the Stats scoreboard and progress bar, the fleet rows, and
"N pending across siblings". The daily and hourly activity series stay raw on purpose — those answer "how
much did Claude do", not "how much is left to review", and collapsing them would under-report the work.

**A plan with no rolling windows says so.** Claude Code sends `rate_limits.*` only for Claude.ai
subscription plans, so on Enterprise or an API key the 5-hour and weekly bars could never fill — and an
empty bar reads as "you have used none of your quota" rather than "this plan has no rolling quota". When
a status-line reading arrives carrying no limits, both editors replace those two rows with what this
machine can actually measure — the status line's own 5h/wk totals when it has written them, a 24h/wk
local scan as the fallback — with no percentage, because there
is no denominator and inventing one would be a guess wearing a number's clothes. Nothing has reported yet
is kept as a third state, distinct from "no limits" — otherwise everyone who has not installed the status
line would be told they have no plan. The UI does not print the word "Enterprise": an API key produces
the same signal and nothing in the payload distinguishes them.

**`clean --completed` can be previewed.** It discards unreviewed edits, and the only way to find out what
it would take was to run it. `--dry-run` lists what would go without dropping anything, and the JetBrains
confirm dialog now leads with those real counts and names — it previously asked for a recursive delete in
generic prose while the VS Code dialog had always stated the numbers. `--stale` gained a 24-hour floor:
the abandoned branch is the one that discards unreviewed work, and `--stale 0d` reaped every
workspace-local session holding it the moment it was typed. Run from a directory with no sessions, the
verb now says that, instead of reporting that every session was spared by the rails.

**The Overview can dock as an editor tab (VS Code).** *Open Overview in Editor* (palette, or
`claudeObservatory.overviewLocation`) moves the Overview to a full-height editor tab; whichever host
holds it drives the refresh — never both — and the bottom panel says where it went. JetBrains needs no
equivalent: its tool windows already float and dock natively.

**The nav bar's Prompt axis follows the picked prompt.** Selecting a row in the Prompts window is an
explicit statement of scope, so the axis counter moves with it immediately (the current edit's prompt is
the fallback), and stepping the axis becomes the pick — the counter and the pick-scoped panes can never
disagree about which ask is under review. Both editors.

**The containers are regrouped and renamed.** The sidebar is **Observatory Traces** (Edits · Diffs ·
File History — the per-edit review side), the bottom panel is **Observatory Dashboards** (Overview ·
Stats), and the timeline-shaped surfaces — **Prompts · Actions · Observations** — live together in a new
**Observatory Timeline** panel. VS Code remembers view placement per profile, so an existing profile
keeps wherever you last dragged things — new installs get this layout, and *Show the Prompts window*
focuses the Prompts view wherever it lives. JetBrains mirrors the three surfaces literally: the Traces and
Dashboards tool windows carry the new names, and a new **Observatory Timeline** tool window (right
stripe) holds Prompts · Actions · Observations as tabs — the Dashboards dock slims to the Overview +
Stats split, and the guided tour raises whichever window a step's surface lives in. (Tool-window positions reset once on upgrade: the platform keys
them by window id, and the ids are the names.)

**Export grew a second form: the full session trace.** The Overview's Export now offers two documents —
the shareable review summary (markdown, as before), and the **full session trace**: everything the
observatory recorded for the session as one JSON document — every edit with its status, per-edit delta,
and reconstructed unified diff, the captures the hook declined, the prompts, every tool call, tasks and
subagents, egress and outside-workspace writes, the observations, and token usage. Core composes it
(`buildSessionTrace`), so the CLI (`claude-observatory export [--out <file>]`), VS Code (Export → Full
session trace, also in the command palette), and JetBrains (Export dropdown) emit the identical
document; a section that fails to build is named in `errors` rather than silently missing. Diff text is
capped at a 64 MB budget — a pathological store otherwise built ~850 MB of diffs and died on V8's
string cap — with the omission named in `errors` (deltas and blob shas stay); JetBrains opens the
result as a tab, or names the written file when it exceeds the IDE's 20 MB editor load limit.

**Release channels: stable, and a rolling pre-release.** The observatory now ships on two channels.
**Stable** is what it always was — tagged releases from `main`, served by `releases/latest`.
**Pre-release** is a rolling build of the persistent `dev` branch: every push re-stamps the version as
`<next>-dev.<n>`, re-runs the suite, and refreshes one GitHub release (tag `dev-latest`, marked
*prerelease* so stable installs never see it). A **version chip** now closes the Overview toolbar's
controls row in BOTH editors — pinned right, showing the running version with a dot when an update
is available, and a menu holding **Update now** (the full pass: CLI + both editor plugins + status
line) and the **Stable ⇄ Pre-release** switch; the terminal equivalent is
`claude-observatory update --channel <stable|dev>`, which persists the choice and installs that
channel's newest in the same run (downgrades included — leaving pre-release for stable must work).
Every updater follows the channel: `update`, `version --check` (now with `--json` for the chip), the
CLI's daily nudge, and VS Code's background notifier. The semver compare understands prerelease
ordering (a dev build is newer than the stable it forked from, older than the release it becomes),
release versions are derived from the tag OR the release title (the rolling tag never moves), and the
whole mechanism is exercised end-to-end in CI against a local mock of the releases API — real
downloads, real installs into a sandboxed npm prefix, both switch directions. Where a change ships
from now on: feature PRs target `dev`; a soaked `dev → main` PR plus a tag cuts the stable release
(see CONTRIBUTING, and the site's new [Releases & channels](https://cell-observatory.github.io/claude-observatory/releases.html) page).

**The session's name leads the Overview in both editors.** JetBrains' Overview top row now opens with
the session-name label VS Code already had — the human-readable title (the Sessions rows' title:
Claude's ai-title, else the first prompt — never the raw id) with the session id on the tooltip. In
both editors the label is ONE line and shows the WHOLE name: it never wraps and never clips — when the
row runs short, the bulk buttons flow to the next line (VS Code) or the toolbar's own overflow
(JetBrains), not the title.

### Fixed
- **The site scales fluidly and text spans the page.** The reading column was fixed at 1140px at every
  size — a ribbon on a 27"+ display. The column is now 90% of the viewport (floored at the old 1140px),
  the ROOT font size tracks width continuously (16px floor, 24px cap, no breakpoint steps — root, not
  body, because the type is rem-sized down to its clamp() caps, and a body-only bump visibly moved
  almost nothing), and every per-element `ch` cap on paragraphs and ledes is gone, so text genuinely
  fills the column at any width.
- **`update` refreshes the bundled status line too.** Updating the observatory left the installed
  `~/.claude/statusline.sh` at whatever version last ran `claude-observatory statusline` — one update
  command now covers both (including when the CLI itself is already current, healing a script an older
  CLI wrote), and only when ours is the installed one: the check matches the FULL config-dir script
  path, so a user's own script that merely ends in `statusline.sh` is never touched.
- **Windows: drive-letter case no longer forges phantom edits (#43).** Hook events could report one
  file as `C:\...` and `c:\...`; the Bash walk keyed each case separately, so every file gained a
  phantom created-record and a deleted-record twin — and undoing the phantom create DELETED the
  untouched file (unrecoverable when gitignored). Paths are now canonicalized at capture and on read
  (a pure drive-letter transform, so old stores heal in place), undo refuses a create whose delete-twin
  is present while the file still exists, and `clean --phantoms` removes the provable pairs — strictly
  those whose two records disagree on raw path case, so a genuine create-then-delete is never touched.
  The guard holds the whole way down: it proves a pair by the RAW-case disagreement (a same-path
  create→delete→re-create chain keeps its ordinary undo instead of a misdiagnosis pointing at a repair
  that finds nothing), it covers `undo --force` too (the bulk flow's conflict hint names --force, which
  previously still deleted the file), bulk reverts now COUNT refusals and surface the first refusal's
  message in all three front-ends (`undo --json` gains `errors` + `firstError`) instead of silently
  swallowing the one message that names the repair, and `clean --phantoms` on a session with no log
  reports zero pairs instead of dying on ENOENT.
  The same canonicalization now guards every path the product *takes in*, not just what capture writes:
  CLI operands (`locate --file`, `list --file`, and `--file`/`--under` on `keep`/`undo`/`redo`/
  `clean --resolved` — `--under` also resolves, so JetBrains' forward-slash paths and relative scopes
  work), the workspace `--root` prefix that scopes the Overview, and the shared `isUnderPath` primitive
  canonicalize both sides. In VS Code, `Uri.fsPath` lower-cases the Windows drive letter, so every
  record↔editor join — inline placements, dirty-buffer guards before bulk undo (which failed OPEN),
  nav-bar counters, per-file accept/revert, the live transcript watcher — now routes through one
  `canonPath` boundary; the extension-host smoke test's `Uri` mock reproduces the real lower-casing so
  windows-latest CI exercises exactly this skew. In JetBrains, the store reader applies the same
  read-side heal (phantom pairs render as one file there too), and a new editor→store path bridge
  (`storeKey`) fixes every `record.file == VirtualFile.path` join, which compared `C:\repo\x` against
  `C:/repo/x` and could never match on Windows — file history, editor banner, inline overlays, nav
  axes, the Project-view badge, and per-file accept/revert all join through it now.
- **`install-jetbrains.sh` no longer dies before its own error message.** With no JetBrains IDE
  installed, expanding the empty plugin-dir array under `set -u` aborted the script with a bash error
  instead of printing where it had looked.

- **A delta computed from an unreadable blob poisoned other sessions' caches.** `lineDelta`'s memo is
  keyed by the two blob SHAs, but blobs are content-addressed while *readability* is per session: a
  session that had lost a snapshot computed a wrong delta from an empty string and published it under a
  content key every other session shares. The per-session delta cache then persisted it behind a
  `hasBlob` guard that had only ever inspected the healthy session, so the bad number outlived the
  process in a store that never lost anything, and nothing could heal it because the key never changes. A
  delta is now returned but never published unless both blobs were actually read.
- **A blob-derived total was persisted under a log-only stamp.** `sessionCounts` caches `added`/`removed`
  in a sidecar keyed to the log's mtime and size — but those numbers come from blobs, and a finished
  session's log never changes again, so a sum computed while a snapshot was missing would have been
  frozen permanently. An incomplete pass now serves its answer and caches nothing.
- **The bulk verbs stopped refreshing the panels.** Accept All, Revert All and Clear Resolved lost the
  forced refresh when they were rescoped, leaving the Overview showing pre-change counts: the store
  watcher's unforced tick lands inside the 3-second coalescing window and the spawn already in flight
  started before the mutation.
- **A Fleet row's own bulk buttons were always refused.** Validation ran against this workspace's
  sessions, which resolve by walking *up* from the working directory — and a sibling worktree is never an
  ancestor. Every Fleet row's Accept/Revert was therefore a control that could only fail. JetBrains needs no equivalent rail there: its scoped ids come from Swing selection over the CLI's own fleet payload, never an untrusted webview boundary — safe by construction rather than by validation.
- **The docked Overview left the bottom panel dead.** Opening the Overview in an editor tab told the
  panel where it had gone only if the panel resolved *after* the tab, which is the rarer order; and the
  notice replaced the panel's DOM, so when the tab closed and the payload came back every renderer bailed
  on the missing nodes and the panel stayed stuck on a message about a tab the reader had already closed.
  The notice is an overlay now, and it lifts on the next payload.
- **JetBrains: the folded group never actually folded.** `TreeUtil.expandAll` expanded the fold, which
  fired the expansion listener, which set the flag the re-collapse was guarded on — so a week of old
  sessions sprang open on every transcript tick. It also drops `promiseExpandAll`'s promise, so on the
  async path the deferred expansion landed after the collapse: both timings ended expanded. The repaint
  now walks the nodes itself.
- **JetBrains printed "Cleared the completed completed session(s)."** The count fell back to a string
  sentinel that was then interpolated into a sentence expecting a number.
- **`warm` rebuilt the session under review** — the one the Overview builds every tick and whose
  transcript invalidates it seconds later. It also held every warmed session's file cache at once, so
  peak memory scaled with how many sessions were active rather than with the largest one.
- **A cached payload changed meaning without changing version.** Sibling rows began carrying collapsed
  counts while the stamp inputs stayed identical, so a valid cache entry would have served the old raw
  numbers indefinitely. The cache version is the only thing that can tell those apart, and it was bumped.

- **A running total cannot be validated, so it is not used.** The first version of the line-delta cache
  stored how far it had counted and resumed from there whenever the log had only grown. Resuming from a
  number is inheriting it: one bad entry — observed for real, a sum of 0 over 2,800 edits — is never
  recomputed, and nothing can notice, because there is nothing to check a derived total against. Adding
  a version gate and a boundary check narrowed the ways in without removing the failure mode. The cache
  is now keyed by each edit's **blob pair** — the content itself — so an entry is either a hit on exactly
  those bytes or a miss, the sum is rebuilt in full on every log change, and identical edits collapse
  onto one entry. Same cost, and a wrong number is bounded by one edit instead of permanent.
- **A running workflow's attribution froze.** The cache stamped `subagents/workflows/`, whose entries are
  `wf_<id>` *directories* — and a directory's mtime does not move when a file inside it grows. So a
  workflow that was still running never invalidated the map, which is the exact failure the stamp exists
  to prevent, one level too shallow. It now descends into the run directories.
- **`clean --older-than` could delete the session you were in.** It filtered on the *store log's* mtime,
  so a long conversation that made its edits early looked ancient by that clock, and the sink is a
  recursive delete. The live session is now excluded; the verb is otherwise unchanged.
- **Two builds fought over one cache file.** The cache version is now part of the file name, not just the
  stamp inside it. Builds that disagree about the stamp's shape used the same path, so each one's write
  was a permanent miss for the other — a 0 % hit rate with no symptom beyond "the Overview is slow".

## [0.8.9] — 2026-07-26

**Demo mode, in both editors.** The demo simulator has existed since 0.8.0, but only in the terminal —
neither editor had a way to reach it. It is now one command away in both: **Start Demo Mode** replays a
scripted Claude Code session through the real capture pipeline while you watch the panels fill, then
opens a **guided tour** that walks every surface, one step at a time, activating the panel it is
describing and ringing the control it names. Starting the demo again **resets** it, the
replay is **cancellable**, and **Exit Demo** removes every trace it wrote. Nothing calls a model, and the
capture hooks need not be installed — which makes it the first thing a new reader can try.

### Added

- **Demo mode in VS Code and JetBrains.** `Start Demo Mode`, `Restart demo`, `Guided tour`, `Exit demo
  mode` — in the command palette, on the Overview's nav bar, and in every empty state, so a
  workspace with no Claude session yet offers the demo instead of only explaining why it is empty. In
  JetBrains the same verbs sit at the end of the Overview's nav bar and in Find Action, and the Edits and
  Observations empty states offer the demo too. The replay runs in-process in VS Code and as a streamed background task in
  JetBrains, narrating each beat.
- **The guided tour.** Forty-one steps covering every panel the product ships and every named
  feature — the five Overview tabs, the change map's Folders strip, Files ledger, summary bar and feed,
  the four review axes, the Edits **and Diffs** trees, inline review, Spotlight, File History and
  revision navigation, search and Active only, the chat handoff, export, the status bar, the Explorer
  badges, the Risk and Egress audits, context sources, file memory, and Stats. It opens with a choice of
  **Essentials** (13 steps) or **Everything** (41); finishing the short one offers the other 28 as its
  own track, in both editors. All
  three are filters over the same list, so they can never tell different stories. The script lives in core (`demoTour()`), so the terminal, VS Code and
  JetBrains all show the same tour in the same order; `claude-observatory demo --tour [--essentials]`
  prints it as prose.
- **The tour plays itself.** Each step holds long enough to read it — derived from its own text, three
  and a half to nine seconds — and any control that moves the tour (Next, Back, a step jump) hands you
  the wheel, with a transport button to resume. Docking or floating the window does not.
  A **YOUR TURN** step shows a countdown and, if you do nothing, performs the action itself and says so,
  so a reader who only watches still sees Keep and Undo actually happen. VS Code honours
  `prefers-reduced-motion` and starts paused; the JetBrains platform exposes no such signal, so it starts
  playing and the button is the control.
- **The tour docks beside your code** — an editor-area panel in VS Code, a tool window on the right in
  JetBrains. VS Code can also detach it into a window of its own for a second screen and remembers the
  choice; JetBrains cannot, because that window never appeared in PyCharm 2025.2 and shipping a control
  that does nothing is worse than not offering it. Hiding the JetBrains tool window **pauses** the
  tour, because its wait steps act on a timer and must never do so behind a window you cannot see.
- **Demo mode lives at the END of the Overview's nav bar**, in both editors, and nowhere else in the
  panels. It began as the first thing on the Edits toolbar, where it pushed the review actions rightward
  and read as though the demo were part of reviewing the session in front of you. The empty states keep
  their **Try the demo** link, which is the first-run path. In JetBrains the four verbs come from one
  shared list, so the surfaces that offer them cannot drift apart.
- **The demo is offered on a first install and once after an update** — one notification, four seconds
  after startup, with **Never ask** on it. Skipped while a Claude session is live in that project, in an
  untrusted workspace, and once a demo is already recorded there.
- **The tour holds the Overview's Active only filter open** while it runs, because five of the demo's six
  tasks are completed and the filter hides completed tasks by default — so a step that says "accept task
  1" now names a row that is on screen. Your own filter and your own tab come back when the tour ends.
- **The control a step names is ringed.** The step's text lives in the tour window; the control it points
  at is outlined in place — a CSS outline in VS Code, a glass-pane painter in JetBrains, neither of which
  reflows the panel being pointed at. Neither editor can draw over IDE chrome it does not own — the
  activity bar, the tab strip, the status bar — so for those the step's text names the control instead.
- **A scenario that leaves no panel empty.** The simulated session now runs to **three prompts, six
  tasks and nine edits**, and adds the cases whose surfaces could previously only render an empty state:
  a **second agent in a sibling worktree** with a live **file collision**, a **deletion** captured through
  the Bash tree-diff path, a **failed tool call**, a **write outside the workspace** for the Risk audit, a
  third **background shell** that exits non-zero, a **three-phase workflow**, and a second edit to one
  file in its own region, so "undo one edit and keep the later edits to the same file" is demonstrable.
- **The demo hides itself from git.** It writes into your own repository, so its folder now carries a
  self-ignoring `.gitignore` — it never appears in `git status` and `git add -A` cannot sweep it in.
- **`demo --status`, and an exit that stays reachable.** Session resolution follows the newest
  transcript, so one real Claude turn after a demo used to take Exit Demo away while the folder and both
  sessions were still on disk. Both editors now offer Exit whenever a demo *exists* for the folder, not
  only while one is the session under review.
- **`demo --tour`, `demo --touch`, `demo --no-fleet`.** The tour's script as text or JSON; a heartbeat
  that keeps a running demo inside the fleet's 60-second active window while a tour explains it (mtime
  only — nothing is written); and an opt-out from the sibling agent.

- **`views` — several read-only views in one process.** `claude-observatory views [--views a,b,c]` runs
  the read-only views together and emits `{name: payload}`, each byte-identical to that view's own
  command (pinned by the e2e suite). A view that fails is `null` rather than fatal to the batch, and a
  mutating verb is refused. The JetBrains plugin has no in-process core, so it spawned one CLI per view —
  eight per refresh tick, each paying node start-up and re-deriving the same transcript parses from
  cold; those eight are now one spawn. `feed`, `tree`, `stats` and `usage` still spawn for themselves —
  they answer their own triggers, not the Overview's tick.

### Changed

- **Prompts and Stats fold away in JetBrains.** The bottom dock holds three columns beside a nav bar, and
  on a short tool window that left the change map almost nothing. Two toggles in the Dashboards title bar
  now fold either side pane, remembered across restarts (`dashShowPrompts` / `dashShowStats`). VS Code
  gets the same room for free — its three dock views are separate accordion sections — so this is the
  platform's equivalent rather than a new idea.
- **The Overview's axes row is icons only, in both editors.** The four review axes — Diff · File ·
  Folder · Prompt — carry color-coded icons with the verb on hover. Each axis already names itself in
  its own counter ("File 3/126"), so "Accept File" beside it restated what the reader was looking at,
  and between them the labels took most of the bar. The session-wide controls row above keeps its
  labels: those act on everything and have no counter to say so.
- **Starting the demo resets it.** A run clears any previous demo for that folder before replaying, so
  Start and Restart are one operation and a second run cannot stack a stale, half-reviewed session beside
  the fresh one. `runDemo({ reset: false })` opts out.
- **One name for the audience.** The project described who it is for four different ways ("established
  codebases", "critical infrastructure", "code that matters", "code you cannot afford to get wrong").
  Every intro surface — the README, the site, both marketplace descriptions, every package description —
  now says **established and mission-critical codebases**, per `docs/STYLE.md` X2.
- **A scope flag and an edit id are mutually exclusive.** `keep`/`undo`/`redo` took the bulk branch
  before ever reading a positional id, so `undo --file src 2` silently discarded the `2` and reverted
  every pending edit under `src` — writing them all to disk and exiting 0. They now refuse the pair and
  say which is which.
- **Flags require their values.** A bare `args[i + 1]` accepted the NEXT FLAG as a value, so
  `locate --file --json` resolved `<cwd>/--json` as the path to place edits in, `list --file --json`
  filtered for files containing "--json", and `clean --session --json` operated on a session literally
  named `--json` (which passes the session-id character class). `--file`, `--under`, `--session` and the
  rest now reject a `--`-prefixed token and fail loudly. `clean --session` and `list --file` require a
  value at all — a missing `clean --session` value used to widen the scope from one session to **every
  session in the store**, and that verb's sink is a recursive remove.
- **A taskId this session never had is an error.** `task-keep`/`task-undo`/`task-clear` answered an
  unknown id with a green "kept 0 edit(s)" and exit 0, indistinguishable from a real task with nothing
  pending. They now exit 1 and list the session's actual task ids (`sessionTaskIds`).
- **`keep` on a reverted edit keeps nothing, and says so.** It used to flip the ledger to *kept* while
  the file still held the reverted content — and that also marked the edit resolved, so `clean
  --resolved` would drop it and the revert could never be redone. `keepGroup` now flips only pending
  edits, matching `keepTask`'s long-standing rule.

### Performance

- **Edit placement composes the edit chain instead of re-aligning per edit.** Placing an edit means
  mapping its `after` snapshot onto the current buffer; done once per edit, that runs a whole-file Myers
  alignment whose cost grows with the *cumulative* drift since that edit, so a file with n edits paid the
  largest alignment n times over. Consecutive snapshots are only one edit apart, so `locateEditsInCurrent`
  now aligns `after[i] → after[i+1]` and composes those hops backwards from the buffer. Measured on an
  800-line file with 30 pending edits (Node 22, warm process, the old per-edit path against the batch):
  **~5× faster at 3 changed lines per edit and ~30–35× at 15 and at 40**, with zero placement
  differences at every level. An earlier draft of this note quoted 71.9× at churn 40; that does not
  reproduce — the gain flattens once per-edit alignment stops being the dominant cost. Snapshots are pulled one at a time rather than materialised up
  front, which keeps a 5,000-line / 500-edit file at **+171 MB instead of +665 MB** in the VS Code
  extension host, where the inline overlay does run in-process. Every surface that places an edit goes
  through it: both editors' inline overlays — VS Code in-process, JetBrains through `locate --json`,
  which now also carries the deletion hunks it computes for free — and the change map, on whichever
  side builds it.

### Fixed

- **Selecting a still-running row bought a permanent background spawn.** A feed is "live" whenever
  nothing has recorded an end — which is not the same as anything still happening — so the Overview
  re-ran `feed --json` (~75 ms) every 3 s tick for as long as that row stayed selected. The demo's
  running shell is live by construction and so paid it until Exit Demo. The poll now backs off while the
  answer keeps coming back identical (9 spawns per 120 s instead of 40, converging on one per 30 s) and
  returns to full rate the instant anything changes or you press Refresh.
- **Adding, removing or reordering workspace folders changed which session VS Code was showing, silently.**
  `workspaceRoot()` is `folders[0]` and every caller reads it live, but nothing subscribed to
  `onDidChangeWorkspaceFolders` — and the store watcher is scoped to `~/.claude`, so no file event fires
  when the WORKSPACE changes. The panels kept rendering the previous root's session until some unrelated
  event happened to refresh them. JetBrains has no counterpart; a project's basePath is fixed.
- **The site scrolled sideways on a phone.** The nav is one non-wrapping flex row, and its ghost GitHub
  button pushed the right-hand cluster past the viewport — measured +29 px at 320 px on every page, and
  +29/+30 px at 768 px on the six-link pages. The button is dropped below 900 px, where GitHub is already
  in the links (and in the ☰ menu). A long command in prose was the last 8 px on the features page; inline
  `code` now wraps rather than overflowing. Verified at 320/390/768/1440 px on all five real pages.

- **A staging record could be read as empty while it was being rewritten, and the garbage collector then
  freed an edit's blobs out from under it.** `writeStaging` truncated in place; a `gcSessionCore` running
  concurrently read zero bytes, `JSON.parse` threw, and the catch treated the record as absent — so both
  the before AND after blob of an edit that was about to be committed were collected. Measured on this
  machine at 2.8% of reads during a rewrite (1,318 of 47,608). It now writes to a temp file and renames,
  so a reader sees the old record or the new one and never a torn one: 0 of 55,340 under the same probe.
- **One slow or failed `views` batch permanently disabled batching for the rest of the IDE session.** Any
  non-zero exit latched the "this CLI is too old" flag — including a timeout on a large first build — and
  every later refresh fell back to eight separate spawns, which is the cost the batch exists to avoid. It
  now latches only on the one failure that cannot recover, a CLI that answers `unknown command`; anything
  else falls back for that tick alone and the next tick retries.
- **A batch build blocked every other open project for as long as it ran.** `ViewBatch` held one global
  lock across the spawn, so a second project whose own views were already cached still waited — up to the
  180 s heavy timeout. The spawn now runs under a per-(session, workspace) lock, which still collapses
  concurrent views of the same session into one process.
- **The Switch-Session picker could block behind a full eight-view build.** It passes the current session,
  so it hit the same batch key as the poller and, on a cold window, paid for the change map to answer a
  session list — the multi-second stall 0.8.8's stat-only listing had removed. It now reads the batch only
  when the poller has already filled it.
- **The tree toolbar's per-file accept/reject could act on a file the gate never approved.** `update()`
  read the background-safe active-file tracker while the click read `FileEditorManager`, two sources that
  disagree across a tab switch — so a bulk, unrecoverable accept could land on the wrong file. The click
  now resolves the same path the gate approved, and cancels rather than guessing when they differ.

- **Every button on the JetBrains Overview did nothing unless the Fleet tab was open.** All six of that
  panel's toolbars set `targetComponent` to a tree living inside ONE nav tab, and the platform refuses to
  perform an action whose toolbar target is not showing — so with Sessions selected, which is the
  default, Accept All, Reject All, Clear Resolved, Export, Search, Active only, Clear completed,
  Spotlight, Refresh and all four review axes were dead, with no error and no feedback. The IDE's own log
  said so 28 times. They now target the panel that owns them, and `ToolbarContractTest` fails if any
  toolbar is ever again pointed at something that can stop showing while its buttons are on screen.
- **The editor's text cursor was replaced by the arrow, in every file.** The inline overlay's lens-hover
  handler is registered on the global editor multicaster and ended by assigning the cursor
  unconditionally — including `Cursor.getDefaultCursor()`, the arrow — so it ran on every mouse move in
  every editor of the project whether or not the file had a single Claude edit, and it ran after the
  platform had set the pointer, so the editor could never win it back. It now uses `setCustomCursor`,
  shows the hand only over a lens, and releases only an editor it took.
- **Clearing resolved edits erased the session's skip markers.** `clearResolved`/`clearResolvedIds`
  rebuilt the log from `readLog`, which returns edit records only, so every `op` line went with it —
  including the `skip` markers that record *"a real edit could not be captured"*, the one thing standing
  between an uncaptured change and silence. Clearing a single folder erased skips for unrelated files
  too. The rewrite now carries every non-status op across.
- **Garbage collection could delete a just-captured snapshot.** `PostToolUse` wrote the after-blob and
  then appended the record; in between, nothing referenced that blob, so a concurrent `clean` or
  `clear` collected it and the append committed a record pointing at a file that no longer existed —
  `lineDelta` then reported the edit as a pure deletion and `undo` threw. The staging record now
  publishes the after-blob before the append, and the GC honours it.
- **Edits attributed to the wrong task.** The strict span model sorted the task-system snapshots by
  timestamp but not the TodoWrite ones — and a transcript is not timestamp-ordered. An out-of-order
  checkpoint inverted a task's span so it matched nothing, and handed its edits to the neighbouring
  task, which a task-scoped keep or undo would then act on. Both sources are now sorted.
- **The change map served stale class attribution.** Its on-disk cache keyed on the transcript and the
  store log, but the map is also derived from the **workspace files themselves** (it reads each one to
  detect classes and place edits). Editing a file in your editor moved neither key, so the map kept
  reporting the old class names and placements until something unrelated touched the transcript.
- **`footprint --json` emitted two JSON documents.** It ran `risk` and `egress` straight through, so
  every caller's `JSON.parse` threw. It now emits one `{ risk, egress }` object.
- **`status` crashed on very large sessions.** Two `Math.max(...log.map(…))` spreads survived the
  conversion to the call-stack-safe `maxOf`, and throw `RangeError` past ~124,000 edits.
- **The end-to-end suite spoke out loud.** One section header used the `say "…"` logging idiom borrowed
  from `scripts/bootstrap.sh` and `docs/devcontainer/setup.sh` — both of which define a `say()` helper.
  `test/e2e.sh` does not, so on macOS it reached `/usr/bin/say` and read the test name aloud through the
  speakers. It now uses the same `echo` header every other section uses.
- **Demo task attribution under a fast replay.** The simulator's transcript clock advances a millisecond
  per line and so ran ahead of wall time, while the store stamps captures with the real clock — far
  enough ahead, in the longer scenario, that a task's in-progress span no longer contained its own edit
  and the Tasks tab lost a row. Each beat now waits for wall time to catch up.
- **Orphaned usage cursors.** A transcript's incremental usage cursor is keyed by path, so
  `removeSession` could not reach it and every demo run left one behind for good. `demo --clean` now
  drops them (`removeUsageCursor`).
- **`demo --dir` could destroy the directory it was pointed at.** The demo planted its ownership
  sentinel into whatever folder `--dir` named, so the sentinel proved nothing: the first run overwrote
  any file whose path the scenario reuses, and — since a run now resets — the second run deleted the
  whole directory. `--dir` is refused unless the folder is empty or already a demo workspace.
- **A symlinked `--dir` stranded the sibling session.** The workspace path was resolved through the
  symlink in one place and not in another, minting two project dirs; the sibling landed in one and every
  later `--clean`, `--touch` and status scan looked in the other, while cleanup reported success. One
  normalization now serves all four.
- **Exit Demo could strand its own folder.** The tour opens a demo file; a buffer saved after Exit
  deleted the tree recreated a file inside it — along with the sentinel that authorizes deletion, so no
  command could ever remove that folder again. Both editors now close the demo's editors first.
- **Cleanup no longer claims more than it did.** Removal is best-effort per item, but both editors
  reported a fixed "removed the folder and the report" regardless; they now name what actually came
  back, and say "nothing to remove" when that is the truth.
- **A demo with no CLI on PATH says so first.** The replay runs in-process in VS Code and works without
  the CLI, but the Overview, Prompts and Stats panels read their data through it — and 26 of the tour's
  41 steps are about those three. Starting the demo without it now warns before, not after — and the
  check **spawns** the CLI rather than statting a path, because the PATH fallback is a bare name and
  statting it declared every install outside a fixed candidate list broken.

## [0.8.8] — 2026-07-25

A subtraction and a speed-up. The **chapters** display layer is gone: it partitioned a session's edits
across Claude's plan, filling the gaps with a synthesized session chapter so every edit had a row, and in
practice nobody reviewed by it. What organizes review now is what you asked for — **prompts**, renamed
from requests and used as the vocabulary everywhere — and what Claude planned, which survives as
**tasks** under strict attribution and nothing else. A new **Sessions** tab lists this workspace's
sessions, the session picker no longer parses a single edit log to open, and a session with thousands of
edits renders in a fraction of the time it used to.

### Added

- **Sessions tab.** The Overview's left nav gains a fifth tab in both editors: every Claude Code session
  recorded for this workspace, led by Claude's own title for it and ordered by when its *conversation*
  was last active. The live session is marked. Selecting a row is a change of subject rather than of
  view — it pins the session every window reviews, the same choice Switch Session makes.
- **`sessions --json` reports the workspace listing.** `{ active, sessions: [{ id, title, lastActiveMs,
  current }] }`, built from directory stats plus a bounded title scan cached in a per-session sidecar.
  Each row also carries what that session did — edits captured, files touched, how many still pending —
  from a per-session sidecar keyed to the store log, so the listing re-reads only logs that changed.
- **`clean --resolved --ids <a,b,c>`.** Clears the resolved edits of an explicit id set — the scope one
  prompt names, which no `--under <path>` can express, since a single prompt edits whatever it edits.
- **Prompt-scoped bulk review in JetBrains.** With a prompt picked in the Prompts window, Accept All,
  Reject All, and Clear Resolved retarget to that prompt, as they already did in VS Code.
- **The Folders strip expands.** The change map's strip leads with the eleven folders that moved most
  and folds the rest behind a **+K more** tile. That tile is now a control: it opens the strip to every
  folder — wrapped onto further rows, capped at five and scrolling, so the file ledger stays in view —
  and **show fewer** folds it back. Before, the tail was an inert label and the folders behind it could
  not be reached from the strip at all. Tiles also hold a readable floor width instead of shrinking, so
  a narrow panel gets more rows rather than slivers.
- **The Overview's panes resize.** A gutter between the left nav and the change map drags in VS Code
  (double-click restores the default), and JetBrains remembers where you left its splitter. Both keep a
  separate position for each layout, because below about 620 px the panel stacks the two panes instead
  of splitting them side by side — and the nav bar there gives each review axis its own row.
- **Per-task review in both editors.** The Tasks tab now offers Accept, Reject, and Clear on each row —
  chips in VS Code, a context menu in JetBrains — over that task's strict span. The CLI verbs existed
  before; nothing in either editor reached them.

### Changed

- **Requests are now prompts.** The dock window is **Prompts**, the verb is `prompts`, the change-map key
  is `prompts[]`, and the review axis is **Prompt**. The old `requests` verb is **gone**, not aliased: a
  script that called it exits non-zero with `unknown command "requests"` instead of quietly printing a
  payload whose array is now named something else. In VS Code the view identifier changed with the name, so the Prompts window
  returns to its default dock position once; drag it back and it stays.
- **Task review is strict, and says so.** `task-keep`, `task-undo`, and `task-clear` act on a task's
  **strict in-progress span**: the edits captured while that to-do was actually in progress. Nothing is
  swept in from the gaps around it, and an edit that fits no interval is reported in the explicit
  unassigned bucket. `task-clear --completed` clears every settled task's resolved edits.
- **The review axes are four**: Diff · File · Folder · Prompt.
- **The Overview's change map is two sections** — the Folders strip over the churn-ranked Files ledger,
  with the summary bar naming the picked prompt or folder filter.
- **Dropping a session drops its derived copies.** 0.8.8 caches a session's title and its whole change
  map — which carries its prompt text — on disk. `clean --drop`, `clean --all`, `clean --older-than`,
  `demo --clean`, `uninstall --purge-store`, and either editor's Drop action remove those with the
  session, and a routine `clean` never mistakes the caches themselves for reclaimable sessions.
- **Active only defaults on, and is remembered.** The Overview opens showing work that still awaits
  review; the toggle survives hiding the panel, reopening the project, and restarting the IDE.
- **The session picker was rebuilt.** Rows lead with the session's title, order the live session first
  and the rest by conversation recency, open with the session you are currently reviewing preselected,
  and match on the raw id as you type. Pending counts are gone from it by design.
- **Documentation.** The panels reference is merged into the concepts page as an annotated tour of each
  surface (`panels.html` redirects), the feature reference is ordered by what a reader reaches for first
  and gains Prompts and Sessions sections, and the landing page opens with an abstract.

### Removed

- **The chapters display layer, in full**: the ribbon, the Chapter review axis, the synthesized session
  chapter, the `chapter --of-edit` query, the `chapters[]` / `edits[].chapter` / `chapterIds` /
  `afterChapterId` JSON keys, and the editor commands and keybindings that drove them — VS Code's
  `claudeObservatory.navChapterPrev` / `navChapterNext` (with their <kbd>ctrl/⌥⌘ ,</kbd> / <kbd>.</kbd>
  bindings, now free) and `claudeObservatory.clearCompletedChapters`, and the JetBrains
  `ClaudeObservatory.ReviewPrevInChapter` / `ReviewNextInChapter` actions on the same chord.

  | 0.8.7 | 0.8.8 |
  | --- | --- |
  | `task-keep <id>` over the chapter's **displayed** edits | `task-keep <taskId>` over the task's **strict** in-progress span |
  | `task-undo <id>` over the chapter's displayed edits | `task-undo <taskId>` over that same strict span |
  | `task-clear <id>` (`--completed` = settled chapters) | `task-clear <taskId>` (`--completed` = settled tasks) |
  | `chapter --of-edit <n>` | `changemap --json` → `tasks[]` + `rollupByTask` |
  | `changemap --json` → `chapters[]`, `edits[].chapter`, `chapterIds`, `afterChapterId` | `tasks[]`, `rollupByTask`, `unassigned`, `prompts[]` |
  | `multitask --json` → `tasks[].chapterId` | `tasks[].taskId` (the strict 12-hex task id) |
  | `requests` (verb, window, `requests[]`) | `prompts`, `prompts[]` — the old verb is removed |
  | `sessions --json` → `{active, sessions:[{id,title,edits,pending,lastMs}]}` (whole store) | `{active, sessions:[{id,title,lastActiveMs,current}]}` (this workspace) |
  | VS Code command `claudeObservatory.showRequests` | `claudeObservatory.showPrompts` |
  | VS Code view id `claudeObservatory.requests` | `claudeObservatory.prompts` |

  The same three task verbs kept their names and changed their meaning: they used to act on the edits a
  chapter row *displayed* (a total partition, so every edit was in one), and now act on a task's strict
  in-progress span. On a session whose plan covered the work, the sets are identical; where they differ,
  the edits that fall outside every in-progress window are reported unassigned instead of being swept in.

### Performance

Measured on a synthetic session of 3,000 edits across 150 files (Node v26.4.0, macOS, warm meaning a
second call with the store unchanged), before and after this release:

| Operation | 0.8.7 | 0.8.8 |
| --- | --- | --- |
| `appendLog` (one capture, including id allocation) | 2.1 ms | 0.3 ms |
| `readLog` × 100 (warm) | 184.1 ms | 7.2 ms |
| `buildEditTree` (warm) | 245.6 ms | 7.3 ms |
| `buildChangeMap` (warm) | 358.0 ms | 148.9 ms |
| `buildChangeMap` (cold) | 549.5 ms | 353.0 ms |
| session listing | 1.9 ms | 0.1 ms |

On this project's own store — 37 sessions, 31 of them for this workspace — the listing the picker opens
with fell from 717 ms to 4 ms, and to 1 ms once each session's title sidecar is warm. The two listings
are not identical: the old one parsed every session's transcript for a title and every session's log for
counts, and returned the whole store; the new one stats directories, reads a cached title, and returns
only this workspace's sessions.
The capture path is no longer quadratic in a session's size — the next edit id is read from the tail of
the log rather than by parsing all of it. In the editors, the VS Code status item indexes its records
instead of scanning them per edit, inline placements are cached per file and no longer recomputed on
every keystroke, and the store watcher only wakes for this workspace; the JetBrains plugin coalesces its
refresh fan-out into one repaint, bounds tree expansion at 300 nodes, and waits for a buffer to settle
before spawning a `locate`.

### Fixed

- **The store's caches were world-readable.** SECURITY.md has always described the store as 0700
  directories and 0600 files, but the derived caches added in 0.8.5–0.8.7 (`stats-cache.json`,
  `usage-cursors/`, the sibling-overview cache) were written with default permissions, and on a shared
  host that is readable by every other account. All of them, and every cache this release adds, now
  carry the store's own modes.
- **Accept All was quadratic, and at real scale that is a hang, not a slow path.** Each per-edit status
  write resolved its record through the folded log, whose memo the write then invalidated — so accepting
  N edits re-parsed the log N times. On a 26,000-edit session it took **8 minutes**; it now takes **8 ms**
  (`setStatusMany`: one parse, one lock, one append, and no-ops skipped so a second Accept All writes
  nothing). Every bulk verb goes through it — Accept All, a file, a folder, a task, a prompt — and the
  JetBrains plugin, which had been spawning one CLI process per edit, now sends the whole set at once
  (`keep --ids <a,b,c>`).
- **Switching sessions was slow in proportion to the session you switched TO.** Three causes, all fixed:
  `changemap --json` had no on-disk memo at all, so a fresh process rebuilt an unchanged map every tick
  (4.1 s → 0.78 s); `multitask --json` rebuilt "the active session" unconditionally, which is right for
  the live conversation and wrong for a pinned one that can never change again (4.8 s → 1.0 s); and every
  sibling's transcript was re-parsed for its risk tally on every refresh (`listRepoSiblings` 684 ms →
  37 ms). A warm switch on this project's own store now costs **0.18 s of process time, against roughly
  8 s before**. Selecting a session also takes effect immediately in the panel, which used to keep
  showing the previous session's edits under the new session's name until the payload landed.
- The Tasks tab joins each row to its strict rollup, so a task's ± and edit counts describe the work
  captured while it was in progress rather than a display grouping's totals.
- Ordering sessions by conversation recency rather than by store writes: accepting a batch of old edits
  no longer moves a finished session back to the top of the list.

## [0.8.7] — 2026-07-23

Follow-up to 0.8.6, and largely a subtraction: the separate capability panel folds into the Risk and
Egress audits, the context-per-turn chart goes away, and what remains is sharper — background
**Processes**, a **live feed** for whatever you click, switching sessions actually switching the
Overview, and two more optimization passes. A full adversarial review of the batch produced 58 verified
findings, and the fixes for them are in here too.

### Added

- **Requests — the session as the conversation you actually had.** Every other view organizes the work
  the way the *agent* saw it: worktrees, runs, its own to-dos, files. This one is one row per thing
  **you** asked for, in order, each carrying what that ask produced — its edits, the subagents and
  workflow runs it spawned, the background shells it launched, the compactions it suffered. Work belongs
  to the ask that **started** it, never the one that happened to be current when it finished: a shell
  launched by request #4 stays #4's even when it exits during #7. `claude-observatory requests` prints
  the list; `--id <n>` prints one ask with everything it caused.
- **Selecting a request scopes everything.** In both editors, Requests is now its own window in the
  bottom dock, immediately left of the Overview — so the list of asks stays visible while you read what
  one of them produced. Picking a row narrows the Overview beside it: its fleet (the subagents that ask
  spawned), its workflow runs, its tasks, its background shells, and the whole change map — chapters,
  folders, files. The bulk actions retarget to it ("Accept All in #18"), and every pane that dropped
  rows says how many and why. Each ask's files and folders are aggregated in core, so both editors
  render the same numbers without re-deriving anything.
- **A Request axis on the review nav bar**, beside Diff · File · Folder · Chapter: step between your own
  asks, and accept or revert everything one of them produced.
- **Every request carries its own headline stats** — edits, files, folders, tokens, subagents, workflow
  runs, tasks worked, background shells, and time. Tokens are the main-chain assistant total for the
  window (deduped by message id, the same figure the Stats panel sums); files/folders are the distinct
  paths the ask's edits touched; tasks are the to-dos it worked. `requests --id <n>` lists them all.
- **Expand any request to read Claude's reply.** Each row opens a log of Claude's actual response to
  that ask — its prose, with the tool calls stripped out, so you get the narrative (the plan, the
  explanations, the summary). Fetched on demand because it can be large, and shown whole, wrapped, never
  clipped. From the shell: `claude-observatory requests --id <n> --response`.
- **Collapse All on the sidebar trees.** Edits, Diffs and Actions gain the file-Explorer's Collapse-All
  affordance — VS Code's native tree button, and its IntelliJ toolbar equivalent — so a deep
  folder → file → class tree folds to its top level in one click.
- **Risk and Egress now answer the whole "what did it touch" question.** `risk` reports the edits that
  landed **outside the workspace** alongside the shell commands it already flagged — writing outside the
  boundary you gave the agent is the same class of fact, and the edits ledger cannot state it because it
  shows every path workspace-relative. `egress` reports the files **read** from outside the workspace as
  channels beside web hosts, MCP servers and network shell — reading outside the boundary is reach,
  exactly like a fetch. Egress scopes gained `local`, rendered as its own label: `local` is a fact,
  `unknown` is an admission that a destination could not be classified, and collapsing the first into
  the second would be a lie.
- **Processes — the background shells Claude left running.** A new tab beside Fleet · Workflows · Tasks,
  and `claude-observatory processes`. Each shell shows its runtime, its exit code, and how much output it
  has produced; `--id <shell>` prints the full command it is running plus a tail of that output. There is
  deliberately no OS process id: the transcript never records one, and inferring it from local processes
  would be wrong the moment the agent runs over SSH or in a devcontainer, so the harness's own shell id
  is the identity — which is also what the agent uses to read or kill it.
- **A live feed for whatever you click** — an agent, a workflow run, a task, a background shell, or the
  session itself — read from the file that thing writes as it works, via `claude-observatory feed`. A
  feed means a different thing depending on whether its source is still going, so core decides and both
  editors agree: **live** while it is still writing (follow the tail, and report the age from real
  evidence rather than claiming realtime), **audit** once it has finished, because a completed run is a
  record, not a stream — and a finished thing stops being polled. Capped feeds always say how many
  earlier entries they did not show.

### Changed

- **The bottom dock is Requests · Overview · Stats; Observations moved to the sidebar.** Three windows
  side by side instead of two-plus-a-list: the Requests window needs to be visible *while* you look at
  what it scopes, which a tab inside the Overview could never do. Observations joined Edits · Diffs ·
  File History · Actions in the sidebar window, where the rest of the read-and-review surface already
  lives. Nothing was removed — everything is where the review work happens.
- **Long text wraps everywhere instead of being clipped.** A prompt, a workflow name, a to-do: these
  render whole, over as many lines as they need, in both editors and in `requests` on the terminal. An
  ellipsis throws away the only copy of what was actually said.
- **The Requests window is a clean list for picking an ask.** The scope it sets is shown where it
  matters — the Overview's panes note what they hid, the bulk buttons read "…in #N", and the bottom
  summary names the ask — so the redundant banner that repeated the ask inside the Overview is gone, as
  are the per-row Review/Accept/Revert icons (those live on the Overview's Request axis once an ask is
  selected).

### Fixed

- **"Active only" now hides exited background shells too.** Fleet, Workflows and Tasks already scoped to
  what is still going when the toggle is on; the Processes pane was the outlier and kept showing finished
  shells. It now shows only running ones, and when that empties the list it says so — "No running
  shells — clear Active only to see the N that have exited" — rather than looking blank.
- **Revealing the Requests window after an upgrade.** When a view container's contents change, VS Code
  keeps the pre-upgrade panel layout and does not surface a newly-added view, so upgraders into 0.8.7
  did not see the new Requests window. A one-time, dismissible prompt now points at it, and a
  **"Claude Observatory: Show Requests window"** command reveals it on demand. (A fresh install shows it
  already; JetBrains was never affected — it builds the pane unconditionally.)
- **The separate capability/footprint panel is gone — folded into Risk and Egress.** It shipped in
  0.8.6 as a six-facet badge row, and most of it restated audits that already existed: risky commands
  are Risk, MCP servers and web hosts are Egress, subagent spawns are the Subagents view. Only two of
  its facts were unique, and those are the two that moved. One audit surface instead of two. The
  `footprint` and `capabilities` commands still run, printing both audits with a note on stderr.
- **The file-edit facet is gone** — edits already have the ledger, the Overview and the review
  scoreboard; repeating them here added a number without adding a fact.

### Removed

- **`claude-observatory capabilities` is now `claude-observatory footprint`.** The old verb still works
  and forwards, printing a one-line deprecation notice on **stderr** so anything piping `--json` is
  unaffected. The JSON key changed with it (`capabilities` → `footprint` in `changemap --json` and
  `multitask --json`) — a deliberate exception to the "add fields, don't rename them" contract, recorded
  here because a version-skewed editor drops the whole footprint row silently rather than erroring.
- **`changemap --json` no longer repeats a full edit list per sibling session** (`agents[].edits`).
  It was 1.95 MB of a 3.30 MB payload that both editors re-parsed on every refresh and neither read;
  the whole payload is now 1.43 MB. The active session's own top-level `edits` is unchanged. Removing a
  shipped field is against this project's "add fields, don't remove them" rule, so it is stated here.
- **The context-per-turn chart** in the Stats panel, along with the per-turn series that fed it. The
  compaction data it visualised stays: compactions remain a curated group in the Actions timeline and
  markers between the Overview's chapters.

### Fixed

- **Switching sessions now changes the Overview's detail pane.** The fleet lists every sibling session
  in the repo, so a selection made against the previous session still resolved after the switch and the
  detail kept rendering the old session's change map — the label changed, the content did not. Both
  editors now re-point the selection when the active session changes, in the same place they already
  reset their dismissed sets.
- **A long session's activity sparkline can no longer blow the call stack** — the fleet histogram used
  `Math.min(...timestamps)`, which throws once a session accumulates enough tool calls to overflow the
  argument list. It now uses the loop-based min/max the rest of core already switched to.

### Performance

A second sweep, measured the same way (real 53.5 MB transcript, 27 sibling sessions).

- **The new views cost nothing to poll.** `sessionProcesses` re-read the whole transcript on every call
  (122 ms on a 53.5 MB session) — fatal for a tab that refreshes; its transcript half is now memoized,
  **122 ms → 0 ms**, while runtime and output size stay deliberately uncached, since those are exactly
  the two numbers that must keep moving. The feed is a bounded tail by construction (~2 ms warm for a
  session, ~0 ms for an agent).
- **The Overview's remaining per-sibling re-parsing is gone.** 0.8.6 cached each finished sibling's
  change map on disk, but the fleet row also derived an activity sparkline and a to-do list per sibling,
  each re-reading that transcript in a fresh process every refresh. Both now ride the same cached entry:
  `multitask --json` **2.3 s → 1.8 s**, and the full Overview refresh (both spawns) is now **~2.9 s**,
  down from ~29 s before the 0.8.6 sweep.

## [0.8.6] — 2026-07-22

A quality-of-life sweep across the CLI, core, both editors, and the docs, plus four new lenses on a
session: what it ran on, what happened to its context, what it reached for, and what shaped it.

### Added

- **The session's model and reasoning effort, beside its name (both editors)** — the Stats panel now
  says what the session is actually running on: `Opus 4.8 · max effort`. The model comes from the
  assistant turns themselves (sidechain turns are excluded — a subagent may run a different model —
  and synthetic records are skipped), so a session that switched models mid-flight shows the current
  one and flags that it switched, with the full per-model turn counts in the tooltip. Effort is read
  from the structural field current Claude Code stamps on every turn, falling back to the `/effort`
  command echo on older transcripts; a session that never declared one shows nothing rather than a
  guessed default. Backed by `core.sessionVitals`, which rides the same incremental byte cursor
  `sessionUsage` already advances — asking for both costs one `stat()`. Exposed as `usage --json`'s
  new `vitals` object.
- **Compactions are visible everywhere (both editors)** — when the harness runs out of context it
  summarizes the conversation and continues, which is the single most consequential thing that can
  happen to a session: everything above that line reaches later turns as a summary, not as what was
  actually said. Until now the observatory drew nothing. Now each compaction is a first-class
  **Actions** row in its own curated *Compactions* group (`auto · 1M→14k · 986k dropped · 2m 5s`), a
  **marker between chapters** in the Overview, and a **context-fill meter** in the Stats panel whose
  saw-tooth is the session's context filling and being dropped. The per-event drop is derived as
  `pre − post`; the harness's own `cumulativeDroppedTokens` is a running session total, so quoting it
  per event would overstate every compaction after the first.
- **Capability footprint badges (both editors)** — a glanceable row on the Overview for what a session
  actually reached for: file reads and edits (split by whether they landed **outside the workspace**),
  shell commands with their risk tiers, MCP servers, network hosts, and subagent spawns. Also
  `claude-observatory capabilities [--json]` and a per-agent footprint on every fleet row. These count
  what was **exercised, never what was approved**: Claude Code writes nothing to the transcript when it
  prompts for permission, so auto-approved and hand-approved are indistinguishable from the outside —
  the badges say what ran, and the UI says so too.
- **Context sources — what shaped this session (both editors)** — a Context section in Observations
  listing the skills it invoked, the plans it wrote, the memory it read, and whether it was resumed
  from a compaction, alongside the instruction files present where Claude Code auto-loads them. Each
  row is labelled with how we know: `transcript` for things the session demonstrably did,
  `file-present` for files that merely exist in a loaded location — because current builds inject
  CLAUDE.md and memory system-prompt-side, leaving no per-session trace. Claiming those as observed
  would be false; hiding them would omit the biggest influence on the session, so they are listed and
  labelled. Rows with a file open it on click. Exposed as `observations --json`'s new `context` object.
- **The Tasks tab tracks the new task system (both editors)** — current Claude Code builds replaced the
  numbered TaskCreate/TaskUpdate list with background **Agent runs** (task-notifications + per-agent
  transcripts), which left the tab permanently empty. Each agent run is now a task row — subject from
  its spawn description, live status from its own transcript's phase, the agent's in-progress todo as
  the active label — unioned with the legacy numbered rows so either harness generation works
  (`core.allSessionTaskRows`, riding the existing `multitask --json`).
- **Session pickers show session names** — the switch-session dropdown in both editors (and
  `claude-observatory sessions`) now leads with each session's human-readable title (its `ai-title`,
  else the first prompt), with the raw id demoted to the description line. Backed by
  `core.listSessionsWithTitles` and a `title` field in `sessions --json`; the JetBrains chooser now
  builds off the EDT from that JSON, falling back to raw ids if the CLI is missing.
- **Session tokens on the Stats panel (both editors)** — a new section right under the session title
  shows the session's cumulative tokens split the way the API bills them: **input** (uncached),
  **output**, **cached** reads, and the **cache hit rate** (reads ÷ all context sent; cache writes in
  the tooltip). The review scoreboard now sits under its own **Edits** heading. Backed by
  `core.sessionUsage`, which now returns the full split and follows the transcript with an incremental
  byte cursor — a refresh parses only newly appended lines (a no-change refresh is a single `stat()`),
  instead of re-reading a potentially 50 MB transcript. Exposed to the editors via `usage --json`'s new
  `sessionTokens` object (the JetBrains panel now pins it to the visible session with `--session`).
- **Bulk "redo all" across every surface** — the forward mirror of Revert All: `claude-observatory redo
  --all` (plus `--file <substr>` / `--under <path>` / `--ids <a,b,c>` and `--json`, matching `undo`), a
  **Redo all edits** command + toolbar button in VS Code, and a **Redo All Edits** action in JetBrains
  (also registered for Find Action), all backed by a shared `core.redoScope` (oldest-first re-apply).
- **JetBrains parity — the opt-in Claude-insight feature is now reachable**: "Refresh Recap (Claude)"
  on the Observations toolbar and "Analyze Edit with Claude" on an edit (previously the `analyze`/`recap`
  backend and the `claudeBin` setting were wired to nothing).
- **JetBrains parity — 10 session actions registered** (Setup Check, Export Review Summary, Switch
  Session, Clean Store, Install Hooks, Accept All, Revert All, Clear Resolved, Spotlight, Search), so
  they appear in Find Action and can be keybound.
- **JetBrains parity** — Previous/Next edit stepping from inside the diff viewer, and a "Pinned session"
  field in Settings → Tools → Claude Observatory.
- **CLI** — `clean --json`, per-command `--help`, and a `keep #<id> · undo #<id>` next-step footer after
  `diff`. `help` now documents the `chapter` command, `undo --ids`, the `trace`/`agents` aliases,
  `doctor --markdown`, `version --latest`, and `clean --session`.

### Performance

A sweep over the whole read path, measured against a real 53.5 MB transcript in a repo with 27 sibling
sessions. Nothing here changes what any surface reports — every number was diffed against the
un-optimized output first.

- **The Overview refresh went from ~29 s of work to ~4.6 s.** It builds a full change map for every
  sibling session in the repo, nearly all of which are *finished* sessions whose transcript and store
  log will never change again — and it does that in a fresh CLI process every few seconds, where the
  in-process memo can never help. Finished siblings are now memoized on disk, keyed by their
  (transcript, log) stamps: `changemap --json` **14.5 s → 1.6 s**, `multitask --json` **14.9 s → 3.0 s**.
  The session actually being viewed is always rebuilt, since its transcript is still growing and its
  live counts are the ones being watched.
- **The parse cache was thrashing to a ~0 % hit rate.** Its per-kind cap was 128 entries with
  oldest-inserted eviction, but a single session's `subagents/` directory holds 150+ transcripts after a
  big workflow run — so every pass evicted exactly the entries the next pass needed, and each
  "memoized" parser re-ran every time. The cap now fits the real working set and eviction is
  least-recently-*used*: warm `buildChangeMap` **126 ms → 29 ms**.
- **The status line and the JetBrains stats poll no longer re-read the whole transcript.** Both run a
  fresh CLI process per tick, so the in-memory usage cursor never survived for them; it is now persisted
  and resumed, turning a full re-parse into a delta: `usage --json` **160 ms → 50 ms** on that 53.5 MB
  session. Token dedup still carries the complete seen-set — duplicate message ids recur hundreds of
  lines apart in resumed sessions, so a cheaper shortcut would double-count.
- **`metrics` stopped re-reading the transcript for tool latencies** (the last unmemoized full scan in
  that module): **127 ms → 17 ms** warm.
- **VS Code no longer refreshes for other repos' sessions.** The transcript watcher pattern spans
  `~/.claude/projects`, i.e. every project on the machine, so unrelated Claude activity was waking this
  window for a full refresh; arrivals are now filtered to this workspace and its worktree siblings.
  Subagent and workflow transcripts nested under a watched session still count, so a live agent fleet
  keeps updating in real time.

### Changed

- **Status line: three rows, session-first** (bundled `claude-observatory statusline`, vendored from
  claude-statusline) — a new top row carries the clock, the git **branch** (when in a repo), and the
  `~`-abbreviated **path**; the middle row is the session: its **title** (folder name until one
  exists), the model + attributes with a `◷` duration, and **`↑in ↓out ↺cached` token counters**
  (from `usage --json` — the same split as the Stats panel; omitted when the CLI is absent); the
  usage bars stay the last row.
- **VS Code extension publisher is now `cell-observatory`** (was `claude-observatory`), matching the
  GitHub org — the extension id is therefore `cell-observatory.claude-observatory-vscode`. Existing
  installs migrate automatically: `claude-observatory update` installs the renamed extension and removes
  the old-id copy, and the extension itself cleans up a lingering pre-rename duplicate on activation.
- **Consistent terminology & emoji-free copy** — unified the Keep/Undo verbs across the CLI and VS Code
  (the stored/JSON `status` value is unchanged), standardized the CLI warning glyph on `⚠`, and dropped
  decorative 🎉/✨/💡 from output and settings descriptions.
- **VS Code** — rebound `⌥⌘[` / `⌥⌘]` off the built-in Fold/Unfold (→ `⌥⌘-` / `⌥⌘=`); scoped
  `reviewNext/Prev` to `!terminalFocus`; hid context-only commands from the Command Palette; de-conflicted
  the review/spotlight/heatmap icons; fixed the blank "Revert all edits" icon and unified the revert-scope
  glyph; replaced a persistent inline-toggle toast with transient status text.
- **JetBrains** — routine Keep/Undo confirmations now use a transient status bar instead of piling
  balloons into the Event Log; the inline-lens Chat action got a glyph; File History's prev/next diff
  buttons are now directionally distinct.
- **Core robustness** — `settings.json` and the hooks file are written atomically (temp + rename);
  `usageLine` reads a bounded transcript tail instead of loading the whole file; the session-resolution
  caches are capped (like `fscache`); `stats` skips out-of-window sessions.
- **Docs** — documented the Node 18+ and `jq` prerequisites; the Remote/SSH guide now leads with the
  bootstrap one-liner; `bootstrap.sh` continues past an npm global-install permission error (instead of
  aborting the rest of the install) and only downloads the JetBrains plugin when a JetBrains IDE is present.

### Fixed

- **A compacted session no longer renames itself "This session is being continued…".** The summary the
  harness injects after a compaction is a synthesized *user* turn, and it slipped past the guards that
  skip command wrappers — so on any long session it became the first user prompt, and from there the
  session title, the synthetic chapter's title, and the label in both editors' session pickers.
- **A session running background agents or a workflow fleet no longer reads as `done` / `awaiting
  permission` while its agents churn.** The phase classifier's staleness clock now spans the child
  agent transcripts (`subagents/*.jsonl` and `subagents/workflows/*/*.jsonl`), not just the main one —
  so a live 100-agent workflow run keeps its session `working`, visible under the Overview's
  "Active only" filter instead of being dropped as finished.
- **Workflow phase titles parse again on current Claude Code builds.** Newer harnesses serialize the
  script meta's phases with quoted keys (`{"title":"Scope",…}`), which the fallback parser flattened
  into a title/detail string soup; the Workflows pane now shows the real phase names.
- **JetBrains: `claude-observatory update --check` no longer reports a current plugin as perpetually
  out of date.** The installed version is now read from the plugin's own jar
  (`lib/claude-observatory-jetbrains-<ver>.jar` — present for every install method: the bootstrap
  script, the IDE's **Install Plugin from Disk**, and `update`), instead of a `.observatory-version`
  sentinel that only `update` ever wrote. The sentinel remains a fallback.
- **CLI** — bulk `keep`/`undo` no longer print a false-green `✓ … 0 edit(s)` when nothing matched; an
  unexpected error in a synchronous command now surfaces as `claude-observatory: <message>` instead of a
  raw Node stack trace; and `stats`/`usage` validate a provided `--session` like the other commands.
- **Core** — a garbage-collected or externally-deleted blob no longer crashes the metrics / review /
  Overview rollups (it degrades to an empty diff, matching the other readers); unguarded
  `Math.min/max(...array)` at five sites are replaced with loop-based helpers, so a very large session
  can't blow the call stack while building the Overview; and `init` on a malformed `settings.json` points
  at the `.bak` instead of dumping a raw `SyntaxError`.
- **JetBrains** — session-wide **Revert All** and the Edits-tree **Clear Resolved** now report "Nothing
  to revert" / "No resolved edits to clear" instead of silently doing nothing (no-silent-fail parity).
- **JetBrains: the Overview's review-axes row (Diff · File · Folder · Chapter) now wraps** onto
  additional centered lines when the pane is too narrow, instead of the axis toolbars collapsing into a
  "…" overflow — completing the toolbar-wrap fix (the top controls row already wrapped as of 0.8.5).
- **Docs** — the "Remote development" guide link (referenced from the VS Code, JetBrains, and devcontainer
  READMEs) now resolves — its target is a real heading; the `status` sample output and a demo file-path
  inconsistency in DEMO.md are corrected.

## [0.8.5] — 2026-07-21

### Added

- **The self-hosted auto-update paths are now surfaced and wired — getting the latest is effortless on
  every surface, still with no marketplace.** The machinery already shipped; this release makes it
  discoverable and turns every install into an auto-updating one.
    - **JetBrains auto-update, documented at last.** The self-hosted plugin repository (regenerated and
      attached to every GitHub Release) is now printed by every install path — `scripts/bootstrap.sh`,
      `scripts/install-jetbrains.sh`, and `claude-observatory update` — and documented in the README,
      the JetBrains plugin README, and the docs site. Add
      `…/releases/latest/download/updatePlugins.xml` once under **Settings → Plugins → ⚙ → Manage Plugin
      Repositories** and the IDE keeps the plugin current like any Marketplace plugin.
    - **A once-a-day "update available" nudge in the CLI.** Any interactive command now checks (at most
      once per day, in a detached background process) whether a newer release exists and prints a single
      one-line notice — cache-first so it never delays a command, silent when offline, and skipped for
      the capture hot path, `--json` output, and non-interactive callers. Opt out with
      `CLAUDE_OBSERVATORY_NO_UPDATE_CHECK=1`.
    - **`claude-observatory version --check`** prints your installed version next to the latest release
      (a live check; bare `version` / `-v` / `--version` stay a plain one-line print for scripts).
    - A canonical **"Keeping up to date"** section in the README (with a direct `releases/latest` link)
      plus per-surface notes in the VS Code and JetBrains package READMEs and the docs site.

### Changed

- **The VS Code in-editor updater now verifies the download.** The one-click **Update now** notifier
  checks the `.vsix` against the release's published **sha256** before installing (parity with the CLI's
  integrity check) and refuses a mismatch. The notifier itself — a daily background check with
  **Update now** / **Check for updates** — is now documented outside the changelog.
- `claude-observatory update` is described accurately as refreshing the CLI **and** the installed editor
  extensions, not just the CLI.

### Fixed

- **PyCharm/JetBrains: the Overview toolbar no longer clips on a narrow tool window.** The top row
  (session + Accept All / Revert All / Clear Resolved / Export on the left; Search / Active Only /
  Spotlight / Refresh on the right) keeps its left/right split when there's room and now **wraps** the
  right cluster onto a second line when the window is too narrow — mirroring the VS Code toolbar's
  `flex-wrap`. A headless geometry test locks the fit-vs-wrap behavior in.

## [0.8.4] — 2026-07-17

### Fixed

- **Stub-proof session resolution** (both editors + CLI). Local commands (`/effort`, `/model`),
  interrupted commands, abandoned prompts, and `/resume` boot-orphans write transcript files with no
  assistant record; the newest-mtime rule let them displace the session under review, emptying every
  panel behind a misleading "Install the capture hooks" prompt. The active session is now the newest
  transcript **with an assistant record** — demoted, never skipped: an all-stub directory still falls
  back to newest, so first-turn projects and the demo fixture keep resolving.
- **Non-UTF-8 files can no longer be corrupted by a surgical undo/redo.** The 3-way merge path now
  verifies all three inputs round-trip UTF-8 and refuses (conflict, with the byte-exact `--force`
  restore offered) instead of silently rewriting bytes as U+FFFD.
- `doctor` no longer blames working hooks for a fresh or command-only session, and now surfaces
  symlinked subtrees (whose Bash-driven changes the tree diff skips for loop safety).
- Removed the last leftover Clear File wiring (declared removed in 0.8.3; JetBrains never had it).

### Added

- **Four review axes in the Overview nav bar** (both editors). The step-through nav bar grew from two
  axes to four — **Diff · File · Folder · Chapter** — so a reviewer can walk the pending edits at the
  granularity that fits the change:
    - **Folder axis** (new) steps between the changed directories (the change-map's folder buckets),
      shows the folder with its file/edit totals, and accepts or reverts that folder's edits only.
    - **Chapter axis** steps between the session's subtasks (chapters, from Claude's own to-dos/tasks),
      shows the chapter's folder/file/edit totals, and carries Review · Accept · Reject · Chat. The
      chapter's name is shown in the change-map's bottom summary rather than inline.
  The Diff axis gains **Chat** (hand this edit to your Claude) and **View diff** (a real side-by-side
  diff, not the floating lens) plus the edit's relative time; the File axis shows the filename and its
  edit count. Grouping is by chapter (Claude's to-dos/tasks, unified), which is total, and members
  come back in capture order; core adds `chapterForEditId` / `sessionChapters` and the CLI a
  `chapter --of-edit <id> --json` verb. Zero token.
- **The Overview nav bar is now two rows**: the review axes on the bottom, and on top the session
  selector (which now shows the session's **human-readable name**, not its id), the session-wide bulk
  actions (Accept All · Revert All · Clear Resolved · **Export**), and Search · Active only ·
  Spotlight · Refresh pinned right.
- **The change map is labeled and navigable.** Its three sections — **Chapters** (subtask chips),
  **Folders** (the proportional strip), and **Files** (the churn-ranked ledger) — now carry captions
  and hover descriptions, and clicking a folder tile or a chapter chip **navigates the matching nav-bar
  axis**. A **bottom summary bar** reports the pending / accepted / reverted edit counts plus file and
  folder totals for whatever is in scope, naming the current chapter (or folder filter).
- **Hover descriptions** throughout the Overview: the Fleet / Workflows / Tasks panes each open with a
  one-line description, and the tabs, sections, and usage rows explain themselves on hover.
- **Overview panels no longer clip row text** (VS Code): Fleet worktree names, subagent descriptions
  and current tasks, the Tasks list, and workflow agent names wrap to full text instead of ellipsis —
  matching the workflow-name treatment.
- **Honest empty states** (both editors): three mutually exclusive variants — hooks missing / fresh
  session with prior work / fresh workspace — with a one-click **Switch to previous session** for the
  newest same-workspace session that has edits. The Actions view gains an empty state in VS Code.
- **JetBrains whole-file review shortcuts**: `⌃⌥K` / `⌘⌥K` accepts and `⌃⌥R` / `⌘⌥R` reverts every
  pending edit in the active file (parity with VS Code).
- **Manifesto** — a new site page on the philosophy, audience, design decisions, and credits.

### Changed

- **Bash capture is memoized.** A per-session `(mtimeMs, size)` stat cache makes the before/after
  tree walks stat-only for unchanged files (binary verdicts cached too), with a GC-self-healing
  blob-presence guard and a racily-clean 2 s epsilon. Steady state ≈145 ms per Bash call, down from
  ≈200–260 ms; behavior (manifest, deletion detection, skip markers) is unchanged.
- **JetBrains worktree discovery is gated**: the ~10 s `multitask` scan runs only when a new project
  directory actually appears, not every 15 s.
- `clean` reclaims log-less stub-session directories (staging-guarded — an in-flight capture is
  never touched) and reports what it pruned.
- Relative times gain week/month buckets (`3w ago`, `2mo ago`) in both editors.
- Nav bars: grouped, labeled icons with full-width groups; status-bar parity; dark clear tint.
- **Stats** shows the session by name (id in the tooltip), and the Usage **5h / weekly** bars now
  report `~used / total`, projecting the 100% budget from the tokens observed against the reported
  percent.

## [0.8.3] — 2026-07-16

### Added

- **The Overview tracks Claude's task list — fully linked to chapters and edits** (CLI + both
  editors). A third left-nav tab — Fleet · Workflows · **Tasks** — shows the session's numbered tasks
  (Claude Code's newer TaskCreate/TaskUpdate system). Task events are mined from the transcript and
  merged into the same snapshot stream as the TodoWrite to-dos (todos win duplicate titles), so a
  task-planned session gets **real chapters with edit attribution and per-task Accept / Reject /
  Clear** — work that used to pile into the synthesized session chapter now lands under its task. Tab
  rows join their chapters (`chapterId`) to carry live `+added −removed · edits · pending` counts,
  statuses show with a done badge / spinner label / strikethrough, and the transcript history keeps
  archived tasks visible after the runtime prunes their files. `multitask --json` gains the `tasks`
  array (additive), TaskCreate/TaskUpdate classify under To-dos in the Actions timeline, and the
  bundled demo seeds three linked tasks (removed without residue by `demo --clean`). The tab lists
  newest first, completed tasks fold behind a "N done · show all" row (the fleet's dismiss pattern),
  and the Active-only toggle hides them outright. The chapter-row chip buttons also switched to the
  same codicons the Overview toolbar uses.

### Changed

- **Live conflicts moved to the Actions panel** (both editors): the cross-agent contested-files list
  now leads the session's audit surface — expanded by default, orange, click a file to open it — and
  the Overview's fleet nav dropped its conflicts strip. Fleet rows keep their per-agent ⛒ collision
  badges.
- **Revert All warns like it means it** (both editors): the confirmation is now a warning-grade
  dialog stating the full blast radius — "Revert N edit(s) across M file(s)… this rewrites the files
  on disk" — with an explicit count-bearing button, replacing the softer question-style prompt.
- **Nav-bar overhaul** (both editors — the review nav bar on every surface, the Overview toolbar,
  and every panel toolbar/context menu):
  - **Color-coded by action**: keep/accept green · undo/reject red · nav chevrons blue · clear
    orange · search/spotlight/chat purple (the shared chart palette), applied consistently wherever
    an action icon appears — toolbars, chapter chips, context menus, the editor banner, the floating
    lens.
  - **Labeled status bar**: every action button in the bottom status bar carries its short label
    beside its tinted icon; the chevrons stay arrow-only, framing the live File n/m / Diff n/m
    counters.
  - **One icon per action, no glyph reuse**: the session-wide bulk pair got their own glyphs —
    Accept All is now a checklist (VS Code `checklist`, JetBrains commit-check) and Revert All a
    history-rewind (`timeline-view-icon` / VCS history) — so they no longer share icons with the
    file-scoped Accept File (double-check) / Reject File (✕) or the per-edit Keep (✓) / Undo (↩).
    Chapter chips use the bulk glyphs (they ARE the bulk actions scoped to a chapter).
  - **Chat has a real icon**: `comment-discussion` in VS Code (chips, subagent rows, the CodeLens)
    and a speech balloon in JetBrains — replacing the 💬 emoji and JetBrains' lightbulb collision
    with Spotlight. Action icons no longer use emoji anywhere (the 🔬 brand mark stays).
  - **Clear File removed** everywhere: the session-wide Clear Resolved covers it (it was the only
    duplicate-icon action left, and redundant — kept/undone rows clear regardless of file).
  - **The Overview toolbar arranges into five spaced groups** (both editors): Search · session ·
    Active only | Diff axis · Keep · Undo | File axis · Accept/Reject File | Accept All · Revert All ·
    Clear Resolved | Spotlight · Refresh. The JetBrains status bar adopts VS Code's Diff-before-File
    order, and its toolbar-only fleet filters (Clear Completed · Show Hidden · Clear Done Chapters)
    are gone — Active only already hides completed rows, and chapter clearing lives in the chapter
    context menu.
  - **The JetBrains editor banner spells out its buttons**: the bare ↑ ↓ ◀ ▶ ✓ ↩ glyphs became
    labeled, tinted buttons — Search · Prev/Next Edit · Prev/Next File · Accept File · Reject File ·
    Clear · Spotlight — the same icons the nav bar wears.
  - **The Panels reference page shows panels only**: the status-bar / tab-bar / bubble glyph legends
    came off `panels.html` — the workspace map and the per-panel gallery remain, and the gallery
    gains dedicated **Fleet / Workflows / Tasks** figures plus the five-group toolbar in the
    Overview diagram.
  - **All site mockups and GIFs regenerated emoji-free**: the demo/media mockups draw the real
    codicon shapes (mini SVGs) with the product's labels, tints, and the current toolbar — no more
    emoji stand-ins (the 🔬 brand mark stays). The ledger's pending marker likewise switched from
    the ⏳ emoji to the monochrome ⧗ glyph in both editors.
- **Per-platform CI badges**: the CI matrix split into per-OS workflows (Linux · macOS · Windows)
  plus dedicated VS Code (.vsix build) and JetBrains (Gradle suite + plugin zip) workflows, so the
  README now carries live status badges for each platform and editor alongside CodeQL, Pages,
  Release, Dependabot, the latest release, and the license.

## [0.8.2] — 2026-07-16

Presentation fixes across the JetBrains Overview and the web demos.

### Fixed (JetBrains)

- **Spotlight works, everywhere it's offered**: the editor banner's icon-only buttons (Spotlight,
  Clear, and the new Search) rendered their icons but had no clickable hyperlink region — the toggle
  never fired from the banner. They now carry clickable text labels, the dim highlighter renders above
  the syntax layer, and toggling confirms itself with a notification (spotlight only dims files that
  have pending edits).
- **Sparklines and symbol buttons render properly**: activity sparklines are now custom-painted bars
  (the Unicode block glyphs fell back to giant placeholder boxes in IDE fonts), and the chapter ribbon's
  Accept / Reject / Clear mini-buttons, the done-chapters toggle, and the editor banner's search button
  (a tiny "⌕" text glyph) use platform icons instead of glyph text.
- **Fleet / Workflows rows carry the VS Code colors**: working/running blue, done green, awaiting
  orange, errored red, subagents purple, +added green / −removed red, and chart-blue sparklines — the
  same palette the VS Code webview reads from its chart tokens.
- **Workflows tab gets a real renderer**: run, phase, and agent rows are styled and elided like the
  Fleet tab (name in regular text, metrics grayed, painted sparkline) instead of raw clipped strings.
- **Overview toolbar shows text labels** on the same buttons VS Code labels (Keep, Undo, Accept /
  Reject / Clear File, Spotlight, Search, Accept All, Revert All, Clear Resolved, Refresh, Active
  only); the four step chevrons stay icon-only, and the status-bar nav bar stays compact.
- **Change-map detail is readable**: chapter titles, the done-toggle, and the readout move up to the
  standard label font; the chapter ribbon is height-capped and scrolls (a huge session no longer fills
  the panel with chapter rows).

### Changed (both editors)

- **Search Edits leads every nav bar** — the Overview toolbar, the status-bar nav, the editor banner,
  and the Edits tree toolbar all put Search first, in both editors.
- **Search now narrows the Overview ledger too** (it used to filter only the sidebar trees), with a
  readout naming the active query so a filtered-empty ledger never reads as a bug.
- **The module strip caps at 11 segments** — the churn-ranked tail merges into one gray "+K more"
  segment instead of squeezing dozens of unreadable slivers across the strip.
- **The dashboards default to Observations 10% · Overview 80% · Stats 10%** — the master-detail
  Overview is the centerpiece. JetBrains applies the split on every start; VS Code applies it where
  the panel hasn't been manually arranged yet (`initialSize` weights). The ribbon's per-chapter
  Accept / Reject / Clear buttons also grew to a comfortable click size in VS Code.
- **Live-conflict entries open the file**: click a conflict row (VS Code) or the conflict strip
  (JetBrains — a chooser when several files collide) to jump into the contested file.

### Changed (site)

- **The showcase lead demo is fully self-running**: it simulates the review clicks itself (the target
  control flashes as it "presses") and loops continuously; the transport row (dots / skip / pause /
  restart) stays for jumping around, and a gate reached while paused still resolves itself — the
  hands-on version lives on the demo page. Review and Tour left the nav.
- **The full demo got closer to the real editor**: a Claude Edits sidebar joins the IDE frame, the
  stage is wider with no inner scrollbars, and review gates now show a countdown and apply themselves
  if the visitor doesn't respond — interaction is optional everywhere.

## [0.8.1] — 2026-07-16

PyCharm parity fixes and an interactive web demo. No store or `--json` shape changes.

### Added

- **Interactive web demos**: the [showcase](https://cell-observatory.github.io/claude-observatory/)
  now leads with a compact, autoplaying in-browser replay of the bundled demo scenario (gates
  self-resolve while it autoplays; any click hands over control), and a detailed
  [demo page](https://cell-observatory.github.io/claude-observatory/demo.html) lays the same session
  out the way the panels sit in the editor — the file on top, the Observations / Overview
  (Fleet nav + chapter ribbon + module strip + churn ledger) / Stats dashboards docked below, with the
  visitor keeping one edit, reverting another, and accepting the rest. Pure client-side; nothing calls
  a model. The stale local `demo/` scratch folder is gone (the CLI simulator's `observatory-demo/`
  folder is unchanged).

### Changed

- **The demo scenario is now a Python training pipeline** everywhere it appears — the bundled
  `claude-observatory demo` simulator, both web demos, the site mockups, the recorded GIFs and
  screenshots, and the README / walkthrough examples: `src/features.py` gains z-score scaling,
  `src/train.py` wires it in, `src/models/dataset.py` gains `validate()`, a subagent writes
  `tests/test_pipeline.py`, and a workflow writes `docs/USAGE.md`.

### Fixed

- **Live workflow runs show real agent labels again** (CLI + both editors). Newer Claude Code runtimes
  journal only a content-hash key per agent — no label or phase — so a running fan-out degraded to
  `workflow-subagent <id>` rows until completion. Core now derives each live agent's label from its own
  prompt (the first line not shared with its siblings — fan-out prompts share a preamble and diverge at
  the task line), marked with the `~` heuristic convention; the runner's real labels still replace them
  when the run's state file lands.

### Fixed (JetBrains)

- **Blank Overview detail pane**: `JBList` wraps its cell renderer, so reading `cellRenderer` back and
  casting it threw a `ClassCastException` mid-construction and left the master–detail right side
  permanently empty. The renderer is now held directly, and a detail-render failure now paints a visible
  error label instead of a blank pane.
- **Invisible sidebar tabs**: the Edits / Diffs / File History / Actions tabs were icon-only (empty
  display name), which the new UI renders as blank tabs — they now carry their names.

### Changed (JetBrains, VS Code parity)

- **Stats navbar drops the Search-edits box** — VS Code's Stats bar names the session only; searching
  edits lives on the review nav bar (Overview toolbar + status bar).
- **Review nav bar reordered to the VS Code order** — File axis before Diff axis, then Keep / Undo,
  Accept / Reject File, a clear button, Spotlight, Search. The clear button is scoped per host, as in
  VS Code: the Overview title bar carries the new file-scoped **Clear File**, while the status bar keeps
  the session-wide Clear Resolved. The Overview toolbar now leads with the session selector and
  Active-only toggle, with bulk Accept / Revert / Clear Resolved and Refresh after the nav bar and the
  fleet filters last.

## [0.8.0] — 2026-07-15

Real-time multi-agent observability. Observatory now shows *everything Claude is doing across parallel
agents* — including agents running in separate git **worktrees** of the same repo — as it happens. Still
zero-token, local-only, git-free, and cross-editor (CLI + VS Code + JetBrains). No breaking changes: the
store format is unchanged, every existing `--json` shape is preserved (additively extended), and the new
commands are new. Two behavioral notes: the Change Map / Overview chapter id is now a stable content-hash
**taskId** (was positional `ch0`), and chapter attribution is now **total** — the Overview never shows an
"unassigned" bucket (see below). Both editors' renderers were updated in lockstep.

### Added — the Multitasking window (CLI + both editors)

A new bottom-panel view that answers *who is doing what, right now*. One row per running agent (unified
**across worktrees** — see below), each with a live **phase** (working · awaiting-input ·
**awaiting-permission** · idle · errored · done), its worktree + branch, an activity sparkline, its ±diff,
risk count, and a collision badge. Nested under each agent are its **subagents** with their type,
description, current task + to-dos, ±lines, and a chat button. A cross-agent **file-collisions** strip
flags any file two or more agents have touched. Backed by the new `multitask --json` command; both editors
are thin renderers. Real-time: VS Code rides its transcript watcher; JetBrains gained a new
**`TranscriptWatcher`** (per-directory `nio` registration with dynamic new-dir handling and an
ENOSPC→poll fallback) so *all* panels now refresh on any tool call, not only on edits.

### Added — git worktree correlation (git-free)

Claude Code keys its session storage by working directory, so two agents in two worktrees of one repo
land in different project folders that the old fleet view could never connect. Observatory now correlates
them by reading the worktree's `.git` pointer files (`gitdir:` → `commondir`) — **plain-file reads, never
the `git` binary** — and unions them into one logical fleet. Also new: **fleet conflict detection**
(`fleetConflicts`), computed over the *uncapped* file set so a busy agent's 21st shared file is never a
silent miss.

### Changed — the Overview view: master–detail across agents and workflows

The Overview (née Change Map) is now a master–detail panel: a left nav of **Fleet** (running agents
across worktrees, with nested subagents) and **Workflows** (runs), and a right detail showing the
selected item's change-map — chapter ribbon, module strip, and churn-ranked ledger. The old count/size
toggle is **gone** — it always sizes by ±lines now. An **Active only** toggle sits in the title bar
(both editors). And when a **new workflow run starts**, the nav auto-focuses it — switches to
Workflows, selects the run (VS Code pulses its row), and tracks its subagents, phases, and edits live;
the first payload after opening only seeds the seen-set, so opening the panel never steals focus.

### Changed — chapters are total: the Overview never shows "unassigned"

Every edit now belongs to a named chapter. Work done between to-dos fills forward to the nearest
preceding chapter; trailing work joins the final chapter; and a session with no to-dos at all gets a
single **synthesized session chapter**, titled from the session's own title or the first prompt — a goal,
never a bookkeeping bucket. Chapters carry an explicit strict `taskId` for the analytics join and the
💬 chat framing (`null` on the synthesized chapter and duplicate-content rows), and the strict
`unassigned` rollup stays in the JSON for scripts. Chapter review ops are **WYSIWYG**: Accept/Reject/Clear act on exactly
the edits the chapter row displays (`reviewEditIds`) — including gap-filled members and the synthesized
session chapter — so accepting a chapter never leaves stragglers behind, and a partial accept can never
strand edits the buttons can't reach. (Reverts remain conflict-guarded per edit — a mis-anchored undo
surfaces as a conflict, never a silent clobber.) Two to-dos with identical text also stopped
colliding on one ribbon row: the first occurrence keeps its stable id, later occurrences render
display-only. Workflow slices carry their own core-built chapter rollup, replacing both editors'
hand-rolled residual math (which double-counted in JetBrains).

### Added — `demo`: a live simulator that is also a test harness

`claude-observatory demo` replays a scripted session through the **real pipeline** — a genuine transcript,
edits captured by the same hook logic, a subagent with its own timeline, and a workflow run — inside an
isolated `demo-<hex>` session and an `observatory-demo/` folder. Open the Overview and watch chapters,
fleet rows, and observations fill in live; then review the edits for real (Accept/Reject genuinely work).
Nothing leaks: a fully reviewed demo session clears its own store, and `demo --clean` removes every trace.
`--fast` lands the whole scenario in under a second — the e2e suite drives every 0.8.0 `--json` surface
off it. The demo also records itself: `scripts/record-demo.mjs` snapshots the real `--json` payloads at
every beat, renders each through the actual Overview webview code in headless Chrome, and assembles
three recordings — the run (`demo-live.gif`), the workflow arc from the Workflows nav
(`demo-workflow.gif`), and the chapter-by-chapter review ending in the auto-clear (`demo-review.gif`) —
so the site's demo footage is the real UI fed by a real run, never a mock. A PyCharm counterpart
(`scripts/render-pyc-demo.mjs` → `demo-pyc.gif`) mirrors the same beats in the JetBrains panel's native
layout, and the **Getting started** page is built from these recordings end to end.

### Fixed — multi-agent tracking accuracy (stabilization pass)

- **Phase confidence is explicit.** `awaiting-permission` / `idle` / `done` have no transcript marker and
  are inferred from inactivity; agents, subagents, and siblings now carry `phaseConfidence`
  (`high`/`heuristic`) and both editors mark inferred phases with `~` instead of asserting them.
- **Workflows stopped flapping.** A workflow's `running` gate widened from the fleet's 60s freshness to a
  5-minute `WORKFLOW_ACTIVE_MS` (a long reasoning turn writes nothing for minutes); killed runs still age
  out, and a new `lastActivityMs` lets renderers say "active 3m ago".
- **Journal keys can't fake phases.** A key-derived phase is trusted only when it slug-matches a declared
  phase title or is shared by 2+ agents — a future hash format that slips past the regex can no longer
  render one bogus "phase" per agent. The script-meta parser is also string/comment-aware now, so braces
  inside a `description` can't mis-slice it.
- **Collisions include idle victims.** A file pending in two agents now flags when *either* is active
  (was: only when both were) — a live agent can trample an idle agent's unreviewed work. `activeAgents`
  names the moving side so renderers dim the rest.
- Dead code removed: the superseded `overviewTabs` prototype in the VS Code extension.

### Performance — the Overview loads ~2× faster

One Overview refresh used to re-read and re-parse the same multi-megabyte transcript ~6 times per view
(and per worktree-sibling). Core's pure parsers are now memoized per `(mtime, size)`, `changemap` no
longer builds the active session's map twice, and JetBrains panels share one throttled fetch per view
(≤1 CLI spawn per view per ~3s, mirroring VS Code's webview throttle) instead of ~4 spawns every 2s.
On an 18 MB transcript: `changemap` 0.63s → 0.30s, `multitask` 0.68s → 0.40s, before multi-agent gains.

### Added — three-level change tracking, honestly attributed

Every edit is now attributed per **task**, per **subagent**, and per **agent**. Task attribution uses
**strict** in-progress intervals (no edge-filling), so an edit made before the first to-do or after the
last one completes is honestly **unassigned** — never force-filed onto a neighbouring task. Subagent
attribution partitions the store by each subagent's action window; a same-file edit that can't be
unambiguously attributed is left unassigned on **both** sides rather than positionally guessed.

### Added — task-scoped keep/undo + a cross-agent task log

`task-keep`/`task-undo` resolve a taskId to exactly the edits inside its real in-progress intervals (a
destructive-safety invariant: a task's undo set never includes an edit that wasn't part of that task).
`tasklog --json` (`crossAgentTaskLog`) gives one row per task, unioned across every worktree-sibling and
subagent that contributed to it.

### Added — context-preloaded chat about any action

Chat with Claude about **any** action, edit, subagent, or task with the right context pre-assembled —
`chat-context --json` builds a ready-to-paste prompt (target + Claude's own reasoning + the before/after
diff or command/result + task/subagent framing) in core, and the editor hands it to your own Claude.
**Zero-token** — Observatory never calls a model. Replaces the old edit-only chat handoff on every surface
in both editors.

### Fixed — the store's single-writer id hazard

`nextId` read the log outside the append lock, so two concurrent subagent captures (they share one
session) could allocate duplicate ids. Ids are now allocated inside the lock, each record carries a
collision-proof `uid`, and `readLog` re-keys any residual duplicate — so parallel-agent captures can't
corrupt the byId fold, status ops, or undo targeting.

### Tests

Extensive new coverage across the layer: worktree resolution (subdir-launch walk-up, dir/file `.git`,
relative/absolute `commondir`, symlink realpath, bare-repo guard); repo-sibling union + the uncapped
collision regression; the store id-hazard reconciliation; live phase (incl. the stale-mtime
awaiting-permission heuristic) and subagent todos; the hardened linker (overlapping same-file windows →
both unassigned); strict-span taskId (head/tail edits → strictly unassigned, while the display chapter
stays total) + the `tasks[]`↔`rollupByTask` id-space join; the cross-agent task log; task-scoped undo's
destructive-safety invariant; the chat-context assembler (never spawns); chapter totality (no-to-do
sessions, gap/trailing edits, duplicate-content to-dos, ts-less edits); the parser-cache invalidation
contract; workflow freshness boundaries and journal-key trust rules. A new **fast contract rename-guard**
pins the key set of every 0.8.0 machine surface (`multitask`, `changemap`, `tasklog`, `chat-context`,
`observations`, `metrics`, `siblings --repo`) against a demo-simulator fixture, so an editor-breaking
rename fails `npm test`, not just the bash e2e. Plus a new e2e block driving the demo end-to-end
(attribution, auto-clear, `--clean`), VS Code smoke coverage of the master–detail Overview + total
chapters, and JetBrains port, `TranscriptWatcher`, and `MultitaskFilter` parity tests.

## [0.7.6] — 2026-07-14

A polish pass over the 0.7.5 Change Map and the review toolbars: the view is renamed **Overview**, its
module strip is honest and clickable, Actions updates live, and the same **Diff n/m · File i/k** position
now shows everywhere you review — plus a new **Panels** interface reference. No breaking changes; the store
format is unchanged. `changemap --json` keeps the same command and `files[]` shape; only `modules[]` changes
— it is now grouped by module **label** (one row per label, `module === label`), which both editors already
read.

### Renamed — Change Map is now "Overview"

The bottom-panel view reads **Overview** in both editors. The `claudeObservatory.changemap` view id, the
command ids, and the `changemap --json` command are all unchanged, so nothing scripted or docked breaks.

### Changed — the Overview module strip

- **Equal-width segments.** Every module Claude touched gets the same slice, so a low-churn module is a
  clickable segment instead of an unhittable sliver. (It was churn-proportional.)
- **One segment per module label.** `packages/vscode` and `packages/vscode/src` used to render as two
  identically-named `vscode` segments; the rollup now groups by label **in `core`**, so they merge into
  one. Both renderers stay dumb — each changed a single file filter (raw path → label).

### Fixed — chapter attribution

The `in_progress` windows are now disjoint and the first extends back to the session start, so an edit is
no longer double-counted across a revisited to-do, and edits made before the first to-do are attributed
instead of dropped. An edit outside every window is still left **unassigned** rather than mis-filed.

### Changed — Actions

- **Live updates on every tool call.** A transcript watcher refreshes the Actions tree whenever Claude
  does anything — not only on edits — so Reads, Bash runs, and searches appear as they happen (VS Code).
- **No more doubled Subagents.** The raw Subagents category is dropped when the subagent submenu is
  present, so subagents live in exactly one place (both editors).

### Renamed — Spotlight (was Heatmap)

The dim-unmodified-lines toggle is now **Spotlight** in its command title, the tab-bar toolbar, and the
status message (both editors).

### Added — the review position, everywhere you review

The **Diff n/m · File i/k** counters from the status-bar navigation bar now also appear in the **inline
CodeLens** on each edit and in the **inline review bubble** title (both editors). The editor tab bar and
comment-thread toolbars can only render icon buttons, so the counters live where text is allowed — and
they now agree across every surface.

### Changed — the review toolbars

**Switch session** is on every review bar. The Overview toolbar icons are spread out. Per-file
**Accept / Revert all** moved off the Claude Edits sidebar's top bar (too easy to hit by accident) onto the
tab bar and status bar; **Clear resolved** and **Spotlight** join the tab-bar toolbar.

### Added — the Panels interface reference

`docs/panels.html` — a named map of every window, tab, and toolbar button: a master annotated workspace
mockup, a per-pane diagram for each of the five Overview panels, an annotated inline-review bubble, and the
three review toolbars, each control numbered and named. Linked from the showcase nav.

### Docs

Regenerated the VS Code + JetBrains hero screenshots for the five-pane panel and added the annotated
mockups above; the showcase slideshow gains Overview / Spotlight frames with the caption below each image.

### Tests

- Core `changemap (0.7.6)` test — the module-label merge (two `packages/vscode*` files collapse to one
  `vscode` row) and the disjoint-span attribution, including extend-to-start and the gap → unassigned case.
- VS Code smoke test — the CodeLens position counter, the bubble's dual-axis label, and an Overview
  webview block that asserts a hidden view spawns no subprocess.

## [0.7.5] — 2026-07-14

Adds the **Change Map** — a new bottom-panel view that answers the one question the flat lists can't:
*where did this session's work land, and what still needs my eyes?* Zero-token and local like the rest,
and cross-editor from day one (CLI + VS Code + JetBrains). No breaking changes — the store format is
unchanged and every existing `--json` shape is unchanged; `changemap --json` is a new command.

### Added — Change Map (CLI + both editors)

The whole session as one picture, drilling to the same per-edit review as everywhere else. Three layers:
**chapters** (Claude's own to-dos — click one to brush the map down to just the files that goal produced),
a one-row **module proportion strip** (click a segment to filter), and every file **ranked by churn**
with a bar. Colour is **worst-unreviewed-wins**, so a module never reads reviewed while something under
it is still pending. Hover a row for the class touched and Claude's reasoning; click to open the real diff.

Chapter attribution is an honest heuristic, not a guess: a to-do flipping to `in_progress` opens a window
that runs until the next one does, and an edit falling outside every window is left **unassigned** rather
than mis-filed onto the wrong goal.

- **CLI**: `claude-observatory changemap [--root <d>] [--json]` — backed by a new `core` module,
  `changemap.ts`, deriving purely from the transcript + the content-addressed store.
- **Both editors**: a **Change Map** pane beside Observations / Timeline / Actions / Stats — a webview in
  VS Code, a natively-painted Swing pane in the JetBrains Dashboards window.
- **One implementation, two renderers**: `changemap --json` ships the *rendered* rollups
  (`files[]` / `modules[]` — churn-sorted, pre-labelled, status already resolved), so neither editor
  aggregates anything of its own. There is no second implementation to drift.

### Changed — the sidebar container is now "Claude Edits"

The activity-bar container and the bottom panel were **both** titled "Claude Observatory", so docking them
together showed two identically-named tabs with no way to tell them apart. The review sidebar
(Edits / Diffs / File History) is now **Claude Edits**; the bottom panel keeps **Claude Observatory**.

### Changed — the Stats view drops its Search box

Search now has one home: the **Search edits** action in the Edits / Diffs title bar (unchanged). The
duplicate box in the Stats navbar is gone, along with the internal `searchWith` command that only existed
to drive it. The Stats navbar keeps the active session and the clickable pending count.

### Added — a feature tour on the showcase page

`docs/showcase.html` gains a slideshow over all seventeen features — keyboard- and swipe-navigable,
autoplaying only while on screen and never when the visitor prefers reduced motion.

### Tests

- `changemap:` core test — file/module rollups, the pending > undone > kept precedence, module labels,
  chapter windows, and the unassigned-edit case.
- `ChangeMapParser` port-fidelity test (JetBrains), pinning every field the Kotlin panel reads.
- A Change Map webview block in the VS Code smoke test — asserts a hidden view spawns no subprocess and
  that a ledger row drills via `viewChanges`.
- Five `changemap --json` shape assertions in `test/e2e.sh`, including churn conservation
  (`files[].churn` sums to `modules[].churn`) and churn-desc ranking.

## [0.7.0] — 2026-07-13

Turns the observatory from a single-agent into a **multi-agent** view: subagents, sibling sessions,
and a rolled-up metrics command — all zero-token, local, and cross-editor (VS Code + JetBrains + CLI),
mined from the Claude Code transcript and the content-addressed store (no model calls, no network).
No breaking changes — the store format is unchanged and every existing `--json` shape is unchanged; the
`actions --json` payload gains additive `subagents` / `subagentsSummary` / `fleet` / `fleetSummary` fields.

### Added — Subagent tracking (CLI + both editors)

Every subagent Claude spawns (the Task / Agent tool) now gets its **own nested action timeline** plus
**per-subagent metrics** — duration, tokens, tool-use count, status. Mined zero-token from
`~/.claude/projects/<proj>/<session>/subagents/agent-<id>.jsonl` and correlated back to the spawning tool
call via the transcript's `toolUseResult` (which carries `agentId` + `totalDurationMs` + `totalTokens` +
`totalToolUseCount` + `status`).

- **CLI**: `claude-observatory subagents` (alias `agents`) — a human feed or `--json`.
- **Both editors**: a **Subagents** node in the Actions view — each subagent expands into its own
  reads / edits / bash / web calls.

### Added — Fleet / cross-agent awareness (CLI + both editors)

The **other** Claude Code sessions working in the **same project**: active/idle status (from transcript
freshness — active = touched within ~60s), pending edits, files touched, and risk-flag counts.
**Read-only and path-only** — no file contents ever cross between agents, so it can't leak one agent's
secrets to another.

- **CLI**: `claude-observatory siblings` (alias `fleet`) — an agent-facing digest an agent can call
  mid-run to see what its siblings are touching and adjust in real time. `--json` defaults to siblings
  only (excludes self); `--all` includes self.
- **Both editors**: a **Fleet** node in the Actions view.
- An optional MCP server for the same digest is noted as future; 0.7.0 ships the CLI digest.

### Added — Metrics command (CLI)

`claude-observatory metrics` (`--json`) rolls up the session's numbers: per-edit diff stats
(+added / −removed lines), action + error counts, per-subagent duration/tokens, and **tool latency**
(median / p95 / max, computed from each `tool_use` → `tool_result` timestamp gap).

### Added — governance files

`CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) and `SECURITY.md` (private vulnerability reporting via
GitHub Security advisories + `cell_observatory@berkeley.edu`; latest-release-line support policy) at the
repo root.

## [0.6.5] — 2026-07-13

QoL + observability polish on top of the Action Timeline. No breaking changes — the store format and
every existing `--json` shape are unchanged (the `actions --json` payload gains an additive `egress`
field and a per-action `risk`).

### Added — Risk + Egress audit (CLI + both editors)

Two zero-token audits mined from the action timeline (adapted from CortexIDE):

- **Risk** — flags the shell commands Claude ran that can **destroy data** (`rm -rf`, `git reset --hard`,
  force push), **execute remote code** (`curl | sh`), **escalate privilege** (`sudo`), or **touch
  credentials** — as ⚠ high/med badges on those rows in the Actions view, plus `claude-observatory risk`.
  Guarded against string/path false positives (the risky token must be a real command, not text).
- **Egress** — "what did this session touch off-machine?": WebFetch hosts, MCP servers, and
  network-shell commands, each marked **remote** or **unknown** — an **Egress** node pinned atop the
  Actions view, plus `claude-observatory egress`.

### Added — Stats top navbar (both editors)

A bar across the top of the Stats view: the **active session**, a **Search-edits** box (drives the same
filter as the Edits/Diffs trees), and the scoreboard's **pending count is now clickable** — click it to
jump to the first (oldest) edit to review.

### Changed — the inline edit highlight is now clearly visible

The whole-line green/red background over Claude's edited section was a deliberately faint 10% tint; it's
now **~0.30** with a bold **green** change-bar on added lines and a **red** one on removed lines, so an
edited region reads at a glance (both editors).

## [0.6.0] — 2026-07-13

Grows Claude Observatory from an *edit*-review layer into a *session* observatory: a new **Actions
timeline** surfaces every tool call Claude made — not just the file edits the store captures. No
breaking changes — the store format and every existing `--json` shape are unchanged; `actions` is additive.

### Added — Actions timeline (CLI + VS Code + JetBrains)

A zero-token, typed timeline of every tool call in the session — reads, greps, shell commands, web
fetches, subagent spawns, and to-do updates — mined from the Claude Code transcript and correlated with
each call's result (ok / error). File-edit actions link to their store record, so you can jump straight
to the review from the timeline.

- **CLI**: `claude-observatory actions` (alias `trace`) — a human feed or `--json`
  (`{ session, summary, actions, groups }`); filters `--category <c>`, `--errors`, `--limit <n>`, `--all`.
- **Both editors**: a new **Actions** view/panel, grouped by category (Edits, Commands, Web, Subagents,
  To-dos…). Curated by default — high-signal categories plus any errors — with a toggle to show all
  (reads/searches/meta). Errored calls are flagged; edit rows open the review.

## [0.5.5] — 2026-07-13

Adds a review **navigation bar** to the status bar in both editors — adopted from the review toolbar in
the [Void](https://github.com/voideditor/void) / [CortexIDE](https://github.com/OpenCortexIDE/cortexide)
editors. No breaking changes — the `--json` contract and on-disk store format are unchanged.

### Added — status-bar navigation bar (VS Code + JetBrains)

Beside the 🔬 scoreboard, a compact review toolbar now appears while edits await review, with two
stepping axes and inline actions:

- **Diff axis** — `▲ Diff n/m ▼` steps through the open file's pending edits (the counter opens the
  current edit's diff).
- **File axis** — `◀ File n/m ▶` steps across every file with pending edits (the counter opens the
  Edits view).
- **Keep** / **Undo** the current edit (surgical, per-edit), **Accept File** / **Reject File** (the
  whole open file), **Clear resolved**, a **Spotlight** toggle (dims unedited lines so Claude's changes
  stand out), and **Search edits**.

The bar is two-tier: the File axis, Clear, Spotlight, and Search show whenever anything is pending; the
Diff axis and per-edit / per-file actions show only when the open file has pending edits. Every button
reuses existing commands, so behavior matches the tree views and keybindings exactly. The counters track
the active editor, updating as you switch tabs or resolve edits.

### Added — the floating review bubble is now the full nav bar

The inline review bubble (opened from the ✨ marker, or by clicking the status bar's `Diff n/m`) carries
the Diff/File counters in its header and a complete toolbar: **Diff axis**, **File axis**, **Keep/Undo**
this edit, **Accept/Reject File**, and **Chat**. There is only ever one bubble — stepping an axis moves
it in place (it never spawns a second).

### Added — nav bar in the editor tab bar

The editor's top-right action row (VS Code `editor/title`) and the top-of-editor banner (JetBrains) now
surface the nav bar for the open file — Diff axis, File axis, Keep/Undo, Accept/Reject File, Clear, and
Spotlight — so the review controls are reachable without leaving the editor.

### Changed — one "spotlight" (heatmap) icon everywhere

The dim-unedited-lines toggle now uses a single lightbulb icon across every surface (status bar, editor
toolbar, and the JetBrains banner). Accept/Reject **File** use the `check-all` / `close-all` icons so
they read distinctly from the single-edit Keep/Undo.

## [0.5.3] — 2026-07-12

Bug-fix: `update` now actually refreshes the VS Code extension, and never skips an installed extension
in silence.

### Fixed — `update` silently skipped the installed VS Code extension

`claude-observatory update` detected the VS Code extension only when the `code` CLI was on PATH — which
on macOS it usually isn't — so it skipped VS Code entirely, and said nothing, even with the extension
installed. It now detects the extension by its install directory (the way it already detects JetBrains
plugin dirs) and resolves the `code` / `cursor` / `codium` / `windsurf` CLI from app-bundle locations
when it's off PATH, so it can apply the update. If an extension is installed but no CLI can be found to
update it, `update` prints an actionable fix (install the shell `code` command, or the `.vsix` from the
release) and **exits non-zero** — never a silent skip. The same "surface it, don't swallow it" rule now
applies to the JetBrains path too (missing `unzip` / asset / a failed extract is reported and non-zero,
not a quiet success).

### Changed — in-editor "Update now" no longer needs the `code` CLI

The VS Code notifier's one-click **Update now** installs the downloaded `.vsix` via VS Code's own
extension service (`workbench.extensions.installExtension`) instead of shelling out to `code`, so it
works regardless of PATH.

## [0.5.2] — 2026-07-11

Streamlines the marketplace-free update path and tightens revert semantics. No breaking changes — the
`--json` contract and on-disk store format are unchanged.

### Changed — `update` refreshes the installed editor extensions, not just the CLI

`claude-observatory update` previously reinstalled only the CLI (and exited early as "up to date"
before it even mentioned the extensions). It now refreshes everything installed on the machine from
the latest GitHub Release — no marketplace required:

- **CLI** — self-updates via `npm i -g` as before (integrity-checked against the release's sha256).
- **VS Code** — if the `code` CLI (or `cursor` / `codium` / `windsurf`) is on PATH and already has the
  extension, downloads the `.vsix` and `code --install-extension --force`s it.
- **JetBrains** — unzips the plugin into every detected IDE plugin dir that already has it (macOS,
  Linux, Remote-Dev backends, Windows), then prompts for the required full IDE restart. Idempotent via
  a `.observatory-version` sentinel written beside the plugin.

New flags: `--cli-only` (old behavior) and `--force` (reinstall even if current); `--check` now
reports the status of the CLI and both extensions and installs nothing. The VS Code update notifier
also gains a real one-click **Update now** (download + install + reload), falling back to the browser +
"Install from VSIX…" flow when the `code` CLI isn't available.

### Changed — bulk / scoped Revert acts on pending edits only

"Revert All" (session) and folder- and file-scoped Revert now revert only **pending** edits and leave
already-**Accepted** (kept) changes on disk — revert an accepted edit individually if you want it gone.
Applies identically across the CLI (`undo --under`), VS Code, and JetBrains.

### Added — `undo` bulk flags + a palette command

- `claude-observatory undo` gains `--all` (revert every pending edit in the session) and
  `--file <substr>`, matching `keep`'s bulk surface. Every bulk/scoped revert (CLI, VS Code, and
  JetBrains) now runs through one shared `core.undoScope` implementation, so the three front-ends
  can't drift.
- VS Code exposes **Claude Observatory: Show suggestions** in the command palette (previously
  reachable only by clicking a suggestion row).

### Fixed — force-restore keeps review status consistent with disk

A `--force` per-file restore (and its redo mirror) drops later edits to the same file from disk, but
those edits kept their old `pending`/`kept` status — so the tree showed a live edit whose change was
gone, and a later per-edit undo/redo computed against a mismatched file. Those dropped later edits are
now marked `undone`, so recorded status always matches what's on disk.

## [0.5.1] — 2026-07-10

Two review-workflow additions. No breaking changes — the `--json` contract only gains a field, and the
on-disk store format is unchanged.

### Added — folder- and file-scoped Accept / Revert / Clear

The edits bar can now act on a whole **folder** or a single **file** at once, not just one edit:

- **VS Code** — hover a folder or file row in the Edits/Diffs tree for inline icons: Accept all
  (`✓`), Revert all (`⟲`), and Clear resolved (`⌫`). Files already had Accept/Revert; both now also
  get Clear.
- **JetBrains** — the tree's right-click menu gains *Accept / Revert / Clear Resolved in Folder* and
  *Clear Resolved in File* (the tool window has no per-row hover icons; the context menu is the parity
  equivalent).
- **CLI** — `keep --under <path>`, `undo --under <path>`, and `clean --resolved --under <path>` scope
  each operation to a file (exact match) or folder (everything beneath it) with one shared path rule,
  so a sibling like `src/api-v2/` never gets swept by an action on `src/api/`.

Shared in `core`: each tree folder now carries an absolute `path`, `clearResolved` takes an optional
scope, and `isUnderPath` is the single file/folder-prefix predicate every surface uses.

### Added — marketplace-free update notifier (VS Code)

VS Code has no custom-repository mechanism like JetBrains', so the extension now does a throttled
(once-a-day) background check of GitHub Releases and, when a newer version exists, offers to download
the `.vsix` (with *Skip this version*). Also available on demand via **Claude Observatory: Check for
updates**. JetBrains gets real auto-update instead — add the plugin repository
`https://github.com/cell-observatory/claude-observatory/releases/latest/download/updatePlugins.xml`
under Settings → Plugins → ⚙ → Manage Plugin Repositories.

## [0.5.0] — 2026-07-10

A big review-experience upgrade on top of a full-project correctness/security/parity audit. No
breaking changes — the `--json` contract is additive only, and the on-disk store format is unchanged.

### Added — collapse same-code edits into one review unit (headline)

You can't sensibly keep or revert an edit whose result a later edit already overwrote. Successive edits
to the **same code** now collapse into a single review unit, represented by the **most-recent** edit;
edits to different regions of a file stay separate and independently reviewable. The logic lives in
`core` (`pendingGroups`/`reviewEdits`/`keepGroup`/`undoGroup`/`redoGroup`), so the CLI, VS Code, and
JetBrains all collapse identically: the Edits tree and `list` show one net rep per group, keep/undo/redo
act on the whole unit (undo runs newest-first — a clean sequential revert to the group's earliest
before-state), and the inline lens shows one action-row per line. The full per-edit sequence still lives
in the Timeline.

### Fixed — data integrity & correctness (core engine)

- **Undo no longer corrupts non-UTF-8 files.** The restore engine now writes the exact stored bytes
  on every whole-file path and compares state by sha256 instead of round-tripping through UTF-8
  (which silently rewrote latin-1 / invalid-UTF-8 files as `U+FFFD`, even on the clean-revert path).
- **The append-only store is now actually race-safe.** `clearResolved`/GC run under a per-session
  advisory lock (stale-broken so it can't wedge capture), and GC treats in-flight staging +
  `__bash__` manifest blobs as referenced — closing a window where a concurrent capture record could
  be dropped or point at a GC'd blob.
- **Stats no longer over-count tokens/messages ~2.3–2.9×.** Assistant turns are deduplicated by
  `message.id` (current Claude Code emits one JSONL line per content block with identical usage).
- **"Why Claude made this edit" is attributed correctly** — a `Bash` record (e.g. `prettier --write`)
  no longer shifts every later same-file edit's reasoning to the wrong entry.
- Blob writes are atomic (tmp + rename); the stats cache is invalidated on a timezone change; the
  "current session" stats card is internally consistent; JetBrains `listSessions` orders by log mtime
  (matching the CLI) instead of max edit-ts.

### Added — features & parity (CLI + VS Code + JetBrains)

- **CLI:** `insights` (human Observations view), `timeline` (chronological feed), and a real
  `uninstall --all` (reverts the bundled status line only if it's ours; `--purge-store` to delete
  captured edits).
- **Both editors:** a "Next steps" suggestions group, and store maintenance (reclaim disk / drop
  session) — previously CLI-only.
- **JetBrains:** an "Install capture hooks" action, and Project-view badges (`●N`) on files with
  pending edits (parity with the VS Code file decorations).
- **Dropped captures are surfaced** — files too large/binary, or a Bash tree over the cap, record a
  `skip` marker so `status` shows "not captured: N change(s)" instead of silently doing nothing.

### Changed

- **Inline review shows only the _latest_ edit per line.** Stacking a keep/undo menu per edit on a
  shared line was noisy and ambiguous; older same-line edits now live in the Timeline (undoing the
  latest surgically reveals the previous state). Consistent across VS Code and JetBrains.
- **JetBrains performance:** memoized session resolution, blob reads moved off the EDT, faster macOS
  store watching (~2 s vs ~10 s), a StatsPanel timer/listener leak fixed, and a `locate` subprocess
  hang/deadlock guarded with a timeout.
- **Onboarding accuracy:** correct `npm prefix -g` guidance (was the removed `npm bin -g`), a
  working `status` hook-health check for the portable hook, and honest Bash-capture docs.

### Security

- Store directories are created `0700` and blobs/log `0600`; the Bash full-tree walk skips
  secret-bearing names (`.env`, `*.pem`, `id_rsa`, `.npmrc`, …) so it never vacuums them into the store.
- Fixed a ReDoS in the observations "next steps" parsing (O(n²) on transcript-mined text).
- Session ids are validated before any store path, closing `clean --drop ../…` arbitrary deletion.
- Self-update verifies the release asset's sha256 before `npm i -g`, and downloads to a private
  `0700` temp dir.

### Build / CI

- `version:set` now updates `package-lock.json` (and `version:check` verifies it), so a bump can't
  redden `npm ci`. Release + CI use the pinned Gradle wrapper (`./gradlew`). Added Dependabot and a
  guarded `npm publish --provenance` release step.

### Tests

- A regression test ships with every fix, plus a `--json` contract golden test (rename-guard for both
  editors) and JetBrains port-fidelity tests (`TreeParser`/`ObserveParser` + a discriminating
  `listSessions` test).

[0.5.0]: https://github.com/cell-observatory/claude-observatory/releases/tag/v0.5.0
