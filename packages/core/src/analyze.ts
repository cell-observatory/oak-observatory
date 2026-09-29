/**
 * Analysis layer (OPT-IN, token-spending): runs `claude -p` to deep-analyze an edit or generate
 * session suggestions, and caches the result in the store. Kept separate from the zero-token core;
 * the capture hook never imports this.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnTool } from './spawn';
import { findRecord, readBlob, readLog, storeDir } from './store';
import { summarize } from './observe';

export interface Analysis {
  kind: 'edit' | 'suggestions' | 'recap';
  key: string; // 'edit-<id>' | 'suggestions' | 'recap'
  text: string; // markdown (or a single sentence, for recap)
  ts: number;
}

function analysisDir(sessionId: string): string {
  return path.join(storeDir(sessionId), 'analysis');
}
export function analysisPath(sessionId: string, key: string): string {
  return path.join(analysisDir(sessionId), `${key}.json`);
}
export function cachedAnalysis(sessionId: string, key: string): Analysis | null {
  try {
    return JSON.parse(fs.readFileSync(analysisPath(sessionId, key), 'utf8')) as Analysis;
  } catch {
    return null;
  }
}
function save(sessionId: string, a: Analysis): void {
  fs.mkdirSync(analysisDir(sessionId), { recursive: true });
  const p = analysisPath(sessionId, a.key);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(a));
  fs.renameSync(tmp, p); // atomic: a concurrent cachedAnalysis() never reads a torn file
}

/** nvm has no stable bin dir — globals land under ~/.nvm/versions/node/<ver>/bin. */
function nvmBins(name: string): string[] {
  try {
    const root = path.join(os.homedir(), '.nvm', 'versions', 'node');
    return fs.readdirSync(root).sort().reverse().map((v) => path.join(root, v, 'bin', name));
  } catch {
    return [];
  }
}

/** fnm, like nvm, keeps one bin dir per installed node — globals land under
 *  <fnm dir>/node-versions/<ver>/installation/bin. FNM_DIR wins when the user set it. */
function fnmBins(name: string): string[] {
  const roots = [
    process.env.FNM_DIR,
    path.join(os.homedir(), '.local', 'share', 'fnm'),
    path.join(os.homedir(), 'Library', 'Application Support', 'fnm'),
  ].filter(Boolean) as string[];
  for (const root of roots) {
    try {
      const vers = fs.readdirSync(path.join(root, 'node-versions')).sort().reverse();
      return vers.map((v) => path.join(root, 'node-versions', v, 'installation', 'bin', name));
    } catch {
      /* not this root */
    }
  }
  return [];
}

/** Best-effort location of a globally-installed bin (`claude`, `oak`) — GUI apps and
 *  SSH-launched remote hosts often lack ~/.local/bin and the nvm/volta dirs on PATH. Shared by the
 *  CLI resolver below and the VS Code stats subprocess so the candidate list lives in exactly one place. */
export function resolveBin(name: string, opts: { configured?: string; env?: string } = {}): string {
  const home = os.homedir();
  const cands = [
    opts.configured,
    opts.env ? process.env[opts.env] : undefined,
    path.join(home, '.local', 'bin', name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    path.join(home, '.npm-global', 'bin', name),
    path.join(home, '.volta', 'bin', name),
    // The rest of the JS toolchain zoo. Every one of these is a real place a `-g` install lands, and
    // an editor launched from a Dock/Finder icon inherits none of them on PATH — which reads to the
    // user as "the update button does nothing", with no way to tell why.
    path.join(home, '.bun', 'bin', name),
    process.env.PNPM_HOME ? path.join(process.env.PNPM_HOME, name) : undefined,
    path.join(home, 'Library', 'pnpm', name), // pnpm's default PNPM_HOME on macOS
    path.join(home, '.local', 'share', 'pnpm', name), // …and on Linux
    path.join(home, '.asdf', 'shims', name),
    ...nvmBins(name),
    ...fnmBins(name),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', `${name}.cmd`) : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Volta', 'bin', `${name}.exe`) : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'pnpm', `${name}.cmd`) : undefined,
  ].filter(Boolean) as string[];
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return name; // fall back to PATH
}

/** Best-effort location of the `claude` binary. */
export function resolveClaudeBin(configured?: string): string {
  return resolveBin('claude', { configured, env: 'CLAUDE_BIN' });
}

/** Run `claude -p` with `prompt` on stdin; resolve stdout. Rejects on spawn error / non-zero / timeout.
 *  When `resumeSessionId` is set, resumes that session (`--resume`) so Claude reuses its already-cached
 *  context — cheaper and better-grounded than re-sending code. Store session ids ARE Claude session ids. */
export function runClaude(
  prompt: string,
  opts: { timeoutMs?: number; claudeBin?: string; resumeSessionId?: string } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['-p'];
    if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
    // Windows: npm installs `claude` as a .cmd shim, which needs cmd.exe — see core/spawn.
    const bin = opts.claudeBin || 'claude';
    const child = spawnTool(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('claude timed out'));
    }, opts.timeoutMs ?? 90000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    // A failed spawn (missing binary) also errors the stdin stream; without a handler that is an
    // UNHANDLED 'error' event that crashes the host process. The 'error'/'close' events on the
    // child itself carry the actionable failure, so stdin errors are safe to swallow.
    child.stdin.on('error', () => {});
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `claude exited with code ${code}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function blobText(sessionId: string, sha: string | null): string {
  return sha ? readBlob(sessionId, sha).toString('utf8') : '';
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** Try the cheap resume path first (Claude reuses its cached session context); on any failure —
 *  session locked / not resumable / older CLI — fall back to the self-contained prompt on a fresh run. */
async function runResumeOrFresh(
  resumePrompt: string,
  freshPrompt: string,
  sessionId: string,
  opts: { timeoutMs?: number; claudeBin?: string }
): Promise<string> {
  const { describeSession } = require('./session') as typeof import('./session');
  const d = describeSession(sessionId);
  if (/^codex(?:-acp)?$/.test(d.runtime)) {
    // This action is opt-in analysis. Keep the original runtime/provider and forbid edits during it.
    return new Promise((resolve, reject) => {
      const child = spawnTool('codex', ['exec', '--sandbox', 'read-only', 'resume', d.nativeSessionId, '--json', '-'],
        { cwd: d.cwd ?? process.cwd(), stdio: ['pipe','pipe','pipe'] });
      let raw = '', err = '';
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Codex analysis timed out')); }, opts.timeoutMs ?? 90000);
      child.stdout.on('data', (b) => { raw += b.toString(); }); child.stderr.on('data', (b) => { err = (err+b.toString()).slice(-16000); });
      child.stdin.on('error', () => {});
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(err || `Codex analysis exited ${code}`));
        const replies: string[] = [];
        for (const line of raw.split('\n')) { try { const e = JSON.parse(line); if (e.type === 'item.completed' && e.item?.type === 'agent_message') replies.push(e.item.text); } catch {} }
        if (!replies.length) return reject(new Error('Codex completed without a readable analysis response'));
        resolve(replies.join('\n\n'));
      });
      child.stdin.end(resumePrompt);
    });
  }
  if (!/^claude(?:-acp)?$/.test(d.runtime)) throw new Error(`Analysis is unavailable for ${d.runtime}; continue with that agent in Observatory.`);
  try {
    return await runClaude(resumePrompt, { ...opts, resumeSessionId: sessionId });
  } catch {
    return runClaude(freshPrompt, opts);
  }
}

/** Deep-analyze one edit (summary / issues / suggestions) via claude -p; caches the markdown.
 *  Prefers resuming the session so Claude already has the file + its own reasoning in context. */
export async function analyzeEdit(
  sessionId: string,
  id: number,
  opts: { timeoutMs?: number; claudeBin?: string; reasoning?: string } = {}
): Promise<Analysis> {
  const rec = findRecord(sessionId, id);
  if (!rec) throw new Error(`no edit #${id}`);
  const base = path.basename(rec.file);
  const seed = opts.reasoning ? `\n\nWhat you said at the time: "${clip(opts.reasoning, 500)}"` : '';
  const ask =
    `Reply in brief markdown: **Summary** (one sentence), **Potential issues** (bullets or "none"), ` +
    `**Suggestions** (bullets or "none"). Be concise.`;
  // Cheap: resume — no need to re-send the code, Claude still has it cached.
  const resumePrompt = `Review edit #${id} you made this session to \`${base}\` (${rec.tool}).${seed}\n\n${ask}`;
  // Fallback: self-contained (fresh claude, blobs pasted in).
  const before = rec.beforeBlob ? blobText(sessionId, rec.beforeBlob) : '(new file)';
  const after = rec.afterBlob ? blobText(sessionId, rec.afterBlob) : '(deleted)';
  const freshPrompt =
    `Review ONE code change Claude Code made to \`${base}\`.${seed}\n\n` +
    `BEFORE:\n\`\`\`\n${before}\n\`\`\`\n\nAFTER:\n\`\`\`\n${after}\n\`\`\`\n\n${ask}`;
  const text = await runResumeOrFresh(resumePrompt, freshPrompt, sessionId, opts);
  const a: Analysis = { kind: 'edit', key: `edit-${id}`, text, ts: Date.now() };
  save(sessionId, a);
  return a;
}

/** Generate session-level next-steps + code suggestions via claude -p; caches the markdown.
 *  Prefers resuming the session (Claude already knows every edit it made) over re-sending a digest. */
export async function analyzeSuggestions(
  sessionId: string,
  opts: { timeoutMs?: number; claudeBin?: string } = {}
): Promise<Analysis> {
  const ask =
    `In brief markdown, give **Next steps** (bullets) and **Code suggestions** (bullets) — concrete, ` +
    `high-value follow-ups a reviewer should consider. Be concise.`;
  const resumePrompt = `Based on the edits you made in this session, ${ask[0].toLowerCase()}${ask.slice(1)}`;
  const digest = readLog(sessionId)
    .map((r) => {
      const sample = blobText(sessionId, r.afterBlob).split('\n').slice(0, 40).join('\n');
      return `### ${summarize(sessionId, r)} [${r.status}]\n\`\`\`\n${sample}\n\`\`\``;
    })
    .join('\n\n')
    .slice(0, 20000); // bound the fallback prompt
  const freshPrompt = `Here are the changes Claude Code made in this session:\n\n${digest}\n\n${ask}`;
  const text = await runResumeOrFresh(resumePrompt, freshPrompt, sessionId, opts);
  const a: Analysis = { kind: 'suggestions', key: 'suggestions', text, ts: Date.now() };
  save(sessionId, a);
  return a;
}

/** A one-line "what was I working on & where did I leave off" recap; prefers resume (cached context). */
export async function analyzeRecap(
  sessionId: string,
  opts: { timeoutMs?: number; claudeBin?: string } = {}
): Promise<Analysis> {
  const ask =
    'In ONE sentence, what was I working on in this session and where did I leave off? ' +
    'Reply with ONLY that sentence — no preamble, no quotes, no markdown.';
  const digest = readLog(sessionId)
    .map((r) => summarize(sessionId, r))
    .join('; ')
    .slice(0, 4000);
  const freshPrompt = `Here are the file changes made in a coding session:\n${digest}\n\n${ask}`;
  const raw = await runResumeOrFresh(ask, freshPrompt, sessionId, opts);
  const text = raw.trim().replace(/^["'`]|["'`]$/g, ''); // strip any wrapping quotes
  const a: Analysis = { kind: 'recap', key: 'recap', text, ts: Date.now() };
  save(sessionId, a);
  return a;
}
