#!/usr/bin/env bash
# Build + install the JetBrains plugin into your real IDE in one shot — no Settings→Plugins dance.
#
#   ./scripts/install-jetbrains.sh              # build, then install
#   ./scripts/install-jetbrains.sh --no-build   # install the zip already in build/distributions
#   ./scripts/install-jetbrains.sh --build-only # build only, print the zip path (used by install.sh)
#
# Then fully restart the IDE (⌘Q → reopen); a plugin's classes can't hot-swap in a running JVM.
#
# The INSTALL half is `oak install-extensions --jetbrains-zip`, so IDE detection lives in
# one place (the CLI) instead of being reimplemented here in bash — which also means it works on Windows
# from PowerShell/cmd, not only from Git Bash, and never needs `unzip` there.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT/packages/jetbrains"

MODE="all"
case "${1:-}" in
  --no-build)   MODE="install-only" ;;
  --build-only) MODE="build-only" ;;
  "")           MODE="all" ;;
  *) echo "unknown option: $1 (expected --no-build, --build-only, or nothing)" >&2; exit 1 ;;
esac

if [ "$MODE" != "install-only" ]; then
  echo "▸ Building the plugin…"
  # Always the pinned wrapper (never an ambient `gradle`), matching scripts/release.sh — the wrapper
  # provisions the exact Gradle version this build is tested against.
  JAVA_HOME="${JAVA_HOME:-$([ -d /opt/homebrew/opt/openjdk@21 ] && echo /opt/homebrew/opt/openjdk@21 || echo "")}" \
    ./gradlew buildPlugin --console=plain -q
fi

ZIP=$(ls -t build/distributions/oak-observatory-jetbrains-*.zip 2>/dev/null | head -1)
[ -n "$ZIP" ] || { echo "no plugin zip found — build failed?" >&2; exit 1; }
ZIP="$PWD/$ZIP"

if [ "$MODE" = "build-only" ]; then
  echo "$ZIP"
  exit 0
fi

# Prefer THIS tree's built CLI over whatever is on PATH: a globally-installed older CLI has no
# `install-extensions`, and the point of running from the repo is to use the repo.
if [ -f "$REPO_ROOT/packages/cli/dist/index.js" ]; then
  CO=(node "$REPO_ROOT/packages/cli/dist/index.js")
elif command -v oak >/dev/null 2>&1; then
  CO=(oak)
else
  echo "The plugin was built but not installed: no CLI to install it with." >&2
  echo "  Build this tree (npm run build) or install the CLI (./install.sh), then re-run --no-build," >&2
  echo "  or: Settings → Plugins → ⚙ → Install Plugin from Disk → $ZIP" >&2
  exit 1
fi

# Detection, extraction (PowerShell Expand-Archive on Windows, unzip elsewhere), the version sentinel
# and the restart/auto-update notes all come from the CLI.
if ! "${CO[@]}" install-extensions --jetbrains-only --jetbrains-zip "$ZIP"; then
  echo >&2
  echo "Install it by hand instead: Settings → Plugins → ⚙ → Install Plugin from Disk → $ZIP" >&2
  exit 1
fi
