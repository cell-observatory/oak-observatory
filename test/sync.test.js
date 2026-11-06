// `oak sync` across throwaway machines: linux-a and linux-b (both Linux homes of one user), a Mac-like machine whose
// clones live elsewhere, and a lab machine that runs under a shared account. ssh and herdr are
// test/fixtures/machine-exec-stub.sh; each machine's `oak` runs this build in its own home, with
// test/fixtures/sync-machine.cjs standing in for its account and mount table. Any machine can run `oak sync` and reach
// the others, as the real ones do.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'packages/cli/dist/index.js');
const preload = path.join(__dirname, 'fixtures/sync-machine.cjs');
const POSIX = process.platform === 'win32' && 'the fake ssh is a POSIX script';
const DAY = 86_400_000;
const me = os.userInfo().username;
const MACHINES = ['linux-a', 'linux-b', 'mac', 'lab'];
/** A real terminal for what OAK asks on one (a key typed at its prompt), where node-pty is built. */
let ptyMod = null;
try { ptyMod = require('node-pty'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

/** Claude Code's folder name for a working directory, as its documentation states it: every character that is not a
 *  letter or digit becomes `-`. Written out here rather than taken from OAK, so the plan's mapping is checked against
 *  the rule and not against itself; the fixture paths stay under the 200 characters past which Claude Code shortens. */
function claudeFolder(cwd) {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  assert.ok(name.length <= 200, `fixture path too long for the plain rule: ${cwd}`);
  return name;
}

const write = (file, text, mtime) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtime) fs.utimesSync(file, new Date(mtime), new Date(mtime));
};
const line = (o) => JSON.stringify(o) + '\n';
/** A time as relTime prints it: the clock today, or the day and the clock when a run and the print fall on two days. */
const CLOCK = String.raw`(?:\d\d:\d\d:\d\d|[A-Z][a-z]{2} \d{1,2} \d\d:\d\d)`;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A transcript whose first record carries no working directory (as Claude Code's often do) and whose second does. */
function transcript(home, cwd, id, extra = '', mtime) {
  const file = path.join(home, '.claude', 'projects', claudeFolder(cwd), `${id}.jsonl`);
  write(file, line({ type: 'queue-operation', operation: 'enqueue' }) + line({ type: 'user', cwd, sessionId: id, message: { role: 'user', content: 'hello' } }) + extra, mtime);
  return file;
}

/** A session that asked and was answered (its usage with it), in the folder Claude Code names after `cwd`, written ten
 *  minutes ago: a session the listings title by its ask. */
function conversation(home, cwd, id, ask) {
  const at = new Date(Date.now() - 10 * 60_000).toISOString();
  const file = path.join(home, '.claude', 'projects', claudeFolder(cwd), `${id}.jsonl`);
  write(file, line({ type: 'user', cwd, sessionId: id, timestamp: at, message: { role: 'user', content: ask } }) +
    line({ type: 'assistant', cwd, sessionId: id, timestamp: at, message: { id: `msg-${id}`, role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 10, output_tokens: 5 } } }));
  idle(path.dirname(file));
  return file;
}

function gitRepo(dir, origin) {
  fs.mkdirSync(dir, { recursive: true });
  cp.execFileSync('git', ['init', '-q', dir]);
  cp.execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
}

/** Every file, folder and link under `dir`: content hash, size, mode and modification time, so a write, a new file
 *  or a file created and removed again (which moves its folder's time) shows. Access times are left out, and so is each
 *  home's cache folder (world() makes it), where the `oak` launcher keeps Node's compile cache of OAK's code. */
function snapshot(dir) {
  const out = new Map();
  const walk = (d, rel) => {
    for (const name of fs.readdirSync(d).sort()) {
      const abs = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (/^homes\/[^/]+\/\.cache$/.test(r)) continue;
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) out.set(r, `link ${fs.readlinkSync(abs)}`);
      else if (st.isDirectory()) {
        out.set(r, `dir ${st.mode} ${st.mtimeMs}`);
        walk(abs, r);
      } else out.set(r, `file ${st.mode} ${st.size} ${st.mtimeMs} ${sha(fs.readFileSync(abs))}`);
    }
  };
  walk(dir, '');
  return out;
}
function diffSnapshots(a, b) {
  const changed = [];
  for (const [k, v] of a) if (b.get(k) !== v) changed.push(`${k}: ${v} -> ${b.get(k) ?? 'gone'}`);
  for (const k of b.keys()) if (!a.has(k)) changed.push(`${k}: new`);
  return changed;
}
const changedPaths = (a, b) => diffSnapshots(a, b).map((l) => l.replace(/: .*/, ''));

/**
 * The world: `base/world` holds every machine's home (`homes/<machine>`) and the two mounts of one network share
 * (snapshotted whole); `base/io` holds the logs and command output, outside it.
 */
function world(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const W = path.join(base, 'world');
  const io = path.join(base, 'io');
  fs.mkdirSync(io, { recursive: true });
  const bin = path.join(io, 'bin');
  fs.mkdirSync(bin);
  const stub = fs.readFileSync(path.join(__dirname, 'fixtures/machine-exec-stub.sh'));
  for (const name of ['ssh', 'herdr']) fs.writeFileSync(path.join(bin, name), stub, { mode: 0o755 });
  const homes = Object.fromEntries(MACHINES.map((m) => [m, path.join(W, 'homes', m)]));
  const mountsA = path.join(W, 'mnt-a', 'groups', 'labshare');
  const mountsM = path.join(W, 'mnt-m', 'Volumes', 'labshare');
  const tables = {
    'linux-a': `//fs1.example.org/labshare ${mountsA} cifs rw,relatime 0 0\nsysfs /sys sysfs rw 0 0\n`,
    'linux-b': '',
    mac: `//u@FS1.example.org/labshare ${mountsM} cifs rw 0 0\n`,
    lab: '',
  };
  const machineEnv = (machine) => ({
    OAK_TEST_MOUNTS_FILE: path.join(io, `mounts-${machine}`),
    OAK_TEST_ACCESS_LOG: path.join(io, `access-${machine}.log`),
    ...(machine === 'lab' ? { OAK_TEST_USER: 'lab-shared' } : {}),
  });
  const target = (m) => (m === 'lab' ? 'lab@lab' : `u@${m}`);
  /** The `oak` a machine's ssh runs: this build, under the machine's account and mount table, and `extra` preloads. */
  function oakWrapper(machine, extra = []) {
    const vars = Object.entries(machineEnv(machine)).map(([k, v]) => `${k}='${v}'`).join(' ');
    const loads = [preload, ...extra].map((p) => `--require "${p}"`).join(' ');
    write(path.join(homes[machine], '.local', 'bin', 'oak'), `#!/bin/sh\n${vars} exec "${process.execPath}" ${loads} "${cli}" "$@"\n`);
    fs.chmodSync(path.join(homes[machine], '.local', 'bin', 'oak'), 0o755);
  }
  for (const machine of MACHINES) {
    // With its cache folder, as a home has one: Node's compile cache of OAK's code, made there by the first `oak` run.
    fs.mkdirSync(path.join(homes[machine], '.cache'), { recursive: true });
    fs.writeFileSync(path.join(io, `mounts-${machine}`), tables[machine]);
    oakWrapper(machine);
  }
  const envFor = (machine, extraEnv = {}) => {
    const home = homes[machine];
    const env = {
      ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', XDG_CONFIG_HOME: path.join(home, '.config'),
      PATH: bin + path.delimiter + process.env.PATH, OAK_MACHINE_LABEL: machine,
      FAKE_REMOTE_ROOT: path.join(W, 'homes'), MACHINE_EXEC_LOG: path.join(io, 'machine-exec.log'),
      MACHINE_EXEC_MACHINES: JSON.stringify(MACHINES.filter((m) => m !== machine).map((m, i) => ({ id: `m${i}`, label: m, target: target(m), session: 'default', enabled: true, selected: false }))),
      ...machineEnv(machine), ...extraEnv,
    };
    delete env.HERDR_PANE_ID;
    return env;
  };
  let n = 0;
  /** Run this build as `machine` (its home, its saved machines: every other one), and wait for it. */
  const runAs = (machine, args, extraEnv = {}, opts = {}) => {
    const k = n++;
    const out = path.join(io, `stdout-${k}`), err = path.join(io, `stderr-${k}`);
    const o = fs.openSync(out, 'w'), e = fs.openSync(err, 'w');
    let r;
    try {
      r = cp.spawnSync(process.execPath, [...(opts.node ?? []), '--require', preload, cli, ...args],
        { cwd: opts.cwd ?? io, env: envFor(machine, extraEnv), timeout: 90000, stdio: [opts.input === undefined ? 'ignore' : 'pipe', o, e], input: opts.input });
    } finally { fs.closeSync(o); fs.closeSync(e); }
    assert.equal(r.error, undefined);
    return { status: r.status, signal: r.signal, stdout: fs.readFileSync(out, 'utf8'), stderr: fs.readFileSync(err, 'utf8') };
  };
  /** Start this build as `machine` without waiting: for runs that overlap. */
  const startAs = (machine, args, extraEnv = {}, opts = {}) => {
    const k = n++;
    const out = path.join(io, `stdout-${k}`), err = path.join(io, `stderr-${k}`);
    const o = fs.openSync(out, 'w'), e = fs.openSync(err, 'w');
    const child = cp.spawn(process.execPath, [...(opts.node ?? []), '--require', preload, cli, ...args], { cwd: io, env: envFor(machine, extraEnv), stdio: ['ignore', o, e] });
    fs.closeSync(o); fs.closeSync(e);
    return new Promise((resolve) => child.on('close', (status, signal) => resolve({ status, signal, stdout: fs.readFileSync(out, 'utf8'), stderr: fs.readFileSync(err, 'utf8') })));
  };
  const json = (machine, args, extraEnv) => {
    const r = runAs(machine, [...args, '--json'], extraEnv);
    assert.equal(r.status, 0, `${machine} ${args.join(' ')}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  /** The paths a machine's oak touched, and with `calls`, each with the call that touched it (`readdirSync /x`). */
  const access = (machine, calls = false) => {
    const f = path.join(io, `access-${machine}.log`);
    const lines = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
    return calls ? lines.map((l) => [l.slice(0, l.indexOf(' ')), l.slice(l.indexOf(' ') + 1)]) : lines.map((l) => l.slice(l.indexOf(' ') + 1));
  };
  const clearAccess = () => { for (const m of MACHINES) fs.rmSync(path.join(io, `access-${m}.log`), { force: true }); };
  const sshCalls = () => {
    const log = path.join(io, 'machine-exec.log');
    const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    return text.split(/^ssh\n/m).slice(1).map((s) => s.slice(0, s.indexOf('\n.\n')).split('\n'));
  };
  const clearSsh = () => fs.rmSync(path.join(io, 'machine-exec.log'), { force: true });
  /** A machine's prefs.json `sync`, set as `oak sync …` would set it. */
  const syncPrefs = (machine, sync) => write(path.join(homes[machine], '.claude', 'claude-observatory', 'prefs.json'), JSON.stringify({ sync }));
  const store = (machine, ...p) => path.join(homes[machine], '.claude', 'claude-observatory', 'sync', ...p);
  return { base, W, io, homes, mountsA, mountsM, runAs, startAs, json, run: (args, env, opts) => runAs('linux-a', args, env, opts), access, clearAccess, sshCalls, clearSsh, syncPrefs, store, oakWrapper, envFor };
}

/** The three machines' Claude Code and Codex state, and a lab machine's that must never be read. */
function seed(w, now = Date.now()) {
  const { homes, mountsA, mountsM } = w;
  const A = homes['linux-a'], B = homes['linux-b'], M = homes.mac, L = homes.lab;
  // One repository: at ~/Github/app on both Linux machines, at ~/src/app on the Mac, all with one origin.
  gitRepo(path.join(A, 'Github', 'app'), 'git@github.com:Org/App.git');
  gitRepo(path.join(B, 'Github', 'app'), 'ssh://git@github.com:22/Org/App');
  gitRepo(path.join(M, 'src', 'app'), 'https://user:secret-token@GitHub.com/Org/App.git');
  gitRepo(path.join(M, 'src', 'other'), 'git@github.com:Org/Other.git'); // cloned on the Mac alone
  for (const d of [path.join(A, 'notes'), path.join(M, 'notes'), path.join(mountsA, 'u', 'proj'), path.join(mountsM, 'u', 'proj')]) fs.mkdirSync(d, { recursive: true });
  const appA = path.join(A, 'Github', 'app'), appB = path.join(B, 'Github', 'app'), appM = path.join(M, 'src', 'app');
  // linux-a: a session in the repository, which linux-b continued; a home session; a session on the share. Its
  // settings set no cleanupPeriodDays: Claude Code's 30 days apply there.
  const extra = line({ type: 'assistant', message: { role: 'assistant', content: 'more' } });
  transcript(A, appA, ID(1));
  write(path.join(A, '.claude', 'projects', claudeFolder(appA), ID(1), 'subagents', 'agent-x.jsonl'), line({ a: 1 }));
  write(path.join(A, '.claude', 'projects', claudeFolder(appA), 'memory', 'MEMORY.md'), '# app\n- one\n');
  transcript(A, path.join(A, 'notes'), ID(2));
  transcript(A, path.join(mountsA, 'u', 'proj'), ID(3));
  write(path.join(A, '.claude', 'plans', 'shared-plan.md'), 'plan\n');
  write(path.join(A, '.claude', 'settings.json'), JSON.stringify({ env: { SECRET: 'SENTINEL-SETTINGS-A' } }));
  // linux-b: the same session, longer; a new session; an old one; a different memory; one plan the same, one new.
  write(path.join(B, '.claude', 'projects', claudeFolder(appB), `${ID(1)}.jsonl`),
    line({ type: 'queue-operation', operation: 'enqueue' }) + line({ type: 'user', cwd: appA, sessionId: ID(1), message: { role: 'user', content: 'hello' } }) + extra);
  transcript(B, appB, ID(4));
  transcript(B, appB, ID(5), '', now - 100 * DAY);
  write(path.join(B, '.claude', 'projects', claudeFolder(appB), 'memory', 'MEMORY.md'), '# app\n- one\n- two\n');
  write(path.join(B, '.claude', 'plans', 'shared-plan.md'), 'plan\n');
  write(path.join(B, '.claude', 'plans', 'b-plan.md'), 'b\n');
  write(path.join(B, '.claude', 'skills', 'review', 'SKILL.md'), '---\nname: review\n---\n');
  write(path.join(B, '.claude', 'skills', 'synced', 'from-claude-ai', 'SKILL.md'), 'synced\n'); // Claude Code's own to manage
  write(path.join(B, '.claude', 'settings.json'), JSON.stringify({ cleanupPeriodDays: 3650 }));
  // The Mac: its clone elsewhere, its home and share sessions, a repository nobody else has, a Codex rollout.
  transcript(M, appM, ID(6));
  transcript(M, path.join(M, 'notes'), ID(7));
  transcript(M, path.join(mountsM, 'u', 'proj'), ID(8));
  transcript(M, path.join(M, 'src', 'other'), ID(9));
  write(path.join(M, '.codex', 'sessions', '2026', '10', '29', 'rollout-2026-10-29T10-00-00-00000000-0000-7000-8000-000000000010.jsonl'),
    line({ type: 'session_meta', payload: { id: '00000000-0000-7000-8000-000000000010', cwd: appM } }));
  write(path.join(M, '.codex', 'memories_1.sqlite'), 'SQLite format 3\0');
  write(path.join(M, '.claude', 'settings.json'), JSON.stringify({ cleanupPeriodDays: 3650 }));
  // Files sync never reads, with sentinels, on every machine.
  for (const h of [A, B, M, L]) {
    const claude = path.join(h, '.claude');
    write(path.join(h, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'SENTINEL-ACCOUNT' } }));
    write(path.join(claude, '.credentials.json'), 'SENTINEL-CREDENTIALS');
    write(path.join(claude, 'settings.local.json'), JSON.stringify({ env: { X: 'SENTINEL-LOCAL' } }));
    write(path.join(claude, 'sessions', '4242.json'), 'SENTINEL-PID');
    write(path.join(claude, 'shell-snapshots', 'snapshot-zsh.sh'), 'SENTINEL-SNAPSHOT');
    write(path.join(h, '.codex', 'auth.json'), 'SENTINEL-AUTH');
    write(path.join(h, '.codex', 'config.toml'), 'model = "SENTINEL-CONFIG"');
    write(path.join(h, '.codex', 'logs_1.sqlite'), 'SENTINEL-LOGS');
    write(path.join(h, '.codex', 'queue_1.sqlite'), 'SENTINEL-QUEUE');
  }
  // Symlinks that would lead a walk into what sync never reads: the config directory and the ssh keys through
  // skills, a credential through a plan.
  write(path.join(B, '.ssh', 'id_ed25519'), 'SENTINEL-SSH-KEY');
  fs.symlinkSync(path.join(B, '.claude'), path.join(B, '.claude', 'skills', 'config-link'));
  fs.symlinkSync(path.join(B, '.ssh'), path.join(B, '.claude', 'skills', 'keys'));
  fs.symlinkSync(path.join(B, '.claude', '.credentials.json'), path.join(B, '.claude', 'plans', 'creds.md'));
  // linux-a keeps its ~/.ssh in a dotfiles folder, as a dotfiles setup links it, and a skill links to ~/.ssh: the walk
  // must refuse where ~/.ssh leads, not only ~/.ssh by name.
  write(path.join(A, 'dotfiles', 'ssh', 'id_ed25519'), 'SENTINEL-SSH-DOTFILES');
  fs.symlinkSync(path.join(A, 'dotfiles', 'ssh'), path.join(A, '.ssh'));
  fs.mkdirSync(path.join(A, '.claude', 'skills'), { recursive: true });
  fs.symlinkSync(path.join(A, '.ssh'), path.join(A, '.claude', 'skills', 'keys'));
  // The lab machine's own sessions, which its other users' sessions sit beside.
  transcript(L, path.join(L, 'lab-work'), ID(11));
  write(path.join(L, '.claude', 'plans', 'lab.md'), 'SENTINEL-LAB-PLAN\n');
  for (const h of [A, B, M, L]) for (const d of [path.join(h, '.claude', 'projects'), path.join(h, '.codex', 'sessions')]) idle(d, now);
  return { A, B, M, L, appA, appB, appM };
}

/** Date each file below `dir` written in the last minute ten minutes back, as a session not running now leaves it: a
 *  run lands no tail on a transcript written here in the last minute (a session running on this machine), so a test
 *  that wants one running writes it then. */
function idle(dir, now = Date.now()) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) idle(abs, now);
    else if (e.isFile() && fs.statSync(abs).mtimeMs > now - 60_000) fs.utimesSync(abs, new Date(now - 10 * 60_000), new Date(now - 10 * 60_000));
  }
}

const never = ['.claude.json', '.credentials.json', 'settings.local.json', '4242.json', 'shell-snapshots', 'auth.json', 'config.toml', 'logs_1.sqlite', 'queue_1.sqlite', 'id_ed25519'];

/** What sync never reads on `machine`, by real path. */
function forbiddenOn(w, machine) {
  const home = w.homes[machine];
  return [
    path.join(home, '.claude.json'), path.join(home, '.ssh'), (() => { try { return fs.realpathSync(path.join(home, '.ssh')); } catch { return path.join(home, '.ssh'); } })(),
    ...['.credentials.json', 'settings.local.json', 'sessions', 'shell-snapshots'].map((n) => path.join(home, '.claude', n)),
    ...['auth.json', 'config.toml', 'logs_1.sqlite', 'queue_1.sqlite'].map((n) => path.join(home, '.codex', n)),
  ];
}

/** The paths `machine` touched of what sync never reads. Compared by real path: a walk that followed a link reached
 *  them under the link's name. Resolving a link to see where it leads is how a walk refuses one, and reads nothing
 *  there; any other call on such a path does. */
function touchedNever(w, machine) {
  const forbidden = forbiddenOn(w, machine);
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  return w.access(machine, true).filter(([call]) => call !== 'realpathSync').map(([, p]) => real(p))
    .filter((p) => forbidden.some((f) => p === f || p.startsWith(f + path.sep)));
}

test('sync: each machine names its working directories by identity: one origin for three clones, the home, the share', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  const inv = (m) => w.json(m, ['__sync-inventory', '--user', me]);
  const a = inv('linux-a'), b = inv('linux-b'), m = inv('mac');
  const key = (i, cwd) => i.identities[cwd]?.key;
  assert.equal(key(a, s.appA), 'git:github.com/Org/App');
  assert.equal(key(b, s.appB), 'git:github.com/Org/App', 'ssh:// with a port is the same repository');
  assert.equal(key(m, s.appM), 'git:github.com/Org/App', 'https with credentials and .git is the same repository, its credentials gone');
  assert.equal(key(m, path.join(s.M, 'src', 'other')), 'git:github.com/Org/Other');
  assert.equal(key(a, path.join(s.A, 'notes')), 'home:notes');
  assert.equal(key(m, path.join(s.M, 'notes')), 'home:notes');
  assert.equal(key(a, path.join(w.mountsA, 'u', 'proj')), 'share:fs1.example.org/labshare/u/proj');
  assert.equal(key(m, path.join(w.mountsM, 'u', 'proj')), 'share:fs1.example.org/labshare/u/proj', 'the same share mounted elsewhere, its server named in another case and with a user');
  assert.ok(!JSON.stringify(m).includes('secret-token'), 'no credential from an origin URL reaches the inventory');
  // The folders it lists are Claude Code's, each with the directory its sessions started in.
  assert.deepEqual(a.projects.map((p) => p.folder).sort(), [claudeFolder(s.appA), claudeFolder(path.join(s.A, 'notes')), claudeFolder(path.join(w.mountsA, 'u', 'proj'))].sort());
  assert.ok(a.projects.every((p) => p.cwd && claudeFolder(p.cwd) === p.folder && p.own));
  assert.equal(a.cleanupPeriodDays, null);
  assert.equal(m.cleanupPeriodDays, 3650);
  assert.deepEqual(m.codexSqlite, ['memories_1.sqlite'], 'Codex databases are named, the log and queue databases not even that');
  assert.equal(m.families.rollouts[0].cwd, s.appM);
  assert.deepEqual(b.families.skills.map((f) => f.name), ['review/SKILL.md'], 'skills Claude Code syncs from claude.ai stay its own, and no link leads out');
  assert.deepEqual(b.families.plans.map((f) => f.name), ['b-plan.md', 'shared-plan.md'], 'a plan that links to a credential is not one');
  for (const i of [a, b, m]) assert.ok(!/SENTINEL/.test(JSON.stringify(i)), 'no inventory carries what sync never reads');
  assert.equal(b.families.memory[0].sha256, sha('# app\n- one\n- two\n'));
});

test('sync plan: by each machine\'s own settings: the backup plans every session, the others text and their own', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  w.syncPrefs('linux-a', { backup: { kind: 'machine', label: 'linux-a' } });
  const r = w.run(['sync', 'plan', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.deepEqual([plan.syncPlan, plan.dryRun], [1, true]);
  const by = Object.fromEntries(plan.machines.map((m) => [m.label, m]));
  assert.deepEqual(plan.machines.map((m) => [m.label, m.status]), [['linux-a', 'ok'], ['linux-b', 'ok'], ['mac', 'ok'], ['lab', 'shared']]);
  const here = by['linux-a'];
  assert.equal(here.backup, true, 'linux-a names itself the backup');
  const pull = (m, family, to) => m.pulls.find((p) => p.family === family && p.to === to);
  const fA = claudeFolder(s.appA);
  // The backup: linux-b's longer copy of the shared session (sizes only: its first bytes are checked as it is
  // pulled), its new session; the Mac's sessions, each in this machine's own folder for its identity.
  const longer = pull(here, 'transcripts', `${fA}/${ID(1)}.jsonl`);
  assert.deepEqual([longer.from, longer.action, longer.reason, longer.verify], ['linux-b', 'pull', 'longer', 'prefix']);
  assert.equal(longer.bytes, longer.size - longer.localSize);
  assert.equal(pull(here, 'transcripts', `${fA}/${ID(4)}.jsonl`)?.reason, 'missing');
  assert.equal(pull(here, 'transcripts', `${fA}/${ID(6)}.jsonl`)?.from, 'mac', 'the Mac\'s clone at ~/src/app lands in ~/Github/app\'s folder');
  assert.equal(pull(here, 'transcripts', `${claudeFolder(path.join(s.A, 'notes'))}/${ID(7)}.jsonl`)?.from, 'mac', 'home:notes lands in this home\'s notes folder');
  assert.equal(pull(here, 'transcripts', `${claudeFolder(path.join(w.mountsA, 'u', 'proj'))}/${ID(8)}.jsonl`)?.from, 'mac', 'the share session lands where the share is mounted here');
  assert.ok(pull(here, 'rollouts', 'sessions/2026/10/29/rollout-2026-10-29T10-00-00-00000000-0000-7000-8000-000000000010.jsonl'));
  // A repository with no checkout here lands under the Mac's own folder name, and says why and what resuming needs.
  const other = claudeFolder(path.join(s.M, 'src', 'other'));
  assert.equal(pull(here, 'transcripts', `${other}/${ID(9)}.jsonl`)?.unmapped, 'no checkout of its repository is known here');
  assert.deepEqual(here.unmapped.map((u) => [u.from, u.folder, u.key, u.lands, u.files]), [['mac', other, 'git:github.com/Org/Other', true, 1]]);
  // Its retention is Claude Code's 30 days, being unset: linux-b's 100-day-old session is skipped, and the plan says so.
  assert.deepEqual([here.retentionDays, here.retentionUnset], [30, true]);
  assert.equal(pull(here, 'transcripts', `${fA}/${ID(5)}.jsonl`), undefined);
  assert.deepEqual(here.skipped.retention, { files: 1, bytes: fs.statSync(path.join(s.B, '.claude', 'projects', claudeFolder(s.appB), `${ID(5)}.jsonl`)).size });
  assert.ok(here.warnings.some((x) => /cleanupPeriodDays is not set on linux-a/.test(x)));
  // Text is everywhere: memory to merge, a plan and a skill to copy; the same plan everywhere is not planned.
  assert.equal(pull(here, 'memory', `${fA}/memory/MEMORY.md`)?.action, 'merge');
  assert.equal(pull(here, 'plans', 'b-plan.md')?.action, 'copy');
  assert.equal(pull(here, 'plans', 'shared-plan.md'), undefined);
  assert.equal(pull(here, 'skills', 'review/SKILL.md')?.action, 'copy');
  assert.equal(here.pulls.filter((p) => p.family === 'skills').length, 1, 'skills/synced is never planned');
  // The Mac is not the backup: no other machine's session, only text, and an index of the rest.
  const mac = by.mac;
  assert.equal(mac.backup, false);
  assert.deepEqual(mac.pulls.filter((p) => ['transcripts', 'session-files', 'rollouts'].includes(p.family)), []);
  assert.ok(mac.skipped.placement.files >= 4, 'the others\' sessions are index only');
  assert.ok(pull(mac, 'plans', 'shared-plan.md') && pull(mac, 'skills', 'review/SKILL.md'));
  // linux-b holds linux-a's session too, but larger: never planned the other way, and named.
  assert.match(by['linux-b'].diverged.find((d) => d.to.endsWith(`${ID(1)}.jsonl`) && d.from === 'linux-a').note, /copy here is larger/);
  // linux-b keeps no other machine's session, so the share and the Mac-only repository it has no place for land nothing
  // there, and its plan names neither.
  assert.ok(by['linux-b'].skipped.placement.files >= 3, 'control: their sessions are index only on linux-b');
  assert.deepEqual(by['linux-b'].unmapped, [], 'no project is named for files that do not land');
  // Nothing anywhere names a file sync never touches.
  const all = JSON.stringify(plan);
  for (const n of never) assert.ok(!all.includes(n), `the plan names ${n}`);
  assert.ok(!/SENTINEL/.test(all));
  // Each saved machine was asked once, over OAK's own ssh, for its inventory alone.
  const calls = w.sshCalls();
  assert.deepEqual(calls.map((c) => c[c.length - 2]).sort(), ['lab@lab', 'u@linux-b', 'u@mac']);
  assert.deepEqual(calls[0].slice(0, 9), ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ControlMaster=no']);
  assert.equal(calls[0].at(-1), `env PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" CLAUDE_OBSERVATORY_NO_UPDATE_CHECK=1 oak __sync-inventory --json --user '${me}'`);
});

test('sync: a shared-account machine refuses inventory and fetch having read nothing, and no machine reads what sync never reads', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  w.syncPrefs('linux-a', { backup: { kind: 'machine', label: 'linux-a' } });
  w.clearAccess();
  assert.equal(w.run(['sync', 'plan', '--json']).status, 0);
  for (const machine of ['linux-a', 'linux-b', 'mac']) assert.deepEqual(touchedNever(w, machine), [], `a plan: ${machine} touched what sync never reads`);
  const now1 = w.run(['sync', 'now', '--json']);
  assert.equal(now1.status, 0, now1.stderr);
  assert.equal(JSON.parse(now1.stdout).machines.find((m) => m.label === 'lab').status, 'shared');
  // Asked to fetch directly, the lab machine answers that it is shared, and sends nothing.
  const asked = w.runAs('lab', ['__sync-fetch', '--user', me], {}, { input: JSON.stringify({ fetch: 1, items: [{ family: 'plans', name: 'lab.md' }] }) });
  assert.equal(asked.status, 0, asked.stderr);
  assert.equal(asked.stdout, '{"shared":true}\n');
  // Control: the instrument sees reads, here linux-b's of its own transcripts.
  assert.ok(w.access('linux-b').some((p) => p.startsWith(path.join(w.homes['linux-b'], '.claude', 'projects') + path.sep)), 'the access log records reads');
  // The lab machine touched nothing in its home but its oak, and the cache folder its launcher keeps Node's compile cache in.
  const lab = w.access('lab').filter((p) => p === w.homes.lab || p.startsWith(w.homes.lab + path.sep));
  const oakOwn = (p) => p.startsWith(path.join(w.homes.lab, '.local') + path.sep) || p === path.join(w.homes.lab, '.cache') || p.startsWith(path.join(w.homes.lab, '.cache') + path.sep);
  assert.deepEqual(lab.filter((p) => !oakOwn(p)), [], 'the shared machine read nothing of its own');
  assert.ok(w.access('lab').length > 0, 'its oak did run');
  // A run makes each machine it asks catch its local index up first (`__sync-inventory --publish`), which reads Claude
  // Code's account file to hash the account its usage is billed to, as every listing there does (machine-usage.ts
  // claudeAccountTag): that file alone, by the asked machines alone, and nothing of it is sent (no inventory carries a
  // sentinel). Nothing else sync never reads is touched, on any machine.
  for (const machine of ['linux-a', 'linux-b', 'mac']) {
    const account = path.join(w.homes[machine], '.claude.json');
    assert.deepEqual(touchedNever(w, machine).filter((p) => machine === 'linux-a' || p !== account), [], `${machine} touched what sync never reads`);
  }
  assert.ok(touchedNever(w, 'linux-b').includes(path.join(w.homes['linux-b'], '.claude.json')), 'control: the instrument sees the catch-up\'s read');
  const pulled = filesOf(w, 'linux-a', path.join('.claude', 'claude-observatory'));
  assert.ok(Object.keys(pulled).some((f) => f.startsWith('records/')), 'control: the record logs came over');
  for (const f of Object.keys(pulled)) assert.ok(!fs.readFileSync(path.join(w.homes['linux-a'], '.claude', 'claude-observatory', f)).includes('SENTINEL'), `${f} carries nothing sync never reads`);
  // Each link that leads there was seen, and refused.
  const resolved = w.access('linux-b', true).filter(([call]) => call === 'realpathSync').map(([, p]) => p);
  for (const link of ['skills/config-link', 'skills/keys', 'plans/creds.md']) assert.ok(resolved.includes(path.join(w.homes['linux-b'], '.claude', link)), `the walk saw ${link}`);
});

test('sync fetch command: refuses every name its family does not hold, and every path that leads to what sync never reads', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  const ask = (items) => {
    const r = w.runAs('linux-b', ['__sync-fetch', '--user', me], {}, { input: JSON.stringify({ fetch: 1, items }) });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split('\n').filter((l) => l.startsWith('{"i"')).map((l) => JSON.parse(l).status);
  };
  w.clearAccess();
  assert.deepEqual(ask([
    { family: 'plans', name: 'b-plan.md' },
    { family: 'plans', name: '../settings.json' },
    { family: 'plans', name: 'creds.md' }, // a link to .credentials.json
    { family: 'skills', name: 'config-link/settings.local.json' },
    { family: 'skills', name: 'keys/id_ed25519' },
    { family: 'transcripts', name: '../../.claude.json' },
    { family: 'rollouts', name: 'auth.json' },
    { family: 'nonesuch', name: 'x' },
    { family: 'plans', name: 'missing.md' },
  ]), ['whole', 'refused', 'refused', 'refused', 'refused', 'refused', 'refused', 'refused', 'missing']);
  assert.deepEqual(touchedNever(w, 'linux-b'), [], 'and read none of them');
});

test('sync plan: read-only, byte for byte, on every machine; a build that writes is caught', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  w.syncPrefs('linux-a', { backup: { kind: 'machine', label: 'linux-a' } });
  const before = snapshot(w.W);
  assert.equal(w.run(['sync', 'plan', '--json']).status, 0);
  assert.equal(w.run(['sync', 'plan']).status, 0);
  assert.equal(w.runAs('mac', ['sync', 'plan', '--machine', 'linux-b']).status, 0);
  assert.equal(w.run(['sync', 'status', '--json']).status, 0);
  assert.deepEqual(diffSnapshots(before, snapshot(w.W)), [], 'nothing changed under any home or mount');
  // Control: the same run under a preload that writes one file on linux-b, as a build that wrote would, is caught.
  const writer = path.join(w.io, 'writer.cjs');
  fs.writeFileSync(writer, `require('fs').writeFileSync(${JSON.stringify(path.join(w.homes['linux-b'], '.claude', 'projects', 'written-by-sync'))}, 'x');\n`);
  const r = w.run(['sync', 'plan', '--json'], {}, { node: ['--require', writer] });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(changedPaths(before, snapshot(w.W)), ['homes/linux-b/.claude/projects', 'homes/linux-b/.claude/projects/written-by-sync']);
});

test('sync plan: --machine limits it; an unreachable machine, a missing oak and an older one are named; the human summary', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  const only = w.json('linux-a', ['sync', 'plan', '--machine', 'linux-b']);
  assert.deepEqual(only.machines.map((m) => m.label), ['linux-a', 'linux-b']);
  assert.deepEqual(w.sshCalls().map((c) => c[c.length - 2]), ['u@linux-b']);
  assert.match(w.run(['sync', 'plan', '--machine', 'nowhere']).stderr, /no saved machine "nowhere"/);
  // linux-b down, no oak on the Mac, an OAK from before the verb on the lab machine.
  fs.rmSync(path.join(w.homes.mac, '.local', 'bin', 'oak'));
  fs.writeFileSync(path.join(w.homes.lab, '.local', 'bin', 'oak'), '#!/bin/sh\nprintf \'oak: unknown command "%s". Run `oak help`.\\n\' "$1" >&2\nexit 1\n');
  const down = { SSH_FAKE_DOWN: 'u@linux-b', SSH_FAKE_STDERR: 'ssh: connect to host linux-b port 22: Connection refused' };
  const by = Object.fromEntries(w.json('linux-a', ['sync', 'plan'], down).machines.map((m) => [m.label, m]));
  assert.deepEqual([by['linux-b'].status, by['linux-b'].detail], ['unreachable', 'ssh: connect to host linux-b port 22: Connection refused']);
  assert.equal(by.mac.status, 'no-oak');
  assert.equal(by.lab.status, 'old-oak');
  // For a person: every machine's state in a sentence, and what this one would pull.
  const human = w.run(['sync', 'plan'], down);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /^Sync plan \(preview: nothing is copied or changed on any machine\)/);
  assert.match(human.stdout, /linux-a \(this machine\)\s+inventoried/);
  assert.match(human.stdout, /linux-b\s+could not be reached over ssh: ssh: connect to host linux-b port 22: Connection refused/);
  assert.match(human.stdout, /mac\s+OAK was not found there/);
  assert.match(human.stdout, /lab\s+its OAK is older than this one/);
  assert.match(human.stdout, /linux-a would pull nothing/);
  assert.match(human.stdout, /warning: cleanupPeriodDays is not set on linux-a/);
  // A run no machine answered does not say there was nothing to pull, and exits 1: every machine it asked failed.
  const ran = w.run(['sync', 'now'], down);
  assert.equal(ran.status, 1, ran.stderr);
  assert.match(ran.stdout, /^oak sync: nothing pulled\n/);
  const asJson = w.run(['sync', 'now', '--json'], down);
  assert.equal(asJson.status, 1, asJson.stderr);
  assert.ok(JSON.parse(asJson.stdout).machines.every((m) => m.status !== 'ok'), 'its answer whole, every machine failed');
  // One machine that answers is enough, with the others still failing: 0 when it pulls, 0 when nothing is left to
  // pull, and 0 when nothing is due.
  for (const args of [['sync', 'now'], ['sync', 'now'], ['sync', 'now', '--if-due']]) {
    const r = w.run(args);
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
  }
});

/** Every machine runs `oak sync now` in turn, `n` rounds, each exiting cleanly; their results. */
function rounds(w, machines, n = 2, env = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    for (const m of machines) {
      const r = w.runAs(m, ['sync', 'now', '--json'], env);
      assert.equal(r.status, 0, `${m}: ${r.stderr}`);
      out.push({ machine: m, round: i, result: JSON.parse(r.stdout) });
    }
  }
  return out;
}

/** The files below one folder of a machine's home, by name, with their bytes' hash. */
function filesOf(w, machine, rel) {
  const out = {};
  const walk = (d, r) => {
    let names = [];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const name of names) {
      const abs = path.join(d, name);
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) walk(abs, r ? `${r}/${name}` : name);
      else if (st.isFile()) out[r ? `${r}/${name}` : name] = sha(fs.readFileSync(abs));
    }
  };
  walk(path.join(w.homes[machine], rel), '');
  return out;
}

test('sync now: three machines converge: text everywhere, every session on the backup, each machine its own; then nothing to do', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  // Two memory files with no version in common are a conflict: here only linux-b has one.
  fs.rmSync(path.join(s.A, '.claude', 'projects', claudeFolder(s.appA), 'memory'), { recursive: true });
  for (const m of ['linux-a', 'linux-b', 'mac']) w.syncPrefs(m, { backup: { kind: 'machine', label: 'linux-b' } });
  // Each machine publishes what the last round landed on it as its own (its plans, skills and memory) when the next asks
  // it, which the round after brings: the third round finds nothing to do anywhere.
  const results = rounds(w, ['linux-a', 'linux-b', 'mac'], 3);
  for (const { machine, result } of results.filter((r) => r.round === 2)) {
    assert.deepEqual(result.done, [], `${machine} pulled again: ${JSON.stringify(result.done)}`);
    assert.equal(result.status, 'ok', machine);
  }
  // Text the agents read is the same everywhere (plans, skills, memory in each machine's own folder for the repository).
  for (const m of ['linux-a', 'linux-b', 'mac']) {
    assert.deepEqual(Object.keys(filesOf(w, m, '.claude/plans')).sort(), ['b-plan.md', 'shared-plan.md'], m);
    assert.equal(fs.readFileSync(path.join(w.homes[m], '.claude', 'skills', 'review', 'SKILL.md'), 'utf8'), '---\nname: review\n---\n');
  }
  assert.equal(fs.readFileSync(path.join(s.M, '.claude', 'projects', claudeFolder(s.appM), 'memory', 'MEMORY.md'), 'utf8'), '# app\n- one\n- two\n');
  assert.equal(fs.readFileSync(path.join(s.A, '.claude', 'projects', claudeFolder(s.appA), 'memory', 'MEMORY.md'), 'utf8'), '# app\n- one\n- two\n');
  // The backup holds every session byte for byte as its origin does: linux-a's (in its own folders), the Mac's.
  const bFolder = claudeFolder(s.appB);
  const same = (a, b) => assert.equal(sha(fs.readFileSync(a)), sha(fs.readFileSync(b)), `${b} is not ${a}`);
  same(path.join(s.M, '.claude', 'projects', claudeFolder(s.appM), `${ID(6)}.jsonl`), path.join(s.B, '.claude', 'projects', bFolder, `${ID(6)}.jsonl`));
  same(path.join(s.A, '.claude', 'projects', claudeFolder(path.join(s.A, 'notes')), `${ID(2)}.jsonl`), path.join(s.B, '.claude', 'projects', claudeFolder(path.join(s.B, 'notes')), `${ID(2)}.jsonl`));
  same(path.join(s.A, '.claude', 'projects', claudeFolder(s.appA), ID(1), 'subagents', 'agent-x.jsonl'), path.join(s.B, '.claude', 'projects', bFolder, ID(1), 'subagents', 'agent-x.jsonl'));
  same(path.join(s.M, '.codex', 'sessions', '2026', '10', '29', 'rollout-2026-10-29T10-00-00-00000000-0000-7000-8000-000000000010.jsonl'),
    path.join(s.B, '.codex', 'sessions', '2026', '10', '29', 'rollout-2026-10-29T10-00-00-00000000-0000-7000-8000-000000000010.jsonl'));
  // linux-a's own session that linux-b continued comes back to linux-a, extended: it is linux-a's.
  same(path.join(s.B, '.claude', 'projects', bFolder, `${ID(1)}.jsonl`), path.join(s.A, '.claude', 'projects', claudeFolder(s.appA), `${ID(1)}.jsonl`));
  // linux-a's session, extended from linux-b's longer copy, is still linux-a's own, and its folder says where its
  // checkout is, however many newer copies from other machines sit beside its own sessions.
  const invA = w.json('linux-a', ['__sync-inventory', '--user', me]);
  assert.equal(invA.families.transcripts.find((f) => f.name.endsWith(`${ID(1)}.jsonl`)).origin, undefined, 'its own, extended');
  for (let i = 40; i < 45; i++) transcript(s.M, s.appM, ID(i), '', Date.now() + (i - 39) * 60_000);
  rounds(w, ['linux-b'], 1);
  const invB = w.json('linux-b', ['__sync-inventory', '--user', me]);
  assert.deepEqual(invB.projects.filter((p) => p.folder === bFolder).map((p) => [p.cwd, p.own]), [[s.appB, true]], 'five newer pulled copies, and still its own folder');
  // The Mac holds no other machine's session, and linux-a none of the Mac's: the index lists them.
  assert.ok(!fs.existsSync(path.join(s.M, '.claude', 'projects', claudeFolder(s.appM), `${ID(4)}.jsonl`)), 'not the backup: index only');
  assert.ok(!fs.existsSync(path.join(s.A, '.claude', 'projects', claudeFolder(s.appA), `${ID(6)}.jsonl`)));
  const st = w.json('mac', ['sync', 'status']);
  assert.deepEqual(st.index.map((x) => x.label).sort(), ['linux-a', 'linux-b']);
  assert.ok(st.index.find((x) => x.label === 'linux-b').files > 5);
  // Every write is in the audit log.
  const audit = fs.readFileSync(w.store('linux-b', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(audit.some((a) => a.op === 'create' && a.from === 'mac' && a.name.endsWith(`${ID(6)}.jsonl`)));
});

test('sync now: writes nothing but the files it pulls and its own state, and a run with nothing to do touches nothing at all', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  w.syncPrefs('linux-b', { backup: { kind: 'machine', label: 'linux-b' } });
  const before = snapshot(w.W);
  const r = w.json('linux-b', ['sync', 'now']);
  const after = snapshot(w.W);
  const B = 'homes/linux-b/';
  const store = `${B}.claude/claude-observatory`;
  const roots = { transcripts: '.claude/projects', 'session-files': '.claude/projects', memory: '.claude/projects', plans: '.claude/plans', skills: '.claude/skills', agents: '.claude/agents', commands: '.claude/commands', rollouts: '.codex' };
  // OAK's own families (record logs and session stores) land in the store.
  for (const f of ['oak-log', 'oak-blobs', 'oak-meta', 'oak-events', 'oak-records']) roots[f] = '.claude/claude-observatory';
  const written = r.done.filter((d) => d.action !== 'conflict' && d.action !== 'skipped').map((d) => `${B}${roots[d.family]}/${d.to}`);
  assert.ok(written.length >= 8, `pulled ${written.length}`);
  // Each machine it asked caught its local index up first (`__sync-inventory --publish`): OAK's own state there (its store,
  // which holds its record log, its index and the store move's coordination folder), and never a file of an agent's.
  const asked = (p) => /^homes\/(linux-a|mac)\/\.claude(\/(claude-observatory|claude-observatory-index|claude-observatory-move)(\/|$)|$)/.test(p);
  const allowed = (p) => p === store || p.startsWith(`${store}/`) || written.includes(p) || written.some((x) => x.startsWith(`${p}/`)) || asked(p);
  assert.deepEqual(changedPaths(before, after).filter((p) => !allowed(p)), [], 'no write outside the targets, sync\'s state and the asked machines\' own');
  assert.ok(changedPaths(before, after).some((p) => /^homes\/mac\/\.claude\/claude-observatory\/records\//.test(p)), 'control: the Mac published first');
  for (const p of written) assert.ok(fs.existsSync(path.join(w.W, p)), p);
  // A second run has nothing to do: no file anywhere but sync's own state moves, not even a folder's time, but the asked
  // machines' index files, whose catch-up found nothing to publish (none of their records, no file of an agent's).
  const quiet = snapshot(w.W);
  assert.deepEqual(w.json('linux-b', ['sync', 'now']).done, []);
  const askedIndex = (p) => /^homes\/(linux-a|mac)\/\.claude\/claude-observatory-index(\/|$)/.test(p);
  assert.deepEqual(changedPaths(quiet, snapshot(w.W)).filter((p) => !p.startsWith(store) && !askedIndex(p)), []);
  // Control: a stray write of the kind this check exists for is caught by it.
  const writer = path.join(w.io, 'stray.cjs');
  fs.writeFileSync(writer, `require('fs').writeFileSync(${JSON.stringify(path.join(w.homes['linux-b'], '.claude', 'plans', 'stray.md'))}, 'x');\n`);
  const q2 = snapshot(w.W);
  assert.equal(w.runAs('linux-b', ['sync', 'now', '--json'], {}, { node: ['--require', writer] }).status, 0);
  assert.deepEqual(changedPaths(q2, snapshot(w.W)).filter((p) => !p.startsWith(store) && !askedIndex(p)), [`${B}.claude/plans`, `${B}.claude/plans/stray.md`]);
});

test('sync now: a diverged session is kept as a conflict copy, never in Claude Code\'s folder, raised once, and listed', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  w.syncPrefs('linux-b', { backup: { kind: 'machine', label: 'linux-b' } });
  // linux-a's copy of session 1 went one way, linux-b's another: the same first records, then different turns.
  const fileA = path.join(s.A, '.claude', 'projects', claudeFolder(s.appA), `${ID(1)}.jsonl`);
  const fileB = path.join(s.B, '.claude', 'projects', claudeFolder(s.appB), `${ID(1)}.jsonl`);
  fs.appendFileSync(fileA, line({ type: 'assistant', message: { role: 'assistant', content: 'went left' } }) + line({ type: 'user', message: { content: 'and further' } }) + line({ type: 'user', message: { content: 'longer than linux-b' } }));
  const beforeB = fs.readFileSync(fileB);
  const r = w.json('linux-b', ['sync', 'now']);
  assert.deepEqual(fs.readFileSync(fileB), beforeB, 'linux-b\'s own copy is untouched');
  assert.ok(r.done.find((d) => d.action === 'conflict'), JSON.stringify(r.done));
  const copy = w.store('linux-b', 'conflicts', 'linux-a', 'transcripts', claudeFolder(s.appB), `${ID(1)}.jsonl`);
  assert.deepEqual(fs.readFileSync(copy), fs.readFileSync(fileA), 'the copy is linux-a\'s, whole');
  assert.equal(fs.readdirSync(path.join(s.B, '.claude', 'projects', claudeFolder(s.appB))).filter((n) => n.includes(ID(1)) && n.endsWith('.jsonl')).length, 1, 'one file per session in Claude Code\'s folder');
  // Listed for a person: in status and in the inbox. Raised once: the next run does not fetch it again.
  const st = w.json('linux-b', ['sync', 'status']);
  assert.deepEqual(st.conflicts.filter((c) => c.family === 'transcripts').map((c) => [c.family, c.from, c.reason]), [['transcripts', 'linux-a', 'diverged']]);
  assert.ok(w.json('linux-b', ['inbox']).sync.some((c) => c.copy === copy));
  assert.match(w.runAs('linux-b', ['inbox']).stdout, /sync conflict .*; delete the copy to keep yours \(`oak sync resolve \w+` deletes it\)\n/, 'a transcript is never edited into a merge');
  assert.deepEqual(w.json('linux-b', ['sync', 'now']).done, []);
  const audit = fs.readFileSync(w.store('linux-b', 'audit.jsonl'), 'utf8').split('\n').filter((l) => l.includes('"conflict"') && l.includes('"transcripts"'));
  assert.equal(audit.length, 1, 'one conflict, once');
});

test('sync now: a tail is cut at its last complete line, and the rest arrives when it is complete', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  w.syncPrefs('linux-b', { backup: { kind: 'machine', label: 'linux-b' } });
  const fileA = path.join(s.A, '.claude', 'projects', claudeFolder(path.join(s.A, 'notes')), `${ID(2)}.jsonl`);
  const fileB = path.join(s.B, '.claude', 'projects', claudeFolder(path.join(s.B, 'notes')), `${ID(2)}.jsonl`);
  assert.equal(w.json('linux-b', ['sync', 'now']).status, 'ok');
  assert.deepEqual(fs.readFileSync(fileB), fs.readFileSync(fileA), 'control: pulled whole');
  // linux-a's Claude Code is mid-record: one complete line, and half of the next.
  const done1 = line({ type: 'assistant', message: { content: 'complete' } });
  fs.appendFileSync(fileA, done1 + '{"type":"user","message":{"content":"half wri');
  const before = fs.statSync(fileB).size;
  const r = w.json('linux-b', ['sync', 'now']);
  const app = r.done.find((d) => d.to.endsWith(`${ID(2)}.jsonl`));
  assert.deepEqual([app?.action, app?.bytes], ['append', Buffer.byteLength(done1)]);
  assert.equal(fs.statSync(fileB).size, before + Buffer.byteLength(done1));
  assert.ok(fs.readFileSync(fileB, 'utf8').endsWith('\n'), 'no torn line');
  // The line completes there, and the next run brings the rest.
  fs.appendFileSync(fileA, 'tten"}}\n');
  w.json('linux-b', ['sync', 'now']);
  assert.deepEqual(fs.readFileSync(fileB), fs.readFileSync(fileA));
});

test('sync now: a run killed while it writes leaves each file whole, old or new, and the next run finishes and cleans up', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  w.syncPrefs('linux-b', { backup: { kind: 'machine', label: 'linux-b' } });
  // A large session on linux-a, and a longer copy of a session linux-b holds: both are written by this run.
  const big = path.join(s.A, '.claude', 'projects', claudeFolder(path.join(s.A, 'notes')), `${ID(2)}.jsonl`);
  for (let i = 0; i < 400; i++) fs.appendFileSync(big, line({ type: 'user', i, message: { content: 'x'.repeat(2000) } }));
  // The preload kills the process with SIGKILL once 64 KB of writes reach any file in Claude Code's folders there, the
  // targets themselves as much as anything written beside them.
  const killer = path.join(w.io, 'killer.cjs');
  const watched = path.join(w.homes['linux-b'], '.claude', 'projects') + path.sep;
  fs.writeFileSync(killer, `
const fs = require('fs');
const paths = new Map(); let total = 0;
const open = fs.openSync; fs.openSync = function (p, ...r) { const fd = open.call(fs, p, ...r); paths.set(fd, String(p)); return fd; };
const w = fs.writeSync; fs.writeSync = function (fd, buf, ...r) {
  if ((paths.get(fd) || '').startsWith(${JSON.stringify(watched)}) && Buffer.isBuffer(buf)) {
    total += buf.length;
    if (total > 65536) { w.call(fs, fd, buf.subarray(0, Math.floor(buf.length / 2))); process.kill(process.pid, 'SIGKILL'); }
  }
  return w.call(fs, fd, buf, ...r);
};`);
  const killed = w.runAs('linux-b', ['sync', 'now', '--json'], {}, { node: ['--require', killer] });
  assert.equal(killed.signal, 'SIGKILL', `killed mid-write: ${killed.stderr}`);
  const target = path.join(s.B, '.claude', 'projects', claudeFolder(path.join(s.B, 'notes')), `${ID(2)}.jsonl`);
  // Never a torn file: the large session is absent (it was being created) or whole.
  assert.ok(!fs.existsSync(target) || fs.readFileSync(target).equals(fs.readFileSync(big)), 'old or new, never torn');
  const temps = () => cp.execFileSync('find', [w.homes['linux-b'], '-name', '*.oak-sync-*.tmp'], { encoding: 'utf8' }).trim();
  assert.notEqual(temps(), '', 'control: the killed run left its half-written file beside the target');
  // The next run removes it and finishes.
  assert.equal(w.json('linux-b', ['sync', 'now']).status, 'ok');
  assert.equal(temps(), '');
  assert.deepEqual(fs.readFileSync(target), fs.readFileSync(big));
});

test('sync now: one run at a time on a machine, and two machines pulling each other at once both end whole and equal', { skip: POSIX }, async (t) => {
  const w = world(t);
  const s = seed(w);
  // Both keep every session (`everywhere`), so each pulls the other's while the other pulls its, however old.
  write(path.join(s.A, '.claude', 'settings.json'), JSON.stringify({ cleanupPeriodDays: 3650 }));
  for (const m of ['linux-a', 'linux-b']) w.syncPrefs(m, { families: { transcripts: 'everywhere', 'session-files': 'everywhere', rollouts: 'everywhere' }, exclude: { machines: ['mac', 'lab'] } });
  for (let i = 0; i < 60; i++) fs.appendFileSync(path.join(s.A, '.claude', 'projects', claudeFolder(path.join(s.A, 'notes')), `${ID(2)}.jsonl`), line({ i, pad: 'a'.repeat(4000) }));
  for (let i = 0; i < 60; i++) fs.appendFileSync(path.join(s.B, '.claude', 'projects', claudeFolder(s.appB), `${ID(4)}.jsonl`), line({ i, pad: 'b'.repeat(4000) }));
  // Each answers slowly, so the two runs overlap.
  const slow = path.join(w.io, 'slow.cjs');
  fs.writeFileSync(slow, 'const end = Date.now() + 1500; while (Date.now() < end) {}\n');
  w.oakWrapper('linux-a', [slow]);
  w.oakWrapper('linux-b', [slow]);
  const both = Promise.all([w.startAs('linux-a', ['sync', 'now', '--json']), w.startAs('linux-b', ['sync', 'now', '--json'])]);
  // A second run on linux-a while its first holds the lock is turned away: started once that lock is there.
  for (let i = 0; i < 200 && !fs.existsSync(w.store('linux-a', 'now.lock')); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(fs.existsSync(w.store('linux-a', 'now.lock')), 'control: the first run holds the lock');
  const second = w.runAs('linux-a', ['sync', 'now', '--json']);
  const [a, b] = await both;
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(JSON.parse(second.stdout).status, 'busy', 'one run at a time');
  w.oakWrapper('linux-a');
  w.oakWrapper('linux-b');
  rounds(w, ['linux-a', 'linux-b'], 1);
  const bySession = (files) => Object.fromEntries(Object.entries(files).filter(([k]) => k.endsWith('.jsonl') && !k.includes('/memory/')).map(([k, v]) => [k.slice(k.indexOf('/') + 1), v]));
  assert.deepEqual(bySession(filesOf(w, 'linux-a', '.claude/projects')), bySession(filesOf(w, 'linux-b', '.claude/projects')), 'both hold every session, byte for byte');
  assert.equal(cp.execFileSync('find', [w.W, '-name', '*.oak-sync-*.tmp'], { encoding: 'utf8' }).trim(), '', 'no half-written file anywhere');
});

test('sync: the backup alone restores a machine that was wiped, and serves a fetch while the origin is down', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  for (const m of ['linux-a', 'linux-b', 'mac']) w.syncPrefs(m, { backup: { kind: 'machine', label: 'linux-b' } });
  rounds(w, ['linux-b', 'mac', 'linux-a'], 1);
  // The Mac holds the index of linux-a's sessions, not the sessions, until it fetches one.
  const notes = (h) => path.join(h, '.claude', 'projects', claudeFolder(path.join(h, 'notes')), `${ID(2)}.jsonl`);
  assert.ok(!fs.existsSync(notes(s.M)));
  const original = fs.readFileSync(notes(s.A));
  // linux-a is down: its session comes from the backup, and the fetch says it tried linux-a first.
  const down = { SSH_FAKE_DOWN: 'u@linux-a', SSH_FAKE_STDERR: 'ssh: connect to host linux-a port 22: No route to host' };
  const f = w.json('mac', ['sync', 'fetch', ID(2)], down);
  assert.deepEqual(f.tried.map((x) => [x.label, x.status]), [['linux-a', 'unreachable'], ['linux-b', 'ok']]);
  assert.equal(f.from, 'linux-b');
  assert.deepEqual(fs.readFileSync(notes(s.M)), original);
  assert.equal(f.path, notes(s.M));
  assert.equal(w.json('mac', ['sync', 'status']).cache.files, 1, 'kept as an on-demand copy');
  // linux-a is wiped: its Claude Code and Codex state and its store are gone; the same home comes back empty.
  const kept = filesOf(w, 'linux-a', '.claude/projects');
  fs.rmSync(path.join(s.A, '.claude'), { recursive: true, force: true });
  fs.rmSync(path.join(s.A, '.codex'), { recursive: true, force: true });
  assert.deepEqual(filesOf(w, 'linux-a', '.claude/projects'), {});
  // One run restores every session that was its own, byte for byte, from the backup alone (the Mac is away).
  w.syncPrefs('linux-a', { backup: { kind: 'machine', label: 'linux-b' }, exclude: { machines: ['mac'] } });
  const r = w.json('linux-a', ['sync', 'now']);
  assert.equal(r.status, 'ok', JSON.stringify(r.machines));
  const restored = filesOf(w, 'linux-a', '.claude/projects');
  // Its own: the sessions it made (2 and 3) and the subagent file of session 1, which linux-b held a longer copy of
  // before sync ran, and so is linux-b's.
  const own = Object.entries(kept).filter(([name]) => /0000000000(02|03)\.jsonl$|0000000000(01)\/subagents\//.test(name));
  assert.equal(own.length, 3, 'control: linux-a had files of its own');
  for (const [name, hash] of own) assert.equal(restored[name], hash, `${name} restored`);
});

test('sync: a fetched copy stays current, and past the cache\'s size it is evicted, while its source holds it', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  rounds(w, ['linux-a', 'mac'], 1);
  const there = path.join(s.A, '.claude', 'projects', claudeFolder(path.join(s.A, 'notes')), `${ID(2)}.jsonl`);
  const here = path.join(s.M, '.claude', 'projects', claudeFolder(path.join(s.M, 'notes')), `${ID(2)}.jsonl`);
  assert.equal(w.json('mac', ['sync', 'fetch', ID(2)]).from, 'linux-a');
  // Fetched again, it is here already: nothing came from any machine, and the answer says so.
  const again = w.json('mac', ['sync', 'fetch', ID(2)]);
  assert.deepEqual([again.from, again.done, again.path], [null, [], here]);
  fs.appendFileSync(there, line({ type: 'assistant', message: { content: 'later' } }));
  w.json('linux-a', ['sync', 'now']);
  w.json('mac', ['sync', 'now']);
  assert.deepEqual(fs.readFileSync(here), fs.readFileSync(there), 'the fetched copy follows its session');
  w.syncPrefs('mac', { cacheMB: 0 });
  const r = w.json('mac', ['sync', 'now']);
  assert.ok(!fs.existsSync(here), 'evicted');
  assert.ok(r.warnings.some((x) => /evicted/.test(x)), JSON.stringify(r.warnings));
  assert.ok(fs.readFileSync(w.store('mac', 'audit.jsonl'), 'utf8').includes('"evict"'));
  // A copy resumed here is this machine's own then, and never evicted.
  w.syncPrefs('mac', {});
  w.json('mac', ['sync', 'fetch', ID(2)]);
  fs.appendFileSync(here, line({ type: 'user', message: { content: 'resumed on the Mac' } }));
  w.syncPrefs('mac', { cacheMB: 0 });
  w.json('mac', ['sync', 'now']);
  assert.ok(fs.existsSync(here), 'a resumed copy stays');
});

// Once a fetched copy is evicted, the local index holds the session as its machine's again, listed with that machine's
// sessions, and never as archived here: it was taken for a session whose files went (`missing`), and left out of the
// other machine's sessions, while that machine still had it.
test('sync: an evicted on-demand copy is its machine\'s session again in the index, never archived here', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  only(w, ['linux-a', 'mac']);
  const S = ID(45);
  // In the repository the Mac alone has cloned: the copy lands under the Mac's folder name. With an edit the Mac
  // captured, which its records bring here.
  const other = path.join(s.M, 'src', 'other');
  conversation(s.M, other, S, 'Profile the nightly import');
  storeSession(w, 'mac', S, { records: [{ id: 1, uid: 'mac-45', ts: Date.now() - 60_000, tool: 'Write', file: path.join(other, 'p.txt'), status: 'pending' }] });
  w.json('mac', ['sessions']);
  rounds(w, ['linux-a'], 1);
  const hM = hostOf(w, 'mac');
  const row = () => JSON.parse(w.runAs('linux-a', ['query', 'sql', 'SELECT origin, archived_reason FROM sessions WHERE machine_id = ? AND session_id = ?', '--param', hM, '--param', S]).stdout).rows;
  const theirs = () => (w.json('linux-a', ['sessions', '--synced']).machines.find((m) => m.label === 'mac')?.sessions ?? []).some((x) => x.id === S);
  assert.ok(theirs(), 'control: listed with the Mac\'s sessions');
  const here = w.json('linux-a', ['sync', 'fetch', S]).path;
  assert.deepEqual(row(), [{ origin: 'pulled', archived_reason: null }], 'control: pulled here');
  only(w, ['linux-a', 'mac'], { cacheMB: 0 });
  w.json('linux-a', ['sync', 'now']);
  assert.ok(!fs.existsSync(here), 'control: evicted');
  assert.deepEqual(row(), [{ origin: 'synced', archived_reason: null }], 'the Mac\'s again, not archived');
  assert.ok(theirs(), 'and listed with the Mac\'s sessions again');
});

/** Session `S` started on the Mac and fetched on linux-a, which then took a turn in it five minutes ago (a session no
 *  longer running there); its two files and a turn written for either machine. */
function resumedCopy(w, s, S) {
  only(w, ['linux-a', 'mac']);
  const onMac = conversation(s.M, s.appM, S, 'Fix the flaky login test');
  rounds(w, ['linux-a'], 1);
  const here = w.json('linux-a', ['sync', 'fetch', S]).path;
  const turn = (cwd, minutes, content) => line({ type: 'user', cwd, sessionId: S, timestamp: new Date(Date.now() - minutes * 60_000).toISOString(), message: { role: 'user', content } });
  fs.appendFileSync(here, turn(s.appA, 5, 'a turn taken on linux-a'));
  fs.utimesSync(here, new Date(Date.now() - 5 * 60_000), new Date(Date.now() - 5 * 60_000));
  /** The Mac goes on with it: a turn longer than linux-a's, so its copy is the longer one. */
  const macGoesOn = (content) => {
    fs.appendFileSync(onMac, turn(s.appM, 4, `${content}: ${'and more '.repeat(20)}`));
    idle(path.dirname(onMac));
  };
  /** linux-a's record of its copy in sync's manifest, the last one written. */
  const record = () => fs.readFileSync(w.store('linux-a', 'manifest.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.name.endsWith(`/${S}.jsonl`)).at(-1);
  return { here, onMac, macGoesOn, record };
}

// A machine went on with a session linux-a had resumed, so linux-a's copy diverged from that machine's; linux-a's
// next run hashed its changed copy and recorded it as sync left it, still a cached copy, and evicted it, its turn lost on
// every machine. A copy changed here is marked so in the manifest for good, and never evicted.
test('sync: a fetched copy resumed here while its source went on is never evicted, its turn kept, the source\'s version a conflict copy', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  const S = ID(42);
  const { here, macGoesOn, record } = resumedCopy(w, s, S);
  macGoesOn('and on the Mac');
  only(w, ['linux-a', 'mac'], { cacheMB: 0 });
  for (const round of [1, 2]) {
    const r = w.json('linux-a', ['sync', 'now']);
    if (round === 1) assert.deepEqual(r.done.filter((d) => d.family === 'transcripts').map((d) => [d.family, d.action, d.detail]), [['transcripts', 'conflict', 'diverged']], 'control: the copies diverged');
    assert.ok(!r.warnings.some((x) => /evicted/.test(x)), `run ${round}: ${JSON.stringify(r.warnings)}`);
    assert.ok(fs.readFileSync(here, 'utf8').includes('a turn taken on linux-a'), `run ${round}: the resumed copy stays, with its turn`);
  }
  assert.deepEqual([record().changed, record().cached], [true, undefined], 'marked changed here, and no longer a cached copy');
  const st = w.json('linux-a', ['sync', 'status']);
  assert.equal(st.cache.files, 0, 'not counted in the cache');
  assert.ok(fs.readFileSync(st.conflicts.find((c) => c.name.endsWith(`/${S}.jsonl`)).copy, 'utf8').includes('and on the Mac'), 'the Mac\'s version is its conflict copy');
  // An earlier build left such a copy recorded as sync left it and cached, the Mac's version a conflict copy: kept too.
  const manifest = w.store('linux-a', 'manifest.jsonl');
  const { changed: _c, ...earlier } = record();
  void _c;
  fs.appendFileSync(manifest, JSON.stringify({ ...earlier, cached: true, usedAt: Date.now() }) + '\n');
  const again = w.json('linux-a', ['sync', 'now']);
  assert.ok(!again.warnings.some((x) => /evicted/.test(x)), JSON.stringify(again.warnings));
  assert.ok(fs.readFileSync(here, 'utf8').includes('a turn taken on linux-a'), 'the copy an earlier build recorded is kept');
  assert.deepEqual([record().changed, record().cached], [true, undefined], 'and marked changed here from then on');
});

test('sync: a fetched copy resumed here stays this machine\'s own once its source took that turn and went on, and a fetch does not make it a cached copy again', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  const S = ID(43);
  const { here, onMac, macGoesOn, record } = resumedCopy(w, s, S);
  // The Mac keeps its own session current: it takes linux-a's turn, then goes on. linux-a's copy is the start of the
  // Mac's, so the Mac's turn lands on it as a tail, and no conflict says it changed here.
  w.json('mac', ['sync', 'now']);
  assert.ok(fs.readFileSync(onMac, 'utf8').includes('a turn taken on linux-a'), 'control: the Mac took linux-a\'s turn');
  macGoesOn('and on the Mac');
  only(w, ['linux-a', 'mac'], { cacheMB: 0 });
  const r = w.json('linux-a', ['sync', 'now']);
  assert.deepEqual(r.done.filter((d) => d.family === 'transcripts').map((d) => [d.family, d.action]), [['transcripts', 'append']], 'control: a tail, no conflict');
  assert.ok(!r.warnings.some((x) => /evicted/.test(x)), JSON.stringify(r.warnings));
  assert.ok(fs.existsSync(here), 'a copy resumed here is never evicted');
  assert.deepEqual([record().changed, record().cached], [true, undefined]);
  // Fetched again once the Mac went on further, it stays this machine's own: no cached copy, and never evicted. linux-a's
  // run learns of the Mac's longer copy but leaves it, the session in use here (written in the last minute); a fetch
  // once it is still lands it.
  macGoesOn('and further on the Mac');
  only(w, ['linux-a', 'mac']);
  const still = fs.statSync(here).mtime;
  fs.utimesSync(here, new Date(), new Date());
  assert.deepEqual(w.json('linux-a', ['sync', 'now']).done.filter((d) => d.family === 'transcripts').map((d) => d.action), ['skipped'], 'control: in use here, the run leaves it');
  fs.utimesSync(here, still, still);
  assert.deepEqual(w.json('linux-a', ['sync', 'fetch', S]).done.filter((d) => d.family === 'transcripts').map((d) => d.action), ['append'], 'control: the fetch landed a tail');
  only(w, ['linux-a', 'mac'], { cacheMB: 0 });
  w.json('linux-a', ['sync', 'now']);
  assert.ok(fs.existsSync(here) && fs.readFileSync(here, 'utf8').includes('and further on the Mac'), 'kept');
  assert.equal(w.json('linux-a', ['sync', 'status']).cache.files, 0, 'a fetch does not make it a cached copy');
  // An earlier build's fetch marks a copy cached whatever else its record says, so a record can carry both marks: the
  // mark that it changed here still keeps it.
  fs.appendFileSync(w.store('linux-a', 'manifest.jsonl'), JSON.stringify({ ...record(), cached: true, usedAt: Date.now() }) + '\n');
  assert.deepEqual([record().changed, record().cached], [true, true], 'control: both marks');
  only(w, ['linux-a', 'mac'], { cacheMB: 0 });
  const both = w.json('linux-a', ['sync', 'now']);
  assert.ok(!both.warnings.some((x) => /evicted/.test(x)), JSON.stringify(both.warnings));
  assert.ok(fs.existsSync(here), 'still never evicted');
});

test('sync: deliberate deletes propagate, a retention sweep and an unavailable folder do not, and an edit outlives a delete', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  for (const m of ['linux-a', 'linux-b', 'mac']) w.syncPrefs(m, { backup: { kind: 'machine', label: 'linux-b' } });
  write(path.join(s.A, '.claude', 'plans', 'gone.md'), 'remove me\n');
  write(path.join(s.A, '.claude', 'plans', 'edited.md'), 'v1\n');
  write(path.join(s.A, '.claude', 'plans', 'old.md'), 'old\n', Date.now() - 20 * DAY);
  rounds(w, ['linux-a', 'linux-b', 'mac'], 1);
  for (const m of ['linux-b', 'mac']) for (const p of ['gone.md', 'edited.md', 'old.md']) assert.ok(fs.existsSync(path.join(w.homes[m], '.claude', 'plans', p)), `control: ${p} on ${m}`);
  // linux-a removes two plans; the Mac edits one of them meanwhile; Claude Code's sweep removes linux-a's old plan,
  // which has aged past linux-a's 30 days by then.
  fs.rmSync(path.join(s.A, '.claude', 'plans', 'gone.md'));
  fs.rmSync(path.join(s.A, '.claude', 'plans', 'edited.md'));
  write(path.join(s.M, '.claude', 'plans', 'edited.md'), 'v2 on the Mac\n');
  const manifest = w.store('linux-a', 'manifest.jsonl');
  fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').split('\n').map((l) => (l.includes('"old.md"') ? JSON.stringify({ ...JSON.parse(l), mtime: Date.now() - 40 * DAY }) : l)).join('\n'));
  fs.rmSync(path.join(s.A, '.claude', 'plans', 'old.md'));
  // A session deleted with `oak sessions --delete` on linux-a.
  assert.equal(w.runAs('linux-a', ['sessions', '--delete', ID(3), '--force']).status, 0);
  // linux-a records its deletes pulling from linux-b alone, and the Mac takes them from linux-a before its edit has
  // reached any machine that could give it back.
  w.json('linux-a', ['sync', 'now', '--machine', 'linux-b']);
  w.json('mac', ['sync', 'now', '--machine', 'linux-a']);
  assert.equal(fs.readFileSync(path.join(s.M, '.claude', 'plans', 'edited.md'), 'utf8'), 'v2 on the Mac\n', 'the edit outlives the delete, on the machine that made it');
  rounds(w, ['linux-a', 'linux-b', 'mac'], 2);
  for (const m of ['linux-b', 'mac']) assert.ok(!fs.existsSync(path.join(w.homes[m], '.claude', 'plans', 'gone.md')), `the delete reached ${m}`);
  assert.ok(fs.readdirSync(w.store('linux-b', 'trash')).length, 'to the trash first');
  assert.equal(fs.readFileSync(path.join(s.M, '.claude', 'plans', 'edited.md'), 'utf8'), 'v2 on the Mac\n', 'the edit outlives the delete');
  assert.equal(fs.readFileSync(path.join(s.A, '.claude', 'plans', 'edited.md'), 'utf8'), 'v2 on the Mac\n', 'and comes back to linux-a');
  for (const m of ['linux-b', 'mac']) assert.ok(fs.existsSync(path.join(w.homes[m], '.claude', 'plans', 'old.md')), `a retention sweep is no delete: ${m} keeps old.md`);
  // The deleted session is hidden everywhere, and its file, once gone from the backup, is not pulled back.
  for (const m of ['linux-b', 'mac']) {
    const hidden = JSON.parse(fs.readFileSync(path.join(w.homes[m], '.claude', 'claude-observatory', 'hidden-sessions.json'), 'utf8'));
    assert.ok(hidden.includes(ID(3)), `hidden on ${m}`);
  }
  const backupCopy = cp.execFileSync('find', [path.join(s.B, '.claude', 'projects'), '-name', `${ID(3)}.jsonl`], { encoding: 'utf8' }).trim();
  assert.ok(backupCopy, 'control: the backup held it');
  fs.rmSync(backupCopy);
  assert.ok(!w.json('linux-b', ['sync', 'now']).done.some((d) => d.to.endsWith(`${ID(3)}.jsonl`)), 'a deleted session is never pulled');
  // A whole family gone at once (a folder on a drive that is not mounted) passes no delete on.
  fs.rmSync(path.join(s.A, '.claude', 'skills'), { recursive: true, force: true });
  const r = w.json('linux-a', ['sync', 'now']);
  assert.ok(r.warnings.some((x) => /no delete is passed on/.test(x)), JSON.stringify(r.warnings));
  rounds(w, ['linux-b', 'mac'], 1);
  assert.ok(fs.existsSync(path.join(s.B, '.claude', 'skills', 'review', 'SKILL.md')));
});

test('sync: text merges three ways against the last version both machines had; lines both changed are a conflict, resolved by an edit', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  for (const m of ['linux-a', 'linux-b']) w.syncPrefs(m, { exclude: { machines: ['mac', 'lab'] } });
  write(path.join(s.A, '.claude', 'plans', 'm.md'), 'one\ntwo\nthree\nfour\n');
  rounds(w, ['linux-a', 'linux-b'], 1);
  write(path.join(s.A, '.claude', 'plans', 'm.md'), 'ONE\ntwo\nthree\nfour\n');
  write(path.join(s.B, '.claude', 'plans', 'm.md'), 'one\ntwo\nthree\nFOUR\n');
  rounds(w, ['linux-a', 'linux-b'], 2);
  for (const m of ['linux-a', 'linux-b']) assert.equal(fs.readFileSync(path.join(w.homes[m], '.claude', 'plans', 'm.md'), 'utf8'), 'ONE\ntwo\nthree\nFOUR\n', `merged on ${m}`);
  // Both change line 2: neither wins; each keeps its own and the other's copy, listed as a conflict.
  write(path.join(s.A, '.claude', 'plans', 'm.md'), 'ONE\nleft\nthree\nFOUR\n');
  write(path.join(s.B, '.claude', 'plans', 'm.md'), 'ONE\nright\nthree\nFOUR\n');
  rounds(w, ['linux-a', 'linux-b'], 1);
  assert.equal(fs.readFileSync(path.join(s.A, '.claude', 'plans', 'm.md'), 'utf8'), 'ONE\nleft\nthree\nFOUR\n');
  assert.equal(fs.readFileSync(path.join(s.B, '.claude', 'plans', 'm.md'), 'utf8'), 'ONE\nright\nthree\nFOUR\n');
  const conflicts = w.json('linux-a', ['sync', 'status']).conflicts.filter((c) => c.family === 'plans');
  assert.deepEqual(conflicts.map((c) => [c.family, c.name, c.reason]), [['plans', 'm.md', 'overlap']]);
  assert.equal(fs.readFileSync(conflicts[0].copy, 'utf8'), 'ONE\nright\nthree\nFOUR\n');
  // Resolved on linux-a by an edit, and linux-b's conflict by deleting its copy: the edit is the merge, both take it.
  write(path.join(s.A, '.claude', 'plans', 'm.md'), 'ONE\nleft and right\nthree\nFOUR\n');
  for (const c of w.json('linux-b', ['sync', 'status']).conflicts.filter((x) => x.family === 'plans')) fs.rmSync(c.copy);
  rounds(w, ['linux-a', 'linux-b'], 2);
  for (const m of ['linux-a', 'linux-b']) assert.equal(fs.readFileSync(path.join(w.homes[m], '.claude', 'plans', 'm.md'), 'utf8'), 'ONE\nleft and right\nthree\nFOUR\n', m);
  assert.deepEqual(w.json('linux-a', ['sync', 'status']).conflicts.filter((c) => c.family === 'plans'), []);
  assert.deepEqual(w.json('linux-b', ['sync', 'status']).conflicts.filter((c) => c.family === 'plans'), []);
});

test('sync: include, exclude, backup and family settings land in prefs.json and steer the runs', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  // status names the project in --root (else the folder it runs in) as exclude keys it, and whether it is excluded here.
  const notes = path.join(s.A, 'notes');
  const here = () => w.json('linux-a', ['sync', 'status', '--root', notes]).project;
  assert.deepEqual(here(), { folder: notes, key: 'home:notes', excluded: false });
  assert.equal(JSON.parse(w.runAs('linux-a', ['sync', 'status', '--json'], {}, { cwd: notes }).stdout).project.folder, fs.realpathSync(notes));
  // A link to it reads as that link, as `exclude <folder>` reads it: the folder as the editor names it.
  const link = path.join(s.A, 'notes-link');
  fs.symlinkSync(notes, link);
  assert.deepEqual(w.json('linux-a', ['sync', 'status', '--root', link]).project, { folder: link, key: 'home:notes-link', excluded: false });
  // Run in a folder removed under it, it still answers: no project to name.
  const gone = path.join(w.W, 'gone');
  fs.mkdirSync(gone);
  const inGone = cp.spawnSync('sh', ['-c', `cd "${gone}" && rmdir "${gone}" && exec "${process.execPath}" --require "${preload}" "${cli}" sync status --json`],
    { env: w.envFor('linux-a'), encoding: 'utf8', timeout: 90000 });
  assert.equal(inGone.status, 0, inGone.stderr);
  assert.equal(JSON.parse(inGone.stdout).project, null);
  assert.deepEqual(w.json('linux-a', ['sync', 'exclude', 'mac']).syncExclude.machines, ['mac']);
  assert.deepEqual(w.json('linux-a', ['sync', 'exclude', notes]).syncExclude.projects, ['home:notes']);
  assert.deepEqual(here(), { folder: notes, key: 'home:notes', excluded: true });
  assert.deepEqual(w.json('linux-a', ['sync', 'backup', 'linux-a']).syncBackup, { kind: 'machine', label: 'linux-a' });
  assert.deepEqual(w.json('linux-a', ['sync', 'family', 'plans', 'off']).syncFamilies, { plans: 'off' });
  assert.match(w.run(['sync', 'family', 'plans', 'backup']).stderr, /everywhere or off/);
  assert.match(w.run(['sync', 'exclude', 'nowhere-at-all']).stderr, /no saved machine/);
  const prefs = JSON.parse(fs.readFileSync(path.join(s.A, '.claude', 'claude-observatory', 'prefs.json'), 'utf8'));
  assert.deepEqual(prefs.sync, { backup: { kind: 'machine', label: 'linux-a' }, families: { plans: 'off' }, exclude: { machines: ['mac'], projects: ['home:notes'] } });
  // linux-b's notes session, in the excluded project, is not pulled; its other sessions are.
  transcript(s.B, path.join(s.B, 'notes'), ID(20));
  const r = w.json('linux-a', ['sync', 'now']);
  assert.equal(r.machines.find((m) => m.label === 'mac').status, 'excluded');
  assert.ok(!fs.existsSync(path.join(s.A, '.claude', 'plans', 'b-plan.md')), 'plans are off here');
  assert.ok(!r.done.some((d) => d.to.endsWith(`${ID(20)}.jsonl`)), 'the excluded project is not pulled');
  assert.ok(r.done.some((d) => d.family === 'transcripts' && d.from === 'linux-b'), 'the backup pulls the rest');
  assert.deepEqual(w.json('linux-a', ['sync', 'include', 'mac']).syncExclude.machines, []);
  // A backup that names no saved machine, and not this one, is said.
  w.json('linux-a', ['sync', 'backup', 'nowhere-box']);
  assert.ok(w.json('linux-a', ['sync', 'now']).warnings.some((x) => /"nowhere-box" is no saved machine here/.test(x)));
});

test('sync: the background run is kicked once set up, at most once a minute, never before the first run or when turned off', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  const recorder = path.join(root, 'packages/tui/test/fixtures/spawn-recorder.cjs');
  const log = path.join(w.io, 'spawns.jsonl');
  const poll = () => w.runAs('linux-a', ['usage', '--json'], { OAK_SPAWN_LOG: log, OAK_NO_BACKGROUND: '' }, { node: ['--require', recorder] });
  const kicks = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((s) => s.args.slice(1).join(' ') === 'sync now --quiet --if-due') : []);
  poll();
  assert.deepEqual(kicks(), [], 'no run here yet: nothing is kicked');
  w.json('linux-a', ['sync', 'now']);
  const status = w.store('linux-a', 'status.json');
  const st = JSON.parse(fs.readFileSync(status, 'utf8'));
  fs.writeFileSync(status, JSON.stringify({ ...st, at: Date.now() - 10 * 60_000 })); // the last run ten minutes ago
  poll();
  assert.equal(kicks().length, 1, 'due: kicked, detached');
  assert.equal(kicks()[0].detached, true);
  poll();
  assert.equal(kicks().length, 1, 'once a minute at most');
  fs.rmSync(w.store('linux-a', 'kick'));
  w.syncPrefs('linux-a', { auto: false });
  poll();
  assert.equal(kicks().length, 1, 'turned off: nothing is kicked');
  // The capture hooks kick it too, at a turn's end and after a tool call, and not before a run has happened here.
  w.syncPrefs('linux-a', {});
  const hook = (machine, event) => {
    const home = w.homes[machine];
    const payload = JSON.stringify({ session_id: ID(30), hook_event_name: event, cwd: home, transcript_path: path.join(home, 'none.jsonl') });
    return w.runAs(machine, ['capture'], { OAK_SPAWN_LOG: log, OAK_NO_BACKGROUND: '' }, { node: ['--require', recorder], input: payload });
  };
  assert.equal(hook('linux-a', 'Stop').status, 0);
  assert.equal(kicks().length, 2, 'the Stop hook kicks a due run');
  assert.ok(kicks()[1].args[0].endsWith(path.join('dist', 'cli.js')), 'through the full CLI beside the capture bundle');
  fs.rmSync(w.store('linux-a', 'kick'));
  assert.equal(hook('linux-a', 'PostToolUse').status, 0);
  assert.equal(kicks().length, 3, 'and so does PostToolUse');
  assert.equal(hook('mac', 'Stop').status, 0);
  assert.equal(kicks().length, 3, 'not on a machine where sync has never run');
});

test('sync: `oak clean` leaves sync\'s state alone, which no session is', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  w.syncPrefs('linux-b', { backup: { kind: 'machine', label: 'linux-b' } });
  w.json('linux-b', ['sync', 'now']);
  const before = fs.readdirSync(w.store('linux-b')).sort();
  assert.ok(before.includes('manifest.jsonl') && before.includes('status.json'), `control: sync wrote its state: ${before}`);
  const cleaned = w.runAs('linux-b', ['clean']);
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.deepEqual(fs.existsSync(w.store('linux-b')) ? fs.readdirSync(w.store('linux-b')).sort() : [], before, 'oak clean removed none of it');
  // So the teardown steps `oak uninstall --all` prints name it, and only where there is one.
  const steps = w.runAs('linux-b', ['uninstall', '--all']);
  assert.equal(steps.status, 0, steps.stderr);
  assert.ok(steps.stdout.includes(`Sync state: delete ${w.store('linux-b')}  (`), steps.stdout);
  // No session was removed here, so there is no list of them to keep, and the step names none.
  assert.equal(fs.existsSync(w.store('linux-b', 'evicted.jsonl')), false, 'control: no list');
  assert.ok(!steps.stdout.includes('evicted.jsonl'), steps.stdout);
  assert.doesNotMatch(w.runAs('mac', ['uninstall', '--all']).stdout, /Sync state/, 'not where sync never ran');
});

test('sync now: a file that cannot be written fails alone; the rest from the same machine lands, and the run says what failed', { skip: POSIX || (process.getuid?.() === 0 && 'root writes anywhere') }, (t) => {
  const w = world(t);
  const s = seed(w);
  w.syncPrefs('linux-b', { backup: { kind: 'machine', label: 'linux-b' } });
  // linux-b's folder for the notes project exists and cannot be written to.
  const locked = path.join(s.B, '.claude', 'projects', claudeFolder(path.join(s.B, 'notes')));
  fs.mkdirSync(locked, { recursive: true });
  fs.chmodSync(locked, 0o500);
  t.after(() => { try { fs.chmodSync(locked, 0o700); } catch { /* the world is gone already */ } });
  const r = w.json('linux-b', ['sync', 'now']);
  assert.equal(r.status, 'partial');
  const a = r.machines.find((m) => m.label === 'linux-a');
  assert.ok(a.errors.some((e) => e.includes(`${ID(2)}.jsonl`)), JSON.stringify(a.errors));
  assert.ok(r.done.some((d) => d.from === 'linux-a' && d.to.endsWith(`${ID(3)}.jsonl`)), 'the next file from linux-a landed');
  assert.ok(r.done.some((d) => d.from === 'mac' && d.to.endsWith(`${ID(6)}.jsonl`)), 'and the Mac\'s');
  // Writable again, the next run brings it.
  fs.chmodSync(locked, 0o700);
  assert.ok(w.json('linux-b', ['sync', 'now']).done.some((d) => d.to.endsWith(`${ID(2)}.jsonl`)));
});

// ---------------------------------------------------------------------------------------------------------------
// A peer that answers what a test says, as a buggy or compromised machine could: its inventory, and the frames its
// fetch command sends. Each test below failed on the build before the fix it covers.
// ---------------------------------------------------------------------------------------------------------------

const PEER_HOST = 'eeeeeeeeeeee';
/** An inventory entry for a text file with `body`. */
const textEntry = (name, body, extra = {}) => ({ name, size: Buffer.byteLength(body), mtime: Date.now(), sha256: sha(body), ...extra });
/**
 * Make `machine` answer with `spec`: its inventory's `families`, `projects`, `identities` and `tombstones`, and for each
 * name asked, `bodies[name]` (a string, or `{ repeat, times }` built there) sent with `status` (one for all, or by name).
 * `tailFrom` sets the offset a `tail` answer claims; `auto` answers as OAK does, the body whole, or what follows the
 * offset asked from. `trickleMs` sends each line of a body that long after the one before, and `pauseMs` instead after
 * the first `pauseAfter` lines. Every request is logged.
 */
function scriptedPeer(w, machine, spec) {
  const specFile = path.join(w.io, `peer-spec-${machine}.json`);
  fs.writeFileSync(specFile, JSON.stringify({ families: {}, projects: [], identities: {}, tombstones: [], bodies: {}, status: 'whole', ...spec, me, host: PEER_HOST }));
  const main = path.join(w.io, `peer-${machine}.js`);
  fs.writeFileSync(main, `
const fs = require('fs');
const crypto = require('crypto');
const d = JSON.parse(fs.readFileSync(${JSON.stringify(specFile)}, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === '__sync-inventory') {
  process.stdout.write(JSON.stringify({ inventory: 1, at: Date.now(), host: d.host, user: d.me, home: '/Users/u', platform: 'darwin', cleanupPeriodDays: 3650,
    projects: d.projects, identities: d.identities, shares: [], families: d.families, codexSqlite: [], tombstones: d.tombstones }));
} else if (args[0] === '__sync-fetch') {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', async () => {
    const req = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    fs.appendFileSync(${JSON.stringify(path.join(w.io, `peer-requests-${machine}.jsonl`))}, JSON.stringify(req) + '\\n');
    for (const [i, it] of req.items.entries()) {
      const b = d.bodies[it.name] ?? '';
      let body = typeof b === 'string' ? Buffer.from(b) : Buffer.from(b.repeat.repeat(b.times));
      let status = typeof d.status === 'string' ? d.status : d.status[it.name] ?? 'whole';
      if (status === 'auto') {
        status = it.offset > 0 ? 'tail' : 'whole';
        if (it.offset > 0) body = body.subarray(it.offset);
      }
      const offset = status === 'tail' ? d.tailFrom ?? it.offset ?? 0 : 0;
      process.stdout.write(JSON.stringify({ i, status, size: body.length + offset, mtime: Date.now(), offset, length: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex') }) + '\\n');
      if (!d.trickleMs) process.stdout.write(body);
      else for (const [k, l] of body.toString('utf8').split(/(?<=\\n)/).entries()) {
        process.stdout.write(l);
        await new Promise((r) => setTimeout(r, d.pauseAfter !== undefined && k + 1 >= d.pauseAfter ? d.pauseMs : d.trickleMs));
      }
    }
  });
}
`);
  const bin = path.join(w.homes[machine], '.local', 'bin', 'oak');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${main}" "$@"\n`);
  fs.chmodSync(bin, 0o755);
}

test('sync now: a peer\'s names and deletes never lead through a link sync does not follow: nothing under ~/.ssh or the Claude folder is written, removed or read', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  // linux-b's skills hold the links seed() made (keys -> ~/.ssh, config-link -> ~/.claude) and one to a checkout of
  // its own, which sync follows.
  write(path.join(s.B, '.ssh', 'known_hosts'), 'build-box ssh-ed25519 AAAAknown\n');
  const mine = path.join(s.B, 'src', 'skills', 'mine');
  write(path.join(mine, 'SKILL.md'), 'v0\n');
  fs.symlinkSync(mine, path.join(s.B, '.claude', 'skills', 'mine'));
  scriptedPeer(w, 'mac', {
    families: { skills: [
      textEntry('keys/authorized_keys', 'ssh-ed25519 AAAA attacker\n'),
      textEntry('config-link/CLAUDE.md', '# instructions from elsewhere\n'),
      textEntry('keys/id_ed25519', 'x\n'),
      textEntry('mine/SKILL.md', 'v1\n', { history: [sha('v0\n'), sha('v1\n')] }),
    ] },
    bodies: { 'keys/authorized_keys': 'ssh-ed25519 AAAA attacker\n', 'config-link/CLAUDE.md': '# instructions from elsewhere\n', 'keys/id_ed25519': 'x\n', 'mine/SKILL.md': 'v1\n' },
    tombstones: [{ kind: 'file', key: 'skills:keys/known_hosts', deleted: true, at: Date.now(), host: PEER_HOST, sha256: sha('build-box ssh-ed25519 AAAAknown\n') }],
  });
  w.clearAccess();
  const r = w.json('linux-b', ['sync', 'now', '--machine', 'mac']);
  assert.ok(!fs.existsSync(path.join(s.B, '.ssh', 'authorized_keys')), 'no key written into ~/.ssh');
  assert.ok(!fs.existsSync(path.join(s.B, '.claude', 'CLAUDE.md')), 'nothing written into the Claude folder');
  assert.equal(fs.readFileSync(path.join(s.B, '.ssh', 'known_hosts'), 'utf8'), 'build-box ssh-ed25519 AAAAknown\n', 'nothing removed from ~/.ssh');
  assert.deepEqual(touchedNever(w, 'linux-b'), [], 'nor read: not even the private key, to merge it');
  // Said, each of them, and not taken for files sync keeps.
  const errors = r.machines.find((m) => m.label === 'mac').errors;
  for (const n of ['keys/authorized_keys', 'config-link/CLAUDE.md', 'keys/id_ed25519']) assert.ok(errors.some((e) => e.startsWith(`${n}: `) && /link sync does not follow/.test(e)), `${n}: ${JSON.stringify(errors)}`);
  // Control: a link to a skill's own checkout is followed, and written through, not replaced.
  assert.equal(fs.readFileSync(path.join(mine, 'SKILL.md'), 'utf8'), 'v1\n');
  assert.ok(fs.lstatSync(path.join(s.B, '.claude', 'skills', 'mine')).isSymbolicLink());
});

test('sync now: a peer that answers a tail request with a whole file, or with bytes from another place, never replaces the transcript here', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  const folder = claudeFolder(s.appB);
  const name = `${folder}/${ID(4)}.jsonl`;
  const mineFile = path.join(s.B, '.claude', 'projects', name);
  const before = fs.readFileSync(mineFile);
  const other = line({ type: 'user', message: { content: 'not this session' } }).repeat(20);
  const peer = (status, extra = {}) => scriptedPeer(w, 'mac', {
    families: { transcripts: [{ name, size: before.length + Buffer.byteLength(other), mtime: Date.now() }] },
    projects: [{ folder, cwd: s.appB, own: true }], identities: { [s.appB]: { key: 'git:github.com/Org/App', root: s.appB } },
    bodies: { [name]: other }, status, ...extra,
  });
  peer('whole');
  const r = w.json('linux-b', ['sync', 'now', '--machine', 'mac']);
  const asked = JSON.parse(fs.readFileSync(path.join(w.io, 'peer-requests-mac.jsonl'), 'utf8').trim().split('\n')[0]).items[0];
  assert.equal(asked.offset, before.length, 'control: it asked for what follows its own bytes');
  assert.deepEqual(fs.readFileSync(mineFile), before, 'the transcript here is untouched');
  const c = r.done.find((d) => d.action === 'conflict');
  assert.ok(c, JSON.stringify(r.done));
  assert.equal(fs.readFileSync(path.join(w.store('linux-b'), c.to), 'utf8'), other, 'the other copy is kept apart, as a conflict copy');
  // A tail that says it starts anywhere but where this machine's bytes end is refused: nothing is pulled, and the one
  // machine asked failed, so the run exits 1.
  peer('tail', { tailFrom: 0 });
  const refused = w.runAs('linux-b', ['sync', 'now', '--json', '--machine', 'mac']);
  assert.equal(refused.status, 1, refused.stderr);
  const r2 = JSON.parse(refused.stdout);
  assert.deepEqual(fs.readFileSync(mineFile), before);
  assert.ok(r2.machines.find((m) => m.label === 'mac').errors.some((e) => e.includes(`${ID(4)}.jsonl: bytes from 0 on were sent for a file asked from ${before.length}`)), JSON.stringify(r2.machines));
  // A copy that is shorter there by the time it is fetched brings nothing, and the run says so.
  peer('shorter');
  const r3 = w.json('linux-b', ['sync', 'now', '--machine', 'mac']);
  assert.deepEqual(fs.readFileSync(mineFile), before);
  assert.ok(r3.done.some((d) => d.action === 'skipped' && d.to === name && /shorter there now/.test(d.detail)), JSON.stringify(r3.done));
  assert.equal(r3.status, 'partial');
});

test('sync now: an empty copy here is filled from the other machine\'s whole file, not kept apart as diverged', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  w.syncPrefs('linux-b', { backup: { kind: 'machine', label: 'linux-b' } });
  const notesA = path.join(s.A, '.claude', 'projects', claudeFolder(path.join(s.A, 'notes')), `${ID(2)}.jsonl`);
  const notesB = path.join(s.B, '.claude', 'projects', claudeFolder(path.join(s.B, 'notes')), `${ID(2)}.jsonl`);
  write(notesB, '', Date.now() - 120_000); // made here a while ago, nothing written to it
  const r = w.json('linux-b', ['sync', 'now']);
  assert.deepEqual(r.done.filter((d) => d.to.endsWith(`${ID(2)}.jsonl`)).map((d) => d.action), ['create']);
  assert.deepEqual(fs.readFileSync(notesB), fs.readFileSync(notesA));
});

test('sync now: a peer that sends more than its inventory listed is not read any further, and nothing it sent lands', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  w.syncPrefs('linux-b', { backup: { kind: 'machine', label: 'linux-b' } });
  const folder = claudeFolder(s.appB);
  const name = `${folder}/${ID(60)}.jsonl`;
  scriptedPeer(w, 'mac', {
    families: { transcripts: [{ name, size: 10, mtime: Date.now() }] },
    projects: [{ folder, cwd: s.appB, own: true }], identities: { [s.appB]: { key: 'git:github.com/Org/App', root: s.appB } },
    bodies: { [name]: { repeat: line({ pad: 'z'.repeat(1000) }), times: 80 * 1024 } },
  });
  const ran = w.runAs('linux-b', ['sync', 'now', '--json', '--machine', 'mac']);
  assert.equal(ran.status, 1, `nothing pulled from the one machine asked: ${ran.stderr}`);
  const r = JSON.parse(ran.stdout);
  assert.ok(!fs.existsSync(path.join(s.B, '.claude', 'projects', name)), 'a 10-byte file does not arrive as 80 MB');
  assert.ok(r.machines.find((m) => m.label === 'mac').errors.some((e) => /bytes were sent for a file its inventory listed at 10$/.test(e)), JSON.stringify(r.machines));
  assert.equal(r.status, 'partial');
});

test('sync: a folder that is only unavailable passes no delete on (an empty mount point, a link to a cloud folder not there); a delete beside other files still does', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  for (const m of ['linux-a', 'linux-b']) w.syncPrefs(m, { exclude: { machines: ['mac', 'lab'] } });
  for (const p of ['p1.md', 'p2.md']) write(path.join(s.A, '.claude', 'plans', p), `${p}\n`);
  // linux-a keeps the notes project's memory in a cloud folder, linked in; linux-b has a notes session of its own.
  const cloud = path.join(w.base, 'cloud', 'notes-memory');
  write(path.join(cloud, 'MEMORY.md'), '# notes\n');
  write(path.join(cloud, 'people.md'), '- someone\n');
  fs.symlinkSync(cloud, path.join(s.A, '.claude', 'projects', claudeFolder(path.join(s.A, 'notes')), 'memory'));
  fs.mkdirSync(path.join(s.B, 'notes'), { recursive: true });
  transcript(s.B, path.join(s.B, 'notes'), ID(21));
  rounds(w, ['linux-a', 'linux-b'], 2);
  const plansB = path.join(s.B, '.claude', 'plans');
  const memB = path.join(s.B, '.claude', 'projects', claudeFolder(path.join(s.B, 'notes')), 'memory');
  assert.deepEqual(fs.readdirSync(memB).sort(), ['MEMORY.md', 'people.md'], 'control: the cloud memory reached linux-b');
  // Control: one plan removed beside others is a delete, and it reaches linux-b.
  fs.rmSync(path.join(s.A, '.claude', 'plans', 'p1.md'));
  rounds(w, ['linux-a', 'linux-b'], 1);
  assert.ok(!fs.existsSync(path.join(plansB, 'p1.md')), 'a deliberate delete still propagates');
  const kept = fs.readdirSync(plansB).filter((n) => n.endsWith('.md')).sort();
  // linux-a's plans folder is a share that is not mounted now (the mount point is there, empty), and the cloud folder
  // its notes memory links to is not there.
  fs.rmSync(path.join(s.A, '.claude', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(s.A, '.claude', 'plans'));
  fs.renameSync(cloud, `${cloud}.away`);
  const ra = w.json('linux-a', ['sync', 'now']);
  assert.equal(ra.tombstones.recorded, 0, JSON.stringify(ra.warnings));
  assert.ok(ra.warnings.some((x) => /plans files are gone here with their folder/.test(x)) && ra.warnings.some((x) => /memory files are gone here with their folder/.test(x)), JSON.stringify(ra.warnings));
  const rb = w.json('linux-b', ['sync', 'now']);
  assert.equal(rb.tombstones.applied, 0);
  assert.deepEqual(fs.readdirSync(plansB).filter((n) => n.endsWith('.md')).sort(), kept, 'linux-b keeps every plan');
  assert.deepEqual(fs.readdirSync(memB).sort(), ['MEMORY.md', 'people.md'], 'and the notes memory');
});

test('sync: a text change undone (one version, another, the first again) reaches the other machine; an undo against an edit made there meanwhile is a conflict, never dropped', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  for (const m of ['linux-a', 'linux-b']) w.syncPrefs(m, { exclude: { machines: ['mac', 'lab'] } });
  const plan = (m, n = 'm.md') => path.join(w.homes[m], '.claude', 'plans', n);
  const read = (n) => ['linux-a', 'linux-b'].map((m) => fs.readFileSync(plan(m, n), 'utf8'));
  write(plan('linux-a'), 'one\n');
  rounds(w, ['linux-a', 'linux-b'], 1);
  write(plan('linux-b'), 'one\ntwo\n');
  rounds(w, ['linux-a', 'linux-b'], 2);
  assert.deepEqual(read('m.md'), ['one\ntwo\n', 'one\ntwo\n'], 'control: the edit reached linux-a');
  write(plan('linux-b'), 'one\n'); // the edit undone
  rounds(w, ['linux-a', 'linux-b'], 2);
  assert.deepEqual(read('m.md'), ['one\n', 'one\n'], 'the undo reaches linux-a too');
  // linux-b undoes an edit while linux-a edits the same version further: both changes stand, and the copy is listed.
  write(plan('linux-a', 'n.md'), 'x\n');
  rounds(w, ['linux-a', 'linux-b'], 1);
  write(plan('linux-b', 'n.md'), 'x\ny\n');
  rounds(w, ['linux-a', 'linux-b'], 2);
  write(plan('linux-a', 'n.md'), 'x\ny\nz\n');
  write(plan('linux-b', 'n.md'), 'x\n');
  rounds(w, ['linux-a', 'linux-b'], 2);
  assert.deepEqual(read('n.md'), ['x\ny\nz\n', 'x\n'], 'neither machine\'s change is dropped');
  for (const m of ['linux-a', 'linux-b']) assert.ok(w.json(m, ['sync', 'status']).conflicts.some((c) => c.name === 'n.md'), `listed on ${m}`);
});

test('sync now: a run killed after its files landed still knows where they came from, and the backup restores them to the machine that made them', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  for (const m of ['linux-a', 'linux-b']) w.syncPrefs(m, { backup: { kind: 'machine', label: 'linux-b' }, exclude: { machines: ['mac', 'lab'] } });
  // Killed as it writes its manifest, once every file has landed.
  const killer = path.join(w.io, 'kill-at-manifest.cjs');
  fs.writeFileSync(killer, `
const fs = require('fs'); const open = fs.openSync;
fs.openSync = function (p, ...r) { if (/manifest\\.jsonl\\.\\d+\\.tmp$/.test(String(p))) process.kill(process.pid, 'SIGKILL'); return open.call(fs, p, ...r); };`);
  assert.equal(w.runAs('linux-b', ['sync', 'now', '--json'], {}, { node: ['--require', killer] }).signal, 'SIGKILL');
  const notes = (h) => path.join(h, '.claude', 'projects', claudeFolder(path.join(h, 'notes')), `${ID(2)}.jsonl`);
  assert.ok(fs.existsSync(notes(s.B)), 'control: linux-a\'s session landed on the backup before the kill');
  const hostA = w.json('linux-a', ['__sync-inventory', '--user', me]).host;
  const listed = w.json('linux-b', ['__sync-inventory', '--user', me]).families.transcripts.find((f) => f.name.endsWith(`${ID(2)}.jsonl`));
  assert.equal(listed.origin, hostA, 'the backup lists it as linux-a\'s, not its own');
  // linux-a is wiped, and takes its sessions back from the backup.
  const original = fs.readFileSync(notes(s.A));
  fs.rmSync(path.join(s.A, '.claude'), { recursive: true, force: true });
  w.syncPrefs('linux-a', { backup: { kind: 'machine', label: 'linux-b' }, exclude: { machines: ['mac', 'lab'] } });
  w.json('linux-a', ['sync', 'now']);
  assert.deepEqual(fs.readFileSync(notes(s.A)), original);
});

test('sync fetch evicts nothing by its index, which may be out of date: the copy it would evict can be the last one', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  rounds(w, ['linux-a', 'linux-b', 'mac'], 1);
  const here = path.join(s.M, '.claude', 'projects', claudeFolder(path.join(s.M, 'notes')), `${ID(2)}.jsonl`);
  w.json('mac', ['sync', 'fetch', ID(2)]);
  assert.ok(fs.existsSync(here), 'control: fetched');
  // linux-a is reinstalled: its copy is gone, and it cannot be reached meanwhile. The Mac's index still lists it there.
  fs.rmSync(path.join(s.A, '.claude', 'projects', claudeFolder(path.join(s.A, 'notes')), `${ID(2)}.jsonl`));
  const down = { SSH_FAKE_DOWN: 'u@linux-a', SSH_FAKE_STDERR: 'ssh: connect to host linux-a port 22: No route to host' };
  w.syncPrefs('mac', { cacheMB: 0 });
  assert.equal(w.runAs('mac', ['sync', 'fetch', ID(4), '--json'], down).status, 0);
  assert.ok(fs.existsSync(here), 'the only copy left is kept');
});

/** linux-b fetches linux-a's session 2 on demand; then, with linux-a down, the Mac fetches it from linux-b. */
function fetchedFromAFetchedCopy(w) {
  rounds(w, ['linux-a', 'linux-b', 'mac'], 1);
  w.json('linux-b', ['sync', 'fetch', ID(2)]);
  const down = { SSH_FAKE_DOWN: 'u@linux-a', SSH_FAKE_STDERR: 'ssh: connect to host linux-a port 22: No route to host' };
  w.json('mac', ['sync', 'now'], down); // the Mac's index learns linux-b's copy
  const f = w.json('mac', ['sync', 'fetch', ID(2)], down);
  assert.equal(f.from, 'linux-b', 'control: the Mac took it from linux-b, which fetched it on demand');
  return { f, down };
}

test('sync now: an on-demand copy is evicted only while the machine it came from holds one of its own, not a copy it too fetched', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  const { f, down } = fetchedFromAFetchedCopy(w);
  assert.ok(fs.existsSync(f.path), 'control: fetched');
  w.syncPrefs('mac', { cacheMB: 0 });
  w.json('mac', ['sync', 'now'], down);
  assert.ok(fs.existsSync(f.path), 'not evicted on the strength of another evictable copy');
});

test('sync fetch: a session fetched from a machine that holds only a copy it fetched lands in this machine\'s own folder for the project', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  const { f } = fetchedFromAFetchedCopy(w);
  assert.equal(f.path, path.join(s.M, '.claude', 'projects', claudeFolder(path.join(s.M, 'notes')), `${ID(2)}.jsonl`), 'by the identity linux-b recorded with its copy');
});

// A session fetched from a machine that names its directory differently lands in this machine's own folder for the
// project, where the listing leaves it out as a copy. The index holds it once, as that machine's records describe it, and
// nothing of it is published as this machine's own: another machine reading this one's log learns nothing of it.
test('sync fetch: a copy from a machine that names its directory differently is one row in the index, that machine\'s, and never published as this machine\'s', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  only(w, ['linux-a', 'mac']);
  const S = ID(33);
  conversation(s.M, s.appM, S, 'Add a retry to the flaky login test');
  assert.ok(w.json('mac', ['sessions']).sessions.some((x) => x.id === S), 'control: the Mac lists it, and its index publishes it');
  rounds(w, ['linux-a'], 1);
  const f = w.json('linux-a', ['sync', 'fetch', S]);
  assert.equal(f.from, 'mac');
  assert.equal(path.dirname(f.path), path.join(s.A, '.claude', 'projects', claudeFolder(s.appA)), 'control: it landed in linux-a\'s own folder for the project');
  const rowsOf = (machine) => {
    const r = w.runAs(machine, ['query', 'sql', `SELECT machine_id AS machine, origin, title FROM sessions WHERE session_id = '${S}' ORDER BY origin`]);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).rows;
  };
  const hA = hostOf(w, 'linux-a'), hM = hostOf(w, 'mac');
  assert.deepEqual(rowsOf('linux-a'), [{ machine: hM, origin: 'synced', title: 'Add a retry to the flaky login test' }], 'one row, the Mac\'s');
  // Its own listing leaves the copy out, from the index as from the files.
  for (const env of [{}, { OAK_INDEX: 'off' }]) assert.ok(!w.json('linux-a', ['sessions'], env).sessions.some((x) => x.id === S), JSON.stringify(env));
  // Nothing of it in linux-a's record log, so the Mac, reading that log, holds the session once: its own.
  const logA = storeOf(w, 'linux-a', 'records', hA);
  assert.ok(fs.readdirSync(logA).length, 'control: linux-a has published its records');
  assert.deepEqual(fs.readdirSync(logA).filter((n) => read(path.join(logA, n)).includes(S)), [], 'linux-a\'s record log names it nowhere');
  w.json('mac', ['sync', 'now']);
  assert.deepEqual(rowsOf('mac').map((r) => [r.machine, r.origin]), [[hM, 'local']]);
});

// The same copy resumed here is this machine's own from then on: at once, after the next run marks it changed here, and
// after the session goes back and forth, when oak sync records the file as it left it, the other machine's tail included.
// What the index recorded of its store is kept, as for any session of this machine's, when `oak clean --all` removes the
// store; nothing of it is forgotten.
test('sync fetch: a copy from a machine that names its directory differently, resumed here, is this machine\'s own, and `oak clean --all` keeps what the index recorded of it', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  only(w, ['linux-a', 'mac']);
  const S = ID(41), W = ID(42);
  const fileM = conversation(s.M, s.appM, S, 'Fix the flaky login test');
  const waitM = conversation(s.M, s.appM, W, 'Look at the flaky signup test');
  rounds(w, ['linux-a'], 1);
  const f = w.json('linux-a', ['sync', 'fetch', S]);
  const fw = w.json('linux-a', ['sync', 'fetch', W]);
  assert.deepEqual([f.from, fw.from], ['mac', 'mac'], 'control: fetched from the Mac');
  const hA = hostOf(w, 'linux-a');
  const q = (sql) => {
    const r = w.runAs('linux-a', ['query', 'sql', sql]);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).rows;
  };
  const own = (id = S) => q(`SELECT archived_reason FROM sessions WHERE session_id = '${id}' AND machine_id = '${hA}'`);
  const edits = () => q(`SELECT cleared_ms IS NOT NULL AS cleared FROM edits WHERE session_id = '${S}' AND machine_id = '${hA}'`).map((r) => r.cleared);
  const logA = () => fs.readdirSync(storeOf(w, 'linux-a', 'records', hA)).map((n) => read(path.join(storeOf(w, 'linux-a', 'records', hA), n))).join('');
  assert.deepEqual([own(), own(W)], [[], []], 'control: copies, filed nowhere here');
  // Resumed on linux-a: Claude Code appends a turn there, and OAK's hooks keep a store for it, with an edit; and for the
  // other, a store that recorded no edit, only a permission prompt's wait.
  const ts = Date.now() - 5 * 60_000;
  for (const [file, id] of [[f.path, S], [fw.path, W]]) fs.appendFileSync(file, line({ type: 'user', cwd: s.appA, sessionId: id, timestamp: new Date(ts).toISOString(), message: { role: 'user', content: 'Continue here on linux-a' } }));
  storeSession(w, 'linux-a', S, { records: [{ id: 1, uid: 'u1', ts, tool: 'Edit', file: path.join(s.appA, 'a.ts'), beforeBlob: null, afterBlob: null, status: 'kept' }] });
  const { dir: waitDir } = storeSession(w, 'linux-a', W, { records: [] });
  fs.writeFileSync(path.join(waitDir, 'attention-log.jsonl'), line({ ev: 'up', kind: 'permission', t: ts }) + line({ ev: 'down', kind: 'permission', t: ts + 1000, since: ts }));
  idle(waitDir);
  const waits = () => q(`SELECT count(*) AS n FROM waits WHERE session_id = '${W}' AND machine_id = '${hA}'`)[0].n;
  assert.deepEqual([own(), own(W)], [[{ archived_reason: null }], [{ archived_reason: null }]], 'linux-a\'s own now');
  assert.deepEqual([edits(), waits()], [[0], 1]);
  idle(path.dirname(f.path)); // the turns written a while ago: a run takes them
  const run = w.json('linux-a', ['sync', 'now']);
  assert.equal(run.status, 'ok', JSON.stringify(run.machines));
  const entry = () => read(storeOf(w, 'linux-a', 'sync', 'manifest.jsonl')).split('\n').filter((l) => l.includes(S)).map((l) => JSON.parse(l)).at(-1);
  assert.equal(entry().sha256, null, 'control: the run marked it changed here');
  // Back and forth: the Mac takes linux-a's turn and goes on, and linux-a's next run lands the Mac's turn on its copy.
  assert.equal(w.json('mac', ['sync', 'now']).status, 'ok');
  assert.ok([fileM, waitM].every((m) => read(m).includes('Continue here on linux-a')), 'control: the Mac took linux-a\'s turns');
  for (const [m, id] of [[fileM, S], [waitM, W]]) fs.appendFileSync(m, line({ type: 'user', cwd: s.appM, sessionId: id, timestamp: new Date(Date.now() - 4 * 60_000).toISOString(), message: { role: 'user', content: 'And back on the Mac' } }));
  idle(path.dirname(fileM));
  assert.equal(w.json('linux-a', ['sync', 'now']).status, 'ok');
  assert.ok([f.path, fw.path].every((p) => read(p).includes('And back on the Mac')), 'control: the Mac\'s turns landed on linux-a\'s copies');
  const landed = entry(), st = fs.statSync(f.path);
  assert.deepEqual([landed.origin, typeof landed.sha256, landed.size === st.size && landed.mtime === Math.floor(st.mtimeMs)], [hostOf(w, 'mac'), 'string', true],
    'control: oak sync records the file as it left it, a copy of the Mac\'s by its manifest alone');
  assert.deepEqual(own(), [{ archived_reason: null }], 'still linux-a\'s own');
  // The store goes, the transcript stays: still linux-a's own, its edit kept as cleared, and nothing of it forgotten.
  assert.equal(w.runAs('linux-a', ['clean', '--all']).status, 0);
  assert.deepEqual([own(), own(W)], [[{ archived_reason: null }], [{ archived_reason: null }]], 'still linux-a\'s own, both');
  assert.deepEqual([edits(), waits()], [[1], 1], 'its edit kept, cleared, and the other\'s wait');
  for (const id of [S, W]) assert.ok(!logA().includes(JSON.stringify({ t: 'sessions', d: { session_id: id } })), `no removal of ${id} published`);
});
// The simulator's sessions (`oak demo`) are never another machine's. This build copies none of a demo's stores (the
// test below), but one from before it may have left copies of a running demo's among the replicas: no index files them,
// before the demo's cleanup there or after.
test('sync store: copies of another machine\'s demo an earlier build left here are never indexed', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  only(w, ['linux-a', 'linux-b']);
  rounds(w, ['linux-a', 'linux-b'], 1);
  assert.equal(w.runAs('linux-a', ['demo', '--fast'], {}, { cwd: s.appA }).status, 0);
  const demo = fs.readdirSync(storeOf(w, 'linux-a')).filter((n) => /^demo-[0-9a-f]{8}$/.test(n));
  assert.ok(demo.length, 'control: the demo runs on linux-a');
  const indexed = (glob) => {
    const r = w.runAs('linux-b', ['query', 'sql', `SELECT count(*) AS n FROM sessions WHERE session_id GLOB '${glob}'`]);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).rows[0].n;
  };
  // Planted as such a build left them, beside the copy of an ordinary session's store, which is indexed (the control
  // that a planted copy is read).
  const replicas = storeOf(w, 'linux-b', 'sync', 'replicas', hostOf(w, 'linux-a'));
  for (const id of demo) fs.cpSync(storeOf(w, 'linux-a', id), path.join(replicas, id), { recursive: true });
  storeSession(w, 'linux-a', 'sess-plain', { records: [{ id: 1, file: '/a' }] });
  fs.cpSync(storeOf(w, 'linux-a', 'sess-plain'), path.join(replicas, 'sess-plain'), { recursive: true });
  assert.equal(indexed('sess-plain'), 1, 'control: a planted copy is read');
  assert.equal(indexed('demo-*'), 0, 'linux-b indexes none of them');
  assert.equal(w.runAs('linux-a', ['demo', '--clean'], {}, { cwd: s.appA }).status, 0);
  rounds(w, ['linux-a', 'linux-b'], 1);
  assert.equal(indexed('demo-*'), 0, 'nor after the cleanup');
});

test('sync now: a delete that cannot be applied here is said, and the run goes on', { skip: POSIX || (process.getuid?.() === 0 && 'root writes anywhere') }, (t) => {
  const w = world(t);
  const s = seed(w);
  for (const m of ['linux-a', 'linux-b']) w.syncPrefs(m, { backup: { kind: 'machine', label: 'linux-b' }, exclude: { machines: ['mac', 'lab'] } });
  write(path.join(s.A, '.claude', 'plans', 'gone.md'), 'remove me\n');
  rounds(w, ['linux-a', 'linux-b'], 1);
  // linux-b's plans folder cannot be written; linux-a removes a plan and starts a session.
  const plansB = path.join(s.B, '.claude', 'plans');
  fs.chmodSync(plansB, 0o555);
  try {
    fs.rmSync(path.join(s.A, '.claude', 'plans', 'gone.md'));
    transcript(s.A, path.join(s.A, 'notes'), ID(50));
    w.json('linux-a', ['sync', 'now']);
    const r = w.runAs('linux-b', ['sync', 'now', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.ok(out.warnings.some((x) => /was not applied here: plans:gone\.md/.test(x)), JSON.stringify(out.warnings));
    assert.ok(fs.existsSync(path.join(s.B, '.claude', 'projects', claudeFolder(path.join(s.B, 'notes')), `${ID(50)}.jsonl`)), 'the rest of the run happened');
    assert.ok(w.json('linux-b', ['sync', 'status']).last.warnings.some((x) => /was not applied here/.test(x)), 'and status says so');
  } finally {
    fs.chmodSync(plansB, 0o755);
  }
});

test('sync now: what is written here while sync merges or copies a text file is never overwritten', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  for (const m of ['linux-a', 'linux-b']) w.syncPrefs(m, { exclude: { machines: ['mac', 'lab'] } });
  write(path.join(s.A, '.claude', 'plans', 'm.md'), 'one\ntwo\nthree\nfour\n');
  rounds(w, ['linux-a', 'linux-b'], 1);
  write(path.join(s.A, '.claude', 'plans', 'm.md'), 'ONE\ntwo\nthree\nfour\n');
  write(path.join(s.B, '.claude', 'plans', 'm.md'), 'one\ntwo\nthree\nFOUR\n');
  write(path.join(s.A, '.claude', 'plans', 'new.md'), 'from linux-a\n');
  // A person, or Claude Code, writes each file on linux-b while sync is writing its result beside it. The temporary
  // file's name does not say which file it is for; what sync writes in it does: linux-a's new plan, or the merge.
  const racer = path.join(w.io, 'racer.cjs');
  fs.writeFileSync(racer, `
const fs = require('fs'); const path = require('path'); const open = fs.openSync; const fsync = fs.fsyncSync; const wf = fs.writeFileSync; const rf = fs.readFileSync; const paths = new Map();
fs.openSync = function (p, ...r) { const fd = open.call(fs, p, ...r); paths.set(fd, String(p)); return fd; };
fs.fsyncSync = function (fd) {
  const p = paths.get(fd) || '';
  if (/\\/plans\\/\\.oak-sync-[0-9a-f]+\\.tmp$/.test(p)) {
    const made = rf.call(fs, p, 'utf8') === 'from linux-a\\n';
    wf.call(fs, path.join(path.dirname(p), made ? 'new.md' : 'm.md'), made ? 'MADE HERE MEANWHILE\\n' : 'EDITED HERE MEANWHILE\\n');
  }
  return fsync.call(fs, fd);
};`);
  const r = w.runAs('linux-b', ['sync', 'now', '--json'], {}, { node: ['--require', racer] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(s.B, '.claude', 'plans', 'm.md'), 'utf8'), 'EDITED HERE MEANWHILE\n');
  assert.equal(fs.readFileSync(path.join(s.B, '.claude', 'plans', 'new.md'), 'utf8'), 'MADE HERE MEANWHILE\n');
  const skipped = JSON.parse(r.stdout).done.filter((d) => d.action === 'skipped').map((d) => d.to).sort();
  assert.deepEqual(skipped, ['m.md', 'new.md'], 'each left for the next run, and said');
  // The next run merges the edit made here with linux-a's.
  w.json('linux-b', ['sync', 'now']);
  assert.equal(fs.readFileSync(path.join(s.B, '.claude', 'plans', 'new.md'), 'utf8'), 'MADE HERE MEANWHILE\n', 'no newer copy wins');
});

test('sync now: a line written here just after a pull lands is not taken for part of it, and the session goes on syncing', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  for (const m of ['linux-a', 'linux-b']) w.syncPrefs(m, { backup: { kind: 'machine', label: 'linux-b' }, exclude: { machines: ['mac', 'lab'] } });
  // Claude Code on linux-b appends to the session the moment sync has put it in place.
  const racer = path.join(w.io, 'append-after.cjs');
  fs.writeFileSync(racer, `
const fs = require('fs'); const rename = fs.renameSync; const ap = fs.appendFileSync;
fs.renameSync = function (a, b) { const r = rename.call(fs, a, b); if (String(b).endsWith('${ID(2)}.jsonl') && String(b).includes('/projects/')) ap.call(fs, b, '{"type":"user","message":{"content":"written here just after"}}\\n'); return r; };`);
  w.runAs('linux-b', ['sync', 'now', '--json'], {}, { node: ['--require', racer] });
  w.json('linux-a', ['sync', 'now']);
  const notesA = path.join(s.A, '.claude', 'projects', claudeFolder(path.join(s.A, 'notes')), `${ID(2)}.jsonl`);
  assert.ok(fs.readFileSync(notesA, 'utf8').includes('written here just after'), 'control: linux-a took the line linux-b added');
  fs.appendFileSync(notesA, line({ type: 'assistant', message: { content: 'and linux-a went on' } }));
  // While the session on linux-b is still being written (its last line under a minute old), nothing lands on it.
  const notesB = path.join(s.B, '.claude', 'projects', claudeFolder(path.join(s.B, 'notes')), `${ID(2)}.jsonl`);
  assert.deepEqual(w.json('linux-b', ['sync', 'now']).done.filter((d) => d.to.endsWith(`${ID(2)}.jsonl`)).map((d) => d.action), ['skipped']);
  // A minute on, it is still: the next run takes linux-a's line after linux-b's own.
  fs.utimesSync(notesB, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  const r = w.json('linux-b', ['sync', 'now']);
  assert.deepEqual(r.done.filter((d) => d.to.endsWith(`${ID(2)}.jsonl`)).map((d) => d.action), ['append'], 'no false divergence');
  assert.deepEqual(fs.readFileSync(notesB), fs.readFileSync(notesA));
});

test('sync now: one file here that cannot be read fails alone; the rest from the same machine lands', { skip: POSIX || (process.getuid?.() === 0 && 'root reads anything') }, (t) => {
  const w = world(t);
  const s = seed(w);
  for (const m of ['linux-a', 'linux-b']) w.syncPrefs(m, { backup: { kind: 'machine', label: 'linux-b' }, exclude: { machines: ['mac', 'lab'] } });
  rounds(w, ['linux-b'], 1);
  const notesA = path.join(s.A, '.claude', 'projects', claudeFolder(path.join(s.A, 'notes')), `${ID(2)}.jsonl`);
  const notesB = path.join(s.B, '.claude', 'projects', claudeFolder(path.join(s.B, 'notes')), `${ID(2)}.jsonl`);
  fs.appendFileSync(notesA, line({ type: 'user', message: { content: 'more' } }));
  transcript(s.A, path.join(s.A, 'notes'), ID(51));
  // linux-b's copy has a new time (so its recorded hash is not reused; two minutes back, as a session running here is
  // left alone anyway) and cannot be read.
  fs.utimesSync(notesB, new Date(), new Date(Date.now() - 120_000));
  fs.chmodSync(notesB, 0o000);
  let r;
  try {
    r = w.json('linux-b', ['sync', 'now']);
  } finally {
    fs.chmodSync(notesB, 0o600);
  }
  assert.ok(r.machines.find((m) => m.label === 'linux-a').errors.some((e) => e.includes(`${ID(2)}.jsonl`) && /EACCES/.test(e)), JSON.stringify(r.machines));
  assert.ok(fs.existsSync(path.join(s.B, '.claude', 'projects', claudeFolder(path.join(s.B, 'notes')), `${ID(51)}.jsonl`)), 'the other session landed');
});

test('sync now: a stale lock is broken by one run, not by two at once', { skip: POSIX }, async (t) => {
  const w = world(t);
  seed(w);
  w.syncPrefs('linux-a', { exclude: { machines: ['mac', 'lab'] } });
  // The lock of a run that was killed: its process is gone.
  const dead = cp.spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  fs.mkdirSync(w.store('linux-a'), { recursive: true });
  fs.writeFileSync(w.store('linux-a', 'now.lock'), JSON.stringify({ pid: Number(dead), at: Date.now() - 1000 }));
  // The first run is held up just as it removes that lock; a second starts then. linux-b answers slowly, so the
  // second is still running when the first goes on.
  const marker = path.join(w.io, 'breaking');
  const slowBreak = path.join(w.io, 'slow-break.cjs');
  fs.writeFileSync(slowBreak, `
const fs = require('fs'); const rm = fs.rmSync; let once = false;
fs.rmSync = function (p, ...r) { if (!once && String(p).endsWith('now.lock')) { once = true; fs.writeFileSync(${JSON.stringify(marker)}, '1'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500); } return rm.call(fs, p, ...r); };`);
  const slow = path.join(w.io, 'slow.cjs');
  fs.writeFileSync(slow, 'const end = Date.now() + 2500; while (Date.now() < end) {}\n');
  w.oakWrapper('linux-b', [slow]);
  const first = w.startAs('linux-a', ['sync', 'now', '--json'], {}, { node: ['--require', slowBreak] });
  for (let i = 0; i < 400 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(fs.existsSync(marker), 'control: the first run is breaking the stale lock');
  const second = w.startAs('linux-a', ['sync', 'now', '--json']);
  const statuses = (await Promise.all([first, second])).map((r) => JSON.parse(r.stdout).status);
  assert.deepEqual(statuses.filter((x) => x === 'busy').length, 1, `one run, the other busy: ${statuses}`);
});

test('sync now: a run that found the lock stale goes away busy when another broke it and took it first', { skip: POSIX }, async (t) => {
  const w = world(t);
  seed(w);
  w.syncPrefs('linux-a', { exclude: { machines: ['mac', 'lab'] } });
  const dead = cp.spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  fs.mkdirSync(w.store('linux-a'), { recursive: true });
  fs.writeFileSync(w.store('linux-a', 'now.lock'), JSON.stringify({ pid: Number(dead), at: Date.now() - 1000 }));
  // The first run finds the lock stale and is held up before it breaks it; meanwhile a second breaks it and takes it,
  // and is still running (linux-b answers slowly) when the first goes on.
  const marker = path.join(w.io, 'judged');
  const late = path.join(w.io, 'late-break.cjs');
  fs.writeFileSync(late, `
const fs = require('fs'); const open = fs.openSync; const rm = fs.rmSync; let once = false;
const hold = () => { if (once) return; once = true; fs.writeFileSync(${JSON.stringify(marker)}, '1'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500); };
fs.openSync = function (p, ...r) { if (String(p).endsWith('now.lock.break')) hold(); return open.call(fs, p, ...r); };
fs.rmSync = function (p, ...r) { if (String(p).endsWith('now.lock')) hold(); return rm.call(fs, p, ...r); };`);
  const slow = path.join(w.io, 'slow.cjs');
  fs.writeFileSync(slow, 'const end = Date.now() + 2500; while (Date.now() < end) {}\n');
  w.oakWrapper('linux-b', [slow]);
  const first = w.startAs('linux-a', ['sync', 'now', '--json'], {}, { node: ['--require', late] });
  for (let i = 0; i < 400 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(fs.existsSync(marker), 'control: the first run judged the lock stale');
  const second = w.startAs('linux-a', ['sync', 'now', '--json']);
  const statuses = (await Promise.all([first, second])).map((r) => JSON.parse(r.stdout).status);
  assert.deepEqual(statuses.filter((x) => x === 'busy').length, 1, `one run, the other busy: ${statuses}`);
});

test('sync: text in another encoding than UTF-8 merges byte for byte', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  for (const m of ['linux-a', 'linux-b']) w.syncPrefs(m, { exclude: { machines: ['mac', 'lab'] } });
  const latin1 = (text) => Buffer.from(text, 'latin1');
  const pa = path.join(s.A, '.claude', 'plans', 'cafe.md'), pb = path.join(s.B, '.claude', 'plans', 'cafe.md');
  fs.writeFileSync(pa, latin1('café\ntwo\nthree\nfour\n'));
  rounds(w, ['linux-a', 'linux-b'], 1);
  fs.writeFileSync(pa, latin1('café one\ntwo\nthree\nfour\n'));
  fs.writeFileSync(pb, latin1('café\ntwo\nthree\nFOUR\n'));
  rounds(w, ['linux-a', 'linux-b'], 1);
  for (const f of [pa, pb]) assert.deepEqual(fs.readFileSync(f), latin1('café one\ntwo\nthree\nFOUR\n'), f);
});

test('sync now: a diverged session whose copy is deleted (this machine\'s stands) stays dismissed until the other copy changes', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  w.syncPrefs('linux-b', { backup: { kind: 'machine', label: 'linux-b' } });
  const fileA = path.join(s.A, '.claude', 'projects', claudeFolder(s.appA), `${ID(1)}.jsonl`);
  fs.appendFileSync(fileA, line({ type: 'assistant', message: { content: 'went left' } }) + line({ type: 'user', message: { content: 'and further than linux-b' } }));
  w.json('linux-b', ['sync', 'now']);
  const c = w.json('linux-b', ['sync', 'status']).conflicts.find((x) => x.family === 'transcripts');
  assert.ok(c, 'control: raised');
  fs.rmSync(c.copy);
  assert.deepEqual(w.json('linux-b', ['sync', 'now']).done.filter((d) => d.family === 'transcripts'), [], 'not fetched again');
  assert.deepEqual(w.json('linux-b', ['sync', 'status']).conflicts.filter((x) => x.family === 'transcripts'), [], 'nor listed');
  // linux-a's copy goes on: a new version, raised anew.
  fs.appendFileSync(fileA, line({ type: 'user', message: { content: 'later' } }));
  assert.ok(w.json('linux-b', ['sync', 'now']).done.some((d) => d.family === 'transcripts' && d.action === 'conflict'));
});

/** A hook event of session `id` on `machine`, through the real capture entry. */
function hookOn(w, machine, id, event, extra = {}) {
  const r = w.runAs(machine, ['capture'], {}, { input: JSON.stringify({ session_id: id, hook_event_name: event, cwd: w.homes[machine], ...extra }) });
  assert.equal(r.status, 0, r.stderr);
  return Date.now();
}

/** Wait until a permission prompt raised at `raised` has stood its wait on its machine (notify.ts PERMISSION_GRACE_MS),
 *  after which that machine publishes it (index ingest.ts ingestAttention). */
function pastGrace(raised) {
  const left = raised + 5300 - Date.now();
  if (left > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, left);
}

// A raised hand travels with the other records: another machine's inbox, listing and phase show it, labelled with the
// label that machine saved it under, until the hand comes down there; never as a session of this machine's own.
test('sync: a raised hand travels: other machines list it, labelled and timed, its phase follows it, and it comes down with its machine\'s', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  only(w, ['linux-a', 'linux-b', 'mac']);
  const S = ID(50);
  const onMac = conversation(s.M, s.appM, S, 'Profile the nightly import');
  // Active two minutes ago: a session the phase's five-minute window would call working.
  const recent = new Date(Date.now() - 2 * 60_000);
  fs.utimesSync(onMac, recent, recent);
  const raised = hookOn(w, 'mac', S, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' }, transcript_path: onMac });
  // linux-b's session at a path both machines share, waiting for input, which linux-a then fetches: a session pulled
  // here, filed under linux-b, whose first catch-up here keeps the hand linux-b's records brought.
  const shared = path.join(w.W, 'shared', 'proj');
  fs.mkdirSync(shared, { recursive: true });
  const P = ID(51);
  conversation(s.B, shared, P, 'Tidy the shared scripts');
  hookOn(w, 'linux-b', P, 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
  for (const m of ['mac', 'linux-b']) w.json(m, ['sessions']); // each lists, which publishes its records
  rounds(w, ['linux-a'], 1);
  assert.equal(w.json('linux-a', ['sync', 'fetch', P]).from, 'linux-b', 'control: fetched');
  const hostM = hostOf(w, 'mac'), hostB = hostOf(w, 'linux-b');
  // A permission prompt is published once it has stood its wait there, as that machine announces it (one answered at
  // once never travels); an input wait at once.
  assert.deepEqual(w.json('linux-a', ['inbox']).hands.filter((h) => h.origin === 'synced').map((h) => h.id), [P], 'inside its wait, the prompt has not travelled');
  pastGrace(raised);
  w.json('mac', ['sessions']);
  rounds(w, ['linux-a'], 1);
  const inbox = w.json('linux-a', ['inbox']);
  const hand = inbox.hands.find((h) => h.id === S);
  assert.ok(hand, JSON.stringify(inbox.hands));
  assert.deepEqual([hand.origin, hand.host, hand.machine, hand.kind, hand.message, hand.title], ['synced', hostM, 'mac', 'permission', 'Bash', 'Profile the nightly import']);
  assert.ok(typeof hand.syncedAt === 'number' && typeof hand.publishedAt === 'number', JSON.stringify(hand));
  // The pulled session's hand waits on linux-b, and is never listed as one of this machine's.
  assert.deepEqual(inbox.hands.filter((h) => h.id === P).map((h) => [h.origin, h.host, h.machine, h.kind]), [['synced', hostB, 'linux-b', 'input']]);
  const listing = w.json('linux-a', ['sessions']);
  assert.equal(listing.sessions.find((r) => r.id === P)?.attention ?? null, null, 'control: the copy is listed here, without the hand');
  assert.deepEqual(listing.syncedHands.map((h) => [h.id, h.machine]).sort(), [[S, 'mac'], [P, 'linux-b']], 'the listing every surface polls carries them');
  assert.equal(inbox.next === S || inbox.next === P, false, 'the next hand to jump to is one of this machine\'s own');
  assert.equal(w.json('linux-a', ['inbox', '--next']).next, null, 'and the jump the surfaces make goes to none of theirs');
  // It says where they wait instead: both on other machines (`elsewhere`, which JetBrains reads), and `oak inbox` lists them.
  assert.equal(w.json('linux-a', ['inbox', '--next']).elsewhere, 2);
  assert.equal(w.runAs('linux-a', ['inbox', '--next']).stdout, 'nobody here is waiting on you · 2 on other machines: `oak inbox` lists them\n');
  assert.match(w.runAs('linux-a', ['inbox']).stdout, new RegExp(`permission {2}Profile the nightly import {2}.+ — Bash .+ {2}on mac, as synced ${CLOCK}\\n`));
  // Its phase follows the hand, in the index's view and in the listing of every machine.
  const phase = (id) => w.json('linux-a', ['query', 'sql', 'SELECT phase FROM session_phase WHERE session_id = ?', '--param', id]).rows[0]?.phase;
  assert.equal(phase(S), 'awaiting-permission');
  const row = w.json('linux-a', ['sessions', '--synced']).machines.find((m) => m.label === 'mac').sessions.find((r) => r.id === S);
  assert.deepEqual([row.attention?.kind, row.phase], ['permission', 'awaiting-permission']);
  // The turn ends there: done, though active two minutes ago, never working while that hand is up.
  hookOn(w, 'mac', S, 'Stop');
  w.json('mac', ['sessions']);
  rounds(w, ['linux-a'], 1);
  assert.equal(phase(S), 'done');
  assert.ok(w.json('linux-a', ['inbox']).hands.some((h) => h.id === S && h.kind === 'idle-done'), 'control: listed with the done rows');
  assert.equal(w.json('linux-a', ['inbox', '--no-done']).hands.some((h) => h.id === S), false, 'a turn\'s end only with the done rows');
  // The next prompt lowers it there, and here once its records come over.
  hookOn(w, 'mac', S, 'UserPromptSubmit');
  w.json('mac', ['sessions']);
  rounds(w, ['linux-a'], 1);
  assert.equal(w.json('linux-a', ['inbox']).hands.some((h) => h.id === S), false, 'lowered there, gone here');
  assert.equal(phase(S), 'working', 'control: active two minutes ago, with no hand up');
});

// One session id with a hand on two machines (a session resumed on both): the jump goes to this machine's own, and the row
// it carries is this machine's, never the other machine's hand on the same id, however much more urgent that one is.
test('sync: `oak inbox --next` carries this machine\'s own hand when another machine raised one on the same session id', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  only(w, ['linux-a', 'mac']);
  const S = ID(60);
  conversation(s.M, s.appM, S, 'Resume the import fix');
  const raised = hookOn(w, 'mac', S, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
  conversation(s.A, s.appA, S, 'Resume the import fix');
  hookOn(w, 'linux-a', S, 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
  pastGrace(raised);
  w.json('mac', ['sessions']);
  rounds(w, ['linux-a'], 1);
  const inbox = w.json('linux-a', ['inbox']);
  assert.deepEqual(inbox.hands.filter((h) => h.id === S).map((h) => [h.kind, h.origin ?? 'own']), [['permission', 'synced'], ['input', 'own']], 'control: both, the other machine\'s first');
  const next = w.json('linux-a', ['inbox', '--next']);
  assert.equal(next.next, S);
  assert.deepEqual([next.hand?.kind, next.hand?.origin], ['input', undefined], JSON.stringify(next.hand));
  assert.equal(next.elsewhere, 1);
});

// A session pulled here and resumed here raises this machine's own hand, which its machine's records of that session's hand
// never replace or lower. A copy evicted here hides none of its machine's hands. And a read whose catch-up is left to
// another process (one holding the index's lease) still lists the other machines' hands, which only the index holds.
test('sync: hands on a session pulled here: this machine\'s own stays; an evicted copy hides none of theirs; a read left to another catch-up lists them', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  only(w, ['linux-a', 'linux-b']);
  const shared = path.join(w.W, 'shared', 'proj2');
  fs.mkdirSync(shared, { recursive: true });
  const P = ID(65), Q = ID(66);
  conversation(s.B, shared, P, 'Tidy the shared helper');
  conversation(s.B, shared, Q, 'Rename the shared constants');
  hookOn(w, 'linux-b', Q, 'Notification', { notification_type: 'idle_prompt', message: 'Q waits on linux-b' });
  w.json('linux-b', ['sessions']);
  rounds(w, ['linux-a'], 1);
  for (const id of [P, Q]) assert.equal(w.json('linux-a', ['sync', 'fetch', id]).from, 'linux-b', 'control: fetched');
  const hands = (id) => w.json('linux-a', ['inbox']).hands.filter((h) => h.id === id).map((h) => [h.kind, h.message, h.origin ?? 'own']);
  // P resumed here: its hand is this machine's.
  hookOn(w, 'linux-a', P, 'Notification', { notification_type: 'idle_prompt', message: 'P waits here' });
  assert.deepEqual(hands(P), [['input', 'P waits here', 'own']], 'control: this machine\'s own hand');
  hookOn(w, 'linux-b', P, 'Notification', { notification_type: 'idle_prompt', message: 'P waits on linux-b' });
  w.json('linux-b', ['sessions']);
  rounds(w, ['linux-a'], 1);
  assert.deepEqual(hands(P), [['input', 'P waits here', 'own']], 'its machine\'s hand replaces none of this one\'s');
  hookOn(w, 'linux-b', P, 'UserPromptSubmit');
  w.json('linux-b', ['sessions']);
  rounds(w, ['linux-a'], 1);
  assert.deepEqual(hands(P), [['input', 'P waits here', 'own']], 'nor does its lowering lower this one');
  // Q's copy, left as it landed, is evicted here: Q's hand still waits on linux-b, and is listed.
  assert.deepEqual(hands(Q), [['input', 'Q waits on linux-b', 'synced']], 'control: linux-b\'s hand');
  only(w, ['linux-a', 'linux-b'], { cacheMB: 0 });
  const evicted = w.json('linux-a', ['sync', 'now']);
  assert.ok(evicted.warnings.some((x) => /evicted/.test(x)), `control: copies evicted: ${JSON.stringify(evicted.warnings)}`);
  assert.deepEqual(hands(Q), [['input', 'Q waits on linux-b', 'synced']], 'the evicted copy hides none of its machine\'s hands');
  // Another process holds the lease while there is work left to catch up: `oak inbox` lists this machine's own from the
  // files, and the other machines' from the index as it stands.
  fs.utimesSync(fs.readdirSync(path.join(s.A, '.claude', 'projects', claudeFolder(s.appA))).filter((n) => n.endsWith('.jsonl')).map((n) => path.join(s.A, '.claude', 'projects', claudeFolder(s.appA), n))[0], new Date(), new Date());
  const dir = path.join(s.A, '.claude', 'claude-observatory-index');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dir, fs.readdirSync(dir).find((n) => /^index-v1-.*\.sqlite$/.test(n))));
  db.prepare('UPDATE lease SET holder = ?, pid = ?, until_ms = ? WHERE id = 1').run('another-catch-up', process.pid, Date.now() + 10 * 60_000);
  db.close();
  const shadow = w.runAs('linux-a', ['query', 'sessions', '--limit', '1']);
  assert.equal(JSON.parse(shadow.stdout).freshness.caughtUp, false, 'control: the catch-up is left to the lease\'s holder');
  assert.deepEqual(hands(Q), [['input', 'Q waits on linux-b', 'synced']], 'listed all the same');
  assert.equal(w.json('linux-a', ['inbox', '--next']).elsewhere, 1);
});

// A question reads the same on every machine: the hand its hooks record (an input wait here) is published as the
// surfaces there read it, a question named by its header, from the transcript's unanswered AskUserQuestion. A hand up for
// more than a day is taken for abandoned, as the desktop's claims and a machine's liveness take it, and is not listed.
test('sync: a question travels as a question, named by its header; a hand up for over a day is listed nowhere else', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  only(w, ['linux-a', 'mac']);
  const S = ID(67), O = ID(68);
  const file = conversation(s.M, s.appM, S, 'Add a backoff');
  fs.appendFileSync(file, line({ type: 'assistant', cwd: s.appM, sessionId: S, timestamp: new Date().toISOString(), message: { id: 'msg-q', role: 'assistant', model: 'claude-opus-4-8',
    content: [{ type: 'tool_use', id: 'toolu_q1', name: 'AskUserQuestion', input: { questions: [{ question: 'Which backoff?', header: 'Backoff', multiSelect: false,
      options: [{ label: 'Exponential', description: '' }, { label: 'Linear', description: '' }] }] } }], usage: { input_tokens: 1, output_tokens: 1 } } }));
  hookOn(w, 'mac', S, 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input', transcript_path: file });
  assert.deepEqual(w.json('mac', ['inbox']).hands.filter((h) => h.id === S).map((h) => [h.kind, h.message]), [['question', 'Backoff']], 'control: its machine reads a question');
  conversation(s.M, s.appM, O, 'An old wait');
  hookOn(w, 'mac', O, 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
  const hand = storeOf(w, 'mac', O, 'attention.json');
  fs.writeFileSync(hand, JSON.stringify({ ...JSON.parse(fs.readFileSync(hand, 'utf8')), ts: Date.now() - 25 * 3600_000 }));
  w.json('mac', ['sessions']);
  rounds(w, ['linux-a'], 1);
  const there = w.json('linux-a', ['inbox']).hands.filter((h) => h.origin === 'synced');
  assert.deepEqual(there.filter((h) => h.id === S).map((h) => [h.kind, h.message, h.machine]), [['question', 'Backoff', 'mac']]);
  assert.equal(w.json('linux-a', ['query', 'sql', 'SELECT phase FROM session_phase WHERE session_id = ?', '--param', S]).rows[0]?.phase, 'awaiting-input');
  assert.equal(w.json('linux-a', ['query', 'sql', 'SELECT count(*) AS n FROM attention WHERE session_id = ?', '--param', O]).rows[0].n, 1, 'control: the old hand came over');
  assert.equal(there.some((h) => h.id === O), false, 'but is not listed');
});

// A machine publishes its records when work happens, not only when something reads it: the machine a run asks catches
// its index up first (`__sync-inventory --publish`), so a fresh setup brings every machine's sessions on its first run,
// with nothing listed anywhere, and a hand raised since comes with the next. A plan never does: it changes nothing.
test('sync now: the machine asked publishes first: a first run brings sessions nothing listed, and a hand raised since', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  only(w, ['linux-a', 'mac']);
  const S = ID(52);
  const onMac = conversation(s.M, s.appM, S, 'Cache the parsed date formats');
  const macIndex = path.join(w.homes.mac, '.claude', 'claude-observatory-index');
  const macRecords = path.join(w.homes.mac, '.claude', 'claude-observatory', 'records');
  assert.equal(fs.existsSync(macIndex) || fs.existsSync(macRecords), false, 'control: nothing on the Mac has read its index');
  // A plan asks the Mac too, and leaves it as it was.
  w.json('linux-a', ['sync', 'plan']);
  assert.equal(fs.existsSync(macIndex) || fs.existsSync(macRecords), false, 'a plan publishes nothing');
  rounds(w, ['linux-a'], 1);
  const macSession = () => w.json('linux-a', ['query', 'sessions', '--machine', hostOf(w, 'mac')]).rows.find((r) => r.id === S);
  assert.equal(macSession()?.title, 'Cache the parsed date formats', 'the first run brought it, nothing having listed it');
  const raised = hookOn(w, 'mac', S, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm run import' }, transcript_path: onMac });
  const hands = () => w.json('linux-a', ['inbox']).hands.filter((h) => h.id === S).map((h) => [h.machine, h.kind, h.message]);
  rounds(w, ['linux-a'], 1);
  assert.deepEqual(hands(), [], 'a permission prompt inside its wait there (it may be answered at once) is not published yet');
  pastGrace(raised);
  rounds(w, ['linux-a'], 1);
  assert.deepEqual(hands(), [['mac', 'permission', 'Bash']], 'and once it has stood its wait, with the next run, though nothing changed there since');
  // With no run to ask it, the background build a hook starts publishes the next prompt itself, once that is due: it
  // waits it out (a backup folder alone carries what it published).
  const recordsOf = () => fs.readdirSync(path.join(macRecords, hostOf(w, 'mac'))).map((f) => fs.readFileSync(path.join(macRecords, hostOf(w, 'mac'), f), 'utf8')).join('');
  hookOn(w, 'mac', S, 'PermissionRequest', { tool_name: 'Edit', tool_input: { file_path: path.join(s.appM, 'x.ts') }, transcript_path: onMac });
  const started = Date.now();
  const build = w.runAs('mac', ['__index-build']);
  assert.equal(build.status, 0, build.stderr);
  assert.ok(Date.now() - started >= 4000, `it waited for the prompt to be due (${Date.now() - started} ms)`);
  assert.match(recordsOf(), /"t":"attention","r":\{[^}]*"message":"Edit"/, 'published to its record log');
});

// A build waiting for a prompt ends once the prompt is down: the hook that lowered it started a build of its own. One
// build a prompt slept out the whole wait, and they piled up (a Codex session under Auto-review, a tool call every 2 s,
// kept 30 asleep at once for 90 s each).
test('index build: a build waiting for a permission prompt ends once the prompt is down, not at the end of its wait', { skip: POSIX }, async (t) => {
  const w = world(t);
  const s = seed(w);
  const S = ID(59);
  const onMac = conversation(s.M, s.appM, S, 'Answer the prompt');
  const raised = hookOn(w, 'mac', S, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' }, transcript_path: onMac });
  let ended = false;
  const build = w.startAs('mac', ['__index-build']).then((r) => ((ended = true), r));
  // Its pass finds the prompt inside its wait (5 s) and waits.
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(ended, false, 'control: it waits for the prompt');
  hookOn(w, 'mac', S, 'UserPromptSubmit', { prompt: 'go on', transcript_path: onMac });
  const done = await build;
  assert.equal(done.status, 0, done.stderr);
  assert.ok(Date.now() - raised < 4500, `it ended once the prompt was down (${Date.now() - raised} ms after it went up)`);
});

// The capture hooks start that catch-up in the background (a hook never opens the index), at most once a minute.
test('capture hooks start a background catch-up of the local index, detached, at most once a minute, never under OAK_NO_BACKGROUND', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  const recorder = path.join(root, 'packages/tui/test/fixtures/spawn-recorder.cjs');
  const log = path.join(w.io, 'spawns.jsonl');
  const builds = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.args.at(-1) === '__index-build') : []);
  const hook = (event, extra = {}) => {
    const r = w.runAs('linux-a', ['capture'], { OAK_SPAWN_LOG: log, OAK_NO_BACKGROUND: '', ...extra }, { node: ['--require', recorder],
      input: JSON.stringify({ session_id: ID(53), hook_event_name: event, cwd: w.homes['linux-a'] }) });
    assert.equal(r.status, 0, r.stderr);
  };
  // What the build publishes is for the other machines: until oak sync has run here, a hook starts none.
  hook('UserPromptSubmit');
  assert.equal(builds().length, 0, 'none before oak sync has run here');
  write(w.store('linux-a', 'status.json'), JSON.stringify({ syncNow: 1, at: Date.now() - 3600_000, status: 'ok', machines: [] }));
  hook('UserPromptSubmit');
  assert.equal(builds().length, 1, 'the first hook once it has starts one');
  assert.equal(builds()[0].detached, true);
  assert.ok(builds()[0].args[0].endsWith(path.join('dist', 'cli.js')), 'through the full CLI beside the capture bundle');
  hook('PostToolUse');
  assert.equal(builds().length, 1, 'once a minute at most');
  // A hook that raised a hand (a turn's end here) starts one whatever the minute's claim: the build that claim stands for
  // may have read the session before the hand went up.
  hook('Stop');
  assert.equal(builds().length, 2, 'a hand raised starts one at once');
  const claim = path.join(w.homes['linux-a'], '.claude', 'claude-observatory-index', 'build.kick');
  fs.rmSync(claim);
  hook('Notification', { OAK_NO_BACKGROUND: '1' });
  assert.equal(builds().length, 2, 'none under OAK_NO_BACKGROUND');
  hook('UserPromptSubmit', { OAK_INDEX: 'off' });
  assert.equal(builds().length, 2, 'none under OAK_INDEX=off');
  hook('PostToolUse');
  assert.equal(builds().length, 3, 'control: due again');
  // A build that cannot open the index (here one a newer OAK wrote) holds the next off for an hour, not a doomed process
  // a minute, a hand moved or not.
  assert.equal(w.runAs('linux-a', ['query', 'sessions']).status, 0, 'control: an index here');
  const file = fs.readdirSync(path.dirname(claim)).find((n) => /^index-v1-.*\.sqlite$/.test(n));
  assert.ok(file, fs.readdirSync(path.dirname(claim)).join(' '));
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(path.dirname(claim), file));
  db.exec('PRAGMA user_version = 99');
  db.close();
  fs.rmSync(claim);
  assert.equal(w.runAs('linux-a', ['__index-build']).status, 0);
  assert.ok(fs.statSync(claim).mtimeMs > Date.now() + 50 * 60_000, 'the claim is dated past the backoff');
  hook('PostToolUse');
  hook('Stop');
  assert.equal(builds().length, 3, 'none during the backoff');
});

// Index answers name another machine as `--machine` takes it: by the label this machine saved it under, its id kept (its
// own name stays `label`). Before its record log arrives (here none comes: oak-records is off), it is named by what this
// machine knows of it: the label its edit logs' copies came by, and the one it is saved under.
test('sync: index answers name another machine by the label it is saved under here, before and after its records name it', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  // The Mac calls itself "studio"; linux-a saved it as "mac".
  const wrapper = path.join(w.homes.mac, '.local', 'bin', 'oak');
  fs.writeFileSync(wrapper, fs.readFileSync(wrapper, 'utf8').replace('#!/bin/sh\n', "#!/bin/sh\nOAK_MACHINE_LABEL='studio' "));
  const S = ID(54);
  conversation(s.M, s.appM, S, 'Name the machines');
  storeSession(w, 'mac', S, { records: [{ id: 1, file: '/a' }] });
  only(w, ['linux-a', 'mac']);
  w.syncPrefs('linux-a', { exclude: { machines: ['linux-b', 'lab'] }, families: { 'oak-records': 'off' } });
  rounds(w, ['linux-a'], 1);
  const hostM = hostOf(w, 'mac');
  const machineRow = () => w.json('linux-a', ['query', 'sync']).rows.find((r) => r.machine === hostM);
  assert.ok(fs.existsSync(storeOf(w, 'linux-a', 'sync', 'replicas', hostM, S, 'log.jsonl')), 'control: its edit log came over');
  assert.equal(fs.existsSync(storeOf(w, 'linux-a', 'records', hostM)), false, 'control: its record log did not');
  assert.deepEqual([machineRow()?.label, machineRow()?.saved_label], ['mac', 'mac'], 'named before its records name it');
  assert.equal(w.json('linux-a', ['query', 'sync']).columns.at(-1), 'saved_label', 'after the columns there were, as --arrays reads them');
  w.syncPrefs('linux-a', { exclude: { machines: ['linux-b', 'lab'] } });
  rounds(w, ['linux-a'], 1);
  assert.deepEqual([machineRow().label, machineRow().saved_label], ['studio', 'mac'], 'its own name, as its records give it, and the label it is saved under');
  const q = w.json('linux-a', ['query', 'sessions', '--machine', hostM]);
  assert.deepEqual(q.rows.filter((r) => r.id === S).map((r) => [r.machine, r.machine_label]), [[hostM, 'mac']]);
  assert.equal(q.columns.at(-1), 'machine_label', 'after the columns there were');
  const source = q.freshness.sources.find((x) => x.machine === hostM);
  assert.deepEqual([source.label, source.savedLabel, source.origin], ['studio', 'mac', 'replica']);
  assert.equal(w.json('linux-a', ['query', 'usage', '--by', 'machine', '--account', 'all']).rows.find((r) => r.key === hostM)?.label, 'mac', 'usage by machine');
  assert.match(w.runAs('linux-a', ['query', 'sessions', '--machine', hostM, '--table']).stdout, /\nmachine_label +mac\n/, 'and a person reads it');
  // Every named query that names a machine, the listing of its sessions, and its raised hand say it so too.
  for (const [name, args] of [['edits', ['--machine', hostM]], ['prompts', ['--session', S]]]) {
    const rows = w.json('linux-a', ['query', name, ...args]).rows;
    assert.ok(rows.length && rows.every((r) => r.machine_label === 'mac'), `${name}: ${JSON.stringify(rows.map((r) => r.machine_label))}`);
  }
  assert.match(w.runAs('linux-a', ['sessions', '--synced']).stdout, /\nmac · synced /, 'the listing heads its sessions so');
  hookOn(w, 'mac', S, 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
  w.json('mac', ['sessions'], { OAK_MACHINE_LABEL: 'studio' });
  rounds(w, ['linux-a'], 1);
  assert.deepEqual(w.json('linux-a', ['inbox']).hands.filter((h) => h.id === S).map((h) => [h.machine, h.host]), [['mac', hostM]], 'its hand');
  // A usage pull, which asks a machine whose records here are not current, keeps the name its records give it.
  const old = new Date(Date.now() - 20 * 60_000);
  for (const f of fs.readdirSync(storeOf(w, 'linux-a', 'records', hostM))) fs.utimesSync(storeOf(w, 'linux-a', 'records', hostM, f), old, old);
  w.clearSsh();
  assert.equal(w.runAs('linux-a', ['usage', '--pull-machines']).status, 0);
  assert.ok(w.sshCalls().some((c) => c.join(' ').includes('__usage-records')), 'control: the pull asked the Mac');
  assert.deepEqual([machineRow().label, machineRow().saved_label], ['studio', 'mac'], 'after a usage pull');
  // Saved under another label since, the next run (which pulls nothing new) names it so.
  const renamed = JSON.parse(w.envFor('linux-a').MACHINE_EXEC_MACHINES).map((m) => (m.label === 'mac' ? { ...m, label: 'mac2' } : m));
  w.json('linux-a', ['sync', 'now'], { MACHINE_EXEC_MACHINES: JSON.stringify(renamed) });
  assert.deepEqual([machineRow().label, machineRow().saved_label], ['studio', 'mac2'], 'renamed');
});

// One repository at ~/Github/app on linux-a and at ~/src/app on the Mac: a file edited in both clones is one file, by its
// project and its path within it; and an absolute path in this machine's clone finds the edits of every clone, or is
// refused saying what to pass (it matched nothing, which read as no pending edit).
test('sync: the index takes a file in two clones as one file: the files query counts both machines, and edits takes an absolute path', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  only(w, ['linux-a', 'mac']);
  const edit = (home, app, sid) => {
    conversation(home, app, sid, 'Retry the flaky login test');
    fs.mkdirSync(path.join(app, 'src'), { recursive: true });
    storeSession(w, home === s.A ? 'linux-a' : 'mac', sid, { records: [{ id: 1, ts: Date.now() - 60_000, tool: 'Edit', file: path.join(app, 'src', 'x.ts'), status: 'pending' }] });
  };
  edit(s.A, s.appA, ID(55));
  edit(s.M, s.appM, ID(56));
  rounds(w, ['linux-a'], 1);
  const files = w.json('linux-a', ['query', 'files']).rows.filter((r) => r.rel_path === 'src/x.ts');
  assert.deepEqual(files.map((r) => [r.project_key, r.machines, r.sessions, r.edits, r.pending]), [['git:github.com/Org/App', 2, 2, 2, 2]], JSON.stringify(files));
  const abs = path.join(s.appA, 'src', 'x.ts');
  const q = w.json('linux-a', ['query', 'edits', '--path', abs]);
  assert.deepEqual(q.rows.map((r) => r.session).sort(), [ID(55), ID(56)], 'both clones\' edits');
  assert.deepEqual([q.params.path, q.params.project], ['src/x.ts', 'git:github.com/Org/App'], 'the answer says what it matched');
  // A path in no project of this machine's sessions is refused, with what to pass, never answered with no rows.
  const r = w.runAs('linux-a', ['query', 'edits', '--path', path.join(w.W, 'elsewhere', 'y.ts')]);
  assert.equal(r.status, 2, r.stdout);
  const failure = JSON.parse(r.stdout).error;
  assert.equal(failure.code, 'bad_param');
  assert.match(failure.message, /path is a file's path within its project \(src\/app\.ts, with --project <key>.*--file <absolute path> matches that path exactly/);
  assert.equal(w.runAs('linux-a', ['query', 'edits', '--path', abs, '--project', 'git:github.com/Org/Other']).status, 2, 'nor one in another project than the one named');
  // A session started in a folder of the repository keys its edits by the repository and that folder; the file is the
  // same one, from the repository's root, and so are the edits of a session in a repository nested in this one.
  const sub = path.join(s.appA, 'src');
  const inner = path.join(s.appA, 'vendor', 'inner');
  gitRepo(inner, 'git@github.com:Org/Inner.git');
  conversation(s.A, sub, ID(62), 'Retry the flaky login test from src');
  storeSession(w, 'linux-a', ID(62), { records: [{ id: 1, ts: Date.now() - 60_000, tool: 'Edit', file: abs, status: 'pending' }] });
  conversation(s.A, inner, ID(63), 'Fix the vendored parser');
  storeSession(w, 'linux-a', ID(63), { records: [{ id: 1, ts: Date.now() - 60_000, tool: 'Edit', file: path.join(inner, 'p.ts'), status: 'pending' }] });
  conversation(s.A, s.appA, ID(64), 'Touch the vendored parser from the top');
  storeSession(w, 'linux-a', ID(64), { records: [{ id: 1, ts: Date.now() - 60_000, tool: 'Edit', file: path.join(inner, 'p.ts'), status: 'pending' }] });
  const keyed = w.json('linux-a', ['query', 'edits', '--file', abs]).rows.map((x) => x.project_key).sort();
  assert.deepEqual([...new Set(keyed)], ['git:github.com/Org/App', 'git:github.com/Org/App//src'], 'control: two keys for one file');
  assert.deepEqual(w.json('linux-a', ['query', 'files']).rows.filter((x) => x.rel_path === 'src/x.ts').map((x) => [x.project_key, x.machines, x.sessions, x.edits]),
    [['git:github.com/Org/App', 2, 3, 3]], 'one file, whatever folder its sessions started in');
  assert.deepEqual(w.json('linux-a', ['query', 'edits', '--path', abs, '--status', 'pending']).rows.map((x) => x.session).sort(), [ID(55), ID(56), ID(62)].sort(), 'every one of its pending edits');
  assert.deepEqual(w.json('linux-a', ['query', 'edits', '--project', 'git:github.com/Org/App', '--path', 'src/x.ts']).rows.map((x) => x.session).sort(), [ID(55), ID(56), ID(62)].sort(),
    'and by its path from the repository\'s root, whatever folder its sessions started in');
  assert.deepEqual(w.json('linux-a', ['query', 'edits', '--path', path.join(inner, 'p.ts')]).rows.map((x) => x.session).sort(), [ID(63), ID(64)].sort(), 'and a nested repository\'s file, from either');
});

// A session fetched here from a machine whose clone is elsewhere is that machine's, running there: no sibling in this
// project. `oak siblings --repo` lists the other machines' sessions of this repository from the local index, under each
// machine's label, read-only (their edits are reviewed where they ran).
test('sync: `oak siblings` leaves out a fetched copy, and `--repo` lists other machines\' sessions of this repository from the index, read-only', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  only(w, ['linux-a', 'mac']);
  const S = ID(57), T = ID(58);
  conversation(s.M, s.appM, S, 'Fix the flaky login test');
  conversation(s.M, s.appM, T, 'Tune the import');
  rounds(w, ['linux-a'], 1);
  const copy = w.json('linux-a', ['sync', 'fetch', S]).path;
  assert.ok(copy.startsWith(path.join(s.A, '.claude', 'projects', claudeFolder(s.appA)) + path.sep), `control: it landed in this clone's folder: ${copy}`);
  const siblings = (args) => {
    const r = w.runAs('linux-a', ['siblings', '--session', ID(1), ...args], {}, { cwd: s.appA });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  assert.deepEqual(JSON.parse(siblings(['--json', '--all'])).siblings.map((x) => x.id), [ID(1)], 'the copy is no sibling here');
  const repo = JSON.parse(siblings(['--repo', '--json']));
  assert.equal(repo.siblings.some((x) => x.id === S), false);
  const mac = repo.machines.find((m) => m.host === hostOf(w, 'mac'));
  assert.equal(mac?.machine, 'mac');
  // Every session of this repository there: the two above, and the one the Mac's clone held before (its seed).
  assert.deepEqual(mac.sessions.map((x) => [x.id, x.machine, x.readOnly]).sort(), [[ID(6), 'mac', true], [S, 'mac', true], [T, 'mac', true]]);
  assert.equal(mac.sessions.find((x) => x.id === S).title, 'Fix the flaky login test');
  // A copy whose recorded directory is the same path on both machines (a share both mount there) is no sibling either.
  const shared = path.join(w.W, 'shared', 'proj3');
  fs.mkdirSync(shared, { recursive: true });
  const C = ID(69);
  conversation(s.M, shared, C, 'A session on the shared path');
  rounds(w, ['linux-a'], 1);
  assert.equal(w.json('linux-a', ['sync', 'fetch', C]).from, 'mac', 'control: fetched');
  assert.ok(fs.existsSync(path.join(s.A, '.claude', 'projects', claudeFolder(shared), `${C}.jsonl`)), 'control: the copy is in this path\'s folder here');
  const onShared = w.runAs('linux-a', ['siblings', '--json', '--all', '--session', ID(70)], {}, { cwd: shared });
  assert.deepEqual(JSON.parse(onShared.stdout).siblings.map((x) => x.id), [], 'the copy is no sibling');
  // Each by its whole id, which `--session <id> --machine mac` takes there.
  const text = siblings(['--repo']);
  assert.match(text, new RegExp(`\\nmac · synced ${CLOCK} · read-only here: its sessions are reviewed on mac\\n○ `));
  for (const [id, title] of [[S, 'Fix the flaky login test'], [T, 'Tune the import']]) assert.ok(text.includes(`○ ${id}  ${title}  `), text);
  // With a sibling here, the other machines' follow this machine's.
  conversation(s.A, s.appA, ID(71), 'A sibling here');
  const both = siblings(['--repo']);
  assert.match(both, /^Fleet {2}[^\n]*\n[\s\S]*\n\nmac · synced [^\n]*\n○ /, both);
});

// `oak demo` sessions stay on the machine that ran them, so `oak demo --clean` there leaves no trace anywhere: no family
// lists a file of one, no machine pulls one (here the backup, which pulls every session), and the record log holds none.
test('sync: `oak demo` sessions never leave the machine: none is listed, none is pulled, even by the backup', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  for (const m of ['linux-a', 'linux-b']) w.syncPrefs(m, { backup: { kind: 'machine', label: 'linux-b' }, exclude: { machines: ['mac', 'lab'] } });
  const r = w.runAs('linux-a', ['demo', '--fast', '--dir', path.join(s.A, 'demo-work')], {}, { cwd: s.appA });
  assert.equal(r.status, 0, r.stderr);
  const store = path.join(s.A, '.claude', 'claude-observatory');
  const demos = fs.readdirSync(store).filter((n) => /^demo-[0-9a-f]{8}$/.test(n));
  assert.ok(demos.length >= 1, `control: the demo ran here: ${fs.readdirSync(store)}`);
  const transcripts = cp.execFileSync('find', [path.join(s.A, '.claude', 'projects'), '-name', `${demos[0]}*`], { encoding: 'utf8' }).trim();
  assert.ok(transcripts, 'control: its transcript is in this machine\'s projects');
  const inv = JSON.stringify(w.json('linux-a', ['__sync-inventory', '--user', me]));
  assert.ok(!demos.some((d) => inv.includes(d)), 'no family lists a file of it');
  rounds(w, ['linux-a', 'linux-b'], 1);
  const there = cp.execFileSync('find', [s.B], { encoding: 'utf8' }).split('\n').filter((p) => demos.some((d) => p.includes(d)));
  assert.deepEqual(there, [], 'nothing of it on the backup');
  const records = cp.execFileSync('find', [path.join(s.B, '.claude', 'claude-observatory'), '-path', '*records*', '-type', 'f'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  assert.ok(records.length, 'control: linux-a\'s record log came over');
  for (const f of records) assert.ok(!demos.some((d) => fs.readFileSync(f, 'utf8').includes(d)), `${f} names no demo session`);
  // Asked for one by name, as an older index might, it sends none.
  const asked = w.runAs('linux-a', ['__sync-fetch', '--user', me], {}, { input: JSON.stringify({ fetch: 1, items: [{ family: 'transcripts', name: transcripts.split('\n').find((p) => p.endsWith('.jsonl')).slice(path.join(s.A, '.claude', 'projects').length + 1) }] }) });
  assert.match(asked.stdout, /"status":"missing"/, `${asked.status} ${asked.stderr}`);
});

test('sync resolve: status and the inbox name this machine\'s file beside the copy; resolve moves the copy to sync\'s trash and closes the conflict at once, never during a run', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  only(w, ['linux-a', 'linux-b']);
  const plan = (m) => path.join(w.homes[m], '.claude', 'plans', 'm.md');
  write(plan('linux-a'), 'one\ntwo\n');
  rounds(w, ['linux-a', 'linux-b'], 1);
  write(plan('linux-a'), 'one\nleft\n');
  write(plan('linux-b'), 'one\nright\n');
  rounds(w, ['linux-a', 'linux-b'], 1);
  const c = w.json('linux-a', ['sync', 'status']).conflicts.find((x) => x.family === 'plans');
  assert.ok(c, 'control: a conflict');
  assert.equal(c.file, path.join(s.A, '.claude', 'plans', 'm.md'), 'this machine\'s file, absolute');
  assert.equal(fs.readFileSync(c.copy, 'utf8'), 'one\nright\n', 'beside the other machine\'s copy');
  const row = w.json('linux-a', ['inbox']).sync.find((x) => x.id === c.id);
  assert.deepEqual([row.file, row.copy], [c.file, c.copy], 'the inbox names both too');
  assert.ok(w.runAs('linux-a', ['inbox']).stdout.includes(`sync conflict  plans m.md from linux-b — its copy is ${c.copy}; edit your file or delete the copy (\`oak sync resolve ${c.id}\` deletes it)\n`),
    'and its text says how to delete the copy');
  // The doctor report both editors open says it, with its fix, beside the local index's row.
  const md = w.runAs('linux-a', ['doctor', '--markdown']).stdout;
  assert.match(md, /### ⚠️ oak sync\nlast run \d\d:\d\d:\d\d; \d+ conflicts? open\n\n\*\*Fix:\*\* Run `oak sync status` to see each conflict copy, and resolve it by editing your file or deleting the copy \(`oak sync resolve <id>`\)\./);
  assert.match(md, /### ✅ Local database\n/);
  // Never during a run: a live run's lock refuses it, and nothing moves.
  fs.writeFileSync(w.store('linux-a', 'now.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }));
  const busy = w.runAs('linux-a', ['sync', 'resolve', c.id]);
  fs.rmSync(w.store('linux-a', 'now.lock'));
  assert.equal(busy.status, 1);
  assert.match(busy.stderr, /another oak sync is running on this machine: resolve it once that run ends/);
  assert.ok(fs.existsSync(c.copy), 'the copy stays while a run holds the lock');
  assert.match(w.runAs('linux-a', ['sync', 'resolve', 'not-a-conflict']).stderr, /no open conflict not-a-conflict: `oak sync status` lists them/);
  const r = w.json('linux-a', ['sync', 'resolve', c.id]);
  assert.deepEqual([r.syncResolve, r.id, r.family, r.name, r.from, r.closed], [1, c.id, 'plans', 'm.md', 'linux-b', [c.id]]);
  assert.ok(!fs.existsSync(c.copy), 'the copy is gone from conflicts/');
  assert.ok(r.trash.startsWith(w.store('linux-a', 'trash') + path.sep), r.trash);
  assert.equal(fs.readFileSync(r.trash, 'utf8'), 'one\nright\n', 'kept whole in sync\'s trash');
  assert.equal(fs.readFileSync(plan('linux-a'), 'utf8'), 'one\nleft\n', 'this machine\'s file stands');
  const plans = (list) => list.filter((x) => x.family === 'plans');
  assert.deepEqual(plans(w.json('linux-a', ['sync', 'status']).conflicts), [], 'closed at once, not at the next run');
  assert.deepEqual(plans(w.json('linux-a', ['inbox']).sync), []);
  assert.ok(fs.readFileSync(w.store('linux-a', 'audit.jsonl'), 'utf8').includes('"the conflict copy, deleted with oak sync resolve"'));
  // Closed for good: the next run takes this machine's file as the newer and raises nothing again.
  assert.ok(!w.json('linux-a', ['sync', 'now']).done.some((d) => d.family === 'plans' && d.action === 'conflict'));
  assert.deepEqual(plans(w.json('linux-a', ['sync', 'status']).conflicts), []);
  assert.match(w.runAs('linux-a', ['sync', 'resolve', c.id]).stderr, /no open conflict/, 'and is no conflict to resolve again');
});

test('sync resolve: a diverged session\'s copy resolved stays dismissed until the other copy changes, as one deleted by hand', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  w.syncPrefs('linux-b', { backup: { kind: 'machine', label: 'linux-b' } });
  const fileA = path.join(s.A, '.claude', 'projects', claudeFolder(s.appA), `${ID(1)}.jsonl`);
  fs.appendFileSync(fileA, line({ type: 'assistant', message: { content: 'went left' } }) + line({ type: 'user', message: { content: 'and further than linux-b' } }));
  w.json('linux-b', ['sync', 'now']);
  const c = w.json('linux-b', ['sync', 'status']).conflicts.find((x) => x.family === 'transcripts');
  assert.ok(c, 'control: raised');
  assert.equal(c.file, path.join(s.B, '.claude', 'projects', claudeFolder(s.appB), `${ID(1)}.jsonl`));
  assert.deepEqual(w.json('linux-b', ['sync', 'resolve', c.id]).closed, [c.id]);
  assert.deepEqual(w.json('linux-b', ['sync', 'now']).done.filter((d) => d.family === 'transcripts'), [], 'not fetched again');
  fs.appendFileSync(fileA, line({ type: 'user', message: { content: 'later' } }));
  assert.ok(w.json('linux-b', ['sync', 'now']).done.some((d) => d.family === 'transcripts' && d.action === 'conflict'), 'a new version is raised anew');
});

test('sync now: a background run that stops says so in status and in oak doctor, and the next waits its turn', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  w.json('linux-a', ['sync', 'now']);
  const status = w.store('linux-a', 'status.json');
  fs.writeFileSync(status, JSON.stringify({ ...JSON.parse(fs.readFileSync(status, 'utf8')), at: Date.now() - 10 * 60_000 }));
  // herdr's machine list cannot be read now: the run stops before it asks any machine.
  const broken = { MACHINE_EXEC_MACHINES: 'not json' };
  const fg = w.runAs('linux-a', ['sync', 'now'], broken);
  assert.equal(fg.status, 1, 'control: in the foreground it stops, and says why');
  const bg = w.runAs('linux-a', ['sync', 'now', '--quiet', '--if-due'], broken);
  assert.deepEqual([bg.status, bg.stdout, bg.stderr], [0, '', ''], 'in the background it prints nothing');
  const last = w.json('linux-a', ['sync', 'status']).last;
  assert.ok(Date.now() - last.at < 60_000, 'it counts as the last run');
  assert.match(last.error, /did not return JSON/);
  assert.ok(last.warnings.some((x) => /^the run stopped: /.test(x)));
  const doctor = JSON.parse(w.runAs('linux-a', ['doctor', '--json']).stdout).checks.find((c) => c.id === 'sync');
  assert.equal(doctor.level, 'warn');
  assert.match(doctor.detail, /which stopped: .*did not return JSON/);
  assert.deepEqual(w.json('linux-a', ['sync', 'now', '--if-due'], broken).status, 'not-due', 'the next background run waits its turn');
  assert.equal(JSON.parse(fs.readFileSync(w.store('linux-a', 'backoff.json'), 'utf8')).failures, 1, 'and its failure counts toward the backoff');
});

test('sync: a file deleted after an edit another machine missed is deleted there too, not brought back with its old text; made again where it was deleted, it comes back everywhere', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  for (const m of ['linux-a', 'linux-b', 'mac']) w.syncPrefs(m, { exclude: { machines: ['lab'] } });
  const p = (m) => path.join(w.homes[m], '.claude', 'plans', 'old-news.md');
  const all = () => ['linux-a', 'linux-b', 'mac'].map((m) => (fs.existsSync(p(m)) ? fs.readFileSync(p(m), 'utf8') : null));
  write(p('linux-a'), 'v1\n');
  rounds(w, ['linux-a', 'linux-b', 'mac'], 1);
  assert.deepEqual(all(), ['v1\n', 'v1\n', 'v1\n'], 'control: on every machine');
  // linux-a edits it and linux-b takes the edit while the Mac is away; then linux-a deletes it, and linux-b follows.
  write(p('linux-a'), 'v2\n');
  w.json('linux-b', ['sync', 'now', '--machine', 'linux-a']);
  w.json('linux-a', ['sync', 'now', '--machine', 'linux-b']);
  fs.rmSync(p('linux-a'));
  w.json('linux-a', ['sync', 'now', '--machine', 'linux-b']);
  w.json('linux-b', ['sync', 'now', '--machine', 'linux-a']);
  assert.deepEqual(all(), [null, null, 'v1\n'], 'control: the Mac still holds the version before the edit');
  // The Mac is back: its copy is a version the file had, edited nowhere since, and goes too.
  rounds(w, ['linux-a', 'linux-b', 'mac'], 2);
  assert.deepEqual(all(), [null, null, null]);
  // Made again on linux-a, with the old text: a new event, and it reaches every machine.
  write(p('linux-a'), 'v1\n');
  rounds(w, ['linux-a', 'linux-b', 'mac'], 2);
  assert.deepEqual(all(), ['v1\n', 'v1\n', 'v1\n']);
});

/** The background runs a machine's pollers would start: `oak usage --json` there, every spawn recorded, none started. */
function kickRecorder(w, machine) {
  const recorder = path.join(root, 'packages/tui/test/fixtures/spawn-recorder.cjs');
  const log = path.join(w.io, `spawns-${machine}.jsonl`);
  const poll = (env = {}) => {
    const r = w.runAs(machine, ['usage', '--json'], { ...env, OAK_SPAWN_LOG: log, OAK_NO_BACKGROUND: '' }, { node: ['--require', recorder] });
    assert.equal(r.status, 0, r.stderr);
  };
  const kicks = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((s) => s.args.slice(1).join(' ') === 'sync now --quiet --if-due') : []);
  return { poll, kicks };
}

test('sync now: a first run with no saved machine to sync with sets nothing up: no background run, and no doctor rows', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  const none = { MACHINE_EXEC_MACHINES: '[]' }; // herdr has no saved machine
  const r = w.json('linux-a', ['sync', 'now'], none);
  assert.ok(r.warnings.some((x) => /no saved machine to sync with/.test(x)), JSON.stringify(r.warnings));
  assert.ok(r.warnings.some((x) => /^this run does not set sync up here, so nothing runs in the background until a run has a saved machine to sync with or a backup folder set$/.test(x)), JSON.stringify(r.warnings));
  assert.equal(w.json('linux-a', ['sync', 'status'], none).setUp, false);
  assert.match(w.runAs('linux-a', ['sync', 'status'], none).stdout, /no run with a saved machine to sync with, or with a backup folder set, here yet/);
  // The pollers start no run for it, and `oak doctor` says nothing of sync, its retention advice included.
  const { poll, kicks } = kickRecorder(w, 'linux-a');
  poll(none);
  assert.deepEqual(kicks(), [], 'nothing kicked');
  const syncRows = () => JSON.parse(w.runAs('linux-a', ['doctor', '--json'], none).stdout).checks.map((c) => c.id).filter((id) => /^sync/.test(id));
  assert.deepEqual(syncRows(), []);
  // Nor does a run whose one saved machine is this machine itself, under another label.
  const self = { MACHINE_EXEC_MACHINES: JSON.stringify([{ id: 'm0', label: 'me-again', target: 'u@linux-a', session: 'default', enabled: true, selected: false }]) };
  const again = w.json('linux-a', ['sync', 'now'], self);
  assert.deepEqual(again.machines.map((m) => [m.label, m.status]), [['me-again', 'duplicate']]);
  assert.ok(again.warnings.some((x) => /does not set sync up here/.test(x)), JSON.stringify(again.warnings));
  assert.equal(w.json('linux-a', ['sync', 'status'], self).setUp, false);
  // As the warning says, a backup folder alone sets it up, with no saved machine: the doctor's rows follow, and the
  // pollers start the background runs once the last run is due again.
  const share = path.join(w.W, 'share', 'oak-backup');
  fs.mkdirSync(path.dirname(share));
  assert.equal(w.runAs('linux-a', ['sync', 'backup', '--folder', share], none).status, 0);
  const folder = w.json('linux-a', ['sync', 'now'], none);
  assert.ok(!folder.warnings.some((x) => /does not set sync up here/.test(x)), JSON.stringify(folder.warnings));
  assert.equal(w.json('linux-a', ['sync', 'status'], none).setUp, true, 'a backup folder alone sets sync up');
  assert.ok(syncRows().includes('sync'), 'and oak doctor shows sync');
  const status = w.store('linux-a', 'status.json');
  fs.writeFileSync(status, JSON.stringify({ ...JSON.parse(read(status)), at: Date.now() - 10 * 60_000 }));
  poll(none);
  assert.equal(kicks().length, 1, 'a poll starts the background run');
  assert.equal(w.runAs('linux-a', ['sync', 'backup', '--none'], none).status, 0);
  // Control: a run with a saved machine sets it up, and the doctor's rows follow.
  w.json('linux-a', ['sync', 'now']);
  assert.equal(w.json('linux-a', ['sync', 'status']).setUp, true);
  assert.deepEqual(syncRows(), ['sync-retention', 'sync']);
});

test('sync: a background run that dies before it writes its status, or stops, backs off: 5, then 10 minutes; one that ends well clears it', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  w.syncPrefs('linux-a', { exclude: { machines: ['mac', 'lab'] } });
  const { poll, kicks } = kickRecorder(w, 'linux-a');
  w.json('linux-a', ['sync', 'now']);
  const status = w.store('linux-a', 'status.json');
  const backoff = w.store('linux-a', 'backoff.json');
  const age = (file, ms) => { const v = JSON.parse(fs.readFileSync(file, 'utf8')); fs.writeFileSync(file, JSON.stringify({ ...v, at: v.at - ms })); };
  age(status, 10 * 60_000); // the last run ten minutes ago: a background run is due
  // Background runs killed (out of memory, say) as they write their manifest, before their status.
  const killer = path.join(w.io, 'kill-at-manifest.cjs');
  fs.writeFileSync(killer, `
const fs = require('fs'); const open = fs.openSync;
fs.openSync = function (p, ...r) { if (/manifest\\.jsonl\\.\\d+\\.tmp$/.test(String(p))) process.kill(process.pid, 'SIGKILL'); return open.call(fs, p, ...r); };`);
  const dies = () => assert.equal(w.runAs('linux-a', ['sync', 'now', '--quiet', '--if-due'], {}, { node: ['--require', killer] }).signal, 'SIGKILL');
  const said = fs.readFileSync(status, 'utf8');
  dies();
  assert.equal(fs.readFileSync(status, 'utf8'), said, 'control: it died before it wrote its status, which still says the last run was ten minutes ago');
  // At the next poll, a minute on in life, nothing is started, and a background run started anyway does nothing.
  poll();
  assert.deepEqual(kicks(), [], 'no retry a minute after');
  assert.equal(w.json('linux-a', ['sync', 'now', '--if-due']).status, 'not-due');
  age(backoff, 5 * 60_000 + 1000);
  poll();
  assert.equal(kicks().length, 1, 'five minutes on, one is due again');
  fs.rmSync(w.store('linux-a', 'kick'));
  // That one dies too: the second failure in a row waits ten minutes.
  dies();
  age(backoff, 5 * 60_000 + 1000);
  poll();
  assert.equal(kicks().length, 1, 'not five minutes after a second failure');
  age(backoff, 5 * 60_000);
  poll();
  assert.equal(kicks().length, 2, 'ten minutes after it');
  fs.rmSync(w.store('linux-a', 'kick'));
  // A run that ends well clears it, and the background runs are due at their usual pace again.
  w.json('linux-a', ['sync', 'now']);
  assert.ok(!fs.existsSync(backoff));
  age(status, 10 * 60_000);
  poll();
  assert.equal(kicks().length, 3);
});

test('sync now: no tail lands on a transcript written here in the last minute (a session running here); once it has been still a minute, it does', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  w.syncPrefs('linux-b', { backup: { kind: 'machine', label: 'linux-b' }, exclude: { machines: ['mac', 'lab'] } });
  const notesA = path.join(s.A, '.claude', 'projects', claudeFolder(path.join(s.A, 'notes')), `${ID(2)}.jsonl`);
  const notesB = path.join(s.B, '.claude', 'projects', claudeFolder(path.join(s.B, 'notes')), `${ID(2)}.jsonl`);
  w.json('linux-b', ['sync', 'now']);
  assert.deepEqual(fs.readFileSync(notesB), fs.readFileSync(notesA), 'control: pulled whole');
  // (A copy sync itself wrote a moment ago takes a tail at once: the test of a tail cut at its last line shows it.)
  fs.appendFileSync(notesA, line({ type: 'assistant', message: { content: 'more on linux-a' } }));
  // The session is written on linux-b just now (the same bytes again, so linux-a's copy still begins with them).
  fs.writeFileSync(notesB, fs.readFileSync(notesB));
  const before = fs.readFileSync(notesB);
  const r = w.json('linux-b', ['sync', 'now']);
  const d = r.done.filter((x) => x.to.endsWith(`${ID(2)}.jsonl`));
  assert.deepEqual(d.map((x) => x.action), ['skipped'], JSON.stringify(r.done));
  assert.match(d[0].detail, /written here in the last minute, by a session running on this machine/);
  assert.deepEqual(fs.readFileSync(notesB), before, 'nothing landed on it');
  assert.equal(r.machines.find((m) => m.label === 'linux-a').pending.files, 1, 'left for a later run');
  // Still for a minute: the tail lands.
  fs.utimesSync(notesB, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  const r2 = w.json('linux-b', ['sync', 'now']);
  assert.deepEqual(r2.done.filter((x) => x.to.endsWith(`${ID(2)}.jsonl`)).map((x) => x.action), ['append']);
  assert.deepEqual(fs.readFileSync(notesB), fs.readFileSync(notesA));
});

test('sync now: a machine that sends slowly is stopped at the run\'s time for it; what it sent lands up to its last line, and the next run takes the rest', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  w.syncPrefs('linux-b', { backup: { kind: 'machine', label: 'linux-b' } });
  const folder = claudeFolder(s.appB);
  const name = `${folder}/${ID(61)}.jsonl`;
  const body = Array.from({ length: 10 }, (_, i) => line({ i, pad: 'x'.repeat(100) })).join('');
  const peer = (extra) => scriptedPeer(w, 'mac', {
    families: { transcripts: [{ name, size: Buffer.byteLength(body), mtime: Date.now() - 600_000 }] },
    projects: [{ folder, cwd: s.appB, own: true }], identities: { [s.appB]: { key: 'git:github.com/Org/App', root: s.appB } },
    bodies: { [name]: body }, status: 'auto', ...extra,
  });
  // Valid lines, slowly: five 200 ms apart, then one each 15 s, so a run that only noticed its time at the next line
  // would wait for it.
  peer({ trickleMs: 200, pauseAfter: 5, pauseMs: 15_000 });
  // The run's ten minutes for one machine are a second and a half here.
  const fast = path.join(w.io, 'fast-budget.cjs');
  fs.writeFileSync(fast, `const st = setTimeout; globalThis.setTimeout = function (fn, ms, ...a) { return st(fn, ms === ${10 * 60_000} ? 1500 : ms, ...a); };\n`);
  const t0 = Date.now();
  const ran = w.runAs('linux-b', ['sync', 'now', '--json', '--machine', 'mac'], {}, { node: ['--require', fast] });
  const took = Date.now() - t0;
  assert.equal(ran.status, 0, ran.stderr);
  const r = JSON.parse(ran.stdout);
  const mac = r.machines.find((m) => m.label === 'mac');
  assert.ok(took < 8000, `stopped at its time, not at the end of the trickle: ${took} ms`);
  assert.ok(mac.errors.some((e) => /^stopped after 10 minutes, the longest one run reads from one machine/.test(e)), JSON.stringify(mac));
  assert.equal(mac.status, 'ok', 'being stopped is no failure of the machine\'s own');
  assert.deepEqual([mac.pulled.files, mac.pending.files], [1, 1], JSON.stringify(mac));
  const here = path.join(s.B, '.claude', 'projects', name);
  const got = fs.readFileSync(here, 'utf8');
  assert.ok(got.length > 0 && got.length < body.length && body.startsWith(got) && got.endsWith('\n'), `a first part, up to a complete line: ${got.length} of ${body.length} bytes`);
  assert.equal(mac.pending.bytes, body.length - got.length);
  assert.ok(!fs.existsSync(w.store('linux-b', 'now.lock')), 'the lock is let go');
  // The next run asks for what follows, and takes the rest.
  peer({});
  w.json('linux-b', ['sync', 'now', '--machine', 'mac']);
  const asked = JSON.parse(fs.readFileSync(path.join(w.io, 'peer-requests-mac.jsonl'), 'utf8').trim().split('\n').at(-1)).items[0];
  assert.equal(asked.offset, Buffer.byteLength(got));
  assert.equal(fs.readFileSync(here, 'utf8'), body);
});

test('sync now: a name as long as a file system allows syncs, merges, conflicts and goes to the trash: its temporary file is named apart', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  for (const m of ['linux-a', 'linux-b']) w.syncPrefs(m, { backup: { kind: 'machine', label: 'linux-b' }, exclude: { machines: ['mac', 'lab'] } });
  // 255 bytes, the most one name may hold: a plan, and a session's tool output.
  const plan = `${'p'.repeat(252)}.md`;
  const tool = `${'t'.repeat(251)}.txt`;
  const planA = path.join(s.A, '.claude', 'plans', plan);
  const planB = path.join(s.B, '.claude', 'plans', plan);
  write(planA, 'one\ntwo\nthree\nfour\n');
  write(path.join(s.A, '.claude', 'projects', claudeFolder(path.join(s.A, 'notes')), ID(2), 'tool-results', tool), 'output\n', Date.now() - 600_000);
  rounds(w, ['linux-b', 'linux-a'], 1); // linux-b copies them, and linux-a records the version both now have
  assert.equal(fs.readFileSync(planB, 'utf8'), 'one\ntwo\nthree\nfour\n');
  assert.equal(fs.readFileSync(path.join(s.B, '.claude', 'projects', claudeFolder(path.join(s.B, 'notes')), ID(2), 'tool-results', tool), 'utf8'), 'output\n');
  // Edited on both machines, apart: merged. Edited again on linux-a: replaced here the same day, so the trash keeps
  // two copies of the one long name.
  write(planA, 'ONE\ntwo\nthree\nfour\n');
  write(planB, 'one\ntwo\nthree\nFOUR\n');
  rounds(w, ['linux-b', 'linux-a'], 1);
  assert.equal(fs.readFileSync(planB, 'utf8'), 'ONE\ntwo\nthree\nFOUR\n');
  write(planA, 'ONE\ntwo\nthree\nFOUR\nfive\n');
  rounds(w, ['linux-b'], 1);
  assert.equal(fs.readFileSync(planB, 'utf8'), 'ONE\ntwo\nthree\nFOUR\nfive\n');
  const trashed = cp.execFileSync('find', [w.store('linux-b', 'trash'), '-name', plan], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  assert.equal(trashed.length, 2, trashed.join('\n'));
  // A line both change: a conflict copy, under the same name.
  write(planA, 'ONE\nleft\nthree\nFOUR\nfive\n');
  write(planB, 'ONE\nright\nthree\nFOUR\nfive\n');
  rounds(w, ['linux-b'], 1);
  const c = w.json('linux-b', ['sync', 'status']).conflicts.find((x) => x.name === plan);
  assert.ok(c, 'a conflict copy is kept');
  assert.equal(fs.readFileSync(c.copy, 'utf8'), 'ONE\nleft\nthree\nFOUR\nfive\n');
  assert.equal(cp.execFileSync('find', [w.W, '-name', '*.oak-sync-*.tmp'], { encoding: 'utf8' }).trim(), '', 'no temporary file left');
});

// ---------------------------------------------------------------------------------------------------------------
// OAK's own store (sync-store.ts) and the encrypted backup folder (sync-folder.ts, sync-crypto.ts). The share is a local
// folder of the world; every machine reaches it at the same path.
// ---------------------------------------------------------------------------------------------------------------

const storeOf = (w, machine, ...p) => path.join(w.homes[machine], '.claude', 'claude-observatory', ...p);
const hostOf = (w, machine) => w.json(machine, ['__sync-inventory', '--user', me]).host;
const read = (file) => fs.readFileSync(file, 'utf8');

/** An OAK store session on `machine`: its edit log, the snapshots it names, its hook events, its agent record and its
 *  comments (in the session's folder, or where they were kept before, `changemap-cache/<session>/comments.json`). */
function storeSession(w, machine, sid, { records = [{ id: 1 }], blobs = [], events = [], agent = null, comments = null, oldComments = null } = {}) {
  const dir = storeOf(w, machine, sid);
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
  const hashes = blobs.map((b) => {
    const h = sha(b);
    fs.writeFileSync(path.join(dir, 'blobs', h), b);
    return h;
  });
  fs.writeFileSync(path.join(dir, 'log.jsonl'), records.map((r) => line(r)).join(''));
  if (events.length) fs.writeFileSync(path.join(dir, 'capture-events.jsonl'), events.map((e) => line(e)).join(''));
  if (agent) fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(agent));
  if (comments) fs.writeFileSync(path.join(dir, 'comments.json'), JSON.stringify(comments));
  if (oldComments) write(storeOf(w, machine, 'changemap-cache', sid, 'comments.json'), JSON.stringify(oldComments));
  idle(dir);
  return { dir, hashes };
}

/** Only these machines sync with each other (the rest are excluded), with `extra` settings. */
function only(w, machines, extra = {}) {
  for (const m of machines) w.syncPrefs(m, { ...extra, exclude: { machines: MACHINES.filter((x) => !machines.includes(x)) } });
}

test('sync store: other machines\' OAK sessions land as replicas under their machine\'s id; one session id on two machines never mixes, and no machine takes its own back', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  const S = 'sess-same-id';
  storeSession(w, 'linux-a', S, { records: [{ id: 1, file: '/a' }], blobs: ['blob of a'], events: [{ k: 'a' }], agent: { kind: 'claude' }, oldComments: { version: 1, comments: [{ id: 'c1', text: 'a note' }] } });
  storeSession(w, 'linux-b', S, { records: [{ id: 9, file: '/b' }], blobs: ['blob of b'], comments: { version: 1, comments: [] } });
  only(w, ['linux-a', 'linux-b']);
  const hA = hostOf(w, 'linux-a'), hB = hostOf(w, 'linux-b');
  const a1 = w.json('linux-a', ['sync', 'now']);
  assert.equal(a1.status, 'ok', JSON.stringify(a1.machines));
  // Edit logs and small records go everywhere, under the machine that made them; this machine's own session of the
  // same id is untouched.
  assert.equal(read(storeOf(w, 'linux-a', 'sync', 'replicas', hB, S, 'log.jsonl')), line({ id: 9, file: '/b' }));
  assert.equal(read(storeOf(w, 'linux-a', 'sync', 'replicas', hB, S, 'comments.json')), JSON.stringify({ version: 1, comments: [] }));
  assert.equal(read(storeOf(w, 'linux-a', S, 'log.jsonl')), line({ id: 1, file: '/a' }));
  // Snapshots and hook events stay with the machine that made them and the backup, which linux-a is not.
  assert.ok(!fs.existsSync(storeOf(w, 'linux-a', 'sync', 'replicas', hB, S, 'blobs')), 'no snapshot pulled here');
  w.json('linux-b', ['sync', 'now']);
  assert.equal(read(storeOf(w, 'linux-b', 'sync', 'replicas', hA, S, 'log.jsonl')), line({ id: 1, file: '/a' }));
  assert.equal(read(storeOf(w, 'linux-b', 'sync', 'replicas', hA, S, 'agent.json')), JSON.stringify({ kind: 'claude' }));
  // Comments where they were kept before land in the replica's own folder.
  assert.equal(read(storeOf(w, 'linux-b', 'sync', 'replicas', hA, S, 'comments.json')), JSON.stringify({ version: 1, comments: [{ id: 'c1', text: 'a note' }] }));
  // linux-b now lists its replica of linux-a's session; linux-a never takes it in.
  const inv = w.json('linux-b', ['__sync-inventory', '--user', me]);
  assert.ok(inv.families['oak-log'].some((f) => f.name === `sync/replicas/${hA}/${S}/log.jsonl` && f.origin === hA), 'control: linux-b lists the replica');
  const before = snapshot(storeOf(w, 'linux-a', S));
  const a2 = w.json('linux-a', ['sync', 'now']);
  assert.ok(!fs.existsSync(storeOf(w, 'linux-a', 'sync', 'replicas', hA)), 'no replica of its own sessions');
  assert.deepEqual(diffSnapshots(before, snapshot(storeOf(w, 'linux-a', S))), [], 'its own session untouched');
  assert.deepEqual(a2.done.filter((d) => d.family.startsWith('oak-')), [], 'nothing to do');
});

// A session fetched here (filed under the Mac in the local index, its conversation read from the copy here) whose OAK log
// the Mac goes on writing: every read lists it, and once resumed here (an edit captured here, in this machine's own
// store), its own edits stay as captured under that key, however the Mac's log and records change. The copy of the Mac's
// log was written over the session's row (it left the listings until the next catch-up), and each side moved the other's
// edits below zero, cleared, at every change.
test('sync store: a session fetched here is listed at every read while its machine\'s log changes, and once resumed here its own edits stay as captured', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  only(w, ['linux-a', 'mac']);
  const S = ID(44);
  // In the repository the Mac alone has cloned: the copy lands under the Mac's folder name, and is listed here.
  const other = path.join(s.M, 'src', 'other');
  conversation(s.M, other, S, 'Fix the flaky login test');
  const macLog = (n) => storeSession(w, 'mac', S, { records: Array.from({ length: n }, (_, i) => ({ id: i + 1, uid: `mac-${i + 1}`, ts: Date.now() - 60_000 + i, tool: 'Write', file: path.join(other, `m${i + 1}.txt`), status: 'pending' })) });
  macLog(1);
  w.json('mac', ['sessions']);
  rounds(w, ['linux-a'], 1);
  assert.equal(w.json('linux-a', ['sync', 'fetch', S]).from, 'mac', 'control: fetched');
  const hM = hostOf(w, 'mac');
  const listed = () => w.json('linux-a', ['sessions', '--all']).sessions.some((x) => x.id === S);
  const edits = () => JSON.parse(w.runAs('linux-a', ['query', 'sql', 'SELECT id, file, cleared_ms IS NOT NULL AS cleared FROM edits WHERE machine_id = ? AND session_id = ? ORDER BY id', '--param', hM, '--param', S]).stdout).rows;
  assert.ok(listed() && listed(), 'control: listed here');
  macLog(2);
  w.json('mac', ['sessions']);
  rounds(w, ['linux-a'], 1);
  assert.ok(listed(), 'listed at the first read after the Mac\'s log changed');
  storeSession(w, 'linux-a', S, { records: [{ id: 1, uid: 'here-1', ts: Date.now() - 30_000, tool: 'Write', file: path.join(s.appA, 'h1.txt'), status: 'pending' }] });
  for (const n of [3, 4]) {
    macLog(n);
    w.json('mac', ['sessions']);
    rounds(w, ['linux-a'], 1);
    assert.ok(listed() && listed(), `round ${n}: listed at every read`);
    const rows = edits();
    assert.deepEqual(rows.filter((r) => r.file.endsWith('h1.txt')).map((r) => [r.id, r.cleared]), [[1, 0]], `round ${n}: this machine's own edit as captured: ${JSON.stringify(rows)}`);
    assert.ok(rows.length <= 3, `round ${n}: nothing piles up below zero: ${JSON.stringify(rows)}`);
  }
});

test('sync store: the backup keeps every machine\'s snapshots and hook events; a log rewritten at the same size and time is mirrored whole, the old copy to the trash', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  const S = 'sess-backed-up';
  // A log longer than the head its stamp hashes, so a change past the head is seen by the inode alone.
  const records = Array.from({ length: 40 }, (_, i) => ({ id: i, status: 'kept', pad: 'x'.repeat(200) }));
  const { dir, hashes } = storeSession(w, 'linux-a', S, { records, blobs: ['one', 'two'], events: [{ k: 1 }] });
  only(w, ['linux-a', 'linux-b'], { backup: { kind: 'machine', label: 'linux-b' } });
  const hA = hostOf(w, 'linux-a');
  const rep = (...p) => storeOf(w, 'linux-b', 'sync', 'replicas', hA, S, ...p);
  w.json('linux-b', ['sync', 'now']);
  for (const h of hashes) assert.equal(sha(fs.readFileSync(rep('blobs', h))), h);
  assert.equal(read(rep('capture-events.jsonl')), line({ k: 1 }));
  // Hook events grow: the replica takes the tail.
  fs.appendFileSync(path.join(dir, 'capture-events.jsonl'), line({ k: 2 }));
  idle(dir);
  const r1 = w.json('linux-b', ['sync', 'now']);
  assert.equal(read(rep('capture-events.jsonl')), line({ k: 1 }) + line({ k: 2 }));
  assert.ok(r1.done.some((d) => d.family === 'oak-events' && d.action === 'append'), JSON.stringify(r1.done));
  // A clear rewrites the log through a rename: the same size and time, other bytes and another inode. Size and time
  // alone would call it unchanged; its stamp does not.
  const log = path.join(dir, 'log.jsonl');
  const st = fs.statSync(log);
  const original = read(log);
  const rewritten = original.replace('"id":39,"status":"kept"', '"id":39,"status":"done"');
  assert.ok(rewritten !== original && original.indexOf('"id":39') > 4096, 'control: the change is past the head');
  assert.equal(Buffer.byteLength(rewritten), st.size, 'control: the same size');
  fs.writeFileSync(`${log}.tmp`, rewritten);
  fs.renameSync(`${log}.tmp`, log);
  fs.utimesSync(log, st.atime, st.mtime);
  assert.equal(Math.floor(fs.statSync(log).mtimeMs), Math.floor(st.mtimeMs), 'control: the same time');
  const r2 = w.json('linux-b', ['sync', 'now']);
  assert.equal(read(rep('log.jsonl')), rewritten);
  assert.deepEqual(r2.done.filter((d) => d.family === 'oak-log').map((d) => d.action), ['replace']);
  const trashed = cp.execFileSync('find', [w.store('linux-b', 'trash'), '-name', 'log.jsonl'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  assert.equal(trashed.length, 1);
  assert.equal(read(trashed[0]), original, 'the copy it replaced');
  // Unchanged: nothing is fetched again.
  assert.deepEqual(w.json('linux-b', ['sync', 'now']).done.filter((d) => d.family.startsWith('oak-')), []);
  // linux-a collects a snapshot no record names any more: its own session is no restore, so it does not come back from
  // the backup's copy.
  fs.rmSync(path.join(dir, 'blobs', hashes[0]));
  w.json('linux-a', ['sync', 'now']);
  assert.ok(!fs.existsSync(path.join(dir, 'blobs', hashes[0])), 'a collected snapshot stays collected');
});

test('sync store: a session cleaned up here is never pulled back; a copy is let go once its machine says it cleaned it, kept while that machine is away or lost it, and a lost one comes back', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  only(w, ['linux-a', 'linux-b'], { backup: { kind: 'machine', label: 'linux-b' } });
  const sessions = { cleaned: 'sess-cleaned', away: 'sess-away', lost: 'sess-lost', kept: 'sess-kept' };
  for (const sid of Object.values(sessions)) storeSession(w, 'linux-a', sid, { records: [{ id: 1, sid }], blobs: [`blob ${sid}`], events: [{ sid }] });
  const hA = hostOf(w, 'linux-a');
  const rep = (sid, ...p) => storeOf(w, 'linux-b', 'sync', 'replicas', hA, sid, ...p);
  w.json('linux-b', ['sync', 'now']);
  for (const sid of Object.values(sessions)) assert.ok(fs.existsSync(rep(sid, 'log.jsonl')), `control: the backup holds ${sid}`);
  // linux-a cleans two sessions up: each removal is recorded as it happens.
  for (const sid of [sessions.cleaned, sessions.away]) assert.equal(w.runAs('linux-a', ['clean', '--drop', sid]).status, 0);
  const evicted = read(storeOf(w, 'linux-a', 'sync', 'evicted.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l).id);
  assert.deepEqual(evicted, [sessions.cleaned, sessions.away]);
  // linux-a runs before the backup has let its copies go: it does not take its cleaned sessions back.
  w.json('linux-a', ['sync', 'now']);
  assert.ok(!fs.existsSync(storeOf(w, 'linux-a', sessions.cleaned)), 'a cleaned session is not restored');
  assert.deepEqual(w.json('linux-a', ['__sync-inventory', '--user', me]).sync.evicted.map((e) => e.id).sort(), [sessions.away, sessions.cleaned].sort());
  // linux-a is away: its absence from no inventory is a cleanup, so the backup keeps every copy.
  const down = { SSH_FAKE_DOWN: 'u@linux-a', SSH_FAKE_STDERR: 'ssh: connect to host linux-a port 22: No route to host' };
  const away = w.runAs('linux-b', ['sync', 'now', '--json'], down);
  assert.equal(JSON.parse(away.stdout).machines[0].status, 'unreachable', away.stdout);
  assert.ok(fs.existsSync(rep(sessions.cleaned, 'log.jsonl')) && fs.existsSync(rep(sessions.away, 'log.jsonl')), 'kept while its machine does not answer');
  // linux-a loses a session (no cleanup recorded): the backup keeps its copy, which may be the last.
  fs.rmSync(storeOf(w, 'linux-a', sessions.lost), { recursive: true });
  const b = w.json('linux-b', ['sync', 'now']);
  assert.ok(!fs.existsSync(rep(sessions.cleaned)), 'cleaned up there, so let go here');
  assert.ok(!fs.existsSync(rep(sessions.away)), 'and the one cleaned while it was away, now that it answers');
  assert.ok(fs.existsSync(rep(sessions.lost, 'log.jsonl')), 'lost there with no cleanup: kept');
  assert.ok(fs.existsSync(rep(sessions.kept, 'log.jsonl')));
  assert.ok(b.warnings.some((x) => /let go/.test(x)), JSON.stringify(b.warnings));
  const trash = cp.execFileSync('find', [w.store('linux-b', 'trash')], { encoding: 'utf8' });
  assert.ok(trash.includes(`replicas/${hA}/${sessions.cleaned}/log.jsonl`) && trash.includes(`replicas/${hA}/${sessions.cleaned}/blobs/`), 'to the trash');
  const audit = read(w.store('linux-b', 'audit.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(audit.some((x) => x.op === 'evict' && x.name === `sync/replicas/${hA}/${sessions.cleaned}`), 'an audit line');
  const records = read(w.store('linux-b', 'evicted.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(records.map((x) => [x.id, x.origin]).sort(), [[sessions.away, hA], [sessions.cleaned, hA]].sort(), 'an eviction record each');
  // The lost session comes back to its machine from the backup, whole.
  const r = w.json('linux-a', ['sync', 'now']);
  assert.equal(r.status, 'ok', JSON.stringify(r.machines));
  assert.equal(read(storeOf(w, 'linux-a', sessions.lost, 'log.jsonl')), line({ id: 1, sid: sessions.lost }));
  assert.equal(read(storeOf(w, 'linux-a', sessions.lost, 'capture-events.jsonl')), line({ sid: sessions.lost }));
  assert.equal(read(storeOf(w, 'linux-a', sessions.lost, 'blobs', sha(`blob ${sessions.lost}`))), `blob ${sessions.lost}`);
  assert.ok(!fs.existsSync(storeOf(w, 'linux-a', sessions.cleaned)), 'still not the cleaned one');
  // Once it is whole, nothing of it is fetched again, run after run.
  for (let i = 0; i < 2; i++) assert.deepEqual(w.json('linux-a', ['sync', 'now']).done.filter((d) => d.family.startsWith('oak-')), [], `run ${i}: nothing more`);
});

test('sync store: a copy let go is never pulled again, though a third machine still holds one', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  only(w, ['linux-a', 'linux-b', 'mac']);
  storeSession(w, 'linux-a', 'sess-c', { records: [{ id: 1 }] });
  const hA = hostOf(w, 'linux-a');
  const rep = (m) => storeOf(w, m, 'sync', 'replicas', hA, 'sess-c', 'log.jsonl');
  w.json('linux-b', ['sync', 'now']);
  w.json('mac', ['sync', 'now']);
  assert.ok(fs.existsSync(rep('linux-b')) && fs.existsSync(rep('mac')), 'control: both hold a copy');
  assert.equal(w.runAs('linux-a', ['clean', '--drop', 'sess-c']).status, 0);
  w.json('linux-b', ['sync', 'now']);
  assert.ok(!fs.existsSync(rep('linux-b')), 'control: linux-b lets its copy go');
  // linux-a is away and the Mac, not run since, still holds its copy: linux-b does not take it back from the Mac.
  const down = { SSH_FAKE_DOWN: 'u@linux-a', SSH_FAKE_STDERR: 'ssh: connect to host linux-a port 22: No route to host' };
  const r = JSON.parse(w.runAs('linux-b', ['sync', 'now', '--json'], down).stdout);
  assert.equal(r.machines.find((m) => m.label === 'mac').status, 'ok', JSON.stringify(r.machines));
  assert.ok(fs.existsSync(rep('mac')), 'control: the Mac still holds a copy');
  assert.ok(!fs.existsSync(rep('linux-b')), 'never pulled again');
  assert.deepEqual(r.done.filter((d) => d.family.startsWith('oak-')), [], JSON.stringify(r.done));
});

test('sync store: a deliberate delete anywhere removes every copy of the session, to the trash; the machine that made it keeps its own', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  only(w, ['linux-a', 'linux-b', 'mac'], { backup: { kind: 'machine', label: 'linux-b' } });
  const S = 'sess-deleted';
  storeSession(w, 'linux-a', S, { records: [{ id: 1 }], blobs: ['x'] });
  const hA = hostOf(w, 'linux-a');
  rounds(w, ['linux-b', 'mac'], 1);
  assert.ok(fs.existsSync(storeOf(w, 'linux-b', 'sync', 'replicas', hA, S, 'log.jsonl')) && fs.existsSync(storeOf(w, 'mac', 'sync', 'replicas', hA, S, 'log.jsonl')), 'control: copies on both');
  // Deleted on the Mac, which holds only a copy: linux-a still holds and lists the session, so this is no cleanup.
  assert.equal(w.runAs('mac', ['sessions', '--delete', S]).status, 0);
  w.json('mac', ['sync', 'now']);
  w.json('linux-b', ['sync', 'now']);
  assert.ok(!fs.existsSync(storeOf(w, 'linux-b', 'sync', 'replicas', hA, S)), 'the backup\'s copy is removed');
  assert.ok(cp.execFileSync('find', [w.store('linux-b', 'trash')], { encoding: 'utf8' }).includes(`replicas/${hA}/${S}/log.jsonl`), 'to the trash');
  assert.ok(!fs.existsSync(w.store('linux-b', 'evicted.jsonl')) || !read(w.store('linux-b', 'evicted.jsonl')).includes(S), 'a delete is no eviction: an undelete brings the copies back');
  // The next run pulls nothing of it back.
  assert.deepEqual(w.json('linux-b', ['sync', 'now']).done.filter((d) => d.family.startsWith('oak-')), []);
  assert.ok(fs.existsSync(storeOf(w, 'linux-a', S, 'log.jsonl')), 'the machine that made it keeps its store: a delete hides it there');
  // Undeleted where it was deleted: the copies come back with the next pulls.
  assert.equal(w.runAs('mac', ['sessions', '--undelete', S]).status, 0);
  w.json('mac', ['sync', 'now']);
  w.json('linux-b', ['sync', 'now']);
  assert.ok(fs.existsSync(storeOf(w, 'linux-b', 'sync', 'replicas', hA, S, 'log.jsonl')), 'the backup holds it again');
  assert.ok(fs.existsSync(storeOf(w, 'linux-b', 'sync', 'replicas', hA, S, 'blobs', sha('x'))));
});

// `oak sessions --undelete` after a run recorded the delete (oak sync's tombstone, which stands until the next run records
// the undelete): the session is listed again at once, from the local index as from the files (OAK_INDEX=off), on each read
// the surfaces make through the CLI. Deleted here, or deleted on another machine and applied here.
test('sync: a session undeleted after a run recorded its delete is listed at once, from the index as from the files', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  only(w, ['linux-a', 'linux-b']);
  const own = ID(31), theirs = ID(32);
  conversation(s.A, s.appA, own, 'Profile the nightly import job');
  conversation(s.A, path.join(s.A, 'notes'), theirs, 'Draft the release notes');
  const ids = (env = {}) => w.json('linux-a', ['sessions'], env).sessions.map((x) => x.id);
  assert.ok([own, theirs].every((id) => ids().includes(id)), 'control: both are listed');
  assert.equal(w.runAs('linux-a', ['sessions', '--delete', own]).status, 0);
  assert.equal(w.runAs('linux-b', ['sessions', '--delete', theirs]).status, 0);
  rounds(w, ['linux-b', 'linux-a'], 1);
  for (const env of [{}, { OAK_INDEX: 'off' }]) assert.ok(![own, theirs].some((id) => ids(env).includes(id)), `control: both are gone ${JSON.stringify(env)}`);
  const tombs = read(w.store('linux-a', 'tombstones.jsonl'));
  assert.ok(tombs.includes(own) && tombs.includes(theirs), 'control: the run recorded both deletes');
  const usage = () => JSON.parse(w.runAs('linux-a', ['query', 'sql', `SELECT message_id, session_id FROM usage_messages WHERE message_id IN ('msg-${own}', 'msg-${theirs}') ORDER BY message_id`]).stdout).rows;
  assert.deepEqual(usage(), [{ message_id: `msg-${own}`, session_id: '' }, { message_id: `msg-${theirs}`, session_id: '' }], 'control: their usage kept without them');
  for (const id of [own, theirs]) assert.equal(w.runAs('linux-a', ['sessions', '--undelete', id]).status, 0);
  for (const env of [{}, { OAK_INDEX: 'off' }]) assert.ok([own, theirs].every((id) => ids(env).includes(id)), `listed again at once ${JSON.stringify(env)}`);
  assert.deepEqual(usage(), [{ message_id: `msg-${own}`, session_id: own }, { message_id: `msg-${theirs}`, session_id: theirs }], 'and their usage is theirs again');
  const views = w.json('linux-a', ['views', '--views', 'sessions']).sessions.sessions.map((x) => x.id);
  assert.ok([own, theirs].every((id) => views.includes(id)), 'by the terminal app\'s views worker too');
  const query = JSON.parse(w.runAs('linux-a', ['query', 'sessions']).stdout).rows.map((x) => x.id);
  assert.ok([own, theirs].every((id) => query.includes(id)), 'and by `oak query`, as JetBrains asks it');
});

// A machine that lost its OAK store (removed by hand, or OAK reinstalled) while Claude Code's transcripts stayed lists a
// session it had deleted on purpose again, from its transcript: its own delete, which the other machines recorded, hides
// it again at its next run, from the files as from the index; and an undelete made there afterwards stands.
test('sync: a session deleted on purpose stays deleted on its machine after that machine lost its store, as the other machines recorded the delete', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  only(w, ['linux-a', 'linux-b']);
  const gone = ID(33), kept = ID(34);
  conversation(s.A, s.appA, gone, 'Draft a migration we will not keep');
  conversation(s.A, s.appA, kept, 'Profile the nightly import job');
  const ids = (env = {}) => w.json('linux-a', ['sessions'], env).sessions.map((x) => x.id);
  assert.equal(w.runAs('linux-a', ['sessions', '--delete', gone]).status, 0);
  rounds(w, ['linux-a', 'linux-b'], 1);
  assert.ok(read(w.store('linux-b', 'tombstones.jsonl')).includes(gone), 'control: linux-b recorded the delete');
  fs.rmSync(storeOf(w, 'linux-a'), { recursive: true, force: true });
  only(w, ['linux-a', 'linux-b']);
  assert.ok(ids({ OAK_INDEX: 'off' }).includes(gone), 'control: its store lost, its transcript lists it again');
  w.json('linux-a', ['sync', 'now']);
  for (const env of [{}, { OAK_INDEX: 'off' }]) {
    assert.ok(!ids(env).includes(gone), `deleted again ${JSON.stringify(env)}`);
    assert.ok(ids(env).includes(kept), `control: the other session stays ${JSON.stringify(env)}`);
  }
  assert.equal(w.runAs('linux-a', ['sessions', '--undelete', gone]).status, 0);
  rounds(w, ['linux-a', 'linux-b', 'linux-a'], 1);
  for (const env of [{}, { OAK_INDEX: 'off' }]) assert.ok(ids(env).includes(gone), `an undelete there stands ${JSON.stringify(env)}`);
});

// A machine that runs no `oak sync now` of its own (one the others pull from, saving none itself): its deletes and
// undeletes travel all the same, recorded when another machine's run asks for its inventory. The backup, which holds its
// transcripts, listed a session deleted there for as long as that machine ran no sync, and indexed its edits again.
test('sync: a delete made on a machine that runs no sync of its own reaches the others, and so does its undelete', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  only(w, ['linux-a', 'linux-b'], { backup: { kind: 'machine', label: 'linux-b' } });
  const S = ID(35);
  // On the share, which linux-b does not mount: its copy there keeps linux-a's folder name, and linux-b lists it.
  const proj = path.join(w.mountsA, 'u', 'proj');
  conversation(s.A, proj, S, 'Sketch a schema we will throw away');
  storeSession(w, 'linux-a', S, { records: [{ id: 1, uid: 'u-35', ts: Date.now() - 60_000, tool: 'Write', file: path.join(proj, 'schema.sql'), status: 'pending' }] });
  w.json('linux-a', ['sessions']);
  const listed = (env = {}) => w.json('linux-b', ['sessions', '--all'], env).sessions.some((x) => x.id === S);
  const edits = () => JSON.parse(w.runAs('linux-b', ['query', 'edits', '--session', S, '--all']).stdout).rows.length;
  rounds(w, ['linux-b'], 1);
  assert.ok(listed() && edits() === 1, 'control: the backup lists it, from its copy of the transcript, with its edit');
  assert.equal(w.runAs('linux-a', ['sessions', '--delete', S, '--force']).status, 0);
  rounds(w, ['linux-b'], 1);
  for (const env of [{}, { OAK_INDEX: 'off' }]) assert.ok(!listed(env), `deleted on the backup too ${JSON.stringify(env)}`);
  assert.equal(edits(), 0, 'its edit forgotten there');
  assert.ok(!fs.existsSync(storeOf(w, 'linux-b', 'sync', 'replicas', hostOf(w, 'linux-a'), S)), 'its copy of the store let go');
  assert.equal(w.runAs('linux-a', ['sessions', '--undelete', S]).status, 0);
  rounds(w, ['linux-b'], 1);
  for (const env of [{}, { OAK_INDEX: 'off' }]) assert.ok(listed(env), `back on the backup ${JSON.stringify(env)}`);
});

/** Every file and folder below `dir`, with whether it is a link. */
function tree(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const name of fs.readdirSync(d).sort()) {
      const abs = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(abs);
      out.push({ rel: r, abs, link: st.isSymbolicLink(), dir: st.isDirectory() });
      if (st.isDirectory()) walk(abs, r);
    }
  };
  walk(dir, '');
  return out;
}

/** `oak sync setup --folder <share> --restore`: a machine reinstalled (its key back, and nothing else of its sync state)
 *  says it is the one that wrote its record in the folder, which no run restores from until it does. */
function reinstalled(w, machine, share) {
  const r = w.json(machine, ['sync', 'setup', '--folder', share, '--restore']);
  assert.deepEqual([r.record?.state, r.record?.claimed], ['unclaimed', true], JSON.stringify(r.record));
}

/** The key a machine holds, as `oak sync key --show` prints it, and its bytes. */
function keyOf(w, machine) {
  const r = w.runAs(machine, ['sync', 'key', '--show']);
  assert.equal(r.status, 0, r.stderr);
  const text = r.stdout.trim();
  return { text, bytes: Buffer.from(text.slice('oak-sync-1:'.length), 'base64url'), stderr: r.stderr };
}

test('sync folder: the share holds ciphertext under names that reveal nothing, and never the key; a wrong key and an altered byte are loud errors, and nothing is used', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  only(w, ['linux-a']);
  const S = 'sess-on-the-share';
  storeSession(w, 'linux-a', S, { records: [{ id: 1, file: '/home/u/SENTINEL-FILE.txt' }], blobs: ['SENTINEL-BLOB '.repeat(100), 'a large one '.repeat(200_000)], events: [{ prompt: 'SENTINEL-EVENT' }] });
  const share = path.join(w.W, 'share', 'oak-backup');
  fs.mkdirSync(path.dirname(share));
  const set = w.runAs('linux-a', ['sync', 'backup', '--folder', share]);
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stdout, /a new backup key was made here/);
  const r = w.json('linux-a', ['sync', 'now']);
  assert.equal(r.status, 'ok', JSON.stringify(r.machines));
  const line0 = r.machines.find((m) => m.label.startsWith('backup'));
  assert.ok(line0.pushed.files >= 8, JSON.stringify(line0));
  const key = keyOf(w, 'linux-a');
  assert.match(key.stderr, /Keep it in a password manager/);
  assert.equal(key.bytes.length, 32);
  // Names: lower case, hex or a fixed word; no links; nothing a person or a machine is named by.
  const files = tree(share);
  assert.ok(files.some((f) => f.rel.startsWith('packs/')) && files.some((f) => f.rel.startsWith('objects/')) && files.some((f) => /^machines\/[0-9a-f]{64}\/seg-\d{12}$/.test(f.rel)), files.map((f) => f.rel).join('\n'));
  for (const f of files) {
    assert.ok(!f.link, `no link: ${f.rel}`);
    assert.match(f.rel, /^(?:oak-backup|machines|objects|packs|machines\/[0-9a-f]{64}(?:\/(?:tmp|seg-\d{12}|snap-\d{12}))?|(?:objects|packs)\/[0-9a-f]{2}(?:\/[0-9a-f]{64})?)$/, `a name that says nothing: ${f.rel}`);
  }
  assert.equal(new Set(files.map((f) => f.rel.toLowerCase())).size, files.length, 'no two names differ only by case');
  // Content: no plaintext of any file, path, session, machine or user; and the key in no form at all.
  const needles = ['SENTINEL', S, ID(2), 'MEMORY.md', 'shared-plan', claudeFolder(path.join(s.A, 'notes')), 'linux-a', me, s.A, 'hello', 'a large one', hostOf(w, 'linux-a'),
    key.text, key.bytes.toString('hex'), key.bytes.toString('base64'), key.bytes.toString('base64url')];
  for (const f of files) {
    if (f.dir) continue;
    const body = fs.readFileSync(f.abs);
    for (const n of needles) assert.ok(!body.includes(Buffer.from(n)), `${f.rel} holds ${n.slice(0, 24)}`);
    assert.ok(!body.includes(key.bytes), `${f.rel} holds the key's bytes`);
  }
  // A machine whose key is another one cannot read it, and says so; nothing is written there.
  const before = snapshot(share);
  const other = 'oak-sync-1:' + Buffer.alloc(32, 7).toString('base64url');
  const inline = w.runAs('linux-a', ['sync', 'key', '--import', other, '--replace']);
  assert.equal(inline.status, 1, 'a key on the command line is refused');
  assert.match(inline.stderr, /not taken on the command line[^\n]*standard input \(`oak sync key --import < file`\)/, 'and the refusal says how to give it');
  const later = w.runAs('linux-a', ['sync', 'key', '--import', '--replace', other]);
  assert.equal(later.status, 1, 'wherever on the command line it is');
  assert.match(later.stderr, /not taken on the command line/);
  assert.equal(keyOf(w, 'linux-a').text, key.text, 'the key here is as it was');
  assert.equal(w.runAs('linux-a', ['sync', 'key', '--import'], {}, { input: other }).status, 1, 'a different key is not taken over the one here');
  assert.equal(w.runAs('linux-a', ['sync', 'backup', '--none']).status, 0);
  assert.equal(w.runAs('linux-a', ['sync', 'key', '--import', '--replace'], {}, { input: other }).status, 0);
  only(w, ['linux-a'], { backup: { kind: 'folder', path: share } });
  const wrong = w.runAs('linux-a', ['sync', 'now', '--json']);
  const wrongRun = JSON.parse(wrong.stdout);
  const wl = wrongRun.machines.find((m) => m.label.startsWith('backup'));
  assert.deepEqual([wrongRun.status, wl.status], ['partial', 'failed']);
  assert.match(wl.detail, /does not open/);
  assert.deepEqual(diffSnapshots(before, snapshot(share)), [], 'nothing written with the wrong key');
  assert.match(w.runAs('linux-a', ['doctor']).stdout, /oak sync[\s\S]*does not open/);
  // The right key back, and a byte of the share altered: what it seals is never used.
  assert.equal(w.runAs('linux-a', ['sync', 'key', '--import', '--replace'], {}, { input: key.text }).status, 0);
  const pack = files.find((f) => f.rel.startsWith('packs/') && !f.dir);
  const bytes = fs.readFileSync(pack.abs);
  bytes[bytes.length - 20] ^= 1;
  fs.writeFileSync(pack.abs, bytes);
  fs.rmSync(storeOf(w, 'linux-a', S), { recursive: true });
  fs.rmSync(storeOf(w, 'linux-a', 'sync', 'evicted.jsonl'), { force: true });
  const tampered = w.json('linux-a', ['sync', 'now']);
  const tl = tampered.machines.find((m) => m.label.startsWith('backup'));
  assert.equal(tampered.status, 'partial');
  assert.ok([tl.detail, ...tl.errors].join(' ').match(/altered|does not open/), JSON.stringify(tl));
  // The file whose piece was altered is not there; nothing it held landed anywhere.
  const restored = filesOf(w, 'linux-a', `.claude/claude-observatory/${S}`);
  const altered = ['log.jsonl', 'capture-events.jsonl', `blobs/${sha('SENTINEL-BLOB '.repeat(100))}`].filter((n) => !restored[n]);
  assert.equal(altered.length, 1, `exactly the altered file is missing: ${JSON.stringify(restored)}`);
  assert.equal(restored[`blobs/${sha('a large one '.repeat(200_000))}`], sha('a large one '.repeat(200_000)), 'the rest restored');
  // A part of the record altered: none of it is used, the run says so as an error, and the machine whose record it is
  // writes it whole again from what it holds.
  const seg = files.find((f) => /seg-\d{12}$/.test(f.rel));
  const sb = fs.readFileSync(seg.abs);
  sb[40] ^= 1;
  fs.writeFileSync(seg.abs, sb);
  fs.rmSync(storeOf(w, 'linux-a', 'sync', 'folder'), { recursive: true, force: true });
  const brokenRun = JSON.parse(w.runAs('linux-a', ['sync', 'now', '--json']).stdout);
  const bl = brokenRun.machines.find((m) => m.label.startsWith('backup'));
  assert.equal(brokenRun.status, 'partial');
  assert.ok(bl.errors.some((e) => /(does not open|altered).*written whole again/.test(e)), JSON.stringify(bl));
  assert.deepEqual(JSON.parse(w.runAs('linux-a', ['sync', 'now', '--json']).stdout).machines.find((m) => m.label.startsWith('backup')).errors, [], 'the next run is clean');
});

test('sync key: copied over ssh from another of the user\'s machines, refused to another account, and the folder opens on both', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  const share = path.join(w.W, 'share', 'oak-backup');
  fs.mkdirSync(path.dirname(share));
  only(w, ['linux-a', 'linux-b']);
  assert.equal(w.runAs('linux-a', ['sync', 'backup', '--folder', share]).status, 0);
  const a = w.json('linux-a', ['sync', 'key']);
  // linux-b has none: the folder holds a backup it cannot open, and it says how to get the key.
  const without = w.runAs('linux-b', ['sync', 'backup', '--folder', share]);
  assert.equal(without.status, 1);
  assert.match(without.stderr, /oak sync key --from/);
  // Copied from linux-a over ssh: the same key, and the folder opens.
  const got = w.json('linux-b', ['sync', 'key', '--from', 'linux-a']);
  assert.equal(got.syncKey.fingerprint, a.syncKey.fingerprint);
  assert.equal(fs.statSync(storeOf(w, 'linux-b', 'sync', 'key')).mode & 0o777, 0o600, 'kept with mode 0600');
  assert.ok(w.sshCalls().some((c) => c.join(' ').includes('__sync-key')), 'over OAK\'s ssh');
  assert.equal(w.runAs('linux-b', ['sync', 'backup', '--folder', share]).status, 0);
  // Another account (the lab machine runs as one) gets nothing.
  const lab = w.runAs('lab', ['__sync-key', '--user', me]);
  assert.deepEqual(JSON.parse(lab.stdout), { shared: true });
  // Both write to the folder; neither key is ever there. linux-b, whose first run finds only linux-a's record there, is
  // new to it: it says it writes its first record, not that it may be a reinstall (one has a record it has not written).
  const both = rounds(w, ['linux-a', 'linux-b'], 1);
  assert.ok(both[1].result.warnings.includes('the backup folder holds no record of this machine yet (it is known there by its host name and home folder): this run writes its first, which is this machine\'s from then on'),
    JSON.stringify(both[1].result.warnings));
  assert.ok(!both[1].result.warnings.some((x) => /reinstall/.test(x)), 'no reinstall advice for a new machine');
  assert.ok(!rounds(w, ['linux-b'], 1)[0].result.warnings.some((x) => /holds no record of this machine yet/.test(x)), 'once only');
  const key = keyOf(w, 'linux-b').bytes;
  for (const f of tree(share)) if (!f.dir) for (const form of [key, Buffer.from(key.toString('hex')), Buffer.from(key.toString('base64url')), Buffer.from(key.toString('base64'))]) assert.ok(!fs.readFileSync(f.abs).includes(form), `${f.rel} holds the key`);
  // Imported by hand: a key that is not one is refused, and one that does not open the folder too.
  assert.match(w.runAs('mac', ['sync', 'key', '--import'], {}, { input: 'oak-sync-1:short' }).stderr, /not an oak sync key/);
  w.syncPrefs('mac', { backup: { kind: 'folder', path: share } });
  assert.match(w.runAs('mac', ['sync', 'key', '--import'], {}, { input: 'oak-sync-1:' + Buffer.alloc(32, 1).toString('base64url') }).stderr, /does not open the backup folder/);
});

test('sync folder: a machine reinstalled with its key restores everything of its own from the folder alone, but no session it cleaned up; then a run writes nothing', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  only(w, ['linux-a']);
  write(path.join(s.A, '.claude', 'settings.json'), JSON.stringify({ cleanupPeriodDays: 3650 }));
  storeSession(w, 'linux-a', 'sess-keep', { records: [{ id: 1 }], blobs: ['keep me'], events: [{ e: 1 }], agent: { a: 1 }, comments: { version: 1, comments: [] } });
  storeSession(w, 'linux-a', 'sess-drop', { records: [{ id: 2 }], blobs: ['drop me'] });
  const share = path.join(w.W, 'share', 'oak-backup');
  fs.mkdirSync(path.dirname(share));
  assert.equal(w.runAs('linux-a', ['sync', 'backup', '--folder', share]).status, 0);
  w.json('linux-a', ['sync', 'now']);
  assert.equal(w.runAs('linux-a', ['clean', '--drop', 'sess-drop']).status, 0);
  // A plan reads the folder and writes nothing, there or here.
  const quiet = [snapshot(share), snapshot(storeOf(w, 'linux-a'))];
  const plan = w.json('linux-a', ['sync', 'plan']);
  assert.ok(plan.machines.some((m) => m.passive && m.label.startsWith('backup:')), JSON.stringify(plan.machines));
  assert.deepEqual([diffSnapshots(quiet[0], snapshot(share)), diffSnapshots(quiet[1], snapshot(storeOf(w, 'linux-a')))], [[], []], 'a plan writes nothing');
  w.json('linux-a', ['sync', 'now']);
  const key = keyOf(w, 'linux-a').text;
  const kept = { claude: filesOf(w, 'linux-a', '.claude/projects'), plans: filesOf(w, 'linux-a', '.claude/plans'), store: filesOf(w, 'linux-a', '.claude/claude-observatory/sess-keep') };
  // Its five files, and the generation sync marked its folder with.
  assert.ok(Object.keys(kept.claude).length >= 4 && Object.keys(kept.store).length === 6 && kept.store['sync-generation'], `control: ${JSON.stringify(kept)}`);
  // Wiped: the same home comes back empty, with no saved machine to restore from.
  fs.rmSync(path.join(s.A, '.claude'), { recursive: true, force: true });
  fs.rmSync(path.join(s.A, '.codex'), { recursive: true, force: true });
  write(path.join(s.A, '.claude', 'settings.json'), JSON.stringify({ cleanupPeriodDays: 3650 }));
  assert.equal(w.runAs('linux-a', ['sync', 'key', '--import'], {}, { input: key }).status, 0, 'the key from standard input');
  only(w, ['linux-a'], { backup: { kind: 'folder', path: share } });
  reinstalled(w, 'linux-a', share);
  const r = w.json('linux-a', ['sync', 'now']);
  assert.equal(r.status, 'ok', JSON.stringify(r.machines));
  assert.deepEqual(filesOf(w, 'linux-a', '.claude/projects'), kept.claude, 'every transcript, session file and memory');
  assert.deepEqual(filesOf(w, 'linux-a', '.claude/plans'), kept.plans);
  assert.deepEqual(filesOf(w, 'linux-a', '.claude/claude-observatory/sess-keep'), kept.store, 'its OAK session, whole');
  assert.ok(!fs.existsSync(storeOf(w, 'linux-a', 'sess-drop')), 'not the session it cleaned up before it was wiped');
  // A run with nothing new touches the folder not at all.
  const before = snapshot(share);
  const again = w.json('linux-a', ['sync', 'now']);
  assert.deepEqual(again.done, []);
  assert.deepEqual(diffSnapshots(before, snapshot(share)), [], 'the share untouched');
});

test('sync folder: two machines writing at once both land whole, the same content once; a run killed mid-write leaves the folder as it was, and the next finishes', { skip: POSIX }, async (t) => {
  const w = world(t);
  seed(w);
  const share = path.join(w.W, 'share', 'oak-backup');
  fs.mkdirSync(path.dirname(share));
  only(w, ['linux-a', 'linux-b']);
  assert.equal(w.runAs('linux-a', ['sync', 'backup', '--folder', share]).status, 0);
  assert.equal(w.runAs('linux-b', ['sync', 'key', '--from', 'linux-a']).status, 0);
  assert.equal(w.runAs('linux-b', ['sync', 'backup', '--folder', share]).status, 0);
  // Each has a large session of its own, and both hold the same plan text.
  const big = (m) => storeSession(w, m, `sess-${m}`, { records: Array.from({ length: 50 }, (_, i) => ({ id: i, m, pad: 'p'.repeat(1000) })), blobs: [`${m} `.repeat(600_000), 'shared blob text'] });
  big('linux-a');
  big('linux-b');
  for (const m of ['linux-a', 'linux-b']) write(path.join(w.homes[m], '.claude', 'plans', 'same.md'), 'the same plan on both\n');
  const both = await Promise.all([w.startAs('linux-a', ['sync', 'now', '--json']), w.startAs('linux-b', ['sync', 'now', '--json'])]);
  for (const r of both) assert.equal(r.status, 0, r.stderr);
  // Each machine's record reads whole from the other, and each restores its own.
  const parts = tree(share).filter((f) => /seg-\d{12}$/.test(f.rel));
  assert.equal(new Set(parts.map((f) => f.rel.split('/')[1])).size, 2, 'one record per machine');
  for (const m of ['linux-a', 'linux-b']) {
    const sid = `sess-${m}`;
    const want = filesOf(w, m, `.claude/claude-observatory/${sid}`);
    fs.rmSync(storeOf(w, m, sid), { recursive: true });
    const r = w.json(m, ['sync', 'now']);
    assert.equal(r.status, 'ok', `${m}: ${JSON.stringify(r.machines)}`);
    assert.deepEqual(filesOf(w, m, `.claude/claude-observatory/${sid}`), want, `${m} restored its own`);
    assert.deepEqual(fs.readdirSync(storeOf(w, m)).filter((n) => n.startsWith('sess-')), [sid], `${m} took no other machine's session for its own`);
  }
  // A run killed while it writes to the folder: once 2 MB have gone to files there, the process is killed.
  storeSession(w, 'linux-a', 'sess-late', { records: [{ id: 1 }], blobs: ['late '.repeat(900_000)] });
  const killer = path.join(w.io, 'share-killer.cjs');
  fs.writeFileSync(killer, `
const fs = require('fs');
const paths = new Map(); let total = 0;
const open = fs.openSync; fs.openSync = function (p, ...r) { const fd = open.call(fs, p, ...r); paths.set(fd, String(p)); return fd; };
const w = fs.writeSync; fs.writeSync = function (fd, buf, ...r) {
  if ((paths.get(fd) || '').startsWith(${JSON.stringify(share + path.sep)}) && Buffer.isBuffer(buf)) {
    total += buf.length;
    if (total > 2 * 1024 * 1024) { w.call(fs, fd, buf.subarray(0, 1000)); process.kill(process.pid, 'SIGKILL'); }
  }
  return w.call(fs, fd, buf, ...r);
};`);
  const recordBefore = tree(share).filter((f) => f.rel.startsWith('machines/') && !f.dir && !f.rel.includes('/tmp/')).map((f) => [f.rel, sha(fs.readFileSync(f.abs))]);
  const killed = w.runAs('linux-a', ['sync', 'now', '--json'], {}, { node: ['--require', killer] });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const recordAfter = tree(share).filter((f) => f.rel.startsWith('machines/') && !f.dir && !f.rel.includes('/tmp/')).map((f) => [f.rel, sha(fs.readFileSync(f.abs))]);
  assert.deepEqual(recordAfter, recordBefore, 'no part of a record was written: the folder reads as before');
  assert.ok(tree(share).some((f) => f.rel.includes('/tmp/') && f.rel.endsWith('.tmp')), 'control: the killed run left a half-written file');
  const next = w.json('linux-a', ['sync', 'now']);
  assert.equal(next.status, 'ok', JSON.stringify(next.machines));
  assert.ok(!tree(share).some((f) => f.rel.endsWith('.tmp')), 'its half-written files removed');
  // And linux-b reads linux-a's record, the late session in it, whole.
  const fetched = w.json('linux-b', ['sync', 'fetch', 'sess-late'], { SSH_FAKE_DOWN: 'u@linux-a' });
  assert.equal(fetched.from, 'backup:linux-a', JSON.stringify(fetched.tried));
  const hA = hostOf(w, 'linux-a');
  assert.equal(sha(fs.readFileSync(storeOf(w, 'linux-b', 'sync', 'replicas', hA, 'sess-late', 'blobs', sha('late '.repeat(900_000))))), sha('late '.repeat(900_000)));
});

test('sync folder: forced modes (0755 everywhere, as a share forces them) change nothing; `oak clean` leaves the key, replicas and records alone', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  only(w, ['linux-a', 'linux-b'], { backup: { kind: 'machine', label: 'linux-b' } });
  storeSession(w, 'linux-a', 'sess-x', { records: [{ id: 1 }], blobs: ['x'] });
  w.json('linux-b', ['sync', 'now']);
  const share = path.join(w.W, 'share', 'oak-backup');
  fs.mkdirSync(path.dirname(share));
  assert.equal(w.runAs('linux-b', ['sync', 'backup', '--folder', share]).status, 0);
  storeSession(w, 'linux-b', 'sess-y', { records: [{ id: 2 }], blobs: ['y'] });
  w.json('linux-b', ['sync', 'now']);
  cp.execFileSync('chmod', ['-R', '0755', share]);
  storeSession(w, 'linux-b', 'sess-z', { records: [{ id: 3 }], blobs: ['z'] });
  const r = w.json('linux-b', ['sync', 'now']);
  assert.equal(r.status, 'ok', JSON.stringify(r.machines));
  assert.ok(r.machines.find((m) => m.label.startsWith('backup')).pushed.files >= 2);
  // oak clean, safe and whole: sync's folder keeps its key, its replicas and what it knows of the backup folder.
  const keep = ['key', 'replicas', 'folder', 'evicted.jsonl'];
  w.runAs('linux-b', ['clean', '--drop', 'sess-z']);
  for (const args of [['clean'], ['clean', '--all']]) {
    const c = w.runAs('linux-b', args);
    assert.equal(c.status, 0, c.stderr);
    for (const k of keep) assert.ok(fs.existsSync(w.store('linux-b', k)), `${args.join(' ')} left sync/${k}`);
  }
  assert.equal(fs.readdirSync(w.store('linux-b', 'replicas')).length, 1, 'the replica of linux-a\'s session is still there');
});

test('sync setup: chooses the backup with flags off a terminal, makes or brings the key, previews a run; doctor suggests it only where a machine is saved', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  const share = path.join(w.W, 'share', 'oak-backup');
  fs.mkdirSync(path.dirname(share));
  only(w, ['linux-a', 'linux-b']);
  // Before: doctor suggests it, since machines are saved here (the world's herdr lists them).
  const doctor = (m) => JSON.parse(w.runAs(m, ['doctor', '--json']).stdout).checks.filter((c) => c.id.startsWith('sync'));
  const before = doctor('linux-a');
  assert.deepEqual(before.map((c) => c.id), ['sync-setup']);
  assert.match(before[0].fix, /oak sync setup/);
  // A machine with no saved machine is never told.
  const lonely = w.runAs('mac', ['doctor', '--json'], { MACHINE_EXEC_MACHINES: '[]' });
  assert.deepEqual(JSON.parse(lonely.stdout).checks.filter((c) => c.id.startsWith('sync')), []);
  // Off a terminal, a choice is needed.
  assert.match(w.runAs('linux-a', ['sync', 'setup']).stderr, /--none \| --machine <label> \| --folder <path>/);
  const a = w.json('linux-a', ['sync', 'setup', '--folder', share]);
  assert.deepEqual([a.syncSetup, a.backup, a.key.made], [1, { kind: 'folder', path: share }, true]);
  assert.equal(a.plan.syncPlan, 1, 'a first plan');
  assert.deepEqual(doctor('linux-a').map((c) => c.id), ['sync-backup'], 'no suggestion once set up');
  // The second machine brings the key from the first.
  const b = w.json('linux-b', ['sync', 'setup', '--folder', share, '--key-from', 'linux-a']);
  assert.deepEqual([b.key.fingerprint, b.key.made, b.key.imported], [a.key.fingerprint, false, true]);
  // Without a key for a folder that holds a backup: refused, with what to do.
  const c = w.runAs('mac', ['sync', 'setup', '--folder', share], { MACHINE_EXEC_MACHINES: '[]' });
  assert.equal(c.status, 1);
  assert.match(c.stderr, /oak sync key --from/);
  // A folder that holds other files is refused; `--none` is a choice too.
  const busy = path.join(w.W, 'share', 'busy');
  write(path.join(busy, 'notes.txt'), 'mine');
  assert.match(w.runAs('mac', ['sync', 'setup', '--folder', busy]).stderr, /not empty/);
  // A key brought for a new folder that is not this machine's, with no --replace: refused before the folder is made.
  assert.equal(w.runAs('mac', ['sync', 'key', '--import'], {}, { input: 'oak-sync-1:' + Buffer.alloc(32, 3).toString('base64url') }).status, 0);
  const fresh = path.join(w.W, 'share', 'fresh');
  const clash = w.runAs('mac', ['sync', 'setup', '--folder', fresh, '--import-key'], {}, { input: 'oak-sync-1:' + Buffer.alloc(32, 4).toString('base64url') });
  assert.equal(clash.status, 1);
  assert.match(clash.stderr, /a different backup key is already kept here/);
  assert.ok(!fs.existsSync(fresh), 'no folder made under a key not kept');
  const none = w.json('mac', ['sync', 'setup', '--none']);
  assert.equal(none.backup, null);
  assert.deepEqual(doctor('mac'), [], 'declined: no suggestion again');
});

test('sync folder: the folder\'s copy of a machine is no inventory of it: a copy is let go only on what that machine itself says, and a machine reinstalled takes back none of what it cleaned up, wherever a copy is', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  const share = path.join(w.W, 'share', 'oak-backup');
  fs.mkdirSync(path.dirname(share));
  only(w, ['linux-a', 'linux-b']);
  assert.equal(w.runAs('linux-a', ['sync', 'backup', '--folder', share]).status, 0);
  assert.equal(w.runAs('linux-b', ['sync', 'key', '--from', 'linux-a']).status, 0);
  assert.equal(w.runAs('linux-b', ['sync', 'backup', '--folder', share]).status, 0);
  storeSession(w, 'linux-a', 'sess-gone', { records: [{ id: 1 }], blobs: ['g'] });
  storeSession(w, 'linux-a', 'sess-stays', { records: [{ id: 2 }], blobs: ['s'] });
  const hA = hostOf(w, 'linux-a');
  w.json('linux-a', ['sync', 'now']);
  w.json('linux-b', ['sync', 'now']);
  const rep = (sid) => storeOf(w, 'linux-b', 'sync', 'replicas', hA, sid, 'log.jsonl');
  assert.ok(fs.existsSync(rep('sess-gone')), 'control: linux-b holds a copy');
  // linux-a cleans a session up, writes that to the folder with a new plan and a change to one both hold, and goes away.
  assert.equal(w.runAs('linux-a', ['clean', '--drop', 'sess-gone']).status, 0);
  write(path.join(w.homes['linux-a'], '.claude', 'plans', 'a-only.md'), 'written on linux-a\n');
  write(path.join(w.homes['linux-a'], '.claude', 'plans', 'shared-plan.md'), 'plan, changed on linux-a\n');
  w.json('linux-a', ['sync', 'now']);
  const down = { SSH_FAKE_DOWN: 'u@linux-a', SSH_FAKE_STDERR: 'ssh: connect to host linux-a port 22: No route to host' };
  const b = JSON.parse(w.runAs('linux-b', ['sync', 'now', '--json'], down).stdout);
  assert.equal(b.machines.find((m) => m.label === 'linux-a').status, 'unreachable');
  assert.ok(fs.existsSync(rep('sess-gone')), 'kept: only linux-a, answering, says what it cleaned up');
  assert.ok(!fs.existsSync(path.join(w.homes['linux-b'], '.claude', 'plans', 'a-only.md')), 'the folder is no source of text: the plan waits for linux-a');
  assert.equal(read(path.join(w.homes['linux-b'], '.claude', 'plans', 'shared-plan.md')), 'plan\n', 'nor of text to merge: the change waits for linux-a too');
  assert.deepEqual(b.done.filter((d) => d.family === 'plans'), [], JSON.stringify(b.done));
  const kept = filesOf(w, 'linux-a', '.claude/projects');
  // linux-a is wiped and reinstalled with its key, while linux-b still holds that copy: it takes it not back.
  const key = keyOf(w, 'linux-a').text;
  fs.rmSync(path.join(w.homes['linux-a'], '.claude'), { recursive: true, force: true });
  assert.equal(w.runAs('linux-a', ['sync', 'key', '--import'], {}, { input: key }).status, 0);
  only(w, ['linux-a', 'linux-b'], { backup: { kind: 'folder', path: share } });
  reinstalled(w, 'linux-a', share);
  const r = w.json('linux-a', ['sync', 'now']);
  assert.equal(r.status, 'ok', JSON.stringify(r.machines));
  assert.ok(fs.existsSync(storeOf(w, 'linux-a', 'sess-stays', 'log.jsonl')), 'control: what it kept comes back');
  const back = filesOf(w, 'linux-a', '.claude/projects');
  for (const [name, hash] of Object.entries(kept)) assert.equal(back[name], hash, `${name} restored`);
  assert.ok(!fs.existsSync(storeOf(w, 'linux-a', 'sess-gone')), 'what it cleaned up does not, though linux-b holds a copy');
  // linux-b, now that linux-a answers, lets its copy go.
  w.json('linux-b', ['sync', 'now']);
  assert.ok(!fs.existsSync(rep('sess-gone')));
  // A session linux-a makes while away reaches linux-b only from linux-a: the folder keeps current what linux-b holds,
  // and makes no new copy of another machine's.
  storeSession(w, 'linux-a', 'sess-while-away', { records: [{ id: 9 }] });
  fs.appendFileSync(storeOf(w, 'linux-a', 'sess-stays', 'log.jsonl'), line({ id: 10 }));
  w.json('linux-a', ['sync', 'now']);
  w.runAs('linux-b', ['sync', 'now'], down);
  assert.ok(!fs.existsSync(rep('sess-while-away')), 'no new copy from the folder');
  assert.equal(read(rep('sess-stays')), read(storeOf(w, 'linux-a', 'sess-stays', 'log.jsonl')), 'the copy held here kept current from it');
  // A fetch asks the machine that made a session first, while it answers, and the folder only after.
  storeSession(w, 'linux-a', 'sess-fetched', { records: [{ id: 3 }], blobs: ['f'] });
  w.json('linux-a', ['sync', 'now']);
  w.json('linux-b', ['sync', 'now']);
  const f = w.json('linux-b', ['sync', 'fetch', 'sess-fetched']);
  assert.deepEqual([f.from, f.tried.map((x) => x.label)], ['linux-a', ['linux-a']]);
  assert.equal(read(storeOf(w, 'linux-b', 'sync', 'replicas', hA, 'sess-fetched', 'blobs', sha('f'))), 'f');
});

test('sync folder: a machine\'s record that lost a part, or went back to an earlier one, is an error, and nothing of it is used; its own machine writes it whole again, and the others read it then', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  const share = path.join(w.W, 'share', 'oak-backup');
  fs.mkdirSync(path.dirname(share));
  only(w, ['linux-a', 'linux-b']);
  assert.equal(w.runAs('linux-a', ['sync', 'backup', '--folder', share]).status, 0);
  assert.equal(w.runAs('linux-b', ['sync', 'key', '--from', 'linux-a']).status, 0);
  assert.equal(w.runAs('linux-b', ['sync', 'backup', '--folder', share]).status, 0);
  const down = { SSH_FAKE_DOWN: 'u@linux-a', SSH_FAKE_STDERR: 'ssh: connect to host linux-a port 22: No route to host' };
  storeSession(w, 'linux-a', 'sess-1', { records: [{ id: 1 }] });
  w.json('linux-a', ['sync', 'now']);
  const mdir = tree(share).find((f) => /^machines\/[0-9a-f]{64}$/.test(f.rel)).abs;
  const older = fs.mkdtempSync(path.join(w.io, 'record-'));
  fs.cpSync(mdir, older, { recursive: true });
  for (const n of [2, 3]) {
    storeSession(w, 'linux-a', `sess-${n}`, { records: [{ id: n }] });
    w.json('linux-a', ['sync', 'now']);
  }
  const parts = () => fs.readdirSync(mdir).filter((n) => /^(?:seg|snap)-/.test(n)).sort();
  assert.deepEqual(parts(), ['seg-000000000001', 'seg-000000000002', 'seg-000000000003']);
  const backupOf = (m, env) => JSON.parse(w.runAs(m, ['sync', 'now', '--json'], env).stdout).machines.find((x) => x.label.startsWith('backup'));
  // linux-b reads linux-a's record (from the folder, linux-a away), so it knows it as far as part 3.
  assert.equal(backupOf('linux-b', down).status, 'ok');
  // Put back from an older copy: linux-b, which read part 3, says it went back, and uses none of it.
  fs.rmSync(mdir, { recursive: true });
  fs.cpSync(older, mdir, { recursive: true });
  const seen = backupOf('linux-b', down);
  assert.ok(seen.errors.some((e) => /went back from part 3 to 1/.test(e)), JSON.stringify(seen));
  // linux-a, whose record it is, says so too, as an error, and writes it whole again, numbered on past part 3.
  const own = backupOf('linux-a');
  assert.ok(own.errors.some((e) => /went back from part 3 to 1.*written whole again/.test(e)), JSON.stringify(own));
  assert.deepEqual(parts(), ['seg-000000000001', 'snap-000000000004']);
  assert.deepEqual(backupOf('linux-a').errors, [], 'the next run is clean');
  assert.deepEqual(backupOf('linux-b', down).errors, [], 'and the other machine reads it again');
  // A part in the middle lost: the record has a gap, which every reader says; its machine writes it whole again.
  storeSession(w, 'linux-a', 'sess-5', { records: [{ id: 5 }] });
  w.json('linux-a', ['sync', 'now']);
  storeSession(w, 'linux-a', 'sess-6', { records: [{ id: 6 }] });
  w.json('linux-a', ['sync', 'now']);
  assert.deepEqual(parts(), ['seg-000000000001', 'seg-000000000005', 'seg-000000000006', 'snap-000000000004']);
  fs.rmSync(path.join(mdir, 'seg-000000000005'));
  assert.ok(backupOf('linux-b', down).errors.some((e) => /part 5 of a machine's record is missing/.test(e)));
  const healed = backupOf('linux-a');
  assert.ok(healed.errors.some((e) => /part 5 of a machine's record is missing.*written whole again/.test(e)), JSON.stringify(healed));
  assert.ok(parts().includes('snap-000000000007'), parts().join(' '));
  assert.deepEqual(backupOf('linux-b', down).errors, []);
  // Every session is in the record written again: linux-a, wiped, restores all four.
  const key = keyOf(w, 'linux-a').text;
  fs.rmSync(path.join(w.homes['linux-a'], '.claude'), { recursive: true, force: true });
  assert.equal(w.runAs('linux-a', ['sync', 'key', '--import'], {}, { input: key }).status, 0);
  only(w, ['linux-a'], { backup: { kind: 'folder', path: share } });
  reinstalled(w, 'linux-a', share);
  w.json('linux-a', ['sync', 'now']);
  for (const n of [1, 2, 3, 5, 6]) assert.ok(fs.existsSync(storeOf(w, 'linux-a', `sess-${n}`, 'log.jsonl')), `sess-${n} restored`);
});

test('sync folder: a link put where the folder\'s own folders go is refused and nothing is written through it; a part larger than OAK writes is refused unread, and its record written whole again', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  only(w, ['linux-a']);
  const share = path.join(w.W, 'share', 'oak-backup');
  fs.mkdirSync(path.dirname(share));
  assert.equal(w.runAs('linux-a', ['sync', 'backup', '--folder', share]).status, 0);
  w.json('linux-a', ['sync', 'now']);
  // Someone who can write the share puts a link where the packs go, leading out of it.
  const outside = fs.mkdtempSync(path.join(w.io, 'outside-'));
  fs.rmSync(path.join(share, 'packs'), { recursive: true });
  fs.symlinkSync(outside, path.join(share, 'packs'));
  storeSession(w, 'linux-a', 'sess-new', { records: [{ id: 1 }], blobs: ['new'] });
  const linked = JSON.parse(w.runAs('linux-a', ['sync', 'now', '--json']).stdout).machines.find((m) => m.label.startsWith('backup'));
  assert.equal(linked.status, 'failed');
  assert.match(linked.detail, /not a folder OAK made/);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing written through the link');
  fs.rmSync(path.join(share, 'packs'));
  assert.equal(JSON.parse(w.runAs('linux-a', ['sync', 'now', '--json']).stdout).status, 'ok', 'and once it is gone, the run writes there again');
  // A part of the record far larger than OAK writes (sparse here, so the test holds none of it): refused unread.
  const mdir = tree(share).find((f) => /^machines\/[0-9a-f]{64}$/.test(f.rel)).abs;
  const top = Math.max(...fs.readdirSync(mdir).filter((n) => /^seg-/.test(n)).map((n) => Number(n.slice(4))));
  const huge = path.join(mdir, `seg-${String(top + 1).padStart(12, '0')}`);
  fs.closeSync(fs.openSync(huge, 'w'));
  fs.truncateSync(huge, 3 * 1024 * 1024 * 1024);
  const big = JSON.parse(w.runAs('linux-a', ['sync', 'now', '--json']).stdout).machines.find((m) => m.label.startsWith('backup'));
  assert.ok(big.errors.some((e) => /larger than OAK writes.*written whole again/.test(e)), JSON.stringify(big));
  assert.equal(fs.statSync(huge).size, 3 * 1024 * 1024 * 1024, 'left as it was, never read');
});

test('sync folder: a restore cut short goes on in the next run until the session is whole; files past this machine\'s retention stay in the backup until its retention takes them', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  only(w, ['linux-a']);
  write(path.join(s.A, '.claude', 'settings.json'), JSON.stringify({ cleanupPeriodDays: 3650 }));
  const old = transcript(s.A, path.join(s.A, 'notes'), ID(20), '', Date.now() - 90 * DAY);
  const big = ['first '.repeat(500_000), 'second '.repeat(500_000)];
  storeSession(w, 'linux-a', 'sess-big', { records: [{ id: 1 }], blobs: big, events: [{ e: 1 }] });
  const share = path.join(w.W, 'share', 'oak-backup');
  fs.mkdirSync(path.dirname(share));
  assert.equal(w.runAs('linux-a', ['sync', 'backup', '--folder', share]).status, 0);
  w.json('linux-a', ['sync', 'now']);
  const want = filesOf(w, 'linux-a', '.claude/claude-observatory/sess-big');
  const key = keyOf(w, 'linux-a').text;
  // Reinstalled, with Claude Code's 30 days (no settings yet): the 90-day-old transcript is not put back.
  fs.rmSync(path.join(s.A, '.claude'), { recursive: true, force: true });
  assert.equal(w.runAs('linux-a', ['sync', 'key', '--import'], {}, { input: key }).status, 0);
  only(w, ['linux-a'], { backup: { kind: 'folder', path: share } });
  reinstalled(w, 'linux-a', share);
  // The first run is killed once 4 MB have gone to the store: a snapshot has landed, the rest has not.
  const killer = path.join(w.io, 'store-killer.cjs');
  const watched = storeOf(w, 'linux-a', 'sess-big') + path.sep;
  fs.writeFileSync(killer, `
const fs = require('fs');
const paths = new Map(); let total = 0;
const open = fs.openSync; fs.openSync = function (p, ...r) { const fd = open.call(fs, p, ...r); paths.set(fd, String(p)); return fd; };
const w = fs.writeSync; fs.writeSync = function (fd, buf, ...r) {
  if ((paths.get(fd) || '').startsWith(${JSON.stringify(watched)}) && Buffer.isBuffer(buf)) {
    total += buf.length;
    if (total > 4 * 1024 * 1024) { w.call(fs, fd, buf.subarray(0, 1000)); process.kill(process.pid, 'SIGKILL'); }
  }
  return w.call(fs, fd, buf, ...r);
};`);
  const killed = w.runAs('linux-a', ['sync', 'now', '--json'], {}, { node: ['--require', killer] });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const part = filesOf(w, 'linux-a', '.claude/claude-observatory/sess-big');
  assert.ok(Object.keys(part).length > 0 && Object.keys(part).length < Object.keys(want).length, `control: a part landed: ${JSON.stringify(part)}`);
  // The next run finishes it: the session comes back whole.
  const r = w.json('linux-a', ['sync', 'now']);
  assert.equal(r.status, 'ok', JSON.stringify(r.machines));
  assert.deepEqual(filesOf(w, 'linux-a', '.claude/claude-observatory/sess-big'), want, 'whole');
  assert.ok(!fs.existsSync(old), 'the transcript past 30 days is not put back');
  // It stays in the backup: once this machine keeps transcripts longer, it comes back.
  write(path.join(s.A, '.claude', 'settings.json'), JSON.stringify({ cleanupPeriodDays: 3650 }));
  w.json('linux-a', ['sync', 'now']);
  assert.ok(fs.existsSync(old), 'kept in the backup, and put back once wanted');
});

// A store over a run's byte budget (SYNC_RUN_MAX_BYTES, 2 GB) comes back over several runs: the small files (each log)
// land in the first, the snapshots past the budget wait. An agent going on in such a session before the next run makes it
// this machine's own again; the snapshots its log names still come back. One snapshot taken away after a whole restore
// stands for one the budget left.
test('sync folder: a snapshot its log names comes back to a restored session even once a capture went on in it', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  only(w, ['linux-a']);
  const [one, two] = ['first snapshot\n', 'second snapshot\n'];
  storeSession(w, 'linux-a', 'sess-resumed', { records: [{ id: 1, file: '/w/a.txt', afterBlob: sha(one) }, { id: 2, file: '/w/b.txt', afterBlob: sha(two) }], blobs: [one, two] });
  const share = path.join(w.W, 'share', 'oak-backup');
  fs.mkdirSync(path.dirname(share));
  assert.equal(w.runAs('linux-a', ['sync', 'backup', '--folder', share]).status, 0);
  w.json('linux-a', ['sync', 'now']);
  const key = keyOf(w, 'linux-a').text;
  fs.rmSync(path.join(s.A, '.claude'), { recursive: true, force: true });
  assert.equal(w.runAs('linux-a', ['sync', 'key', '--import'], {}, { input: key }).status, 0);
  only(w, ['linux-a'], { backup: { kind: 'folder', path: share } });
  reinstalled(w, 'linux-a', share);
  w.json('linux-a', ['sync', 'now']);
  const blob = storeOf(w, 'linux-a', 'sess-resumed', 'blobs', sha(two));
  assert.ok(fs.existsSync(blob), 'control: restored');
  fs.rmSync(blob);
  fs.appendFileSync(storeOf(w, 'linux-a', 'sess-resumed', 'log.jsonl'), line({ id: 3, file: '/w/c.txt', ts: Date.now() }));
  w.json('linux-a', ['sync', 'now']);
  assert.equal(fs.existsSync(blob) && read(blob), two, 'the snapshot its log names is back');
  assert.ok(read(storeOf(w, 'linux-a', 'sess-resumed', 'log.jsonl')).includes('/w/c.txt'), 'and the capture made since stays');
});

test('sync store: a mirrored copy never falls back to an older one (a copy the backup folder keeps, while the machine that writes the log holds a newer one)', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  const share = path.join(w.W, 'share', 'oak-backup');
  fs.mkdirSync(path.dirname(share));
  only(w, ['linux-a', 'linux-b']);
  assert.equal(w.runAs('linux-a', ['sync', 'backup', '--folder', share]).status, 0);
  assert.equal(w.runAs('linux-b', ['sync', 'key', '--from', 'linux-a']).status, 0);
  assert.equal(w.runAs('linux-b', ['sync', 'backup', '--folder', share]).status, 0);
  storeSession(w, 'linux-a', 'sess-m', { records: [{ id: 1 }] });
  w.json('linux-a', ['sync', 'now']);
  w.json('linux-b', ['sync', 'now']);
  // linux-a's log grows, and linux-a does not run: the folder still holds the older version.
  const log = storeOf(w, 'linux-a', 'sess-m', 'log.jsonl');
  fs.appendFileSync(log, line({ id: 2 }));
  fs.utimesSync(log, new Date(), new Date(Date.now() + 1000));
  const hA = hostOf(w, 'linux-a');
  const copy = storeOf(w, 'linux-b', 'sync', 'replicas', hA, 'sess-m', 'log.jsonl');
  for (let i = 0; i < 3; i++) {
    const r = w.json('linux-b', ['sync', 'now']);
    assert.equal(read(copy), line({ id: 1 }) + line({ id: 2 }), `run ${i}: the newer copy, from linux-a`);
    if (i > 0) assert.deepEqual(r.done.filter((d) => d.family === 'oak-log'), [], `run ${i}: nothing taken back and forth`);
  }
});

test('sync store: copies fetched on demand are evicted past the cache\'s size, while the machine that made them holds them', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  only(w, ['linux-a', 'linux-b']);
  storeSession(w, 'linux-a', 'sess-f', { records: [{ id: 1 }], blobs: ['snapshot '.repeat(20_000)], events: [{ e: 1 }] });
  rounds(w, ['linux-b'], 1);
  const hA = hostOf(w, 'linux-a');
  const blobFile = storeOf(w, 'linux-b', 'sync', 'replicas', hA, 'sess-f', 'blobs', sha('snapshot '.repeat(20_000)));
  assert.ok(!fs.existsSync(blobFile), 'control: snapshots stay with their machine');
  assert.equal(w.json('linux-b', ['sync', 'fetch', 'sess-f']).from, 'linux-a');
  assert.ok(fs.existsSync(blobFile), 'fetched');
  assert.ok(w.json('linux-b', ['sync', 'status']).cache.files >= 2, 'kept as on-demand copies');
  w.syncPrefs('linux-b', { cacheMB: 0, exclude: { machines: ['mac', 'lab'] } });
  const r = w.json('linux-b', ['sync', 'now']);
  assert.ok(!fs.existsSync(blobFile), 'evicted past the cap');
  assert.ok(r.warnings.some((x) => /evicted/.test(x)), JSON.stringify(r.warnings));
});

test('sync store: `oak clean --drop` refuses a folder the store keeps for itself; a session made again under a cleaned id is a session again, whose loss is no cleanup', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  only(w, ['linux-a', 'linux-b'], { backup: { kind: 'machine', label: 'linux-b' } });
  w.json('linux-a', ['sync', 'now']);
  const sync = w.store('linux-a');
  assert.ok(fs.existsSync(sync), 'control: sync has state here');
  const drop = w.runAs('linux-a', ['clean', '--drop', 'sync']);
  assert.equal(drop.status, 1);
  assert.match(drop.stderr, /no session but a folder the store keeps/);
  assert.ok(fs.existsSync(path.join(sync, 'status.json')), 'nothing removed');
  const del = w.runAs('linux-a', ['sessions', '--delete', 'sync']);
  assert.notEqual(del.status, 0, 'a delete refuses it too');
  // In any case: where the file system ignores it (macOS's and Windows' by default), `SYNC` is the `sync` folder.
  for (const name of ['SYNC', 'Sync']) {
    const r = w.runAs('linux-a', ['clean', '--drop', name]);
    assert.equal(r.status, 1, `clean --drop ${name}: ${r.stdout}`);
    assert.match(r.stderr, /no session but a folder the store keeps/);
    assert.notEqual(w.runAs('linux-a', ['sessions', '--delete', name, '--force']).status, 0, `sessions --delete ${name}`);
  }
  const hidden = storeOf(w, 'linux-a', 'hidden-sessions.json');
  assert.ok(!fs.existsSync(hidden) || !JSON.parse(read(hidden)).some((id) => id.toLowerCase() === 'sync'), 'and hides nothing, so no delete goes to the other machines');
  // Cleaned, then made again under the same id (a session resumed), then lost: the backup keeps its last copy, and the
  // machine takes it back.
  const S = 'sess-again';
  storeSession(w, 'linux-a', S, { records: [{ id: 1, v: 'first' }] });
  w.json('linux-b', ['sync', 'now']);
  assert.equal(w.runAs('linux-a', ['clean', '--drop', S]).status, 0);
  storeSession(w, 'linux-a', S, { records: [{ id: 1, v: 'second' }] });
  fs.utimesSync(storeOf(w, 'linux-a', S, 'log.jsonl'), new Date(), new Date(Date.now() + 2000)); // written after the cleanup
  // linux-a runs no sync of its own before it loses the session again: only the copy says it lived again.
  w.json('linux-b', ['sync', 'now']);
  const hA = hostOf(w, 'linux-a');
  assert.equal(read(storeOf(w, 'linux-b', 'sync', 'replicas', hA, S, 'log.jsonl')), line({ id: 1, v: 'second' }));
  fs.rmSync(storeOf(w, 'linux-a', S), { recursive: true });
  w.json('linux-b', ['sync', 'now']);
  assert.ok(fs.existsSync(storeOf(w, 'linux-b', 'sync', 'replicas', hA, S, 'log.jsonl')), 'lost, not cleaned: kept');
  w.json('linux-a', ['sync', 'now']);
  assert.equal(read(storeOf(w, 'linux-a', S, 'log.jsonl')), line({ id: 1, v: 'second' }), 'and taken back');
  // What the cleanup removed stays gone: no copy keeps it as the session's earlier history, nor brings it back.
  for (const dir of [storeOf(w, 'linux-b', 'sync', 'replicas', hA), storeOf(w, 'linux-a')]) assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith(`${S}_earlier-`)), [], dir);
  // The list was only appended to: each line written is still there.
  const lines = read(storeOf(w, 'linux-a', 'sync', 'evicted.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.id, !!l.back]), [[S, false], [S, true]]);
});

test('sync folder: the machine that made a session deletes it, and an undelete brings its store back from the backup folder', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  only(w, ['linux-a']);
  const share = path.join(w.W, 'share', 'oak-backup');
  fs.mkdirSync(path.dirname(share));
  assert.equal(w.runAs('linux-a', ['sync', 'backup', '--folder', share]).status, 0);
  storeSession(w, 'linux-a', 'sess-del', { records: [{ id: 1 }], blobs: ['kept'] });
  w.json('linux-a', ['sync', 'now']);
  const want = filesOf(w, 'linux-a', '.claude/claude-observatory/sess-del');
  const deleted = w.runAs('linux-a', ['sessions', '--delete', 'sess-del']);
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.match(deleted.stdout, /the next `oak sync now` brings back what of its edits the backup folder holds/, 'the delete says what the undelete will bring back');
  // So does its refusal of a session with an edit pending review: purged here, the folder keeping its copy.
  const pend = storeSession(w, 'linux-a', 'sess-pend', { records: [], blobs: ['before\n', 'after\n'] });
  fs.writeFileSync(path.join(pend.dir, 'log.jsonl'), line({ id: 1, ts: Date.now(), tool: 'Edit', file: path.join(w.homes['linux-a'], 'notes', 'p.txt'), status: 'pending',
    beforeBlob: pend.hashes[0], afterBlob: pend.hashes[1] }));
  const refused = w.runAs('linux-a', ['sessions', '--delete', 'sess-pend']);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /sess-pend has 1 edit pending review; deleting the session purges that edit here \(the backup folder keeps its copy\)\. Review it first, or pass --force\./);
  assert.ok(!fs.existsSync(storeOf(w, 'linux-a', 'sess-del')), 'control: its store removed');
  assert.ok(!fs.existsSync(storeOf(w, 'linux-a', 'sync', 'evicted.jsonl')) || !read(storeOf(w, 'linux-a', 'sync', 'evicted.jsonl')).includes('sess-del'), 'a delete is no cleanup');
  w.json('linux-a', ['sync', 'now']);
  assert.ok(!fs.existsSync(storeOf(w, 'linux-a', 'sess-del')), 'deleted: not put back');
  assert.equal(w.runAs('linux-a', ['sessions', '--undelete', 'sess-del']).status, 0);
  w.json('linux-a', ['sync', 'now']);
  assert.deepEqual(filesOf(w, 'linux-a', '.claude/claude-observatory/sess-del'), want, 'back from the backup folder');
});

test('sync folder: a pipe put in the folder where a file of OAK\'s should be fails the run at once; an object lost from the folder is written again', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  only(w, ['linux-a']);
  const share = path.join(w.W, 'share', 'oak-backup');
  fs.mkdirSync(path.dirname(share));
  assert.equal(w.runAs('linux-a', ['sync', 'backup', '--folder', share]).status, 0);
  const notes = path.join(s.A, '.claude', 'projects', claudeFolder(path.join(s.A, 'notes')), `${ID(2)}.jsonl`);
  for (let i = 0; i < 1200; i++) fs.appendFileSync(notes, line({ i, pad: 'n'.repeat(4000) }));
  idle(path.dirname(notes));
  w.json('linux-a', ['sync', 'now']);
  // An object lost (a share user, a failing disk): the next change that names it writes it again.
  const objects = tree(share).filter((f) => f.rel.startsWith('objects/') && !f.dir);
  assert.ok(objects.length >= 1, 'control: a 4 MB piece is an object of its own');
  for (const o of objects) fs.rmSync(o.abs);
  // The packs too, which hold the transcript's last, partial piece: kept as it grows, unless it is gone.
  for (const p of tree(share).filter((f) => f.rel.startsWith('packs/') && !f.dir)) fs.rmSync(p.abs);
  fs.appendFileSync(notes, line({ more: true }));
  idle(path.dirname(notes));
  w.json('linux-a', ['sync', 'now']);
  for (const o of objects) assert.ok(fs.existsSync(o.abs), `${o.rel} written again`);
  const want = fs.readFileSync(notes);
  fs.rmSync(notes);
  w.json('linux-a', ['sync', 'now']);
  assert.deepEqual(fs.readFileSync(notes), want, 'and the transcript restores from it');
  // A pipe where the marker is: the run ends at once, saying so, and is not left waiting on it.
  fs.renameSync(path.join(share, 'oak-backup'), path.join(share, 'oak-backup.real'));
  cp.execFileSync('mkfifo', [path.join(share, 'oak-backup')]);
  const t0 = Date.now();
  const piped = JSON.parse(w.runAs('linux-a', ['sync', 'now', '--json']).stdout).machines.find((m) => m.label.startsWith('backup'));
  assert.ok(Date.now() - t0 < 30_000, 'it did not wait on the pipe');
  assert.equal(piped.status, 'failed');
  assert.match(piped.detail, /not a file OAK wrote/);
});

test('sync folder: a record written whole again keeps what of it still opens: a file not here (past this machine\'s retention) stays named, and comes back once wanted', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  only(w, ['linux-a']);
  write(path.join(s.A, '.claude', 'settings.json'), JSON.stringify({ cleanupPeriodDays: 3650 }));
  const old = transcript(s.A, path.join(s.A, 'notes'), ID(30), '', Date.now() - 90 * DAY);
  const share = path.join(w.W, 'share', 'oak-backup');
  fs.mkdirSync(path.dirname(share));
  assert.equal(w.runAs('linux-a', ['sync', 'backup', '--folder', share]).status, 0);
  w.json('linux-a', ['sync', 'now']);
  storeSession(w, 'linux-a', 'sess-later', { records: [{ id: 1 }] });
  w.json('linux-a', ['sync', 'now']);
  const key = keyOf(w, 'linux-a').text;
  // Reinstalled with Claude Code's 30 days, so the old transcript is not put back; and the record's later part altered.
  fs.rmSync(path.join(s.A, '.claude'), { recursive: true, force: true });
  assert.equal(w.runAs('linux-a', ['sync', 'key', '--import'], {}, { input: key }).status, 0);
  only(w, ['linux-a'], { backup: { kind: 'folder', path: share } });
  reinstalled(w, 'linux-a', share);
  const mdir = tree(share).find((f) => /^machines\/[0-9a-f]{64}$/.test(f.rel)).abs;
  const seg2 = path.join(mdir, 'seg-000000000002');
  const b = fs.readFileSync(seg2);
  b[40] ^= 1;
  fs.writeFileSync(seg2, b);
  const r = JSON.parse(w.runAs('linux-a', ['sync', 'now', '--json']).stdout);
  assert.ok(r.machines.find((m) => m.label.startsWith('backup')).errors.some((e) => /written whole again/.test(e)), JSON.stringify(r.machines));
  assert.ok(!fs.existsSync(old), 'control: not put back past 30 days');
  // The record written again still names the old transcript (from the part that opened): kept until wanted.
  write(path.join(s.A, '.claude', 'settings.json'), JSON.stringify({ cleanupPeriodDays: 3650 }));
  w.json('linux-a', ['sync', 'now']);
  assert.ok(fs.existsSync(old), 'put back from the record written whole again');
});

test('sync setup: an unmounted share, a file, a relative path and a folder this machine cannot write are refused before anything is made, each saying what to do; so is a folder whose key is lost, and a backup machine that is not saved is warned about in the preview', { skip: POSIX }, (t) => {
  const w = world(t);
  only(w, ['linux-a', 'linux-b']);
  const keyFile = storeOf(w, 'linux-a', 'sync', 'key');
  // A share that is not mounted: the folder its mount point is in is not there either. Nothing is made beneath it.
  const unmounted = path.join(w.W, 'mnt-gone', 'labshare', 'oak-backup');
  const gone = w.runAs('linux-a', ['sync', 'setup', '--folder', unmounted]);
  assert.equal(gone.status, 1, gone.stdout);
  assert.match(gone.stderr, /is not there \(is its share or disk mounted\?\)/);
  assert.ok(!fs.existsSync(path.join(w.W, 'mnt-gone')), 'nothing made on the disk beneath it');
  // A file, not a folder; and a relative path, which would be taken against wherever the command ran.
  const file = path.join(w.W, 'share-file');
  write(file, 'x');
  assert.match(w.runAs('linux-a', ['sync', 'backup', '--folder', file]).stderr, /share-file is not a folder/);
  assert.match(w.runAs('linux-a', ['sync', 'backup', '--folder', 'share/oak-backup']).stderr, /is relative: give the folder's absolute path/);
  // A folder this machine cannot write: said with what to do, not as a bare error code.
  if (process.getuid?.() !== 0) {
    const ro = path.join(w.W, 'read-only');
    fs.mkdirSync(ro);
    fs.chmodSync(ro, 0o555);
    const denied = w.runAs('linux-a', ['sync', 'backup', '--folder', path.join(ro, 'oak-backup')]);
    fs.chmodSync(ro, 0o755);
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /cannot be made the backup folder: EACCES[^\n]*\. Choose a folder this machine can write/);
  }
  assert.ok(!fs.existsSync(keyFile), 'no key kept for a folder that was refused');
  // A folder that holds a backup under a key no machine here has: what to do, the key lost included.
  const share = path.join(w.W, 'share', 'oak-backup');
  fs.mkdirSync(path.dirname(share));
  assert.equal(w.runAs('linux-b', ['sync', 'backup', '--folder', share]).status, 0);
  const lost = w.runAs('linux-a', ['sync', 'backup', '--folder', share], { MACHINE_EXEC_MACHINES: '[]' });
  assert.equal(lost.status, 1);
  assert.match(lost.stderr, /oak sync key --from <machine>[\s\S]*if no copy of that key is left, nothing can read that backup: choose an empty folder for a new one/);
  // Setup says it in JSON too, for a surface to ask where the key comes from, as setup asks on a terminal; nothing is kept.
  const asked = w.runAs('linux-a', ['sync', 'setup', '--folder', share, '--json'], { MACHINE_EXEC_MACHINES: '[]' });
  assert.equal(asked.status, 1);
  const needs = JSON.parse(asked.stdout);
  assert.deepEqual([needs.syncSetup, needs.needsKey, needs.folder, needs.keyHere], [1, true, share, null]);
  assert.match(needs.error, /holds a backup sealed under a key this machine does not have/);
  assert.ok(!fs.existsSync(keyFile), 'no key kept');
  // …and so is a key here that does not open it (this machine's own, made for another folder); the backup stays as it was.
  const own = path.join(w.W, 'share', 'own-backup');
  assert.equal(w.runAs('linux-a', ['sync', 'backup', '--folder', own], { MACHINE_EXEC_MACHINES: '[]' }).status, 0);
  const wrong = w.runAs('linux-a', ['sync', 'setup', '--folder', share, '--json'], { MACHINE_EXEC_MACHINES: '[]' });
  assert.equal(wrong.status, 1);
  assert.equal(JSON.parse(wrong.stdout).needsKey, true);
  assert.match(JSON.parse(wrong.stdout).error, /backup key does not open/);
  // It names the key here, which one brought for the folder replaces only with --replace (as a surface then passes).
  assert.equal(JSON.parse(wrong.stdout).keyHere, w.json('linux-a', ['sync', 'key']).syncKey.fingerprint);
  assert.match(w.runAs('linux-a', ['sync', 'setup', '--folder', share, '--key-from', 'linux-b']).stderr, /a different backup key is already kept here .*Pass --replace/);
  assert.deepEqual(w.json('linux-a', ['sync', 'backup']).syncBackup, { kind: 'folder', path: own });
  // The key from the machine that made the backup opens it (replacing this machine's, kept beside it).
  const brought = w.json('linux-a', ['sync', 'setup', '--folder', share, '--key-from', 'linux-b', '--replace']);
  assert.deepEqual([brought.backup, brought.key.imported, brought.needsKey], [{ kind: 'folder', path: share }, true, undefined]);
  // A backup machine that is not saved here (a typo): the preview says so, as the run does; a saved one is not warned about.
  const typo = w.json('linux-a', ['sync', 'setup', '--machine', 'linux-bb']);
  assert.ok(typo.plan.machines[0].warnings.some((x) => /the backup "linux-bb" is no saved machine here/.test(x)), JSON.stringify(typo.plan.machines[0].warnings));
  assert.ok(w.json('linux-a', ['sync', 'now']).warnings.some((x) => /the backup "linux-bb" is no saved machine here/.test(x)), 'the run says it too');
  const named = w.json('linux-a', ['sync', 'setup', '--machine', 'linux-b']);
  assert.ok(!named.plan.machines[0].warnings.some((x) => /no saved machine here/.test(x)), JSON.stringify(named.plan.machines[0].warnings));
});

test('sync folder: a backup folder this machine cannot write (a share mounted read-only) fails the backup line saying what to do, and the next run writes it', { skip: POSIX || (process.getuid?.() === 0 && 'root writes anywhere') }, (t) => {
  const w = world(t);
  only(w, ['linux-a']);
  const share = path.join(w.W, 'share', 'oak-backup');
  fs.mkdirSync(path.dirname(share));
  assert.equal(w.runAs('linux-a', ['sync', 'backup', '--folder', share]).status, 0);
  storeSession(w, 'linux-a', 'sess-ro', { records: [{ id: 1 }], blobs: ['one'] });
  cp.execFileSync('chmod', ['-R', 'a-w', share]);
  let denied;
  try {
    denied = JSON.parse(w.runAs('linux-a', ['sync', 'now', '--json']).stdout);
  } finally {
    cp.execFileSync('chmod', ['-R', 'u+w', share]);
  }
  const line = denied.machines.find((m) => m.label.startsWith('backup'));
  assert.equal(line.status, 'failed', JSON.stringify(line));
  assert.match(line.detail, /could not be written there: EACCES[^\n]*\. Free space there, or make it writable for this machine/);
  const again = w.json('linux-a', ['sync', 'now']).machines.find((m) => m.label.startsWith('backup'));
  assert.equal(again.status, 'ok', JSON.stringify(again));
  assert.ok(again.pushed.files >= 2, JSON.stringify(again));
});

test('sync key: the key --replace replaces is kept beside it; a key file that holds no key is replaced only with --replace, and kept too; a key brought for a folder it does not open leaves the key here as it was; doctor and uninstall say what is there', { skip: POSIX }, (t) => {
  const w = world(t);
  only(w, ['linux-a', 'linux-b']);
  const K = (n) => 'oak-sync-1:' + Buffer.alloc(32, n).toString('base64url');
  const keyFile = (m) => storeOf(w, m, 'sync', 'key');
  const beside = (m) => fs.readdirSync(path.dirname(keyFile(m))).filter((n) => n.startsWith('key.replaced-')).map((n) => read(path.join(path.dirname(keyFile(m)), n)).trim()).sort();
  // Replaced on purpose: the old key is kept beside the new one, mode 0600, since a backup sealed under it opens with nothing else.
  assert.equal(w.runAs('mac', ['sync', 'key', '--import'], {}, { input: K(1) }).status, 0);
  const swap = w.runAs('mac', ['sync', 'key', '--import', '--replace', '--json'], {}, { input: K(2) });
  assert.equal(swap.status, 0, swap.stderr);
  const kept = JSON.parse(swap.stdout).syncKey.replaced;
  assert.equal(read(kept).trim(), K(1), 'the replaced key, where the answer says');
  assert.equal(fs.statSync(kept).mode & 0o777, 0o600);
  // A key file that holds no key (cut short, edited by hand): `oak sync key` says what to do, and nothing replaces it unasked.
  fs.writeFileSync(keyFile('mac'), 'oak-sync-1:cut-sh');
  const shown = w.runAs('mac', ['sync', 'key']);
  assert.equal(shown.status, 1);
  assert.match(shown.stderr, /does not hold an oak sync key[\s\S]*oak sync key --from <machine> --replace/);
  const refused = w.runAs('mac', ['sync', 'key', '--import'], {}, { input: K(3) });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /holds no key OAK can read\. Pass --replace/);
  assert.equal(read(keyFile('mac')), 'oak-sync-1:cut-sh', 'nothing written over it unasked');
  assert.equal(w.runAs('mac', ['sync', 'key', '--import', '--replace'], {}, { input: K(3) }).status, 0);
  assert.equal(read(keyFile('mac')).trim(), K(3));
  assert.deepEqual(beside('mac'), [K(1), 'oak-sync-1:cut-sh'].sort(), 'the file that held no key is kept beside it too');
  // A backup folder set with no key here, and then a key file that holds none: doctor warns, and its fix works.
  const share = path.join(w.W, 'share', 'oak-backup');
  fs.mkdirSync(path.dirname(share));
  assert.equal(w.runAs('linux-a', ['sync', 'backup', '--folder', share]).status, 0);
  w.syncPrefs('linux-b', { backup: { kind: 'folder', path: share }, exclude: { machines: ['mac', 'lab'] } });
  const row = (m) => JSON.parse(w.runAs(m, ['doctor', '--json']).stdout).checks.find((c) => c.id === 'sync-backup');
  const none = row('linux-b');
  assert.equal(none.level, 'warn', JSON.stringify(none));
  assert.match(none.fix, /oak sync key --from <machine>`/);
  fs.mkdirSync(path.dirname(keyFile('linux-b')), { recursive: true });
  fs.writeFileSync(keyFile('linux-b'), 'not a key\n');
  const bad = row('linux-b');
  assert.equal(bad.level, 'warn', JSON.stringify(bad));
  assert.match(bad.fix, /oak sync key --from <machine> --replace/);
  assert.equal(w.runAs('linux-b', ['sync', 'key', '--from', 'linux-a', '--replace']).status, 0, 'its fix works');
  assert.equal(row('linux-b').level, 'ok');
  // A key brought for the folder that does not open it (the Mac's is another): refused, and the key here is as it was.
  const before = read(keyFile('linux-b'));
  const wrong = w.runAs('linux-b', ['sync', 'setup', '--folder', share, '--key-from', 'mac', '--replace']);
  assert.equal(wrong.status, 1, wrong.stdout);
  assert.match(wrong.stderr, /does not open/);
  assert.equal(read(keyFile('linux-b')), before, 'the key here is not replaced by one that does not open the folder');
  // `oak uninstall --all` names the key and the backup folder, which holds every machine's encrypted copy.
  const steps = w.runAs('linux-a', ['uninstall', '--all']).stdout;
  assert.match(steps, /Sync state: delete [^\n]*it holds the backup key: keep it first, `oak sync key --show`/);
  assert.ok(steps.includes(`Backup folder: ${share}`), steps);
});

test('sync key: a key pasted at the prompt on a terminal is never shown', { skip: POSIX || (!ptyMod && 'node-pty is unavailable') }, async (t) => {
  const w = world(t);
  const key = 'oak-sync-1:' + Buffer.alloc(32, 6).toString('base64url');
  const env = { ...w.envFor('mac'), TERM: 'xterm-256color', CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1' };
  const child = ptyMod.spawn(process.execPath, ['--require', preload, cli, 'sync', 'key', '--import'], { cols: 200, rows: 30, cwd: w.io, env, name: 'xterm-256color' });
  let out = '';
  child.onData((d) => { out += d; });
  const exited = new Promise((resolve) => child.onExit(({ exitCode }) => resolve(exitCode)));
  const until = async (re) => {
    for (const end = Date.now() + 30_000; !re.test(out); await new Promise((r) => setTimeout(r, 50))) if (Date.now() > end) assert.fail(`never showed ${re}: ${JSON.stringify(out)}`);
  };
  try {
    await until(/then press Enter: /);
    child.write(key + '\r');
    await until(/the backup key [0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4} at /);
    assert.equal(await exited, 0, out);
  } finally {
    try { child.kill(); } catch { /* gone */ }
  }
  assert.ok(!out.includes(key.slice('oak-sync-1:'.length, 30)), `the key was shown: ${JSON.stringify(out)}`);
  assert.equal(read(storeOf(w, 'mac', 'sync', 'key')).trim(), key, 'and kept');
});

test('sync folder: a machine reinstalled neither restores from its record nor writes it until it takes it over, which every run, `oak sync status` and `oak sync setup` say; `--restore` takes it over, and a machine whose writer is another is refused', { skip: POSIX }, (t) => {
  const w = world(t);
  const s = seed(w);
  only(w, ['linux-a']);
  storeSession(w, 'linux-a', 'sess-mine', { records: [{ id: 1 }] });
  const share = path.join(w.W, 'share', 'oak-backup');
  fs.mkdirSync(path.dirname(share));
  assert.equal(w.runAs('linux-a', ['sync', 'backup', '--folder', share]).status, 0);
  w.json('linux-a', ['sync', 'now']);
  const key = keyOf(w, 'linux-a').text;
  fs.rmSync(path.join(s.A, '.claude'), { recursive: true, force: true });
  assert.equal(w.runAs('linux-a', ['sync', 'key', '--import'], {}, { input: key }).status, 0);
  only(w, ['linux-a'], { backup: { kind: 'folder', path: share } });
  const quiet = snapshot(share);
  const said = /failed: the backup folder holds a record under this machine's name \(its host name and home folder\) that this machine has not written: last written \S+ by linux-a \(home [^)]+\)\. If this machine is a reinstall of that one, `oak sync setup --restore`/;
  for (let i = 0; i < 2; i++) {
    const run = w.runAs('linux-a', ['sync', 'now']);
    assert.equal(run.status, 1, 'every machine it asked failed');
    assert.match(run.stdout, said);
  }
  assert.match(w.runAs('linux-a', ['sync', 'status']).stdout, said);
  // In JSON the backup's line names the record's state, for a surface to offer the reinstall choice: the run's own…
  const nowJson = JSON.parse(w.runAs('linux-a', ['sync', 'now', '--json']).stdout);
  assert.equal(nowJson.machines.find((m) => m.label.startsWith('backup (')).record, 'unclaimed');
  // …and the status's.
  const refused = w.json('linux-a', ['sync', 'status']).last.machines.find((m) => m.label.startsWith('backup ('));
  assert.deepEqual([refused.status, refused.record], ['failed', 'unclaimed']);
  // …and its `text` is the line `oak sync status` prints after the label, which every surface shows.
  assert.equal(refused.text, `failed: ${refused.detail}`);
  assert.ok(w.runAs('linux-a', ['sync', 'status']).stdout.includes(`${refused.label}   ${refused.text}\n`));
  assert.ok(!fs.existsSync(storeOf(w, 'linux-a', 'sess-mine')), 'nothing restored');
  assert.deepEqual(diffSnapshots(quiet, snapshot(share)), [], 'nor written there');
  // `oak sync setup` off a terminal, without --restore, says what to do and takes nothing over.
  const setup = w.runAs('linux-a', ['sync', 'setup', '--folder', share]);
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /the folder holds a record under this machine's name \(its host name and home folder\) that this machine has not written: last written \S+ by linux-a[^\n]*`oak sync setup --folder \S+ --restore` takes it over and restores from it; if it is another machine, give it another host name/);
  // One account of it: the plan setup prints is made, and says nothing the line above did not.
  assert.match(setup.stdout, /Sync plan \(preview/, 'control: the plan is printed');
  assert.doesNotMatch(setup.stdout, /could not be made/, setup.stdout);
  assert.equal(setup.stdout.split('has not written').length, 2, `the record is said once: ${setup.stdout}`);
  assert.equal(JSON.parse(w.runAs('linux-a', ['sync', 'setup', '--folder', share, '--json']).stdout).record.state, 'unclaimed');
  assert.match(w.runAs('linux-a', ['sync', 'setup', '--none', '--restore']).stderr, /--restore` takes over a backup folder's record: give it with --folder/);
  // --restore takes it over: the next run restores.
  reinstalled(w, 'linux-a', share);
  const r = w.json('linux-a', ['sync', 'now']);
  assert.equal(r.status, 'ok', JSON.stringify(r.machines));
  assert.ok(fs.existsSync(storeOf(w, 'linux-a', 'sess-mine', 'log.jsonl')), 'restored');
  // A writer id of another machine's here: refused as another machine's record, every run.
  fs.writeFileSync(storeOf(w, 'linux-a', 'sync', 'writer'), `${'c'.repeat(32)}\n`);
  assert.match(w.runAs('linux-a', ['sync', 'now']).stdout, /failed: another machine with this machine's host name and home folder writes the backup folder's record under that name/);
  assert.equal(w.json('linux-a', ['sync', 'status']).last.machines.find((m) => m.label.startsWith('backup (')).record, 'other');
  // …which `oak sync setup` says in the plan it previews, as the run does: that reason names what to do in this case.
  const other = w.runAs('linux-a', ['sync', 'setup', '--folder', share]);
  assert.equal(other.status, 0, other.stderr);
  assert.match(other.stdout, /warning: the backup folder cannot be used: another machine with this machine's host name and home folder writes the backup folder's record under that name/, other.stdout);
  assert.doesNotMatch(other.stdout, /could not be made/);
});

test('sync setup: on a terminal, a folder that holds a record under this machine\'s name it has not written asks whether this machine is a reinstall of the one that wrote it, naming when and what wrote it', { skip: POSIX || (!ptyMod && 'node-pty is unavailable') }, async (t) => {
  const w = world(t);
  const s = seed(w);
  only(w, ['linux-a']);
  storeSession(w, 'linux-a', 'sess-asked', { records: [{ id: 1 }] });
  const share = path.join(w.W, 'share', 'oak-backup');
  fs.mkdirSync(path.dirname(share));
  assert.equal(w.runAs('linux-a', ['sync', 'backup', '--folder', share]).status, 0);
  w.json('linux-a', ['sync', 'now']);
  const key = keyOf(w, 'linux-a').text;
  fs.rmSync(path.join(s.A, '.claude'), { recursive: true, force: true });
  assert.equal(w.runAs('linux-a', ['sync', 'key', '--import'], {}, { input: key }).status, 0);
  only(w, ['linux-a']);
  const answer = async (yes) => {
    const env = { ...w.envFor('linux-a'), TERM: 'xterm-256color', CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1' };
    const child = ptyMod.spawn(process.execPath, ['--require', preload, cli, 'sync', 'setup'], { cols: 400, rows: 50, cwd: w.io, env, name: 'xterm-256color' });
    let out = '';
    child.onData((d) => { out += d; });
    const exited = new Promise((resolve) => child.onExit(({ exitCode }) => resolve(exitCode)));
    const until = async (re) => {
      for (const end = Date.now() + 30_000; !re.test(out); await new Promise((r) => setTimeout(r, 50))) if (Date.now() > end) assert.fail(`never showed ${re}: ${JSON.stringify(out)}`);
    };
    try {
      await until(/Choose 1, 2 or 3: /);
      child.write('3\r');
      await until(/The folder's path on this machine: /);
      child.write(`${share}\r`);
      await until(/that this machine has not written: last written \S+ by linux-a[^\n]*\n[\s\S]*Is this machine a reinstall of that one \(its sessions are then restored here, and it writes that record from now on\)\? \[y\/N\] /);
      child.write(yes ? 'y\r' : '\r');
      assert.equal(await exited, 0, out);
    } finally {
      try { child.kill(); } catch { /* gone */ }
    }
    return out;
  };
  assert.match(await answer(false), /give it another host name/, 'no: told what to do');
  assert.match(w.runAs('linux-a', ['sync', 'now']).stdout, /that this machine has not written/, 'and nothing taken over');
  assert.match(await answer(true), /this machine took over the folder's record under its name \(last written \S+ by linux-a/);
  assert.equal(w.json('linux-a', ['sync', 'now']).status, 'ok');
  assert.ok(fs.existsSync(storeOf(w, 'linux-a', 'sess-asked', 'log.jsonl')), 'restored');
});

test('sync setup: on a terminal, a folder\'s key brought over another key here replaces it only once asked, the old one kept beside it', { skip: POSIX || (!ptyMod && 'node-pty is unavailable') }, async (t) => {
  const w = world(t);
  seed(w);
  only(w, ['linux-a', 'linux-b']);
  // linux-b made the backup folder; linux-a keeps a key of its own, made for another folder.
  const share = path.join(w.W, 'share', 'oak-backup');
  fs.mkdirSync(path.dirname(share));
  assert.equal(w.runAs('linux-b', ['sync', 'backup', '--folder', share]).status, 0);
  assert.equal(w.runAs('linux-a', ['sync', 'backup', '--folder', path.join(w.W, 'share', 'own-backup')]).status, 0);
  const own = w.json('linux-a', ['sync', 'key']).syncKey.fingerprint;
  const theirs = w.json('linux-b', ['sync', 'key']).syncKey.fingerprint;
  const setup = async (answer) => {
    const env = { ...w.envFor('linux-a'), TERM: 'xterm-256color', CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1' };
    const child = ptyMod.spawn(process.execPath, ['--require', preload, cli, 'sync', 'setup'], { cols: 400, rows: 50, cwd: w.io, env, name: 'xterm-256color' });
    let out = '';
    child.onData((d) => { out += d; });
    const exited = new Promise((resolve) => child.onExit(({ exitCode }) => resolve(exitCode)));
    const until = async (re) => {
      for (const end = Date.now() + 30_000; !re.test(out); await new Promise((r) => setTimeout(r, 50))) if (Date.now() > end) assert.fail(`never showed ${re}: ${JSON.stringify(out)}`);
    };
    try {
      await until(/Choose 1, 2 or 3: /);
      child.write('3\r');
      await until(/The folder's path on this machine: /);
      child.write(`${share}\r`);
      await until(/holds a backup made with a key this machine does not have[\s\S]*1\) copy it from linux-b[\s\S]*Where from\? /);
      child.write('1\r');
      await until(new RegExp(`This machine keeps another backup key \\(${own}\\)\\. Replace it with the folder's\\? The old one is kept beside it\\. \\[y/N\\] `));
      child.write(answer);
      return { code: await exited, out };
    } finally {
      try { child.kill(); } catch { /* gone */ }
    }
  };
  const no = await setup('\r');
  assert.equal(no.code, 1);
  assert.match(no.out, new RegExp(`nothing changed: this machine keeps its backup key ${own}, which does not open`));
  assert.equal(w.json('linux-a', ['sync', 'key']).syncKey.fingerprint, own, 'no: the key here stands');
  const yes = await setup('y\r');
  assert.equal(yes.code, 0, yes.out);
  assert.equal(w.json('linux-a', ['sync', 'key']).syncKey.fingerprint, theirs, 'yes: the folder\'s key is kept here');
  assert.ok(fs.readdirSync(w.store('linux-a')).some((f) => f.startsWith('key.replaced-')), 'and the old one beside it');
  assert.deepEqual(w.json('linux-a', ['sync', 'backup']).syncBackup, { kind: 'folder', path: share });
});

test('sync key: a machine whose answer to `--from` runs past 64 KB (something there prints first) is refused at once, not read until the timeout', { skip: POSIX }, (t) => {
  const w = world(t);
  const oak = path.join(w.homes.mac, '.local', 'bin', 'oak');
  write(oak, '#!/bin/sh\nhead -c 300000 /dev/zero | tr "\\000" x\nsleep 30\n');
  fs.chmodSync(oak, 0o755);
  const t0 = Date.now();
  const r = w.runAs('linux-a', ['sync', 'key', '--from', 'mac']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not read the backup key from mac: failed: its answer was larger than 64 KB, which no key's is/);
  assert.ok(Date.now() - t0 < 20_000, `refused at once, not after the 30 s the machine holds its output open (${Date.now() - t0} ms)`);
  assert.ok(!fs.existsSync(storeOf(w, 'linux-a', 'sync', 'key')), 'no key kept');
});

test('sync setup: its last line says what is set up (the background runs only with a saved machine or a folder), and a new key\'s advice names the label the other machines use, not this machine\'s own name', { skip: POSIX }, (t) => {
  const w = world(t);
  const alone = w.runAs('mac', ['sync', 'setup', '--none'], { MACHINE_EXEC_MACHINES: '[]' });
  assert.equal(alone.status, 0, alone.stderr);
  assert.match(alone.stdout, /nothing is set up to sync with yet: no machine is saved here \(`oak machine add <label> <ssh-target>` saves one\) and no backup folder is set/);
  assert.doesNotMatch(alone.stdout, /in the background/);
  const saved = w.runAs('linux-a', ['sync', 'setup', '--none']);
  assert.match(saved.stdout, /`oak sync now` runs it; after that, the capture hooks keep it running in the background/);
  const share = path.join(w.W, 'share', 'oak-backup');
  fs.mkdirSync(path.dirname(share));
  const folder = w.runAs('mac', ['sync', 'setup', '--folder', share], { MACHINE_EXEC_MACHINES: '[]' });
  assert.match(folder.stdout, /keep it running in the background/, 'a folder is something to sync with');
  assert.match(folder.stdout, /run `oak sync setup --folder <the folder's path there> --key-from <the label that machine saved this one under> --replace` \(`oak machine list` there shows the label; a key that machine kept for another folder is kept beside this one\)/);
  assert.doesNotMatch(folder.stdout, /--from mac\b/);
});

// The new key's advice works where the old one did not: on a machine whose backup is still the folder before. One of
// them lost the key it held for that folder (`oak sync key --from` alone refuses a key that does not open the folder set
// there); the other still keeps it, which a key brought for another folder replaces only with --replace. The setup the
// advice names, run as it is printed, takes the new folder and its key in one step on both.
test('sync setup: a new key\'s advice works on a machine whose backup is still another folder, whether or not it kept that folder\'s key', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  only(w, ['linux-a', 'linux-b', 'mac']);
  const old = path.join(w.W, 'share', 'old-backup'), fresh = path.join(w.W, 'share', 'new-backup');
  fs.mkdirSync(path.dirname(old));
  assert.equal(w.runAs('linux-a', ['sync', 'setup', '--folder', old]).status, 0);
  for (const m of ['linux-b', 'mac']) assert.equal(w.runAs(m, ['sync', 'setup', '--folder', old, '--key-from', 'linux-a']).status, 0, `control: ${m} uses the old folder`);
  const oldKey = w.json('mac', ['sync', 'key']).syncKey.fingerprint;
  for (const m of ['linux-a', 'linux-b']) fs.rmSync(storeOf(w, m, 'sync', 'key'));
  const made = w.runAs('linux-a', ['sync', 'setup', '--folder', fresh]);
  assert.equal(made.status, 0, made.stderr);
  const advised = /run `oak sync setup --folder <the folder's path there> --key-from <the label that machine saved this one under>((?: --[a-z-]+)*)`/.exec(made.stdout);
  assert.ok(advised, made.stdout);
  const flags = advised[1].split(' ').filter(Boolean);
  assert.match(w.runAs('linux-b', ['sync', 'key', '--from', 'linux-a']).stderr, /that key does not open the backup folder set here/, 'control: the key alone is refused there');
  assert.match(w.runAs('mac', ['sync', 'setup', '--folder', fresh, '--key-from', 'linux-a']).stderr, /a different backup key is already kept here/, 'control: without --replace, the Mac keeps the old folder\'s key');
  // As advised, with the folder's path on each machine and the label each saved linux-a under.
  for (const m of ['linux-b', 'mac']) {
    const r = w.runAs(m, ['sync', 'setup', '--folder', fresh, '--key-from', 'linux-a', ...flags]);
    assert.equal(r.status, 0, `${m}: ${r.stderr}`);
    assert.equal(w.json(m, ['sync', 'key']).syncKey.fingerprint, w.json('linux-a', ['sync', 'key']).syncKey.fingerprint, `the new folder's key is kept on ${m}`);
    assert.deepEqual(w.json(m, ['sync', 'status']).backup, { kind: 'folder', path: fresh }, `and the new folder is ${m}'s backup`);
  }
  const beside = fs.readdirSync(storeOf(w, 'mac', 'sync')).filter((n) => n.startsWith('key.replaced-'));
  assert.equal(beside.length, 1, 'the Mac keeps the old folder\'s key beside the new one');
  assert.notEqual(oldKey, w.json('mac', ['sync', 'key']).syncKey.fingerprint);
});

test('sync: `oak uninstall --all --purge-store` takes the list of the sessions it purged with them where that list is all of sync\'s state, and names it where sync ran', { skip: POSIX }, (t) => {
  const w = world(t);
  seed(w);
  storeSession(w, 'mac', 'sess-purged', { records: [{ id: 1 }] });
  const purged = w.runAs('mac', ['uninstall', '--all', '--purge-store']);
  assert.equal(purged.status, 0, purged.stderr);
  assert.match(purged.stdout, /purged the store \(1 session\(s\)\)/);
  assert.ok(!fs.existsSync(storeOf(w, 'mac', 'sync')), 'no list of the purged sessions left behind');
  assert.doesNotMatch(purged.stdout, /Sync state/);
  // Where sync ran, its state stays, the list with it, and the teardown names it.
  w.syncPrefs('linux-b', { backup: { kind: 'machine', label: 'linux-b' } });
  w.json('linux-b', ['sync', 'now']);
  storeSession(w, 'linux-b', 'sess-purged-b', { records: [{ id: 1 }] });
  const kept = w.runAs('linux-b', ['uninstall', '--all', '--purge-store']);
  assert.ok(read(storeOf(w, 'linux-b', 'sync', 'evicted.jsonl')).includes('sess-purged-b'));
  // The step deletes the rest of it, and says to keep that list while oak sync runs elsewhere: without it, the other
  // machines' copies come back here.
  assert.ok(kept.stdout.includes(`Sync state: delete everything in ${storeOf(w, 'linux-b', 'sync')} but evicted.jsonl  (oak sync's trash, conflict copies, merge bases and the copies of other machines' sessions)\n`), kept.stdout);
  assert.ok(kept.stdout.includes(`keep ${storeOf(w, 'linux-b', 'sync', 'evicted.jsonl')} while oak sync runs on another of your machines: it lists the sessions removed here, whose copies there would otherwise come back with this machine's next run\n`), kept.stdout);
  assert.ok(!purged.stdout.includes('evicted.jsonl'), 'not where sync never ran');
});

// An OAK older than 0.11.0 still running beside this one rewrites prefs.json with only the keys it knows (a terminal app's
// tab switch, an editor's sort): oak sync's settings went with it, and the backup and the excluded projects with them.
// Every read here takes them from oak sync's copy (a read-only command writes nothing); the next listing or sync run writes
// them back; a command run in a terminal says so once, after its own output, and `oak doctor`, which every surface shows,
// says it too. A run in a pipe (a hook, the status line, an editor) says nothing and leaves the telling to the terminal.
test('sync settings: an older OAK\'s rewrite of prefs.json is undone at the next read, which a command in a terminal says once and `oak doctor` says too', { skip: POSIX || (!ptyMod && 'node-pty is unavailable') }, async (t) => {
  const w = world(t);
  seed(w);
  w.syncPrefs('linux-b', { backup: { kind: 'machine', label: 'linux-b' }, exclude: { projects: ['home:secret'] } });
  // A listing (its catch-up) makes oak sync's copy of them, on an install made before it kept one.
  assert.equal(w.runAs('linux-b', ['sessions', '--json']).status, 0);
  assert.ok(fs.existsSync(storeOf(w, 'linux-b', 'sync', 'settings.json')), 'control: the copy');
  const prefs = storeOf(w, 'linux-b', 'prefs.json');
  // OAK 0.10.0's writePrefs, written out from its source: the keys it knows, and none other.
  const rewrite = () => { const raw = JSON.parse(read(prefs)); write(prefs, JSON.stringify(Object.fromEntries(Object.entries(raw).filter(([k]) => ['sort', 'theme', 'layout', 'keys', 'storeDir'].includes(k))), null, 2) + '\n'); };
  rewrite();
  assert.equal(JSON.parse(read(prefs)).sync, undefined, 'control: dropped');
  const status = w.runAs('linux-b', ['sync', 'status', '--json']);
  assert.deepEqual([JSON.parse(status.stdout).backup, JSON.parse(status.stdout).exclude.projects], [{ kind: 'machine', label: 'linux-b' }, ['home:secret']], 'read from the copy');
  assert.equal(JSON.parse(read(prefs)).sync, undefined, 'by a read-only command, which writes nothing');
  const piped = w.runAs('linux-b', ['sessions', '--json']);
  assert.deepEqual(JSON.parse(read(prefs)).sync.exclude, { projects: ['home:secret'] }, 'a listing writes them back to prefs.json');
  assert.doesNotMatch(piped.stderr, /had lost/, 'a run in a pipe says nothing');
  const onTerminal = async (args = ['sync', 'status']) => {
    const child = ptyMod.spawn(process.execPath, ['--require', preload, cli, ...args], { cols: 400, rows: 50, cwd: w.io, env: w.envFor('linux-b'), name: 'xterm-256color' });
    let out = '';
    child.onData((d) => { out += d; });
    const code = await new Promise((resolve) => child.onExit(({ exitCode }) => resolve(exitCode)));
    assert.equal(code, 0, out);
    return out.replace(/\x1b\[[0-9;]*m/g, '');
  };
  assert.doesNotMatch(await onTerminal(['--version']), /had lost/, '`oak --version` says nothing, and leaves it to be said');
  assert.match(await onTerminal(), /⚠ prefs\.json had lost oak sync's settings, so OAK put them back from oak sync's copy \([^)]*settings\.json\): an OAK older than 0\.11\.0 rewrote the file with only the settings it knows\. Quit or update that OAK: `oak doctor` says where it may be running\./);
  assert.doesNotMatch(await onTerminal(), /had lost/, 'once');
  // A sync run writes them back too.
  rewrite();
  w.json('linux-b', ['sync', 'now']);
  assert.deepEqual(JSON.parse(read(prefs)).sync.backup, { kind: 'machine', label: 'linux-b' }, 'a sync run writes them back');
  // A setting changed after a drop, before anything wrote them back, is changed over the settings kept, and that restore is
  // recorded, to be said.
  rewrite();
  const restoredAt = () => JSON.parse(read(storeOf(w, 'linux-b', 'sync', 'settings.json'))).restoredAt;
  const before = restoredAt();
  assert.equal(w.runAs('linux-b', ['sync', 'exclude', 'lab']).status, 0);
  assert.ok(restoredAt() > before, 'the restore is recorded');
  assert.deepEqual(JSON.parse(read(prefs)).sync, { backup: { kind: 'machine', label: 'linux-b' }, exclude: { projects: ['home:secret'], machines: ['lab'] } });
  const doctor = JSON.parse(w.runAs('linux-b', ['doctor', '--json']).stdout).checks.find((c) => c.id === 'sync-settings');
  assert.equal(doctor?.level, 'warn', 'oak doctor says it');
});
