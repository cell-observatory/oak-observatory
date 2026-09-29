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
if [ -f "$SETTINGS" ] && ! jq -e . "$SETTINGS" >/dev/null 2>&1; then
  echo "ERROR: $SETTINGS is not valid JSON — leaving it untouched. Fix it and re-run." >&2
  exit 1
fi
# Scalar-tolerant read: a plain-string statusLine (e.g. "ccusage statusline") used to error jq
# inside the substitution and kill the whole script under set -e — exit 5, no message. Any shape
# that is not our object lands in the foreign branch below and gets the honest REFUSED instead.
EXISTING=""
[ -f "$SETTINGS" ] && EXISTING="$(jq -r '.statusLine | if . == null then "" elif type == "object" then (.command // "unrecognized-statusLine-object") else tostring end' "$SETTINGS" 2>/dev/null || echo "unreadable-statusLine")"
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
#   Line 3: the quota bars — 5h | week | per-model week | month, each `label <bar> pct% · resets`
#
# THE BARS ARE RULES UNDER THE FIGURES: each one's used/total and +cached↺ are
# printed plainly, and the share is marked by UNDERLINING the first pct% of the field in the usage
# colour, the rest left dim. Nothing is painted — no brackets, no block glyphs, no background; the
# rule is the bar, the figures stay legible end to end, and the line still fits a narrow pane.
#
# EVERY BAR IS THE SAME LENGTH: the field is as wide as the widest figures anywhere in the render
# (the ctx gauge on line 2 included), with the figures LEFT-aligned in it so the rule always starts
# on the first digit. That width is only known once every segment is built, so line 3 is a TWO-PASS
# build and line 2 prints at the END — behind an EXIT trap, so a render killed during the window
# scan still emits its head.
#
# rate_limits.* fields are sent only for Claude.ai subscription plans (Pro/Max/Team)
# and only after the first API response in a session, so line 3 may be empty
# in a fresh session. Schema: https://code.claude.com/docs/en/statusline.md

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
# bar pct,text,width,colour -> the figures with a RULE under them: a `width`-cell field holding the
# figures LEFT-aligned, whose first pct% of CELLS are underlined and in the usage colour while the
# rest is dim and plain. Nothing is painted — no background, no block glyphs; the rule is the bar,
# and the figures stay legible end to end (after a painted field read as a slab
# and its fill edge cut numbers in half).
#
# LEFT-ALIGNED IS LOAD-BEARING. Right-aligned figures put the rule under the blank padding: at 37%
# of a 22-cell field the whole rule sat in the gap and stopped before the first digit, which is a
# gauge pointing at nothing.
#
# EVERY BAR IS THE SAME LENGTH: `width` is the widest figures in the whole render, passed in by the
# two-pass build below. A width smaller than the text cannot truncate a number — the field grows.
# An empty text still draws a bare rule, so a segment whose estimate has not calibrated yet shows
# its share rather than vanishing.
#
# THE RULE CARRIES THE USAGE COLOUR up to the share and goes GREY past it, and so do the figures it
# runs under — see the SGR 58 note above for why they cannot differ. The caps are always the usage
# colour: they mark the bar's extent, not its fill.
#
# THE RULE SPANS THE WHOLE FIELD, CAPS INCLUDED. The caps are underlined too:
# ▏ and ▕ are drawn at the LEFT and RIGHT EDGE of their cell, so an un-underlined cap leaves seven
# eighths of a cell of bare ground between it and the rule — the small gap that made the bar look
# broken at both ends. The rule is also ONE HUE throughout: the usage colour at full strength up to
# the share and DIMMED past it, so it reads as one line that fills rather than as a coloured stub
# beside a grey one. That is what makes the figures free to sit CENTRED on the bar — the gauge is
# read off where the colour drops, not off where the text starts.
# Slices with ${v:o:n}, which counts CHARACTERS under the UTF-8 locale forced above: the cache
# glyph is multibyte and a byte-slice would cut it in half.
ULN=$'\033[4m'
# The caps, as LITERAL glyphs: bash 3.2 (every stock macOS) has no \u escape in $'...' and would
# print the six characters \u258f instead of the tick.
CAPL="▏"; CAPR="▕"
# The figures past the share are GREY — as a 256-colour grey, NOT the DIM
# attribute, which also dims the rule drawn under them.
#
# NO SGR 58. A coloured underline (SGR 58) is the only way to hold a grey digit over a coloured
# rule, and it was tried: tmux stores it, but it does not reach a real screen here — the rule came
# out grey twice, observed live. An underline with no SGR 58 takes the cell's FOREGROUND, so one
# cell cannot colour the rule and grey the digit independently. The rule keeps the colour:
# the figures inside the share take its colour with it, and the rest stays grey.
GY=$'\033[38;5;245m'
BLANKS="                                        "
bar() { local p=${1%.*} txt="$2" w="${3:-0}" col="$4" field f
  case "$p" in ''|*[!0-9]*) p=0 ;; esac
  [ "$p" -gt 100 ] && p=100
  local left
  if [ -n "$txt" ]; then
    [ "$w" -lt $(( ${#txt} + 2 )) ] && w=$(( ${#txt} + 2 ))
    left=$(( (w - ${#txt}) / 2 ))
    field="${BLANKS:0:$left}$txt${BLANKS:0:$(( w - ${#txt} - left ))}"
  else
    [ "$w" -lt 8 ] && w=8; field="${BLANKS:0:$w}"
  fi
  f=$(( (p * w + 50) / 100 )); [ "$f" -gt "$w" ] && f=$w
  printf '%s%s%s%s%s' "$col$ULN$CAPL" "${field:0:$f}" "$GY" "${field:$f}" "$col$CAPR$R"; }
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
shopt -s extglob 2>/dev/null || true
# Visible width: the SGR sequences occupy no columns. Pure parameter expansion, because this runs
# once per segment per render and a sed per call is a process per segment.
vw() { local t="${1//$'\033'\[*([0-9;])m/}"; printf '%s' "${#t}"; }
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
    if [ "$w" -gt 0 ] && [ -n "$sub" ] && [ "$(vw "$seg")" -gt "$w" ]; then
      _split "$sub" "$seg"; first=1
      for piece in ${_sp[@]+"${_sp[@]}"}; do
        segs+=("$piece")
        if [ "$first" = 1 ]; then seps+=("$sep"); first=0; else seps+=("$sub"); fi
      done
    else segs+=("$seg"); seps+=("$sep"); fi
  done
  for seg in ${segs[@]+"${segs[@]}"}; do
    sw=$(vw "$seg"); pw=$(vw "${seps[$i]}")
    if [ -z "$line" ]; then line="$seg"; lw=$sw
    elif [ "$w" -gt 0 ] && [ $(( lw + pw + sw )) -gt "$w" ]; then
      printf '%s\n' "$line"; line="$seg"; lw=$sw
    else line="$line${seps[$i]}$seg"; lw=$(( lw + pw + sw )); fi
    i=$(( i + 1 ))
  done
  [ -n "$line" ] && printf '%s\n' "$line"; }
# Roll a PAST reset anchor forward by whole periods (2026-09-08: Claude Code 2.1.263 stopped
# sending resets_at while the percentages still arrive) — exact for the periodic weekly window,
# and for 5h the same one-period estimate Claude Code itself uses for an unknown reset.
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
[ "${#title}" -gt 48 ] && title="${title:0:47}…"

# Line 1 — when and where: the clock, the branch (only inside a git repo), the ~-abbreviated
# working directory, and the session title last.
pdir="$dir"; case "$dir" in "$HOME"*) pdir="~${dir#"$HOME"}";; esac
# Line 1 in solid white — the separators stay dim so the pieces still read apart.
l1=("${WHT}$(date +%H:%M)${R} ${DIM}·${R} ${WHT}$(date '+%b %d')${R}")
[ -n "$branch" ] && l1+=("${WHT}$branch${R}")
l1+=("${WHT}$pdir${R}")
[ -n "$title" ] && l1+=("${WHT}$title${R}")
emit " $DIM|$R " "" "${l1[@]}"

# Session token counters (input / output / cache reads) via the oak CLI this script
# ships with — the same split its Stats panel shows. Omitted (never zeroed) when the CLI is absent
# or the session has no usage yet, matching the shown-only-when-present rule of the other segments.
t_in=""; t_out=""; t_cr=""
# OAK_STATUSLINE marks this as the statusline's OWN usage read: `oak usage` kicks a detached month
# refresh (spawning the statusline) for editor-only machines, and without this flag THIS render would
# kick itself in a throttled loop. The editors' own `oak usage` calls carry no flag and still kick.
if [ -n "$sid" ] && command -v oak >/dev/null 2>&1; then
  read -r t_in t_out t_cr <<<"$( (cd "$dir" 2>/dev/null && OAK_STATUSLINE=1 oak usage --session "$sid" 2>/dev/null) \
    | jq -r '.sessionTokens | select(.total > 0) | "\(.input) \(.output) \(.cacheRead)"' 2>/dev/null)"
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
l2tail=""
[ -n "$model" ]  && l2tail="$model"
[ -n "$effort" ] && l2tail="$l2tail ${DIM}·${R} $effort"
[ "$thinking" = "true" ] && l2tail="$l2tail ${DIM}·${R} think"
case "$ostyle" in ''|null|default|Default) ;; *) l2tail="$l2tail ${DIM}·${R} $ostyle" ;; esac
[ -n "$t_in" ] && l2tail="$l2tail ${DIM}·${R} ${DIM}↑${R}$(human "$t_in") ${DIM}↓${R}$(human "$t_out") ${DIM}↺${R}$(human "$t_cr")"
{ [ -n "$dur_ms" ] && [ "${dur_ms%.*}" -ge 1000 ]; } && l2tail="$l2tail ${DIM}·${R} ${DIM}◷${R}$(dur_str "$dur_ms")"
# The context window closes line 2 as a compact `used/total pct%` figure — the bar
# it used to open line 2 with is gone. Kept out of the shared-width bar math above; it is text now.
[ -n "$ctx" ] && [ -n "$ctx_size" ] && l2tail="$l2tail ${DIM}·${R} $(uc "${ctx%.*}")$(human $(( ${ctx_in%.*} + ${ctx_out%.*} )))/$(human "$ctx_size") ${ctx%.*}%${R}"
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
emit_head() { [ "$_head_out" = 1 ] && return 0; _head_out=1; emit " $DIM|$R " " ${DIM}·${R} " "$line2" "$l2tail"; }
trap emit_head EXIT

# --- account-wide token ESTIMATE for the 5h/wk windows (rough, self-calibrating) ---
# Those windows expose ONLY a percentage, never tokens. We approximate absolute tokens as
#   est = used_percentage * tokens_per_percent
# where tokens_per_percent is LEARNED over time: each scan compares this machine's transcript
# throughput within the window against the account %. Usage inputs are local-only, so activity
# elsewhere can affect the percentage without appearing in measured tokens. A throttled scan
# stores calibration in statusline-usage.json; without python3 or a sample the estimate is omitted.
est5=""; est7=""; meas5=""; meas7=""
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
  # 5 minutes, 4 seconds of budget, silent on any failure; a value the payload carries still
  # wins. Every machine asks for itself — there is no cross-machine fallback for these.
  api_five_reset=""; api_week_reset=""; api_five_pct=""; api_week_pct=""; fable_pct=""; fable_reset=""; fable_label=""; api_ts_new=""
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
        if [ -n "$_usage" ] && printf '%s' "$_usage" | jq -e '.five_hour' >/dev/null 2>&1; then
          api_five_reset=$(to_epoch "$(printf '%s' "$_usage" | jq -r '.five_hour.resets_at // empty')")
          api_week_reset=$(to_epoch "$(printf '%s' "$_usage" | jq -r '.seven_day.resets_at // empty')")
          # The account's own shares too: with a new reset beside it, an old share read as this window's.
          api_five_pct=$(printf '%s' "$_usage" | jq -r '.five_hour.utilization // empty')
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
  # Candidate resets, best-forward wins: the payload's, the account API's, then the cached
  # anchor. Resets only move forward, so MAX is the real one; a value still in the past rolls
  # forward by whole periods. The cache write keeps the original payload/API anchor only, so
  # estimates never compound.
  best_reset() { local out="" v e; for v in "$@"; do e=$(to_epoch "$v"); [ -n "$e" ] || continue
    if [ -z "$out" ] || [ "$e" -gt "$out" ] 2>/dev/null; then out="$e"; fi; done; printf '%s' "$out"; }
  five_reset=$(best_reset "$five_reset" "$api_five_reset" "$(jq -r '.five_reset // empty' "$_slj" 2>/dev/null)")
  week_reset=$(best_reset "$week_reset" "$api_week_reset" "$(jq -r '.week_reset // empty' "$_slj" 2>/dev/null)")
  [ -n "$five_reset" ] && five_reset=$(roll_fwd "$five_reset" 18000)
  [ -n "$week_reset" ] && week_reset=$(roll_fwd "$week_reset" 604800)
  # Capture into a var, THEN here-string it. Never feed a heredoc-bearing command substitution
  # straight into a read here-string: macOS ships bash 3.2 as /bin/bash, and 3.2 cannot parse a
  # heredoc nested inside a double-quoted command substitution inside a here-string — it aborts the
  # WHOLE script with an unexpected-EOF error, so the status line never runs and its usage cache goes
  # stale. A plain assignment holding the heredoc parses everywhere.
  _fbp_py="${fable_pct:-}"
  [ -z "$_fbp_py" ] && _fbp_py=$(jq -r '.fable_pct // empty' "$_slj" 2>/dev/null)
  _uest=$(python3 - "$CFG_DIR/statusline-usage.json" "$CFG_DIR/projects" \
      "${five_pct:-0}" "${five_reset:-0}" "${week_pct:-0}" "${week_reset:-0}" "${_fbp_py:-0}" 2>/dev/null <<'PYEOF'
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
# API list prices per 1M tokens (input, output, cache-write, cache-read) — mirror of
# packages/core/src/pricing.ts CLAUDE_RATES; keep the two in sync (a source test pins both).
# The month $ figures are priced from these (list-price basis — the ledger
# only sees sessions that render a statusline, so it under-counts).
RATES = [
    ('claude-fable-5', (10, 50, 12.5, 0.25)),
    ('claude-mythos-5', (10, 50, 12.5, 0.25)),
    ('claude-opus-5', (5, 25, 6.25, 0.5)),
    ('claude-sonnet-5', (2, 10, 2.5, 0.2)),
    ('claude-opus-4', (15, 75, 18.75, 1.5)),
    ('claude-sonnet-4', (3, 15, 3.75, 0.3)),
    ('claude-haiku-4', (1, 5, 1.25, 0.1)),
    ('claude-3-5-haiku', (0.8, 4, 1, 0.08)),
]
def _rate(m):
    m = (m or '').lower()
    for _p, _r in RATES:
        if m.startswith(_p): return _r
    return (5, 25, 6.25, 0.5)  # family fallback (opus-5 tier)

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
            t = _i + _o + _cw
            w = 1 if own(o.get('cwd') or '') else 0
            mid = m.get('id') or (path + '#' + str(n))
            prev = ids.get(mid)
            if prev is None or t > prev[0] or (t == prev[0] and e < prev[2]):
                _mdl = (m.get('model') or '').lower()
                _ri, _ro, _rw, _rr = _rate(_mdl)
                # Top-tier family flag, for the account's per-model weekly cap (fable/mythos
                # share the tier). Rides each entry so the window loop can split without a
                # second parse.
                _fb = 1 if ('fable' in _mdl or 'mythos' in _mdl) else 0
                ids[mid] = [t, w, e, _cr, (_i * _ri + _o * _ro + _cw * _rw + _cr * _rr) / 1e6, _fb]
    except Exception: pass
    return ids
# `r5 or r7` used to be required here too. Without a reset time the windows simply anchor at now
# (see ws5/ws7 below), which is exactly right for a plan that has no reset to anchor to.
_scanned = False
if (now - last) >= THR or not st:
    # BaseException, NOT Exception: nearly all scan wall-time is inside scan(), whose broad
    # except Exception swallowed the alarm — so the 12s cap did not cap, and a partial per-file count
    # could be persisted into fc under a stable key. BaseException passes through untouched, reaches
    # the TO handler below, and the state dump there is what keeps later renders from re-paying the
    # timeout. The alarm seconds are env-tunable so a test can exercise this path deterministically.
    class TO(BaseException): pass
    try: signal.signal(signal.SIGALRM, lambda *a: (_ for _ in ()).throw(TO())); signal.alarm(int(os.environ.get("STATUSLINE_SCAN_ALARM", "12")))
    except Exception: pass
    _scanned = True
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
        # account itself — Claude Code caches oauthAccount.subscriptionCreatedAt in ~/.claude.json,
        # and anniversary billing renews on that day-of-month. Calendar 1st only when neither exists.
        _bd = 0
        try:
            _prefs = json.load(open(os.path.join(os.path.dirname(proj), 'claude-observatory', 'prefs.json')))
            _bdv = _prefs.get('billDay')
            if isinstance(_bdv, (int, float)) and 1 <= _bdv <= 31: _bd = int(_bdv)
        except Exception: pass
        if not _bd:
            try:
                _oa = (json.load(open(os.path.expanduser('~/.claude.json'))).get('oauthAccount') or {})
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
        st['mo_start'] = wsMO
        st['mo_end'] = mo_end  # beside its twin — a first-scan timeout used to persist one without the other
        # The parse horizon must reach the month's first day even in a 31-day month.
        ws30 = min(int((now - W30) // 86400 * 86400), wsMO)
        g = {}
        nfc = {}
        for path in glob.glob(os.path.join(proj, '**', '*.jsonl'), recursive=True):
            try: m = os.path.getmtime(path)
            except Exception: continue
            if m < ws30: continue
            if m >= ws5:                                   # active in last 5h: always parse fresh
                ids = scan(path, ws30)
            else:                                          # colder: id map cached by (mtime, horizon)
                c = fc.get(path)
                if c and c.get('mtime') == m and c.get('k') == ws30 and c.get('ev') == 4 and 'ids' in c:
                    ids = c['ids']
                else:
                    ids = scan(path, ws30)  # horizon holds all month, so the key is month-stable
            nfc[path] = {'mtime': m, 'k': ws30, 'ev': 4, 'ids': ids}
            gmerge(g, ids)
        nL5 = nL7 = nU5 = nU7 = nL30 = nU30 = nR30 = nR7 = nR5 = 0.0
        nRO5 = nRO7 = nRO30 = 0.0  # OWN reads — what this machine exports (additive across machines)
        nCLu30 = nCLo30 = 0.0      # month LIST-PRICE cost: union and own (own is what exports)
        nU7F = nR7F = 0.0          # UNION fable-family tokens/reads in the weekly window (the
                                   # per-model cap is account-wide; the union already is)
        for tw in g.values():
            t, w, e = tw[0], tw[1], tw[2]
            r = tw[3] if len(tw) > 3 else 0
            lc = tw[4] if len(tw) > 4 else 0
            if e >= wsMO:
                nU30 += t; nL30 += t * w; nR30 += r; nRO30 += r * w
                nCLu30 += lc; nCLo30 += lc * w
            if e >= ws7:
                nU7 += t; nL7 += t * w; nR7 += r; nRO7 += r * w
                if len(tw) > 5 and tw[5]: nU7F += t; nR7F += r
            if e >= ws5:
                nU5 += t; nL5 += t * w; nR5 += r; nRO5 += r * w
        L30, U30 = nL30, nU30
        st['R30'] = nR30; st['R7'] = nR7; st['R5'] = nR5
        st['RO30'] = nRO30; st['RO7'] = nRO7; st['RO5'] = nRO5
        st['CLu30'] = nCLu30; st['CLo30'] = nCLo30
        st['U7F'] = nU7F; st['R7F'] = nR7F
        L5, L7, U5, U7, fc, last = nL5, nL7, nU5, nU7, nfc, now
        try:
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
        # Usage is local-only. The local union includes any transcripts already synced here.
        st['a30'] = U30
        aU5 = U5; aU7 = U7
        st['a5'] = aU5; st['a7'] = aU7
        # CALIBRATED OVER TIME: one sample is one render's ratio; the smoothed
        # value converges across renders, weighted by how far the window has filled — a 60%-full
        # window pins the ratio far better than a 6%-full one. Not a ratchet: it moves both ways.
        def ewma(prev, sample, pct):
            a = 0.5 * min(1.0, pct / 40.0)
            return sample if not prev else prev + a * (sample - prev)
        if p5 >= 5 and aU5 > 0:
            tpp5 = aU5 / p5                                # calibrate only above the noise floor
            tppE5 = ewma(tppE5, tpp5, p5)
        if p7 >= 5 and aU7 > 0:
            tpp7 = aU7 / p7
            tppE7 = ewma(tppE7, tpp7, p7)
        # The fable cap runs low single digits for most of a week — a 5% floor would leave it
        # uncalibrated forever. Its numerator is a DIRECT union measurement of the family's own
        # tokens (not a projection), so the ratio is well-conditioned from 1% up.
        if pF >= 1 and nU7F > 0:
            tppF = ewma(tppF, nU7F / pF, pF)
        try:
            tmp = sp + '.tmp'
            json.dump({'v': 2, 'last_scan': last, 'L5': L5, 'L7': L7, 'U5': U5, 'U7': U7, 'L30': L30, 'U30': U30, 'a30': st.get('a30') or 0, 'tpp5': tpp5, 'tpp7': tpp7, 'tppE5': tppE5, 'tppE7': tppE7, 'cpp5': cpp5, 'cpp7': cpp7, 'ch': st.get('ch') or [], 'mo_end': st.get('mo_end') or 0, 'mo_start': st.get('mo_start') or 0, 'R30': st.get('R30') or 0, 'R5': st.get('R5') or 0, 'R7': st.get('R7') or 0, 'RO30': st.get('RO30') or 0, 'RO5': st.get('RO5') or 0, 'RO7': st.get('RO7') or 0, 'a5': st.get('a5') or 0, 'a7': st.get('a7') or 0, 'CLu30': st.get('CLu30') or 0, 'CLo30': st.get('CLo30') or 0, 'U7F': st.get('U7F') or 0, 'R7F': st.get('R7F') or 0, 'tppF': tppF, 'fc': fc}, open(tmp, 'w'))
            os.replace(tmp, sp)
        except Exception: pass
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
            json.dump({"v": 2, "last_scan": last, "L5": L5, "L7": L7, "U5": U5, "U7": U7, "L30": L30, "U30": U30, "a30": st.get("a30") or 0, "tpp5": tpp5, "tpp7": tpp7, "tppE5": tppE5, "tppE7": tppE7, "cpp5": cpp5, "cpp7": cpp7, "ch": st.get("ch") or [], "mo_end": st.get("mo_end") or 0, "mo_start": st.get("mo_start") or 0, "R30": st.get("R30") or 0, "R5": st.get("R5") or 0, "R7": st.get("R7") or 0, "RO30": st.get("RO30") or 0, "RO5": st.get("RO5") or 0, "RO7": st.get("RO7") or 0, "a5": st.get("a5") or 0, "a7": st.get("a7") or 0, "CLu30": st.get("CLu30") or 0, "CLo30": st.get("CLo30") or 0, "U7F": st.get("U7F") or 0, "R7F": st.get("R7F") or 0, "tppF": tppF, "fc": merged}, open(tmp, "w"))
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
# hidden-for-a-week.
_b5 = _base(now - 18000)
c5 = max(0.0, _cum - _b5) if _b5 is not None else 0.0
_b7 = _base(now - 604800)
if _b7 is not None:
    c7 = max(0.0, _cum - _b7)
else:
    c7 = 0.0
    try:
        for _v in (_cache.get('costs') or {}).values():
            if (_v.get('at') or 0) > now - 604800: c7 += _v.get('usd') or 0
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
# under-counts. The local union includes transcripts already synced onto this machine.
c30_own = st.get('CLo30') or 0.0
c30 = st.get('CLu30') or 0.0
def ewma2(prev, sample, pct):
    a = 0.5 * min(1.0, pct / 40.0)
    return sample if not prev else prev + a * (sample - prev)
if p5 >= 5 and c5 > 0: cpp5 = ewma2(cpp5, c5 / p5, p5)
if p7 >= 5 and c7 > 0: cpp7 = ewma2(cpp7, c7 / p7, p7)
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
# the turns THIS machine ran, so per-machine figures can be added without counting synced work twice.
# They are the only usage figure an account with no rolling windows can be given, honest for everyone.
# (No apostrophes in these comments: the heredoc is inside $( ), where bash still tracks quotes.)
print(f"{e5} {t5} {e7} {t7} {int(L5)} {int(L7)} {c5:.2f} {d5} {c7:.2f} {d7} {promo} 0 {c30:.2f} {d30} {a30} {tk30} {int(L30)} {int(st.get('mo_end') or 0)} {int(st.get('R30') or 0)} {int(st.get('R5') or 0)} {int(st.get('R7') or 0)} {c5_own:.2f} {c7_own:.2f} {c30_own:.2f} {int(st.get('RO5') or 0)} {int(st.get('RO7') or 0)} {int(st.get('RO30') or 0)} {int(st.get('a5') or 0)} {int(st.get('a7') or 0)} {eF} {tF} {int(st.get('R7F') or 0)}")
PYEOF
)
  read -r est5 tot5 est7 tot7 meas5 meas7 cost5 costt5 cost7 costt7 promo7 padj7 cost30 costt30 tok30 tokt30 meas30 moreset reads30 reads5 reads7 cost5own cost7own cost30own readso5 readso7 readso30 acct5 acct7 estf totf readsf <<<"$_uest"
# "-" = python ran and there IS no live promo (the cache must clear); "" = python never ran (keep $old).
promo7raw="$promo7"
[ "$promo7" = "-" ] && promo7=""
fi

# Persist the exact values so the OAK VS Code sidebar ("Usage" panel) shows the same
# numbers as this line — including the 5h/week token estimates (est5/est7, computed just above). Merge
# with the previous file so a turn missing rate_limits keeps the last known-good. Never fail the line.
_LAST="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline-last.json"
_old=$(cat "$_LAST" 2>/dev/null || echo '{}')
# If the existing file is corrupt/truncated/empty, --argjson would abort the jq below on EVERY
# turn and the persist would silently stop updating forever — fall back to '{}' so it self-heals.
printf '%s' "$_old" | jq -e . >/dev/null 2>&1 || _old='{}'
printf '%s' "$input" | jq -c --argjson old "$_old" --arg est5 "${est5:-}" --arg est7 "${est7:-}" --arg meas5 "${meas5:-}" --arg meas7 "${meas7:-}" --arg tot5 "${tot5:-}" --arg tot7 "${tot7:-}" --arg c5 "${cost5:-}" --arg ct5 "${costt5:-}" --arg c7 "${cost7:-}" --arg ct7 "${costt7:-}" --arg promo "${promo7raw:-}" --arg c30 "${cost30:-}" --arg ct30 "${costt30:-}" --arg tok30 "${tok30:-}" --arg tokt30 "${tokt30:-}" --arg meas30 "${meas30:-}" --arg moreset "${moreset:-}" --arg reads30 "${reads30:-}" --arg reads5 "${reads5:-}" --arg reads7 "${reads7:-}" --arg c5o "${cost5own:-}" --arg c7o "${cost7own:-}" --arg c30o "${cost30own:-}" --arg ro5 "${readso5:-}" --arg ro7 "${readso7:-}" --arg ro30 "${readso30:-}" --arg a5 "${acct5:-}" --arg a7 "${acct7:-}" --arg af "${api_five_reset:-}" --arg aw "${api_week_reset:-}" --arg ap5 "${api_five_pct:-}" --arg ap7 "${api_week_pct:-}" --arg fbp "${fable_pct:-}" --arg fbr "${fable_reset:-}" --arg fbl "${fable_label:-}" --arg ats "${api_ts_new:-}" --arg ftok "${estf:-}" --arg ftot "${totf:-}" --arg frd "${readsf:-}" --arg branch "${branch:-}" --arg tokcache "${t_cr:-}" '{
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
  five_pct: (.rate_limits.five_hour.used_percentage // ($ap5 | tonumber?) // $old.five_pct),
  # When the share was measured: a carried share keeps its time, so a reader can tell a share from the last window.
  five_at: (if .rate_limits.five_hour.used_percentage != null or (($ap5 | tonumber?) // null) != null then now else $old.five_at end),
  five_reset: (.rate_limits.five_hour.resets_at // (if $af == "" then null else ($af | tonumber) end) // $old.five_reset),
  week_pct: (.rate_limits.seven_day.used_percentage // ($ap7 | tonumber?) // $old.week_pct),
  week_at: (if .rate_limits.seven_day.used_percentage != null or (($ap7 | tonumber?) // null) != null then now else $old.week_at end),
  week_reset: (.rate_limits.seven_day.resets_at // (if $aw == "" then null else ($aw | tonumber) end) // $old.week_reset),
  fable_pct: (if $ats != "" then (($fbp | tonumber?) // null) else $old.fable_pct end),
  fable_reset: (if $ats != "" then (($fbr | tonumber?) // null) else $old.fable_reset end),
  fable_at: (if $ats != "" and (($fbp | tonumber?) // null) != null then now else $old.fable_at end),
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
  month_reset: (($moreset | tonumber?) // $old.month_reset),
  month_reads: (($reads30 | tonumber?) // $old.month_reads),
  five_reads: (($reads5 | tonumber?) // $old.five_reads),
  week_reads: (($reads7 | tonumber?) // $old.week_reads),
  month_tok: (($tok30 | tonumber?) // $old.month_tok),
  month_tok_total: (($tokt30 | tonumber?) // $old.month_tok_total),
  month_cost: (($c30 | tonumber?) // $old.month_cost),
  month_cost_total: (($ct30 | tonumber?) // $old.month_cost_total),
  branch: ($branch // $old.branch // ""),
  thinking: (.thinking.enabled // $old.thinking // false),
  output_style: (.output_style.name // $old.output_style // ""),
  tok_in: ((.context_window.total_input_tokens // 0) | if . > 0 then . else ($old.tok_in // 0) end),
  tok_out: ((.context_window.total_output_tokens // 0) | if . > 0 then . else ($old.tok_out // 0) end),
  tok_cache: (($tokcache | tonumber?) // $old.tok_cache),
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
}' > "$_LAST.tmp" 2>/dev/null && mv "$_LAST.tmp" "$_LAST" 2>/dev/null || true

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
# response of the session). ctx is NOT here: it opens line 2 now.
# Enterprise/API (no rolling quota, payload or cache): the 5h/wk slots say nothing an account
# without windows can use — the month segment below is its whole readout.
_LASTQ="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline-last.json"
_c5q=$(jq -r '.five_pct // empty' "$_LASTQ" 2>/dev/null); _c7q=$(jq -r '.week_pct // empty' "$_LASTQ" 2>/dev/null)
if [ -z "$five_pct" ] && [ -z "$week_pct" ] && [ -z "$_c5q" ] && [ -z "$_c7q" ]; then
  :
elif [ -n "$five_pct" ]; then c=$(uc "$five_pct"); s=""; [ -n "$five_reset" ] && s=" ${DIM}·${R}${WHT}$(until_str "$five_reset")${R}"
  # ~used/projected-total (total = 100% of the window's estimated budget); used-only until it calibrates
  _bt=""
  if [ "${tot5:-0}" != 0 ]; then _bt="~$(human "${est5:-0}")/$(human "$tot5")"; elif [ "${est5:-0}" != 0 ]; then _bt="~$(human "$est5")"; fi
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
[ -z "$_fbp" ] && _fbp=$(jq -r '.fable_pct // empty' "$_LASTQ" 2>/dev/null)
[ -z "$_fbr" ] && _fbr=$(jq -r '.fable_reset // empty' "$_LASTQ" 2>/dev/null)
[ -z "$_fbl" ] && _fbl=$(jq -r '.fable_label // empty' "$_LASTQ" 2>/dev/null)
if [ -n "$_fbp" ]; then
  _fbe=$(to_epoch "$_fbr"); [ -n "$_fbe" ] && _fbe=$(roll_fwd "$_fbe" 604800)
  c=$(uc "$_fbp"); s=""; [ -n "$_fbe" ] && s=" ${DIM}·${R}${WHT}$(until_str "$_fbe")${R}"
  _bt=""
  if [ "${totf:-0}" != 0 ]; then _bt="~$(human "${estf:-0}")/$(human "$totf")"; elif [ "${estf:-0}" != 0 ]; then _bt="~$(human "$estf")"; fi
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
  if [ "${tot7:-0}" != 0 ]; then _bt="~$(human "${est7:-0}")/$(human "$tot7")"; elif [ "${est7:-0}" != 0 ]; then _bt="~$(human "$est7")"; fi
  [ "${reads7:-0}" != 0 ] 2>/dev/null && [ "${reads7%.*}" -gt 0 ] 2>/dev/null && _bt="${_bt:+$_bt }+$(human "$reads7")↺"
  defer "$week_pct" "$_bt" "wk" " ${c}$(printf '%.0f' "$week_pct")%${R}${s}"
elif [ "${meas7:-0}" != 0 ]; then parts+=("${DIM}wk${R} $(human "$meas7") ${DIM}tok${R}")
else parts+=("${DIM}wk —${R}"); fi
# ONE dollar pair, MONTHLY, in its OWN |-divided segment: 30 days of spend
# against four weekly cycles of budget (spend alone when no quota projects one), plus the live
# promotion with its dates — money and promos read apart from the quota bars.
_mo=""
_t30="${tok30%.*}"; _tt30="${tokt30%.*}"
if [ "${_t30:-0}" != 0 ] 2>/dev/null && [ "${_tt30:-0}" != 0 ] 2>/dev/null && [ "$_tt30" -gt 0 ] 2>/dev/null; then
  # A quota-shaped month: same bar grammar as the 5h/wk segments.
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
_m30=$(money "$cost30"); [ -n "$_m30" ] && { _mt30=$(money "$costt30"); _mo="${_mo:+$_mo ${DIM}·${R} }${LORG}~${_m30}${_mt30:+/~$_mt30}${R}"; _mo="${_mo:-${DIM}mo${R} ${LORG}~${_m30}${R}}"; }
[ -n "$promo7" ] && _mo="${_mo:+$_mo }${YEL}${promo7//:/ }${R}"
# The month's money/promo tail rides on the deferred bar when there is one, and stands as its own
# segment when there is not.
if [ "${_mohead:-0}" = 1 ]; then _motail="${_mo:+ ${DIM}·${R} $_mo}"
else _motail=""; [ -n "$_mo" ] && parts+=("$_mo"); fi

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

l3=()
for p in ${parts[@]+"${parts[@]}"}; do
  case "$p" in
    bar:*) _i=${p#bar:}
      _lab="${blab[$_i]}"
      # only the first segment is padded into line with the ctx gauge above it
      [ "$_i" = 0 ] && while [ "${#_lab}" -lt "$labw" ]; do _lab="$_lab "; done
      _c=$(uc "${bpct[$_i]}")
      p="${_c}${_lab}${R} $(bar "${bpct[$_i]}" "${btxt[$_i]}" "$bw" "$_c")${bsuf[$_i]}"
      ;;
  esac
  # NO DIVIDER between the gauges: every segment already opens with its own
  # label and closes with its caps and share, so a pipe between them was one more thing to read.
  l3+=("$p")
done
# The money and promo are their OWN segment, not a tail on the mo bar: they already read apart from
# the quota bars, and riding along made mo the one segment too wide to wrap on a narrow window.
[ "${_mohead:-0}" = 1 ] && [ -n "$_mo" ] && l3+=("$_mo")
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
jq --arg cmd "$CMD" '.statusLine = {type:"command", command:$cmd, refreshInterval:60}' "$SETTINGS" > "$tmp"
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
open(cfg, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
print('codex: status line configured (' + cfg + ') - restart codex to see it.')
PYEOF2
fi
