#!/usr/bin/env bash
# OAK — one-command install / update. No registry account. On Linux, the terminal PTY (node-pty)
# compiles during the install and needs python3, make and a C++ compiler; macOS and Windows need none.
# Downloads a GitHub Release and installs the CLI + editor extensions + status line + hooks.
#
#   curl -fsSL https://raw.githubusercontent.com/cell-observatory/oak-observatory/main/scripts/bootstrap.sh | bash
#
# Pre-release channel (rolling build of the dev branch — newest features, less soak):
#   curl -fsSL .../scripts/bootstrap.sh | bash -s -- --channel dev
#
# Windows: this is bash. Run it from Git Bash, or use install.ps1 (PowerShell, no bash needed).
# Safe to re-run — re-running is how you update. Does NOT commit anything.
set -euo pipefail

REPO="cell-observatory/oak-observatory"
c_arrow=$'\033[1;36m▸\033[0m'; c_warn=$'\033[1;33m!\033[0m'; c_ok=$'\033[1;32m✓\033[0m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
say()  { printf '%s %s\n' "$c_arrow" "$1"; }
warn() { printf '%s %s\n' "$c_warn" "$1"; }
ok()   { printf '%s %s\n' "$c_ok" "$1"; }

# node-pty is an OPTIONAL dependency: when its native build fails, `npm i -g` still exits 0 and prints
# nothing about it. Check that it loads, and say what is missing. Only OAK's herdr tab needs it.
pty_check() {
  node -e 'require(require.resolve("node-pty", { paths: [process.argv[1]] }))' "$1" >/dev/null 2>&1 && return 0
  warn "node-pty did not build, so OAK's herdr tab has no terminal on this machine. Everything else works, and 'oak attach' opens herdr without it."
  if [ "$(uname -s)" = Linux ]; then
    local missing="" t
    for t in python3 make "${CXX:-g++}"; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done
    # npm drops node-pty when its build fails, so one installed with no build/ directory is one whose build
    # script npm never ran: npm 12 runs only the install scripts it is told to allow.
    # Reinstalling keeps the unbuilt package; `npm rebuild` runs its script, and $3 names the one for this install.
    if node -e 'const p = require("path"), d = p.dirname(require.resolve("node-pty/package.json", { paths: [process.argv[1]] })); process.exit(require("fs").existsSync(p.join(d, "build")) ? 1 : 0)' "$1" >/dev/null 2>&1; then
      local build="Build it with"
      [ -z "$missing" ] || build="The build also needs python3, make and a C++ compiler (g++) — missing:$missing. Install them, then build it with"
      warn "npm installed node-pty without running its build script: npm 12 runs only the install scripts it is told to allow, and no npm runs them while ignore-scripts is set. $build $3"
    elif [ -z "$missing" ]; then
      warn "On Linux node-pty compiles from source with python3, make and a C++ compiler (g++), all of which are here: $2"
    else
      warn "On Linux node-pty compiles from source: it needs python3, make and a C++ compiler (g++) — missing:$missing. Install them, then $2"
    fi
  else
    warn "Reinstall to rebuild it: $2"
  fi
}

CHANNEL="stable"
while [ $# -gt 0 ]; do
  case "$1" in
    # `shift 2` with nothing after --channel fails under `set -e` and the script exits SILENTLY, so
    # require the value explicitly and say what is missing.
    --channel)
      [ $# -ge 2 ] || { warn "--channel needs a value: stable or dev"; exit 1; }
      CHANNEL="$2"; shift 2 ;;
    --channel=*) CHANNEL="${1#*=}"; shift ;;
    --dev|--pre|--prerelease) CHANNEL="dev"; shift ;;
    -h|--help)
      printf 'usage: bootstrap.sh [--channel stable|dev]\n\n  stable  tagged releases (default)\n  dev     rolling pre-release built from the dev branch\n'
      exit 0 ;;
    *) warn "unknown option: $1  (try --help)"; exit 1 ;;
  esac
done
case "$CHANNEL" in
  stable|main|release) CHANNEL="stable" ;;
  dev|pre|prerelease|pre-release) CHANNEL="dev" ;;
  *) warn "unknown channel \"$CHANNEL\" — use stable or dev"; exit 1 ;;
esac

command -v npm  >/dev/null 2>&1 || { warn "npm not found — install Node.js 20+ first."; exit 1; }
command -v curl >/dev/null 2>&1 || { warn "curl not found — install curl first."; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# The CLI tarball is the ONE thing this script has to fetch itself — it is what provides
# `install-extensions`, which then does every editor from here on (detection, download, sha256
# verification, Windows .cmd shims). `releases/latest` is the stable channel; the rolling pre-release
# keeps a fixed `dev-latest` tag so its URLs never move.
if [ "$CHANNEL" = "dev" ]; then
  say "Finding the newest pre-release…"
  REL_URL="https://api.github.com/repos/$REPO/releases/tags/dev-latest"
else
  say "Finding the latest release…"
  REL_URL="https://api.github.com/repos/$REPO/releases/latest"
fi
JSON="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$REL_URL")" || {
  warn "Could not reach the release API for $REPO (channel: $CHANNEL)."; exit 1; }
# Parse without jq (may be absent): the tag, and the CLI tarball's download URL.
TAG="$(printf '%s\n' "$JSON" | grep -o '"tag_name":[^,]*' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
[ -n "$TAG" ] || { warn "Could not find a $CHANNEL release for $REPO."; exit 1; }
CLI_URL="$(printf '%s\n' "$JSON" | grep -o '"browser_download_url": *"[^"]*"' | sed 's/.*"\(https[^"]*\)"/\1/' | grep -E '\.tgz$' | head -1 || true)"
say "Release: $TAG  (channel: $CHANNEL)"

# --- CLI (required) ---
[ -n "$CLI_URL" ] || { warn "release $TAG has no CLI tarball."; exit 1; }
say "Installing the oak CLI…"
curl -fsSL "$CLI_URL" -o "$TMP/cli.tgz"
# Verify the tarball before npm runs its install scripts, as install.ps1 and `oak update` do. GitHub
# publishes `sha256:<hex>` as the asset's digest; node (npm's own runtime) parses the JSON.
CLI_SHA="$(printf '%s' "$JSON" | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  let a;
  try { a = (JSON.parse(s).assets || []).find((x) => x.browser_download_url === process.argv[1]); } catch { a = null; }
  process.stdout.write(a && typeof a.digest === "string" && a.digest.startsWith("sha256:") ? a.digest.slice(7) : "");
})' "$CLI_URL")"
if [ -n "$CLI_SHA" ]; then
  GOT_SHA="$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$TMP/cli.tgz")"
  [ "$GOT_SHA" = "$CLI_SHA" ] || { warn "Integrity check FAILED for the CLI tarball (sha256 $GOT_SHA != $CLI_SHA) — refusing to install."; exit 1; }
  ok "sha256 verified"
else
  warn "No published checksum for the CLI tarball — skipping the integrity check."
fi
# A pre-rename install (`claude-observatory`) owns the `claude-observatory` bin, which this package
# also ships, and npm >=7 refuses to hand a bin to a different package (EEXIST) — remove the old
# global first, never --force (--force leaves the old package behind claiming the shared bin; a later
# `npm uninstall -g claude-observatory` would then delete a symlink that belongs to the NEW install).
if npm ls -g claude-observatory >/dev/null 2>&1; then
  say "Removing the old claude-observatory global package (renamed to oak-observatory)…"
  npm uninstall -g claude-observatory --silent \
    || warn "could not remove it — if the install below fails with EEXIST, run: npm uninstall -g claude-observatory, then re-run this script."
fi
# Not --silent: npm's own EEXIST or permission error is the one line that says what went wrong.
# --allow-scripts: npm 12 blocks dependency install scripts by default, and on Linux node-pty's is
# the only way it gets built (npm 10 and 11 accept the flag and change nothing).
if npm i -g "$TMP/cli.tgz" --allow-scripts=node-pty; then
  # Not `npm root -g`: npm 11 and later print a UUID-shaped path segment as ***. A script npm runs is
  # handed the real global prefix, whose lib/node_modules (node_modules on Windows) holds the package.
  GLOBAL_PREFIX="$(npm exec --silent -c 'node -p process.env.npm_config_global_prefix')"
  PKG="$(node -p 'require("path").join(process.argv[1], process.platform === "win32" ? "" : "lib", "node_modules", "oak-observatory")' "$GLOBAL_PREFIX")"
  # The plugin and the notices ride in the release tarball; install.sh and install.ps1 check them too.
  for artifact in dist/herdr-plugin/herdr-plugin.toml dist/THIRD_PARTY_NOTICES.md; do
    [ -f "$PKG/$artifact" ] || { warn "Missing release artifact: $PKG/$artifact. Reinstall a complete OAK release."; exit 1; }
  done
  # Outside a project npm 12 needs --allow-scripts; --ignore-scripts=false outweighs an npmrc that set it.
  pty_check "$PKG" "re-run this script." "'npm rebuild -g node-pty --allow-scripts=node-pty --ignore-scripts=false'."
else
  warn "Global install failed. If npm said EEXIST, another global package already owns one of OAK's commands (oak, oak-observatory, claude-observatory): uninstall it or remove the file npm named, then re-run this script. For a permission error, re-run it as a user who can write npm's global prefix. Continuing so the other components still install."
fi
CLI="$(command -v oak || true)"
[ -n "$CLI" ] && ok "CLI ready: $CLI" || warn "oak not on PATH — check your npm global bin dir (npm prefix -g)."

# --- editor extensions (whatever is on this machine) ---
# One call for the VS Code family AND JetBrains. This used to be ~30 lines of bash that curled the
# .vsix with no integrity check and, for JetBrains, only downloaded the zip and printed three lines of
# "Settings → Plugins → Install Plugin from Disk" — so the one-liner never actually installed the
# JetBrains plugin. The CLI detects both families, verifies each asset's sha256, and handles Windows.
if [ -n "$CLI" ]; then
  say "Installing the editor extensions…"
  oak install-extensions --channel "$CHANNEL" || warn "Some editor surfaces could not be installed — see the notes above."
else
  warn "Skipped the editor extensions: the CLI is not on PATH. Once it is, run: oak install-extensions"
fi

# --- status line (usage bars) ---
if command -v jq >/dev/null 2>&1 && command -v bash >/dev/null 2>&1; then
  say "Installing the bundled status line…"
  oak statusline >/dev/null 2>&1 && ok "Status line installed." || warn "Status line install skipped."
else
  warn "jq not found — skipped the status line (it is a bash script and parses its input with jq)."
  printf '  %sDebian/Ubuntu: sudo apt-get install -y jq   ·   macOS: brew install jq   ·   Windows: winget install jqlang.jq%s\n' "$c_dim" "$c_off"
  printf '  %sThen: oak statusline%s\n' "$c_dim" "$c_off"
fi

# --- capture hooks (with the closed-Claude guard) ---
printf '\n%s Install the capture hooks with Claude Code CLOSED — a running session reverts mid-session hook edits.\n' "$c_warn"
if [ -t 0 ]; then
  printf 'Install the capture hooks now? Writes ~/.claude/settings.json (backed up first). [y/N] '
  read -r ans || ans=""
  # `|| warn`: under `set -e` a failed (or missing) oak would end the script before the health check.
  case "$ans" in [yY]*) oak init || warn "'oak init' did not finish — run it before launching Claude Code." ;; *) say "Skipped — run 'oak init' before launching Claude Code." ;; esac
else
  say "Non-interactive shell — run 'oak init' before launching Claude Code."
fi

printf '\n'
say "Health check:"
oak doctor --fix || true

ok "Done. Update anytime by re-running this script, or with: oak update"
