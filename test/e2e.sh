#!/usr/bin/env bash
# End-to-end integration test: drives the ACTUAL bundled CLI + capture hook over an isolated store.
# Repo-relative + self-contained (temp HOME/workspace); run via `npm run e2e`.
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
# `oak` by name (the status line's usage delegate) is this tree's CLI, never one installed on the machine.
export PATH="$REPO/node_modules/.bin:$PATH"
CLI="$REPO/packages/cli/dist/index.js"
CAPTURE="$REPO/packages/cli/dist/capture.js"
CORE="$REPO/packages/core/dist/index.js"
SETLINE="$REPO/test/setline.js"
if [ ! -f "$CLI" ] || [ ! -f "$CAPTURE" ] || [ ! -f "$CORE" ] || [ ! -f "$REPO/packages/tui/dist/index.js" ]; then
  echo "build first: npm run build"; exit 1
fi

TMP="$(cd "$(mktemp -d)" && pwd -P)"   # canonical path (macOS /var -> /private/var) so mangle == process.cwd()
# The interactive boot below starts this store's focus server; stop it before its store is deleted, or
# it outlives the run by its idle timeout.
trap 'node "$CLI" server stop >/dev/null 2>&1; rm -rf "$TMP"' EXIT
export HOME="$TMP/home"
unset CLAUDE_CONFIG_DIR   # isolation: stats/usage read transcripts from here if set
# …and codex's own home, for the same reason and with more at stake:  writes hooks.json,
# appends trust state to config.toml and can WIRE A MODEL there. Leaving CODEX_HOME set pointed all
# of that at the developer's real configuration — a per-user file no review would ever see.
unset CODEX_HOME
# …and herdr's. Run from a herdr pane, this shell names the person's LIVE server, and `tui --once` read
# it (and once wrote to it); XDG_CONFIG_HOME would hand herdr the real saved machines. Nothing here may
# reach either: the socket below does not exist.
unset HERDR_PANE_ID HERDR_TAB_ID HERDR_WORKSPACE_ID HERDR_ENV HERDR_BIN_PATH HERDR_SESSION XDG_CONFIG_HOME
export HERDR_SOCKET_PATH="$TMP/no-herdr.sock"
WS="$TMP/ws"
SESSION="e2eSess"
mkdir -p "$WS"
MANGLE=$(printf '%s' "$WS" | sed 's/[^a-zA-Z0-9]/-/g')
mkdir -p "$HOME/.claude/projects/$MANGLE"
: > "$HOME/.claude/projects/$MANGLE/$SESSION.jsonl"

pass=0; fail=0
ok(){ if eval "$2"; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1"; fail=$((fail+1)); fi; }
hook(){ printf '{"session_id":"%s","cwd":"%s","hook_event_name":"%s","tool_name":"%s","tool_input":{"file_path":"%s"}}' \
  "$SESSION" "$WS" "$1" "$2" "$3" | node "$CAPTURE"; }
cc(){ ( cd "$WS" && node "$CLI" "$@" ); }   # run from workspace -> exercises resolveSessionId end-to-end

echo "════════ E2E 1: three non-overlapping edits, undo the MIDDLE (must NOT false-conflict) ════════"
F="$WS/main.js"
printf 'L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\nL11\nL12\n' > "$F"
hook PreToolUse Edit "$F"; node "$SETLINE" "$F" 0  "TOP";  hook PostToolUse Edit "$F"   # #1
hook PreToolUse Edit "$F"; node "$SETLINE" "$F" 5  "MID";  hook PostToolUse Edit "$F"   # #2
hook PreToolUse Edit "$F"; node "$SETLINE" "$F" 11 "BOT";  hook PostToolUse Edit "$F"   # #3
cc list >/dev/null
ok "3 edits recorded"  "[ \$(cc status | grep -oE 'edits:[[:space:]]+[0-9]+' | grep -oE '[0-9]+') -eq 3 ]"
cc undo 2 >/dev/null; rc=$?
ok "undo #2 succeeded (no false conflict)" "[ $rc -eq 0 ]"
ok "middle reverted to L6"      "grep -qx 'L6' '$F'"
ok "MID gone"                   "! grep -q 'MID' '$F'"
ok "TOP (edit #1) preserved"    "grep -qx 'TOP' '$F'"
ok "BOT (edit #3) preserved"    "grep -qx 'BOT' '$F'"

echo "════════ E2E 2: undo remaining two, then re-undo is a noop ════════"
cc undo 1 >/dev/null; cc undo 3 >/dev/null
ok "all reverted to original (TOP/MID/BOT gone)" "! grep -qE 'TOP|MID|BOT' '$F'"
out=$(cc undo 2); ok "re-undo #2 reports already undone" "echo \"\$out\" | grep -qi 'already undone'"
ok "status shows 3 undone" "[ \$(cc status | grep -oE '[0-9]+ undone' | grep -oE '[0-9]+') -eq 3 ]"

echo "════════ E2E 3: keep leaves disk untouched + shows in list ════════"
G="$WS/keep.txt"; printf 'a\nb\n' > "$G"
hook PreToolUse Edit "$G"; node "$SETLINE" "$G" 0 "AA"; hook PostToolUse Edit "$G"   # #4
h1=$(shasum "$G"|awk '{print $1}'); cc keep 4 >/dev/null; h2=$(shasum "$G"|awk '{print $1}')
ok "keep #4 no disk change" "[ '$h1' = '$h2' ]"
ok "list shows kept"        "cc list | grep -q kept"

echo "════════ E2E 4: new-file create + later edit -> undo create CONFLICTS (data-loss guard) ════════"
N="$WS/created.ts"
hook PreToolUse Write "$N"; printf 'export const x=1\n' > "$N"; hook PostToolUse Write "$N"  # #5 create
hook PreToolUse Edit  "$N"; printf 'export const x=1\nexport const y=2\n' > "$N"; hook PostToolUse Edit "$N"  # #6
cc undo 5 >/dev/null; rc=$?
ok "undo #5 (create w/ later edit) CONFLICTS, exit!=0" "[ $rc -ne 0 ]"
ok "file NOT deleted on conflict"        "[ -f '$N' ]"
ok "edit #6 content intact"              "grep -q 'y=2' '$N'"
cc undo 5 --force >/dev/null
ok "undo #5 --force deletes the created file" "[ ! -e '$N' ]"

echo "════════ E2E 5: diff of a force-undone create still renders ════════"
ok "diff #5 renders" "cc diff 5 | grep -q 'export const x=1'"

echo "════════ E2E 6: numeric --session id must NOT be mistaken for the edit id ════════"
NS=7
hookS(){ printf '{"session_id":"%s","cwd":"%s","hook_event_name":"%s","tool_name":"Edit","tool_input":{"file_path":"%s"}}' "$NS" "$WS" "$1" "$2" | node "$CAPTURE"; }
NF="$WS/num.txt"; printf 'p\nq\nr\n' > "$NF"
hookS PreToolUse "$NF"; node "$SETLINE" "$NF" 0 "PP"; hookS PostToolUse "$NF"
hookS PreToolUse "$NF"; node "$SETLINE" "$NF" 2 "RR"; hookS PostToolUse "$NF"
out=$(node "$CLI" diff --session "$NS" 2 2>&1)
ok "diff --session 7 2 targets edit #2" "echo \"\$out\" | grep -q 'RR'"
ok "  did NOT try edit #7 (the session value)" "! echo \"\$out\" | grep -qi 'no edit #7'"

echo "════════ E2E 7: redo re-applies an undone edit (fresh session) ════════"
RS=redoSess
hookR(){ printf '{"session_id":"%s","cwd":"%s","hook_event_name":"%s","tool_name":"Edit","tool_input":{"file_path":"%s"}}' "$RS" "$WS" "$1" "$2" | node "$CAPTURE"; }
RF="$WS/redo.txt"; printf 'one\ntwo\n' > "$RF"
hookR PreToolUse "$RF"; node "$SETLINE" "$RF" 0 "ONE"; hookR PostToolUse "$RF"
node "$CLI" undo --session "$RS" 1 >/dev/null
ok "undo reverted to 'one'" "grep -qx 'one' '$RF'"
node "$CLI" redo --session "$RS" 1 >/dev/null
ok "redo re-applied 'ONE'" "grep -qx 'ONE' '$RF'"
ok "redo set status back to pending" "node \"$CLI\" list --session \"$RS\" --pending | grep -q '#1'"

echo "════════ E2E 8: clean GC, clear --resolved, drop session ════════"
out=$(node "$CLI" clean --session "$RS" 2>&1)
ok "clean --session reports GC" "echo \"\$out\" | grep -qi 'garbage-collected'"
node "$CLI" keep --session "$RS" 1 >/dev/null
out=$(node "$CLI" clean --resolved --session "$RS" 2>&1)
ok "clean --resolved clears the kept edit" "echo \"\$out\" | grep -qiE 'cleared 1'"
STORE="$HOME/.claude/claude-observatory"
( cd "$WS" && node "$CLI" changemap --session "$RS" --json >/dev/null 2>&1 )   # warm the derived caches
ok "the session's map cache exists before the drop" "[ -d \"$STORE/changemap-cache/$RS\" ]"
node "$CLI" clean --drop "$RS" >/dev/null
ok "clean --drop removed the session store"   "[ ! -d \"$STORE/$RS\" ]"
ok "list on a dropped session finds nothing"  "! node \"$CLI\" list --session \"$RS\" | grep -q '#1'"
# 0.8.8: the derived caches hold the session's own prompt text and title — dropping the session drops them.
ok "…and its change-map cache went with it"   "[ ! -d \"$STORE/changemap-cache/$RS\" ]"
ok "…and its title/counts sidecar too"        "[ ! -f \"$STORE/session-meta/$RS.json\" ]"
# The caches are not sessions: a routine GC walks the store root for reclaimable husks and must not
# find these — deleting them silently discards the very caches this release's speed depends on.
( cd "$WS" && node "$CLI" changemap --json >/dev/null 2>&1 )   # a cache entry for the LIVE session
CACHED=$(ls "$STORE/changemap-cache" 2>/dev/null | head -1)
ok "a live session's map cache exists"        "[ -n \"$CACHED\" ]"
node "$CLI" clean --json >/dev/null 2>&1
ok "clean spares the cache directory"         "[ -d \"$STORE/changemap-cache\" ]"
ok "…and the cached map inside it"            "[ -n \"$CACHED\" ] && [ -e \"$STORE/changemap-cache/$CACHED\" ]"

echo "════════ E2E 9: init installs hooks, status reports them, uninstall removes them ════════"
out=$(cc init 2>&1)
ok "init installs capture hooks"          "echo \"\$out\" | grep -qi 'installed capture hooks'"
ok "settings.json now carries our hook"   "grep -q 'oak-observatory-hook' '$HOME/.claude/settings.json'"
out2=$(cc init 2>&1)
ok "init is idempotent (2nd run no-op)"   "echo \"\$out2\" | grep -qi 'already installed'"
ok "…and the 2nd run still reaches the codex leg" "echo \"\$out2\" | grep -qiE 'codex:? (hooks|capture|is not|not on this machine)'"
ok "status reports hooks installed"       "cc status | grep -qE 'hooks:[[:space:]]+installed'"
out=$(cc uninstall 2>&1)
ok "uninstall removes capture hooks"      "echo \"\$out\" | grep -qi 'removed capture hooks'"
ok "hook gone from settings.json"         "! grep -q 'oak-observatory-hook' '$HOME/.claude/settings.json'"
ok "status now reports not installed"     "cc status | grep -qi 'not installed'"

echo "════════ E2E 10: list filters + diff of a KEPT edit + sessions listing ════════"
LS=listSess
hookL(){ printf '{"session_id":"%s","cwd":"%s","hook_event_name":"%s","tool_name":"Edit","tool_input":{"file_path":"%s"}}' "$LS" "$WS" "$1" "$2" | node "$CAPTURE"; }
LF="$WS/list.txt"; printf 'a\nb\nc\n' > "$LF"
hookL PreToolUse "$LF"; node "$SETLINE" "$LF" 0 "AA"; hookL PostToolUse "$LF"   # #1
hookL PreToolUse "$LF"; node "$SETLINE" "$LF" 2 "CC"; hookL PostToolUse "$LF"   # #2
node "$CLI" keep --session "$LS" 1 >/dev/null
ok "list --pending shows the pending #2"  "node \"$CLI\" list --session \"$LS\" --pending | grep -q '#2'"
ok "list --pending hides the kept #1"     "! node \"$CLI\" list --session \"$LS\" --pending | grep -q '#1'"
ok "list --kept shows the kept #1"        "node \"$CLI\" list --session \"$LS\" --kept | grep -q '#1'"
ok "list --file filters by substring"     "node \"$CLI\" list --session \"$LS\" --file list.txt | grep -q '#2'"
ok "list --file miss -> no matching edits" "node \"$CLI\" list --session \"$LS\" --file nope.zzz | grep -qi 'no matching'"
ok "diff of the KEPT edit #1 renders"     "node \"$CLI\" diff --session \"$LS\" 1 | grep -q 'AA'"
# 0.8.8: `sessions` is workspace-filtered — a store-only session with no transcript under this cwd is
# another project's (or a deleted conversation) and is deliberately NOT offered by the picker.
ok "sessions is workspace-filtered (store-only session hidden)" "! node \"$CLI\" sessions | grep -q \"$LS\""
ok "sessions --json emits the 0.8.8 shape"  "node \"$CLI\" sessions --json | jq -e 'has(\"active\") and has(\"sessions\")' >/dev/null"
# …and the HUMAN listing, on a session this workspace really has: it must name it and report what it did.
printf '%s\n' '{"type":"user","message":{"role":"user","content":"Add retry logic to the uploader"},"timestamp":"2026-07-25T00:00:00Z"}' > "$HOME/.claude/projects/$MANGLE/$SESSION.jsonl"
out=$(cc sessions 2>&1)
ok "sessions names the workspace session"   "echo \"$out\" | grep -q \"$SESSION\" || echo \"$out\" | grep -qi 'retry logic'"
ok "sessions reports the session's counts"  "echo \"$out\" | grep -qE '[0-9]+ edit'"
ok "sessions marks the live session"        "echo \"$out\" | grep -q '●'"

echo "════════ E2E 11: error handling + exit codes ════════"
node "$CLI" boguscmd >/dev/null 2>&1; rc=$?
ok "unknown command exits non-zero"       "[ $rc -ne 0 ]"
( cd "$WS" && node "$CLI" undo ) >/dev/null 2>&1; rc=$?
ok "undo with no id exits non-zero"       "[ $rc -ne 0 ]"
node "$CLI" diff --session "$LS" 999 >/dev/null 2>&1; rc=$?
ok "diff of a nonexistent id exits !=0"   "[ $rc -ne 0 ]"
node "$CLI" keep --session "$LS" 999 >/dev/null 2>&1; rc=$?
ok "keep of a nonexistent id exits !=0"   "[ $rc -ne 0 ]"
out=$(node "$CLI" undo --session "$LS" 999 2>&1); rc=$?
ok "undo of a nonexistent id errors"      "echo \"\$out\" | grep -qi 'no edit'"
ok "  and exits non-zero"                 "[ $rc -ne 0 ]"

echo "════════ E2E 12: status stays graceful on a malformed (wrong-shape) settings.json ════════"
printf '{"hooks":{"PreToolUse":{"matcher":"Edit"}},"theme":"dark"}' > "$HOME/.claude/settings.json"
cc status >/dev/null 2>&1; rc=$?
ok "status does NOT crash on wrong-shape hooks" "[ $rc -eq 0 ]"
ok "status leaves the settings.json intact"     "grep -q theme '$HOME/.claude/settings.json'"

echo "════════ E2E 13: stats --json emits valid JSON (30 daily + 24 hourly buckets) ════════"
STATS=$(cc stats --json 2>/dev/null); rc=$?
ok "stats --json exits 0"            "[ $rc -eq 0 ]"
ok "output is valid JSON"            "printf '%s' \"\$STATS\" | jq -e . >/dev/null"
ok "daily series has 30 buckets"     "[ \$(printf '%s' \"\$STATS\" | jq '.daily | length') -eq 30 ]"
ok "hourly series has 24 buckets"    "[ \$(printf '%s' \"\$STATS\" | jq '.hourly | length') -eq 24 ]"
ok "today's window counts the session's edits" "[ \$(printf '%s' \"\$STATS\" | jq '.windows.day.edits') -ge 1 ]"
ok "human stats renders the table"   "cc stats | grep -q 'Claude usage stats'"
STATS2=$(cc stats --json 2>/dev/null)
ok "second run (warm cache) agrees"  "[ \"\$(printf '%s' \"\$STATS\" | jq -S '.daily')\" = \"\$(printf '%s' \"\$STATS2\" | jq -S '.daily')\" ]"

echo "════════ E2E 14: machine-readable surface (--json + blob/locate/observe/usage) ════════"
# Two chained same-line edits collapse into ONE review unit (#A a->X superseded by #B X->Y).
J="$WS/json.txt"; printf 'a\nb\nc\n' > "$J"
hook PreToolUse Edit "$J"; node "$SETLINE" "$J" 1 "X"; hook PostToolUse Edit "$J"
hook PreToolUse Edit "$J"; node "$SETLINE" "$J" 1 "Y"; hook PostToolUse Edit "$J"
LISTJ=$(cc list --json)
ok "list --json is valid JSON with deltas" "printf '%s' \"\$LISTJ\" | jq -e '.edits[0].added >= 0' >/dev/null"
ok "same-code edits collapse to one review unit" "[ \$(printf '%s' \"\$LISTJ\" | jq '[.edits[]|select(.file|endswith(\"json.txt\"))]|length') -eq 1 ]"
REP=$(printf '%s' "$LISTJ" | jq "[.edits[] | select(.file|endswith(\"json.txt\")) | .id] | .[0]")
ok "status --json reports the session + counts" "cc status --json | jq -e '.session == \"$SESSION\" and .counts.total >= 2' >/dev/null"
ok "sessions --json marks the active session"   "cc sessions --json | jq -e '.active == \"$SESSION\"' >/dev/null"
# undo the collapsed group --json: clean revert of the whole change back to the original, exit 0
UJ2=$(cc undo "$REP" --json); rc2=$?
ok "undo group --json -> status:undone, exit 0" "[ $rc2 -eq 0 ] && printf '%s' \"\$UJ2\" | jq -e '.status == \"undone\"' >/dev/null"
ok "undo group reverts to the original"         "head -1 \"$J\" | grep -q '^a\$'"
ok "redo group --json re-applies"               "cc redo \"$REP\" --json | jq -e '.status == \"redone\"' >/dev/null"
ok "keep group --json"                          "cc keep \"$REP\" --json | jq -e '.kept >= 1' >/dev/null"
ok "keep --all --json sweeps the rest"          "cc keep --all --json | jq -e '.kept >= 0' >/dev/null"
# Structured conflict path: a MANUAL change between two same-line edits breaks the chain, so they do
# NOT collapse; undoing the earlier one then reports a structured conflict (front-ends branch on .status).
K="$WS/conflict.txt"; printf 'p\nq\nr\n' > "$K"
hook PreToolUse Edit "$K"; node "$SETLINE" "$K" 0 "M1"; hook PostToolUse Edit "$K"   # E1: line 0 p->M1
printf 'M1\nQX\nr\n' > "$K"   # manual (non-hook) change to line 1 -> breaks the before/after chain
hook PreToolUse Edit "$K"; node "$SETLINE" "$K" 0 "M2"; hook PostToolUse Edit "$K"   # E2: line 0 M1->M2 (not chained)
CID=$(cc list --json | jq "[.edits[] | select(.file|endswith(\"conflict.txt\")) | .id] | min")
UJ=$(cc undo "$CID" --json); rc=$?
ok "undo --json non-chained overlap -> status:conflict" "printf '%s' \"\$UJ\" | jq -e '.status == \"conflict\" and .ok == false' >/dev/null"
ok "undo --json conflict exit code is 1"     "[ $rc -eq 1 ]"
# blob: raw bytes round-trip through the store
SHA=$(jq -r 'select(.afterBlob != null) | .afterBlob' "$HOME/.claude/claude-observatory/$SESSION/log.jsonl" | head -1)
ok "blob streams raw bytes"                  "[ -n \"\$(cc blob \"$SHA\")\" ]"
# locate: live-buffer text on stdin -> per-edit current line indices (prior edits were all kept, so re-edit)
hook PreToolUse Edit "$J"; node "$SETLINE" "$J" 2 "Z"; hook PostToolUse Edit "$J"
LOC=$(cc locate --file "$J" < "$J")
ok "locate emits placements for the pending edit" "printf '%s' \"\$LOC\" | jq -e '.placements | length >= 1' >/dev/null"
ok "locate maps the edit to its current line"     "printf '%s' \"\$LOC\" | jq -e '.placements[-1].lines | index(2) != null' >/dev/null"
# A SECOND pending edit to the same file: placements are now composed down the chain, so the EARLIER
# one is the interesting case — asserting only [-1] would pass even if every earlier placement were
# empty, since the newest edit is the one anchored directly against the buffer.
node "$SETLINE" "$J" 5 "Y2"; hook PreToolUse Edit "$J"; node "$SETLINE" "$J" 7 "Y3"; hook PostToolUse Edit "$J"
LOC2=$(cc locate --file "$J" < "$J")
ok "locate places EVERY pending edit, not just the newest" "printf '%s' \"\$LOC2\" | jq -e '[.placements[] | select(.lines | length > 0)] | length >= 2' >/dev/null"
ok "locate's first placement is non-empty (chain composed, not severed)" "printf '%s' \"\$LOC2\" | jq -e '.placements[0].lines | length > 0' >/dev/null"
ok "locate carries deletion hunks for the JetBrains overlay"  "printf '%s' \"\$LOC2\" | jq -e '.placements[0] | has(\"removed\")' >/dev/null"
# delta rides along so a lens can print "+A −R" without a second spawn, and only for placements that
# actually render (a superseded edit places nothing, so nothing reads its delta).
ok "locate carries a per-placement delta"                     "printf '%s' \"\$LOC2\" | jq -e '[.placements[]|select(.lines|length>0)]|all(.delta.added>=0 and (.delta|has(\"removed\")))' >/dev/null"
ok "delta counts a real deletion"                             "printf 'a\nb\nc\nd\n' > \"\$WS/del.txt\" && hook PreToolUse Edit \"\$WS/del.txt\" && printf 'a\n' > \"\$WS/del.txt\" && hook PostToolUse Edit \"\$WS/del.txt\" && cc locate --file \"\$WS/del.txt\" < \"\$WS/del.txt\" | jq -e '.placements[-1].delta.removed>=3' >/dev/null"
# A flag name is never a flag VALUE, and a scope flag never coexists with an explicit id.
cc locate --file --json < "$J" >/dev/null 2>&1; ok "locate --file --json fails instead of placing edits in a file called --json" "[ \$? -ne 0 ]"
cc keep --file main 1 --json >/dev/null 2>&1;   ok "keep --file <substr> <id> is refused (id would be discarded)"              "[ \$? -ne 0 ]"
cc undo --ids 999 --json >/dev/null 2>&1;       ok "undo --ids <n> still works (a flag VALUE is not a positional id)"          "[ \$? -eq 0 ]"
# observe: one payload for the Observations view
OBS=$(cc observe)
ok "observe emits per-edit summaries"        "printf '%s' \"\$OBS\" | jq -e '.edits[0].summary | length > 0' >/dev/null"
ok "observe carries memory + flags fields"   "printf '%s' \"\$OBS\" | jq -e '.edits[0] | has(\"memory\") and has(\"flags\")' >/dev/null"
# changemap: the Change Map view-model — core does every rollup so both editors render it as given
CM=$(cc changemap)
ok "changemap emits summary/edits/prompts/files/modules (no subtasks key)" "printf '%s' \"\$CM\" | jq -e 'has(\"summary\") and has(\"edits\") and has(\"prompts\") and has(\"files\") and has(\"modules\") and (has(\"subtasks\")|not)' >/dev/null"
ok "changemap file rows carry the core-computed rollup"   "printf '%s' \"\$CM\" | jq -e '.files[0] | has(\"churn\") and has(\"status\") and has(\"maxId\") and has(\"moduleLabel\")' >/dev/null"
ok "changemap module rows carry a label + churn"          "printf '%s' \"\$CM\" | jq -e '.modules[0] | has(\"label\") and has(\"churn\") and has(\"status\")' >/dev/null"
ok "changemap churn is conserved from files up to modules" "printf '%s' \"\$CM\" | jq -e '([.files[].churn]|add) == ([.modules[].churn]|add)' >/dev/null"
ok "changemap files are ranked churn-desc"                "printf '%s' \"\$CM\" | jq -e '[.files[].churn] == ([.files[].churn]|sort|reverse)' >/dev/null"
# usage: no statusline cache in this HOME -> statuslineCache false + shared staleness threshold
ok "usage reports cache-missing + staleMs"   "cc usage | jq -e '.statuslineCache == false and .staleMs == 300000' >/dev/null"

echo "════════ E2E 15: bundled statusline installs with no network ════════"
cc statusline >/dev/null 2>&1; rc=$?
ok "statusline command exits 0"               "[ $rc -eq 0 ]"
ok "statusline.sh written under ~/.claude"    "[ -x \"$HOME/.claude/statusline.sh\" ]"
ok "settings.json gained the statusLine entry" "jq -e '.statusLine.command | test(\"statusline.sh\")' \"$HOME/.claude/settings.json\" >/dev/null"
ok "existing settings keys preserved"          "jq -e '.theme == \"dark\"' \"$HOME/.claude/settings.json\" >/dev/null"
ok "idempotent on re-run"                      "cc statusline >/dev/null 2>&1"

echo "════════ E2E 16: folder/file scoped Accept/Revert/Clear (--under) ════════"
mkdir -p "$WS/pkgA/sub" "$WS/pkgB"
FA="$WS/pkgA/a.txt";     printf 'a1\n' > "$FA"
FSU="$WS/pkgA/sub/s.txt"; printf 's1\n' > "$FSU"
FBP="$WS/pkgB/b.txt";    printf 'b1\n' > "$FBP"
hook PreToolUse Edit "$FA";  node "$SETLINE" "$FA"  0 "A2"; hook PostToolUse Edit "$FA"    # pkgA/a
hook PreToolUse Edit "$FSU"; node "$SETLINE" "$FSU" 0 "S2"; hook PostToolUse Edit "$FSU"   # pkgA/sub/s
hook PreToolUse Edit "$FBP"; node "$SETLINE" "$FBP" 0 "B2"; hook PostToolUse Edit "$FBP"   # pkgB/b
# keep --under a FOLDER accepts every pending edit beneath it (pkgA/a + pkgA/sub/s), never the sibling pkgB.
KOUT=$(cc keep --under "$WS/pkgA")
ok "keep --under folder accepts both edits beneath it" "echo \"\$KOUT\" | grep -qiE 'kept 2'"
ok "sibling pkgB edit is left pending"                 "cc list --json | jq -e '[.edits[]|select((.file|endswith(\"pkgB/b.txt\")) and .status==\"pending\")]|length==1' >/dev/null"
# clean --resolved --under a folder drops only that folder's resolved edits.
COUT=$(cc clean --resolved --under "$WS/pkgA")
ok "clean --resolved --under folder clears the 2 kept"  "echo \"\$COUT\" | grep -qiE 'cleared 2'"
ok "pkgA edits gone from the log; pkgB still present"    "cc list --json | jq -e '([.edits[]|select(.file|contains(\"pkgA\"))]|length==0) and ([.edits[]|select(.file|endswith(\"pkgB/b.txt\"))]|length==1)' >/dev/null"
# clean --resolved --ids clears an EXPLICIT id set — the scope one PROMPT names (its edits span whatever
# folders the ask touched, so no --under path can express it). Pending ids in the set are left alone.
mkdir -p "$WS/pkgD"
FD1="$WS/pkgD/d1.txt"; FD2="$WS/pkgD/d2.txt"
printf 'd1\n' > "$FD1"; printf 'd2\n' > "$FD2"
hook PreToolUse Edit "$FD1"; node "$SETLINE" "$FD1" 0 "D1b"; hook PostToolUse Edit "$FD1"   # kept below
hook PreToolUse Edit "$FD2"; node "$SETLINE" "$FD2" 0 "D2b"; hook PostToolUse Edit "$FD2"   # stays pending
ID_KEPT=$(cc list --json | jq -r '[.edits[]|select(.file|endswith("pkgD/d1.txt"))][0].id')
ID_PEND=$(cc list --json | jq -r '[.edits[]|select(.file|endswith("pkgD/d2.txt"))][0].id')
cc keep "$ID_KEPT" >/dev/null
IOUT=$(cc clean --resolved --ids "$ID_KEPT,$ID_PEND" --json)
ok "clean --resolved --ids clears only the resolved id"  "echo \"\$IOUT\" | jq -e '.cleared==1 and (.ids|length==1)' >/dev/null"
ok "the pending id in the set is left in the log"        "cc list --json | jq -e --argjson p \"\$ID_PEND\" '[.edits[]|select(.id==\$p)]|length==1' >/dev/null"
# undo --under an EXACT FILE reverts just that file's edit (folder-prefix rule matches the file itself).
UOUT=$(cc undo --under "$FBP")
ok "undo --under file reverts that file's edit"          "echo \"\$UOUT\" | grep -qiE 'reverted 1'"
ok "pkgB/b.txt restored to original 'b1'"                "grep -qx 'b1' '$FBP'"
# undo --under reverts PENDING edits only — an already-Accepted (kept) edit is left on disk.
mkdir -p "$WS/pkgC"
FCP="$WS/pkgC/p.txt"; FCK="$WS/pkgC/k.txt"
printf 'p1\n' > "$FCP"; printf 'k1\n' > "$FCK"
hook PreToolUse Edit "$FCP"; node "$SETLINE" "$FCP" 0 "P2"; hook PostToolUse Edit "$FCP"   # pkgC/p (stays pending)
hook PreToolUse Edit "$FCK"; node "$SETLINE" "$FCK" 0 "K2"; hook PostToolUse Edit "$FCK"   # pkgC/k (accepted)
cc keep --under "$FCK" >/dev/null                                                          # accept just k.txt
RUOUT=$(cc undo --under "$WS/pkgC")
ok "undo --under folder reverts only the 1 pending edit"  "echo \"\$RUOUT\" | grep -qiE 'reverted 1'"
ok "pending pkgC/p.txt restored to original 'p1'"          "grep -qx 'p1' '$FCP'"
ok "accepted pkgC/k.txt left on disk (K2)"                 "grep -q 'K2' '$FCK'"
ok "accepted pkgC/k.txt is still status=kept"              "cc list --json | jq -e '[.edits[]|select((.file|endswith(\"pkgC/k.txt\")) and .status==\"kept\")]|length==1' >/dev/null"
# undo --all is the session-wide bulk revert (mirror of keep --all) — emits the same scoped shape.
ok "undo --all --json emits {undone,conflicts,total}"      "cc undo --all --json | jq -e 'has(\"undone\") and has(\"conflicts\") and has(\"total\")' >/dev/null"

echo "════════ E2E 17: 0.8.0 multi-agent (multitask / tasklog / siblings --repo / changemap agents / chat-context / task-keep|undo) ════════"
# A plain .git DIRECTORY makes commonDir resolve (git-free — no git binary), so listRepoSiblings can
# group worktree-siblings by repo. Two sessions launched from $WS share this repo key.
mkdir -p "$WS/.git"
MTA=mtAgent; MTB=mtBgent
CONTENT="implement shared feature"
# Transcripts: a first user line carrying cwd+gitBranch (so firstCwdLine/listRepoSiblings resolve the
# repo), then TWO TodoWrite snapshots of the SAME in_progress to-do bracketing "now" — a REAL strict
# in_progress interval so the edits captured below fall inside it and get a stable taskId (§2.1).
node -e '
  const fs=require("fs");
  const [proj, ws, mta, mtb, content]=process.argv.slice(1);
  const TA=new Date(Date.now()-3600000).toISOString();
  const TB=new Date(Date.now()+3600000).toISOString();
  const cwdLine=(sid,br)=>JSON.stringify({type:"user",sessionId:sid,cwd:ws,gitBranch:br,timestamp:TA});
  const todoLine=(ts)=>JSON.stringify({type:"assistant",timestamp:ts,message:{role:"assistant",content:[{type:"tool_use",id:"tu_"+ts,name:"TodoWrite",input:{todos:[{content,status:"in_progress"}]}}]}});
  // A Task (subagent-spawn) action in agent A only — so the multitask Actions section can prove it
  // DROPS the "agent" (Subagents) category (those are the fleet rows above), while `cc actions` keeps it.
  const agentLine=(ts)=>JSON.stringify({type:"assistant",timestamp:ts,message:{role:"assistant",content:[{type:"tool_use",id:"ag_"+ts,name:"Task",input:{description:"spawn helper",subagent_type:"general-purpose"}}]}});
  for (const [sid,br] of [[mta,"feat/a"],[mtb,"feat/b"]]) {
    const lines=[cwdLine(sid,br), todoLine(TA), todoLine(TB)];
    if (sid===mta) lines.push(agentLine(TA));
    fs.writeFileSync(proj+"/"+sid+".jsonl", lines.join("\n")+"\n");
  }
' "$HOME/.claude/projects/$MANGLE" "$WS" "$MTA" "$MTB" "$CONTENT"
# One subagent under agent A, with its OWN in_progress TodoWrite (so subagentTodos.currentTask is set).
mkdir -p "$HOME/.claude/projects/$MANGLE/$MTA/subagents"
node -e '
  const fs=require("fs");
  const [dir, content]=process.argv.slice(1);
  const line=JSON.stringify({type:"assistant",isSidechain:true,timestamp:new Date().toISOString(),agentId:"suba",sessionId:"mtAgent",message:{role:"assistant",content:[{type:"tool_use",id:"stu1",name:"TodoWrite",input:{todos:[{content,status:"in_progress"}]}}]}});
  fs.writeFileSync(dir+"/agent-suba.jsonl", line+"\n");
' "$HOME/.claude/projects/$MANGLE/$MTA/subagents" "subagent task alpha"
# A WORKFLOW RUN (0.8.0) under agent A: <session>/subagents/workflows/wf_<id>/ (journal + one agent
# transcript + meta sidecar), plus the rich per-run STATE FILE <session>/workflows/wf_<id>.json (0.8.0 r2,
# the PRIMARY source: informative name/summary, real phase titles, labeled agents). Two tool_use turns 2h
# apart, BRACKETING now (T0=now-1h, T1=now+1h) with usage + an Edit → the run surfaces per-agent + run-level
# tokens/durationMs/edits, and its ts-window contains the shared.txt store edit captured below, so changemap
# can attribute that edit to this workflow (0.8.0 r2, §C/§D).
node -e '
  const fs=require("fs"), path=require("path");
  const [sessDir]=process.argv.slice(1);
  const T0=new Date(Date.now()-3600000).toISOString(), T1=new Date(Date.now()+3600000).toISOString();
  const wf=path.join(sessDir,"subagents","workflows","wf_e2e"); fs.mkdirSync(wf,{recursive:true});
  const scripts=path.join(sessDir,"workflows","scripts"); fs.mkdirSync(scripts,{recursive:true});
  fs.writeFileSync(path.join(scripts,"e2e-flow-wf_e2e.js"),
    "export const meta = {\n  name: '"'"'E2E Flow'"'"',\n  description: '"'"'an e2e workflow'"'"',\n  phases: [{ title: '"'"'Do'"'"' }],\n}\n");
  fs.writeFileSync(path.join(sessDir,"workflows","wf_e2e.json"),JSON.stringify({
    workflowName:"E2E Flow", summary:"an informative e2e workflow that ships in both editors",
    phases:[{title:"Do",detail:"the work"}],
    workflowProgress:[{type:"workflow_phase",index:0,title:"Do"},
      {type:"workflow_agent",label:"S1-do",phaseTitle:"Do",phaseIndex:0,agentId:"wfa",tokens:400,toolCalls:2,state:"completed",durationMs:7200000}],
    totalTokens:400, totalToolCalls:2, durationMs:7200000, status:"completed", startTime:T0, agentCount:1}));
  fs.writeFileSync(path.join(wf,"journal.jsonl"),
    [{type:"started",key:"k1",agentId:"wfa"},{type:"result",key:"k1",agentId:"wfa",result:{ok:true}}].map(o=>JSON.stringify(o)).join("\n"));
  fs.writeFileSync(path.join(wf,"agent-wfa.meta.json"),JSON.stringify({agentType:"workflow-subagent",spawnDepth:1}));
  fs.writeFileSync(path.join(wf,"agent-wfa.jsonl"),
    [ {timestamp:T0,message:{role:"assistant",id:"w1",usage:{input_tokens:100,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:200},content:[{type:"tool_use",id:"we1",name:"Edit",input:{file_path:"/f.ts",old_string:"a\nb\n",new_string:"a\nb\nc\n"}}]}},
      {message:{role:"user",content:[{type:"tool_result",tool_use_id:"we1",is_error:false}]}},
      {timestamp:T1,message:{role:"assistant",id:"w2",usage:{input_tokens:50,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:50},content:[{type:"tool_use",id:"we2",name:"Read",input:{file_path:"/g.ts"}}]}} ].map(o=>JSON.stringify(o)).join("\n"));
' "$HOME/.claude/projects/$MANGLE/$MTA"
# Both agents edit the SAME file $WS/shared.txt (A first, then B) → a cross-agent collision + a task
# both agents contribute to. Chain the edits so B is the newest edit on the file (clean task-undo below).
mthook(){ printf '{"session_id":"%s","cwd":"%s","hook_event_name":"%s","tool_name":"%s","tool_input":{"file_path":"%s"}}' "$1" "$WS" "$2" "$3" "$4" | node "$CAPTURE"; }
SF="$WS/shared.txt"; printf 'base\n' > "$SF"
mthook "$MTA" PreToolUse Edit "$SF"; node "$SETLINE" "$SF" 0 "A_X"; mthook "$MTA" PostToolUse Edit "$SF"   # A: base->A_X
mthook "$MTB" PreToolUse Edit "$SF"; node "$SETLINE" "$SF" 0 "B_Y"; mthook "$MTB" PostToolUse Edit "$SF"   # B: A_X->B_Y

# --- multitask: one payload for the whole fleet, aggregated in core/CLI (renderers stay thin) ---
MT=$(cc multitask --session "$MTA" 2>/dev/null)
ok "multitask --json is valid JSON"                     "printf '%s' \"\$MT\" | jq -e . >/dev/null"
ok "multitask carries agents/collisions/worktrees/summary" "printf '%s' \"\$MT\" | jq -e 'has(\"agents\") and has(\"collisions\") and has(\"worktrees\") and has(\"summary\")' >/dev/null"
ok "multitask groups BOTH worktree-siblings as agents"  "[ \$(printf '%s' \"\$MT\" | jq '.agents|length') -ge 2 ]"
ok "multitask agent row carries phase/phaseConfidence/sparkline(20)/diff/risk" "printf '%s' \"\$MT\" | jq -e '.agents[0] | has(\"phase\") and has(\"phaseConfidence\") and (.sparkline|length==20) and (.diff|has(\"added\") and has(\"removed\")) and has(\"risk\")' >/dev/null"
# 0.8.0 r3 (M1): each fleet sibling gains tokens + wall-clock (durationMs) — the SAME metric style Workflows
# already show. The two agent transcripts span TA→TB (2h), so durationMs>0; tokens is present (0 here — those
# lines carry no usage block).
ok "multitask agent row carries tokens + durationMs (fleet metrics)" "printf '%s' \"\$MT\" | jq -e '.agents[0] | has(\"tokens\") and has(\"durationMs\") and (.durationMs>0)' >/dev/null"
ok "multitask subagents carry todos + currentTask"      "printf '%s' \"\$MT\" | jq -e '[.agents[].subagents[] | select(has(\"todos\") and has(\"currentTask\"))]|length>=1' >/dev/null"
ok "multitask subagent currentTask extracted (in_progress todo)" "printf '%s' \"\$MT\" | jq -e '[.agents[].subagents[] | select(.currentTask==\"subagent task alpha\")]|length>=1' >/dev/null"
ok "multitask collisions come from the UNCAPPED set (shared.txt, 2 agents)" "printf '%s' \"\$MT\" | jq -e '[.collisions[] | select((.file|endswith(\"shared.txt\")) and (.agents|length>=2))]|length==1' >/dev/null"
ok "multitask summary reports the conflict"             "printf '%s' \"\$MT\" | jq -e '.summary.conflicts>=1' >/dev/null"
# 0.8.0 r2 (B): a collision is a LIVE overlap — shared.txt is PENDING in 2 BOTH-active agents (not just
# a historically-shared path). anyPending is by-definition true; the named agents are the active ones.
ok "multitask collision is a live pending overlap (anyPending)" "printf '%s' \"\$MT\" | jq -e '[.collisions[] | select((.file|endswith(\"shared.txt\")) and .anyPending==true)]|length==1' >/dev/null"

# --- 0.8.0: workflow-run tracking — one level above subagents, aggregated in core (renderers stay thin) ---
ok "multitask carries a workflows array"                "printf '%s' \"\$MT\" | jq -e '.workflows|type==\"array\"' >/dev/null"
ok "multitask workflow run carries agents+tokens+durationMs+edits" "printf '%s' \"\$MT\" | jq -e '[.workflows[] | select((.agents|type==\"array\") and has(\"tokens\") and has(\"durationMs\") and has(\"edits\"))]|length>=1' >/dev/null"
ok "multitask workflow name/phases resolved from the script meta" "printf '%s' \"\$MT\" | jq -e '[.workflows[] | select(.name==\"E2E Flow\" and (.phases==[\"Do\"]))]|length==1' >/dev/null"
ok "multitask workflow surfaces summed tokens>0/durationMs>0/edits>=1" "printf '%s' \"\$MT\" | jq -e '[.workflows[] | select(.tokens>0 and .durationMs>0 and .edits>=1)]|length>=1' >/dev/null"
ok "multitask workflow agent carries per-agent tokens/durationMs/edits" "printf '%s' \"\$MT\" | jq -e '[.workflows[].agents[] | select(has(\"tokens\") and has(\"durationMs\") and has(\"edits\"))]|length>=1' >/dev/null"
# 0.8.0 r2: the rich state file is the PRIMARY source — informative description (summary), real per-phase
# grouping (phaseGroups), and labeled agents carrying a REAL phase title (not the journal hash).
ok "multitask workflow carries an informative description (state summary)" "printf '%s' \"\$MT\" | jq -e '[.workflows[] | select(.id==\"wf_e2e\" and (.description|test(\"informative e2e workflow\")))]|length==1' >/dev/null"
ok "multitask workflow carries phaseGroups (Do done 1/1)"  "printf '%s' \"\$MT\" | jq -e '[[.workflows[]|select(.id==\"wf_e2e\")][0].phaseGroups[] | select(.title==\"Do\" and .done==1 and .total==1)]|length==1' >/dev/null"
ok "multitask workflow agent carries label + real phase title" "printf '%s' \"\$MT\" | jq -e '[.workflows[].agents[] | select(.label==\"S1-do\" and .phase==\"Do\")]|length==1' >/dev/null"

# --- 0.8.0 (A): Actions folded into Multitasking — a curated tool-call timeline + egress for the ACTIVE
#     session, MINUS the fleet/subagent (agent) category (already the fleet rows above) ---
ok "multitask carries an actions section (groups + egress)" "printf '%s' \"\$MT\" | jq -e '.actions | has(\"groups\") and has(\"egress\")' >/dev/null"
ok "multitask actions has ≥1 curated group"             "printf '%s' \"\$MT\" | jq -e '.actions.groups|length>=1' >/dev/null"
ok "multitask actions DROPS the subagent (agent) group" "printf '%s' \"\$MT\" | jq -e '[.actions.groups[] | select(.category==\"agent\")]|length==0' >/dev/null"
# Proof the drop is real: the standalone `actions` view DOES surface the agent group for this session.
ok "actions view (unfolded) still shows the agent group" "cc actions --session \"$MTA\" --json | jq -e '[.groups[] | select(.category==\"agent\")]|length>=1' >/dev/null"

# --- subagents: each subagent now carries running/phase + sidecar-ish todos/currentTask (S4/S5) ---
SA=$(cc subagents --session "$MTA" --json 2>/dev/null)
ok "subagents --json subagent carries running/phase/todos/currentTask" "printf '%s' \"\$SA\" | jq -e '[.subagents[] | select(has(\"running\") and has(\"phase\") and has(\"todos\") and has(\"currentTask\"))]|length>=1' >/dev/null"

# --- tasklog: one row per stable taskId, unioned across worktree-siblings ---
TL=$(cc tasklog 2>/dev/null)
ok "tasklog --json is an array"                         "printf '%s' \"\$TL\" | jq -e 'type==\"array\"' >/dev/null"
ok "tasklog row carries taskId/agentIds/edits/added/removed/status" "printf '%s' \"\$TL\" | jq -e '.[0] | has(\"taskId\") and has(\"agentIds\") and has(\"edits\") and has(\"added\") and has(\"removed\") and has(\"status\")' >/dev/null"
ok "tasklog unions ONE task across BOTH agents (2 agentIds)" "printf '%s' \"\$TL\" | jq -e '[.[] | select(.agentIds|length>=2)]|length>=1' >/dev/null"

# --- siblings --repo: worktree-scoped, each sibling gains worktree/gitBranch/phase; summary.conflicts ---
SR=$(cc siblings --repo --session "$MTA" --json 2>/dev/null)
ok "siblings --repo siblings carry worktree/gitBranch/phase" "printf '%s' \"\$SR\" | jq -e '[.siblings[] | select(has(\"worktree\") and has(\"gitBranch\") and has(\"phase\"))]|length>=1' >/dev/null"
ok "siblings --repo summary carries conflicts (uncapped)" "printf '%s' \"\$SR\" | jq -e '.summary.conflicts>=1' >/dev/null"

# --- changemap: additive keys (removing nothing) — agents[] per-sibling builds + unassigned bucket ---
CM2=$(cc changemap --session "$MTA" 2>/dev/null)
ok "changemap still carries summary/edits/files/modules" "printf '%s' \"\$CM2\" | jq -e 'has(\"summary\") and has(\"edits\") and has(\"files\") and has(\"modules\")' >/dev/null"
ok "changemap adds rollupByAgent/agents/unassigned"     "printf '%s' \"\$CM2\" | jq -e 'has(\"rollupByAgent\") and has(\"agents\") and has(\"unassigned\")' >/dev/null"
ok "changemap agents[] is a per-sibling change-map build (both worktrees)" "printf '%s' \"\$CM2\" | jq -e '[.agents[] | select(has(\"summary\") and has(\"rollupByTask\"))]|length>=2' >/dev/null"
# 0.8.7: the per-sibling edit LIST is projected out of agents[] (1.95 MB of a 3.30 MB payload that no
# renderer read); the session's own top-level edits are untouched.
ok "changemap agents[] carries no per-sibling edit list"  "printf '%s' \"\$CM2\" | jq -e '[.agents[] | select(has(\"edits\"))]|length==0' >/dev/null"
ok "changemap per-edit carries taskId (strict spans)"   "printf '%s' \"\$CM2\" | jq -e '.edits[0] | has(\"taskId\")' >/dev/null"
ok "changemap unassigned bucket has taskId null"        "printf '%s' \"\$CM2\" | jq -e '.unassigned.taskId==null' >/dev/null"

# --- 0.8.0 r2 (C/D): workflow→edit attribution + the Overview per-workflow dimension ---
ok "changemap adds rollupByWorkflow + workflows[] + per-edit workflowId" "printf '%s' \"\$CM2\" | jq -e 'has(\"rollupByWorkflow\") and (.workflows|type==\"array\") and (.edits[0]|has(\"workflowId\"))' >/dev/null"
ok "changemap attributes MTA's in-window store edit to wf_e2e" "printf '%s' \"\$CM2\" | jq -e '[.edits[] | select(.workflowId==\"wf_e2e\")]|length>=1' >/dev/null"
ok "changemap workflows[] has the wf_e2e tab (named, ≥1 edit, ≥1 file)" "printf '%s' \"\$CM2\" | jq -e '[.workflows[] | select(.id==\"wf_e2e\" and .name==\"E2E Flow\" and .rollup.edits>=1 and (.files|length>=1))]|length==1' >/dev/null"
ok "changemap rollupByWorkflow has the wf_e2e row"      "printf '%s' \"\$CM2\" | jq -e '[.rollupByWorkflow[] | select(.workflowId==\"wf_e2e\")]|length==1' >/dev/null"

# --- chat-context: a zero-token, ready-to-paste prompt; assembled from plain files, NO model spawn ---
EID=$(cc list --session "$MTA" --json | jq '.edits[0].id')
CX=$(cc chat-context --session "$MTA" --edit "$EID" 2>/dev/null); rc=$?
ok "chat-context exits 0 (no model, no network)"        "[ $rc -eq 0 ]"
ok "chat-context returns a non-empty prompt"            "printf '%s' \"\$CX\" | jq -e '.prompt|length>0' >/dev/null"
ok "chat-context prompt carries the edit before/after"  "printf '%s' \"\$CX\" | jq -e '.prompt|test(\"before\")' >/dev/null"
TID=$(printf '%s' "$CM2" | jq -r '[.edits[] | select(.taskId!=null) | .taskId][0]')
ok "an edit resolved to a strict-span taskId"           "[ -n \"$TID\" ] && [ \"$TID\" != null ]"
ok "chat-context --task frames the task (no model call)" "cc chat-context --session \"$MTA\" --task \"$TID\" | jq -e '.prompt|test(\"task\")' >/dev/null"

# --- task-keep / task-undo: resolve taskId -> STRICT in_progress edit set -> keep/undo (destructive, last) ---
TK=$(cc task-keep --session "$MTA" "$TID" --json)
ok "task-keep --json keeps agent A's strict edit(s)" "printf '%s' \"\$TK\" | jq -e '.kept>=1 and (.ids|length>=1)' >/dev/null"
TU=$(cc task-undo --session "$MTB" "$TID" --json)
ok "task-undo --json reverts agent B's strict edit(s)" "printf '%s' \"\$TU\" | jq -e '.undone>=1 and (.conflicts==0)' >/dev/null"
ok "task-undo restored shared.txt to A's content (A_X)"  "grep -qx 'A_X' '$SF'"

# --- 0.8.0 (C): task-clear — drop a task's RESOLVED (kept/undone) strict edits; --completed clears
#     every SETTLED task. Agent B's TID edit is now UNDONE; agent A's TID edit is now KEPT. ---
TC=$(cc task-clear --session "$MTB" "$TID" --json)
ok "task-clear --json drops agent B's resolved (undone) edit" "printf '%s' \"\$TC\" | jq -e '.cleared>=1 and (.ids|length>=1)' >/dev/null"
ok "task-clear actually removed the edit from B's log"    "[ \$(cc list --session \"$MTB\" --json | jq '.edits|length') -eq 0 ]"
TCC=$(cc task-clear --session "$MTA" --completed --json)
ok "task-clear --completed clears the settled (all-kept) task" "printf '%s' \"\$TCC\" | jq -e '.cleared>=1' >/dev/null"
ok "task-clear --completed reports the settled task's taskId" "printf '%s' \"\$TCC\" | jq -e --arg t \"$TID\" '[.tasks[] | select(.taskId==\$t)]|length>=1' >/dev/null"
ok "task-clear --completed removed agent A's kept edit"   "[ \$(cc list --session \"$MTA\" --json | jq '.edits|length') -eq 0 ]"

echo "════════ E2E 18: 0.8.0 Observations view-model (timeline runs + reasoning + recap + next steps) ════════"
OBSESS=obsSess
: > "$HOME/.claude/projects/$MANGLE/$OBSESS.jsonl"
OBF="$WS/obs.txt"; printf 'x\n' > "$OBF"
# A transcript with Claude's reasoning TEXT preceding an Edit tool_use on obs.txt (so reasoningByEdit
# correlates), an open TodoWrite (→ nextSteps), and an ai-title recap (→ recap).
node -e '
  const fs=require("fs");
  const [proj, sess, file]=process.argv.slice(1);
  const now=new Date().toISOString();
  const title=JSON.stringify({type:"ai-title",aiTitle:"Observations recap line",timestamp:now});
  const edit=JSON.stringify({type:"assistant",timestamp:now,message:{role:"assistant",content:[
    {type:"text",text:"Reasoned about the obs edit."},
    {type:"tool_use",id:"oe1",name:"Edit",input:{file_path:file}}]}});
  const todo=JSON.stringify({type:"assistant",timestamp:now,message:{role:"assistant",content:[
    {type:"tool_use",id:"ot1",name:"TodoWrite",input:{todos:[{content:"ship observations",status:"pending"}]}}]}});
  fs.writeFileSync(proj+"/"+sess+".jsonl", [title, edit, todo].join("\n")+"\n");
' "$HOME/.claude/projects/$MANGLE" "$OBSESS" "$OBF"
# TWO adjacent edits to obs.txt → they coalesce into ONE ×2 run with a combined delta.
obhook(){ printf '{"session_id":"%s","cwd":"%s","hook_event_name":"%s","tool_name":"%s","tool_input":{"file_path":"%s"}}' "$OBSESS" "$WS" "$1" "$2" "$3" | node "$CAPTURE"; }
obhook PreToolUse Edit "$OBF"; node "$SETLINE" "$OBF" 0 "OBS1"; obhook PostToolUse Edit "$OBF"
obhook PreToolUse Edit "$OBF"; node "$SETLINE" "$OBF" 0 "OBS2"; obhook PostToolUse Edit "$OBF"
OBSV=$(cc observations --session "$OBSESS" 2>/dev/null)
ok "observations --json carries recap/runs/nextSteps"    "printf '%s' \"\$OBSV\" | jq -e 'has(\"recap\") and has(\"runs\") and has(\"nextSteps\")' >/dev/null"
ok "observations recap is the session title"             "printf '%s' \"\$OBSV\" | jq -e '.recap==\"Observations recap line\"' >/dev/null"
# `observe` reads the recap through core's accessor instead of building the whole Observations model.
# Nothing pinned that it produces the same STRING: replacing the line with a literal `null` left every
# suite green. These two must agree by construction — that shared definition is the reason core owns it.
OBSRV=$( cc observe --session "$OBSESS" --json )
ok "observe --json carries the same recap"               "printf '%s' \"\$OBSRV\" | jq -e '.recap==\"Observations recap line\"' >/dev/null"
ok "observe and observations agree on the recap"         "[ \"\$(printf '%s' \"\$OBSRV\" | jq -r .recap)\" = \"\$(printf '%s' \"\$OBSV\" | jq -r .recap)\" ]"
ok "observations coalesces adjacent same-file edits ×N"  "printf '%s' \"\$OBSV\" | jq -e '[.runs[] | select((.file|endswith(\"obs.txt\")) and .count>=2)]|length==1' >/dev/null"
ok "observations run carries combined delta + per-edit rows" "printf '%s' \"\$OBSV\" | jq -e '.runs[0] | has(\"added\") and has(\"removed\") and (.edits|length>=1) and .edits[0].status!=null' >/dev/null"
ok "observations edit carries Claude's reasoning"        "printf '%s' \"\$OBSV\" | jq -e '[.runs[].edits[] | select(.reasoning!=null)]|length>=1' >/dev/null"
ok "observations nextSteps includes the open to-do"      "printf '%s' \"\$OBSV\" | jq -e '[.nextSteps[] | select(test(\"ship observations\"))]|length>=1' >/dev/null"

echo "════════ E2E 20: 0.8.6 session vitals · compactions · capabilities · context sources ════════"
# One transcript carrying everything the 0.8.6 lenses read: two models (the later one wins), a
# structural effort stamp, a real compact_boundary record (no `message` field — it must survive the
# parser's message gate), a Skill invocation, and an out-of-workspace read.
V6=vitals86
: > "$HOME/.claude/projects/$MANGLE/$V6.jsonl"
node -e '
  const fs=require("fs");
  const [proj, sess]=process.argv.slice(1);
  const at=(ms)=>new Date(ms).toISOString();
  const turn=(id,model,effort,ms,usage)=>JSON.stringify({type:"assistant",timestamp:at(ms),effort,
    message:{role:"assistant",id,model,usage,content:[]}});
  const boundary=JSON.stringify({type:"system",subtype:"compact_boundary",content:"Conversation compacted",
    isSidechain:false,timestamp:at(3000),
    compactMetadata:{trigger:"auto",preTokens:1000140,postTokens:13883,cumulativeDroppedTokens:986257,durationMs:125455}});
  const skill=JSON.stringify({type:"assistant",timestamp:at(4000),message:{role:"assistant",content:[
    {type:"tool_use",id:"sk1",name:"Skill",input:{skill:"dataviz"}}]}});
  const outside=JSON.stringify({type:"assistant",timestamp:at(5000),message:{role:"assistant",content:[
    {type:"tool_use",id:"rd1",name:"Read",input:{file_path:"/etc/hosts"}}]}});
  fs.writeFileSync(proj+"/"+sess+".jsonl",[
    turn("v1","claude-opus-4-8","max",1000,{input_tokens:900,output_tokens:20,cache_read_input_tokens:100,cache_creation_input_tokens:0}),
    turn("v2","claude-fable-5","xhigh",2000,{input_tokens:1200,output_tokens:30,cache_read_input_tokens:200,cache_creation_input_tokens:0}),
    boundary, skill, outside].join("\n")+"\n");
' "$HOME/.claude/projects/$MANGLE" "$V6"
USG=$(cc usage --session "$V6" 2>/dev/null)
ok "usage --json carries vitals"                         "printf '%s' \"\$USG\" | jq -e 'has(\"vitals\") and has(\"sessionTokens\")' >/dev/null"
ok "vitals: the LATEST main-chain model is current"      "printf '%s' \"\$USG\" | jq -e '.vitals.model.label==\"Fable 5\"' >/dev/null"
ok "vitals: every model used is listed (switch shown)"   "printf '%s' \"\$USG\" | jq -e '(.vitals.models|length)==2' >/dev/null"
ok "vitals: effort read from the assistant record"       "printf '%s' \"\$USG\" | jq -e '.vitals.effort.level==\"xhigh\" and .vitals.effort.source==\"record\"' >/dev/null"
ok "vitals: the compaction is captured"                  "printf '%s' \"\$USG\" | jq -e '(.vitals.compactions|length)==1' >/dev/null"
ok "vitals: no per-turn context series (dropped in 0.8.7)" "printf '%s' \"\$USG\" | jq -e '(.vitals|has(\"context\"))|not' >/dev/null"
ACT6=$(cc actions --session "$V6" --json 2>/dev/null)
ok "actions: a compaction becomes a 'compact' row"       "printf '%s' \"\$ACT6\" | jq -e '[.actions[]|select(.category==\"compact\")]|length==1' >/dev/null"
ok "actions: the compact row carries THIS event's drop"  "printf '%s' \"\$ACT6\" | jq -e '[.actions[]|select(.category==\"compact\")][0].compact.droppedTokens==986257' >/dev/null"
# 0.8.7: the footprint folded into the risk/egress audits. Its two unique facts now live where they
# belong — reads that left the workspace are egress (reach), writes that left it are risk (damage).
RISK7=$(cc risk --session "$V6" --json 2>/dev/null)
ok "risk --json reports writes that left the workspace" "printf '%s' \"\$RISK7\" | jq -e 'has(\"outsideWrites\")' >/dev/null"
EGR7=$(cc egress --session "$V6" --json 2>/dev/null)
ok "egress --json carries out-of-workspace reads"      "printf '%s' \"\$EGR7\" | jq -e '[.channels[]|select(.kind==\"file\")]|length>=1' >/dev/null"
ok "egress: an outside read is scoped local, not unknown" "printf '%s' \"\$EGR7\" | jq -e '[.channels[]|select(.kind==\"file\" and .scope==\"local\")]|length>=1' >/dev/null"
ok "changemap no longer carries a footprint payload"   "printf '%s' \"\$(cc changemap --json 2>/dev/null)\" | jq -e '(has(\"footprint\"))|not' >/dev/null"
OBS6=$(cc observations --session "$V6" 2>/dev/null)
ok "observations: context sources ride the payload"      "printf '%s' \"\$OBS6\" | jq -e '.context|has(\"sources\") and has(\"note\")' >/dev/null"
ok "observations: an invoked skill is transcript-proven" "printf '%s' \"\$OBS6\" | jq -e '[.context.sources[]|select(.kind==\"skill\" and .evidence==\"transcript\")]|length==1' >/dev/null"

echo "════════ E2E 21: 0.8.7 background processes ════════"
# A backgrounded Bash leaves three marks: the spawn (run_in_background), a result naming the shell, and
# a queue-operation notification carrying the exit code. A FOREGROUND Bash must not appear.
P7=proc87
: > "$HOME/.claude/projects/$MANGLE/$P7.jsonl"
POUT="$WS/job.output"; printf 'output\n' > "$POUT"
node -e '
  const fs=require("fs");
  const [proj, sess, out]=process.argv.slice(1);
  const at=(ms)=>new Date(ms).toISOString();
  const spawn=JSON.stringify({timestamp:at(1000),type:"assistant",message:{role:"assistant",content:[
    {type:"tool_use",id:"tb1",name:"Bash",input:{command:"npm test",description:"Run the suite",run_in_background:true}}]}});
  const res=JSON.stringify({timestamp:at(1100),type:"user",toolUseResult:{backgroundTaskId:"shellA"},
    message:{role:"user",content:[{type:"tool_result",tool_use_id:"tb1",content:"Command running in background with ID: shellA. Output is being written to: "+out+". You will be notified."}]}});
  const fg=JSON.stringify({timestamp:at(1200),type:"assistant",message:{role:"assistant",content:[
    {type:"tool_use",id:"tb2",name:"Bash",input:{command:"ls"}}]}});
  const done=JSON.stringify({type:"queue-operation",operation:"enqueue",timestamp:at(61000),
    content:"<task-notification> <task-id>shellA</task-id> <status>completed</status> <summary>Background command \"job\" completed (exit code 0)</summary> </task-notification>"});
  fs.writeFileSync(proj+"/"+sess+".jsonl",[spawn,res,fg,done].join("\n")+"\n");
' "$HOME/.claude/projects/$MANGLE" "$P7" "$POUT"
PROC=$(cc processes --session "$P7" --json 2>/dev/null)
ok "processes --json lists background shells"          "printf '%s' \"\$PROC\" | jq -e '(.processes|length)==1' >/dev/null"
ok "processes: a FOREGROUND Bash is not a process"     "printf '%s' \"\$PROC\" | jq -e '[.processes[]|select(.command==\"ls\")]|length==0' >/dev/null"
ok "processes: the shell carries command + runtime"    "printf '%s' \"\$PROC\" | jq -e '.processes[0].command==\"npm test\" and .processes[0].runtimeMs==60000' >/dev/null"
ok "processes: exit code read from the notification"   "printf '%s' \"\$PROC\" | jq -e '.processes[0].exitCode==0 and .processes[0].running==false' >/dev/null"
ok "processes: output volume is stat-ed"               "printf '%s' \"\$PROC\" | jq -e '.processes[0].outputBytes>0' >/dev/null"
ok "processes: summary headlines the tab"              "printf '%s' \"\$PROC\" | jq -e '.summary.total==1 and .summary.running==0' >/dev/null"

echo "════════ E2E 22: 0.8.7 live feed ════════"
# The feed tails whatever the clicked thing writes. Reuses the process fixture above ($P7 / shellA).
FEEDP=$(cc feed --kind process --id shellA --session "$P7" --json 2>/dev/null)
ok "feed: a process feed tails its output file"       "printf '%s' \"\$FEEDP\" | jq -e '[.entries[]|select(.kind==\"output\")]|length>=1' >/dev/null"
ok "feed: output rows carry no invented timestamp"    "printf '%s' \"\$FEEDP\" | jq -e '[.entries[]|select(.ts!=0)]|length==0' >/dev/null"
FEEDS=$(cc feed --session "$P7" --json 2>/dev/null)
ok "feed: the session feed lists its tool calls"      "printf '%s' \"\$FEEDS\" | jq -e '(.entries|length)>=1 and .ref.kind==\"session\"' >/dev/null"
ok "feed: a capped feed reports what it dropped"      "printf '%s' \"\$(cc feed --session \"$P7\" --limit 1 --json 2>/dev/null)\" | jq -e '(.entries|length)==1 and (.truncated>=0)' >/dev/null"
ok "feed: an unknown target is empty with a reason"   "printf '%s' \"\$(cc feed --kind agent --id nope --session \"$P7\" --json 2>/dev/null)\" | jq -e '(.entries|length)==0 and (.note|length)>0' >/dev/null"

echo "════════ E2E 19: demo simulator + guided tour (real pipeline end-to-end, strict attribution, no-residue lifecycle) ════════"
# The demo replays a scripted session through the REAL pipeline (transcript + captured edits + a
# subagent + a three-phase workflow + a second agent in a sibling worktree) in isolated demo-* sessions
# + folder — then every surface is asserted against it, including the ones that can ONLY show an empty
# state unless the scenario produces their data (deletions, failed calls, outside writes, processes).
# Finally the lifecycle (accept-all auto-clear, --clean) must leave zero residue, across both sessions.
DEMOWS="$WS/demo-e2e"; mkdir -p "$DEMOWS/.git"
DEMOJ=$( ( cd "$DEMOWS" && node "$CLI" demo --fast --json ) )
DSESS=$(printf '%s' "$DEMOJ" | jq -r '.session')
DSIB=$(printf '%s' "$DEMOJ" | jq -r '.sibling')
DSCRATCH=$(printf '%s' "$DEMOJ" | jq -r '.scratch')
ok "demo --fast --json reports its isolated session + workspace" "printf '%s' \"\$DEMOJ\" | jq -e '(.session|test(\"^demo-[0-9a-f]{8}$\")) and .edits==9 and .cancelled==false and (.workspace|endswith(\"observatory-demo\"))' >/dev/null"
ok "demo --fast --json reports the sibling agent + the scratch dir"    "printf '%s' \"\$DEMOJ\" | jq -e '(.sibling|test(\"^demo-[0-9a-f]{8}$\")) and (.scratch|length)>0' >/dev/null"
DCM=$( ( cd "$DEMOWS" && node "$CLI" changemap --session "$DSESS" --json ) )
ok "demo changemap: every edit is strictly attributed (no null taskId)" "printf '%s' \"\$DCM\" | jq -e '[.edits[] | select(.taskId==null)]|length==0' >/dev/null"
ok "demo changemap: six strict task identities"                         "printf '%s' \"\$DCM\" | jq -e '(.tasks|length)==6 and (has(\"subtasks\")|not)' >/dev/null"
ok "demo changemap: subagent edit attributed (rollupBySubagent)"       "printf '%s' \"\$DCM\" | jq -e '[.rollupBySubagent[] | select(.subagentId==\"demosub1\" and .edits==1)]|length==1' >/dev/null"
ok "demo changemap: workflow slice rolls up its run"                    "printf '%s' \"\$DCM\" | jq -e '.workflows[0] | .id==\"wf_demo\" and (.rollup.edits>=1)' >/dev/null"
ok "demo changemap: the outside-workspace write gets an (external) tile" "printf '%s' \"\$DCM\" | jq -e '[.modules[]|select(.label==\"(external)\")]|length==1' >/dev/null"
ok "demo changemap: features.py holds TWO independent review units"    "printf '%s' \"\$DCM\" | jq -e '[.edits[]|select(.file|endswith(\"features.py\"))]|length==2' >/dev/null"
DPR=$( ( cd "$DEMOWS" && node "$CLI" prompts --session "$DSESS" --json ) )
ok "prompts --json lists all THREE asks with their edit ids"           "printf '%s' \"\$DPR\" | jq -e '(.prompts|length)==3 and ([.prompts[]|select((.editIds|length)==0)]|length)==0' >/dev/null"
ok "prompts --json counts the failed tool call against its ask"        "printf '%s' \"\$DPR\" | jq -e '[.prompts[]|select(.errors>0)]|length==1' >/dev/null"
ok "the pre-0.8.8 'requests' verb is gone, with the usage text"        "! ( cd \"\$DEMOWS\" && node \"\$CLI\" requests --session \"\$DSESS\" --json ) >/dev/null 2>&1"
DMT=$( ( cd "$DEMOWS" && node "$CLI" multitask --session "$DSESS" --json ) )
# Never index agents[] positionally: listRepoSiblings sorts by transcript mtime, so the sibling can hold
# slot 0. Every assertion below selects on .self, the way both editors' renderers do.
ok "demo multitask: TWO agents — this session and the sibling worktree" "printf '%s' \"\$DMT\" | jq -e '(.agents|length)==2 and ([.agents[]|select(.self)]|length)==1' >/dev/null"
ok "demo multitask: the sibling reports its own branch"                "printf '%s' \"\$DMT\" | jq -e '[.agents[]|select(.self|not)][0].gitBranch==\"demo/hotfix\"' >/dev/null"
ok "demo multitask: one live file collision between them"              "printf '%s' \"\$DMT\" | jq -e '(.collisions|length)==1 and ((.collisions[0].agents|length)==2) and (.collisions[0].file|endswith(\"src/features.py\"))' >/dev/null"
ok "demo multitask: the self agent owns the subagent + the workflow"   "printf '%s' \"\$DMT\" | jq -e '([.agents[]|select(.self)][0].subagents|length)==1 and (.workflows[0].id==\"wf_demo\")' >/dev/null"
ok "demo multitask: the workflow run is multi-phase, multi-agent"      "printf '%s' \"\$DMT\" | jq -e '.workflows[0] | (.agents|length)==3 and ([.phaseGroups[].title]==[\"Outline\",\"Docs\",\"Review\"])' >/dev/null"
ok "demo multitask: subagent rows carry phaseConfidence (0.8.0)"       "printf '%s' \"\$DMT\" | jq -e '[.agents[]|select(.self)][0].subagents[0] | has(\"phaseConfidence\")' >/dev/null"
DPROC=$( ( cd "$DEMOWS" && node "$CLI" processes --session "$DSESS" --json ) )
ok "demo processes: three shells — running, exited 0, and failed"      "printf '%s' \"\$DPROC\" | jq -e '(.processes|length)==3 and .summary.running==1 and .summary.failed==1' >/dev/null"
# The finished demo leaves WORK IN FLIGHT, not only aftermath: a workflow still running with its last
# phase open, and a task still in progress. Both are what these panels exist to show.
ok "demo multitask: the workflow is still running, last phase open"    "printf '%s' \"\$DMT\" | jq -e '.workflows[0].running==true and ([.workflows[0].phaseGroups[]|select(.title==\"Review\")][0]|.done==0 and .total==1)' >/dev/null"
ok "demo multitask: exactly one task is still in progress"             "printf '%s' \"\$DMT\" | jq -e '[.tasks[]|select(.status==\"in_progress\")]|length==1' >/dev/null"
DRISK=$( ( cd "$DEMOWS" && node "$CLI" risk --session "$DSESS" --json ) )
ok "demo risk: a flagged command AND an outside-the-workspace write"   "printf '%s' \"\$DRISK\" | jq -e '.high>=1 and (.outsideWrites|length)==1 and (.outsideWrites[0].file|startswith(\"~/\"))' >/dev/null"
DACT=$( ( cd "$DEMOWS" && node "$CLI" actions --session "$DSESS" --json ) )
ok "demo actions: exactly one FAILED call, and it is not the last"     "printf '%s' \"\$DACT\" | jq -e '([.actions[]|select(.ok==false)]|length)==1 and (.actions[-1].ok!=false)' >/dev/null"
DTL=$( ( cd "$DEMOWS" && node "$CLI" tasklog --session "$DSESS" ) )
# FIVE, not six: the task log is edits-derived, and the sixth task is the one still in progress, which
# owns no edits. The change map reports six task IDENTITIES; this reports the tasks that produced work.
# The two numbers differing is the model being honest, not a drift.
ok "demo tasklog: one row per EDIT-PRODUCING task"                     "printf '%s' \"\$DTL\" | jq -e 'length==5 and ([.[]|select(.content==\"Validate the training dataset\")]|length)==1' >/dev/null"
DOBS=$( ( cd "$DEMOWS" && node "$CLI" observations --session "$DSESS" ) )
ok "demo observations: runs + reasoning + next steps"                  "printf '%s' \"\$DOBS\" | jq -e '(.runs|length)>=4 and ([.runs[].edits[]|select(.reasoning!=null)]|length)>=3 and (.nextSteps|length)>=1' >/dev/null"
# The guided tour's script — the SAME list both editors render, so the CLI is the contract for it.
DTOUR=$( ( cd "$DEMOWS" && node "$CLI" demo --tour --json ) )
ok "demo --tour --json emits the shared step list"                     "printf '%s' \"\$DTOUR\" | jq -e '(.steps|length)>=15 and ([.steps[].id]|unique|length)==(.steps|length)' >/dev/null"
ok "demo --tour covers every Overview tab"                             "printf '%s' \"\$DTOUR\" | jq -e '[.steps[]|select(.tab)|.tab]|unique|sort == [\"fleet\",\"processes\",\"sessions\",\"tasks\",\"workflows\"]' >/dev/null"
ok "demo --tour (text) is readable without a session"                  "( cd \"\$DEMOWS\" && node \"\$CLI\" demo --tour ) | grep -q 'Workers'"
# The prose renderer must print every field the editors render, or the printed tour is quietly a
# different, shorter tour than the driven one — the drift core owning the script exists to prevent.
DTIP=$( printf '%s' "$DTOUR" | jq -r '[.steps[]|select(.tip)][0].tip' )
ok "demo --tour (text) prints each step's tip, as both editors do"     "( cd \"\$DEMOWS\" && node \"\$CLI\" demo --tour ) | grep -qF \"\$DTIP\""
# Two tracks over ONE script: the short one must be a strict, order-preserving subset — a second list
# would let the two tours tell different stories about the same product.
DTOURE=$( ( cd "$DEMOWS" && node "$CLI" demo --tour --essentials --json ) )
ok "demo --tour --essentials is a SHORTER track"                       "printf '%s' \"\$DTOURE\" | jq -e '.track==\"essentials\" and (.steps|length)==.sizes.essentials and .sizes.essentials < .sizes.everything' >/dev/null"
DTOURR=$( ( cd "$DEMOWS" && node "$CLI" demo --tour --remainder --json ) )
ok "demo --tour --remainder is the exact complement of --essentials"   "[ \"\$(printf '%s' \"\$DTOURE\" \"\$DTOURR\" | jq -s -r '[.[0].steps[].id]+[.[1].steps[].id]|sort|join(\",\")')\" = \"\$(printf '%s' \"\$DTOUR\" | jq -r '[.steps[].id]|sort|join(\",\")')\" ]"
ok "the three track sizes add up"                                      "printf '%s' \"\$DTOURR\" | jq -e '.sizes.essentials + .sizes.remainder == .sizes.everything and (.steps|length)==.sizes.remainder' >/dev/null"
ok "--essentials and --remainder together is an error, not a guess"    "! ( cd \"\$DEMOWS\" && node \"\$CLI\" demo --tour --essentials --remainder ) >/dev/null 2>&1"
# Action steps: both labels present, well formed, and never doubled up with a tryIt line.
ok "demo --tour: action steps are well formed, both modes present"     "printf '%s' \"\$DTOUR\" | jq -e '([.steps[]|select(.action)]|length)>=4 and ([.steps[]|select(.action.mode==\"wait\")]|length)>=1 and ([.steps[]|select(.action.mode==\"auto\")]|length)>=1 and ([.steps[]|select(.action and .tryIt)]|length)==0 and ([.steps[]|select(.action and (.action.mode==\"auto\") and (.action.done|not))]|length)==0' >/dev/null"
ok "…and every step in it is in the full tour, in the same order"      "[ \"\$(printf '%s' \"\$DTOURE\" | jq -r '[.steps[].id]|join(\",\")')\" = \"\$(printf '%s' \"\$DTOUR\" | jq -r --argjson e \"\$(printf '%s' \"\$DTOURE\" | jq -c '[.steps[].id]')\" '[.steps[].id|select(. as \$i|\$e|index(\$i))]|join(\",\")')\" ]"
ok "demo --tour covers every shipped panel (Edits/Diffs trees are gone)" "printf '%s' \"\$DTOUR\" | jq -e '[.steps[].view]|unique|sort == [\"actions\",\"editor\",\"feed\",\"fileHistory\",\"observations\",\"overview\",\"prompts\",\"review\",\"stats\"]' >/dev/null"
# The heartbeat keeps a paced tour inside the fleet's 60s active window — mtime only, never a write.
DBYTES=$(wc -c < "$HOME/.claude/projects/$(printf '%s' "$DEMOWS" | sed 's/[^a-zA-Z0-9]/-/g')/$DSESS.jsonl")
ok "demo --touch bumps both transcripts and the workflow state"        "( cd \"\$DEMOWS\" && node \"\$CLI\" demo --touch --json ) | jq -e '([.touched[]|select(endswith(\".jsonl\"))]|length)==2 and ([.touched[]|select(endswith(\"wf_demo.json\"))]|length)==1' >/dev/null"
# The heartbeat must never touch anything under subagents/ — those files ARE watched by both editors, so
# bumping them would give a heartbeat driven by a refresh the very loop it exists to avoid.
ok "demo --touch leaves the watched subagent transcripts alone"        "( cd \"\$DEMOWS\" && node \"\$CLI\" demo --touch --json ) | jq -e '[.touched[]|select(contains(\"/subagents/\"))]|length==0' >/dev/null"
ok "demo --touch appends nothing (it is a touch, not a write)"         "[ \"\$(wc -c < \"\$HOME/.claude/projects/\$(printf '%s' \"\$DEMOWS\" | sed 's/[^a-zA-Z0-9]/-/g')/\$DSESS.jsonl\")\" = \"\$DBYTES\" ]"
# No-residue lifecycle: accepting everything auto-clears a demo session's store…
( cd "$DEMOWS" && node "$CLI" keep --all --session "$DSESS" ) >/dev/null
ok "demo accept-all leaves an EMPTY store (auto-clear, demo-only)"     "( cd \"\$DEMOWS\" && node \"\$CLI\" list --session \"\$DSESS\" --json ) | jq -e '.edits|length==0' >/dev/null"
ok "demo files stay on disk after accept (only the STORE clears)"      "[ -f \"\$DEMOWS/observatory-demo/docs/USAGE.md\" ]"
# …and --clean removes BOTH sessions, their stores, the marked workspace, and the scratch dir.
# A usage cursor is keyed by TRANSCRIPT PATH, so removeSession (which knows only the id) cannot reach
# it — deleting a transcript has to drop its cursor explicitly, or every demo run orphans two forever.
# Count the delta: other e2e sessions hold cursors of their own that must survive.
DCUR_BEFORE=$(ls -A "$HOME/.claude/claude-observatory/usage-cursors" 2>/dev/null | wc -l | tr -d ' ')
DCLEAN=$( ( cd "$DEMOWS" && node "$CLI" demo --clean --json ) )
DCUR_AFTER=$(ls -A "$HOME/.claude/claude-observatory/usage-cursors" 2>/dev/null | wc -l | tr -d ' ')
ok "demo --clean reports both sessions, the workspace and the scratch" "printf '%s' \"\$DCLEAN\" | jq -e '(.sessions|length)==2 and (.workspaces|length)==1 and (.scratch|length)==1' >/dev/null"
ok "demo --clean removes the demo session from sessions"               "( cd \"\$DEMOWS\" && node \"\$CLI\" sessions --json ) | jq -e '[.sessions[] | select(.id==\"'\$DSESS'\")]|length==0' >/dev/null"
ok "demo --clean removes the SIBLING session too"                      "[ ! -d \"\$HOME/.claude/claude-observatory/\$DSIB\" ]"
ok "demo --clean removes the workspace folder (marker-gated)"          "[ ! -d \"\$DEMOWS/observatory-demo\" ]"
ok "demo --clean removes the store dir"                                "[ ! -d \"\$HOME/.claude/claude-observatory/\$DSESS\" ]"
ok "demo --clean removes the outside-the-workspace scratch dir"        "[ ! -d \"\$DSCRATCH\" ]"
ok "demo --clean drops both demo usage cursors, keeping the others"    "[ \"\$DCUR_AFTER\" = \"\$((DCUR_BEFORE - 2))\" ]"

# --- §E2E 23: `views` batches read-only views into ONE process -------------------------------------
# The JetBrains plugin has no in-process core, so it spawned one CLI per view — eight per refresh tick,
# each paying node start-up and each re-deriving the same transcript parses from cold. `views` runs them
# together. The property that MATTERS is that batching cannot change an answer: every view must be
# byte-identical to its own command. (An early version stripped `--session` when `--views` was absent —
# `indexOf` returns -1 and the filter removed argument zero — so every view described a DIFFERENT session
# while looking perfectly plausible. That is what these pin.)
echo "════════ E2E 23: views batching must not change a single answer ════════"
# These separate processes must see the same phase/liveness inputs. Backdate the other fixtures
# well past the 10-second pending-tool and 5-minute idle thresholds, then keep the selected session
# fresh for the fleet's 60-second active window. Refreshing only the selected transcript left
# obsSess crossing working -> awaiting-permission between the batch and single macOS reads.
node -e '
  const fs=require("fs"), path=require("path"), stamp=(Date.now()-3600000)/1000;
  function walk(dir) {
    for (const e of fs.readdirSync(dir,{withFileTypes:true})) {
      const file=path.join(dir,e.name);
      if (e.isDirectory()) walk(file);
      else if (e.isFile() && e.name.endsWith(".jsonl")) fs.utimesSync(file,stamp,stamp);
    }
  }
  walk(process.argv[1]);
' "$HOME/.claude/projects"
touch "$HOME/.claude/projects/$MANGLE/$SESSION.jsonl"
VJ=$( cc views --session "$SESSION" --root "$WS" --json )
# Non-empty FIRST: without this the comparisons below pass when both sides fail, which is how the first
# version of this section reported four green ticks against two empty strings.
ok "views emits a non-empty object keyed by view"                      "printf '%s' \"\$VJ\" | jq -e 'type==\"object\" and (keys|length)>=6' >/dev/null"
# EVERY default view, not a sample: the architecture doc's "byte-identical, pinned by e2e" claim is only
# true if all eight are actually pinned, and the four that used to be left out (multitask, observations,
# risk, egress) are exactly the ones no other section touches.
for v in changemap multitask prompts processes sessions observations risk egress; do
  ONE=$( cc $v --session "$SESSION" --root "$WS" --json | jq -cS . )
  BAT=$( printf '%s' "$VJ" | jq -cS ".$v" )
  ok "$v: the single command answers at all"                           "[ -n \"\$ONE\" ] && [ \"\$ONE\" != null ]"
  ok "views.$v is byte-identical to \`$v --json\`"                     "[ \"\$ONE\" = \"\$BAT\" ]"
done
# `feed` and `list` are batchable but NOT in the default set, so the loop above cannot cover them. They
# were absent from the allow-list entirely: asking for either fell through to the unknown-view throw and
# was swallowed into a null, so a caller batching them got a silently empty pane instead of an error.
for v in feed list; do
  ONE=$( cc $v --session "$SESSION" --root "$WS" --json | jq -cS . )
  BAT=$( cc views --views $v --session "$SESSION" --root "$WS" --json | jq -cS ".$v" )
  ok "$v: batchable, and not null"                                     "[ -n \"\$BAT\" ] && [ \"\$BAT\" != null ]"
  ok "views.$v is byte-identical to \`$v --json\`"                     "[ \"\$ONE\" = \"\$BAT\" ]"
done
ok "views --views picks a subset, and only that subset"                "cc views --views prompts,sessions --session \"\$SESSION\" --root \"\$WS\" --json | jq -e 'keys==[\"prompts\",\"sessions\"]' >/dev/null"
ok "an unknown view is null, never fatal to the batch"                 "cc views --views prompts,nope --session \"\$SESSION\" --root \"\$WS\" --json | jq -e '.nope==null and (.prompts|type)==\"object\"' >/dev/null"
ok "views will not batch a MUTATING command"                           "cc views --views keep --session \"\$SESSION\" --root \"\$WS\" --json | jq -e '.keep==null' >/dev/null"

echo "════════ E2E 24: 0.10.0 rewind — undo/redo --from-prompt ════════"
# The boundary is "this ask and everything after it", so the fixture needs edits on BOTH sides of an ask.
# Capture stamps its own ts, so the edits are made first and the asks are then written to bracket them —
# the only way to get a deterministic boundary without hand-writing store records.
RW=rewind010
: > "$HOME/.claude/projects/$MANGLE/$RW.jsonl"
RF1="$WS/rw-one.txt"; RF2="$WS/rw-two.txt"
printf 'keep-me\n' > "$RF1"; printf 'revert-me\n' > "$RF2"
hookR(){ printf '{"session_id":"%s","cwd":"%s","hook_event_name":"%s","tool_name":"Edit","tool_input":{"file_path":"%s"}}' "$RW" "$WS" "$1" "$2" | node "$CAPTURE"; }
hookR PreToolUse "$RF1"; printf 'edited-one\n' > "$RF1"; hookR PostToolUse "$RF1"   # #1
hookR PreToolUse "$RF2"; printf 'edited-two\n' > "$RF2"; hookR PostToolUse "$RF2"   # #2
RTS=$(cc timeline --session "$RW" --json | jq -r '[.edits[]|.ts]|sort|@tsv')
RT1=$(printf '%s' "$RTS" | cut -f1); RT2=$(printf '%s' "$RTS" | cut -f2)
node -e '
  const fs=require("fs");
  const [proj, sess, t1, t2]=process.argv.slice(1);
  const ask=(ms,text)=>JSON.stringify({timestamp:new Date(Number(ms)).toISOString(),type:"user",message:{role:"user",content:text}});
  fs.writeFileSync(proj+"/"+sess+".jsonl",[ask(Number(t1)-1,"first ask"),ask(Number(t2)-1,"second ask")].join("\n")+"\n");
' "$HOME/.claude/projects/$MANGLE" "$RW" "$RT1" "$RT2"
ok "the fixture really splits into two asks owning one edit each" "cc prompts --session \"\$RW\" --json | jq -e '(.prompts|length)==2 and ([.prompts[]|select((.editIds|length)==1)]|length)==2' >/dev/null"
# The preflight a confirmation dialog is built from: it must COUNT without touching disk, or the two
# editors cannot state the same numbers before the user commits to the rewind.
RWD=$(cc undo --from-prompt 2 --dry-run --session "$RW" --json)
ok "undo --from-prompt --dry-run counts the scope"       "printf '%s' \"\$RWD\" | jq -e '.dryRun==true and .pending==1 and .units==1 and (.files|length)==1 and (.ids|length)==1' >/dev/null"
ok "…and reverts NOTHING (the file is untouched)"        "grep -qx 'edited-two' '$RF2'"
ok "…and leaves the edit pending"                        "cc list --pending --session \"\$RW\" --json | jq -e '[.edits[].id]|length==2' >/dev/null"
# An IGNORED --dry-run performs the mutation it was meant to preview, so every path that cannot preview
# must refuse it rather than drop it. The positional-id form is the dangerous one: it skips the scope branch.
ok "--dry-run is refused where it would mean nothing"    "! cc undo --all --dry-run --session \"\$RW\" --json >/dev/null 2>&1"
ok "undo <id> --dry-run refuses instead of undoing"      "! cc undo 1 --dry-run --session \"\$RW\" >/dev/null 2>&1 && cc list --pending --session \"\$RW\" --json | jq -e '[.edits[].id]|length==2' >/dev/null"
ok "redo/keep --dry-run refuse too"                      "! cc redo --all --dry-run --session \"\$RW\" >/dev/null 2>&1 && ! cc keep --all --dry-run --session \"\$RW\" >/dev/null 2>&1"
# `clean` is the same trap on the most expensive verb in the product. --dry-run IS real on
# `clean --completed`, which is exactly why a reader tries it on a sibling scope; before the guard,
# `clean --all --dry-run` deleted every session in the store and printed "✓ dropped all N session(s)".
ok "clean --all --dry-run refuses instead of wiping the store" "! cc clean --all --dry-run >/dev/null 2>&1 && [ -d \"\$STORE/\$RW\" ] && cc list --pending --session \"\$RW\" --json | jq -e '[.edits[].id]|length==2' >/dev/null"
ok "…and so do its other destructive scopes"                   "! cc clean --older-than 1d --dry-run >/dev/null 2>&1 && ! cc clean --drop \"\$RW\" --dry-run >/dev/null 2>&1 && [ -d \"\$STORE/\$RW\" ]"
# The positive control: the one scope that genuinely previews still does, or the guard above would be
# indistinguishable from "--dry-run was removed from clean".
ok "clean --completed --dry-run still previews without dropping" "cc clean --completed --dry-run --json | jq -e '.dryRun==true and (.dropped|length)==0' >/dev/null && [ -d \"\$STORE/\$RW\" ]"
# A flag VALUE is never an edit id: `keep --from-prompt 2` must not quietly keep edit #2.
ok "a flag value is never read as an edit id"            "! cc keep --from-prompt 2 --session \"\$RW\" >/dev/null 2>&1 || cc list --pending --session \"\$RW\" --json | jq -e '[.edits[].id]|length==2' >/dev/null"
RWJ=$(cc undo --from-prompt 2 --session "$RW" --json)
ok "undo --from-prompt reverts the later ask only"      "printf '%s' \"\$RWJ\" | jq -e '.undone==1 and .total==1' >/dev/null"
ok "undo --from-prompt --json names WHICH edits reverted" "printf '%s' \"\$RWJ\" | jq -e '(.ids|type)==\"array\" and (.ids|length)==1' >/dev/null"
ok "…and reports review units beside raw records"      "printf '%s' \"\$RWJ\" | jq -e '.units==1' >/dev/null"
ok "the later ask's file is back to its original"      "grep -qx 'revert-me' '$RF2'"
ok "the earlier ask's file is untouched"               "grep -qx 'edited-one' '$RF1'"
RWR=$(cc redo --from-prompt 2 --session "$RW" --json)
ok "redo --from-prompt re-applies that window's undone edits" "printf '%s' \"\$RWR\" | jq -e '.redone==1 and (.ids|length)==1' >/dev/null"
ok "the file is re-applied"                            "grep -qx 'edited-two' '$RF2'"
# `redo --from-prompt` is the prompt's WINDOW, not "exactly what that rewind reverted", and the difference
# destroys work: checkpointScope answers with every record in the window whatever its status, so an edit
# rejected BEFORE the rewind is undone-and-in-window and comes back. Both editors' Redo buttons avoid this
# by passing the rewind's own `ids`. Pinned here so the help text and the docs cannot drift back to the
# stronger claim they used to make.
cc undo 1 --session "$RW" >/dev/null                   # a deliberate rejection, before any rewind
ok "the pre-rewind rejection is reverted on disk"      "grep -qx 'keep-me' '$RF1'"
RWX=$(cc undo --from-prompt 2 --session "$RW" --json)
ok "the rewind moves only the still-pending edit"      "printf '%s' \"\$RWX\" | jq -e '.undone==1 and .ids==[2]' >/dev/null"
RWY=$(cc redo --from-prompt 1 --session "$RW" --json)
ok "redo --from-prompt re-applies the REJECTED edit too" "printf '%s' \"\$RWY\" | jq -e '.redone==2 and .ids==[1,2]' >/dev/null"
ok "…so the rejected edit is back on disk (documented)" "grep -qx 'edited-one' '$RF1'"
ok "rewinding from ask 1 covers BOTH asks"             "cc undo --from-prompt 1 --session \"\$RW\" --json | jq -e '.undone==2' >/dev/null"
ok "an unknown prompt id fails loudly (exit 1)"        "! cc undo --from-prompt nope --session \"\$RW\" --json >/dev/null 2>&1"
ok "a missing --from-prompt value fails"               "! cc undo --from-prompt --session \"\$RW\" --json >/dev/null 2>&1"
ok "--from-prompt refuses to share with another scope" "! cc undo --from-prompt 1 --all --session \"\$RW\" --json >/dev/null 2>&1"
ok "a real prompt with nothing pending is an honest zero, not an error" "cc undo --from-prompt 2 --session \"\$RW\" --json | jq -e '.undone==0 and .total==0' >/dev/null"

# `pending` and `units` are two different counts of the same set, and a confirmation dialog prints BOTH.
# They only disagree when a same-code chain collapses, so this needs its OWN session: chaining inside the
# fixture above would empty window 1's editIds and break its boundary assertions.
RC=rewind010chain
: > "$HOME/.claude/projects/$MANGLE/$RC.jsonl"
RCF="$WS/rw-chain.txt"; printf 'L1\nA\nL3\n' > "$RCF"
hookC(){ printf '{"session_id":"%s","cwd":"%s","hook_event_name":"%s","tool_name":"Edit","tool_input":{"file_path":"%s"}}' "$RC" "$WS" "$1" "$2" | node "$CAPTURE"; }
hookC PreToolUse "$RCF"; printf 'L1\nB\nL3\n' > "$RCF"; hookC PostToolUse "$RCF"   # #1
hookC PreToolUse "$RCF"; printf 'L1\nC\nL3\n' > "$RCF"; hookC PostToolUse "$RCF"   # #2 — same line, chains with #1
RCT=$(cc timeline --session "$RC" --json | jq -r '[.edits[].ts]|min')
node -e '
  const fs=require("fs");
  const [proj, sess, t]=process.argv.slice(1);
  fs.writeFileSync(proj+"/"+sess+".jsonl",
    JSON.stringify({timestamp:new Date(Number(t)-1).toISOString(),type:"user",message:{role:"user",content:"one ask"}})+"\n");
' "$HOME/.claude/projects/$MANGLE" "$RC" "$RCT"
ok "two chained edits collapse to ONE review unit"     "cc list --pending --session \"\$RC\" --json | jq -e '(.edits|length)==1' >/dev/null"
ok "the rewind counts BOTH: 2 raw records, 1 unit"     "cc undo --from-prompt 1 --dry-run --session \"\$RC\" --json | jq -e '.pending==2 and .units==1' >/dev/null"

echo "════════ E2E 25: tui renders headlessly ════════"
# The only tui assertion CI can make. An Actions runner's stdout is not a TTY, so raw mode, the
# alternate screen and the exit guard are UNTESTABLE here — a green job is not TTY coverage, and the
# interactive path has to be exercised by hand. What this does pin is that the non-interactive path
# produces a real frame instead of crashing on `columns === undefined`, and exits 0.
DASH=$( cc tui --once --cols 96 --rows 14 --no-color --session "$SESSION" --root "$WS" --tab review )
ok "tui --once exits 0 and prints exactly its height"  "[ \"\$(printf '%s\n' \"\$DASH\" | wc -l | tr -d ' ')\" = 14 ]"
ok "tui --once emits no escapes under --no-color"      "! printf '%s' \"\$DASH\" | grep -q \$'\\033'"
# Measured with the product's own display-width ruler, not awk's `length`: awk counts bytes, so a
# 4-byte emoji occupying 2 columns reads as 4 and the check fails on a correct frame. That ruler is
# itself pinned by unit tests against known widths, so this is not circular.
ok "tui --once holds the column budget"                "printf '%s\n' \"\$DASH\" | node -e \"const c=require('\$REPO/packages/tui/dist/index.js');const ls=require('fs').readFileSync(0,'utf8').split('\\n');const bad=ls.filter(l=>c.displayWidth(l)>96);if(bad.length){console.error('over budget: '+bad.length);process.exit(1)}\""
# The window bar names all five windows at EVERY size — a minimized window keeps its chip, its jump
# key and its counter, so the reader can always see what exists and press a key for it.
#
# Checked against the BAR ROW, not the whole frame. Grepping the frame passed against a bar that had
# dropped every chip, because the same words appear in the blocked-size status line underneath: the
# check reported healthy for precisely the failure it existed to catch.
BAR=$( printf '%s\n' "$DASH" | grep -E 'F2.+Prompts' )
ok "review names its four panes even when they cannot all fit" "printf '%s' \"\$BAR\" | grep -qE 'F2 .Prompts.*F3 .Traces.*F4 .Map.*F5 .Diff'"

ok "and says what a window it cannot open would cost"  "printf '%s' \"\$DASH\" | grep -qE 'needs [0-9]+ (cols|body rows)'"
# The keys row must not advertise a key the runtime does not answer. `j`/`k` are gone; arrows moved in.
ok "the key row advertises arrows, not j/k"             "printf '%s\n' \"\$DASH\" | tail -1 | grep -q '↑↓' && ! printf '%s\n' \"\$DASH\" | tail -1 | grep -q 'j/k'"
# The product's front door is the app: a bare invocation, or one carrying only flags, opens the
# dashboard rather than printing help or erroring on a leading flag it would read as a command.
ok "a bare invocation opens the app, not usage"         "cc --root \"\$WS\" --no-color | grep -q 'Sessions'"
ok "flags alone still open it"                          "cc --root \"\$WS\" --session \"\$SESSION\" --no-color | grep -q 'Sessions'"
# `diff --patch` is what the dashboard parses. The human trailer is not diff, and it rendered as a
# context row at the foot of every edit until the flag existed.
# `grep -qv` was a tautology: it exits 0 as soon as ANY line fails to match, so it passed for output
# that was not a patch at all. Assert the output IS one — a hunk header — and that the human trailer is
# absent, which are the two separate claims this check exists to make.
ok "diff --patch emits a real patch"                    "cc diff 1 --patch --session \"\$SESSION\" | grep -qE '^@@ '"
ok "…and nothing but the patch"                          "! cc diff 1 --patch --session \"\$SESSION\" | grep -q 'keep #1 · undo #1'"
ok "…and plain diff still prints the trailer for a human" "cc diff 1 --session \"\$SESSION\" | grep -q 'keep #1 · undo #1'"
# …but the two questions still answer for themselves, or every script and doc changes meaning.
# The INTERACTIVE first frame. `--once` renders directly and never calls `paint`, so it cannot catch
# an error thrown while drawing frame one — which is how a temporal-dead-zone crash reached a user.
# Its 60-second usage poll also kicks the Remote Control titles refresh (claimed, then detached). Clear
# what earlier `usage` calls left so the claim this checks can only be the paint's.
RT="$HOME/.claude/claude-observatory/remote-cache/session-titles.json"
rm -f "$RT" "$RT.kick"
ok "the interactive path boots and paints"       "cd \"$WS\" && node \"$REPO/test/tty-boot.js\" \"$REPO/packages/cli/dist/index.js\""
ok "…and its first poll claims a Remote Control titles refresh" "[ -f \"$RT.kick\" ]"
# …and then it is DRIVEN. `--once` never installs a key handler and tty-boot only proves frame one
# does not throw, so neither presses a key — which is how five separate keys shipped bound to a string
# the decoder never emits. This one sends real bytes and reads the frame that comes back.
# …and an accept SURVIVES the read that was already running when it happened. Both halves take about
# the same time on a fixture, so this one deliberately slows the read: on a real session the read is
# ~11s and the write ~90ms, and a reader watched their accepted rows come back.
ok "an accept is not clobbered by a read that predates it" "cd \"$WS\" && node \"$REPO/test/stale-read-race.js\" \"$REPO/packages/cli/dist/index.js\""

ok "--help still prints usage"                          "cc --help | grep -qi 'per-edit Keep/Undo'"
ok "--version still prints a version"                   "cc --version | grep -qE '[0-9]+\\.[0-9]+\\.[0-9]+'"
ok "a named verb still dispatches"                      "cc status | grep -qi 'capture hooks'"
ok "an unknown verb still fails loudly"                 "! cc definitely-not-a-verb >/dev/null 2>&1"

echo "════════ E2E 26: .observatoryignore ════════"
# The whole feature end to end, through the real binary, in a scratch tree: a hide rule, a refuse
# rule, and the gitignore gotcha that a negation cannot reach into an excluded directory.
#
# `cc` runs from $WS in its own subshell, so a `cd` in front of it does nothing — the first draft of
# this block "passed" three checks that were really running in the wrong tree and reporting SHOWN for
# everything. `ccin` takes the directory, because the whole feature is about the cwd's own files.
ccin(){ ( cd "$1" && shift && node "$CLI" "$@" ); }
IGW=$(mktemp -d); mkdir -p "$IGW/dist" "$IGW/src"
printf 'package-lock.json\ndist/\n!dist/manifest.json\n\n# capture: off\n**/*.mp4\n' > "$IGW/.observatoryignore"
ok "a rule reports IGNORED, naming its file and line"       "ccin \"\$IGW\" ignore --check package-lock.json | grep -q ignored && ccin \"\$IGW\" ignore --check package-lock.json | grep -q '.observatoryignore:1'"
# '# capture: off' is an ordinary comment again — the pattern under it is ignored by its own rule, and
# the comment decides nothing. One mode: everything a rule matches is simply never recorded.
ok "a '# capture:' comment decides nothing on its own"      "ccin \"\$IGW\" ignore --check clip.mp4 | grep -q ignored"
ok "…and warns that an ignored path has nothing to undo"    "ccin \"\$IGW\" ignore --check clip.mp4 | grep -q 'nothing to undo'"
ok "an uncovered path reports SHOWN"                        "ccin \"\$IGW\" ignore --check src/app.ts | grep -q shown"
# The famous gitignore gotcha, diagnosed rather than left as a mystery: `dist/` excludes the
# directory, so the `!dist/manifest.json` below it can never take effect.
ok "an excluded ANCESTOR is named as the cause"             "ccin \"\$IGW\" ignore --check dist/manifest.json | grep -q ANCESTOR"
ok "…and the working form is suggested"                     "ccin \"\$IGW\" ignore --check dist/manifest.json | grep -q 'dist/\\*'"
ok "--json carries the deciding rule and its source"        "ccin \"\$IGW\" ignore --check dist/manifest.json --json | jq -e '.paths[0].mode==\"ignored\" and .paths[0].rule.pattern==\"dist/\" and (.paths[0].rule.line|type)==\"number\"' >/dev/null"
# The array shape is the point: the verb takes many paths, like git check-ignore, so one path is just
# a list of one rather than a different response.
ok "--json answers for EVERY path given, in order"          "ccin \"\$IGW\" ignore --check dist/bundle.js src/app.ts --json | jq -e '(.paths|length)==2 and .paths[0].mode==\"ignored\" and .paths[1].mode==\"shown\"' >/dev/null"
# The negative, with a positive control beside it: no ignore file anywhere means nothing is hidden,
# and the very same probe DOES fire once a file exists.
IGN=$(mktemp -d)
ok "with no ignore file, a path reports SHOWN"              "ccin \"\$IGN\" ignore --check any.ts | grep -q shown"
ok "positive control: adding one changes that answer"       "printf 'any.ts\\n' > \"\$IGN/.observatoryignore\" && ccin \"\$IGN\" ignore --check any.ts | grep -q ignored"
ok "the bare verb explains itself when nothing is in play"  "rm \"\$IGN/.observatoryignore\" && ccin \"\$IGN\" ignore --session \"\$SESSION\" | grep -q 'no .observatoryignore in play'"
rm -rf "$IGW" "$IGN"

echo "════════ E2E 27: .observatoryignore matches real git, pattern for pattern ════════"
# A DIFFERENTIAL test against the actual `git check-ignore`, not against our own idea of what git
# does. The matcher is hand-rolled (no glob dependency is allowed here), and hand-rolled gitignores
# are exactly where the edge cases rot: `**` spanning segments, a negation that re-includes a
# DIRECTORY, character classes, an escaped literal `!`. Writing the same rules into .gitignore and
# .observatoryignore and diffing the two tools' verbose output pins every one of them at once.
GITW=$(mktemp -d)
( cd "$GITW" && git init -q . ) 2>/dev/null
if [ -d "$GITW/.git" ]; then
  mkdir -p "$GITW/dist" "$GITW/src" "$GITW/pkg/core/dist" "$GITW/pkg/web/dist" "$GITW/deep/nested" "$GITW/build/keep"
  IGRULES='package-lock.json
dist/
!dist/manifest.json
pkg/*/dist/
!pkg/core/dist/
*.log
!keep.log
build/**
!build/keep/
deep/**/*.tmp
[abc].txt
\!lit.txt'
  printf '%s\n' "$IGRULES" > "$GITW/.gitignore"
  printf '%s\n' "$IGRULES" > "$GITW/.observatoryignore"
  ( cd "$GITW" && touch dist/manifest.json dist/bundle.js src/app.ts pkg/core/dist/i.js pkg/web/dist/i.js \
      a.log keep.log package-lock.json deep/nested/x.tmp build/x.js build/keep/y.js a.txt d.txt '!lit.txt' )
  IGPATHS="dist/manifest.json dist/bundle.js src/app.ts pkg/core/dist/i.js pkg/web/dist/i.js a.log keep.log package-lock.json deep/nested/x.tmp build/x.js build/keep/y.js a.txt d.txt !lit.txt"
  # `-v -n` is git's machine format: <source>:<linenum>:<pattern><TAB><pathname>, with every field but
  # the pathname empty for a non-match. Only the source FILENAME differs between the two tools.
  ok "verbose output is byte-identical to git check-ignore -v -n" \
     "diff <( cd \"\$GITW\" && git check-ignore -v -n \$(echo \$IGPATHS) ) <( cd \"\$GITW\" && node \"\$CLI\" ignore -v -n --check \$(echo \$IGPATHS) | sed 's/^\\.observatoryignore:/.gitignore:/' ) >/dev/null"
  ok "exit 0 when a path is ignored (git's contract)"  "( cd \"\$GITW\" && node \"\$CLI\" ignore -q --check dist/bundle.js )"
  ok "exit 1 when none are"                            "! ( cd \"\$GITW\" && node \"\$CLI\" ignore -q --check src/app.ts )"
  ok "--stdin reads paths the way git does"            "( cd \"\$GITW\" && printf 'dist/bundle.js\\nsrc/app.ts\\n' | node \"\$CLI\" ignore --stdin -v -n --check | grep -q 'dist/bundle.js' )"
  ok "-z separates with NULs, not colons and tabs"     "( cd \"\$GITW\" && node \"\$CLI\" ignore -v -z --check dist/bundle.js | tr '\\0' '~' | grep -q '\\.observatoryignore~2~dist/~dist/bundle.js~' )"
else
  echo "  ·  skipped — git could not create a scratch repo here"
fi
rm -rf "$GITW"

echo "════════ E2E 28: every view answers for the SESSION's workspace, not the terminal's ════════"
# The class of bug this exists for, in one sentence: a dashboard opened OUTSIDE the workspace showed an
# empty Fleet, empty Prompts and untitled sessions, with no error anywhere — because those views are
# transcript-derived, a transcript is found under the mangled LAUNCH cwd, and they read `process.cwd()`
# instead of the `--root` they were given. `changemap`, `multitask` and `observations` honoured it;
# `prompts`, `feed`, `risk`, `egress` and `processes` did not; and a shared `noTranscript()` guard
# ignored it for all of them, short-circuiting before any caller's own root could matter.
#
# Asserted as an EQUIVALENCE — the same query from a foreign directory must answer exactly what it
# answers from inside the workspace — because that is the property, and it holds for every view at once
# rather than for the handful anyone remembers to re-check by hand.
FOREIGN="$(mktemp -d)"
# Push every transcript OUT of the fleet-liveness window (FLEET_ACTIVE_MS = 60s) first. A sibling's
# `active` is `now - mtime <= 60s`, so a transcript sitting near that boundary answers `true` for the
# first call and `false` for the second — the two payloads then differ for a reason that has nothing
# to do with `--root`, which is the only thing this loop is asserting. It bit on Linux CI, where
# `views multitask` takes tens of seconds and the pair straddles the edge.
find "$HOME/.claude/projects" -name '*.jsonl' -exec touch -t 202607250000 {} + 2>/dev/null || true
for v in multitask prompts changemap observations processes risk egress feed sessions; do
  inside="$( cd "$WS" && node "$CLI" views --views "$v" --json --session "$SESSION" 2>/dev/null )"
  outside="$( cd "$FOREIGN" && node "$CLI" views --views "$v" --json --session "$SESSION" --root "$WS" 2>/dev/null )"
  ok "views --root answers identically for \`$v\` from outside the workspace" \
     "[ -n \"\$inside\" ] && [ \"\$inside\" = \"\$outside\" ]"
done
# …and the positive control: WITHOUT --root from the same foreign directory, the transcript-derived
# views must differ. Without this the equivalence above would also pass if --root did nothing at all.
bare="$( cd "$FOREIGN" && node "$CLI" views --views prompts --json --session "$SESSION" 2>/dev/null )"
inside_prompts="$( cd "$WS" && node "$CLI" views --views prompts --json --session "$SESSION" 2>/dev/null )"
ok "positive control: without --root the same query does NOT find the transcript" \
   "[ \"\$bare\" != \"\$inside_prompts\" ]"
rm -rf "$FOREIGN"


echo "════════ E2E 29: review — the session's units, with --prompt scoping to one ask ════════"
# A dedicated workspace + transcript: the ask boundary is what decides which units belong to which
# prompt, so this needs a real conversation beside the store rather than the shared fixture.
RVW="$(cd "$(mktemp -d)" && pwd -P)"; RVS="rvw-0000000000000001"   # canonical path (see $TMP above)
mkdir -p "$RVW"
node -e '
const core = require(process.argv[1]), fs = require("fs"), path = require("path");
const cwd = fs.realpathSync(process.argv[2]), S = process.argv[3];
const proj = core.projectDir(cwd); fs.mkdirSync(proj, { recursive: true });
const ask = (ts, t) => JSON.stringify({ timestamp: new Date(ts).toISOString(), type: "user", message: { role: "user", content: t } });
fs.writeFileSync(path.join(proj, S + ".jsonl"), ask(500, "tighten the parser") + "\n" + ask(3500, "now the tests") + "\n");
core.ensureStore(S);
const F = path.join(cwd, "parser.py"), G = path.join(cwd, "test_parser.py");
const mk = (f, b, a, ts) => core.appendLog(S, { ts, tool: "Edit", file: f, beforeBlob: core.writeBlob(S, Buffer.from(b)), afterBlob: core.writeBlob(S, Buffer.from(a)), status: "pending" });
mk(F, "def p():\n    return 0\n", "def p():\n    return 1\n", 1000);
mk(F, "def p():\n    return 1\n", "def p():\n    return 2\n", 2000);
mk(G, "assert p()==0\n", "assert p()==2\n", 4000);
fs.writeFileSync(F, "def p():\n    return 2\n"); fs.writeFileSync(G, "assert p()==2\n");
' "$CORE" "$RVW" "$RVS"
rv(){ ( cd "$RVW" && node "$CLI" review --session "$RVS" --root "$RVW" "$@" ); }
RJ="$(rv --prompt 1 --json)"
ok "review --prompt lists that ask's units"            "printf '%s' \"\$RJ\" | jq -e '.units|length == 1' >/dev/null"
ok "…two edits to one line are ONE unit"               "printf '%s' \"\$RJ\" | jq -e '.units[0].members|length == 2' >/dev/null"
ok "…whose patch is the NET change, not the steps"     "printf '%s' \"\$RJ\" | jq -e '.units[0].patch | test(\"return 0\") and test(\"return 2\") and (test(\"return 1\")|not)' >/dev/null"
ok "…and its delta is not double-counted"              "printf '%s' \"\$RJ\" | jq -e '.summary.added == 1 and .summary.removed == 1' >/dev/null"
ok "ids are RAW and group-expanded, for keep/undo"     "printf '%s' \"\$RJ\" | jq -e '.ids == [1,2]' >/dev/null"
RJ2="$(rv --prompt 2 --json)"
ok "a unit never crosses an ask boundary"              "printf '%s' \"\$RJ2\" | jq -e '(.units|length) == 1 and (.units[0].rel|endswith(\"test_parser.py\"))' >/dev/null"
ok "--no-patch answers without the diff bodies"        "printf '%s' \"\$(rv --prompt 1 --no-patch --json)\" | jq -e '.units[0]|has(\"patch\")|not' >/dev/null"
ok "an unknown prompt fails loudly, not emptily"       "! rv --prompt 99 --json >/dev/null 2>&1"
# Without --prompt the answer is the WHOLE session — the Review tab's default view: every unit
# across both asks, a null prompt, and the same group-expanded id set the scoped calls partition.
RJA="$(rv --json --no-patch)"
ok "review without --prompt answers the whole session" "printf '%s' \"\$RJA\" | jq -e '.prompt == null and (.units|length) == 2' >/dev/null"
ok "…with the session-wide group-expanded id set"      "printf '%s' \"\$RJA\" | jq -e '.ids == [1,2,3]' >/dev/null"
# --pending — the Review tabs' filter: a resolved unit leaves the list AND the id set; without the
# flag it still answers (the control that proves the filter, not the fixture, shrank the list).
( cd "$RVW" && node "$CLI" keep 3 --session "$RVS" ) >/dev/null
RJP="$(rv --json --no-patch --pending)"
ok "review --pending hides the resolved unit"          "printf '%s' \"\$RJP\" | jq -e '(.units|length) == 1 and .units[0].members == [1,2] and .ids == [1,2]' >/dev/null"
ok "…and without the flag both units still answer"     "printf '%s' \"\$(rv --json --no-patch)\" | jq -e '(.units|length) == 2' >/dev/null"
# A chain that CANCELS OUT — a file created then deleted — is not a row at all: it rides `cancelled`
# with the ids that dismiss it, so nothing is silently dropped and nobody is asked to decide about a
# file that no longer exists and never did. (Added last: it changes this fixture's id set.)
node -e '
const core = require(process.argv[1]), fs = require("fs"), path = require("path");
const cwd = fs.realpathSync(process.argv[2]), S = process.argv[3];
const G = path.join(cwd, "ghost.txt");
core.appendLog(S, { ts: 4500, tool: "Write", file: G, beforeBlob: null, afterBlob: core.writeBlob(S, Buffer.from("tmp\n")), status: "pending" });
core.appendLog(S, { ts: 4600, tool: "Edit",  file: G, beforeBlob: core.writeBlob(S, Buffer.from("tmp\n")), afterBlob: null, status: "pending" });
' "$CORE" "$RVW" "$RVS"
RJC="$(rv --json --no-patch)"
ok "a cancelled-out chain is NOT a review row"          "printf '%s' \"\$RJC\" | jq -e '(.units|map(.rel)|index(\"ghost.txt\")) == null' >/dev/null"
ok "…it rides cancelled, with the ids that dismiss it" "printf '%s' \"\$RJC\" | jq -e '.summary.cancelled == 1 and (.cancelled|length) == 1 and .cancelledIds == [4,5]' >/dev/null"
ok "…and the scope's id set still covers it"            "printf '%s' \"\$RJC\" | jq -e '(.ids|index(4)) != null and (.ids|index(5)) != null' >/dev/null"
ok "list --json marks it for the terminal's footer"     "( cd \"\$RVW\" && node \"\$CLI\" list --json --session \"\$RVS\" ) | jq -e '[.edits[]|select(.cancelled == true)]|length == 1' >/dev/null"
rm -rf "$RVW"

echo "════════ E2E 30: a 3-member unit reverts in ONE call ════════"
# undoGroup sums the unit's chain into its net blob pair — one merge, one status batch. Three chained
# same-line edits are the smallest unit where the old member-by-member walk did extra work.
U3W="$(cd "$(mktemp -d)" && pwd -P)"; U3S="u3-0000000000000001"
node -e '
const core = require(process.argv[1]), fs = require("fs"), path = require("path");
const cwd = fs.realpathSync(process.argv[2]), S = process.argv[3];
core.ensureStore(S);
const F = path.join(cwd, "three.txt");
const mk = (b, a, ts) => core.appendLog(S, { ts, tool: "Edit", file: F, beforeBlob: core.writeBlob(S, Buffer.from(b)), afterBlob: core.writeBlob(S, Buffer.from(a)), status: "pending" });
mk("L1\nA\nL3\n", "L1\nB\nL3\n", 1000);
mk("L1\nB\nL3\n", "L1\nC\nL3\n", 2000);
mk("L1\nC\nL3\n", "L1\nD\nL3\n", 3000);
fs.writeFileSync(F, "L1\nD\nL3\n");
' "$CORE" "$U3W" "$U3S"
# `diff` on a unit REP renders the unit's whole NET change (span-first before → rep after), never
# the raw last hop — the same collapsed record every row and diff surface shows.
U3D="$( cd "$U3W" && node "$CLI" diff 3 --patch --session "$U3S" )"
ok "diff on a unit rep is the NET change"              "printf '%s' \"\$U3D\" | grep -q -- '-A' && printf '%s' \"\$U3D\" | grep -q -- '+D'"
ok "…with no intermediate hop leaking in"              "! printf '%s' \"\$U3D\" | grep -qE '^[+-][BC]\$'"
U3J="$( cd "$U3W" && node "$CLI" undo 3 --json --session "$U3S" )"
ok "a 3-member unit reverts in one call"               "printf '%s' \"\$U3J\" | jq -e '.status == \"undone\"' >/dev/null"
ok "…back to the span's FIRST before-state"            "[ \"\$(sed -n 2p \"\$U3W/three.txt\")\" = \"A\" ]"
ok "…and every member is undone"                       "( cd \"\$U3W\" && node \"\$CLI\" list --json --session \"\$U3S\" ) | jq -e '[.edits[].status]|unique == [\"undone\"]' >/dev/null"
# The dependency edge: a later PENDING unit (#5) rewrote a line this KEPT unit (#4) produced, so the
# merge refuses — and the refusal names the dependent and carries the one-call closure.
node -e '
const core = require(process.argv[1]), fs = require("fs"), path = require("path");
const cwd = fs.realpathSync(process.argv[2]), S = process.argv[3];
const F = path.join(cwd, "dep.txt");
const mk = (b, a, ts) => core.appendLog(S, { ts, tool: "Edit", file: F, beforeBlob: core.writeBlob(S, Buffer.from(b)), afterBlob: core.writeBlob(S, Buffer.from(a)), status: "pending" });
mk("L1\nX\nL3\n", "L1\nA\nL3\n", 4000);
core.setStatusMany(S, [4], "kept");
mk("L1\nA\nL3\n", "L1\nB\nL3\n", 5000);
fs.writeFileSync(F, "L1\nB\nL3\n");
' "$CORE" "$U3W" "$U3S"
DEPJ="$( cd "$U3W" && node "$CLI" undo 4 --json --session "$U3S" )" || true   # a conflict exits 1, with a full payload
# #4 is KEPT: the dependent is named, but no `--ids` closure is offered — that verb reverts pending
# records only, so the suggestion would be a no-op loop (the executed-probe finding this pins).
ok "a depended-on undo refuses, naming the dependent"  "printf '%s' \"\$DEPJ\" | jq -e '.status == \"conflict\" and .dependents == [5] and (has(\"closure\")|not)' >/dev/null"
ok "…and says the chain is partly accepted"            "printf '%s' \"\$DEPJ\" | jq -e '.message | test(\"already accepted\")' >/dev/null"
# A bulk revert must carry the first conflict's MESSAGE, not only a count.
printf 'L1\nMANUAL\nL3\n' > "$U3W/dep.txt"
BULKJ="$( cd "$U3W" && node "$CLI" undo --all --json --session "$U3S" )"
ok "bulk undo carries firstConflict for its readers"   "printf '%s' \"\$BULKJ\" | jq -e '.conflicts == 1 and (.firstConflict | type == \"string\" and length > 0)' >/dev/null"
rm -rf "$U3W"

echo "════════ E2E 31: oplog — the reviewer's own operations, journaled and reversible ════════"
OPW="$(cd "$(mktemp -d)" && pwd -P)"; OPS="op-0000000000000001"
node -e '
const core = require(process.argv[1]), fs = require("fs"), path = require("path");
const cwd = fs.realpathSync(process.argv[2]), S = process.argv[3];
core.ensureStore(S);
const mk = (f, b, a, ts) => core.appendLog(S, { ts, tool: "Edit", file: path.join(cwd, f), beforeBlob: core.writeBlob(S, Buffer.from(b)), afterBlob: core.writeBlob(S, Buffer.from(a)), status: "pending" });
mk("a.txt", "a\n", "b\n", 1000);
mk("b.txt", "x\n", "y\n", 2000);
fs.writeFileSync(path.join(cwd, "a.txt"), "b\n");
fs.writeFileSync(path.join(cwd, "b.txt"), "y\n");
' "$CORE" "$OPW" "$OPS"
op(){ ( cd "$OPW" && node "$CLI" "$@" --session "$OPS" ); }
# Positive control first: an untouched store answers an EMPTY list, not an error.
ok "an untouched store answers an empty oplog"          "op oplog --json | jq -e '.operations == []' >/dev/null"
op keep --ids 1,2 --json >/dev/null
ok "a bulk keep lands in the oplog with its ids"        "op oplog --json | jq -e '(.operations|length) == 1 and .operations[0].kind == \"keep\" and .operations[0].ids == [1,2]' >/dev/null"
ok "oplog --revert-last puts the statuses back"         "op oplog --revert-last --json | jq -e '.restored == 2' >/dev/null && op list --json | jq -e '[.edits[].status]|unique == [\"pending\"]' >/dev/null"
op undo --all --json >/dev/null
ok "the bulk undo reverted the files"                   "[ \"\$(cat \"\$OPW/a.txt\")\" = \"a\" ]"
ok "reverting the bulk undo re-applies them byte-for-byte" "op oplog --revert-last --json | jq -e '.result.redone == 2' >/dev/null && [ \"\$(cat \"\$OPW/a.txt\")\" = \"b\" ] && [ \"\$(cat \"\$OPW/b.txt\")\" = \"y\" ]"
rm -rf "$OPW"

echo "════════ E2E 32: assign — attribution moves, and every read side follows ════════"
ASW="$(cd "$(mktemp -d)" && pwd -P)"; ASS="asg-0000000000000001"
node -e '
const core = require(process.argv[1]), fs = require("fs"), path = require("path");
const cwd = fs.realpathSync(process.argv[2]), S = process.argv[3];
const proj = core.projectDir(cwd); fs.mkdirSync(proj, { recursive: true });
const ask = (ts, t) => JSON.stringify({ timestamp: new Date(ts).toISOString(), type: "user", message: { role: "user", content: t } });
fs.writeFileSync(path.join(proj, S + ".jsonl"), ask(500, "first ask") + "\n" + ask(3500, "second ask") + "\n");
core.ensureStore(S);
const mk = (f, b, a, ts) => core.appendLog(S, { ts, tool: "Edit", file: path.join(cwd, f), beforeBlob: core.writeBlob(S, Buffer.from(b)), afterBlob: core.writeBlob(S, Buffer.from(a)), status: "pending" });
mk("one.py", "a = 1\n", "a = 2\n", 1000);
mk("two.py", "b = 1\n", "b = 2\n", 4000);
fs.writeFileSync(path.join(cwd, "one.py"), "a = 2\n");
fs.writeFileSync(path.join(cwd, "two.py"), "b = 2\n");
' "$CORE" "$ASW" "$ASS"
as(){ ( cd "$ASW" && node "$CLI" "$@" --session "$ASS" --root "$ASW" ); }
ok "assign moves an edit to another ask"                "as assign --ids 2 --prompt 1 --json | jq -e '.assigned == true and .ids == [2]' >/dev/null"
ok "review --prompt follows the assignment"             "as review --prompt 1 --json | jq -e '(.units|length) == 2' >/dev/null && as review --prompt 2 --json | jq -e '(.units|length) == 0' >/dev/null"
ok "prompts rows agree"                                 "as prompts --json | jq -e '.prompts[0].editIds == [1,2] and .prompts[1].editIds == []' >/dev/null"
ok "assign --clear restores the recorded window"        "as assign --ids 2 --clear --json >/dev/null && as prompts --json | jq -e '.prompts[1].editIds == [2]' >/dev/null"
ok "an unknown prompt fails loudly"                     "! as assign --ids 2 --prompt 99 >/dev/null 2>&1"
# A stored override can go stale (a copied store, a rewritten transcript): it must be SAID, never
# silently dropped — the edit falls back to its temporal window and prompts --json names the mismatch.
node -e 'require(process.argv[1]).appendScopeOverride(process.argv[2], [1], "p_bogus")' "$CORE" "$ASS"
ok "a stale override is said, not swallowed"            "as prompts --json | jq -e '(.assignErrors|length) == 1 and (.assignErrors[0] | test(\"p_bogus\"))' >/dev/null"
ok "…and the edit stays in its temporal window"         "as prompts --json | jq -e '.prompts[0].editIds == [1]' >/dev/null"
rm -rf "$ASW"

echo "════════════════════════════════════════════════════════"
echo "E2E RESULT: $pass passed, $fail failed"
[ $fail -eq 0 ]
