/**
 * Fleet / cross-agent awareness (zero-token): the OTHER Claude Code sessions working in the same
 * project as this one — so a human can watch a fleet of concurrent agents, and (via `siblings --json`)
 * so an agent can see what its siblings are touching and adjust in real time.
 *
 * "Sibling" = another session in the same project (listSiblings, one project dir) or — repo-scoped —
 * any WORKTREE of the same git repo (listRepoSiblings, unioned via §S2 commonDir since worktrees
 * mangle to different project dirs). For each we derive, live from the store + transcript: active/idle
 * status (transcript freshness), pending edits, the files it has touched, and a risk-flag count.
 * Read-only and path-only — no file contents cross between agents, so this can't leak one agent's
 * secrets to another. No model calls, no network.
 */
import * as fs from 'fs';
import * as path from 'path';
import { claudeConfigDir } from './paths';
import { projectDir, commonDir, repoKeyForSession, firstCwdLine, isMirroredTranscript, isBridgePointer } from './session';
import { readLog, isSafeSessionId, sidecarMemo } from './store';
import { captureEventsPath } from './capture-events';
import { cancelledMemberIds } from './units';
import { parseTranscriptActions, agentPhaseDetail } from './actions';
import { sessionCounts } from './observe';
import { derivedInventory } from './derived';

/** A session whose transcript mtime is within this of now is "active" (an agent is live in it). */
export const FLEET_ACTIVE_MS = 60_000;

/**
 * Is a session live right now, by the one definition the whole product uses? Every "active" surface —
 * the fleet rows, the Overview's Active-only filter, the Timeline's session selector — must agree, so the
 * comparison lives here rather than being re-spelled per caller.
 *
 * `lastMs` is a transcript mtime (see [SiblingSession.lastMs]). A falsy one means "never seen", which is
 * not active.
 */
export function isFleetActive(lastMs: number, now: number = Date.now()): boolean {
  return !!lastMs && now - lastMs <= FLEET_ACTIVE_MS;
}

/**
 * A session whose conversation last moved longer ago than this is FOLDED: still listed, but collapsed
 * in the fleet surfaces and never rebuilt on the Overview's critical path.
 *
 * The Overview builds one full change map per repo sibling, and a mature repo accumulates them without
 * bound — 33 in this one, of which 24 were more than a week old. Those are finished conversations
 * nobody is watching, and rebuilding them is most of what a cold refresh costs. Folded siblings are
 * served from the on-disk cache when it happens to be warm and reported as UNBUILT when it is not;
 * they are never built eagerly. Expanding one is what asks for it.
 */
export const FLEET_FOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** Whether a sibling's last conversation activity is old enough to fold. `lastMs` is transcript mtime. */
export function isFoldedAge(lastMs: number, now: number): boolean {
  return lastMs > 0 && now - lastMs > FLEET_FOLD_MS;
}

export interface SiblingSession {
  id: string;
  /** True for the current (querying) session — so a UI can mark "you are here" and a digest can skip it. */
  self: boolean;
  /** Transcript touched within FLEET_ACTIVE_MS ⇒ an agent is live in this session right now. */
  active: boolean;
  /** Transcript mtime (ms epoch) — last activity. */
  lastMs: number;
  edits: number;
  pending: number;
  /** Distinct absolute files this session has edits for (capped; `moreFiles` = how many were elided). */
  files: string[];
  moreFiles: number;
  /** UNCAPPED distinct files this session has a PENDING (unresolved) edit for — the live-overlap signal
   *  fleetConflicts intersects. Path-only; a file reviewed (kept/undone) in every edit drops out. */
  pendingFiles: string[];
  /** Risky shell commands this session ran (total + high-severity), for a conflict/safety heads-up. */
  risk: { total: number; high: number };
  // --- S3 (0.8.0): repo-scoped worktree siblings + conflict detection ---
  /** This session's launch cwd — its worktree dir. Sibling worktrees of one repo differ here. */
  worktree: string;
  /** Branch from the transcript's first cwd-bearing line (display disambiguator; null when unresolved,
   *  e.g. the cheap same-dir listSiblings path — never a guess). */
  gitBranch: string | null;
  /** UNCAPPED distinct file set this session touched — exposed to clients (siblings --json). Path-only;
   *  no file contents ever cross. (Collisions now key off `pendingFiles`, above — not this.) */
  allFiles: string[];
  /** Live phase (working/awaiting-input/…) from a bounded tail read of the transcript (S4, agentPhase). */
  phase?: string;
  /** 'high' = structural; 'heuristic' = staleness-inferred (awaiting-permission/idle/done). Renderers
   *  dim/qualify heuristic phases instead of asserting them as truth. */
  phaseConfidence?: string;
}

/** How many distinct files to list per sibling before eliding the rest (keeps the digest compact). */
const FILE_CAP = 20;

/** Session ids whose transcript lives in this project — CHEAP (one readdir, no store/transcript
 *  reads). Lets a UI decide whether to show a Fleet affordance before doing the full listSiblings parse. */
export function projectSessionIds(cwd: string): string[] {
  try {
    const dir = projectDir(cwd);
    return derivedInventory(`fleet-directory:${dir}`, () => fs.readdirSync(dir))
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => n.slice(0, -'.jsonl'.length))
      .filter(isSafeSessionId);
  } catch {
    return [];
  }
}

/**
 * Build one SiblingSession from its transcript + store log — shared by listSiblings (same project dir)
 * and listRepoSiblings (across worktree project dirs). `worktree` is the session's launch cwd and
 * `gitBranch` its transcript branch (null when the caller didn't resolve one). Returns null if the
 * transcript can't be stat'd (vanished mid-scan). Path-only — no file contents are read. Zero token.
 */
function buildSibling(
  id: string,
  transcriptPath: string,
  worktree: string,
  gitBranch: string | null,
  activeSessionId: string | undefined,
  now: number
): SiblingSession | null {
  let lastMs = 0;
  try {
    lastMs = fs.statSync(transcriptPath).mtimeMs;
  } catch {
    return null;
  }
  // The ACTIVITY clock, apart from `lastMs` (which stays the conversation clock — the fold rule
  // and the displayed age key on it): a DRIVEN sibling's freshest evidence is its sidecar
  // (appended per streamed chunk) or its store log (hook captures land mid-turn), and
  // transcript-only liveness flapped working agents inactive between message boundaries — under
  // "Active only" a flap makes the row VANISH. Two stats per sibling.
  let liveMs = lastMs;
  try {
    liveMs = Math.max(liveMs, fs.statSync(captureEventsPath(id)).mtimeMs);
  } catch {
    /* no sidecar — the conversation clock stands */
  }
  const log = readLog(id); // [] when the session captured no edits — still a real sibling agent
  // The log leg reads the newest RECORD ts, not the file's mtime: records are append-only truth
  // (a keep/undo rewrites statuses but never timestamps), so reviewing cannot fake activity.
  for (const r of log) if (r.ts > liveMs) liveMs = r.ts;
  const distinct: string[] = [];
  const seen = new Set<string>();
  const pendingSeen = new Set<string>(); // distinct files with a PENDING edit — the live-overlap set
  // …and a chain that cancels out is not an overlap. This set drives the cross-agent collision
  // warning, so a phantom create/delete pair would raise "two agents are both editing this file"
  // about a file neither of them changed — and the row beside it would read `0 pending`.
  // Pending-only, deliberately: this set gates the PENDING-file overlap below, and it runs once per
  // sibling in a fresh process where nothing is memoized — the all-status form added ~43% to
  // `listSiblings` on large siblings for two walks whose answers this loop never reads.
  const settled = cancelledMemberIds(id, 'pending');
  for (const r of log) {
    if (r.status === 'pending' && !settled.has(r.id)) {
      pendingSeen.add(r.file);
    }
    if (!seen.has(r.file)) {
      seen.add(r.file);
      distinct.push(r.file);
    }
  }
  // Risk needs the transcript (Bash commands aren't in the store), so it is parsed the way the Actions
  // view parses it — but ONCE per transcript state, not once per refresh. A repo with dozens of finished
  // siblings was re-parsing every one of their transcripts on every tick, which is most of what made a
  // refresh (and therefore a session switch) slow.
  let stamp = '';
  try {
    const st = fs.statSync(transcriptPath);
    stamp = `1|${st.mtimeMs}:${st.size}`;
  } catch {
    /* unreadable — compute without a cache */
  }
  const { total: riskTotal, high: riskHigh } = sidecarMemo(id, 'risk', stamp, () => {
    let total = 0;
    let high = 0;
    for (const a of parseTranscriptActions(transcriptPath, { includeSidechain: false })) {
      if (a.risk) {
        total++;
        if (a.risk.level === 'high') high++;
      }
    }
    return { total, high };
  });
  const counts = sessionCounts(id);
  const phaseDetail = derivedInventory(`phase:${transcriptPath}`, () => agentPhaseDetail(transcriptPath));
  return {
    id,
    self: id === activeSessionId,
    active: isFleetActive(liveMs, now),
    lastMs,
    // DISPLAY units — the same collapse the Overview and the Sessions rows apply, so "N pending across
    // siblings" cannot disagree with the row the reader clicks into. sessionCounts is sidecar-cached on
    // disk, so this stays one stat() per sibling on a warm store rather than 31 collapses per tick.
    // The DISTINCT-file set above stays raw on purpose: collapsing merges chained edits within one
    // file, so that set is identical either way. The PENDING-file set is not — a file whose only
    // pending records cancel out has nothing to collide over — so that one is filtered.
    edits: counts.edits,
    pending: counts.pending,
    files: distinct.slice(0, FILE_CAP),
    moreFiles: Math.max(0, distinct.length - FILE_CAP),
    pendingFiles: [...pendingSeen],
    risk: { total: riskTotal, high: riskHigh },
    worktree,
    gitBranch,
    allFiles: distinct,
    // S4: bounded tail read — the sibling's live phase, with its confidence (structural vs heuristic).
    phase: phaseDetail.phase,
    phaseConfidence: phaseDetail.confidence,
  };
}

/**
 * Every session in the current project (siblings + self), newest activity first. `activeSessionId`
 * marks which one is `self`. Zero token — store reads plus one transcript parse per sibling for risk.
 */
export function listSiblings(cwd: string, activeSessionId?: string): SiblingSession[] {
  const dir = projectDir(cwd);
  let entries: string[];
  try {
    entries = derivedInventory(`fleet-directory:${dir}`, () => fs.readdirSync(dir));
  } catch {
    return [];
  }
  const now = Date.now();
  const out: SiblingSession[] = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    if (!isSafeSessionId(id)) continue;
    // Same project dir ⇒ every session here launched from `cwd`; the branch isn't resolved on this
    // cheap same-dir path (honest null, not a guess) — listRepoSiblings reads it from the transcript.
    const s = buildSibling(id, path.join(dir, name), cwd, null, activeSessionId, now);
    if (s) out.push(s);
  }
  return out.sort((a, b) => b.lastMs - a.lastMs);
}

/**
 * Every session across ALL worktrees of the same logical repo as `cwd` — the repo-scoped superset of
 * listSiblings. Two worktrees launch from different cwds, so they mangle to different project dirs and
 * listSiblings (one dir) can't see across them; this unions every projectDir whose commonDir (§S2)
 * equals this cwd's. Each candidate's real cwd is read from its transcript (firstCwdLine — the mangled
 * folder name is irreversible), then keyed via repoKeyForSession. Git-free, path-only, zero token.
 * Returns [] when this cwd has no resolvable repo (never unions on a null key — that would wrongly
 * group every unrelated non-repo session together).
 */
export function listRepoSiblings(cwd: string, activeSessionId?: string): SiblingSession[] {
  const key = commonDir(cwd);
  if (key === null) return [];
  const root = path.join(claudeConfigDir(), 'projects');
  let projects: string[];
  try {
    projects = derivedInventory(`fleet-directory:${root}`, () => fs.readdirSync(root));
  } catch {
    return [];
  }
  const now = Date.now();
  const out: SiblingSession[] = [];
  for (const proj of projects) {
    const dir = path.join(root, proj);
    let names: string[];
    try {
      names = derivedInventory(`fleet-directory:${dir}`, () => fs.readdirSync(dir));
    } catch {
      continue; // not a directory / unreadable — skip
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -'.jsonl'.length);
      if (!isSafeSessionId(id)) continue;
      const transcript = path.join(dir, name);
      if (isMirroredTranscript(transcript).mirrored || isBridgePointer(transcript)) continue;
      const first = firstCwdLine(transcript);
      if (!first) continue; // no cwd line ⇒ can't resolve its repo; skip (never guess membership)
      if (repoKeyForSession(id, first.cwd) !== key) continue; // different (or unresolvable) repo
      const s = buildSibling(id, transcript, first.cwd, first.gitBranch, activeSessionId, now);
      if (s) out.push(s);
    }
  }
  return out.sort((a, b) => b.lastMs - a.lastMs);
}

export interface FileCollision {
  /** Absolute path with an unresolved (pending) edit in 2+ siblings, at least one active (path-only). */
  file: string;
  /** ALL session ids that have this file pending (2+), active or idle. Honest: exact agents, never a "winner". */
  agents: string[];
  /** The subset of `agents` that are active right now — the side that can trample the others' pending
   *  work. Renderers dim the idle holders. Always ≥1 (an all-idle overlap is not a live hazard). */
  activeAgents: string[];
  /** Always true — a collision is by definition a set of pending edits (kept for payload stability; the
   *  overlap is unresolved in every listed agent). */
  anyPending: boolean;
}

/**
 * LIVE cross-agent collisions: a file flagged when 2+ siblings each have it in their `pendingFiles` AND
 * at least ONE of them is `active` right now — a live agent's in-flight edit can trample another agent's
 * unresolved work even if that other agent has gone idle (>60s without a transcript write is routine for
 * a long think). This is still deliberately NARROWER than "any file two agents ever touched": a file
 * reviewed (kept/undone) on one side drops out, and an ALL-idle overlap (nobody moving) does not flag.
 * Intersects the UNCAPPED `pendingFiles` (never the display-capped `files`), so a busy agent's 21st+
 * shared pending file is still caught. Path-only: no file contents cross between agents.
 */
export function fleetConflicts(sessions: SiblingSession[]): FileCollision[] {
  const activeIds = new Set(sessions.filter((s) => s.active).map((s) => s.id));
  const byFile = new Map<string, string[]>(); // file -> ALL agent ids that have it pending
  for (const s of sessions) {
    for (const f of s.pendingFiles) {
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f)!.push(s.id);
    }
  }
  const out: FileCollision[] = [];
  for (const [file, agents] of byFile) {
    const activeAgents = agents.filter((id) => activeIds.has(id));
    if (agents.length >= 2 && activeAgents.length >= 1) out.push({ file, agents, activeAgents, anyPending: true });
  }
  return out;
}

export interface FleetSummary {
  total: number; // sessions in this project (including self)
  active: number; // how many are live right now
  siblings: number; // total minus self
  pending: number; // pending edits across siblings (excludes self)
  conflicts: number; // LIVE collisions: files pending in 2+ BOTH-active siblings (fleetConflicts)
}

/** Headline rollup for the fleet (the Actions "Fleet" node header + `siblings` non-JSON output). */
export function summarizeFleet(sessions: SiblingSession[]): FleetSummary {
  const siblings = sessions.filter((s) => !s.self);
  return {
    total: sessions.length,
    active: sessions.filter((s) => s.active).length,
    siblings: siblings.length,
    pending: siblings.reduce((n, s) => n + s.pending, 0),
    conflicts: fleetConflicts(sessions).length,
  };
}
