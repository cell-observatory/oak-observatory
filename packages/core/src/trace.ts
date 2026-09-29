/**
 * The FULL session trace — everything the observatory recorded for one session, composed into a
 * single exportable document.
 *
 * Nothing here derives anything new: every section is the same builder a panel already renders —
 * the edit log with per-edit deltas and unified diffs, capture skips, prompts, the action timeline,
 * tasks and subagents, egress and outside-workspace writes, observations, token usage, and the
 * change-map summary — so the export can never disagree with the UI. Built in core so the CLI,
 * VS Code, and JetBrains all export the identical document.
 *
 * A section that fails to build becomes `null` and its name lands in `errors` — the `views` batch
 * precedent: one unbuildable section must not cost the reader the other nine, and a named failure is
 * loud where a silently-missing key would not be. Diffs are recomputed from the stored blobs, so a
 * big session exports in one shot at proportional cost — this runs on an explicit user action, never
 * on a refresh tick.
 */
import { EditRecord, readLog, readSkips, SkipOp } from './store';
import { lineDelta, coloredDiff } from './format';
import { cachedChangeMap, ChangeMapSummary } from './changemap';
import { sessionPrompts, SessionPrompt } from './prompts';
import { parseActions, ActionRecord } from './actions';
import { allSessionTaskRows, parseSubagents, SubagentInfo } from './subagents';
import { SessionTaskRow } from './tasks';
import { buildEgressReport, EgressChannel } from './egress';
import { outsideWrites, OutsideWrite } from './risk';
import { buildObservations, Observations } from './observe';
import { sessionUsage, SessionTokens } from './metrics';

export interface TraceEdit extends EditRecord {
  added: number;
  removed: number;
  /** Unified diff (plain, uncolored) reconstructed from the stored before/after blobs. */
  diff: string;
}

export interface SessionTrace {
  exportedAt: string; // ISO timestamp of the export itself
  tool: string; // "oak" + the exporting front-end's version when it supplies one
  session: string;
  title: string; // human-readable session name ('' when the transcript has neither title nor prompt)
  root: string; // the workspace root paths are shown relative to
  summary: ChangeMapSummary | null;
  edits: TraceEdit[];
  skips: SkipOp[]; // captures the hook declined, with the recorded reason
  prompts: SessionPrompt[] | null;
  actions: ActionRecord[] | null; // every tool call, not just the edits
  tasks: SessionTaskRow[] | null;
  subagents: SubagentInfo[] | null;
  egress: EgressChannel[] | null;
  outsideWrites: OutsideWrite[] | null;
  observations: Observations | null;
  usage: (SessionTokens & { durationMs: number }) | null;
  errors: string[]; // names of sections that failed to build — never silently absent
}

export function buildSessionTrace(
  cwd: string,
  sessionId: string,
  opts: { root?: string; toolVersion?: string } = {}
): SessionTrace {
  const root = opts.root ?? cwd;
  const errors: string[] = [];
  function sec<T>(name: string, build: () => T): T | null {
    try {
      return build();
    } catch {
      errors.push(name);
      return null;
    }
  }

  const log = sec('edits', () => readLog(sessionId)) ?? [];
  // Diff-byte budget: a pathological store (hundreds of MB of blobs) otherwise builds ~850 MB of diff
  // text and JSON.stringify dies on V8's string cap after a multi-GB allocation spike — measured on a
  // real 7,900-edit session. Past the budget, edits keep every OTHER field and the omission is NAMED
  // in `errors` (one entry, first omitted id) — loud, never silent.
  const TRACE_DIFF_BUDGET_BYTES = 64 * 1024 * 1024;
  let diffBytesLeft = TRACE_DIFF_BUDGET_BYTES;
  let diffsOmittedFrom: number | null = null;
  const edits: TraceEdit[] = log.map((r) => {
    const d = sec(`delta #${r.id}`, () => lineDelta(sessionId, r)) ?? { added: 0, removed: 0 };
    let diff = '';
    if (diffsOmittedFrom === null) {
      diff = sec(`diff #${r.id}`, () => coloredDiff(sessionId, r, false)) ?? '';
      diffBytesLeft -= Buffer.byteLength(diff);
      if (diffBytesLeft < 0) {
        diffsOmittedFrom = r.id;
        diff = '';
      }
    }
    return { ...r, added: d.added, removed: d.removed, diff };
  });
  if (diffsOmittedFrom !== null)
    errors.push(
      `diffs omitted from edit #${diffsOmittedFrom} onward — the session exceeds the ` +
        `${TRACE_DIFF_BUDGET_BYTES / (1024 * 1024)} MB diff budget (deltas and blob shas are still present)`
    );
  const actions = sec('actions', () => parseActions(cwd, sessionId));
  const summary = sec('summary', () => cachedChangeMap(cwd, sessionId, { root, prompts: true }).summary);

  return {
    exportedAt: new Date().toISOString(),
    tool: 'oak' + (opts.toolVersion ? ` ${opts.toolVersion}` : ''),
    session: sessionId,
    title: summary?.title ?? '',
    root,
    summary,
    edits,
    skips: sec('skips', () => readSkips(sessionId)) ?? [],
    prompts: sec('prompts', () => sessionPrompts(cwd, sessionId)),
    actions,
    tasks: sec('tasks', () => allSessionTaskRows(cwd, sessionId)),
    subagents: sec('subagents', () => parseSubagents(cwd, sessionId)),
    egress: actions ? sec('egress', () => buildEgressReport(actions)) : null,
    outsideWrites: actions ? sec('outsideWrites', () => outsideWrites(actions, root)) : null,
    observations: sec('observations', () => buildObservations(cwd, sessionId, { root })),
    usage: sec('usage', () => sessionUsage(cwd, sessionId)),
    errors,
  };
}
