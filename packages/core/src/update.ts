/**
 * THE update decision — one function, for every surface and every front end.
 *
 * Before this existed the same question ("is there something to install, and what?") was answered in
 * three places with three different rules: the CLI's `update` (which special-cased a channel switch),
 * the VS Code notifier (which used a bare `isNewer`, so it could never move backwards), and the
 * version chip (which resolved the pre-release channel differently again). They disagreed, and the
 * disagreements were exactly the reported bugs. Everything now derives from `resolveUpdatePlan`.
 *
 * THE RULE: the channel is AUTHORITATIVE. A surface is acted on whenever its installed version
 * DIFFERS from the channel's newest — not when it is merely older. `isNewer` cannot express a
 * downgrade, which is what a stable⇄pre-release switch is half the time, and it silently strands
 * anything sitting ABOVE the channel line:
 *
 *   `dev` publishes 0.10.0-dev.N, which by semver §11 sorts BELOW the plain 0.10.0 a local build
 *   carries. An install at 0.10.0 therefore reported "up to date" on the dev channel forever, and on
 *   stable too (0.9.x is lower still). Following a channel means matching it, in both directions.
 *
 * Pure over parsed JSON: no network, no filesystem, no process. The callers do the I/O — they read
 * what is installed, they run the installs — and this decides. That is what makes the whole matrix
 * testable without standing up a release server.
 */
import { ReleaseInfo, UpdateChannel, resolveReleaseFromList, versionOfRelease } from './channel';
import { compareVersions } from './semver';

/** The three things a release installs. One row each — an editor family counts as one `vscode`
 *  surface per editor, distinguished by `label` (VS Code, Cursor, …). */
export type UpdateSurface = 'cli' | 'vscode' | 'jetbrains';

/**
 * Why a surface is being acted on — or why it is not.
 *
 *   behind    installed sorts below the target: the ordinary update
 *   ahead     installed sorts ABOVE the target: stranded (a local build, or a channel switched
 *             downward). Acted on, because following a channel means matching it.
 *   switching the version is equal but the channel changed — a reinstall so the bits match the
 *             channel the config now names
 *   missing   not installed at all (only `install-extensions` asks for these)
 *   forced    `--force`: reinstall regardless
 *   current   nothing to do
 */
export type UpdateReason = 'behind' | 'ahead' | 'switching' | 'missing' | 'forced' | 'current';

/** One installed surface, as the caller found it on disk. `version: null` = not installed. */
export interface InstalledSurface {
  surface: UpdateSurface;
  /** What a human calls it: 'CLI', 'VS Code', 'Cursor', 'JetBrains (PyCharm2026.1)'. */
  label: string;
  version: string | null;
  /** False when something is installed but this machine offers no way to update it (no editor CLI
   *  found, an unwritable plugin dir). Kept in the plan so the caller can say so out loud instead of
   *  skipping in silence. */
  actionable?: boolean;
  /** Free-form passthrough for the caller's own bookkeeping (extension dirs, the editor CLI path).
   *  Never read here — this module stays pure. */
  ref?: unknown;
}

/** A surface that needs work, and why. `to` is always the channel's target version. */
export interface UpdateAction {
  surface: UpdateSurface;
  label: string;
  from: string | null;
  to: string;
  reason: UpdateReason;
  actionable: boolean;
  ref?: unknown;
}

export interface UpdatePlan {
  channel: UpdateChannel;
  /** The release the channel resolves to, and its version. */
  release: ReleaseInfo | null;
  target: string;
  /** True when `dev` resolved to the stable release: the list has no pre-release, or its newest
   *  pre-release ranks below stable. Callers say which rather than advertise a pre-release. */
  degradedToStable: boolean;
  /** Every surface the caller declared, each with its verdict — `current` ones included, because a
   *  chip that only lists what is stale cannot tell "up to date" from "not checked". */
  surfaces: UpdateAction[];
  /** The subset needing work: everything whose reason is not `current`. */
  actions: UpdateAction[];
}

/** The verdict for one surface. Split out so the ordering rule lives in exactly one place. */
function reasonFor(
  installed: InstalledSurface,
  target: string,
  opts: { switching?: boolean; force?: boolean }
): UpdateReason {
  if (installed.version === null) return 'missing';
  if (opts.force) return 'forced';
  const cmp = compareVersions(installed.version, target);
  // Equal version, but the channel just changed: reinstall so the bits provably come from the
  // channel the config now names. Without this a stable→dev switch at the same version number
  // leaves an install nobody can attribute to either channel.
  if (cmp === 0) return opts.switching ? 'switching' : 'current';
  return cmp < 0 ? 'behind' : 'ahead';
}

/**
 * Resolve what should happen, for every surface, on `channel`.
 *
 * `releases` is the parsed `/releases` list (newest first, as GitHub returns it) — the SAME list for
 * both channels; `resolveReleaseFromList` picks. Returns a plan with an empty `actions` when there is
 * nothing to do, and `release: null` / `target: ''` when the list yields no usable release at all
 * (the caller decides whether that is fatal — `--check` reports it, `update` fails).
 */
export function resolveUpdatePlan(
  releases: ReleaseInfo[],
  channel: UpdateChannel,
  installed: InstalledSurface[],
  opts: { switching?: boolean; force?: boolean } = {}
): UpdatePlan {
  const release = resolveReleaseFromList(releases ?? [], channel);
  const target = versionOfRelease(release) ?? '';
  // `resolveReleaseFromList` falls back to stable when the dev channel has no pre-release (or when a
  // just-promoted stable outranks the rolling one). Report that rather than letting the caller
  // announce a pre-release it is not about to install — the bug the version chip had.
  const degradedToStable = channel === 'dev' && release !== null && release.prerelease !== true;
  if (!release || !target) {
    return {
      channel,
      release: null,
      target: '',
      degradedToStable: false,
      surfaces: [],
      actions: [],
    };
  }
  const surfaces: UpdateAction[] = installed.map((s) => ({
    surface: s.surface,
    label: s.label,
    from: s.version,
    to: target,
    reason: reasonFor(s, target, opts),
    actionable: s.actionable !== false,
    ref: s.ref,
  }));
  return {
    channel,
    release,
    target,
    degradedToStable,
    surfaces,
    actions: surfaces.filter((a) => a.reason !== 'current'),
  };
}

/**
 * The release asset a surface installs from, by KIND rather than by name — the two channels name
 * their assets differently (`…-v0.9.4.vsix` vs `…-vscode-dev.vsix`), so a name pattern would have to
 * know which channel it is on.
 *
 * String predicates, deliberately, not regexes. `/jetbrains.*\.zip$/` is polynomial: an unanchored
 * literal followed by `.*` and a suffix backtracks over every starting position, so a name like
 * `jetbrainsjetbrains…` costs quadratic time. These names arrive from a release API (overridable to
 * a mirror), which makes that reachable rather than theoretical — the same class already fixed once
 * in `versionOfRelease`. `includes`/`endsWith` are linear and say the intent more plainly anyway.
 */
export function assetFor<T extends { name?: string }>(assets: T[], surface: UpdateSurface): T | null {
  const matches = (raw: string): boolean => {
    const n = raw.toLowerCase();
    if (surface === 'cli') return n.endsWith('.tgz');
    if (surface === 'vscode') return n.endsWith('.vsix');
    return n.includes('jetbrains') && n.endsWith('.zip');
  };
  return (assets ?? []).find((a) => matches(String(a?.name ?? ''))) ?? null;
}
