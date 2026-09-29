const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const C = require('../dist');
const child = path.join(__dirname, 'fixtures/store-review.cjs');
const DAY = 86400000;

function fresh() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-review-test-'));
  process.env.CLAUDE_CONFIG_DIR = path.join(base, 'claude');
  process.env.CODEX_HOME = path.join(base, 'codex');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  fs.mkdirSync(path.join(process.env.CODEX_HOME, 'sessions'), { recursive: true });
  const cwd = path.join(base, 'work'); fs.mkdirSync(cwd);
  return { base, cwd };
}
function hook(s, cwd, file, event, call, codex = true) {
  if (codex) C.handleCodexHookPayload({ session_id: s, cwd, hook_event_name: event,
    tool_use_id: call, tool_name: 'apply_patch', turn_id: 'turn', tool_input: { command:
      `*** Begin Patch\n*** Update File: ${file}\n@@\n-before\n+after\n*** End Patch` } });
  else C.handleHookPayload({ session_id: s, cwd, hook_event_name: event,
    tool_use_id: call, tool_name: 'Edit', tool_input: { file_path: file } });
}
function ageStaging(s, ms) {
  for (const n of fs.readdirSync(path.join(C.storeDir(s), 'staging'))) {
    const p = path.join(C.storeDir(s), 'staging', n), j = JSON.parse(fs.readFileSync(p));
    j.ts -= ms; fs.writeFileSync(p, JSON.stringify(j));
    const d = new Date(Date.now() - ms); fs.utimesSync(p, d, d);
  }
}
function event(ts, tokens, pct, reset) {
  return { timestamp: new Date(ts).toISOString(), type: 'event_msg', payload: {
    type: 'token_count', info: { total_token_usage: { input_tokens: tokens, output_tokens: 0 } },
    ...(pct == null ? {} : { rate_limits: { secondary: { used_percent: pct, window_minutes: 10080, resets_at: reset / 1000 } } }),
  } };
}
function rollout(cwd, events, id = 'review-usage') {
  const file = path.join(process.env.CODEX_HOME, 'sessions', `rollout-${id}.jsonl`);
  fs.writeFileSync(file, [{ type: 'session_meta', payload: { id, cwd, model_provider: 'openai' } },
    { type: 'turn_context', payload: { model: 'gpt-5.2' } }, ...events].map(JSON.stringify).join('\n') + '\n');
  return file;
}

for (const clear of ['clearResolved', 'clearResolvedIds']) test(`review: ${clear} cannot erase an append acknowledged during its rename`, () => {
  const { cwd } = fresh(), s = 'rewrite'; C.ensureStore(s);
  C.appendLog(s, { ts: Date.now(), tool: 'Edit', file: path.join(cwd, 'old'), beforeBlob: null, afterBlob: null, status: 'kept' });
  const rename = fs.renameSync; let result;
  fs.renameSync = function (a, b) {
    if (String(b) === C.logPath(s)) {
      const r = cp.spawnSync(process.execPath, [child, 'append', s, path.join(cwd, 'new')], { encoding: 'utf8', timeout: 15000 });
      assert.equal(r.status, 0, r.stderr); result = JSON.parse(r.stdout);
    }
    return rename.call(fs, a, b);
  };
  try { C[clear](s, ...(clear === 'clearResolvedIds' ? [[1]] : [])); }
  finally { fs.renameSync = rename; }
  assert.equal(result.ok, false, 'a write that cannot commit must not report success');
  assert.equal(C.readLog(s).length, 0);
  assert.equal(C.readSkips(s).length, 1, 'the refusal remains visible after the rewrite');
  assert.equal(C.captureIntegrity(s).healthy, false);
  C.gcSession(s); assert.equal(C.readSkips(s).length, 1);
  C.appendLog(s, { ts: Date.now(), tool: 'Edit', file: path.join(cwd, 'later'), beforeBlob: null, afterBlob: null, status: 'kept' });
  C.clearResolved(s); assert.equal(C.readSkips(s).length, 1);
  fs.writeFileSync(path.join(cwd, '.observatoryignore'), 'new\n');
  C.dropIgnored(s); assert.equal(C.readSkips(s).length, 0, 'ignore sweeps include contention diagnostics');
});

test('review: status operations and capture callbacks cannot bypass an occupied transaction', () => {
  const { cwd } = fresh(), s = 'blocked', f = path.join(cwd, 'f'); C.ensureStore(s); fs.writeFileSync(f, 'before\n');
  C.withFileMutation(path.join(C.storeDir(s), '__capture-operation'), () => {
    // A hook waits up to 15 s for this mutex before it gives up, so the child needs longer than that.
    const r = cp.spawnSync(process.execPath, [child, 'hook', s, f], { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { staged: 0, skips: 1 });
  });
  C.appendLog(s, { ts: Date.now(), tool: 'Edit', file: f, beforeBlob: null, afterBlob: null, status: 'kept' });
  C.withBashPreLock(s, () => {
    const r = cp.spawnSync(process.execPath, [child, 'status', s, f], { encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).ok, false);
    assert.equal(C.readLog(s)[0].status, 'kept');
  });
});

test('review: aging an outstanding Claude or Codex call never turns overlap into safe Undo', () => {
  for (const codex of [true, false]) for (const ids of [true, false]) {
    const { cwd } = fresh(), s = 'delayed', f = path.join(cwd, 'f'); fs.writeFileSync(f, 'before\n');
    hook(s, cwd, f, 'PreToolUse', ids ? 'A' : undefined, codex);
    ageStaging(s, 2 * DAY); C.reapStaleManifests(s); C.gcSession(s);
    assert.equal(C.hasInflightCapture(s), true);
    hook(s, cwd, f, 'PreToolUse', ids ? 'B' : undefined, codex);
    fs.writeFileSync(f, 'before\nA\nB\n');
    hook(s, cwd, f, 'PostToolUse', ids ? 'B' : undefined, codex);
    hook(s, cwd, f, 'PostToolUse', ids ? 'A' : undefined, codex);
    const rows = C.readLog(s); assert.equal(rows.length, 1); assert.equal(rows[0].partial, true);
    assert.equal(C.readBlob(s, rows[0].beforeBlob).toString(), 'before\n');
    assert.equal(C.undoEdit(s, rows[0].id).ok, false);
    assert.equal(fs.readFileSync(f, 'utf8'), 'before\nA\nB\n');
  }
});

test('review: live snapshot ownership survives retention horizons and GC', () => {
  fresh(); const s = 'lease'; C.ensureStore(s); const sha = C.writeBlob(s, Buffer.from('retained'));
  const token = C.writeSnapshotLease(s, { f: sha }); ageStaging(s, 2 * DAY);
  assert.equal(C.hasInflightCapture(s), true); C.gcSession(s);
  assert.equal(C.hasInflightCapture(s), true); assert.equal(C.readBlob(s, sha).toString(), 'retained');
  C.releaseSnapshotLease(s, token); C.gcSession(s); assert.throws(() => C.readBlob(s, sha));
});

test('review: historical quota is never relabelled after account switches or merged from legacy exports', async () => {
  const { cwd } = fresh(), now = Date.now();
  rollout(cwd, [event(now - 60000, 1000, 87, now + 3 * DAY)]);
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture', expiresAt: now + DAY } }));
  const cache = path.join(process.env.CLAUDE_CONFIG_DIR, 'statusline-last.json');
  const fetch = global.fetch; global.fetch = async () => ({ ok: true, json: async () => ({ five_hour: { utilization: 1 } }) });
  try {
    for (const account of ['A', 'B', 'A', null]) {
      const auth = path.join(process.env.CODEX_HOME, 'auth.json');
      if (account) fs.writeFileSync(auth, JSON.stringify({ tokens: { account_id: account } })); else fs.unlinkSync(auth);
      fs.writeFileSync(cache, JSON.stringify({ gpt_ts: now, gpt_account: 'unsafe-old-export', gpt_week_pct: 87 }));
      assert.equal(await C.pullAccountUsage(), true);
      const exported = JSON.parse(fs.readFileSync(cache));
      assert.equal(exported.gpt_account, undefined); assert.equal(exported.gpt_week_pct, undefined);
      fs.mkdirSync(C.rootDir(), { recursive: true });
      fs.writeFileSync(path.join(C.rootDir(), 'remote-usage.json'), JSON.stringify({ at: now, machines: [{ name: 'remote', host: 'fixture', v: 3, atMs: now,
        gptAccount: C.codexAccountId(), gptTs: now, gptWeekPct: 42, gptWeekReset: now + 3 * DAY }] }));
      const g = C.gptUsagePanel(); assert.equal(g.weekPct, 87);
      // Month budget is estimated the SAME way claude's is (weekly total, tokens ÷ fill, projected
      // across the cycle by days). 1000 tokens at 87% ⇒ round(1000/0.87)=1149 per week; the month
      // scales that by its day count. This is the positive control for the gpt month %.
      assert.equal(g.weekTotal, 1149);
      const mdays = Math.round((g.monthReset - g.monthStart) / 86400000);
      assert.equal(g.monthTokTotal, Math.round((1149 * mdays) / 7));
      assert.equal(g.monthCostTotal, null);
      // End to end: the status readout's gpt month is now a %, computed by the SAME expression as
      // claude's (tokens / projected total) — no longer the hardcoded null it used to be.
      const brief = C.usageBrief(cwd);
      assert.ok(brief.gpt && brief.gpt.month.pct !== null, 'gpt month reads as a percentage now');
      assert.equal(brief.gpt.month.pct, Math.min(100, (g.monthTok / g.monthTokTotal) * 100), 'gpt month % mirrors claude’s tokens/total');
    }
  } finally { global.fetch = fetch; }
});

test('review: exact quota resets exclude prior-window tokens and polling uses one event cache', () => {
  const { cwd } = fresh(), now = Date.now(), start = Math.floor(now / DAY) * DAY - 4 * DAY + 12 * 3600000;
  rollout(cwd, [event(start - 1, 1000), event(start, 1100), event(start + 1, 1200), event(now - 60000, 1200, 10, start + 7 * DAY)]);
  assert.equal(C.gptUsagePanel().weekTok, 200);
  const F = require('../dist/fscache'), cached = F.cachedByFiles, kinds = new Set();
  F.cachedByFiles = function (kind, ...args) { if (kind.startsWith('codex-cycle')) kinds.add(kind); return cached(kind, ...args); };
  try { for (let i = 0; i < 100; i++) C.gptUsagePanel(undefined, now + 8 * DAY + i); }
  finally { F.cachedByFiles = cached; }
  assert.equal(kinds.size, 1, 'moving fallback boundaries do not mint cache namespaces');
  assert.equal(C.gptUsagePanel(undefined, now + 8 * DAY)?.weekTok ?? null, null);
});

test('review: GPT month and selected-session usage ignore Claude billing state across calendar rollovers', () => {
  for (const date of ['2026-01-31T23:59:59Z', '2026-02-15T12:00:00Z', '2028-02-29T12:00:00Z', '2026-04-30T23:59:59Z']) {
    const { cwd } = fresh(), now = Date.parse(date), d = new Date(now), start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    rollout(cwd, [event(start - 1, 1000), event(start, 1200), event(now, 1300)]);
    fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'statusline-usage.json'), JSON.stringify({ mo_start: (now - 45 * DAY) / 1000, mo_end: (now - 15 * DAY) / 1000 }));
    const g = C.gptUsagePanel(undefined, now);
    assert.equal(g.monthTok, 300); assert.equal(g.monthStart, start);
    assert.equal(g.monthReset, Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    assert.equal(C.gptUsagePanel(undefined, g.monthReset), null, 'old month tokens roll out without a Claude refresh');
  }
  const { cwd } = fresh(), now = Date.now(); rollout(cwd, [event(now - 1000, 1000)]);
  const g = C.gptUsagePanel(), u = C.usageLine(cwd, 'review-usage');
  assert.equal(u.monthTokens, g.monthTok); assert.equal(u.monthReset, g.monthReset);
  assert.equal(u.monthTokensTotal, null); assert.equal(u.usageFrom, 'codex');
});

test('review: a stale Claude monthly reset rolls forward to the next boundary, not "now"', () => {
  // The claude (non-codex) usage path reads the statusline cache. Seed a month_reset 40 days in the
  // PAST (seconds, as the statusline writes it). Before the fix this landed verbatim (raw *1000, and
  // — alone among the windows — never rolled forward), so the editors' `resets in` math rendered a
  // past anchor as "now". The month is now unit-normalized (toEpochMs) and rolled by whole calendar
  // months, exactly as 5h/wk/fable already were.
  const { cwd } = fresh(), now = Date.now();
  const past = Math.floor((now - 40 * DAY) / 1000);
  fs.writeFileSync(path.join(C.claudeConfigDir(), 'statusline-last.json'), JSON.stringify({ month_reset: past, month_tok: 5000, month_tok_total: 100000 }));
  const u = C.usageLine(cwd, 'stale-month');
  assert.ok(u.monthReset && u.monthReset > now, `a 40-day-stale month anchor rolls to the future (got ${u.monthReset ? new Date(u.monthReset).toISOString() : u.monthReset})`);
  assert.ok(u.monthReset - now < 32 * DAY, 'to the NEXT boundary — within a month, not left a fixed period behind');
  // POSITIVE CONTROL: a FUTURE anchor passes through untouched (the roll only heals a past one).
  const fut = Math.floor((now + 20 * DAY) / 1000);
  fs.writeFileSync(path.join(C.claudeConfigDir(), 'statusline-last.json'), JSON.stringify({ month_reset: fut, month_tok: 5000, month_tok_total: 100000 }));
  assert.equal(C.usageLine(cwd, 'stale-month').monthReset, fut * 1000, 'a future anchor is unchanged');
});

test('review: model-free quota RPC binds the backend account and closes its process on every outcome', async () => {
  const fixture = path.join(__dirname, 'fixtures/quota-server.cjs');
  // `account/updated` names no account (Codex 0.156.1 sends it for the same login on every connection),
  // so it never fails a read: 'notification' and 'routing' succeed, and only the reply's account id decides.
  const reads = ['good', 'notification', 'routing'];
  for (const mode of [...reads, 'missing', 'mismatch', 'routing-mismatch', 'error', 'hang']) {
    const { base } = fresh();
    fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({ tokens: { account_id: 'A' } }));
    const methods = path.join(base, 'methods');
    const p = cp.spawn(process.execPath, [fixture], { env: { ...process.env, OAK_TEST_QUOTA_MODE: mode, OAK_TEST_QUOTA_METHODS: methods }, stdio: ['pipe', 'pipe', 'pipe'] });
    const why = [];
    const q = await C.readCodexAccountQuotaOverChild(p, C.codexAccountId(), mode === 'hang' ? 1000 : 5000, false, (w) => why.push(w));
    assert.ok(p.exitCode !== null || p.signalCode !== null, 'the owned process is closed before returning');
    if (reads.includes(mode)) { assert.deepEqual(why, [], mode); assert.equal(q.weekPct, 20); assert.equal(q.fivePct, null); assert.equal(q.account, C.codexAccountId()); }
    else { assert.equal(q, null, mode); assert.equal(why.length, 1, `${mode} says why exactly once`); assert.ok(why[0].length > 10, why[0]); }
    if (mode.endsWith('mismatch')) assert.match(why[0], /named another account/, 'the reply\'s account id refuses it');
    assert.deepEqual(fs.readFileSync(methods, 'utf8').trim().split('\n'), ['initialize', 'initialized', 'account/rateLimits/read']);
  }
});

test('review: a failed Codex quota read says why in doctor, and backs off instead of starting app-server every minute', { skip: process.platform === 'win32' && 'POSIX fake codex' }, async (t) => {
  const { base } = fresh();
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({ tokens: { account_id: 'A' } }));
  const methods = path.join(base, 'methods');
  const fake = path.join(base, 'fake-codex');
  fs.writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, 'fixtures/quota-server.cjs')}"\n`, { mode: 0o755 });
  const prev = { path: process.env.CODEX_PATH, mode: process.env.OAK_TEST_QUOTA_MODE, methods: process.env.OAK_TEST_QUOTA_METHODS };
  t.after(() => { for (const [k, v] of [['CODEX_PATH', prev.path], ['OAK_TEST_QUOTA_MODE', prev.mode], ['OAK_TEST_QUOTA_METHODS', prev.methods]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  Object.assign(process.env, { CODEX_PATH: fake, OAK_TEST_QUOTA_MODE: 'error', OAK_TEST_QUOTA_METHODS: methods });
  const reads = () => fs.readFileSync(methods, 'utf8').split('\n').filter((m) => m === 'initialize').length;
  assert.equal(C.diagnoseCodexQuota(), null, 'nothing read yet: no row');
  assert.equal(await C.pullCodexAccountUsage(), false);
  const row = C.diagnoseCodexQuota();
  assert.equal(row.level, 'warn');
  assert.match(row.detail, /the last read failed .*account\/rateLimits\/read failed: unsupported/);
  assert.match(row.fix, /codex login/);
  assert.equal(await C.pullCodexAccountUsage(), false);
  assert.equal(reads(), 1, 'the next claim within 5 minutes starts no codex app-server');
  // The login is fixed and the backoff has passed: the next read succeeds, and doctor says so.
  process.env.OAK_TEST_QUOTA_MODE = 'good';
  fs.rmSync(C.codexAccountQuotaPath() + '.pull-retry');
  assert.equal(await C.pullCodexAccountUsage(), true);
  assert.equal(C.diagnoseCodexQuota().level, 'ok');
  // The login switches while a read is in flight and the reply still names the old account: the
  // post-read login check keeps it out of the cache.
  fs.rmSync(C.codexAccountQuotaPath());
  process.env.OAK_TEST_QUOTA_MODE = 'switch';
  assert.equal(await C.pullCodexAccountUsage(), false);
  assert.equal(fs.existsSync(C.codexAccountQuotaPath()), false, 'nothing is cached for the old login');
  assert.match(C.diagnoseCodexQuota().detail, /the Codex login changed during the read/);
});

// ── Fixes to the review engine ──────────────────────────────────────────────────────────

test('review: an abandoned typed Pre is cleared at turn end, so the next turn captures the file cleanly', () => {
  const { cwd } = fresh();
  const s = 'sess-abandon';
  const file = path.join(cwd, 'f.ts');
  fs.writeFileSync(file, 'v1\n');
  // A typed Edit fires Pre but is denied/fails: no Post. Its before-snapshot lingers in staging.
  hook(s, cwd, file, 'PreToolUse', 'callA', false);
  assert.equal(C.hasInflightCapture(s), true, 'the abandoned Pre is staged');
  // Turn ends. Without the backstop this snapshot would poison every later edit of the file.
  C.handleHookPayload({ session_id: s, cwd, hook_event_name: 'Stop' });
  assert.equal(C.hasInflightCapture(s), false, 'Stop cleared the abandoned typed Pre');
  // Next turn edits the same file, fully paired.
  hook(s, cwd, file, 'PreToolUse', 'callB', false);
  fs.writeFileSync(file, 'v2\n');
  hook(s, cwd, file, 'PostToolUse', 'callB', false);
  const recs = C.readLog(s).filter((r) => r.file === file && r.status !== 'undone');
  const last = recs[recs.length - 1];
  assert.ok(last, 'the clean edit was recorded');
  assert.ok(!last.partial, 'it is NOT review-only — the abandoned Pre no longer makes it ambiguous');
  assert.notEqual(last.attribution, 'ambiguous');
  assert.equal(C.undoEdit(s, last.id).ok, true, 'and ordinary Undo succeeds');
});

test('review: .observatoryignore redaction drops an ignored file\'s CONTENT even when it rides in a sibling field', () => {
  const { cwd } = fresh();
  const s = 'sess-ignore';
  fs.writeFileSync(path.join(cwd, '.observatoryignore'), 'secret.txt\n');
  // A tool_call update: the path is in `locations`, the read RESULT in a sibling `content` — the shape
  // the old path-object-scoped redaction leaked.
  C.appendCaptureEvent(s, 'update', { sessionUpdate: 'tool_call', toolCallId: 't1',
    locations: [{ path: path.join(cwd, 'secret.txt') }],
    content: [{ type: 'content', content: { type: 'text', text: 'TOPSECRETVALUE' } }],
    rawOutput: 'TOPSECRETVALUE again' }, cwd);
  const dumped = JSON.stringify(C.readCaptureEvents(s, ['update']));
  assert.ok(!dumped.includes('TOPSECRETVALUE'), 'ignored-file content is redacted from the journal');
  assert.ok(dumped.includes('observatoryignore'), 'the redaction marker is present');
});

test('review: a forked rollout\'s first token_count takes the turn\'s own last_token_usage, not the inherited cumulative', () => {
  const { cwd } = fresh();
  const id = 'forked';
  const file = path.join(process.env.CODEX_HOME, 'sessions', `rollout-${id}.jsonl`);
  // First event carries a PARENT cumulative (big) in total_token_usage and THIS turn's own small
  // breakdown in last_token_usage — the real fork shape.
  const lines = [
    { type: 'session_meta', payload: { id, cwd, model_provider: 'openai', forked_from_id: 'parent' } },
    { type: 'turn_context', payload: { model: 'gpt-5.2' } },
    { timestamp: '2026-09-11T00:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 1_000_000, cached_input_tokens: 200_000, output_tokens: 50_000 },
      last_token_usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 10 } } } },
  ];
  fs.writeFileSync(file, lines.map(JSON.stringify).join('\n') + '\n');
  const d = C.codexUsageDeltas(file);
  assert.equal(d.length, 1);
  // uncached input (120-20=100) + output (10) = 110, NOT the parent's ~1,050,000.
  assert.equal(d[0].usage.input + d[0].usage.output, 110, 'first delta is the turn\'s own, parent history excluded');
});

test('review: oak clean never treats a non-session store directory as an empty stub', () => {
  fresh();
  const root = C.storeDir('x').replace(/\/x$/, '');
  for (const d of ['.file-locks', 'runtime-transcripts', 'remote-cache', 'agent-prefs-codex-acp']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
    assert.equal(C.pruneEmptySession(d), false, `${d} is reserved, never pruned`);
  }
  assert.ok(!C.allStoreSessionIds().some((id) => ['.file-locks', 'runtime-transcripts', 'remote-cache'].includes(id) || id.startsWith('agent-prefs-')),
    'reserved dirs are not listed as sessions');
});

test('review: codex session list skips empty stubs and gone-temp-dir throwaways (codex clutter fix)', () => {
  const { cwd } = fresh();
  const userMsg = { timestamp: '2026-09-14T00:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'hi' } };
  rollout(cwd, [userMsg], 'real-1');                              // real session, real cwd — listed
  rollout(cwd, [], 'stub-1');                                     // session_meta only, no prompt — skipped
  rollout(path.join(os.tmpdir(), 'oak-gone-' + Date.now()), [userMsg], 'tmp-1'); // gone temp cwd — skipped
  const ids = C.codexSessionSources().map((s) => s.id);
  assert.ok(ids.includes('real-1'), 'a real codex session is listed');
  assert.ok(!ids.includes('stub-1'), 'an empty stub (no user message) is skipped');
  assert.ok(!ids.includes('tmp-1'), 'a throwaway run in a gone temp dir is skipped');
});

test('review: deleting a session removes it from every picker and undelete restores it (delete-session)', () => {
  const { cwd } = fresh();
  // A codex session that appears in the session list (real rollout, real cwd, a user prompt).
  rollout(cwd, [{ timestamp: '2026-09-14T00:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'hi' } }], 'del-me');
  const listed = () => C.sessionMeta(cwd).sessions.some((s) => s.id === 'del-me');
  assert.ok(listed(), 'the session is listed before deletion');
  C.deleteSession('del-me');
  assert.ok(C.isSessionHidden('del-me'), 'it is now on the hidden list');
  assert.ok(!listed(), 'and gone from the session picker');
  assert.ok(!C.listSessionsWithTitles(cwd).some((s) => s.id === 'del-me'), 'gone from the titled list too');
  C.unhideSession('del-me');
  assert.ok(!C.isSessionHidden('del-me'));
  assert.ok(listed(), 'undelete restores it to the picker');
});

// Every editor deletes through this function. The purge takes a pending edit's before-snapshot with it,
// and undelete never brings it back, so a session holding one is refused unless the caller's
// confirmation named it (only the CLI verb checked).
test('review: deleting a session with edits pending review is refused unless forced; undelete restores the session, not the edits', () => {
  const { cwd } = fresh();
  const file = path.join(cwd, 'a.txt');
  fs.writeFileSync(file, 'after\n');
  C.ensureStore('del-pending');
  C.appendLog('del-pending', { id: 1, ts: 1000, tool: 'Edit', file, status: 'pending',
    beforeBlob: C.writeBlob('del-pending', Buffer.from('before\n')), afterBlob: C.writeBlob('del-pending', Buffer.from('after\n')) });
  assert.equal(C.sessionCounts('del-pending').pending, 1, 'control: one edit is pending');
  assert.throws(() => C.deleteSession('del-pending'), /1 edit pending review; deleting the session would purge it for good/);
  assert.ok(!C.isSessionHidden('del-pending'), 'a refused delete hides nothing');
  assert.equal(C.readLog('del-pending').length, 1, '…and purges nothing');
  C.deleteSession('del-pending', { confirmedPending: 1 });
  assert.ok(C.isSessionHidden('del-pending'), 'confirmed, it is deleted');
  assert.ok(!fs.existsSync(C.storeDir('del-pending')), '…with its store');
  C.unhideSession('del-pending');
  assert.equal(C.readLog('del-pending').length, 0, 'undelete lists the session again without its edits');
  // Nothing pending: no confirmation of edits is needed.
  C.ensureStore('del-kept');
  C.appendLog('del-kept', { id: 1, ts: 1000, tool: 'Edit', file, status: 'kept',
    beforeBlob: C.writeBlob('del-kept', Buffer.from('before\n')), afterBlob: C.writeBlob('del-kept', Buffer.from('after\n')) });
  C.deleteSession('del-kept');
  assert.ok(C.isSessionHidden('del-kept'));
});

// The confirm named N > 0 pending edits and more are pending when the delete runs: every editor used to
// pass `force`, which purged them all, including edits captured while the dialog was open.
test('review: a delete confirmed for N pending edits refuses when more are pending, and counts under the capture mutex', async () => {
  const { cwd } = fresh();
  // One edit per file, so each is its own review unit.
  const pend = (s) => { const id = C.nextId(s); C.appendLog(s, { id, ts: Date.now(), tool: 'Edit', file: path.join(cwd, `f${id}.txt`), status: 'pending',
    beforeBlob: C.writeBlob(s, Buffer.from('before\n')), afterBlob: C.writeBlob(s, Buffer.from(`after ${id}\n`)) }); };
  C.ensureStore('del-late'); pend('del-late'); pend('del-late');
  pend('del-late'); // captured while a dialog naming 2 was open
  assert.equal(C.sessionCounts('del-late').pending, 3, 'control: three edits pending');
  assert.throws(() => C.deleteSession('del-late', { confirmedPending: 2 }), /^Error: del-late has 3 edits pending review, more than the 2 this delete confirmed; deleting the session would purge the rest unseen, so it was not deleted$/);
  assert.ok(!C.isSessionHidden('del-late') && C.readLog('del-late').length === 3, 'refused: nothing hidden, nothing purged');
  C.deleteSession('del-late', { confirmedPending: 5 });
  assert.ok(C.isSessionHidden('del-late') && !fs.existsSync(C.storeDir('del-late')), 'no more than named: deleted');
  // A capture holds the session's capture mutex while its edit lands. A delete asked meanwhile waits for it
  // and counts that edit too, so it is refused rather than purging it between the count and the purge.
  C.ensureStore('del-racing'); pend('del-racing');
  const held = path.join(cwd, 'held');
  const capture = cp.spawn(process.execPath, ['-e', `const C = require(${JSON.stringify(require.resolve('../dist'))}), fs = require('fs'), s = 'del-racing';
C.withFileMutation(C.captureMutex(s), () => {
  fs.writeFileSync(${JSON.stringify(held)}, '');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150); // well inside the delete's short wait
  C.appendLog(s, { id: C.nextId(s), ts: Date.now(), tool: 'Edit', file: ${JSON.stringify(path.join(cwd, 'captured.txt'))}, status: 'pending',
    beforeBlob: C.writeBlob(s, Buffer.from('before\\n')), afterBlob: C.writeBlob(s, Buffer.from('captured\\n')) });
});`], { env: process.env, stdio: 'inherit' });
  const exited = new Promise((resolve) => capture.on('exit', resolve));
  for (let i = 0; i < 500 && !fs.existsSync(held); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fs.existsSync(held), 'control: the capture holds the mutex');
  assert.throws(() => C.deleteSession('del-racing', { confirmedPending: 1 }), /del-racing has 2 edits pending review, more than the 1/);
  assert.equal(await exited, 0, 'the capture finished');
  assert.ok(!C.isSessionHidden('del-racing') && C.sessionCounts('del-racing').pending === 2, 'the edit it captured is kept, and the session with it');
});

// The confirm counts review units. An edit that rewrites the lines of a change it already counted, in the
// same ask, JOINS that change: the count does not move, and a delete checked by the count alone purged the
// edit unseen. The listing's newest record id rides with its count now, and the
// delete refuses any pending record newer than it.
test('review: a delete refuses an edit captured after its listing, even one that joined a change the count already named', () => {
  const { cwd } = fresh(), S = 'del-join';
  C.ensureStore(S);
  const rec = (file, before, after) => {
    C.appendLog(S, { ts: Date.now(), tool: 'Edit', file, status: 'pending', promptId: 'ask-1',
      beforeBlob: C.writeBlob(S, Buffer.from(before)), afterBlob: C.writeBlob(S, Buffer.from(after)) });
    fs.writeFileSync(file, after);
  };
  const A = path.join(cwd, 'a.py'), B = path.join(cwd, 'b.py');
  rec(A, 'x = 1\n', 'x = 2\n');
  rec(B, 'def f():\n    return 1\n', 'def f():\n    return 2\n');
  rollout(cwd, [{ timestamp: '2026-09-27T00:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: 'edit a and b' } }], S);
  const shown = C.sessionMeta(cwd).sessions.find((r) => r.id === S); // the row the confirm reads
  assert.deepEqual([shown.pending, shown.lastEdit], [2, 2], 'the listing names two changes, and the newest record it saw');
  rec(B, 'def f():\n    return 2\n', 'def f():\n    return 3\n'); // captured while the confirm is open
  assert.equal(C.sessionCounts(S).pending, 2, 'control: the new edit joined a counted change, so the count did not move');
  assert.deepEqual(C.groupMembers(S, 3), [2, 3], 'control: …the change #2 started');
  assert.throws(() => C.deleteSession(S, { confirmedPending: shown.pending, seenThrough: shown.lastEdit }),
    /^Error: del-join captured an edit after the listing this delete was confirmed from, still pending review; deleting the session would purge it unseen, so it was not deleted$/);
  assert.ok(!C.isSessionHidden(S) && C.readLog(S).length === 3 && fs.existsSync(C.storeDir(S)), 'refused: nothing hidden, nothing purged');
  // A listing read after it saw it; confirmed from that one, the delete goes ahead.
  const again = C.sessionCounts(S);
  assert.equal(again.lastEdit, 3);
  C.deleteSession(S, { confirmedPending: again.pending, seenThrough: again.lastEdit });
  assert.ok(C.isSessionHidden(S) && !fs.existsSync(C.storeDir(S)), 'deleted');
});

// The counts read the log more than once. An edit captured while they are counted must come out newer than the
// `lastEdit` they report: read after the units, it covered an edit the units may not have seen, and a delete
// confirmed from them purged that edit when it had joined a counted change.
test('review: an edit captured while the listing counts is newer than the newest edit the listing reports', () => {
  const { cwd } = fresh(), S = 'del-counting';
  C.ensureStore(S);
  const B = path.join(cwd, 'b.py');
  const rec = (before, after) => C.appendLog(S, { ts: Date.now(), tool: 'Edit', file: B, status: 'pending', promptId: 'ask-1',
    beforeBlob: C.writeBlob(S, Buffer.from(before)), afterBlob: C.writeBlob(S, Buffer.from(after)) });
  rec('def f():\n    return 1\n', 'def f():\n    return 2\n');
  // The capture lands right after the counts' first read of this session's log, as it can between any two.
  const store = require('../dist/store'), readLog = store.readLog;
  let reads = 0;
  store.readLog = (s) => { const out = readLog(s); if (s === S && reads++ === 0) rec('def f():\n    return 2\n', 'def f():\n    return 3\n'); return out; };
  let counts;
  try { counts = C.sessionCounts(S); } finally { store.readLog = readLog; }
  assert.equal(C.readLog(S).length, 2, 'control: the edit landed while the counts were read');
  assert.deepEqual(C.groupMembers(S, 2), [1, 2], 'control: …and joined the change the counts name');
  assert.equal(counts.pending, 1);
  assert.throws(() => C.deleteSession(S, { confirmedPending: counts.pending, seenThrough: counts.lastEdit }),
    /^Error: del-counting captured an edit after the listing this delete was confirmed from/);
  assert.ok(!C.isSessionHidden(S) && C.readLog(S).length === 2, 'refused: nothing hidden, nothing purged');
});

// `lastEdit` is the newest of EVERY record, because the delete checks every pending record: a pending chain
// that cancels out (a file created and deleted again) is in no count, and a listing that stopped at the last
// counted record would have its own delete refused, again at every retry. Counts cached before `lastEdit`
// existed are counted again rather than served without it.
test('review: the listing\'s newest edit covers records no count shows, and counts cached without it are recounted', () => {
  const { cwd } = fresh(), S = 'del-chain';
  C.ensureStore(S);
  const f = path.join(cwd, 'kept.txt'), scratch = path.join(cwd, 'scratch.txt');
  C.appendLog(S, { ts: 1, tool: 'Edit', file: f, status: 'pending', promptId: 'ask-1', beforeBlob: C.writeBlob(S, Buffer.from('a\n')), afterBlob: C.writeBlob(S, Buffer.from('b\n')) });
  C.appendLog(S, { ts: 2, tool: 'Write', file: scratch, status: 'pending', promptId: 'ask-1', beforeBlob: null, afterBlob: C.writeBlob(S, Buffer.from('tmp\n')) });
  C.appendLog(S, { ts: 3, tool: 'Bash', file: scratch, status: 'pending', promptId: 'ask-1', beforeBlob: C.writeBlob(S, Buffer.from('tmp\n')), afterBlob: null });
  // What an earlier build cached for exactly this log: the counts without `lastEdit`, under that build's stamp.
  const st = fs.statSync(C.logPath(S));
  const sidecar = path.join(C.rootDir(), 'session-meta', `${S}.json`);
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  fs.writeFileSync(sidecar, JSON.stringify({ counts: { edits: 1, pending: 1, files: 1, added: 1, removed: 1 }, countsStamp: `6|${st.mtimeMs}:${st.size}` }));
  const counts = C.sessionCounts(S);
  const restamped = JSON.parse(fs.readFileSync(sidecar, 'utf8')).countsStamp;
  assert.notEqual(restamped, `6|${st.mtimeMs}:${st.size}`, 'the cached counts were replaced…');
  assert.equal(restamped.replace(/^\d+\|/, ''), `${st.mtimeMs}:${st.size}`, 'control: …under a stamp that differs from theirs only in its version');
  assert.deepEqual([...C.cancelledMemberIds(S)].sort(), [2, 3], 'control: the create-then-delete cancels out');
  assert.equal(counts.pending, 1, 'control: …so the count names only the edit to kept.txt');
  assert.equal(counts.lastEdit, 3, 'the newest record, counted or not, and not a cache from before lastEdit');
  C.deleteSession(S, { confirmedPending: counts.pending, seenThrough: counts.lastEdit });
  assert.ok(C.isSessionHidden(S) && !fs.existsSync(C.storeDir(S)), 'a delete confirmed from that listing goes ahead');
});

// VS Code's extension host and the terminal app delete in-process. Behind a capture that held the mutex,
// the delete slept out the file lock's 5 s on their thread, then failed with that lock's message, "…is
// modifying this file". It waits briefly now, and says what is going on.
test('review: a delete behind a capture in progress refuses at once, naming the capture, and leaves the session', async () => {
  const { cwd } = fresh();
  C.ensureStore('del-busy');
  const held = path.join(cwd, 'held');
  const capture = cp.spawn(process.execPath, ['-e', `const C = require(${JSON.stringify(require.resolve('../dist'))});
C.withFileMutation(C.captureMutex('del-busy'), () => {
  require('fs').writeFileSync(${JSON.stringify(held)}, '');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000);
}, 15000);`], { env: process.env, stdio: 'inherit' });
  try {
    for (let i = 0; i < 500 && !fs.existsSync(held); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(fs.existsSync(held), 'control: the capture holds the mutex');
    const t0 = Date.now();
    assert.throws(() => C.deleteSession('del-busy'), /^Error: del-busy is recording an edit right now, so it was not deleted; try again in a moment$/);
    const waited = Date.now() - t0;
    assert.ok(waited < 2000, `the delete held its caller's thread for ${waited} ms`);
    assert.ok(!C.isSessionHidden('del-busy') && fs.existsSync(C.storeDir('del-busy')), 'nothing hidden, nothing purged');
  } finally {
    capture.kill();
  }
});
