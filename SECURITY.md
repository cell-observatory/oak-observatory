# Security Policy

OAK is a local-first, zero-token review + observability layer over
Claude Code and Codex. Its content-addressed snapshot store lives on the machine where
the edits were captured, under `~/.claude/claude-observatory/` by default. Optional sync copies
records and snapshots to the saved machines and backup you configure. It performs no model inference
of its own and sends no telemetry. Agents launched or prompted through OAK use their native CLI’s provider
connection and permissions. OAK’s network paths are:

- **`analyze` / `recap` / `suggest`** — opt-in; each runs your local `claude` CLI
  (which then makes its own model calls).
- **`update`** and **`install-extensions`** — fetch a GitHub Release's assets to update
  OAK or to install its editor extensions. Unless run with `--here` or `--cli-only`,
  `oak update` then reaches each enabled saved machine over SSH and runs that machine's
  own `oak update --here`, which reads the release list from GitHub there and downloads
  and installs what that machine needs from the release (with `--check` or `--json`, it
  only reads the plan). The editors' **Update now** runs `oak update` on every click, so
  it reaches the saved machines too. Installing the CLI (`npm i -g` of the release's
  tarball, here and on each saved machine) has npm download its optional dependency
  node-pty, and node-pty's node-addon-api, from your npm registry; where node-pty ships
  no prebuilt binary (Linux), npm builds it, and node-gyp downloads the Node.js headers
  from nodejs.org unless it has them already.
- **Update checks** *(automatic)* — these read
  `https://api.github.com/repos/cell-observatory/oak-observatory/releases` to learn
  whether a newer version exists. The request carries no session data.
  - The CLI checks at most once a day, and only in an interactive terminal;
    `CLAUDE_OBSERVATORY_NO_UPDATE_CHECK=1` turns it off.
  - The VS Code extension's update notifier checks when a window opens, at most once a
    day after a check that succeeds (a failed check is retried when the next window
    opens), except in an install that a marketplace updates, on the stable channel.
  - Both editors' version chips, on the Overview, check however the extension was
    installed. VS Code's reads the list when the Overview or the chip's menu opens, at
    most once an hour in each window after a read that succeeds; a failed read is
    retried on the next open. JetBrains' runs `oak version --check`, which reads
    the list on every call, about once an hour while the Overview is open, and every
    five minutes until a read succeeds. `CLAUDE_OBSERVATORY_NO_UPDATE_CHECK` does not
    turn the chips off.
- **`oak models use <name>`** — runs `ollama pull <name>` when that model is not
  already local; ollama downloads it.
- **OAK installation** — the release installers (`scripts/bootstrap.sh`, and `install.ps1` on
  Windows) download OAK's CLI tarball from this repository's GitHub releases and check it against
  the SHA-256 digest GitHub lists for that asset, read from the same release listing. That catches a
  corrupted or altered download, not a compromised release, and when GitHub lists no digest the
  installer warns and installs the tarball anyway; npm's own downloads for that install are those
  of `oak update` above. `install.sh` builds from its own checkout: its `npm install` downloads the
  dependency tree locked in `package-lock.json` from your npm registry, and on Linux node-gyp
  downloads the Node.js headers as above. With `--jetbrains`, it also builds the JetBrains plugin with
  `./gradlew buildPlugin`, which downloads, unless Gradle has them already, Gradle itself from
  services.gradle.org, which redirects that download to GitHub (github.com/gradle/gradle-distributions),
  the build's Gradle plugins from the Gradle Plugin Portal, the IntelliJ Platform from JetBrains'
  repositories, the other dependencies from Maven Central, and, on a machine with no JDK 21, a JDK 21
  that Gradle finds through foojay.io.
- **herdr installation** — `oak doctor --fix`, `oak update`, and both installers
  (`install.sh` and `install.ps1`) download the binary pinned in `herdr.lock` from
  [herdr's GitHub releases](https://github.com/herdrdev/herdr/releases) and verify
  its SHA-256 checksum before installation. A newer local herdr is left alone.
- **`oak machine add <label> <ssh-target>`** — over SSH and SCP, installs the herdr
  version pinned in `herdr.lock` at `~/.local/bin/herdr` on the target when it has none
  or an older one: it copies this machine's herdr when the platform and version match,
  and otherwise first downloads the target's binary from herdr's GitHub releases and
  verifies its checksum. On macOS it removes the binary's quarantine attribute. It
  saves the machine in herdr (`herdr machine add`). When the target has Node.js 24 or newer,
  it then copies OAK's own files (`cli.js`, `capture.js`, `index.js`,
  `package.json`, `THIRD_PARTY_NOTICES.md` and OAK's herdr plugin) to
  `~/.local/lib/oak`, writes an `oak` launcher to `~/.local/bin`, appends a line that
  puts `~/.local/bin` on the PATH to `~/.profile`, `~/.bashrc` and `~/.zprofile`
  (creating any that are missing), and runs `oak init` there, which writes OAK's capture
  hooks into the target's `~/.claude/settings.json` and Codex's `~/.codex/hooks.json`,
  and adds trust entries for those hooks to `~/.codex/config.toml`.
- **SSH commands you run** — `oak <verb> --machine <label>` runs one of `fleet`, `views`,
  `review`, `list`, `sessions`, `prompts`, `conversation`, `feed`, `processes`, `multitask`, `subagents`,
  `diff`, `keep`, `undo`, `redo`, `resolve`, `clean`, `task-keep`, `task-undo`, `task-clear`, `chat-context`, `comment`, `quote`, `ignore`, `search`,
  `editor-review`, `locate` and `install-extensions`
  with the saved machine's own `oak` over SSH; the terminal app's session picker runs
  `search` on each saved machine when your typing in its search box pauses. The editors search saved machines in parallel when you choose Search Conversations, with each result naming its machine.
  Opening a remote review reads its edit snapshots and, when no matching mount is available, writes a
  private editor request on that machine, consumed once and expiring after ten minutes. Mounted-file
  placement sends the current editor buffer to that machine through `locate`; review decisions run there.
  The missing-extension offer runs `install-extensions` there only when you accept it.
  `oak attach <machine>` starts OAK in a herdr pane on that machine and hands your
  terminal to herdr's client there.
  `oak agent start --machine <label>` starts an agent in a pane there (running
  `oak machine add` first when the machine is not saved yet), and
  `oak prompt --machine <label>` sends a prompt to a pane there; these go through
  herdr's SSH connection. So does a prompt to a session that no herdr pane on this
  machine runs, sent with `oak prompt`, `oak quote --send`, `oak comment send` or an
  editor: OAK asks each enabled saved machine's herdr for its panes and sends the
  prompt to the pane that runs the session. `oak doctor` times one forwarded `herdr pane list` on each
  saved machine. OAK's own `ssh` and `scp` calls run in batch mode and accept a host
  key on first contact (`StrictHostKeyChecking=accept-new`), refusing a changed one.
- **Saved herdr machines (automatic)** — the terminal Observatory requests
  per-machine snapshots over herdr's SSH tunnel. Over the same tunnel it keeps each
  machine's `btop` tab (it makes the tab, labels its pane and types the monitor's
  command into that pane's idle shell) and renames the herdr tabs that machine's own
  OAK cannot name: all of them when that OAK predates `oak __tab-sync`, and the tab of
  a session whose capture hooks never ran in its pane there. For a Codex pane there
  that herdr reports as blocked, it can also read the pane's visible screen over the
  same tunnel (`herdr --machine <label> pane read`). It reads it only while the
  session's turn is open, no permission prompt waits, and the rollout has been quiet for
  90 seconds, and again every 15 seconds while that holds. It keeps only whether
  Codex's running timer was on the screen. Over SSH to each enabled saved machine it
  also runs that machine's own `oak` to read its session list (read from the local database
  instead while `oak sync` keeps that machine's records current here and nothing there may
  be running) and,
  for a session running there, the conversation, edit previews and workers; each is
  refreshed at most every ten seconds. When a session's title there differs from its
  tab's name, it runs that machine's `oak __tab-sync` over the same SSH path, which
  renames the session's herdr tab (never one you named) and records that name in the
  machine's own store.
  When you review a session that runs on a saved machine, the Review tab's reads and
  your review actions (keep, undo and the rest) run that machine's `oak` over the
  same SSH path. Reviewing copies neither transcripts nor edit stores off that machine; only oak sync
  does, once you run it (below).
  VS Code and JetBrains session listings also read each saved machine's session list over the
  same SSH path (`oak sessions --machine`), and reviewing one of those sessions runs
  that machine's `oak` there as the Review tab does. These reads run in the background,
  in parallel, at most once per machine per ten seconds, with a 45-second remote deadline.
- **Account usage** *(automatic)* — to keep the Usage bars live (context, 5-hour,
  weekly, and monthly), OAK calls `https://api.anthropic.com/api/oauth/usage` with
  Claude Code's stored OAuth token, and when that token has expired refreshes it
  against `https://platform.claude.com/v1/oauth/token`, writing the rotated token
  back to the same place Claude Code keeps it — the `~/.claude/.credentials.json`
  file, or the macOS login keychain (service `Claude Code-credentials`). The five-hour window remains in Stats, `oak usage` and the
  Claude Code status line; terminal and editor status bars omit it. It reads
  and updates only that existing Claude Code credential and sends nothing else. It
  runs whenever usage is shown — `oak usage`, the editors' Usage panel, and the
  bundled status line each kick it — once the cached reading is over a minute old,
  at most one refresh every 45 seconds, and it backs off for five minutes after a
  rate-limited or unavailable reply. There is no dedicated off switch today; it
  simply does nothing when no credential is stored. Avoiding usage displays means avoiding the terminal app’s
  usage polling, the editors’ usage polling, `oak usage` and the bundled status line.
- **Account usage from saved machines** *(automatic)* — so that a machine with no
  current reading of the Claude account's 5-hour and weekly shares can show the reading
  another machine took, and so that each machine's token and dollar estimates count the
  usage of every machine of the account once, OAK runs `oak __usage-records --json` on
  each enabled saved machine over its own SSH (batch mode, as above, never opening a
  shared connection for other sessions), at most every five minutes, in a detached
  process started by the same pollers as the account-usage read: the terminal app, both
  editors, `oak usage` and the bundled status line. While any of them runs and herdr has
  a saved machine, OAK therefore connects to each enabled saved machine over SSH every
  five minutes in the background, except to a machine whose record log `oak sync` already
  keeps current here. That machine answers from its own local database, making no network
  request for it: its usage since the last read, as rows of its database. Each assistant
  message's id, its session's id, model, time, token counts and list-price cost; each
  share it read of the account's windows, with when it was measured, its reset, its
  token estimate and budget, the per-model cap's name, and when the account last
  answered with no five-hour window and with one; the spend Claude Code reported for
  each session; which account each agent there is signed in to; and the sessions
  deleted there. Never an ask, an answer, a title or a path. It names the machine by a
  hash of its host name and home directory
  (the first 12 hexadecimal digits of their SHA-256), so that no machine is counted
  twice, and the account each row was billed to by a hash of its Claude account id (the
  first 12 hexadecimal digits of the SHA-256 of `oauthAccount.accountUuid` in Claude
  Code's `.claude.json`). An OAK there from before this command, or one whose local
  database does not open, is asked for its readings instead, as is every saved machine
  where this machine's own database does not open (`oak __usage-brief --json`, what `oak
  usage --brief --json` prints: each share with when it was measured, its reset and its
  token estimate, its month figures, what that machine measured of its own Claude usage
  in each window, when its account last answered with no five-hour window and with one,
  and the same two hashes), and one from before that command runs nothing. OAK hashes the same field on this machine and uses an
  answer only when the two match. On a machine with no Claude Code login, it uses the
  one account the saved machines name, and none when they name two; an answer that names
  no account is never used. OAK caches the answers under the store's `remote-cache/`,
  with each machine's last outcome for `oak doctor` (whether it answered and, when it
  did not, why, with at most one line of what SSH or that machine's `oak` printed) and
  how far its clock is from this one's. No account id, host name, home directory, email
  address or credential leaves either machine. `"machineUsage": false` in
  `~/.claude/claude-observatory/prefs.json` turns it off: no SSH runs for it, and the
  readouts show this machine's own readings only.
- **oak sync** *(once you run it)* — `oak sync now` reads each enabled saved machine's inventory and
  files over its own SSH (batch mode, as above), with `oak __sync-inventory` and `oak __sync-fetch` there, which
  read, and writes only this machine (and, once you set one, the backup folder below). The writes it asks of a
  machine it reads are that machine's own: `oak __sync-inventory --publish` first records the sessions deleted or
  restored there since it last looked, in its own sync state, and catches its local database up, which appends what it
  derives of its own sessions to its own record log, for the same user only (`oak sync plan` never asks it). It
  reads Claude Code's
  transcripts and their `subagents/` and
  `tool-results/` folders, auto memory, plans, skills, agents and commands, Codex's rollouts, OAK's own store of
  each session (its edit log, the content snapshots its edits name, its comments, agent record and hook events,
  which other machines keep as replicas under the store's `sync/replicas/`), each machine's record log
  (`records/`, below), and from
  Claude Code's `settings.json` only `cleanupPeriodDays`; to match a project across machines, it also reads the
  origin URL in the project's git configuration and the mount table. It never reads `.claude.json`, other
  settings, Claude Code's per-process `sessions/` files, `shell-snapshots/` or credentials, Codex's `auth.json`,
  `config.toml` or databases, or the home's `.ssh`, `.gnupg`, `.aws`, `.netrc` and `.git-credentials`, and it
  follows no symlink there. A machine whose user name is not yours refuses before it reads anything. An inventory
  carries the machine's user name, home directory and platform, the hash that tells machines apart (as above),
  each project's working directory and identity key (a repository's origin host and path, without credentials,
  a path under the home, or a network share), its network mounts, its sync settings, deleted sessions and the store
  sessions it cleaned up, and each file's name, size, time and, for text, its hashes; file contents cross only in a
  fetch. A replica of another machine's store session keeps the content snapshots it was given until the session is
  cleaned up or deleted there, an edit that machine's ignore sweep dropped included, and what a run replaces or lets
  go stays in the trash for 30 days. What it pulls
  lands in Claude Code's and Codex's own folders here, and its state, conflict copies and a 30-day trash of
  what it replaced stay in the store's `sync/` folder. Once a run with a saved machine to sync with, or with a
  backup folder set, has happened on a machine, the capture hooks and the pollers start one in the background at
  most every five minutes;
  `"sync": { "auto": false }` in `~/.claude/claude-observatory/prefs.json` stops that.
  **Every machine you sync with is trusted with your agents' instructions.** Skills, agents, commands,
  memories and plans are instructions that coding agents follow, and sync merges each machine's changes to them
  into every other's, so a machine that is compromised can change what your agents do on every machine.
  `oak sync family <family> off` stops syncing one of these families on this machine, and
  `oak sync exclude <machine>` stops syncing with a machine. See
  [docs/REMOTE.md](docs/REMOTE.md#sync-across-machines-oak-sync).
- **oak sync backup folder** *(once you set one: `oak sync setup` or `oak sync backup --folder`)* — each machine
  writes an encrypted copy of its own files (sessions, memory, plans, skills, agents, commands, rollouts and its OAK
  store) to a folder you name, such as a network share other people can read. **What lies in that folder:
  ciphertext, names that are keyed hashes or a numbered part of a machine's record, the sizes of its files, and the
  times they were written.** Nothing
  else: no file name, path, session id, project, host name or user name is in a name or in the
  clear, and the key is never written there. Each object and each part of a machine's record is sealed with
  AES-256-GCM (Node's own crypto) under a random nonce, with what it is bound in; objects are named by an
  HMAC-SHA256 of their content's hash, under a key derived from yours, so equal content has one name and a name
  reveals nothing of its content. The marker file holds a known text sealed under the key, which tells a wrong key
  from a right one. **Without the key the folder is useless**: it is 32 random bytes kept only in each of your
  machines' OAK store (`sync/key`, mode 0600), copied between them over OAK's SSH (`oak sync key --from <machine>`,
  answered only to your account), or by you (`oak sync key --show`, which warns, and `--import`, which takes it on
  standard input or at a prompt that shows nothing, never as an argument the shell's history and `ps` keep). Keep a
  copy in a password manager: a machine that is lost with the only copy leaves the backup unreadable, and a new backup
  then starts in an empty folder under a new key ([docs/REMOTE.md](docs/REMOTE.md#the-backup-folder)). Anyone who holds
  the key and can read the folder can read every session in it. Anything in the folder that does not open, or opens
  to other
  content than its name says (altered, or sealed under another key), is reported and never used; so is a machine's
  record that lost a part or went back to an earlier one, a pipe or device where a file of OAK's should be (never
  waited on), and a link where OAK writes (never written through; one in a path OAK only reads gets nothing past the
  key). Sync also refuses a family symlink into a relocated OAK store’s current or replaced backup keys,
  and checks transcript paths before reading their headers, so a credential symlink is never opened. What the folder cannot protect against: someone who can write it can remove or replace whole files, which
  makes runs fail and restores incomplete (a machine whose own record is damaged writes it whole again, from what of
  it still opens and what is on its disk, so what only the damaged part named is gone from it; an object lost is
  written again only when a file names it next), and which a machine
  notices as a record gone back only where it read that record before (a fresh install takes what it finds); and
  anyone who can read it learns from its names, sizes and times how many machines write there, how much each writes
  and when. Nothing is removed from the folder's objects in this release: content a machine no longer holds, an edit
  dropped by `.observatoryignore` included, stays there, sealed and named by no record, except the segments of a
  machine's record log that a compaction replaced, which its record still names. A session deleted with
  `oak sessions --delete` stays there too, still named by its machine's record, so that an undelete brings it back.
  A machine's record is named by its host name and home folder, which two machines can share; each part of it also
  carries, sealed, the random writer id of the machine that wrote it (`sync/writer`), so a machine that finds a record
  under its name that it did not write (a reinstall, another machine of the same name and home, or one that has a
  copy of its sync state and wrote the record since) neither restores another machine's sessions nor writes over its
  record until you say it is a reinstall (`oak sync setup --restore`).
- **Codex quota** *(automatic)* — alongside the account-usage refresh, OAK starts the
  local `codex app-server` and asks it for the account's rate limits
  (`account/rateLimits/read`); Codex makes that request with its own login, and OAK
  caches the returned limits. Starting `codex app-server` also makes Codex's own startup
  requests with its login, such as its workspace routing check (`accounts/check`),
  before the rate-limits read. Without a Codex login it never starts `codex app-server`.
  It runs at most once every four minutes and backs off for five minutes after a failed
  read (for example, when Codex's login has expired).
- **Remote Control titles** *(automatic)* — so a session carries the name the Claude
  app and claude.ai show, OAK reads the account's session list from
  `https://api.anthropic.com/v1/code/sessions`. It sends the same stored OAuth token
  as the account-usage read (refreshed the same way), the API-version and client
  headers Claude Code's own session list sends, and the paging cursor — nothing about
  the sessions on this machine. It receives each session's id and title and caches
  only those, under the store's `remote-cache/`. It runs at most once every five minutes, from the same pollers as
  account usage (`oak usage`, the editors, the terminal dashboard), in a detached
  process or, in VS Code, in the extension host. `oak titles --off` (or
  `"remoteTitles": false` in `~/.claude/claude-observatory/prefs.json`) turns it off
  and deletes the cache; `oak titles --on` turns it back on.

herdr has its own update check at `herdr.dev`; OAK does not configure it.

Because the store holds whole-file snapshots (often of secret-bearing files), we
take its handling seriously and welcome reports of anything that weakens it.

## Supported versions

Only the latest release line receives security fixes. We ship via GitHub
Releases, so "supported" means "the newest tag."

| Version            | Supported          |
| ------------------ | ------------------ |
| Latest release (≥ 0.7.x) | ✅            |
| Older releases     | ❌ (please update: `oak update`) |

## Reporting a vulnerability

**Please do not open a public issue for security problems.** Instead, use one of
these private channels:

1. **GitHub Private Vulnerability Reporting** (preferred) — on the repository,
   go to the **Security** tab → **Report a vulnerability**. This opens a private
   advisory only you and the maintainers can see.
2. **Email** — **cell_observatory@berkeley.edu** with the subject line
   `SECURITY: oak-observatory`.

Please include:

- The version (`oak --version`) and OS.
- A description of the issue and its impact.
- Steps to reproduce, or a proof-of-concept, if you have one.

We aim to acknowledge a report within **3 business days** and to ship a fix or a
mitigation plan for confirmed, in-scope issues as promptly as we can. We'll keep
you updated through the private channel and credit you in the release notes
unless you prefer to remain anonymous.

## Scope

Things we especially want to hear about:

- A path that lets a crafted session id, file path, or CLI argument read, write,
  or delete outside the store (path traversal / `rm -rf` escape).
- The store or its blobs being created world- or group-readable (they are meant
  to be `0700` dirs / `0600` files), or the local database (`0700` folder, `0600` files).
- A way for `oak query sql` to write anything, read another file, or outlive its
  deadline.
- Anyone but you being able to write the `herdr-ssh/ssh` script that OAK keeps in
  the store on macOS and Linux and puts first on the `PATH` of herdr's `--machine`
  commands (it is written `0700`, in a directory OAK does not use when others can
  write to it).
- A capture path that persists a secret the redaction sweep should have filtered.
- The `siblings` / fleet digest leaking one session's file *contents* to another
  agent (by design it is read-only and path-only — it exposes counts, statuses,
  and file paths across sibling sessions in the same project, never file bodies).
- Any way the capture hooks could be coerced into executing attacker-controlled
  code.
- Agent-written text (a session title, prompt, reply or file name) that reaches
  your terminal as a live escape sequence through the CLI's human-readable output
  or the terminal app.

Out of scope: vulnerabilities in Claude Code itself, the `claude` CLI, or your
editor — please report those to their respective projects.

Out of scope: vulnerabilities in herdr itself — report those to
[herdr upstream](https://github.com/herdrdev/herdr/security).

## Good to know

- Capture, review, and observability are **zero-token**, with no telemetry.
  Local views read local transcripts and stores; saved-machine listings use the
  automatic SSH path above. To title a Codex session whose prompt only hands the
  task to a markdown brief, OAK also reads the heading on the first line of that
  brief (its first 8 KB, on the machine where the session ran), at the path the
  prompt names: relative to the session's workspace, absolute, or under `~`.
- **The local database holds your prompts and the answers to them.** Each machine keeps
  a SQLite database of its sessions in `~/.claude/claude-observatory-index/` (beside
  the store's config, never inside the store): titles, every ask and the prose that
  answered it, edit metadata (file paths, hashes and line counts, never file
  contents), tool calls with their targets (file paths, shell commands, URLs),
  review comments, and the text of plans, memories and skills. The folder is `0700`
  and its files `0600`; `PRAGMA secure_delete` is on, so what a delete frees is
  overwritten, and a deliberate delete also empties SQLite's write-ahead log, where
  the session's pages would otherwise stay while another process (the terminal app,
  an editor) keeps the database open; a read in progress in another process holds the
  log until it ends, and the next checkpoint then completes it. It is built on this
  machine from this machine's files and from the record logs `oak sync` keeps here,
  and it is never synced or backed up as a file: oak sync never reads it. Its rows
  are, though: each machine publishes what its database derives of its own sessions to
  its record log (below), so with oak sync the database of every machine you sync with
  holds every machine's prompts and answers.
- **The record log carries your prompts and their answers to every machine you sync
  with.** Each machine appends what its database derives of its own sessions to a log in
  its store (`records/<machine hash>/`, files `0600` in folders `0700`): titles, every
  ask and the prose that answered it, edit metadata (file paths, hashes and line counts,
  never file contents), tool calls with their targets (file paths, shell commands,
  URLs), workers, review comments, raised hands with what each waits on (a tool's name,
  or the agent's notification text), the text of plans, memories and skills, and the usage
  of each message. Only that machine writes its log. `oak sync` copies every machine's
  log to every machine it syncs with, unlike the transcripts, which stay on the machine
  that made them and the backup, and writes it, sealed like everything else, to the
  backup folder. `oak sync family oak-records off` on a machine stops it pulling the
  other machines' logs (what it already holds stays, in `records/` and in its database); to keep a machine's
  log off the others, turn the family off on each of them. The demo
  simulator's sessions are never in it. A deliberate delete reaches every copy: the
  delete is a record of the log, every machine that applies it forgets the session at
  once, and the next compaction of the log (a rewrite that keeps only the latest version
  of each row, and no deleted session) removes its text from every machine's copy of the
  files, as each machine lets go of what a newer compaction covers. A machine set up again
  (its store lost) begins its log anew, and its compactions cover only that log: a session
  from before, deleted there, stays in the copies of the log it kept before until oak sync
  brings that log back to it, which then compacts both. The session's usage rows
  (message ids, models, token counts and times, never text) stay, without its id: the
  account was billed for them. A backup folder keeps the earlier segments, sealed, as it
  keeps its other content (above).
- **What the database keeps after its files are gone.** A session whose files are gone (its
  store removed by `oak clean`, its transcript swept by Claude Code's retention or deleted
  by hand) is archived in the database, not removed: its asks and answers, edit metadata, tool calls and comments stay, and
  `oak query` shows them when asked (`--archived` or `--all`). To forget a session,
  delete it on purpose with `oak sessions --delete <id>`: that purges every row of it
  from the database, its full-text entries included, at once (and on the other machines
  through oak sync's tombstone and the record log), but for its usage rows, which stay
  without its id. The delete in the terminal app and
  in VS Code purges it too, where that Node has `node:sqlite`; otherwise the session is
  purged at the next listing, search or query any OAK command answers from it. On a
  machine that does not use oak sync, deleting the folder above and this machine's record
  log forgets everything only they held; the next listing rebuilds the database from the
  files that remain. With oak sync, the other machines and the backup keep copies of this
  machine's record log, which the next run brings back, so only `oak sessions --delete`
  forgets a session on every machine, once a run there has read this machine's record log
  after it. `oak uninstall --all --purge-store` forgets the sessions whose stores it removes
  in this machine's database and record log, and a transcript the purge leaves is added to the database again
  from the file. Another machine forgets what those stores held once a run brings it this
  machine's record log. While this machine's OAK still answers its runs, it also lets its
  copies of the stores go, as after any cleanup; a machine that does not reach this one
  again keeps its copies, and can keep what its database holds of them. A backup folder keeps
  what it holds of a session (above). `oak uninstall --all` names the folder and the record
  logs' folder.
- **`oak query sql`** runs one read-only statement against the database, in a child
  process killed at its deadline, on a read-only connection with `query_only` set;
  ATTACH, VACUUM INTO, a second statement and any statement that returns no columns
  are refused, and on Node 24.10 and newer SQLite's authorizer allows reading only.
- Risk scoring and the egress report are themselves defensive features: they
  surface destructive/privileged shell commands and off-machine destinations a
  session touched, so you can audit what an agent did.
