/** Baselines for explicitly unfinished tools, as the retired ACP capture path left them behind. The
 * writer and its reconciler went with that path; `oak integrity` still reports what they retained. */
import * as fs from 'fs';
import * as path from 'path';
import { storeDir } from './store';

interface DeferredTurn {
  version: 1; promptId: string; cwd: string; runtime: string; model?: string; ts: number;
  toolCallIds: string[]; files: Record<string, string>; complete: boolean; excluded: string[];
  lease?: string;
}
export function deferredTurns(session: string): (DeferredTurn & { file: string })[] {
  try { return fs.readdirSync(storeDir(session)).filter(n => /^deferred-acp-[a-f0-9-]+\.json$/.test(n)).flatMap(n => {
    const file = path.join(storeDir(session), n);
    try { const d = JSON.parse(fs.readFileSync(file, 'utf8')) as DeferredTurn;
      return d.version === 1 && Array.isArray(d.toolCallIds) && typeof d.cwd === 'string' && d.files ? [{ ...d, file }] : [];
    } catch { return []; }
  }); } catch { return []; }
}
