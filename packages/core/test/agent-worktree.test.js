const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../dist');
const spawn = require('../dist/spawn');
const { indexFixture } = require('./fixtures/index-fixture.cjs');

// Git mutations are represented by a synthetic executable boundary; tests never write a checkout's Git state.
function fixture(t) {
  const f = indexFixture(t, core);
  require('../../../test/fixtures/git.cjs').gitDir(path.join(f.work, '.git'));
  const state = { head: 'a'.repeat(40), status: '', diff: '', counts: '0\t0\n', treeDiff: '', list: '', calls: [] };
  t.mock.method(spawn, 'spawnToolSync', (bin, args, options) => {
    assert.equal(bin, 'git');
    assert.ok(options.timeout <= 10000);
    assert.equal(options.maxBuffer, 256 * 1024);
    assert.equal(options.env.GIT_OPTIONAL_LOCKS, '0');
    const a = args.slice(args.indexOf('-C') + 2);
    state.calls.push(a);
    // A status that takes `statusMs`: past its timeout, spawnSync kills it and says ETIMEDOUT.
    if (a[0] === 'status' && options.timeout < (state.statusMs ?? 0))
      return { status: null, signal: 'SIGTERM', error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' };
    let stdout = '';
    if (a[0] === 'status') stdout = state.status;
    else if (a[0] === 'rev-parse') stdout = a.includes('--abbrev-ref') || a.includes('--symbolic-full-name') ? 'main\n' : state.head + '\n';
    else if (a[0] === 'merge-base') stdout = 'a'.repeat(40) + '\n';
    else if (a[0] === 'rev-list') stdout = state.counts;
    else if (a[0] === 'diff') stdout = a.includes('--numstat') ? state.diff : state.treeDiff;
    else if (a[0] === 'worktree' && a[1] === 'list') stdout = state.list;
    else if (a[0] === 'worktree' && a[1] === 'add') {
      const target = a[a.length - 2];
      fs.mkdirSync(target);
      const admin = path.join(f.work, '.git', 'worktrees', path.basename(target));
      fs.mkdirSync(admin, { recursive: true });
      fs.writeFileSync(path.join(target, '.git'), `gitdir: ${admin}\n`);
      fs.writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/oak/agent-x\n');
      fs.writeFileSync(path.join(admin, 'commondir'), '../..\n');
    } else if (a[0] === 'worktree' && a[1] === 'remove') fs.rmSync(a.at(-1), { recursive: true, force: true });
    else if (a[0] === 'branch' && a[1] === '-d') state.branchDeleted = a.at(-1);
    else throw new Error(`unexpected Git command ${a}`);
    return { status: 0, stdout, stderr: '' };
  });
  return { ...f, state };
}

test('agent worktree: create, detect --cwd, refuse dirty/missing repositories and remove only merged work', (t) => {
  const f = fixture(t);
  const w = core.createAgentWorktree(f.work, 'agent-x');
  assert.deepEqual([w.path, w.branch, w.base, w.baseBranch], [path.join(f.dir, 'agent-x'), 'oak/agent-x', 'a'.repeat(40), 'main']);
  assert.ok(fs.existsSync(w.path));
  assert.equal(core.detectAgentWorktree(w.path).path, w.path);
  f.state.status = ' M parser.ts\0';
  assert.throws(() => core.createAgentWorktree(f.work, 'dirty'), /clean repository/);
  assert.throws(() => core.removeAgentWorktree(w), /clean and merged/);
  assert.throws(() => core.createAgentWorktree(f.dir, 'missing'), /existing Git repository/);
  f.state.status = ''; f.state.counts = '0\t1'; f.state.treeDiff = 'parser.ts\n';
  assert.throws(() => core.removeAgentWorktree(w), /merged/);
  f.state.counts = '1\t0';
  core.removeAgentWorktree(w);
  assert.equal(fs.existsSync(w.path), false);
  assert.ok(f.state.calls.some(a => a[0] === 'worktree' && a[1] === 'remove' && !a.includes('--force')));
});

test('agent worktree: removal waits on a Git slower than a refresh allows, and says when it could not read (Windows CI 2026-11-06)', (t) => {
  const f = fixture(t);
  const w = core.createAgentWorktree(f.work, 'agent-x'), v = core.createAgentWorktree(f.work, 'agent-y');
  f.state.statusMs = 800; // a status in a large tree, or on a slow machine: past a refresh's 500 ms a call
  assert.match(core.readAgentWorktree(w).error, /ETIMEDOUT/, 'control: the refresh read gives up on it');
  core.removeAgentWorktree(w);
  assert.equal(fs.existsSync(w.path), false, 'a clean, merged worktree is removed');
  f.state.statusMs = 60000; // past the removal's wait too
  assert.throws(() => core.removeAgentWorktree(v), /^Error: could not read the worktree before removal \(agent worktree: spawnSync git ETIMEDOUT\); nothing was removed$/);
  assert.ok(fs.existsSync(v.path), 'a worktree it could not read stays');
});

test('agent worktree: clean, dirty, ahead, behind, merged, binary and untracked changes', (t) => {
  const f = fixture(t);
  const w = core.createAgentWorktree(f.work, 'agent-x');
  assert.equal(core.readAgentWorktree(w).merged, true);
  f.state.status = ' M parser.ts\0?? extra.txt\0';
  fs.writeFileSync(path.join(w.path, 'extra.txt'), 'one\ntwo\n');
  f.state.diff = '12\t3\tparser.ts\0-\t-\timage.bin\0';
  f.state.counts = '2\t1';
  const dirty = core.readAgentWorktree(w, 1000);
  assert.deepEqual([dirty.files, dirty.added, dirty.removed, dirty.ahead, dirty.behind, dirty.merged, dirty.readMs], [3, 14, 3, 1, 2, false, 1000]);
  assert.ok(dirty.calls <= 4);
  assert.equal(typeof dirty.durationMs, 'number');
  f.state.status = ''; f.state.treeDiff = 'parser.ts\n';
  assert.equal(core.readAgentWorktree(w).merged, false);
  f.state.counts = '1\t0';
  assert.equal(core.readAgentWorktree(w).merged, true);
  t.diagnostic(`synthetic worktree read: ${dirty.calls} Git calls, ${dirty.durationMs} ms`);
});

test('agent worktree: refresh is bounded, persisted, and never probes a remote worktree', (t) => {
  const f = fixture(t);
  const w = core.createAgentWorktree(f.work, 'agent-x');
  const rec = { id: 'agent-x', kind: 'codex', state: 'done', since: 1, startedMs: 1, closedMs: null, machine: null, worktree: w };
  core.writeDelegated(rec);
  f.state.calls.length = 0;
  core.refreshDelegated({ records: [rec], now: 100000 });
  const count = f.state.calls.length;
  assert.ok(count > 0 && count <= 4);
  for (let i = 1; i < 100; i++) core.refreshDelegated({ records: [core.readDelegated(rec.id)], now: 100000 + i });
  assert.equal(f.state.calls.length, count, '100 paints, one persisted read');
  const remote = { ...rec, machine: 'build-box', worktree: { ...w, state: undefined } };
  core.refreshDelegated({ records: [remote], now: 200000 });
  assert.equal(f.state.calls.length, count);
  const there = { ...rec, worktree: { ...w, state: { files: 3, added: 120, removed: 8, merged: false } } };
  core.applyRemoteDelegated(remote, there, 'index');
  assert.equal(core.readDelegated(rec.id).worktree.state.added, 120);
  assert.equal(core.agentWorktreeSummary(remote.worktree), '3 files · +120 −8 · not merged');
});

test('agent worktree: doctor names orphaned worktrees without removing them', (t) => {
  const f = fixture(t);
  const w = core.createAgentWorktree(f.work, 'agent-x');
  f.state.list = `worktree ${f.work}\nbranch refs/heads/main\n\nworktree ${w.path}\nbranch refs/heads/oak/agent-x\n\n`;
  assert.match(core.diagnoseAgentWorktrees(f.work).fix, /oak agent close --remove-worktree agent-x/);
  core.writeDelegated({ id: 'agent-x', kind: 'codex', startedMs: 1, state: 'working', closedMs: null, worktree: w });
  assert.equal(core.diagnoseAgentWorktrees(f.work).level, 'ok');
  core.writeDelegated({ id: 'agent-x', kind: 'codex', startedMs: 1, state: 'gone', closedMs: 2, worktree: { ...w, state: { merged: true } } });
  assert.match(core.diagnoseAgentWorktrees(f.work).detail, /agent-x/);
  assert.equal(fs.existsSync(w.path), true);
  assert.ok(!f.state.calls.some(a => a[0] === 'worktree' && a[1] === 'remove'));
});

test('agent worktree: the user\'s own worktrees, on a branch or detached, are never called orphaned', (t) => {
  const f = fixture(t);
  f.state.list = `worktree ${f.work}\nbranch refs/heads/main\n\nworktree ${f.work}-feature\nbranch refs/heads/feature/x\n\n` +
    `worktree ${f.work}-scratch\nHEAD ${'a'.repeat(40)}\ndetached\n\nworktree ${f.work}-agent\nbranch refs/heads/oak/agent-y\n\n`;
  assert.deepEqual(core.orphanedAgentWorktrees(f.work).map(o => o.id), ['agent-y'], 'only the worktree OAK made, with no agent row');
});

test('agent worktree: the user\'s own worktree an agent started in is never orphaned or removed, ignored files included (review 2026-11-05)', (t) => {
  const os = require('node:os'), cp = require('node:child_process');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oak-agent-userwt-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const repo = path.join(dir, 'repo'), userwt = path.join(dir, 'userwt');
  const run = (...args) => cp.execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' });
  fs.mkdirSync(repo);
  run('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'local.env\n');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  run('add', '.'); run('commit', '-q', '-m', 'init');
  run('worktree', 'add', '-q', '-b', 'feature', userwt);
  fs.writeFileSync(path.join(userwt, 'local.env'), 'SECRET=1\n');
  // What `oak agent start` records when it starts inside a linked worktree without --worktree.
  const w = core.detectAgentWorktree(userwt);
  assert.equal(w.branch, 'feature');
  w.state = core.readAgentWorktree(w);
  assert.equal(w.state.merged, true, 'control: clean and merged, so only the branch rule protects it');
  core.writeDelegated({ id: 'a1b2', kind: 'codex', startedMs: 1, state: 'gone', closedMs: 2, worktree: w });
  assert.deepEqual(core.orphanedAgentWorktrees(repo), [], 'the user\'s worktree is not called orphaned');
  assert.throws(() => core.removeAgentWorktree(w), /not a worktree OAK made/);
  assert.ok(fs.existsSync(path.join(userwt, 'local.env')), 'its ignored files are still there');
});

test('agent start --worktree and close --remove-worktree use the recorded tree in a synthetic herdr tab', async t => {
  const f = fixture(t);
  const herdr = require('../dist/herdr');
  t.mock.method(herdr, 'herdrSnapshot', async () => ({}));
  const calls = [];
  let reads = 0;
  t.mock.method(herdr, 'herdrRequest', async (method, params) => {
    calls.push([method, params]);
    if (method === 'tab.create') return { tab: { tab_id: 't1', workspace_id: 'w1' }, root_pane: { pane_id: 'p1' } };
    if (method === 'pane.process_info') return { process_info: { pane_id: 'p1', shell_pid: 100, foreground_process_group_id: 100, foreground_processes: [{ pid: 100, name: 'sh', argv: ['sh'] }] } };
    if (method === 'pane.read') return { read: { text: reads++ === 0 ? 'Ask Codex' : 'esc to interrupt' } };
    return {};
  });
  const brief = path.join(f.dir, 'brief.md'); fs.writeFileSync(brief, '# Synthetic work\n');
  const rec = await core.startDelegatedAgent({ kind: 'codex', brief, cwd: f.work, worktree: true, name: 'agent-x', writableRoots: ['/cache'], sleep: async () => {} });
  assert.equal(calls.find(([m]) => m === 'tab.create')[1].cwd, rec.worktree.path);
  // A root-relative root is the agent's: on Windows it takes the drive of the tree it runs in, not this test's.
  assert.ok(calls.find(([m]) => m === 'agent.start')[1].args.includes(`sandbox_workspace_write.writable_roots=${JSON.stringify([path.resolve(rec.cwd, '/cache'), rec.out])}`));
  assert.equal(core.readDelegated(rec.id).worktree.path, rec.cwd);
  const closed = await core.closeDelegatedAgent(rec.id, { removeWorktree: true });
  assert.ok(closed.closedMs);
  assert.ok(closed.worktree.removedMs);
  assert.equal(fs.existsSync(rec.cwd), false);
  assert.ok(calls.some(([m]) => m === 'tab.close'));
});

test('agent start --after and --worktree: create at launch and clean up a cancelled queued start', async t => {
  for (const outcome of ['start', 'cancel before launch', 'cancel clean', 'cancel dirty']) await t.test(outcome, async t => {
    const f = fixture(t);
    const herdr = require('../dist/herdr');
    const calls = [];
    const target = path.join(f.dir, 'agent-x');
    let reads = 0;
    t.mock.method(herdr, 'herdrSnapshot', async () => ({}));
    t.mock.method(herdr, 'herdrRequest', async (method, params) => {
      calls.push([method, params]);
      if (method === 'tab.create') {
        assert.equal(params.cwd, target);
        assert.ok(fs.existsSync(target), 'the worktree exists before its tab starts');
        if (outcome.startsWith('cancel')) {
          if (outcome === 'cancel dirty') {
            fs.writeFileSync(path.join(target, 'keep.txt'), 'work in progress\n');
            f.state.status = '?? keep.txt\0';
          }
          await core.closeDelegatedAgent('agent-x');
        }
        return { tab: { tab_id: 't1', workspace_id: 'w1' }, root_pane: { pane_id: 'p1' } };
      }
      if (method === 'pane.process_info') return { process_info: require('./fake-herdr').processInfo.idle('p1') };
      if (method === 'pane.read') return { read: { text: reads++ === 0 ? 'Ask Codex' : 'esc to interrupt' } };
      return {};
    });
    const brief = path.join(f.dir, 'brief.md'); fs.writeFileSync(brief, '# Queued work\n');
    const dep = { id: 'dep', kind: 'codex', state: 'working', startedMs: 1, since: 1, closedMs: null };
    core.writeDelegated(dep);
    const queued = core.queueDelegatedAgent({ kind: 'codex', brief, cwd: f.work, worktree: true, name: 'agent-x' }, ['dep']);
    assert.deepEqual([queued.state, queued.after, queued.launch.worktree], ['queued', ['dep'], true]);
    assert.equal(core.readDelegated(queued.id).state, 'queued');
    assert.equal(queued.worktree, undefined);
    assert.equal(fs.existsSync(target), false);
    assert.ok(!f.state.calls.some(a => a[0] === 'worktree'), 'queueing only validates the repository');
    assert.deepEqual(calls, [], 'queueing does not start a tab');
    assert.equal(core.delegatedDependencies(queued, [dep]).ready, false);
    core.writeDelegated({ ...dep, state: 'done' });
    assert.equal(core.delegatedDependencies(queued, [core.readDelegated(dep.id)]).ready, true);
    f.state.head = 'b'.repeat(40); // the dependency advanced the base after this agent was queued
    if (outcome === 'cancel before launch') await core.closeDelegatedAgent(queued.id);
    const start = core.startDelegatedAgent({ ...queued.launch, sleep: async () => {} }, queued);
    if (outcome === 'start') {
      const rec = await start;
      assert.equal(rec.state, 'starting');
      assert.equal(rec.worktree.base, f.state.head, 'the launch uses the new base');
      assert.equal(core.readDelegated(rec.id).worktree.path, target);
      assert.equal(core.readDelegated(rec.id).launch, undefined);
      assert.equal(f.state.calls.filter(a => a[0] === 'worktree' && a[1] === 'add').length, 1);
      assert.equal(calls.filter(([m]) => m === 'agent.start').length, 1);
      assert.equal(calls.filter(([m]) => m === 'agent.prompt').length, 1);
    } else {
      await assert.rejects(start, /queued start cancelled/);
      const rec = core.readDelegated(queued.id);
      assert.equal(rec.state, 'gone');
      assert.ok(rec.closedMs);
      assert.equal(rec.launch, undefined);
      assert.ok(!calls.some(([m]) => m === 'agent.start' || m === 'agent.prompt'));
      assert.equal(calls.filter(([m]) => m === 'tab.close').length, outcome === 'cancel before launch' ? 0 : 1);
      assert.equal(fs.existsSync(target), outcome === 'cancel dirty');
      const removed = f.state.calls.filter(a => a[0] === 'worktree' && a[1] === 'remove');
      assert.equal(removed.length, outcome === 'cancel clean' ? 1 : 0);
      if (removed.length) assert.ok(!removed[0].includes('--force'));
      if (outcome === 'cancel dirty') assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'work in progress\n');
    }
  });
});

test('agent worktree: real read-only Git reports synthetic clean, dirty, ahead, merged and orphaned states', t => {
  const f = indexFixture(t, core);
  const g = require('./fixtures/agent-git.cjs')(f.dir);
  const w = core.detectAgentWorktree(g.tree);
  assert.equal(w.branch, 'oak/agent-x');
  assert.equal(w.base, g.initial.id);
  const clean = core.readAgentWorktree(w);
  assert.equal(clean.error, undefined);
  assert.deepEqual([clean.dirty, clean.files, clean.ahead, clean.behind, clean.merged], [false, 0, 0, 0, true]);
  fs.appendFileSync(path.join(g.tree, 'file.txt'), 'two\n');
  const dirty = core.readAgentWorktree(w);
  assert.deepEqual([dirty.dirty, dirty.files, dirty.added, dirty.removed, dirty.merged], [true, 1, 1, 0, false]);
  const next = g.commit('one\ntwo\n', g.initial.id); g.agent(next);
  const ahead = core.readAgentWorktree(w);
  assert.deepEqual([ahead.dirty, ahead.ahead, ahead.behind, ahead.merged], [false, 1, 0, false]);
  g.main(next);
  const merged = core.readAgentWorktree(w);
  assert.deepEqual([merged.ahead, merged.behind, merged.merged], [0, 0, true]);
  g.main(g.commit('one\ntwo\nthree\n', next.id));
  assert.equal(core.readAgentWorktree(w).behind, 1);
  assert.match(core.diagnoseAgentWorktrees(g.repository).detail, /agent-x/);
  assert.ok(!fs.existsSync(path.join(g.tree, '.git/index.lock')));
  t.diagnostic(`real Git reads: clean ${clean.durationMs} ms/${clean.calls} calls; dirty ${dirty.durationMs} ms/${dirty.calls} calls; ahead ${ahead.durationMs} ms/${ahead.calls} calls; merged ${merged.durationMs} ms/${merged.calls} calls`);
});

test('agent worktree: real Git creates, reads and removes an agent worktree, and deletes its merged branch', (t) => {
  const os = require('node:os'), cp = require('node:child_process');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oak-agent-wt-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const repo = path.join(dir, 'repo');
  const run = (...args) => cp.execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' });
  fs.mkdirSync(repo);
  run('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  run('add', 'a.txt'); run('commit', '-q', '-m', 'init');
  const w = core.createAgentWorktree(repo, 'agent-y');
  assert.equal(w.branch, 'oak/agent-y');
  assert.ok(fs.existsSync(path.join(w.path, 'a.txt')));
  fs.writeFileSync(path.join(w.path, 'b.txt'), 'b\n');
  w.state = core.readAgentWorktree(w);
  assert.deepEqual([w.state.dirty, w.state.files, w.state.added, w.state.merged], [true, 1, 1, false]);
  assert.equal(core.agentWorktreeSummary(w), '1 file · +1 −0 · not merged');
  assert.throws(() => core.removeAgentWorktree(w), /clean and merged/);
  assert.ok(fs.existsSync(w.path), 'a worktree with changes is never removed');
  fs.unlinkSync(path.join(w.path, 'b.txt'));
  core.removeAgentWorktree(w);
  assert.ok(!fs.existsSync(w.path));
  assert.equal(run('branch', '--list', 'oak/*').trim(), '', 'the merged agent branch goes with its worktree');
  assert.equal(run('worktree', 'list').trim().split('\n').length, 1);
});
