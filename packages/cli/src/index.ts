/**
 * oak — standalone, git-free, per-edit Keep/Undo for Claude Code.
 *
 * Commands:
 *   init                 install the capture + attention hooks into ~/.claude/settings.json
 *   uninstall            remove those hooks again
 *   capture              internal hook entrypoint (invoked by Claude Code; never call by hand)
 *   list                 list edits in the active session
 *   diff <id>            colored before/after for one edit
 *   keep <id>            keep the whole change edit <id> belongs to (no disk change)
 *   undo <id> [--force]  surgically undo the whole change edit <id> belongs to; --force = per-file restore
 *   inbox                every session waiting on you, most urgent first (--next = the one to jump to)
 *   notify               desktop notifications for raised hands (--message | --session … | --watch)
 *   search <words…>      every conversation on this machine, ranked (asks + answers)
 *
 * Machine-readable surface (drives the JetBrains plugin): blob / locate / observe / usage, plus
 * --json on list / status / sessions / keep / undo / redo, and analyze / recap / suggest for the
 * opt-in `claude -p` layer. See `usage()` below.
 *
 * `oak capture` never reaches this file: the dist/index.js launcher (launch.ts) sends it to the lean
 * capture bundle, so the hooks do not compile the whole CLI.
 */
import type { EditRecord, InstallResult, StatMetrics, InstalledSurface, UpdatePlan, HandKind, Check, HerdrReport } from '@oak-observatory/core';

/** Version read from the package manifest at runtime — one source of truth, so it can never drift. */
function version(): string {
  try {
    const fs = require('fs');
    const path = require('path');
    // dist/index.js → ../package.json (same layout in the repo and the published tarball); the
    // bundle `oak machine add` pushes to a remote keeps package.json BESIDE index.js instead —
    // without it that oak said 0.0.0 and `oak update` there planned an update forever.
    for (const candidate of [path.join(__dirname, '..', 'package.json'), path.join(__dirname, 'package.json')]) {
      try {
        return JSON.parse(fs.readFileSync(candidate, 'utf8')).version;
      } catch {
        /* try the next layout */
      }
    }
    return '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Is this the copy `oak machine add` pushed? It keeps package.json beside the CLI, as version() reads it. */
function machineBundle(): boolean {
  return require('fs').existsSync(require('path').join(__dirname, 'package.json'));
}

function isTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

const c = {
  dim: (s: string) => (isTTY() ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (isTTY() ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (isTTY() ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (isTTY() ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (isTTY() ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (isTTY() ? `\x1b[36m${s}\x1b[0m` : s),
};

function fail(msg: string): never {
  process.stderr.write(c.red('oak: ') + msg + '\n');
  process.exit(1);
}

/** Machine-readable output for non-Node front-ends (the JetBrains plugin drives these). */
function emitJson(v: unknown): void {
  process.stdout.write(JSON.stringify(v));
}

// --- session resolution (shared shape with the VS Code front-end) ---

/**
 * The TERMINAL APP's session resolver. Every scripted verb stays strictly cwd-scoped
 * (`getSessionId`), but the front door launched OUTSIDE any repo — a shell at $HOME, the Desktop —
 * used to walk up to whatever stale session an ancestor directory once launched; opening the
 * observatory from nowhere means "show me what Claude is doing NOW", so the machine-wide newest
 * wins there (core.defaultTuiSession). Explicit `--session`, `--root` and the env pin all still win.
 */
function getTuiSessionId(args: string[]): string | { session: string; elsewhere: true } {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const pinned = args.includes('--session') || process.env.CLAUDE_OBSERVATORY_SESSION || process.env.CLAUDE_CHANGES_SESSION;
  if (pinned) {
    const id = getSessionId(args);
    // The dashboard is a whole-session view, so an EXPLICIT id it cannot open (a typo) must fail loudly
    // rather than paint an empty board. A session this machine has is one with a transcript (Claude or
    // Codex) or a store (a reviewed session whose transcript is gone). Verbs that legitimately pin an
    // id with neither — `feed --feed-agent <subagent>` — never reach here (this is the tui path only).
    // With saved machines, the session may run on one of them: the dashboard finds its owner from
    // their catalogs, reviews it there, and fails just as loudly when none lists it.
    if (id && !core.findTranscript(process.cwd(), id) && !require('fs').existsSync(core.storeDir(id))) {
      if (savedMachineLabels().length) return { session: id, elsewhere: true };
      fail(`no session "${id}" on this machine — \`oak sessions\` lists the ones it has.`);
    }
    return id;
  }
  // `--root` means that workspace's own session, never the machine-wide newest the launch default reaches for.
  const id = args.includes('--root') ? core.resolveSessionId(process.cwd()) : core.defaultTuiSession(process.cwd());
  if (id && core.isSafeSessionId(id)) return id;
  // No agent session on this machine yet — a first run. The TUI still opens (on the herdr tab, which
  // starts one) and adopts the first session that appears; exiting here would make "install oak, get
  // herdr" fail at the very first `oak`.
  return '';
}

/** The enabled saved machines' labels, from herdr's own list: a local config read, no network. Empty
 *  when herdr is missing or its list cannot be read. */
function savedMachineLabels(): string[] {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const bin = core.findHerdrBin();
  if (!bin) return [];
  try {
    const list = JSON.parse(String(core.spawnToolSync(bin, ['machine', 'list', '--json'], { encoding: 'utf8', timeout: 15000 }).stdout || '[]'));
    return Array.isArray(list) ? list.filter((m) => m?.enabled === true && typeof m.label === 'string').map((m) => m.label) : [];
  } catch {
    return [];
  }
}

function getSessionId(args: string[]): string {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const i = args.indexOf('--session');
  const given = flagValue(args, '--session');
  let id: string | null = null;
  if (i >= 0 && !given) fail('`--session` requires a session id');
  if (given) id = given;
  else if (process.env.CLAUDE_OBSERVATORY_SESSION) id = process.env.CLAUDE_OBSERVATORY_SESSION;
  else if (process.env.CLAUDE_CHANGES_SESSION) id = process.env.CLAUDE_CHANGES_SESSION; // legacy name
  else id = core.resolveSessionId(process.cwd());
  if (!id) {
    fail(
      `could not resolve an active Claude Code session for ${process.cwd()}.\n` +
        `  Run this from your workspace root, or pass --session <id>.`
    );
  }
  // Reject a traversing/garbage session id before it reaches any store path (read, write, or delete).
  if (!core.isSafeSessionId(id)) {
    fail(`invalid session id "${id}" (letters, digits, dot, dash, underscore only).`);
  }
  return id;
}

// --- init / uninstall: delegate the settings.json merge to the shared core installer ---

function captureCommand(_project: boolean): string {
  const { HOOK_MARKER } = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  // Portable hook: relies on the globally-installed `oak` bin being on PATH. Survives moving/renaming
  // the repo and works for teammates who `npm i -g`. The trailing shell-comment marker makes the hook
  // recognizable for status/uninstall regardless of where the package lives, and lets a re-run of
  // `init` migrate a pre-rename `claude-observatory capture` hook to this one in place.
  return `oak capture #${HOOK_MARKER}`;
}

function cmdInit(project: boolean, withStatusline = false, repair = false, statuslineForce = false): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const command = captureCommand(project);
  if (repair) {
    // The self-fix for older installs: the upsert install re-run over every file the ledger (plus
    // the user scope) knows, collapsing doubled hooks to one canonical pair per event. Per-file
    // results, because "fixed everywhere" without naming the files is not checkable.
    const results = core.repairInstall(command);
    for (const r of results) {
      const label = `${r.path}${r.scope === 'project' ? c.dim(' (project)') : ''}`;
      if (r.error && r.action !== 'skipped') process.stdout.write(c.red('✗ ') + `${label}: ${r.error}\n`);
      else if (r.action === 'skipped') process.stdout.write(c.dim(`- ${label}: ${r.error}\n`));
      else if (r.action === 'repaired') process.stdout.write(c.green('✓ ') + `${label}: repaired — one entry for each of the ${core.HEALTHY_HOOK_ENTRIES} capture events, current command\n`);
      else if (r.action === 'installed') process.stdout.write(c.green('✓ ') + `${label}: installed\n`);
      else process.stdout.write(`${label}: ${c.dim('already correct')}\n`);
    }
    const broken = results.filter((r) => r.error && r.action !== 'skipped').length;
    if (broken) fail(`${broken} file(s) could not be repaired — fix the JSON above and re-run init --repair.`);
    return;
  }
  const target = project ? core.projectSettingsPath(process.cwd()) : core.settingsPath();
  let res: InstallResult;
  try {
    res = core.installHooks(command, target);
  } catch {
    fail(`${target} is not valid JSON; fix it and re-run init.`);
  }
  if (res.ledgerError) {
    // The install itself succeeded; the RECORD of it did not. Said out loud because `uninstall`
    // enumerates that record — an unrecorded install is one it can only find by the marker scan.
    process.stdout.write(c.yellow('⚠ ') + `could not update the install ledger: ${res.ledgerError}\n`);
  }
  // Companion status line (bundled): powers the 5h/week Usage bars in the sidebars. Install it in
  // the same run when asked; otherwise just point at it when it isn't active yet.
  const statuslineNote = withStatusline
    ? null
    : statuslineActive() || core.statuslineInstalled()
      ? null
      : c.dim('tip: `oak statusline` installs the bundled status line (plan-usage bars in the sidebars).\n');
  // The codex leg and the statusline hand-off run on EVERY path from here — the old early return
  // skipped codex entirely for upgraders ("already installed — nothing to do", which then wasn't
  // true), and cmdStatusline's own process.exit made anything after it unreachable.
  const finishInit = (): void => {
    void maybeInitCodex().finally(() => {
      if (withStatusline) cmdStatusline(statuslineForce ? ['--force'] : []);
    });
  };
  if (!res.changed) {
    process.stdout.write(c.yellow('oak hooks already installed for Claude Code.\n'));
    if (statuslineNote) process.stdout.write(statuslineNote);
    finishInit();
    return;
  }
  process.stdout.write(
    c.green('✓ ') +
      `installed capture hooks into ${res.settingsPath}\n` +
      (res.backupPath ? c.dim(`  backup: ${res.backupPath}\n`) : '') +
      c.dim(`  command: ${command}\n`) +
      (project
        ? c.yellow(
            '  note: project hooks call `oak` on PATH — teammates need it installed ' +
              '(https://github.com/cell-observatory/oak-observatory#quickstart) for capture to run.\n'
          ) +
          c.dim('  this file is meant to be committed; the install is recorded in the install ledger (`status` lists every install).\n')
        : '') +
      `Edits made by Claude Code (Edit/Write/MultiEdit/NotebookEdit — plus files changed by Bash; ` +
      `set CLAUDE_OBSERVATORY_NO_BASH=1 to opt out) will now be tracked.\n`
  );
  if (statuslineNote) process.stdout.write(statuslineNote);
  finishInit();
}


function maybeInitCodex(): Promise<void> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  if (process.argv.includes('--no-codex')) return Promise.resolve();
  const found = core.spawnToolSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], { encoding: 'utf8' });
  if (found.status !== 0 || !String(found.stdout).trim()) {
    process.stdout.write(c.dim('codex: not on this machine — skipped (install codex, then `oak init --codex`).\n'));
    return Promise.resolve();
  }
  process.stdout.write(c.dim('codex found — installing its capture hooks too (--no-codex skips):\n'));
  cmdInitCodex(true);
  // "Install everything automatically": when codex has NO model configured and
  // local models exist, wire the newest one — loudly, with a backup, and only into the vacuum. A
  // model the user already chose (directly, through a provider, or through a profile) is never
  // touched; `models use` is the explicit switch, and `oak uninstall` removes what this wired. The
  // promise is RETURNED so the caller can sequence the statusline hand-off (whose process.exit
  // used to cut this wiring off mid-flight) after it.
  return core.listOllamaModels().then((list) => {
    if (!list?.length) return;
    const chosen = core.codexModelChoice();
    if (chosen) {
      process.stdout.write(c.dim(`codex model: ${chosen} · ${list.length} local model(s) — \`oak models\` to list or switch.\n`));
      return;
    }
    const pick = list[0].name;
    const wired = core.wireCodexModel(pick, true);
    process.stdout.write(
      c.green('✓ ') + `codex had no model configured — wired to your newest local model, ${pick} (provider: ollama)\n` +
        (wired.backupPath ? c.dim(`  backup: ${wired.backupPath}\n`) : '') +
        c.dim('  `oak models use <name>` switches any time.\n')
    );
  }).catch((e) => {
    // Opportunistic, but never silent: ollama being down is routine; a failed CONFIG WRITE is not.
    process.stdout.write(c.dim(`codex model wiring skipped: ${String((e as Error)?.message || e)}\n`));
  });
}


function cmdInitCodex(verify: boolean): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const command = `oak capture --agent codex #${core.HOOK_MARKER}`;
  let res: import('@oak-observatory/core').CodexInstallResult;
  try {
    res = core.installCodexHooks(command, core.isOurCommand);
  } catch (e) {
    fail(String((e as Error)?.message || e));
  }
  const label = res.hooksJson === 'unchanged' ? c.yellow('already installed') : c.green(res.hooksJson);
  process.stdout.write(c.green('✓ ') + `codex hooks ${label} → ${core.codexHooksJsonPath()}\n`);
  if (res.stateWritten) {
    process.stdout.write(
      c.green('✓ ') + `trust state written → ${res.statePath}\n` +
        c.dim(`  (append-only edit; your existing config lines are untouched${res.backupPath ? ` — backup: ${res.backupPath}` : ''})\n`)
    );
  }
  if (res.foreignGroups > 0) process.stdout.write(c.dim(`  ${res.foreignGroups} foreign hook group(s) preserved untouched\n`));
  if (!verify) {
    process.stdout.write(c.yellow('⚠ verification skipped (--no-verify) — codex skips untrusted hooks SILENTLY; `oak status` shows the trust check.\n'));
    return;
  }
  const status = core.codexHooksStatus(core.isOurCommand);
  process.stdout.write(`configuration: ${status.installed ? 'installed' : 'incomplete'}; trust: ${status.trust}\n`);
  process.stdout.write('No model was invoked. Lifecycle and edit capture are verified separately when your next Codex session runs.\n');

}

/**
 * Local-model onboarding (no API keys — open-weight models over local
 * ollama are the test bed, and switching between them must be one command).
 *
 * `models`            what ollama serves HERE (read live — a model pulled a second ago is listed),
 *                     which one codex is wired to, and the switch hint.
 * `models use <name>` pull it if missing (streamed), wire ~/.codex/config.toml to it (Orca
 *                     manners: surgical line replacement + .bak), then PROBE — a live `codex exec`
 *                     turn proves the wiring, because written-and-working is a claim only a
 *                     completed turn can make.
 */
async function cmdModels(args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const sub = args.find((a) => !a.startsWith('-'));
  const list = await core.listOllamaModels();
  if (sub === 'use') {
    const name = args[args.indexOf('use') + 1];
    if (!name || name.startsWith('-')) fail('models use <name> — `oak models` lists what is available');
    if (list === null) fail('ollama is not answering on 127.0.0.1:11434 — start it (`ollama serve`, or the ollama app) and re-run.');
    if (!list.some((m) => m.name === name || m.name === `${name}:latest`)) {
      process.stdout.write(c.dim(`${name} is not local yet — pulling via ollama (this streams; ctrl+c aborts safely):\n`));
      const r = core.spawnToolSync('ollama', ['pull', name], { stdio: 'inherit' });
      if (r.status !== 0) fail(`ollama pull ${name} failed — the name may not exist in the ollama library.`);
    }
    const wired = core.wireCodexModel(name);
    process.stdout.write(
      c.green('✓ ') + `codex wired to ${name} (provider: ollama)` +
        (wired.previous && wired.previous !== name ? c.dim(`  (was ${wired.previous})`) : '') + '\n' +
        (wired.backupPath ? c.dim(`  backup: ${wired.backupPath}\n`) : '')
    );
    process.stdout.write(c.dim('verifying: one live codex turn on the new model (a first load of a big model can take minutes)…\n'));
    const probe = core.spawnToolSync('codex', ['exec', '--skip-git-repo-check', 'Reply with exactly: ok'], {
      cwd: require('os').tmpdir(),
      timeout: 300000, // first-load of a 20GB-class model + one turn — measured over 120s for laguna-xs.2
      killSignal: 'SIGKILL',
      encoding: 'utf8',
    });
    const outText = `${probe.stdout || ''}`;
    const errCode = (probe.error as NodeJS.ErrnoException | undefined)?.code;
    if (/\bok\b/i.test(outText.split('\n').slice(-8).join('\n'))) {
      process.stdout.write(c.green(`✓ verified — ${name} answered a live turn through codex\n`));
    } else if (errCode === 'ETIMEDOUT') {
      // The failure modes need different advice, and lumping them under "is codex installed?"
      // misdiagnosed a model that was simply still loading (measured, laguna-xs.2's first load).
      process.stdout.write(c.yellow('⚠ the verify turn timed out — the model is likely still loading into memory.') + c.dim(' The wiring is done; try `codex` in a minute.\n'));
    } else if (/session id:/.test(outText)) {
      process.stdout.write(c.yellow('⚠ codex started but the model did not answer cleanly') + c.dim(' — try `codex`.\n'));
    } else if (errCode === 'ENOENT') {
      process.stdout.write(c.yellow('⚠ codex is not installed') + c.dim(' — the model is wired; install codex and the drive picks it up.\n'));
    } else {
      process.stdout.write(c.yellow('⚠ could not verify') + c.dim(` (${probe.error ? String(probe.error) : 'no codex output'})\n`));
    }
    return;
  }
  // The listing. Ollama not running is an ANSWER here, not an error exit — status pages never fail.
  const { model: wiredModel } = core.codexConfiguredModel();
  if (list === null) {
    process.stdout.write(c.yellow('ollama: not answering on 127.0.0.1:11434') + c.dim(' — start it to serve local models (https://ollama.com).\n'));
  } else if (!list.length) {
    process.stdout.write('ollama is running but serves no models yet — `ollama pull <name>` (e.g. qwen3, gemma3, laguna-xs.2), then `oak models use <name>`.\n');
  } else {
    process.stdout.write(c.bold(`local models (ollama · newest first):\n`));
    for (const m of list) {
      const active = m.name === wiredModel;
      const gb = (m.sizeBytes / 1e9).toFixed(1);
      process.stdout.write(`  ${active ? c.green('● ') : '  '}${m.name.padEnd(28)} ${c.dim(`${gb} GB`)}${active ? c.green('  ← codex runs this') : ''}\n`);
    }
    process.stdout.write(c.dim('`oak models use <name>` switches codex (pulls first when missing). New pulls appear here with nothing to reinstall — capture is model-independent.\n'));
  }
  if (wiredModel && list?.every((m) => m.name !== wiredModel)) {
    process.stdout.write(c.yellow(`⚠ codex is wired to "${wiredModel}", which ollama does not serve — \`models use <name>\` fixes the mismatch.\n`));
  }
}

function cmdUninstall(args: string[]): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const project = args.includes('--project');
  const all = args.includes('--all');
  const target = project ? core.projectSettingsPath(process.cwd()) : core.settingsPath();
  if (project) {
    // Explicitly scoped: exactly this repo's settings file, nothing else.
    let res: InstallResult;
    try {
      res = core.uninstallHooks(target);
    } catch {
      fail(`${target} is not valid JSON.`);
    }
    process.stdout.write(
      res.changed
        ? c.green('✓ ') + `removed capture hooks from ${res.settingsPath}\n`
        : 'no oak hooks found.\n'
    );
  } else {
    // Default: EVERY file the install ledger records, plus the user scope (the pre-ledger
    // fallback) — per-file results, because a teardown that names what it cleaned is checkable
    // and one that says "done" is not.
    const results = core.uninstallEverywhere();
    let removed = 0;
    for (const r of results) {
      const label = `${r.path}${r.scope === 'project' ? c.dim(' (project)') : ''}`;
      if (r.error) process.stdout.write(c.red('✗ ') + `${label}: ${r.error}\n`);
      else if (r.changed) {
        removed++;
        process.stdout.write(c.green('✓ ') + `removed capture hooks from ${label}\n`);
      } else process.stdout.write(c.dim(`- ${label}: no hooks present\n`));
    }
    if (!removed && results.every((r) => !r.error)) process.stdout.write('no oak hooks found anywhere the ledger knows.\n');
    // codex lives at fixed paths and is self-describing — no ledger needed to find it.
    const cst = core.codexHooksStatus(core.isOurCommand);
    if (cst.installed) {
      const r = core.uninstallCodexHooks(core.isOurCommand);
      process.stdout.write(
        c.green('✓ ') +
          (r.hooksJson === 'removed'
            ? `removed ${core.codexHooksJsonPath()}\n`
            : `removed our entries from ${core.codexHooksJsonPath()} (foreign hook groups kept)\n`) +
          (r.stateRemoved ? c.green('✓ ') + `removed our trust-state tables from ${core.codexConfigTomlPath()}\n` : '')
      );
    }
    const unwired = core.unwireCodexModel();
    if (unwired) process.stdout.write(c.green('✓ ') + `removed the codex model lines oak init added (${unwired}) from ${core.codexConfigTomlPath()}\n`);
  }
  if (!all) {
    process.stdout.write(
      c.dim('tip: `oak uninstall --all` also reverts the bundled status line + prints full teardown steps.\n')
    );
    return;
  }
  // --all: revert the bundled status line too, but only if it's still ours (never a user's custom one).
  try {
    const sl = core.uninstallStatusline(target);
    if (sl.changed || sl.scriptRemoved) {
      process.stdout.write(c.green('✓ ') + `reverted the bundled status line${sl.changed ? ' (settings.json + script)' : ' (script)'}\n`);
    } else if (sl.scriptKept) {
      // Deliberately left, so say so: a settings entry still points at the script, and deleting it
      // would leave Claude Code erroring on every render with nothing naming us.
      process.stdout.write(
        c.yellow('⚠ ') +
          `left ${core.claudeConfigDir()}/statusline.sh in place — a statusLine in settings.json still points at it.\n` +
          c.dim('  Remove that statusLine entry first, then re-run, or delete the script yourself.\n')
      );
    }
  } catch {
    /* leave a custom/hand-edited statusLine alone */
  }
  if (args.includes('--purge-store')) {
    const sessions = core.listSessions();
    for (const s of sessions) core.removeSession(s.id);
    process.stdout.write(c.green('✓ ') + `purged the store (${sessions.length} session(s))\n`);
  }
  // We can't remove the global CLI or the editor extensions from here — print the exact steps.
  process.stdout.write(
    '\n' + c.bold('To finish removing OAK:\n') +
      c.dim('  • CLI:        ') + 'npm rm -g oak-observatory\n' +
      c.dim('  • VS Code:    ') + 'uninstall the “OAK” extension (Extensions view)\n' +
      c.dim('  • JetBrains:  ') + 'Settings → Plugins → OAK → Uninstall\n' +
      (args.includes('--purge-store')
        ? ''
        : c.dim('  • Stored edits: ') + '`oak clean --all`  (or re-run with `--purge-store`)\n')
  );
}

function cmdStatus(args: string[] = []): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const fs = require('fs');
  const installed = core.hooksInstalled();
  // Verify the installed hook points at a script that still exists — the #1 silent-failure mode
  // (repo moved / deleted after install, or a stale path on a teammate's machine).
  const cmd = core.installedHookCommand();
  const quoted = cmd ? cmd.match(/"([^"]+)"/) : null;
  // Legacy hooks embed an absolute script path (in quotes); the current portable hook is just
  // `oak capture #marker` and resolves the bin on PATH — probe THAT instead, else the
  // health check is silently inert (never fires) for every current install.
  const hookScript = quoted
    ? { path: quoted[1], ok: fs.existsSync(quoted[1]) }
    : cmd
      ? { path: 'oak (on PATH)', ok: onPath('oak') === true }
      : null;
  const session = core.resolveSessionId(process.cwd());
  const log = session ? core.readLog(session) : [];
  const skips = session ? core.readSkips(session) : [];
  // Cancelled-out chains are not edits anybody reviews, and this line sits beside `list`'s: one
  // session read "2 pending" here and "0 pending" there until they counted the same set.
  const statusHidden = session ? core.cancelledMemberIds(session) : new Set<number>();
  const shownLog = log.filter((r) => !statusHidden.has(r.id));
  const by = (s: string) => shownLog.filter((r) => r.status === s).length;

  const installFiles = core.installStatus();
  const codexStatus = core.codexHooksStatus(core.isOurCommand);
  if (args.includes('--json')) {
    emitJson({
      hooksInstalled: installed,
      hookScript,
      // Every settings file the install ledger records (plus the user scope): path, scope,
      // installed, command, and the entry count whose healthy value is exactly 2.
      installFiles,
      codexHooks: codexStatus,
      session,
      store: session ? core.storeDir(session) : null,
      lastCaptureTs: log.length ? core.maxOf(log.map((r) => r.ts)) : null,
      // The oak server, from its pidfile (2026-09-16): alive means the pid is; `server status` asks it.
      server: (() => {
        const spid = core.readDaemonPid();
        return { pid: spid, running: spid !== null && core.pidAlive(spid) };
      })(),
      counts: session
        ? { total: shownLog.length, pending: by('pending'), kept: by('kept'), undone: by('undone'), cancelled: log.length - shownLog.length }
        : null,
      skipped: session ? skips.length : null,
    });
    return;
  }

  process.stdout.write(
    `capture hooks:   ${installed ? c.green('installed') : c.red('not installed — run `oak init`')}\n`
  );
  if (hookScript) {
    process.stdout.write(
      `hook script:     ${hookScript.path} ${hookScript.ok ? c.green('[ok]') : c.red('[not resolving — run `oak doctor`]')}\n`
    );
  }
  // THE OAK SERVER: the local focus endpoint that routes navigation between attached OAK terminals.
  // Read from its pidfile — a synchronous status must not open a socket — so "running" here means
  // the pid is alive; `oak server status` asks the endpoint itself.
  {
    const spid = core.readDaemonPid();
    const up = spid !== null && core.pidAlive(spid);
    process.stdout.write(
      `oak server:      ${up ? c.green(`running (pid ${spid})`) + c.dim(' — `oak server status` reports the focus endpoint') : spid !== null ? c.yellow(`stale pidfile (${spid}) — \`oak server start\` reclaims it`) : c.dim('not running — starts with oak tui')}\n`
    );
  }
  // The ledger view: one line per settings file we have written. A single healthy user-scope row
  // repeats what "capture hooks:" already said, so it stays quiet; anything else — project
  // installs, a missing file, a doubled hook pair — is exactly what this table exists to show.
  const noteworthy = installFiles.some((f) => f.scope === 'project' || (f.exists && f.installed && f.entries !== core.HEALTHY_HOOK_ENTRIES));
  if (noteworthy) {
    process.stdout.write('installed into:\n');
    for (const f of installFiles) {
      // The user file's repair is plain `oak init`, the command doctor names; only `--repair` reaches
      // every project file the ledger lists, from wherever it runs.
      const repair = f.scope === 'project' ? 'oak init --repair' : 'oak init';
      const state = !f.exists
        ? c.dim('file missing')
        : f.installed
          ? f.entries === core.HEALTHY_HOOK_ENTRIES
            ? c.green('ok')
            : c.yellow(`${f.entries < core.HEALTHY_HOOK_ENTRIES ? `incomplete: ${f.entries} of ${core.HEALTHY_HOOK_ENTRIES}` : f.entries} hook entries — run \`${repair}\``)
          : c.dim('no hooks');
      process.stdout.write(`  ${f.path} ${f.scope === 'project' ? c.dim('(project) ') : ''}${state}\n`);
    }
  }
  // settings.json is contested shared state — say what ELSE manages hooks in it, so "my other
  // tool broke" has a lead. Reported only; this installer never touches a foreign entry.
  const foreign = installFiles.find((f) => f.scope === 'user')?.foreign ?? [];
  if (foreign.length) {
    process.stdout.write(
      c.dim(`other tools' hooks: ${foreign.length} entr${foreign.length === 1 ? 'y' : 'ies'} (left untouched) — `) +
        c.dim(foreign.map((cmd) => cmd.split(/\s+/)[0]).join(', ')) + '\n'
    );
  }
  // The terminal app's pointer shapes ride OSC 22 through tmux's passthrough, which tmux ships OFF
  // (2026-09-15) — said here, where a reader looks when something in the terminal app stays silent.
  if (process.env.TMUX) {
    try {
      const r = core.spawnToolSync('tmux', ['show', '-gv', 'allow-passthrough'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const v = String(r.stdout ?? '').trim();
      if (r.status === 0 && v !== 'on' && v !== 'all') {
        process.stdout.write(c.yellow(`tmux:            allow-passthrough is ${v || 'off'} — the terminal app's mouse-pointer shapes need \`set -g allow-passthrough on\` in ~/.tmux.conf\n`));
      }
    } catch {
      /* no tmux binary reachable — nothing to say */
    }
  }
  // codex capture: trust is the load-bearing bit — codex SKIPS untrusted hooks with no warning, so a
  // mismatch here is a live capture gap, not a cosmetic one.
  if (codexStatus.installed) {
    const trust =
      codexStatus.trust === 'trusted'
        ? c.green('trusted')
        : c.red(`${codexStatus.trust} — codex skips untrusted hooks SILENTLY; re-run \`oak init --codex\``);
    process.stdout.write(
      `codex hooks:     installed → ${codexStatus.hooksJsonPath}  ${trust}\n` +
        (codexStatus.foreignGroups ? c.dim(`                 ${codexStatus.foreignGroups} foreign hook group(s) untouched\n`) : '')
    );
  } else {
    process.stdout.write(c.dim('codex hooks:     not installed (`oak init --codex` to capture codex sessions)\n'));
  }
  if (!session) {
    process.stdout.write(`active session:  ${c.dim('none for ' + process.cwd())}\n`);
    return;
  }
  const last = log.length ? core.relTime(core.maxOf(log.map((r) => r.ts))) : 'never';
  process.stdout.write(
    `active session:  ${session}\n` +
      `store:           ${core.storeDir(session)}\n` +
      `last capture:    ${last}\n` +
      `edits:           ${shownLog.length}  ${c.dim(`(${by('pending')} pending · ${by('kept')} kept · ${by('undone')} undone)`)}\n` +
      (log.length > shownLog.length
        ? c.dim(`                 ${log.length - shownLog.length} more in cancelled-out chains — nothing to review\n`)
        : '')
  );
  if (skips.length) {
    process.stdout.write(
      c.yellow(`not captured:    ${skips.length} change(s)`) +
        c.dim(' — too large (>5MB) / binary, or a Bash tree too large to snapshot\n')
    );
  }
}

/** Does `bin` resolve on PATH? Cross-platform; null if we couldn't determine it. */
function onPath(bin: string): boolean | null {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  try {
    // Named `where.exe`, not `where`, so the launcher keeps it direct: this function's whole answer is
    // res.error ("couldn't determine") vs res.status ("not on PATH"), and a shell collapses the two.
    // `direct` says that out loud at both call sites rather than relying on the .exe suffix rule.
    const res =
      process.platform === 'win32'
        ? core.spawnToolSync('where.exe', [bin], { stdio: 'ignore', direct: true })
        // Pass `bin` as $1, never interpolated into the shell string — no injection even if a future
        // caller passes a config-derived value.
        : core.spawnToolSync('sh', ['-c', 'command -v "$1"', 'sh', bin], { stdio: 'ignore', direct: true });
    if (res.error) return null;
    return res.status === 0;
  } catch {
    return null;
  }
}

/** `doctor` — diagnose the whole setup (hooks, PATH, config dir, session, status line) with fixes. */
function cmdIntegrity(args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  const session = getSessionId(args);
  const report = core.captureIntegrity(session);
  if (args.includes('--json')) emitJson(report);
  else {
    process.stdout.write(`${report.records} records; ${report.skipped} capture gaps; ${report.issues.length} integrity findings\n`);
    for (const issue of report.issues) process.stdout.write(`${issue.severity}: ${issue.message}${issue.file ? ` — ${issue.file}` : ''}\n`);
  }
}

/**
 * herdr's row in the doctor report — and, with `--fix`, the repair.
 *
 * herdr is a hard runtime dependency with no fallback path, so "is it there and is it the pinned
 * one" belongs in the same report as the hooks and the PATH. A bare `oak doctor` only LOOKS: a
 * diagnostic that installs a 26 MB binary because you asked it what was wrong is not a diagnostic.
 * `--fix` runs the one function that owns all of it (binary, integrations, plugin, server).
 */
async function herdrCheck(fix: boolean): Promise<{ check: Check; report: HerdrReport | null }> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const label = 'herdr (the terminal engine OAK runs on)';
  const row = (level: Check['level'], detail: string, fixHint?: string): Check =>
    ({ id: 'herdr', label, level, detail, ...(fixHint ? { fix: fixHint } : {}) });
  // A herdr at or above the pin can still speak another protocol: a newer release that bumped it, or
  // a server still running an older binary. Every Observatory snapshot then fails, and `--fix` never
  // replaces a newer herdr, so the row says what does fix it — for the side that fails. The binary on
  // disk and the running server are judged apart: when only the binary is off, the server still
  // serves OAK, and stopping it (which closes every pane) would restart it on that binary.
  const protocolRow = async (bin: string): Promise<Check | null> => {
    const lock = core.readHerdrLock();
    let v: import('@oak-observatory/core').HerdrVersion;
    try {
      v = await core.herdrVersion({ binary: bin, timeoutMs: 5000 });
    } catch {
      return null; // herdr did not answer `status`; the server rows below report an unreachable herdr
    }
    if (v.compatible) return null;
    const pin = `this OAK speaks protocol ${lock.protocol} (herdr ${lock.version})`;
    const why = (x: { protocol: number }) => (x.protocol !== lock.protocol ? `speaks protocol ${x.protocol}` : `is older than herdr ${lock.version}`);
    const restart = '`herdr server stop` from a terminal outside herdr (this closes its panes), then `oak doctor --fix`';
    const b = v.binary ?? v; // with no server running, `v` is the binary's own verdict
    const server = `the running herdr server (${v.version})`;
    if (!b.compatible) {
      const fix = b.protocol > lock.protocol
        ? `\`oak update\` for an OAK that speaks protocol ${b.protocol}, or install herdr ${lock.version}`
        : `install herdr ${lock.version} (\`oak doctor --fix\` does)`;
      const binary = `herdr ${b.version} at ${bin} ${why(b)}`;
      if (!v.running) return row('fail', `${binary}; ${pin}`, fix);
      if (v.serverCompatible) return row('fail', `${binary}; ${pin} — ${server} still serves OAK, so leave it running until then`, fix);
      return row('fail', `${binary}, and ${server} ${why(v)}; ${pin}`, `${fix}; then ${restart}`);
    }
    // The binary on disk is fine, so a server restarted on it will be too.
    if (!v.serverCompatible) return row('fail', `${server} ${why(v)}; ${pin}`, restart);
    return row('fail', `herdr reports that ${server} cannot serve herdr ${b.version} at ${bin}`, restart);
  };
  try {
    const pinned = core.readHerdrLock().version;
    if (!fix) {
      const probe = core.probeHerdr();
      if (!probe.bin) return { check: row('fail', `not installed (OAK pins ${pinned})`, 'oak doctor --fix'), report: null };
      if (!probe.current)
        return { check: row('warn', `${probe.version} at ${probe.bin} is older than the pinned ${pinned}`, 'oak doctor --fix'), report: null };
      return { check: (await protocolRow(probe.bin)) ?? row('ok', `${probe.version} at ${probe.bin}`), report: null };
    }
    const report = await core.ensureHerdr();
    const downloaded = report.downloaded;
    const detail =
      `${report.version} at ${report.bin}` +
      (report.upgraded ? ` (installed ${report.pinned})` : '') +
      (downloaded ? ` · downloaded herdr ${report.pinned} (${(downloaded.bytes / 1_000_000).toFixed(1)} MB) from ${downloaded.url}` : '') +
      ` · integrations ${Object.entries(report.integrations).map(([k, v]) => `${k}=${v}`).join(' ')}` +
      ` · plugin ${report.pluginLinked ? 'linked' : 'not linked'}` +
      (report.sidebarConfigured ? ' · sidebar widths set in config.toml' : '') +
      (report.themeConfigured ? ' · herdr theme: gruvbox (set)' : '') +
      (report.serverStarted ? ' · server started' : '');
    // Warnings are not cosmetic here: no python3 means herdr's hooks exit silently and no session
    // ever joins its pane, which looks like OAK being broken rather than a missing dependency.
    return { check: (report.bin ? await protocolRow(report.bin) : null) ?? row(report.warnings.length ? 'warn' : 'ok', detail), report };
  } catch (e) {
    return { check: row('fail', String((e as Error)?.message || e), 'oak doctor --fix'), report: null };
  }
}

/**
 * Inspect only: does the running herdr server carry a Claude Code session identity?
 *
 * A server started from inside a session (an `oak doctor --fix` run by an agent, a bare `herdr` in a
 * pane's shell) inherits `CLAUDE_CODE_CHILD_SESSION` and friends, and every pane it opens inherits
 * them in turn — so each `claude` started there runs as a CHILD session: transcript saving off
 * ("inherited CLAUDE_CODE_CHILD_SESSION marker"), nothing to `--resume`, no conversation for the
 * Observatory, no session record for Remote Control. OAK strips the identity when IT starts the
 * server (2026-09-22), but a server already running keeps what it was born with; the only cure is a
 * restart, which closes every pane — so this row says so instead of doing it.
 */
function herdrIdentityCheck(): Check[] {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const label = 'herdr server environment';
  const consequence = 'every Claude Code agent started in its panes inherits it and runs as a child session: transcript saving off, nothing to --resume, no conversation in the Observatory, no session record for Remote Control';
  let found: ReturnType<typeof core.herdrServerIdentityLeak>;
  try {
    // herdr's own word on whether a server runs comes first: no server, nothing to inspect — and no
    // warning to read on a platform (Windows) whose process environments cannot be read at all.
    const bin = core.findHerdrBin();
    const status = bin ? core.spawnToolSync(bin, ['status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }) : null;
    found = status && /status:\s*not running/.test(String(status.stdout ?? '')) ? { state: 'absent' } : core.herdrServerIdentityLeak();
  } catch (e) {
    found = { state: 'unknown', why: String((e as Error)?.message || e) };
  }
  switch (found.state) {
    case 'absent':
      return [{ id: 'herdr-env', label, level: 'ok', detail: 'no herdr server running' }];
    case 'clean':
      return [{ id: 'herdr-env', label, level: 'ok', detail: `the running herdr server (pid ${found.pid}) carries no Claude Code session identity` }];
    case 'unknown':
      // "Could not look" is said as such — never printed as a clean bill.
      return [{
        id: 'herdr-env', label, level: 'warn',
        detail: `not inspected — ${found.why}. A server started from inside a Claude Code session carries that session's identity, and ${consequence}`,
        fix: 'start herdr (or `oak doctor --fix`) from a plain terminal, never from inside a Claude Code session',
      }];
    case 'leak':
      return [{
        id: 'herdr-env', label, level: 'fail',
        detail: `the running herdr server (pid ${found.pid}) carries a Claude Code session identity (${found.keys.join(', ')}) — ${consequence}`,
        fix: 'from a terminal OUTSIDE herdr: `herdr server stop` (this closes every herdr pane and the agents in them), then `oak doctor --fix` to start it clean',
      }];
  }
}

/** A daemon in a login scope loses every pane when that login closes — only where logind stops the
 *  scope then (`KillUserProcesses=yes`). Inspection only. */
function herdrLoginScopeCheck(): Check {
  const core = require('@oak-observatory/core') as Core;
  const found = core.herdrServerLoginScope();
  const row = { id: 'herdr-login-scope', label: 'herdr server login scope' };
  const move = 'after closing your agents, from a terminal outside herdr: herdr server stop, then oak doctor --fix; loginctl enable-linger keeps the user manager alive after the last logout';
  if (found.state === 'scope') {
    if (found.killUserProcesses === false) return { ...row, level: 'ok',
      detail: `the running herdr server (pid ${found.pid}) is in the login scope ${found.scope}; logind keeps it running after that login ends (KillUserProcesses=no)` };
    if (found.killUserProcesses === true) return { ...row, level: 'warn',
      detail: `the running herdr server (pid ${found.pid}) is inside a login scope; logind can stop it and every pane when that login ends`, fix: move };
    return { ...row, level: 'warn',
      detail: `the running herdr server (pid ${found.pid}) is in the login scope ${found.scope}, and logind's KillUserProcesses could not be read; if it is yes, logind stops the server and every pane when that login ends`,
      fix: 'check with `busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager KillUserProcesses`; if it prints b true, ' + move };
  }
  if (found.state === 'not-applicable') return { ...row, level: 'ok', detail: 'not applicable: login scopes are logind\'s, and logind runs only on Linux' };
  if (found.state === 'unknown') return { ...row, level: 'warn', detail: 'not inspected — ' + found.why };
  return { ...row, level: 'ok', detail: found.state === 'absent' ? 'no herdr server running' : 'the running herdr server is outside every login scope' };
}

/** Inspect only: herdr's installed agent hooks parse JSON with python3. */
function python3Check(report: HerdrReport | null): Check {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  // herdr's Windows hooks are PowerShell: the pinned herdr.exe carries no python at all.
  if (process.platform === 'win32')
    return { id: 'python3', label: 'python3 (herdr agent hooks)', level: 'ok', detail: "not needed on Windows, where herdr's agent hooks run in PowerShell" };
  const present = onPath('python3') === true;
  let hooksInstalled = report !== null && Object.entries(report.integrations)
    .some(([target, state]) => (target === 'claude' || target === 'codex') && (state === 'current' || state === 'installed'));
  if (!report) {
    const bin = core.findHerdrBin();
    if (bin) {
      try {
        const status = core.spawnToolSync(bin, ['integration', 'status'], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
        });
        hooksInstalled = /^\s*(?:claude|codex):\s*(?:current|outdated|needs repair)\b/m.test(String(status.stdout ?? ''));
      } catch { /* herdr's own diagnostic reports an unavailable binary */ }
    }
  }
  const missing = hooksInstalled && !present;
  return {
    id: 'python3', label: 'python3 (herdr agent hooks)', level: missing ? 'fail' : 'ok',
    detail: present ? 'on PATH' : hooksInstalled ? 'not on PATH' : 'not on PATH; no installed herdr claude/codex integration needs it',
    ...(missing ? { fix: "herdr's agent hooks need python3" } : {}),
  };
}

async function cmdDoctor(args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const checks = core.diagnose({
    cwd: process.cwd(),
    binOnPath: onPath('oak'),
    jqPresent: onPath('jq'),
  });
  checks.push(core.diagnoseRemoteTitles());
  const codexQuota = core.diagnoseCodexQuota();
  if (codexQuota) checks.push(codexQuota);
  const herdr = await herdrCheck(args.includes('--fix'));
  checks.push(herdr.check);
  checks.push(python3Check(herdr.report));
  if (herdr.check.level !== 'fail') checks.push(...herdrIdentityCheck(), herdrLoginScopeCheck());
  checks.push(await core.diagnoseFocusServer(args.includes('--fix')));
  const tui = require('@oak-observatory/tui') as typeof import('@oak-observatory/tui');
  checks.push(await tui.diagnoseNativeSpawn(args.includes('--fix'), { bundle: machineBundle() }));
  if (herdr.check.level !== 'fail') checks.push(...await core.diagnoseHerdrForwarding({ binary: core.findHerdrBin() ?? undefined }));
  if (args.includes('--json')) {
    emitJson({ version: version(), checks, herdr: herdr.report });
    return;
  }
  if (args.includes('--markdown') || args.includes('--md')) {
    process.stdout.write(core.diagnoseMarkdown(checks));
    return;
  }
  const icon = (l: string) => (l === 'ok' ? c.green('✓') : l === 'warn' ? c.yellow('⚠') : c.red('✗'));
  process.stdout.write(
    c.bold(`oak doctor`) +
      c.dim(`  v${version()} · ${(require('@oak-observatory/core') as typeof import('@oak-observatory/core')).getUpdateChannel() === 'dev' ? 'pre-release (dev)' : 'stable'} channel\n\n`)
  );
  for (const ch of checks) {
    process.stdout.write(`${icon(ch.level)} ${ch.label}\n    ${c.dim(ch.detail)}\n`);
    if (ch.fix) process.stdout.write(`    ${c.cyan('→ ' + ch.fix)}\n`);
    // One row cannot carry four different half-failures, and swallowing them is how a machine ends
    // up with herdr installed, no python3, and nothing to explain why the observatory is empty.
    if (ch.id === 'herdr') for (const w of herdr.report?.warnings ?? []) process.stdout.write(`    ${c.yellow('⚠ ' + w)}\n`);
  }
  const fails = checks.filter((ch) => ch.level === 'fail').length;
  const warns = checks.filter((ch) => ch.level === 'warn').length;
  process.stdout.write(
    '\n' +
      (fails
        ? c.red(`${fails} problem(s) to fix`) + (warns ? c.yellow(` · ${warns} warning(s)`) : '') + '\n'
        : warns
          ? c.yellow(`critical checks passed · ${warns} warning(s)`) + '\n'
          : c.green('all checks passed') + '\n')
  );
  process.exit(fails ? 1 : 0);
}

/**
 * `resolve [--session <id>] [--json]` — accept every pending edit in a session, then clear its resolved
 * records. Files on disk are never touched (accepting is a verdict, not a write), and the session is
 * kept — `clean --drop` deletes one outright.
 */
function cmdResolve(args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  const session = getSessionId(args);
  const r = core.resolveSession(session);
  if (args.includes('--json')) {
    emitJson({ session, accepted: r.accepted, cleared: r.cleared });
    return;
  }
  process.stdout.write(
    c.green('✓ ') + `resolved ${session.slice(0, 8)}: accepted ${r.accepted} pending edit(s), cleared ${r.cleared} record(s)\n`
  );
}

/**
 * `warm [--root <d>] [--since <dur>] [--json]` — build the change map for this workspace's RECENT
 * sessions so switching to one is a cache read instead of a rebuild.
 *
 * Switching to a large session was measured at 6.8 s cold against 1.4 s warm, and nothing warmed a
 * session until you switched to it — so the cost landed on the reader every time. This is that work,
 * moved off the critical path: the editors spawn it detached after a refresh settles.
 *
 * Deliberately serial. It exists to spend idle time, not to contend with the refresh that just finished
 * — a fan-out of full change-map builds is exactly the ~500 MB-per-process work this project already
 * spawns one at a time. The only bound on HOW MANY it builds is `--since`, so the per-session caches are
 * dropped between sessions: without that, peak RSS scaled with how many sessions happened to be active
 * in the window rather than with the largest one.
 */
function cmdWarm(args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  const cwd = flagValue(args, '--root') ?? process.cwd();
  const spec = flagValue(args, '--since');
  const sinceMs = spec ? parseDuration(spec) : 24 * 60 * 60_000;
  if (spec && sinceMs === null) fail(`bad --since value "${spec}" (use e.g. 24h or 2d)`);
  const now = Date.now();
  const recent = core
    .sessionMeta(cwd)
    .sessions
    // Skip the session under review. The Overview's own `views` spawn already builds it every tick, and
    // its transcript invalidates that build seconds later — so warming it is work that is both duplicated
    // and immediately wasted. Measured: dropping it took this from 7.7 s to the cost of the rest.
    .filter((r) => !r.current && now - r.lastActiveMs <= (sinceMs as number))
    .sort((a, b) => b.lastActiveMs - a.lastActiveMs);
  const warmed: string[] = [];
  for (const r of recent) {
    try {
      // The same cached build a switch performs. Its side effect — the map, placement and delta caches
      // on disk — is the entire point; the returned value is discarded.
      core.cachedChangeMap(cwd, r.id, { root: cwd, prompts: true });
      warmed.push(r.id);
      core.clearFsCache(); // the next session shares none of this one's file cache — hold one at a time
    } catch {
      /* a session that cannot be built is not a reason to abandon the rest */
    }
  }
  if (args.includes('--json')) {
    emitJson({ warmed, since: spec ?? '24h' });
    return;
  }
  process.stdout.write(c.green('✓ ') + `warmed ${warmed.length} session(s) active in the last ${spec ?? '24h'}\n`);
}


/**
 * WHERE THE OBSERVATORY KEEPS ITS DATA — show it, or move it.
 *
 * "Where does this thing put my files" had no answer anywhere in the product. The move is
 * `core.moveStore`, shared with the terminal's options window and both editors, because a setting
 * that changed where NEW data goes while leaving the old data behind would strand a session's
 * history somewhere the product no longer looks.
 */
function cmdStore(args: string[]): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const path = require('path') as typeof import('path');
  const flagAt = (f: string): string | undefined => {
    const i = args.indexOf(f);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const to = flagAt('--move');
  const toDefault = args.includes('--default');
  if (to !== undefined || toDefault) {
    const target = toDefault ? path.join(core.claudeConfigDir(), 'claude-observatory') : String(to);
    const parsed = toDefault ? { dir: target } : core.parseStorePath(target);
    if ('error' in parsed) fail(parsed.error);
    else {
      const res = core.moveStore(parsed.dir);
      if ('error' in res) fail(res.error);
      else {
        const prefs = core.readPrefs();
        if (toDefault) delete prefs.storeDir;
        else prefs.storeDir = parsed.dir;
        core.writePrefs(prefs);
        process.stdout.write(`${c.green('moved')} ${res.from}\n   →   ${res.to}\n`);
      }
    }
    return;
  }
  const dir = core.rootDir();
  const moved = Boolean(core.readPrefs().storeDir);
  if (args.includes('--json')) {
    emitJson({ dir, moved, default: path.join(core.claudeConfigDir(), 'claude-observatory') });
    return;
  }
  process.stdout.write(`${dir}${moved ? c.dim('   (moved)') : c.dim('   (default)')}\n`);
  process.stdout.write(c.dim('  every session\u2019s edits, snapshots and derived caches live here\n'));
  process.stdout.write(c.dim('  move it with: oak store --move <dir>   (--default puts it back)\n'));
}

/** SSH options every remote step of `machine add` shares — the same set the session listing uses:
 *  never prompt (a password prompt in a script hangs forever), fail fast, trust a first-contact
 *  host key, and reject a changed known key. */
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new'];

/** The verbs `--machine <label>` runs on a saved machine: everything Review and Observatory read or decide
 *  for a session whose store and files live there, and `__tab-sync`, with which the terminal app has a
 *  saved machine name its own session's herdr tab. `prompt` and `agent start` are deliberately absent:
 *  their `--machine` is herdr's (deliver to, or start in, that machine's pane) and keeps that meaning. */
const MACHINE_VERBS = new Set(['views', 'review', 'list', 'sessions', 'conversation', 'feed', 'multitask', 'subagents', 'diff', 'keep', 'undo', 'redo', 'resolve', 'comment', 'quote', 'ignore', '__tab-sync']);
/** End to end, for one command on a saved machine. A cold review read there takes seconds;
 *  connection setup allows 8 s; OAK_MACHINE_TIMEOUT_MS can extend this command deadline. */
const MACHINE_TIMEOUT_MS = 120_000;
/** Where a non-interactive ssh finds the remote's `oak` and the `node` it runs on. Such a shell sources
 *  no profile, so its PATH is the system's alone: `oak machine add` installs to ~/.local/bin, and npm or
 *  Homebrew globals land in /opt/homebrew/bin (Apple silicon) or /usr/local/bin. */
const MACHINE_PATH = '$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH';

/**
 * `oak <verb> … --machine <label>` — one session verb, run where the session's store and files are.
 *
 * Keep and undo revert files on disk, so a decision about a session on another machine can only run
 * there, and its review can only be read there: the store and the transcript never leave it. This
 * runs that machine's OWN installed `oak` over ssh with the `--machine` pair removed, and hands back
 * its stdout byte for byte (the JSON a local run prints), its stderr and its exit status, so a caller
 * treats a remote answer exactly like a local one. The ssh target is herdr's: OAK's machines ARE
 * herdr's. The remote command runs under `env PATH=…`, never an interactive shell, whose banner on
 * stdout would corrupt the JSON; each argument is single-quoted for the remote shell, so a comment or
 * a path with spaces arrives as one argument, unexpanded.
 */
async function forwardToMachine(verb: string, args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const isMachine = (a: string) => a === '--machine' || a.startsWith('--machine=');
  const at = args.findIndex(isMachine);
  const inline = args[at]?.startsWith('--machine=');
  const label = inline ? args[at].slice('--machine='.length) : args[at + 1];
  if (!label || label.startsWith('-')) fail('`--machine` needs a saved machine label — see `oak machine list`');
  const bin = core.findHerdrBin();
  if (!bin) fail('herdr is not installed on this machine — run `oak doctor --fix` first');
  let machines: import('@oak-observatory/core').HerdrMachine[];
  try {
    machines = await core.herdrMachines({ binary: bin, timeoutMs: 15000 });
  } catch (e) {
    fail(`could not read herdr's machine list: ${String((e as Error)?.message || e)}`);
  }
  if (args.filter(isMachine).length !== 1) fail('specify --machine only once');
  const matches = machines.filter(x => x.label === label || x.id === label);
  if (matches.length > 1) fail(`ambiguous saved machine "${label}" — use its unique id`);
  const m = matches[0];
  if (!m) fail(`no saved machine "${label}" — add it with \`oak machine add ${label} <ssh-target>\` (see \`oak machine list\`)`);
  if (!m.enabled) fail(`saved machine "${label}" is disabled — enable it in herdr before reviewing it`);
  if (!m.target || m.target.startsWith('-')) fail(`invalid ssh target for saved machine ${label}`);
  const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  const argv = [verb, ...args.filter((_, i) => i !== at && (inline || i !== at + 1))];
  // A same-version dev tag cannot prove support. Check the requested features before an older
  // CLI can ignore a flag, expand only part of a review unit, or return plain text instead of JSON.
  const needsProtocol = args.includes('--units') || (verb === 'diff' && args.includes('--json')) || (verb === 'comment' && (args[0] === 'mark-sent' || args.some(a => a.startsWith('--text='))));
  const marker = 'OAK_EXIT_' + require('crypto').randomBytes(12).toString('hex') + ':';
  const conversationProtocol = verb === 'conversation';
  const check = conversationProtocol
    ? `if [ "$(oak __conversation-protocol 2>/dev/null)" != 1 ]; then printf '%s\n' ${quote('oak: update OAK on ' + m.label + ' — this build does not support the requested conversation protocol')} >&2; exit 78; fi; `
    : needsProtocol
    ? `if [ "$(oak __review-protocol 2>/dev/null)" != 1 ]; then printf '%s\n' ${quote('oak: update OAK on ' + m.label + ' — this build does not support the requested review protocol')} >&2; exit 78; fi; `
    : '';
  // The final, private stderr marker distinguishes the remote program's exit 255 from SSH's 255.
  // It is removed below; the program's stdout, stderr and exit status remain unchanged.
  const present = `if ! command -v oak >/dev/null 2>&1; then printf '\n${marker}missing\n' >&2; exit 127; fi; `;
  const script = present + check + `oak "$@"; oak_status=$?; printf '\n${marker}%s\n' "$oak_status" >&2; exit "$oak_status"`;
  // OAK_FORWARDED: the remote runs in its session's own workspace rather than the login directory
  // (`enterSessionWorkspace`). OAK_FORWARDED_MACHINE: the label this side reaches it by, so a repair
  // command the remote prints ("not recorded … --record-only") runs from here. An older build there
  // ignores both.
  const remote = `env PATH="${MACHINE_PATH}" CLAUDE_OBSERVATORY_NO_UPDATE_CHECK=1 OAK_FORWARDED=1 OAK_FORWARDED_MACHINE=${quote(label)} sh -c ${quote(script)} oak ${argv.map(quote).join(' ')}`;
  const env = { ...process.env };
  // An ssh_config SendEnv wildcard must not export this machine's store or agent identity.
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE_') || ['CLAUDECODE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
      'CLAUDE_OBSERVATORY_SESSION', 'HERDR_SOCKET_PATH', 'XDG_CONFIG_HOME'].includes(key)) delete env[key];
  }
  const configured = Number(process.env.OAK_MACHINE_TIMEOUT_MS);
  const timeout = Number.isInteger(configured) && configured > 0 && configured <= 2147483647
    ? configured : MACHINE_TIMEOUT_MS;
  // -T: never a remote terminal, even where ssh_config asks for one (a pty turns \n into \r\n). stdin
  // is forwarded only to a verb told to read it (`ignore --stdin`): unforwarded, the remote read no
  // paths, and ssh must not swallow the caller's otherwise. `direct`: ssh is a real executable, and the
  // Windows shell route would drop the command's double quotes.
  const child = core.spawnTool('ssh', ['-T', ...SSH_OPTS, m.target, remote], { stdio: [args.includes('--stdin') ? 'inherit' : 'ignore', 'inherit', 'pipe'], direct: true, env });
  const errChunks: Buffer[] = [];
  child.stderr?.on('data', (d: Buffer) => errChunks.push(d));
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
    killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    killTimer.unref();
  }, timeout);
  child.on('error', (e: Error) => {
    clearTimeout(timer);
    fail(`could not run ssh: ${e.message}`);
  });
  child.on('close', (code: number | null) => {
    clearTimeout(timer);
    clearTimeout(killTimer);
    let err = Buffer.concat(errChunks).toString('utf8');
    const missing = err.endsWith(`\n${marker}missing\n`);
    if (missing) err = err.slice(0, -(`\n${marker}missing\n`).length);
    const receipt = err.match(new RegExp('\\n' + marker + '(\\d+)\\n$'));
    if (receipt) err = err.slice(0, -receipt[0].length);
    const reason = err.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';
    const refuse = (status: number, msg: string): never => {
      process.stderr.write(c.red('oak: ') + msg + '\n');
      process.exit(status);
    };
    if (timedOut) refuse(124, `${m.label} did not finish within ${timeout / 1000} s (OAK_MACHINE_TIMEOUT_MS); a decision may already have run — refresh before retrying`);
    // Without the completion receipt, 255 is an SSH failure, not a remote program result.
    if (code === 255 && !receipt) refuse(255, `${m.label} is not reachable over ssh (${m.target})${reason ? `: ${reason}` : ''}`);
    if (code === 127 && (missing || (!receipt && /(?:oak: (?:not found|No such file)|(?:env|sh):.*oak.*(?:not found|No such file))/.test(err)))) refuse(127, `OAK is not installed on ${m.label} — run \`oak machine add ${m.label} ${m.target}\` from here`);
    process.stderr.write(err);
    process.exit(code ?? 1);
  });
}

/**
 * The receiving end of `--machine`: a forwarded session verb runs in its session's own workspace.
 *
 * ssh starts the remote command in the login's home directory, and every transcript lookup that
 * walks up from the working directory found nothing from there: a forwarded review came back
 * untitled, with no reasoning, prompts or fleet, for any session not started in the home directory
 * itself. The workspace is the one the session's own transcript records (a sync mirror of another
 * machine's session is never read as one), so the command sees exactly what a run in that directory
 * sees. `--root`, when given, still decides the views that take it.
 */
function enterSessionWorkspace(args: string[]): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const id = flagValue(args, '--session');
  try {
    const dir = id && core.isSafeSessionId(id) ? core.sessionWorkspace(id) : null;
    if (dir) process.chdir(dir);
  } catch {
    /* no readable transcript, or its workspace is gone: the login directory stands, as before */
  }
}

/**
 * `machine add <label> <ssh-target>` / `machine list [--json]` — OAK's machines ARE herdr's.
 *
 * `herdr machine add` can install the remote binary itself, but it asks a human to approve that
 * install, which needs an interactive TTY and therefore stalls inside a script. So OAK puts the
 * PINNED binary there first — checksum-verified before it is copied, at the `~/.local/bin/herdr`
 * path herdr's own remote discovery looks in — and herdr's step then finds a matching install and
 * saves the machine with nothing to approve.
 */
/**
 * `oak attach [machine]` — tmux over SSH: run agents and OAK ON the target, then attach this
 * terminal to its herdr. Nothing is copied across machines; review (keep/undo write the remote's
 * store and revert its files) runs where the work is. Idempotently ensures a pane labelled `oak`
 * exists on the remote so the attach lands on a review surface, not a bare shell. OAK's machines
 * ARE herdr's, so the ssh target comes from herdr's own machine list.
 */
async function cmdAttach(args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const bin = core.findHerdrBin();
  if (!bin) fail('herdr is not installed on this machine — run `oak doctor --fix` first');
  const label = args.find((a) => !a.startsWith('-'));
  let target: string | undefined;
  let session: string | undefined;
  if (label) {
    let machines: { label: string; id: string; target: string; session?: string }[] = [];
    try { machines = JSON.parse(String(core.spawnToolSync(bin, ['machine', 'list', '--json'], { encoding: 'utf8', timeout: 15000 }).stdout || '[]')); }
    catch { /* leave empty → the not-found message below */ }
    const m = machines.find((x) => x.label === label || x.id === label);
    if (!m) fail(`no saved machine "${label}" — add it with \`oak machine add ${label} <ssh-target>\` (see \`oak machine list\`)`);
    target = m.target; session = m.session;
  }
  const where = label ?? 'this machine';
  // Local and a saved machine both drive herdr's own CLI; only the `--machine` prefix differs.
  const ask = (argv: string[]) => core.spawnToolSync(bin, [...(label ? ['--machine', label] : []), ...argv], { encoding: 'utf8', timeout: label ? 30000 : 8000 });
  // Ensure OAK runs in a herdr pane, so attaching lands on the observatory, not a shell. Idempotent:
  // reuse a tab already labelled `oak` (and focus it) rather than stacking a new one each attach.
  let snap: { tabs?: { label?: string; tab_id?: string }[]; focused_workspace_id?: string } = {};
  try { const j = JSON.parse(String(ask(['api', 'snapshot']).stdout || '{}')); snap = (j?.result?.snapshot ?? j?.snapshot ?? j ?? {}); }
  catch { /* treat as no oak pane and create one */ }
  const existing = (snap.tabs ?? []).find((t) => t.label === 'oak');
  let oakTab: string | undefined = existing?.tab_id;
  if (existing) {
    process.stdout.write(c.dim(`OAK is already running in a herdr pane on ${where}\n`));
  } else {
    process.stdout.write(c.dim(`starting OAK in a herdr pane on ${where} …\n`));
    try {
      const created = JSON.parse(String(ask(['tab', 'create', '--label', 'oak', ...(snap.focused_workspace_id ? ['--workspace', snap.focused_workspace_id] : [])]).stdout || '{}'));
      oakTab = created?.result?.tab?.tab_id ?? created?.tab?.tab_id;
      const pane: string | undefined = created?.result?.root_pane?.pane_id ?? created?.root_pane?.pane_id;
      if (pane) ask(['pane', 'send-text', pane, 'oak\n']);
    } catch { process.stdout.write(c.dim(`(could not pre-start OAK on ${where}; run \`oak\` in a pane after attaching)\n`)); }
  }
  if (oakTab) { try { ask(['tab', 'focus', oakTab]); } catch { /* best-effort landing on the oak tab */ } }
  // Inside herdr already? herdr refuses to nest, so don't hand off — the target is reachable in
  // herdr's own machine/workspace sidebar (its `oak` tab is now ready there). oak attach bootstraps
  // from a plain terminal outside herdr.
  if (process.env.HERDR_PANE_ID) {
    process.stdout.write(c.yellow('! ') + `you're already inside herdr — ${where}${target ? ` (${target})` : ''} is in herdr's machine sidebar; select it there (its \`oak\` tab is ready). Run \`oak attach\` from a plain terminal to open a fresh herdr.\n`);
    return;
  }
  // Hand this terminal to herdr — a tmux-style attach; ctrl+b q detaches and returns here. Only a tab
  // herdr confirmed is announced as up: an unreachable herdr creates none and says nothing.
  process.stdout.write(
    (oakTab ? c.green('✓ ') + `attaching to ${where}${target ? ` (${target})` : ''} — the \`oak\` tab is up`
      : c.yellow('! ') + `attaching to ${where}${target ? ` (${target})` : ''} — OAK could not be started there; run \`oak\` in a pane once attached`) +
      '; press ctrl+b then q to detach\n'
  );
  const attach = target ? ['--remote', target, ...(session && session !== 'default' ? ['--session', session] : [])] : [];
  // herdr's client starts the server when none runs, and a server born from a Claude Code session's
  // shell (an agent running `oak attach`, a `!` command) would stamp every pane's agent as a child
  // session — the same strip the terminal's herdr tab applies.
  const r = core.spawnToolSync(bin, attach, { stdio: 'inherit', env: core.stripSessionIdentity(process.env) });
  process.exit(typeof r.status === 'number' ? r.status : 0);
}
async function cmdMachine(args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const bin = core.findHerdrBin();
  if (!bin) fail('herdr is not installed on this machine — run `oak doctor --fix` first');
  const sub = args[0];
  if (sub === 'list') {
    // A PASSTHROUGH, deliberately: herdr owns the machine list, and a second rendering of it here
    // would be one more thing to keep in step for no new information.
    const r = core.spawnToolSync(bin, ['machine', 'list', '--json'], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  if (sub !== 'add') fail('usage: oak machine add <label> <ssh-target>   |   oak machine list [--json]');
  const positional = args.slice(1).filter((a) => !a.startsWith('-'));
  let label = positional[0];
  const target = positional[1];
  if (!label || !target) fail('usage: oak machine add <label> <ssh-target>');
  const lock = core.readHerdrLock();
  const ssh = (script: string) =>
    core.spawnToolSync('ssh', [...SSH_OPTS, target, script], { encoding: 'utf8', timeout: 120000 });
  const why = (r: { stderr: string | Buffer; status: number | null }): string =>
    String(r.stderr ?? '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || `exit ${r.status ?? '?'}`;

  process.stdout.write(c.dim(`probing ${target} …\n`));
  const un = ssh('uname -s; uname -m');
  if (un.status !== 0) fail(`could not reach ${target}: ${why(un)}`);
  const [sysname = '', machine = ''] = String(un.stdout).trim().split('\n').map((l) => l.trim());
  const key = core.herdrPlatformKeyFromUname(sysname, machine);
  // Windows is a herdr release but not an ssh-remote one (its install is a zip + DLLs, and herdr's
  // remote path is POSIX). Say which machine and why rather than failing three steps later.
  if (!key) fail(`herdr publishes no ssh-installable binary for ${sysname || '?'}/${machine || '?'} — install it on ${target} yourself`);

  const already = core.parseHerdrVersion(ssh('if [ -x "$HOME/.local/bin/herdr" ]; then "$HOME/.local/bin/herdr" --version; elif command -v herdr >/dev/null 2>&1; then herdr --version; fi').stdout);
  if (already && core.compareVersions(already, lock.version) >= 0) {
    process.stdout.write(c.dim(`${target} already runs herdr ${already}\n`));
  } else {
    // Same platform and already pinned here? Copy the bytes this machine verified at install time
    // instead of pulling the identical asset down a second time.
    const localProbe = core.probeHerdr({ lock });
    const reuse = core.herdrPlatformKey() === key && localProbe.bin && localProbe.version === lock.version;
    const tmpDir = reuse ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'oak-herdr-'));
    try {
      let src = localProbe.bin as string;
      if (tmpDir) {
        process.stdout.write(c.dim(`downloading herdr ${lock.version} (${key}) …\n`));
        src = path.join(tmpDir, 'herdr');
        await core.downloadHerdrAsset(key, src, { lock });
      }
      const mk = ssh('mkdir -p "$HOME/.local/bin"');
      if (mk.status !== 0) fail(`could not create ~/.local/bin on ${target}: ${why(mk)}`);
      process.stdout.write(c.dim(`copying herdr ${lock.version} to ${target}:~/.local/bin/herdr …\n`));
      const cp = core.spawnToolSync('scp', [...SSH_OPTS, src, `${target}:.local/bin/herdr.oak-new`], {
        encoding: 'utf8',
        timeout: 600000,
      });
      if (cp.status !== 0) fail(`scp to ${target} failed: ${why(cp)}`);
      // Land it with a rename, never a write-in-place: overwriting a herdr that is currently running
      // is ETXTBSY on Linux, while a rename swaps it cleanly under the running process.
      const land = ssh('chmod 0755 "$HOME/.local/bin/herdr.oak-new" && mv "$HOME/.local/bin/herdr.oak-new" "$HOME/.local/bin/herdr"');
      if (land.status !== 0) fail(`could not install herdr on ${target}: ${why(land)}`);
      // macOS refuses to run a quarantined binary with a dialog no ssh session can answer. Stripping
      // the attribute is best-effort: a file that never carried one makes xattr exit nonzero, which
      // is not a failure of anything.
      if (sysname.trim().toLowerCase() === 'darwin') ssh('xattr -d com.apple.quarantine "$HOME/.local/bin/herdr" >/dev/null 2>&1; true');
      const got = core.parseHerdrVersion(ssh('"$HOME/.local/bin/herdr" --version').stdout);
      if (got !== lock.version) fail(`installed herdr on ${target}, but it reports ${got ?? 'nothing'} (expected ${lock.version})`);
      process.stdout.write(c.green('✓ ') + `herdr ${got} installed on ${target}\n`);
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // Idempotent: `herdr machine add` appends a new entry every call, so a re-run (e.g. to update the
  // oak stack) would duplicate the machine. Skip it when this target/label is already saved.
  const saved = (() => { try { return JSON.parse(String(core.spawnToolSync(bin, ['machine', 'list', '--json'], { encoding: 'utf8', timeout: 15000 }).stdout || '[]')) as { id?: string; target?: string; label?: string }[]; } catch { return []; } })();
  const byLabel = saved.find((m) => m.label === label);
  const byTarget = saved.find((m) => m.target === target);
  if (byLabel && byLabel.target !== target) {
    // The same name for a different host is a conflict, not a no-op: silently keeping the old entry
    // sent every later attach to the wrong machine.
    fail(`machine ${label} is already saved as ${byLabel.target}, not ${target} — \`herdr machine remove ${byLabel.id ?? label}\` first, or pick another label`);
  } else if (byTarget && byTarget.label !== label) {
    process.stdout.write(c.dim(`${target} is already saved in herdr as ${byTarget.label} — using that label\n`));
    label = byTarget.label as string;
  } else if (byLabel || byTarget) {
    process.stdout.write(c.dim(`machine ${label} → ${target} already saved in herdr\n`));
  } else {
    const add = core.spawnToolSync(bin, ['machine', 'add', target, '--label', label], { stdio: 'inherit' });
    if (add.status !== 0) fail(`\`herdr machine add\` failed (exit ${add.status ?? '?'}) — the remote binary is installed; re-run once the reason above is fixed`);
    process.stdout.write(c.green('✓ ') + `machine ${label} → ${target}\n`);
  }
  await installOakStack(target, __dirname);
}

/**
 * Install the OAK stack on a remote machine so the tmux-attach model actually works there: the CLI
 * bundle (verified to run standalone — no node_modules), its sidecar assets, and the capture hooks.
 * herdr alone runs terminals but cannot render the observatory or capture edits. Node 20+ is OAK's
 * only extra remote runtime need; without it we WARN and leave herdr working rather than fail the add.
 * `distDir` is this bundle's own directory (`__dirname`), which holds the index.js launcher, cli.js
 * (this CLI), capture.js + the sidecar assets.
 */
async function installOakStack(target: string, distDir: string): Promise<void> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const path = require('path');
  const ssh = (script: string) => core.spawnToolSync('ssh', [...SSH_OPTS, target, script], { encoding: 'utf8', timeout: 120000 });
  const scp = (args: string[]) => core.spawnToolSync('scp', [...SSH_OPTS, ...args], { encoding: 'utf8', timeout: 600000 });
  const why = (r: { stderr?: string | Buffer; status: number | null }): string =>
    String(r.stderr ?? '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || `exit ${r.status ?? '?'}`;

  // Node 20+ is OAK's only extra remote runtime need. A stock host often has it user-local in
  // ~/.local/bin, which a non-interactive ssh does NOT put on PATH — so check that path explicitly too.
  const nodeV = ssh('command -v node >/dev/null 2>&1 && node --version || { [ -x "$HOME/.local/bin/node" ] && "$HOME/.local/bin/node" --version; } || true');
  const major = /v(\d+)/.exec(String(nodeV.stdout || ''));
  if (!major || Number(major[1]) < 20) {
    process.stdout.write(c.yellow('! ') + `oak not installed on ${target}: needs Node.js 20+ (found ${String(nodeV.stdout).trim() || 'none'}). herdr is set up; install Node 20+ there and re-run \`oak machine add <label> ${target}\` to enable review + capture.\n`);
    return;
  }
  process.stdout.write(c.dim(`installing oak + capture hooks on ${target} …\n`));
  const mk = ssh('mkdir -p "$HOME/.local/lib/oak/herdr-plugin" "$HOME/.local/bin"');
  if (mk.status !== 0) fail(`could not create ~/.local on ${target}: ${why(mk)}`);
  // Put ~/.local/bin on PATH for login (.profile) and interactive (.bashrc) shells — a stock host does
  // not, so `oak` and the capture hooks would not resolve in the agent's pane. Idempotent; printf is
  // single-quoted so $HOME/$PATH land literally in the rc, evaluated when a shell starts.
  // …and .zprofile: zsh (the macOS default) reads neither of the other two.
  ssh('for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zprofile"; do touch "$rc"; grep -q "oak: user-local bin on PATH" "$rc" || printf \'\\n# oak: user-local bin on PATH\\nexport PATH="$HOME/.local/bin:$PATH"\\n\' >> "$rc"; done');
  // The index.js launcher is copied last, after the two bundles it loads, so a failed copy never
  // leaves it pointing at a cli.js that is not there.
  for (const f of ['cli.js', 'capture.js', 'THIRD_PARTY_NOTICES.md', 'index.js']) {
    const cp = scp([path.join(distDir, f), `${target}:.local/lib/oak/${f}`]);
    if (cp.status !== 0) fail(`could not copy oak/${f} to ${target}: ${why(cp)}`);
  }
  // The manifest rides beside the bundle so `oak --version` there is the real version (without it
  // `oak update` on the remote planned an update forever). It is found
  // where version() looks: ../package.json in an npm install, beside index.js in a bundle that
  // `oak machine add` itself pushed (a remote adding a machine of its own).
  const manifest = [path.join(distDir, '..', 'package.json'), path.join(distDir, 'package.json')].find((p) => require('fs').existsSync(p));
  const cpManifest = scp([manifest ?? path.join(distDir, 'package.json'), `${target}:.local/lib/oak/package.json`]);
  if (cpManifest.status !== 0) fail(`could not copy package.json to ${target}: ${why(cpManifest)}`);
  const cpPlugin = scp(['-r', path.join(distDir, 'herdr-plugin') + '/.', `${target}:.local/lib/oak/herdr-plugin/`]);
  if (cpPlugin.status !== 0) fail(`could not copy the herdr plugin to ${target}: ${why(cpPlugin)}`);
  // Launcher that resolves node at RUN time — system node if on PATH, else the user-local one — so it
  // works even from a hook's non-interactive shell. $HOME/$@ stay literal (printf is single-quoted).
  const launch = ssh('printf \'#!/bin/sh\\nexec "$(command -v node 2>/dev/null || echo "$HOME/.local/bin/node")" "$HOME/.local/lib/oak/index.js" "$@"\\n\' > "$HOME/.local/bin/oak" && chmod 0755 "$HOME/.local/bin/oak"');
  if (launch.status !== 0) fail(`could not install the oak launcher on ${target}: ${why(launch)}`);
  // Capture hooks (claude + codex), then verify oak actually runs. Hooks are best-effort; a dead oak
  // is a hard failure. `--no-codex` on the plain init: its codex step can also wire a local model, a
  // config change that must never happen where nobody sees it; `init --codex` installs the hooks.
  const init = ssh('PATH="$HOME/.local/bin:$PATH"; oak init --no-codex >/dev/null 2>&1 || true; oak init --codex >/dev/null 2>&1 || true; oak --version 2>&1');
  if (!/oak\s+\S+/.test(String(init.stdout || ''))) fail(`installed oak on ${target}, but it did not run: ${why(init)}`);
  process.stdout.write(c.green('\u2713 ') + `oak installed on ${target} (${String(init.stdout).trim()}) + capture hooks; ~/.local/bin on PATH\n`);
}


/**
 * `oak inbox` — every session waiting on you, most urgent first: permission
 * prompts, then questions (with their real options), then input waits, then finished turns. `--next
 * [--after <id>]` prints the one to jump to — the rule the terminal app's `h` key and both editors'
 * "next hand" commands share (JetBrains reaches it here, in one place, rather than mirroring it).
 */
function cmdInbox(args: string[]): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const root = flagValue(args, '--root') ?? process.cwd();
  const inbox = core.attentionInbox(root, { includeDone: !args.includes('--no-done') });
  if (args.includes('--next')) {
    const after = flagValue(args, '--after') ?? null;
    const id = core.nextAttention(inbox.hands.map((h) => ({ id: h.id, attention: { kind: h.kind, ts: h.ts } })), after);
    // The whole row rides along, so a caller that needs the label (JetBrains' balloon) makes ONE call.
    if (args.includes('--json')) emitJson({ next: id, hand: inbox.hands.find((h) => h.id === id) ?? null });
    else process.stdout.write(id ? `${id}\n` : c.dim('nobody is waiting on you\n'));
    return;
  }
  if (args.includes('--json')) {
    emitJson(inbox);
    return;
  }
  if (!inbox.hands.length) {
    process.stdout.write(c.dim('nobody is waiting on you\n'));
    return;
  }
  for (const h of inbox.hands) {
    const kind = h.kind === 'idle-done' ? c.dim('done      ') : c.yellow(h.kind.padEnd(10));
    const wait = h.kind === 'idle-done' ? '' : c.dim(`  ${core.compactDuration(h.waitingMs)} waiting`);
    const agent = h.agent && h.agent !== 'claude' ? c.yellow(`[${h.agent}] `) : '';
    const name = h.title ? `${c.bold(h.title)}  ${c.dim(h.id)}` : c.bold(h.id);
    process.stdout.write(`${kind}  ${agent}${name}${h.message ? ` — ${h.message}` : ''}${wait}\n`);
    if (h.question) {
      process.stdout.write(c.dim(`            ${h.question.header ? `${h.question.header}: ` : ''}${h.question.question}\n`));
      h.question.options.forEach((o, i) => process.stdout.write(c.dim(`              ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}\n`)));
    }
  }
  const waited = inbox.hands.reduce((s, h) => s + h.waitedTodayMs, 0);
  if (waited > 0) process.stdout.write(c.dim(`\nleft waiting on you today: ${core.compactDuration(waited)}\n`));
}

/**
 * `oak search <words…>` — every conversation on this machine, ranked:
 * the asks you typed and the prose that answered them, across sessions and workspaces. Every word
 * must appear; a hit in the ask outranks one in the answer. `--query <text>` is the same thing as one
 * argument (the terminal app's door — a value, never a leading dash); `--days N` narrows to sessions
 * active since; `--limit N` caps the rows (50).
 */
function cmdSearch(args: string[]): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const root = flagValue(args, '--root') ?? process.cwd();
  const flagged = flagValue(args, '--query');
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (FLAGS_WITH_VALUES.has(a)) i++;
      continue;
    }
    words.push(a);
  }
  const query = (flagged ?? words.join(' ')).trim();
  if (!query) fail('search needs some words: oak search <words…> (or --query <text>)');
  const days = Number(flagValue(args, '--days'));
  const limit = Number(flagValue(args, '--limit'));
  const res = core.searchConversations(root, query, {
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined,
    sinceMs: Number.isFinite(days) && days > 0 ? Date.now() - days * 86_400_000 : undefined,
  });
  if (args.includes('--json')) {
    emitJson(res);
    return;
  }
  if (!res.hits.length) {
    process.stdout.write(c.dim(`nothing matches “${query}” across ${res.sessions} session${res.sessions === 1 ? '' : 's'} (${res.asks} asks, ${res.ms} ms)\n`));
    return;
  }
  for (const h of res.hits) {
    const name = h.title ? c.bold(h.title) : c.bold(h.session);
    const agent = h.agent && h.agent !== 'claude' ? c.yellow(`[${h.agent}] `) : '';
    process.stdout.write(`${agent}${name}  ${c.dim(`${h.session.slice(0, 8)} · ${core.relTime(h.ts)}${h.workspace ? ` · ${h.workspace}` : ''}`)}\n`);
    process.stdout.write(`    ${c.dim(h.where === 'prompt' ? 'ask' : 'answer')}  ${h.snippet}\n`);
  }
  process.stdout.write(c.dim(`\n${res.hits.length} of the asks matching “${query}” · ${res.sessions} sessions, ${res.asks} asks, ${res.ms} ms${res.indexed ? ` (indexed ${res.indexed} session${res.indexed === 1 ? '' : 's'} on the way)` : ''}\n`));
}

/**
 * `oak notify` — desktop notifications for raised hands.
 *   --message <text> [--title <t>] [--sound]     pop one notification (the plumbing check)
 *   --session <id> --kind <k> --ts <ms> [...]    announce a row IF DUE — the once-per-machine claim
 *                                                 and cooldown every surface shares; JetBrains' door
 *   --watch [--interval <s>]                      headless: announce every hand this workspace raises,
 *                                                 from a plain terminal with no editor open
 * Never answers anything: the notification says who is waiting; the answer stays in the agent's terminal.
 */
async function cmdNotify(args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const root = flagValue(args, '--root') ?? process.cwd();
  if (args.includes('--watch')) {
    const every = Math.max(1, Number(flagValue(args, '--interval') ?? 3) || 3);
    const via = core.desktopNotifier();
    process.stdout.write(
      `watching ${root} — desktop notifications via ${via === 'none' ? c.red('nothing (no notify-send, gdbus or osascript found)') : via === 'osc9' ? 'this terminal (OSC 9)' : via} · every ${every}s · ctrl+c stops\n`
    );
    const tick = (): void => {
      try {
        for (const r of core.sessionMeta(root).sessions) {
          if (core.announceAttention(r)) process.stdout.write(`${core.relTime(Date.now())}  ${r.title ?? r.id}  ${core.attentionLabel(r.attention!.kind)}${r.attention!.message ? ` — ${r.attention!.message}` : ''}\n`);
        }
      } catch (e) {
        process.stderr.write(`notify: ${String((e as Error).message)}\n`);
      }
    };
    tick();
    setInterval(tick, every * 1000);
    process.on('SIGINT', () => process.exit(0));
    await new Promise<void>(() => {
      /* runs until interrupted */
    });
    return;
  }
  const session = flagValue(args, '--session');
  if (session) {
    if (!core.isSafeSessionId(session)) fail(`notify: invalid session id "${session}"`);
    const kind = flagValue(args, '--kind') as HandKind | undefined;
    const ts = Number(flagValue(args, '--ts'));
    if (!kind || !(core.HAND_KINDS as readonly string[]).includes(kind) || !Number.isFinite(ts)) fail('notify --session needs --kind <permission|question|input|idle-done> and --ts <ms>');
    const sent = core.announceAttention({ id: session, title: flagValue(args, '--title') ?? null, agent: flagValue(args, '--agent') ?? '', attention: { kind, message: flagValue(args, '--message') ?? '', ts } });
    if (args.includes('--json')) emitJson({ sent });
    else process.stdout.write(sent ? 'notified\n' : c.dim('not due — already announced, inside the cooldown, or off in the options\n'));
    return;
  }
  const message = flagValue(args, '--message');
  if (!message) fail('notify needs --message <text> (with --title), or --session <id> --kind <k> --ts <ms>, or --watch');
  const r = core.desktopNotify(flagValue(args, '--title') ?? 'OAK', message, { sound: args.includes('--sound') });
  if (args.includes('--json')) emitJson(r);
  else process.stdout.write(r.sent ? `sent via ${r.via === 'osc9' ? 'this terminal (OSC 9)' : r.via}\n` : c.red(`no desktop notifier on this machine (${r.via})\n`));
}

/** Ask an attached OAK terminal to select a conversation or review tab. */
async function cmdFocus(args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as Core;
  let session = flagValue(args, '--session');
  const pane = flagValue(args, '--pane');
  if (!session && pane) {
    const snapshot = await core.herdrSnapshot();
    session = snapshot.panes.find(p => p.pane_id === pane)?.agent_session?.value;
  }
  const tab = (flagValue(args, '--tab') ?? 'observatory').toLowerCase();
  if (!session || !core.isSafeSessionId(session)) return fail('focus needs --session <id>, or --pane <id> with a live session');
  if (!['observatory', 'review', 'herdr'].includes(tab)) return fail('focus --tab: observatory | review | herdr');
  const client = await core.connectDaemon({ client: 'focus' });
  if (!client) return fail('no OAK focus endpoint — open oak tui first');
  try {
    await client.request({ op: 'focus', session, tab: tab as import('@oak-observatory/core').FocusTab });
    if (args.includes('--json')) emitJson({ focused: true, session, tab });
  } finally { client.close(); }
}

async function cmdServer(args: string[]): Promise<void> {
  const unsupported = args.find(a => a.startsWith('--') && !['--daemon', '--json'].includes(a));
  if (unsupported) return fail(`server does not support ${unsupported}; this is a local focus endpoint`);
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  if (args.includes('--daemon')) {
    (require('@oak-observatory/tui') as typeof import('@oak-observatory/tui')).runServer(core);
    return new Promise(() => {
      /* the server lives until it shuts itself down */
    });
  }
  const sub = args.find((a) => !a.startsWith('--')) ?? 'status';
  const json = args.includes('--json');
  if (sub === 'start') {
    const r = await core.ensureDaemon({ client: 'cli' });
    if (!r.client) return fail(r.why);
    r.client.close();
    const st = await core.daemonStatus();
    if (json) emitJson({ ...st, spawned: r.spawned });
    else process.stdout.write(`${r.spawned ? 'started' : 'already running'} — oak server pid ${st.pid} · ${st.sock}\n`);
    return;
  }
  if (sub === 'stop') {
    const r = await core.stopDaemon();
    if (json) emitJson(r);
    else process.stdout.write(r.stopped ? 'oak server stopped — focus endpoint closed\n' : c.dim(`${r.why}\n`));
    if (!r.stopped && r.why !== 'no oak server is running') process.exitCode = 1;
    return;
  }
  if (sub === 'status') {
    const st = await core.daemonStatus();
    if (json) return emitJson(st);
    if (!st.running) {
      process.stdout.write(c.dim(`no oak server is running${st.stale ? ` (a stale pidfile names ${st.pid} — \`oak server start\` reclaims it)` : ''}\n`));
      return;
    }
    const same = st.build === core.buildStamp();
    process.stdout.write(
      `oak server pid ${st.pid} · protocol ${st.protocol} · up since ${core.relTime(st.started)} · ` +
        `${same ? 'the same build as this oak' : c.yellow('an older build than this oak — `oak server stop` and reopen a tab to update it')}\n`
    );

    return;
  }
  return fail(`server: unknown subcommand "${sub}" — start | stop | status`);
}

/** A failed or unavailable prompt keeps a clipboard draft and printable text. */
async function promptDraft(session: string, text: string, args: string[]): Promise<boolean> {
  const core = require('@oak-observatory/core') as Core;
  let result: { sent: boolean; reason?: string };
  try { result = await core.promptSession(session, text, { machine: flagValue(args, '--machine') }); }
  catch (error) { result = { sent: false, reason: String((error as Error).message || error) }; }
  if (!result.sent) {
    const choices = process.platform === 'darwin' ? [['pbcopy']] : process.platform === 'win32' ? [['clip.exe']] : [['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']];
    for (const [file, ...argv] of choices) {
      const copied = core.spawnToolSync(file, argv, { input: text, encoding: 'utf8', timeout: 2000 });
      if (!copied.error && copied.status === 0) break;
    }
  }
  if (args.includes('--json')) emitJson({ ...result, text });
  else if (result.sent) process.stdout.write('Sent to the agent.\n');
  else { process.stderr.write(`Draft retained: ${result.reason}\n`); process.stdout.write(text + '\n'); }
  return result.sent;
}

async function cmdPrompt(args: string[]): Promise<void> {
  const session = flagValue(args, '--session'), text = flagValue(args, '--text');
  if (!session || !text) return fail('prompt needs --session <id> --text <text>');
  if (await promptDraft(session, text, args)) {
    const ids = flagValue(args, '--comment-ids')?.split(',').filter(Boolean) ?? [];
    if (ids.length) (require('@oak-observatory/core') as Core).markCommentsSent(session, ids);
  }
}

async function cmdAgent(args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as Core;
  if (args[0] !== 'start') return fail('agent: start --kind claude|codex [--cwd <dir>] [--machine <label|ssh-target>]');
  const kind = flagValue(args, '--kind');
  if (kind !== 'claude' && kind !== 'codex') return fail('agent start needs --kind claude|codex');
  const cwd = flagValue(args, '--cwd');
  const machineArg = flagValue(args, '--machine');
  if (machineArg) {
    // Spin an agent up ON a remote machine from here, then drop into its OAK (the chosen flow).
    // Auto-provisions an unknown machine (installs herdr + saves it) so a brand-new remote works
    // from this one command. OAK's machines ARE herdr's.
    const bin = core.findHerdrBin();
    if (!bin) return fail('herdr is not installed on this machine — run `oak doctor --fix` first');
    let machines: { label: string; id: string; target: string }[] = [];
    try { machines = JSON.parse(String(core.spawnToolSync(bin, ['machine', 'list', '--json'], { encoding: 'utf8', timeout: 15000 }).stdout || '[]')); }
    catch { /* none saved yet → provision below */ }
    // By label, id OR ssh target: `--machine user@host` for a host saved under a label re-provisioned
    // the whole stack and then failed, because herdr's --machine takes only a label or id.
    let label = machines.find((m) => m.label === machineArg || m.id === machineArg || m.target === machineArg)?.label;
    if (!label) {
      process.stdout.write(c.dim(`${machineArg} is not a saved machine — setting it up first …\n`));
      await cmdMachine(['add', machineArg, machineArg]); // installs herdr on the target and saves it
      label = machineArg;
    }
    const ask = (argv: string[]) => core.spawnToolSync(bin, ['--machine', label as string, ...argv], { encoding: 'utf8', timeout: 60000 });
    const created = JSON.parse(String(ask(['tab', 'create', '--label', kind, ...(cwd ? ['--cwd', cwd] : [])]).stdout || '{}'));
    const pane: string | undefined = created?.result?.root_pane?.pane_id ?? created?.root_pane?.pane_id;
    if (!pane) return fail(`could not open a herdr pane on ${label}`);
    const name = `oak-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    ask(['agent', 'start', name, '--kind', kind, '--pane', pane]);
    process.stdout.write(c.green('✓ ') + `started ${kind} on ${label} in herdr pane ${pane}\n`);
    return cmdAttach([label]); // spawn + drop into OAK — lands on the oak tab to watch and review it
  }
  const result = await core.startAgentSession(kind, cwd ?? process.cwd());
  if (args.includes('--json')) emitJson(result);
  else process.stdout.write(`Started ${kind} in herdr pane ${result.pane}.\n`);
}
/** `oak quote` — the agent's last reply as a `> ` block for the composer (#6/#7). */
async function cmdQuote(args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as Core;
  const session = flagValue(args, '--session');
  if (!session) return fail('quote needs --session <id>');
  const q = core.quoteAgentOutput(session);
  if (!q) return fail('nothing to quote — the agent has not replied yet in this session');
  const text = q + (flagValue(args, '--text') ?? '');
  if (args.includes('--send')) await promptDraft(session, text, args);
  else if (args.includes('--json')) emitJson({ text, sent: false });
  else process.stdout.write(text);
}

/** `oak comment` — line comments on a pending edit, batched into one prompt. The editors' shell
 *  door: JetBrains shells these; VS Code and the terminal app call core directly. add/list/rm/compose. */
async function cmdComment(args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as Core;
  const sub = args.find((a) => !a.startsWith('--')) ?? 'list';
  const session = flagValue(args, '--session');
  const json = args.includes('--json');
  const cwd = flagValue(args, '--cwd') ?? process.cwd();
  if (!session) return fail('comment needs --session <id>');
  const unit = flagValue(args, '--edit') !== undefined ? Number(flagValue(args, '--edit')) : undefined;
  const file = flagValue(args, '--file');
  if (sub === 'add') {
    const line = flagValue(args, '--line') !== undefined ? Number(flagValue(args, '--line')) : 0;
    const textArg = flagValue(args, '--text');
    const positional = args.filter((a, i) => !a.startsWith('--') && a !== 'add' && !(i > 0 && FLAGS_WITH_VALUES.has(args[i - 1])));
    const text = textArg ?? positional.join(' ');
    if (unit === undefined || !Number.isFinite(unit)) return fail('comment add needs --edit <unit id>');
    if (!text) return fail('comment add needs --text "<comment>"');
    const c2 = core.addComment(session, { unit, line, text });
    if (!c2) return fail(`no pending edit #${unit} in session ${session}`);
    if (json) emitJson(c2);
    else process.stdout.write(`added comment ${c2.id} on ${core.relPath(cwd, c2.file)}${c2.line ? `:${c2.line}` : ''}\n`);
    return;
  }
  if (sub === 'list') {
    const cs = core.listComments(session, { unit, file, unsentOnly: args.includes('--unsent') });
    if (json) return emitJson({ comments: cs });
    if (!cs.length) return void process.stdout.write(c.dim('no comments\n'));
    for (const cm of cs) {
      process.stdout.write(`${cm.sentAt ? c.dim('sent   ') : c.yellow('pending')} ${core.relPath(cwd, cm.file)}${cm.line ? `:${cm.line}` : ''}  ${cm.text}  ${c.dim(cm.id)}\n`);
    }
    return;
  }
  if (sub === 'rm') {
    const id = flagValue(args, '--id');
    if (!id) return fail('comment rm needs --id <comment id>');
    const ok = core.removeComment(session, id);
    if (json) emitJson({ removed: ok });
    else process.stdout.write(ok ? `removed ${id}\n` : c.dim(`no comment ${id}\n`));
    if (!ok) process.exitCode = 1;
    return;
  }
  if (sub === 'compose' || sub === 'send') {
    const p = core.composeCommentPrompt(session, { unit, file, cwd });
    if (!p) {
      if (json) emitJson({ text: '', ids: [], files: [] });
      else process.stdout.write(c.dim('no unsent comments to compose\n'));
      return;
    }
    if (sub === 'send') {
      if (await promptDraft(session, p.text, args)) core.markCommentsSent(session, p.ids);
      return;
    }
    if (json) emitJson(p);
    else process.stdout.write(p.text + '\n');
    return;
  }
  if (sub === 'mark-sent') {
    // The ledger step `send` and `prompt --comment-ids` take after a delivered prompt, for a reply that
    // went out another way: through herdr from another machine, whose OAK holds none of these comments.
    const ids = (flagValue(args, '--ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return fail('comment mark-sent needs --ids <comment id,…>');
    const marked = core.listComments(session, { unsentOnly: true }).filter((cm) => ids.includes(cm.id)).length;
    core.markCommentsSent(session, ids);
    if (json) emitJson({ marked });
    else process.stdout.write(`marked ${marked} comment(s) sent\n`);
    return;
  }
  return fail(`comment: unknown subcommand "${sub}" — add | list | rm | compose | send | mark-sent`);
}

/**
 * `titles` — the Remote Control titles OAK reads from claude.ai (core remote-titles.ts): the status of
 * the last read by default; `--refresh` reads now; `--off` / `--on` set `prefs.remoteTitles`. The
 * pollers run `--refresh --if-due` detached, which honours the throttle and must exit even if a request
 * or an inherited handle never settles — the lock is reclaimed after a kill.
 */
function cmdTitles(args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  const fs = require('fs') as typeof import('fs');
  if (args.includes('--refresh')) {
    const quiet = args.includes('--if-due');
    const deadline = setTimeout(() => process.exit(1), core.remoteTitlesDeadlineMs());
    deadline.unref();
    void core.refreshRemoteTitles({ force: !quiet }).then((ran) => {
      clearTimeout(deadline);
      if (quiet) return;
      if (!ran) process.stdout.write(core.remoteTitlesEnabled() ? 'another refresh is running\n' : 'off (oak titles --on resumes)\n');
      else process.stdout.write(core.diagnoseRemoteTitles().detail + '\n');
    });
    return;
  }
  if (args.includes('--off') || args.includes('--on')) {
    const prefs = core.readPrefs();
    if (args.includes('--off')) {
      prefs.remoteTitles = false;
      fs.rmSync(core.remoteTitlesCachePath(), { force: true }); // no cached claude.ai title outlives the switch
    } else delete prefs.remoteTitles;
    core.writePrefs(prefs);
    process.stdout.write(prefs.remoteTitles === false
      ? 'Remote Control titles off: OAK no longer reads session titles from claude.ai, and names sessions from their transcripts.\n'
      : 'Remote Control titles on: the next poll reads session titles from claude.ai.\n');
    return;
  }
  const cache = core.readRemoteTitles();
  const check = core.diagnoseRemoteTitles();
  if (args.includes('--json')) {
    emitJson({
      enabled: core.remoteTitlesEnabled(),
      status: cache.attemptedAt ? cache.status ?? 'error' : 'never',
      fetchedAt: cache.fetchedAt,
      attemptedAt: cache.attemptedAt,
      titles: Object.keys(cache.titles).length,
      ...(cache.error ? { error: cache.error } : {}),
      cache: core.remoteTitlesCachePath(),
    });
    return;
  }
  process.stdout.write(`${check.label}: ${check.detail}\n` + (check.fix ? `  → ${check.fix}\n` : ''));
}

/**
 * `__tab-sync <session>` — internal, hidden: the capture hooks and the Claude Code status line start it
 * detached (core `kickTabSync`) when a session's title may have changed, and the terminal app on another
 * machine runs it here with `--machine`, so this machine's record is the only one of its tabs' names. It
 * names the herdr tab that holds the session's pane after the session's listed title (core
 * `syncSessionTab`) and touches nothing else. `--claimed=<label>`: the name that app recorded giving the
 * tab before this machine named its own, which this machine's record takes on while the tab wears it.
 * Prints nothing, and exits by its deadline whatever herdr does. A session with no herdr pane link here
 * (its hooks never ran in a herdr pane on this machine: not installed, or the session began before they
 * were) asks herdr nothing and prints `unlinked`: the terminal app that asked names that tab itself.
 */
function cmdTabSync(args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  const session = args[0];
  if (!session || !core.isSafeSessionId(session)) return;
  if (!core.readHerdrPaneLink(session)) { process.stdout.write('unlinked\n'); return; }
  const deadline = setTimeout(() => process.exit(0), 15000);
  deadline.unref();
  void core.syncSessionTab({ session, claimed: flagValue(args, '--claimed'), transport: core, herdrOptions: { timeoutMs: 4000 } })
    .catch(() => { /* the tab keeps its name until the next sync */ })
    .finally(() => clearTimeout(deadline));
}

function cmdSessions(args: string[] = []): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  // Remove a session from every picker (and purge its stored edits). The agent's own transcript/rollout
  // is left alone — hiding is what keeps it gone. `--undelete` puts it back in the pickers, but the
  // purged edits are gone for good, so edits still pending review are purged only with --force, or with
  // --force-pending <n> up to the n an editor's delete dialog named (more pending than that is refused).
  // --seen-through <edit> is the newest edit id of the listing that dialog counted from (its row's
  // `lastEdit`): a pending edit newer than that is refused too, even one that joined a counted change.
  const del = flagValue(args, '--delete');
  if (del) {
    if (!core.isSafeSessionId(del)) fail(`--delete: invalid session id "${del}"`);
    const named = flagValue(args, '--force-pending');
    if (named !== undefined && !/^\d+$/.test(named)) fail(`--force-pending: expected the number of pending edits the confirmation named, got "${named}"`);
    const seen = flagValue(args, '--seen-through');
    if ((seen !== undefined || args.includes('--seen-through')) && !/^\d+$/.test(seen ?? ''))
      fail(`--seen-through: expected the newest edit id of the listing the confirmation counted from, got "${seen ?? ''}"`);
    const forced = args.includes('--force');
    const pending = forced || named !== undefined ? 0 : core.sessionCounts(del).pending;
    if (pending > 0)
      fail(`${del} has ${pending} edit${pending === 1 ? '' : 's'} pending review; deleting the session purges ${pending === 1 ? 'that edit' : 'those edits'} for good. Review ${pending === 1 ? 'it' : 'them'} first, or pass --force.`);
    try { core.deleteSession(del, { confirmedPending: forced ? Infinity : Number(named ?? 0), seenThrough: seen === undefined ? undefined : Number(seen) }); }
    catch (e) { fail(String((e as Error)?.message || e)); }
    if (args.includes('--json')) emitJson({ deleted: del });
    else process.stdout.write(`removed session ${del} from Observatory and purged its captured edits (its transcript is untouched; \`oak sessions --undelete ${del}\` puts it back in the pickers, without those edits)\n`);
    return;
  }
  const undel = flagValue(args, '--undelete');
  if (undel) {
    if (!core.isSafeSessionId(undel)) fail(`--undelete: invalid session id "${undel}"`);
    if (!core.hiddenSessions().has(undel)) fail(`${undel} was not deleted`);
    core.unhideSession(undel);
    if (core.hiddenSessions().has(undel)) fail(`could not restore ${undel}`);
    if (args.includes('--json')) emitJson({ undeleted: undel });
    else process.stdout.write(`restored ${undel}\n`);
    return;
  }
  // EVERY workspace's sessions by conversation recency, titled from a bounded sidecar-cached scan —
  // no per-session log parse, no pending counts (recency + name is what the switch decision needs).
  // --session pins the listing to the session being reviewed, so a pinned conversation with no edits
  // yet still appears in it rather than looking like another workspace's.
  // `--root` for the same reason every other view honours it: the picker's TITLES come from
  // transcripts, which live under the mangled launch cwd — so listed from outside the workspace the
  // rows fell back to bare session ids, which is what "the selector shows the id instead of the name"
  // was. The workspace is the session's, not the terminal's.
  const cwd = flagValue(args, '--root') ?? process.cwd();
  const reviewing = args.includes('--session') ? getSessionId(args) : null;
  const meta = core.sessionMeta(cwd, reviewing);
  if (args.includes('--json')) {
    emitJson(meta);
    return;
  }
  if (meta.sessions.length === 0) {
    process.stdout.write(c.dim('no sessions on this machine yet.\n'));
    return;
  }
  let workspace: string | undefined;
  for (const s of meta.sessions) {
    if (workspace !== s.workspace) {
      workspace = s.workspace;
      const count = meta.sessions.filter((r) => r.workspace === workspace).length;
      process.stdout.write(`\n${c.bold(workspace || 'Unknown workspace')} · ${count} session${count === 1 ? '' : 's'}\n`);
    }
    const mark = s.current ? c.green('● ') : '  ';
    const agent = s.agent !== 'claude' ? `[${s.agent}] ` : '';
    const stats = `${s.edits} edit${s.edits === 1 ? '' : 's'} · ${core.compactTokens(s.tokens)} tok · ${core.compactDuration(s.durationMs)} · ${s.model || 'model unknown'}`;
    process.stdout.write(`${mark}${agent}${c.bold(s.title || s.id)}  ${c.dim(s.id)}  ${c.dim(stats + ' · ' + core.relTime(s.lastActiveMs))}\n`);
  }
  process.stdout.write(c.dim('\n● = resolves for this workspace · sessions on this machine, grouped by workspace\nuse `--session <id>` to target another\n'));

}

// --- review commands ---

function relFile(file: string): string {
  const path = require('path');
  const r = path.relative(process.cwd(), file);
  return r && !r.startsWith('..') ? r : file;
}

/** #43: an `--under` operand can arrive with a lower-cased Windows drive letter (shells) or forward
 *  slashes (JetBrains passes VirtualFile paths) — resolve to the OS-native absolute form and
 *  canonicalize the drive case so it matches canonical record paths. Callers validate emptiness
 *  FIRST: `path.resolve('')` is the cwd, which would silently widen an invalid scope to everything. */
function canonUnder(under: string): string {
  const path = require('path');
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  return core.canonPath(path.resolve(under));
}

/** `--ids … --units`: each id names a review UNIT (one row on a surface), so it widens to every record
 *  of that unit. A surface with core in-process applies this rule before `--ids`; this is the same rule
 *  run where the store is, for a caller that holds only the ids (the Review tab on another machine). */
function expandUnits(core: Core, session: string, ids: number[], args: string[]): number[] {
  return args.includes('--units') ? [...new Set(ids.flatMap((id) => core.groupMembers(session, id)))] : ids;
}

function statusLabel(s: string): string {
  if (s === 'pending') return c.yellow('pending');
  if (s === 'kept') return c.green('kept');
  return c.dim('reverted');
}

/** A prompt's patches can be large; a whole ask's worth crossing a pipe into a Swing panel is not the
 *  same budget as a whole-session `export`, which bounds itself at 64 MB (core `trace.ts`). */
const REVIEW_PATCH_BUDGET = 8 * 1024 * 1024;

/**
 * `review [--prompt <id>]` — the session's work as review units with their patches; `--prompt`
 * scopes to one ask. The session-wide answer is the Review tab's DEFAULT view (nothing selected
 * loses nothing), and prompt selection filters it.
 *
 * The surface every Review tab renders, and the reason it is a CLI command rather than three
 * client-side compositions: JetBrains never links core, so without this it would have to spawn
 * `prompts --id` plus one `diff` per unit on every repaint. It is also what finally gives that plugin
 * the collapse at all — it reads raw records off disk today, so its review cursor steps through every
 * member of a unit individually where the other two surfaces show one row.
 *
 * Deliberately NOT in the `views` batch: `views` hands one argument list to every view it runs, so a
 * `--prompt` would retarget the others, and the backend's dedupe key is the whole argument list — so
 * batching it would respawn every view on each prompt selection, which is the opposite of the saving.
 */
function cmdReview(args: string[]): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  // `--root` scopes this to the SESSION's workspace, not the terminal's — same rule every
  // transcript-derived view follows, and the reason a dashboard opened outside the workspace used to
  // render empty with no error.
  const viewRoot = flagValue(args, '--root') ?? process.cwd();
  const session = getSessionId(args);
  const json = args.includes('--json');
  if (noTranscript(session, json, flagValue(args, '--root') ?? undefined)) return;

  // Without --prompt the answer is the WHOLE session's units — the Review tab's default view; a
  // prompt id or index scopes it to one ask.
  const want = flagValue(args, '--prompt');
  const reqs = core.sessionPrompts(viewRoot, session);
  const r = want ? (reqs.find((x) => x.id === want || String(x.index) === want) ?? null) : null;
  if (want && !r) fail(`no prompt "${want}" in session ${session} (1..${reqs.length}).`);

  const byId = new Map(core.reviewEdits(session).map((rec) => [rec.id, rec]));
  const unitIds = r ? r.editIds : [...byId.keys()];
  const errors: string[] = [];
  let spent = 0;
  let omittedFrom: number | null = null;
  const noPatch = args.includes('--no-patch');
  // The Review tabs' filter: still-undecided units only. Applied AFTER the missing-record check, so
  // a bad id is still an error, never silently absent.
  const pendingOnly = args.includes('--pending');

  const units = unitIds.map((id) => {
    const rec = byId.get(id);
    if (!rec) {
      // A display id with no record behind it is a bug somewhere upstream, not an empty unit — say so
      // rather than emitting a hole the renderer would draw as "no changes".
      errors.push(`unit #${id} is named by this prompt but has no record in the log`);
      return null;
    }
    if (pendingOnly && rec.status !== 'pending') return null;
    const d = core.lineDelta(session, rec);
    const members = core.groupMembers(session, id);
    let patch: string | undefined;
    if (!noPatch) {
      const p = core.coloredDiff(session, rec, false);
      // ONE cut ends the attachments: the error says "from unit #N onward", and quietly attaching
      // later, smaller patches made that a lie — a reader scrolling past the cut saw patches again
      // and could not tell which absences were the budget and which were empty diffs.
      if (omittedFrom !== null || spent + p.length > REVIEW_PATCH_BUDGET) {
        if (omittedFrom === null) omittedFrom = id;
      } else {
        spent += p.length;
        patch = p;
      }
    }
    return {
      id,
      members,
      file: rec.file,
      rel: core.relPath(viewRoot, rec.file),
      tool: rec.tool,
      status: rec.status,
      ts: rec.ts,
      added: d.added,
      removed: d.removed,

      // caught this projection dropping them — the raw log had the fields, `list --json` did not).
      // `partial` is the one renderers act on: a review-only record must be marked BEFORE the
      // reader tries to undo it, not explained after.
      ...(rec.source ? { source: rec.source } : {}),
      ...(rec.acpSessionId ? { acpSessionId: rec.acpSessionId } : {}),
      ...(rec.promptId ? { promptId: rec.promptId } : {}),
      ...((rec.partial || core.uncertainCreation(rec)) ? { partial: true } : {}),
      capture: core.captureSummary(rec),
      runtime: rec.runtime, model: rec.model, provenance: rec.provenance, attribution: rec.attribution, toolCallId: rec.toolCallId, nativeTurnId: rec.nativeTurnId,
      ...(patch === undefined ? {} : { patch }),
    };
  });
  const all = units.filter(Boolean) as NonNullable<(typeof units)[number]>[];
  // Chains that CANCEL OUT leave the row list: a file created then deleted (or an edit put back)
  // ends on the content it started from, so there is nothing to decide. They are NOT dropped — they
  // ride their own array, and every surface accounts for them in one footer with a Dismiss.
  const cancelledMap = core.cancelledGroups(session);
  // Every cancelled member at ANY status. `cancelledMap` answers the pending question — what Dismiss
  // acts on — and a chain that was already dismissed is still nothing to look at, so renderers hide
  // this whole set. Without it, one Dismiss turned the footer into thousands of greyed rows.
  const hidden = core.cancelledMemberIds(session);
  const cancelled = all.filter((u) => cancelledMap.has(u.id));
  const rows = all.filter((u) => !cancelledMap.has(u.id) && !hidden.has(u.id));
  const cancelledIds = [...new Set(cancelled.flatMap((u) => u.members))].sort((a, b) => a - b);
  const hiddenIds = [...hidden].sort((a, b) => a - b);
  if (omittedFrom !== null) {
    errors.push(`patches from unit #${omittedFrom} onward exceed the ${Math.round(REVIEW_PATCH_BUDGET / 1024 / 1024)} MB budget — fetch them with \`diff <id> --patch\``);
  }

  // RAW ids, group-expanded: this is what `keep --ids` / `undo --ids` must act on. The rows above are
  // display units, and acting on those alone strands their earlier members pending. Cancelled chains
  // are INCLUDED here — "keep all in this scope" means all of it — while `cancelledIds` lets a
  // surface dismiss only the ones that were never a decision.
  const ids = [...new Set([...rows, ...cancelled].flatMap((u) => u.members))].sort((a, b) => a - b);

  if (json) {
    emitJson({
      session,
      prompt: r ? { id: r.id, index: r.index, ts: r.ts, endTs: r.endTs, title: r.title, text: r.text } : null,
      units: rows,
      cancelled,
      cancelledIds,
      // What a tree/list renderer must not draw, at any status — a superset of `cancelledIds`.
      hiddenIds,
      ids,
      summary: {
        units: rows.length,
        pending: rows.filter((u) => u.status === 'pending').length,
        cancelled: cancelled.length,
        added: rows.reduce((a, u) => a + u.added, 0),
        removed: rows.reduce((a, u) => a + u.removed, 0),
      },
      patchesOmittedFrom: omittedFrom,
      errors,
    });
    return;
  }

  if (r) {
    process.stdout.write(c.bold(`#${r.index}`) + c.dim(`  ${core.relTime(r.ts)} · ${rows.length} review unit(s)\n\n`));
    process.stdout.write(`${r.text}\n\n`);
  } else {
    process.stdout.write(c.bold(session) + c.dim(`  whole session · ${rows.length} review unit(s)\n\n`));
  }
  if (!rows.length && !cancelled.length) {
    process.stdout.write(c.dim(r ? 'this ask changed no files.\n' : 'no captured edits in this session.\n'));
    return;
  }
  for (const u of rows) {
    const mem = u.members.length > 1 ? c.dim(` (${u.members.length} edits)`) : '';
    process.stdout.write(c.bold(`#${u.id} `) + `${u.rel}` + c.dim(` +${u.added}/−${u.removed}`) + mem + '\n');
    if (u.patch) process.stdout.write(core.coloredDiff(session, byId.get(u.id) as EditRecord, isTTY()) + '\n');
  }
  // The footer: named, never a silent omission, and it carries the exact command that clears them.
  if (cancelled.length) {
    process.stdout.write(
      c.dim(`\n${cancelled.length} cancelled-out chain(s) — created then deleted, or put back: nothing to review\n`) +
        // `--session` spelled out: ids are per-session counters, so a pasted command without it
        // would keep whatever ids 3,4,5 happen to be in whichever session the cwd resolves to.
        c.dim(`  dismiss with: keep --ids ${cancelledIds.join(',')} --session ${session}\n`)
    );
  }
  for (const e of errors) process.stderr.write(c.dim(`${e}\n`));
}

function cmdList(args: string[]): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const session = getSessionId(args);
  let log = core.reviewEdits(session); // collapse same-code pending edits into one review unit (like the tree)

  // Filters: --pending | --kept | --undone, and --file <substring>
  const only = args.includes('--pending')
    ? 'pending'
    : args.includes('--kept')
      ? 'kept'
      : args.includes('--undone')
        ? 'undone'
        : null;
  if (only) log = log.filter((r) => r.status === only);
  const fi = args.indexOf('--file');
  const subRaw = flagValue(args, '--file');
  if (fi >= 0 && !subRaw) fail('`list --file <substr>` requires a value');
  const sub = subRaw && core.canonPath(subRaw); // #43: match canonical record paths
  if (sub) log = log.filter((r) => r.file.includes(sub));

  if (args.includes('--json')) {
    // `cancelled` marks the units that go nowhere (created then deleted, or put back). Renderers
    // keep them out of the row list and account for them in one footer — the flag rides per row so
    // no renderer has to re-derive the grouping.
    const cancelledMap = core.cancelledGroups(session);
    // `cancelled` marks what to HIDE (any status); `members` rides only the pending ones, because
    // those are the chains a Dismiss can still act on.
    const hidden = core.cancelledMemberIds(session);
    emitJson({
      session,
      edits: log.map((r) => {
        const d = core.lineDelta(session, r);
        // `rel` is the workspace-relative path. Without it every renderer has to guess how to
        // shorten an absolute path, and the terminal's guess kept only the last two segments — so
        // packages/core/src/x.ts and packages/cli/src/x.ts both read as src/x.ts. Two different
        // files, indistinguishable, in a tool for deciding whether to revert one of them.
        const members = cancelledMap.get(r.id);
        return {
          id: r.id, ts: r.ts, tool: r.tool, file: r.file, rel: core.relPath(process.cwd(), r.file),
          status: r.status, added: d.added, removed: d.removed,
          ...(members ? { cancelled: true, members } : hidden.has(r.id) ? { cancelled: true } : {}),
        };
      }),
    });
    return;
  }

  if (log.length === 0) {
    process.stdout.write(c.dim(`no matching edits (session ${session}).\n`));
    return;
  }
  // Chains that cancel out are not rows here either — the same rule the JSON payload, the terminal
  // and both editors follow. Counted in a footer below rather than dropped in silence.
  const listHidden = core.cancelledMemberIds(session);
  const shown = log.filter((r) => !listHidden.has(r.id));
  const hiddenCount = log.length - shown.length;
  // group by file, preserve first-seen order
  const byFile = new Map<string, EditRecord[]>();
  for (const r of shown) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file)!.push(r);
  }
  const pending = shown.filter((r) => r.status === 'pending').length;
  process.stdout.write(
    c.bold(`${shown.length} edit(s)`) +
      c.dim(`  ·  ${pending} pending${only ? ` · ${only} only` : ''}  ·  session ${session}\n\n`)
  );
  for (const [file, recs] of byFile) {
    process.stdout.write(c.cyan(relFile(file)) + '\n');
    for (const r of recs) {
      const { added, removed } = core.lineDelta(session, r);
      const delta = c.green(`+${added}`) + ' ' + c.red(`-${removed}`);
      process.stdout.write(
        `  ${c.bold('#' + r.id)}  ${statusLabel(r.status).padEnd(7)}  ${delta}  ${c.dim(
          r.tool
        )}  ${c.dim(core.relTime(r.ts))}\n`
      );
    }
    process.stdout.write('\n');
  }
  if (hiddenCount) {
    process.stdout.write(
      c.dim(`${hiddenCount} row(s) not listed — cancelled-out chains (created then deleted, or put back): nothing to review\n`)
    );
  }
  process.stdout.write(c.dim('diff <id> · keep <id> · undo <id>\n'));
}

/** `timeline` — a newest-first chronological feed of edits (time · id · status · Δ · file), the
 *  terminal counterpart to the editors' Timeline. `list` groups by file; this is time-ordered. */
function cmdTimeline(args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  const session = getSessionId(args);
  const log = core.readLog(session);
  // This feed is deliberately RAW — every record, in the order it happened, because a phantom record
  // is still something that happened and an audit that hides it is worse than one that explains it.
  // But it must not CONTRADICT the review surfaces: the rows are marked and the pending count agrees
  // with `list`, instead of reporting five pending for a session whose review list offers one.
  const hidden = core.cancelledMemberIds(session);
  if (args.includes('--json')) {
    emitJson({
      session,
      edits: [...log]
        .reverse()
        .map((r) => {
          const d = core.lineDelta(session, r);
          // `rel` is the workspace-relative path. Without it every renderer has to guess how to
        // shorten an absolute path, and the terminal's guess kept only the last two segments — so
        // packages/core/src/x.ts and packages/cli/src/x.ts both read as src/x.ts. Two different
        // files, indistinguishable, in a tool for deciding whether to revert one of them.
        return { id: r.id, ts: r.ts, tool: r.tool, file: r.file, rel: core.relPath(process.cwd(), r.file), status: r.status, added: d.added, removed: d.removed, ...(hidden.has(r.id) ? { cancelled: true } : {}) };
        }),
    });
    return;
  }
  if (log.length === 0) {
    process.stdout.write(c.dim(`no edits (session ${session}).\n`));
    return;
  }
  const pending = log.filter((r) => r.status === 'pending' && !hidden.has(r.id)).length;
  const inChains = log.filter((r) => hidden.has(r.id)).length;
  process.stdout.write(
    c.bold('Timeline') +
      c.dim(
        `  ${log.length} edit(s) · ${pending} pending${inChains ? ` · ${inChains} in cancelled-out chains` : ''}` +
          ` · newest first · session ${session}\n\n`
      )
  );
  for (const r of [...log].reverse()) {
    const { added, removed } = core.lineDelta(session, r);
    const delta = c.green(`+${added}`) + ' ' + c.red(`-${removed}`);
    process.stdout.write(
      `${c.dim(core.relTime(r.ts).padEnd(12))} ${c.bold('#' + r.id)}  ${statusLabel(r.status).padEnd(7)} ${delta}  ${c.cyan(relFile(r.file))} ${c.dim(r.tool)}${hidden.has(r.id) ? c.dim(' · cancelled-out chain') : ''}\n`
    );
  }
}

/** The full, typed action timeline (every tool call Claude made) — zero-token, mined from the transcript. */
function cmdActions(args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  const session = getSessionId(args);
  const actions = core.parseActions(process.cwd(), session);
  if (args.includes('--json')) {
    // Emit the flat actions AND the category-grouped view-model (curated unless --all) — the editors
    // render `groups` directly so the curated/ordering logic lives only in core.
    const showAll = args.includes('--all');
    const subagents = core.parseSubagents(process.cwd(), session);
    const fleet = core.listSiblings(process.cwd(), session);
    emitJson({
      session,
      summary: core.summarizeActions(actions),
      actions,
      groups: core.buildActionGroups(actions, { showAll }),
      egress: core.buildEgressReport(actions),
      subagents,
      subagentsSummary: core.summarizeSubagents(subagents),
      fleet,
      fleetSummary: core.summarizeFleet(fleet),
    });
    return;
  }
  if (actions.length === 0) {
    process.stdout.write(c.dim(`no actions (no transcript found for session ${session}).\n`));
    return;
  }
  const sum = core.summarizeActions(actions);
  const cats = Object.entries(sum.byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`)
    .join(' · ');
  process.stdout.write(
    c.bold('Actions') +
      c.dim(`  ${sum.total} total · ${cats}${sum.errors ? ` · ${sum.errors} error(s)` : ''} · session ${session}\n\n`)
  );
  const ci = args.indexOf('--category');
  const catFilter = ci >= 0 ? args[ci + 1] : '';
  const li = args.indexOf('--limit');
  const limit = li >= 0 && args[li + 1] ? parseInt(args[li + 1], 10) : 0;
  let rows = actions;
  if (catFilter) rows = rows.filter((a) => a.category === catFilter);
  if (args.includes('--errors')) rows = rows.filter((a) => a.isError);
  if (limit > 0) rows = rows.slice(-limit);
  for (const a of rows) {
    const when = c.dim(core.relTime(a.ts).padEnd(11));
    const mark = a.isError ? c.red('✗') : ' ';
    const tag = c.cyan(`[${a.category}]`.padEnd(9));
    const link = a.editId != null ? c.dim(` edit#${a.editId}`) : '';
    const detail = a.detail ? c.dim(`  (${a.detail})`) : '';
    process.stdout.write(`${when} ${mark} ${tag} ${c.bold(a.tool.padEnd(10))} ${(a.target || '').slice(0, 80)}${link}${detail}\n`);
  }
}

/** Command risk: the shell commands Claude ran that can destroy data / escalate / touch secrets. */
function cmdRisk(args: string[]): void {
  // `--root` scopes this to the SESSION's workspace, not the terminal's. Every view here is
  // transcript-derived, and a transcript is found under the mangled launch cwd — so a dashboard
  // opened outside the workspace, or pointed at another workspace's session, read no transcript
  // and rendered empty with no error. `changemap`, `multitask` and `observations` already did
  // this; these did not, and the split is what made the failure look like data rather than a bug.
  const viewRoot = flagValue(args, '--root') ?? process.cwd();
  const core = require('@oak-observatory/core') as Core;
  const session = getSessionId(args);
  const rri = args.indexOf('--root'); // the workspace boundary for "outside", like changemap/footprint
  const root = rri >= 0 && args[rri + 1] ? args[rri + 1] : viewRoot;
  if (noTranscript(session, args.includes('--json'), flagValue(args, '--root') ?? undefined)) return;
  const risky = core
    .parseActions(viewRoot, session)
    .filter((a) => a.risk)
    .map((a) => ({ ts: a.ts, tool: a.tool, target: a.target, level: a.risk!.level, reasons: a.risk!.reasons }));
  const high = risky.filter((r) => r.level === 'high').length;
  if (args.includes('--json')) {
    // The folded footprint's damaging half: edits that landed outside the workspace boundary.
    emitJson({ session, count: risky.length, high, risky, outsideWrites: core.outsideWrites(core.parseActions(viewRoot, session), root) });
    return;
  }
  if (risky.length === 0 && !core.outsideWrites(core.parseActions(viewRoot, session), root).length) {
    process.stdout.write(c.dim(`no risky commands flagged (session ${session}).\n`));
    return;
  }
  process.stdout.write(c.bold('Risk') + c.dim(`  ${risky.length} flagged · ${high} high · session ${session}\n\n`));
  for (const r of risky) {
    const badge = r.level === 'high' ? c.red('● HIGH') : c.yellow('● MED ');
    process.stdout.write(`${badge}  ${(r.target || '').slice(0, 74)}\n       ${c.dim(r.reasons.join(' · '))}\n`);
  }

  // Writes that left the workspace. Risk otherwise only inspects commands, but "it edited files outside
  // the directory you pointed it at" is the same class of fact, and the edits ledger cannot say it —
  // every path there is shown workspace-relative. Stated as an observation, not scored as a danger.
  const outside = core.outsideWrites(core.parseActions(viewRoot, session), root);
  if (outside.length) {
    const total = outside.reduce((n, w) => n + w.count, 0);
    process.stdout.write('\n' + c.bold('Outside the workspace') + c.dim(`  ${total} edit(s) across ${outside.length} file(s)\n`));
    for (const w of outside.slice(0, args.includes('--all') ? 200 : 8)) {
      process.stdout.write(`  ${c.yellow('↗')} ${w.file}${w.count > 1 ? c.dim(` ×${w.count}`) : ''}\n`);
    }
    const hidden = outside.length - Math.min(outside.length, args.includes('--all') ? 200 : 8);
    if (hidden) process.stdout.write(c.dim(`     … ${hidden} more (--all)\n`));
  }
}

/** Egress: what this session touched off-machine — web / MCP / network-shell destinations. */
function cmdEgress(args: string[]): void {
  // `--root` scopes this to the SESSION's workspace, not the terminal's. Every view here is
  // transcript-derived, and a transcript is found under the mangled launch cwd — so a dashboard
  // opened outside the workspace, or pointed at another workspace's session, read no transcript
  // and rendered empty with no error. `changemap`, `multitask` and `observations` already did
  // this; these did not, and the split is what made the failure look like data rather than a bug.
  const viewRoot = flagValue(args, '--root') ?? process.cwd();
  const core = require('@oak-observatory/core') as Core;
  const session = getSessionId(args);
  if (noTranscript(session, args.includes('--json'), flagValue(args, '--root') ?? undefined)) return;
  const eri = args.indexOf('--root'); // the workspace boundary for the `file` channels below
  const eroot = eri >= 0 && args[eri + 1] ? args[eri + 1] : viewRoot;
  const acts = core.parseActions(viewRoot, session);
  // Reads that left the workspace are reach, exactly like a fetch — the same question this audit
  // already answers for the network, so they are channels of the same report rather than a second one.
  const channels = [...core.buildEgressReport(acts), ...core.outsideReads(acts, eroot)];
  const sum = core.summarizeEgress(channels);
  if (args.includes('--json')) {
    emitJson({ session, ...sum });
    return;
  }
  if (channels.length === 0) {
    process.stdout.write(c.dim(`no off-machine egress detected (session ${session}).\n`));
    return;
  }
  process.stdout.write(
    c.bold('Egress') + c.dim(`  ${channels.length} destination(s) · ${sum.remote} remote · session ${session}\n\n`)
  );
  for (const ch of channels) {
    // 'local' is a FACT (it stayed on this machine but left the workspace); 'unknown' is an admission
    // that we could not classify the destination. Printing the first as the second would be a lie.
    const scope = ch.scope === 'remote' ? c.red('remote ') : ch.scope === 'local' ? c.yellow('outside') : c.dim('unknown');
    process.stdout.write(`${scope}  ${c.cyan(ch.kind.padEnd(5))} ${ch.target}${ch.count > 1 ? c.dim(` ×${ch.count}`) : ''}\n`);
  }
}

/** Every audit verb reads the transcript. When there ISN'T one (another project's session, a bad id),
 *  an empty result means "we couldn't look", not "nothing happened" — and printing the second is a false
 *  statement of absence. Returns true when the caller should stop. */
function noTranscript(session: string, json: boolean, root?: string): boolean {
  const core = require('@oak-observatory/core') as Core;
  // `root`, not `process.cwd()`. This guard looked for the transcript under the TERMINAL's directory
  // while its caller had already been told, via `--root`, which workspace the session belongs to — so
  // every audit verb reported "no transcript" for a session whose transcript was sitting right where
  // the caller said it was. It short-circuits BEFORE the caller's own root is used, which is why
  // fixing the callers alone changed nothing.
  if (core.findTranscript(root ?? process.cwd(), session)) return false;
  if (json) emitJson({ session, transcript: null, error: 'no transcript found for this session under this directory' });
  else process.stdout.write(c.dim(`no transcript found for session ${session} under this directory — nothing to audit.\n`));
  return true;
}

/** `footprint`/`capabilities` — folded into `risk` and `egress` in 0.8.7. The two facts it alone
 *  reported now live where they belong: reads that left the workspace are egress (reach), writes that
 *  left it are risk (damage). One audit surface instead of two. */
function cmdFootprint(args: string[]): void {
  process.stderr.write(
    c.dim('`footprint` was folded into `risk` and `egress` in 0.8.7 — reads that left the workspace are\n' +
      'reported by `egress`, writes that left it by `risk`. Showing both.\n\n')
  );
  // `--json` has to stay ONE document. Running both verbs straight through emitted two concatenated
  // objects, so every caller's JSON.parse threw ("Unexpected non-whitespace character after JSON").
  if (args.includes('--json')) {
    const grab = (run: () => void): unknown => {
      const real = process.stdout.write.bind(process.stdout);
      let buf = '';
      (process.stdout as unknown as { write: (s: string) => boolean }).write = (chunk: string) => {
        buf += chunk;
        return true;
      };
      try {
        run();
      } finally {
        (process.stdout as unknown as { write: typeof real }).write = real;
      }
      try {
        return JSON.parse(buf);
      } catch {
        return null;
      }
    };
    emitJson({ risk: grab(() => cmdRisk(args)), egress: grab(() => cmdEgress(args)) });
    return;
  }
  cmdRisk(args);
  process.stdout.write('\n');
  cmdEgress(args);
}

/** `processes` — the background shells this session launched with `run_in_background` and left running,
 *  with the detail the harness's own Background panel omits: runtime, exit code, output volume. There is
 *  no OS pid here on purpose — the transcript never records one, and guessing it from local processes
 *  would be wrong whenever the agent runs on another machine (SSH / devcontainer / another worktree). */
function cmdProcesses(args: string[]): void {
  // `--root` scopes this to the SESSION's workspace, not the terminal's. Every view here is
  // transcript-derived, and a transcript is found under the mangled launch cwd — so a dashboard
  // opened outside the workspace, or pointed at another workspace's session, read no transcript
  // and rendered empty with no error. `changemap`, `multitask` and `observations` already did
  // this; these did not, and the split is what made the failure look like data rather than a bug.
  const viewRoot = flagValue(args, '--root') ?? process.cwd();
  const core = require('@oak-observatory/core') as Core;
  const session = getSessionId(args);
  if (noTranscript(session, args.includes('--json'), flagValue(args, '--root') ?? undefined)) return;
  const list = core.sessionProcesses(viewRoot, session);
  const sum = core.summarizeProcesses(list);
  // `--id <shell>` drills into ONE shell: the full command it is running, plus a tail of its output —
  // for a job that is still going, that tail is the only view of what it is actually doing.
  const want = flagValue(args, '--id');
  if (want) {
    const p = list.find((x) => x.id === want);
    if (!p) fail(`no background shell "${want}" in session ${session}.`);
    const tail = core.processOutputTail(p!.outputPath);
    if (args.includes('--json')) {
      emitJson({ session, process: p, outputTail: tail });
      return;
    }
    process.stdout.write(c.bold(p!.id) + c.dim(`  ${p!.running ? 'running' : p!.status}${p!.exitCode !== null ? ` (exit ${p!.exitCode})` : ''} · ${fmtDur(p!.runtimeMs)}\n\n`));
    if (p!.description) process.stdout.write(c.dim(`${p!.description}\n\n`));
    process.stdout.write(`${p!.command}\n`);
    if (p!.outputPath) process.stdout.write(c.dim(`\noutput → ${p!.outputPath}\n`));
    if (tail) process.stdout.write(c.dim('\n--- last output ---\n') + tail + '\n');
    return;
  }
  if (args.includes('--json')) {
    emitJson({ session, summary: sum, processes: list });
    return;
  }
  if (!list.length) {
    process.stdout.write(c.dim(`no background shells in session ${session}.\n`));
    return;
  }
  process.stdout.write(
    c.bold('Processes') + c.dim(`  ${sum.running} running · ${sum.total} total${sum.failed ? ` · ${sum.failed} failed` : ''} · session ${session}\n\n`)
  );
  for (const p of list) {
    const state = p.running
      ? c.green('running')
      : p.exitCode === null
        ? c.dim(p.status)
        : p.exitCode === 0
          ? c.dim('exit 0 ')
          : c.red(`exit ${p.exitCode}`);
    const out = p.outputBytes ? c.dim(` · ${human(p.outputBytes)}B out`) : '';
    process.stdout.write(`${state}  ${c.cyan(p.id.padEnd(11))} ${fmtDur(p.runtimeMs).padStart(7)}${out}\n`);
    process.stdout.write(c.dim(`             ${(p.description || p.command).replace(/\s+/g, ' ').slice(0, 84)}\n`));
  }
  process.stdout.write(c.dim('\nshell ids are the harness’s own — no OS pid is recorded in the transcript\n'));
}

/** `feed` — what ONE thing is doing right now: an agent, a workflow run, a task, a background shell, or
 *  the session itself. A bounded tail of the file that thing writes as it works, so the editors can poll
 *  it on their existing watcher tick without re-reading whole transcripts. */
function cmdFeed(args: string[]): void {
  // `--root` scopes this to the SESSION's workspace, not the terminal's. Every view here is
  // transcript-derived, and a transcript is found under the mangled launch cwd — so a dashboard
  // opened outside the workspace, or pointed at another workspace's session, read no transcript
  // and rendered empty with no error. `changemap`, `multitask` and `observations` already did
  // this; these did not, and the split is what made the failure look like data rather than a bug.
  const viewRoot = flagValue(args, '--root') ?? process.cwd();
  const core = require('@oak-observatory/core') as Core;
  const session = getSessionId(args);
  // `--feed-agent` is the Agent screen's channel for VIEWING a spawned subagent's own feed read-only.
  // Feed-specific like `--feed-limit`, deliberately NOT the generic `--kind`/`--id`: the Agent batch
  // also carries the `prompts` view, which reads `--id`, so a shared id would retarget IT (see the note
  // on VIEWS_FOR.claude). When present it pins this view to that subagent's transcript.
  const feedAgent = flagValue(args, '--feed-agent');
  const kind = (feedAgent ? 'agent' : flagValue(args, '--kind') || 'session') as 'session' | 'agent' | 'workflow' | 'task' | 'process';
  if (!['session', 'agent', 'workflow', 'task', 'process'].includes(kind)) fail(`--kind must be session|agent|workflow|task|process (got "${kind}").`);
  const id = feedAgent || flagValue(args, '--id') || '';
  if (kind !== 'session' && !id) fail(`--id <${kind} id> is required for --kind ${kind}.`);
  // `--feed-limit` outranks `--limit` and is the Agent screen's channel: that screen IS the feed, and a
  // 60-row window left ~1,300 entries unreachable on a long session.
  // A dedicated flag so raising the Agent screen's depth
  // never perturbs any other view that shares the batch's argv.
  const limitRaw = flagValue(args, '--feed-limit') ?? flagValue(args, '--limit');
  const limit = limitRaw ? Math.max(1, Number(limitRaw) || 0) : undefined;
  const res = core.liveFeed(viewRoot, session, { kind, id }, limit ? { limit } : {});
  if (args.includes('--json')) {
    // The session RECAP rides the feed payload (0.10.0): the terminal's Agent screen shows it
    // directly above its prompt, and this is the view that surface already polls. `recapOf` is the
    // product's single definition — the CLI, both editors and the dashboard cannot disagree — and
    // `recapSource` travels with it, because an unlabelled recap reads as a considered summary
    // when it may be the session's title or the last thing the agent said.
    let recap: Record<string, unknown> = {};
    if (kind === 'session') {
      try {
        recap = core.recapOf(session, core.transcriptInsights(viewRoot, session)) as unknown as Record<string, unknown>;
      } catch {
        /* no transcript yet — the surface renders its own empty state */
      }
    }
    emitJson({ ...res, ...recap });
    return;
  }
  const age = res.lastTs ? core.relTime(res.lastTs) : 'no activity yet';
  // Print core's own mode, not a re-derived running/idle: live-vs-audit IS the feature, and both editors
  // and the docs present it in exactly these words.
  const mode = res.mode === 'live' ? c.green('● live') : c.dim('▣ audit log');
  process.stdout.write(c.bold(res.title) + c.dim(`  `) + mode + c.dim(` · ${age} · ${kind}\n`));
  if (res.note) process.stdout.write(c.dim(`${res.note}\n`));
  process.stdout.write('\n');
  if (res.truncated) process.stdout.write(c.dim(`… ${res.truncated} earlier entr${res.truncated === 1 ? 'y' : 'ies'} not shown\n`));
  const { wrapVisible, stripSgr } = require('@oak-observatory/tui') as typeof import('@oak-observatory/tui');
  for (const e of res.entries) {
    if (e.kind === 'output') {
      process.stdout.write(`${e.label}\n`);
      continue;
    }
    // LOCAL time: this is the only wall clock the CLI prints, and UTC put it hours off the reader's
    // own clock (rolling past midnight mid-list). Both editors already format the same ts locally.
    const when = e.ts ? c.dim(new Date(e.ts).toTimeString().slice(0, 8) + ' ') : '';
    const mark = e.ok === false ? c.red('✗ ') : '  ';
    const words = e.kind === 'reasoning' ? e.reasoning : e.kind === 'prompt' ? e.promptText : undefined;
    const line = `${when}${mark}${c.cyan(e.label)}${e.target ? ' ' + e.target : ''}${words ? ' — ' + words : ''}${e.detail ? '  ' + c.dim('[' + e.detail + ']') : ''}`;
    for (const source of line.split('\n')) for (const part of wrapVisible(source, process.stdout.columns || 100))
      process.stdout.write((e.reasoningKind === 'thinking' ? c.dim(stripSgr(part)) : part) + '\n');
  }
  if (!res.entries.length) process.stdout.write(c.dim('nothing recorded yet\n'));
}

/** `conversation` — the transcript as renderer-ready session updates. JSON is the pane contract. */
function cmdConversation(args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  const session = getSessionId(args);
  const root = flagValue(args, '--root') ?? process.cwd();
  // Provenance only: diagnose a local sync copy without parsing or presenting its conversation.
  if (args.includes('--source-info')) {
    // The raw lookup: session listing and resolution skip sync mirrors, but provenance must find one to report it.
    const transcript = core.findTranscript(root, session) ?? core.transcriptForSession(session) ?? core.describeSession(session).transcript;
    return emitJson(transcript ? { ...core.isMirroredTranscript(transcript), syncedAt: require('fs').statSync(transcript).mtimeMs } : { mirrored: false });
  }
  const numberFlag = (name: string, minimum: number): number | undefined => {
    const raw = flagValue(args, name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum) fail(`\`${name} ${raw}\` must be an integer ≥ ${minimum}`);
    return value;
  };
  const limit = numberFlag('--limit', 1);
  const since = numberFlag('--since', 0);
  const result = core.conversationEvents(session, { root, ...(limit !== undefined ? { limit } : {}), ...(since !== undefined ? { since } : {}),
    ...(args.includes('--with-source') ? { includeSource: true } : {}), ...(flagValue(args, '--source') ? { source: flagValue(args, '--source')! } : {}) });
  if (args.includes('--json')) return emitJson(result);
  for (const event of result.events) {
    const update = event.update as Record<string, unknown>;
    const kind = String(update.sessionUpdate ?? '');
    const content = update.content as { text?: unknown } | undefined;
    if (kind === 'user_prompt') process.stdout.write(`> ${String(content?.text ?? '')}\n`);
    else if (kind === 'agent_message_chunk') process.stdout.write(`${String(content?.text ?? '')}\n`);
    else if (kind === 'agent_thought_chunk') process.stdout.write(c.dim(`thinking: ${String(content?.text ?? '')}\n`));
    else if (kind === 'tool_call') process.stdout.write(c.dim(`[tool] ${String(update.title ?? update.kind ?? 'call')}\n`));
    else if (kind === 'plan') process.stdout.write(c.dim(`[plan] ${((update.entries as { content?: string }[]) ?? []).map((e) => e.content ?? '').filter(Boolean).join(' · ')}\n`));
    else if (kind === 'turn_end') process.stdout.write(c.dim(`— turn ended (${String(update.stopReason ?? '?')}) · ${Number(update.edits ?? 0)} edit(s) captured\n`));
  }
}

/** `prompts` — the session broken into what the USER asked for, in order, each carrying what it
 *  produced. Every other view organizes work the way the agent saw it (rollups by task, file or
 *  agent); this is the only one that answers "what happened when I asked for X". */
function cmdPrompts(args: string[]): void {
  // `--root` scopes this to the SESSION's workspace, not the terminal's. Every view here is
  // transcript-derived, and a transcript is found under the mangled launch cwd — so a dashboard
  // opened outside the workspace, or pointed at another workspace's session, read no transcript
  // and rendered empty with no error. `changemap`, `multitask` and `observations` already did
  // this; these did not, and the split is what made the failure look like data rather than a bug.
  const viewRoot = flagValue(args, '--root') ?? process.cwd();
  const core = require('@oak-observatory/core') as Core;
  const session = getSessionId(args);
  if (noTranscript(session, args.includes('--json'), flagValue(args, '--root') ?? undefined)) return;
  const reqs = core.sessionPrompts(viewRoot, session);
  const want = flagValue(args, '--id');
  if (want) {
    const r = reqs.find((x) => x.id === want || String(x.index) === want);
    if (!r) fail(`no prompt "${want}" in session ${session} (1..${reqs.length}).`);
    // `--response`: Claude's own prose in reply to this ask (its tool calls stripped) — the log a
    // reviewer expands to read. Fetched lazily because it can be large.
    if (args.includes('--response')) {
      const resp = core.promptResponse(viewRoot, session, r!.id);
      if (args.includes('--json')) {
        emitJson({ session, response: resp });
        return;
      }
      if (!resp || !resp.text) {
        process.stdout.write(c.dim(`no assistant response recorded for prompt #${r!.index}.\n`));
        return;
      }
      process.stdout.write(c.bold(`#${r!.index}`) + c.dim(`  Claude’s response · ${resp.turns} turn(s)\n\n`));
      process.stdout.write(`${resp.text}\n`);
      if (resp.truncated) process.stdout.write(c.dim(`\n… ${fmtBytes(resp.truncated)} more not shown (--json for the capped text)\n`));
      return;
    }
    if (args.includes('--json')) {
      emitJson({ session, prompt: r });
      return;
    }
    process.stdout.write(c.bold(`#${r!.index}`) + c.dim(`  ${core.relTime(r!.ts)} · ${fmtDur(r!.durationMs)}\n\n`));
    process.stdout.write(`${r!.text}\n\n`);
    const bits: string[] = [];
    if (r!.edits) bits.push(`${r!.edits} edit(s) (+${r!.added}/−${r!.removed}) · ${r!.pending} pending · ${r!.kept} accepted · ${r!.undone} reverted`);
    if (r!.files) bits.push(`${r!.files} file(s) · ${r!.folders} folder(s)`);
    if (r!.tokens) bits.push(`${fmtTok(r!.tokens)} tokens`);
    if (r!.actions) bits.push(`${r!.actions} tool call(s)${r!.errors ? ` · ${r!.errors} failed` : ''}`);
    if (r!.tasks) bits.push(`${r!.tasks} task(s) worked`);
    if (r!.agents.length) bits.push(`${r!.agents.length} subagent(s)`);
    if (r!.workflows.length) bits.push(`${r!.workflows.length} workflow run(s)`);
    if (r!.processes.length) bits.push(`${r!.processes.length} background shell(s)`);
    if (r!.compactions) bits.push(`${r!.compactions} compaction(s)`);
    for (const b of bits) process.stdout.write(c.dim(`  ${b}\n`));
    if (r!.editIds.length) process.stdout.write(c.dim(`\n  edits: ${r!.editIds.slice(0, 40).join(', ')}${r!.editIds.length > 40 ? ` … ${r!.editIds.length - 40} more (--json)` : ''}\n`));
    return;
  }
  if (args.includes('--json')) {
    // `assignErrors` (additive): an override naming a prompt id this session does not have — the
    // edit falls back to its temporal window rather than vanishing, and the mismatch is SAID here.
    const known = new Set(reqs.map((p) => p.id));
    const assignErrors = [...core.readScopeOverrides(session).entries()]
      .filter(([, p]) => !known.has(p))
      .map(([id, p]) => `edit #${id} assigned to unknown prompt "${p}" — override ignored`);
    emitJson({
      session,
      summary: core.summarizePrompts(reqs),
      prompts: reqs,
      ...(assignErrors.length ? { assignErrors } : {}),
    });
    return;
  }
  const sum = core.summarizePrompts(reqs);
  if (!reqs.length) {
    process.stdout.write(c.dim(`no user prompts recorded in session ${session}.\n`));
    return;
  }
  process.stdout.write(c.bold('Prompts') + c.dim(`  ${sum.total} asked · ${sum.withEdits} produced edits · ${sum.edits} edit(s) total · session ${session}\n\n`));
  for (const r of reqs) {
    const facts: string[] = [];
    if (r.edits) facts.push(c.cyan(`${r.edits}e`) + c.dim(` ${r.files}f ${r.folders}fo`));
    if (r.tokens) facts.push(`${fmtTok(r.tokens)} tok`);
    if (r.tasks) facts.push(`${r.tasks}t`);
    if (r.agents.length) facts.push(`${r.agents.length}a`);
    if (r.workflows.length) facts.push(`${r.workflows.length}w`);
    if (r.processes.length) facts.push(`${r.processes.length}p`);
    if (r.compactions) facts.push('⤺');
    // The ask is printed WHOLE, wrapped over as many lines as it needs — never clipped to a width.
    // A truncated prompt is the one thing on this list a reader can't reconstruct from anywhere else.
    const lines = wrapText(r.text, Math.max(40, (process.stdout.columns || 100) - 5));
    process.stdout.write(c.dim(`#${String(r.index).padEnd(3)}`) + `${lines[0]}\n`);
    for (const ln of lines.slice(1)) process.stdout.write(`     ${ln}\n`);
    process.stdout.write(c.dim(`     ${fmtDur(r.durationMs).padStart(7)}${facts.length ? '  ' + facts.join(' · ') : ''}\n`));
  }
  process.stdout.write(c.dim('\nwork is attributed to the prompt that STARTED it — a shell launched here belongs here even if it exits later\n'));
}

/** Break text onto lines at word boundaries — used wherever a full sentence must survive a narrow
 *  terminal. Wrapping, never clipping: an ellipsis loses the only copy of what the user actually said.
 *  A word longer than the width (a path, a URL) gets its own line rather than being cut mid-token. */
function wrapText(s: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const w of String(s ?? '').split(/\s+/).filter(Boolean)) {
    if (!line) line = w;
    else if (line.length + 1 + w.length <= width) line += ' ' + w;
    else {
      out.push(line);
      line = w;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/** Compact token count (1.2M / 45k / 900) — the total incl. cache, as the Stats panel sums it. */
function fmtTok(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return `${n}`;
}

/** ms → compact human duration (450ms / 3.2s / 2m 5s). */
function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0).replace(/\.0$/, '')}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${rem ? ` ${rem}s` : ''}`;
}

/** `subagents` (alias `agents`) — every subagent this session spawned, each with its own action
 *  timeline + metrics (duration / tokens), mined zero-token from subagents/*.jsonl. */
function cmdSubagents(args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  const session = getSessionId(args);
  const subs = core.parseSubagents(process.cwd(), session);
  const sum = core.summarizeSubagents(subs);
  if (args.includes('--json')) {
    emitJson({ session, summary: sum, subagents: subs });
    return;
  }
  if (subs.length === 0) {
    process.stdout.write(c.dim(`no subagents in this session (${session}).\n`));
    return;
  }
  const head = [
    `${sum.count} subagent(s)`,
    `${sum.totalActions} action(s)`,
    sum.totalEdits ? `${sum.totalEdits} edit(s)` : null,
    sum.totalDurationMs ? fmtDur(sum.totalDurationMs) : null,
    sum.totalTokens ? `${human(sum.totalTokens)} tok` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  process.stdout.write(c.bold('Subagents') + c.dim(`  ${head} · session ${session}\n\n`));
  const limit = args.includes('--all') ? Infinity : 8;
  for (const s of subs) {
    const title = s.agentType || s.description || s.agentId.slice(0, 12);
    const meta = [
      s.durationMs ? fmtDur(s.durationMs) : null,
      s.tokens ? `${human(s.tokens)} tok` : null,
      `${s.summary.total} action(s)`,
      s.edits ? `${s.edits} edit(s)` : null,
      s.summary.errors ? c.red(`${s.summary.errors} err`) : null,
      s.status && s.status !== 'completed' ? c.yellow(s.status) : null,
    ]
      .filter(Boolean)
      .join(' · ');
    process.stdout.write(c.cyan('▸ ') + c.bold(title) + c.dim(`  ${meta}\n`));
    if (s.description && s.agentType) process.stdout.write('   ' + c.dim(s.description.slice(0, 100)) + '\n');
    for (const a of s.actions.slice(0, limit)) {
      const mark = a.isError ? c.red('✗') : ' ';
      process.stdout.write(`   ${mark} ${c.dim(`[${a.category}]`.padEnd(9))} ${c.bold(a.tool)} ${(a.target || '').slice(0, 56)}\n`);
    }
    if (s.actions.length > limit) process.stdout.write(c.dim(`   … ${s.actions.length - limit} more (\`--all\` to expand)\n`));
    process.stdout.write('\n');
  }
}

/** `siblings` (alias `fleet`) — the other Claude Code sessions in THIS project: active/idle, pending
 *  edits, files touched, risk flags. Agent-facing digest (call it mid-run to see what siblings touch);
 *  --json defaults to siblings only (excludes self), --all includes self. */
function cmdSiblings(args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  const session = getSessionId(args);
  // --repo widens the scope from this project dir to every WORKTREE of the same git repo (§S3):
  // each sibling then carries its worktree/gitBranch/phase, and the summary's conflicts count comes
  // from the UNCAPPED file set. Same-dir listSiblings stays the default (cheap, no repo resolution).
  const sessions = args.includes('--repo')
    ? core.listRepoSiblings(process.cwd(), session)
    : core.listSiblings(process.cwd(), session);
  const sum = core.summarizeFleet(sessions);
  if (args.includes('--json')) {
    const list = args.includes('--all') ? sessions : sessions.filter((s) => !s.self);
    emitJson({ session, summary: sum, siblings: list });
    return;
  }
  if (sessions.filter((s) => !s.self).length === 0) {
    process.stdout.write(c.dim(`no sibling sessions in this project (only ${session}).\n`));
    return;
  }
  process.stdout.write(
    c.bold('Fleet') +
      c.dim(`  ${sum.total} session(s) · ${sum.active} active · ${sum.siblings} sibling(s) · ${sum.pending} pending across siblings\n\n`)
  );
  for (const s of sessions) {
    const dot = s.active ? c.green('●') : c.dim('○');
    const you = s.self ? c.cyan(' (you)') : '';
    const risk = s.risk.total ? (s.risk.high ? c.red(` ⚠ ${s.risk.high} high`) : c.yellow(` ⚠ ${s.risk.total}`)) : '';
    process.stdout.write(
      `${dot} ${c.bold(s.id.slice(0, 8))}${you}  ${c.dim(`${s.edits} edit(s) · ${s.pending} pending · ${core.relTime(s.lastMs)}`)}${risk}\n`
    );
    if (s.files.length) {
      const shown = s.files.slice(0, 5).map((f) => relFile(f));
      process.stdout.write('   ' + c.dim(shown.join(', ') + (s.moreFiles ? ` +${s.moreFiles} more` : '')) + '\n');
    }
  }
}


/** `multitask` (§4) — the multi-agent bottom-panel view: one row per running agent across every
 *  worktree of this repo (live phase, sparkline, ±lines, risk), its nested subagents (phase + current
 *  task/todos + ±lines), and the cross-agent live file conflicts. One JSON payload; both editors render it
 *  thin, no client aggregation. Zero token, git-free, path-only. */
function cmdMultitask(args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  const session = getSessionId(args);
  const ri = args.indexOf('--root'); // repo-scoped: honor --root like changemap/tree (editors point it at the workspace)
  const cwd = flagValue(args, '--root') ?? process.cwd();
  const siblings = core.listRepoSiblings(cwd, session);
  const fleet = core.summarizeFleet(siblings);
  const collisions = core.fleetConflicts(siblings); // live conflicts: a file pending in 2+ both-active siblings

  const now = Date.now();
  const agents = siblings.map((sib) => {
    const transcript = core.findTranscript(sib.worktree, sib.id);
    const pd = transcript
      ? core.agentPhaseDetail(transcript)
      : { phase: 'idle' as const, confidence: 'heuristic' as const };
    // The session's human title — the SAME source the session selector uses (preferredSessionTitle's
    // order, normalized), bounded + sidecar-cached, so even a folded row pays a stat
    // rather than a parse. Null → the renderer falls back to the branch. (The
    // observatory lists sessions BY TITLE, not by "feat/acp".)
    const title = transcript ? core.fastSessionTitle(transcript, sib.id) : null;
    // The store's on-disk footprint and when the session last moved (for the "10m ago" the master shows before the
    // title). `storeBytes` is cached on the store's shape, so a folded row still pays only a stat.
    const storeBytes = core.storeBytes(sib.id);
    // FOLDED: a conversation more than FLEET_FOLD_MS old, and not the one under review. 24 of the 33
    // siblings in this repo qualify, and building their maps was most of what a cold refresh cost.
    // Serve one from the disk cache if it is already there; otherwise report the row as UNBUILT and
    // move on. Identity, phase and file list stay honest — they come from listRepoSiblings, which is
    // sidecar-cached and cheap. Everything below this line is a transcript parse and is skipped.
    const folded = sib.id !== session && core.isFoldedAge(sib.lastMs, now);
    const cached = folded ? core.siblingOverviewCached(sib.worktree, sib.id, { root: sib.worktree }) : null;
    if (folded && !cached) {
      return {
        session: sib.id,
        worktree: sib.worktree,
        gitBranch: sib.gitBranch,
        title,
        lastActiveMs: sib.lastMs,
        storeBytes,
        self: sib.self,
        phase: pd.phase,
        phaseConfidence: pd.confidence,
        sparkline: [],
        todos: [],
        subagents: [],
        files: sib.files,
        diff: { added: 0, removed: 0 },
        tokens: 0,
        durationMs: 0,
        // PENDING (unresolved) edits and liveness — the two facts the observatory master filters on, so a
        // folded-but-unreviewed session still shows. Both come from listRepoSiblings (sidecar-cached), so
        // a folded row still pays only a stat. `edits` stays 0: its map is unbuilt, `pending` is not.
        edits: 0,
        pending: sib.pending,
        active: sib.active === true,
        risk: sib.risk,
        outside: { reads: 0, writes: 0 },
        compactions: 0,
        folded: true,
        // The zeros above are placeholders. A renderer must read THIS, not them: "not built" and
        // "changed nothing" are different facts that look identical in the numbers.
        loaded: false,
      };
    }
    // Full (slow-tier) payload: whole-file builds per agent — aggregated HERE so renderers stay thin.
    // EVERY sibling, the session under review included, comes from the on-disk cache: it is keyed to the
    // (transcript, log) stamps, so a session that is still being written misses it naturally and a
    // finished one hits it. The old special case rebuilt "the active session" unconditionally, which is
    // right for the live conversation and badly wrong for a PINNED one — switching to a long finished
    // session paid seconds of transcript parsing on every refresh tick, forever. Live facts (phase,
    // subagent phases) are computed below, outside the cache, so nothing frozen is reported as current.
    const view = cached ?? core.siblingOverview(sib.worktree, sib.id, { root: sib.worktree });
    const map = view.map;
    // Per-sibling tokens + wall-clock (one light transcript pass) — so Fleet shows the same metric style
    // as Workflows already do. Cached on this slow tier alongside buildChangeMap.
    const usage = core.sessionUsage(sib.worktree, sib.id);
    const subRoll = new Map(map.rollupBySubagent.map((r) => [r.subagentId, r])); // per-subagent ±lines
    // Digests, not full parses: a fleet row needs identity, plan and live phase — never the subagent's
    // action list, which is what made this the slowest remaining part of a refresh.
    const subagents = core.subagentDigests(sib.worktree, sib.id).map((s) => {
      const roll = subRoll.get(s.agentId);
      return {
        agentId: s.agentId,
        agentType: s.agentType ?? null,
        description: s.description ?? null,
        phase: s.phase,
        phaseConfidence: s.phaseConfidence, // 'high' | 'heuristic' — renderers dim staleness-inferred phases
        running: s.running, // the digest's own liveness — dropping it left consumers deriving it from prose
        todos: s.todos,
        currentTask: s.currentTask,
        ts: s.ts ?? 0, // spawn time — so the detail pane can order most-recent-first and show its age
        model: s.model ?? '', // the spawn's OWN model/effort, from its transcript
        effort: s.effort ?? '',
        edits: roll ? roll.edits : 0,
        added: roll ? roll.added : 0,
        removed: roll ? roll.removed : 0,
        // What the subagent cost, so the Workers tab shows it the same metrics as its parent.
        tokens: s.tokens ?? 0,
        // The ↑in·↓out·↺cacheRead split the statusline shows.
        tokensIn: s.tokensIn ?? 0,
        tokensOut: s.tokensOut ?? 0,
        tokensCacheRead: s.tokensCacheRead ?? 0,
        durationMs: s.durationMs ?? 0,
      };
    });
    return {
      session: sib.id,
      worktree: sib.worktree,
      gitBranch: sib.gitBranch,
      title,
      lastActiveMs: sib.lastMs,
      storeBytes,
      self: sib.self,
      phase: pd.phase,
      phaseConfidence: pd.confidence,
      sparkline: view.sparkline,
      todos: view.todos,
      subagents,
      files: sib.files,
      diff: { added: map.summary.added, removed: map.summary.removed },
      // The agent's own edit count,
      // and its live flag — the fleet's own `active`, so a row can group under "active" without the
      // renderer re-deriving liveness from phase alone. `units` is edits after same-code collapse, the
      // review count every other surface shows.
      edits: map.summary.units ?? 0,
      // PENDING (unresolved) edits — what the observatory master filters "has work to review" on, and what
      // resolve zeroes; `units` counts kept/undone rows too, so it would keep a fully-resolved session on
      // the list forever. `sib.pending` is the same count the fleet's grouping uses.
      pending: sib.pending,
      active: sib.active === true,
      tokens: usage.total,
      durationMs: usage.durationMs,
      risk: sib.risk,
      // Boundary crossings for the fleet row's ↗ suffix — the footprint's one unique fact, kept after
      // the badge row was folded into risk/egress.
      // Two integers from a sidecar-memoized count — NOT a transcript parse. The parse that used to sit
      // here was 88% of this view's CPU and 458MB of reads per tick, for numbers that only change when
      // the transcript does. (Its comment claimed "memoized — the sparkline used it too"; the sparkline
      // moved into the cached siblingOverview long ago, leaving the parse with no second customer.)
      outside: core.outsideCounts(sib.worktree, sib.id),
      compactions: map.summary.compactions,
      folded,
      loaded: true,
    };
  });

  // The distinct worktrees in play (branch + the sessions launched in each) — a compact repo index.
  const wtBy = new Map<string, { worktree: string; gitBranch: string | null; sessions: string[] }>();
  for (const sib of siblings) {
    let w = wtBy.get(sib.worktree);
    if (!w) {
      w = { worktree: sib.worktree, gitBranch: sib.gitBranch, sessions: [] };
      wtBy.set(sib.worktree, w);
    }
    w.sessions.push(sib.id);
  }

  // The active session's curated tool-call timeline (0.8.0: Actions folded into Multitasking). Drop the
  // `agent` (Subagents) category — those are already the fleet/subagent rows above — and pair it with the
  // egress sub-report. Both editors render this `actions` section below the fleet; no client aggregation.
  const sessionActions = core.parseActions(cwd, session);
  const actions = {
    groups: core.buildActionGroups(sessionActions).filter((g) => g.category !== 'agent'),
    egress: core.buildEgressReport(sessionActions),
  };

  emitJson({
    agents,
    collisions,
    worktrees: [...wtBy.values()],
    // Workflow runs (one level above subagents) for the ACTIVE session — aggregated in core, rendered thin.
    workflows: core.parseWorkflows(cwd, session),
    // The ACTIVE session's task list for the Overview's Tasks tab, across BOTH task generations:
    // the legacy numbered TaskCreate/TaskUpdate list (transcript history ∪ live dir state) unioned
    // with one row per background Agent run — the current harness's task system. Each row carries the
    // strict taskId that joins it to rollupByTask / taskEditIds. [] for sessions with neither.
    tasks: core.allSessionTaskRows(cwd, session),
    actions,
    summary: { active: fleet.active, conflicts: fleet.conflicts },
  });
}

/** `tasklog` (§2.5) — the cross-agent task log: one row per stable taskId, unioned across every
 *  worktree-sibling + subagent of this repo. Always JSON (TaskLogEntry[]). Zero token, git-free. */
function cmdTaskLog(_args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  emitJson(core.crossAgentTaskLog(process.cwd()));
}

/** `metrics` — session numbers: ±lines, action/error counts, per-subagent duration/tokens, tool latency. */
function cmdMetrics(args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  const session = getSessionId(args);
  const m = core.sessionMetrics(process.cwd(), session);
  if (args.includes('--json')) {
    emitJson(m);
    return;
  }
  process.stdout.write(c.bold('Metrics') + c.dim(`  session ${session}\n\n`));
  process.stdout.write(
    `  edits         ${m.edits.count}  ${c.green('+' + m.edits.added)} ${c.red('-' + m.edits.removed)}  ` +
      c.dim(`${m.edits.pending} pending · ${m.edits.kept} kept · ${m.edits.undone} undone`) +
      '\n'
  );
  process.stdout.write(`  actions       ${m.actions.total}${m.actions.errors ? c.red(`  ${m.actions.errors} error(s)`) : ''}\n`);
  process.stdout.write(
    `  subagents     ${m.subagents.count}` +
      (m.subagents.count
        ? c.dim(
            `  ${m.subagents.totalActions} action(s) · ${m.subagents.totalEdits} edit(s)` +
              (m.subagents.totalDurationMs ? ` · ${fmtDur(m.subagents.totalDurationMs)}` : '') +
              (m.subagents.totalTokens ? ` · ${human(m.subagents.totalTokens)} tok` : '')
          )
        : '') +
      '\n'
  );
  if (m.toolLatency.count)
    process.stdout.write(
      `  tool latency  ` +
        c.dim(`median ${fmtDur(m.toolLatency.medianMs)} · p95 ${fmtDur(m.toolLatency.p95Ms)} · max ${fmtDur(m.toolLatency.maxMs)} (${m.toolLatency.count} call(s))`) +
        '\n'
    );
  if (m.spanMs) process.stdout.write(`  span          ${c.dim(fmtDur(m.spanMs))}\n`);
}

/**
 * The value following a `--flag`, or undefined when the flag is absent OR was given without one.
 *
 * A following token that itself starts with `--` is NOT a value. Without that rule every caller here
 * silently acted on a flag name: `locate --file --json` resolved `<cwd>/--json` as the path to place
 * edits in, `list --file --json` filtered for files containing "--json" and reported an empty result,
 * and `clean --session --json` operated on a session literally named `--json` — which passes
 * `isSafeSessionId`, since `-` is in its character class. Returning undefined lets each caller fail
 * loudly instead of acting on the wrong thing.
 */
function flagValue(args: string[], name: string): string | undefined {
  const inline = args.find(a => a.startsWith(name + '='));
  if (inline !== undefined) return inline.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : undefined;
}

/** Flags that consume the token after them — so a numeric VALUE is never read as a positional id. */
// `--tab` is here because its VALUE is a tab id, and `review` is also a command name: without this
// the parser reads `--tab review` as the flag followed by the review verb and refuses the whole
// invocation. A value flag whose values collide with verbs has to be declared, not inferred.
const VALUE_FLAGS = new Set(['--session', '--file', '--under', '--ids', '--root', '--filter', '--dir', '--channel', '--from-prompt', '--tab']);

/**
 * The positional edit id if one was typed, else undefined — requireId's scan without the failure.
 *
 * Used to REFUSE a scoped verb that also names an id. `keep`/`undo`/`redo` take the scope branch
 * (`--all` / `--file` / `--under` / `--ids`) before `requireId` is ever reached, so the id was silently
 * discarded: `undo --file src 2` reverted every pending edit under `src`, wrote them all to disk, and
 * exited 0 reporting `{"undone":2}`. Asking for one edit must never revert a whole scope.
 */
function positionalId(args: string[]): number | undefined {
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i])) {
      i++; // skip the flag's VALUE
      continue;
    }
    if (args[i].startsWith('--')) continue;
    if (/^\d+$/.test(args[i])) return Number(args[i]);
  }
  return undefined;
}

/** Refuse a scope-wide verb that also names a single edit — the two mean different things. */
function refuseScopeWithId(args: string[], verb: string): void {
  const id = positionalId(args);
  if (id === undefined) return;
  fail(
    `\`${verb}\` was given both a scope flag and edit id ${id}, which mean different things.\n` +
      `  For just that edit:   oak ${verb} ${id}\n` +
      `  For the whole scope:  drop the id and re-run.`
  );
}

/**
 * Resolve `--from-prompt <id>` into the rewind scope: this ask and everything after it.
 *
 * Shared by `undo` and `redo` so one definition of the boundary serves both directions. Three failure
 * modes are told apart deliberately, because "nothing happened" and "you named a prompt that does not
 * exist" must not look alike to a caller about to revert someone's work:
 *   - no transcript            → fail (the boundaries come from it)
 *   - no such prompt           → fail, naming the valid range
 *   - a real prompt, empty set → return it; the caller reports an honest zero and exits 0
 *
 * Must be called BEFORE `requireId`: that scan skips only `--session`, so it would otherwise read an
 * all-digit prompt id (or a bare index) as a positional edit id.
 */
function checkpointArg(
  core: typeof import('@oak-observatory/core'),
  args: string[],
  session: string,
  verb: string
): import('@oak-observatory/core').CheckpointScope {
  const ref = flagValue(args, '--from-prompt');
  if (!ref) fail(`\`${verb} --from-prompt <id>\` requires a prompt id — run \`oak prompts\` to list them`);
  const cwd = process.cwd();
  const windows = core.promptWindows(cwd, session);
  if (!windows.length) fail('no transcript for this session — the prompt boundaries come from it');
  if (!windows.some((w) => w.id === ref || String(w.index) === ref)) {
    fail(`no prompt \`${ref}\` in this session — run \`oak prompts\` to list them (1..${windows.length})`);
  }
  return core.checkpointScope(cwd, session, ref as string);
}

function requireId(args: string[]): number {
  let raw: string | undefined;
  for (let i = 0; i < args.length; i++) {
    // Skip every flag's VALUE, not just `--session`'s: any of them can be numeric, and reading one as the
    // edit id silently acts on a DIFFERENT edit than the caller named. `keep --from-prompt 2` used to keep
    // edit #2 — the wrong verb on the wrong record, reported as success.
    if (VALUE_FLAGS.has(args[i])) {
      i++;
      continue;
    }
    if (/^\d+$/.test(args[i])) {
      raw = args[i];
      break;
    }
  }
  if (!raw) fail('expected an edit id, e.g. `oak diff 3`');
  return parseInt(raw, 10);
}

/**
 * `--dry-run` means "tell me, do not do it". Exactly two scopes implement it, so anywhere else the flag
 * must REFUSE rather than be ignored: an ignored `--dry-run` performs the very mutation the caller was
 * trying to preview, and reports it as success.
 *
 * `clean` is here because it is the most expensive place to get this wrong. `--dry-run` is real on
 * `clean --completed`, which is reason enough for a reader to try it on a sibling scope — and
 * `clean --all --dry-run` used to delete every session in the store and print `✓ dropped all N session(s)`.
 */
const DRY_RUN_SCOPES: Record<string, string> = {
  undo: '--from-prompt', // the rewind preflight: count what it would revert
  clean: '--completed', // list the sessions the reap would drop
};

function refuseUnsupportedDryRun(args: string[], verb: string): void {
  if (!args.includes('--dry-run')) return;
  const previewable = DRY_RUN_SCOPES[verb];
  if (previewable && args.includes(previewable)) return;
  fail(
    `\`${verb} --dry-run\` is not supported.\n` +
      '  Only `undo --from-prompt <id> --dry-run` and `clean --completed --dry-run` can preview;\n' +
      '  every other scope would perform the change it was asked to describe.\n' +
      `  Drop --dry-run to ${verb} for real.`
  );
}

function cmdDiff(args: string[]): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const session = getSessionId(args);
  const id = requireId(args);
  // The DISPLAY record first: every list shows collapsed review units, and `diff <id>` on a unit's
  // row must render the unit's whole net change — not the raw last hop, which shows a slice of what
  // the row claims. An id no row shows (a pending member inside a unit) still answers raw, so a
  // hand-typed member id keeps meaning the single record it names.
  const rec = core.reviewEdits(session).find((r) => r.id === id) ?? core.findRecord(session, id);
  if (!rec) fail(`no edit #${id} in session ${session}`);
  if (args.includes('--json')) return emitJson({ session, id, file: rec.file, patch: core.coloredDiff(session, rec as EditRecord, false) });
  process.stdout.write(core.coloredDiff(session, rec as EditRecord, isTTY()) + '\n');
  // `--patch` means "the patch and nothing else". The trailer below is a hint for a human at a
  // prompt; to anything that PARSES this output it is one more line of diff, and the dashboard
  // rendered it as a context row at the bottom of every edit it showed.
  if (!args.includes('--patch')) process.stdout.write(c.dim(`keep #${id} · undo #${id}\n`));
}

function cmdKeep(args: string[]): void {
  refuseUnsupportedDryRun(args, 'keep');
  // `keep` has no rewind scope: accepting "this ask and everything after it" is what `keep --all` or an
  // explicit id set already say, and less ambiguously. Say so, rather than letting the generic "expected
  // an edit id" leave the reader thinking they mistyped the id.
  if (args.includes('--from-prompt')) {
    fail(
      '`keep --from-prompt <id>` is not supported — only `undo` and `redo` take a rewind scope.\n' +
        '  For one ask\'s edits:   oak keep --ids <a,b,c>\n' +
        '  For the whole session: oak keep --all'
    );
  }
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const session = getSessionId(args);
  const json = args.includes('--json');
  // Bulk: --all (every pending), --file <substr> (pending edits in matching files), or --under <path>
  // (pending edits at-or-beneath a file/folder path — the editors' folder/file Accept action, so
  // file-scope and folder-scope share one exact rule).
  // --ids <a,b,c>: an explicit set, so an editor accepting a file / folder / task / prompt spends ONE
  // process instead of one per edit (the JetBrains plugin has no in-process core).
  const idi = args.indexOf('--ids');
  if (idi >= 0) {
    const raw = args[idi + 1];
    if (!raw) fail('`keep --ids <a,b,c>` requires a comma-separated id list');
    const ids = raw.split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => Number.isFinite(n));
    if (!ids.length) fail('`keep --ids <a,b,c>` got no valid integer ids');
    const kept = core.setStatusMany(session, expandUnits(core, session, ids, args), 'kept');
    core.autoClearDemo(session);
    if (json) {
      emitJson({ kept: kept.length, ids: kept });
      return;
    }
    if (!kept.length) {
      process.stdout.write(c.dim('no pending edits to keep in that set\n'));
      return;
    }
    process.stdout.write(c.green('✓ ') + `kept ${kept.length} edit(s)\n`);
    return;
  }
  const fi = args.indexOf('--file');
  const ui = args.indexOf('--under');
  if (args.includes('--all') || fi >= 0 || ui >= 0) {
    refuseScopeWithId(args, "keep");
    const fileSubRaw = flagValue(args, "--file");
    if (fi >= 0 && !fileSubRaw) fail('`keep --file <substr>` requires a value');
    const fileSub = fileSubRaw && core.canonPath(fileSubRaw); // #43: match canonical record paths
    const underRaw = flagValue(args, "--under");
    if (ui >= 0 && !underRaw) fail('`keep --under <path>` requires a value');
    const under = underRaw && canonUnder(underRaw);
    const targets = core
      .readLog(session)
      .filter(
        (r) =>
          r.status === 'pending' &&
          (!fileSub || r.file.includes(fileSub)) &&
          (!under || core.isUnderPath(r.file, under))
      );
    core.setStatusMany(session, targets.map((r) => r.id), 'kept'); // one parse + one append
    core.autoClearDemo(session); // a fully reviewed demo session leaves no residue
    if (json) {
      emitJson({ kept: targets.length, ids: targets.map((r) => r.id) });
      return;
    }
    const scope = fileSub ? ` in files matching "${fileSub}"` : under ? ` under ${relFile(under)}` : '';
    if (targets.length === 0) {
      // Nothing matched the scope — an honest "nothing to do", never a green ✓ 0 that reads as success.
      process.stdout.write(c.dim(`no pending edits to keep${scope}\n`));
      return;
    }
    process.stdout.write(c.green('✓ ') + `kept ${targets.length} edit(s)${scope}\n`);
    return;
  }
  const id = requireId(args);
  const rec = core.findRecord(session, id);
  if (!rec) fail(`no edit #${id} in session ${session}`);
  const g = core.keepGroup(session, id); // keep the whole same-code review unit (collapsed group)
  core.autoClearDemo(session); // a fully reviewed demo session leaves no residue
  if (json) {
    emitJson({ kept: g.kept, ids: g.ids });
    return;
  }
  if (g.kept === 0) {
    // keepGroup flips only PENDING edits, so nothing happened — never a green ✓ over a no-op. Mirrors
    // the scope branch's "no pending edits to keep" above; the --json path already reported kept: 0.
    process.stdout.write(
      c.dim(
        rec.status === 'undone'
          ? `edit #${id} is reverted — nothing kept (\`redo ${id}\` to restore it first)\n`
          : `edit #${id} is already kept — nothing to do\n`
      )
    );
    return;
  }
  const label = g.kept > 1 ? `${g.kept} edits for this change` : `edit #${id}`;
  process.stdout.write(c.green('✓ ') + `kept ${label} (${relFile(rec.file)})\n`);
}

/**
 * `undo|redo --ids <a,b,c> --record-only` — record what an undo or redo ALREADY did on disk, touching
 * no file: the repair a "not recorded" report names when the store stayed busy after the files changed.
 * Exact ids (no unit widening): the report lists exactly the records whose files moved.
 */
function cmdRecordOnly(core: Core, session: string, args: string[], verb: 'undo' | 'redo'): void {
  if (['--all', '--file', '--under', '--from-prompt', '--force', '--units'].some((f) => args.includes(f))) {
    fail(`\`${verb} --record-only\` takes only --ids <a,b,c> — the edits a "not recorded" report named`);
  }
  const raw = flagValue(args, '--ids');
  if (!raw) fail(`\`${verb} --record-only\` requires --ids <a,b,c> — the edits a "not recorded" report named`);
  const ids = (raw as string).split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n));
  if (!ids.length) fail(`\`${verb} --ids <a,b,c> --record-only\` got no valid integer ids`);
  const unknown = ids.filter((id) => !core.findRecord(session, id));
  if (unknown.length) fail(`no edit #${unknown.join(', #')} in session ${session}`);
  const recorded = core.recordOnly(session, ids, verb);
  const state = verb === 'undo' ? 'reverted' : 're-applied';
  if (args.includes('--json')) {
    emitJson({ recorded: recorded.length, ids: recorded });
    return;
  }
  if (!recorded.length) {
    process.stdout.write(c.dim(`nothing to record — those edits are already recorded as ${state}\n`));
    return;
  }
  process.stdout.write(c.green('✓ ') + `recorded ${recorded.length} edit(s) as ${state} — no file was changed\n`);
}

function cmdUndo(args: string[]): void {
  refuseUnsupportedDryRun(args, 'undo');
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const session = getSessionId(args);
  if (args.includes('--record-only')) return cmdRecordOnly(core, session, args, 'undo');
  // Bulk: --all (every pending in the session), --file <substr> (pending edits in matching files),
  // --under <path> (pending edits at-or-beneath a file/folder path — the editors' folder/file Revert),
  // or --ids <a,b,c> (an explicit pending-edit id set — the Overview's Folder-axis Reject, which acts
  // on ONE module bucket's exact edits, not the recursive subtree a path scope would catch).
  // Already-Accepted (kept) edits are left on disk — revert those individually. All share core.undoScope,
  // the single scoped-revert implementation both editors also use.
  const fi = args.indexOf('--file');
  const ui = args.indexOf('--under');
  const idi = args.indexOf('--ids');
  const fp = args.indexOf('--from-prompt');
  if (args.includes('--all') || fi >= 0 || ui >= 0 || idi >= 0 || fp >= 0) {
    refuseScopeWithId(args, "undo");
    // `--from-prompt` IS a scope — combining it with another one would silently pick a winner.
    if (fp >= 0 && (args.includes('--all') || fi >= 0 || ui >= 0 || idi >= 0)) {
      fail('`undo --from-prompt <id>` is a scope of its own — drop the other scope flag and re-run.');
    }
    const fileSub = flagValue(args, "--file");
    if (fi >= 0 && !fileSub) fail('`undo --file <substr>` requires a value');
    const underRaw = flagValue(args, "--under");
    if (ui >= 0 && !underRaw) fail('`undo --under <path>` requires a value');
    const under = underRaw && canonUnder(underRaw); // #43: undoScope canonicalizes fileSub itself
    let ids: number[] | undefined;
    let units: number | undefined;
    if (idi >= 0) {
      const raw = args[idi + 1];
      if (!raw) fail('`undo --ids <a,b,c>` requires a comma-separated id list');
      ids = raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n));
      if (!ids.length) fail('`undo --ids <a,b,c>` got no valid integer ids');
      ids = expandUnits(core, session, ids, args);
    }
    if (fp >= 0) {
      const scope = checkpointArg(core, args, session, 'undo');
      ids = scope.ids; // group-expanded: a same-code chain straddling the boundary reverts whole
      units = scope.units;
      // PREFLIGHT. A rewind's confirmation has to state what it is about to rewrite, and only this scope
      // can count it: the raw records, the review units they collapse to, and the files. An editor that
      // shells out cannot get those any other way — every other exposure of this scope performs the
      // revert — so without `--dry-run` one editor could show the numbers (by calling core in-process)
      // and the other could not, which is the same feature behaving differently per editor.
      if (args.includes('--dry-run')) {
        if (args.includes('--json')) {
          emitJson({ dryRun: true, pending: scope.pending, units: scope.units, fromEarlier: scope.fromEarlier, files: scope.files, ids: scope.ids });
          return;
        }
        process.stdout.write(
          scope.pending === 0
            ? c.dim('no pending edits to rewind from that prompt onward\n')
            : `would revert ${scope.pending} pending edit(s) (${scope.units} review unit(s)) across ${scope.files.length} file(s)` +
              // A unit is the smallest revertible thing and one can span two asks (a file absent in
              // between), so a rewind can reach back past the boundary. Said, never discovered.
              (scope.fromEarlier
                ? `, including ${scope.fromEarlier} from an earlier ask that cannot be separated from this one\n`
                : '\n')
        );
        return;
      }
    }
    const res = core.undoScope(session, { under, fileSubstr: fileSub, ids });
    core.autoClearDemo(session); // a fully reviewed demo session leaves no residue
    if (args.includes('--json')) {
      // `ids` names WHICH edits reverted (the UndoScopeResult already carried them; dropping them left a
      // caller unable to offer a precise Redo). `units` rides along only for the rewind scope, whose two
      // counts differ: raw records vs the review units the Prompts rows print.
      emitJson({
        undone: res.undone,
        conflicts: res.conflicts,
        errors: res.errors,
        firstError: res.firstError ?? null,
        total: res.total,
        ids: res.ids,
        ...(units === undefined ? {} : { units }),
        ...(res.firstConflict === undefined ? {} : { firstConflict: res.firstConflict }),
        // Files reverted but not recorded: a JSON caller must say so (exit stays 0 so it can be parsed).
        ...(res.unrecorded ? { unrecorded: res.unrecorded } : {}),
      });
      return;
    }
    const scope = fileSub ? ` in files matching "${fileSub}"` : under ? ` under ${relFile(under)}` : fp >= 0 ? ` from prompt ${flagValue(args, '--from-prompt')} onward` : ids ? ` in ${ids.length} selected edit(s)` : '';
    if (res.total === 0) {
      // No pending edits matched the scope — an honest "nothing to do", never a green ✓ 0.
      process.stdout.write(c.dim(`no pending edits to revert${scope}\n`));
      return;
    }
    process.stdout.write(
      (res.conflicts || res.errors || res.unrecorded ? c.yellow('⚠ ') : c.green('✓ ')) +
        `reverted ${res.undone} edit(s)${scope}` +
        (res.conflicts ? ` · ${res.conflicts} conflict(s) left (undo individually with --force)` : '') +
        (res.errors ? ` · ${res.errors} refused` : '') +
        '\n'
    );
    // The refusal's remediation pointer (e.g. `clean --phantoms`) must reach the user — a bulk revert
    // that silently swallows it leaves a session that never empties and no way to learn why.
    if (res.errors && res.firstError) process.stdout.write(c.yellow('  ↳ ') + res.firstError + '\n');
    // Same for a conflict: when it is a named-dependent refusal, the name and the closure are the remedy.
    if (res.conflicts && res.firstConflict) process.stdout.write(c.yellow('  ↳ ') + res.firstConflict + '\n');
    if (res.unrecorded) {
      process.stdout.write(c.red('✗ ') + res.unrecorded.message + '\n');
      process.exit(1);
    }
    return;
  }
  const id = requireId(args);
  const force = args.includes('--force');
  // Undo the whole same-code review unit (collapsed group) as ONE merge; --force is the per-file fallback.
  const res = force ? core.restoreFile(session, id) : core.undoGroup(session, id);
  core.autoClearDemo(session); // a fully reviewed demo session leaves no residue
  // A named-dependent refusal gets prompt attribution here, not in core — core has no cwd at that
  // depth. Best-effort: promptWindows answers in display units, which is what `dependents` carries.
  if (res.status === 'conflict' && res.dependents?.length) {
    try {
      const windows = core.promptWindows(flagValue(args, '--root') ?? process.cwd(), session);
      const notes = res.dependents
        .map((d) => {
          const w = windows.find((x) => x.editIds.includes(d));
          return w ? `unit #${d} is prompt #${w.index}'s work` : null;
        })
        .filter((n): n is string => n !== null);
      if (notes.length) res.message += ` (${notes.join('; ')})`;
    } catch {
      /* no transcript beside this store — the ids alone still name the edge */
    }
  }
  // --json: the full structured UndoResult, so a front-end can branch conflict → offer --force
  // instead of string-matching prose. Exit codes match the human path exactly.
  if (args.includes('--json')) {
    emitJson({
      ok: res.ok,
      status: res.status,
      message: res.message,
      ...(res.dependents ? { dependents: res.dependents, closure: res.closure } : {}),
      ...(res.unrecorded ? { unrecorded: res.unrecorded } : {}),
    });
    process.exit(res.status === 'conflict' ? 1 : res.ok ? 0 : 1);
  }
  if (res.status === 'conflict') {
    process.stdout.write(c.yellow('⚠ conflict: ') + res.message + '\n');
    process.exit(1);
  }
  process.stdout.write((res.ok ? c.green('✓ ') : c.red('✗ ')) + res.message + '\n');
  process.exit(res.ok ? 0 : 1);
}

/**
 * `assign --ids <a,b,c> --prompt <id|index> [--json]` / `assign --ids … --clear` — move edits'
 * PROMPT ATTRIBUTION. The mechanism behind "this change belongs to that ask": an exact override
 * table keyed by immutable record ids, appended to the log as `{op:"scope"}` lines (last wins,
 * survives rewrites). Every read side follows — prompts, the change map's per-ask rollups,
 * `review --prompt`, and rewind scopes — because they all attribute through one helper. Units are
 * NOT re-derived: boundaries stay temporal; only the label moves. The editors' drag/menu gesture is
 * deferred; this verb is the whole 0.9.4 surface.
 */
function cmdAssign(args: string[]): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const viewRoot = flagValue(args, '--root') ?? process.cwd();
  const session = getSessionId(args);
  const json = args.includes('--json');
  if (noTranscript(session, json, flagValue(args, '--root') ?? undefined)) return;

  const rawIds = flagValue(args, '--ids');
  if (!rawIds) fail('`assign --ids <a,b,c>` requires a comma-separated id list');
  const parsed = (rawIds as string).split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n));
  if (!parsed.length) fail('`assign --ids <a,b,c>` got no valid integer ids');
  // Expand through units — the same rule as every id-set verb: a collapsed row names its rep, and
  // moving the rep alone would strand its members' attribution.
  const ids = [...new Set(parsed.flatMap((id) => core.groupMembers(session, id)))].sort((a, b) => a - b);

  if (args.includes('--clear')) {
    core.appendScopeOverride(session, ids, null);
    if (json) emitJson({ assigned: false, ids, prompt: null });
    else process.stdout.write(c.green('✓ ') + `cleared the assignment of ${ids.length} edit(s)\n`);
    return;
  }
  const want = flagValue(args, '--prompt');
  if (!want) fail('`assign --ids … --prompt <id|index>` requires a prompt (or --clear)');
  const reqs = core.sessionPrompts(viewRoot, session);
  const r = reqs.find((x) => x.id === want || String(x.index) === want);
  if (!r) fail(`no prompt "${want}" in session ${session} (1..${reqs.length}).`);
  core.appendScopeOverride(session, ids, r.id);
  if (json) emitJson({ assigned: true, ids, prompt: r.id });
  else process.stdout.write(c.green('✓ ') + `assigned ${ids.length} edit(s) to prompt #${r.index}\n`);
}

/**
 * `oplog [--json]` / `oplog --revert-last [--json]` — the reviewer's own journaled operations.
 * CLI-only surface, like `tasklog`: neither editor invokes it. Bulk keeps/reverts land in the log as
 * `{op:"batch"}` lines with before-images (store.ts); this lists them newest first and reverts the
 * most recent one — statuses restored for a keep, files rewritten for an undo/redo.
 */
function cmdOplog(args: string[]): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const session = getSessionId(args);
  const json = args.includes('--json');
  const ops = core.readOperations(session);
  if (args.includes('--revert-last')) {
    if (!ops.length) {
      if (json) emitJson({ session, reverted: null });
      else process.stdout.write(c.dim('no journaled operations in this session\n'));
      return;
    }
    const last = ops[0];
    const res = core.revertOperation(session, last);
    core.autoClearDemo(session); // a fully reviewed demo session leaves no residue
    const scoped = res.result as { undone?: number; redone?: number; conflicts?: number; unrecorded?: { message: string } } | undefined;
    if (json) {
      emitJson({
        session,
        reverted: { kind: last.kind, label: last.label, ids: last.ids, ts: last.ts },
        ...(res.restored === undefined ? {} : { restored: res.restored }),
        ...(scoped ? { result: scoped } : {}),
      });
      return;
    }
    const outcome =
      res.restored !== undefined
        ? `${res.restored} status(es) restored`
        : `${scoped?.undone ?? scoped?.redone ?? 0} edit(s) rewritten` +
          (scoped?.conflicts ? ` · ${scoped.conflicts} conflict(s) left` : '');
    process.stdout.write((scoped?.unrecorded ? c.yellow('⚠ ') : c.green('✓ ')) + `reverted "${last.label}" — ${outcome}\n`);
    if (scoped?.unrecorded) {
      process.stdout.write(c.red('✗ ') + scoped.unrecorded.message + '\n');
      process.exit(1);
    }
    return;
  }
  if (json) {
    emitJson({ session, operations: ops.map((o) => ({ kind: o.kind, label: o.label, ids: o.ids, ts: o.ts })) });
    return;
  }
  if (!ops.length) {
    process.stdout.write(c.dim('no journaled operations in this session — bulk keeps and reverts land here\n'));
    return;
  }
  for (const o of ops) {
    process.stdout.write(`${c.dim(core.relTime(o.ts).padEnd(8))} ${o.label}  ${c.dim(`(#${o.ids.join(', #')})`)}\n`);
  }
}

function cmdRedo(args: string[]): void {
  refuseUnsupportedDryRun(args, 'redo');
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const session = getSessionId(args);
  if (args.includes('--record-only')) return cmdRecordOnly(core, session, args, 'redo');
  // Bulk: --all (every undone in the session) | --file <substr> | --under <path> | --ids <a,b,c> —
  // the forward mirror of `undo`'s selectors, via the shared core.redoScope.
  const fi = args.indexOf('--file');
  const ui = args.indexOf('--under');
  const idi = args.indexOf('--ids');
  const fp = args.indexOf('--from-prompt');
  if (args.includes('--all') || fi >= 0 || ui >= 0 || idi >= 0 || fp >= 0) {
    refuseScopeWithId(args, "redo");
    if (fp >= 0 && (args.includes('--all') || fi >= 0 || ui >= 0 || idi >= 0)) {
      fail('`redo --from-prompt <id>` is a scope of its own — drop the other scope flag and re-run.');
    }
    const fileSub = flagValue(args, "--file");
    if (fi >= 0 && !fileSub) fail('`redo --file <substr>` requires a value');
    const underRaw = flagValue(args, "--under");
    if (ui >= 0 && !underRaw) fail('`redo --under <path>` requires a value');
    const under = underRaw && canonUnder(underRaw); // #43: redoScope canonicalizes fileSub itself
    let bulkIds: number[] | undefined;
    if (idi >= 0) {
      const raw = args[idi + 1];
      if (!raw) fail('`redo --ids <a,b,c>` requires a comma-separated id list');
      bulkIds = raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n));
      if (!bulkIds.length) fail('`redo --ids <a,b,c>` got no valid integer ids');
      bulkIds = expandUnits(core, session, bulkIds, args);
    }
    if (fp >= 0) {
      // The prompt's WINDOW, scoped the same way the rewind scopes it — narrower than `redo --all`, which
      // would also re-apply edits this prompt never touched.
      //
      // It is NOT "exactly what the rewind reverted", and cannot be: `checkpointScope` answers with every
      // record in the window whatever its status, so an edit undone BEFORE the rewind is undone-and-in-scope
      // and comes back too. Only the ids a particular rewind moved can express that set, which is why both
      // editors' Redo buttons pass `undo --from-prompt --json`'s `ids` to `--ids` instead of re-resolving
      // the prompt. The help text says so out loud rather than leaving a reader to discover it.
      //
      // Deliberately no `units`: the scope's unit count is computed over the PENDING records (it exists to
      // make a rewind's confirmation honest), and by the time anything is redone those records are undone,
      // so the number would always be 0. Emitting a confident 0 is worse than emitting nothing.
      bulkIds = checkpointArg(core, args, session, 'redo').ids;
    }
    const bulk = core.redoScope(session, { under, fileSubstr: fileSub, ids: bulkIds });
    if (args.includes('--json')) {
      emitJson({ redone: bulk.redone, conflicts: bulk.conflicts, total: bulk.total, ids: bulk.ids, ...(bulk.unrecorded ? { unrecorded: bulk.unrecorded } : {}) });
      return;
    }
    const scope = fileSub ? ` in files matching "${fileSub}"` : under ? ` under ${relFile(under)}` : fp >= 0 ? ` from prompt ${flagValue(args, '--from-prompt')} onward` : bulkIds ? ` in ${bulkIds.length} selected edit(s)` : '';
    if (bulk.total === 0) {
      process.stdout.write(c.dim(`no undone edits to redo${scope}\n`));
      return;
    }
    process.stdout.write(
      (bulk.conflicts || bulk.unrecorded ? c.yellow('⚠ ') : c.green('✓ ')) +
        `re-applied ${bulk.redone} edit(s)${scope}` +
        (bulk.conflicts ? ` · ${bulk.conflicts} conflict(s) left (redo individually with --force)` : '') +
        '\n'
    );
    if (bulk.unrecorded) {
      process.stdout.write(c.red('✗ ') + bulk.unrecorded.message + '\n');
      process.exit(1);
    }
    return;
  }
  const id = requireId(args);
  const force = args.includes('--force');
  const res = force ? core.reapplyFile(session, id) : core.redoGroup(session, id);
  if (args.includes('--json')) {
    emitJson({ ok: res.ok, status: res.status, message: res.message, ...(res.unrecorded ? { unrecorded: res.unrecorded } : {}) });
    process.exit(res.status === 'conflict' ? 1 : res.ok ? 0 : 1);
  }
  if (res.status === 'conflict') {
    process.stdout.write(c.yellow('⚠ conflict: ') + res.message + '\n');
    process.exit(1);
  }
  process.stdout.write((res.ok ? c.green('✓ ') : c.red('✗ ')) + res.message + '\n');
  process.exit(res.ok ? 0 : 1);
}

/** Resolve the taskId argument: `--task <id>`, else the first positional (skipping flags + the
 *  --session value). A taskId is a content-hash slug (§2.1), never a path — no traversal to guard. */
function requireTaskId(args: string[], session: string): string {
  const flag = flagValue(args, '--task');
  const found = flag || pickTaskIdArg(args);
  if (!found) {
    // `tasklog` unions taskIds across worktrees and subagents, so an id it lists may belong to a
    // SIBLING session and have no strict span here. `changemap.tasks[]` is the per-session source.
    fail('expected a taskId, e.g. `oak task-keep <taskId>` (ids: `changemap` tasks[] / rollupByTask)');
  }
  // A taskId this session never had is a MISTAKE, not an empty result. keepTask/undoTask answer both
  // with a bare zero, so `task-keep <garbage>` printed a green "kept 0 edit(s)" and exited 0 — the
  // caller could not tell a typo from a task that simply had nothing pending. (no-silent-fail)
  const core = require('@oak-observatory/core') as Core;
  const known = core.sessionTaskIds(process.cwd(), session);
  if (!known.includes(found)) {
    fail(
      `no task ${found} in session ${session}.\n` +
        (known.length
          ? `  This session's task ids: ${known.join(', ')}`
          : '  This session has no tasks (nothing ever entered in_progress).')
    );
  }
  return found;
}

function pickTaskIdArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i])) {
      i++; // skip the flag's VALUE
      continue;
    }
    if (!args[i].startsWith('--')) return args[i];
  }
  return undefined;
}

/** `task-keep` (§6) — mark every PENDING edit in a task's STRICT in_progress span kept. Honest by
 *  construction: only edits made while the task was actually in progress are in the set (core
 *  taskEditIds) — an edit that cannot be strictly placed is never included. */
function cmdTaskKeep(args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  const session = getSessionId(args);
  const taskId = requireTaskId(args, session);
  const res = core.keepTask(process.cwd(), session, taskId);
  core.autoClearDemo(session); // a fully reviewed demo session leaves no residue
  if (args.includes('--json')) {
    emitJson({ kept: res.kept, total: res.total, ids: res.ids });
    return;
  }
  process.stdout.write(
    c.green('✓ ') +
      `kept ${res.kept} edit(s) in task ${taskId}` +
      (res.total !== res.kept ? c.dim(` (${res.total} in the task's strict span)`) : '') +
      '\n'
  );
}

/** `task-undo` (§6) — revert every PENDING edit in a task's STRICT in_progress span, newest-first.
 *  Same strict set as task-keep; each revert stays conflict-guarded per edit. */
function cmdTaskUndo(args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  const session = getSessionId(args);
  const taskId = requireTaskId(args, session);
  const res = core.undoTask(process.cwd(), session, taskId);
  core.autoClearDemo(session); // a fully reviewed demo session leaves no residue
  if (args.includes('--json')) {
    // Same UndoScopeResult as the bulk path, so it gets the same JSON shape: a refusal that reaches one
    // caller and not the other is how a session that never empties gets no explanation.
    emitJson({ undone: res.undone, conflicts: res.conflicts, errors: res.errors, firstError: res.firstError ?? null, total: res.total, ids: res.ids, ...(res.firstConflict === undefined ? {} : { firstConflict: res.firstConflict }), ...(res.unrecorded ? { unrecorded: res.unrecorded } : {}) });
    return;
  }
  process.stdout.write(
    (res.conflicts || res.errors || res.unrecorded ? c.yellow('⚠ ') : c.green('✓ ')) +
      `reverted ${res.undone} edit(s) in task ${taskId}` +
      (res.conflicts ? ` · ${res.conflicts} conflict(s) left (undo individually with --force)` : '') +
      (res.errors ? ` · ${res.errors} refused` : '') +
      '\n'
  );
  if (res.errors && res.firstError) process.stdout.write(c.yellow('  ↳ ') + res.firstError + '\n');
  if (res.unrecorded) {
    process.stdout.write(c.red('✗ ') + res.unrecorded.message + '\n');
    process.exit(1);
  }
}

/** `task-clear` (§C) — drop the RESOLVED (kept/undone) edits of a task's STRICT edit set
 *  (core.taskEditIds → core.clearResolvedIds); pending edits are preserved. `--completed` clears
 *  every SETTLED task (edits present, none pending, none undone). */
function cmdTaskClear(args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  const session = getSessionId(args);
  const json = args.includes('--json');
  if (args.includes('--completed')) {
    // Cached: the map this reads is the same one the Overview just built, and re-deriving it cost
    // seconds on a large session for a rollup that is already sitting on disk.
    const map = core.cachedChangeMap(process.cwd(), session, { root: process.cwd(), prompts: true });
    // A settled task: strict-attributed edits present, none pending, none undone.
    const settled = map.rollupByTask.filter((t) => t.taskId !== null && t.edits > 0 && t.pending === 0 && t.undone === 0);
    let cleared = 0;
    const ids: number[] = [];
    const tasks: { taskId: string; cleared: number }[] = [];
    for (const t of settled) {
      const res = core.clearResolvedIds(session, core.taskEditIds(process.cwd(), session, t.taskId!));
      cleared += res.cleared;
      ids.push(...res.ids);
      tasks.push({ taskId: t.taskId!, cleared: res.cleared });
    }
    if (json) {
      emitJson({ cleared, ids, tasks });
      return;
    }
    process.stdout.write(
      c.green('✓ ') + `cleared ${cleared} resolved edit(s) across ${tasks.length} completed task(s)\n`
    );
    return;
  }
  const taskId = requireTaskId(args, session);
  const res = core.clearResolvedIds(session, core.taskEditIds(process.cwd(), session, taskId));
  if (json) {
    emitJson({ cleared: res.cleared, ids: res.ids });
    return;
  }
  process.stdout.write(c.green('✓ ') + `cleared ${res.cleared} resolved edit(s) in task ${taskId}\n`);
}

/** `demo` (0.8.0) — the live simulator: replays a scripted Claude session through the REAL pipeline
 *  (transcript, captured edits, a subagent, a workflow) in an isolated demo-* session + folder, so
 *  every panel updates live and review/undo genuinely work. `--fast` lands the whole scenario in
 *  well under a second (the automated-test mode); `--clean` removes every trace. Zero token. */
async function cmdDemo(args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as Core;
  const dir = flagValue(args, '--dir');
  const json = args.includes('--json');
  // The tour's script, printed rather than replayed. Both editors read the --json form, so the tour
  // they render and the one this prints can never be two different tours.
  if (args.includes('--tour')) {
    // Three tracks over ONE script: `essentials` is the marked subset, `remainder` its exact complement
    // (so finishing the short track can resume rather than restart), both in script order.
    if (args.includes('--essentials') && args.includes('--remainder')) {
      fail('`demo --tour` takes --essentials or --remainder, not both — they are complementary halves of one script');
    }
    const track = args.includes('--essentials') ? 'essentials' : args.includes('--remainder') ? 'remainder' : 'everything';
    const steps = core.demoTour(track);
    if (json) {
      emitJson({ track, steps, sizes: core.demoTrackSizes(), blurb: core.demoTrackBlurb(track) });
      return;
    }
    steps.forEach((s, i) => {
      const where = s.view === 'overview' ? `Overview · ${s.tab}` : s.view;
      process.stdout.write(`\n${c.bold(`${i + 1}. ${s.title}`)}  ${c.dim(`— ${where}`)}\n`);
      for (const line of wrapText(s.body, 76)) process.stdout.write(`   ${line}\n`);
      // The one-line gloss both editors render under the body. Dropping it here made the printed tour
      // quietly shorter than the driven one, which is exactly the drift core owning the script prevents.
      if (s.tip) for (const line of wrapText(s.tip, 76)) process.stdout.write(c.dim(`   ${line}\n`));
      if (s.tryIt) for (const line of wrapText(`try: ${s.tryIt}`, 76)) process.stdout.write(c.dim(`   ${line}\n`));
      // The same two labels the editors' panels use, so the printed tour and the driven one read alike.
      if (s.action) {
        const label = s.action.mode === 'auto' ? 'the tour does this:' : 'your turn:';
        const text = s.action.mode === 'auto' ? s.action.done ?? s.action.hint : s.action.hint;
        for (const line of wrapText(`${label} ${text}`, 76)) process.stdout.write(c.cyan(`   ${line}\n`));
      }
    });
    const sizes = core.demoTrackSizes();
    process.stdout.write(c.dim(`\n${core.demoTrackBlurb(track)}\n`));
    process.stdout.write(
      c.dim(
        `${steps.length} steps · start the session they describe with: oak demo\n` +
          (track === 'everything'
            ? `  the short track is ${sizes.essentials} of these: demo --tour --essentials\n`
            : track === 'essentials'
              ? `  the other ${sizes.remainder}: demo --tour --remainder   ·   all ${sizes.everything}: demo --tour\n`
              : `  all ${sizes.everything} steps: demo --tour\n`)
      )
    );
    return;
  }
  // Keep a running demo inside the fleet's 60s active window while a tour explains it (mtime only —
  // nothing is written, no activity is invented). The editors call this on each step advance.
  if (args.includes('--touch')) {
    const touched = core.demoHeartbeat({ dir: dir || undefined });
    if (json) emitJson({ touched });
    else process.stdout.write(c.dim(`touched ${touched.length} demo transcript(s)\n`));
    return;
  }
  if (args.includes('--clean')) {
    const res = core.cleanDemo({ dir: dir || undefined });
    if (json) {
      emitJson(res);
      return;
    }
    if (!res.sessions.length && !res.workspaces.length && !res.scratch.length) {
      process.stdout.write(c.dim('nothing to remove — no demo recorded for this folder\n'));
      return;
    }
    process.stdout.write(
      c.green('✓ ') +
        `removed ${res.sessions.length} demo session(s)` +
        (res.workspaces.length ? ` and ${res.workspaces.map(relFile).join(', ')}` : '') +
        (res.scratch.length ? ` and ${res.scratch.length} scratch dir(s)` : '') +
        '\n'
    );
    return;
  }
  // `demo --status --json` — does a demo exist for this folder? The editors ask so they can keep
  // offering Exit after session resolution has moved on to a real session.
  if (args.includes('--status')) {
    const sessions = core.demoSessionsFor({ dir: dir || undefined });
    if (json) emitJson({ sessions });
    else process.stdout.write(sessions.length ? `${sessions.length} demo session(s): ${sessions.join(', ')}\n` : 'no demo recorded for this folder\n');
    return;
  }
  const speedRaw = flagValue(args, '--speed');
  const speed = speedRaw ? parseFloat(speedRaw) : undefined;
  let res: Awaited<ReturnType<Core['runDemo']>>;
  try {
    res = await core.runDemo({
      dir: dir || undefined,
      fast: args.includes('--fast'),
      speed,
      fleet: !args.includes('--no-fleet'),
      log: json ? undefined : (line) => process.stdout.write(c.dim(line) + '\n'),
    });
  } catch (e) {
    // A refused `--dir`, a read-only parent, a vanished cwd. These are the user's mistakes to correct,
    // so they get a sentence — never a stack trace.
    fail(e instanceof Error ? e.message : String(e));
  }
  if (json) {
    emitJson(res);
    return;
  }
  process.stdout.write(
    c.green('✓ ') +
      `demo session ${res.session} is live — ${res.edits} pending edits in ${relFile(res.workspace)}` +
      (res.sibling ? ', plus a second agent on demo/hotfix' : '') +
      '\n' +
      c.dim('  guided tour: oak demo --tour   ·   remove every trace: oak demo --clean\n')
  );
}

function parseDuration(spec: string): number | null {
  const m = spec.match(/^(\d+)([dh])$/);
  if (!m) return null;
  return parseInt(m[1], 10) * (m[2] === 'd' ? 86400000 : 3600000);
}
function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function cmdClean(args: string[]): void {
  // Before ANY branch reads its flags: every other scope here deletes sessions outright, and this verb's
  // sink is a recursive rm.
  refuseUnsupportedDryRun(args, 'clean');
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const json = args.includes('--json'); // structured results for front-ends/scripts (sibling to keep/undo)
  // Drop resolved (kept/undone) edits in the active session, keep pending. --under <path> scopes it to
  // a file/folder (the editors' folder/file Clear action).
  if (args.includes('--resolved')) {
    const ui = args.indexOf('--under');
    const underRaw = flagValue(args, "--under");
    if (ui >= 0 && !underRaw) fail('`clean --resolved --under <path>` requires a value');
    const under = underRaw && canonUnder(underRaw); // #43
    // --ids <a,b,c> clears an EXPLICIT edit set — the scope a prompt names, which no path can express
    // (one ask edits many folders). Same resolver both editors use, so neither invents its own scope.
    const idi = args.indexOf('--ids');
    if (idi >= 0) {
      const raw = args[idi + 1];
      if (!raw) fail('`clean --resolved --ids <a,b,c>` requires a comma-separated id list');
      const ids = raw
        .split(',')
        .map((x) => parseInt(x.trim(), 10))
        .filter((n) => Number.isFinite(n));
      if (!ids.length) fail('`clean --resolved --ids <a,b,c>` got no valid integer ids');
      const res = core.clearResolvedIds(getSessionId(args), ids);
      if (json) {
        emitJson({ cleared: res.cleared, ids: res.ids });
        return;
      }
      process.stdout.write(c.green('✓ ') + `cleared ${res.cleared} resolved edit(s)\n`);
      return;
    }
    const n = core.clearResolved(getSessionId(args), under);
    if (json) {
      emitJson({ cleared: n, under: under ?? null });
      return;
    }
    process.stdout.write(c.green('✓ ') + `cleared ${n} resolved edit(s)${under ? ` under ${relFile(under)}` : ''}\n`);
    return;
  }
  // Destructive: drop a specific session.
  const di = args.indexOf('--drop');
  if (di >= 0) {
    const id = args[di + 1];
    if (!id) fail('`--drop <session-id>` requires a session id');
    if (!core.isSafeSessionId(id)) fail(`invalid session id "${id}" — refusing to delete.`);
    core.removeSession(id);
    if (json) {
      emitJson({ dropped: [id] });
      return;
    }
    process.stdout.write(c.green('✓ ') + `dropped session ${id}\n`);
    return;
  }
  // Repair (issue #43): drop Windows drive-letter-case phantom pairs — a pending create + delete twin
  // for one file under two cases, both capture artifacts. Provable pairs only; real work is never touched.
  if (args.includes('--phantoms')) {
    const sess = flagValue(args, '--session') ?? core.resolveSessionId(process.cwd());
    if (!sess) fail('no session resolved — pass --session <id>');
    const r = core.repairCasePhantoms(sess);
    if (json) {
      emitJson({ session: sess, pairs: r.pairs, ids: r.ids });
      return;
    }
    process.stdout.write(
      r.pairs
        ? c.green('✓ ') + `removed ${r.pairs} phantom pair(s) (${r.ids.length} records) from ${sess}\n`
        : `no phantom pairs found in ${sess} — nothing changed\n`
    );
    return;
  }
  // Destructive: drop every session whose review is finished — nothing pending, conversation over.
  if (args.includes('--completed')) {
    // `--stale <Nd>` moves the ABANDONED threshold only; a session with nothing left to review is
    // reaped on the (much shorter) quiet clock regardless.
    const si2 = args.indexOf('--stale');
    const staleSpec = si2 >= 0 ? args[si2 + 1] : null;
    if (si2 >= 0 && !staleSpec) fail('`clean --completed --stale <Nd>` requires a duration');
    const staleMs = staleSpec ? parseDuration(staleSpec) : null;
    if (staleSpec && staleMs === null) fail(`bad --stale value "${staleSpec}" (use e.g. 14d or 36h)`);
    // A FLOOR, because this is the branch that discards edits nobody reviewed. The `finished` branch is
    // protected by the fixed 24h quiet clock; without the same floor here, `--stale 0d` reaps every
    // workspace-local session that has unreviewed work the moment it is typed, with no confirmation and
    // nothing to undo it. Anyone who genuinely wants that can pass --stale 1d and lose only a day.
    if (staleMs !== null && staleMs < core.REAP_QUIET_MS)
      fail(`--stale must be at least 24h — it discards unreviewed edits (got "${staleSpec}")`);
    // `--dry-run` answers "what WOULD go" without going. It exists because this verb discards
    // unreviewed edits and, until now, the only way to find out what it would take was to run it. The
    // JetBrains dialog uses it to state the counts and names before asking, which is what the VS Code
    // dialog always did by calling core in-process.
    const dry = args.includes('--dry-run');
    const doomed = core.reapableSessions(process.cwd(), Date.now(), staleMs ?? undefined);
    if (!dry) for (const s of doomed) core.removeSession(s.id);
    if (json) {
      emitJson({ dropped: dry ? [] : doomed.map((s) => s.id), sessions: doomed, dryRun: dry });
      return;
    }
    if (doomed.length === 0) {
      // Say WHY there is nothing, and distinguish "the rails spared everything" from "this directory has
      // no sessions at all" — running it from a subdirectory hits the second and read like the first.
      const anyHere = core.sessionMeta(process.cwd()).sessions.length > 0;
      process.stdout.write(
        anyHere
          ? 'No sessions to clear — every other one is live, has edits still under review, or is too recent.\n'
          : `No sessions recorded for ${process.cwd()} — run this from the directory Claude Code was started in.\n`
      );
      return;
    }
    if (dry) {
      const fin0 = doomed.filter((s) => s.reason === 'finished').length;
      const ab0 = doomed.filter((s) => s.reason === 'abandoned');
      process.stdout.write(
        `would clear ${doomed.length} session(s): ${fin0} finished` +
          (ab0.length ? `, ${ab0.length} abandoned (${ab0.reduce((n, s) => n + s.pending, 0)} unreviewed edit(s) would be discarded)` : '') +
          '\n'
      );
      return;
    }
    const fin = doomed.filter((s) => s.reason === 'finished').length;
    const aband = doomed.filter((s) => s.reason === 'abandoned');
    const lost = aband.reduce((n, s) => n + s.pending, 0);
    process.stdout.write(
      c.green('✓ ') +
        `cleared ${doomed.length} session(s): ${fin} finished` +
        (aband.length ? `, ${aband.length} abandoned (${lost} unreviewed edit(s) discarded)` : '') +
        '\n'
    );
    return;
  }
  // Destructive: drop sessions inactive longer than N.
  const oi = args.indexOf('--older-than');
  if (oi >= 0) {
    const spec = args[oi + 1];
    const ms = spec ? parseDuration(spec) : null;
    if (ms === null) fail(`bad --older-than value "${spec ?? ''}" (use e.g. 30d or 12h)`);
    // `lastMs` is the STORE LOG's mtime, so a long-running conversation that made its edits early
    // looks ancient by this clock — and this verb's sink is a recursive delete. Excluding the session
    // the user is actually in costs one resolve and removes the only way this can eat live data.
    const live = (() => {
      try {
        return core.resolveSessionId(process.cwd());
      } catch {
        return null;
      }
    })();
    const stale = core.listSessions().filter((s) => s.lastMs < Date.now() - ms && s.id !== live);
    for (const s of stale) core.removeSession(s.id);
    if (json) {
      emitJson({ dropped: stale.map((s) => s.id), olderThan: spec });
      return;
    }
    process.stdout.write(c.green('✓ ') + `dropped ${stale.length} session(s) inactive > ${spec}\n`);
    return;
  }
  // Destructive: drop everything.
  if (args.includes('--all')) {
    const all = core.listSessions();
    for (const s of all) core.removeSession(s.id);
    if (json) {
      emitJson({ dropped: all.map((s) => s.id) });
      return;
    }
    process.stdout.write(c.green('✓ ') + `dropped all ${all.length} session(s)\n`);
    return;
  }
  // Safe default: garbage-collect orphaned blobs (optionally scoped to --session <id>), then
  // reclaim stub-session husks — dirs with no log that hold only Bash-walk snapshots. Iterates the
  // store root directly: listSessions skips log-less dirs, which made stubs unreclaimable.
  const si = args.indexOf('--session');
  const only = flagValue(args, '--session');
  // A missing value used to widen the scope from ONE session to the whole store — and this verb's sink
  // is pruneEmptySession → removeSession → recursive rm. Scope-widening on a typo is not a default.
  if (si >= 0 && !only) fail('`clean --session <id>` requires a session id');
  if (only && !core.isSafeSessionId(only)) fail(`invalid session id: ${JSON.stringify(only)}`);
  const targets = only ? [only] : core.allStoreSessionIds();
  let removed = 0;
  let bytes = 0;
  let pruned = 0;
  let maps = 0;
  let cursors = 0;
  if (!only) {
    const normalized = core.pruneCodexDerivedCache();
    bytes += normalized.bytes;
    // Blind spots the store-id loop below cannot see (all three found live on a real store):
    // 1. Cache dirs for sessions with NO store dir — version-bump orphans survive there forever, since
    //    nothing else visits them. Superseded VERSIONS only: a live-version cache for a transcript-only
    //    session is a working cache, not garbage.
    const storeIds = new Set(targets);
    for (const id of core.cachedMapSessionIds()) {
      if (storeIds.has(id)) continue; // the main loop prunes these
      const m = core.pruneStaleMaps(id);
      maps += m.removed;
      bytes += m.bytes;
    }
    // 2. Usage cursors whose transcript is gone (hash-keyed, unreachable from any session id).
    const uc = core.reapUsageCursors();
    cursors = uc.removed;
    bytes += uc.bytes;
    // 3. blob-memo.json: written only by an uncommitted 0.8.6-era build — no released version ever read
    //    it. 3.7MB of nothing with no owner; this is the only place that can know to drop it.
    try {
      const fs = require('fs') as typeof import('fs');
      const bm = require('path').join(core.rootDir(), 'blob-memo.json') as string;
      const st = fs.statSync(bm);
      fs.rmSync(bm, { force: true });
      bytes += st.size;
    } catch {
      /* absent on any store that never ran that build */
    }
  }
  for (const id of targets) {
    const r = core.gcSession(id);
    removed += r.removed;
    bytes += r.bytes;
    // Cached map payloads from an earlier cache version are unreachable but never overwritten, because
    // the version is part of the filename. The GC is where they get collected.
    const m = core.pruneStaleMaps(id);
    maps += m.removed;
    bytes += m.bytes;
    if (core.pruneEmptySession(id)) pruned++;
  }
  if (json) {
    emitJson({ removed, bytes, pruned, staleMaps: maps, cursors });
    return;
  }
  process.stdout.write(
    c.green('✓ ') +
      `garbage-collected ${removed} orphaned blob(s), freed ${fmtBytes(bytes)}` +
      (maps ? `, dropped ${maps} superseded cache file(s)` : '') +
      (cursors ? `, reaped ${cursors} orphaned usage cursor(s)` : '') +
      (pruned ? `, pruned ${pruned} empty stub session(s)` : '') +
      '\n'
  );
}

function human(n: number): string {
  if (!Number.isFinite(n)) return '0'; // never render "NaNB" for a malformed metric
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'k';
  if (n < 1e9) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  return (n / 1e9).toFixed(2) + 'B';
}

function cmdStats(args: string[]): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  let sid: string | undefined;
  const i = args.indexOf('--session');
  if (i >= 0 && args[i + 1]) {
    sid = args[i + 1];
    // Guard a user-provided id like getSessionId does — computeStats derives a store path from it.
    if (!core.isSafeSessionId(sid)) fail(`invalid session id "${sid}" (letters, digits, dot, dash, underscore only).`);
  } else sid = core.resolveSessionId(process.cwd()) || undefined; // no session → global/default window
  const stats = core.computeStats(sid);
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(stats));
    return;
  }
  const w = stats.windows;
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(1, n - s.length));
  const metrics: [string, keyof StatMetrics][] = [
    ['edits', 'edits'],
    ['tokens', 'tokens'],
    ['messages', 'messages'],
    ['thinking', 'thinking'],
    ['output', 'output'],
  ];
  process.stdout.write(c.bold('Claude usage stats') + c.dim('   session · today · 7 days · 30 days\n\n'));
  process.stdout.write(c.dim(pad('', 11) + pad('session', 10) + pad('today', 10) + pad('7d', 10) + '30d\n'));
  for (const [label, key] of metrics) {
    process.stdout.write(
      pad(label, 11) +
        pad(human(w.session[key]), 10) +
        pad(human(w.day[key]), 10) +
        pad(human(w.week[key]), 10) +
        human(w.month[key]) +
        '\n'
    );
  }
  process.stdout.write(c.dim('\nthinking tokens are estimated (~chars/4); tokens include cache.\n'));
}

/** `summary` — a per-session review recap (kept/reverted per file + acceptance rate); --markdown to export. */
/** `export` — the FULL session trace: everything the observatory recorded for one session (the edit
 *  log with per-edit deltas and unified diffs, capture skips, prompts, every action, tasks,
 *  subagents, egress, outside-workspace writes, observations, token usage, and the change-map
 *  summary) as ONE JSON document. Core composes it (`buildSessionTrace`), so the CLI and both
 *  editors export the identical thing. `--out <file>` writes it; otherwise it prints to stdout. */
function cmdExport(args: string[]): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const fs = require('fs');
  const path = require('path');
  const session = getSessionId(args);
  const ri = args.indexOf('--root');
  const root = flagValue(args, '--root');
  if (ri >= 0 && !root) fail('`export --root <path>` requires a value');
  const oi = args.indexOf('--out');
  const out = flagValue(args, '--out');
  if (oi >= 0 && !out) fail('`export --out <file>` requires a value');
  const trace = core.buildSessionTrace(process.cwd(), session, { root: root ?? process.cwd(), toolVersion: version() });
  const body = JSON.stringify(trace, null, 2) + '\n';
  if (out) {
    fs.writeFileSync(out, body);
    process.stdout.write(
      c.green('✓ ') +
        `wrote the full session trace to ${relFile(path.resolve(out))} ` +
        `(${trace.edits.length} edit(s), ${trace.actions?.length ?? 0} action(s))\n`
    );
  } else {
    process.stdout.write(body);
  }
  if (trace.errors.length)
    process.stderr.write(c.yellow('⚠ ') + `sections that failed to build: ${trace.errors.join(', ')}\n`);
}

function cmdSummary(args: string[]): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const session = getSessionId(args);
  const s = core.reviewSummary(session);
  if (args.includes('--json')) {
    emitJson(s);
    return;
  }
  if (args.includes('--markdown') || args.includes('--md')) {
    process.stdout.write(core.reviewSummaryMarkdown(s));
    return;
  }
  const pct = s.acceptanceRate === null ? '—' : `${Math.round(s.acceptanceRate * 100)}%`;
  process.stdout.write(
    c.bold('Review summary') +
      c.dim(`  session ${session}\n\n`) +
      `${s.total} edit(s) · ${c.yellow(s.pending + ' pending')} · ${c.green(s.kept + ' kept')} · ` +
      `${c.dim(s.undone + ' reverted')} · ${pct} accepted\n\n`
  );
  for (const f of s.files) {
    process.stdout.write(
      `  ${c.cyan(relFile(f.file))}  ${c.green('+' + f.added)} ${c.red('-' + f.removed)}  ` +
        `${c.dim(`${f.kept} kept · ${f.undone} reverted · ${f.pending} pending`)}\n`
    );
  }
  if (s.reverted.length) {
    process.stdout.write('\n' + c.dim('reverted: ') + s.reverted.map((r) => '#' + r.id).join(' ') + '\n');
  }
  process.stdout.write(c.dim('\nexport:  oak summary --markdown > review.md\n'));
  process.stdout.write(c.dim('         oak export --out trace.json   (the full session trace)\n'));
}

// --- machine-readable commands for non-Node front-ends (JetBrains plugin, scripts) ---

/** Raw blob bytes to stdout (diff panes, chat prompts). */
function cmdBlob(args: string[]): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const session = getSessionId(args);
  const sha = args.find((a) => /^[0-9a-f]{64}$/i.test(a));
  if (!sha) fail('expected a 64-hex blob sha, e.g. `oak blob <sha>`');
  try {
    process.stdout.write(core.readBlob(session, sha));
  } catch {
    fail(`no blob ${sha} in session ${session}`);
  }
}

/**
 * `ignore` — what `.observatoryignore` is doing, and why.
 *
 * With no arguments: the files in play and what they hide in this session. With `--check <path>`:
 * the one rule that decided, named by file and line.
 *
 * This verb is the difference between a filter you can debug and a filter you have to guess at. A
 * gitignore-shaped file has real gotchas — an excluded parent beats a later negation, `dist/` is not
 * `dist` — and a reader who cannot see WHICH line hid their file has no way to tell a working rule
 * from a typo.
 */
function cmdIgnore(args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const json = args.includes('--json');
  const cwd = process.cwd();
  const verbose = args.includes('-v') || args.includes('--verbose');
  const nonMatching = args.includes('-n') || args.includes('--non-matching');
  const quiet = args.includes('-q') || args.includes('--quiet');
  const nulSep = args.includes('-z');
  const stdin = args.includes('--stdin');

  // Paths come from --check (repeatable), from --stdin, or as bare operands after --check.
  const flags = new Set(['-v', '--verbose', '-n', '--non-matching', '-q', '--quiet', '-z', '--stdin', '--json']);
  const targets: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') {
      // Everything after --check that is not itself a flag is a path, so `--check a b c` works the
      // way `git check-ignore a b c` does.
      for (let j = i + 1; j < args.length && !args[j].startsWith('-'); j++) targets.push(args[j]);
    } else if (args[i] === '--session') {
      i++; // its value, never a path
    }
  }
  if (stdin) {
    let raw = '';
    try {
      raw = fs.readFileSync(0, 'utf8');
    } catch {
      fail('ignore --stdin could not read standard input');
    }
    for (const line of raw.split(nulSep ? '\0' : '\n')) if (line.trim()) targets.push(line.trim());
  }
  void flags;

  // `--stdin` asks about paths; with none read it answers that none is ignored (exit 1, as git
  // check-ignore does), never falling through to the sweep below, which drops the session's records.
  if (targets.length || stdin) {
    if (quiet && targets.length > 1) fail('`ignore -q` takes a single path (same rule as `git check-ignore -q`)');
    const abs = targets.map((t) => path.resolve(cwd, t));
    const ctx = core.ignoreContextFor(abs);
    const rows = abs.map((a, i) => {
      let isDir = false;
      try {
        isDir = fs.statSync(a).isDirectory();
      } catch {
        /* a path that does not exist yet is still a fair question — treat it as a file */
      }
      const d = ctx.decide(a, isDir);
      return { given: targets[i], abs: a, d, mode: d.ignored ? 'ignored' : 'shown' };
    });
    const anyIgnored = rows.some((r) => r.d.ignored);

    if (json) {
      emitJson({
        paths: rows.map((r) => ({
          path: r.abs,
          mode: r.mode,
          rule: r.d.rule && {
            pattern: r.d.rule.pattern,
            source: r.d.rule.source,
            line: r.d.rule.line,
            negated: r.d.rule.negated,
          },
          matched: r.d.matched,
        })),
        files: ctx.files,
      });
      process.exit(anyIgnored ? 0 : 1);
    }
    if (quiet) process.exit(anyIgnored ? 0 : 1);

    // `-v` is git's machine-readable shape, byte for byte: <source>:<linenum>:<pattern><TAB><pathname>,
    // with every field but the pathname empty for a non-match, and NULs replacing the separators under
    // `-z`. Anything that already parses `git check-ignore -v` parses this.
    if (verbose) {
      for (const r of rows) {
        const matched = r.d.rule;
        if (!matched && !nonMatching) continue;
        const src = matched ? core.relPath(cwd, matched.source) : '';
        const ln = matched ? String(matched.line) : '';
        const pat = matched ? matched.pattern : '';
        process.stdout.write(
          nulSep
            ? `${src}\0${ln}\0${pat}\0${r.given}\0`
            : `${src}:${ln}:${pat}\t${r.given}\n`
        );
      }
      process.exit(anyIgnored ? 0 : 1);
    }

    // More than one path (or none, from an empty --stdin): one line each, like git's default. The
    // rich explanation below is for the single-path case, where there is room to say WHY.
    if (rows.length !== 1) {
      for (const r of rows) {
        if (!r.d.ignored && !nonMatching) continue;
        const tag = r.d.ignored ? c.yellow('ignored') : c.green('shown  ');
        process.stdout.write(`${tag} ${r.given}\n`);
      }
      process.exit(anyIgnored ? 0 : 1);
    }

    const r = rows[0];
    for (const why of core.ignoreProblems()) process.stdout.write(`${c.red('!')} ${why}\n`);
    const rel = core.relPath(cwd, r.abs);
    if (!r.d.ignored) {
      process.stdout.write(`${c.green('shown')}  ${rel}\n`);
      // A negation that matched is worth naming even though the answer is "not ignored" — it is the
      // rule doing the work, and git's `-v` reports it for the same reason.
      if (r.d.rule?.negated) {
        process.stdout.write(
          `  re-included by  ${r.d.rule.pattern}   (${core.relPath(cwd, r.d.rule.source)}:${r.d.rule.line})\n`
        );
      } else {
        process.stdout.write(
          ctx.files.length
            ? `  no rule in ${ctx.files.length} ignore file(s) matches it\n`
            : `  no .observatoryignore governs it\n`
        );
      }
      process.exit(1);
    }
    process.stdout.write(`${c.yellow('ignored')} ${rel}\n`);
    process.stdout.write(
      `  by  ${r.d.rule?.pattern}   (${core.relPath(cwd, r.d.rule?.source ?? '')}:${r.d.rule?.line})\n`
    );
    // The excluded-ANCESTOR case is the gotcha worth spelling out: the reader wrote a negation for
    // this exact file and it did not take, because git's rule (which this follows) never descends
    // into an excluded directory. Saying so beats leaving them to rediscover it.
    if (r.d.matched && r.d.matched !== r.abs.replace(/\\/g, '/')) {
      const dir = path.basename(r.d.matched);
      process.stdout.write(
        `  its ANCESTOR ${c.cyan(core.relPath(cwd, r.d.matched))} is excluded, and a later "!" rule\n` +
          `  cannot re-include anything beneath an excluded directory (same as .gitignore).\n` +
          `  Exclude the CONTENTS instead — "${dir}/*" — then negate.\n`
      );
    }
    process.stdout.write(`  edits to it are never recorded — there is nothing to undo later\n`);
    process.exit(0);
  }

  const session = getSessionId(args);
  const edits = core.reviewEdits(session);
  // Runs the sweep, rather than only reporting one. A rule normally takes effect at the next capture;
  // a reader who has just written one and made no further edits would otherwise be told what the file
  // says while the records it covers were still in the store. Doing it here is safe — this is a
  // command someone typed, not a refresh — and it does nothing at all when nothing matches.
  const swept = core.dropIgnored(session);
  // The files governing the SESSION'S edits, plus the ones governing the directory the reader is
  // standing in. Without the second, a fresh workspace with a brand-new .observatoryignore and no
  // captured edits yet reported "no .observatoryignore in play" while the file sat in plain sight —
  // the verb answered about the session when the reader was asking about the file.
  const here = core.ignoreContextFor([path.join(cwd, 'x')]);
  const mine = core.ignoreContextFor(edits.map((e: EditRecord) => e.file));
  const sources = [...new Set([...mine.files, ...here.files])].sort();
  const total = core.readSweep(session);
  if (json) {
    emitJson({
      session,
      files: sources,
      recorded: core.reviewEdits(session).length,
      droppedNow: swept.dropped,
      droppedFiles: swept.files,
      droppedTotal: total?.dropped ?? 0,
    });
    return;
  }
  if (!sources.length) {
    process.stdout.write('no .observatoryignore in play\n');
    process.stdout.write(`  create one beside your code, ${core.REPO_PRIVATE_IGNORE} for rules you do not want to commit,\n`);
    process.stdout.write(`  or ${core.homeIgnorePath()} for personal rules that follow you everywhere.\n`);
    process.stdout.write('  .gitignore syntax. Anything it matches is never recorded — not listed, not counted, not revertible.\n');
    return;
  }
  process.stdout.write(`ignore files (nearest wins):\n`);
  for (const f of sources) process.stdout.write(`  ${core.relPath(cwd, f)}\n`);
  process.stdout.write(`\n${core.reviewEdits(session).length} edit(s) recorded in this session\n`);
  process.stdout.write('  anything these rules match is never recorded — not listed, not counted, not revertible.\n');
  process.stdout.write('  Use `--check <path>` to see which rule decides a path.\n');
  // Said out loud, every time, because it is the one operation here that destroys data. A count that
  // only ever appeared in a log nobody reads would make "I added a rule and my history vanished" a
  // mystery rather than a fact the tool already told you.
  if (swept.dropped) {
    process.stdout.write(
      `\n${c.yellow('dropped')} ${swept.dropped} already-recorded edit(s) across ${swept.files.length} file(s) that these rules now cover:\n`
    );
    for (const f of swept.files.slice(0, 10)) process.stdout.write(`  ${core.relPath(cwd, f)}\n`);
    if (swept.files.length > 10) process.stdout.write(`  … and ${swept.files.length - 10} more\n`);
  } else if (total?.dropped) {
    process.stdout.write(`\n${total.dropped} edit(s) across ${total.files} file(s) have been dropped by these rules so far.\n`);
  }
  reportDeadRules(core, cwd, sources);
  // A file that EXISTS but could not be read is not the same as no file. Under one mode it fails in
  // the SAFE direction — its rules are not in force, so MORE is captured, not less — but a reader who
  // thinks a path is excluded and finds it recorded deserves to be told which file went silent.
  for (const why of core.ignoreProblems()) process.stdout.write(`\n${c.red('!')} ${why}\n`);
}

/**
 * Rules that can never fire.
 *
 * `git check-ignore -v` names the rule that WON and never mentions that the line you actually wrote
 * is dead code: given `dist/` then `!dist/manifest.json`, it reports `dist/` and says nothing about
 * line 2. That specific confusion is one of the most-asked questions about this file format, and the
 * matcher already knows the answer — so it says so unprompted rather than waiting to be asked about
 * one path at a time.
 */
function reportDeadRules(core: Core, cwd: string, sources: readonly string[]): void {
  if (!sources.length) return;
  // A path INSIDE each ignore file's directory, which is what primes the layer that file contributes.
  const probes = sources.map((f) => f.replace(/[^/\\]+$/, '') + 'x');
  const dead = core.deadRules(core.ignoreContextFor(probes));
  if (!dead.length) return;
  process.stdout.write(`\n${c.yellow(String(dead.length))} rule(s) can never match:\n`);
  for (const d of dead) {
    process.stdout.write(
      `  ${d.rule.pattern}   (${core.relPath(cwd, d.rule.source)}:${d.rule.line})\n` +
        `    "${d.shadowedBy.pattern}" on line ${d.shadowedBy.line} excludes ${d.under}/, and nothing beneath an\n` +
        `    excluded directory is ever consulted. Write "${d.fix}" there instead, then negate.\n`
    );
  }
}

/** Current line indices of every pending edit in a file, mapped into the LIVE buffer text supplied
 *  on stdin (which may be unsaved). Powers inline overlays; always emits JSON. */
function cmdLocate(args: string[]): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const path = require('path');
  const fs = require('fs');
  const session = getSessionId(args);
  const fi = args.indexOf('--file');
  const file = flagValue(args, '--file');
  if (!file) fail('`locate --file <path>` is required (current buffer text on stdin)');
  const abs = core.canonPath(path.resolve(file)); // #43: both editors pass editor-cased paths
  let current: string;
  try {
    current = fs.readFileSync(0, 'utf8'); // stdin
  } catch {
    fail('locate reads the current buffer on stdin, e.g. `oak locate --file f.ts < f.ts`');
  }
  // readLog is chronological and .filter keeps that order — which is what lets locateEditsInCurrent
  // compose one-edit-wide hops instead of re-aligning the whole buffer once per edit.
  const recs = core.readLog(session).filter((r) => r.status === 'pending' && r.file === abs);
  const blob = (sha: string | null): string => (sha ? core.readBlob(session, sha).toString('utf8') : '');
  const placed = core.locateEditsInCurrent(
    recs.length,
    (i) => ({ before: blob(recs[i].beforeBlob), after: blob(recs[i].afterBlob) }),
    current
  );
  // `removed` rides along for free now that one pass computes both — JetBrains renders no deletion
  // ghost text today only because this payload never carried it.
  //
  // `delta` spares a renderer a second round trip for the "+A −R" a lens shows. It is NOT free: lineDelta
  // is one whole-file diff per record, memoized only in-process, and JetBrains reaches locate by SPAWNING
  // (once per file, after the buffer settles) so it always starts cold. Bound it to the placements that
  // will actually render — a superseded edit in a long chain places nothing, so nothing reads its delta,
  // and on a heavily-chained file that is most of them.
  const placements = recs.map((r, i) => {
    const p = placed[i];
    const renders = p.lines.length > 0 || p.removed.length > 0;
    return { id: r.id, lines: p.lines, removed: p.removed, ...(renders ? { delta: core.lineDelta(session, r) } : {}) };
  });
  emitJson({ file: abs, placements });
}

/** The full folder→file→class→edit tree (with exact deltas) — the shared view-model for both editors. */
function cmdTree(args: string[]): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const session = getSessionId(args);
  const ri = args.indexOf('--root');
  const root = flagValue(args, '--root') ?? process.cwd();
  const fi = args.indexOf('--filter');
  const filter = flagValue(args, '--filter');
  if (args.indexOf('--filter') >= 0 && !filter) fail('`tree --filter <substr>` requires a value');
  // `hiddenIds` rides along, independent of `--filter`: the JetBrains plugin derives its status bar,
  // its File/Diff/Folder axes and its project-view badges from the raw store, and without this it had
  // no way to agree with the tree it renders beside them.
  emitJson({ ...core.buildEditTree(session, { root, filter }), hiddenIds: [...core.cancelledMemberIds(session)].sort((a, b) => a - b) });
}

/** The session change-map: edits placed as module→file→class + strict per-task rollups, for the map webview.
 *  0.8.0 additive keys (removing nothing): the base build already carries per-edit `taskId` (strict
 *  spans) + `rollupByTask`/`rollupBySubagent`; this adds `rollupByAgent`, an `agents[]` array of a
 *  per-sibling change-map for every worktree of this repo (aggregated HERE — renderers stay thin), and
 *  the explicit `unassigned` task bucket (§3/§5). */
/**
 * Several read-only views in ONE process.
 *
 * The JetBrains plugin is a thin renderer with no way to call core in-process the way the VS Code
 * extension does, so it spawned one CLI per view — eight of them, every three-second tick. Two costs
 * follow, and only the first is obvious:
 *   · ~70 ms of node start-up per spawn before any work at all — measured, and paid eight times over;
 *   · every process re-derives the SAME transcript and log parses from cold, because core's memoization
 *     (`cachedByFiles`) dies with the process that holds it.
 * Run together they share those parses, which is the larger of the two savings.
 *
 * Each view is produced by CALLING ITS OWN COMMAND and capturing what it writes, so a batched payload is
 * byte-identical to the single-command one by construction — there is no second implementation to drift.
 * A view that fails is `null` rather than fatal: one unbuildable section must not cost the reader the
 * other seven, and `fail()`'s `process.exit` is caught for the same reason.
 */
function cmdViews(args: string[]): void {
  const vi = args.indexOf('--views');
  const DEFAULT = 'changemap,multitask,prompts,processes,sessions,observations,risk,egress';
  if (vi >= 0 && !flagValue(args, '--views')) fail('`views --views <a,b,c>` requires a comma-separated list');
  // SERVE mode (perf, 2026-08-19): one long-lived process answers view batches over stdin — one JSON
  // request line in ({views, args}), one JSON payload line out. The cold-spawn-per-poll design cost
  // 2.9s per batch on a 39 MB session (measured): node start + SIX transcript parses + the store's
  // blob diffs, re-derived from zero every 3 seconds because every in-process memo died with the
  // process. Warm, the same batch is ~60 ms — fscache revalidates every lookup by stat, so a
  // long-lived host serves exactly the same answers (that contract is what the VS Code extension
  // already relies on). The dashboard keeps a cold-spawn fallback for a serve child that dies.
  if (args.includes('--serve')) return serveViews();
  const names = (flagValue(args, '--views') ?? DEFAULT)
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  // Drop OUR selector, and only ours. `indexOf` returns -1 when `--views` is absent, and filtering on
  // `i !== vi + 1` then quietly removes argument ZERO — which is `--session`. Every view resolved the
  // newest session for the cwd instead of the one asked for, and the payloads looked plausible while
  // describing the wrong session entirely.
  const rest = vi >= 0 ? args.filter((_, i) => i !== vi && i !== vi + 1) : args;
  const viewArgs = rest.includes('--json') ? rest : [...rest, '--json'];
  emitJson(buildViews(names, viewArgs));
}

/** One batch of views as a value — the shared engine of `views` (one shot) and `views --serve`. */
function buildViews(names: string[], viewArgs: string[]): Record<string, unknown> {
  const core = require('@oak-observatory/core') as Core;
  return core.withDerivedInventory(() => {
    const out: Record<string, unknown> = {};
    /** view -> why it is null. Emitted as `__problems` so a null can never pass for an empty answer. */
    const problems: Record<string, string> = {};
    const realWrite = process.stdout.write.bind(process.stdout);
    const realExit = process.exit.bind(process);
    for (const name of names) {
      let buf = '';
      (process.stdout as unknown as { write: (s: string) => boolean }).write = (chunk: string) => {
        buf += chunk;
        return true;
      };
      (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
        throw new Error(`view ${name} exited ${code ?? 0}`);
      }) as (code?: number) => never;
      try {
        runView(name, viewArgs);
        out[name] = buf ? JSON.parse(buf) : null;
        if (out[name] === null) problems[name] = 'produced no output';
      } catch (e) {
        // A per-view failure used to become a bare `null`, indistinguishable from "this view is
        // legitimately empty" — so an unreadable store (EACCES on log.jsonl, a mounted volume, a
        // permissions repair) rendered as zeros with the status bar saying "ready". The view still
        // resolves to null so one broken view cannot blank the other seven, but the REASON now rides
        // alongside, and the dashboard raises it.
        out[name] = null;
        problems[name] = String((e as Error)?.message || e);
      } finally {
        (process.stdout as unknown as { write: typeof realWrite }).write = realWrite;
        (process as unknown as { exit: typeof realExit }).exit = realExit;
      }
    }
    if (Object.keys(problems).length) out.__problems = problems;
    // An ignore file that exists but cannot be read stops applying — including its `# capture: off`
    // rules — and the matcher that discovers this runs HERE, in the child. The dashboard read its own
    // (always empty) copy, so the report was inert on the one surface most likely to see it.
    const igProblems = (require('@oak-observatory/core') as Core).ignoreProblems();
    if (igProblems.length) out.__ignoreProblems = igProblems;
    return out;
  });
}

/** The `views --serve` loop: newline-delimited JSON requests on stdin, one payload line per request
 *  on stdout. Stray writes from a view can never corrupt the protocol — the batch runs with stdout
 *  captured (buildViews already redirects per view), and the response goes out through the REAL
 *  writer in one piece. A malformed request answers with `__fatal` instead of dying: the dashboard
 *  owns the child's lifecycle, and a silent exit would read as a hang. stdin closing ends the serve. */
function serveViews(): void {
  const realWrite = process.stdout.write.bind(process.stdout);
  const rl = require('readline').createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line: string) => {
    let payload: Record<string, unknown>;
    try {
      const req = JSON.parse(line) as { views?: unknown; args?: unknown };
      const names = Array.isArray(req.views) ? req.views.map(String) : [];
      const reqArgs = Array.isArray(req.args) ? req.args.map(String) : [];
      if (!names.length) throw new Error('request carries no views');
      payload = buildViews(names, reqArgs.includes('--json') ? reqArgs : [...reqArgs, '--json']);
    } catch (e) {
      payload = { __fatal: String((e as Error)?.message || e) };
    }
    // This worker's resident size leads every answer, where the dashboard reads it without parsing the
    // payload, to retire a worker grown too big. Asking `ps` instead spawned one every 5 s per worker
    // wherever /proc is absent (macOS), and Windows had no probe at all.
    realWrite(JSON.stringify({ __rss: process.memoryUsage.rss(), ...payload }) + '\n');
  });
  rl.on('close', () => process.exit(0));
}

/** The views `views` may batch. An allow-list on purpose: nothing that MUTATES belongs in a poll.
 *
 *  One caveat every caller inherits: `views` hands the SAME argument list to every view in the batch,
 *  so a batch can carry only one `--kind`/`--id` between them. That is why `feed` is usable here at
 *  all — a caller shows one feed subject at a time — and why a batch wanting two different feeds must
 *  make two calls. */
function runView(name: string, args: string[]): void {
  switch (name) {
    case 'integrity':
      return cmdIntegrity(args);
    case 'changemap':
      return cmdChangeMap(args);
    // Both read-only, and both were missing: asking for them fell through to the throw below, which
    // `cmdViews` swallows into a null view. A caller following the "just batch it" advice therefore
    // got a silently empty pane rather than an error.
    case 'feed':
      return cmdFeed(args);
    case 'conversation':
      return cmdConversation(args);
    // Read-only too: the TUI's warm worker renders a conversation's edit previews through it (with `--json`,
    // the patch `diff <id> --patch` prints) instead of a cold `oak diff` per edit.
    case 'diff':
      return cmdDiff(args);
    case 'list':
      return cmdList(args);
    case 'multitask':
      return cmdMultitask(args);
    case 'prompts':
      return cmdPrompts(args);
    case 'processes':
      return cmdProcesses(args);
    case 'sessions':
      return cmdSessions(args);
    case 'observations':
      return cmdObservations(args);
    case 'risk':
      return cmdRisk(args);
    case 'egress':
      return cmdEgress(args);
    case 'stats':
      return cmdStats(args);
    default:
      throw new Error(`unknown view ${name}`);
  }
}

function cmdChangeMap(args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  const session = getSessionId(args);
  const ri = args.indexOf('--root');
  const root = flagValue(args, '--root') ?? process.cwd();
  // The composition lives in core (`overviewChangeMap`) so the VS Code extension — which bundles core
  // and calls it in-process everywhere else — can have this payload WITHOUT spawning a node process for
  // it. Two copies of fifty lines of sibling projection is how the front-ends stop agreeing.
  // `root` for BOTH: it is already the resolved workspace, and passing `process.cwd()` here meant the
  // transcript lookup used the terminal's directory while the "outside the workspace" boundary used
  // the caller's — two different answers to "which workspace is this" inside one call.
  emitJson(core.overviewChangeMap(root, session, { root }));
}


/** `chat-context` (§2.6/§7) — the zero-token chat handoff: assemble a ready-to-paste prompt about one
 *  action (`--tool-use-id`)/edit (`--edit`)/subagent (`--agent`)/task (`--task`), built in core (the
 *  single backend both editors call). Always JSON `{ prompt }`. NEVER spawns a process or calls a model. */
function cmdChatContext(args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  const session = getSessionId(args);
  const ref: { toolUseId?: string; editId?: number; agentId?: string; taskId?: string } = {};
  const tu = flagValue(args, '--tool-use-id');
  if (tu) ref.toolUseId = tu;
  const ed = flagValue(args, '--edit');
  if (ed && /^\d+$/.test(ed)) ref.editId = parseInt(ed, 10);
  const ag = flagValue(args, '--agent');
  if (ag) ref.agentId = ag;
  const tk = flagValue(args, '--task');
  if (tk) ref.taskId = tk;
  emitJson({ prompt: core.assembleChatContext(process.cwd(), session, ref) });
}

type Core = typeof import('@oak-observatory/core');

/** Build the Observations payload (recap + per-edit reasoning/flags/memory) once — shared by the
 *  machine `observe --json` surface and the human `insights` view. */
function buildObserve(core: Core, session: string, cwd: string) {
  const log = core.readLog(session);
  const reasoning = core.reasoningByEdit(cwd, session);
  const insights = core.transcriptInsights(cwd, session);
  // Core owns the recap definition now (analysis > auto-title > last summary, with its source), so the
  // CLI and both editors can no longer disagree about what "recap" means. Reading it through `recapOf`
  // rather than building the whole Observations model keeps that single definition while skipping the
  // per-edit reasoning/flags/memory walk the model also does — ~0.8 s of a 5.9 s `observe --json` on a
  // 7.9k-record session, for one string. `insights` above is the parse it would otherwise repeat.
  const recap = core.recapOf(session, insights).recap || null;
  const suggestions = [
    ...new Set([...core.transcriptSuggestions(cwd, session), ...core.heuristicSuggestions(session)]),
  ];
  // One index for the whole file set. Caching per file was not enough: each MISS still revalidated the
  // cross-session index against every session log, so a session touching 3,957 files spent 383,830
  // stats proving an index that had not changed was still valid.
  const memCache = core.fileMemories(new Set(log.map((r) => r.file)));
  const edits = [...log].reverse().map((r) => {
    const mem = memCache.get(r.file) ?? core.fileMemory(r.file);
    return {
      id: r.id,
      ts: r.ts,
      tool: r.tool,
      file: r.file,
      status: r.status,
      summary: core.summarize(session, r),
      reasoning: reasoning.get(r.id) ?? null,
      flags: core.flagsFor(session, r, log),
      memory: { summary: core.memorySummary(mem), risky: core.isRiskyFile(mem) },
      analysis: core.cachedAnalysis(session, `edit-${r.id}`)?.text ?? null,
    };
  });
  return { session, recap, insights, suggestions, edits };
}

/** One JSON payload for an Observations-style view: recap + per-edit reasoning/flags/memory. */
function cmdObserve(args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  emitJson(buildObserve(core, getSessionId(args), process.cwd()));
}

/** `observations` (§B) — the 0.8.0 Observations view-model (Timeline folded in): a session recap on
 *  top, the edit timeline as coalesced same-file ×N runs (most-recent first) each edit carrying
 *  Claude's reasoning, and the still-open next steps at the end. Always JSON; both editors render it
 *  thin (or recompute the same shape from the same core fns). Zero token. */
function cmdObservations(args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  const session = getSessionId(args);
  const ri = args.indexOf('--root'); // display-relative paths (editors point it at the workspace)
  const root = flagValue(args, '--root') ?? process.cwd();
  emitJson(core.buildObservations(process.cwd(), session, { root }));
}

/** `insights` — the human-readable Observations view (recap + per-edit summary/reasoning/flags/
 *  file-memory + next steps). The terminal counterpart to the editors' Observations panel. */
function cmdInsights(args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  const session = getSessionId(args);
  const p = buildObserve(core, session, process.cwd());
  if (args.includes('--json')) {
    emitJson(p);
    return;
  }
  if (p.edits.length === 0) {
    process.stdout.write(c.dim(`no edits yet (session ${session}).\n`));
    return;
  }
  process.stdout.write(c.bold('Observations') + c.dim(`  session ${session}\n`));
  if (p.recap) process.stdout.write(c.dim(p.recap) + '\n');
  process.stdout.write('\n');
  for (const e of p.edits) {
    process.stdout.write(
      `${c.bold('#' + e.id)}  ${statusLabel(e.status).padEnd(7)}  ${c.cyan(relFile(e.file))}  ${c.dim(e.summary)}\n`
    );
    if (e.reasoning) process.stdout.write('     ' + c.dim(e.reasoning.split('\n')[0].slice(0, 140)) + '\n');
    for (const f of e.flags) {
      process.stdout.write('     ' + (f.level === 'warn' ? c.yellow('⚠ ') : c.dim('· ')) + f.message + '\n');
    }
    if (e.memory.risky) process.stdout.write('     ' + c.yellow('⚑ ') + c.dim(e.memory.summary) + '\n');
  }
  if (p.suggestions.length) {
    process.stdout.write('\n' + c.bold('Next steps') + '\n');
    for (const s of p.suggestions) process.stdout.write('  • ' + s + '\n');
  }
}


/** Same shape for the ACCOUNT pull: at most one detached `usage --pull-account` per interval,
 *  claimed cross-process, never blocking the JSON this poll is about to print. */
function kickAccountPull(): void {
  try {
    const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
    if (!core.dueAccountUsagePull()) return;
    core.spawnTool(process.execPath, [process.argv[1], 'usage', '--pull-account', '--json'], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* a failed kick only means the cache stays stale until the next poll */
  }
}


/** The UsageLine snapshot (ctx / 5h / week) + the session's input/output/cache token split + its
 *  model/effort/compaction vitals + the shared staleness threshold; always JSON. Both editors' Stats
 *  panels consume this. */
function cmdUsage(args: string[]): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const bi = args.indexOf('--bill-day');
  if (bi >= 0) {
    // The bill cycle is anniversary-anchored and no payload carries the date — stated once here,
    // read by the statusline's month segment and the breakdown's month buckets. 0 clears.
    const v = Number(args[bi + 1]);
    if (!Number.isInteger(v) || v < 0 || v > 31) fail('--bill-day takes a day of month 1-31 (0 clears it).');
    const prefs = core.readPrefs();
    if (v === 0) delete prefs.billDay;
    else prefs.billDay = v;
    core.writePrefs(prefs);
    console.log(v === 0 ? 'Claude bill day cleared — Claude month figures use calendar months.' : `Claude bill day set to the ${v}${v === 1 ? 'st' : v === 2 ? 'nd' : v === 3 ? 'rd' : 'th'} — Claude month figures now follow your bill cycle (set it on each machine).`);
    return;
  }
  const gbi = args.indexOf('--gpt-bill-day');
  if (gbi >= 0) {
    // Separate from --bill-day: the OpenAI subscription renews on its own day, and codex sends no
    // date. Read by the gpt month segment (gptUsagePanel). 0 clears (calendar months).
    const v = Number(args[gbi + 1]);
    if (!Number.isInteger(v) || v < 0 || v > 31) fail('--gpt-bill-day takes a day of month 1-31 (0 clears it).');
    const prefs = core.readPrefs();
    if (v === 0) delete prefs.gptBillDay;
    else prefs.gptBillDay = v;
    core.writePrefs(prefs);
    console.log(v === 0 ? 'GPT bill day cleared — GPT month figures use calendar months.' : `GPT bill day set to the ${v}${v === 1 ? 'st' : v === 2 ? 'nd' : v === 3 ? 'rd' : 'th'} — GPT month figures now follow your bill cycle (set it on each machine).`);
    return;
  }
  if (args.includes('--breakdown')) return cmdUsageBreakdown(args);
  // The detached account pull: one process fetches the account's own usage (pcts + resets +
  // fable) and merges it into the statusline cache — the numbers stay live with NO claude
  // session open. Hidden verb; every poller kicks it via the claim below.
  if (args.includes('--pull-account')) {
    return void core.pullProviderAccountUsage().then((ok) => {
      if (!args.includes('--json')) console.log(ok ? 'account usage pulled.' : 'nothing pulled (no credentials, or the account answered nothing).');
    });
  }
  kickAccountPull(); // …and the account pull that keeps 5h/wk live without a claude session
  core.kickRemoteTitles(); // …and the Remote Control titles, on the same pollers (throttled, detached)
  // …and the month scan, so the bill-cycle $ stays live in editor-only use. Skip it when the caller
  // IS the statusline (OAK_STATUSLINE) — the statusline reads `oak usage --session` for its token line,
  // and kicking there would have it spawn itself in a throttled loop.
  if (!process.env.OAK_STATUSLINE) core.kickMonthRefresh(process.cwd());
  const si = args.indexOf('--session');
  const provided = si >= 0 && args[si + 1] ? args[si + 1] : undefined;
  // Guard a user-provided id like getSessionId does — usageLine derives a store path from it.
  if (provided && !core.isSafeSessionId(provided)) fail(`invalid session id "${provided}" (letters, digits, dot, dash, underscore only).`);
  const sid = provided || core.resolveSessionId(process.cwd()) || '';
  // sessionTokens = the session's cumulative input/output/cache split (+ cache hit rate), which the
  // editors' stats panels render under the session title; ctx/5h/week above are point-in-time limits.
  // vitals = which model/effort served the session, its compactions, and the context-fill series —
  // free here, since it shares the cursor sessionUsage just advanced.
  // ACCOUNT-level windows for the IDE status-bar widget, one set per agent (flat keys — the
  // JetBrains widget reads top-level numbers). The spread below is SESSION-scoped: for a codex
  // session its fiveHourPct IS codex's window (usageFrom:'codex'), so the widget must never
  // read those as claude's. claude* = the statusline cache (empty session id ⇒ the codex seam
  // can't fire); gpt* = codex's own rollout windows, rolled-over ones dropped. Scoped to a Codex session
  // only when the caller NAMED it: the JetBrains status bar asks with no --session, and scoping to the
  // workspace's newest session there made it disagree with VS Code's unscoped status bar. The
  // statusline (OAK_STATUSLINE) reads only `sessionTokens`, on every render, so it skips the panel,
  // which totals Codex usage history.
  const acct = core.usageLine(process.cwd(), '');
  const gpt = process.env.OAK_STATUSLINE ? null
    : core.gptUsagePanel(provided && core.describeSession(provided).runtime.includes('codex') ? provided : undefined);
  emitJson({
    ...core.usageLine(process.cwd(), sid),
    claudeAccount: acct,
    claudeFivePct: acct.fiveHourPct,
    claudeFiveReset: acct.fiveReset,
    claudeFiveTokens: acct.fiveTokens,
    claudeFiveTotal: acct.fiveTotal,
    claudeWeekPct: acct.weekPct,
    claudeWeekReset: acct.weekReset,
    // The Fable cap, flattened like the rest: the TUI reads `claudeAccount`, but the JetBrains
    // status widget only reads top-level numbers, so without these it could not show the cap at all.
    claudeFablePct: acct.fablePct,
    claudeFableReset: acct.fableReset,
    claudeFableLabel: acct.fableLabel,
    claudeMonthCost: acct.monthCost,
    claudeMonthCostTotal: acct.monthCostTotal,
    claudeMonthPct: acct.monthTokens && acct.monthTokensTotal ? Math.min(100, (acct.monthTokens / acct.monthTokensTotal) * 100) : null,
    claudeMonthReset: acct.monthReset,
    claudeWeekTokens: acct.weekTokens,
    claudeWeekTotal: acct.weekTotal,
    gptFivePct: gpt?.fivePct ?? null,
    gptFiveReset: gpt?.fiveReset ?? null,
    gptWeekPct: gpt?.weekPct ?? null,
    gptWeekReset: gpt?.weekReset ?? null,
    gptCtxPct: gpt?.ctxPct ?? null,
    gptCtxTokens: gpt?.ctxTokens ?? null,
    gptCtxSize: gpt?.ctxSize ?? null,
    gptWeekTok: gpt?.weekTok ?? null,
    gptWeekTotal: gpt?.weekTotal ?? null,
    gptMonthStart: gpt?.monthStart ?? null,
    gptMonthReset: gpt?.monthReset ?? null,
    gptMonthTok: gpt?.monthTok ?? null,
    gptMonthTokTotal: gpt?.monthTokTotal ?? null,
    gptMonthReads: gpt?.monthReads ?? null,
    gptMonthCost: gpt?.monthCost ?? null,
    gptMonthCostTotal: gpt?.monthCostTotal ?? null,
    sessionTokens: core.sessionUsage(process.cwd(), sid),
    vitals: core.sessionVitals(process.cwd(), sid),
    staleMs: core.USAGE_STALE_MS,
  });
}

/**
 * `oak usage --breakdown`: the /usage-style detail Claude itself keeps —
 * tokens and ~$ by week, month, model or session, for claude AND codex. Everything is measured
 * from THIS machine's records (transcripts and codex rollouts) with the statusline scan's rules
 * (cross-file message-id dedup, window-by-timestamp); dollars are API list prices, i.e. estimates
 * of compute value, not a bill — subscription plans are flat-rate and the header says so.
 */
function cmdUsageBreakdown(args: string[]): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const argOf = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
  };
  const by = (argOf('--by') ?? 'week') as import('@oak-observatory/core').BreakdownBy;
  if (!['week', 'month', 'model', 'session'].includes(by)) fail(`--by takes week, month, model or session (got "${by}").`);
  const agent = argOf('--agent') ?? 'both';
  if (!['claude', 'codex', 'both'].includes(agent)) fail(`--agent takes claude, codex or both (got "${agent}").`);
  const weeksArg = argOf('--weeks');
  if (weeksArg !== undefined) { const n = Number(weeksArg); if (!Number.isInteger(n) || n < 1 || n > 52) fail(`--weeks takes an integer 1-52 (got "${weeksArg}").`); }
  const weeks = Math.max(1, Math.min(52, Number(weeksArg ?? (by === 'month' ? 26 : 8)) || 8));
  const sinceMs = Date.now() - weeks * 7 * 86400_000;
  // Week buckets follow the account's real reset cycle when the statusline cache knows it.
  const u = core.usageLine(process.cwd(), '');
  const anchorMs = u.weekReset ?? null;
  const rows: import('@oak-observatory/core').AgentBreakdown[] = [];
  const billDay = core.billDay();
  if (agent !== 'codex') rows.push(core.claudeBreakdown(by, sinceMs, anchorMs, undefined, billDay));
  if (agent !== 'claude') rows.push(core.codexBreakdown(by, sinceMs, core.codexUsageLive().weekReset, undefined, null));
  const promo = core.activePromo();

  if (args.includes('--json')) {
    emitJson({ by, weeks, sinceMs, weekAnchorMs: anchorMs, promo, agents: rows });
    return;
  }

  const money = (v: number): string => (v >= 100 ? `$${Math.round(v)}` : v >= 10 ? `$${v.toFixed(0)}` : `$${v.toFixed(1)}`);
  const out: string[] = [];
  out.push(`usage breakdown · by ${by} · last ${weeks} week${weeks > 1 ? 's' : ''} · this machine's records`);
  out.push(`~$ are API list prices — an estimate of compute value, not a bill (subscriptions are flat-rate)`);
  out.push(`the oldest bucket may be partial — records before the ${weeks}-week cutoff are not counted`);
  if (promo) {
    const until = new Date(promo.endMs).toISOString().slice(0, 10);
    out.push(`plan note: the ${promo.label} weekly-limit promotion is live until ${until}; budgets shown elsewhere include it`);
  }
  for (const r of rows) {
    out.push('');
    out.push(`${r.agent === 'claude' ? 'claude' : 'gpt (codex)'} — ${fmtTok(r.totals.tokens)} tok · ${human(r.totals.cacheRead)} cache reads · ${r.totals.usdKnown ? '~' + money(r.totals.usd) : 'price unavailable'}${r.totals.usdApprox ? '*' : ''}`);
    if (!r.buckets.length) {
      out.push('  (no records in range)');
      continue;
    }
    const w = Math.max(...r.buckets.map((b) => b.label.length), 6);
    for (const b of r.buckets.slice(0, 40)) {
      out.push(
        `  ${b.label.padEnd(w)}  ${fmtTok(b.tokens).padStart(8)} tok  ${human(b.cacheRead).padStart(7)} reads  ${(b.usdKnown ? money(b.usd) : '—').padStart(7)}${b.usdApprox ? '*' : ' '}  ${String(b.messages).padStart(6)} msgs`
      );
    }
    if (r.buckets.length > 40) out.push(`  … ${r.buckets.length - 40} more (use --json for all)`);
  }
  if (rows.some((r) => r.totals.usdApprox)) out.push('');
  if (rows.some((r) => r.totals.usdApprox)) out.push('* includes an approximate or unavailable model rate; totals with unpriced usage show no dollar estimate');
  console.log(out.join('\n'));
}

// --- opt-in `claude -p` analysis (token-spending; cached results are returned unless --fresh) ---

function claudeBinFrom(args: string[]): string {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const bi = args.indexOf('--claude-bin');
  return core.resolveClaudeBin(bi >= 0 ? args[bi + 1] : undefined);
}

function emitAnalysis(a: { key: string; text: string; ts: number }, cached: boolean, json: boolean): void {
  if (json) emitJson({ key: a.key, text: a.text, ts: a.ts, cached });
  else process.stdout.write(a.text + '\n');
}

async function cmdAnalyze(args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const session = getSessionId(args);
  const id = requireId(args);
  const json = args.includes('--json');
  const cached = args.includes('--fresh') ? null : core.cachedAnalysis(session, `edit-${id}`);
  if (cached) return emitAnalysis(cached, true, json);
  const reasoning = core.reasoningByEdit(process.cwd(), session).get(id);
  const a = await core.analyzeEdit(session, id, { claudeBin: claudeBinFrom(args), reasoning });
  emitAnalysis(a, false, json);
}

async function cmdRecap(args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const session = getSessionId(args);
  const json = args.includes('--json');
  const cached = args.includes('--fresh') ? null : core.cachedAnalysis(session, 'recap');
  if (cached) return emitAnalysis(cached, true, json);
  const a = await core.analyzeRecap(session, { claudeBin: claudeBinFrom(args) });
  emitAnalysis(a, false, json);
}

// --- bundled status line (vendored cell-observatory/claude-statusline installer) ---

/** The self-contained statusline installer shipped inside this npm package. */
function statuslineInstallerPath(): string {
  const path = require('path');
  // dist/index.js -> ../statusline/install-statusline.sh (same layout in the repo and the tarball)
  return path.join(__dirname, '..', 'statusline', 'install-statusline.sh');
}

/** True once the status line has written its cache — the signal the Usage bars need. */
function statuslineActive(): boolean {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const fs = require('fs');
  const path = require('path');
  return fs.existsSync(path.join(core.claudeConfigDir(), 'statusline-last.json'));
}

/** Install/refresh the bundled status line (idempotent; honors CLAUDE_CONFIG_DIR; needs bash+jq). */
function cmdStatusline(args: string[] = []): void {
  const fs = require('fs');
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const script = statuslineInstallerPath();
  if (!fs.existsSync(script)) {
    fail(`bundled installer missing (${script}) — install from https://github.com/cell-observatory/claude-statusline`);
  }
  // `direct`: bash is a real .exe that libuv resolves unaided, and the hint below is reachable ONLY
  // through res.error — a shell would report a missing bash as exit 127 and kill that branch.
  // `--force` passes through: the installer REFUSES to replace a statusLine that is not ours
  // (ccusage's, Orca's) unless the caller explicitly said so.
  const res = core.spawnToolSync('bash', [script, ...(args.includes('--force') ? ['--force'] : [])], { stdio: 'inherit', direct: true });
  if (res.error) {
    const winHint = process.platform === 'win32' ? ' — on Windows run this from Git Bash or WSL' : '';
    fail(`could not run bash: ${res.error.message} (the status line needs bash + jq${winHint})`);
  }
  process.exit(res.status ?? 1);
}

async function cmdSuggest(args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const session = getSessionId(args);
  const json = args.includes('--json');
  const cached = args.includes('--fresh') ? null : core.cachedAnalysis(session, 'suggestions');
  if (cached) return emitAnalysis(cached, true, json);
  const a = await core.analyzeSuggestions(session, { claudeBin: claudeBinFrom(args) });
  emitAnalysis(a, false, json);
}

// --- self-update: fetch the latest GitHub Release and reinstall the CLI (no registry, no deps) ---

const RELEASE_REPO = 'cell-observatory/oak-observatory';
/** The releases API base — overridable so the update/channel integration test (and an enterprise
 *  release mirror) can stand in for github.com. Everything else about the flow stays identical:
 *  asset downloads follow the `browser_download_url`s the API payload itself carries. */
const RELEASES_API = process.env.CLAUDE_OBSERVATORY_RELEASES_API || `https://api.github.com/repos/${RELEASE_REPO}`;
// The VS Code-family extension id (publisher.name). We detect the extension by its install DIR (like
// the JetBrains plugin dirs) so detection never depends on the editor CLI being on PATH; the CLI is
// only needed to APPLY the update, and is resolved from app-bundle locations when it's off PATH.
const VSCODE_EXT_ID = 'cell-observatory.oak-observatory-vscode';
// The id before the OAK rename (the extension shipped as `cell-observatory.claude-observatory-vscode`).
// Editors treat it as a separate extension, so an old-id install must still be detected — and removed
// after a successful update to the renamed .vsix, or a migrated editor ends up with two Observatories.
const VSCODE_EXT_ID_OLD = 'cell-observatory.claude-observatory-vscode';
// The global npm package name before the OAK rename. It declares the `claude-observatory` bin, which
// this package also ships as the deprecated alias, so it must be uninstalled before an `npm i -g` of
// this package can land — see updateCliBinary.
const NPM_PKG_OLD = 'claude-observatory';
// One row per VS Code-family editor: where it keeps installed extensions (relative to $HOME), the CLI
// that drives `--install-extension`, and the macOS .app name used to locate that CLI when off PATH.
// `app` is the macOS bundle name; `winApp` the Windows install FOLDER, which is not the same string —
// VS Code ships as "Visual Studio Code.app" but installs to `Programs\Microsoft VS Code`, so the
// win32 fallback below was looking somewhere that never exists and detection quietly rested on
// `where code` alone. (VS Code's layout is from its own docs; the other three are best-effort, which
// costs nothing — these are existsSync candidates, so a wrong guess is skipped, a missing one is a
// real editor we fail to find.)
const VSCODE_EDITORS: { label: string; extDirs: string[]; cli: string; app: string; winApp: string }[] = [
  { label: 'VS Code', extDirs: ['.vscode/extensions', '.vscode-server/extensions'], cli: 'code', app: 'Visual Studio Code', winApp: 'Microsoft VS Code' },
  // Insiders is a SEPARATE install with its own extensions dir and its own CLI name — omitting it
  // did not degrade anything gracefully, it made every Insiders user invisible to `update` and
  // `install-extensions`, which then reported "no editor detected" and did nothing, forever.
  { label: 'VS Code Insiders', extDirs: ['.vscode-insiders/extensions', '.vscode-server-insiders/extensions'], cli: 'code-insiders', app: 'Visual Studio Code - Insiders', winApp: 'Microsoft VS Code Insiders' },
  // The `-server` dirs are the Remote-SSH/remote-dev backends, same as `.vscode-server` above —
  // without them a server-side install (e.g. `~/.cursor-server` on a GPU box) is invisible to
  // `update`, which then silently skips the one install the user actually works in.
  { label: 'Cursor', extDirs: ['.cursor/extensions', '.cursor-server/extensions'], cli: 'cursor', app: 'Cursor', winApp: 'cursor' },
  { label: 'VSCodium', extDirs: ['.vscodium/extensions', '.vscodium-server/extensions'], cli: 'codium', app: 'VSCodium', winApp: 'VSCodium' },
  { label: 'Windsurf', extDirs: ['.windsurf/extensions', '.windsurf-server/extensions'], cli: 'windsurf', app: 'Windsurf', winApp: 'Windsurf' },
];
// The JetBrains plugin unzips to this dir inside each IDE's plugins/ folder; we drop a version
// sentinel beside it so a later `update` can tell whether the installed plugin is already current.
const JB_PLUGIN_DIRNAME = 'oak-observatory-jetbrains';
// The dir the plugin unzipped to before the OAK rename — removed on install so a migrated IDE does not
// end up with the pre-rename plugin loaded beside the new one.
const JB_PLUGIN_DIRNAME_OLD = 'claude-observatory-jetbrains';
const JB_VERSION_SENTINEL = '.observatory-version';
// The self-hosted JetBrains plugin repository, regenerated + attached to every GitHub Release by
// .github/workflows/release.yml. Add it ONCE under Settings → Plugins → ⚙ → Manage Plugin
// Repositories and the IDE auto-updates the plugin natively from then on (no more Install-from-Disk).
const JB_PLUGIN_REPO_URL = `https://github.com/${RELEASE_REPO}/releases/latest/download/updatePlugins.xml`;

type ReleaseAsset = { name: string; browser_download_url: string; digest?: string };

/** GET a URL following redirects, resolving to the response body. Rejects on non-200. */
function httpGet(url: string, redirects = 5): Promise<Buffer> {
  // Protocol-aware: production traffic is https (github.com + its CDN), while the update/channel
  // integration test serves a LOCAL http mock of the releases API — the one way the real download →
  // verify → install path gets exercised end-to-end without touching the network.
  const https = url.startsWith('http://') ? require('http') : require('https');
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'oak-observatory', Accept: 'application/vnd.github+json' } },
      (res: any) => {
        const { statusCode, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location && redirects > 0) {
          res.resume();
          resolve(httpGet(headers.location, redirects - 1)); // asset URLs redirect to a CDN
          return;
        }
        if (statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${statusCode} for ${url}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request timed out')));
  });
}

/** Verify downloaded bytes against GitHub's per-asset sha256 `digest`. Fails hard on mismatch (we're
 *  about to execute/extract them); warns if the release published no checksum. */
function assertDigest(bytes: Buffer, asset: ReleaseAsset): void {
  const crypto = require('crypto');
  const expected =
    typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : null;
  if (!expected) {
    process.stdout.write(c.yellow(`  ⚠ no published checksum for ${asset.name} — skipping integrity check\n`));
    return;
  }
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    fail(`integrity check FAILED for ${asset.name} (sha256 ${actual} ≠ ${expected}) — refusing to install.`);
  }
  process.stdout.write(c.dim(`  ✓ sha256 verified (${asset.name})\n`));
}

/** Download a release asset to a fresh private temp file (0700 dir, 0600 file, exclusive create —
 *  no predictable-path symlink/TOCTOU on /tmp), integrity-checked before it lands. Returns the path. */
async function downloadAsset(asset: ReleaseAsset): Promise<string> {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  process.stdout.write(c.dim(`downloading ${asset.name} …\n`));
  const bytes = await httpGet(asset.browser_download_url);
  assertDigest(bytes, asset);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-observatory-'));
  const dest = path.join(dir, path.basename(asset.name));
  fs.writeFileSync(dest, bytes, { flag: 'wx', mode: 0o600 });
  // Scratch for this run: removed when it succeeds (every update used to leave its downloads behind).
  // A failed run keeps them, because its message names the file to install by hand.
  process.once('exit', (code) => {
    if (code === 0) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  return dest;
}

/** Download the CLI tarball from the release and `npm i -g` it (integrity-checked first — the tarball
 *  runs install lifecycle scripts as the current user). */
async function updateCliBinary(assets: ReleaseAsset[], latest: string, current: string): Promise<void> {
  const tgz = assets.find((a) => /\.tgz$/.test(a.name));
  if (!tgz) fail(`release v${latest} has no CLI tarball asset to install.`);
  const dest = await downloadAsset(tgz!);
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  // A pre-rename global (`claude-observatory`) owns bin names this package also declares, and
  // npm ≥7 refuses to hand a bin to a different package (EEXIST). Uninstall-first, never --force:
  // --force leaves the old package behind with a dangling claim on the shared bins, and a later
  // `npm uninstall -g claude-observatory` then deletes symlinks that belong to the NEW install.
  const oldPkg = core.spawnToolSync(npm, ['ls', '-g', NPM_PKG_OLD], { stdio: 'pipe' });
  if (oldPkg.status === 0) {
    process.stdout.write(c.dim(`removing the old ${NPM_PKG_OLD} global package (renamed to oak-observatory)…\n`));
    const un = core.spawnToolSync(npm, ['uninstall', '-g', NPM_PKG_OLD], { stdio: 'pipe' });
    if (un.status !== 0)
      process.stdout.write(
        c.yellow('! ') + `could not remove it — if the install below fails, run: npm uninstall -g ${NPM_PKG_OLD}\n`
      );
  }
  process.stdout.write(c.dim('installing globally (npm i -g) …\n'));
  // npm is npm.cmd on Windows, which cannot be spawned without cmd.exe. The launcher also does the
  // quoting `dest` needs (spaced Windows usernames put a space in every temp path). --allow-scripts:
  // npm 12 blocks dependency install scripts by default, and on Linux node-pty's is the only way it
  // gets built (npm 10 and 11 accept the flag and change nothing).
  const r = core.spawnToolSync(npm, ['i', '-g', dest, '--allow-scripts=node-pty'], {
    stdio: 'inherit',
  });
  if (r.status !== 0)
    fail(
      `npm install failed (exit ${r.status ?? '?'}). If npm said EEXIST, another global package already owns one of ` +
        `OAK's commands (oak, oak-observatory, claude-observatory): uninstall it or remove the file npm named, then ` +
        `re-run \`oak update\`. Otherwise try: npm i -g ${dest} --allow-scripts=node-pty`
    );
  process.stdout.write(c.green('✓ ') + `updated the CLI ${current} → ${latest}\n`);
  refreshInstalledStatusline();
}

/**
 * Finish an update in the CLI npm just installed. This process is still the OLD release: its
 * compiled-in herdr pin is the old one, and npm has just re-extracted node-pty, which resets the macOS
 * spawn-helper's mode. Found through npm's global root rather than `oak` on PATH, which can be
 * another install (a linked checkout, a second Node).
 */
function finishInInstalledCli(): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const fs = require('fs');
  const path = require('path');
  let entry: string | null = null;
  try {
    // Not `npm root -g`: npm 11 and later print a UUID-shaped path segment as ***. A script npm runs is
    // handed the real global prefix, whose lib/node_modules (node_modules on Windows) holds the package.
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const prefix = String(core.spawnToolSync(npm, ['exec', '--silent', '-c', 'node -p process.env.npm_config_global_prefix'], { encoding: 'utf8' }).stdout ?? '').trim();
    const pkg = path.join(prefix, process.platform === 'win32' ? '' : 'lib', 'node_modules', 'oak-observatory');
    const bin = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).bin?.oak;
    if (typeof bin === 'string') entry = path.join(pkg, bin);
  } catch {
    /* reported below */
  }
  const r = entry ? core.spawnToolSync(process.execPath, [entry, '__after-update'], { stdio: 'inherit' }) : null;
  if (r?.status !== 0)
    process.stdout.write(c.yellow('⚠ ') + 'the updated CLI did not finish setting up herdr and its terminal — run `oak doctor --fix`\n');
}

/** `__after-update`: the half of `oak update` that belongs to the NEW release (see finishInInstalledCli). */
async function afterUpdate(): Promise<void> {
  await ensureHerdrPin();
  const tui = require('@oak-observatory/tui') as typeof import('@oak-observatory/tui');
  const pty = await tui.diagnoseNativeSpawn(true);
  if (pty.level !== 'ok') process.stdout.write(c.yellow('⚠ ') + `${pty.label}: ${pty.detail}\n` + (pty.fix ? c.dim(`  → ${pty.fix}\n`) : ''));
  else if (pty.detail.startsWith('repaired')) process.stdout.write(c.green('✓ ') + `${pty.detail}\n`);
}

/** The bundled status line updates WITH the CLI. Updating the observatory used to leave the installed
 *  ~/.claude/statusline.sh stale until the user re-ran `oak statusline` by hand — one
 *  update command now covers both. Runs the freshly-installed GLOBAL binary (not this process, whose
 *  bundled copy is the old version), and only when ours is actually installed. */
function refreshInstalledStatusline(): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  if (!core.statuslineInstalled()) return; // some other status line (or none) — never touch it
  process.stdout.write(c.dim('refreshing the bundled status line…\n'));
  const r = core.spawnToolSync(
    process.platform === 'win32' ? 'oak.cmd' : 'oak',
    ['statusline'],
    { stdio: 'inherit' }
  );
  if (r.status !== 0)
    process.stdout.write(
      c.dim(`status line refresh did not complete — run \`oak statusline\` yourself.\n`)
    );
}

/** Editors in the VS Code family (code/cursor/…) on PATH that already have our extension, with the
 *  installed version parsed from `--list-extensions --show-versions` (ids are lowercased by VS Code). */
/** Resolve an editor's CLI to an absolute path: PATH first, else known app-bundle locations (macOS
 *  .app bundles, Windows Programs dirs, common Linux dirs). Returns null when not found — the extension
 *  is still DETECTED via its dir, so a null means "installed but we can't drive an update", which the
 *  caller must SURFACE, never swallow. Mirrors core.resolveBin (candidates → PATH fallback). */
function resolveEditorCli(cli: string, app: string, winApp: string): string | null {
  if (onPath(cli)) return cli; // bare name; the launcher routes it through cmd.exe on Windows
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const home = os.homedir();
  const cands: string[] = [];
  if (process.platform === 'darwin') {
    for (const root of ['/Applications', path.join(home, 'Applications')]) {
      cands.push(path.join(root, `${app}.app`, 'Contents', 'Resources', 'app', 'bin', cli));
    }
  } else if (process.platform === 'win32') {
    // Two roots (per-user "User Setup" and machine-wide "System Setup") × two layouts: most of the
    // family keeps its CLI in `bin\`, Cursor buries it under `resources\app\bin\`.
    for (const root of [
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', winApp) : null,
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, winApp) : null,
      process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'] as string, winApp) : null,
    ]) {
      if (!root) continue;
      cands.push(path.join(root, 'bin', `${cli}.cmd`));
      cands.push(path.join(root, 'resources', 'app', 'bin', `${cli}.cmd`));
    }
  } else {
    cands.push(`/usr/share/${cli}/bin/${cli}`, `/usr/bin/${cli}`, `/snap/bin/${cli}`, path.join(home, '.local', 'bin', cli));
  }
  for (const p of cands) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

/**
 * What the editor itself says is installed in `dir`, from its own `extensions.json` registry:
 * `{ '<publisher>.<name>': '<version>' }`. Null when the file is absent or unreadable — then the
 * caller falls back to scanning folders.
 *
 * This has to come first, because a folder scan answers a DIFFERENT question. An editor leaves the
 * previous version's folder on disk after an install, and picking the newest folder made a downgrade
 * un-redoable: after a dev→stable switch the higher `…-0.10.0-dev.12` folder lingered, so the CLI
 * kept reporting the version it had just replaced, decided there was nothing to do, and left the
 * user on a build the registry no longer even loads. The registry lists what is LOADED, one row per
 * extension — which is the thing an update has to reason about.
 */
function registeredExtVersions(dir: string): Record<string, string> | null {
  const fs = require('fs');
  const path = require('path');
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, 'extensions.json'), 'utf8');
  } catch {
    return null; // no registry here (older editors, a bare server dir) — the folder scan answers
  }
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return null;
    const out: Record<string, string> = {};
    for (const e of list) {
      const id = String(e?.identifier?.id ?? '').toLowerCase();
      const v = e?.version;
      if (id && typeof v === 'string' && v) out[id] = v;
    }
    return out;
  } catch {
    // Present but corrupt is NOT "nothing installed" — fall back rather than report a clean absence.
    return null;
  }
}

/** Parse the version out of a VS Code extension folder named `<id>-<version>` (fallback: its
 *  package.json). Returns null if neither yields a semver. */
function versionFromExtFolder(folderPath: string, folderName: string, id: string): string | null {
  const suffix = folderName.slice(id.length + 1); // drop the `<id>-` prefix
  if (/^\d+\.\d+\.\d+/.test(suffix)) return suffix;
  try {
    const fs = require('fs');
    const path = require('path');
    return JSON.parse(fs.readFileSync(path.join(folderPath, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

/** One row per VS Code-family editor, present on this machine or not. `version` = the newest install
 *  folder of OUR extension for that editor (null when it does not have it yet — which is exactly the
 *  case `install-extensions` acts on and `update` deliberately ignores); `extRoots` = its extension
 *  dirs that actually exist; `cli` = the resolved CLI to drive an install, or null. */
type EditorRow = {
  label: string;
  extDirs: string[];
  extRoots: string[];
  cli: string | null;
  /** The bare command name (`code`, `code-insiders`, `cursor`, …) — what to tell a human to install
   *  when `cli` is null. Hardcoding "code" sent Insiders and Cursor users after the wrong command. */
  cliName: string;
  version: string | null;
  hasOld: boolean;
};

function vscodeEditors(): EditorRow[] {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const home = os.homedir();
  const out: EditorRow[] = [];
  for (const ed of VSCODE_EDITORS) {
    let best: string | null = null; // newest version across this editor's extension dirs
    let hasOld = false;
    const extRoots: string[] = [];
    for (const rel of ed.extDirs) {
      const dir = path.join(home, rel);
      let entries: string[] = [];
      try { entries = fs.readdirSync(dir); } catch { continue; }
      extRoots.push(dir); // readdir succeeded, so this editor has run here at least once
      // The editor's own registry is authoritative about what is LOADED; folders are only evidence
      // of what has ever been unpacked. See registeredExtVersions.
      const reg = registeredExtVersions(dir);
      if (reg) {
        if (reg[VSCODE_EXT_ID_OLD]) hasOld = true;
        const v = reg[VSCODE_EXT_ID];
        if (v && (best === null || core.isNewer(v, best))) best = v;
        continue;
      }
      for (const e of entries) {
        // VS Code names extension folders `<publisher>.<name>-<version>` (lowercased).
        const id = [VSCODE_EXT_ID, VSCODE_EXT_ID_OLD].find((i) => e.toLowerCase().startsWith(i + '-'));
        if (!id) continue;
        if (id === VSCODE_EXT_ID_OLD) hasOld = true;
        const v = versionFromExtFolder(path.join(dir, e), e, id);
        if (v && (best === null || core.isNewer(v, best))) best = v;
      }
    }
    out.push({ label: ed.label, extDirs: ed.extDirs, extRoots, cli: resolveEditorCli(ed.cli, ed.app, ed.winApp), cliName: ed.cli, version: best, hasOld });
  }
  return out;
}

/** Is this editor on the machine at all? An extensions dir means it has RUN; a resolvable CLI means it
 *  is installed but maybe never launched. Either counts — only the `cli !== null` subset is actionable. */
function editorPresent(e: EditorRow): boolean {
  return e.extRoots.length > 0 || e.cli !== null;
}

/**
 * Every surface an update touches, in the shape `core.resolveUpdatePlan` decides over: this CLI, each
 * VS Code-family editor, each JetBrains IDE plugin dir. `version: null` = not installed here.
 *
 * This is the ONE place that reads what is on disk. Before it existed, `update`, `install-extensions`
 * and the version chip each gathered their own idea of "installed" and compared it with their own
 * idea of "stale", which is how they came to disagree.
 */
function installedSurfaces(): InstalledSurface[] {
  const fs = require('fs');
  const path = require('path');
  const out: InstalledSurface[] = [{ surface: 'cli', label: 'CLI', version: version() }];
  for (const e of vscodeEditors()) {
    if (!editorPresent(e)) continue;
    // An editor with no CLI is still reported — "installed but we cannot drive an update" has to be
    // said out loud, and the plan is what carries it to whoever prints.
    out.push({ surface: 'vscode', label: e.label, version: e.version, actionable: e.cli !== null, ref: e });
  }
  for (const d of jetbrainsPluginDirs()) {
    const pluginDir = path.join(d, JB_PLUGIN_DIRNAME);
    if (!fs.existsSync(pluginDir)) continue;
    out.push({ surface: 'jetbrains', label: `JetBrains (${path.basename(path.dirname(d))})`, version: jbInstalledVersion(pluginDir), ref: d });
  }
  return out;
}

/** Install `vsixPath` into each target with `--install-extension --force`, handle the 0.8.6 publisher
 *  cleanup, and report per editor. Returns how many succeeded. Shared by `update` (refresh what is
 *  there) and `install-extensions` (put it where it is missing) so the two cannot drift. */
function applyVsix(targets: EditorRow[], vsixPath: string, version: string): number {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  let installed = 0;
  for (const h of targets) {
    // `h.cli` is `code`/`cursor`/… — a bare name on PATH, or an explicit `…\bin\code.cmd` on
    // Windows. BOTH are unspawnable there without cmd.exe, which is why this never once worked
    // on Windows before the launcher: libuv only extension-searches .com/.exe.
    const r = core.spawnToolSync(h.cli as string, ['--install-extension', vsixPath, '--force'], { stdio: 'inherit' });
    if (r.status === 0) {
      process.stdout.write(c.green('✓ ') + `${h.label} extension ${h.version ?? '(new)'} → ${version}\n`);
      installed++;
      // Publisher change (0.8.6): drop the old-id install, but only once the renamed extension is
      // confirmed on disk — a --force reinstall of a pre-rename .vsix must not uninstall itself.
      if (h.hasOld && hasExtFolder(h.extDirs, VSCODE_EXT_ID)) {
        const u = core.spawnToolSync(h.cli as string, ['--uninstall-extension', VSCODE_EXT_ID_OLD], { stdio: 'pipe' });
        if (u.status === 0) process.stdout.write(c.dim(`  removed the old ${VSCODE_EXT_ID_OLD} install (renamed to OAK).\n`));
        else process.stdout.write(c.yellow(`  ⚠ ${h.label} still has the old install — uninstall the older "Claude Observatory" entry in its Extensions view.\n`));
      }
    } else {
      process.stdout.write(c.yellow(`  ⚠ ${h.label} --install-extension failed — install the .vsix manually from the release\n`));
    }
  }
  if (installed) process.stdout.write(c.dim('  fully quit the editor (⌘Q) once so the activity-bar icon refreshes.\n'));
  return installed;
}

/** Whether any of an editor's extension dirs (home-relative) holds an install folder of `id`. */
function hasExtFolder(extDirs: string[], id: string): boolean {
  const fs = require('fs');
  const path = require('path');
  const home = require('os').homedir();
  for (const rel of extDirs) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(path.join(home, rel)); } catch { continue; }
    if (entries.some((e: string) => e.toLowerCase().startsWith(id + '-'))) return true;
  }
  return false;
}

/** Refresh the VS Code-family extension in every editor that already has it (never installs into an
 *  editor that lacks it — that is `install-extensions`' job). Downloads the .vsix once and
 *  `--install-extension --force`s it. The DECISION of what is stale came from `resolveUpdatePlan`;
 *  this only applies it. */
async function refreshVscodeExtension(
  assets: ReleaseAsset[],
  plan: UpdatePlan
): Promise<'updated' | 'current' | 'blocked' | 'absent'> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const here = plan.surfaces.filter((s) => s.surface === 'vscode');
  const installs = here.filter((s) => s.reason !== 'missing');
  if (installs.length === 0) return 'absent'; // genuinely not installed — the only OK silent case
  const stale = installs.filter((s) => s.reason !== 'current');
  if (stale.length === 0) {
    process.stdout.write(c.green('✓ ') + `VS Code extension up to date (${installs[0].from})\n`);
    return 'current';
  }
  // Installed but no CLI could be located: SURFACE it loudly with a fix — never skip in silence.
  for (const s of stale.filter((s) => !s.actionable)) {
    const ed = s.ref as EditorRow;
    process.stdout.write(
      c.yellow('  ⚠ ') +
        `${s.label} extension ${s.from} is installed, but its CLI wasn't found on PATH or in the usual app locations — can't auto-update it.\n` +
        c.dim(`    Fix: in ${s.label}, ⇧⌘P → "Shell Command: Install '${ed?.cliName || 'code'}' command in PATH", then re-run \`oak update\`;\n`) +
        c.dim(`    or install oak-observatory-vscode-v${plan.target}.vsix from the release manually.\n`)
    );
  }
  const actionable = stale.filter((s) => s.actionable);
  let installed = 0;
  if (actionable.length) {
    const vsix = core.assetFor(assets, 'vscode');
    if (!vsix) {
      process.stdout.write(c.yellow(`  ⚠ release v${plan.target} has no .vsix asset — could not update the VS Code extension\n`));
    } else {
      const dest = await downloadAsset(vsix);
      installed = applyVsix(actionable.map((s) => s.ref as EditorRow), dest, plan.target);
    }
  }
  // 'blocked' when any stale install couldn't be applied (no CLI, no asset, or a failed install).
  return installed === stale.length ? 'updated' : 'blocked';
}

/** JetBrains plugin dirs across platforms — ports the detection in scripts/install-jetbrains.sh so
 *  `update` also works on an SSH host serving JetBrains Remote Development. */
function jetbrainsPluginDirs(): string[] {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const home = os.homedir();
  const PRODUCTS = ['PyCharm', 'IntelliJIdea', 'WebStorm', 'GoLand'];
  const dirs: string[] = [];
  const isDir = (p: string): boolean => {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  };
  const productDirs = (parent: string, sub: string | null): void => {
    let entries: string[] = [];
    try { entries = fs.readdirSync(parent); } catch { return; }
    for (const e of entries) {
      if (!PRODUCTS.some((p) => e.startsWith(p))) continue;
      const target = sub ? path.join(parent, e, sub) : path.join(parent, e);
      if (isDir(target)) dirs.push(target);
    }
  };
  // macOS: ~/Library/Application Support/JetBrains/<Product>*/plugins
  productDirs(path.join(home, 'Library', 'Application Support', 'JetBrains'), 'plugins');
  // Linux desktop: ~/.local/share/JetBrains/<Product>*  (plugins live directly in this dir)
  productDirs(path.join(home, '.local', 'share', 'JetBrains'), null);
  // Remote Development backends: ~/.config/JetBrains/RemoteDev-*/<project>/plugins
  const rd = path.join(home, '.config', 'JetBrains');
  try {
    for (const e of fs.readdirSync(rd)) {
      if (!e.startsWith('RemoteDev-')) continue;
      const projRoot = path.join(rd, e);
      try {
        for (const proj of fs.readdirSync(projRoot)) {
          const t = path.join(projRoot, proj, 'plugins');
          if (isDir(t)) dirs.push(t);
        }
      } catch {
        /* not a dir */
      }
    }
  } catch {
    /* no RemoteDev root */
  }
  // Windows: %APPDATA%\JetBrains\<Product>*\plugins
  if (process.env.APPDATA) productDirs(path.join(process.env.APPDATA, 'JetBrains'), 'plugins');
  return dirs;
}

/** Extract a .zip into destDir (unzip on macOS/Linux; Expand-Archive on Windows). */
function extractZip(zip: string, destDir: string): boolean {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  if (process.platform === 'win32') {
    // Both paths travel by ENVIRONMENT, never interpolated into the -Command string: a path holding
    // a `"`, a `$` (PowerShell expands those inside double quotes) or a `'` would otherwise rewrite
    // the command. `direct` because powershell.exe is a real image AND its -Command payload carries
    // quotes of its own, which cmd.exe cannot round-trip.
    const r = core.spawnToolSync(
      'powershell.exe',
      ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:CO_ZIP -DestinationPath $env:CO_DEST -Force'],
      { stdio: 'ignore', direct: true, env: { ...process.env, CO_ZIP: zip, CO_DEST: destDir } }
    );
    return r.status === 0;
  }
  return core.spawnToolSync('unzip', ['-qo', zip, '-d', destDir], { stdio: 'ignore', direct: true }).status === 0;
}

/** The installed JetBrains plugin version, read from its own jar (`lib/oak-observatory-jetbrains-
 *  <version>.jar`, laid down by every install method — `install-jetbrains.sh`, the IDE's "Install Plugin
 *  from Disk", and `update`), falling back to the `.observatory-version` sentinel that `update` also
 *  writes. Returns null only when neither is present. `pluginDir` = `.../plugins/oak-observatory-jetbrains`.
 *  (Before this, only `update` wrote the sentinel, so script/IDE installs read as null → perpetually "stale".) */
function jbInstalledVersion(pluginDir: string): string | null {
  const fs = require('fs');
  const path = require('path');
  try {
    for (const f of fs.readdirSync(path.join(pluginDir, 'lib'))) {
      if (f.includes('searchableOptions')) continue; // the -searchableOptions.jar carries the version too
      const m = /^oak-observatory-jetbrains-(\d+\.\d+\.\d+(?:[-.+][0-9A-Za-z.-]+)?)\.jar$/.exec(f);
      if (m) return m[1];
    }
  } catch {
    /* no lib/ dir — fall through to the sentinel */
  }
  try {
    return fs.readFileSync(path.join(pluginDir, JB_VERSION_SENTINEL), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** One-time setup line that turns a side-loaded JetBrains plugin into an auto-updating one: once
 *  JB_PLUGIN_REPO_URL is registered as a custom plugin repository, the IDE polls it for new releases. */
function jetbrainsAutoUpdateHint(): string {
  return (
    c.dim('  Auto-update future releases (one time): Settings → Plugins → ⚙ → Manage Plugin Repositories → +\n') +
    c.dim(`    → paste ${JB_PLUGIN_REPO_URL}\n`)
  );
}

/** Refresh the JetBrains plugin in every IDE plugins dir that already has it, by unzipping the release
 *  zip in place (the plugin can't hot-swap — the IDE must fully restart). Idempotent via a version
 *  sentinel written beside the plugin. */
async function refreshJetbrainsPlugin(
  assets: ReleaseAsset[],
  plan: UpdatePlan
): Promise<'updated' | 'current' | 'blocked' | 'absent'> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const holders = plan.surfaces.filter((s) => s.surface === 'jetbrains');
  if (holders.length === 0) return 'absent';
  const stale = holders.filter((s) => s.reason !== 'current');
  if (stale.length === 0) {
    process.stdout.write(c.green('✓ ') + `JetBrains plugin up to date (${plan.target})\n`);
    return 'current';
  }
  if (!zipToolReady()) return 'blocked';
  const zip = core.assetFor(assets, 'jetbrains');
  if (!zip) {
    process.stdout.write(c.yellow(`  ⚠ release v${plan.target} has no JetBrains .zip asset — could not update the plugin\n`));
    return 'blocked';
  }
  const dest = await downloadAsset(zip);
  const installed = applyJetbrainsZip(stale.map((s) => s.ref as string), dest, plan.target);
  return installed === stale.length ? 'updated' : 'blocked'; // any dir that failed to extract → surface it
}

/** The precondition for unzipping into a plugin dir. Windows uses PowerShell's Expand-Archive, so only
 *  POSIX needs `unzip`. Prints the fix when it is missing — never a silent skip. */
function zipToolReady(): boolean {
  if (process.platform === 'win32' || onPath('unzip')) return true;
  process.stdout.write(c.yellow(`  ⚠ \`unzip\` was not found — can't install the JetBrains plugin (install unzip, then re-run)\n`));
  return false;
}

/** Unzip `zipPath` into each IDE plugin dir, stamp the version sentinel, report per dir. Returns how
 *  many succeeded. Shared by `update` and `install-extensions`. */
function applyJetbrainsZip(dirs: string[], zipPath: string, version: string): number {
  const fs = require('fs');
  const path = require('path');
  let installed = 0;
  for (const d of dirs) {
    const pluginDir = path.join(d, JB_PLUGIN_DIRNAME);
    try {
      fs.rmSync(pluginDir, { recursive: true, force: true }); // drop files gone from the new build
      fs.rmSync(path.join(d, JB_PLUGIN_DIRNAME_OLD), { recursive: true, force: true }); // remove the pre-rename plugin so a migrated IDE has one, not two
      if (!extractZip(zipPath, d)) throw new Error('extract failed');
      fs.writeFileSync(path.join(pluginDir, JB_VERSION_SENTINEL), version);
      process.stdout.write(c.green('✓ ') + `JetBrains plugin → ${version} (${d})\n`);
      installed++;
    } catch (e: any) {
      process.stdout.write(c.yellow(`  ⚠ could not install the JetBrains plugin into ${d}: ${e?.message || e}\n`));
    }
  }
  if (installed) {
    process.stdout.write(c.dim('  fully restart the IDE (⌘Q → reopen) — a running JVM can’t hot-swap plugin classes.\n'));
    process.stdout.write(jetbrainsAutoUpdateHint());
  }
  return installed;
}

/**
 * `update` — refresh the CLI AND the locally-installed editor extensions from the latest GitHub
 * Release (marketplace-free). The CLI self-updates via `npm i -g`; the VS Code extension via
 * `code --install-extension --force`; the JetBrains plugin by unzipping into the IDE plugin dirs.
 * `--check` reports only; `--cli-only` is the old CLI-only behavior; `--force` reinstalls even if
 * already current.
 */
/** The releases LIST (newest first, drafts invisible anonymously) — ONE fetch answers both
 *  channels: the first regular release is what `releases/latest` serves, the first prerelease is
 *  the rolling dev build. Channel choice happens in core (`resolveReleaseFromList`), pure. */
async function fetchReleases(throwOnError = false): Promise<any[]> {
  try {
    const list = JSON.parse((await httpGet(`${RELEASES_API}/releases?per_page=100`)).toString('utf8'));
    return Array.isArray(list) ? list : [];
  } catch (e: any) {
    // `throwOnError` for callers that can degrade (install-extensions --check reports detection with
    // no network); everything else keeps the process-exiting behaviour it has always had.
    const msg = `could not check for updates (need network access to github.com): ${e?.message || e}`;
    if (throwOnError) throw new Error(msg);
    fail(msg);
  }
}

const CHANNEL_LABEL = { stable: 'stable', dev: 'pre-release (dev)' } as const;

/**
 * `install-extensions` — put the editor extensions ON this machine, into whatever editors are actually
 * here. The counterpart to `update`, which deliberately refreshes only what is ALREADY installed and
 * never adds a new install.
 *
 * It exists so the installers stop reimplementing editor detection in bash. `bootstrap.sh` used to
 * curl the .vsix itself and, for JetBrains, only download the zip and print "Settings → Plugins →
 * Install Plugin from Disk"; `install.sh` ignored JetBrains entirely; neither had a Windows path at
 * all. All of that is one call to this command now, which means it also works on Windows and gets the
 * release-asset sha256 verification (assertDigest) that the bash download never had.
 *
 * Two worlds:
 *   • no artifact flags  → download from the release for `--channel` (bootstrap.sh, install.ps1)
 *   • --vsix/--jetbrains-zip → use these local build outputs, no network (install.sh from source)
 * A locally supplied artifact ALWAYS installs: you just built it, and reading a version out of a
 * .vsix's inner package.json to compare would be work for no benefit.
 */
async function cmdInstallExtensions(args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const fs = require('fs');
  const path = require('path');
  const checkOnly = args.includes('--check');
  const asJson = args.includes('--json');
  const force = args.includes('--force');
  // flagValue returns UNDEFINED when absent, so normalise: `!== null` on `string | undefined` is
  // always true, which would have put every plain run into local-artifact mode with no file to use.
  const vsixArg = flagValue(args, '--vsix') ?? null;
  const zipArg = flagValue(args, '--jetbrains-zip') ?? null;
  const only = args.includes('--vscode-only') ? 'vscode' : args.includes('--jetbrains-only') ? 'jetbrains' : 'both';
  for (const [flag, v] of [['--vsix', vsixArg], ['--jetbrains-zip', zipArg]] as const) {
    if (v !== null && !fs.existsSync(v)) fail(`${flag} ${v}: no such file`);
  }

  // --channel means the same thing it does on `update`: PERSIST the choice, so the next `update` follows
  // the channel you installed from instead of silently pulling you back to stable.
  const chI = args.indexOf('--channel');
  const chRaw = flagValue(args, '--channel');
  if (chI >= 0 && !chRaw) fail('`install-extensions --channel <stable|dev>` requires a value');
  const requested = chRaw ? core.normalizeChannel(chRaw) : null;
  if (chRaw && !requested) fail(`unknown channel "${chRaw}" — use stable or dev (pre-release)`);
  const channel = requested ?? core.getUpdateChannel();

  const editors = vscodeEditors().filter(editorPresent);
  const jbDirs = jetbrainsPluginDirs();
  const local = vsixArg !== null || zipArg !== null;
  // In LOCAL mode no release is fetched, so a family with no artifact has nothing to install FROM.
  // Without this, `install-extensions --vsix build.vsix` on a box that also has a JetBrains IDE
  // installed VS Code and then failed with "release v<cli version> has no JetBrains .zip asset" —
  // naming a release it never requested. An explicit scope flag still wins.
  const doVscode = only === 'vscode' || (only === 'both' && (!local || vsixArg !== null));
  const doJetbrains = only === 'jetbrains' || (only === 'both' && (!local || zipArg !== null));

  // Resolve the release only when we actually need to download something.
  let latest: string | null = local ? version() : null;
  let assets: ReleaseAsset[] = [];
  if (!local) {
    // `--check` is a DETECTION report, and the thing it reports (which editors are here) needs no
    // network at all. A rate-limited or offline GitHub used to abort the whole command — including on
    // CI runners, where api.github.com answers 403 unauthenticated. So in check mode the lookup is
    // best-effort and an unresolved version is reported as null; an INSTALL still has to fail, because
    // it has nothing to install.
    let list: any[] = [];
    try {
      list = await fetchReleases(true);
    } catch (e: any) {
      if (!checkOnly) throw e;
      process.stderr.write(c.yellow('⚠ ') + `could not reach the release feed: ${e?.message || e}\n`);
    }
    const rel = core.resolveReleaseFromList(list, channel);
    latest = core.versionOfRelease(rel as any);
    assets = ((rel as any)?.assets ?? []) as ReleaseAsset[];
    if (!latest && !checkOnly) fail(`no ${CHANNEL_LABEL[channel]} release found to install from.`);
  }

  if (checkOnly) {
    // --check honours the scope flags too, or `--check --vscode-only` would report a surface the real
    // run is about to skip — the kind of mismatch an installer script would then act on.
    const payload = {
      version: latest,
      channel,
      vscode: only === 'jetbrains' ? [] : editors.map((e) => ({ label: e.label, present: true, cli: e.cli, installed: e.version, actionable: e.cli !== null })),
      jetbrains: only === 'vscode' ? [] : jbDirs.map((d) => ({ dir: d, installed: jbInstalledVersion(path.join(d, JB_PLUGIN_DIRNAME)), actionable: true })),
    };
    if (asJson) return emitJson(payload);
    process.stdout.write(
      `channel: ${CHANNEL_LABEL[channel]}   installing: ${latest ?? '(release feed unavailable)'}\n`
    );
    if (only !== 'jetbrains' && !editors.length) process.stdout.write(c.dim('VS Code family: no editor detected\n'));
    for (const e of only === 'jetbrains' ? [] : editors)
      process.stdout.write(
        (e.cli ? c.green('• ') : c.yellow('⚠ ')) +
          `${e.label}: ${e.version ? `has ${e.version}` : 'extension not installed'}` +
          (e.cli ? '' : " — no CLI found, can't install into it") +
          '\n'
      );
    if (only !== 'vscode' && !jbDirs.length) process.stdout.write(c.dim('JetBrains: no IDE detected\n'));
    for (const d of only === 'vscode' ? [] : jbDirs) {
      const v = jbInstalledVersion(path.join(d, JB_PLUGIN_DIRNAME));
      process.stdout.write(c.green('• ') + `JetBrains: ${v ? `has ${v}` : 'plugin not installed'} (${d})\n`);
    }
    return;
  }

  // Past the --check return, an install needs a version. The `!latest && !checkOnly` fail above already
  // guarantees one; this names it so the rest of the function is not littered with non-null assertions.
  if (!latest) fail(`no ${CHANNEL_LABEL[channel]} release found to install from.`);
  const target: string = latest;

  if (requested !== null && requested !== core.getUpdateChannel()) {
    core.setUpdateChannel(requested);
    process.stdout.write(c.green('✓ ') + `following the ${CHANNEL_LABEL[requested]} channel\n`);
  }

  let did = 0;
  let blocked = 0;
  let detected = 0; // surfaces that exist at all — distinguishes "nothing here" from "all current"

  if (doVscode) {
    // The SAME rule core.resolveUpdatePlan applies for `update`: follow the channel in either
    // direction, so a version DIFFERENCE is the trigger, not `isNewer`. The old gate refused to
    // touch anything sitting ABOVE the channel's release, which is exactly how a locally-built
    // 0.10.0 became permanently "already current" on every channel. `!==` cannot loop: once
    // installed === target the next run is a no-op.
    const stale = (installed: string | null) =>
      force || vsixArg !== null || installed === null || core.compareVersions(installed, target) !== 0;
    const actionable = editors.filter((e) => e.cli && stale(e.version));
    const noCli = editors.filter((e) => !e.cli);
    for (const e of noCli) {
      // Never a silent skip: the editor is here, we just cannot drive it.
      process.stdout.write(
        c.yellow('  ⚠ ') +
          `${e.label} is installed but its CLI wasn't found — can't install into it.\n` +
          c.dim(`    Fix: in ${e.label}, ⇧⌘P → "Shell Command: Install '${e.cliName}' command in PATH", then re-run.\n`)
      );
      blocked++;
    }
    detected += editors.length;
    // Guard on whether an editor EXISTS, not on whether there is work: everything-already-current is
    // the common case on a re-run (which is how the docs say to update), and it was reporting
    // "no editor detected" — while the truthful line was reachable only on runs that also failed.
    if (!editors.length) process.stdout.write(c.dim('VS Code family: no editor detected — skipped.\n'));
    else if (!actionable.length && !noCli.length) process.stdout.write(c.green('✓ ') + `VS Code family already at ${target}\n`);
    else {
      let src = vsixArg;
      if (src === null) {
        const vsix = assets.find((a) => /\.vsix$/i.test(a.name));
        if (!vsix) fail(`release v${target} has no .vsix asset to install.`);
        src = await downloadAsset(vsix!);
      }
      const n = applyVsix(actionable, src, target);
      did += n;
      blocked += actionable.length - n;
    }
  }

  if (doJetbrains) {
    detected += jbDirs.length;
    if (!jbDirs.length) process.stdout.write(c.dim('JetBrains: no IDE detected — skipped.\n'));
    else if (!zipToolReady()) blocked++;
    else {
      const targets = jbDirs.filter((d) => {
        if (force || zipArg !== null) return true;
        const v = jbInstalledVersion(path.join(d, JB_PLUGIN_DIRNAME));
        if (v === null) return true;
        return core.compareVersions(v, target) !== 0; // follow the channel, either direction
      });
      if (!targets.length) process.stdout.write(c.green('✓ ') + `JetBrains plugin already at ${target}\n`);
      else {
        let src = zipArg;
        if (src === null) {
          const zip = core.assetFor(assets, 'jetbrains');
          if (!zip) fail(`release v${target} has no JetBrains .zip asset to install.`);
          src = await downloadAsset(zip!);
        }
        const n = applyJetbrainsZip(targets, src, target);
        did += n;
        blocked += targets.length - n;
      }
    }
  }

  if (blocked) {
    // Same rule as `update`: a surface we could not do is a FAILURE, reported on stderr where an
    // editor or a CI log will actually find it.
    process.stderr.write(c.yellow('⚠ ') + `${blocked} surface(s) could not be installed — see the notes above.\n`);
    process.exitCode = 1;
    return;
  }
  if (local) {
    if (!doVscode && editors.length)
      process.stdout.write(c.dim(`VS Code family: skipped — no --vsix given (${editors.length} editor(s) detected).\n`));
    if (!doJetbrains && jbDirs.length)
      process.stdout.write(
        c.dim(`JetBrains: skipped — no --jetbrains-zip given (${jbDirs.length} IDE(s) detected).\n`) +
          c.dim('  From a source checkout: ./install.sh --jetbrains\n')
      );
  }
  if (!detected) {
    // An explicit scope is a statement of intent: you asked for THIS family, so finding none of it is a
    // failed expectation, not a quiet success. Unscoped (what bootstrap.sh does) a terminal-only box is
    // a perfectly good outcome, so that stays exit 0.
    const what = only === 'vscode' ? 'VS Code-family editor' : only === 'jetbrains' ? 'JetBrains IDE' : 'editor';
    if (only === 'both') {
      process.stdout.write(c.dim(`no ${what} detected on this machine — nothing to install.\n`));
      return;
    }
    process.stderr.write(c.yellow('⚠ ') + `no ${what} found on this machine — nothing was installed.\n`);
    process.exitCode = 1;
    return;
  }
  if (!did) process.stdout.write(c.green('✓ ') + 'nothing to install — every detected editor is already current.\n');
}

/** Write the channel choice, once the installs that follow it have actually been attempted. Silent
 *  when nothing changed. Kept a function so BOTH exits from `cmdUpdate` (--cli-only and the full
 *  run) persist at the same point in the sequence, rather than one of them doing it early. */
function persistChannel(requested: 'stable' | 'dev' | null): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  if (requested === null || requested === core.getUpdateChannel()) return;
  core.setUpdateChannel(requested);
  process.stdout.write(c.green('✓ ') + `switched to the ${CHANNEL_LABEL[requested]} channel\n`);
}

/**
 * The herdr pin moves WITH oak. A release that bumps `herdr.lock` and leaves the old binary on disk
 * would have the adapter talking to a protocol it was not built against — the one drift this pin
 * exists to prevent.
 *
 * `startServer: false` on purpose: an update is not a request to launch something. A server that is
 * already running keeps running (herdr's own `status` reports the stale binary), and the installers
 * and `oak doctor --fix` are where a server gets started.
 *
 * Never fatal. The CLI update itself already succeeded; herdr's state is reported, not enforced.
 */
async function ensureHerdrPin(): Promise<void> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  try {
    const report = await core.ensureHerdr({ startServer: false });
    if (report.upgraded) process.stdout.write(c.green('✓ ') + `herdr ${report.version} installed (pinned by herdr.lock)\n`);
    if (report.sidebarConfigured) process.stdout.write(c.green('✓ ') + `herdr sidebar widths set in its config.toml (a backup sits beside it)\n`);
    if (report.themeConfigured) process.stdout.write(c.green('✓ ') + `herdr theme: gruvbox (set)\n`);
    for (const w of report.warnings) process.stdout.write(c.yellow('⚠ ') + w + '\n');
  } catch (e) {
    process.stderr.write(
      c.yellow('⚠ ') + `could not verify herdr: ${String((e as Error)?.message || e)} — run \`oak doctor --fix\`\n`
    );
  }
}

async function cmdUpdate(args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const current = version();
  const cliOnly = args.includes('--cli-only');
  const checkOnly = args.includes('--check');
  const force = args.includes('--force');
  const json = args.includes('--json');
  // --channel <stable|dev>: SWITCH channels — persist the choice and install that channel's newest
  // in the same breath (a switch installs even when the target version isn't "newer": moving from a
  // dev build back to stable is a downgrade by semver and must still happen).
  const chI = args.indexOf('--channel');
  const chRaw = flagValue(args, '--channel');
  if (chI >= 0 && !chRaw) fail('`update --channel <stable|dev>` requires a value');
  const requested = chRaw ? core.normalizeChannel(chRaw) : null;
  if (chRaw && !requested) fail(`unknown channel "${chRaw}" — use stable or dev (pre-release)`);
  const switching = requested !== null && requested !== core.getUpdateChannel();
  const channel = requested ?? core.getUpdateChannel();

  const releases = await fetchReleases();
  // ONE decision for every surface, in core: a surface is acted on when its installed version
  // DIFFERS from the channel's newest — in either direction. `isNewer` could not express the
  // downgrade half of a channel switch, and it silently ignored anything sitting ABOVE the channel
  // line (a local build at 0.10.0 outranks every 0.10.0-dev.N the dev channel publishes).
  const surfaces = cliOnly ? installedSurfaces().filter((s) => s.surface === 'cli') : installedSurfaces();
  const plan = core.resolveUpdatePlan(releases, channel, surfaces, { switching, force });
  if (!plan.release) fail('no published release found for the repository.');
  if (plan.degradedToStable)
    process.stdout.write(c.dim(releases.some((r: any) => r?.prerelease === true && !r?.draft)
      ? 'the stable release outranks the newest pre-release, so the pre-release channel serves it.\n'
      : 'no pre-release published yet — the stable release is the newest there is.\n'));
  const latest = plan.target;
  const assets: ReleaseAsset[] = (plan.release as any).assets || [];
  const cliSurface = plan.surfaces.find((s) => s.surface === 'cli');
  const cliStale = cliSurface !== undefined && cliSurface.reason !== 'current';

  if (json) {
    // The STRUCTURED hand-off, and deliberately READ-ONLY: `--json` reports the plan and changes
    // nothing, whether or not `--check` was passed. The editors used to infer what happened by
    // grepping this command's prose (`out.includes('everything is up to date')`), which is how a
    // real switch could toast "nothing to reload". They now read the plan, do their own part, run
    // the plain command for the rest, and READ THE PLAN AGAIN to see the result — an outcome that
    // was observed rather than one that was claimed.
    emitJson({
      channel,
      following: core.getUpdateChannel(),
      switching,
      target: latest,
      degradedToStable: plan.degradedToStable,
      surfaces: plan.surfaces.map((s) => ({
        surface: s.surface,
        label: s.label,
        from: s.from,
        to: s.to,
        reason: s.reason,
        actionable: s.actionable,
      })),
      upToDate: plan.actions.length === 0,
    });
    return;
  }

  if (checkOnly) {
    // A PREVIEW is honest about being one: `--check --channel dev` shows what the switch WOULD do —
    // it never persists, and the closing hint names the command that actually applies it.
    process.stdout.write(
      c.dim(
        switching
          ? `channel: ${CHANNEL_LABEL[channel]} (previewing — you follow ${CHANNEL_LABEL[core.getUpdateChannel()]}; nothing switched)\n`
          : `channel: ${CHANNEL_LABEL[channel]}\n`
      )
    );
    for (const s of plan.surfaces) {
      if (s.reason === 'current') {
        process.stdout.write(c.green(`${s.label}: up to date (${s.from})\n`));
        continue;
      }
      // `update` refreshes only what is ALREADY installed; putting a present-but-empty editor in the
      // action list would promise an install this command is about to skip on purpose.
      if (s.reason === 'missing') {
        process.stdout.write(c.dim(`${s.label}: not installed — \`oak install-extensions\` adds it\n`));
        continue;
      }
      // 'ahead' is its own sentence. Reading "0.10.0 → 0.9.5" as an update is confusing; reading it
      // as nothing at all is what stranded people for weeks.
      const how = s.reason === 'ahead' ? ' (not on this channel — will be replaced)' : '';
      process.stdout.write(
        c.yellow(`${s.label}: ${s.from} → ${latest}${how}`) +
          (s.actionable ? '\n' : c.yellow(`  (installed but no CLI found to update — install the shell \`${(s.ref as EditorRow)?.cliName || 'code'}\` command)\n`))
      );
    }
    if (!cliOnly) {
      if (!plan.surfaces.some((s) => s.surface === 'vscode')) process.stdout.write(c.dim('VS Code: extension not detected\n'));
      if (!plan.surfaces.some((s) => s.surface === 'jetbrains')) process.stdout.write(c.dim('JetBrains: plugin not detected\n'));
    }
    if (channel === 'stable') {
      // The pre-release channel's tip, one dim line — the list is already in hand, and this is the
      // only place a stable user learns the channel exists from the terminal.
      const pre: any = releases.find((r: any) => r?.prerelease === true && !r?.draft);
      const preVer = core.versionOfRelease(pre);
      if (preVer)
        process.stdout.write(c.dim(`pre-release channel: ${preVer} — switch with \`oak update --channel dev\`\n`));
    }
    process.stdout.write(
      c.dim(switching ? `run \`oak update --channel ${requested}\` to apply.\n` : 'run `oak update` to apply.\n')
    );
    return;
  }

  if (cliOnly) {
    if (cliStale) await updateCliBinary(assets, latest, current);
    else process.stdout.write(c.green('✓ ') + `oak CLI is up to date (${current})\n`);
    persistChannel(requested);
    if (cliStale) finishInInstalledCli();
    else await ensureHerdrPin();
    return;
  }

  if (cliStale) await updateCliBinary(assets, latest, current); // refreshes the status line itself
  else refreshInstalledStatusline(); // CLI already current — still heal a statusline.sh an older CLI wrote
  const vscode = await refreshVscodeExtension(assets, plan);
  const jetbrains = await refreshJetbrainsPlugin(assets, plan);
  // Persist the switch AFTER the installs, not before. Doing it first meant a blocked install left
  // the config naming one channel while the binaries came from the other — the split-brain the
  // channel file is supposed to make impossible — and the failure toast made it look like nothing
  // had happened at all.
  persistChannel(requested);
  if (cliStale) finishInInstalledCli();
  else await ensureHerdrPin();
  if (vscode === 'blocked' || jetbrains === 'blocked') {
    // Something is installed but couldn't be updated — never let this pass as success/silence.
    // On STDERR, not stdout: this is the failure reason, and an editor surfacing this run reads
    // stderr first. Reported as #45, where the only thing on stderr was a Node deprecation warning,
    // so the toast showed the warning and the person never saw this line at all.
    const which = [vscode === 'blocked' ? 'the VS Code extension' : null, jetbrains === 'blocked' ? 'the JetBrains plugin' : null]
      .filter(Boolean)
      .join(' and ');
    process.stderr.write(c.yellow('⚠ ') + `could not update ${which} — see the notes above.\n`);
    process.exitCode = 1;
    return;
  }
  if (!(cliStale || vscode === 'updated' || jetbrains === 'updated')) {
    if (vscode === 'absent' && jetbrains === 'absent') {
      process.stdout.write(
        c.green('✓ ') +
          `CLI is up to date (${latest}); no editor extensions detected locally.\n` +
          c.dim('  install the VS Code / JetBrains extensions via scripts/bootstrap.sh or the release assets.\n')
      );
    } else {
      process.stdout.write(
        c.green('✓ ') + `everything is up to date (${latest}${channel === 'dev' ? ', pre-release channel' : ''})\n`
      );
    }
  }
}

/** `version` — print the installed CLI version; with `--check` (or `--latest`), also fetch the newest
 *  GitHub Release live (not the daily cache) and say whether an update is available. The flag forms
 *  `-v` / `--version` stay a pure one-line print so scripts can rely on them. */
async function cmdVersion(args: string[]): Promise<void> {
  const cur = version();
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const json = args.includes('--json');
  if (!(args.includes('--check') || args.includes('--latest'))) {
    // Network-free forms. `--json` is what the editors' version chip renders BEFORE any fetch:
    // the installed version + the followed channel, instantly.
    if (json) {
      emitJson({ current: cur, channel: core.getUpdateChannel() });
      return;
    }
    process.stdout.write(`oak ${cur}\n`);
    return;
  }
  const channel = core.getUpdateChannel();
  const releases = await fetchReleases();
  const pick = (ch: 'stable' | 'dev') => {
    const r: any = core.resolveReleaseFromList(releases, ch);
    // dev falls back to stable when no prerelease exists — report null instead, so a consumer can
    // tell "no pre-release published" apart from "the pre-release equals stable".
    return ch === 'dev' && r && r.prerelease !== true ? null : core.versionOfRelease(r);
  };
  const stableLatest = pick('stable');
  const devLatest = pick('dev');
  const latest = (channel === 'dev' ? devLatest ?? stableLatest : stableLatest) ?? '';
  if (!latest) fail('no published release found for the repository.');
  writeUpdateCache({
    checkedMs: Date.now(),
    latestTag: stableLatest,
    latestDevTag: devLatest,
  }); // an explicit check also freshens the daily nudge
  // Following a channel means MATCHING it, so any difference is actionable — not just a higher
  // number. `stranded` is the difference that points the other way: an install sitting ABOVE the
  // channel (a local build, or a channel just switched downward), which the old isNewer check read
  // as "up to date" and left there permanently.
  const cmp = core.compareVersions(latest, cur);
  const differs = cmp !== 0;
  const stranded = cmp < 0;
  if (json) {
    // The editors' version dropdown: one call answers the chip, the Update row, and both channel rows.
    emitJson({ current: cur, channel, latest, updateAvailable: differs, stranded, stableLatest, devLatest });
    return;
  }
  process.stdout.write(
    `installed   ${c.bold(cur)}   ${c.dim(`(${CHANNEL_LABEL[channel]} channel)`)}\n` +
      `latest      ${c.bold(latest)}   ${differs ? c.yellow(stranded ? '← not on this channel' : '← update available') : c.green('✓ up to date')}\n` +
      (channel === 'stable' && devLatest ? c.dim(`pre-release ${devLatest}   (switch: \`update --channel dev\`)\n`) : '')
  );
  if (stranded) {
    process.stdout.write(
      c.dim(`the installed build is newer than anything the ${CHANNEL_LABEL[channel]} channel publishes — probably a local build.\n`) +
        c.dim('run `oak update` to move onto the channel, or switch channels with `update --channel dev`.\n')
    );
  } else if (differs) {
    process.stdout.write(c.dim('run `oak update` to apply, or `update --check` to see every surface.\n'));
  }
}

function usage(): void {
  process.stdout.write(
    `oak — per-edit Keep/Undo for Claude Code\n\n` +
      `  init [--project] [--with-statusline] [--force] [--repair] [--no-codex]\n` +
      `                       install capture hooks (--project = repo ./.claude/settings.json;\n` +
      `                       --with-statusline also installs the bundled status line; --repair\n` +
      `                       re-canonicalizes every recorded install — the fix for doubled hooks\n` +
      `                       left by older versions)\n` +
      `  init --codex [--no-verify]\n` +
      `                       install capture hooks for codex (~/.codex/hooks.json + trust state;\n` +
      `                       foreign entries preserved); checks hooks.json + trust locally, no model\n` +
      `                       run — codex skips untrusted hooks silently, so status re-checks them\n` +
      `  statusline [--force] install/refresh the bundled claude-statusline (usage bars; needs bash+jq);\n` +
      `                       refuses to replace another tool's statusLine unless --force\n` +
      `  uninstall [--project] [--all] [--purge-store]\n` +
      `                       remove the capture hooks from every install-ledger location (--project =\n` +
      `                       only this repo's file; --all also reverts the bundled status line +\n` +
      `                       prints teardown steps; --purge-store also deletes the stored edits)\n` +
      `  status               show hooks + hook-path health + session + edit counts\n` +
      `  integrity [--session <id>] [--json]  inspect capture gaps and unsafe history; read-only\n` +
      `  doctor [--json] [--fix]\n` +
      `                       diagnose setup (hooks, PATH, config dir, session, status line, herdr,\n` +
      `                       the herdr server's environment) with fixes; --markdown (--md) emits the\n` +
      `                       report as Markdown; --fix installs the pinned herdr, its claude + codex\n` +
      `                       integrations and OAK's plugin, sets missing sidebar widths and theme\n` +
      `                       defaults (gruvbox), starts its server, repairs PTY helper permissions\n` +
      `                       and stops outdated focus servers; reports slow SSH forwarding for saved machines\n` +
      `  models [use <name>]\n` +
      `                       local models: list what ollama serves here and which one codex runs\n` +
      `                       (a fresh \`ollama pull\` appears with nothing to reinstall — capture is\n` +
      `                       model-independent); \`use\` pulls it if missing, wires codex to it\n` +
      `                       (surgical config edit + .bak), and verifies with one live turn\n` +
      `  install-extensions [--check] [--json] [--force] [--channel stable|dev]\n` +
      `                       install the editor extensions into whatever editors are on this machine\n` +
      `                       (VS Code family + JetBrains); --vsix/--jetbrains-zip use local build\n` +
      `                       outputs instead of the release; --check reports without installing\n` +
      `  update [--check] [--json] [--cli-only] [--force] [--channel stable|dev]\n` +
      `                       update the CLI AND refresh the locally-installed editor extensions from\n` +
      `                       the followed release channel (VS Code via \`code --install-extension\`;\n` +
      `                       JetBrains by unzip into plugin dirs), and refresh the bundled status\n` +
      `                       line when ours is installed. A surface is updated whenever it DIFFERS\n` +
      `                       from the channel's newest — including builds newer than it, which is\n` +
      `                       what makes switching channels work in both directions. --check reports\n` +
      `                       only; --json reports the plan as JSON and changes nothing; --cli-only\n` +
      `                       skips the extensions; --force reinstalls even if already current;\n` +
      `                       --channel switches between stable and the rolling pre-release (dev)\n` +
      `                       and installs that channel's newest in the same run\n` +
      `  sessions [--delete <id> [--force | --force-pending <n>] [--seen-through <edit>] | --undelete <id>]\n` +
      `                       this machine's sessions, grouped by workspace (● = this directory's), without\n` +
      `                       those in which nothing happened (no edit, no tokens, no reply) unless still running;\n` +
      `                       --json --machine <label|id> reads one machine's own captured sessions over SSH;\n` +
      `                       delete hides a session and purges stored edits (pending ones only with --force,\n` +
      `                       or with --force-pending <n> while no more than n are pending); --seen-through\n` +
      `                       <edit> also refuses while an edit newer than that id is pending;\n` +
      `                       undelete restores visibility, not the purged edits\n` +
      `  prompt --session <id> --text "…" [--machine <label>] [--json]  explicitly submit to its live pane;\n` +
      `                       without a live pane, retain the clipboard draft and print it\n` +
      `  comment add|list|rm|compose|send|mark-sent --session <id>  add --edit <n> [--line <n>] --text "…";\n` +
      `                       compose prints an unsent draft; send submits it and marks only acknowledged\n` +
      `                       comments sent; mark-sent --ids <a,b> records a reply delivered another way.\n` +
      `                       --json reports the result; --text=--note preserves text beginning with dashes\n` +
      `  quote --session <id> [--text "note"] [--send] [--json]  quote the latest transcript reply;\n` +
      `                       default is a draft; --send explicitly submits it through herdr\n` +
      `  focus --session <id> --tab observatory|review|herdr  select a conversation in an attached OAK TUI\n` +
      `                       --pane <id> resolves a live herdr pane to its session\n` +
      `  server start|stop|status [--json]  local focus endpoint; herdr owns terminals and agents\n` +
      `  inbox [--json]       every session waiting on you, most urgent first — permission prompts, questions\n` +
      `                       (with their options), input waits, then finished turns; --next [--after <id>]\n` +
      `                       names the one to jump to. Review tab: i opens the inbox, h jumps to the next session;\n` +
      `                       on Observatory, i replies and h focuses herdr\n` +
      `  search <words…>      every conversation on this machine, ranked: the asks you typed and the prose that\n` +
      `                       answered them, across sessions and workspaces (every word must appear; a hit in\n` +
      `                       the ask outranks one in the answer); --days <N>, --limit <N>, --json\n` +
      `  notify               desktop notifications for raised hands: --message <text> [--title <t>] [--sound]\n` +
      `                       pops one; --watch [--interval <s>] announces every hand this workspace raises\n` +
      `                       (from a plain terminal with no editor open); the editors announce in-process\n` +
      `  agent start --kind claude|codex [--cwd <dir>] [--machine <label>]  spin an agent up (add --machine to run it on a remote and attach)\n` +
      `  attach [machine]          attach this terminal to herdr here, or on a saved machine over SSH (tmux-style)\n` +
      `  machine add <label> <ssh-target> | machine list [--json]\n` +
      `                       the machines herdr runs agents on: add installs the version pinned in herdr.lock\n` +
      `                       over ssh (checksum-verified) and saves it non-interactively; a newer local herdr is left alone.\n` +
      `                       list is herdr's own machine list\n` +
      `  <verb> … --machine <label>\n` +
      `                       views, review, list, sessions, conversation, feed, multitask, subagents, diff,\n` +
      `                       keep, undo, redo, resolve, comment, quote and ignore run on that saved machine over ssh.\n` +
      `                       Its own oak answers (from ~/.local/bin, /opt/homebrew/bin or\n` +
      `                       /usr/local/bin), in the session's own workspace there, with output and exit\n` +
      `                       status passed back unchanged. Review (its session picker lists every saved\n` +
      `                       machine's sessions; --session and --once too) and Observatory read sessions on\n` +
      `                       their owning machine.\n` +
      `                       OAK_MACHINE_TIMEOUT_MS overrides the 120-second command deadline; unit and\n` +
      `                       mark-sent operations and conversations require a compatible remote build\n` +
      `  list [filters]       list edits (grouped by file); filters: --pending|--kept|--undone, --file <substr>\n` +
      `  timeline [--json]    edits newest-first as a chronological feed (time · id · Δ · file)\n` +
      `  actions [--json]     the full action timeline: EVERY tool call Claude made (reads, greps, bash,\n` +
      `                       web, subagents, to-dos), each with its result (alias: trace); --category <c> | --errors | --limit <n>\n` +

      `  egress [--json]      what this session reached beyond here: web hosts, MCP servers, network shell,\n` +
      `                       and the files it READ from outside the workspace (--root <d>)\n` +
      `  risk [--json]        shell commands that can destroy data / escalate privilege / touch secrets,\n` +
      `                       plus the edits that landed OUTSIDE the workspace (--all, --root <d>)\n` +
      `                       (with risk tiers), MCP servers, network, subagents — exercised, not approved\n` +
      `  processes [--json]   background shells this session left running (runtime · exit code · output);\n` +
      `                       --id <shell> shows one shell's full command + a tail of its output\n` +
      `  prompts [--json]     the session as the list of things YOU asked for, each with the edits,\n` +
      `                       files, folders, tokens, agents, workflows, tasks and shells it produced;\n` +
      `                       --id <n> drills into one; --id <n> --response prints Claude’s reply to it\n` +
      `  review [--prompt <n>] the session's work as review units, each with its net patch — repeated\n` +
      `                       edits to the same code read as one change; --prompt <id|index> scopes to\n` +
      `                       one ask; --pending hides resolved units; --no-patch for metadata only\n` +
      `  feed [--json]        what ONE thing is doing now — a tail of its activity;\n` +
      `                       --kind session|agent|workflow|task|process --id <id> [--limit <n>]\n` +
      `  subagents [--json]   every subagent this session spawned, each with its own action timeline + metrics (alias: agents)\n` +
      `  siblings [--json]    the other Claude Code sessions in THIS project (active/idle · pending · files · risk);\n` +
      `                       agent-facing digest for cross-agent awareness (alias: fleet); --all includes self;\n` +
      `                       --repo widens to every WORKTREE of the repo (adds worktree/branch/phase + conflicts)\n` +
      `  multitask                the multi-agent view: one row per running agent across every worktree (live phase,\n` +
      `                       sparkline, ±lines, risk) + nested subagents (phase/current task) + live file conflicts\n` +
      `  tasklog                    cross-agent task log: one row per stable taskId, unioned across worktrees + subagents\n` +
      `  metrics [--json]     session numbers: ±lines, action/error counts, subagent duration/tokens, tool latency\n` +
      `  diff <id> [--json]   show before/after; JSON carries session, id, file and patch\n` +
      `  keep <id>            keep the whole change (review unit) edit <id> belongs to;\n` +
      `                       bulk: --all | --file <substr> | --under <path> | --ids <a,b,c>\n` +
      `                       an id and a bulk flag are mutually exclusive (they mean different things)\n` +
      `  undo <id> [--force]  surgically undo the whole change edit <id> belongs to (--force = per-file restore);\n` +
      `                       bulk (pending only): --all | --file <substr> | --under <path> | --ids <a,b,c>\n` +
      `                       --from-prompt <id> rewinds that ask and everything after it\n` +
      `                       (add --dry-run to count what it would revert without touching disk)\n` +
      `                       an id and a bulk flag are mutually exclusive\n` +
      `  redo <id> [--force]  re-apply the whole undone change edit <id> belongs to;\n` +
      `                       bulk (undone only): --all | --file <substr> | --under <path> | --ids <a,b,c>\n` +
      `                       --from-prompt <id> re-applies EVERY undone edit from that ask onward — including\n` +
      `                       ones you had reverted before the rewind. To restore only what one rewind moved,\n` +
      `                       pass that rewind's --json ids to --ids (what the editors' Redo button does)\n` +
      `                       an id and a bulk flag are mutually exclusive\n` +
      `                       keep, undo and redo: --ids <a,b,c> acts on those edits alone; add --units to\n` +
      `                       widen each id to its whole review unit, as a single <id> does\n` +
      `                       undo and redo: --ids <a,b,c> --record-only records what an undo or redo already\n` +
      `                       did on disk without touching a file (the repair a "not recorded" report names)\n` +
      `  oplog [--json]       YOUR bulk operations (keeps, reverts, redos), journaled with before-images,\n` +
      `                       newest first; --revert-last reverses the most recent one — statuses\n` +
      `                       restored for a keep, files rewritten for a revert/redo\n` +
      `  assign --ids <a,b,c> --prompt <id|index>   move those edits' PROMPT attribution — every\n` +
      `                       surface follows (prompts, change map, review, rewind scopes); units\n` +
      `                       keep their temporal boundaries. --clear restores the recorded window\n` +
      `  task-keep <taskId>   keep every pending edit in a task's strict in-progress span (--json)\n` +
      `  task-undo <taskId>   revert every pending edit in a task's strict in-progress span (--json)\n` +
      `  task-clear <taskId>  drop a task's resolved (kept/undone) edits (--json);\n` +
      `                       --completed clears every settled task (edits present, all kept)\n` +
      `  demo [--fast] [--speed <n>] [--dir <folder>] [--no-fleet] [--json]\n` +
      `                       simulate a Claude session LIVE in an isolated demo-* session and folder:\n` +
      `                       a real transcript + captured edits + a subagent + a three-phase workflow\n` +
      `                       + a second agent in a sibling worktree — watch every panel update, then\n` +
      `                       review/undo for real; --fast for scripts/tests, --no-fleet for one agent.\n` +
      `                       Running it again RESETS the demo (it replaces any previous demo here)\n` +
      `  demo --tour [--essentials | --remainder] [--json]\n` +
      `                       the guided tour: what to look at, panel by panel. --essentials is the\n` +
      `                       short track through the same script; --remainder is its exact complement\n` +
      `  demo --touch [--json]  keep a running demo inside the fleet's active window (mtime only)\n` +
      `  demo --clean [--json]  remove every trace (both sessions, stores, demo folder, scratch dir)\n` +
      `  demo --status [--json] whether a demo is recorded for this folder\n` +
      `  resolve [--session <id>]  accept every pending edit in a session, then clear its records; --json\n` +
      `  warm [--root <d>]    pre-build recent sessions so switching to one is instant (--since <dur>); --json\n` +
      `  store [--move <dir> | --default] [--json]\n` +
      `                       show or move the observatory store; --default returns it to its default location\n` +
      `  clean [opts]         GC orphaned blobs (--session <id> scopes; --json for structured output);\n` +
      `                       --drop <id> | --older-than <Nd> | --all | --resolved [--under <path> | --ids <a,b,c>]\n` +
      `                       --completed [--stale <Nd>] [--dry-run]  drop FINISHED sessions (nothing\n` +
      `                       left to review) and ABANDONED ones (unreviewed but dead >14d; their edits\n` +
      `                       are discarded) — --dry-run lists what would go without dropping anything\n` +
      `                       --phantoms [--session <id>]  remove Windows path-case phantom pairs (#43)\n` +
      `  stats [--json]       usage stats (edits/tokens/messages/thinking/output) by session & window\n` +
      `  summary [--markdown] per-session review recap (kept/reverted per file); --markdown to export\n` +
      `  export [--out <f>]   the FULL session trace as JSON — every edit with its diff, skips, prompts,\n` +
      `                       actions, tasks, subagents, egress, outside writes, observations, usage\n` +
      `  insights [--json]    Observations view: recap + per-edit reasoning/flags/file-memory + next steps\n` +
      `  ignore [--json]      what .observatoryignore is hiding in this session, and which files set it\n` +
      `  ignore --check <p>... [-v] [-n] [-z] [-q] [--stdin] [--json]   why each path is shown / hidden /\n` +
      `                       refused — names the rule, its file and its line (and the excluded ancestor,\n` +
      `                       when that is what decided). Takes git check-ignore's flags and its exit\n` +
      `                       codes: 0 when a path is ignored, 1 when none are; -v prints git's\n` +
      `                       <source>:<line>:<pattern><TAB><path> machine format\n` +
      `  tui [--session <id>] [--root <d>] [--tick <s>] [--once] [--no-color] [--no-mouse]\n` +
      `       [--cols N] [--rows N]\n` +
      `                       herdr · Observatory · Review; --tab herdr|observatory|review selects a tab\n` +
      `                       Observatory: arrows preview (Review follows), Enter pins, i replies,\n` +
      `                       h focuses herdr, r reviews, Shift+A includes archived sessions.\n` +
      `                       Review: a keep, u undo.\n` +
      `                       Leader (default ctrl+a) then o opens herdr's focused conversation.\n` +
      `                       Herdr's tab bar starts agents; ctrl+a n/p or 1-3 switches OAK tabs.\n` +
      `                       Ctrl+q twice quits OAK on every tab (repeat within two seconds).\n` +
      `                       Ctrl+a q twice also quits OAK, including from the herdr tab.\n` +
      `                       ? lists keys; Options rebinds them. --once prints one frame.\n\n` +
      `machine-readable (for front-ends/scripts; list/status/sessions/keep/undo/redo also take --json):\n` +
      `  blob <sha>           raw blob bytes to stdout\n` +
      `  tree [--root <d>] [--filter <q>]   folder→file→class→edit view-model as JSON (both editors)\n` +
      `  changemap [--root <d>]             session change-map (edits + per-file/per-folder rollups + per-agent slices) as JSON\n` +
      `  conversation --session <id> [--limit N] [--since <cursor>] [--machine <label>] --json\n` +
      `                       transcript conversation as renderer-ready updates; returns the next byte cursor.\n` +
      `                       --limit N is the last N TURNS of an initial read (default 50); \`truncated\`\n` +
      `                       reports the bytes cut above them (0 = the whole transcript). --since delivers\n` +
      `                       EVERY record appended after that cursor, whatever the limit; \`reset\`: true\n` +
      `                       means the transcript was replaced, so redraw from these events, never append\n` +
      `  views [--views <a,b,c>] [--root <d>]\n` +
      `                       run several READ-ONLY views in ONE process and emit {name: payload} —\n` +
      `                       each is byte-identical to its own command. Default set: changemap,\n` +
      `                       multitask, prompts, processes, sessions, observations, risk, egress;\n` +
      `                       stats is accepted by name too, though nothing batches it by default.\n` +
      `                       A view that fails is null rather than fatal to the batch; a mutating\n` +
      `                       verb is refused. The JetBrains Overview polls its eight views through it.\n` +
      `  chat-context [--tool-use-id <id> | --edit <n> | --agent <id> | --task <id>]\n` +
      `                       assemble a zero-token, ready-to-paste chat prompt about an action/edit/subagent/task\n` +
      `  locate --file <f>    per-pending-edit line indices in the live buffer (text on stdin; JSON out)\n` +
      `  observe              recap + per-edit reasoning/flags/memory as JSON\n` +
      `  observations [--root <d>]   Observations view-model: recap + timeline runs (adjacent same-file\n` +
      `                       edits coalesced ×N, each with reasoning) + next steps, as JSON\n` +
      `  usage                ctx / 5h / week snapshot + session token split + model/effort/compaction\n` +
      `                       vitals, as JSON; --breakdown [--by week|month|model|session]\n` +
      `                       [--agent claude|codex|both] [--weeks N]; --bill-day N anchors Claude month\n` +
      `                       figures to your bill cycle, --gpt-bill-day N does the same for GPT (0 clears)\n` +
      `  titles [--json] [--refresh] [--off | --on]\n` +
      `                       Remote Control titles read from claude.ai, so sessions carry the names the\n` +
      `                       Claude app shows: the last refresh and what it cached; --refresh reads now;\n` +
      `                       --off stops the reads and drops the cache, --on resumes them\n\n` +
      `opt-in, token-spending (runs \`claude -p\`; returns the cached result unless --fresh):\n` +
      `  analyze <id>         deep-analyze one edit    [--json --fresh --claude-bin <path>]\n` +
      `  recap                one-line session recap   [--json --fresh --claude-bin <path>]\n` +
      `  suggest              next-steps + suggestions [--json --fresh --claude-bin <path>]\n\n` +
      `  --session <id>       target a specific session instead of the newest\n` +
      `  version [--check] [--json]\n` +
      `                       print the installed version (--json adds the channel); --check (or --latest)\n` +
      `                       also shows the newest release of BOTH channels (--json feeds the editors' chip)\n` +
      `  --version            print the installed CLI version\n`
  );
}

// --- once-a-day "update available" nudge -------------------------------------------------------
// Cache-first + detached refresh (like npm's update-notifier): reading the cache is synchronous and
// offline-safe, so a real command is NEVER delayed; the network check runs in a detached child that
// fills the cache for the NEXT run. Only for interactive (TTY) human invocations — never the capture
// hot path, `--json` output, or the JetBrains plugin. Opt out: CLAUDE_OBSERVATORY_NO_UPDATE_CHECK=1.

type UpdateCache = { checkedMs: number; latestTag: string | null; latestDevTag?: string | null };

function updateCachePath(): string {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  return require('path').join(core.rootDir(), '.update-check');
}

function readUpdateCache(): UpdateCache | null {
  try {
    const j = JSON.parse(require('fs').readFileSync(updateCachePath(), 'utf8'));
    if (typeof j?.checkedMs === 'number') {
      return {
        checkedMs: j.checkedMs,
        latestTag: typeof j.latestTag === 'string' ? j.latestTag : null,
        latestDevTag: typeof j.latestDevTag === 'string' ? j.latestDevTag : null,
      };
    }
  } catch {
    /* no cache yet / unreadable — treated as "never checked" */
  }
  return null;
}

function writeUpdateCache(v: UpdateCache): void {
  try {
    const fs = require('fs');
    const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
    fs.mkdirSync(core.rootDir(), { recursive: true });
    fs.writeFileSync(updateCachePath(), JSON.stringify(v));
  } catch {
    /* best-effort — the nudge is non-essential, never fail a command over it */
  }
}

/** The internal `__update-check` command (spawned detached): fetch the latest release tag and cache it.
 *  Prints nothing; failures are swallowed so an offline machine just keeps the previous cached tag. */
async function refreshUpdateCache(): Promise<void> {
  try {
    const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
    const list = JSON.parse(
      (await httpGet(`${RELEASES_API}/releases?per_page=100`)).toString('utf8')
    );
    const releases: any[] = Array.isArray(list) ? list : [];
    const stable: any = core.resolveReleaseFromList(releases, 'stable');
    // resolveReleaseFromList, NOT a raw `.find(prerelease)` — the two disagree right after a promote,
    // when the freshly-tagged stable outranks the rolling build and IS what the dev channel serves.
    // The raw find had the nudge advertising a pre-release the updater would not have installed.
    // Null when the dev channel degraded to stable, so the consumer falls back to latestTag rather
    // than being told the pre-release equals the stable.
    const dev: any = core.resolveReleaseFromList(releases, 'dev');
    writeUpdateCache({
      checkedMs: Date.now(),
      latestTag: core.versionOfRelease(stable),
      latestDevTag: dev && dev.prerelease === true ? core.versionOfRelease(dev) : null,
    });
  } catch {
    /* offline / rate-limited: the parent already wrote a throttle timestamp; keep the old tag */
  }
}

function shouldCheckUpdates(cmd: string | undefined, rest: string[]): boolean {
  if (process.env.CLAUDE_OBSERVATORY_NO_UPDATE_CHECK) return false;
  if (!process.stderr.isTTY) return false; // pipes, the JetBrains plugin, CI, cron — never nudged
  if (rest.includes('--json')) return false; // a machine-readable invocation
  // The capture hot path, self/redundant commands, and non-work invocations get no nudge.
  // `tui` is here for two reasons beyond the usual: the nudge registers a `process.on('exit')` printer
  // that would fire INSIDE the alternate screen and be wiped with it, and the check `require`s core
  // before the dispatch switch — on the one path whose first frame has to be immediate. The TUI surfaces
  // the same information in its own status line instead.
  const SKIP = new Set(['capture', '__update-check', '__after-update', 'update', 'demo', 'tui', 'version', '--version', '-v', 'help', '--help', '-h']);
  return cmd !== undefined && !SKIP.has(cmd);
}

/** Register the once-a-day update nudge (which prints on the NEXT run, after the command's own output)
 *  and kick a detached refresh if the cached check is older than a day. Cheap and non-blocking. */
function maybeCheckForUpdate(cmd: string | undefined, rest: string[]): void {
  if (!shouldCheckUpdates(cmd, rest)) return;
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const cache = readUpdateCache();
  const cur = version();
  // The nudge follows the ACTIVE channel: a dev-channel install compares against the rolling
  // pre-release tag, never against stable (which is older than every dev build by construction).
  const channelTag = core.getUpdateChannel() === 'dev' ? cache?.latestDevTag ?? cache?.latestTag : cache?.latestTag;
  // Any DIFFERENCE from the channel, not just a higher number — the nudge went silent for exactly
  // the people who most needed it: installs sitting above the channel line, which never self-heal.
  if (channelTag && core.compareVersions(channelTag, cur) !== 0) {
    const behind = core.isNewer(channelTag, cur);
    // Print AFTER the command's output, once, to stderr — never pollutes stdout / --json consumers.
    process.on('exit', () => {
      try {
        process.stderr.write(
          c.dim(
            behind
              ? `\nupdate available (${cur} → ${channelTag}) — run \`oak update\`\n`
              : `\nthis build (${cur}) is not on your ${CHANNEL_LABEL[core.getUpdateChannel()]} channel (${channelTag}) — run \`oak update\`\n`
          )
        );
      } catch {
        /* stream already closed */
      }
    });
  }
  const DAY = 24 * 60 * 60 * 1000;
  if (!cache || Date.now() - cache.checkedMs > DAY) {
    // The optimistic throttle must carry BOTH tags forward — dropping latestDevTag here silently
    // ate a dev-channel machine's known-update nudge until the next successful network refresh.
    writeUpdateCache({ checkedMs: Date.now(), latestTag: cache?.latestTag ?? null, latestDevTag: cache?.latestDevTag ?? null });
    try {
      // process.execPath ends in .exe on Windows, so the launcher keeps this DIRECT — routing a
      // detached spawn through cmd.exe would flash a console window once a day.
      (require('@oak-observatory/core') as typeof import('@oak-observatory/core'))
        .spawnTool(process.execPath, [__filename, '__update-check'], { detached: true, stdio: 'ignore' })
        .unref();
    } catch {
      /* couldn't spawn the background check — no nudge this cycle, no harm */
    }
  }
}

/** Every verb the dispatch below answers to, and the flags that take a VALUE — both used only
 *  to tell a swallowed command apart from a flag's argument at the front door. Derived from
 *  the same switch that runs them, so the two cannot drift. */
const KNOWN_VERBS = new Set([
  'actions', 'agent', 'agents', 'analyze', 'assign', 'attach', 'blob', 'capabilities', 'capture', 'changemap', 'chat-context', 'clean', 'comment', 'conversation', 'quote', 'demo', 'diff', 'doctor', 'egress', 'export', 'feed', 'fleet', 'footprint', 'focus', 'help', 'ignore', 'inbox', 'init', 'integrity', 'insights', 'install-extensions', 'keep', 'list', 'locate', 'machine', 'metrics', 'models', 'multitask', 'notify', 'observations', 'observe', 'oplog', 'processes', 'prompt', 'prompts', 'recap', 'review', 'store', 'redo', 'resolve', 'risk', 'search', 'server', 'sessions', 'siblings', 'stats', 'status', 'statusline', 'subagents', 'tui', 'suggest', 'summary', 'task-clear', 'task-keep', 'task-undo', 'tasklog', 'timeline', 'titles', 'trace', 'tree', 'undo', 'uninstall', 'update', 'usage', 'version', 'views', 'warm',
]);
// NOTE: this is the SECOND list of value-taking flags in this file (see `VALUE_FLAGS` above). They
// serve different parsers — that one strips flag/value pairs, this one decides whether a bare token
// is a verb — and a flag missing from EITHER fails in its own way. `--tab review` needs both: the
// first so the pair is consumed, this one so `review` is not mistaken for the review command.
const FLAGS_WITH_VALUES = new Set(['--root', '--session', '--tick', '--cols', '--rows', '--out', '--under', '--ids', '--file', '--since', '--stale', '--drop', '--older-than', '--check', '--views', '--channel', '--prompt', '--agent', '--cwd', '--resume', '--tab', '--delete', '--undelete', '--after', '--kind', '--ts', '--title', '--message', '--interval', '--query', '--days', '--limit', '--text', '--edit', '--line', '--id', '--machine', '--comment-ids', '--pane']);

function main(): void {
  // Exit cleanly when output is piped to a consumer that closes early (`| head`, `| grep -q`, …)
  // instead of crashing with an unhandled EPIPE 'error' event.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });

  // Detached refreshes (`titles --refresh`) relaunch THIS file, the oak CLI, never whatever script started
  // the process: a harness can run the CLI in-process with its own argv[1]. Its own tiny module, so the
  // capture hook's hot path loads nothing more.
  require('@oak-observatory/core/dist/cli-entry').setOakCliEntry(__filename);

  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  // Post-rename nudge: the product is now `oak` (package `oak-observatory`). The old
  // `claude-observatory` command still works as a deprecated alias, but say so once — interactively
  // only (a human at a TTY), and NEVER for the `capture` hook, which runs on every tool call and whose
  // output Claude Code consumes.
  try {
    const invokedAs = require('path').basename(process.argv[1] || '');
    if (invokedAs === 'claude-observatory' && cmd !== 'capture' && process.stderr.isTTY) {
      process.stderr.write(
        c.yellow('claude-observatory') +
          c.dim(' is now ') +
          c.bold('oak') +
          c.dim(' — the old name still works but will be retired; try `') +
          `oak ${argv.join(' ')}`.trim() +
          c.dim('`.\n')
      );
    }
  } catch {
    /* a deprecation nudge must never break a command */
  }
  // A subcommand invoked with --help/-h prints usage instead of erroring on a missing positional arg
  // (e.g. `diff --help`, `task-keep --help`); do it before the nudge so a help invocation stays quiet.
  if (cmd !== undefined && (rest.includes('--help') || rest.includes('-h'))) {
    usage();
    return;
  }
  // The product's front door is the app. A bare `oak`, or one carrying only flags
  // (`--root`, `--session`, `--no-mouse`), opens the dashboard rather than erroring on a leading flag
  // it would otherwise read as a command name. Named verbs still dispatch below, and `--help` and
  // `--version` keep answering for themselves — those are questions, not a request to open anything.
  const HELP_OR_VERSION = new Set(['-h', '--help', '-v', '--version']);
  if (cmd === undefined || (cmd.startsWith('-') && !HELP_OR_VERSION.has(cmd))) {
    // A VERB typed after a flag is not a request to open the dashboard. `oak --root x
    // status` used to open the app and silently drop `status`, which reads as the flag being wrong.
    // Flags take a value, so only a token that is a known verb AND not the value of the flag before
    // it counts — otherwise `--session status` would be misread as the verb.
    const verb = argv.find((a, i) => !a.startsWith('-') && !(i > 0 && argv[i - 1].startsWith('-') && FLAGS_WITH_VALUES.has(argv[i - 1])) && KNOWN_VERBS.has(a));
    if (verb) {
      fail(`\`${verb}\` is a command, so it goes first: \`oak ${verb} ${argv.filter((a) => a !== verb).join(' ')}\``);
    }
    require('@oak-observatory/tui').runTui(require('@oak-observatory/core'), argv, getTuiSessionId);
    return;
  }
  // A session verb aimed at a saved machine runs THERE, where the session's store and files are.
  if (MACHINE_VERBS.has(cmd) && rest.some(a => a === '--machine' || a.startsWith('--machine='))) {
    void forwardToMachine(cmd, rest).catch((e) => fail(String(e?.message || e)));
    return;
  }
  // …and arriving there, it runs where its session ran.
  if (process.env.OAK_FORWARDED === '1' && MACHINE_VERBS.has(cmd)) enterSessionWorkspace(rest);
  maybeCheckForUpdate(cmd, rest); // register a once-a-day "update available" nudge (never blocks)
  // A throw from a SYNC command should surface as `oak: <msg>`, not a raw Node stack.
  // process.exit() throws nothing, so a command's own exit is never caught here; async commands keep
  // their own .catch(fail) below.
  try {
  switch (cmd) {
    case '__conversation-protocol':
      process.stdout.write('1\n'); // bounded initial reads, remote byte cursors and replacement resets
      break;
    case '__review-protocol':
      process.stdout.write('1\n'); // units, sent-comment ledger, equals text values, and JSON diffs
      break;
    case 'init':
      if (rest.includes('--codex')) {
        cmdInitCodex(!rest.includes('--no-verify'));
        break;
      }
      cmdInit(rest.includes('--project'), rest.includes('--with-statusline'), rest.includes('--repair'), rest.includes('--force'));
      break;
    case 'statusline':
      cmdStatusline(rest);
      break;
    case 'uninstall':
      cmdUninstall(rest);
      break;
    case 'status':
      cmdStatus(rest);
      break;
    case 'integrity':
      cmdIntegrity(rest);
      break;
    case 'doctor':
      cmdDoctor(rest).catch((e) => fail(String(e?.message || e)));
      break;
    case 'sessions':
      cmdSessions(rest);
      break;
    case 'attach':
      cmdAttach(rest).catch((e) => fail(String(e?.message || e)));
      break;
    case 'machine':
      cmdMachine(rest).catch((e) => fail(String(e?.message || e)));
      break;
    case 'inbox':
      cmdInbox(rest);
      break;
    case 'search':
      cmdSearch(rest);
      break;
    case 'notify':
      // Like `drive`: an async command in the sync dispatcher — `--watch` keeps its own interval alive;
      // the one-shot forms finish on their own.
      void cmdNotify(rest).catch(fail);
      break;
    case 'store':
      cmdStore(rest);
      break;
    // Deliberately NOT a `views` member: it WRITES caches, and that batch is read-only by contract.
    case 'resolve':
      cmdResolve(rest);
      break;
    case 'warm':
      cmdWarm(rest);
      break;
    case 'list':
      cmdList(rest);
      break;
    case 'timeline':
      cmdTimeline(rest);
      break;
    case 'actions':
    case 'trace':
      cmdActions(rest);
      break;
    case 'risk':
      cmdRisk(rest);
      break;
    case 'egress':
      cmdEgress(rest);
      break;
    case 'footprint':
      cmdFootprint(rest);
      break;
    case 'capabilities':
      // 0.8.6 shipped this verb; 0.8.7 renamed it to `footprint`. Keep it working rather than answering
      // an upgrade with "unknown command", and put the notice on STDERR — a line on stdout would corrupt
      // `capabilities --json` for anything already piping it.
      process.stderr.write(c.dim('`capabilities` was renamed to `footprint` in 0.8.7 — running `footprint`.\n'));
      cmdFootprint(rest);
      break;
    case 'processes':
      cmdProcesses(rest);
      break;
    case 'prompts':
      cmdPrompts(rest);
      break;
    case 'review':
      cmdReview(rest);
      break;
    case 'feed':
      cmdFeed(rest);
      break;
    case 'conversation':
      cmdConversation(rest);
      break;
    case 'subagents':
    case 'agents':
      cmdSubagents(rest);
      break;
    case 'siblings':
    case 'fleet':
      cmdSiblings(rest);
      break;
    case 'multitask':
      cmdMultitask(rest);
      break;
    case 'tasklog':
      cmdTaskLog(rest);
      break;
    case 'metrics':
      cmdMetrics(rest);
      break;

    case 'focus':
      void cmdFocus(rest).catch(e => fail(String(e?.message || e)));
      break;
    case 'server':
      void cmdServer(rest).catch(e => fail(String(e?.message || e)));
      break;

    case 'agent':
      cmdAgent(rest).catch((e) => fail(String(e.message || e)));
      return;
    case 'prompt':
      void cmdPrompt(rest).catch(e => fail(String(e?.message || e)));
      break;
    case 'comment':
      void cmdComment(rest).catch(e => fail(String(e?.message || e)));
      break;
    case 'quote':
      void cmdQuote(rest).catch(e => fail(String(e?.message || e)));
      break;

    case 'models':
      void cmdModels(rest).catch(fail);
      break;

    case 'diff':
      cmdDiff(rest);
      break;
    case 'keep':
      cmdKeep(rest);
      break;
    case 'undo':
      cmdUndo(rest);
      break;
    case 'oplog':
      cmdOplog(rest);
      break;
    case 'assign':
      cmdAssign(rest);
      break;
    case 'redo':
      cmdRedo(rest);
      break;
    case 'task-keep':
      cmdTaskKeep(rest);
      break;
    case 'task-undo':
      cmdTaskUndo(rest);
      break;
    case 'task-clear':
      cmdTaskClear(rest);
      break;
    case 'demo':
      void cmdDemo(rest);
      break;
    case 'clean':
      cmdClean(rest);
      break;
    case 'stats':
      cmdStats(rest);
      break;
    case 'summary':
      cmdSummary(rest);
      break;
    case 'export':
      cmdExport(rest);
      break;
    case 'blob':
      cmdBlob(rest);
      break;
    case 'ignore':
      cmdIgnore(rest);
      break;
    case 'locate':
      cmdLocate(rest);
      break;
    case 'tree':
      cmdTree(rest);
      break;
    case 'views':
      cmdViews(rest);
      break;
    case 'tui':
      require('@oak-observatory/tui').runTui(require('@oak-observatory/core'), rest, getTuiSessionId);
      break;
    case 'changemap':
      cmdChangeMap(rest);
      break;
    case 'chat-context':
      cmdChatContext(rest);
      break;
    case 'observe':
      cmdObserve(rest);
      break;
    case 'observations':
      cmdObservations(rest);
      break;
    case 'insights':
      cmdInsights(rest);
      break;
    case 'usage':
      cmdUsage(rest);
      break;
    case 'titles':
      cmdTitles(rest);
      break;
    case 'analyze':
      cmdAnalyze(rest).catch((e) => fail(String(e?.message || e)));
      break;
    case 'recap':
      cmdRecap(rest).catch((e) => fail(String(e?.message || e)));
      break;
    case 'update':
      cmdUpdate(rest).catch((e) => fail(String(e?.message || e)));
      break;
    case 'install-extensions':
      cmdInstallExtensions(rest).catch((e) => fail(String(e?.message || e)));
      break;
    case '__update-check':
      // Internal, hidden: spawned detached by maybeCheckForUpdate to refresh the update cache.
      void refreshUpdateCache();
      break;
    case '__after-update':
      // Internal, hidden: `oak update` runs this in the CLI it just installed (finishInInstalledCli).
      afterUpdate().catch((e) => fail(String(e?.message || e)));
      break;
    case '__tab-sync':
      // Internal, hidden: started detached by the capture hooks and the status line (core kickTabSync).
      cmdTabSync(rest);
      break;
    case 'suggest':
      cmdSuggest(rest).catch((e) => fail(String(e?.message || e)));
      break;
    case '--version':
    case '-v':
      process.stdout.write(`oak ${version()}\n`);
      break;
    case 'version':
      cmdVersion(rest).catch((e) => fail(String(e?.message || e)));
      break;
    case '-h':
    case '--help':
    case 'help':
      usage();
      break;
    default: {
      // Verbs earlier releases shipped (0.9.5's `remotes`; dev builds' `drive`, `acp-fidelity`): name the replacement.
      const replaced: Record<string, string> = {
        remotes: '`oak machine add <label> <ssh-target>` and `oak machine list`',
        drive: '`oak agent start` and `oak prompt`',
        'acp-fidelity': '`oak integrity`',
      };
      if (Object.prototype.hasOwnProperty.call(replaced, cmd)) fail(`\`${cmd}\` was removed in 0.10.0; use ${replaced[cmd]}.`);
      fail(`unknown command "${cmd}". Run \`oak help\`.`);
    }
  }
  } catch (e: any) {
    fail(String(e?.message || e));
  }
}

main();
