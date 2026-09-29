#!/bin/sh
# One stub standing in for herdr and ssh during the `--machine` tests (copied to each name). No network.
# herdr answers the saved-machine list. ssh logs its argv to $MACHINE_EXEC_LOG (one argument per line,
# then a lone `.`), then runs the remote command the way sshd does: a non-interactive `sh -c` in the
# fake remote home, with the system PATH alone and nothing else inherited. SSH_FAKE_EXIT (with
# SSH_FAKE_STDERR) makes it fail instead, as ssh itself does when a host cannot be reached;
# SSH_FAKE_DOWN names one target that fails that way (exit 255) while the others answer.
tool=$(basename "$0")
case "$tool" in
  oak)
    # Installed as the remote oak to simulate an older build: unknown internal verbs print help
    # successfully. Capability checks must reject this before it can masquerade as JSON data.
    printf 'Legacy OAK: use oak help for supported commands\n'
    exit 0 ;;
  herdr)
    printf 'herdr %s\n' "$*" >> "$MACHINE_EXEC_LOG"
    if [ "$*" = "machine list --json" ]; then
      if [ -n "$MACHINE_EXEC_MACHINES" ]; then printf '%s' "$MACHINE_EXEC_MACHINES"; exit 0; fi
      printf '[{"id":"m1","label":"build-box","target":"builder@build-box.example","session":"default","enabled":true,"selected":false}]'
    fi
    exit 0 ;;
  ssh)
    { echo ssh; for a in "$@"; do printf '%s\n' "$a"; done; echo .; } >> "$MACHINE_EXEC_LOG"
    down=
    for a in "$@"; do [ -n "${SSH_FAKE_DOWN:-}" ] && [ "$a" = "$SSH_FAKE_DOWN" ] && down=255; done
    if [ -n "${SSH_FAKE_EXIT:-}$down" ]; then
      printf '%s\n' "${SSH_FAKE_STDERR:-}" >&2
      exit "${SSH_FAKE_EXIT:-$down}"
    fi
    if [ -n "$MACHINE_EXEC_ENV" ]; then
      /usr/bin/env | sed -n '/^CLAUDE_CONFIG_DIR=/s/=.*//p; /^CODEX_HOME=/s/=.*//p; /^CLAUDE_CODE_/s/=.*//p; /^CLAUDECODE=/s/=.*//p' > "$MACHINE_EXEC_ENV"
    fi
    for a in "$@"; do last="$a"; done
    cd "$FAKE_REMOTE_HOME" || exit 255
    exec /usr/bin/env -i HOME="$FAKE_REMOTE_HOME" PATH=/usr/bin:/bin /bin/sh -c "$last" ;;
esac
exit 0
