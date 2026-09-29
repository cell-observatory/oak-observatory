#!/bin/sh
# Fake herdr for the `oak agent start --machine` and `oak attach` tests: log every argv line to
# $HERDR_FAKE_LOG and answer the reads those commands make. No real ssh, no real herdr, no agent.
printf '%s\n' "$*" >> "$HERDR_FAKE_LOG"
case "$*" in
  "machine list --json")
    printf '[{"label":"build-box","id":"n1","target":"build-box.example","session":"default","enabled":true}]' ;;
  *"tab create --label claude"*)
    printf '{"result":{"root_pane":{"pane_id":"cp"}}}' ;;
  *"tab create --label oak"*)
    printf '{"result":{"tab":{"tab_id":"ot"},"root_pane":{"pane_id":"op"}}}' ;;
  *"api snapshot"*)
    printf '{"result":{"snapshot":{"tabs":[],"focused_workspace_id":"w1"}}}' ;;
esac
exit 0
