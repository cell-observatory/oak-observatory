/**
 * ONE launcher for every child process this project starts.
 *
 * Windows makes two rules that no POSIX box does, and every surface here spawns the same two kinds
 * of thing — npm-installed `.cmd` shims (`npm.cmd`, `claude-observatory.cmd`, `code.cmd`, `claude.cmd`)
 * and plain executables:
 *
 *   1. A `.cmd`/`.bat` CANNOT be launched without a shell. Node refuses outright (the CVE-2024-27980
 *      hardening) — `spawnSync` comes back with `status === null` and an EINVAL in `error`.
 *   2. A BARE name never finds one either. libuv's `path_search_walk_ext` says it plainly: "Since
 *      CreateProcess can start only .com and .exe files, only those extensions are tried." So
 *      `spawn('code', …)` is ENOENT on a machine where `code.cmd` sits right there on the PATH.
 *      (A bare name backed by a real `.exe` — `bash`, `where`, `unzip`, `powershell` — resolves fine
 *      without us. Those callers should pass `direct`; see the ENOENT note below.)
 *
 * So on win32 those spawns MUST go through `cmd.exe`. But passing an args ARRAY together with
 * `shell: true` is deprecated as DEP0190 — and worse than deprecated, it is wrong: shell
 * mode concatenates the arguments with a single space and NO quoting, so `--root C:\Users\First
 * Last\repo` arrives at the child as two arguments and the command silently does the wrong thing.
 *
 * The fix for both is the same one Node's own docs prescribe: build ONE command string, quote each
 * token ourselves, and hand it over with an EMPTY args array (empty is not deprecated — only a
 * populated array is). Shell mode is exactly `file + ' ' + args.join(' ')`, so a correctly quoted
 * string reproduces the argv a POSIX spawn would have produced, byte for byte.
 *
 * POSIX is left completely alone: bare binary, args array, no shell, no new quoting — therefore no
 * new injection surface anywhere except the one platform that demands a shell.
 *
 * WHAT THIS DOES NOT HANDLE — pass `direct` when any of it applies to your arguments:
 *   • `%VAR%` still expands INSIDE double quotes. A path holding two `%` characters gets mangled.
 *     Windows account names may contain `%`, so this is reachable in principle, unfixable in shell
 *     mode, and not worth abandoning shell mode over.
 *   • A literal `"` inside an argument is DROPPED, because cmd has no way to express one. For the
 *     realistic source of a quote — a hand-written `CLAUDE_BIN`/`CLAUDE_OBSERVATORY_BIN` that the
 *     user quoted themselves — dropping is a REPAIR: we re-quote it correctly a line later. For an
 *     argument that MEANS its quotes (a PowerShell `-Command` payload) it is corruption, so those
 *     callers pass `direct` and keep Node's own escaping.
 *   • A trailing `\` is doubled so it cannot escape our closing quote. Without that, `"C:\dir\"`
 *     swallows the closing quote and every argument after it joins the token.
 *   • ENOENT FIDELITY IS LOST. A missing binary reports `error: ENOENT, status: null` when spawned
 *     directly, but `error: undefined, status: 127` (9009 on Windows) through a shell — cmd.exe
 *     itself started just fine. Any caller that branches on `res.error` to say something useful
 *     ("could not run bash — install Git Bash") must pass `direct`, or that branch goes dead.
 *   • `!` under delayed expansion (`cmd /v:on`, or the DelayedExpansion registry value). Node passes
 *     `/d`, which only suppresses AutoRun, so reaching this needs a deliberate machine-wide setting.
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import type { Readable, Writable } from 'stream';

export interface LaunchOpts {
  /** Injected so the win32 shape is unit-testable from macOS/Linux. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /**
   * Never route through a shell, even on win32. For callers that KNOW the target is an executable
   * image AND whose arguments carry characters cmd.exe cannot round-trip (embedded double quotes).
   */
  direct?: boolean;
}

export interface LaunchSpec {
  file: string;
  /** ALWAYS empty when `shell` is true — a populated array there is what DEP0190 fires on. */
  args: string[];
  shell: boolean;
}

/** Characters cmd.exe reads as syntax — whitespace, redirection, grouping, expansion. */
const CMD_SPECIAL = /[\s"&|<>^()%!,;=]/;

/**
 * Quote one token for a cmd.exe command line. Clean tokens are left bare so the command still reads
 * like a command in an error message; anything cmd would split on or interpret gets wrapped.
 */
export function quoteForCmd(arg: string): string {
  if (arg === '') return '""';
  if (!CMD_SPECIAL.test(arg)) return arg;
  const bare = arg.replace(/"/g, '');
  // Doubling a RUN of trailing backslashes is the standard Windows rule: `C:\dir\` would otherwise
  // close as `"C:\dir\"`, where the `\` escapes our own quote and every argument after it joins the
  // token. Counted in a loop, not with `/(\\+)$/` — that regex backtracks quadratically on a long run
  // of backslashes that ISN'T at the end (js/polynomial-redos; measured 508 ms at 32k, vs 0.006 ms
  // here), and this function's input includes paths that come from the environment.
  let slashes = 0;
  while (slashes < bare.length && bare.charCodeAt(bare.length - 1 - slashes) === 0x5c) slashes++;
  return '"' + bare + '\\'.repeat(slashes) + '"';
}

/**
 * Does this target need cmd.exe on win32? Everything except a real executable image does — see rules
 * 1 and 2 above. Keeping `.exe`/`.com` direct is not just tidiness: the daily update check spawns
 * `process.execPath` DETACHED, and routing that through cmd.exe would flash a console window on the
 * user's desktop once a day.
 */
export function needsWinShell(file: string): boolean {
  return !/\.(exe|com)$/i.test(file);
}

/** How `file` + `args` must actually be handed to child_process on this platform. */
export function launchSpec(file: string, args: readonly string[] = [], opts: LaunchOpts = {}): LaunchSpec {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32' || opts.direct || !needsWinShell(file)) {
    return { file, args: [...args], shell: false };
  }
  return { file: [file, ...args].map(quoteForCmd).join(' '), args: [], shell: true };
}

/** Strip our two options off so they never reach child_process. */
function split<T extends object>(options: T & LaunchOpts): [T, LaunchOpts] {
  const { platform, direct, ...rest } = options as T & LaunchOpts;
  return [rest as T, { platform, direct }];
}

// Mirrors Node's stdio-based narrowing: an all-`pipe` stdio guarantees the three streams, and callers
// pipe stdin/stdout precisely so they can use them without a null check on every line.
export function spawnTool(
  file: string,
  args: readonly string[],
  options: cp.SpawnOptions & { stdio: ['pipe', 'pipe', 'pipe'] } & LaunchOpts
): cp.ChildProcessByStdio<Writable, Readable, Readable>;
export function spawnTool(
  file: string,
  args?: readonly string[],
  options?: cp.SpawnOptions & LaunchOpts
): cp.ChildProcess;
export function spawnTool(
  file: string,
  args: readonly string[] = [],
  options: cp.SpawnOptions & LaunchOpts = {}
): cp.ChildProcess {
  const [o, l] = split(options);
  const s = launchSpec(file, args, l);
  // A detached child outlives its caller, and Windows refuses to delete or rename a directory that is
  // any running process's cwd: started in the caller's cwd, a background refresh or a server pinned
  // the user's project folder for as long as it ran. So on Windows, unless the caller names a cwd, it
  // starts at home. POSIX does not pin a cwd, and there a detached child keeps the caller's, as before.
  const home = o.detached && o.cwd === undefined && process.platform === 'win32' ? os.homedir() : undefined;
  return cp.spawn(s.file, s.args, { ...o, ...(home && fs.existsSync(home) ? { cwd: home } : {}), shell: s.shell });
}

// Mirrors Node's own typings: an explicit string `encoding` narrows stdout/stderr to strings, so
// callers keep `.trim()` without a cast.
export function spawnToolSync(
  file: string,
  args: readonly string[],
  options: cp.SpawnSyncOptions & { encoding: BufferEncoding } & LaunchOpts
): cp.SpawnSyncReturns<string>;
export function spawnToolSync(
  file: string,
  args?: readonly string[],
  options?: cp.SpawnSyncOptions & LaunchOpts
): cp.SpawnSyncReturns<string | Buffer>;
export function spawnToolSync(
  file: string,
  args: readonly string[] = [],
  options: cp.SpawnSyncOptions & LaunchOpts = {}
): cp.SpawnSyncReturns<string | Buffer> {
  const [o, l] = split(options);
  const s = launchSpec(file, args, l);
  return cp.spawnSync(s.file, s.args, { ...o, shell: s.shell });
}

/** String encoding only — the callback's `stdout`/`stderr` are declared as strings, so a caller must
 *  not be able to ask for buffers through the same door and get a lie. */
export function execFileTool(
  file: string,
  args: readonly string[],
  options: Omit<cp.ExecFileOptionsWithStringEncoding, 'encoding'> & { encoding?: BufferEncoding } & LaunchOpts,
  callback: (error: cp.ExecFileException | null, stdout: string, stderr: string) => void
): cp.ChildProcess {
  const [o, l] = split(options);
  const s = launchSpec(file, args, l);
  return cp.execFile(s.file, s.args, { ...o, encoding: o.encoding ?? 'utf8', shell: s.shell }, callback);
}
