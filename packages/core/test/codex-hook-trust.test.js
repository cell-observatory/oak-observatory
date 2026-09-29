const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { parse: parseToml } = require('smol-toml');
const { codexHookTrustHash, trustHerdrCodexHook } = require('../dist/codex-hook-trust');
const { ensureHerdr } = require('../dist/herdr-install');

const fixtures = path.join(__dirname, 'fixtures', 'codex-hook-trust');
const realHooks = JSON.parse(fs.readFileSync(path.join(fixtures, 'hooks.json'), 'utf8'));
const realStateText = fs.readFileSync(path.join(fixtures, 'hooks-state.toml'), 'utf8');
const realStates = parseToml(realStateText).hooks.state;
const command = { type: 'command', command: 'oak capture --agent codex #oak-observatory-hook' };
const group = (hook = command, matcher) => ({ matcher, hooks: [hook] });
const hash = (event, hook = command, matcher, platform = 'linux') => codexHookTrustHash(event, group(hook, matcher), 0, platform);
const POSIX = { skip: process.platform === 'win32' && 'fake herdr uses a POSIX executable wrapper' };

// These are byte copies of the user's real files, NOT hashes produced by the implementation under
// test. Keep every recorded hash in the assertion: changing normalization must pass all 12 events.
test('Codex trust: reproduces EVERY existing trusted_hash in the real config fixture byte-exact', () => {
  assert.equal(Object.keys(realStates).length, 12, 'all existing state entries are present');
  const covered = new Set();
  for (const [key, state] of Object.entries(realStates)) {
    assert.match(state.trusted_hash, /^sha256:[a-f0-9]{64}$/);
    const [, event, groupIndex, handlerIndex] = key.match(/:([a-z_]+):(\d+):(\d+)$/);
    const eventName = event.split('_').map(word => word[0].toUpperCase() + word.slice(1)).join('');
    assert.equal(codexHookTrustHash(event, realHooks.hooks[eventName][Number(groupIndex)], Number(handlerIndex), 'linux'), state.trusted_hash, key);
    covered.add(eventName);
  }
  assert.deepEqual([...covered].sort(), Object.keys(realHooks.hooks).sort());
});

test('Codex trust: normalizes timeouts, omitted fields, ignored matchers and default context limits', () => {
  assert.equal(hash('SessionStart'), hash('session_start', { ...command, timeout: 600, async: false, statusMessage: null, additionalContextLimit: 2500 }));
  assert.equal(hash('SessionEnd'), hash('SessionEnd', { ...command, timeout: 1 }));
  assert.equal(hash('Interrupt'), hash('Interrupt', { ...command, timeout: 0 }));
  assert.equal(hash('SessionEnd', { ...command, timeout: 100 }), hash('SessionEnd', { ...command, timeout: 3 }));
  assert.equal(hash('Interrupt', { ...command, timeout: 100 }), hash('Interrupt', { ...command, timeout: 3 }));
  assert.equal(hash('Stop'), hash('Stop', { ...command, additionalContextLimit: 42 }, 'ignored'));
  assert.equal(hash('UserPromptSubmit'), hash('UserPromptSubmit', command, 'ignored'));
  assert.equal(hash('Interrupt'), hash('Interrupt', command, 'ignored'));
  assert.equal(hash('PreToolUse', { ...command, timeout: 0 }), hash('PreToolUse', { ...command, timeout: 1 }));
});

test('Codex trust: hashes effective command, matcher, status, async and nondefault context limits', () => {
  for (const change of [{ command: 'different' }, { timeout: 10 }, { async: true }, { statusMessage: '' }, { additionalContextLimit: 0 }]) {
    assert.notEqual(hash('SessionStart'), hash('SessionStart', { ...command, ...change }), JSON.stringify(change));
  }
  assert.notEqual(hash('SessionStart'), hash('SessionStart', command, 'startup'));
  assert.notEqual(hash('SessionStart'), hash('SessionStart', command, ''));
  // SessionEnd runs synchronously but retains the configured async flag in its trust identity.
  assert.notEqual(hash('SessionEnd'), hash('SessionEnd', { ...command, async: true }));
  const windowsHook = { ...command, commandWindows: 'windows command' };
  assert.equal(hash('SessionStart', windowsHook), hash('SessionStart'));
  assert.equal(hash('SessionStart', windowsHook, undefined, 'win32'), hash('SessionStart', { ...command, command: 'windows command' }));
  assert.equal(hash('SessionStart', { ...command, command_windows: 'windows command' }, undefined, 'win32'), hash('SessionStart', windowsHook, undefined, 'win32'));
  assert.equal(codexHookTrustHash('SessionStart', { hooks: [{ ...command, command: 'sibling' }, command] }, 1, 'linux'), hash('SessionStart'));
});

test('Codex trust: refuses unsupported handlers/events and numbers that cannot be hashed exactly', () => {
  assert.throws(() => hash('FutureEvent'), /Unsupported/);
  assert.throws(() => hash('SessionStart', { type: 'prompt' }), /Only Codex command/);
  assert.throws(() => hash('SessionStart', { ...command, timeout: Number.MAX_SAFE_INTEGER + 1 }), /exactly representable/);
  assert.throws(() => hash('SessionStart', { ...command, timeout: -1 }), /unsigned/);
  assert.throws(() => hash('SessionStart', { ...command, async: 'false' }), /boolean/);
});

// The sandbox holds herdr's POSIX hook, so a direct trust call names 'linux': left to the host
// platform, a Windows run looks for herdr's PowerShell form and has nothing to trust.
function sandbox(t, { together = true, override = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-codex-hook-trust-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const codexDir = override ? path.join(base, 'Codex "profile" with a \' quote') : path.join(home, '.codex');
  const binDir = path.join(base, 'bin');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const herdrHook = { type: 'command', command: `bash '${path.join(codexDir, 'herdr-agent-state.sh').replace(/'/g, "'\\''")}' session`, timeout: 10 };
  const other = { ...herdrHook, command: `${herdrHook.command}; echo 'unrelated command'` };
  const hooks = { hooks: { SessionStart: together ? [{ hooks: [command, herdrHook, other] }] : [{ hooks: [command] }, { hooks: [herdrHook, other] }], Stop: [{ hooks: [herdrHook] }] } };
  const key = `${path.join(codexDir, 'hooks.json')}:session_start:${together ? '0:1' : '1:0'}`;
  const configFile = path.join(codexDir, 'config.toml');
  const original = `# existing settings stay byte-exact\r\nmodel = "test"\r\n${realStateText}\n[hooks.state.'unrelated']\nenabled = false\n\n[features]\nhooks = true\n# no final newline`;
  fs.writeFileSync(configFile, original, { mode: 0o600 });
  const payload = path.join(base, 'installed-hooks.json');
  fs.writeFileSync(payload, JSON.stringify(hooks));
  const log = path.join(base, 'argv.log');
  fs.writeFileSync(log, '');
  fs.copyFileSync(path.join(fixtures, 'fake-herdr.sh'), path.join(binDir, 'herdr'));
  fs.chmodSync(path.join(binDir, 'herdr'), 0o755);
  fs.writeFileSync(path.join(binDir, 'python3'), '#!/bin/sh\necho "Python 3.12"\n', { mode: 0o755 });
  const env = { PATH: binDir, HOME: home, OAK_TEST_ARGV: log, OAK_TEST_HOOKS: payload, ...(override ? { CODEX_HOME: codexDir } : {}) };
  const options = { home, env, platform: 'linux', arch: 'x64', configDir: path.join(base, 'herdr'), integrations: ['codex'], pluginDir: null, startServer: false, download: async () => { throw new Error('unexpected download'); } };
  return { base, home, codexDir, configFile, original, hooks, key, env, options, log, payload };
}

function backups(b) {
  return fs.readdirSync(b.codexDir).filter(name => name.startsWith('config.toml.oak-hook-trust-'));
}

test('Codex trust regression: matches herdr Windows PowerShell hook and effective command overrides', t => {
  const b = sandbox(t);
  const script = path.join(b.codexDir, 'herdr-agent-state.ps1');
  const command = `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" session`;
  const hooks = { hooks: { SessionStart: [
    { hooks: [{ type: 'command', command, timeout: 10 }] },
    { hooks: [{ type: 'command', command: 'bash unrelated.sh', commandWindows: command, timeout: 10 }] },
    { hooks: [{ type: 'command', command: 'bash unrelated.sh', command_windows: command, timeout: 10 }] },
    { hooks: [{ type: 'command', command: command + ' unexpected', timeout: 10 }] },
  ] } };
  fs.writeFileSync(path.join(b.codexDir, 'hooks.json'), JSON.stringify(hooks));
  assert.equal(trustHerdrCodexHook(b.codexDir, 'win32'), 3);
  const states = parseToml(fs.readFileSync(b.configFile, 'utf8')).hooks.state;
  for (let i = 0; i < 3; i++) {
    const key = `${path.join(b.codexDir, 'hooks.json')}:session_start:${i}:0`;
    assert.equal(states[key].trusted_hash, codexHookTrustHash('SessionStart', hooks.hooks.SessionStart[i], 0, 'win32'));
  }
  assert.equal(states[`${path.join(b.codexDir, 'hooks.json')}:session_start:3:0`], undefined);
  assert.equal(trustHerdrCodexHook(b.codexDir, 'win32'), 0);
});

for (const together of [true, false]) {
  test(`Codex trust: ensureHerdr installs then backs up and appends only herdr at ${together ? '0:1' : '1:0'}`, POSIX, async t => {
    const b = sandbox(t, { together, override: !together });
    assert.equal(fs.existsSync(path.join(b.codexDir, 'hooks.json')), false, 'hook arrives only after fake herdr installation');
    const report = await ensureHerdr(b.options);
    assert.equal(report.integrations.codex, 'installed');
    assert.deepEqual(report.warnings, []);
    const result = fs.readFileSync(b.configFile, 'utf8');
    assert.ok(result.startsWith(b.original), 'append-only; every original byte survives');
    const states = parseToml(result).hooks.state;
    const expected = { ...realStates, unrelated: { enabled: false }, [b.key]: { trusted_hash: codexHookTrustHash('SessionStart', b.hooks.hooks.SessionStart[together ? 0 : 1], together ? 1 : 0, 'linux') } };
    assert.deepEqual(states, expected, 'no other hook, event or substring-matching command is trusted');
    assert.equal(backups(b).length, 1);
    assert.equal(fs.readFileSync(path.join(b.codexDir, backups(b)[0]), 'utf8'), b.original);
    assert.equal(fs.statSync(path.join(b.codexDir, backups(b)[0])).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(b.codexDir, 'hooks.json'), 'utf8'), fs.readFileSync(b.payload, 'utf8'));
    if (!together) assert.equal(fs.existsSync(path.join(b.home, '.codex', 'config.toml')), false, 'CODEX_HOME is honored');

    b.env.OAK_TEST_CURRENT = 'yes';
    const beforeStat = fs.statSync(b.configFile);
    const again = await ensureHerdr(b.options);
    assert.equal(again.integrations.codex, 'current');
    assert.equal(fs.readFileSync(b.configFile, 'utf8'), result);
    assert.equal(fs.statSync(b.configFile).mtimeMs, beforeStat.mtimeMs, 'repeat call does not rewrite config');
    assert.equal(backups(b).length, 1, 'repeat call does not make a new backup');
    assert.equal(fs.readFileSync(b.log, 'utf8').split('\n').filter(line => line === 'integration install codex').length, 1);
  });
}

test('Codex trust: repairs missing trust when herdr integration is already current', POSIX, async t => {
  const b = sandbox(t);
  fs.copyFileSync(b.payload, path.join(b.codexDir, 'hooks.json'));
  b.env.OAK_TEST_CURRENT = 'yes';
  const report = await ensureHerdr(b.options);
  assert.equal(report.integrations.codex, 'current');
  assert.deepEqual(report.warnings, []);
  assert.match(parseToml(fs.readFileSync(b.configFile, 'utf8')).hooks.state[b.key].trusted_hash, /^sha256:/);
  assert.ok(!fs.readFileSync(b.log, 'utf8').includes('integration install codex'));
});

test('Codex trust: preserves existing disabled or stale states in any valid TOML spelling', async t => {
  for (const state of ['enabled = false', 'trusted_hash = "sha256:previous"', 'enabled = false, trusted_hash = "sha256:previous"']) {
    const b = sandbox(t);
    fs.copyFileSync(b.payload, path.join(b.codexDir, 'hooks.json'));
    const original = `# alternate TOML syntax\n[hooks.state]\n'${b.key}' = { ${state} }\n`;
    fs.writeFileSync(b.configFile, original);
    assert.equal(trustHerdrCodexHook(b.codexDir, 'linux'), 0);
    assert.equal(fs.readFileSync(b.configFile, 'utf8'), original);
    assert.deepEqual(backups(b), []);
  }
});

test('Codex trust: failed integrations are never trusted', POSIX, async t => {
  const b = sandbox(t);
  fs.copyFileSync(b.payload, path.join(b.codexDir, 'hooks.json'));
  b.env.OAK_TEST_FAIL = 'yes';
  const report = await ensureHerdr(b.options);
  assert.equal(report.integrations.codex, 'failed');
  assert.equal(fs.readFileSync(b.configFile, 'utf8'), b.original);
  assert.deepEqual(backups(b), []);
});

test('Codex trust: malformed config is preserved and reported as an installer warning', POSIX, async t => {
  const b = sandbox(t);
  const original = '# broken\n[hooks.state';
  fs.writeFileSync(b.configFile, original);
  const report = await ensureHerdr(b.options);
  assert.equal(report.integrations.codex, 'installed');
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /could not trust herdr's Codex hook/);
  assert.equal(fs.readFileSync(b.configFile, 'utf8'), original);
  assert.deepEqual(backups(b), []);
});

test('Codex trust: creates a private config if absent, and does nothing if hooks are absent', t => {
  const b = sandbox(t);
  assert.equal(trustHerdrCodexHook(b.codexDir, 'linux'), 0);
  assert.equal(fs.readFileSync(b.configFile, 'utf8'), b.original);
  fs.unlinkSync(b.configFile);
  fs.copyFileSync(b.payload, path.join(b.codexDir, 'hooks.json'));
  assert.equal(trustHerdrCodexHook(b.codexDir, 'linux'), 1);
  assert.deepEqual(Object.keys(parseToml(fs.readFileSync(b.configFile, 'utf8')).hooks.state), [b.key]);
  if (process.platform !== 'win32') assert.equal(fs.statSync(b.configFile).mode & 0o777, 0o600);
  assert.deepEqual(backups(b), []);
});

test('Codex trust: backup must succeed before any config bytes are appended', t => {
  const b = sandbox(t);
  fs.copyFileSync(b.payload, path.join(b.codexDir, 'hooks.json'));
  t.mock.method(fs, 'copyFileSync', () => { throw new Error('backup refused'); });
  assert.throws(() => trustHerdrCodexHook(b.codexDir, 'linux'), /backup refused/);
  assert.equal(fs.readFileSync(b.configFile, 'utf8'), b.original);
});

// Two real OAK processes repairing the same Codex config both passed the reread
// check and both appended the same `[hooks.state.…]` table, leaving a config smol-toml refuses. The
// barrier parks whichever process reaches the backup first, so the window is as wide as it can be;
// with the exclusive section the second process cannot even enter it, which is what `reached` shows.
test('Codex trust: concurrent repairs are serialized, never publishing the same table twice', POSIX, async t => {
  const b = sandbox(t);
  fs.copyFileSync(b.payload, path.join(b.codexDir, 'hooks.json'));
  const module = require.resolve('../dist/codex-hook-trust');
  const childFile = path.join(b.base, 'race-child.cjs');
  fs.writeFileSync(childFile, `const fs = require('node:fs'), path = require('node:path');
const [, , modulePath, dir, id] = process.argv;
const copy = fs.copyFileSync;
fs.copyFileSync = function (...args) {
  const out = copy.apply(this, args);
  fs.writeFileSync(path.join(dir, 'ready-' + id), '');
  const end = Date.now() + 5000;
  while (!fs.existsSync(path.join(dir, 'release'))) {
    if (Date.now() > end) throw new Error('barrier timed out');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  return out;
};
process.stdout.write(String(require(modulePath).trustHerdrCodexHook(dir)));
`);
  const ready = id => fs.existsSync(path.join(b.codexDir, 'ready-' + id));
  const children = ['a', 'b'].map(id => new Promise((resolve, reject) => {
    const out = path.join(b.base, id + '.log'), fd = fs.openSync(out, 'w');
    const child = cp.spawn(process.execPath, [childFile, module, b.codexDir, id], { stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    child.on('error', reject);
    child.on('close', code => resolve({ id, code, output: fs.readFileSync(out, 'utf8').trim() }));
  }));
  const deadline = Date.now() + 1500;
  while (!(ready('a') && ready('b')) && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
  const reached = ['a', 'b'].filter(ready);
  fs.writeFileSync(path.join(b.codexDir, 'release'), '');
  const results = await Promise.all(children);
  t.diagnostic(JSON.stringify({ insideTheBackupWindow: reached, results }));
  assert.equal(reached.length, 1, 'only one repair may hold the backup-to-publication window');
  assert.deepEqual(results.map(r => r.code), [0, 0], results.map(r => r.output).join(' | '));
  assert.deepEqual(results.map(r => r.output).sort(), ['0', '1'], 'exactly one repair adds the entry');
  const after = fs.readFileSync(b.configFile, 'utf8');
  assert.ok(after.startsWith(b.original), 'append-only; every original byte survives');
  const states = parseToml(after).hooks.state; // throws on the duplicated table this test exists for
  assert.deepEqual(states[b.key], { trusted_hash: codexHookTrustHash('SessionStart', b.hooks.hooks.SessionStart[0], 1, 'linux') });
  assert.equal((after.match(/\[hooks\.state\./g) || []).length, Object.keys(states).length, 'one table per entry');
  assert.equal(backups(b).length, 1, 'the repair that did nothing takes no backup');
  assert.deepEqual(fs.readdirSync(b.codexDir).filter(n => n.endsWith('.lock') || n.endsWith('.tmp')), [], 'no lock or temp file survives');
});

// The refusal used to be evaluated BEFORE the backup, so a writer landing during the backup was
// appended to anyway. Publication is now a whole-candidate rename guarded by a reread that covers it.
test('Codex trust: a config that changes during the backup is refused, not appended to', t => {
  const b = sandbox(t);
  fs.copyFileSync(b.payload, path.join(b.codexDir, 'hooks.json'));
  const copy = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (...args) => {
    const out = copy.apply(fs, args);
    fs.appendFileSync(b.configFile, "\n[hooks.state.'concurrent-writer']\nenabled = false\n");
    return out;
  });
  assert.throws(() => trustHerdrCodexHook(b.codexDir, 'linux'), /Codex configuration changed/);
  const after = fs.readFileSync(b.configFile, 'utf8');
  assert.equal(after, b.original + "\n[hooks.state.'concurrent-writer']\nenabled = false\n", 'the other writer keeps the file');
  assert.equal(parseToml(after).hooks.state[b.key], undefined, 'no entry is published over a changed config');
  assert.equal(backups(b).length, 1, 'the backup that was taken is kept');
  assert.deepEqual(fs.readdirSync(b.codexDir).filter(n => n.endsWith('.lock') || n.endsWith('.tmp')), []);
});

test('Codex trust: a lock left by a dead repair is reclaimed instead of blocking forever', t => {
  const b = sandbox(t);
  fs.copyFileSync(b.payload, path.join(b.codexDir, 'hooks.json'));
  const lock = b.configFile + '.oak-hook-trust.lock';
  fs.writeFileSync(lock, '');
  const stale = Date.now() - 60_000;
  fs.utimesSync(lock, stale / 1000, stale / 1000);
  assert.equal(trustHerdrCodexHook(b.codexDir, 'linux'), 1, 'an abandoned lock is reclaimed by age');
  assert.equal(fs.existsSync(lock), false);
  assert.match(parseToml(fs.readFileSync(b.configFile, 'utf8')).hooks.state[b.key].trusted_hash, /^sha256:/);
});
