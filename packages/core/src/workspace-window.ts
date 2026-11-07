import * as fs from 'fs';
import * as path from 'path';

/** Only the owning machine can check a workspace; a display label is never a pathname. */
export function workspaceDirectoryExists(folder: string | null | undefined): boolean | undefined {
  if (!folder || !path.isAbsolute(folder)) return undefined;
  try { return fs.statSync(folder).isDirectory(); } catch { return false; }
}

