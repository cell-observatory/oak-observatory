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
 *      (A bare name backed by a real `.exe` — `where`, `unzip`, `powershell` — resolves fine without
 *      us. Those callers should pass `direct`; see the ENOENT note below. `bash` resolves too, but to the
 *      WSL launcher whenever WSL is on: run `bashPath()` instead.)
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
 * Windows also gives a console program started by a process with no console of its own a console window
 * of its own, for as long as it runs. VS Code's extension host has no console, nor does a detached
 * refresh or the herdr server OAK starts, and each child of theirs (herdr, ssh, node, cmd.exe for a
 * `.cmd` shim) flashed one on the desktop. So every launch here passes `windowsHide`, which Node ignores
 * elsewhere, unless its caller names it. The flag also starts a GUI program's window hidden, so a launch
 * of one (an editor, the file manager) passes `windowsHide: false`.
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
import * as path from 'path';
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

export interface BashLookup {
  /** Injected so the win32 lookup is unit-testable from macOS/Linux. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
}

const isFile = (file: string): boolean => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** The first `name` (with its extension, e.g. `git.exe`) in a Windows PATH, or null. */
export function winOnPath(name: string, opts: BashLookup = {}): string | null {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? isFile;
  for (const dir of String(env.PATH ?? env.Path ?? '').split(';')) {
    const d = dir.trim().replace(/^"(.*)"$/, '$1');
    if (d && exists(path.win32.join(d, name))) return path.win32.join(d, name);
  }
  return null;
}

/** `%SystemRoot%\System32\bash.exe`, the WSL launcher. With WSL on, System32 comes first on Windows' PATH, so a bare
 *  `bash` is this one, and it runs Linux, which read the Windows path of the script it was handed with the backslashes
 *  gone (`C:Users…install-statusline.sh: No such file or directory`). */
export function isWslLauncher(file: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const norm = (p: string) => path.win32.normalize(p).toLowerCase();
  return norm(file) === norm(path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'bash.exe'));
}

/** What to tell someone on Windows with no Git Bash. */
export const GIT_BASH_FIX = 'Install Git for Windows (winget install Git.Git), or set CLAUDE_CODE_GIT_BASH_PATH to its bin\\bash.exe';

/** `node -e` source that starts argv[1] with the rest of argv, `windowsHide` and not detached (on Windows a console
 *  with no window, which the child's own children share), feeds it this process's stdin and ends when it does. A
 *  detached node running it keeps a console program's tree windowless and still outlives its caller (see
 *  monthRefreshSpawn). */
export const HIDDEN_CONSOLE_LAUNCHER =
  "const c=require('child_process').spawn(process.argv[1],process.argv.slice(2),{stdio:['pipe','ignore','ignore'],windowsHide:true});" +
  "c.on('error',()=>{});c.stdin.on('error',()=>{});process.stdin.pipe(c.stdin);";

/**
 * The bash OAK runs its bash scripts with: `bash` off Windows. On Windows, Git Bash, found the way Claude Code finds
 * the bash it runs hooks and the status line with: CLAUDE_CODE_GIT_BASH_PATH when it names a bash or sh, Git for
 * Windows' default folders, then `..\..\bin\bash.exe` from the first `git.exe` on PATH (Git puts only its `cmd`
 * folder there). Never the WSL launcher; null when there is no Git Bash.
 */
export function bashPath(opts: BashLookup = {}): string | null {
  if ((opts.platform ?? process.platform) !== 'win32') return 'bash';
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? isFile;
  const w = path.win32;
  const set = env.CLAUDE_CODE_GIT_BASH_PATH;
  const git = winOnPath('git.exe', { env, exists });
  const candidates = [
    set && ['bash.exe', 'sh.exe', 'bash', 'sh'].includes(w.basename(set).toLowerCase()) ? set : null,
    w.join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    w.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    git ? w.join(git, '..', '..', 'bin', 'bash.exe') : null,
  ];
  return candidates.find((p): p is string => !!p && exists(p) && !isWslLauncher(p, env)) ?? null;
}

/** OAK_NO_BACKGROUND=1 turns off every fire-and-forget child OAK starts on its own (the account pull, the
 *  title, tab and month refreshes, the update check, the change-map warm-up and the terminal app's focus
 *  server). Each outlives the process that started it, so under a test harness it kept writing into a
 *  temporary HOME the harness was removing. The test bootstrap sets it; nothing else does. */
export function noBackgroundChildren(): boolean {
  return process.env.OAK_NO_BACKGROUND === '1';
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
  return cp.spawn(s.file, s.args, { windowsHide: true, ...o, ...(home && fs.existsSync(home) ? { cwd: home } : {}), shell: s.shell });
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
  return cp.spawnSync(s.file, s.args, { windowsHide: true, ...o, shell: s.shell });
}

/** The detached children of execFileTool still running: each leads a process group of its own. */
const detachedGroups = new Set<number>();

/** Stop each detached child of execFileTool still running, with its whole process group (SIGTERM), except
 *  one started with `keepOnExit`. Such a child runs apart from the terminal, so ctrl+c or a hangup reaches
 *  only the process that started it, and a saved machine's herdr command ran on once that process had ended:
 *  `oak prompt` delivered its prompt after ctrl+c. The CLI calls this before it ends by a signal, and the
 *  terminal app on every way out, which leaves the reply it is sending (`keepOnExit`) to finish. Core never
 *  calls it, at exit or otherwise: VS Code runs core inside its extension host, where closing a window must
 *  not stop a prompt still being sent. */
export function stopDetachedChildren(): void {
  const groups = [...detachedGroups];
  if (!groups.length) return;
  for (const pid of groups) {
    try { process.kill(-pid, 'SIGTERM'); } catch { /* the group has ended */ }
  }
  // On macOS a process a group's leader starts while that signal is being delivered can miss it, and runs on once the
  // leader has ended: a herdr script's `sleep 30` outlived it on a CI run. Each group is signalled again 20 ms on, when it
  // holds every process its leader started.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  for (const pid of groups) {
    try { process.kill(-pid, 'SIGTERM'); } catch { /* the group has ended */ }
  }
}

/** String encoding only — the callback's `stdout`/`stderr` are declared as strings, so a caller must
 *  not be able to ask for buffers through the same door and get a lie.
 *
 *  `detached`, which execFile ignores, runs the child on POSIX in a session of its own, which no terminal
 *  belongs to, read the way execFile reads it. At `timeout`, or once stdout or stderr passes `maxBuffer`
 *  bytes, its output pipes are closed, as execFile closes them, and its whole process group is sent
 *  killSignal (SIGTERM unless given), then SIGKILL half a second later: everything still in that group
 *  ends by then, and the callback comes once the child itself has ended, even while a process that left
 *  the group (a daemon it started) runs on. `keepOnExit` leaves it out of stopDetachedChildren. Windows keeps
 *  execFile: there a detached child gets a console window of its own. */
export function execFileTool(
  file: string,
  args: readonly string[],
  options: Omit<cp.ExecFileOptionsWithStringEncoding, 'encoding'> & { encoding?: BufferEncoding; detached?: boolean; keepOnExit?: boolean } & LaunchOpts,
  callback: (error: cp.ExecFileException | null, stdout: string, stderr: string) => void
): cp.ChildProcess {
  const [{ detached, keepOnExit, ...o }, l] = split(options);
  const s = launchSpec(file, args, l);
  if (!detached || (l.platform ?? process.platform) === 'win32') {
    return cp.execFile(s.file, s.args, { windowsHide: true, ...o, encoding: o.encoding ?? 'utf8', shell: s.shell }, callback);
  }
  const { timeout, maxBuffer = 1024 * 1024, killSignal = 'SIGTERM', encoding = 'utf8', ...rest } = o;
  const child = cp.spawn(s.file, s.args, { windowsHide: true, ...rest, shell: s.shell, detached: true });
  const pid = child.pid;
  if (pid && !keepOnExit) detachedGroups.add(pid);
  let stdout = '', stderr = '', timedOut = false, overflow = '', ended = false;
  const bytes = { stdout: 0, stderr: 0 };
  const group = (signal: NodeJS.Signals | number): void => {
    try { if (pid) process.kill(-pid, signal); } catch { /* the group has ended */ }
  };
  const stop = (): void => {
    child.stdout?.destroy();
    child.stderr?.destroy();
    group(killSignal);
    setTimeout(() => group('SIGKILL'), 500).unref();
  };
  const timer = timeout ? setTimeout(() => { timedOut = true; stop(); }, Math.min(2147483647, timeout)) : undefined;
  const read = (stream: 'stdout' | 'stderr', text: string): void => {
    if ((bytes[stream] += Buffer.byteLength(text, encoding)) > maxBuffer && !overflow) { overflow = stream; stop(); }
  };
  child.stdout?.setEncoding(encoding).on('data', (text: string) => { stdout += text; read('stdout', text); });
  child.stderr?.setEncoding(encoding).on('data', (text: string) => { stderr += text; read('stderr', text); });
  const end = (error: cp.ExecFileException | null): void => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    callback(error, stdout, stderr);
  };
  child.on('error', end);
  child.on('close', (code, signal) => {
    if (pid) detachedGroups.delete(pid);
    if (code === 0 && !overflow) return end(null);
    const cmd = [s.file, ...s.args].join(' ');
    end(overflow ? Object.assign(new RangeError(`${overflow} maxBuffer length exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', cmd })
      : Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`), { cmd, code: code ?? undefined, killed: timedOut, signal: signal ?? undefined }));
  });
  return child;
}
