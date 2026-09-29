/* `ensureHerdr()` — the installer, against a FAKE herdr.
 *
 * Nothing here touches the network, ~/.local/bin, ~/.claude, ~/.codex or ~/.config/herdr: every
 * path is a temp dir handed in through `home`/`configDir`, the download is injected, and the
 * "herdr" the code spawns is a shell script that records its argv. The spawns are REAL (that is the
 * point — the install has to produce something executable), which is why the whole file is POSIX-
 * gated: the Windows install path is a zip + Expand-Archive and is not exercised here.
 *
 * Requires the built dist (npm test builds first). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const C = require('../dist');

const POSIX = { skip: process.platform === 'win32' && 'the fixture herdr is a POSIX shell script' };
const PINNED = '0.9.1';

/** A stand-in herdr: answers every verb `ensureHerdr` asks about, and appends each argv to a log. */
function fakeHerdr({ version = PINNED, log, claude = 'not installed', codex = 'not installed', server = 'not running', linked = null, noAgent = null, stale = 'no', configCheck = 'ok', rejectKey = 'sidebar_min_width', statusError = '' }) {
  const q = JSON.stringify(log);
  return (
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${q}`,
      'case "$1" in',
      `  --version) echo "herdr ${version}" ;;`,
      `  status) if [ -n "${statusError}" ]; then echo "${statusError}" >&2; exit 1; fi; echo "client:"; echo "  version: ${version}"; echo ""; echo "server:"; echo "  status: ${server}"; echo ""; echo "update:"; echo "  server_binary_stale: ${stale}" ;;`,
      '  integration)',
      '    case "$2" in',
      `      status) echo "claude: ${claude} (/nowhere/claude)"; echo "codex: ${codex} (/nowhere/codex)"; echo "letta (experimental): not installed (/nowhere/letta)" ;;`,
      // herdr's own refusal when the agent is not on the machine, verbatim from its targets.rs.
      `      install) if [ "$3" = "${noAgent ?? ''}" ]; then echo "$3 directory not found at /nowhere/$3. install $3 first" >&2; exit 1; fi ;;`,
      '    esac ;;',
      '  plugin)',
      '    case "$2" in',
      `      list) ${linked ? `echo "- oak.observatory (OAK) enabled [local:${linked}]"` : 'echo "No plugins installed."'} ;;`,
      '    esac ;;',
      '  server) echo "fake herdr server up" ;;',
      // `bad-after` fails only once OAK's widths or theme are in the file — post-edit rejection. Pure sh:
      // the fake's PATH holds no grep.
      `  config) case "$2" in check) found=0; while IFS= read -r l; do case "$l" in *${rejectKey}*) found=1 ;; esac; done < "$OAK_TEST_CONFIG" 2>/dev/null; if [ "${configCheck}" = ok ] || { [ "${configCheck}" = bad-after ] && [ "$found" = 0 ]; }; then echo "config: ok"; else echo "config: error: bad key" >&2; exit 1; fi ;; esac ;;`,
      'esac',
      'exit 0',
    ].join('\n') + '\n'
  );
}

function writeExec(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
  fs.chmodSync(file, 0o755); // umask cannot be trusted to leave the x bit alone
  return file;
}

/** One sandbox: a fake HOME, a PATH we control, a config dir the code must create itself. */
function bed() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-herdr-'));
  const b = {
    base,
    home: path.join(base, 'home'),
    pathDir: path.join(base, 'bin'), // the injected PATH
    configDir: path.join(base, 'config', 'herdr'), // deliberately absent
    plugin: path.join(base, 'plugin'),
    log: path.join(base, 'argv.log'),
  };
  b.dest = path.join(b.home, '.local', 'bin', 'herdr');
  fs.mkdirSync(b.pathDir, { recursive: true });
  fs.mkdirSync(b.plugin, { recursive: true });
  fs.writeFileSync(path.join(b.plugin, 'herdr-plugin.toml'), 'id = "oak.observatory"\n');
  fs.writeFileSync(b.log, '');
  return b;
}

function withPython(b) {
  writeExec(path.join(b.pathDir, 'python3'), '#!/bin/sh\necho "Python 3.12.0"\n');
  return b;
}

function lockFor(payload, { badDigest = false } = {}) {
  const sha = crypto.createHash('sha256').update(payload).digest('hex');
  return {
    version: PINNED,
    protocol: 22,
    assets: { 'linux-x86_64': 'https://example.invalid/herdr-linux-x86_64' },
    sha256: { 'linux-x86_64': badDigest ? 'de'.repeat(32) : sha },
  };
}

/** Every argv line the fake recorded, as written. */
function argv(b) {
  return fs.readFileSync(b.log, 'utf8').split('\n').filter(Boolean);
}

/** No login scope: the host this suite runs on (an ssh login, a desktop, CI) must not steer the launch. */
const NO_LOGIN = () => ({ cgroup: null, linger: false, killUserProcesses: null, systemdRun: null });

function run(b, opts = {}) {
  return C.ensureHerdr({
    platform: 'linux',
    arch: 'x64',
    home: b.home,
    env: { PATH: b.pathDir },
    configDir: b.configDir,
    pluginDir: b.plugin,
    loginSession: NO_LOGIN,
    ...opts,
  });
}

/** The detached server is fire-and-forget; poll for the effect instead of guessing a sleep. */
async function until(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('herdr: missing → downloads the pin, verifies it, installs it executable, wires it up', POSIX, async () => {
  const b = withPython(bed());
  const payload = Buffer.from(fakeHerdr({ log: b.log }));
  let downloads = 0;
  const report = await run(b, {
    lock: lockFor(payload),
    download: async () => {
      downloads++;
      return payload;
    },
  });

  assert.equal(downloads, 1);
  assert.equal(report.upgraded, true);
  assert.equal(report.installed, true);
  assert.equal(report.version, PINNED);
  assert.equal(report.bin, b.dest);
  assert.equal(fs.statSync(b.dest).mode & 0o777, 0o755, 'installed executable');
  assert.deepEqual(report.integrations, { claude: 'installed', codex: 'installed' });
  assert.equal(report.pluginLinked, true);
  assert.equal(report.python3, true);
  assert.equal(report.serverStarted, true);
  assert.deepEqual(report.warnings, [`add ${path.dirname(b.dest)} to PATH so \`herdr\` resolves in your shell`]);

  const lines = argv(b);
  assert.ok(lines.includes('integration install claude'), 'claude integration installed');
  assert.ok(lines.includes('integration install codex'), 'codex integration installed');
  assert.ok(lines.includes(`plugin link ${b.plugin}`), 'plugin linked by absolute path');

  // The server start is the one step with a REDIRECT, and the directory it redirects into does not
  // exist on a machine that has never run herdr — so the mkdir has to come first or the start fails
  // silently. Proven by the log file existing and carrying the child's stdout.
  const logFile = path.join(b.configDir, 'oak-herdr-server.log');
  assert.ok(await until(() => fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('fake herdr server up')), 'server started, stdout captured under the config dir');
  assert.ok(argv(b).includes('server'), 'the server verb ran');
});

test('herdr: the started server env is stripped of the starting agent session identity', POSIX, async () => {
  const b = withPython(bed());
  const payload = Buffer.from(fakeHerdr({ log: b.log }));
  let captured = null;
  await run(b, {
    lock: lockFor(payload),
    download: async () => payload,
    env: { PATH: b.pathDir, CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'abc', CLAUDECODE: '1', AI_AGENT: 'claude-code', CLAUDE_EFFORT: 'max', CLAUDE_CONFIG_DIR: '/x/.claude' },
    spawnDetached: (_bin, _args, _log, serverEnv) => { captured = serverEnv; },
  });
  assert.ok(captured, 'the server was spawned');
  for (const k of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE', 'AI_AGENT', 'CLAUDE_EFFORT'])
    assert.equal(captured[k], undefined, `${k} must be stripped so a pane's agent is its own top-level session`);
  assert.equal(captured.CLAUDE_CONFIG_DIR, '/x/.claude', 'CLAUDE_CONFIG_DIR (config, not identity) is kept');
  assert.equal(captured.PATH, b.pathDir, 'the rest of the env is preserved');
});

test('herdr: a checksum MISMATCH installs nothing and says so', POSIX, async () => {
  const b = withPython(bed());
  const payload = Buffer.from(fakeHerdr({ log: b.log }));
  await assert.rejects(
    run(b, { lock: lockFor(payload, { badDigest: true }), download: async () => payload }),
    /FAILED its checksum/,
    'a bad digest is loud'
  );
  assert.equal(fs.existsSync(b.dest), false, 'nothing installed');
  // …and no half-downloaded temp left behind for a later run to trip over.
  assert.deepEqual(fs.readdirSync(path.dirname(b.dest)), [], 'the temp file is gone');
  assert.deepEqual(argv(b), [], 'nothing was run');
});

test('herdr: an OLDER install is upgraded; a NEWER one is never touched', POSIX, async () => {
  // older → upgrade
  const older = withPython(bed());
  writeExec(older.dest, fakeHerdr({ version: '0.9.0', log: older.log }));
  const payload = Buffer.from(fakeHerdr({ log: older.log }));
  const up = await run(older, { lock: lockFor(payload), download: async () => payload });
  assert.equal(up.upgraded, true);
  assert.equal(up.version, PINNED);
  assert.equal(fs.readFileSync(older.dest, 'utf8'), payload.toString(), 'the pinned bytes replaced the old ones');

  // newer → untouched. Downloading at all would be the bug, so the injected download fails the test.
  const newer = withPython(bed());
  const mine = fakeHerdr({ version: '0.10.0', log: newer.log });
  writeExec(newer.dest, mine);
  const kept = await run(newer, {
    lock: lockFor(Buffer.from('irrelevant')),
    download: async () => assert.fail('a newer herdr must never be downloaded over'),
  });
  assert.equal(kept.upgraded, false);
  assert.equal(kept.downloaded, undefined);
  assert.equal(kept.version, '0.10.0');
  assert.equal(fs.readFileSync(newer.dest, 'utf8'), mine, 'their binary is byte-identical afterwards');
});

test('herdr: an older herdr earlier on PATH is reported, not answered with a download on every run', POSIX, async () => {
  const b = withPython(bed());
  writeExec(path.join(b.pathDir, 'herdr'), fakeHerdr({ version: '0.9.0', log: b.log })); // e.g. a lagging package manager's
  writeExec(b.dest, fakeHerdr({ log: b.log })); // the pinned copy a previous run installed
  for (let i = 0; i < 2; i++) {
    const report = await run(b, { lock: lockFor(Buffer.alloc(0)), download: async () => assert.fail('the pinned copy is already installed') });
    assert.equal(report.upgraded, false);
    assert.equal(report.bin, b.dest);
    assert.equal(report.version, PINNED);
    assert.ok(report.warnings.some((w) => w.includes(`${path.join(b.pathDir, 'herdr')} comes first on PATH and shadows the pinned herdr at ${b.dest}`)), report.warnings.join('\n'));
  }
});

test('herdr: integrations are installed only when herdr does not already call them current', POSIX, async () => {
  const b = withPython(bed());
  writeExec(b.dest, fakeHerdr({ log: b.log, claude: 'current (v10)', codex: 'outdated (v7 < v8)' }));
  const report = await run(b, { lock: lockFor(Buffer.alloc(0)), download: async () => assert.fail('no download expected') });
  assert.deepEqual(report.integrations, { claude: 'current', codex: 'installed' });
  const lines = argv(b);
  assert.ok(!lines.includes('integration install claude'), 'a current integration is left alone');
  assert.ok(lines.includes('integration install codex'), 'an outdated one is repaired');
});

test('herdr: an agent that is not installed here is “absent”, not a failure to warn about', POSIX, async () => {
  const b = withPython(bed());
  // A very common machine: claude, no codex. herdr refuses the codex integration because there is no
  // codex to integrate with — reporting that as a failure would put a yellow warning on every run.
  writeExec(b.dest, fakeHerdr({ log: b.log, noAgent: 'codex' }));
  const report = await run(b, { lock: lockFor(Buffer.alloc(0)) });
  assert.deepEqual(report.integrations, { claude: 'installed', codex: 'absent' });
  assert.deepEqual(report.warnings, [], 'nothing to warn about');
});

test('herdr: a genuinely failed integration install IS a warning', POSIX, async () => {
  const b = withPython(bed());
  writeExec(b.dest, fakeHerdr({ log: b.log }).replace('  integration)', '  integration)\n    [ "$2" = "install" ] && { echo "settings.json is not valid json" >&2; exit 1; }'));
  const report = await run(b, { lock: lockFor(Buffer.alloc(0)) });
  assert.deepEqual(report.integrations, { claude: 'failed', codex: 'failed' });
  assert.equal(report.warnings.length, 2);
  assert.match(report.warnings[0], /integration install claude` failed: settings\.json is not valid json/);
});

test('herdr: a relative plugin dir is linked as an ABSOLUTE path', POSIX, async () => {
  const b = withPython(bed());
  writeExec(b.dest, fakeHerdr({ log: b.log }));
  const relative = path.relative(process.cwd(), b.plugin);
  const report = await run(b, { lock: lockFor(Buffer.alloc(0)), pluginDir: relative });
  assert.equal(report.pluginLinked, true);
  const linked = argv(b).find((l) => l.startsWith('plugin link '));
  assert.equal(linked, `plugin link ${path.resolve(relative)}`);
  assert.ok(path.isAbsolute(linked.slice('plugin link '.length)), 'absolute — herdr stores what it is given');
});

test('herdr: no python3 is a loud warning, not a silent pass', POSIX, async () => {
  const b = bed(); // no python3 on the injected PATH
  writeExec(b.dest, fakeHerdr({ log: b.log }));
  const report = await run(b, { lock: lockFor(Buffer.alloc(0)) });
  assert.equal(report.python3, false);
  assert.ok(report.warnings.some((w) => /python3/.test(w)), 'the warning names python3');
  assert.ok(report.warnings.some((w) => /join/.test(w)), 'and says what breaks without it');
});

test('herdr: on Windows no python3 is needed, so none is looked for or warned about', POSIX, async () => {
  const b = bed(); // no python3 on the injected PATH
  writeExec(path.join(b.pathDir, 'herdr.exe'), fakeHerdr({ log: b.log })); // what PATH resolves on win32
  const probed = [];
  const report = await run(b, {
    platform: 'win32',
    lock: lockFor(Buffer.alloc(0)),
    run: (file, args) => {
      probed.push(file);
      const r = require('child_process').spawnSync(file, args, { encoding: 'utf8', env: { PATH: b.pathDir } });
      return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
    },
    spawnDetached: () => {},
  });
  assert.equal(report.installed, true, report.warnings.join('\n'));
  assert.ok(!report.warnings.some((w) => /python3/.test(w)), report.warnings.join('\n'));
  assert.ok(!probed.some((f) => /python/.test(f)), 'the PowerShell hooks need no interpreter check');
});

test('herdr: a failing `herdr status` is not read as a running server: nothing starts, and it says why', POSIX, async () => {
  const b = withPython(bed());
  writeExec(b.dest, fakeHerdr({ log: b.log, statusError: 'Error: local socket name length exceeds capacity of sun_path of sockaddr_un' }));
  let started = 0;
  const report = await run(b, { lock: lockFor(Buffer.alloc(0)), spawnDetached: () => { started++; } });
  assert.equal(report.serverStarted, false);
  assert.equal(started, 0, 'no second server on a socket whose state is unknown');
  assert.ok(report.warnings.some((w) => /herdr status. failed.*started none: Error: local socket name length exceeds capacity of sun_path/.test(w)), report.warnings.join('\n'));
});

test('herdr: a running server is left alone; a second run installs and links nothing', POSIX, async () => {
  const b = withPython(bed());
  writeExec(b.dest, fakeHerdr({ log: b.log, claude: 'current (v10)', codex: 'current (v8)', server: 'running', linked: b.plugin }));
  const first = await run(b, { lock: lockFor(Buffer.alloc(0)), download: async () => assert.fail('nothing to download') });
  assert.equal(first.serverStarted, false, 'a running server is not started again');
  assert.equal(first.upgraded, false);
  assert.equal(first.pluginLinked, true);

  const before = argv(b).length;
  const second = await run(b, { lock: lockFor(Buffer.alloc(0)), download: async () => assert.fail('nothing to download') });
  assert.deepEqual(second.integrations, first.integrations);
  const added = argv(b).slice(before);
  assert.deepEqual(
    added.filter((l) => l.startsWith('integration install') || l.startsWith('plugin link') || l === 'server'),
    [],
    'the second run installs nothing, links nothing and starts nothing'
  );
});

test('herdr: an upgrade with a server still on the OLD binary says so', POSIX, async () => {
  const b = withPython(bed());
  // herdr's own status block reports the stale server; nothing else would ever tell the user why a
  // freshly pinned client is talking to a server built against another protocol.
  writeExec(b.dest, fakeHerdr({ log: b.log, server: 'running', stale: 'yes' }));
  const report = await run(b, { lock: lockFor(Buffer.alloc(0)) });
  assert.equal(report.serverStarted, false);
  assert.ok(report.warnings.some((w) => /still the old binary/.test(w)), report.warnings.join(' | '));
});

test('herdr: an older copy earlier on PATH is reported as shadowing the pinned install', POSIX, async () => {
  const b = withPython(bed());
  // A package manager's herdr, on PATH, older than the pin — installing ours to ~/.local/bin does
  // not change which one the shell runs.
  writeExec(path.join(b.pathDir, 'herdr'), fakeHerdr({ version: '0.9.0', log: b.log }));
  const payload = Buffer.from(fakeHerdr({ log: b.log }));
  const report = await run(b, { lock: lockFor(payload), download: async () => payload });
  assert.equal(report.upgraded, true);
  assert.ok(report.warnings.some((w) => w.includes('shadows the pinned herdr')), report.warnings.join(' | '));
});

test('herdr: the platform key follows both this process and a remote uname', () => {
  assert.equal(C.herdrPlatformKey('linux', 'x64'), 'linux-x86_64');
  assert.equal(C.herdrPlatformKey('linux', 'arm64'), 'linux-aarch64');
  assert.equal(C.herdrPlatformKey('darwin', 'x64'), 'macos-x86_64');
  assert.equal(C.herdrPlatformKey('darwin', 'arm64'), 'macos-aarch64');
  assert.equal(C.herdrPlatformKey('win32', 'x64'), 'windows-x86_64');
  assert.equal(C.herdrPlatformKey('win32', 'arm64'), null, 'herdr publishes no windows-aarch64 asset');
  assert.equal(C.herdrPlatformKey('freebsd', 'x64'), null);
  // `uname -s` / `uname -m`, exactly as the remote prints them.
  assert.equal(C.herdrPlatformKeyFromUname('Linux', 'x86_64'), 'linux-x86_64');
  assert.equal(C.herdrPlatformKeyFromUname('Linux', 'aarch64'), 'linux-aarch64');
  assert.equal(C.herdrPlatformKeyFromUname('Darwin', 'arm64'), 'macos-aarch64');
  assert.equal(C.herdrPlatformKeyFromUname('Darwin', 'x86_64'), 'macos-x86_64');
  assert.equal(C.herdrPlatformKeyFromUname('MINGW64_NT-10.0', 'x86_64'), null, 'no ssh install for Windows');
  assert.equal(C.parseHerdrVersion('herdr 0.9.1\n'), '0.9.1');
  assert.equal(C.parseHerdrVersion('bash: herdr: command not found'), null);
});

test('herdr: the generated pin exactly matches the checked-in root herdr.lock', () => {
  const source = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../..', 'herdr.lock'), 'utf8'));
  assert.deepEqual(C.HERDR_LOCK, source, 'run npm run gen:herdr-lock after changing herdr.lock');
  const lock = C.readHerdrLock();
  assert.deepEqual(lock, C.HERDR_LOCK);
  assert.match(lock.version, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof lock.protocol, 'number');
  for (const key of ['linux-x86_64', 'linux-aarch64', 'macos-x86_64', 'macos-aarch64', 'windows-x86_64']) {
    assert.ok(lock.assets[key]?.startsWith('https://'), `${key} has an asset URL`);
    assert.match(lock.sha256[key] ?? '', /^[0-9a-f]{64}$/, `${key} has a sha256`);
    assert.ok(lock.assets[key].includes(`v${lock.version}`), `${key} asset comes from the pinned tag`);
  }
  // OAK's own plugin ships with the lock and is what `ensureHerdr` links by default.
  const dir = C.herdrPluginDir();
  assert.ok(dir && fs.existsSync(path.join(dir, 'herdr-plugin.toml')), 'the plugin directory resolves');
  assert.match(fs.readFileSync(path.join(dir, 'herdr-plugin.toml'), 'utf8'), /min_herdr_version = "(\d+\.\d+\.\d+)"/);
});

test('herdr: ensureHerdr uses the built-in pin when no herdr.lock exists beside an installed package', POSIX, async () => {
  const b = withPython(bed());
  writeExec(b.dest, fakeHerdr({ log: b.log, server: 'running' }));
  const packageRoot = path.join(b.base, 'node_modules', '@oak-observatory', 'core');
  const installedDist = path.join(packageRoot, 'dist');
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.cpSync(path.resolve(__dirname, '../dist'), installedDist, { recursive: true });
  // A published core installation includes its declared TOML dependency too.
  fs.cpSync(path.resolve(path.dirname(require.resolve('smol-toml')), '..'), path.join(b.base, 'node_modules', 'smol-toml'), { recursive: true });
  assert.equal(fs.existsSync(path.join(packageRoot, 'herdr.lock')), false);

  const installed = require(path.join(installedDist, 'herdr-install.js'));
  const report = await installed.ensureHerdr({
    platform: 'linux',
    arch: 'x64',
    home: b.home,
    env: { PATH: b.pathDir },
    configDir: b.configDir,
    pluginDir: b.plugin,
  });
  assert.equal(report.installed, true);
  assert.equal(report.pinned, C.HERDR_LOCK.version);
  assert.equal(report.upgraded, false);
  assert.equal(report.themeConfigured, true);
});

for (const mode of ['error', 'aborted', 'close']) {
  test(`herdr regression: download rejects response ${mode} after partial bytes`, async t => {
    const { EventEmitter } = require('node:events');
    const { PassThrough } = require('node:stream');
    t.mock.method(require('node:https'), 'get', (_url, _options, callback) => {
      const request = new EventEmitter();
      request.setTimeout = () => request;
      queueMicrotask(() => {
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = {};
        callback(response);
        response.write('partial asset');
        if (mode === 'error') response.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
        else if (mode === 'aborted') { response.emit('aborted'); response.destroy(); }
        else response.destroy();
      });
      return request;
    });
    await assert.rejects(C.httpGetBuffer('https://example.invalid/asset'), /aborted|closed|ECONNRESET/i);
  });
}

test('herdr regression: complete download resolves once despite subsequent close', async t => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  t.mock.method(require('node:https'), 'get', (_url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    queueMicrotask(() => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = {};
      callback(response);
      response.end('complete asset');
    });
    return request;
  });
  assert.equal((await C.httpGetBuffer('https://example.invalid/asset')).toString(), 'complete asset');
});

test('herdr regression: Windows archive has a zip suffix and extraction errors retain stderr', async t => {
  const b = bed();
  t.after(() => fs.rmSync(b.base, { recursive: true, force: true }));
  const payload = Buffer.from('fixture archive');
  const url = 'https://example.invalid/herdr-windows.zip';
  const lock = { version: PINNED, protocol: 22, assets: { 'windows-x86_64': url }, sha256: { 'windows-x86_64': crypto.createHash('sha256').update(payload).digest('hex') } };
  let invocation;
  t.mock.method(require('../dist/spawn'), 'spawnToolSync', (file, args, options) => {
    invocation = { file, args, options };
    assert.deepEqual(fs.readFileSync(options.env.OAK_ZIP), payload);
    return { status: 1, stderr: 'fixture: archive extraction refused' };
  });
  await assert.rejects(run(b, { platform: 'win32', lock, download: async () => payload }), /archive extraction refused/);
  assert.equal(path.extname(invocation.options.env.OAK_ZIP), '.zip');
  assert.notEqual(invocation.options.stdio, 'ignore');
  assert.equal(fs.existsSync(invocation.options.env.OAK_ZIP), false);
});

test('herdr regression: POSIX install reports its download and warns only for a missing PATH directory', POSIX, async t => {
  for (const onPath of [false, true]) {
    const b = withPython(bed());
    t.after(() => fs.rmSync(b.base, { recursive: true, force: true }));
    const payload = Buffer.from(fakeHerdr({ log: b.log, server: 'running' }));
    const lock = lockFor(payload);
    const env = { PATH: [b.pathDir, ...(onPath ? [path.dirname(b.dest) + path.sep] : [])].join(path.delimiter) };
    const report = await run(b, { lock, env, download: async () => payload });
    assert.deepEqual(report.downloaded, { url: lock.assets['linux-x86_64'], bytes: payload.length });
    assert.equal(report.warnings.includes(`add ${path.dirname(b.dest)} to PATH so \`herdr\` resolves in your shell`), !onPath);
    assert.equal((await run(b, { lock, env, download: async () => assert.fail('already installed') })).downloaded, undefined);
  }
});

// --- the sidebar widths ------------------------------------------------------------------------------

/** A stock config.toml as herdr's onboarding leaves it: `[ui.toast]` BEFORE `[ui]`, which is the
 *  shape that makes "append a [ui] table" wrong and "insert under the existing header" necessary. */
const STOCK_CONFIG = 'onboarding = false\n\n[ui.toast]\ndelivery = "system"\n\n[ui.sound]\nenabled = true\n\n[ui]\nstatus_indicators = "symbols"\n\n[theme]\nname = "catppuccin"\nauto_switch = false\n';

async function installed(b, extra = {}) {
  writeExec(b.dest, fakeHerdr({ log: b.log, ...extra }));
  return run(b, { env: { PATH: `${b.pathDir}:${path.dirname(b.dest)}`, OAK_TEST_CONFIG: path.join(b.configDir, 'config.toml') }, lock: lockFor(Buffer.from('unused')) });
}

test('herdr sidebar: no config yet → a [ui] table with OAK\'s widths, checked by herdr before it is kept', POSIX, async () => {
  const b = withPython(bed());
  const report = await installed(b);
  const file = path.join(b.configDir, 'config.toml');
  assert.equal(fs.readFileSync(file, 'utf8'), '[ui]\nsidebar_min_width = 48\nsidebar_max_width = 72\n\n[theme]\nname = "gruvbox"\n');
  assert.equal(report.sidebarConfigured, true);
  assert.equal(report.themeConfigured, true);
  assert.ok(argv(b).includes('config check'), 'herdr parsed the file it will load');
  assert.ok(!argv(b).includes('server reload-config'), 'no server was running, nothing to reload');
  assert.ok(!fs.readdirSync(b.configDir).some((f) => f.includes('.bak-oak-')), 'nothing existed to back up');
  // A second run changes nothing: the keys are there, so the file is not rewritten or re-checked.
  const before = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(b.log, '');
  const again = await installed(b);
  assert.equal(again.sidebarConfigured, false);
  assert.equal(again.themeConfigured, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.ok(!argv(b).includes('config check'), 'an idempotent run does not recheck');
});

test('herdr sidebar: a stock config gains the widths under its existing [ui] header, byte-for-byte otherwise, and a live server reloads', POSIX, async () => {
  const b = withPython(bed());
  fs.mkdirSync(b.configDir, { recursive: true });
  const file = path.join(b.configDir, 'config.toml');
  fs.writeFileSync(file, STOCK_CONFIG);
  const report = await installed(b, { server: 'running' });
  assert.equal(report.sidebarConfigured, true);
  assert.equal(report.themeConfigured, false, 'the stock catppuccin choice wins');
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    STOCK_CONFIG.replace('[ui]\n', '[ui]\nsidebar_min_width = 48\nsidebar_max_width = 72\n')
  );
  const backup = fs.readdirSync(b.configDir).find((f) => f.startsWith('config.toml.bak-oak-'));
  assert.ok(backup, 'the pre-touch copy sits beside the file');
  assert.equal(fs.readFileSync(path.join(b.configDir, backup), 'utf8'), STOCK_CONFIG);
  assert.ok(argv(b).includes('server reload-config'), 'the running server was told to reload');
  assert.deepEqual(report.warnings, []);
});

test('herdr sidebar: a width the person set — table key or dotted key — is theirs, and the file is not touched', POSIX, async () => {
  for (const theirs of ['[ui]\nsidebar_width = 30\n\n[theme]\nname = "gruvbox"\n', '[ui]\nsidebar_max_width = 40\n\n[theme]\nname = "catppuccin"\n', 'ui.sidebar_min_width = 20\n\n[theme]\nname = "x"\n']) {
    const b = withPython(bed());
    fs.mkdirSync(b.configDir, { recursive: true });
    const file = path.join(b.configDir, 'config.toml');
    fs.writeFileSync(file, theirs);
    const report = await installed(b, { server: 'running' });
    assert.equal(report.sidebarConfigured, false, theirs);
    assert.equal(fs.readFileSync(file, 'utf8'), theirs, 'untouched');
    assert.ok(!argv(b).includes('config check') && !argv(b).includes('server reload-config'), 'nothing to check or reload');
    assert.ok(!fs.readdirSync(b.configDir).some((f) => f.includes('.bak-oak-')), 'no backup for an untouched file');
  }
});

test('herdr sidebar: a file herdr refuses to parse is put back exactly as it was, and the report says so', POSIX, async () => {
  const b = withPython(bed());
  fs.mkdirSync(b.configDir, { recursive: true });
  const file = path.join(b.configDir, 'config.toml');
  fs.writeFileSync(file, STOCK_CONFIG, { mode: 0o600 });
  const report = await installed(b, { configCheck: 'bad-after' });
  assert.equal(report.sidebarConfigured, false);
  assert.equal(fs.readFileSync(file, 'utf8'), STOCK_CONFIG, 'restored byte-for-byte');
  assert.ok(report.warnings.some((w) => /rejected the sidebar widths.*\(config: error: bad key\)/.test(w)), report.warnings.join('\n'));
  assert.ok(!fs.readdirSync(b.configDir).some((f) => f.includes('.bak-oak-')), 'a rejected edit leaves no backup behind');
  // …and with no file before, the rejected one is removed rather than left half-made.
  const c = withPython(bed());
  const again = await installed(c, { configCheck: 'bad' });
  assert.ok(!fs.existsSync(path.join(c.configDir, 'config.toml')), 'a rejected first config does not linger');
  assert.equal(again.sidebarConfigured, false);
  assert.equal(again.themeConfigured, false);
});

// --- the default theme -------------------------------------------------------------------------------

const USER_WIDTH = '[ui]\nsidebar_max_width = 40\n';
const THEME_KEY = 'name = "gruvbox"\n';

test('herdr theme: a new table goes at the end, preserves other names and subtables, and reloads once', POSIX, async () => {
  const b = withPython(bed());
  fs.mkdirSync(b.configDir, { recursive: true });
  const file = path.join(b.configDir, 'config.toml');
  const before = 'name = "root"\n' + USER_WIDTH + 'name = "ui"\n[theme.light]\nname = "other"';
  fs.writeFileSync(file, before, { mode: 0o600 });
  const report = await installed(b, { server: 'running' });
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(after, before + '\n\n[theme]\n' + THEME_KEY);
  assert.equal(require('smol-toml').parse(after).theme.name, 'gruvbox');
  assert.equal(report.themeConfigured, true);
  assert.equal(report.sidebarConfigured, false);
  assert.deepEqual(report.warnings, []);
  const backups = fs.readdirSync(b.configDir).filter(f => f.includes('.bak-oak-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(b.configDir, backups[0]), 'utf8'), before);
  assert.equal(fs.statSync(path.join(b.configDir, backups[0])).mode & 0o777, 0o600);
  assert.deepEqual(argv(b).filter(a => a === 'config check' || a === 'server reload-config'),
    ['config check', 'config check', 'server reload-config']);
});

test('herdr theme: inserts under an existing nameless header, preserving comments, other keys and line endings', POSIX, async () => {
  for (const [prefix, header, tail] of [
    [USER_WIDTH, '[theme]\n', '# name = "commented out"\nauto_switch = false\n[other]\nname = "other"\n'],
    [USER_WIDTH, ' [ theme ] # chosen table\r\n', 'auto_switch = false\r\n'],
    [USER_WIDTH, '["theme"]\n', 'auto_switch = false\n'],
    [USER_WIDTH + '["other"]\nname = "other"\n', '["th\\u0065me"]\n', 'auto_switch = false\n'],
    [USER_WIDTH, "['theme']", ''],
    [USER_WIDTH, '[theme] # no trailing newline', ''],
    ['description = """\n[theme]\nexample\n"""\n' + USER_WIDTH, '[theme]\n', 'auto_switch = false\n'],
  ]) {
    const b = withPython(bed());
    const file = path.join(b.configDir, 'config.toml');
    fs.mkdirSync(b.configDir, { recursive: true });
    const before = prefix + header + tail;
    fs.writeFileSync(file, before);
    const report = await installed(b);
    assert.equal(report.themeConfigured, true, before);
    assert.deepEqual(report.warnings, [], before);
    const after = fs.readFileSync(file, 'utf8');
    assert.equal(after, prefix + header + (header.endsWith('\n') ? '' : '\n') + THEME_KEY + tail);
    assert.deepEqual(require('smol-toml').parse(after), {
      ...require('smol-toml').parse(before), theme: { ...require('smol-toml').parse(before).theme, name: 'gruvbox' },
    }, 'the theme name is the only semantic change');
  }
});

test('herdr theme: any chosen name is kept, including gruvbox, other themes, quoted keys and dotted keys', POSIX, async () => {
  for (const before of [
    USER_WIDTH + '[theme]\nname = "gruvbox"\n',
    USER_WIDTH + '[theme]\nname = "catppuccin"\n',
    USER_WIDTH + '[theme]\n"name" = ""\n',
    USER_WIDTH + "['theme']\n'name' = 'custom'\n",
    'theme.name = "custom"\n' + USER_WIDTH,
    'theme = { name = "custom" }\n' + USER_WIDTH,
  ]) {
    const b = withPython(bed());
    const file = path.join(b.configDir, 'config.toml');
    fs.mkdirSync(b.configDir, { recursive: true });
    fs.writeFileSync(file, before, { mode: 0o600 });
    assert.equal(C.ensureHerdrThemeConfig(file), 'kept');
    const report = await installed(b, { server: 'running' });
    assert.equal(report.themeConfigured, false, before);
    assert.equal(report.sidebarConfigured, false, before);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(!argv(b).includes('config check') && !argv(b).includes('server reload-config'));
    assert.ok(!fs.readdirSync(b.configDir).some(f => f.includes('.bak-oak-')));
  }
});

test('herdr theme: pre-check failure leaves the original alone, with no backup or reload', POSIX, async () => {
  for (const before of [USER_WIDTH + '[theme]\nauto_switch = false\n', USER_WIDTH + '[theme\n']) {
    const b = withPython(bed());
    const file = path.join(b.configDir, 'config.toml');
    fs.mkdirSync(b.configDir, { recursive: true });
    fs.writeFileSync(file, before, { mode: 0o600 });
    const report = await installed(b, { configCheck: 'bad', server: 'running' });
    assert.equal(report.themeConfigured, false);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(report.warnings.some(w => /rejects .* as it is.*config: error: bad key/.test(w)));
    assert.equal(argv(b).filter(a => a === 'config check').length, 1);
    assert.ok(!argv(b).includes('server reload-config'));
    assert.ok(!fs.readdirSync(b.configDir).some(f => f.includes('.bak-oak-')));
  }
});

test('herdr theme: rejection restores the original bytes and mode, including a simultaneous sidebar edit', POSIX, async () => {
  for (const before of [USER_WIDTH + '[theme]\nauto_switch = false\n', '# both defaults absent\n']) {
    const b = withPython(bed());
    const file = path.join(b.configDir, 'config.toml');
    fs.mkdirSync(b.configDir, { recursive: true });
    fs.writeFileSync(file, before, { mode: 0o640 });
    const original = fs.readFileSync(file);
    const mode = fs.statSync(file).mode;
    const report = await installed(b, { configCheck: 'bad-after', rejectKey: 'gruvbox', server: 'running' });
    assert.equal(report.themeConfigured, false);
    assert.equal(report.sidebarConfigured, false);
    assert.deepEqual(fs.readFileSync(file), original);
    assert.equal(fs.statSync(file).mode, mode);
    assert.ok(report.warnings.some(w => /rejected the .*gruvbox theme.*config: error: bad key.*restored it/.test(w)));
    assert.equal(argv(b).filter(a => a === 'config check').length, 2, 'the fake accepted the original, then rejected the edit');
    assert.ok(!argv(b).includes('server reload-config'));
    assert.ok(!fs.readdirSync(b.configDir).some(f => f.includes('.bak-oak-')));
  }
});

test('herdr theme: both defaults share exactly one original backup and reload, and reruns do neither', POSIX, async () => {
  const b = withPython(bed());
  const file = path.join(b.configDir, 'config.toml');
  fs.mkdirSync(b.configDir, { recursive: true });
  const before = '# first setup\n';
  fs.writeFileSync(file, before, { mode: 0o600 });
  const report = await installed(b, { server: 'running' });
  assert.equal(report.sidebarConfigured, true);
  assert.equal(report.themeConfigured, true);
  const backups = fs.readdirSync(b.configDir).filter(f => f.includes('.bak-oak-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(b.configDir, backups[0]), 'utf8'), before);
  assert.equal(fs.statSync(path.join(b.configDir, backups[0])).mode & 0o777, 0o600);
  assert.deepEqual(require('smol-toml').parse(fs.readFileSync(file, 'utf8')), {
    ui: { sidebar_min_width: 48, sidebar_max_width: 72 }, theme: { name: 'gruvbox' },
  });
  assert.equal(argv(b).filter(a => a === 'server reload-config').length, 1);
  fs.writeFileSync(b.log, '');
  const again = await installed(b, { server: 'running' });
  assert.equal(again.sidebarConfigured, false);
  assert.equal(again.themeConfigured, false);
  assert.deepEqual(fs.readdirSync(b.configDir).filter(f => f.includes('.bak-oak-')), backups);
  assert.ok(!argv(b).includes('config check') && !argv(b).includes('server reload-config'));
});

test('herdr theme: nameless inline/dotted tables cannot be extended with [theme], so rejection preserves them', POSIX, async () => {
  for (const declaration of ['theme = { auto_switch = false }\n', 'theme.auto_switch = false\n']) {
    const b = withPython(bed());
    const file = path.join(b.configDir, 'config.toml');
    fs.mkdirSync(b.configDir, { recursive: true });
    const before = declaration + USER_WIDTH;
    fs.writeFileSync(file, before);
    require('smol-toml').parse(before);
    assert.equal(C.ensureHerdrThemeConfig(file), 'set');
    assert.throws(() => require('smol-toml').parse(fs.readFileSync(file, 'utf8')), /table|key/i);
    fs.writeFileSync(file, before);
    const report = await installed(b, { configCheck: 'bad-after', rejectKey: 'gruvbox', server: 'running' });
    assert.equal(report.themeConfigured, false);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.ok(report.warnings.some(w => /rejected the gruvbox theme.*restored it/.test(w)));
    assert.ok(!argv(b).includes('server reload-config'));
    assert.ok(!fs.readdirSync(b.configDir).some(f => f.includes('.bak-oak-')));
  }
});

test('herdr theme: HERDR_CONFIG_PATH selects the file and a new server starts with gruvbox already on disk', POSIX, async () => {
  const b = withPython(bed());
  const file = path.join(b.base, 'custom.toml');
  fs.writeFileSync(file, USER_WIDTH);
  writeExec(b.dest, fakeHerdr({ log: b.log }));
  let atSpawn;
  const report = await run(b, {
    env: { PATH: `${b.pathDir}:${path.dirname(b.dest)}`, HERDR_CONFIG_PATH: file, OAK_TEST_CONFIG: file },
    lock: lockFor(Buffer.from('unused')),
    spawnDetached: () => { atSpawn = fs.readFileSync(file, 'utf8'); },
  });
  assert.equal(report.themeConfigured, true);
  assert.equal(report.serverStarted, true);
  assert.equal(atSpawn, USER_WIDTH + '\n[theme]\n' + THEME_KEY);
  assert.ok(!fs.existsSync(path.join(b.configDir, 'config.toml')));
  assert.ok(!argv(b).includes('server reload-config'));
});

// --- the server's leaked session identity -------------------------------------------------------------

test('herdr identity leak: a server started inside a Claude Code session is named; clean, absent and uninspectable are each their own answer', () => {
  const NUL = '\0';
  const procs = {
    10: { cmd: ['/usr/bin/zsh'], env: ['CLAUDECODE=1', 'HOME=/h'] },
    20: { cmd: ['/home/u/.local/bin/herdr', 'server'], env: ['PATH=/x', 'CLAUDE_CODE_CHILD_SESSION=1', 'CLAUDECODE=1', 'CLAUDE_CODE_SESSION_ID=abc', 'AI_AGENT=claude-code_agent', 'CLAUDE_CONFIG_DIR=/h/.claude', 'HERDR_SOCKET_PATH=/run/ours.sock'] },
    30: { cmd: ['herdr', 'remote-client-bridge'], env: ['CLAUDECODE=1'] },
  };
  const inject = (table) => ({
    platform: 'linux',
    socket: '/run/ours.sock',
    listPids: () => Object.keys(table).map(Number),
    readCmdline: (pid) => (table[pid] ? table[pid].cmd.join(NUL) + NUL : null),
    readEnviron: (pid) => (table[pid] ? table[pid].env.join(NUL) + NUL : null),
  });
  assert.deepEqual(C.herdrServerIdentityLeak(inject(procs)), { state: 'leak', pid: 20, keys: ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'AI_AGENT'] });
  // The same server started from a plain terminal: present, and clean.
  assert.deepEqual(C.herdrServerIdentityLeak(inject({ ...procs, 20: { cmd: procs[20].cmd, env: ['PATH=/x', 'CLAUDE_CONFIG_DIR=/h/.claude', 'HERDR_SOCKET_PATH=/run/ours.sock'] } })), { state: 'clean', pid: 20 });
  // Another server listed first (another session, sandbox or user) is not the one this doctor talks to.
  const other = { cmd: procs[20].cmd, env: ['CLAUDECODE=1', 'HERDR_SOCKET_PATH=/run/other.sock'] };
  assert.deepEqual(C.herdrServerIdentityLeak(inject({ 15: other, 20: { cmd: procs[20].cmd, env: ['HERDR_SOCKET_PATH=/run/ours.sock'] } })), { state: 'clean', pid: 20 });
  assert.deepEqual(C.herdrServerIdentityLeak(inject({ 15: other })), { state: 'absent' });
  // With no HERDR_SOCKET_PATH, the socket follows herdr's own default for that environment.
  assert.equal(C.herdrServerIdentityLeak({ ...inject({ 20: { cmd: procs[20].cmd, env: ['HOME=/h', 'CLAUDECODE=1'] } }), socket: '/h/.config/herdr/herdr.sock' }).state, 'leak');
  // No server at all — and a shell that merely carries the marker is not a server.
  assert.deepEqual(C.herdrServerIdentityLeak(inject({ 10: procs[10], 30: procs[30] })), { state: 'absent' });
  // A server whose environment cannot be read (another user's) is UNKNOWN, never "clean".
  const refused = C.herdrServerIdentityLeak({ ...inject(procs), readEnviron: () => null });
  assert.equal(refused.state, 'unknown'); assert.match(refused.why, /\/proc\/20\/environ/);
  // A process that exits mid-scan (unreadable cmdline) is skipped, not a crash.
  assert.deepEqual(C.herdrServerIdentityLeak({ ...inject(procs), readCmdline: (pid) => (pid === 20 ? null : procs[pid].cmd.join(NUL)) }), { state: 'absent' });
  // /proc itself unreadable → unknown with the reason.
  assert.equal(C.herdrServerIdentityLeak({ platform: 'linux', listPids: () => { throw new Error('EACCES'); } }).state, 'unknown');
  // macOS: the listing names the server, `ps -E` shows its environment inline.
  const calls = [];
  const mac = C.herdrServerIdentityLeak({
    platform: 'darwin',
    run: (file, args) => {
      calls.push([file, ...args].join(' '));
      if (args[0] === '-axo') return { status: 0, stdout: '  100 /bin/zsh -l\n  200 /Users/u/.local/bin/herdr server\n', stderr: '' };
      return { status: 0, stdout: '/Users/u/.local/bin/herdr server PATH=/x CLAUDE_CODE_CHILD_SESSION=1 CLAUDECODE=1 HERDR_SOCKET_PATH=/run/ours.sock\n', stderr: '' };
    },
    socket: '/run/ours.sock',
  });
  assert.deepEqual(mac, { state: 'leak', pid: 200, keys: ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE'] });
  assert.deepEqual(calls, ['ps -axo pid=,command=', 'ps -Eo command= -p 200']);
  assert.deepEqual(C.herdrServerIdentityLeak({ platform: 'darwin', run: () => ({ status: 0, stdout: '  100 /bin/zsh -l\n', stderr: '' }) }), { state: 'absent' });
  assert.equal(C.herdrServerIdentityLeak({ platform: 'darwin', run: () => ({ status: 1, stdout: '', stderr: 'ps: nope' }) }).state, 'unknown');
  // Windows offers nothing to read: unknown, with the reason — not a clean bill.
  const win = C.herdrServerIdentityLeak({ platform: 'win32' });
  assert.equal(win.state, 'unknown'); assert.match(win.why, /win32/);
});

test('herdr identity strip: the session identity is removed, config is kept, the input is untouched', () => {
  const env = { PATH: '/x', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', AI_AGENT: 'claude', CLAUDE_EFFORT: 'max', CLAUDE_PID: '7', TRACEPARENT: 'x',
    CLAUDE_CODE_BRIDGE_SESSION_ID: 's', CLAUDE_CODE_MESSAGING_SOCKET: '/s', CLAUDE_CODE_ENTRYPOINT: 'cli', GIT_EDITOR: 'true',
    CLAUDE_CONFIG_DIR: '/h/.claude', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_GIT_BASH_PATH: 'C:/bash', CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1', HERDR_PANE_ID: 'w1:p1' };
  const out = C.stripSessionIdentity(env);
  assert.deepEqual(out, { PATH: '/x', CLAUDE_CONFIG_DIR: '/h/.claude', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_GIT_BASH_PATH: 'C:/bash', CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1', HERDR_PANE_ID: 'w1:p1' },
    'identity goes, settings stay — the whole CLAUDE_CODE_ prefix is NOT the identity');
  assert.equal(env.CLAUDECODE, '1', 'the input is a copy source, not mutated');
  // GIT_EDITOR=true is Claude Code's, but only when it travels with the identity; a person's own editor stays.
  assert.equal(C.stripSessionIdentity({ GIT_EDITOR: 'true', PATH: '/x' }).GIT_EDITOR, 'true');
  assert.equal(C.stripSessionIdentity({ GIT_EDITOR: 'vim', CLAUDECODE: '1' }).GIT_EDITOR, 'vim');
  for (const k of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'AI_AGENT', 'CLAUDE_EFFORT', 'CLAUDE_PID', 'CLAUDE_CODE_SESSION_ACCESS_TOKEN', 'CLAUDE_CODE_BRIDGE_OWNER_ORG_UUID', 'CLAUDE_CODE_EXECPATH']) assert.equal(C.isSessionIdentityKey(k), true, k);
  for (const k of ['CLAUDE_CONFIG_DIR', 'PATH', 'HERDR_PANE_ID', 'CLAUDE', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_ANYTHING']) assert.equal(C.isSessionIdentityKey(k), false, k);
});

// --- where herdr keeps its config -------------------------------------------

test('herdr config dir: XDG wins; Windows reads %APPDATA%\\herdr, never ~/.config; POSIX ~/.config/herdr', () => {
  assert.equal(C.herdrConfigDir('/home/u', {}, 'linux'), '/home/u/.config/herdr');
  assert.equal(C.herdrConfigDir('/home/u', { XDG_CONFIG_HOME: '/xdg' }, 'linux'), '/xdg/herdr');
  assert.equal(C.herdrConfigDir('C:\\Users\\u', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32'), 'C:\\Users\\u\\AppData\\Roaming\\herdr');
  assert.equal(C.herdrConfigDir('C:\\Users\\u', { USERPROFILE: 'C:\\Users\\u' }, 'win32'), 'C:\\Users\\u\\AppData\\Roaming\\herdr');
  assert.equal(C.herdrConfigDir('C:\\Users\\u', { XDG_CONFIG_HOME: 'D:\\cfg' }, 'win32'), 'D:\\cfg\\herdr');
  assert.equal(C.herdrConfigDir('/Users/u', {}, 'darwin'), '/Users/u/.config/herdr');
});

test('herdr sidebar: HERDR_CONFIG_PATH names the file herdr reads, so that is the file OAK edits', POSIX, async () => {
  const b = withPython(bed());
  const elsewhere = path.join(b.base, 'elsewhere', 'herdr.toml');
  fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
  fs.writeFileSync(elsewhere, STOCK_CONFIG);
  writeExec(b.dest, fakeHerdr({ log: b.log }));
  const report = await run(b, { env: { PATH: `${b.pathDir}:${path.dirname(b.dest)}`, HERDR_CONFIG_PATH: elsewhere, OAK_TEST_CONFIG: elsewhere }, lock: lockFor(Buffer.from('unused')) });
  assert.equal(report.sidebarConfigured, true);
  assert.match(fs.readFileSync(elsewhere, 'utf8'), /\[ui\]\nsidebar_min_width = 48\nsidebar_max_width = 72\n/);
  assert.ok(!fs.existsSync(path.join(b.configDir, 'config.toml')), 'nothing lands in the default location');
});

test('herdr sidebar: a config herdr ALREADY rejects is left alone — no edit, no backup, the diagnostic quoted', POSIX, async () => {
  const b = withPython(bed());
  fs.mkdirSync(b.configDir, { recursive: true });
  const file = path.join(b.configDir, 'config.toml');
  fs.writeFileSync(file, STOCK_CONFIG);
  for (let i = 0; i < 2; i++) {
    const report = await installed(b, { configCheck: 'bad' });
    assert.equal(report.sidebarConfigured, false);
    assert.equal(fs.readFileSync(file, 'utf8'), STOCK_CONFIG, 'untouched');
    assert.ok(report.warnings.some((w) => /rejects .*config\.toml as it is \(config: error: bad key\) — fix that first/.test(w)), report.warnings.join('\n'));
    assert.ok(!report.warnings.some((w) => /rejected the sidebar widths/.test(w)), 'the widths are not blamed for a file herdr refused before they existed');
    assert.ok(!fs.readdirSync(b.configDir).some((f) => f.includes('.bak-oak-')), `run ${i + 1}: no backup piles up`);
  }
});

test('herdr sidebar: the backup keeps the config\'s own mode, and a server OAK starts is born after the widths are on disk', POSIX, async () => {
  const b = withPython(bed());
  fs.mkdirSync(b.configDir, { recursive: true });
  const file = path.join(b.configDir, 'config.toml');
  fs.writeFileSync(file, STOCK_CONFIG, { mode: 0o600 });
  let atSpawn = 'never spawned';
  writeExec(b.dest, fakeHerdr({ log: b.log }));
  const report = await run(b, {
    env: { PATH: `${b.pathDir}:${path.dirname(b.dest)}`, OAK_TEST_CONFIG: file }, lock: lockFor(Buffer.from('unused')),
    spawnDetached: () => { atSpawn = fs.readFileSync(file, 'utf8'); },
  });
  assert.equal(report.serverStarted, true);
  assert.equal(report.sidebarConfigured, true);
  assert.match(atSpawn, /sidebar_min_width = 48/, 'the server reads the widths at birth — no reload-config reaches a server started after the step');
  const backup = fs.readdirSync(b.configDir).find((f) => f.startsWith('config.toml.bak-oak-'));
  assert.ok(backup);
  assert.equal(fs.statSync(path.join(b.configDir, backup)).mode & 0o777, 0o600, 'a 0600 config gets a 0600 backup');
});

test('herdr identity leak: GIT_EDITOR=true rides with the identity; only `herdr server` is the server; other users\' servers are skipped, not fatal', () => {
  const NUL = '\0';
  const inject = (table) => ({
    platform: 'linux',
    socket: C.herdrSocketPath({}, 'linux'), // these servers name no socket: herdr's default for this user
    listPids: () => Object.keys(table).map(Number),
    readCmdline: (pid) => (table[pid] ? table[pid].cmd.join(NUL) + NUL : null),
    readEnviron: (pid) => (table[pid] && table[pid].env ? table[pid].env.join(NUL) + NUL : null),
  });
  const leaked = ['PATH=/x', 'CLAUDECODE=1', 'CLAUDE_CODE_CHILD_SESSION=1', 'GIT_EDITOR=true'];
  assert.deepEqual(C.herdrServerIdentityLeak(inject({ 20: { cmd: ['/u/.local/bin/herdr', 'server'], env: leaked } })),
    { state: 'leak', pid: 20, keys: ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'GIT_EDITOR'] });
  // A person's own GIT_EDITOR is never an identity, and GIT_EDITOR=true alone (no identity) is not a leak either.
  assert.deepEqual(C.herdrServerIdentityLeak(inject({ 20: { cmd: ['herdr', 'server'], env: ['PATH=/x', 'GIT_EDITOR=true'] } })), { state: 'clean', pid: 20 });
  // `herdr server reload-config` is a CLI call, not the daemon: with only that around, no server runs.
  assert.deepEqual(C.herdrServerIdentityLeak(inject({ 30: { cmd: ['/u/.local/bin/herdr', 'server', 'reload-config'], env: leaked } })), { state: 'absent' });
  // Another user's server (environ unreadable) is skipped when ours can be read; alone, it is unknown.
  assert.deepEqual(C.herdrServerIdentityLeak(inject({ 10: { cmd: ['herdr', 'server'], env: null }, 20: { cmd: ['herdr', 'server'], env: ['PATH=/x'] } })), { state: 'clean', pid: 20 });
  assert.equal(C.herdrServerIdentityLeak(inject({ 10: { cmd: ['herdr', 'server'], env: null } })).state, 'unknown');
  // An environment that reads as nothing is unseen, not clean.
  assert.equal(C.herdrServerIdentityLeak(inject({ 20: { cmd: ['herdr', 'server'], env: [''] } })).state, 'unknown');
  // macOS: `ps -E` that prints only the command line (the environment hidden) is unknown, never clean.
  const hidden = C.herdrServerIdentityLeak({ platform: 'darwin', run: (file, args) => args[0] === '-axo'
    ? { status: 0, stdout: '  200 /Users/u/.local/bin/herdr server\n', stderr: '' }
    : { status: 0, stdout: '/Users/u/.local/bin/herdr server\n', stderr: '' } });
  assert.equal(hidden.state, 'unknown'); assert.match(hidden.why, /no environment/);
});

// --- the server must outlive the LOGIN that started it, not just the process ----------------------
// A laptop lid closing ended the ssh login that had started the workstation's herdr server; logind
// (KillUserProcesses=yes) then SIGTERMed that login's whole scope — server, panes, agents — although
// the server was setsid'd with no terminal. Measured 2026-09-23, 7 of 7 kills that day.
const SESSION = '0::/user.slice/user-1000.slice/session-7.scope\n';
const loginFacts = (over = {}) => ({ cgroup: SESSION, linger: true, killUserProcesses: true, systemdRun: '/usr/bin/systemd-run', ...over });

test('server launch: inside a login scope on a KillUserProcesses host → a user scope that no login owns', () => {
  const plan = C.planHerdrServerLaunch('/h/herdr', ['server'], loginFacts(), 42);
  assert.deepEqual(plan, {
    file: '/usr/bin/systemd-run',
    args: ['--user', '--scope', '--quiet', '--collect', '--unit=oak-herdr-server-42', '--', '/h/herdr', 'server'],
  });
  // cgroup v1 hosts name the scope on a `name=systemd` line; same answer.
  assert.equal(C.planHerdrServerLaunch('/h/herdr', ['server'], loginFacts({ cgroup: '12:cpu:/\n1:name=systemd:/user.slice/user-1000.slice/session-3.scope\n' })).file, '/usr/bin/systemd-run');
});

test('server launch: where the plain detached spawn already outlives the login, nothing changes', () => {
  const plain = { file: '/h/herdr', args: ['server'] };
  // Not in a login scope: a desktop app, a user service (tmux under systemd-run), a pane of a moved server.
  assert.deepEqual(C.planHerdrServerLaunch('/h/herdr', ['server'], loginFacts({ cgroup: '0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1.scope\n' })), plain);
  // Not Linux (the probe reads no cgroup there).
  assert.deepEqual(C.planHerdrServerLaunch('/h/herdr', ['server'], loginFacts({ cgroup: null })), plain);
  // Ubuntu's default — KillUserProcesses=no, no linger: an abandoned login scope lives on, while the
  // user manager would stop with the last logout and take the server with it.
  assert.deepEqual(C.planHerdrServerLaunch('/h/herdr', ['server'], loginFacts({ linger: false, killUserProcesses: false })), plain);
  assert.deepEqual(C.planHerdrServerLaunch('/h/herdr', ['server'], loginFacts({ linger: false, killUserProcesses: null })), plain);
});

test('server launch: a server that will still stop with a login is said out loud', () => {
  const noLinger = C.planHerdrServerLaunch('/h/herdr', ['server'], loginFacts({ linger: false }));
  assert.equal(noLinger.file, '/usr/bin/systemd-run');
  assert.match(noLinger.warning, /loginctl enable-linger/);
  const cannotMove = C.planHerdrServerLaunch('/h/herdr', ['server'], loginFacts({ systemdRun: null }));
  assert.deepEqual([cannotMove.file, cannotMove.args], ['/h/herdr', ['server']]);
  assert.match(cannotMove.warning, /KillUserProcesses=yes/);
  // Off Linux the probe answers without touching the host.
  assert.deepEqual(C.probeLoginSession({}, 'darwin'), { cgroup: null, linger: false, killUserProcesses: null, systemdRun: null });
});

test('herdr: the server start follows the launch plan, and its warning reaches the report', POSIX, async () => {
  const b = withPython(bed());
  writeExec(path.join(b.pathDir, 'herdr'), fakeHerdr({ log: b.log }));
  let spawned = null;
  const report = await run(b, {
    loginSession: () => loginFacts({ linger: false }),
    spawnDetached: (file, args, _log, env) => { spawned = { file, args, env }; },
  });
  assert.equal(report.serverStarted, true);
  assert.equal(spawned.file, '/usr/bin/systemd-run');
  assert.deepEqual(spawned.args.slice(-3), ['--', path.join(b.pathDir, 'herdr'), 'server']);
  assert.equal(spawned.env.PATH, b.pathDir, 'the server still gets the stripped caller env');
  assert.ok(report.warnings.some((w) => /enable-linger/.test(w)), report.warnings.join(' | '));
});

// The argv above against REAL systemd: the started process must land in its own user scope. Runs only
// where this user can start one (skipped in CI containers and off Linux); kills what it started.
const REAL_SYSTEMD_RUN = process.platform === 'linux' && ['/usr/bin/systemd-run', '/bin/systemd-run'].find((p) => fs.existsSync(p));
const CAN_SCOPE = Boolean(REAL_SYSTEMD_RUN) && require('child_process').spawnSync(REAL_SYSTEMD_RUN, ['--user', '--scope', '--quiet', '--collect', '--', 'true'], { timeout: 10000, killSignal: 'SIGKILL' }).status === 0;
test('herdr: on a real systemd host the started server lands in its own user scope, outside every login', { skip: !CAN_SCOPE && 'needs `systemd-run --user --scope` (Linux with a user manager)' }, async () => {
  const b = withPython(bed());
  const rec = path.join(b.base, 'server');
  // A replacer FUNCTION: in a replacement string `$$` means a literal `$`, and the pid would be lost.
  writeExec(path.join(b.pathDir, 'herdr'), fakeHerdr({ log: b.log }).replace(
    '  server) echo "fake herdr server up" ;;',
    () => `  server) echo $$ > ${JSON.stringify(rec + '.pid')}; /bin/cat /proc/self/cgroup > ${JSON.stringify(rec + '.cgroup')}; exec /bin/sleep 60 ;;`,
  ));
  await run(b, {
    env: { PATH: b.pathDir, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS },
    loginSession: () => loginFacts({ systemdRun: REAL_SYSTEMD_RUN }),
  });
  assert.ok(await until(() => fs.existsSync(rec + '.cgroup') && fs.readFileSync(rec + '.cgroup', 'utf8').includes('::')), 'the server recorded its cgroup');
  const pid = Number(fs.readFileSync(rec + '.pid', 'utf8'));
  try {
    const cgroup = fs.readFileSync(rec + '.cgroup', 'utf8');
    assert.match(cgroup, /user@\d+\.service\/.*oak-herdr-server-\d+\.scope/, cgroup);
    assert.doesNotMatch(cgroup, /session-[^/]+\.scope/);
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    assert.equal(Number(stat[3]), pid, 'still its own session leader (setsid): no terminal hangup reaches it');
  } finally {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
});

test('server login scope inspection: only running daemons, Linux, and readable cgroups; a scope carries its name and logind\'s setting', () => {
  let probes = 0;
  const inspect = (cgroup, platform = 'linux', kill = true) => C.herdrServerLoginScope({
    platform, socket: '/run/ours.sock', readEnviron: () => 'HERDR_SOCKET_PATH=/run/ours.sock\0',
    listPids: () => [10, 20], readCmdline: pid => pid === 10 ? 'herdr\0server\0stop\0' : '/bin/herdr\0server\0',
    readCgroup: () => cgroup, killUserProcesses: () => { probes++; return kill; },
  });
  assert.deepEqual(inspect(SESSION), { state: 'scope', pid: 20, scope: 'session-7.scope', killUserProcesses: true });
  assert.deepEqual(inspect(SESSION, 'linux', false), { state: 'scope', pid: 20, scope: 'session-7.scope', killUserProcesses: false });
  assert.deepEqual(inspect(SESSION, 'linux', null), { state: 'scope', pid: 20, scope: 'session-7.scope', killUserProcesses: null });
  assert.equal(inspect(SESSION.trim() + '/child\n').scope, 'session-7.scope');
  probes = 0;
  assert.equal(inspect('0::/user.slice/user@1000.service/app.slice/oak.scope\n').state, 'clean');
  assert.equal(inspect(null).state, 'unknown');
  // Login scopes are logind's: off Linux there is nothing to inspect, which is not a failure to inspect.
  assert.deepEqual(inspect('', 'darwin'), { state: 'not-applicable' });
  assert.deepEqual(inspect('', 'win32'), { state: 'not-applicable' });
  assert.equal(probes, 0, "logind's setting is read only for a server inside a scope");
  assert.deepEqual(C.herdrServerLoginScope({ platform: 'linux', listPids: () => [10], readCmdline: () => 'herdr\0server\0reload-config' }), { state: 'absent' });
  // A server in a login scope that serves ANOTHER socket is not this user's herdr: the one on ours is reported.
  assert.deepEqual(C.herdrServerLoginScope({ platform: 'linux', socket: '/run/ours.sock', listPids: () => [15, 20],
    readCmdline: () => '/bin/herdr\0server\0', readEnviron: (pid) => `HERDR_SOCKET_PATH=/run/${pid === 15 ? 'other' : 'ours'}.sock\0`,
    readCgroup: (pid) => pid === 15 ? SESSION : '0::/user.slice/user@1000.service/app.slice/oak.scope\n', killUserProcesses: () => true }), { state: 'clean', pid: 20 });
});

test('herdr: login probing costs nothing for an already running server or a no-start ensure', POSIX, async () => {
  for (const [server, startServer] of [['running', true], ['not running', false]]) {
    const b = withPython(bed());
    writeExec(path.join(b.pathDir, 'herdr'), fakeHerdr({ log: b.log, server }));
    let probes = 0;
    await run(b, { startServer, loginSession: () => { probes++; return loginFacts(); } });
    assert.equal(probes, 0);
  }
});

test('server launch: a nested cgroup still belongs to its login scope', () => {
  assert.equal(C.planHerdrServerLaunch('/h/herdr', ['server'], loginFacts({ cgroup: SESSION.trim() + '/child\n' })).file, '/usr/bin/systemd-run');
});

test('login probe: nested scopes are recognized and synchronous probes use hard timeouts', t => {
  const spawn = require('../dist/spawn'), originalRead = fs.readFileSync, calls = [];
  t.mock.method(fs, 'readFileSync', (file, ...args) => file === '/proc/self/cgroup' ? SESSION.trim() + '/child\n' : originalRead(file, ...args));
  t.mock.method(fs, 'existsSync', file => String(file).startsWith('/var/lib/systemd/linger/'));
  t.mock.method(fs, 'accessSync', () => {});
  t.mock.method(fs, 'statSync', () => ({ isFile: () => true }));
  t.mock.method(spawn, 'spawnToolSync', (file, args, opts) => {
    calls.push({ file, args, opts });
    return { status: 0, stdout: file.endsWith('busctl') ? 'b true' : '', stderr: '' };
  });
  assert.ok(C.probeLoginSession({ PATH: '/fixture-tools' }, 'linux').systemdRun);
  assert.equal(calls.length, 2);
  for (const { opts } of calls) { assert.equal(opts.killSignal, 'SIGKILL'); assert.ok(opts.timeout > 0 && opts.timeout <= 10000); }
  for (const platform of ['darwin', 'win32']) assert.equal(C.probeLoginSession({}, platform).cgroup, null);
  assert.equal(calls.length, 2, 'other platforms probe nothing');
  // The doctor row reads logind's setting through the same probe: one bounded busctl call.
  assert.equal(C.probeKillUserProcesses({ PATH: '/fixture-tools' }, 'linux'), true);
  assert.deepEqual(calls.at(-1).args.slice(-2), ['org.freedesktop.login1.Manager', 'KillUserProcesses']);
  assert.equal(calls.at(-1).opts.killSignal, 'SIGKILL');
  assert.equal(C.probeKillUserProcesses({}, 'darwin'), null);
  assert.equal(calls.length, 3, 'off Linux the setting is not probed');
});
