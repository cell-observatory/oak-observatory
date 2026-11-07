/**
 * The capture hooks' half of a delegated agent's link to its session (delegated.ts): kept apart, with nothing but the
 * store's paths, so the hook bundle carries none of what lists and derives the agents (the index, herdr, the CLIs).
 */
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { rootDir, isSafeSessionId } from './store';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const isDelegatedId = (id: unknown): id is string => typeof id === 'string' && ID.test(id) && !id.includes('..');

export function delegatedDir(): string {
  return path.join(rootDir(), 'delegated');
}

/** Where the first session that runs with `OAK_DELEGATED=<id>` names the agent's session. */
export const delegatedSessionPath = (id: string): string => path.join(delegatedDir(), `${id}.session`);

/** The first session that runs with `OAK_DELEGATED` set names the agent's session. Publish the complete file with an
 *  exclusive link: a killed hook leaves only a temporary file, never an empty link that blocks every later hook.
 *  A nested agent run inside the session inherits the variable and finds the link taken. Never throws. */
export function linkDelegated(session: string, env: NodeJS.ProcessEnv = process.env): void {
  const id = env.OAK_DELEGATED;
  if (!isDelegatedId(id) || !isSafeSessionId(session)) return;
  const file = delegatedSessionPath(id);
  if (fs.existsSync(file)) return;
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, session, { flag: 'wx', mode: 0o600 });
    fs.linkSync(tmp, file);
  } catch {
    /* taken, or no such agent here */
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* not written */ }
  }
}
