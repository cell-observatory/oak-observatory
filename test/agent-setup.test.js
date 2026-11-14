const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const core = require('../packages/core/dist');
const { indexFixture } = require('../packages/core/test/fixtures/index-fixture.cjs');
const cli = path.join(__dirname, '../packages/cli/dist/index.js');

function run(f, args) {
  const output = path.join(f.dir, 'stdout'), error = path.join(f.dir, 'stderr');
  const fds = [fs.openSync(output, 'w'), fs.openSync(error, 'w')];
  let r;
  try { r = cp.spawnSync(process.execPath, [cli, ...args], { cwd: f.work, env: { ...process.env, CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1' }, stdio: ['ignore', ...fds], timeout: 30000 }); }
  finally { fds.forEach(fd => fs.closeSync(fd)); }
  return { status: r.status, stdout: fs.readFileSync(output, 'utf8'), stderr: fs.readFileSync(error, 'utf8') };
}

test('agent setup CLI: opt-in plan, --yes, --check, JSON, project scope and uninstall', t => {
  const f = indexFixture(t, core);
  require('./fixtures/git.cjs').gitDir(path.join(f.work, '.git'));
  const preview = run(f, ['agent', 'setup', '--json']);
  assert.equal(preview.status, 1);
  const plan = JSON.parse(preview.stdout);
  assert.equal(fs.existsSync(plan.manifest), false);
  assert.match(plan.warnings.join(' '), /oak doctor --fix/);
  const install = run(f, ['agent', 'setup', '--yes', '--json']);
  assert.equal(install.status, 0, install.stderr);
  const checked = run(f, ['agent', 'setup', '--check', '--json']);
  assert.equal(checked.status, 0, checked.stderr);
  assert.ok(JSON.parse(checked.stdout).items.every(e => ['current', 'kept'].includes(e.state)));
  const project = run(f, ['agent', 'setup', '--project', '--yes', '--json']);
  assert.equal(project.status, 0, project.stderr);
  assert.ok(JSON.parse(project.stdout).items.every(e => e.path.startsWith(f.work + path.sep)));
  const removed = run(f, ['uninstall', '--project']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.existsSync(path.join(f.work, '.claude/skills/oak-delegate/SKILL.md')), false);
  assert.ok(fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'skills/oak-delegate/SKILL.md')));
  const all = run(f, ['uninstall']);
  assert.equal(all.status, 0, all.stderr);
  assert.equal(fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'skills/oak-delegate/SKILL.md')), false);
});

// Test the actual update and start composition without network, SSH or a running CLI session.
function commands(coreOverride = core) {
  const ts = require('typescript'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../packages/cli/src/index.ts'), 'utf8')
    .replace(/main\(\);\s*$/, 'module.exports = { applyComponents, componentPlan, cmdAgentStartBrief };');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, Buffer, Date, process,
    require: name => name === '@oak-observatory/core' ? coreOverride : require(name) });
  return module.exports;
}

test('oak update component refreshes old guidance and preserves edited blocks', async t => {
  indexFixture(t, core);
  const plan = core.agentSetupPlan();
  const old = plan.items.find(e => e.part === 'block');
  old.value = old.value.replace('independent', 'separate');
  core.applyAgentSetup(plan);
  const result = await commands().applyComponents([{ id: 'agent-setup', label: 'Agent delegation guidance', state: 'update' }]);
  assert.equal(result[0].state, 'updated');
  assert.equal(core.agentSetupPlan().items.find(e => e.part === 'block').state, 'current');
  fs.writeFileSync(old.path, fs.readFileSync(old.path, 'utf8').replace('independent', 'customized'));
  const second = await commands().applyComponents([{ id: 'agent-setup', label: 'Agent delegation guidance', state: 'update' }]);
  assert.equal(second[0].state, 'manual');
  assert.match(fs.readFileSync(old.path, 'utf8'), /customized/);
});

test('agent setup by default: oak init makes it, --remove keeps it out of init and update, setup brings it back', async t => {
  const f = indexFixture(t, core);
  const skill = path.join(process.env.CLAUDE_CONFIG_DIR, 'skills/oak-delegate/SKILL.md');
  const init = run(f, ['init', '--no-codex']);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /set up agent delegation guidance for Claude Code and Codex/);
  assert.ok(fs.existsSync(skill), 'oak init sets it up');
  const removed = run(f, ['agent', 'setup', '--remove', '--yes']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.existsSync(skill), false);
  const again = run(f, ['init', '--no-codex']);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(again.stdout, /set up agent delegation guidance/);
  assert.equal(fs.existsSync(skill), false, 'a removal stays removed through oak init');
  const row = async () => (await commands().componentPlan()).find(c => c.id === 'agent-setup');
  assert.equal(await row(), undefined, 'and through oak update');
  const back = run(f, ['agent', 'setup', '--yes']);
  assert.equal(back.status, 0, back.stderr);
  assert.ok(fs.existsSync(skill), 'oak agent setup adds it back');
  // A machine with OAK's hooks and no guidance yet (set up before this default): the update adds it.
  core.applyAgentSetup(core.agentSetupPlan({ remove: true }));
  assert.equal(fs.existsSync(skill), false);
  const planned = await row();
  assert.equal(planned.state, 'update');
  assert.match(planned.detail, /OAK sets it up by default/);
  const [applied] = await commands().applyComponents([planned]);
  assert.equal(applied.state, 'updated');
  assert.match(applied.detail, /set up by default/);
  assert.ok(fs.existsSync(skill), 'oak update sets it up');
});

test('agent start CLI passes repeatable writable roots and optional worktree base', async t => {
  const f = indexFixture(t, core);
  const brief = path.join(f.dir, 'brief.md'); fs.writeFileSync(brief, '# Synthetic work\n');
  let received;
  const cmd = commands({ ...core, delegatedDefaults: () => ({ writableRoots: ['/cache'] }),
    startDelegatedAgent: async o => { received = o; return { id: 'agent-x' }; } });
  const write = process.stdout.write;
  t.mock.method(process.stdout, 'write', () => true);
  await cmd.cmdAgentStartBrief('codex', ['--brief', brief, '--cwd', f.work, '--writable-root', '/build', '--writable-root=/extra', '--worktree', 'main', '--json']);
  assert.deepEqual(Array.from(received.writableRoots), ['/cache', '/build', '/extra']);
  assert.equal(received.worktree, 'main');
  await cmd.cmdAgentStartBrief('codex', ['--brief', brief, '--cwd', f.work, '--worktree', '--json']);
  assert.equal(received.worktree, true);
  process.stdout.write = write;
});

test('agent setup terminal: list destinations before confirmation, decline safely, ask defaults only once', async t => {
  const f = indexFixture(t, core);
  const ts = require('typescript'), vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../packages/cli/src/agent-setup.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  let answer = 'n', transcript = '', questions = [];
  const manifest = core.agentSetupPlan().manifest;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, process: { cwd: () => f.work, stdin: { isTTY: true }, stdout: { isTTY: true, write: s => { transcript += s; } } },
    require: name => name === '@oak-observatory/core' ? { ...core, findHerdrBin: () => null } : name === 'node:readline/promises' ? {
      createInterface: () => ({ close() {}, async question(q) {
        questions.push(q);
        if (q.includes('listed OAK content')) {
          for (const e of core.agentSetupPlan().items) assert.ok(transcript.includes(e.path), 'the user sees each destination before consent');
          return answer;
        }
        return '';
      } }),
    } : require(name) });
  await module.exports.cmdAgentSetup([]);
  assert.equal(fs.existsSync(manifest), false);
  assert.ok(questions.some(q => q.startsWith('codex effort')));
  answer = 'yes'; questions = []; transcript = '';
  await module.exports.cmdAgentSetup([]);
  assert.ok(fs.existsSync(manifest));
  questions = []; transcript = '';
  await module.exports.cmdAgentSetup([]);
  assert.equal(questions.length, 1, 'only the final write confirmation remains after defaults were saved');
});
