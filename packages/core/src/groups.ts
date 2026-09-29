/**
 * Review-unit collapsing — the PUBLIC surface, now a thin projection over `units.ts`.
 *
 * Successive edits to the SAME code should be reviewed as one unit, not as a pile of superseded
 * intermediate states: you cannot sensibly keep or revert an edit whose result a later edit already
 * overwrote. That has always been the intent; the engine that used to live here only achieved it for
 * edits that were ADJACENT in a file's chain, and that requirement is the bug. An agent that revises a
 * region, goes elsewhere, and comes back leaves the first edit owning no line on disk while still
 * demanding its own decision.
 *
 * `units.ts` replaces the engine. These names and shapes are unchanged so no caller moves — what
 * changed is which ids come back together, and that a unit's members are now a contiguous span, which
 * is what makes its `(first.beforeBlob, last.afterBlob)` pair an exact description of it.
 *
 * This lives in core so every surface (CLI, VS Code, JetBrains) collapses identically — the editors are
 * thin renderers over the tree/keep/undo this backs.
 */
import { EditRecord, readLog, uncertainCreation } from './store';
import { cancelledMemberIds, unitGroups, unitMembersIndex } from './units';
import { markLive, pairKeyOf } from './derived';

/** Pending review units: repId → ascending member ids (what the tree/list collapse to). */
export function pendingGroups(session: string): Map<number, number[]> {
  return unitGroups(session, 'pending');
}

/**
 * The edits a surface SHOWS: display units, minus every record inside a chain that cancels out.
 *
 * Nine call sites had written this pair of lines by hand, and the bug that produced this helper was
 * one of them forgetting the second: a badge, a scoreboard and a change map each counted a set the
 * list beside them refused to draw. One rule, one place to change it.
 *
 * All three statuses on purpose — these callers count kept and undone too. A surface that only ever
 * reads PENDING records (the gutter, the nav axes, the review walk) filters with
 * `cancelledMemberIds(session, 'pending')` instead and says so, because the other two walks cost real
 * time on a big session and answer a question it never asks.
 */
export function visibleEdits(session: string): EditRecord[] {
  const hidden = cancelledMemberIds(session);
  return reviewEdits(session).filter((r) => !hidden.has(r.id));
}

/**
 * Every grouped id → its unit's ascending members, across ALL THREE statuses in one map.
 *
 * One index rather than a per-id lookup, because the obvious version is quadratic in disguise: it read
 * the whole log to learn one record's status, then scanned that status's units linearly. Called once per
 * review unit — which is what [checkpointScope] does — a 7,922-record session spent 1.2 s answering a
 * question whose answer was that NOTHING was pending, blocking VS Code's extension host.
 *
 * Merging the statuses is safe, not a shortcut: units are derived per status, so member ids are strictly
 * partitioned and no id can appear under two of them.
 */
function membersIndex(session: string): Map<number, number[]> {
  return unitMembersIndex(session);
}

/** Ascending member ids of the same-status group containing `id` (or `[id]` if ungrouped/unknown). */
export function groupMembers(session: string, id: number): number[] {
  return membersIndex(session).get(id) ?? [id];
}

/**
 * The session's edits collapsed for REVIEW (in log order): each pending same-code group becomes ONE
 * synthetic record — the most-recent edit's id/tool/status/ts/afterBlob, but the earliest member's
 * beforeBlob, so its delta/diff/placement reflect the group's net before→after. Resolved (kept/undone)
 * edits pass through unchanged. Shared by the tree and the CLI `list` so both collapse identically.
 *
 * No `.observatoryignore` filtering happens here, or anywhere else on a read path. A matching file is
 * never CAPTURED, so there is nothing in the log to filter — which is what let the whole display
 * layer that used to sit here go away.
 */
export function reviewEdits(session: string): EditRecord[] {
  const log = readLog(session);
  const groups = pendingGroups(session);
  const repByMember = new Map<number, number>();
  for (const [rep, members] of groups) for (const m of members) repByMember.set(m, rep);
  const byId = new Map(log.map((r) => [r.id, r]));

  // A unit's members are a CONTIGUOUS span of its file's chain — see units.ts for why that is a
  // requirement rather than an accident: both editors render a diff by reading `rec.beforeBlob` and
  // `rec.afterBlob`, so `(first.before, last.after)` has to BE the unit's whole change. Contiguity is
  // what makes that pair exact, and it is why no line can end up inside two units' diffs.
  //
  // The unit is emitted at the REP's position, not the earliest member's. `locate` composes
  // one-edit-wide hops and documents that its input must be chronological in `after` order; a record
  // carrying the rep's `afterBlob` placed at an earlier position breaks that contract.
  const out: EditRecord[] = [];
  for (const rec of log) {
    if (rec.status !== 'pending') {
      out.push(rec);
      continue;
    }
    const rep = repByMember.get(rec.id) ?? rec.id;
    if (rec.id !== rep) continue; // a member emits nothing; its unit lands at the rep
    const members = groups.get(rep) ?? [rec.id];
    const repRec = byId.get(rep) as EditRecord;
    if (members.length < 2) {
      out.push(repRec);
      continue;
    }
    const first = byId.get(members[0]) as EditRecord;
    // A unit with ANY partial member has no true net pair — its first `beforeBlob` may be null
    // meaning "unknown", not "created" (see EditRecord.partial). The taint rides the synthetic
    // record so every consumer (diff, undo, badges) treats the whole unit as review-only.
    const tainted = members.some((m) => { const r = byId.get(m); return r && (r.partial || uncertainCreation(r)); });
    out.push({ ...repRec, beforeBlob: first.beforeBlob, beforeState: first.beforeState, ...(tainted ? { partial: true as const } : {}) });
  }
  // The synthetic pairs minted above exist only here — tell the derived stores so a flush keeps
  // what was computed for them instead of pruning it back to the log's pairs on every pass
  // (2026-09-16: the deltas of ~44 collapsed units re-diffed per listing, forever).
  markLive(session, out.map((r) => pairKeyOf(r.beforeBlob, r.afterBlob)));
  return out;
}
