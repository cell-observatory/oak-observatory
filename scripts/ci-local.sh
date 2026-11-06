#!/usr/bin/env bash
# ci-local — run what CI runs, on the PLATFORM CI runs it on, before pushing.
#
# WHY THIS EXISTS
# --------------
# `npm test` on a Mac is not a green build. PR #50 went red on Linux/node 20 with an `ENOTDIR` that
# macOS reports as `ENOENT` and therefore swallows: `fs.statSync(p, { throwIfNoEntry: false })`
# suppresses ENOENT only, so a path whose component is a FILE rather than a directory throws on Linux
# and does not on a Mac. The test covering that case was green here and red there, and no amount of
# re-running it locally would have said so. Only the platform could.
#
# So this runs the Linux lanes in a container, across CI's Node matrix, plus the native-platform lanes
# directly. It is the pre-push gate; `npm test` is not.
#
#   bash scripts/ci-local.sh            # the whole matrix
#   bash scripts/ci-local.sh --quick    # Linux on the oldest Node only — the lane that catches most
#   bash scripts/ci-local.sh --native   # skip containers; local platform only
#
# WHAT IT CANNOT DO: Windows. There is no container for it on macOS, so the windows-latest lanes are
# still only checked by CI — write those tests to be platform-independent (stub the platform) rather
# than hoping. The same rule applies to any bug that turns out to be OS-specific: reproduce it
# everywhere, or a contributor on the other OS cannot run it before pushing.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT=$PWD

# CI's matrix, from .github/workflows/{linux,macos,windows}.yml.
NODES=(22.16 24)
MODE=${1:-}
[ "$MODE" = "--quick" ] && NODES=(22.16)

RUNTIME=""
for c in podman docker; do command -v "$c" >/dev/null 2>&1 && { RUNTIME=$c; break; }; done

fails=()
step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fails+=("$1"); }

# ---- Linux lanes, in a container, one per Node in the matrix ---------------------------------
# Mounted read-only with node_modules and build output redirected to a container-local overlay: a
# host `npm ci` for darwin-arm64 cannot be reused by linux, and letting the container write into the
# working tree would leave Linux binaries in it afterwards.
if [ "$MODE" != "--native" ] && [ -n "$RUNTIME" ]; then
  for n in "${NODES[@]}"; do
    img="ci-local-node${n}"
    # A tiny cached image per Node version, built once. `jq` is on GitHub's ubuntu runners and not in
    # the node image, and e2e.sh uses it — without it 194 checks "fail" for a missing binary.
    if ! $RUNTIME image exists "$img" 2>/dev/null; then
      step "building $img (once)"
      printf 'FROM docker.io/library/node:%s-bookworm\nRUN apt-get update -qq && apt-get install -y -qq jq git >/dev/null && rm -rf /var/lib/apt/lists/*\n' "$n" \
        | $RUNTIME build -q -t "$img" -f - . >/dev/null 2>&1 || { bad "build $img"; continue; }
    fi
    step "Linux · node $n · npm test + e2e"
    # LANG matters, and its absence is a FALSE failure rather than a missed one: without a UTF-8
    # locale `grep '.'` matches a BYTE, so an e2e check for `F1 .Prompts` fails against a correct
    # frame whose glyph is a 3-byte `▾`. GitHub's runners set C.UTF-8; matching the environment is
    # part of simulating the lane, or the tool cries wolf and stops being used.
    if $RUNTIME run --rm -e LANG=C.UTF-8 -e LC_ALL=C.UTF-8 -e CI=true -v "$ROOT":/src:ro "$img" bash -lc '
        set -e
        # Copied in with tar, not bind-mounted as the workdir: a host `npm ci` is darwin-arm64 and
        # unusable on linux, and writing into the mount would leave Linux binaries in the working
        # tree. The excludes are what is huge, host-specific, or unreadable to the run user.
        mkdir -p /tmp/w && cd /src
        tar -cf - --exclude=node_modules --exclude=.git --exclude=docs/media \
                  --exclude=packages/jetbrains/build --exclude=packages/jetbrains/.intellijPlatform \
                  --exclude=.gradle . 2>/dev/null | (cd /tmp/w && tar -xf -)
        chown -R node:node /tmp/w
        # …then dropped to a NON-ROOT user, matching CI. As root, the two tests that assert a
        # directory is NOT writable fail, because root can write anywhere — which reads as a product
        # bug and is not one.
        su node -c "cd /tmp/w && npm ci --no-audit --no-fund >/dev/null 2>&1 && npm test && bash test/e2e.sh"
      ' 2>&1 | tail -20; then
      ok "Linux node $n"
    else
      bad "Linux node $n"
    fi
  done
elif [ "$MODE" != "--native" ]; then
  printf '\n\033[33m!\033[0m no podman/docker — the Linux lanes are the ones that catch platform bugs.\n'
  fails+=("no container runtime: Linux lanes SKIPPED")
fi

# ---- the native platform, which is a CI lane too (macos-latest) -------------------------------
step "$(uname -s) · node $(node -v) · npm test + e2e"
if npm test >/tmp/ci-local-native.log 2>&1 && bash test/e2e.sh >>/tmp/ci-local-native.log 2>&1; then
  ok "native"
else
  tail -25 /tmp/ci-local-native.log
  bad "native"
fi

# ---- the JetBrains lane ------------------------------------------------------------------------
step "JetBrains · gradle test + buildPlugin"
# The wrapper cannot find a JDK from a bare shell; Gradle provisioned one, so point at it.
if [ -z "${JAVA_HOME:-}" ]; then
  JAVA_HOME=$(ls -d "$HOME"/.gradle/jdks/*/*/Contents/Home 2>/dev/null | head -1)
  export JAVA_HOME
fi
if [ -n "${JAVA_HOME:-}" ] && (cd packages/jetbrains && ./gradlew test buildPlugin --console=plain >/tmp/ci-local-jb.log 2>&1); then
  ok "gradle"
else
  tail -20 /tmp/ci-local-jb.log
  bad "gradle"
fi

printf '\n'
if [ ${#fails[@]} -eq 0 ]; then
  printf '\033[32mCI-LOCAL: everything CI can be simulated for is green\033[0m\n'
  printf '  (windows-latest is still only checked by CI — see the header)\n'
  exit 0
fi
printf '\033[31mCI-LOCAL: %d lane(s) failed:\033[0m\n' "${#fails[@]}"
for f in "${fails[@]}"; do printf '  - %s\n' "$f"; done
exit 1
