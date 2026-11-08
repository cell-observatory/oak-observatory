// Synthetic sessions shared by the three dashboard tests. SSH executes only in the private remote home.
const fs = require('node:fs');
const path = require('node:path');
const cli = path.resolve(__dirname, '../../packages/cli/dist/index.js');
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
function processDashboard(dir, count = 1000, localWork) {
  const write = (file, text, mode) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, mode ? { mode } : undefined); return file; };
  const lines = records => records.map(r => JSON.stringify(r)).join('\n') + '\n';
  const homes = {};
  for (const side of ['local', 'remote']) {
    const home = path.join(dir, side), work = side === 'local' && localWork ? localWork : path.join(home, 'work');
    fs.mkdirSync(work, { recursive: true });
    const project = path.join(home, '.claude/projects', work.replace(/[^a-zA-Z0-9]/g, '-'));
    const records = [], worker = [];
    for (let i = 0; i < count; i++) {
      const output = write(path.join(home, `shell-${i}.output`), `${side.toUpperCase()} OUTPUT ${i}\n`);
      const target = i === count - 1 ? worker : records;
      target.push(
        { type: 'assistant', cwd: work, sessionId: 'parent', timestamp: '2026-10-01T10:00:00Z', message: { role: 'assistant', content: [
          { type: 'tool_use', id: `tool-${i}`, name: 'Bash', input: { command: `${side}-build-${i}`, description: `${side} build ${i}`, run_in_background: true } }] } },
        { type: 'user', cwd: work, timestamp: '2026-10-01T10:00:01Z', toolUseResult: { backgroundTaskId: `shell-${i}` }, message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: `tool-${i}`, content: `Output is being written to: ${output}` }] } },
      );
      if (i >= 2) target.push({ type: 'queue-operation', timestamp: '2026-10-01T10:01:00Z',
        content: `<task-notification><task-id>shell-${i}</task-id><status>completed</status><summary>exit code 0</summary></task-notification>` });
    }
    write(path.join(project, 'parent.jsonl'), lines(records));
    write(path.join(project, 'parent/subagents/agent-worker.jsonl'), lines(worker.map(r => ({ ...r, isSidechain: true }))));
    write(path.join(project, 'empty.jsonl'), lines([{ type: 'assistant', cwd: work, sessionId: 'empty', message: { role: 'assistant', content: [] } }]));
    const stamp = { timestamp: '2026-10-01T10:00:00Z' };
    write(path.join(home, '.codex/sessions/2026/10/01/rollout-codex-shell.jsonl'), lines([
      { ...stamp, type: 'session_meta', payload: { id: 'codex-shell', cwd: work } },
      { ...stamp, type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'exec-1', arguments: JSON.stringify({ cmd: `${side}-codex` }) } },
      { ...stamp, type: 'response_item', payload: { type: 'function_call_output', call_id: 'exec-1', output: `Process running with session ID 123\nOutput:\n${side.toUpperCase()} CODEX\n` } },
    ]));
    write(path.join(home, '.local/bin/oak'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`, 0o755);
    homes[side] = { home, work, output: path.join(home, 'shell-0.output') };
  }
  const bin = path.join(dir, 'bin'), log = path.join(dir, 'ssh.log'), calls = path.join(dir, 'calls.log');
  const stub = fs.readFileSync(path.join(__dirname, 'machine-exec-stub.sh'));
  for (const name of ['ssh', 'herdr']) write(path.join(bin, name), stub, 0o755);
  const env = { HOME: homes.local.home, USERPROFILE: homes.local.home, CLAUDE_CONFIG_DIR: path.join(homes.local.home, '.claude'),
    CODEX_HOME: path.join(homes.local.home, '.codex'), FAKE_REMOTE_HOME: homes.remote.home, MACHINE_EXEC_LOG: log,
    HERDR_SOCKET_PATH: path.join(dir, 'no-herdr.sock'), OAK_NO_BACKGROUND: '1', CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1' };
  const oak = write(path.join(bin, 'oak'), '#!/bin/sh\n' + Object.entries(env).map(([k, v]) => `export ${k}=${quote(v)}\n`).join('') +
    `export PATH=${quote(bin)}:"$PATH"\nprintf '%s | %s\\n' "$*" "$OAK_MACHINE_TIMEOUT_MS" >> ${quote(calls)}\nexec ${quote(process.execPath)} ${quote(cli)} "$@"\n`, 0o755);
  return { ...homes, oak, log, calls, count, env: { ...process.env, ...env, PATH: bin + path.delimiter + process.env.PATH } };
}
module.exports = { processDashboard };
if (require.main === module) process.stdout.write(JSON.stringify(processDashboard(path.resolve(process.argv[2]), 1000, process.argv[3])));
