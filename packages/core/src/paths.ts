/**
 * Single source of truth for the Claude config directory.
 *
 * Everything the observatory reads or writes lives under one directory: the edit store
 * (claude-observatory/), the per-session transcripts (projects/), the capture hooks in
 * settings.json, and the statusline usage cache (statusline-last.json). That directory is
 * CLAUDE_CONFIG_DIR when set — Claude Code's own override, commonly pointed at a mounted volume
 * inside a devcontainer so the store and history survive a container rebuild — otherwise ~/.claude.
 *
 * The capture hook runs as a subprocess of Claude Code and inherits the same CLAUDE_CONFIG_DIR, so
 * routing every path through here keeps the writer (hook) and the readers (CLI + VS Code sidebar)
 * pointed at the same place even when the config dir is relocated.
 */
import * as os from 'os';
import * as path from 'path';

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Claude Code's global config, which holds its login (`oauthAccount`): `.claude.json` in CLAUDE_CONFIG_DIR when that is
 *  set, else in the home, as Claude Code itself places it. */
export function claudeJsonPath(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
}

/**
 * Canonicalize a path's DRIVE-LETTER case (issue #43).
 *
 * Windows filesystems are case-insensitive but our record keys are strings: the same file reported as
 * `C:\\repo\\x` by one hook event and `c:\\repo\\x` by the next was tracked as two files, giving every
 * file a phantom created-record (+N −0) and a deleted-record twin (+0 −N) — and undoing the phantom
 * create DELETED the untouched file. A pure string transform, deliberately: it must be total (deletion
 * records reference paths that no longer exist, so realpath is not an option), free (it runs per record
 * in readLog), and platform-independent (the same tests run on every CI OS). Per-component case drift
 * beyond the drive letter is not normalized — no report of it exists, and resolving it would need
 * syscalls with all the costs this transform exists to avoid.
 */
export function canonPath(p: string): string {
  if (p.length >= 2 && p[1] === ':' && (p[2] === '\\' || p[2] === '/' || p.length === 2)) {
    const d = p[0];
    if (d >= 'a' && d <= 'z') return d.toUpperCase() + p.slice(1);
  }
  return p;
}
