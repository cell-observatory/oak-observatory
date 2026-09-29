/**
 * The guided tour's script (0.8.9): an ordered list of steps that walks every surface of the
 * observatory, written once here and rendered by the CLI, the VS Code extension and the JetBrains
 * plugin alike. Keeping it in core is what makes the three tours the same tour — a step added to a
 * panel reaches every editor at once, and none of them can quietly drift into its own wording.
 *
 * Pure data: no IO, no state, no dependency on a session existing. It pairs with the demo simulator
 * (`runDemo`), whose scenario is arranged so that every step below has something real to point at —
 * three prompts, six tasks, two agents with a live collision, a three-phase workflow, three
 * background shells in three different states, a deletion, a failed tool call, and one write outside
 * the workspace. A step whose data the scenario does not produce would be a tour of empty states.
 *
 * Each step names a `view` (and, for the Overview, a `tab`) that each editor maps to its own
 * activation, plus an optional `anchor` naming one control inside that view to highlight. The shape is
 * deliberately FLAT rather than a discriminated union: it crosses a JSON boundary into Kotlin, where a
 * flat record parses without a custom deserializer.
 *
 * Renderers must degrade rather than throw on anything they do not recognize — an unknown `view` or
 * `anchor` means "show the text, skip the activation", never an error. That is what lets core add a
 * step for a surface an older editor build has never heard of.
 */

/** A surface the tour can bring forward. `editor` means the file itself, not a panel. N15 removed
 *  `edits`/`diffs` with their trees — Review is the one review surface; older renderers seeing an
 *  unknown view degrade to text-only by contract, so shrinking the set is additive-safe. */
export type DemoView =
  | 'overview'
  | 'prompts'
  | 'review'
  | 'stats'
  | 'fileHistory'
  | 'actions'
  | 'observations'
  // The Timeline's Feed tab — the conversation and the activity, one surface. Older renderers seeing
  // this unknown view degrade to text-only by contract.
  | 'feed'
  | 'editor';

/** The Overview's left-nav tabs, in their shipped order. */
export type DemoOverviewTab = 'sessions' | 'fleet' | 'workflows' | 'tasks' | 'processes';

/**
 * One control inside a view, for the highlight. Kept to a small closed set that both editors can map
 * exhaustively: an anchor nobody can point at is worse than no anchor, because the step's text would
 * name something the reader cannot find.
 *
 * Names are GLOBALLY unique, not unique per panel. The editors broadcast an anchor to every tour-aware
 * panel and each rings it only if its own map knows the name — which is what lets a Prompts step ring
 * "Accept Prompt", a control that lives in the Overview beside it. A name used by two panels would ring
 * both. A core test pins the uniqueness.
 */
export type DemoAnchor =
  | 'nav-tabs' // the Overview's left-nav tab row
  | 'folders-strip' // the churn-by-folder strip
  | 'files-ledger' // the churn-ranked file list
  | 'summary-bar' // the pending/accepted totals under the ledger
  | 'feed' // the Timeline's Feed tab body
  | 'nav-axes' // the review nav bar: Diff · File · Folder · Prompt
  | 'accept-prompt' // "Accept All in #N"
  | 'session-label' // which session the panels are showing
  | 'spotlight' // dim the unedited lines
  | 'prompts-list' // the Prompts window's list of asks
  | 'session-picker' // the Timeline's active-session selector
  | 'stats-model' // the model + effort chip
  | 'stats-compaction' // the compaction readout
  | 'stats-tokens' // the input/output/cached split
  | 'stats-cache' // the cache-hit cell inside it
  | 'stats-usage' // the context and plan-usage bars
  | 'stats-review'; // the pending / accepted / reverted scoreboard

export interface DemoStep {
  /** Stable kebab id. Tests and both editors key on it; never renumber, only append or rename with care. */
  id: string;
  /** One line, sentence case, no trailing period. */
  title: string;
  /** One to three complete sentences. Plain text — a webview and a Swing label must render it alike. */
  body: string;
  view: DemoView;
  /** Required when `view` is 'overview'; meaningless otherwise. */
  tab?: DemoOverviewTab;
  /** A one-line gloss of the panel this step is about, rendered in the TOUR WINDOW under the body. It
   *  is deliberately not drawn inside the panel itself: an in-panel strip was tried in 0.8.9 and removed,
   *  because it covered the very control the step was pointing at. */
  tip?: string;
  /** One control in that view to highlight, when there is a single obvious one. */
  anchor?: DemoAnchor;
  /** One concrete thing the reader can do from where they are standing. Everything here really works.
   *  Never set alongside `action` — two "do this" lines on one step is exactly the inconsistency the
   *  two action labels exist to avoid. */
  tryIt?: string;
  /** What this step asks for, or does. See {@link DemoAction}. */
  action?: DemoAction;
  /**
   * In the short track. The full tour explains every panel and every named feature, which is more than
   * anyone wants when they have five minutes and someone waiting — so the short track is a FILTER over
   * this one list rather than a second script, and the two can never tell different stories.
   */
  essential?: boolean;
}

/**
 * What a step asks the reader to do (`wait`) or does on their behalf (`auto`).
 *
 * A tour that only ever talks is a tour nobody remembers. But a tour that only ever waits is a tour that
 * can strand you, so the script mixes the two — and because a mixture reads as inconsistent unless it is
 * labelled, there are exactly two labels and every action step wears one.
 *
 * The kinds are a closed set, and every one of them is decided from the STORE rather than from editor
 * UI state. That is what lets one pure function (`demoActionState`) make the decision for both editors
 * and for a headless test. Kinds that would have needed a new channel out of a webview or a Swing panel
 * — "select this row", "type in the search box" — were deliberately left out; `tryIt` prose does that
 * job for free.
 */
export type DemoActionKind =
  | 'keep-edit' // accept one pending edit
  | 'undo-edit' // revert one edit
  | 'keep-prompt' // accept everything one ask produced
  | 'keep-task' // accept one task's strict span
  | 'open-demo-file' // open a file the demo changed, at its edit
  | 'toggle-spotlight'; // dim the lines Claude did not touch

export interface DemoAction {
  /** `wait` pauses on the step until the reader does it; `auto` does it and narrates. */
  mode: 'wait' | 'auto';
  kind: DemoActionKind;
  /** One line. Imperative for `wait` ("Keep one edit"), descriptive for `auto`. */
  hint: string;
  /** Past tense, one line. Present if and only if `mode` is `auto`. */
  done?: string;
}

/** Which track to walk. Each is a FILTER over one list — never a second script. */
export type DemoTrack = 'essentials' | 'everything' | 'remainder';

/** The review counts a `wait` step watches. Snapshotted on entry, recomputed on each store change. */
export interface DemoActionSnapshot {
  kept: number;
  undone: number;
  /** Still awaiting review. Zero means there is nothing left to accept, whatever the total says. */
  pending: number;
  /** Every record in the log, resolved or not — zero means the session's records are gone. */
  total: number;
}

export type DemoActionState = 'waiting' | 'satisfied' | 'vacated';

/**
 * Has the reader done what this step asked? Pure, so both editors and the test suite reach the same
 * verdict from the same two snapshots.
 *
 * `vacated` means "there is nothing left to do here", and it has two shapes, both of which would
 * otherwise HANG the step exactly when the reader had done the most work:
 *
 *   · the records are GONE. A demo session whose edits are all resolved drops its own records
 *     (`autoClearDemo`), so a reader who reviews everything makes `kept` fall to zero — a decrease,
 *     which a watcher looking only for "kept went up" would never see.
 *   · nothing is PENDING. All resolved but the records still there (a real session, or a demo whose
 *     resolved edits were not cleared): "accept an edit" has no edit left to accept.
 *
 * Undo is deliberately not subject to the second: a kept edit can still be reverted, so only an empty
 * log ends that one.
 */
export function demoActionState(
  kind: DemoActionKind,
  before: DemoActionSnapshot,
  now: DemoActionSnapshot
): DemoActionState {
  // The records were cleared under us, or there were never any.
  if (now.total === 0) return 'vacated';
  switch (kind) {
    case 'keep-edit':
    case 'keep-prompt':
    case 'keep-task':
      if (now.kept > before.kept) return 'satisfied';
      return now.pending === 0 ? 'vacated' : 'waiting'; // nothing left to accept
    case 'undo-edit':
      return now.undone > before.undone ? 'satisfied' : 'waiting';
    // Never shipped as `wait` — the editor performs these. Waiting is the safe answer for an editor
    // that somehow armed one anyway: the panel's Skip is always live, so it cannot trap anybody.
    default:
      return 'waiting';
  }
}

/**
 * A wait step's grace before the tour performs the action itself.
 *
 * A tour left playing must still finish, and a reader who only watches should still see Keep and Undo
 * actually happen rather than be told about them — so an unanswered ask self-applies instead of being
 * skipped. Nine seconds is the same grace the site's interactive demo (docs/showcase.html#demo) gives
 * its gates, deliberately: the page and the product should behave alike rather than two ways.
 */
export const DEMO_ACTION_COUNTDOWN_MS = 9_000;

/**
 * Reading speed the dwell is derived from, in characters per second.
 *
 * Faster than careful reading on purpose: this paces a demo somebody is WATCHING while the panels move
 * under it, not a page they are studying. The pause control is what serves a reader who wants longer,
 * and the clamps below keep the shortest step from flashing past and the longest from stalling.
 */
const DEMO_READ_CPS = 46;
const DEMO_DWELL_MIN_MS = 3_500;
const DEMO_DWELL_MAX_MS = 9_000;

/**
 * How long a step holds before autoplay advances, derived from its own text.
 *
 * A flat dwell is what the site's browser demo uses, and it is right there — its captions are one line.
 * These bodies run two to three sentences, so a flat timer would either outrun the dense steps (the
 * audits, the cache-rate explanation) or crawl through the short ones. Clamped at both ends so no step
 * flashes past and none stalls; the pause control is always there for a reader who wants longer.
 */
export function demoStepDwellMs(step: DemoStep): number {
  const chars = step.body.length + (step.tip?.length ?? 0) + (step.tryIt?.length ?? 0);
  const ms = Math.round((chars / DEMO_READ_CPS) * 1000);
  return Math.min(DEMO_DWELL_MAX_MS, Math.max(DEMO_DWELL_MIN_MS, ms));
}

/**
 * The tour, in order: what you are looking at, the two groupings of a session (prompts and tasks), the
 * agents, the change map and its parts, every review surface, the audits, and how to leave. Every panel
 * the product ships and every named feature has a step; `essential` marks the short track through them.
 */
export function demoTour(track: DemoTrack = 'everything'): DemoStep[] {
  const all = allSteps();
  if (track === 'essentials') return all.filter((s) => s.essential);
  if (track === 'remainder') return all.filter((s) => !s.essential);
  return all;
}

/** How many steps each track holds — for a chooser that has to say so before any is started. */
export function demoTrackSizes(): { essentials: number; remainder: number; everything: number } {
  const all = allSteps();
  const essentials = all.filter((s) => s.essential).length;
  return { essentials, remainder: all.length - essentials, everything: all.length };
}

/**
 * The closing sentence for a track. It lives here rather than in the last step's body because that body
 * has to read correctly on all three tracks: "That is the tour" is false when twenty-four steps are
 * being offered next. Prose stays in core; the panel just renders it.
 */
export function demoTrackBlurb(track: DemoTrack): string {
  const n = demoTrackSizes().remainder;
  if (track === 'essentials') {
    return `That is the short track. ${n} more steps cover the rest of the panels and the features this one skipped.`;
  }
  if (track === 'remainder') return 'That is the rest of it — you have now seen every panel the observatory ships.';
  return 'That is the tour — every panel the observatory ships, and every feature it names.';
}

function allSteps(): DemoStep[] {
  return [
    {
      id: 'welcome',
      essential: true,
      title: 'A simulated session, recorded for real',
      body:
        'Nothing here called a model. The demo writes the files a real Claude Code session would have written and lets the ordinary capture hooks record them, so every panel you are about to see is reading a genuine session and every button really works. Reviewing an edit reviews it; undoing one restores the file.',
      view: 'overview',
      tab: 'sessions',
      tip: 'The demo session, recorded through the real capture pipeline.',
      anchor: 'session-label',
      tryIt: 'Leave at any time with Exit Demo, which removes every trace it wrote.',
    },
    {
      id: 'sessions',
      title: 'Sessions — which one you are reviewing',
      body:
        'The Overview begins with the question that precedes every other one: which session these panels are showing. Sessions are grouped by workspace on this machine, the editor’s workspace first. Rows follow conversation recency; selecting a local row switches the whole observatory. Each row shows its title and statistics.',
      view: 'overview',
      tab: 'sessions',
      tip: 'Selecting a local row switches what the whole observatory reviews.',
      anchor: 'nav-tabs',
    },
    {
      id: 'prompts',
      essential: true,
      title: 'Prompts — the session as the conversation you had',
      body:
        'One row per thing you asked for, in order. Each carries what it produced: edits and their line counts, files and folders touched, tokens spent answering, the agents and background shells it started, the tool calls that failed, and how long it took. This demo asked for three things.',
      view: 'prompts',
      anchor: 'prompts-list',
      tip: 'One row per ask, with everything that ask caused.',
      tryIt: 'Prompt 1 shows a failed tool call — the sanity run that raised before the fix landed.',
    },
    {
      id: 'timeline-session',
      title: 'Choosing which session the timeline shows',
      body:
        'The selector at the top of the Timeline names the session the observatory is reviewing. Picking another one switches every panel, so moving between two live conversations is one click. The Overview Sessions tab lists every session, grouped by workspace.',
      view: 'prompts',
      tip: 'Picking a session here switches every panel; the Overview lists them all.',
      anchor: 'session-picker',
    },
    {
      id: 'prompt-scope',
      essential: true,
      title: 'A prompt is also a review scope',
      body:
        'Selecting an ask narrows the Overview beside it to the work that ask caused, and the bulk actions retarget with it. Attribution is by what a prompt started, never by what happened to finish while it ran.',
      view: 'prompts',
      tip: 'Selecting an ask scopes the Overview and the bulk actions to it.',
      anchor: 'accept-prompt',
      action: {
        mode: 'wait',
        kind: 'keep-prompt',
        hint: 'Select prompt 2, then Accept Prompt — exactly the edits that ask produced.',
      },
    },
    {
      id: 'review-tab',
      essential: true,
      title: 'Review — one ask, as a list',
      body:
        'Selecting an ask — as you just did — scopes the Review list to exactly that prompt’s work. Repeated edits to the same code arrive combined into one unit — a superseded intermediate state never asks for a decision. The list holds no code: a row opens that unit’s NET diff in the editor, and "Open all in editor" reads the pending work as one concatenated view, each diff with its own Keep and Undo. Keep or undo act per unit, or on everything listed at once.',
      view: 'review',
      tip: 'One row per piece of code the ask changed, however many times Claude revised it.',
    },
    {
      id: 'fleet',
      essential: true,
      title: 'Workers — every agent working in this repo',
      body:
        'Claude running in several git worktrees of one repository unifies here, one row per agent, with a live phase, its branch, an activity sparkline, line counts, and its risk and outside-the-workspace counts. The demo runs two: this session on demo/pipeline, and a hotfix agent on demo/hotfix. The correlation reads git\'s pointer files and never runs git.',
      view: 'overview',
      tab: 'fleet',
      tip: 'Two agents in this repo: this session, and a hotfix agent on demo/hotfix.',
      anchor: 'nav-tabs',
      tryIt: 'Select the hotfix agent to map its changes instead of this session\'s.',
    },
    {
      id: 'fleet-conflict',
      essential: true,
      title: 'The collision badge — two agents, one file',
      body:
        'Both agents are holding an unresolved edit to src/features.py, so the observatory flags it. This is deliberately narrower than "two agents touched this file": the edit must still be pending on both sides, and at least one of them must be active. Paths are compared, never contents — nothing crosses between agents.',
      view: 'overview',
      tab: 'fleet',
      tip: 'src/features.py is pending in both agents — whoever writes next can trample the other.',
      tryIt: 'The badge is per-file: both agents hold it unresolved, so neither can review it knowing what the other did.',
    },
    {
      id: 'subagents',
      title: 'Subagents nest under the agent that spawned them',
      body:
        'The Workers tab nests subagents beneath the agent that spawned them, each with its own task, to-dos and edits. Its edit was captured under the parent session, exactly as Claude Code records one, and attributed back to the subagent by the window of its own tool calls rather than by guesswork.',
      view: 'overview',
      tab: 'fleet',
      tip: 'The test writer is a subagent; its edit is attributed by its action window.',
    },
    {
      id: 'workflows',
      title: 'Workflows — multi-agent runs, grouped by phase',
      body:
        'A workflow run sits one level above the subagents: several agents working through named phases. The demo run has three phases and one agent each, with per-agent tokens, wall time and edits, and the run\'s own attributed edits below.',
      view: 'overview',
      tab: 'workflows',
      tip: 'Three phases — Outline, Docs, Review — with one agent each.',
      anchor: 'nav-tabs',
    },
    {
      id: 'tasks',
      essential: true,
      title: 'Tasks — Claude\'s own numbered plan',
      body:
        'The other grouping of a session. A task owns only the edits captured while that task was in progress, so an edit outside every in-progress window stays unassigned rather than being attributed to a neighbouring task. Each row accepts, rejects or clears its own edits.',
      view: 'overview',
      tab: 'tasks',
      tip: 'A task owns only what was captured while it was in progress.',
      anchor: 'nav-tabs',
      tryIt: 'Accept task 1 to accept the two edits it produced, and nothing else.',
    },
    {
      id: 'task-review',
      title: 'Accepting a whole task at once',
      body:
        'In the Tasks tab, a row accepts, rejects or clears exactly the edits captured while that task was in progress \u2014 its strict span, never a guess. That is the unit to reach for when a plan step is right in full: one action, and the edits that belong to it resolve together.',
      view: 'overview',
      tab: 'tasks',
      tip: 'Each row acts on its own strict span, and nothing else.',
      action: {
        mode: 'auto',
        kind: 'keep-task',
        hint: 'Accepting one task, so you can watch which files move.',
        done: 'Accepted a task — in the Files ledger, exactly its files went green and nothing else did.',
      },
    },
    {
      id: 'processes',
      title: 'Processes — the background shells',
      body:
        'Every shell the session started in the background, with its state, runtime and how much output it produced. The demo starts three: one still running, one that exited cleanly, and one that failed. The identifiers are the harness\'s own, because a transcript records no operating-system process id.',
      view: 'overview',
      tab: 'processes',
      tip: 'Three shells: one running, one exited 0, one failed.',
      anchor: 'nav-tabs',
      tryIt: 'Select a shell to tail its output in the Timeline’s Feed tab.',
    },
    {
      id: 'folders-strip',
      essential: true,
      title: 'The Folders strip — where the change landed',
      body:
        'The detail pane opens with churn by directory, coloured by review status, so the shape of a change is visible before any of it is read. One tile here is labelled (external): the session wrote a profiling report outside your workspace, and the strip says so rather than hiding it.',
      view: 'overview',
      tab: 'tasks',
      tip: 'Churn by folder. The (external) tile is the write that landed outside your workspace.',
      anchor: 'folders-strip',
      tryIt: 'Click a tile to jump the review to that folder\'s first pending edit.',
    },
    {
      id: 'files-ledger',
      essential: true,
      title: 'The Files ledger — ranked by how much changed',
      body:
        'Below the strip, one row per file, ordered by churn, each with its line counts and review status. The deleted file appears here too: src/legacy_scaler.py was removed by a shell command, and the removal is a reviewable edit like any other.',
      view: 'overview',
      tab: 'tasks',
      tip: 'One row per file, ranked by churn. Deletions are reviewable edits too.',
      anchor: 'files-ledger',
    },
    {
      id: 'deletion',
      title: 'A deleted file is a reviewable edit',
      body:
        'One row in the Files ledger is a file that no longer exists: the scenario removed src/legacy_scaler.py with a shell command, and the tree-diff capture recorded the removal like any other change. Undoing it puts the file back, byte for byte, from the snapshot taken before the command ran. In the editor a deleted file shows its removed lines as ghosts rather than vanishing silently.',
      view: 'overview',
      tab: 'tasks',
      tip: 'src/legacy_scaler.py was deleted \u2014 undo restores it.',
      anchor: 'files-ledger',
    },
    {
      id: 'summary-bar',
      title: 'The summary bar counts exactly what is shown',
      body:
        'The totals under the ledger describe the current scope, not the whole session. Narrow the Overview to one prompt or one agent and they narrow with it, so the number you are reading always matches the rows above it.',
      view: 'overview',
      tab: 'tasks',
      tip: 'These totals follow the current scope, not the whole session.',
      anchor: 'summary-bar',
    },
    {
      id: 'feed',
      title: 'The Feed tab',
      body:
        'The Timeline’s Feed tab is the selected conversation as it happened: your prompts, the agent’s replies and thinking, every tool call with the diff it produced, and the permissions it asked for — followed as the transcript grows. Picking a worker, run, task or shell in the Overview points the same tab at that thing’s own activity. New sessions and explicit prompt submissions use herdr.',
      view: 'feed',
      tip: 'Select a session to read its conversation; open herdr to interact with the running agent.',
      anchor: 'feed',
    },
    {
      id: 'nav-axes',
      title: 'Four axes to review along',
      body:
        'The nav bar steps through the session by diff, by file, by folder, or by prompt, and each axis carries the bulk actions that make sense at its scope. The same bar appears in the status bar, on the editor tab, and floating over the code at the edit itself, so review never depends on which surface you happen to be looking at.',
      view: 'overview',
      tab: 'tasks',
      tip: 'Diff, File, Folder and Prompt — each with the bulk actions for its scope.',
      anchor: 'nav-axes',
    },
    {
      id: 'status-bar',
      title: 'The same review bar, in the status bar',
      body:
        'The four axes and the review scoreboard also live in the status bar and on the editor\u2019s tab bar, so reviewing never depends on which panel happens to be open. The microscope shows how many edits are still pending, and clicking it jumps to the oldest one.',
      view: 'overview',
      tab: 'tasks',
      tip: 'The bar follows you \u2014 status bar, editor tab, and floating at the edit.',
      anchor: 'nav-axes',
    },
    {
      id: 'search',
      title: 'Search and Active only',
      body:
        'Search filters the Review list and the Overview ledger by path, and Active only narrows the Overview to what is still moving \u2014 agents and runs in flight, edits still awaiting review. Both persist, so a large session can be worked in slices. Reset scope, beside Search, clears the search, folder and prompt scopes at once.',
      view: 'overview',
      tab: 'fleet',
      tip: 'Search filters by path; Active only hides what has settled.',
    },
    {
      id: 'review-list',
      essential: true,
      title: 'Review — every change, one decision each',
      body:
        'The sidebar holds the running list: every change Claude made, grouped by file, each with its own Keep and Undo. Successive edits to the same code collapse into one unit, because keeping an edit that a later edit already overwrote would not mean anything. Decided rows stay listed, greyed — an undone one offers redo, a kept one can still be reverted.',
      view: 'review',
      tip: 'Every change, grouped by file, each with its own Keep and Undo.',
      action: { mode: 'wait', kind: 'keep-edit', hint: 'Keep any one edit — the tour is watching for it.' },
    },
    {
      id: 'explorer-badges',
      title: 'Pending edits show up in the file tree',
      body:
        'Files with edits still awaiting review carry a badge in the editor\u2019s own project tree, so work in progress is visible from where you already navigate rather than only inside the observatory.',
      view: 'review',
      tip: 'Your file explorer badges the files that still have pending edits.',
    },
    {
      id: 'clear-resolved',
      title: 'Clearing what you have already decided',
      body:
        'Accepting and rejecting resolve an edit but keep it in the log, so the record of what happened stays complete. Clear Resolved drops the ones you have settled and leaves the pending ones \u2014 the way to shorten a long session without losing what is still to review.',
      view: 'review',
      tip: 'Resolved edits stay in the log until you clear them.',
    },
    {
      id: 'chat',
      title: 'Handing something back to Claude, at no cost',
      body:
        'Any edit, action, agent or task can be turned into a ready-to-paste prompt carrying its context \u2014 the file, the reasoning, the surrounding actions. It waits on the clipboard as a draft, and goes to the session\u2019s live agent through herdr only when you choose Send to agent. Assembling it reads files you already have, so it costs nothing until you send it.',
      view: 'actions',
      tip: 'Chat about this \u2014 assembles the context, spends no tokens.',
    },
    {
      id: 'inline',
      essential: true,
      title: 'Review without leaving the file',
      body:
        'Open a file Claude changed and the edits are in the margin: changed lines highlighted, removed lines shown as ghost text, a lens on each edit, and Keep or Undo under the cursor. Resolving one carries you to the next edit still awaiting review, crossing into another file when that is where it is, and the review bar can stay pinned in the editor while you work. Spotlight dims everything Claude did not touch, which on a large file is the difference between reading a diff and reading the file.',
      view: 'editor',
      tip: 'Keep or Undo at the cursor; resolving one moves you to the next.',
      anchor: 'spotlight',
      action: {
        mode: 'auto',
        kind: 'open-demo-file',
        hint: 'Opening a file Claude changed, at one of its edits.',
        done: 'Opened a file Claude changed — the edits are in the margin, with Keep and Undo on each.',
      },
    },
    {
      id: 'spotlight',
      title: 'Spotlight — dim everything Claude did not touch',
      body:
        'Reviewing inside the file has one more control worth knowing. On a long file, the changed lines are a small fraction of what is on screen. Spotlight dims the rest, which turns reading a file into reading a diff without leaving the file.',
      view: 'editor',
      tip: 'One toggle: everything Claude did not touch fades back.',
      anchor: 'spotlight',
      action: {
        mode: 'auto',
        kind: 'toggle-spotlight',
        hint: 'Turning Spotlight on, and back off when you move to the next step.',
        done: 'Spotlight on — everything Claude did not touch has faded back.',
      },
    },
    {
      id: 'revision-nav',
      title: 'Stepping through a file\u2019s revisions',
      body:
        'A file Claude changed more than once has a history within the session. Revision navigation diffs the file as it stands against the state each earlier edit produced, so you can see how it got here one step at a time.',
      view: 'fileHistory',
      tip: 'Diff the file against the state any earlier edit produced.',
    },
    {
      id: 'file-history',
      essential: true,
      title: 'File History — every revision of the open file',
      body:
        'This session changed src/features.py twice in two different places: once to add scaling, and once to add a timing helper. Both are listed here, both can be diffed against the file as it stands, and either can be undone while the other stands.',
      view: 'fileHistory',
      tip: 'features.py has two revisions from this session, reviewable independently.',
      action: {
        mode: 'wait',
        kind: 'undo-edit',
        hint: 'Undo any one edit — the others stay exactly as Claude left them.',
      },
    },
    {
      id: 'actions-audit',
      essential: true,
      title: 'Actions — every tool call, and what it reached',
      body:
        'The complete timeline of what the session did, by category, with the failed calls marked and counted in each one, and a risk flag on every command worth a second look. Below it, two audits: the writes that landed outside your workspace, and Egress, which names the hosts, servers and outside files the session reached. Both report what was exercised, not what was approved.',
      view: 'actions',
      tip: 'The timeline, plus the Risk and Egress audits over what the session reached.',
      tryIt: 'Find the failed sanity run, the rm -rf, and the report written outside the workspace.',
    },
    {
      id: 'observations',
      title: 'Observations — the reasoning behind the edits',
      body:
        'Claude\'s own words for why each change was made, lifted from the transcript rather than regenerated, alongside a recap of the session and the context it was working from. This costs nothing: it is a read of a file that already exists on your disk.',
      view: 'observations',
      tip: 'Reasoning lifted from the transcript — no tokens spent.',
    },
    {
      id: 'context-sources',
      title: 'What the session was working from',
      body:
        'Observations also names the context the session had: the skills, plans, memory files and compaction summaries it was reading. Each is marked by how it is known \u2014 seen in the transcript, or merely present on disk \u2014 so an inference is never dressed up as a fact.',
      view: 'observations',
      tip: 'Context sources, labelled by how they are known.',
    },
    {
      id: 'file-memory',
      title: 'What you decided about this file before',
      body:
        'The observatory remembers how you reviewed a file across sessions. A file whose edits you have reverted before is flagged when Claude touches it again, which is the cheapest warning available that something here keeps going wrong.',
      view: 'observations',
      tip: 'Cross-session history: what you accepted and reverted here before.',
    },
    {
      id: 'export',
      title: 'Handing the review to someone else',
      body:
        'A session\u2019s decisions export as markdown \u2014 what was accepted, what was reverted, per file. It is a git-free record of what the agent did and what you decided, which is the thing worth attaching to a review.',
      view: 'observations',
      tip: 'Export the decisions as markdown, ready to hand over.',
    },
    {
      id: 'model-effort',
      title: 'What the session actually ran on',
      body:
        'Stats names the model and reasoning effort behind the work, reads it from the turns themselves rather than a setting, and says so when a session switched models partway. Beside it, how many times the conversation was compacted and how much the last compaction dropped.',
      view: 'stats',
      anchor: 'stats-model',
      tip: 'Model, effort, and the compactions the session survived.',
    },
    {
      id: 'session-tokens',
      title: 'What it cost, split the way it bills',
      body:
        'Input, output and cached reads with the cache hit rate, kept current by reading only the bytes that have been appended since the last look. Below them, context and plan-usage bars with the time until each resets.',
      view: 'stats',
      anchor: 'stats-tokens',
      tip: 'Tokens split the way the API bills them, plus the usage bars.',
    },
    {
      id: 'doctor',
      title: 'When something looks wrong',
      body:
        'Setup Check reports what the observatory can and cannot see \u2014 the hooks, the CLI on PATH, herdr, the config directory, the session it resolved, the status line. Store maintenance sits beside it: reclaim disk, or drop a session entirely without touching a file on disk.',
      view: 'observations',
      tip: 'Setup Check names what is wired and what is not.',
    },
    {
      id: 'compaction',
      title: 'Compactions — where the context went',
      body:
        'Each compaction is a moment Claude Code summarised the conversation away and carried on from the summary. The context that produced the earlier edits is gone, which is why an edit from before one can carry thinner reasoning than you expect. The chip counts them and says how much the last one dropped; a session that was never compacted shows no chip rather than a zero.',
      view: 'stats',
      anchor: 'stats-compaction',
      tip: 'How many times the conversation was summarised away, and how much the last one dropped.',
    },
    {
      id: 'cache-hit',
      title: 'The cache hit rate, and what it is a ratio of',
      body:
        'Cache reads divided by ALL the context sent — reads plus writes plus fresh input — not reads divided by input. A long session should trend high; a low rate on a long one usually means something keeps invalidating the context rather than that the cache is failing. The tooltip separates reads from writes, and a large write figure is the cost of building the cache, not waste.',
      view: 'stats',
      anchor: 'stats-cache',
      tip: 'Reads \u00f7 all context sent — not reads \u00f7 input.',
    },
    {
      id: 'usage-bars',
      title: 'Context, and the limits you are working against',
      body:
        'The context bar is live from the transcript: tokens currently in context against the model\u2019s window. The five-hour and weekly bars are account-wide plan limits, read from your account\u2019s usage and from Claude\u2019s own status line, so they carry an age when the reading is stale and say so when there has never been one; the month bar follows your bill cycle. The used-of-total figures beside them are projections from the reported percentage, and the dollar figures are priced from token counts; each is marked with a tilde, because it is an estimate and never a bill.',
      view: 'stats',
      anchor: 'stats-usage',
      tip: 'ctx is live; 5h and wk come from your account\u2019s usage; mo follows your bill cycle.',
    },
    {
      id: 'review-scoreboard',
      title: 'The number that says whether you are really reviewing',
      body:
        'Pending, accepted and reverted for this session, live on every store change. The bar is how much of the session you have got through; the figure beside it is the accept rate — the one number that distinguishes reading Claude\u2019s work from rubber-stamping it. Clicking the pending count jumps to the oldest edit still waiting.',
      view: 'stats',
      anchor: 'stats-review',
      tip: 'Pending / accepted / reverted, and the accept rate.',
    },
    {
      id: 'finish',
      essential: true,
      title: 'Stats, and how to leave',
      body:
        'Tokens in and out with the cache hit rate, the model and effort the session ran at, and the saw-tooth of its context filling and being compacted. Exit Demo removes every trace the demo wrote: both sessions, their stores, the demo folder, and the report it left outside your workspace.',
      view: 'stats',
      tip: 'Exit Demo removes every trace — both sessions, the folder, and the outside report.',
      tryIt:
        'Or keep reviewing: the edits are real. One difference from your own code, and it is deliberate — once nothing is left pending, a demo session drops its own records rather than leaving a reviewed history behind.',
    },
  ];
}
