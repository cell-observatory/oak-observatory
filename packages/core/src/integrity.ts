import { deferredTurns } from './deferred-capture';
/** Read-only capture health and historical integrity. Never rewrites records, blobs or statuses. */
import * as fs from 'fs';
import * as path from 'path';
import { readLog, readBlob, readSkips, storeDir, maxOf, uncertainCreation, type EditRecord } from './store';
import { readCaptureEvents } from './capture-events';
import { findCodexRollout } from './codex';
import { codexParserHealth } from './codex-events';
export { uncertainCreation } from './store';
export interface IntegrityIssue { severity: 'error' | 'warning'; code: string; message: string; recordIds: number[]; file?: string }
export function captureIntegrity(session: string): { session: string; records: number; issues: IntegrityIssue[]; skipped: number; skipReasons: { reason: string; count: number }[];
  lastCaptureTs: number | null; inFlight: number; parser: ReturnType<typeof codexParserHealth>; healthy: boolean } {
  const records = readLog(session), issues: IntegrityIssue[] = [], blobs = new Set<string>(), latest = new Map<string, EditRecord>();
  const sources = new Map<string, number>();
  for (const r of records) {
    for (const sha of [r.beforeBlob,r.afterBlob]) if (sha && !blobs.has(sha)) {
      blobs.add(sha); try { readBlob(session,sha); } catch { issues.push({ severity:'error',code:'missing-blob',message:'Referenced snapshot content is missing',recordIds:[r.id],file:r.file }); }
    }
    if (r.partial || uncertainCreation(r)) issues.push({ severity:'warning',code:'uncertain-before',message:r.uncertainty || 'Before-state lacks sufficient evidence for safe Undo',recordIds:[r.id],file:r.file });
    const prior=latest.get(r.file);
    if (prior && prior.status !== 'undone' && r.status !== 'undone' && prior.afterBlob !== r.beforeBlob)
      issues.push({severity:'warning',code:'disconnected-transition',message:'File changed between recorded transitions; attribution may be incomplete',recordIds:[prior.id,r.id],file:r.file});
    latest.set(r.file,r);
    if (r.toolCallId) {
      const key=JSON.stringify([r.nativeTurnId ?? r.promptId,r.toolCallId,r.file,r.beforeBlob,r.afterBlob]);
      const previous=sources.get(key);
      if (previous !== undefined) issues.push({severity:'warning',code:'duplicate-source',message:'Multiple records identify the same tool transition',recordIds:[previous,r.id],file:r.file});
      sources.set(key,r.id);
    }
  }
  const prompts = new Set<string>();
  for (const e of readCaptureEvents(session,['turn_start'])) { const id=(e.payload as {promptId?:string})?.promptId;
    if (!id) continue; if (prompts.has(id)) issues.push({severity:'warning',code:'reused-prompt-id',message:`Prompt ID ${id} occurs more than once; historical attribution needs review`,recordIds:[]}); prompts.add(id);
  }
  for (const d of deferredTurns(session)) issues.push({ severity:'warning', code:'deferred-tools',
    message:`Turn ${d.promptId} has ${d.toolCallIds.length} unfinished tool(s); its retained baseline awaits completion`, recordIds:[] });
  let inFlight=0; try { inFlight=fs.readdirSync(path.join(storeDir(session),'staging')).filter(n=>n.endsWith('.json')).length; } catch {}
  const raw=findCodexRollout(session), parser=raw ? codexParserHealth(raw) : null;
  const skips=readSkips(session);
  const skipped=skips.length;
  // By reason, most frequent first: "1,391 capture gaps" says nothing to act on; "1,391 × Bash
  // working tree exceeds 4000 files (most under packages/x/)" names the remedy.
  const byReason=new Map<string,number>();
  for(const k of skips){const r=String((k as {reason?:unknown}).reason ?? 'unknown');byReason.set(r,(byReason.get(r)??0)+1);}
  const skipReasons=[...byReason.entries()].sort((a,b)=>b[1]-a[1]).map(([reason,count])=>({reason,count}));
  return {session,records:records.length,issues,skipped,skipReasons,inFlight,lastCaptureTs:records.length ? maxOf(records.map(r=>r.ts)) : null,
    parser,healthy:issues.length===0 && skipped===0 && !(parser?.malformed)};
}

/** Human-readable evidence for review tooltips and the CLI. A snapshot-interval capture names its
 *  METHOD, not an unknown author: the record still carries the turn/tool that owns the interval
 *  (`runtime`, `turn`, `tool` appended below), so the old "authorship unverified" wording overstated
 *  the uncertainty — alarmingly so for codex/gpt, whose driven and shell edits are ALL interval-
 *  captured (the ACP drive-turn reconcile and the Bash tree diff), while Claude's typed Edit/Write
 *  tools land as `provenance: 'tool'`. What an interval genuinely cannot rule out — a concurrent
 *  writer in the window — is the separate `attribution === 'ambiguous'` branch above. */
export function captureSummary(r: EditRecord): string {
  const fidelity = r.partial || uncertainCreation(r) ? 'review-only: before-state uncertain' :
    r.attribution === 'ambiguous' ? 'overlapping capture: attribution uncertain' :
    r.provenance === 'snapshot' ? 'snapshot interval — before/after captured from disk' :
    r.toolCallId ? 'correlated tool capture' : 'capture without native tool identity';
  return [fidelity, r.runtime, r.model && `reported model ${r.model}`, r.toolCallId && `tool ${r.toolCallId}`,
    r.nativeTurnId && `turn ${r.nativeTurnId}`].filter(Boolean).join(' · ');
}
