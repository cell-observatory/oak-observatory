/**
 * Edit-tree view-model — the single source of the folder → file → class → edit structure that the
 * VS Code and JetBrains front-ends render. Folder-chain compaction, class grouping, and exact line
 * deltas all live here (and are exposed as `tree --json`), so the two editors stop reimplementing
 * them. Renderers walk the returned structure; they no longer compute it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { EditRecord, EditStatus, blobText as storeBlobText, rootDir, isSafeSessionId } from './store';
import { lineDelta } from './format';
import { detectClasses, classAt } from './classes';
import * as crypto from 'crypto';
import { locateEditsInCurrent } from './ranges';
import { matchesQuery } from './filter';
import { fileExt, fileCategory, type FileCategory } from './filetype';
import { reviewEdits } from './groups';
import { cancelledMemberIds } from './units';

export interface TreeEdit {
  id: number;
  ts: number;
  tool: string;
  file: string;
  status: EditStatus;
  beforeBlob: string | null;
  afterBlob: string | null;
  added: number;
  removed: number;
  /** Review-only (an ACP diff whose before-content never arrived): undo will REFUSE with the
   *  stated reason, keep works. Load-bearing for any renderer — without it a partial create
   *  renders as an ordinary new file and the reader learns the truth only from the refusal
   *  (JetBrains consumes exactly this projection). */
  partial?: true; // the store's own literal shape (EditRecord.partial) — never a stored `false`
}
export interface TreeClass {
  name: string;
  edits: TreeEdit[];
}
export interface TreeFile {
  rel: string;
  file: string;
  classes: TreeClass[];
  loose: TreeEdit[]; // edits not inside any detected class
  maxTs: number; // most-recent edit time — the "N min ago" column + time sort
  ext: string; // bare lowercased extension — the extension filter key
  category: FileCategory; // one of the six type buckets — the file-type filter key
}
export interface TreeFolder {
  label: string; // may be a compacted chain like "src/utils"
  path: string; // absolute directory path (drives scoped folder Accept/Revert/Clear)
  folders: TreeFolder[];
  files: TreeFile[];
  maxTs: number; // most-recent edit time under this folder
}
export interface EditTree {
  folders: TreeFolder[];
  files: TreeFile[];
}

/** Immediate folder segments + files directly under `prefix` (no compaction). */
function immediate(rels: string[], prefix: string): { folderSegs: Set<string>; files: string[] } {
  const folderSegs = new Set<string>();
  const files: string[] = [];
  for (const rel of rels) {
    if (!rel.startsWith(prefix)) continue;
    const rem = rel.slice(prefix.length);
    const slash = rem.indexOf('/');
    if (slash >= 0) folderSegs.add(rem.slice(0, slash));
    else files.push(rel);
  }
  return { folderSegs, files };
}

/** Any descendant file of a folder (folders only exist because some file lives beneath them). */
function firstFile(f: { folders: TreeFolder[]; files: TreeFile[] }): TreeFile | undefined {
  if (f.files.length) return f.files[0];
  for (const c of f.folders) {
    const r = firstFile(c);
    if (r) return r;
  }
  return undefined;
}

/** Absolute directory path for the folder at rel-prefix `p`, derived from a descendant file's
 *  absolute path (so it's correct regardless of `opts.root` or the OS separator). */
function folderAbs(prefix: string, node: { folders: TreeFolder[]; files: TreeFile[] }): string {
  const sample = firstFile(node);
  if (!sample) return '';
  const nativeTail = sample.rel.slice(prefix.length).split('/').join(path.sep); // file's path below the folder
  let abs = sample.file.slice(0, sample.file.length - nativeTail.length);
  if (abs.endsWith(path.sep)) abs = abs.slice(0, -1);
  return abs;
}

/** Folders + files under `prefix`, with single-child folder chains compacted (src/utils/…). */
function subtree(rels: string[], prefix: string, byRel: Map<string, TreeFile>): { folders: TreeFolder[]; files: TreeFile[] } {
  const { folderSegs, files } = immediate(rels, prefix);
  const folders: TreeFolder[] = [...folderSegs].sort().map((seg) => {
    let p = prefix + seg + '/';
    let label = seg;
    for (;;) {
      const sub = immediate(rels, p);
      if (sub.files.length === 0 && sub.folderSegs.size === 1) {
        const only = [...sub.folderSegs][0];
        p = p + only + '/';
        label = label + '/' + only;
      } else break;
    }
    const child = subtree(rels, p, byRel);
    const maxTs = Math.max(
      0,
      ...child.folders.map((f) => f.maxTs),
      ...child.files.map((f) => f.maxTs)
    );
    return { label, path: folderAbs(p, child), folders: child.folders, files: child.files, maxTs };
  });
  const fileNodes = files.sort().map((rel) => byRel.get(rel) as TreeFile);
  return { folders, files: fileNodes };
}

function toEdit(session: string, rec: EditRecord): TreeEdit {
  const d = lineDelta(session, rec);
  return {
    id: rec.id, ts: rec.ts, tool: rec.tool, file: rec.file, status: rec.status,
    beforeBlob: rec.beforeBlob, afterBlob: rec.afterBlob, added: d.added, removed: d.removed,
    ...(rec.partial ? { partial: true } : {}),
  };
}

/** Group a file's edits under the class each currently falls in (line geometry from ranges.ts). */
function buildFile(session: string, rel: string, file: string, recs: EditRecord[], store: PlacementStore): TreeFile {
  const meta = { maxTs: recs.reduce((m, r) => Math.max(m, r.ts || 0), 0), ext: fileExt(rel), category: fileCategory(rel) };
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    /* file gone / unreadable — render flat */
  }
  const spans = text ? detectClasses(text) : [];
  if (spans.length === 0) {
    return { rel, file, classes: [], loose: recs.map((r) => toEdit(session, r)), ...meta };
  }
  // A blob that cannot be READ is not the same as an edit with no blob: the chain hash is over blob
  // SHAs, so a dropped blob keys identically to an intact one but places differently. In-process that
  // only ever mattered until exit; persisted, it would outlive the process as a wrong answer. Track it
  // and keep such a result out of the disk tier (the memo above is still fine for this run).
  let blobsIntact = true;
  const blobText = (sha: string | null): string => {
    if (!sha) return ''; // no snapshot recorded — a legitimate state (file created), not a failure
    try {
      return storeBlobText(session, sha);
    } catch {
      blobsIntact = false;
      return '';
    }
  };
  const byClass = new Map<string, TreeClass>();
  const loose: TreeEdit[] = [];
  // One hash per FILE (not per edit) identifies the current text for the memo below.
  const textKey = `${text.length}:${crypto.createHash('sha1').update(text).digest('hex').slice(0, 16)}`;
  // `recs` arrive in log order (reviewEdits walks the log), i.e. chronological — which is what keeps
  // each composed hop one edit wide. Order is a CORRECTNESS requirement, not a speed one: composition
  // follows surviving lines, so a hop between unrelated states drops them and the earlier edits come
  // back unplaced. Feeding the same three edits as (2,0,1) yields [[],[1],[3]] where chronological order
  // yields [[1],[3],[5]] — a silently missing placement, not a slower one.
  const lines = locateCached(textKey, recs, blobText, text, store, () => blobsIntact);
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const line = lines[i];
    const cls = line !== undefined ? classAt(spans, line) : null;
    if (cls) {
      const key = `${cls.name}@${cls.start}`;
      if (!byClass.has(key)) byClass.set(key, { name: cls.name, edits: [] });
      byClass.get(key)!.edits.push(toEdit(session, r));
    } else {
      loose.push(toEdit(session, r));
    }
  }
  return { rel, file, classes: [...byClass.values()], loose, ...meta };
}

/**
 * Build the full edit tree for a session.
 * - `root`: workspace root, used to compute display-relative paths (defaults to the raw absolute path).
 * - `filter`: optional Search filter (matched against the relative path).
 */
/** Memo for the per-FILE placement pass, keyed by (current file text, the file's whole edit chain).
 *
 *  Placing a file's edits composes the edit chain in ONE backwards pass (see locateEditsInCurrent), so
 *  the unit worth caching is the FILE, not the edit — one entry now covers every edit in it. All inputs
 *  are content-identified (blobs are immutable; the file text is hashed once per file), so a hit is
 *  exact: when the file on disk changes, or any edit in the chain does, the key changes with it. */
/**
 * Each entry carries whether it may be PERSISTED, because this memo outlives the disk store below.
 *
 * `lineMemo` is module-global; a `placementStore` is created per `buildEditTree` call. So on the second
 * build in one process every lookup is an L1 hit, and if that path does not re-retain the key, the
 * store's `keep` set is empty and its pruning flush rewrites placements.json as `{}` — the disk tier
 * deleting itself on the second call, in exactly the long-lived process (the VS Code extension host)
 * that benefits from it most. Reproduced: entries 1 → 0 → 0.
 */
const lineMemo = new Map<string, { lines: Placements; persistable: boolean }>();
const LINE_MEMO_CAP = 2000; // one entry per FILE now, not per edit

type Placements = (number | undefined)[];

/** Bump when the stored shape or the key's meaning changes. */
const PLACEMENT_VERSION = 1;

/**
 * The disk tier behind `lineMemo` — the same memo, surviving the process.
 *
 * Placement is where a change-map build actually spends its time: profiled on a 405-file / 2,800-edit
 * session, 75 % of `buildEditTree`'s 2.27 s was the Myers diff inside `locateEditsInCurrent`, against
 * 22 ms of reading those files off disk. `lineMemo` already collapses that to nothing — but only within
 * one process, and the Overview runs in a FRESH CLI process on every refresh tick, so it never got the
 * chance. This makes the same entries readable by the next process.
 *
 * Persisting a memo is only safe because this key is content-exact (see `locateCached`): the current
 * file text is hashed, and blobs are immutable and identified by SHA. Nothing here is keyed by mtime,
 * so there is no stale-read window — a changed file or a changed edit chain is simply a different key.
 * That granularity is the point: saving one file re-diffs one file, where the change map's own cache
 * would discard all 405.
 */
interface PlacementStore {
  get(key: string): Placements | undefined;
  set(key: string, lines: Placements, persistable: boolean): void;
  /** `prune`: drop entries this pass did not use. Only ever true for an UNFILTERED build (see below). */
  flush(prune: boolean): void;
}

function placementStore(session: string): PlacementStore {
  const file = isSafeSessionId(session)
    ? path.join(rootDir(), 'changemap-cache', session, 'placements.json')
    : null; // an unsafe id must never become a path segment
  const disk = new Map<string, Placements>();
  if (file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: number; entries?: Record<string, (number | null)[]> };
      if (j && j.version === PLACEMENT_VERSION && j.entries) {
        // `undefined` (an unplaced edit) is not representable in JSON and serializes to null; map it back
        // rather than letting "unplaced" quietly become line 0.
        for (const [k, v] of Object.entries(j.entries)) disk.set(k, v.map((n) => (n === null ? undefined : n)));
      }
    } catch {
      /* absent, unreadable, or a version we do not understand — start empty */
    }
  }
  const keep = new Map<string, Placements>();
  return {
    get(key) {
      const hit = disk.get(key);
      if (hit) keep.set(key, hit); // used this pass — must survive a pruning rewrite
      return hit;
    },
    set(key, lines, persistable) {
      if (persistable) keep.set(key, lines);
    },
    flush(prune) {
      if (!file) return;
      // A FILTERED build only visits the matching files, so its `keep` is a subset by construction —
      // pruning against it would let `tree --filter foo` throw away every other file's placements and
      // make the next full build cold. Filtered passes may only ADD.
      const out = prune ? keep : new Map([...disk, ...keep]);
      if (out.size === disk.size && [...out.keys()].every((k) => disk.has(k))) return; // nothing to write
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.tmp`; // pid-scoped so concurrent builds cannot collide
        // 0600/0700 like every other file in the store (SECURITY.md).
        fs.writeFileSync(tmp, JSON.stringify({ version: PLACEMENT_VERSION, entries: Object.fromEntries(out) }), { mode: 0o600 });
        fs.renameSync(tmp, file); // atomic: a concurrent reader sees old-or-new, never a torn file
      } catch {
        /* cache is best-effort */
      }
    },
  };
}

function locateCached(
  textKey: string,
  recs: EditRecord[],
  blobText: (sha: string | null) => string,
  text: string,
  store: PlacementStore,
  blobsIntact: () => boolean
): Placements {
  // The chain is HASHED, not concatenated: at 82 chars per edit the raw key was 91% of the entry, so a
  // full memo of 2,000 files at 500 edits each retained 86 MB (7.7 MB hashed) in a long-lived host.
  const chain = crypto
    .createHash('sha1')
    .update(recs.map((r) => `${r.beforeBlob ?? ''}:${r.afterBlob ?? ''}`).join(','))
    .digest('hex')
    .slice(0, 16);
  const key = `${textKey} ${recs.length}:${chain}`;
  const hit = lineMemo.get(key);
  // An L1 hit must STILL be offered to the store. The memo outlives the store (see lineMemo), so on the
  // second build in one process this is the only path taken — and a store whose `keep` set stayed empty
  // prunes the file down to nothing on flush.
  if (hit) {
    store.set(key, hit.lines, hit.persistable);
    return hit.lines;
  }
  const onDisk = store.get(key); // marks it retained for this pass
  if (onDisk) {
    memoize(key, onDisk, true); // it came FROM disk, so it is persistable by construction
    return onDisk;
  }
  // Blob reads only on a miss, and PULLED one at a time — materialising every snapshot up front held
  // the file's whole history resident.
  const lines = locateEditsInCurrent(
    recs.length,
    (i) => ({ before: blobText(recs[i].beforeBlob), after: blobText(recs[i].afterBlob) }),
    text
  ).map((p) => p.lines[0]);
  const persistable = blobsIntact(); // only after the reads, which is what sets the flag
  memoize(key, lines, persistable);
  store.set(key, lines, persistable);
  return lines;
}

function memoize(key: string, lines: Placements, persistable: boolean): void {
  if (lineMemo.size >= LINE_MEMO_CAP) lineMemo.clear();
  lineMemo.set(key, { lines, persistable });
}


export function buildEditTree(session: string, opts: { root?: string; filter?: string } = {}): EditTree {
  const filter = opts.filter || '';
  const relOf = (file: string): string => {
    const r = opts.root ? path.relative(opts.root, file) : file;
    return r.split(path.sep).join('/');
  };
  // Collapse same-code pending edits into one review unit (shared with the CLI `list`).
  const display = reviewEdits(session);
  // A chain that goes nowhere is not work, so it is not on the map either. Counting it here is what
  // let a file read "16 pending" in the Overview while the review list showed it nothing to decide —
  // and on a session full of them the map's totals were mostly noise.
  const cancelled = cancelledMemberIds(session);
  const grouped = new Map<string, { file: string; edits: EditRecord[] }>();
  for (const rec of display) {
    if (cancelled.has(rec.id)) continue;
    const rel = relOf(rec.file);
    if (filter && !matchesQuery(rel, filter)) continue;
    if (!grouped.has(rel)) grouped.set(rel, { file: rec.file, edits: [] });
    grouped.get(rel)!.edits.push(rec);
  }
  const byRel = new Map<string, TreeFile>();
  const store = placementStore(session);
  for (const [rel, g] of grouped) byRel.set(rel, buildFile(session, rel, g.file, g.edits, store));
  store.flush(!filter); // a filtered pass saw only some files — it may add entries, never prune them
  return subtree([...grouped.keys()], '', byRel);
}
