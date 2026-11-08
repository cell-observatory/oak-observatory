// The local index (core src/index): its location, runtime and schema; catching up with the files on disk; the archive
// that outlives a session's files; the listings it serves with parity to the old ones; `oak query`'s guards.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gitDir: makeGitDir } = require('../../../test/fixtures/git.cjs');
const cp = require('node:child_process');
const core = require(process.env.OAK_INDEX_TEST_DIST || '../dist');
const { indexFixture, assertKilled, ask, reply, text, thinking, cxUser } = require('./fixtures/index-fixture.cjs');

const DIST = path.dirname(require.resolve(process.env.OAK_INDEX_TEST_DIST || '../dist'));
const available = core.indexRuntime().ok;
const skip = !available && `no node:sqlite with FTS5 in ${process.version}`;

/** Open the index and catch it up whole (no reader budget). */
function caughtUp(opts = {}) {
  const ix = core.useIndex({ budgetMs: Infinity, inlineBytes: Infinity, ...opts });
  assert.ok(ix.ok, ix.reason);
  assert.equal(ix.catchUp.caughtUp, true, `caught up: ${JSON.stringify(ix.catchUp)}`);
  return ix;
}

function withIndex(fn) {
  const ix = caughtUp();
  try {
    return fn(ix.db, ix);
  } finally {
    ix.close();
  }
}

const rows = (db, sql, ...args) => db.prepare(sql).all(...args);
const one = (db, sql, ...args) => db.prepare(sql).get(...args);

/** The listing from the index, checked against the old listing. */
function listingParity(cwd, reviewing, opts) {
  return withIndex((db) => {
    const fromIndex = core.indexedSessionMeta(db, cwd, reviewing, opts);
    assert.deepEqual(fromIndex, core.sessionMeta(cwd, reviewing, opts), 'the index lists what the files list');
    return fromIndex;
  });
}

function searchParity(cwd, query, opts) {
  return withIndex((db) => {
    const strip = (r) => ({ ...r, ms: 0, indexed: 0 });
    const fromIndex = core.indexedSearch(db, cwd, query, opts);
    assert.deepEqual(strip(fromIndex), strip(core.searchConversations(cwd, query, opts)), `search "${query}" finds what the files find`);
    return fromIndex;
  });
}

// --- runtime, location, schema ----------------------------------------------------------------------------------

test('index: first WAL open waits for a writer to release its lock', { skip }, async (t) => {
  const f = indexFixture(t, core);
  const file = path.join(f.dir, 'locked.sqlite');
  const { DatabaseSync } = require('node:sqlite');
  const { Worker } = require('node:worker_threads');
  const reader = new DatabaseSync(file);
  // Its COMMIT waits out the opener's brief lock on each WAL attempt, as OAK's own connections do.
  reader.exec('PRAGMA busy_timeout = 5000');
  reader.exec('CREATE TABLE probe(x); INSERT INTO probe VALUES (1); BEGIN IMMEDIATE; INSERT INTO probe VALUES (2)');
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const core = require(workerData.dist);
    const { DatabaseSync } = require('node:sqlite');
    const exec = DatabaseSync.prototype.exec;
    let announced = false;
    DatabaseSync.prototype.exec = function(sql) {
      if (sql === 'PRAGMA journal_mode = WAL' && !announced) { announced = true; parentPort.postMessage('opening'); }
      return exec.call(this, sql);
    };
    const start = Date.now();
    const ix = core.openIndex(workerData.file);
    parentPort.postMessage({ ok: ix.ok, reason: ix.reason, elapsed: Date.now() - start,
      mode: ix.ok && ix.db.prepare('PRAGMA journal_mode').get().journal_mode,
      integrity: ix.ok && ix.db.prepare('PRAGMA integrity_check').get().integrity_check });
    if (ix.ok) ix.close();
  `, { eval: true, workerData: { file, dist: DIST } });
  let release;
  const released = new Promise(resolve => { release = resolve; });
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      worker.on('error', reject);
      worker.on('message', (m) => {
        if (m === 'opening') setTimeout(() => { reader.exec('COMMIT'); release(); }, 250);
        else resolve(m);
      });
    });
    await released;
  } finally {
    // Closed before the fixture's after hook removes the folder: Windows deletes no file a handle holds open.
    await worker.terminate();
    reader.close();
  }
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.mode, 'wal');
  assert.equal(result.integrity, 'ok');
  assert.ok(result.elapsed >= 200 && result.elapsed < 5000, `waited ${result.elapsed} ms`);
});

test('index: lives beside the config, outside the movable store, one file per store and format', { skip }, (t) => {
  const f = indexFixture(t, core);
  const file = core.indexFile();
  assert.equal(path.dirname(file), path.join(process.env.CLAUDE_CONFIG_DIR, 'claude-observatory-index'));
  assert.match(path.basename(file), /^index-v1-[0-9a-f]{16}\.sqlite$/);
  assert.ok(!file.startsWith(core.rootDir() + path.sep), 'never inside the store root');
  // A store moved elsewhere keys a file of its own.
  const before = core.storeKey();
  core.writePrefs({ ...core.readPrefs(), storeDir: path.join(f.dir, 'moved-store') });
  core.clearRootMemo();
  assert.notEqual(core.storeKey(), before);
  assert.equal(core.storeKey(path.join(f.dir, 'moved-store')), core.storeKey());
});

test('index: the file and its folder are private (0600 and 0700), with SQLite\'s own files open beside it', { skip: skip || (process.platform === 'win32' && 'POSIX modes') }, (t) => {
  indexFixture(t, core);
  const ix = caughtUp();
  try {
    ix.db.exec('CREATE TEMP TABLE w(x); INSERT INTO meta (key, value) VALUES (\'probe\', \'1\') ON CONFLICT(key) DO UPDATE SET value = \'2\'');
    const dir = core.indexDir();
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    const files = fs.readdirSync(dir).filter((n) => n.startsWith('index-v'));
    assert.ok(files.some((n) => n.endsWith('-wal')), `the write-ahead log is there while it is open: ${files}`);
    for (const n of files) assert.equal(fs.statSync(path.join(dir, n)).mode & 0o777, 0o600, `${n} is 0600`);
    assert.equal(one(ix.db, 'PRAGMA secure_delete').secure_delete, 1);
    assert.equal(one(ix.db, 'PRAGMA journal_mode').journal_mode, 'wal');
  } finally {
    ix.close();
  }
});

test('index: unavailable without node:sqlite or FTS5, with the floor named; OAK_INDEX=off turns it off', (t) => {
  const f = indexFixture(t, core);
  const fake = path.join(f.dir, 'fake-sqlite.cjs');
  fs.writeFileSync(fake, `class DatabaseSync { constructor() {} prepare() { return { get: () => ({ v: '3.45.0' }) }; } exec(sql) { if (/fts5/i.test(sql)) throw new Error('no such module: fts5'); } close() {} }
module.exports = { DatabaseSync, constants: {} };`);
  process.env.OAK_INDEX_TEST_MODULE = fake;
  core.resetIndexRuntime();
  let rt = core.indexRuntime();
  assert.equal(rt.ok, false);
  assert.match(rt.reason, /no full-text search \(FTS5\).*; the database needs Node\.js 24 or newer$/);
  // `oak query --status` names the releases OAK supports to run it, beside the oldest.
  assert.deepEqual([core.indexStatus().floor, core.indexStatus().nodes], ['24.0.0', 'Node.js 24 or newer']);
  process.env.OAK_INDEX_TEST_MODULE = path.join(f.dir, 'absent.cjs');
  core.resetIndexRuntime();
  rt = core.indexRuntime();
  assert.match(rt.reason, /has no node:sqlite.*Node\.js 24 or newer/);
  // FTS5 from the system's SQLite, with the node:sqlite of a release before 22.16 (no StatementSync.columns).
  const older = path.join(f.dir, 'older-sqlite.cjs');
  fs.writeFileSync(older, `class DatabaseSync { constructor() {} prepare() { return { get: () => ({ v: '3.47.2', n: 1 }) }; } exec() {} close() {} }
class StatementSync {}
module.exports = { DatabaseSync, StatementSync, constants: {} };`);
  process.env.OAK_INDEX_TEST_MODULE = older;
  core.resetIndexRuntime();
  rt = core.indexRuntime();
  assert.equal(rt.ok, false);
  assert.match(rt.reason, /no StatementSync\.columns.*Node\.js 24 or newer/);
  delete process.env.OAK_INDEX_TEST_MODULE;
  process.env.OAK_INDEX = 'off';
  core.resetIndexRuntime();
  assert.equal(core.indexRuntime().ok, false);
  // Nothing fails: the listing is read the old way, and a query says why it has nothing.
  f.claude('fixture-off', f.work, [ask('A listed session'), reply('m1', [text('ok')])]);
  assert.equal(core.sessionMeta(f.work).sessions.length, 1);
  const q = core.queryIndex('sessions', {});
  assert.deepEqual([q.error?.code, core.failureExitCode(q)], ['index_unavailable', 3]);
  delete process.env.OAK_INDEX;
  core.resetIndexRuntime();
  if (available) assert.equal(core.indexRuntime().ok, true, 'positive control: back on, it is available');
});

test('index: loading node:sqlite drops only its ExperimentalWarning; every other warning still prints', (t) => {
  const f = indexFixture(t, core);
  const fake = path.join(f.dir, 'warning-sqlite.cjs');
  fs.writeFileSync(fake, `process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
process.emitWarning('Another feature is experimental', 'ExperimentalWarning');
process.emitWarning('a plain warning');
throw new Error('stop after the warnings');`);
  const r = cp.spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(DIST, 'index.js'))}).indexRuntime()`], {
    env: { ...process.env, OAK_INDEX_TEST_MODULE: fake }, encoding: 'utf8',
  });
  assert.doesNotMatch(r.stderr, /SQLite is an experimental/);
  assert.match(r.stderr, /Another feature is experimental/);
  assert.match(r.stderr, /a plain warning/);
});

test('index: schema version 1, every table STRICT; a file a newer OAK wrote is left alone', { skip }, (t) => {
  indexFixture(t, core);
  withIndex((db) => {
    assert.equal(one(db, 'PRAGMA user_version').user_version, core.SCHEMA_VERSION);
    const tables = rows(db, "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%_fts%' AND name NOT LIKE 'sqlite_%'");
    assert.ok(tables.length >= 20, `${tables.length} tables`);
    for (const tb of tables) assert.match(tb.sql, /\) STRICT$/, `${tb.name} is STRICT`);
    for (const name of [...core.SESSION_TABLES, 'machines', 'edit_facts', 'notes', 'tombstones', 'ingest_state']) assert.ok(tables.some((x) => x.name === name), name);
    for (const fts of ['sessions_fts', 'prompts_fts', 'comments_fts', 'notes_fts']) assert.ok(one(db, "SELECT 1 AS x FROM sqlite_master WHERE name = ?", fts), fts);
    db.exec(`PRAGMA user_version = ${core.SCHEMA_VERSION + 1}`);
  });
  const again = core.openIndex();
  assert.equal(again.ok, false);
  assert.match(again.reason, /newer OAK/);
});

// Schema version 4 makes raised hands records. An earlier build read past the hands in the other machines' logs (a table
// it did not know) without applying them: the upgrade reads those logs again from their start, once, and this machine's
// own hands again from its stores; this machine's own log, which holds nothing it lacks, stays where it was read.
test('index: older schemas and ingest facts migrate without losing the archive', { skip }, async (t) => {
  const { MIGRATIONS } = require(path.join(DIST, 'index/schema.js'));
  for (const version of [1, 2, 3, 4, 5]) await t.test(`schema ${version}`, (t) => {
    const f = indexFixture(t, core);
    f.claude('fixture-upgrade', f.work, [ask('Current title'), reply('u1', [text('Current answer')])]);
    const file = core.indexFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = new (require('node:sqlite').DatabaseSync)(file);
    old.exec(MIGRATIONS.slice(0, version).join('\n'));
    old.exec(`PRAGMA user_version = ${version}`);
    old.exec("INSERT INTO meta VALUES ('ingest_version', '1')");
    const machine = core.machineHostTag();
    old.prepare("INSERT INTO sessions (machine_id, session_id, agent, origin, title, inputs, updated_ms, archived_ms) VALUES (?, ?, 'claude', 'local', ?, 'old-facts', 1, ?)")
      .run(machine, 'fixture-upgrade', 'Stale title', null);
    old.prepare("INSERT INTO sessions (machine_id, session_id, agent, origin, title, updated_ms, archived_ms) VALUES (?, 'fixture-archive-upgrade', 'claude', 'local', 'Archived title', 1, 1)").run(machine);
    old.prepare("INSERT INTO prompts (machine_id, session_id, idx, ts, text, source) VALUES (?, 'fixture-archive-upgrade', 0, 1, 'archival zebracorn', 'hooks')").run(machine);
    old.close();
    withIndex((db) => {
      assert.equal(one(db, 'PRAGMA user_version').user_version, core.SCHEMA_VERSION);
      assert.equal(one(db, "SELECT value FROM meta WHERE key = 'ingest_version'").value, String(core.INGEST_VERSION));
      assert.equal(one(db, "SELECT title FROM sessions WHERE session_id = 'fixture-upgrade'").title, 'Current title');
      assert.equal(one(db, "SELECT title FROM sessions WHERE session_id = 'fixture-archive-upgrade'").title, 'Archived title');
      assert.equal(one(db, "SELECT count(*) AS n FROM prompts_fts WHERE prompts_fts MATCH 'zebracorn'").n, 1);
      assert.equal(one(db, 'PRAGMA integrity_check').integrity_check, 'ok');
    });
  });
});

test('index: the upgrade to schema 4 reads the other machines\' record logs again, and this machine\'s hands', { skip }, () => {
  const { DatabaseSync } = require('node:sqlite');
  const { MIGRATIONS } = require(path.join(DIST, 'index', 'schema.js'));
  const db = new DatabaseSync(':memory:');
  for (let v = 0; v < 3; v++) db.exec(MIGRATIONS[v]);
  db.prepare("INSERT INTO machines (machine_id, label, is_self) VALUES ('aaaaaaaaaaaa', 'this machine', 1), ('bbbbbbbbbbbb', 'build-box', 0)").run();
  const state = db.prepare("INSERT INTO ingest_state (source, kind, machine_id, session_id, state, updated_ms) VALUES (?, ?, ?, ?, '{}', 1)");
  state.run('records:aaaaaaaaaaaa', 'records', 'aaaaaaaaaaaa', null);
  state.run('records:bbbbbbbbbbbb', 'records', 'bbbbbbbbbbbb', null);
  state.run('unit:attention:aaaaaaaaaaaa:s1', 'unit', 'aaaaaaaaaaaa', 's1');
  state.run('unit:work:aaaaaaaaaaaa:s1', 'unit', 'aaaaaaaaaaaa', 's1');
  db.exec(MIGRATIONS[3]);
  assert.deepEqual(db.prepare('SELECT source FROM ingest_state ORDER BY source').all().map((r) => r.source), ['records:aaaaaaaaaaaa', 'unit:work:aaaaaaaaaaaa:s1']);
  db.close();
});

// Schema version 6 keeps each message's cache writes by lifetime and the price table that priced it. The upgrade keeps
// every row and day, marks them priced by no table (the next catch-up prices them), and reads every usage file again from
// its start, once, for the split; nothing else is read again.
test('index: the upgrade to schema 6 keeps the usage rows and days, priced by no table yet, and reads the usage files again (0.11.0)', { skip }, () => {
  const { DatabaseSync } = require('node:sqlite');
  const { MIGRATIONS } = require(path.join(DIST, 'index', 'schema.js'));
  const db = new DatabaseSync(':memory:');
  for (let v = 0; v < 5; v++) db.exec(MIGRATIONS[v]);
  db.prepare(`INSERT INTO usage_messages (message_id, agent, machine_id, session_id, model, ts, input, output, cache_create, cache_read, cost)
    VALUES ('m1', 'claude', 'aaaaaaaaaaaa', 's1', 'claude-opus-4-8', 1767225600000, 10, 20, 3000, 400, 0.5)`).run();
  const state = db.prepare("INSERT INTO ingest_state (source, kind, machine_id, session_id, state, updated_ms) VALUES (?, ?, ?, ?, 'done', 1)");
  state.run('usage:/x/s1.jsonl', 'usage', 'aaaaaaaaaaaa', 's1');
  state.run('codex-usage:/x/r.jsonl', 'codex-usage', 'aaaaaaaaaaaa', 's2');
  state.run('unit:usage:aaaaaaaaaaaa:s1', 'unit', 'aaaaaaaaaaaa', 's1');
  state.run('unit:deleted-usage:aaaaaaaaaaaa:s3', 'unit', 'aaaaaaaaaaaa', 's3');
  state.run('records:bbbbbbbbbbbb', 'records', 'bbbbbbbbbbbb', null);
  state.run('unit:work:aaaaaaaaaaaa:s1', 'unit', 'aaaaaaaaaaaa', 's1');
  db.exec(MIGRATIONS[5]);
  assert.deepEqual({ ...db.prepare('SELECT cost, cache_create_1h, provider, priced, cost_approx FROM usage_messages').get() }, { cost: 0.5, cache_create_1h: null, provider: null, priced: '', cost_approx: 0 });
  const day = () => ({ ...db.prepare('SELECT messages, cache_create, cache_create_1h, cost, cost_approx FROM usage_daily').get() });
  assert.deepEqual(day(), { messages: 1, cache_create: 3000, cache_create_1h: 0, cost: 0.5, cost_approx: 0 });
  // The day follows a row priced again, and its split.
  db.exec("UPDATE usage_messages SET cache_create_1h = 2000, cost = 0.25, cost_approx = 1, priced = 'v'");
  assert.deepEqual(day(), { messages: 1, cache_create: 3000, cache_create_1h: 2000, cost: 0.25, cost_approx: 1 });
  db.exec('DELETE FROM usage_messages');
  assert.equal(db.prepare('SELECT count(*) AS n FROM usage_daily').get().n, 0);
  assert.deepEqual(db.prepare('SELECT source FROM ingest_state ORDER BY source').all().map((r) => r.source), ['records:bbbbbbbbbbbb', 'unit:work:aaaaaaaaaaaa:s1']);
  db.close();
});

// A background build takes another pass when a kick claimed one after it began (a hook that moved a hand, whose own build
// found this one holding the lease); a claim dated ahead, a backoff, is no such kick.
test('index: a build takes another pass for a kick claimed after it began, never for a backoff', { skip }, (t) => {
  indexFixture(t, core);
  fs.mkdirSync(core.indexDir(), { recursive: true });
  const claim = path.join(core.indexDir(), 'build.kick');
  const began = Date.now() - 5000;
  const at = (ms) => { fs.writeFileSync(claim, 'x'); fs.utimesSync(claim, new Date(ms), new Date(ms)); };
  at(began - 1000);
  assert.equal(core.claimTouchedSince(began), false, 'claimed before it began');
  at(Date.now());
  assert.equal(core.claimTouchedSince(began), true, 'claimed since');
  at(Date.now() + 3_600_000);
  assert.equal(core.claimTouchedSince(began), false, 'a backoff');
  fs.rmSync(claim);
  assert.equal(core.claimTouchedSince(began), false, 'none');
});

// --- the listings, with parity ------------------------------------------------------------------------------------

test('index: store-only sessions bind repeated SQL parameters on Node 22.16', { skip }, (t) => {
  const f = indexFixture(t, core);
  const id = 'fixture-node22-capture';
  f.store(id, f.work, [['a.ts', 'before\n', 'after\n', 1000]]);
  withIndex((db) => {
    assert.equal(one(db, 'SELECT count(*) AS n FROM edits WHERE session_id = ?', id).n, 1);
  });
});

test('index: synced hands bind repeated SQL parameters on Node 22.16', { skip }, (t) => {
  indexFixture(t, core);
  withIndex((db) => assert.deepEqual(core.syncedHands(db, Date.now(), false, null), []));
});

test('index: sessions listing has parity with the files: Claude, Codex, store-only, empty, mirrored, review and deleted sessions', { skip }, (t) => {
  const f = indexFixture(t, core);
  const other = path.join(f.dir, 'other');
  fs.mkdirSync(other);
  f.claude('fixture-a', f.work, [ask('Refactor the parser'), reply('a1', [thinking('plan'), text('Split the parser in two.')])]);
  f.claude('fixture-b', other, [ask('Write the docs'), reply('b1', [text('Docs written.')])]);
  f.claude('fixture-empty', f.work, [{ type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>' } }]);
  fs.utimesSync(path.join(core.projectDir(f.work), 'fixture-empty.jsonl'), 1e6, 1e6);
  f.claude('fixture-mirror', path.join(f.dir, 'foreign-host'), [ask('Copied'), reply('m1', [text('x')])], f.work);
  f.claude('fixture-gone', f.work, [ask('Deleted on purpose'), reply('g1', [text('x')])]);
  core.hideSession('fixture-gone');
  f.rollout('0199a000-0000-7000-8000-0000000000c1', f.work, [cxUser('Port the exporter'),
    { type: 'event_msg', timestamp: '2026-10-01T10:01:00Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 900, cached_input_tokens: 100, output_tokens: 50 } } } }]);
  f.rollout('0199a000-0000-7000-8000-0000000000c2', f.work, [cxUser('Assess the request')], { thread_source: 'guardian_review', parent_thread_id: '0199a000-0000-7000-8000-0000000000c1' });
  f.store('fixture-a', f.work, [['a.ts', 'a\n', 'b\n', Date.parse('2026-10-01T10:05:00Z')], ['b.ts', null, 'new\n', Date.parse('2026-10-01T10:06:00Z')]]);
  f.store('fixture-storeonly', f.work, [['c.ts', 'x\n', 'y\n', Date.parse('2026-10-01T10:07:00Z')]]);
  const listed = listingParity(f.work);
  assert.deepEqual(listed.sessions.map((r) => r.id).sort(), ['0199a000-0000-7000-8000-0000000000c1', 'fixture-a', 'fixture-b'].sort());
  listingParity(f.work, null, { includeReviews: true });
  listingParity(f.work, '0199a000-0000-7000-8000-0000000000c2');
  listingParity(other, 'fixture-mirror');
  listingParity(f.work, null, { includeEmpty: true });
  // The index holds what it found and why the listing leaves some out.
  withIndex((db) => {
    assert.equal(one(db, "SELECT listed FROM sessions WHERE session_id = 'fixture-mirror'").listed, 0);
    assert.equal(one(db, "SELECT review FROM sessions WHERE session_id = '0199a000-0000-7000-8000-0000000000c2'").review, 1);
    assert.equal(one(db, "SELECT count(*) AS n FROM sessions WHERE session_id = 'fixture-gone'").n, 0, 'a deleted session is never indexed');
    assert.deepEqual(rows(db, "SELECT id, status FROM edits WHERE session_id = 'fixture-a' ORDER BY id").map((r) => [r.id, r.status]), [[1, 'pending'], [2, 'pending']]);
  });
});

test('index: a changed file is noticed: an append, a rename, a deleted session and an Auto-review rename', { skip }, (t) => {
  const f = indexFixture(t, core);
  const file = f.claude('fixture-live', f.work, [ask('First ask'), reply('l1', [text('First answer.')])]);
  listingParity(f.work);
  fs.appendFileSync(file, [ask('Second ask'), reply('l2', [text('Second answer.')]), { type: 'custom-title', customTitle: 'Renamed by a person' }].map((x) => JSON.stringify({ cwd: f.work, sessionId: 'fixture-live', ...x })).join('\n') + '\n');
  const after = listingParity(f.work);
  assert.equal(after.sessions[0].title, 'Renamed by a person');
  core.hideSession('fixture-live');
  assert.deepEqual(listingParity(f.work).sessions, []);
});

test('index: search has parity with the files, answers that follow a thinking block included', { skip }, (t) => {
  const f = indexFixture(t, core);
  const other = path.join(f.dir, 'other');
  fs.mkdirSync(other);
  f.claude('fixture-s1', f.work, [
    ask('How does the tokenizer split words?'),
    reply('s1a', [thinking('Look at the tokenizer.')]),
    reply('s1a', [text('The zebracorn tokenizer splits on whitespace and punctuation.')]),
    reply('s1a', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x' } }]),
    ask('And the parser?'),
    reply('s1b', [text('The parser builds an index of tokens.')]),
  ]);
  f.claude('fixture-s2', other, [ask('Index the tokenizer output'), reply('s2a', [text('Indexed: tokenizer, parser, zebracorn.')])]);
  f.store('fixture-hooks', f.work, []);
  core.appendCaptureEvent('fixture-hooks', 'turn_start', { prompt: 'A tokenizer ask the hooks recorded', promptId: 'p1' });
  for (const q of ['zebracorn', 'tokenizer', 'token', 'parser index', 'ZEBRA', 'kenizer spl', 'hooks recorded', 'nothing-matches-this']) searchParity(f.work, q);
  searchParity(f.work, 'tokenizer', { perSession: true });
  searchParity(f.work, 'tokenizer', { limit: 1 });
  searchParity(f.work, 'tokenizer', { sinceMs: Date.now() + 60_000 });
  const hit = searchParity(f.work, 'zebracorn').hits.find((h) => h.session === 'fixture-s1');
  assert.equal(hit?.where, 'response', 'the text after the thinking block is searched');
});

test('index: search reuses caught-up Claude metadata without rereading its transcript or title sidecar', { skip }, (t) => {
  const f = indexFixture(t, core);
  const id = 'fixture-search-metadata';
  const file = f.claude(id, f.work, [ask('Find zebracorn'), reply('sm1', [text('A zebracorn reply')]), { type: 'custom-title', customTitle: 'A chosen title' }]);
  const ix = caughtUp();
  const expected = core.searchConversations(f.work, 'zebracorn');
  const open = fs.openSync;
  const read = fs.readFileSync;
  let reads = 0;
  const relevant = (p) => String(p) === file || String(p) === path.join(core.rootDir(), 'session-meta', `${id}.json`);
  fs.openSync = (p, ...args) => { if (relevant(p)) reads++; return open(p, ...args); };
  fs.readFileSync = (p, ...args) => { if (relevant(p)) reads++; return read(p, ...args); };
  try {
    const actual = core.indexedSearch(ix.db, f.work, 'zebracorn');
    assert.deepEqual({ ...actual, ms: 0, indexed: 0 }, { ...expected, ms: 0, indexed: 0 });
    assert.equal(reads, 0, 'the catch-up already read this metadata');
  } finally {
    fs.openSync = open;
    fs.readFileSync = read;
    ix.close();
  }
  fs.appendFileSync(file, f.lines([{ type: 'custom-title', customTitle: 'Changed title' }]));
  assert.equal(searchParity(f.work, 'zebracorn').hits[0].title, 'Changed title');
});

test('index: inbox has parity with the files', { skip }, (t) => {
  const f = indexFixture(t, core);
  f.claude('fixture-hand', f.work, [ask('Run the migration'), reply('h1', [text('Waiting for permission.')])]);
  f.store('fixture-hand', f.work, []);
  fs.writeFileSync(path.join(core.storeDir('fixture-hand'), 'attention.json'), JSON.stringify({ kind: 'permission', message: 'Bash', ts: Date.now() - 1000 }));
  withIndex((db) => {
    const strip = (x) => ({ ...x, generatedAt: 0, hands: x.hands.map((h) => ({ ...h, waitingMs: 0, waitedTodayMs: 0 })) });
    const fromIndex = core.indexedInbox(db, f.work);
    assert.deepEqual(strip(fromIndex), strip(core.attentionInbox(f.work)));
    assert.deepEqual(fromIndex.hands.map((h) => [h.id, h.kind]), [['fixture-hand', 'permission']]);
    assert.deepEqual(rows(db, 'SELECT session_id, kind FROM attention').map((r) => [r.session_id, r.kind]), [['fixture-hand', 'permission']]);
  });
});

// --- ingest correctness ---------------------------------------------------------------------------------------------

/** The asks and answers the index holds for a session, in order. */
const prompts = (db, id) => rows(db, 'SELECT idx, text, response FROM prompts WHERE session_id = ? ORDER BY idx', id).map((r) => [r.idx, r.text, r.response]);

test('index: a transcript is folded from its cursor: an append adds only what is new, an answer split over lines once', { skip }, (t) => {
  const f = indexFixture(t, core);
  const id = 'fixture-cursor';
  const file = f.claude(id, f.work, [ask('First'), reply('c1', [thinking('t')]), reply('c1', [text('Alpha.')])]);
  withIndex((db) => assert.deepEqual(prompts(db, id), [[0, 'First', 'Alpha.']]));
  const add = (...recs) => fs.appendFileSync(file, recs.map((x) => JSON.stringify({ cwd: f.work, sessionId: id, ...x })).join('\n') + '\n');
  const cursorAt = (db) => one(db, 'SELECT cursor, size FROM ingest_state WHERE source LIKE ?', `prompts:%:${id}`);
  // The same message's next line (a later block), then a repeat of a line, then a snapshot that extends it.
  add(reply('c1', [text('Beta.')]), reply('c1', [text('Beta.')]), reply('c1', [text('Beta. Gamma.')]));
  withIndex((db) => {
    assert.deepEqual(prompts(db, id), [[0, 'First', 'Alpha. Beta. Gamma.']]);
    const c = cursorAt(db);
    assert.equal(c.cursor, fs.statSync(file).size, 'the cursor is at the end');
  });
  // A line still being written waits; once whole, it is folded.
  fs.appendFileSync(file, JSON.stringify({ cwd: f.work, sessionId: id, ...ask('Second') }));
  withIndex((db) => assert.equal(prompts(db, id).length, 1));
  fs.appendFileSync(file, '\n');
  add(reply('c2', [text('Delta.')]));
  withIndex((db) => {
    assert.deepEqual(prompts(db, id), [[0, 'First', 'Alpha. Beta. Gamma.'], [1, 'Second', 'Delta.']]);
    assert.ok(one(db, 'SELECT end_ts FROM prompts WHERE session_id = ? AND idx = 0', id).end_ts > 0, 'the first ask ends where the second begins');
  });
  // The same fold from nothing gives the same rows: what an incremental catch-up holds is what a rebuild would.
  fs.rmSync(core.indexFile());
  for (const x of ['-wal', '-shm']) fs.rmSync(core.indexFile() + x, { force: true });
  withIndex((db) => assert.deepEqual(prompts(db, id), [[0, 'First', 'Alpha. Beta. Gamma.'], [1, 'Second', 'Delta.']]));
});

// node:sqlite on Node 22 returns a text cut at its first NUL character (Node 24 returns all of it): an ask or answer
// holding one is read back as bytes, both by the fold that extends the newest answer and by the search's docs.
test('index: an ask or answer holding a NUL character stays whole: folded from its cursor, and searched with parity', { skip }, (t) => {
  const f = indexFixture(t, core);
  const id = 'fixture-nul';
  const file = f.claude(id, f.work, [ask('Before\u0000after quokkaword'), reply('n1', [text('Answer\u0000tail lemurword.')])]);
  const bytes = (db) => rows(db, 'SELECT nul, CAST(text AS BLOB) AS text, CAST(response AS BLOB) AS response FROM prompts WHERE session_id = ? ORDER BY idx', id)
    .map((r) => [r.nul, Buffer.from(r.text).toString('utf8'), Buffer.from(r.response).toString('utf8')]);
  const folded = () => core.sessionSearchIndex(f.work, id, file).docs.map((d) => [d.prompt, d.response]);
  withIndex((db) => assert.deepEqual(bytes(db), [[1, 'Before\u0000after quokkaword', 'Answer\u0000tail lemurword.']]));
  // The answer goes on past the NUL: the catch-up extends the answer it holds, all of it.
  fs.appendFileSync(file, JSON.stringify({ cwd: f.work, sessionId: id, ...reply('n1', [text('More wombatword.')]) }) + '\n');
  fs.appendFileSync(file, JSON.stringify({ cwd: f.work, sessionId: id, ...ask('A plain ask') }) + '\n');
  withIndex((db) => {
    const held = bytes(db);
    assert.deepEqual(held.map(([, a, b]) => [a, b]), folded(), 'the index holds what the search\'s own fold holds');
    assert.match(held[0][2], /tail lemurword\. More wombatword\.$/);
    assert.deepEqual(held.map(([nul]) => nul), [1, 0], 'only the rows holding a NUL are flagged');
  });
  f.store('fixture-nulhooks', f.work, []);
  core.appendCaptureEvent('fixture-nulhooks', 'turn_start', { prompt: 'Hooks\u0000ask capybaraword', promptId: 'p1' });
  for (const q of ['quokkaword', 'lemurword', 'wombatword', 'capybaraword', 'after quokka']) assert.equal(searchParity(f.work, q).hits.length, 1, q);
});

test('index: a rewritten transcript is folded again from the start: a new inode, a shorter file, a changed head or a changed middle', { skip }, (t) => {
  const f = indexFixture(t, core);
  const id = 'fixture-rewrite';
  const recs = (word) => [ask(`Ask about ${word}`), reply(`r-${word}`, [text(`Answer about ${word}.`)])].map((x) => JSON.stringify({ cwd: f.work, sessionId: id, ...x }));
  const file = f.claude(id, f.work, []);
  fs.writeFileSync(file, recs('apples').join('\n') + '\n');
  withIndex((db) => assert.deepEqual(prompts(db, id).map((p) => p[1]), ['Ask about apples']));
  // A new inode (replaced by rename).
  fs.writeFileSync(file + '.new', recs('pears').join('\n') + '\n');
  fs.renameSync(file + '.new', file);
  withIndex((db) => assert.deepEqual(prompts(db, id).map((p) => p[1]), ['Ask about pears']));
  // Shorter.
  fs.writeFileSync(file, recs('figs')[0] + '\n');
  withIndex((db) => assert.deepEqual(prompts(db, id).map((p) => p[1]), ['Ask about figs']));
  // The head rewritten in place (same inode, same length), then grown: the head hash catches it.
  const head = fs.readFileSync(file, 'utf8');
  const at = Buffer.byteLength(head.slice(0, head.indexOf('Ask about figs')));
  const fd = fs.openSync(file, 'r+');
  fs.writeSync(fd, Buffer.from('Ask about kiwi'), 0, 14, at);
  fs.closeSync(fd);
  fs.appendFileSync(file, recs('kiwi')[1] + '\n');
  withIndex((db) => assert.deepEqual(prompts(db, id).map((p) => [p[1], p[2]]), [['Ask about kiwi', 'Answer about kiwi.']], 'folded again from the start'));
  // A middle rewritten in place, then grown: the anchor hash catches it.
  fs.writeFileSync(file, [...recs('lime'), ...recs('plum')].join('\n') + '\n');
  withIndex((db) => assert.deepEqual(prompts(db, id).map((p) => p[1]), ['Ask about lime', 'Ask about plum']));
  const whole = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, whole.replace('Ask about plum', 'Ask about pear'));
  fs.appendFileSync(file, recs('date').join('\n') + '\n');
  withIndex((db) => assert.deepEqual(prompts(db, id).map((p) => p[1]), ['Ask about lime', 'Ask about pear', 'Ask about date']));
  // Past the head's 4 KB, each guard holds alone. A change in the 4 KB before the cursor, in place: the anchor's.
  const filler = (word, n) => Array.from({ length: n }, (_, k) => recs(`${word}${k}`)).flat();
  fs.writeFileSync(file, filler('fig', 40).join('\n') + '\n');
  withIndex((db) => assert.equal(prompts(db, id).length, 40));
  let big = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, big.replace('Ask about fig39', 'Ask about fog39'));
  fs.appendFileSync(file, recs('end').join('\n') + '\n');
  withIndex((db) => assert.deepEqual(prompts(db, id).slice(-2).map((p) => p[1]), ['Ask about fog39', 'Ask about end'], 'the anchor caught the change before the cursor'));
  // A change in the middle (past the head, before the anchor), the file replaced by a rename: the new inode's.
  big = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file + '.new', big.replace('Ask about fig20', 'Ask about fog20'));
  fs.renameSync(file + '.new', file);
  withIndex((db) => assert.equal(prompts(db, id)[20][1], 'Ask about fog20', 'the new inode started the fold over'));
});

test('index: what a session did: its tool calls with their project paths, and its workers', { skip }, (t) => {
  const f = indexFixture(t, core);
  const id = 'fixture-work';
  const file = f.claude(id, f.work, [
    ask('Review the module'),
    reply('w1', [{ type: 'tool_use', id: 'spawn-1', name: 'Agent', input: { description: 'Review the parser module', subagent_type: 'Explore' } },
      { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: path.join(f.work, 'src', 'parser.ts') } }]),
    { type: 'user', timestamp: '2026-10-01T10:30:00.000Z', toolUseResult: { agentId: 'child1', status: 'completed', agentType: 'Explore' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'spawn-1', content: 'Reviewed' }] } },
    { type: 'user', timestamp: '2026-10-01T10:30:01.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'source', is_error: true }] } },
  ]);
  const sub = path.join(path.dirname(file), id, 'subagents', 'agent-child1.jsonl');
  f.write(sub, [{ type: 'assistant', isSidechain: true, timestamp: '2026-10-01T10:30:00.500Z', message: { role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 4, output_tokens: 7 }, content: [{ type: 'tool_use', id: 'child-read', name: 'Read', input: { file_path: 'module.ts' } }] } }]);
  // A project of its own, so paths are relative to it.
  makeGitDir(path.join(f.work, '.git'));
  fs.writeFileSync(path.join(f.work, '.git', 'config'), '[remote "origin"]\n\turl = git@example.com:org/app.git\n');
  withIndex((db) => {
    const acts = rows(db, 'SELECT seq, tool, category, path_abs, project_key, rel_path, is_error FROM actions WHERE session_id = ? ORDER BY seq', id).map((r) => ({ ...r }));
    assert.deepEqual(acts.map((a) => [a.tool, a.category]), [['Agent', 'agent'], ['Read', 'read']]);
    const read = acts.find((a) => a.tool === 'Read');
    assert.deepEqual([read.rel_path, read.project_key, read.is_error], ['src/parser.ts', 'git:example.com/org/app', 1]);
    assert.deepEqual(rows(db, 'SELECT agent_id, kind, agent_type FROM agents WHERE session_id = ?', id).map((r) => [r.agent_id, r.kind, r.agent_type]), [['child1', 'subagent', 'Explore']]);
  });
  const w = core.queryIndex('workers', { session: id });
  assert.deepEqual(w.rows.map((r) => [r.agent_id, r.kind]), [['child1', 'subagent']]);
});

test('usage: a session\'s own tokens and its tokens with every agent it started, one meaning in the transcripts and the index (0.11.0)', { skip }, (t) => {
  const f = indexFixture(t, core);
  const id = 'fixture-tree';
  const file = f.claude(id, f.work, [ask('Fan out'), reply('own-1', [text('ok')], 1, { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 })]);
  const side = (mid, usage, s) => ({ type: 'assistant', isSidechain: true, timestamp: `2026-10-01T10:3${s}:00.000Z`, message: { id: mid, role: 'assistant', model: 'claude-opus-4-8', usage, content: [] } });
  const subs = path.join(path.dirname(file), id, 'subagents');
  // A subagent (two lines of one message: counted once, at its larger snapshot), a workflow run's agent a level down,
  // and the run's journal, which reports no usage and is no agent.
  f.write(path.join(subs, 'agent-a1.jsonl'), [side('w-1', { input_tokens: 10, output_tokens: 5 }, 1), side('w-1', { input_tokens: 10, output_tokens: 9 }, 1),
    side('w-2', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 500 }, 2)]);
  f.write(path.join(subs, 'workflows', 'wf_1', 'agent-b1.jsonl'), [side('w-3', { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 40 }, 3)]);
  f.write(path.join(subs, 'workflows', 'wf_1', 'journal.jsonl'), [{ type: 'phase', timestamp: '2026-10-01T10:30:00.000Z', name: 'one' }]);
  const own = core.sessionUsage(f.work, id);
  assert.deepEqual([own.input, own.output, own.cacheRead, own.cacheCreation, own.total], [100, 20, 1000, 50, 170], 'its own: the main chain alone');
  const tree = core.sessionTreeUsage(f.work, id);
  assert.deepEqual([tree.input, tree.output, tree.cacheRead, tree.cacheCreation, tree.total, tree.agents], [118, 33, 1500, 90, 241, 2], 'with its agents: two workers added');
  // An agent still writing: its newline-less last line counts once, now and after its newline lands.
  const a1 = path.join(subs, 'agent-a1.jsonl');
  fs.appendFileSync(a1, JSON.stringify(side('w-4', { input_tokens: 2, output_tokens: 2 }, 4)));
  assert.equal(core.sessionTreeUsage(f.work, id).total, 245, 'the pending line peeked');
  fs.appendFileSync(a1, '\n');
  assert.equal(core.sessionTreeUsage(f.work, id).total, 245, 'and folded once');
  assert.equal(core.sessionUsage(f.work, id).total, 170, 'the session\'s own figure never takes a worker\'s turns');
  // The index counts the session's workers under it too: `oak query usage --by session` is the figure with its agents.
  withIndex(() => {});
  const q = core.queryIndex('usage', { window: 'all', by: 'session', account: 'all' });
  const row = q.rows.find((r) => r.session === id);
  assert.deepEqual([row.tokens, row.cache_read], [245, 1500], 'the index agrees with the transcripts');
  assert.deepEqual([row.own_tokens, row.own_cache_read, row.agents], [170, 1000, 2], 'its own turns apart, and how many agents');
  // A record from an OAK before the worker column cannot say whose turn it was: the own figure is unknown, not a guess.
  withIndex((db) => db.prepare("UPDATE usage_messages SET worker = NULL WHERE message_id = 'w-3'").run());
  const old = core.queryIndex('usage', { window: 'all', by: 'session', account: 'all' }).rows.find((r) => r.session === id);
  assert.deepEqual([old.tokens, old.own_tokens, old.own_cache_read], [245, null, null], 'an older record leaves the own figure unknown');
});

test('index: a catch-up with nothing changed derives nothing again', { skip }, (t) => {
  const f = indexFixture(t, core);
  f.claude('fixture-still-a', f.work, [ask('A transcript'), reply('s1', [text('x')])]);
  f.store('fixture-still-a', f.work, [['a.ts', 'a\n', 'b\n', 1000]]);
  f.store('fixture-still-b', f.work, [['b.ts', 'a\n', 'b\n', 1000]]);
  f.claude('fixture-still-c', f.work, [ask('Only a transcript'), reply('s2', [text('y')])]);
  const first = caughtUp();
  assert.ok(first.catchUp.updated >= 3);
  first.close();
  const second = caughtUp();
  assert.equal(second.catchUp.updated, 0, 'every unit is current: none is derived again');
  second.close();
  fs.appendFileSync(path.join(core.projectDir(f.work), 'fixture-still-c.jsonl'), JSON.stringify({ cwd: f.work, sessionId: 'fixture-still-c', ...ask('More') }) + '\n');
  const third = caughtUp();
  assert.equal(third.catchUp.updated, 1, 'positive control: the one that changed');
  third.close();
});

// A catch-up that found nothing to do still took the lease and wrote its time, so every reader's PRAGMA data_version
// moved on every catch-up by any process, and could not say that the index had changed.
test('index: a catch-up that finds nothing to do writes nothing, so another reader\'s data_version moves only when the index changed', { skip }, (t) => {
  const f = indexFixture(t, core);
  f.claude('fixture-quiet', f.work, [ask('Quiet'), reply('q1', [text('x')])]);
  f.store('fixture-quiet', f.work, [['a.ts', 'a\n', 'b\n', 1000]]);
  // A rollout whose name does not carry its id has its head looked up under the write lock: still nothing is written.
  f.rollout('fixture-quiet-codex', f.work, [cxUser('Quiet too')]);
  caughtUp().close();
  const reader = core.openIndex();
  assert.ok(reader.ok, reader.reason);
  try {
    const dv = () => one(reader.db, 'PRAGMA data_version').data_version;
    const at = () => one(reader.db, "SELECT value FROM meta WHERE key = 'caught_up_ms'").value;
    assert.equal(one(reader.db, "SELECT count(*) AS n FROM sessions WHERE session_id = 'fixture-quiet-codex'").n, 1, 'the rollout is indexed');
    const before = [dv(), at()];
    caughtUp().close();
    assert.deepEqual([dv(), at()], before, 'nothing written, not even the time');
    // A raised hand is a change.
    fs.writeFileSync(path.join(core.storeDir('fixture-quiet'), 'attention.json'), JSON.stringify({ kind: 'input', message: 'Waiting', ts: Date.now() }));
    caughtUp().close();
    assert.notEqual(dv(), before[0], 'positive control: a change is written');
    // Nothing changed for QUIET_MS: one catch-up records that it ran, as readouts that ask how recent the index is read it;
    // before `oak usage` would take the index for behind and start a background catch-up of its own.
    assert.ok(core.QUIET_MS < core.USAGE_SWEEP_MS);
    const quiet = [dv(), at()];
    const o = core.openIndex();
    try {
      const later = Date.now() + core.QUIET_MS + 1000;
      const r = core.catchUp(o.db, { now: later });
      assert.equal(r.caughtUp, true);
      assert.equal(Number(one(o.db, "SELECT value FROM meta WHERE key = 'caught_up_ms'").value), later);
    } finally {
      o.close();
    }
    assert.notEqual(dv(), quiet[0]);
  } finally {
    reader.close();
  }
});

// An NTFS file id holds its record's sequence number in its top 16 bits: from sequence 32 on it passes 2^53, as every
// id did on GitHub's Windows runners. node:sqlite would not read such an INTEGER back as a number, so on Windows no
// catch-up finished and the usage read threw. Here every stat gives such an id.
test('index: a file id past 2^53, as NTFS gives, reads back: the index catches up and then has nothing to do', { skip }, (t) => {
  const f = indexFixture(t, core);
  Object.defineProperty(fs.Stats.prototype, 'ino', { configurable: true, set(v) {
    Object.defineProperty(this, 'ino', { value: 2 ** 53 + v * 2, writable: true, enumerable: true, configurable: true });
  } });
  t.after(() => delete fs.Stats.prototype.ino);
  assert.ok(fs.statSync(f.dir).ino > Number.MAX_SAFE_INTEGER, 'control: stat gives an id past 2^53');
  const file = f.claude('fixture-ntfs', f.work, [ask('Big ids'), reply('n1', [text('x')])]);
  f.rollout('fixture-ntfs-codex', f.work, [cxUser('Big ids too')]); // its name does not carry its id: its head is kept
  caughtUp().close();
  const again = caughtUp();
  try {
    assert.equal(again.catchUp.updated, 0, 'every unit is current: none is derived again');
    const dv = () => one(again.db, 'PRAGMA data_version').data_version;
    const o = core.openIndex();
    assert.ok(o.ok, o.reason);
    try {
      core.catchUpUsage(o.db, { session: 'fixture-ntfs', transcript: file });
      const before = dv();
      assert.deepEqual(core.catchUpUsage(o.db, { session: 'fixture-ntfs', transcript: file }), { ran: true, problems: [] });
      assert.equal(dv(), before, 'the usage read found its transcript current: nothing written');
    } finally {
      o.close();
    }
  } finally {
    again.close();
  }
  // A file that grew is read on from where its recorded stamp left it.
  fs.appendFileSync(file, JSON.stringify({ cwd: f.work, sessionId: 'fixture-ntfs', ...ask('More') }) + '\n');
  const grown = caughtUp();
  assert.equal(grown.catchUp.updated, 1, 'the one that changed');
  grown.close();
});

// On Windows 11 24H2 under libuv 1.49-1.50 (Node 22.16), a path's stat names another device than its open file's. The
// usage read records a transcript's stamp from the open file and checks it against the path: still current, so a status
// line's render takes no lease and writes nothing. Here every path stat gives such a device.
test('index: the usage read finds its transcript current when a path names another device than its open file (Windows, Node 22.16)', { skip }, (t) => {
  const f = indexFixture(t, core);
  const file = f.claude('fixture-dev', f.work, [ask('Devices'), reply('d1', [text('x')])]);
  caughtUp().close();
  const statSync = fs.statSync;
  fs.statSync = function (...args) { const st = statSync.apply(this, args); if (st) st.dev += 1; return st; };
  t.after(() => { fs.statSync = statSync; });
  const fd = fs.openSync(file, 'r');
  try { assert.notEqual(fs.statSync(file).dev, fs.fstatSync(fd).dev, 'control: the path names another device'); } finally { fs.closeSync(fd); }
  const watch = core.openIndex();
  const o = core.openIndex();
  assert.ok(watch.ok && o.ok, watch.reason || o.reason);
  try {
    core.catchUpUsage(o.db, { session: 'fixture-dev', transcript: file });
    const dv = () => one(watch.db, 'PRAGMA data_version').data_version;
    const before = dv();
    assert.deepEqual(core.catchUpUsage(o.db, { session: 'fixture-dev', transcript: file }), { ran: true, problems: [] });
    assert.equal(dv(), before, 'the transcript is current: no lease taken, nothing written');
  } finally {
    o.close();
    watch.close();
  }
});

// A catch-up looks at the files before it takes the lease (to know whether there is anything to do). Overtaken there by
// another process's catch-up, it looks again under the lease: a session that process indexed meanwhile, which its first
// look did not see, is not taken for gone (archived, and published so).
test('index: a catch-up overtaken between its first look and its lease looks again; nothing begun meanwhile is archived', { skip }, (t) => {
  const f = indexFixture(t, core);
  const file = f.claude('fixture-race-1', f.work, [ask('one'), reply('r1', [text('ok')])]);
  caughtUp().close();
  fs.appendFileSync(file, JSON.stringify({ cwd: f.work, sessionId: 'fixture-race-1', ...ask('two') }) + '\n'); // work to do: not quiet
  const o = core.openIndex();
  assert.ok(o.ok, o.reason);
  let fired = false;
  // The other process, at this one's first BEGIN IMMEDIATE (the lease's): a session begins, and its listing catches up.
  const db = new Proxy(o.db, {
    get(target, prop) {
      if (prop === 'exec') {
        return (sql) => {
          if (!fired && /BEGIN IMMEDIATE/.test(sql)) {
            fired = true;
            f.claude('fixture-race-new', f.work, [ask('new'), reply('n1', [text('ok')])]);
            cp.execFileSync(process.execPath, ['-e', `const core = require(${JSON.stringify(DIST)}); const ix = core.useIndex({ budgetMs: Infinity, inlineBytes: Infinity }); ix.close();`], { env: process.env });
          }
          return target.exec(sql);
        };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  try {
    const r = core.catchUp(db, { budgetMs: Infinity });
    assert.ok(fired, 'the other process ran before this one took the lease');
    assert.equal(r.caughtUp, true);
    assert.equal(one(o.db, "SELECT archived_ms FROM sessions WHERE session_id = 'fixture-race-new'").archived_ms, null, 'the session begun meanwhile stays');
  } finally {
    o.close();
  }
});

test('index: a quiet catch-up overtaken by another writer never claims it is caught up', { skip }, (t) => {
  const f = indexFixture(t, core);
  f.claude('fixture-quiet-race', f.work, [ask('Quiet'), reply('qr1', [text('ok')])]);
  caughtUp().close();
  const o = core.openIndex();
  const writer = core.openIndex();
  assert.ok(o.ok && writer.ok);
  let fired = false;
  const db = new Proxy(o.db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql) => {
        const stmt = target.prepare(sql);
        if (!sql.includes("kind = 'pub-waiting'")) return stmt;
        return new Proxy(stmt, {
          get(statement, method) {
            if (method === 'get') return (...args) => {
              const row = statement.get(...args);
              if (!fired) {
                fired = true;
                assert.ok(core.tryLease(writer.db, Date.now(), 'other-writer'));
              }
              return row;
            };
            const v = statement[method];
            return typeof v === 'function' ? v.bind(statement) : v;
          },
        });
      };
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  try {
    const r = core.catchUp(db);
    assert.ok(fired, 'the second connection took the lease during the quiet check');
    assert.equal(r.caughtUp, false, 'the writer can be between batches');
    assert.equal(r.ran, false);
  } finally {
    core.releaseLease(writer.db, 'other-writer');
    writer.close();
    o.close();
  }
});

// A listing's catch-up reads a changing session's tool calls at most every 30 seconds; one that put them off is quiet
// after it as long as nothing else changed: the catch-up it stands for would have put them off too.
test('index: a listing\'s catch-up quiet while it puts off a session\'s tool calls, as nothing else changed', { skip }, (t) => {
  const f = indexFixture(t, core);
  const file = f.claude('fixture-deferred', f.work, [ask('Keep going'), reply('d1', [text('x')])]);
  caughtUp().close();
  fs.appendFileSync(file, JSON.stringify({ cwd: f.work, sessionId: 'fixture-deferred', ...ask('And more') }) + '\n');
  const listing = () => caughtUp({ workRefreshMs: core.LISTING_WORK_REFRESH_MS }).close();
  listing(); // reads the new ask; its tool calls wait their turn
  const reader = core.openIndex();
  assert.ok(reader.ok, reader.reason);
  try {
    const dv = () => one(reader.db, 'PRAGMA data_version').data_version;
    const before = dv();
    listing();
    listing();
    assert.equal(dv(), before, 'nothing written while they wait');
    caughtUp().close(); // a catch-up that does not put them off (oak query's) reads them
    assert.notEqual(dv(), before, 'positive control');
  } finally {
    reader.close();
  }
});

// The listing read every session's attention.json and tab.json, and asked every worker transcript written in the last two
// hours what it was doing, whatever it had answered before: 221 of 307 ms of a listing of 1,260 synthetic sessions.
test('index: a listing served from the index reads the raised hand and the tab as the catch-up read them, and clears them when the store goes', { skip }, (t) => {
  const f = indexFixture(t, core);
  const id = 'fixture-hand';
  f.claude(id, f.work, [ask('Wait for me'), reply('h1', [text('x')])]);
  f.store(id, f.work, [['a.ts', 'a\n', 'b\n', 1000]]);
  fs.writeFileSync(path.join(core.storeDir(id), 'attention.json'), JSON.stringify({ kind: 'input', message: 'Waiting on you', ts: 1_700_000_000_000 }));
  fs.writeFileSync(path.join(core.storeDir(id), 'tab.json'), JSON.stringify({ tab: 'tab-1@42', at: 1 }));
  const row = (meta) => meta.sessions.find((r) => r.id === id);
  const listed = listingParity(f.work);
  assert.deepEqual([row(listed).attention, row(listed).tab], [{ kind: 'input', message: 'Waiting on you', ts: 1_700_000_000_000 }, 'tab-1@42']);
  withIndex((db) => {
    // What the index holds is what the listing reads: planted, it shows; the files still say otherwise.
    db.prepare("UPDATE attention SET message = 'Planted' WHERE session_id = ?").run(id);
    db.prepare("UPDATE session_live SET tab = 'tab-planted@1' WHERE session_id = ?").run(id);
    const fromIndex = row(core.indexedSessionMeta(db, f.work));
    assert.deepEqual([fromIndex.attention.message, fromIndex.tab], ['Planted', 'tab-planted@1']);
    assert.deepEqual([row(core.sessionMeta(f.work)).attention.message, row(core.sessionMeta(f.work)).tab], ['Waiting on you', 'tab-1@42'], 'control: the files');
  });
  // The tab's link changing alone is read again.
  fs.writeFileSync(path.join(core.storeDir(id), 'tab.json'), JSON.stringify({ tab: 'tab-22@430', at: 2 }));
  assert.equal(row(listingParity(f.work)).tab, 'tab-22@430');
  // A store that went takes its hand and tab with it (its transcript stays, so the session stays listed).
  fs.rmSync(core.storeDir(id), { recursive: true, force: true });
  const after = listingParity(f.work);
  assert.deepEqual([row(after).attention, row(after).tab], [null, null]);
});

test('index: the listing asks no worker the catch-up found finished; one that may still run is asked, as the files\' listing asks it', { skip }, (t) => {
  const f = indexFixture(t, core);
  const id = 'fixture-workers';
  const now = new Date().toISOString();
  const file = f.claude(id, f.work, [
    { type: 'user', timestamp: now, message: { role: 'user', content: 'Split the work' } },
    { type: 'assistant', timestamp: now, message: { id: 'p1', role: 'assistant', model: 'claude-opus-4-8', usage: { input_tokens: 5, output_tokens: 5 },
      content: [{ type: 'tool_use', id: 'spawn-done', name: 'Agent', input: { description: 'The finished one' } }, { type: 'tool_use', id: 'spawn-run', name: 'Agent', input: { description: 'The running one' } }] } },
  ]);
  const dir = path.join(path.dirname(file), id, 'subagents');
  // Finished: its last turn ended. Running: its last call has no result yet. Both written just now.
  f.write(path.join(dir, 'agent-done.jsonl'), [{ type: 'assistant', isSidechain: true, timestamp: now, message: { role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } }]);
  f.write(path.join(dir, 'agent-run.jsonl'), [{ type: 'assistant', isSidechain: true, timestamp: now, message: { role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'tool_use', id: 'r1', name: 'Bash', input: { command: 'make' } }] } }]);
  const stamp = (n) => { const st = fs.statSync(path.join(dir, n)); return `${st.mtimeMs}:${st.size}`; };
  const listed = listingParity(f.work);
  assert.deepEqual(listed.sessions.find((r) => r.id === id).activeWorkers.map((w) => w.agentId), ['run'], 'the running one is listed, from the index as from the files');
  withIndex((db) => {
    assert.deepEqual(JSON.parse(one(db, 'SELECT workers FROM session_live WHERE session_id = ?', id).workers), { 'agent-done.jsonl': stamp('agent-done.jsonl') }, 'the finished one is kept, the running one is not');
  });
  // What the index keeps spares the asking: a worker known finished at its stamp is not asked again, in a process that
  // never asked it (here, one named finished that would read as running if asked).
  assert.deepEqual(core.activeWorkers(file, id, Date.now(), new Map([['agent-run.jsonl', stamp('agent-run.jsonl')]])), [], 'known finished: not asked');
  assert.deepEqual(core.activeWorkers(file, id, Date.now(), new Map([['agent-run.jsonl', '1:1']])).map((w) => w.agentId), ['run'], 'a stamp it no longer has: asked');
  // What the index holds is what the listing goes by: a worker planted there as finished at its stamp is not asked; one
  // not read yet (a file from before schema 3, a catch-up that stopped part way) is asked, as the files' listing asks it.
  withIndex((db) => {
    const workersOf = () => core.indexedSessionMeta(db, f.work).sessions.find((r) => r.id === id).activeWorkers.map((w) => w.agentId);
    db.prepare('UPDATE session_live SET workers = ? WHERE session_id = ?').run(JSON.stringify({ 'agent-run.jsonl': stamp('agent-run.jsonl') }), id);
    assert.deepEqual(workersOf(), [], 'planted as finished: not asked');
    assert.deepEqual(core.sessionMeta(f.work).sessions.find((r) => r.id === id).activeWorkers.map((w) => w.agentId), ['run'], 'control: the files ask it');
    db.prepare('UPDATE session_live SET workers = NULL WHERE session_id = ?').run(id);
    assert.deepEqual(workersOf(), ['run'], 'not read yet: asked');
  });
  // A session with no folder of workers asks nothing: its row in the index says so.
  f.claude('fixture-no-workers', f.work, [ask('Alone'), reply('n1', [text('x')])]);
  withIndex((db) => assert.equal(one(db, 'SELECT workers FROM session_live WHERE session_id = ?', 'fixture-no-workers').workers, 'none'));
});

// The terminal app's "a newer session is live" hint walked every transcript on the machine every 30 seconds outside a
// workspace (newestSessionGlobal); it asks the index instead, which must name the same session.
test('index: the machine\'s newest session from the index is the one the transcripts name: no mirror, no deleted one, an answered one first', { skip }, (t) => {
  const f = indexFixture(t, core);
  const at = (file, s) => fs.utimesSync(file, s, s);
  at(f.claude('fixture-n-old', f.work, [ask('Old'), reply('n1', [text('x')])]), 100);
  at(f.claude('fixture-n-mid', f.work, [ask('Mid'), reply('n2', [text('x')])]), 200);
  at(f.claude('fixture-n-new', f.work, [ask('No answer yet')]), 300);
  const check = (expected, why) => {
    withIndex(() => {});
    assert.equal(core.newestSessionGlobal(), expected, `${why}: the transcripts`);
    assert.equal(core.indexedNewestSession(), expected, why);
  };
  check('fixture-n-mid', 'an answered session before a newer one that has none');
  at(f.claude('fixture-n-mirror', path.join(f.dir, 'other-host', 'work'), [ask('Foreign'), reply('n3', [text('x')])], f.work), 400);
  check('fixture-n-mid', 'a mirrored copy is never chosen');
  f.rollout('fixture-n-codex', f.work, [cxUser('A Codex session, newer still')]);
  check('fixture-n-mid', 'nor a Codex session');
  core.hideSession('fixture-n-mid');
  assert.equal(core.indexedNewestSession(), 'fixture-n-old', 'a deleted session, before the next catch-up forgets it');
  check('fixture-n-old', 'a deleted session is never chosen');
  at(f.claude('fixture-n-old', f.work, [ask('Old, asked again')]), 500);
  check('fixture-n-old', 'none answered: the newest');
  process.env.OAK_INDEX = 'off';
  core.resetIndexRuntime();
  assert.equal(core.indexedNewestSession(), undefined, 'no index here: the caller walks the transcripts');
});

test('index: a reader that never writes opens the index read-only, as the last catch-up left it, and only a file of this build\'s schema', { skip }, (t) => {
  const f = indexFixture(t, core);
  assert.equal(core.openIndexReadOnly().ok, false, 'no index yet: nothing is created');
  assert.equal(fs.existsSync(core.indexFile()), false);
  f.claude('fixture-ro', f.work, [ask('Read only'), reply('r1', [text('x')])]);
  caughtUp().close();
  const reader = core.openIndex();
  try {
    const before = one(reader.db, 'PRAGMA data_version').data_version;
    const ro = core.openIndexReadOnly();
    assert.ok(ro.ok, ro.reason);
    try {
      assert.equal(one(ro.db, "SELECT count(*) AS n FROM sessions WHERE session_id = 'fixture-ro'").n, 1);
      assert.throws(() => ro.db.exec("DELETE FROM sessions WHERE session_id = 'fixture-ro'"), /readonly|read-only|query_only/i);
    } finally {
      ro.close();
    }
    assert.equal(one(reader.db, 'PRAGMA data_version').data_version, before, 'nothing written');
    // A file of another schema version (an older one waits for the next catch-up to migrate it).
    reader.db.exec('PRAGMA user_version = 2');
  } finally {
    reader.close();
  }
  const old = core.openIndexReadOnly();
  assert.equal(old.ok, false);
  assert.match(old.reason, /schema 2/);
});

test('index: the log is read with the views\' fold: duplicate ids re-keyed, status ops applied', { skip }, (t) => {
  const f = indexFixture(t, core);
  const id = 'fixture-dup';
  f.store(id, f.work, [['a.ts', 'a\n', 'b\n', 1000]]);
  const log = core.logPath(id);
  const rec = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').pop());
  fs.appendFileSync(log, JSON.stringify({ ...rec, uid: 'twin', ts: 2000 }) + '\n' + JSON.stringify({ op: 'status', id: 1, status: 'kept' }) + '\n');
  const fold = core.readLog(id);
  withIndex((db) => {
    assert.deepEqual(rows(db, 'SELECT id, uid, status FROM edits WHERE session_id = ? ORDER BY id', id).map((r) => [r.id, r.uid, r.status]), fold.map((r) => [r.id, r.uid ?? null, r.status]));
    assert.equal(fold.length, 2);
  });
});

// A line longer than the fold's 8 MB read: an ask carrying a large pasted image. Folded in pieces, it parsed as nothing,
// the ask was lost, and its answer joined the ask before it.
test('index: an ask on a line longer than a read chunk (a large pasted image) is folded whole, with its own answer', { skip }, (t) => {
  const f = indexFixture(t, core);
  const id = 'fixture-bigline';
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(9 * 1024 * 1024) } };
  const file = f.claude(id, f.work, [ask('Look at the wombat'), reply('b1', [text('A wombat.')]),
    { type: 'user', timestamp: '2026-10-01T11:00:00.000Z', message: { role: 'user', content: [image, { type: 'text', text: 'What is wrong in this quokkashot?' }] } },
    reply('b2', [text('The quokkashot shows a lemurbug.')]), ask('Thanks'), reply('b3', [text('Welcome.')])]);
  const docs = [];
  core.foldSearchDocs(fs.readFileSync(file, 'utf8'), docs, new Map());
  assert.equal(docs.length, 3, 'positive control: the whole-file fold has three asks');
  withIndex((db) => assert.deepEqual(prompts(db, id), docs.map((d, i) => [i, d.prompt, d.response])));
  assert.equal(searchParity(f.work, 'quokkashot').hits.length, 1);
});

// What a transcript's cursor carries between catch-ups is what an answer still being written needs: the texts of its
// newest messages, not 64 of them (13% of an index, measured).
test('index: the fold carries the texts of a transcript\'s newest messages only', { skip }, (t) => {
  const f = indexFixture(t, core);
  const id = 'fixture-carried';
  f.claude(id, f.work, Array.from({ length: 40 }, (_, k) => (k % 2 ? reply(`c-${k}`, [text(`Answer ${k} `.repeat(50))]) : ask(`Ask ${k}`))));
  withIndex((db) => {
    const state = JSON.parse(one(db, 'SELECT state FROM ingest_state WHERE source LIKE ?', `prompts:%:${id}`).state);
    assert.ok(state.seen.length > 0 && state.seen.length <= 4, `${state.seen.length} messages carried`);
    assert.equal(prompts(db, id).length, 20, 'positive control: every ask is folded');
  });
});

test('index: another machine\'s log kept under sync/replicas is indexed under that machine', { skip }, (t) => {
  const f = indexFixture(t, core);
  const origin = 'a1b2c3d4e5f6';
  const dir = path.join(core.syncDir(), 'replicas', origin, 'fixture-remote');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'log.jsonl'), JSON.stringify({ id: 1, uid: 'u1', ts: 1000, tool: 'Edit', file: '/remote/a.ts', beforeBlob: null, afterBlob: 'f'.repeat(64), status: 'pending' }) + '\n');
  withIndex((db) => {
    assert.deepEqual({ ...one(db, "SELECT machine_id, origin FROM sessions WHERE session_id = 'fixture-remote'") }, { machine_id: origin, origin: 'replica' });
    assert.deepEqual(rows(db, "SELECT machine_id, file FROM edits WHERE session_id = 'fixture-remote'").map((r) => [r.machine_id, r.file]), [[origin, '/remote/a.ts']]);
  });
  const q = core.queryIndex('edits', { machine: origin });
  assert.deepEqual(q.rows.map((r) => [r.machine, r.session]), [[origin, 'fixture-remote']]);
  assert.equal(core.queryIndex('edits', { machine: 'self' }).rowCount, 0, 'and not under this machine');
});

test('index: a transcript oak sync pulled is filed under the machine it came from, and listed as before', { skip }, (t) => {
  const f = indexFixture(t, core);
  const file = f.claude('fixture-pulled', f.work, [ask('Work done on the other machine'), reply('p1', [text('Done there.')])]);
  fs.mkdirSync(core.syncDir(), { recursive: true });
  const name = `${path.basename(path.dirname(file))}/fixture-pulled.jsonl`;
  const st = fs.statSync(file);
  fs.writeFileSync(path.join(core.syncDir(), 'manifest.jsonl'), JSON.stringify({ family: 'transcripts', name, size: st.size, mtime: st.mtimeMs, origin: 'peer00000001' }) + '\n');
  const listed = listingParity(f.work);
  assert.deepEqual(listed.sessions.map((r) => r.id), ['fixture-pulled']);
  searchParity(f.work, 'machine');
  assert.deepEqual(core.queryIndex('sessions', {}).rows.map((r) => [r.id, r.machine, r.origin]), [['fixture-pulled', 'peer00000001', 'pulled']]);
  // Filed once: a manifest that no longer names it (sync rewrote it) and a change that derives its facts again leave
  // it where it was, one session, not two.
  fs.rmSync(path.join(core.syncDir(), 'manifest.jsonl'));
  fs.appendFileSync(file, JSON.stringify({ cwd: f.work, sessionId: 'fixture-pulled', ...ask('Another ask') }) + '\n');
  assert.deepEqual(core.queryIndex('sessions', {}).rows.map((r) => [r.id, r.machine]), [['fixture-pulled', 'peer00000001']]);
  fs.rmSync(file);
  assert.deepEqual(listingParity(f.work).sessions, [], 'gone from the listing with its file');
  // The copy gone (an on-demand copy evicted, one removed by hand) while younger than this machine's retention: the
  // session is its machine's again, as that machine's records describe it, and never archived here.
  assert.deepEqual(core.queryIndex('sessions', { archived: true }).rows.map((r) => [r.id, r.machine, r.origin, r.archived]), [['fixture-pulled', 'peer00000001', 'synced', 0]]);
  // A copy older than the retention went with Claude Code's sweep here: archived, as a session of this machine's would be.
  const old = f.claude('fixture-old', f.work, [ask('Work done long ago on the other machine'), reply('p3', [text('Done there.')])]);
  const then = new Date(Date.now() - 100 * 86_400_000);
  fs.utimesSync(old, then, then);
  const ost = fs.statSync(old);
  fs.writeFileSync(path.join(core.syncDir(), 'manifest.jsonl'), JSON.stringify({ family: 'transcripts', name: `${path.basename(path.dirname(old))}/fixture-old.jsonl`, size: ost.size, mtime: ost.mtimeMs, origin: 'peer00000001' }) + '\n');
  assert.deepEqual(core.queryIndex('sessions', { all: true }).rows.filter((r) => r.id === 'fixture-old').map((r) => [r.machine, r.origin]), [['peer00000001', 'pulled']], 'control');
  fs.rmSync(old);
  assert.deepEqual(core.queryIndex('sessions', { archived: true }).rows.filter((r) => r.id === 'fixture-old').map((r) => [r.origin, r.archived, r.archived_reason]), [['pulled', 1, 'retention']]);
});

// A copy oak sync pulled from a machine that names its directory differently: its transcript in this machine's folder for
// the project, its working directory that machine's. The listing leaves it out, and the index files nothing of it here,
// so nothing of it is published as this machine's. A row an earlier build filed of it here as this machine's own goes at
// the next catch-up, and so does the row this machine's record log published of it.
test('index: a copy from a machine that names its directory differently is filed nowhere here, and one filed here before goes', { skip }, (t) => {
  const f = indexFixture(t, core);
  f.claude('fixture-own', f.work, [ask('Own work here'), reply('o1', [text('ok')])]);
  const file = f.claude('fixture-copy', path.join(f.dir, 'there', 'src', 'app'), [ask('Work done on the other machine'), reply('c1', [text('Done there.')])], f.work);
  fs.mkdirSync(core.syncDir(), { recursive: true });
  const st = fs.statSync(file);
  // As oak sync records a file it landed: its size, time and hash then (sync-engine.ts).
  const landed = { family: 'transcripts', name: `${path.basename(path.dirname(file))}/fixture-copy.jsonl`, size: st.size, mtime: Math.floor(st.mtimeMs), sha256: require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'), origin: 'peer00000001' };
  fs.writeFileSync(path.join(core.syncDir(), 'manifest.jsonl'), JSON.stringify(landed) + '\n');
  assert.deepEqual(listingParity(f.work).sessions.map((r) => r.id), ['fixture-own'], 'control: the listing leaves the copy out');
  const me = core.machineHostTag();
  const log = () => core.segments(me).map((s) => fs.readFileSync(s.file, 'utf8')).join('');
  assert.ok(log().includes('fixture-own'), 'control: this machine published its own session');
  const stamp = withIndex((db) => {
    assert.equal(one(db, "SELECT count(*) AS n FROM sessions WHERE session_id = 'fixture-copy'").n, 0, 'nothing of the copy is filed here');
    return one(db, "SELECT state FROM ingest_state WHERE source = 'copy:fixture-copy'").state;
  });
  assert.ok(!log().includes('fixture-copy'), 'nor published');
  // As it was, the copy costs a catch-up nothing: one with nothing else to do writes nothing (not even its time), and one
  // that has other work passes the copy over.
  const reader = core.openIndex();
  assert.ok(reader.ok, reader.reason);
  try {
    const quiet = () => [one(reader.db, 'PRAGMA data_version').data_version, one(reader.db, "SELECT value FROM meta WHERE key = 'caught_up_ms'").value];
    const copyState = () => one(reader.db, "SELECT state, updated_ms FROM ingest_state WHERE source = 'copy:fixture-copy'");
    const before = quiet();
    const kept = { ...copyState() };
    caughtUp().close();
    assert.deepEqual(quiet(), before, 'nothing to do');
    fs.appendFileSync(path.join(path.dirname(file), 'fixture-own.jsonl'), JSON.stringify({ cwd: f.work, sessionId: 'fixture-own', ...ask('More own work') }) + '\n');
    const t0 = Date.now();
    while (Date.now() === t0) { /* a later millisecond than the copy's state */ }
    caughtUp().close();
    assert.notDeepEqual(quiet(), before, 'control: the own session\'s change was caught up');
    assert.deepEqual({ ...copyState() }, kept, 'the copy passed over, its state as it was');
  } finally {
    reader.close();
  }
  // As an earlier build filed it: a bare row of this machine's, stamped by that build's facts (INGEST_VERSION), which it
  // published as one of its sessions.
  assert.ok(stamp, 'control: the copy\'s stamp');
  const opened = core.openIndex();
  assert.ok(opened.ok, opened.reason);
  try {
    opened.db.prepare("INSERT INTO sessions (machine_id, session_id, agent, origin, listed, review, workspace, last_active_ms, inputs, updated_ms) VALUES (?, 'fixture-copy', 'claude', 'local', 0, 0, '', ?, ?, ?)")
      .run(me, Math.round(st.mtimeMs), '0'.repeat(stamp.length), Date.now());
    opened.db.prepare("DELETE FROM ingest_state WHERE source = 'copy:fixture-copy'").run();
  } finally {
    opened.close();
  }
  withIndex((db) => assert.equal(one(db, "SELECT count(*) AS n FROM sessions WHERE session_id = 'fixture-copy'").n, 0, 'the row filed before is gone'));
  assert.ok(log().includes(JSON.stringify({ t: 'sessions', d: { session_id: 'fixture-copy' } })), 'and its removal is published, for the machines that took it for this one\'s');
  assert.deepEqual(listingParity(f.work).sessions.map((r) => r.id), ['fixture-own']);
  // Changed here since oak sync landed it (a turn appended here, with no store and before any run): no longer as it
  // landed, so this machine's own.
  fs.appendFileSync(file, JSON.stringify({ cwd: f.work, sessionId: 'fixture-copy', ...ask('Continued here') }) + '\n');
  withIndex((db) => assert.deepEqual(rows(db, "SELECT machine_id FROM sessions WHERE session_id = 'fixture-copy'").map((x) => x.machine_id), [me], 'this machine\'s own'));
});

// Another machine's sessions and conversations from its records, as that machine lists and searches them itself: with
// its sessions oak sync brought here (filed under it, `pulled`), and only while nothing there may be running: no session
// active in the last two hours as its records or the files the last oak sync run saw there say, none waiting on a person.
test('index: another machine read from its records: its pulled sessions with its own, and over ssh while something there may be running', { skip }, (t) => {
  const f = indexFixture(t, core);
  const host = 'abcdef012345';
  const old = Date.now() - 3 * 3600_000;
  // A session of peer's that oak sync fetched here: its transcript, and the manifest naming peer as its origin.
  const file = f.claude('fixture-pulled', f.work, [ask('zebra migration plan'), reply('p1', [text('ok')])]);
  fs.utimesSync(file, old / 1000, old / 1000);
  const st = fs.statSync(file);
  fs.mkdirSync(core.syncDir(), { recursive: true });
  fs.writeFileSync(path.join(core.syncDir(), 'manifest.jsonl'), JSON.stringify({ family: 'transcripts', name: `${path.basename(path.dirname(file))}/fixture-pulled.jsonl`, size: st.size, mtime: Math.floor(st.mtimeMs), origin: host }) + '\n');
  // peer's record log with another of its sessions, the run that read it a minute ago, and what that run saw of its files.
  const segment = (records, tag) => {
    const at = Date.now() - 60_000;
    const seg = path.join(core.recordsRoot(), host, `${at}-${tag}.jsonl`);
    fs.mkdirSync(path.dirname(seg), { recursive: true });
    fs.writeFileSync(seg, [{ t: 'batch', at, v: 1, label: 'peer', platform: 'linux' }, ...records].map((x) => JSON.stringify(x)).join('\n') + '\n');
  };
  segment([{ t: 'sessions', r: { session_id: 'peer-own', agent: 'claude', origin: 'local', review: 0, title: 'zebra notes', workspace: '~/work', last_active_ms: old, capture_ms: 0, tokens: 12, model: 'Opus 4.8' } },
    { t: 'prompts', r: { session_id: 'peer-own', idx: 0, prompt_id: 'peer-own-p0', ts: old, end_ts: old + 1, text: 'zebra notes on peer', response: 'ok', source: 'x', nul: 0 } },
    { t: 'sessions', r: { session_id: 'peer-review', agent: 'codex', origin: 'local', review: 1, title: 'Assess the request', workspace: '~/work', last_active_ms: old, capture_ms: 0, tokens: 0, model: '' } }], '0badc0de');
  fs.writeFileSync(path.join(core.syncDir(), 'status.json'), JSON.stringify({ at: Date.now() - 60_000, durationMs: 1, status: 'ok', warnings: [], machines: [{ label: 'peer', host, status: 'ok', lastOkAt: Date.now() - 60_000 }] }));
  // On its own clock (here two days behind this one), which only its own times are compared with.
  const theirs = Date.now() - 2 * 86_400_000;
  const seen = (newest, extra = []) => {
    fs.mkdirSync(path.join(core.syncDir(), 'index'), { recursive: true });
    fs.writeFileSync(path.join(core.syncDir(), 'index', `${host}.json`), JSON.stringify({ label: 'peer', savedAt: Date.now() - 60_000,
      inventory: { inventory: 1, at: theirs, host, families: { transcripts: [{ name: 'p/peer-own.jsonl', size: 1, mtime: theirs - newest }, ...extra] } } }));
  };
  seen(3 * 3600_000); // on its own clock, three hours before the run
  withIndex(() => {});
  // A search here reads the pulled session's asks from the index, as it reads this machine's own: never from its files.
  withIndex((db) => {
    const docs = require('../dist/index/listing').indexedDocs(db);
    const got = docs(f.work, { id: 'fixture-pulled', transcript: file });
    assert.deepEqual([got.built, got.docs.map((d) => d.prompt), docs.fallbacks], [false, ['zebra migration plan'], 0]);
  });
  const listed = core.indexedMachineSessions('peer');
  assert.ok(listed?.fromIndex, 'positive control: nothing there may be running');
  assert.deepEqual(listed.sessions.map((r) => r.id).sort(), ['fixture-pulled', 'peer-own'], 'with the session oak sync brought here, as peer lists it');
  // As peer lists one named with --session: whatever it is (here an Auto-review thread, which its listing leaves out).
  assert.deepEqual(core.indexedMachineSessions('peer', Date.now(), 'peer-review').sessions.map((r) => r.id).sort(), ['fixture-pulled', 'peer-own', 'peer-review']);
  assert.deepEqual(core.indexedMachineSearch('peer', 'zebra').hits.map((h) => h.session).sort(), ['fixture-pulled', 'peer-own'], 'and searched as peer searches it');
  // A file the run saw written there ten minutes before it, whatever its records say yet: asked there.
  seen(10 * 60_000);
  assert.equal(core.indexedMachineSessions('peer'), null, 'files written lately');
  // A copy it keeps of another machine's session is that machine's work, not its own.
  seen(3 * 3600_000, [{ name: 'p/elsewhere.jsonl', size: 1, mtime: theirs - 60_000, origin: 'fedcba987654' }]);
  assert.ok(core.indexedMachineSessions('peer')?.fromIndex, 'a copy written lately');
  seen(3 * 3600_000);
  // A run that stopped, or reached it and failed a pull, leaves when it last read it whole where it was.
  const status = path.join(core.syncDir(), 'status.json');
  fs.writeFileSync(status, JSON.stringify({ at: Date.now() - 60_000, durationMs: 1, status: 'partial', warnings: [], machines: [{ label: 'peer', host, status: 'ok', lastOkAt: Date.now() - 3 * 3600_000 }] }));
  assert.equal(core.indexedMachineSessions('peer'), null, 'not read whole lately');
  fs.writeFileSync(status, JSON.stringify({ at: Date.now() - 60_000, durationMs: 1, status: 'ok', warnings: [], machines: [{ label: 'peer', host, status: 'ok', lastOkAt: Date.now() - 60_000 }] }));
  // A hand still raised there, however long ago: asked there, where it shows.
  segment([{ t: 'waits', r: { session_id: 'peer-own', start_ms: old, end_ms: null, kind: 'permission' } }], '0badc0df');
  withIndex(() => {});
  assert.equal(core.indexedMachineSessions('peer'), null, 'a session waiting on a person');
  // …but not one raised more than a day ago and never lowered (a session that ended without saying so).
  segment([{ t: 'waits', r: { session_id: 'peer-own', start_ms: old, end_ms: old + 1000, kind: 'permission' } },
    { t: 'waits', r: { session_id: 'peer-own', start_ms: Date.now() - 2 * 86_400_000, end_ms: null, kind: 'input' } }], '0badc0e0');
  withIndex(() => {});
  assert.ok(core.indexedMachineSessions('peer')?.fromIndex, 'a hand left up for days');
});

// This machine's tag hashes its host name and home; macOS renames the host with the network. Sessions indexed before
// keep the tag they were filed under, and `--machine self` found only those of one tag.
test('query: --machine self finds this machine\'s sessions under every tag it has had', { skip }, (t) => {
  const f = indexFixture(t, core);
  f.claude('fixture-before', f.work, [ask('Before the rename'), reply('t1', [text('ok')])]);
  withIndex(() => {});
  const home = [process.env.HOME, process.env.USERPROFILE];
  // The tag changes as it does with the host name (os.homedir() reads USERPROFILE on Windows).
  process.env.HOME = process.env.USERPROFILE = path.join(f.dir, 'renamed');
  try {
    f.claude('fixture-after', f.work, [ask('After the rename'), reply('t2', [text('ok')])]);
    const all = core.queryIndex('sessions', {}).rows;
    assert.equal(new Set(all.map((r) => r.machine)).size, 2, 'positive control: filed under two tags');
    assert.deepEqual(core.queryIndex('sessions', { machine: 'self' }).rows.map((r) => r.id).sort(), ['fixture-after', 'fixture-before']);
  } finally {
    [process.env.HOME, process.env.USERPROFILE] = home;
  }
});

// What JetBrains asks of `oak query --serve`: one session by id (its pin check), and the machine's newest Codex sessions
// with the folder each ran in (its refresh signal, which it matches to the project's folders itself).
test('query: sessions --id names one session, and every row says the folder it ran in (cwd)', { skip }, (t) => {
  const f = indexFixture(t, core);
  const cwds = { 'fixture-u1': path.join(f.work, 'proj'), 'fixture-u2': path.join(f.work, 'proj', 'sub'), 'fixture-u3': path.join(f.work, 'prøj-ü') };
  for (const [id, cwd] of Object.entries(cwds)) {
    fs.mkdirSync(cwd, { recursive: true });
    f.claude(id, cwd, [ask('Work here'), reply(`${id}-r`, [text('ok')])]);
  }
  f.rollout('0199a000-0000-7000-8000-0000000000d1', cwds['fixture-u2'], [cxUser('Work there')]);
  withIndex(() => {});
  const rows = (p) => core.queryIndex('sessions', p).rows;
  assert.deepEqual(rows({}).map((r) => r.id).sort(), [...Object.keys(cwds), '0199a000-0000-7000-8000-0000000000d1'].sort(), 'positive control: every one is indexed');
  assert.deepEqual(rows({ id: 'fixture-u3' }).map((r) => [r.id, r.cwd]), [['fixture-u3', cwds['fixture-u3']]]);
  assert.deepEqual(rows({ agent: 'codex' }).map((r) => [r.id, r.cwd]), [['0199a000-0000-7000-8000-0000000000d1', cwds['fixture-u2']]]);
  assert.equal(core.queryIndex('sessions', { under: f.work }).error?.code, 'bad_param', 'no folder filter: the caller matches folders itself');
});

test('index: notes: plans, memories and skills are indexed and searchable; one removed is kept, archived', { skip }, (t) => {
  const f = indexFixture(t, core);
  const plan = path.join(process.env.CLAUDE_CONFIG_DIR, 'plans', 'ship-it.md');
  fs.mkdirSync(path.dirname(plan), { recursive: true });
  fs.writeFileSync(plan, '# Ship the zebracorn release\n\nSteps.\n');
  const mem = path.join(core.projectDir(f.work), 'memory', 'notes.md');
  fs.mkdirSync(path.dirname(mem), { recursive: true });
  fs.writeFileSync(mem, 'Remember the tokenizer quirk.\n');
  const skill = path.join(process.env.CLAUDE_CONFIG_DIR, 'skills', 'review', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '# Review\n');
  let q = core.queryIndex('notes', {});
  assert.deepEqual(q.rows.map((r) => r.kind).sort(), ['memory', 'plan', 'skill']);
  assert.equal(core.queryIndex('notes', { text: 'zebracorn' }).rows[0]?.title, 'Ship the zebracorn release');
  fs.rmSync(plan);
  q = core.queryIndex('notes', {});
  assert.deepEqual(q.rows.map((r) => r.kind).sort(), ['memory', 'skill']);
  const all = core.queryIndex('notes', { archived: true });
  assert.deepEqual(all.rows.filter((r) => r.archived).map((r) => r.path), [plan]);
});

// --- the archive --------------------------------------------------------------------------------------------------

function archiveFixture(t) {
  const f = indexFixture(t, core);
  const id = 'fixture-archive';
  const transcript = f.claude(id, f.work, [ask('Teach the zebracorn parser'), reply('z1', [text('The zebracorn parser is taught.')])]);
  f.store(id, f.work, [['a.ts', 'a\n', 'b\n', Date.now() - 1000]]);
  withIndex(() => {});
  return { f, id, transcript };
}

test('archive: OAK\'s cleanup (clean --drop) then the transcript gone: archived as cleaned, every row kept and searchable when asked', { skip }, (t) => {
  const { id, transcript } = archiveFixture(t);
  core.indexBeforeCleanup([id], { archive: true });
  core.removeSession(id);
  fs.rmSync(transcript);
  withIndex((db) => {
    const s = one(db, 'SELECT archived_ms, archived_reason FROM sessions WHERE session_id = ?', id);
    assert.ok(s.archived_ms > 0);
    assert.equal(s.archived_reason, 'cleaned');
    assert.equal(one(db, 'SELECT count(*) AS n FROM edits WHERE session_id = ? AND cleared_ms IS NOT NULL', id).n, 1, 'its edits stay, marked cleared');
    assert.equal(one(db, 'SELECT count(*) AS n FROM prompts WHERE session_id = ?', id).n, 1, 'its asks and answers stay');
    assert.equal(one(db, 'SELECT count(*) AS n FROM blobs WHERE session_id = ? AND present = 0', id).n, 2, 'its blobs are listed as gone');
  });
  // Left out by default; with --archived (or --all) each row is marked with when and why.
  assert.equal(core.queryIndex('sessions', {}).rowCount, 0);
  const shown = core.queryIndex('sessions', { archived: true }).rows;
  assert.deepEqual(shown.map((r) => [r.id, r.archived, r.archived_reason]), [[id, 1, 'cleaned']]);
  assert.equal(core.queryIndex('search', { text: 'zebracorn' }).rowCount, 0, 'search leaves the archive out');
  assert.deepEqual(core.queryIndex('search', { text: 'zebracorn', archived: true }).rows.map((r) => [r.session, r.archived]), [[id, 1]]);
  assert.equal(core.queryIndex('edits', {}).rowCount, 0);
  assert.equal(core.queryIndex('edits', { all: true }).rowCount, 1);
  assert.equal(core.queryIndex('prompts', { session: id }).rowCount, 0);
  assert.equal(core.queryIndex('prompts', { session: id, archived: true }).rowCount, 1);
});

test('archive: a transcript that vanished is archived: retention when older than Claude Code keeps them, else missing', { skip }, (t) => {
  const f = indexFixture(t, core);
  const old = f.claude('fixture-old', f.work, [ask('Old work'), reply('o1', [text('done')])]);
  const recent = f.claude('fixture-recent', f.work, [ask('Recent work'), reply('r1', [text('done')])]);
  const days = 40 * 86_400;
  fs.utimesSync(old, Date.now() / 1000 - days, Date.now() / 1000 - days);
  withIndex(() => {});
  fs.rmSync(old);
  fs.rmSync(recent);
  withIndex((db) => {
    assert.deepEqual(rows(db, 'SELECT session_id, archived_reason FROM sessions ORDER BY session_id').map((r) => [r.session_id, r.archived_reason]), [['fixture-old', 'retention'], ['fixture-recent', 'missing']]);
  });
  // A session whose file comes back (a restore) is live again.
  f.claude('fixture-recent', f.work, [ask('Recent work'), reply('r1', [text('done')])]);
  withIndex((db) => assert.equal(one(db, "SELECT archived_ms FROM sessions WHERE session_id = 'fixture-recent'").archived_ms, null));
});

// Files that go away and come back unchanged (a folder moved out and back, a volume that was not mounted, CODEX_HOME
// pointed elsewhere for a while) keep their stamps: the session is still brought back whole.
test('archive: a session whose files come back unchanged is live again, its edits and blobs with it', { skip }, (t) => {
  const { f, id } = archiveFixture(t);
  const project = core.projectDir(f.work);
  const store = core.storeDir(id);
  const away = (p) => path.join(f.dir, `away-${path.basename(p)}`);
  const before = withIndex((db) => ({
    listing: core.indexedSessionMeta(db, f.work),
    edits: rows(db, 'SELECT id, cleared_ms FROM edits WHERE session_id = ?', id),
    blobs: rows(db, 'SELECT sha, present FROM blobs WHERE session_id = ? ORDER BY sha', id),
  }));
  for (const p of [project, store]) fs.renameSync(p, away(p));
  withIndex((db) => {
    assert.equal(one(db, 'SELECT archived_reason FROM sessions WHERE session_id = ?', id).archived_reason, 'missing');
    assert.equal(one(db, 'SELECT count(*) AS n FROM edits WHERE session_id = ? AND cleared_ms IS NULL', id).n, 0);
  });
  for (const p of [project, store]) fs.renameSync(away(p), p);
  core.clearFsCache();
  withIndex((db) => {
    assert.equal(one(db, 'SELECT archived_ms FROM sessions WHERE session_id = ?', id).archived_ms, null, 'live again');
    assert.deepEqual(rows(db, 'SELECT id, cleared_ms FROM edits WHERE session_id = ?', id), before.edits, 'its edits are not cleared');
    assert.deepEqual(rows(db, 'SELECT sha, present FROM blobs WHERE session_id = ? ORDER BY sha', id), before.blobs, 'its blobs are present');
    assert.deepEqual(core.indexedSessionMeta(db, f.work), before.listing, 'and it is listed as before');
  });
  listingParity(f.work);
});

test('archive: clean --resolved keeps the records it drops from the log, marked cleared', { skip }, (t) => {
  const f = indexFixture(t, core);
  const id = 'fixture-resolved';
  f.claude(id, f.work, [ask('Edit two files'), reply('e1', [text('ok')])]);
  f.store(id, f.work, [['a.ts', 'a\n', 'b\n', 1000, 'kept'], ['b.ts', 'c\n', 'd\n', 2000]]);
  withIndex(() => {});
  core.indexBeforeCleanup([id], { archive: false });
  assert.equal(core.clearResolved(id), 1);
  withIndex((db) => {
    assert.deepEqual(rows(db, 'SELECT id, cleared_ms IS NOT NULL AS cleared FROM edits WHERE session_id = ? ORDER BY id', id).map((r) => [r.id, r.cleared]), [[1, 1], [2, 0]]);
    assert.equal(one(db, 'SELECT archived_ms FROM sessions WHERE session_id = ?', id).archived_ms, null, 'the session itself is live');
  });
  assert.deepEqual(core.queryIndex('edits', { session: id }).rows.map((r) => r.id), [2]);
  assert.deepEqual(core.queryIndex('edits', { session: id, archived: true }).rows.map((r) => [r.id, r.archived, r.archived_reason]), [[2, 0, null], [1, 1, 'cleaned']]);
});

test('archive: a deliberate delete purges every row of the session, its full-text entries with them; undelete brings it back', { skip }, (t) => {
  const { f, id } = archiveFixture(t);
  core.deleteSession(id, { confirmedPending: Infinity });
  core.indexForget(id);
  const ix = caughtUp();
  try {
    for (const table of core.SESSION_TABLES) assert.equal(one(ix.db, `SELECT count(*) AS n FROM ${table} WHERE session_id = ?`, id).n, 0, `${table} holds nothing of it`);
    assert.equal(one(ix.db, "SELECT count(*) AS n FROM prompts_fts WHERE prompts_fts MATCH 'zebracorn'").n, 0, 'nor does the full-text index');
    assert.equal(one(ix.db, 'SELECT source FROM tombstones WHERE session_id = ?', id).source, 'deleted here');
    ix.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    ix.close();
  }
  assert.equal(core.queryIndex('search', { text: 'zebracorn', all: true }).rowCount, 0);
  // The words are gone from the file itself, the full-text index's own pages included, not only from its tables.
  const bytes = Buffer.concat([core.indexFile(), core.indexFile() + '-wal'].filter((p) => fs.existsSync(p)).map((p) => fs.readFileSync(p)));
  assert.equal(bytes.includes(Buffer.from('zebracorn')), false, 'secure_delete zeroed the freed pages');
  core.unhideSession(id);
  withIndex((db) => {
    assert.equal(one(db, 'SELECT count(*) AS n FROM tombstones WHERE session_id = ?', id).n, 0);
    assert.equal(one(db, 'SELECT count(*) AS n FROM prompts WHERE session_id = ?', id).n, 1, 'its transcript is indexed again');
  });
  // Deleted by another process (an editor), the next catch-up forgets it.
  core.hideSession(id);
  withIndex((db) => assert.equal(one(db, 'SELECT count(*) AS n FROM sessions WHERE session_id = ?', id).n, 0));
  void f;
});

// A long-lived reader (the terminal app's worker, an editor) keeps the write-ahead log open, where the pages a session
// was written in stay until they are overwritten: a deliberate delete checkpoints it into the file and truncates it.
test('archive: a deliberate delete leaves no copy of the session in the write-ahead log while another reader holds it open', { skip }, (t) => {
  const f = indexFixture(t, core);
  const hold = core.openIndex();
  assert.ok(hold.ok, hold.reason);
  try {
    const id = 'fixture-wal';
    f.claude(id, f.work, [ask('Teach the quokkacorn parser'), reply('w1', [text('The quokkacorn parser is taught.')])]);
    withIndex(() => {});
    const wal = core.indexFile() + '-wal';
    const has = (word) => [core.indexFile(), wal].filter((p) => fs.existsSync(p)).some((p) => fs.readFileSync(p).includes(Buffer.from(word)));
    assert.ok(has('quokkacorn'), 'positive control: the words are in the files while the session is indexed');
    core.deleteSession(id, { confirmedPending: Infinity });
    core.indexForget(id);
    assert.equal(has('quokkacorn'), false, 'neither the file nor its write-ahead log holds them');
    // Deleted where nothing told the index (an editor's delete): the next catch-up purges it the same way.
    f.claude('fixture-wal2', f.work, [ask('Teach the wombatcorn parser'), reply('w2', [text('The wombatcorn parser is taught.')])]);
    withIndex(() => {});
    assert.ok(has('wombatcorn'), 'positive control: indexed');
    core.hideSession('fixture-wal2');
    withIndex(() => {});
    assert.equal(has('wombatcorn'), false, 'a catch-up that purges leaves no copy either');
  } finally {
    hold.close();
  }
});

test('archive: a delete on another machine (oak sync\'s tombstone) purges here too', { skip }, (t) => {
  const { id } = archiveFixture(t);
  fs.mkdirSync(core.syncDir(), { recursive: true });
  fs.appendFileSync(path.join(core.syncDir(), 'tombstones.jsonl'), JSON.stringify({ kind: 'session', key: id, deleted: true, at: Date.now(), host: 'peer00000001' }) + '\n');
  withIndex((db) => {
    assert.equal(one(db, 'SELECT count(*) AS n FROM sessions WHERE session_id = ?', id).n, 0);
    assert.equal(one(db, 'SELECT source FROM tombstones WHERE session_id = ?', id).source, 'deleted on peer00000001');
  });
});

test('archive: a new index format carries the archive over; the previous file is kept until clean, and only once verified', { skip }, (t) => {
  const { f, id, transcript } = archiveFixture(t);
  core.indexBeforeCleanup([id], { archive: true });
  core.removeSession(id);
  fs.rmSync(transcript);
  f.claude('fixture-live', f.work, [ask('Live work'), reply('l1', [text('ok')])]);
  withIndex(() => {});
  const v1 = core.indexFile();
  // Another store's index, written after this one: the archive still comes from this store's own file.
  const other = path.join(path.dirname(v1), 'index-v1-0123456789abcdef.sqlite');
  const o = core.openIndex(other);
  assert.ok(o.ok, o.reason);
  o.close();
  const later = Date.now() / 1000 + 60;
  fs.utimesSync(other, later, later);
  // The next OAK's build: the same code with INDEX_FORMAT 2.
  const next = path.join(f.dir, 'core-next');
  fs.cpSync(DIST, path.join(next, 'dist'), { recursive: true });
  fs.symlinkSync(path.resolve(DIST, '..', '..', '..', 'node_modules'), path.join(next, 'node_modules'), 'junction');
  const loc = path.join(next, 'dist', 'index', 'location.js');
  fs.writeFileSync(loc, fs.readFileSync(loc, 'utf8').replace(/exports\.INDEX_FORMAT = 1;/, 'exports.INDEX_FORMAT = 2;'));
  const run = (code) => cp.spawnSync(process.execPath, ['-e', code], { env: process.env, encoding: 'utf8' });
  const r = run(`const core = require(${JSON.stringify(path.join(next, 'dist', 'index.js'))});
const ix = core.useIndex({ budgetMs: Infinity, inlineBytes: Infinity });
const n = (sql) => ix.db.prepare(sql).get().n;
console.log(JSON.stringify({ file: ix.file, sessions: n("SELECT count(*) AS n FROM sessions WHERE session_id = '${id}' AND archived_reason = 'cleaned'"),
  prompts: n("SELECT count(*) AS n FROM prompts WHERE session_id = '${id}'"), edits: n("SELECT count(*) AS n FROM edits WHERE session_id = '${id}'"),
  fts: n("SELECT count(*) AS n FROM prompts_fts WHERE prompts_fts MATCH 'zebracorn'"), live: n("SELECT count(*) AS n FROM sessions WHERE session_id = 'fixture-live'"),
  verified: ix.db.prepare("SELECT value FROM meta WHERE key = 'archive_carry_verified'").get().value, from: ix.db.prepare("SELECT value FROM meta WHERE key = 'archive_carried_from'").get().value }));
ix.close();
console.log(JSON.stringify(core.reclaimableIndexFiles()));`);
  assert.equal(r.status, 0, r.stderr);
  const [carried, reclaim] = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.match(path.basename(carried.file), /^index-v2-/);
  assert.deepEqual([carried.sessions, carried.prompts, carried.edits, carried.fts, carried.live], [1, 1, 1, 1, 1], 'the archived session, its rows and its full-text entries; the live one rebuilt');
  assert.deepEqual([carried.verified, carried.from], ['1', v1]);
  assert.deepEqual(reclaim, [v1], 'the old file is kept, and clean may now remove it');
  assert.ok(fs.existsSync(v1));
});

// `oak clean --drop` removes a store; when the session goes on, a new store begins its log at id 1 again, and its
// comments file is a new one. The index had filed the new edit #1 over the archived #1, and dropped the archived
// comments as if a person had taken them back.
test('archive: a session dropped by clean and then resumed keeps its earlier edits and comments; the new store\'s ids overwrite nothing', { skip }, (t) => {
  const f = indexFixture(t, core);
  const base = (file) => path.basename(file);
  for (const [id, seenGone] of [['fixture-resumed', true], ['fixture-replaced', false]]) {
    f.claude(id, f.work, [ask('Edit two files'), reply(`${id}-r1`, [text('ok')])]);
    f.store(id, f.work, [['first.ts', 'a\n', 'b\n', 1000, 'kept'], ['second.ts', 'c\n', 'd\n', 2000, 'kept']]);
    core.addComment(id, { unit: 1, line: 1, text: 'Rename this to zebracorn' });
    withIndex(() => {});
    core.indexBeforeCleanup([id], { archive: true });
    core.removeSession(id);
    if (seenGone) withIndex(() => {}); // a catch-up saw the store gone (else it is replaced between two catch-ups)
    f.store(id, f.work, [['third.ts', 'e\n', 'f\n', 3000]]);
    assert.deepEqual(core.readLog(id).map((r) => r.id), [1], 'positive control: the new log begins at 1');
    const fresh = core.addComment(id, { unit: 1, line: 0, text: 'A new comment' });
    withIndex((db) => {
      assert.deepEqual(rows(db, 'SELECT file, cleared_ms IS NOT NULL AS cleared FROM edits WHERE session_id = ? ORDER BY ts', id).map((r) => [base(r.file), r.cleared]),
        [['first.ts', 1], ['second.ts', 1], ['third.ts', 0]], id);
      assert.deepEqual(rows(db, 'SELECT text FROM comments WHERE session_id = ? ORDER BY created_ms', id).map((r) => r.text), ['Rename this to zebracorn', 'A new comment'], id);
    });
    assert.deepEqual(core.queryIndex('edits', { session: id }).rows.map((r) => [r.id, base(r.file)]), [[1, 'third.ts']], 'the live edits are the log\'s');
    // A comment a person takes back still goes.
    core.removeComment(id, fresh.id);
    withIndex((db) => assert.deepEqual(rows(db, 'SELECT text FROM comments WHERE session_id = ?', id).map((r) => r.text), ['Rename this to zebracorn']));
  }
});

// Claude Code's retention sweeps a transcript while OAK's store for it stays (stores outlive the 30-day sweep): the
// index had blanked the session's title, first ask, tokens and model.
test('archive: a transcript swept while its store stays keeps the session\'s title, first ask and vitals', { skip }, (t) => {
  const f = indexFixture(t, core);
  const id = 'fixture-swept';
  const file = f.claude(id, f.work, [ask('Port the zebracorn exporter'), reply('s1', [text('Ported.')], undefined, { input_tokens: 5000, output_tokens: 700 })]);
  f.store(id, f.work, [['x.rs', 'a\n', 'b\n', 1000]]);
  const cols = 'SELECT title, first_prompt, tokens, model, cwd, workspace FROM sessions WHERE session_id = ?';
  const before = withIndex((db) => ({ ...one(db, cols, id) }));
  assert.equal(before.title, 'Port the zebracorn exporter', 'positive control');
  fs.rmSync(file);
  withIndex((db) => assert.deepEqual({ ...one(db, cols, id) }, before));
  assert.equal(core.queryIndex('sessions', { text: 'zebracorn', all: true }).rowCount, 1, 'still found by its title');
});

// OAK's cleanup must record a session before it removes it; while another process held the catch-up lease (a long
// build), the cleanup recorded nothing and the session's newest edits were lost with its store.
test('archive: a cleanup asks a catch-up running elsewhere for the lease, which hands it over, and records the session first', { skip }, async (t) => {
  const f = indexFixture(t, core);
  const id = 'fixture-dropped';
  f.claude(id, f.work, [ask('Edit a file'), reply('d1', [text('ok')])]);
  f.store(id, f.work, [['one.ts', 'a\n', 'b\n', 1000]]);
  withIndex(() => {});
  for (let i = 0; i < 30; i++) f.claude(`fixture-busy-${i}`, f.work, [ask(`Busy ${i}`), reply(`busy-${i}`, [text('ok')])]);
  f.store(id, f.work, [['two.ts', 'c\n', 'd\n', 2000]]); // not yet in the index
  const started = path.join(f.dir, 'started');
  const build = cp.spawn(process.execPath, ['-e', `const core = require(${JSON.stringify(path.join(DIST, 'index.js'))}); const o = core.openIndex(); let n = 0;
const r = core.catchUp(o.db, { afterUnit: () => { if (!n++) require('fs').writeFileSync(${JSON.stringify(started)}, ''); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); } });
console.log(JSON.stringify({ ran: r.ran, left: r.left })); o.close();`], { env: process.env });
  let out = '';
  build.stdout.on('data', (d) => (out += d));
  const ended = new Promise((resolve) => build.on('close', resolve));
  while (!fs.existsSync(started)) await new Promise((resolve) => setTimeout(resolve, 20));
  const t0 = Date.now();
  assert.deepEqual(core.indexBeforeCleanup([id], { archive: true }), [], 'nothing kept it from recording the session');
  assert.ok(Date.now() - t0 < 5000, `handed over at the build's next session (${Date.now() - t0} ms), not after the whole build`);
  core.removeSession(id);
  await ended;
  assert.ok(JSON.parse(out).left > 0, `the build stopped part way to hand the lease over: ${out}`);
  withIndex((db) => assert.deepEqual(rows(db, 'SELECT id, cleared_ms IS NOT NULL AS cleared FROM edits WHERE session_id = ? ORDER BY id', id).map((r) => [r.id, r.cleared]), [[1, 1], [2, 1]]));
  // A holder that never hands over: the cleanup waits its bound, then says what it could not do.
  const holder = core.openIndex();
  try {
    assert.ok(core.tryLease(holder.db, Date.now(), 'another-process'));
    holder.db.prepare('UPDATE lease SET pid = ? WHERE id = 1').run(process.ppid);
    const t1 = Date.now();
    const problems = core.indexBeforeCleanup(['fixture-busy-0'], { archive: true, waitMs: 300 });
    assert.ok(Date.now() - t1 >= 300);
    assert.match(problems.join(' '), /kept the local database busy/);
  } finally {
    core.releaseLease(holder.db, 'another-process');
    holder.close();
  }
});

// A lease that cannot be taken while nobody holds it (a full disk: the write fails) is not one to wait for: the cleanup
// says so at once rather than after its whole wait (measured with writes failing under an LD_PRELOAD shim: 30 s).
test('archive: a cleanup that cannot take the lease while nobody holds it does not wait, and says why', { skip }, (t) => {
  const f = indexFixture(t, core);
  f.claude('fixture-full', f.work, [ask('One'), reply('u1', [text('ok')])]);
  f.store('fixture-full', f.work, [['a.ts', 'a\n', 'b\n', 1000]]);
  withIndex(() => {});
  const o = core.openIndex();
  o.db.exec("CREATE TRIGGER lease_fails BEFORE UPDATE ON lease BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END");
  o.close();
  const t0 = Date.now();
  const problems = core.indexBeforeCleanup(['fixture-full'], { archive: false, waitMs: 5000 });
  assert.ok(Date.now() - t0 < 2500, `answered in ${Date.now() - t0} ms`);
  assert.match(problems.join(' '), /could not be written/);
});

/** The next OAK's core: this build, with INDEX_FORMAT 2, so it builds a new file and carries the archive into it. */
function nextFormatCore(dir) {
  const next = path.join(dir, 'core-next');
  fs.cpSync(DIST, path.join(next, 'dist'), { recursive: true });
  fs.symlinkSync(path.resolve(DIST, '..', '..', '..', 'node_modules'), path.join(next, 'node_modules'), 'junction');
  const loc = path.join(next, 'dist', 'index', 'location.js');
  fs.writeFileSync(loc, fs.readFileSync(loc, 'utf8').replace(/exports\.INDEX_FORMAT = 1;/, 'exports.INDEX_FORMAT = 2;'));
  return path.join(next, 'dist', 'index.js');
}

// The carry used to take only sessions archived whole. What only the index holds of a live session (the records
// `clean --resolved` dropped, its comments, what it read of a conversation whose file has gone) was left in the old
// file, which then reported itself carried and verified, and `oak clean` removed it.
test('archive: a new index format carries what only the index holds of live sessions: cleared edits, comments, a swept transcript', { skip }, (t) => {
  const f = indexFixture(t, core);
  f.claude('fixture-cleared', f.work, [ask('Edit two files'), reply('c1', [text('ok')])]);
  f.store('fixture-cleared', f.work, [['kept.ts', 'a\n', 'b\n', 1000, 'kept'], ['pending.ts', 'c\n', 'd\n', 2000]]);
  core.addComment('fixture-cleared', { unit: 2, line: 1, text: 'Keep this note' });
  const swept = f.claude('fixture-swept', f.work, [ask('Teach the zebracorn parser'), reply('s1', [text('The zebracorn parser is taught.')])]);
  f.store('fixture-swept', f.work, [['s.ts', 'x\n', 'y\n', 3000]]);
  withIndex(() => {});
  core.indexBeforeCleanup(['fixture-cleared'], { archive: false });
  assert.equal(core.clearResolved('fixture-cleared'), 1);
  fs.rmSync(swept);
  const v1 = withIndex((db, ix) => {
    assert.equal(one(db, "SELECT count(*) AS n FROM edits WHERE session_id = 'fixture-cleared' AND cleared_ms IS NOT NULL").n, 1, 'positive control');
    return ix.file;
  });
  const r = cp.spawnSync(process.execPath, ['-e', `const core = require(${JSON.stringify(nextFormatCore(f.dir))});
const ix = core.useIndex({ budgetMs: Infinity, inlineBytes: Infinity }); const db = ix.db; const n = (sql) => db.prepare(sql).get().n;
console.log(JSON.stringify({ cleared: n("SELECT count(*) AS n FROM edits WHERE session_id = 'fixture-cleared' AND cleared_ms IS NOT NULL"),
  comments: n("SELECT count(*) AS n FROM comments WHERE text = 'Keep this note'"),
  answers: n("SELECT count(*) AS n FROM prompts WHERE session_id = 'fixture-swept' AND response = 'The zebracorn parser is taught.'"),
  title: db.prepare("SELECT title FROM sessions WHERE session_id = 'fixture-swept'").get()?.title ?? null,
  verified: db.prepare("SELECT value FROM meta WHERE key = 'archive_carry_verified'").get().value }));
ix.close();
console.log(JSON.stringify(core.reclaimableIndexFiles()));`], { env: process.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const [carried, reclaim] = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(carried, { cleared: 1, comments: 1, answers: 1, title: 'Teach the zebracorn parser', verified: '1' });
  assert.deepEqual(reclaim, [v1], 'only then may clean remove the old file');
});

// A superseded format's file is kept until `oak clean` removes it; a deliberate delete forgot the session only in the
// current one, and the old file kept its text.
test('archive: a deliberate delete forgets the session in every index file, a superseded one included', { skip }, (t) => {
  const f = indexFixture(t, core);
  f.claude('fixture-forget-a', f.work, [ask('Teach the quokkacorn parser'), reply('q1', [text('The quokkacorn parser is taught.')])]);
  f.claude('fixture-forget-b', f.work, [ask('Teach the wombatcorn parser'), reply('w1', [text('The wombatcorn parser is taught.')])]);
  withIndex(() => {});
  const old = path.join(core.indexDir(), `index-v0-${core.storeKey()}.sqlite`);
  fs.copyFileSync(core.indexFile(), old);
  const holds = (word) => [old, `${old}-wal`].filter((p) => fs.existsSync(p)).some((p) => fs.readFileSync(p).includes(Buffer.from(word)));
  assert.ok(holds('quokkacorn') && holds('wombatcorn'), 'positive control: the old file holds both');
  core.deleteSession('fixture-forget-a', { confirmedPending: Infinity });
  core.indexForget('fixture-forget-a');
  assert.equal(holds('quokkacorn'), false, 'oak sessions --delete');
  core.hideSession('fixture-forget-b'); // deleted where nothing told the index: the next catch-up forgets it
  withIndex(() => {});
  assert.equal(holds('wombatcorn'), false, 'the catch-up that purges');
});

// --- crash safety and concurrency -----------------------------------------------------------------------------------

test('index: a catch-up killed partway resumes where its last commit left it, with nothing twice', { skip }, async (t) => {
  const f = indexFixture(t, core);
  for (let i = 0; i < 6; i++) f.claude(`fixture-crash-${i}`, f.work, Array.from({ length: 40 }, (_, k) => k % 2 ? reply(`c${i}-${k}`, [text(`Answer ${k} of session ${i}.`)]) : ask(`Ask ${k} of session ${i}`)));
  // Killed after the second session's work was committed.
  const r = cp.spawnSync(process.execPath, ['-e', `const core = require(${JSON.stringify(path.join(DIST, 'index.js'))});
const o = core.openIndex(); let n = 0;
core.catchUp(o.db, { afterUnit: () => { if (++n === 2) process.exit(9); } });`], { env: process.env, encoding: 'utf8' });
  assert.equal(r.status, 9, r.stderr);
  withIndex((db) => {
    for (let i = 0; i < 6; i++) {
      const p = rows(db, 'SELECT idx FROM prompts WHERE session_id = ? ORDER BY idx', `fixture-crash-${i}`).map((x) => x.idx);
      assert.deepEqual(p, Array.from({ length: 20 }, (_, k) => k), `session ${i}: every ask once, in order`);
    }
  });
  // Killed by SIGKILL in the middle of a large transcript's fold, at its seventh batch (with a transaction open): its
  // rows and its cursor commit together, so what was not committed is folded again, once.
  f.claude('fixture-big', f.work, Array.from({ length: 30000 }, (_, k) => k % 2 ? reply(`b-${k}`, [text(`Answer ${k} `.repeat(20))]) : ask(`Ask ${k}`)));
  const killed = cp.spawnSync(process.execPath, ['-e', `const core = require(${JSON.stringify(path.join(DIST, 'index.js'))}); const o = core.openIndex(); let n = 0;
core.catchUp(o.db, { afterBatch: () => { if (++n === 7) process.kill(process.pid, 'SIGKILL'); } });`], { env: process.env });
  assertKilled(killed);
  const partial = core.openIndex();
  const before = one(partial.db, "SELECT count(*) AS n FROM prompts WHERE session_id = 'fixture-big'").n;
  partial.close();
  assert.ok(before > 0 && before < 15000, `killed part way through the fold (${before} of 15000 asks committed)`);
  withIndex((db) => {
    const got = rows(db, "SELECT idx FROM prompts WHERE session_id = 'fixture-big' ORDER BY idx").map((x) => x.idx);
    assert.equal(got.length, 15000, 'every ask once');
    assert.deepEqual(got.slice(0, 3), [0, 1, 2]);
    assert.equal(got[got.length - 1], 14999);
  });
});

test('index: 16 writers at once never fail SQLITE_BUSY (BEGIN IMMEDIATE with a busy timeout), and 16 catch-ups agree', { skip }, async (t) => {
  const f = indexFixture(t, core);
  for (let i = 0; i < 8; i++) f.claude(`fixture-par-${i}`, f.work, [ask(`Parallel ask ${i}`), reply(`p${i}`, [text(`Parallel answer ${i}.`)])]);
  withIndex(() => {});
  const writer = (k) => new Promise((resolve) => {
    const c = cp.spawn(process.execPath, ['-e', `const core = require(${JSON.stringify(path.join(DIST, 'index.js'))});
const o = core.openIndex(); let busy = 0;
for (let i = 0; i < 40; i++) {
  // A read, then a write that depends on it (a counter every writer bumps), as the index's own transactions read first.
  try { core.indexWrite(o.db, () => { const n = Number(o.db.prepare("SELECT value FROM meta WHERE key = 'counter'").get()?.value ?? 0);
    for (let r = 0; r < 50; r++) o.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run('w${k}-' + i + '-' + r, 'x');
    o.db.prepare("INSERT INTO meta (key, value) VALUES ('counter', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(n + 1)); }); }
  catch (e) { busy++; }
}
const res = core.catchUp(o.db, {});
console.log(JSON.stringify({ busy, ran: res.ran, problems: res.problems }));`], { env: process.env });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('close', (code) => resolve({ code, out }));
  });
  const results = await Promise.all(Array.from({ length: 16 }, (_, k) => writer(k)));
  for (const r of results) {
    assert.equal(r.code, 0);
    const o = JSON.parse(r.out);
    assert.equal(o.busy, 0, 'no transaction failed BUSY');
    assert.deepEqual(o.problems, []);
  }
  withIndex((db) => {
    assert.equal(one(db, "SELECT count(*) AS n FROM meta WHERE key LIKE 'w%'").n, 16 * 40 * 50);
    assert.equal(Number(one(db, "SELECT value FROM meta WHERE key = 'counter'").value), 16 * 40, 'no update was lost');
    for (let i = 0; i < 8; i++) assert.equal(one(db, 'SELECT count(*) AS n FROM prompts WHERE session_id = ?', `fixture-par-${i}`).n, 1);
  });
});

test('index: the capture hook never opens SQLite; a catch-up changes PRAGMA data_version for a reader', { skip }, (t) => {
  const f = indexFixture(t, core);
  const capture = fs.readFileSync(path.resolve(DIST, '..', '..', 'cli', 'dist', 'capture.js'), 'utf8');
  assert.doesNotMatch(capture, /node:sqlite/, 'the hook bundle holds no SQLite');
  assert.match(fs.readFileSync(path.resolve(DIST, '..', '..', 'cli', 'dist', 'cli.js'), 'utf8'), /node:sqlite/, 'positive control: the CLI bundle does');
  f.claude('fixture-dv', f.work, [ask('One'), reply('d1', [text('x')])]);
  const reader = caughtUp();
  try {
    const before = one(reader.db, 'PRAGMA data_version').data_version;
    fs.appendFileSync(path.join(core.projectDir(f.work), 'fixture-dv.jsonl'), JSON.stringify({ cwd: f.work, sessionId: 'fixture-dv', ...ask('Two') }) + '\n');
    const r = cp.spawnSync(process.execPath, ['-e', `const core = require(${JSON.stringify(path.join(DIST, 'index.js'))}); const ix = core.useIndex({ budgetMs: Infinity }); ix.close();`], { env: process.env });
    assert.equal(r.status, 0);
    assert.notEqual(one(reader.db, 'PRAGMA data_version').data_version, before);
  } finally {
    reader.close();
  }
});

test('index: a reader that finds another catching up answers at once, not caught up; a first build too large waits for the background', { skip }, (t) => {
  const f = indexFixture(t, core);
  f.claude('fixture-lease', f.work, [ask('One'), reply('l1', [text('x')])]);
  const holder = core.openIndex();
  assert.ok(core.tryLease(holder.db, Date.now(), 'another-process'));
  holder.db.prepare('UPDATE lease SET pid = ? WHERE id = 1').run(process.ppid);
  const ix = core.useIndex({});
  assert.equal(ix.ok, true);
  assert.deepEqual([ix.catchUp.ran, ix.catchUp.caughtUp], [false, false]);
  ix.close();
  core.releaseLease(holder.db, 'another-process');
  holder.close();
  const small = core.useIndex({ inlineBytes: 10 });
  assert.equal(small.catchUp.caughtUp, false, 'more to read than a reader waits for');
  assert.ok(small.catchUp.deferredBytes > 10);
  small.close();
  const whole = core.useIndex({});
  assert.equal(whole.catchUp.caughtUp, true, 'positive control');
  whole.close();
});

// Opening the index took the write lock to check its schema, so every reader waited out another process's write
// transaction (a catch-up's) before it could even read.
test('index: opening the index never waits for another process\'s write transaction', { skip }, async (t) => {
  const f = indexFixture(t, core);
  f.claude('fixture-open', f.work, [ask('One'), reply('o1', [text('x')])]);
  withIndex(() => {});
  const locked = path.join(f.dir, 'locked');
  const writer = cp.spawn(process.execPath, ['-e', `const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(${JSON.stringify(core.indexFile())});
d.exec('BEGIN IMMEDIATE'); require('fs').writeFileSync(${JSON.stringify(locked)}, ''); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000); d.exec('COMMIT');`], { env: process.env });
  const ended = new Promise((resolve) => writer.on('close', resolve));
  while (!fs.existsSync(locked)) await new Promise((resolve) => setTimeout(resolve, 20));
  const t0 = Date.now();
  const o = core.openIndex();
  const ms = Date.now() - t0;
  try {
    assert.ok(o.ok, o.reason);
    assert.ok(ms < 1500, `opened in ${ms} ms while another process held the write lock`);
    assert.equal(one(o.db, "SELECT count(*) AS n FROM sessions WHERE session_id = 'fixture-open'").n, 1, 'and reads');
  } finally {
    o.close();
  }
  await ended;
});

// A listing's catch-up re-read a changing session's tool calls and workers every time: each read parses the whole
// transcript (a session with no OAK store keeps no parse cache), 1.3 s per listing of a growing 164 MB session.
test('index: a listing\'s catch-up re-reads a changing session\'s tool calls at most every workRefreshMs; a query\'s every time', { skip }, (t) => {
  const f = indexFixture(t, core);
  const id = 'fixture-live-work';
  const read = (k) => reply(`w${k}`, [{ type: 'tool_use', id: `read-${k}`, name: 'Read', input: { file_path: path.join(f.work, `f${k}.ts`) } }]);
  const file = f.claude(id, f.work, [ask('Read the files'), read(1)]);
  withIndex(() => {});
  const add = (...recs) => fs.appendFileSync(file, recs.map((x) => JSON.stringify({ cwd: f.work, sessionId: id, ...x })).join('\n') + '\n');
  const o = core.openIndex();
  try {
    const actions = () => one(o.db, 'SELECT count(*) AS n FROM actions WHERE session_id = ?', id).n;
    const refresh = core.LISTING_WORK_REFRESH_MS;
    assert.equal(actions(), 1);
    add(ask('And another'), read(2));
    core.catchUp(o.db, { workRefreshMs: refresh });
    assert.equal(actions(), 1, 'a listing read them a moment ago: not again yet');
    assert.equal(prompts(o.db, id).length, 2, 'its asks are current all the same');
    core.catchUp(o.db, { workRefreshMs: refresh, now: Date.now() + refresh + 1000 });
    assert.equal(actions(), 2, 'once the interval has passed');
    add(read(3));
    core.catchUp(o.db, {});
    assert.equal(actions(), 3, 'a query\'s catch-up reads them whenever they changed');
  } finally {
    o.close();
  }
});

// A damaged file made `oak doctor` and `oak query --status` throw ("database disk image is malformed").
test('index: a damaged index file is reported by the status and doctor\'s row, never thrown', { skip }, (t) => {
  const f = indexFixture(t, core);
  for (let i = 0; i < 20; i++) f.claude(`fixture-dmg-${i}`, f.work, [ask(`Ask ${i} `.repeat(100)), reply(`d${i}`, [text(`Answer ${i} `.repeat(200))])]);
  // A session whose transcript is gone, kept in the archive: what the advice must not lose.
  const gone = f.claude('fixture-dmg-gone', f.work, [ask('Teach the wombatcorn parser'), reply('dg', [text('Taught.')])]);
  withIndex(() => {});
  fs.rmSync(gone);
  withIndex(() => {});
  const kept = () => core.queryIndex('search', { text: 'wombatcorn', all: true }).rows.map((r) => [r.session, r.archived_reason]);
  assert.deepEqual(kept(), [['fixture-dmg-gone', 'missing']], 'control: archived');
  const file = core.indexFile();
  assert.equal(core.indexStatus().available, true, 'positive control');
  const b = fs.readFileSync(file);
  for (let i = 8192; i < Math.min(b.length, 8192 * 6); i++) b[i] = (i * 31) & 0xff;
  fs.writeFileSync(file, b);
  const st = core.indexStatus();
  assert.equal(st.available, false);
  assert.match(st.reason, /malformed|not a database/);
  const row = core.diagnoseIndex();
  assert.equal(row.level, 'warn');
  assert.match(row.fix, /^Move .* aside; the next listing builds a new database from the files on disk and from the record logs, which bring back the sessions kept after their files were removed\.$/);
  // A Node with no FTS5 is told to upgrade, not to move the file.
  process.env.OAK_INDEX_TEST_MODULE = path.join(f.dir, 'absent.cjs');
  core.resetIndexRuntime();
  assert.match(core.diagnoseIndex().fix, /^Install Node\.js 24 or newer \(this is v[\d.]+\)\.$/);
  delete process.env.OAK_INDEX_TEST_MODULE;
  core.resetIndexRuntime();
  // A file this Node can run but cannot open (not this user's to read) is neither: the detail says what failed.
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    fs.writeFileSync(file, Buffer.alloc(0));
    fs.chmodSync(file, 0);
    try {
      const unreadable = core.diagnoseIndex();
      assert.equal(unreadable.level, 'warn');
      assert.match(unreadable.detail, /could not be opened/);
      assert.equal(unreadable.fix, undefined, 'no advice that would not help');
    } finally {
      fs.chmodSync(file, 0o600);
    }
  }
  // As the advice says: the file moved aside, the next catch-up builds a new one, and the archive comes back from the
  // record log.
  for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(file + ext)) fs.renameSync(file + ext, `${file}.aside${ext}`);
  assert.deepEqual(kept(), [['fixture-dmg-gone', 'missing']], 'the archived session is back');
});

// --- named queries and raw SQL ----------------------------------------------------------------------------------------

test('query: every named query and declared filter against distinct synthetic rows', { skip }, (t) => {
  indexFixture(t, core);
  const { migrate } = require(path.join(DIST, 'index/schema.js'));
  const { runNamedQuery } = require(path.join(DIST, 'index/query.js'));
  const db = new (require('node:sqlite').DatabaseSync)(':memory:');
  t.after(() => db.close());
  migrate(db);
  const put = (table, row) => {
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(row));
  };
  const start = Date.parse('2026-10-01T00:00:00Z');
  const at = (n) => start + n * 1000;
  for (const [machine_id, is_self, saved_label] of [['local', 1, null], ['peer', 0, 'fixture-peer']]) put('machines', { machine_id, label: machine_id, is_self, saved_label });
  for (const [id, machine, agent, project, n, archived, review] of [
    ['a', 'local', 'claude', 'project-a', 10, null, 0], ['b', 'peer', 'codex', 'project-b', 20, null, 0],
    ['old', 'peer', 'claude', 'project-old', 5, at(6), 0], ['review', 'local', 'codex', 'project-r', 30, null, 1],
  ]) {
    put('sessions', { machine_id: machine, session_id: id, agent, origin: machine === 'local' ? 'local' : 'synced', listed: 1, review,
      title: `${id} zebracorn`, workspace: `workspace-${id}`, project_key: project, last_active_ms: at(n), archived_ms: archived, updated_ms: at(n) });
    if (review) continue;
    put('prompts', { machine_id: machine, session_id: id, idx: 0, prompt_id: `prompt-${id}`, ts: at(n), text: `${id} zebracorn`, response: 'answer', source: 'hooks' });
    put('edits', { machine_id: machine, session_id: id, id: 1, ts: at(n) + 1, tool: 'Edit', file: `/fixture/${id}.ts`, project_key: project, rel_path: `${id}.ts`,
      status: id === 'a' ? 'pending' : id === 'b' ? 'kept' : 'undone', record: '{}' });
    put('agents', { machine_id: machine, session_id: id, agent_id: `worker-${id}`, kind: 'subagent', first_ts: at(n), last_ts: at(n), record: '{}' });
    put('notes', { machine_id: machine, kind: id === 'a' ? 'plan' : id === 'b' ? 'memory' : 'skill', path: `/fixture/${id}.md`,
      title: `${id} quokkacorn`, text: 'note', size: 4, mtime_ms: at(n), sha: id, archived_ms: archived });
    if (archived) continue;
    put('usage_readings', { machine_id: machine, agent, kind: id === 'a' ? 'five' : 'week', measured_ms: at(n), pct: n, source: 'fixture' });
    put('usage_messages', { machine_id: machine, session_id: id, agent, message_id: `msg-${id}`, account: `account-${id}`, model: `model-${id}`, ts: at(n), input: n });
  }
  const covered = new Map();
  const query = (name, params = {}) => {
    const used = covered.get(name) ?? new Set();
    Object.keys(params).forEach((k) => used.add(k));
    covered.set(name, used);
    return runNamedQuery(db, name, params, { caughtUp: true });
  };
  const ids = (name, params, key, expected) => assert.deepEqual(query(name, params).rows.map((r) => r[key]), expected, `${name} ${JSON.stringify(params)}`);
  ids('sessions', {}, 'id', ['b', 'a']);
  for (const params of [{ machine: 'self' }, { workspace: 'workspace-a' }, { project: 'project-a' }, { agent: 'claude' }, { text: 'a zebracorn' }, { id: 'a' }]) ids('sessions', params, 'id', ['a']);
  ids('sessions', { since: new Date(at(15)).toISOString() }, 'id', ['b']);
  ids('sessions', { archived: true }, 'id', ['b', 'a', 'old']);
  ids('sessions', { all: true }, 'id', ['review', 'b', 'a', 'old']);
  for (const name of ['edits', 'files']) {
    const key = name === 'edits' ? 'session' : 'rel_path';
    const a = name === 'edits' ? 'a' : 'a.ts';
    const b = name === 'edits' ? 'b' : 'b.ts';
    const old = name === 'edits' ? 'old' : 'old.ts';
    ids(name, {}, key, [b, a]);
    for (const p of [{ machine: 'local' }, { project: 'project-a' }, { status: 'pending' }]) ids(name, p, key, [a]);
    ids(name, { since: at(15) }, key, [b]);
    for (const p of [{ archived: true }, { all: true }]) ids(name, p, key, [b, a, old]);
  }
  for (const p of [{ session: 'a' }, { file: '/fixture/a.ts' }, { path: 'a.ts', project: 'project-a' }]) ids('edits', p, 'session', ['a']);
  for (const name of ['prompts', 'workers']) {
    ids(name, {}, 'session', ['b', 'a']);
    for (const p of [{ session: 'a' }, { machine: 'self' }]) ids(name, p, 'session', ['a']);
    ids(name, { since: String(at(15)) }, 'session', ['b']);
    for (const p of [{ archived: true }, { all: true }]) ids(name, p, 'session', ['b', 'a', 'old']);
  }
  const search = (params, expected) => ids('search', { text: 'zebracorn', ...params }, 'session', expected);
  search({}, ['b', 'a']);
  search({ machine: 'fixture-peer' }, ['b']);
  search({ since: at(15) }, ['b']);
  search({ archived: true }, ['b', 'a', 'old']);
  search({ all: true }, ['b', 'a', 'old']);
  ids('notes', {}, 'title', ['b quokkacorn', 'a quokkacorn']);
  for (const p of [{ kind: 'plan' }, { text: 'a quokka' }, { machine: 'self' }]) ids('notes', p, 'title', ['a quokkacorn']);
  for (const p of [{ archived: true }, { all: true }]) ids('notes', p, 'title', ['b quokkacorn', 'a quokkacorn', 'old quokkacorn']);
  ids('sync', {}, 'machine', ['local', 'peer']);
  ids('readings', {}, 'machine', ['peer', 'local']);
  for (const p of [{ machine: 'self' }, { agent: 'claude' }, { kind: 'five' }]) ids('readings', p, 'machine', ['local']);
  ids('readings', { since: at(15) }, 'machine', ['peer']);
  const usage = { since: at(1), until: at(25), account: 'all' };
  assert.equal(query('usage', usage).rows.reduce((n, r) => n + r.tokens, 0), 30);
  for (const by of core.USAGE_GROUPS) assert.equal(query('usage', { ...usage, by }).rows.reduce((n, r) => n + r.tokens, 0), 30, by);
  for (const p of [{ machine: 'self' }, { agent: 'claude' }]) assert.equal(query('usage', { ...usage, ...p }).rows.reduce((n, r) => n + r.tokens, 0), 10);
  for (const window of core.USAGE_WINDOWS) assert.ok(Array.isArray(query('usage', { window }).rows), window);
  // Agents started from a brief (\`oak agent start --brief\`): newest first, by state, kind and id, a closed one only with all,
  // and each followed by its session's workers unless workers is off.
  for (const [id, kind, state, n, closed] of [['d-old', 'codex', 'done', 30, at(40)], ['d-a', 'claude', 'working', 31, null], ['d-b', 'codex', 'done', 32, null]]) {
    put('delegated', { machine_id: 'local', id, title: `brief ${id}`, brief: `/b/${id}.md`, cwd: `/w/${id}`, out: `/w/${id}-out`, report: `/w/${id}-out/report.md`,
      kind, session_id: id === 'd-a' ? 'a' : null, started_ms: at(n), closed_ms: closed, state, since_ms: at(n), stamp: '' });
  }
  ids('delegated', { workers: false }, 'id', ['d-b', 'd-a']);
  ids('delegated', { workers: false, all: true }, 'id', ['d-b', 'd-a', 'd-old']);
  ids('delegated', { workers: false, state: 'working' }, 'id', ['d-a']);
  ids('delegated', { workers: false, kind: 'codex' }, 'id', ['d-b']);
  ids('delegated', { workers: false, id: 'd-a' }, 'id', ['d-a']);
  const withWorkers = query('delegated', { id: 'd-a' }).rows;
  assert.deepEqual(withWorkers.map((r) => [r.id, r.kind, r.parent ?? null]), [['d-a', 'claude', null], ['worker-a', 'worker', 'd-a']], 'its session\'s worker follows it');
  for (const [id, machine, repo, paths, n] of [['f-a', 'local', 'repo-a', '["a.ts"]', 10], ['f-b', 'peer', 'repo-b', '[]', 20], ['f-old', 'local', 'repo-a', '["old.ts"]', 5]]) {
    put('findings', { machine_id: machine, id, session_id: id, created_ms: at(n), repo, paths, text: id });
  }
  put('finding_resolutions', { machine_id: 'local', finding_machine: 'local', finding_id: 'f-old', session_id: 'a', resolved_ms: at(30) });
  ids('findings', {}, 'id', ['f-b', 'f-a']);
  for (const p of [{ machine: 'self' }, { session: 'f-a' }, { repo: 'repo-a' }, { repo: 'repo-a', path: 'a.ts' }]) ids('findings', p, 'id', ['f-a']);
  ids('findings', { all: true }, 'id', ['f-b', 'f-a', 'f-old']);
  for (const name of Object.keys(core.NAMED_QUERIES)) {
    const params = name === 'search' ? { text: 'zebracorn' } : name === 'usage' ? usage : {};
    const limited = query(name, { ...params, limit: 1 });
    assert.equal(limited.rowCount, 1, name);
    assert.equal(limited.truncated, true, name);
    assert.deepEqual([...covered.get(name)].sort(), Object.keys(core.NAMED_QUERIES[name].params).sort(), `${name}: every declared filter exercised`);
  }
  assert.ok(query('schema').rows.some((r) => r.kind === 'query' && r.name === 'sql'));
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('query: inherited names and undeclared parameters are rejected by the JSON contract', { skip }, (t) => {
  indexFixture(t, core);
  for (const name of ['toString', 'constructor', '__proto__']) {
    assert.equal(core.queryIndex(name, {}).error?.code, 'bad_query', name);
  }
  for (const [name, params] of [['schema', { limit: 1 }], ['sessions', { constructor: 'x' }], ['sessions', JSON.parse('{"__proto__":"x"}')]]) {
    assert.equal(core.queryIndex(name, params).error?.code, 'bad_param', `${name} ${JSON.stringify(params)}`);
  }
});

test('query: the JSON contract, parameters checked, words searched safely', { skip }, (t) => {
  const f = indexFixture(t, core);
  f.claude('fixture-q', f.work, [ask('Fix "quoted" -dash words: zebracorn'), reply('q1', [text('fixed')])]);
  f.store('fixture-q', f.work, [['a.ts', 'a\n', 'b\nc\n', 1000]]);
  const a = core.queryIndex('sessions', {});
  assert.deepEqual(Object.keys(a), ['v', 'query', 'params', 'columns', 'rows', 'rowCount', 'truncated', 'freshness', 'elapsedMs', 'problems']);
  assert.equal(a.v, 1);
  assert.deepEqual(Object.keys(a.freshness), ['indexedAt', 'caughtUp', 'sources']);
  assert.equal(a.freshness.sources[0].origin, 'local');
  assert.deepEqual(core.queryIndex('sessions', { arrays: true }).error?.code, 'bad_param');
  const arrays = core.queryIndex('sessions', {}, { arrays: true });
  assert.ok(Array.isArray(arrays.rows[0]) && arrays.rows[0][arrays.columns.indexOf('id')] === 'fixture-q');
  assert.equal(core.queryIndex('sessions', { limit: 0 }).error.code, 'bad_param');
  assert.equal(core.queryIndex('sessions', { since: 'yesterday-ish' }).error.code, 'bad_param');
  assert.equal(core.queryIndex('search', { text: '"quoted" -dash' }).rowCount, 1, 'quotes and dashes are words, not syntax');
  assert.equal(core.queryIndex('search', { text: 'zebra' }).rowCount, 1, 'the last word is a prefix');
  const e = core.queryIndex('edits', {}).rows[0];
  assert.deepEqual([e.added, e.removed], [2, 1], 'line counts computed where the blobs are');
  assert.equal(core.queryIndex('files', {}).rows[0].pending, 1);
  assert.equal(core.queryIndex('prompts', { session: 'fixture-q' }).rows[0].edits, 0);
  assert.ok(core.queryIndex('schema', {}).rows.some((r) => r.kind === 'query' && r.name === 'sql'));
  assert.equal(core.queryIndex('sessions', { limit: 1 }).truncated, false);
});

test('sql: the keyword check refuses anything but one read', () => {
  for (const sql of ["ATTACH DATABASE '/tmp/x' AS x", "VACUUM INTO '/tmp/x'", 'PRAGMA query_only = 0', 'DELETE FROM sessions', 'WITH x AS (SELECT 1) DELETE FROM sessions',
    "WITH x AS (SELECT 1) REPLACE INTO meta VALUES ('a', 'b')", "SELECT load_extension('x')", 'BEGIN', 'CREATE TABLE x(y)', 'SELECT 1; SELECT 2; DROP TABLE x']) {
    assert.throws(() => core.checkSqlKeywords(sql), (e) => e.code === 'unsafe_sql', sql);
  }
  for (const sql of ["SELECT replace(title, 'a', 'b') FROM sessions", "SELECT 'DELETE FROM x' AS words", 'SELECT "update" FROM x', '-- DROP\nSELECT 1', 'WITH RECURSIVE c(x) AS (SELECT 1) SELECT x FROM c', 'VALUES (1)', 'EXPLAIN SELECT 1']) {
    assert.doesNotThrow(() => core.checkSqlKeywords(sql), sql);
  }
  assert.throws(() => core.checkOneStatement('SELECT 1; SELECT 2', 'SELECT 1;'), /one statement/);
  assert.doesNotThrow(() => core.checkOneStatement('SELECT 1; -- done\n ;', 'SELECT 1;'));
});

test('sql: each guard holds on its own: query_only, one statement, no zero-column statement, the authorizer', { skip }, (t) => {
  const f = indexFixture(t, core);
  f.claude('fixture-sql', f.work, [ask('One'), reply('s1', [text('x')])]);
  withIndex(() => {});
  const file = core.indexFile();
  const stolen = path.join(f.dir, 'stolen.db');
  const run = (sql, guards) => core.runGuardedSql({ file, sql, limit: 10 }, guards);
  // Positive control.
  assert.deepEqual(run("SELECT session_id FROM sessions").rows, [{ session_id: 'fixture-sql' }]);
  // query_only alone makes VACUUM INTO fail before it copies anything (SQLite still creates the empty target file,
  // which is why the zero-column refusal keeps the statement from ever running).
  let r = run(`VACUUM INTO '${stolen}'`, { keywords: false, authorizer: false, zeroColumns: false });
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(stolen) ? fs.statSync(stolen).size : 0, 0, 'nothing copied');
  fs.rmSync(stolen, { force: true });
  r = run(`VACUUM INTO '${stolen}'`, { keywords: false, authorizer: false });
  assert.deepEqual([r.ok, r.code], [false, 'unsafe_sql']);
  assert.equal(fs.existsSync(stolen), false, 'refused before it ran: no file at all');
  // The zero-column refusal alone stops ATTACH.
  r = run(`ATTACH DATABASE '${stolen}' AS x`, { keywords: false, authorizer: false });
  assert.deepEqual([r.ok, r.code], [false, 'unsafe_sql']);
  // One statement only, with the keyword check off.
  r = run('SELECT 1 AS a; SELECT 2 AS b', { keywords: false });
  assert.deepEqual([r.ok, r.code], [false, 'unsafe_sql']);
  // The keyword check alone stops a write that every other guard would let reach SQLite (which a read-only connection
  // then refuses with an error of its own, not as unsafe).
  r = run('DELETE FROM sessions', { authorizer: false, zeroColumns: false, queryOnly: false, oneStatement: false });
  assert.deepEqual([r.ok, r.code], [false, 'unsafe_sql']);
  if (core.indexRuntime().authorizer) {
    // The authorizer alone stops ATTACH. SQLite never consults it for VACUUM (checked on 3.53), so VACUUM INTO is the
    // zero-column refusal's and query_only's to stop, as above.
    r = run(`ATTACH DATABASE '${stolen}' AS x`, { keywords: false, zeroColumns: false });
    assert.deepEqual([r.ok, r.code], [false, 'unsafe_sql']);
  }
  assert.equal(fs.existsSync(stolen), false, 'nothing was written');
});

// Uncut, 100,000 rows of 8 KB took the child to 1.5 GB and ended in a string too long to build ("nothing usable"); three
// 900 MB zeroblobs in one row took it to 7 GB.
test('sql: rows past the byte cap are cut and say so; a value past SQLite\'s length limit is refused where this Node can set it', { skip }, (t) => {
  const f = indexFixture(t, core);
  f.claude('fixture-cap', f.work, [ask('One'), reply('c1', [text('x')])]);
  withIndex(() => {});
  const file = core.indexFile();
  const sql = 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 1000) SELECT x, hex(zeroblob(500)) AS pad FROM c';
  assert.equal(core.runGuardedSql({ file, sql, limit: 100000 }).rows.length, 1000, 'positive control: under the cap, every row');
  const cut = core.runGuardedSql({ file, sql, limit: 100000, maxBytes: 64 * 1024 });
  assert.equal(cut.ok, true);
  assert.equal(cut.truncated, true);
  assert.equal(cut.cutAtBytes, 64 * 1024);
  assert.ok(cut.rows.length > 0 && cut.rows.length < 1000, `${cut.rows.length} rows`);
  assert.ok(cut.rows.reduce((n, r) => n + JSON.stringify(r).length, 0) <= 64 * 1024, 'the rows kept come to no more than the cap');
  const { DatabaseSync } = require('node:sqlite');
  let enforced = false;
  try {
    new DatabaseSync(':memory:', { limits: { length: 100 } }).prepare('SELECT zeroblob(1000) AS z').get();
  } catch {
    enforced = true;
  }
  const big = core.runGuardedSql({ file, sql: 'SELECT length(zeroblob(100000000)) AS n', limit: 10 });
  if (enforced) assert.deepEqual([big.ok, big.code], [false, 'sql_error'], 'a 100 MB value is refused');
  else assert.equal(big.ok, true, `this Node (${process.version}) cannot set the limit`);
});

/** What a child test run says of the tests that failed: each `not ok` line of its TAP with the diagnostics under it, else
 *  the end of its output. The end alone (its last 4000 characters) named none of them when a Windows run failed one. */
function failedTap(stdout) {
  const lines = stdout.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*not ok \d/.test(lines[i])) continue;
    out.push(lines[i]);
    for (let j = i + 1; j < lines.length && !/^\s*(not ok|ok) \d|^\s*# Subtest/.test(lines[j]); j++) out.push(lines[j]);
  }
  return out.length ? out.join('\n').slice(0, 12000) : stdout.slice(-4000);
}

/** A test run of its own, not a part of this one: without the test runner's context, it reports on stdout. */
function childTestEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

test('parity: every session-listing test holds with the listing and the search served from the index', { skip }, () => {
  const shim = path.join(__dirname, 'fixtures', 'index-listing-shim.cjs');
  const r = cp.spawnSync(process.execPath, ['--require', path.resolve(__dirname, '../../../test/bootstrap.cjs'), '--test', '--test-reporter=tap', path.join(__dirname, 'session-listing.test.js')], {
    env: childTestEnv({ OAK_LISTING_TEST_DIST: shim }), encoding: 'utf8', timeout: 300_000,
  });
  assert.equal(r.status, 0, failedTap(r.stdout) + r.stderr.slice(-2000));
  assert.match(r.stdout, /# pass [1-9]\d*/);
  assert.match(r.stdout, /# fail 0/);
});

test('parity: the core tests that list, search or rank sessions hold with the index serving them', { skip }, () => {
  const preload = path.join(__dirname, 'fixtures', 'index-shim-preload.cjs');
  const pattern = '^(sessions:|graphemes: a title|observe: a compaction|titles:|clean: --completed|sessionMeta costs|attention:|needs you:|auto-title link|search:|search and capture|session listing:)';
  const r = cp.spawnSync(process.execPath, ['--require', path.resolve(__dirname, '../../../test/bootstrap.cjs'), '--require', preload, '--test', '--test-reporter=tap', '--test-name-pattern', pattern, path.join(__dirname, 'core.test.js')], {
    env: childTestEnv(), encoding: 'utf8', timeout: 300_000,
  });
  assert.equal(r.status, 0, failedTap(r.stdout) + r.stderr.slice(-2000));
  const pass = Number(/# pass (\d+)/.exec(r.stdout)?.[1] ?? 0);
  assert.ok(pass >= 15, `${pass} tests ran through the index`);
});

// One lister owns catch-up while the other converts a rollout. The writer finishes the raw file inside that
// converter's lock window; the index must not certify the missing output or an Auto-review title read from it.
test('index: overlapping listings retry an unfinished Codex conversion and its dependent title', { skip }, async (t) => {
  const { worker, race } = require('./fixtures/listing-write-race.cjs');
  const f = indexFixture(t, core);
  const workers = [worker(), worker(), worker()];
  t.after(() => { for (const w of workers) w.child.kill(); });
  for (const mode of ['missing', 'review']) {
    const dir = path.join(f.dir, mode);
    fs.mkdirSync(dir);
    const r = await race(dir, mode, workers);
    assert.equal(r.during.caught.caughtUp, false, 'a locked converter is not a settled source');
    assert.deepEqual(r.during.stored, [], 'no incomplete facts are committed');
    assert.equal(r.after.caught.caughtUp, true, JSON.stringify(r.after.caught));
    assert.equal(r.after.rows.find(r => r.id === '0199a000-0000-7000-8000-00000000c0de')?.title, 'Fix the synthetic exporter');
    if (mode === 'review') assert.equal(r.after.rows.find(r => r.id === '0199a000-0000-7000-8000-00000000a0a0')?.title, 'Auto-review: Fix the synthetic exporter');
  }
});

test('index: overlapping listings of a just-written Claude transcript recover its complete title', { skip }, async (t) => {
  const { worker, race } = require('./fixtures/listing-write-race.cjs');
  const f = indexFixture(t, core);
  const workers = [worker(), worker(), worker()];
  t.after(() => { for (const w of workers) w.child.kill(); });
  const r = await race(f.dir, 'claude', workers);
  assert.equal(r.after.caught.caughtUp, true, JSON.stringify(r.after.caught));
  assert.equal(r.after.rows.find(r => r.id === '0199a000-0000-7000-8000-00000000c0de')?.title, 'Fix the synthetic exporter');
});

test('index: a transcript appended during its listing stays due until the next catch-up', { skip }, (t) => {
  const f = indexFixture(t, core);
  const id = 'fixture-changing-claude';
  const file = f.claude(id, f.work, [ask('The initial synthetic task')]);
  const open = fs.openSync, read = fs.readSync;
  let fd, changed = false;
  fs.openSync = function(p, ...args) {
    const out = open.call(this, p, ...args);
    if (p === file) fd = out;
    return out;
  };
  fs.readSync = function(current, ...args) {
    const n = read.call(this, current, ...args);
    if (current === fd && !changed) {
      changed = true;
      fs.appendFileSync(file, f.lines([{ type: 'custom-title', customTitle: 'The completed synthetic task' }]));
    }
    return n;
  };
  try {
    const ix = core.useIndex({ budgetMs: Infinity, inlineBytes: Infinity });
    assert.ok(ix.ok);
    try {
      assert.ok(changed);
      assert.equal(ix.catchUp.caughtUp, false);
      assert.equal(one(ix.db, 'SELECT COUNT(*) AS n FROM sessions').n, 0);
    } finally { ix.close(); }
  } finally { fs.openSync = open; fs.readSync = read; }
  withIndex(db => assert.equal(core.indexedSessionMeta(db, f.work).sessions.find(r => r.id === id)?.title, 'The completed synthetic task'));
});

test('index: stale Codex output is not memoized under the completed rollout stamp', { skip }, (t) => {
  const f = indexFixture(t, core);
  const id = '0199a000-0000-7000-8000-00000000c0de';
  const file = f.rollout(id, f.work, [cxUser('# AGENTS.md instructions\nSynthetic context')]);
  const output = core.codexTranscriptFile(file);
  const lock = path.join(path.dirname(output), '.lock');
  fs.appendFileSync(file, f.lines([cxUser('Fix the synthetic exporter')]));
  fs.writeFileSync(lock, String(process.pid));
  try {
    // These best-effort readers can run before catch-up in an editor process, including inside cachedByFiles.
    assert.equal(core.codexSessionTitle(file, id), null);
    assert.deepEqual(core.readCodexRollout(file).prompts, []);
    const ix = core.useIndex({ budgetMs: Infinity, inlineBytes: Infinity });
    assert.ok(ix.ok);
    try { assert.equal(ix.catchUp.caughtUp, false); }
    finally { ix.close(); }
  } finally { fs.unlinkSync(lock); }
  withIndex(db => assert.equal(core.indexedSessionMeta(db, f.work).sessions.find(r => r.id === id)?.title, 'Fix the synthetic exporter'));
  assert.deepEqual(core.readCodexRollout(file).prompts, ['Fix the synthetic exporter']);
});

test('index: WAL open stops at the busy timeout and releases its failed handle', { skip }, (t) => {
  const f = indexFixture(t, core);
  const file = path.join(f.dir, 'busy.sqlite');
  const { DatabaseSync } = require('node:sqlite');
  const holder = new DatabaseSync(file);
  try {
    holder.exec('CREATE TABLE probe(x); BEGIN IMMEDIATE; INSERT INTO probe VALUES (1)');
    const start = performance.now();
    const blocked = core.openIndex(file);
    const elapsed = performance.now() - start;
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason, /database is locked/);
    assert.ok(elapsed >= 4900 && elapsed < 6500, `bounded wait: ${elapsed} ms`);
    holder.exec('COMMIT');
    const opened = core.openIndex(file);
    assert.equal(opened.ok, true, opened.reason);
    assert.equal(opened.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
    opened.close();
  } finally {
    holder.close(); // before the fixture's after hook removes the folder: Windows deletes no file a handle holds open
  }
});

function accountUsageFixture(t) {
  const f = indexFixture(t, core);
  const now = Date.parse('2026-11-04T12:00:00Z'), weekReset = now + 4 * 86400_000;
  core.writePrefs({ gptBillDay: 14, billDay: 14 });
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({ tokens: { account_id: 'synthetic-account' } }));
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'codex-account-usage.json'), JSON.stringify({ version: 1, source: 'app-server', account: core.codexAccountId(),
    snapshotMs: now, fivePct: null, fiveReset: null, weekPct: 20, weekReset }));
  const turn = (id, at, input, cached = 0) => f.rollout(id, f.work, [
    { type: 'turn_context', payload: { model: 'gpt-5.2' } },
    { type: 'event_msg', timestamp: new Date(at).toISOString(), payload: { type: 'token_count',
      info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: 0 } },
      rate_limits: { secondary: { used_percent: 20, window_minutes: 10080, resets_at: weekReset / 1000 } } } },
  ], { model_provider: 'openai' });
  const deleted = turn('account-deleted', now - 86400_000, 1_000_000, 200_000);
  turn('account-old', Date.parse('2026-10-20T12:00:00Z'), 6_000_000);
  withIndex((db) => {
    const remote = { usageRecords: 1, host: 'bbbbbbbbbbbb', hosts: ['bbbbbbbbbbbb'], at: now, cursor: 'fixture:1:0', more: false,
      messages: [{ message_id: 'codex:account-remote', agent: 'codex', session_id: 'account-remote', model: 'gpt-5.2', provider: 'openai',
        ts: now - 3600000, input: 3_200_000, output: 0, cache_create: 0, cache_read: 0 }], readings: [], accounts: [], spend: [], purged: [] };
    core.applyUsageRecords(db, remote, { label: 'build-box', skewMs: 0, now });
    core.applyUsageRecords(db, remote, { label: 'build-box', skewMs: 0, now });
  });
  fs.rmSync(deleted);
  core.clearFsCache();
  return { ...f, now, weekReset };
}

test('account usage: GPT month retains deleted rollouts and counts both machines once', { skip }, (t) => {
  const f = accountUsageFixture(t);
  const g = core.gptUsagePanel(undefined, f.now);
  assert.equal(g.monthTok, 10_000_000);
  assert.equal(g.monthReads, 200_000);
  assert.equal(g.monthCost, 17.535);
  assert.match(g.measuredMachines, /build-box/);
  assert.equal(g.usageSource, 'database');
});

test('account usage: GPT calibrates its budget from the union', { skip }, (t) => {
  const f = accountUsageFixture(t);
  const g = core.gptUsagePanel(undefined, f.now);
  assert.equal(g.weekTok, 4_000_000);
  assert.equal(g.weekTotal, 20_000_000);
  assert.equal(g.monthTokTotal, Math.round(20_000_000 * 31 / 7));
});

test('account usage: database off explicitly labels the local fallback', { skip }, (t) => {
  const f = accountUsageFixture(t);
  process.env.OAK_INDEX = 'off';
  const g = core.gptUsagePanel(undefined, f.now);
  assert.equal(g.monthTok, 6_000_000);
  assert.equal(g.usageSource, 'local');
  assert.equal(g.measuredMachines, 'this machine alone');
});

test('account usage: bill days follow usage records to a synthetic machine with no preference', { skip }, (t) => {
  const f = accountUsageFixture(t);
  const before = core.gptUsagePanel(undefined, f.now);
  let windows;
  withIndex((db) => { windows = ['bill', 'week'].map((name) => core.namedWindow(db, name, 'codex', f.now)); });
  const a = core.indexUsageRecords(null);
  let remote;
  withIndex((db) => { remote = db.prepare("SELECT * FROM usage_messages WHERE machine_id = 'bbbbbbbbbbbb'").all(); });
  process.env.CLAUDE_CONFIG_DIR = path.join(f.dir, 'machine-b', '.claude');
  process.env.CODEX_HOME = path.join(f.dir, 'machine-b', '.codex');
  process.env.HOME = process.env.USERPROFILE = path.join(f.dir, 'machine-b'); // os.homedir() reads USERPROFILE on Windows
  core.clearRootMemo(); core.clearFsCache();
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({ tokens: { account_id: 'synthetic-account' } }));
  assert.ok(core.indexApplyUsageRecords({ ...a, host: 'bbbbbbbbbbbb', hosts: ['bbbbbbbbbbbb'], messages: remote, readings: [], spend: [], accounts: [], billDays: [] }, { label: 'build-box', skewMs: 0, now: f.now }));
  assert.ok(core.indexApplyUsageRecords(a, { label: 'work-box', skewMs: 0, now: f.now }));
  assert.equal(core.gptBillDay(), 14);
  assert.equal(core.billDay(), 14);
  withIndex((db) => assert.deepEqual(['bill', 'week'].map((name) => core.namedWindow(db, name, 'codex', f.now)), windows));
  const after = core.gptUsagePanel(undefined, f.now);
  const figures = (g) => [g.monthStart, g.monthReset, g.monthTok, g.monthReads, g.monthCost, g.weekPct, g.weekTok, g.weekTotal, g.monthTokTotal, core.monthUsd(g)];
  assert.deepEqual(figures(after), figures(before), 'same rows and account setting print identical figures');
  fs.rmSync(path.join(process.env.CODEX_HOME, 'auth.json'));
  core.clearFsCache();
  assert.deepEqual(figures(core.gptUsagePanel(undefined, f.now)), figures(before), 'a machine without a login follows the one unambiguous account');
  fs.rmSync(path.join(core.rootDir(), 'gpt-week-budget.json'), { force: true });
  assert.equal(core.gptUsagePanel(undefined, f.weekReset + 1).weekTotal, before.weekTotal, 'the shared historical sample supplies the budget after reset, without a local remembered budget');
});

test('account usage: Claude estimates and Stats history count the database union', { skip }, (t) => {
  const f = accountUsageFixture(t);
  const now = Date.now(), reset = now + 3 * 86400_000;
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'statusline-last.json'), JSON.stringify({ week_pct: 20, week_reset: reset / 1000,
    week_at: now / 1000, week_tok: 100, week_total: 500, month_tok: 100, month_tok_total: 2000, month_cost: 0.001 }));
  withIndex((db) => {
    const insert = db.prepare(`INSERT INTO usage_messages(message_id, agent, machine_id, session_id, model, ts, input, output, cache_read, cost)
      VALUES (?, 'claude', ?, 'synthetic', 'claude-opus-4-8', ?, ?, 0, 100, ?)`);
    insert.run('claude-own', core.machineHostTag(), now - 1000, 100_000, 0.5);
    insert.run('claude-remote', 'bbbbbbbbbbbb', now - 1000, 900_000, 4.5);
  });
  // One union per read (review 2026-11-05): a first call whose answer was thrown away doubled its cost.
  const api = require('../dist/index/api'), union = api.indexedUsageTotals;
  let unions = 0;
  api.indexedUsageTotals = (...args) => { unions++; return union(...args); };
  let u;
  try { u = core.usageLine(f.work, ''); } finally { api.indexedUsageTotals = union; }
  assert.equal(unions, 1);
  assert.equal(u.weekTokens, 1_000_000);
  assert.equal(u.weekTotal, 5_000_000);
  assert.equal(u.monthTokens, 1_000_000);
  assert.equal(u.monthCost, 5);
  const stats = core.computeStats(undefined, now, true);
  assert.equal(stats.windows.day.tokens, 1_000_200);
  assert.equal(stats.usageSource, 'database');
});

test('account usage: explicit shared bill days override legacy values, including calendar-month clears', { skip }, (t) => {
  const f = accountUsageFixture(t);
  const original = core.indexUsageRecords(null);
  const remote = { ...original, host: 'cccccccccccc', hosts: ['cccccccccccc'], messages: [], readings: [], accounts: [], spend: [],
    billDays: [{ agent: 'codex', account: core.codexAccountId(), day: 22, updated_ms: f.now }, { agent: 'claude', account: '', day: 0, updated_ms: f.now }] };
  assert.ok(core.indexApplyUsageRecords(remote, { label: 'other-box', skewMs: 0, now: f.now }));
  assert.equal(core.gptBillDay(), 22);
  assert.equal(core.billDay(), null);
  core.setAccountBillDay('codex', 8);
  assert.equal(core.gptBillDay(), 8);
  core.setAccountBillDay('codex', 0);
  assert.equal(core.gptBillDay(), null);
  withIndex((db) => {
    for (const agent of ['claude', 'codex']) assert.equal(core.namedWindow(db, 'bill', agent, f.now).start, Date.parse('2026-11-01T00:00:00Z'));
  });
});

test('account usage: a Node without sqlite labels the local fallback', { skip }, (t) => {
  const f = accountUsageFixture(t);
  const Module = require('node:module'), original = Module._load;
  t.mock.method(Module, '_load', function(id, ...args) { if (id === 'node:sqlite') throw new Error('synthetic missing sqlite'); return original.call(this, id, ...args); });
  core.resetIndexRuntime();
  const g = core.gptUsagePanel(undefined, f.now);
  assert.equal(g.monthTok, 6_000_000);
  assert.equal(g.usageSource, 'local');
  assert.equal(g.measuredMachines, 'this machine alone');
});

test('account usage: bill days also arrive through the existing sync record log', { skip }, (t) => {
  const f = accountUsageFixture(t), records = core.recordsRoot();
  core.setAccountBillDay('codex', 19);
  core.indexUsageRecords(null);
  process.env.HOME = path.join(f.dir, 'sync-machine');
  process.env.CLAUDE_CONFIG_DIR = path.join(process.env.HOME, '.claude');
  process.env.CODEX_HOME = path.join(process.env.HOME, '.codex');
  core.clearRootMemo(); core.clearFsCache();
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({ tokens: { account_id: 'synthetic-account' } }));
  fs.cpSync(records, core.recordsRoot(), { recursive: true });
  withIndex(() => {});
  assert.equal(core.gptBillDay(), 19);
  assert.equal(core.billDay(), 14);
});

test('account usage: CLI JSON, usageBrief and breakdown use the retained database totals', { skip }, (t) => {
  const f = accountUsageFixture(t);
  const clock = path.join(f.dir, 'clock.cjs');
  fs.writeFileSync(clock, `Date.now = () => ${f.now};`);
  const json = JSON.parse(cp.execFileSync(process.execPath, ['--require', clock, path.resolve(__dirname, '../../cli/dist/cli.js'), 'usage', '--json'],
    { cwd: f.work, env: { ...process.env, OAK_NO_BACKGROUND: '1' }, encoding: 'utf8' }));
  assert.equal(json.gptMonthTok, 10_000_000);
  assert.equal(json.gptWeekTotal, 20_000_000);
  assert.equal(json.gptMonthCost, 17.535);
  assert.match(json.gptMeasuredMachines, /build-box/);
  t.mock.method(Date, 'now', () => f.now);
  const brief = core.usageBrief(f.work).gpt;
  assert.equal(brief.month.tok, json.gptMonthTok);
  assert.equal(brief.month.usd, json.gptMonthUsd);
  assert.match(brief.measuredMachines, /build-box/);
  const breakdown = core.codexBreakdown('month', Date.parse('2026-10-14T00:00:00Z'), f.weekReset, undefined, core.gptBillDay());
  assert.equal(breakdown.totals.tokens, 10_000_000);
  assert.equal(breakdown.buckets.length, 1);
  assert.equal(breakdown.usageSource, 'database');
});

test('account usage: two synthetic Claude machines print identical estimates and shared windows', { skip }, (t) => {
  const f = accountUsageFixture(t);
  t.mock.method(Date, 'now', () => f.now);
  const cache = (pct, when) => JSON.stringify({ week_pct: pct, week_at: when / 1000, week_reset: f.weekReset / 1000,
    week_tok: 100, week_total: 1000, month_tok: 100, month_cost: 1 });
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'statusline-last.json'), cache(20, f.now));
  withIndex((db) => {
    db.prepare(`INSERT INTO usage_messages(message_id,agent,machine_id,session_id,model,ts,input,output,cache_read,cost,priced)
      VALUES ('claude-equality','claude',?,'fixture','claude-opus-4-8',?,1000000,0,200000,5.1,?)`).run(core.machineHostTag(), f.now - 1000, core.PRICE_VERSION);
  });
  const a = core.indexUsageRecords(null);
  const printed = () => {
    const u = core.usageLine(f.work, '');
    return [u.weekPct, u.weekReset, u.weekTokens, u.weekReads, u.weekCost, u.weekTotal, u.monthTokens, u.monthTokensTotal, u.monthReads, u.monthCost, u.monthReset, core.monthUsd(u)];
  };
  const before = printed();
  process.env.HOME = process.env.USERPROFILE = path.join(f.dir, 'claude-machine-b'); // os.homedir() reads USERPROFILE on Windows
  process.env.CLAUDE_CONFIG_DIR = path.join(process.env.HOME, '.claude');
  process.env.CODEX_HOME = path.join(process.env.HOME, '.codex');
  core.clearRootMemo(); core.clearFsCache();
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'statusline-last.json'), cache(5, f.now - 60_000));
  assert.ok(core.indexApplyUsageRecords(a, { label: 'work-box', skewMs: 0, now: f.now }));
  assert.deepEqual(printed(), before, 'a smaller, older local sample cannot shrink the account estimate');
});

test('account JSON: unprefixed fields explicitly name the active provider', { skip }, (t) => {
  const f = accountUsageFixture(t);
  const cli = path.resolve(__dirname, '../../cli/dist/cli.js');
  const read = (session) => JSON.parse(cp.execFileSync(process.execPath, [cli, 'usage', '--session', session, '--json'],
    { cwd: f.work, env: { ...process.env, OAK_NO_BACKGROUND: '1' }, encoding: 'utf8' }));
  const claude = read('synthetic-claude');
  assert.equal(claude.usageFrom, 'claude');
  assert.equal(claude.monthCost, claude.claudeMonthCost);
  const gpt = read('account-old');
  assert.equal(gpt.usageFrom, 'codex');
  assert.equal(gpt.monthCost, gpt.gptMonthCost);
  assert.equal(gpt.claudeAccount.usageFrom, 'claude');
});
