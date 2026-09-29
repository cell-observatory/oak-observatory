// Preloaded (`node --require`) into the app probe: records every child process the run starts to the
// JSONL file named by OAK_SPAWN_LOG, synchronously, as each call is made. A `titles --refresh` launch is
// recorded and never started, so a run that would relaunch itself cannot start a chain even while it
// fails. OAK_REGISTER_CLI_ENTRY registers an oak CLI entry the way the CLI does at startup.
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const log = process.env.OAK_SPAWN_LOG;
for (const kind of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync']) {
  const original = cp[kind];
  cp[kind] = function (file, args, options) {
    const argv = Array.isArray(args) ? args.map(String) : [];
    const opts = (Array.isArray(args) ? options : args) || {};
    if (log) fs.appendFileSync(log, JSON.stringify({ pid: process.pid, check: process.env.OAK_APP_FIX_CHECK || '', kind, file: String(file), args: argv, detached: !!opts.detached }) + '\n');
    if (argv.includes('titles') && argv.includes('--refresh')) {
      if (kind.endsWith('Sync')) return { pid: 0, status: 0, signal: null, stdout: '', stderr: '', output: [] };
      const child = new EventEmitter();
      Object.assign(child, { pid: 0, unref() {}, ref() {}, kill() { return true; } });
      return child;
    }
    return original.apply(this, arguments);
  };
}
if (process.env.OAK_REGISTER_CLI_ENTRY) {
  const core = require(path.resolve(__dirname, '../../../core/dist'));
  core.setOakCliEntry?.(process.env.OAK_REGISTER_CLI_ENTRY);
}
