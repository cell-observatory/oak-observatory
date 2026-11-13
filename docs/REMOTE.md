# Remote development with herdr

OAK delegates remote machines and agent terminals to herdr. Configure a machine from the host
where you run OAK:

```sh
oak doctor --fix
oak machine add build-box user@host
oak machine list --json
oak tui
```

`oak machine add <label> <ssh-target>` installs the version pinned in `herdr.lock` on the target over SSH,
verifies its checksum, starts its server, and registers the machine in herdr. Where the target has
Node.js 24 or newer, it then copies OAK to `~/.local/lib/oak`, with a launcher at
`~/.local/bin/oak`, and installs the capture hooks. An `oak` already on the target's PATH that it did not put there,
installed by npm or linked to a checkout, is left as it is, and the capture hooks are installed with it. Use SSH keys or an
existing SSH configuration; the operation is non-interactive. The herdr tab is its real client,
including its machine switcher. `HERDR_REMOTE_BINARY` can select a remote binary where needed.
A newer local herdr is left alone; an existing remote herdr at the pin or newer is accepted on every platform.
On Windows, use Git Bash, MSYS2 or Cygwin as the SSH login shell and install herdr and OAK there first.
OAK accepts herdr on PATH or at `~/.local/bin/herdr/herdr.exe`, finds `oak` on the login shell's PATH
(including npm's Windows prefix), and installs its capture hooks without copying a POSIX launcher.
If either program is missing or herdr is too old, install it on Windows and re-run the add.

Machine add checks the login shell's quoting before installing or saving the machine. Windows OpenSSH
configured to use the WSL launcher as its login shell can lose quoted assignments; connect to the
WSL distro's own sshd instead. Installation scripts travel on stdin. Forwarded OAK commands, updates,
usage reads and sync commands are base64-encoded for the remote shell (`sh` and `base64 -d` are required).
Commands that read input keep it separate from the script; other non-interactive SSH calls receive no stdin.
A failed copy removes that run's temporary files. A failed launcher or version check restores the earlier
OAK bundle and launcher. If the connection is lost and cleanup cannot run, OAK reports the temporary path;
remove it after SSH works again. Capture-hook changes made by `oak init` are best-effort and are not rolled back.

OAK joins herdr's live pane identities with captured sessions. A remote prompt is submitted through
`herdr --machine <label> agent prompt`; it never passes through an OAK SSH relay. For an explicit
scripted send, use `oak prompt --session <id> --machine <label> --text "…" --json`. A missing,
blocked, or unavailable pane leaves a clipboard/printed draft, with `sent: false` in JSON and exit status 75 in every
output mode.

Review runs where the files, transcripts, and OAK store are available: Undo and Redo change files on
disk, and every decision writes the session's edit log, which only the session's own machine writes, so a
decision can be made only on that machine. The terminal Review tab applies
this for you. When the reviewed session runs on a saved machine, the tab reads the review from that
machine and runs every decision there over SSH, using that machine's own `oak`, and its session
header names the machine; reviewing copies no store, transcript or working file between machines. Its `e`
opens the selected file on that machine: a terminal editor (`nvim`, `vim`, `hx` and the others the
options list as terminal editors) runs there over `ssh -t`, and VS Code or Cursor open it from here through
their Remote-SSH extension; other editors say they cannot. Its session
picker (`b`) lists this machine's sessions first and then each saved machine's, from that machine's own
`sessions --json` (or from its records in the local database while `oak sync` keeps them current here and nothing there
may be running), read in the background and refreshed about every 15 seconds; a machine that has not
answered, or cannot be reached, is one line saying so. Choosing a row reviews the session on the
machine it is listed under, and the session under the Observatory's cursor, previewed or pinned, is the
one Review shows. Started outside any repo with no `--session` or `--root`, Review opens on the session
that most recently took a turn on any machine, this one or a saved one (on a machine running this
version, a resume alone does not count; an older OAK reports only when a session's file last changed),
as the machines first answer and until you choose a session or act in the Review tab.
Scripts use the same primitive: `--machine <label>` on `views`,
`review`, `list`, `sessions`, `conversation`, `feed`, `multitask`, `subagents`, `diff`, `keep`, `undo`, `redo`, `resolve`, `comment`, `quote`, `ignore` and `search` runs
the command on the saved machine and returns its output and exit status unchanged (`sessions --json` and `search` are
answered from that machine's records here instead while `oak sync` keeps them current, saying so; below), for example
`oak diff 12 --patch --session <id> --machine build-box`. Printed to a terminal, the output is filtered as
this machine filters its own: colour stays, and other escape sequences are removed. The remote command runs non-interactively,
in the session's own workspace there (the directory its transcript records, not the SSH login
directory), with `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin` added to its PATH, so OAK must be
installed in one of them (`oak machine add` installs it to `~/.local/bin`). SSH connects with an
8-second connection timeout. Stopping the command (SIGTERM, SIGINT, SIGHUP, or SIGQUIT on macOS and
Linux) stops its SSH session too, and the command then ends by that signal. An unexpected error that
ends the command stops its SSH session as well. The command on the saved machine is not signalled, and
may still finish there. A command killed with SIGKILL (`kill -9`) cannot stop its SSH session, which then
runs until the remote command ends. On Windows, only ctrl+c and closing the console window reach the
command this way: when another program stops it, as the terminal app does at its deadline or when it no
longer needs a search, the command ends at once and its SSH session runs until the remote command ends.
The overall command deadline
defaults to 120 seconds; set `OAK_MACHINE_TIMEOUT_MS=300000` for a slow review. A timeout is an error, including when some output
has arrived. A timed-out decision may already have changed files: refresh before deciding whether
to retry. An automatic review refresh waits at least 10 seconds, or twice the previous read's duration
when longer. A refresh after a decision bypasses that delay, waiting only for an existing read to finish.

`oak sessions --json --machine build-box` reads that machine's own captured sessions over SSH, or from the local database
when `oak sync` read that machine in the last ten minutes and nothing there may be running (no session active in the
last two hours, as its records and the files that run saw say, no hand raised in the last day still up): the answer then
says so (`fromIndex`) and how fresh it is (`syncedAt`, the run that read it, and `publishedAt`, when that machine last
published), and leaves out what only that machine can say now (the phase of a session with no hand up, running
workers; a raised hand is the one its records brought, and the session's phase follows it). `oak sessions
--json --synced` adds every other machine's sessions the local database holds from the records `oak sync` brought
(`machines`: each machine's `label`, `host`, `syncedAt`, `publishedAt` and `sessions`, each session `origin: "synced"`).
`oak search --machine build-box` searches that machine's conversations in its records here when `oak sync` read it in
the last ten minutes (an ask typed there is found once that machine has published it and a run has brought it), and over
SSH otherwise. `oak sessions --json` lists the CLI host’s local sessions, grouped by workspace. Editor windows use this
listing on their workspace host: their Switch Session (and VS Code's Timeline session selector) add the `--synced`
machines, each session opened read-only with an offer to fetch it (`oak sync fetch`). The terminal (its Observatory and
its Review session picker) and both editors (Switch Session, Timeline session selector, Overview Sessions and Workers) also ask
each saved machine with `oak sessions --json --machine <label>`, and review a session picked there on its machine with
`--machine`. The editors share one background read per saved machine across these lists: parallel,
at least ten seconds apart, with a 45-second remote deadline. Cached answers show immediately with their age;
a failed refresh removes the old rows and shows the reason and last successful read. Remote patches open
without resolving paths against local files. Keep, Undo, Resolve, comments, quotes and prompts run on the
selected machine. Review lists remote changes and File History follows the remote file selected there. Targets must be
enabled and uniquely identified by a saved label or id. A local pane wins when the same session is also listed remotely;
a remembered remote owner survives a pane closing or going offline.

Task Keep, Undo, Clear and Clear Completed run on the selected machine through `task-keep`, `task-undo` and `task-clear --machine`; a remote failure never falls back to a local task. Search Conversations asks this machine and enabled saved machines concurrently, with the shared 45-second remote deadline (and five seconds for the CLI to return). Every hit names its machine; selecting it reviews that session there. Partial failures keep successful hits and name the machines that could not answer.

The Review keyboard loop steps remote display units and opens their patches. Use Ctrl+Alt+X (Cmd+Alt+X on macOS), then N/P for next/previous edit or Right/Left for next/previous changed file. Single-edit Keep/Undo continues only after a fresh remote read confirms resolution, when Reveal Next on Resolve is enabled. In JetBrains' remote patch dialog, Alt+Up/Down steps edits and Alt+Left/Right steps files. Review also has an inline reply box: Send to agent or Ctrl/Cmd+Enter delivers through `oak prompt --machine`. A blocked or missing agent leaves the draft in the box; switching machines or sessions keeps their drafts separate.

`oak tui --tab review --session <id>`, with or without `--once`, reviews a session this machine does
not hold (no transcript or store here) on the saved machine whose pane runs it or whose session list
includes it. When no saved machine lists it, `--once` fails and the Review panes say so, naming the
machines asked; this machine's store is never read in its place. Remote
session metadata supplies the tab and status details without replacing the Observatory's local catalog.
The Observatory reads remote conversations, session metadata, edit previews and workers on the
owning machine too. Automatic reads wait at least ten seconds and back off for slow responses.
A local sync mirror never supplies a remote session's conversation or facts. An unavailable owner
produces a visible error; if a mirror exists, the detail reports its last sync time without using
its content. `oak conversation --json --session <id> --machine build-box` returns a bounded first
window; pass its byte cursor as `--since <cursor>` on the same machine for the next read. A
`reset: true` result replaces the held conversation. The TUI also returns the optional source token
(`--with-source`, then `--source <token>`) so uncaptured sessions detect replacement across processes. The TUI allows 45 seconds for the remote
command and a 60-second outer deadline including machine discovery. `e` on a reviewed remote file opens it
on its owning machine, as described for the Review tab above.

SSH uses `StrictHostKeyChecking=accept-new`: an existing key must match, while a first-contact key
is accepted automatically. Saving a machine label alone does not verify that first key; provision
`known_hosts` beforehand when you need verification before first contact. OAK uses your SSH
connection sharing as it is configured, with one exception: where `ControlMaster` is on and
`ControlPersist` is off, OAK's own ssh would become the master that other sessions to that host share,
and stopping it (at a deadline, or at ctrl+c) would close them, so OAK's ssh runs with
`ControlMaster=no` and uses a master that is already open. It does the same for a host whose configuration
ssh cannot print (`ssh -G` fails, or runs longer than five seconds). On macOS and Linux, the SSH session
of a `--machine` command or of `oak update` runs apart from your terminal, so ctrl+c reaches OAK, which
stops it. So do the `herdr --machine` commands with which the terminal app reads and acts on a saved
machine, `oak prompt`, `oak quote --send` and `oak comment send` send a prompt to a pane there, and
`oak doctor` times the forwarding to it: stopping `oak prompt`, `oak quote --send`, `oak comment send` or
`oak doctor` (SIGTERM, SIGINT, SIGHUP, or SIGQUIT) stops the herdr command it waits on, and the terminal
app stops its reads when you quit it or close its terminal, or press ctrl+c on its `--once` frame. A reply
the terminal app is already sending still arrives after it ends, as one sent from VS Code does, and a
prompt that has already reached the saved machine may still arrive in its pane. A reply that a JetBrains
IDE is sending when it quits arrives if the IDE leaves `oak` running, and may not if the IDE stops the
processes it started. At its deadline, OAK stops
such a command with herdr's SSH, the SSH of a jump host included. On macOS and Linux, herdr's SSH gets the
same exception as OAK's own: herdr 0.9.1 gives it no option about connection sharing, so where OAK's ssh to
the saved machine's target would run with `ControlMaster=no`, herdr's does too. OAK runs herdr's SSH through a
small `ssh` script that it puts first on the command's `PATH`, kept in the `herdr-ssh` directory of its
store, which only you can write to. A reply the terminal app sends gets `ControlMaster=no` without OAK
asking `ssh -G` first, so that it starts at once; it still uses a master that is already open. When OAK
cannot put that script in place, or the store is on a `noexec` mount where it cannot run, herdr's SSH runs
without `ControlMaster=no`, and `oak doctor` names the machine and why. herdr 0.9.2 and later give that SSH
a connection of their own (`-S` and `ControlPersist`), whose master runs in the background, where no stop
of OAK's reaches it: the script runs it as herdr asks, and `oak doctor` has nothing to name. A jump host's
own connection is outside this: with `ControlMaster` on and `ControlPersist` off for the jump host, the hop that ssh starts
for `ProxyJump` becomes the master for it and ends with the ssh that started it, OAK's or any other,
closing the sessions that share it. Set `ControlPersist` for the jump host to keep them. (On Windows, OAK
never stops herdr's SSH: a deadline ends herdr alone.) None of this SSH asks anything, on the terminal or
in a dialog, and neither does the SSH that reaches a jump host in your SSH configuration (`ProxyJump`, or
a `ProxyCommand` that runs `ssh`), which does not get OAK's or herdr's `BatchMode=yes`: all of it runs
with `SSH_ASKPASS_REQUIRE=never` (OpenSSH 8.4 and newer), so no background read opens your desktop's
askpass dialog. The exception is a FIDO security key (an `-sk` key) that needs a
touch: OpenSSH shows its request for the touch through the askpass program when a display is set, whatever
`SSH_ASKPASS_REQUIRE` says, though that notice asks for nothing. A jump host that needs a password or a
key's passphrase, or that SSH meets for the first time, fails instead, and the command names SSH's reason,
such as `Host key verification failed.` for the first meeting. Connect to the jump host once with plain
`ssh` to record its key, and use a key without a passphrase, or an agent, rather than a password.
`oak machine add`, `oak attach` and `oak agent start --machine` run SSH on your terminal, as OAK does on
Windows, where a jump host can still ask. The caller's store-root and `CLAUDE_CODE_*` identity variables
are removed from the environment of OAK's own SSH, including with a broad `SendEnv` rule, and so is
`XDG_CONFIG_HOME`. Where your SSH configuration expands `${XDG_CONFIG_HOME}`, as in
`IdentityFile ${XDG_CONFIG_HOME}/ssh/id_ed25519`, OAK's own SSH therefore fails before it logs in, with
`invalid environment variable expansion` (exit status 255), rather than going on without that setting:
write the path out in full there.
The remote uses its own configured store.

Unit expansion (`keep|undo|redo --ids … --units`), `diff --json`, `comment mark-sent`, comments using
`--text=…`, and `ignore --dry-run` check the remote CLI's
review protocol before acting. An older build produces an update-required error instead of silently
acting on individual records, or running the `.observatoryignore` sweep that `ignore --dry-run` only counts. This check uses capabilities rather than a version string, since
different development builds can share a version. Remote conversations check a separate
conversation capability and ask you to update OAK on the named machine if it is missing. For comments beginning with dashes, use
`--text=--your-comment`; the TUI preserves this text automatically.

Install OAK's capture hooks on each machine with `oak init` (and `oak init --codex` for Codex). For
VS Code Remote SSH or a JetBrains Gateway backend, install the extension/plugin and CLI on that
remote backend. Inside a devcontainer, install OAK and its hooks in the container. A live pane
listing alone does not copy files or edit history between machines; unavailable transcripts are
reported as unavailable.

`CLAUDE_CONFIG_DIR` relocates Claude's configuration and OAK's default store together. `CODEX_HOME`
selects Codex's configuration. Keep the CLI, hooks and editor backend pointed at the same roots.

Usage is read on each machine for itself, from its own account cache and transcripts, with two
exceptions. Where this machine has no current reading of the Claude account's 5-hour, weekly or
per-model weekly share (a laptop signed in to Claude Code whose agents run on another machine, so its
own shares go out of date), the terminal app, both editors and `oak usage --json` show a saved
machine's reading of the same account and name that machine: `✳ claude (build-box) wk: 22% · mo:
2%`. Whether the account has a five-hour limit is decided by its usage answers alone, never by a
5-hour share: each machine's answer carries when its account last answered with no 5-hour window (as a
verified Ultra account's does) and when it last answered with one, as do its records (a reading in its
local database for each answer, which `oak sync` and the read below carry), and the newest of those answers,
on any machine of the account, decides. While it is a no-limit answer, no 5-hour window is shown at all, whatever
5-hour share a machine holds. The status bars name the machine only for the windows they
show, the weekly and monthly ones; a per-model weekly share from a saved machine is named in the editors'
tooltips and Stats panels, which show it, and a 5-hour share in the Stats panels. The tooltips and
Stats panels also say when that machine measured the reading. OAK compares the time each answer was
printed there with the time it arrived, which bounds the difference between the two clocks by the SSH
round trip, and dates that machine's readings by this machine's clock, so a saved machine whose clock
is fast or slow is still read correctly. At most every five minutes, a detached process runs `oak
__usage-records --json` on each enabled saved machine over OAK's own SSH, with the options and environment
`--machine` uses, except that it never opens a shared connection for other sessions. That machine answers
from its local database with its own usage since the last read, in pages of at most 20,000 rows of each kind: each
message's tokens, its readings of the account's shares, the spend Claude Code reported and the accounts it
is signed in to, never its conversations. This machine keeps them in its local database under that machine,
and that machine's latest readings under the store's `remote-cache/` for a process with no database. A
machine whose record log `oak sync` keeps here current (a segment of it written in the last 15 minutes)
is not asked: its usage arrives with its records. The terminal
app, both editors, `oak usage` and the bundled status line start that process, so while any of them
runs and herdr has a saved machine, these SSH connections run in the background every five minutes.
Claude Code's status line shows the same readings, from the `oak usage` call it makes on every render:
a window that call takes from a saved machine is drawn with that machine's figures, and the machine is
named in a dim label ahead of the windows, `(build-box)`, or `(build-box: wk mo)` when only some came
from it. The status line only draws them. Its cache, which the editors and the other machines read,
keeps this machine's own readings (the newest of its sessions' shares, each dated by its last reply or
its newest subagent's when that is later, its read of the account's usage and its recorded shares), and
a share it measured in the last five minutes stands by the rule below, and no saved machine's share
calibrates its token estimate. The second exception is that estimate: the shares are the account's, so
each machine calibrates its token and dollar estimates against the account's measured usage, which its
local database counts: every message of the account once, by its message id and at its largest snapshot,
from this machine's transcripts and from every other machine's usage the database holds (by `oak sync`'s
record logs, or by the read above), so a transcript synced between machines is counted once, wherever it
ran. Another machine's usage counts only for the account it was billed to. The month's tokens, cache
reads and dollars are the same sum, for machines that bill on the same day, and the budgets come from
that calibration, so machines of the account show the same estimates, budgets and month. The editors'
tooltips and Stats panels name the machines whose usage the estimates include; the status line and the
terminal app's usage bar, which have no tooltip, do not. An OAK on a saved machine from before this read
refuses `oak __usage-records`, and is asked for its readings instead (`oak __usage-brief`, what `oak
usage --brief --json` prints), which are shown as before; so is one whose database does not open there.
No usage records arrive from it, so the totals and estimates add what its answer says it measured of
its own turns, as before this read, until the local database holds any of its usage in the windows they
count; `oak doctor` says so, and what brings its records (update OAK there, or see that machine's own
`oak doctor`). A turn of that machine whose transcript this machine also holds, through a sync other
than `oak sync`, is then counted twice. One from before `oak __usage-brief` too supplies no reading until it is updated. Where this
machine's own database does not open (a file a newer OAK wrote, or a damaged one), every saved machine is
asked for its readings instead.
`oak doctor` has a row for each saved machine the last read asked, saying whether it answered and, when
it gave no reading, why and what to do: SSH could not connect (with SSH's own reason), no answer within
30 seconds, no `oak` there, an OAK there from before this command (update OAK on that machine), or
output before OAK's answer, such as a shell startup file there that prints when the shell is not
interactive; and for a machine `oak sync` keeps current, that it was not asked. It also says when a machine is signed in to another Claude account or has
measured none of its shares itself, and when its clock is a minute or more off. The cache keeps each
outcome with at most one line of what SSH or that machine said. No readout waits on SSH, and a machine
that does not answer keeps its last reading until its shares fall out of their windows. A reading
counts only for the same Claude account: each machine sends a hash of the account id in Claude Code's
`.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when that is set), never the id itself, and a saved
machine with no Claude Code login is never used. Where this machine has no Claude Code login of its
own, there is nothing to match: it uses the one account its saved machines name, and none when they
name two, and the editors' tooltips say that the account could not be matched. On such a machine, a
saved machine signed in to someone else's account is shown as if it were yours, named. Each window then
shows the newest share measured inside it, this machine's own while it is under five minutes old, except
that a later week's share replaces this machine's even then, and this machine's ended 5-hour window
(its reset passed, with no newer one reported there) counts as no window, below any running one. The
month comes whole from the machine whose weekly share is shown, whose month already adds up each
machine's own turns as described above, so two machines' months are never added to each other.
`"machineUsage": false` in `~/.claude/claude-observatory/prefs.json` turns this off: no SSH runs for
it, and the readouts show this machine's own readings only. GPT usage is still read on each machine for
itself. OAK no longer keeps `prefs.remotes` or exposes the old server relay. `oak server` serves local
focus requests only. To focus an attached local TUI, use `oak focus --session <id> --tab observatory`
(or `review`).

## Sync across machines (`oak sync`)

`oak sync` shares the agents' state among this machine and its saved machines (`oak machine list`): Claude Code's
transcripts (with their `subagents/` and `tool-results/` folders), auto memory, plans, skills, agents and commands,
Codex's rollouts, OAK's own store of each session (its edit log, the content snapshots its edits name, its
comments, agent record and hook events), and each machine's record log, what its local database derives of its own
sessions. [The database across machines](https://cell-observatory.github.io/oak-observatory/database-across-machines.html)
explains the local databases, record logs and shared backup folder.
The guide [Database & sync](https://cell-observatory.github.io/oak-observatory/database-and-sync.html) explains
them with worked examples, and
[Multi-agent work across machines](https://cell-observatory.github.io/oak-observatory/agents-across-machines.html)
follows agents on three machines from start to review; this section is the reference. The command line is OAK's
single backend for it, and the terminal app and both editors render its `--json` and change it through it:

- **The terminal app**: the Observatory shows, under each saved machine, what the last run pulled from it and when
  (or why it failed), and under this machine the backup, with its key's fingerprint; the `i` list holds the open
  conflicts after the raised hands; the options window (`o`) has a SYNC section to run it (Enter again stops a run it
  started), show the last run whole, set it up or change the backup (`oak sync setup`, on the terminal), take the
  backup folder's record over (once asked), and include or exclude each saved machine and this project.
- **VS Code**: an OAK sync item on the status bar, with the last run a machine a line in its tooltip; its picker
  (OAK: Sync) runs it, opens each conflict, sets it up or changes the backup, takes the folder's record over, chooses
  the machines and projects, and shows the last run whole. The Timeline's session list has a sync conflicts group.
- **JetBrains**: an OAK sync widget on the status bar with the same menu (OAK: Sync…), a Sync section on the OAK
  Settings page, and the conflicts in the Overview's Sessions tab.

Each conflict there opens both copies (side by side in a diff in the editors, both in your editor from the terminal
app) or deletes the other machine's copy (`oak sync resolve`). Until sync is in use on a machine (a run set it up, a
backup is chosen, or a conflict is open) none of its status shows there, and nothing asks to set it up; the terminal
app's SYNC section and the JetBrains Settings page offer that once a machine is saved, and VS Code's OAK: Sync is in
the command palette. VS Code keeps no sync setting of its own: they are OAK's, in `prefs.json`, changed through
OAK: Sync, as the store's place is through its Store location command. Both editors list the other machines' sessions
it keeps (Switch Session, and VS Code's Timeline session selector), each shown from its records with an offer to fetch
it (a fetched copy's conversation opens here, and its captured edits are decided on the machine that made it), and the terminal app lists
its saved machines' from them while they are current (above). OAK's session lists take a session pulled from a machine
that names its directory differently for a copy and leave it out. Its end-to-end tests run on Linux and macOS; on
Windows it is untested in this release.

```sh
oak sync setup           # choose the backup, make or bring its key, preview a first run (asks on a terminal)
oak sync plan            # what a run would do on each machine; copies nothing
oak sync now             # pull what this machine keeps from every enabled saved machine
oak sync status          # the last run, open conflicts, the index of the other machines' files
oak sync fetch <session> # bring one session here from the machine that made it, or the backup
oak sync resolve <conflict>  # keep your file: the other machine's copy goes to sync's trash
oak sync backup build-box                    # the backup is a saved machine
oak sync backup --folder /groups/lab/backup  # or an encrypted folder: a share, a NAS or a disk
oak sync key [--show | --import | --from <machine>]
oak sync exclude <machine|project>   # and `oak sync include` to undo it
oak sync family <family> <everywhere|backup|on-demand|off>
```

`oak sync setup` asks on a terminal where sessions are backed up (nowhere else, a saved machine, or a folder), and
off a terminal takes `--none`, `--machine <label>` or `--folder <path>`, with `--key-from <machine>` or
`--import-key` (the key on standard input) for a folder that holds a backup already, and `--replace` to keep that key
over a different one here. A folder that holds a record under this machine's name which this machine has not written
(a machine reinstalled, or another machine of the same host name and home) is named with when and by what machine it
was last written, and setup asks on a terminal whether this machine is a reinstall of that one; off a terminal,
`--restore` says it is. It then previews a first run, and says whether anything runs in the background: nothing does
until a machine is saved here or a backup folder is set.
A Windows peer with a Git Bash SSH login shell can use its installed OAK for sync. The remote commands
are `oak __sync-inventory` (with `--publish` for an actual pull), `oak __sync-fetch` (a request on stdin,
file bytes on stdout), and `oak __sync-key`. They use the remote's HOME and inherited PATH and no PTY,
so file bytes are not changed to terminal line endings. No rsync, tar, or remote temporary files are needed.
Native Windows SSH shells such as PowerShell or cmd.exe are not supported by this POSIX transport.
Windows end-to-end operation still needs confirmation on a Windows host.

`oak machine add` suggests it once a machine is saved, and `oak doctor` does on a machine with a saved machine and no
choice made yet; a machine with no saved machine is never told.

Each machine writes only its own disk, and its own files in a backup folder when one is set (below), and pulls from
the others; no machine writes another. Once `oak sync now` has
run on a machine with a saved machine to sync with, or with a backup folder set, the capture hooks (at the end of a
turn and after a tool call) and the pollers that read the saved machines' usage (the terminal app's, VS Code's,
JetBrains' and `oak usage`'s) start a run in the background at most every five minutes, detached, with no daemon or
port of its own;
`"sync": { "auto": false }` in `~/.claude/claude-observatory/prefs.json` stops that. A first run with neither sets nothing up: a saved machine that is disabled, excluded, another account's, or this
machine under another label is none, and one that cannot be reached at the time is one. After a background run that
stopped, or ended before it could say why, the next waits longer each time, until one ends well: 5, 10, 20 and 40
minutes, then an hour. `oak sync now` exits 1 when every machine it asked failed and nothing was pulled, and 0
otherwise, nothing due or everything current included.

Every machine you sync with is trusted with your agents' instructions: skills, agents, commands, memories and plans
are what coding agents follow, and a machine that is compromised can change them on every machine. `oak sync family
<family> off` stops syncing a family on this machine, and `oak sync exclude <machine>` stops syncing with a machine.

### What each machine keeps

| Family | Kept | How copies are reconciled |
| --- | --- | --- |
| `memory` (`projects/<folder>/memory/*.md`), `plans`, `skills`, `agents`, `commands` | on every machine (`everywhere`) | three-way merge |
| `transcripts`, `session-files` (Claude Code), `rollouts` (Codex) | on the machine that made them and the backup (`backup`) | prefix and tail |
| `oak-log` (OAK's edit log of a session), `oak-meta` (its comments and agent record) | on every machine (`everywhere`) | mirrored whole whenever it changes there |
| `oak-blobs` (the content snapshots its edits name) | on the machine that made them and the backup (`backup`) | copied by name, checked by hash |
| `oak-events` (its hook events and the log of waits) | on the machine that made them and the backup (`backup`) | prefix and tail |
| `oak-records` (each machine's record log, `records/<machine>/` in the store) | on every machine (`everywhere`) | prefix and tail; a machine lets go of each segment that a compacted base replaced |

Since every machine keeps every record log, a machine takes each log from any machine it pulls from that holds a
copy, including the log of a machine it has not saved.

A machine adds to its record log as its local database catches up: before it answers another machine's `oak sync now`,
which asks it to catch up first, for up to five seconds (`oak __sync-inventory --publish`; `oak sync plan` asks for
none), so that run takes what it published, and what that leaves, such as a first build too large for it, goes on in
the background (`oak __index-build`), for a later run; as its agents work, once oak sync has run there, through the
background catch-up each capture hook starts at most once a minute, and at once when it raised, changed or lowered a
hand (none under `OAK_NO_BACKGROUND` or `OAK_INDEX=off`, and none for an hour after a build that could not open the
database; a hook never opens the database itself); and whenever OAK lists, searches or queries there. A first run therefore
brings every machine's sessions, with nothing listed anywhere first. The record log carries each session's raised hand
with what it waits on (a question as a question, by its header): at once, but a permission prompt only once it has
stood its wait there (5 seconds, or 90 under Codex's Auto-review), as that machine announces it, so a prompt answered
at once never travels. `oak inbox` lists the other machines' hands with this machine's, most urgent first, each with
its machine and when sync brought it, for a day at most; the terminal app's `i` list, VS Code's session selector and
the JetBrains Sessions tab list them too, and the terminal app, the editors and `oak notify --watch` announce each
once on each machine, naming its machine. A hand is answered on its own machine, and comes down here once that machine
publishes again and a run brings it. Through a backup folder alone, with no machine reading that one over SSH, a hand
reaches the folder with that machine's next sync run: its hooks start one at most every five minutes while its agents
work, and its terminal app or editors do while one is open there.

Claude Code reads the small text files from local disk, so every machine keeps them. A session's files stay on the
machine that made it and on one backup: a saved machine, `oak sync backup <label>`, which pulls every machine's
sessions, or an encrypted folder every machine reaches, `oak sync backup --folder <path>`, to which each machine
writes its own (below). Set the same backup on every machine; a backup machine knows itself by its host name, or by a
saved machine of that label that leads back to it. Every other machine keeps an index of the others' files (their
inventories, under `sync/index/`), which lists them all, and `oak sync fetch <session>` brings one over: from the
machine that made it, or the backup when that machine cannot be reached. A fetched session is kept current by later
runs, as an on-demand copy that is evicted, least recently used first, once the copies pass `sync.cacheMB` (2048
megabytes unless set), and only while the machine it came from, in the inventories that run read, still holds a copy
of its own rather than one it fetched too; one resumed here is no longer a copy, and is never evicted: sync marks it
changed here in `manifest.jsonl`, for good, whatever it records of the file later (the other machine may have gone on
first). `oak sync fetch` itself evicts nothing. A machine keeps current any session it already holds, and pulls its
own sessions back from wherever they are, so a machine that was wiped is restored from the backup on its next run.
`oak sync family <family> <placement>` changes where a family is kept on this machine (`on-demand`: only the machine
that made a session and the machines that fetch it; `off`: nowhere new). Skills that Claude Code downloads from a
claude.ai account (`skills/synced/`) stay its own. Codex's memories and goals databases are not sessions, and sync
leaves them alone.

### OAK's own store

Each machine's store sessions reach every other machine as replicas, under `sync/replicas/<machine>/<session>/` in the
store, keyed by the machine that made them: one Claude Code session resumed on two machines has a store session on each,
and the two never mix. A machine never takes its own sessions back as replicas; a copy of one found elsewhere is put
back where it was (a restore) only when the session is not in the store, or holds nothing but what sync put back (a
restore a run left unfinished goes on the next run), and was not removed there on purpose. A content snapshot that the
session's log there names and its folder lacks comes back whatever else the session holds, as a restore past one run's
2 GB leaves it when an agent goes on in the session before the next run. A restore never lands on a file a capture made
there while it was fetched. An edit log has one writer, the machine that runs the session, but
that machine rewrites it (a clear, an ignore sweep), so a replica is replaced whole whenever the log's device, inode,
size, time or first 4 KB change there, and never by an older copy than the one it holds; the copy it replaces goes to
the trash first, unless the new one only extends it (a log that grew holds all of its old copy). Keep, undo and the
other decisions still run on the machine that made the session.

A session's store folder can be lost with no cleanup (removed by hand, a crash, a machine reinstalled and used before
its first restore), and the next capture makes it again with a new log. That folder is a new generation of the
session, and the history the copies hold of the one before it is never replaced by it. Each session folder has a
generation id, `sync-generation` in the folder, which no capture writes: a run gives a folder it first sees the hash
of its log's first line, which a capture writes once (a random one for a folder with no log yet), and a session it
puts back the generation of the copy its log came from, once that log is back (a capture that starts a log in a
folder a run left half put back makes a new generation). Every copy of a session's files names it. A replica, or the
backup folder's record of the session, whose session was made anew is kept as a session of its own,
`<session>_earlier-<generation>`, beside the new one: it comes back to the machine that made the session like any of
its sessions, the session lists show it there as `earlier history of session <id>`, and it is never replaced again.
A replica is set apart on what its machine says when it answers, and on a newer copy elsewhere (another machine's
replica, the backup folder's record) while it is away. A clear or an ignore sweep rewrites the log in the same folder,
and writes the folder's generation down first where no run has, so the folder keeps it, on a machine that never runs
a sync of its own too.

A session deleted with `oak sessions --delete`, on any machine, is no lost folder: it stays a delete everywhere, its
captured edits are not kept as an earlier history, and its copies go as before. A session cleaned up here (`oak clean`,
below) and captured into again before a run saw it goes on from the generation of the folder cleaned up, which its
line in `sync/evicted.jsonl` names: what the cleanup removed is kept nowhere. An undelete brings back what the backup
folder holds of the session (below); a session undeleted and captured into again before a run put it back is, to
sync, a folder lost and made anew, and what the backup folder held of it comes back as its earlier history.

A session removed from the store (`oak clean --drop`, `--older-than`, `--completed`, `--all`, a dropped session in an
editor) is recorded in `sync/evicted.jsonl` as it is removed, and no copy elsewhere brings it back; the machine's
inventory lists it as cleaned up. Another machine lets its replica go, to its trash, with an audit line and an
eviction record of its own (so no third copy brings it back), once an inventory it reads in that run from the machine
that made the session no longer lists the session and lists it as cleaned up. A replica whose machine does not answer,
or whose machine lost the session without a cleanup (a disk that failed, a store removed by hand), is kept: it may be
the last copy, and that machine pulls it back on its next run. A session made again under an id this machine cleaned
up (one resumed) is a session again, whose loss is a loss. A session deleted with `oak sessions --delete` on any
machine (a delete, not a cleanup) has every replica of it removed, to the trash; where the machine that made it still
holds it, `--undelete` brings the replicas back with the next pull, and where that machine deleted it, its store
comes back from the backup folder, when one holds it. `oak clean --drop` and `oak sessions --delete` refuse the
store's own folders (`sync` among them), whatever the case of the name, which macOS and Windows ignore. Replicas
fetched on demand count toward `sync.cacheMB` and are evicted with the other copies.

The simulator's sessions (`oak demo`, ids `demo-<8 hex digits>`) are in no family and no record log: a machine lists
none of their files to another, serves none when asked, and writes none to a backup folder, so `oak demo --clean`
leaves no trace of them anywhere.

### The backup folder

`oak sync backup --folder <path>` (or `oak sync setup`) makes a folder every machine reaches the backup: a network
share, a NAS or an external disk, which may be readable by others. The path is this machine's own: each machine sets
its own, where it mounts the folder. Every machine writes its own files there once its run has pulled, and every
machine reads it as it reads another machine: a machine restores its own files from its copy there, and keeps current
what it holds of another machine while that machine is off (it makes no new copy of another machine's file from the
folder), and `oak sync fetch` tries the machine that made a session first, then the folder. The folder is never a
source of text to merge.

A machine reinstalled, holding its key, takes its record over with `oak sync setup --restore` (or by answering yes
when `oak sync setup` asks on a terminal), and then restores from the folder everything of its own but the sessions it
cleaned up and those deleted: a restore larger than one run's 2 GB goes on in the next runs, and transcripts older
than its `cleanupPeriodDays` (30 days until it is set) wait in the folder until its retention keeps them. A machine is
known in the folder by its host name and home directory: one reinstalled under another name or home is a new machine
there, and brings the old one's sessions over with `oak sync fetch <session>`.

Two machines can share a host name and home directory (two Macs left with their default names and one user, two
virtual machines made from one image), so a record is written by one machine alone: each machine keeps a random writer
id, `sync/writer` (mode 0600, made at its first push), which every part of its record carries, sealed with the part. A
machine that has no writer id and finds a record under its name (a reinstall, or another machine of the same name and
home) neither restores from it nor writes it, and every run, `oak sync status` and `oak sync setup` say so, with when
and by what machine the record was last written: `oak sync setup --restore` takes it over (its writer id becomes this
machine's), and another machine is to be given another host name. A machine whose writer id is another than the one
the record's last part carries is refused every run the same way. Two machines that share a writer id because one's
sync state was copied onto the other (a virtual machine made from an image, a home folder copied over) are told apart
too: before each part it writes, a machine notes the part's number (`sync/folder/<folder>/wrote.json`), and a part
past the last one it wrote that carries its writer id was written by the other machine. The record is then refused,
every run, on the machine that did not write its last part. A machine's record keeps every file it ever
wrote there but a session it cleaned up and a snapshot its session's log no longer names (the store collected it, or
an ignore sweep dropped it): a file lost here, or not put back yet, is still there.

Everything in it is encrypted on this machine before it is written, with a key that is never written there:

- **The key** is 32 random bytes, made when a new folder is set up, kept in the store at `sync/key` with mode 0600.
  `oak sync key --from <machine>` copies it from another of your machines over OAK's SSH (its `oak __sync-key`, which
  answers your account only), `oak sync key --show` prints it, with a warning, for a password manager, and
  `oak sync key --import` takes it back, from standard input or at a prompt on a terminal that shows nothing of what
  is pasted; never as an argument, which the shell's history and `ps` keep. A different
  key is replaced only with `--replace`, and the old one is kept beside it, as is a key file that holds no key (cut
  short, or edited by hand); a key that does not open the folder set here is refused. Without the key, the folder
  cannot be read, by OAK or by anyone: once no copy of it is left, on any machine or where you keep passwords, choose
  an empty folder for a new backup (`oak sync setup --folder <path>` makes a new key for it), take it on each of the
  other machines with `oak sync setup --folder <path> --key-from <machine>` (`oak sync key --from` alone refuses a key
  that does not open the folder still set there), and remove the old folder by hand.
- **Sealing**: AES-256-GCM from Node's own crypto, a random nonce for each object, with what the object is (its name,
  or its machine and part) bound in, so a file moved to another name fails to open. Objects are named by an
  HMAC-SHA256 of their content's hash under a key derived from yours: a name says nothing of the content, and the
  same content has one name from any machine. Anything that does not open, or opens to other content than its name
  says, is an error the run reports, and none of it is used.
- **Layout**: `oak-backup` (a marker holding a known text sealed under the key, which tells a wrong key at once), `machines/<keyed name>/`
  (each machine's record, written by that machine alone: numbered parts, one per run that changed something, and a
  whole one every 32), `objects/` (objects of 1 MB or more) and `packs/` (smaller objects sealed one by one and packed
  together, up to about 32 MB a pack, since a file made on a share can take milliseconds). Names are lower-case hex, a
  fixed word, or a numbered part (`seg-<n>`, `snap-<n>`), there are no links, and modes and ownership the share forces are ignored.
- **Writes**: a file is cut at 4 MB offsets and its last piece into what each run added, so a growing transcript
  writes only what it grew by; content any machine wrote already is not written again. Every file is written under the
  machine's `tmp/` and renamed; a part of the record comes last, so a run killed part way leaves the folder as it was,
  and the next run removes what it left. Two machines writing at once each write their own record; a large object both
  write is one file of one content, written whole by either, and a pack is named by its content, so neither write
  replaces the other's. An object a file names that is gone from the folder, or cut short, is written again when a file
  names it next.
- **What it refuses**: a record with a missing part, one that went back to an earlier part than this machine read, a
  part or object that does not open, a pipe, device or link where a file or folder of OAK's should be, or a part
  larger than OAK writes (256 MB). Each is an error of the run, and nothing of it is used; the machine whose record it
  is writes it whole again, from what of it still opens and what that machine holds, numbered on past the highest part
  any machine read, so the others read it again from then on. A record under this machine's name that another
  machine's writer wrote, or that this machine has not taken over, is never restored from or written (above). No
  machine writes a part past that size: a record that
  outgrows it (about 1.4 million files) is not written further, and each run says so. A folder that holds other
  machines' records and none of this one's says so, and that this machine's first run writes one, which is its own from
  then on: a new machine, or one reinstalled under another host name or home, is new there (the old one's sessions come
  over with `oak sync fetch <session>`).
- In this release nothing is ever removed from `objects/` or `packs/`: what a machine no longer holds stays there,
  sealed and named by no record, except the segments of its record log that a compaction replaced, which its record
  still names, the text of a session deleted on purpose among them.

### How a run pulls

A run reads each machine's inventory over OAK's own SSH (batch mode, never a shared connection's master), as the usage
readings do: `oak __sync-inventory`, which lists each file of each family with its size and time, a hash for the small
text files, and the working directory each project folder and rollout names. A run (never a plan) asks it with
`--publish`, which first records that machine's own session deletes and undeletes since its last look, as a run there
would (so a machine that runs no `oak sync now` of its own passes them on too), and catches its own local database up, for
up to five seconds, appending to its own record log: the writes a run asks of another machine, for the same user only.
The plan is computed here, and the files this machine keeps are fetched in one SSH round trip per machine with
`oak __sync-fetch`, which only reads.

- A transcript or rollout this machine lacks is pulled whole, and one it holds a shorter copy of is extended: the
  other machine hashes its first bytes, as many as this machine holds, and sends only what follows when they match.
  Either is cut at its last complete line, and the rest arrives on a later run.
- A transcript, session file or rollout written here in the last minute, by anything but sync, belongs to a session
  running on this machine: nothing lands on it, and a later run takes it once it has been still for a minute.
- When they do not match, the two copies have diverged: the other machine's copy is kept under
  `sync/conflicts/<machine>/` and never put beside this machine's in Claude Code's folder, and the conflict is listed.
  So is a whole file sent where a tail was asked for. A tail that starts anywhere but where this machine's bytes end,
  or an answer larger than the file's inventory allows for, is refused, and the run says so.
- A text file this machine lacks is copied. One that differs is merged three ways against the newest version both
  machines had, which sync keeps as a content-addressed object. Changes to the same lines keep both copies, and so
  does text with no version in common, such as two files of one name made apart; text over 16 MB is neither merged nor
  copied. A version that comes back (an edit undone) still reaches the other machines; where it leaves unclear which
  change came first, both copies are kept. Text is merged byte for byte, whatever its encoding.
- Every file is written beside its target and renamed over it, so a run that is killed leaves the old file or the new
  one, never a torn one; the next run removes what it left half written. It lands only over the file as it was read:
  one changed here meanwhile is left for the next run. What a write replaces goes to a dated trash (`sync/trash/`,
  kept 30 days) first, every write is a line in `sync/audit.jsonl`, and the manifest records each file as it lands.
- One run asks each machine for at most 2 GB (a single larger file is still asked for), and reads from it for at most
  10 minutes, as `oak sync fetch` does: a machine that sends slower is stopped there, and what it sent of a session
  lands up to its last complete line. What is left waits for the next run, which `oak sync now` counts as pending.
- One run at a time per machine: a second run while one holds the lock returns `busy`. A run, or `oak sync fetch`, and
  a move of OAK's store (`oak store --move`) never overlap: each refuses while the other runs, naming it, and is tried
  again once it ends.
- A name Windows cannot hold is never synced, on any platform, so no Windows machine is sent one: a `:` or another of
  `<>"|?*`, a control character, a device name such as `CON` or `NUL` (with any extension: `nul.md` is the device too),
  or a name ending in a dot or a space. Another machine's inventory that lists one has it dropped, and its plan says
  how many.

### Where a project lands

Claude Code names a project folder after the path its sessions started in, so one repository can be `-home-you-src-app`
on one machine and `-Users-you-code-app` on another. Each working directory is named by an identity key:

- `git:<host>/<path>`: the origin URL of the repository holding it, normalized (scp-like and URL forms alike, the host
  in lower case, credentials, port and `.git` dropped), with `//<path>` for a directory below the repository's main
  working tree. Only a directory that exists on that machine is identified this way, from the files git writes.
- `home:<path>`: its path under the home directory.
- `share:<server>/<share>/<path>`: a CIFS, SMB or NFS share in the mount table (`/proc/mounts` on Linux, `mount` on
  macOS), so a share mounted at `/groups/lab` on one machine and at `/Volumes/lab` on another is one project.
- `path:<absolute path>`: anything else.

A project lands in this machine's own folder for the same key, or in the folder Claude Code would give the path the
key names here: under the home directory, in a checkout of the same repository that a session here names, or under
the same share's mount. A project with no such path, such as a repository with no checkout here, lands under the other
machine's folder name; resuming one of its sessions needs a checkout here.

### Conflicts, deletes and retention

`oak sync status` and `oak inbox` list the open conflicts, each with its id and where the other machine's copy is kept
(and in `--json`, this machine's file). Resolve one by editing your file (your edit is the merge, which the other machines take) or by
deleting the copy (yours stands): `oak sync resolve <conflict>` moves it to sync's trash and closes the conflict at once,
as the next run would, and waits for no run (it refuses while one holds the lock). A diverged session is resolved only
by deleting its copy, which is then not fetched again until the other machine's copy changes. A session deleted with `oak sessions --delete` is deleted on every machine, and `--undelete` brings it back
everywhere. A memory, plan, skill, agent or command file removed on one machine is removed on the others, to their
trash, unless they edited it since, in which case the edit stands and comes back; a copy that missed edits made before
the delete is removed too. A file made again on the machine that removed it comes back everywhere. A delete or a
restore dated more than a day ahead of this machine's clock (the clock of the machine it came from is wrong) counts as
made a day after it arrived here, and the run warns: as dated, it would outrank every later change until that date.
Claude Code's own retention sweep is no delete: a run never pulls a transcript or plan older than this machine's
`cleanupPeriodDays` (Claude Code's 30 days when it is not set, which `oak doctor` warns about once sync has been used
on the machine), which Claude Code here would delete again.
A family that is missing whole, or lost more than half its files at once, as a folder on a drive that is not mounted
does, passes no delete on, and nor does a file that went with its folder: a folder left empty or missing, a link to a
folder that is not there, a project's folder gone whole, or a cloud drive's placeholder (`.<name>.icloud`) in its
place. A delete that cannot be applied here is a warning, and the run goes on.

### What sync never reads

`.claude.json`, Claude Code's settings beyond `cleanupPeriodDays`, its per-process `sessions/` files, `shell-snapshots/`
and credentials; Codex's `auth.json`, `config.toml` and log and queue databases (its other databases are named and
never opened); and the home's `.ssh`, `.gnupg`, `.aws`, `.netrc` and `.git-credentials`. A symlink that leads to any of
them, or into the Claude or Codex folders from a family, is not followed, to read, write or remove: a name another
machine sends, or a delete it passes on, that would lead through such a link here is refused, and the run names it.
The fetch command refuses any name its family does not hold. A machine whose user name is not this machine's (a
shared lab account) refuses the inventory
and the fetch before it reads anything, and the run names it.

### Transfer and recovery checks

A small file that shrinks during a fetch is refused rather than padded with zero bytes. A record-log segment
restored only through a complete-line prefix is fetched again from that offset until the writer's sealed length is
present. Importing the same backup key repairs its mode to `0600` without replacing its bytes. Sync refuses a family
symlink to a relocated store's current or replaced backup keys, and validates a transcript path before reading its
header so a symlink to credentials is never opened. Preference restoration holds the same lock as a settings save;
a concurrent save cannot be overwritten between the comparison and rename.

### Its state

Under the store's `sync/` folder (which `oak clean` leaves alone): `manifest.jsonl` (per file: size, time, hash, the
machine it came from and its name there, and the versions a text file has had), `objects/` (the merge bases),
`audit.jsonl`, `trash/`, `conflicts/` and `conflicts.json`, `dismissed.json` (the diverged sessions whose copy was
deleted), `tombstones.jsonl` (the deliberate deletes), `index/`, `status.json`, `replicas/` (other machines' store
sessions), `evicted.jsonl` (the sessions removed here, and the replicas let go; `oak uninstall --purge-store` keeps it
while sync has any other state here, since without it the copies other machines keep of the purged sessions come back
with this machine's next run), `key` (the backup folder's key, and `key.replaced-<time>` for each key `--replace`
replaced), `writer` (this machine's writer id), `folder/` (what this machine read of the backup folder, and what it
wrote there last), `settings.json` (a copy of prefs.json's `sync` and `machineUsage`, which every reader takes where an
OAK older than 0.11.0 rewrote prefs.json without them, and the next listing or run writes back), `blobs/README` (which
keeps OAK 0.10's `oak clean` off the folder), and the runs' bookkeeping (`now.lock`, `inflight.jsonl`, `seen.json`, and
the background run's `kick` and `backoff.json`). Each session folder of the store holds its generation,
`sync-generation` (OAK's own store, above). `oak uninstall --all` names the folder among its teardown steps, and the key
in it: keep a copy (`oak sync key --show`) before removing it if a backup folder must stay readable, and keep
`evicted.jsonl` while oak sync runs on another of your machines. It names a backup folder set here too, which it never
removes: the folder holds the backup of each machine that uses it.

### JSON

Every command takes `--json`. The answers of `plan`, `now`, `status` and `fetch` are versioned by their first key.

- `oak sync plan --json`: `{ syncPlan: 1, at, dryRun: true, machines: [...] }`. A machine that gave no inventory has
  `{ label, local, status, detail? }`, where `status` is `shared`, `disabled`, `excluded`, `duplicate`, `unreachable`,
  `timeout`, `no-oak`, `old-oak`, `not-inventory` or `failed`. One that did adds `host`, `retentionDays`,
  `retentionUnset`, `backup` (it keeps every machine's sessions), `pulls: [{ family, from, name, to, action:
  pull|copy|merge, reason: missing|longer|differs, bytes, size, localSize, verify?: 'prefix', origin, originName?, key?,
  unmapped? }]`, `summary: { <family>: { files, bytes } }`, `skipped: { retention, placement, deleted, excluded, off,
  large }` (each `{ files, bytes }`; `large` is text over 16 MB, which is neither merged nor copied), `unmapped: [{
  from, folder, key, cwd, reason, lands, files, bytes }]`, `diverged: [{
  family, from, name, to, localSize, size, note }]` and `warnings`.
- `oak sync now --json`: `{ syncNow: 1, at, durationMs, status: ok|partial|busy|not-due|off, backup: { kind, label,
  self } | null, machines: [{ label, host?, status, detail?, pulled: { files, bytes }, conflicts, pending: { files,
  bytes }, errors, pushed? }], done: [{ family, from, name, to, action: create|append|copy|merge|replace|conflict|skipped,
  bytes, detail? }], tombstones: { recorded, applied }, warnings }`. A backup folder is one line, `backup (<path>)`:
  `pulled` is what came back from it, `pushed: { files, bytes }` what this machine wrote there, and `status: failed`
  with `detail` when it could not be read or used (no key, another key, an altered file, a record under this
  machine's name that it may not use). It exits 1 when every machine it asked failed (none could
  be reached or read, or each that answered had errors) and nothing was pulled; 0 otherwise.
- `oak sync status --json`: `{ syncStatus: 1, setUp, auto, running, last: { at, durationMs, status, machines (as above,
  with lastOkAt), warnings, error? } | null, backup: { kind: 'machine', label } | null, placements: { <family>:
  placement }, exclude: { machines, projects }, conflicts: [{ id, family, name, from, host, at, peerSha256, peerSize,
  copy, localSha256, reason: diverged|no-base|overlap|binary }], index: [{ label, host, savedAt, files, bytes }],
  cache: { files, bytes, capMB }, key: { present, fingerprint?, error? }, project }` (`backup` may be `{ kind: 'folder',
  path }`; `key` is the backup folder's key here, never the key itself); `setUp` is whether a run with a saved machine
  to sync with, or with a backup folder set, has happened here, and `last.error` says why a background run stopped. Each line of `last.machines` adds
  `text`, what `oak sync status` prints after its label, and a backup folder's line that refused its record under this
  machine's name adds `record: unclaimed|other` (`oak sync setup --folder <path> --restore` takes it over; `now` has it
  too). Each conflict adds `file`, this machine's file of it (null where sync does not reach it). `project: { folder,
  key, excluded } | null` is the project in `--root <folder>` (else the folder it runs in), keyed as `oak sync exclude`
  keys it, and whether it is excluded here.
- `oak sync fetch <session> --json`: `{ syncFetch: 1, session, from, done, tried: [{ label, status, detail? }], path }`,
  `from` null when nothing was fetched (the session was here already, or no machine gave it); it exits 1 when no
  machine that holds the session gave it.
- `oak sync include|exclude --json`: `{ syncExclude: { machines, projects } }`; `oak sync backup --json`:
  `{ syncBackup }` (and `key: { fingerprint, made }` with `--folder`); `oak sync family --json`: `{ syncFamilies }`.
- `oak sync key --json`: `{ syncKey: { present, fingerprint?, path? } }`; with `--show`, `{ syncKey: { key,
  fingerprint } }`; with `--import` or `--from`, `{ syncKey: { present, fingerprint, path, replaced? } }`, `replaced`
  the file the key it replaced was kept in. `oak sync setup --json`: `{ syncSetup: 1, backup, key: { fingerprint,
  made, imported } | null, record?: { state: none|mine|unclaimed|other, lastWrite?, claimed? }, plan, planError? }`,
  `record` for a folder: whose its record under this machine's name is, and `claimed` when setup took it over. For a
  folder that holds a backup this machine's key does not open (none here, or another), it exits 1 with `{ syncSetup: 1,
  needsKey: true, folder, error, keyHere }` and changes nothing: the key comes with `--key-from <machine>` or
  `--import-key`, and `keyHere`, when not null, is the fingerprint of another key this machine keeps, which the one
  brought replaces only with `--replace` (the old one kept beside it). On a terminal setup asks before it replaces it.
- `oak sync resolve <conflict> --json`: `{ syncResolve: 1, id, family, name, from, trash, closed }`, `trash` where the
  other machine's copy went (null when it was gone already) and `closed` the conflicts this closed (that one, and any
  other resolved meanwhile).
- `oak inbox --json` has `sync: [{ id, family, name, from, copy, at, reason, file }]`, the open conflicts, `file` as in
  `status`. Its `hands` include the other machines' raised hands as their records brought them, each with
  `origin: "synced"`, `host` (that machine's id), `machine` (the label this machine knows it by), `syncedAt` (when oak
  sync last brought its records, this machine's clock) and `publishedAt` (when that machine last wrote them, its
  clock), and no `question` (what a question asks is read from its transcript, on that machine). `oak sessions --json`
  carries the same rows as `syncedHands`, absent when there are none, and `oak inbox --next --json` adds `elsewhere`,
  how many of them wait (a turn's end aside), since the jump goes to this machine's own only.

## Keeping agents running when the laptop closes

An agent runs on the machine whose herdr server owns its pane. Agents in a remote machine's panes,
whether started from herdr's sidebar, with `oak agent start --machine` or in an `oak attach`
session, do not depend on the laptop: closing its lid, losing the connection, detaching (`ctrl+b`
then `q`) or quitting OAK ends only the view, provided the remote's herdr server outlives the SSH
login that started it. Agents in the laptop's own panes stop while the laptop sleeps.

On Linux, systemd-logind decides whether the server outlives that login. With
`KillUserProcesses=yes`, logind stops every process of an SSH login when the login ends, including
processes detached from its terminal. KDE neon enables it in `/usr/lib/systemd/logind.conf.d/`;
Ubuntu and Debian default to `no`. When no server is running, herdr's client starts the remote
server inside the SSH login of the attach, so on such a host the server, its panes and their agents
stop when that login ends. A sleeping laptop ends it too: the connection is closed when the laptop
wakes, or by the remote host once the connection times out. To check a machine:

```sh
# "b true": a login's processes end with the login
busctl get-property org.freedesktop.login1 /org/freedesktop/login1 \
  org.freedesktop.login1.Manager KillUserProcesses
# ".../session-<n>.scope": the running server lives inside a login
cat /proc/$(pgrep -f -x '.*/herdr server' | head -1)/cgroup
```

When `oak doctor --fix` or an installer starts the herdr server from inside a login on such a host,
it starts it in a user scope of its own (`systemd-run --user --scope`, unit
`oak-herdr-server-<n>`). That scope belongs to the user's systemd manager, which stops at the last
logout unless lingering is enabled (`loginctl enable-linger`); `oak doctor --fix` warns when it is
not. To move a server that already runs inside a login, run `herdr server stop` on that machine,
which closes every pane, then `oak doctor --fix` there. herdr reopens the panes and resumes their
agents' sessions when the next server starts; the turn in progress at the stop is lost. Later
attaches connect to that server instead of starting another. A logind drop-in in
`/etc/systemd/logind.conf.d/` with `KillUserProcesses=no` (root required) keeps every login's
processes, including servers started by herdr's client.

No process runs while a Mac sleeps, and a MacBook sleeps when its lid closes unless it is in
closed-display mode (connected to power and an external display). Run agents that must keep
working on an always-on machine and attach to it from the laptop.

## Forwarding latency

`oak doctor` times one `herdr --machine <label> pane list` for each saved machine. Calls taking
more than eight seconds produce a warning with SSH connection-reuse settings for that target:

```sshconfig
Host build-box
    ControlMaster auto
    ControlPath ~/.ssh/cm-%r@%h:%p
    ControlPersist 10m
```

OAK does not change SSH configuration. The Observatory allows 30 seconds for a remote call;
set `OAK_HERDR_REMOTE_TIMEOUT_MS=60000` before launching OAK for slower forwarding. Calls for one
machine never overlap, and repeated failures back off up to two minutes. The saved machines' usage
readings described above use OAK's own SSH, not this forwarding.

`oak doctor --fix` also stops an outdated local OAK focus server and verifies that node-pty can
spawn a terminal child. When an unpacked `spawn-helper` lacks executable permissions, it repairs
them and retries. Neither repair stops herdr's agent terminals.

`oak doctor` also inspects the running herdr server's environment (Linux and macOS; elsewhere the
row says it could not look). A server started from inside a Claude Code session carries that
session's identity (`CLAUDE_CODE_CHILD_SESSION` and related variables, plus `GIT_EDITOR=true`), and
every agent started in its panes inherits it: Claude Code then turns transcript saving off, so those
sessions cannot be resumed and have no conversation to show, and `git commit` in those shells aborts
on an empty message. OAK strips the identity from the server `oak doctor --fix`
and the installers start and from the client its herdr tab spawns; a server already running keeps
it until it is restarted from a terminal outside herdr (`herdr server stop`, which closes every
pane, then `oak doctor --fix`).

herdr's sidebar is sized by the client that draws it: the divider drags with the mouse between
`ui.sidebar_min_width` and `ui.sidebar_max_width` (double-click resets it), and the ceiling is 36
columns by default — which is what stops the drag. The installers, `oak update` and
`oak doctor --fix` write `ui.sidebar_min_width = 48` and `ui.sidebar_max_width = 72` into the
`config.toml` of the machine they run on, unless a sidebar width is already set there (set any of
the three yourself, `sidebar_max_width = 36` say, and OAK leaves the widths alone), and set
`theme.name = "gruvbox"` only when no theme name is set, preserving existing theme choices. A running server
reloads its config and a client on the same machine follows at once; a client attached from another
machine reads its own config, and picks a change up on its next reload (herdr's `reload_config` key:
the prefix, `ctrl+b` by default and `ctrl+b ctrl+b` inside tmux, then `shift+r`) or attach. The
machine whose `herdr` you are looking at is the one whose config applies — with `oak attach`, that
is the machine you attach from. `oak machine add` leaves the remote's config alone; run
`oak doctor --fix` there if you open herdr on that machine directly.
