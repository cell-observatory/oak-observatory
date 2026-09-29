/** Capture persists pane links; Codex also reports immediately, without an Observatory watcher. */
import * as fs from 'fs';
import * as path from 'path';
import { storeDir } from './store';
import type { HerdrOptions, HerdrTransport } from './herdr';
import { spawnTool, spawnToolSync } from './spawn';
import { oakCliEntry } from './cli-entry';

export interface HerdrPaneLink { paneId: string; socketPath?: string; at: number; reported?: boolean; sessionStartSource?: string }

export function readHerdrPaneLink(session: string): HerdrPaneLink | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(storeDir(session), 'herdr.json'), 'utf8'));
    return typeof value.paneId === 'string' && value.paneId && typeof value.at === 'number'
      ? { paneId: value.paneId, at: value.at, ...(typeof value.socketPath === 'string' ? { socketPath: value.socketPath } : {}), ...(value.reported === true ? { reported: true } : {}), ...(typeof value.sessionStartSource === 'string' ? { sessionStartSource: value.sessionStartSource } : {}) }
      : null;
  } catch { return null; }
}

/** Called by linkTab for both Claude hooks and Codex ingestion, even without OAK_TAB. */
export function linkHerdrPane(session: string, kind?: 'codex', sessionStartSource?: string): void {
  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) return;
  const socketPath = process.env.HERDR_SOCKET_PATH;
  try {
    const previous = readHerdrPaneLink(session);
    const same = previous?.paneId === paneId && previous.socketPath === socketPath;
    const link: HerdrPaneLink = same ? previous : { paneId, socketPath, at: Date.now() };
    if (kind === 'codex' && sessionStartSource) link.sessionStartSource = sessionStartSource;
    const save = () => {
      fs.mkdirSync(storeDir(session), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(storeDir(session), 'herdr.json'), JSON.stringify(link), { mode: 0o600 });
    };
    if (!same || sessionStartSource) save();
    // A nested Codex can inherit the parent pane; it must not replace the pane's root identity.
    const inherited = process.env.CODEX_THREAD_ID;
    if (kind === 'codex' && (!inherited || inherited === session) && (!link.reported || sessionStartSource)) {
      const reported = reportHerdrSessionSync(session, kind, link);
      if (reported !== Boolean(link.reported)) {
        if (reported) link.reported = true;
        else delete link.reported;
        save();
      }
    }
  } catch { /* A missing convenience link must never fail capture. */ }
}

/** The least time between two tab syncs one session's hooks start: two turn boundaries a moment apart
 *  (a Stop and a queued prompt, a resume and its first prompt) start one. */
export const TAB_SYNC_KICK_MS = 5000;

/**
 * Start `oak __tab-sync <session>` detached, so the herdr tab that holds this session's pane follows the
 * session's title while the terminal app is closed (herdr-tabs.ts `syncSessionTab`). The capture hooks
 * call it at turn boundaries. Only inside herdr, at most once per TAB_SYNC_KICK_MS per session, and only
 * through the oak CLI entry the running bundle registered (cli-entry.ts): a process with none starts
 * nothing. Never blocks, never throws, never writes to stdout: the child's stdio is ignored.
 */
export function kickTabSync(session: string, cli: string | undefined = oakCliEntry()): void {
  if (!process.env.HERDR_PANE_ID || !cli) return;
  try {
    const marker = path.join(storeDir(session), 'herdr-tab.kick');
    // Within the window on either side of now: a file time can read a fraction of a millisecond past
    // Date.now(), which truncates. One further ahead (the clock was set back) throttles nothing.
    try { if (Math.abs(Date.now() - fs.statSync(marker).mtimeMs) < TAB_SYNC_KICK_MS) return; } catch { /* never kicked */ }
    fs.mkdirSync(storeDir(session), { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, '', { mode: 0o600 });
    const child = spawnTool(process.execPath, [cli, '__tab-sync', session], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => { /* the tab keeps its name until the next boundary */ });
    child.unref();
  } catch { /* A tab name is a convenience: it must never fail capture. */ }
}

/** The capture CLI calls process.exit(0) immediately, so an unawaited socket promise is lost.
 * Use herdr's native CLI for the same pane.report_agent_session request and wait at most 500 ms.
 * No shell or stdout, no server startup, no Python dependency. A failure is retried by the next
 * Codex hook; successful links are reused until SessionStart or a pane/socket move. */
export function reportHerdrSessionSync(session: string, kind: string, link: HerdrPaneLink): boolean {
  if (!link.socketPath) return false;
  try {
    // Required here, not at the top: every capture hook loads this module, and only a Codex hook in a
    // herdr pane gets this far. The installer module brings smol-toml and codex-hook-trust with it.
    const binary = process.env.HERDR_BIN_PATH || (require('./herdr-install') as typeof import('./herdr-install')).findHerdrBin();
    if (!binary) return false;
    const result = spawnToolSync(binary, [
      'pane', 'report-agent-session', link.paneId,
      '--source', `herdr:${kind}`, '--agent', kind, '--agent-session-id', session,
      // Native hooks use time.time_ns(). Unsequenced reports are ignored once herdr saw a sequence.
      '--seq', String(BigInt(Date.now()) * 1_000_000n),
      // herdr requires startup/resume/etc. to replace a previous Codex session in this pane.
      ...(link.sessionStartSource ? ['--session-start-source', link.sessionStartSource] : []),
    ], { env: { ...process.env, HERDR_SOCKET_PATH: link.socketPath }, stdio: 'ignore', timeout: 500, killSignal: 'SIGKILL', direct: true });
    return result.status === 0 && !result.error;
  } catch { return false; }
}

/** herdr ignores identity reports from other sources, including "oak". `transport`: the caller's own
 *  (see HerdrTransport), so an injected core is never bypassed. */
export function reportHerdrSession(session: string, kind: string, link: HerdrPaneLink, opts: HerdrOptions = {},
  { herdrRequest }: Pick<HerdrTransport, 'herdrRequest'> = require('./herdr') as typeof import('./herdr')): Promise<unknown> {
  return herdrRequest('pane.report_agent_session', {
    pane_id: link.paneId, agent: kind, agent_session_id: session, source: `herdr:${kind}`,
  }, { ...opts, ...(link.socketPath ? { socketPath: link.socketPath } : {}) });
}
