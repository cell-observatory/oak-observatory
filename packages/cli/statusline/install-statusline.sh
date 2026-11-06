#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Cell Observatory
# install-statusline.sh — set up the Claude Code usage status line on THIS host
# (e.g. a remote box you reach over SSH / VS Code Remote-SSH).
# Idempotent: re-running just refreshes the script and the statusLine setting.
# Honors $CLAUDE_CONFIG_DIR if you relocate ~/.claude.
set -euo pipefail
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
mkdir -p "$CLAUDE_DIR"

# --- dependency checks ---
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: 'jq' is required (the status line parses its JSON input with it)." >&2
  echo "  Debian/Ubuntu: sudo apt-get install -y jq" >&2
  echo "  RHEL/Fedora:   sudo dnf install -y jq" >&2
  echo "  macOS:         brew install jq" >&2
  echo "  Windows:       winget install jqlang.jq   (or: choco install jq / scoop install jq)" >&2
  exit 1
fi
command -v git >/dev/null 2>&1 || echo "NOTE: 'git' not found — branch segment is just skipped (harmless)." >&2
command -v python3 >/dev/null 2>&1 || echo "NOTE: 'python3' not found — the ~token estimate on the 5h/wk bars is skipped (percentages still show)." >&2
if ! locale charmap 2>/dev/null | grep -qi utf && ! locale -a 2>/dev/null | grep -qiE 'utf-?8'; then
  echo "NOTE: no UTF-8 locale found — the bar glyphs may not render, but everything else works." >&2
fi

# --- the foreign-statusLine guard, BEFORE ANY WRITE ---
# settings.json is CONTESTED SHARED STATE: ccusage, Orca and hand-rigged status lines all live in
# the same statusLine key. A statusLine that is not OURS is another tool's managed state, and
# silently taking it over is how two installers fight over one file — so it is REFUSED by default,
# named, and replaced only under an explicit --force (with a .bak of settings.json written first).
# This check runs before the script write below: a refused run must leave the disk EXACTLY as it
# found it (the guard used to sit after the write, so a refusal still replaced statusline.sh).
SETTINGS="$CLAUDE_DIR/settings.json"
# A byte order mark first (some Windows editors write one) is no part of the JSON: jq reads what follows it,
# and the merge below writes it back first, as OAK's own writes of this file keep it. (Local fix.)
SBOM=""
[ -f "$SETTINGS" ] && [ "$(head -c 3 "$SETTINGS" | od -An -tx1 | tr -d ' \n')" = efbbbf ] && SBOM=1
settings_json() { if [ -n "$SBOM" ]; then tail -c +4 "$SETTINGS"; else cat "$SETTINGS"; fi; }
if [ -f "$SETTINGS" ] && ! settings_json | jq -e . >/dev/null 2>&1; then
  echo "ERROR: $SETTINGS is not valid JSON — leaving it untouched. Fix it and re-run." >&2
  exit 1
fi
# Scalar-tolerant read: a plain-string statusLine (e.g. "ccusage statusline") used to error jq
# inside the substitution and kill the whole script under set -e — exit 5, no message. Any shape
# that is not our object lands in the foreign branch below and gets the honest REFUSED instead.
EXISTING=""
[ -f "$SETTINGS" ] && EXISTING="$(settings_json | jq -r '.statusLine | if . == null then "" elif type == "object" then (.command // "unrecognized-statusLine-object") else tostring end' 2>/dev/null || echo "unreadable-statusLine")"
case "$EXISTING" in
  "" ) : ;;                                   # nothing there — free to install
  *"$CLAUDE_DIR/statusline.sh"* ) : ;;        # ours (as this script spells it) — a refresh
  * )
    if [ "${1:-}" != "--force" ]; then
      echo "REFUSED: $SETTINGS already has a statusLine that is not ours:" >&2
      echo "    $EXISTING" >&2
      echo "  Another tool (ccusage, Orca, or your own rig) manages it. Re-run with --force to" >&2
      echo "  replace it — a backup of settings.json is written to $SETTINGS.bak first." >&2
      exit 2
    fi
    cp "$SETTINGS" "$SETTINGS.bak"
    echo "replacing the existing statusLine (backup: $SETTINGS.bak):"
    echo "    was: $EXISTING"
    ;;
esac

# --- write the status line script (verbatim copy of the working one) ---
cat > "$CLAUDE_DIR/statusline.sh" <<'STATUSLINE_EOF'
#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Cell Observatory
# Claude Code status line.
#   Line 1: time · date | branch (only inside a git repo) | current path (~-abbreviated) |
#           session title (falls back to the folder name)
#   Line 2: ctx bar | model · effort · think · style · ↑input ↓output ↺cached session tokens · ◷duration
#           (effort/think/style/tokens/duration shown only when present)
#   Line 3: the quota bars — 5h | week | per-model week | month, each `label <bar> pct% · resets`,
#           after a dim `(machine)` when one is a saved machine's reading (A SAVED MACHINE'S READING)
#
# THE BARS ARE PROGRESS BARS THAT HOLD THEIR FIGURES (painted again, 2026-10-14): each one's
# used/total and +cached↺ print inside a painted box whose first pct% is a very dim tint of the usage
# colour and whose rest is an even dimmer neutral, all under one light ink. The colours are kept very
# dim so the figures stand out; no brackets, no block glyphs, so the line still fits a narrow pane.
#
# EVERY BAR IS THE SAME LENGTH: the box is as wide as the widest figures anywhere in the render
# (the ctx figures on line 2 included), with the figures centred in it. That width is only known
# once every segment is built, so line 3 is a TWO-PASS build and line 2 prints at the END — behind
# an EXIT trap, so a render killed during the window scan still emits its head.
#
# rate_limits.* fields are sent only for Claude.ai subscription plans (Pro/Max/Team)
# and only after the first API response in a session (or since its window reset), so
# such a session shows the share the account pull or the cache measured inside the
# window, else the saved machine's reading OAK shows, else a placeholder. They are THAT
# session's last response's, days old in an idle one, so each reading is dated and each
# window shows its freshest (pick_win).
# Schema: https://code.claude.com/docs/en/statusline.md

# Bar glyphs are multibyte; slicing them counts CHARACTERS only under a UTF-8 locale.
# Over SSH the locale is often C/POSIX (byte-counting), which would corrupt the bars,
# so pick a UTF-8 locale when the current one isn't already UTF-8.
if ! locale charmap 2>/dev/null | grep -qi 'utf'; then
  for L in C.UTF-8 en_US.UTF-8 C.utf8 en_US.utf8; do
    if locale -a 2>/dev/null | grep -qix "$L"; then export LC_ALL="$L"; break; fi
  done
fi

# Under Git Bash or Cygwin (how Claude Code runs this on Windows) a native jq.exe or python.exe ends
# its lines with CRLF (jq's own --binary flag exists for this), and every value read from them kept
# the \r: arithmetic failed, compares missed and the rows came out broken. Only there, their output
# loses the \r.
case "${OSTYPE:-}" in msys*|cygwin*)
  jq() { command jq "$@" | tr -d '\r'; return "${PIPESTATUS[0]}"; }
  if command -v python3 >/dev/null 2>&1; then python3() { command python3 "$@" | tr -d '\r'; return "${PIPESTATUS[0]}"; }; fi ;;
esac

input=$(cat)
# ONE jq pass for every scalar this render reads. The old per-field j() helper spawned jq sixteen
# times (~150ms of a 550ms render, measured). One field per LINE, not @tsv: @tsv escapes backslashes,
# which would corrupt Windows paths, and none of these fields can legally contain a newline. Absent
# maps to an empty line ("" — never `empty`, which would DROP the line and shift every later field),
# so the read chain below stays aligned. bash 3.2-safe: no mapfile.
{
  IFS= read -r dir
  IFS= read -r model
  IFS= read -r effort      # reasoning effort (low/medium/high/xhigh/max); empty if unsupported
  IFS= read -r thinking    # extended thinking on/off
  IFS= read -r ostyle      # active output style (hidden when default)
  IFS= read -r dur_ms      # wall-clock session duration
  IFS= read -r ctx
  IFS= read -r ctx_in
  IFS= read -r ctx_out
  IFS= read -r ctx_size
  IFS= read -r sid
  IFS= read -r tp
  IFS= read -r five_pct
  IFS= read -r five_reset
  IFS= read -r week_pct
  IFS= read -r week_reset
  IFS= read -r sname       # Claude Code's own name for the session: its rename, else its ai-title
} < <(printf '%s' "$input" | jq -r '[
  (.workspace.current_dir // .cwd // ""), (.model.display_name // ""), (.effort.level // ""),
  (.thinking.enabled // false), (.output_style.name // ""), (.cost.total_duration_ms // ""),
  (.context_window.used_percentage // ""), (.context_window.total_input_tokens // 0),
  (.context_window.total_output_tokens // 0), (.context_window.context_window_size // ""),
  (.session_id // ""), (.transcript_path // ""),
  (.rate_limits.five_hour.used_percentage // ""), (.rate_limits.five_hour.resets_at // ""),
  (.rate_limits.seven_day.used_percentage // ""), (.rate_limits.seven_day.resets_at // ""),
  (.session_name // "")
][] | tostring' 2>/dev/null)
branch=$(git -C "$dir" --no-optional-locks rev-parse --abbrev-ref HEAD 2>/dev/null)

DIM=$'\033[2m'; R=$'\033[0m'; WHT=$'\033[97m'; LORG=$'\033[38;5;215m'; YEL=$'\033[93m'
# color a usage percentage: green <50, yellow 50-79, red >=80
uc() { local p=${1%.*}; [ -z "$p" ] && p=0
  if [ "$p" -ge 80 ]; then printf '\033[31m'; elif [ "$p" -ge 50 ]; then printf '\033[33m'; else printf '\033[32m'; fi; }
# bar pct,text,width,colour -> a PROGRESS BAR holding its figures: a `width`-cell box with the
# figures centred in it, whose first pct% of CELLS are painted a very dim tint of the usage colour
# (`colour` is uc's code; the tint is its dim twin) and the rest an even dimmer neutral. Cells are
# whole, so the fill edge falls between two cells.
#
# VERY DIM, SO THE FIGURES STAND OUT. A field painted in the usage colour itself read as a slab, and
# its fill edge cut numbers in half, because the ink changed with the ground. Here ONE light ink runs
# over both grounds: the edge changes the ground under a digit, never the digit. The ink is set
# explicitly rather than left to the terminal, because the box brings its own dark ground and a
# light-themed terminal's dark default would vanish into it. No caps: the painted box shows its own
# extent, and a cap in the usage colour would be the brightest thing on the bar. Centred, as a
# progress bar's label is; with one ink the figures need not start where the fill does.
#
# EVERY BAR IS THE SAME LENGTH: `width` is the widest figures in the whole render, passed in by the
# two-pass build below. A width smaller than the text cannot truncate a number — the box grows.
# An empty text still draws a bare bar, so a segment whose estimate has not calibrated yet shows
# its share rather than vanishing.
#
# COLOUR DEPTH: 24-bit grounds only where Claude Code itself draws 24-bit, which is $COLORTERM
# truecolor and no other value: under COLORTERM=24bit it maps 24-bit codes onto the 256-colour
# cube, and the neutral came out #5f5f5f with the red fill on the same cell (observed). Elsewhere
# the nearest 256-colour cells, which it passes through as they are. That palette has no very dim
# hue: its darkest green and yellow (#005f00, #5f5f00) are far brighter than the 24-bit tints and
# its darkest red (#5f0000) far more saturated, so there every fill is the nearest grey a step above
# the neutral, and the label and share keep the hue. Selected once, by a `case`: no process per bar.
# THE TINTS SURVIVE A 256-COLOUR HOP. tmux sets COLORTERM=truecolor in its panes and, for a client
# it does not know to be truecolor (one reached over ssh, for one), maps each 24-bit colour to its
# nearest 256-colour cell. Each tint is picked so that cell is 236 and the neutral's 234, the 256
# design above; darker tints all landed on 234 or 235 and the fill vanished into the neutral.
# Slices with ${v:o:n}, which counts CHARACTERS under the UTF-8 locale forced above: the cache
# glyph is multibyte and a byte-slice would cut it in half.
case "${COLORTERM:-}" in
  truecolor) BINK=$'\033[38;2;228;228;228m'; BREST=$'\033[48;2;30;30;34m'
    BGRN=$'\033[48;2;30;64;40m'; BYEL=$'\033[48;2;60;52;24m'; BRED=$'\033[48;2;74;36;36m' ;;
  *) BINK=$'\033[38;5;254m'; BREST=$'\033[48;5;234m'
    BGRN=$'\033[48;5;236m'; BYEL=$BGRN; BRED=$BGRN ;;
esac
BLANKS="                                        "
bar() { local p=${1%.*} txt="$2" w="${3:-0}" col="$4" field f fill
  case "$p" in ''|*[!0-9]*) p=0 ;; esac
  [ "$p" -gt 100 ] && p=100
  case "$col" in *'[31m') fill=$BRED ;; *'[33m') fill=$BYEL ;; *) fill=$BGRN ;; esac
  local left
  if [ -n "$txt" ]; then
    [ "$w" -lt $(( ${#txt} + 2 )) ] && w=$(( ${#txt} + 2 ))
    left=$(( (w - ${#txt}) / 2 ))
    field="${BLANKS:0:$left}$txt${BLANKS:0:$(( w - ${#txt} - left ))}"
  else
    [ "$w" -lt 8 ] && w=8; field="${BLANKS:0:$w}"
  fi
  f=$(( (p * w + 50) / 100 )); [ "$f" -gt "$w" ] && f=$w
  printf '%s%s%s%s%s' "$BINK$fill" "${field:0:$f}" "$BREST" "${field:$f}" "$R"; }
# Normalize a resets_at value to integer epoch SECONDS. Claude Code sends it as either an epoch
# (seconds, or ms when >=13 digits) OR an ISO-8601 string like "2026-07-08T12:00:00Z" (seen inside
# Linux containers) — the raw ISO form would blow up until_str's integer math. Prints the epoch on
# success, nothing on failure so callers guard on empty. ISO parsers tried in order: GNU `date -d`
# (Linux, where ISO actually shows up), python3 fromisoformat, then BSD/macOS `date -j`.
to_epoch() { local v="$1" e=
  case "$v" in
    ''|*[!0-9.]*) ;;                                  # empty or non-numeric (ISO) -> parse below
    *) e=${v%.*}; [ "${#e}" -ge 13 ] && e=$(( e / 1000 )); printf '%s' "$e"; return 0 ;;
  esac
  [ -z "$v" ] && return 0
  e=$(date -d "$v" +%s 2>/dev/null) && { printf '%s' "$e"; return 0; }
  if command -v python3 >/dev/null 2>&1; then
    e=$(python3 -c 'import sys,datetime as d; s=sys.argv[1].strip(); s=s[:-1]+"+00:00" if s.endswith("Z") else s; print(int(d.datetime.fromisoformat(s).timestamp()))' "$v" 2>/dev/null) \
      && { printf '%s' "$e"; return 0; }
  fi
  e=$(TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%S" "${v%%[.Z+]*}" +%s 2>/dev/null) && printf '%s' "$e"; }
# WRAPPING. A row wider than the window is TRUNCATED by Claude Code, and the
# right-hand segments simply vanish. Claude Code captures the script's output rather than attaching
# it to the terminal, so `tput cols` and every language-level width probe read nothing from in here
# - but it exports COLUMNS (and LINES) before running us, and that is the documented way to learn
# the width. Unset or zero means "do not wrap": a wrong guess would fold rows that fit.
# Visible width: the SGR sequences occupy no columns. Pure parameter expansion, because this runs
# once per segment per render and a sed per call is a process per segment. A loop over the escapes
# rather than ${1//<ESC>\[*([0-9;])m/}: bash's extglob match slows with each sequence's length, and the
# bars' 24-bit grounds took it to 5 ms a segment (measured). An ESC[ that opens no SGR is text.
# It also leaves the width in _vw, so `vw X >/dev/null` measures without the subshell `$(vw X)` costs (half a
# millisecond each, measured): a title wrapped at its spaces is a segment per word.
vw() { local s="$1" o="" q
  while :; do
    case "$s" in
      *$'\033['*) o="$o${s%%$'\033['*}"; s="${s#*$'\033['}"; q="${s%%m*}"
        case "$s" in
          *m*) case "$q" in *[!0-9\;]*) o="$o"$'\033[' ;; *) s="${s#*m}" ;; esac ;;
          *) o="$o"$'\033[' ;;
        esac ;;
      *) o="$o$s"; break ;;
    esac
  done
  _vw=${#o}; printf '%s' "${#o}"; }
# split SUBSEP STRING -> the pieces, in _sp. Quoted in the pattern so an ANSI-bearing separator is
# matched literally rather than as a glob.
_split() { local ss="$1" str="$2"; _sp=()
  while [ -n "$str" ]; do
    case "$str" in
      *"$ss"*) _sp+=("${str%%"$ss"*}"); str="${str#*"$ss"}" ;;
      *) _sp+=("$str"); str="" ;;
    esac
  done; }
# emit SEP SUBSEP SEGMENT... -> pack the segments into as few rows as fit COLUMNS. A segment is
# never cut mid-way; one too wide to stand alone is broken at SUBSEP first (the session blob is one
# segment, and on a 60-column window it overran by itself), and only if SUBSEP is empty or does not
# help does it get a row of its own and overflow. Rows print with %s, never %b: the colours are real ESC
# bytes already, and %b read a Windows path's `\c…` as "stop output", so row 1 swallowed row 2.
emit() { local sep="$1" sub="$2"; shift 2
  local w="${COLUMNS:-0}" segs=() seps=() seg piece first line="" lw=0 i=0 sw pw
  for seg in "$@"; do
    [ -z "$seg" ] && continue
    if [ "$w" -gt 0 ] && [ -n "$sub" ] && vw "$seg" >/dev/null && [ "$_vw" -gt "$w" ]; then
      _split "$sub" "$seg"; first=1
      for piece in ${_sp[@]+"${_sp[@]}"}; do
        segs+=("$piece")
        if [ "$first" = 1 ]; then seps+=("$sep"); first=0; else seps+=("$sub"); fi
      done
    else segs+=("$seg"); seps+=("$sep"); fi
  done
  for seg in ${segs[@]+"${segs[@]}"}; do
    vw "$seg" >/dev/null; sw=$_vw; vw "${seps[$i]}" >/dev/null; pw=$_vw
    if [ -z "$line" ]; then line="$seg"; lw=$sw
    elif [ "$w" -gt 0 ] && [ $(( lw + pw + sw )) -gt "$w" ]; then
      printf '%s\n' "$line"; line="$seg"; lw=$sw
    else line="$line${seps[$i]}$seg"; lw=$(( lw + pw + sw )); fi
    i=$(( i + 1 ))
  done
  [ -n "$line" ] && printf '%s\n' "$line"; }
# Roll a PAST reset anchor forward by whole periods (2026-09-08: Claude Code 2.1.263 stopped
# sending resets_at while the percentages still arrive; current versions send it again, and this
# stays the fallback for the versions that do not) — exact for the periodic weekly windows.
# A 5h window starts only with the first message after the last one ended, so a passed 5h anchor
# rolls only for a share measured after it with no reset of its own (pick_win).
_nowe=$(date +%s)
roll_fwd() { local e="$1" per="$2"
  [ -z "$e" ] && return 0
  [ "$e" -le "$_nowe" ] 2>/dev/null && e=$(( e + ( ( _nowe - e ) / per + 1 ) * per ))
  printf '%s' "$e"; }
# resets_at (epoch or ISO-8601) -> "Xd Yh" / "Xh Ym" / "Xm" / "now"; empty if unparseable
until_str() { local e; e=$(to_epoch "$1"); [ -z "$e" ] && return 0
  local now d; now=$(date +%s); d=$(( e - now ))
  if [ "$d" -le 0 ]; then echo now
  elif [ "$d" -ge 86400 ]; then echo "$((d/86400))d $(((d%86400)/3600))h"
  elif [ "$d" -ge 3600 ]; then echo "$((d/3600))h $(((d%3600)/60))m"
  else echo "$((d/60))m"; fi; }
# integer token count -> compact "49k" / "1.2M" (matches /context's readout)
human() { local n=${1%.*}; [ -z "$n" ] && n=0
  if [ "$n" -ge 1000000000 ]; then local b=$(((n%1000000000)/100000000))
    if [ "$b" -eq 0 ]; then printf '%dB' $((n/1000000000)); else printf '%d.%dB' $((n/1000000000)) "$b"; fi
  elif [ "$n" -ge 1000000 ]; then local d=$(((n%1000000)/100000))
    if [ "$d" -eq 0 ]; then printf '%dM' $((n/1000000)); else printf '%d.%dM' $((n/1000000)) "$d"; fi
  elif [ "$n" -ge 1000 ]; then printf '%dk' $((n/1000))
  else printf '%d' "$n"; fi; }
# dollars -> compact "$4.2" / "$41" / "$412"; empty for zero/absent so segments can skip it
money() { LC_ALL=C awk -v v="${1:-0}" 'BEGIN{ if (v+0 <= 0) printf ""; else if (v >= 1000) printf "$%.1fk", v/1000; else if (v >= 100) printf "$%d", v; else if (v >= 10) printf "$%.0f", v; else printf "$%.1f", v }'; }
# milliseconds -> compact wall time "1h04m" / "4m" / "30s"
dur_str() { local s=$(( ${1%.*} / 1000 ))
  if [ "$s" -ge 3600 ]; then printf '%dh%02dm' $((s/3600)) $(((s%3600)/60))
  elif [ "$s" -ge 60 ]; then printf '%dm' $((s/60))
  else printf '%ds' "$s"; fi; }

# Session title, which closes line 1, in the order every OAK surface names a session
# (core preferredSessionTitle), so this line, the dashboard and the Claude app agree:
#   1. a rename — the newest `custom-title` (/rename, or a rename on claude.ai or the Claude app);
#   2. the Remote Control title claude.ai holds for the session's newest `bridge-session` id, as OAK
#      last cached it (read from the cache file: this script never asks the network for it);
#   3. Claude Code's own name for it (`session_name`), else the transcript's latest ai-title.
# It rides with the path it belongs to, and line 2 opens with the ctx gauge instead.
# NO FOLDER-NAME FALLBACK any more: it used to open line 2, where standing in for an untitled
# session was worth it; sitting directly after the path it is copied from, it would print
# `~/src/oak | oak` on every fresh session. An untitled session simply shows no title — which is
# also what the dashboard does, so the two lines still agree. Cheap:
# grep pre-filters (no full JSON parse); one jq takes the newest record of each kind.
title=""; rename=""; ai=""; bridge=""
if [ -n "$tp" ] && [ -f "$tp" ]; then
  # Bounded to the last 4MB (title records ride near the end; matches core TITLE_TAIL_SCAN) — the
  # whole-file grep was ~144ms on a 10MB transcript and grew with it. fromjson? skips the possibly-
  # truncated first line of the tail instead of aborting the stream. An empty rename is a cleared one.
  { IFS= read -r rename; IFS= read -r ai; IFS= read -r bridge; } < <(tail -c 4194304 "$tp" 2>/dev/null |
    grep -E '"type":"(custom-title|ai-title|bridge-session)"' | tail -n 60 |
    jq -Rrn '[inputs | fromjson? | select(type == "object")] as $r
      | ([$r[] | select(.type == "custom-title")] | last | .customTitle // ""),
        ([$r[] | select(.type == "ai-title")] | last | .aiTitle // ""),
        ([$r[] | select(.type == "bridge-session" and (.bridgeSessionId | type) == "string")] | last | .bridgeSessionId // "")
      | tostring | gsub("[\\r\\n]"; " ")' 2>/dev/null)
fi
title="$rename"
# session_name is Claude Code's rename-or-ai-title; when it differs from the ai-title it is a rename.
[ -z "$title" ] && [ -n "$sname" ] && [ -n "$ai" ] && [ "$sname" != "$ai" ] && title="$sname"
if [ -z "$title" ] && [ -n "$bridge" ]; then
  obs="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/claude-observatory"; sdir=""; rt_off=""
  if [ -f "$obs/prefs.json" ]; then
    # A relocated store (prefs.storeDir) moves the cache; remoteTitles:false means none is shown.
    { IFS= read -r sdir; IFS= read -r rt_off; } < <(jq -r '(.storeDir // "" | tostring), (if .remoteTitles == false then "off" else "" end)' "$obs/prefs.json" 2>/dev/null)
    case "$sdir" in "~"*) sdir="$HOME${sdir#"~"}";; esac
    [ -n "$sdir" ] && obs="$sdir"
  fi
  if [ -z "$rt_off" ] && [ -f "$obs/remote-cache/session-titles.json" ]; then
    key="${bridge#cse_}"; key="${key#session_}"
    title=$(jq -r --arg k "$key" '.titles[$k] // "" | tostring | gsub("[\\r\\n]"; " ")' "$obs/remote-cache/session-titles.json" 2>/dev/null)
  fi
fi
[ -z "$title" ] && title="${sname:-$ai}"
# herdr's tab follows the title (OAK, 2026-09-27), also while OAK's terminal app is closed: in a herdr
# pane, when the title or the pane differs from the last one this line started a sync for, start
# `oak __tab-sync` in the background; it renames the tab only where the tab's label is OAK's to set.
# One small file read per render, and nothing at all outside herdr.
if [ -n "${HERDR_PANE_ID:-}" ] && [ -n "$title" ]; then
  case "$sid" in ''|.|..|*[!A-Za-z0-9._-]*) ;; *)
    _tsf="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline-tab-titles/$sid"; _tsv="$HERDR_PANE_ID $title"; _tsl=""
    [ -f "$_tsf" ] && IFS= read -r _tsl < "$_tsf"
    # Started only once the new value is recorded: a render that cannot record it starts nothing. The
    # record is private (a 0700 directory of 0600 files): a title is conversation content. The umask
    # covers what it creates; chmod also covers what an earlier line left 0755/0644, before it writes.
    if [ "$_tsl" != "$_tsv" ] && command -v oak >/dev/null 2>&1 \
      && (umask 077; mkdir -p "${_tsf%/*}" && chmod 700 "${_tsf%/*}" && { [ ! -e "$_tsf" ] || chmod 600 "$_tsf"; } \
        && printf '%s\n' "$_tsv" > "$_tsf") 2>/dev/null; then
      (oak __tab-sync "$sid" </dev/null >/dev/null 2>&1 &)
    fi ;;
  esac
fi

# Line 1 — when and where: the clock, the branch (only inside a git repo), the ~-abbreviated
# working directory, and the session title last.
pdir="$dir"; case "$dir" in "$HOME"*) pdir="~${dir#"$HOME"}";; esac
# Line 1 in solid white — the separators stay dim so the pieces still read apart.
l1=("${WHT}$(date +%H:%M)${R} ${DIM}·${R} ${WHT}$(date '+%b %d')${R}")
[ -n "$branch" ] && l1+=("${WHT}$branch${R}")
# The path and the title are content, never cut (2026-11-03: the title was cut at 48 characters). One wider than the
# window wraps at its spaces (emit's SUBSEP), and a word wider than the window is broken at its edge; each word is then
# coloured on its own, so the rows the wrap starts keep the colour. One that fits is left exactly as it was.
# Into l1, without a subshell per call.
words() { local t="$1" o="" wd n="${COLUMNS:-0}"
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  if [ "$n" = 0 ] || [ "${#t}" -le "$n" ]; then l1+=("${WHT}$t${R}"); return 0; fi
  set -f
  for wd in $t; do
    while [ "${#wd}" -gt "$n" ]; do o="${o:+$o }${WHT}${wd:0:$n}${R}"; wd="${wd:$n}"; done
    o="${o:+$o }${WHT}$wd${R}"
  done
  set +f; l1+=("$o"); }
words "$pdir"
[ -n "$title" ] && words "$title"
emit " $DIM|$R " " " "${l1[@]}"

# Session token counters (input / output / cache reads) via the oak CLI this script
# ships with — the same split its Stats panel shows. Omitted (never zeroed) when the CLI is absent
# or the session has no usage yet, matching the shown-only-when-present rule of the other segments.
# The same read carries the account's windows as OAK's own readouts show them (`claudeAccount`, core usageLine). For
# each window core took from a saved machine of the same account (fillFromMachines), it names that machine; this jq
# takes the name, the share, its reset (epoch seconds), and the estimate and budget beside it, and for the month the
# figures it came with; and whether the account has a five-hour limit by core's reading of its answers (no_five: 1 for
# none, 0 for one, '' from an oak that does not say). One field per line, each present ('' for none) so the reads stay
# aligned, and a name without its control characters. They are drawn on line 3 and never recorded: A SAVED MACHINE'S
# READING, below. Its last field
# is what the saved machines of the account measured of their own turns (`machineMeasured`, one line of JSON), which
# the estimator adds to this machine's: THE ACCOUNT ACROSS ITS MACHINES, in the estimator.
t_in=""; t_out=""; t_cr=""; t_ag=""; t_tin=""; t_tout=""; t_tcr=""; _m5=""; _m5n=""; _m7=""; _mf=""; _mm=""; _mx=""; _mt=""
# OAK_STATUSLINE marks this as the statusline's OWN usage read: `oak usage` kicks a detached month
# refresh (spawning the statusline) for editor-only machines, and without this flag THIS render would
# kick itself in a throttled loop. The editors' own `oak usage` calls carry no flag and still kick.
# That month refresh renders with no session id, and makes the read too, for the saved machines' figures, which its
# scan of the month adds up: without them it recorded this machine's month alone. Its session tokens are not taken.
if command -v oak >/dev/null 2>&1; then
  { read -r t_in t_out t_cr t_ag t_tin t_tout t_tcr
    IFS= read -r _m5; IFS= read -r _m5p; IFS= read -r _m5r; IFS= read -r _m5e; IFS= read -r _m5t; IFS= read -r _m5n
    IFS= read -r _m7; IFS= read -r _m7p; IFS= read -r _m7r; IFS= read -r _m7e; IFS= read -r _m7t
    IFS= read -r _mf; IFS= read -r _mfp; IFS= read -r _mfr; IFS= read -r _mfe; IFS= read -r _mft; IFS= read -r _mfl
    IFS= read -r _mm; IFS= read -r _mmt; IFS= read -r _mmT; IFS= read -r _mmr; IFS= read -r _mmR; IFS= read -r _mmc; IFS= read -r _mmC
    IFS= read -r _mx
    IFS= read -r _mt
  } < <( (cd "$dir" 2>/dev/null && OAK_STATUSLINE=1 oak usage ${sid:+--session "$sid"} 2>/dev/null) | jq -r --arg sid "$sid" '
    def lab: if type == "string" then gsub("[\u0001-\u001f\u007f-\u009f]"; "") else "" end;
    def sec: if type == "number" then . / 1000 | floor else "" end;
    def num: if type == "number" then . else "" end;
    if type != "object" then empty else
      (if $sid == "" then "" else (([.sessionTreeTokens? | select(type == "object" and .agents? > 0) | " \(.agents) \(.input) \(.output) \(.cacheRead)"]
        | first // "") as $tree | (.sessionTokens | select(.total? > 0) | "\(.input) \(.output) \(.cacheRead)" + $tree | gsub("\n"; " ")) // "") end),
      (.claudeAccount | if type == "object" then . else {} end
        | (.fiveMachine | lab), (.fiveHourPct | num), (.fiveReset | sec), (.fiveTokens | num), (.fiveTotal | num),
          (if has("fiveNoneAt") then (if (.fiveNoneAt | type) == "number" then 1 else 0 end) else "" end),
          (.weekMachine | lab), (.weekPct | num), (.weekReset | sec), (.weekTokens | num), (.weekTotal | num),
          (.fableMachine | lab), (.fablePct | num), (.fableReset | sec), (.fableTokens | num), (.fableTotal | num), (.fableLabel | lab),
          (.monthMachine | lab), (.monthTokens | num), (.monthTokensTotal | num), (.monthReset | sec), (.monthReads | num),
          (.monthCost | num), (.monthCostTotal | num), (.machineMeasured | if type == "object" then tojson else "" end)),
      (.usageTotals | if type == "object" then tojson else "" end)
      | tostring
    end' 2>/dev/null)
fi

# Line 2 — the session: the CONTEXT gauge first (it is the number read most
# often, and it belongs beside the model whose window it fills), then model + attributes + spend.
# The ↑/↓/↺/◷ glyphs are plain text (not emoji), dimmed so the numbers carry the line.
# Everything the gauge needs is already in hand here: the shares come off the input JSON at the top
# and the cache reads off the `oak usage` read just above.
ctx_txt=""
if [ -n "$ctx" ]; then
  # the absolute token count "used/size" rides INSIDE the bar when the context_window fields are present
  [ -n "$ctx_size" ] && ctx_txt="$(human $(( ${ctx_in%.*} + ${ctx_out%.*} )))/$(human "$ctx_size")"
  # …and the session cache READS beside them — the same ↺ figure this line keeps.
  [ -n "$t_cr" ] && [ "${t_cr%.*}" -gt 0 ] 2>/dev/null && ctx_txt="${ctx_txt:+$ctx_txt }+$(human "$t_cr")↺"
fi
# Everything after the ctx gauge. Built now, joined to the gauge at the end.
# Its parts, each with the rank it is dropped at when the row is wider than the window (1 first; 0 never: the model and
# the context figure stay on one row).
l2p=(); l2k=()
[ -n "$effort" ] && { l2p+=("$effort"); l2k+=(6); }
[ "$thinking" = "true" ] && { l2p+=("think"); l2k+=(2); }
case "$ostyle" in ''|null|default|Default) ;; *) l2p+=("$ostyle"); l2k+=(1) ;; esac
# The session's own tokens, and with every agent it started when it started any (`oak usage`'s sessionTreeTokens),
# each labelled: its own figure is never the task's.
if [ -n "$t_in" ]; then
  _tk="${DIM}↑${R}$(human "$t_in") ${DIM}↓${R}$(human "$t_out") ${DIM}↺${R}$(human "$t_cr")"
  if [ -n "$t_ag" ] && [ "${t_ag%.*}" -gt 0 ] 2>/dev/null; then
    l2p+=("${DIM}own${R} $_tk"); l2k+=(5)
    l2p+=("${DIM}with $t_ag agent$([ "$t_ag" = 1 ] || printf s)${R} ${DIM}↑${R}$(human "$t_tin") ${DIM}↓${R}$(human "$t_tout") ${DIM}↺${R}$(human "$t_tcr")"); l2k+=(4)
  else l2p+=("$_tk"); l2k+=(5); fi
fi
{ [ -n "$dur_ms" ] && [ "${dur_ms%.*}" -ge 1000 ]; } && { l2p+=("${DIM}◷${R}$(dur_str "$dur_ms")"); l2k+=(3); }
# The context window closes line 2 as a compact `used/total pct%` figure — the bar
# it used to open line 2 with is gone. Kept out of the shared-width bar math above; it is text now.
[ -n "$ctx" ] && [ -n "$ctx_size" ] && { l2p+=("$(uc "${ctx%.*}")$(human $(( ${ctx_in%.*} + ${ctx_out%.*} )))/$(human "$ctx_size") ${ctx%.*}%${R}"); l2k+=(0); }
# Every part after the model opens with ` · ` (a bare effort with no model leads with one, as it always has).
l2row() { l2tail="$model"; local k
  for (( k = 0; k < ${#l2p[@]}; k++ )); do [ "${l2k[$k]}" = x ] || l2tail="$l2tail ${DIM}·${R} ${l2p[$k]}"; done; }
l2row
# A row wider than COLUMNS drops its parts by rank, lowest first, measuring the row again after each, before it wraps:
# the output style, think, the duration, the tokens with the agents, the session's own, then the effort.
if [ "${COLUMNS:-0}" -gt 0 ] 2>/dev/null; then
  for _r in 1 2 3 4 5 6; do
    vw "$l2tail" >/dev/null; [ "$_vw" -gt "$COLUMNS" ] || break
    for (( _k = 0; _k < ${#l2p[@]}; _k++ )); do [ "${l2k[$_k]}" = "$_r" ] && l2k[$_k]=x; done
    l2row
  done
fi
# LINE 2 IS PRINTED AT THE END, not here: every bar in the render shares one width (the widest
# figures anywhere in it), and the quota figures below are not known yet. This provisional value
# uses the ctx gauge's own natural width, and the EXIT trap emits it if the render is killed
# during the window scan — which is what used to happen anyway, and losing the head of the
# statusline to a slow scan would be a worse trade than a ragged bar.
# The ctx gauge no longer opens line 2 — it rides the end of $l2tail as a compact `used/total pct%`
# figure. Line 2 is now just $l2tail; this stays a no-op so the two-pass call sites
# and the EXIT-trap head emit are untouched.
build_line2() { line2=""; }
build_line2
_head_out=0
# The trap also removes the cache's temporary file that a render leaves when its write fails or it ends inside the
# write (below): each render's has a name of its own, which no later render writes over. And it releases the cache's
# lock (_lock, below) when the render ends holding it.
emit_head() { [ -n "${_LAST:-}" ] && [ -e "$_LAST.tmp.$$" ] && rm -f "$_LAST.tmp.$$"
  [ -z "${_lt:-}" ] || _unlock
  [ "$_head_out" = 1 ] && return 0; _head_out=1; emit " $DIM|$R " " ${DIM}·${R} " "$line2" "$l2tail"; }
trap emit_head EXIT

# --- account-wide token ESTIMATE for the 5h/wk windows (rough, self-calibrating) ---
# Those windows expose ONLY a percentage, never tokens. We approximate absolute tokens as
#   est = used_percentage * tokens_per_percent
# where tokens_per_percent is LEARNED over time: each scan compares the account's measured tokens
# within the window against the account %: this machine's transcripts, plus what each saved machine
# of the same account measured of its own turns in the same window (THE ACCOUNT ACROSS ITS MACHINES,
# below). Activity on a machine OAK does not read can still move the percentage without appearing in
# measured tokens. A throttled scan stores calibration in statusline-usage.json; without python3 or a
# sample the estimate is omitted.
est5=""; est7=""; meas5=""; meas7=""
# A cached Fable share measured before its current week began is last week's: the account pull that
# brings this week's has not run since (offline, or a lapsed login). It is neither shown nor used to
# calibrate, as in every other OAK view (core usageLine drops it the same way). A share this render
# pulls is always this week's.
_fb_old=""
_fb_q=$(jq -r '"\(.fable_at // .api_ts // "")|\(.fable_reset // "")"' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline-last.json" 2>/dev/null)
_fb_at=${_fb_q%%|*}; _fb_at=${_fb_at%.*}; _fb_re=$(roll_fwd "$(to_epoch "${_fb_q#*|}")" 604800)
[ -n "$_fb_at" ] && [ -n "$_fb_re" ] && [ "$_fb_at" -lt $(( _fb_re - 604800 )) ] 2>/dev/null && _fb_old=1
# THE SHARE A WINDOW SHOWS (2026-10-19). Every session renders every minute (refreshInterval), idle or not, and its
# rate_limits carry the shares of ITS last API response (Claude Code keeps them per process, and the payload says nothing
# of when they were observed): an idle session's are days old, yet they were drawn, and written to the cache stamped as
# measured now over the share the active session had just measured (three sessions wrote 49, 0 and 43 in turn). So every
# reading is DATED: a payload share by its session's last reply (_sd below), this render's account pull by now, the
# cached share by its *_at. Each window draws, and the cache keeps, the FRESHEST reading of its LATEST window, the larger
# share between two equally dated. Not the largest share: a share can drop within a window (a plan upgrade, an early
# reset, a promotion that raises the limit), and the pull, a reading of the account now, must be able to say so. An
# undated reading ranks below every dated one. A cached share belongs to the window that ran when it was stamped, so one
# stamped before the window began is the last window's. Two resets name one window when they are under half a period
# apart: consecutive windows' resets are a period or more apart, and the account's carry fractional seconds where the
# payload's are whole. A later window replaces an earlier one whatever its date; with no reset known at all, every share
# is of the one unknown window. A cached stamp ahead of this clock counts as now; one more than five minutes
# (USAGE_STALE_MS) ahead, which a clock set back leaves, still places its share in the window and after its reset, as
# OAK's other readouts take it, but ranks it as undated, below every dated reading.
# AN ENDED 5H WINDOW IS OVER. A 5h window starts only with the first message after the last one ended, so a passed 5h
# reset rolled forward by whole periods named a window that does not exist (`0% · 48m` after a night with no use, for
# a window that had begun a minute earlier). Once the latest known 5h reset has passed and nothing reports a newer
# window (a payload share with a later reset, or a pull with a reset), the share is 0 with no countdown. Its cache reads
# are not drawn either: with no reset to anchor on, the scan counts the last five hours, the ended window's. A share
# above 0 measured after that anchor with no reset of its own (from a Claude Code that sends no resets_at, as 2.1.263
# did) still rolls it forward; a cached one does not once this render's pull answers that no 5h window runs (0, no
# reset), as OAK's own pull records that answer. The weekly window is a fixed schedule and always rolls.
# pick_win PERIOD ENDS SHARE RESET DATE PULL PULL_RESET CACHED CACHED_AT CACHED_RESET, resets and dates as epochs, ENDS
#   1 for 5h -> _wp/_wr: the share and reset drawn ('' for none); _wn/_wd: the share the cache takes and the date it is
#   stamped with, the reading's own ('' keeps the cached share and its stamp; an undated payload share has no date
#   here, is stamped now by the write, and wins only where nothing else is known); _wa: the latest known reset, the
#   anchor the cache keeps; _wc: 1 when the share drawn is undated, or dated more than USAGE_STALE_MS (300 s) before
#   this render: it never calibrates the estimate; _wx: 1 when the 5h window has ended. No subshell but roll_fwd's:
#   shares carry decimals, so _gt compares them as integer millionths.
_mil() { local v=$1 f=000000; case "$v" in ''|*[!0-9.]*|*.*.*) v=0 ;; esac
  case "$v" in *.*) f="${v#*.}000000" ;; esac; v=${v%%.*}; _mv=$(( 10#${v:-0} * 1000000 + 10#${f:0:6} )); }
_gt() { local x; _mil "$1"; x=$_mv; _mil "$2"; [ "$x" -gt "$_mv" ]; }
# _fresher SHARE DATE BEST BEST_DATE: a reading beats the best so far: dated over undated, then the later date, then,
# between two equally dated or both undated, the larger share.
_fresher() { if [ -z "$4" ]; then [ -n "$2" ] || _gt "$1" "$3"; elif [ -z "$2" ]; then return 1
  elif [ "$2" -ne "$4" ]; then [ "$2" -gt "$4" ]; else _gt "$1" "$3"; fi; }
pick_win() { local per=$1 ends=$2 sp=$3 sr=$4 sd=$5 ap=$6 ar=$7 cp=$8 ca=${9%.*} cr=${10} r="" v best="" bd="" src="" cu=""
  _wp=""; _wr=""; _wn=""; _wd=""; _wc=""; _wx=""
  case "$ca" in *[!0-9]*) ca="" ;; esac
  if [ -n "$ca" ] && [ "$ca" -gt "$_nowe" ]; then [ "$ca" -gt $(( _nowe + 300 )) ] && cu=1; ca=$_nowe; fi
  for v in "$sr" "$ar" "$cr"; do if [ -n "$v" ] && { [ -z "$r" ] || [ "$v" -gt "$r" ]; }; then r=$v; fi; done
  _wa=$r
  if [ -n "$r" ] && [ "$r" -le "$_nowe" ]; then
    if [ "$ends" = 1 ] && ! { [ -z "$sr" ] && _gt "$sp" 0 && { [ -z "$sd" ] || [ "$sd" -gt "$r" ]; }; } \
      && ! { [ -n "$ca" ] && [ "$ca" -gt "$r" ] && _gt "$cp" 0 && ! { [ "$ap" = 0 ] && [ -z "$ar" ]; }; }; then
      _wp=0; _wx=1; if [ -n "$sp" ] || [ -n "$ap" ]; then _wn=0; _wd=$_nowe; fi; return 0
    fi
    r=$(roll_fwd "$r" "$per")
  fi
  _wr=$r
  if [ -n "$cp" ] && { [ -z "$r" ] || { [ -n "$ca" ] && [ "$ca" -ge $(( r - per )) ]; }; }; then best=$cp; bd=$ca; [ -z "$cu" ] || bd=""; src=c; fi
  if [ -n "$sp" ] && { { [ -n "$sr" ] && [ $(( r - sr )) -lt $(( per / 2 )) ]; } || { [ -z "$sr" ] && { [ -z "$r" ] || [ -z "$sd" ] || [ "$sd" -ge $(( r - per )) ]; }; }; } \
    && { [ -z "$src" ] || _fresher "$sp" "$sd" "$best" "$bd"; }; then best=$sp; bd=$sd; src=s; fi
  if [ -n "$ap" ] && { [ -z "$r$ar" ] || { [ -n "$ar" ] && [ $(( r - ar )) -lt $(( per / 2 )) ]; }; } \
    && { [ -z "$src" ] || _fresher "$ap" "$_nowe" "$best" "$bd"; }; then best=$ap; bd=$_nowe; src=a; fi
  _wp=$best; case "$src" in s|a) _wn=$best; _wd=$bd ;; esac
  if [ -n "$src" ] && { [ -z "$bd" ] || [ $(( _nowe - bd )) -gt 300 ]; }; then _wc=1; fi
  return 0; }
# The cached share, stamp and reset of each window, and when the account last answered with no 5h window and with one
# (no_five), in one jq.
_c5p=""; _c5a=""; _c5r=""; _c7p=""; _c7a=""; _c7r=""; _c5n=""; _c5s=""
{ IFS= read -r _c5p; IFS= read -r _c5a; IFS= read -r _c5r; IFS= read -r _c7p; IFS= read -r _c7a; IFS= read -r _c7r; IFS= read -r _c5n; IFS= read -r _c5s; } < <(jq -r '
  ((.five_pct | numbers) // ""), ((.five_at | numbers) // ""), ((.five_reset | select(type == "number" or type == "string")) // ""),
  ((.week_pct | numbers) // ""), ((.week_at | numbers) // ""), ((.week_reset | select(type == "number" or type == "string")) // ""),
  ((.five_none_at | numbers) // ""), ((.five_seen_at | numbers) // "")' \
  "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline-last.json" 2>/dev/null)
# When THIS session last replied, which dates the shares its payload carries: the timestamp of the transcript's last
# assistant entry, from its last megabyte whatever the transcript's size, its matching lines read from the end (awk
# reverses them) to the first that parses as one: fromjson? skips the line the tail cut in two and one still being
# written, and a line that only nests an assistant record (an agent's progress, a tool's structured result) is not one,
# however many follow the reply. It stops there by recursing over input: first() or limit() around a try does not stop
# in jq 1.6, which printed every reply in the tail. grep and awk run in the C locale, where every byte is a character:
# one the tail cut in two is no encoding error to either. Not the file's mtime: an idle transcript is touched without a
# reply (one moved to today, its last reply six days old). A subagent writes its turns to its own transcript
# (<session>/subagents/agent-<id>.jsonl, a workflow's under subagents/workflows/wf_<id>/), and its API responses update
# the shares while the session waits on it, the session's own last reply the spawn: the newest of those transcripts by
# mtime (bash's own -nt over the glob, in a subshell in the C locale: an `ls -t` given every name did not run once the
# names passed the system's argument limit, ARG_MAX, and read QUOTING_STYLE and CLICOLOR_FORCE; with 3,000 of them,
# sorting their names a UTF-8 locale's way took 45 ms) is read the same way, and the later reply dates the shares.
# Empty when no reply is found: the share is then undated.
_lr() { _lv=$(tail -c 1048576 "$1" 2>/dev/null | LC_ALL=C grep -F '"type":"assistant"' | LC_ALL=C awk '{ l[NR] = $0 } END { for (i = NR; i > 0; i--) print l[i] }' | jq -Rrn \
    'def r: (try input catch null) as $l | if $l == null then empty else (($l | fromjson? | select(type == "object" and .type == "assistant") | .timestamp | strings | sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601?) // r) end; r' 2>/dev/null)
  _lv=${_lv%.*}; case "$_lv" in *[!0-9]*) _lv="" ;; esac; }
_sd=""
if { [ -n "$five_pct" ] || [ -n "$week_pct" ]; } && [ -n "$tp" ] && [ -f "$tp" ]; then
  _lr "$tp"; _sd=$_lv
  if [ -d "${tp%.jsonl}/subagents" ]; then
    _sa=$(LC_ALL=C; n=""; for f in "${tp%.jsonl}"/subagents/agent-*.jsonl "${tp%.jsonl}"/subagents/workflows/*/agent-*.jsonl; do
      [ "$f" -nt "$n" ] && n=$f; done; printf '%s' "$n")
    if [ -n "$_sa" ]; then _lr "$_sa"; if [ -n "$_lv" ] && { [ -z "$_sd" ] || [ "$_lv" -gt "$_sd" ]; }; then _sd=$_lv; fi; fi
  fi
  [ -n "$_sd" ] && [ "$_sd" -gt "$_nowe" ] && _sd=$_nowe
fi
# Both windows, once this render's pull (if any) is in. A share dated more than five minutes before this render, or not
# dated at all, never calibrates the estimate, whatever its source (`_carried` names its windows for the estimator): it
# can predate tokens the scan counts, and a share an hour old with that hour's tokens since read twice the
# tokens-per-percent, which the smoothing then carried into every later figure.
pick_windows() { _carried=""
  pick_win 18000 1 "$five_pct" "$(to_epoch "$five_reset")" "$_sd" "${api_five_pct:-}" "${api_five_reset:-}" "$_c5p" "$_c5a" "$(to_epoch "$_c5r")"
  five_pct=$_wp; five_reset=$_wr; _w5p=$_wn; _w5d=$_wd; _w5r=$_wa; _x5=$_wx; [ -z "$_wc" ] || _carried=5
  no_five
  pick_win 604800 0 "$week_pct" "$(to_epoch "$week_reset")" "$_sd" "${api_week_pct:-}" "${api_week_reset:-}" "$_c7p" "$_c7a" "$(to_epoch "$_c7r")"
  week_pct=$_wp; week_reset=$_wr; _w7p=$_wn; _w7d=$_wd; _w7r=$_wa; [ -z "$_wc" ] || _carried="${_carried}7"; }
# NO FIVE-HOUR LIMIT (2026-10-30). An account usage answer that carries the weekly window and no 5h window (`five_hour`
# null or missing, or its utilization null) is an account with no five-hour limit, as Claude Code's own usage view reads
# it: it draws no Current session bar for one. Verified Ultra accounts answer so. Only these answers decide it, never a
# share: the cache records when the account last answered with no 5h window (five_none_at) and when it last answered
# with one (five_seen_at), as OAK's own pull does, and the account has no five-hour limit while the newest no-limit
# answer is at least as new as the newest answer with a 5h window. This render's pull, when it ran, is the newest answer
# there is; else core's reading (_m5n), which weighs the saved machines' answers too; else the cache's two. While it holds
# (_n5), the line draws no 5h segment at all and records no 5h share, whatever share its input, the cache or a saved
# machine has. A payload with the weekly window and no five_hour is no such answer: Claude Code leaves a 5h window out of
# its input once the window's reset has passed, so an account whose 5h window has ended sends one too.
_n5=""
no_five() { local n=${_c5n%.*} s=${_c5s%.*}
  case "$n" in *[!0-9]*) n="" ;; esac; case "$s" in *[!0-9]*) s="" ;; esac
  if [ -n "${api_five_none:-}" ]; then _n5=1
  elif [ -n "${api_five_pct:-}" ]; then _n5=""
  elif [ -n "${_m5n:-}" ]; then [ "$_m5n" = 1 ] && _n5=1
  elif [ -n "$n" ] && ! { [ -n "$s" ] && [ "$s" -gt "$n" ]; }; then _n5=1; fi
  if [ -n "$_n5" ]; then five_pct=""; five_reset=""; _w5p=""; fi
  return 0; }
# No rate_limits gate. rate_limits.* is sent ONLY for Claude.ai subscription plans, so gating the scan
# on it meant an Enterprise or API account — which has no rolling windows to report — got no usage
# readout at all, when the tokens it burned sit in the very same transcripts everyone else scans.
# The scan is what produces the MEASURED totals; the percentages only calibrate the ~estimate on top.
if command -v python3 >/dev/null 2>&1; then
  CFG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  # WINDOW ANCHORS SURVIVE PAYLOAD GAPS (2026-09-03). rate_limits is absent on a session's first
  # render, and the scan then anchors "the last 7 days from now" — a span that straddles TWO
  # account windows, so the exported measurement overstates the current one (measured live: the
  # Mac exported 17.07M for a window whose true spend was ~6.3M, and the cross-machine estimate
  # ran ~1.6x high on the other box). A reset time is ABSOLUTE and stays valid until it passes,
  # so an empty one falls back to the cached value from the last render that had it.
  # REAL WINDOW DATA from the account itself (2026-09-08): the same OAuth session can ask the
  # usage endpoint the desktop app reads — true resets plus the per-model "Fable" weekly cap.
  # EVERY machine pulls independently: Linux reads the credentials file;
  # macOS reads Claude Code's keychain item (the first read may show one keychain prompt —
  # "Always Allow" makes it permanent; a locked keychain fails fast and silently). At most every
  # 5 minutes, 4 seconds of budget, silent on any failure. Its shares are dated now, the freshest
  # reading there is, so they replace an older one of the same window even when lower (pick_win).
  # Every machine asks for itself. Where this machine has no current reading, the line draws the saved
  # machine's reading of the same account that OAK's own readouts show (A SAVED MACHINE'S READING, below).
  api_five_reset=""; api_week_reset=""; api_five_pct=""; api_week_pct=""; fable_pct=""; fable_reset=""; fable_label=""; api_ts_new=""; api_five_none=""
  _slj="$CFG_DIR/statusline-last.json"
  if command -v curl >/dev/null 2>&1; then
    _ats=$(jq -r '.api_ts // 0' "$_slj" 2>/dev/null); _ats=${_ats%.*}
    if [ $(( _nowe - ${_ats:-0} )) -ge "${STATUSLINE_USAGE_API_TTL:-300}" ]; then
      _cred=""
      if [ -f "$CFG_DIR/.credentials.json" ]; then _cred=$(cat "$CFG_DIR/.credentials.json" 2>/dev/null)
      elif [ "$(uname)" = "Darwin" ]; then _cred=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null); fi
      _tok=$(printf '%s' "$_cred" | jq -r 'if (.claudeAiOauth.expiresAt // 0) > (now * 1000) then .claudeAiOauth.accessToken else empty end' 2>/dev/null)
      _cred=""
      if [ -n "$_tok" ]; then
        _usage=$(curl -sf -m 4 -H "Authorization: Bearer $_tok" -H "anthropic-beta: oauth-2025-04-20" \
          "${STATUSLINE_USAGE_API_URL:-https://api.anthropic.com/api/oauth/usage}" 2>/dev/null)
        _tok=""
        # NO 5H WINDOW RUNNING IS AN ANSWER (2026-10-19): a 5h window whose resets_at is null, beside the weekly window an
        # account with rolling limits reports, is no 5h window running: share 0, no reset. NO 5H WINDOW AT ALL (2026-10-30):
        # `five_hour` null or missing, or its utilization null, beside the weekly window, is an account with no five-hour
        # limit (no_five): no 5h share or reset, and the cache records when; an answer with a 5h window records when too.
        # The week and Fable beside either still count; the gate dropped the whole answer when `five_hour` was null. The
        # weekly window is its share or its reset, as OAK's pull reads it: beside no 5h window, one with a share and no reset
        # was dropped whole. An answer with neither window (no rolling limits) is still not used.
        if [ -n "$_usage" ] && printf '%s' "$_usage" | jq -e '(.five_hour | type) == "object" or (.five_hour == null and ((.seven_day | objects | (.utilization // .resets_at)) // null) != null)' >/dev/null 2>&1; then
          api_five_reset=$(to_epoch "$(printf '%s' "$_usage" | jq -r '.five_hour.resets_at // empty')")
          api_week_reset=$(to_epoch "$(printf '%s' "$_usage" | jq -r '.seven_day.resets_at // empty')")
          # The account's own shares too: with a new reset beside it, an old share read as this window's.
          api_five_pct=$(printf '%s' "$_usage" | jq -r 'if ((.five_hour | objects | .utilization) // null) == null and ((.seven_day | objects | (.utilization // .resets_at)) // null) != null then "none"
            elif .five_hour.resets_at == null and ((.seven_day | objects | .resets_at) // null) != null then 0 else (.five_hour.utilization // empty) end')
          [ "$api_five_pct" = none ] && { api_five_pct=""; api_five_reset=""; api_five_none=1; }
          api_week_pct=$(printf '%s' "$_usage" | jq -r '.seven_day.utilization // empty')
          fable_pct=$(printf '%s' "$_usage" | jq -r '[.limits[]? | select(.kind == "weekly_scoped")][0].percent // empty')
          fable_reset=$(to_epoch "$(printf '%s' "$_usage" | jq -r '[.limits[]? | select(.kind == "weekly_scoped")][0].resets_at // empty')")
          fable_label=$(printf '%s' "$_usage" | jq -r '[.limits[]? | select(.kind == "weekly_scoped")][0].scope.model.display_name // empty')
          api_ts_new="$_nowe"
        fi
      elif command -v oak >/dev/null 2>&1; then
        # The stored token has LAPSED (or credentials are unreadable here). The CLI puller
        # refreshes the login the way claude does — token endpoint + rotation written back —
        # and merges fresh usage into this same cache. ONE implementation of that delicate
        # flow; this script never re-implements it. Detached: the line renders now, the next
        # render reads the refreshed cache. Same TTL gate as the inline fetch above.
        (oak usage --pull-account --json >/dev/null 2>&1 &)
      fi
    fi
  fi
  pick_windows  # each window's reset and share, now that this render's pull (if any) is in
  # Capture into a var, THEN here-string it. Never feed a heredoc-bearing command substitution
  # straight into a read here-string: macOS ships bash 3.2 as /bin/bash, and 3.2 cannot parse a
  # heredoc nested inside a double-quoted command substitution inside a here-string — it aborts the
  # WHOLE script with an unexpected-EOF error, so the status line never runs and its usage cache goes
  # stale. A plain assignment holding the heredoc parses everywhere.
  _fbp_py="${fable_pct:-}"
  [ -z "$_fbp_py" ] && [ -z "$_fb_old" ] && _fbp_py=$(jq -r '.fable_pct // empty' "$_slj" 2>/dev/null)
  _uest=$(python3 - "$CFG_DIR/statusline-usage.json" "$CFG_DIR/projects" \
      "${five_pct:-0}" "${five_reset:-0}" "${week_pct:-0}" "${week_reset:-0}" "${_fbp_py:-0}" "${_carried:-}" "${_mx:-}" "${_mt:-}" 2>/dev/null <<'PYEOF'
import sys, os, json, glob, time, datetime, signal, re
sp, proj = sys.argv[1], sys.argv[2]
def f(x):
    try: return float(x)
    except Exception: return 0.0
def fts(x):
    # A reset time arrives as epoch seconds, epoch ms, or ISO-8601 (seen inside Linux containers).
    # float() alone zeroed the ISO form, silently un-anchoring every window on such clients.
    v = f(x)
    if v > 1e12: return v / 1000.0
    if v: return v
    try:
        sx = str(x).strip()
        if sx.endswith('Z'): sx = sx[:-1] + '+00:00'
        return datetime.datetime.fromisoformat(sx).timestamp()
    except Exception: return 0.0
p5, r5, p7, r7 = f(sys.argv[3]), fts(sys.argv[4]), f(sys.argv[5]), fts(sys.argv[6])
pF = f(sys.argv[7]) if len(sys.argv) > 7 else 0.0
# The windows (5, 7) whose share was measured more than five minutes before this render, or is undated: drawn, never calibrated from.
CARRIED = sys.argv[8] if len(sys.argv) > 8 else ''
now, W5, W7, THR = (float(os.environ.get('STATUSLINE_NOW') or 0) or time.time()), 5*3600, 7*86400, 600
try: st = json.load(open(sp))
except Exception: st = {}
# State v2 = deduped + origin-aware totals. Older state was measured WITHOUT the message-id dedup
# below (2.5-3x high, measured) and its cached per-file sums and calibration would keep that error
# alive forever — a stale figure on disk is indistinguishable from a correct one, so drop it whole.
if st.get('v') != 2: st = {}
tpp5 = st.get('tpp5', 0.0); tpp7 = st.get('tpp7', 0.0)
tppE5 = st.get('tppE5', 0.0); tppE7 = st.get('tppE7', 0.0)  # smoothed over time (EWMA)
L30 = st.get('L30', 0.0); U30 = st.get('U30', 0.0)
W30 = 2592000
cpp5 = st.get('cpp5', 0.0); cpp7 = st.get('cpp7', 0.0)      # dollars-per-percent, same treatment
tppF = st.get('tppF', 0.0)  # tokens-per-percent for the per-model (fable) weekly cap
L5 = st.get('L5', 0.0); L7 = st.get('L7', 0.0)
U5 = st.get('U5', 0.0); U7 = st.get('U7', 0.0)
fc = st.get('fc', {}); last = st.get('last_scan', 0)
# THE 5H WINDOW THE LAST SCAN COUNTED: s5, the reset it anchored on (0: none, the last five hours). A scan runs every THR,
# and the 5h reads and totals it saved are that window's: beside a newer window, until the next scan, they were the last
# one's (`+30M↺` beside a window a minute old). A known 5h reset other than s5 scans now; a state from before s5 waits.
s5 = st.get('s5')
# THE ACCOUNT ACROSS ITS MACHINES (2026-10-27). The shares are the whole account, and each machine learned its tokens per
# percent from its own transcripts alone: a laptop beside a busy machine credited the whole share to its own few turns,
# and its budgets came out 14 times too small. argv[9] holds what the saved machines of this account measured of their
# own turns (core machineMeasured, one line of JSON from the oak usage call this render already makes): per window, the
# sum over each machine whose figures are of this account, of the window this machine is in and fresh, with that window
# (a reset in ms, the month by its bill cycle) and which machines it holds (their host hashes). A window is used only
# when it is the one this scan anchors on. Each machine counts only its own turns (own, below), so the sum counts a
# synced or forked transcript once, apart from the turns own cannot place (outside any home, or under a home path two
# machines share); and where this machine holds more than the sum (turns synced in from a machine OAK does not read),
# its own union stands, so with no saved machine, or none that counts, every figure is what it was.
def _n(v): return len([h for h in v['hosts'].split(',') if h]) if v else 0
def _ok(v, nums): return v if isinstance(v, dict) and isinstance(v.get('hosts'), str) and all(isinstance(v.get(k), (int, float)) and v.get(k) >= 0 for k in nums) else None
# Within a window the figures of the saved machines do not leave: a machine that stops answering keeps its last ones. A
# render whose oak call gave fewer of them than the last scan held, for the same window or none (the call failed, or
# read the login file caught mid-write), takes the figures of that scan (k_five, k_week, k_month), which the window
# checks below still judge. A scan that summed this machine alone put its own month in place of the account month until
# the next scan (18 percent read 0), and its sample took a tenth or more off each budget (half at half a week), which
# the smoothing took most of an hour to win back. For one scan only, a quarter of an hour: then a machine taken off the
# list, or signed in to another account, leaves the sum.
def _acct(key, same, *nums):
    try: v = _ok(json.loads(sys.argv[9]).get(key), nums)
    except Exception: v = None
    o, k = st.get('k_' + key), None
    if isinstance(o, list) and len(o) == 2 and 0 <= now - f(o[0]) < 900: k = _ok(o[1], nums)
    if _n(v): st['k_' + key] = [now, v]
    return k if _n(k) > _n(v) and (not v or same(k, v)) else v
def _same(v, r, per): return v if (v and r and abs(fts(v['reset']) - r) < per / 2) else None
def _one(per): return lambda a, b: abs(fts(a['reset']) - fts(b['reset'])) < per / 2
A5 = _same(_acct('five', _one(W5), 'tok', 'reads', 'cost', 'reset'), r5, W5)
A7 = _same(_acct('week', _one(W7), 'tok', 'reads', 'cost', 'fable', 'fableReads', 'reset'), r7, W7)
A30 = _acct('month', lambda a, b: (a['start'], a['reset']) == (b['start'], b['reset']), 'tok', 'reads', 'cost', 'start', 'reset')
# The smoothing below averages samples over renders. A sample that adds more saved machines than any it was calibrated
# with (n5, n7, nF: the most a calibration of that window has added) starts it over: averaged with figures that left
# those machines out, it took hours of renders to shed their error (the month read 100 percent long after the sum was
# right). A machine that drops out (its figures from an earlier window, or stale) and comes back smooths on as before.
G5, G7, GF = _n(A5) > f(st.get('n5')), _n(A7) > f(st.get('n7')), _n(A7) > f(st.get('nF'))
def ep(s):
    try:
        s = s.strip()
        if s.endswith('Z'): s = s[:-1] + '+00:00'
        return datetime.datetime.fromisoformat(s).timestamp()
    except Exception: return None
# Machine-of-origin for one transcript LINE, by the home directory its cwd sits under. Transcripts
# sync between this account s machines, so the same file can hold turns run on a Linux box
# (/home/<u>/...) and a Mac (/Users/<u>/...) — and a scan that counts every line makes each machine
# report the OTHER machines work as its own, which double-counts the moment the per-machine numbers
# are added up. Per LINE, not per file: one session resumed across machines splits correctly. A cwd
# under no recognizable home (or an unreadable one) counts as ours — under-claiming a foreign line
# is a smaller lie than dropping a local one. Two machines with the SAME home spelling (two Linux
# boxes, one username) cannot be told apart this way; their overlap still double-counts.
_HOMES = (re.compile(r'^(/(?:home|Users)/[^/]+)(?:/|$)'), re.compile(r'^([A-Za-z]:[\\/]Users[\\/][^\\/]+)(?:[\\/]|$)'))
def homeroot(p):
    for rx in _HOMES:
        m = rx.match(p or '')
        if m: return m.group(1).replace('\\', '/')
    return ''
MYROOT = homeroot(os.path.expanduser('~'))
def own(cwd):
    r = homeroot(cwd)
    return (not r) or (not MYROOT) or (r == MYROOT)
# API list prices per 1M tokens and the rules that pick one: a mirror of packages/core/src/pricing.ts modelRate and
# priceUsage; keep the two in sync (a test runs the same ids through both). A rate is (input, output, 5-minute write,
# 1-hour write, read, long tier, fast, US-only 1.1x, approx): the long tier (over, input, output, 5m write, 1h write,
# read) prices a request whose prompt is over `over` tokens, fast is (input, output) in fast mode. The month $ figures
# are priced from these (list-price basis — the ledger only sees sessions that render a statusline, so it under-counts).
def _c(i, w, w1h, r, o, long=None, fast=None, geo=False): return (i, o, w, w1h, r, long, fast, geo, False)
# Rows without a cache write: OpenAI's (input, cached, output, and the same over 272K), and the providers'.
def _g(i, r, o, long=None): return (i, o, 0, 0, r, (272000, long[0], long[2], 0, 0, long[1]) if long else None, None, False, False)
_O45 = (5, 6.25, 10, 0.5, 25)
_O4 = (15, 18.75, 30, 1.5, 75)
_S4 = (3, 3.75, 6, 0.3, 15)
RATES = [
    ('claude-fable-5-1', _c(10, 12.5, 20, 0.25, 50, geo=True)),
    ('claude-fable-5', _c(10, 12.5, 20, 1, 50, geo=True)),
    ('claude-mythos-5-1', _c(10, 12.5, 20, 0.25, 50, geo=True)),
    ('claude-mythos-5', _c(10, 12.5, 20, 1, 50, geo=True)),
    ('claude-opus-5-5', _c(4, 5, 8, 0.2, 20, fast=(8, 40), geo=True)),
    ('claude-opus-5', _c(*_O45, fast=(10, 50), geo=True)),
    ('claude-opus-4-8', _c(*_O45, fast=(10, 50), geo=True)),
    ('claude-opus-4-7', _c(*_O45, geo=True)),
    ('claude-opus-4-6', _c(*_O45, geo=True)),
    ('claude-opus-4-5', _c(*_O45)),
    ('claude-opus-4-1', _c(*_O4)),
    ('claude-opus-4', _c(*_O4)),
    ('claude-sonnet-5-5', _c(2, 2.5, 4, 0.1, 10, geo=True)),
    ('claude-sonnet-5', _c(2, 2.5, 4, 0.2, 10, geo=True)),
    ('claude-sonnet-4-6', _c(*_S4, geo=True)),
    ('claude-sonnet-4-5', _c(*_S4)),
    ('claude-sonnet-4', _c(*_S4)),
    ('claude-haiku-5-5', _c(0.1, 0.125, 0.2, 0.01, 0.5, long=(100000, 0.5, 2.5, 0.625, 1, 0.05), geo=True)),
    ('claude-haiku-4-5', _c(1, 1.25, 2, 0.1, 5)),
    ('claude-3-5-sonnet', _c(*_S4)),
    ('claude-3-5-haiku', _c(0.8, 1, 1.6, 0.08, 4)),
]
GPT_RATES = [
    ('gpt-6-astra', _g(10, 1, 50, (20, 2, 75))),
    ('gpt-6.1-sol', _g(2, 0.1, 10, (4, 0.2, 15))),
    ('gpt-6.1-terra', _g(1, 0.05, 5, (2, 0.1, 7.5))),
    ('gpt-6-sol', _g(2, 0.2, 10, (4, 0.4, 15))),
    ('gpt-6-luna', _g(0.1, 0.01, 0.5, (0.2, 0.02, 0.75))),
    ('gpt-5.6-sol', _g(4, 0.4, 20, (8, 0.8, 30))),
    ('gpt-5.6-terra', _g(2, 0.2, 12, (4, 0.4, 18))),
    ('gpt-5.6-luna', _g(0.2, 0.02, 1.2, (0.4, 0.04, 1.8))),
    ('gpt-5.5-pro', _g(30, 30, 180, (60, 60, 270))),
    ('gpt-5.5', _g(5, 0.5, 30, (10, 1, 45))),
    ('gpt-5.4-pro', _g(30, 30, 180, (60, 60, 270))),
    ('gpt-5.4-mini', _g(0.75, 0.075, 4.5)),
    ('gpt-5.4-nano', _g(0.2, 0.02, 1.25)),
    ('gpt-5.4', _g(2.5, 0.25, 15, (5, 0.5, 22.5))),
    ('gpt-5.2-pro', _g(21, 21, 168)),
    ('gpt-5.2-codex', _g(1.75, 0.175, 14)),
    ('gpt-5.2', _g(1.75, 0.175, 14)),
    ('gpt-5.1', _g(1.25, 0.125, 10)),
    ('gpt-5-pro', _g(15, 15, 120)),
    ('gpt-5-mini', _g(0.25, 0.025, 2)),
    ('gpt-5-nano', _g(0.05, 0.005, 0.4)),
    ('gpt-5', _g(1.25, 0.125, 10)),
]
# Priced only under the provider named: mirror of pricing.ts PROVIDER_RATES.
PROVIDER_RATES = {
    'openrouter': {
        'poolside/laguna-s-2.1': _g(0.09, 0.009, 0.18),
        'poolside/laguna-xs-2.1': _g(0.06, 0.03, 0.12),
        'thinkingmachines/inkling': _g(1, 0.17, 4.05),
        'thinkingmachines/inkling-small': _g(0.45, 0.1, 1.2),
    },
}
_UNPRICED = (0, 0, 0, 0, 0, None, None, False, True)
_FREE = _g(0, 0, 0)
_DATED = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}')
# A Claude id's family and version, as pricing.ts claudeVersion reads it; a GPT id's version and suffix.
_CFAM = re.compile(r'(fable|mythos|opus|sonnet|haiku)(?:-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?)?')
_COLD = re.compile(r'(\d)(?:-(\d))?-(sonnet|haiku|opus)')
def _cver(n):
    o = _COLD.search(n)
    if o: return (o.group(3), (int(o.group(1)), int(o.group(2) or 0)))
    f = _CFAM.search(n)
    return (f.group(1), (int(f.group(2)), int(f.group(3) or 0)) if f.group(2) else None) if f else None
def _gver(m):
    g = re.match(r'^gpt-(\d+)(?:\.(\d+))?(.*)$', re.sub(r'-\d{4}-\d{2}-\d{2}$', '', m))
    return ((int(g.group(1)), int(g.group(2) or 0)), g.group(3)) if g else None
_CROWS = sorted([(_cver(k), v) for k, v in RATES], key=lambda x: x[0][1], reverse=True)
_GROWS = sorted([(_gver(k), v) for k, v in GPT_RATES], key=lambda x: x[0][0], reverse=True)
def _exact(table, m):
    for _p, _r in table:
        if m == _p or (m.startswith(_p + '-') and _DATED.fullmatch(m[len(_p) + 1:])): return _r
    return None
# One answer per model id: scan() asks for every usage line, and the rules below are regexes. (Local fix.)
import functools
@functools.lru_cache(maxsize=None)
def _rate(m):
    m = re.sub(r'\[[^\]]*\]$', '', (m or '').strip().lower())
    via = re.match(r'^provider:([^/]+)/(.+)$', m)
    if via and via.group(2) in PROVIDER_RATES.get(via.group(1), {}): return PROVIDER_RATES[via.group(1)][via.group(2)]
    if via and via.group(1) == 'openrouter' and via.group(2).endswith(':free'): return _FREE
    if via: return _UNPRICED
    _r = _exact(GPT_RATES, m) or _exact(RATES, m)
    if _r: return _r
    # Display names, undashed dated ids and provider-prefixed ids (Bedrock us.anthropic.claude-...,
    # Vertex claude-...@date) read as family and version, after spaces, dots and @ become dashes. A version no row
    # lists takes the family's newest row at or below it, approx.
    c = _cver(re.sub(r'[\s.@]+', '-', m))
    rows = [x for x in _CROWS if c and x[0][0] == c[0]]
    for x in rows:
        if c[1] and x[0][1] == c[1]: return x[1]
    if rows and not m.startswith('provider:') and ('claude' in m or re.match(r'(opus|sonnet|haiku|fable)', m)):
        return next((x for x in rows if not c[1] or x[0][1] <= c[1]), rows[-1])[1][:-1] + (True,)
    # Anything else outside these families (a gateway or local model behind ANTHROPIC_BASE_URL) has no
    # list price here: it adds nothing, rather than an invented dollar figure. Nor has gpt-oss, the
    # open-weight model, outside a provider's table.
    if m.startswith(('provider:', 'gpt-oss')) or not re.match(r'(gpt|o[134]|codex|claude|opus|sonnet|haiku|fable)', m): return _UNPRICED
    if re.match(r'(gpt|o[134]|codex)', m):
        g = _gver(m)
        hit = g and (next((x for x in _GROWS if x[0][1] == g[1] and x[0][0] <= g[0]), None)
                     or next((x for x in _GROWS if x[0][1] == '' and x[0][0] == g[0]), None)
                     or next((x for x in _GROWS if x[0][1] == '' and x[0][0] <= g[0]), None))
        return (hit[1] if hit else GPT_RATES[-1][1])[:-1] + (True,)
    return _c(*_O45)[:-1] + (True,)  # family fallback (opus 4.5-5 tier)
# One request's list price, as pricing.ts priceUsage: the long tier for the whole request when its prompt is over
# the tier's bound; 1-hour writes at their rate (an unsplit record prices every write at 5 minutes); fast mode and
# US-only inference where the record states them.
def _cost(m, i, o, cw, cw1h, cr, speed=None, geo=None):
    b = _rate(m)
    r = b[5][1:] if b[5] and i + cr + cw > b[5][0] else b[:5]
    w1 = min(cw, max(0, cw1h or 0))
    fi, fo = (b[6][0] / b[0], b[6][1] / b[1]) if speed == 'fast' and b[6] else (1, 1)
    g = 1.1 if geo == 'us' and b[7] else 1
    return g * (fi * (i * r[0] + (cw - w1) * r[2] + w1 * r[3] + cr * r[4]) + fo * o * r[1]) / 1e6

def scan(path, since, gids=None):
    # Collects {id: [tokens, own, line-ts]} for every usage line at/after `since`. One assistant
    # message is written as SEVERAL transcript lines sharing message.id — and the later lines carry
    # a LARGER output_tokens (the stream completing) — so the merge keeps the biggest snapshot per
    # id, never the first or a blind sum (blind summing measured 2.5-3x the truth). Ids also recur
    # across FILES (forks/resumes copy history), so the caller merges maps globally. The TIMESTAMP
    # rides each entry so one wide (month) map answers every narrower window afterwards. Lines
    # without an id get a synthetic per-line key — unique, so they sum; stable, so a cached map
    # replays identically.
    ids = {} if gids is None else gids
    n = 0
    try:
        for ln in open(path, errors='ignore'):
            n += 1
            if '"usage"' not in ln: continue
            try: o = json.loads(ln)
            except Exception: continue
            if not isinstance(o, dict): continue  # a top-level array aborted the file and CACHED the partial sum
            m = o.get('message') or {}
            u = m.get('usage')
            if not u: continue
            e = ep(o.get('timestamp', '') or '')
            if e is None or e < since: continue
            _i = u.get('input_tokens', 0) or 0
            _o = u.get('output_tokens', 0) or 0
            _cw = u.get('cache_creation_input_tokens', 0) or 0
            _cr = u.get('cache_read_input_tokens', 0) or 0
            _cc = u.get('cache_creation')
            _cw1 = _cc.get('ephemeral_1h_input_tokens') if isinstance(_cc, dict) else None
            t = _i + _o + _cw
            w = 1 if own(o.get('cwd') or '') else 0
            mid = m.get('id') or (path + '#' + str(n))
            prev = ids.get(mid)
            if prev is None or t > prev[0] or (t == prev[0] and e < prev[2]):
                _mdl = (m.get('model') or '').lower()
                # Top-tier family flag, for the account's per-model weekly cap (fable/mythos
                # share the tier). Rides each entry so the window loop can split without a
                # second parse.
                _fb = 1 if ('fable' in _mdl or 'mythos' in _mdl) else 0
                ids[mid] = [t, w, e, _cr, _cost(_mdl, _i, _o, _cw, _cw1, _cr, u.get('speed'), u.get('inference_geo')), _fb]
    except Exception: pass
    return ids
# THE ACCOUNT TOTALS FROM THE OAK INDEX (0.11.0). The oak usage read above counts each message once across every machine
# whose usage the local index holds (core index/usage.ts: this machine and each machine that oak sync or the usage pull
# brings, and what a saved machine that answers only with its readings measured of its own turns), for the 5h, weekly and
# bill-cycle windows its readout places; argv[10] carries them. When the 5h and weekly
# ones are of the windows this render anchors on (a reset under half a period from its own, or no reset on either side)
# and the month of the same bill cycle, they stand in for the scan: no file is read and no file map is kept. They are the
# account totals already, so no saved machine figures are added to them. Otherwise (an oak without the index, or a window
# that turned over between the two reads) the scan runs as before. Either is read at the scan cadence (THR), and so is the
# calibration; a render between two reads draws the last one, as before, but for the first render with the totals after a
# scan, which drops the file map the scan kept.
def _totals():
    try: v = json.loads(sys.argv[10]) if len(sys.argv) > 10 and sys.argv[10] else None
    except Exception: return None
    # Totals of an index still catching up (its first build running) hold part of the account: the scan, then.
    if not isinstance(v, dict) or v.get('caughtUp') is False: return None
    def win(k):
        w = v.get(k)
        return w if isinstance(w, dict) and all(isinstance(w.get(x), (int, float)) and w.get(x) >= 0 for x in ('tokens', 'cacheRead', 'cost', 'start', 'end')) else None
    t = {k: win(k) for k in ('five', 'week', 'month')}
    return t if all(t.values()) else None
def _anchored(w, r, per):
    rs = fts(w.get('reset')) if w.get('reset') is not None else 0
    return (not r and not rs) or (bool(r) and bool(rs) and abs(rs - r) < per / 2)
TOT = _totals()
if TOT and not (_anchored(TOT['five'], r5, W5) and _anchored(TOT['week'], r7, W7)): TOT = None
# `r5 or r7` used to be required here too. Without a reset time the windows simply anchor at now
# (see ws5/ws7 below), which is exactly right for a plan that has no reset to anchor to.
_scanned = False
_due = (now - last) >= THR or not st or (r5 and s5 is not None and abs(r5 - s5) > 60)
_hadfc = bool(fc)
if _due or (TOT and _hadfc):
    # BaseException, NOT Exception: nearly all scan wall-time is inside scan(), whose broad
    # except Exception swallowed the alarm — so the 12s cap did not cap, and a partial per-file count
    # could be persisted into fc under a stable key. BaseException passes through untouched, reaches
    # the TO handler below, and the state dump there is what keeps later renders from re-paying the
    # timeout. The alarm seconds are env-tunable so a test can exercise this path deterministically.
    class TO(BaseException): pass
    class _Wait(BaseException): pass
    try: signal.signal(signal.SIGALRM, lambda *a: (_ for _ in ()).throw(TO())); signal.alarm(int(os.environ.get("STATUSLINE_SCAN_ALARM", "12")))
    except Exception: pass
    _scanned = _due
    ws5 = (r5 - W5) if r5 else now - W5
    # No reset clock (Enterprise / API): a raw now-anchored ws7 moves every scan, so the (mtime, ws7)
    # cache key could never match twice and every 600s scan re-parsed the full week window (~1.3s,
    # forever, measured). Quantized to the hour, the key holds between scans and a full re-parse
    # happens once an hour; the readout drifts by at most the bucket width at the window edge, which
    # is honest for an estimate that has no true account window to disagree with.
    ws7 = (r7 - W7) if r7 else int((now - W7) // 3600 * 3600)
    try:
        # Message ids recur across FILES, not just lines — a forked or resumed session copies its
        # history into a NEW transcript, and the original stays on disk — so the dedup must span
        # every file in the window, cold ones included (measured live 2026-09-03: per-file dedup
        # ran one machine's week +45% and the other's +70%). The fc cache therefore stores each
        # cold file's ID MAP (id -> [tokens, own]), not a pre-summed number: sums cannot be
        # deduplicated after the fact. Totals come from the merged maps exactly once, at the end.
        def gmerge(g, ids):
            for mid, tw in ids.items():
                prev = g.get(mid)
                # Equal snapshots tie-break to the EARLIEST timestamp — a fork's copy carries the
                # original minting time, and window attribution must not depend on file order.
                if prev is None or tw[0] > prev[0] or (tw[0] == prev[0] and tw[2] < prev[2]): g[mid] = tw
        # ONE month-wide pass (the mo segment shows tokens too). The cache
        # horizon is DAY-quantized: an hourly key would invalidate every cached file each hour and
        # re-pay the full month parse; a day of drift on a ~month estimate is honest. The exact
        # ws5/ws7 cuts are applied per ENTRY (each carries its line's timestamp), so the weekly
        # and 5h figures stay anchored to the account's real resets.
        # The month is the BILL CYCLE, UTC (2026-09-03): Anthropic bills on the signup
        # anniversary and no payload carries the date, so the user states it once
        # (`oak usage --bill-day 10` -> prefs.json billDay); absent, the calendar 1st. Neither
        # vendor has a monthly usage quota to mirror (both run 5h + weekly; codex's monthly-limit
        # experiment was reverted), so the budget prorates by the cycle's REAL length x weekly/7.
        # A bill day past a month's end clamps to its last day, the way card billing does.
        # The bill day, best source first: the user's own statement (prefs.billDay), else the
        # account itself — Claude Code caches oauthAccount.subscriptionCreatedAt in its .claude.json
        # ($CLAUDE_CONFIG_DIR's when that is set, else the home's, as it places the file), and anniversary
        # billing renews on that day-of-month. Calendar 1st only when neither exists.
        _bd = 0
        try:
            _prefs = json.load(open(os.path.join(os.path.dirname(proj), 'claude-observatory', 'prefs.json'), encoding='utf-8-sig'))  # a byte order mark first, as OAK reads it
            _bdv = _prefs.get('billDay')
            if isinstance(_bdv, (int, float)) and 1 <= _bdv <= 31: _bd = int(_bdv)
        except Exception: pass
        if not _bd:
            try:
                _oa = (json.load(open(os.path.join(os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~'), '.claude.json'))).get('oauthAccount') or {})
                _sc = ep(str(_oa.get('subscriptionCreatedAt') or ''))
                if _sc: _bd = datetime.datetime.fromtimestamp(_sc, datetime.timezone.utc).day
            except Exception: pass
        if not _bd: _bd = 1
        import calendar as _cal
        def _cyc(y, mo):
            return int(datetime.datetime(y, mo, min(_bd, _cal.monthrange(y, mo)[1]), tzinfo=datetime.timezone.utc).timestamp())
        _g = datetime.datetime.fromtimestamp(now, datetime.timezone.utc)
        _cand = _cyc(_g.year, _g.month)
        if now >= _cand:
            wsMO = _cand
            _ny, _nm = (_g.year + 1, 1) if _g.month == 12 else (_g.year, _g.month + 1)
            mo_end = _cyc(_ny, _nm)
        else:
            _py, _pm = (_g.year - 1, 12) if _g.month == 1 else (_g.year, _g.month - 1)
            wsMO = _cyc(_py, _pm)
            mo_end = _cand
        if TOT and not (fts(TOT['month']['start']) <= now < fts(TOT['month']['end'])): TOT = None
        if TOT:
            wsMO = int(fts(TOT['month']['start']))
            mo_end = int(fts(TOT['month']['end']))
        st['mo_start'] = wsMO
        st['mo_end'] = mo_end  # beside its twin — a first-scan timeout used to persist one without the other
        # The parse horizon must reach the month's first day even in a 31-day month.
        ws30 = min(int((now - W30) // 86400 * 86400), wsMO)
        g = {}
        nfc = {}
        T30 = TOT['month'] if TOT else None
        if TOT and not (abs(fts(T30['start']) - wsMO) < 1 and abs(fts(T30['end']) - mo_end) < 1): TOT = None
        # Entered between two scans only to take the totals in place of a file map, which they do not fit: the next scan
        # interval decides, and nothing is read now.
        if not TOT and not _due: raise _Wait()
        for path in ([] if TOT else glob.glob(os.path.join(proj, '**', '*.jsonl'), recursive=True)):
            try: m = os.path.getmtime(path)
            except Exception: continue
            if m < ws30: continue
            if m >= ws5:                                   # active in last 5h: always parse fresh
                ids = scan(path, ws30)
            else:                                          # colder: id map cached by (mtime, horizon)
                c = fc.get(path)
                if c and c.get('mtime') == m and c.get('k') == ws30 and c.get('ev') == 10 and 'ids' in c:
                    ids = c['ids']
                else:
                    ids = scan(path, ws30)  # horizon holds all month, so the key is month-stable
            nfc[path] = {'mtime': m, 'k': ws30, 'ev': 10, 'ids': ids}
            gmerge(g, ids)
        nL5 = nL7 = nU5 = nU7 = nL30 = nU30 = nR30 = nR7 = nR5 = 0.0
        nRO5 = nRO7 = nRO30 = 0.0  # OWN reads — what this machine exports (additive across machines)
        nCLu30 = nCLo30 = 0.0      # month LIST-PRICE cost: union and own (own is what exports)
        nU7F = nR7F = 0.0          # UNION fable-family tokens/reads in the weekly window (the
                                   # per-model cap is account-wide; the union already is)
        nL7F = nRO7F = 0.0         # OWN fable-family tokens and reads in the week, which this machine reports
        for tw in g.values():
            t, w, e = tw[0], tw[1], tw[2]
            r = tw[3] if len(tw) > 3 else 0
            lc = tw[4] if len(tw) > 4 else 0
            if e >= wsMO:
                nU30 += t; nL30 += t * w; nR30 += r; nRO30 += r * w
                nCLu30 += lc; nCLo30 += lc * w
            if e >= ws7:
                nU7 += t; nL7 += t * w; nR7 += r; nRO7 += r * w
                if len(tw) > 5 and tw[5]: nU7F += t; nR7F += r; nL7F += t * w; nRO7F += r * w
            if e >= ws5:
                nU5 += t; nL5 += t * w; nR5 += r; nRO5 += r * w
        if TOT:
            # The account (U, the union the calibration counts) and this machine (L, its own rows: the account less what
            # the other machines ran, which the brief to an older OAK sends as its own measurement).
            T5, T7 = TOT['five'], TOT['week']
            def _o(w): return w.get('others') if isinstance(w.get('others'), dict) else {}
            def _tt(w): return w.get('topTier') if isinstance(w.get('topTier'), dict) else {}
            o5, o7, o30 = _o(T5), _o(T7), _o(T30)
            nU5 = f(T5['tokens']); nL5 = nU5 - f(o5.get('tokens')); nR5 = f(T5['cacheRead']); nRO5 = nR5 - f(o5.get('cacheRead'))
            nU7 = f(T7['tokens']); nL7 = nU7 - f(o7.get('tokens')); nR7 = f(T7['cacheRead']); nRO7 = nR7 - f(o7.get('cacheRead'))
            nU7F = f(_tt(T7).get('tokens')); nL7F = nU7F - f(_tt(o7).get('tokens')); nR7F = f(_tt(T7).get('cacheRead')); nRO7F = nR7F - f(_tt(o7).get('cacheRead'))
            nU30 = f(T30['tokens']); nL30 = nU30 - f(o30.get('tokens')); nR30 = f(T30['cacheRead']); nRO30 = nR30 - f(o30.get('cacheRead'))
            nCLu30 = f(T30['cost']); nCLo30 = nCLu30 - f(o30.get('cost'))
        L30, U30 = nL30, nU30
        st['R30'] = nR30; st['R7'] = nR7; st['R5'] = nR5; st['s5'] = r5 or 0
        st['RO30'] = nRO30; st['RO7'] = nRO7; st['RO5'] = nRO5
        st['CLu30'] = nCLu30; st['CLo30'] = nCLo30
        st['U7F'] = nU7F; st['R7F'] = nR7F
        L5, L7, U5, U7, fc = nL5, nL7, nU5, nU7, nfc
        if _due: last = now
        # What this scan measured of its own turns, for the saved machines to add up (core machineUsageBrief): when, the
        # 5h and weekly resets it anchored on (0: none), the bill cycle, and the own fable tokens. Kept apart from s5 and
        # the cycle above, which a scan the alarm cut moves on while its totals stay the last scan. Dated once a scan
        # interval with the totals too: dated at every render, the cache would change with every render, and the index
        # would read it again each time.
        if _due: st['mt'], st['m5'], st['m7'], st['mm'], st['L7F'], st['RO7F'] = now, r5 or 0, r7 or 0, [wsMO, mo_end], nL7F, nRO7F
        try:
            if not _due: raise ValueError('the spend ring takes a sample once a scan interval')
            _cumS = 0.0
            _cacheS = json.load(open(os.path.join(os.path.dirname(proj), 'statusline-last.json')))
            for _v in (_cacheS.get('costs') or {}).values():
                _cumS += _v.get('usd') or 0
            ch = [x for x in (st.get('ch') or []) if x and x[0] > now - 32 * 86400]
            ch.append([now, _cumS])
            st['ch'] = ch
        except Exception: pass
        # NOT max(): a one-way ratchet can never come down, so one badly-conditioned sample (a
        # percentage that lagged, or a burst on a machine whose share of the account was small)
        # poisons every later render — measured on a real host at 896,991 tokens/% against a
        # current sample of 783,342, and the 5h and week windows disagreeing about the same
        # account's budget. The current sample is what this render actually knows.
        # The account measured in each window: this machine and each saved machine that counts (THE ACCOUNT ACROSS ITS
        # MACHINES, above), each its own turns, with the cache reads beside them; or, where it holds more, the union this
        # machine holds, as before. The month adds up the same way when the machines bill on the same cycle, with its
        # list-price dollars (this machine to the cent, as the others send theirs, so every machine sums the same
        # figures), and so does the fable family in the week.
        aU5, aU7, aU7F = U5, U7, nU7F
        if A5 and not TOT and L5 + A5['tok'] > U5: aU5, st['R5'] = L5 + A5['tok'], nRO5 + A5['reads']
        if A7 and not TOT and L7 + A7['tok'] > U7: aU7, st['R7'] = L7 + A7['tok'], nRO7 + A7['reads']
        if A7 and not TOT and nL7F + A7['fable'] > nU7F: aU7F, st['R7F'] = nL7F + A7['fable'], nRO7F + A7['fableReads']
        M30 = A30 if (A30 and not TOT and abs(fts(A30['start']) - wsMO) < 1 and abs(fts(A30['reset']) - mo_end) < 1) else None
        if M30 and L30 + M30['tok'] > U30: st['a30'], st['c30'], st['R30'] = L30 + M30['tok'], round(nCLo30, 2) + M30['cost'], nRO30 + M30['reads']
        else: st['a30'], st['c30'] = U30, nCLu30
        st['a5'] = aU5; st['a7'] = aU7
        # CALIBRATED OVER TIME: one sample is one render's ratio; the smoothed
        # value converges across renders, weighted by how far the window has filled — a 60%-full
        # window pins the ratio far better than a 6%-full one. Not a ratchet: it moves both ways.
        def ewma(prev, sample, pct):
            a = 0.5 * min(1.0, pct / 40.0)
            return sample if not prev else prev + a * (sample - prev)
        if _due and (p5 >= 5 or (TOT and p5 > 0)) and aU5 > 0 and '5' not in CARRIED:
            tpp5 = aU5 / p5                                # calibrate only above the noise floor
            tppE5 = tpp5 if TOT else ewma(0 if G5 else tppE5, tpp5, p5); st['n5'] = max(f(st.get('n5')), _n(A5))
        if _due and (p7 >= 5 or (TOT and p7 > 0)) and aU7 > 0 and '7' not in CARRIED:
            tpp7 = aU7 / p7
            tppE7 = tpp7 if TOT else ewma(0 if G7 else tppE7, tpp7, p7); st['n7'] = max(f(st.get('n7')), _n(A7))
        # The fable cap runs low single digits for most of a week — a 5% floor would leave it
        # uncalibrated forever. Its numerator is a DIRECT union measurement of the family's own
        # tokens (not a projection), so the ratio is well-conditioned from 1% up.
        if _due and (pF >= 1 or (TOT and pF > 0)) and aU7F > 0:
            tppF = aU7F / pF if TOT else ewma(0 if GF else tppF, aU7F / pF, pF); st['nF'] = max(f(st.get('nF')), _n(A7))
        try:
            # Written once a scan interval, and once more to drop the file map a scan kept, which the totals need not.
            if not (_due or _hadfc): raise ValueError('nothing to keep yet')
            tmp = sp + '.tmp'
            json.dump({'v': 2, 'last_scan': last, 'L5': L5, 'L7': L7, 'U5': U5, 'U7': U7, 'L30': L30, 'U30': U30, 'a30': st.get('a30') or 0, 'tpp5': tpp5, 'tpp7': tpp7, 'tppE5': tppE5, 'tppE7': tppE7, 'cpp5': cpp5, 'cpp7': cpp7, 'ch': st.get('ch') or [], 'mo_end': st.get('mo_end') or 0, 'mo_start': st.get('mo_start') or 0, 'R30': st.get('R30') or 0, 'R5': st.get('R5') or 0, 'R7': st.get('R7') or 0, 'RO30': st.get('RO30') or 0, 'RO5': st.get('RO5') or 0, 'RO7': st.get('RO7') or 0, 'a5': st.get('a5') or 0, 'a7': st.get('a7') or 0, 'CLu30': st.get('CLu30') or 0, 'CLo30': st.get('CLo30') or 0, 'U7F': st.get('U7F') or 0, 'R7F': st.get('R7F') or 0, 's5': st.get('s5'), 'tppF': tppF, 'mt': st.get('mt') or 0, 'm5': st.get('m5') or 0, 'm7': st.get('m7') or 0, 'mm': st.get('mm') or [0, 0], 'L7F': st.get('L7F') or 0, 'RO7F': st.get('RO7F') or 0, 'c30': st.get('c30', st.get('CLu30') or 0), 'n5': f(st.get('n5')), 'n7': f(st.get('n7')), 'nF': f(st.get('nF')), 'k_five': st.get('k_five'), 'k_week': st.get('k_week'), 'k_month': st.get('k_month'), 'fc': fc}, open(tmp, 'w'))
            os.replace(tmp, sp)
        except Exception: pass
    except _Wait: pass
    except TO:
        # The scan hit the alarm. Persist last_scan anyway (with the OLD totals): without this the dump
        # below never runs, last_scan never advances, and every future render re-enters the scan and
        # pays the full 12s — the one state this file exists to prevent. Stale-but-bounded beats that.
        # The COMPLETED files' cache entries are kept too (2026-09-03): after an anchor change every
        # fc key is stale, and a timeout that also threw the finished work away re-parsed the same
        # files next render, timed out again, and froze the totals permanently (measured live). The
        # file the alarm interrupted is exactly the one nfc does not hold yet, so nothing partial
        # can be persisted. Totals stay OLD — a sum missing the unscanned tail must not be shown.
        last = now
        try:
            tmp = sp + ".tmp"
            merged = dict(fc); merged.update(nfc)
            json.dump({"v": 2, "last_scan": last, "L5": L5, "L7": L7, "U5": U5, "U7": U7, "L30": L30, "U30": U30, "a30": st.get("a30") or 0, "tpp5": tpp5, "tpp7": tpp7, "tppE5": tppE5, "tppE7": tppE7, "cpp5": cpp5, "cpp7": cpp7, "ch": st.get("ch") or [], "mo_end": st.get("mo_end") or 0, "mo_start": st.get("mo_start") or 0, "R30": st.get("R30") or 0, "R5": st.get("R5") or 0, "R7": st.get("R7") or 0, "RO30": st.get("RO30") or 0, "RO5": st.get("RO5") or 0, "RO7": st.get("RO7") or 0, "a5": st.get("a5") or 0, "a7": st.get("a7") or 0, "CLu30": st.get("CLu30") or 0, "CLo30": st.get("CLo30") or 0, "U7F": st.get("U7F") or 0, "R7F": st.get("R7F") or 0, "s5": r5 or 0, "tppF": tppF, "mt": st.get("mt") or 0, "m5": st.get("m5") or 0, "m7": st.get("m7") or 0, "mm": st.get("mm") or [0, 0], "L7F": st.get("L7F") or 0, "RO7F": st.get("RO7F") or 0, "c30": st.get("c30", st.get("CLu30") or 0), "n5": f(st.get("n5")), "n7": f(st.get("n7")), "nF": f(st.get("nF")), "k_five": st.get("k_five"), "k_week": st.get("k_week"), "k_month": st.get("k_month"), "fc": merged}, open(tmp, "w"))
            os.replace(tmp, sp)
        except Exception: pass
    try: signal.alarm(0)
    except Exception: pass
# Display uses the SMOOTHED calibration when it exists (falls back to the latest raw sample).
_d5 = tppE5 or tpp5; _d7 = tppE7 or tpp7
e5 = int(p5 * _d5) if (p5 and _d5) else 0
# NO MEASURED FALLBACK for a share the account rounds to zero (tried 2026-09-15, reverted the
# same day). Substituting the scan's measured union looked like it filled the gap, but a MEASURED
# numerator over a PROJECTED budget states a ratio the account's own percentage contradicts: wk
# printed ~4M/59.5M - 6.7% - beside a bar the account put at 0%. est and tot must come from the
# SAME projection so that est/tot restates pct exactly. A window at 0% prints ~0/total instead:
# always used/total, and internally consistent.
e7 = int(p7 * _d7) if (p7 and _d7) else 0
t5 = int(_d5 * 100) if _d5 else 0   # projected 100% budget (tokens) for the 5h window
t7 = int(_d7 * 100) if _d7 else 0   # projected 100% budget (tokens) for the week window
if t5 and t7 and t5 > t7: t5 = 0  # a 5h budget above the weekly one is calibration noise (same clamp as the dollars)
# The projection is pct x tokens-per-percent, so an account that rounds the per-model share DOWN
# TO ZERO collapses it to nothing - and the segment then printed a bare bar with its cache reads and
# no figures at all. The scan has
# already MEASURED the family's tokens in this window (U7F, union across machines, which is what the
# account-wide cap is measured against), so fall back to that: a figure actually counted beats a
# projection of a rounded-down percentage. Both are printed under the same ~ as every other estimate.
eF = int(pF * tppF) if (pF and tppF) else 0
tF = int(tppF * 100) if tppF else 0  # projected 100% budget for the per-model weekly cap
if tF and t7 and tF > t7: tF = 0  # the fable budget cannot exceed the whole weekly budget

# DOLLARS: Claude Code prices each session itself (cost.total_cost_usd) and the
# cache keeps a per-session spend ledger; summing entries inside each window is this machine's
# window spend, other machines' ledgers ride the oak usage cache (additive, same as tokens). The
# $ totals calibrate exactly like the token ones: dollars-per-percent, smoothed over renders.
# The ledger keys each session's CUMULATIVE cost by its LAST report time, so summing entries
# inside a window would land a week-long session's whole spend in the 5h bar. Window spend is a
# DELTA of cumulative snapshots instead: the state keeps a ring of (ts, ledger-sum) samples, one
# per scan tick, and each window's cost = now's sum minus the sample at its start. A ledger prune
# (entries age out at 8 days) can pull the sum down — deltas clamp at zero rather than go
# negative, and the ring itself ages out with the ledger.
  # (snapshot-ts, own-month-cost) rows; joined once c30's window start is known
_cum = 0.0
try:
    _cache = json.load(open(os.path.join(os.path.dirname(proj), 'statusline-last.json')))
    for _v in (_cache.get('costs') or {}).values():
        _cum += _v.get('usd') or 0
except Exception: pass
ch = st.get('ch') or []
def _base(target):
    b = None
    for _t, _c in ch:
        if _t <= target: b = _c
        else: break
    return b
# 5h spend needs a baseline at least 5h old — before one exists the figure would be "growth since
# tracking began", which for a short window overstates wildly (a week-long session's whole spend
# landed in the 5h bar, so the week read less than the 5h). The WEEK window is different:
# the ledger's own 8-day horizon nearly matches it, so until the ring covers 7 days the at-keyed
# ledger sum stands in — sessions rarely span more than a week of spend, and honest-now beats
# hidden-for-a-week. Each window starts where its tokens start counting: at its reset less its
# length (the last 5 hours or 7 days without one). From the rolling 7 days, the week's dollars took
# in the days before its reset that its tokens leave out.
_ws5c = (r5 - W5) if r5 else now - W5
_ws7c = (r7 - W7) if r7 else now - W7
_b5 = _base(_ws5c)
c5 = max(0.0, _cum - _b5) if _b5 is not None else 0.0
_b7 = _base(_ws7c)
if _b7 is not None:
    c7 = max(0.0, _cum - _b7)
else:
    c7 = 0.0
    try:
        for _v in (_cache.get('costs') or {}).values():
            if (_v.get('at') or 0) > _ws7c: c7 += _v.get('usd') or 0
    except Exception: pass
if c5 > c7: c5 = 0.0  # a 5h figure above the week's is incoherent — drop the shakier one
# Preserve the local cost fields consumed by existing statusline readers.
c5_own, c7_own = c5, c7
# The month's $ window matches its token window: the anchored 4-cycle block when a reset grid
# exists, rolling 30 days otherwise.
_wsmo = st.get('mo_start') or 0
if _wsmo <= 0: _wsmo = now - 2592000
# The month $ is LIST-PRICED from the transcripts: per-message model rates,
# cache reads included — the ledger only sees sessions that render a statusline, so it
# under-counts. The local union includes transcripts already synced onto this machine; the
# scan put the account month (c30, beside a30) in its place where the saved machines add more.
c30_own = st.get('CLo30') or 0.0
c30 = st.get('c30', st.get('CLu30')) or 0.0
# The month as Claude Code reported it, session by session (the ledger), for a plan with no rolling windows,
# where it is the charge: each session counts in the month its last report fell in.
s30 = 0.0
try:
    for _v in (_cache.get('costs') or {}).values():
        if (_v.get('at') or 0) >= _wsmo: s30 += _v.get('usd') or 0
except Exception: pass
def ewma2(prev, sample, pct):
    a = 0.5 * min(1.0, pct / 40.0)
    return sample if not prev else prev + a * (sample - prev)
# The dollars per percent calibrate on the account spend, as the tokens do: this machine and each saved machine that
# counts for the window (each the spend its own sessions reported), starting over as the tokens do.
c5a = round(c5, 2) + A5['cost'] if A5 else c5; c7a = round(c7, 2) + A7['cost'] if A7 else c7
if TOT:
    c5a = TOT['five'].get('spend', c5a); c7a = TOT['week'].get('spend', c7a)
if (p5 >= 5 or (TOT and p5 > 0)) and c5a > 0 and '5' not in CARRIED: cpp5 = c5a / p5 if TOT else ewma2(0 if G5 else cpp5, c5a / p5, p5)
if (p7 >= 5 or (TOT and p7 > 0)) and c7a > 0 and '7' not in CARRIED: cpp7 = c7a / p7 if TOT else ewma2(0 if G7 else cpp7, c7a / p7, p7)
# PERSIST the dollar calibration: the state dump above runs BEFORE this
# update, so without this write-back cpp reloaded as 0 every render and the "smoothed" value was
# forever the raw sample. Scan ticks only — same cadence as the token calibration.
if _scanned and (cpp5 or cpp7):
    try:
        _st2 = json.load(open(sp))
        _st2['cpp5'] = cpp5; _st2['cpp7'] = cpp7
        _t2 = sp + '.tmp2'
        json.dump(_st2, open(_t2, 'w')); os.replace(_t2, sp)
    except Exception: pass
d5 = int(cpp5 * 100) if cpp5 else 0
d7 = int(cpp7 * 100) if cpp7 else 0
if d5 and d7 and d5 > d7: d5 = 0  # a 5h budget above the weekly one is calibration noise, not a fact
_mdays = ((st.get('mo_end') or 0) - (st.get('mo_start') or 0)) / 86400.0
if _mdays <= 0: _mdays = 30.0
a30 = int(st.get('a30') or max(U30, L30))
tk30 = int(t7 * _mdays / 7)
# The month's $ budget SHARES the month token ratio. A separately-calibrated dollar budget put
# 6% under a 29% bar for one and the same consumption.
d30 = int(c30 * tk30 / a30) if (a30 > 0 and c30 > 0) else 0

# Anthropic plan-limit promotions, dated (mirror: packages/core/src/pricing.ts — keep in sync).
# While one is live the wk segment carries its marker, and the post-promo budget is projected so
# the number does not silently shrink on the flip date. After the window the entry is inert.
PROMOS = [(1778630400, 1789344000, '+50%', 1.25 / 1.5)]  # May 13 2026 -> Sep 14 2026 UTC; then permanent +25%
promo = '-'
for _a, _b, _lab, _post in PROMOS:
    if _a <= now < _b:
        # One whitespace-free token (the bash reader splits on spaces): label:ends:M/D. Only the
        # END matters on a glance — the start (this one began May 13) is history, and the budgets
        # shown already include the boost. The date is the flip day: limits change that morning.
        _ed = time.strftime('%m/%d', time.gmtime(_b)).lstrip('0').replace('/0', '/')
        promo = f"{_lab}:ends:{_ed}"
# L5/L7 are MEASURED from the transcripts on this machine — deduped by message id and counting only
# the turns THIS machine ran, so per-machine figures can be added without counting synced work twice
# (THE ACCOUNT ACROSS ITS MACHINES: the saved machines add them up, with when and in which window each
# scan measured them, the last seven fields).
# They are the only usage figure an account with no rolling windows can be given, honest for everyone.
# (No apostrophes in these comments: the heredoc is inside $( ), where bash still tracks quotes.)
try: _mm0, _mm1 = (int(x) for x in st.get('mm'))
except Exception: _mm0 = _mm1 = 0
print(f"{e5} {t5} {e7} {t7} {int(L5)} {int(L7)} {c5:.2f} {d5} {c7:.2f} {d7} {promo} 0 {c30:.2f} {d30} {a30} {tk30} {int(L30)} {int(st.get('mo_end') or 0)} {int(st.get('R30') or 0)} {int(st.get('R5') or 0)} {int(st.get('R7') or 0)} {c5_own:.2f} {c7_own:.2f} {c30_own:.2f} {int(st.get('RO5') or 0)} {int(st.get('RO7') or 0)} {int(st.get('RO30') or 0)} {int(st.get('a5') or 0)} {int(st.get('a7') or 0)} {eF} {tF} {int(st.get('R7F') or 0)} {int(st.get('mt') or 0)} {int(st.get('m5') or 0)} {int(st.get('m7') or 0)} {_mm0} {_mm1} {int(st.get('L7F') or 0)} {int(st.get('RO7F') or 0)} {s30:.2f}")
PYEOF
)
  read -r est5 tot5 est7 tot7 meas5 meas7 cost5 costt5 cost7 costt7 promo7 padj7 cost30 costt30 tok30 tokt30 meas30 moreset reads30 reads5 reads7 cost5own cost7own cost30own readso5 readso7 readso30 acct5 acct7 estf totf readsf measat meas5r meas7r measmo0 measmo1 measf readsfo spend30 <<<"$_uest"
  # An ended 5h window (pick_win) draws no cache reads: the scan counted the last five hours, the ended window's. The
  # cache keeps the reads it holds, which OAK's readouts leave out for an ended window as well.
  [ -z "$_x5" ] || reads5=""
# "-" = python ran and there IS no live promo (the cache must clear); "" = python never ran (keep $old).
promo7raw="$promo7"
[ "$promo7" = "-" ] && promo7=""
else
  pick_windows  # no estimate and no pull here, but each window still draws, and the cache keeps, its freshest reading
fi

# Persist the exact values so the OAK VS Code sidebar ("Usage" panel) shows the same
# numbers as this line — including the 5h/week token estimates (est5/est7, computed just above). Merge
# with the previous file so a turn missing rate_limits keeps the last known-good. Never fail the line.
_LAST="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline-last.json"
# THE CACHE LOCK (2026-10-20). A render rewrites the whole cache from the copy it read just before, so of two renders
# started together, the one that renamed last put back what the other had just recorded: an idle session's write undid
# the share, its date and the spend another session had just recorded (19 times in 20, measured). The read through the
# rename runs under <cache>.lock, a directory, which mkdir makes or finds taken in one step everywhere this line runs
# (macOS has no flock). Its holder marks it with a token, a directory inside named <second taken>.<pid>.<random>, and
# holds the lock only once its token is the lock's only entry. A token 5 s old, or 5 s ahead of the clock (one set
# back), is a holder that died, for the write takes milliseconds: a waiter removes that token by its name and then the
# lock only if it is empty, so a lock another render took since, which holds that render's token, is never removed. A
# lock with no token for 5 s (a holder killed between its two mkdirs) goes the same way, by the lock's own time. A
# holder renames only while its token is still there: one stopped for 5 s (Ctrl-Z, a machine asleep) has lost the lock.
# A render waits about a second (50 tries 20 ms apart, never past 2 s) and, without the lock, skips its write: the next
# render, a minute on, writes what this one would have, and this one still draws its line. OAK's account pull
# (`oak usage --pull-account`), which also rewrites the cache, takes this lock by the same protocol (mirror:
# packages/core/src/statusline-lock.ts, keep the two in sync).
_lt=""
_lock() { local l="$_LAST.lock" s=$SECONDS b i e p t
  [ -w "${_LAST%/*}" ] || return 1
  b=$(( $(date +%s) - SECONDS ))
  for (( i = 0; i < 50 && SECONDS - s < 2; i++ )); do
    if mkdir "$l" 2>/dev/null; then
      _lt="$(( b + SECONDS )).$$.$RANDOM"
      if mkdir "$l/$_lt" 2>/dev/null; then set -- "$l"/*; [ "$#" = 1 ] && [ "$1" = "$l/$_lt" ] && return 0; fi
      _unlock; continue
    fi
    [ -d "$l" ] || continue
    e=$(( b + SECONDS )); set -- "$l"/*
    if [ -e "$1" ]; then
      for p in "$@"; do t=${p##*/}; t=${t%%.*}; case "$t" in ''|*[!0-9]*) t=0 ;; esac
        { [ $(( e - 10#$t )) -ge 5 ] || [ $(( 10#$t - e )) -ge 5 ]; } && ! rmdir "$p" "$l" 2>/dev/null && [ -e "$p" ] && _aside; done
    else
      t=$(stat -c %Y "$l" 2>/dev/null || stat -f %m "$l" 2>/dev/null)
      case "$t" in ''|*[!0-9]*) ;; *) { [ $(( e - t )) -ge 5 ] || [ $(( t - e )) -ge 5 ]; } && ! rmdir "$l" 2>/dev/null \
        && set -- "$l"/* && [ -d "$l" ] && [ ! -e "$1" ] && _aside ;; esac
    fi
    [ -d "$l" ] && { sleep 0.02 2>/dev/null || sleep 1; }
  done
  return 1; }
# A stale lock that cannot be removed (another user's token, as a render run under sudo leaves it, or an entry that is no
# token) is renamed aside and removed as far as it can be: left in place, it kept every later render from writing.
_aside() { local x="$_LAST.lock.$$.$RANDOM"; mv "$_LAST.lock" "$x" 2>/dev/null && rm -rf "$x" 2>/dev/null; }
# Releases the lock this render holds: its token, then the lock if that leaves it empty.
_unlock() { [ -n "$_lt" ] && rmdir "$_LAST.lock/$_lt" "$_LAST.lock" 2>/dev/null; _lt=""; }
# THE SWEEP (2026-10-21). SIGKILL runs no trap: a render killed inside its write leaves its temporary file beside the
# cache, and _aside leaves a stale lock it renamed but could not remove (another user's), or was killed before removing.
# Nothing removed either. The render that takes the lock removes those more than two minutes from when it started, either
# way (one dated ahead was written before the clock was set back, as _lock reads a token), by stat's mtime as _lock reads
# a lock's, as far as it can: <cache>.tmp.* files and <cache>.lock.*.* directories in the cache's own directory, never
# the lock itself, and never a link (`oak uninstall --all` leaves one too). Only those two names reach the rm. A temporary file lives for its render's write, milliseconds, and is
# renamed only while its render's token is in the lock: while this render holds it, one that old is a dead render's or
# one that lost the lock. An aside lock is inert from its rename. bash's own globs look first, so a render with nothing
# to sweep, or with only an aside lock it cannot change (another user's, as sudo leaves it), starts no process for it.
_sweep() { local f t
  for f in "$_LAST".tmp.* "$_LAST".lock.*.*; do
    [ -L "$f" ] && continue
    case $f in "$_LAST".tmp.*) [ -f "$f" ] ;; "$_LAST".lock.*.*) [ -d "$f" ] && [ -w "$f" ] ;; *) false ;; esac || continue
    t=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null)
    case $t in ''|*[!0-9]*) ;; *) { [ $(( _nowe - t )) -gt 120 ] || [ $(( t - _nowe )) -gt 120 ]; } && rm -rf "$f" 2>/dev/null ;; esac
  done; }
_lock && _sweep
_old=$(cat "$_LAST" 2>/dev/null || echo '{}')
# If the existing file is corrupt/truncated/empty, it would abort the jq below on EVERY
# turn and the persist would silently stop updating forever — fall back to '{}' so it self-heals.
# The same read gives each window's share, stamp and reset as the cache holds them NOW, which may be a reading another
# render recorded after pick_win read the cache: every session renders every minute and the estimator can run for
# seconds, and the render that finished last wrote its older reading over a newer one, the account pull's included.
_ov=$(printf '%s' "$_old" | jq -er 'def ep: (numbers | select(. < 1e12) | floor) // ""; if type == "object" then
  [(.five_pct | numbers) // "", (.five_at | ep), (.five_reset | ep), (.week_pct | numbers) // "", (.week_at | ep), (.week_reset | ep)]
  | map(tostring) | join("|") else error end' 2>/dev/null) || _old='{}'
IFS='|' read -r _o5p _o5a _o5r _o7p _o7a _o7r <<<"$_ov"
# _kept SHARE AT RESET DATE ANCHOR PERIOD PICKED: a reading another render recorded since pick_win read the cache (one
# other than PICKED, the share|stamp pick_win ranked) stands against the one this render would write (dated DATE, empty
# for an undated one, of the window ANCHOR ends), by pick_win's rule: one of a later window, else one dated after it (a
# stamp ahead of this clock as now, one more than five minutes ahead of the clock at this write as undated: a render
# stopped for longer, by Ctrl-Z or a machine asleep, began that long before what was recorded meanwhile), or any dated
# one against an undated one, a reset unknown on either side naming the same window. The cache then keeps it, with its
# stamp, the estimate written beside it (est/tot restate the share they are written with; this render's restate its
# own, which it still draws) and the later of the two resets.
_kept() { local oa=$2 h=$(( $6 / 2 )); [ -n "$1" ] && [ "$1|$2" != "$7" ] || return 1
  if [ -n "$oa" ] && [ "$oa" -gt "$_nowe" ]; then
    if [ "$oa" -gt $(( _nowe + 300 )) ] && [ "$oa" -gt $(( $(date +%s) + 300 )) ]; then oa=""; else oa=$_nowe; fi; fi
  if [ -n "$3" ] && [ -n "$5" ]; then [ $(( $3 - $5 )) -ge "$h" ] && return 0; [ $(( $5 - $3 )) -ge "$h" ] && return 1; fi
  [ -n "$oa" ] && { [ -z "$4" ] || [ "$oa" -gt "$4" ]; }; }
_we5=${est5:-}; _wt5=${tot5:-}; _we7=${est7:-}; _wt7=${tot7:-}
[ -n "$_w5p" ] && _kept "$_o5p" "$_o5a" "$_o5r" "$_w5d" "$_w5r" 18000 "$_c5p|${_c5a%.*}" && { _w5p=""; _we5=""; _wt5=""; }
[ -n "$_w7p" ] && _kept "$_o7p" "$_o7a" "$_o7r" "$_w7d" "$_w7r" 604800 "$_c7p|${_c7a%.*}" && { _w7p=""; _we7=""; _wt7=""; }
# A share this render drew from the cache, which writes none, keeps its own estimate as well once another render has
# recorded a reading since: this render's restates the share it drew.
[ -z "$_w5p" ] && [ "$_o5p|$_o5a" != "$_c5p|${_c5a%.*}" ] && { _we5=""; _wt5=""; }
[ -z "$_w7p" ] && [ "$_o7p|$_o7a" != "$_c7p|${_c7a%.*}" ] && { _we7=""; _wt7=""; }
# The temporary file is this render's own: two renders writing one name truncated each other's, and the second wrote
# into the file the first had just renamed, a longer first write's tail left behind its own, so the cache stopped
# parsing and the next render rebuilt it from '{}'. A render without the lock writes nothing (_lock, above).
# The cache as it was reaches jq on its standard input, ahead of the payload, and never as an argument: Linux refuses
# any one argument over 128 KiB, so a cache past that size (the spend ledger of a month of many sessions) failed this
# write on every render, and the cache stopped changing.
[ -n "$_lt" ] && printf '%s\n%s' "$_old" "$input" | jq -c -n --arg est5 "$_we5" --arg est7 "$_we7" --arg meas5 "${meas5:-}" --arg meas7 "${meas7:-}" --arg tot5 "$_wt5" --arg tot7 "$_wt7" --arg c5 "${cost5:-}" --arg ct5 "${costt5:-}" --arg c7 "${cost7:-}" --arg ct7 "${costt7:-}" --arg promo "${promo7raw:-}" --arg c30 "${cost30:-}" --arg s30 "${spend30:-}" --arg ct30 "${costt30:-}" --arg tok30 "${tok30:-}" --arg tokt30 "${tokt30:-}" --arg meas30 "${meas30:-}" --arg moreset "${moreset:-}" --arg reads30 "${reads30:-}" --arg reads5 "${reads5:-}" --arg reads7 "${reads7:-}" --arg c5o "${cost5own:-}" --arg c7o "${cost7own:-}" --arg c30o "${cost30own:-}" --arg ro5 "${readso5:-}" --arg ro7 "${readso7:-}" --arg ro30 "${readso30:-}" --arg a5 "${acct5:-}" --arg a7 "${acct7:-}" --arg w5p "${_w5p:-}" --arg w5d "${_w5d:-}" --arg w5r "${_w5r:-}" --arg fnone "${api_five_none:+$_nowe}" --arg fseen "${api_five_pct:+$_nowe}" --arg w7p "${_w7p:-}" --arg w7d "${_w7d:-}" --arg w7r "${_w7r:-}" --arg fbp "${fable_pct:-}" --arg fbr "${fable_reset:-}" --arg fbl "${fable_label:-}" --arg ats "${api_ts_new:-}" --arg t0 "${_nowe:-}" --arg ftok "${estf:-}" --arg ftot "${totf:-}" --arg frd "${readsf:-}" --arg mat "${measat:-}" --arg m5r "${meas5r:-}" --arg m7r "${meas7r:-}" --arg mm0 "${measmo0:-}" --arg mm1 "${measmo1:-}" --arg fme "${measf:-}" --arg fro "${readsfo:-}" --arg branch "${branch:-}" --arg tokin "${t_in:-}" --arg tokout "${t_out:-}" --arg tokcache "${t_cr:-}" --arg toktree "${t_ag:+$t_ag $t_tin $t_tout $t_tcr}" 'input as $old | input | {
  ts: now,
  # Schema version of THIS cache. The dashboard compares it and says so when an older status line
  # is still installed, instead of drawing blanks for fields that script never wrote. v3 = the
  # measured window totals are deduped by message id and count only THIS machines own turns —
  # readers refuse to ADD a v2 machines totals into a cross-machine sum, because those are 2.5-3x
  # high and include every other machines synced-in work.
  v: 3,
  model: (.model.display_name // $old.model // ""),
  dir: (.workspace.current_dir // .cwd // $old.dir // ""),
  ctx_pct: (.context_window.used_percentage // $old.ctx_pct),
  ctx_used: (((.context_window.total_input_tokens // 0) + (.context_window.total_output_tokens // 0)) | if . > 0 then . else ($old.ctx_used // 0) end),
  ctx_size: (.context_window.context_window_size // $old.ctx_size),
  # The share pick_win gave each window, the freshest reading of it: none, the cached one, or one the cache has kept
  # since (_kept), leaves the cache as it is.
  five_pct: (($w5p | tonumber?) // $old.five_pct),
  # When the share was measured, its own date: a payload share the last reply of its session, a pull the time this
  # render began (when it read its input and pulled), not this write: a render whose scan ran past a reset stamped a
  # share read before the reset inside the next window. A share the cache keeps keeps its time, so a reader can tell a
  # share from the last window.
  five_at: (if (($w5p | tonumber?) // null) != null then (($w5d | tonumber?) // ($t0 | tonumber?) // now) else $old.five_at end),
  # The latest reset known, as it came (never rolled forward), so estimates never compound: the later of the one this
  # render knows and the one another render recorded since.
  five_reset: ([($w5r | tonumber?), ($old.five_reset | numbers | select(. < 1e12))] | max // $old.five_reset),
  # NO FIVE-HOUR LIMIT (no_five): when the account last answered with no 5h window, and with one, as OAK pull records
  # them: each the later of this render pull, when it answered so, and the one recorded, another render included.
  five_none_at: (if $fnone != "" then ([($fnone | tonumber?), ($old.five_none_at | numbers)] | max) else $old.five_none_at end),
  five_seen_at: (if $fseen != "" then ([($fseen | tonumber?), ($old.five_seen_at | numbers)] | max) else $old.five_seen_at end),
  week_pct: (($w7p | tonumber?) // $old.week_pct),
  week_at: (if (($w7p | tonumber?) // null) != null then (($w7d | tonumber?) // ($t0 | tonumber?) // now) else $old.week_at end),
  week_reset: ([($w7r | tonumber?), ($old.week_reset | numbers | select(. < 1e12))] | max // $old.week_reset),
  fable_pct: (if $ats != "" then (($fbp | tonumber?) // null) else $old.fable_pct end),
  fable_reset: (if $ats != "" then (($fbr | tonumber?) // null) else $old.fable_reset end),
  fable_at: (if $ats != "" and (($fbp | tonumber?) // null) != null then (($t0 | tonumber?) // now) else $old.fable_at end),
  fable_label: (if $ats != "" then (if $fbl == "" then null else $fbl end) else $old.fable_label end),
  fable_tok: (($ftok | tonumber?) // $old.fable_tok),
  fable_tok_total: (($ftot | tonumber?) // $old.fable_tok_total),
  fable_reads: (($frd | tonumber?) // $old.fable_reads),
  api_ts: (if $ats != "" then ($ats | tonumber) else $old.api_ts end),
  five_tok: (($est5 | tonumber?) // $old.five_tok),
  week_tok: (($est7 | tonumber?) // $old.week_tok),
  five_meas: (($meas5 | tonumber?) // $old.five_meas),
  week_meas: (($meas7 | tonumber?) // $old.week_meas),
  five_cost: (($c5 | tonumber?) // $old.five_cost),
  five_cost_own: (($c5o | tonumber?) // $old.five_cost_own),
  week_cost_own: (($c7o | tonumber?) // $old.week_cost_own),
  month_cost_own: (($c30o | tonumber?) // $old.month_cost_own),
  five_reads_own: (($ro5 | tonumber?) // $old.five_reads_own),
  week_reads_own: (($ro7 | tonumber?) // $old.week_reads_own),
  month_reads_own: (($ro30 | tonumber?) // $old.month_reads_own),
  five_acct: (($a5 | tonumber?) // $old.five_acct),
  week_acct: (($a7 | tonumber?) // $old.week_acct),
  five_cost_total: (($ct5 | tonumber?) // $old.five_cost_total),
  week_cost: (($c7 | tonumber?) // $old.week_cost),
  week_cost_total: (($ct7 | tonumber?) // $old.week_cost_total),
  promo: (if $promo == "-" then "" elif $promo == "" then ($old.promo // "") else $promo end),
  month_meas: (($meas30 | tonumber?) // $old.month_meas),
  # When the last scan measured this machines own turns (meas_at, epoch seconds) and the windows it counted them in:
  # the 5h and weekly resets it anchored on (0: none) and the bill cycle, with its own fable tokens and reads. The brief another
  # machine reads carries them, so that machine adds these figures to its own only for the same windows.
  meas_at: (($mat | tonumber?) // $old.meas_at),
  five_meas_reset: (($m5r | tonumber?) // $old.five_meas_reset),
  week_meas_reset: (($m7r | tonumber?) // $old.week_meas_reset),
  month_meas_start: (($mm0 | tonumber?) // $old.month_meas_start),
  month_meas_end: (($mm1 | tonumber?) // $old.month_meas_end),
  fable_meas: (($fme | tonumber?) // $old.fable_meas),
  fable_reads_own: (($fro | tonumber?) // $old.fable_reads_own),
  month_reset: (($moreset | tonumber?) // $old.month_reset),
  month_reads: (($reads30 | tonumber?) // $old.month_reads),
  five_reads: (($reads5 | tonumber?) // $old.five_reads),
  week_reads: (($reads7 | tonumber?) // $old.week_reads),
  month_tok: (($tok30 | tonumber?) // $old.month_tok),
  month_tok_total: (($tokt30 | tonumber?) // $old.month_tok_total),
  month_cost: (($c30 | tonumber?) // $old.month_cost),
  month_spend: (($s30 | tonumber?) // $old.month_spend),
  month_cost_total: (($ct30 | tonumber?) // $old.month_cost_total),
  branch: ($branch // $old.branch // ""),
  thinking: (.thinking.enabled // $old.thinking // false),
  output_style: (.output_style.name // $old.output_style // ""),
  # The session tokens line 2 draws (`oak usage`), as the cache reads beside them are; the context window counts of
  # Claude Code only where oak gave none. Two meanings of input in one cache read as one figure on two surfaces.
  tok_in: (($tokin | tonumber?) // ((.context_window.total_input_tokens // 0) | if . > 0 then . else ($old.tok_in // 0) end)),
  tok_out: (($tokout | tonumber?) // ((.context_window.total_output_tokens // 0) | if . > 0 then . else ($old.tok_out // 0) end)),
  tok_cache: (($tokcache | tonumber?) // $old.tok_cache),
  # The session with the agents it started, for the port of line 2 in the terminal app: from this render, or none; a
  # render with no session (the month refresh) keeps the last.
  tok_tree: (if $toktree != "" then ($toktree | split(" ") | map(tonumber? // 0) | {agents: .[0], input: .[1], output: .[2], cacheRead: .[3]})
    elif (.session_id // "") == "" then $old.tok_tree else null end),
  dur_ms: ((.cost.total_duration_ms // 0) | if . > 0 then . else ($old.dur_ms // 0) end),
  five_total: (($tot5 | tonumber?) // $old.five_total),
  week_total: (($tot7 | tonumber?) // $old.week_total),
  cost_usd: ((.cost.total_cost_usd // 0) | if . > 0 then . else ($old.cost_usd // 0) end),
  # THE SPEND LEDGER: the cost this session reported, keyed by session id, with the moment it was
  # reported. Claude Code computes cost.total_cost_usd itself and resets it on /clear, so the figure
  # is per session and cumulative WITHIN one — last-write-wins per key is exactly right, and summing
  # the keys inside a window is the only honest way to a weekly or monthly total. Entries older
  # than 32 days are dropped, so the file cannot grow without bound.
  # (NO APOSTROPHES: this comment is inside the jq program, which the generated script wraps in
  # single quotes — one apostrophe ends the program and the whole status line stops parsing.)
  costs: (
    (($old.costs // {}) + { ((.session_id // "?")): { usd: (.cost.total_cost_usd // 0), at: now } })
    | with_entries(select((.value.at // 0) > (now - 2764800)))
  )
}' > "$_LAST.tmp.$$" 2>/dev/null && [ -d "$_LAST.lock/$_lt" ] && mv "$_LAST.tmp.$$" "$_LAST" 2>/dev/null || true
_unlock

# A SAVED MACHINE'S READING (2026-10-22). Where this machine has no current share of a window, OAK's own readouts show a
# saved machine's reading of the same account and name that machine (core fillFromMachines), and this line drew its own
# ended or out-of-date share beside them (`5h 0%`, `wk —`). A window core names a machine for is drawn as they draw it,
# from the `oak usage` read above: its share, countdown, estimate and budget, beside the cache reads this line measured,
# which core keeps as well; the month, which comes with the week, comes whole. Drawn only: the cache is written above,
# so statusline-last.json, and the brief this machine gives the others, hold its own measurements alone, and the
# estimator ran before, so none of them calibrated it. A share this render drew dated within five minutes (a reply, or
# this render's pull, which core read the cache too early to see) stands, as core keeps this machine's live share, by
# core's rule: a 5h window that has ended (_x5), or whose share is 0 with no reset known, has none, and a later week (a
# reset half a week or more after this one's) replaces this machine's share, live or not. No saved machine's 5h share is
# drawn while the account has no five-hour limit (no_five).
_sm5=""; _sm7=""; _smf=""; _smm=""
_live() { [ -n "$1" ] && case "$_carried" in *"$2"*) false ;; esac; }
if [ -n "$_m5" ] && [ -n "$_m5p" ] && [ -z "$_n5" ] && ! { [ -z "$_x5" ] && { [ -n "$five_reset" ] || _gt "$five_pct" 0; } && _live "$five_pct" 5; }; then
  five_pct=$_m5p; five_reset=$_m5r; est5=$_m5e; tot5=$_m5t; _sm5=$_m5
fi
if [ -n "$_m7" ] && [ -n "$_m7p" ] && { ! _live "$week_pct" 7 || { [ -n "$_m7r" ] && [ -n "$week_reset" ] && [ $(( _m7r - week_reset )) -ge 302400 ]; }; }; then
  week_pct=$_m7p; week_reset=$_m7r; est7=$_m7e; tot7=$_m7t; _sm7=$_m7
  if [ -n "$_mm" ] && [ -n "$_mmt" ]; then tok30=$_mmt; tokt30=$_mmT; moreset=$_mmr; reads30=$_mmR; cost30=$_mmc; costt30=$_mmC; _smm=$_mm; fi
fi
if [ -n "$_mf" ] && [ -n "$_mfp" ] && [ -z "${fable_pct:-}" ]; then
  fable_pct=$_mfp; fable_reset=$_mfr; fable_label=$_mfl; estf=$_mfe; totf=$_mft; _smf=$_mf
fi

# Line 3 — the usage bars
# TWO PASSES, because every bar is the same length and that length is the widest
# figures in the whole render — not knowable until the last segment is built. Pass 1 records a
# deferred segment as `bar:<index>` in `parts`, with its pieces in the four arrays beside it; pass 2
# measures, then renders. A segment with no bar (a placeholder, a measured-only window, the money)
# goes into `parts` as its finished string and passes straight through; every one of those opens with
# an SGR escape, so it can never read as a marker.
# A PRINTABLE marker (2026-09-27). It was a \001 byte, which is bash's own internal quoting byte: bash
# 3.2, the /bin/bash of every stock macOS, stores a $'\001' written into an array literal TWICE, so the
# index never parsed back, pass 2 died on an arithmetic error, and the whole quota line vanished on Macs.
parts=(); bpct=(); btxt=(); blab=(); bsuf=()
defer() { local i=${#bpct[@]}; bpct+=("$1"); btxt+=("$2"); blab+=("$3"); bsuf+=("$4"); parts+=("bar:$i"); }
# Each segment shows a dim "label —" placeholder until its value arrives, so a fresh
# session reads as "loading", not "missing" (the rate_limits are absent until the first API
# response of the session, and the account pull or the cache may have no share for the current
# window either: see pick_win). ctx is NOT here: it opens line 2 now.
# Enterprise/API (no rolling quota, payload or cache): the 5h/wk slots say nothing an account
# without windows can use — the month segment below is its whole readout.
_LASTQ="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline-last.json"
_c5q=$(jq -r '.five_pct // empty' "$_LASTQ" 2>/dev/null); _c7q=$(jq -r '.week_pct // empty' "$_LASTQ" 2>/dev/null)
if [ -n "$_n5" ]; then
  :  # an account with no five-hour limit (no_five): no 5h segment, and no gap where it was
elif [ -z "$five_pct" ] && [ -z "$week_pct" ] && [ -z "$_c5q" ] && [ -z "$_c7q" ]; then
  :
elif [ -n "$five_pct" ]; then c=$(uc "$five_pct"); s=""; [ -n "$five_reset" ] && s=" ${DIM}·${R}${WHT}$(until_str "$five_reset")${R}"
  # ~used/projected-total (total = 100% of the window's estimated budget); used-only until it calibrates.
  # A share of 0 with neither reads ~0: an empty bar beside 0% read as a window with nothing to report.
  _bt=""
  if [ "${tot5:-0}" != 0 ]; then _bt="~$(human "${est5:-0}")/$(human "$tot5")"; elif [ "${est5:-0}" != 0 ]; then _bt="~$(human "$est5")"
  else case "$five_pct" in *[1-9]*) ;; *) _bt="~0" ;; esac; fi
  [ "${reads5:-0}" != 0 ] 2>/dev/null && [ "${reads5%.*}" -gt 0 ] 2>/dev/null && _bt="${_bt:+$_bt }+$(human "$reads5")↺"
  defer "$five_pct" "$_bt" "5h" " ${c}$(printf '%.0f' "$five_pct")%${R}${s}"
# No percentage, but a real measurement: show it. A bare "5h —" on an Enterprise or API account reads as
# "still loading" forever, when the truth is that this plan has no rolling window to report a share of.
elif [ "${meas5:-0}" != 0 ]; then parts+=("${DIM}5h${R} $(human "$meas5") ${DIM}tok${R}")
else parts+=("${DIM}5h —${R}"); fi
# The per-model weekly cap the account reports (the desktop app's "Fable" row, 2026-09-08),
# BEFORE the whole-week segment it is a slice of. Same grammar as its neighbours: bar, share,
# countdown, ~est/total from its own union measurement + calibration, and its cache reads.
_fbp="${fable_pct:-}"; _fbr="${fable_reset:-}"; _fbl="${fable_label:-}"
[ -z "$_fbp" ] && [ -z "$_fb_old" ] && _fbp=$(jq -r '.fable_pct // empty' "$_LASTQ" 2>/dev/null)
[ -z "$_fbr" ] && _fbr=$(jq -r '.fable_reset // empty' "$_LASTQ" 2>/dev/null)
[ -z "$_fbl" ] && _fbl=$(jq -r '.fable_label // empty' "$_LASTQ" 2>/dev/null)
if [ -n "$_fbp" ]; then
  _fbe=$(to_epoch "$_fbr"); [ -n "$_fbe" ] && _fbe=$(roll_fwd "$_fbe" 604800)
  c=$(uc "$_fbp"); s=""; [ -n "$_fbe" ] && s=" ${DIM}·${R}${WHT}$(until_str "$_fbe")${R}"
  _bt=""
  if [ "${totf:-0}" != 0 ]; then _bt="~$(human "${estf:-0}")/$(human "$totf")"; elif [ "${estf:-0}" != 0 ]; then _bt="~$(human "$estf")"
  else case "$_fbp" in *[1-9]*) ;; *) _bt="~0" ;; esac; fi
  [ "${readsf:-0}" != 0 ] 2>/dev/null && [ "${readsf%.*}" -gt 0 ] 2>/dev/null && _bt="${_bt:+$_bt }+$(human "$readsf")↺"
  _fname=$(printf '%s' "${_fbl:-fable}" | tr '[:upper:]' '[:lower:]')
  defer "$_fbp" "$_bt" "$_fname" " ${c}$(printf '%.0f' "$_fbp")%${R}${s}"
fi
# No weekly quota (Enterprise/API): a MONTH of spend is the figure that means something there
# — the ledger holds 32 days now, so the sum is real, not a truncation.
if [ -z "$five_pct" ] && [ -z "$week_pct" ] && [ -z "$_c5q" ] && [ -z "$_c7q" ]; then
  :
elif [ -n "$week_pct" ]; then c=$(uc "$week_pct"); s=""; [ -n "$week_reset" ] && s=" ${DIM}·${R}${WHT}$(until_str "$week_reset")${R}"
  _bt=""
  # ALWAYS used/total where a budget is known - a window at 0% reads ~0/59.5M,
  # never a blank. est and tot are both projections from the same tokens-per-percent, so the pair
  # restates pct exactly; that is the invariant the consistency check pins.
  if [ "${tot7:-0}" != 0 ]; then _bt="~$(human "${est7:-0}")/$(human "$tot7")"; elif [ "${est7:-0}" != 0 ]; then _bt="~$(human "$est7")"
  else case "$week_pct" in *[1-9]*) ;; *) _bt="~0" ;; esac; fi
  [ "${reads7:-0}" != 0 ] 2>/dev/null && [ "${reads7%.*}" -gt 0 ] 2>/dev/null && _bt="${_bt:+$_bt }+$(human "$reads7")↺"
  defer "$week_pct" "$_bt" "wk" " ${c}$(printf '%.0f' "$week_pct")%${R}${s}"
elif [ "${meas7:-0}" != 0 ]; then parts+=("${DIM}wk${R} $(human "$meas7") ${DIM}tok${R}")
else parts+=("${DIM}wk —${R}"); fi
# ONE dollar pair, MONTHLY, in its OWN |-divided segment: 30 days of spend
# against four weekly cycles of budget (spend alone when no quota projects one), plus the live
# promotion with its dates — money and promos read apart from the quota bars.
_mo=""
_t30="${tok30%.*}"; _tt30="${tokt30%.*}"
# A MEASURED month is one this render's scan gave a budget (tokt30 > 0). With no usage in it yet it
# is a 0% bar (~0/total, like the 5h and week windows at 0%), not a missing segment; a month never
# measured or calibrated still shows nothing.
if [ "${_tt30:-0}" != 0 ] 2>/dev/null && [ "$_tt30" -gt 0 ] 2>/dev/null && [ "${_t30:-0}" -ge 0 ] 2>/dev/null; then
  # A quota-shaped month: same bar grammar as the 5h/wk segments.
  _t30=${_t30:-0}
  _p30=$(( (_t30 * 100 + _tt30 / 2) / _tt30 )); [ "$_p30" -gt 100 ] && _p30=100
  c=$(uc "$_p30")
  _mr=""; [ "${moreset:-0}" != 0 ] && [ "${moreset%.*}" -gt "$(date +%s)" ] 2>/dev/null && _mr=" ${DIM}·${R}${WHT}$(until_str "$moreset")${R}"
  # Cache READS ride beside the pair, not inside it: they are charged (a tenth of input — most
  # of the real $ below) but the quota unit stays what Claude itself counts, the unit the maxed-
  # week ceilings validated. The ↺ glyph is the same one line 2 uses for the session's reads.
  _bt="~$(human "$_t30")/$(human "$_tt30")"
  [ "${reads30:-0}" != 0 ] 2>/dev/null && [ "${reads30%.*}" -gt 0 ] 2>/dev/null && _bt="$_bt +$(human "$reads30")↺"
  # The month head is deferred like its neighbours; the money and promo below are appended to the
  # rendered segment in pass 2, so they still read apart from the quota bar.
  _mohead=1; defer "$_p30" "$_bt" "mo" " ${c}${_p30}%${R}${_mr}"
elif [ "${_t30:-0}" != 0 ] 2>/dev/null; then
  _mo="${DIM}mo${R} ${DIM}~$(human "$_t30") tok${R}"
fi
# A plan with no rolling windows (pay-as-you-go API, Enterprise) is charged what Claude Code reports: the month shows
# that spend, without the ~ of an estimate. Every other plan shows the list-price estimate.
_m30=$(money "$cost30"); _e30="~"
if [ -z "$five_pct" ] && [ -z "$week_pct" ] && [ -z "$_c5q" ] && [ -z "$_c7q" ]; then
  _s30=$(money "$spend30"); [ -n "$_s30" ] && { _m30=$_s30; _e30=""; costt30=""; }
fi
[ -n "$_m30" ] && { _mt30=$(money "$costt30"); _mo="${_mo:+$_mo ${DIM}·${R} }${LORG}${_e30}${_m30}${_mt30:+/~$_mt30}${R}"; _mo="${_mo:-${DIM}mo${R} ${LORG}${_e30}${_m30}${R}}"; }
[ -n "$promo7" ] && _mo="${_mo:+$_mo }${YEL}${promo7//:/ }${R}"
# The month's money/promo tail rides on the deferred bar when there is one, and stands as its own
# segment when there is not.
if [ "${_mohead:-0}" = 1 ]; then _motail="${_mo:+ ${DIM}·${R} $_mo}"
else _motail=""; [ -n "$_mo" ] && parts+=("$_mo"); fi
# The saved machine a window drawn came from, named as OAK's readouts name it (core machineNote, in its order): the
# machine alone when every window drawn came from it, else each machine with its windows (`build-box: wk mo`). One dim
# segment ahead of the windows, where OAK's bars put `(build-box)` after `claude`: it is read before the figures it
# names, and as a segment of its own it wraps whole, heading the rows on a pane too narrow for it beside a window.
_nw=0; _nb=0; _nms=(); _nls=()
_name() { _nw=$(( _nw + 1 )); [ -n "$2" ] || return 0; local k=0
  while [ "$k" -lt "${#_nms[@]}" ] && [ "${_nms[$k]}" != "$2" ]; do k=$(( k + 1 )); done
  _nb=$(( _nb + 1 )); _nms[$k]=$2; _nls[$k]="${_nls[$k]:+${_nls[$k]} }$1"; }
[ -n "$five_pct" ] && _name 5h "$_sm5"
[ -n "$week_pct" ] && _name wk "$_sm7"
[ -n "$_fbp" ] && _name "$_fname" "$_smf"
{ [ "${_mohead:-0}" = 1 ] || [ "${_t30:-0}" != 0 ]; } && _name mo "$_smm"
if [ "$_nb" -gt 0 ]; then
  if [ "${#_nms[@]}" = 1 ] && [ "$_nb" = "$_nw" ]; then _from=${_nms[0]}
  else _from=""; for (( _k = 0; _k < ${#_nms[@]}; _k++ )); do _from="${_from:+$_from; }${_nms[$_k]}: ${_nls[$_k]}"; done; fi
  parts=("${DIM}(${_from})${R}" ${parts[@]+"${parts[@]}"})
fi

# PASS 2 — one width for every bar: the widest figures in the render, the ctx gauge on line 2
# included, so the two lines carry bars of the same length. +2 for a cell of air each side of the
# centred figures; a floor of 10 keeps an all-uncalibrated row from drawing slivers.
bw=0
for _t in ${btxt[@]+"${btxt[@]}"}; do [ "${#_t}" -gt "$bw" ] && bw=${#_t}; done
[ "${#ctx_txt}" -gt "$bw" ] && bw=${#ctx_txt}
bw=$(( bw + 2 )); [ "$bw" -lt 10 ] && bw=10
# LABEL WIDTH: line 2 opens with `ctx` and line 3 with its first window, and the two bars only line
# up in a column if those labels are padded to one width. Only the FIRST segment
# of line 3 is padded — the rest sit after a divider, where nothing is above them to align with.
labw=3; [ "${#blab[@]}" -gt 0 ] && [ "${#blab[0]}" -gt "$labw" ] && labw=${#blab[0]}
build_line2 "$bw" "$labw"
emit_head

# A NARROW PANE (2026-11-03) compacts the gauges before it wraps them. Each window is built three ways: with its bar,
# as text without the bar (`5h ~1.2M/9M 42% ·2h 10m`), and without its token figures (`5h 42% ·2h 10m`). The render
# measures each row and prints the first that fits on one row; only the last wraps. Without COLUMNS, the bars.
l3=(); l3t=(); l3s=()
for p in ${parts[@]+"${parts[@]}"}; do
  _t=$p; _s=$p
  case "$p" in
    bar:*) _i=${p#bar:}
      _lab="${blab[$_i]}"
      # only the first segment is padded into line with the ctx gauge above it
      [ "$_i" = 0 ] && while [ "${#_lab}" -lt "$labw" ]; do _lab="$_lab "; done
      _c=$(uc "${bpct[$_i]}")
      p="${_c}${_lab}${R} $(bar "${bpct[$_i]}" "${btxt[$_i]}" "$bw" "$_c")${bsuf[$_i]}"
      _s="${_c}${blab[$_i]}${R}${bsuf[$_i]}"
      _t="${_c}${blab[$_i]}${R}${btxt[$_i]:+ ${DIM}${btxt[$_i]}${R}}${bsuf[$_i]}"
      ;;
  esac
  # NO DIVIDER between the gauges: every segment already opens with its own
  # label and its painted bar sets it apart, so a pipe between them was one more thing to read.
  l3+=("$p"); l3t+=("$_t"); l3s+=("$_s")
done
# The money and promo are their OWN segment, not a tail on the mo bar: they already read apart from
# the quota bars, and riding along made mo the one segment too wide to wrap on a narrow window.
[ "${_mohead:-0}" = 1 ] && [ -n "$_mo" ] && { l3+=("$_mo"); l3t+=("$_mo"); l3s+=("$_mo"); }
# rowfits SEGMENT... -> whether the segments fit one COLUMNS-wide row, two columns between each: one measure of the row.
rowfits() { local r="" s; for s in "$@"; do r="${r:+$r  }$s"; done; vw "$r" >/dev/null; [ "$_vw" -le "$COLUMNS" ]; }
if [ "${COLUMNS:-0}" -gt 0 ] 2>/dev/null && [ "${#l3[@]}" -gt 0 ] && ! rowfits "${l3[@]}"; then
  if rowfits "${l3t[@]}"; then l3=("${l3t[@]}"); else l3=("${l3s[@]}"); fi
fi
emit "  " "" ${l3[@]+"${l3[@]}"}
exit 0
STATUSLINE_EOF
chmod +x "$CLAUDE_DIR/statusline.sh"

# --- merge statusLine into settings.json, preserving any existing settings ---
# The foreign-statusLine guard already ran, BEFORE the script write above — reaching here means the
# existing entry was empty or ours, or --force backed the file up.
# QUOTE the path. Unquoted, a config dir with a space — the norm on Windows, where $HOME is
# /c/Users/First Last — produced `bash /c/Users/First Last/.claude/statusline.sh`, which Claude Code
# runs as bash with TWO arguments, so the status line simply never rendered. (Local fix: upstream
# cell-observatory/claude-statusline carries the unquoted form, and scripts/sync-statusline.sh
# overwrites this file wholesale — a test in packages/core/test/core.test.js fails if a sync drops it.)
CMD="bash \"$CLAUDE_DIR/statusline.sh\""
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
tmp="$(mktemp)"
{ if [ -n "$SBOM" ]; then printf '\357\273\277'; fi; settings_json | jq --arg cmd "$CMD" '.statusLine = {type:"command", command:$cmd, refreshInterval:60}'; } > "$tmp"
mv "$tmp" "$SETTINGS"

echo "OK installed status line on this host:"
echo "    script:   $CLAUDE_DIR/statusline.sh"
echo "    settings: $SETTINGS  (statusLine -> $CMD)"
echo "  Open a fresh 'claude' session here; usage appears after the first reply."

# --- codex too: the same readout, as far as codex allows ---
# codex has no command-backed status line (openai/codex#20244 is still open) — [tui].status_line
# picks from BUILT-IN items only. The set below mirrors ours: model/branch/dir, then context,
# the 5h and weekly windows, tokens, and the session's own cost estimate. Same guard philosophy
# as settings.json: an existing status_line that is not ours is another rig's choice — REFUSED
# (no --force here; edit config.toml yourself). TOML-safe: keys are injected INSIDE an existing
# bare [tui] table when there is one; a new [tui] table is appended only when none exists
# (a [tui.sub] table does not count — TOML allows defining the super-table later).
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"  # honor CODEX_HOME like every other codex path (core codexHome())
if [ -d "$CODEX_DIR" ] && command -v python3 >/dev/null 2>&1; then
  python3 - "$CODEX_DIR/config.toml" <<'PYEOF2'
import re, sys
cfg = sys.argv[1]
ITEMS = 'status_line = ["model-with-reasoning", "git-branch", "current-dir", "context-used", "five-hour-limit", "weekly-limit", "used-tokens", "estimated-thread-cost"]  # oak-statusline'
COLORS = 'status_line_use_colors = true  # oak-statusline'
try:
    text = open(cfg, encoding='utf-8').read()
except FileNotFoundError:
    text = ''
# A byte order mark first (Codex reads past it) is set aside, so a [tui] header right after it is found, and
# put back first, once. (Local fix.)
bom = '\ufeff' if text.startswith('\ufeff') else ''
text = text[len(bom):]
lines = text.split('\n')
if any('status_line' in ln and '# oak-statusline' not in ln and not ln.strip().startswith('#') for ln in lines):
    print('codex: a status_line that is not ours is already configured - left untouched.')
    sys.exit(0)
# Strip only our CONTENT lines. The '[tui]  # oak-statusline' HEADER must survive: removing it
# orphaned any keys the user later added under our table onto the ROOT table —
# and TOML table headers with inner whitespace ('[ tui ]') are valid, so the match allows them.
def _is_tui_header(ln):
    return re.match(r'^\[\s*tui\s*\]\s*(#.*)?$', ln.strip()) is not None
lines = [ln for ln in lines if '# oak-statusline' not in ln or _is_tui_header(ln)]
out = []
injected = False
for ln in lines:
    out.append(ln)
    if not injected and _is_tui_header(ln):
        out.append(ITEMS)
        out.append(COLORS)
        injected = True
while out and out[-1] == '': out.pop()  # both branches: re-runs must not grow trailing blanks
if not injected:
    out += ['', '[tui]  # oak-statusline', ITEMS, COLORS]
open(cfg, 'w', encoding='utf-8').write(bom + '\n'.join(out) + '\n')
print('codex: status line configured (' + cfg + ') - restart codex to see it.')
PYEOF2
fi
