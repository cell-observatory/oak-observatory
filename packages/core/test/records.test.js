// Usage in the local index and the record log that carries every machine's rows to every other (0.11.0): one row per
// message at its largest snapshot, counted once across machines; the readings, spend and accounts beside it; the log a
// machine publishes as its sessions go on, replicated by oak sync and read back into a new index; deliberate deletes
// that reach every copy; the usage pull for machines that do not sync; and cleanups from every surface.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../dist');
const { indexFixture, ask, reply, text } = require('./fixtures/index-fixture.cjs');

const skip = !core.indexRuntime().ok && `no node:sqlite with FTS5 in ${process.version}`;

/** An assistant line reporting a message's usage, `ago` seconds ago. */
const turn = (id, ago, usage, extra = {}) => ({
  type: 'assistant', timestamp: new Date(Date.now() - ago * 1000).toISOString(),
  message: { id, role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: `reply ${id}` }], usage }, ...extra,
});
const userAsk = (t, ago = 3600) => ({ type: 'user', timestamp: new Date(Date.now() - ago * 1000).toISOString(), message: { role: 'user', content: t } });

/** Machines, each a home of its own (and so a host tag of its own: machineHostTag hashes the home), entered in turn. */
function machines(t, names) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oak-records-')));
  const old = { ...process.env };
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k];
    Object.assign(process.env, old);
    core.clearRootMemo();
    core.clearFsCache();
    core.resetIndexRuntime();
    fs.rmSync(base, { recursive: true, force: true });
  });
  const out = { base };
  for (const name of names) {
    const home = path.join(base, name);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const m = {
      name,
      home,
      work: path.join(home, 'work'),
      use() {
        Object.assign(process.env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'), OAK_MACHINE_LABEL: name });
        delete process.env.OAK_INDEX;
        core.clearRootMemo();
        core.clearFsCache();
        core.resetIndexRuntime();
        return m;
      },
      /** Its host tag, as machineHostTag makes it from its host name and home, read without entering it. */
      get host() {
        return require('node:crypto').createHash('sha256').update(`${os.hostname()}\0${home}`).digest('hex').slice(0, 12);
      },
      transcript(id, records, cwd = m.work) {
        m.use();
        const file = path.join(core.projectDir(cwd), `${id}.jsonl`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.mkdirSync(cwd, { recursive: true });
        fs.writeFileSync(file, records.map((r) => JSON.stringify({ cwd, sessionId: id, ...r })).join('\n') + '\n');
        return file;
      },
      catchUp() {
        m.use();
        const ix = core.useIndex({ budgetMs: Infinity, inlineBytes: Infinity });
        assert.ok(ix.ok, ix.reason);
        try {
          assert.equal(ix.catchUp.caughtUp, true, `${name} caught up: ${JSON.stringify(ix.catchUp.problems)}`);
          return ix.catchUp;
        } finally {
          ix.close();
        }
      },
      db(fn) {
        m.use();
        const o = core.openIndex();
        assert.ok(o.ok, o.reason);
        try {
          return fn(o.db);
        } finally {
          o.close();
        }
      },
      records: () => path.join(home, '.claude', 'claude-observatory', 'records'),
    };
    out[name] = m;
  }
  /** Carry `from`'s record log into `to`'s store, as oak sync carries it (the whole folder, as it is now). */
  out.carry = (from, to) => {
    from.use();
    require('../dist/index/records').sealRecords(from.host);
    const host = from.host;
    const dst = path.join(to.records(), host);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(path.join(from.records(), host), dst, { recursive: true });
  };
  return out;
}

const rows = (db, sql, ...args) => db.prepare(sql).all(...args);
const one = (db, sql, ...args) => db.prepare(sql).get(...args);

// --- usage in the index ----------------------------------------------------------------------------------------------

test('usage: one row per message at its largest snapshot, from a session and its workers, cache reads apart; a day rollup beside it', { skip }, (t) => {
  const { a } = machines(t, ['a']);
  const file = a.transcript('s-usage', [
    userAsk('count my tokens'),
    turn('msg-1', 600, { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 9000 }),
    // The same message, written again as it streams: more output. Counted once, at this snapshot.
    turn('msg-1', 590, { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 9000 }),
    turn('msg-2', 300, { input_tokens: 20, output_tokens: 2, cache_creation_input_tokens: 500 }),
    // A line with no usage, and one whose usage counts nothing, add no row.
    { type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'msg-3', role: 'assistant', content: [] } },
    turn('msg-4', 200, { input_tokens: 0, output_tokens: 0 }),
  ]);
  // A worker's transcript beside it: its turns are the account's too.
  const worker = path.join(path.dirname(file), 's-usage', 'subagents', 'agent-w1.jsonl');
  fs.mkdirSync(path.dirname(worker), { recursive: true });
  fs.writeFileSync(worker, JSON.stringify({ cwd: a.work, sessionId: 's-usage', isSidechain: true, ...turn('msg-w', 100, { input_tokens: 7, output_tokens: 3 }) }) + '\n');
  a.catchUp();
  a.db((db) => {
    assert.deepEqual(rows(db, 'SELECT message_id, input, output, cache_create, cache_read FROM usage_messages ORDER BY message_id').map((r) => ({ ...r })), [
      { message_id: 'msg-1', input: 100, output: 40, cache_create: 0, cache_read: 9000 },
      { message_id: 'msg-2', input: 20, output: 2, cache_create: 500, cache_read: 0 },
      { message_id: 'msg-w', input: 7, output: 3, cache_create: 0, cache_read: 0 },
    ]);
    // Tokens are input + output + cache creation, as Claude Code counts them; cache reads apart.
    const total = one(db, 'SELECT total(input + output + cache_create) AS t, total(cache_read) AS r FROM usage_messages');
    assert.deepEqual([total.t, total.r], [140 + 522 + 10, 9000]);
    const daily = one(db, 'SELECT total(messages) AS n, total(input + output + cache_create) AS t, total(cache_read) AS r FROM usage_daily');
    assert.deepEqual([daily.n, daily.t, daily.r], [3, 672, 9000], 'the rollup holds the same');
    // List price, from pricing.ts: msg-1 at Opus 4.8's rates.
    const cost = one(db, "SELECT cost FROM usage_messages WHERE message_id = 'msg-1'").cost;
    assert.ok(Math.abs(cost - (100 * 5 + 40 * 25 + 9000 * 0.5) / 1e6) < 1e-9, `cost ${cost}`);
  });
  // A second catch-up writes nothing; a grown file adds only its new message, and a larger snapshot replaces its row.
  const seqBefore = a.db((db) => Number(db.prepare("SELECT value FROM meta WHERE key = 'usage_seq'").get().value));
  a.catchUp();
  assert.equal(a.db((db) => Number(db.prepare("SELECT value FROM meta WHERE key = 'usage_seq'").get().value)), seqBefore, 'nothing was written again');
  fs.appendFileSync(file, [JSON.stringify({ cwd: a.work, sessionId: 's-usage', ...turn('msg-2', 290, { input_tokens: 20, output_tokens: 9, cache_creation_input_tokens: 500 }) }),
    JSON.stringify({ cwd: a.work, sessionId: 's-usage', ...turn('msg-5', 10, { input_tokens: 1, output_tokens: 1 }) })].join('\n') + '\n');
  a.catchUp();
  a.db((db) => {
    assert.equal(one(db, "SELECT output FROM usage_messages WHERE message_id = 'msg-2'").output, 9);
    assert.equal(one(db, 'SELECT count(*) AS n FROM usage_messages').n, 4);
    assert.equal(one(db, 'SELECT total(input + output + cache_create) AS t FROM usage_daily').t, 672 + 7 + 2, 'the rollup follows the larger snapshot');
  });
});

// Claude Code splits a message's cache writes by how long they are kept (`cache_creation`): an hour's cost more than five
// minutes'. The index keeps the split in the message, its day and its record, and prices each part at its own rate.
test('usage: cache writes are kept by lifetime and each priced at its own rate, in the messages, the day rollup and the records; a write with no split is priced at the 5-minute rate as approximate (0.11.0)', { skip }, (t) => {
  const ms = machines(t, ['a', 'b']);
  const { a, b } = ms;
  const split = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 } };
  a.transcript('s-split', [userAsk('cache this'), turn('w-split', 600, split), turn('w-plain', 500, { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 3000 }),
    turn('w-us', 400, { ...split, inference_geo: 'us' })]);
  a.catchUp();
  // Opus 4.8: input 5, 5-minute write 6.25, 1-hour write 10, output 25 per million; US-only inference 1.1 times that.
  const want = { 'w-split': (10 * 5 + 1000 * 6.25 + 2000 * 10 + 10 * 25) / 1e6, 'w-plain': (10 * 5 + 3000 * 6.25 + 10 * 25) / 1e6, 'w-us': 1.1 * (10 * 5 + 1000 * 6.25 + 2000 * 10 + 10 * 25) / 1e6 };
  const held = (m, host) => m.db((db) => rows(db, 'SELECT message_id, cache_create, cache_create_1h, geo, cost, cost_approx, priced FROM usage_messages WHERE machine_id = ? ORDER BY message_id', host)
    .map((r) => ({ ...r })));
  const expect = [
    { message_id: 'w-plain', cache_create: 3000, cache_create_1h: null, geo: null, cost_approx: 1, priced: core.PRICE_VERSION },
    { message_id: 'w-split', cache_create: 3000, cache_create_1h: 2000, geo: null, cost_approx: 0, priced: core.PRICE_VERSION },
    { message_id: 'w-us', cache_create: 3000, cache_create_1h: 2000, geo: 'us', cost_approx: 0, priced: core.PRICE_VERSION },
  ];
  const check = (got, what) => {
    assert.deepEqual(got.map(({ cost: _c, ...r }) => r), expect, what);
    for (const r of got) assert.ok(Math.abs(r.cost - want[r.message_id]) < 1e-12, `${what}: ${r.message_id} costs ${r.cost}, not ${want[r.message_id]}`);
  };
  check(held(a, a.host), 'this machine\'s rows');
  a.db((db) => {
    const day = one(db, 'SELECT total(cache_create) AS w, total(cache_create_1h) AS h, total(cost_approx) AS x, total(cost) AS c FROM usage_daily');
    assert.deepEqual([day.w, day.h, day.x], [9000, 4000, 1], 'the day holds the hour\'s writes and one approximate message');
    assert.ok(Math.abs(day.c - (want['w-split'] + want['w-plain'] + want['w-us'])) < 1e-12, `the day's cost ${day.c}`);
    const sent = core.usageRecordsSince(db, null).messages.find((m) => m.message_id === 'w-split');
    assert.deepEqual([sent.cache_create_1h, sent.priced], [2000, core.PRICE_VERSION], 'the usage pull sends the split');
    const w = core.windowTotals(db, 'claude', { start: 0, end: Date.now() + 1, reset: null }, null, core.selfIds(db));
    assert.deepEqual([w.cacheCreate, w.cacheCreate1h, w.approx], [9000, 4000, 1], 'a window says how much of its writes were kept an hour, and how many of its messages are priced approximately');
  });
  a.use();
  const q = core.queryIndex('usage', { window: 'all', by: 'agent', account: 'all' });
  assert.deepEqual(q.rows.map((r) => [r.key, r.cache_create, r.cache_create_1h, r.cost_approx]), [['claude', 9000, 4000, 1]], '`oak query usage` says the same');
  // Another machine reads them from the record log, split and priced alike.
  ms.carry(a, b);
  b.catchUp();
  check(held(b, a.host), 'a\'s rows on b');
  // A row an earlier OAK stored without the split (schema 4) takes it from its transcript, read again from the start once.
  a.db((db) => db.exec(`UPDATE usage_messages SET cache_create_1h = NULL, provider = NULL, geo = NULL;
    DELETE FROM ingest_state WHERE kind IN ('usage', 'codex-usage') OR source LIKE 'unit:usage:%'`));
  a.catchUp();
  check(held(a, a.host), 'read again');
});

// The index prices each message when it writes it. A new price table prices again every row an older one priced, this
// machine's and another machine's alike, and the day rollup with them; the tokens and the spend Claude Code reported stay.
test('usage: a new price table prices every stored row again, this machine\'s and another\'s, each message once, by the catch-up, `oak usage` and a usage pull; the reported spend stays (0.11.0)', { skip }, (t) => {
  const ms = machines(t, ['a', 'b']);
  const { a, b } = ms;
  for (const m of [a, b]) fs.writeFileSync(path.join(m.home, '.claude', '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'one-account' } }));
  const both = turn('both-1', 500, { input_tokens: 50, output_tokens: 5 });
  a.transcript('s-a', [userAsk('on a'), turn('a-1', 600, { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 4000,
    cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 3000 } }), both]);
  b.transcript('s-b', [userAsk('on b'), both, turn('b-1', 400, { input_tokens: 2000, output_tokens: 200 })]);
  a.catchUp();
  b.catchUp();
  ms.carry(a, b);
  b.catchUp();
  const priced = () => b.db((db) => rows(db, 'SELECT message_id, machine_id, input, output, cache_create, cache_create_1h, cache_read, cost, cost_approx, priced FROM usage_messages ORDER BY message_id')
    .map((r) => ({ ...r })));
  const day = () => b.db((db) => ({ ...one(db, 'SELECT total(messages) AS n, total(input + output + cache_create) AS t, total(cost) AS c FROM usage_daily') }));
  const before = priced();
  assert.deepEqual(before.map((r) => [r.message_id, r.machine_id === a.host ? 'a' : 'b', r.priced]), [['a-1', 'a', core.PRICE_VERSION], ['b-1', 'b', core.PRICE_VERSION],
    ['both-1', 'b', core.PRICE_VERSION]], 'each message once');
  const cost = before.reduce((s, r) => s + r.cost, 0);
  const dayBefore = day();
  assert.ok(Math.abs(dayBefore.c - cost) < 1e-12);
  // The spend Claude Code reported for b's session, as the status line's ledger records it.
  const reported = Date.now() - 60_000;
  b.db((db) => db.prepare('INSERT INTO usage_spend (machine_id, session_id, reported_ms, usd, delta, account) VALUES (?, ?, ?, ?, ?, ?)').run(b.host, 's-b', reported, 7.5, 7.5, null));
  const spend = () => b.db((db) => rows(db, 'SELECT usd, delta FROM usage_spend').map((r) => [r.usd, r.delta]));
  // An older table priced every row, the identical tokens at other prices.
  const older = () => b.db((db) => db.exec(`UPDATE usage_messages SET cost = cost * 2 + 1, cost_approx = 1, priced = 'aaaaaaaaaaaa';
    UPDATE meta SET value = 'aaaaaaaaaaaa' WHERE key = 'usage_priced'`));
  older();
  assert.ok(Math.abs(day().c - (cost * 2 + 3)) < 1e-9, 'control: the day follows the stored costs');
  // The catch-up prices them again; the tokens, the messages and the reported spend stay as they were.
  b.catchUp();
  assert.deepEqual(priced(), before, 'every row priced again by this table');
  const dayAfter = day();
  assert.deepEqual([dayAfter.n, dayAfter.t], [dayBefore.n, dayBefore.t]);
  assert.ok(Math.abs(dayAfter.c - dayBefore.c) < 1e-12, `and the day with them: ${dayAfter.c}`);
  assert.deepEqual(spend(), [[7.5, 7.5]], 'the reported spend is never priced');
  const totals = b.db((db) => core.usageTotals(db, { fiveReset: null, weekReset: null }));
  assert.equal(totals.five.messages, 3);
  assert.ok(Math.abs(totals.five.cost - Math.round(cost * 10000) / 10000) < 1e-9, `the window's cost ${totals.five.cost}`);
  assert.equal(totals.five.spend, 7.5);
  assert.equal(totals.five.others.cost, Math.round(before[0].cost * 10000) / 10000, 'a\'s part once');
  // `oak usage` (the status line asks it) prices them again before it sums the windows, with no full catch-up.
  older();
  b.use();
  const viaUsage = core.indexedUsageTotals({ fiveReset: null, weekReset: null });
  assert.ok(Math.abs(viaUsage.five.cost - totals.five.cost) < 1e-9, `oak usage's window cost ${viaUsage.five.cost}`);
  assert.deepEqual(priced(), before);
  // A usage pull from an OAK before the split sends rows with no split and no price table: priced as they arrive, the
  // writes at the 5-minute rate, as approximate.
  const sent = a.db((db) => core.usageRecordsSince(db, null));
  const plain = (m, id) => {
    const { cache_create_1h: _h, provider: _p, speed: _s, geo: _g, priced: _v, cost_approx: _x, ...rest } = m;
    return { ...rest, message_id: id, cost: 99 };
  };
  const first = sent.messages.find((m) => m.message_id === 'a-1');
  b.use();
  assert.ok(core.indexApplyUsageRecords({ ...sent, messages: [plain(first, 'a-1'), plain(first, 'a-old')] }, { label: 'a', skewMs: 0 }));
  const after = priced();
  assert.deepEqual(after.filter((r) => r.message_id !== 'a-old'), before, 'a row it holds stays, once');
  const old = after.find((r) => r.message_id === 'a-old');
  assert.deepEqual([old.cache_create_1h, old.cost_approx, old.priced], [null, 1, core.PRICE_VERSION]);
  assert.ok(Math.abs(old.cost - (1000 * 5 + 4000 * 6.25 + 100 * 25) / 1e6) < 1e-12, `a-old costs ${old.cost}`);
  assert.deepEqual(spend(), [[7.5, 7.5]]);
});

test('usage: a message held by two machines counts once; work on separate machines adds up; another account\'s stays out of the windows', { skip }, (t) => {
  const ms = machines(t, ['a', 'b']);
  const { a, b } = ms;
  for (const m of [a, b]) fs.writeFileSync(path.join(m.home, '.claude', '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'shared-account' } }));
  const both = turn('both-1', 500, { input_tokens: 50, output_tokens: 5 });
  a.transcript('s-a', [userAsk('on a'), turn('a-1', 600, { input_tokens: 1000, output_tokens: 100 }), both]);
  // b holds a copy of a's message both-1, its line as it was (a resumed fork, or a transcript copied over), and work of
  // its own.
  b.transcript('s-b', [userAsk('on b'), both, turn('b-1', 400, { input_tokens: 2000, output_tokens: 200 })]);
  a.catchUp();
  b.catchUp();
  ms.carry(a, b);
  b.catchUp();
  const totals = b.db((db) => core.usageTotals(db, { fiveReset: null, weekReset: null }));
  assert.equal(totals.five.tokens, 1100 + 55 + 2200, 'both-1 once, each machine\'s own work added');
  assert.equal(totals.five.messages, 3);
  assert.deepEqual(totals.five.others.machines, [a.host], 'a\'s part is named');
  assert.equal(totals.five.others.tokens, 1100, 'a\'s own message; the one b holds too is b\'s first');
  // A third machine signed in to another account: its usage is no part of this account's windows.
  const { c } = machines(t, ['c']);
  fs.writeFileSync(path.join(c.home, '.claude', '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'other-account' } }));
  c.transcript('s-c', [userAsk('on c'), turn('c-1', 300, { input_tokens: 9999, output_tokens: 1 })]);
  c.catchUp();
  ms.carry(c, b);
  b.catchUp();
  const after = b.db((db) => core.usageTotals(db, { fiveReset: null, weekReset: null }));
  assert.equal(after.five.tokens, totals.five.tokens, 'another account\'s message is left out');
  assert.equal(b.db((db) => one(db, "SELECT count(*) AS n FROM usage_messages WHERE message_id = 'c-1'").n), 1, 'though the index holds it');
});

test('usage: the status line\'s readings, its spend ledger and the accounts go into the index, each reading once per time it was measured', { skip }, (t) => {
  const f = indexFixture(t, core);
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct-1' } }));
  const cache = (extra) => fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'statusline-last.json'), JSON.stringify({
    v: 3, five_pct: 12, five_at: now - 60, five_reset: now + 3600, five_tok: 1_200_000, five_total: 10_000_000,
    week_pct: 30, week_at: now - 120, week_reset: now + 86400, week_tok: 3_000_000, week_total: 10_000_000,
    fable_pct: 4, fable_at: now - 30, fable_reset: now + 86400, fable_label: 'Fable', costs: { 's-1': { usd: 2.5, at: now - 100 } }, ...extra,
  }));
  cache({});
  f.claude('s-1', f.work, [ask('hi'), reply('m1', [text('ok')])]);
  const ix = core.useIndex({ budgetMs: Infinity, inlineBytes: Infinity });
  try {
    const r = rows(ix.db, 'SELECT kind, pct, reset_ms, measured_ms, tokens, budget, label, account FROM usage_readings ORDER BY kind');
    assert.deepEqual(r.map((x) => [x.kind, x.pct, x.reset_ms, x.measured_ms, x.tokens, x.budget]), [
      ['five', 12, (now + 3600) * 1000, (now - 60) * 1000, 1_200_000, 10_000_000],
      ['model', 4, (now + 86400) * 1000, (now - 30) * 1000, null, null],
      ['week', 30, (now + 86400) * 1000, (now - 120) * 1000, 3_000_000, 10_000_000],
    ]);
    assert.equal(r[1].label, 'Fable');
    assert.ok(r.every((x) => /^[0-9a-f]{12}$/.test(x.account)), 'each reading names the account by its tag');
    assert.deepEqual(rows(ix.db, 'SELECT session_id, usd, delta FROM usage_spend').map((x) => [x.session_id, x.usd, x.delta]), [['s-1', 2.5, 2.5]]);
    assert.equal(one(ix.db, "SELECT count(*) AS n FROM accounts WHERE agent = 'claude'").n, 1);
  } finally {
    ix.close();
  }
  // A later render: a new 5h share, the same week share; the session's spend grew. One more reading, one more spend row.
  cache({ five_pct: 14, five_at: now - 10, costs: { 's-1': { usd: 3.75, at: now - 5 } } });
  const ix2 = core.useIndex({ budgetMs: Infinity, inlineBytes: Infinity });
  try {
    assert.equal(one(ix2.db, "SELECT count(*) AS n FROM usage_readings WHERE kind = 'five'").n, 2);
    assert.equal(one(ix2.db, "SELECT count(*) AS n FROM usage_readings WHERE kind = 'week'").n, 1, 'a reading that has not moved writes nothing');
    assert.deepEqual(rows(ix2.db, 'SELECT usd, delta FROM usage_spend ORDER BY reported_ms').map((x) => [x.usd, x.delta]), [[2.5, 2.5], [3.75, 1.25]], 'what each report added');
  } finally {
    ix2.close();
  }
  // Renders that report the same spend again (the status line reports at each one) keep no row.
  cache({ five_pct: 14, five_at: now - 10, costs: { 's-1': { usd: 3.75, at: now - 1 } } });
  const ix3 = core.useIndex({ budgetMs: Infinity, inlineBytes: Infinity });
  try {
    assert.equal(one(ix3.db, 'SELECT count(*) AS n FROM usage_spend').n, 2);
  } finally {
    ix3.close();
  }
});

test('usage: the account\'s windows are placed by the resets the readout shows; a reset that names another window is that window', { skip }, (t) => {
  const { a } = machines(t, ['a']);
  // One message an hour ago, one two days ago, one three weeks ago.
  a.transcript('s-w', [userAsk('windows', 30 * 86400), turn('h1', 3600, { input_tokens: 10, output_tokens: 0 }), turn('d2', 2 * 86400, { input_tokens: 100, output_tokens: 0 }),
    turn('w3', 21 * 86400, { input_tokens: 1000, output_tokens: 0 })]);
  a.catchUp();
  const now = Date.now();
  const t1 = a.db((db) => core.usageTotals(db, { fiveReset: now + 2 * 3600_000, weekReset: now + 3 * 86400_000, now }));
  assert.deepEqual([t1.five.tokens, t1.five.start, t1.five.end], [10, now + 2 * 3600_000 - 5 * 3600_000, now + 2 * 3600_000], 'the 5h window its reset names');
  assert.equal(t1.week.tokens, 110, 'the week its reset names: the last four days');
  // A reset that ended the 5h window (no reset): the last five hours; no weekly reset: the last week from the hour.
  const t2 = a.db((db) => core.usageTotals(db, { fiveReset: null, weekReset: null, now }));
  assert.deepEqual([t2.five.tokens, t2.five.reset, t2.week.tokens], [10, null, 110]);
  // The bill cycle: from the bill day.
  const day = new Date(now - 25 * 86400_000).getUTCDate();
  const cycle = core.billCycle(now, day);
  assert.ok(cycle.start <= now && now < cycle.end && cycle.end - cycle.start >= 28 * 86400_000, JSON.stringify(cycle));
  assert.equal(a.db((db) => core.windowTotals(db, 'claude', cycle, null, core.selfIds(db)).tokens), now - 21 * 86400_000 >= cycle.start ? 1110 : 110);
});

test('usage: `oak query usage` breaks a window down by machine, model, session, day or agent; `readings` lists the shares each machine read', { skip }, (t) => {
  const ms = machines(t, ['a', 'b']);
  const { a, b } = ms;
  a.transcript('s-a', [userAsk('a'), turn('a1', 600, { input_tokens: 100, output_tokens: 1 }), { ...turn('a2', 500, { input_tokens: 50, output_tokens: 0 }), message: { id: 'a2', role: 'assistant', model: 'claude-sonnet-5', content: [], usage: { input_tokens: 50, output_tokens: 0 } } }]);
  b.transcript('s-b', [userAsk('b'), turn('b1', 400, { input_tokens: 7, output_tokens: 0 })]);
  a.catchUp();
  b.catchUp();
  ms.carry(a, b);
  b.use();
  const byMachine = core.queryIndex('usage', { window: 'week', by: 'machine', account: 'all' });
  assert.ok(!byMachine.error, JSON.stringify(byMachine));
  assert.deepEqual(byMachine.rows.map((r) => [r.key, r.tokens]), [[a.host, 151], [b.host, 7]]);
  assert.deepEqual(byMachine.rows.map((r) => r.label), ['a', 'this machine'], 'a machine is named as its records name it');
  b.use();
  const byModel = core.queryIndex('usage', { window: 'all', by: 'model', account: 'all' });
  assert.deepEqual(byModel.rows.map((r) => [r.key, r.tokens]), [['claude-opus-4-8', 108], ['claude-sonnet-5', 50]]);
  const bySession = core.queryIndex('usage', { window: 'all', by: 'session', account: 'all' });
  assert.deepEqual(bySession.rows.map((r) => [r.machine, r.session, r.title]), [[a.host, 's-a', 'a'], [b.host, 's-b', 'b']]);
  assert.equal(core.queryIndex('usage', { window: 'nope' }).error.code, 'bad_param');
  assert.equal(core.queryIndex('usage', { by: 'colour' }).error.code, 'bad_param');
  // A long window reads the daily rollup, and agrees with the messages.
  const all = core.queryIndex('usage', { window: 'all', by: 'agent', account: 'all' });
  const sum = core.queryIndex('usage', { since: '1d', by: 'agent', account: 'all' });
  assert.deepEqual([all.rows[0].tokens, Object.keys(all.rows[0]).includes('first_day')], [158, true], 'the rollup, in whole days');
  assert.deepEqual([sum.rows[0].tokens, Object.keys(sum.rows[0]).includes('first_ts')], [158, true], 'the messages, in a short span');
});

test('usage: a Codex rollout\'s turns go into the index, priced under the provider that served them', { skip }, (t) => {
  const f = indexFixture(t, core);
  const at = (s) => new Date(Date.now() - s * 1000).toISOString();
  f.rollout('0f0f0f0f-0000-4000-8000-000000000001', f.work, [
    { type: 'turn_context', timestamp: at(600), payload: { type: 'turn_context', turn_id: 'turn-1', model: 'gpt-5.1' } },
    { type: 'event_msg', timestamp: at(590), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 },
      last_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, total_tokens: 1050 } } } },
    { type: 'event_msg', timestamp: at(500), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1500, cached_input_tokens: 600, output_tokens: 80 },
      last_token_usage: { input_tokens: 500, cached_input_tokens: 200, output_tokens: 30, total_tokens: 530 } } } },
  ]);
  const ix = core.useIndex({ budgetMs: Infinity, inlineBytes: Infinity });
  try {
    const r = rows(ix.db, "SELECT agent, model, input, output, cache_read, cost FROM usage_messages WHERE agent = 'codex' ORDER BY ts");
    assert.deepEqual(r.map((x) => [x.agent, x.model, x.input, x.output, x.cache_read]), [['codex', 'gpt-5.1', 600, 50, 400], ['codex', 'gpt-5.1', 300, 30, 200]]);
    assert.ok(r[0].cost > 0, 'priced at gpt-5.1\'s list price');
  } finally {
    ix.close();
  }
});

test('usage: a window\'s whole days are summed from the daily rollup and its hours at either end from the messages, to the same totals', { skip }, (t) => {
  const { a } = machines(t, ['a']);
  const hours = [1, 20, 30, 49, 75, 100, 170];
  a.transcript('s-days', [userAsk('days', 200 * 3600), ...hours.map((h, i) => turn(`d${i}`, h * 3600, { input_tokens: 100 * (i + 1), output_tokens: 7, cache_read_input_tokens: 1000 * i },
    i % 3 === 0 ? { message: { id: `d${i}`, role: 'assistant', model: 'claude-fable-5', content: [], usage: { input_tokens: 100 * (i + 1), output_tokens: 7, cache_read_input_tokens: 1000 * i } } } : {}))]);
  a.catchUp();
  a.db((db) => {
    const self = core.selfIds(db);
    const now = Date.now();
    for (const span of [{ start: now - 80 * 3600_000, end: now + 1 }, { start: now - 140 * 3600_000, end: now - 10 * 3600_000 }, { start: now - 4 * 3600_000, end: now + 3600_000 }, { start: 0, end: now + 1 }]) {
      const w = core.windowTotals(db, 'claude', { ...span, reset: null }, null, self);
      const direct = one(db, `SELECT count(*) AS messages, total(input + output + cache_create) AS tokens, total(cache_read) AS cacheRead,
        total(CASE WHEN top_tier = 1 THEN input + output + cache_create ELSE 0 END) AS top FROM usage_messages WHERE ts >= ? AND ts < ?`, span.start, span.end);
      assert.deepEqual([w.messages, w.tokens, w.cacheRead, w.topTier.tokens], [direct.messages, direct.tokens, direct.cacheRead, direct.top], JSON.stringify(span));
    }
    assert.ok(one(db, 'SELECT count(*) AS n FROM usage_daily WHERE top_tier = 1').n > 0, 'control: the rollup holds the top tier');
  });
});

test('usage: readings and spend reports older than a bill cycle and its margin are kept as history: one reading per machine, kind and hour, and one report per session and day with what the day\'s reports added; once a day', { skip }, (t) => {
  const { a } = machines(t, ['a']);
  a.transcript('s-p', [userAsk('p'), turn('p1', 60, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const now = Date.now();
  // An hour sixty days ago and a UTC day fifty days ago, both wholly before the cut; and the hour and the day the cut falls
  // in, whose times before it are kept whole, the bucket not being wholly before it.
  const hour = Math.floor((now - 60 * DAY) / HOUR) * HOUR;
  const day = Math.floor((now - 50 * DAY) / DAY) * DAY;
  const cut = now - 35 * DAY;
  const cutHour = Math.floor(cut / HOUR) * HOUR;
  const cutDay = Math.floor(cut / DAY) * DAY;
  const [m1, m2] = ['0123456789ab', 'ba9876543210'];
  a.db((db) => {
    const reading = db.prepare("INSERT INTO usage_readings (machine_id, agent, kind, measured_ms, no_limit, pct, source) VALUES (?, 'claude', ?, ?, ?, ?, 'statusline')");
    for (const m of [m1, m2]) {
      // Three readings in one old hour, one in the next, and two a day ago.
      for (const [at, pct] of [[hour + 60_000, 1], [hour + 120_000, 2], [hour + 3_000_000, 3], [hour + HOUR + 10, 4], [now - DAY, 5], [now - DAY + 1000, 6]]) reading.run(m, 'five', at, 0, pct);
      reading.run(m, 'week', now - 80 * DAY, 0, 7); // its only reading of the week: the latest, kept
      for (const [at, pct] of [[cutHour + Math.floor((cut - cutHour) / 3), 8], [cutHour + Math.floor(((cut - cutHour) * 2) / 3), 9]]) reading.run(m, 'model', at, 0, pct);
      // Answers on the five-hour limit in one old hour: the hour's last of each answer stays, the newest of each.
      reading.run(m, 'limit', hour + 1000, 1, null);
      reading.run(m, 'limit', hour + 1500, 1, null);
      reading.run(m, 'limit', hour + 2000, 0, null);
    }
    const spend = db.prepare('INSERT INTO usage_spend (machine_id, session_id, reported_ms, usd, delta, synced_ms) VALUES (?, ?, ?, ?, ?, ?)');
    // One session's reports: one the day before an old day, three on that day (it had spent 0.5, then 1.5, 3.5, 6.5: the day
    // added 6), one the next day (it added 4), and two a day ago.
    for (const [at, usd, delta] of [[day - DAY + 500, 0.5, 0.5], [day + 1000, 1.5, 1], [day + 2000, 3.5, 2], [day + 3000, 6.5, 3], [day + DAY + 5, 10.5, 4], [now - DAY, 12.5, 2],
      [now - DAY + 1, 13.5, 1]]) {
      spend.run(m1, 's', at, usd, delta, null);
    }
    // Another's two reports on the day the cut falls in, before the cut: kept whole.
    for (const [at, usd] of [[cutDay + Math.floor((cut - cutDay) / 3), 1], [cutDay + Math.floor(((cut - cutDay) * 2) / 3), 2]]) spend.run(m1, 's3', at, usd, 1, null);
    // Another machine's old day whose reports arrived here an hour ago (a pull that starts over brings back reports folded
    // before): it waits until a day has passed since.
    for (const [at, usd] of [[day + 100, 1], [day + 200, 2]]) spend.run(m2, 's2', at, usd, 1, now - HOUR);
    db.prepare("UPDATE meta SET value = '0' WHERE key = 'usage_pruned_ms'").run();
  });
  a.catchUp();
  const kept = (db, m, kind) => rows(db, 'SELECT measured_ms AS t, pct, no_limit FROM usage_readings WHERE machine_id = ? AND kind = ? ORDER BY t', m, kind).map((r) => [r.t, r.pct ?? r.no_limit]);
  a.db((db) => {
    assert.deepEqual(kept(db, m1, 'five'), [[hour + 3_000_000, 3], [hour + HOUR + 10, 4], [now - DAY, 5], [now - DAY + 1000, 6]], 'the old hour\'s last reading, the next hour\'s, and the last 35 days whole');
    assert.deepEqual(kept(db, m2, 'week'), [[now - 80 * DAY, 7]], 'a machine\'s latest reading stays');
    assert.deepEqual(kept(db, m2, 'limit'), [[hour + 1500, 1], [hour + 2000, 0]], 'the hour\'s newest answer of each kind stays');
    assert.deepEqual(kept(db, m1, 'model').map((r) => r[1]), [8, 9], 'the hour the cut falls in is kept whole');
    assert.deepEqual(rows(db, "SELECT reported_ms AS t, usd, delta FROM usage_spend WHERE session_id = 's' ORDER BY t").map((r) => [r.t, r.usd, r.delta]),
      [[day - DAY + 500, 0.5, 0.5], [day + 3000, 6.5, 6], [day + DAY + 5, 10.5, 4], [now - DAY, 12.5, 2], [now - DAY + 1, 13.5, 1]], 'the old day\'s last report, with what the day added');
    assert.equal(one(db, "SELECT total(delta) AS d FROM usage_spend WHERE session_id = 's'").d, 0.5 + 1 + 2 + 3 + 4 + 2 + 1, 'the same spend over every span of whole days');
    assert.equal(one(db, "SELECT count(*) AS n FROM usage_spend WHERE session_id = 's3'").n, 2, 'the day the cut falls in is kept whole');
    assert.equal(one(db, "SELECT count(*) AS n FROM usage_spend WHERE session_id = 's2'").n, 2, 'a day that took another machine\'s reports in the last day waits');
    // Once a day: a reading that comes in an old hour meanwhile waits for the next day's prune.
    db.prepare("INSERT INTO usage_readings (machine_id, agent, kind, measured_ms, pct, source) VALUES (?, 'claude', 'five', ?, 8, 'statusline')").run(m1, hour + 10);
  });
  a.catchUp();
  assert.equal(a.db((db) => kept(db, m1, 'five').length), 5, 'not again the same day');
  // A day on: that reading goes, and the other machine's day, settled since, folds into its last report.
  a.db((db) => {
    db.prepare("UPDATE meta SET value = ? WHERE key = 'usage_pruned_ms'").run(String(now - DAY - 1));
    db.prepare("UPDATE usage_spend SET synced_ms = ? WHERE session_id = 's2'").run(now - DAY - 1);
  });
  a.catchUp();
  a.db((db) => {
    assert.deepEqual(kept(db, m1, 'five').map((r) => r[1]), [3, 4, 5, 6]);
    assert.deepEqual(rows(db, "SELECT reported_ms AS t, usd, delta FROM usage_spend WHERE session_id = 's2'").map((r) => [r.t, r.usd, r.delta]), [[day + 200, 2, 2]]);
  });
});

test('usage: the account\'s answers on its five-hour limit are readings of their own (kind `limit`), apart from its shares; the record log carries them and `oak query readings` lists them', { skip }, (t) => {
  const ms = machines(t, ['a', 'b']);
  const { a, b } = ms;
  const nowS = Math.floor(Date.now() / 1000);
  for (const m of [a, b]) {
    fs.writeFileSync(path.join(m.home, '.claude', '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'one-account' } }));
    m.transcript(`s-${m.name}`, [userAsk('go'), turn(`n-${m.name}`, 60, { input_tokens: 1, output_tokens: 1 })]);
  }
  const cache = (m, o) => fs.writeFileSync(path.join(m.home, '.claude', 'statusline-last.json'), JSON.stringify({ v: 3, week_pct: 30, week_at: nowS - 900, week_reset: nowS + 86400, ...o }));
  const readings = (m, kind) => m.db((db) => rows(db, 'SELECT measured_ms, no_limit, pct, reset_ms FROM usage_readings WHERE kind = ? ORDER BY measured_ms', kind).map((r) => ({ ...r })));
  // a's account read answered with a 5h window twenty minutes ago and with none ten minutes ago; the share a session
  // reported a minute ago is a share, and no answer.
  cache(a, { five_pct: 12, five_at: nowS - 60, five_reset: nowS + 3600, five_seen_at: nowS - 1200, five_none_at: nowS - 600 });
  a.catchUp();
  assert.deepEqual(readings(a, 'limit').map((r) => [r.measured_ms, r.no_limit, r.pct, r.reset_ms]), [[(nowS - 1200) * 1000, 0, null, null], [(nowS - 600) * 1000, 1, null, null]],
    'the answer with a 5h window, and the later one with none');
  assert.deepEqual(readings(a, 'five').map((r) => [r.measured_ms, r.no_limit, r.pct]), [[(nowS - 60) * 1000, 0, 12]], 'the share is a share');
  // A 5h window that is not running (a share of 0 with no reset) is a share too.
  cache(b, { five_pct: 0, five_at: nowS - 2000 });
  b.catchUp();
  assert.deepEqual([readings(b, 'limit').length, readings(b, 'five').map((r) => r.pct)], [0, [0]]);
  // Two answers in one second, one each way: no limit, as the brief reads them, kept once.
  cache(a, { five_pct: 12, five_at: nowS - 60, five_reset: nowS + 3600, five_seen_at: nowS - 30, five_none_at: nowS - 30 });
  a.catchUp();
  const answers = [[-1200, 0], [-600, 1], [-30, 1]];
  assert.deepEqual(readings(a, 'limit').map((r) => [r.measured_ms / 1000 - nowS, r.no_limit]), answers);
  // The record log carries them, and on b `oak query readings` lists them under a, newest first.
  assert.deepEqual(logLines(a).filter((l) => l.t === 'usage_readings' && l.r.kind === 'limit').map((l) => [l.r.measured_ms / 1000 - nowS, l.r.no_limit]), answers);
  ms.carry(a, b);
  b.catchUp();
  b.use();
  const q = core.queryIndex('readings', { kind: 'limit', machine: a.host });
  assert.ok(!q.error, JSON.stringify(q));
  assert.deepEqual(q.rows.map((r) => [r.agent, r.measured_ms / 1000 - nowS, r.no_limit, r.machine_label]), [...answers].reverse().map(([s, n]) => ['claude', s, n, 'a']));
});

test('usage: each other machine\'s latest reading of each kind, and its newest answer each way on the five-hour limit, come from the index whatever history it keeps', { skip }, (t) => {
  const { a } = machines(t, ['a']);
  a.transcript('s-x', [userAsk('x'), turn('x1', 60, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  const now = Date.now();
  const ids = ['0aaaaaaaaaaa', '0bbbbbbbbbbb', '0ccccccccccc'];
  const MIN = 60_000;
  a.db((db) => {
    const put = db.prepare("INSERT INTO usage_readings (machine_id, agent, kind, measured_ms, no_limit, pct, reset_ms, account, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'abcdef012345', 'statusline')");
    for (const [i, m] of ids.entries()) {
      // Three 5-hour shares, the newest 10 + i minutes ago (its share says how old it is); a weekly share; the answers each
      // way, the newest with no 5h window 200 minutes ago and the newest with one 50 minutes ago; and Codex's own share.
      for (const ago of [90, 30, 10 + i]) put.run(m, 'claude', 'five', now - ago * MIN, 0, ago, now + 3_600_000);
      put.run(m, 'claude', 'week', now - 5 * MIN, 0, 50, now + 86_400_000);
      for (const [ago, n] of [[400, 1], [300, 0], [200, 1], [100, 0], [50, 0]]) put.run(m, 'claude', 'limit', now - ago * MIN, n, null, null);
      put.run(m, 'codex', 'five', now - MIN, 0, 77, now + 3_600_000);
    }
    put.run('0ddddddddddd', 'codex', 'week', now - MIN, 0, 5, now + 86_400_000); // a machine with Codex readings alone: no entry
  });
  const entries = a.db((db) => core.machineReadingEntries(db));
  assert.deepEqual(entries.map((e) => [e.host, e.brief.five.pct, e.brief.week.pct, e.brief.fiveNoneAt, e.brief.fiveSeenAt, e.brief.account]),
    ids.map((m, i) => [m, 10 + i, 50, now - 200 * MIN, now - 50 * MIN, 'abcdef012345']));
});

test('usage pull: an old spend day this index already holds keeps its own reports when a pull brings the sender\'s folded day; a day it holds none of is taken as sent, every page of one pull', { skip }, (t) => {
  const { a, b } = machines(t, ['a', 'b']);
  b.transcript('s-b', [userAsk('b'), turn('b1', 60, { input_tokens: 1, output_tokens: 1 })]);
  b.catchUp();
  const DAY = 86_400_000;
  const now = Date.now();
  const day = Math.floor((now - 50 * DAY) / DAY) * DAY;
  // b holds a's three reports of one old day, from a's record log two days ago, not yet folded here.
  b.db((db) => {
    const spend = db.prepare('INSERT INTO usage_spend (machine_id, session_id, reported_ms, usd, delta, synced_ms) VALUES (?, ?, ?, ?, ?, ?)');
    for (const [at, usd, delta] of [[day + 1000, 1, 1], [day + 2000, 3, 2], [day + 3000, 6, 3]]) spend.run(a.host, 's-a', at, usd, delta, now - 2 * DAY);
  });
  const answer = (spend, cursor) => ({ usageRecords: 1, host: a.host, hosts: [a.host], at: now, cursor, more: false, messages: [], readings: [], spend, accounts: [], purged: [] });
  b.use();
  // A pull that starts over brings a's day as a has folded it: one report carrying what the day added.
  assert.ok(core.indexApplyUsageRecords(answer([{ session_id: 's-a', reported_ms: day + 3000, usd: 6, delta: 6, account: null }], 'e:1:0'), { label: 'a', skewMs: 0, now }));
  const daySpend = (session) => b.db((db) => one(db, 'SELECT total(delta) AS d, count(*) AS n FROM usage_spend WHERE session_id = ?', session));
  assert.deepEqual({ ...daySpend('s-a') }, { d: 6, n: 3 }, 'b keeps its own reports of the day: 6, never 1 + 2 + 6');
  // A day b holds none of comes in two pages of one pull: both pages' reports are taken.
  const pullAt = now + 1;
  for (const [i, r] of [[1, { reported_ms: day + DAY + 1000, usd: 1, delta: 1 }], [2, { reported_ms: day + DAY + 2000, usd: 3, delta: 2 }]]) {
    b.use();
    assert.ok(core.indexApplyUsageRecords(answer([{ session_id: 's-a2', account: null, ...r }], `e:${i + 1}:0`), { label: 'a', skewMs: 0, now: pullAt }));
  }
  assert.deepEqual({ ...daySpend('s-a2') }, { d: 3, n: 2 }, 'both pages of one pull');
  // And b's prune folds each day to what it added.
  b.db((db) => db.prepare("UPDATE meta SET value = '0' WHERE key = 'usage_pruned_ms'").run());
  b.db((db) => db.prepare('UPDATE usage_spend SET synced_ms = ? WHERE machine_id = ?').run(now - 2 * DAY, a.host));
  b.catchUp();
  assert.deepEqual([{ ...daySpend('s-a') }, { ...daySpend('s-a2') }], [{ d: 6, n: 1 }, { d: 3, n: 1 }]);
});

test('usage: one machine\'s answers on its five-hour limit decide alike from its brief, from its record log (oak sync) and from its usage pull, and so does the 5-hour window `oak usage --window` places', { skip }, async (t) => {
  const ms = machines(t, ['a', 'b', 'c', 'd']);
  const { a, b, c, d } = ms;
  const nowS = Math.floor(Date.now() / 1000);
  for (const m of [a, b, c, d]) {
    fs.writeFileSync(path.join(m.home, '.claude', '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'one-account' } }));
    m.transcript(`s-${m.name}`, [userAsk('go'), turn(`n-${m.name}`, 60, { input_tokens: 1, output_tokens: 1 })]);
  }
  const cache = (m, o) => fs.writeFileSync(path.join(m.home, '.claude', 'statusline-last.json'), JSON.stringify({ v: 3, week_pct: 30, week_at: nowS - 900, week_reset: nowS + 86400, ...o }));
  // b, c and d each read the account too: a live 5h share, and an answer with a 5h window five minutes ago.
  for (const m of [b, c, d]) {
    cache(m, { five_pct: 9, five_at: nowS - 120, five_reset: nowS + 3000, five_seen_at: nowS - 300 });
    m.catchUp();
  }
  // b reads a's brief (an OAK there older than the usage pull answers with it), c a's record log (oak sync), d a's pull.
  const ask = async (m, how) => {
    a.use();
    const answer = JSON.stringify(how.verb === 'records' ? core.indexUsageRecords(how.since) : core.machineUsageBrief(a.work));
    d.use();
    return answer;
  };
  const decide = async () => {
    a.catchUp();
    a.use();
    const brief = core.machineUsageBrief(a.work);
    b.use();
    fs.mkdirSync(path.dirname(core.machineUsageCachePath()), { recursive: true });
    fs.writeFileSync(core.machineUsageCachePath(), JSON.stringify({ version: 1, attemptedAt: Date.now(), machines: [{ label: 'a', target: 'me@a', skewMs: 0, rttMs: 1, brief }], outcomes: [] }));
    ms.carry(a, c);
    c.catchUp();
    d.use();
    await core.refreshMachineUsage(async () => [{ label: 'a', target: 'me@a', enabled: true }], ask, { force: true });
    const seen = [b, c, d].map((m) => {
      m.use();
      const u = core.usageLine(m.work, '');
      return [u.fiveNoneAt, u.fiveHourPct];
    });
    // The 5-hour window a breakdown is placed in: none while the account has no five-hour limit, by the same rule.
    seen.push(c.db((db) => core.namedWindow(db, '5h', 'claude').reset === null));
    return seen;
  };
  const alike = (none, pct) => [[none, pct], [none, pct], [none, pct], none !== null];
  // a's account read answered with a 5h window, then with none, both before b's, c's and d's answer with one.
  cache(a, { five_seen_at: nowS - 1200, five_none_at: nowS - 600 });
  assert.deepEqual(await decide(), alike(null, 9), 'an older no-limit answer elsewhere: the 5h window stays');
  // It answered with none since: the newest answer, on every path.
  cache(a, { five_seen_at: nowS - 1200, five_none_at: nowS - 60 });
  assert.deepEqual(await decide(), alike((nowS - 60) * 1000, null), 'a newer no-limit answer elsewhere hides it');
  // A share a session reported there since is no answer.
  cache(a, { five_pct: 40, five_at: nowS - 20, five_reset: nowS + 3600, five_seen_at: nowS - 1200, five_none_at: nowS - 60 });
  assert.deepEqual(await decide(), alike((nowS - 60) * 1000, null), 'nor does a share since bring it back');
  // Answers each way in the same second: no limit.
  cache(a, { five_seen_at: nowS - 60, five_none_at: nowS - 60 });
  assert.deepEqual(await decide(), alike((nowS - 60) * 1000, null), 'the same second: no limit');
  // An answer with a 5h window since brings it back, here with each machine's own live share.
  cache(a, { five_seen_at: nowS - 30, five_none_at: nowS - 60 });
  assert.deepEqual(await decide(), alike(null, 9), 'an answer with a 5h window since brings it back');
  // a signs in to another account, which answers with no 5h window: another account's answer decides nothing here.
  fs.writeFileSync(path.join(a.home, '.claude', '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'another-account' } }));
  cache(a, { five_seen_at: nowS - 30, five_none_at: nowS - 20 });
  assert.deepEqual(await decide(), alike(null, 9), 'another account\'s answer is set aside on every path');
  fs.writeFileSync(path.join(a.home, '.claude', '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'one-account' } }));
  // A no-limit answer dated ten minutes ahead of this clock (a's clock running fast) is set aside on every path.
  cache(a, { five_seen_at: nowS - 30, five_none_at: nowS + 600 });
  assert.deepEqual(await decide(), alike(null, 9), 'one dated past this clock\'s tolerance is set aside');
  // b, c and d answered with no 5h window a minute and a half ago: a's answer with one, thirty seconds ago, is newer, and
  // counts on every path although a's newest answer is the one set aside.
  for (const m of [b, c, d]) cache(m, { five_pct: 9, five_at: nowS - 120, five_reset: nowS + 3000, five_seen_at: nowS - 300, five_none_at: nowS - 90 });
  assert.deepEqual(await decide(), alike(null, 9), 'a\'s answer with a 5h window, behind its set-aside one, still decides');
});

test('usage: a saved machine that answers only with its readings adds what it measured of its own turns to the totals again, and one moving to the usage pull is never counted twice', { skip }, async (t) => {
  const ms = machines(t, ['b', 'p', 'q']);
  const { b, p, q } = ms;
  for (const m of [b, p, q]) fs.writeFileSync(path.join(m.home, '.claude', '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'one-account' } }));
  const now = Date.now();
  const nowS = Math.floor(now / 1000);
  const r5 = (nowS + 3600) * 1000;
  const r7 = (nowS + 3 * 86400) * 1000;
  // b reads the account itself, and q's usage arrives with oak sync: the index holds another machine's usage.
  fs.writeFileSync(path.join(b.home, '.claude', 'statusline-last.json'), JSON.stringify({ v: 3, five_pct: 10, five_at: nowS - 30, five_reset: nowS + 3600, week_pct: 20,
    week_at: nowS - 30, week_reset: nowS + 3 * 86400 }));
  b.transcript('s-b', [userAsk('b'), turn('b1', 600, { input_tokens: 100, output_tokens: 0 })]);
  q.transcript('s-q', [userAsk('q'), turn('q1', 600, { input_tokens: 20, output_tokens: 0 })]);
  q.catchUp();
  ms.carry(q, b);
  b.catchUp();
  // p answers only with its readings (an OAK there older than the usage pull), which carry what it measured of its turns.
  // A bill cycle that began ten days ago, so the month holds the turns whatever the date.
  b.use();
  const billDay = new Date(now - 10 * 86_400_000).getUTCDate();
  core.writePrefs({ ...core.readPrefs(), billDay });
  const cycle = core.billCycle(now, billDay);
  const own = { host: p.host, at: now - 60_000, five: { tok: 5000, reads: 50, cost: 0.5, reset: r5 }, week: { tok: 20000, reads: 200, cost: 2, reset: r7, fable: 1000, fableReads: 10 },
    month: { tok: 90000, reads: 900, cost: 9, reset: cycle.end, start: cycle.start } };
  const brief = { brief: 1, account: core.claudeAccountTag(), at: now, five: null, week: { pct: 20, reset: r7, at: now - 60_000, tok: null, total: null }, fable: null, month: null, own };
  fs.mkdirSync(path.dirname(core.machineUsageCachePath()), { recursive: true });
  fs.writeFileSync(core.machineUsageCachePath(), JSON.stringify({ version: 1, attemptedAt: now, machines: [{ label: 'old-box', target: 'me@p', skewMs: 0, rttMs: 1, brief }],
    outcomes: [{ label: 'old-box', target: 'me@p', at: now, status: 'ok', briefOnly: true }] }));
  const totals = () => (b.use(), core.indexedUsageTotals({ fiveReset: r5, weekReset: r7 }));
  const figures = (x) => [x.five.tokens, x.five.others.tokens, x.five.spend, x.week.tokens, x.week.topTier.tokens, x.month.tokens, x.five.others.machines];
  const ownRows = 100 + 20;
  let x = totals();
  assert.deepEqual(figures(x), [ownRows + 5000, 20 + 5000, 0.5, ownRows + 20000, 1000, ownRows + 90000, [p.host, q.host].sort()], 'p\'s own figures, beside the rows');
  assert.ok(Math.abs(x.month.cost - (b.db((db) => one(db, 'SELECT total(cost) AS c FROM usage_messages').c) + 9)) < 1e-9, 'its month at list price');
  assert.deepEqual(x.machines.find((m) => m.machine === p.host), { machine: p.host, label: 'old-box', self: false, syncedAt: null, briefOnly: true });
  assert.equal(b.db((db) => core.usageTotals(db, { fiveReset: r5, weekReset: r7 })).five.tokens, ownRows, 'control: the rows alone');
  // The readouts' estimates add them too (machineMeasured), and `oak usage --json` carries them for the status line.
  b.use();
  const mm = core.usageLine(b.work, '').machineMeasured;
  assert.deepEqual([mm.five.tok, mm.five.cost, mm.week.fable, mm.month.tok, mm.machines.split(', ').sort()], [5020, 0.5, 1000, 90020, ['old-box', 'q']]);
  const cli = path.resolve(__dirname, '../../cli/dist/index.js');
  const usage = JSON.parse(cp.execFileSync(process.execPath, [cli, 'usage', '--json'], { cwd: b.work, encoding: 'utf8', env: { ...process.env, OAK_NO_BACKGROUND: '1' } }));
  assert.equal(usage.usageTotals.five.tokens, ownRows + 5000);
  // While the account has no five-hour limit there is no 5-hour window to measure in: the estimates' 5-hour part goes.
  const cachePath = path.join(b.home, '.claude', 'statusline-last.json');
  const kept = fs.readFileSync(cachePath, 'utf8');
  fs.writeFileSync(cachePath, JSON.stringify({ ...JSON.parse(kept), five_none_at: nowS }));
  b.use();
  const hidden = core.usageLine(b.work, '');
  assert.deepEqual([hidden.fiveNoneAt, hidden.machineMeasured.five, hidden.machineMeasured.week.tok], [nowS * 1000, null, 20020]);
  fs.writeFileSync(cachePath, kept);
  // The doctor says so, as information.
  const row = core.diagnoseMachineUsage().find((r) => r.id === 'machine-usage:old-box');
  assert.deepEqual([row.level, /what it measured of its own usage, which the totals and estimates here add/.test(row.detail), /oak update/.test(row.fix)], ['ok', true, true]);
  // p now answers with records. Its first page proves the capability, even before any rows in these windows arrive.
  p.transcript('s-p', [userAsk('p', 40 * 86400), turn('p-old', 40 * 86400, { input_tokens: 7000, output_tokens: 0 }), turn('p-new', 600, { input_tokens: 300, output_tokens: 0 })]);
  p.use();
  const o = core.openIndex();
  core.catchUp(o.db, {});
  const page1 = core.usageRecordsSince(o.db, null, 1);
  const page2 = core.usageRecordsSince(o.db, page1.cursor, 1);
  o.close();
  assert.deepEqual([page1.messages.map((m) => m.message_id), page2.messages.map((m) => m.message_id)], [['p-old'], ['p-new']]);
  b.use();
  assert.ok(core.indexApplyUsageRecords(page1, { label: 'old-box', skewMs: 0 }));
  x = totals();
  assert.deepEqual(figures(x).slice(0, 6), [ownRows, 20, 0, ownRows, 0, ownRows], 'the first records page retires the aggregate, whatever its dates');
  b.use();
  assert.ok(core.indexApplyUsageRecords(page2, { label: 'old-box', skewMs: 0 }));
  x = totals();
  assert.deepEqual(figures(x), [ownRows + 300, 20 + 300, 0, ownRows + 300, 0, ownRows + 300, [p.host, q.host].sort()], 'its rows in the windows: they alone count');
  assert.equal(x.machines.find((m) => m.machine === p.host).briefOnly, undefined);
  b.use();
  assert.equal(core.usageLine(b.work, '').machineMeasured.five.tok, 320, 'and so do the estimates');
});

// --- the record log ---------------------------------------------------------------------------------------------------

/** Every record line of a machine's log here, parsed. */
function logLines(m, host = m.host) {
  m.use();
  return core.segments(host).flatMap((s) => fs.readFileSync(s.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

test('records: a machine publishes what it extracts as its sessions go on; another machine\'s index holds it under that machine, marked when it arrived', { skip }, (t) => {
  const ms = machines(t, ['a', 'b']);
  const { a, b } = ms;
  a.transcript('s-a', [userAsk('Teach the zebracorn parser'), turn('za-1', 300, { input_tokens: 30, output_tokens: 3 })]);
  a.use();
  core.ensureStore('s-a');
  core.appendLog('s-a', { ts: Date.now() - 1000, tool: 'Edit', file: path.join(a.work, 'z.ts'), beforeBlob: core.writeBlob('s-a', Buffer.from('a\n')), afterBlob: core.writeBlob('s-a', Buffer.from('a\nb\n')), status: 'pending' });
  core.addComment('s-a', { unit: 1, line: 1, text: 'Rename this zebracorn' });
  a.catchUp();
  const kinds = new Set(logLines(a).map((r) => r.t));
  for (const k of ['batch', 'sessions', 'prompts', 'edits', 'units', 'edit_facts', 'comments', 'usage_messages']) assert.ok(kinds.has(k), `the log holds ${k}: ${[...kinds]}`);
  assert.ok(!logLines(a).some((r) => r.r && ('machine_id' in r.r || 'synced_ms' in r.r)), 'a record names no machine: its log is the machine');
  // Another machine, with none of a's files, reads a's log.
  b.transcript('s-b', [userAsk('b\'s own'), turn('zb-1', 200, { input_tokens: 1, output_tokens: 1 })]);
  ms.carry(a, b);
  const before = Date.now();
  b.catchUp();
  b.db((db) => {
    const s = one(db, 'SELECT machine_id, origin, title, edits, pending, synced_ms FROM sessions WHERE session_id = ?', 's-a');
    assert.deepEqual([s.machine_id, s.origin, s.title, s.edits, s.pending], [a.host, 'synced', 'Teach the zebracorn parser', 1, 1]);
    assert.ok(s.synced_ms >= before, 'marked with when it arrived');
    assert.equal(one(db, 'SELECT count(*) AS n FROM edits WHERE machine_id = ? AND session_id = ?', a.host, 's-a').n, 1);
    assert.equal(one(db, 'SELECT added FROM units WHERE machine_id = ?', a.host).added, 1, 'line counts computed where the blobs are, shipped');
    assert.equal(one(db, "SELECT count(*) AS n FROM comments_fts WHERE comments_fts MATCH 'zebracorn'").n, 1, 'comments searchable here');
    assert.equal(one(db, "SELECT count(*) AS n FROM prompts_fts WHERE prompts_fts MATCH 'zebracorn'").n, 1, 'asks and answers searchable on every machine');
  });
  // One query lists every machine's sessions.
  b.use();
  assert.deepEqual(core.queryIndex('sessions', {}).rows.map((r) => [r.machine, r.id]).sort(), [[a.host, 's-a'], [b.host, 's-b']].sort());
  assert.ok(core.queryIndex('sessions', {}).freshness.sources.some((x) => x.machine === a.host && x.origin === 'replica' && x.throughTs > 0), 'and says how fresh a\'s are');
  // Replay is idempotent: the same log read again (a new index file) leaves the same rows.
  const snapshot = () => b.db((db) => JSON.stringify(rows(db, 'SELECT machine_id, session_id, title, edits FROM sessions ORDER BY session_id')) +
    JSON.stringify(rows(db, 'SELECT message_id, input, output FROM usage_messages ORDER BY message_id')));
  const first = snapshot();
  b.catchUp();
  assert.equal(snapshot(), first);
});

test('records: a new index file reads this machine\'s own log back, so a session whose files are gone keeps its rows', { skip }, (t) => {
  const ms = machines(t, ['a', 'b']);
  const { a, b } = ms;
  const file = a.transcript('s-gone', [userAsk('a session that goes'), turn('g1', 600, { input_tokens: 500, output_tokens: 50 })]);
  a.transcript('s-keep', [userAsk('kept'), turn('k1', 300, { input_tokens: 1, output_tokens: 1 })]);
  a.use();
  core.ensureStore('s-gone');
  core.appendLog('s-gone', { ts: Date.now() - 1000, tool: 'Edit', file: path.join(a.work, 'f.ts'), beforeBlob: core.writeBlob('s-gone', Buffer.from('1\n')), afterBlob: core.writeBlob('s-gone', Buffer.from('2\n')), status: 'kept' });
  a.catchUp();
  // OAK's cleanup, then Claude Code's retention, before any read: the catch-up that archives the session clears its edit
  // and its snapshots, in the record log as in the index.
  a.use();
  core.removeSession('s-gone');
  fs.rmSync(file);
  a.catchUp();
  const gone = (m) => m.db((db) => [one(db, 'SELECT cleared_ms IS NOT NULL AS c FROM edits WHERE session_id = ?', 's-gone').c, one(db, 'SELECT sum(present) AS n FROM blobs WHERE session_id = ?', 's-gone').n]);
  assert.deepEqual(gone(a), [1, 0], 'control: its edit cleared and its snapshots gone, here');
  ms.carry(a, b);
  b.catchUp();
  assert.deepEqual(gone(b), [1, 0], 'and on another machine, from the record log');
  // The index file is lost (or a new format is built).
  const count = (t) => logLines(a).filter((r) => r.t === t).length;
  const published = ['edits', 'prompts', 'usage_messages', 'actions'].map(count);
  a.use();
  for (const n of fs.readdirSync(core.indexDir())) fs.rmSync(path.join(core.indexDir(), n), { force: true });
  a.catchUp();
  a.db((db) => {
    const s = one(db, 'SELECT archived_reason, title FROM sessions WHERE session_id = ?', 's-gone');
    assert.deepEqual([s.archived_reason, s.title], ['cleaned', 'a session that goes'], 'archived as cleaned, as it was');
    assert.equal(one(db, 'SELECT count(*) AS n FROM edits WHERE session_id = ?', 's-gone').n, 1);
    assert.equal(one(db, 'SELECT input FROM usage_messages WHERE message_id = ?', 'g1').input, 500, 'its usage, kept for ever');
    assert.equal(one(db, "SELECT count(*) AS n FROM prompts_fts WHERE prompts_fts MATCH 'goes'").n, 1, 'searchable');
  });
  assert.deepEqual(gone(a), [1, 0], 'its edit still cleared and its snapshots still gone');
  a.use();
  assert.deepEqual(core.queryIndex('sessions', { archived: true }).rows.map((r) => [r.id, r.archived, r.archived_reason]).sort(), [['s-gone', 1, 'cleaned'], ['s-keep', 0, null]]);
  // Reading the files again published none of their rows twice, but for each live session's own row and newest ask, which
  // a new file has no record of having published (one each: s-keep's).
  const now = ['edits', 'prompts', 'usage_messages', 'actions'].map(count);
  assert.deepEqual([now[0], now[2], now[3]], [published[0], published[2], published[3]], 'no second copy of an edit, a message or a tool call');
  assert.equal(now[1], published[1] + 1, 'and of the asks, only the live session\'s newest');
  // The usage it read back pages to the end for a usage pull, a row at a time.
  a.db((db) => {
    const all = rows(db, 'SELECT message_id FROM usage_messages ORDER BY message_id').map((r) => r.message_id);
    const got = [];
    let page = core.usageRecordsSince(db, null, 1);
    for (let i = 0; page && i < 10; i++) {
      got.push(...page.messages.map((m) => m.message_id));
      page = page.more ? core.usageRecordsSince(db, page.cursor, 1) : null;
    }
    assert.deepEqual(got.sort(), all, 'every message, once');
  });
});

test('records: a deliberate delete forgets the session in this machine\'s log (its text gone from every segment at the next compaction) and on every machine that applies it', { skip }, (t) => {
  const ms = machines(t, ['a', 'b']);
  const { a, b } = ms;
  a.transcript('s-secret', [userAsk('the zebracorn password is swordfish'), turn('x1', 300, { input_tokens: 10, output_tokens: 1 })]);
  a.transcript('s-other', [userAsk('another session'), turn('x2', 200, { input_tokens: 10, output_tokens: 1 })]);
  a.catchUp();
  ms.carry(a, b);
  b.catchUp();
  assert.equal(b.db((db) => one(db, "SELECT count(*) AS n FROM prompts_fts WHERE prompts_fts MATCH 'swordfish'").n), 1, 'control: b holds it');
  a.use();
  core.deleteSession('s-secret');
  // The delete is in a's log at once, before any compaction: a machine that takes the log now forgets the session.
  assert.ok(logLines(a).some((r) => r.t === 'purge' && r.s === 's-secret'), 'a purge record');
  ms.carry(a, b);
  b.catchUp();
  b.db((db) => {
    assert.equal(one(db, "SELECT count(*) AS n FROM sessions WHERE session_id = 's-secret'").n, 0, 'b forgot it from the purge record');
    assert.equal(one(db, "SELECT count(*) AS n FROM prompts_fts WHERE prompts_fts MATCH 'swordfish'").n, 0, 'its full-text entries too');
  });
  a.catchUp();
  const text = () => core.segments(a.host).map((s) => fs.readFileSync(s.file, 'utf8')).join('');
  assert.ok(!text().includes('swordfish'), 'the session\'s text is gone from a\'s log');
  assert.ok(text().includes('another session'), 'the rest stays');
  assert.equal(core.segments(a.host).length, 1, 'one base now');
  ms.carry(a, b);
  b.catchUp();
  b.db((db) => {
    assert.equal(one(db, "SELECT count(*) AS n FROM prompts_fts WHERE prompts_fts MATCH 'swordfish'").n, 0, 'b forgot it, full-text entries too');
    assert.equal(one(db, "SELECT count(*) AS n FROM sessions WHERE session_id = 's-secret'").n, 0);
    assert.equal(one(db, "SELECT count(*) AS n FROM sessions WHERE session_id = 's-other'").n, 1);
    assert.equal(one(db, "SELECT session_id FROM usage_messages WHERE message_id = 'x1'").session_id, '', 'its usage stays in the account\'s, without the session');
  });
});

// Another machine's delete reaches this index as that machine's log says it: a purge record, or, once that machine compacted
// its log, a base without the session. Either is forgotten here as a delete here forgets one: in every index file in the
// folder, and out of the write-ahead log, which a process that keeps the index open (the terminal app's worker, an
// editor) would otherwise keep the session's pages in.
test('records: a session another machine deleted is forgotten in every index file here and out of the write-ahead log, from its purge record or from a base', { skip }, (t) => {
  const ms = machines(t, ['a', 'b']);
  const { a, b } = ms;
  a.transcript('s-x', [userAsk('the numbat password is quetzal'), turn('n1', 300, { input_tokens: 10, output_tokens: 1 })]);
  a.transcript('s-y', [userAsk('the axolotl password is pangolin'), turn('n2', 250, { input_tokens: 10, output_tokens: 1 })]);
  a.transcript('s-keep', [userAsk('another session'), turn('n3', 200, { input_tokens: 10, output_tokens: 1 })]);
  a.transcript('s-z', [userAsk('the quoll password is wallaroo'), turn('n4', 190, { input_tokens: 10, output_tokens: 1 })]);
  // More rows than one transaction reads, so that a base of a's log can be read in two catch-ups.
  const bulk = [userAsk('a long session')];
  for (let i = 0; i < 6000; i++) bulk.push(turn(`bulk-${i}`, 180, { input_tokens: 1, output_tokens: 1 }));
  a.transcript('s-bulk', bulk);
  a.catchUp();
  ms.carry(a, b);
  b.catchUp();
  b.use();
  const current = core.indexFile();
  const old = path.join(core.indexDir(), `index-v0-${core.storeKey()}.sqlite`);
  fs.copyFileSync(current, old);
  const holds = (file, word) => [file, `${file}-wal`].filter((p) => fs.existsSync(p)).some((p) => fs.readFileSync(p).includes(Buffer.from(word)));
  // A row of the same session id under another machine, which a's delete is not about.
  const plant = new (require('node:sqlite').DatabaseSync)(old);
  plant.prepare('INSERT INTO tombstones (machine_id, session_id, deleted_ms, source) VALUES (?, ?, ?, ?)').run('ffffffffffff', 's-x', 1, 'wallaby');
  plant.close();
  const forgets = (word, ...act) => {
    assert.ok(holds(old, word) && holds(current, word), `control: both index files hold ${word}`);
    for (const fn of act) fn();
    ms.carry(a, b);
    // A process that keeps the index open, as the terminal app's worker does (it has read it): closing the catch-up's own
    // connection then checkpoints nothing.
    const reader = new (require('node:sqlite').DatabaseSync)(current);
    reader.prepare('SELECT count(*) AS n FROM sessions').get();
    try {
      b.catchUp();
      assert.equal(b.db((db) => one(db, "SELECT count(*) AS n FROM prompts_fts WHERE prompts_fts MATCH ?", word).n), 0, `control: ${word} is forgotten in the index`);
      assert.equal(holds(old, word), false, `nor kept in the superseded index file (${word})`);
      assert.equal(holds(current, word), false, `nor in the pages the write-ahead log held (${word})`);
    } finally {
      reader.close();
    }
  };
  // a's delete, read from its purge record.
  forgets('quetzal', () => { a.use(); core.deleteSession('s-x'); }, () => assert.ok(logLines(a).some((r) => r.t === 'purge' && r.s === 's-x'), 'control: a purge record'));
  // a's delete, read from the base a compacted it into before b read its log.
  forgets('pangolin', () => { a.use(); core.deleteSession('s-y'); a.catchUp(); }, () => assert.ok(core.segments(a.host).every((x) => x.base) && logLines(a).some((r) => r.t === 'purge' && r.s === 's-y'), 'control: only a base, retaining the purge'));
  // a's delete, from a base b reads part way in one catch-up and to its end in the next.
  assert.ok(holds(old, 'wallaroo') && holds(current, 'wallaroo'), 'control: both index files hold wallaroo');
  a.use();
  core.deleteSession('s-z');
  a.catchUp();
  assert.ok(core.segments(a.host).every((x) => x.base), 'control: only a base');
  ms.carry(a, b);
  b.use();
  const cut = core.useIndex({ budgetMs: 0, inlineBytes: Infinity });
  assert.ok(cut.ok, cut.reason);
  try {
    assert.equal(cut.catchUp.caughtUp, false, 'control: the base read part way');
  } finally {
    cut.close();
  }
  b.catchUp();
  assert.equal(holds(old, 'wallaroo'), false, 'nor kept in the superseded index file, from a base read in two catch-ups');
  b.use();
  assert.deepEqual(core.queryIndex('sessions', {}).rows.filter((r) => r.machine === a.host).map((r) => r.id).sort(), ['s-bulk', 's-keep'], 'the rest stays');
  assert.ok(holds(old, 'wallaby'), 'and another machine\'s row of the same session id');
});

// A search of this machine's conversations from the index reads the asks of the sessions whose files are here and none of
// the other machines', which only their records hold: those were read whole and dropped one by one, and every search paid
// for every machine's history (`oak search` was 27% slower than in v0.10.0 on a synthetic machine of 1,200 sessions).
test('records: a search here reads no other machine\'s asks, and finds what the files\' search finds', { skip }, (t) => {
  const ms = machines(t, ['a', 'b']);
  const { a, b } = ms;
  for (let i = 0; i < 6; i++) a.transcript(`s-a${i}`, [userAsk(`remote kumquat plan ${i}`), turn(`ra${i}`, 300 - i, { input_tokens: 1, output_tokens: 1 })]);
  for (let i = 0; i < 3; i++) b.transcript(`s-b${i}`, [userAsk(`local kumquat plan ${i}`), turn(`rb${i}`, 200 - i, { input_tokens: 1, output_tokens: 1 }), userAsk(`and the kumquat test ${i}`)]);
  // A session of the other machine's under an id one of this machine's has (a transcript synced or forked between them).
  a.transcript('s-b0', [userAsk('remote kumquat twin'), turn('ra-twin', 290, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  ms.carry(a, b);
  b.catchUp();
  // Every row any statement of the search hands back from the asks.
  let read = 0;
  const counting = (db) => new Proxy(db, { get: (d, k) => (k === 'prepare' ? (sql) => {
    const st = d.prepare(sql);
    if (!/\bFROM prompts\b/.test(sql)) return st;
    return new Proxy(st, { get: (x, m) => (m === 'iterate' ? function* (...args) { for (const row of x.iterate(...args)) { read++; yield row; } }
      : m === 'all' ? (...args) => { const rows = x.all(...args); read += rows.length; return rows; } : typeof x[m] === 'function' ? x[m].bind(x) : x[m]) });
  } : typeof d[k] === 'function' ? d[k].bind(d) : d[k]) });
  const found = b.db((db) => core.indexedSearch(counting(db), b.work, 'kumquat', {}));
  b.use();
  const files = core.searchConversations(b.work, 'kumquat', {});
  assert.deepEqual(found.hits.map((h) => [h.session, h.prompt]), files.hits.map((h) => [h.session, h.prompt]), 'the hits the files\' search finds');
  assert.deepEqual([...new Set(found.hits.map((h) => h.session))].sort(), ['s-b0', 's-b1', 's-b2'], 'control: this machine\'s sessions');
  assert.equal(found.hits.length, 6, 'control: both asks of each');
  assert.equal(read, 6, 'the asks it read: this machine\'s six, none of the other machine\'s');
  assert.equal(b.db((db) => one(db, 'SELECT count(*) AS n FROM prompts WHERE machine_id = ?', a.host).n), 7, 'control: the index holds the other machine\'s asks');
});

test('records: a machine holding a base whole lets go of the segments it covers, and the sync family never pulls them again', { skip }, (t) => {
  const ms = machines(t, ['a', 'b']);
  const { a, b } = ms;
  a.transcript('s-1', [userAsk('one'), turn('c1', 300, { input_tokens: 1, output_tokens: 1 })]);
  a.transcript('s-2', [userAsk('two'), turn('c2', 200, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  ms.carry(a, b);
  b.catchUp();
  const old = core.segments(a.host).map((s) => s.name);
  // a compacts (a forgotten session asks for it).
  a.use();
  core.deleteSession('s-1');
  a.catchUp();
  const base = core.segments(a.host);
  assert.equal(base.length, 1);
  assert.ok(base[0].base);
  // b receives the base beside its old copies, as a pull would bring it.
  b.use();
  fs.copyFileSync(base[0].file, path.join(b.records(), a.host, base[0].name));
  const fam = core.syncFamily('oak-records');
  assert.ok(fam, 'the record logs are a sync family');
  assert.equal(fam.target({ name: `records/${a.host}/${old[0]}` }, { host: a.host, label: 'a', origin: a.host, me: b.host }), null, 'a covered segment is never pulled again');
  assert.equal(fam.target({ name: `records/${a.host}/${base[0].name}` }, { host: a.host, label: 'a', origin: a.host, me: b.host }), `records/${a.host}/${base[0].name}`);
  b.catchUp();
  assert.deepEqual(core.segments(a.host).map((s) => s.name), [base[0].name], 'b let go of what the base covers');
  // A base not yet whole covers nothing: its header whole, its body cut short.
  const half = path.join(b.records(), a.host, '9999999999999-00000000-base.jsonl');
  const header = core.baseHeader(base[0].file);
  assert.ok(header.bytes > 2, 'the base holds s-2');
  fs.writeFileSync(half, fs.readFileSync(base[0].file).subarray(0, header.headerBytes + header.bytes - 1));
  assert.equal(core.wholeBase(core.segments(a.host)).name, base[0].name, 'a partial base is not the newest whole one');
  fs.rmSync(half);
  // The family lists every machine's segments, and names this machine's own as its own.
  b.use();
  const list = fam.list({});
  assert.ok(list.some((e) => e.name === `records/${a.host}/${base[0].name}`));
  assert.ok(fam.accepts(`records/${a.host}/${base[0].name}`) && !fam.accepts(`records/${a.host}/../x.jsonl`) && !fam.accepts('records/zz/1.jsonl'));
});

test('records: the folder is the store\'s own, never a session, and `oak clean` leaves it', { skip }, (t) => {
  const { a } = machines(t, ['a']);
  a.transcript('s-r', [userAsk('r'), turn('r1', 10, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  a.use();
  assert.ok(core.isReservedStoreDir('records'));
  assert.ok(!core.allStoreSessionIds().includes('records'));
  assert.throws(() => core.removeSession('records'), /keeps for itself/);
  assert.ok(core.segments(a.host).length > 0, 'the log is still there');
});

/** OAK 0.10.0's plain `oak clean` on a store root, written out from its source (packages/core/src/store.ts and the CLI's
 *  cmdClean at v0.10.0: allStoreSessionIds, gcSession, pruneEmptySession), so the store's own folders are checked against
 *  that rule and not against this build's: every root folder it does not keep for itself is a session to it; its blobs
 *  (64 hex digits) that no log record or staged capture names are deleted; and it is removed when it then holds no edit
 *  log, no staging, no capture events or ACP journal and nothing in `blobs/`. Returns the folders it removed. */
function cleanAsOak010(root) {
  const reserved = new Set(['changemap-cache', 'session-meta', 'usage-cursors', '.file-locks', 'runtime-transcripts', 'remote-cache']);
  const removed = [];
  for (const id of fs.readdirSync(root)) {
    if (reserved.has(id) || id.startsWith('agent-prefs-') || id.startsWith('.') || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) continue;
    const dir = path.join(root, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
    const referenced = new Set();
    let text = '';
    try { text = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8'); } catch { /* none */ }
    for (const l of text.split('\n')) { try { const r = JSON.parse(l); for (const b of [r.beforeBlob, r.afterBlob]) if (b) referenced.add(b); } catch { /* torn */ } }
    for (const n of ls(path.join(dir, 'staging'))) if (n.endsWith('.json')) { try { const r = JSON.parse(fs.readFileSync(path.join(dir, 'staging', n), 'utf8')); for (const b of [r.beforeBlob, r.afterBlob, ...Object.values(r.files ?? {})]) if (b) referenced.add(b); } catch { /* kept, as 0.10.0 keeps it */ } }
    for (const n of ls(path.join(dir, 'blobs'))) if (/^[0-9a-f]{64}$/.test(n) && !referenced.has(n)) fs.unlinkSync(path.join(dir, 'blobs', n));
    if (fs.existsSync(path.join(dir, 'log.jsonl')) || ls(path.join(dir, 'staging')).length) continue;
    if (ls(dir).some((f) => f === 'capture-events.jsonl' || (f.startsWith('acp-') && f.endsWith('.jsonl')))) continue;
    if (ls(path.join(dir, 'blobs')).length) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(id);
  }
  return removed;
}

// OAK 0.10.0 knows neither oak sync's folder nor the record log's: its plain `oak clean`, run by an older OAK left beside
// this one, deleted both, the backup key and every machine's log with them. Each holds a file in `blobs/` that it keeps,
// made with the folder, and by the first catch-up in a folder an earlier build made.
test('records: OAK 0.10\'s `oak clean` keeps oak sync\'s folder and the record log, made now or by an earlier build', { skip }, (t) => {
  const { a } = machines(t, ['a']);
  a.transcript('s-k', [userAsk('kept through an old clean'), turn('k1', 10, { input_tokens: 1, output_tokens: 1 })]);
  a.use();
  const root = core.rootDir();
  const guard = (name) => path.join(root, name, 'blobs', 'README');
  // Each folder holds the file from the moment it is made, by whatever makes it: the record log's first append, a
  // backup key, a sync run's lock, and the list of the sessions OAK's own cleanup removed.
  a.catchUp();
  assert.ok(fs.existsSync(guard('records')) && !fs.existsSync(path.join(root, 'sync')), 'the record log\'s folder, made by its first append');
  a.use();
  core.writeSyncKey(core.newSyncKey());
  assert.ok(fs.existsSync(guard('sync')), 'oak sync\'s, made by a backup key');
  fs.rmSync(path.join(root, 'sync', 'blobs'), { recursive: true, force: true });
  assert.ok(core.takeSyncLock(60_000), 'control: the lock a run takes');
  core.releaseSyncLock();
  assert.ok(fs.existsSync(guard('sync')), 'and by a sync run');
  const keyFile = path.join(root, 'sync', 'key');
  const key = fs.readFileSync(keyFile);
  fs.rmSync(path.join(root, 'sync'), { recursive: true, force: true });
  core.ensureStore('s-stub');
  core.removeSession('s-stub');
  assert.ok(fs.existsSync(path.join(root, 'sync', 'evicted.jsonl')) && fs.existsSync(guard('sync')), 'and by OAK\'s own cleanup, which lists what it removed there');
  fs.rmSync(path.join(root, 'sync', 'blobs'), { recursive: true, force: true });
  core.writePrefs({ ...core.readPrefs(), machineUsage: false });
  assert.ok(fs.existsSync(path.join(root, 'sync', 'settings.json')) && fs.existsSync(guard('sync')), 'and by oak sync\'s copy of its settings, which a save of them makes');
  fs.writeFileSync(keyFile, key, { mode: 0o600 });
  // Control: the rule, run over a copy without those files, removes both folders.
  const bare = path.join(a.home, 'bare-store');
  fs.cpSync(root, bare, { recursive: true });
  for (const name of ['sync', 'records']) fs.rmSync(path.join(bare, name, 'blobs'), { recursive: true, force: true });
  assert.deepEqual(cleanAsOak010(bare).sort(), ['records', 'sync'], 'control: OAK 0.10\'s clean removes both folders as they were made before');
  // OAK 0.10's clean leaves both whole.
  assert.deepEqual(cleanAsOak010(root), [], 'nothing removed');
  assert.ok(core.readSyncKey(), 'the backup key is kept');
  assert.ok(core.segments(a.host).length > 0, 'and the record log');
  // Made by an earlier build (no file): the first catch-up gives each folder its file.
  for (const name of ['sync', 'records']) fs.rmSync(path.join(root, name, 'blobs'), { recursive: true, force: true });
  a.catchUp();
  for (const name of ['sync', 'records']) assert.ok(fs.existsSync(guard(name)), `${name} holds it again after a catch-up`);
  assert.deepEqual(cleanAsOak010(root), [], 'nothing removed');
  // Nothing in this build takes either file for anything: no machine reads a log from `records/blobs`.
  assert.deepEqual(core.recordHosts(), [a.host]);
  assert.ok(!core.allStoreSessionIds().some((id) => id === 'sync' || id === 'records'));
});

// The record log is the archive's truth on every other machine and in the backup. One lost while this machine's index still
// holds what it published (OAK 0.10's `oak clean` before the file above kept it, or a hand) is written again whole, from
// the index, at the next catch-up, whatever was appended to it since; one the index never published is left for oak
// sync to bring back.
test('records: a record log lost while the index holds what it published is written again whole at the next catch-up', { skip }, (t) => {
  const ms = machines(t, ['a', 'b']);
  const { a, b } = ms;
  const file = a.transcript('s-gone', [userAsk('the quokka archive must survive'), turn('q1', 600, { input_tokens: 5, output_tokens: 1 })]);
  a.transcript('s-live', [userAsk('a live session'), turn('q2', 300, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  fs.rmSync(file);
  a.catchUp();
  assert.equal(a.db((db) => one(db, 'SELECT archived_reason FROM sessions WHERE session_id = ?', 's-gone').archived_reason), 'missing', 'control: archived here');
  const text = () => logLines(a).map((r) => JSON.stringify(r)).join('\n');
  assert.ok(text().includes('quokka'), 'control: the log holds it');
  // The whole folder goes; then a status line render appends this machine's usage readings to a log begun again, which
  // asks no compaction of its own, before any listing.
  fs.rmSync(a.records(), { recursive: true, force: true });
  a.use();
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'statusline-last.json'), JSON.stringify({ v: 3, five_pct: 12, five_at: now - 60, five_reset: now + 3600, week_pct: 30, week_at: now - 120, week_reset: now + 86400 }));
  assert.ok(core.indexedUsageTotals({ fiveReset: null, weekReset: null }), 'control: the usage read ran');
  assert.ok(core.segments(a.host).length === 1 && text().includes('usage_readings') && !text().includes('quokka'), 'control: the log holds only the readings');
  const doctorRow = () => { a.use(); return core.diagnoseSync().find((c) => c.id === 'sync-records'); };
  assert.equal(doctorRow(), undefined, 'no row where oak sync is not used');
  const status = path.join(core.rootDir(), 'sync', 'status.json');
  fs.mkdirSync(path.dirname(status), { recursive: true });
  fs.writeFileSync(status, JSON.stringify({ at: Date.now(), durationMs: 5, status: 'ok', warnings: [], machines: [] }));
  assert.equal(doctorRow()?.level, 'warn', 'one where oak sync ran');
  fs.rmSync(status);
  core.writePrefs({ ...core.readPrefs(), sync: { backup: { kind: 'folder', path: path.join(a.home, 'share') } } });
  assert.equal(doctorRow()?.level, 'warn', 'oak doctor says the log is lost, where a backup is in use');
  assert.match(doctorRow().fix, /oak sessions/, 'and how to write it again');
  a.catchUp();
  assert.equal(doctorRow(), undefined, 'and no more after the catch-up');
  assert.ok(core.segments(a.host).some((s) => s.base), 'a base written');
  assert.ok(text().includes('quokka') && text().includes('a live session') && text().includes('usage_readings'), 'holding the archive, the rest, and what was appended');
  ms.carry(a, b);
  b.catchUp();
  b.use();
  assert.deepEqual(core.queryIndex('sessions', { archived: true }).rows.filter((r) => r.machine === a.host).map((r) => [r.id, r.archived]).sort(), [['s-gone', 1], ['s-live', 0]], 'another machine has the archive from it');
  // A log lost with nothing appended since: the next catch-up writes it too.
  fs.rmSync(a.records(), { recursive: true, force: true });
  a.catchUp();
  assert.ok(core.segments(a.host).length === 1 && text().includes('quokka'), 'written again from the index alone');
  assert.ok(fs.existsSync(path.join(a.records(), 'blobs', 'README')), 'in a folder OAK 0.10\'s clean keeps');
  // A new index file that never published this machine's log writes no base over it: oak sync brings it back.
  fs.rmSync(a.records(), { recursive: true, force: true });
  a.use();
  for (const n of fs.readdirSync(core.indexDir())) fs.rmSync(path.join(core.indexDir(), n), { force: true });
  a.catchUp();
  assert.ok(!core.segments(a.host).some((s) => s.base), 'no base over a log another machine or the backup may hold');
  // Nor does an index that holds this machine's rows but never read or wrote its log (no record of it): it holds less
  // than the log the backup holds.
  a.db((db) => db.prepare('DELETE FROM ingest_state WHERE source = ?').run(`records:${a.host}`));
  fs.rmSync(a.records(), { recursive: true, force: true });
  a.catchUp();
  assert.deepEqual(core.segments(a.host), [], 'no base written');
});

/** Whether `m`'s next catch-up writes nothing (it finds nothing to do), as another reader of its index sees it. */
function settles(m) {
  m.use();
  const reader = core.openIndex();
  assert.ok(reader.ok, reader.reason);
  try {
    const before = one(reader.db, 'PRAGMA data_version').data_version;
    m.catchUp();
    return one(reader.db, 'PRAGMA data_version').data_version === before;
  } finally {
    reader.close();
  }
}

// The durable checkpoint of a read stopped inside a segment, followed by loss of that segment. No clock-dependent
// transaction cutoff is needed: this is exactly the state the next catch-up receives.
function lostPartial(t) {
  const { a, b } = machines(t, ['a', 'b']);
  a.transcript('s-kept', [userAsk('kept fixture')]);
  a.catchUp();
  const [seg] = core.segments(a.host);
  const body = fs.readFileSync(seg.file);
  a.db((db) => db.prepare('UPDATE ingest_state SET state = ? WHERE source = ?').run(
    JSON.stringify({ base: null, read: { [seg.name]: 1 }, partial: true }), `records:${a.host}`));
  fs.rmSync(seg.file);
  a.catchUp();
  a.transcript('s-secret', [userAsk('synthetic marmoset text')]);
  a.catchUp();
  core.deleteSession('s-secret');
  a.catchUp();
  assert.ok(logLines(a).some((r) => JSON.stringify(r).includes('marmoset')), 'control: deletion waits for compaction');
  return { a, b, seg, body, partial: () => a.db((db) => require('../dist/index/ingest').logState(db, a.host)?.partial) };
}

test('records: a permanently missing partial segment releases compaction after a complete sync survey', { skip }, async (t) => {
  const { a, b, partial } = lostPartial(t);
  assert.equal(partial(), true, 'no evidence yet: keep waiting');
  assert.equal((await core.syncNow(transport(a, { b }))).status, 'ok');
  a.catchUp();
  assert.equal(partial(), undefined, 'no saved machine or backup holds the missing part');
  assert.ok(!logLines(a).some((r) => JSON.stringify(r).includes('marmoset')), 'the deleted text leaves the replicated log');
  assert.equal(a.db((db) => one(db, "SELECT value FROM meta WHERE key = 'records_compact'").value), '0');
  assert.ok(settles(a), 'catch-ups settle after compaction');
});

test('records: doctor names a partial log and the recovery step, even before sync is set up', { skip }, (t) => {
  const { a, seg } = lostPartial(t);
  const row = core.diagnoseSync().find((c) => c.id === `sync-records-partial:${a.host}`);
  assert.ok(row, 'the wait must be visible');
  assert.equal(row.level, 'warn');
  assert.ok(row.detail.includes(path.join(a.records(), a.host)) && row.detail.includes(seg.name));
  assert.match(row.fix, /oak sync now/);
  assert.match(row.fix, /oak sessions/);
  assert.ok(core.diagnoseMarkdown([row]).includes('`oak sync now`'), 'the editors receive the same recovery step');
});

for (const why of ['unreachable', 'disabled', 'excluded', 'limited', 'unknown list', 'unreadable backup', 'changed backup', 'old survey', 'dropped entry', 'unlisted records', 'held segment', 'held base']) {
  test(`records: a missing partial log still waits with ${why}`, { skip }, async (t) => {
    const { a, b, seg, partial } = lostPartial(t);
    const wire = transport(a, { b });
    if (why === 'unreachable') wire.inventory = async () => ({ status: 'unreachable', detail: 'fixture offline' });
    if (why === 'disabled') { const list = await wire.machines(); wire.machines = async () => list.map((m) => ({ ...m, enabled: false })); }
    if (why === 'unknown list') wire.machines = async () => null;
    if (why === 'excluded') core.writePrefs({ sync: { exclude: { machines: ['b'] } } });
    if (why === 'unreadable backup') core.writePrefs({ sync: { backup: { kind: 'folder', path: path.join(a.home, 'absent-backup') } } });
    if (why.startsWith('held ')) {
      b.use();
      if (why === 'held base') require('../dist/index/records').writeBase(a.host, seg.name, () => {});
      else {
        fs.mkdirSync(path.join(b.records(), a.host), { recursive: true });
        fs.writeFileSync(path.join(b.records(), a.host, seg.name), '{"t":"batch","v":1}\n');
      }
      a.use();
      core.writePrefs({ sync: { families: { 'oak-records': 'off' } } });
    }
    if (why === 'dropped entry' || why === 'unlisted records') {
      const inventory = wire.inventory;
      wire.inventory = async (...args) => {
        const inv = JSON.parse((await inventory(...args)).text);
        if (why === 'unlisted records') delete inv.families['oak-records'];
        else inv.families['oak-records'] = [{ name: '../invalid', size: 1, mtime: Date.now() }];
        return { text: JSON.stringify(inv) };
      };
    }
    await core.syncNow(wire, why === 'limited' ? { machines: ['b'] } : why === 'old survey' ? { now: 1 } : {});
    if (why === 'old survey') {
      const file = path.join(core.syncDir(), 'records-survey.json');
      if (fs.existsSync(file)) { const v = JSON.parse(fs.readFileSync(file)); v.at = 1; fs.writeFileSync(file, JSON.stringify(v)); }
    }
    if (why === 'changed backup') core.writePrefs({ sync: { backup: { kind: 'folder', path: path.join(a.home, 'new-backup') } } });
    a.catchUp();
    assert.equal(partial(), true, 'not proof that the missing history is gone');
    assert.ok(logLines(a).some((r) => JSON.stringify(r).includes('marmoset')), 'compaction still waits');
  });
}

test('records: a complete empty backup survey releases the missing partial log, bounded by its history', { skip }, async (t) => {
  const { a, seg, partial } = lostPartial(t);
  const share = path.join(a.home, 'backup');
  const key = core.newSyncKey();
  core.writeSyncKey(key);
  assert.equal(core.initBackupFolder(share, key).check.ok, true);
  core.writePrefs({ sync: { backup: { kind: 'folder', path: share } } });
  assert.equal((await core.syncNow(transport(a, {}))).status, 'ok');
  a.catchUp();
  assert.equal(partial(), undefined);
  const base = core.wholeBase(core.segments(a.host));
  assert.ok(base);
  assert.equal(core.baseHeader(base.file).from, seg.name, 'the base never covers history before this index read it');
  assert.ok(!logLines(a).some((r) => JSON.stringify(r).includes('marmoset')));
});

test('records: a backup copy keeps the missing partial log waiting until it is read back', { skip }, async (t) => {
  const { a, seg, body, partial } = lostPartial(t);
  const share = path.join(a.home, 'backup');
  const key = core.newSyncKey();
  core.writeSyncKey(key);
  assert.equal(core.initBackupFolder(share, key).check.ok, true);
  core.writePrefs({ sync: { backup: { kind: 'folder', path: share } } });
  fs.writeFileSync(seg.file, body);
  assert.equal((await core.syncNow(transport(a, {}))).status, 'ok');
  fs.rmSync(seg.file);
  core.writePrefs({ sync: { backup: { kind: 'folder', path: share }, families: { 'oak-records': 'off' } } });
  await core.syncNow(transport(a, {}));
  a.catchUp();
  assert.equal(partial(), true, 'the backup listed the missing segment; no compaction over it');
});

test('records: a complete survey with no saved machines or backup releases the missing partial log', { skip }, async (t) => {
  const { a, partial } = lostPartial(t);
  await core.syncNow(transport(a, {}));
  a.catchUp();
  assert.equal(partial(), undefined);
  assert.ok(!logLines(a).some((r) => JSON.stringify(r).includes('marmoset')));
});

// A log is written again only from an index that read it whole and holds what it published. A new index file reads this
// machine's own log back over several catch-ups: a log lost before it read the rest holds what only the log had (the
// archive among it), which a base written from the index would cover on every machine. It is left for oak sync to bring
// back, and `oak doctor` asks no listing to write it. Another index file over this store (the store reached by another
// path) compacting the log is no loss either: this one reads that base. And a log lost once every session was deleted is
// nothing to write: the catch-ups after settle.
test('records: a log lost while a new index file was reading it back is left for oak sync; another index file\'s compaction, or a log of no sessions, is no loss', { skip }, (t) => {
  const ms = machines(t, ['a', 'b']);
  const { a, b } = ms;
  // More usage than one transaction reads, then a session archived after it: the end of the log holds the archive.
  const big = [userAsk('a long session')];
  for (let i = 0; i < 6000; i++) big.push(turn(`big-${i}`, 500, { input_tokens: 1, output_tokens: 1 }));
  a.transcript('s-big', big);
  a.transcript('s-tmp', [userAsk('deleted later'), turn('t1', 450, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  const gone = a.transcript('s-arch', [userAsk('the wombat archive'), turn('w1', 400, { input_tokens: 5, output_tokens: 1 })]);
  a.catchUp();
  fs.rmSync(gone);
  a.catchUp();
  ms.carry(a, b);
  b.catchUp();
  const archive = (m) => m.db((db) => rows(db, 'SELECT session_id FROM sessions WHERE machine_id = ? AND archived_ms IS NOT NULL', a.host).map((r) => r.session_id));
  assert.deepEqual(archive(b), ['s-arch'], 'control: b holds a\'s archive');
  // A new index file on a reads its log back, and stops part way; then the log is lost.
  a.use();
  for (const n of fs.readdirSync(core.indexDir())) fs.rmSync(path.join(core.indexDir(), n), { force: true });
  const cut = core.useIndex({ budgetMs: 0, inlineBytes: Infinity });
  assert.ok(cut.ok, cut.reason);
  try {
    assert.equal(cut.catchUp.caughtUp, false, 'control: read part way');
  } finally {
    cut.close();
  }
  assert.deepEqual(archive(a), [], 'control: the archive is not read back yet');
  const lost = path.join(a.home, 'lost-log');
  fs.renameSync(path.join(a.records(), a.host), lost);
  a.use();
  assert.equal(core.ownRecordLogGone(), false, 'oak doctor asks no listing to write it again');
  a.catchUp();
  a.catchUp();
  assert.ok(!core.segments(a.host).some((s) => s.base), 'no base written from what the index read of it');
  // Nor by the compaction a delete here asks for, which waits until the index has read the log whole.
  a.use();
  core.deleteSession('s-tmp');
  a.catchUp();
  assert.ok(!core.segments(a.host).some((s) => s.base), 'nor by the compaction a delete asks for');
  ms.carry(a, b);
  b.catchUp();
  assert.deepEqual(archive(b), ['s-arch'], 'b keeps the archive');
  // oak sync brings the log back: the index reads the rest, the archive with it.
  fs.cpSync(lost, path.join(a.records(), a.host), { recursive: true });
  a.catchUp();
  assert.deepEqual(archive(a), ['s-arch'], 'read back');
  // Read whole now: a log lost from here on is written again from the index.
  fs.rmSync(path.join(a.records(), a.host), { recursive: true, force: true });
  a.use();
  assert.equal(core.ownRecordLogGone(), true, 'oak doctor says it is lost');
  a.catchUp();
  assert.ok(core.segments(a.host).some((s) => s.base), 'and the next catch-up writes it again');
  // Another index file over this store compacts the log: this one reads that base, and writes none of its own.
  a.use();
  const other = core.openIndex(path.join(core.indexDir(), 'index-v1-0000000000000000.sqlite'));
  assert.ok(other.ok, other.reason);
  try {
    core.catchUp(other.db, { budgetMs: Infinity, inlineBytes: Infinity });
    other.db.prepare("INSERT INTO meta (key, value) VALUES ('records_compact', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
    core.catchUp(other.db, { budgetMs: Infinity, inlineBytes: Infinity });
  } finally {
    other.close();
  }
  const bases = () => core.segments(a.host).filter((s) => s.base).map((s) => s.name);
  const theirs = bases();
  assert.equal(theirs.length, 1, 'control: the other index file compacted the log');
  a.use();
  assert.equal(core.ownRecordLogGone(), false, 'no loss: a newer base is there');
  a.catchUp();
  assert.ok(settles(a), 'and the next catch-up has nothing to do');
  assert.deepEqual(bases(), theirs, 'no base of its own over it');
  // A log lost once every session was deleted: nothing to write, and the catch-ups settle.
  a.use();
  for (const id of ['s-big', 's-arch']) core.deleteSession(id);
  assert.equal(a.db((db) => one(db, 'SELECT count(*) AS n FROM sessions WHERE machine_id = ? AND synced_ms IS NULL', a.host).n), 0, 'control: no session of this machine\'s left');
  a.catchUp();
  fs.rmSync(path.join(a.records(), a.host), { recursive: true, force: true });
  a.catchUp();
  assert.ok(settles(a), 'a log of no sessions lost: the next catch-up has nothing to do');
});

// A log is read whole only once every segment the index read is here and read to its end, under the base it read: oak
// sync brings a lost log back file by file, and a large file in parts, so a part or a later segment can land first.
// Nothing is written from the index before then, so no base covers what it has not read; and another machine's base read
// in part and then gone forgets none of that machine's sessions in the other index files.
const okapiAsks = (m) => m.db((db) => one(db, "SELECT count(*) AS n FROM prompts_fts WHERE prompts_fts MATCH 'okapi'").n);
const okapiUsage = (m) => m.db((db) => one(db, "SELECT count(*) AS n FROM usage_messages WHERE message_id = 'arch-1'").n);

/** a's log: a base (s-big's 6,000 asks, then an archived session's) and a later segment, which b holds whole. A new
 *  index file on a reads it back in part, and then the log is lost (kept aside in `lost`). */
function readBackInPartThenLost(t) {
  const ms = machines(t, ['a', 'b']);
  const { a, b } = ms;
  const big = [];
  for (let i = 0; i < 6000; i++) big.push(userAsk(`ask ${i}`, 900), turn(`big-${i}`, 899, { input_tokens: 1, output_tokens: 1 }));
  a.transcript('s-big', big);
  a.catchUp();
  const arch = a.transcript('s-zarch', [userAsk('the okapi archive must survive', 800), turn('arch-1', 799, { input_tokens: 7, output_tokens: 1 })]);
  a.catchUp();
  fs.rmSync(arch);
  a.catchUp();
  a.transcript('s-tmp', [userAsk('a throwaway', 700), turn('tmp-1', 699, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  a.use();
  core.deleteSession('s-tmp');
  a.catchUp();
  a.transcript('s-later', [userAsk('a later session', 600), turn('later-1', 599, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  a.use();
  const segs = core.segments(a.host);
  assert.ok(segs.length === 2 && segs[0].base && !segs[1].base, 'control: a base and a later segment');
  ms.carry(a, b);
  b.catchUp();
  assert.deepEqual([okapiAsks(b), okapiUsage(b)], [1, 1], 'control: b holds the archived session\'s ask and usage');
  a.use();
  for (const n of fs.readdirSync(core.indexDir())) fs.rmSync(path.join(core.indexDir(), n), { force: true });
  const cut = core.useIndex({ budgetMs: 0, inlineBytes: Infinity });
  assert.ok(cut.ok, cut.reason);
  try {
    assert.equal(cut.catchUp.caughtUp, false, 'control: read part way');
  } finally {
    cut.close();
  }
  assert.equal(okapiAsks(a), 0, 'control: the archived ask is in the part not read yet');
  const lost = path.join(a.home, 'lost-log');
  fs.renameSync(path.join(a.records(), a.host), lost);
  a.catchUp();
  return { a, b, segs, lost };
}

/** oak sync's pull of a's log into b: what b lacks of it, then b's catch-up. */
function pullInto(a, b) {
  a.use();
  const segs = core.segments(a.host);
  b.use();
  for (const s of segs) if (!fs.existsSync(path.join(b.records(), a.host, s.name))) fs.copyFileSync(s.file, path.join(b.records(), a.host, s.name));
  b.catchUp();
}

test('records: a log brought back in parts is read whole before anything is written from the index: its base landing in part', { skip }, (t) => {
  const { a, b, segs, lost } = readBackInPartThenLost(t);
  fs.mkdirSync(path.join(a.records(), a.host), { recursive: true });
  fs.copyFileSync(path.join(lost, segs[1].name), path.join(a.records(), a.host, segs[1].name));
  const whole = fs.readFileSync(path.join(lost, segs[0].name));
  fs.writeFileSync(path.join(a.records(), a.host, segs[0].name), whole.subarray(0, whole.indexOf(0x0a, Math.floor(whole.length / 2)) + 1));
  a.catchUp();
  pullInto(a, b);
  assert.deepEqual([okapiAsks(b), okapiUsage(b)], [1, 1], 'b keeps the archived session\'s ask and usage');
  fs.writeFileSync(path.join(a.records(), a.host, segs[0].name), whole);
  a.catchUp();
  assert.deepEqual([okapiAsks(a), okapiUsage(a)], [1, 1], 'a reads them back once the base is whole');
  pullInto(a, b);
  assert.deepEqual([okapiAsks(b), okapiUsage(b)], [1, 1], 'and b still holds them');
});

test('records: a log brought back in parts is read whole before anything is written from the index: a later segment first', { skip }, (t) => {
  const { a, b, segs, lost } = readBackInPartThenLost(t);
  fs.mkdirSync(path.join(a.records(), a.host), { recursive: true });
  fs.copyFileSync(path.join(lost, segs[1].name), path.join(a.records(), a.host, segs[1].name));
  a.catchUp();
  a.catchUp();
  pullInto(a, b);
  assert.deepEqual([okapiAsks(b), okapiUsage(b)], [1, 1], 'b keeps the archived session\'s ask and usage');
  fs.copyFileSync(path.join(lost, segs[0].name), path.join(a.records(), a.host, segs[0].name));
  a.catchUp();
  assert.deepEqual([okapiAsks(a), okapiUsage(a)], [1, 1], 'a reads them back once the base is here');
});

test('records: a compaction that waits for a log read in part settles the catch-ups meanwhile, and runs once the log is whole', { skip }, (t) => {
  const { a, lost, segs } = readBackInPartThenLost(t);
  a.use();
  core.deleteSession('s-later');
  a.catchUp();
  assert.ok(settles(a), 'the next catch-up has nothing to do while the log is not here whole');
  assert.ok(!core.segments(a.host).some((s) => s.base), 'and no base is written meanwhile');
  for (const s of segs) fs.copyFileSync(path.join(lost, s.name), path.join(a.records(), a.host, s.name));
  a.catchUp();
  a.catchUp();
  assert.deepEqual([okapiAsks(a), okapiUsage(a)], [1, 1], 'read whole');
  a.use();
  assert.ok(core.segments(a.host).some((s) => s.base) && !logLines(a).some((r) => r.t === 'sessions' && r.r.session_id === 's-later'), 'then the delete\'s compaction runs');
});

/** A base of `host`'s log written into `m`'s records folder by hand, as writeBase lays one out. */
function handBase(m, host, lines, name) {
  const body = lines.map((l) => l + '\n').join('');
  const head = JSON.stringify({ t: 'base', bytes: Buffer.byteLength(body), at: Date.now(), v: 1, label: 'a', platform: 'linux', covers: null });
  const file = path.join(m.records(), host, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, head.padEnd(255, ' ') + '\n' + body);
  return file;
}

test('records: another machine\'s base read in part and then gone forgets none of its sessions in the other index files', { skip }, (t) => {
  const ms = machines(t, ['a', 'b']);
  const { a, b } = ms;
  for (const id of ['s-1', 's-2', 's-3']) a.transcript(id, [userAsk(`the ${id} kinkajou`), turn(`m-${id}`, 300, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  ms.carry(a, b);
  b.catchUp();
  b.use();
  const old = path.join(core.indexDir(), `index-v0-${core.storeKey()}.sqlite`);
  fs.copyFileSync(core.indexFile(), old);
  const oldHolds = () => {
    const d = new (require('node:sqlite').DatabaseSync)(old);
    try {
      return d.prepare('SELECT session_id FROM sessions WHERE machine_id = ? ORDER BY session_id').all(a.host).map((r) => r.session_id);
    } finally {
      d.close();
    }
  };
  const recs = logLines(a).filter((r) => r.t === 'sessions');
  const tmpl = recs.find((r) => r.r.session_id === 's-1');
  const lines = [];
  for (let i = 0; i < 6000; i++) lines.push(JSON.stringify({ t: 'sessions', r: { ...tmpl.r, session_id: `x-big-${i}`, title: `big ${i}` } }));
  for (const r of recs) lines.push(JSON.stringify(r));
  const name = `${String(Date.now() + 5000).padStart(13, '0')}-deadbeef-base.jsonl`;
  const file = handBase(b, a.host, lines, name);
  b.use();
  const cut = core.useIndex({ budgetMs: 0, inlineBytes: Infinity });
  assert.ok(cut.ok, cut.reason);
  try {
    assert.equal(cut.catchUp.caughtUp, false, 'control: the base read part way');
  } finally {
    cut.close();
  }
  fs.rmSync(file);
  b.db((db) => db.prepare("UPDATE meta SET value = '1' WHERE key = 'caught_up_ms'").run()); // past the quiet window
  b.catchUp();
  assert.deepEqual(oldHolds(), ['s-1', 's-2', 's-3'], 'a never forgot them: the other index file keeps them');
  handBase(b, a.host, lines, name);
  b.catchUp();
  assert.deepEqual(b.db((db) => rows(db, "SELECT session_id FROM sessions WHERE machine_id = ? AND session_id NOT LIKE 'x-big-%' ORDER BY session_id", a.host).map((r) => r.session_id)), ['s-1', 's-2', 's-3'], 'read back once the base is here');
});

test('records: a read of this machine\'s own log that stopped on its last record is whole: a delete\'s compaction runs and the catch-ups settle', { skip }, (t) => {
  const { a } = machines(t, ['a']);
  a.transcript('s-1', [userAsk('one'), turn('e1', 300, { input_tokens: 1, output_tokens: 1 })]);
  a.transcript('s-2', [userAsk('two'), turn('e2', 200, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  // As the commit a catch-up's budget runs out on, right after the log's last record, leaves it: every segment read to
  // its end, and partial. Written here as that commit writes it.
  a.db((db) => {
    const st = require('../dist/index/ingest').logState(db, a.host);
    assert.ok(st && Object.entries(st.read).every(([k, v]) => v === fs.statSync(path.join(a.records(), a.host, k)).size), 'control: read to its end');
    db.prepare('UPDATE ingest_state SET state = ? WHERE source = ?').run(JSON.stringify({ ...st, partial: true }), `records:${a.host}`);
  });
  a.catchUp();
  assert.equal(a.db((db) => require('../dist/index/ingest').logState(db, a.host).partial), undefined, 'the next catch-up records it read whole');
  a.use();
  core.deleteSession('s-1');
  a.catchUp();
  a.catchUp();
  assert.ok(!logLines(a).some((r) => JSON.stringify(r).includes('reply e1')), 'the deleted session\'s text is gone from the log');
  assert.ok(settles(a), 'and the next catch-up has nothing to do');
});

test('records: a growing answer is published again at most once a minute, and what waited is published by a later catch-up', { skip }, (t) => {
  const { a } = machines(t, ['a']);
  const file = a.transcript('s-grow', [userAsk('a long answer'), turn('gr-1', 100, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  const published = () => logLines(a).filter((r) => r.t === 'prompts' && r.r.session_id === 's-grow').map((r) => r.r.response);
  assert.equal(published().length, 1);
  for (let i = 2; i <= 4; i++) {
    fs.appendFileSync(file, JSON.stringify({ cwd: a.work, sessionId: 's-grow', ...turn(`gr-${i}`, 100 - i, { input_tokens: 1, output_tokens: 1 }) }) + '\n');
    a.catchUp();
  }
  assert.equal(published().length, 1, 'three more catch-ups within the minute publish the growing answer no more');
  // A minute later, a catch-up with nothing new to read publishes what waited.
  a.use();
  const o = core.openIndex();
  assert.ok(Number(o.db.prepare("UPDATE ingest_state SET updated_ms = updated_ms - ? WHERE kind = 'pub-waiting'").run(core.PUBLISH_MS + 1000).changes) > 0, 'it waits');
  o.close();
  a.catchUp();
  assert.equal(published().length, 2);
  assert.match(published()[1], /reply gr-4/, 'the answer as it stands');
});

test('records: the demo simulator\'s sessions stay in this machine\'s index and are never published', { skip }, (t) => {
  const { a } = machines(t, ['a']);
  a.transcript('demo-0a1b2c3d', [userAsk('a demo ask'), turn('d1', 60, { input_tokens: 5, output_tokens: 1 })]);
  a.transcript('s-real', [userAsk('a real ask'), turn('r1', 60, { input_tokens: 5, output_tokens: 1 })]);
  a.catchUp();
  const sessionOf = (r) => r.r?.session_id ?? r.d?.session_id ?? r.clear ?? r.s;
  const sessions = new Set(logLines(a).map(sessionOf).filter(Boolean));
  assert.ok(sessions.has('s-real'), 'control: the real session is published');
  assert.ok(!sessions.has('demo-0a1b2c3d'), 'the demo session is not');
  assert.equal(a.db((db) => one(db, "SELECT count(*) AS n FROM sessions WHERE session_id = 'demo-0a1b2c3d'").n), 1, 'though this machine\'s index lists it');
  // Another machine's log from an earlier build, whose compaction wrote its demo into a base: none of it is applied here.
  const host = '0123456789ab';
  const at = Date.now();
  const row = (id, session) => JSON.stringify({ t: 'usage_messages', r: { message_id: id, agent: 'claude', session_id: session, account: null, model: 'claude-opus-4-8', ts: at - 1000, input: 1, output: 1, cache_create: 0, cache_read: 0, cost: 0, top_tier: 0 } });
  fs.mkdirSync(path.join(a.records(), host), { recursive: true });
  fs.writeFileSync(path.join(a.records(), host, `${at}-0a0b0c0d.jsonl`), [JSON.stringify({ t: 'batch', at, v: 1, label: 'older', platform: 'linux' }), row('far-real', 's-far'), row('far-demo', 'demo-0f0e0d0c')].join('\n') + '\n');
  a.catchUp();
  assert.deepEqual(a.db((db) => rows(db, 'SELECT message_id FROM usage_messages WHERE machine_id = ? ORDER BY message_id', host).map((r) => r.message_id)), ['far-real']);
});

test('records: a catch-up out of time partway through another machine\'s log says it is not caught up, and the next reads on from there', { skip }, (t) => {
  const { b } = machines(t, ['b']);
  b.transcript('s-b', [userAsk('b'), turn('b1', 60, { input_tokens: 1, output_tokens: 1 })]);
  b.catchUp();
  // A log of 6,000 rows, more than one transaction holds, from a machine oak sync brought here.
  const host = '0123456789ab';
  const at = Date.now();
  const lines = [JSON.stringify({ t: 'batch', at, v: 1, label: 'far', platform: 'linux' })];
  for (let i = 0; i < 6000; i++) {
    lines.push(JSON.stringify({ t: 'usage_messages', r: { message_id: `far-${i}`, agent: 'claude', session_id: 's-far', account: null, model: 'claude-opus-4-8', ts: at - 1000, input: 1, output: 1, cache_create: 0, cache_read: 0, cost: 0, top_tier: 0 } }));
  }
  fs.mkdirSync(path.join(b.records(), host), { recursive: true });
  fs.writeFileSync(path.join(b.records(), host, `${at}-0a0b0c0d.jsonl`), lines.join('\n') + '\n');
  b.use();
  const ix = core.useIndex({ budgetMs: 0, inlineBytes: Infinity });
  assert.ok(ix.ok, ix.reason);
  try {
    assert.equal(ix.catchUp.caughtUp, false, 'out of time partway: not caught up');
    const n = one(ix.db, 'SELECT count(*) AS n FROM usage_messages WHERE machine_id = ?', host).n;
    assert.ok(n > 0 && n < 6000, `partway: ${n}`);
  } finally {
    ix.close();
  }
  b.catchUp();
  assert.equal(b.db((db) => one(db, 'SELECT count(*) AS n FROM usage_messages WHERE machine_id = ?', host).n), 6000, 'the rest, from where it stopped');
});

test('records: a log written in a newer format is applied no further, and the catch-up says to update', { skip }, (t) => {
  const ms = machines(t, ['a', 'b']);
  const { a, b } = ms;
  a.transcript('s-n', [userAsk('n'), turn('n1', 10, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  ms.carry(a, b);
  const seg = core.segments(a.host)[0];
  b.use();
  fs.appendFileSync(path.join(b.records(), a.host, seg.name), JSON.stringify({ t: 'batch', at: Date.now(), v: 99 }) + '\n' + JSON.stringify({ t: 'sessions', r: { session_id: 'from-the-future' } }) + '\n');
  const ix = core.useIndex({ budgetMs: Infinity, inlineBytes: Infinity });
  try {
    assert.ok(ix.catchUp.problems.some((p) => /newer format.*update OAK/.test(p)), JSON.stringify(ix.catchUp.problems));
    assert.equal(one(ix.db, "SELECT count(*) AS n FROM sessions WHERE session_id = 'from-the-future'").n, 0);
    assert.equal(one(ix.db, "SELECT count(*) AS n FROM sessions WHERE session_id = 's-n'").n, 1, 'what came before it stands');
  } finally {
    ix.close();
  }
});

/** oak sync's transport to the machines `to` names by label, for a run on `from`: each answers in its own home, its
 *  fetch run to its end before its bytes are read, so no two homes interleave (as sync.test.js's). */
function transport(from, to) {
  const at = async (m, fn) => {
    m.use();
    try {
      return await fn();
    } finally {
      from.use();
    }
  };
  return {
    machines: async () => Object.keys(to).map((label, i) => ({ id: `m${i}`, label, target: label, session: 'default', enabled: true, selected: false })),
    inventory: async (target, user) => ({ text: JSON.stringify(await at(to[target], () => {
      require('../dist/index/records').sealRecords(to[target].host); // the publishing inventory closes its local append
      return core.syncInventory({ user });
    })) }),
    fetch: (target, user, request) => {
      const chunks = [];
      const done = at(to[target], () => core.serveSyncFetch(request, user, async (b) => { chunks.push(Buffer.from(b)); })).then(() => null);
      return { stream: (async function* () { await done; yield* chunks; })(), done };
    },
  };
}

test('records: oak sync carries a machine\'s log to another as it grows and a base in place of what it covers, lists its sessions from there, and gives a machine set up again its own log back', { skip }, async (t) => {
  const { a, b } = machines(t, ['a', 'b']);
  const sync = async (from, to) => {
    from.use();
    return core.syncNow(transport(from, to));
  };
  const hoursAgo = (n) => new Date(Date.now() - n * 3600_000);
  const f1 = a.transcript('s-1', [userAsk('first', 4 * 3600), turn('k1', 4 * 3600, { input_tokens: 10, output_tokens: 1 })]);
  const f2 = a.transcript('s-2', [userAsk('second', 4 * 3600), turn('k2', 4 * 3600, { input_tokens: 20, output_tokens: 2 })]);
  // One in another workspace, the latest; and one in which nothing happened, which a's own listing leaves out.
  const fx = a.transcript('s-x', [userAsk('elsewhere', 4 * 3600), turn('kx', 4 * 3600, { input_tokens: 1, output_tokens: 1 })], path.join(a.home, 'other'));
  const f0 = a.transcript('s-empty', [userAsk('nothing came of it', 4 * 3600)]);
  for (const [f, h] of [[f1, 3], [f2, 3.2], [fx, 2.5], [f0, 3]]) fs.utimesSync(f, hoursAgo(h), hoursAgo(h));
  a.catchUp();
  /** A machine's log as a store holds it: each segment's name and bytes. */
  const log = (m, host) => core.segments(host, m.records()).map((s) => [s.name, fs.readFileSync(s.file, 'utf8')]);
  const pulled = (r) => r.done.filter((d) => d.family === 'oak-records');
  let r = await sync(b, { a });
  assert.equal(r.status, 'ok', JSON.stringify(r.machines));
  assert.ok(log(a, a.host).length > 0);
  assert.deepEqual(log(b, a.host), log(a, a.host), 'a\'s log, byte for byte');
  b.catchUp();
  b.db((db) => {
    assert.deepEqual(rows(db, 'SELECT session_id, origin FROM sessions WHERE machine_id = ? ORDER BY session_id', a.host).map((x) => [x.session_id, x.origin]),
      [['s-1', 'synced'], ['s-2', 'synced'], ['s-empty', 'synced'], ['s-x', 'synced']]);
    assert.equal(one(db, 'SELECT count(*) AS n FROM usage_messages WHERE machine_id = ?', a.host).n, 3);
  });
  // oak sync reached a just now, and none of its sessions is running: they are listed from here, saying how fresh.
  b.use();
  const listed = core.indexedMachineSessions('a');
  assert.ok(listed, 'listed from the index');
  assert.deepEqual([listed.fromIndex, listed.host, listed.sessions.map((s) => s.id)], [true, a.host, ['s-x', 's-1', 's-2']], 'as a lists them: by workspace, latest first, without s-empty');
  assert.equal(listed.syncedAt, core.readSyncStatusFile().at, 'as of the oak sync run that read it');
  assert.equal(core.indexedMachineSessions('a', Date.now() + core.MACHINE_SESSIONS_FRESH_MS + 1000), null, 'not once that run is older than two runs');
  assert.equal(core.indexedMachineSessions('nobody'), null, 'nor for a machine oak sync does not reach');
  // a's session goes on: its segment grows, and only what it grew by is pulled. (Its row, which moved only in time, is
  // published by the catch-up a minute on: the first was a moment ago.)
  fs.appendFileSync(f1, JSON.stringify({ cwd: a.work, sessionId: 's-1', ...turn('k3', 60, { input_tokens: 30, output_tokens: 3 }) }) + '\n');
  a.catchUp();
  a.db((db) => db.prepare("UPDATE ingest_state SET updated_ms = updated_ms - ? WHERE kind = 'pub-waiting'").run(core.PUBLISH_MS + 1000));
  a.catchUp();
  r = await sync(b, { a });
  assert.deepEqual(log(b, a.host), log(a, a.host), 'grown alike');
  assert.ok(pulled(r).length > 0 && pulled(r).every((d) => d.action === 'append' || d.action === 'create'), JSON.stringify(pulled(r)));
  b.catchUp();
  assert.equal(b.db((db) => one(db, "SELECT count(*) AS n FROM usage_messages WHERE message_id = 'k3'").n), 1);
  b.use();
  assert.equal(core.indexedMachineSessions('a'), null, 'a session there may be running: asked over ssh instead');
  // a forgets s-1 and compacts: b takes the base, lets go of what it covers, and forgets s-1 too.
  a.use();
  core.deleteSession('s-1');
  a.catchUp();
  assert.equal(core.segments(a.host, a.records()).length, 1);
  r = await sync(b, { a });
  b.catchUp();
  assert.deepEqual(log(b, a.host), log(a, a.host), 'only the base is left on either');
  b.db((db) => {
    assert.deepEqual(rows(db, 'SELECT session_id FROM sessions WHERE machine_id = ? ORDER BY session_id', a.host).map((x) => x.session_id), ['s-2', 's-empty', 's-x'], 's-1 forgotten');
    assert.deepEqual(rows(db, "SELECT session_id FROM usage_messages WHERE message_id IN ('k1', 'k3')").map((r) => r.session_id), ['', ''], 'its usage, without the session');
  });
  r = await sync(b, { a });
  assert.deepEqual(pulled(r), [], 'nothing to pull again');
  // a is set up again: no log, no index, and s-2's transcript gone. Its log comes back from b, and with it s-2.
  a.use();
  fs.rmSync(a.records(), { recursive: true, force: true });
  for (const n of fs.readdirSync(core.indexDir())) fs.rmSync(path.join(core.indexDir(), n), { force: true });
  fs.rmSync(f2);
  r = await sync(a, { b });
  assert.deepEqual(log(a, a.host), log(b, a.host), 'its own log, from b');
  a.catchUp();
  a.db((db) => {
    const s = one(db, "SELECT origin, archived_ms IS NOT NULL AS archived FROM sessions WHERE session_id = 's-2'");
    assert.deepEqual([s.origin, s.archived], ['local', 1], 'its own session, archived: its transcript is gone');
    assert.equal(one(db, "SELECT count(*) AS n FROM usage_messages WHERE message_id = 'k2'").n, 1, 'its usage with it');
  });
});

// A machine set up again (the same host name and home, so the same machine id) begins its record log anew: its store, the
// log among it, and its index are gone, while the machines it syncs with and the backup folder still hold the log it kept
// before. Nothing on the machine tells it from one set up for the first time, which compacts its log as ever. So a base
// covers only the history its writer read (its header says where that begins), and every machine reads the log kept
// before with the new one: none lets that log go or forgets a session it holds, whatever compacts the new log (a delete
// there, the catch-up that finds this machine's rows with no log of its own, its size), and whether or not oak sync was set
// up there yet. oak sync brings the log kept before back to the machine, whose next base then covers both.

/** oak sync's run on `from` with the machines `to`, over the in-process transport. */
async function syncRun(from, to) {
  from.use();
  const r = await core.syncNow(transport(from, to));
  assert.equal(r.status, 'ok', JSON.stringify(r.machines));
  return r;
}

/** The sessions of machine `host` that `m`'s index holds, the archived ones marked. */
const holds = (m, host) => m.db((db) => rows(db, 'SELECT session_id, archived_ms IS NOT NULL AS archived FROM sessions WHERE machine_id = ? ORDER BY session_id', host)
  .map((r) => (r.archived ? `${r.session_id} (archived)` : r.session_id)));

/** a, whose log b holds by an oak sync run of b's (s-arch archived on a, its transcript gone; s-live), set up again:
 *  its store and index gone, s-live's transcript kept, and a new session (s-new). `old`: a's log as b holds it. */
async function setUpAgain(t) {
  const ms = machines(t, ['a', 'b']);
  const { a, b } = ms;
  const gone = a.transcript('s-arch', [userAsk('the capybara archive must survive', 7200), turn('cap-1', 7100, { input_tokens: 5, output_tokens: 1 })]);
  a.transcript('s-live', [userAsk('a session from before', 3600), turn('live-1', 3500, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  fs.rmSync(gone);
  a.catchUp();
  await syncRun(b, { a });
  b.catchUp();
  assert.deepEqual(holds(b, a.host), ['s-arch (archived)', 's-live'], 'control: b holds a\'s archive');
  b.use();
  const old = core.segments(a.host).map((s) => s.name);
  a.use();
  fs.rmSync(path.join(a.home, '.claude', 'claude-observatory'), { recursive: true, force: true });
  fs.rmSync(core.indexDir(), { recursive: true, force: true });
  a.transcript('s-new', [userAsk('a session after it was set up again', 600), turn('new-1', 500, { input_tokens: 1, output_tokens: 1 })]);
  return { ...ms, old };
}

test('records: a machine set up again that compacts its new log for a delete there leaves every machine the log it kept before; oak sync set up there later brings it back, and its next base carries both', { skip }, async (t) => {
  const { a, b, old } = await setUpAgain(t);
  a.catchUp();
  a.use();
  core.deleteSession('s-new');
  a.catchUp();
  a.use();
  const [base, ...rest] = core.segments(a.host);
  assert.ok(base?.base && !rest.length, 'control: a compacted its new log into a base');
  // b takes the base, keeps the log a kept before, and reads it with the base.
  await syncRun(b, { a });
  b.catchUp();
  assert.deepEqual(holds(b, a.host), ['s-arch (archived)', 's-live'], 'b keeps a\'s archive');
  b.use();
  assert.deepEqual(core.segments(a.host).map((s) => s.name), [...old, base.name], 'and the log a kept before');
  assert.ok(core.baseHeader(base.file).from > old[old.length - 1], `which the base's history begins after: ${JSON.stringify(core.baseHeader(base.file))}`);
  // oak sync set up on a since (its first run, with b, which holds that log): the log comes back, and a its archive.
  await syncRun(a, { b });
  a.catchUp();
  assert.deepEqual(holds(a, a.host), ['s-arch (archived)', 's-live'], 'a has its archive back');
  // Read whole now: a's next base covers both logs and carries the archive; b lets both go for it, and keeps the archive.
  a.transcript('s-tmp', [userAsk('a throwaway', 300), turn('tmp-1', 200, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  a.use();
  core.deleteSession('s-tmp');
  a.catchUp();
  a.use();
  const next = core.segments(a.host);
  assert.ok(next.length === 1 && next[0].base, `one base: ${next.map((s) => s.name)}`);
  assert.ok(logLines(a).some((r) => r.t === 'prompts' && r.r.text.includes('capybara')), 'carrying the archive');
  await syncRun(b, { a });
  b.catchUp();
  b.use();
  assert.deepEqual(core.segments(a.host).map((s) => s.name), [next[0].name], 'b holds that base alone of a\'s log');
  assert.deepEqual(holds(b, a.host), ['s-arch (archived)', 's-live']);
});

// The catch-up that finds this machine's rows in the index and no log of its own writes the log as one base of what the
// index holds. On a machine set up again, the demo run first is one way there: its session is this machine's and never
// published, so the catch-up after it finds a row and no log.
test('records: a machine set up again whose first catch-up held only the demo writes its log from the index, and leaves every machine the log it kept before', { skip }, async (t) => {
  const { a, b } = await setUpAgain(t);
  a.use();
  const dir = core.projectDir(a.work);
  const aside = path.join(a.home, 'aside');
  fs.renameSync(dir, aside);
  a.transcript('demo-0123abcd', [userAsk('the demo', 900), turn('demo-1', 800, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  a.use();
  assert.deepEqual(core.segments(a.host), [], 'control: the demo publishes nothing');
  for (const n of fs.readdirSync(aside)) fs.renameSync(path.join(aside, n), path.join(dir, n));
  a.catchUp();
  a.use();
  assert.ok(core.segments(a.host).some((s) => s.base), 'control: the next catch-up wrote a base');
  await syncRun(b, { a });
  b.catchUp();
  assert.deepEqual(holds(b, a.host), ['s-arch (archived)', 's-live', 's-new'], 'b keeps a\'s archive');
});

// Another: the new log lost again (by hand, say) while the index holds what it published, which the catch-up writes again
// whole from the index.
test('records: a machine set up again whose new log is lost again writes it from the index, and leaves every machine the log it kept before', { skip }, async (t) => {
  const { a, b } = await setUpAgain(t);
  a.catchUp();
  fs.rmSync(path.join(a.records(), a.host), { recursive: true, force: true });
  a.catchUp();
  a.use();
  assert.ok(core.segments(a.host).some((s) => s.base), 'control: the catch-up wrote the log again as a base');
  await syncRun(b, { a });
  b.catchUp();
  assert.deepEqual(holds(b, a.host), ['s-arch (archived)', 's-live', 's-new'], 'b keeps a\'s archive');
});

test('records: a machine set up again whose new log passes 32 MB compacts it, with no delete, and leaves every machine the log it kept before', { skip }, async (t) => {
  const { a, b } = await setUpAgain(t);
  a.catchUp();
  // 900 asks of 8 KB, each answered in 32 KB: as much of each as the index keeps, over 32 MB of records in all.
  const answer = (id) => ({ type: 'assistant', timestamp: new Date(Date.now() - 300_000).toISOString(),
    message: { id, role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: `answer ${id} ${'y'.repeat(32 * 1024)}` }], usage: { input_tokens: 1, output_tokens: 1 } } });
  const big = [];
  for (let i = 0; i < 900; i++) big.push(userAsk(`ask ${i} ${'x'.repeat(8 * 1024)}`, 400), answer(`big-${i}`));
  a.transcript('s-big', big);
  assert.notEqual(a.db((db) => one(db, "SELECT value FROM meta WHERE key = 'records_compact'")?.value), '1', 'control: no compaction asked for');
  a.catchUp();
  a.use();
  const segs = core.segments(a.host);
  assert.ok(segs.length === 1 && segs[0].base && segs[0].size > 32 * 1024 * 1024, `control: compacted for its size: ${segs.map((s) => `${s.name} ${s.size}`)}`);
  await syncRun(b, { a });
  b.catchUp();
  assert.deepEqual(holds(b, a.host), ['s-arch (archived)', 's-big', 's-live', 's-new'], 'b keeps a\'s archive');
});

/** A run with no saved machine (a backup folder alone). */
const noMachine = { machines: async () => [], inventory: async () => ({ status: 'failed' }), fetch: () => { throw new Error('no machine'); } };

// The backup folder knows a machine by its host name and home: one set up again neither restores from its record there nor
// writes it until it takes the record over (`oak sync setup --restore`). The log it kept before stays in the folder
// meanwhile, and is restored once it does, though the machine compacted its new log before.
test('records: a machine set up again that compacts its new log before its backup folder is set up there again restores the log it kept before from the folder once it takes its record over', { skip }, async (t) => {
  const ms = machines(t, ['a']);
  const { a } = ms;
  const gone = a.transcript('s-arch', [userAsk('the capybara archive must survive', 7200), turn('cap-1', 7100, { input_tokens: 5, output_tokens: 1 })]);
  a.transcript('s-live', [userAsk('a session from before', 3600), turn('live-1', 3500, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  fs.rmSync(gone);
  a.catchUp();
  const share = path.join(ms.base, 'share');
  const key = core.newSyncKey();
  const folder = () => {
    a.use();
    core.writeSyncKey(key);
    assert.equal(core.initBackupFolder(share, key).check.ok, true);
    core.writePrefs({ ...core.readPrefs(), sync: { backup: { kind: 'folder', path: share } } });
  };
  folder();
  assert.equal((await core.syncNow(noMachine)).status, 'ok');
  a.use();
  const old = core.segments(a.host).map((s) => `records/${a.host}/${s.name}`);
  // a set up again: no store, no index; a session there, deleted, compacts its new log.
  fs.rmSync(path.join(a.home, '.claude', 'claude-observatory'), { recursive: true, force: true });
  fs.rmSync(core.indexDir(), { recursive: true, force: true });
  a.transcript('s-new', [userAsk('a session after it was set up again', 600), turn('new-1', 500, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  a.use();
  core.deleteSession('s-new');
  a.catchUp();
  a.use();
  assert.ok(core.segments(a.host).every((s) => s.base), 'control: a compacted its new log');
  // The folder and its key set up again: until a takes its record over, a run neither restores from it nor writes it.
  folder();
  const before = await core.syncNow(noMachine);
  assert.equal(before.machines.find((m) => m.label.startsWith('backup'))?.record, 'unclaimed', JSON.stringify(before.machines));
  assert.deepEqual(holds(a, a.host), ['s-live'], 'control: nothing restored');
  // Taken over: the next run restores that log, and a reads its archive from it.
  a.use();
  core.claimBackupRecord(core.openBackupFolder(share).folder, core.machineHostTag());
  assert.equal((await core.syncNow(noMachine)).status, 'ok');
  a.use();
  assert.ok(old.every((n) => fs.existsSync(path.join(a.home, '.claude', 'claude-observatory', n))), 'the log a kept before is back');
  a.catchUp();
  assert.deepEqual(holds(a, a.host), ['s-arch (archived)', 's-live'], 'and with it a\'s archive');
});

// A delete there reaches every machine as oak sync's tombstone, as ever. A session the log kept before holds, deleted on
// the machine set up again before that log came back, is in that log still, which every machine reads with the new one:
// it is forgotten again as soon as a log brings it back, and leaves both logs at the next compaction.
test('records: a session the log a machine kept before holds, deleted there after it was set up again, stays forgotten on every machine, and its text leaves both logs', { skip }, async (t) => {
  const { a, b } = await setUpAgain(t);
  a.catchUp();
  await syncRun(b, { a });
  b.catchUp();
  assert.deepEqual(holds(b, a.host), ['s-arch (archived)', 's-live', 's-new'], 'control: b reads a\'s new log too');
  a.use();
  core.deleteSession('s-live');
  a.catchUp();
  // As `oak __sync-inventory --publish` does before another machine's run reads a: a's deletes recorded for oak sync.
  a.use();
  core.recordSessionDeletes();
  await syncRun(b, { a });
  b.catchUp();
  assert.deepEqual(holds(b, a.host), ['s-arch (archived)', 's-new'], 'b forgets s-live, though the log a kept before holds it, and keeps the archive');
  // a reads the log it kept before back: s-live is forgotten again at once, and a compacts both logs into one base.
  await syncRun(a, { b });
  a.catchUp();
  assert.deepEqual(holds(a, a.host), ['s-arch (archived)', 's-new'], 'a forgets it again as it reads its old log back');
  const text = (m) => {
    m.use();
    return core.segments(a.host).map((s) => fs.readFileSync(s.file, 'utf8')).join('');
  };
  a.use();
  assert.equal(core.segments(a.host).length, 1, 'a compacted both logs into one base');
  assert.ok(!text(a).includes('a session from before') && text(a).includes('capybara'), 's-live\'s text left a\'s log, and the archive stayed');
  await syncRun(b, { a });
  b.catchUp();
  assert.ok(!text(b).includes('a session from before'), 'and b\'s copy');
  assert.deepEqual(holds(b, a.host), ['s-arch (archived)', 's-new']);
});

// oak sync lands a large file of a record log in parts, a run at a time. A part of the log a machine kept before that has
// landed but is not whole yet is not read, nor replaced by a base of the new log written meanwhile: it stays, and is read
// once the rest lands.
test('records: a base of the log a machine set up again began anew leaves a part of the log it kept before that is not whole yet', { skip }, async (t) => {
  const ms = machines(t, ['a', 'b']);
  const { a, b } = ms;
  // a's log before: a base (a delete compacted it), which b holds.
  const gone = a.transcript('s-arch', [userAsk('the capybara archive must survive', 7200), turn('cap-1', 7100, { input_tokens: 5, output_tokens: 1 })]);
  const tmp = a.transcript('s-tmp', [userAsk('a throwaway', 7000), turn('tmp-1', 6900, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  fs.rmSync(gone);
  a.catchUp();
  a.use();
  core.deleteSession('s-tmp');
  fs.rmSync(tmp);
  a.catchUp();
  ms.carry(a, b);
  b.use();
  const [oldBase] = core.segments(a.host);
  assert.ok(oldBase.base, 'control: b holds a\'s log before as a base');
  // a set up again, its new log compacted.
  a.use();
  fs.rmSync(path.join(a.home, '.claude', 'claude-observatory'), { recursive: true, force: true });
  fs.rmSync(core.indexDir(), { recursive: true, force: true });
  a.transcript('s-new', [userAsk('a session after it was set up again', 600), turn('new-1', 500, { input_tokens: 1, output_tokens: 1 })]);
  a.transcript('s-new2', [userAsk('another one', 500), turn('new-2', 400, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  a.use();
  core.deleteSession('s-new');
  a.catchUp();
  // The old base lands in part; then a delete compacts the new log again.
  const whole = fs.readFileSync(oldBase.file);
  const landed = path.join(a.records(), a.host, oldBase.name);
  fs.writeFileSync(landed, whole.subarray(0, whole.indexOf(0x0a, 300) + 1));
  a.use();
  core.deleteSession('s-new2');
  a.catchUp();
  a.use();
  assert.ok(fs.existsSync(landed), 'the part that landed stays');
  assert.equal(core.segments(a.host).filter((s) => s.base && s.name !== oldBase.name).length, 1, 'control: a compacted its new log again');
  // The rest lands: a reads its archive from it.
  fs.writeFileSync(landed, whole);
  a.catchUp();
  assert.deepEqual(holds(a, a.host), ['s-arch (archived)'], 'a reads its archive back');
});

// The surfaces list every machine's sessions: each other machine's under its label, with when oak sync last brought its
// records, as that machine lists them; a log that begins with a base (every log, once compacted) names its machine too.
// `oak query --machine` takes the label this machine saved another under, as every other verb's `--machine` takes it, as well
// as an id and `self`; a name the index holds no machine by is refused, where it answered no rows, exit 0.
test('records: a query\'s --machine takes a saved machine\'s label as its id, and `self` as this machine\'s, and refuses a name it holds no machine by', { skip }, (t) => {
  const ms = machines(t, ['a', 'b', 'c']);
  const { a, b, c } = ms;
  a.transcript('s-a', [userAsk('on the build box'), turn('ma', 300, { input_tokens: 40, output_tokens: 4 })]);
  b.transcript('s-b', [userAsk('here'), turn('mb', 200, { input_tokens: 9, output_tokens: 1 })]);
  a.catchUp();
  ms.carry(a, b);
  // b's last oak sync run reached a under the label b saved it under.
  b.use();
  const run = { status: 'ok', pulled: { files: 0, bytes: 0 }, conflicts: 0, pending: { files: 0, bytes: 0 }, errors: [] };
  fs.mkdirSync(path.join(core.rootDir(), 'sync'), { recursive: true });
  fs.writeFileSync(path.join(core.rootDir(), 'sync', 'status.json'), JSON.stringify({ at: Date.now(), durationMs: 5, status: 'ok', warnings: [], machines: [{ label: 'build-box', host: a.host, ...run }] }));
  b.catchUp();
  b.use();
  const ids = (q, p) => { const r = core.queryIndex(q, p); assert.ok(!r.error, JSON.stringify(r.error)); return r.rows.map((x) => x.id ?? x.key); };
  assert.deepEqual(ids('sessions', { machine: a.host }), ['s-a'], 'control: by its id');
  assert.deepEqual(ids('sessions', { machine: 'build-box' }), ['s-a'], 'by its saved label');
  assert.deepEqual(core.queryIndex('sessions', { machine: 'build-box' }).params, { machine: 'build-box', limit: 100, archived: false, all: false }, 'the answer names the machine as asked, and nothing else');
  assert.deepEqual(ids('sessions', { machine: 'self' }), ['s-b']);
  assert.deepEqual(ids('usage', { by: 'machine', since: '1d', machine: 'build-box' }), [a.host], 'usage by its label');
  assert.deepEqual(ids('usage', { by: 'machine', since: '1d', machine: 'self' }), [b.host], 'and `self` is this machine alone in usage too');
  const no = core.queryIndex('sessions', { machine: 'nowhere' });
  assert.equal(no.error?.code, 'bad_param');
  assert.match(no.error.message, /`oak query sync` lists each machine the database holds/);
  assert.ok(core.queryIndex('sync', {}).rows.some((r) => r.machine === a.host && r.saved_label === 'build-box'), 'which it does, by id and by that label');
  // The build box set up again: a new id, saved under the same label, which the old id keeps too. The label names both.
  c.transcript('s-c', [userAsk('on the new build box'), turn('mc', 100, { input_tokens: 5, output_tokens: 1 })]);
  c.catchUp();
  ms.carry(c, b);
  b.use();
  fs.writeFileSync(path.join(core.rootDir(), 'sync', 'status.json'), JSON.stringify({ at: Date.now() + 1, durationMs: 5, status: 'ok', warnings: [], machines: [{ label: 'build-box', host: c.host, ...run }] }));
  b.catchUp();
  b.use();
  assert.deepEqual(ids('sessions', { machine: 'build-box' }).sort(), ['s-a', 's-c'], 'a label saved under two ids names both');
});

test('records: every other machine\'s sessions are listed by label from its records, as it lists them, with when oak sync brought them; a base names its machine', { skip }, async (t) => {
  const { a, b } = machines(t, ['a', 'b']);
  // Records publish whole milliseconds; exercise a filesystem timestamp with a fractional millisecond.
  const hoursAgo = (n) => (Date.now() - n * 3600_000 + 0.375) / 1000;
  const f1 = a.transcript('s-1', [userAsk('first', 4 * 3600), turn('k1', 4 * 3600, { input_tokens: 10, output_tokens: 1 })]);
  const f2 = a.transcript('s-2', [userAsk('second', 4 * 3600), turn('k2', 4 * 3600, { input_tokens: 20, output_tokens: 2 })]);
  const fx = a.transcript('s-x', [userAsk('elsewhere', 4 * 3600), turn('kx', 4 * 3600, { input_tokens: 1, output_tokens: 1 })], path.join(a.home, 'other'));
  const f0 = a.transcript('s-empty', [userAsk('nothing came of it', 4 * 3600)]);
  a.use();
  core.ensureStore('s-1');
  core.appendLog('s-1', { ts: Date.now() - 4 * 3600_000, tool: 'Edit', file: path.join(a.work, 'one.ts'), beforeBlob: core.writeBlob('s-1', Buffer.from('a\n')), afterBlob: core.writeBlob('s-1', Buffer.from('b\nc\n')), status: 'pending' });
  for (const [f, h] of [[f1, 3], [f2, 3.2], [fx, 2.5], [f0, 3]]) fs.utimesSync(f, hoursAgo(h), hoursAgo(h));
  fs.utimesSync(core.logPath('s-1'), hoursAgo(3), hoursAgo(3));
  a.catchUp();
  // a compacts its log: what b receives begins with a base.
  a.db((db) => db.prepare("INSERT INTO meta (key, value) VALUES ('records_compact', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run());
  a.catchUp();
  assert.deepEqual(core.segments(a.host, a.records()).map((s) => s.base), [true], 'one base, nothing else');
  b.use();
  b.catchUp(); // b's index, from before the run
  assert.deepEqual(core.readMachineListings(), [], 'control: read in-process, nothing of a yet');
  const r = await core.syncNow(transport(b, { a }));
  assert.equal(r.status, 'ok', JSON.stringify(r.machines));
  // What the run brought is not in the index until a catch-up reads it: a reader that never catches it up has no answer
  // then (VS Code asks the CLI, which does), and lists a once one has.
  assert.equal(core.readMachineListings(), null);
  b.catchUp();
  assert.deepEqual(core.readMachineListings()?.map((m) => m.label), ['a']);
  const named = () => b.db((db) => one(db, 'SELECT label, synced_through_ms FROM machines WHERE machine_id = ?', a.host));
  assert.equal(named()?.label, 'a', 'the base\'s first line names the machine');
  assert.ok(named().synced_through_ms > 0, 'and says when it wrote it');
  // An index that read the base before this (no row for the machine) gets the row back at its next catch-up.
  b.db((db) => db.prepare('DELETE FROM machines WHERE machine_id = ?').run(a.host));
  b.catchUp();
  assert.equal(named()?.label, 'a', 'healed');
  // As a lists them, from somewhere none of its workspaces is: grouped by workspace, latest first, without s-empty.
  a.use();
  const own = core.sessionMeta(path.join(a.home, 'nowhere')).sessions;
  b.use();
  const listings = b.db((db) => core.machineListings(db));
  assert.equal(listings.length, 1);
  const [m] = listings;
  const status = core.readSyncStatusFile();
  assert.deepEqual([m.label, m.host, m.syncedAt, m.publishedAt], ['a', a.host, status.machines.find((x) => x.label === 'a').lastOkAt, named().synced_through_ms]);
  // A machine no oak sync run here names (relayed through another, or no longer saved): when its records last arrived in
  // this index, on this machine's clock (its log's files carry its own).
  const statusFile = path.join(core.syncDir(), 'status.json');
  const kept = fs.readFileSync(statusFile, 'utf8');
  fs.writeFileSync(statusFile, JSON.stringify({ ...JSON.parse(kept), machines: [] }));
  try {
    const arrived = b.db((db) => one(db, "SELECT max(synced_ms) AS t FROM sessions WHERE machine_id = ? AND origin = 'synced'", a.host).t);
    assert.ok(arrived > Date.now() - 600_000, 'positive control: the records arrived during this test');
    assert.equal(b.db((db) => core.machineListings(db))[0].syncedAt, arrived);
  } finally {
    fs.writeFileSync(statusFile, kept);
  }
  const shared = (row) => ({ id: row.id, workspace: row.workspace, title: row.title, lastActiveMs: row.lastActiveMs, lastTurnMs: row.lastTurnMs, liveMs: row.liveMs,
    edits: row.edits, pending: row.pending, files: row.files, added: row.added, removed: row.removed, lastEdit: row.lastEdit, tokens: row.tokens, cached: row.cached,
    durationMs: row.durationMs, storeBytes: row.storeBytes, model: row.model, effort: row.effort, agent: row.agent });
  assert.deepEqual(m.sessions.map(shared), own.map((row) => ({ ...shared(row), lastActiveMs: Math.round(row.lastActiveMs), liveMs: Math.round(row.liveMs) })), 'what a lists of itself, at the records’ whole-millisecond precision');
  assert.deepEqual(m.sessions.map((s) => s.id), ['s-x', 's-1', 's-2']);
  assert.ok(m.sessions.every((s) => s.origin === 'synced' && s.machine === 'a' && s.attention === null && !s.current && s.storePath === '' && s.activeWorkers.length === 0),
    'marked as another machine\'s, with nothing of what only that machine can see now');
  assert.deepEqual([m.sessions[1].edits, m.sessions[1].added, m.sessions[1].removed], [1, 2, 1], 'its edits as a counts them, line counts from its blobs');
  // The CLI's answer is the in-process reader's, byte for byte; with the index off there is none.
  fs.mkdirSync(b.work, { recursive: true });
  const cli = path.resolve(__dirname, '../../cli/dist/index.js');
  const run = (env = {}) => JSON.parse(cp.execFileSync(process.execPath, [cli, 'sessions', '--json', '--synced'], { cwd: b.work, encoding: 'utf8', env: { ...process.env, OAK_NO_BACKGROUND: '1', ...env } }));
  const out = run();
  assert.equal(JSON.stringify(out.machines), JSON.stringify(core.readMachineListings()), 'in-process and CLI agree byte for byte');
  assert.equal(JSON.stringify(out.machines), JSON.stringify(listings));
  assert.deepEqual(run({ OAK_INDEX: 'off' }).machines, []);
  assert.equal(Object.hasOwn(JSON.parse(cp.execFileSync(process.execPath, [cli, 'sessions', '--json'], { cwd: b.work, encoding: 'utf8', env: { ...process.env, OAK_NO_BACKGROUND: '1' } })), 'machines'), false, 'only when asked');
  // For a person: each machine after this one's, under its name, with when oak sync read it.
  const text = cp.execFileSync(process.execPath, [cli, 'sessions', '--synced'], { cwd: b.work, encoding: 'utf8', env: { ...process.env, OAK_NO_BACKGROUND: '1', NO_COLOR: '1' } });
  assert.match(text, new RegExp(`\\na · synced ${core.relTime(m.syncedAt).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · 3 sessions from its records\\n`), text);
  // Its conversations, searched from its records here, as a ranks them itself; the CLI answers `search --machine a` so,
  // with no ssh (there is no herdr here to reach a with).
  a.use();
  const ownSearch = core.searchConversations(a.work, 'second elsewhere first', {});
  const ownOne = core.searchConversations(a.work, 'second', {});
  b.use();
  const hits = (x) => x.hits.map((h) => [h.session, h.title, h.ts, h.prompt, h.snippet, h.where, h.score]);
  const fromRecords = core.indexedMachineSearch('a', 'second', {});
  assert.ok(fromRecords?.fromIndex && fromRecords.syncedAt === status.at, JSON.stringify(fromRecords));
  assert.deepEqual(hits(fromRecords), hits(ownOne), 'what a finds');
  assert.ok(ownOne.hits.length === 1 && ownSearch.hits.length === 0, 'control: one hit, and a query with none');
  assert.deepEqual(hits(core.indexedMachineSearch('a', 'second elsewhere first', {})), []);
  const searched = JSON.parse(cp.execFileSync(process.execPath, [cli, 'search', '--json', '--query=second', '--machine', 'a'], { cwd: b.work, encoding: 'utf8', env: { ...process.env, OAK_NO_BACKGROUND: '1' } }));
  assert.deepEqual(hits(searched), hits(ownOne));
  const said = cp.execFileSync(process.execPath, [cli, 'search', '--query=second', '--machine', 'a'], { cwd: b.work, encoding: 'utf8', env: { ...process.env, OAK_NO_BACKGROUND: '1', NO_COLOR: '1' } });
  assert.match(said, new RegExp(` · from a's records, synced ${core.relTime(status.at).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), said);
  assert.equal(core.indexedMachineSearch('nobody', 'second', {}), null, 'a machine oak sync does not reach is searched there');
  // The terminal app's warm worker lists a's sessions from here; one it cannot list so is no answer.
  const serve = cp.spawnSync(process.execPath, [cli, 'views', '--serve'], { cwd: b.work, encoding: 'utf8', env: { ...process.env, OAK_NO_BACKGROUND: '1' },
    input: [{ views: ['sessions'], args: ['--machine', 'a'] }, { views: ['sessions'], args: ['--machine', 'nobody'] }].map((x) => JSON.stringify(x)).join('\n') + '\n' });
  const [served, refused] = serve.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual([served.sessions.fromIndex, served.sessions.host, served.sessions.sessions.map((x) => x.id)], [true, a.host, ['s-x', 's-1', 's-2']]);
  assert.equal(refused.sessions, null, 'no answer, so the terminal app asks that machine over ssh');
  assert.equal(typeof refused.__problems.sessions, 'string', 'and the batch says the view failed');
});

test('records: the backup folder holds each machine\'s own log, sealed, and never the copies it keeps of the others\'', { skip }, async (t) => {
  const ms = machines(t, ['a', 'b']);
  const { a, b } = ms;
  a.transcript('s-a', [userAsk('the quokka ledger'), turn('fa', 60, { input_tokens: 1, output_tokens: 1 })]);
  b.transcript('s-b', [userAsk('the wombat ledger'), turn('fb', 60, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  b.catchUp();
  // a keeps b's log, as oak sync brought it.
  a.use();
  assert.equal((await core.syncNow(transport(a, { b }))).status, 'ok');
  assert.ok(core.segments(b.host, a.records()).length > 0, 'control: a holds b\'s log');
  a.use();
  const share = path.join(ms.base, 'share');
  const key = core.newSyncKey();
  core.writeSyncKey(key);
  assert.equal(core.initBackupFolder(share, key).check.ok, true);
  const user = core.localUserName();
  const role = () => core.resolveSyncBackup({ kind: 'folder', path: share }, { nodes: [], local: core.syncInventory({ user }) });
  await role().push({ me: core.syncInventory({ user }), placements: {}, now: Date.now() });
  const listed = (role().nodes.find((n) => n.inventory.host === a.host)?.inventory.families['oak-records'] ?? []).map((f) => f.name).sort();
  assert.deepEqual(listed, core.segments(a.host, a.records()).map((s) => `records/${a.host}/${s.name}`).sort(), 'a\'s own segments');
  // Sealed: no word of either log in the clear anywhere in the folder.
  const words = [];
  const walk = (dir) => {
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else words.push(fs.readFileSync(p).toString('latin1'));
    }
  };
  walk(share);
  assert.ok(!words.some((w) => w.includes('quokka') || w.includes('wombat')), 'nothing in the clear');
});

// --- the usage pull: machines that do not sync ------------------------------------------------------------------------

test('usage pull: a saved machine\'s own usage arrives page by page from where the last pull ended, into this machine\'s index', { skip }, async (t) => {
  const ms = machines(t, ['a', 'b']);
  const { a, b } = ms;
  for (const m of [a, b]) fs.writeFileSync(path.join(m.home, '.claude', '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'one-account' } }));
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(a.home, '.claude', 'statusline-last.json'), JSON.stringify({ v: 3, five_pct: 20, five_at: now - 30, five_reset: now + 3600, week_pct: 40, week_at: now - 30, week_reset: now + 86400 }));
  const file = a.transcript('s-a', [userAsk('a'), turn('p1', 500, { input_tokens: 100, output_tokens: 10 }), turn('p2', 400, { input_tokens: 200, output_tokens: 20 })]);
  b.transcript('s-b', [userAsk('b'), turn('q1', 300, { input_tokens: 5, output_tokens: 5 })]);
  b.catchUp();
  // Paging: a page of one row of each kind says there is more, and its cursor resumes after it.
  a.use();
  const o = core.openIndex();
  core.catchUp(o.db, {});
  const page1 = core.usageRecordsSince(o.db, null, 1);
  const page2 = core.usageRecordsSince(o.db, page1.cursor, 1);
  const page3 = core.usageRecordsSince(o.db, page2.cursor, 1);
  o.close();
  assert.deepEqual([page1.messages.map((m) => m.message_id), page1.more, page2.messages.map((m) => m.message_id), page3.more], [['p1'], true, ['p2'], false]);
  assert.ok(page1.messages.every((m) => !('machine_id' in m) && !('seq' in m)), 'rows as records: no machine, no write sequence');
  // The pull, as `oak usage --pull-machines` runs it, asking `oak __usage-records` there (here, in its home).
  const asked = [];
  const ask = async (m, how) => {
    asked.push(how);
    if (how.verb !== 'records') return null;
    a.use();
    const answer = JSON.stringify(core.indexUsageRecords(how.since));
    b.use();
    return answer;
  };
  b.use();
  // Always from b (a catch-up on a enters a).
  const refresh = () => (b.use(), core.refreshMachineUsage(async () => [{ label: 'build-a', target: 'me@a', enabled: true }], ask, { force: true }));
  let c = await refresh();
  assert.deepEqual(c.outcomes.map((x) => [x.label, x.status]), [['build-a', 'ok']]);
  assert.equal(c.machines[0].host, a.host, 'the machine is known by its host from now on');
  assert.equal(c.machines[0].brief.five.pct, 20, 'its latest readings, as the cache keeps them for a process with no index');
  b.db((db) => {
    assert.deepEqual(rows(db, 'SELECT message_id, machine_id FROM usage_messages ORDER BY message_id').map((r) => [r.message_id, r.machine_id]), [['p1', a.host], ['p2', a.host], ['q1', b.host]]);
    assert.equal(one(db, 'SELECT label FROM machines WHERE machine_id = ?', a.host).label, 'build-a', 'named as herdr names it');
    assert.equal(one(db, 'SELECT count(*) AS n FROM sessions WHERE machine_id = ?', a.host).n, 0, 'usage only: no session, no conversation text');
    const totals = core.usageTotals(db, { fiveReset: null, weekReset: null });
    assert.equal(totals.five.tokens, 110 + 220 + 10, 'both machines\' usage, each message once');
  });
  // The next pull asks from where this one ended, and gets only what is new.
  fs.appendFileSync(file, JSON.stringify({ cwd: a.work, sessionId: 's-a', ...turn('p3', 100, { input_tokens: 1, output_tokens: 1 }) }) + '\n');
  a.catchUp();
  asked.length = 0;
  c = await refresh();
  assert.equal(asked.length, 1);
  assert.ok(asked[0].since, 'from the cursor');
  b.use();
  assert.equal(b.db((db) => one(db, "SELECT count(*) AS n FROM usage_messages WHERE message_id = 'p3'").n), 1);
  // A session deleted there leaves this machine's index too, but for its usage, which the account was billed for: it
  // stays in the totals, without the session.
  a.use();
  core.deleteSession('s-a');
  a.catchUp();
  await refresh();
  assert.deepEqual(b.db((db) => rows(db, 'SELECT message_id, session_id FROM usage_messages WHERE machine_id = ? ORDER BY message_id', a.host).map((r) => [r.message_id, r.session_id])),
    [['p1', ''], ['p2', ''], ['p3', '']]);
});

// The simulator's turns (`oak demo`) were never billed: a usage pull sends none of their usage, while the demo runs or
// after, and a pull from an older OAK that sends some applies none of it.
test('usage pull: the demo\'s usage is neither sent nor applied', { skip }, (t) => {
  const { a, b } = machines(t, ['a', 'b']);
  a.transcript('s-real', [userAsk('real'), turn('pr', 60, { input_tokens: 1, output_tokens: 1 })]);
  a.transcript('demo-0123abcd', [userAsk('the demo'), turn('pd', 60, { input_tokens: 9, output_tokens: 9 })]);
  a.catchUp();
  const sent = a.db((db) => {
    assert.equal(one(db, "SELECT count(*) AS n FROM usage_messages WHERE session_id = 'demo-0123abcd'").n, 1, 'control: counted where it runs');
    return core.usageRecordsSince(db, null);
  });
  assert.deepEqual(sent.messages.map((m) => m.message_id), ['pr'], 'only the real session\'s usage is sent');
  // As an older OAK sends it.
  const older = { ...sent, messages: [...sent.messages, { ...sent.messages[0], message_id: 'pd', session_id: 'demo-0123abcd', input: 9, output: 9 }] };
  b.use();
  assert.ok(core.indexApplyUsageRecords(older, { label: 'a', skewMs: 0 }));
  assert.deepEqual(b.db((db) => rows(db, 'SELECT message_id FROM usage_messages WHERE machine_id = ? ORDER BY message_id', a.host).map((r) => r.message_id)), ['pr']);
});

// A message's usage that a forget left without its session (the account was billed for it) takes the session back from a
// snapshot at least as large that names it, as when the session is indexed again; a smaller one changes nothing, so a
// count never shrinks.
test('usage: a row a forget left without its session takes it back from a snapshot as large of its machine, never from a smaller one or another machine\'s', { skip }, (t) => {
  const { a, b, c } = machines(t, ['a', 'b', 'c']);
  a.transcript('s-x', [userAsk('x'), turn('ux', 60, { input_tokens: 100, output_tokens: 0 })]);
  a.catchUp();
  const sent = a.db((db) => core.usageRecordsSince(db, null));
  const msg = sent.messages.find((m) => m.message_id === 'ux');
  assert.ok(msg, 'control: sent');
  b.use();
  const page = (m) => ({ ...sent, messages: [m], spend: [], readings: [], accounts: [], purged: [] });
  const row = () => b.db((db) => one(db, "SELECT machine_id, session_id, input FROM usage_messages WHERE message_id = 'ux'"));
  assert.ok(core.indexApplyUsageRecords(page(msg), { label: 'a', skewMs: 0 }));
  assert.deepEqual({ ...row() }, { machine_id: a.host, session_id: 's-x', input: 100 }, 'control: applied');
  b.db((db) => db.prepare("UPDATE usage_messages SET session_id = '' WHERE message_id = 'ux'").run()); // as a forget leaves it
  assert.ok(core.indexApplyUsageRecords(page({ ...msg, input: 10 }), { label: 'a', skewMs: 0 }));
  assert.deepEqual({ ...row() }, { machine_id: a.host, session_id: '', input: 100 }, 'a smaller snapshot takes nothing');
  // The same message in a session of another machine's (which this one's log would then leave out, and a machine that
  // counted it from that log lose): it takes nothing either.
  assert.ok(core.indexApplyUsageRecords({ ...page({ ...msg, session_id: 's-c' }), host: c.host, hosts: [c.host] }, { label: 'c', skewMs: 0 }));
  assert.deepEqual({ ...row() }, { machine_id: a.host, session_id: '', input: 100 }, 'another machine\'s snapshot takes nothing');
  assert.ok(core.indexApplyUsageRecords(page(msg), { label: 'a', skewMs: 0 }));
  assert.deepEqual({ ...row() }, { machine_id: a.host, session_id: 's-x', input: 100 }, 'one as large of its machine takes the session back');
});

test('usage pull: each purge is stamped after every purge before it, so a pull that passed one never misses a later one', { skip }, (t) => {
  const { a } = machines(t, ['a']);
  a.transcript('s-real', [userAsk('real'), turn('pr', 60, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  const later = Date.now() + 3600_000;
  // A purge stamped later than this one will be (a catch-up that began earlier and wrote its purge first).
  a.db((db) => db.prepare("INSERT INTO tombstones (machine_id, session_id, deleted_ms, source, purged_ms) VALUES (?, 's-early', 1, 'deleted here', ?)").run(core.selfIds(db)[0], later));
  a.use();
  core.deleteSession('s-real');
  a.db((db) => {
    assert.ok(one(db, "SELECT purged_ms FROM tombstones WHERE session_id = 's-real'").purged_ms > later, 'after it');
    const page = core.usageRecordsSince(db, `${core.usageRecordsSince(db, null).cursor.split(':')[0]}:0:${later}`);
    assert.deepEqual(page.purged.map((p) => p.session), ['s-real'], 'a pull from past the earlier purge still sends it');
  });
});

test('usage pull: a machine whose record log oak sync keeps here, current, is not asked; an older OAK there gives its readings, and doctor says to update it', { skip }, async (t) => {
  const ms = machines(t, ['a', 'b']);
  const { a, b } = ms;
  a.transcript('s-a', [userAsk('a'), turn('s1', 100, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  const asked = [];
  const ask = async (m, how) => {
    asked.push(how.verb);
    if (how.verb === 'records') {
      a.use();
      const answer = JSON.stringify(core.indexUsageRecords(how.since));
      b.use();
      return answer;
    }
    return null;
  };
  b.use();
  const list = async () => [{ label: 'a', target: 'me@a', enabled: true }];
  await core.refreshMachineUsage(list, ask, { force: true });
  assert.deepEqual(asked, ['records']);
  // oak sync now brings a's records: no ssh is asked.
  ms.carry(a, b);
  asked.length = 0;
  b.use();
  const c = await core.refreshMachineUsage(list, ask, { force: true });
  assert.deepEqual(asked, [], 'not asked');
  assert.deepEqual(c.outcomes.map((x) => x.status), ['synced']);
  assert.match(core.diagnoseMachineUsage().map((x) => x.detail).join('\n'), /arrives with oak sync/);
  // An OAK there from before the usage pull refuses `__usage-records`, and answers `__usage-brief`.
  fs.rmSync(path.join(b.records(), a.host), { recursive: true, force: true });
  const now = Date.now();
  const brief = JSON.stringify({ brief: 1, account: 'a1b2c3d4e5f6', at: now, five: { pct: 7, reset: now + 3600_000, at: now, tok: null, total: null }, week: null, fable: null, month: null });
  const old = async (m, how) => (how.verb === 'records' ? { status: 'old-oak' } : brief);
  b.use();
  const c2 = await core.refreshMachineUsage(list, old, { force: true });
  assert.deepEqual([c2.outcomes[0].status, c2.outcomes[0].briefOnly, c2.machines[0].brief.five.pct], ['ok', true, 7]);
  // Its brief carries no figures of its own usage either (an OAK from before them): nothing of its usage can be counted
  // here, and the doctor says to update it.
  const row = core.diagnoseMachineUsage()[0];
  assert.deepEqual([row.level, /does not report its own usage/.test(row.detail), /oak update/.test(row.fix)], ['warn', true, true]);
});

// --- the status line ---------------------------------------------------------------------------------------------------

test('status line: with the account\'s totals from `oak usage` it reads no transcript and keeps no file map, and two machines of one account calibrate one budget', { skip: skip || (process.platform === 'win32' && 'POSIX shell') }, (t) => {
  for (const tool of ['jq', 'python3']) if (cp.spawnSync(tool, ['--version']).error) return t.skip(`${tool} is not installed`);
  const ms = machines(t, ['a', 'b']);
  const { a, b } = ms;
  const nowS = Math.floor(Date.now() / 1000);
  const limits = { five_hour: { used_percentage: 10, resets_at: nowS + 3600 }, seven_day: { used_percentage: 20, resets_at: nowS + 3 * 86400 } };
  const files = {};
  for (const [m, own] of [[a, 1000], [b, 3000]]) {
    fs.writeFileSync(path.join(m.home, '.claude', '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'one-account' } }));
    // The account's readout as the last render left it, and an account pull just made (so this render makes none).
    fs.writeFileSync(path.join(m.home, '.claude', 'statusline-last.json'), JSON.stringify({ v: 3, api_ts: nowS, five_pct: 10, five_at: nowS - 5, five_reset: nowS + 3600,
      week_pct: 20, week_at: nowS - 5, week_reset: nowS + 3 * 86400 }));
    // Its own turn, and one both machines hold (a transcript copied between them), counted once.
    files[m.name] = m.transcript(`s-${m.name}`, [userAsk('go', 120), turn(`own-${m.name}`, 90, { input_tokens: own, output_tokens: 10 }), turn('both', 60, { input_tokens: 500, output_tokens: 5 })]);
    m.catchUp();
  }
  ms.carry(a, b);
  ms.carry(b, a);
  a.catchUp();
  b.catchUp();
  const both = 1010 + 3010 + 505;
  // A transcript written since the last catch-up, which `oak usage` (its own session's files only) leaves to the next.
  a.transcript('s-later', [userAsk('later', 60), turn('later', 30, { input_tokens: 70_000, output_tokens: 0 })]);
  const cli = path.resolve(__dirname, '../../cli/dist/index.js');
  const state = (m) => JSON.parse(fs.readFileSync(path.join(m.home, '.claude', 'statusline-usage.json'), 'utf8'));
  const render = (m, extra = {}, rateLimits = limits) => {
    const bin = path.join(m.home, 'bin');
    const env = { ...process.env, HOME: m.home, USERPROFILE: m.home, CLAUDE_CONFIG_DIR: path.join(m.home, '.claude'), CODEX_HOME: path.join(m.home, '.codex'),
      OAK_MACHINE_LABEL: m.name, PATH: [bin, '/usr/bin', '/bin', '/usr/local/bin'].join(path.delimiter), ...extra };
    if (!fs.existsSync(bin)) {
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'oak'), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`, { mode: 0o755 });
      const inst = cp.spawnSync('bash', [path.resolve(__dirname, '../../cli/statusline/install-statusline.sh'), '--force'], { env, encoding: 'utf8' });
      assert.equal(inst.status, 0, inst.stderr);
    }
    const r = cp.spawnSync('bash', [path.join(m.home, '.claude', 'statusline.sh')], { input: JSON.stringify({ session_id: `s-${m.name}`, cwd: m.work, transcript_path: files[m.name], rate_limits: rateLimits }), env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return state(m);
  };
  // Control: with no index (OAK_INDEX=off) the estimator scans this machine's transcripts, the later one too, and keeps a
  // map of the files it read.
  const scanned = render(a, { OAK_INDEX: 'off' });
  assert.ok(Object.keys(scanned.fc).length >= 2, `the scan's file map: ${JSON.stringify(Object.keys(scanned.fc))}`);
  assert.equal(scanned.U5, 1010 + 505 + 70_000, 'this machine\'s transcripts, as the scan reads them');
  // With the index, the next render takes the account's totals instead, drops the file map, and reads no transcript.
  let st = render(a);
  assert.deepEqual([Object.keys(st.fc).length, st.U5, st.U7, st.U30], [0, both, both, both], 'both machines\' turns, each once; the later transcript unread');
  // What it records as its own measurement (which an older OAK's brief adds up) is this machine's rows alone.
  const last = JSON.parse(fs.readFileSync(path.join(a.home, '.claude', 'statusline-last.json'), 'utf8'));
  assert.deepEqual([last.five_meas, last.week_meas], [1010 + 505, 1010 + 505], 'a\'s own turns (the message both hold was a\'s first)');
  // Between two of its scans a render takes no totals, so the status line's own `oak usage` read opens no index for it.
  const usage = (extra) => JSON.parse(cp.execFileSync(process.execPath, [cli, 'usage', '--session', 's-a', '--json'], { cwd: a.work, encoding: 'utf8',
    env: { ...process.env, HOME: a.home, USERPROFILE: a.home, CLAUDE_CONFIG_DIR: path.join(a.home, '.claude'), CODEX_HOME: path.join(a.home, '.codex'), ...extra } }));
  assert.equal(usage({ OAK_STATUSLINE: '1' }).usageTotals, null, 'a render between scans');
  assert.equal(typeof usage({}).usageTotals, 'object', 'any other reader');
  // Two machines of one account calibrate one budget from the same shares.
  fs.rmSync(path.join(a.home, '.claude', 'statusline-usage.json'));
  assert.equal(usage({ OAK_STATUSLINE: '1' }).usageTotals.five.tokens, both, 'a render whose scan is due');
  st = render(a);
  const other = render(b);
  assert.deepEqual([st.U5, st.tpp5, st.tpp7], [both, both / 10, both / 20]);
  assert.deepEqual([other.U5, other.tpp5, other.tpp7, Object.keys(other.fc).length], [both, both / 10, both / 20, 0], 'the same on the other machine');
  // A 5-hour window that turned over between the readout `oak usage` placed its totals by and this render's: they are
  // another window's, and the scan runs as before.
  fs.rmSync(path.join(a.home, '.claude', 'statusline-usage.json'));
  st = render(a, {}, { ...limits, five_hour: { used_percentage: 10, resets_at: nowS + 4 * 3600 } });
  assert.ok(Object.keys(st.fc).length >= 2 && st.U5 === 1010 + 505 + 70_000, `the scan: ${JSON.stringify([Object.keys(st.fc).length, st.U5])}`);
  // A render between two scans whose totals do not fit its bill cycle (here, the clock it was given falls in another)
  // waits for its next scan interval, and reads nothing now.
  const stateFile = path.join(a.home, '.claude', 'statusline-usage.json');
  const kept = fs.readFileSync(stateFile, 'utf8');
  render(a, { STATUSLINE_NOW: String(nowS - 40 * 86400) }, { ...limits, five_hour: { used_percentage: 10, resets_at: nowS + 4 * 3600 } });
  assert.equal(fs.readFileSync(stateFile, 'utf8'), kept, 'no scan, and the state as it was');
  // An index still catching up (a new file, its first build not done) gives totals of part of the account: the scan.
  a.use();
  for (const n of fs.readdirSync(core.indexDir())) fs.rmSync(path.join(core.indexDir(), n), { force: true });
  fs.rmSync(stateFile);
  st = render(a);
  assert.ok(Object.keys(st.fc).length >= 2, `the scan: ${Object.keys(st.fc).length} files`);
});

// --- what the review of the record log found ---------------------------------------------------------------------------

test('records: a catch-up out of time partway through this machine\'s own log compacts nothing, so nothing it had yet to read is lost', { skip }, (t) => {
  const { a } = machines(t, ['a']);
  // Enough rows ahead of the rest that a catch-up stopped at its first transaction has read only part of the log.
  const many = [userAsk('bulk')];
  for (let i = 0; i < 6000; i++) many.push(turn(`bulk-${i}`, 5000 - (i % 4000), { input_tokens: 1, output_tokens: 1 }));
  a.transcript('s-bulk', many);
  a.catchUp();
  const arch = a.transcript('s-arch', [userAsk('the archived wombat session'), turn('w1', 100, { input_tokens: 7, output_tokens: 7 })]);
  a.catchUp();
  fs.rmSync(arch);
  a.catchUp();
  // A new index file (the old one damaged and moved aside), which a deliberate delete asks to compact.
  a.use();
  for (const n of fs.readdirSync(core.indexDir())) fs.rmSync(path.join(core.indexDir(), n), { force: true });
  a.db((db) => db.prepare("INSERT INTO meta (key, value) VALUES ('records_compact', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run());
  const ix = core.useIndex({ budgetMs: 0, inlineBytes: Infinity });
  assert.ok(ix.ok, ix.reason);
  try {
    assert.equal(ix.catchUp.caughtUp, false, 'out of time partway');
  } finally {
    ix.close();
  }
  assert.ok(logLines(a).some((r) => r.r?.message_id === 'w1'), 'the log still holds what the index had not read');
  a.catchUp();
  a.catchUp();
  a.db((db) => {
    assert.equal(one(db, "SELECT archived_reason FROM sessions WHERE session_id = 's-arch'").archived_reason, 'missing', 'the archived session, read back');
    assert.equal(one(db, "SELECT count(*) AS n FROM usage_messages WHERE message_id = 'w1'").n, 1);
  });
  assert.ok(core.segments(a.host).some((s) => s.base), 'compacted once the whole log was read');
  assert.ok(logLines(a).some((r) => r.r?.message_id === 'w1'), 'with it');
});

test('records: segments oak sync lands out of order are read in order: a base after a later segment, or one landed in part, is read once it is whole', { skip }, (t) => {
  for (const mode of ['later-first', 'part-of-the-base']) {
    const ms = machines(t, ['a', 'b']);
    const { a, b } = ms;
    a.transcript('s-1', [userAsk('alpha one'), turn('m1', 300, { input_tokens: 10, output_tokens: 1 })]);
    a.catchUp();
    ms.carry(a, b);
    b.catchUp();
    // a forgets s-1 and starts s-2; its catch-up compacts. Then s-3, in a segment after the base.
    a.use();
    core.deleteSession('s-1');
    a.transcript('s-2', [userAsk('beta two'), turn('m2', 200, { input_tokens: 10, output_tokens: 1 })]);
    a.catchUp();
    a.transcript('s-3', [userAsk('gamma three'), turn('m3', 100, { input_tokens: 10, output_tokens: 1 })]);
    a.catchUp();
    const segs = core.segments(a.host, a.records());
    const base = segs.find((s) => s.base);
    assert.ok(base && segs.some((s) => s.name > base.name), `${mode}: a base and a segment after it`);
    const dst = path.join(b.records(), a.host);
    const put = (s, bytes) => fs.writeFileSync(path.join(dst, s.name), bytes ?? fs.readFileSync(s.file));
    if (mode === 'later-first') {
      for (const s of segs) if (s.name > base.name) put(s);
    } else {
      const buf = fs.readFileSync(base.file);
      put(base, buf.subarray(0, buf.indexOf(0x0a, core.baseHeader(base.file).headerBytes) + 1));
    }
    b.catchUp();
    if (mode === 'part-of-the-base') {
      assert.equal(b.db((db) => one(db, "SELECT count(*) AS n FROM sessions WHERE session_id = 's-2'").n), 0, 'a base not here whole is not read');
    }
    for (const s of segs) put(s);
    b.catchUp();
    const sessions = b.db((db) => rows(db, 'SELECT session_id FROM sessions WHERE machine_id = ? ORDER BY session_id', a.host).map((r) => r.session_id));
    assert.deepEqual(sessions, ['s-2', 's-3'], `${mode}: s-1 forgotten as the base says, s-2 from the base, s-3 after it`);
  }
});

test('records: this machine\'s own records read again over its rows (a catch-up stopped before it committed) never hide a session from the listings', { skip }, (t) => {
  const { a } = machines(t, ['a']);
  a.transcript('s-k', [userAsk('kiwi ask'), turn('k1', 300, { input_tokens: 10, output_tokens: 1 })]);
  a.catchUp();
  // The index forgets how far it read its own log, as a catch-up stopped between the append and its commit leaves it.
  a.db((db) => db.prepare("DELETE FROM ingest_state WHERE source = ?").run(`records:${a.host}`));
  a.catchUp();
  a.db((db) => {
    assert.equal(one(db, "SELECT listed FROM sessions WHERE session_id = 's-k'").listed, 1);
    assert.deepEqual(core.indexedSessionMeta(db, a.work).sessions.map((s) => s.id), ['s-k']);
  });
});

test('usage: a session deleted on purpose is read no more by `oak usage`, which keeps its usage up to the delete without it', { skip }, (t) => {
  const { a } = machines(t, ['a']);
  const file = a.transcript('s-del', [userAsk('to delete'), turn('d1', 300, { input_tokens: 10, output_tokens: 1 })]);
  a.catchUp();
  a.use();
  core.deleteSession('s-del');
  // Its status line renders on: `oak usage --session s-del`, with a turn written since.
  fs.appendFileSync(file, JSON.stringify({ cwd: a.work, sessionId: 's-del', ...turn('d2', 10, { input_tokens: 10, output_tokens: 1 }) }) + '\n');
  a.use();
  core.indexedUsageTotals({ fiveReset: null, weekReset: null, session: 's-del', transcript: file, rollout: null });
  a.db((db) => {
    assert.deepEqual(rows(db, 'SELECT message_id, session_id FROM usage_messages ORDER BY message_id').map((r) => [r.message_id, r.session_id]), [['d1', '']]);
  });
});

// A session deleted with OAK 0.10.0, before this machine had an index, kept its transcript: the account was billed for its
// turns, and the status line's own scan counts them. The index counts them too, without the session, from cursors of
// their own, so an undelete reads the session again and its usage is its own again; a delete made since stays read no more.
test('usage: a session deleted before the index knew it counts toward the account without the session, and an undelete gives it its usage back', { skip }, (t) => {
  const { a } = machines(t, ['a']);
  const file = a.transcript('s-old', [userAsk('deleted with an older OAK'), turn('o1', 600, { input_tokens: 100, output_tokens: 10 }), turn('o2', 500, { input_tokens: 50, output_tokens: 5 })]);
  a.transcript('s-live', [userAsk('live'), turn('l1', 300, { input_tokens: 1, output_tokens: 1 })]);
  // A worker of the deleted session, its transcript beside it.
  const worker = path.join(path.dirname(file), 's-old', 'subagents', 'agent-w1.jsonl');
  fs.mkdirSync(path.dirname(worker), { recursive: true });
  fs.writeFileSync(worker, JSON.stringify({ cwd: a.work, sessionId: 's-old', isSidechain: true, ...turn('ow', 550, { input_tokens: 9, output_tokens: 1 }) }) + '\n');
  // …and a Codex session deleted the same way, its rollout kept.
  const cx = '0f0f0f0f-0000-4000-8000-0000000000c1';
  const at = (sec) => new Date(Date.now() - sec * 1000).toISOString();
  fs.mkdirSync(path.join(a.home, '.codex', 'sessions', '2026', '11', '01'), { recursive: true });
  fs.writeFileSync(path.join(a.home, '.codex', 'sessions', '2026', '11', '01', `rollout-2026-11-01T10-00-00-${cx}.jsonl`), [
    { type: 'session_meta', timestamp: at(700), payload: { id: cx, cwd: a.work } },
    { type: 'turn_context', timestamp: at(600), payload: { type: 'turn_context', turn_id: 'turn-1', model: 'gpt-5.1' } },
    { type: 'event_msg', timestamp: at(590), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 900, cached_input_tokens: 0, output_tokens: 40 }, last_token_usage: { input_tokens: 900, cached_input_tokens: 0, output_tokens: 40, total_tokens: 940 } } } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  // OAK 0.10.0's delete: the sessions hidden, their files kept, and no index here to hear of it.
  a.use();
  fs.mkdirSync(core.rootDir(), { recursive: true });
  fs.writeFileSync(path.join(core.rootDir(), 'hidden-sessions.json'), JSON.stringify(['s-old', cx]));
  a.catchUp();
  const usage = () => a.db((db) => rows(db, "SELECT message_id, session_id, input FROM usage_messages WHERE message_id LIKE 'o%' ORDER BY message_id").map((r) => [r.message_id, r.session_id, r.input]));
  assert.deepEqual(usage(), [['o1', '', 100], ['o2', '', 50], ['ow', '', 9]], 'its usage, its worker\'s too, without the session');
  const codex = () => a.db((db) => rows(db, "SELECT session_id, input FROM usage_messages WHERE agent = 'codex'").map((r) => [r.session_id, r.input]));
  assert.deepEqual(codex(), [['', 900]], 'the Codex session\'s too');
  assert.equal(a.db((db) => one(db, "SELECT count(*) AS n FROM sessions WHERE session_id = 's-old'").n), 0, 'and the session is listed nowhere');
  assert.ok(settles(a), 'read once: the next catch-up has nothing to do');
  // A turn written since is read too.
  fs.appendFileSync(file, JSON.stringify({ cwd: a.work, sessionId: 's-old', ...turn('o3', 10, { input_tokens: 7, output_tokens: 1 }) }) + '\n');
  a.catchUp();
  assert.deepEqual(usage(), [['o1', '', 100], ['o2', '', 50], ['o3', '', 7], ['ow', '', 9]]);
  // Put back: the session is read whole again, and its usage is its own; the Codex one's too.
  a.use();
  core.unhideSession('s-old');
  core.unhideSession(cx);
  a.catchUp();
  assert.deepEqual(usage(), [['o1', 's-old', 100], ['o2', 's-old', 50], ['o3', 's-old', 7], ['ow', 's-old', 9]], 'each message once, the session\'s again');
  assert.deepEqual(codex(), [[cx, 900]], 'the Codex one\'s too');
  // Deleted again, here: its usage stays without it, and is read no more.
  a.use();
  core.deleteSession('s-old');
  fs.appendFileSync(file, JSON.stringify({ cwd: a.work, sessionId: 's-old', ...turn('o4', 5, { input_tokens: 3, output_tokens: 1 }) }) + '\n');
  a.catchUp();
  assert.deepEqual(usage(), [['o1', '', 100], ['o2', '', 50], ['o3', '', 7], ['ow', '', 9]]);
});

test('usage: two catch-ups writing at once never give two rows one write sequence, nor move it back', { skip }, (t) => {
  const { a } = machines(t, ['a']);
  a.transcript('s-1', [userAsk('one'), turn('u1', 300, { input_tokens: 1, output_tokens: 1 })]);
  a.transcript('s-2', [userAsk('two'), turn('u2', 200, { input_tokens: 1, output_tokens: 1 })]);
  a.use();
  const o = core.openIndex();
  try {
    let first = true;
    core.catchUp(o.db, { budgetMs: Infinity, afterUnit: () => {
      if (!first) return;
      first = false;
      // Between this catch-up's two sessions another process (one that took a lapsed lease over) wrote usage.
      const other = core.openIndex();
      try {
        other.db.prepare("UPDATE meta SET value = '1000' WHERE key = 'usage_seq'").run();
      } finally {
        other.close();
      }
    } });
    const seqs = rows(o.db, 'SELECT seq FROM usage_messages ORDER BY seq').map((r) => r.seq);
    assert.ok(seqs[seqs.length - 1] > 1000, `the later writes follow the other process's: ${seqs}`);
    assert.ok(Number(one(o.db, "SELECT value FROM meta WHERE key = 'usage_seq'").value) >= seqs[seqs.length - 1], 'and the sequence never goes back');
  } finally {
    o.close();
  }
});

test('usage pull: a machine with no index that opens says why, and gives its readings instead; a machine whose own index does not open asks every machine for its readings', { skip }, async (t) => {
  const { b } = machines(t, ['b']);
  fs.writeFileSync(path.join(b.home, '.claude', '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'one-account' } }));
  b.use();
  const now = Date.now();
  const brief = JSON.stringify({ brief: 1, account: core.claudeAccountTag(), at: now, five: { pct: 42, reset: now + 3600_000, at: now - 1000, tok: null, total: null }, week: null, fable: null, month: null, own: null });
  const asked = [];
  const ask = async (m, how) => {
    asked.push(how.verb);
    return how.verb === 'records' ? JSON.stringify({ usageRecords: 1, error: 'the database is turned off (OAK_INDEX=off)' }) : brief;
  };
  const list = async () => [{ label: 'far', target: 'me@far', enabled: true }];
  let c = await core.refreshMachineUsage(list, ask, { force: true });
  assert.deepEqual(asked, ['records', 'brief']);
  assert.deepEqual([c.outcomes[0].status, c.outcomes[0].briefOnly, c.machines[0].brief.five.pct], ['ok', true, 42]);
  const row = core.diagnoseMachineUsage().find((r) => r.id === 'machine-usage:far');
  // Said as information: what it measured of its own turns, when it has measured any, counts in the totals here.
  assert.equal(row.level, 'ok');
  assert.match(row.detail, /no local database that opens \(the database is turned off \(OAK_INDEX=off\)\)/);
  assert.match(row.fix, /oak doctor/);
  // This machine's index written by a newer OAK: no machine's records can be kept here, so each gives its readings.
  b.db((db) => db.exec('PRAGMA user_version = 99'));
  b.use();
  asked.length = 0;
  c = await core.refreshMachineUsage(list, ask, { force: true });
  assert.deepEqual(asked, ['brief']);
  assert.equal(c.machines[0].brief.five.pct, 42);
});

test('usage: `oak usage`\'s totals say they are whole only once a catch-up of everything has finished lately', { skip }, (t) => {
  const { a } = machines(t, ['a']);
  const f1 = a.transcript('s-1', [userAsk('one'), turn('t1', 300, { input_tokens: 3000, output_tokens: 0 })]);
  a.transcript('s-2', [userAsk('two'), turn('t2', 200, { input_tokens: 3000, output_tokens: 0 })]);
  a.use();
  let tot = core.indexedUsageTotals({ fiveReset: null, weekReset: null, session: 's-1', transcript: f1, rollout: null });
  assert.deepEqual([tot.caughtUp, tot.five.tokens], [false, 3000], 'the one session read so far');
  a.catchUp();
  a.use();
  tot = core.indexedUsageTotals({ fiveReset: null, weekReset: null, session: 's-1', transcript: f1, rollout: null });
  assert.deepEqual([tot.caughtUp, tot.five.tokens], [true, 6000]);
  a.db((db) => db.prepare("UPDATE meta SET value = ? WHERE key = 'caught_up_ms'").run(String(Date.now() - 20 * 60_000)));
  a.use();
  assert.equal(core.indexedUsageTotals({ fiveReset: null, weekReset: null }).caughtUp, false, 'not caught up for twenty minutes');
});

test('usage: a breakdown counts another machine\'s Codex turns of this machine\'s Codex account, and no one else\'s', { skip }, (t) => {
  const { b } = machines(t, ['b']);
  fs.writeFileSync(path.join(b.home, '.claude', '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct-b' } }));
  b.transcript('s-b', [userAsk('b'), turn('cb', 60, { input_tokens: 5, output_tokens: 5 })]);
  b.catchUp();
  b.db((db) => {
    db.prepare("INSERT INTO accounts (account, agent, machine_id, first_ms, last_ms) VALUES ('c0dexacc0unt', 'codex', ?, 1, ?)").run(core.selfIds(db)[0], Date.now());
    const msg = db.prepare("INSERT INTO usage_messages (message_id, agent, machine_id, session_id, account, model, ts, input, output) VALUES (?, 'codex', '0123456789ab', 's-far', ?, 'gpt-5.3-codex', ?, ?, 0)");
    msg.run('x-mine', 'c0dexacc0unt', Date.now() - 60_000, 70);
    msg.run('x-other', 'someoneelse0', Date.now() - 60_000, 900);
  });
  b.use();
  assert.deepEqual(core.queryIndex('usage', { window: 'all', by: 'agent' }).rows.map((x) => [x.key, x.tokens]).sort(), [['claude', 10], ['codex', 70]]);
});

test('usage: the bill cycle follows the subscription again once a bill day set in prefs.json is cleared', { skip }, (t) => {
  const { a } = machines(t, ['a']);
  fs.writeFileSync(path.join(a.home, '.claude', '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct-a', subscriptionCreatedAt: '2026-01-14T10:00:00Z' } }));
  const prefs = (o) => {
    fs.mkdirSync(path.join(a.home, '.claude', 'claude-observatory'), { recursive: true });
    fs.writeFileSync(path.join(a.home, '.claude', 'claude-observatory', 'prefs.json'), JSON.stringify(o));
  };
  prefs({ billDay: 3 });
  a.transcript('s-a', [userAsk('a'), turn('ba', 60, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  const day = () => a.db((db) => new Date(core.usageTotals(db, { fiveReset: null, weekReset: null }).month.start).getUTCDate());
  assert.equal(day(), 3);
  prefs({});
  assert.equal(day(), 14, 'the subscription\'s day, as the status line takes it');
});

// --- cleanups from every surface (index review A, finding 1) ---------------------------------------------------------

test('cleanup: an editor\'s Drop and clear, and the terminal app\'s delete, call core in place, and core records or forgets the session first', { skip }, (t) => {
  const { a } = machines(t, ['a']);
  const edit = (id, n, status) => core.appendLog(id, { ts: Date.now() - 1000 + n, tool: 'Edit', file: path.join(a.work, `f${n}.ts`),
    beforeBlob: core.writeBlob(id, Buffer.from(`${n}\n`)), afterBlob: core.writeBlob(id, Buffer.from(`${n}\n${n}\n`)), status });
  a.transcript('s-drop', [userAsk('dropped later'), turn('d1', 100, { input_tokens: 1, output_tokens: 1 })]);
  a.transcript('s-clear', [userAsk('cleared later'), turn('c1', 100, { input_tokens: 1, output_tokens: 1 })]);
  a.transcript('s-del', [userAsk('the zebracorn to forget'), turn('x1', 100, { input_tokens: 1, output_tokens: 1 })]);
  a.use();
  core.ensureStore('s-drop');
  edit('s-drop', 1, 'kept');
  core.ensureStore('s-clear');
  edit('s-clear', 1, 'kept');
  a.catchUp();
  // After the last catch-up: an edit the index never saw, then VS Code's Drop (core.removeSession in place).
  a.use();
  edit('s-drop', 2, 'kept');
  core.removeSession('s-drop');
  // …and its clear by task or prompt (core.clearResolvedIds in place), of an edit the index never saw either.
  edit('s-clear', 2, 'kept');
  core.clearResolvedIds('s-clear', [1, 2]);
  // …and the terminal app's delete (core.deleteSession in place).
  core.deleteSession('s-del');
  a.db((db) => {
    assert.equal(one(db, "SELECT count(*) AS n FROM edits WHERE session_id = 's-drop'").n, 2, 'the dropped session\'s last edit was recorded before its store went');
    assert.equal(one(db, "SELECT archive_hint FROM sessions WHERE session_id = 's-drop'").archive_hint, 'cleaned');
    assert.equal(one(db, "SELECT count(*) AS n FROM edits WHERE session_id = 's-clear' AND id = 2").n, 1, 'the cleared edit was recorded before the clear');
    assert.equal(one(db, "SELECT count(*) AS n FROM sessions WHERE session_id = 's-del'").n, 0, 'the deleted session is forgotten at once');
    assert.equal(one(db, "SELECT count(*) AS n FROM prompts_fts WHERE prompts_fts MATCH 'zebracorn'").n, 0, 'its full-text entries with it');
  });
  assert.ok(logLines(a).some((r) => r.t === 'edits' && r.r.session_id === 's-drop' && r.r.id === 2), 'and the record log has the dropped session\'s last edit');
  assert.ok(logLines(a).some((r) => r.t === 'purge' && r.s === 's-del'), 'and the delete');
  // Where the index is unavailable (an editor whose Node has no node:sqlite), the same calls work and record nothing.
  a.use();
  process.env.OAK_INDEX = 'off';
  core.resetIndexRuntime();
  core.ensureStore('s-off');
  edit('s-off', 1, 'kept');
  assert.equal(core.clearResolvedIds('s-off', [1]).cleared, 1);
  core.removeSession('s-off');
  delete process.env.OAK_INDEX;
  core.resetIndexRuntime();
});

// --- values the index's tables cannot hold (index review A, finding 2) -----------------------------------------------

test('index: a fractional time is rounded where it is read; a value no column can hold keeps its session out, and the index never says it is caught up over it', { skip }, (t) => {
  const { a } = machines(t, ['a']);
  a.transcript('s-frac', [userAsk('fractional'), turn('f1', 100, { input_tokens: 1, output_tokens: 1 })]);
  a.use();
  core.ensureStore('s-frac');
  const log = core.logPath('s-frac');
  const ts = Date.now() - 5000.5;
  fs.appendFileSync(log, JSON.stringify({ id: 1, ts, tool: 'Edit', file: path.join(a.work, 'x.ts'), beforeBlob: null, afterBlob: core.writeBlob('s-frac', Buffer.from('x\n')), status: 'pending' }) + '\n');
  fs.writeFileSync(path.join(core.storeDir('s-frac'), 'attention-log.jsonl'), JSON.stringify({ ev: 'up', kind: 'input', t: Date.now() - 2000.25 }) + '\n');
  a.catchUp();
  a.db((db) => {
    assert.equal(one(db, "SELECT ts FROM edits WHERE session_id = 's-frac'").ts, Math.round(ts), 'the time, rounded');
    assert.equal(one(db, "SELECT count(*) AS n FROM waits WHERE session_id = 's-frac'").n, 1);
  });
  // A time that is no number at all: the session fails, and says so, read after read.
  a.transcript('s-bad', [userAsk('bad'), turn('b1', 100, { input_tokens: 1, output_tokens: 1 })]);
  a.use();
  core.ensureStore('s-bad');
  fs.appendFileSync(core.logPath('s-bad'), JSON.stringify({ id: 1, ts: 'yesterday', tool: 'Edit', file: path.join(a.work, 'y.ts'), beforeBlob: null, afterBlob: null, status: 'pending' }) + '\n');
  for (let i = 0; i < 2; i++) {
    const ix = core.useIndex({ budgetMs: Infinity, inlineBytes: Infinity });
    try {
      assert.equal(ix.catchUp.caughtUp, false, 'never caught up over a session that failed');
      assert.ok(ix.catchUp.problems.some((p) => /s-bad: edits\.ts cannot hold/.test(p)), JSON.stringify(ix.catchUp.problems));
    } finally {
      ix.close();
    }
  }
  const doc = core.diagnoseIndex();
  assert.deepEqual([doc.level, /1 session could not be added to the database \(s-bad/.test(doc.detail)], ['warn', true], doc.detail);
  assert.ok(core.indexStatus().failed.some((x) => x.id === 's-bad'));
  // Mended (or gone), the index is caught up again.
  fs.writeFileSync(core.logPath('s-bad'), '');
  a.catchUp();
  assert.equal(core.diagnoseIndex().level, 'ok');
});

// --- a store begun again (index review A, finding 3) ------------------------------------------------------------------

test('index: a session whose store `oak clean` removed and which went on keeps the earlier store\'s operations, gaps and units, below every id the new one gives', { skip }, (t) => {
  const { a } = machines(t, ['a']);
  a.transcript('s-gen', [userAsk('two stores'), turn('g1', 100, { input_tokens: 1, output_tokens: 1 })]);
  a.use();
  const edit = (n) => core.appendLog('s-gen', { ts: Date.now() - 10000 + n, tool: 'Edit', file: path.join(a.work, `g${n}.ts`),
    beforeBlob: core.writeBlob('s-gen', Buffer.from('a\n')), afterBlob: core.writeBlob('s-gen', Buffer.from(`a\n${n}\n`)), status: 'pending' });
  core.ensureStore('s-gen');
  edit(1);
  edit(2);
  core.setStatusMany('s-gen', [1, 2], 'kept');
  core.appendSkip('s-gen', path.join(a.work, 'big.bin'), 'too large');
  a.catchUp();
  const first = a.db((db) => ({
    ops: rows(db, "SELECT seq, ids FROM edit_ops WHERE session_id = 's-gen'").map((r) => ({ ...r })),
    gaps: rows(db, "SELECT seq, file FROM capture_gaps WHERE session_id = 's-gen'").map((r) => ({ ...r })),
    units: rows(db, "SELECT rep_id FROM units WHERE session_id = 's-gen'").map((r) => r.rep_id),
  }));
  assert.ok(first.ops.length === 1 && first.gaps.length === 1 && first.units.length === 2, `control: ${JSON.stringify(first)}`);
  // `oak clean --drop`, then the session goes on: a new store, its ids from 1 again.
  a.use();
  core.removeSession('s-gen');
  a.catchUp();
  a.use();
  core.ensureStore('s-gen');
  edit(1);
  edit(2);
  core.setStatusMany('s-gen', [1, 2], 'kept');
  core.appendSkip('s-gen', path.join(a.work, 'other.bin'), 'too large');
  a.catchUp();
  a.db((db) => {
    const ops = rows(db, "SELECT seq, ids FROM edit_ops WHERE session_id = 's-gen' ORDER BY seq").map((r) => ({ ...r }));
    const gaps = rows(db, "SELECT seq, file FROM capture_gaps WHERE session_id = 's-gen' ORDER BY seq").map((r) => ({ ...r }));
    const units = rows(db, "SELECT rep_id, members FROM units WHERE session_id = 's-gen' ORDER BY rep_id").map((r) => ({ ...r }));
    const edits = rows(db, "SELECT id, cleared_ms IS NOT NULL AS cleared FROM edits WHERE session_id = 's-gen' ORDER BY id").map((r) => [r.id, r.cleared]);
    assert.deepEqual(edits, [[-2, 1], [-1, 1], [1, 0], [2, 0]], 'the earlier store\'s edits below zero, cleared');
    assert.equal(gaps.length, 2, `both stores' gaps: ${JSON.stringify(gaps)}`);
    assert.ok(gaps.some((g) => g.seq < 0 && g.file.endsWith('big.bin')) && gaps.some((g) => g.seq === 0 && g.file.endsWith('other.bin')));
    assert.equal(ops.length, 2, `both stores' operations: ${JSON.stringify(ops)}`);
    const old = ops.find((o) => o.seq < 0);
    assert.deepEqual(JSON.parse(old.ids).sort((x, y) => x - y), [-2, -1], 'the earlier operation names the earlier edits where they moved');
    assert.deepEqual(units.map((u) => u.rep_id), [-2, -1, 1, 2], 'the earlier units kept, under their edits\' new ids');
  });
});

// A move to the default location is a copy (the folder there holds prefs.json), so each session's folder is a new one
// when the store comes back; the index file kept there must not take the same store for one begun again.
test('index: a store moved away and back, by copy, keeps each edit once under its own id, and publishes no earlier store', { skip }, (t) => {
  const { a } = machines(t, ['a']);
  a.transcript('s-moved', [userAsk('a store that moves'), turn('mv1', 100, { input_tokens: 1, output_tokens: 1 })]);
  a.use();
  core.ensureStore('s-moved');
  for (const n of [1, 2]) {
    core.appendLog('s-moved', { ts: Date.now() - 10000 + n, tool: 'Edit', file: path.join(a.work, `m${n}.ts`),
      beforeBlob: core.writeBlob('s-moved', Buffer.from('a\n')), afterBlob: core.writeBlob('s-moved', Buffer.from(`a\n${n}\n`)), status: 'pending' });
  }
  a.catchUp();
  const edits = () => a.db((db) => rows(db, "SELECT id, cleared_ms IS NOT NULL AS cleared FROM edits WHERE session_id = 's-moved' ORDER BY id").map((r) => [r.id, r.cleared]));
  assert.deepEqual(edits(), [[1, 0], [2, 0]], 'control');
  a.use();
  const home = core.rootDir();
  assert.ok(!('error' in core.moveStore(path.join(a.home, 'elsewhere', 'oak'))), 'moved away');
  a.catchUp();
  a.use();
  const back = core.moveStore(home);
  assert.ok(!('error' in back), `and back: ${JSON.stringify(back)}`);
  a.catchUp();
  assert.deepEqual(edits(), [[1, 0], [2, 0]], 'each edit once, under its own id');
  assert.ok(!logLines(a).some((r) => r.t === 'edits' && r.r && r.r.id < 0), 'and no earlier store in the record log');
  // A store begun again whose log holds no record yet (a capture gap first) is no copy of the one indexed: its gaps
  // and edits move below zero as before.
  a.use();
  core.removeSession('s-moved');
  core.ensureStore('s-moved');
  core.appendSkip('s-moved', path.join(a.work, 'big.bin'), 'too large');
  a.catchUp();
  assert.deepEqual(edits(), [[-2, 1], [-1, 1]], 'the earlier store\'s edits below zero, cleared');
});

test('records R1: a partially restored old segment must not be covered by compaction', { skip }, async (t) => {
  const { a, b, old } = await setUpAgain(t);
  a.catchUp();
  const name = old[0];
  const whole = fs.readFileSync(path.join(b.records(), a.host, name));
  const prefix = whole.subarray(0, whole.indexOf(10) + 1);
  const file = path.join(a.records(), a.host, name);
  fs.writeFileSync(file, prefix);
  a.use();
  core.deleteSession('s-new');
  a.catchUp();
  a.use();
  const records = require('../dist/index/records');
  const covered = records.covers(records.coverage(core.segments(a.host)), name);
  t.diagnostic(JSON.stringify({ whole: whole.length, landed: prefix.length, covered, oldStillHere: fs.existsSync(file) }));
  await syncRun(b, { a });
  b.catchUp();
  const after = holds(b, a.host);
  t.diagnostic(JSON.stringify({ after }));
  assert.ok(after.includes('s-arch (archived)'), 'compaction must preserve the unreceived archive');
  assert.equal(covered, false, 'a local EOF is no proof of a segment\'s final size');
  assert.ok(fs.existsSync(file), 'the prefix stays available for the rest to arrive');
  // Sync defers a recently written local prefix for a minute; let this synthetic restore be old enough.
  const quiet = new Date(Date.now() - 120_000);
  fs.utimesSync(file, quiet, quiet);
  await syncRun(a, { b });
  a.catchUp();
  assert.ok(holds(a, a.host).includes('s-arch (archived)'), 'the rest restores the archive on its owner too');
});

test('records R2: a base without its tombstone must not resurrect a session already purged', { skip }, async (t) => {
  const { a, b } = await setUpAgain(t);
  a.catchUp();
  a.use();
  core.deleteSession('s-live');
  // Carry the purge itself, before a compacts, while the sync tombstone has not arrived.
  for (const seg of core.segments(a.host)) fs.copyFileSync(seg.file, path.join(b.records(), a.host, seg.name));
  b.catchUp();
  assert.ok(!holds(b, a.host).includes('s-live'), 'control: b applied the purge');
  a.catchUp();
  a.use();
  for (const seg of core.segments(a.host)) fs.copyFileSync(seg.file, path.join(b.records(), a.host, seg.name));
  b.catchUp();
  const after = holds(b, a.host);
  t.diagnostic(JSON.stringify({ after, hidden: [...core.hiddenSessions()] }));
  a.db((db) => db.prepare("INSERT INTO meta (key, value) VALUES ('records_compact', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run());
  a.catchUp();
  for (const seg of core.segments(a.host)) fs.copyFileSync(seg.file, path.join(b.records(), a.host, seg.name));
  b.use();
  fs.rmSync(core.indexDir(), { recursive: true, force: true });
  b.catchUp();
  assert.ok(!holds(b, a.host).includes('s-live'), 'a rebuilt index reads the durable purge after another compaction');
  assert.ok(holds(b, a.host).includes('s-arch (archived)'), 'unrelated archived history survives');
  a.use();
  core.recordSessionDeletes();
  await syncRun(b, { a });
  b.catchUp();
  assert.ok(!holds(b, a.host).includes('s-live'), 'control: delivering the missing tombstone suppresses it again');
  assert.ok(!after.includes('s-live'), 'a compacted purge must stay effective without the separate tombstone');
});

test('records R3: clock rollback across a reinstall must not let the old log replace newer text', { skip }, async (t) => {
  const { a, b } = await setUpAgain(t);
  const clock = Date.now;
  try {
    Date.now = () => clock() - 2 * 86400000;
    a.transcript('s-live', [userAsk('replacement after reinstall'), turn('live-2', 500, { input_tokens: 1, output_tokens: 1 })]);
    a.catchUp();
    a.use();
    core.deleteSession('s-new');
    a.catchUp();
  } finally { Date.now = clock; }
  await syncRun(b, { a });
  b.catchUp();
  const prompts = b.db((db) => rows(db, 'SELECT text FROM prompts WHERE machine_id = ? AND session_id = ? ORDER BY idx', a.host, 's-live').map((r) => r.text));
  t.diagnostic(JSON.stringify({ prompts }));
  assert.ok(prompts.includes('replacement after reinstall'), 'the new lifetime must override its old copy');
  await syncRun(a, { b });
  a.catchUp();
  assert.equal(a.db((db) => one(db, 'SELECT text FROM prompts WHERE machine_id = ? AND session_id = ?', a.host, 's-live').text), 'replacement after reinstall', 'old history also stays behind the owner\'s base');
  a.transcript('s-live', [userAsk('a later edit in the current lifetime'), turn('live-3', 10, { input_tokens: 1, output_tokens: 1 })]);
  a.catchUp();
  a.db((db) => db.prepare("UPDATE ingest_state SET updated_ms = updated_ms - ? WHERE kind = 'pub-waiting'").run(core.PUBLISH_MS + 1000));
  a.catchUp();
  await syncRun(b, { a });
  b.catchUp();
  assert.equal(b.db((db) => one(db, 'SELECT text FROM prompts WHERE machine_id = ? AND session_id = ?', a.host, 's-live').text), 'a later edit in the current lifetime', 'that writer\'s later segment still supersedes its base');
  b.use();
  fs.rmSync(core.indexDir(), { recursive: true, force: true });
  b.catchUp();
  assert.equal(b.db((db) => one(db, 'SELECT text FROM prompts WHERE machine_id = ? AND session_id = ?', a.host, 's-live').text), 'a later edit in the current lifetime', 'the same order holds on a fresh index');
  // A disconnected base has no causal claim over this one, whatever its clock says. Keep the selected view and both logs.
  b.use();
  const base = core.segments(a.host).find((s) => s.base);
  const h = core.baseHeader(base.file);
  const body = fs.readFileSync(base.file, 'utf8').slice(h.headerBytes).split('\n').filter((l) => l && JSON.parse(l).t !== 'cover').join('\n').replaceAll('replacement after reinstall', 'unrelated earlier text') + '\n';
  const name = `${String(Date.now() + 86400000)}-f00df00d-base.jsonl`;
  const head = JSON.stringify({ t: 'base', bytes: Buffer.byteLength(body), at: Date.now(), v: 1, writer: 'fedcba9876543210', parts: 0 });
  fs.writeFileSync(path.join(b.records(), a.host, name), head.padEnd(255) + '\n' + body);
  b.catchUp();
  assert.equal(b.db((db) => one(db, 'SELECT text FROM prompts WHERE machine_id = ? AND session_id = ?', a.host, 's-live').text), 'a later edit in the current lifetime', 'an unrelated base cannot replace the selected writer by clock order');
  assert.equal(core.segments(a.host).filter((s) => s.base).length, 2, 'the ambiguous histories remain available');
});


test('records R1: coverage names only verified segments, including when an unseen old filename falls inside the clock range', { skip }, (t) => {
  const { a } = machines(t, ['a']);
  a.transcript('s-one', [userAsk('one')]);
  a.catchUp();
  a.use();
  const first = core.segments(a.host)[0].name;
  const unknown = first.replace(/-[0-9a-f]{8}\.jsonl$/, '-ffffffff.jsonl');
  core.deleteSession('s-one');
  a.catchUp();
  const records = require('../dist/index/records');
  const cov = records.coverage(core.segments(a.host));
  assert.ok(first < unknown && unknown < core.segments(a.host)[0].name, 'control: inside the old from range');
  assert.equal(records.covers(cov, first), true, 'the verified segment was compacted');
  assert.equal(records.covers(cov, unknown), false, 'an unseen segment cannot be covered by a clock interval');
});

test('queued asks: stored and synced asks match the transcript after derivation upgrade and append', { skip }, t => {
  const q = require('./fixtures/queued-asks.cjs');
  const { a, b, carry } = machines(t, ['a', 'b']);
  const id = 'queued-synced';
  const file = a.transcript(id, [q.ask('Start', 0, 'start'), q.remove('Change zebracorn', 1, 'mid'), q.queued('Change zebracorn', 2, 'mid'), q.blob('Change zebracorn', 3), q.answer('Changed', 4)]);
  a.catchUp();
  const read = m => m.db(db => rows(db, 'SELECT ts, text, response FROM prompts WHERE session_id = ? ORDER BY idx', id).map(r => [r.ts, r.text, r.response]));
  const expected = [[Date.parse(q.at(0)), 'Start', ''], [Date.parse(q.at(2)), 'Change zebracorn', 'Changed']];
  assert.deepEqual(read(a), expected);
  // Force the previous derivation's stamp, with an obsolete stored ask and an otherwise unchanged transcript.
  a.db(db => {
    db.prepare("UPDATE meta SET value = '4' WHERE key = 'ingest_version'").run();
    db.prepare("UPDATE sessions SET inputs = 'previous-derivation' WHERE session_id = ?").run(id);
    db.prepare("UPDATE ingest_state SET state = json_set(state, '$.version', 4) WHERE kind = 'prompts' AND session_id = ?").run(id);
    db.prepare("UPDATE prompts SET text = 'obsolete wrapper' WHERE session_id = ? AND idx = 1").run(id);
  });
  a.catchUp(); assert.deepEqual(read(a), expected);
  carry(a, b); b.catchUp(); assert.deepEqual(read(b), expected);
  fs.appendFileSync(file, [q.ask('Change zebracorn', 5, 'delivery-copy', { promptId: 'mid' }), q.ask('Change zebracorn', 6, 'new-ask')].map(r => JSON.stringify(r)).join('\n') + '\n');
  a.catchUp();
  expected.push([Date.parse(q.at(6)), 'Change zebracorn', '']);
  assert.deepEqual(read(a), expected);
  carry(a, b); b.catchUp(); assert.deepEqual(read(b), expected);
  b.use();
  const result = cp.spawnSync(process.execPath, [path.resolve(__dirname, '../../cli/dist/index.js'), 'query', 'prompts', '--session', id, '--machine', a.host], { env: process.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).rows.map(r => r.text), expected.map(r => r[1]));
});


test('delegated worktree state travels through published records into another machine database', { skip }, t => {
  const { a, b, carry } = machines(t, ['a', 'b']);
  a.use();
  const worktree = { path: '/synthetic/agent-x', repository: '/synthetic/repo', branch: 'oak/agent-x', base: 'a'.repeat(40), baseBranch: 'main',
    state: { files: 3, added: 120, removed: 8, ahead: 1, behind: 0, merged: false, dirty: true, readMs: 123, durationMs: 8, calls: 3 } };
  core.writeDelegated({ id: 'agent-x', title: 'Synthetic work', kind: 'codex', brief: '/synthetic/brief.md', cwd: worktree.path, out: '/synthetic/out', report: '/synthetic/out/report.md',
    startedMs: 1, state: 'done', since: 2, endedMs: 2, closedMs: null, agentType: null, model: null, effort: null, sandbox: null, machine: null, workspace: null, tab: null, pane: null, session: null, parent: null, worktree });
  a.catchUp(); carry(a, b); b.catchUp();
  b.db(db => {
    const row = one(db, 'SELECT * FROM delegated WHERE id = ?', 'agent-x');
    assert.equal(row.machine_id, a.host);
    assert.deepEqual(core.delegatedFromRow(row).worktree, worktree);
  });
});

// Account estimates must not depend on which machine first indexed a copied transcript.
test('account union: three machines with copied transcripts show the same Claude and GPT windows', { skip }, async (t) => {
  const { a, b, c } = machines(t, ['a', 'b', 'c']);
  const now = Date.parse('2026-11-04T12:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const reset = now + 3 * 86400_000;
  const pages = new Map();
  for (const [m, input] of [[a, 1000000], [b, 2000000], [c, 3000000]]) {
    m.use();
    fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'synthetic-union' } }));
    fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
    fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({ tokens: { account_id: 'synthetic-union' } }));
    fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'statusline-last.json'), JSON.stringify({ week_pct: 20, week_at: now / 1000, week_reset: reset / 1000 }));
    fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'codex-account-usage.json'), JSON.stringify({ version: 1, source: 'app-server', account: core.codexAccountId(), snapshotMs: now,
      fivePct: null, fiveReset: null, weekPct: 20, weekReset: reset }));
    core.setAccountBillDay('claude', 14);
    core.setAccountBillDay('codex', 14);
    m.transcript(`s-${m.name}`, [turn(`union-${m.name}`, 60, { input_tokens: input, output_tokens: 0 })]);
    const rollout = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '04', `rollout-${m.name}.jsonl`);
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    fs.writeFileSync(rollout, [
      { type: 'session_meta', payload: { id: `gpt-${m.name}`, cwd: m.work, model_provider: 'openai' } },
      { type: 'turn_context', payload: { model: 'gpt-5.2' } },
      { type: 'event_msg', timestamp: new Date(now - 60000).toISOString(), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: 0 } } } },
    ].map(JSON.stringify).join('\n') + '\n');
    m.catchUp();
    pages.set(m, core.indexUsageRecords(null));
  }
  // A ingests copies of B and C's Claude transcripts under its own host before pulling them.
  for (const [m, input] of [[b, 2000000], [c, 3000000]]) a.transcript(`s-${m.name}`, [turn(`union-${m.name}`, 60, { input_tokens: input, output_tokens: 0 })], m.work);
  for (const m of [b, c]) {
    const relative = path.join('.codex', 'sessions', '2026', '11', '04', `rollout-${m.name}.jsonl`);
    fs.copyFileSync(path.join(m.home, relative), path.join(a.home, relative));
  }
  a.catchUp();
  assert.equal(a.db((db) => one(db, 'SELECT count(DISTINCT machine_id) AS n FROM usage_messages').n), 1, 'all copies are attributed to A');
  const figures = [];
  for (const m of [a, b, c]) {
    m.use();
    const peers = [a, b, c].filter((p) => p !== m);
    for (const p of peers) assert.ok(core.indexApplyUsageRecords(pages.get(p), { label: p.name, skewMs: 0, now }));
    const cycle = core.billCycle(now, 14);
    // Cached aggregate readings can predate the records pull, or be kept after a failed refresh.
    const entries = peers.map((p) => ({ label: p.name, target: `fixture@${p.name}`, host: p.host, skewMs: 0, rttMs: 0,
      brief: { brief: 1, account: core.claudeAccountTag(), at: now, five: null, week: null, fable: null, month: null,
        own: { host: p.host, at: now, five: null, week: { tok: 2000000, reads: 0, cost: 10, reset, fable: 0, fableReads: 0 },
          month: { tok: 2000000, reads: 0, cost: 10, start: cycle.start, reset: cycle.end } } } }));
    fs.mkdirSync(path.dirname(core.machineUsageCachePath()), { recursive: true });
    fs.writeFileSync(core.machineUsageCachePath(), JSON.stringify({ version: 1, attemptedAt: now, machines: entries, outcomes: [] }));
    const u = core.usageLine(m.work, ''), g = core.gptUsagePanel(undefined, now);
    figures.push([u.monthTokens, u.monthCost, u.weekTokens, u.weekTotal, g.monthTok, g.monthCost, g.weekTok, g.weekTotal]);
  }
  assert.deepEqual(figures, [0, 1, 2].map(() => [6000000, 30, 6000000, 30000000, 6000000, 10.5, 6000000, 30000000]));
});

test('account union: a readings-only capability survives failures and adds an old machine once', { skip }, async (t) => {
  const { a, b } = machines(t, ['a', 'b']);
  a.transcript('s-a', [turn('own-a', 60, { input_tokens: 100, output_tokens: 0 })]);
  a.catchUp();
  const now = Date.now(), cycle = core.billCycle(now);
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'synthetic-old-peer' } }));
  const brief = JSON.stringify({ brief: 1, account: core.claudeAccountTag(), at: now, five: null, week: null, fable: null, month: null,
    own: { host: b.host, at: now, five: null, week: null, month: { tok: 200, reads: 0, cost: 1, start: cycle.start, reset: cycle.end } } });
  const list = async () => ['b', 'alias-b'].map((label) => ({ label, target: `fixture@${label}`, enabled: true }));
  const answer = async (_m, how) => how.verb === 'records' ? { status: 'old-oak' } : brief;
  await core.refreshMachineUsage(list, answer, { force: true });
  assert.equal(core.readMachineUsage().machines[0].briefOnly, true);
  await core.refreshMachineUsage(list, async () => ({ status: 'unreachable' }), { force: true });
  assert.equal(core.readMachineUsage().machines[0].briefOnly, true, 'last successful capability survives a failed attempt');
  assert.equal(core.indexedUsageTotals({ fiveReset: null, weekReset: null }).month.tokens, 300, 'two aliases add one old machine');
});

test('account union: ordinary usage refresh propagates a changed bill day to two machines without oak sync', { skip }, async (t) => {
  const { a, b, c } = machines(t, ['a', 'b', 'c']);
  a.use();
  core.setAccountBillDay('codex', 7);
  let answer = JSON.stringify(core.indexUsageRecords(null));
  const list = async () => [{ label: 'a', target: 'fixture@a', enabled: true }];
  for (const m of [b, c]) {
    m.use();
    await core.refreshMachineUsage(list, async () => answer, { force: true });
    assert.equal(core.gptBillDay(), 7);
  }
  a.use();
  core.setAccountBillDay('codex', 14);
  for (const m of [b, c]) {
    m.use();
    let how;
    await core.refreshMachineUsage(list, async (_m, query) => {
      how = query;
      a.use();
      const page = JSON.stringify(core.indexUsageRecords(query.since));
      m.use();
      return page;
    }, { force: true });
    assert.equal(how.verb, 'records');
    assert.ok(how.since, 'incremental pull');
    assert.equal(core.gptBillDay(), 14);
  }
});

test('account union: freshness dates the records, including stale, failed and partial pulls', { skip }, async (t) => {
  const { a, b } = machines(t, ['a', 'b']);
  const now = Date.parse('2026-11-04T12:00:00Z');
  t.mock.method(Date, 'now', () => now);
  a.transcript('s-a', [turn('stamp-a', 60, { input_tokens: 100, output_tokens: 0 })]);
  a.catchUp();
  const page = core.indexUsageRecords(null);
  b.transcript('s-b', [turn('stamp-b', 60, { input_tokens: 100, output_tokens: 0 })]);
  b.catchUp();
  const list = async () => [{ label: 'a', target: 'fixture@a', enabled: true }];
  await core.refreshMachineUsage(list, async () => JSON.stringify(page), { force: true });
  // This machine's clock time, as every other stamp OAK shows: never an ISO UTC string.
  assert.equal(core.usageLine(b.work, '').usageFreshness, `Usage received: a ${core.relTime(now, now)}`);
  assert.equal(core.indexedUsageTotals({ fiveReset: null, weekReset: null }).machines.find((m) => m.machine === a.host).syncedAt, now);
  t.mock.method(Date, 'now', () => now + 10 * 60000);
  await core.refreshMachineUsage(list, async () => ({ status: 'unreachable' }), { force: true });
  // Ten minutes is two pull periods: not stale yet, but the failed pull still shows.
  assert.equal(core.usageLine(b.work, '').usageFreshness, `Usage received: a ${core.relTime(now, now + 10 * 60000)} (unreachable)`);
  // Stale past fifteen minutes (three pull periods), and not before.
  t.mock.method(Date, 'now', () => now + 14 * 60000);
  assert.equal(core.usageLine(b.work, '').usageFreshness, `Usage received: a ${core.relTime(now, now + 14 * 60000)} (unreachable)`);
  t.mock.method(Date, 'now', () => now + 16 * 60000);
  assert.match(core.usageLine(b.work, '').usageFreshness, /\(stale, unreachable\)$/);
  await core.refreshMachineUsage(list, async () => JSON.stringify({ ...page, more: true }), { force: true });
  assert.match(core.usageLine(b.work, '').usageFreshness, /partial/);
});
