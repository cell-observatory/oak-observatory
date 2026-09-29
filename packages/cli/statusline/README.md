# Bundled claude-statusline

`install-statusline.sh` is a **vendored copy** of
[cell-observatory/claude-statusline](https://github.com/cell-observatory/claude-statusline)
(self-contained installer; it embeds the whole status line). It ships inside the
`oak-observatory` npm package so `oak statusline` can install the status line
with no network and no second repo — the Usage bars in the VS Code / JetBrains front-ends read
the `statusline-last.json` it writes.

- Upstream stays the source of truth for statusline-only users.
- Vendored from upstream commit `3ff1e1b` (branch `0.4.0`). This copy also carries changes upstream
  does not have yet: the usage bars are drawn as rules under their figures, the rows wrap at the
  terminal width, the session title follows OAK's order, the usage windows count each message
  once and only this machine's own turns, in a herdr pane a changed title starts OAK's tab sync
  (`oak __tab-sync`) in the background, and the rows render intact under Git Bash on Windows.
- Refresh this copy with `bash scripts/sync-statusline.sh` from the repository root, then commit the
  diff. The script lists the local changes a sync must keep.
