// oak sync's identity keys, mount tables and plan, on synthetic inventories: two Linux machines whose homes are both
// /home/u (so their Claude project folders have the same names) and a Mac at /Users/u.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const core = require(path.join(__dirname, '..', 'dist'));
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-29T12:00:00Z');

/** Claude Code's folder name for a working directory under 200 characters: every non-alphanumeric becomes `-`. */
const folderOf = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

test('sync identity: origin URLs of one repository normalize to one key, credentials and ports dropped', () => {
  const same = [
    'git@github.com:Org/App.git',
    'https://github.com/Org/App',
    'https://user:token@GitHub.COM/Org/App.git/',
    'ssh://git@github.com:22/Org/App.git',
    'ssh://git@github.com/Org//App',
    'git+ssh://git@github.com/Org/App.git',
    'github.com:Org/App',
    'https://github.com/Org/App.git?ref=main#readme',
  ];
  for (const url of same) assert.equal(core.normalizeGitUrl(url), 'github.com/Org/App', url);
  assert.equal(core.normalizeGitUrl('git@gitlab.example.org:group/sub/Project.git'), 'gitlab.example.org/group/sub/Project', 'the path keeps its case and depth');
  assert.equal(core.normalizeGitUrl('https://[2001:db8::1]:8443/x/y.git'), '2001:db8::1/x/y');
  for (const local of ['/srv/git/app.git', '../app.git', 'file:///srv/git/app.git', 'C:\\repos\\app', 'C:/repos/app', ''])
    assert.equal(core.normalizeGitUrl(local), null, `a local origin names no server: ${local}`);
});

test('sync identity: the origin is read from git config with its quoting, comments and case rules', () => {
  const config = [
    '[core]', '\tbare = false',
    '[remote "upstream"]', '\turl = git@github.com:Other/Fork.git',
    '[Remote "origin"] ; a comment', '\tfetch = +refs/heads/*:refs/remotes/origin/*', '\tURL = "git@github.com:Org/App.git" # trailing',
    '[remote "origin"]', '\turl = git@github.com:Second/Ignored.git',
  ].join('\n');
  assert.equal(core.originUrlFromConfig(config), 'git@github.com:Org/App.git');
  assert.equal(core.originUrlFromConfig('[remote "Origin"]\n\turl = x:y/z\n'), null, 'the remote\'s name is case-sensitive');
  assert.equal(core.originUrlFromConfig('[remote "origin"]\n\turl = "a\\"b"\n'), 'a"b');
});

test('sync identity: mount tables, Linux and macOS, name each network share by server and share', () => {
  const linux = [
    '//FS1.example.org/labshare/lab /groups/lab cifs rw,relatime,vers=3.1.1 0 0',
    'fs2:/export/home /nfs/home nfs4 rw 0 0',
    '[2001:db8::2]:/data /mnt/v6 nfs rw 0 0',
    '//fs1.example.org/My\\040Share /mnt/my\\040share cifs rw 0 0',
    'tmpfs /tmp tmpfs rw 0 0',
    '/dev/sda1 / ext4 rw 0 0',
  ].join('\n');
  assert.deepEqual(core.parseMountTable(linux, 'linux'), [
    { server: 'fs1.example.org', share: 'labshare/lab', mount: '/groups/lab', type: 'cifs' },
    { server: 'fs2', share: 'export/home', mount: '/nfs/home', type: 'nfs4' },
    { server: '2001:db8::2', share: 'data', mount: '/mnt/v6', type: 'nfs' },
    { server: 'fs1.example.org', share: 'My Share', mount: '/mnt/my share', type: 'cifs' },
  ]);
  const mac = [
    '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
    '//u@fs1.example.org/labshare on /Volumes/labshare (smbfs, nodev, nosuid, mounted by u)',
    '//DOMAIN;u@fs1.example.org/My%20Share on /Volumes/My Share (smbfs, nodev, nosuid, mounted by u)',
    'fs2:/export/home on /Volumes/home (nfs, nodev, nosuid, mounted by u)',
    'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)',
  ].join('\n');
  assert.deepEqual(core.parseMountTable(mac, 'mac'), [
    { server: 'fs1.example.org', share: 'labshare', mount: '/Volumes/labshare', type: 'smbfs' },
    { server: 'fs1.example.org', share: 'My Share', mount: '/Volumes/My Share', type: 'smbfs' },
    { server: 'fs2', share: 'export/home', mount: '/Volumes/home', type: 'nfs' },
  ]);
});

test('sync identity: git before home before share before path, git only for a directory that exists', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-id-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, 'src', 'app');
  fs.mkdirSync(path.join(repo, 'pkg', 'core'), { recursive: true });
  cp.execFileSync('git', ['init', '-q', repo]);
  cp.execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:Org/App.git']);
  const shares = [{ server: 'fs1', share: 'labshare', mount: path.join(home, 'share-mount'), type: 'cifs' }, { server: 'fs9', share: 'far', mount: '/far/away', type: 'nfs' }];
  const id = (cwd) => core.identityKey(cwd, { home, shares });
  assert.deepEqual(id(repo), { key: 'git:github.com/Org/App', root: repo });
  assert.deepEqual(id(path.join(repo, 'pkg', 'core')), { key: 'git:github.com/Org/App//pkg/core', root: repo });
  // A directory inside the repository that is not on this machine (a deleted worktree) is not the repository.
  assert.deepEqual(id(path.join(repo, 'gone')), { key: 'home:src/app/gone' });
  assert.deepEqual(id(home), { key: 'home:.' });
  assert.deepEqual(id(path.join(home, 'notes')), { key: 'home:notes' });
  assert.deepEqual(id(path.join(home, 'share-mount', 'u')), { key: 'home:share-mount/u' }, 'a share mounted inside the home is the home\'s');
  assert.deepEqual(id('/far/away/u/proj'), { key: 'share:fs9/far/u/proj' });
  assert.deepEqual(id('/far/awayish'), { key: 'path:/far/awayish' }, 'a mount point is a whole path segment');
  assert.deepEqual(id('/opt/x'), { key: 'path:/opt/x' });
  // A repository without an origin has no git identity.
  const bare = path.join(home, 'no-origin');
  cp.execFileSync('git', ['init', '-q', bare]);
  assert.deepEqual(id(bare), { key: 'home:no-origin' });
  // A linked worktree inside the main working tree is that repository, at its own path below it.
  cp.execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.org', 'commit', '-q', '--allow-empty', '-m', 'x']);
  const wt = path.join(repo, '.claude', 'worktrees', 'feat');
  cp.execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', wt]);
  assert.deepEqual(id(wt), { key: 'git:github.com/Org/App//.claude/worktrees/feat', root: repo });
  // One outside it answers relative to its own top.
  const sibling = path.join(home, 'src', 'app-feat');
  cp.execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', sibling]);
  assert.deepEqual(id(sibling), { key: 'git:github.com/Org/App', root: sibling });
});

/** A synthetic inventory of a machine with home `home`, its sessions given as [cwd, key, [session ids]]. */
function inv(host, home, sessions, extra = {}) {
  const projects = [];
  const identities = {};
  const transcripts = [];
  for (const [cwd, key, ids, mtime = NOW - DAY, root] of sessions) {
    const folder = folderOf(cwd);
    projects.push({ folder, cwd });
    identities[cwd] = { key, ...(root ? { root } : {}) };
    for (const [id, size] of ids) transcripts.push({ name: `${folder}/${id}.jsonl`, size, mtime });
  }
  const families = { transcripts, 'session-files': [], memory: [], plans: [], skills: [], agents: [], commands: [], rollouts: [], ...(extra.families ?? {}) };
  return { inventory: 1, at: NOW, host, user: 'u', home, platform: home.startsWith('/Users/') ? 'darwin' : 'linux', cleanupPeriodDays: 3650, projects, identities, shares: [], codexSqlite: [], ...extra, families };
}
const node = (label, inventory, local = false) => ({ label, local, status: 'ok', inventory });

test('sync plan: same paths map to the same folder; a Mac\'s clone, home and share map by identity', () => {
  const app = (h) => `${h}/Github/app`;
  const a = inv('aaaaaaaaaaaa', '/home/u', [[app('/home/u'), 'git:github.com/Org/App', [['s1', 100]], NOW - DAY, app('/home/u')], ['/home/u/notes', 'home:notes', [['s2', 50]]]],
    { shares: [{ server: 'fs1', share: 'labshare', mount: '/groups/labshare', type: 'cifs' }] });
  const b = inv('bbbbbbbbbbbb', '/home/u', [[app('/home/u'), 'git:github.com/Org/App', [['s1', 160], ['s3', 70]], NOW - DAY, app('/home/u')], ['/groups/labshare/u/proj', 'share:fs1/labshare/u/proj', [['s4', 10]]]]);
  const mac = inv('cccccccccccc', '/Users/u', [['/Users/u/src/app/pkg', 'git:github.com/Org/App//pkg', [['s5', 30]], NOW - DAY, '/Users/u/src/app'], ['/Users/u', 'home:.', [['s6', 20]]], ['/Volumes/labshare/u/proj', 'share:fs1/labshare/u/proj', [['s7', 40]]]],
    { shares: [{ server: 'fs1', share: 'labshare', mount: '/Volumes/labshare', type: 'smbfs' }] });
  const plan = core.planSync([node('a', a, true), node('b', b), node('mac', mac)], NOW);
  const [pa, pb, pm] = plan.machines;
  const to = (m) => Object.fromEntries(m.pulls.map((p) => [`${p.from}:${p.name.split('/').pop()}`, [p.to, p.reason]]));
  // a: b's longer s1 and its s3 land in the folder both machines name the same; b's share session where the share is
  // mounted here; the Mac's subdirectory of the repository under a's checkout, and its home session in a's home.
  assert.deepEqual(to(pa), {
    'b:s1.jsonl': [`${folderOf(app('/home/u'))}/s1.jsonl`, 'longer'],
    'b:s3.jsonl': [`${folderOf(app('/home/u'))}/s3.jsonl`, 'missing'],
    'b:s4.jsonl': [`${folderOf('/groups/labshare/u/proj')}/s4.jsonl`, 'missing'],
    'mac:s5.jsonl': [`${folderOf('/home/u/Github/app/pkg')}/s5.jsonl`, 'missing'],
    'mac:s6.jsonl': [`${folderOf('/home/u')}/s6.jsonl`, 'missing'],
    'mac:s7.jsonl': [`${folderOf('/groups/labshare/u/proj')}/s7.jsonl`, 'missing'],
  });
  assert.deepEqual(pa.unmapped, []);
  // b lists no mount of the share, but a session of its own there has the same key, which places the Mac's.
  assert.equal(to(pb)['mac:s7.jsonl'][0], `${folderOf('/groups/labshare/u/proj')}/s7.jsonl`);
  assert.deepEqual(pb.diverged.map((d) => [d.from, d.to, d.localSize, d.size]), [['a', `${folderOf(app('/home/u'))}/s1.jsonl`, 160, 100]]);
  // The Mac: a's notes in /Users/u/notes; a and b's sessions in its own clone's folder.
  assert.equal(to(pm)['a:s2.jsonl'][0], `${folderOf('/Users/u/notes')}/s2.jsonl`);
  assert.equal(to(pm)['b:s1.jsonl'][0], `${folderOf('/Users/u/src/app')}/s1.jsonl`);
  assert.equal(to(pm)['a:s1.jsonl'], undefined, 'of two copies, only the longer is planned');
  assert.equal(to(pm)['b:s4.jsonl'][0], `${folderOf('/Volumes/labshare/u/proj')}/s4.jsonl`);
});

test('sync plan: unplaceable keys are named, never guessed; a path with no session here is not taken', () => {
  const a = inv('aaaaaaaaaaaa', '/home/u', [['/home/u/x', 'home:x', [['s0', 1]]], ['/srv/one', 'git:github.com/Org/App', [['s9', 1]], NOW - DAY, '/srv/one'], ['/srv/two', 'git:github.com/Org/App', [['s8', 1]], NOW - DAY, '/srv/two']]);
  const peer = inv('dddddddddddd', '/home/v', [
    ['/home/v/r', 'git:github.com/Org/Other', [['p1', 5]]],
    ['/opt/tool', 'path:/opt/tool', [['p2', 5]]],
    ['/mnt/x/y', 'share:fs7/x/y', [['p3', 5]]],
    ['/home/v/app', 'git:github.com/Org/App', [['p4', 5]]],
  ]);
  const plan = core.planSync([node('a', a, true), node('peer', peer)], NOW);
  const reasons = Object.fromEntries(plan.machines[0].unmapped.map((u) => [u.key, u.reason]));
  assert.match(reasons['git:github.com/Org/Other'], /no checkout of its repository/);
  assert.match(reasons['path:/opt/tool'], /its path is not known here/);
  assert.match(reasons['share:fs7/x/y'], /not mounted here/);
  assert.match(reasons['git:github.com/Org/App'], /2 folders here have this identity/, 'two checkouts and neither named like the peer\'s: no guess');
  assert.equal(plan.machines[0].pulls.length, 0);
  // A peer folder whose working directory is unknown lands only in a folder of the same name.
  const named = inv('eeeeeeeeeeee', '/home/u', [['/home/u/x', 'home:x', [['q1', 9]]]]);
  named.projects[0].cwd = null;
  delete named.identities['/home/u/x'];
  const lost = inv('ffffffffffff', '/home/w', [['/home/w/y', 'home:y', [['q2', 9]]]]);
  lost.projects[0].cwd = null;
  const p2 = core.planSync([node('a', a, true), node('named', named), node('lost', lost)], NOW);
  assert.deepEqual(p2.machines[0].pulls.map((p) => p.to), [`${folderOf('/home/u/x')}/q1.jsonl`]);
  assert.match(p2.machines[0].unmapped[0].reason, /no working directory is recorded/);
});

test('sync plan: a machine with no saved machine to sync with is told how to save one', () => {
  const a = inv('aaaaaaaaaaaa', '/home/u', [['/home/u/x', 'home:x', [['s0', 1]]]]);
  const alone = core.planSync([node('a', a, true)], NOW).machines[0];
  assert.ok(alone.warnings.some((x) => /no saved machine to sync with: `oak machine add <label> <ssh-target>`/.test(x)), JSON.stringify(alone.warnings));
  const peer = inv('bbbbbbbbbbbb', '/home/u', []);
  for (const others of [[node('b', peer)], [{ label: 'b', local: false, status: 'unreachable' }]]) {
    assert.ok(!core.planSync([node('a', a, true), ...others], NOW).machines[0].warnings.some((x) => /no saved machine/.test(x)), 'a saved machine, answering or not, is one');
  }
});

test('sync settings: a change through `oak sync` keeps what prefs.json holds that this build cannot read', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-prefs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'prefs.json');
  const later = { kind: 'folder', path: '/mnt/backup', paths: { 'build-box': '/b' } };
  fs.writeFileSync(file, JSON.stringify({ later: 1, sync: { later: true, backup: later, families: { rollouts: 'later', plans: 'off' }, exclude: { machines: ['m1'], later: ['x'] } } }));
  // `oak sync exclude <folder>`: the setting it changes, and everything else as the file had it.
  const p = core.readPrefs(file);
  core.writePrefs({ ...p, sync: { ...p.sync, exclude: { ...p.sync.exclude, projects: ['home:notes'] } } }, file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { prefsFormat: 2, later: 1, sync: { later: true, backup: later, families: { rollouts: 'later', plans: 'off' }, exclude: { machines: ['m1'], later: ['x'], projects: ['home:notes'] } } });
  // What a change removes is removed: the backup (`--none`), and the placement set back to its default.
  const q = core.readPrefs(file);
  const { backup: _gone, ...rest } = q.sync;
  core.writePrefs({ ...q, sync: { ...rest, families: {} } }, file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).sync, { later: true, families: { rollouts: 'later' }, exclude: { machines: ['m1'], later: ['x'], projects: ['home:notes'] } });
});

/** OAK 0.10.0's writePrefs over prefs.json, written out from its source (packages/core/src/prefs.ts at v0.10.0): the
 *  keys it knows, as the file has them, and none other. Every save an older OAK makes rewrites the file so. */
function rewriteAsOak010(file) {
  const known = ['editor', 'color', 'glyphs', 'mouse', 'refreshSeconds', 'billDay', 'gptBillDay', 'startFocus', 'sort', 'theme', 'syntax', 'remoteTitles', 'notify', 'layout', 'storeDir', 'keys'];
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(raw).filter(([k]) => known.includes(k))), null, 2) + '\n');
}

// An OAK older than 0.11.0 still running beside this one (a terminal app, a VS Code window not reloaded since the update,
// the old CLI) rewrote prefs.json without oak sync's settings and `machineUsage`: the backup stopped without a word, an
// excluded project synced again, and the saved machines were read over ssh again. oak sync keeps a copy of them, which
// follows every change made to them. A file without the mark every later OAK writes (`prefsFormat`, which that OAK drops
// too) is one it rewrote: every reader reads what it dropped from the copy, and what writes OAK's state anyway (a
// catch-up, a sync run, this build's own save) writes it back. A person's edit leaves the mark, and stands.
test('sync settings: an older OAK\'s rewrite of prefs.json loses neither oak sync\'s settings nor `machineUsage`: they are read from oak sync\'s copy, written back, and said once', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-kept-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  await as(home, () => {
    core.clearRootMemo();
    const file = core.prefsPath();
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    const copied = () => JSON.parse(fs.readFileSync(path.join(core.rootDir(), 'sync', 'settings.json'), 'utf8'));
    core.writePrefs({ sort: 'name', sync: { backup: { kind: 'folder', path: '/mnt/backup' }, exclude: { projects: ['home:secret'] }, auto: false }, machineUsage: false });
    assert.equal(read().prefsFormat, 2, 'this build marks what it writes');
    assert.deepEqual([copied().sync.exclude, copied().machineUsage], [{ projects: ['home:secret'] }, false], 'and the copy follows it');
    rewriteAsOak010(file);
    assert.deepEqual(read(), { sort: 'name' }, 'control: the older OAK\'s rewrite drops both, and the mark');
    // Every reader reads them kept: what other machines are told, the usage readouts, the sync run's own settings.
    assert.deepEqual(core.syncInventory({ user: core.localUserName() }).sync.excludeProjects, ['home:secret'], 'the inventory other machines read');
    assert.equal(core.machineUsageEnabled(), false, 'the saved machines\' usage stays off');
    const s = core.syncSettings();
    assert.deepEqual([s.backup, s.excludeProjects, s.auto], [{ kind: 'folder', path: '/mnt/backup' }, ['home:secret'], false], 'the settings read are the ones kept');
    assert.deepEqual(read(), { sort: 'name' }, 'reading writes nothing: `oak sync plan` and `oak sync status` stay read-only');
    // The background run stays off as it was set: no hook or poller kicks one, though a run is due.
    const syncDir = path.join(core.rootDir(), 'sync');
    fs.writeFileSync(path.join(syncDir, 'status.json'), JSON.stringify({ at: Date.now() - 2 * core.SYNC_AUTO_MS }));
    assert.equal(core.claimSyncKick(), false, 'no background run where `auto` is off');
    assert.match(core.diagnoseSync().find((r) => r.id === 'sync-settings')?.detail ?? '', /prefs\.json has lost oak sync's settings and "machineUsage", so OAK reads them from oak sync's copy/, 'oak doctor says so before they are written back');
    // A catch-up or a sync run writes them back, marked, and the restore is said once.
    core.keptPrefs(true);
    assert.deepEqual([read().sync?.exclude, read().machineUsage, read().prefsFormat, read().sort], [{ projects: ['home:secret'] }, false, 2, 'name'], 'prefs.json holds them again');
    assert.match(core.takeKeptPrefsNotice(), /prefs\.json had lost oak sync's settings and "machineUsage", so OAK put them back from oak sync's copy \(.*settings\.json\): an OAK older than 0\.11\.0 rewrote the file/);
    assert.equal(core.takeKeptPrefsNotice(), null, 'said once');
    const row = core.diagnoseSync().find((r) => r.id === 'sync-settings');
    assert.match(row?.detail ?? '', /had lost .* at /, 'oak doctor says when');
    assert.match(row.fix, /Quit or update that OAK/);
    // Said for a week after the restore, by when that OAK has been quit or updated.
    const aged = (days) => {
      fs.writeFileSync(path.join(syncDir, 'settings.json'), JSON.stringify({ ...copied(), restoredAt: Date.now() - days * 86_400_000 }));
      return core.diagnoseSync().some((r) => r.id === 'sync-settings');
    };
    assert.deepEqual([aged(6), aged(8)], [true, false], 'oak doctor says it for a week');
    assert.match(core.keptPrefsWords(['machineUsage']), /^prefs\.json had lost "machineUsage", so OAK put it back from oak sync's copy/);
    assert.match(core.keptPrefsWords(['machineUsage'], true), /^prefs\.json has lost "machineUsage", so OAK reads it from oak sync's copy .* until the next sync run, or listing with the local database on, writes it back/);
    // So does this build's own save of another setting over the dropped file (the terminal app saving its layout).
    rewriteAsOak010(file);
    core.writePrefs({ ...core.readPrefs(), billDay: 7 });
    assert.deepEqual([read().sync?.backup, read().machineUsage, read().billDay], [{ kind: 'folder', path: '/mnt/backup' }, false, 7], 'a save over the dropped file writes them back');
    assert.match(core.takeKeptPrefsNotice() ?? '', /had lost oak sync's settings and "machineUsage"/, 'and that restore is said too');
    // A change made since, in this build, is what comes back: the backup set to none, then dropped again.
    const p = core.keptPrefs();
    const { backup: _none, ...rest } = p.sync;
    core.writePrefs({ ...p, sync: rest });
    rewriteAsOak010(file);
    assert.deepEqual([core.syncSettings().backup, core.syncSettings().excludeProjects], [null, ['home:secret']], 'no backup comes back that was set to none');
    // One put back by hand into the dropped file since is its own; the others come back from the copy.
    core.keptPrefs(true);
    core.writePrefs({ ...core.readPrefs(), machineUsage: undefined, sync: { backup: { kind: 'folder', path: '/mnt/backup' } } });
    assert.deepEqual([copied().sync, copied().machineUsage], [{ backup: { kind: 'folder', path: '/mnt/backup' } }, undefined], 'control: the copy holds no `machineUsage`');
    rewriteAsOak010(file);
    fs.writeFileSync(file, JSON.stringify({ ...read(), machineUsage: false }, null, 2) + '\n');
    core.keptPrefs(true);
    assert.deepEqual([read().sync?.backup, read().machineUsage, read().prefsFormat], [{ kind: 'folder', path: '/mnt/backup' }, false, 2], 'the backup back, `machineUsage` as the person put it');
    assert.equal(copied().machineUsage, false, 'and the copy follows the file');
    // A save that lands while they are written back is not lost under them: it stands, for the next upkeep.
    rewriteAsOak010(file);
    const real = fs.writeFileSync;
    fs.writeFileSync = function (f, ...rest) {
      const done = real.call(fs, f, ...rest);
      if (String(f).startsWith(`${file}.tmp-`)) {
        fs.writeFileSync = real;
        real.call(fs, file, JSON.stringify({ ...read(), billDay: 9 }, null, 2) + '\n');
      }
      return done;
    };
    try {
      core.keptPrefs(true);
    } finally {
      fs.writeFileSync = real;
    }
    assert.deepEqual([read().billDay, read().sync], [9, undefined], 'the other writer\'s save stands');
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith('prefs.json.tmp-')), [], 'and no write of its own is left behind');
    core.keptPrefs(true);
    assert.deepEqual([read().billDay, read().sync?.backup, read().prefsFormat], [9, { kind: 'folder', path: '/mnt/backup' }, 2], 'and the next upkeep writes them back over it');
    // A setting put back into a dropped file since (by hand, or by an OAK that knows it) stands as written, over the copy:
    // `sync` whole, as an OAK of a 0.11.0 pre-release writes it, without the mark.
    rewriteAsOak010(file);
    fs.writeFileSync(file, JSON.stringify({ ...read(), sync: { auto: false }, machineUsage: true }, null, 2) + '\n');
    core.keptPrefs(true);
    assert.deepEqual([read().sync, read().machineUsage, read().prefsFormat], [{ auto: false }, true, 2], 'both as written, over what the copy held');
    fs.writeFileSync(file, JSON.stringify({ ...read(), sync: { backup: { kind: 'folder', path: '/mnt/backup' } }, machineUsage: false }, null, 2) + '\n');
    core.keptPrefs(true);
    // The copy made again where its folder went (as `oak uninstall` says to remove it), from a file this build wrote.
    fs.rmSync(path.join(core.rootDir(), 'sync'), { recursive: true, force: true });
    core.keptPrefs(true);
    assert.deepEqual(copied().sync?.backup, { kind: 'folder', path: '/mnt/backup' }, 'the copy made again');
    fs.mkdirSync(syncDir, { recursive: true });
    fs.writeFileSync(path.join(syncDir, 'status.json'), JSON.stringify({ at: Date.now() - 2 * core.SYNC_AUTO_MS }));
    // A person's edit of a file this build wrote leaves the mark: what it removes stays removed, and the copy follows it.
    // `machineUsage` deleted (the saved machines' usage turned back on), then `sync` deleted (as `jq 'del(.sync)'` does).
    for (const key of ['machineUsage', 'sync']) {
      const hand = read();
      delete hand[key];
      fs.writeFileSync(file, JSON.stringify(hand, null, 2) + '\n');
      core.syncSettings();
      assert.notEqual(copied()[key], undefined, `a read leaves the copy as it was (${key}): what writes nothing writes nothing`);
      core.keptPrefs(true);
      assert.equal(read()[key], undefined, `${key} stays removed`);
      assert.equal(copied()[key], undefined, `and the copy follows the file (${key})`);
      rewriteAsOak010(file);
      core.keptPrefs(true);
      assert.equal(read()[key], undefined, `nor comes back after an older OAK's rewrite (${key})`);
    }
    assert.equal(core.machineUsageEnabled(), true, '`machineUsage` stays as the person left it');
    assert.equal(core.syncSettings().backup, null);
    // A prefs.json removed is no older OAK's: nothing comes back, nor is the file written again, and a save makes it anew.
    core.writePrefs({ sort: 'name', sync: { exclude: { projects: ['home:secret'] } } });
    assert.deepEqual(copied().sync.exclude.projects, ['home:secret'], 'control: the copy holds them');
    fs.rmSync(file);
    core.writePrefs({ sort: 'name' });
    assert.equal(read().sync, undefined, 'a save over a removed prefs.json brings nothing back');
    // A prefs.json that cannot be read (here a folder) leaves the copy as it is.
    core.writePrefs({ sort: 'name', sync: { exclude: { projects: ['home:secret'] } } });
    fs.rmSync(file);
    fs.mkdirSync(file);
    assert.deepEqual(core.keptPrefs(true), {});
    assert.deepEqual(copied().sync.exclude.projects, ['home:secret'], 'the copy is left as it is');
    fs.rmSync(file, { recursive: true });
    assert.deepEqual([core.syncSettings().excludeProjects, core.keptPrefs(true).sync, fs.existsSync(file)], [[], undefined, false], 'a prefs.json removed');
    assert.equal(core.claimSyncKick(), true, 'control: a background run is kicked once `auto` is no longer set off');
    // A file that is not JSON (a hand edit half done) is left as it is.
    fs.writeFileSync(file, '{ "sort": ');
    assert.deepEqual(core.keptPrefs(true), {});
    assert.equal(fs.readFileSync(file, 'utf8'), '{ "sort": ');
  });
});

test('sync settings: a save between upkeep comparison and rename is serialized', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-write-race-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  await as(home, () => {
    core.clearRootMemo();
    core.writePrefs({ sort: 'name', sync: { auto: false } });
    const file = core.prefsPath();
    rewriteAsOak010(file);
    const writer = `const core = require(${JSON.stringify(path.resolve(__dirname, '../dist'))});
      try { core.writePrefs({ ...core.readPrefs(), billDay: 9 }); }
      catch (e) { if (e.constructor.name === 'FileBusyError') process.exit(75); throw e; }`;
    const save = () => cp.spawnSync(process.execPath, ['-e', writer], { encoding: 'utf8', timeout: 15000 });
    const rename = fs.renameSync;
    let competing;
    fs.renameSync = function (src, dst) {
      if (dst === file) {
        fs.renameSync = rename;
        competing = save(); // the comparison has finished; the replacement has not
      }
      return rename.call(fs, src, dst);
    };
    try { core.keptPrefs(true); } finally { fs.renameSync = rename; }
    assert.ok(competing && !competing.error, competing?.error?.message);
    if (competing.status === 75) assert.equal(save().status, 0, 'the writer can retry after upkeep releases its lock');
    else assert.equal(competing.status, 0, competing.stderr);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).billDay, 9, 'upkeep must not overwrite the competing save');
    assert.deepEqual(core.keptPrefs().sync, { auto: false });
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith('prefs.json.tmp-')), []);
  });
});

test('sync settings: a store move over a prefs.json an older OAK rewrote keeps oak sync\'s settings, wherever the store goes', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-kept-move-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  await as(home, () => {
    core.clearRootMemo();
    const backup = { kind: 'folder', path: '/mnt/backup' };
    core.writePrefs({ sort: 'name', sync: { backup } });
    // From the default folder to another, and from there to a third: each move writes prefs.json, where the copy was.
    for (const to of [path.join(home, 'store-1'), path.join(home, 'store-2')]) {
      rewriteAsOak010(core.prefsPath());
      assert.equal(core.readPrefs().sync, undefined, 'control: dropped');
      const moved = core.moveStore(to);
      assert.ok(moved.moved, JSON.stringify(moved));
      assert.deepEqual([core.readPrefs().sync?.backup, core.syncSettings().backup], [backup, backup], `kept through the move to ${path.basename(to)}`);
    }
    rewriteAsOak010(core.prefsPath());
    assert.deepEqual(core.syncSettings().backup, backup, 'and read from the copy in the store\'s new folder');
  });
});

test('sync settings: oak sync set up without a backup is not offered again after an older OAK\'s rewrite of prefs.json', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-kept-setup-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  await as(home, () => {
    core.clearRootMemo();
    core.writePrefs({ sort: 'name' });
    assert.equal(fs.existsSync(path.join(core.rootDir(), 'sync')), false, 'a save of no oak sync setting makes no copy');
    const offered = () => core.diagnoseSync(Date.now(), { savedMachines: 1 }).some((r) => r.id === 'sync-setup');
    assert.equal(offered(), true, 'control: offered where it was never set up');
    core.writePrefs({ sort: 'name', sync: { setupAt: Date.now() } });
    assert.equal(offered(), false, 'control: not offered once set up');
    rewriteAsOak010(core.prefsPath());
    assert.equal(core.readPrefs().sync, undefined, 'control: the older OAK\'s rewrite drops it');
    assert.equal(offered(), false, 'not offered again: the setup is read from oak sync\'s copy');
  });
});

test('sync plan: retention is this machine\'s own, unset means 30 days with a warning; set-aside sessions age with theirs', () => {
  const sessions = [['/home/u/x', 'home:x', [['old', 10]], NOW - 40 * DAY], ['/home/u/y', 'home:y', [['new', 10]], NOW - 20 * DAY]];
  const peer = inv('pppppppppppp', '/home/u', sessions, { families: { 'session-files': [{ name: `${folderOf('/home/u/x')}/old/subagents/a.jsonl`, size: 3, mtime: NOW }] } });
  const unset = inv('uuuuuuuuuuuu', '/home/u', [], { cleanupPeriodDays: null });
  const long = inv('llllllllllll', '/home/u', [], { cleanupPeriodDays: 365 });
  const plan = core.planSync([node('unset', unset, true), node('long', long), node('peer', peer)], NOW);
  const [u, l] = plan.machines;
  assert.deepEqual([u.retentionDays, u.retentionUnset, u.pulls.map((p) => p.name.split('/').pop())], [30, true, ['new.jsonl']]);
  assert.deepEqual(u.skipped.retention, { files: 2, bytes: 13 }, 'the 40-day-old transcript, and its subagent file with it though that is newer');
  assert.match(u.warnings[0], /cleanupPeriodDays is not set on unset/);
  assert.deepEqual([l.retentionDays, l.retentionUnset, l.pulls.length], [365, false, 3]);
});

test('sync plan: text files are copied when missing, merged when different, once per version; an inventory\'s foreign names are dropped', () => {
  const text = (name, sha, size = 5) => ({ name, size, mtime: NOW, sha256: sha.repeat(64) });
  const a = inv('aaaaaaaaaaaa', '/home/u', [], { families: { plans: [text('p.md', 'a'), text('same.md', 'c')], skills: [] } });
  const b = inv('bbbbbbbbbbbb', '/home/u', [], { families: { plans: [text('p.md', 'b'), text('same.md', 'c'), text('n.md', 'd')], skills: [text('s/SKILL.md', 'e')] } });
  const c = inv('cccccccccccc', '/home/u', [], { families: { plans: [text('n.md', 'f'), text('p.md', 'b')] } });
  const plan = core.planSync([node('a', a, true), node('b', b), node('c', c)], NOW);
  assert.deepEqual(plan.machines[0].pulls.map((p) => [p.family, p.to, p.action, p.from]), [
    ['plans', 'n.md', 'copy', 'b'], ['plans', 'n.md', 'merge', 'c'], ['plans', 'p.md', 'merge', 'b'], ['skills', 's/SKILL.md', 'copy', 'b'],
  ]);
  // What another machine sends is checked name by name: a path out of its family's folder, a hidden file, a
  // never-synced file and a session file in the wrong place are dropped and counted.
  const sent = JSON.stringify({ ...b, families: { ...b.families,
    plans: [text('ok.md', 'a'), text('../settings.json', 'a'), text('/etc/passwd', 'a'), text('x/../../.claude.json', 'a'), text('.credentials.json', 'a'), text('a\\b.md', 'a')],
    transcripts: [{ name: '-home-u-x/s.jsonl', size: 1, mtime: NOW }, { name: '-home-u-x/sub/s.jsonl', size: 1, mtime: NOW }, { name: 'shell-snapshots/s.sh', size: 1, mtime: NOW }],
    rollouts: [{ name: 'sessions/2026/10/29/rollout-x.jsonl', size: 1, mtime: NOW }, { name: 'auth.json', size: 1, mtime: NOW }, { name: 'logs_1.sqlite', size: 1, mtime: NOW }],
    memory: [{ name: '-home-u-x/memory/M.md', size: 1, mtime: NOW, sha256: 'a'.repeat(64) }, { name: '-home-u-x/memory/sub/M.md', size: 1, mtime: NOW }],
  } });
  const parsed = core.parseSyncInventory(sent);
  assert.deepEqual(parsed.inventory.families.plans.map((f) => f.name), ['ok.md']);
  assert.deepEqual(parsed.inventory.families.transcripts.map((f) => f.name), ['-home-u-x/s.jsonl']);
  assert.deepEqual(parsed.inventory.families.rollouts.map((f) => f.name), ['sessions/2026/10/29/rollout-x.jsonl']);
  assert.deepEqual(parsed.inventory.families.memory.map((f) => f.name), ['-home-u-x/memory/M.md']);
  assert.equal(parsed.dropped, 10);
  assert.deepEqual(core.parseSyncInventory(JSON.stringify({ inventory: 1, shared: true, families: { plans: [text('x.md', 'a')] } })), { inventory: { inventory: 1, shared: true }, dropped: 0 });
  assert.equal(core.parseSyncInventory(JSON.stringify({ inventory: 2 })), null, 'another version is no inventory');
  // Text too large to hash (listed without a sha256) is neither copied nor merged, and the plan counts it.
  const big = inv('bbbbbbbbbbbb', '/home/u', [], { families: { plans: [{ name: 'huge.md', size: 17 * 1024 * 1024, mtime: NOW, sha256: null }] } });
  const pBig = core.planSync([node('a', a, true), node('big', big)], NOW).machines[0];
  assert.equal(pBig.pulls.filter((p) => p.to === 'huge.md').length, 0);
  assert.deepEqual(pBig.skipped.large, { files: 1, bytes: 17 * 1024 * 1024 });
  assert.equal(core.parseSyncInventory('Legacy OAK: use oak help'), null);
});

test('sync: a folder Claude Code shortened is recognised by its kept prefix, whatever hash it carries', () => {
  const long = `/home/u/${'deep/'.repeat(50)}project`;
  const name = core.mangleCwd(long);
  assert.ok(name.length > 201 && /^[0-9a-z]+$/.test(name.slice(201)));
  assert.ok(core.folderNamesCwd(name, long));
  assert.ok(core.folderNamesCwd(`${name.slice(0, 201)}zzz`, long), 'another build\'s hash');
  assert.ok(!core.folderNamesCwd(name, `/home/v/${'deep/'.repeat(50)}project`));
  assert.ok(core.folderNamesCwd('-home-u-app', '/home/u/app') && !core.folderNamesCwd('-home-u-app', '/home/u/app2'));
});

// ---------------------------------------------------------------------------------------------------------------
// The engine in one process: each machine is a home, entered by switching HOME and the config directories, and the
// transport runs the other machine's fetch command to its end before its bytes are read, so no two homes interleave.
// ---------------------------------------------------------------------------------------------------------------

/** Run `fn` as the machine whose home is `home`. USERPROFILE too: Windows' os.homedir() reads it and ignores HOME, and
 *  a machine is told apart by its home (machineHostTag). */
async function as(home, fn) {
  const keys = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OAK_MACHINE_LABEL'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'), OAK_MACHINE_LABEL: path.basename(home) });
  try {
    return await fn();
  } finally {
    for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
}

/** A transport to the machines whose homes `homes` maps by label, each fetch counted. */
function inProcess(homes, fetches = []) {
  return {
    machines: async () => Object.keys(homes).map((label, i) => ({ id: `m${i}`, label, target: label, session: 'default', enabled: true, selected: false })),
    inventory: async (target, user) => ({ text: JSON.stringify(await as(homes[target], () => core.syncInventory({ user }))) }),
    fetch: (target, user, request) => {
      fetches.push({ target, request: JSON.parse(request) });
      const chunks = [];
      const done = as(homes[target], () => core.serveSyncFetch(request, user, async (b) => { chunks.push(Buffer.from(b)); })).then(() => null);
      return { stream: (async function* () { await done; yield* chunks; })(), done };
    },
  };
}

test('sync engine: a content-addressed family copies what is missing by name, verifies each by its hash, in one round trip', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-cas-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a'), B = path.join(base, 'b');
  const blob = (home, text, name) => {
    const dir = path.join(home, 'blobs');
    fs.mkdirSync(dir, { recursive: true });
    const h = name ?? require('crypto').createHash('sha256').update(text).digest('hex');
    fs.writeFileSync(path.join(dir, h), text);
    return h;
  };
  const h1 = blob(A, 'one'), h2 = blob(A, 'two'), h3 = blob(B, 'three');
  blob(B, 'two');
  const forged = blob(A, 'not what its name says', 'f'.repeat(64));
  const unregister = core.registerSyncFamily({
    id: 'test-blobs', agent: 'oak', strategy: 'cas', placement: 'everywhere', projectScoped: false, retention: false,
    root: () => path.join(process.env.HOME, 'blobs'),
    accepts: (n) => /^[0-9a-f]{64}$/.test(n),
    list: () => {
      const dir = path.join(process.env.HOME, 'blobs');
      return (fs.existsSync(dir) ? fs.readdirSync(dir) : []).map((n) => { const st = fs.statSync(path.join(dir, n)); return { name: n, size: st.size, mtime: Math.floor(st.mtimeMs) }; });
    },
  });
  t.after(unregister);
  const fetches = [];
  const r = await as(B, () => core.syncNow(inProcess({ a: A }, fetches)));
  assert.deepEqual(fs.readdirSync(path.join(B, 'blobs')).sort(), [h1, h2, h3].sort(), 'the missing blob copied, the forged one refused');
  assert.equal(fs.readFileSync(path.join(B, 'blobs', h1), 'utf8'), 'one');
  assert.ok(!fs.existsSync(path.join(B, 'blobs', forged)));
  assert.ok(r.machines[0].errors.some((e) => /do not hash to its name/.test(e)), JSON.stringify(r.machines));
  assert.equal(fetches.length, 1, 'one round trip for the whole family');
  assert.deepEqual(fetches[0].request.items.map((i) => i.name).sort(), [h1, forged].sort(), 'only what is missing here is asked for');
  // Nothing is replaced: a blob is its name.
  const again = await as(B, () => core.syncNow(inProcess({ a: A }, fetches)));
  assert.deepEqual(again.done.filter((d) => d.family === 'test-blobs' && d.action === 'create'), []);
});

test('sync engine: the fetch command answers a prefix, a divergence, a shorter copy, a missing and a refused file, and a stranger', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-serve-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a');
  const folder = '-x-proj';
  const file = path.join(A, '.claude', 'projects', folder, 's1.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'line one\nline two\n');
  const h = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
  const serve = async (items, user = core.localUserName()) => {
    const out = [];
    await as(A, () => core.serveSyncFetch(JSON.stringify({ fetch: 1, items }), user, async (b) => { out.push(Buffer.from(b)); }));
    const frames = [];
    const reader = new core.SyncFrameReader({ header: (hd) => frames.push({ ...hd, body: '' }), body: (i, c) => { frames.find((f) => f.i === i).body += c.toString(); }, end: () => {} });
    reader.push(Buffer.concat(out));
    return { frames, raw: Buffer.concat(out).toString(), shared: reader.shared };
  };
  const name = `${folder}/s1.jsonl`;
  const { frames } = await serve([
    { family: 'transcripts', name, offset: 9, sha256: h('line one\n') },
    { family: 'transcripts', name, offset: 9, sha256: h('line ONE\n') },
    { family: 'transcripts', name, offset: 99, sha256: h('x') },
    { family: 'transcripts', name: `${folder}/nope.jsonl`, offset: 0 },
    { family: 'transcripts', name: '../../.claude.json' },
    { family: 'transcripts', name },
  ]);
  assert.deepEqual(frames.map((f) => [f.status, f.offset ?? null, f.body]), [
    ['tail', 9, 'line two\n'],
    ['diverged', 0, 'line one\nline two\n'],
    ['shorter', null, ''],
    ['missing', null, ''],
    ['refused', null, ''],
    ['whole', 0, 'line one\nline two\n'],
  ]);
  const stranger = await serve([{ family: 'transcripts', name }], 'someone-else');
  assert.deepEqual([stranger.raw, stranger.shared], ['{"shared":true}\n', true]);
});

test('sync engine: the frame reader rebuilds every header and body however the stream is split', () => {
  const frames = [{ i: 0, status: 'tail', length: 5, body: 'hello' }, { i: 1, status: 'missing' }, { i: 2, status: 'whole', length: 3, body: '\n\n{' }, { i: 3, status: 'refused' }];
  const bytes = Buffer.concat(frames.map(({ body, ...h }) => Buffer.concat([Buffer.from(JSON.stringify(h) + '\n'), Buffer.from(body ?? '')])));
  for (const size of [1, 2, 3, 7, bytes.length]) {
    const got = [];
    const reader = new core.SyncFrameReader({
      header: (h) => got.push({ i: h.i, status: h.status, body: '' }),
      body: (i, c) => { got.find((g) => g.i === i).body += c.toString(); },
      end: (i) => { got.find((g) => g.i === i).ended = true; },
    });
    for (let at = 0; at < bytes.length; at += size) reader.push(bytes.subarray(at, at + size));
    assert.deepEqual(got, frames.map((f) => ({ i: f.i, status: f.status, body: f.body ?? '', ended: true })), `split every ${size} bytes`);
  }
});

test('sync engine: a small file that shrinks while being sent is refused, never padded with zero bytes', async () => {
  const { syncFetchFrames } = require('../dist/sync-engine');
  const items = [{ family: 'plans', name: 'shrinking.md' }, { family: 'plans', name: 'whole.md' }];
  let closed = 0;
  const open = (_fam, name) => {
    const bytes = Buffer.from(name === 'shrinking.md' ? 'short' : 'whole');
    return { size: name === 'shrinking.md' ? 20 : bytes.length, mtime: NOW,
      read: (buf, off, len, pos) => bytes.copy(buf, off, pos, pos + len), close: () => { closed++; } };
  };
  const collect = async (skip) => {
    const chunks = [];
    for await (const b of syncFetchFrames(items, open, skip)) chunks.push(b);
    return Buffer.concat(chunks);
  };
  await assert.rejects(collect(), /shrank while it was sent/);
  const errors = [];
  const frames = [];
  const reader = new core.SyncFrameReader({ header: (h) => frames.push({ ...h, body: '' }),
    body: (_i, b) => { frames.at(-1).body += b.toString(); }, end: () => {} });
  reader.push(await collect((i, e) => { errors.push([i, e.message]); return true; }));
  assert.deepEqual(frames.map((h) => [h.status, h.body]), [['refused', ''], ['whole', 'whole']]);
  assert.deepEqual(errors, [[0, 'the file shrank while it was sent']]);
  assert.equal(closed, 3, 'each opened source is closed, including a refused one');
});

test('sync records: a restore of this machine\'s own segment that landed in part fetches its remaining lines', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-record-tail-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a'), B = path.join(base, 'b');
  const host = await as(A, () => core.machineHostTag());
  const name = `records/${host}/1700000000000-1234abcd.jsonl`;
  const prefix = '{"t":"batch","at":1700000000000,"v":1}\n';
  const whole = prefix + '{"t":"purge","s":"s-deleted"}\n';
  const file = await as(A, () => path.join(core.rootDir(), name));
  await as(B, () => {
    const peer = path.join(core.rootDir(), name);
    fs.mkdirSync(path.dirname(peer), { recursive: true });
    fs.writeFileSync(peer, whole);
  });
  await as(A, async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, prefix);
    const st = fs.statSync(file);
    // The first run landed a complete-line prefix when its peer budget ended.
    const state = require('../dist/sync-state');
    state.appendManifest({ family: 'oak-records', name, size: st.size, mtime: Math.floor(st.mtimeMs), sha256: state.sha256(prefix) });
    const fetches = [];
    const result = await core.syncNow(inProcess({ b: B }, fetches));
    assert.equal(result.status, 'ok', JSON.stringify(result));
    assert.equal(fs.readFileSync(file, 'utf8'), whole, 'the remaining purge line must come back too');
    assert.equal(fetches[0].request.items[0].offset, Buffer.byteLength(prefix));
    assert.equal((await core.syncNow(inProcess({ b: B }))).done.length, 0, 'a whole segment is not fetched again');
  });
});

test('sync key: importing the same key repairs its permissions without replacing its bytes', { skip: process.platform === 'win32' }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-key-mode-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  await as(home, () => {
    const key = core.newSyncKey();
    core.writeSyncKey(key);
    const file = core.syncKeyPath();
    const before = fs.readFileSync(file);
    fs.chmodSync(file, 0o644);
    assert.deepEqual(core.writeSyncKey(key), { replaced: null });
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

test('sync privacy: a skill linked to a relocated store never lists or serves the backup key or replaced keys', { skip: process.platform === 'win32' }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-private-key-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  await as(home, async () => {
    core.writePrefs({ storeDir: path.join(home, 'store') });
    core.writeSyncKey(core.newSyncKey());
    const old = core.writeSyncKey(core.newSyncKey(), { replace: true }).replaced;
    const dir = path.join(home, '.claude', 'skills');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(path.dirname(core.syncKeyPath()), path.join(dir, 'backup'));
    const user = core.localUserName();
    const inventory = core.syncInventory({ user });
    const names = ['backup/key', `backup/${path.basename(old)}`];
    const chunks = [];
    await core.serveSyncFetch(JSON.stringify({ fetch: 1, items: names.map((name) => ({ family: 'skills', name })) }), user,
      async (b) => { chunks.push(Buffer.from(b)); });
    const frames = [];
    new core.SyncFrameReader({ header: (h) => frames.push(h.status), body: () => {}, end: () => {} }).push(Buffer.concat(chunks));
    assert.deepEqual({ listed: inventory.families.skills.filter((f) => names.includes(f.name)).map((f) => f.name), frames },
      { listed: [], frames: ['refused', 'refused'] });
    assert.equal(core.syncLocalPath(core.syncFamily('skills'), names[0]), null, 'a peer cannot overwrite the key through the same link');
  });
});

test('sync privacy: inventory never opens a transcript symlink to a credential file', { skip: process.platform === 'win32' }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-private-head-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  await as(home, () => {
    const secret = path.join(home, '.ssh', 'id_ed25519');
    const file = path.join(home, '.claude', 'projects', '-private', 's-secret.jsonl');
    fs.mkdirSync(path.dirname(secret), { recursive: true });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(secret, 'synthetic credential fixture\n');
    fs.symlinkSync(secret, file);
    const open = fs.openSync;
    let opened = 0;
    fs.openSync = function (p, ...args) {
      if (p === file || p === secret) opened++;
      return open.call(fs, p, ...args);
    };
    let inventory;
    try { inventory = core.syncInventory({ user: core.localUserName() }); }
    finally { fs.openSync = open; }
    assert.deepEqual({ opened, listed: inventory.families.transcripts.map((f) => f.name) }, { opened: 0, listed: [] });
  });
});

test('sync memory: a copy without transcripts keeps its project identity and follows deletes in either direction', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-memory-only-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a'), B = path.join(base, 'b');
  const cwd = path.join(A, 'work');
  const folder = core.mangleCwd(cwd);
  const memory = (home, name) => path.join(home, '.claude', 'projects', core.mangleCwd(path.join(home, 'work')), 'memory', name);
  await as(A, () => {
    fs.mkdirSync(path.dirname(memory(A, 'keep.md')), { recursive: true });
    fs.writeFileSync(path.join(homeProjects(A), folder, 's-own.jsonl'), JSON.stringify({ cwd }) + '\n');
    for (const name of ['keep.md', 'from-a.md', 'from-b.md']) fs.writeFileSync(memory(A, name), `memory ${name}\n`);
  });
  await as(B, () => core.syncNow(inProcess({ a: A })));
  assert.ok(fs.existsSync(memory(B, 'from-a.md')));
  assert.deepEqual(await as(B, () => core.syncInventory({ user: core.localUserName() }).families.transcripts), [], 'control: transcripts stay on their origin');
  await as(A, () => core.syncNow(inProcess({ b: B })));
  fs.rmSync(memory(A, 'from-a.md'));
  await as(A, () => core.syncNow(inProcess({})));
  await as(B, () => core.syncNow(inProcess({ a: A })));
  assert.ok(!fs.existsSync(memory(B, 'from-a.md')), 'a delete at the origin reaches its memory-only copy');
  fs.rmSync(memory(B, 'from-b.md'));
  await as(B, () => core.syncNow(inProcess({})));
  await as(A, () => core.syncNow(inProcess({ b: B })));
  assert.ok(!fs.existsSync(memory(A, 'from-b.md')), 'a delete at the memory-only copy reaches the origin');
  function homeProjects(home) { return path.join(home, '.claude', 'projects'); }
});

test('sync engine: a family that keeps peers apart mirrors their files whole into its own namespace, and a receive hook takes them in', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-mirror-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a'), B = path.join(base, 'b');
  const log = (home, text) => {
    const f = path.join(home, 'store', 'own', 's1', 'log.jsonl');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    return f;
  };
  log(A, '{"id":1}\n{"id":2}\n');
  log(B, '{"id":9}\n'); // the same session id on the other machine: never mixed with A's
  const received = [];
  // Its own logs, and the replicas it holds of other machines' (which another machine can restore from).
  const listOwn = () => {
    const out = [];
    const walk = (rel, depth) => {
      const dir = path.join(process.env.HOME, 'store', rel);
      for (const n of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        const r = `${rel}/${n}`;
        if (n === 'log.jsonl') {
          const st = fs.statSync(path.join(dir, n));
          out.push({ name: r, size: st.size, mtime: Math.floor(st.mtimeMs) });
        } else if (depth < 3) walk(r, depth + 1);
      }
    };
    walk('own', 0);
    walk('replicas', 0);
    return out;
  };
  const fam = (id, extra) => ({
    id, agent: 'oak', strategy: 'mirror', placement: 'everywhere', projectScoped: false, retention: false,
    root: () => path.join(process.env.HOME, 'store'),
    accepts: (n) => /^(?:own\/[\w-]+|replicas\/[0-9a-f]{12}\/[\w-]+)\/log\.jsonl$/.test(n),
    list: listOwn,
    target: (e, from) => (from.origin === from.me ? null : `replicas/${from.origin}/${e.name.split('/').at(-2)}/log.jsonl`),
    ...extra,
  });
  const unregister = core.registerSyncFamily(fam('test-logs', {}));
  t.after(unregister);
  const hostA = await as(A, () => core.syncInventory({ user: core.localUserName() }).host);
  await as(B, () => core.syncNow(inProcess({ a: A })));
  const replica = path.join(B, 'store', 'replicas', hostA, 's1', 'log.jsonl');
  assert.equal(fs.readFileSync(replica, 'utf8'), '{"id":1}\n{"id":2}\n', 'A\'s log, under A\'s machine id');
  assert.equal(fs.readFileSync(path.join(B, 'store', 'own', 's1', 'log.jsonl'), 'utf8'), '{"id":9}\n', 'B\'s own session of that id untouched');
  // A rewrites its log (a clear re-keys it, shorter): mirrored whole, the old copy to the trash.
  const f = log(A, '{"id":2}\n');
  fs.utimesSync(f, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  const r = await as(B, () => core.syncNow(inProcess({ a: A })));
  assert.equal(fs.readFileSync(replica, 'utf8'), '{"id":2}\n');
  assert.deepEqual(r.done.filter((d) => d.family === 'test-logs').map((d) => d.action), ['replace']);
  assert.ok(fs.existsSync(path.join(B, '.claude', 'claude-observatory', 'sync', 'trash')), 'the replaced copy kept');
  // Unchanged: nothing fetched again; and A never takes in a replica of its own log from B.
  assert.deepEqual((await as(B, () => core.syncNow(inProcess({ a: A })))).done.filter((d) => d.family === 'test-logs'), []);
  await as(A, () => core.syncNow(inProcess({ b: B })));
  assert.ok(!fs.existsSync(path.join(A, 'store', 'replicas', hostA)), 'no replica of its own sessions');
  const hostB = await as(B, () => core.syncInventory({ user: core.localUserName() }).host);
  assert.equal(fs.readFileSync(path.join(A, 'store', 'replicas', hostB, 's1', 'log.jsonl'), 'utf8'), '{"id":9}\n', 'B\'s, under B\'s id');
  // A family with its own receive takes the bytes itself.
  unregister();
  const unregister2 = core.registerSyncFamily(fam('test-logs-2', { receive: (body, at) => received.push([at.to, body.toString()]) }));
  t.after(unregister2);
  const C = path.join(base, 'c');
  await as(C, () => core.syncNow(inProcess({ a: A })));
  assert.deepEqual(received, [[`replicas/${hostA}/s1/log.jsonl`, '{"id":2}\n']]);
  assert.ok(!fs.existsSync(path.join(C, 'store', 'replicas')), 'the family wrote it, not the engine');
});

test('sync doctor: no row before sync is used here; then an unset cleanupPeriodDays warns, a set one does not, and a machine it could not reach and an open conflict warn', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-doctor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  await as(home, () => {
    const claude = path.join(home, '.claude');
    const row = (id) => core.diagnoseSync().find((r) => r.id === id);
    // A machine that does not sync (every new install's `oak doctor --fix`) is told nothing about keeping transcripts.
    assert.deepEqual(core.diagnoseSync(), [], 'no row before sync is used here, with cleanupPeriodDays unset');
    const dir = path.join(claude, 'claude-observatory', 'sync');
    fs.mkdirSync(dir, { recursive: true });
    const run = { pulled: { files: 0, bytes: 0 }, conflicts: 0, pending: { files: 0, bytes: 0 }, errors: [] };
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ at: Date.now(), durationMs: 5, status: 'ok', warnings: [], machines: [{ label: 'build-box', status: 'ok', ...run }] }));
    assert.equal(row('sync-retention').level, 'warn');
    assert.match(row('sync-retention').detail, /deletes transcripts and plans after 30 days/);
    assert.match(row('sync-retention').fix, /"cleanupPeriodDays": 3650/);
    assert.equal(row('sync').level, 'ok');
    fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 3650 }));
    assert.deepEqual([row('sync-retention').level, row('sync-retention').detail], ['ok', 'cleanupPeriodDays is 3650']);
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ at: Date.now(), durationMs: 5, status: 'partial', warnings: [], machines: [{ label: 'build-box', status: 'unreachable', detail: 'ssh: no route', ...run }] }));
    fs.writeFileSync(path.join(dir, 'conflicts.json'), JSON.stringify([{ id: 'c1', family: 'plans', name: 'm.md', from: 'build-box', host: 'aaaaaaaaaaaa', at: 1, peerSha256: null, peerSize: 1, copy: '/x', localSha256: null, reason: 'overlap' }]));
    const sync = row('sync');
    assert.equal(sync.level, 'warn');
    assert.match(sync.detail, /build-box: ssh: no route/);
    assert.match(sync.detail, /1 conflict open/);
    assert.match(sync.fix, /oak sync status/);
  });
  // `oak doctor` lists these rows with its others.
  assert.match(fs.readFileSync(path.join(__dirname, '..', '..', 'cli', 'src', 'index.ts'), 'utf8'), /checks\.push\(\.\.\.core\.diagnoseSync\(Date\.now\(\), \{ savedMachines \}\)\)/);
});

test('sync background: background runs that failed in a row wait 5, 10, 20 and 40 minutes, then an hour at most', () => {
  const MIN = 60_000;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 40].map((n) => core.syncBackoffMs(n) / MIN), [0, 5, 10, 20, 40, 60, 60, 60]);
  const at = Date.parse('2026-10-29T12:00:00Z');
  assert.equal(core.syncBackedOff(at + 9 * MIN, { at, failures: 2 }), true);
  assert.equal(core.syncBackedOff(at + 11 * MIN, { at, failures: 2 }), false);
  assert.equal(core.syncBackedOff(at, null), false, 'no failure, no wait');
});

test('sync engine: a delete dated more than a day ahead of this machine\'s clock counts as made a day from now, so an undelete after that stands', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-skew-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a'), B = path.join(base, 'b');
  const id = '00000000-0000-4000-8000-000000000077';
  const T0 = Date.now();
  // A's clock is a year ahead: a session deleted there is dated a year from now.
  await as(A, async () => {
    core.hideSession(id);
    await core.syncNow(inProcess({ b: B }), { now: T0 + 365 * DAY });
  });
  // B applies the delete, recorded as made a day from its own now, and says why.
  const r = await as(B, () => core.syncNow(inProcess({ a: A }), { now: T0 }));
  assert.ok(r.warnings.some((x) => /a delete made on another machine \([0-9a-f]{12}\) is dated .* more than a day ahead of this machine's clock/.test(x)), JSON.stringify(r.warnings));
  await as(B, () => {
    assert.ok(core.hiddenSessions().has(id), 'control: the delete reached B');
    const stored = core.readTombstones().filter((x) => x.key === id);
    assert.deepEqual(stored.map((x) => [x.at, x.sentAt]), [[T0 + DAY, T0 + 365 * DAY]]);
  });
  // Two days on, it is brought back on B: that is the latest event now, and it stands.
  await as(B, async () => {
    core.unhideSession(id);
    await core.syncNow(inProcess({ a: A }), { now: T0 + 2 * DAY });
    assert.ok(!core.hiddenSessions().has(id), 'the undelete stands');
  });
  // A's own delete, offered again, is known by the time it carried: not taken in, nor warned of, twice.
  const again = await as(B, () => core.syncNow(inProcess({ a: A }), { now: T0 + 3 * DAY }));
  assert.ok(!again.warnings.some((x) => /ahead of this machine's clock/.test(x)), JSON.stringify(again.warnings));
  await as(B, () => {
    assert.ok(!core.hiddenSessions().has(id));
    assert.equal(core.readTombstones().filter((x) => x.key === id && x.deleted).length, 1, 'recorded once');
  });
  // `oak sync plan` ranks the events as the run did: the delete as recorded here, not as A still dates it.
  const invA = await as(A, () => core.syncInventory({ user: core.localUserName() }));
  const invB = await as(B, () => core.syncInventory({ user: core.localUserName() }));
  assert.equal(core.deletedSessions([invB, invA], T0 + 3 * DAY).has(id), false, 'restored in the preview too');
});

test('sync never reads the local index, a folder of the Claude config directory, as it never reads its sessions (0.11.0)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-never-'));
  const [claude, codex, home] = ['claude', 'codex', 'home'].map((n) => path.join(root, n));
  const refuse = core.neverRead(claude, codex, home);
  assert.equal(refuse(path.join(claude, 'plans', 'a.md')), false, 'control: a plan is read');
  assert.equal(refuse(path.join(claude, 'sessions', '4242.json')), true, 'control: what it never read before is refused');
  assert.equal(refuse(path.join(claude, 'claude-observatory-index')), true);
  assert.equal(refuse(path.join(claude, 'claude-observatory-index', 'index-v1-0123456789abcdef.sqlite')), true);
  assert.equal(refuse(path.join(claude, 'claude-observatory-index', 'index-v1-0123456789abcdef.sqlite-wal')), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('sync names: a name Windows cannot hold is refused on every platform, so no machine is ever sent one', () => {
  const hostile = ['a:b.md', 'CON', 'con.md', 'skills/NUL/SKILL.md', 'Com1.txt', 'lpt9', 'COM0.md', 'COM¹.md', 'aux.tar.gz', 'prn', 'conin$', 'CONOUT$.md', 'nul .md',
    'plan.md.', 'plan.md ', 'dir./x.md', 'dir /x.md', 'q?.md', 'star*.md', 'pipe|.md', 'lt<.md', 'gt>.md', 'quote".md', 'tab\t.md', 'bell\u0007.md'];
  for (const n of hostile) assert.equal(core.safeSyncName(n), false, JSON.stringify(n));
  const benign = ['console.md', 'con-notes.md', 'null.md', 'com10.md', 'lpt.md', 'auxiliary.md', 'a.b.c.md', 'x/y.md', ' leading.md', 'CONTRIBUTING.md', 'café.md'];
  for (const n of benign) assert.equal(core.safeSyncName(n), true, JSON.stringify(n));
  // In another machine's inventory such a name is dropped and counted, and a plan never pulls it.
  const text = (name) => ({ name, size: 2, mtime: NOW, sha256: 'a'.repeat(64) });
  const peer = inv('bbbbbbbbbbbb', '/home/u', [], { families: { plans: [text('ok.md'), text('a:b.md'), text('nul.md'), text('end.')] } });
  const parsed = core.parseSyncInventory(JSON.stringify(peer));
  assert.deepEqual([parsed.inventory.families.plans.map((f) => f.name), parsed.dropped], [['ok.md'], 3]);
  const here = inv('aaaaaaaaaaaa', '/home/u', []);
  assert.deepEqual(core.planSync([node('a', here, true), node('b', peer)], NOW).machines[0].pulls.map((p) => p.to), ['ok.md']);
});

test('sync names: the fetch command refuses a name Windows cannot hold, though the file is there', { skip: process.platform === 'win32' && 'Windows cannot make such a file' }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-winname-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a');
  const plans = path.join(A, '.claude', 'plans');
  fs.mkdirSync(plans, { recursive: true });
  for (const n of ['a:b.md', 'nul.md', 'ok.md']) fs.writeFileSync(path.join(plans, n), `${n}\n`);
  const out = [];
  await as(A, () => core.serveSyncFetch(JSON.stringify({ fetch: 1, items: ['a:b.md', 'nul.md', 'ok.md'].map((name) => ({ family: 'plans', name })) }), core.localUserName(), async (b) => { out.push(Buffer.from(b)); }));
  const statuses = [];
  new core.SyncFrameReader({ header: (h) => statuses.push(h.status), body: () => {}, end: () => {} }).push(Buffer.concat(out));
  assert.deepEqual(statuses, ['refused', 'refused', 'whole']);
});

test('sync crypto: a key is 32 bytes written one way; a sealed unit opens only with its key and what it was sealed as, and any altered byte refuses it', () => {
  const key = core.newSyncKey();
  const text = core.formatSyncKey(key);
  assert.match(text, /^oak-sync-1:[A-Za-z0-9_-]{43}$/);
  assert.ok(core.parseSyncKey(text).equals(key));
  assert.ok(core.parseSyncKey(` ${key.toString('base64')}\n`).equals(key), 'its bytes in plain base64 too');
  for (const bad of ['', 'oak-sync-1:', 'oak-sync-1:' + 'A'.repeat(42), 'oak-sync-1:' + 'A'.repeat(44), key.toString('hex'), 'oak-sync-1:' + key.toString('base64url').slice(0, -1) + '!'])
    assert.throws(() => core.parseSyncKey(bad), core.SyncKeyError, JSON.stringify(bad));
  // A last character whose spare bits are set decodes to the same bytes; it is not the key's one spelling, so refused.
  const spare = 'oak-sync-1:' + key.toString('base64url').slice(0, -1) + String.fromCharCode(key.toString('base64url').at(-1).charCodeAt(0) ^ 1);
  assert.throws(() => core.parseSyncKey(spare), core.SyncKeyError);
  const keys = core.folderKeys(key);
  assert.ok(!keys.enc.export().equals(keys.name.export()) && !keys.enc.export().equals(key) && !keys.name.export().equals(key), 'two keys derived, neither the key');
  assert.match(core.keyFingerprint(key), /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
  assert.equal(core.keyFingerprint(key), core.keyFingerprint(Buffer.from(key)));
  const plain = Buffer.from('a session\'s every word');
  const sealed = core.seal(keys, plain, 'oak-sync\0object\0aa');
  assert.equal(sealed.length, plain.length + core.SEAL_OVERHEAD);
  assert.ok(core.unseal(keys, sealed, 'oak-sync\0object\0aa', 'x').equals(plain));
  assert.ok(!core.seal(keys, plain, 'oak-sync\0object\0aa').equals(sealed), 'a nonce of its own each time');
  assert.ok(!sealed.includes(plain), 'ciphertext');
  for (let i = 0; i < sealed.length; i++) {
    const b = Buffer.from(sealed);
    b[i] ^= 0x01;
    assert.throws(() => core.unseal(keys, b, 'oak-sync\0object\0aa', 'x'), core.SyncSealError, `byte ${i} altered`);
  }
  assert.throws(() => core.unseal(keys, sealed, 'oak-sync\0object\0ab', 'x'), core.SyncSealError, 'sealed as another name');
  assert.throws(() => core.unseal(core.folderKeys(core.newSyncKey()), sealed, 'oak-sync\0object\0aa', 'x'), /another key/, 'another key');
  assert.throws(() => core.unseal(keys, sealed.subarray(0, 20), 'oak-sync\0object\0aa', 'x'), core.SyncSealError, 'cut short');
  // Names: keyed, so a name says nothing of content anyone can hash; the same content has the same name.
  const h = require('crypto').createHash('sha256').update(plain).digest('hex');
  assert.equal(core.objectName(keys, h), core.objectName(core.folderKeys(key), h));
  assert.notEqual(core.objectName(keys, h), core.objectName(core.folderKeys(core.newSyncKey()), h));
  assert.notEqual(core.objectName(keys, h), h);
});

test('sync folder: a growing transcript writes only what it grew by: each 4 MB piece once, its last piece as what each run added, made one again past 64 such; a change in the middle is seen', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-chunks-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'm');
  const share = path.join(base, 'share');
  await as(home, async () => {
    const key = core.newSyncKey();
    core.writeSyncKey(key);
    assert.equal(core.initBackupFolder(share, key).check.ok, true);
    core.writePrefs({ ...core.readPrefs(), sync: { backup: { kind: 'folder', path: share } } });
    const file = path.join(home, '.claude', 'projects', '-x-proj', 's1.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Every record its own: the same bytes twice would be one object, which is written once.
    let n = 0;
    const rec = (size) => `${JSON.stringify({ n: n++, pad: 'x'.repeat(size) })}\n`;
    const grow = (bytes) => {
      let s = '';
      while (s.length < bytes) s += rec(1000);
      fs.appendFileSync(file, s);
      return Buffer.byteLength(s);
    };
    const push = () => {
      const inv = core.syncInventory({ user: core.localUserName() });
      const role = core.resolveSyncBackup({ kind: 'folder', path: share }, { nodes: [], local: inv });
      assert.equal(role.error, undefined);
      return role.push({ me: inv, placements: {}, now: Date.now() });
    };
    const MB = 1024 * 1024;
    const first = grow(5 * MB);
    assert.equal((await push()).pushed.bytes, first, 'all of it, once');
    const small = grow(10_000);
    assert.equal((await push()).pushed.bytes, small, 'only what it grew by');
    assert.equal((await push()).pushed.bytes, 0, 'unchanged: nothing');
    // Past a 4 MB offset: the piece from 4 MB to 8 MB is whole now and written as one, and the rest after it.
    const size0 = fs.statSync(file).size;
    grow(4 * MB);
    const crossed = (await push()).pushed.bytes;
    const size1 = fs.statSync(file).size;
    assert.equal(crossed, 4 * MB + (size1 - 8 * MB), 'the whole 4 MB piece, and the last piece');
    assert.ok(size0 < 8 * MB && size1 > 8 * MB, 'control: it crossed 8 MB');
    // Many small runs: each writes what it added; once 64 pieces follow on, they are written as one.
    let consolidated = 0;
    for (let i = 0; i < 70; i++) {
      const added = grow(500);
      const wrote = (await push()).pushed.bytes;
      if (wrote === added) continue;
      consolidated++;
      assert.equal(wrote, fs.statSync(file).size - 8 * MB, 'the whole last piece, once');
    }
    assert.equal(consolidated, 1, 'made one again once');
    // The folder gives back the file, byte for byte.
    const want = fs.readFileSync(file);
    const restore = async () => {
      fs.rmSync(file);
      const r = await core.syncNow({ machines: async () => [], inventory: async () => ({ status: 'failed' }), fetch: () => { throw new Error('no machine'); } });
      assert.equal(r.status, 'ok', JSON.stringify(r.machines));
      return fs.readFileSync(file);
    };
    assert.ok((await restore()).equals(want), 'restored whole');
    // A change in the middle of the last piece, the size kept: its old pieces no longer match, and it is written anew.
    const bytes = fs.readFileSync(file);
    const at = 8 * MB + 100;
    bytes[at] = bytes[at] === 0x78 ? 0x79 : 0x78;
    fs.writeFileSync(file, bytes);
    assert.ok((await push()).pushed.bytes > 0, 'written');
    assert.ok((await restore()).equals(bytes), 'the changed bytes come back');
  });
});

test('sync folder: only what went on purpose leaves the backup\'s record (a session cleaned up, a snapshot its log no longer names); anything lost, away or not put back yet stays', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-record-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'm');
  const share = path.join(base, 'share');
  await as(home, async () => {
    const key = core.newSyncKey();
    core.writeSyncKey(key);
    assert.equal(core.initBackupFolder(share, key).check.ok, true);
    const projects = path.join(home, '.claude', 'projects', '-x-proj');
    fs.mkdirSync(projects, { recursive: true });
    for (const n of ['a', 'b']) fs.writeFileSync(path.join(projects, `${n}.jsonl`), '{"type":"user"}\n');
    const store = path.join(home, '.claude', 'claude-observatory');
    const blob = (sid, text) => {
      const h = require('crypto').createHash('sha256').update(text).digest('hex');
      fs.mkdirSync(path.join(store, sid, 'blobs'), { recursive: true });
      fs.writeFileSync(path.join(store, sid, 'blobs', h), text);
      return h;
    };
    const session = (sid, blobs) => {
      fs.mkdirSync(path.join(store, sid), { recursive: true });
      const hs = blobs.map((b) => blob(sid, b));
      fs.writeFileSync(path.join(store, sid, 'log.jsonl'), hs.map((h, i) => `${JSON.stringify({ id: i, afterBlob: h })}\n`).join(''));
      return hs;
    };
    for (const sid of ['cleaned', 'lost', 'kept']) session(sid, [`${sid} one`, `${sid} two`]);
    const user = core.localUserName();
    const role = () => core.resolveSyncBackup({ kind: 'folder', path: share }, { nodes: [], local: core.syncInventory({ user }) });
    const listed = (family) => (role().nodes.find((n) => n.inventory.host === core.machineHostTag())?.inventory.families[family] ?? []).map((f) => f.name).sort();
    const push = () => role().push({ me: core.syncInventory({ user }), placements: {}, now: Date.now() });
    await push();
    const logs = ['cleaned/log.jsonl', 'kept/log.jsonl', 'lost/log.jsonl'];
    assert.deepEqual(listed('oak-log'), logs);
    assert.equal(listed('oak-blobs').length, 6);
    // The projects folder away (a disk not mounted): its transcripts stay in the record.
    fs.renameSync(path.join(home, '.claude', 'projects'), path.join(home, '.claude', 'projects.away'));
    await push();
    fs.renameSync(path.join(home, '.claude', 'projects.away'), path.join(home, '.claude', 'projects'));
    assert.deepEqual(listed('transcripts'), ['-x-proj/a.jsonl', '-x-proj/b.jsonl'], 'away is not deleted');
    // One session cleaned up (on purpose), one lost (removed by hand: no cleanup recorded), and in the third, a snapshot
    // the store collected (its log names it no more) and one gone that its log still names.
    core.removeSession('cleaned');
    fs.rmSync(path.join(store, 'lost'), { recursive: true });
    const keptBlobs = listed('oak-blobs').filter((n) => n.startsWith('kept/'));
    const [named, collected] = keptBlobs.map((n) => n.slice('kept/blobs/'.length));
    const log = fs.readFileSync(path.join(store, 'kept', 'log.jsonl'), 'utf8').split('\n').filter((l) => l && !l.includes(collected)).join('\n') + '\n';
    fs.writeFileSync(path.join(store, 'kept', 'log.jsonl'), log);
    for (const h of [named, collected]) fs.rmSync(path.join(store, 'kept', 'blobs', h));
    await push();
    assert.deepEqual(listed('oak-log'), ['kept/log.jsonl', 'lost/log.jsonl'], 'the cleaned session leaves; the lost one stays');
    assert.deepEqual(listed('oak-blobs').filter((n) => n.startsWith('kept/')), [`kept/blobs/${named}`], 'the collected snapshot leaves; one the log names stays');
    assert.equal(listed('oak-blobs').filter((n) => n.startsWith('lost/')).length, 2);
    assert.equal(listed('oak-blobs').filter((n) => n.startsWith('cleaned/')).length, 0);
  });
});

test('sync folder: a marker an earlier setup left half written does not make the folder look taken', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-marker-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const share = path.join(base, 'share');
  fs.mkdirSync(share);
  fs.writeFileSync(path.join(share, 'oak-backup.0123456789ab.tmp'), '{"oakBa');
  const r = core.initBackupFolder(share, core.newSyncKey());
  assert.equal(r.check.ok, true, JSON.stringify(r.check));
  assert.deepEqual(fs.readdirSync(share), ['oak-backup']);
  fs.writeFileSync(path.join(base, 'other'), 'x');
  const busy = path.join(base, 'busy');
  fs.mkdirSync(busy);
  fs.writeFileSync(path.join(busy, 'notes.txt'), 'mine');
  assert.equal(core.initBackupFolder(busy, core.newSyncKey()).check.code, 'not-empty', 'control: another file still makes it taken');
});

test('sync folder: a marker that is not one (altered, cut short, emptied) is said to be no OAK marker, never as a parse error', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-badmarker-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const share = path.join(base, 'share');
  const key = core.newSyncKey();
  assert.equal(core.initBackupFolder(share, key).check.ok, true, 'control: a marker of OAK\'s opens');
  for (const body of ['garbage', '{"oakBackup":1,"keyCh', '', '{"oakBackup":1}']) {
    fs.writeFileSync(path.join(share, 'oak-backup'), body);
    assert.throws(() => core.openBackupFolder(share, key), (e) => e instanceof core.SyncSealError && /oak-backup is not an OAK backup's marker/.test(e.message), JSON.stringify(body));
  }
});

test('sync store: a session put back from another machine\'s copy never lands over a log a capture started here while it was fetched', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-landing-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a'), B = path.join(base, 'b');
  const hostA = await as(A, () => core.syncInventory({ user: core.localUserName() }).host);
  // B holds a copy of A's session S; A no longer has it (lost), so A puts it back.
  const copy = path.join(B, '.claude', 'claude-observatory', 'sync', 'replicas', hostA, 'S', 'log.jsonl');
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.writeFileSync(copy, '{"id":1,"old":true}\n');
  const live = path.join(A, '.claude', 'claude-observatory', 'S', 'log.jsonl');
  const transport = (during) => ({
    machines: async () => [{ id: 'm0', label: 'b', target: 'b', session: 'default', enabled: true, selected: false }],
    inventory: async (target, user) => ({ text: JSON.stringify(await as(B, () => core.syncInventory({ user }))) }),
    fetch: (target, user, request) => {
      const chunks = [];
      const done = as(B, () => core.serveSyncFetch(request, user, async (b) => { chunks.push(Buffer.from(b)); })).then(() => null);
      return { stream: (async function* () { await done; during(); yield* chunks; })(), done };
    },
  });
  // A capture makes the session's log while the copy is on its way.
  const r = await as(A, () => core.syncNow(transport(() => {
    fs.mkdirSync(path.dirname(live), { recursive: true });
    fs.writeFileSync(live, '{"id":1,"captured":"here"}\n');
  })));
  assert.equal(fs.readFileSync(live, 'utf8'), '{"id":1,"captured":"here"}\n', 'the capture stands');
  assert.ok(r.done.some((d) => d.family === 'oak-log' && d.action === 'skipped' && /changed here/.test(d.detail)), JSON.stringify(r.done));
  // Control: with nothing written meanwhile, the copy is put back.
  fs.rmSync(path.join(A, '.claude', 'claude-observatory', 'S'), { recursive: true });
  await as(A, () => core.syncNow(transport(() => {})));
  assert.equal(fs.readFileSync(live, 'utf8'), '{"id":1,"old":true}\n');
});

test('sync evictions: the list is folded by time, so a removal written while a run decided is not undone by the line the run writes after it', (t) => {
  const { currentEvictions } = core;
  const own = (list) => [...currentEvictions(list).own.keys()];
  assert.deepEqual(own([{ id: 'x', at: 686 }, { id: 'x', at: 683, back: true }]), ['x'], 'the later removal stands');
  assert.deepEqual(own([{ id: 'x', at: 680 }, { id: 'x', at: 683, back: true }]), [], 'a later return stands');
  assert.deepEqual(own([{ id: 'x', at: 683, back: true }, { id: 'x', at: 683 }]), ['x'], 'at one time, the later line');
  const copies = currentEvictions([{ id: 's', origin: 'aaaaaaaaaaaa', at: 5 }, { id: 's', origin: 'bbbbbbbbbbbb', at: 5 }, { id: 's', origin: 'aaaaaaaaaaaa', at: 6, back: true }]).copies;
  assert.deepEqual([...copies.keys()], ['bbbbbbbbbbbb/s'], 'each copy by its own machine');
});

// ---------------------------------------------------------------------------------------------------------------
// Sync's edge cases: the trash, a restore stopped between a landing and its record, a cleanup made while a run
// puts a session back, comments moved since they were backed up, the marker, and the folder keys.
// ---------------------------------------------------------------------------------------------------------------

/** Every file below `dir`, by path; none when it is not there. */
function filesBelow(dir) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) (e.isDirectory() ? walk : (p) => out.push(p))(path.join(d, e.name));
  };
  walk(dir);
  return out.sort();
}

/** A folder backup at `share` for the machine whose home is `home`, sealed under `key`. */
async function folderBackup(home, share, key) {
  await as(home, () => {
    core.writeSyncKey(key);
    assert.equal(core.initBackupFolder(share, key).check.ok, true);
    core.writePrefs({ ...core.readPrefs(), sync: { backup: { kind: 'folder', path: share } } });
  });
}

const noMachine = () => ({ machines: async () => [], inventory: async () => ({ status: 'failed' }), fetch: () => { throw new Error('no machine'); } });

/** Rewrite every part of every record in the backup folder `share` as an earlier 0.11.0 build wrote it: no entry names a
 *  generation (`g`). */
function stripGenerations(share, key) {
  const keys = core.folderKeys(key);
  for (const mid of fs.readdirSync(path.join(share, 'machines'))) {
    const mdir = path.join(share, 'machines', mid);
    for (const n of fs.readdirSync(mdir).filter((x) => /^(seg|snap)-\d{12}$/.test(x))) {
      const aad = `oak-sync\0manifest\0${mid}\0${n}`;
      const part = JSON.parse(core.unseal(keys, fs.readFileSync(path.join(mdir, n)), aad, n).toString('utf8'));
      for (const e of [...(part.put ?? []), ...(part.files ?? [])]) delete e.g;
      fs.writeFileSync(path.join(mdir, n), core.seal(keys, Buffer.from(JSON.stringify(part)), aad));
    }
  }
}

test('sync store: a copy of another machine\'s log that only grew is replaced with nothing to the trash; a log rewritten keeps the copy it replaced there', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-trash-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a'), B = path.join(base, 'b');
  const S = 'sess-grows';
  const log = path.join(A, '.claude', 'claude-observatory', S, 'log.jsonl');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const rec = (i) => `${JSON.stringify({ id: i, pad: 'x'.repeat(300) })}\n`;
  // Each write dated a second on, ten minutes back: no session running now.
  const dated = (k) => fs.utimesSync(log, new Date(Date.now() - 600_000 + k * 1000), new Date(Date.now() - 600_000 + k * 1000));
  fs.writeFileSync(log, rec(0));
  dated(0);
  const hostA = await as(A, () => core.syncInventory({ user: core.localUserName() }).host);
  const replica = path.join(B, '.claude', 'claude-observatory', 'sync', 'replicas', hostA, S, 'log.jsonl');
  const trash = path.join(B, '.claude', 'claude-observatory', 'sync', 'trash');
  await as(B, () => core.syncNow(inProcess({ a: A })));
  assert.equal(fs.readFileSync(replica, 'utf8'), rec(0), 'control: the copy is here');
  for (let k = 1; k <= 5; k++) {
    fs.appendFileSync(log, rec(k));
    dated(k);
    const r = await as(B, () => core.syncNow(inProcess({ a: A })));
    assert.deepEqual(r.done.filter((d) => d.family === 'oak-log').map((d) => d.action), ['replace'], `run ${k}`);
  }
  assert.equal(fs.readFileSync(replica, 'utf8'), fs.readFileSync(log, 'utf8'));
  assert.deepEqual(filesBelow(trash), [], 'a copy that is the start of its new one holds nothing that one lacks');
  // A run on a marks the session's folder with its generation, which a rewrite of its log keeps.
  await as(A, () => core.syncNow(noMachine()));
  assert.ok(fs.existsSync(path.join(path.dirname(log), 'sync-generation')), 'control: marked');
  // A clear rewrites the log: the copy it replaces holds what the new one lacks, and goes to the trash, once.
  const before = fs.readFileSync(log, 'utf8');
  fs.writeFileSync(log, rec(99));
  dated(9);
  await as(B, () => core.syncNow(inProcess({ a: A })));
  const kept = filesBelow(trash);
  assert.equal(kept.length, 1, JSON.stringify(kept));
  assert.equal(fs.readFileSync(kept[0], 'utf8'), before);
  assert.equal(fs.readFileSync(replica, 'utf8'), rec(99));
});

test('sync folder: a restore stopped right after a file landed, before sync noted it (a SIGKILL, a crash), goes on in the next run', { skip: process.platform === 'win32' && 'no SIGKILL' }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-killed-restore-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  // Run as a machine, and killed right after a file whose path holds `what` lands in its session's folder.
  const child = path.join(base, 'killed-run.js');
  fs.writeFileSync(child, `
const fs = require('fs');
const core = require(${JSON.stringify(path.join(__dirname, '..', 'dist'))});
const [what, dir] = process.argv.slice(2);
const rename = fs.renameSync;
fs.renameSync = function (from, to) {
  const r = rename.call(fs, from, to);
  if (String(to).startsWith(dir + require('path').sep) && String(to).includes(what)) process.kill(process.pid, 'SIGKILL');
  return r;
};
core.syncNow({ machines: async () => [], inventory: async () => ({ status: 'failed' }), fetch: () => { throw new Error('no machine'); } });
`);
  const h = (b) => require('crypto').createHash('sha256').update(b).digest('hex');
  const blobs = ['one', 'two', 'three', 'four'];
  // The first file of each kind to land: a snapshot (content-addressed), the hook events (append-only) and the log
  // (mirrored); the comments land after the log. Each on a machine of its own, whose manifest knows no earlier landing.
  for (const what of [`${path.sep}blobs${path.sep}`, 'capture-events.jsonl', 'log.jsonl']) {
    const A = path.join(base, `a-${what.replace(/\W/g, '')}`);
    const share = path.join(base, `share-${what.replace(/\W/g, '')}`);
    await folderBackup(A, share, core.newSyncKey());
    const S = 'sess-restored';
    const dir = path.join(A, '.claude', 'claude-observatory', S);
    fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
    for (const b of blobs) fs.writeFileSync(path.join(dir, 'blobs', h(b)), b);
    fs.writeFileSync(path.join(dir, 'log.jsonl'), blobs.map((b, i) => `${JSON.stringify({ id: i, afterBlob: h(b) })}\n`).join(''));
    fs.writeFileSync(path.join(dir, 'capture-events.jsonl'), '{"e":1}\n');
    fs.writeFileSync(path.join(dir, 'comments.json'), '{"version":1,"comments":[]}');
    // What the run marks its folder with (its generation) comes back with it too.
    await as(A, () => core.syncNow(noMachine()));
    const want = filesBelow(dir).map((f) => [path.relative(dir, f), fs.readFileSync(f, 'utf8')]);
    assert.ok(want.some(([n]) => n === 'sync-generation'), 'control: marked');
    fs.rmSync(dir, { recursive: true }); // lost here, with no cleanup
    const env = { ...process.env, HOME: A, USERPROFILE: A, CLAUDE_CONFIG_DIR: path.join(A, '.claude'), CODEX_HOME: path.join(A, '.codex'), OAK_MACHINE_LABEL: 'a' };
    const r = cp.spawnSync(process.execPath, [child, what, dir], { env, encoding: 'utf8' });
    assert.equal(r.signal, 'SIGKILL', `${what}: ${r.stderr}`);
    assert.notDeepEqual(filesBelow(dir).map((f) => [path.relative(dir, f), fs.readFileSync(f, 'utf8')]), want, `control (${what}): the run stopped part way`);
    const next = await as(A, () => core.syncNow(noMachine()));
    assert.equal(next.status, 'ok', JSON.stringify(next.machines));
    assert.deepEqual(filesBelow(dir).map((f) => [path.relative(dir, f), fs.readFileSync(f, 'utf8')]), want, `${what}: the next run put the rest back`);
  }
});

test('sync store: a session cleaned up here while a run puts it back stays cleaned up: what the run brought goes to the trash, and no later run brings it back', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-clean-meanwhile-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a'), B = path.join(base, 'b');
  const S = 'sess-cleaned-meanwhile';
  const dir = path.join(A, '.claude', 'claude-observatory', S);
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
  for (const b of ['one', 'two']) fs.writeFileSync(path.join(dir, 'blobs', require('crypto').createHash('sha256').update(b).digest('hex')), b);
  fs.writeFileSync(path.join(dir, 'log.jsonl'), '{"id":1}\n{"id":2}\n');
  fs.writeFileSync(path.join(dir, 'capture-events.jsonl'), '{"e":1}\n');
  for (const f of filesBelow(dir)) fs.utimesSync(f, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
  // B is the backup machine: it holds every file of A's sessions.
  await as(B, () => core.writePrefs({ ...core.readPrefs(), sync: { backup: { kind: 'machine', label: 'b' } } }));
  await as(B, () => core.syncNow(inProcess({ a: A })));
  // A loses S (no cleanup), and runs: the copy comes back from B. Half way through B's answer, S is cleaned up on A.
  fs.rmSync(dir, { recursive: true });
  let cleaned = false;
  const meanwhile = {
    ...inProcess({ b: B }),
    fetch: (target, user, request) => {
      const chunks = [];
      const done = as(B, () => core.serveSyncFetch(request, user, async (x) => { chunks.push(Buffer.from(x)); })).then(() => null);
      return { stream: (async function* () {
        await done;
        for (let i = 0; i < chunks.length; i++) {
          if (i === Math.floor(chunks.length / 2) && !cleaned) {
            cleaned = true;
            core.removeSession(S); // as `oak clean --drop`, run as A (this answer is read inside A's run)
          }
          yield chunks[i];
        }
      })(), done };
    },
  };
  await as(A, () => core.syncNow(meanwhile));
  assert.ok(cleaned, 'control: the cleanup happened during the run');
  assert.ok(fs.existsSync(dir), 'control: the run made the folder again, for what it put back after the cleanup');
  for (let i = 0; i < 2; i++) await as(A, () => core.syncNow(inProcess({ b: B })));
  assert.ok(!fs.existsSync(dir), 'the cleanup stands');
  const ids = fs.readFileSync(path.join(A, '.claude', 'claude-observatory', 'sync', 'evicted.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(ids.map((e) => [e.id, !!e.back]), [[S, false]], 'and no line says it came back');
  assert.ok(filesBelow(path.join(A, '.claude', 'claude-observatory', 'sync', 'trash')).some((f) => f.endsWith(`${S}${path.sep}log.jsonl`)), 'what the run brought is in the trash');
  // Control: made again by a capture (a log sync did not write), it is a session again.
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'log.jsonl'), '{"id":1,"captured":"again"}\n');
  await as(A, () => core.syncNow(inProcess({ b: B })));
  assert.equal(fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8'), '{"id":1,"captured":"again"}\n');
});

test('sync folder: comments the backup holds where they were kept before 0.11.0 leave its record once they moved into the session\'s file, so a restore brings no removed comment back', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-old-comments-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a');
  const share = path.join(base, 'share');
  const key = core.newSyncKey();
  await folderBackup(A, share, key);
  const S = 'sess-comments';
  const store = path.join(A, '.claude', 'claude-observatory');
  fs.mkdirSync(path.join(store, S), { recursive: true });
  fs.writeFileSync(path.join(store, S, 'log.jsonl'), '{"id":1}\n');
  const c = (id, text) => ({ id, unit: 1, pair: 'p', file: '/f', line: 1, text, createdAt: 1 });
  const old = path.join(store, 'changemap-cache', S, 'comments.json');
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, JSON.stringify({ version: 1, comments: [c('c1', 'kept'), c('c2', 'removed later')] }));
  await as(A, () => core.syncNow(noMachine()));
  // The move, as comments.ts makes it at the next change (one comment removed in it): the session's own file, then the
  // old one goes.
  fs.writeFileSync(path.join(store, S, 'comments.json'), JSON.stringify({ version: 1, comments: [c('c1', 'kept')] }));
  fs.rmSync(old);
  assert.deepEqual((await as(A, () => core.readComments(S))).map((x) => x.text), ['kept'], 'control');
  await as(A, () => core.syncNow(noMachine()));
  // Wiped, and restored from the folder alone, once it takes its record there over (`oak sync setup --restore`).
  fs.rmSync(path.join(A, '.claude'), { recursive: true });
  await folderBackup(A, share, key);
  await as(A, () => core.claimBackupRecord(core.openBackupFolder(share).folder, core.machineHostTag()));
  const r = await as(A, () => core.syncNow(noMachine()));
  assert.equal(r.status, 'ok', JSON.stringify(r.machines));
  assert.ok(fs.existsSync(path.join(store, S, 'comments.json')), 'control: the comments came back');
  assert.ok(!fs.existsSync(old), 'not the file they moved from');
  assert.deepEqual((await as(A, () => core.readComments(S))).map((x) => x.text), ['kept']);
});

test('sync folder: a marker that is not JSON is no OAK backup\'s marker, and says so by its path', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-bad-marker-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const share = path.join(base, 'share');
  fs.mkdirSync(share);
  fs.writeFileSync(path.join(share, 'oak-backup'), 'not json{');
  assert.throws(() => core.openBackupFolder(share, core.newSyncKey()), (e) => e instanceof core.SyncSealError && e.message.includes(path.join(share, 'oak-backup')) && /not an OAK backup's marker/.test(e.message));
});

test('sync crypto: the folder\'s keys are held as KeyObjects, and name and seal as the folders already written expect', () => {
  const keys = core.folderKeys(Buffer.alloc(32, 9));
  assert.deepEqual([keys.enc.type, keys.name.type], ['secret', 'secret']);
  // Made with this key by the build under review, before its keys were KeyObjects: what a folder holds already.
  assert.equal(core.objectName(keys, 'ab'.repeat(32)), 'b1386298a71f7ca4ffafc78cca9fdc593752266e53cda6f2f1df505fcfd99b33');
  assert.equal(core.keyedName(keys, 'machine\0aaaaaaaaaaaa'), 'cff2f8f38d35f186a8ea378d3225429f0ba392935ec03f19d82f72b47318a6ea');
  assert.equal(core.unseal(keys, Buffer.from('AXqFOK8QTnwcldKfXrv1ip/YsZcFAGV7O9cTj+r1KPVtlIkaFUwh7Cnu+4s=', 'base64'), 'oak-sync\0object\0kat', 'x').toString(), 'known plaintext');
});

test('sync folder: no part of a record is written larger than a reader takes: the push says so, and the record stays readable as it was', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-part-max-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a');
  const share = path.join(base, 'share');
  await folderBackup(A, share, core.newSyncKey());
  for (let i = 0; i < 40; i++) {
    const dir = path.join(A, '.claude', 'claude-observatory', `sess-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'log.jsonl'), `${JSON.stringify({ id: 1, i })}\n`);
  }
  const parts = () => filesBelow(path.join(share, 'machines')).filter((p) => /(seg|snap)-\d{12}$/.test(p));
  // Pushed as a run pushes, with a part limit small enough that a part naming 40 sessions passes it.
  const push = (part) => as(A, () => {
    const user = core.localUserName();
    const opened = core.openBackupFolder(share);
    assert.equal(opened.ok, true);
    return core.pushToFolder(opened.folder, { me: core.syncInventory({ user }), placements: {}, now: Date.now() }, new Map(), { part });
  });
  await assert.rejects(push(2048), /outgrown what one part of it may hold/);
  assert.deepEqual(parts(), [], 'no part written');
  // Control: with room for it, the same push writes its part.
  await push(undefined);
  assert.equal(parts().length, 1);
});

// ---------------------------------------------------------------------------------------------------------------
// fix-s2: a session folder made anew is a new generation, whose earlier one the copies keep apart; a record of the
// backup folder is written by one machine; a store move and a sync run never overlap.
// ---------------------------------------------------------------------------------------------------------------

const sha256 = (b) => require('crypto').createHash('sha256').update(b).digest('hex');

/** An OAK store session `sid` on the machine whose home is `home`: its log of `records`, and the snapshots `blobs`. */
function oakSession(home, sid, records, blobs = []) {
  const dir = path.join(home, '.claude', 'claude-observatory', sid);
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
  for (const b of blobs) fs.writeFileSync(path.join(dir, 'blobs', sha256(b)), b);
  fs.writeFileSync(path.join(dir, 'log.jsonl'), records.map((r) => `${JSON.stringify(r)}\n`).join(''));
  return dir;
}

/** What the backup folder's record of the machine whose home is `home` names of a family, as that machine reads it. */
function recordOf(home, share, family) {
  return as(home, () => {
    const role = core.resolveSyncBackup({ kind: 'folder', path: share }, { nodes: [], local: core.syncInventory({ user: core.localUserName() }), readOnly: true });
    return (role.nodes.find((n) => n.inventory.host === core.machineHostTag())?.inventory.families[family] ?? []).sort((a, b) => (a.name < b.name ? -1 : 1));
  });
}
const names = (files) => files.map((f) => f.name);

test('sync folder: a session folder made anew (its store lost with no cleanup, then captured into) is a new generation: the record keeps the earlier one apart, which comes back here as a session listed as the earlier history, and is never replaced; a clear of the log is no new generation', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-generation-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a');
  const share = path.join(base, 'share');
  await folderBackup(A, share, core.newSyncKey());
  const S = 'sess-anew';
  // Its conversation, in a project folder other than the home's: the listing names the earlier history the same way
  // whether it reads the files or the local index, which reads each session from its own files alone.
  const work = path.join(A, 'work');
  const transcript = path.join(A, '.claude', 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'), `${S}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', cwd: work, sessionId: S, message: { role: 'user', content: 'make the thing' } })}\n`);
  const dir = oakSession(A, S, [{ id: 1, file: '/w/one', status: 'kept', afterBlob: sha256('one') }, { id: 2, file: '/w/two', status: 'pending', afterBlob: sha256('two') }], ['one', 'two']);
  await as(A, () => core.syncNow(noMachine()));
  const gen = fs.readFileSync(path.join(dir, 'sync-generation'), 'utf8').trim();
  assert.match(gen, /^[0-9a-f]{16}$/, 'control: the run marked the folder with its generation');
  // A clear rewrites the log (the id floor first): the same folder, so the same generation, and the record's log is
  // the new one, with no earlier history beside it.
  assert.equal(await as(A, () => core.clearResolved(S)), 1);
  await as(A, () => core.syncNow(noMachine()));
  assert.deepEqual(names(await recordOf(A, share, 'oak-log')), [`${S}/log.jsonl`], 'a clear is no new generation');
  const cleared = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8');
  // Lost with no cleanup, and made anew by a capture: the record keeps what it held of the session, apart.
  fs.rmSync(dir, { recursive: true });
  oakSession(A, S, [{ id: 1, file: '/w/new', status: 'pending', afterBlob: sha256('new') }], ['new']);
  const E = core.earlierGenerationId(S, gen);
  const r = await as(A, () => core.syncNow(noMachine()));
  assert.equal(r.status, 'ok', JSON.stringify(r.machines));
  assert.ok(r.warnings.some((x) => x.includes(`session ${S}'s folder was made anew here`) && x.includes(E)), JSON.stringify(r.warnings));
  assert.deepEqual(names(await recordOf(A, share, 'oak-log')), [`${E}/log.jsonl`, `${S}/log.jsonl`].sort());
  assert.deepEqual(names(await recordOf(A, share, 'oak-blobs')), [`${E}/blobs/${sha256('two')}`, `${S}/blobs/${sha256('new')}`].sort(), 'each generation with the snapshots its own log names');
  const gen2 = fs.readFileSync(path.join(dir, 'sync-generation'), 'utf8').trim();
  assert.notEqual(gen2, gen, 'the folder made anew has a generation of its own');
  // The next run brings the earlier history back here, whole, as that generation; the listing names it so.
  await as(A, () => core.syncNow(noMachine()));
  const earlier = path.join(A, '.claude', 'claude-observatory', E);
  assert.equal(fs.readFileSync(path.join(earlier, 'log.jsonl'), 'utf8'), cleared);
  assert.equal(fs.readFileSync(path.join(earlier, 'blobs', sha256('two')), 'utf8'), 'two');
  assert.equal(fs.readFileSync(path.join(earlier, 'sync-generation'), 'utf8').trim(), gen, 'it is that generation');
  const rows = (await as(A, () => core.sessionMeta(A, null, {}))).sessions;
  const row = rows.find((x) => x.id === E);
  assert.ok(row && row.title === `earlier history of session ${S}` && row.edits === 1 && row.agent === 'claude', JSON.stringify(rows));
  if (core.indexRuntime().ok) {
    await as(A, () => {
      const ix = core.useIndex({ budgetMs: Infinity, inlineBytes: Infinity });
      assert.ok(ix.ok && ix.catchUp.caughtUp, JSON.stringify(ix.ok ? ix.catchUp : ix));
      try {
        assert.deepEqual(core.indexedSessionMeta(ix.db, A, null, {}).sessions.find((x) => x.id === E), core.sessionMeta(A, null, {}).sessions.find((x) => x.id === E), 'the local index lists it as the files do');
      } finally {
        ix.close();
      }
    });
  }
  assert.equal((await recordOf(A, share, 'oak-log')).find((f) => f.name === `${E}/log.jsonl`).gen, gen, 'the record names it by that generation');
  const audit = () => fs.readFileSync(path.join(A, '.claude', 'claude-observatory', 'sync', 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(audit().some((l) => l.op === 'earlier' && l.name === E), 'an audit line says where the earlier history went');
  // A run stopped after it put the earlier history back and before it marked it (a SIGKILL): the next marks it as the
  // record names it, not by its log's first line, which the clear changed.
  fs.rmSync(path.join(earlier, 'sync-generation'));
  await as(A, () => core.syncNow(noMachine()));
  assert.equal(fs.readFileSync(path.join(earlier, 'sync-generation'), 'utf8').trim(), gen, 'marked again as the record names it');
  // Made anew once more: a third generation, kept apart from both; the earlier history stays as it was.
  fs.rmSync(dir, { recursive: true });
  oakSession(A, S, [{ id: 1, file: '/w/third', status: 'pending' }]);
  await as(A, () => core.syncNow(noMachine()));
  assert.deepEqual(names(await recordOf(A, share, 'oak-log')), [`${core.earlierGenerationId(S, gen2)}/log.jsonl`, `${E}/log.jsonl`, `${S}/log.jsonl`].sort());
  assert.equal(fs.readFileSync(path.join(earlier, 'log.jsonl'), 'utf8'), cleared, 'never replaced');
});

test('sync folder: a session deleted on purpose keeps no earlier history: its agent capturing again after the delete makes no copy of what the delete purged', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-generation-delete-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a');
  const share = path.join(base, 'share');
  await folderBackup(A, share, core.newSyncKey());
  const D = 'sess-deleted';
  oakSession(A, D, [{ id: 1, file: '/w/purged', status: 'kept', afterBlob: sha256('purged') }], ['purged']);
  await as(A, () => core.syncNow(noMachine()));
  await as(A, () => core.deleteSession(D));
  assert.ok(!fs.existsSync(path.join(A, '.claude', 'claude-observatory', D)), 'control: its store purged');
  oakSession(A, D, [{ id: 1, file: '/w/after', status: 'pending' }]);
  const r = await as(A, () => core.syncNow(noMachine()));
  assert.equal(r.status, 'ok', JSON.stringify(r.machines));
  assert.deepEqual(names(await recordOf(A, share, 'oak-log')), [`${D}/log.jsonl`], 'no earlier history of a deleted session');
  assert.ok(!r.warnings.some((x) => /made anew/.test(x)), JSON.stringify(r.warnings));
});

test('sync store: a copy of another machine\'s session whose folder that machine made anew is kept as the session\'s earlier history beside the new one; a deleted session\'s copy goes, and is kept as none', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-generation-replica-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a'), B = path.join(base, 'b');
  const S = 'sess-replicated', D = 'sess-deleted-there', T = 'sess-no-log-yet';
  oakSession(A, S, [{ id: 1, file: '/w/one' }, { id: 2, file: '/w/two' }]);
  oakSession(A, D, [{ id: 1, file: '/w/d' }]);
  oakSession(A, T, [{ id: 1, file: '/w/t' }]);
  const hA = await as(A, () => core.machineHostTag());
  const replicas = path.join(B, '.claude', 'claude-observatory', 'sync', 'replicas', hA);
  // b copies a's sessions before a has run sync itself: the copy names the generation a's inventory gives it.
  await as(B, () => core.syncNow(inProcess({ a: A })));
  const was = fs.readFileSync(path.join(replicas, S, 'sync-generation'), 'utf8').trim();
  const before = fs.readFileSync(path.join(replicas, S, 'log.jsonl'), 'utf8');
  await as(A, () => core.syncNow(noMachine()));
  assert.equal(fs.readFileSync(path.join(A, '.claude', 'claude-observatory', S, 'sync-generation'), 'utf8').trim(), was, 'a marks its folder with the generation the copy names');
  // a loses S with no cleanup, and a capture makes it anew; T too, made anew with an agent record and no log yet.
  fs.rmSync(path.join(A, '.claude', 'claude-observatory', S), { recursive: true });
  oakSession(A, S, [{ id: 1, file: '/w/new' }]);
  const wasT = fs.readFileSync(path.join(replicas, T, 'sync-generation'), 'utf8').trim();
  fs.rmSync(path.join(A, '.claude', 'claude-observatory', T), { recursive: true });
  fs.mkdirSync(path.join(A, '.claude', 'claude-observatory', T));
  fs.writeFileSync(path.join(A, '.claude', 'claude-observatory', T, 'agent.json'), '{"agent":"codex"}');
  const r = await as(B, () => core.syncNow(inProcess({ a: A })));
  const E = core.earlierGenerationId(S, was);
  assert.equal(fs.readFileSync(path.join(replicas, E, 'log.jsonl'), 'utf8'), before, 'the copy b held is kept, as the earlier history');
  assert.equal(fs.readFileSync(path.join(replicas, S, 'log.jsonl'), 'utf8'), `${JSON.stringify({ id: 1, file: '/w/new' })}\n`, 'beside the new one');
  assert.ok(r.warnings.some((x) => /made anew on (its|their) machine/.test(x) && x.includes(`${hA}/${S}`)), JSON.stringify(r.warnings));
  // T's folder names no generation while it has no log and no mark: b's copy stays as it is, and is set apart once a's
  // folder names one (here its first log line).
  assert.equal(fs.readFileSync(path.join(replicas, T, 'log.jsonl'), 'utf8'), `${JSON.stringify({ id: 1, file: '/w/t' })}\n`, 'a folder with no log yet replaces nothing');
  fs.writeFileSync(path.join(A, '.claude', 'claude-observatory', T, 'log.jsonl'), `${JSON.stringify({ id: 1, file: '/w/t-new' })}\n`);
  await as(B, () => core.syncNow(inProcess({ a: A })));
  assert.equal(fs.readFileSync(path.join(replicas, core.earlierGenerationId(T, wasT), 'log.jsonl'), 'utf8'), `${JSON.stringify({ id: 1, file: '/w/t' })}\n`, 'a folder made anew with no log yet is another generation too');
  const auditB = fs.readFileSync(path.join(B, '.claude', 'claude-observatory', 'sync', 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(auditB.some((l) => l.op === 'earlier' && l.name === `sync/replicas/${hA}/${E}`), 'an audit line says where the copy went');
  // a deletes D (`oak sessions --delete`) while its agent goes on capturing: b's copy goes with the delete, and no
  // earlier history of it is kept anywhere.
  await as(A, () => core.deleteSession(D));
  oakSession(A, D, [{ id: 1, file: '/w/after-delete' }]);
  await as(A, () => core.syncNow(noMachine()));
  const d = await as(B, () => core.syncNow(inProcess({ a: A })));
  assert.ok(!fs.existsSync(path.join(replicas, D)), JSON.stringify(d.done));
  assert.deepEqual(fs.readdirSync(replicas).filter((n) => n.startsWith(`${D}_earlier-`)), [], 'none of a deleted session');
  assert.ok(filesBelow(path.join(B, '.claude', 'claude-observatory', 'sync', 'trash')).some((f) => f.endsWith(`${D}${path.sep}log.jsonl`)), 'its copy went to the trash');
});

test('sync folder: a record written before generations were is the same session where what it holds of the log only grew, and kept apart where the log is another', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-generation-legacy-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a');
  const share = path.join(base, 'share');
  const key = core.newSyncKey();
  await folderBackup(A, share, key);
  const store = path.join(A, '.claude', 'claude-observatory');
  oakSession(A, 'sess-grows', [{ id: 1, file: '/w/g' }]);
  oakSession(A, 'sess-other', [{ id: 1, file: '/w/o' }]);
  // Pushed as an earlier 0.11.0 build pushed: files that name no generation, and no folder marked.
  await as(A, () => core.syncNow(noMachine()));
  stripGenerations(share, key);
  for (const sid of ['sess-grows', 'sess-other']) fs.rmSync(path.join(store, sid, 'sync-generation'));
  assert.ok((await recordOf(A, share, 'oak-log')).every((f) => !f.gen), 'control: the record names no generation');
  assert.ok(!fs.existsSync(path.join(store, 'sess-grows', 'sync-generation')), 'control: no folder marked');
  fs.appendFileSync(path.join(store, 'sess-grows', 'log.jsonl'), `${JSON.stringify({ id: 2, file: '/w/g2' })}\n`);
  fs.rmSync(path.join(store, 'sess-other'), { recursive: true });
  oakSession(A, 'sess-other', [{ id: 1, file: '/w/another' }]);
  await as(A, () => core.syncNow(noMachine()));
  const logs = await recordOf(A, share, 'oak-log');
  assert.deepEqual(names(logs).filter((n) => n.startsWith('sess-grows')), ['sess-grows/log.jsonl'], 'grown: the same session');
  assert.equal(logs.find((f) => f.name === 'sess-grows/log.jsonl').gen, fs.readFileSync(path.join(store, 'sess-grows', 'sync-generation'), 'utf8').trim(), 'named by its generation from now on');
  assert.equal(names(logs).filter((n) => /^sess-other_earlier-[0-9a-f]{16}\/log\.jsonl$/.test(n)).length, 1, `another log: the record's kept apart: ${names(logs)}`);
});

test('sync folder: a record is written by one machine: one of the same host name and home neither restores from it nor writes it, every run, and says what to do; a machine reinstalled takes it over only when told', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-writer-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  // Two machines that name themselves alike: the same host name and home folder, so the same host tag.
  const mu = require(path.join(__dirname, '..', 'dist', 'machine-usage.js'));
  const real = mu.machineHostTag;
  const X = path.join(base, 'x'), Y = path.join(base, 'y'), share = path.join(base, 'share');
  mu.machineHostTag = () => ([X, Y].includes(process.env.HOME) ? 'aaaaaaaaaaaa' : real());
  t.after(() => { mu.machineHostTag = real; });
  const key = core.newSyncKey();
  await folderBackup(X, share, key);
  await folderBackup(Y, share, key);
  oakSession(X, 'sess-of-x', [{ id: 1, file: '/x' }]);
  oakSession(Y, 'sess-of-y', [{ id: 1, file: '/y' }]);
  assert.equal((await as(X, () => core.syncNow(noMachine()))).status, 'ok');
  const writer = (home) => path.join(home, '.claude', 'claude-observatory', 'sync', 'writer');
  assert.match(fs.readFileSync(writer(X), 'utf8'), /^[0-9a-f]{32}\n$/, 'control: x made its writer id at its first push');
  if (process.platform !== 'win32') assert.equal(fs.statSync(writer(X)).mode & 0o777, 0o600); // no POSIX modes on Windows
  const shareNow = () => filesBelow(share).map((f) => `${path.relative(share, f)}:${fs.statSync(f).size}`);
  const quiet = shareNow();
  const backupLine = (r) => r.machines.find((m) => m.label.startsWith('backup'));
  for (let i = 0; i < 2; i++) {
    const r = await as(Y, () => core.syncNow(noMachine()));
    assert.equal(backupLine(r).status, 'failed');
    assert.match(backupLine(r).detail, /record under this machine's name .* that this machine has not written: last written [^ ]+ by x \(home .*\)\. If this machine is a reinstall of that one, `oak sync setup --restore`.*give it another host name.*Until then nothing is restored from the folder or written to it/);
  }
  assert.ok(!fs.existsSync(path.join(Y, '.claude', 'claude-observatory', 'sess-of-x')), 'y took nothing of x\'s');
  assert.deepEqual(shareNow(), quiet, 'and wrote nothing there');
  assert.ok(!fs.existsSync(writer(Y)), 'nor made a writer id');
  // y has a writer id of its own (it wrote a backup before), and even a push state for this record (a store copied from
  // x): the writer the record's parts carry is another, and the record is refused as another machine's.
  fs.writeFileSync(writer(Y), `${'b'.repeat(32)}\n`);
  const xFolder = path.join(X, '.claude', 'claude-observatory', 'sync', 'folder');
  fs.cpSync(xFolder, path.join(Y, '.claude', 'claude-observatory', 'sync', 'folder'), { recursive: true });
  const other = await as(Y, () => core.syncNow(noMachine()));
  assert.match(backupLine(other).detail, /another machine with this machine's host name and home folder writes the backup folder's record under that name/);
  assert.deepEqual(shareNow(), quiet);
  // x goes on as before, and takes nothing of y's.
  assert.equal((await as(X, () => core.syncNow(noMachine()))).status, 'ok');
  assert.ok(!fs.existsSync(path.join(X, '.claude', 'claude-observatory', 'sess-of-y')));
  // x reinstalled: refused until it takes its record over, then restored.
  fs.rmSync(path.join(X, '.claude'), { recursive: true });
  await folderBackup(X, share, key);
  assert.match(backupLine(await as(X, () => core.syncNow(noMachine()))).detail, /this machine has not written/);
  assert.deepEqual(await as(X, () => core.backupRecordOwner(core.openBackupFolder(share).folder, core.machineHostTag())).then((o) => o.state), 'unclaimed');
  await as(X, () => core.claimBackupRecord(core.openBackupFolder(share).folder, core.machineHostTag()));
  assert.equal((await as(X, () => core.syncNow(noMachine()))).status, 'ok');
  assert.ok(fs.existsSync(path.join(X, '.claude', 'claude-observatory', 'sess-of-x', 'log.jsonl')), 'restored once taken over');
  // A record whose parts name no writer (written by an earlier 0.11.0 build) is this machine's where its push state says
  // it wrote it, and no machine's otherwise.
  const mdir = path.join(share, 'machines', fs.readdirSync(path.join(share, 'machines'))[0]);
  const keys = core.folderKeys(key);
  for (const n of fs.readdirSync(mdir).filter((x) => /^(seg|snap)-\d{12}$/.test(x))) {
    const aad = `oak-sync\0manifest\0${path.basename(mdir)}\0${n}`;
    const part = JSON.parse(core.unseal(keys, fs.readFileSync(path.join(mdir, n)), aad, n).toString('utf8'));
    delete part.writer;
    fs.writeFileSync(path.join(mdir, n), core.seal(keys, Buffer.from(JSON.stringify(part)), aad));
  }
  fs.rmSync(writer(X));
  const pushState = filesBelow(path.join(X, '.claude', 'claude-observatory', 'sync', 'folder')).find((f) => f.endsWith('push.json'));
  const saved = fs.readFileSync(pushState);
  fs.rmSync(pushState);
  assert.match(backupLine(await as(X, () => core.syncNow(noMachine()))).detail, /this machine has not written/, 'no push state here: no machine\'s');
  fs.writeFileSync(pushState, saved);
  assert.equal(backupLine(await as(X, () => core.syncNow(noMachine()))).status, 'ok', 'this machine\'s, by its push state');
});

test('sync: a store move and a sync run each refuse while the other runs, each naming the other, and nothing lands where the store was', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-store-move-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a');
  oakSession(A, 'sess-1', [{ id: 1, file: '/w/1' }]);
  const store = path.join(A, '.claude', 'claude-observatory');
  const moved = path.join(base, 'moved-store');
  await as(A, async () => {
    // A run holds its lock: the move refuses, and the store stays where it is.
    assert.ok(core.takeSyncLock(core.SYNC_RUN_STALE_MS), 'control: the run\'s lock');
    try {
      const r = core.moveStore(moved);
      assert.match(r.error ?? '', /an oak sync run is writing to the store.*try again once it finishes/, JSON.stringify(r));
      assert.ok(fs.existsSync(path.join(store, 'sess-1')) && !fs.existsSync(moved));
    } finally {
      core.releaseSyncLock();
    }
    // A move holds its lock: a run, and `oak sync fetch`, refuse, and write nothing in the store, its status file included;
    // nor are the session deletes another machine's run asks this one to record (`__sync-inventory --publish`) written.
    core.writeIndex('bbbbbbbbbbbb', 'b', { inventory: 1, at: Date.now(), host: 'bbbbbbbbbbbb', user: core.localUserName(), home: '/home/b', platform: 'linux', cleanupPeriodDays: null,
      projects: [], identities: {}, shares: [], codexSqlite: [], families: { 'oak-log': [{ name: 'sess-of-b/log.jsonl', size: 10, mtime: Date.now() }] } });
    fs.writeFileSync(path.join(store, 'hidden-sessions.json'), JSON.stringify(['sess-deleted']));
    const lock = path.join(A, '.claude', 'claude-observatory-move', 'lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, `${process.pid}:${require('crypto').randomUUID()}:${Number(process.hrtime.bigint() / 1_000_000n)}`);
    try {
      const before = filesBelow(store);
      await assert.rejects(core.syncNow(noMachine()), /OAK's store is being moved \(process \d+\).*try again once the move finishes/);
      await assert.rejects(core.syncFetchSession(noMachine(), 'sess-of-b'), /OAK's store is being moved/);
      core.recordSessionDeletes();
      assert.deepEqual(filesBelow(store), before, 'nothing written');
    } finally {
      fs.rmSync(lock, { force: true });
    }
    // Neither held: the move goes ahead.
    assert.equal(core.moveStore(moved).moved, true);
  });
});

test('sync folder: a push marks each session folder its part names with the generation it names it by, so a later clear of the log is still that session', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-generation-push-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a');
  const share = path.join(base, 'share');
  await folderBackup(A, share, core.newSyncKey());
  const S = 'sess-pushed';
  const dir = oakSession(A, S, [{ id: 1, file: '/w/1', status: 'kept' }, { id: 2, file: '/w/2', status: 'pending' }]);
  // Pushed as a run pushes, with no run before it to mark the folder.
  const push = () => as(A, () => core.pushToFolder(core.openBackupFolder(share).folder, { me: core.syncInventory({ user: core.localUserName() }), placements: {}, now: Date.now() }, new Map()));
  await push();
  const gen = fs.readFileSync(path.join(dir, 'sync-generation'), 'utf8').trim();
  assert.equal((await recordOf(A, share, 'oak-log')).find((f) => f.name === `${S}/log.jsonl`).gen, gen, 'the folder carries what the record names it by');
  assert.equal(await as(A, () => core.clearResolved(S)), 1);
  const r = await as(A, () => core.syncNow(noMachine()));
  assert.equal(r.status, 'ok', JSON.stringify(r.machines));
  assert.deepEqual(names(await recordOf(A, share, 'oak-log')), [`${S}/log.jsonl`], 'the clear is no new generation');
});

test('sync store: a session put back from another machine\'s copy keeps the generation that copy names, so that copy is not set apart, though its log was cleared since it was marked', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-generation-restore-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a'), B = path.join(base, 'b');
  const R = 'sess-restored-from-b';
  const dir = oakSession(A, R, [{ id: 1, file: '/w/1', status: 'kept' }, { id: 2, file: '/w/2', status: 'pending' }]);
  await as(A, () => core.syncNow(noMachine()));
  const gen = fs.readFileSync(path.join(dir, 'sync-generation'), 'utf8').trim();
  assert.equal(await as(A, () => core.clearResolved(R)), 1); // the first line is the id floor now
  await as(B, () => core.syncNow(inProcess({ a: A })));
  const hA = await as(A, () => core.machineHostTag());
  const replicas = path.join(B, '.claude', 'claude-observatory', 'sync', 'replicas', hA);
  assert.equal(fs.readFileSync(path.join(replicas, R, 'sync-generation'), 'utf8').trim(), gen, 'control: b\'s copy names a\'s generation');
  // a loses R with no cleanup; its next run puts it back from b's copy, as that generation.
  fs.rmSync(dir, { recursive: true });
  await as(A, () => core.syncNow(inProcess({ b: B })));
  assert.ok(fs.existsSync(path.join(dir, 'log.jsonl')), 'control: put back');
  assert.equal(fs.readFileSync(path.join(dir, 'sync-generation'), 'utf8').trim(), gen);
  await as(B, () => core.syncNow(inProcess({ a: A })));
  assert.deepEqual(fs.readdirSync(replicas).filter((n) => n.startsWith(`${R}_earlier-`)), [], 'b sets no copy apart');
});

test('sync store: a copy of a session its machine made anew is set apart on the backup folder\'s word while that machine is away, and no new copy is made from the folder', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-generation-away-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a'), B = path.join(base, 'b');
  const share = path.join(base, 'share');
  const key = core.newSyncKey();
  await folderBackup(A, share, key);
  await folderBackup(B, share, key);
  const S = 'sess-anew-away';
  oakSession(A, S, [{ id: 1, file: '/w/old' }]);
  await as(A, () => core.syncNow(noMachine()));
  await as(B, () => core.syncNow(inProcess({ a: A })));
  const hA = await as(A, () => core.machineHostTag());
  const replicas = path.join(B, '.claude', 'claude-observatory', 'sync', 'replicas', hA);
  const was = fs.readFileSync(path.join(replicas, S, 'sync-generation'), 'utf8').trim();
  const before = fs.readFileSync(path.join(replicas, S, 'log.jsonl'), 'utf8');
  // a makes S anew, writes that to the folder, and goes away.
  fs.rmSync(path.join(A, '.claude', 'claude-observatory', S), { recursive: true });
  oakSession(A, S, [{ id: 1, file: '/w/new' }]);
  await as(A, () => core.syncNow(noMachine()));
  const away = { machines: async () => [{ id: 'm0', label: 'a', target: 'a', session: 'default', enabled: true, selected: false }], inventory: async () => ({ status: 'unreachable', detail: 'down' }), fetch: () => { throw new Error('down'); } };
  const r = await as(B, () => core.syncNow(away));
  assert.equal(r.machines.find((m) => m.label === 'a').status, 'unreachable');
  assert.equal(fs.readFileSync(path.join(replicas, core.earlierGenerationId(S, was), 'log.jsonl'), 'utf8'), before, 'kept apart, not replaced by the folder\'s newer copy');
  assert.ok(!fs.existsSync(path.join(replicas, S)), 'and no new copy made from the folder');
});

test('sync store: a run\'s upkeep marks a new session folder without reading the sync manifest again (the run holds it already)', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-generation-manifest-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a');
  const dir = oakSession(A, 'sess-new', [{ id: 1, file: '/w/1' }]);
  await as(A, () => {
    const manifest = core.readManifest();
    const me = core.syncInventory({ user: core.localUserName() });
    const read = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = function (p, ...rest) {
      if (String(p).endsWith(`${path.sep}manifest.jsonl`)) reads++;
      return read.call(fs, p, ...rest);
    };
    try {
      core.upkeepStoreReplicas({ nodes: [{ label: 'a', local: true, status: 'ok', inventory: me }], tombs: new Map(), manifest, now: Date.now(), warnings: [] });
    } finally {
      fs.readFileSync = read;
    }
    assert.ok(fs.existsSync(path.join(dir, 'sync-generation')), 'control: marked, and asked whether it was being put back');
    assert.equal(reads, 0, 'the manifest was read again');
  });
});

test('sync folder: a session folder lost and made anew while a run asks the other machines is a new generation to that run\'s push, though the run\'s inventory named the folder before', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-generation-race-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a');
  const share = path.join(base, 'share');
  await folderBackup(A, share, core.newSyncKey());
  const S = 'sess-anew-mid-run';
  const dir = oakSession(A, S, [{ id: 1, file: '/w/old' }]);
  await as(A, () => core.syncNow(noMachine()));
  const gen = fs.readFileSync(path.join(dir, 'sync-generation'), 'utf8').trim();
  // S grows, so the next run's inventory names it changed; while that run asks for the other machines, a's folder of S
  // is lost and a capture makes it anew. The run pulls nothing, so its push goes by that first inventory.
  fs.appendFileSync(path.join(dir, 'log.jsonl'), `${JSON.stringify({ id: 2, file: '/w/old2' })}\n`);
  const transport = { ...noMachine(), machines: async () => {
    fs.rmSync(dir, { recursive: true });
    oakSession(A, S, [{ id: 1, file: '/w/new' }]);
    return [];
  } };
  const r = await as(A, () => core.syncNow(transport));
  assert.deepEqual(r.done, [], 'control: nothing pulled, so the push lists this machine as the run first found it');
  const E = core.earlierGenerationId(S, gen);
  const logs = await recordOf(A, share, 'oak-log');
  assert.deepEqual(names(logs), [`${E}/log.jsonl`, `${S}/log.jsonl`].sort(), JSON.stringify(r.warnings));
  assert.equal(logs.find((f) => f.name === `${E}/log.jsonl`).size, Buffer.byteLength(`${JSON.stringify({ id: 1, file: '/w/old' })}\n`), 'the earlier history as the record held it');
  const now = fs.readFileSync(path.join(dir, 'sync-generation'), 'utf8').trim();
  assert.notEqual(now, gen, 'control: the folder made anew carries a generation of its own');
  assert.equal(logs.find((f) => f.name === `${S}/log.jsonl`).gen, now, 'and the record names the new log by it');
});

test('sync: a session cleaned up on purpose and captured into again before a run saw it keeps no earlier history anywhere: what was cleaned up stays gone, and what came after is the session', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-generation-cleaned-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a'), B = path.join(base, 'b');
  const share = path.join(base, 'share');
  await folderBackup(A, share, core.newSyncKey());
  // S is captured into again; R too, and its log cleared before any run (a rewrite of a folder no run marked yet).
  const S = 'sess-cleaned-again', R = 'sess-cleaned-cleared';
  for (const sid of [S, R]) oakSession(A, sid, [{ id: 1, file: `/w/${sid}/first` }], [`${sid}1`]);
  await as(A, () => core.syncNow(noMachine()));
  await as(B, () => core.syncNow(inProcess({ a: A })));
  const hA = await as(A, () => core.machineHostTag());
  const replicas = path.join(B, '.claude', 'claude-observatory', 'sync', 'replicas', hA);
  assert.ok(fs.existsSync(path.join(replicas, S, 'log.jsonl')) && fs.existsSync(path.join(replicas, R, 'log.jsonl')), 'control: b holds copies');
  // `oak clean --drop` while the agents run; their next captures make the sessions' stores again, before any run. b runs
  // first (a's folders are not marked yet), then a, then each once more.
  for (const sid of [S, R]) {
    await as(A, () => core.removeSession(sid));
    oakSession(A, sid, [{ id: 1, file: `/w/${sid}/second`, status: 'kept' }, { id: 2, file: `/w/${sid}/third`, status: 'pending' }], [`${sid}2`]);
  }
  assert.equal(await as(A, () => core.clearResolved(R)), 1, 'control: R cleared');
  await as(B, () => core.syncNow(inProcess({ a: A })));
  await as(A, () => core.syncNow(inProcess({ b: B })));
  await as(B, () => core.syncNow(inProcess({ a: A })));
  await as(A, () => core.syncNow(inProcess({ b: B })));
  for (const sid of [S, R]) {
    const earlier = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith(`${sid}_earlier-`));
    assert.deepEqual(earlier(replicas), [], `b keeps none of ${sid}`);
    assert.deepEqual(earlier(path.join(A, '.claude', 'claude-observatory')), [], `a gets none of ${sid} back`);
    assert.deepEqual(names(await recordOf(A, share, 'oak-log')).filter((n) => n.startsWith(sid)), [`${sid}/log.jsonl`], `the record keeps none of ${sid}`);
    const copy = fs.readFileSync(path.join(replicas, sid, 'log.jsonl'), 'utf8');
    assert.ok(copy.includes(`/w/${sid}/third`) && !copy.includes(`/w/${sid}/first`), `b's copy of ${sid} is what came after: ${copy}`);
  }
  assert.ok(filesBelow(path.join(B, '.claude', 'claude-observatory', 'sync', 'trash')).some((f) => f.endsWith(`${S}${path.sep}log.jsonl`)), 'what b held before went to the trash, as a copy replaced does');
});

test('sync store: a session of this machine\'s put back from two copies takes the generation of the copy its log came from, and none while its log is not back', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-generation-source-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a');
  const S = 'sess-two-sources', H = 'sess-log-not-back';
  await as(A, () => {
    const host = core.machineHostTag();
    // What a run put back, as its landing writes it to the manifest: S's snapshot from one copy and its log from
    // another; H's snapshot alone, its log not back.
    const landed = [];
    for (const sid of [S, H]) {
      const dir = path.join(core.rootDir(), sid);
      fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'blobs', sha256('b1')), 'b1');
      landed.push(['oak-blobs', `${sid}/blobs/${sha256('b1')}`]);
      if (sid === S) {
        fs.writeFileSync(path.join(dir, 'log.jsonl'), `${JSON.stringify({ id: 1, afterBlob: sha256('b1') })}\n`);
        landed.push(['oak-log', `${sid}/log.jsonl`]);
      }
    }
    for (const [family, name] of landed) {
      const st = fs.statSync(path.join(core.rootDir(), ...name.split('/')));
      core.appendManifest({ family, name, size: st.size, mtime: Math.floor(st.mtimeMs), sha256: null, origin: host });
    }
    const inv = (gen) => ({ inventory: 1, host, families: Object.fromEntries([['oak-blobs', []], ['oak-meta', []], ['oak-events', []], ['oak-log', [S, H].map((sid) => ({ name: `${sid}/log.jsonl`, size: 9, mtime: 1, gen }))]]) });
    const invs = { stale: inv('1111111111111111'), record: inv('2222222222222222') };
    core.noteLandedGenerations(landed.map(([family, name]) => ({ family, from: family === 'oak-log' ? 'record' : 'stale', name, to: name, action: 'create' })), (label) => invs[label]);
  });
  const store = path.join(A, '.claude', 'claude-observatory');
  assert.equal(fs.readFileSync(path.join(store, S, 'sync-generation'), 'utf8').trim(), '2222222222222222', 'the generation of the copy its log came from');
  assert.ok(!fs.existsSync(path.join(store, H, 'sync-generation')), 'none while the log its copy lists is not back');
});

test('sync folder: a session put back all but its log, then captured into before its log came back, is a new generation: the record keeps the log and snapshots it held as the earlier history', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-generation-half-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a');
  const share = path.join(base, 'share');
  await folderBackup(A, share, core.newSyncKey());
  const S = 'sess-half-restored';
  const dir = path.join(A, '.claude', 'claude-observatory', S);
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
  for (const b of ['b1', 'b2', 'b3']) fs.writeFileSync(path.join(dir, 'blobs', sha256(b)), b);
  fs.writeFileSync(path.join(dir, 'capture-events.jsonl'), `${JSON.stringify({ e: 1 })}\n`);
  await as(A, () => core.syncNow(noMachine()));
  const before = new Set(filesBelow(share));
  fs.writeFileSync(path.join(dir, 'log.jsonl'), [1, 2, 3].map((i) => `${JSON.stringify({ id: i, afterBlob: sha256(`b${i}`) })}\n`).join(''));
  await as(A, () => core.syncNow(noMachine()));
  const logBytes = filesBelow(share).filter((f) => !before.has(f) && !f.includes(`${path.sep}machines${path.sep}`));
  assert.ok(logBytes.length, 'control: the log\'s bytes are in objects of their own');
  const held = (await recordOf(A, share, 'oak-log')).find((f) => f.name === `${S}/log.jsonl`);
  // The folder is lost, and the log's bytes are away from the share for one run: it puts back all but the log.
  fs.rmSync(dir, { recursive: true });
  const saved = logBytes.map((f) => [f, fs.readFileSync(f)]);
  for (const [f] of saved) fs.rmSync(f);
  await as(A, () => core.syncNow(noMachine()));
  assert.ok(fs.existsSync(path.join(dir, 'capture-events.jsonl')) && !fs.existsSync(path.join(dir, 'log.jsonl')), 'control: all but the log put back');
  assert.ok(!fs.existsSync(path.join(dir, 'sync-generation')), 'the folder takes no generation before its log is back');
  for (const [f, bytes] of saved) fs.writeFileSync(f, bytes);
  // The session resumes before the next run: a capture starts its log afresh.
  fs.writeFileSync(path.join(dir, 'blobs', sha256('b9')), 'b9');
  fs.writeFileSync(path.join(dir, 'log.jsonl'), `${JSON.stringify({ id: 1, afterBlob: sha256('b9') })}\n`);
  const r = await as(A, () => core.syncNow(noMachine()));
  const logs = await recordOf(A, share, 'oak-log');
  const E = names(logs).find((n) => n.startsWith(`${S}_earlier-`));
  assert.ok(E, `the record keeps the log it held apart: ${names(logs)} ${JSON.stringify(r.warnings)}`);
  assert.equal(logs.find((f) => f.name === E).size, held.size, 'whole');
  assert.equal(names(await recordOf(A, share, 'oak-blobs')).filter((n) => n.startsWith(`${path.posix.dirname(E)}/`)).length, 3, 'with its snapshots');
});

test('sync store: on a machine that never runs a sync of its own, a clear of a log keeps its folder\'s generation, and a folder removed by hand while its old comments stay is no new one: the other machine keeps no earlier history', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-generation-unmarked-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const A = path.join(base, 'a'), B = path.join(base, 'b');
  const S = 'sess-cleared-there', T = 'sess-removed-there';
  oakSession(A, S, [{ id: 1, file: '/w/a', status: 'kept' }, { id: 2, file: '/w/b', status: 'pending' }]);
  oakSession(A, T, [{ id: 1, file: '/w/c' }]);
  fs.mkdirSync(path.join(A, '.claude', 'claude-observatory', 'changemap-cache', T), { recursive: true });
  fs.writeFileSync(path.join(A, '.claude', 'claude-observatory', 'changemap-cache', T, 'comments.json'), JSON.stringify({ v: 1, comments: [] }));
  await as(B, () => core.syncNow(inProcess({ a: A })));
  const hA = await as(A, () => core.machineHostTag());
  const replicas = path.join(B, '.claude', 'claude-observatory', 'sync', 'replicas', hA);
  assert.ok(fs.existsSync(path.join(replicas, S, 'log.jsonl')) && fs.existsSync(path.join(replicas, T, 'log.jsonl')), 'control: b holds both');
  assert.equal(await as(A, () => core.clearResolved(S)), 1, 'control: a cleared one resolved edit');
  assert.ok(!fs.readFileSync(path.join(A, '.claude', 'claude-observatory', S, 'log.jsonl'), 'utf8').startsWith('{"id":1,'), 'control: the clear put another line first');
  fs.rmSync(path.join(A, '.claude', 'claude-observatory', T), { recursive: true });
  await as(B, () => core.syncNow(inProcess({ a: A })));
  assert.deepEqual(fs.readdirSync(replicas).filter((n) => n.includes('_earlier-')), [], 'no earlier history kept');
  assert.match(fs.readFileSync(path.join(replicas, S, 'log.jsonl'), 'utf8'), /"pending"/, 'b\'s copy of S is the log as cleared');
  assert.ok(fs.existsSync(path.join(replicas, T, 'log.jsonl')), 'and its copy of T is kept as it was, under its own name');
});

test('sync folder: a machine whose sync state another machine copied (a VM made from its image) is refused once the copy writes its record, and so is the copy once the machine writes it again', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-sync-writer-copied-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const mu = require(path.join(__dirname, '..', 'dist', 'machine-usage.js'));
  const real = mu.machineHostTag;
  const X = path.join(base, 'x'), Y = path.join(base, 'y'), share = path.join(base, 'share');
  mu.machineHostTag = () => ([X, Y].includes(process.env.HOME) ? 'cccccccccccc' : real());
  t.after(() => { mu.machineHostTag = real; });
  const key = core.newSyncKey();
  await folderBackup(X, share, key);
  oakSession(X, 'sess-of-x', [{ id: 1, file: '/x' }]);
  assert.equal((await as(X, () => core.syncNow(noMachine()))).status, 'ok');
  // y is made from x's image: x's sync state, writer id and all, with sessions of its own.
  await folderBackup(Y, share, key);
  fs.cpSync(path.join(X, '.claude', 'claude-observatory', 'sync'), path.join(Y, '.claude', 'claude-observatory', 'sync'), { recursive: true });
  oakSession(Y, 'sess-of-y', [{ id: 1, file: '/y' }]);
  oakSession(X, 'sess-of-x2', [{ id: 1, file: '/x2' }]);
  assert.equal((await as(X, () => core.syncNow(noMachine()))).status, 'ok', 'x writes its record on');
  const shareNow = () => filesBelow(share).map((f) => `${path.relative(share, f)}:${fs.statSync(f).size}`);
  const quiet = shareNow();
  const backupLine = (r) => r.machines.find((m) => m.label.startsWith('backup'));
  const refused = (by) => new RegExp(`holds a part this machine did not write, with this machine's writer id: part \\d+, last written .* by ${by} .*Another machine has a copy of this machine's sync state.*Nothing is restored from the folder or written to it`);
  for (let i = 0; i < 2; i++) assert.match(backupLine(await as(Y, () => core.syncNow(noMachine()))).detail ?? '', refused('x'), 'y is refused, every run');
  assert.deepEqual(shareNow(), quiet, 'and wrote nothing there');
  assert.ok(!fs.existsSync(path.join(Y, '.claude', 'claude-observatory', 'sess-of-x2')), 'nor took anything of x\'s');
  assert.equal(backupLine(await as(X, () => core.syncNow(noMachine()))).status, 'ok', 'x goes on');
  // y taken over all the same (`oak sync setup --restore`): from then on x is the one refused.
  await as(Y, () => core.claimBackupRecord(core.openBackupFolder(share).folder, core.machineHostTag()));
  assert.equal((await as(Y, () => core.syncNow(noMachine()))).status, 'ok');
  assert.match(backupLine(await as(X, () => core.syncNow(noMachine()))).detail ?? '', refused('y'));
});

test('sync: the capture hook\'s bundle carries none of the sync engine (a store move asks for a sync run through sync-state alone)', () => {
  const capture = fs.readFileSync(path.resolve(__dirname, '..', '..', 'cli', 'dist', 'capture.js'), 'utf8');
  assert.match(fs.readFileSync(path.resolve(__dirname, '..', '..', 'cli', 'dist', 'cli.js'), 'utf8'), /^\/\/ \.\.\/core\/dist\/sync-engine\.js$/m, 'positive control: the CLI bundle does');
  for (const m of ['sync-engine', 'sync-store', 'sync-folder', 'sync']) assert.doesNotMatch(capture, new RegExp(`^// \\.\\./core/dist/${m}\\.js$`, 'm'), m);
});
