#!/bin/sh
# One stub standing in for herdr and ssh during the `--machine` tests (copied to each name). No network.
# herdr answers the saved-machine list. ssh logs its argv to $MACHINE_EXEC_LOG (one argument per line,
# then a lone `.`), then runs the remote command the way sshd does: a non-interactive `sh -c` in the
# fake remote home, with the system PATH alone and nothing else inherited. SSH_FAKE_EXIT (with
# SSH_FAKE_STDERR) makes it fail instead, as ssh itself does when a host cannot be reached;
# SSH_FAKE_DOWN names one target that fails that way (exit 255) while the others answer.
# FAKE_REMOTE_ROOT gives each target a home of its own: <root>/<host>, the part after the `@`.
# SSH_ASKPASS_LOG collects one line for every ssh run, `ssh -G` included: `G` or `run`, then the
# SSH_ASKPASS_REQUIRE it ran with (`unset` when none).
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
    [ -n "${SSH_ASKPASS_LOG:-}" ] && printf '%s %s\n' "$([ "$1" = -G ] && echo G || echo run)" "${SSH_ASKPASS_REQUIRE:-unset}" >> "$SSH_ASKPASS_LOG"
    if [ "$1" = -G ]; then
      # `ssh -G <target>` prints the configuration ssh would use, and connects nowhere: SSH_FAKE_G is that
      # answer (escapes as printf's %b reads them), and SSH_G_LOG collects the targets asked about.
      [ -n "${SSH_G_LOG:-}" ] && printf '%s\n' "$2" >> "$SSH_G_LOG"
      printf '%b' "${SSH_FAKE_G:-controlmaster false\ncontrolpersist no\n}"
      exit 0
    fi
    # One write per call: the record goes to a file of its own, then onto the log by one `cat`. Line by
    # line (bash's printf writes each line apart), two ssh run at once, as a refresh asks every machine,
    # interleaved their records and the log read back as different calls (macOS CI, 2026-11-06).
    rec=$(mktemp "$MACHINE_EXEC_LOG.XXXXXX")
    { echo ssh; for a in "$@"; do printf '%s\n' "$a"; done; echo .; } > "$rec"
    cat "$rec" >> "$MACHINE_EXEC_LOG"; rm -f "$rec"
    down=
    for a in "$@"; do [ -n "${SSH_FAKE_DOWN:-}" ] && [ "$a" = "$SSH_FAKE_DOWN" ] && down=255; done
    if [ -n "${SSH_FAKE_EXIT:-}$down" ]; then
      printf '%s\n' "${SSH_FAKE_STDERR:-}" >&2
      exit "${SSH_FAKE_EXIT:-$down}"
    fi
    if [ -n "$MACHINE_EXEC_ENV" ]; then
      # Appended: every ssh a run makes adds the names it would have exported, so any one leak shows.
      /usr/bin/env | sed -n '/^CLAUDE_CONFIG_DIR=/s/=.*//p; /^CODEX_HOME=/s/=.*//p; /^CLAUDE_CODE_/s/=.*//p; /^CLAUDECODE=/s/=.*//p; /^CLAUDE_OBSERVATORY_SESSION=/s/=.*//p; /^HERDR_SOCKET_PATH=/s/=.*//p; /^XDG_CONFIG_HOME=/s/=.*//p' >> "$MACHINE_EXEC_ENV"
    fi
    target=; last=
    for a in "$@"; do target="$last"; last="$a"; done
    [ -n "${FAKE_REMOTE_ROOT:-}" ] && FAKE_REMOTE_HOME="$FAKE_REMOTE_ROOT/${target##*@}"
    cd "$FAKE_REMOTE_HOME" || exit 255
    exec /usr/bin/env -i HOME="$FAKE_REMOTE_HOME" PATH=/usr/bin:/bin /bin/sh -c "$last" ;;
esac
exit 0
