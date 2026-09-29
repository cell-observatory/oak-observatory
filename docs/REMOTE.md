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
verifies its checksum, starts its server, and registers the machine in herdr. Use SSH keys or an
existing SSH configuration; the operation is non-interactive. The herdr tab is its real client,
including its machine switcher. `HERDR_REMOTE_BINARY` can select a remote binary where needed.
A newer local herdr is left alone; remote provisioning still uses the pin.

OAK joins herdr's live pane identities with captured sessions. A remote prompt is submitted through
`herdr --machine <label> agent prompt`; it never passes through an OAK SSH relay. For an explicit
scripted send, use `oak prompt --session <id> --machine <label> --text "…" --json`. A missing,
blocked, or unavailable pane leaves a clipboard/printed draft, with `sent: false` in JSON.

Review runs where the files, transcripts, and OAK store are available: Keep and Undo revert files on
disk, so a decision can only be made on the machine that holds them. The terminal Review tab applies
this for you. When the reviewed session runs on a saved machine, the tab reads the review from that
machine and runs every decision there over SSH, using that machine's own `oak`, and its session
header names the machine; no store, transcript or working file is copied between machines. Its session
picker (`b`) lists this machine's sessions first and then each saved machine's, from that machine's own
`sessions --json`, read in the background and refreshed about every 15 seconds; a machine that has not
answered, or cannot be reached, is one line saying so. Choosing a row reviews the session on the
machine it is listed under, and the session under the Observatory's cursor, previewed or pinned, is the
one Review shows. Started outside any repo with no `--session` or `--root`, Review opens on the session
that most recently took a turn on any machine, this one or a saved one (on a machine running this
version, a resume alone does not count; an older OAK reports only when a session's file last changed),
as the machines first answer and until you choose a session or act in the Review tab.
Scripts use the same primitive: `--machine <label>` on `views`,
`review`, `list`, `sessions`, `conversation`, `feed`, `multitask`, `subagents`, `diff`, `keep`, `undo`, `redo`, `resolve`, `comment`, `quote` and `ignore` runs
the command on the saved machine and returns its output and exit status unchanged, for example
`oak diff 12 --patch --session <id> --machine build-box`. The remote command runs non-interactively,
in the session's own workspace there (the directory its transcript records, not the SSH login
directory), with `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin` added to its PATH, so OAK must be
installed in one of them (`oak machine add` installs it to `~/.local/bin`). SSH connects with an
8-second connection timeout. The overall command deadline defaults to 120 seconds; set
`OAK_MACHINE_TIMEOUT_MS=300000` for a slow review. A timeout is an error, including when some output
has arrived. A timed-out decision may already have changed files: refresh before deciding whether
to retry. An automatic review refresh waits at least 10 seconds, or twice the previous read's duration
when longer. A refresh after a decision bypasses that delay, waiting only for an existing read to finish.

`oak sessions --json --machine build-box` reads that machine's own captured sessions over SSH.
`oak sessions --json` lists the CLI host’s local sessions, grouped by workspace. Editor windows
use this listing on their workspace host; only the terminal (its Observatory and its Review session
picker) discovers other machines.
Targets must be enabled and uniquely identified by a saved label or id. A local pane wins when the
same session is also listed remotely; a remembered remote owner survives a pane closing or going offline.

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
command and a 60-second outer deadline including machine discovery. Opening a reviewed remote file with
`e` asks you to open it on its owning machine.

SSH uses `StrictHostKeyChecking=accept-new`: an existing key must match, while a first-contact key
is accepted automatically. Saving a machine label alone does not verify that first key; provision
`known_hosts` beforehand when you need verification before first contact. OAK uses existing SSH
connection-sharing settings without changing them. The caller's store-root and `CLAUDE_CODE_*`
identity variables are removed from SSH's environment, including with a broad `SendEnv` rule.
The remote uses its own configured store.

Unit expansion (`keep|undo|redo --ids … --units`), `diff --json`, `comment mark-sent`, and comments using
`--text=…` check the remote CLI's
review protocol before acting. An older build produces an update-required error instead of silently
acting on individual records. This check uses capabilities rather than a version string, since
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

The usage line is **local-only**: it reads the account/cache data and transcripts available on the
current machine. OAK no longer keeps `prefs.remotes` or gathers remote usage,
or exposes the old server relay. `oak server` serves local focus requests only. To focus an
attached local TUI, use `oak focus --session <id> --tab observatory` (or `review`).

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
machine never overlap, and repeated failures back off up to two minutes. Usage remains local-only.

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
