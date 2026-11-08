// A fake herdr client that draws one screen and draws the SAME screen again every 300 ms, as a live client
// redraws whether or not anything moved. Each redraw is a native-tab update the app paints for.
if (process.argv.length > 2) { process.stdout.write('herdr 0.9.1\n'); process.exit(0); }
process.stdin.setRawMode(true); process.stdin.resume();
const screen = () => '\x1b[2J\x1b[H\x1b[1mHERDR PANE READY\x1b[0m\r\nsecond line\x1b[3;5H';
process.stdout.write('\x1b[?1049h' + screen());
setInterval(() => process.stdout.write(screen()), 300);
process.on('SIGHUP', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
