#!/usr/bin/env bash
# Build shareable release artifacts into ./release :
#   - oak-observatory.vsix                    (VS Code extension)
#   - oak-observatory-<ver>.tgz               (npm-installable CLI:  npm i -g --allow-scripts=node-pty <tgz>)
#   - oak-observatory-jetbrains-<ver>.zip     (JetBrains plugin — when JDK/Gradle available)
# Invoked by `npm run release`. Does NOT publish or commit.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf release && mkdir -p release

echo "▸ Building core + CLI…"
npm run build --silent

echo "▸ Packing the CLI (npm tarball)…"
( cd packages/cli && npm pack --silent --pack-destination ../../release >/dev/null )

echo "▸ Building + packaging the VS Code extension…"
npm run build:vscode --silent
( cd packages/vscode && npm run package --silent )
cp packages/vscode/oak-observatory.vsix release/

echo "▸ Building the JetBrains plugin…"
# Use the committed Gradle wrapper (pins the Gradle version) — never the ambient `gradle`. It still
# needs a JDK: honor $JAVA_HOME, else fall back to a local Homebrew openjdk@21 if present.
: "${JAVA_HOME:=$([ -d /opt/homebrew/opt/openjdk@21 ] && echo /opt/homebrew/opt/openjdk@21 || true)}"
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
  ( cd packages/jetbrains && JAVA_HOME="$JAVA_HOME" ./gradlew buildPlugin --console=plain -q )
  cp packages/jetbrains/build/distributions/oak-observatory-jetbrains-*.zip release/
else
  echo "  (skipped — no JDK at \$JAVA_HOME; CI builds the .zip on tagged releases)"
fi

echo
echo "Release artifacts:"
ls -1 release
echo
echo "Share:  the .tgz installs the CLI with  npm i -g --allow-scripts=node-pty ./oak-observatory-<ver>.tgz"
echo "        the .vsix installs the sidebar with  code --install-extension oak-observatory.vsix"
echo "        the .zip installs in JetBrains IDEs via Settings → Plugins → Install Plugin from Disk"
