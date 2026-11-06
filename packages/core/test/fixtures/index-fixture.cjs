// Fixtures for the local index's tests: a private HOME, Claude config and Codex home, and writers for the files the index
// reads (Claude transcripts, Codex rollouts, OAK store sessions).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function indexFixture(t, core) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oak-index-')));
  const old = { ...process.env };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, '.claude');
  process.env.CODEX_HOME = path.join(dir, '.codex');
  delete process.env.OAK_INDEX;
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  core.clearRootMemo();
  core.clearFsCache();
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k];
    Object.assign(process.env, old);
    core.clearRootMemo();
    core.clearFsCache();
    core.resetIndexRuntime();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const lines = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const write = (file, records) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines(records));
    return file;
  };
  /** A Claude transcript in the project folder of `folder` (default: its cwd). */
  const claude = (id, cwd, records, folder = cwd) => write(path.join(core.projectDir(folder), `${id}.jsonl`), records.map((r) => ({ cwd, sessionId: id, ...r })));
  const rollout = (id, cwd, records, extra = {}, day = '2026/10/01') =>
    write(path.join(process.env.CODEX_HOME, 'sessions', day, `rollout-2026-10-01T10-00-00-${id}.jsonl`), [
      { type: 'session_meta', timestamp: '2026-10-01T10:00:00Z', payload: { id, cwd, ...extra } },
      ...records,
    ]);
  /** An OAK store session with edits: [file, before, after, ts, status?]. */
  const store = (id, cwd, edits) => {
    core.ensureStore(id);
    for (const [f, b, a, ts, status] of edits) {
      core.appendLog(id, { ts, tool: 'Edit', file: path.join(cwd, f), beforeBlob: b === null ? null : core.writeBlob(id, Buffer.from(b)), afterBlob: a === null ? null : core.writeBlob(id, Buffer.from(a)), status: status ?? 'pending' });
    }
  };
  return { dir, work, write, claude, rollout, store, lines };
}

let n = 0;
const at = (s) => `2026-10-01T10:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000Z`;
const ask = (text, s = n++) => ({ type: 'user', timestamp: at(s % 3600), message: { role: 'user', content: text } });
const reply = (id, blocks, s = n++, usage = { input_tokens: 100, output_tokens: 20 }) => ({
  type: 'assistant', timestamp: at(s % 3600), message: { id, role: 'assistant', model: 'claude-opus-4-8', content: blocks, usage },
});
const text = (t) => ({ type: 'text', text: t });
const thinking = (t) => ({ type: 'thinking', thinking: t });
const cxUser = (t) => ({ type: 'response_item', timestamp: '2026-10-01T10:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] } });

module.exports = { indexFixture, ask, reply, text, thinking, cxUser };
