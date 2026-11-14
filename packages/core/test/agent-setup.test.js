const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../dist');
const { indexFixture } = require('./fixtures/index-fixture.cjs');

test('agent setup: exact plan, idempotence, documented permission, defaults and surgical removal', (t) => {
  const f = indexFixture(t, core);
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ model: 'synthetic-model', effortLevel: 'high', permissions: { allow: ['Read'] } }));
  fs.mkdirSync(process.env.CODEX_HOME);
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'AGENTS.md'), '# User rules\n');
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'model = "synthetic-codex"\nmodel_reasoning_effort = "medium"\n');
  const plan = core.agentSetupPlan();
  assert.deepEqual([...new Set(plan.items.map(x => x.path))].sort(), [
    path.join(cfg, 'skills/oak-delegate/SKILL.md'), path.join(cfg, 'agents/oak-builder.md'),
    path.join(cfg, 'settings.json'), core.prefsPath(), path.join(process.env.CODEX_HOME, 'AGENTS.md'),
  ].sort());
  assert.equal(fs.existsSync(plan.manifest), false, 'planning never writes');
  core.applyAgentSetup(plan);
  assert.equal(core.agentSetupPlan().items.every(x => x.state === 'current'), true);
  const paths = [...new Set([...plan.items.map(x => x.path), plan.manifest])];
  const before = paths.map(p => [p, fs.readFileSync(p, 'utf8'), fs.statSync(p).mtimeMs]);
  core.applyAgentSetup(core.agentSetupPlan());
  assert.deepEqual(paths.map(p => [p, fs.readFileSync(p, 'utf8'), fs.statSync(p).mtimeMs]), before);
  const settings = JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json')));
  assert.deepEqual(settings.permissions.allow, ['Read', 'Bash(oak agent:*)']);
  assert.deepEqual(core.readPrefs().agents.claude, { model: 'synthetic-model', effort: 'high', agentType: 'oak-builder' });
  assert.equal(core.readPrefs().agents.codex.model, 'synthetic-codex');
  assert.match(fs.readFileSync(path.join(cfg, 'agents/oak-builder.md'), 'utf8'), /disallowedTools: Agent/);
  core.applyAgentSetup(core.agentSetupPlan({ remove: true }));
  assert.equal(fs.readFileSync(path.join(process.env.CODEX_HOME, 'AGENTS.md'), 'utf8'), '# User rules\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'))), { model: 'synthetic-model', effortLevel: 'high', permissions: { allow: ['Read'] } });
  assert.equal(fs.existsSync(path.join(cfg, 'skills/oak-delegate/SKILL.md')), false);
  assert.equal(core.readPrefs().agents, undefined);
});

test('agent setup: refresh an older managed block, preserve a user edit and report it', (t) => {
  indexFixture(t, core);
  const plan = core.agentSetupPlan();
  const old = plan.items.find(x => x.part === 'block');
  old.value = old.value.replace('independent', 'separate');
  core.applyAgentSetup(plan);
  assert.equal(core.agentSetupPlan().items.find(x => x.part === 'block').state, 'outdated');
  core.refreshAgentSetup();
  assert.equal(core.agentSetupPlan().items.find(x => x.part === 'block').state, 'current');
  fs.appendFileSync(old.path, '\nUser ending\n');
  fs.writeFileSync(old.path, fs.readFileSync(old.path, 'utf8').replace('independent', 'customized'));
  const edited = fs.readFileSync(old.path, 'utf8');
  assert.equal(core.agentSetupPlan().items.find(x => x.part === 'block').state, 'edited');
  core.refreshAgentSetup();
  core.applyAgentSetup(core.agentSetupPlan({ remove: true }));
  assert.equal(fs.readFileSync(old.path, 'utf8'), edited);
});

test('agent setup: project files stay in the repository and keep an existing builder preference', (t) => {
  const f = indexFixture(t, core);
  require('../../../test/fixtures/git.cjs').gitDir(path.join(f.work, '.git'));
  const plan = core.agentSetupPlan({ project: f.work });
  assert.ok(plan.items.every(x => x.path.startsWith(f.work + path.sep)));
  core.applyAgentSetup(plan);
  assert.ok(fs.existsSync(path.join(f.work, 'AGENTS.md')));
  assert.equal(core.delegatedDefaults('claude', f.work).agentType, 'oak-builder');
  core.writePrefs({ agents: { claude: { agentType: 'my-builder' } } });
  core.applyAgentSetup(core.agentSetupPlan());
  assert.equal(core.readPrefs().agents.claude.agentType, 'my-builder');
  assert.equal(core.diagnoseAgentSetup(f.work).level, 'ok');
});

test('agent setup: doctor suggests setup and the terminal suggestion appears once', (t) => {
  indexFixture(t, core);
  const check = core.diagnoseAgentSetup();
  assert.equal(check.id, 'agent-setup');
  assert.equal(check.level, 'warn');
  assert.match(check.fix, /oak agent setup/);
  assert.match(core.takeAgentSetupNotice(), /oak agent setup/);
  assert.equal(core.takeAgentSetupNotice(), null);
});

test('agent setup: the user setup is made by default once, and a removal keeps it out until it is set up again', (t) => {
  indexFixture(t, core);
  const skill = path.join(process.env.CLAUDE_CONFIG_DIR, 'skills/oak-delegate/SKILL.md');
  assert.equal(core.defaultAgentSetupPending(), true);
  const made = core.applyDefaultAgentSetup();
  assert.ok(made && fs.existsSync(made.manifest) && fs.existsSync(skill));
  assert.equal(core.applyDefaultAgentSetup(), null, 'once made, the default leaves it to refresh');
  // `oak agent setup --remove`: the content goes, and the removal is remembered.
  core.applyAgentSetup(core.agentSetupPlan({ remove: true }));
  core.setAgentSetupDeclined(true);
  assert.equal(fs.existsSync(skill), false);
  assert.equal(core.defaultAgentSetupPending(), false);
  assert.equal(core.applyDefaultAgentSetup(), null, 'a removal stays removed');
  assert.equal(fs.existsSync(skill), false);
  const check = core.diagnoseAgentSetup();
  assert.equal(check.level, 'ok');
  assert.match(check.detail, /Removed with oak agent setup --remove/);
  assert.equal(core.takeAgentSetupNotice(), null, 'no suggestion after a removal');
  // `oak agent setup`: set up again, and the default is back in force.
  core.setAgentSetupDeclined(false);
  assert.equal(core.defaultAgentSetupPending(), true);
});

// An agent kind that names an Object.prototype member reached a shared object: `__proto__` wrote into Object.prototype,
// and `constructor` deleted from the global Object.
test('agent setup: a plan never writes into or deletes from shared objects', (t) => {
  indexFixture(t, core);
  Object.oakProbe = 'kept';
  t.after(() => { delete Object.prototype.oakPolluted; delete Object.oakProbe; });
  const plan = core.agentSetupPlan({ defaults: JSON.parse('{"__proto__":{"oakPolluted":true}}') });
  assert.throws(() => core.applyAgentSetup(plan), /__proto__\.oakPolluted is not an agent setting/);
  assert.equal({}.oakPolluted, undefined);
  fs.mkdirSync(path.dirname(core.prefsPath()), { recursive: true });
  fs.writeFileSync(core.prefsPath(), '{"agents":{}}');
  const remove = { path: core.prefsPath(), part: 'constructor.oakProbe', value: null, before: null, created: false, observed: '"kept"', state: 'outdated' };
  assert.throws(() => core.applyAgentSetup({ manifest: plan.manifest, remove: false, items: [remove] }), /constructor\.oakProbe is not an agent setting/);
  assert.equal(Object.oakProbe, 'kept');
});

test('agent start: Codex receives all writable roots and always its output folder', () => {
  const args = core.delegatedArgs('codex', { cwd: '/repo', out: '/output', writableRoots: ['/cache', '/cache', '/build'] });
  assert.ok(args.includes(`sandbox_workspace_write.writable_roots=${JSON.stringify(['/cache', '/build', '/output'].map(p => path.resolve(p)))}`));
});
