// A fake herdr client with a real shell pane, ringing through printf on a timer.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
if (process.argv.length > 2) { process.stdout.write('herdr 0.9.1\n'); process.exit(0); }
process.stdin.setRawMode(true); process.stdin.resume();
process.stdout.write('\x1b[?1049h\x1b[2J\x1b[HHERDR PANE READY');
const pane = cp.spawn('/bin/sh', ['-c', 'while :; do printf "\\a"; sleep 0.2; done'], { stdio: ['ignore', 'pipe', 'ignore'] });
pane.stdout.on('data', bytes => {
  fs.appendFileSync(path.join(process.env.OAK_FLASH_DIR, 'pane.jsonl'), JSON.stringify({ at: Date.now(), hex: bytes.toString('hex') }) + '\n');
  process.stdout.write(bytes);
  // Split OSC and DCS strings test the recorder and emulator across real writes.
  process.stdout.write('\x1b]2;PANE TITLE');
  setTimeout(() => process.stdout.write('\x07\x1bPignored\x07\x1b\\'), 10);
});
process.on('exit', () => pane.kill());
process.on('SIGHUP', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
