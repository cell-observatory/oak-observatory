import * as fs from 'fs';
import * as path from 'path';
/** Display label for a transcript or herdr agent kind. */
export function agentKindLabel(kind: string): string {
  return (kind || 'claude').toLowerCase().replace(/-acp$/, '') || 'claude';
}

/** Supported native CLIs present on PATH. */
export function detectInstalledAgents(): { id: string; name: string; command: string }[] {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  return ['claude', 'codex'].filter(command => dirs.some(dir => exts.some(ext => fs.existsSync(path.join(dir, command + ext)))))
    .map(command => ({ id: command, name: command, command }));
}
