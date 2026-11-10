// Core with the session listing, the inbox, the search and the machine's newest session served from the local index, each
// checked against the old one on every call: run a listing test file with OAK_LISTING_TEST_DIST pointing here and every one
// of its assertions holds of the index's answer too. The old one runs first, so what it writes as it reads (its sidecars)
// is there as before. It reads the Codex rollouts afresh (forgetCodexSources): inside their 1 s window it read them as an
// earlier call had, before the test changed them, and an index answer that came after the window read them as they are.
const assert = require('node:assert/strict');
const real = require('../../dist');

function withIndex(fn, pending) {
  const ix = real.useIndex({ budgetMs: Infinity, inlineBytes: Infinity });
  if (!ix.ok) throw new Error(ix.reason);
  try {
    // The CLI falls back while a converter owns its output. The core turn-clock fixture deliberately holds that lock;
    // it can still exercise the files listing, but catch-up must no longer certify that incomplete snapshot.
    if (pending && !ix.catchUp.caughtUp && ix.catchUp.problems.some(p => p.includes('Codex transcript conversion is still in progress'))) return pending();
    assert.equal(ix.catchUp.caughtUp, true, `the index caught up: ${JSON.stringify(ix.catchUp.problems)}`);
    return fn(ix.db);
  } finally {
    ix.close();
  }
}

module.exports = {
  ...real,
  sessionMeta(cwd, reviewing, opts) {
    real.forgetCodexSources();
    const old = real.sessionMeta(cwd, reviewing, opts);
    return withIndex((db) => {
      const fromIndex = real.indexedSessionMeta(db, cwd, reviewing, opts);
      assert.deepEqual(fromIndex, old, 'the index lists what the files list');
      return fromIndex;
    }, () => old);
  },
  attentionInbox(cwd, opts = {}) {
    real.forgetCodexSources();
    const old = real.attentionInbox(cwd, opts);
    return withIndex((db) => {
      const fromIndex = real.indexedInbox(db, cwd, opts);
      const strip = (x) => ({ ...x, generatedAt: 0, hands: x.hands.map((h) => ({ ...h, waitingMs: 0, waitedTodayMs: 0 })) });
      assert.deepEqual(strip(fromIndex), strip(old), 'the inbox from the index is the inbox from the files');
      return { ...fromIndex, generatedAt: old.generatedAt, hands: fromIndex.hands.map((h, i) => ({ ...h, waitingMs: old.hands[i].waitingMs, waitedTodayMs: old.hands[i].waitedTodayMs })) };
    });
  },
  // The terminal app's "a newer session is live" hint asks the index for the machine's newest session (outside any
  // workspace), where it walked every transcript: the same answer.
  newestSessionGlobal() {
    const old = real.newestSessionGlobal();
    withIndex(() => {});
    const fromIndex = real.indexedNewestSession();
    assert.equal(fromIndex, old, 'the newest session from the index is the one the transcripts name');
    return fromIndex;
  },
  searchConversations(cwd, query, opts) {
    real.forgetCodexSources();
    const old = real.searchConversations(cwd, query, opts);
    return withIndex((db) => {
      const fromIndex = real.indexedSearch(db, cwd, query, opts);
      assert.deepEqual({ ...fromIndex, ms: 0, indexed: 0 }, { ...old, ms: 0, indexed: 0 }, `search "${query}" finds what the files find`);
      return { ...fromIndex, ms: old.ms, indexed: old.indexed };
    });
  },
};
