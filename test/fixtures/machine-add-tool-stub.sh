#!/bin/sh
# One stub standing in for ssh, scp, and herdr during `oak machine add` tests (copied to each name).
# Logs "<tool> <args>" to $MACHINE_ADD_LOG and answers the few probes the add flow makes. No network.
tool=$(basename "$0")
printf '%s %s\n' "$tool" "$*" >> "$MACHINE_ADD_LOG"
case "$tool" in
  scp)
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
  herdr) exit 0 ;;
  ssh)
    for a in "$@"; do last="$a"; done
    case "$last" in
      *"uname -s"*) printf 'Linux\nx86_64\n' ;;
      *"herdr --version"*) printf 'herdr 0.9.1\n' ;;
      *"node --version"*) printf 'v20.11.0\n' ;;
      *"oak --version"*) printf 'oak 0.0.0\n' ;;
    esac
    exit 0 ;;
esac
exit 0
