# Bundled claude-statusline

`install-statusline.sh` is a **vendored copy** of
[cell-observatory/claude-statusline](https://github.com/cell-observatory/claude-statusline)
(self-contained installer; it embeds the whole status line). It ships inside the
`oak-observatory` npm package so `oak statusline` can install the status line
with no network and no second repo — the Usage bars in the VS Code / JetBrains front-ends read
the `statusline-last.json` it writes.

- Upstream stays the source of truth for statusline-only users.
- Vendored from upstream commit `3ff1e1b` (branch `0.4.0`). This copy also carries changes upstream
  does not have yet: the usage bars are progress bars painted in very dim colours with their figures
  inside, a month with no usage yet is a 0% bar, a window at 0% with no figures reads `~0`, each
  window shows and records its most recent share, the session's dated by that session's last reply or
  its newest subagent's, whichever is later, the account pull's by the pull, the recorded one by its
  stamp (so a session with no share since its window reset shows one measured inside it, and an idle
  session's old share neither shows nor replaces a newer one, also when two sessions redraw at once),
  each render reads and rewrites the cache under a lock (the directory `statusline-last.json.lock`, which
  it waits about a second for before it skips its write, so two renders started together no longer write
  each other's reading back, and which OAK's account pull takes by the same protocol, from
  `packages/core/src/statusline-lock.ts`) and through its own temporary file, the render that takes the
  lock removes what killed renders left beside the cache (their temporary files, and stale locks renamed
  aside) once it is more than two minutes old, a 5h window whose reset has passed reads
  0% with no countdown and no cache reads, an account pull that reports no 5h window keeps its weekly and
  per-model shares, an account with no five-hour limit (its usage answer carries no 5h window: `five_hour`
  null or missing, or its utilization null, as for a verified Ultra account) is recorded with when
  (`five_none_at`), as an answer that carries a 5h window is (`five_seen_at`), and while the newest of those
  answers, on this machine or, through `oak usage`, a saved machine, is a no-limit one, no 5h segment is drawn,
  whatever 5h share there is, nor any 5h share recorded,
  the rows wrap at the terminal width only after a row too wide has compacted (the model row drops the output
  style, think, the duration, the tokens with the agents, the session's own tokens and the effort, in that order,
  measuring the row again after each, and keeps the context figure; the gauges are drawn as text without their bars,
  then without their token figures, whichever first fits one row), the path and the title are never cut and wrap at
  their spaces, a session that started agents shows its own tokens and its tokens with every agent it started, each
  labelled (`own`, `with 2 agents`, from `oak usage`'s `sessionTreeTokens`), the 5-hour and weekly spend that
  Claude Code reported counts from the start of its window, as the window's tokens do (it counted the last 5 hours
  and the last 7 days), the session title follows OAK's order, the usage
  windows count each message once, in a herdr pane a changed title starts
  OAK's tab sync (`oak __tab-sync`) in the background, the rows render intact under Git Bash on
  Windows, and the month's dollar figure prices each model by the rules of OAK's own usage views
  (`packages/core/src/pricing.ts`), so a model OAK cannot price adds nothing, and prices 5-minute and 1-hour
  cache writes each at its own rate. Where this machine has no
  current reading of a window, the line draws the saved machine's reading of the same account that OAK's
  own readouts show, taken from the `oak usage` call it already makes, and names that machine in a dim
  label ahead of the windows (`(build-box)`, or `(build-box: wk mo)` when only some came from it); it
  records none of that reading in `statusline-last.json`, and none of it calibrates the token estimate.
  The token and dollar estimates calibrate against the account's measured usage, once a scan interval: the
  account's totals for the 5-hour, weekly and bill-cycle windows that the same `oak usage` call carries
  from OAK's local database (`usageTotals`, each message once across every machine whose usage the database
  holds, with what a saved machine that answers only with its readings measured of its own turns), and the
  month's tokens, cache reads and dollars are those totals. With them it reads no
  transcript and keeps no file map; without them (an OAK without the database, a database still building, or a
  window that turned over between the two reads) it scans this machine's transcripts as before and adds
  what each saved machine of the account measured of its own turns (`machineMeasured`). The cache records
  when and in which windows this machine's own turns were measured, for an older OAK on another machine
  to add. A sum that brings in more machines than the calibration has held starts its smoothing over. The
  month refresh OAK runs with no session makes the same call. The cache write takes the cache as it was
  on `jq`'s standard input rather than as an argument, which Linux refuses past 128 KiB.
- Refresh this copy with `bash scripts/sync-statusline.sh` from the repository root, then commit the
  diff. The script lists the local changes a sync must keep.
