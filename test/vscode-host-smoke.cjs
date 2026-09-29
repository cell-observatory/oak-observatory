/** Optional real VS Code extension-host check. Launch with --extensionTestsPath pointing here,
 * an isolated user-data directory, CODEX_HOME/CLAUDE_CONFIG_DIR, and a scratch workspace. */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
exports.run = async function () {
  const vscode = require('vscode');
  const core = require('../packages/core/dist');
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(cwd && process.env.OAK_HOST_SMOKE === '1', 'run only in the isolated smoke-test launcher');
  const session = 'oak-host-codex-fixture';
  const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '09', '09');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rollout-host.jsonl'), [
    { type: 'session_meta', payload: { id: session, cwd, model_provider: 'openai' } },
    { type: 'turn_context', payload: { model: 'gpt-5.2', turn_id: 'host-turn' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Review the fixture', turn_id: 'host-turn' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Fixture response', turn_id: 'host-turn' } },
  ].map(o => JSON.stringify({ timestamp: new Date().toISOString(), ...o })).join('\n') + '\n');
  await vscode.workspace.getConfiguration('claudeObservatory').update('session', session, vscode.ConfigurationTarget.Workspace);
  const extension = vscode.extensions.getExtension('cell-observatory.oak-observatory-vscode');
  assert.ok(extension, 'development extension discovered');
  await extension.activate();
  assert.equal(extension.isActive, true);
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['claudeObservatory.refresh', 'claudeObservatory.stats.focus']) assert.ok(commands.includes(command), command);
  await vscode.commands.executeCommand('claudeObservatory.refresh');
  await vscode.commands.executeCommand('claudeObservatory.stats.focus');
  assert.equal(core.resolveSessionId(cwd), session);
  assert.equal(core.describeSession(session).runtime, 'codex');
  assert.match(JSON.stringify(core.liveFeed(cwd, session, { kind: 'session', id: session })), /Fixture response/);
  console.log(`OAK extension host ${vscode.version}: activation, native Codex resolution, refresh, Stats view and feed passed.`);
};
