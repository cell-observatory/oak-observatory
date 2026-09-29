#!/bin/sh
# Every input and write lives in the test sandbox.
printf '%s\n' "$*" >> "$OAK_TEST_ARGV"
case "$*" in
  --version) echo 'herdr 999.0.0' ;;
  'integration status')
    if [ "$OAK_TEST_CURRENT" = yes ]; then
      echo 'codex: current (v8)'
    else
      echo 'codex: not installed'
    fi ;;
  'integration install codex')
    if [ "$OAK_TEST_FAIL" = yes ]; then
      echo 'test installation failed' >&2
      exit 1
    fi
    /bin/cp "$OAK_TEST_HOOKS" "${CODEX_HOME:-$HOME/.codex}/hooks.json" ;;
  status) printf 'server:\n  status: running\n' ;;
  # ensureHerdr checks the sidebar widths it adds to config.toml and reloads a running server (2026-09-22).
  'config check') echo 'config: ok' ;;
  'server reload-config') echo '{"result":{"status":"applied","type":"config_reload"}}' ;;
  *) echo "Unexpected fake herdr invocation: $*" >&2; exit 1 ;;
esac
