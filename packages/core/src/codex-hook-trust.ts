import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface CodexCommandHook {
  type: 'command';
  command: string;
  commandWindows?: string | null;
  command_windows?: string | null;
  timeout?: number | null;
  async?: boolean;
  statusMessage?: string | null;
  additionalContextLimit?: number | null;
}

export interface CodexHookGroup {
  matcher?: string | null;
  hooks: CodexCommandHook[];
}

const EVENTS = new Set([
  'pre_tool_use', 'permission_request', 'post_tool_use', 'pre_compact', 'post_compact',
  'session_start', 'session_end', 'user_prompt_submit', 'subagent_start', 'subagent_stop',
  'stop', 'interrupt',
]);
const CONTEXT_EVENTS = new Set(['pre_tool_use', 'post_tool_use', 'session_start', 'user_prompt_submit', 'subagent_start']);
const NO_MATCHER_EVENTS = new Set(['user_prompt_submit', 'stop', 'interrupt']);

function unsignedInteger(value: number | null | undefined, field: string): void {
  if (value != null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Codex hook ${field} must be an exactly representable unsigned integer`);
  }
}

// Explicit serialization avoids JavaScript's special ordering of integer object keys. Codex sorts
// keys recursively and serializes compact UTF-8 JSON, with array order preserved and no newline.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Codex 0.154's trust fingerprint for a command hook (PascalCase or snake_case event name).
 * Ported from codex-rs/hooks/src/engine/discovery.rs::{append_matcher_groups,hook_hash},
 * hooks/src/events/common.rs::matcher_pattern_for_event, config/src/hook_config.rs and
 * config/src/fingerprint.rs::version_for_toml. Unsupported handler types throw, never guess.
 *
 * SHA-256 covers {event_name, hooks: [one normalized handler], matcher?}. The TOML value
 * intermediate omits absent optional fields. async=false is included; timeout is normalized;
 * commandWindows is resolved then omitted; statusMessage and applicable nondefault context limits
 * are retained. Commands are hashed BEFORE environment substitution. Neither the source filename,
 * group/handler index, description, siblings, script contents, nor any secret/salt is hashed.
 */
export function codexHookTrustHash(
  eventName: string,
  group: CodexHookGroup,
  handlerIndex = 0,
  platform: NodeJS.Platform = process.platform
): string {
  const event = eventName.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  if (!EVENTS.has(event)) throw new Error(`Unsupported Codex hook event: ${eventName}`);
  const hook = group.hooks[handlerIndex];
  if (!hook || hook.type !== 'command') throw new Error('Only Codex command hooks can be fingerprinted');
  const command = platform === 'win32' ? hook.commandWindows ?? hook.command_windows ?? hook.command : hook.command;
  if (typeof command !== 'string' || !command.trim()) throw new Error('Codex hook command must not be empty');
  if (hook.async !== undefined && typeof hook.async !== 'boolean') throw new Error('Codex hook async must be boolean');
  if (hook.statusMessage != null && typeof hook.statusMessage !== 'string') throw new Error('Codex hook statusMessage must be a string');
  if (group.matcher != null && typeof group.matcher !== 'string') throw new Error('Codex hook matcher must be a string');
  unsignedInteger(hook.timeout, 'timeout');
  unsignedInteger(hook.additionalContextLimit, 'additionalContextLimit');
  const shortTimeout = event === 'session_end' || event === 'interrupt';
  const timeout = Math.max(1, Math.min(hook.timeout ?? (shortTimeout ? 1 : 600), shortTimeout ? 3 : Infinity));
  const normalized: Record<string, unknown> = { type: 'command', command, timeout, async: hook.async ?? false };
  // SessionEnd executes synchronously, but Codex deliberately retains the configured async in its hash.
  if (hook.statusMessage != null) normalized.statusMessage = hook.statusMessage;
  if (CONTEXT_EVENTS.has(event) && hook.additionalContextLimit != null && hook.additionalContextLimit !== 2500) {
    normalized.additionalContextLimit = hook.additionalContextLimit;
  }
  const identity: Record<string, unknown> = { event_name: event, hooks: [normalized] };
  if (!NO_MATCHER_EVENTS.has(event) && group.matcher != null) identity.matcher = group.matcher;
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(identity), 'utf8').digest('hex')}`;
}

function readOptional(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
function herdrTrustCandidates(hooksFile: string, hooksText: string, platform: NodeJS.Platform): { key: string; hash: string }[] {
  const groups: CodexHookGroup[] = JSON.parse(hooksText).hooks?.SessionStart ?? [];
  const script = path.join(path.dirname(hooksFile), platform === 'win32' ? 'herdr-agent-state.ps1' : 'herdr-agent-state.sh');
  // herdr's integration/command.rs::hook_command writes this PowerShell -File form on Windows.
  const command = platform === 'win32'
    ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${script.replace(/"/g, '\\"')}" session`
    : `bash '${script.replace(/'/g, "'\\''")}' session`;
  const candidates: { key: string; hash: string }[] = [];
  groups.forEach((group, groupIndex) => {
    group.hooks.forEach((hook, handlerIndex) => {
      const effectiveCommand = platform === 'win32' ? hook.commandWindows ?? hook.command_windows ?? hook.command : hook.command;
      if (hook.type === 'command' && effectiveCommand === command) {
        candidates.push({ key: `${hooksFile}:session_start:${groupIndex}:${handlerIndex}`, hash: codexHookTrustHash('SessionStart', group, handlerIndex, platform) });
      }
    });
  });
  return candidates;
}

const LOCK_TIMEOUT_MS = 10_000;
/** Exclusive, cross-process section over ONE Codex configuration. Two installs (or an install and a
 * doctor --fix) that validate the same untrusted hook both passed the reread check and both appended
 * the same table, leaving a config no TOML parser accepts. The lock, not the append, prevents that.
 * A lock whose owner died is reclaimed by age: one crashed repair must not block every later one. */
function withConfigLock<T>(configFile: string, run: () => T): T {
  const lockFile = `${configFile}.oak-hook-trust.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number;
  for (;;) {
    try {
      fd = fs.openSync(lockFile, 'wx', 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let age = 0;
      try { age = Date.now() - fs.statSync(lockFile).mtimeMs; } catch { continue; /* released under us */ }
      if (age > LOCK_TIMEOUT_MS) {
        try { fs.unlinkSync(lockFile); } catch { /* another waiter reclaimed it first */ }
        continue;
      }
      if (Date.now() >= deadline) throw new Error('Another OAK process is repairing herdr hook trust; retry the install');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return run();
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(lockFile); } catch { /* reclaimed as stale */ }
  }
}

/** Append missing trust for herdr's installed SessionStart command only. Existing state (including
 * disabled or stale trust) is the user's and is never changed. Returns the number of entries added.
 * The caller supplies Codex's home so tests never fall back to the developer's real configuration.
 */
export function trustHerdrCodexHook(codexDir: string, platform: NodeJS.Platform = process.platform): number {
  const hooksFile = path.resolve(codexDir, 'hooks.json');
  const hooksText = readOptional(hooksFile);
  if (hooksText === undefined) return 0;
  // Parsed before locking so a malformed hooks.json still throws without creating a lock file, and so
  // the common "nothing to trust" call leaves the Codex directory exactly as it found it.
  if (!herdrTrustCandidates(hooksFile, hooksText, platform).length) return 0;

  const configFile = path.join(path.dirname(hooksFile), 'config.toml');
  // Reread, missing-entry calculation, backup and publication are ONE exclusive section. Everything
  // above is recomputed inside it, because another repair may have completed in the meantime.
  return withConfigLock(configFile, () => {
    const currentHooks = readOptional(hooksFile);
    if (currentHooks === undefined) return 0;
    const candidates = herdrTrustCandidates(hooksFile, currentHooks, platform);
    if (!candidates.length) return 0;
    const original = readOptional(configFile);
    const config = original ?? '';
    // Load only when there is a hook to trust; the standalone binary installer has no TOML work.
    // smol-toml's CJS runtime is also used by codex.ts; its declarations are ESM.
    const { parse: parseToml } = require('smol-toml') as { parse(text: string): Record<string, any> };
    const states = parseToml(config).hooks?.state ?? {};
    const missing = candidates.filter(({ key }) => !Object.prototype.hasOwnProperty.call(states, key));
    if (!missing.length) return 0;
    const eol = config.includes('\r\n') ? '\r\n' : '\n';
    const addition = eol + missing.map(({ key, hash }) =>
      `[hooks.state.${JSON.stringify(key).replace(/\u007f/g, '\\u007f')}]${eol}trusted_hash = "${hash}"${eol}`
    ).join(eol);
    // Validate without reserializing: comments, whitespace and every existing byte stay untouched.
    const candidate = config + addition;
    parseToml(candidate);
    if (original !== undefined) {
      const backup = `${configFile}.oak-hook-trust-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.bak`;
      fs.copyFileSync(configFile, backup, fs.constants.COPYFILE_EXCL);
    }
    // The refusal now covers the whole window, backup included: a writer obeying no lock still never
    // gets bytes appended after its change. Publication is one rename, so no reader sees a half file.
    if (readOptional(configFile) !== original || readOptional(hooksFile) !== currentHooks) {
      throw new Error('Codex configuration changed while preparing herdr hook trust; retry the install');
    }
    let mode = 0o600;
    try { if (original !== undefined) mode = fs.statSync(configFile).mode & 0o777; } catch { /* keep it private */ }
    const tmp = `${configFile}.oak-trust-publish-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, candidate, { encoding: 'utf8', mode, flag: 'wx' });
      fs.renameSync(tmp, configFile);
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch { /* already renamed */ }
    }
    return missing.length;
  });
}
