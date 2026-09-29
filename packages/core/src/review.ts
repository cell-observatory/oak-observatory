/**
 * Review summary / export — a shareable per-session recap of what Claude changed and what you did
 * with it (kept / reverted / pending, per file, acceptance rate). Rendered once here so the CLI and
 * both editors export the identical markdown (e.g. to paste into a PR).
 */
import { minOf, maxOf } from './store';
import { visibleEdits } from './groups';
import { lineDelta } from './format';

export interface ReviewFileSummary {
  file: string;
  kept: number;
  undone: number;
  pending: number;
  added: number;
  removed: number;
}

export interface ReviewSummary {
  session: string;
  total: number;
  pending: number;
  kept: number;
  undone: number;
  /** kept / (kept + undone), or null when nothing has been reviewed yet. */
  acceptanceRate: number | null;
  files: ReviewFileSummary[];
  reverted: { id: number; file: string; ts: number }[];
  firstTs: number | null;
  lastTs: number | null;
}

export function reviewSummary(session: string): ReviewSummary {
  // DISPLAY units, like every other count in the product (see sessionCounts) — minus the chains
  // that cancel out, which are not edits anybody is asked to decide about.
  const log = visibleEdits(session);
  const byFile = new Map<string, ReviewFileSummary>();
  let kept = 0;
  let undone = 0;
  let pending = 0;
  const reverted: { id: number; file: string; ts: number }[] = [];
  for (const r of log) {
    let f = byFile.get(r.file);
    if (!f) {
      f = { file: r.file, kept: 0, undone: 0, pending: 0, added: 0, removed: 0 };
      byFile.set(r.file, f);
    }
    const d = lineDelta(session, r);
    f.added += d.added;
    f.removed += d.removed;
    if (r.status === 'kept') {
      kept++;
      f.kept++;
    } else if (r.status === 'undone') {
      undone++;
      f.undone++;
      reverted.push({ id: r.id, file: r.file, ts: r.ts });
    } else {
      pending++;
      f.pending++;
    }
  }
  const reviewed = kept + undone;
  return {
    session,
    total: log.length,
    pending,
    kept,
    undone,
    acceptanceRate: reviewed ? kept / reviewed : null,
    files: [...byFile.values()],
    reverted,
    firstTs: log.length ? minOf(log.map((r) => r.ts)) : null,
    lastTs: log.length ? maxOf(log.map((r) => r.ts)) : null,
  };
}

/** Render a summary as portable markdown (for export / PR comments). */
export function reviewSummaryMarkdown(s: ReviewSummary): string {
  const pct = s.acceptanceRate === null ? '—' : `${Math.round(s.acceptanceRate * 100)}%`;
  const lines: string[] = [
    '# OAK — review summary',
    '',
    `- Session: \`${s.session}\``,
    `- Edits: **${s.total}** — ${s.pending} pending · ${s.kept} kept · ${s.undone} reverted`,
    `- Acceptance rate: **${pct}**`,
    '',
    '| File | +added | −removed | kept | reverted | pending |',
    '| --- | --: | --: | --: | --: | --: |',
  ];
  for (const f of s.files) {
    lines.push(`| ${f.file} | ${f.added} | ${f.removed} | ${f.kept} | ${f.undone} | ${f.pending} |`);
  }
  if (s.reverted.length) {
    lines.push('', '## Reverted edits', '');
    for (const r of s.reverted) lines.push(`- #${r.id} \`${r.file}\``);
  }
  return lines.join('\n') + '\n';
}
