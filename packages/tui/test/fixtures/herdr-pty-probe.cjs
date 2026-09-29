const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Terminal } = require('@xterm/headless');
const core = require('../../../core/dist');

module.exports = async function probe(t, fixture = false) {
  const skip = why => {
    const message = `${fixture ? 'PTY FIXTURE' : 'LIVE HERDR'} NOT VERIFIED: ${why}`;
    console.error(message); t.skip(message);
  };
  let pty;
  try { pty = require('node-pty'); }
  catch (error) { if (error.code === 'MODULE_NOT_FOUND') return skip('node-pty is unavailable'); throw error; }
  if (!fixture) {
    if (!core.findHerdrBin()) return skip('no herdr binary installed');
    // Refuse to start a new server for a test. Only known missing/forbidden prerequisites skip;
    // protocol errors and failed UI assertions must stay failures.
    try { await core.herdrSnapshot({ timeoutMs: 1000 }); }
    catch (error) {
      if (['ENOENT', 'ECONNREFUSED', 'EPERM', 'EACCES', 'server_not_running'].includes(error.code)) {
        return skip(`existing server unavailable (${error.code}); host keyboard push, cmd+w, sidebar and prefix were not exercised`);
      }
      throw error;
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-herdr-pty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', NO_COLOR: '1',
    CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), CODEX_HOME: path.join(dir, 'codex'),
    OAK_NO_SERVER: '1', CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1', TMUX: '' };
  if (fixture) {
    if (process.platform === 'win32') return skip('the executable fixture requires a POSIX shebang');
    fs.writeFileSync(path.join(dir, 'herdr'), `#!${process.execPath}\n` + fs.readFileSync(path.join(__dirname, 'herdr-terminal.cjs'), 'utf8'), { mode: 0o755 });
    Object.assign(env, { HOME: dir, USERPROFILE: dir, PATH: dir + path.delimiter + env.PATH,
      XDG_CONFIG_HOME: path.join(dir, 'config'), HERDR_SOCKET_PATH: path.join(dir, 'absent.sock') });
  }
  const cli = path.resolve(__dirname, '../../../cli/dist/index.js');
  assert.ok(fs.existsSync(cli), 'build the CLI before running the PTY probe');
  const term = new Terminal({ cols: 120, rows: 36, allowProposedApi: true });
  const child = pty.spawn(process.execPath, [cli, 'tui', '--tab', 'herdr', '--no-server'], {
    cols: 120, rows: 36, name: 'xterm-256color', cwd: dir, env,
  });
  let exited = false;
  const closed = new Promise(resolve => child.onExit(() => { exited = true; resolve(); }));
  t.after(async () => {
    if (!exited) child.kill();
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 1000))]);
    term.dispose();
  });
  let hostOutput = '';
  child.onData(data => { hostOutput += data; term.write(data); });
  const screen = () => Array.from({ length: 36 }, (_, row) => term.buffer.active.getLine(row)?.translateToString(true) || '');
  const until = async (predicate, description) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      if (predicate(screen())) return;
      assert.ok(!exited, `CLI exited while waiting for ${description}`);
    }
    assert.fail(`Timed out waiting for ${description}\n${screen().join('\n')}`);
  };
  // Machine rows are bold disclosure labels in herdr's endpoint sidebar. Read the name and
  // coordinates from the screen; never bake the runner's saved hostnames into a test.
  const machineRows = rows => rows.slice(1, 28).flatMap((line, i) => {
    const sidebar = line.slice(0, 38);
    const match = /^\s*[│|]?\s*[▸▾]\s+(.+?)(?:\s{2,}.*)?$/.exec(sidebar.trimEnd());
    return match ? [{ row: i + 2, col: sidebar.search(/[▸▾]/) + 1, label: match[1], marker: sidebar.match(/[▸▾]/)[0] }] : [];
  });
  const workspaceRows = rows => rows.slice(1, 28).flatMap((line, i) => {
    const match = /^\s*[│|]?\s*(\d+)\s+\S/.exec(line.slice(0, 38));
    return match ? [{ row: i + 2, col: match[0].length, label: line.slice(0, 38).trim() }] : [];
  });
  // The local machine's disclosure row paints at once; a SAVED machine's row appears only after herdr's
  // ssh check answers, so wait for the row the click needs — a remote machine or a workspace — not for
  // the first sidebar paint. A cockpit that never shows one (no saved machine, or its host unreachable)
  // cannot exercise selection: say so and skip, rather than fail on the network.
  const pickTarget = rows => machineRows(rows).find(row => !/^local\b/i.test(row.label)) || workspaceRows(rows)[0];
  await until(rows => machineRows(rows).length || workspaceRows(rows).length, 'herdr cockpit sidebar');
  assert.match(hostOutput, /\x1b\[>\d+u/, 'herdr keyboard push must reach the host terminal');
  t.diagnostic('host stdout carried herdr keyboard push');
  child.write('\x1b[119;9u');
  if (fixture) {
    await until(rows => rows.some(line => line.includes('super+w reached herdr fixture verbatim')), 'super+w bytes echoed by the child');
  } else {
    t.diagnostic('LIVE HERDR cmd+w action NOT VERIFIED: receipt is asserted by the fixture; the existing server configuration is untouched');
  }
  // A MISSING prerequisite skips; a dead product does not. This is the widest window in the probe, so
  // a crash of the CLI under test landed in it and came back as "no saved machine" — green, and with
  // the blame on the environment. `until` already asserts the child is alive, so honour that verdict.
  try { await until(rows => pickTarget(rows), 'a saved machine or workspace row in the sidebar'); }
  catch (error) {
    if (exited) throw error;
    return t.skip(`${fixture ? 'PTY FIXTURE' : 'LIVE HERDR'} PTY NOT VERIFIED: ${String(error.message).split('\n')[0]}`);
  }
  const before = screen();
  const target = pickTarget(before);
  assert.ok(target, 'the cockpit needs a saved machine or a workspace to exercise selection');
  const sidebar = () => screen().slice(3, 28).map(line => line.slice(0, 38)).join('\n');
  // A selection may change only styling, so compare cell colours as well as the sidebar text.
  const style = () => {
    const line = term.buffer.active.getLine(target.row - 1);
    return Array.from({ length: 38 }, (_, col) => {
      const cell = line.getCell(col);
      return [cell.getFgColor(), cell.getBgColor(), cell.isInverse(), cell.isBold()];
    });
  };
  const priorStyle = JSON.stringify(style());
  child.write(`\x1b[<0;${target.col};${target.row}M\x1b[<0;${target.col};${target.row}m`);
  await until(rows => target.marker
    ? rows[target.row - 1]?.includes(target.marker === '▸' ? '▾' : '▸') && rows[target.row - 1]?.includes(target.label)
    : JSON.stringify(style()) !== priorStyle, 'the clicked sidebar row to change after its SGR click');
  t.diagnostic(`clicked ${target.marker ? 'machine' : 'workspace'} row ${target.row}; sidebar changed`);
  if (fixture) {
    assert.match(sidebar(), /fixture-workspace/);
    child.write('?');
    await until(rows => rows.some(line => line.includes('question mark reached herdr fixture')), 'literal question mark in the child');
    child.write('\x02?');
    await until(rows => rows.some(line => line.includes('herdr fixture bindings')), 'ctrl+b sequence in the child');
  } else {
    child.write('\x02?');
    await until(rows => rows.slice(1, 29).some(line => /keybinds/i.test(line)), 'herdr keybinding help from ctrl+b ?');
    child.write('\x1b');
  }
  let offset = hostOutput.length;
  child.write('\x1b[97;5u\x1b[97;5:3u\x1b[110;1u');
  await until(rows => /\[\s*observatory\s*\]/.test(rows[0]), 'CSI-u ctrl+a n to leave herdr');
  assert.match(hostOutput.slice(offset), /\x1b\[<\d+u/, 'leaving pops the child keyboard stack');
  offset = hostOutput.length;
  child.write('\x01' + '1');
  await until(rows => /\[\s*herdr\s*\]/.test(rows[0]), 'return to herdr');
  assert.match(hostOutput.slice(offset), /\x1b\[>\d+u/, 'returning re-pushes child flags');
  offset = hostOutput.length;
  const quit = fixture === 'leader-quit' ? '\x1b[97;5u\x1b[113u' : '\x1b[113;5u';
  child.write(quit + '\x1b[113;5:3u');
  await until(rows => rows.some(line => /again to exit/.test(line)), 'first quit confirmation; release does not confirm it');
  assert.doesNotMatch(hostOutput.slice(offset), /\x1b\[<\d+u/, 'first quit keeps the live tab modes');
  child.write(quit);
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(Error('CLI did not quit')), 3000))]);
  assert.match(hostOutput.slice(offset), /\x1b\[<\d+u/, 'quitting pops child flags');
  t.diagnostic('built CLI at 120x36: host push, verbatim super+w, CSI-u leader, pop/re-push and quit cleanup passed');
};
