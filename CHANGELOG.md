# Changelog

All notable changes to OAK are recorded here, following
[Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).
Each tagged release's artifacts are on the
[Releases page](https://github.com/cell-observatory/oak-observatory/releases), with its section below as
the release notes.

## [Unreleased]

### Upgrading from 0.10.0

- **Node.js 22.16 or newer, or 24 or newer.** 0.10 ran on Node 20, and `oak update` installs this release there with
  only npm's `EBADENGINE` warning. Every `oak` command then refuses to start until Node is upgraded; the capture hooks
  still record edits meanwhile. Check with `node --version` before updating.

- Messages sent while Claude Code is working appear once in Prompts, Feed and search, in the user's words,
  with subsequent work attributed to them. Task and peer notices, meta image notes and API replay copies are
  excluded. Stored asks and prompt caches are derived again, including the records synced to another machine.
  `oak prompts --machine <label>` now reads on that saved machine. Codex steering messages within one native
  turn keep separate ask identities and work windows, including repeated messages.

- **Quit or update every OAK 0.10 still running.** A terminal app started before the update, a VS Code window not
  reloaded since, or an older `oak` on the PATH runs OAK 0.10's code, and two of its writes would undo this release's:
  - Its plain `oak clean` removes a folder in the store that it does not know and takes for an empty session. This
    release keeps three: `sync/`, oak sync's state with the backup folder's key, `records/`, every machine's record
    log, and `delegated/`, the agents started from a brief. Each holds `blobs/README`, which that cleaner keeps. This machine's record log, lost all the same (by hand,
    say), is written again at the next listing from the local database, once that database has read all of it. A backup key
    lost with `sync/` is not: copy it from a machine that has it (`oak sync key --from <machine>`), or from where you
    kept it (`oak sync key --import`). `oak doctor` says when either is missing, and how to recover it. A log lost
    while the database was reading it back waits for `oak sync now` to bring it back. Doctor names that log and the
    recovery steps. Once a complete sync run finds no copy on any saved machine or in the backup, the next listing
    compacts what remains, so a deleted session's text does not stay in the log sent to every machine.
  - It rewrites `prefs.json` with only the settings it knows, which drops oak sync's (the backup, the machines and
    projects left out, the placements, the cache size, `auto`) and `"machineUsage": false`: the backup stopped without
    a word, and an excluded project synced again. This release keeps a copy of those settings in oak sync's state,
    `sync/settings.json`, which follows every change made to them, and marks each `prefs.json` it writes with
    `"prefsFormat": 2`, which OAK 0.10 drops with them. Over a `prefs.json` without that mark, every reader takes each
    of those settings it lacks from the copy, the next listing, sync run or save of a setting writes them back, the next
    `oak` command run in a terminal (or the terminal app, on its status row) says so once, and `oak doctor` says it for
    a week. A setting you remove by hand from a `prefs.json` that keeps the mark stays removed. Restoring settings
    and saving them now share a lock, so a save cannot land between the restore's check and its replacement of the file.

### Added

- Processes always follows Workers in the terminal Observatory and both editor dashboards, including empty, Codex and saved-machine sessions. The terminal keeps a counted header and any unavailable reason, and the editors say why a saved machine's shells could not be read; editor tabs and grouped columns use the same order and say “No shells in this session” when empty. Saved-machine process reads resolve the session on its owner and use the shared deadline.

- **Open workspace window:** `W` on an Observatory session in the terminal app, or **Open workspace window** in either editor’s session lists, opens one workspace on its owning machine. VS Code/Cursor use Remote-SSH for saved machines; JetBrains uses Gateway. The folder is read from the owning machine itself, never from the local database's copy of its listing. Missing folders are refused, a Gateway link nothing on this machine can open says so, and a terminal app without a GUI prints the command to run on the machine with the editor.
- **Workspace review layout:** `W` and **Open workspace window** pin the session, open all pending changes stacked, reveal Review and Timeline, show the grouped Overview and change map, and reuse one OAK terminal running `oak`, preserving view placements. Both editors pick up requests in already-open windows; empty reviews show a note. JetBrains terminal support uses the optional Terminal plugin.

- **Terminal app: a GUI editor beside the terminal editor.** Options has two editor rows: **Terminal editor** (`prefs.editor`, unchanged, used by `e`) and **GUI editor** (`prefs.guiEditor`, used by `W`; blank is Auto). Auto takes a GUI editor from the terminal editor setting, `$VISUAL` or `$EDITOR`, then the editor whose integrated terminal this is, then the first GUI editor on `PATH`, so `nvim` as the terminal editor no longer stops `W`; `W` refuses only when there is no GUI editor, and names the setting. On Review, `e` or `E` opens the selection in the terminal editor and `W` in the GUI editor at the selected edit's line (Remote-SSH `--goto` for a saved machine's session, Gateway for a JetBrains IDE). The status row names the GUI editor that ran and where it came from.

- Observatory (F2) lists the pinned session’s background shells and its workers’ shells, running first,
  with state, runtime and exit code. Finished shells fold into one row. Clicking a shell follows a bounded,
  plain-text output tail; visible running rows show their last few lines.
- `oak processes --follow <id> [--session <id>] [--machine <label>]` streams output locally or on a saved
  machine. `--json` emits snapshots. Both editors’ Processes selections use this route in the background,
  with the shared remote deadline. Only task-named output files are read; terminal controls are stripped.
- Codex exec sessions appear when they report a running session ID. Their output updates from recorded
  exec and `write_stdin` results, with an explicit note that Codex supplies no output file to watch.
- `oak agent tell <id…> <text>` (or `--file <path>`) sends a running agent more to do through its own chatbox, here
  or on a saved machine, for Claude Code and Codex. The message reaches the agent's transcript, so its Prompts and
  Feed show it, and OAK records who sent it and when (`oak agent list --json`'s `lastMessageMs`). A gone, done or
  closed agent is refused before anything is sent.
- `oak agent start … --after <id…>` records an agent as `queued` and starts it once every agent it names is done
  (`--after-any` also accepts gone), even after the terminal that queued it closed. A failed dependency, an unknown
  id or a cycle stops it with the reason; `oak agent close` cancels it. A queued agent with `--worktree` makes its
  worktree when it starts.
- `oak finding add "<text>" [--path <file>…]` posts a fact other agents should know, such as a generated file or a
  build step tests need; `oak finding list`, `oak query findings` and `oak finding resolve` read and retire them.
  Findings travel to every machine in the record log and always show as quoted, untrusted text.
- When an agent is about to edit a file that another active agent, on this machine or another, has pending edits
  to, OAK's capture hook adds a one-line note to its context: who, where and since when. The note never blocks the
  edit, and the hook does not open the database to find it.
- `oak agent setup` opts agents into delegation through herdr tabs, with managed Claude and Codex guidance,
  an `oak-builder` agent, model/effort and writable-root defaults, a permission rule, checks and surgical removal.
  Update refreshes unedited guidance, uninstall removes it, and doctor and the terminal app suggest setup.
- Delegated agents can start in new worktrees. Their records carry path, branch, base and bounded Git readings
  across machines; the CLI and all Workers views show change and merge state. Doctor lists orphaned agent worktrees
  (only ones OAK made, on an `oak/<id>` branch), and `agent close --remove-worktree` removes only clean, merged ones OAK made.

- `oak feed --kind agent --id <worker> --follow` follows a worker’s own log, with a file watch and a quiet
  polling fallback. It prints the recorded end time and exits when the worker ends. Add `--machine <label>`
  to read a saved machine’s worker over SSH every ten seconds; `--json` prints one snapshot per line.
- Agents started from a brief, tracked by OAK. `oak agent start --kind claude|codex --brief <file>` opens a herdr tab
  labelled with the brief's `# Title`, starts the agent's own CLI there and hands it the brief, here or on a saved
  machine (`--machine <label>`, where that machine's OAK starts it). Claude Code's agent type and permission mode, and
  Codex's model, effort and sandbox, come from `agents` in `prefs.json` unless a flag sets them. The start answers a
  folder-trust prompt with its first choice, sends Enter after the brief, starts the tab's shell with
  `DISABLE_AUTO_UPDATE=true`, and checks the pane before it believes that herdr's start timed out.
  `oak agent list` shows each agent with a state OAK derives from the agent's report, transcript or rollout, raised
  hand, process and pane, and Claude Code's `claude agents --json` (starting, working, waiting, blocked, errored with
  the error's text, done, gone), when that state began, its machine, tab, tokens and cost, and its workers.
  `oak agent wait <id…> --until done|blocked|any` returns once that is reached, watching the files it reads, so a
  report written shows as done within a second. `oak agent close <id…>` closes the tab and keeps the row. An agent on a
  saved machine is read from the local database when oak sync read that machine in the last ten minutes, else over SSH.
  The database keeps the agents in a `delegated` table (schema version 5), which the record log carries to every
  machine; `oak query delegated` lists them with their workers. The terminal app's Observatory, and VS Code's and
  JetBrains' Workers tabs, list them with their states; the Observatory opens an agent's tab.
- Each machine keeps a local database of its sessions, in one SQLite file in `~/.claude/claude-observatory-index/`, beside
  the store's config and never inside the store: sessions, every ask and the answer to it, edit metadata with line
  counts, tool calls with their paths within the project, workers and workflow runs, raised hands and waits, review
  comments, plans, memories and skills, the usage of every message, and every other machine's sessions from the record
  logs `oak sync` keeps (below), each marked with the machine it came from. It uses the SQLite built into Node, so it
  adds no native dependency; it is kept current as each command reads, from a byte cursor per transcript, and built in
  the background when there is more to read than a command waits for, as on a first build of a machine with many
  transcripts. `oak sessions --json`, `oak search` and `oak inbox` answer from it when it is current, with the same
  answers as from the files (and, from it alone, the other machines' raised hands), and so does `oak notify --watch`,
  which listed every session's files every three seconds; `OAK_INDEX=off` reads the files instead, and
  `OAK_INDEX=shadow` reads them and records where the database would differ. The terminal app and both editors get those
  answers wherever they run these commands, and read the database themselves where it saves a walk of the files (below). It
  grows with the text of the asks and answers, not with tool output: about twice that text, plus about half a kilobyte
  per tool call, a kilobyte per edit and a third of a kilobyte per assistant message's usage. Nothing caps it, since
  archived sessions are kept; deleting its folder reclaims it, rebuilt from the files and the record logs. A value in a
  session's files that no column of the database can hold keeps only that session out, and while one does the database never
  reports itself current: the listings read the files, `oak query --status` lists the session with why, and `oak doctor`
  warns. `oak doctor` has a row for it, with its size, and `oak uninstall --all` names its folder and the record logs'
  folder.
- `oak query` answers from the local database in JSON, for agents and scripts: `sessions` (every machine's the database
  holds), `edits`, `files`, `prompts`, `search` (asks and answers ranked with bm25, an ask over its answer), `workers`,
  `sync`, `notes`, `usage`, `readings` and `schema`, with
  filters such as `--since 7d`, `--text <words>` and `--status pending`, and `oak query sql "<SELECT …>"` for one
  read-only statement, run in a child process stopped at its deadline. Every answer carries its columns, rows, whether a
  limit cut them, and how current the database was; `--arrays` and `--table` shape it, and `oak query --serve` answers one
  request per line. Exit status 2 means the query cannot run, 3 that there is no database here, and 124 that raw SQL ran
  past its deadline. The rows of `sessions`, `edits`, `prompts`, `search`, `workers` and `notes` name their machine by
  id, which a query's own `--machine` takes, as it takes `self` and the label a saved machine has here (any other name
  is refused with `bad_param`), and by the name this machine knows it by (`machine_label`: the label it saved that
  machine under, which the other commands' `--machine` takes, else the name the machine gives itself), and the
  `machines` table keeps both names (`label`, `saved_label`). `files` counts a file once by its repository and its path
  within it, so a repository cloned at different paths on two machines, or edited from sessions in different folders of
  it, is one file, and `edits --path` takes an absolute path in this machine's clone as that path, or refuses one
  outside every project with `bad_param`, where it answered with no rows.
- The local database keeps what a session did after its files are gone. A session whose transcript, rollout and store are
  all gone (its store removed by `oak clean`, its transcript swept by Claude Code's retention or deleted by hand) is
  archived, with when and why, and its asks and answers, edit metadata, tool calls and comments stay searchable when
  asked for (`oak query … --archived` or `--all`); the edit records of a store `oak clean` removed, and a record
  `oak clean --resolved` drops, stay too, marked cleared, as do the records, operations, capture gaps and review units
  of a store `oak clean` removed when the session then went on. OAK's cleanup records each session it removes first, from
  every surface that cleans up (the CLI, the terminal app and both editors), except where an editor's Node has no
  `node:sqlite`: there what the session did since the database last caught up goes with its files. Only a deliberate
  delete forgets a session, at once and with its full-text entries. `oak sessions --delete` forgets it on every machine
  whose oak sync reads this machine's record log after the delete, as a delete made there forgets one: in every database
  file there, and out of the write-ahead log, whether the log brings the delete or a base its machine compacted it
  into. `oak uninstall --all --purge-store` forgets the sessions whose stores it removes in this machine's database and
  record log, and a transcript the purge leaves is added to the database again from the file. Another machine forgets what those
  stores held once a run brings it this machine's record log, and, while this machine's OAK still answers its runs,
  lets its copies of the stores go, as after any cleanup; one that does not reach this machine again keeps its copies.
  `oak demo --clean` forgets the demo's sessions and their usage, which no record log or usage pull carries. A new
  database file reads the archive back from this machine's record log, and carries it over from the previous file too,
  which `oak clean` removes once the copy is verified.
- The local database keeps the usage of every assistant message, on every machine whose records it holds: one row per
  message at its largest snapshot, kept for ever, with its input, output and cache-creation tokens, its cache reads
  apart, its model, list-price cost, session, machine and account, and a rollup by day; each share a machine read of
  the Claude account's 5-hour, weekly and per-model weekly windows, with when it was measured; the spend Claude Code
  reported for each session; and the account each machine is signed in to. `oak usage --window
  5h|week|bill|month|day|all --by machine|model|session|day|agent|account` and `oak query usage` break a window down
  from it, each message counted once however many machines hold it, and `oak query readings` lists the shares each
  machine read; `oak usage --json` carries the account's 5-hour, weekly and bill-cycle windows as `usageTotals`. It reads
  no credentials. Readings and spend reports are kept whole for 35 days, and then as the account's usage over time: one
  reading of each machine, agent, kind and hour (and of each answer on the five-hour limit), and one report of each
  session and day, carrying what that day's reports added. A session deleted on purpose keeps its usage, without the
  session, since the account was billed for it, and has it back when it is added to the database again; so does a session deleted
  with OAK 0.10.0, its transcript kept, which no database knew (read from cursors of its own, so an undelete reads it
  whole); the demo's sessions, never billed, take theirs with them. The account's answers on its five-hour limit
  (below) are readings of their own, apart from its shares, each kept with when the account answered: with no
  five-hour window, or with one.
- Each machine publishes what its local database derives of its own sessions to an append-only record log in its store
  (`records/`), and `oak sync` keeps every machine's log on every machine and in the backup: sessions, every ask and
  the answer to it, edit metadata, tool calls, workers, comments, raised hands, plans, memories and skills, and usage.
  So each machine's database lists every machine's sessions, and counts every machine's usage, without its transcripts; a
  machine set up again gets its own log back, and with it its archive, even one used before oak sync brought that log
  back: rewriting the log it began anew replaces only that log, so the other machines keep the one it kept before, and
  read the two together (a session from before that is deleted there leaves that log once oak sync brings it back). A
  log that lost what the database published in it
  (OAK 0.10's `oak clean` removed `records/`, for one) is written again whole from the database at the next catch-up, where
  that database has read all of it, and `oak doctor` says so meanwhile where oak sync reads it; a log the database was still
  reading back is left for oak sync to bring back. A log is rewritten as its latest rows once it
  holds 32 MB and twice what it held when last rewritten, and at once after a deliberate delete, whose session then
  leaves every machine's copy of the log (a backup folder keeps the segments it was sent). `oak sessions --json
  --machine <label>` answers from the database when `oak sync` read that machine in
  the last ten minutes and nothing there may be running (no session active in the last two hours, as its records and
  the files that run saw say, no hand raised in the last day still up), saying so and how fresh it is (`fromIndex`,
  `syncedAt`, `publishedAt`), and over SSH otherwise. The capture hooks never write it: once `oak sync` has run on a
  machine, each starts a catch-up of the database in the background, at most once a minute and at once when it moved a
  hand, so what the agents do is published while they work; and a machine that another machine's `oak sync now` asks
  catches up first, for up to five seconds (the rest in the background, for a later run), so a first run brings every
  machine's sessions with nothing listed anywhere first. The log carries your prompts and
  their answers to every machine you sync with ([SECURITY.md](SECURITY.md#good-to-know)).
  Compaction requires a local append receipt or the writer's final segment seal, and bases name the verified
  segments they replace. Bases retain purges, including through repeated compaction and database rebuilding.
  Writer lifetimes keep unrelated old segments behind the selected base after a reinstall with a clock rollback;
  disconnected bases are selected conservatively and retain uncovered history. Doctor reports a partly read log.
- Both editors list the sessions of every machine whose records `oak sync` brought to the local database, with when it
  last read that machine (or when its records arrived, for one it does not read): VS Code in Switch Session and the
  Timeline's session selector (read in-process where its Node can, from the CLI otherwise), JetBrains in Switch
  Session, in one list with this machine's sessions, each row naming its machine. A machine no longer saved, or one
  whose records came through another, is listed too. When no saved machine can be contacted for that record, its
  session shows what its records say of it, read-only, and offers to fetch it here (`oak sync fetch`), after which its
  conversation opens here. Its captured edits are not listed on this machine, where no view lists another machine's
  edit log, and it is reviewed on the machine that made it. The terminal app lists its saved machines' sessions in the Observatory and the
  session picker as before, now from the database when `oak sync` read that machine in the last ten minutes and nothing
  there may be running (no session active in the last two hours, as its records and the files that run saw say, and no
  hand raised in the last day still up), saying so under the machine with when, and over SSH otherwise. `oak sessions
  --json --synced` adds the other machines' sessions to the listing (`machines`), and `oak search --machine <label>`
  searches a machine's conversations in its records here when `oak sync` read it in the last ten minutes, without SSH.
  Until `oak sync` brings another machine's records here, no synced-only row is added; saved-machine listings work independently. `oak siblings --repo` (`oak fleet --repo`)
  lists the other machines' sessions of the same repository too, from their records, read-only.
- A session's raised hand reaches the other machines in its machine's record log. `oak inbox` lists every machine's
  hands, most urgent first, another machine's labelled with that machine and when `oak sync` brought it (`--json` adds
  the machine's id and label and how fresh the hand is); the terminal app's `i` list, VS Code's session selector and
  the JetBrains Sessions tab list them the same way, and a running terminal app, editor or `oak notify --watch`
  announces each once on each machine, naming its machine. A permission prompt travels only once it has stood its
  wait there (5 seconds, or Codex Auto-review's 90), as that machine announces it, a question as a question, named by
  its header, and a hand up for more than a day is listed on its own machine alone. The phase the database gives another
  machine's session (`session_phase`, the `workers` query, the listings) follows its hand, so a session waiting on a
  permission prompt there never reads as working here.
- `oak sync` shares the agents' state across the saved machines over SSH. Memory, plans, skills, agents and
  commands, which Claude Code reads from local disk, are kept on every machine and merged three ways against the
  last version the machines shared; changes to the same lines keep both copies as a conflict, listed by
  `oak sync status` and `oak inbox`. Claude Code transcripts and Codex rollouts are kept on the machine that
  made them and on one backup machine (`oak sync backup <label>`), which restores a machine that was wiped;
  the other machines keep an index of them and bring one over with `oak sync fetch <session>`, as a copy
  evicted past a size cap. A longer copy of a session is pulled only once its first bytes match this machine's,
  and only up to its last complete line, and never onto a session written in the last minute on the machine
  that pulls it; diverged copies are kept apart. A machine that sends slowly is stopped after ten minutes in a
  run, and what it sent lands up to its last complete line. Each project lands in each machine's own folder
  for it, matched by its repository's origin, its path under the home directory or its network share. Every
  machine pulls and none writes another's; writes are atomic, what one replaces goes to a dated trash first,
  every write is logged, and one run goes at a time. Names Windows cannot hold are never synced, on any
  platform. Deletes made with `oak sessions --delete`, and memory, plans, skills, agents and commands removed
  on one machine, reach the others, and a delete dated more than a day ahead of a machine's clock counts there
  as made a day after it arrived; Claude Code's retention sweep does not reach them, and no transcript older
  than a machine's `cleanupPeriodDays` is pulled there (`oak doctor` warns when it is unset, once sync has been
  used on that machine). A machine whose user name is not this machine's refuses before it reads anything,
  and every machine you sync with is trusted with the skills, agents, commands, memories and plans your agents
  follow (SECURITY.md). `oak sync plan` previews a run, `oak sync include` and `exclude` choose machines and
  projects, `oak sync family` where each kind of file is kept, and every command takes `--json`; `oak sync now`
  exits 1 when every machine it asked failed and nothing was pulled. Once a run with a saved machine to sync
  with, or with a backup folder set, has happened on a machine, the capture hooks and the pollers keep it current
  in the background, waiting up to an hour after a background run that stopped with an error or was killed. The terminal app and both editors show its runs and its conflicts, and run it,
  set it up and choose its machines and projects through the CLI (below). OAK's session lists take a session pulled
  from a machine that names its directory differently for a copy and leave it out.
- `oak sync` carries OAK's own store too. Each session's edit log, comments and agent record reach every machine
  as a replica under the machine that made it (`sync/replicas/<machine>/<session>/`), so one session id on two
  machines never mixes and no machine takes its own in as a replica; a log is mirrored whole whenever the machine
  that writes it changes it, a clear included, the copy it replaces to the trash unless the new one only extends it.
  Its content snapshots and hook events stay on that machine and the backup, and `oak sync fetch <session>` brings
  them. A session removed with `oak clean` is never pulled back, and the other machines let their copies go once its
  machine says it cleaned it up; a copy whose machine is away, or lost the session with no cleanup, is kept, and is
  how that machine gets it back. A session folder made anew after its store was lost with no cleanup (removed by
  hand, a crash, a machine reinstalled and used before its first restore) is a new generation of the session: every
  copy, the backup folder's included, keeps the history it held of the one before it as a session of its own,
  `<session>_earlier-<generation>`, which comes back to its machine and is listed there as the session's earlier
  history. A clear or an ignore sweep is no new generation, on a machine that never runs a sync of its own too, and a
  session cleaned up with `oak clean` and captured into again keeps no earlier history, nor does one deleted with
  `oak sessions --delete` once a run has seen the delete. A run and `oak store --move` never overlap: each refuses
  while the other runs.
  In this release no OAK view lists the replicas.
- The backup can be a folder every machine reaches, such as a network share others can read
  (`oak sync backup --folder <path>`, its path set on each machine). Each machine writes its own files there,
  encrypted on the machine with AES-256-GCM under names that are keyed hashes; the share holds ciphertext, those
  names, sizes and times, and never the key. A machine reinstalled with its key takes its record there over with
  `oak sync setup --restore`, then restores its own files from it, over as many runs as that takes, but the sessions
  it cleaned up or deleted, and `oak sync fetch` reads the folder when a session's machine is off. Each part of a
  machine's record carries that machine's writer id, so two machines of one host name and home (two Macs with their
  default names, two virtual machines made from one image, whether or not that image had written to the folder) never
  take each other's sessions or write each other's record: every run and `oak sync status` say so, and what to do. A growing transcript writes only what it grew by,
  small objects are packed, writers never collide, and a run killed part way leaves the folder as it was; a machine
  whose own record there is damaged or went back writes it whole again. The key is 32 random bytes kept in each
  machine's store with mode 0600: `oak sync key --from <machine>` copies it over SSH, `--show` prints it for a
  password manager, and `--import` takes it back on standard input or at a prompt that shows nothing, never as an
  argument. A wrong key, an altered byte, or a pipe or link in the folder is reported and nothing of it is used
  (SECURITY.md).
- `oak sync setup` chooses where sessions are backed up (none, a saved machine or a folder), makes or brings the
  folder's key, and previews a first run; it asks on a terminal and takes flags otherwise. For a folder that holds a
  record under this machine's name it has not written, it says when and by what machine that was written and asks
  whether this machine is a reinstall of it (`--restore` off a terminal). `oak machine add`
  suggests it, and `oak doctor` does on a machine with a saved machine and no choice made yet.
- `oak sync` reaches every surface: each renders the CLI's `--json` and changes sync's settings, which stay in OAK's
  `prefs.json`, through the CLI. The terminal app's Observatory shows under each saved machine what the last run pulled
  from it and when, or why it failed, and under this machine the run, the backup and its key's fingerprint; VS Code and
  JetBrains have an OAK sync item on the status bar, with each machine's last run a line in its tooltip. The open
  conflicts are listed where each surface lists the raised hands (the terminal app's `i` list, the Timeline's session
  list in VS Code, the Overview's Sessions tab in JetBrains), each with its two ways out: both copies opened (in the
  reader's editor from the terminal app, side by side in a diff in the editors), or the other machine's copy deleted.
  Each surface runs it now, with its progress and result, and stops a run it started; shows the last run whole; sets it
  up or changes the backup with the choices `oak sync setup` offers (nowhere else, a saved machine, or a folder whose
  key is made, copied from a saved machine or pasted, replacing another key kept here once asked; the terminal app hands
  the terminal to `oak sync setup` itself); takes a backup folder's record over when a run refused it (`--restore`),
  after saying why and asking; and includes or excludes each saved machine and this project (the terminal app's options
  window, VS Code's OAK: Sync, and JetBrains' status bar menu and OAK Settings page). Until sync is in use on a machine
  (a run set it up, a backup is chosen, or a conflict is open) none of its status shows there, and nothing asks to set
  it up; with no machine saved either, the terminal app's options and the JetBrains Settings page show no sync section.
  `oak doctor`'s oak sync and local database rows, with their fixes, appear in every surface's doctor report. A session's
  delete, and its refusal of edits pending review, say what the CLI says: with a backup folder set, its edits are purged
  here only, and the next `oak sync now` after an undelete brings back what the folder holds.
- `oak sync resolve <conflict>` keeps this machine's file: it moves the other machine's copy to sync's trash and
  closes the conflict at once, as the next run would, and never while a run holds sync's lock. `oak sync status` lists
  each conflict's id, and `oak inbox` and `oak doctor` say the command. For the surfaces, `oak sync status --json`
  names each conflict's file on this machine (`file`, in `oak inbox --json` too), each machine's line as the text
  prints it (`text`), a backup folder's refused record (`record`, in `oak sync now --json` too), and the project in
  `--root` (`project`); `oak sync setup --json` exits 1 with `needsKey` for a folder that holds a backup this
  machine's key does not open, naming another key kept here (`keyHere`), which the folder's replaces only with
  `--replace`, and changes nothing. On a terminal, `oak sync setup` asks before a key brought for a folder replaces
  the one kept here.
- `oak update` updates everything OAK installed, on this machine and on each saved machine. On this
  machine it now also covers the extension in each VS Code-family Remote-SSH server
  (`~/.vscode-server`, `~/.cursor-server` and the others), which the editor's own command never
  reached, and the plugin in every JetBrains IDE that has it, not only PyCharm, IntelliJ IDEA, WebStorm
  and GoLand. It also covers the Claude Code capture hooks in your user settings and the Codex capture
  hooks, which it repairs when a release adds a hook event (until now `oak status` reported a hook
  install one event short after an update), and a focus server still running an older build, which it
  stops. A project's own
  `.claude/settings.json`, which its repository shares, is never written: one that needs a repair gets
  a row naming the `oak init --repair` to run there. A Codex hook you turned off in Codex stays off,
  and where herdr publishes no build (Windows on ARM, or Linux on 32-bit ARM), herdr is left alone.
  Each enabled saved machine then runs its own `oak update --here` over ssh, in parallel, with a
  deadline and once for machines saved with the same ssh target, and downloads the release itself; a
  machine without OAK, or with an OAK older than `--here`, gets a row saying what to do there. The
  command prints one plan and one result table, leaves what is current alone, and exits non-zero when
  anything on any machine could not be updated, the setup step of the CLI it installed included.
  Stopped (SIGTERM, SIGINT, SIGHUP, or SIGQUIT on macOS and Linux), or ended by an unexpected error,
  it stops the ssh it started on the saved machines. `--json`
  adds `components` and `machines` to the plan. An extension a marketplace installed is left to that
  marketplace on the stable channel, as the VS Code extension's own updater already did. The editors'
  Update now runs the same command on every click, so it updates the saved machines too, gives it
  fifteen minutes, and then names each repair it left to you on this machine.
- OAK gives dollar estimates for Poolside's Laguna S 2.1 and XS 2.1 and Thinking Machines' Inkling and Inkling-Small, at
  OpenRouter's prices, when Codex's provider is `openrouter`. The same model from any other provider, such as a local
  Ollama, shows tokens without a dollar figure. The Models page of the docs describes how to run Laguna through Codex so
  that OAK records it.
- The terminal app's session picker (`b`, on the Observatory and Review tabs) opens with a search box.
  Typing still narrows the rows by title, id, workspace and machine at once, and when the typing pauses
  the picker also searches what was said in each session, on this machine and on every saved machine,
  and lists the sessions that match only that way after the others, each with a line of the matching
  text. Each machine contributes up to 200 sessions, and the box says when one had more matches than
  that. Closing the picker or quitting OAK stops waiting for any search still running and stops its
  processes on this machine, as does a search passing its 30-second deadline; a search already running
  on a saved machine may still finish there. On Windows, the search's ssh to a saved machine runs until
  the search there ends. A paste goes into the box.
  `oak search --machine <label>` searches a saved machine's conversations there (in its records here when `oak sync`
  read it in the last ten minutes).
- Where this machine has no current reading of your Claude account's 5-hour, weekly or per-model weekly
  share, the detailed Usage views and `oak usage --json`
  show the reading a saved machine took of the same account, and name that machine: `✳ claude (build-box)
  wk: 22% · mo: 2%`. A laptop signed in to Claude Code whose agents run on another machine showed
  only the month, because its own shares were out of date. The status bars name the machine only for the
  windows they show, so a per-model weekly share from a saved machine is named in their tooltips and the
  Stats panels, which show it, and not on the bars. The editors' tooltips and Stats panels say when that
  machine measured the reading, by this machine's clock: OAK compares the time each answer was printed
  with the time it arrived, so the readings of a machine whose clock runs minutes fast or slow are shown,
  dated and placed in their windows as if its clock were right. In the background, at most every five
  minutes, OAK reads each enabled saved machine's usage over ssh (`oak __usage-records --json` there, from
  where the last read ended: its usage rows and readings, never its conversations), except a machine whose
  record log `oak sync` keeps current here, and no readout waits for it; a machine that does not answer
  keeps its last reading until its shares fall out of their windows, and one whose OAK predates this
  release refuses the command and supplies no reading until it is updated. `oak doctor` has a row for each
  saved machine the last read asked, saying whether it answered and, when it gave no reading, why and what
  to do: ssh's own reason when it could not connect, no answer within 30 seconds, no OAK there, an OAK
  there from before this release (update OAK on that machine), or output before OAK's own, such as a shell
  startup file there that prints. It also says when a machine is signed in to another account or has
  measured none of its shares itself, and when its clock is a minute or more off. The cache keeps that
  outcome with at most one line of what ssh or that machine said. An answer is read once ssh ends, even
  when a process that ssh started (a `LocalCommand`) still holds its output. A machine's herdr label is
  shown without its control, bidirectional or zero-width characters (an emoji family keeps its joiners,
  and a Persian or Indic word its non-joiners), and a claim, lock or attempt dated in the future, as a
  clock stepped back leaves one, does not hold the read off. `"machineUsage": false` in OAK's `prefs.json`
  turns the background read off, and the readouts then show this machine's own readings only. On Windows,
  the read opens no console window, and neither does a herdr command OAK runs to read herdr's status or
  saved machines or to reach a saved machine. A reading is used only for the same Claude account, which
  each machine names by a hash of the account id in Claude Code's `.claude.json`; a machine with no Claude
  Code login of its own uses the one account its saved machines name, and none when they name two, and its
  tooltips say that the account could not be matched. A reading is used only when it was measured inside
  its current window, and only when it is newer than this machine's own or of a later week; a share
  this machine measured in the last five minutes is replaced only by a later week's, and this machine's
  5-hour window, once ended, by any running one. The month comes whole from the machine whose weekly
  share is shown, never added to this machine's shown month: each machine's month already adds up the
  account's machines (below). GPT's month is likewise the account's: every machine's usage the database holds.
- The Claude Code status line shows the same readings. On a laptop whose sessions were idle and whose own
  shares were days old, it drew `5h 0%` and `wk —` while OAK's readouts on the same machine showed the
  account's shares from the machine running its agents. A window that `oak usage --json` takes from a saved
  machine is now drawn with that machine's share, countdown and estimate, the month with the week, and the
  machine is named in a dim label ahead of the windows: `(build-box)`, or `(build-box: wk mo)` when only
  some came from it. The reading comes from the `oak usage` call the status line already makes on every
  render. It is only drawn: the status line's cache, which the editors and the other machines read, keeps
  this machine's own readings, no saved machine's share calibrates the token estimate, and a share this
  machine measured in the last five minutes stands unless a saved machine reports a later week, as in OAK's
  readouts. With no saved machine's reading, or no `oak`, the line is unchanged. `oak update` or
  `oak statusline` refreshes an installed status line.
- `oak search --per-session` keeps each session's best match only, before `--limit` applies, so one
  session with many matching asks no longer fills every row. `oak search --json` reports `matched`, the
  number of matches before the limit, and the plain output says how many of them it shows.
- The terminal app's Observatory shows each session's workers that are still at it under the session,
  without pinning it. One row under the session's stats counts them by state, in herdr's words
  (`▸ 12 workers · ⠴ 6 working · ◐ 6 blocked`). `→`, Enter or a click opens it into a group for each
  state, those waiting on a person first, and each worker takes two rows, as a session does: its title,
  then its status, model, edits and their lines, tokens, how many of its edits await review and when it
  last wrote. `←`, Enter or a second click closes it, and each session's group stays open or closed while
  the app runs. The arrow keys move through the summary, the headers and the workers, and Enter or a
  click on a worker opens its own live log. A session on a saved machine shows its workers from that machine.
  A phase no record states, such as a wait that only a call left unanswered suggests (a permission
  prompt, or a long command) in a session whose hooks OAK does not record, is marked `~`, as the Workers
  lists mark it. A finished worker is not
  listed (the pinned session's Workers section keeps it), and a session with a worker still at it is
  listed under its machine, even with nothing pending and outside herdr. The Sessions tab of both
  editors groups each session's workers the same way under its row, a click on a worker opens its own live log, and Active only keeps a session whose workers are at it. `oak sessions --json` gives each
  session an `activeWorkers` list: each worker that is working or waiting on a person, with its title,
  phase, model, tokens, last write, and its share of the session's captured edits (the review units whose
  latest edit one of its own tool calls made), with their lines and how many await review. Only a worker
  whose transcript changed in the last two hours is asked, and one already found finished is not read
  again until it changes. A selected worker’s log stays readable after completion, and resumes updating if the
  worker resumes. A quiet pause does not end it. In-process workers get no herdr tab; those tabs run the agent’s CLI.
- The docs' Database & sync page explains the local database and `oak query`, what `oak sync` carries between
  machines and what never leaves one, the encrypted backup and its key, the archive, and how usage is
  counted once across machines, with worked examples from two synthetic machines. The README's section
  on the database and sync points to it.
- A docs page, The database across machines, explains how each machine's local database, the record logs it exchanges
  over SSH and an encrypted backup folder on a shared storage server fit together, and why the database stays local.
- The docs' Multi-agent work across machines page follows three synthetic machines through briefs, native CLI
  starts, OAK-derived agent states, worker logs, waits, terminal and editor review, git integration and tab closure.
  The commands and outputs come from the built CLI using isolated homes and stand-ins for SSH and herdr. It explains
  the delegated records in the shared database, freshness, usage and privacy, and distinguishes OAK's review decisions
  from committing and merging branches. The README, REMOTE.md and related pages link to it.
- VS Code and JetBrains list the sessions of each machine saved in herdr (`oak machine list`), as the terminal app
  does, without `oak sync`. Switch Session, the Timeline selector, Sessions and Workers share one background cache
  per machine. Reads run in parallel, at most once per ten seconds, with a 45-second remote deadline. This machine's
  list never waits for them. Switch Session, the Timeline selector and Sessions show every machine's sessions in one
  list, newest first unless sorted otherwise, another machine's rows naming it; search, filters and sorts cover them
  all. Above the rows, one line per machine gives the age of its last answer, or why the last read failed and when it
  last answered; a failed read also removes its stale worker rows. Selecting a session reads its Timeline and
  Overview on that machine, and Review lists its edits as it does a local session's. Keep, Undo, Redo and Resolve,
  for an edit, a file, a task or the whole session, review comments, quotes and prompts run there. Open first uses a
  verified mounted share, then a new Remote-SSH window (VS Code/Cursor) or Gateway (JetBrains) at the session workspace.
  An expiring, single-use request selects the session and requested edit, file or Open all view. Diff is a separate
  native before/after view. The Review reply box is removed; replies remain in Timeline/Feed, quotes and comments. Conversation search covers this machine and every
  saved machine, each hit naming its machine. Mounted files use inline review while decisions still run on the saved
  machine; explicit refreshes account for delayed SMB notifications. VS
  Code's Actions shows the session's risky actions, writes outside the workspace, egress and live conflicts; JetBrains
  reads risk and egress there and omits live conflicts.
- `oak prompts` lists the asks and answers of a session whose transcript is gone from the local database, and says so
  (`fromIndex` and `note` in `--json`). The terminal app, VS Code and JetBrains show that note above the list.
  `oak views --views actions` returns the Actions view, so an editor can read it on another machine.

### Changed

- Done sessions start collapsed in the terminal Observatory and both editors’ Overview Sessions lists, in one “N done” fold per machine. Opening it shows the sessions grouped by workspace. A done session folds even with edits left to review, and the fold row counts them. Pins, selections, the
  watched session and active workers stay visible, new turns leave the fold, and search reveals matching done sessions. The editors retain their existing Active-only toggle, which is on by default.

- Account estimates are the whole account's on every machine: GPT's month tokens, cache reads and dollars, and the
  weekly tokens its budget is calibrated from, count every machine's usage the database holds, including usage
  whose Codex rollout files are gone. `oak usage --bill-day N` and `--gpt-bill-day N` set an account's bill day
  once; the setting travels with the usage records and sync, so every machine counts the same month. The tooltips and
  `oak usage --json` (`claudeUsageFreshness`, `gptUsageFreshness`) say how fresh each machine's usage is.
- Workers lists every active agent by name in both editors and the terminal app: the agents in herdr panes on each
  machine, the agents OAK started, recent Claude Code and Codex sessions in the repository's worktrees, and the
  session's own workers. A session whose process is gone reads gone, never working; Active only hides finished
  agents and folds a session's finished subagents into one row. The dashboards order their panels Sessions ·
  Workers · Processes · Tasks · Workflows.
- Placeholder herdr tab labels no longer replace session titles in the Observatory or Workers, including
  `oak tui --once`. A tab's workspace position, a blank label or an agent kind is not a session title;
  a user-named tab still keeps its name.
- `oak prompt`, `oak comment send` and `oak quote --send` exit with status 75 when they keep the text as a draft
  (nothing was sent: the pane is blocked or gone, or herdr did not confirm a forwarded prompt), in every output mode,
  where they exited 0, so an agent that drives another agent can tell. The terminal app, VS Code and JetBrains show a
  kept draft as a draft, never as an error.
- A tool call with no result, in a Claude Code or a Codex session, reads as awaiting permission only while the
  session's raised hand says it waits on a permission prompt, and as working otherwise, however long the command runs:
  a command that ran longer than ten seconds read as awaiting permission. No hook reports the answer to a prompt, so a
  call the person allowed reads as awaiting permission until its result, and a hand raised before a call was made is not
  about that call; once the hooks report the turn over, a call made before that and left without a result reads as an
  ended turn, idle and then done, unless the session's workers are still at it. Only a session no capture hook records,
  which has no OAK store, and a Codex subagent's own thread, whose hooks write to its parent's store, keep that
  ten-second guess.
- `oak` and the capture hooks start faster: the `oak` launcher turns on Node's compile cache, so each start after the
  first reuses what Node compiled of OAK's code instead of compiling it again. On a Linux workstation `oak --version`
  takes 51 ms, against 71 ms in OAK 0.10.0 and 88 ms in this release without the cache, and the two capture hooks of
  one edit take about 100 ms, as in OAK 0.10.0, against about 115 ms without the cache. The cache is in
  `$XDG_CACHE_HOME/oak/compile-cache` (`~/.cache/oak/compile-cache` where that is unset or not an absolute path),
  never in the store. Node checks each entry against the file it was compiled from, so code an update replaced is
  compiled again, never run from the cache.
- A session listing from a caught-up local database reads a session's store files only for a session with a call still
  without a result (its raised hand) or a worker still running (its edit log and agent record), and asks no finished
  worker again: the database keeps each session's raised hand and native tab, read again when they change, and the workers
  found finished. On a synthetic machine of 1,200 sessions, `oak sessions --json` takes about 300 ms from the database,
  where OAK 0.10.0 took about 610 ms reading the files (on one of 300 sessions, 180 ms where it took 260 ms). A catch-up
  that finds nothing changed writes nothing but its time, at most every 30 seconds, so `PRAGMA data_version` moves only
  when the database did or that time was written.
- Outside any workspace, the terminal app's "a newer session is live" check reads the newest session from the database
  (1 ms on a synthetic machine of 1,200 sessions) instead of walking every transcript every 30 seconds (42 ms in OAK
  0.10.0); its check for a local copy of another machine's transcript is answered by its warm worker instead of a
  process each time.
- A write to a Codex rollout refreshes an editor only when the local database says that session ran in its project's
  folder, a worktree of its repository that its sessions are known in, or below one of them, or is a session on screen,
  or when the database does not know it or cannot say: VS Code checks the folder each rollout ran in (reloaded when `PRAGMA
  data_version` moves), and JetBrains asks `oak query --serve` once its two-second sum of the rollouts' stamps moves.
  Any Codex session's write on the machine refreshed every open project before. Off the EDT, JetBrains' check that a
  pinned Codex session still exists asks the same serve before reading the head of every rollout.
- An account with no five-hour limit shows no 5-hour readout. Anthropic's Ultra plan (formerly Max 20x) has none once
  the account is verified, and its usage answer then carries no five-hour window: `five_hour` is null or missing, or its
  utilization is null. Claude Code's own usage view draws no Current session bar for such an answer, but OAK read it as
  a five-hour window with nothing running and showed `5h 0%`, or kept showing a share measured before. OAK's account
  read and the Claude Code status line's own read now record when the account last answered with no five-hour window and
  when it last answered with one (`five_none_at` and `five_seen_at` in `statusline-last.json`), and record no 5-hour
  share for a no-limit answer. Only these answers decide whether the account has a five-hour limit, never a 5-hour
  share. While the newest of them is a no-limit answer, the status line, both editors'
  Stats panels, and `oak usage --json` show no 5-hour window, with no gap where it was, whatever 5-hour
  share a session, the cache or a saved machine holds; the weekly and per-model readouts are unchanged.
  `oak usage --json` reports when the account said so as `fiveNoneAt` and gives no 5-hour share, reset, estimate or
  spend; its `usageTotals.five` counts the account's usage in the last five hours. The rule follows the usage answer,
  never the plan's name: an Ultra account that is not yet verified keeps its temporary five-hour limit and its 5-hour
  readout in those detailed views. Terminal and editor status bars omit it for every plan. An account that gains a
  five-hour limit shows its detailed 5-hour readout again from the first account read that
  answers with a five-hour window. An answer whose five-hour window has a share
  and no reset, beside the weekly window, still has a five-hour limit with no window running, read as before. The saved
  machines of the same account count alike: each one's answers go in the brief the others read, and in its local database
  as readings (`oak query readings`, kind `limit`), which `oak sync` and the usage read carry to the others, and the
  newest answer on any of them decides; `oak usage --window 5h` then counts the last five hours. A status line input
  that carries the weekly window and no five-hour window is not taken for this:
  Claude Code leaves a five-hour window out of that input once its reset has passed, so an account whose window has
  ended sends one too. `oak update` or `oak statusline` refreshes an installed status line.
- OAK needs Node.js 22 (22.16 or newer) or 24 or newer (it needed 20), enforced by the CLI before command dispatch: its local database uses the SQLite built into
  Node, whose full-text search 22 has from 22.16 and no 23 release has. The install scripts and `oak machine add` check
  for it, and CI runs on Node 22.16 and Node 24. An older OAK may install this release under an unsupported Node
  with npm’s `EBADENGINE` warning, but the new CLI refuses to start until Node is upgraded. The capture hooks keep
  recording edits there, saying on stderr that Node needs upgrading. An editor embedding core can still fall back to
  file readers when its own host lacks SQLite.
- The README introduces OAK as it is now: an observatory for Claude Code and Codex sessions on every
  machine you work on, reviewed in the terminal app, VS Code or JetBrains. Its quickstart covers
  Codex, and the terminal app's tabs, keys, herdr backend and other machines are described in one
  section instead of across the introduction.
- Packaging the VS Code extension from a checkout (`./install.sh`, `npm run release`) uses
  @vscode/vsce 4, which requires Node.js 22 or newer; on Node.js 20, `npm ci` warns `EBADENGINE` about
  it. `./install.sh` checks the version before it installs anything, and on a Node.js that OAK now refuses (above)
  says so and stops.
- VS Code and JetBrains ask before Refresh drops the recorded edits that a newly-added
  `.observatoryignore` covers, as the terminal app does: the confirm names how many edits and which
  session, and says the drop cannot be undone. They dropped them without asking. VS Code counts and
  drops in-process, as the terminal app does for a session on this machine, so it needs no CLI for this.
  JetBrains counts with `oak ignore --dry-run`, which an older CLI ignores and sweeps instead, so with a
  CLI older than this version it asks you to update the CLI and drops nothing; when it cannot read a
  count at all, it reports that and drops nothing. In VS Code, the refresh that follows a keep, undo,
  resolve or clear no longer applies `.observatoryignore`; only Refresh does.
- VS Code's update notification and **OAK: Check for updates** now run the same update as the version
  chip's Update now: the extension, then `oak update` for the CLI, the other editors, the JetBrains
  plugin, OAK's setup and the saved machines. They installed the extension alone. The command
  palette's **OAK: Update now** is now titled for that, "everything OAK installed, here and on saved
  machines", where it said "CLI + both editor plugins".
- **The terminal app and the editors have new keys.** No letter now means one thing on the Observatory
  tab and another on Review, and OAK has no leader key of its own. Old → new:
  - The `ctrl+a` leader is gone, and `ctrl+a` now reaches the program on the herdr tab (both agents use
    it for line start). On the herdr tab OAK listens on herdr's own prefix instead, read from herdr's
    config (`ctrl+b` by default): prefix then `m` goes back to the OAK tab you last used, prefix then
    `M` pins herdr's focused session in the Observatory (was `ctrl+a o`), and prefix then `V` opens Review
    on that session, read on the machine whose herdr runs it, as `oak focus --tab review` opens it
    (herdr binds `R` itself, to reload its config); on a pane with no session, `M` and `V` still go to
    OAK's tabs and say why. Where herdr's config binds `m`, `M` and `V` after the prefix, all three are
    herdr's, and the key row, the status row and the help offer `F1` to `F3` instead, or a click on OAK's
    tab bar to leave the herdr tab where herdr's config binds those too. After the prefix the status row
    names the keys OAK takes there, in fewer words on a narrow terminal. Every other key after the prefix
    is herdr's, so prefix then `q` detaches herdr's client (was `ctrl+a k`), and the `?` help names the
    detach key herdr's config sets, or none where herdr disables that binding (`prefix+question`, or `q`
    without the prefix). Inside a herdr pane herdr keeps its prefix. OAK reads herdr's config as TOML, as
    herdr does, so a `[keys]` table, dotted keys, an inline table and a list written over several lines
    all count, and a file herdr cannot parse, or a
    binding in `[keys]` of the wrong type, leaves both on herdr's defaults; a prefix herdr cannot read
    falls back to `ctrl+b` in both. OAK also reads herdr's key names `quote`, `double_quote`, `percent`
    and `bs`. A list of prefixes, which herdr 0.9.2 and later take (`prefix = ["ctrl+space", "ctrl+s"]`),
    gives OAK each of them, and the key row names every one OAK can follow from any terminal; herdr 0.9.1
    refuses the list and stays on its defaults, and so does OAK, which asks the herdr it runs for its
    version. The prefix is recognised without the kitty keyboard protocol too. Like herdr, OAK reads a
    capital letter as the letter with shift (`ctrl+A` is ctrl+shift+a) and tells ctrl+shift+b from
    ctrl+b, keeps shift as part of any other key (ctrl+shift+space is not ctrl+space, nor shift+f5 f5),
    and names every prefix as herdr does, in the key row, the `?` help and the status row
    (`ctrl+shift+a`; super is `cmd` on macOS). A terminal without the protocol sends ctrl+shift+a as it
    sends ctrl+a and ctrl+shift+space as it sends ctrl+space, and sends no super chord at all, so herdr
    and OAK follow such a prefix (ctrl+shift+a, super+b) only through the protocol; the key row and the
    help then say to click OAK's tab bar to leave the herdr tab. So do ctrl+tab, ctrl or shift on enter,
    backspace or esc, alt on esc, and `ctrl+i`, `ctrl+m`, `ctrl+[` and `ctrl+?`, whose bytes herdr reads
    as tab, enter, esc and backspace: OAK no longer holds those keys as the prefix. A prefix of backspace
    or enter is taken on DEL or CR alone, as herdr takes it, not on 0x08 or LF, which herdr reads as
    ctrl+h and ctrl+j. A prefix of `ctrl+q` stays herdr's when pressed twice, and OAK then quits from its
    own tabs.
  - Switching OAK tabs: `ctrl+a n`/`p`/`1`–`3` → `Tab` and `shift+Tab` on the Observatory and Review
    (`ctrl+n`/`ctrl+p` and `alt+1`–`alt+3` still work, now also from the reply box). `F1`, `F2` and `F3`
    raise the herdr, Observatory and Review tabs from any tab, and the tab bar names each tab with its key.
    They work over any overlay, which closes first, as `Esc` would close it; a box holding text you typed
    (the palette, a picker's or the help's search, find in the diff, an options entry) closes too, and the
    text goes with it, while the reply box keeps its draft and the `/` filter its text. A question waiting
    for its answer keeps them until you answer it. On the herdr tab OAK takes them before herdr or the
    program sees them, with or without herdr's prefix, unless herdr's config binds the key; with `shift`,
    `ctrl`, `alt` or `super` an F-key reaches the program unchanged. Inside a herdr pane there is no herdr
    tab, and `F1` says so. Review's windows move to make room: Prompts, Traces, Map and Diff `F2`–`F5` →
    `F4`–`F7`. Quitting:
    `ctrl+a q` twice → `ctrl+q` twice. On the herdr tab a single `ctrl+q` reaches the program, once
    the two seconds OAK waits for the second have passed or before the next key you press there.
  - Observatory: resolve `a` → `R`, stop the agent `x` → `X` (both still ask first, and are now
    also `⚑ resolve` and `■ stop` buttons beside `↗ herdr` and `⌕ review`); reply `i` → `c`; go to
    the herdr pane `h` → `t`; archived sessions `Shift+A` → `B`; open Review `r` → `Tab` (Review
    follows the selection) or the `⌕ review` button. `i`, `h` and `r` now mean the inbox, the next
    hand and refresh, as on Review. The pane keys drop the leader: `ctrl+a z`/`v`/`|`/`-`/`H J K L`
    → `z`/`v`/`|`/`-`/`H J K L`, focusing the next pane (`ctrl+a Tab`) → `F4`, `F5` and so on by
    position, `←`/`→`, or the palette, and closing a pane (`ctrl+a x`) is in the palette. Keys the
    Observatory does not use now do nothing there, rather than running Review's verbs.
  - Review: redo `ctrl+r` → `U`; undo everything listed `U` → `D`.
  - The palette `ctrl+o` and the `:` command line are one: `:` lists every command and action and
    finds sessions, tabs and workspaces, and a typed command (`status`, `comment 12: note`) still
    runs, listed above whatever else its words find. `ctrl+r` and `ctrl+o` now do nothing on OAK's
    tabs.
  - Refresh (`r`) now asks before its `.observatoryignore` sweep drops recorded edits, and says how
    many (`oak ignore --dry-run` gives the count); Options → Reset every option asks first too. For a
    session on another machine, the count needs this version of OAK there: an older one would ignore
    `--dry-run` and sweep, so Refresh says to update OAK on that machine and drops nothing. When that
    machine's count arrives after you have moved on, to another question, into text you are typing or
    to the herdr tab, Refresh asks nothing, drops nothing, and says how many edits it kept (under
    another question, once you answer it): `r` asks again.
  - The `/` filter belongs to the tab it was typed on. Every list overlay closes on `Esc` or `q` and
    ignores other keys, except the ones you type into (the `:` palette, the session picker and the
    `?` help's `/` filter), which take `q` as text and close on `Esc`, or as `F1`–`F3` switch tabs. The
    key rows and `?` help name your own rebinds. Options refuses keys the frame keeps for itself (Space,
    the digits, `:`, the mark keys and the Observatory's letters).
    A rebind an earlier version saved onto one of those keys stays in your preferences file but is not
    used: the action keeps its default key, the terminal app says so each time it starts, and Options names
    it until you choose another key. A rebind onto `D` or `U` leaves undo-everything or redo without a
    key, as Options shows; the palette still runs it.
  - VS Code and JetBrains: every shortcut is now `ctrl+alt+X` (`⌥⌘X` on macOS) then a key, the
    terminal app's where it has one: `n`/`p` next and previous pending edit, `←`/`→` previous and next file,
    `a`/`u` keep and undo at the cursor, `shift+a`/`shift+d` keep and undo every edit in the file, `[`/`]` file
    revisions, `c` a review comment and `h` the next session waiting on you. They were `ctrl+alt+n`/`p`/`y`/`u`/`k`/`r`,
    `-`/`=` (VS Code) or `[`/`]` (JetBrains), `c` and `i` (JetBrains only). VS Code now binds the
    comment and next-hand keys too, and JetBrains titles its file actions Keep and Undo.
    The editors' READMEs note the prefix's two collisions and how to rebind it: VS Code's LaTeX
    Workshop extension binds the same chord, and on Windows a layout where AltGr+X types a character
    (`ź` in Polish, `#` in Hungarian or Czech) loses it to the chord.
- On macOS and Linux, the ssh that a `--machine` command runs to a saved machine now runs apart from
  your terminal, as the ssh that `oak update` runs there does, so that ctrl+c reaches OAK, which stops
  it. So do the `herdr --machine` commands with which the terminal app reads and acts on a saved
  machine, `oak prompt`, `oak quote --send` and `oak comment send` send a prompt to a pane there, and
  `oak doctor` times the forwarding to it. Stopping `oak prompt`, `oak quote --send`, `oak comment send`
  or `oak doctor` (SIGTERM, SIGINT, SIGHUP, or SIGQUIT) stops the herdr command it waits on, and the
  terminal app stops its reads when you quit it or close its terminal, or press ctrl+c on its `--once`
  frame. A reply the terminal app is already sending still arrives after it ends, as one sent from VS Code
  does, and a prompt that has already reached the saved machine may still arrive in its pane. A reply
  that a JetBrains IDE is sending when it quits arrives if the IDE leaves `oak` running, and may not if
  the IDE stops the processes it started, as in 0.10.0. At its deadline OAK now stops such a command with
  herdr's ssh and the ssh of a jump host: it stopped herdr alone, and both went on running on the
  terminal app's terminal. None of this ssh asks anything, on the terminal or in a dialog, and neither
  does the ssh that reaches a jump host in your ssh configuration (`ProxyJump`, or a `ProxyCommand`
  that runs ssh), which does not get OAK's or herdr's `BatchMode=yes`. All of it runs with
  `SSH_ASKPASS_REQUIRE=never` (OpenSSH 8.4 and newer), so that no background read
  opens your desktop's askpass dialog or asks for a passphrase on the terminal app's terminal. The
  exception is a FIDO security key (an `-sk` key) that needs a touch: OpenSSH shows its request for the
  touch through the askpass program when a display is set, whatever `SSH_ASKPASS_REQUIRE` says, though
  that notice asks for nothing. A jump host that needs a password or a key's passphrase, or that ssh
  meets for the first time, fails instead, and the command names ssh's reason, such as
  `Host key verification failed.` for the first meeting. Connect to the jump host once with plain `ssh`
  to record its key, and use a key without a passphrase, or an agent, rather than a password.
  `oak machine add`, `oak attach` and `oak agent start --machine` still run ssh on your terminal, as OAK
  does on Windows, where a jump host can still ask; the ssh and scp of `oak machine add` now also carry
  none of this machine's store or agent identity, as OAK's other ssh does.
- `oak doctor` checks that the `oak` a login shell finds is the installation it runs from. Codex runs
  its hooks through a login shell, whose PATH comes from the login startup files: on macOS, path_helper
  puts /usr/local/bin and Homebrew's directories before ~/.local/bin there, so another installation in
  one of them ran every such hook, and nothing said so. The row names both installations with their
  versions, and how to remove the other one or put this one first; it also says when a login shell
  finds no `oak`, or one it cannot follow to an installation. The check starts one login shell from the
  home folder, for at most 5 seconds, and is skipped on Windows, where the hooks run `oak` from the PATH
  every process inherits.
- The Claude Code status line draws each gauge as a progress bar again, its figures inside the bar over
  very dim colours: the used share on a dim tint of the usage colour (green, yellow or red), the rest of
  the bar on an even dimmer grey, and light text over both, so the figures stand out on a dark or a
  light terminal. It replaces the underline under the figures that 0.10.0 drew. The colours are 24-bit
  where Claude Code draws 24-bit colour (`COLORTERM` is `truecolor`); elsewhere they are
  the nearest of the 256-colour palette, in which every bar fills in grey and the label and percentage
  carry the colour. `oak update` or `oak statusline` refreshes an installed status line.
- A session that started agents, such as subagents or a workflow's agents, shows two labelled figures in the usage
  readouts: `own`, its own turns, and `with N agents`, its own turns and those of every agent it started. They are on
  the Claude Code status line, the terminal app's status row, the Session tokens section of VS Code's Stats panel,
  JetBrains' Stats panel, and `oak usage --window` and `--breakdown` with `--by session`. `oak usage --json` carries
  the session with its agents as `sessionTreeTokens`, and `oak query usage --by session` adds `agents`, `own_tokens`,
  `own_cache_read` and `own_cost` to each row. A row from a machine whose OAK predates this release does not say
  whether an agent made it, so a session with such rows has no own figure (`null`) and shows its total alone. The
  session lists show a session's own tokens, as before.
- The Claude Code status line compacts a row that is too wide for the pane before it wraps it, measuring the row
  again after each step. The model row drops the output style, think, the duration, the tokens with the agents, the
  session's own tokens and the effort, in that order, and keeps the context figure at its end. The gauges are drawn
  as text without their bars, then without their token figures. The path and the session title are no longer cut
  (the title was cut at 48 characters) and wrap at their spaces. With a long title and a session that started
  agents, the status line takes 5 rows at 70 columns, where it took 6, and 6 rows at 50 columns, where it took 8; at
  120 columns it takes 4 rows, where it took 3, because the whole title shows. `oak update` or `oak statusline`
  refreshes an installed status line.
- OAK's status bars, which are the terminal app's bottom bar and the VS Code and JetBrains status bar items with their
  tooltips, no longer show the 5-hour window, for any plan. They show the week and the month for Claude and for GPT.
  The editors' Stats panels, `oak usage` and its JSON, and the Claude Code status line keep the 5-hour readout for a
  plan that has one.
- On OAK's status bars, the month ends with the month's dollar figure, after its reset time, for Claude and for GPT:
  `✳ claude wk: 44% 6d 6h · mo: 64% 10d 7h ~$10.0k  |  ⬡ gpt wk: 9% 22h 16m · mo: 2% 10d 7h ~$13`. It is the figure
  the Claude Code status line shows for the month, written as that line writes it. On a subscription it is the
  estimate at today's list prices, marked `~`. On a Claude plan with no rolling windows, such as pay-as-you-go API use
  or Enterprise, it is the spend Claude Code reported for the sessions it last reported this month, with no `~`, and
  the status line shows that spend too where it showed the estimate. Codex reports no spend, so GPT's figure is always
  the estimate. A provider with no reading for the month shows no figure, never a zero or an older one. The tooltips
  say whether the figure is an estimate or the reported spend. When the terminal app's bar is too narrow, it drops
  the reset times and then the dollar figures before it cuts anything short. `oak usage --json` gives the figures as
  `claudeMonthUsd` and `gptMonthUsd`, and the reported spend as `claudeAccount.monthSpend`; the status line keeps it
  in its cache as `month_spend`. `oak update` or `oak statusline` refreshes an installed status line.

### Fixed

- **Open all in editor** pages large reviews in VS Code, Cursor and JetBrains, releasing previous diff pages and keeping the UI responsive. Saved-machine reviews open stacked in the current window, read ten edits per call, and send Keep/Undo/Redo back to that machine. Missing files remain reviewable from their records; verified mounts are used by the side-by-side view, and file editing still falls back to SSH when needed.

- The terminal app no longer flashes its whole window every few seconds (seen in iTerm2). Each refresh and each
  update of the herdr tab rewrote every row of the screen, most of them unchanged; a paint now writes only the rows
  that changed, and nothing when none did. A resize, a return from `$EDITOR` or ctrl+z, and the window regaining focus
  still repaint every row.
- A terminal that inherited `HERDR_PANE_ID` from a herdr pane it is not in, such as one in an editor started from a herdr
  pane, no longer makes OAK hide its herdr tab, link sessions to that pane or report to it. OAK takes the pane as its own
  only when herdr confirms this process runs there, without delaying the first paint, and `oak doctor` names a stale one.
- An OAK focus server that has exited but that its parent app has not yet collected (a zombie) now counts as stopped.
  `oak doctor` reported it as an outdated server that "did not stop", and a new server would not start over it.
- The Observatory's and editors' Processes lists no longer show a worker's background shells as running for good.
  OAK now reads the end a worker's transcript records for its shell, and a shell that never reported one stops
  counting as running once its worker has ended and the shell has gone quiet ("no end recorded"). An idle
  `--follow` no longer emits a snapshot nothing changed.
- A herdr answer that arrives while OAK is busy, such as during the terminal app's first paint on a loaded machine, is
  no longer counted as a timeout. A timeout now measures herdr's own time from the request, and the terminal app asks
  again when the process table could not be read in time. A herdr that does not answer in time is still taken as
  outside herdr for the rest of that process, so nothing waits on it twice.
- A herdr pane that closes no longer puts herdr's raw JSON error on the terminal app's status row. OAK stops
  reporting to that pane, here or on a saved machine, until herdr lists it again, and a herdr error it does show
  reads as herdr's own message.
- Sync refuses a small file that shrinks while being sent rather than padding it with zero bytes. A partly restored
  record segment is fetched again from its complete-line offset. Importing the same backup key repairs its `0600`
  permissions. A family symlink to a relocated store cannot expose or overwrite current or replaced backup keys,
  and inventory validates transcript paths before reading headers, so credential symlinks are never opened.
- Repository discovery requires valid git metadata, follows worktree `gitdir` and `commondir` pointers, and honors
  `GIT_CEILING_DIRECTORIES`; arbitrary files or empty directories named `.git` are not repositories.
- Database derivation version 4 defers Codex rollouts that change while being read. It retries them on a later pass
  without publishing partial facts or advancing their saved stamp; an upgrade derives the older facts again.
- OAK's dollar estimates use the current list prices, and a model id takes only the row that names it; a date suffix
  or a `[1m]` tag names the same model. Opus 5.5 was priced as Opus 5 ($5 and $25 per million input and output tokens,
  where it costs $4 and $20), Sonnet 5.5's cache reads at Sonnet 5's rate, Fable 5's cache reads at $0.25 where they
  cost $1, Haiku 5.5 at the Opus 5 rate, and GPT's mini, nano and pro models and every GPT model from GPT-5.4 on at
  GPT-5's rate. A newer release of a known family is priced from that family's nearest earlier version and marked
  approximate. Haiku 5.5's rate for a prompt over 100,000 tokens, GPT's rate for a prompt over 272,000 tokens, fast
  mode and US-only inference apply to a turn whose transcript records them. The bundled status line carries the same
  table. The Models page lists the rules.
- Cache writes kept for one hour are priced at their own rate, twice the input rate, where every cache write was
  priced at the five-minute rate. The local database keeps the one-hour part of each message's cache writes
  (`cache_create_1h` in `usage_messages`, the daily rollup and the record log), and a message whose record does not
  split them is priced at the five-minute rate and marked approximate (`cost_approx`). Schema 6 also stores each message’s worker, provider, speed, geography and price version. After the update, the database
  reads this machine's transcripts and the record logs it holds once more to fill the new columns.
- The local database records which price table priced each message, and prices every stored message again when an
  update changes the table, this machine's and the other machines' alike, so every total uses one table: 200,000
  messages took 2.9 seconds, once. The spend that Claude Code reported for a session is never priced again. Every
  calculated dollar figure is labelled an estimate at today's list prices; reported charges keep their actual amount.
- The 5-hour and weekly spend that the status line adds up from what Claude Code reported (`fiveCost` and `weekCost`
  in `oak usage --json`, and this machine's own spend in the usage it sends the other machines) counts from the start
  of its window, as the window's tokens do. It counted the last 5 hours and the last 7 days, so a week's spend also
  took in spend from before the weekly reset.
- The usage another machine sends (`oak __usage-brief`) gives the tokens its status line counted in each window,
  marked `measured`, with the share times the estimated allowance beside it as `est`. It gave that estimate as the
  window's tokens.
- One Codex rollout whose session id cannot be used as a file name (a file written by hand, or damaged) no longer
  stops every session listing: it is left out, and the rest are listed. The listing read from the files failed with
  "invalid session id" and listed nothing.
- The terminal app's pinned conversation no longer marks a tool call still waiting for its result with ✓, as if it
  had succeeded: it draws the pending mark while the session waits on you, and the running mark otherwise.
- A review comment that could not be saved is no longer reported as added. The failed write was ignored, so
  `oak comment add` printed the comment's id and the terminal app and VS Code showed it, and the comment was
  gone at the next read. Now `oak comment add` exits 1 and says why, the terminal app's status line and VS
  Code show the reason, and JetBrains reports what the CLI says. A prompt that carries comments and is
  delivered while they cannot be marked sent is reported as sent: `oak prompt` and `oak comment send` exit 1
  and say that the prompt went out and the comments will be drafted again. Two comments added at the same
  moment, or one added while another is removed or marked sent, no longer lose one of them: each change is
  made under the session's lock. A session's comments are kept in its own folder in the store
  (`<store>/<session>/comments.json`), beside its log, instead of among the caches. Comments an earlier
  version kept among the caches, and those an editor still running an earlier version writes there until it
  is reloaded, are read with them and moved at the next change.
- Each edit a session captures from Edit or Write checks whether a shell command running beside it already
  recorded the change by reading only the end of the session's edit log, where OAK 0.10.0 parsed the whole
  log: 39 ms for each edit on a 5.4 MB log, now 2 ms, or 3 ms for a file the log does not name.
- A session's token counts, the Stats charts, each prompt's tokens, and the tokens of workers and workflow
  agents count each message at its largest usage, as the status line and `oak usage --breakdown` do. Claude
  Code writes one message as a line per part, each with the usage as it stood when the line was written,
  and a later line can carry more output than the first; these counts took the first line's and came out
  short, by 0.7% of the output tokens on real transcripts. The caches that hold these counts are recomputed
  once. The usage cursors and the Stats caches are now named by their version
  (`usage-cursors/<hash>.v3.json`, `stats-cache-v3.json`, `stats-cache-claude-v3.json`): kept under one
  name, an editor still running an earlier version and this one discarded each other's and read the
  transcripts again at every call until that editor was reloaded. The transcript facts and the session
  sidecar (titles and the workers' figures) are still rebuilt after each other's writes while such an
  editor runs. `oak clean` removes the cache files an earlier version left (the usage cursors and Stats
  caches under their old names, and the asks scan, prompts projection and transcript facts of an earlier
  version), and never this version's own.
- Deleting or restoring sessions (`oak sessions --delete`, `--undelete`) while another change to the list
  of deleted sessions is made, such as an `oak sync` pull, no longer loses one of the two changes: the list
  is changed under a lock. It stays a JSON array of session ids. A delete or restore that waited for a store
  move takes its locks where the store went, as a change made after the move does, where it took them under
  the store's old path and could run beside one.
- A Codex session's `agent.json` in the store is replaced whole and is readable by its owner only, like the
  rest of the store. It was rewritten in place, so a reader could find it half written, and it was created
  with the default permissions.
- Conversation search keeps the index of a session OAK has only read among its caches, and no longer makes
  a folder in the store for it. `oak clean` removed that folder as an empty one, the index with it, and the
  next search read the whole transcript again. An index an earlier version kept in a session's folder is
  removed when this version first indexes the session, and a folder it alone held goes with it.
- `oak integrity` checks that each snapshot a record names is there and readable without reading it, where it
  read every snapshot in full.
- The Claude Code status line keeps writing its cache once the cache passes 128 KiB, as the spend ledger of
  a month with many sessions does. The whole cache went to `jq` as one argument, which Linux refuses past
  that size, so every write failed and the readouts that read the cache stopped changing. It now goes on
  `jq`'s standard input. `oak update` or `oak statusline` refreshes an installed status line.
- `oak clean --drop` (and an editor's Drop) and `oak sessions --delete` (and the Delete in the terminal app and the
  editors) refuse the folders the store keeps for itself, whatever the case of the name: `oak clean --drop sync`
  removed oak sync's state, which now holds the backup key and every other machine's replicas too, and on macOS and
  Windows, whose file systems ignore case, `SYNC` named the same folder.
- `oak search`, and the search in the terminal app and both editors, find the text of an answer that follows a
  thinking block or a tool call. Claude Code writes each block of a reply on a line of its own, with the reply's id,
  and only the first line of each reply was searched, so a model that thinks first had most of its answers left out.
  Each session's search index is rebuilt once, and `oak clean` reclaims the one it replaces.
- On machines signed in to one Claude account, the token estimates beside the 5-hour, weekly and per-model
  weekly shares, their budgets, and the month's tokens, cache reads and dollars are now the account's, the
  same on each machine that has the others saved. Each machine learned its tokens per percent from its own
  transcripts against the account's share, so a laptop whose agents run on another machine credited the
  whole share to its own few turns: its budgets came out more than ten times too small, and its month read
  100% and a few hundred dollars where the other machine's read under a fifth and thousands. The status
  line now calibrates against the account's usage as the local database counts it (`usageTotals` in `oak usage
  --json`): every message of the account once, by its message id, from this machine's transcripts and from
  every other machine's usage the database holds, which `oak sync`'s record logs or the read of each saved
  machine (above) bring, in the same 5-hour or weekly window and bill cycle; the month is that sum too, with
  its cache reads and dollars. So a transcript synced or forked between machines is counted once, whichever
  machines hold it. Each machine is counted once, also when it is saved under two targets. The 5-hour and
  weekly dollar budgets in `oak usage --json` calibrate the same way, on the spend each machine's sessions
  reported. With those totals the status line reads no transcript and keeps no map of the files it read:
  on a synthetic machine of 1,200 sessions its state file went from 3.1 MB in OAK 0.10.0 to about 2 KB, a
  render whose scan was due from 790 ms to 320 ms, and one between two scans from 340 ms to 280 ms (on one of
  300 sessions, 400 ms to 320 ms and 290 ms to 280 ms), the compile cache (above) among it: without that cache a
  render between two scans takes about 320 ms on either machine. With an OAK without the database, a database still
  building, or a window that turned over between its two reads, it scans as before. On one machine the figures
  are the scan's; a machine that held the turns of another and counted them as its own (turns that ran
  outside any home directory, or under a home path two machines share) no longer counts them twice. An OAK
  from before this release sends no figures and adds nothing, and `oak doctor` says so for that machine. A
  sum that adds more machines than the estimates
  have been calibrated with starts their smoothing over, so the figures are right at the next scan rather
  than hours later. The month refresh OAK runs on a machine used from an editor alone reads them too, from
  the `oak usage` call it now makes. The editors' tooltips and Stats panels name the machines whose usage
  the estimates include; the status line and the terminal app's usage bar, which have no tooltip, do not.
  With no saved machine of the account, or none with figures for a window, every figure is as before.
  `oak update` or `oak statusline` refreshes an installed status line.
- The terminal app writes a token count of a billion or more as the status line and both editors do
  (`6B`, `1.2B`); its readout wrote `6070M`.
- A worker's tokens in the Workers lists count each of its messages once, as a session's do. Claude Code
  writes one message as a record per part (its thinking, its text and each tool call), each carrying the
  whole message's usage, and a worker's input, output and cache counts added up every record.
- A lock, claim or last attempt dated in the future, as a clock stepped back leaves one, no longer holds
  work off until the clock catches up, which can be hours. It held off the Remote Control titles refresh
  and its daily read of every page; desktop notifications, where a crashed holder's lock muted every
  raised hand and a claim muted every new one of its kind; the conversion of a Codex session's
  transcript; the trust OAK writes for herdr's Codex hook, so each install and `oak doctor --fix` waited
  ten seconds and failed; and the capture lock of a session whose holder had died, so every capture
  dropped its edit. A lock still counts for a live holder, by the monotonic clock it records, and a torn
  Bash snapshot dated in the future is dropped, so its session can be cleaned up. A snapshot of a command
  still running is kept however it is dated. A file is dated by the clock of the file system it is on, so
  on a store whose file system's clock runs ahead of this machine's (a network share's server, or the host
  under a virtual machine's shared folder), a lock or claim just taken there still holds: read as dated in
  the future, a live capture's lock on another machine sharing the store was broken, and two captures
  wrote at once.
- The terminal app draws text from outside, such as a session's title, a workspace's or machine's label
  and a herdr pane's title, without bidirectional controls, which reordered the rest of the row in a
  terminal that lays out right-to-left text, zero-width characters, which hid in the text and were
  measured as columns the terminal does not draw, line and paragraph separators (U+2028, U+2029), or
  the other characters drawn as nothing or as a blank: the soft hyphen, the Khmer inherent vowels, the
  Hangul fillers (U+3164 among them, which JavaScript takes for a name) and the tag characters, which
  spell out text no one sees, a known way to hide words in a prompt; after 🏴 they draw a black flag
  with those words behind it. The zero-width joiner an emoji family, a rainbow flag or an Indic letter
  is built with, the non-joiner a Persian or Indic word is written with, the combining grapheme joiner
  and the Mongolian vowel separator Hebrew's points and Mongolian words are written with, the tags of
  England's, Scotland's and Wales's flags and the variation selectors are kept, there and in a saved
  machine's label on every surface. Each of those characters in a file's text is shown rather than
  dropped, since a line of code that hides one runs differently from how it reads (Trojan Source;
  JavaScript reads a line or paragraph separator as a line break): each is a mark that names it, such as
  `⟨U+202E⟩` or `⟨U+E0041⟩`, dimmed except in the ghost text, in the terminal app's diff and the edits the
  Feed shows, in `oak diff` and `oak review`, in VS Code's review bubble, stacked review and Feed, in
  JetBrains' Feed, and in the removed lines' ghost text in both editors. So is a zero-width joiner or
  non-joiner, a combining grapheme joiner, a Mongolian vowel separator or a variation selector with only
  ASCII text beside it, where it hides in an identifier or a string (`is⟨U+200D⟩admin` is not
  `isadmin`, and `isAdmin⟨U+200D⟩` and `isAdmin⟨U+FE0F⟩` are second names); after an emoji or an
  ideograph, and in an Indic letter or a Persian, Hebrew or Mongolian word, it stays as it is. So is a
  variation selector after another one, which chooses nothing: a run of them spells out text no one
  sees, one byte each, after an emoji too. `oak diff --patch` in a pipe and `--json` keep the text
  exactly.
- `oak doctor --markdown`, which VS Code and JetBrains open as the setup check, shows the text a
  check carries from outside OAK as text: a server's banner that ssh printed before its login, which
  the row of a saved machine ssh could not reach keeps, herdr's errors, a remote's message and a login
  shell's output. Put in as it was, an image there (`![](https://…)` or an `<img>` tag) loaded when the
  editor showed the report, a link could be clicked, and a line break and a heading after it made rows
  that read as OAK's own. Each label, detail and fix is now one line, with what Markdown would read in
  it escaped, a bare link and HTML included, and without the characters the terminal app drops from a
  title (above); the zero-width joiner and non-joiner are kept. A code span stays one, OAK's own or one
  in the text, since Markdown shows its text as it is: it is formatting only, and loads or links
  nothing.
- VS Code's review bubble shows each line of an edit's diff as it is written. The diff went into the
  bubble's Markdown, which read it: a line with an image, such as a README's `![build](https://…)` badge,
  loaded the image when the bubble opened, a link could be clicked, and `**bold**`, `_emphasis_` or a
  `` `code` `` span lost its marks.
- `oak update` no longer replaces a CLI linked to a source checkout. `npm link`,
  `npm i -g ./packages/cli` and `./install.sh` leave npm's global package a link to the checkout, and
  installing a release over it replaced the link with a copy of that release: from then on every `oak`,
  the capture hooks included, ran the release's code, and rebuilding the checkout changed nothing. The
  CLI's row now names the checkout and says to update it there (`git pull`, then `npm run build`), even
  with `--force`, and the rest of the update goes on as usual; a CLI run from a checkout is left alone
  the same way. A saved machine's `oak update --here` does the same, and on a saved machine whose OAK is
  older than this, `oak update` runs nothing where npm's package there is such a link, and its row says
  so. `oak update --json` gives that CLI the reason `linked`, with the checkout's path.
  `oak version --check` and both editors' version chips no longer offer such a CLI a release, and say
  it is linked to a checkout; the daily nudge to run `oak update` is not shown for a CLI that runs from
  a checkout.
- `oak update` no longer installs the release with npm on a saved machine that `oak machine add`
  provisioned, where the CLI is the copy it pushed to `~/.local/lib/oak`: npm put a second CLI beside
  it that nothing ran, and `oak update` said it had updated the CLI. The copy is left to
  `oak machine add`, which updates it, and the machine's row names that command; the rest there is
  updated as before. A copy from a release older than this one is not run at all, and its row says the
  same. `oak update --json` gives such a CLI the reason `provisioned`, `oak version --check` and both
  editors' version chips offer it no release, and the daily nudge is not shown there. A saved machine
  whose CLI is still behind after its update is now a failed row, and `oak update` exits non-zero.
- `oak update` no longer replaces a local build: a CLI, VS Code extension or JetBrains plugin whose
  version ends in `-dev.0`, which every build of a `dev` checkout carries and no release does (CI numbers
  its rolling builds from `-dev.1`). On the pre-release channel it installed the rolling build over one,
  and on stable an older release. Its row now says it is a local build, here and on a saved machine, and
  `--force` or `--channel` replaces it with that channel's newest; `oak update --json` gives it the reason
  `local`. `oak version --check` (with `local` in its `--json`, and `local build` as the `--compare`
  reason), the daily nudge, VS Code's update check and both editors' version chips offer a local build no
  release and say what it is, and the chips' Update now leaves it alone. The JetBrains IDE's own plugin
  updates read the plugin repository, which OAK cannot steer for one install, so an IDE subscribed to it
  may still offer the repository's build over a local build of the plugin.
- `oak machine add` no longer writes its launcher over an `oak` on the machine that it did not put there.
  Where npm's prefix is `~/.local`, `npm link` makes `~/.local/bin/oak` a link into the checkout's build,
  and the launcher was written through that link, over the checkout's `packages/cli/dist/index.js`. Such
  an `oak`, or one npm installed, is now left as it is, with a line that says so, and the capture hooks are
  installed with it. The launcher is written beside its place and renamed over it, so it never writes
  through a link.
- When `oak update` cannot update something, the line it writes to stderr, which is what both editors
  show, names each surface, part of OAK's setup or saved machine with its reason, such as
  `machine build-box (not reachable over ssh (me@build-box): ssh: connect to host build-box port 22: No route to host)`.
  It named them alone, and the reasons were only in the notes above it, which the editors do not show.
  The editors no longer cut that line, or any other reason a CLI command fails with, at 300 characters,
  which left out the later reasons. A saved machine's reason is one line, in that line and in the table:
  when its `oak` crashed, it is Node's error line, such as
  `TypeError: Cannot read properties of undefined (reading 'surfaces')`, not the whole report with the
  source line and every frame of the stack.
- `oak init --codex` no longer turns back on a Codex hook of OAK's that you turned off in Codex
  (`enabled = false` in its state in Codex's `config.toml`): rewriting the hooks' trust state keeps it.
  `oak status` and `oak doctor` name such a hook as turned off in Codex, where they reported the hooks'
  trust as partial and told you to re-run `oak init --codex`.
- OAK reads a Codex `config.toml` that begins with a UTF-8 byte order mark, as Codex does. `oak init`,
  `oak init --codex` and `oak uninstall` stopped on one with "Invalid TOML document", and `oak status`
  reported the Codex hooks' trust as `no-config`; the TOML parser OAK bundles, smol-toml, reads past the
  mark from version 1.9.0. OAK's edits to such a file keep the mark first, once. `oak models use` put its
  `model` and `model_provider` lines in front of the mark when a table came right after it, and Codex then
  refused to load the file; where a `model` line came first, it rewrote that line without the mark. In
  herdr's `config.toml`, a `[ui]` or `[theme]` header or a sidebar width right after the mark was missed:
  OAK added a second table or width, which herdr refuses, so OAK put the file back and said herdr had
  rejected its sidebar widths or theme.
- OAK reads its preferences file (`prefs.json`) when it begins with a UTF-8 byte order mark. It took such
  a file for no preferences at all, and the next setting it saved, such as the terminal app's layout,
  `oak titles --off` or VS Code's sort order, replaced the file and lost the others.
- A setting made in `prefs.json` while the terminal app runs stays set. The app wrote back the preferences
  it had read at start on every tab switch and every option it saved, which undid `oak titles --off`
  (`"remoteTitles": false`), so OAK read session titles from claude.ai again; `"machineUsage": false`, so
  the saved machines' usage read resumed; `oak usage --bill-day`; and `oak store --move`, so the store was
  looked for where it had been. The app now saves only its layout and the options it changes, over the
  file as it is then, and leaves a file that does not parse (a hand edit saved half done) as it is, saying
  so on the status row. Options → Reset every option keeps the settings made outside the options window,
  such as the bill days and `oak titles --off`.
- A store moved while OAK runs is followed there. The terminal app's views worker, the VS Code extension and
  `oak notify --watch` kept the location they started with: after `oak store --move`, or a move from another
  surface, Review listed none of the session's files, the old location was given a `session-meta` folder
  again, and moving the store back there was refused because it was no longer empty. Every long-running OAK
  process now looks up the store's location in `prefs.json` each time it resumes work, on a file system that
  dates a write to the second or two (FAT, HFS+) too, where a location written twice within that time was
  missed. VS Code and JetBrains
  watch the store where it went, after their own move as after another surface's: VS Code's watcher stayed on
  the folder it started on even after its own Store location command. The focus server stops once the store
  has moved, and the terminal app's reconnect starts one where the store went: where a move took its endpoint
  away (a move made by copying, as one back to the default location is; a new path too long for a socket;
  any move on Windows), `oak focus` could not reach it, and it kept a new focus server from starting until
  it exited. Stopping, the focus server removes its own socket and pidfile only: it removed them by path,
  and a server started since where the store is now (moved back there) lost both while it ran. The terminal
  app tries a reconnect that failed again, waiting longer each time, up to a minute; it gave up after one try.
- A `prefs.json` that does not parse (a hand edit saved half done) leaves every running OAK process on the
  store where it is. Read as no preferences, it sent them to the default location until it parsed again:
  Review listed nothing, the terminal app's views worker wrote its caches there, the focus server stopped
  and one started there, and `oak store --default` then refused the default location as not empty.
- No capture or review decision is lost while the store moves. An edit an agent made during `oak store
  --move`, or during a move from the terminal app's options or either editor, was written where the store
  had been: during a move to another file system, which copies the store, it was copied or not, and the
  removal of the original then deleted it or failed on it; after a rename, or before the new location was
  recorded, it made the old location again and stayed there, where nothing looked. With six agents editing
  through a move of a 400 MB store to another file system, eight edits of 59 were lost. A decision made
  meanwhile was lost the same way: a keep, undo, redo or resolve, a comment, an ignore sweep, a deleted or
  hidden session, `oak clean`, the update channel and the install ledger. An undo lost so left its file
  reverted and its edit still pending. During a move on one file system, which renames the store, a decision
  made before the new location was recorded found no store where `prefs.json` pointed: a keep kept nothing,
  an undo said there was no such edit. A move now takes a lock, waits for the captures and decisions already
  being written to finish, moves the store, records the new location in `prefs.json`, removes the original
  and lets go; a capture or decision that starts meanwhile waits for the move, then reads and writes where
  the store went. Either waits up to 10 seconds, and a move that cannot begin within 8, because something is
  still being written, is refused before any of them gives up. A capture made during a move that takes
  longer, a Bash command's included, is recorded as a capture gap in its session, and the move says how many;
  a decision is refused, saying the store is being moved, and writes nothing, so it can be made again. A move
  that crashed holds nothing up for long: its lock is broken by the same rules as a session's capture lock,
  or once it has gone a minute without the refresh a running move gives it, whatever process now has its
  number. A move stopped that long, or one that took a minute to copy a single file, finds its lock taken,
  also once it has renamed the store or recorded where a copy went, and undoes itself and says so: the
  rename is reversed, or the copy removed and the location put back. Where a capture let in meanwhile made
  the old folder of a renamed store again, the store stays where it went, and the move says that the old
  folder holds what was recorded while it was stopped. A second move while one runs is refused.
  The lock, a registration for each capture or decision while it is written, and those notes are kept in
  `claude-observatory-move` beside the default store folder. What OAK rebuilds as it reads, written where
  the store had been by a process that had not followed it yet (the terminal app's views worker, between two
  refreshes), no longer makes a move back there refuse the folder as not empty: it is removed first.
- A store move to another file system stands once the copy is made and recorded. A removal of the original
  that stopped part way (a file another program holds open, a folder OAK cannot empty) was reported as a
  failure that left the original half removed, `prefs.json` with it, and the whole copy where nothing
  looked. It is now a note beside the move on every surface; JetBrains said only "Store moved to …". A move
  whose new location `prefs.json` cannot record (a hand edit saved half done meanwhile) is undone, by
  removing the copy or reversing the rename; one that cannot be undone either says, on every surface, that
  the store moved and OAK looks for it where it was. The copy keeps the store's folders private to you
  (Node's fast copy, in recent versions, gave them the default mode, such as 0775), copies no lock, which
  held up the next capture of its session as a live holder's would, and leaves out the focus server's
  socket, which no copy can take.
- A store location written as `~name/…` is refused as relative, by `oak store --move` and the terminal app's
  options, and ignored in `prefs.json` by every surface, JetBrains included. Only the home
  (`~`, `~/…`) is expanded, so it was kept in the folder each process started in, an agent's project among
  them.
- VS Code's Store location command no longer undoes a setting made while its pick or folder dialog was open,
  in the terminal app's Options or with `oak usage --bill-day`: it wrote back the preferences it had read
  before the dialogs, with the new location.
- Saving a setting keeps what this build of OAK cannot read in `prefs.json`: a setting a newer build added,
  a key bound to an action this build does not have, a notification kind or field it does not have, and a
  value it does not recognize, such as a newer palette. Every writer (the terminal app's layout and options,
  `oak usage --bill-day`, `oak titles`, `oak store --move`, VS Code's sort and Store location, and JetBrains
  through the CLI) rebuilt the file from the settings it knew and dropped the rest. Every writer now leaves
  a `prefs.json` that does not parse (a hand edit saved half done) as it is and says so, where it replaced
  the file with its one setting, and a store move stops before anything moves while `prefs.json` does not
  parse, since the new location could not be recorded in it. `oak titles --off` then keeps the cached
  titles, which it removed before the save was refused.
- The month figures' bill day falls back to the subscription date in the `.claude.json` Claude Code uses,
  which is in `CLAUDE_CONFIG_DIR` when that is set. OAK and the bundled status line read the one in the home
  folder, so with a relocated config the month followed the calendar instead of the bill cycle.
- The terminal app no longer says `watching projects degraded: ENOENT` (or `Observatory store watcher:
  ENOENT`) when it starts in a folder no agent has run in, or on a machine with no agent session yet. A
  folder that is not there yet is watched once it appears; the whole projects folder was given up to
  polling instead. On Linux a folder deleted and made again, such as a session's folder or the store moved
  away and back, is watched again, as JetBrains now watches a store folder deleted and made again by the
  next capture: each kept a watcher that no longer reported, and a live view stopped updating.
- OAK reads Claude Code's `settings.json` when it begins with a UTF-8 byte order mark, and its writes keep
  the mark first. `oak init` and `oak doctor` called such a file invalid JSON, `oak status` found no
  capture hooks in it, and `oak uninstall` could not parse it, while `oak statusline` rewrote it without
  the mark; the bundled status line's installer keeps the mark too.
- The bundled status line's installer finds a `[tui]` table right after a byte order mark in Codex's
  `config.toml`, and keeps the mark first, once. It added a second `[tui]` table there, which Codex
  refuses. The status line reads a `prefs.json` that begins with a byte order mark, so the bill day you
  set with `oak usage --bill-day` anchors its month again.
- `oak uninstall --all` removes the status line the bundled installer set in Codex's `config.toml`: its
  lines marked `# oak-statusline`, and the `[tui]` table it added when nothing of yours is left in it. It
  reverted only Claude Code's, although its tip says it reverts the bundled status line.
- `oak uninstall --project --all` leaves the bundled status line, which its installer sets up for your
  user rather than for a project, and says that `oak uninstall --all` reverts it. It deleted the status
  line's script while your user settings still ran it.
- `oak uninstall --purge-store` without `--all` says that it purged nothing, and names the command that does.
  `--purge-store` takes effect only with `--all`, and alone it left the stored edits in place and said nothing of them.
- `oak uninstall --all --purge-store` removes every session folder in the store, one holding no edit log among them (a
  session that only asked and read, a Bash command's snapshot stub), where it took only those with a log. `oak uninstall
  --all` names the files it leaves: those the bundled status line keeps beside its cache (`statusline-usage.json`, and
  `statusline-last.json.month-refresh`, `.pull-log` and `.pulling`), and the compile cache the `oak` launcher keeps.
- The GPT month estimate no longer disappears after Codex's weekly reset. The month's budget is projected
  from the week's own fill, and from the reset until GPT is used again the week has none; the budget the
  last sampled week gave now stands in, for up to 35 days, in the terminal app's status bar,
  `oak usage --json` and both editors' GPT rows. A fresh sample replaces it.
- A month with no usage yet reads 0%, for Claude and for GPT, on the status bars of the terminal app,
  VS Code and JetBrains and in both editors' Stats panels, and the Claude Code status line draws it as a
  `0%` bar (`~0/` its budget). Right after a bill cycle rolled over, the month's count of 0 was read as
  no data: the month was left out, and on the status bars so was the whole Claude or GPT group when its
  5-hour and weekly windows had nothing to show either. `oak usage --json` reports such a month as 0
  where it reported null. A month that was never measured, such as GPT's before it has a budget to share
  against, is still left out.
- VS Code's Update now names what the CLI updated on this machine, from the plans read before and after
  it. It showed "CLI and JetBrains plugin refreshed" whenever the CLI's update succeeded, whatever the
  CLI had updated.
- A `--machine` command that is stopped (SIGTERM, SIGINT, SIGHUP, or SIGQUIT on macOS and Linux) now
  stops its ssh as well, then ends by that signal as before, so ctrl+c still stops a shell loop that
  runs it; one that ends with an unexpected error stops its ssh too. The ssh was left running on its own
  until the remote command finished, as it still is when the command is killed with SIGKILL (`kill -9`),
  which no program can handle. The command on the saved machine is not signalled, and may still finish
  there. On Windows, only ctrl+c and closing the console window reach the command this way: when another
  program stops it, as the terminal app does at its deadline, it ends at once and its ssh runs until the
  remote command ends, as after SIGKILL.
- When ssh cannot reach a saved machine, a `--machine` command names why with the last two lines ssh
  wrote that can say so, joined by ` — `, where it showed the first line ssh wrote. For a host whose key
  has changed, that first line was a row of `@` signs from ssh's warning banner; the reason now reads
  `Host key for <host> has changed and you have requested strict checking. — Host key verification failed.`
  Two lines, because the line that says why is not always ssh's last: a server that refuses the login,
  such as one whose PAM configuration refuses logins while it starts, says why before ssh's line that it
  closed the connection, and its banner comes in the same place. The lines that never say why are passed
  over: a stale control socket, the host key that `accept-new` has just recorded, the login that
  `LogLevel VERBOSE` reports as done, ssh's note that it allocates no terminal (where your ssh
  configuration asks for one with `RequestTTY`), and the rows of `@` around a warning. So are the lines
  ssh adds once another line has said why, such as
  `Connection closed by UNKNOWN port 65535` through a jump host or `ProxyCommand`, a jump host's
  `stdio forwarding failed`, the transfer totals that `LogLevel VERBOSE` prints, and scp's closing lines.
  The rows `oak update` prints for saved machines name the reason the same way, and so does
  `oak machine add`, which also showed the first line, for its ssh and scp.
- A search stopped while it writes a session's search index no longer leaves the partial index behind,
  often several megabytes: the next search there removes it.
- OAK's ssh to a saved machine (`--machine`, `oak machine add`) no longer becomes the master of a
  shared connection that ends with it, and the ssh `oak update` now runs to each saved machine never
  does. With ControlMaster on and no ControlPersist in your ssh configuration, the first ssh to a host
  is the master that every later session to that host rides on, and OAK stops its ssh at a deadline or
  at ctrl+c, which closed those sessions too. OAK's ssh now runs with `ControlMaster=no` there, and
  still uses a master that is already open. It does the same when ssh cannot print its configuration
  for the host (`ssh -G` fails, or runs past five seconds). With ControlPersist set, the master runs in
  the background, and OAK's ssh shares it as before. On macOS and Linux, the same holds for the ssh that
  herdr runs for OAK's `herdr --machine` commands (the terminal app's reads and replies, an editor's
  prompt to a pane there, `oak prompt`, `oak quote --send`, `oak comment send` and `oak doctor`), which
  OAK now stops with herdr. Wherever OAK's ssh to the saved machine's target would run with
  `ControlMaster=no`, herdr 0.9.1's does too, since it gives that ssh no option about connection
  sharing. OAK runs herdr's ssh through a small `ssh` script that it puts first on the command's `PATH`,
  kept in the `herdr-ssh` directory of its store, which only you can write to. A reply the terminal app
  sends gets `ControlMaster=no` without OAK asking `ssh -G` first, so that it starts at once; it still
  uses a master that is already open. When OAK cannot put that script in place, or the store is on a
  `noexec` mount where it cannot run, herdr's ssh runs without `ControlMaster=no`, as before, and `oak
  doctor` names the machine and why. herdr 0.9.2 and later give that ssh a shared connection of their
  own, kept in the background with `ControlPersist`: the script leaves it as herdr sets it up, and
  `oak doctor` gives no warning about the script with them.
- In the terminal app, `e` on a session reviewed on a saved machine opens the selected file on that
  machine: a terminal editor (`nvim`, `vim`, `hx` and the others the options list) runs there over
  `ssh -t`, and VS Code or Cursor open it from here through Remote-SSH. Other editors say they cannot.
  It used to refuse, and on a zoomed Diff, below a size note or below an error that refusal was never
  drawn, so the key seemed to do nothing. A status a key writes now shows for five seconds over those
  rows before they return, also while a list such as the session picker is open, and an error that
  arrives in that time replaces it at once. `ctrl+c` while that machine's ssh connects or asks for a
  passphrase stops the ssh and leaves the app running. The editor is run by its name, found on that
  machine's PATH, a second `e` while the first is starting is ignored, and the ssh session carries none
  of this machine's store or agent identity.
- In the terminal app, a Keep, Undo, Redo or Resolve that fails shows its error on the status row for
  at least five seconds. The read that follows every decision cleared it at once, so a failed decision
  looked like one still running.
- The terminal app ends with status 0 when its terminal closes, as on the hangup signal that closing
  sends. A read from the closed terminal, or a write to it, could fail (`EIO`) before that signal
  arrived, which ended the app as a crash, with status 1 and `dash: Error: read EIO` or `write EIO` on
  its error output. It happened rarely, and more often on a busy machine.
- In the terminal app's Review tab, `e` (open in `$EDITOR`) and `y` (copy the path) act on the
  selected Map row. While an edit's diff was open, both used the diff's file instead, so `e` on another
  Map row reopened the same file and `y` copied the wrong path. On the Diff pane both still use the
  diff on screen, and `e` on a row that names no file (a Prompts row) opens the diff's file, as before.
  On the outside-the-workspace row of an older CLI's map, which names no real path, `y` says so, as `e`
  does.
- An overlay on the Observatory tab (the `?` help, the palette, Options or a picker) keeps the
  Observatory's own key row. It showed Review's window bar, session line and key row, which name keys
  (`a`, `u`, `e`) that do nothing on the Observatory.
- In the terminal app, the session picker keeps its highlighted row on screen, and scrolls to the last
  row of a long list. It sized its window four lines taller than the list drawn under Review's window
  bar and session row, so the row it opened on could sit below the screen, and the last rows (another
  machine's sessions, listed after this machine's) never came into view. A row wide enough to wrap is
  counted as the lines it takes. The filter menu uses the same measured height, so its selected row
  stays on screen in a short terminal.
- In the terminal app, the `?` help and the other text windows scroll to their last line. Scrolling
  stopped several lines short of it, because the limit took the window to be taller than the one
  drawn under Review's window bar and session row, and counted a line wide enough to wrap as one.
- Review no longer opens onto an empty full-screen Diff. A Diff zoomed when the layout was saved came
  back zoomed at the next launch, when no edit is selected, so the screen showed only the hint to select
  one; switching session from a zoomed edit did the same. The zoom now ends with the session it
  belonged to and is not restored at launch.
- On Review, `g` and `G` stop where the arrows stop, so `G` selects the last file's whole header
  instead of only its counts line. On the Diff pane they scroll to the top and bottom of the diff.
- `F` reports how many files it folded or unfolded; it counted each file twice.
- `ctrl+v` where nothing takes text says that it pastes into the filter or a reply box. It reported
  "pasted N chars" while the text went nowhere.
- Codex's Auto-review threads no longer fill the session lists. Codex runs each approval under
  Auto-review (`approvals_reviewer = "auto_review"`) as a thread with a rollout of its own, and OAK
  listed every one as a session named after the session it reviews, which pushed the sessions
  themselves out of view. The terminal app's picker and Observatory, both editors and `oak sessions`
  now leave them out, as do the lists of a saved machine once it runs this version, and none of them
  becomes the session a workspace resolves to. This holds for Codex 0.160.1 as well, which names each
  such thread "Guardian review" in its index; an OAK from before this version still lists them, as
  "Auto-review: " followed by the reviewed session's name. Conversation search leaves them out as
  well: each quotes the session it reviews, so a search for that session's words returned its reviews
  ahead of it. `--session` naming one still opens it, `oak sessions --all` lists them, and usage
  figures still count their tokens.
- herdr tabs that run Codex no longer end up named "Codex memory update". Codex runs its
  memory-writing agent inside the session in the pane, and OAK reported that agent to herdr as the
  pane's session, so herdr gave it the pane and OAK named the tab after it. OAK now leaves the pane
  and its tab to the session that runs there, for the agent in `memories` and in `memories_v2`, also
  when the login shell Codex runs each hook through sets CODEX_HOME or HOME to another folder while
  the agent runs in Codex's default `~/.codex`. No pass of the terminal app names a tab after the
  agent. A pane already given to the agent goes back to its session at that session's next turn, even
  before the session has a title, and its tab takes the session's name once there is one. A pane on
  the machine the terminal app runs on also goes back on the app's next pass while it is open, each
  time the agent takes it, including one the app had itself reported for that session before the agent
  took it. Checked against the source of Codex 0.160.1 and on herdr 0.9.1 and 0.9.3. Nothing needs to
  be reset, but Codex runs whichever `oak` its hook's login shell finds first, so a machine where that
  is an older OAK keeps giving the agent the pane until that `oak` is updated or removed.
- The terminal app no longer reports "herdr review tokens: herdr command did not return JSON" for a
  session on a saved machine. herdr 0.9.1 prints nothing when it records a pane's review count, and
  OAK took that silence as a failure, so it sent the count again over ssh on every pass. The btop
  tab on a saved machine had the same problem when OAK started the monitor in it.
- Codex sessions whose approvals go to Auto-review (`approvals_reviewer = "auto_review"`) no longer
  post "needs your permission" on the desktop, or in the terminal app, VS Code or JetBrains, while
  Codex's reviewer, not you, answers the prompt.
  Codex runs its permission hook before the reviewer decides, and the hand comes down only when the
  approved call reports its result. OAK reads the setting from the session's rollout, and in such a
  session announces a permission prompt only if it is still up after 90 seconds, the time Codex gives
  its reviewer. Codex hands a prompt to you only when the review cannot finish, so such a prompt is
  announced up to 90 seconds late. A prompt whose approved command Codex left running in the
  background, such as a server still running when its `yield_time_ms` passed, stays up until Codex
  reports the command's end, the agent starts another call, or the turn ends, so it can still be
  announced after the 90 seconds. Any other permission prompt, Claude Code's included, is announced
  only if it is still unanswered five seconds after it went up. The message each surface shows in its
  own window for the prompt (a note at the bottom of the terminal app, a notification in VS Code, a
  balloon in JetBrains) waits the same way; it showed at once. The hand still rises at once in every
  surface.
- `oak notify --session`, which JetBrains posts through, ends as soon as the permission prompt is
  answered instead of waiting out the whole wait. With `--json` it also reports `stillUp`, whether the
  prompt was still up when its wait ended.
- A permission prompt stays up while a call of another agent in the same session starts, such as a
  subagent's while the main agent waits on you, or the main agent's while a subagent does. That call's
  start lowered it, so the terminal app and the editors showed nobody waiting while the prompt was
  still open. Each agent's own next call lowers the prompts that agent asked for, and any call lowers a
  prompt that names no call, such as one raised by Claude Code's permission notification alone. A
  subagent's prompts also come down when the subagent finishes, since a call it was denied reports
  nothing: `oak init` now hooks Claude Code's `SubagentStop`, so run it again with Claude Code closed
  (`oak doctor` names the event until then), and Codex's is already hooked.
- VS Code's jump to the next session waiting on you (`ctrl+alt+x` then `h`, `⌥⌘X` then `h` on macOS,
  or a click on the status bar's `⚠` chip) now reads who is waiting when you use it. It used the list
  the Timeline last drew, which the Timeline updates only while it is visible, so with the Timeline
  hidden it could jump to a session already answered, or say that the session list did not load.
- On macOS, a notification posted from an editor or a herdr pane no longer opens Script Editor when
  clicked, if terminal-notifier is installed. OAK now posts through terminal-notifier in preference to
  osascript: a click brings forward the app OAK was started from and, for a notification posted by
  the terminal app or JetBrains, selects the session in an open OAK terminal app; a newer
  notification for the same session replaces the older one. OAK finds terminal-notifier in Homebrew's
  directories (`/opt/homebrew/bin`, then `/usr/local/bin`) when it is not on PATH, as in an editor
  launched from the Dock. Without terminal-notifier, `oak doctor` warns that a click opens Script
  Editor and suggests `brew install terminal-notifier`; it looks in the same places the notification
  does.
- The Codex month's dollar figure no longer leaves out a turn from a hosted custom provider that OAK
  has no price for, such as an OpenRouter model outside its price table. Such a turn now makes the
  figure unavailable; turns from a local Ollama or LM Studio still count as $0, and so do OpenRouter's
  `:free` variants. A custom provider is judged by its id, not its `base_url`, so one that serves a
  local model, such as a vLLM server on localhost, also makes the figure unavailable.
- The Claude status line's month dollar figure now prices each model by the same rules as `oak usage`
  and the editors' usage views. It priced a model outside Claude's families, such as a local model or a
  gateway model behind `ANTHROPIC_BASE_URL`, at the Opus 5 rate; such a model now adds nothing. It
  also priced Bedrock and Vertex ids such as `us.anthropic.claude-sonnet-4-5-20250929-v1:0` at
  nothing, Opus 4.5 to 4.8 at the Opus 4.0 rate, and GPT ids at nothing; they now carry the same rates
  as in `oak usage`, where gpt-oss has none. It prices each model once per render rather than once for
  every usage line it reads.
- gpt-oss, the open-weight model usually run locally, has no dollar figure outside a provider's price
  table, as other local models have none. `oak usage`, the editors' usage views and the status line priced
  it at GPT-5's rate, marked approximate.
- JetBrains' version chip compares the plugin's own build with the channel as well as the CLI's, as
  VS Code's compares its extension and the CLI: a plugin behind or above the channel, other than a local
  build, shows the dot and says so in the menu, where the plugin row used to repeat the CLI's state. After
  an update the plugin row shows the installed build as pending a restart, and only in the IDE whose
  plugin was updated: `oak update --json` names each JetBrains row's plugins folder. `oak version --check
  --json --compare <version>` reports how another build stands against the channel.
- In VS Code and JetBrains, Update now or a channel switch while an update started in the same VS Code
  window or the same JetBrains IDE is still running says that one is running there, and starts nothing.
  It started a second `oak update` beside the first, over the same installs. An update started anywhere
  else, such as `oak update` in a terminal, another VS Code window or another IDE, is not detected.
- JetBrains' Update Now offers the IDE restart whenever the plugin in the IDE's own plugins folder is
  not the build it runs, as `oak update --json` reads that folder after the update, and marks that
  build pending a restart. It said "no restart needed" while the old build ran when VS Code's Update
  now, `oak update` in a terminal, or an earlier Update Now answered with Later had already replaced
  the plugin, and it offered no restart when the update replaced the plugin but failed at something
  else. It still reports that failure.
- `oak undo --json`, `oak redo --json` and `oak ignore` with `--json`, `-v` or several paths no longer cut
  their answer short when it goes through a pipe whose reader is slower than OAK. They ended the process
  as soon as the answer was handed to the pipe, which dropped everything past the pipe's buffer (8 KB on
  macOS, 64 KB on Linux), so a script or editor received JSON it could not parse.
- A command whose reader stops reading early (`| head`) now ends with its own exit status, such as 1 from
  `oak comment rm` for a comment that does not exist, or from an `oak tui --once` frame that fails; it ended
  with 0.
- The CLI's human-readable output no longer passes escape sequences from agent-written text (session
  titles, prompts, replies, file names) to your terminal, where one could retitle the window, clear the
  screen or write the clipboard. Control characters are filtered as the terminal app filters them,
  keeping colour. `--json`, `oak blob`, `oak export`, `oak diff --patch` and `oak ignore -z` stay byte-exact
  in a pipe or a file; `--json`, `oak diff --patch` and `oak ignore -z` printed to a terminal are filtered too,
  as is what a command run on another machine with `--machine` prints to a terminal.
- An edit captured after clearing resolved edits, or after an `.observatoryignore` sweep, no longer
  takes the id of an edit the rewrite removed. A session delete confirmed before that edit arrived could
  purge it unseen; it now refuses, as it does for any edit newer than the listing it was confirmed from.
- Windows desktop notifications now post under Windows PowerShell's registered app id. The previous
  `OAK` id was registered by no Start-menu shortcut, so Windows could drop the notification.
- Parsing a heading that runs into a bare carriage return, a long blank run in `.observatoryignore`, and
  a prompt of many unclosed `<pasted_content>` openers is now linear; each took seconds at tens of
  thousands of characters.
- `:ignore` in the terminal app's palette applies `.observatoryignore` to the session under review, as
  Refresh does: on the machine where that session is, and only after asking with the count. It ran
  `oak ignore` for the directory the app was started from, which dropped that session's now-ignored
  edits without asking.
- `oak tui --root <dir>` and `oak tui --root=<dir>` review the session of `<dir>`, in its first frame, in `--once`, in the
  newer-session hint and after deleting the session under review. It opened on the session of the directory it was
  started from, and outside a repo on the newest session anywhere. An empty `--root=` now fails with
  "`--root` requires a path" in every command and the app; commands read it as an empty root, and
  `oak export` wrote `"root": ""`.
- `oak tui --session=<id>` opens that session, as `oak tui --session <id>` does. It opened the session the
  terminal app picks when none is named, and an id this machine does not have was not reported.
  `oak sessions --session=<id>` likewise lists that session, as the two-word form does. An empty
  `--session=` now fails with "`--session` requires a session id", as a bare `--session` does, instead of
  reviewing or listing the current directory's session. `oak stats` and `oak usage` read `--session=<id>`
  too, with the checks `--session <id>` gets; they ignored it, an unsafe id included, and exited with
  status 0. In both, and in `oak clean`, an empty `--session=` and a bare `--session` now fail with
  "`--session` requires a session id": `oak clean --session=` cleaned the whole store, and in `oak stats`
  and `oak usage` a bare `--session` read the current directory's session, or took the flag after it,
  such as `--json`, as the session id.
- A herdr tab keeps following its session's title when the terminal app's tab pass and the session's
  own tab sync save their records at the same moment. The pass could erase the claim the sync had just
  written, and the tab then kept that title. When the title changed twice while a pass ran, the pass
  could also rename the tab back to the older title after the sync had named it, and the tab kept that.
- The status line no longer shows last week's `fable` share beside this week's countdown when the
  account's usage has not been read since the weekly reset; the terminal app and both editors already
  left it out. JetBrains' Stats panel lists the `fable` cap on a plan with no `5h` and `wk` windows,
  as VS Code's panel, the terminal app and the status line do.
- The Claude Code status line no longer shows `5h —` or `wk —` when its session has sent no share for
  that window since the window reset but this machine has already measured one for the current window.
  The line now shows the share its own read of the account's usage returned, else the one another
  session or an earlier read measured inside the window, with the same bar, figures and countdown as a
  share from the session; a share measured before the window began is still not shown. A share the
  status line reads from the account's usage is now dated by when its render began, not when the render
  finished: one read just before its window reset, by a render that ended after the reset, counted as
  the next window's, in the terminal app and both editors as well. A window at 0% with no figures to
  show, such as the `fable` cap of a model not used this week, reads `~0` inside its bar instead of an
  empty bar, as the month at 0% reads `~0/` its budget. `oak update` or `oak statusline` refreshes an
  installed status line.
- The Claude 5-hour and weekly shares no longer drop to an idle session's old share. Every Claude Code
  session redraws its status line every minute, idle or not, and a session idle for days sends the shares
  of its last reply: the status line drew them, recorded them as measured that minute over the share
  another session had just measured, and OAK's readouts and the saved machines that read this one showed
  them (`wk: 0%` beside a week at 49%). The status line now dates each share: one a session sends by that
  session's last reply, or by its newest subagent's when that is later, its own read of the account's
  usage by the moment it reads it, and the one already recorded by the time it was measured. Each window
  shows, and records with its own date, the most recent of them, so a share from an idle session no longer
  replaces a newer one, also when two sessions redraw at the same moment; a share that falls within a
  window, as after a plan upgrade or a limit promotion, still shows once the account or a session reports
  it. A share measured more than five minutes before the line is drawn no longer calibrates the token
  estimate. `oak update` or `oak statusline` refreshes an installed status line.
- A 5-hour window whose reset has passed now reads `0%` with no countdown in the status line, the
  terminal app, both editors, `oak usage --json` and the reading saved machines take of this one, until
  a session or the account's usage reports a newer window. The token estimate and the cache reads
  (`+30M↺`) shown beside it were the ended window's, and are left out. A 5-hour window starts only with
  the first message after the last one ended, so the countdown rolled forward from the last reset named a
  window that did not exist: after a night with no use the readouts showed `5h: 0% 48m` for a window that
  had begun a minute earlier and would reset in five hours. A share above 0 measured after the last reset
  by a Claude Code that sends no reset with it, as 2.1.263 did, still gets its countdown estimated from that
  reset; the weekly windows run on a fixed schedule and still roll forward. `oak update` or
  `oak statusline` refreshes an installed status line.
- GPT's 5-hour window, once the reset Codex reported has passed with no newer reading, reads `0%` with no
  countdown in the terminal app, both editors and `oak usage --json`, as Claude's does. It was left out,
  and its slot with it. A newer reading is one any session on this machine took: a Codex session named in
  a Stats panel whose own window has ended, or the session written to last, shows the window another
  session has open. A plan whose Codex reports no 5-hour window, only the weekly one, still shows none.
- A GPT window whose reset Codex reports only as the seconds left in it (`resets_in_seconds`, which older
  Codex versions write in place of `resets_at`) now resets that many seconds after the reading was taken.
  It was read as having no reset, so its share stayed, with no countdown, in the terminal app, both editors
  and `oak usage --json` after the window had reset: `40%` two hours after a reset that was ten minutes
  away when the reading was taken. Once that reset passes, the 5-hour window reads `0%` with no countdown
  and the weekly one is left out, as when Codex reports the reset's time; until then each shows its
  countdown. The weekly window's tokens, and the month's budget and share estimated from them, count from
  the start of the week that reset ends, as when Codex reports the reset's time, and `oak usage --breakdown`
  divides Codex's weeks there; they counted the last seven days.
- The status line's cache reads beside a new 5-hour window are that window's from its first redraw. They
  were the last window's (`+30M↺` beside a window a minute old) until the next scan, up to ten minutes
  later. `oak update` or `oak statusline` refreshes an installed status line.
- In both editors' Stats panels, a window at 0% reads `~0`, as the status line reads it: against its
  budget where it has one (`~0/` the budget), and alone where it has none yet. That is Claude's 5-hour,
  weekly, `fable` and month rows, and GPT's 5-hour, weekly and month rows. The used column was empty, and
  on the 5-hour and weekly rows the budget too.
- The status line keeps the weekly and `fable` shares of an account usage answer that reports no 5-hour
  window, which it dropped whole. `oak update` or `oak statusline` refreshes an installed status line.
  OAK's own read of the account's usage records an answer whose 5-hour window has no reset (no window
  running) as the status line does: the 5-hour share
  as 0, measured at that read, beside the reset already recorded, so the terminal app, both editors,
  `oak usage --json` and the status line read a 5-hour window whose reset has passed as ended, `0%` with
  no countdown. The read recorded the share the answer gave beside no reset, or kept the share recorded
  before, and a share above 0 measured after that reset was read as the current window's, with a
  countdown estimated from it (`7% ·4h 0m` in the status line, for a window that had ended an hour before).
  The status line's own read of such an answer now ends that window too, where it kept such a share and
  its countdown. A 5-hour reset already recorded that is still ahead keeps the share recorded beside it, in
  both reads, as the status line's own read kept it. An answer with no 5-hour window at all is an account
  with no five-hour limit, which shows no 5-hour readout (under Changed).
- Two Claude Code sessions redrawing their status lines at the same moment no longer break the record the
  status line keeps of the usage shares and of the spend each session reported. Both wrote it through one
  temporary file, which could leave it unreadable; the next redraw then started it over, and the shares
  and the spend it held, which OAK's spend totals add up, were lost. `oak update` or `oak statusline`
  refreshes an installed status line.
- Two Claude Code sessions redrawing their status lines at the same moment no longer undo each other's
  readings in that record. Each redraw rewrites the whole record from a copy it read a moment before, so of
  two redraws started together, the one that finished last put back what the other had just recorded: an
  idle session's redraw restored the older 5-hour and weekly shares with the times they were measured, and
  dropped the spend the other session had just reported until that session's next redraw. A redraw now
  reads and rewrites the record under a lock, which it waits about a second for; when another redraw holds
  it longer, it records nothing that time, and the next redraw, a minute later, records what it would have.
  Its line is drawn either way. A lock left by a redraw that was killed is taken over once it is five
  seconds old, and one the redraw cannot remove (another user's, as a redraw run under `sudo` leaves it) is
  renamed aside. OAK's own read of the account's usage, which records into the same file, takes this lock
  too and waits for it the same way, so a read and a redraw finishing together no longer undo each other's
  readings either; a read that cannot have the lock records nothing, and the next read records the
  account's usage. `oak update` or `oak statusline` refreshes an installed status line.
- The status line removes the temporary files that redraws killed while recording their readings leave
  beside its record (`statusline-last.json.tmp.` followed by a number), and the stale locks it renamed
  aside, once they are more than two minutes old; nothing removed them before. Only the redraw that holds
  the record's lock removes them, and a redraw writes its own file only while it holds that lock. A renamed lock
  that your user cannot remove, such as one a redraw run under `sudo` left, stays. `oak uninstall --all`
  removes them by the same rule. `oak update` or `oak statusline` refreshes an installed status line.
- On a plan with no `5h` and `wk` windows, VS Code's Stats panel reads the month's share, budget and
  cache reads, and the `$` row's share and projected total, as JetBrains' panel does. It showed only the
  month's token count (`~0` before any use), and kept a `$` row with no spend to show.
- A Codex session that Codex has not named yet is titled by its first prompt's first phrase up to a comma
  as well, so a long first sentence no longer becomes the whole title. The comma counts like the other
  clause breaks: only when the phrase before it has at least two words and 12 characters. A first
  sentence that ends within 64 characters is kept whole rather than cut at a clause break inside it,
  so "In packages/core, fix the parser." is not shortened to "In packages/core".
- In the terminal app, `ctrl+c` while `e` has handed the terminal to an editor that keeps it in its
  line mode stops that editor, not the app. The terminal sends `ctrl+c` to every process of the job, so
  the app quit while the editor still had the terminal. The status row then says the editor was stopped.
- Started in a folder with no session of its own, the terminal app's Observatory lists every session,
  as it does from a folder with one, and Review says it has nothing to review. The Observatory listed no
  session there, while its status row said it listed every session, and Review's windows said
  `building…` for good; `oak tui --once` did the same.
- The installers, `oak update` and `oak doctor --fix` add herdr's sidebar widths and gruvbox theme to a
  `config.toml` that writes its `ui` or `theme` table as dotted keys (`ui.status_indicators = …`) or as
  an inline table (`ui = { … }`), in that same form, and under a `[ui]` header written with spaces or
  quotes. They added a second `[ui]` or `[theme]` table, which herdr refuses, so OAK put the file back
  and warned on every run. A `[ui]` line inside a multiline string, such as a custom command's script,
  is no longer taken for the table: the widths went into the string, and herdr got none. The file's own
  line endings are kept.
- When herdr refuses its `config.toml`, the warning from the installers, `oak update` and
  `oak doctor --fix` gives herdr's reason (`unknown config key ui.bogus; ignoring key`). It quoted the
  `config: issues found` line herdr prints first.
- In a workspace with no session of its own, the terminal app's session picker lists this machine's
  sessions. It said it could not list them (`view sessions exited 1`), because it named the session
  as an empty `--session`, which the CLI refuses.
- A paste in the terminal app, the terminal's own or `ctrl+v`, goes into the `:` palette, the `?`
  help's `/` filter and the Diff's find, as typing does. It was dropped.
- The terminal app reads `F1` to `F5` as the Linux console sends them (`ESC [[A` to `ESC [[E`). They
  arrived as their last letter: `F1` was `A`, which asks to keep everything on Review.
- An F-key in the terminal app that names no window or pane says so: `F8` to `F12` on Review, and
  on the Observatory an F-key past its last pane. They did nothing.
- After Refresh the terminal app's status row says `refreshed` once the new read has landed. It kept
  saying `refreshing…` until another message replaced it.
- The terminal app's screenshots and the site's terminal demo no longer draw a coloured cell over the
  top of the row below it, which hid the top of herdr's second row under OAK's tab labels. A coloured
  run of text now paints exactly one row, as it does in the terminal. The rows are also as tall as the
  letters, so the tail of a letter such as y or g is no longer cut off by the row below, and the pane
  borders stay joined: the demo names DejaVu Sans Mono and Noto Sans Mono before the browser's own
  monospace, which can be a font whose `│` is shorter than those rows, such as Ubuntu Mono or FreeMono.
  The demo on the terminal app's docs page also shows the frame on the terminal's dark background rather
  than the page's light code box.
- In the terminal app, a drag across the status row, the usage bar or the key row copies the text
  there, on the Observatory, Review and herdr tabs, as a drag in a pane does: the drag highlights the
  text it covers, and the release copies it. Those rows could not be copied, and on the herdr tab a
  press there reached nothing. The status row is cut at the terminal's edge rather than wrapped, so a
  drag that starts in the status text and reaches that edge, or goes on past the row, copies the rest
  of the status too, and a drag that starts in a toast on the row copies the toast as it shows. When
  the rows move under a drag before its release (the status row goes when its toast runs out or when
  the press clears herdr's prefix note), nothing is copied, and a toast says so. Only the left button
  selects there, a click still does nothing, and on the herdr tab nothing of such a drag reaches herdr.
- In the terminal app, a drag still held when the terminal changes size, in a pane or on the rows at
  the bottom, ends there: nothing is copied, and a toast says so. Its release copied whatever the
  resize had moved under it.
- In the terminal app, each of OAK's copies says how it went in a toast that goes after a few seconds:
  what it copied, as before, or why it copied nothing (a drag over blank space alone, rows that moved
  under the drag, a resize, a copy too large to make, tmux or a clipboard tool that did not finish in
  ten seconds). A drag over blank space and a copy too large to make said so on the status row until
  something else replaced it, on the herdr tab over herdr's last row, and a later copy's toast showed
  beside it. A copy too large to make on a terminal of this machine names the clipboard tools that ran
  and failed (with no display to copy to, say) and which to install, of those not installed; it said
  to install wl-copy or xclip whatever had failed. When the status row is too narrow for a toast and
  the message beside it, that message takes the row in the toast's place if it is a question, a status
  message other than `ready` said after the toast, or the error of a keep, undo, redo or resolve that
  failed after it; the toast cut or hid it. On Review, `selecting — release to copy` goes when the drag
  ends, and `y` with nothing to copy still says so on the status row, as `e` does with nothing to open.
- On the terminal app's herdr tab, what herdr copies reaches the clipboard of the terminal OAK runs
  in. herdr copies a selection in its pane, and passes on what a program in its pane copies, with the
  system's clipboard tool where it has one (pbcopy on macOS, wl-copy, xclip or xsel on Linux), and
  otherwise, or over ssh, in VS Code's terminal or in WSL, as an OSC 52 sequence, which OAK's herdr tab
  dropped. Such a copy now goes on as OAK's own copies do: OSC 52 to the terminal, tmux's buffer inside
  tmux, and on a local terminal the system's clipboard tool for one too large for OSC 52. herdr says
  that it copied, so OAK adds no toast of its own unless the copy cannot be made: for one too large, a
  toast says that herdr's copy is too large for the terminal, and on this machine which clipboard tools
  ran and failed and which to install, as for OAK's own copies. One tmux or clipboard tool runs at a time,
  so a program that writes the clipboard on every change does not start one for each write: the
  newest text waiting goes next. A tool that has not finished in ten seconds is stopped, so the copies
  after it wait no longer than that, and a toast names it and says that nothing was copied. A
  program's request to read the clipboard is never passed on or answered.
- On the terminal app's herdr tab, a drag in herdr's pane released over OAK's rows below it, or over
  OAK's tab bar, ends in herdr, on the nearest row of its screen that OAK shows: herdr finishes the
  selection and copies it, and a program in the pane that reads the mouse gets the release. herdr got
  the press and the motion but never the release, so its selection stayed highlighted and nothing was
  copied, and such a program was left with a button that never came up. While the status row shows a
  message, OAK's divider covers herdr's last row: such a drag no longer selects that hidden row, and a
  click on the divider no longer reaches it.
- On the terminal app's herdr tab, a mouse button still down in herdr's pane is let go there, where it
  last was, when you leave the tab (herdr's prefix, then `m`) or press another button on OAK's rows or
  tab bar: herdr kept its selection up, and a program in the pane that reads the mouse was left with its
  button down. A drag of OAK's own still held when the tab changes ends there, and the selection Review
  keeps after a drag goes with its tab: let go, or copied again with `ctrl+c`, on the next tab, they
  took that tab's text. herdr's prefix pressed during a drag in its pane goes on to herdr before the
  drag's release when that is let go over OAK's rows.
- A drag in the terminal app that ends on a letter followed by a combining accent copies the accent too:
  `café` written with a combining accent copied as `cafe`. One that covers any part of an emoji built
  from several, such as a family, a flag or one with a skin tone, copies and highlights all of it, and
  text coloured with escapes written with colons (`ESC[38:2::255:0:0m`) copies without them. The toast
  after a copy, and `ctrl+v`'s `pasted` count, count a letter and the combining accents after it as one
  character, and so an emoji, and say `1 char` for one; they counted UTF-16 code units, so an emoji or
  such an accented letter counted as two. An emoji built from several, such as a flag, one with a skin
  tone or a family, is one character too.
- The terminal app's status row shows the line breaks and other control characters in a message as
  spaces, and passes no escape sequence but colour, under the help, a picker or the options too, and
  in a toast, which can carry a session's title. A herdr error line not in Rust's debug form came
  through as it was written: a line break in it broke the row in two, and an escape sequence from a
  saved machine's ssh could clear the screen.
- OAK shows a herdr failure as herdr's own message: the terminal app's status row and Observatory,
  `oak doctor`, the CLI, and VS Code's and JetBrains' messages. herdr ends a failed command with
  Rust's debug form of the error, which all of them showed as it came: `Error: Custom { kind:
  ConnectionAborted, error: "machine 'build-box' (session default): remote SSH connection failed: …"
  }`. A line in that form, `Error: Custom { … }`, now reads as its message, `machine 'build-box'
  (session default): remote SSH connection failed: ssh: connect to host build-box port 22: Operation
  timed out`, with the lines of a longer message joined by ` — `; herdr's lines in any other form are
  kept as they are, and so is the line when its message is empty. `oak doctor` no longer puts
  `HerdrError:` before such a failure, and VS Code's `Prompt failed:` message no longer starts with
  it.
- While a saved machine cannot be reached, the terminal app no longer writes herdr's error over the
  status row on every pass. The review count it sends herdr for each session pane on that machine
  failed and was sent again on every pass, each time waiting out the connection timeout, and each
  failure replaced the status row. The failure is shown where the machine is: in the Observatory,
  which marks the machine once its own read of it fails, in herdr's sidebar on the herdr tab, and in
  `oak doctor`. The counts for that machine wait 15 seconds before they are sent again, then twice as
  long after each failure, up to two minutes, and that wait starts again from 15 seconds when the
  machine is removed or disabled in herdr and added again. Any other failure of that count, or of the
  report that tells herdr which session runs in a pane, is shown once rather than on every pass, and
  waits the same way. A saved machine whose herdr is too old to forward OAK's commands is such a
  failure, on every herdr version, though herdr 0.9.2 and later word it as a failure to find herdr
  there, and `oak doctor` now says to update herdr on that machine, where it said to check ssh access
  to it. A conversation pinned from a saved machine that cannot be reached shows its Workers read's
  failure once, and once more each time its pane is opened again; it wrote that failure over the
  status row on every read. Each of these failures leaves the status row once what failed works again,
  or once the pane whose Workers read failed is closed, unless the row has said something else since;
  it stayed there after the machine was back. Another count or read still failing in the same words
  says them again at its next failure.
- A session's title, an ask, a search excerpt or a label cut to fit no longer splits a character: the
  terminal app's session picker showed a family emoji cut at a title's 64th character as `👨‍👩‍�…`, half
  of the family and half of the next emoji. Every such cut now ends where a character does, never inside
  an emoji built from several (a family, a flag, one with a skin tone, a keycap) or between a letter and
  its combining accents: the titles, asks, excerpts and actions core gives every surface, and in the
  terminal app each row fitted to its width, each wrapped line, the columns a sideways pan shows, and
  what a drag highlights and copies; the Observatory's reply box moves over and deletes a character
  whole, and backspace in the filter, the session picker's search, the palette, the help's search, the
  diff's find and an option's text takes one back whole. VS Code and JetBrains cut their own labels the
  same way: a diff's title, the removed lines' ghost text, the folder counter, and JetBrains' feed rows,
  asks and Map labels. A title cut by an earlier version is read again from its transcript. So does a
  cut to a size with no `…`: what `ctrl+v` pastes past its half-megabyte limit, the asks and answers
  the conversation search keeps, a hook's oversized value, the label a workflow's agent takes from its
  prompt, the targets, descriptions and reasoning `oak actions`, `oak risk`, `oak processes`,
  `oak subagents` and `oak insights` cut to fit, the message of a failed title or quota read, and the
  error output a JetBrains notification shows. `ctrl+v` also reads the clipboard tool's output as one
  stream: a character whose bytes two reads split came out as replacement characters.
- In the terminal app, the session picker highlights the whole selected row, as the other lists do.
  On a session with edits the highlight stopped after the session's time, because the colours in the
  row ended it, and a file row in Traces kept it only on its fold arrow.
- On Windows, the programs OAK runs no longer open console windows: herdr's commands when OAK installs
  or checks herdr, the herdr server it starts, ssh, and every other command run by a refresh in the
  background, by VS Code or by the CLI a JetBrains IDE runs. A console program started by a process with
  no console of its own, such as VS Code's extension host or a background refresh, opened a window of its
  own for as long as it ran. An editor or the file manager that OAK opens still shows its window, and
  the ssh and scp of `oak machine add`, a `--machine` command and `oak update` share the command's
  own console, where a jump host's ssh asks its questions.
- The terminal app's Observatory shows a Codex agent that asked a question and kept working as
  working, with `? question` beside it in the waiting colour, in its session row and the conversation
  header. It showed blocked: Codex titles its terminal Action Required while a question waits, and herdr
  reports a pane with that title as blocked even while Codex's turn goes on. OAK now reads the session's
  Codex rollout, and shows such a pane as working while the rollout's last turn has started and not
  ended, no permission prompt is waiting, and either the rollout was written within the last 90 seconds
  or the pane's screen shows Codex's running timer (`Working (5m 2s • esc to interrupt)`) above its
  prompt. A long command writes nothing to the rollout while it runs: once the rollout has been quiet
  for 90 seconds, OAK reads the pane's visible screen through herdr, and again every 15 seconds while it
  stays that way. A turn that has ended, one gone quiet with no timer on screen, a Claude Code pane, and
  every other state show as herdr reports them, and herdr's own sidebar is unchanged. The reply box still
  waits for the answer in herdr and says so (`Question waiting · answer in herdr`): herdr refuses to send
  to a pane it reports as blocked, and Codex takes the answer in its own question view. In
  `oak sessions --json`, a Codex session active in the last two hours has a `turnOpen` field, true while
  its last turn is running.
- When `oak prompts` lists nothing for a session, the Prompts tab in VS Code and JetBrains and the terminal app's
  Prompts screen show the CLI's reason (such as "no transcript found for this session under this directory"). They
  said the CLI on PATH was older than 0.8.8 and had no `prompts` command.
- The Timeline in VS Code shows one header per column, or per tab, with the count and its unit (`25 edits`). With
  Group tabs on, each column repeated its header inside it (`OBSERVATIONS 25`, then `OBSERVATIONS 25 edits`). Moved to
  another panel, the Timeline's title reads "OAK: Observatory Timeline"; in Cursor it read "Observatory Timeline:
  Observatory Timeline".
- The Timeline's labels in VS Code wrap between words, so "Context" no longer breaks inside the word. The Feed's
  first row is no longer hidden under the line above the list; a shadow marks the edge once the list is scrolled.

## [0.10.0] — 2026-09-28

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
