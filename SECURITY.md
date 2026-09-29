# Security Policy

OAK is a local-first, zero-token review + observability layer over
Claude Code. Its data — the content-addressed snapshot store — lives entirely on
your machine under `~/.claude/claude-observatory/`. It performs no model inference
of its own and sends no telemetry. It reaches the network on only these paths:

- **`analyze` / `recap` / `suggest`** — opt-in; each runs your local `claude` CLI
  (which then makes its own model calls).
- **`update`** and **`install-extensions`** — fetch a GitHub Release's assets to update
  OAK or to install its editor extensions; the editors' **Update now** does the same.
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
  installer warns and installs the tarball anyway. `install.sh` builds from its own checkout.
- **herdr installation** — `oak doctor --fix`, `oak update`, and both installers
  (`install.sh` and `install.ps1`) download the binary pinned in `herdr.lock` from
  [herdr's GitHub releases](https://github.com/herdrdev/herdr/releases) and verify
  its SHA-256 checksum before installation. A newer local herdr is left alone.
- **`oak machine add <label> <ssh-target>`** — over SSH and SCP, installs the herdr
  version pinned in `herdr.lock` at `~/.local/bin/herdr` on the target when it has none
  or an older one: it copies this machine's herdr when the platform and version match,
  and otherwise first downloads the target's binary from herdr's GitHub releases and
  verifies its checksum. On macOS it removes the binary's quarantine attribute. It
  saves the machine in herdr (`herdr machine add`). When the target has Node.js 20 or
  newer, it then copies OAK's own files (`cli.js`, `capture.js`, `index.js`,
  `package.json`, `THIRD_PARTY_NOTICES.md` and OAK's herdr plugin) to
  `~/.local/lib/oak`, writes an `oak` launcher to `~/.local/bin`, appends a line that
  puts `~/.local/bin` on the PATH to `~/.profile`, `~/.bashrc` and `~/.zprofile`
  (creating any that are missing), and runs `oak init` there, which writes OAK's capture
  hooks into the target's `~/.claude/settings.json` and Codex's `~/.codex/hooks.json`,
  and adds trust entries for those hooks to `~/.codex/config.toml`.
- **SSH commands you run** — `oak <verb> --machine <label>` runs one of `views`,
  `review`, `list`, `sessions`, `conversation`, `feed`, `multitask`, `subagents`,
  `diff`, `keep`, `undo`, `redo`, `resolve`, `comment`, `quote` and `ignore` with the
  saved machine's own `oak` over SSH. `oak attach <machine>` starts OAK in a herdr pane
  on that machine and hands your terminal to herdr's client there.
  `oak agent start --machine <label>` starts an agent in a pane there (running
  `oak machine add` first when the machine is not saved yet), and
  `oak prompt --machine <label>` sends a prompt to a pane there; these go through
  herdr's SSH connection. `oak doctor` times one forwarded `herdr pane list` on each
  saved machine. OAK's own `ssh` and `scp` calls run in batch mode and accept a host
  key on first contact (`StrictHostKeyChecking=accept-new`), refusing a changed one.
- **Saved herdr machines (automatic)** — the terminal Observatory requests
  per-machine snapshots over herdr's SSH tunnel. Over the same tunnel it keeps each
  machine's `btop` tab (it makes the tab, labels its pane and types the monitor's
  command into that pane's idle shell) and renames the herdr tabs that machine's own
  OAK cannot name: all of them when that OAK predates `oak __tab-sync`, and the tab of
  a session whose capture hooks never ran in its pane there. Over SSH to each enabled
  saved machine it also runs that machine's own `oak` to read its session list and,
  for a session running there, the conversation, edit previews and workers; each is
  refreshed at most every ten seconds. When a session's title there differs from its
  tab's name, it runs that machine's `oak __tab-sync` over the same SSH path, which
  renames the session's herdr tab (never one you named) and records that name in the
  machine's own store.
  When you review a session that runs on a saved machine, the Review tab's reads and
  your review actions (keep, undo and the rest) run that machine's `oak` over the
  same SSH path. Transcripts and edit stores stay on that machine.
  Editor session listings stay on the workspace's machine and do not gather
  remote machines.
- **Account usage** *(automatic)* — to keep the Usage bars live (context, 5-hour,
  weekly, and monthly), OAK calls `https://api.anthropic.com/api/oauth/usage` with
  Claude Code's stored OAuth token, and when that token has expired refreshes it
  against `https://platform.claude.com/v1/oauth/token`, writing the rotated token
  back to the same place Claude Code keeps it — the `~/.claude/.credentials.json`
  file, or the macOS login keychain (service `Claude Code-credentials`). It reads
  and updates only that existing Claude Code credential and sends nothing else. It
  runs whenever usage is shown — `oak usage`, the editors' Usage panel, and the
  bundled status line each kick it — once the cached reading is over a minute old,
  at most one refresh every 45 seconds, and it backs off for five minutes after a
  rate-limited or unavailable reply. There is no dedicated off switch today; it
  simply does nothing when no credential is stored, so skipping the status line and
  the Usage panel avoids it.
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
  to be `0700` dirs / `0600` files).
- A capture path that persists a secret the redaction sweep should have filtered.
- The `siblings` / fleet digest leaking one session's file *contents* to another
  agent (by design it is read-only and path-only — it exposes counts, statuses,
  and file paths across sibling sessions in the same project, never file bodies).
- Any way the capture hooks could be coerced into executing attacker-controlled
  code.

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
- Risk scoring and the egress report are themselves defensive features: they
  surface destructive/privileged shell commands and off-machine destinations a
  session touched, so you can audit what an agent did.
