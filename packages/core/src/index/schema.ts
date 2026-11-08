/**
 * The index's schema. Every table is STRICT and keyed by the machine a row came from first (a session id can repeat
 * across machines), times are epoch milliseconds, and every field a query filters or sorts on is a typed column with an
 * index. Text is searched through FTS5. A row's whole record rides beside its columns for display, and is never scanned.
 *
 * Two ways the schema moves:
 * - A change a migration can make (a new table, column or index) is a step in MIGRATIONS, applied in order and counted
 *   in `PRAGMA user_version`. An OAK that finds a higher version than it knows writes nothing to that file.
 * - A change none can make bumps INDEX_FORMAT (location.ts): a new file is built from the sources. What the sources no
 *   longer hold, the archive (sessions whose files are gone, with every row they had), is carried over from the
 *   previous file before anything else is written (`carryArchive`), and that file is kept until the copy is verified.
 */
import type { DatabaseSync } from 'node:sqlite';

/** Tables whose rows belong to one session, keyed (machine_id, session_id, …): what a deliberate delete purges and
 *  what the archive carries into a new file. */
export const SESSION_TABLES = [
  'sessions', 'session_live', 'agents', 'workflow_runs', 'actions', 'prompts', 'edits', 'edit_ops', 'capture_gaps', 'units',
  'blobs', 'attention', 'waits', 'comments', 'usage_messages', 'usage_spend',
] as const;

const FTS = (name: string, content: string, cols: string[]): string => {
  const list = cols.join(', ');
  const newCols = cols.map((c) => `new.${c}`).join(', ');
  const oldCols = cols.map((c) => `old.${c}`).join(', ');
  // `secure-delete`: a deleted row leaves the full-text index at once, not at a later merge, so a session forgotten on
  // purpose leaves no searchable trace (PRAGMA secure_delete zeroes the pages it freed).
  return `
CREATE VIRTUAL TABLE ${name} USING fts5(${list}, content='${content}', tokenize='unicode61 remove_diacritics 2');
INSERT INTO ${name}(${name}, rank) VALUES ('secure-delete', 1);
CREATE TRIGGER ${name}_ai AFTER INSERT ON ${content} BEGIN
  INSERT INTO ${name}(rowid, ${list}) VALUES (new.rowid, ${newCols});
END;
CREATE TRIGGER ${name}_ad AFTER DELETE ON ${content} BEGIN
  INSERT INTO ${name}(${name}, rowid, ${list}) VALUES ('delete', old.rowid, ${oldCols});
END;
CREATE TRIGGER ${name}_au AFTER UPDATE OF ${list} ON ${content} BEGIN
  INSERT INTO ${name}(${name}, rowid, ${list}) VALUES ('delete', old.rowid, ${oldCols});
  INSERT INTO ${name}(rowid, ${list}) VALUES (new.rowid, ${newCols});
END;`;
};

/** Schema version 1. */
const V1 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE lease (id INTEGER PRIMARY KEY CHECK (id = 1), holder TEXT, pid INTEGER, until_ms INTEGER) STRICT;
INSERT INTO lease (id) VALUES (1);

CREATE TABLE machines (
  machine_id TEXT PRIMARY KEY,
  label TEXT,
  is_self INTEGER NOT NULL DEFAULT 0,
  home TEXT,
  platform TEXT,
  oak_version TEXT,
  skew_ms INTEGER NOT NULL DEFAULT 0,
  synced_through_ms INTEGER,
  last_seen_ms INTEGER
) STRICT;

CREATE TABLE sessions (
  machine_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  origin TEXT NOT NULL,
  listed INTEGER NOT NULL DEFAULT 0,
  review INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  first_prompt TEXT,
  workspace TEXT NOT NULL DEFAULT '',
  cwd TEXT,
  project_key TEXT,
  transcript_path TEXT,
  rollout_path TEXT,
  first_ms INTEGER,
  last_active_ms INTEGER NOT NULL DEFAULT 0,
  last_turn_ms INTEGER,
  capture_ms INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  cached INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL DEFAULT '',
  effort TEXT NOT NULL DEFAULT '',
  edits INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  last_edit_id INTEGER NOT NULL DEFAULT 0,
  gaps INTEGER NOT NULL DEFAULT 0,
  store_bytes INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  archived_ms INTEGER,
  archived_reason TEXT,
  archive_hint TEXT,
  inputs TEXT NOT NULL DEFAULT '',
  facts TEXT,
  facts_transcript TEXT,
  title_inputs TEXT,
  updated_ms INTEGER NOT NULL,
  PRIMARY KEY (machine_id, session_id)
) STRICT;
CREATE INDEX sessions_recent ON sessions(last_active_ms DESC);
CREATE INDEX sessions_project ON sessions(project_key, last_active_ms DESC);
CREATE INDEX sessions_workspace ON sessions(workspace, last_active_ms DESC);
CREATE INDEX sessions_archived ON sessions(archived_ms) WHERE archived_ms IS NOT NULL;
CREATE INDEX sessions_pending ON sessions(pending) WHERE pending > 0;
${FTS('sessions_fts', 'sessions', ['title', 'first_prompt'])}

CREATE TABLE session_live (
  machine_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  observed_ms INTEGER NOT NULL,
  transcript_mtime INTEGER,
  capture_mtime INTEGER,
  turn_open INTEGER,
  PRIMARY KEY (machine_id, session_id)
) STRICT;

CREATE TABLE attention (
  machine_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL,
  observed_ms INTEGER NOT NULL,
  PRIMARY KEY (machine_id, session_id)
) STRICT;
CREATE INDEX attention_kind ON attention(kind, ts);

CREATE TABLE waits (
  machine_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER,
  kind TEXT NOT NULL,
  PRIMARY KEY (machine_id, session_id, start_ms)
) STRICT;
CREATE INDEX waits_end ON waits(end_ms);

CREATE TABLE agents (
  machine_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  run_id TEXT,
  tool_use_id TEXT,
  agent_type TEXT,
  description TEXT,
  label TEXT,
  status TEXT,
  first_ts INTEGER,
  last_ts INTEGER,
  model TEXT,
  tokens INTEGER NOT NULL DEFAULT 0,
  actions INTEGER NOT NULL DEFAULT 0,
  edits INTEGER NOT NULL DEFAULT 0,
  transcript_path TEXT,
  record TEXT NOT NULL,
  PRIMARY KEY (machine_id, session_id, agent_id)
) STRICT;
CREATE INDEX agents_recent ON agents(last_ts DESC);
CREATE INDEX agents_run ON agents(run_id);

CREATE TABLE workflow_runs (
  machine_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  name TEXT,
  description TEXT,
  status TEXT,
  started_ts INTEGER,
  last_ts INTEGER,
  agents INTEGER NOT NULL DEFAULT 0,
  record TEXT NOT NULL,
  PRIMARY KEY (machine_id, session_id, run_id)
) STRICT;

CREATE TABLE actions (
  machine_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  tool_use_id TEXT,
  ts INTEGER NOT NULL,
  tool TEXT NOT NULL,
  category TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  path_abs TEXT,
  project_key TEXT,
  rel_path TEXT,
  is_error INTEGER NOT NULL DEFAULT 0,
  edit_id INTEGER,
  PRIMARY KEY (machine_id, session_id, seq)
) STRICT;
CREATE INDEX actions_session ON actions(machine_id, session_id, ts);
CREATE INDEX actions_file ON actions(project_key, rel_path, ts);
CREATE INDEX actions_path ON actions(path_abs);

CREATE TABLE prompts (
  machine_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  prompt_id TEXT,
  ts INTEGER NOT NULL,
  end_ts INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  response TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  -- 1 when the ask or its answer holds a NUL character: node:sqlite on Node 22 returns such a text cut at the NUL, so
  -- the code that must have all of it reads it as bytes (CAST(text AS BLOB)).
  nul INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (machine_id, session_id, idx)
) STRICT;
CREATE INDEX prompts_ts ON prompts(ts);
CREATE INDEX prompts_id ON prompts(prompt_id);
${FTS('prompts_fts', 'prompts', ['text', 'response'])}

CREATE TABLE edits (
  machine_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  id INTEGER NOT NULL,
  uid TEXT,
  ts INTEGER NOT NULL,
  tool TEXT NOT NULL,
  file TEXT NOT NULL,
  project_key TEXT,
  rel_path TEXT,
  ext TEXT,
  before_blob TEXT,
  after_blob TEXT,
  status TEXT NOT NULL,
  prompt_id TEXT,
  native_turn_id TEXT,
  tool_call_id TEXT,
  source TEXT,
  runtime TEXT,
  model TEXT,
  provenance TEXT,
  attribution TEXT,
  partial INTEGER NOT NULL DEFAULT 0,
  binary INTEGER NOT NULL DEFAULT 0,
  before_state TEXT,
  cleared_ms INTEGER,
  record TEXT NOT NULL,
  PRIMARY KEY (machine_id, session_id, id)
) STRICT;
CREATE INDEX edits_project_file ON edits(project_key, rel_path, status, ts);
CREATE INDEX edits_file ON edits(file, status);
CREATE INDEX edits_status ON edits(status, ts);
CREATE INDEX edits_session ON edits(machine_id, session_id, status, ts);
CREATE INDEX edits_prompt ON edits(prompt_id);
CREATE INDEX edits_call ON edits(tool_call_id);

CREATE TABLE edit_ops (
  machine_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ids TEXT NOT NULL,
  label TEXT,
  PRIMARY KEY (machine_id, session_id, seq)
) STRICT;

CREATE TABLE capture_gaps (
  machine_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  file TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (machine_id, session_id, seq)
) STRICT;
CREATE INDEX capture_gaps_reason ON capture_gaps(reason, ts);

CREATE TABLE edit_facts (
  machine_id TEXT NOT NULL,
  before_blob TEXT NOT NULL,
  after_blob TEXT NOT NULL,
  added INTEGER NOT NULL,
  removed INTEGER NOT NULL,
  PRIMARY KEY (machine_id, before_blob, after_blob)
) STRICT;

CREATE TABLE units (
  machine_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  rep_id INTEGER NOT NULL,
  members TEXT NOT NULL,
  file TEXT NOT NULL,
  status TEXT NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (machine_id, session_id, rep_id)
) STRICT;

CREATE TABLE blobs (
  machine_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  size INTEGER NOT NULL,
  present INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (machine_id, session_id, sha)
) STRICT;
CREATE INDEX blobs_sha ON blobs(sha);

CREATE TABLE comments (
  machine_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  unit INTEGER,
  pair TEXT,
  file TEXT NOT NULL DEFAULT '',
  line INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  created_ms INTEGER,
  sent_ms INTEGER,
  PRIMARY KEY (machine_id, session_id, comment_id)
) STRICT;
${FTS('comments_fts', 'comments', ['text', 'file'])}

CREATE TABLE notes (
  machine_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  project TEXT,
  title TEXT,
  text TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  sha TEXT NOT NULL,
  archived_ms INTEGER,
  PRIMARY KEY (machine_id, kind, path)
) STRICT;
${FTS('notes_fts', 'notes', ['title', 'text'])}

CREATE TABLE tombstones (
  machine_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  deleted_ms INTEGER NOT NULL,
  source TEXT NOT NULL,
  purged_ms INTEGER,
  PRIMARY KEY (machine_id, session_id)
) STRICT;

CREATE TABLE ingest_state (
  source TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  session_id TEXT,
  dev INTEGER,
  ino INTEGER,
  size INTEGER,
  mtime_ms REAL,
  cursor INTEGER NOT NULL DEFAULT 0,
  head_sha TEXT,
  anchor_sha TEXT,
  state TEXT,
  updated_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX ingest_state_session ON ingest_state(machine_id, session_id);

-- Phase is never stored: it depends on the time it is asked. This view computes a coarse one from stored inputs.
CREATE VIEW session_phase AS
  SELECT s.machine_id, s.session_id,
    CASE
      WHEN a.kind = 'permission' THEN 'awaiting-permission'
      WHEN a.kind IN ('input', 'question') THEN 'awaiting-input'
      WHEN l.turn_open = 1 THEN 'working'
      WHEN CAST(strftime('%s', 'now') AS INTEGER) * 1000 - max(s.last_active_ms, s.capture_ms) <= 300000 THEN 'working'
      WHEN a.kind = 'idle-done' THEN 'done'
      ELSE 'idle'
    END AS phase
  FROM sessions s
  LEFT JOIN attention a ON a.machine_id = s.machine_id AND a.session_id = s.session_id
  LEFT JOIN session_live l ON l.machine_id = s.machine_id AND l.session_id = s.session_id;
`;

/** One day's share of a message in `usage_daily`, for the rollup's triggers (`row` is `new` or `old`). */
const DAY_KEY = (row: string): string =>
  `day = strftime('%Y-%m-%d', ${row}.ts / 1000, 'unixepoch') AND machine_id = ${row}.machine_id AND agent = ${row}.agent AND account = coalesce(${row}.account, '') AND model = ${row}.model`;
const DAY_ADD = (row: string, sign: '+' | '-'): string => `UPDATE usage_daily SET messages = messages ${sign} 1, input = input ${sign} ${row}.input, output = output ${sign} ${row}.output,
    cache_create = cache_create ${sign} ${row}.cache_create, cache_read = cache_read ${sign} ${row}.cache_read, cost = cost ${sign} ${row}.cost WHERE ${DAY_KEY(row)};`;
// A plain INSERT behind NOT EXISTS, not INSERT OR IGNORE: a trigger's statements take the conflict policy of the statement
// that fired it, and the upsert that writes a message would turn IGNORE into ABORT on a day that already has a row.
const DAY_OPEN = (row: string): string => `INSERT INTO usage_daily (day, machine_id, agent, account, model, top_tier)
    SELECT strftime('%Y-%m-%d', ${row}.ts / 1000, 'unixepoch'), ${row}.machine_id, ${row}.agent, coalesce(${row}.account, ''), ${row}.model, ${row}.top_tier
    WHERE NOT EXISTS (SELECT 1 FROM usage_daily WHERE ${DAY_KEY(row)});`;
const DAY_CLOSE = (row: string): string => `DELETE FROM usage_daily WHERE ${DAY_KEY(row)} AND messages <= 0;`;

/** The tables whose rows another machine's record log can fill (records.ts): each row it filled says when (`synced_ms`). */
export const SYNCED_TABLES = [
  'sessions', 'prompts', 'actions', 'agents', 'workflow_runs', 'edits', 'edit_ops', 'capture_gaps', 'units', 'comments', 'edit_facts', 'notes', 'waits', 'blobs',
] as const;

/**
 * Schema version 2: usage, from every machine.
 *
 * - `usage_messages`: one row per assistant message (Claude Code's message id, a Codex turn's usage id), at its largest
 *   snapshot: input, output, cache-creation and cache-read tokens, the model, its list-price cost, the session, the
 *   machine it ran on and the account it was billed to. Kept for ever; `usage_daily` rolls it up by day, kept in step
 *   by triggers (a model's `top_tier` with it, which the model decides).
 * - `usage_readings`: the account's shares (the 5-hour, weekly and per-model weekly windows, and the bill-cycle month a
 *   status line projected), each with its reset, when it was measured and by which machine; and the Claude account's
 *   answers on its five-hour limit (kind `limit`, no share and no reset): when it last answered with no five-hour window
 *   (`no_limit` 1, an account with no five-hour limit) and when it last answered with one (`no_limit` 0), which decide
 *   whether it has one, as a brief's two times do (observe.ts noFiveHourLimitIfNewest).
 * - `usage_spend`: each session's spend as Claude Code reported it (the status line's ledger), with what each report
 *   added since the one before.
 * - `accounts`: each account tag, with the machines and agents seen on it.
 *
 * `seq` is the write that last changed a usage row, what another machine's usage pull asks from (usage.ts). Rows another
 * machine's records filled say when (`synced_ms`).
 */
const V2 = `
CREATE TABLE usage_messages (
  message_id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  account TEXT,
  model TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_create INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  top_tier INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0,
  synced_ms INTEGER
) STRICT;
CREATE INDEX usage_messages_window ON usage_messages(agent, ts);
CREATE INDEX usage_messages_session ON usage_messages(machine_id, session_id, ts);
CREATE INDEX usage_messages_seq ON usage_messages(machine_id, seq);

CREATE TABLE usage_daily (
  day TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  account TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  top_tier INTEGER NOT NULL DEFAULT 0,
  messages INTEGER NOT NULL DEFAULT 0,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_create INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, machine_id, agent, account, model)
) STRICT;
CREATE TRIGGER usage_messages_daily_ai AFTER INSERT ON usage_messages BEGIN
  ${DAY_OPEN('new')}
  ${DAY_ADD('new', '+')}
END;
CREATE TRIGGER usage_messages_daily_ad AFTER DELETE ON usage_messages BEGIN
  ${DAY_ADD('old', '-')}
  ${DAY_CLOSE('old')}
END;
CREATE TRIGGER usage_messages_daily_au AFTER UPDATE OF ts, machine_id, agent, account, model, input, output, cache_create, cache_read, cost ON usage_messages BEGIN
  ${DAY_ADD('old', '-')}
  ${DAY_CLOSE('old')}
  ${DAY_OPEN('new')}
  ${DAY_ADD('new', '+')}
END;

CREATE TABLE usage_readings (
  machine_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  measured_ms INTEGER NOT NULL,
  no_limit INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL DEFAULT '',
  account TEXT,
  pct REAL,
  reset_ms INTEGER,
  start_ms INTEGER,
  tokens INTEGER,
  budget INTEGER,
  reads INTEGER,
  cost REAL,
  cost_budget REAL,
  source TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  synced_ms INTEGER,
  PRIMARY KEY (machine_id, agent, kind, measured_ms)
) STRICT;
CREATE INDEX usage_readings_latest ON usage_readings(agent, kind, measured_ms);
CREATE INDEX usage_readings_seq ON usage_readings(machine_id, seq);
CREATE INDEX usage_readings_answers ON usage_readings(machine_id, no_limit, measured_ms) WHERE kind = 'limit';

CREATE TABLE usage_spend (
  machine_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  reported_ms INTEGER NOT NULL,
  usd REAL NOT NULL,
  delta REAL NOT NULL,
  account TEXT,
  seq INTEGER NOT NULL DEFAULT 0,
  synced_ms INTEGER,
  PRIMARY KEY (machine_id, session_id, reported_ms)
) STRICT;
CREATE INDEX usage_spend_window ON usage_spend(reported_ms);
CREATE INDEX usage_spend_seq ON usage_spend(machine_id, seq);

CREATE TABLE accounts (
  account TEXT NOT NULL,
  agent TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  first_ms INTEGER NOT NULL,
  last_ms INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  synced_ms INTEGER,
  PRIMARY KEY (account, agent, machine_id)
) STRICT;

${SYNCED_TABLES.map((t) => `ALTER TABLE ${t} ADD COLUMN synced_ms INTEGER;`).join('\n')}
`;

/**
 * Schema version 3: what the session listing reads of a session right now, kept so a listing reads none of it from a
 * session that cannot be live. Beside the raised hand (`attention`): its native tab's link (`tab`, `tab.json`), and the
 * workers found finished at their transcript's stamp (`workers`, a JSON object of file name to stamp; WORKERS_NONE where
 * no folder of workers is beside its transcript; null until the catch-up has read them).
 */
const V3 = `
ALTER TABLE session_live ADD COLUMN tab TEXT;
ALTER TABLE session_live ADD COLUMN workers TEXT;
`;

/** `session_live.workers` for a session with no folder of workers beside its transcript, whose listing asks no worker. */
export const WORKERS_NONE = 'none';

/**
 * Schema version 4: raised hands travel, and machines are named as this machine names them.
 *
 * - `attention.synced_ms`: a raised hand is a record (records.ts), so another machine's hand fills this table as its
 *   other rows fill theirs, marked with when it arrived.
 * - `machines.saved_label`: the label this machine saved that machine under (herdr's list, which `--machine` takes), as
 *   oak sync and the usage pull last reached it by; null where it saved none. `label` stays the name the machine gives
 *   itself in its records.
 * - `session_phase` follows a raised hand first: a session whose hand is up (its own, or another machine's as its record
 *   log brought it) is never `working`. A turn's end is `done` however recent; the hooks lower that hand when the next
 *   prompt or tool call starts.
 *
 * The hands held before are read again from each session's store by the next catch-up, which publishes those still up;
 * and the other machines' record logs are read again from their start, once: an earlier build read past the hands they
 * carry (a table it did not know), which it never applied.
 */
const V4 = `
ALTER TABLE attention ADD COLUMN synced_ms INTEGER;
DELETE FROM attention;
DELETE FROM ingest_state WHERE source LIKE 'unit:attention:%';
DELETE FROM ingest_state WHERE kind = 'records' AND machine_id NOT IN (SELECT machine_id FROM machines WHERE is_self = 1);
ALTER TABLE machines ADD COLUMN saved_label TEXT;
DROP VIEW session_phase;
CREATE VIEW session_phase AS
  SELECT s.machine_id, s.session_id,
    CASE
      WHEN a.kind = 'permission' THEN 'awaiting-permission'
      WHEN a.kind IN ('input', 'question') THEN 'awaiting-input'
      WHEN a.kind = 'idle-done' THEN 'done'
      WHEN l.turn_open = 1 THEN 'working'
      WHEN CAST(strftime('%s', 'now') AS INTEGER) * 1000 - max(s.last_active_ms, s.capture_ms) <= 300000 THEN 'working'
      ELSE 'idle'
    END AS phase
  FROM sessions s
  LEFT JOIN attention a ON a.machine_id = s.machine_id AND a.session_id = s.session_id
  LEFT JOIN session_live l ON l.machine_id = s.machine_id AND l.session_id = s.session_id;
`;

/**
 * Schema version 5: the agents OAK started from a brief (delegated.ts), one row per agent, from its record in the store
 * of the machine it runs on (`delegated/<id>.json`, with the session its hooks linked). `machine_id` is that machine;
 * `machine` is null for an agent on it, or the saved machine a record started from here names (its own row is that
 * machine's). `state` and `since_ms` are as a refresh there last derived them (`oak agent list`, `wait`, the surfaces,
 * and each oak sync run that reads the machine), and `stamp` the record's files as this machine's catch-up read them.
 * Rows travel in the record log, so oak sync brings every machine's agents to every index.
 */
const V5 = `
CREATE TABLE delegated (
  machine_id TEXT NOT NULL,
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  brief TEXT NOT NULL,
  cwd TEXT NOT NULL,
  out TEXT NOT NULL,
  report TEXT NOT NULL,
  kind TEXT NOT NULL,
  agent_type TEXT,
  model TEXT,
  effort TEXT,
  sandbox TEXT,
  machine TEXT,
  workspace TEXT,
  tab TEXT,
  pane TEXT,
  session_id TEXT,
  parent TEXT,
  started_ms INTEGER NOT NULL,
  ended_ms INTEGER,
  closed_ms INTEGER,
  state TEXT NOT NULL,
  since_ms INTEGER NOT NULL,
  error TEXT,
  stamp TEXT NOT NULL DEFAULT '',
  synced_ms INTEGER,
  PRIMARY KEY (machine_id, id)
) STRICT;
CREATE INDEX delegated_recent ON delegated(started_ms DESC);
CREATE INDEX delegated_session ON delegated(session_id);
`;

/** A message's share of its day, with the parts schema version 6 added: the cache writes kept an hour, and whether
 *  its cost is approximate. */
const DAY_ADD_V6 = (row: string, sign: '+' | '-'): string => DAY_ADD(row, sign).replace(' WHERE ',
  `, cache_create_1h = cache_create_1h ${sign} coalesce(${row}.cache_create_1h, 0), cost_approx = cost_approx ${sign} ${row}.cost_approx WHERE `);

/**
 * Schema version 6: usage priced by what each message records, and again whenever the prices change.
 *
 * - `usage_messages.cache_create_1h`: of its cache writes (`cache_create`), those kept an hour, which cost more than
 *   those kept five minutes; null where the record kept no split (priced at the five-minute rate, as approximate).
 * - `provider`: the provider that served a Codex turn ('' for Claude's); `speed` and `geo`: Claude's fast mode and
 *   US-only inference, where a transcript records them. A row with no provider (null) was written before this version:
 *   the next read of its file writes it again, with them.
 * - `priced`: the price table that priced it (pricing.ts PRICE_VERSION), '' for none yet; `cost_approx` 1 where that
 *   cost is approximate (a model no row lists, or writes with no split). The catch-up prices again every row an older
 *   table priced, this machine's and the other machines' alike (index/ingest.ts repriceUsage); `usage_daily` follows,
 *   with the hour's writes and the approximate messages summed beside the rest.
 * - `worker`: the agent whose transcript a message came from, by its file's name (`agent-…`), '' for the session's own
 *   turns; null where unknown (a record from an OAK before this version). A session's usage counts its agents' turns;
 *   this tells its own apart (usage.ts usageBreakdownSql).
 *
 * Every transcript's and rollout's usage is read again from its start, once, to fill the new columns.
 */
const V6 = `
ALTER TABLE usage_messages ADD COLUMN cache_create_1h INTEGER;
ALTER TABLE usage_messages ADD COLUMN worker TEXT;
ALTER TABLE usage_messages ADD COLUMN provider TEXT;
ALTER TABLE usage_messages ADD COLUMN speed TEXT;
ALTER TABLE usage_messages ADD COLUMN geo TEXT;
ALTER TABLE usage_messages ADD COLUMN priced TEXT NOT NULL DEFAULT '';
ALTER TABLE usage_messages ADD COLUMN cost_approx INTEGER NOT NULL DEFAULT 0;
CREATE INDEX usage_messages_priced ON usage_messages(priced);
ALTER TABLE usage_daily ADD COLUMN cache_create_1h INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_daily ADD COLUMN cost_approx INTEGER NOT NULL DEFAULT 0;
DROP TRIGGER usage_messages_daily_ai;
DROP TRIGGER usage_messages_daily_ad;
DROP TRIGGER usage_messages_daily_au;
CREATE TRIGGER usage_messages_daily_ai AFTER INSERT ON usage_messages BEGIN
  ${DAY_OPEN('new')}
  ${DAY_ADD_V6('new', '+')}
END;
CREATE TRIGGER usage_messages_daily_ad AFTER DELETE ON usage_messages BEGIN
  ${DAY_ADD_V6('old', '-')}
  ${DAY_CLOSE('old')}
END;
CREATE TRIGGER usage_messages_daily_au AFTER UPDATE OF ts, machine_id, agent, account, model, input, output, cache_create, cache_read, cost, cache_create_1h, cost_approx
  ON usage_messages BEGIN
  ${DAY_ADD_V6('old', '-')}
  ${DAY_CLOSE('old')}
  ${DAY_OPEN('new')}
  ${DAY_ADD_V6('new', '+')}
END;
DELETE FROM ingest_state WHERE kind IN ('usage', 'codex-usage') OR source LIKE 'unit:usage:%' OR source LIKE 'unit:deleted-usage:%';
`;

const V7 = `
CREATE TABLE account_bill_days (
  machine_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  account TEXT NOT NULL DEFAULT '',
  day INTEGER NOT NULL CHECK(day BETWEEN 0 AND 31),
  updated_ms INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  synced_ms INTEGER,
  PRIMARY KEY (machine_id, agent, account)
) STRICT;
CREATE INDEX account_bill_days_seq ON account_bill_days(machine_id, seq);
DELETE FROM ingest_state WHERE source LIKE 'unit:usage-machine:%';
`;

/** Findings are immutable posts. A retirement belongs to the machine resolving it, so any machine can retire a
 *  remote post without writing another machine's record log. Both survive a rebuild from records. */
const V9 = `
-- Empty parent: a known root session. NULL: older records or unavailable lineage, never assumed unrelated.
ALTER TABLE sessions ADD COLUMN parent_session TEXT;
CREATE TABLE findings (
  machine_id TEXT NOT NULL,
  id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  repo TEXT NOT NULL,
  paths TEXT NOT NULL CHECK(json_valid(paths) AND json_type(paths) = 'array'),
  text TEXT NOT NULL,
  synced_ms INTEGER,
  PRIMARY KEY (machine_id, id)
) STRICT;
CREATE INDEX findings_recent ON findings(created_ms DESC);
CREATE INDEX findings_repo ON findings(repo, created_ms DESC);
CREATE INDEX findings_session ON findings(machine_id, session_id);
CREATE TABLE finding_resolutions (
  machine_id TEXT NOT NULL,
  finding_machine TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  resolved_ms INTEGER NOT NULL,
  synced_ms INTEGER,
  PRIMARY KEY (machine_id, finding_machine, finding_id)
) STRICT;
CREATE INDEX finding_resolutions_post ON finding_resolutions(finding_machine, finding_id);
DELETE FROM ingest_state WHERE kind = 'records' AND machine_id NOT IN (SELECT machine_id FROM machines WHERE is_self = 1);
`;

/** The migrations, in order: step N brings `user_version` to N. */
const V8 = `ALTER TABLE delegated ADD COLUMN worktree_json TEXT;
UPDATE delegated SET stamp = '';`;

export const MIGRATIONS: readonly string[] = [V1, V2, V3, V4, V5, V6, V7, V8, V9];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Bump when what ingest.ts writes changes meaning, or when `listingFacts` (or anything it reads) does: a bump
 *  re-derives every session's facts. A version, not a hash of the code: the CLI's bundle, the editor's and core's own
 *  build print the same function differently, and one index file shared by all three would be re-derived whole each
 *  time another of them read it. The file records the version its facts were derived by (`meta.ingest_version`). */
// File paths start at the current worktree root; native child sessions keep their parent.
export const INGEST_VERSION = 6;

/** Bring a writable database to SCHEMA_VERSION, inside the caller's write transaction. Throws when the file was written
 *  by a newer OAK, which this one must not write: a newer schema, or facts derived by a newer INGEST_VERSION (deriving
 *  them again here would only be undone by that OAK, and the two would take turns on every read). */
export function migrate(db: DatabaseSync): void {
  const at = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (at > SCHEMA_VERSION) throw new IndexTooNewError(`schema ${at}; this one knows ${SCHEMA_VERSION}`);
  for (let v = at; v < SCHEMA_VERSION; v++) {
    db.exec(MIGRATIONS[v]);
    db.exec(`PRAGMA user_version = ${v + 1}`);
  }
  const ingest = Number((db.prepare("SELECT value FROM meta WHERE key = 'ingest_version'").get() as { value: string } | undefined)?.value ?? 0);
  if (ingest > INGEST_VERSION) throw new IndexTooNewError(`facts version ${ingest}; this one derives version ${INGEST_VERSION}`);
  if (ingest !== INGEST_VERSION) db.prepare("INSERT INTO meta (key, value) VALUES ('ingest_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(INGEST_VERSION));
}

/** Whether `migrate` has anything to do, read without the write lock, so a reader never waits for another process's
 *  transaction just to learn the file is current. Throws, as `migrate` does, for a file a newer OAK wrote. */
export function needsMigration(db: DatabaseSync): boolean {
  const at = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  if (at > SCHEMA_VERSION) throw new IndexTooNewError(`schema ${at}; this one knows ${SCHEMA_VERSION}`);
  if (at < SCHEMA_VERSION) return true;
  const ingest = Number((db.prepare("SELECT value FROM meta WHERE key = 'ingest_version'").get() as { value: string } | undefined)?.value ?? 0);
  if (ingest > INGEST_VERSION) throw new IndexTooNewError(`facts version ${ingest}; this one derives version ${INGEST_VERSION}`);
  return ingest !== INGEST_VERSION;
}

export class IndexTooNewError extends Error {
  constructor(which: string) {
    super(`the database was written by a newer OAK (${which})`);
    this.name = 'IndexTooNewError';
  }
}

/** The columns a table has, in order. */
export function tableColumns(db: DatabaseSync, table: string, schema = 'main'): string[] {
  return (db.prepare(`PRAGMA ${schema}.table_info(${JSON.stringify(table)})`).all() as { name: string }[]).map((r) => r.name);
}
