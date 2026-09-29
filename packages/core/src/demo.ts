/**
 * Live demo simulator (0.8.0): replays a scripted Claude Code session through the REAL pipeline —
 * transcript lines appended to the real project dir, edits captured via the same Pre/PostToolUse hook
 * logic (`handleHookPayload`), a subagent transcript, and a workflow run — so every panel in both
 * editors lights up live, exactly as it would during a real session. Two jobs:
 *
 *   1. SHOWCASE — `oak demo` in an open workspace simulates a prompt to Claude and
 *      shows live changes: the Overview's change map fills task by task, the Fleet nav
 *      gains a subagent and a workflow run, Observations streams the reasoning, and Accept/Reject/
 *      task-scoped review genuinely work (the edits are real store records on real files).
 *   2. AUTOMATED TEST — `--fast` replays the whole scenario in under a second, hermetically under
 *      CLAUDE_CONFIG_DIR, so the e2e suite can assert every 0.8.0 `--json` surface against a session
 *      produced by the same code path a real one takes.
 *
 * ISOLATION (never pollutes real work):
 *   · the session id is `demo-<8hex>` — the prefix gates every demo-only behavior incl. cleanup;
 *   · every file edit is confined to a dedicated workspace folder (default `<cwd>/observatory-demo/`),
 *     marked with a `.observatory-demo` sentinel so cleanup can prove it owns the directory. The ONE
 *     deliberate exception is the scratch dir (§ the outside-the-workspace write), which carries the
 *     same sentinel and lives under the product's own config dir;
 *   · reviewing the demo leaves no residue: `autoClearDemo` drops the store records of a fully
 *     reviewed (no pending) demo session, and `demo --clean` removes everything — both transcripts,
 *     subagents/workflows, stores, the workspace folder, and the scratch dir.
 *
 * Zero token — nothing here calls a model; it only writes the files a real session would have written.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { projectDir, commonDir } from './session';
import { handleHookPayload } from './capture';
import { readLog, clearResolved, removeSession, isSafeSessionId, ensureStore, writeBlob, appendLog, allStoreSessionIds } from './store';
import { removeUsageCursor } from './metrics';
import { claudeConfigDir } from './paths';

export interface DemoOptions {
  /** Workspace folder the demo edits live in (created if missing). Default: `<cwd>/observatory-demo`. */
  dir?: string;
  /** No pacing — the whole scenario lands in well under a second (the automated-test mode). */
  fast?: boolean;
  /** Pacing multiplier for the live showcase: 2 = twice as fast. Ignored with `fast`. */
  speed?: number;
  /** The invocation cwd — the OPEN project whose panels should light up (transcript lands in ITS
   *  project dir, so the editors' session auto-resolution picks the demo up). Default process.cwd(). */
  cwd?: string;
  /** Progress narration (one line per beat); silent when omitted. */
  log?: (line: string) => void;
  /** Also simulate a SECOND agent in a sibling worktree of the same repo, so the Fleet tab has more
   *  than one row and the live file-collision badge has something to flag. Default true; the opt-out
   *  exists for recordings that want a single-agent frame. No-op outside a git repo (fleet
   *  correlation needs a resolvable repo key — see `commonDir`). */
  fleet?: boolean;
  /** Polled once per beat; returning true aborts the replay. The partial session it leaves behind is
   *  still fully removable by `cleanDemo` — a paced run is ~20s, long enough to want to stop it. */
  shouldStop?: () => boolean;
  /** Clear any previous demo for this cwd before replaying, so starting the demo again RESETS it
   *  instead of stacking a second demo session beside the first. Default true, and it lives here rather
   *  than in each front-end so the CLI, VS Code and JetBrains cannot drift on what "start again" means.
   *  Only ever removes `demo-<8hex>` sessions and marker-carrying directories, so it can never reach
   *  real work. Pass false to stack runs deliberately. */
  reset?: boolean;
}

export interface DemoResult {
  session: string;
  /** The sibling agent's session id, or null when `fleet` was off / this cwd has no resolvable repo. */
  sibling: string | null;
  workspace: string;
  /** Where the ONE deliberate outside-the-workspace write landed (what the Risk audit reports). */
  scratch: string;
  transcript: string;
  /** Store edits the scenario captured (the review units the panels show). */
  edits: number;
  /** Scenario beats executed. */
  steps: number;
  /** True when the replay was stopped early via `shouldStop`. */
  cancelled: boolean;
}

const DEMO_ID_RE = /^demo-[0-9a-f]{8}$/;

/** How many numbered tasks the scenario plans. Exported so a caption or a doc counts it rather than
 *  claiming it: the recorded GIF's burnt-in caption drifted to "5 tasks" once already. */
export const DEMO_TASKS = 6;
const MARKER = '.observatory-demo';
/** Where the scenario's one deliberate outside-the-workspace write lands, under the product's own
 *  config dir. Chosen over os.tmpdir() so the path home-shortens to a stable `~/.claude/…` form the
 *  docs can quote (scripts/check-docs-privacy.mjs rejects machine temp paths in published prose) and
 *  so the OS cannot reap it mid-tour. `listSessions` ignores it — it holds no `log.jsonl`. */
const SCRATCH_DIR = '.demo-scratch';

function scratchRoot(): string {
  return path.join(claudeConfigDir(), 'claude-observatory', SCRATCH_DIR);
}

/**
 * The demo workspace path, normalized ONE way for every caller.
 *
 * The sibling agent records under `projectDir(workspace)`, and a project dir is a mangling of the path
 * string — so resolving the workspace through a symlink in one place and not in another mints two
 * different project dirs. Cleanup, the heartbeat and the "does a demo exist" scan would then all look
 * in the wrong one, leaving the sibling session unreachable by any command while `--clean` reported
 * success. realpath when the directory exists; the plain resolve when it does not (cleanup runs after
 * the directory is gone, and must still name the same project dir it did before).
 */
function demoPath(dir: string): string {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Refuse a workspace the demo does not already own. An existing directory is adoptable only when it is
 * empty or already carries the sentinel from a previous run; anything else throws before a single byte
 * is written. Callers that pass no `--dir` never see this — `observatory-demo/` is theirs by
 * construction.
 */
function assertAdoptable(workspace: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(workspace);
  } catch {
    return; // does not exist (or is unreadable — the seeding below will report that honestly)
  }
  if (entries.length === 0 || entries.includes(MARKER)) return;
  throw new Error(
    `refusing to use ${workspace} as the demo workspace: it already contains files the demo did not create. ` +
      `The demo seeds and later deletes its whole workspace, so it will only use an empty or previously-demo directory.`
  );
}

/** True for a simulator-owned session id — the gate for every demo-only behavior. */
export function isDemoSession(id: string): boolean {
  return DEMO_ID_RE.test(id);
}

/**
 * Demo sessions leave no residue once reviewed: when EVERY edit of a demo session is resolved
 * (kept/undone — e.g. the user hit Accept All), drop the resolved records entirely so the panels
 * empty out and a re-run starts clean. No-op (false) for real sessions, unreviewed demos, and
 * already-empty stores. Called after the CLI's keep/undo/task ops and the editors' refresh paths.
 */
export function autoClearDemo(sessionId: string): boolean {
  if (!isDemoSession(sessionId)) return false;
  let log;
  try {
    log = readLog(sessionId);
  } catch {
    return false;
  }
  if (log.length === 0 || log.some((r) => r.status === 'pending')) return false;
  return clearResolved(sessionId) > 0;
}

// --- scenario runner ------------------------------------------------------------------------------

/** Monotonic ms clock: strictly increasing across transcript lines, never ahead of real time by more
 *  than the +1ms nudges (the store stamps captures with the REAL Date.now(), and strict-span task
 *  attribution compares the two — so the clock must track real time, not a synthetic timeline). */
class DemoClock {
  private last = 0;
  now(): number {
    this.last = Math.max(this.last + 1, Date.now());
    return this.last;
  }
  iso(): string {
    return new Date(this.now()).toISOString();
  }
  /** How far the clock currently LEADS wall time, in ms. The +1ms nudges accumulate — a beat that
   *  writes eighty transcript lines pushes the clock eighty ms into the future — and a task span
   *  stamped from a leading clock would not contain the store records stamped from the real
   *  `Date.now()`, silently unassigning that task's edits. `beat` waits this out. */
  drift(): number {
    return Math.max(0, this.last - Date.now());
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Mint a simulator-owned id, checked against both gates it will later be trusted by. */
function newDemoId(): string {
  const id = `demo-${crypto.randomBytes(4).toString('hex')}`;
  if (!isSafeSessionId(id) || !isDemoSession(id)) throw new Error('demo session id failed its own gate');
  return id;
}

/** Thrown by `beat` when `shouldStop` goes true; caught by runDemo, which returns the partial result. */
class DemoCancelled extends Error {}

/** The demo app the scenario edits — a tiny ML training pipeline (the same story the docs mockups
 *  tell). Stdlib-only Python, so the demo files actually run. */
const SEED_FILES: Record<string, string> = {
  'src/features.py':
    'from statistics import mean\n\n\ndef summarize(values):\n    return {"count": len(values), "mean": mean(values)}\n',
  'src/train.py': 'from features import summarize\n\nprint(summarize([1.0, 2.0, 3.0]))\n',
  'src/models/dataset.py':
    'class Dataset:\n    def __init__(self, features, labels):\n        self.features = features\n        self.labels = labels\n',
  // Retired by the scenario — the deletion the review surfaces need in order to show a deleted-file
  // row, the deletion ghost in the editor, and restore-on-undo.
  'src/legacy_scaler.py':
    '# Superseded by features.scale(); kept only until the callers moved over.\n\n\nclass LegacyScaler:\n    def apply(self, values):\n        hi = max(values)\n        return [v / hi for v in values]\n',
};

/**
 * Run the built-in scenario. Everything is appended INCREMENTALLY (one beat at a time, paced unless
 * `fast`), so watchers fire and the panels update live. Returns once the scenario has fully landed.
 */
export async function runDemo(opts: DemoOptions = {}): Promise<DemoResult> {
  // Physical path, symlinks resolved — a real session's `cwd` field is the shell's getcwd(), and the
  // project-dir mangling must produce the SAME directory a CLI invoked from there will look in.
  const cwd = fs.realpathSync(opts.cwd ?? process.cwd());
  const workspace = demoPath(opts.dir ?? path.join(cwd, 'observatory-demo'));
  // The demo may only ever own a directory it created. A `--dir` that already holds anything else is
  // REFUSED, rather than adopted by planting the sentinel in it: the sentinel is what authorizes a
  // recursive delete, so planting it in a directory the caller already had would turn a mistyped flag
  // into `rm -rf` of their work on the very next run — the seeding writes are raw, so the first run
  // would already have overwritten any file whose path the scenario reuses.
  assertAdoptable(workspace);
  // Starting the demo again RESETS it. Without this, a second run stacks a second demo session beside
  // the first — the reviewed one still in the Sessions list, its half-accepted edits still on disk —
  // which is exactly the state you do not want when you reach for the demo to show someone.
  if (opts.reset !== false) cleanDemo({ cwd, dir: opts.dir });
  const session = newDemoId();
  const proj = projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const transcript = path.join(proj, `${session}.jsonl`);
  const scratch = path.join(scratchRoot(), session);
  const say = opts.log ?? (() => {});
  // Fast mode still sleeps a few ms per beat: the clock nudges lines +1ms apart, and real time must
  // stay ahead of it so the store's Date.now() captures interleave correctly with the todo flips.
  const delay = opts.fast ? 8 : Math.max(60, Math.round(800 / (opts.speed && opts.speed > 0 ? opts.speed : 1)));
  const clock = new DemoClock();
  let steps = 0;
  let sibling: string | null = null;
  let cancelled = false;

  // Seed the demo workspace (never touches anything outside it).
  fs.mkdirSync(path.join(workspace, 'src', 'models'), { recursive: true });
  fs.writeFileSync(path.join(workspace, MARKER), `${session}\n`);
  // The demo writes into the reader's own repository, so it hides itself from git rather than turning
  // up as an untracked folder in their next `git status` — or, worse, being swept in by `git add -A`.
  // A self-ignoring .gitignore needs no change to any file the reader owns, and it survives the case
  // where cleanup cannot reclaim the folder (a buffer saved after Exit recreates one of its files,
  // and the sentinel that authorizes deletion went with the tree).
  fs.writeFileSync(path.join(workspace, '.gitignore'), '# OAK demo — not part of your project.\n*\n');
  // …and un-hides itself from OAK: the Bash tree walk honours .gitignore (2026-09-23), and a demo whose
  // Bash edits went uncaptured would demonstrate the opposite of the product. `.observatoryignore`
  // is the stronger layer, so this re-include wins over the `*` above for OAK alone.
  fs.writeFileSync(path.join(workspace, '.observatoryignore'), '# OAK demo — captured by OAK although git ignores it.\n!*\n');
  for (const [rel, content] of Object.entries(SEED_FILES)) {
    fs.mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true });
    fs.writeFileSync(path.join(workspace, rel), content);
  }

  const append = (obj: unknown) => fs.appendFileSync(transcript, JSON.stringify(obj) + '\n');
  const beat = async (label: string) => {
    if (opts.shouldStop?.()) throw new DemoCancelled();
    steps++;
    say(label);
    // Sleep at least long enough for wall time to catch the transcript clock back up, so the NEXT
    // beat's task spans bracket the store records it is about to capture (see DemoClock.drift).
    await sleep(Math.max(delay, clock.drift() + 1));
  };
  let toolSeq = 0;
  const tid = () => `demo_tu_${++toolSeq}`;

  // One assistant turn: optional reasoning text, then tool_uses (each later resolved by a result line).
  const assistant = (blocks: unknown[], usage = { input_tokens: 40, output_tokens: 120 }) =>
    append({
      type: 'assistant',
      sessionId: session,
      timestamp: clock.iso(),
      // Model + effort are stamped the way current Claude Code stamps them, so the demo session lights
      // up the Stats panel's model/effort chip instead of leaving it blank.
      effort: 'high',
      message: {
        role: 'assistant',
        id: `demo_msg_${toolSeq}_${steps}`,
        model: 'claude-opus-4-8',
        usage: { ...usage, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: blocks,
      },
    });
  /** A context compaction, exactly as the harness records one — so the demo exercises the compaction
   *  marker, the Actions row and the context meter's saw-tooth. */
  const compaction = (preTokens: number, postTokens: number, cumulative: number) =>
    append({
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      sessionId: session,
      isSidechain: false,
      timestamp: clock.iso(),
      compactMetadata: { trigger: 'auto', preTokens, postTokens, cumulativeDroppedTokens: cumulative, durationMs: 92_000 },
    });
  const result = (toolUseId: string) =>
    append({
      type: 'user',
      sessionId: session,
      timestamp: clock.iso(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: false }] },
    });
  /** A tool call that FAILED — what the Actions view's error filter and the per-prompt failed-call
   *  counter count. Never leave one trailing: `agentPhaseDetail` reads a trailing error result as an
   *  errored agent, which would leave the demo agent errored for the rest of the tour. */
  const errResult = (toolUseId: string, text: string) =>
    append({
      type: 'user',
      sessionId: session,
      timestamp: clock.iso(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: true, content: text }] },
    });
  /** One of YOUR turns — the unit the Prompts window lists and scopes the Overview by. */
  const prompt = (text: string, extra: Record<string, unknown> = {}) =>
    append({ type: 'user', sessionId: session, timestamp: clock.iso(), ...extra, message: { role: 'user', content: text } });
  const todos = (list: { content: string; status: string }[]) => {
    const id = tid();
    assistant([{ type: 'tool_use', id, name: 'TodoWrite', input: { todos: list } }]);
    result(id);
  };

  /** A backgrounded shell, exactly as the harness records one: the spawn, the result that names the
   *  shell, and (optionally) the completion notification carrying its exit code. Without this the
   *  Processes tab and `feed --kind process` can only ever render their empty states. */
  const bgShell = (shellId: string, cmd: string, desc: string, opts: { finish?: number } = {}) => {
    const id = tid();
    const outPath = path.join(workspace, `.observatory-demo-${shellId}.log`);
    try {
      fs.writeFileSync(outPath, `${desc}\n… running ${cmd}\n`);
    } catch {
      /* the log is a nicety; the rows render without it */
    }
    assistant([{ type: 'tool_use', id, name: 'Bash', input: { command: cmd, description: desc, run_in_background: true } }]);
    append({
      type: 'user',
      sessionId: session,
      timestamp: clock.iso(),
      toolUseResult: { backgroundTaskId: shellId },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: ${shellId}. Output is being written to: ${outPath}.` }],
      },
    });
    if (opts.finish !== undefined) {
      append({
        type: 'queue-operation',
        operation: 'enqueue',
        sessionId: session,
        timestamp: clock.iso(),
        content: `<task-notification> <task-id>${shellId}</task-id> <status>completed</status> <summary>Background command "${desc}" completed (exit code ${opts.finish})</summary> </task-notification>`,
      });
    }
  };

  // The NUMBERED task list (TaskCreate/TaskUpdate, 0.8.3) — seeded alongside the todos so the
  // Overview's Tasks tab shows live, LINKED data. Same titles as the to-dos: the merged plan dedupes
  // (todos win), so this never mints twin tasks. Task state is written both ways a real session
  // leaves it: transcript tool calls (the history + spans) AND the live task-dir files.
  const taskDir = path.join(claudeConfigDir(), 'tasks', session);
  const TASKS: { subject: string; description: string; activeForm: string }[] = [
    { subject: 'Add feature scaling to the pipeline', description: 'z-score scale() in features.py, wired into train.py', activeForm: 'Adding feature scaling' },
    { subject: 'Validate the training dataset', description: 'Dataset.validate() — length match + non-empty', activeForm: 'Validating the dataset' },
    { subject: 'Tests and docs', description: 'subagent tests + workflow usage docs', activeForm: 'Writing tests and docs' },
    { subject: 'Retire the legacy scaler', description: 'delete legacy_scaler.py now that scale() covers it', activeForm: 'Retiring the legacy scaler' },
    { subject: 'Profile the pipeline', description: 'timing report, written outside the workspace', activeForm: 'Profiling the pipeline' },
    // Left IN PROGRESS when the replay ends, so the Tasks tab shows work under way and not only a
    // finished plan. It owns no edits by construction: its in-progress span is a single checkpoint, and
    // strict attribution needs a ts strictly inside a span — so `rollupByTask` is untouched.
    { subject: 'Tune the scaler for sparse columns', description: 'follow-up from the profile — constant columns still degrade to a no-op', activeForm: 'Tuning the scaler' },
  ];
  const taskStatus = TASKS.map(() => 'pending');
  const writeTaskFiles = () => {
    fs.mkdirSync(taskDir, { recursive: true });
    TASKS.forEach((t, i) =>
      fs.writeFileSync(
        path.join(taskDir, `${i + 1}.json`),
        JSON.stringify({ id: String(i + 1), subject: t.subject, description: t.description, activeForm: t.activeForm, status: taskStatus[i], blocks: [], blockedBy: [] })
      ));
  };
  const taskCreateAll = () => {
    TASKS.forEach((t, i) => {
      const id = tid();
      assistant([{ type: 'tool_use', id, name: 'TaskCreate', input: { subject: t.subject, description: t.description, activeForm: t.activeForm } }]);
      append({
        type: 'user',
        sessionId: session,
        timestamp: clock.iso(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Task #${i + 1} created successfully: ${t.subject}` }] },
      });
    });
    writeTaskFiles();
  };
  const taskUpdate = (n: number, status: string) => {
    taskStatus[n - 1] = status;
    const id = tid();
    assistant([{ type: 'tool_use', id, name: 'TaskUpdate', input: { taskId: String(n), status } }]);
    result(id);
    writeTaskFiles();
  };

  /** A REAL captured edit: Pre hook → mutate the file → Post hook (the store record every review
   *  surface acts on), plus the matching transcript tool_use so reasoning/actions correlate. */
  const edit = (rel: string, newContent: string, reasoning: string, tool: 'Edit' | 'Write' = 'Edit') =>
    editAt(path.join(workspace, rel), newContent, reasoning, tool);
  const editAt = (file: string, newContent: string, reasoning: string, tool: 'Edit' | 'Write' = 'Edit') => {
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const hook = (event: string) => ({
      session_id: session,
      cwd,
      hook_event_name: event,
      tool_name: tool,
      tool_input: { file_path: file },
    });
    handleHookPayload(hook('PreToolUse'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, newContent);
    handleHookPayload(hook('PostToolUse'));
    const id = tid();
    const input =
      tool === 'Write'
        ? { file_path: file, content: newContent }
        : { file_path: file, old_string: before ?? '', new_string: newContent };
    assistant([
      { type: 'text', text: reasoning },
      { type: 'tool_use', id, name: tool, input },
    ]);
    result(id);
  };

  /**
   * Delete a workspace file through the REAL Bash capture path (Pre snapshots the tree, Post diffs it
   * and logs the removal with `afterBlob: null`, which undo restores). The scenario's only exercise of
   * that code path, and what gives the deleted-file row, the editor's deletion ghost and
   * restore-on-undo something live to render.
   *
   * The hook payload's cwd is the WORKSPACE, never the session cwd: `handlePreBash` walks `payload.cwd`
   * whole, so the session cwd would sweep the user's entire repository into the store. Nothing may
   * write inside the workspace between Pre and Post, or the diff attributes that write to this command.
   */
  const deleteViaBash = (rel: string, command: string, reasoning: string) => {
    const file = path.join(workspace, rel);
    const hook = (event: string) => ({
      session_id: session,
      cwd: workspace,
      hook_event_name: event,
      tool_name: 'Bash',
      tool_input: { command },
    });
    handleHookPayload(hook('PreToolUse'));
    fs.rmSync(file, { force: true });
    handleHookPayload(hook('PostToolUse'));
    const id = tid();
    assistant([
      { type: 'text', text: reasoning },
      { type: 'tool_use', id, name: 'Bash', input: { command, description: 'Remove the superseded scaler' } },
    ]);
    result(id);
  };

  /**
   * A SECOND agent, working the same repo from a sibling worktree — what turns the Fleet tab from one
   * row into a fleet, and what makes the live file-collision badge reachable.
   *
   * No second directory and no fabricated `.git` are needed, and none should be written: `commonDir`
   * walks UP from a cwd to the nearest `.git`, so a session launched from `<repo>/observatory-demo`
   * resolves to the SAME repo key as `<repo>` while mangling to a DIFFERENT project dir — which is
   * exactly the shape `listRepoSiblings` unions into a second row. Its edit targets the same absolute
   * path the primary session already has pending, because `fleetConflicts` intersects absolute paths.
   *
   * Returns null when this cwd has no resolvable repo: the fleet correlates on the repo key, so
   * outside a git repo there is nothing to correlate and inventing a row would be a lie.
   */
  const runSibling = (): string | null => {
    if (opts.fleet === false) return null;
    if (commonDir(workspace) === null) return null;
    const sibCwd = workspace; // already normalized by demoPath — one mangling, one project dir
    const sibId = newDemoId();
    const sibProj = projectDir(sibCwd);
    fs.mkdirSync(sibProj, { recursive: true });
    const sibFile = path.join(sibProj, `${sibId}.jsonl`);
    const sibAppend = (obj: unknown) => fs.appendFileSync(sibFile, JSON.stringify(obj) + '\n');
    let sibSeq = 0;
    const sibAssistant = (blocks: unknown[]) =>
      sibAppend({
        type: 'assistant',
        sessionId: sibId,
        timestamp: clock.iso(),
        effort: 'high',
        message: {
          role: 'assistant',
          id: `demo_sib_${++sibSeq}`,
          model: 'claude-opus-4-8',
          usage: { input_tokens: 35, output_tokens: 110, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: blocks,
        },
      });
    // The first cwd-bearing line is what `firstCwdLine` reads to place this session in the repo, and
    // its gitBranch is what the Fleet row labels the worktree with.
    sibAppend({
      type: 'user',
      sessionId: sibId,
      cwd: sibCwd,
      gitBranch: 'demo/hotfix',
      timestamp: clock.iso(),
      message: { role: 'user', content: 'Hotfix: clamp scale() so a constant column cannot divide by zero.' },
    });
    {
      const t = tid();
      sibAssistant([{ type: 'tool_use', id: t, name: 'TodoWrite', input: { todos: [{ content: 'Clamp scale() for constant columns', status: 'in_progress' }] } }]);
      sibAppend({
        type: 'user',
        sessionId: sibId,
        timestamp: clock.iso(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: t, is_error: false }] },
      });
    }
    // The collision: the same absolute path the primary session already holds pending.
    const target = path.join(workspace, 'src', 'features.py');
    const hook = (event: string) => ({
      session_id: sibId,
      cwd: sibCwd,
      hook_event_name: event,
      tool_name: 'Edit',
      tool_input: { file_path: target },
    });
    const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    // A DIFFERENT region of the same file. The collision the Fleet badge reports is per-FILE — both
    // agents holding it pending — and it needs nothing more. Overlapping the primary's own edit would
    // additionally make undoing that edit a three-way conflict that half-applies before reporting, and
    // the tour sends the reader to undo exactly that edit.
    const after = before.replace(
      'def summarize(values):\n',
      'def summarize(values):\n    # hotfix: callers pass generators; materialize before measuring\n    values = list(values)\n'
    );
    handleHookPayload(hook('PreToolUse'));
    fs.writeFileSync(target, after);
    handleHookPayload(hook('PostToolUse'));
    const editId = tid();
    sibAssistant([
      { type: 'text', text: 'Clamping sigma so a constant column degrades to a no-op instead of raising.' },
      { type: 'tool_use', id: editId, name: 'Edit', input: { file_path: target, old_string: before, new_string: after } },
    ]);
    sibAppend({
      type: 'user',
      sessionId: sibId,
      timestamp: clock.iso(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: editId, is_error: false }] },
    });
    // Left deliberately unresolved: a tool_use with no result is what a real agent mid-call looks like,
    // so the row's live phase reads `working` and later `awaiting-permission` — both honest, and the
    // second is itself a state worth showing.
    sibAssistant([{ type: 'tool_use', id: tid(), name: 'Bash', input: { command: 'python src/train.py', description: 'Re-run the entrypoint' } }]);
    return sibId;
  };

  // The scenario runs inside one closure so a cancellation — thrown by `beat` when `shouldStop` goes
  // true — unwinds to exactly one place. Everything written up to that beat is real and reviewable,
  // and `cleanDemo` removes a partial run exactly as it removes a complete one.
  const scenario = async () => {
    // ---------- the story: three prompts, six tasks, a subagent, a workflow, a sibling agent ----------

    await beat('▸ prompt 1 — asking Claude to extend the training pipeline');
    prompt('Add feature scaling and dataset validation to the training pipeline.', { cwd, gitBranch: 'demo/pipeline' });
    append({ type: 'ai-title', aiTitle: 'Pipeline: scaling, validation, tests', timestamp: clock.iso() });
    assistant([{ type: 'text', text: 'I will plan this as five tasks, starting with feature scaling and dataset validation.' }]);

    await beat('▸ plan — the to-dos and the numbered task list');
    todos([
      { content: 'Add feature scaling to the pipeline', status: 'in_progress' },
      { content: 'Validate the training dataset', status: 'pending' },
      { content: 'Tests and docs', status: 'pending' },
      { content: 'Retire the legacy scaler', status: 'pending' },
      { content: 'Profile the pipeline', status: 'pending' },
    ]);
    taskCreateAll();
    taskUpdate(1, 'in_progress');

    await beat('▸ task 1 — feature scaling (2 edits)');
    edit(
      'src/features.py',
      'from statistics import mean, stdev\n\n\ndef summarize(values):\n    return {"count": len(values), "mean": mean(values)}\n\n\ndef scale(values):\n    mu, sigma = mean(values), stdev(values)\n    return [(v - mu) / sigma for v in values]\n',
      'Adding scale() — z-score standardization so features share a range before training.'
    );
    await beat('  … wiring it into the entrypoint');
    edit(
      'src/train.py',
      'from features import summarize, scale\n\nfeatures = scale([1.0, 2.0, 3.0])\nprint(summarize(features))\n',
      'Scaling the features in the training entrypoint before they reach the model.'
    );
    await beat('  … the sanity run FAILS — the failed call the audit counts');
    {
      // A tool call that errored: what the Actions error filter and the per-prompt failed-call counter
      // count. Transcript-only (Bash capture diffs the whole tree — overkill for a read-only run).
      const id = tid();
      assistant([
        { type: 'text', text: 'Quick sanity run of the pipeline before moving on.' },
        { type: 'tool_use', id, name: 'Bash', input: { command: 'python src/train.py', description: 'Run the training entrypoint' } },
      ]);
      errResult(id, 'StatisticsError: variance requires at least two data points');
    }
    await beat('  … and the fix — a SECOND edit to the same file');
    edit(
      'src/features.py',
      'from statistics import mean, stdev\n\n\ndef summarize(values):\n    return {"count": len(values), "mean": mean(values)}\n\n\ndef scale(values):\n    if len(values) < 2:\n        return [0.0 for _ in values]\n    mu, sigma = mean(values), stdev(values)\n    return [(v - mu) / sigma for v in values]\n',
      'Guarding scale() against a column with fewer than two points, which made stdev() raise.'
    );
    {
      // The retry succeeds. A trailing ERROR result would leave the agent phased `errored` for the whole
      // tour, so the failure is always followed by its resolution.
      const id = tid();
      assistant([{ type: 'tool_use', id, name: 'Bash', input: { command: 'python src/train.py', description: 'Re-run the training entrypoint' } }]);
      result(id);
    }

    await beat('▸ task 2 — dataset validation');
    todos([
      { content: 'Add feature scaling to the pipeline', status: 'completed' },
      { content: 'Validate the training dataset', status: 'in_progress' },
      { content: 'Tests and docs', status: 'pending' },
      { content: 'Retire the legacy scaler', status: 'pending' },
      { content: 'Profile the pipeline', status: 'pending' },
    ]);
    taskUpdate(1, 'completed');
    taskUpdate(2, 'in_progress');
    edit(
      'src/models/dataset.py',
      'class Dataset:\n    def __init__(self, features, labels):\n        self.features = features\n        self.labels = labels\n\n    def validate(self):\n        if len(self.features) != len(self.labels):\n            return {"ok": False, "error": "features/labels length mismatch"}\n        if not self.features:\n            return {"ok": False, "error": "empty dataset"}\n        return {"ok": True}\n',
      'Adding Dataset.validate() — matching feature/label lengths and a non-empty check, returned as {ok, error}.'
    );

    // A long session fills its context window and the harness compacts it. The turns on either side
    // carry realistic context sizes so the meter shows the climb and the drop, not a flat line.
    await beat('  … three background shells: one finishes, one fails, one keeps running');
    bgShell('demo-tests', 'pytest -q --watch', 'Watch the test suite', { finish: 0 });
    bgShell('demo-lint', 'ruff check src/', 'Lint the package', { finish: 1 });
    bgShell('demo-serve', 'python -m http.server 8000', 'Serve the docs preview');

    await beat('▸ a second agent picks up a hotfix in a sibling worktree');
    sibling = runSibling();
    // Give the footprint something in every facet: a read outside the workspace, a flagged command, and
    // a web fetch — otherwise four of its six drill-downs are unreachable in the demo.
    const rd = tid();
    assistant([{ type: 'tool_use', id: rd, name: 'Read', input: { file_path: path.join(os.homedir(), '.claude', 'CLAUDE.md') } }]);
    result(rd);
    const rm = tid();
    assistant([{ type: 'tool_use', id: rm, name: 'Bash', input: { command: 'rm -rf build/', description: 'Clear the build directory' } }]);
    result(rm);
    const wf = tid();
    assistant([{ type: 'tool_use', id: wf, name: 'WebFetch', input: { url: 'https://docs.pytest.org/en/stable/' } }]);
    result(wf);
    const mc = tid();
    assistant([{ type: 'tool_use', id: mc, name: 'mcp__linear__list_issues', input: { team: 'pipeline' } }]);
    result(mc);

    await beat('  … context fills up and the harness compacts the conversation');
    assistant([{ type: 'text', text: 'Continuing — the dataset checks are in place.' }], { input_tokens: 2_400, output_tokens: 320 });
    compaction(178_000, 12_400, 165_600);
    append({
      type: 'user',
      sessionId: session,
      timestamp: clock.iso(),
      isCompactSummary: true,
      message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.' },
    });
    assistant([{ type: 'text', text: 'Picking up from the summary — tests are next.' }], { input_tokens: 900, output_tokens: 140 });

    await beat('▸ prompt 2 — asking for the tests, the docs, and the old scaler gone');
    prompt('Now the tests and the usage docs, and drop the legacy scaler.');
    taskUpdate(2, 'completed');

    await beat('▸ task 3 — tests, written by a subagent');
    todos([
      { content: 'Add feature scaling to the pipeline', status: 'completed' },
      { content: 'Validate the training dataset', status: 'completed' },
      { content: 'Tests and docs', status: 'in_progress' },
      { content: 'Retire the legacy scaler', status: 'pending' },
      { content: 'Profile the pipeline', status: 'pending' },
    ]);
    taskUpdate(3, 'in_progress');
    const subDir = path.join(proj, session, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    const spawnId = tid();
    assistant([
      { type: 'text', text: 'Handing the test-writing to a subagent while I prepare the docs workflow.' },
      { type: 'tool_use', id: spawnId, name: 'Task', input: { description: 'Write pipeline tests', subagent_type: 'general-purpose', prompt: 'Write tests for scale/summarize/validate.' } },
    ]);
    fs.writeFileSync(
      path.join(subDir, 'agent-demosub1.meta.json'),
      JSON.stringify({ agentType: 'general-purpose', description: 'Write pipeline tests', toolUseId: spawnId, spawnDepth: 1 })
    );
    const subFile = path.join(subDir, 'agent-demosub1.jsonl');
    const subLine = (blocks: unknown[]) =>
      fs.appendFileSync(
        subFile,
        JSON.stringify({
          type: 'assistant',
          isSidechain: true,
          agentId: 'demosub1',
          sessionId: session,
          timestamp: clock.iso(),
          message: { role: 'assistant', id: `demo_sub_${++toolSeq}`, usage: { input_tokens: 30, output_tokens: 90, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: blocks },
        }) + '\n'
      );
    // Resolve each subagent tool_use so its live phase classifies structurally (a pending tool_use with
    // no result would read as a stale permission block minutes later).
    const subResult = (toolUseId: string) =>
      fs.appendFileSync(
        subFile,
        JSON.stringify({
          type: 'user',
          isSidechain: true,
          agentId: 'demosub1',
          sessionId: session,
          timestamp: clock.iso(),
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: false }] },
        }) + '\n'
      );
    {
      const t = tid();
      subLine([{ type: 'tool_use', id: t, name: 'TodoWrite', input: { todos: [{ content: 'Write tests for scale/summarize/validate', status: 'in_progress' }] } }]);
      subResult(t);
    }
    await beat('  … the subagent\'s edit lands, attributed by its action window');
    {
      // The subagent's edit: captured under the parent session (exactly like real Claude Code — hooks
      // carry the parent session_id), attributed to the subagent by its transcript ts-window.
      const rel = 'tests/test_pipeline.py';
      const file = path.join(workspace, rel);
      const content =
        'import sys, pathlib\n\nsys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))\nfrom features import scale, summarize\nfrom models.dataset import Dataset\n\nscaled = scale([1.0, 2.0, 3.0])\nassert abs(sum(scaled)) < 1e-9\nassert summarize(scaled)["count"] == 3\nassert Dataset([[1.0]], [0]).validate()["ok"] is True\nassert Dataset([[1.0]], []).validate()["ok"] is False\nprint("pipeline tests: all assertions pass")\n';
      const writeId = tid();
      subLine([{ type: 'text', text: 'Covering scale, summarize, and both validate branches.' }, { type: 'tool_use', id: writeId, name: 'Write', input: { file_path: file, content } }]);
      const hook = (event: string) => ({ session_id: session, cwd, hook_event_name: event, tool_name: 'Write', tool_input: { file_path: file } });
      handleHookPayload(hook('PreToolUse'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      handleHookPayload(hook('PostToolUse'));
      subResult(writeId);
      subLine([{ type: 'text', text: 'Tests written and passing locally.' }]);
    }
    result(spawnId);

    await beat('▸ a workflow run starts — three phases, one level above the subagents');
    const wfDir = path.join(subDir, 'workflows', 'wf_demo');
    const stateDir = path.join(proj, session, 'workflows');
    const scriptsDir = path.join(stateDir, 'scripts');
    const journal = path.join(wfDir, 'journal.jsonl');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(scriptsDir, 'demo-docs-wf_demo.js'),
      "export const meta = {\n  name: 'Demo Docs',\n  description: 'Write usage docs for the training pipeline',\n  phases: [{ title: 'Outline' }, { title: 'Docs' }, { title: 'Review' }],\n}\nphase('Outline')\nphase('Docs')\nphase('Review')\n"
    );
    /** One workflow agent: its own transcript in the run dir, its own line in the journal. Phase grouping
     *  in the Workflows tab comes from the run's state file, written once the phases have all run. */
    const wfAgent = (agentId: string, phase: string) => {
      fs.writeFileSync(path.join(wfDir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }));
      fs.appendFileSync(journal, JSON.stringify({ type: 'started', key: phase, agentId }) + '\n');
      const file = path.join(wfDir, `agent-${agentId}.jsonl`);
      const line = (blocks: unknown[]) =>
        fs.appendFileSync(
          file,
          JSON.stringify({
            type: 'assistant',
            isSidechain: true,
            timestamp: clock.iso(),
            message: { role: 'assistant', id: `demo_wf_${++toolSeq}`, usage: { input_tokens: 60, output_tokens: 180, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: blocks },
          }) + '\n'
        );
      const res = (toolUseId: string) =>
        fs.appendFileSync(
          file,
          JSON.stringify({
            type: 'user',
            isSidechain: true,
            timestamp: clock.iso(),
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: false }] },
          }) + '\n'
        );
      const read = (rel: string) => {
        const t = tid();
        line([{ type: 'tool_use', id: t, name: 'Read', input: { file_path: path.join(workspace, rel) } }]);
        res(t);
      };
      const finish = () => fs.appendFileSync(journal, JSON.stringify({ type: 'result', key: phase, agentId, result: { ok: true } }) + '\n');
      return { line, res, read, finish };
    };

    const outline = wfAgent('demowf1', 'Outline');
    outline.read('src/features.py');
    outline.read('src/models/dataset.py');
    outline.line([{ type: 'text', text: 'Public surface is scale, summarize and Dataset.validate — three sections.' }]);
    outline.finish();

    // The docs agent opens its action window HERE, one beat before it writes. Attribution matches a
    // store record's wall-clock ts against the agent's [first,last] tool_use window, and the transcript
    // clock leads wall time by a millisecond per line — so an agent whose first tool_use is the write
    // itself can end up with a window that starts just AFTER the capture it is supposed to own.
    const docs = wfAgent('demowf2', 'Docs');
    docs.read('src/models/dataset.py');

    await beat('  … the docs phase writes the documentation');
    {
      const rel = 'docs/USAGE.md';
      const file = path.join(workspace, rel);
      const content =
        '# Pipeline usage\n\n```python\nfrom features import scale, summarize\nsummarize(scale([1.0, 2.0, 3.0]))  # {"count": 3, "mean": 0.0}\n```\n\nValidate a dataset before training:\n\n```python\nDataset(features, labels).validate()  # {"ok": True} | {"ok": False, "error": ...}\n```\n';
      const writeId = tid();
      docs.line([{ type: 'text', text: 'Documenting the public API with runnable examples.' }, { type: 'tool_use', id: writeId, name: 'Write', input: { file_path: file, content } }]);
      const hook = (event: string) => ({ session_id: session, cwd, hook_event_name: event, tool_name: 'Write', tool_input: { file_path: file } });
      handleHookPayload(hook('PreToolUse'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      handleHookPayload(hook('PostToolUse'));
      docs.res(writeId);
    }
    docs.read('docs/USAGE.md'); // closes the window after the capture, the way a real agent verifies its write
    docs.finish();
    const review = wfAgent('demowf3', 'Review');

    await beat('  … the review phase starts, and is still going when the replay ends');
    review.read('docs/USAGE.md');
    // Deliberately NO `finish()`: a demo whose every panel shows only aftermath never shows what work in
    // flight looks like, which is most of what these panels are for. The run reads as running for five
    // minutes from the newest of its state file and its agents' transcripts, and `demoHeartbeat` keeps
    // that window open while a tour explains it. Left alone, it settles to done on its own.
    review.line([{ type: 'text', text: 'Checking the examples against the current signatures…' }]);

    fs.writeFileSync(
      path.join(stateDir, 'wf_demo.json'),
      JSON.stringify({
        workflowName: 'Demo Docs',
        summary: 'Write usage docs for the training pipeline',
        phases: [
          { title: 'Outline', detail: 'read the public surface' },
          { title: 'Docs', detail: 'usage docs' },
          { title: 'Review', detail: 'read the result back' },
        ],
        workflowProgress: [
          { type: 'workflow_phase', index: 0, title: 'Outline' },
          { type: 'workflow_agent', label: 'outliner', phaseTitle: 'Outline', phaseIndex: 0, agentId: 'demowf1', tokens: 180, toolCalls: 2, state: 'completed', durationMs: 2000 },
          { type: 'workflow_phase', index: 1, title: 'Docs' },
          { type: 'workflow_agent', label: 'docs-writer', phaseTitle: 'Docs', phaseIndex: 1, agentId: 'demowf2', tokens: 240, toolCalls: 1, state: 'completed', durationMs: 4000 },
          { type: 'workflow_phase', index: 2, title: 'Review' },
          // Still going. `running` is `status !== 'completed'` AND a fresh mtime, so this decays honestly
          // rather than claiming to be live forever.
          { type: 'workflow_agent', label: 'reviewer', phaseTitle: 'Review', phaseIndex: 2, agentId: 'demowf3', tokens: 120, toolCalls: 1, state: 'running' },
        ],
        totalTokens: 540,
        totalToolCalls: 4,
        durationMs: 7500,
        status: 'running',
        startTime: new Date().toISOString(),
        agentCount: 3,
      })
    );

    await beat('▸ task 4 — the legacy scaler is deleted (captured by the Bash path)');
    todos([
      { content: 'Add feature scaling to the pipeline', status: 'completed' },
      { content: 'Validate the training dataset', status: 'completed' },
      { content: 'Tests and docs', status: 'completed' },
      { content: 'Retire the legacy scaler', status: 'in_progress' },
      { content: 'Profile the pipeline', status: 'pending' },
    ]);
    taskUpdate(3, 'completed');
    taskUpdate(4, 'in_progress');
    deleteViaBash(
      'src/legacy_scaler.py',
      'rm src/legacy_scaler.py',
      'scale() covers everything LegacyScaler did, and nothing imports it any more — removing it.'
    );
    taskUpdate(4, 'completed');

    await beat('▸ prompt 3 — asking for a profiling report');
    prompt('Profile it and leave me the report somewhere outside the tree.');
    todos([
      { content: 'Add feature scaling to the pipeline', status: 'completed' },
      { content: 'Validate the training dataset', status: 'completed' },
      { content: 'Tests and docs', status: 'completed' },
      { content: 'Retire the legacy scaler', status: 'completed' },
      { content: 'Profile the pipeline', status: 'in_progress' },
    ]);
    taskUpdate(5, 'in_progress');

    // A SEPARATE region of a file already edited earlier. Successive edits to the same code collapse
    // into one review unit by design (you cannot sensibly keep an edit a later one overwrote), so a
    // file needs a second, non-overlapping change before "undo one edit and keep the later edits to
    // the same file" — the review model's whole point — has anything to demonstrate.
    await beat('  … a timing helper joins features.py, in a region of its own');
    // Read defensively: the workspace can vanish under a paced replay (a `demo --clean` from another
    // shell, an Exit clicked in the editor), and a raw ENOENT here would reject the whole run instead
    // of letting the next beat's cancellation check end it cleanly.
    let featuresNow = '';
    try {
      featuresNow = fs.readFileSync(path.join(workspace, 'src/features.py'), 'utf8');
    } catch {
      /* gone — append to nothing rather than throw; the run is being torn down anyway */
    }
    edit(
      'src/features.py',
      featuresNow +
        '\n\ndef profile(values):\n    from time import perf_counter\n\n    t0 = perf_counter()\n    scale(values)\n    return {"scale_ms": (perf_counter() - t0) * 1000}\n',
      'Adding profile() at the end of the module so the timings come from the same code path training uses.'
    );

    await beat('  … the report lands OUTSIDE the workspace — what the Risk audit reports');
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, MARKER), `${session}\n`);
    editAt(
      path.join(scratch, 'profile-report.md'),
      '# Pipeline profile\n\n| stage | ms |\n| --- | --- |\n| scale | 0.4 |\n| summarize | 0.2 |\n| validate | 0.1 |\n\nNothing here is hot enough to optimize yet.\n',
      'Writing the profile outside the workspace so it does not land in the tree, as asked.',
      'Write'
    );
    taskUpdate(5, 'completed');

    await beat('▸ recap — and the next task is already under way');
    todos([
      { content: 'Add feature scaling to the pipeline', status: 'completed' },
      { content: 'Validate the training dataset', status: 'completed' },
      { content: 'Tests and docs', status: 'completed' },
      { content: 'Retire the legacy scaler', status: 'completed' },
      { content: 'Profile the pipeline', status: 'completed' },
      { content: 'Tune the scaler for sparse columns', status: 'in_progress' },
    ]);
    taskUpdate(DEMO_TASKS, 'in_progress');
    assistant([
      {
        type: 'text',
        text:
          'The pipeline scales its features, datasets are validated before training, a subagent wrote the tests, a three-phase workflow is finishing the usage docs, the legacy scaler is gone, and the profile is written outside the tree. Picking up the sparse-column follow-up the profile turned up.\n\nNext steps:\n- Take the guided tour with `oak demo --tour`, or from your editor\n- Review the pending edits in the Overview (try Accept on a whole prompt)\n- Run `python observatory-demo/tests/test_pipeline.py`\n- Remove the demo with `oak demo --clean`',
      },
    ]);
  };

  try {
    await scenario();
  } catch (e) {
    if (!(e instanceof DemoCancelled)) throw e;
    cancelled = true;
  }
  const edits = readLog(session).length;
  say(
    `${cancelled ? '⨯ demo stopped early —' : '✔ demo session'} ${session} — ${edits} captured edits across ${steps} beats` +
      (sibling ? ` (+ a sibling agent on demo/hotfix)` : '')
  );
  return { session, sibling, workspace, scratch, transcript, edits, steps, cancelled };
}

/**
 * Every demo session recorded for this project, across both project dirs — the primary session's and
 * the sibling agent's. Newest transcript first.
 *
 * This is how a front-end knows a demo EXISTS, which is not the same question as whether a demo is the
 * session currently under review. Session resolution follows the newest transcript, so one real Claude
 * turn after a demo (or a window that crashed mid-demo) makes the demo stop being "current" — and a UI
 * that gated its Exit action on "current" would take away the only way out at exactly that moment,
 * leaving the folder, two sessions and a scratch dir behind with nothing offering to remove them.
 */
export function demoSessionsFor(opts: { cwd?: string; dir?: string } = {}): string[] {
  let cwd = opts.cwd ?? process.cwd();
  try {
    cwd = fs.realpathSync(cwd);
  } catch {
    /* keep as given */
  }
  const candidate = demoPath(opts.dir ?? path.join(cwd, 'observatory-demo'));
  const found: { id: string; ms: number }[] = [];
  for (const proj of new Set([projectDir(cwd), projectDir(candidate)])) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(proj);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -'.jsonl'.length);
      if (!isDemoSession(id)) continue;
      let ms = 0;
      try {
        ms = fs.statSync(path.join(proj, name)).mtimeMs;
      } catch {
        continue; // vanished mid-scan
      }
      found.push({ id, ms });
    }
  }
  return found.sort((a, b) => b.ms - a.ms).map((f) => f.id);
}

/**
 * Keep a running demo LIVE: bump the mtime of every demo transcript for this project (both the primary
 * session's and the sibling agent's). A fleet row is `active` only within FLEET_ACTIVE_MS (60s) of its
 * transcript's last write, and the live file-collision badge needs at least one active holder — so
 * without this the two headline Fleet steps of a guided tour go quiet while they are being explained.
 *
 * Touch only: no content is written and no record is invented, so nothing it does can be mistaken for
 * activity that did not happen. Returns the transcripts it touched.
 *
 * Call it on a tour step advance, NEVER inside a refresh loop: touching a watched file wakes the
 * editors' transcript watchers, so a heartbeat driven by a refresh would re-trigger itself forever.
 */
export function demoHeartbeat(opts: { cwd?: string; dir?: string } = {}): string[] {
  let cwd = opts.cwd ?? process.cwd();
  try {
    cwd = fs.realpathSync(cwd);
  } catch {
    /* keep as given */
  }
  const candidate = demoPath(opts.dir ?? path.join(cwd, 'observatory-demo'));
  const now = new Date();
  const touched: string[] = [];
  for (const proj of new Set([projectDir(cwd), projectDir(candidate)])) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(proj);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -'.jsonl'.length);
      if (!isDemoSession(id)) continue;
      const file = path.join(proj, name);
      try {
        fs.utimesSync(file, now, now);
        touched.push(file);
      } catch {
        /* vanished mid-tour — nothing to keep alive */
      }
      // …and the workflow run's state file, which is what holds the in-flight run inside its own
      // five-minute window. ONLY this file: it matches neither editor's watcher globs, so touching it
      // wakes nothing — where the agent transcripts beside it ARE watched, and bumping those would give
      // a heartbeat the very self-retriggering loop the comment above warns about.
      let runs: string[] = [];
      try {
        runs = fs.readdirSync(path.join(proj, id, 'workflows'));
      } catch {
        continue; // no workflow runs recorded for this session
      }
      for (const f of runs) {
        if (!f.startsWith('wf_') || !f.endsWith('.json')) continue;
        const state = path.join(proj, id, 'workflows', f);
        try {
          fs.utimesSync(state, now, now);
          touched.push(state);
        } catch {
          /* gone — the run is over either way */
        }
      }
    }
  }
  return touched;
}

// --- cleanup --------------------------------------------------------------------------------------

export interface DemoCleanResult {
  /** Demo session ids removed (transcript + subagents/workflows + store), across both project dirs. */
  sessions: string[];
  /** Workspace folders removed (only ones carrying the `.observatory-demo` marker). */
  workspaces: string[];
  /** Scratch dirs removed — where the outside-the-workspace write landed (marker-gated the same way). */
  scratch: string[];
}

/**
 * Remove every trace of the simulator for this project: each `demo-<8hex>` session's transcript, its
 * `<proj>/<session>/` tree (subagents + workflows), its store, and the demo workspace folder — but a
 * workspace is only deleted when it carries the `.observatory-demo` sentinel (never a user directory,
 * even if passed via --dir by mistake). Real sessions can never match the id gate.
 */
export function cleanDemo(opts: { cwd?: string; dir?: string } = {}): DemoCleanResult {
  let cwd = opts.cwd ?? process.cwd();
  try {
    cwd = fs.realpathSync(cwd); // the same physical-path rule runDemo records under
  } catch {
    /* keep as given */
  }
  const candidate = demoPath(opts.dir ?? path.join(cwd, 'observatory-demo'));
  const sessions: string[] = [];
  const scratch: string[] = [];
  // BOTH project dirs: the primary session records under the open project, and the sibling agent
  // records under the demo workspace (that is what makes it a second worktree of the same repo).
  // `projectDir` is a pure string mangle, so this still resolves after the workspace is gone.
  for (const proj of new Set([projectDir(cwd), projectDir(candidate)])) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(proj);
    } catch {
      continue; // no project dir — nothing recorded there
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -'.jsonl'.length);
      if (!isDemoSession(id)) continue;
      try {
        removeUsageCursor(path.join(proj, name)); // keyed by transcript path — removeSession can't reach it
        fs.rmSync(path.join(proj, name), { force: true });
        fs.rmSync(path.join(proj, id), { recursive: true, force: true }); // subagents/ + workflows/
        fs.rmSync(path.join(claudeConfigDir(), 'tasks', id), { recursive: true, force: true }); // the task list (0.8.3)
        removeSession(id); // the store (log + blobs)
        // The scratch dir the outside-the-workspace write landed in — marker-gated like the workspace.
        const scr = path.join(scratchRoot(), id);
        if (fs.existsSync(path.join(scr, MARKER))) {
          fs.rmSync(scr, { recursive: true, force: true });
          scratch.push(scr);
        }
        sessions.push(id);
      } catch {
        /* best-effort per session */
      }
    }
    // The sibling's project dir exists only for the demo; drop it once its sessions are gone. rmdirSync
    // fails (and is ignored) while anything real remains, so a shared dir is never removed.
    if (proj !== projectDir(cwd)) {
      try {
        fs.rmdirSync(proj);
      } catch {
        /* still holds something — leave it */
      }
    }
  }
  const workspaces: string[] = [];
  // Demo sessions with NO transcript — the ACP scenario's, whose whole conversation is its store
  // sidecar. The transcript scan above can never find them, and the store's own pruner explicitly
  // protects sidecar-holding sessions, so without this sweep `demo --clean` left an orphan
  // `[acp-only] demo-*` row in every session picker forever. `isDemoSession` is the same gate that
  // authorizes every other demo removal.
  for (const id of allStoreSessionIds()) {
    if (!isDemoSession(id) || sessions.includes(id)) continue;
    try {
      removeSession(id);
      sessions.push(id);
    } catch {
      /* best-effort per session */
    }
  }
  if (fs.existsSync(path.join(candidate, MARKER))) {
    try {
      fs.rmSync(candidate, { recursive: true, force: true });
      workspaces.push(candidate);
    } catch {
      /* leave it — the marker still identifies it for a retry */
    }
  }
  try {
    fs.rmdirSync(scratchRoot()); // only when the last demo's scratch is gone
  } catch {
    /* other demos still hold scratch dirs, or it never existed */
  }
  return { sessions, workspaces, scratch };
}
