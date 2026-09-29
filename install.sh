#!/usr/bin/env bash
# OAK — one-shot installer from a clean checkout: CLI + the editor extensions for
# whatever editors are on this machine (VS Code family and/or JetBrains) + status line + hooks.
# Everything is built from THIS tree; nothing is downloaded. Safe to re-run. Does NOT commit anything.
#
#   ./install.sh                 # skips the JetBrains plugin unless --jetbrains is given (slow build)
#   ./install.sh --jetbrains     # also build + install the JetBrains plugin (needs JDK 21 + Gradle)
#
# For a release install with no toolchain, use scripts/bootstrap.sh (or install.ps1 on Windows), which
# also takes --channel stable|dev.
set -euo pipefail
cd "$(dirname "$0")"

WITH_JETBRAINS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --jetbrains|--with-jetbrains) WITH_JETBRAINS=1; shift ;;
    -h|--help)
      printf 'usage: ./install.sh [--jetbrains]\n\n  --jetbrains  also build + install the JetBrains plugin (needs JDK 21 + Gradle)\n'
      exit 0 ;;
    *) printf 'unknown option: %s (try --help)\n' "$1" >&2; exit 1 ;;
  esac
done

c_arrow=$'\033[1;36m▸\033[0m'; c_warn=$'\033[1;33m!\033[0m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
say()  { printf '%s %s\n' "$c_arrow" "$1"; }
warn() { printf '%s %s\n' "$c_warn" "$1"; }
step=0; total=$((7 + WITH_JETBRAINS))
head() { step=$((step+1)); printf '\n%s[%d/%d]%s %s\n' "$c_dim" "$step" "$total" "$c_off" "$1"; }

# node-pty is an OPTIONAL dependency: when its native build fails, npm still exits 0 and prints
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

command -v npm >/dev/null 2>&1 || { warn "npm not found — install Node.js 20+ first."; exit 1; }

head "Installing workspace dependencies"
# node-pty's install script runs under npm 12 because the root package.json allows it (`allowScripts`).
npm install --silent
# node-pty sits in this checkout's node_modules, whose package.json allows its script (npm 12 refuses
# --allow-scripts inside a project); --ignore-scripts=false outweighs an npmrc that set it.
pty_check "$PWD/packages/cli" "re-run ./install.sh." "'npm rebuild node-pty --ignore-scripts=false' in $PWD."

head "Building core + CLI"
npm run build --silent
# The bundled CLI resolves the plugin alongside its entry point, including global installs.
for artifact in packages/cli/dist/herdr-plugin/herdr-plugin.toml packages/cli/dist/THIRD_PARTY_NOTICES.md; do
  [ -f "$artifact" ] || { warn "Missing release artifact: $artifact"; exit 1; }
done

head "Linking the oak CLI onto your PATH"
# A pre-rename global (`claude-observatory`) owns the `claude-observatory` bin, which this package also
# ships — npm >=7 EEXISTs rather than hand a bin to a different package, so remove the old global first
# (never --force: it strands the old package with a claim on the shared bin).
if npm ls -g claude-observatory >/dev/null 2>&1; then
  say "Removing the old claude-observatory global package (renamed to oak-observatory)…"
  npm uninstall -g claude-observatory --silent || warn "could not remove it — if the install below fails with EEXIST, run: npm uninstall -g claude-observatory"
fi
# Not --silent: npm's own EEXIST or permission error is the one line that says what went wrong.
npm i -g ./packages/cli || {
  warn "Global install failed. If npm said EEXIST, another global package already owns one of OAK's commands (oak, oak-observatory, claude-observatory): uninstall it or remove the file npm named, then re-run. For a permission error, try:  sudo npm i -g ./packages/cli"; exit 1; }
CLI="$(command -v oak || true)"
[ -n "$CLI" ] && say "CLI ready: $CLI" || warn "oak not on PATH — check your npm global bin dir (npm prefix -g)."

head "Building + packaging the VS Code extension"
npm run build:vscode --silent
( cd packages/vscode && npm run package --silent )
VSIX="$PWD/packages/vscode/oak-observatory.vsix"
say "Packaged: $VSIX"

JB_ZIP=""
if [ "$WITH_JETBRAINS" = "1" ]; then
  head "Building the JetBrains plugin (JDK 21 + Gradle)"
  if bash scripts/install-jetbrains.sh --build-only; then
    # `command head`, not bare `head`: this script defines its own head() for section banners (above),
    # which shadows the binary. A bare pipe therefore captured the BANNER — "[6/6] -1" — as the zip
    # path, so the JetBrains plugin never installed and the only clue was a generic warning.
    JB_ZIP="$(ls -t packages/jetbrains/build/distributions/oak-observatory-jetbrains-*.zip 2>/dev/null | command head -1 || true)"
    [ -n "$JB_ZIP" ] && JB_ZIP="$PWD/${JB_ZIP#./}"
  fi
  # Never silently: if the build failed, say so — the install step below will simply skip JetBrains.
  [ -n "$JB_ZIP" ] || warn "The JetBrains plugin did not build — skipping it (the rest still installs)."
fi

head "Installing the extensions into the editors on this machine"
# One call covers the VS Code family AND JetBrains, from the artifacts just built — no network, and it
# installs into editors that do not have the extension yet (which `update` deliberately will not do).
# Run this inside a Remote-SSH / devcontainer terminal and it targets the REMOTE host, which is exactly
# where the extension has to live: it reads that host's ~/.claude.
# No scope flag: in local-artifact mode the CLI acts only on families it was GIVEN an artifact for, and
# names `./install.sh --jetbrains` for the one it skipped. Passing --vscode-only instead meant a
# JetBrains-only machine got "no VS Code-family editor found" plus three lines of VS Code advice, and the
# plugin it actually needed was never mentioned.
INSTALL_ARGS=(--vsix "$VSIX")
[ -n "$JB_ZIP" ] && INSTALL_ARGS+=(--jetbrains-zip "$JB_ZIP")
# Prefer this tree's freshly-built CLI: the global one was installed a moment ago, but if that step
# failed (permissions) we should still be able to install the extensions.
if [ -f "$PWD/packages/cli/dist/index.js" ]; then
  CO=(node "$PWD/packages/cli/dist/index.js")
elif [ -n "$CLI" ]; then
  CO=(oak)
else
  CO=()
fi
if [ ${#CO[@]} -gt 0 ]; then
  "${CO[@]}" install-extensions "${INSTALL_ARGS[@]}" || {
    warn "Some editor surfaces could not be installed — see the notes above."
    printf "  %sManual fallback: code --install-extension %s%s\n" "$c_dim" "$VSIX" "$c_off"
    printf "  %sNo 'code' on PATH? In VS Code: Cmd/Ctrl-Shift-P → \"Shell Command: Install 'code' command in PATH\".%s\n" "$c_dim" "$c_off"
  }
else
  warn "The CLI is not on PATH, so the extensions were not installed."
  printf "  %sOnce it is: oak install-extensions --vsix %s%s\n" "$c_dim" "$VSIX" "$c_off"
fi

head "Installing the bundled status line (powers the sidebar Usage bars)"
# The status line is bundled (packages/cli/statusline). Never clobber a user's own statusLine:
# install only when none is configured, or when the existing one is already claude-statusline.
SETTINGS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
EXISTING=$(jq -r '.statusLine.command // ""' "$SETTINGS" 2>/dev/null || echo "")
if [ -z "$EXISTING" ] || printf '%s' "$EXISTING" | grep -q 'statusline\.sh'; then
  if command -v jq >/dev/null 2>&1; then
    bash packages/cli/statusline/install-statusline.sh && say "Status line installed (idempotent — safe to re-run)."
  else
    warn "jq not found — skipped the status line. Install jq, then run: oak statusline"
  fi
else
  warn "You already have a custom statusLine configured — left it alone."
  printf '  %sTo switch to claude-statusline later:  oak statusline%s\n' "$c_dim" "$c_off"
fi

cat <<EOF

  ${c_dim}────────────────────────────────────────────────────────────────${c_off}
  ${c_warn} Install the capture hooks with Claude Code CLOSED.
    A running session reverts hook edits made mid-session, so hooks
    added while it's open silently won't take effect.
  ${c_dim}────────────────────────────────────────────────────────────────${c_off}
EOF

if [ -t 0 ]; then
  printf 'Install the capture hooks now? Writes ~/.claude/settings.json (backed up first). [y/N] '
  read -r ans || ans=""
  # The same CLI the rest of this script runs (the tree's build), and `|| warn`: under `set -e` a
  # failed or missing `oak` would end the script before the herdr install and the health check.
  case "$ans" in
    [yY]*) if [ ${#CO[@]} -gt 0 ]; then "${CO[@]}" init || warn "'oak init' did not finish — run it before launching Claude Code."
           else warn "The CLI is not on PATH — run 'oak init' once it is."; fi ;;
    *)     say "Skipped — run 'oak init' before launching Claude Code." ;;
  esac
else
  say "Non-interactive shell — run 'oak init' before launching Claude Code."
fi

head "Installing herdr + a health check"
# `doctor --fix` IS ensureHerdr(): the herdr pinned in herdr.lock (downloaded and checksum-verified
# only when this machine has none, or an older one), its claude + codex integrations, OAK's herdr
# plugin, and its server. Last, so the report it prints covers the hooks installed a moment ago too.
# Never fatal: doctor exits nonzero when ANY check fails — declining the hooks above is enough — and
# `set -e` would turn that into a failed install.
if [ ${#CO[@]} -gt 0 ]; then
  "${CO[@]}" doctor --fix || warn "Some checks did not pass — the report above says which."
else
  warn "The CLI is not on PATH, so herdr was not installed. Once it is:  oak doctor --fix"
fi

printf '\n%s Done. Verify anytime with:  oak status\n' "$c_arrow"
