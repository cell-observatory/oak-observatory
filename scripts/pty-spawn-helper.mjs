// The checkout's `postinstall` (npm ci / npm install): make node-pty's spawn-helper executable.
// node-pty 1.1.0 ships its macOS prebuilds with spawn-helper at mode 0644 and never sets the bit, so on
// a Mac every PTY spawn from a fresh clone failed with `posix_spawnp failed` — OAK's herdr tab, and the
// PTY tests on the first macOS CI run (2026-09-27). An installed OAK gets the same repair from
// `oak doctor --fix`, which the installers and `oak update` run. Never fails the install.
import { chmodSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

let dir = null;
try { dir = dirname(createRequire(import.meta.url).resolve('node-pty/package.json')); } catch { /* optional: not installed here */ }
// The directories node-pty loads its binding from, as `oak doctor --fix` walks them.
for (const sub of dir ? ['build/Release', 'build/Debug', `prebuilds/${process.platform}-${process.arch}`] : []) {
  const helper = join(dir, sub, 'spawn-helper');
  let stat;
  try { stat = statSync(helper); } catch { continue; } // Windows has no helper; Linux builds one executable
  if (!stat.isFile() || (stat.mode & 0o111) === 0o111) continue;
  try { chmodSync(helper, (stat.mode & 0o777) | 0o111); }
  catch (error) { console.warn(`could not make ${helper} executable (${error.code ?? error}); PTY spawns fail until it is: chmod +x it`); }
}
