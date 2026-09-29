/* Transcript-to-conversation contract tests. Fixtures are copied into isolated homes; no real
 * Claude/Codex files are read or written. Requires built core + CLI dist, like core.test.js. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('../dist');
const CLI = path.resolve(__dirname, '../../cli/dist/index.js');
const FIXTURES = path.join(__dirname, 'fixtures');
const { workspaceFixture } = require('./fixtures/workspace-fixture.cjs');

function fresh() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-conversation-'));
  process.env.CLAUDE_CONFIG_DIR = path.join(base, 'claude');
  process.env.CODEX_HOME = path.join(base, 'codex');
  process.env.HOME = base;
  process.env.USERPROFILE = base;
  const cwd = path.join(base, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  return { base, cwd };
}

function fixture(name, cwd) {
  return workspaceFixture(name, cwd);
}

function claudeTranscript(cwd, text, session = 'claude-conversation') {
  const dir = core.projectDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${session}.jsonl`);
  fs.writeFileSync(file, text);
  return file;
}

function codexRollout(cwd, text, session = 'codex-conversation') {
  const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '09', '18');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-18T15-00-00-${session}.jsonl`);
  fs.writeFileSync(file, text);
  return file;
}

function seedEdit(session, file, ts, tool = 'Edit') {
  core.ensureStore(session);
  const beforeBlob = core.writeBlob(session, Buffer.from('old'));
  const afterBlob = core.writeBlob(session, Buffer.from('new'));
  return core.appendLog(session, { ts, tool, file, beforeBlob, afterBlob, status: 'pending' });
}

function updates(result, kind) {
  return result.events.filter((e) => e.update.sessionUpdate === kind).map((e) => e.update);
}

function rows(cwd) {
  const start = Date.parse('2026-09-18T14:00:00Z');
  const row = (ms, message) => ({ cwd, timestamp: new Date(start + ms).toISOString(), message });
  return {
    start,
    prompt: (ms, content = 'fixture prompt') => row(ms, { role: 'user', content }),
    answer: (ms, text = 'fixture answer') => row(ms, { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' }),
    tool: (ms, id, name, input) => row(ms, { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }),
    result: (ms, id) => row(ms, { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] }),
    jsonl: values => values.map(value => JSON.stringify(value)).join('\n') + '\n',
  };
}

test('conversation regression: non-object complete records are skipped and cursors advance in full reads and tails', () => {
  const { cwd } = fresh();
  const r = rows(cwd), session = 'nonobject-records';
  const file = claudeTranscript(cwd, r.jsonl([r.prompt(0)]), session);
  const first = core.conversationEvents(session, { root: cwd });
  fs.appendFileSync(file, r.jsonl([null, [], 42, true, 'text', r.tool(500, 'edit-1', 'Edit', { file_path: path.join(cwd, 'demo.ts') }), r.result(1000, 'edit-1'), r.answer(2000)]));
  const full = core.conversationEvents(session, { root: cwd });
  assert.equal(full.events.length, 5);
  assert.equal(core.parseTranscriptActions(file).length, 1);
  const tail = core.conversationTail(session, first.cursor);
  assert.deepEqual([...first.events, ...tail.events], full.events);
  assert.equal(tail.cursor, fs.statSync(file).size);
  assert.deepEqual(core.conversationTail(session, tail.cursor).events, []);
});

test('conversation regression: completion bounds edits to its own turn for Claude and Codex completion records', () => {
  for (const kind of ['claude', 'codex']) {
    const { cwd } = fresh();
    const r = rows(cwd), session = `edit-windows-${kind}`;
    const completion = ms => kind === 'claude' ? r.answer(ms) : { cwd, timestamp: new Date(r.start + ms).toISOString(), subtype: 'task_complete' };
    claudeTranscript(cwd, r.jsonl([r.prompt(0), completion(2000), r.prompt(3000), completion(5000)]), session);
    seedEdit(session, path.join(cwd, 'first.ts'), r.start + 1000);
    seedEdit(session, path.join(cwd, 'second.ts'), r.start + 4000);
    assert.deepEqual(updates(core.conversationEvents(session, { root: cwd }), 'turn_end').map(end => end.edits), [1, 1]);
  }
});

test('conversation regression: prompt then tail then completion emits one turn_end with the right edits', () => {
  const { cwd } = fresh();
  const r = rows(cwd), session = 'split-completion';
  const file = claudeTranscript(cwd, r.jsonl([r.prompt(0)]), session);
  const first = core.conversationEvents(session, { root: cwd });
  assert.equal(typeof first.cursor, 'number', 'all three consumers compare byte offsets numerically');
  seedEdit(session, path.join(cwd, 'first.ts'), r.start + 1000);
  fs.appendFileSync(file, r.jsonl([r.answer(2000)]));
  const tail = core.conversationTail(session, first.cursor);
  assert.deepEqual(tail.events.map(e => e.update.sessionUpdate), ['agent_message_chunk', 'turn_end']);
  assert.equal(updates(tail, 'turn_end')[0].edits, 1);
  assert.equal(tail.turns, 0, 'a continuing turn does not increment editor turn counts');
  assert.deepEqual([...first.events, ...tail.events], core.conversationEvents(session, { root: cwd }).events);
  assert.deepEqual(core.conversationEvents(session, { root: cwd, since: first.cursor }), tail, 'CLI since uses the same stateless continuation');
  assert.deepEqual(core.conversationTail(session, tail.cursor).events, []);
});

test('conversation regression: split tools and plans rebuild state without replay or timestamp deduplication', () => {
  const { cwd } = fresh();
  const r = rows(cwd), session = 'split-tools';
  const file = claudeTranscript(cwd, r.jsonl([r.prompt(0), r.tool(1000, 'read-1', 'Read', { file_path: path.join(cwd, 'read.ts') }), r.tool(1000, 'plan-1', 'TodoWrite', { todos: [{ content: 'check', status: 'in_progress', activeForm: 'checking' }] })]), session);
  const first = core.conversationEvents(session, { root: cwd });
  fs.appendFileSync(file, r.jsonl([r.result(1000, 'read-1'), r.result(1000, 'plan-1')]));
  const tools = core.conversationTail(session, first.cursor);
  assert.deepEqual(tools.events.map(e => e.update.sessionUpdate), ['tool_call_update']);
  assert.equal(tools.events[0].update.kind, 'read');
  assert.equal(tools.turns, 0);
  fs.appendFileSync(file, r.jsonl([r.answer(2000)]));
  const end = core.conversationTail(session, tools.cursor);
  assert.equal(updates(end, 'turn_end').length, 1);
  assert.deepEqual([...first.events, ...tools.events, ...end.events], core.conversationEvents(session, { root: cwd }).events);
});

test('conversation regression: tail context crosses buffer boundaries and ignores torn UTF-8 records', () => {
  const { cwd } = fresh();
  const r = rows(cwd), session = 'large-turn';
  const file = claudeTranscript(cwd, r.jsonl([r.prompt(0), { ignored: 'x'.repeat(140000) }, null]), session);
  const first = core.conversationEvents(session, { root: cwd });
  const answer = Buffer.from(r.jsonl([r.answer(2000, '猫😀')]));
  fs.appendFileSync(file, answer.subarray(0, answer.length - 2));
  assert.deepEqual(core.conversationTail(session, first.cursor).events, []);
  fs.appendFileSync(file, answer.subarray(answer.length - 2));
  const tail = core.conversationTail(session, first.cursor);
  assert.equal(updates(tail, 'agent_message_chunk')[0].content.text, '猫😀');
  assert.equal(updates(tail, 'turn_end').length, 1);
  assert.equal(tail.cursor, fs.statSync(file).size);
});

test('conversation regression: Codex final message stays active until the appended task_complete', () => {
  const { cwd } = fresh();
  const session = 'codex-conversation';
  const lines = fixture('conversation-codex.jsonl', cwd).trim().split('\n');
  const file = codexRollout(cwd, lines.slice(0, 11).join('\n') + '\n', session);
  seedEdit(session, path.join(cwd, 'codex.ts'), Date.parse('2026-09-18T15:00:04.500Z'), 'apply_patch');
  const first = core.conversationEvents(session, { root: cwd });
  assert.equal(updates(first, 'agent_message_chunk').length, 1);
  assert.equal(updates(first, 'turn_end').length, 0, 'Codex has an explicit completion record');
  fs.appendFileSync(file, lines[11] + '\n');
  const tail = core.conversationTail(session, first.cursor);
  assert.equal(updates(tail, 'turn_end').length, 1);
  assert.equal(updates(tail, 'turn_end')[0].edits, 1);
  assert.equal(updates(tail, 'turn_end')[0].ts, Date.parse('2026-09-18T15:00:10.000Z'));
  assert.deepEqual([...first.events, ...tail.events], core.conversationEvents(session, { root: cwd }).events);
});

test('conversation regression: an inferred Claude completion is not replayed when another prompt arrives', () => {
  const { cwd } = fresh();
  const r = rows(cwd), session = 'inferred-completion';
  const answer = r.answer(2000);
  delete answer.message.stop_reason;
  const file = claudeTranscript(cwd, r.jsonl([r.prompt(0), answer]), session);
  const first = core.conversationEvents(session, { root: cwd });
  assert.equal(updates(first, 'turn_end').length, 1);
  fs.appendFileSync(file, r.jsonl([null, r.prompt(3000)]));
  const tail = core.conversationTail(session, first.cursor);
  assert.deepEqual(tail.events.map(e => e.update.sessionUpdate), ['user_prompt']);
  assert.equal(tail.turns, 1);
});

test('conversation regression: a new prompt finishes the previous unfinished window across a cursor', () => {
  const { cwd } = fresh();
  const r = rows(cwd), session = 'next-prompt-boundary';
  const file = claudeTranscript(cwd, r.jsonl([r.prompt(0)]), session);
  const first = core.conversationEvents(session, { root: cwd });
  seedEdit(session, path.join(cwd, 'first.ts'), r.start + 1000);
  seedEdit(session, path.join(cwd, 'second.ts'), r.start + 3000);
  fs.appendFileSync(file, r.jsonl([r.prompt(3000), r.answer(5000)]));
  const tail = core.conversationTail(session, first.cursor);
  assert.deepEqual(updates(tail, 'turn_end').map(end => end.edits), [1, 1]);
  assert.equal(tail.turns, 1);
});

test('conversation: Claude transcript maps exactly to renderer updates, store records and permission history', () => {
  const { cwd } = fresh();
  const session = 'claude-conversation';
  claudeTranscript(cwd, fixture('conversation-claude.jsonl', cwd), session);
  seedEdit(session, path.join(cwd, 'demo.ts'), Date.parse('2026-09-18T14:00:01.500Z'));
  fs.copyFileSync(path.join(FIXTURES, 'conversation-permissions.jsonl'), core.captureEventsPath(session));

  const result = core.conversationEvents(session, { root: cwd });
  assert.equal(result.agent, 'claude');
  assert.equal(result.turns, 2);
  const lastPrompt = result.events.findLastIndex(e => e.update.sessionUpdate === 'user_prompt');
  assert.deepEqual(core.conversationEvents(session, { root: cwd, limit: 1 }).events, result.events.slice(lastPrompt));
  assert.equal(result.cursor, fs.statSync(result.transcriptPath).size);
  assert.deepEqual(updates(result, 'user_prompt'), [
    { sessionUpdate: 'user_prompt', content: { type: 'text', text: 'Fix the demo and make a plan.' }, promptId: 'claude-prompt-1' },
    { sessionUpdate: 'user_prompt', content: { type: 'text', text: 'Run the focused tests.' }, promptId: 'claude-prompt-2' },
  ]);
  assert.deepEqual(updates(result, 'agent_thought_chunk'), [
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspecting the demo carefully.' } },
  ]);
  assert.deepEqual(updates(result, 'agent_message_chunk'), [
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The first turn is complete.' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'All focused tests pass.' } },
  ]);
  assert.deepEqual(updates(result, 'plan'), [{
    sessionUpdate: 'plan',
    entries: [
      { content: 'Edit the demo', priority: 'medium', status: 'completed' },
      { content: 'Run checks', priority: 'medium', status: 'in_progress' },
      { content: 'Report back', priority: 'medium', status: 'pending' },
    ],
  }]);
  const edit = result.events.find((e) => e.update.sessionUpdate === 'tool_call' && e.update.toolCallId === 'claude-edit-1').update;
  assert.deepEqual(edit, {
    sessionUpdate: 'tool_call', toolCallId: 'claude-edit-1', title: `Edit ${path.join(cwd, 'demo.ts')}`,
    kind: 'edit', status: 'pending',
    rawInput: { file_path: path.join(cwd, 'demo.ts'), old_string: 'old', new_string: 'new' }, editId: 1,
  });
  const editResult = result.events.find((e) => e.update.sessionUpdate === 'tool_call_update' && e.update.toolCallId === 'claude-edit-1').update;
  assert.deepEqual(editResult, {
    sessionUpdate: 'tool_call_update', toolCallId: 'claude-edit-1', title: `Edit ${path.join(cwd, 'demo.ts')}`,
    kind: 'edit', status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: `Updated ${path.join(cwd, 'demo.ts')}` } }],
  });
  const shell = result.events.find((e) => e.update.sessionUpdate === 'tool_call' && e.update.toolCallId === 'claude-bash-1').update;
  assert.deepEqual(shell, {
    sessionUpdate: 'tool_call', toolCallId: 'claude-bash-1',
    title: 'Bash npm test -- --test-name-pattern conversation', kind: 'execute', status: 'pending',
    rawInput: { command: 'npm test -- --test-name-pattern conversation', description: 'Run the focused tests' },
  });
  assert.deepEqual(updates(result, 'usage_update')[0], { sessionUpdate: 'usage_update', used: 440, size: 200000 });
  const permission = result.events.find((e) => e.update.sessionUpdate === 'tool_call' && e.update.toolCallId.startsWith('permission-')).update;
  assert.deepEqual(permission, {
    sessionUpdate: 'tool_call', toolCallId: 'permission-1789740002500-0', title: 'permission asked: Bash',
    kind: 'other', status: 'completed', rawInput: { permission: true, target: 'Bash' },
  });
  assert.deepEqual(updates(result, 'turn_end'), [
    { sessionUpdate: 'turn_end', stopReason: 'end_turn', edits: 1, ts: 1789740005000,
      records: [{ id: 1, file: path.join(cwd, 'demo.ts'), partial: false }] },
    { sessionUpdate: 'turn_end', stopReason: 'end_turn', edits: 0, ts: 1789740063000, records: [] },
  ]);
});

test('conversation: Codex raw rollout uses the same exact shapes for text, thought, edit, shell, plan and usage', () => {
  const { cwd } = fresh();
  const session = 'codex-conversation';
  codexRollout(cwd, fixture('conversation-codex.jsonl', cwd), session);
  seedEdit(session, path.join(cwd, 'codex.ts'), Date.parse('2026-09-18T15:00:04.500Z'), 'apply_patch');

  const result = core.conversationEvents(session, { root: cwd });
  assert.equal(result.agent, 'codex');
  assert.equal(result.turns, 2);
  const lastPrompt = result.events.findLastIndex(e => e.update.sessionUpdate === 'user_prompt');
  assert.deepEqual(core.conversationEvents(session, { root: cwd, limit: 1 }).events, result.events.slice(lastPrompt));
  assert.match(result.transcriptPath, /runtime-transcripts[/\\]codex/);
  assert.deepEqual(updates(result, 'user_prompt'), [
    { sessionUpdate: 'user_prompt', content: { type: 'text', text: 'Patch the Codex demo and plan the checks.' }, promptId: 'codex-turn-1' },
    { sessionUpdate: 'user_prompt', content: { type: 'text', text: 'Run the Codex checks.' }, promptId: 'codex-turn-2' },
  ]);
  assert.deepEqual(updates(result, 'agent_thought_chunk'), [
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspecting the Codex fixture.' } },
  ]);
  const edit = result.events.find((e) => e.update.sessionUpdate === 'tool_call' && e.update.toolCallId === 'codex-edit-1').update;
  assert.deepEqual(edit, {
    sessionUpdate: 'tool_call', toolCallId: 'codex-edit-1', title: `apply_patch ${path.join(cwd, 'codex.ts')}`,
    kind: 'edit', status: 'pending',
    rawInput: {
      input: `*** Begin Patch\n*** Update File: ${path.join(cwd, 'codex.ts')}\n@@\n-old\n+new\n*** End Patch`,
      file_path: path.join(cwd, 'codex.ts'),
    },
    editId: 1,
  });
  assert.deepEqual(updates(result, 'plan'), [{ sessionUpdate: 'plan', entries: [
    { content: 'Patch Codex demo', priority: 'medium', status: 'completed' },
    { content: 'Run Codex checks', priority: 'medium', status: 'in_progress' },
  ] }]);
  const shell = result.events.find((e) => e.update.sessionUpdate === 'tool_call' && e.update.toolCallId === 'codex-bash-1').update;
  assert.deepEqual(shell, {
    sessionUpdate: 'tool_call', toolCallId: 'codex-bash-1', title: 'Bash npm test -- codex', kind: 'execute', status: 'pending',
    rawInput: { cmd: 'npm test -- codex', command: 'npm test -- codex' },
  });
  assert.deepEqual(updates(result, 'usage_update'), [
    { sessionUpdate: 'usage_update', used: 130, size: 10000 },
    { sessionUpdate: 'usage_update', used: 50, size: 10000 },
  ]);
  assert.deepEqual(updates(result, 'turn_end').map((u) => u.edits), [1, 0]);
});

test('conversation: byte cursor returns only an appended turn and turn limit bounds the initial view', () => {
  const { cwd } = fresh();
  const session = 'claude-conversation';
  const all = fixture('conversation-claude.jsonl', cwd).split('\n').filter(Boolean);
  const file = claudeTranscript(cwd, all.slice(0, 6).join('\n') + '\n', session);
  const first = core.conversationEvents(session, { root: cwd });
  assert.equal(first.turns, 1);
  assert.equal(first.cursor, fs.statSync(file).size);

  fs.appendFileSync(file, all.slice(6).join('\n') + '\n');
  const tail = core.conversationTail(session, first.cursor);
  assert.equal(tail.turns, 1);
  assert.equal(updates(tail, 'user_prompt').length, 1);
  assert.deepEqual(updates(tail, 'user_prompt')[0], {
    sessionUpdate: 'user_prompt', content: { type: 'text', text: 'Run the focused tests.' }, promptId: 'claude-prompt-2',
  });
  assert.ok(tail.events.every((e) => e.ts >= Date.parse('2026-09-18T14:01:00.000Z')));
  assert.equal(tail.cursor, fs.statSync(file).size);

  const bounded = core.conversationEvents(session, { root: cwd, limit: 1 });
  assert.equal(bounded.turns, 1);
  assert.deepEqual(updates(bounded, 'user_prompt'), [{
    sessionUpdate: 'user_prompt', content: { type: 'text', text: 'Run the focused tests.' }, promptId: 'claude-prompt-2',
  }]);
});

test('conversation: streamed text and thought bounds match the TUI caps', () => {
  const { cwd } = fresh();
  const session = 'conversation-bounds';
  const longText = 'x'.repeat(9000);
  const longThought = 'y'.repeat(2100);
  const lines = [
    { timestamp: '2026-09-18T16:00:00.000Z', cwd, message: { role: 'user', content: 'bound it' } },
    { timestamp: '2026-09-18T16:00:01.000Z', cwd, message: { id: 'bound-1', role: 'assistant', stop_reason: 'end_turn', content: [
      { type: 'thinking', thinking: longThought }, { type: 'text', text: longText },
    ] } },
  ];
  claudeTranscript(cwd, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', session);
  const result = core.conversationEvents(session, { root: cwd });
  assert.deepEqual(updates(result, 'agent_thought_chunk'), [{
    sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `${'y'.repeat(2000)}…` },
  }]);
  assert.deepEqual(updates(result, 'agent_message_chunk'), [{
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${'x'.repeat(8192)} …(+1k chars)` },
  }]);
});

test('cli: conversation --json and views batching expose the same payload', (t) => {
  const { cwd } = fresh();
  const session = 'claude-conversation';
  claudeTranscript(cwd, fixture('conversation-claude.jsonl', cwd), session);
  const env = { ...process.env };
  let directText;
  try {
    directText = cp.execFileSync(process.execPath, [CLI, 'conversation', '--session', session, '--root', cwd, '--limit', '1', '--json'], { cwd, env, encoding: 'utf8' });
  } catch (error) {
    if (error?.code === 'EPERM') return t.skip('this sandbox forbids child-process execution');
    throw error;
  }
  const direct = JSON.parse(directText);
  assert.equal(direct.turns, 1);
  assert.equal(updates(direct, 'user_prompt')[0].content.text, 'Run the focused tests.');
  const batch = JSON.parse(cp.execFileSync(process.execPath, [CLI, 'views', '--views', 'conversation', '--session', session, '--root', cwd, '--limit', '1'], { cwd, env, encoding: 'utf8' }));
  assert.deepEqual(batch.conversation, direct);
});

// The turn window is an INITIAL-read bound. It used to be applied to `--since`
// reads too, while the cursor advanced to EOF — so a viewer that was hidden while 60 turns arrived
// appended the newest 50 to its history and could never fetch the 10 in between again.
test('conversation regression: an incremental read delivers every appended turn, however many arrived', () => {
  const { cwd } = fresh();
  const r = rows(cwd), session = 'incremental-turns';
  const file = claudeTranscript(cwd, r.jsonl([r.prompt(0, 'initial'), r.answer(1)]), session);
  const first = core.conversationEvents(session, { root: cwd });
  assert.equal(first.turns, 1);
  assert.equal(first.truncated, 0, 'a transcript shorter than the window is not truncated');
  const appended = [];
  for (let i = 0; i < 60; i++) appended.push(r.prompt(100 + i * 2, `appended ${i}`), r.answer(101 + i * 2, `answer ${i}`));
  fs.appendFileSync(file, r.jsonl(appended));

  const tail = core.conversationTail(session, first.cursor);
  const prompts = updates(tail, 'user_prompt').map((u) => u.content.text);
  assert.equal(prompts.length, 60, 'every appended turn is delivered');
  assert.equal(prompts[0], 'appended 0');
  assert.equal(tail.turns, 60);
  assert.equal(tail.truncated, 0, 'an incremental read cuts nothing');
  assert.equal(tail.reset, undefined, 'an append is not a reset');
  assert.equal(tail.cursor, fs.statSync(file).size);
  // The window still bounds an initial read, which is the reason the limit exists.
  const initial = core.conversationEvents(session, { root: cwd });
  assert.equal(initial.turns, 50);
  assert.ok(initial.truncated > 0, `${initial.truncated} bytes of earlier turns are reported as cut`);
  assert.equal(updates(initial, 'user_prompt')[0].content.text, 'appended 10');
});

// A rewritten transcript is not a continuation: the reader must say so instead of
// answering a suffix that a consumer files under a prompt the file no longer contains.
for (const shape of ['same size', 'larger', 'shorter']) {
  test(`conversation regression: a ${shape} in-place replacement answers a reset, not a suffix`, () => {
    const { cwd } = fresh();
    const r = rows(cwd), session = `replaced-${shape.replace(' ', '-')}`;
    const file = claudeTranscript(cwd, r.jsonl([r.prompt(0, 'old prompt'), r.answer(1, 'old answer')]), session);
    const first = core.conversationEvents(session, { root: cwd });
    assert.equal(updates(first, 'user_prompt')[0].content.text, 'old prompt');
    const ino = fs.statSync(file).ino;
    const replacement = [r.prompt(0, 'new prompt'), r.answer(1, 'new answer')];
    if (shape === 'larger') replacement.push(r.prompt(2, 'x'.repeat(first.cursor)), r.answer(3, 'padding answer'));
    if (shape === 'shorter') replacement.pop();
    fs.writeFileSync(file, r.jsonl(replacement));
    assert.equal(fs.statSync(file).ino, ino, 'the same inode, as an in-place rewrite leaves it');

    const tail = core.conversationTail(session, first.cursor);
    assert.equal(tail.reset, true, 'the consumer is told to replace its aggregate');
    assert.equal(updates(tail, 'user_prompt')[0].content.text, 'new prompt', 'and is given the new conversation');
    assert.ok(!updates(tail, 'agent_message_chunk').some((u) => u.content.text === 'old answer'), 'no record of the old source survives');
    assert.equal(tail.cursor, fs.statSync(file).size);
    assert.deepEqual(core.conversationEvents(session, { root: cwd }).events, tail.events, 'a reset equals a fresh read');
    // And the next poll from the reset cursor is an ordinary append again.
    fs.appendFileSync(file, r.jsonl([r.prompt(500, 'after the reset'), r.answer(501)]));
    const next = core.conversationTail(session, tail.cursor);
    assert.equal(next.reset, undefined);
    assert.deepEqual(updates(next, 'user_prompt').map((u) => u.content.text), ['after the reset']);
  });
}

test('conversation regression: a cursor past the end of the transcript is a reset, not a full-file tail', () => {
  const { cwd } = fresh();
  const r = rows(cwd), session = 'cursor-past-eof';
  const file = claudeTranscript(cwd, r.jsonl([r.prompt(0, 'only prompt'), r.answer(1)]), session);
  const size = fs.statSync(file).size;
  const tail = core.conversationTail(session, size + 4096);
  assert.equal(tail.reset, true);
  assert.equal(updates(tail, 'user_prompt')[0].content.text, 'only prompt');
  assert.equal(tail.cursor, size);
});

// The editors poll with a FRESH `oak conversation --since` process every time, so replacement
// detection has to survive process death: it rides the persisted checkpoint, not process memory.
test('cli: a same-size rewrite between two conversation processes answers a reset', (t) => {
  const { cwd } = fresh();
  const r = rows(cwd), session = 'cli-replacement';
  core.ensureStore(session);
  fs.writeFileSync(core.logPath(session), ''); // captured: checkpoints persist beside the change map
  const file = claudeTranscript(cwd, r.jsonl([r.prompt(0, 'old prompt'), r.answer(1, 'old answer')]), session);
  const env = { ...process.env };
  const read = (...extra) => JSON.parse(cp.execFileSync(process.execPath,
    [CLI, 'conversation', '--session', session, '--root', cwd, '--json', ...extra], { cwd, env, encoding: 'utf8' }));
  let first;
  try { first = read(); } catch (error) {
    if (error?.code === 'EPERM') return t.skip('this sandbox forbids child-process execution');
    throw error;
  }
  assert.equal(updates(first, 'user_prompt')[0].content.text, 'old prompt');
  assert.ok(fs.existsSync(path.join(core.rootDir(), 'changemap-cache', session, 'conversation.json')), 'the checkpoint outlives the process');
  const ino = fs.statSync(file).ino;
  fs.writeFileSync(file, r.jsonl([r.prompt(0, 'new prompt'), r.answer(1, 'new answer')]));
  assert.equal(fs.statSync(file).ino, ino);
  assert.equal(fs.statSync(file).size, first.cursor, 'same size: only the checkpoint can tell this apart');
  const tail = read('--since', String(first.cursor));
  assert.equal(tail.reset, true);
  assert.deepEqual(updates(tail, 'user_prompt').map((u) => u.content.text), ['new prompt']);
});

test('remote source token: uncaptured replacement and independent cursors reset without changing ordinary local JSON', () => {
  const { cwd } = fresh(), r = rows(cwd), session = 'uncaptured-source';
  const file = claudeTranscript(cwd, r.jsonl([r.prompt(0), r.answer(1)]), session);
  const ordinary = core.conversationEvents(session, { root: cwd });
  const first = core.conversationEvents(session, { root: cwd, includeSource: true });
  assert.match(first.source, /^[a-f0-9]{64}$/);
  const { source, ...localShape } = first;
  assert.equal(JSON.stringify(localShape), JSON.stringify(ordinary), 'source opt-in leaves default local output byte-identical');
  fs.appendFileSync(file, r.jsonl([r.prompt(2), r.answer(3)]));
  const second = core.conversationEvents(session, { root: cwd, since: first.cursor, source, includeSource: true });
  assert.equal(second.reset, undefined); assert.ok(second.cursor > first.cursor);
  // A second reader has advanced the in-process checkpoint. The first cursor still validates.
  const replay = core.conversationEvents(session, { root: cwd, since: first.cursor, source, includeSource: true });
  assert.deepEqual(replay.events, second.events);
  const replacement = r.jsonl([r.prompt(4, 'replacement '.repeat(400)), r.answer(5)]);
  fs.writeFileSync(file, replacement);
  const reset = core.conversationEvents(session, { root: cwd, since: first.cursor, source, includeSource: true });
  assert.equal(reset.reset, true); assert.match(JSON.stringify(reset.events), /replacement/);
  assert.equal(fs.existsSync(core.logPath(session)), false, 'reading never resurrects an uncaptured session store');
});

test('mirror provenance: matching cwd, absent cwd, Codex layout and copied Claude project directory', () => {
  const { cwd } = fresh(), r = rows(cwd);
  const local = claudeTranscript(cwd, r.jsonl([{ type: 'queue-operation', content: 'prefix' }, r.prompt(0)]), 'mirror-provenance');
  assert.deepEqual(core.isMirroredTranscript(local), { mirrored: false, recordedCwd: cwd });
  const copied = claudeTranscript('/other/workspace', fs.readFileSync(local, 'utf8'), 'mirror-provenance-copy');
  assert.deepEqual(core.isMirroredTranscript(copied), { mirrored: true, recordedCwd: cwd });
  const unknown = claudeTranscript(cwd, '{"type":"queue-operation"}\n', 'no-cwd');
  assert.deepEqual(core.isMirroredTranscript(unknown), { mirrored: false });
  const rollout = codexRollout(cwd, r.jsonl([r.prompt(0)]));
  assert.equal(core.isMirroredTranscript(rollout).mirrored, false, 'a Codex rollout in its own layout is never a mirror');
});
