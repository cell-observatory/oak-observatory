/**
 * Setup diagnostics — the rules and messaging behind `oak doctor`.
 *
 * Kept pure and environment-injected (binOnPath / jqPresent are probed by the CLI and passed in) so
 * it stays unit-testable and so any front-end can render the exact same checks via `doctor --json`.
 * This turns the tool's quiet setup footguns (hooks reverted mid-session, CLI not on PATH, a broken
 * settings.json) into explicit, actionable messages.
 */
import * as fs from 'fs';
import * as path from 'path';
import { claudeConfigDir } from './paths';
import { settingsPath, hooksInstalled, installedHookCommand, missingHookEvents, HOOK_MARKER, statuslineInstalled } from './install';
import { resolveSessionId, hasAssistantRecord } from './session';
import { findTranscript } from './observe';
import { readLog, rootDir } from './store';

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface Check {
  id: string;
  label: string;
  level: CheckLevel;
  detail: string;
  /** A concrete next action, present when level !== 'ok'. */
  fix?: string;
}

export interface DiagnoseInput {
  cwd: string;
  /** Whether `oak` resolves on PATH — the capture hook depends on it. null = unknown. */
  binOnPath?: boolean | null;
  /** Whether `jq` is available — the bundled status line needs it. null = unknown. */
  jqPresent?: boolean | null;
}

function settingsJsonValid(): boolean | null {
  const p = settingsPath();
  if (!fs.existsSync(p)) return null; // no file yet is not "invalid"
  try {
    JSON.parse(fs.readFileSync(p, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

/** Writable if the dir — or the nearest existing ancestor `init` would create it under — is writable. */
function writable(dir: string): boolean {
  let d = dir;
  while (!fs.existsSync(d)) {
    const parent = path.dirname(d);
    if (parent === d) return false;
    d = parent;
  }
  try {
    fs.accessSync(d, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Render checks as portable markdown (shown in an editor tab by both front-ends). */
export function diagnoseMarkdown(checks: Check[]): string {
  const icon = (l: CheckLevel) => (l === 'ok' ? '✅' : l === 'warn' ? '⚠️' : '❌');
  const lines: string[] = ['# OAK — setup check', ''];
  for (const c of checks) {
    lines.push(`### ${icon(c.level)} ${c.label}`, c.detail);
    if (c.fix) lines.push('', `**Fix:** ${c.fix}`);
    lines.push('');
  }
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  lines.push(
    '---',
    '',
    fails
      ? `**${fails} problem(s) to fix**${warns ? ` · ${warns} warning(s)` : ''}`
      : warns
        ? `Critical checks passed · ${warns} warning(s)`
        : 'All checks passed 🎉'
  );
  return lines.join('\n') + '\n';
}

/** Run every setup check and return them in report order (most foundational first). */
export function diagnose(input: DiagnoseInput): Check[] {
  const checks: Check[] = [];
  const cfg = claudeConfigDir();
  const usingOverride = Boolean(process.env.CLAUDE_CONFIG_DIR);

  // settings.json must parse before anything can read or write hooks.
  const valid = settingsJsonValid();
  checks.push(
    valid === false
      ? {
          id: 'settings-json',
          label: 'settings.json is valid JSON',
          level: 'fail',
          detail: `${settingsPath()} is not valid JSON — capture hooks can't be read or installed.`,
          fix: 'Fix the JSON (or restore the .bak beside it), then re-run `oak init`.',
        }
      : {
          id: 'settings-json',
          label: 'settings.json is valid JSON',
          level: 'ok',
          detail: valid === null ? `no settings.json yet (${settingsPath()})` : `${settingsPath()} parses cleanly`,
        }
  );

  // The capture hooks are the whole mechanism — without them nothing is tracked.
  const installed = hooksInstalled();
  const missing = installed ? missingHookEvents() : [];
  checks.push(
    installed && missing.length
      ? {
          id: 'hooks',
          label: 'capture hooks installed',
          level: 'warn',
          detail: `installed by an older OAK; not hooked: ${missing.join(', ')}`,
          fix: 'Run `oak init` with Claude Code CLOSED (a running session reverts mid-session hook edits).',
        }
      : installed
      ? { id: 'hooks', label: 'capture hooks installed', level: 'ok', detail: 'PreToolUse/PostToolUse hooks are present' }
      : {
          id: 'hooks',
          label: 'capture hooks installed',
          level: 'fail',
          detail: 'no capture hooks in settings.json — Claude edits are not being tracked.',
          fix: 'Run `oak init` with Claude Code CLOSED (a running session reverts mid-session hook edits).',
        }
  );

  // The hook command is `oak capture …` resolved from PATH; if the bin is missing there,
  // capture silently no-ops — the single most common "it's just not working" cause.
  if (input.binOnPath === false) {
    checks.push({
      id: 'bin-path',
      label: '`oak` on PATH',
      level: 'fail',
      detail: 'the capture hook runs `oak` from PATH, but it does not resolve here — capture will silently do nothing.',
      fix: 'Add the global npm bin dir (`$(npm prefix -g)/bin`) to your PATH, or reinstall the CLI.',
    });
  } else if (input.binOnPath === true) {
    checks.push({ id: 'bin-path', label: '`oak` on PATH', level: 'ok', detail: 'resolves on PATH' });
  }

  // A legacy/absolute hook command is brittle across machines and repo moves.
  const cmd = installedHookCommand();
  if (installed && cmd && !cmd.includes(HOOK_MARKER)) {
    checks.push({
      id: 'hook-shape',
      label: 'hook uses the portable marker',
      level: 'warn',
      detail: `the installed hook looks legacy/absolute: ${cmd}`,
      fix: 'Re-run `oak init` to migrate to the portable PATH-based hook.',
    });
  }

  // The store lives under the config dir; if it isn't writable, capture can't record.
  checks.push(
    writable(cfg)
      ? {
          id: 'config-dir',
          label: 'config dir writable',
          level: 'ok',
          detail: `${cfg}${usingOverride ? ' (CLAUDE_CONFIG_DIR)' : ''}`,
        }
      : {
          id: 'config-dir',
          label: 'config dir writable',
          level: 'fail',
          detail: `${cfg} is not writable — the edit store can't be updated.`,
          fix: 'Check permissions on the config dir (or CLAUDE_CONFIG_DIR, if set).',
        }
  );

  // "The directory is writable" and "a setting persists" are different claims, and only the second
  // one is what a channel switch depends on. A bind-mounted overlay or a network filesystem can
  // accept a write and not keep it, which makes `update --channel dev` report success and change
  // nothing — the exact shape that looks like a broken feature rather than a broken mount. The probe
  // is the file the channel really lives in: the store root's, which a moved store puts elsewhere.
  checks.push(channelRoundTrips(rootDir()));

  // A resolvable session with real capture activity is the proof the whole chain works end-to-end.
  const session = resolveSessionId(input.cwd);
  if (!session) {
    checks.push({
      id: 'session',
      label: 'active session resolves',
      level: 'warn',
      detail: `no agent session resolves for ${input.cwd}`,
      fix: 'Run doctor from your workspace root, or start a Claude Code or Codex session there.',
    });
  } else {
    const log = readLog(session);
    if (installed && log.length === 0) {
      // Distinguish the two honest no-edits cases so the fix advice never points at working hooks:
      // a session with no assistant reply yet (command-only stub / first turn in flight) vs a real
      // session that simply hasn't run an Edit/Write yet.
      const transcript = findTranscript(input.cwd, session);
      if (transcript && !hasAssistantRecord(transcript)) {
        checks.push({
          id: 'session',
          label: 'capture activity',
          level: 'warn',
          detail: `session ${session} resolves but has no assistant reply yet (command-only or just-started session).`,
          fix: 'The hooks are fine. If an earlier session holds your edits, pick it explicitly (session picker in the sidebar, or the claudeObservatory.session setting).',
        });
      } else {
        checks.push({
          id: 'session',
          label: 'capture activity',
          level: 'warn',
          detail: `session ${session} resolves, but no edits have been captured yet.`,
          fix: 'Normal for a fresh or read-only session. If Claude HAS edited files this session, the hooks were likely added mid-session — restart Claude Code.',
        });
      }
    } else {
      checks.push({ id: 'session', label: 'capture activity', level: 'ok', detail: `session ${session} · ${log.length} edit(s)` });
    }
  }

  // Bash capture walks the real directory tree only: a symlinked subtree is skipped (loop safety),
  // so its Bash-driven changes are invisible. Surface the blind spot instead of leaving it silent.
  try {
    const symDirs = fs
      .readdirSync(input.cwd, { withFileTypes: true })
      .filter((e) => {
        // Per-entry guard: one dangling (ENOENT), circular (ELOOP), or unreadable (EACCES) link
        // must not abort the whole check and silently drop warnings for the genuine ones.
        if (!e.isSymbolicLink()) return false;
        try {
          return fs.statSync(path.join(input.cwd, e.name)).isDirectory();
        } catch {
          return false;
        }
      })
      .map((e) => e.name);
    if (symDirs.length > 0) {
      checks.push({
        id: 'symlink-subtrees',
        label: 'symlinked subtrees',
        level: 'warn',
        detail: `${symDirs.slice(0, 3).join(', ')}${symDirs.length > 3 ? ', …' : ''} — Bash-driven changes under symlinked directories are not captured.`,
        fix: 'Edit/Write captures still work everywhere; only the Bash tree diff skips symlinks (loop safety).',
      });
    }
  } catch {
    /* cwd unreadable — other checks already cover that */
  }

  // The status line powers the 5h/week usage bars — nice-to-have, not required. Its usage cache
  // appears only once Claude Code draws it, so one installed a moment ago has none yet: that is not
  // "not installed", and telling the installers' closing doctor to install it again was wrong.
  const statuslineOn = fs.existsSync(path.join(cfg, 'statusline-last.json'));
  const noJq = input.jqPresent === false ? ' (jq not found; the status line needs bash + jq)' : '';
  checks.push(
    statuslineOn
      ? { id: 'statusline', label: 'status line active', level: 'ok', detail: 'usage cache present (plan-usage bars will render)' }
      : statuslineInstalled()
      ? { id: 'statusline', label: 'status line active', level: noJq ? 'warn' : 'ok',
          detail: `installed; its usage cache appears the next time Claude Code draws the status line${noJq}`,
          ...(noJq ? { fix: 'Install jq.' } : {}) }
      : {
          id: 'statusline',
          label: 'status line active',
          level: 'warn',
          detail: `no usage cache yet — the 5h/week bars will be empty${input.jqPresent === false ? ' (jq not found; the status line needs bash + jq)' : ''}.`,
          fix: 'Run `oak statusline` to install the bundled status line.',
        }
  );

  if (session) {
    const { captureIntegrity } = require('./integrity') as typeof import('./integrity');
    const health = captureIntegrity(session);
    const top = health.skipReasons[0];
    checks.push({ id: 'capture-integrity', label: 'capture integrity', level: health.healthy ? 'ok' : 'warn',
      detail: `${health.records} records; ${health.issues.length} integrity findings; ${health.skipped} capture gaps${top ? ` (${top.count} × ${top.reason})` : ''}; ${health.inFlight} pending snapshots`,
      ...(health.healthy ? {} : { fix: `oak integrity --session ${session} --json` }) });
  }
  if (session && (require('./session') as typeof import('./session')).describeSession(session).runtime.includes('codex')) {
    const { codexHooksStatus } = require('./codex') as typeof import('./codex');
    const { usageLine } = require('./observe') as typeof import('./observe');
    const { isOurCommand } = require('./install') as typeof import('./install');
    const cx = codexHooksStatus(isOurCommand);
    const hooks = checks.findIndex((c) => c.id === 'hooks');
    if (hooks >= 0) checks[hooks] = { id: 'hooks', label: 'Codex capture hooks', level: cx.trust === 'trusted' ? 'ok' : 'warn',
      detail: `${cx.installed ? 'configured' : 'not configured'}; trust configuration: ${cx.trust}. Configuration does not prove lifecycle or edit capture.`,
      ...(cx.trust === 'trusted' ? {} : { fix: 'oak init --codex' }) };
    const activity = checks.findIndex(c => c.id === 'session');
    const edits = readLog(session).length;
    if (activity >= 0) checks[activity] = { id: 'session', label: 'Codex capture activity', level: edits ? 'ok' : 'warn',
      detail: `session ${session} · ${edits} captured edit(s). ${edits ? 'Stored capture evidence is present; inspect integrity separately.' : 'No captured edits yet; configuration alone does not verify capture.'}` };
    const statusline = checks.findIndex(c => c.id === 'statusline');
    const usage = usageLine(input.cwd, session);
    if (statusline >= 0) checks[statusline] = { id: 'statusline', label: 'Codex usage evidence',
      level: usage.tokensIn !== null ? 'ok' : 'warn',
      detail: 'Codex usage comes from its selected rollout. Account limits require quota events; missing values remain unavailable. A Claude status line is not required.' };
    for (let i = checks.length - 1; i >= 0; i--) if (['settings-json', 'hook-shape'].includes(checks[i].id)) checks.splice(i, 1);
  }
  return checks;
}


/** Write the channel marker, read it back, and restore it. Proves the setting SURVIVES, not merely
 *  that the write returned without an error. */
function channelRoundTrips(dir: string): Check {
  const file = path.join(dir, 'channel');
  let before: string | null = null;
  try {
    before = fs.readFileSync(file, 'utf8');
  } catch {
    before = null; // absent is fine — stable is the default
  }
  const probe = `${before && before.trim() === 'dev' ? 'stable' : 'dev'}\n`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, probe);
    const back = fs.readFileSync(file, 'utf8');
    // Restore whatever was there before probing, including "absent".
    if (before === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, before);
    if (back !== probe) {
      return {
        id: 'channel-persist',
        label: 'update channel persists',
        level: 'fail',
        detail: `${file} accepted a write but did not keep it — \`update --channel\` will report success and change nothing.`,
        fix: 'That filesystem is not keeping writes (common on a bind-mounted or network directory). Keep the store on a real local path: `oak store --move <dir>`, or point CLAUDE_CONFIG_DIR there.',
      };
    }
    return { id: 'channel-persist', label: 'update channel persists', level: 'ok', detail: `${file} round-trips` };
  } catch (e) {
    return {
      id: 'channel-persist',
      label: 'update channel persists',
      level: 'fail',
      detail: `cannot write ${file} (${(e as NodeJS.ErrnoException).code ?? 'error'}) — switching channels will fail.`,
      fix: 'Make that directory writable by this user, or keep the store elsewhere: `oak store --move <dir>`, or set CLAUDE_CONFIG_DIR to a writable path. In a devcontainer the config dir is often bind-mounted read-only or owned by another uid.',
    };
  }
}
