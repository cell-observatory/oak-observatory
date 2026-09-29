// A real, disposable herdr server shared by both media builders. No model process is started.
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, openSync, closeSync } from 'node:fs';
import { dirname, delimiter, join } from 'node:path';
const require = createRequire(import.meta.url);
const core = require('../packages/core/dist');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function validateFrame(frame, { conversation = false, herdr = false } = {}) {
  const text = frame.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  if (!text.trim() || /not reachable|could not launch|not installed|doctor --fix/i.test(text))
    throw new Error('TUI media has no healthy live frame; existing media was not replaced.');
  // CURRENCY, not only health. Every published TUI still showed the retired `[+]` tab a day after it
  // was removed, because nothing here asked WHICH product the frame came from. The three fixed tab
  // names with no `[+]` cell are the cheapest fingerprint of the current bar.
  if (!(/\bherdr\b/.test(text) && /\bobservatory\b/i.test(text) && /\breview\b/i.test(text)) || text.includes('[+]'))
    throw new Error('TUI media shows a retired tab bar (missing a fixed tab name, or a [+] cell); existing media was not replaced.');
  if (conversation && (/Select a session|Enter pins this conversation|loading conversation|No conversation events yet/i.test(text)
    // The detail opens at the NEWEST event, so its header (`↗ herdr`) scrolls away in a long
    // conversation; the pinned-detail hint line (`i reply`) is on every frame with a live pane.
    || !text.includes('workstation') || !(text.includes('↗ herdr') || /\bi reply\b/.test(text))))
    throw new Error('TUI media needs a pinned demo conversation; existing media was not replaced.');
  if (herdr && (/mouse-first|[↵⏎].*continue|integrations/i.test(text) || !text.includes('OAK demo · disposable session')))
    throw new Error('herdr media still shows onboarding or has no seeded pane; existing media was not replaced.');
  return frame;
}

export async function startCaptureServer(binary, home, cwd) {
  if (!binary) throw new Error('Install the pinned herdr with oak doctor --fix before capturing TUI media.');
  const env = { ...process.env, PATH: dirname(binary) + delimiter + process.env.PATH,
    SHELL: '/bin/sh', ZDOTDIR: home, OAK_NO_SERVER: '1', TERM: 'xterm-256color' };
  const log = join(home, 'capture-herdr.log'), fd = openSync(log, 'w');
  let server;
  try { server = spawn(binary, ['server'], { cwd, env, stdio: ['ignore', fd, fd] }); }
  finally { closeSync(fd); }
  let failed;
  server.on('error', error => { failed = error; });
  server.on('exit', code => { failed ??= new Error(`herdr server exited ${code}`); });
  let stopping;
  const stop = () => stopping ??= new Promise(resolve => {
    if (server.exitCode != null || server.signalCode != null || (failed && !server.pid)) return resolve();
    const timer = setTimeout(() => { try { server.kill('SIGKILL'); } catch {} resolve(); }, 2000);
    server.once('close', () => { clearTimeout(timer); resolve(); });
    try { server.kill(); } catch { clearTimeout(timer); resolve(); }
  });
  try {
    let ready = false, lastError;
    for (let i = 0; i < 50; i++) {
      if (failed) throw failed;
      try { await core.herdrSnapshot({ timeoutMs: 200 }); ready = true; break; }
      catch (error) { lastError = error; await pause(100); }
    }
    if (!ready) throw lastError;
    const workspace = await core.herdrRequest('workspace.create', { cwd, label: 'OAK demo', focus: true });
    const tab = await core.herdrRequest('tab.create', { cwd, label: 'Demo checks', focus: true, workspace_id: workspace.workspace.workspace_id });
    const panes = [workspace.root_pane.pane_id, tab.root_pane.pane_id];
    for (const pane_id of panes) {
      await core.herdrRequest('pane.send_text', { pane_id,
        text: "printf '\\033[2J\\033[H'; printf '%s\\n' 'OAK demo · disposable session' 'Conversation and captured edits are ready in Observatory.'\n" });
    }
    const sessions = new Map();
    return {
      env, stop,
      seed(session) {
        if (!/^demo-[a-f0-9]{8}$/.test(session)) throw new Error('Media capture requires a synthetic demo session.');
        if (!sessions.has(session)) {
          const pane = panes[sessions.size];
          if (!pane) throw new Error('Media capture has more sessions than disposable panes.');
          execFileSync(binary, ['pane', 'report-agent', pane, '--source', 'herdr:claude', '--agent', 'claude',
            '--state', 'idle', '--agent-session-id', session], { env, stdio: 'pipe', timeout: 5000 });
          sessions.set(session, pane);
        }
        return sessions.get(session);
      },
      async herdrFrame(cli, session, cols, rows) {
        const pane = this.seed(session);
        await core.herdrRequest('pane.focus', { pane_id: pane });
        const { Terminal } = require('@xterm/headless');
        const { serializeGrid } = require('../packages/tui/dist/native');
        const term = new Terminal({ cols, rows, allowProposedApi: true });
        let child;
        try {
          child = require('node-pty').spawn(process.execPath, [cli, 'tui', '--tab', 'herdr', '--root', cwd, '--no-server'],
            { cols, rows, cwd, env, name: 'xterm-256color' });
          let exited = false, continued = false, settingsClosed = false;
          child.onExit(() => { exited = true; });
          child.onData(data => term.write(data));
          for (let i = 0; i < 100; i++) {
            await pause(100);
            await new Promise(resolve => term.write('', resolve));
            if (exited) throw new Error('The herdr client exited during capture.');
            const frame = serializeGrid(term, cols, rows, 'truecolor').join('\n');
            if (/mouse-first|[↵⏎].*continue/i.test(frame)) {
              if (!continued) { child.write('\r'); continued = true; }
              continue;
            }
            // Welcome opens the optional integration settings; dismiss without installing anything.
            if (continued && !settingsClosed && /integrations/i.test(frame)) {
              child.write('\x1b'); settingsClosed = true; continue;
            }
            // The gate is the seeded pane plus today's tab bar. It waited on the word "cockpit" —
            // deleted from the hint line — so a perfectly healthy frame timed out for a day and the
            // message blamed the pane. Anything worded stays a moving target; the bar does not.
            const plain = frame.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
            if (plain.includes('OAK demo · disposable session') && /\bherdr\b/.test(plain)) return validateFrame(frame, { herdr: true });
          }
          throw new Error('No herdr frame matched the capture gate (a seeded pane and the numbered tab bar) in 10s; existing media was not replaced.');
        } finally { try { child?.kill(); } catch {} term.dispose(); }
      },
    };
  } catch (error) {
    await stop();
    throw new Error(`Hermetic herdr capture failed; run with Unix socket and PTY permission: ${error.message}\n${readFileSync(log, 'utf8')}`, { cause: error });
  }
}
