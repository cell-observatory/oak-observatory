// `oak query` and the listings the CLI serves from the local index: the JSON contract and its exit codes, `--serve`,
// guarded SQL killed at its deadline, the archive through `oak clean` and `oak sessions --delete`, and parity of
// `oak sessions --json`, `oak search` and `oak inbox` with the old listings (OAK_INDEX=off).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const root = path.resolve(__dirname, '..');
const CLI = path.join(root, 'packages/cli/dist/index.js');
const core = require(path.join(root, 'packages/core/dist/index.js'));
const skip = !core.indexRuntime().ok && `no node:sqlite with FTS5 in ${process.version}`;

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oak-index-cli-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = {
    ...process.env, HOME: dir, USERPROFILE: dir, CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), CODEX_HOME: path.join(dir, 'codex'),
    XDG_CONFIG_HOME: path.join(dir, 'xdg'), HERDR_BIN: path.join(dir, 'absent-herdr'), HERDR_SOCKET_PATH: path.join(dir, 'no-socket'), OAK_NO_BACKGROUND: '1',
  };
  delete env.OAK_INDEX;
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  const mangle = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');
  const lines = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const claude = (id, cwd, records, folder = cwd) => {
    const file = path.join(env.CLAUDE_CONFIG_DIR, 'projects', mangle(folder), `${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines(records.map((r) => ({ cwd, sessionId: id, ...r }))));
    return file;
  };
  const cli = (args, opts = {}) => cp.spawnSync(process.execPath, [CLI, ...args], { cwd: opts.cwd ?? work, env: { ...env, ...(opts.env ?? {}) }, encoding: 'utf8', input: opts.input, timeout: 60_000 });
  const json = (args, opts) => {
    const r = cli(args, opts);
    try {
      return { status: r.status, out: JSON.parse(r.stdout), stderr: r.stderr };
    } catch {
      throw new Error(`not JSON (${r.status}): ${r.stdout.slice(0, 400)} ${r.stderr.slice(0, 400)}`);
    }
  };
  return { dir, env, work, claude, cli, json };
}

let s = 0;
const at = () => `2026-10-01T10:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s++ % 60).padStart(2, '0')}.000Z`;
const ask = (t) => ({ type: 'user', timestamp: at(), message: { role: 'user', content: t } });
const reply = (id, t) => ({ type: 'assistant', timestamp: at(), message: { id, role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: t }], usage: { input_tokens: 10, output_tokens: 5 } } });

test('oak query: the JSON contract, --arrays, --table, and the exit codes (2 bad query, 3 no index, 124 deadline)', { skip }, (t) => {
  const f = fixture(t);
  f.claude('fixture-q1', f.work, [ask('Teach the zebracorn tokenizer'), reply('a1', 'Taught.')]);
  let r = f.json(['query', 'sessions']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.keys(r.out), ['v', 'query', 'params', 'columns', 'rows', 'rowCount', 'truncated', 'freshness', 'elapsedMs', 'problems']);
  assert.deepEqual(r.out.rows.map((x) => x.id), ['fixture-q1']);
  assert.equal(r.out.freshness.caughtUp, true);
  r = f.json(['query', 'sessions', '--arrays']);
  assert.equal(r.out.rows[0][r.out.columns.indexOf('id')], 'fixture-q1');
  r = f.json(['query', 'search', '--text', 'zebracorn']);
  assert.match(r.out.rows[0].snippet, /\[zebracorn\]/);
  const table = f.cli(['query', 'sessions', '--table']);
  assert.match(table.stdout, /^id\s+fixture-q1$/m);
  assert.match(table.stdout, /^1 row · \d+ ms · the database is current$/m);
  // A machine by id, `self`, or a saved machine's label; a name the index holds no machine by is a query that cannot run.
  assert.deepEqual(f.json(['query', 'sessions', '--machine', 'self']).out.rows.map((x) => x.id), ['fixture-q1']);
  assert.deepEqual(f.json(['query', 'sessions', '--machine', r.out.rows[0].machine]).out.rows.map((x) => x.id), ['fixture-q1']);
  // 2: a query that cannot run.
  for (const args of [['query', 'nope'], ['query', 'constructor'], ['query', 'schema', '--limit', '1'], ['query', 'sessions', '--constructor', 'x'], ['query', 'sessions', '--limit', '0'], ['query', 'sessions', '--colour', 'red'], ['query'], ['query', 'search'], ['query', 'sessions', '--machine', 'nowhere']]) {
    r = f.json(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.out.error.code, /^bad_/, args.join(' '));
  }
  // 3: no index (turned off here; a Node without FTS5 answers the same).
  r = f.json(['query', 'sessions'], { env: { OAK_INDEX: 'off' } });
  assert.deepEqual([r.status, r.out.error.code], [3, 'index_unavailable']);
  assert.equal(r.out.error.message, 'the database is turned off (OAK_INDEX=off)');
  const off = f.cli(['query', '--status', '--table'], { env: { OAK_INDEX: 'off' } });
  assert.equal(off.stdout, 'database unavailable: the database is turned off (OAK_INDEX=off)\n');
  // 124: raw SQL past its deadline, killed.
  const t0 = Date.now();
  r = f.json(['query', 'sql', 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c', '--timeout', '700']);
  assert.deepEqual([r.status, r.out.error.code], [124, 'timeout']);
  assert.ok(Date.now() - t0 < 20_000, 'stopped near its deadline');
});

test('oak query: every subcommand reaches its named query through the CLI', { skip }, (t) => {
  const f = fixture(t);
  f.claude('fixture-verbs', f.work, [ask('Search zebracorn'), reply('verbs', 'Answer')]);
  for (const [name, count, args] of [
    ['sessions', 1, []], ['edits', 0, []], ['files', 0, []], ['prompts', 1, ['--session', 'fixture-verbs']],
    ['search', 1, ['--text', 'zebracorn']], ['workers', 0, []], ['sync', 1, []], ['usage', 1, ['--since', '2026-01-01', '--account', 'all']],
    ['readings', 0, []], ['notes', 0, []], ['sql', 1, ['SELECT session_id FROM sessions']],
  ]) {
    const r = f.json(['query', name, ...args]);
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.equal(r.out.query, name);
    assert.equal(r.out.rowCount, count, name);
    assert.equal(r.out.freshness.caughtUp, true, name);
  }
  const schema = f.json(['query', 'schema']);
  assert.equal(schema.status, 0);
  assert.equal(schema.out.query, 'schema');
  assert.deepEqual(schema.out.rows.filter((r) => r.kind === 'query').map((r) => r.name).sort(), [...Object.keys(core.NAMED_QUERIES), 'sql'].sort());
});

// The parent that would stop a runaway query at its deadline can itself be killed while it waits (an editor cancelling
// the CLI): the child ends itself a second after the deadline. Found by its environment, which only Linux shows in /proc.
test('oak query sql: a query whose parent was killed ends itself after its deadline', { skip: skip || (process.platform !== 'linux' && 'reads /proc') }, async (t) => {
  const f = fixture(t);
  f.claude('fixture-orphan', f.work, [ask('Index me'), reply('o1', 'Indexed.')]);
  assert.equal(f.json(['query', 'sessions']).status, 0);
  const mark = `oak-orphan-${process.pid}-${Date.now()}`;
  const child = () => {
    for (const pid of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
      try {
        if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('__query-sql')) continue;
        if (fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`OAK_ORPHAN_MARK=${mark}`)) return Number(pid);
      } catch {
        /* gone, or not ours */
      }
    }
    return null;
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const parent = cp.spawn(process.execPath, [CLI, 'query', 'sql', 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c', '--timeout', '1500'],
    { cwd: f.work, env: { ...f.env, OAK_ORPHAN_MARK: mark }, stdio: 'ignore' });
  let pid = null;
  try {
    for (let i = 0; i < 100 && pid === null; i++) {
      await wait(50);
      pid = child();
    }
    assert.ok(pid, 'the query is running in its child');
    parent.kill('SIGKILL');
    const killed = Date.now();
    await wait(100);
    assert.equal(child(), pid, 'positive control: the child outlives its killed parent');
    while (child() !== null && Date.now() - killed < 10_000) await wait(100);
    assert.equal(child(), null, 'the child ended itself');
    assert.ok(Date.now() - killed < 5000, `within its deadline and grace (${Date.now() - killed} ms after the parent died)`);
  } finally {
    const left = child();
    if (left) process.kill(left, 'SIGKILL');
    try { parent.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

test('oak query sql: one read runs; ATTACH, VACUUM INTO, a second statement and a write are refused (exit 2) and change nothing', { skip }, (t) => {
  const f = fixture(t);
  f.claude('fixture-sql', f.work, [ask('Index me'), reply('s1', 'Indexed.')]);
  let r = f.json(['query', 'sql', 'SELECT session_id, title FROM sessions ORDER BY session_id', '--limit', '5']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.rows, [{ session_id: 'fixture-sql', title: 'Index me' }]);
  r = f.json(['query', 'sql', '-'], { input: 'SELECT count(*) AS n FROM prompts' });
  assert.deepEqual(r.out.rows, [{ n: 1 }], 'the statement read from stdin');
  const stolen = path.join(f.dir, 'stolen.db');
  for (const sql of [`ATTACH DATABASE '${stolen}' AS x`, `VACUUM INTO '${stolen}'`, 'SELECT 1; DELETE FROM sessions', 'DELETE FROM sessions', "UPDATE sessions SET title = 'x'", 'PRAGMA query_only = 0']) {
    r = f.json(['query', 'sql', sql]);
    assert.deepEqual([r.status, r.out.error?.code], [2, 'unsafe_sql'], sql);
  }
  assert.equal(fs.existsSync(stolen), false);
  assert.equal(f.json(['query', 'sql', 'SELECT count(*) AS n FROM sessions']).out.rows[0].n, 1, 'nothing was changed');
});

test('oak query --serve: one process answers a request per line, by name or as SQL, each with its id', { skip }, (t) => {
  const f = fixture(t);
  f.claude('fixture-serve', f.work, [ask('Serve me'), reply('v1', 'Served.')]);
  const r = f.cli(['query', '--serve'], { input: [
    JSON.stringify({ id: 'a', query: 'sessions' }),
    JSON.stringify({ id: 'b', sql: 'SELECT count(*) AS n FROM prompts', arrays: true }),
    JSON.stringify({ id: 'c', query: 'nope' }),
    'not json',
  ].join('\n') + '\n' });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(out.map((o) => o.id ?? null), ['a', 'b', 'c', null]);
  assert.equal(out[0].rows[0].id, 'fixture-serve');
  assert.deepEqual(out[1].rows, [[1]]);
  assert.equal(out[2].error.code, 'bad_query');
  assert.equal(out[3].error.code, 'bad_query');
});

/** The same listing from the index and the old way (OAK_INDEX=off), timing fields aside. */
function parity(f, args, strip = (x) => x) {
  const fromIndex = f.json(args);
  const old = f.json(args, { env: { OAK_INDEX: 'off' } });
  assert.equal(fromIndex.status, 0, fromIndex.stderr);
  assert.deepEqual(strip(fromIndex.out), strip(old.out), `${args.join(' ')}: the index lists what the files list`);
  return fromIndex.out;
}

test('parity: oak sessions --json, oak search and oak inbox answer the same from the index as from the files', { skip }, (t) => {
  const f = fixture(t);
  const other = path.join(f.dir, 'other');
  fs.mkdirSync(other);
  f.claude('fixture-p1', f.work, [ask('Port the zebracorn parser'), { type: 'assistant', timestamp: at(), message: { id: 'p1', role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }] } }, reply('p1', 'The zebracorn parser is ported.')]);
  f.claude('fixture-p2', other, [ask('Write the release notes'), reply('p2', 'Drafted the notes.')]);
  f.claude('fixture-p3', f.work, [ask('Copied from elsewhere'), reply('p3', 'x')], path.join(f.dir, 'elsewhere'));
  const empty = f.claude('fixture-empty', f.work, [{ type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>' } }]);
  fs.utimesSync(empty, 1e6, 1e6);
  // A raised hand, for the inbox.
  const store = path.join(f.env.CLAUDE_CONFIG_DIR, 'claude-observatory', 'fixture-p2');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'attention.json'), JSON.stringify({ kind: 'input', message: 'Waiting for you', ts: Date.now() - 5000 }));
  const listing = parity(f, ['sessions', '--json']);
  // The copy in another project's folder is a mirror, and the session in which nothing happened is not listed.
  assert.deepEqual(listing.sessions.map((x) => x.id).sort(), ['fixture-p1', 'fixture-p2']);
  parity(f, ['sessions', '--json', '--all']);
  parity(f, ['sessions', '--json', '--session', 'fixture-empty']);
  parity(f, ['sessions', '--json', '--session', 'fixture-p3']);
  const strip = (x) => ({ ...x, ms: 0, indexed: 0 });
  for (const q of ['zebracorn', 'notes', 'zebra parser', 'ported', 'nothing-at-all']) parity(f, ['search', q, '--json'], strip);
  parity(f, ['search', 'zebracorn', '--json', '--per-session'], strip);
  const inbox = parity(f, ['inbox', '--json'], (x) => ({ ...x, generatedAt: 0, hands: x.hands.map((h) => ({ ...h, waitingMs: 0, waitedTodayMs: 0 })) }));
  assert.deepEqual(inbox.hands.map((h) => [h.id, h.kind]), [['fixture-p2', 'input']]);
  // The text forms render from the same listing.
  assert.equal(f.cli(['sessions']).stdout, f.cli(['sessions'], { env: { OAK_INDEX: 'off' } }).stdout);
});

test('archive: oak clean --drop then the transcript gone keeps the session, archived; oak sessions --delete forgets it', { skip }, (t) => {
  const f = fixture(t);
  const file = f.claude('fixture-arch', f.work, [ask('Teach the zebracorn parser'), reply('z1', 'Taught.')]);
  const keep = f.claude('fixture-keep', f.work, [ask('Keep this one'), reply('k1', 'Kept.')]);
  const store = path.join(f.env.CLAUDE_CONFIG_DIR, 'claude-observatory', 'fixture-arch');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'log.jsonl'), JSON.stringify({ id: 1, uid: 'u', ts: Date.now() - 1000, tool: 'Edit', file: path.join(f.work, 'a.ts'), beforeBlob: null, afterBlob: null, status: 'kept' }) + '\n');
  assert.equal(f.json(['query', 'edits']).out.rowCount, 1);
  assert.equal(f.cli(['clean', '--drop', 'fixture-arch']).status, 0);
  fs.rmSync(file);
  assert.deepEqual(f.json(['sessions', '--json']).out.sessions.map((x) => x.id), ['fixture-keep']);
  assert.equal(f.json(['query', 'sessions']).out.rowCount, 1);
  const archived = f.json(['query', 'sessions', '--archived']).out.rows.find((x) => x.id === 'fixture-arch');
  assert.deepEqual([archived?.archived, archived?.archived_reason], [1, 'cleaned']);
  assert.equal(f.json(['query', 'search', '--text', 'zebracorn']).out.rowCount, 0);
  assert.equal(f.json(['query', 'search', '--text', 'zebracorn', '--all']).out.rowCount, 1);
  assert.deepEqual(f.json(['query', 'edits', '--all']).out.rows.map((x) => [x.session, x.archived_reason]), [['fixture-arch', 'cleaned']]);
  // A deliberate delete forgets: nothing of it is left, even when asked for everything.
  assert.equal(f.cli(['sessions', '--delete', 'fixture-keep', '--force']).status, 0);
  assert.equal(f.json(['query', 'sessions', '--all']).out.rows.some((x) => x.id === 'fixture-keep'), false);
  assert.equal(f.json(['query', 'search', '--text', 'Keep', '--all']).out.rowCount, 0);
  void keep;
});

test('oak clean removes a superseded index file once its archive was carried; uninstall --all names the folder; doctor has a row', { skip }, (t) => {
  const f = fixture(t);
  f.claude('fixture-c', f.work, [ask('One'), reply('c1', 'x')]);
  assert.equal(f.json(['query', 'sessions']).status, 0);
  const dir = path.join(f.env.CLAUDE_CONFIG_DIR, 'claude-observatory-index');
  const [current] = fs.readdirSync(dir).filter((n) => /^index-v1-[0-9a-f]{16}\.sqlite$/.test(n));
  // An older file another format left, which the current file carried and verified.
  const old = path.join(dir, 'index-v0-0000000000000000.sqlite');
  fs.copyFileSync(path.join(dir, current), old);
  const db = new (require('node:sqlite').DatabaseSync)(path.join(dir, current));
  const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  meta.run('archive_carried_from', old);
  meta.run('archive_carry_verified', '0');
  db.close();
  let r = f.json(['clean', '--json']);
  assert.equal(r.out.indexFiles, 0, 'not verified: kept');
  const db2 = new (require('node:sqlite').DatabaseSync)(path.join(dir, current));
  db2.prepare("INSERT INTO meta (key, value) VALUES ('archive_carry_verified', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  db2.close();
  r = f.json(['clean', '--json']);
  assert.equal(r.out.indexFiles, 1);
  assert.equal(fs.existsSync(old), false);
  assert.ok(fs.existsSync(path.join(dir, current)), 'never the current one');
  const un = f.cli(['uninstall', '--all']);
  assert.match(un.stdout, /Local database: .*claude-observatory-index/);
  const doc = f.json(['doctor', '--json']);
  assert.equal(doc.out.checks.find((c) => c.id === 'index')?.level, 'ok');
  assert.equal(doc.out.checks.find((c) => c.id === 'index')?.label, 'Local database');
});

test('the listings are served from the index when it is current: a difference planted in it shows, and OAK_INDEX=off reads the files', { skip }, (t) => {
  const f = fixture(t);
  f.claude('fixture-served', f.work, [ask('Port the parser'), reply('s1', 'Ported.')]);
  const store = path.join(f.env.CLAUDE_CONFIG_DIR, 'claude-observatory', 'fixture-served');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'attention.json'), JSON.stringify({ kind: 'input', message: 'Waiting', ts: Date.now() - 1000 }));
  assert.equal(f.json(['sessions', '--json']).status, 0); // builds the index
  const dir = path.join(f.env.CLAUDE_CONFIG_DIR, 'claude-observatory-index');
  const [file] = fs.readdirSync(dir).filter((n) => /^index-v1-.*\.sqlite$/.test(n));
  const db = new (require('node:sqlite').DatabaseSync)(path.join(dir, file));
  db.prepare("UPDATE sessions SET facts = json_set(facts, '$.tokens', 424242, '$.titleParts.prompt', 'Planted title') WHERE session_id = 'fixture-served'").run();
  db.prepare("UPDATE prompts SET text = 'Port the parser plantedword' WHERE session_id = 'fixture-served'").run();
  db.close();
  const row = (env) => f.json(['sessions', '--json'], { env }).out.sessions.find((x) => x.id === 'fixture-served');
  assert.deepEqual([row().tokens, row().title], [424242, 'Planted title'], 'oak sessions --json read the index');
  assert.notEqual(row({ OAK_INDEX: 'off' }).tokens, 424242, 'positive control: off reads the files');
  assert.equal(f.json(['search', 'plantedword', '--json']).out.hits.length, 1, 'oak search read the index');
  assert.equal(f.json(['search', 'plantedword', '--json'], { env: { OAK_INDEX: 'off' } }).out.hits.length, 0);
  assert.equal(f.json(['inbox', '--json']).out.hands[0]?.title, 'Planted title', 'oak inbox read the index');
  assert.notEqual(f.json(['inbox', '--json'], { env: { OAK_INDEX: 'off' } }).out.hands[0]?.title, 'Planted title');
  // While another live process holds the catch-up, the index may be behind the files: the listing reads the files.
  const held = new (require('node:sqlite').DatabaseSync)(path.join(dir, file));
  held.prepare('UPDATE lease SET holder = ?, pid = ?, until_ms = ? WHERE id = 1').run('another-process', process.pid, Date.now() + 60_000);
  held.close();
  assert.notEqual(row().tokens, 424242, 'not caught up: listed from the files');
});

// `oak notify --watch` announces every hand the workspace raises, from the listing it reads every few seconds: the one
// `oak sessions --json` gives, so from the index when it is current.
test('oak notify --watch reads its listing from the index: a title planted there is the one it announces', { skip: skip || (process.platform !== 'linux' && 'the fake notifier is notify-send') }, async (t) => {
  const announced = async (env) => {
    const f = fixture(t);
    f.claude('fixture-watched', f.work, [ask('Port the parser'), reply('w1', 'Ported.')]);
    const store = path.join(f.env.CLAUDE_CONFIG_DIR, 'claude-observatory', 'fixture-watched');
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, 'attention.json'), JSON.stringify({ kind: 'input', message: 'Waiting', ts: Date.now() - 1000 }));
    assert.equal(f.json(['sessions', '--json']).status, 0); // builds the index
    const dir = path.join(f.env.CLAUDE_CONFIG_DIR, 'claude-observatory-index');
    const [file] = fs.readdirSync(dir).filter((n) => /^index-v1-.*\.sqlite$/.test(n));
    const db = new (require('node:sqlite').DatabaseSync)(path.join(dir, file));
    db.prepare("UPDATE sessions SET facts = json_set(facts, '$.titleParts.prompt', 'Planted title') WHERE session_id = 'fixture-watched'").run();
    db.close();
    const bin = path.join(f.dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'notify-send'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }); // never a real notification
    const child = cp.spawn(process.execPath, [CLI, 'notify', '--watch', '--root', f.work], {
      cwd: f.work, env: { ...f.env, CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1', PATH: bin + path.delimiter + f.env.PATH, ...env },
    });
    t.after(() => child.kill('SIGKILL'));
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    for (let i = 0; i < 200 && !/Waiting/.test(out); i++) await new Promise((r) => setTimeout(r, 50));
    child.kill('SIGKILL');
    return out.split('\n').find((l) => l.includes('Waiting')) ?? `nothing announced: ${out}`;
  };
  assert.match(await announced({}), /  Planted title  /, 'the hand, titled as the index holds it');
  assert.match(await announced({ OAK_INDEX: 'off' }), /  Port the parser  /, 'positive control: off reads the files');
});

// `--status` is the edits' and files' parameter after a query's name, as the docs show it (`oak query edits --status
// pending`); with no query named it describes the index. It used to describe the index wherever it stood, and in its
// `--status=<value>` form it was dropped, so the query answered every status.
test('oak query edits --status <value> filters by status; oak query --status alone describes the index', { skip }, (t) => {
  const f = fixture(t);
  f.claude('fixture-st', f.work, [ask('Edit three files'), reply('st1', 'Edited.')]);
  const store = path.join(f.env.CLAUDE_CONFIG_DIR, 'claude-observatory', 'fixture-st');
  fs.mkdirSync(store, { recursive: true });
  const rec = (id, status) => JSON.stringify({ id, uid: `u${id}`, ts: Date.now() - 1000 * id, tool: 'Edit', file: path.join(f.work, `f${id}.ts`), beforeBlob: null, afterBlob: null, status });
  fs.writeFileSync(path.join(store, 'log.jsonl'), [rec(1, 'pending'), rec(2, 'kept'), rec(3, 'pending')].join('\n') + '\n');
  assert.deepEqual(f.json(['query', 'edits']).out.rows.map((x) => x.status).sort(), ['kept', 'pending', 'pending'], 'positive control: every status');
  for (const args of [['query', 'edits', '--status', 'pending'], ['query', 'edits', '--status=pending']]) {
    const r = f.json(args);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual([r.out.params.status, r.out.rows.map((x) => x.status)], ['pending', ['pending', 'pending']], args.join(' '));
  }
  assert.deepEqual(f.json(['query', 'files', '--status', 'kept']).out.rows.map((x) => path.basename(x.file)), ['f2.ts']);
  assert.equal(f.json(['query', '--status', '--json']).out.available, true, 'with no query named, --status describes the index');
  const wrong = f.json(['query', 'sessions', '--status', 'pending']);
  assert.deepEqual([wrong.status, wrong.out.error?.code], [2, 'bad_param'], 'a query that takes no status says so');
});

// An OAK beside a newer one (a second install, a channel switched back) must leave the newer one's index alone: a newer
// schema, or facts a newer INGEST_VERSION derived, which deriving again here would only have the newer OAK undo, the
// two taking turns on every read. The listings read the files, `oak query` exits 3, and `oak doctor` names the update,
// not a Node this machine already has.
test('an index a newer OAK wrote is left alone: the listing reads the files, oak query exits 3, doctor names the update', { skip }, (t) => {
  const f = fixture(t);
  const transcript = f.claude('fixture-newer', f.work, [ask('One'), reply('n1', 'x')]);
  assert.equal(f.json(['query', 'sessions']).status, 0);
  const dir = path.join(f.env.CLAUDE_CONFIG_DIR, 'claude-observatory-index');
  const [name] = fs.readdirSync(dir).filter((n) => /^index-v\d+-[0-9a-f]{16}\.sqlite$/.test(n));
  const file = path.join(dir, name);
  const sqlite = require('node:sqlite');
  const exec = (sql) => { const db = new sqlite.DatabaseSync(file); try { db.exec(sql); } finally { db.close(); } };
  const row = () => { const db = new sqlite.DatabaseSync(file, { readOnly: true }); try { return { ...db.prepare("SELECT inputs, updated_ms FROM sessions WHERE session_id = 'fixture-newer'").get() }; } finally { db.close(); } };
  const meta = () => { const db = new sqlite.DatabaseSync(file, { readOnly: true }); try { return db.prepare("SELECT value FROM meta WHERE key = 'ingest_version'").get()?.value; } finally { db.close(); } };
  assert.equal(meta(), String(core.INGEST_VERSION), 'the file records the version its facts were derived by');
  for (const [label, plant, restore, why] of [
    ['a newer schema', `PRAGMA user_version = ${core.SCHEMA_VERSION + 1}`, `PRAGMA user_version = ${core.SCHEMA_VERSION}`, /schema/],
    ['facts a newer OAK derived', `UPDATE meta SET value = '${core.INGEST_VERSION + 1}' WHERE key = 'ingest_version'`, `UPDATE meta SET value = '${core.INGEST_VERSION}' WHERE key = 'ingest_version'`, /facts version/],
  ]) {
    exec(plant);
    fs.appendFileSync(transcript, JSON.stringify({ cwd: f.work, sessionId: 'fixture-newer', ...reply(`n-${label}`, 'more') }) + '\n'); // work a writer would do
    const before = row();
    const q = f.json(['query', 'sessions']);
    assert.deepEqual([q.status, q.out.error?.code], [3, 'index_unavailable'], label);
    assert.match(q.out.error.message, /written by a newer OAK/, label);
    assert.match(q.out.error.message, why, label);
    assert.deepEqual(f.json(['sessions', '--json']).out, f.json(['sessions', '--json'], { env: { OAK_INDEX: 'off' } }).out, `${label}: the listing reads the files`);
    assert.deepEqual(row(), before, `${label}: nothing written`);
    const doctor = f.json(['doctor', '--json']).out.checks.find((c) => c.id === 'index');
    assert.equal(doctor.level, 'warn', label);
    assert.match(doctor.fix, /oak update/, label);
    assert.doesNotMatch(doctor.fix, /Node/, `${label}: this Node is not what stops it`);
    exec(restore);
    assert.equal(f.json(['query', 'sessions']).status, 0, `${label}: restored, it is read again`);
    assert.notDeepEqual(row(), before, `${label}: positive control: the catch-up now takes in what was appended`);
  }
});

// A file of a newer format belongs to a newer OAK: this one builds its own without copying from it, and `oak clean`
// never removes it, even when a record says it was carried.
test('a newer format\'s index file is neither carried from nor removed by this OAK', { skip }, (t) => {
  const f = fixture(t);
  f.claude('fixture-fmt', f.work, [ask('One'), reply('m1', 'x')]);
  assert.equal(f.json(['query', 'sessions']).status, 0);
  const dir = path.join(f.env.CLAUDE_CONFIG_DIR, 'claude-observatory-index');
  const [name] = fs.readdirSync(dir).filter((n) => /^index-v\d+-[0-9a-f]{16}\.sqlite$/.test(n));
  const current = path.join(dir, name);
  const key = /-([0-9a-f]{16})\.sqlite$/.exec(name)[1];
  const newer = path.join(dir, `index-v${core.INDEX_FORMAT + 1}-${key}.sqlite`);
  fs.copyFileSync(current, newer);
  // The current file gone, as a newer OAK's `oak clean` leaves it: this OAK builds it again from the files.
  for (const s of ['', '-wal', '-shm']) fs.rmSync(current + s, { force: true });
  assert.equal(f.json(['query', 'sessions']).status, 0);
  const sqlite = require('node:sqlite');
  const db = new sqlite.DatabaseSync(current);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'archive_carried_from'").get()?.value, '', 'nothing carried from the newer file');
  const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  setMeta.run('archive_carried_from', newer);
  setMeta.run('archive_carry_verified', '1');
  db.close();
  assert.equal(f.json(['clean', '--json']).out.indexFiles, 0);
  assert.ok(fs.existsSync(newer), 'a newer OAK\'s file is kept');
  // Positive control: an older format's file, carried and verified, is reclaimed by the same clean.
  const older = path.join(dir, `index-v0-${key}.sqlite`);
  fs.copyFileSync(current, older);
  const db2 = new sqlite.DatabaseSync(current);
  db2.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('archive_carried_from', older);
  db2.close();
  assert.equal(f.json(['clean', '--json']).out.indexFiles, 1);
  assert.equal(fs.existsSync(older), false);
  assert.ok(fs.existsSync(newer));
});

// Dropped is not forgotten: `oak clean --all`, the command a person wipes OAK's sessions with, says that the index keeps
// what it recorded of them, and so does the record log a new index reads it back from, and what forgets a session.
test('oak clean --all says what the local index and the record log keep of the sessions it dropped, and what forgets one', { skip }, (t) => {
  const f = fixture(t);
  f.claude('fixture-all', f.work, [ask('One'), reply('a1', 'x')]);
  const seed = () => {
    const store = path.join(f.env.CLAUDE_CONFIG_DIR, 'claude-observatory', 'fixture-all');
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, 'log.jsonl'), JSON.stringify({ id: 1, uid: 'u', ts: Date.now() - 1000, tool: 'Edit', file: path.join(f.work, 'a.ts'), beforeBlob: null, afterBlob: null, status: 'kept' }) + '\n');
  };
  seed();
  let r = f.cli(['clean', '--all'], { env: { OAK_INDEX: 'off' } });
  assert.match(r.stdout, /dropped all 1 session/);
  assert.doesNotMatch(r.stdout, /local database/, 'no index here: nothing to say of one');
  seed();
  assert.equal(f.json(['query', 'edits']).out.rowCount, 1);
  r = f.cli(['clean', '--all']);
  assert.match(r.stdout, /dropped all 1 session/);
  assert.match(r.stdout, /the local database keeps what it recorded of them \(`oak query edits --all`\), and so does this machine's record log \(.*records\), from which a new database reads it back: `oak sessions --delete <id>` forgets a session/);
  assert.deepEqual(f.json(['query', 'edits', '--all']).out.rows.map((x) => x.archived_reason), ['cleaned'], 'as it says');
  // Deleting the index forgets nothing the record log holds: a new index reads it back. A deliberate delete forgets.
  fs.rmSync(path.join(f.env.CLAUDE_CONFIG_DIR, 'claude-observatory-index'), { recursive: true });
  assert.deepEqual(f.json(['query', 'edits', '--all']).out.rows.map((x) => x.archived_reason), ['cleaned'], 'a new index reads it back');
  assert.equal(f.cli(['sessions', '--delete', 'fixture-all']).status, 0);
  assert.equal(f.json(['query', 'edits', '--all']).out.rowCount, 0, '`oak sessions --delete` forgets it');
});

/** The fixture's index file read as it stands, with no catch-up first; and this store's record logs, every segment. (A
 *  test's stand-in for a superseded file is keyed 0000000000000000.) */
function indexAndLog(f) {
  const dir = path.join(f.env.CLAUDE_CONFIG_DIR, 'claude-observatory-index');
  const file = () => path.join(dir, fs.readdirSync(dir).find((n) => /^index-v1-[0-9a-f]{16}\.sqlite$/.test(n) && !n.includes('-0000000000000000.')));
  const read = (sql, ...args) => {
    const db = new (require('node:sqlite').DatabaseSync)(file(), { readOnly: true });
    try {
      return db.prepare(sql).all(...args).map((r) => ({ ...r }));
    } finally {
      db.close();
    }
  };
  const write = (sql, ...args) => {
    const db = new (require('node:sqlite').DatabaseSync)(file());
    try {
      db.prepare(sql).run(...args);
    } finally {
      db.close();
    }
  };
  const compactNext = () => write("INSERT INTO meta (key, value) VALUES ('records_compact', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");
  const records = path.join(f.env.CLAUDE_CONFIG_DIR, 'claude-observatory', 'records');
  const segments = () => fs.readdirSync(records).filter((h) => /^[0-9a-f]{12}$/.test(h)).flatMap((h) => fs.readdirSync(path.join(records, h)).map((s) => path.join(records, h, s)));
  const log = () => segments().map((s) => fs.readFileSync(s, 'utf8')).join('');
  return { read, write, compactNext, records, segments, log };
}

// `oak demo --clean` removes every trace: the demo's sessions are forgotten in the local index at once, their full-text
// entries and usage with them (the simulator's turns were never billed), and the record log, which never carries the
// simulator's sessions, carries none in a base a compaction writes, while the demo runs or after.
test('oak demo --clean forgets the demo in the local index, its usage with it, and no compaction carries it into the record log', { skip }, (t) => {
  const f = fixture(t);
  f.claude('fixture-real', f.work, [ask('Real work stays'), reply('r1', 'ok')]);
  assert.equal(f.cli(['demo', '--fast']).status, 0);
  const x = indexAndLog(f);
  assert.equal(f.json(['sessions', '--json']).status, 0);
  const demo = x.read("SELECT DISTINCT session_id FROM prompts WHERE session_id LIKE 'demo-%'").map((r) => r.session_id);
  assert.ok(demo.length, 'control: the demo is indexed while it runs');
  const word = x.read('SELECT text FROM prompts WHERE session_id = ? ORDER BY idx LIMIT 1', demo[0])[0].text.match(/[A-Za-z]{6,}/)[0];
  const hits = () => x.read('SELECT count(*) AS n FROM prompts_fts WHERE prompts_fts MATCH ?', word)[0].n;
  assert.ok(hits() > 0, `control: "${word}" is searchable while it runs`);
  assert.ok(x.read("SELECT count(*) AS n FROM usage_messages WHERE session_id LIKE 'demo-%'")[0].n > 0, 'control: its usage is counted while it runs');
  x.compactNext();
  assert.equal(f.json(['sessions', '--json']).status, 0);
  assert.ok(x.segments().some((s) => s.endsWith('-base.jsonl')) && x.log().includes('fixture-real'), 'control: a base was written, this machine\'s session in it');
  assert.ok(!x.log().includes('demo-'), 'no base carries the demo while it runs');
  assert.equal(f.cli(['demo', '--clean']).status, 0);
  // Forgotten by the cleanup itself, before any catch-up.
  for (const table of ['sessions', 'prompts', 'actions', 'edits', 'usage_messages', 'usage_spend']) {
    assert.equal(x.read(`SELECT count(*) AS n FROM ${table} WHERE session_id LIKE 'demo-%'`)[0].n, 0, `${table} holds nothing of the demo`);
  }
  assert.equal(hits(), 0, `"${word}" is no longer searchable`);
  assert.equal(x.read("SELECT count(*) AS n FROM usage_messages WHERE session_id = ''")[0].n, 0, 'nor is its usage kept without its session');
  assert.notEqual(x.read("SELECT value FROM meta WHERE key = 'records_compact'")[0]?.value, '1', 'nor asks a compaction of a log it was never in: every other machine would pull the base again');
  x.compactNext();
  assert.deepEqual(f.json(['query', 'sql', "SELECT session_id FROM sessions WHERE session_id LIKE 'demo-%'"]).out.rows, [], 'a catch-up brings none of it back');
  assert.ok(!x.log().includes('demo-'), 'nor does the next compaction');
});

// A demo removed where no index could hear of it (an editor whose Node has no node:sqlite runs the cleanup in-process):
// the next catch-up forgets it rather than archive it.
test('a demo removed where the index was not available is forgotten at the next catch-up, never archived', { skip }, (t) => {
  const f = fixture(t);
  assert.equal(f.cli(['demo', '--fast']).status, 0);
  const x = indexAndLog(f);
  assert.equal(f.json(['sessions', '--json']).status, 0);
  assert.ok(x.read("SELECT count(*) AS n FROM sessions WHERE session_id LIKE 'demo-%'")[0].n > 0, 'control: indexed');
  assert.equal(f.cli(['demo', '--clean'], { env: { OAK_INDEX: 'off' } }).status, 0);
  assert.ok(x.read("SELECT count(*) AS n FROM sessions WHERE session_id LIKE 'demo-%'")[0].n > 0, 'control: the cleanup could not reach the index');
  assert.equal(f.json(['sessions', '--json']).status, 0);
  for (const table of ['sessions', 'prompts', 'usage_messages']) assert.equal(x.read(`SELECT count(*) AS n FROM ${table} WHERE session_id LIKE 'demo-%'`)[0].n, 0, table);
});

// An index an earlier build kept: its demo cleanup archived the simulator's sessions, their prompts and usage with them,
// and a compaction carried them into this machine's record log, which that index read. This build's first read forgets
// them, even with nothing else to do, and the compaction it asks writes a base without them; it looks for them once in
// each index.
test('the demo sessions an earlier build archived are forgotten at the first read, and out of the record log after the compaction it asks', { skip }, (t) => {
  const f = fixture(t);
  f.claude('fixture-real', f.work, [ask('Real work stays'), reply('r1', 'ok')]);
  assert.equal(f.cli(['demo', '--fast']).status, 0);
  assert.equal(f.json(['sessions', '--json']).status, 0);
  const x = indexAndLog(f);
  const demo = x.read("SELECT DISTINCT session_id FROM sessions WHERE session_id LIKE 'demo-%'").map((r) => r.session_id);
  assert.ok(demo.length, 'control: indexed');
  assert.equal(x.read("SELECT value FROM meta WHERE key = 'demo_archive_swept'")[0]?.value, '1', 'control: a full catch-up of this build looked once');
  assert.equal(f.cli(['demo', '--clean'], { env: { OAK_INDEX: 'off' } }).status, 0);
  // As the earlier build left it: archived, not forgotten; a line of its base naming it, which its index had read; not
  // looked for yet; and a catch-up a moment ago, so that a read has nothing else to do.
  x.write("UPDATE sessions SET archived_ms = ?, archived_reason = 'cleaned' WHERE session_id LIKE 'demo-%'", Date.now());
  x.write("DELETE FROM meta WHERE key = 'demo_archive_swept'");
  const seg = x.segments().find((s) => fs.readFileSync(s, 'utf8').includes('"fixture-real"'));
  const planted = fs.readFileSync(seg, 'utf8').split('\n').find((l) => l.includes('"fixture-real"')).replaceAll('fixture-real', demo[0]) + '\n';
  const body = fs.readFileSync(seg, 'utf8') + planted;
  const base = seg.replace(/\.jsonl$/, '-base.jsonl');
  const head = JSON.stringify({ t: 'base', bytes: Buffer.byteLength(body), at: Date.now(), v: 1 });
  fs.writeFileSync(base, head.padEnd(255) + '\n' + body);
  fs.rmSync(seg);
  const host = path.basename(path.dirname(seg));
  const st = JSON.parse(x.read('SELECT state FROM ingest_state WHERE source = ?', `records:${host}`)[0].state);
  delete st.read[path.basename(seg)];
  st.base = path.basename(base);
  st.read[st.base] = fs.statSync(base).size;
  x.write('UPDATE ingest_state SET state = ? WHERE source = ?', JSON.stringify(st), `records:${host}`);
  // …and another machine's demo, which that build read from that machine's log.
  x.write("INSERT INTO sessions (machine_id, session_id, agent, origin, listed, review, workspace, last_active_ms, inputs, updated_ms, synced_ms) VALUES ('0a0b0c0d0e0f', 'demo-0f0e0d0c', 'claude', 'synced', 1, 0, '', ?, '', ?, ?)", Date.now(), Date.now(), Date.now());
  x.write("UPDATE meta SET value = ? WHERE key = 'caught_up_ms'", String(Date.now()));
  assert.ok(x.read("SELECT count(*) AS n FROM prompts WHERE session_id LIKE 'demo-%'")[0].n > 0 && x.log().includes(demo[0]), 'control: kept, and in the log');
  assert.equal(f.json(['sessions', '--json']).status, 0);
  for (const table of ['sessions', 'prompts', 'usage_messages']) assert.equal(x.read(`SELECT count(*) AS n FROM ${table} WHERE session_id LIKE 'demo-%'`)[0].n, 0, `${table}: forgotten`);
  assert.equal(x.read("SELECT count(*) AS n FROM usage_messages WHERE session_id = ''")[0].n, 0, 'its usage with it, never billed');
  assert.ok(!x.log().includes('demo-'), 'the compaction it asked wrote a base without it');
  assert.ok(x.log().includes('"fixture-real"'), 'control: with this machine\'s session');
  assert.equal(x.read("SELECT value FROM meta WHERE key = 'demo_archive_swept'")[0]?.value, '1');
});

// `oak uninstall --purge-store` forgets the sessions it purges as a deliberate delete forgets them: in the index at once,
// and in this machine's record log, whose purge oak sync carries to the other machines. What their transcripts still hold
// is the files' to say, as for any session; what their stores held is gone. The teardown names the record logs.
test('oak uninstall --purge-store forgets what it purges in the local index and the record log, and names the record logs', { skip }, (t) => {
  const f = fixture(t);
  f.claude('fixture-purged', f.work, [ask('Teach the quokkacorn tokenizer'), reply('q1', 'Taught.')]);
  f.claude('fixture-also', f.work, [ask('Teach the wallabycorn lexer'), reply('w1', 'Taught.')]);
  for (const id of ['fixture-purged', 'fixture-also']) {
    const store = path.join(f.env.CLAUDE_CONFIG_DIR, 'claude-observatory', id);
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, 'log.jsonl'), JSON.stringify({ id: 1, uid: `u-${id}`, ts: Date.now() - 1000, tool: 'Edit', file: path.join(f.work, `${id}.ts`), beforeBlob: null, afterBlob: null, status: 'kept' }) + '\n');
  }
  // The demo running beside them: its sessions are in the store too.
  assert.equal(f.cli(['demo', '--fast']).status, 0);
  const x = indexAndLog(f);
  assert.equal(f.json(['query', 'edits']).out.rows.filter((r) => r.session.startsWith('fixture-')).length, 2, 'control: their edits are indexed');
  assert.ok(x.log().includes('fixture-purged') && x.log().includes('fixture-also'), 'control: and published');
  assert.ok(x.read("SELECT count(*) AS n FROM usage_messages WHERE session_id LIKE 'demo-%'")[0].n > 0, 'control: the demo\'s usage is counted while it runs');
  // An index file of the store before a move, kept until `oak clean` removes it: the purge reaches it too.
  const superseded = path.join(f.env.CLAUDE_CONFIG_DIR, 'claude-observatory-index', 'index-v1-0000000000000000.sqlite');
  x.write('VACUUM INTO ?', superseded);
  const inSuperseded = () => {
    const db = new (require('node:sqlite').DatabaseSync)(superseded, { readOnly: true });
    try {
      return ['sessions', 'prompts', 'edits'].map((table) => db.prepare(`SELECT count(*) AS n FROM ${table} WHERE session_id IN ('fixture-purged', 'fixture-also')`).get().n);
    } finally {
      db.close();
    }
  };
  assert.ok(inSuperseded().every((n) => n > 0), 'control: the superseded file holds both');
  const un = f.cli(['uninstall', '--all', '--purge-store']);
  assert.equal(un.status, 0, un.stderr);
  const purged = Number(/purged the store \((\d+) session\(s\)\)/.exec(un.stdout)?.[1]);
  assert.ok(purged > 2, un.stdout);
  for (const id of ['fixture-purged', 'fixture-also']) {
    for (const table of ['sessions', 'prompts', 'edits']) assert.equal(x.read(`SELECT count(*) AS n FROM ${table} WHERE session_id = ?`, id)[0].n, 0, `${id} ${table}: forgotten at once`);
    assert.ok(x.log().includes(JSON.stringify({ t: 'purge', s: id })), `${id}: the purge is in this machine's record log, for the other machines`);
  }
  assert.equal(x.read("SELECT count(*) AS n FROM prompts_fts WHERE prompts_fts MATCH 'quokkacorn OR wallabycorn'")[0].n, 0, 'their full-text entries too');
  assert.deepEqual(inSuperseded(), [0, 0, 0], 'and in the superseded index file');
  // The account was billed for their turns: their usage stays, without the sessions. The demo's never was: it goes.
  assert.deepEqual(x.read("SELECT message_id, session_id FROM usage_messages WHERE message_id IN ('q1', 'w1') ORDER BY message_id"), [{ message_id: 'q1', session_id: '' }, { message_id: 'w1', session_id: '' }]);
  assert.equal(x.read("SELECT count(*) AS n FROM usage_messages WHERE session_id LIKE 'demo-%'")[0].n, 0, 'the demo\'s usage goes');
  assert.match(un.stdout, new RegExp(`Record logs: delete ${x.records.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} {2}\\(`), 'the teardown names the record logs');
  // Their stores are gone, and so are their edits for good; their transcripts are listed as the files list them, and their
  // usage is theirs again.
  assert.equal(f.json(['query', 'edits', '--all']).out.rows.filter((r) => r.session.startsWith('fixture-')).length, 0);
  assert.deepEqual(f.json(['sessions', '--json']).out, f.json(['sessions', '--json'], { env: { OAK_INDEX: 'off' } }).out);
  assert.deepEqual(x.read("SELECT message_id, session_id FROM usage_messages WHERE message_id IN ('q1', 'w1') ORDER BY message_id"), [{ message_id: 'q1', session_id: 'fixture-purged' }, { message_id: 'w1', session_id: 'fixture-also' }]);
});

// The index moved aside (as `oak doctor` advises for a damaged one) or its folder deleted, this machine's record log
// left: the purge still reaches the log, so a new index reads nothing of the purged session back from it.
test('oak uninstall --purge-store forgets in the record log where the index file was removed', { skip }, (t) => {
  const f = fixture(t);
  f.claude('fixture-purged', f.work, [ask('Teach the quokkacorn tokenizer'), reply('q1', 'Taught.')]);
  const store = path.join(f.env.CLAUDE_CONFIG_DIR, 'claude-observatory', 'fixture-purged');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'log.jsonl'), JSON.stringify({ id: 1, uid: 'u', ts: Date.now() - 1000, tool: 'Edit', file: path.join(f.work, 'a.ts'), beforeBlob: null, afterBlob: null, status: 'kept' }) + '\n');
  const x = indexAndLog(f);
  assert.equal(f.json(['query', 'edits']).out.rowCount, 1, 'control: its edit is indexed');
  assert.ok(x.log().includes('fixture-purged'), 'control: and published');
  fs.rmSync(path.join(f.env.CLAUDE_CONFIG_DIR, 'claude-observatory-index'), { recursive: true });
  const un = f.cli(['uninstall', '--all', '--purge-store']);
  assert.equal(un.status, 0, un.stderr);
  assert.ok(x.log().includes(JSON.stringify({ t: 'purge', s: 'fixture-purged' })), 'the purge is in this machine\'s record log');
  assert.equal(f.json(['query', 'edits', '--all']).out.rows.filter((r) => r.session === 'fixture-purged').length, 0, 'a new index reads nothing of it back');
});

// An index this OAK cannot open (a damaged file): the purge still reaches this machine's record log, and the uninstall
// says why the index was not reached. Once the file is moved aside, as `oak doctor` advises, the new index reads nothing
// of the purged session back.
test('oak uninstall --purge-store forgets in the record log where the index cannot be opened, and says so', { skip }, (t) => {
  const f = fixture(t);
  f.claude('fixture-purged', f.work, [ask('Teach the quokkacorn tokenizer'), reply('q1', 'Taught.')]);
  const store = path.join(f.env.CLAUDE_CONFIG_DIR, 'claude-observatory', 'fixture-purged');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'log.jsonl'), JSON.stringify({ id: 1, uid: 'u', ts: Date.now() - 1000, tool: 'Edit', file: path.join(f.work, 'a.ts'), beforeBlob: null, afterBlob: null, status: 'kept' }) + '\n');
  const x = indexAndLog(f);
  assert.equal(f.json(['query', 'edits']).out.rowCount, 1, 'control: its edit is indexed');
  const dir = path.join(f.env.CLAUDE_CONFIG_DIR, 'claude-observatory-index');
  const file = path.join(dir, fs.readdirSync(dir).find((n) => /^index-v1-[0-9a-f]{16}\.sqlite$/.test(n)));
  for (const ext of ['-wal', '-shm']) fs.rmSync(file + ext, { force: true });
  const fd = fs.openSync(file, 'r+');
  fs.writeSync(fd, Buffer.alloc(4096, 0x5a), 0, 4096, 0);
  fs.closeSync(fd);
  assert.match(f.json(['query', '--status', '--json']).out.reason ?? '', /malformed|not a database/, 'control: the index cannot be opened');
  const un = f.cli(['uninstall', '--all', '--purge-store']);
  assert.equal(un.status, 0, un.stderr);
  assert.match(un.stdout, /the local database could not be opened \(.*(malformed|not a database).*\): the sessions purged are forgotten in this machine's record log/);
  assert.ok(x.log().includes(JSON.stringify({ t: 'purge', s: 'fixture-purged' })), 'the purge is in this machine\'s record log');
  fs.renameSync(file, `${file}.aside`);
  assert.equal(f.json(['query', 'edits', '--all']).out.rows.filter((r) => r.session === 'fixture-purged').length, 0, 'a new index reads nothing of it back');
});

// A machine whose OAK never built a local index (no listing ran on a Node that runs it): the uninstall makes none, and
// no record log, to forget what it purges in.
test('oak uninstall --purge-store makes no local index or record log where there was none', { skip }, (t) => {
  const f = fixture(t);
  const store = path.join(f.env.CLAUDE_CONFIG_DIR, 'claude-observatory', 'store-only');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'log.jsonl'), JSON.stringify({ id: 1, uid: 'u', ts: Date.now() - 1000, tool: 'Edit', file: path.join(f.work, 'a.ts'), beforeBlob: null, afterBlob: null, status: 'kept' }) + '\n');
  const un = f.cli(['uninstall', '--all', '--purge-store']);
  assert.equal(un.status, 0, un.stderr);
  assert.match(un.stdout, /purged the store \(1 session\(s\)\)/);
  assert.ok(!fs.existsSync(store), 'control: purged');
  for (const made of ['claude-observatory-index', path.join('claude-observatory', 'records')]) assert.ok(!fs.existsSync(path.join(f.env.CLAUDE_CONFIG_DIR, made)), `no ${made}`);
  assert.doesNotMatch(un.stdout, /Local database|Record logs/);
});

// The old listing takes the sessions it discovers (a transcript, a rollout its Codex scan takes) and those with a store;
// a Codex run whose temp-dir workspace is gone is in neither. The index took in every rollout, and listed 43 such runs on
// a real machine that the files listed none of: those whose folder went before the index read them, and those whose
// folder went after (nothing they were read from changed, so only the listing can notice).
test('a Codex run whose temp folder is gone is left out from the index as from the files, gone before or after the index read it', { skip }, (t) => {
  const f = fixture(t);
  f.claude('fixture-control', f.work, [ask('Keep the control'), reply('c1', 'Kept.')]);
  const rollout = (id, cwd) => {
    const base = path.join(f.env.CODEX_HOME, 'sessions', '2026', '10', '01');
    fs.mkdirSync(base, { recursive: true });
    const recs = [
      { type: 'session_meta', payload: { id, cwd } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Run ${id}` }] } },
      { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } } } },
    ];
    fs.writeFileSync(path.join(base, `rollout-2026-10-01T10-00-00-${id}.jsonl`), recs.map((r) => JSON.stringify({ timestamp: at(), ...r })).join('\n') + '\n');
  };
  const BEFORE = '0199a000-0000-7000-8000-0000000000c1';
  const AFTER = '0199a000-0000-7000-8000-0000000000c2';
  const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-gone-before-'));
  const later = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-gone-after-'));
  t.after(() => { for (const d of [gone, later]) fs.rmSync(d, { recursive: true, force: true }); });
  rollout(BEFORE, gone);
  fs.rmSync(gone, { recursive: true, force: true }); // gone before the index reads it
  rollout(AFTER, later);
  assert.equal(f.json(['sessions', '--json']).status, 0); // builds the index
  // Positive control that the listings below are the index's: a value planted in it shows.
  const dir = path.join(f.env.CLAUDE_CONFIG_DIR, 'claude-observatory-index');
  const [file] = fs.readdirSync(dir).filter((n) => /^index-v1-.*\.sqlite$/.test(n));
  const db = new (require('node:sqlite').DatabaseSync)(path.join(dir, file));
  db.prepare("UPDATE sessions SET facts = json_set(facts, '$.tokens', 424242) WHERE session_id = 'fixture-control'").run();
  db.close();
  const listing = (env) => f.json(['sessions', '--json'], { env }).out.sessions;
  const ids = (rows) => rows.map((r) => r.id).sort();
  let rows = listing();
  assert.equal(rows.find((r) => r.id === 'fixture-control')?.tokens, 424242, 'positive control: the listing is the index\'s');
  assert.deepEqual(ids(listing({ OAK_INDEX: 'off' })), [AFTER, 'fixture-control'].sort(), 'control: the files list the run whose folder is there');
  assert.deepEqual(ids(rows), [AFTER, 'fixture-control'].sort(), 'the index lists the same, not the run whose folder had gone');
  fs.rmSync(later, { recursive: true, force: true }); // gone after the index read it
  rows = listing();
  assert.equal(rows.find((r) => r.id === 'fixture-control')?.tokens, 424242, 'positive control: still the index\'s');
  assert.deepEqual(ids(rows), ['fixture-control'], 'the run whose folder went after the index read it is left out too');
  assert.deepEqual(ids(listing({ OAK_INDEX: 'off' })), ['fixture-control'], 'as the files leave it out');
});

test('oak usage --window: a window\'s tokens by model, session or day from the index, each message once at its largest snapshot, cache reads apart; a bad window exits 2', { skip }, (t) => {
  const f = fixture(t);
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const turn = (id, ms, model, usage) => ({ type: 'assistant', timestamp: ago(ms), message: { id, role: 'assistant', model, content: [{ type: 'text', text: id }], usage } });
  const u1 = f.claude('fixture-u1', f.work, [{ type: 'user', timestamp: ago(3_600_000), message: { role: 'user', content: 'Count the tokens' } },
    turn('u1', 3_500_000, 'claude-opus-4-8', { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5000 }),
    turn('u1', 3_400_000, 'claude-opus-4-8', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 5000 }), // the same message, grown
    turn('u2', 3_000_000, 'claude-sonnet-4-6', { input_tokens: 200, output_tokens: 20, cache_creation_input_tokens: 300 })]);
  // Ten days ago: outside the week, inside the month.
  const old = f.claude('fixture-u2', f.work, [{ type: 'user', timestamp: ago(864_000_000), message: { role: 'user', content: 'Long ago' } },
    turn('u3', 863_990_000, 'claude-opus-4-8', { input_tokens: 9000, output_tokens: 1 })]);
  fs.utimesSync(old, new Date(Date.now() - 864_000_000), new Date(Date.now() - 864_000_000));
  let r = f.json(['usage', '--window', 'week', '--by', 'model', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([r.out.query, r.out.params.window, r.out.params.by], ['usage', 'week', 'model']);
  assert.deepEqual(r.out.rows.map((x) => [x.key, x.messages, x.tokens, x.cache_read]), [['claude-sonnet-4-6', 1, 520, 0], ['claude-opus-4-8', 1, 150, 5000]]);
  r = f.json(['usage', '--window', 'all', '--by', 'model', '--json']);
  assert.deepEqual(r.out.rows.map((x) => [x.key, x.tokens]), [['claude-opus-4-8', 9151], ['claude-sonnet-4-6', 520]], 'the old message too');
  // An agent the session started: its row counts the agent's turns, and the line under it is the session's own.
  const sub = path.join(path.dirname(u1), 'fixture-u1', 'subagents', 'agent-k1.jsonl');
  fs.mkdirSync(path.dirname(sub), { recursive: true });
  fs.writeFileSync(sub, JSON.stringify({ isSidechain: true, ...turn('k1', 3_200_000, 'claude-opus-4-8', { input_tokens: 20, output_tokens: 10 }) }) + '\n');
  const text = f.cli(['usage', '--window', 'week', '--by', 'session']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^usage · week · by session/);
  assert.match(text.stdout, /cache reads are counted apart; ~\$ is an estimate at today's API list prices, not a bill/);
  assert.match(text.stdout, /^\s+700\s+↺5\.0K\s+~\$0\.01\s+Count the tokens · with 1 agent\n\s+670\s+↺5\.0K\s+~\$0\.01\s+own$/m);
  assert.match(f.cli(['usage', '--since', '3d', '--by', 'model']).stdout, /^usage · since · by model/, 'a span --since places is no window');
  r = f.json(['usage', '--window', 'fortnight', '--json']);
  assert.deepEqual([r.status, r.out.error.code], [2, 'bad_param']);
  r = f.json(['usage', '--window', 'week', '--by', 'colour', '--json']);
  assert.deepEqual([r.status, r.out.error.code], [2, 'bad_param']);
});

// A session whose transcript is gone while its store stays (an "audit log" session): `oak prompts` lists its asks and
// answers from the local index, never another session's, by either spelling of `--session`; with the index off it says
// why it has none.
test('oak prompts: a session whose transcript is gone lists its asks and answers from the index, never another session\'s', { skip }, (t) => {
  const f = fixture(t);
  const turns = [ask('Teach the zebracorn lexer'), reply('g1', 'Taught the lexer.'), ask('Now the parser'), reply('g2', 'Parser done.')];
  const file = f.claude('fixture-gone', f.work, turns);
  f.claude('fixture-newer', f.work, [ask('A newer session ask'), reply('n1', 'Newer answer.')]);
  const store = path.join(f.env.CLAUDE_CONFIG_DIR, 'claude-observatory', 'fixture-gone');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'log.jsonl'), JSON.stringify({ id: 1, uid: 'u', ts: Date.parse(turns[1].timestamp) + 500, tool: 'Edit', file: path.join(f.work, 'a.ts'), beforeBlob: null, afterBlob: null, status: 'pending' }) + '\n');
  assert.equal(f.json(['query', 'prompts', '--session', 'fixture-gone']).out.rowCount, 2, 'the index read both asks while the transcript was there');
  fs.rmSync(file);
  for (const form of [['--session', 'fixture-gone'], ['--session=fixture-gone']]) {
    const r = f.json(['prompts', '--json', ...form]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.out.session, 'fixture-gone', form.join(' '));
    assert.deepEqual(r.out.prompts.map((p) => p.text), ['Teach the zebracorn lexer', 'Now the parser'], `${form.join(' ')}: this session's asks, from the index`);
    assert.equal(r.out.fromIndex, true, 'and it says where they came from');
    assert.equal(r.out.note, 'the transcript is gone; these asks and answers are what the local database kept of it');
    assert.deepEqual([r.out.prompts[0].edits, r.out.prompts[0].pending, r.out.prompts[1].edits], [1, 1, 0], 'the edit lands on the ask whose window holds it');
    assert.deepEqual([r.out.summary.total, r.out.summary.withEdits, r.out.summary.edits], [2, 1, 1]);
  }
  const resp = f.json(['prompts', '--json', '--session', 'fixture-gone', '--id', '2', '--response']);
  assert.equal(resp.out.response.text, 'Parser done.', 'the answer the index kept');
  const one = f.json(['prompts', '--json', '--session', 'fixture-gone', '--id', '1']);
  assert.equal(one.out.prompt.text, 'Teach the zebracorn lexer');
  // With the index off there is nothing to list from, and the reason is the CLI's own.
  const off = f.json(['prompts', '--json', '--session', 'fixture-gone'], { env: { OAK_INDEX: 'off' } });
  assert.deepEqual([off.out.transcript, off.out.error], [null, 'no transcript found for this session under this directory']);
  // An id nothing knows never falls back to the newest session, in either spelling.
  for (const form of [['--session', 'fixture-nowhere'], ['--session=fixture-nowhere']]) {
    const r = f.json(['prompts', '--json', ...form]);
    assert.equal(r.out.session, 'fixture-nowhere');
    assert.equal(r.out.prompts, undefined, form.join(' '));
    assert.equal(r.out.error, 'no transcript found for this session under this directory');
  }
});

// The Timeline runs `oak prompts` for its pin beside the `oak sessions` that lists the selector, on every refresh. A pin
// whose transcript is not here reads the index as the last catch-up left it: a catch-up of its own would derive the
// store's Codex rollouts beside the listing's, and a deriver that finds the other's derivation half written indexes what
// it read of it.
test('oak prompts: a session whose transcript is not here reads the index without catching it up', { skip }, (t) => {
  const f = fixture(t);
  f.claude('fixture-first', f.work, [ask('The first ask'), reply('f1', 'First answer.')]);
  const listed = () => f.json(['query', 'sessions']).out.rows.map((x) => x.id).sort();
  assert.deepEqual(listed(), ['fixture-first']);
  const dir = path.join(f.env.CLAUDE_CONFIG_DIR, 'claude-observatory-index');
  const [name] = fs.readdirSync(dir).filter((n) => /^index-v\d+-[0-9a-f]{16}\.sqlite$/.test(n));
  const indexed = () => {
    const db = new (require('node:sqlite').DatabaseSync)(path.join(dir, name), { readOnly: true });
    try { return db.prepare('SELECT session_id FROM sessions ORDER BY session_id').all().map((r) => r.session_id); } finally { db.close(); }
  };
  f.claude('fixture-later', f.work, [ask('A later ask'), reply('l1', 'Later answer.')]);
  const r = f.json(['prompts', '--json', '--session', 'fixture-nowhere']);
  assert.equal(r.out.error, 'no transcript found for this session under this directory');
  assert.deepEqual(indexed(), ['fixture-first'], 'oak prompts left the index as it found it');
  assert.deepEqual(listed(), ['fixture-first', 'fixture-later'], 'the listing\'s catch-up reads the later session (the check sees a catch-up)');
  assert.deepEqual(indexed(), ['fixture-first', 'fixture-later']);
});

test('oak usage --breakdown --by session: a session that started agents reads as its own, with the figure with its agents under it', (t) => {
  const f = fixture(t);
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const turn = (id, usage) => ({ type: 'assistant', timestamp: at, message: { id, role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: id }], usage } });
  const file = f.claude('fixture-bd1', f.work, [{ type: 'user', timestamp: at, message: { role: 'user', content: 'Fan out' } }, turn('b1', { input_tokens: 600, output_tokens: 70 })]);
  const sub = path.join(path.dirname(file), 'fixture-bd1', 'subagents', 'agent-k1.jsonl');
  fs.mkdirSync(path.dirname(sub), { recursive: true });
  fs.writeFileSync(sub, JSON.stringify({ isSidechain: true, ...turn('k1', { input_tokens: 20, output_tokens: 10 }) }) + '\n');
  const text = f.cli(['usage', '--breakdown', '--by', 'session', '--agent', 'claude']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^~\$ are estimates at today's API list prices, not a bill/m);
  assert.match(text.stdout, /^ {2}fixture-… \(.+\) · own +670 tok .* 1 msgs\n {4}with 1 agent +700 tok .* 2 msgs$/m);
  assert.match(text.stdout, /^ {2}agent-k1… \(agent of fixture-…\) +30 tok /m);
});
