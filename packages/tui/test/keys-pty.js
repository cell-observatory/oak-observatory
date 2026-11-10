// Every key the terminal app claims, pressed in a REAL terminal: the built CLI under node-pty, its
// output parsed by @xterm/headless, over a store the real capture hook wrote. One row per key, each in a
// fresh app over its own copy of that store, asserting what the key did: a state change on screen, a
// spawned command (a fake editor and a fake herdr client record what reached them), a store change
// (`oak list --json`) or a status line.
// The last test holds the `?` help to this table: every key it lists has a row here, and every row that
// works is listed there.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const REPO = path.resolve(__dirname, '../../..');
const CLI = path.join(REPO, 'packages/cli/dist/index.js');
const CAPTURE = path.join(REPO, 'packages/cli/dist/capture.js');
let pty = null, Terminal = null;
try { pty = require('node-pty'); ({ Terminal } = require('@xterm/headless')); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const skip = process.platform === 'win32' ? 'the fake editors and herdr client are POSIX scripts' : !pty ? 'node-pty is unavailable' : false;

const E = '\x1b';
const K = { up: E + '[A', down: E + '[B', right: E + '[C', left: E + '[D', pgdn: E + '[6~', pgup: E + '[5~', end: E + '[F',
  f1: E + 'OP', f2: E + 'OQ', f3: E + 'OR', f4: E + 'OS', f5: E + '[15~', f6: E + '[17~', f7: E + '[18~', f8: E + '[19~', tab: '\t', btab: E + '[Z', enter: '\r', esc: E,
  ctrl: (c) => String.fromCharCode(c.toUpperCase().charCodeAt(0) - 64), alt: (c) => E + c };

/** A workspace with two captured edits (#1 in a.ts, #2 in b.ts), and a PATH holding a GUI editor
 *  (`code`), a terminal one (`fakevi`) and a herdr client, each of which records what reached it.
 *  The capture hooks run once, into a template; each row gets its own copy (`fixture`). */
function build(dir) {
  const home = path.join(dir, 'h'), ws = path.join(dir, 'ws'), bin = path.join(dir, 'bin');
  for (const d of [home, ws, bin]) fs.mkdirSync(d, { recursive: true });
  const env = { ...process.env, TERM: 'xterm-256color', HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'), XDG_CONFIG_HOME: path.join(home, '.config'), HERDR_SOCKET_PATH: path.join(dir, 'no.sock'),
    OAK_NO_SERVER: '1', OAK_NO_BACKGROUND: '1', CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1', OAK_MACHINE_LABEL: 'workstation',
    PATH: bin + path.delimiter + process.env.PATH, EDITOR: 'code' };
  // TERM_PROGRAM and the editor markers beside it name the editor whose integrated terminal this is, which W opens
  // when nothing names a GUI editor (core.integratedTerminalEditor): a row sets them, the terminal it runs in does not.
  for (const k of ['TERM_PROGRAM', 'CURSOR_TRACE_ID', 'WINDSURF_TRACE_ID', 'VSCODE_GIT_ASKPASS_MAIN', 'VISUAL', 'TMUX', 'NO_COLOR', 'SSH_CONNECTION', 'SSH_TTY', 'WSL_DISTRO_NAME', 'WSLENV', 'HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_ENV', 'HERDR_BIN_PATH', 'HERDR_SESSION']) delete env[k];
  fs.mkdirSync(path.join(home, '.claude/claude-observatory'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/claude-observatory/agent-setup-suggested'), '1\n');
  const session = 'keysSess';
  const projects = path.join(home, '.claude/projects', ws.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, `${session}.jsonl`), '');
  const hook = (event, file) => cp.execFileSync(process.execPath, [CAPTURE], { env,
    input: JSON.stringify({ session_id: session, cwd: ws, hook_event_name: event, tool_name: 'Edit', tool_input: { file_path: file } }) });
  for (const name of ['a.ts', 'b.ts']) {
    const f = path.join(ws, name);
    fs.writeFileSync(f, 'one\ntwo\nthree\n');
    hook('PreToolUse', f); fs.writeFileSync(f, 'one\nTWO\nthree\n'); hook('PostToolUse', f);
  }
  const edLog = path.join(dir, 'editor.log'), herdrLog = path.join(dir, 'herdr.log');
  for (const name of ['code', 'fakevi']) {
    fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(edLog)}, JSON.stringify([${JSON.stringify(name)}, ...process.argv.slice(2)]) + '\\n');\n`, { mode: 0o755 });
  }
  // A terminal editor that waits on the terminal in its cooked mode, where ctrl+c signals the whole job.
  fs.writeFileSync(path.join(bin, 'fakeread'), '#!/bin/sh\nprintf "FAKEREAD WAITING"\nread line\n', { mode: 0o755 });
  // The clipboard tools ^V reads, on either platform: each answers `zz`.
  for (const name of ['wl-paste', 'xclip', 'pbpaste']) fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\nprocess.stdout.write('zz');\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'herdr'), `#!${process.execPath}\n` + [
    // A slow version probe blocks the first herdr paint; delaying the client's output does not.
    "if (process.argv[2] === '--version' && process.env.FAKE_HERDR_VERSION_DELAY) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_HERDR_VERSION_DELAY));",
    // A row's FAKE_HERDR_VERSION is the version this client reports; otherwise it answers no version at all.
    "if (process.argv[2] === '--version' && process.env.FAKE_HERDR_VERSION) { process.stdout.write(`herdr ${process.env.FAKE_HERDR_VERSION}\\n`); process.exit(0); }",
    "if (process.argv.length > 2) { process.stdout.write('[]\\n'); process.exit(0); }",
    "process.stdout.write('FAKE HERDR CLIENT');",
    `process.stdin.setRawMode(true); process.stdin.on('data', d => require('fs').appendFileSync(${JSON.stringify(herdrLog)}, d.toString('hex') + '\\n'));`,
    'setInterval(() => {}, 1000);',
  ].join('\n') + '\n', { mode: 0o755 });
  return { dir, home, ws, env, session, edLog, herdrLog };
}

let template = null;
/** A fresh copy of the template. Every path in it names the template's folder, as `oak-keys-XXXXXX`
 *  (in a file, or in the Claude projects folder's name that encodes the workspace), and a row's folder
 *  differs only in those six characters: each copy renames them in names and contents, and keeps times. */
function fixture() {
  const fresh = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oak-keys-')));
  if (!template) {
    template = build(fresh());
    process.on('exit', () => fs.rmSync(template.dir, { recursive: true, force: true }));
  }
  const dir = fresh(), from = path.basename(template.dir), to = path.basename(dir);
  assert.equal(from.length, to.length);
  const copy = (src, dst) => {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const a = path.join(src, entry.name), b = path.join(dst, entry.name.split(from).join(to));
      if (entry.isDirectory()) { fs.mkdirSync(b); copy(a, b); }
      else fs.writeFileSync(b, fs.readFileSync(a, 'utf8').split(from).join(to), { mode: fs.statSync(a).mode });
      const st = fs.statSync(a); fs.utimesSync(b, st.atime, st.mtime);
    }
  };
  copy(template.dir, dir);
  const swap = (v) => (typeof v === 'string' ? v.split(template.dir).join(dir) : v);
  return { ...Object.fromEntries(Object.entries(template).map(([k, v]) => [k, swap(v)])), dir,
    env: Object.fromEntries(Object.entries(template.env).map(([k, v]) => [k, swap(v)])) };
}

/** Run one row: start the app on its tab, press its keys, and check what happened. */
async function drive(row) {
  const fx = fixture();
  // A 120x36 terminal, or the row's own size.
  const COLS = row.cols ?? 120, ROWS = row.rows ?? 36;
  if (row.prefs) {
    fs.mkdirSync(path.join(fx.home, '.claude/claude-observatory'), { recursive: true });
    fs.writeFileSync(path.join(fx.home, '.claude/claude-observatory/prefs.json'), JSON.stringify(row.prefs));
  }
  if (row.herdrConfig !== undefined) {
    fs.mkdirSync(path.join(fx.home, '.config/herdr'), { recursive: true });
    fs.writeFileSync(path.join(fx.home, '.config/herdr/config.toml'), row.herdrConfig);
  }
  row.prep?.(fx);
  const env = { ...fx.env, ...row.env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  const child = pty.spawn(process.execPath, [CLI, 'tui', '--session', fx.session, '--root', fx.ws, '--tab', row.tab ?? 'review'],
    { cols: COLS, rows: ROWS, cwd: fx.ws, env, name: 'xterm-256color' });
  let raw = '', last = Date.now(), exited = false;
  child.onData((d) => { raw += d; last = Date.now(); term.write(d); });
  child.onExit(() => { exited = true; });
  const flush = () => new Promise((resolve) => term.write('', resolve));
  const lines = () => { const b = term.buffer.active; return Array.from({ length: ROWS }, (_, y) => b.getLine(b.baseY + y)?.translateToString(true) ?? ''); };
  // Quiet for `ms` after the last key or output. Work may still be running; rows can wait for `done`.
  const settle = async (ms) => { last = Math.max(last, Date.now()); const until = Date.now() + 5000; while (Date.now() - last < ms && Date.now() < until) await new Promise((r) => setTimeout(r, 30)); await flush(); };
  // A verb still running says so on the status row (`redoing 1 edit(s)…`): quiet is not done. Its answer is
  // waited for, as a reader would wait, up to a deadline a loaded machine still meets.
  // What a failed row saw: the screen, what the fake herdr client received, and whether the app had exited.
  const shown = () => `screen:\n${lines().join('\n')}\nherdr received: ${JSON.stringify(fs.existsSync(fx.herdrLog) ? fs.readFileSync(fx.herdrLog, 'utf8') : '')}${exited ? '\nthe app had exited' : ''}`;
  // A key row may wait for the screen to show something before its next key (a tab's program starting). A wait that
  // ends without it fails there, rather than as a later check after keys that went to a screen not yet drawn.
  const until = async (re, ms = 10000) => {
    for (const end = Date.now() + ms; !re.test(lines().join('\n'));) {
      if (Date.now() >= end) throw new Error(`the screen did not show ${re} within ${ms} ms\n${shown()}`);
      await new Promise((r) => setTimeout(r, 50)); await flush();
    }
  };
  const answered = async () => { for (const end = Date.now() + 15000; Date.now() < end && /…\s*$/.test(lines()[ROWS - 3]);) { await new Promise((r) => setTimeout(r, 50)); await flush(); } };
  try {
    // The empty transcript has no title. Workers names its session row `ws`; the catalog's temporary
    // `keysSess` label may never paint when Workers wins the race. Wait for the row the keys act on.
    const ready = row.ready ?? (row.tab === 'herdr' ? /FAKE HERDR/ : row.tab === 'observatory' ? /^ {7}ws +│/m : /a\.ts/);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !ready.test(lines().join('\n'))) { await new Promise((r) => setTimeout(r, 50)); await flush(); }
    assert.match(lines().join('\n'), ready, `the ${row.tab ?? 'review'} tab painted\n${lines().join('\n')}`);
    await settle(400);
    const fg = (text) => { const b = term.buffer.active; for (let y = 0; y < ROWS; y++) { const x = lines()[y].indexOf(text); if (x >= 0) return b.getLine(b.baseY + y).getCell(x).getFgColor(); } return null; };
    const snap = row.before ? row.before({ fg, screen: lines() }) : undefined;
    for (const key of row.keys) {
      if (typeof key === 'function') await key(child, { lines, until, fx });
      else child.write(key);
      await settle(key === K.esc ? 250 : 150);
      await answered();
    }
    await settle(row.wait ?? 250);
    await answered();
    // F1's first paint probes herdr's version synchronously: silence can still be the old Review frame.
    if (row.done) await until(row.done);
    // The store, through `oak list --json`, only for a row whose check reads it.
    let list = null;
    const listed = () => (list ??= JSON.parse(cp.execFileSync(process.execPath, [CLI, 'list', '--session', fx.session, '--json'], { cwd: fx.ws, env: fx.env, encoding: 'utf8' })));
    const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []);
    const view = (screen) => ({
      screen, text: screen.join('\n'), bottom: screen.slice(-4).join('\n'), keysRow: screen[ROWS - 1], raw, exited, snap, fg,
      rowOf: (text) => screen.findIndex((l) => l.includes(text)),
      get edits() { return Object.fromEntries(listed().edits.map((e) => [e.id, e.status])); },
      editor: read(fx.edLog).map((l) => JSON.parse(l).map((a) => (a.startsWith(fx.ws) ? path.relative(fx.ws, a) : a))),
      herdr: read(fx.herdrLog).join(''),
      copied: [...raw.matchAll(/\x1b\]52;c;([^\x07\x1b]*)(?:\x07|\x1b\\)/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf8')).map((s) => (s.startsWith(fx.ws) ? path.relative(fx.ws, s) : s)),
      // The rows drawn in reverse video (the selection), below the tab bar: their text, and their screen rows.
      ...(() => {
        const b = term.buffer.active, text = [], rows = [];
        for (let y = 1; y < ROWS; y++) {
          const l = b.getLine(b.baseY + y); let s = '';
          for (let x = 0; x < COLS; x++) { const c = l.getCell(x); if (c.isInverse()) s += c.getChars() || ' '; }
          if (s.trim()) { text.push(s.trim()); rows.push(y); }
        }
        return { selected: text.join(' | '), selRows: rows };
      })(),
      pid: child.pid,
    });
    // Quiet is not done: a loaded machine can leave the app's answer to the last key unpainted after the quiet the
    // keys wait for (the help, 105 ms after a check that failed on a loaded runner). A check that fails reads the
    // screen, the store and the logs again until it passes, for 10 s; one that never passes fails on the screen as it is then.
    const checkedAt = Date.now();
    for (;;) {
      try { row.check(view(lines())); break; } catch (error) {
        if (Date.now() - checkedAt > 10000) throw new Error(`the check still failed after 10 s: ${error.message}\n${shown()}`, { cause: error });
        await new Promise((r) => setTimeout(r, 100)); await flush(); list = null;
      }
    }
  } finally {
    try { child.kill(); } catch { /* exited */ }
    // The app may have started a detached database build (`__index-build`) that is still writing in this home: retry
    // the removal while it finishes, rather than failing on ENOTEMPTY.
    fs.rmSync(fx.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

const PENDING = { 1: 'pending', 2: 'pending' };
const PASTE = (text) => `\x1b[200~${text}\x1b[201~`;
/** `n` sessions in the workspace, each newer than keysSess, which is then the oldest the picker lists. */
const newerSessions = (n) => (fx) => {
  const dir = path.join(fx.home, '.claude/projects', fx.ws.replace(/[^a-zA-Z0-9]/g, '-'));
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const id = `filler-${String(i).padStart(2, '0')}`, ts = new Date(now - i * 60000);
    const f = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(f, [{ type: 'user', sessionId: id, cwd: fx.ws, timestamp: ts.toISOString(), message: { role: 'user', content: `Filler ${i}` } },
      { type: 'assistant', sessionId: id, cwd: fx.ws, timestamp: ts.toISOString(), message: { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 10, output_tokens: 5 } } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.utimesSync(f, ts, ts);
  }
  const old = new Date(now - (n + 5) * 60000);
  fs.utimesSync(path.join(dir, `${fx.session}.jsonl`), old, old);
};
/** oak sync's state in a row's store, as a run leaves it: a run 30 seconds ago that pulled from build-box, and one open
 *  conflict on a plan, with this machine's file and the other machine's copy. Its files, for the row's check. */
function syncWorld(fx) {
  const sync = path.join(fx.home, '.claude/claude-observatory/sync');
  const file = path.join(fx.home, '.claude/plans/m.md'), copy = path.join(sync, 'conflicts/build-box/plans/m.md');
  const sha = (t) => require('node:crypto').createHash('sha256').update(t).digest('hex');
  for (const [f, text] of [[file, 'one\nleft\n'], [copy, 'one\nright\n']]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
  const at = Date.now() - 30_000;
  fs.writeFileSync(path.join(sync, 'status.json'), JSON.stringify({ at, durationMs: 800, status: 'ok', warnings: [], machines: [{ label: 'build-box', host: 'h1', status: 'ok',
    pulled: { files: 2, bytes: 2048 }, conflicts: 1, pending: { files: 0, bytes: 0 }, errors: [], lastOkAt: at }] }));
  fs.writeFileSync(path.join(sync, 'conflicts.json'), JSON.stringify([{ id: 'c0ffee000001', family: 'plans', name: 'm.md', from: 'build-box', host: 'h1', at,
    peerSha256: sha('one\nright\n'), peerSize: 11, copy, localSha256: sha('one\nleft\n'), reason: 'overlap' }]));
  return { sync, file, copy };
}
/** Press ↓ until the options window's selected row is `label`: the selected row has its marker before the label. */
const toOption = (label) => async (child, { lines }) => {
  const selected = () => /^ {2}\S (.*?) {2,}/m.exec(lines().join('\n'))?.[1];
  const on = () => selected() === label;
  // One key at a time, each answered on screen before the next: on a loaded machine keys sent faster than the app paints
  // arrive together and the cursor jumps past the row in one frame. Down to the end, then back up: a section that
  // appears while the window is open (sync's, once its status is read) can land above the cursor.
  for (const key of [K.down, K.up]) {
    for (let i = 0; i < 80 && !on(); i++) {
      const before = selected();
      child.write(key);
      for (const end = Date.now() + 3000; Date.now() < end && selected() === before;) await new Promise((r) => setTimeout(r, 30));
      if (selected() === before) break; // the end of the list; unrelated redraws do not acknowledge the key
    }
  }
  assert.ok(on(), `the options reach ${label}:\n${lines().join('\n')}`);
};
const untouched = (r) => assert.deepEqual(r.edits, PENDING, 'no edit changed');
/** A recording editor named `name` in the row's bin, as `code` and `fakevi` are. */
const fakeEditor = (fx, name) => fs.writeFileSync(path.join(fx.dir, 'bin', name),
  `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(fx.edLog)}, JSON.stringify([${JSON.stringify(name)}, ...process.argv.slice(2)]) + '\\n');\n`, { mode: 0o755 });
/** This machine's PATH without the folders that hold a GUI editor OAK knows (a workstation's /snap/bin/code or
 *  ~/.local/bin/cursor): W's last resort is the first GUI editor on PATH, so a row about it has only its fixture's. */
const NO_GUI_PATH = (() => {
  const core = require('../../core/dist');
  return (process.env.PATH ?? '').split(path.delimiter).filter((d) => d && !core.detectEditors({ path: d }).some((e) => core.editorKind(e.command) === 'gui')).join(path.delimiter);
})();
/** The row's PATH: its bin, holding `editors` (recording ones) and not `code` unless named, then NO_GUI_PATH. */
const onlyEditors = (...editors) => (fx) => {
  fs.rmSync(path.join(fx.dir, 'bin/code'));
  for (const name of editors) fakeEditor(fx, name);
  fx.env.PATH = path.join(fx.dir, 'bin') + path.delimiter + NO_GUI_PATH;
};
const OPEN_B = [K.enter, K.down]; // unfold b.ts (the newest file, listed first) and select its one edit, #2
const status = (re) => (r) => assert.match(r.bottom, re);
/** Focus moved to the window titled `to`: its title takes the colour the focused title had at start
 *  (`start`, Traces on Review), and `from` no longer has it. */
const focusMoves = (to, from, start = 'F5 Traces') => ({
  before: ({ fg }) => fg(start),
  check: (r) => { assert.equal(r.fg(to), r.snap, `${to} has the focus colour`); assert.notEqual(r.fg(from), r.snap, `${from} lost it`); },
});

/**
 * One row per key. `help` is the key's entry in the `?` help (its first column there, exactly), or
 * `mentions` a phrase of the help that names it; `unlisted` says why a key is deliberately not in the help.
 * `cols` and `rows` size the terminal, and `ready` is what the start screen must show before the keys.
 */
const ROWS_TABLE = [
  (() => {
    let output;
    const click = text => async (child, { lines, until }) => {
      await until(new RegExp(text));
      const y = lines().findIndex(line => line.includes(text));
      assert.ok(y >= 0, `row is visible: ${text}\n${lines().join('\n')}`);
      const x = lines()[y].indexOf(text) + 1;
      child.write(`\x1b[<0;${x};${y + 1}M\x1b[<0;${x};${y + 1}m`);
    };
    return { id: 'Observatory process click follows appends and folds finished shells', tab: 'observatory', mentions: 'click', ready: /ws/,
      prep: fx => {
        output = path.join(fx.dir, 'synthetic.output'); fs.writeFileSync(output, 'PROCESS FIRST\n');
        const records = [0, 1].flatMap(i => [
          { type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: `tool-${i}`, name: 'Bash', input: { command: 'synthetic-build', description: i ? 'Finished synthetic build' : 'Live synthetic build', run_in_background: true } }] } },
          { type: 'user', timestamp: new Date().toISOString(), toolUseResult: { backgroundTaskId: `shell-${i}` }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${i}`, content: `Output is being written to: ${output}` }] } },
        ]);
        records.push({ type: 'queue-operation', timestamp: new Date().toISOString(), content: '<task-notification><task-id>shell-1</task-id><status>completed</status><summary>exit code 0</summary></task-notification>' });
        fs.writeFileSync(path.join(fx.home, '.claude/projects', fx.ws.replace(/[^a-zA-Z0-9]/g, '-'), fx.session + '.jsonl'), records.map(r => JSON.stringify({ ...r, cwd: fx.ws, sessionId: fx.session })).join('\n') + '\n');
      },
      // A click lands on the row the app has drawn when it reads the click. The detail draws its Processes under
      // "loading conversation…" first, then the conversation above them, then the live shell's output under it: three
      // runs of a loaded runner clicked "1 finished" on the first layout and reached the app after the conversation
      // came, folding the shell row drawn there instead. The clicks wait for the last layout.
      keys: [K.enter, async (_child, { lines, until }) => {
        const laidOut = /^(?![\s\S]*loading conversation…)[\s\S]*PROCESS FIRST/;
        await until(laidOut, 20000);
        assert.match(lines().join('\n'), laidOut, 'the conversation and the live shell\'s output are drawn');
      },
        click('1 finished'), async (_child, { lines, until }) => { await until(/Finished synthetic build/); assert.match(lines().join('\n'), /Finished synthetic build/); },
        click('Live synthetic build'), async (_child, { lines, until }) => {
          // The Processes list already shows the shell's first line under it, so the process view is what is waited for.
          const opened = /^(?![\s\S]*Loading process output…)[\s\S]* · process output/;
          await until(opened); assert.match(lines().join('\n'), opened);
          fs.appendFileSync(output, '\x1b]0;UNTRUSTED TITLE\x07\x1b[2JPROCESS APPENDED\n');
          await until(/PROCESS APPENDED/);
        }],
      check: r => { assert.match(r.text, /PROCESS APPENDED/); assert.doesNotMatch(r.raw, /UNTRUSTED TITLE/); },
    };
  })(),
  // ---- Review: the rebindable verbs ----
  { id: 'a keeps the selected edit', keys: [...OPEN_B, 'a'], help: 'a', check: (r) => assert.deepEqual(r.edits, { 1: 'pending', 2: 'kept' }) },
  { id: 'u undoes the selected edit', keys: [...OPEN_B, 'u'], help: 'u', check: (r) => assert.deepEqual(r.edits, { 1: 'pending', 2: 'undone' }) },
  { id: 'U redoes an undone edit', keys: [...OPEN_B, 'u', 'U'], help: 'U', wait: 500, check: (r) => { untouched(r); assert.match(r.bottom, /re-applied edit #2/); } },
  { id: 'A asks, then keeps everything listed', keys: ['A', 'y'], help: 'A', wait: 500, check: (r) => assert.deepEqual(r.edits, { 1: 'kept', 2: 'kept' }) },
  { id: 'D asks, then undoes everything listed', keys: ['D', 'y'], help: 'D', wait: 500, check: (r) => assert.deepEqual(r.edits, { 1: 'undone', 2: 'undone' }) },
  { id: 'y answers a confirmation, n cancels it', keys: ['A', 'n'], help: 'y / n', check: (r) => { untouched(r); assert.match(r.bottom, /cancelled/); } },
  { id: 'esc cancels a confirmation', keys: ['A', K.esc], mentions: 'esc is no', check: (r) => { untouched(r); assert.match(r.bottom, /cancelled/); } },
  { id: 'a confirmation takes every other key', keys: ['A', 'u'], mentions: 'it takes every key until you answer', check: (r) => { untouched(r); assert.match(r.bottom, /keep 2 edit\(s\).*\[y\/n\]/); } },
  { id: 'n steps to the next edit', keys: ['n'], help: 'prev / next', check: (r) => assert.match(r.selected, /1 edit · 1 pending/) },
  { id: 'p steps back', keys: ['n', 'p'], mentions: 'prev / next    p / n', check: (r) => assert.match(r.selected, /1 edit · 1 pending/) },
  { id: 'e opens a file header in a GUI editor', keys: ['e'], help: 'e / E', wait: 500, check: (r) => { assert.deepEqual(r.editor, [['code', 'b.ts']]); assert.match(r.bottom, /opened in code/); } },
  { id: 'e opens the selected edit', keys: [...OPEN_B, 'e'], mentions: 'open the selection in the terminal editor', wait: 500, check: (r) => assert.deepEqual(r.editor, [['code', 'b.ts']]) },
  { id: 'e hands a terminal editor the terminal', env: { EDITOR: 'fakevi' }, keys: [...OPEN_B, 'e'], mentions: 'terminal ones take over until exit', wait: 800,
    check: (r) => { assert.deepEqual(r.editor, [['fakevi', 'b.ts']]); assert.match(r.bottom, /back from fakevi/); assert.ok(r.raw.includes('\x1b[?1049l'), 'the alternate screen was handed over'); } },
  // ctrl+c while a terminal editor has the terminal signals the whole job; it is the editor's, and the app stays.
  { id: 'ctrl+c in a terminal editor stops the editor, not the app', env: { EDITOR: 'fakeread' }, keys: [...OPEN_B, 'e', (child, { until }) => until(/FAKEREAD WAITING/), K.ctrl('c')], wait: 800,
    mentions: 'terminal ones take over until exit', check: (r) => { assert.equal(r.exited, false); assert.match(r.bottom, /fakeread was stopped \(SIGINT\)/); } },
  // The same ctrl+c reaches the app, and can be handled only after the editor's end handed the terminal back.
  { id: 'a SIGINT just after a terminal editor ends is still the editor\'s', env: { EDITOR: 'fakeread' }, wait: 800, mentions: 'terminal ones take over until exit',
    keys: [...OPEN_B, 'e', (child, { until }) => until(/FAKEREAD WAITING/), '\r', async (child, { until }) => { await until(/back from fakeread/); process.kill(child.pid, 'SIGINT'); }],
    check: (r) => { assert.equal(r.exited, false); assert.match(r.bottom, /back from fakeread/); } },
  { id: 'e follows the options editor before $EDITOR', env: { EDITOR: 'fakevi' }, prefs: { editor: 'code' }, keys: ['e'], mentions: 'options (editor', wait: 500, check: (r) => assert.deepEqual(r.editor, [['code', 'b.ts']]) },
  { id: 'e with no editor says where to set one', env: { EDITOR: undefined }, keys: ['e'], mentions: 'open the selection in the terminal editor',
    check: (r) => { assert.deepEqual(r.editor, []); assert.match(r.bottom, /no editor set — press o and pick one under Terminal editor, or export \$EDITOR/); } },
  // The regression the report was about: with an edit's diff open, `e` on another Map row opened the diff's file.
  { id: 'e on a Map row opens that row, not the open diff', keys: [...OPEN_B, K.f6, K.down, K.down, 'e'], mentions: 'open the selection in the terminal editor', wait: 500,
    check: (r) => { assert.match(r.selected, /a\.ts/); assert.deepEqual(r.editor, [['code', 'a.ts']]); } },
  { id: 'e on the Diff opens the file it shows', keys: [...OPEN_B, K.f7, 'e'], mentions: 'open the selection in the terminal editor', wait: 500, check: (r) => assert.deepEqual(r.editor, [['code', 'b.ts']]) },
  { id: 'e on a Prompts row with a diff open opens the diff', keys: [...OPEN_B, K.f4, 'e'], mentions: 'open the selection in the terminal editor', wait: 500, check: (r) => assert.deepEqual(r.editor, [['code', 'b.ts']]) },
  { id: 'e on a Prompts row with nothing open says so', keys: [K.f4, 'e'], mentions: 'open the selection in the terminal editor',
    check: (r) => { assert.deepEqual(r.editor, []); assert.match(r.bottom, /select an edit first/); } },
  // ---- Review: e/E the terminal editor, W the GUI editor ----
  { id: 'E opens the selected edit in the terminal editor, as e does', env: { EDITOR: 'fakevi' }, keys: [...OPEN_B, 'E'], mentions: 'open the selection in the terminal editor', wait: 800,
    check: (r) => { assert.deepEqual(r.editor, [['fakevi', 'b.ts']]); assert.match(r.bottom, /back from fakevi/); } },
  { id: 'W opens the selected edit at its line in the GUI editor', env: { DISPLAY: ':synthetic' }, keys: [...OPEN_B, 'W'], mentions: "open the selection in the GUI editor, at the edit's line", wait: 500, cols: 200,
    check: (r) => { assert.deepEqual(r.editor, [['code', '--goto', 'b.ts:2']]); assert.match(r.bottom, /GUI editor code, from \$EDITOR — ran code --goto \S*b\.ts:2/); } },
  { id: 'W on the Diff opens the edit it shows at its line', env: { DISPLAY: ':synthetic' }, keys: [...OPEN_B, K.f7, 'W'], mentions: "open the selection in the GUI editor, at the edit's line", wait: 500,
    check: (r) => assert.deepEqual(r.editor, [['code', '--goto', 'b.ts:2']]) },
  { id: 'W on a file header opens the file, at no line', env: { DISPLAY: ':synthetic' }, keys: ['W'], mentions: "open the selection in the GUI editor, at the edit's line", wait: 500,
    check: (r) => assert.deepEqual(r.editor, [['code', 'b.ts']]) },
  { id: 'W gives a JetBrains IDE the line its own way', env: { DISPLAY: ':synthetic' }, prefs: { guiEditor: 'idea' }, prep: (fx) => fakeEditor(fx, 'idea'),
    keys: [...OPEN_B, 'W'], mentions: "open the selection in the GUI editor, at the edit's line", wait: 500, check: (r) => assert.deepEqual(r.editor, [['idea', '--line', '2', 'b.ts']]) },
  // The Mac report: the terminal editor is nvim, nothing in the environment names an editor, and cursor is installed.
  { id: 'with nvim the terminal editor, e runs nvim and W runs cursor at the line', prefs: { editor: 'nvim' }, env: { EDITOR: undefined, DISPLAY: ':synthetic' }, prep: onlyEditors('cursor', 'nvim'),
    keys: [...OPEN_B, 'e', (child, { until }) => until(/back from nvim/), 'W'], mentions: "open the selection in the GUI editor, at the edit's line", wait: 500, cols: 200,
    check: (r) => { assert.deepEqual(r.editor, [['nvim', 'b.ts'], ['cursor', '--goto', 'b.ts:2']]); assert.match(r.bottom, /GUI editor cursor, from the first GUI editor on PATH/); } },
  { id: 'W over SSH prints the Remote-SSH command, at the line', env: { SSH_CONNECTION: '192.0.2.1 1234 192.0.2.2 22', DISPLAY: undefined, WAYLAND_DISPLAY: undefined }, keys: [...OPEN_B, 'W'], cols: 220,
    mentions: "open the selection in the GUI editor, at the edit's line",
    check: (r) => { assert.deepEqual(r.editor, []); assert.match(r.bottom, /Run on the machine with the editor: code --remote ssh-remote\+\S+@192\.0\.2\.2 --goto \S*b\.ts:2/); } },
  { id: 'the key row names e/E the terminal editor and W the GUI editor', cols: 260, keys: [], mentions: "open the selection in the GUI editor, at the edit's line",
    check: (r) => assert.match(r.keysRow, /e\/E terminal editor · W GUI editor/) },
  { id: 'y copies the selected path', keys: ['y'], help: 'y', check: (r) => assert.deepEqual(r.copied, ['b.ts']) },
  { id: 'y on a Map row copies that row, not the open diff', keys: [...OPEN_B, K.f6, K.down, K.down, 'y'], mentions: 'copy the selected path', check: (r) => assert.deepEqual(r.copied, ['a.ts']) },
  { id: 'y on the Diff copies the patch', keys: [...OPEN_B, K.f7, 'y'], mentions: 'or the diff, when the Diff face is focused', check: (r) => assert.match(r.copied[0] ?? '', /^-two\n\+TWO$/m) },
  { id: 'w pans long lines instead of wrapping', keys: ['w'], help: 'w', check: status(/long lines pan sideways/) },
  { id: '← / → pan while w is on', keys: [...OPEN_B, K.f7, 'w', K.right], help: '← / →', check: status(/panned \d+ columns/) },
  { id: 's cycles the sort', keys: ['s'], help: 's', check: status(/sorted by Time \(oldest first\)/) },
  { id: 'F unfolds every file', keys: ['F'], help: 'F', check: status(/unfolded 2 file\(s\)/) },
  { id: 'F again folds every file', keys: ['F', 'F'], mentions: 'fold or unfold every file group', check: status(/folded 2 file\(s\) — space opens one/) },
  { id: 'x marks the row', keys: [...OPEN_B, 'x'], help: 'x', check: status(/1 edit\(s\) marked/) },
  { id: 'x marks, then u undoes every marked edit', keys: [...OPEN_B, 'x', K.down, K.down, 'x', 'u', 'y'], mentions: 'then keep and undo act on every marked edit', wait: 500,
    check: (r) => assert.deepEqual(r.edits, { 1: 'undone', 2: 'undone' }) },
  // A regex, anchored: scattered letters also match the directories above the file, which here are random.
  { id: '/ filters the list', keys: ['/', ...'a\\.ts$', K.enter], help: '/', check: (r) => { assert.match(r.keysRow, /^\/a\\\.ts\$/); assert.match(r.text, /\? a\.ts/); assert.doesNotMatch(r.text, /\? b\.ts/); } },
  { id: '\\ opens the filter options', keys: ['\\'], help: '\\', check: (r) => assert.match(r.text, /filter — space toggles a bucket/) },
  { id: 'r refreshes', keys: ['r'], help: 'r', check: status(/^refreshed\s*$/m) },
  { id: 'b opens the session picker', keys: ['b'], help: 'b', check: (r) => assert.match(r.text, /sessions · 1 {2}\[all\]/) },
  { id: 'o opens the options', keys: ['o'], help: 'o', check: (r) => assert.match(r.text, /options {2}— {2}↑↓ move/) },
  { id: 'i opens the inbox, or says nobody waits', keys: ['i'], help: 'i', check: status(/nobody is waiting on you/) },
  { id: 'h jumps to the next hand, or says nobody waits', keys: ['h'], help: 'h', check: status(/nobody is waiting on you/) },
  { id: 'm minimizes the focused window', keys: ['m'], help: 'm / z', check: (r) => assert.doesNotMatch(r.text, /F5 Traces/) },
  { id: 'z zooms the focused window', keys: ['z'], mentions: 'minimize / zoom the focused window', check: status(/Traces full screen/) },
  { id: '= resets the layout', keys: ['m', '='], help: '< / > / =', check: (r) => { assert.match(r.bottom, /layout reset/); assert.match(r.text, /F5 Traces/); } },
  { id: '? opens the help', keys: ['?'], help: '?', check: (r) => assert.match(r.text, /keys {2}— {2}esc or \? to close/) },
  // ---- Review: fixed keys ----
  { id: ': opens the palette', keys: [':'], help: ':', check: (r) => assert.match(r.text, /: ▏ {2}· a command, or type to find/) },
  { id: 'the palette runs a typed command', keys: [':', ...'version', K.enter], mentions: 'type a command (status, doctor, store, ignore, version', wait: 1500, check: status(/oak \d+\.\d+\.\d+/) },
  { id: 'the palette row "Open in the terminal editor" opens the selection', keys: [...OPEN_B, ':', ...'Open in the terminal editor', K.enter], mentions: 'find sessions, tabs, workspaces and actions', wait: 500,
    check: (r) => assert.deepEqual(r.editor, [['code', 'b.ts']]) },
  { id: 'e typed in the palette is text', keys: [':', 'e'], mentions: 'the palette, the session picker and', check: (r) => { assert.deepEqual(r.editor, []); assert.match(r.text, /: e▏/); } },
  { id: '↓ moves the selection', keys: [K.down], help: '↑↓ or j/k', check: (r) => assert.match(r.selected, /1 edit · 1 pending/) },
  { id: 'j and k move too', keys: ['j', 'j', 'k'], mentions: '↑↓ or j/k', check: (r) => assert.match(r.selected, /1 edit · 1 pending/) },
  { id: 'PgDn / PgUp move ten', keys: [K.pgdn, K.pgup], help: 'PgUp / PgDn', check: (r) => assert.match(r.selected, /1 edit · 1 pending/) },
  { id: 'G selects the last file header, all of it', keys: ['G'], mentions: 'g / G   first / last row',
    check: (r) => assert.equal(r.selRows[0], r.rowOf('? a.ts'), `the selection starts on the a.ts header line, not its counts line: ${r.selected}`) },
  { id: 'g goes back to the first row', keys: ['G', 'g'], mentions: 'g / G   first / last row', check: (r) => assert.equal(r.selRows[0], r.rowOf('? b.ts')) },
  { id: 'space unfolds a file', keys: [' '], help: 'space', check: (r) => assert.match(r.selected, /^▾/) },
  { id: 'enter opens the selected row', keys: [K.enter], help: 'enter', check: (r) => assert.match(r.selected, /^▾/) },
  { id: 'esc unselects', keys: [...OPEN_B, K.esc], help: 'esc', check: status(/nothing selected/) },
  { id: '0-9 then enter goes to an edit', keys: ['1', K.enter], help: '0-9 then enter', check: status(/edit #1/) },
  { id: 'a digit shows the pending id', keys: ['2'], mentions: '0-9 then enter', check: (r) => assert.match(r.bottom, /go to edit #2_/) },
  { id: '> grows the focused window', keys: ['>'], mentions: 'shrink / grow the focused window',
    before: ({ screen }) => screen.find((l) => l.includes('F5 Traces')).indexOf('┐'), check: (r) => assert.ok(r.screen[r.rowOf('F5 Traces')].indexOf('┐') > r.snap, 'Traces is wider') },
  { id: '< shrinks it again', keys: ['>', '>', '<'], mentions: 'shrink / grow the focused window', check: (r) => assert.match(r.text, /F5 Traces/) },
  { id: ', and . resize too', keys: ['.'], mentions: '(, . and _ too)', check: (r) => assert.match(r.text, /F5 Traces/) },
  { id: '_ resets the layout too', keys: ['m', '_'], mentions: '(, . and _ too)', check: status(/layout reset/) },
  { id: 'F4 focuses Prompts', keys: [K.f4], help: 'F4 / F5', ...focusMoves('F4 Prompts', 'F5 Traces') },
  { id: 'F5 focuses Traces', keys: [K.f6, K.f5], mentions: 'focus Prompts / Traces', ...focusMoves('F5 Traces', 'F6 Map') },
  { id: 'F6 focuses the Map', keys: [K.f6], help: 'F6 / F7', ...focusMoves('F6 Map', 'F5 Traces') },
  { id: 'F7 focuses the Diff', keys: [K.f7], mentions: 'focus Map / Diff', ...focusMoves('F7 Diff', 'F5 Traces') },
  { id: 'a second F7 zooms the Diff', keys: [K.f7, K.f7], mentions: 'a second press zooms', check: status(/Diff full screen/) },
  { id: 'F8 says Review has no Agent window', keys: [K.f8], unlisted: 'Review hides the Agent window; the key says so', check: status(/this workspace has no Agent/) },
  { id: 'F10 says it is not a window key', keys: [E + '[21~'], unlisted: 'a guard: an F-key past the window bar says so', check: status(/F10 is not a window key — F4 to F7 focus Prompts, Traces, Map and Diff/) },
  { id: '[ says the window has no tabs', keys: ['['], unlisted: 'no Review window has tabs; the key says so', check: status(/Traces has no tabs/) },
  { id: 'P jumps to a file', keys: ['P', K.down, K.enter], help: 'P', check: (r) => assert.match(r.selected, /1 edit · 1 pending/) },
  { id: 'N with no find says so', keys: ['N'], mentions: 'N goes back a match', check: status(/no find to repeat/) },
  { id: '/ on the Diff finds in the patch, n repeats', keys: [...OPEN_B, K.f7, '/', 'T', 'W', 'O', K.enter], mentions: 'with a find standing on the Diff face they repeat it', check: status(/“TWO” — line \d+ of \d+/) },
  { id: "' sets a mark", keys: [...OPEN_B, "'", 'q'], help: "' then a letter", check: status(/mark ‘q’ set on edit #2/) },
  { id: '` jumps to a mark', keys: [...OPEN_B, "'", 'q', 'g', '`', 'q'], help: '` then a letter', check: status(/mark ‘q’ — edit #2/) },
  { id: 'the Map keeps under the row, asking in the map', keys: [K.f6, 'a'], mentions: 'on the Map, everything under the row', check: (r) => { untouched(r); assert.match(r.text, /keep 1\? {2}\[y\/n\]/); } },
  { id: 'a on the Diff keeps the edit it shows', keys: [...OPEN_B, K.f7, 'a'], help: 'Keep / Undo', check: (r) => assert.deepEqual(r.edits, { 1: 'pending', 2: 'kept' }) },
  // ---- Review: ctrl ----
  { id: '^D / ^U move half a page', keys: [K.ctrl('d'), K.ctrl('u')], help: '^D / ^U', check: (r) => assert.match(r.selected, /1 edit · 1 pending/) },
  { id: '^F / ^B move a page', keys: [K.ctrl('f')], mentions: '^F / ^B   a whole page', check: (r) => assert.match(r.selected, /1 edit · 1 pending/) },
  { id: '^Z hands the terminal back until SIGCONT', keys: [K.ctrl('z'), (child) => process.kill(child.pid, 'SIGCONT')], help: '^Z', wait: 500,
    check: (r) => { const at = r.raw.lastIndexOf('\x1b[?1049l'); assert.ok(at > 0, 'the alternate screen was left'); assert.ok(r.raw.indexOf('\x1b[?1049h', at) > at, 'and entered again on SIGCONT'); } },
  { id: '^V pastes into the filter', keys: ['/', K.ctrl('v')], help: '^V', wait: 500, check: (r) => assert.match(r.keysRow, /^\/zz_/) },
  { id: '^V with nothing to paste into says so', keys: [K.ctrl('v')], mentions: 'paste into the reply box, a filter, the palette or a search box', check: status(/nothing here takes a paste/) },
  { id: '^C arms the quit', keys: [K.ctrl('c')], mentions: '^C        copy a drag selection, else quit', check: status(/press ctrl\+c again to exit/) },
  { id: '^C twice quits', keys: [K.ctrl('c'), K.ctrl('c')], mentions: 'ctrl+c twice shares its confirmation', wait: 600, check: (r) => assert.ok(r.exited) },
  { id: 'other ctrl chords do nothing (^R)', keys: [...OPEN_B, K.ctrl('r'), K.ctrl('a'), K.ctrl('o'), K.ctrl('e')], mentions: 'Other ctrl chords do nothing', check: (r) => { untouched(r); assert.deepEqual(r.editor, []); } },
  { id: 'an alt chord is not its letter', keys: [...OPEN_B, K.alt('u'), K.alt('e')], unlisted: 'a guard: alt+letter does nothing', check: (r) => { untouched(r); assert.deepEqual(r.editor, []); } },
  { id: 'ctrl+q twice quits', keys: [K.ctrl('q'), K.ctrl('q')], help: 'ctrl+q twice', wait: 600, check: (r) => assert.ok(r.exited) },
  { id: 'ctrl+q once arms it', keys: [K.ctrl('q')], mentions: 'repeat within two seconds to confirm', check: status(/press ctrl\+q again to exit/) },
  // ---- Tabs ----
  // The herdr tab's first paint asks herdr its version, synchronously, and its client starts after: on a slow runner the
  // app writes nothing for over a second, so quiet after the key is still the Review frame. The row waits for the client.
  { id: 'Tab goes to the next tab', keys: [K.tab], help: 'Tab / shift+Tab', done: /FAKE HERDR/, check: (r) => assert.match(r.text, /FAKE HERDR/) },
  { id: 'shift+Tab goes to the previous tab', keys: [K.btab], mentions: 'Tab / shift+Tab', check: (r) => assert.match(r.keysRow, /↵ pin/) },
  { id: 'ctrl+n / ctrl+p switch tabs', keys: [K.ctrl('p')], mentions: 'ctrl+n / ctrl+p', check: (r) => assert.match(r.keysRow, /↵ pin/) },
  { id: 'alt+digit picks a tab', keys: [K.alt('2')], mentions: 'alt+1-3 too', check: (r) => assert.match(r.keysRow, /↵ pin/) },
  { id: 'alt+7 says there is no seventh tab', keys: [K.alt('7')], mentions: 'alt+1-3 too', check: status(/no tab 7 — 3 open/) },
  // A tab switch saves the layout, and an option saves itself, over prefs.json as it is then. What the file was given
  // while the app ran (a hand edit, `oak usage --bill-day`, `oak titles --off`, `oak store --move`) survives both: the
  // copy the app read at start, written back whole, turned the switches back to what they were and lost the moved store.
  // So does a key a newer build wrote, which every save rebuilt from what this build knows dropped.
  (() => {
    let fx = null, file = '', moved = '', afterTab = null;
    const oak = (...args) => cp.execFileSync(process.execPath, [CLI, ...args], { cwd: fx.ws, env: fx.env, encoding: 'utf8' });
    return { id: 'Tab and an option keep what prefs.json was given while the app ran', prefs: { machineUsage: false, billDay: 3 }, mentions: 'Tab / shift+Tab',
      prep: (f) => { fx = f; file = path.join(fx.home, '.claude/claude-observatory/prefs.json'); moved = path.join(fx.dir, 'moved-store'); },
      keys: [
        () => {
          // "machineUsage": false deleted by hand: on again. A hand edit leaves the rest of the file, its mark among it.
          fs.writeFileSync(file, JSON.stringify({ prefsFormat: 2, billDay: 3, futureKey: { a: 1 } }));
          oak('usage', '--bill-day', '12'); oak('titles', '--off'); oak('store', '--move', moved);
        },
        K.btab, // to the Observatory: the layout is saved
        () => { afterTab = JSON.parse(fs.readFileSync(file, 'utf8')); },
        K.tab, 'o', K.down, K.down, K.down, K.down, K.down, K.right, 'q', // back to Review, and Options → Theme → colorblind
      ],
      check: () => {
        const given = (p) => ({ machineUsage: p.machineUsage, remoteTitles: p.remoteTitles, billDay: p.billDay, storeDir: p.storeDir, futureKey: p.futureKey });
        const want = { machineUsage: undefined, remoteTitles: false, billDay: 12, storeDir: moved, futureKey: { a: 1 } };
        assert.equal(afterTab.layout?.active, 'observatory', `control: the tab switch saved the layout: ${JSON.stringify(afterTab)}`);
        assert.deepEqual(given(afterTab), want, 'the tab switch kept them');
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(saved.theme, 'colorblind', `control: the option was saved: ${JSON.stringify(saved)}`);
        assert.equal(saved.layout?.active, 'review', 'with the layout of the second tab switch');
        assert.deepEqual(given(saved), want, 'the option kept them');
      } };
  })(),
  // The store row moves the store, and the status row says what the move could not do, as every surface says it: here an
  // edit an agent made meanwhile that could not wait for the move (the note it left beside the move lock).
  (() => {
    let fx = null, dest = '';
    // Wide enough for the whole status: the row is cut at the terminal's edge (and copied whole by a drag).
    return { id: 'the store row moves the store, and says what the move could not do', mentions: 'options (editor, display, store, sync, keys)', wait: 800, cols: 320,
      prep: (f) => {
        fx = f; dest = path.join(fx.dir, 'moved-by-options');
        const moveDir = path.join(fx.home, '.claude/claude-observatory-move');
        fs.mkdirSync(moveDir, { recursive: true });
        fs.writeFileSync(path.join(moveDir, 'missed-33333333-3333-3333-3333-333333333333.json'), JSON.stringify({ session: fx.session, file: '/w/o.ts', reason: 'r — edit not captured', ts: 1 }));
      },
      keys: ['o', K.down, K.enter, (child) => child.write(dest), K.enter],
      check: (r) => {
        assert.match(r.bottom.replace(/\s+/g, ' '), new RegExp(`store moved to ${dest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} — 1 edit could not wait for the move and was not captured; it is recorded as a capture gap in its session`));
        assert.equal(JSON.parse(fs.readFileSync(path.join(fx.home, '.claude/claude-observatory/prefs.json'), 'utf8')).storeDir, dest, 'the move recorded where it went');
        assert.ok(fs.existsSync(path.join(dest, fx.session, 'log.jsonl')), 'and the session went with it');
      } };
  })(),
  // A move whose new location prefs.json cannot record, and that cannot be undone, says so: said as "store moved", it hid
  // that OAK looks for the store where it was. Here the default folder cannot come back, nor the store go back to it.
  (() => {
    let dest = '';
    const row = { id: 'the store row says when the move could not be recorded', mentions: 'options (editor, display, store, sync, keys)', wait: 800, cols: 320, prefs: { billDay: 3 },
      prep: (fx) => {
        dest = path.join(fx.dir, 'moved-unrecorded');
        const home = path.join(fx.home, '.claude/claude-observatory');
        const preload = path.join(fx.dir, 'refuse-back.js');
        fs.writeFileSync(preload, `const fs = require('fs'); const rename = fs.renameSync;
fs.renameSync = function (a, b, ...r) { if (String(b) === ${JSON.stringify(home)} || String(a) === ${JSON.stringify(dest)}) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); return rename.call(this, a, b, ...r); };\n`);
        row.env = { NODE_OPTIONS: `--require ${preload}` };
      },
      keys: ['o', K.down, K.enter, (child) => child.write(dest), K.enter],
      check: (r) => assert.match(r.bottom.replace(/\s+/g, ' '), new RegExp(`store moved to ${dest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, but its location was not saved, so OAK looks for it where it was — EBUSY`)) };
    return row;
  })(),
  // A prefs.json that does not parse (a hand edit half done) is left as it is, and the status row says so: read as no
  // preferences, it would be replaced by the layout alone. Once it parses, the next tab switch saves over it.
  (() => {
    let file = '', afterTab = '', said = '';
    const half = '{ "prefsFormat": 2, "billDay": 12, "remoteTitles": false,';
    return { id: 'Tab leaves a prefs.json that does not parse as it is', prefs: { machineUsage: false }, mentions: 'Tab / shift+Tab',
      prep: (fx) => { file = path.join(fx.home, '.claude/claude-observatory/prefs.json'); },
      // The file is read once the app has said it left it: before that, it is as the hand edit left it whatever the
      // tab switch will do, and a loaded runner read the status row before the app had answered the key.
      keys: [() => fs.writeFileSync(file, half), K.btab, async (_child, { lines, until }) => {
        await until(/layout not saved: prefs\.json is not valid JSON/);
        afterTab = fs.readFileSync(file, 'utf8'); said = lines().slice(-4).join('\n');
      },
        () => fs.writeFileSync(file, half.replace(/,$/, ' }')), K.tab],
      check: () => {
        assert.equal(afterTab, half, 'the tab switch left the file as the hand edit left it');
        assert.match(said, /layout not saved: prefs\.json is not valid JSON, so it was left as it is/);
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.ok(saved.layout, `control: once it parses, the next tab switch saves the layout: ${JSON.stringify(saved)}`);
        assert.deepEqual([saved.billDay, saved.remoteTitles, saved.machineUsage], [12, false, undefined], 'over the file as it is');
      } };
  })(),
  // ---- Observatory ----
  { id: 'Observatory Processes stays below Workers with no shells', tab: 'observatory', keys: [K.down, K.enter], unlisted: 'section headers',
    done: /No shells in this session/, check: r => {
      assert.match(r.text, /Processes · 0/);
      assert.equal(r.rowOf('Processes · 0'), r.rowOf('Workers · 0') + 1);
      assert.ok(r.rowOf('Tasks · 0') > r.rowOf('Processes · 0'));
    } },
  { id: 'Observatory a mouse click on a finished shell opens its output', tab: 'observatory', unlisted: 'process row click',
    prep: fx => {
      const output = path.join(fx.dir, 'finished.output'); fs.writeFileSync(output, 'FINISHED SHELL OUTPUT\n');
      const file = path.join(fx.home, '.claude/projects', fx.ws.replace(/[^a-zA-Z0-9]/g, '-'), fx.session + '.jsonl');
      fs.writeFileSync(file, [
        { type: 'assistant', cwd: fx.ws, sessionId: fx.session, timestamp: '2026-10-01T10:00:00Z', message: { role: 'assistant', content: [
          { type: 'tool_use', id: 'finished-tool', name: 'Bash', input: { command: 'synthetic-build', description: 'Finished synthetic shell', run_in_background: true } }] } },
        { type: 'user', cwd: fx.ws, timestamp: '2026-10-01T10:00:01Z', toolUseResult: { backgroundTaskId: 'finished-shell' }, message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'finished-tool', content: 'Output is being written to: ' + output }] } },
        { type: 'queue-operation', timestamp: '2026-10-01T10:00:02Z', content: '<task-notification><task-id>finished-shell</task-id><status>completed</status><summary>exit code 0</summary></task-notification>' },
      ].map(r => JSON.stringify(r)).join('\n') + '\n');
    },
    keys: [K.down, K.enter, async (child, { lines, until }) => {
      // The conversation is drawn above the Processes once it is read: a click aimed before that lands on it (see the
      // process click row).
      const laidOut = /^(?![\s\S]*loading conversation…)[\s\S]*synthetic-build[\s\S]*1 finished/;
      await until(laidOut, 20000);
      assert.match(lines().join('\n'), laidOut, 'the conversation is drawn');
      const y = lines().findIndex(l => l.includes('1 finished')); assert.ok(y >= 0, lines().join('\n'));
      const x = lines()[y].indexOf('1 finished') + 1;
      child.write(`\x1b[<0;${x};${y + 1}M\x1b[<0;${x};${y + 1}m`);
    }, async (child, { lines, until }) => {
      await until(/Finished synthetic shell.*completed/);
      const y = lines().findIndex(l => /Finished synthetic shell.*completed/.test(l)); assert.ok(y >= 0, lines().join('\n'));
      const x = lines()[y].indexOf('Finished synthetic shell') + 1;
      child.write(`\x1b[<0;${x};${y + 1}M\x1b[<0;${x};${y + 1}m`);
    }], done: /FINISHED SHELL OUTPUT/, check: r => assert.match(r.text, /FINISHED SHELL OUTPUT/) },
  { id: 'Observatory ↓ selects a session', tab: 'observatory', env: { NODE_OPTIONS: `--require=${path.join(__dirname, 'fixtures/keys-workers-first.cjs')}` }, keys: [K.down], help: '↑/↓ or j/k', check: (r) => { assert.doesNotMatch(r.raw, /keysSess/); status(/ws — Enter pins its conversation/)(r); } },
  { id: 'Observatory j selects too', tab: 'observatory', env: { NODE_OPTIONS: `--require=${path.join(__dirname, 'fixtures/keys-workers-first.cjs')}` }, keys: ['j'], mentions: '↑/↓ or j/k', check: (r) => { assert.doesNotMatch(r.raw, /keysSess/); status(/ws — Enter pins/)(r); } },
  { id: 'Observatory Enter pins', tab: 'observatory', keys: [K.down, K.enter], help: 'Enter / d / f', check: status(/pinned ws/) },
  { id: 'Observatory d pins', tab: 'observatory', keys: [K.down, 'd'], mentions: 'Enter / d / f', check: status(/pinned ws/) },
  { id: 'Observatory f pins', tab: 'observatory', keys: [K.down, 'f'], mentions: 'Enter / d / f', check: status(/pinned ws/) },
  { id: 'Observatory c focuses the reply box', tab: 'observatory', keys: [K.down, K.enter, 'c'], help: 'c / esc', check: status(/No live pane/) },
  { id: 'Observatory t goes to the herdr pane', tab: 'observatory', keys: [K.down, 't'], help: 't', check: status(/no live herdr pane/) },
  { id: 'Observatory R asks to resolve', tab: 'observatory', keys: [K.down, 'R'], help: 'R', check: (r) => { untouched(r); assert.match(r.bottom, /resolve — accept every pending edit in ws/); } },
  { id: 'Observatory R then y resolves', tab: 'observatory', keys: [K.down, 'R', 'y'], mentions: 'keep its pending edits and clear its store', wait: 800, check: (r) => assert.doesNotMatch(Object.values(r.edits).join(), /pending/) },
  { id: 'Observatory X asks to stop the agent', tab: 'observatory', keys: [K.down, 'X'], help: 'X', check: status(/kill — stop the running agent for ws/) },
  { id: 'Observatory B shows archived sessions', tab: 'observatory', keys: ['B'], help: 'B', check: status(/show archived sessions/) },
  { id: 'Observatory F5 twice zooms the detail', tab: 'observatory', keys: [K.f5, K.f5], help: 'F4, F5, …', check: (r) => assert.doesNotMatch(r.text, /Sessions ─/) },
  { id: 'Observatory F6 says there is no third pane', tab: 'observatory', keys: [K.f6], mentions: 'F4, F5, …', check: status(/no pane F6 here — F4–F5 focus the 2 panes/) },
  { id: 'Observatory → focuses the detail', tab: 'observatory', keys: [K.right], help: '←/→', ...focusMoves('Session ', 'Sessions ─', 'Sessions ─') },
  { id: 'Observatory ← focuses the list again', tab: 'observatory', keys: [K.right, K.left], mentions: 'focus master / detail', ...focusMoves('Sessions ─', 'Session ', 'Sessions ─') },
  { id: 'Observatory End follows the newest message', tab: 'observatory', keys: [K.down, K.enter, K.right, K.end], help: 'End / ↓ newest', check: status(/pinned ws/) },
  { id: 'Observatory i, h, r, b and / work as on Review', tab: 'observatory', keys: ['i'], help: 'i h r b /', check: status(/nobody is waiting on you/) },
  { id: 'Observatory b opens the session picker', tab: 'observatory', keys: ['b'], mentions: 'i h r b /', check: (r) => assert.match(r.text, /sessions · 1 {2}\[all\]/) },
  { id: 'Observatory / filters', tab: 'observatory', keys: ['/', 'k'], mentions: 'i h r b /', check: (r) => assert.match(r.keysRow, /^\/k_/) },
  { id: 'Observatory z zooms the pane', tab: 'observatory', keys: ['z'], help: 'z / v', check: status(/zoomed/) },
  { id: 'Observatory v chooses what the pane shows', tab: 'observatory', keys: ['v'], mentions: 'choose what it shows', check: (r) => assert.match(r.text, /what should this pane show\?/) },
  { id: 'Observatory | splits', tab: 'observatory', keys: ['|'], help: '| / -', check: status(/pane split/) },
  { id: 'Observatory - splits', tab: 'observatory', keys: ['-'], mentions: '| / -', check: status(/pane split/) },
  { id: 'Observatory H swaps panes', tab: 'observatory', keys: [K.right, 'H'], help: 'H J K L', check: status(/panes swapped/) },
  { id: 'Observatory L swaps panes', tab: 'observatory', keys: ['L'], mentions: 'H J K L', check: status(/panes swapped/) },
  { id: 'Observatory J says there is no pane below', tab: 'observatory', keys: ['J'], mentions: 'H J K L', check: status(/no pane below/) },
  { id: 'Observatory the palette closes a pane', tab: 'observatory', keys: ['|', K.esc, ':', ...'Close the focused', K.enter], help: ':', check: status(/closed|pane/) },
  ...['code', 'cursor', 'idea'].map(editor => ({ id: 'workspace request is written before local ' + editor, tab: 'observatory', keys: [K.down, 'W'], mentions: 'workspace window', env: { DISPLAY: ':synthetic' }, prefs: { guiEditor: editor },
    prep: fx => fs.writeFileSync(path.join(fx.dir, 'bin', editor), `#!${process.execPath}
const fs = require('fs'), path = require('path');
const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'editor-review');
const requests = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f)))) : [];
fs.writeFileSync(${JSON.stringify(fx.edLog)}, JSON.stringify([requests.length ? requests[0].action : 'missing', requests[0]?.editor || '', requests[0]?.session || '', requests[0]?.workspace || '']) + '\\n');
`, { mode: 0o755 }),
    check: r => assert.deepEqual(r.editor, [['workspace', editor === 'idea' ? 'jetbrains' : editor === 'code' ? 'vscode' : 'cursor', 'keysSess', '']]) })),
  { id: 'workspace window: W opens the local folder once', tab: 'observatory', keys: [K.down, 'W'], help: 'W', env: { DISPLAY: ':synthetic' },
    check: r => { assert.deepEqual(r.editor, [['code', '']]); assert.match(r.bottom, /ran code /); } },
  { id: 'workspace window: a group button opens its single workspace', tab: 'observatory', keys: [(child, { lines }) => {
      const y = lines().findIndex(l => /ws \[W window\]/.test(l)); assert.ok(y >= 0, lines().join('\n'));
      const x = lines()[y].indexOf('[W window]') + 2;
      child.write(`\x1b[<0;${x};${y + 1}M\x1b[<0;${x};${y + 1}m`);
    }], mentions: 'workspace window', env: { DISPLAY: ':synthetic' },
    check: r => { assert.deepEqual(r.editor, [['code', '']]); assert.match(r.bottom, /ran code /); } },
  { id: 'workspace window: W opens a local JetBrains launcher', tab: 'observatory', keys: [K.down, 'W'], mentions: 'workspace window', env: { DISPLAY: ':synthetic' }, prefs: { editor: 'idea' },
    prep: fx => fs.writeFileSync(path.join(fx.dir, 'bin/idea'), `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(fx.edLog)}, JSON.stringify(['idea', ...process.argv.slice(2)]) + '\\n');\n`, { mode: 0o755 }),
    check: r => { assert.deepEqual(r.editor, [['idea', '']]); assert.match(r.bottom, /ran idea /); } },
  { id: 'workspace window: W refuses a removed local folder', tab: 'observatory', keys: [K.down, (child, { fx }) => fs.renameSync(fx.ws, fx.ws + '-removed'), 'W'], mentions: 'workspace window', env: { DISPLAY: ':synthetic' },
    check: r => { assert.deepEqual(r.editor, []); assert.match(r.bottom, /workspace folder.*(missing|unavailable)/); } },
  { id: 'workspace window: W refuses a terminal editor in the GUI editor setting', tab: 'observatory', keys: [K.down, 'W'], mentions: 'workspace window', prefs: { guiEditor: 'vim' }, cols: 200,
    env: { DISPLAY: ':synthetic' }, check: r => { assert.deepEqual(r.editor, []); assert.match(r.bottom, /W needs a GUI editor — set GUI editor under o \(prefs\.guiEditor\)/); } },
  { id: 'workspace window: W runs the GUI editor when the terminal editor is nvim, here the first on PATH', tab: 'observatory', keys: [K.down, 'W'], mentions: 'workspace window', cols: 200,
    prefs: { editor: 'nvim' }, env: { EDITOR: undefined, DISPLAY: ':synthetic' }, prep: onlyEditors('cursor', 'nvim'),
    check: r => { assert.deepEqual(r.editor, [['cursor', '']]); assert.match(r.bottom, /GUI editor cursor, from the first GUI editor on PATH — ran cursor \S+/); } },
  { id: 'workspace window: the GUI editor setting wins over $EDITOR', tab: 'observatory', keys: [K.down, 'W'], mentions: 'workspace window', cols: 200,
    prefs: { guiEditor: 'cursor' }, env: { DISPLAY: ':synthetic' }, prep: (fx) => fakeEditor(fx, 'cursor'),
    check: r => { assert.deepEqual(r.editor, [['cursor', '']]); assert.match(r.bottom, /GUI editor cursor, from the GUI editor setting/); } },
  { id: "workspace window: in an editor's integrated terminal W runs that editor", tab: 'observatory', keys: [K.down, 'W'], mentions: 'workspace window', cols: 200,
    env: { EDITOR: undefined, DISPLAY: ':synthetic', TERM_PROGRAM: 'vscode', CURSOR_TRACE_ID: 'synthetic-trace' },
    // code first on PATH: the terminal's own editor, cursor, comes before it.
    prep: (fx) => { fakeEditor(fx, 'cursor'); fx.env.PATH = path.join(fx.dir, 'bin') + path.delimiter + NO_GUI_PATH; },
    check: r => { assert.deepEqual(r.editor, [['cursor', '']]); assert.match(r.bottom, /GUI editor cursor, from this terminal's editor/); } },
  { id: 'workspace window: with no GUI editor anywhere W says to set the GUI editor', tab: 'observatory', keys: [K.down, 'W'], mentions: 'workspace window', cols: 200,
    prefs: { editor: 'nvim' }, env: { EDITOR: undefined, DISPLAY: ':synthetic' }, prep: onlyEditors('nvim'),
    check: r => { assert.deepEqual(r.editor, []); assert.match(r.bottom, /W needs a GUI editor — set GUI editor under o \(prefs\.guiEditor\)/); } },
  { id: 'workspace window: W prints the command over SSH without a GUI', tab: 'observatory', keys: [K.down, 'W'], mentions: 'workspace window', env: { SSH_CONNECTION: '192.0.2.1 1234 192.0.2.2 22', DISPLAY: undefined, WAYLAND_DISPLAY: undefined },
    check: r => { assert.deepEqual(r.editor, []); assert.match(r.bottom, /Run on the machine with the editor: code --remote ssh-remote\+/); } },
  { id: 'Observatory ? opens the help, over its own key row', tab: 'observatory', keys: ['?'], mentions: 'these keys',
    check: (r) => { assert.match(r.text, /keys {2}— {2}esc or \? to close/); assert.match(r.keysRow, /↵ pin/); assert.doesNotMatch(r.text, /F4 ▸Prompts|a\/u\/U/); } },
  { id: 'Observatory Review verbs do nothing (e, a)', tab: 'observatory', keys: [K.down, 'e', 'a', 'u'], unlisted: "Review's verbs are not the Observatory's",
    check: (r) => { untouched(r); assert.deepEqual(r.editor, []); } },
  { id: 'Observatory esc clears the selection', tab: 'observatory', keys: [K.down, K.esc], mentions: 'c / esc', check: status(/showing every worker again/) },
  { id: 'Observatory Tab goes to Review', tab: 'observatory', keys: [K.tab], mentions: 'Tab / shift+Tab', check: (r) => assert.match(r.keysRow, /F4-F7 window/) },
  // ---- herdr tab ----
  { id: 'herdr e reaches the program', tab: 'herdr', keys: ['e'], mentions: "Every key there but F1 to F3", check: (r) => { assert.equal(r.herdr, '65'); assert.deepEqual(r.editor, []); } },
  { id: 'herdr prefix m returns to OAK', tab: 'herdr', keys: [K.ctrl('b'), 'm'], help: 'ctrl+b m', check: (r) => { assert.equal(r.herdr, ''); assert.match(r.keysRow, /↵ pin/); } },
  { id: 'herdr prefix M pins the pane', tab: 'herdr', keys: [K.ctrl('b'), 'M'], help: 'ctrl+b M', check: (r) => assert.equal(r.herdr, '') },
  { id: "herdr prefix e is herdr's", tab: 'herdr', keys: [K.ctrl('b'), 'e'], mentions: "every other key is herdr's own", check: (r) => { assert.equal(r.herdr, '0265'); assert.deepEqual(r.editor, []); } },
  { id: 'herdr prefix twice sends the prefix', tab: 'herdr', keys: [K.ctrl('b'), K.ctrl('b')], mentions: 'pressed twice sends it to the program', check: (r) => assert.equal(r.herdr, '0202') },
  { id: 'herdr Tab reaches the program', tab: 'herdr', keys: [K.tab], mentions: "Every key there but F1 to F3", check: (r) => assert.equal(r.herdr, '09') },
  { id: 'herdr ctrl+q twice quits', tab: 'herdr', keys: [K.ctrl('q'), K.ctrl('q')], mentions: 'quit OAK from any tab', wait: 600, check: (r) => { assert.ok(r.exited); assert.equal(r.herdr, ''); } },
  // A single ctrl+q is the program's (emacs's quoted-insert): it waits out the quit window, or goes before the next key.
  { id: 'herdr ctrl+q once reaches the program when the quit window passes', tab: 'herdr', keys: [K.ctrl('q')], wait: 2600,
    mentions: 'Pressed once on the herdr tab, ctrl+q reaches the program', check: (r) => { assert.equal(r.herdr, '11'); assert.equal(r.exited, false); } },
  { id: 'herdr ctrl+q then another key sends both, in order, and does not quit', tab: 'herdr', keys: [K.ctrl('q'), 'x'], mentions: 'or before the next key you press there',
    check: (r) => { assert.equal(r.herdr, '1178'); assert.equal(r.exited, false); assert.doesNotMatch(r.bottom, /press ctrl\+q again/); } },
  // A prefix list holding super+ctrl+q holds no ctrl+q: after ctrl+b, ctrl+q is OAK's quit, as the key row says, not herdr's.
  { id: 'herdr prefixes ctrl+b and super+ctrl+q: ctrl+b then ctrl+q arms the quit and sends herdr nothing', tab: 'herdr',
    herdrConfig: '[keys]\nprefix = ["ctrl+b", "super+ctrl+q"]\n', keys: [K.ctrl('b'), K.ctrl('q')], mentions: 'quit OAK from any tab',
    check: (r) => { assert.equal(r.herdr, ''); assert.match(r.bottom, /press ctrl\+q again to exit/); assert.match(r.keysRow, /ctrl\+q ×2 quit/); } },
  // Nor is a chord of ctrl+q with shift or super OAK's quit: after the prefix it goes on to herdr, the prefix ahead of it.
  { id: 'herdr prefix then kitty ctrl+shift+q or super+ctrl+q goes on to herdr after the prefix', tab: 'herdr',
    keys: [K.ctrl('b'), '\x1b[113;6u', K.ctrl('b'), '\x1b[113;13u'], mentions: "every other key is herdr's own",
    check: (r) => assert.equal(r.herdr, Buffer.from('\x02\x1b[113;6u\x02\x1b[113;13u').toString('hex')) },
  // herdr's prefix pressed twice after it is its literal prefix: the program gets ctrl+q first (emacs's C-q C-b).
  { id: 'herdr ctrl+q then the prefix twice sends ctrl+q first', tab: 'herdr', keys: [K.ctrl('q'), K.ctrl('b'), K.ctrl('b')], mentions: 'or before the next key you press there',
    check: (r) => { assert.equal(r.herdr, '110202'); assert.equal(r.exited, false); } },
  // A click under herdr's screen reaches no program: the ctrl+q stays held, and the key after it still carries it.
  { id: "herdr ctrl+q then a click under herdr's screen keeps it for the next key", tab: 'herdr', mentions: 'or before the next key you press there',
    keys: [K.ctrl('q'), (child) => child.write('\x1b[<0;6;36M\x1b[<0;6;36m'), 'x', K.ctrl('q')], wait: 600,
    check: (r) => { assert.equal(r.exited, false, 'the ctrl+q after x armed the quit, not ended it'); assert.match(r.herdr, /^1178/); } },
  // A click herdr never receives drops a held prefix with it: sent on alone, it left herdr in prefix mode, and the
  // next key typed on its tab ran as a herdr command.
  { id: "herdr prefix then a click on OAK's tab bar sends herdr nothing", tab: 'herdr', mentions: "every other key is herdr's own",
    keys: [K.ctrl('b'), (child, { lines }) => { const x = lines()[0].indexOf('observatory') + 2; child.write(`\x1b[<0;${x};1M\x1b[<0;${x};1m`); }],
    check: (r) => { assert.equal(r.herdr, ''); assert.match(r.keysRow, /↵ pin/); } },
  { id: "herdr prefix then a click under herdr's screen drops the prefix", tab: 'herdr', mentions: "every other key is herdr's own",
    keys: [K.ctrl('b'), (child) => child.write('\x1b[<0;6;36M\x1b[<0;6;36m'), 'x'], check: (r) => assert.equal(r.herdr, '78') },
  // herdr's prefix then `m` goes back to the OAK tab left for herdr, the one the app opened on included.
  { id: 'herdr prefix m returns to the tab the app opened on', keys: [K.tab, (child, { until }) => until(/FAKE HERDR/), K.ctrl('b'), 'm'], mentions: 'back to the OAK tab you were last on',
    check: (r) => { assert.equal(r.herdr, ''); assert.match(r.keysRow, /F4-F7 window/); } },
  // `M` is the way back when herdr's config takes `m`: with no session to pin it still goes back, and says why.
  { id: "herdr prefix M with no session to pin goes to OAK's tabs and says why", tab: 'herdr', keys: [K.ctrl('b'), 'M'], wait: 800,
    mentions: "pin its focused pane's session", check: (r) => { assert.equal(r.herdr, ''); assert.match(r.keysRow, /↵ pin/); assert.match(r.bottom, /herdr/); } },
  // V opens Review on herdr's focused pane's session (local or a saved machine's: observatory.js); with no session to
  // review it still goes to OAK's tabs, and says why, as M does.
  { id: "herdr prefix V with no session to review goes to OAK's tabs and says why", tab: 'herdr', keys: [K.ctrl('b'), 'V'], wait: 800,
    help: 'ctrl+b V', check: (r) => { assert.equal(r.herdr, ''); assert.match(r.keysRow, /↵ pin/); assert.match(r.bottom, /herdr/); } },
  { id: "herdr prefix V bound in herdr's config is herdr's", tab: 'herdr', herdrConfig: '[keys]\nnew_tab = "prefix+shift+v"\n', keys: [K.ctrl('b'), 'V'],
    mentions: "read from herdr's config", check: (r) => { assert.equal(r.herdr, '0256'); assert.match(r.keysRow, /ctrl\+b m OAK's tabs/); } },
  // herdr 0.9.3 takes several prefixes: each is one, and the key row names them all.
  { id: 'herdr either of two prefixes, then m, returns to OAK', tab: 'herdr', herdrConfig: '[keys]\nprefix = ["ctrl+space", "ctrl+s"]\n', keys: [K.ctrl('s'), 'm'],
    mentions: "read from herdr's config", check: (r) => { assert.equal(r.herdr, ''); assert.match(r.keysRow, /↵ pin/); } },
  { id: 'herdr the other prefix of two goes on to herdr with the next key; the key row names both', tab: 'herdr', herdrConfig: '[keys]\nprefix = ["ctrl+space", "ctrl+s"]\n',
    keys: ['\x00', 'x'], mentions: "read from herdr's config", check: (r) => { assert.equal(r.herdr, '0078'); assert.match(r.keysRow, /ctrl\+space or ctrl\+s m OAK/); } },
  // herdr 0.9.1, the client that applies the prefix, refuses a list of them and runs on its defaults: so does OAK.
  { id: 'herdr 0.9.1 with a list of prefixes: ctrl+b, then m, returns to OAK', tab: 'herdr', env: { FAKE_HERDR_VERSION: '0.9.1' },
    herdrConfig: '[keys]\nprefix = ["ctrl+space", "ctrl+s"]\n', keys: [K.ctrl('s'), K.ctrl('b'), 'm'], mentions: "read from herdr's config",
    check: (r) => { assert.equal(r.herdr, '13'); assert.match(r.keysRow, /↵ pin/); } },
  // Shift on a key that is not a letter is part of it, as herdr 0.9.1 to 0.9.3 read it: ctrl+shift+space is only the kitty
  // protocol's 32;6u, never NUL (which a terminal without the protocol sends for it, as for ctrl+space), nor 32;5u.
  { id: 'herdr prefix ctrl+shift+space: NUL is ctrl+space, which goes on to herdr with the key after it', tab: 'herdr', cols: 140,
    herdrConfig: '[keys]\nprefix = "ctrl+shift+space"\n', keys: ['\x00', 'm'], mentions: "read from herdr's config",
    check: (r) => { assert.equal(r.herdr, '006d'); assert.match(r.keysRow, /ctrl\+shift\+space is herdr's prefix · click OAK's tab bar to leave/); } },
  { id: 'herdr prefix ctrl+shift+space through the kitty protocol, then m, returns to OAK', tab: 'herdr',
    herdrConfig: '[keys]\nprefix = "ctrl+shift+space"\n', keys: ['\x1b[32;6u', 'm'], mentions: "read from herdr's config",
    check: (r) => { assert.equal(r.herdr, ''); assert.match(r.keysRow, /↵ pin/); } },
  { id: 'herdr prefix ctrl+space: kitty ctrl+shift+space is another key, which goes on to herdr', tab: 'herdr',
    herdrConfig: '[keys]\nprefix = "ctrl+space"\n', keys: ['\x1b[32;6u', 'm'], mentions: "read from herdr's config",
    check: (r) => assert.equal(r.herdr, Buffer.from('\x1b[32;6um').toString('hex')) },
  { id: 'herdr prefix shift+f5: F5 goes on to herdr; shift+F5, then m, returns to OAK', tab: 'herdr', herdrConfig: '[keys]\nprefix = "shift+f5"\n',
    keys: [K.f5, 'm', '\x1b[15;2~', 'm'], mentions: "read from herdr's config",
    check: (r) => { assert.equal(r.herdr, Buffer.from(`${K.f5}m`).toString('hex')); assert.match(r.keysRow, /↵ pin/); } },
  // super+b reaches the app through the kitty protocol, and herdr takes it as its prefix there: so does OAK. Neither it nor
  // Ctrl+A (ctrl+shift+a to herdr) comes from a terminal without the protocol, so the key row says to click, and every row
  // names the prefix as herdr does.
  { id: 'herdr prefix super+b through the kitty protocol, then m, returns to OAK', tab: 'herdr', herdrConfig: '[keys]\nprefix = "super+b"\n',
    keys: ['\x1b[98;9u', 'm'], mentions: "read from herdr's config", check: (r) => { assert.equal(r.herdr, ''); assert.match(r.keysRow, /↵ pin/); } },
  { id: 'herdr prefix Ctrl+A is named ctrl+shift+a, as herdr names it, on the status and key rows', tab: 'herdr', herdrConfig: '[keys]\nprefix = "Ctrl+A"\n',
    keys: ['\x1b[97;6u'], mentions: "read from herdr's config", cols: 140,
    check: (r) => { assert.match(r.bottom, /ctrl\+shift\+a — m OAK tabs · M Observatory · V Review · F1–F3 herdr\/Observatory\/Review · any other key is herdr's/);
      assert.match(r.keysRow, /ctrl\+shift\+a is herdr's prefix · click OAK's tab bar to leave/); assert.equal(r.herdr, ''); } },
  // A super or hyper chord is never herdr's default prefix: it goes on to herdr, and so does the m after it.
  { id: 'herdr default prefix: kitty super+ctrl+b and hyper+ctrl+b go on to herdr with the m after them', tab: 'herdr',
    keys: ['\x1b[98;13u', 'm', '\x1b[98;21u', 'm'], mentions: "read from herdr's config",
    check: (r) => assert.equal(r.herdr, Buffer.from('\x1b[98;13um\x1b[98;21um').toString('hex')) },
  // The kitty protocol reports shift+tab as tab with shift (9;2u), and a shifted symbol with its base key and shift when
  // herdr asks for alternate keys (alt+! as 49:33;4u): herdr takes both for those prefixes, and so does OAK.
  { id: 'herdr prefix shift+tab through the kitty protocol (9;2u), then m, returns to OAK', tab: 'herdr', herdrConfig: '[keys]\nprefix = "shift+tab"\n',
    keys: ['\x1b[9;2u', 'm'], mentions: "read from herdr's config", check: (r) => { assert.equal(r.herdr, ''); assert.match(r.keysRow, /↵ pin/); } },
  { id: 'herdr prefix alt+! as alt+shift+1 with its alternate key (49:33;4u), then m, returns to OAK', tab: 'herdr', herdrConfig: '[keys]\nprefix = "alt+!"\n',
    keys: ['\x1b[49:33;4u', 'm'], mentions: "read from herdr's config", check: (r) => { assert.equal(r.herdr, ''); assert.match(r.keysRow, /↵ pin/); } },
  // Enter is 0x0d, which herdr reads as enter, never as ctrl+m: it goes on with the m after it, and the key row says to click.
  { id: 'herdr prefix ctrl+m: Enter (0x0d) goes on to herdr with the m after it', tab: 'herdr', herdrConfig: '[keys]\nprefix = "ctrl+m"\n',
    keys: ['\r', 'm'], mentions: "read from herdr's config", cols: 140,
    check: (r) => { assert.equal(r.herdr, '0d6d'); assert.match(r.keysRow, /ctrl\+m is herdr's prefix · click OAK's tab bar to leave/); } },
  // herdr reads 0x08 as ctrl+h, never as backspace, which OAK's decoder names it: for a prefix of backspace, 0x08 goes on to herdr
  // with the m after it, and DEL, then m, returns to OAK.
  { id: 'herdr prefix backspace: 0x08 goes on to herdr with the m after it; DEL, then m, returns to OAK', tab: 'herdr',
    herdrConfig: '[keys]\nprefix = "backspace"\n', keys: ['\x08', 'm', '\x7f', 'm'], mentions: "read from herdr's config",
    check: (r) => { assert.equal(r.herdr, '086d'); assert.match(r.keysRow, /↵ pin/); } },
  // herdr reads ctrl+double_quote as ctrl+" (here ctrl+shift+' with its alternate key, 39:34;6u): ctrl+b is not its prefix.
  { id: "herdr prefix ctrl+double_quote: ctrl+b goes on to herdr; ctrl+shift+' (39:34;6u), then m, returns to OAK", tab: 'herdr',
    herdrConfig: '[keys]\nprefix = "ctrl+double_quote"\n', keys: [K.ctrl('b'), 'x', '\x1b[39:34;6u', 'm'], mentions: "read from herdr's config",
    check: (r) => { assert.equal(r.herdr, '0278'); assert.match(r.keysRow, /↵ pin/); } },
  // At 40 columns the status after the prefix and the key row keep every key, in fewer words, each part whole.
  { id: 'herdr prefix at 40 columns: the status and the key row name the keys in fewer words', tab: 'herdr', cols: 40, keys: [K.ctrl('b')],
    mentions: "read from herdr's config", check: (r) => {
      assert.match(r.bottom, /^ctrl\+b — m\/M\/V · F1–F3 OAK tabs *$/m);
      assert.match(r.keysRow, /^ctrl\+b m or F1–F3 OAK tabs · \^Q ×2 quit *$/);
    } },
  // With m, M and V all herdr's, the tab keys are the way back by key, and the status and key rows say so.
  { id: 'herdr prefix with m, M and V bound in herdr offers the tab keys', tab: 'herdr', herdrConfig: '[keys]\nnew_tab = ["prefix+m", "prefix+shift+m", "prefix+shift+v"]\n',
    keys: [K.ctrl('b')], mentions: "read from herdr's config",
    check: (r) => { assert.match(r.bottom, /ctrl\+b — F1–F3 herdr\/Observatory\/Review · any other key is herdr's/); assert.match(r.keysRow, /click OAK's tab bar to leave · F1–F3 OAK tabs/); } },
  // With those and the tab keys herdr's too, only a click leaves, and the status and key rows say so.
  { id: 'herdr prefix with m, M, V and F1 to F3 bound in herdr says to click', tab: 'herdr',
    herdrConfig: '[keys]\nnew_tab = ["prefix+m", "prefix+shift+m", "prefix+shift+v", "prefix+f1", "prefix+f2", "prefix+f3"]\nnext_tab = ["f1", "f2", "f3"]\n', keys: [K.ctrl('b')], mentions: "read from herdr's config",
    check: (r) => { assert.match(r.bottom, /ctrl\+b — click OAK's tab bar to leave · any other key is herdr's/); assert.match(r.keysRow, /click OAK's tab bar to leave/); assert.doesNotMatch(r.keysRow, /F1/); } },
  // ---- tab keys: F1 the herdr tab, F2 the Observatory, F3 Review, from every tab ----
  { id: 'F2 raises the Observatory from Review', keys: [K.f2], help: 'F1 / F2 / F3', check: (r) => assert.match(r.keysRow, /↵ pin/) },
  { id: 'F1 raises the herdr tab from Review', keys: [K.f1], done: /ctrl\+b m OAK's tabs/,
    mentions: 'herdr / Observatory / Review, from every tab', check: (r) => assert.match(r.keysRow, /ctrl\+b m OAK's tabs/) },
  { id: "F1 from Review waits for herdr's version probe before checking its key row", keys: [K.f1], env: { FAKE_HERDR_VERSION_DELAY: '1200' },
    done: /ctrl\+b m OAK's tabs/, mentions: 'herdr / Observatory / Review, from every tab', check: (r) => assert.match(r.keysRow, /ctrl\+b m OAK's tabs/) },
  { id: 'F3 raises Review from the Observatory', tab: 'observatory', keys: [K.f3], mentions: 'herdr / Observatory / Review, from every tab', check: (r) => assert.match(r.keysRow, /F4-F7 window/) },
  { id: 'F1 raises the herdr tab from the Observatory', tab: 'observatory', keys: [K.f1], done: /ctrl\+b m OAK's tabs/,
    mentions: 'herdr / Observatory / Review, from every tab', check: (r) => assert.match(r.keysRow, /ctrl\+b m OAK's tabs/) },
  { id: 'herdr F2 raises the Observatory, and herdr gets nothing', tab: 'herdr', keys: [K.f2], mentions: 'on the herdr tab before herdr or the program sees them',
    check: (r) => { assert.equal(r.herdr, ''); assert.match(r.keysRow, /↵ pin/); } },
  { id: 'herdr F3 raises Review, and herdr gets nothing', tab: 'herdr', keys: [K.f3], mentions: 'on the herdr tab before herdr or the program sees them',
    check: (r) => { assert.equal(r.herdr, ''); assert.match(r.keysRow, /F4-F7 window/); } },
  // The kitty protocol's F3 (CSI 13~) with event types, as herdr asks for them: the press raises Review, and its release
  // reaches no one.
  { id: 'herdr kitty F3, press then release, raises Review and herdr gets neither', tab: 'herdr', keys: ['\x1b[13;1:1~', '\x1b[13;1:3~'],
    mentions: 'on the herdr tab before herdr or the program sees them', check: (r) => { assert.equal(r.herdr, ''); assert.match(r.keysRow, /F4-F7 window/); } },
  { id: 'herdr F1 on its own tab reaches no one', tab: 'herdr', keys: [K.f1, '\x1b[1;1:3P', 'x'], mentions: 'on the herdr tab before herdr or the program sees them',
    check: (r) => { assert.equal(r.herdr, '78'); assert.match(r.keysRow, /ctrl\+b m OAK's tabs/); } },
  { id: 'herdr prefix then F2 raises the Observatory, the prefix dropped', tab: 'herdr', keys: [K.ctrl('b'), K.f2], mentions: "with herdr's prefix or without",
    check: (r) => { assert.equal(r.herdr, ''); assert.match(r.keysRow, /↵ pin/); } },
  // With shift, ctrl, alt or super an F-key is another key: it reaches the program unchanged.
  { id: 'herdr shift+F2, ctrl+F1, alt+F3 and super+F2 reach the program unchanged', tab: 'herdr', keys: ['\x1b[1;2Q', '\x1b[1;5P', '\x1b[13;3~', '\x1b[1;9Q'],
    mentions: 'on the herdr tab before herdr or the program sees them',
    check: (r) => { assert.equal(r.herdr, Buffer.from('\x1b[1;2Q\x1b[1;5P\x1b[13;3~\x1b[1;9Q').toString('hex')); assert.match(r.keysRow, /ctrl\+b m OAK's tabs/); } },
  { id: "herdr F2 bound in herdr's config is herdr's", tab: 'herdr', herdrConfig: '[keys]\nnext_tab = "f2"\n', keys: [K.f2], mentions: "unless herdr's config binds the key",
    check: (r) => { assert.equal(r.herdr, Buffer.from(K.f2).toString('hex')); assert.match(r.keysRow, / F3 (Review|OAK tabs) /); assert.doesNotMatch(r.keysRow, /F1/); } },
  { id: "herdr prefix f2: F2 is herdr's prefix, and m after it returns to OAK", tab: 'herdr', herdrConfig: '[keys]\nprefix = "f2"\n', keys: [K.f2, 'm'],
    mentions: "unless herdr's config binds the key", check: (r) => { assert.equal(r.herdr, ''); assert.match(r.keysRow, /↵ pin/); } },
  { id: "herdr prefix+f3 bound in herdr's config: the prefix then F3 is herdr's", tab: 'herdr', herdrConfig: '[keys]\nnew_tab = "prefix+f3"\n', keys: [K.ctrl('b'), K.f3],
    mentions: "unless herdr's config binds the key", check: (r) => { assert.equal(r.herdr, '02' + Buffer.from(K.f3).toString('hex')); assert.match(r.keysRow, /F1–F3 OAK tabs/); } },
  // Every form a terminal sends: xterm's SS3 (above), rxvt's CSI 11~ to 13~, the kitty protocol's CSI P and Q, and the Linux
  // console's ESC [[A to [[C.
  { id: "rxvt's F3 (CSI 13~) raises Review from the Observatory", tab: 'observatory', keys: ['\x1b[13~'], mentions: 'herdr / Observatory / Review, from every tab', check: (r) => assert.match(r.keysRow, /F4-F7 window/) },
  { id: "rxvt's F2 (CSI 12~) raises the Observatory", keys: ['\x1b[12~'], mentions: 'herdr / Observatory / Review, from every tab', check: (r) => assert.match(r.keysRow, /↵ pin/) },
  { id: "the kitty protocol's F2 (CSI Q) raises the Observatory", keys: ['\x1b[Q'], mentions: 'herdr / Observatory / Review, from every tab', check: (r) => assert.match(r.keysRow, /↵ pin/) },
  { id: "the Linux console's F2 (ESC [[B) raises the Observatory", keys: ['\x1b[[B'], mentions: 'herdr / Observatory / Review, from every tab', check: (r) => { untouched(r); assert.match(r.keysRow, /↵ pin/); } },
  { id: "the Linux console's F3 (ESC [[C) raises Review from the herdr tab", tab: 'herdr', keys: ['\x1b[[C'], mentions: 'on the herdr tab before herdr or the program sees them',
    check: (r) => { assert.equal(r.herdr, ''); assert.match(r.keysRow, /F4-F7 window/); } },
  { id: 'shift+F2 on Review is no tab key, and says it is no window key either', keys: ['\x1b[1;2Q'], mentions: 'herdr / Observatory / Review, from every tab',
    check: status(/F2 is not a window key — F4 to F7 focus Prompts, Traces, Map and Diff/) },
  { id: 'F2 over the help closes it and raises the Observatory', keys: ['?', K.f2], mentions: 'over every overlay, which closes first',
    check: (r) => { assert.match(r.keysRow, /↵ pin/); assert.doesNotMatch(r.text, /esc or \? to close/); } },
  { id: 'F2 from the empty palette closes it and raises the Observatory', keys: [':', K.f2], mentions: 'over every overlay, which closes first',
    check: (r) => { assert.match(r.keysRow, /↵ pin/); assert.doesNotMatch(r.text, /a command, or type to find/); } },
  // A box holding text you typed closes as esc would, and its text goes with it: no tab key is held back for it.
  { id: 'F2 with text typed in the palette closes it, text and all, and raises the Observatory', keys: [':', 's', K.f2], mentions: 'A box you typed in closes and drops the text',
    check: (r) => { assert.match(r.keysRow, /↵ pin/); assert.doesNotMatch(r.text, /a command, or type to find|: s▏/); } },
  { id: 'F2 with a search typed in the session picker closes it, search and all, and raises the Observatory', keys: ['b', 'k', K.f2], mentions: 'A box you typed in closes and drops the text',
    check: (r) => { assert.match(r.keysRow, /↵ pin/); assert.doesNotMatch(r.text, /type to search|^search k▏/m); } },
  { id: 'F2 with find in the diff typed closes it and raises the Observatory', keys: [...OPEN_B, K.f7, '/', 'T', K.f2], mentions: 'A box you typed in closes and drops the text',
    check: (r) => { assert.match(r.keysRow, /↵ pin/); assert.doesNotMatch(r.bottom, /find in diff/); } },
  { id: 'F2 then F3 over find in the diff comes back to Review with the find closed, its text off the status row', keys: [...OPEN_B, K.f7, '/', 'T', K.f2, K.f3],
    mentions: 'A box you typed in closes and drops the text', check: (r) => { untouched(r); assert.match(r.keysRow, /F4-F7 window/); assert.doesNotMatch(r.bottom, /find in diff/); } },
  // The question keeps the status row, so it is what the reader sees: still on Review, still asked.
  { id: 'F2 under a standing question holds', keys: ['A', K.f2], mentions: 'standing question keeps them until you answer it',
    check: (r) => { untouched(r); assert.match(r.bottom, /keep 2 edit\(s\) — every row listed on edits\?  \[y\/n\]/); assert.match(r.keysRow, /F4-F7 window/); } },
  { id: 'F2 then F3 keeps the / filter on its tab', keys: ['/', 'u', K.f2, K.f3], mentions: 'herdr / Observatory / Review, from every tab',
    check: (r) => { untouched(r); assert.match(r.keysRow, /^\/u *$/); } },
  // ---- overlays ----
  { id: 'the help closes on q', keys: ['?', 'q'], mentions: 'esc or q closes', check: (r) => assert.doesNotMatch(r.text, /esc or \? to close/) },
  { id: 'the help closes on ?', keys: ['?', '?'], mentions: 'esc or q closes', check: (r) => assert.doesNotMatch(r.text, /esc or \? to close/) },
  { id: 'the help takes a verb without acting', keys: [...OPEN_B, '?', 'u', 'e'], mentions: 'Enter chooses, esc or q closes', check: (r) => { untouched(r); assert.deepEqual(r.editor, []); } },
  { id: 'the help filters on /', keys: ['?', '/', ...'edit'], mentions: 'the help filter type', check: (r) => assert.match(r.text, /\/edit_ filters/) },
  { id: 'the palette takes a paste', keys: [':', PASTE('stat')], mentions: 'paste into the reply box, a filter, the palette', check: (r) => assert.match(r.text, /: stat▏/) },
  { id: 'the help filter takes a paste', keys: ['?', '/', PASTE('edit')], mentions: 'paste into the reply box, a filter, the palette', check: (r) => assert.match(r.text, /\/edit_ filters/) },
  { id: 'find in the diff takes a paste', keys: [...OPEN_B, K.f7, '/', PASTE('TWO'), K.enter], mentions: 'paste into the reply box, a filter, the palette',
    check: status(/“TWO” — line \d+ of \d+/) },
  { id: 'the palette closes on esc', keys: [':', K.esc], mentions: 'so q is text there', check: (r) => assert.doesNotMatch(r.text, /a command, or type to find/) },
  { id: 'the session picker types', keys: ['b', 'k', 'e'], mentions: 'type to search names and what was said', check: (r) => { assert.match(r.text, /^search ke▏/m); assert.deepEqual(r.editor, []); } },
  { id: 'the session picker opens with the session in effect drawn and marked, below a screen of newer ones', rows: 30, prep: newerSessions(40), keys: ['b'], wait: 600,
    mentions: 'choose a session, here or on a saved machine', check: (r) => { assert.match(r.selected, /^\* /); assert.match(r.screen[r.selRows[0]], /^ \* .* 2 pending/, 'the cursor is on keysSess, the session in effect'); } },
  // The band runs the whole row: the row's dimmed time and tinted counts close with resets, which ended it after the time.
  { id: 'the session picker bands the whole selected row, its name and counts too', keys: ['b'], mentions: 'choose a session, here or on a saved machine',
    check: (r) => assert.match(r.selected, /^\* \S+ +New Claude session +this machine +\+2 −2 +2 pending/) },
  { id: 'the session picker Tab cycles the state', keys: ['b', K.tab], mentions: 'choose a session, here or on a saved machine', check: (r) => assert.match(r.text, /\[working\]/) },
  { id: 'Observatory: the session picker types', tab: 'observatory', keys: ['b', 'k', 'e'], mentions: 'type to search names and what was said', check: (r) => { assert.match(r.text, /^search ke▏/m); assert.deepEqual(r.editor, []); } },
  { id: 'the options close on q', keys: ['o', 'q'], mentions: 'esc or q closes', check: (r) => assert.doesNotMatch(r.text, /options {2}— {2}↑↓ move/) },
  { id: 'the options move on ↓', keys: ['o', K.down], mentions: 'options (editor, display, store, sync, keys)', check: (r) => assert.match(r.text, /options {2}— {2}↑↓ move/) },
  (() => {
    let fx;
    return { id: 'the options GUI editor row steps Auto and the GUI editors found here, and keeps the choice', mentions: 'options (editor, display, store, sync, keys)', cols: 160,
      prep: (f) => { fx = f; onlyEditors('code', 'cursor', 'nvim')(f); },
      keys: ['o', toOption('GUI editor'), K.right, K.right],
      check: (r) => {
        assert.match(r.text, /Terminal editor +/, 'the terminal editor row, renamed');
        assert.match(r.text, /GUI editor +cursor/);
        const prefs = JSON.parse(fs.readFileSync(path.join(fx.home, '.claude/claude-observatory/prefs.json'), 'utf8'));
        assert.equal(prefs.guiEditor, 'cursor', 'Auto → code → cursor, written to prefs.json');
        assert.equal(prefs.editor, undefined, 'the terminal editor is its own setting');
      } };
  })(),
  // ---- oak sync, through the real CLI: its state shows, its conflict resolves, setup gets the terminal, a run runs ----
  (() => {
    let sw;
    return { id: 'Observatory: sync\'s last run shows under this machine; i lists its conflict, and Enter, ↓, Enter, y deletes the copy through oak sync resolve',
      // The check reads the screen taken before the keys, and the machine's [W window] is drawn from the same session list
      // as the session's `ws` row: on a slow runner sync's rows paint seconds before it, so the row waits for both.
      tab: 'observatory', ready: /^(?=[\s\S]*backup · none)(?=[\s\S]*^ {7}ws +│)/m, prep: (fx) => { sw = syncWorld(fx); }, mentions: 'then oak sync\'s open conflicts', wait: 1200,
      before: ({ screen }) => screen.join('\n'), keys: ['i', K.enter, K.down, K.enter, 'y'],
      check: (r) => {
        // The master's column alone, its wrapped rows joined: the conversation pane is beside it.
        const master = r.snap.split('\n').map((l) => l.split('│')[0].trim()).join(' ').replace(/\s+/g, ' ');
        assert.match(master, /workstation ✗ \[W window\] sync · last run \d\d:\d\d:\d\d \(ok\) · 1 conflict in the inbox backup · none: each session stays on the machine that made it/);
        assert.ok(!fs.existsSync(sw.copy), 'the copy left conflicts/');
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sw.sync, 'conflicts.json'), 'utf8')), [], 'and the conflict is closed');
        assert.equal(fs.readFileSync(sw.file, 'utf8'), 'one\nleft\n', 'yours stands');
        assert.match(r.bottom, /resolved: build-box's copy of m\.md is in sync's trash, and yours stands/);
      } };
  })(),
  (() => {
    let sw;
    return { id: 'a sync conflict\'s first way out opens both copies in the editor', prep: (fx) => { sw = syncWorld(fx); }, mentions: 'or opens a conflict', wait: 600,
      keys: ['i', K.enter, K.enter], check: (r) => assert.deepEqual(r.editor, [['code', sw.file, sw.copy]]) };
  })(),
  (() => {
    let fx;
    // ctrl+d at the prompt used to end stdin (the prompt read with the terminal not raw), and nothing could answer it again.
    return { id: 'ctrl+d at the "back to OAK" prompt goes back as Enter does (review 2026-11-05)',
      prep: (f) => { fx = f; syncWorld(f); }, mentions: 'options (editor, display, store, sync, keys)', wait: 800,
      keys: ['o', toOption('Backup'), K.enter, (c, { until }) => until(/Choose 1, 2 or 3/), '1', K.enter, (c, { until }) => until(/Press Enter to go back to OAK/), '\x04'],
      check: (r) => {
        assert.match(r.bottom, /back from oak sync setup/, 'OAK took the terminal back');
        assert.equal(r.exited, false);
      } };
  })(),
  (() => {
    let fx;
    return { id: 'the options Backup row hands the terminal to oak sync setup, which asks; its last words stay until Enter',
      prep: (f) => { fx = f; syncWorld(f); }, mentions: 'options (editor, display, store, sync, keys)', wait: 800,
      keys: ['o', toOption('Backup'), K.enter, (c, { until }) => until(/Choose 1, 2 or 3/), '1', K.enter, (c, { until }) => until(/Press Enter to go back to OAK/), K.enter],
      check: (r) => {
        const prefs = JSON.parse(fs.readFileSync(path.join(fx.home, '.claude/claude-observatory/prefs.json'), 'utf8'));
        assert.equal(typeof prefs.sync?.setupAt, 'number', 'setup ran, and recorded that it did');
        const shown = r.raw.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
        assert.match(shown, /oak sync setup: where the agents' sessions are backed up/, shown.slice(-4000));
        assert.match(r.bottom, /back from oak sync setup/);
        assert.equal(r.exited, false);
      } };
  })(),
  (() => {
    let share;
    return { id: 'the options Sync now row runs oak sync now and shows what the run did', mentions: 'options (editor, display, store, sync, keys)', wait: 2500,
      keys: ['o', toOption('Sync now'), K.enter],
      prep: (fx) => { share = path.join(fx.dir, 'share'); cp.execFileSync(process.execPath, [CLI, 'sync', 'setup', '--folder', share, '--json'], { cwd: fx.ws, env: fx.env }); },
      check: (r) => {
        assert.match(r.text, /oak sync: nothing to pull/);
        assert.ok(r.text.includes(`backup (${share})`), r.text);
        assert.match(r.text, /backup \(.*share\) +\d+ files? written, \d+(B|KB)/);
      } };
  })(),
  { id: ':doctor shows oak sync\'s rows and the local index\'s, each with its fix', prep: syncWorld, mentions: 'type a command (status, doctor',
    keys: [':', ...'doctor', K.enter, (c, { until }) => until(/doctor\s+—\s+esc to close/, 20000), 'G'],
    wait: 2500, check: (r) => {
      // Read whole: a row the overlay wraps goes on after a ▸.
      const text = r.text.replace(/\s*▸/g, ' ').replace(/\s+/g, ' ');
      assert.match(text, /oak sync last run \d\d:\d\d:\d\d; 1 conflict open → Run `oak sync status` to see each conflict copy, and resolve it by editing your file or deleting the copy \(`oak sync resolve <id>`\)\./);
      assert.match(text, /Claude Code transcript retention cleanupPeriodDays is not set[^→]*→ Set "cleanupPeriodDays": 3650/);
      assert.match(text, /Local database/);
    } },
  { id: 'a machine with no saved machine and no sync shows no SYNC options', keys: ['o', ...Array(22).fill(K.down)], mentions: 'options (editor, display, store, sync, keys)',
    check: (r) => { assert.match(r.text, /Cooldown[\s\S]*KEYS/, 'the place a SYNC section would be is on screen'); assert.doesNotMatch(r.text, /SYNC|Sync now/); } },
  { id: 'the filter options toggle a bucket on x', keys: ['\\', K.down, 'x'], mentions: 'the file-type / extension buckets', check: (r) => assert.match(r.text, /filter: \.ts/) },
  { id: 'the filter options close on esc', keys: ['\\', K.esc], mentions: 'filter options', check: (r) => assert.doesNotMatch(r.text, /space toggles/) },
  { id: 'the go-to-file list takes a verb without acting', keys: ['P', 'a'], mentions: 'a picker, not a filter', check: (r) => { untouched(r); assert.match(r.text, /go to file/); } },
  // An overlay scrolls to its last line under the chrome it is drawn below, with long lines wrapped (the help's
  // last line is two lines at 80 columns, and the lines above it wrap too).
  { id: 'G in the help shows its last line', cols: 80, rows: 24, keys: ['?', 'G'], mentions: 'g / G', check: (r) => assert.match(r.text, /how you\s+(?:▸)?leave a mode\./) },
  { id: 'the filter options keep the selected row on a short terminal', cols: 80, rows: 13, ready: /b\.ts/, keys: ['\\', K.down], mentions: 'the file-type / extension buckets', check: (r) => assert.match(r.selected, /^\[ \] \.ts$/) },
  { id: 'the filter types a verb as text', keys: [...OPEN_B, '/', 'u'], mentions: 'filter this tab', check: (r) => { untouched(r); assert.match(r.keysRow, /^\/u_/); } },
];

it('options navigation waits for the selected row despite unrelated redraws', async () => {
  const labels = ['Colour', 'Backup', 'Sync now', 'Sync this project'];
  let cursor = 0, redraw = 0;
  const lines = () => [`  ▸ ${labels[cursor]}    value`, `status redraw ${redraw++}`];
  const child = { write: (key) => queueMicrotask(() => {
    cursor = Math.max(0, Math.min(labels.length - 1, cursor + (key === K.down ? 1 : -1)));
  }) };
  await toOption('Sync now')(child, { lines });
  await new Promise(setImmediate);
  assert.equal(labels[cursor], 'Sync now', 'no extra arrow is still in flight when Enter follows');
});

describe('every terminal-app key, pressed in a real PTY', { skip, concurrency: Math.min(8, Math.max(4, os.cpus().length - 1)) }, () => {
  for (const row of ROWS_TABLE) {
    it(row.id, { timeout: 60000 }, async () => {
      await drive(row);
    });
  }
});

describe('the ? help and the key table agree', () => {
  const { helpLines } = require('../dist');
  const core = require('../../core/dist');
  const help = helpLines({}, core.herdrPrefixFrom(''));
  const text = help.join('\n');
  // Rows of the help that describe the mouse or a tab rather than name a key.
  const PROSE = /^(herdr|Observatory|Review|click |buttons|drag |xterm;|\(a single|Other ctrl chords|herdr tab they)/;
  const columns = help.map((l) => /^ {4}(\S.*?)(?:\s{2,}|$)/.exec(l)?.[1]).filter((k) => k && !PROSE.test(k));
  it('every key the help lists has a row that presses it', () => {
    const covered = new Set(ROWS_TABLE.map((r) => r.help).filter(Boolean));
    assert.deepEqual(columns.filter((k) => !covered.has(k)), []);
  });
  it('every row names its entry in the help, or why it has none', () => {
    for (const row of ROWS_TABLE) {
      assert.ok(row.help || row.mentions || row.unlisted, `${row.id} names its help entry`);
      if (row.help) assert.ok(columns.includes(row.help), `${row.id}: the help lists ${JSON.stringify(row.help)}`);
      if (row.mentions) assert.ok(text.includes(row.mentions), `${row.id}: the help says ${JSON.stringify(row.mentions)}`);
    }
  });
});
