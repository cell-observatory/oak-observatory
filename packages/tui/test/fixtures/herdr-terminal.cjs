// Socket-free child for the real CLI -> node-pty -> xterm input regression. It is deliberately
// labelled as a fixture: the separate live probe is the proof against the installed herdr client.
if (process.argv.length > 2) {
  process.stdout.write('[]\n');
  process.exit(0);
}
process.stdin.setRawMode(true);
process.stdout.write('\x1b[>31u');
let selected = false, note = '', input = '';
function paint() {
  const rows = ['herdr fixture cockpit', '', '', '', '',
    `  ${selected ? '▾' : '▸'} fixture-machine`, selected ? '    1 fixture-workspace' : '', '', note];
  process.stdout.write('\x1b[?1003h\x1b[?1006h\x1b[2J\x1b[H' + rows.join('\r\n'));
}
process.stdin.on('data', chunk => {
  input += chunk.toString();
  if (input.includes('\x1b[119;9u')) { note = 'super+w reached herdr fixture verbatim'; input = ''; }
  else if (input.includes('\x02?')) { note = 'herdr fixture bindings'; input = ''; }
  else if (input === '?') { note = 'question mark reached herdr fixture'; input = ''; }
  else if (input === '\x1b') { note = ''; input = ''; }
  input = input.replace(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g, (_raw, button, col, row, end) => {
    if (button === '0' && Number(col) <= 30 && row === '6' && end === 'M') selected = !selected;
    return '';
  });
  paint();
});
paint();
