/**
 * herdr's presence on this machine — the SINGLE owner of "is it there, is it the pinned one, is it
 * wired up".
 *
 * herdr is a hard runtime dependency (no fallback path exists), so exactly one function decides what
 * that means and every entry point — `oak doctor --fix`, `oak update`, `install.sh`, `install.ps1` —
 * calls it rather than reimplementing half of it. The pin lives in `herdr.lock` at the repo root
 * (version + per-platform asset URL + sha256, copied from herdr's own `latest.json`), so the version
 * a build installs is a file a reviewer can read, not a string buried in an installer.
 *
 * THE RULES, in order:
 *   1. A herdr NEWER than the pin is never touched. Downgrading someone's working install to satisfy
 *      our lockfile is the one failure mode that would make this function worse than nothing — they
 *      use herdr standalone too.
 *   2. Bytes are verified BEFORE they are made executable, and the verification reads what LANDED on
 *      disk rather than the buffer we were handed, so a truncated write fails the same way a
 *      tampered download does. A mismatch deletes the temp file and throws; nothing is installed.
 *   3. Everything after the binary is IDEMPOTENT and says so out loud: integrations are installed
 *      only when `herdr integration status` does not already say "current", the plugin link is a
 *      no-op re-registration, and the server is started only when `herdr status` says "not running".
 *
 * Every process call and the download go through injected functions (`run`, `download`,
 * `spawnDetached`), which is what lets the tests drive the whole thing against a FAKE herdr — a
 * shell script that answers `--version`/`status`/`integration status` and records its argv — with no
 * network, no `~/.local/bin`, and no chance of touching the developer's real herdr state.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnTool, spawnToolSync } from './spawn';
import { compareVersions } from './semver';
import { HERDR_LOCK } from './herdr-lock';
import { trustHerdrCodexHook } from './codex-hook-trust';
// smol-toml's CJS runtime is also used by codex.ts; its declarations are ESM.
const { parse: parseToml } = require('smol-toml') as { parse(text: string): Record<string, any> };

export { HERDR_LOCK };

/** `herdr.lock` — the pin. Parsed shape, not a schema: unknown keys are ignored on purpose so a
 *  future field (a mirror, a signature) does not break an older CLI reading a newer lockfile. */
export interface HerdrLock {
  version: string;
  /** herdr's socket protocol generation, for the adapter's compatibility gate. */
  protocol: number;
  assets: Record<string, string>;
  sha256: Record<string, string>;
}

/** The five platforms herdr publishes an asset for — the keys in `herdr.lock`. */
export type HerdrPlatformKey =
  | 'linux-x86_64'
  | 'linux-aarch64'
  | 'macos-x86_64'
  | 'macos-aarch64'
  | 'windows-x86_64';

export interface HerdrRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** One synchronous command run. Injected by the tests; the default is `spawnToolSync`. */
export type HerdrRun = (file: string, args: string[]) => HerdrRunResult;

export interface EnsureHerdrOptions {
  /** The pin. Defaults to the build-time `HERDR_LOCK` constant. */
  lock?: HerdrLock;
  /** Home directory to install into (`<home>/.local/bin`). Defaults to `os.homedir()`. */
  home?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Environment for the child processes AND for the PATH search. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  run?: HerdrRun;
  download?: (url: string) => Promise<Buffer>;
  /** Detached server launch; injected only by tests that must not leave a process behind. */
  spawnDetached?: (file: string, args: string[], logFile: string, env: NodeJS.ProcessEnv) => void;
  /** What decides whether the server must leave this login's scope (see [planHerdrServerLaunch]).
   *  Defaults to probing this host; tests inject it. */
  loginSession?: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => LoginSessionFacts;
  /** Absolute path of OAK's herdr plugin. Defaults to the one shipped beside the lockfile. */
  pluginDir?: string | null;
  /** herdr's config dir. Defaults to `$XDG_CONFIG_HOME/herdr` or `<home>/.config/herdr`. */
  configDir?: string;
  /** Agent integrations to install. Defaults to claude + codex (the two OAK captures). */
  integrations?: string[];
  /** False = report the server's state without starting one (the read-only `oak doctor`). */
  startServer?: boolean;
}

/** What one integration target ended up as. `absent` = that agent is not installed on this machine,
 *  which is not a failure of anything; `unknown` = `integration status` did not list the target. */
export type HerdrIntegrationState = 'current' | 'installed' | 'absent' | 'failed' | 'unknown';

export interface HerdrReport {
  /** herdr is present and usable now — already there, or installed by this call. */
  installed: boolean;
  /** What `herdr --version` says afterwards. */
  version: string | null;
  /** True when this call downloaded and installed the pinned binary. */
  upgraded: boolean;
  /** The verified release asset fetched by this call; absent when the existing binary was kept. */
  downloaded?: { url: string; bytes: number };
  integrations: Record<string, HerdrIntegrationState>;
  pluginLinked: boolean;
  /** python3 is on PATH. herdr's agent hooks are `sh` but parse JSON with python3 — without it they
   *  `exit 0` silently and the pane↔session join never happens. Not checked on Windows (false there),
   *  where the hooks are PowerShell. */
  python3: boolean;
  /** True when this call started the server (false when one was already running). */
  serverStarted: boolean;
  /** True when this call wrote OAK's sidebar widths into herdr's config (see [ensureHerdrSidebarConfig]). */
  sidebarConfigured: boolean;
  /** True when this call set gruvbox because no theme name was chosen. */
  themeConfigured: boolean;
  warnings: string[];
  bin: string | null;
  pinned: string;
}

/** herdr's release asset key for a platform/arch pair, or null when herdr publishes none. */
export function herdrPlatformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): HerdrPlatformKey | null {
  const cpu = arch === 'x64' || arch === 'x86_64' || arch === 'amd64' ? 'x86_64' : arch === 'arm64' || arch === 'aarch64' ? 'aarch64' : null;
  if (!cpu) return null;
  if (platform === 'linux') return cpu === 'x86_64' ? 'linux-x86_64' : 'linux-aarch64';
  if (platform === 'darwin') return cpu === 'x86_64' ? 'macos-x86_64' : 'macos-aarch64';
  // herdr ships no windows-aarch64 release asset (the arm64 workflow exists, the asset does not).
  if (platform === 'win32') return cpu === 'x86_64' ? 'windows-x86_64' : null;
  return null;
}

/** The same mapping from a REMOTE machine's `uname -s` / `uname -m`, for `oak machine add`. */
export function herdrPlatformKeyFromUname(sysname: string, machine: string): HerdrPlatformKey | null {
  const s = sysname.trim().toLowerCase();
  const platform = s === 'linux' ? 'linux' : s === 'darwin' ? 'darwin' : null;
  if (!platform) return null;
  return herdrPlatformKey(platform as NodeJS.Platform, machine.trim().toLowerCase());
}

/**
 * Return the build-time pin. Passing `startDir` explicitly is the development override: find an
 * on-disk `herdr.lock` upward from that directory. Production readers omit it, so a packaged CLI
 * never depends on repository files existing beside its bundle.
 */
export function readHerdrLock(startDir?: string): HerdrLock {
  if (startDir === undefined) return HERDR_LOCK;
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, 'herdr.lock');
    if (fs.existsSync(candidate)) {
      const lock = JSON.parse(fs.readFileSync(candidate, 'utf8')) as HerdrLock;
      if (!lock || typeof lock.version !== 'string' || !lock.assets || !lock.sha256) {
        throw new Error(`${candidate} is not a usable herdr.lock (needs version, assets, sha256)`);
      }
      return lock;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`herdr.lock not found (searched upward from ${startDir}) — this install is incomplete`);
}

/**
 * OAK's own herdr plugin: `packages/herdr-plugin` in the tree, or the copy the CLI build stages
 * beside its bundle in a published install. Null when neither exists (a partial install — reported,
 * never silently skipped).
 *
 * SOURCE DIRECTORY FIRST, across every ancestor, before the staged copy. `herdr plugin link` records
 * the path it is given, and `npm run clean` removes every package's dist — linking the staged copy
 * would leave a developer's herdr registry pointing at a directory the next clean removes.
 */
export function herdrPluginDir(startDir: string = __dirname): string | null {
  const has = (dir: string): boolean => fs.existsSync(path.join(dir, 'herdr-plugin.toml'));
  for (const rel of [path.join('packages', 'herdr-plugin'), 'herdr-plugin']) {
    let dir = path.resolve(startDir);
    for (;;) {
      const candidate = path.join(dir, rel);
      if (has(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

function defaultRun(env: NodeJS.ProcessEnv): HerdrRun {
  return (file, args) => {
    const r = spawnToolSync(file, args, { encoding: 'utf8', env, maxBuffer: 4 * 1024 * 1024 });
    return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
  };
}

/** GET with redirects, into memory. Mirrors the CLI's release downloader — same 15 s timeout, same
 *  redirect budget — because the asset URL is a github.com link that redirects to a CDN. */
export function httpGetBuffer(url: string, redirects = 5): Promise<Buffer> {
  const mod = url.startsWith('http://') ? require('http') : require('https');
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const complete = (bytes: Buffer | Promise<Buffer>) => {
      if (settled) return;
      settled = true;
      resolve(bytes);
    };
    const req = mod.get(url, { headers: { 'User-Agent': 'oak-observatory' } }, (res: any) => {
      let ended = false;
      res.once('error', fail);
      res.once('aborted', () => fail(new Error(`Response aborted for ${url}`)));
      res.once('end', () => { ended = true; });
      res.once('close', () => { if (!ended) fail(new Error(`Response closed before completion for ${url}`)); });
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location && redirects > 0) {
        res.resume();
        complete(httpGetBuffer(headers.location, redirects - 1));
        return;
      }
      if (statusCode !== 200) {
        res.resume();
        fail(new Error(`HTTP ${statusCode} for ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => complete(Buffer.concat(chunks)));
    });
    req.on('error', fail);
    req.setTimeout(15000, () => req.destroy(new Error('request timed out')));
  });
}

/**
 * Download one pinned asset into `destFile`, verified against the lockfile's sha256.
 *
 * The digest is computed from the file that LANDED, not from the buffer, so a short write fails here
 * instead of at first run. A mismatch deletes the file and throws — the caller never gets a path to
 * something unverified, which is the whole contract of this function.
 */
export async function downloadHerdrAsset(
  key: HerdrPlatformKey,
  destFile: string,
  opts: { lock?: HerdrLock; download?: (url: string) => Promise<Buffer> } = {}
): Promise<void> {
  const lock = opts.lock ?? HERDR_LOCK;
  const url = lock.assets?.[key];
  const expected = lock.sha256?.[key];
  if (!url || !expected) throw new Error(`herdr.lock has no ${key} asset — cannot install herdr here`);
  const bytes = await (opts.download ?? httpGetBuffer)(url);
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  fs.writeFileSync(destFile, bytes, { mode: 0o600 });
  const actual = crypto.createHash('sha256').update(fs.readFileSync(destFile)).digest('hex');
  if (actual !== expected) {
    try {
      fs.unlinkSync(destFile);
    } catch {
      /* the throw below is the report that matters */
    }
    throw new Error(`herdr ${lock.version} (${key}) FAILED its checksum: sha256 ${actual} ≠ ${expected} — refusing to install`);
  }
}

/** Every directory on PATH, from the env we were given (never `process.env` behind the caller's
 *  back — the tests point PATH at a directory holding the fake herdr). */
function pathDirs(env: NodeJS.ProcessEnv): string[] {
  return String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
}

function executable(p: string, platform: NodeJS.Platform): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (platform === 'win32') return true; // no x bit; the extension is the contract
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where WE install herdr: `~/.local/bin/herdr` — herdr's own remote-install and shell discovery
 *  look there, so a user can drive `herdr` standalone with no extra PATH entry. On Windows the
 *  release is a zip whose DLLs must sit beside the exe, so the exe lands one level deeper. */
export function herdrInstallPath(home: string, platform: NodeJS.Platform): string {
  const bin = path.join(home, '.local', 'bin');
  return platform === 'win32' ? path.join(bin, 'herdr', 'herdr.exe') : path.join(bin, 'herdr');
}

/** The herdr binary this machine would run: PATH first (that is what the user's shell and herdr's own
 *  hooks resolve), then our install location. Null when there is none. */
export function findHerdrBin(opts: { home?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const name = platform === 'win32' ? 'herdr.exe' : 'herdr';
  for (const dir of pathDirs(env)) {
    const p = path.join(dir, name);
    if (executable(p, platform)) return p;
  }
  const mine = herdrInstallPath(home, platform);
  return executable(mine, platform) ? mine : null;
}

/** `herdr 0.9.1` → `0.9.1`. Null when the binary did not answer (missing, or not herdr at all). */
export function parseHerdrVersion(out: string): string | null {
  const m = /herdr\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)/i.exec(out);
  return m ? m[1] : null;
}

export interface HerdrProbe {
  bin: string | null;
  version: string | null;
  /** version >= the pin: nothing to install. */
  current: boolean;
}

/** Read-only "what is here?" — no install, no server, no writes. `oak doctor` without `--fix` and
 *  any surface that wants to refuse loudly calls this. */
export function probeHerdr(opts: { lock?: HerdrLock; home?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; run?: HerdrRun } = {}): HerdrProbe {
  const lock = opts.lock ?? HERDR_LOCK;
  const env = opts.env ?? process.env;
  const run = opts.run ?? defaultRun(env);
  const bin = findHerdrBin(opts);
  if (!bin) return { bin: null, version: null, current: false };
  const version = parseHerdrVersion(run(bin, ['--version']).stdout);
  return { bin, version, current: version !== null && compareVersions(version, lock.version) >= 0 };
}

/** `herdr integration status` prints one line per target: `claude: current (v10) (<path>)`, or
 *  `not installed` / `outdated (v9 < v10)` / `needs repair (v10)`. Only "current" means leave alone. */
function integrationStates(out: string): Record<string, string> {
  const states: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    // Split on the FIRST colon, by index rather than a pattern: the state carries an absolute path,
    // which on Windows starts `C:\`, and the label itself can carry a qualifier (`letta
    // (experimental)`), so the target is the first word before that colon.
    const target = line.slice(0, at).trim().split(/\s+/)[0];
    states[target] = line.slice(at + 1).trim();
  }
  return states;
}

/** The unix default. Windows has no XDG convention, but herdr reads the same variable there. */
/**
 * Where THIS platform's herdr keeps its config dir — the same resolution as herdr's own
 * (`src/config/io.rs`): `$XDG_CONFIG_HOME/herdr` when set; on Windows `%APPDATA%\\herdr` (falling back to
 * `%USERPROFILE%\\AppData\\Roaming`); else `~/.config/herdr`. Writing `~/.config/herdr` on Windows put the
 * sidebar widths in a file herdr never reads while the report said they were set.
 */
export function herdrConfigDir(home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (env.XDG_CONFIG_HOME) return p.join(env.XDG_CONFIG_HOME, 'herdr');
  if (platform === 'win32') {
    const roaming = env.APPDATA || (env.USERPROFILE ? p.join(env.USERPROFILE, 'AppData', 'Roaming') : p.join(home, 'AppData', 'Roaming'));
    return p.join(roaming, 'herdr');
  }
  return p.join(home, '.config', 'herdr');
}

/** Install the downloaded asset at `dest`, atomically and executable. POSIX only — Windows takes the
 *  zip path below. */
function installBinary(bytesFile: string, dest: string): void {
  fs.chmodSync(bytesFile, 0o755);
  fs.renameSync(bytesFile, dest);
}

/**
 * Make herdr present, current and wired up. Returns the report; throws only when something is
 * genuinely unrecoverable (no asset for this platform, a failed checksum). Everything else — a
 * missing python3, an integration that would not install, no plugin to link — comes back as a
 * warning, because a half-wired herdr is still a herdr and the caller has to be able to say which
 * half.
 */
export async function ensureHerdr(opts: EnsureHerdrOptions = {}): Promise<HerdrReport> {
  const lock = opts.lock ?? HERDR_LOCK;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const run = opts.run ?? defaultRun(env);
  const configDir = opts.configDir ?? herdrConfigDir(home, env, platform);
  const report: HerdrReport = {
    installed: false,
    version: null,
    upgraded: false,
    integrations: {},
    pluginLinked: false,
    python3: false,
    serverStarted: false,
    sidebarConfigured: false,
    themeConfigured: false,
    warnings: [],
    bin: null,
    pinned: lock.version,
  };

  // --- the binary -------------------------------------------------------------------------------
  let bin = findHerdrBin({ home, platform, env });
  let version = bin ? parseHerdrVersion(run(bin, ['--version']).stdout) : null;
  if (bin && !version) {
    report.warnings.push(`\`${bin} --version\` did not answer like herdr — reinstalling the pinned build`);
    bin = null;
  }
  // An older herdr earlier on PATH can shadow the pinned copy we installed before. Downloading it
  // again changes nothing PATH resolves (it used to cost 26 MB on every run), so use our copy and
  // say what shadows it, exactly as after a fresh install.
  const mine = herdrInstallPath(home, platform);
  if (bin && path.resolve(bin) !== path.resolve(mine) && compareVersions(version ?? '0.0.0', lock.version) < 0 && executable(mine, platform)) {
    const mineVersion = parseHerdrVersion(run(mine, ['--version']).stdout);
    if (mineVersion && compareVersions(mineVersion, lock.version) >= 0) {
      report.warnings.push(`${bin} comes first on PATH and shadows the pinned herdr at ${mine} — remove it, or put ${path.dirname(mine)} earlier on PATH`);
      bin = mine;
      version = mineVersion;
    }
  }
  // RULE 1: a newer herdr is theirs, not ours. Only older-or-absent installs.
  if (!bin || compareVersions(version ?? '0.0.0', lock.version) < 0) {
    const key = herdrPlatformKey(platform, arch);
    if (!key) throw new Error(`herdr publishes no release for ${platform}/${arch} — install it yourself and put it on PATH`);
    const dest = herdrInstallPath(home, platform);
    const tmp = `${dest}.download-${process.pid}${platform === 'win32' ? '.zip' : ''}`;
    await downloadHerdrAsset(key, tmp, { lock, download: opts.download });
    report.downloaded = { url: lock.assets[key], bytes: fs.statSync(tmp).size };
    if (platform === 'win32') {
      // BEST EFFORT, and untested on Windows by this change: the release is a zip whose ConPTY DLLs
      // must stay beside herdr.exe, so the whole archive is expanded into `~/.local/bin/herdr/` and
      // that directory — not the parent — is what has to be on PATH. Same Expand-Archive call the
      // CLI's JetBrains installer uses, with both paths travelling by environment so a quote or a `$`
      // in a Windows user name cannot rewrite the command.
      const dir = path.dirname(dest);
      fs.mkdirSync(dir, { recursive: true });
      const r = spawnToolSync(
        'powershell.exe',
        ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:OAK_ZIP -DestinationPath $env:OAK_DEST -Force'],
        { stdio: 'pipe', encoding: 'utf8', direct: true, env: { ...env, OAK_ZIP: tmp, OAK_DEST: dir } }
      );
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* the zip is scratch; a leftover is not worth failing the install over */
      }
      if (r.status !== 0) {
        const detail = String(r.stderr || r.error?.message || '').trim();
        throw new Error(`could not expand the herdr archive into ${dir} (Expand-Archive exited ${r.status ?? '?'})${detail ? `: ${detail}` : ''}`);
      }
      report.warnings.push(`add ${dir} to PATH so \`herdr\` resolves in your shell`);
    } else {
      installBinary(tmp, dest);
      if (!pathDirs(env).some(dir => path.resolve(dir) === path.resolve(path.dirname(dest)))) {
        report.warnings.push(`add ${path.dirname(dest)} to PATH so \`herdr\` resolves in your shell`);
      }
    }
    bin = dest;
    version = parseHerdrVersion(run(bin, ['--version']).stdout);
    report.upgraded = true;
    // We install where herdr's own tooling looks (`~/.local/bin/herdr`), which is NOT necessarily
    // where this shell resolves `herdr`: an older copy in /usr/local/bin or a package manager's dir
    // keeps winning PATH, and every verb — including herdr's hooks — would still run that one. Say
    // so; removing someone else's managed install is not ours to do.
    const resolved = findHerdrBin({ home, platform, env });
    if (resolved && path.resolve(resolved) !== path.resolve(dest)) {
      report.warnings.push(`${resolved} comes first on PATH and shadows the pinned herdr at ${dest} — remove it, or put ${path.dirname(dest)} earlier on PATH`);
    }
  }
  report.bin = bin;
  report.version = version;
  report.installed = Boolean(bin && version);
  if (!report.installed) {
    report.warnings.push(`installed herdr at ${bin} but it did not report a version`);
    return report;
  }

  // --- integrations (claude + codex) -------------------------------------------------------------
  // `integration status` first, ALWAYS: re-running `integration install` rewrites the agent's
  // settings file and bumps its backups every single time `oak doctor --fix` runs, which is how an
  // idempotent installer turns into a settings-file churn machine.
  const wanted = opts.integrations ?? ['claude', 'codex'];
  const states = integrationStates(run(bin, ['integration', 'status']).stdout);
  for (const target of wanted) {
    const state = states[target];
    if (state === undefined) {
      report.integrations[target] = 'unknown';
      report.warnings.push(`herdr does not know an integration target called “${target}”`);
      continue;
    }
    if (/^current\b/.test(state)) {
      report.integrations[target] = 'current';
      continue;
    }
    const r = run(bin, ['integration', 'install', target]);
    if (r.status === 0) {
      report.integrations[target] = 'installed';
      continue;
    }
    const said = (r.stderr || r.stdout).split('\n').find(Boolean) ?? '';
    // herdr's uniform refusal when the agent itself is not on this machine (its
    // `src/integration/targets.rs`: "<agent> … directory not found at <path>. install <agent>
    // first"). Not having codex installed is not a failure of anything, and a warning that fires on
    // every `oak doctor --fix` of a perfectly healthy machine is how people learn to stop reading
    // warnings.
    if (/ directory not found at .*\. install /i.test(said)) {
      report.integrations[target] = 'absent';
      continue;
    }
    report.integrations[target] = 'failed';
    report.warnings.push(`\`herdr integration install ${target}\` failed: ${said || `exit ${r.status ?? '?'}`}`);
  }

  // Also repair trust for an integration installed before OAK learned Codex's per-hook trust format.
  if (report.integrations.codex === 'installed' || report.integrations.codex === 'current') {
    try {
      trustHerdrCodexHook(env.CODEX_HOME?.trim() ? env.CODEX_HOME : path.join(home, '.codex'), platform);
    } catch (error) {
      report.warnings.push(`could not trust herdr's Codex hook: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // --- OAK's plugin ------------------------------------------------------------------------------
  // `plugin link` registers a LOCAL directory and works with no server running, which is why the
  // installer can do it before anything is up. The path must be absolute: herdr stores what it is
  // given, and a relative one would resolve against whatever directory a later client started in.
  const pluginDir = opts.pluginDir === undefined ? herdrPluginDir() : opts.pluginDir;
  if (pluginDir) {
    const abs = path.resolve(pluginDir);
    // Already registered FROM THIS DIRECTORY? Then leave it: re-linking rewrites an identical
    // registry entry on every run, and it would also re-enable a plugin the user disabled on
    // purpose. Matched on the absolute path rather than the plugin id, so a moved checkout — same
    // id, different root — still re-links.
    if (run(bin, ['plugin', 'list']).stdout.includes(abs)) {
      report.pluginLinked = true;
    } else {
      const r = run(bin, ['plugin', 'link', abs]);
      report.pluginLinked = r.status === 0;
      if (r.status !== 0) {
        report.warnings.push(`\`herdr plugin link\` failed: ${(r.stderr || r.stdout).split('\n')[0] || `exit ${r.status ?? '?'}`}`);
      }
    }
  } else if (opts.pluginDir !== null) {
    report.warnings.push('OAK’s herdr plugin was not found next to this install — “Open in OAK” will not appear in herdr');
  }

  // --- python3 -----------------------------------------------------------------------------------
  // herdr's agent hooks are POSIX sh but parse the hook JSON with python3. Without it they exit 0
  // silently: no error, no join, no explanation. A loud warning here is the only place a user finds
  // out before wondering why the observatory never links a session to a pane. Windows is exempt:
  // herdr's hooks there are PowerShell, and the pinned herdr.exe carries no python at all.
  if (platform !== 'win32') {
    report.python3 = run('python3', ['--version']).status === 0;
    if (!report.python3) {
      report.warnings.push('python3 is not on PATH — herdr’s agent hooks exit silently without it, so sessions never join their pane');
    }
  }

  // --- the server --------------------------------------------------------------------------------
  // CLI verbs do NOT auto-start a server (only the interactive client does), so the observatory would
  // find nothing until the user opened herdr by hand.
  const statusRun = run(bin, ['status']);
  const status = statusRun.stdout;
  // A failing `status` (a socket path longer than the OS allows, say) tells us nothing about the
  // server. It used to read as "running": no server started, and no word about why.
  const statusKnown = statusRun.status === 0;
  if (!statusKnown) {
    const said = (statusRun.stderr || statusRun.stdout).split('\n').find((l) => l.trim()) ?? `exit ${statusRun.status ?? '?'}`;
    report.warnings.push(`\`herdr status\` failed, so OAK could not tell whether its server runs and started none: ${said}`);
  }
  const running = statusKnown && !/status:\s*not running/.test(status);
  // An upgrade does not touch the server that is ALREADY running: it keeps executing the binary it
  // started with, which after a pin bump is the wrong protocol. herdr says so in its own status
  // block, and this is the one place a person would ever see it.
  if (running && /server_binary_stale:\s*yes/.test(status)) {
    report.warnings.push(`the running herdr server is still the old binary — \`herdr server stop\`, then reopen herdr`);
  }

  // --- the sidebar and theme ----------------------------------------------------------------------
  // OAK names herdr's tabs after the sessions they run, and herdr's default 36-column ceiling clips
  // exactly those names. Written once, only where nobody set a width, and checked by herdr's own
  // parser before it is kept: a config the client refuses to load would cost the whole terminal.
  // The theme follows the same rule: a user's choice wins. Both defaults share one validation,
  // backup of the original file, and reload; a rejected edit restores both together.
  // `HERDR_CONFIG_PATH` overrides herdr's config file on every platform (its --help says so).
  const configFile = env.HERDR_CONFIG_PATH?.trim() || path.join(configDir, 'config.toml');
  try {
    const before = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : null;
    const sidebar = sidebarWidthsAbsent(before ?? '');
    const theme = themeNameAbsent(before ?? '');
    const defaults = [sidebar ? 'sidebar widths' : '', theme ? 'gruvbox theme' : ''].filter(Boolean).join(' and ');
    const check = (): { ok: boolean; said: string } => {
      const r = run(bin, ['config', 'check']);
      return { ok: r.status === 0 && /config:\s*ok/.test(r.stdout), said: (r.stderr || r.stdout).split('\n').find((l) => /\S/.test(l) && !/config:\s*ok/.test(l)) ?? '' };
    };
    const precheck = before !== null && defaults ? check() : { ok: true, said: '' };
    if (!precheck.ok) {
      // herdr already refuses THIS file (a stale key of the user's, say). Editing it would rewrite,
      // check, restore and blame the widths on every run — and never widen anything.
      report.warnings.push(`herdr rejects ${configFile} as it is${precheck.said ? ` (${precheck.said})` : ''} — fix that first; the ${defaults} were not added`);
    } else if (defaults) {
      const sidebarSet = ensureHerdrSidebarConfig(configFile) === 'set';
      const themeSet = ensureHerdrThemeConfig(configFile) === 'set';
      const after = check();
      if (after.ok) {
        // The pre-touch copy is written only once the edit is known good: a rejected edit is restored
        // from memory and leaves no litter behind.
        if (before !== null) fs.writeFileSync(`${configFile}.bak-oak-${Date.now()}`, before, { mode: fs.statSync(configFile).mode & 0o777 });
        report.sidebarConfigured = sidebarSet;
        report.themeConfigured = themeSet;
        if (running) run(bin, ['server', 'reload-config']);
      } else {
        if (before === null) fs.unlinkSync(configFile);
        else fs.writeFileSync(configFile, before);
        report.warnings.push(`herdr rejected the ${defaults} OAK added to ${configFile}${after.said ? ` (${after.said})` : ''} — restored it; set ${[sidebar ? 'ui.sidebar_min_width and ui.sidebar_max_width' : '', theme ? 'theme.name' : ''].filter(Boolean).join(' and ')} yourself`);
      }
    }
  } catch (error) {
    report.warnings.push(`could not set herdr's sidebar widths or theme: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!running && statusKnown && opts.startServer !== false) {
    // mkdir FIRST. The log redirect below opens a file inside this directory, and on a machine that
    // has never run herdr the directory does not exist yet — the redirect then fails and the server
    // start looks like it silently did nothing.
    fs.mkdirSync(configDir, { recursive: true });
    const logFile = path.join(configDir, 'oak-herdr-server.log');
    // The SAME env every probe above ran with (so the server lands on the right config dir/socket) —
    // but STRIPPED of the starting agent's session identity. herdr is a long-lived multiplexer that
    // outlives whatever session happened to spawn it, and its panes host FRESH agents that must be
    // their own top-level sessions. If the herdr server inherits e.g. CLAUDE_CODE_CHILD_SESSION or
    // CLAUDE_CODE_SESSION_ID, every `claude` a pane starts thinks it is a child of that session —
    // transcript saving off, Remote Control refused. CLAUDE_CONFIG_DIR (config, not identity) stays.
    const serverEnv = stripSessionIdentity(env);
    // Detached is not enough on a systemd host: see [planHerdrServerLaunch].
    const launch = planHerdrServerLaunch(bin, ['server'], (opts.loginSession ?? probeLoginSession)(serverEnv, platform));
    if (launch.warning) report.warnings.push(launch.warning);
    (opts.spawnDetached ?? spawnHerdrServer)(launch.file, launch.args, logFile, serverEnv);
    report.serverStarted = true;
  }
  return report;
}

/** Start `herdr server` so it OUTLIVES this process: its own session (detached), stdio to a log
 *  under herdr's config dir. `herdr server` is a foreground process by design — nothing daemonizes
 *  it for us. */
function spawnHerdrServer(bin: string, args: string[], logFile: string, env: NodeJS.ProcessEnv): void {
  const fd = fs.openSync(logFile, 'a');
  try {
    const child = spawnTool(bin, args, { detached: true, stdio: ['ignore', fd, fd], env });
    child.unref();
  } finally {
    fs.closeSync(fd);
  }
}

/** What decides whether a server started from here outlives the login that started it. */
export interface LoginSessionFacts {
  /** This process's `/proc/self/cgroup`; null off Linux or when unreadable. */
  cgroup: string | null;
  /** logind keeps this user's service manager up with nobody logged in (`loginctl enable-linger`). */
  linger: boolean;
  /** logind's `KillUserProcesses`; null when it could not be read. */
  killUserProcesses: boolean | null;
  /** Absolute path of a `systemd-run` that just started a `--user --scope` here; null otherwise. */
  systemdRun: string | null;
}

/** Re-homes the process into a transient user scope, named `oak-herdr-server-<ms>` by the caller so
 *  `systemctl --user list-units 'oak-herdr-server-*'` finds it. */
const SCOPE_FLAGS = ['--user', '--scope', '--quiet', '--collect'];

/**
 * How to launch `herdr server` so it OUTLIVES the login that ran this, not just this process.
 *
 * `detached` (setsid) keeps the server off the terminal's SIGHUP, but on a systemd host every
 * process of an ssh login — daemonized or not — stays in that login's `session-N.scope`, and with
 * logind's `KillUserProcesses=yes` (KDE neon ships it) the whole scope is SIGTERMed the moment the
 * login ends: a laptop lid closing, a dropped connection, a client detaching. The server then takes
 * every pane and every agent down with it (measured 2026-09-23: 7 of 7 such kills in one day).
 * `systemd-run --user --scope` keeps the same pid, env, cwd and stdio but files the server under the
 * user's service manager, which no login owns.
 *
 * Only when that is the better home. Outside a login scope nothing changes. With no linger AND
 * `KillUserProcesses=no` (Ubuntu's default) nothing changes either: an abandoned login scope lives
 * on, while the user manager would stop with the last logout and take the server with it.
 */
export function planHerdrServerLaunch(bin: string, args: string[], facts: LoginSessionFacts, now: number = Date.now()): { file: string; args: string[]; warning?: string } {
  const plain = { file: bin, args };
  if (!facts.cgroup || !/\/session-[^/\s]+\.scope(?:\/|$)/m.test(facts.cgroup)) return plain;
  if (!facts.linger && facts.killUserProcesses !== true) return plain;
  if (!facts.systemdRun) {
    return facts.killUserProcesses === true
      ? { ...plain, warning: 'logind ends every process of this login when it closes (KillUserProcesses=yes) and `systemd-run --user` is not available to move herdr out of it — the herdr server and every agent in it will stop when this login ends; start it from a login that stays open, or set KillUserProcesses=no' }
      : plain;
  }
  return {
    file: facts.systemdRun,
    args: [...SCOPE_FLAGS, `--unit=oak-herdr-server-${now}`, '--', bin, ...args],
    ...(facts.linger ? {} : { warning: 'the herdr server runs under your systemd user manager, which stops when your last login closes — `loginctl enable-linger` keeps it and its agents running with nobody logged in' }),
  };
}

/** A systemd tool by absolute path. Remote OAK commands run with a narrowed PATH; systemd's tools live
 *  in the system dirs regardless. */
function systemdTool(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  return [...pathDirs(env), '/usr/bin', '/bin'].map((d) => path.join(d, name)).find((p) => executable(p, platform));
}

/** logind's `KillUserProcesses`, read over busctl; null when it cannot be read (no busctl, no logind,
 *  not Linux). */
export function probeKillUserProcesses(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean | null {
  if (platform !== 'linux') return null;
  const busctl = systemdTool('busctl', env, platform);
  const kill = busctl ? spawnToolSync(busctl, ['get-property', 'org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', 'KillUserProcesses'], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', env }) : null;
  const said = /^b (true|false)\b/.exec(String(kill?.stdout ?? '').trim());
  return said ? said[1] === 'true' : null;
}

/** The real [LoginSessionFacts] for this process. Probes only as far as the answer needs. */
export function probeLoginSession(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): LoginSessionFacts {
  const facts: LoginSessionFacts = { cgroup: null, linger: false, killUserProcesses: null, systemdRun: null };
  if (platform !== 'linux') return facts;
  try {
    facts.cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
  } catch {
    return facts;
  }
  if (!/\/session-[^/\s]+\.scope(?:\/|$)/m.test(facts.cgroup)) return facts;
  let user = env.USER || env.LOGNAME || '';
  try { user = os.userInfo().username; } catch { /* no passwd entry: keep the env's name */ }
  facts.linger = Boolean(user) && fs.existsSync(`/var/lib/systemd/linger/${user}`);
  facts.killUserProcesses = probeKillUserProcesses(env, platform);
  if (!facts.linger && facts.killUserProcesses !== true) return facts;
  // Proven by doing it, not by finding the binary: a container or a login without a user bus has
  // `systemd-run` on PATH and still cannot start a user scope.
  const found = systemdTool('systemd-run', env, platform);
  if (found && spawnToolSync(found, [...SCOPE_FLAGS, '--', 'true'], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', env }).status === 0) facts.systemdRun = found;
  return facts;
}

/**
 * The sidebar widths OAK provisions in herdr's client config. herdr 0.9.1 draws its sidebar at a
 * 36-column ceiling that no key or mouse can lift, and the rows OAK itself puts there — a
 * `machine · workspace · <session title>` agent row — clip at 32 columns (measured 2026-09-22 with a
 * headless client: `sidebar_width` changed nothing; `sidebar_min_width` is the knob that widens it).
 * Client-side: the machine whose `herdr` draws the screen reads it, so every machine gets it.
 */
const HERDR_SIDEBAR_MIN_WIDTH = 48;
const HERDR_SIDEBAR_MAX_WIDTH = 72;

/** True when the person set no sidebar width — table key or dotted key, any of the three. */
function sidebarWidthsAbsent(text: string): boolean {
  return !/^[ \t]*(?:ui\.)?sidebar_(?:min_|max_)?width[ \t]*=/m.test(text);
}

/**
 * Add OAK's sidebar widths to herdr's `config.toml` unless the person set any sidebar width
 * themselves — theirs wins, whatever it is. Append-only: the two keys go right under the existing
 * `[ui]` header, or into a new `[ui]` table at the end (TOML allows a super-table after its
 * sub-tables, and this file already holds `[ui.toast]` on a stock install). Nothing else is
 * reordered or rewritten. `kept` means it was left alone; `set` means the caller must have herdr
 * parse it before trusting it — and only then keep a backup of what was there.
 */
export function ensureHerdrSidebarConfig(file: string): 'set' | 'kept' {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    /* no config yet — herdr runs on its defaults, and the file below becomes its config */
  }
  if (!sidebarWidthsAbsent(text)) return 'kept';
  const keys = `sidebar_min_width = ${HERDR_SIDEBAR_MIN_WIDTH}\nsidebar_max_width = ${HERDR_SIDEBAR_MAX_WIDTH}\n`;
  const header = /^\[ui\][ \t]*(?:#.*)?\r?\n/m;
  const next = header.test(text)
    ? text.replace(header, (m) => m + keys)
    : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}[ui]\n${keys}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return 'set';
}

/** Parse only to detect a choice, including quoted/dotted keys; never serialize the user's TOML. */
function themeNameAbsent(text: string): boolean {
  try {
    return !Object.prototype.hasOwnProperty.call(parseToml(text).theme ?? {}, 'name');
  } catch {
    // Let herdr's pre-check report an already broken file without editing it.
    return true;
  }
}

/** Add gruvbox only when no theme name exists. Like the widths, the caller validates and backs up. */
export function ensureHerdrThemeConfig(file: string): 'set' | 'kept' {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!themeNameAbsent(text)) return 'kept';
  const key = 'name = "gruvbox"\n';
  let at = -1;
  for (const header of text.matchAll(/^[ \t]*\[[ \t]*(?:theme|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')[ \t]*\][ \t]*(?:#.*)?(?:\r?\n|$)/gm)) {
    try {
      if (!parseToml(header[0]).theme) continue; // quoted keys can spell theme with Unicode escapes
      // A header-looking line inside a multiline string leaves this prefix unparseable.
      parseToml(text.slice(0, header.index! + header[0].length));
      at = header.index! + header[0].length;
      break;
    } catch { /* keep looking for the actual table */ }
  }
  const next = at >= 0
    ? text.slice(0, at) + (text[at - 1] === '\n' ? '' : '\n') + key + text.slice(at)
    : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}[theme]\n${key}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return 'set';
}

/**
 * The variables a Claude Code session stamps on every process it starts — its identity. herdr is a
 * long-lived multiplexer that outlives whatever session happened to start it, and its panes host
 * FRESH agents that must be their own top-level sessions: a `claude` that inherits
 * `CLAUDE_CODE_CHILD_SESSION` runs as a child session — transcript saving off, no `--resume`, no
 * session record for Remote Control. So neither the server OAK starts nor the interactive client
 * OAK's herdr tab spawns (the client auto-starts a server when none runs) may carry them.
 * `CLAUDE_CONFIG_DIR` is config, not identity, and stays.
 */
export function isSessionIdentityKey(key: string): boolean {
  // The explicit set Claude Code 2.1 stamps on the processes it starts (its own child-identity and
  // "strip before spawning an editor" lists), plus the families that only ever name a session — and
  // NOT the whole `CLAUDE_CODE_` prefix: `CLAUDE_CODE_USE_BEDROCK`, `…_USE_VERTEX`, `…_GIT_BASH_PATH`,
  // `…_OAUTH_TOKEN`, `…_FORCE_SESSION_PERSISTENCE` are the person's settings and must reach the agents
  // `CLAUDE_CONFIG_DIR` is config, not identity, and stays.
  return SESSION_IDENTITY_EXACT.has(key) || /^CLAUDE_CODE_(?:SESSION|BRIDGE|MESSAGING|CHILD)_/.test(key);
}
const SESSION_IDENTITY_EXACT = new Set([
  'CLAUDECODE', 'AI_AGENT', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'TRACEPARENT',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_INVOKED_SKILLS', 'CLAUDE_CODE_PLAN_MODE_REQUIRED', 'CLAUDE_CODE_RESUME_INTERRUPTED_TURN',
  'CLAUDE_CODE_WORKER_EPOCH',
]);

/** `env` without the session identity — a copy; the input is untouched. */
export function stripSessionIdentity(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (!isSessionIdentityKey(key)) out[key] = value;
  // Claude Code's Bash tool also exports `GIT_EDITOR=true` so that nothing it runs opens an editor.
  // Carried into a herdr server it reached every pane: `git commit` there aborted on an empty message
  // and `git rebase -i` applied its todo unedited. Only that value, and
  // only when it travels with the identity — a person's own `GIT_EDITOR=vim` is theirs.
  if (out.GIT_EDITOR === 'true' && (env.CLAUDECODE || env.CLAUDE_CODE_SESSION_ID)) delete out.GIT_EDITOR;
  return out;
}

/** The identity keys `oak doctor` names when it finds them on a running server. A subset of what
 *  [isSessionIdentityKey] strips: these four are the ones that change how an agent behaves. */
const SESSION_IDENTITY_KEYS = ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'AI_AGENT'];
/** Named in a leak report only with the value Claude Code's Bash tool sets. */
const GIT_EDITOR_MARKER = 'true';

/**
 * What `oak doctor` learned about the running `herdr server`'s environment. `unknown` is its own
 * answer: "could not look" must never be printed as "nothing found" — that is how a Windows user
 * (no way to read another process's environment) would get a clean bill nobody checked.
 */
export type HerdrServerIdentity =
  | { state: 'leak'; pid: number; /** in [SESSION_IDENTITY_KEYS] order */ keys: string[] }
  | { state: 'clean'; pid: number }
  | { state: 'absent' }
  | { state: 'unknown'; why: string };

/** Does a server started with `env` serve `socket`? Another session (`herdr --session`), sandbox or
 *  user runs its own server, and a doctor row about THAT one would send a person to restart the wrong
 *  server. Required lazily: herdr.ts imports this module. */
function servesSocket(env: NodeJS.ProcessEnv, socket: string, platform: NodeJS.Platform): boolean {
  return (require('./herdr') as typeof import('./herdr')).herdrSocketPath(env, platform) === socket;
}
function ourSocket(platform: NodeJS.Platform): string {
  return (require('./herdr') as typeof import('./herdr')).herdrSocketPath(process.env, platform);
}

/**
 * Inspect the running `herdr server`'s environment for a leaked session identity. Linux reads
 * `/proc`; macOS asks `ps -E` (unverified on a real Mac by this change — the tests inject its
 * output); anywhere else, and wherever the read is refused, the answer is `unknown`, with the reason.
 * Every source is injectable so the tests never depend on the machine they run on. Only the server
 * on `socket` (default: the one this process's herdr talks to) counts.
 */
export function herdrServerIdentityLeak(opts: {
  platform?: NodeJS.Platform;
  socket?: string;
  /** Linux: the pids to inspect (default: every numeric entry of /proc). */
  listPids?: () => number[];
  /** Linux: a pid's NUL-separated argv, or null when unreadable. */
  readCmdline?: (pid: number) => string | null;
  /** Linux: a pid's NUL-separated environment, or null when unreadable. */
  readEnviron?: (pid: number) => string | null;
  /** macOS: `ps` output — `ps -axo pid=,command=` for the listing, `ps -Eo command= -p <pid>` for one env. */
  run?: HerdrRun;
} = {}): HerdrServerIdentity {
  const platform = opts.platform ?? process.platform;
  const socket = opts.socket ?? ourSocket(platform);
  // Exactly `herdr server` — the daemon's own argv. `herdr server reload-config` and `herdr server
  // stop` are short-lived CLI calls that must not be mistaken for the server.
  const isServer = (argv: string[]): boolean => {
    const a = argv.filter(Boolean);
    return a.length === 2 && /(?:^|[\\/])herdr(?:\.exe)?$/.test(a[0]) && a[1] === 'server';
  };
  const verdict = (pid: number, vars: Map<string, string>): HerdrServerIdentity => {
    const keys = SESSION_IDENTITY_KEYS.filter((k) => vars.has(k));
    if (keys.length && vars.get('GIT_EDITOR') === GIT_EDITOR_MARKER) keys.push('GIT_EDITOR');
    return keys.length ? { state: 'leak', pid, keys } : { state: 'clean', pid };
  };
  const parse = (pairs: string[]): Map<string, string> => {
    const vars = new Map<string, string>();
    for (const kv of pairs) { const i = kv.indexOf('='); if (i > 0) vars.set(kv.slice(0, i), kv.slice(i + 1)); }
    return vars;
  };
  if (platform === 'linux') {
    let pids: number[];
    try {
      pids = opts.listPids ? opts.listPids() : fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number);
    } catch (e) {
      return { state: 'unknown', why: `/proc is not readable: ${String((e as Error)?.message || e)}` };
    }
    const read = (file: string): string | null => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    };
    const readCmdline = opts.readCmdline ?? ((pid: number) => read(`/proc/${pid}/cmdline`));
    const readEnviron = opts.readEnviron ?? ((pid: number) => read(`/proc/${pid}/environ`));
    // Another user's server on a shared box is unreadable AND not ours: keep scanning for one we
    // can read, and say "unknown" only when every server found was closed to us.
    let unreadable: number | null = null;
    for (const pid of pids) {
      // A process that exits mid-scan reads as nothing — not this server, move on.
      const argv = (readCmdline(pid) ?? '').split('\0');
      if (!isServer(argv)) continue;
      const environ = readEnviron(pid);
      // An environment that cannot be read, or reads as nothing at all, is unseen — never clean.
      if (environ === null || !environ.includes('=')) { unreadable = unreadable ?? pid; continue; }
      const vars = parse(environ.split('\0'));
      if (!servesSocket(Object.fromEntries(vars), socket, platform)) continue;
      return verdict(pid, vars);
    }
    return unreadable === null ? { state: 'absent' } : { state: 'unknown', why: `/proc/${unreadable}/environ is not readable (a server owned by another user?)` };
  }
  if (platform === 'darwin') {
    const run = opts.run ?? defaultRun(process.env);
    const listing = run('ps', ['-axo', 'pid=,command=']);
    if (listing.status !== 0) return { state: 'unknown', why: `\`ps -axo pid=,command=\` exited ${listing.status ?? '?'}` };
    for (const line of listing.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m || !isServer(m[2].trim().split(/\s+/))) continue;
      const pid = Number(m[1]);
      const env = run('ps', ['-Eo', 'command=', '-p', String(pid)]);
      if (env.status !== 0) return { state: 'unknown', why: `\`ps -Eo command= -p ${pid}\` exited ${env.status ?? '?'}` };
      const tokens = env.stdout.split(/\s+/).filter((t) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
      // BSD ps prints NO environment (and still exits 0) when the system hides it — SIP on newer
      // macOS. An empty environment is not a clean one; it is one nobody could read.
      if (!tokens.length) return { state: 'unknown', why: `\`ps -E\` showed no environment for pid ${pid} (macOS may hide it)` };
      const vars = parse(tokens);
      if (!servesSocket(Object.fromEntries(vars), socket, platform)) continue;
      return verdict(pid, vars);
    }
    return { state: 'absent' };
  }
  return { state: 'unknown', why: `no way to read another process's environment on ${platform}` };
}

/**
 * Inspect the current user's running daemon without starting or stopping anything. A server inside a
 * login scope carries the scope's name and logind's `KillUserProcesses` (read only then): with `no`,
 * logind abandons the scope when the login ends and never stops it. Login scopes are logind's, so
 * off Linux there is nothing to inspect. Only the server on `socket` counts, as in the identity check.
 */
export function herdrServerLoginScope(opts: {
  platform?: NodeJS.Platform;
  socket?: string;
  listPids?: () => number[];
  readCmdline?: (pid: number) => string | null;
  readEnviron?: (pid: number) => string | null;
  readCgroup?: (pid: number) => string | null;
  killUserProcesses?: () => boolean | null;
} = {}): { state: 'scope'; pid: number; scope: string; killUserProcesses: boolean | null } | { state: 'clean'; pid: number }
  | { state: 'absent' } | { state: 'not-applicable' } | { state: 'unknown'; why: string } {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'linux') return { state: 'not-applicable' };
  const socket = opts.socket ?? ourSocket(platform);
  const read = (file: string): string | null => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
  try {
    const pids = opts.listPids ? opts.listPids() : fs.readdirSync('/proc').filter(p => {
      try { return /^\d+$/.test(p) && fs.statSync('/proc/' + p).uid === process.getuid?.(); } catch { return false; }
    }).map(Number);
    let clean: number | undefined, unreadable = false;
    for (const pid of pids) {
      const argv = (opts.readCmdline ? opts.readCmdline(pid) : read('/proc/' + pid + '/cmdline'))?.split('\0').filter(Boolean);
      if (!argv || argv.length !== 2 || !/(?:^|\/)herdr$/.test(argv[0]) || argv[1] !== 'server') continue;
      const environ = opts.readEnviron ? opts.readEnviron(pid) : read('/proc/' + pid + '/environ');
      if (!environ) { unreadable = true; continue; }
      const env = Object.fromEntries(environ.split('\0').filter((kv) => kv.indexOf('=') > 0).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
      if (!servesSocket(env, socket, platform)) continue;
      const cgroup = opts.readCgroup ? opts.readCgroup(pid) : read('/proc/' + pid + '/cgroup');
      if (!cgroup) { unreadable = true; continue; }
      const scope = /\/(session-[^/\s]+\.scope)(?:\/|$)/m.exec(cgroup)?.[1];
      if (scope) return { state: 'scope', pid, scope, killUserProcesses: (opts.killUserProcesses ?? (() => probeKillUserProcesses(process.env, platform)))() };
      clean = pid;
    }
    if (unreadable) return { state: 'unknown', why: 'a running server cgroup could not be read' };
    return clean === undefined ? { state: 'absent' } : { state: 'clean', pid: clean };
  } catch (e) { return { state: 'unknown', why: String((e as Error)?.message || e) }; }
}
