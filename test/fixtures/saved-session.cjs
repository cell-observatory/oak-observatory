// A synthetic Claude session for the saved-machine read tests, written into $HOME as that machine holds it:
// a repository (git's marker files only), the transcript, each background worker's transcript, and the store's
// edit records with their blobs. Each worker edits a file of its own, so the store attributes its edits to it.
// Usage: HOME=<machine home> node saved-session.cjs <repo root> <session> <workers> <main-chain edits>
// (transcripts go under $CLAUDE_CONFIG_DIR when it is set, else $HOME/.claude).
// Prints {work, transcript}. Nothing in it comes from a real session.
'use strict';
const fs = require('fs'), path = require('path');
const [REPO, SESSION, WORKERS, EDITS] = process.argv.slice(2);
const core = require(path.join(REPO, 'packages/core/dist'));
const home = process.env.HOME, work = path.join(home, 'work');
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
const proj = path.join(claudeDir, 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'));
const subDir = path.join(proj, SESSION, 'subagents');
for (const d of [path.join(work, '.git/objects'), path.join(work, '.git/refs/heads'), subDir]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(work, '.git/HEAD'), 'ref: refs/heads/main\n');
const now = Date.now(), t0 = now - 2 * 3600_000, iso = (ms) => new Date(ms).toISOString();
let n = 0; const id = (p) => `${p}_${String(++n).padStart(8, '0')}`;
const usage = { input_tokens: 40, output_tokens: 120, cache_read_input_tokens: 9000, cache_creation_input_tokens: 300 };
const line = (o) => ({ sessionId: SESSION, cwd: work, uuid: id('u'), version: '2.1.200', ...o });
const asst = (ts, content, extra = {}) => line({ type: 'assistant', timestamp: iso(ts), ...extra, message: { role: 'assistant', id: id('msg'), model: 'claude-opus-4-1', content, usage } });
const user = (ts, content, extra = {}) => line({ type: 'user', timestamp: iso(ts), ...extra, message: { role: 'user', content } });
const todos = (ts, list, extra) => asst(ts, [{ type: 'tool_use', id: id('toolu'), name: 'TodoWrite', input: { todos: list } }], extra);
const records = [];
/** An Edit call and its result, and the store record it left: `k` lines changed. */
function edit(out, ts, file, k, extra = {}) {
  const tu = id('toolu');
  out.push(asst(ts, [{ type: 'tool_use', id: tu, name: 'Edit', input: { file_path: file, old_string: 'old', new_string: 'new' } }], extra));
  out.push(user(ts + 200, [{ type: 'tool_result', tool_use_id: tu, content: `The file ${file} has been updated.` }], { toolUseResult: { filePath: file }, ...extra }));
  const body = (word) => Array.from({ length: 6 }, (_, i) => i < k ? `${word} ${records.length} ${i}` : `same ${i}`).join('\n') + '\n';
  records.push({ ts: ts + 100, file, toolCallId: tu, before: body('old'), after: body('new') });
}
const main = [user(t0, 'Build the fixture feature; fan out to workers.')];
let t = t0 + 1000;
for (let w = 0; w < Number(WORKERS); w++, t += 60_000) {
  const agentId = `a${String(w).padStart(16, '0')}`, tu = id('toolu'), type = w % 2 ? 'builder' : 'reviewer';
  main.push(asst(t, [{ type: 'tool_use', id: tu, name: 'Agent', input: { description: `Worker ${w}: part ${w}`, subagent_type: type, prompt: `Do part ${w}`, run_in_background: true } }]));
  main.push(user(t + 100, [{ type: 'tool_result', tool_use_id: tu, content: 'Async agent launched successfully.' }], { toolUseResult: { agentId, status: 'async_launched', agentType: type } }));
  const side = { isSidechain: true, agentId }, out = [user(t + 1000, `Do part ${w}`, side)];
  out.push(todos(t + 2000, [{ content: `Read part ${w}`, status: 'completed' }, { content: `Change part ${w}`, status: 'in_progress' }], side));
  for (let e = 0; e < 2; e++) edit(out, t + 10_000 + e * 10_000, path.join(work, `worker-${w}.ts`), e + 1, side);
  out.push(asst(t + 40_000, [{ type: 'text', text: `Worker ${w} done.` }], side));
  const file = path.join(subDir, `agent-${agentId}.jsonl`);
  fs.writeFileSync(file, out.map((o) => JSON.stringify(o)).join('\n') + '\n');
  fs.utimesSync(file, new Date(t + 40_000), new Date(t + 40_000));
  main.push({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(t + 45_000), sessionId: SESSION,
    content: `<task-notification>\n<task-id>${agentId}</task-id>\n<status>completed</status>\n<summary>Agent "Worker ${w}" completed</summary>\n<result>done</result>\n</task-notification>` });
}
for (let e = 0; e < Number(EDITS); e++, t += 30_000) edit(main, t, path.join(work, `main-${e % 5}.ts`), 1 + (e % 3));
main.push(todos(t, [{ content: 'Fan out workers', status: 'completed' }, { content: 'Merge results', status: 'in_progress' }]));
main.push(asst(t + 1000, [{ type: 'text', text: 'Merging the workers\' results now.' }]));
main.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
const transcript = path.join(proj, `${SESSION}.jsonl`);
fs.writeFileSync(transcript, main.map((o) => JSON.stringify(o)).join('\n') + '\n');
fs.utimesSync(transcript, new Date(t + 1000), new Date(t + 1000));
core.ensureStore(SESSION);
for (const r of records.sort((a, b) => a.ts - b.ts)) {
  core.appendLog(SESSION, { ts: r.ts, tool: 'Edit', file: r.file, status: 'pending', toolCallId: r.toolCallId,
    beforeBlob: core.writeBlob(SESSION, Buffer.from(r.before)), afterBlob: core.writeBlob(SESSION, Buffer.from(r.after)) });
}
process.stdout.write(JSON.stringify({ work, transcript }));
