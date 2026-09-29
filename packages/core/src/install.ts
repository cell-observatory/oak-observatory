/**
 * Installer: careful merge of the PreToolUse/PostToolUse capture hooks into ~/.claude/settings.json.
 * Shared by the CLI (`oak init`) and the VS Code extension so there is one source of truth.
 * Adds only the `hooks` entries; never disturbs existing permissions/statusLine/etc.
 */
import * as fs from 'fs';
import * as path from 'path';
import { claudeConfigDir } from './paths';
import { rootDir } from './store';

export const MATCHER = 'Edit|Write|MultiEdit|NotebookEdit|Bash';

/** Matchers shipped by earlier versions — migrated in place to MATCHER on re-init (adds Bash capture). */
const LEGACY_MATCHERS = ['Edit|Write|MultiEdit|NotebookEdit'];

/** Stable, path-independent marker appended (as a shell comment) to our hook command. */
export const HOOK_MARKER = 'oak-observatory-hook';

/** Markers shipped before the OAK rename (the product was `claude-observatory`). Still recognized so
 *  re-running `init` MIGRATES an old install's hook in place — addTo replaces it with the current
 *  canonical command — and so an old hook is still counted as installed until then. */
const LEGACY_HOOK_MARKERS = ['claude-observatory-hook'];

interface HookCmd {
  type: string;
  command: string;
}
interface HookGroup {
  matcher?: string;
  hooks: HookCmd[];
}

export function settingsPath(): string {
  return path.join(claudeConfigDir(), 'settings.json');
}

/** Project-scoped settings file (checked into a repo so teammates get capture). */
export function projectSettingsPath(cwd: string): string {
  return path.join(cwd, '.claude', 'settings.json');
}

/**
 * True if a command string is one of ours. Primary signal is the stable HOOK_MARKER (works no
 * matter where the repo/package lives); the path-based check is a fallback for legacy/manual entries.
 */
export function isOurCommand(cmd: string): boolean {
  if (cmd.includes(HOOK_MARKER)) return true;
  if (LEGACY_HOOK_MARKERS.some((m) => cmd.includes(m))) return true;
  return /(\boak\b|claude[-_](observatory|changes)|claude_review)/.test(cmd) && /capture(\.js)?["']?\s*$/.test(cmd.trim());
}

function readSettings(file: string): { path: string; exists: boolean; data: any } {
  if (!fs.existsSync(file)) return { path: file, exists: false, data: {} };
  const data = JSON.parse(fs.readFileSync(file, 'utf8')); // throws on invalid JSON — caller handles
  return { path: file, exists: true, data };
}

/** readSettings for the WRITE paths: a malformed settings.json becomes a GUIDING error (naming the
 *  file and pointing at the .bak) instead of a raw SyntaxError. The read-only probes above degrade
 *  quietly, but a mutation must stop loudly so the user repairs the JSON before we rewrite it. */
function readSettingsForWrite(file: string): { path: string; exists: boolean; data: any } {
  try {
    return readSettings(file);
  } catch (e) {
    throw new Error(
      `Cannot parse ${file}: ${(e as Error).message}. Fix the JSON (a backup may exist at ${file}.bak) and retry.`
    );
  }
}

/** Atomically replace the settings file: write a temp sibling, then rename it into place, so a crash
 *  mid-write can never truncate the user's settings.json. Mirrors the cache writers (store/analyze).
 *  Callers write the .bak first, so a rare rename failure still leaves a recovery copy. */
function writeSettingsFile(p: string, data: any): void {
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, p); // atomic: a concurrent reader sees old-or-new, never a torn file
}

/** Coerce a possibly-mangled settings value into a HookGroup[] (a hand-edited file may hold the
 *  wrong shape — e.g. an object where an array is expected). Never throws. */
function hookGroups(data: any, event: string): HookGroup[] {
  const v = data?.hooks?.[event];
  return Array.isArray(v) ? v : [];
}

/** Are our capture hooks already present (PreToolUse)? */
export function hooksInstalled(file: string = settingsPath()): boolean {
  let data: any;
  try {
    data = readSettings(file).data;
  } catch {
    return false;
  }
  return hookGroups(data, 'PreToolUse').some((g) =>
    (Array.isArray(g.hooks) ? g.hooks : []).some((h) => isOurCommand(h.command))
  );
}

/** The installed capture command (from PreToolUse), or null if not installed. */
export function installedHookCommand(file: string = settingsPath()): string | null {
  let data: any;
  try {
    data = readSettings(file).data;
  } catch {
    return null;
  }
  for (const g of hookGroups(data, 'PreToolUse')) {
    for (const h of Array.isArray(g.hooks) ? g.hooks : []) {
      if (isOurCommand(h.command)) return h.command;
    }
  }
  return null;
}

/**
 * Upsert OUR hook entry for one event: exactly one canonical entry survives, in the MATCHER group.
 *
 * This used to dedupe on EXACT command equality only, so any variant rendering of our command — a
 * dist path that moved, the marker arriving in a later version, a legacy shape — appended a second
 * entry beside the first. Both fired on every tool call (double snapshot, double tree-walk), and an
 * uninstall that recognized only one shape left the other behind. Replacing every entry
 * `isOurCommand` recognizes with the one canonical command makes a version upgrade a REPLACEMENT,
 * never a double — and makes re-running `init` the repair for installs the old behavior doubled.
 */
function addTo(events: Record<string, HookGroup[]>, event: string, command: string): boolean {
  const matcher = matcherFor(event);
  const list = (events[event] = events[event] || []);
  // Census first: how many entries of ours exist, and is the canonical one already in place?
  let ours = 0;
  let canonical = false;
  for (const g of list) {
    for (const h of Array.isArray(g.hooks) ? g.hooks : []) {
      if (!isOurCommand(h.command)) continue;
      ours++;
      if (h.command === command && g.matcher === matcher) canonical = true;
    }
  }
  if (ours === 1 && canonical) return false; // exactly right already — a no-op re-init
  // Remove every entry of ours, of any vintage, pruning only the groups OUR removal emptied — a
  // user's own empty group, however odd, is not ours to tidy.
  for (let i = list.length - 1; i >= 0; i--) {
    const g = list[i];
    const hooks = Array.isArray(g.hooks) ? g.hooks : [];
    if (!hooks.some((h) => isOurCommand(h.command))) continue;
    g.hooks = hooks.filter((h) => !isOurCommand(h.command));
    if (g.hooks.length === 0) list.splice(i, 1);
  }
  // Always OUR OWN group. The upsert used to append into any group carrying our matcher, which
  // was safe while that matcher was a tool list nobody else writes; with `*` on the attention
  // events it would land our entry inside a foreign managed group (Orca, herdr and Superset all
  // install `*` groups) — mutating a group that is not ours to touch. Every entry of ours is gone
  // by this point, so a fresh group is always the right home.
  list.push({ matcher, hooks: [{ type: 'command', command }] });
  return true;
}

/**
 * The matcher OUR group carries for one event. Claude Code matches it against a different field
 * per event (tool name for Pre/PostToolUse, PostToolUseFailure and PermissionRequest, the notification TYPE for
 * Notification, nothing for Stop and UserPromptSubmit), so one string cannot serve them all:
 * the tool list on a Notification group is compared to `permission_prompt` and never matches —
 * which is exactly what the 2026-09-02 attention install did, so claude's permission and input
 * hands never fired live (Stop, which ignores matchers, did). Capture stays scoped to the edit
 * tools + Bash; everything else is match-all — a permission wait on ANY tool is a raised hand.
 */
export function matcherFor(event: string): string {
  return event === 'PreToolUse' || event === 'PostToolUse' || event === 'PostToolUseFailure' ? MATCHER : '*';
}

/** Upgrade a pre-existing hook group (our command, an older matcher) to the current MATCHER, so
 *  re-running `init` extends an old install to also capture Bash — without adding a duplicate group. */
function migrateMatchers(hooks: Record<string, HookGroup[]>): boolean {
  let migrated = false;
  for (const event of Object.keys(hooks)) {
    const list = hooks[event];
    if (!Array.isArray(list)) continue;
    for (const g of list) {
      if (
        g.matcher &&
        g.matcher !== MATCHER &&
        LEGACY_MATCHERS.includes(g.matcher) &&
        (Array.isArray(g.hooks) ? g.hooks : []).some((h) => isOurCommand(h.command))
      ) {
        g.matcher = MATCHER;
        migrated = true;
      }
    }
  }
  return migrated;
}

export interface InstallResult {
  changed: boolean;
  settingsPath: string;
  backupPath?: string;
  /** Set when the settings write succeeded but the install ledger could not be updated — the
   *  install is real, the RECORD of it is not, and the caller must say so. */
  ledgerError?: string;
}

// --- the install ledger --------------------------------------------------------------------------
//
// Every settings file this installer writes is recorded here, store-side — NEVER in the settings
// file itself (that would be us decorating a file users hand-edit and commit). Before the ledger,
// no record existed of which files we had written: `uninstall` defaulted to the user scope while
// project-scoped installs (committed into repos) were never enumerated, so they had to be hunted
// by hand. A FILE at the store root is safe from `clean`: allStoreSessionIds keeps only
// DIRECTORIES that parse as session ids, and a file is neither.

/** One settings file this installer has written. */
export interface LedgerEntry {
  path: string;
  scope: 'user' | 'project';
  /** ms epoch of the last install into this file. */
  ts: number;
}

export function ledgerPath(): string {
  return path.join(rootDir(), 'install-ledger.json');
}

/** Every settings file the ledger knows about. Missing/corrupt ledger reads as empty — the marker
 *  scan of the user scope is the pre-ledger fallback, so an empty ledger degrades, never lies. */
export function readLedger(): LedgerEntry[] {
  try {
    const v = JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'));
    if (!Array.isArray(v?.files)) return [];
    return v.files.filter(
      (e: unknown): e is LedgerEntry =>
        typeof (e as LedgerEntry)?.path === 'string' && ((e as LedgerEntry).scope === 'user' || (e as LedgerEntry).scope === 'project')
    );
  } catch {
    return [];
  }
}

function writeLedger(files: LedgerEntry[]): void {
  fs.mkdirSync(rootDir(), { recursive: true });
  const tmp = `${ledgerPath()}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ files }, null, 2) + '\n');
  fs.renameSync(tmp, ledgerPath()); // atomic, like every store write
}

function recordInstall(file: string, scope: 'user' | 'project'): void {
  const files = readLedger().filter((e) => e.path !== file);
  files.push({ path: file, scope, ts: Date.now() });
  writeLedger(files);
}

function forgetInstall(file: string): void {
  const files = readLedger();
  const kept = files.filter((e) => e.path !== file);
  if (kept.length !== files.length) writeLedger(kept);
}

/** The scope a settings path implies. Everything that is not THE user settings file is a project
 *  file — the two are the only shapes the installer writes. */
function scopeOf(file: string): 'user' | 'project' {
  return path.resolve(file) === path.resolve(settingsPath()) ? 'user' : 'project';
}

/** Install both hook entries. `command` is the exact shell command Claude Code will run. */
export function installHooks(command: string, file: string = settingsPath()): InstallResult {
  const { path: p, exists, data } = readSettingsForWrite(file);
  if (!exists) fs.mkdirSync(path.dirname(p), { recursive: true });
  const hooks = (data.hooks = data.hooks || {});
  const migrated = migrateMatchers(hooks);
  // One entry per event in CAPTURE_HOOK_EVENTS — capture (Pre/Post/PostToolUseFailure), attention (Notification/Stop,
  // 2026-09-02) and the structured pair (PermissionRequest/UserPromptSubmit, 2026-09-15). Same
  // command, same marker, same merge — a user's own hooks on any of these events (sync scripts and
  // the like) are left beside, never disturbed. Driven by the constant so the installer and the
  // health count cannot drift apart.
  let added = false;
  for (const event of CAPTURE_HOOK_EVENTS) if (addTo(hooks, event, command)) added = true;
  const changed = migrated || added;
  let backupPath: string | undefined;
  if (changed) {
    // Back up the ORIGINAL file (only when we're actually going to modify it — a no-op re-init
    // must not clobber a good backup).
    if (exists) {
      backupPath = p + '.bak';
      fs.writeFileSync(backupPath, fs.readFileSync(p));
    }
    writeSettingsFile(p, data);
  }
  // Recorded on EVERY install call, changed or not: an unchanged re-init over a pre-ledger install
  // is exactly the moment the ledger learns about it. A ledger failure must not fail an install
  // that already happened — it is reported instead, and the marker scan remains the fallback.
  let ledgerError: string | undefined;
  try {
    recordInstall(p, scopeOf(p));
  } catch (e) {
    ledgerError = String((e as Error)?.message || e);
  }
  return { changed, settingsPath: p, backupPath, ledgerError };
}

/** Remove any of our capture hooks. */
export function uninstallHooks(file: string = settingsPath()): InstallResult {
  const { path: p, exists, data } = readSettingsForWrite(file);
  if (!exists || !data.hooks) {
    // Nothing installed here — and the ledger should not claim otherwise.
    try {
      forgetInstall(p);
    } catch {
      /* a stale ledger row is harmless; uninstallEverywhere reports per-file state anyway */
    }
    return { changed: false, settingsPath: p };
  }
  const hooks = data.hooks as Record<string, HookGroup[]>;
  let changed = false;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue; // leave a hand-mangled (non-array) shape untouched
    for (const g of hooks[event]) {
      const list = Array.isArray(g.hooks) ? g.hooks : [];
      const before = list.length;
      g.hooks = list.filter((h) => !isOurCommand(h.command));
      if (g.hooks.length !== before) changed = true;
    }
    hooks[event] = hooks[event].filter((g) => (Array.isArray(g.hooks) ? g.hooks : []).length > 0);
    if (hooks[event].length === 0) delete hooks[event];
  }
  if (changed) {
    fs.writeFileSync(p + '.bak', fs.readFileSync(p));
    writeSettingsFile(p, data);
  }
  let ledgerError: string | undefined;
  try {
    forgetInstall(p);
  } catch (e) {
    ledgerError = String((e as Error)?.message || e);
  }
  return { changed, settingsPath: p, ledgerError };
}

// --- multi-file operations: status, uninstall-everywhere, repair ---------------------------------

/** The union of every location the ledger records and the user settings file — the user scope is
 *  always probed because pre-ledger installs exist and the marker scan still finds them there. */
function knownSettingsFiles(): { path: string; scope: 'user' | 'project' }[] {
  const out = new Map<string, 'user' | 'project'>();
  out.set(path.resolve(settingsPath()), 'user');
  for (const e of readLedger()) {
    const key = path.resolve(e.path);
    if (!out.has(key)) out.set(key, e.scope);
  }
  return [...out].map(([p, scope]) => ({ path: p, scope }));
}

/**
 * Hook commands in a settings file that are NOT ours — other tools' managed entries. Orca, herdr
 * and Superset all install PostToolUse hooks (typically matcher `*`) into the same contested file;
 * this names them so `status` can show what else lives there. VISIBILITY ONLY: nothing in this
 * installer ever modifies, moves or removes a foreign entry — the upsert and the uninstall both
 * filter strictly on `isOurCommand`.
 */
export function foreignHooks(file: string = settingsPath()): string[] {
  let data: unknown;
  try {
    data = readSettings(file).data;
  } catch {
    return [];
  }
  const hooks = (data as { hooks?: Record<string, unknown> })?.hooks ?? {};
  const out = new Set<string>();
  for (const event of Object.keys(hooks)) {
    for (const g of hookGroups(data, event)) {
      for (const h of Array.isArray(g.hooks) ? g.hooks : []) {
        if (typeof h?.command === 'string' && h.command && !isOurCommand(h.command)) out.add(h.command);
      }
    }
  }
  return [...out];
}

/** One settings file's install state, as `install --status` prints it. */
export interface InstallStatusRow {
  path: string;
  scope: 'user' | 'project';
  /** The settings file exists on disk. */
  exists: boolean;
  /** Our hook is present (PreToolUse probe, same as hooksInstalled). */
  installed: boolean;
  /** The installed command, when present. */
  command: string | null;
  /** How many entries of ours exist across CAPTURE_HOOK_EVENTS. Healthy is exactly
   *  HEALTHY_HOOK_ENTRIES — one per event; more is the doubled-hook defect the upsert repairs,
   *  fewer a partial install the repair completes. */
  entries: number;
  /** Other tools' hook commands in the same file — reported, never touched. */
  foreign: string[];
}

/** The hook events the installer writes one of our entries into (capture: Pre/Post, plus
 *  PostToolUseFailure, which Claude Code fires INSTEAD of PostToolUse when a tool fails — a Bash
 *  command that exits non-zero — so without it that command's snapshot was never claimed and its
 *  changes never recorded, 2026-09-26; attention: Notification/Stop, 2026-09-02; structured
 *  attention: PermissionRequest names the TOOL a permission prompt waits on and UserPromptSubmit
 *  marks the turn's start, 2026-09-15 — the pair codex has had since its hooks landed). A healthy
 *  install has exactly one of our command per event, so `installStatus().entries ===
 *  HEALTHY_HOOK_ENTRIES`; more is the doubled-hook defect, fewer a partial install. Consumers (CLI
 *  status/doctor) and the installer itself iterate this constant, never a literal, so adding an event
 *  here cannot leave a stale count behind. */
export const CAPTURE_HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'PermissionRequest', 'UserPromptSubmit', 'SessionEnd'] as const;
export const HEALTHY_HOOK_ENTRIES = CAPTURE_HOOK_EVENTS.length;

/** The events in CAPTURE_HOOK_EVENTS that carry no entry of ours: what an install written by an older
 *  OAK lacks until `oak init` runs again. Capture keeps working meanwhile, so doctor names these
 *  instead of calling the install broken. */
export function missingHookEvents(file: string = settingsPath()): string[] {
  let data: any;
  try {
    data = readSettings(file).data;
  } catch {
    return [];
  }
  return CAPTURE_HOOK_EVENTS.filter(
    (event) => !hookGroups(data, event).some((g) => (Array.isArray(g.hooks) ? g.hooks : []).some((h) => isOurCommand(h.command)))
  );
}

export function installStatus(): InstallStatusRow[] {
  return knownSettingsFiles().map(({ path: p, scope }) => {
    const exists = fs.existsSync(p);
    let entries = 0;
    if (exists) {
      try {
        const data = readSettings(p).data;
        for (const event of CAPTURE_HOOK_EVENTS) {
          for (const g of hookGroups(data, event)) {
            entries += (Array.isArray(g.hooks) ? g.hooks : []).filter((h) => isOurCommand(h.command)).length;
          }
        }
      } catch {
        /* unreadable JSON: reported below as not-installed; repair/uninstall will surface the error */
      }
    }
    return { path: p, scope, exists, installed: hooksInstalled(p), command: installedHookCommand(p), entries, foreign: foreignHooks(p) };
  });
}

/** The per-file outcome of a multi-file operation. `error` carries a parse failure the caller must
 *  show — a file we cannot read is a file we did NOT clean. */
export interface MultiFileResult {
  path: string;
  scope: 'user' | 'project';
  changed: boolean;
  /** For repair: what happened, said in one word the CLI can print. */
  action?: 'repaired' | 'installed' | 'ok' | 'skipped';
  error?: string;
}

/**
 * Remove our hooks from EVERY file the ledger records, plus the user scope (the pre-ledger
 * fallback). Files that are gone are reported and forgotten, never re-created.
 */
export function uninstallEverywhere(): MultiFileResult[] {
  return knownSettingsFiles().map(({ path: p, scope }) => {
    try {
      const r = uninstallHooks(p);
      return { path: p, scope, changed: r.changed, error: r.ledgerError };
    } catch (e) {
      return { path: p, scope, changed: false, error: String((e as Error)?.message || e) };
    }
  });
}

/**
 * The self-fix for older installs (the doubled-hook defect): re-run the upsert install over every
 * known location. `installHooks` IS the repair now — one canonical entry per event survives — so
 * this only adds enumeration and the rule that repair never resurrects: a ledger-recorded settings
 * file that no longer exists is skipped and forgotten, not re-created in a repo that may be gone.
 */
export function repairInstall(command: string): MultiFileResult[] {
  return knownSettingsFiles().map(({ path: p, scope }) => {
    // The user-scope file may legitimately not exist yet (fresh machine): install it. A missing
    // PROJECT file means the repo moved or removed it — leave it gone.
    if (scope === 'project' && !fs.existsSync(p)) {
      try {
        forgetInstall(p);
      } catch {
        /* stale row; reported by --status if it persists */
      }
      return { path: p, scope, changed: false, action: 'skipped' as const, error: 'file no longer exists — removed from the ledger' };
    }
    try {
      const existed = fs.existsSync(p) && hooksInstalled(p);
      const r = installHooks(command, p);
      return {
        path: p,
        scope,
        changed: r.changed,
        action: r.changed ? (existed ? ('repaired' as const) : ('installed' as const)) : ('ok' as const),
        error: r.ledgerError,
      };
    } catch (e) {
      return { path: p, scope, changed: false, error: String((e as Error)?.message || e) };
    }
  });
}

/**
 * Does `cmd` point at OUR `<configDir>/statusline.sh`?
 *
 * Not a substring test, because the two strings are written by different worlds. The installer is bash
 * (`install-statusline.sh`), so under Git Bash it writes `bash /c/Users/me/.claude/statusline.sh` —
 * MSYS-shaped, forward slashes, drive as a leading path segment. Node's `path.join(configDir, …)`
 * produces `C:\Users\me\.claude\statusline.sh`. A raw `.includes()` between those is false forever,
 * which meant that on Windows:
 *
 *   • `statuslineInstalled()` always said no, so `update` silently never refreshed the status line, and
 *   • `uninstallStatusline()` skipped the settings edit but deleted the script anyway — leaving
 *     settings.json pointing at a file that no longer exists, so every Claude Code render errored.
 *
 * Normalizing separators alone does NOT fix it: `/c/users/…` still is not `c:/users/…`. The drive
 * prefix has to be folded too, in all three shapes a Windows box produces — MSYS/Git Bash `/c/`,
 * Cygwin `/cygdrive/c/`, and WSL `/mnt/c/`. Matching stays CASE-INSENSITIVE on win32 only (NTFS is,
 * POSIX is not — folding case on Linux would let `~/tools/StatusLine.sh` read as ours).
 */
export function referencesOurStatusline(
  cmd: string,
  configDir: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (typeof cmd !== 'string' || !cmd) return false;
  // Join with the TARGET platform's rules, not the host's. `path.join` follows whatever machine this
  // runs on, so on a Windows host the posix branch built `/home/u/.claude\statusline.sh` and matched
  // nothing — the `platform` parameter has to reach the path construction too, or it only half works.
  const ours = (platform === 'win32' ? path.win32 : path.posix).join(configDir, 'statusline.sh');
  if (platform !== 'win32') return cmd.includes(ours);
  const norm = (s: string) =>
    s
      .replace(/\\/g, '/')
      .replace(/^\/(?:mnt|cygdrive)\/([a-z])\//i, '$1:/') // WSL / Cygwin
      .replace(/(^|[\s"'=])\/(?:mnt|cygdrive)\/([a-z])\//gi, '$1$2:/')
      .replace(/^\/([a-z])\//i, '$1:/') // MSYS / Git Bash
      .replace(/(^|[\s"'=])\/([a-z])\//gi, '$1$2:/')
      .toLowerCase();
  return norm(cmd).includes(norm(ours));
}

/**
 * Revert the bundled status line — but ONLY if settings.json's `statusLine.command` still points at
 * OUR `<configDir>/statusline.sh` (never disturb a user's own custom statusLine). Also removes the
 * vendored script, its cache and its tab-title record. Part of `uninstall --all`.
 */
export function uninstallStatusline(file: string = settingsPath()): {
  changed: boolean;
  settingsPath: string;
  scriptRemoved: boolean;
  /** True when the script was deliberately LEFT because a setting still points at it. */
  scriptKept: boolean;
} {
  const { path: p, exists, data } = readSettingsForWrite(file);
  const ourScript = path.join(claudeConfigDir(), 'statusline.sh');
  let changed = false;
  const sl = data.statusLine as { command?: string } | undefined;
  const pointsAtOurs = !!sl && referencesOurStatusline(sl.command ?? '', claudeConfigDir());
  if (exists && pointsAtOurs) {
    delete data.statusLine;
    changed = true;
    fs.writeFileSync(p + '.bak', fs.readFileSync(p));
    writeSettingsFile(p, data);
  }
  // Deleting the script while a surviving setting still points AT OUR SCRIPT is worse than leaving
  // both: Claude Code then errors on every render, once a minute, with nothing naming us. That is what
  // happened on Windows, where the match always failed so the settings edit was skipped and the unlink
  // was not. The gate uses OUR matcher — an earlier version tested for the bare name `statusline.sh`,
  // which also kept our script alive whenever a user's own script merely shared the filename, leaking
  // it forever and silently.
  // `referencesOurStatusline` handles every shape the INSTALLER writes, but a hand-edited settings.json
  // can hold an unexpanded one — `bash $HOME/.claude/statusline.sh`, `~/.claude/statusline.sh` — which no
  // path comparison can resolve. Those must not be deleted out from under a live setting, so fall back to
  // "names statusline.sh inside a directory called like our config dir". Deliberately NOT the bare
  // basename: that also matched a user's own /opt/theirs/statusline.sh and leaked our script forever.
  const cfgLeaf = path.basename(claudeConfigDir()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const looksLikeOurs = new RegExp(`${cfgLeaf}[\\\\/]statusline\\.sh`).test(String(sl?.command ?? ''));
  const stillOurs = !changed && looksLikeOurs;
  let scriptRemoved = false;
  const removable = stillOurs
    ? [path.join(claudeConfigDir(), 'statusline-last.json')]
    : [ourScript, path.join(claudeConfigDir(), 'statusline-last.json')];
  for (const f of removable) {
    try {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        if (f === ourScript) scriptRemoved = true;
      }
    } catch {
      /* best-effort */
    }
  }
  // The script's record of the tab titles it started a sync for (a pane id and a session title each):
  // conversation content, and as disposable as its cache.
  try {
    fs.rmSync(path.join(claudeConfigDir(), 'statusline-tab-titles'), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  // Surfaced, never silent: the caller prints only when something happened, so a skipped removal has
  // to be its own signal.
  return { changed, settingsPath: p, scriptRemoved, scriptKept: stillOurs && fs.existsSync(ourScript) };
}

/**
 * Is OUR bundled status line the one installed on this machine? True only when the settings.json
 * statusLine command points at a statusline.sh under the config dir AND that script exists — a user
 * running some other status line (or none) must never have theirs touched by an update.
 */
export function statuslineInstalled(): boolean {
  const dir = claudeConfigDir();
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    const cmd = settings?.statusLine?.command;
    // The FULL config-dir path, matching uninstallStatusline — a bare 'statusline.sh' substring also
    // matched a user's own ~/tools/my-statusline.sh, and `update` would then have overwritten a status
    // line that was never ours. Via referencesOurStatusline, which knows the installer writes an
    // MSYS-shaped path on Windows while path.join here writes a native one.
    if (!referencesOurStatusline(typeof cmd === 'string' ? cmd : '', dir)) return false;
    return fs.existsSync(path.join(dir, 'statusline.sh'));
  } catch {
    return false; // no settings, unreadable settings — nothing of ours to refresh
  }
}
