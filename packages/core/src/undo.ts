/**
 * Surgical undo engine for Claude Observatory.
 *
 * For edit N we hold the full file content BEFORE (before_N) and AFTER (after_N). To undo only N
 * while keeping later edits to the same file, we do a POSITION-ANCHORED 3-way merge with after_N as
 * the common base: `ours` = the file's current on-disk content (after_N + later edits), `theirs` =
 * before_N (after_N with edit N reversed). Merging both onto the common base applies the undo AND
 * the later edits; if the two truly overlap, the merge reports a conflict and we offer a per-file
 * restore fallback. Anchoring to the base (rather than fuzzy patch application that searches for
 * matching text) is what makes this safe against duplicated content — a fuzzy reverse-patch could
 * silently revert the wrong duplicate block and pass a naive round-trip check.
 *
 * Pure filesystem + the `diff` package. No model calls, zero tokens.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EditRecord, EditStatus, OperationEntry, StoreBusyError, findRecord, isUnderPath, readBlob, readLog, readLogRaw, setStatusMany, statusesBeforeUndone } from './store';
import { withFileMutation } from './store';
import { uncertainCreation } from './integrity';
import { canonPath } from './paths';
import { groupMembers } from './groups';
import { unitDependents } from './units';
import { taskEditIds } from './changemap';
import { mergeGuard, threeWayMerge } from './merge';


export interface UndoResult {
  ok: boolean;
  status: 'undone' | 'redone' | 'deleted' | 'conflict' | 'noop' | 'error';
  message: string;
  /** On an undo conflict caused by LATER UNITS that rewrote this change's lines: their unit reps,
   *  ascending. Absent on ordinary conflicts (a manual/external change). Additive — never renamed. */
  dependents?: number[];
  /** With [dependents]: the whole closure as RAW member ids, newest first — exactly the set
   *  `undo --ids` takes to revert this change and its dependents in one call. */
  closure?: number[];
  /** The file WAS rewritten but these records' status could not be written (see recordAfterDisk). */
  unrecorded?: Unrecorded;
}

/** Raw blob bytes (exactly what capture stored) — the fidelity-preserving read. */
function blobBuf(sessionId: string, sha: string | null): Buffer | null {
  return sha === null ? null : readBlob(sessionId, sha);
}

/** UTF-8 decode — ONLY for the line-based 3-way merge, which is inherently a text operation. Every
 *  whole-file restore path writes raw bytes instead, so a non-UTF-8 file is never corrupted. */
function blobText(sessionId: string, sha: string | null): string | null {
  const b = blobBuf(sessionId, sha);
  return b === null ? null : b.toString('utf8');
}

/** True iff `buf` survives a UTF-8 decode→encode round-trip. The 3-way merge is a text operation;
 *  merging a file that does NOT round-trip (Latin-1, UTF-16, mixed encodings — capturable because
 *  isBinary only screens for NUL) would silently rewrite its bytes as U+FFFD. Those inputs must
 *  degrade to the conflict path instead: the explicit whole-file restore stays byte-exact. */
function utf8RoundTrips(buf: Buffer): boolean {
  try {
    return Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
  } catch {
    // .toString('utf8') throws past V8's MAX_STRING_LENGTH (~512 MB). A file that large can't be
    // line-merged anyway — treat it as "does not round-trip" so undo/redo returns conflict (the
    // byte-exact whole-file restore) instead of crashing the whole bulk operation.
    return false;
  }
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function writeEnsuringDir(file: string, content: Buffer | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// The line-merge primitives moved to `merge.ts` when `units.ts` needed `tokenizeLines` for its
// hop-shape diffs; importing this module from there would have closed a cycle. Same implementation,
// one copy — see that file's header.

/**
 * The file's baseline for a quick-diff: `current` with every still-PENDING edit reverted, computed
 * in-memory (the same position-anchored 3-way merge undoEdit uses, applied newest→oldest) so an editor
 * can show a git-style dirty-diff of exactly Claude's pending changes without touching disk. A manual
 * (non-Claude) edit stays in the baseline (it's `ours`, not reverted), so the diff shows only Claude's
 * work. Best-effort: an edit that won't cleanly revert is left in place rather than corrupting the text.
 */
export function fileBaseline(sessionId: string, file: string, current: string): string {
  const resolved = path.resolve(file);
  const pending = readLog(sessionId)
    .filter((r) => path.resolve(r.file) === resolved && r.status === 'pending')
    .sort((a, b) => b.id - a.id); // newest → oldest
  let text = current;
  for (const rec of pending) {
    const before = blobText(sessionId, rec.beforeBlob);
    const after = blobText(sessionId, rec.afterBlob);
    if (after === null) continue; // edit deleted the file, but it exists now — leave as-is
    if (before === null) {
      // new-file create: the baseline had no such content — drop what this edit added.
      text = text === after ? '' : threeWayMerge(after, text, '') ?? text;
      continue;
    }
    if (text === after) {
      text = before; // clean exact revert (no later edits since)
      continue;
    }
    text = threeWayMerge(after, text, before) ?? text; // later edits present — surgical revert
  }
  return text;
}

/**
 * Undo a single edit, preserving unrelated later edits where possible.
 * On overlap, returns { status: 'conflict' } without touching the file — caller can then call
 * restoreFile() (the `--force` / per-file fallback).
 */
export function undoEdit(sessionId: string, id: number): UndoResult {
  const rec = findRecord(sessionId, id);
  if (!rec) return { ok: false, status: 'error', message: `no edit #${id} in this session` };
  return undoRecord(sessionId, rec, [id]);
}

/**
 * Undo one CHANGE: a record, or a whole review unit summed into its net blob pair. `rec` may be
 * synthetic — a unit's rep carrying the span's FIRST beforeBlob, exactly the record `reviewEdits`
 * renders — and `memberIds` are the records whose ledger status the outcome covers, flipped in ONE
 * append. The decision tree is the single-edit one, branch for branch; on conflict the DISK IS
 * UNTOUCHED and no status is written. `defer` skips the status write so a scoped caller can flush
 * one batch at the end instead of invalidating the readLog memo once per record.
 */
function undoRecord(sessionId: string, rec: EditRecord, memberIds: number[], defer = false): UndoResult {
  try { return withFileMutation(rec.file, () => undoRecordUnlocked(sessionId, rec, memberIds, defer)); }
  catch (e) { return failedResult(sessionId, e, `reverted ${rec.file}`); }
}

function undoRecordUnlocked(sessionId: string, rec: EditRecord, memberIds: number[], defer = false): UndoResult {
  const id = rec.id;
  if (rec.status === 'undone') {
    return { ok: true, status: 'noop', message: `edit #${id} is already undone` };
  }
  // Before ANY blob math: a partial record's before-state is UNKNOWN, not known-absent (see
  // EditRecord.partial). Every branch below assumes the blob pair tells the truth about disk
  // history — running one on a record that only carries the new text would either delete a file
  // that predates the edit or "restore" content we never had. Review-only, said out loud.
  if (rec.partial || uncertainCreation(rec)) {
    const twin = standingPhantomTwin(sessionId, rec);
    if (twin) return phantomRefusal(id, twin.id);
    const u = uncertainMember(sessionId, rec, memberIds);
    return {
      ok: false,
      status: 'error',
      message:
        `edit #${u.id} has an uncertain before-state (${u.uncertainty ?? 'missing capture evidence'}) — ` +
        `there is nothing to restore from. It is review-only: keep works, undo cannot.`,
    };
  }
  const markUndone = (): void => {
    if (!defer) recordAfterDisk(sessionId, [{ verb: 'undo', ids: memberIds }]);
  };

  const beforeBuf = blobBuf(sessionId, rec.beforeBlob);
  let currentBuf: Buffer | null;
  try {
    currentBuf = fs.readFileSync(rec.file);
  } catch {
    currentBuf = null;
  }
  const currentSha = currentBuf ? sha256(currentBuf) : null;

  const conflict = (): UndoResult => {
    // What the offered `oak undo <id> --force` does (restoreFile): the file goes back to the state
    // before the first edit of <id>'s unit, and every later edit of it goes, beyond the ones asked for.
    const from = groupMembers(sessionId, id)[0];
    const loss = forceLoss(sessionId, rec.file, from, memberIds);
    // A dependent unit by definition rewrote lines this change produced, so the merge already
    // refused on its own — the dependency edge's job is to turn that anonymous refusal into a named
    // one with a one-call closure. A conflict with NO dependent unit keeps the original wording: it
    // means a manual or external change, and `--ids` would not help there.
    const dependents = unitDependents(sessionId, id).filter(
      (d) => findRecord(sessionId, d)?.status !== 'undone'
    );
    if (dependents.length) {
      const many = dependents.length > 1;
      const members = [...new Set([...dependents, id].flatMap((d) => groupMembers(sessionId, d)))];
      // The one-call closure exists only when `undo --ids` can actually perform it — that verb
      // reverts PENDING records alone. A kept unit anywhere in the set (this one, or a dependent)
      // would make the suggestion a no-op that re-prints itself; name the edge, offer --force.
      const allPending = members.every((m) => findRecord(sessionId, m)?.status === 'pending');
      if (allPending) {
        const closure = members.sort((a, b) => b - a); // newest first — the order undoScope reverts in
        return {
          ok: false,
          status: 'conflict',
          dependents,
          closure,
          message:
            `edit #${id} overlaps later work: unit${many ? 's' : ''} #${dependents.join(', #')} ` +
            `depend${many ? '' : 's'} on it. Undo ${many ? 'them together' : 'both'} with ` +
            `\`oak undo --ids ${closure.join(',')}\`, or \`oak undo ${id} --force\` to restore the whole file, ` +
            `which ${loss}.`,
        };
      }
      return {
        ok: false,
        status: 'conflict',
        dependents,
        message:
          `edit #${id} overlaps later work: unit${many ? 's' : ''} #${dependents.join(', #')} ` +
          `depend${many ? '' : 's'} on it, and part of that chain is already accepted — ` +
          `review ${many ? 'those units' : 'that unit'} first, or \`oak undo ${id} --force\` to restore the whole file, ` +
          `which ${loss}.`,
      };
    }
    return {
      ok: false,
      status: 'conflict',
      message:
        `edit #${id} overlaps a later change to ${path.basename(rec.file)}. ` +
        `Run \`oak undo ${id} --force\` to restore the file to its pre-edit-#${from} state, ` +
        `which ${loss}.`,
    };
  };

  // New-file create -> undo deletes the file, but ONLY if no later edit changed it since (compare by
  // sha of the raw bytes, never a UTF-8 round-trip).
  if (rec.beforeBlob === null) {
    // A unit whose FIRST member created the file and whose rep DELETED it nets to both blobs null:
    // "no file existed, none should exist". There is nothing of ours to remove — a file at that path
    // now is someone else's, its content captured in NO blob, so unlinking it would be unrecoverable
    // data loss (the old vacuous `rec.afterBlob !== null &&` guard did exactly that). Refuse when a
    // file exists; absent, the undo is a pure ledger flip.
    if (rec.afterBlob === null) {
      if (currentBuf !== null) return conflict();
      if (!defer) setStatusMany(sessionId, memberIds, 'undone'); // no file changes here: a refusal is the whole truth
      return { ok: true, status: 'undone', message: `edit #${id} created and removed ${rec.file} — nothing to restore` };
    }
    // #43 phantom guard: this "creation" is one half of a capture artifact, not Claude's work, and the
    // content check below cannot save the file (the phantom's snapshot IS the untouched file, so it
    // always matches). Refuse and name the repair. Gated on the file still EXISTING: that is what
    // makes this undo destructive — a legitimate create-then-delete pair (Claude made a temp file and
    // removed it) has the same record shape but no file on disk, and its undo stays a harmless no-op.
    const twin = currentBuf === null ? undefined : phantomTwinOf(sessionId, rec);
    if (twin) return phantomRefusal(id, twin.id);
    if (currentSha !== null && currentSha !== rec.afterBlob) return conflict();
    try {
      if (currentBuf !== null) fs.unlinkSync(rec.file);
    } catch (e) {
      return { ok: false, status: 'error', message: `could not delete ${rec.file}: ${String(e)}` };
    }
    markUndone();
    return { ok: true, status: 'deleted', message: `deleted ${rec.file} (created by edit #${id})` };
  }

  // Edit deleted the file -> undo restores it (raw bytes), unless a later edit re-created it.
  if (rec.afterBlob === null) {
    if (currentBuf !== null) return conflict();
    writeEnsuringDir(rec.file, beforeBuf as Buffer);
    markUndone();
    return { ok: true, status: 'undone', message: `restored ${rec.file}` };
  }

  // Normal in-place edit; file missing now -> restore wholesale (raw bytes).
  if (currentBuf === null) {
    writeEnsuringDir(rec.file, beforeBuf as Buffer);
    markUndone();
    return {
      ok: true,
      status: 'undone',
      message: `${rec.file} was missing; restored to its pre-edit-#${id} state`,
    };
  }

  // No later edits touched this file -> clean, exact byte-for-byte revert.
  if (currentSha === rec.afterBlob) {
    fs.writeFileSync(rec.file, beforeBuf as Buffer);
    markUndone();
    return { ok: true, status: 'undone', message: `undid edit #${id} (${rec.file})` };
  }

  // Later edits exist -> position-anchored 3-way merge (base = after_N, ours = current, theirs = before).
  // Text-domain by necessity; the clean paths above already preserved bytes exactly.
  const afterBuf = blobBuf(sessionId, rec.afterBlob) as Buffer;
  if (!utf8RoundTrips(currentBuf) || !utf8RoundTrips(beforeBuf as Buffer) || !utf8RoundTrips(afterBuf)) {
    return conflict(); // non-UTF-8 content: a text merge would corrupt it — refuse, offer --force
  }
  const current = currentBuf.toString('utf8');
  const merged = threeWayMerge(afterBuf.toString('utf8'), current, (beforeBuf as Buffer).toString('utf8'));
  if (merged === null) return conflict(); // edit #id and a later edit genuinely overlap
  // The file as it is: nothing of the change is left to take out, a later change already undid it.
  // Reported as an undo, it let the redo after it re-apply the change over that later one.
  if (merged === current && !afterBuf.equals(beforeBuf as Buffer)) return conflict();
  fs.writeFileSync(rec.file, merged);
  markUndone();
  return {
    ok: true,
    status: 'undone',
    message: `surgically undid edit #${id}, preserving later edits (${rec.file})`,
  };
}

/**
 * A wholesale per-file restore/reapply of edit `id` overwrites the file and DROPS every later edit to
 * that same file from disk. Those later edits are marked `undone` so their recorded status matches disk —
 * otherwise the tree shows a pending/kept edit whose change is gone, and a later per-edit undo/redo
 * computes against a file that no longer matches its blobs (a spurious conflict).
 */
function laterSameFile(sessionId: string, file: string, afterId: number): number[] {
  return readLog(sessionId)
    .filter((r) => r.file === file && r.id > afterId && r.status !== 'undone')
    .map((r) => r.id);
}

/**
 * The PROVABLE #43 phantom delete-twin of a pending create record, or undefined. Provable STRICTLY,
 * matching repairCasePhantoms: same canonical file, the twin's before-blob equals the create's
 * after-blob, both still pending — and the two RAW paths disagree (drive-letter case). A genuine
 * create→delete→re-create chain carries one consistent raw path and must keep its ordinary undo
 * semantics; without the raw-case discriminator the guard misdiagnosed exactly that chain and pointed
 * at a repair (`clean --phantoms`) that then correctly found nothing.
 */
function phantomTwinOf(sessionId: string, rec: EditRecord): EditRecord | undefined {
  const rawById = new Map(readLogRaw(sessionId).map((r) => [r.id, r.file]));
  const rawRec = rawById.get(rec.id);
  if (rawRec === undefined) return undefined;
  return readLog(sessionId).find(
    (t) =>
      t.id !== rec.id &&
      t.status === 'pending' &&
      t.afterBlob === null &&
      t.beforeBlob === rec.afterBlob &&
      t.file === rec.file &&
      rawById.get(t.id) !== undefined &&
      rawById.get(t.id) !== rawRec
  );
}

/** A #43 phantom create is a legacy Bash creation, which the uncertain-creation refusal claims too, and
 *  that refusal names no repair. Where both hold the phantom answer comes first, because it is the one
 *  place `clean --phantoms` is named (the Windows runner's bulk revert said only "uncertain"). */
function standingPhantomTwin(sessionId: string, rec: EditRecord): EditRecord | undefined {
  return rec.beforeBlob === null && fs.existsSync(rec.file) ? phantomTwinOf(sessionId, rec) : undefined;
}

/** The one refusal both undo paths present — the remediation pointer must read identically. */
function phantomRefusal(id: number, twinId: number): UndoResult {
  return {
    ok: false,
    status: 'error',
    message:
      `edit #${id} looks like a Windows path-case phantom (its delete-twin is edit #${twinId}) — ` +
      `undoing it would delete a file Claude never touched. Run \`oak clean --phantoms\` to remove both records.`,
  };
}

/**
 * Per-file restore fallback (the `--force` path). Reverts the file to its state BEFORE the review unit
 * that edit `id` belongs to, dropping any later edits to that same file. Used when undoEdit() reports a
 * conflict.
 */
export function restoreFile(sessionId: string, id: number): UndoResult {
  const rec = findRecord(sessionId, id);
  if (!rec) return { ok: false, status: 'error', message: `no edit #${id}` };
  try { return withFileMutation(rec.file, () => restoreFileUnlocked(sessionId, id)); }
  catch (e) { return failedResult(sessionId, e, `restored ${rec.file}`); }
}

function restoreFileUnlocked(sessionId: string, id: number): UndoResult {
  // The whole unit, the way `undo <id>` reverts it and `redo <id> --force` puts it back: the file as it
  // was before the unit's first member, every member reverted. Restoring the named edit's own
  // before-state left a unit's earlier members on disk and still pending.
  const ids = [...groupMembers(sessionId, id)].sort((a, b) => a - b);
  const rec = ids.length > 1 ? unitRecord(sessionId, ids) : findRecord(sessionId, id);
  if (!rec) return { ok: false, status: 'error', message: `no edit #${id} in this session` };
  // The partial refusal holds on the FORCE path too — this branch is exactly where a partial's
  // `beforeBlob: null` would read as "created" and unlink a file whose pre-edit content was never
  // captured, making the loss unrecoverable. The refusal wording matches undoRecord's.
  if (rec.partial || uncertainCreation(rec)) {
    // The named edit's own twin: a phantom pair is one unit, whose summed record nets to no file at all.
    const twin = standingPhantomTwin(sessionId, findRecord(sessionId, id) ?? rec);
    if (twin) return phantomRefusal(id, twin.id);
    const u = uncertainMember(sessionId, rec, ids);
    return {
      ok: false,
      status: 'error',
      message:
        `edit #${u.id} has an uncertain before-state (${u.uncertainty ?? 'missing capture evidence'}) — ` +
        `there is nothing to restore from, --force included. It is review-only: keep works, undo cannot.`,
    };
  }

  const beforeBuf = blobBuf(sessionId, rec.beforeBlob);
  if (beforeBuf === null) {
    // #43: the phantom guard holds on the FORCE path too — `undo <id> --force` on a phantom create
    // must not delete the untouched file either (the bulk flow's conflict hint names --force, so this
    // is exactly where a #43 victim lands next).
    if (rec.beforeBlob === null && fs.existsSync(rec.file)) {
      const twin = phantomTwinOf(sessionId, rec);
      if (twin) return phantomRefusal(id, twin.id);
    }
    const later = laterSameFile(sessionId, rec.file, rec.id);
    try {
      if (fs.existsSync(rec.file)) fs.unlinkSync(rec.file);
    } catch (e) {
      return { ok: false, status: 'error', message: `could not delete ${rec.file}: ${String(e)}` };
    }
    recordAfterDisk(sessionId, [{ verb: 'undo', ids }, { verb: 'undo', ids: later }]);
    return { ok: true, status: 'deleted', message: `deleted ${rec.file} (created by edit #${ids[0]})` };
  }
  const later = laterSameFile(sessionId, rec.file, rec.id);
  writeEnsuringDir(rec.file, beforeBuf);
  recordAfterDisk(sessionId, [{ verb: 'undo', ids }, { verb: 'undo', ids: later }]);
  return {
    ok: true,
    status: 'undone',
    message: `restored ${rec.file} to its pre-edit-#${ids[0]} state (later edits to this file dropped)`,
  };
}

/**
 * Re-apply a previously undone edit (the mirror of undoEdit in the forward direction): merge edit
 * #id (before -> after) back onto the current file, keeping unrelated later edits. Common base is
 * before_N. On overlap, returns { status: 'conflict' } and leaves the file untouched.
 */
export function redoEdit(sessionId: string, id: number): UndoResult {
  const rec = findRecord(sessionId, id);
  if (!rec) return { ok: false, status: 'error', message: `no edit #${id} in this session` };
  return redoRecord(sessionId, rec, [id]);
}

/** Flip each redone record back to ITS OWN pre-revert status (kept stays kept, a rejected pending
 *  edit returns to pending) — grouped per status so a bulk redo appends O(statuses), not O(ids).
 *  The one status writer every redo path shares, so no front end can disagree about what a redo
 *  restores. */
function restoreStatuses(sessionId: string, memberIds: number[], budgetMs?: number): void {
  const prior = statusesBeforeUndone(sessionId, memberIds);
  const byStatus = new Map<EditStatus, number[]>();
  for (const m of memberIds) {
    const s = prior.get(m) ?? 'pending';
    const group = byStatus.get(s);
    if (group) group.push(m);
    else byStatus.set(s, [m]);
  }
  for (const [s, group] of byStatus) setStatusMany(sessionId, group, s, budgetMs);
}

/**
 * How long a status write waits for the session lock once the file is ALREADY rewritten. The disk
 * cannot be un-written, so it waits longer than an ordinary append (2–5 s) before it gives up. Under
 * 16 concurrent agents capturing on a 3,936-file tree, a status write waited 1.2 s at most
 * (measured 2026-09-26), so 10 s is waited out only by a store that is stuck.
 */
const RECORD_BUDGET_MS = 10_000;

/** Records whose files were rewritten but whose status could not be written — reported, never
 *  dropped: `commands` record exactly these ids without touching a file. */
export interface Unrecorded {
  ids: number[];
  commands: string[];
  message: string;
}

/** One status write a completed disk change implies: `undo` marks the ids reverted, `redo` gives them
 *  back the status they had before they were reverted. */
type StatusPart = { verb: 'undo' | 'redo'; ids: number[] };

class UnrecordedError extends Error {
  constructor(readonly parts: StatusPart[], readonly reason: string) {
    super(reason);
  }
  /** `done` says what already happened on disk, e.g. "reverted src/a.ts". */
  report(sessionId: string, done: string): Unrecorded {
    // One command per verb: a force restore's own id and the later edits it dropped are both `undo`.
    const parts: StatusPart[] = [];
    for (const p of this.parts) {
      const same = parts.find((q) => q.verb === p.verb);
      if (same) same.ids.push(...p.ids);
      else parts.push({ verb: p.verb, ids: [...p.ids] });
    }
    const ids = parts.flatMap((p) => p.ids);
    // Run through `--machine`, this store belongs to another machine than the person reading the
    // report: the repair has to name it, or it runs where the session is not ("no edit #N").
    const label = process.env.OAK_FORWARDED === '1' ? process.env.OAK_FORWARDED_MACHINE : undefined;
    const at = label ? ` --machine ${/^[\w.@:+-]+$/.test(label) ? label : `'${label.replace(/'/g, `'\\''`)}'`}` : '';
    const commands = parts.map((p) => `oak ${p.verb} --ids ${p.ids.join(',')} --record-only --session ${sessionId}${at}`);
    const states = parts.map((p) => {
      const many = p.ids.length > 1;
      return `edit${many ? 's' : ''} #${p.ids.join(', #')} ${p.verb === 'undo' ? `${many ? 'are' : 'is'} not recorded as reverted` : `${many ? 'are' : 'is'} still recorded as reverted`}`;
    });
    const message =
      `${done} on disk, but ${this.reason}, so ${states.join(' and ')}. ` +
      `Record ${ids.length > 1 ? 'them' : 'it'} with \`${commands.join('` and `')}\` (this changes no file).`;
    return { ids, commands, message };
  }
}

/** Write the statuses a completed disk change implies, each waiting RECORD_BUDGET_MS. Whatever could
 *  not be written, the failed part and every part after it, is thrown as an UnrecordedError. */
function recordAfterDisk(sessionId: string, parts: StatusPart[]): void {
  const todo = parts.filter((p) => p.ids.length);
  for (let i = 0; i < todo.length; i++) {
    const p = todo[i];
    try {
      if (p.verb === 'undo') setStatusMany(sessionId, p.ids, 'undone', RECORD_BUDGET_MS);
      else restoreStatuses(sessionId, p.ids, RECORD_BUDGET_MS);
    } catch (e) {
      const reason = e instanceof StoreBusyError
        ? `the store stayed busy for ${RECORD_BUDGET_MS / 1000} s`
        : `the store could not be written (${String((e as Error).message)})`;
      throw new UnrecordedError(todo.slice(i), reason);
    }
  }
}

/** The failed-status result for a single-file undo/redo/restore/reapply, or the plain error. */
function failedResult(sessionId: string, e: unknown, done: string): UndoResult {
  if (e instanceof UnrecordedError) {
    const unrecorded = e.report(sessionId, done);
    return { ok: false, status: 'error', message: unrecorded.message, unrecorded };
  }
  return { ok: false, status: 'error', message: String((e as Error).message) };
}

/**
 * Record, WITHOUT touching any file, what an undo (`verb: 'undo'`) or redo already did on disk to these
 * exact records: the repair an Unrecorded report names. Records already in that state are left alone.
 * Returns the ids whose status changed.
 */
export function recordOnly(sessionId: string, ids: number[], verb: 'undo' | 'redo'): number[] {
  const want = new Set(ids);
  const recs = readLog(sessionId).filter((r) => want.has(r.id));
  if (verb === 'undo') return setStatusMany(sessionId, recs.filter((r) => r.status !== 'undone').map((r) => r.id), 'undone', RECORD_BUDGET_MS);
  const undone = recs.filter((r) => r.status === 'undone').map((r) => r.id);
  restoreStatuses(sessionId, undone, RECORD_BUDGET_MS);
  return undone;
}

/** The forward mirror of [undoRecord]: re-apply one change (a record, or a unit's net pair), its
 *  members returning to 'pending' in ONE append. Same synthetic-rec contract, same conflict contract
 *  (disk untouched, no status write), same `defer` contract for scoped callers. */
function redoRecord(sessionId: string, rec: EditRecord, memberIds: number[], defer = false): UndoResult {
  try { return withFileMutation(rec.file, () => redoRecordUnlocked(sessionId, rec, memberIds, defer)); }
  catch (e) { return failedResult(sessionId, e, `re-applied ${rec.file}`); }
}

function redoRecordUnlocked(sessionId: string, rec: EditRecord, memberIds: number[], defer = false): UndoResult {
  // A partial can only reach 'undone' sideways (a force restore drops same-file records
  // wholesale) — never through undoRecord, which refuses it. Re-applying from here would write
  // claimed content over an unknown disk history, so the refusal is symmetric.
  if (rec.partial || uncertainCreation(rec)) {
    return {
      ok: false,
      status: 'error',
      message: `edit #${uncertainMember(sessionId, rec, memberIds).id} is review-only (its before-content never arrived) — redo cannot re-apply it.`,
    };
  }
  const id = rec.id;
  if (rec.status !== 'undone') {
    return { ok: true, status: 'noop', message: `edit #${id} is not undone — nothing to redo` };
  }
  const markPending = (): void => {
    if (defer) return;
    // Redo RESTORES the decision the revert took away: a kept-then-reverted
    // edit returns to KEPT, a rejected pending edit returns to pending. "Redo" undoes the undo —
    // it must not reopen a decision that was already made, which is how a redone whole-file WRITE
    // unit read as "it redid the entire file and wants review again".
    recordAfterDisk(sessionId, [{ verb: 'redo', ids: memberIds }]);
  };

  const afterBuf = blobBuf(sessionId, rec.afterBlob);
  const beforeBuf = blobBuf(sessionId, rec.beforeBlob);
  let currentBuf: Buffer | null;
  try {
    currentBuf = fs.readFileSync(rec.file);
  } catch {
    currentBuf = null;
  }
  const currentSha = currentBuf ? sha256(currentBuf) : null;

  const conflict = (): UndoResult => ({
    ok: false,
    status: 'conflict',
    message:
      `re-applying edit #${id} overlaps a later change to ${path.basename(rec.file)}. ` +
      `Run \`oak redo ${id} --force\` to write the file as edit #${id} left it, which ${forceLoss(sessionId, rec.file, id)}.`,
  });

  // Redo a creation -> re-create the file with `after` (raw bytes).
  if (rec.beforeBlob === null) {
    // The both-null net (a create→…→delete unit): re-applying it means the file STAYS absent. A file
    // there now is someone else's — fabricating an empty file over it (the old `?? Buffer.alloc(0)`)
    // was never a state any captured snapshot held.
    if (rec.afterBlob === null) {
      if (currentBuf !== null) return conflict();
      if (!defer) restoreStatuses(sessionId, memberIds); // no file changes here: a refusal is the whole truth
      return { ok: true, status: 'redone', message: `re-applied edit #${id} — ${rec.file} stays removed` };
    }
    if (currentSha !== null && currentSha !== rec.afterBlob) return conflict();
    writeEnsuringDir(rec.file, afterBuf ?? Buffer.alloc(0));
    markPending();
    return { ok: true, status: 'redone', message: `re-applied edit #${id} — created ${rec.file}` };
  }

  // Redo a deletion -> delete the file again (only if it still matches its pre-deletion content).
  if (rec.afterBlob === null) {
    if (currentSha !== null && currentSha !== rec.beforeBlob) return conflict();
    try {
      if (currentBuf !== null) fs.unlinkSync(rec.file);
    } catch (e) {
      return { ok: false, status: 'error', message: `could not delete ${rec.file}: ${String(e)}` };
    }
    markPending();
    return { ok: true, status: 'deleted', message: `re-applied edit #${id} — deleted ${rec.file}` };
  }

  // Normal edit: file missing now -> write after wholesale (raw bytes).
  if (currentBuf === null) {
    writeEnsuringDir(rec.file, afterBuf as Buffer);
    markPending();
    return { ok: true, status: 'redone', message: `re-applied edit #${id} (${rec.file})` };
  }
  // No later edits -> clean forward apply (raw bytes).
  if (currentSha === rec.beforeBlob) {
    fs.writeFileSync(rec.file, afterBuf as Buffer);
    markPending();
    return { ok: true, status: 'redone', message: `re-applied edit #${id} (${rec.file})` };
  }
  // Later edits exist -> 3-way merge with before_N as the common base (text-domain by necessity).
  if (
    !utf8RoundTrips(currentBuf) ||
    !utf8RoundTrips(beforeBuf as Buffer) ||
    !utf8RoundTrips(afterBuf as Buffer)
  ) {
    return conflict(); // non-UTF-8 content: a text merge would corrupt it — refuse, offer --force
  }
  const before = (beforeBuf as Buffer).toString('utf8');
  const after = (afterBuf as Buffer).toString('utf8');
  const current = currentBuf.toString('utf8');
  const merged = redoMerge(laterStates(sessionId, rec, memberIds, before, after), current, before, after);
  // A redo that leaves the file as it is has put nothing back, and must not say it did.
  if (merged === null || (merged === current && before !== after)) return conflict();
  fs.writeFileSync(rec.file, merged);
  markPending();
  return {
    ok: true,
    status: 'redone',
    message: `re-applied edit #${id}, preserving later edits (${rec.file})`,
  };
}

/**
 * How many of the file's recorded states after the change a redo merges from, newest first, counting
 * only states that still hold the change. Merging from every one made a redo that really conflicts
 * quadratic in the file's later edits (23.9 s for 400 of them on a 20,000-line file, all under the file
 * lock, on VS Code's extension host). In 6,000 fuzzed sequences, every redo placed from a later state
 * used one of the first three that held the change. Every later record is read until three pass
 * mergeGuard, which turns away a state recorded after the undo for the price of a read and a text
 * search: capping the records read instead made the redo conflict again once ten edits had been
 * recorded since the undo.
 */
const REDO_STATES = 3;

/**
 * How long a redo keeps trying later states once the plain merge has refused. Each try is a whole-file
 * merge against the file as it is now, which costs as much as the edits between them: with a thousand
 * edits recorded since the undo, three tries added seconds to a redo that conflicts anyway, under the
 * file lock on VS Code's extension host. A placement that works takes tens of
 * milliseconds, so the newest state is always tried and an older one only while this lasts.
 */
const REDO_FALLBACK_MS = 250;

/** The file's recorded states after the change that still hold it, newest first, read as they are
 *  asked for: `state(k)` is the k-th, or undefined past the last (see REDO_STATES). */
function laterStates(sessionId: string, rec: EditRecord, memberIds: number[], before: string, after: string): (k: number) => string | undefined {
  const last = Math.max(rec.id, ...memberIds);
  const recs = readLog(sessionId)
    .filter((r) => r.file === rec.file && r.id > last && r.afterBlob !== null)
    .sort((a, b) => b.id - a.id);
  const states: string[] = [];
  let read = 0;
  let holds: ((state: string) => boolean) | undefined;
  return (k) => {
    while (states.length <= k && states.length < REDO_STATES && read < recs.length) {
      const buf = blobBuf(sessionId, recs[read++].afterBlob);
      if (buf === null || !utf8RoundTrips(buf)) continue;
      const text = buf.toString('utf8');
      // A state recorded after the undo no longer holds the change: nothing to place it from.
      if ((holds ??= mergeGuard(after, before))(text)) states.push(text);
    }
    return states[k];
  };
}

/** Lines in a text, its last line counted whether or not it ends with a newline. */
function lineCount(s: string): number {
  let n = s !== '' && !s.endsWith('\n') ? 1 : 0;
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

/**
 * Where a redo puts a change back, given the file's later recorded states that hold it (laterStates).
 *
 * First, an undo followed at once by a redo puts the file back exactly as it was. The plain merge could
 * not promise that: a change inserted where a later edit also inserted, beside a line another later edit
 * replaced, came back on the far side of those lines. If undoing the change from the newest state gives
 * exactly the file now, that state is the file as it was.
 *
 * Otherwise the change is merged onto the file as it is now. Where that merge cannot place it, the later
 * states still hold its lines among theirs. Undoing a change that later edits of the same file surround
 * can leave nothing beside its lines to anchor them: in the demo, `scale()` (the unit #1+#3) and the
 * later `profile()` (#8) were both appended to the end of features.py, so once the unit was undone the
 * redo merge saw two insertions at one point and refused, and the only repair it offered, `--force`,
 * dropped #8. From each state (newest first) the change is undone exactly as `undo` undoes it; what that
 * removes is this change in its later context, merged onto the file as it is now. A state whose undo is
 * not clean is skipped; if none applies, or the time for older states is spent (REDO_FALLBACK_MS), the
 * conflict stands.
 */
function redoMerge(state: (k: number) => string | undefined, current: string, before: string, after: string): string | null {
  const undone: (string | null)[] = [];
  const without = (k: number): string | null => {
    if (!(k in undone)) {
      // `undo`'s merge from `after` diffs everything written since the change, which is what a big file
      // with many later edits pays for. An older state is one hop from the newer one, so the newer
      // state's result is rebased onto it instead: two short diffs. The long way is taken only at the
      // newest state, or where a hop touched the change.
      const newer = k > 0 ? without(k - 1) : null;
      const rebased = newer !== null && newer !== state(k - 1) ? threeWayMerge(state(k - 1) as string, newer, state(k) as string) : null;
      undone[k] = rebased ?? threeWayMerge(after, state(k) as string, before);
    }
    return undone[k];
  };
  // A clean undo from a state has exactly this many lines, so a file with another count is not one. And
  // a state the undo leaves as it was never held the change.
  const newest = state(0);
  if (newest !== undefined && current !== newest && lineCount(current) === lineCount(newest) + lineCount(before) - lineCount(after) && without(0) === current) {
    return newest;
  }
  const merged = threeWayMerge(before, current, after);
  if (merged !== null) return merged;
  const until = Date.now() + REDO_FALLBACK_MS;
  for (let k = 0; (k === 0 || Date.now() < until) && state(k) !== undefined; k++) {
    const withoutChange = without(k);
    if (withoutChange === null || withoutChange === state(k)) continue;
    const placed = threeWayMerge(withoutChange, current, state(k) as string);
    if (placed !== null) return placed;
  }
  return null;
}

/**
 * What `--force` discards, said exactly. A forced restore or re-apply rewrites the whole file from its
 * state at edit `from`, so every later edit of it still on disk goes, bar `asked` (the edits the refused
 * undo or redo was reverting or re-applying anyway), and so does any change OAK did not record.
 */
function forceLoss(sessionId: string, file: string, from: number, asked: number[] = []): string {
  const later = laterSameFile(sessionId, file, from).filter((r) => !asked.includes(r));
  return later.length
    ? `drops later edit${later.length > 1 ? 's' : ''} #${later.join(', #')} and anything else changed in the file since`
    : 'discards whatever changed in the file since';
}

// --- group-aware review actions: keep/undo/redo operate on the whole same-code review unit (the
// collapsed group), so a superseded intermediate edit is never kept/reverted on its own ---

/**
 * A unit's net change as one record: its rep (the newest member) carrying the span's first
 * `beforeBlob`, exactly the record `reviewEdits` renders. `ids` ascending. A unit with any partial
 * member has no true net pair, and undoRecord/redoRecord's own refusal is the one place that says so.
 */
function unitRecord(sessionId: string, ids: number[]): EditRecord | null {
  const first = findRecord(sessionId, ids[0]);
  const rep = findRecord(sessionId, ids[ids.length - 1]);
  if (!first || !rep) return null;
  const anyPartial = ids.some((i) => { const r = findRecord(sessionId, i); return r && (r.partial || uncertainCreation(r)); });
  return { ...rep, beforeBlob: first.beforeBlob, beforeState: first.beforeState, ...(anyPartial ? { partial: true as const } : {}) };
}

/** The edit a before-state refusal names: `rec`, or for a unit the first member whose before-state is
 *  uncertain, with its own reason. The unit's record is its newest member's, whichever member it was. */
function uncertainMember(sessionId: string, rec: EditRecord, memberIds: number[]): EditRecord {
  const members = [...memberIds].sort((a, b) => a - b).map((m) => findRecord(sessionId, m));
  return members.find((r): r is EditRecord => r !== null && (r.partial === true || uncertainCreation(r))) ?? rec;
}

export interface GroupResult extends UndoResult {
  ids: number[]; // the member edit ids acted on
}

/**
 * Keep every PENDING edit in the review group containing `id`.
 *
 * Only pending ones, exactly as [keepTask] does and for the same reason: keeping an already-undone edit
 * asserts a change that is not on disk. `keep 1` on a reverted edit used to report `{"kept":1}` and flip
 * the ledger to 'kept' while the file still held the reverted content — and since that also marks the
 * edit RESOLVED, `clearResolved` would then drop it and the revert could never be redone.
 */
export function keepGroup(sessionId: string, id: number): { kept: number; ids: number[] } {
  const members = new Set(groupMembers(sessionId, id));
  const ids = readLog(sessionId)
    .filter((r) => members.has(r.id) && r.status === 'pending')
    .map((r) => r.id);
  setStatusMany(sessionId, ids, 'kept'); // one parse + one append, whatever the group's size
  return { kept: ids.length, ids };
}

/**
 * Undo the whole review unit containing `id` as ONE merge. A unit's members are contiguous, so its
 * net change IS the blob pair `(first.beforeBlob, rep.afterBlob)` — the same synthetic record
 * `reviewEdits` renders. The old member-by-member walk paid k × (file read + whole-file merge +
 * locked append) and could conflict against the unit's OWN chain, stopping half-reverted; summing
 * the chain into one pair makes that impossible. A conflict now means a LATER unrelated edit or a
 * manual change — never the chain itself — and every member flips in one append.
 */
export function undoGroup(sessionId: string, id: number): GroupResult {
  const ids = [...groupMembers(sessionId, id)].sort((a, b) => a - b); // oldest → newest
  // Singleton (the common case) keeps the exact single-edit semantics: noop / error / conflict / undone.
  if (ids.length === 1) return { ...undoEdit(sessionId, ids[0]), ids };
  const unit = unitRecord(sessionId, ids);
  if (!unit) return { ok: false, status: 'error', message: `no edit #${id} in this session`, ids };
  const res = undoRecord(sessionId, unit, ids);
  if (res.ok && res.status !== 'noop') {
    const message = res.status === 'deleted'
      ? `deleted ${unit.file} (created by this change — ${ids.length} edit(s))`
      : `reverted this change — ${ids.length} edit(s)`;
    return { ...res, message, ids };
  }
  return { ...res, ids };
}

/** Re-apply a whole undone unit as ONE merge — the forward mirror of [undoGroup]: base is the span's
 *  first `before`, `theirs` its rep's `after`, and every member returns to 'pending' in one append. */
export function redoGroup(sessionId: string, id: number): GroupResult {
  const ids = [...groupMembers(sessionId, id)].sort((a, b) => a - b); // oldest → newest
  if (ids.length === 1) return { ...redoEdit(sessionId, ids[0]), ids };
  const unit = unitRecord(sessionId, ids);
  if (!unit) return { ok: false, status: 'error', message: `no edit #${id} in this session`, ids };
  const res = redoRecord(sessionId, unit, ids);
  if (res.ok && res.status !== 'noop') {
    const message = res.status === 'deleted'
      ? `re-applied this change — deleted ${unit.file}`
      : `re-applied this change — ${ids.length} edit(s)`;
    return { ...res, message, ids };
  }
  return { ...res, ids };
}

/** Force a redo: write the edit's `after` content wholesale (dropping later edits to the file). */
export function reapplyFile(sessionId: string, id: number): UndoResult {
  const rec = findRecord(sessionId, id);
  if (!rec) return { ok: false, status: 'error', message: `no edit #${id}` };
  try { return withFileMutation(rec.file, () => reapplyFileUnlocked(sessionId, id)); }
  catch (e) { return failedResult(sessionId, e, `re-applied ${rec.file}`); }
}

function reapplyFileUnlocked(sessionId: string, id: number): UndoResult {
  const rec = findRecord(sessionId, id);
  if (!rec) return { ok: false, status: 'error', message: `no edit #${id} in this session` };
  // Symmetric with restoreFile: a partial record's disk history is unknown, and force-reapplying
  // its claimed content over whatever is there now is a write nothing could later reverse.
  if (rec.partial || uncertainCreation(rec)) {
    return {
      ok: false,
      status: 'error',
      message: `edit #${id} is review-only (its before-content never arrived) — redo cannot re-apply it, --force included.`,
    };
  }
  const afterBuf = blobBuf(sessionId, rec.afterBlob);
  const later = laterSameFile(sessionId, rec.file, id);
  // The file is written as edit #id left it, which holds the earlier members of its reverted unit
  // too: they come back with it, or the ledger would call them reverted while their lines are on
  // disk (`redo 3 --force` on the demo's unit #1+#3 left #1 "undone").
  const redone = rec.status === 'undone' ? groupMembers(sessionId, id).filter((m) => m <= id) : [id];
  // The force path restores the pre-revert decision too, and drops every later edit of the file.
  const record: StatusPart[] = [{ verb: 'redo', ids: redone }, { verb: 'undo', ids: later }];
  if (afterBuf === null) {
    try {
      if (fs.existsSync(rec.file)) fs.unlinkSync(rec.file);
    } catch (e) {
      return { ok: false, status: 'error', message: `could not delete ${rec.file}: ${String(e)}` };
    }
    recordAfterDisk(sessionId, record);
    return { ok: true, status: 'deleted', message: `re-applied edit #${id} — deleted ${rec.file}` };
  }
  writeEnsuringDir(rec.file, afterBuf);
  recordAfterDisk(sessionId, record);
  return {
    ok: true,
    status: 'redone',
    message: `re-applied edit #${id} to ${rec.file} (later edits to this file dropped)`,
  };
}

export interface UndoScopeResult {
  undone: number; // edits actually reverted
  conflicts: number; // edits left in place because a later change overlapped (offer per-edit --force)
  errors: number; // edits refused outright (e.g. the #43 phantom guard) — without this the bulk totals lie
  firstError?: string; // the first refusal's message — its remediation pointer must reach the user
  firstConflict?: string; // the first conflict's message — a named-dependent refusal must reach the reader too
  total: number; // pending edits that matched the scope
  ids: number[]; // the reverted edit ids
  unrecorded?: Unrecorded; // reverted on disk, status not written — every surface must say so
}

/** The flush every bulk undo/redo ends with: its files are rewritten, so a failure is reported. */
function flushScope(sessionId: string, verb: 'undo' | 'redo', ids: number[]): Unrecorded | undefined {
  try {
    recordAfterDisk(sessionId, [{ verb, ids }]);
    return undefined;
  } catch (e) {
    if (!(e instanceof UnrecordedError)) throw e;
    return e.report(sessionId, `${verb === 'undo' ? 'reverted' : 're-applied'} ${ids.length} edit${ids.length === 1 ? '' : 's'}`);
  }
}

/**
 * Revert every PENDING edit matching a scope, NEWEST-first (so each surgical undo stays on its clean
 * path — later edits are removed before earlier ones). Already-Accepted (kept) and already-undone
 * edits are left as-is; revert an accepted edit individually if you want it gone.
 *
 * This is the ONE implementation behind every scoped/bulk revert: the CLI's `undo --all|--file|--under`,
 * VS Code's file/folder/session Revert (in-process), and — via those CLI flags — JetBrains. Keeping the
 * enumeration here (rather than reimplementing the filter+sort+loop per surface) is what stops the three
 * front-ends from drifting. Scope: no opts = the whole session; `under` = a file (exact) or folder
 * (everything beneath, via isUnderPath); `fileSubstr` = a filename substring (the CLI `--file` filter).
 */
export function undoScope(
  sessionId: string,
  opts: { under?: string; fileSubstr?: string; ids?: number[] } = {}
): UndoScopeResult {
  const idSet = opts.ids ? new Set(opts.ids) : null; // the task-scoped path passes a resolved edit-id set
  const sub = opts.fileSubstr === undefined ? undefined : canonPath(opts.fileSubstr); // #43: match canonical records
  const targets = readLog(sessionId)
    .filter(
      (r) =>
        r.status === 'pending' &&
        (opts.under === undefined || isUnderPath(r.file, opts.under)) &&
        (sub === undefined || r.file.includes(sub)) &&
        (idSet === null || idSet.has(r.id))
    )
    .sort((a, b) => b.id - a.id);
  let undone = 0;
  let conflicts = 0;
  let errors = 0;
  let firstError: string | undefined;
  let firstConflict: string | undefined;
  let unrecorded: Unrecorded | undefined;
  const ids: number[] = [];
  try {
    for (const t of targets) {
      // Deferred status write: each per-record append would invalidate the readLog memo, making the
      // NEXT iteration re-parse the whole log — O(N) full parses per bulk revert. The successes flush
      // as ONE status write below instead.
      const r = undoRecord(sessionId, t, [t.id], true);
      if (r.status === 'conflict') {
        conflicts++;
        if (firstConflict === undefined) firstConflict = r.message;
      } else if (r.ok) {
        undone++;
        ids.push(t.id);
      } else {
        // A refusal (status 'error') is not a conflict and must not vanish from the arithmetic: on a
        // #43-corrupted store, "Reject All" hits the phantom guard for every phantom create, and the
        // refusal message is the only place the repair (`clean --phantoms`) is named.
        errors++;
        if (firstError === undefined) firstError = r.message;
      }
    }
  } finally {
    // The files already rewritten must not lose their ledger flip to a mid-loop throw (one EACCES
    // target aborting the walk) — flush whatever succeeded before the error propagates, or every
    // reverted-but-still-"pending" record answers a spurious conflict forever after.
    unrecorded = flushScope(sessionId, 'undo', ids);
  }
  return { undone, conflicts, errors, firstError, firstConflict, total: targets.length, ids, ...(unrecorded ? { unrecorded } : {}) };
}

export interface RedoScopeResult {
  redone: number;
  conflicts: number;
  total: number; // UNDONE edits in scope
  ids: number[]; // the re-applied edit ids
  unrecorded?: Unrecorded; // re-applied on disk, status not written — every surface must say so
}

/**
 * The forward mirror of undoScope: re-apply every UNDONE edit in scope, OLDEST-first (so a later edit
 * re-merges onto the earlier ones it built on). Same single-implementation rationale — the CLI's
 * `redo --all|--file|--under|--ids`, VS Code's "Redo all", and (via those flags) JetBrains all route
 * here. A reverted unit wholly in scope is re-applied as one change. On an overlap the edits stay undone
 * and are counted as conflicts (redo them with --force).
 * Scope: no opts = the whole session; `under` = a file/folder (isUnderPath); `fileSubstr` = a filename
 * substring; `ids` = an explicit id set.
 */
export function redoScope(
  sessionId: string,
  opts: { under?: string; fileSubstr?: string; ids?: number[] } = {}
): RedoScopeResult {
  const idSet = opts.ids ? new Set(opts.ids) : null;
  const sub = opts.fileSubstr === undefined ? undefined : canonPath(opts.fileSubstr); // #43: match canonical records
  const targets = readLog(sessionId)
    .filter(
      (r) =>
        r.status === 'undone' &&
        (opts.under === undefined || isUnderPath(r.file, opts.under)) &&
        (sub === undefined || r.file.includes(sub)) &&
        (idSet === null || idSet.has(r.id))
    )
    .sort((a, b) => a.id - b.id); // oldest-first: re-apply in original order
  let redone = 0;
  let conflicts = 0;
  let unrecorded: Unrecorded | undefined;
  const ids: number[] = [];
  const inScope = new Set(targets.map((t) => t.id));
  const reached = new Set<number>();
  try {
    for (const t of targets) {
      if (reached.has(t.id)) continue;
      // A reverted unit whose members are all in scope comes back as ONE change, exactly as
      // `redo <id>` re-applies it: member by member, the first cannot be placed without the lines its
      // own later members rewrote, and `redo --ids 1,3` conflicted where `redo 1` succeeded.
      const unit = groupMembers(sessionId, t.id);
      const whole = unit.length > 1 && unit.every((m) => inScope.has(m)) ? unitRecord(sessionId, unit) : null;
      const members = whole ? unit : [t.id];
      for (const m of members) reached.add(m);
      // Deferred status write — same rationale as undoScope: one flush below, not one append per record.
      const r = redoRecord(sessionId, whole ?? t, members, true);
      if (r.status === 'conflict') conflicts += members.length;
      else if (r.ok) {
        redone += members.length;
        ids.push(...members);
      }
    }
  } finally {
    unrecorded = flushScope(sessionId, 'redo', ids); // flush survives a mid-loop throw — see undoScope; kept stays kept
  }
  return { redone, conflicts, total: targets.length, ids, ...(unrecorded ? { unrecorded } : {}) };
}

/**
 * Reverse ONE journaled reviewer operation (store.ts `BatchOp`, listed by `oplog`).
 *
 * A 'keep' is a pure ledger change — restoring each record's journaled BEFORE-status is the whole
 * revert. An 'undo'/'redo' rewrote FILES, so statuses alone would lie about disk: those replay
 * through redoScope/undoScope and surface conflicts exactly like every other scoped verb. Every
 * path flows back through setStatusMany, so the revert is journaled too — `oplog --revert-last`
 * twice lands back where it started, never in a hidden state.
 */
export function revertOperation(
  session: string,
  entry: OperationEntry
): { kind: OperationEntry['kind']; restored?: number; result?: UndoScopeResult | RedoScopeResult } {
  // Disk verbs replay ONLY for records whose journaled BEFORE-status matches the disk operation the
  // kind names: an 'undo' rewrote files flipping pending→undone, a 'redo' flipping undone→pending.
  // Any other before-status means the journaled flip was ledger-only for that record — reverting a
  // keep journals kind 'redo' with prev 'kept', and replaying that through undoScope would rewrite
  // disk for an operation that never touched it (and land on 'undone', not back at 'kept').
  const canonical: EditStatus | null = entry.kind === 'undo' ? 'pending' : entry.kind === 'redo' ? 'undone' : null;
  const diskIds: number[] = [];
  const byPrev = new Map<EditStatus, number[]>();
  for (const id of entry.ids) {
    const prev = entry.prev[String(id)];
    if (!prev) continue;
    if (canonical !== null && prev === canonical) {
      diskIds.push(id);
    } else {
      const arr = byPrev.get(prev);
      if (arr) arr.push(id);
      else byPrev.set(prev, [id]);
    }
  }
  let restored = 0;
  for (const [status, ids] of byPrev) restored += setStatusMany(session, ids, status).length;
  if (entry.kind === 'undo' && diskIds.length) {
    return { kind: entry.kind, ...(restored ? { restored } : {}), result: redoScope(session, { ids: diskIds }) };
  }
  if (entry.kind === 'redo' && diskIds.length) {
    return { kind: entry.kind, ...(restored ? { restored } : {}), result: undoScope(session, { ids: diskIds }) };
  }
  return { kind: entry.kind, restored };
}

/**
 * Task-scoped revert: undo every PENDING edit in the task's STRICT edit set (taskEditIds — only edits
 * made inside a real in_progress interval; an edit that cannot be strictly placed is never included).
 * Reuses undoScope, so a task revert behaves exactly like every other scoped/bulk revert (newest-first,
 * per-edit conflict fallback — a mis-anchored revert still surfaces as a conflict, never a silent
 * clobber).
 */
export function undoTask(cwd: string, session: string, taskId: string): UndoScopeResult {
  return undoScope(session, { ids: taskEditIds(cwd, session, taskId) });
}

export interface KeepScopeResult {
  kept: number; // edits flipped to kept
  total: number; // edits in the task's STRICT edit set (taskEditIds), any status
  ids: number[]; // the kept edit ids
}

/**
 * Task-scoped keep: mark every PENDING edit in the task's STRICT edit set (taskEditIds — the same set
 * undoTask reverts) as kept. Only pending edits are flipped: keeping an already-undone edit would
 * assert a change that isn't on disk.
 */
export function keepTask(cwd: string, session: string, taskId: string): KeepScopeResult {
  const idSet = new Set(taskEditIds(cwd, session, taskId));
  const ids = readLog(session)
    .filter((r) => idSet.has(r.id) && r.status === 'pending')
    .map((r) => r.id);
  setStatusMany(session, ids, 'kept');
  return { kept: ids.length, total: idSet.size, ids };
}
