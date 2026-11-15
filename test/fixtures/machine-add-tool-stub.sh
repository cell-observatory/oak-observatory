#!/bin/sh
# One stub standing in for ssh, scp, and herdr during `oak machine add` tests (copied to each name).
# Logs "<tool> <args>" to $MACHINE_ADD_LOG and answers the few probes the add flow makes. No network.
# SSH_FAKE_EXIT or SCP_FAKE_EXIT (with SSH_FAKE_STDERR or SCP_FAKE_STDERR) makes every ssh or every scp
# fail that way, as each does when it cannot reach a host. SSH_ASKPASS_LOG collects one line for every
# ssh or scp run, `ssh -G` included: the tool, then the SSH_ASKPASS_REQUIRE it ran with (`unset` when none),
# then the names of this machine's store and session variables it carried, if any. The remote's answers can
# be set: SSH_FAKE_UNAME (`uname -s; uname -m`, printf %b escapes) and SSH_FAKE_HERDR (the herdr version it
# has before the add); HERDR_FAKE_VERSION is this machine's herdr version, and the remote's after a copy.
tool=$(basename "$0")
script=
for a in "$@"; do script="$a"; done
if [ "$tool" = ssh ] && [ "$script" = 'sh -s' ]; then script=$(cat); fi
if [ "$tool" = ssh ] && [ "$a" = 'sh -s' ]; then
  printf 'ssh %s %s\n' "$*" "$(printf '%s' "$script" | tr '\n' ' ')" >> "$MACHINE_ADD_LOG"
else
  printf '%s %s\n' "$tool" "$*" >> "$MACHINE_ADD_LOG"
fi
if [ -n "${SSH_ASKPASS_LOG:-}" ] && [ "$tool" != herdr ]; then
  carried=$(/usr/bin/env | sed -n -e '/^CLAUDE_CONFIG_DIR=/s/=.*//p' -e '/^CODEX_HOME=/s/=.*//p' -e '/^CLAUDE_OBSERVATORY_SESSION=/s/=.*//p' -e '/^XDG_CONFIG_HOME=/s/=.*//p' -e '/^HERDR_SOCKET_PATH=/s/=.*//p' | tr '\n' ' ')
  printf '%s %s %s\n' "$tool" "${SSH_ASKPASS_REQUIRE:-unset}" "$carried" >> "$SSH_ASKPASS_LOG"
fi
case "$tool" in
  scp)
    if [ -n "${SCP_FAKE_EXIT:-}" ]; then printf '%s\n' "${SCP_FAKE_STDERR:-}" >&2; exit "$SCP_FAKE_EXIT"; fi
    # Like the real scp, fail on a local source that does not exist (remote targets contain a colon).
    skip=0
    for a in "$@"; do
      if [ "$skip" = 1 ]; then skip=0; continue; fi
      case "$a" in
        -o) skip=1 ;;
        -*|*:*) ;;
        *) [ -e "$a" ] || { printf 'scp: %s: No such file or directory\n' "$a" >&2; exit 1; } ;;
      esac
    done
    exit 0 ;;
  herdr)
    [ "${1:-}" = --version ] && [ -n "${HERDR_FAKE_VERSION:-}" ] && printf 'herdr %s\n' "$HERDR_FAKE_VERSION"
    exit 0 ;;
  ssh)
    # `ssh -G <target>`: the configuration ssh would use, which SSH_FAKE_G gives (printf %b escapes).
    if [ "$1" = -G ]; then printf '%b' "${SSH_FAKE_G:-}"; exit 0; fi
    if [ -n "${SSH_FAKE_EXIT:-}" ]; then printf '%s\n' "${SSH_FAKE_STDERR:-}" >&2; exit "$SSH_FAKE_EXIT"; fi
    last="$script"
    case "$last" in
      *"oak-shell-ok"*) echo oak-shell-ok ;;
      *"uname -s"*) printf '%b\n' "${SSH_FAKE_UNAME:-Linux\nx86_64}" ;;
      *"herdr --version"*) printf 'herdr %s\n' "${SSH_FAKE_HERDR:-0.9.1}" ;;
      *'"$f" --version'*) printf 'herdr %s\n' "${HERDR_FAKE_VERSION:-0.9.1}" ;;
      *"node --version"*) printf '%s\n' "${SSH_FAKE_NODE:-v24.18.0}" ;;
      *"oak --version"*) printf 'oak 0.0.0\n' ;;
    esac
    exit 0 ;;
esac
exit 0
