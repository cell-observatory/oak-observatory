/**
 * Capture entrypoint for the hooks: `oak capture` (Claude Code) and `oak capture --agent codex`.
 *
 * Kept as its OWN esbuild bundle, which dist/index.js loads for `capture` (see launch.ts), so a hook
 * never compiles the full CLI: this holds the core capture modules and what they import, not the
 * review/undo engine or the terminal app. Emits nothing to stdout and always exits 0.
 */
import * as path from 'path';
import { setOakCliEntry } from '@oak-observatory/core/dist/cli-entry';
import { runCapture } from '@oak-observatory/core/dist/capture';
import { runCodexCapture } from '@oak-observatory/core/dist/codex';

// The full CLI beside this bundle: a hook at a turn boundary starts it detached to rename its session's
// herdr tab (core kickTabSync).
setOakCliEntry(path.join(__dirname, 'cli.js'));
const args = process.argv.slice(2);
if (args.includes('--agent') && args[args.indexOf('--agent') + 1] === 'codex') runCodexCapture();
else runCapture();
process.exit(0);
