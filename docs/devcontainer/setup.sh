#!/usr/bin/env bash
# Provision OAK + claude-statusline INSIDE a devcontainer.
# Referenced by devcontainer.json's postCreateCommand. Idempotent — safe to re-run on rebuild.
#
# Installs, under $CLAUDE_CONFIG_DIR (a persistent volume, per devcontainer.json):
#   • jq + a UTF-8 locale         (required by the status line)
#   • python3 if missing          (required by herdr's agent hooks)
#   • the oak CLI  (capture hook + stats subprocess)
#   • herdr and its integrations  (via oak doctor --fix)
#   • the claude-statusline        (writes statusline-last.json → the sidebar's Usage bars)
#   • the PreToolUse/PostToolUse capture hooks in settings.json
# The VS Code extension installs from a release's .vsix (see README.md).
set -euo pipefail

CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
say() { printf '▸ %s\n' "$1"; }

say "Claude config dir: $CFG"
# A freshly-created named volume is root-owned; take ownership so the hook/CLI/statusline can write.
if [ ! -w "$CFG" ] 2>/dev/null || [ ! -d "$CFG" ]; then
  sudo mkdir -p "$CFG" && sudo chown -R "$(id -u):$(id -g)" "$CFG"
fi
mkdir -p "$CFG"

CODEX_CFG="${CODEX_HOME:-$HOME/.codex}"
if [ ! -w "$CODEX_CFG" ] || [ ! -d "$CODEX_CFG" ]; then
  sudo mkdir -p "$CODEX_CFG" && sudo chown -R "$(id -u):$(id -g)" "$CODEX_CFG"
fi
mkdir -p "$CODEX_CFG"

# 1) jq (required by the status line) + a UTF-8 locale (keeps the bar glyphs intact).
if ! command -v jq >/dev/null 2>&1; then
  say "Installing jq + locales"
  sudo apt-get update -qq && sudo apt-get install -y -qq jq locales
fi

# 2) The oak CLI. Prefer a repo checkout mounted into the container (set
#    OBSERVATORY_REPO, or mount it at one of the common paths below); otherwise fall back to npm.
if command -v oak >/dev/null 2>&1; then
  say "CLI already present: $(command -v oak)"
else
  REPO="${OBSERVATORY_REPO:-}"
  for d in "$REPO" /workspaces/oak /workspace/oak-observatory; do
    [ -n "$d" ] && [ -f "$d/packages/cli/package.json" ] && REPO="$d" && break
  done
  if [ -n "$REPO" ] && [ -f "$REPO/packages/cli/package.json" ]; then
    say "Installing CLI from checkout: $REPO"
    ( cd "$REPO" && npm install --silent && npm run build --silent && npm i -g ./packages/cli --silent )
  else
    say "Installing CLI from the latest GitHub Release"
    TGZ_URL="$(curl -fsSL -H 'Accept: application/vnd.github+json' \
      https://api.github.com/repos/cell-observatory/oak-observatory/releases/latest \
      | grep -o '"browser_download_url": *"[^"]*\.tgz"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
    if [ -n "$TGZ_URL" ]; then
      # --allow-scripts: npm 12 blocks node-pty's install script otherwise, and Linux builds it there.
      # privacy-ok: a download target inside the container, not a path on anyone's machine
      curl -fsSL "$TGZ_URL" -o /tmp/oak-observatory.tgz && npm i -g /tmp/oak-observatory.tgz --silent --allow-scripts=node-pty \
        || say "  CLI install failed — mount the repo and set OBSERVATORY_REPO."
    else
      say "  No release tarball found — mount the repo and set OBSERVATORY_REPO."
    fi
  fi
fi

# 3) Install python3 if missing, then provision herdr and its integrations.
if ! command -v python3 >/dev/null 2>&1; then
  say "Installing python3 for herdr's agent hooks (if missing)"
  sudo apt-get update -qq && sudo apt-get install -y python3
fi
if command -v oak >/dev/null 2>&1; then
  say "Provisioning herdr and its integrations"
  oak doctor --fix || say "some doctor checks did not pass — the report above says which; the hooks are installed below"
fi

# 4) The status line (writes statusline-last.json that the sidebar's Usage bars read). It is
#    BUNDLED with the CLI — no network needed; honors CLAUDE_CONFIG_DIR so it lands in the same
#    persistent dir the extension reads. Curl fallback only if the CLI install failed above.
say "Installing the bundled claude-statusline"
if command -v oak >/dev/null 2>&1; then
  oak statusline || say "  statusline install failed — is jq installed?"
else
  curl -fsSL https://raw.githubusercontent.com/cell-observatory/claude-statusline/main/install-statusline.sh | bash \
    || say "  statusline install skipped (no CLI, no network) — run 'oak statusline' later."
fi

# 5) Capture hooks into $CFG/settings.json. Safe here: postCreate runs with no live Claude session,
#    and Claude Code reverts hooks edited mid-session. init honors CLAUDE_CONFIG_DIR.
if command -v oak >/dev/null 2>&1; then
  say "Installing capture hooks"
  # Plain `oak init` wires the Claude Code PreToolUse/PostToolUse hooks into settings.json AND installs
  # codex's capture hooks when a codex binary is present (`--codex` alone would do ONLY codex, leaving
  # Claude Code uncaptured — the very thing this step exists to wire).
  oak init || say "  'oak init' failed — run it once the CLI is ready."
fi

cat <<EOF

  ────────────────────────────────────────────────────────────────
  ▸ CLI + statusline + hooks provisioned under: $CFG  (persistent volume)
  ▸ VS Code extension: download a release's .vsix and use
      Extensions → '…' → 'Install from VSIX…' → 'Install in Dev Container'.
  ────────────────────────────────────────────────────────────────
EOF
