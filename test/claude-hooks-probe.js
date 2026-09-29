#!/usr/bin/env node
/**
 * MANUAL live probe: do Claude Code's hooks reach oak with the settings shape the installer writes?
 *
 * Not part of `npm test` — it needs a logged-in `claude` on PATH and spends one Haiku turn. Run it
 * after any change to the installer's hook events or matchers, because this is the failure class
 * the unit tests cannot see: they call `handleHookPayload` directly, so they were green for two
 * weeks while Claude Code silently never invoked the Notification hook (its `matcher` was the
 * capture tool list, which Claude Code compares to the notification TYPE — found 2026-09-15).
 *
 * How: a throwaway CLAUDE_CONFIG_DIR holds only what `core.installHooks` writes (so the shape under
 * test is the shipped one) plus a copy of the OAuth credentials and enough of `.claude.json` to skip
 * onboarding and the trust dialog. The hook command tees every payload into a log, then runs the
 * real `oak capture`, so the probe sees both what Claude Code fired and what oak recorded. A real
 * interactive `claude --model haiku` runs under a PTY, is asked to run one Bash command (no allow
 * rule → a permission prompt), and the prompt is DENIED with Escape. Nothing is ever approved.
 *
 * Expected: UserPromptSubmit → PreToolUse(Bash) → PermissionRequest(Bash) →
 * Notification(permission_prompt), with the sandbox store's attention.json reading `permission`
 * while the dialog is up. Prints the event sequence and the attention states; never prints
 * credential material; removes the credential and .claude.json copies on exit.
 *
 *   node test/claude-hooks-probe.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const core = require(path.join(REPO, 'packages/core/dist/index.js'));
let pty;
try {
  pty = require(path.join(REPO, 'node_modules/node-pty'));
} catch {
  console.error('node-pty is not installed — the probe needs a PTY');
  process.exit(2);
}

const stamp = Date.now();
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-hooks-probe-'));
fs.chmodSync(sandbox, 0o700);
const log = path.join(sandbox, 'hook-payloads.jsonl');
const settings = path.join(sandbox, 'settings.json');
const cmd = `sh -c 'tee -a "${log}" | oak capture' #${core.HOOK_MARKER}`;

fs.writeFileSync(settings, '{}');
core.installHooks(cmd, settings);
const shape = JSON.parse(fs.readFileSync(settings, 'utf8')).hooks;
console.log('settings hooks:', Object.keys(shape).map((ev) => `${ev}[${shape[ev].map((g) => g.matcher).join(',')}]`).join(' '));

const creds = path.join(os.homedir(), '.claude', '.credentials.json');
if (!fs.existsSync(creds)) {
  console.error('no ~/.claude/.credentials.json — cannot run a live claude (macOS keeps credentials in the keychain; run this on Linux)');
  process.exit(2);
}
fs.copyFileSync(creds, path.join(sandbox, '.credentials.json'));
fs.chmodSync(path.join(sandbox, '.credentials.json'), 0o600);
// Onboarding + trust live in the config dir's OWN .claude.json (a bare sandbox shows the onboarding
// dialog). Seed it from the real one, keeping only this repo's project entry and none of its allowed
// tools — a permission prompt is the point.
const home = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
const proj = (home.projects || {})[REPO] || {};
home.projects = { [REPO]: { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: proj.hasClaudeMdExternalIncludesApproved ?? true, hasClaudeMdExternalIncludesWarningShown: true, allowedTools: [], mcpServers: {} } };
fs.writeFileSync(path.join(sandbox, '.claude.json'), JSON.stringify(home), { mode: 0o600 });

// Inside the cwd: Claude Code's bash sandbox refuses paths outside it before any prompt.
const marker = path.join(REPO, `.oak-hook-probe-${stamp}`);
const prompt = `Use the Bash tool to run exactly this command and nothing else: touch ${marker}`;

const child = pty.spawn('claude', ['--model', 'haiku'], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd: REPO,
  env: { ...process.env, CLAUDE_CONFIG_DIR: sandbox, CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1' },
});

let screen = '';
child.onData((d) => {
  screen += d;
  if (screen.length > 200_000) screen = screen.slice(-100_000);
});
let exited = false;
child.onExit(() => {
  exited = true;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

function events() {
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
function attention(session) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sandbox, 'claude-observatory', session, 'attention.json'), 'utf8'));
  } catch {
    return null;
  }
}

function cleanup() {
  fs.rmSync(path.join(sandbox, '.credentials.json'), { force: true });
  fs.rmSync(path.join(sandbox, '.claude.json'), { force: true });
  fs.rmSync(marker, { force: true });
}
process.on('exit', cleanup);

(async () => {
  const seen = [];
  const attn = [];
  let session = null;
  const note = (why) => {
    for (const e of events().slice(seen.length)) {
      seen.push(e);
      session = session || e.session_id;
      const extra = e.notification_type ? ` type=${e.notification_type}` : e.tool_name ? ` tool=${e.tool_name}` : '';
      console.log(`event  ${e.hook_event_name}${extra}${e.message ? ` msg=${JSON.stringify(String(e.message).slice(0, 80))}` : ''}`);
    }
    if (session) {
      const a = attention(session);
      const key = JSON.stringify(a);
      if (!attn.length || attn[attn.length - 1] !== key) {
        attn.push(key);
        console.log(`attention (${why}): ${a ? `${a.kind} "${a.message}"` : 'none'}`);
      }
    }
  };

  // 1. Wait for the input box.
  let ready = false;
  for (let i = 0; i < 60 && !exited; i++) {
    await sleep(500);
    if (/❯|Try "|for shortcuts/.test(strip(screen))) {
      ready = true;
      break;
    }
  }
  if (!ready) {
    console.log('claude never showed its prompt; last screen:\n' + strip(screen).slice(-1500));
    child.kill();
    process.exit(1);
  }
  await sleep(1500);
  child.write(prompt);
  await sleep(400);
  child.write('\r');

  // 2. Wait for the ask (PermissionRequest or Notification/permission_prompt).
  let asked = false;
  for (let i = 0; i < 180 && !exited; i++) {
    await sleep(500);
    note('polling');
    if (seen.some((e) => e.hook_event_name === 'PermissionRequest' || (e.hook_event_name === 'Notification' && e.notification_type === 'permission_prompt'))) {
      asked = true;
      break;
    }
  }
  // Let the dialog render and the (slightly later) Notification arrive before answering.
  for (let i = 0; i < 24 && !exited; i++) {
    await sleep(500);
    note('dialog up');
  }
  console.log(`hooks saw the ask: ${asked}`);
  console.log(`marker file created (must be false — nothing approved): ${fs.existsSync(marker)}`);

  // 3. Deny with Escape (an interrupt — Claude Code fires no Stop for it), then quit.
  child.write('\x1b');
  await sleep(3000);
  note('after deny');
  child.write('/exit\r');
  for (let i = 0; i < 20 && !exited; i++) await sleep(500);
  note('after exit');
  if (!exited) child.kill();

  console.log('\nsequence:', seen.map((e) => e.hook_event_name + (e.notification_type ? `(${e.notification_type})` : e.tool_name ? `(${e.tool_name})` : '')).join(' → '));
  console.log('attention states:', attn.map((k) => (k === 'null' ? 'none' : JSON.parse(k).kind)).join(' → '));
  console.log(`session ${session ? session.slice(0, 8) : 'n/a'} · sandbox ${sandbox}`);
  const sawNotification = seen.some((e) => e.hook_event_name === 'Notification' && e.notification_type === 'permission_prompt');
  const sawRequest = seen.some((e) => e.hook_event_name === 'PermissionRequest');
  const sawPrompt = seen.some((e) => e.hook_event_name === 'UserPromptSubmit');
  const handUp = attn.some((k) => k !== 'null' && JSON.parse(k).kind === 'permission');
  const ok = sawPrompt && sawRequest && sawNotification && handUp && !fs.existsSync(marker);
  console.log(ok ? '\nPROBE OK' : `\nPROBE FAILED — prompt:${sawPrompt} request:${sawRequest} notification:${sawNotification} hand:${handUp}`);
  process.exit(ok ? 0 : 1);
})();
