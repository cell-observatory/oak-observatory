/**
 * oak — standalone, git-free, per-edit Keep/Undo for Claude Code and Codex.
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
 *   query <name>         the local index in JSON (named queries, or one read-only SQL statement)
 *
 * Machine-readable surface (drives the JetBrains plugin): blob / locate / observe / usage, plus
 * --json on list / status / sessions / keep / undo / redo, and analyze / recap / suggest for the
 * opt-in `claude -p` layer. See `usage()` below.
 *
 * `oak capture` never reaches this file: the dist/index.js launcher (launch.ts) sends it to the lean
 * capture bundle, so the hooks do not compile the whole CLI.
 */
import type { EditRecord, InstallResult, StatMetrics, InstalledSurface, UpdatePlan, UpdateAction, HandKind, Check, HerdrReport } from '@oak-observatory/core';
import type { SyncCliDeps } from './sync';

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

/** A command that records the reader's decisions runs whole outside any store move (core.outsideStoreMoves): its reads
 *  and its writes. Read while a move had renamed the store, before the new location was recorded, a keep found no edit
 *  to keep and an undo said there was none; only the writes waited for the move. */
function deciding(run: () => void): void {
  (require('@oak-observatory/core') as typeof import('@oak-observatory/core')).outsideStoreMoves(run);
}

function fail(msg: string): never {
  process.stderr.write(c.red('oak: ') + msg + '\n');
  process.exit(1);
}

/** True while `emitJson` writes: JSON passes `guardHumanOutput` byte-exact, even from a verb that
 *  answers in JSON without `--json` (`chat-context`). */
let writingJson = false;

/** Machine-readable output for non-Node front-ends (the JetBrains plugin drives these). A verb that
 *  emits JSON and then sets an exit status sets `process.exitCode` and returns, never `process.exit()`:
 *  exit drops whatever a pipe has not taken yet, which cut the JSON off at the pipe's buffer (8 KB on
 *  macOS) whenever the reader was slower than the writer. One that must end the process exits from
 *  `written`, which runs once stdout has taken the JSON. */
function emitJson(v: unknown, written?: () => void): void {
  writingJson = true;
  try {
    process.stdout.write(JSON.stringify(v), written);
  } finally {
    writingJson = false;
  }
}

/** Verbs whose stdout is data or a terminal app of its own, never filtered: the raw blob, the JSON
 *  trace and view batches, the protocol probes, the tab-sync answer, the focus server and the terminal
 *  app itself. `views` is filtered on a terminal, as `--json` is: its batches (and `views --serve`'s
 *  answers) reach the editors and the terminal app through a pipe. */
const RAW_OUTPUT_VERBS = new Set(['blob', 'export', 'views', 'tui', 'server', '__conversation-protocol', '__review-protocol', '__update-protocol', '__tab-sync', '__sync-inventory', '__sync-fetch', '__sync-key', '__query-sql', '__index-build']);

/**
 * Human output carries text an agent wrote: titles, prompts, replies, file names, messages. Printed
 * raw, an escape sequence in any of them drives the reader's terminal (retitle the window, clear the
 * screen, write the clipboard over OSC 52). Every string this process writes to stdout or stderr is
 * therefore filtered as the terminal app filters its cells, keeping only colour, line breaks and tabs.
 * One filter at the stream, rather than one call per print, covers every path, including new ones.
 * Messages on stderr are always for a person; stdout is left exact for the machine formats.
 */
function guardHumanOutput(streams: NodeJS.WriteStream[]): void {
  const { sanitizeText } = require('@oak-observatory/tui/dist/textwidth') as typeof import('@oak-observatory/tui/dist/textwidth');
  for (const stream of streams) {
    const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => write(typeof chunk === 'string' && !writingJson ? sanitizeText(chunk) : chunk, ...rest)) as typeof stream.write;
  }
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
  // `--root <dir>` names the workspace the app reviews, so it scopes every lookup here, not the launch cwd.
  const root = flagValue(args, '--root') ?? process.cwd();
  const pinned = args.some((a) => a === '--session' || a.startsWith('--session=')) || process.env.CLAUDE_OBSERVATORY_SESSION || process.env.CLAUDE_CHANGES_SESSION;
  if (pinned) {
    const id = getSessionId(args);
    // The dashboard is a whole-session view, so an EXPLICIT id it cannot open (a typo) must fail loudly
    // rather than paint an empty board. A session this machine has is one with a transcript (Claude or
    // Codex) or a store (a reviewed session whose transcript is gone). Verbs that legitimately pin an
    // id with neither — `feed --feed-agent <subagent>` — never reach here (this is the tui path only).
    // With saved machines, the session may run on one of them: the dashboard finds its owner from
    // their catalogs, reviews it there, and fails just as loudly when none lists it.
    if (id && !core.findTranscript(root, id) && !require('fs').existsSync(core.storeDir(id))) {
      if (savedMachineLabels().length) return { session: id, elsewhere: true };
      fail(`no session "${id}" on this machine — \`oak sessions\` lists the ones it has.`);
    }
    return id;
  }
  // `--root` means that workspace's own session, never the machine-wide newest the launch default reaches for.
  const id = core.defaultTuiSession(root, flagValue(args, '--root') !== undefined);
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
  // `--session=` names no id, as a bare `--session` does not: both fail, never fall back to the cwd's session.
  const named = args.some((a) => a === '--session' || a.startsWith('--session='));
  const given = flagValue(args, '--session');
  let id: string | null = null;
  if (named && !given) fail('`--session` requires a session id');
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
  const setups = project ? (core.repoRoot(process.cwd()) ? [core.applyAgentSetup(core.agentSetupPlan({ project: process.cwd(), remove: true }))] : []) : core.refreshAgentSetup(process.cwd(), true);
  for (const p of setups) for (const e of p.items) process.stdout.write(`${e.path}: ${e.state === 'edited' ? 'user-edited; left unchanged' : 'OAK delegation content removed or absent'}\n`);
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
    // `--purge-store` acts only with `--all`: said, never skipped in silence, so a store meant to go is not left unnoticed.
    if (args.includes('--purge-store'))
      process.stdout.write(c.yellow('⚠ ') + '`--purge-store` takes effect with `--all`: nothing was purged. Run `oak uninstall --all --purge-store` to delete the stored edits.\n');
    process.stdout.write(
      c.dim('tip: `oak uninstall --all` also reverts the bundled status line + prints full teardown steps.\n')
    );
    return;
  }
  // --all: revert the bundled status line too, but only if it's still ours (never a user's custom one). Its
  // installer sets it up for the user, so a project's uninstall leaves it: reverting it there edited Codex's
  // config and deleted the script the user's own settings still ran.
  if (project) {
    process.stdout.write(c.dim('- a project\'s uninstall leaves the bundled status line, which is set up for your user: `oak uninstall --all` reverts it.\n'));
  } else {
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
    // …and the one it configured in Codex (the lines it marks `# oak-statusline` in config.toml).
    try {
      if (core.uninstallCodexStatusline()) process.stdout.write(c.green('✓ ') + `removed the bundled status line's lines from ${core.codexConfigTomlPath()}\n`);
    } catch (e) {
      process.stdout.write(c.yellow('⚠ ') + `could not remove the bundled status line's lines from ${core.codexConfigTomlPath()}: ${String((e as Error)?.message || e)}\n`);
    }
  }
  const syncState = core.syncDir();
  if (args.includes('--purge-store')) {
    // Every session folder, one holding no edit log among them (a session that only asked and read, a Bash snapshot's
    // stub, a demo of the simulator's): the store's own folders (oak sync's state, the record logs) are no session.
    const sessions = core.allStoreSessionIds().map((id) => ({ id }));
    for (const s of sessions) core.removeSession(s.id, { archive: false });
    // Forgotten as a deliberate delete forgets them: their rows and full-text entries in the local index, and in this
    // machine's record log, whose purge oak sync carries to the other machines. Wherever an index file or this machine's
    // record log is left (the index may have been moved aside, as `oak doctor` advises for a damaged one); a machine that
    // never built an index gets none made.
    const fs = require('fs') as typeof import('fs');
    const unopened = core.indexFiles().length || core.recordHosts().includes(core.machineHostTag()) ? core.indexForget(sessions.map((s) => s.id)) : null;
    if (unopened) process.stdout.write(c.yellow('⚠ ') + `the local database could not be opened (${unopened}): the sessions purged are forgotten in this machine's record log, which a new database reads\n`);
    // Each session removed is noted in sync/evicted.jsonl (store.ts), which so lists every id purged. Where it is all oak
    // sync's state holds (a machine that never synced), it goes with the sessions; otherwise the line below names it.
    try {
      if (fs.readdirSync(syncState).every((n: string) => n === 'evicted.jsonl' || n === core.OLD_CLEAN_GUARD_DIR)) fs.rmSync(syncState, { recursive: true, force: true });
    } catch {
      /* no sync state */
    }
    process.stdout.write(c.green('✓ ') + `purged the store (${sessions.length} session(s))\n`);
  }
  // We can't remove the global CLI or the editor extensions from here — print the exact steps. oak sync's state and the
  // record logs are no session, so neither `oak clean --all` nor `--purge-store` removes them: name them where they are.
  const indexFolder = core.indexDir();
  const records = core.recordsRoot();
  const recordHosts = core.recordHosts();
  let hostTag = '';
  try {
    hostTag = core.machineHostTag();
  } catch {
    /* no home (on Windows an empty USERPROFILE throws): no record log is known as this machine's */
  }
  // A backup folder is outside the store, and may be shared with the user's other machines: named, never removed here.
  const backup = core.syncSettings().backup;
  // What the bundled status line keeps beside its cache between renders, which reverting it leaves: its calibration, and
  // the claims and journal of the refreshes and pulls it starts. And Node's compile cache of OAK's code, which the `oak`
  // launcher keeps in this user's cache folder.
  const fsx = require('fs') as typeof import('fs');
  const pathx = require('path') as typeof import('path');
  const sideFiles = all && !project ? ['statusline-usage.json', 'statusline-last.json.month-refresh', 'statusline-last.json.pull-log', 'statusline-last.json.pulling']
    .map((n) => pathx.join(core.claudeConfigDir(), n)).filter((f) => fsx.existsSync(f)) : [];
  const xdgCache = process.env.XDG_CACHE_HOME;
  let compileCache = '';
  try {
    compileCache = pathx.join(xdgCache && pathx.isAbsolute(xdgCache) ? xdgCache : pathx.join(require('os').homedir(), '.cache'), 'oak', 'compile-cache');
  } catch {
    /* no home: no cache the launcher could have kept */
  }
  const compileCacheHere = pathx.isAbsolute(compileCache) && fsx.existsSync(compileCache);
  process.stdout.write(
    '\n' + c.bold('To finish removing OAK:\n') +
      // An agent session runs the hooks it started with until it ends, and they record (and rebuild the local index) until
      // the CLI is gone.
      c.dim('  • Agents:     ') + 'end the Claude Code and Codex sessions still running: each runs the hooks it started with until it ends\n' +
      c.dim('  • CLI:        ') + 'npm rm -g oak-observatory\n' +
      c.dim('  • VS Code:    ') + 'uninstall the “OAK” extension (Extensions view)\n' +
      c.dim('  • JetBrains:  ') + 'Settings → Plugins → OAK → Uninstall\n' +
      (args.includes('--purge-store')
        ? ''
        : c.dim('  • Stored edits: ') + '`oak clean --all`  (or re-run with `--purge-store`)\n') +
      syncStateStep(syncState, (require('fs') as typeof import('fs')).existsSync(core.syncKeyPath())) +
      ((require('fs') as typeof import('fs')).existsSync(indexFolder)
        ? c.dim('  • Local database: ') + `delete ${indexFolder}  (OAK's searchable database of your sessions: it holds your prompts and the answers to them, and sessions kept after their files were removed)\n`
        : '') +
      (recordHosts.length
        ? c.dim('  • Record logs: ') + `delete ${records}  (what the local database published of your sessions${recordHosts.some((h) => h !== hostTag) ? ', and the copies oak sync keeps of other machines\'' : ''}: your prompts and the answers to them, which a new database reads back)\n`
        : '') +
      (backup?.kind === 'folder'
        ? c.dim('  • Backup folder: ') + `${core.backupFolderPath(backup.path)}  (the encrypted backup of each of your machines that uses it: delete it once none does)\n`
        : '') +
      (sideFiles.length
        ? c.dim('  • Status line files: ') + `delete ${sideFiles.join(', ')}  (what the bundled status line kept between renders: its calibration, and when it last refreshed and pulled the account's usage)\n`
        : '') +
      (compileCacheHere
        ? c.dim('  • Compile cache: ') + `delete ${compileCache}  (what Node compiled of OAK's code, kept so that \`oak\` and the capture hooks start faster)\n`
        : '')
  );
}

/** The teardown step for oak sync's state, as `oak uninstall` prints it. A store that never synced has at most the list of
 *  the sessions removed there (store.ts writes it as one goes), which goes with it. Where oak sync ran, that list stays
 *  (the purge keeps it): without it, the copies the other machines keep of the sessions removed here come back with this
 *  machine's next run. Empty where there is no state. */
function syncStateStep(syncState: string, keyHere: boolean): string {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  let names: string[];
  try {
    // The file that keeps OAK 0.10's `oak clean` off the folder (store.ts keepFromOldClean) is no state of its own.
    names = fs.readdirSync(syncState).filter((n) => n !== core.OLD_CLEAN_GUARD_DIR);
  } catch {
    return '';
  }
  if (!names.length) return '';
  // A machine that never synced may hold the list of the sessions removed here and oak sync's copy of the settings an
  // older OAK drops from prefs.json (settings.json, which a machineUsage set there makes), and nothing else.
  const others = names.some((n) => n !== 'evicted.jsonl' && n !== 'settings.json');
  const listed = names.includes('evicted.jsonl');
  const key = keyHere ? '; it holds the backup key: keep it first, `oak sync key --show`, if a backup folder must stay readable' : '';
  if (!others) {
    const held = [listed ? 'the list of the sessions removed here' : '', names.includes('settings.json') ? 'a copy of oak sync\'s settings and "machineUsage" from prefs.json' : ''];
    return c.dim('  • Sync state: ') + `delete ${syncState}  (${held.filter(Boolean).join(', and ')})\n`;
  }
  const what = `oak sync's trash, conflict copies, merge bases and the copies of other machines' sessions${key}`;
  if (!listed) return c.dim('  • Sync state: ') + `delete ${syncState}  (${what})\n`;
  return c.dim('  • Sync state: ') + `delete everything in ${syncState} but evicted.jsonl  (${what})\n` +
    c.dim('                ') + `keep ${path.join(syncState, 'evicted.jsonl')} while oak sync runs on another of your machines: it lists the sessions removed here, whose copies there would otherwise come back with this machine's next run\n`;
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
        (codexStatus.userDisabled.length ? c.dim(`                 turned off in Codex: ${codexStatus.userDisabled.join(', ')}\n`) : '') +
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

/** On macOS, a notification OAK cannot hand to the terminal (an editor, a herdr pane) goes through
 *  osascript when terminal-notifier is missing, and macOS files it under Script Editor, which a click
 *  opens. Nothing fails for it, so the row is a warning, and only where it applies. The lookup is the
 *  one the post makes (PATH, then Homebrew's directories), so the two cannot disagree. */
function notifierCheck(): Check | null {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  if (process.platform !== 'darwin' || core.terminalNotifierPath(process.env) !== null) return null;
  return {
    id: 'terminal-notifier', label: 'Desktop notifications (macOS)', level: 'warn',
    detail: 'terminal-notifier is not installed: a notification posted through osascript opens Script Editor when clicked',
    fix: 'brew install terminal-notifier',
  };
}

/** The installation an `oak` command runs: its real path, through the launcher script `oak machine add`
 *  writes, which execs $HOME/.local/lib/oak/index.js. */
function oakEntry(cmd: string): string {
  const fs = require('fs');
  const path = require('path');
  const real = fs.realpathSync(cmd);
  try {
    if (fs.statSync(real).size < 512 && /"\$HOME\/\.local\/lib\/oak\/index\.js"/.test(fs.readFileSync(real, 'utf8')))
      return fs.realpathSync(path.join(process.env.HOME || require('os').homedir(), '.local', 'lib', 'oak', 'index.js'));
  } catch {
    /* not that launcher, or its bundle is gone: the file itself is the answer */
  }
  return real;
}

/** The version of the OAK installation whose entry point is `entry`, or null when it is not one. */
function oakEntryVersion(entry: string): string | null {
  const path = require('path');
  for (const manifest of [path.join(path.dirname(entry), '..', 'package.json'), path.join(path.dirname(entry), 'package.json')]) {
    try {
      const p = JSON.parse(require('fs').readFileSync(manifest, 'utf8'));
      if (p?.name === 'oak-observatory' || p?.name === 'claude-observatory') return String(p.version);
    } catch {
      /* try the other layout */
    }
  }
  return null;
}

/**
 * Inspect only: is the `oak` a login shell finds this installation? Codex runs each hook through the login
 * shell (`$SHELL -lc`), whose PATH comes from the login startup files rather than from the shell `oak
 * doctor` ran in: on macOS, path_helper puts /usr/local/bin and Homebrew's directories before
 * ~/.local/bin. Another installation found first runs every such hook, and a release left beside a linked
 * checkout runs old code with no error anywhere. One shell, started in the home folder as the hooks' is,
 * with a deadline. POSIX only: on Windows the hooks run `oak` from the PATH every process inherits, which
 * the `oak` on PATH row checks.
 */
function loginShellOakCheck(): Check {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const fs = require('fs');
  const path = require('path');
  const row = { id: 'login-shell-oak', label: '`oak` in a login shell' };
  if (process.platform === 'win32')
    return { ...row, level: 'ok', detail: 'not checked on Windows, where the hooks run `oak` from the PATH every process inherits (the `oak` on PATH row)' };
  const shell = process.env.SHELL || '/bin/sh';
  let ours = path.join(__dirname, 'index.js');
  try {
    ours = fs.realpathSync(ours);
  } catch {
    /* an install missing its entry point: nothing can match it */
  }
  const here = `${version()} at ${ours}`;
  const fix = 'remove the other one (an npm install: `npm uninstall -g oak-observatory` with the npm that installed it), or put the directory of this one first on PATH in your login startup file (~/.zprofile for zsh, ~/.bash_profile or ~/.profile for bash). On macOS, path_helper puts /usr/local/bin and Homebrew\'s directories before ~/.local/bin in a login shell.';
  const r = core.spawnToolSync(shell, ['-lc', 'command -v oak'], { cwd: process.env.HOME || require('os').homedir(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  // A startup file can leave a job of its own holding the shell's output open: a shell that exited by itself
  // answered, and only the wait for that output to close ran into the deadline. Its answer stands.
  if (r.status === null)
    return { ...row, level: 'warn', detail: `not inspected — \`${shell} -lc 'command -v oak'\` ${r.signal ? 'did not answer within 5 s' : `could not run: ${String(r.error?.message || r.error)}`}` };
  // The last path it printed: a login startup file can print lines of its own.
  const lines = String(r.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const found = lines.filter((l) => l.startsWith('/')).pop() ?? lines.pop();
  if (r.status !== 0 || !found)
    return { ...row, level: 'warn', detail: `a login shell (${shell} -lc) finds no \`oak\`, so the hooks Codex runs through one cannot capture anything; this installation is ${here}`, fix: 'put the directory of this `oak` on PATH in your login startup file (~/.zprofile for zsh, ~/.bash_profile or ~/.profile for bash)' };
  let entry: string | null = null;
  try {
    entry = path.isAbsolute(found) ? oakEntry(found) : null;
  } catch {
    /* a dangling link: named as found below */
  }
  if (entry === ours) return { ...row, level: 'ok', detail: `${found} is this installation (${here})` };
  const theirs = entry ? oakEntryVersion(entry) : null;
  if (theirs === null)
    return { ...row, level: 'warn', detail: `a login shell runs \`oak\` as ${found}, which OAK cannot follow to an installation (a version manager's shim, a wrapper script or an alias), so it cannot tell whether that is this one (${here})`, fix: `check that \`${shell} -lc 'oak --version'\` prints oak ${version()}; if not, ${fix}` };
  return { ...row, level: 'warn', detail: `a login shell runs ${found}, which is ${theirs} at ${entry}, not this installation (${here}): the hooks Codex runs through a login shell run that one`, fix };
}

async function cmdDoctor(args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const checks = core.diagnose({
    cwd: process.cwd(),
    binOnPath: onPath('oak'),
    jqPresent: onPath('jq'),
  });
  checks.push(loginShellOakCheck());
  checks.push(...await core.diagnoseHerdrPane());
  checks.push(core.diagnoseRemoteTitles());
  const codexQuota = core.diagnoseCodexQuota();
  if (codexQuota) checks.push(codexQuota);
  const herdr = await herdrCheck(args.includes('--fix'));
  checks.push(herdr.check);
  checks.push(python3Check(herdr.report));
  const notifier = notifierCheck();
  if (notifier) checks.push(notifier);
  if (herdr.check.level !== 'fail') checks.push(...herdrIdentityCheck(), herdrLoginScopeCheck());
  checks.push(await core.diagnoseFocusServer(args.includes('--fix')));
  const tui = require('@oak-observatory/tui') as typeof import('@oak-observatory/tui');
  checks.push(await tui.diagnoseNativeSpawn(args.includes('--fix'), { bundle: machineBundle() }));
  if (herdr.check.level !== 'fail') {
    stopDetachedOnSignals();
    checks.push(...await core.diagnoseHerdrForwarding({ binary: core.findHerdrBin() ?? undefined }));
  }
  // How each saved machine answered the last read of its Claude usage, and why one gave no reading: from the cache.
  checks.push(...core.diagnoseMachineUsage());
  // Once oak sync has been used here: Claude Code's retention, which sync follows, and sync's last run and open
  // conflicts, from the store alone. Before, with a machine saved here, a suggestion to set it up.
  // herdr's machines, as the forwarding rows above listed them (one row each): no second read of its list.
  const savedMachines = checks.filter((ch) => ch.id.startsWith('herdr-forwarding:')).length;
  checks.push(...core.diagnoseSync(Date.now(), { savedMachines }));
  checks.push(core.diagnoseIndex());
  // Every report ends the process, as the terminal's below does: on Windows node-pty's ConPTY keeps a worker thread
  // running after the PTY check's child has exited (microsoft/node-pty#887), and doctor would never end on its own.
  const done = () => process.exit();
  if (args.includes('--json')) {
    emitJson({ version: version(), checks, herdr: herdr.report }, done);
    return;
  }
  if (args.includes('--markdown') || args.includes('--md')) {
    process.stdout.write(core.diagnoseMarkdown(checks), done);
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
      // The move records the new location in prefs.json itself, while captures wait for it.
      const res = core.moveStore(parsed.dir);
      if ('error' in res) fail(res.error);
      // The store is already there, and could not be put back: said as the bare refusal, it read as "not moved".
      else if (res.unrecorded) fail(`the store moved to ${res.to}, but prefs.json could not record it, so OAK looks for it where it was: ${res.unrecorded} — once prefs.json parses, ${toDefault ? 'remove its "storeDir"' : `set its "storeDir" to ${parsed.dir}`}`);
      else {
        process.stdout.write(`${c.green('moved')} ${res.from}\n   →   ${res.to}\n`);
        if (res.left) process.stderr.write(`${c.yellow('note:')} ${res.left}\n`);
        if (res.missed) process.stderr.write(`${c.yellow('note:')} ${core.missedDuringMove(res.missed)}\n`);
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

/** SSH options every remote step of `machine add`, `--machine` and `update` shares: never prompt (a
 *  password prompt in a script hangs forever), fail fast, trust a first-contact host key, and reject a
 *  changed known key. Keepalives are the person's own ssh_config's to set: OAK's command deadlines,
 *  and the signal cleanup that stops its ssh with it, end a run that hangs. */
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new'];

/** Per ssh target, what `sshMux` decided, asked once per process. */
const sshMuxAsked = new Map<string, string[]>();
/** `-o ControlMaster=no` when the person's ssh config would make OAK's ssh to `target` the master of a
 *  shared connection that is not kept in the background, which stopping OAK's ssh would close under every
 *  session sharing it (core's sshMuxOptions, which decides herdr's ssh for a saved machine the same way). */
function sshMux(target: string): string[] {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  let opts = sshMuxAsked.get(target);
  if (opts) return opts;
  opts = core.sshMuxOptions(core.spawnToolSync('ssh', ['-G', target], { encoding: 'utf8', timeout: 5000, direct: true, env: core.machineSshEnv() }));
  sshMuxAsked.set(target, opts);
  return opts;
}

/** Why ssh, or scp, which runs it, failed, in its own words: the last two lines of its stderr that can say
 *  why, joined by ` — `. One line is not enough: a server that refuses a login says why before ssh's line
 *  that it closed the connection (a PAM module's `System is booting up …`), where a banner comes too, and
 *  OAK cannot tell the two apart; anything the remote printed before the connection dropped comes before
 *  ssh's own line too. */
function sshReason(stderr: string): string {
  // Never why: a stale control socket is reported before ssh connects directly, accept-new announces a
  // host key it just recorded before the login that then fails, LogLevel VERBOSE notes the closed
  // identification exchange before ssh's line that the server closed the connection, and the login that
  // succeeded before what went wrong after it, ssh notes that it allocates no terminal (RequestTTY in the
  // person's ssh_config, with no terminal on stdin) before it tries to connect, and rows of `@` frame a
  // changed host key's warning. A line said twice in a row (a jump host's banner, then its target's) is
  // shown once.
  const lines = stderr.split('\n').map((l) => l.trim())
    .filter((l) => l && !/^(?:Control socket connect\(|Warning: Permanently added |kex_exchange_identification: Connection closed by remote host$|Authenticated to |Pseudo-terminal will not be allocated because stdin is not a terminal\.$|@.*@$)/.test(l))
    .filter((l, i, kept) => l !== kept[i - 1]);
  // Nor are the lines ssh ends with once another has said why: through a jump host or ProxyCommand, the
  // jump's `stdio forwarding failed` and the close of the proxied connection, which ssh knows only as
  // `UNKNOWN port 65535`; a server's disconnect, a handshake that timed out, and LogLevel VERBOSE's
  // transfer totals; nor scp's after those (`lost connection` in its older protocol, `scp: Connection
  // closed`, and `scp: failed to upload …` after the line that says why the file could not be written,
  // each named by the path scp was run as). When nothing else was said, the last of them is the reason.
  const after = /^(?:Connection (?:closed|reset) by UNKNOWN port \d+|Connection to \S+ port \d+ timed out|Disconnected from \S+ port \d+|Transferred: sent \d|Bytes per second: |stdio forwarding failed$|lost connection$|(?:\S*\/)?scp: (?:Connection closed$|failed to upload ))/;
  const said = lines.filter((l) => !after.test(l));
  return (said.length ? said.slice(-2) : lines.slice(-1)).join(' — ');
}

/** End this process as `sig` would have, once its handler has stopped what it started: the signal is
 *  raised again with no handler left, so the parent sees it. A shell stops a loop at ctrl+c only for a
 *  command the signal ended; an exit status of 128 + n reads as one that handled it, and the loop goes
 *  on. Windows has no such signals: there it exits with the status a shell reports for one. */
function endBySignal(sig: NodeJS.Signals, n: number): void {
  if (process.platform === 'win32') process.exit(128 + n);
  process.kill(process.pid, sig);
}

/** The signals that stop OAK's ssh to a saved machine before they end OAK: a deadline's SIGTERM (the terminal
 *  app's, an editor's), and from a terminal ctrl+c (SIGINT), a hangup (SIGHUP) and ctrl+\ (SIGQUIT, which
 *  Windows does not have). SIGKILL (`kill -9`) ends OAK with no handler run, and ssh then runs on until the
 *  remote command ends. */
const SSH_STOP_SIGNALS: readonly (readonly [NodeJS.Signals, number])[] =
  [['SIGTERM', 15], ['SIGINT', 2], ['SIGHUP', 1], ...(process.platform === 'win32' ? [] : [['SIGQUIT', 3] as const])];

/** For a verb that may run herdr's command for a saved machine (`herdr --machine`: `oak prompt`, and
 *  `oak doctor`'s forwarding check), which runs apart from the terminal as the ssh above does: the same
 *  signals stop it, with herdr's ssh, before they end OAK. Unstopped, it ran on after ctrl+c, and a prompt
 *  was delivered seconds later. Installed once, however many such commands run. Windows runs that command
 *  in this process's console (execFileTool), where ctrl+c reaches it as well, so there is nothing to stop. */
let detachedStops = false;
function stopDetachedOnSignals(): void {
  if (detachedStops || process.platform === 'win32') return;
  detachedStops = true;
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  for (const [sig, n] of SSH_STOP_SIGNALS) {
    process.once(sig, () => {
      core.stopDetachedChildren();
      endBySignal(sig, n);
    });
  }
}

/** The verbs `--machine <label>` runs on a saved machine: everything Review and Observatory read or decide
 *  for a session whose store and files live there, `search`, with which the terminal app's session picker
 *  matches what was said in that machine's conversations, and `__tab-sync`, with which the terminal app has a
 *  saved machine name its own session's herdr tab. `prompt` and `agent start` are deliberately absent:
 *  their `--machine` is herdr's (deliver to, or start in, that machine's pane) and keeps that meaning. */
const MACHINE_VERBS = new Set(['processes', 'fleet', 'views', 'review', 'list', 'sessions', 'prompts', 'conversation', 'feed', 'multitask', 'subagents', 'diff', 'keep', 'undo', 'redo', 'resolve', 'clean', 'task-keep', 'task-undo', 'task-clear', 'chat-context', 'comment', 'quote', 'ignore', 'search', '__tab-sync', 'editor-review', 'locate', 'install-extensions']);
/** End to end, for one command on a saved machine. A cold review read there takes seconds;
 *  connection setup allows 8 s; OAK_MACHINE_TIMEOUT_MS can extend this command deadline. */
const MACHINE_TIMEOUT_MS = 120_000;

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
  // Level 2 adds `ignore --dry-run`: an older build ignores the flag and runs the sweep, which cannot be undone.
  const reviewLevel = verb === 'ignore' && args.includes('--dry-run') ? 2
    : args.includes('--units') || (verb === 'diff' && args.includes('--json')) || (verb === 'comment' && (args[0] === 'mark-sent' || args.some(a => a.startsWith('--text=')))) ? 1 : 0;
  const marker = 'OAK_EXIT_' + require('crypto').randomBytes(12).toString('hex') + ':';
  const conversationProtocol = verb === 'conversation';
  const check = conversationProtocol
    ? `if [ "$(oak __conversation-protocol 2>/dev/null)" != 1 ]; then printf '%s\n' ${quote('oak: update OAK on ' + m.label + ' — this build does not support the requested conversation protocol')} >&2; exit 78; fi; `
    : reviewLevel
    ? `level=$(oak __review-protocol --level 2>/dev/null); case "$level" in ''|*[!0-9]*) level=0 ;; esac; if [ "$level" -lt ${reviewLevel} ]; then printf '%s\n' ${quote('oak: update OAK on ' + m.label + ' — this build does not support the requested review protocol')} >&2; exit 78; fi; `
    : '';
  // The final, private stderr marker distinguishes the remote program's exit 255 from SSH's 255.
  // It is removed below; the program's stdout, stderr and exit status remain unchanged.
  const present = `if ! command -v oak >/dev/null 2>&1; then printf '\n${marker}missing\n' >&2; exit 127; fi; `;
  const script = present + check + `oak "$@"; oak_status=$?; printf '\n${marker}%s\n' "$oak_status" >&2; exit "$oak_status"`;
  // OAK_FORWARDED: the remote runs in its session's own workspace rather than the login directory
  // (`enterSessionWorkspace`). OAK_FORWARDED_MACHINE: the label this side reaches it by, so a repair
  // command the remote prints ("not recorded … --record-only") runs from here. An older build there
  // ignores both.
  const remote = `env PATH="${core.MACHINE_PATH}" CLAUDE_OBSERVATORY_NO_UPDATE_CHECK=1 OAK_FORWARDED=1 OAK_FORWARDED_MACHINE=${quote(label)} sh -c ${quote(script)} oak ${argv.map(quote).join(' ')}`;
  const env = core.machineSshEnv();
  const configured = Number(process.env.OAK_MACHINE_TIMEOUT_MS);
  const timeout = Number.isInteger(configured) && configured > 0 && configured <= 2147483647
    ? configured : MACHINE_TIMEOUT_MS;
  // -T: never a remote terminal, even where ssh_config asks for one (a pty turns \n into \r\n). stdin
  // is forwarded only to a verb told to read it (`ignore --stdin`): unforwarded, the remote read no
  // paths, and ssh must not swallow the caller's otherwise. `direct`: ssh is a real executable, and the
  // Windows shell route would drop the command's double quotes.
  // To a terminal, the remote's stdout passes through this side's output filter: the remote sees a pipe
  // and leaves its machine formats unfiltered, and an older build there filters nothing.
  // `detached` (POSIX; on Windows it would give ssh a console window of its own): ssh runs in a session of
  // its own, so a terminal's ctrl+c or hangup reaches this process alone, whose handlers below stop ssh and
  // end by the signal. Once its session is up, ssh catches both and exits 255: signalled too, it could
  // close first, and the command then named the machine unreachable and exited 255, which a shell loop
  // around it read as handled, and went on. Out of the terminal's jobs, ssh must not read the terminal
  // either: ctrl+z stops this process and not ssh, which went on reading what was then typed to the
  // shell. This process reads stdin and hands it on.
  const readsStdin = verb === 'locate' || args.includes('--stdin');
  // windowsHide: false — on Windows ssh shares this command's console: a terminal's, where a jump host's ssh asks its
  // questions, or the unseen one an editor runs this command in, so it opens no window either way. Hidden, with every
  // stdio a pipe, it got an unseen console of its own, where a jump host's question waited out the deadline.
  const child = core.spawnTool('ssh', ['-T', ...SSH_OPTS, ...sshMux(m.target), m.target, remote], { stdio: [readsStdin ? 'pipe' : 'ignore', isTTY() ? 'pipe' : 'inherit', 'pipe'], direct: true, env, detached: process.platform !== 'win32', windowsHide: false });
  if (readsStdin && child.stdin) {
    child.stdin.on('error', () => { /* ssh closed first: its close below reports why */ });
    process.stdin.pipe(child.stdin);
  }
  // Told to stop (the terminal app's deadline sends SIGTERM, ctrl+c sends SIGINT), ssh stops with it:
  // otherwise it outlives this process, reparented, until the remote command ends. That command is not
  // stopped: without a terminal, sshd does not signal it, so a search there may still finish there.
  for (const [sig, n] of SSH_STOP_SIGNALS) {
    process.once(sig, () => {
      child.kill();
      endBySignal(sig, n);
    });
  }
  // So does any other exit (an uncaught exception), unless a handler above has stopped it already.
  process.once('exit', () => { if (!child.killed) child.kill(); });
  child.stdout?.setEncoding('utf8');
  // Whole lines at a time: the filter reads a line on its own, and an escape sequence that one read of
  // the pipe split in two it took for two broken ones, printing what was left of them (`[31m`).
  // A line longer than 64 KB goes out without waiting for its end, less a trailing escape sequence
  // still incomplete: held whole, one without a newline grew until the process ran out of memory.
  const HOLD_MAX = 64 * 1024;
  let partial: string[] = [];
  let held = 0;
  // A patch printed for a person shows a bidirectional control or zero-width character in the file as the mark that
  // names it, as `oak diff` does here: the saved machine prints `--patch` into its pipe byte for byte, and the filter
  // on this terminal would drop them.
  const write = verb === 'diff' && args.includes('--patch') && isTTY() ? (text: string) => process.stdout.write(core.revealHidden(text, true)) : (text: string) => process.stdout.write(text);
  child.stdout?.on('data', (d: string) => {
    const cut = d.lastIndexOf('\n') + 1;
    if (!cut) {
      partial.push(d);
      if ((held += d.length) <= HOLD_MAX) return;
      const text = partial.join('');
      // eslint-disable-next-line no-control-regex
      const open = /\x1b(?:\[[0-9;:?<>!]*|\][^\x07\x1b]*|[PX^_][^\x1b]*|[()])?$/.exec(text);
      const keep = open && open[0].length < HOLD_MAX ? open.index : text.length;
      write(text.slice(0, keep));
      partial = keep < text.length ? [text.slice(keep)] : [];
      held = text.length - keep;
      return;
    }
    write(partial.join('') + d.slice(0, cut));
    partial = cut < d.length ? [d.slice(cut)] : [];
    held = d.length - cut;
  });
  child.stdout?.on('end', () => { if (partial.length) write(partial.join('')); });
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
    const reason = sshReason(err);
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
  if ((await core.herdrPaneContext()).nested) {
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
  const env = core.stripSessionIdentity(process.env);
  for (const key of ['HERDR_PANE_ID', 'HERDR_TAB_ID', 'HERDR_WORKSPACE_ID', 'HERDR_ENV']) delete env[key];
  const r = core.spawnToolSync(bin, attach, { stdio: 'inherit', env });
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
  // The environment of every ssh to a saved machine (machineSshEnv). This command keeps the terminal, where
  // a jump host's ssh still asks its questions; run without one, it fails with the reason, never a dialog.
  const env = core.machineSshEnv();
  // windowsHide: false, as forwardToMachine's: on Windows too, ssh asks in this command's console.
  const ssh = (script: string) =>
    core.spawnToolSync('ssh', [...SSH_OPTS, ...sshMux(target), target, script], { encoding: 'utf8', timeout: 120000, env, windowsHide: false });
  const why = (r: { stderr: string | Buffer; status: number | null }): string =>
    sshReason(String(r.stderr ?? '')) || `exit ${r.status ?? '?'}`;

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
      const cp = core.spawnToolSync('scp', [...SSH_OPTS, ...sshMux(target), src, `${target}:.local/bin/herdr.oak-new`], {
        encoding: 'utf8',
        timeout: 600000,
        env,
        windowsHide: false,
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
  // A machine is saved now: sync is offered, until it is set up here.
  const st = core.syncStatus();
  if (!st.setUp && !st.backup && !core.keptPrefs().sync?.setupAt) {
    process.stdout.write(c.dim(`share memory, plans, skills and sessions with ${label}, and choose where sessions are backed up: \`oak sync setup\`\n`));
  }
}

/**
 * Install the OAK stack on a remote machine so the tmux-attach model actually works there: the CLI
 * bundle (verified to run standalone — no node_modules), its sidecar assets, and the capture hooks.
 * herdr alone runs terminals but cannot render the observatory or capture edits. A Node that runs the local index
 * (core INDEX_NODES) is OAK's only extra remote runtime need; without it we WARN and leave herdr working rather than
 * fail the add.
 * `distDir` is this bundle's own directory (`__dirname`), which holds the index.js launcher, cli.js
 * (this CLI), capture.js + the sidecar assets.
 */
async function installOakStack(target: string, distDir: string): Promise<void> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const path = require('path');
  const env = core.machineSshEnv();
  const ssh = (script: string) => core.spawnToolSync('ssh', [...SSH_OPTS, ...sshMux(target), target, script], { encoding: 'utf8', timeout: 120000, env, windowsHide: false });
  const scp = (args: string[]) => core.spawnToolSync('scp', [...SSH_OPTS, ...sshMux(target), ...args], { encoding: 'utf8', timeout: 600000, env, windowsHide: false });
  const why = (r: { stderr?: string | Buffer; status: number | null }): string =>
    sshReason(String(r.stderr ?? '')) || `exit ${r.status ?? '?'}`;

  // A Node that runs the local index is OAK's only extra remote runtime need. A stock host often has it user-local in
  // ~/.local/bin, which a non-interactive ssh does NOT put on PATH — so check that path explicitly too.
  const nodeV = ssh('command -v node >/dev/null 2>&1 && node --version || { [ -x "$HOME/.local/bin/node" ] && "$HOME/.local/bin/node" --version; } || true');
  if (!core.nodeRunsIndex(/v\d+\.\d+\.\d+/.exec(String(nodeV.stdout || ''))?.[0] ?? '')) {
    process.stdout.write(c.yellow('! ') + `oak not installed on ${target}: needs ${core.INDEX_NODES} (found ${String(nodeV.stdout).trim() || 'none'}). herdr is set up; install that Node there and re-run \`oak machine add <label> ${target}\` to enable review + capture.\n`);
    return;
  }
  process.stdout.write(c.dim(`installing oak + capture hooks on ${target} …\n`));
  // An `oak` there that is not the launcher below (npm's, or npm's link to a checkout, which npm puts in
  // ~/.local/bin when its prefix is ~/.local) is left as it is: writing the launcher went through such a link
  // and replaced the checkout's build. Found as `--machine` finds it, on MACHINE_PATH.
  const found = ssh(`PATH="${core.MACHINE_PATH}"; o=$(command -v oak 2>/dev/null) || exit 0; ` +
    `[ "$o" = "$HOME/.local/bin/oak" ] && [ ! -L "$o" ] && grep -q '/.local/lib/oak/index.js' "$o" 2>/dev/null && exit 0; printf '%s\\n' "$o"`);
  const other = found.status === 0 ? String(found.stdout ?? '').trim() : '';
  const mk = ssh(other ? 'mkdir -p "$HOME/.local/bin"' : 'mkdir -p "$HOME/.local/lib/oak/herdr-plugin" "$HOME/.local/bin"');
  if (mk.status !== 0) fail(`could not create ~/.local on ${target}: ${why(mk)}`);
  // Put ~/.local/bin on PATH for login (.profile) and interactive (.bashrc) shells — a stock host does
  // not, so `oak` and the capture hooks would not resolve in the agent's pane. Idempotent; printf is
  // single-quoted so $HOME/$PATH land literally in the rc, evaluated when a shell starts.
  // …and .zprofile: zsh (the macOS default) reads neither of the other two.
  ssh('for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zprofile"; do touch "$rc"; grep -q "oak: user-local bin on PATH" "$rc" || printf \'\\n# oak: user-local bin on PATH\\nexport PATH="$HOME/.local/bin:$PATH"\\n\' >> "$rc"; done');
  if (other) {
    process.stdout.write(c.dim(`${target} already runs oak from ${other}, which \`oak machine add\` did not put there: left as it is\n`));
  } else {
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
    // Written beside its place and renamed over it: a write to the path itself went through a link there.
    const launch = ssh('f="$HOME/.local/bin/oak"; rm -f "$f.oak-new" && printf \'#!/bin/sh\\nexec "$(command -v node 2>/dev/null || echo "$HOME/.local/bin/node")" "$HOME/.local/lib/oak/index.js" "$@"\\n\' > "$f.oak-new" && chmod 0755 "$f.oak-new" && mv -f "$f.oak-new" "$f"');
    if (launch.status !== 0) fail(`could not install the oak launcher on ${target}: ${why(launch)}`);
  }
  // Capture hooks (claude + codex), then verify oak actually runs. Hooks are best-effort; a dead oak
  // is a hard failure. `--no-codex` on the plain init: its codex step can also wire a local model, a
  // config change that must never happen where nobody sees it; `init --codex` installs the hooks.
  const init = ssh(`PATH="${core.MACHINE_PATH}"; oak init --no-codex >/dev/null 2>&1 || true; oak init --codex >/dev/null 2>&1 || true; oak --version 2>&1`);
  if (!/oak\s+\S+/.test(String(init.stdout || ''))) fail(`installed oak on ${target}, but it did not run: ${why(init)}`);
  process.stdout.write(c.green('\u2713 ') + (other
    ? `oak on ${target} (${String(init.stdout).trim()}) + capture hooks\n`
    : `oak installed on ${target} (${String(init.stdout).trim()}) + capture hooks; ~/.local/bin on PATH\n`));
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
  const includeDone = !args.includes('--no-done');
  const here = fromIndex('inbox', () => core.attentionInbox(root, { includeDone }), (db) => core.indexedInbox(db, root, { includeDone }));
  // Other machines' hands, which only the index holds, as their records brought them: listed whichever way this machine's
  // own were read (from the files, while another process catches the index up), as `oak sessions --json` carries them.
  const synced = core.readSyncedHands(Date.now(), includeDone);
  const inbox = synced.length ? { ...here, hands: [...here.hands, ...synced].sort(core.byHand) } : here;
  if (args.includes('--next')) {
    const after = flagValue(args, '--after') ?? null;
    // A session of this machine's own: another machine's hand is answered on that machine.
    const own = inbox.hands.filter((h) => h.origin !== 'synced');
    const id = core.nextAttention(own.map((h) => ({ id: h.id, attention: { kind: h.kind, ts: h.ts } })), after);
    // How many hands wait on other machines (`elsewhere`), which the jump never goes to: said when none waits here.
    const elsewhere = inbox.hands.filter((h) => h.origin === 'synced' && h.kind !== 'idle-done').length;
    // The whole row rides along, so a caller that needs the label (JetBrains' balloon) makes ONE call.
    if (args.includes('--json')) emitJson({ next: id, hand: own.find((h) => h.id === id) ?? null, elsewhere });
    else process.stdout.write(id ? `${id}\n` : c.dim(`${core.nobodyWaitingHere(elsewhere, '`oak inbox`')}\n`));
    return;
  }
  if (args.includes('--json')) {
    emitJson(inbox);
    return;
  }
  for (const s of inbox.sync) {
    // A diverged session is resolved by deleting the copy alone: sync never takes an edit to a transcript for a merge.
    const resolve = s.reason === 'diverged' ? 'delete the copy to keep yours' : 'edit your file or delete the copy';
    process.stdout.write(`${c.yellow('sync conflict')}  ${s.family} ${s.name} from ${s.from} — its copy is ${s.copy}; ${resolve} (\`oak sync resolve ${s.id}\` deletes it)\n`);
  }
  if (!inbox.hands.length) {
    if (!inbox.sync.length) process.stdout.write(c.dim('nobody is waiting on you\n'));
    return;
  }
  for (const h of inbox.hands) {
    const kind = h.kind === 'idle-done' ? c.dim('done      ') : c.yellow(h.kind.padEnd(10));
    const wait = h.kind === 'idle-done' ? '' : c.dim(`  ${core.compactDuration(h.waitingMs)} waiting`);
    const agent = h.agent && h.agent !== 'claude' ? c.yellow(`[${h.agent}] `) : '';
    const name = h.title ? `${c.bold(h.title)}  ${c.dim(h.id)}` : c.bold(h.id);
    // Another machine's hand: where it waits, and as of when its records came over.
    const where = h.origin === 'synced' ? c.dim(`  on ${h.machine}${h.syncedAt ? `, as synced ${core.relTime(h.syncedAt)}` : ''}`) : '';
    process.stdout.write(`${kind}  ${agent}${name}${h.message ? ` — ${h.message}` : ''}${wait}${where}\n`);
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
 * active since; `--limit N` caps the rows (50); `--per-session` keeps each session's best hit only, before
 * the cap. `--machine <label>` searches a saved machine's conversations: from the local index when oak sync
 * read that machine lately (the main dispatch reaches this with it then), else over SSH, there.
 */
function cmdSearch(args: string[]): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const root = flagValue(args, '--root') ?? process.cwd();
  const { query, opts } = searchRequest(args);
  const machine = flagValue(args, '--machine');
  const res = machine ? core.indexedMachineSearch(machine, query, opts)
    : fromIndex('search', () => core.searchConversations(root, query, opts), (db) => core.indexedSearch(db, root, query, opts));
  if (!res) fail(`${machine}'s conversations are not in the local database as oak sync read them in the last ten minutes: search it there (\`oak search --machine ${machine}\`)`);
  printSearch(res, args);
}

/** What `oak search` was asked: the words, and the limit, the days back and whether each session counts once. */
function searchRequest(args: string[]): { query: string; opts: { limit?: number; sinceMs?: number; perSession: boolean } } {
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
  return {
    query,
    opts: {
      limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined,
      sinceMs: Number.isFinite(days) && days > 0 ? Date.now() - days * 86_400_000 : undefined,
      perSession: args.includes('--per-session'),
    },
  };
}

function printSearch(res: import('@oak-observatory/core').SearchResult & { fromIndex?: true; syncedAt?: number }, args: string[]): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  if (args.includes('--json')) {
    emitJson(res);
    return;
  }
  const query = res.query;
  const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
  // Another machine's conversations from its records here: as of the oak sync run that brought them.
  const from = res.fromIndex && res.syncedAt ? ` · from ${flagValue(args, '--machine')}'s records, synced ${core.relTime(res.syncedAt)}` : '';
  if (!res.hits.length) {
    process.stdout.write(c.dim(`nothing matches “${query}” across ${count(res.sessions, 'session')} (${count(res.asks, 'ask')}, ${res.ms} ms)${from}\n`));
    return;
  }
  for (const h of res.hits) {
    const name = h.title ? c.bold(h.title) : c.bold(h.session);
    const agent = h.agent && h.agent !== 'claude' ? c.yellow(`[${h.agent}] `) : '';
    process.stdout.write(`${agent}${name}  ${c.dim(`${h.session.slice(0, 8)} · ${core.relTime(h.ts)}${h.workspace ? ` · ${h.workspace}` : ''}`)}\n`);
    process.stdout.write(`    ${c.dim(h.where === 'prompt' ? 'ask' : 'answer')}  ${h.snippet}\n`);
  }
  const matching = count(res.matched, args.includes('--per-session') ? 'session' : 'ask');
  const shown = res.hits.length < res.matched ? `${res.hits.length} of the ${matching}` : matching;
  process.stdout.write(c.dim(`\n${shown} matching “${query}” · ${count(res.sessions, 'session')}, ${count(res.asks, 'ask')}, ${res.ms} ms${res.indexed ? ` (prepared ${count(res.indexed, 'session')} for search)` : ''}${from}\n`));
}

/**
 * The listings below are served from the local index when it is caught up with the files on disk, and listed the old
 * way otherwise (core index/listing.ts): when the index is unavailable (a Node without FTS5), turned off
 * (`OAK_INDEX=off`), busy (another process is catching it up) or building for the first time (a reader never waits for
 * that: a detached `oak __index-build` is started instead). `OAK_INDEX=shadow` lists the old way and records where the
 * index would have differed.
 */
function fromIndex<T>(kind: string, oldWay: () => T, indexWay: (db: import('node:sqlite').DatabaseSync) => T): T {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const mode = core.indexMode();
  if (mode === 'off') return oldWay();
  const ix = core.useIndex({ kick: true, workRefreshMs: core.LISTING_WORK_REFRESH_MS });
  if (!ix.ok) return oldWay();
  try {
    if (!ix.catchUp.caughtUp) return oldWay();
    const answer = indexWay(ix.db);
    if (mode === 'shadow') {
      const old = oldWay();
      const strip = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (k === 'ms' || k === 'indexed' || k === 'generatedAt' || k === 'waitingMs' || k === 'waitedTodayMs' ? undefined : x)));
      const diff = core.listingDifference(strip(old), strip(answer));
      if (diff) core.recordShadow(kind, diff);
      return old;
    }
    return answer;
  } catch {
    return oldWay();
  } finally {
    ix.close();
  }
}

/** Every other machine's sessions the local index holds from its records (core indexedMachineListings), read without
 *  another catch-up: the caller's listing has just caught it up. Empty where there is no index. */
function machinesFromIndex(core: Core): import('@oak-observatory/core').MachineListing[] {
  if (core.indexMode() === 'off') return [];
  const opened = core.openIndex();
  if (!opened.ok) return [];
  try {
    return core.machineListings(opened.db);
  } catch {
    return [];
  } finally {
    opened.close();
  }
}

/** The flags each named query takes, as `--<name> <value>`; `--archived` and `--all` stand alone. */
function queryParamsFrom(core: Core, name: string, args: string[]): Record<string, unknown> {
  const spec = core.NAMED_QUERIES[name]?.params ?? {};
  const out: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const key = flag.slice(2);
    // `--status` is a parameter here (`oak query edits --status pending`): the index's status is `oak query --status`.
    if (['json', 'arrays', 'table', 'serve', 'timeout', 'param', 'quiet'].includes(key)) {
      if ((key === 'timeout' || key === 'param') && inline === undefined) i++;
      continue;
    }
    if (!(key in spec)) {
      out[key] = inline ?? true; // refused by name, with the list of what it takes
      continue;
    }
    if (spec[key].type === 'bool') out[key] = inline ?? true;
    else out[key] = inline ?? args[++i];
  }
  return out;
}

/** An answer for a person at a terminal: each row as one block, a line per column, every value whole. */
function printQueryTable(answer: import('@oak-observatory/core').QueryAnswer): void {
  const cols = answer.columns;
  const width = Math.max(0, ...cols.map((name) => name.length));
  const cell = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
  answer.rows.forEach((r, n) => {
    if (n) process.stdout.write('\n');
    cols.forEach((name, i) => {
      const v = Array.isArray(r) ? r[i] : (r as Record<string, unknown>)[name];
      process.stdout.write(`${c.dim(name.padEnd(width))}  ${answer.query === 'findings' && typeof v === 'string' ? (require('@oak-observatory/core') as Core).quoteFinding(v) : cell(v)}\n`);
    });
  });
  const f = answer.freshness;
  process.stdout.write(c.dim(`\n${answer.rowCount} row${answer.rowCount === 1 ? '' : 's'}${answer.truncated ? ' (more left out by the limit)' : ''} · ${answer.elapsedMs} ms · ` +
    (f.caughtUp ? 'the database is current' : `the database was last caught up ${f.indexedAt ? (require('@oak-observatory/core') as Core).relTime(f.indexedAt) : 'never'}`) + '\n'));
  for (const p of answer.problems) process.stdout.write(c.yellow(`! ${p}\n`));
}

/**
 * `oak query <name> [--<param> <value>…] [--archived|--all] [--arrays] [--table]` and `oak query sql "<SELECT…>"`:
 * the local index's answers in the JSON contract (core index/query.ts). `--serve` answers NDJSON requests on stdin, one
 * per line (`{"id":…,"query":"sessions","params":{…}}` or `{"id":…,"sql":"SELECT …"}`), for a front end that keeps one
 * process. `--status` with no query named describes the index. Exit status: 2 for a query that cannot run, 3 when there
 * is no index here, 124 when raw SQL ran past its deadline.
 */
function printFindingsBoard(board: import('@oak-observatory/core').FindingsBoard): void {
  const core = require('@oak-observatory/core') as Core;
  if (board.count === null) { process.stdout.write(`findings unavailable: ${core.quoteFinding(board.error)}\n`); return; }
  process.stdout.write(`findings · ${board.count} · untrusted quoted data · oak finding list\n`);
  for (const r of board.rows) process.stdout.write(`  ${core.quoteFinding(r.id)} · ${core.quoteFinding(r.machine_label)} · ${core.quoteFinding(r.text)}\n`);
}

function cmdFinding(args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  const verb = args[0];
  if (verb === 'add') {
    const text = args[1];
    if (!text || text.startsWith('--')) return fail('finding add needs quoted text');
    const paths: string[] = [];
    for (let i = 2; i < args.length; i++) if (args[i] === '--path') {
      const at = paths.length;
      while (args[i + 1] && !args[i + 1].startsWith('--')) paths.push(args[++i]);
      if (paths.length === at) return fail('--path needs a file');
    }
    const added = core.addFinding(text, { cwd: process.cwd(), paths, session: flagValue(args, '--session') });
    if (args.includes('--json')) emitJson(added);
    else process.stdout.write(`Finding ${added.id} posted as untrusted data.\n`);
  } else if (verb === 'resolve') {
    if (!args[1]) return fail('finding resolve needs an id');
    core.resolveFinding(args[1], flagValue(args, '--session'));
    if (args.includes('--json')) emitJson({ id: args[1], resolved: true });
    else process.stdout.write(`Finding ${args[1]} resolved.\n`);
  } else if (verb === 'list') {
    const params = queryParamsFrom(core, 'findings', args.filter(a => a !== '--repo'));
    // A bare --repo means this checkout; an explicit key is accepted by both reading commands.
    const at = args.indexOf('--repo');
    if (at >= 0) params.repo = args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : core.findingScope(process.cwd()).repo;
    if (typeof params.path === 'string' && require('path').isAbsolute(params.path)) {
      const scope = core.findingScope(process.cwd(), [params.path]);
      params.repo = scope.repo; params.path = scope.paths[0];
    }
    const out = core.queryIndex('findings', params, { kick: true });
    if ('error' in out) return fail(out.error.message);
    if (args.includes('--json')) emitJson(out);
    else printQueryTable(out);
  } else fail('finding needs add, list or resolve');
}

function cmdQuery(args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  // The query's name: the first word that is not a flag's value.
  const name = args.find((a, i) => !a.startsWith('-') && !(i > 0 && args[i - 1].startsWith('--') && !args[i - 1].includes('=') && !['--json', '--arrays', '--table', '--archived', '--all'].includes(args[i - 1])));
  // After a query's name, `--status` is that query's parameter (`oak query edits --status pending`).
  if (!name && args.includes('--status')) {
    const st = core.indexStatus();
    if (args.includes('--table') || (!args.includes('--json') && isTTY())) {
      process.stdout.write(st.available ? `database: ${st.file}\n` : `database unavailable: ${st.reason}\n`);
      if (st.available) process.stdout.write(c.dim(`${st.sessions ?? 0} session(s), ${st.archived ?? 0} archived · ${fmtBytes(st.bytes)} · ${st.indexedAt ? `caught up ${core.relTime(st.indexedAt)}` : 'not built yet'}${st.building ? ` · a build is running (pid ${st.building.pid})` : ''}\n`));
      return;
    }
    emitJson(st);
    return;
  }
  const arrays = args.includes('--arrays');
  const table = args.includes('--table');
  const answer = (out: import('@oak-observatory/core').QueryAnswer | import('@oak-observatory/core').QueryFailure, id?: unknown): void => {
    if ('error' in out) {
      if (table) process.stderr.write(c.red('oak query: ') + `${out.error.message} (${out.error.code})\n`);
      else emitJson(id === undefined ? out : { id, ...out });
      process.exitCode = core.failureExitCode(out);
      return;
    }
    if (table) printQueryTable(out);
    else emitJson(id === undefined ? out : { id, ...out });
  };
  const deadline = (): number | undefined => {
    const t = flagValue(args, '--timeout');
    if (t === undefined) return undefined;
    const ms = Number(t);
    if (!Number.isInteger(ms) || ms < 100 || ms > 600_000) fail('--timeout is milliseconds, from 100 to 600000');
    return ms;
  };
  if (args.includes('--serve')) {
    void serveQueries(core, deadline());
    return;
  }
  if (!name) {
    answer({ v: 1, error: { code: 'bad_query', message: `name a query (${[...Object.keys(core.NAMED_QUERIES), 'schema', 'sql'].join(', ')}): \`oak query sessions\`, or \`oak query sql "SELECT …"\`` } });
    return;
  }
  if (name === 'sql') {
    const at = args.indexOf('sql');
    let sql = args[at + 1];
    if (sql === '-' || sql === undefined) sql = sql === '-' ? require('fs').readFileSync(0, 'utf8') : '';
    if (!sql || !sql.trim()) {
      answer({ v: 1, error: { code: 'bad_query', message: 'sql needs one SELECT: `oak query sql "SELECT …"`, or `-` to read it from stdin' } });
      return;
    }
    const params: (string | number | null)[] = [];
    for (let i = 0; i < args.length; i++) if (args[i] === '--param') params.push(args[i + 1] ?? null);
    const limit = flagValue(args, '--limit');
    answer(core.querySql(sql, { params, limit: limit === undefined ? undefined : Number(limit), arrays, deadlineMs: deadline(), kick: true }));
    return;
  }
  // The delegated agents' states as `oak agent list` derives them now, before the index reads their records.
  if (name === 'delegated') core.refreshDelegated();
  answer(core.queryIndex(name, queryParamsFrom(core, name, args), { arrays, kick: true }));
}

/** `oak query --serve`: one process answering a request per line until stdin closes, so a front end starts Node once.
 *  Each answer catches the index up first, for at most half a second. */
async function serveQueries(core: Core, deadlineMs: number | undefined): Promise<void> {
  const rl = require('readline').createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl as AsyncIterable<string>) {
    if (!line.trim()) continue;
    let req: { id?: unknown; query?: unknown; params?: unknown; sql?: unknown; arrays?: unknown; limit?: unknown };
    try {
      req = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ v: 1, error: { code: 'bad_query', message: 'each line is one JSON request' } }) + '\n');
      continue;
    }
    const arrays = req.arrays === true;
    let out: import('@oak-observatory/core').QueryAnswer | import('@oak-observatory/core').QueryFailure;
    if (typeof req.sql === 'string') {
      out = core.querySql(req.sql, { arrays, limit: typeof req.limit === 'number' ? req.limit : undefined, deadlineMs, kick: true, budgetMs: 500 });
    } else if (typeof req.query === 'string') {
      const params = req.params && typeof req.params === 'object' && !Array.isArray(req.params) ? (req.params as Record<string, unknown>) : {};
      out = core.queryIndex(req.query, params, { arrays, kick: true, budgetMs: 500 });
    } else {
      out = { v: 1, error: { code: 'bad_query', message: 'a request names a query ("query") or carries one SELECT ("sql")' } };
    }
    process.stdout.write(JSON.stringify(req.id === undefined ? out : { id: req.id, ...out }) + '\n');
  }
}

/** `oak __query-sql`: the child that runs one guarded read for `oak query sql`, the request on stdin. */
function cmdQuerySqlChild(): void {
  const core = require('@oak-observatory/core') as Core;
  let req: import('@oak-observatory/core').SqlRequest;
  try {
    req = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, code: 'sql_error', message: 'no request on stdin' }));
    return;
  }
  // Ends itself past the deadline even when the parent that would stop it is gone.
  if (typeof req.deadlineMs === 'number' && req.deadlineMs > 0) core.sqlChildWatchdog(req.deadlineMs);
  process.stdout.write(JSON.stringify(core.runGuardedSql(req)));
}

/**
 * `oak notify` — desktop notifications for raised hands.
 *   --message <text> [--title <t>] [--sound]     pop one notification (the plumbing check)
 *   --session <id> --kind <k> --ts <ms> [...]    announce a row IF DUE — the once-per-machine claim
 *                                                 and cooldown every surface shares; JetBrains' door
 *   --watch [--interval <s>]                      headless: announce every hand raised on this machine,
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
        // The listing `oak sessions --json` gives, from the local index when it is current (every tick read every
        // session's files before).
        // Other machines' hands too, as their records brought them, each named with its machine.
        const synced = core.readSyncedHands().map((h) => ({ id: h.id, title: h.title, agent: h.agent, attention: { kind: h.kind, message: h.message, ts: h.ts }, host: h.host, machine: h.machine }));
        for (const r of [...fromIndex('sessions', () => core.sessionMeta(root), (db) => core.indexedSessionMeta(db, root)).sessions, ...synced]) {
          const where = 'host' in r && r.host ? ` · on ${r.machine}` : '';
          const line = (): void => { process.stdout.write(`${core.relTime(Date.now())}  ${r.title ?? r.id}  ${core.attentionLabel(r.attention!.kind)}${r.attention!.message ? ` — ${r.attention!.message}` : ''}${where}\n`); };
          if (core.announceAttention(r, Date.now(), (sent) => { if (sent) line(); })) line();
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
    const attention = { kind, message: flagValue(args, '--message') ?? '', ts };
    // `--host <id> [--machine <label>]`: another machine's hand (a `syncedHands` row), announced at once and naming it.
    const host = flagValue(args, '--host');
    if (host !== undefined && !/^[0-9a-f]{12}$/.test(host)) fail(`notify: invalid machine id "${host}"`);
    // A permission prompt waits out its wait here (JetBrains runs this off its UI thread), and is
    // announced only if it still stands then; the process ends as soon as it is answered.
    const sent = await core.announceWhenDue({ id: session, title: flagValue(args, '--title') ?? null, agent: flagValue(args, '--agent') ?? '', attention,
      ...(host ? { host, machine: flagValue(args, '--machine') ?? host } : {}) });
    // `stillUp`: the hand still stood when its wait ended, whether or not this run posted it (another
    // surface may have). JetBrains pops a permission prompt up in its window only then. Another machine's hand stood as
    // its records last said.
    if (args.includes('--json')) emitJson({ sent, stillUp: host ? true : core.handStillUp(session, attention) });
    else process.stdout.write(sent ? 'notified\n' : c.dim('not due — already announced, inside the cooldown, off in the options, or a permission prompt answered while it waited\n'));
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
/** The exit status of `oak prompt`, `oak comment send` and `oak quote --send` when nothing was sent and the text was kept as
 *  a draft (sysexits' EX_TEMPFAIL: the agent could not take it now), in every output mode, so an agent driving another
 *  agent can tell; 0 only when it was sent. */
const DRAFT_KEPT_EXIT = 75;

async function promptDraft(session: string, text: string, args: string[]): Promise<boolean> {
  const core = require('@oak-observatory/core') as Core;
  let result: { sent: boolean; reason?: string };
  // With no live pane here, or with --machine, the prompt goes through a saved machine's herdr.
  stopDetachedOnSignals();
  try { result = await core.promptSession(session, text, { machine: flagValue(args, '--machine') }); }
  catch (error) { result = { sent: false, reason: String((error as Error).message || error) }; }
  if (!result.sent) {
    const choices = process.platform === 'darwin' ? [['pbcopy']] : process.platform === 'win32' ? [['clip.exe']] : [['wl-copy'], ['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard', '--input']];
    for (const [file, ...argv] of choices) {
      const copied = core.spawnToolSync(file, argv, { input: text, encoding: 'utf8', timeout: 2000 });
      if (!copied.error && copied.status === 0) break;
    }
  }
  if (!result.sent) process.exitCode = DRAFT_KEPT_EXIT;
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
    if (ids.length) markSentAfterDelivery(session, ids);
  }
}

/** The ledger step after a delivered prompt. Its failure says the prompt was delivered: said bare ("could not be
 *  saved"), JetBrains read the exit as an undelivered prompt and offered the draft to send again. */
function markSentAfterDelivery(session: string, ids: string[]): void {
  try {
    (require('@oak-observatory/core') as Core).markCommentsSent(session, ids);
  } catch (e) {
    fail(`sent to the agent, but its review comments were not marked sent, so the next send drafts them again: ${String((e as Error)?.message || e)}`);
  }
}

const AGENT_USAGE = 'agent: setup [--yes|--check] [--json] [--project] [--remove] | start --kind claude|codex [--brief <file>] … | tell <id…> <text> [--file <path>] | list [--all] | wait <id…> [--until done|blocked|any] | close <id…>';

async function cmdAgent(args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as Core;
  if (args[0] === 'setup') return (require('./agent-setup') as typeof import('./agent-setup')).cmdAgentSetup(args.slice(1));
  if (args[0] === 'tell') return cmdAgentTell(args.slice(1));
  if (args[0] === '__tell') return cmdAgentTellPayload();
  if (args[0] === '__after') return cmdAgentAfter(args[1]);
  if (args[0] === 'list') return cmdAgentList(args.slice(1));
  if (args[0] === 'wait') return cmdAgentWait(args.slice(1));
  if (args[0] === 'close') return cmdAgentClose(args.slice(1));
  if (args[0] !== 'start') return fail(AGENT_USAGE);
  const kind = flagValue(args, '--kind');
  if (kind !== 'claude' && kind !== 'codex') return fail('agent start needs --kind claude|codex');
  const cwd = flagValue(args, '--cwd');
  const machineArg = flagValue(args, '--machine');
  if (args.some(a => a === '--after' || a.startsWith('--after=')) || args.includes('--after-any')) return cmdAgentQueue(kind, args);
  if (flagValue(args, '--brief') !== undefined) return machineArg ? cmdAgentStartRemote(machineArg, args) : cmdAgentStartBrief(kind, args);
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
/** Tell's text is data, including words that look like global CLI flags. Remote hops carry JSON on stdin. */
async function cmdAgentTell(args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as Core;
  const fs = require('fs') as typeof import('fs');
  const words: string[] = [];
  let file: string | undefined, json = false, literal = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!literal && a === '--') { literal = true; continue; }
    if (!literal && a === '--json') { json = true; continue; }
    if (!literal && (a === '--file' || a.startsWith('--file='))) {
      file = a === '--file' ? args[++i] : a.slice(7);
      if (!file) return fail('agent tell --file needs a path');
      continue;
    }
    words.push(a);
  }
  const text = file ? fs.readFileSync(file, 'utf8') : words.pop() ?? '';
  const ids = [...new Set(words)];
  if (!ids.length) return fail('agent tell needs <id…> <text> or <id…> --file <path>');
  core.validateDelegatedMessage(text);
  const os = require('os') as typeof import('os');
  const from = process.env.OAK_DELEGATED ?? process.env.CODEX_THREAD_ID ?? process.env.CLAUDE_OBSERVATORY_SESSION ?? `${os.userInfo().username}@${os.hostname()}`;
  const groups = new Map<string, import('@oak-observatory/core').DelegatedAgent[]>();
  for (const id of ids) {
    const rec = core.readDelegated(id);
    if (!rec) return fail(`no delegated agent "${id}" (oak agent list shows them)`);
    if (rec.closedMs != null || core.isTerminalDelegated(rec.state) || rec.state === 'queued') return fail(`${id} is ${rec.closedMs != null ? 'closed' : rec.state}; cannot tell it`);
    const key = rec.machine ?? '';
    groups.set(key, [...(groups.get(key) ?? []), rec]);
  }
  const remote = async (machine: string, recs: import('@oak-observatory/core').DelegatedAgent[], check: boolean) => {
    const r = await agentOnMachine(machine, ['__tell', '--stdin', '--json'], JSON.stringify({ ids: recs.map(r => r.remoteId ?? r.id), text, from, check }));
    if (r.code !== 0) throw new Error(r.stderr.trim() || `agent tell on ${machine} failed (exit ${r.code})`);
    const value = JSON.parse(r.stdout);
    if (check ? value.checked !== true : !Array.isArray(value.sent)) throw new Error(`agent tell on ${machine} returned no confirmation; update OAK there`);
    return value;
  };
  for (const [machine, recs] of groups) {
    if (machine) await remote(machine, recs, true);
    else await core.checkDelegatedTell(recs.map(r => r.id));
  }
  const sent: import('@oak-observatory/core').DelegatedAgent[] = [];
  try {
    for (const [machine, recs] of groups) {
      if (machine) {
        const result = await remote(machine, recs, false);
        for (const rec of recs) {
          const there = result.sent.find((r: { id: string }) => r.id === (rec.remoteId ?? rec.id));
          if (!there) throw new Error(`${rec.id}: no delivery confirmation; check its herdr tab`);
          sent.push(core.applyRemoteDelegated(rec, there, 'ssh'));
        }
      } else for (const rec of recs) sent.push(await core.tellDelegatedAgent(rec.id, text, from));
    }
  } catch (e) {
    return fail(`${String((e as Error).message || e)}${sent.length ? `; already sent to ${sent.map(r => r.id).join(', ')}` : ''}`);
  }
  if (json) emitJson({ sent });
  else process.stdout.write(`Sent to ${sent.map(r => r.id).join(', ')}.\n`);
}

async function cmdAgentTellPayload(): Promise<void> {
  const core = require('@oak-observatory/core') as Core;
  const value = JSON.parse((require('fs') as typeof import('fs')).readFileSync(0, 'utf8'));
  if (!Array.isArray(value.ids) || !value.ids.length || !value.ids.every((id: unknown) => typeof id === 'string' && core.isDelegatedId(id)) || typeof value.text !== 'string' || typeof value.from !== 'string') return fail('invalid agent tell payload');
  core.validateDelegatedMessage(value.text);
  await core.checkDelegatedTell(value.ids);
  if (value.check === true) return emitJson({ checked: true });
  const sent = [];
  for (const id of value.ids) sent.push(await core.tellDelegatedAgent(id, value.text, value.from));
  emitJson({ sent });
}

async function cmdAgentQueue(kind: 'claude' | 'codex', args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as Core;
  const brief = flagValue(args, '--brief');
  if (!brief) return fail('agent start --after needs --brief <file>');
  const after: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--after=')) after.push(...args[i].slice(8).split(',').filter(Boolean));
    else if (args[i] === '--after') while (i + 1 < args.length && !args[i + 1].startsWith('--')) after.push(...args[++i].split(',').filter(Boolean));
  }
  const machine = flagValue(args, '--machine') ?? null;
  const cwd = flagValue(args, '--cwd') ?? (machine ? '.' : process.cwd());
  if (!machine && !(require('fs') as typeof import('fs')).statSync(cwd).isDirectory()) return fail(`agent start: no folder ${cwd} to work in`);
  const d = machine ? {} : core.delegatedDefaults(kind);
  const pick = (flag: string, fallback?: string): string | null => flagValue(args, flag) ?? fallback ?? null;
  const rec = core.queueDelegatedAgent({
    kind, brief, cwd, name: flagValue(args, '--name'), title: flagValue(args, '--title'), out: flagValue(args, '--out'), report: flagValue(args, '--report'),
    agentType: pick('--agent', d.agentType), permissionMode: pick('--permission-mode', d.permissionMode), model: pick('--model', d.model),
    effort: pick('--effort', d.effort), sandbox: pick('--sandbox', d.sandbox), args: d.args, workspace: flagValue(args, '--workspace'),
    parent: flagValue(args, '--parent') ?? process.env.OAK_DELEGATED ?? process.env.CODEX_THREAD_ID ?? process.env.CLAUDE_OBSERVATORY_SESSION ?? null,
  }, after, args.includes('--after-any'), machine);
  try {
    // The same detached CLI machinery as OAK's refresh jobs; this requested job exits after one launch or cancellation.
    const entry = require('@oak-observatory/core/dist/cli-entry').oakCliEntry();
    const child = core.spawnTool(process.execPath, [entry, 'agent', '__after', rec.id], { detached: true, stdio: 'ignore', windowsHide: true });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } catch (e) {
    core.writeDelegated({ ...rec, state: 'gone', endedMs: Date.now(), since: Date.now(), error: `Could not start queued job: ${String(e)}` });
    throw e;
  }
  if (args.includes('--json')) emitJson(rec);
  else process.stdout.write(`Queued ${rec.id}; waiting on ${after.join(', ')}.\n`);
}

/** One requested background job. It uses the existing record watcher and saved-machine refresh, then exits. */
async function cmdAgentAfter(id: string): Promise<void> {
  const core = require('@oak-observatory/core') as Core;
  if (!core.isDelegatedId(id)) return fail('invalid queued agent id');
  const fs = require('fs') as typeof import('fs'), path = require('path') as typeof import('path');
  const lock = path.join(core.delegatedDir(), `${id}.queue-lock`);
  let fd: number;
  try { fd = fs.openSync(lock, 'wx', 0o600); } catch { return; }
  try {
    for (;;) {
      const rec = core.readDelegated(id);
      if (!rec || rec.state !== 'queued' || rec.closedMs != null || !rec.launch) return;
      const rows = await delegatedNow(true);
      const decision = core.delegatedDependencies(rec, rows);
      if (core.readDelegated(id)?.closedMs != null) return;
      if (decision.error) {
        core.writeDelegated({ ...rec, state: 'gone', endedMs: Date.now(), since: Date.now(), error: decision.error });
        return;
      }
      if (decision.ready) {
        if (rec.machine) {
          const o = rec.launch;
          const argv = ['start', '--kind', rec.kind, '--brief', rec.brief, '--cwd', rec.cwd, '--name', rec.id, '--out', rec.out, '--report', rec.report, '--json'];
          for (const [flag, value] of [['--title', o.title], ['--agent', o.agentType], ['--permission-mode', o.permissionMode], ['--model', o.model], ['--effort', o.effort], ['--sandbox', o.sandbox], ['--workspace', o.workspace], ['--parent', o.parent]]) {
            if (value) argv.push(flag!, value);
          }
          const r = await agentOnMachine(rec.machine, argv);
          if (r.code !== 0) throw new Error(r.stderr.trim() || `start on ${rec.machine} failed`);
          const there = JSON.parse(r.stdout);
          if (!core.isDelegatedId(there?.id)) throw new Error(`start on ${rec.machine} returned no agent`);
          const latest = core.readDelegated(id);
          if (latest?.closedMs != null) {
            await agentOnMachine(rec.machine, ['close', there.id, '--json']);
            return;
          }
          delete rec.launch;
          rec.remoteId = there.id;
          for (const key of ['brief', 'cwd', 'out', 'report'] as const) rec[key] = there[key];
          rec.startedMs = there.startedMs;
          core.applyRemoteDelegated(rec, there, 'ssh');
        } else await core.startDelegatedAgent(rec.launch, rec);
        return;
      }
      await new Promise<void>((resolve) => {
        let watcher: ReturnType<typeof core.createWatcher> | undefined;
        const done = () => { clearTimeout(timer); watcher?.close(); resolve(); };
        const timer = setTimeout(done, Math.max(200, Number(process.env.OAK_AGENT_WAIT_MS) || 2000));
        watcher = core.createWatcher({ roots: core.delegatedWatchRoots(rows.filter(r => r.id === id || rec.after?.includes(r.id))), onChange: done, onDegrade: () => {} });
      });
    }
  } catch (e) {
    const rec = core.readDelegated(id);
    if (rec && rec.closedMs == null) core.writeDelegated({ ...rec, state: 'gone', endedMs: Date.now(), since: Date.now(), error: String((e as Error).message || e) });
  } finally {
    fs.closeSync(fd); fs.unlinkSync(lock);
  }
}

/** `oak agent start --brief <file>`: a new herdr tab labelled from the brief's title, the agent started there and handed
 *  the brief, and its row recorded (core delegated.ts). Codex's model, effort and sandbox, and Claude Code's agent type
 *  and permission mode, come from prefs.json `agents`, each overridden by its flag. */
async function cmdAgentStartBrief(kind: 'claude' | 'codex', args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as Core;
  const brief = flagValue(args, '--brief')!;
  const fs = require('fs') as typeof import('fs');
  if (!fs.existsSync(brief)) return fail(`agent start: no brief at ${brief}`);
  const cwd = flagValue(args, '--cwd') ?? process.cwd();
  if (!fs.existsSync(cwd)) return fail(`agent start: no folder ${cwd} to work in`);
  const d = core.delegatedDefaults(kind, cwd);
  const worktree = args.some(a => a === '--worktree' || a.startsWith('--worktree=')) ? flagValue(args, '--worktree') ?? true : undefined;
  const writableRoots = [...(d.writableRoots ?? [])];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--writable-root=')) writableRoots.push(args[i].slice('--writable-root='.length));
    else if (args[i] === '--writable-root') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) return fail('--writable-root needs a directory');
      writableRoots.push(args[++i]);
    }
  }
  const pick = (flag: string, fallback?: string): string | null => flagValue(args, flag) ?? fallback ?? null;
  // The agent or session this one is started from: a delegated agent's own shell names it, as Codex names its thread.
  const parent = flagValue(args, '--parent') ?? process.env.OAK_DELEGATED ?? process.env.CODEX_THREAD_ID ?? process.env.CLAUDE_OBSERVATORY_SESSION ?? null;
  stopDetachedOnSignals();
  let rec: import('@oak-observatory/core').DelegatedAgent;
  try {
    rec = await core.startDelegatedAgent({
      kind, brief, cwd, worktree, writableRoots, name: flagValue(args, '--name'), title: flagValue(args, '--title'), out: flagValue(args, '--out'), report: flagValue(args, '--report'),
      agentType: pick('--agent', d.agentType), permissionMode: pick('--permission-mode', d.permissionMode), model: pick('--model', d.model),
      effort: pick('--effort', d.effort), sandbox: pick('--sandbox', d.sandbox), args: d.args, workspace: flagValue(args, '--workspace'), parent,
      log: (line) => process.stderr.write(c.dim(`${line}\n`)),
    });
  } catch (error) {
    return fail(String((error as Error).message || error));
  }
  if (args.includes('--json')) emitJson(rec);
  else process.stdout.write(`Started ${rec.id} (${kind}) in herdr tab "${rec.id}: ${rec.title}", pane ${rec.pane}. Its report: ${rec.report}\n`);
}

/** `oak agent <argv>` run on a saved machine, as `--machine` runs a session verb there (forwardToMachine, over ssh):
 *  this CLI again, told to forward the verb, with its output captured. */
function agentOnMachine(label: string, argv: string[], input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const core = require('@oak-observatory/core') as Core;
  return new Promise((resolve) => {
    const child = core.spawnTool(process.execPath, [process.argv[1], 'agent', ...argv, '--machine', label],
      { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], env: { ...process.env, OAK_AGENT_FORWARD: '1' } });
    if (input !== undefined) { child.stdin?.on('error', () => {}); child.stdin?.end(input); }
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout?.on('data', (d: Buffer) => out.push(d));
    child.stderr?.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e: Error) => resolve({ code: null, stdout: '', stderr: e.message }));
    child.on('close', (code: number | null) => resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
  });
}

/** `oak agent start --brief … --machine <label>`: the saved machine's own OAK starts the agent there, in a herdr tab
 *  there, with the paths (brief, tree, output folder) as that machine has them; this machine keeps a row naming the
 *  machine, which list, wait and close read and act on there. */
async function cmdAgentStartRemote(label: string, args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as Core;
  const parent = flagValue(args, '--parent') ?? process.env.OAK_DELEGATED ?? process.env.CODEX_THREAD_ID ?? process.env.CLAUDE_OBSERVATORY_SESSION ?? null;
  const isMachine = (a: string, i: number) => a === '--machine' || a.startsWith('--machine=') || (i > 0 && args[i - 1] === '--machine');
  const argv = args.filter((a, i) => !isMachine(a, i) && a !== '--json' && a !== '--parent' && !(i > 0 && args[i - 1] === '--parent'));
  const r = await agentOnMachine(label, [...argv, ...(parent ? ['--parent', parent] : []), '--json']);
  let there: import('@oak-observatory/core').DelegatedAgent;
  try { there = JSON.parse(r.stdout); } catch { return fail(r.stderr.trim() || `agent start on ${label} answered nothing (exit ${r.code})`); }
  if (r.code !== 0 || !core.isDelegatedId(there?.id)) return fail(r.stderr.trim() || `agent start on ${label} failed (exit ${r.code})`);
  const rec: import('@oak-observatory/core').DelegatedAgent = { ...there, id: core.delegatedIdFor(there.id), remoteId: there.id, machine: label, pid: null, herdrName: null, parent: parent ?? there.parent };
  core.writeDelegated(rec);
  if (args.includes('--json')) emitJson(rec);
  else process.stdout.write(`Started ${rec.id} (${rec.kind}) on ${label} in herdr tab "${there.id}: ${rec.title}", pane ${rec.pane}. Its report there: ${rec.report}\n`);
}

/** When this machine last read each saved machine's agents, so a wait's polls ask a machine at most every
 *  REMOTE_READ_MS. */
const remoteReads = new Map<string, number>();
const REMOTE_READ_MS = 3000;

/** Read the agents started from here on saved machines where they run: from this machine's index when oak sync keeps
 *  that machine current (core indexedMachineDelegated), else from its `oak agent list --json` over ssh. A machine that
 *  cannot be reached keeps the rows as last read, which say when. */
async function refreshRemoteDelegated(records: import('@oak-observatory/core').DelegatedAgent[]): Promise<void> {
  const core = require('@oak-observatory/core') as Core;
  const now = Date.now();
  const byMachine = new Map<string, import('@oak-observatory/core').DelegatedAgent[]>();
  for (const r of records) if (r.machine && !r.launch && !core.isTerminalDelegated(r.state)) {
    const group = byMachine.get(r.machine);
    if (group) group.push(r);
    else byMachine.set(r.machine, [r]);
  }
  const indexed = core.refreshRemoteFromIndex(records, now);
  for (const [label, recs] of byMachine) {
    if (indexed.has(label) || now - (remoteReads.get(label) ?? 0) < REMOTE_READ_MS) continue;
    remoteReads.set(label, now);
    let agents: import('@oak-observatory/core').DelegatedRow[] | null = null;
    const r = await agentOnMachine(label, ['list', '--all', '--json']);
    try { if (r.code === 0) agents = JSON.parse(r.stdout).agents; } catch { /* not an answer */ }
    if (!Array.isArray(agents)) continue;
    const byId = new Map<string, import('@oak-observatory/core').DelegatedRow>();
    for (const agent of agents) {
      const id = agent.id;
      if (!byId.has(id)) byId.set(id, agent);
    }
    for (const rec of recs) {
      const there = byId.get(rec.remoteId ?? rec.id);
      if (there) core.applyRemoteDelegated(rec, there, 'ssh', now);
    }
  }
}

/** The ids a `wait` or `close` names: its words that are no flag and no flag's value. */
function agentIds(args: string[]): string[] {
  return args.filter((a, i) => !a.startsWith('--') && !(i > 0 && FLAGS_WITH_VALUES.has(args[i - 1])));
}

/** The delegated agents refreshed now, with what herdr's snapshots show of their panes. */
async function delegatedNow(all: boolean): Promise<import('@oak-observatory/core').DelegatedRow[]> {
  const core = require('@oak-observatory/core') as Core;
  const records = core.listDelegatedRecords();
  await refreshRemoteDelegated(records);
  const herdr = await core.delegatedPanes(records);
  return core.listDelegated({ herdr, all, records, refreshRemote: false });
}

function delegatedLine(r: import('@oak-observatory/core').DelegatedRow, now: number): string {
  const core = require('@oak-observatory/core') as Core;
  const tint = r.state === 'done' ? c.green : r.state === 'blocked' || r.state === 'gone' || r.state === 'errored' ? c.yellow : (s: string) => s;
  const read = r.remote ? `read ${core.relTime(r.remote.readMs, now)} ${r.remote.via === 'index' ? 'from its synced records' : 'over ssh'}` : null;
  const bits = [r.kind, [r.model, r.effort].filter(Boolean).join(' ') || null, r.machine ? `on ${r.machine}` : 'this machine', read, r.tab ? `tab ${r.remoteId ?? r.id}: ${r.title}` : null,
    r.tokens ? `${core.compactTokens(r.tokens)} tok` : null, r.cost ? `$${r.cost.toFixed(2)}` : null, r.closedMs !== null ? 'closed' : null, r.state === 'queued' ? `waiting on ${(r.after ?? []).join(', ')}` : null, core.agentWorktreeSummary(r.worktree)].filter(Boolean);
  const head = `${c.bold(r.id)}  ${tint(r.state)} since ${core.relTime(r.since, now)}  ${r.title}\n    ${bits.join(' · ')}${r.error ? `\n    ${c.yellow(r.error)}` : ''}\n`;
  return head + r.workers.map((w) => `    └ worker ${w.title} · ${w.state}${w.model ? ` · ${w.model}` : ''} · ${core.compactTokens(w.tokens)} tok\n`).join('');
}

/** `oak agent list` — every delegated agent with its state and since, and its workers still at it. */
async function cmdAgentList(args: string[]): Promise<void> {
  const rows = await delegatedNow(args.includes('--all'));
  const findings = (require('@oak-observatory/core') as Core).findingsBoard();
  if (args.includes('--json')) return emitJson({ agents: rows, findings });
  printFindingsBoard(findings);
  if (!rows.length) return void process.stdout.write(c.dim('no delegated agents — `oak agent start --kind claude|codex --brief <file>` starts one\n'));
  const now = Date.now();
  for (const r of rows) process.stdout.write(delegatedLine(r, now));
}

/** `oak agent wait <id…> --until done|blocked|any` — returns once that is reached, for an orchestrator's background job:
 *  `done` when every agent is done or gone (exit 1 when one is gone), `blocked` when one is blocked or stopped on an
 *  error (or none can be any more), `any` when one has turned to waiting, blocked, errored, done or gone. 124 at
 *  `--timeout <seconds>`. */
async function cmdAgentWait(args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as Core;
  const until = flagValue(args, '--until') ?? 'done';
  if (!['done', 'blocked', 'any'].includes(until)) return fail('agent wait --until done | blocked | any');
  const ids = agentIds(args);
  if (!ids.length) return fail('agent wait needs the ids of the agents to wait for (oak agent list shows them)');
  for (const id of ids) if (!core.readDelegated(id)) return fail(`no delegated agent "${id}" (oak agent list shows them)`);
  const timeout = flagValue(args, '--timeout') !== undefined ? Number(flagValue(args, '--timeout')) : Infinity;
  if (!(timeout > 0)) return fail('agent wait --timeout takes a number of seconds');
  // Each pass re-derives at once when a file it reads changes (the report, the transcript or rollout, a raised hand, a
  // session linked), and at least every OAK_AGENT_WAIT_MS (2 s) where nothing is watched or a watch cannot be had.
  const poll = Math.max(200, Number(process.env.OAK_AGENT_WAIT_MS) || 2000);
  const deadline = Date.now() + timeout * 1000;
  let wake: (() => void) | null = null;
  let watcher: { close(): void } | null = null;
  let watched = '';
  const said = new Set<string>();
  process.once('exit', () => watcher?.close());
  for (;;) {
    const rows = (await delegatedNow(true)).filter((r) => ids.includes(r.id));
    const roots = core.delegatedWatchRoots(rows);
    const key = roots.map((r) => `${r.kind}:${r.dir}`).sort().join('|');
    if (key !== watched) {
      watcher?.close();
      watched = key;
      watcher = core.createWatcher({
        roots, onChange: () => { const w = wake; wake = null; w?.(); },
        onDegrade: (dir, why) => { if (!said.has(dir)) { said.add(dir); process.stderr.write(c.dim(`watching ${dir} by polling (${why})\n`)); } },
      });
    }
    const final = rows.every((r) => core.isTerminalDelegated(r.state));
    const reached = until === 'done' ? final
      : until === 'blocked' ? final || rows.some((r) => r.state === 'blocked' || r.state === 'errored')
      : rows.some((r) => r.state !== 'queued' && r.state !== 'starting' && r.state !== 'working');
    if (reached || Date.now() >= deadline) {
      if (args.includes('--json')) emitJson({ until, reached, agents: rows });
      else { const now = Date.now(); for (const r of rows) process.stdout.write(delegatedLine(r, now)); }
      process.exitCode = !reached ? 124 : until === 'done' && rows.some((r) => r.state === 'gone') ? 1 : 0;
      watcher?.close();
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { wake = null; resolve(); }, Math.min(poll, Math.max(0, deadline - Date.now())));
      wake = () => { clearTimeout(timer); resolve(); };
    });
  }
}

/** `oak agent close <id…>` — close each agent's herdr tab; its row stays, marked closed. */
async function cmdAgentClose(args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as Core;
  const ids = agentIds(args);
  if (!ids.length) return fail('agent close needs the ids of the agents whose tabs to close');
  const closed: import('@oak-observatory/core').DelegatedAgent[] = [];
  for (const id of ids) {
    const rec = core.readDelegated(id);
    if (rec?.machine && !rec.launch) {
      // Closed where it runs, by that machine's OAK; the row here follows what it says.
      const r = await agentOnMachine(rec.machine, ['close', rec.remoteId ?? rec.id, '--json', ...(args.includes('--remove-worktree') ? ['--remove-worktree'] : [])]);
      let there: import('@oak-observatory/core').DelegatedAgent | undefined;
      try { there = JSON.parse(r.stdout).closed?.[0]; } catch { /* not an answer */ }
      if (r.code !== 0 || !there) return fail(r.stderr.trim() || `agent close on ${rec.machine} failed (exit ${r.code})`);
      rec.closedMs = there.closedMs ?? Date.now();
      closed.push(core.applyRemoteDelegated(rec, there, 'ssh'));
      continue;
    }
    try { closed.push(await core.closeDelegatedAgent(id, { removeWorktree: args.includes('--remove-worktree') })); }
    catch (error) { return fail(String((error as Error).message || error)); }
  }
  if (args.includes('--json')) emitJson({ closed });
  else for (const r of closed) process.stdout.write(`Closed ${r.id}'s tab; it stays listed under \`oak agent list --all\` (${r.state}).\n`);
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
      if (await promptDraft(session, p.text, args)) markSentAfterDelivery(session, p.ids);
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
    if (args.includes('--off')) prefs.remoteTitles = false;
    else delete prefs.remoteTitles;
    core.writePrefs(prefs);
    // No cached claude.ai title outlives the switch. Once it is saved: removed before a save that was refused (prefs.json
    // not parsing), the titles went while the setting stayed on, and the next poll fetched them again.
    if (prefs.remoteTitles === false) fs.rmSync(core.remoteTitlesCachePath(), { force: true });
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
      fail(`${del} has ${pending} edit${pending === 1 ? '' : 's'} pending review; deleting the session purges ${pending === 1 ? 'that edit' : 'those edits'} ${core.deleteWords().purged}. Review ${pending === 1 ? 'it' : 'them'} first, or pass --force.`);
    try { core.deleteSession(del, { confirmedPending: forced ? Infinity : Number(named ?? 0), seenThrough: seen === undefined ? undefined : Number(seen) }); }
    catch (e) { fail(String((e as Error)?.message || e)); }
    if (args.includes('--json')) emitJson({ deleted: del });
    // oak sync's backup folder keeps its copy of a deleted session's store, which an undelete brings back (sync-store.ts).
    else process.stdout.write(`removed session ${del} from Observatory and purged its captured edits (its transcript is untouched; \`oak sessions --undelete ${del}\` puts it back in the pickers, ${core.syncSettings().backup?.kind === 'folder' ? 'and the next `oak sync now` brings back what of its edits the backup folder holds' : 'without those edits'})\n`);
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
  // `--machine <label>` reaches here only from a `views` batch (the main dispatch runs `sessions --machine` itself, on the
  // machine or from the index): the terminal app's warm worker asks for a saved machine's sessions from the local index,
  // which answers as `oak sessions --json --machine` does when it can, and asks that machine over ssh when it cannot.
  const machine = flagValue(args, '--machine');
  if (machine) {
    const listed = core.indexedMachineSessions(machine, Date.now(), flagValue(args, '--session') ?? null);
    if (!listed) fail(`${machine}'s sessions are not in the local database as oak sync read them lately, or one of them may be running: ask it over ssh`);
    emitJson(listed);
    return;
  }
  const cwd = flagValue(args, '--root') ?? process.cwd();
  const reviewing = args.some(a => a === '--session' || a.startsWith('--session=')) ? getSessionId(args) : null;
  // --all also lists Codex's Auto-review threads, which the listing leaves out.
  const listOpts = { includeReviews: args.includes('--all') };
  const meta = fromIndex('sessions', () => core.sessionMeta(cwd, reviewing, listOpts), (db) => core.indexedSessionMeta(db, cwd, reviewing, listOpts));
  // `--synced`: every other machine's sessions this machine's index holds from its records, by label, with when oak
  // sync last brought them (the index as the listing above left it; none where there is no index, or OAK_INDEX=off).
  const machines = args.includes('--synced') ? machinesFromIndex(core) : null;
  if (args.includes('--json')) {
    // Other machines' raised hands as their records brought them, which every surface that polls this listing lists, and
    // announces, labelled with their machine (core readSyncedHands).
    const hands = core.readSyncedHands();
    emitJson({ ...meta, ...(machines ? { machines } : {}), ...(hands.length ? { syncedHands: hands } : {}) });
    return;
  }
  if (meta.sessions.length === 0 && !machines?.some((m) => m.sessions.length)) {
    process.stdout.write(c.dim(machines ? 'no sessions on this machine or in the records of another yet.\n' : 'no sessions on this machine yet.\n'));
    return;
  }
  const printRows = (rows: import('@oak-observatory/core').SessionMetaRow[], indent: string): void => {
    let workspace: string | undefined;
    for (const s of rows) {
      if (workspace !== s.workspace) {
        workspace = s.workspace;
        const count = rows.filter((r) => r.workspace === workspace).length;
        process.stdout.write(`\n${indent}${c.bold(workspace || 'Unknown workspace')} · ${count} session${count === 1 ? '' : 's'}\n`);
      }
      const mark = s.current ? c.green('● ') : '  ';
      const agent = s.agent !== 'claude' ? `[${s.agent}] ` : '';
      const stats = `${s.edits} edit${s.edits === 1 ? '' : 's'} · ${core.compactTokens(s.tokens)} tok · ${core.compactDuration(s.durationMs)} · ${s.model || 'model unknown'}`;
      process.stdout.write(`${indent}${mark}${agent}${c.bold(s.title || s.id)}  ${c.dim(s.id)}  ${c.dim(stats + ' · ' + core.relTime(s.lastActiveMs))}\n`);
    }
  };
  printRows(meta.sessions, '');
  for (const m of machines ?? []) {
    const synced = m.syncedAt ? `synced ${core.relTime(m.syncedAt)}` : 'synced at a time not recorded';
    process.stdout.write(`\n${c.bold(m.label)} ${c.dim(`· ${synced} · ${m.sessions.length} session${m.sessions.length === 1 ? '' : 's'} from its records`)}\n`);
    printRows(m.sessions, '  ');
  }
  process.stdout.write(c.dim(`\n● = resolves for this workspace · sessions on this machine${machines ? ', then each other machine\'s as oak sync last brought its records' : ''}, grouped by workspace\nuse \`--session <id>\` to target another\n`));

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
    // A bidirectional control or zero-width character in the file shows as the mark that names it (`⟨U+202E⟩`): the
    // filter on this output drops them, and a line of code that hides one runs differently from how it reads.
    if (u.patch) process.stdout.write(core.revealHidden(core.coloredDiff(session, byId.get(u.id) as EditRecord, isTTY()), isTTY()) + '\n');
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
    process.stdout.write(`${when} ${mark} ${tag} ${c.bold(a.tool.padEnd(10))} ${core.graphemeHead(a.target || '', 80)}${link}${detail}\n`);
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
    process.stdout.write(`${badge}  ${core.graphemeHead(r.target || '', 74)}\n       ${c.dim(r.reasons.join(' · '))}\n`);
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
  const follow = flagValue(args, '--follow');
  if (args.includes('--follow') && !follow) fail('--follow requires a background shell id.');
  if (follow) {
    const output = processFollowOutput(args);
    let stop = (): void => {};
    const cancel = (): void => { stop(); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); };
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    stop = core.followProcessOutput(viewRoot, session, follow, {
      onSnapshot: snapshot => { output(snapshot); if (!snapshot.process.running) cancel(); },
      onError: error => { process.stderr.write(`oak: ${error.message}\n`); process.exitCode = 1; cancel(); },
    });
    return;
  }
  if (noTranscript(session, args.includes('--json'), flagValue(args, '--root') ?? undefined)) return;
  const preview = flagValue(args, '--process-previews');
  if (preview !== undefined) {
    emitJson(core.processView(viewRoot, session, { previews: preview.split(','), selected: flagValue(args, '--process-selected') }));
    return;
  }
  const list = core.sessionProcesses(viewRoot, session);
  const sum = core.summarizeProcesses(list);
  // `--id <shell>` drills into ONE shell: the full command it is running, plus a tail of its output —
  // for a job that is still going, that tail is the only view of what it is actually doing.
  const want = flagValue(args, '--id');
  if (want) {
    const p = list.find((x) => core.processKey(x) === want);
    if (!p) fail(`no background shell "${want}" in session ${session}.`);
    if (args.includes('--json')) {
      const cursor = Number(flagValue(args, '--process-cursor'));
      const source = flagValue(args, '--process-source');
      emitJson(core.processSnapshot(viewRoot, session, want, source && Number.isSafeInteger(cursor) && cursor >= 0 ? { cursor, source } : undefined, list));
      return;
    }
    const tail = p!.recordedOutput !== undefined ? core.plainProcessOutput(p!.recordedOutput) : core.processOutputTail(p!.outputPath);
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
    process.stdout.write(`${state}  ${c.cyan(core.processKey(p).padEnd(11))} ${fmtDur(p.runtimeMs).padStart(7)}${out}\n`);
    process.stdout.write(c.dim(`             ${core.graphemeHead((p.description || p.command).replace(/\s+/g, ' '), 84)}\n`));
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
  if (args.includes('--follow')) {
    if (kind !== 'agent') fail('--follow requires --kind agent --id <worker>.');
    const output = workerFeedOutput(args);
    let stop = (): void => {};
    const cancel = (): void => { stop(); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); };
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    stop = core.followWorkerFeed(viewRoot, session, id, {
      limit,
      onError: error => { process.stderr.write(`oak: ${error.message}\n`); process.exitCode = 1; cancel(); },
      onFeed: feed => {
        output(feed);
        if (feed.endedTs) cancel();
      },
    });
    return;
  }
  const sinceRaw = flagValue(args, '--feed-since-entry');
  const sinceEntry = sinceRaw !== undefined && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : undefined;
  const res = core.liveFeed(viewRoot, session, { kind, id }, { limit, sinceEntry });
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
  printFeed(res, kind);
}

/** Follow output is append-only in a terminal; JSON callers receive one snapshot per line. */
function workerFeedOutput(args: string[]): (feed: import('@oak-observatory/core').FeedResult) => void {
  let first = true;
  let previous = new Map<string, number>();
  return feed => {
    if (args.includes('--json')) { emitJson(feed); process.stdout.write('\n'); }
    else {
      const counts = new Map<string, number>();
      const entries = feed.entries.filter(entry => {
        const key = JSON.stringify(entry), n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return n > (previous.get(key) ?? 0);
      });
      printFeed({ ...feed, entries }, 'agent', first);
      previous = counts;
    }
    first = false;
  };
}

function processFollowOutput(args: string[]): (snapshot: import('@oak-observatory/core').ProcessSnapshot) => void {
  let note = '';
  return snapshot => {
    if (args.includes('--json')) { emitJson(snapshot); process.stdout.write('\n'); }
    else {
      if (snapshot.note && snapshot.note !== note) process.stderr.write(`oak: ${snapshot.note}\n`);
      note = snapshot.note || '';
      process.stdout.write((require('@oak-observatory/core') as Core).plainProcessOutput(snapshot.outputDelta));
    }
  };
}

/** Each remote read uses the existing --machine transport, including its timeout and SSH errors.
 * No remote follower is left behind when this viewer closes. */
function followMachineWorker(args: string[], processId?: string): void {
  const core = require('@oak-observatory/core') as Core;
  if (!processId && ((flagValue(args, '--kind') ?? '') !== 'agent' || !flagValue(args, '--id'))) fail('--follow requires --kind agent --id <worker>.');
  const output = processId ? processFollowOutput(args) : workerFeedOutput(args);
  let previous: import('@oak-observatory/core').ProcessSnapshot | undefined;
  let child: ReturnType<typeof core.spawnTool> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false, sinceEntry: number | undefined;
  let session = flagValue(args, '--session');
  const stop = (): void => {
    closed = true; clearTimeout(timer); child?.kill();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const read = (): void => {
    if (closed) return;
    const argv = processId ? args.filter((a, i) => a !== '--json' && a !== '--follow' && args[i - 1] !== '--follow' && !a.startsWith('--follow='))
      : args.filter(a => a !== '--follow' && a !== '--json');
    if (processId) argv.push('--id', processId);
    if (previous) argv.push('--process-cursor', String(previous.cursor), '--process-source', previous.source);
    if (session && !flagValue(args, '--session')) argv.push('--session', session);
    if (sinceEntry !== undefined) argv.push('--feed-since-entry', String(sinceEntry));
    const run = core.spawnTool(process.execPath, [__filename, processId ? 'processes' : 'feed', ...argv, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child = run;
    let out = '', err = '';
    run.stdout?.on('data', d => { out += d; });
    run.stderr?.on('data', d => { err += d; });
    run.on('error', error => { if (!closed) { process.stderr.write(`oak: ${error.message}\n`); process.exitCode = 1; stop(); } });
    run.on('close', code => {
      child = undefined;
      if (closed) return;
      if (code !== 0) { process.stderr.write(err || `oak: remote worker log exited ${code}\n`); process.exitCode = code || 1; stop(); return; }
      try {
        const feed = JSON.parse(out) as import('@oak-observatory/core').ProcessSnapshot;
        if (processId && (feed.processLogVersion !== 1 || !feed.process || typeof feed.outputTail !== 'string'))
          throw new Error(`update OAK on ${flagValue(args, '--machine')} for live process output`);
        if (!processId && (feed.workerLogVersion !== 1 || feed.ref?.kind !== 'agent' || !Array.isArray(feed.entries)))
          throw new Error(`update OAK on ${flagValue(args, '--machine')} — this build does not support live worker logs`);
        session ??= feed.session;
        if (processId) previous = feed;
        else sinceEntry = feed.truncated + feed.entries.length;
        output(feed);
        if (feed.endedTs || (processId && !feed.process.running)) { stop(); return; }
        timer = setTimeout(read, 10000);
      } catch (error) { process.stderr.write(`oak: ${String((error as Error).message || error)}\n`); process.exitCode = 1; stop(); }
    });
  };
  read();
}

function printFeed(res: import('@oak-observatory/core').FeedResult, kind: string, heading = true): void {
  const core = require('@oak-observatory/core') as Core;
  const age = res.lastTs ? core.relTime(res.lastTs) : 'no activity yet';
  // Print core's own mode, not a re-derived running/idle: live-vs-audit IS the feature, and both editors
  // and the docs present it in exactly these words.
  const mode = res.mode === 'live' ? c.green('● live') : c.dim('▣ audit log');
  if (heading) process.stdout.write(c.bold(res.title) + c.dim(`  `) + mode + c.dim(` · ${age} · ${kind}\n`));
  if (res.note && (heading || res.endedTs)) process.stdout.write(c.dim(`${res.note}\n`));
  if (heading) process.stdout.write('\n');
  if (heading && res.truncated) process.stdout.write(c.dim(`… ${res.truncated} earlier entr${res.truncated === 1 ? 'y' : 'ies'} not shown\n`));
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
  if (heading && !res.entries.length) process.stdout.write(c.dim('nothing recorded yet\n'));
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
  // A session whose transcript is gone (an audit-log session: its store stays) lists the asks and answers the local
  // index kept of it. Only where the index holds none is there nothing to list, and the CLI says why.
  const archived = core.findTranscript(flagValue(args, '--root') ?? process.cwd(), session) ? null : core.indexedSessionPrompts(session);
  if (!archived && noTranscript(session, args.includes('--json'), flagValue(args, '--root') ?? undefined)) return;
  const fromArchive = archived ? { fromIndex: true, note: 'the transcript is gone; these asks and answers are what the local database kept of it' } : {};
  const reqs = archived ? archived.prompts : core.sessionPrompts(viewRoot, session);
  const want = flagValue(args, '--id');
  if (want) {
    const r = reqs.find((x) => x.id === want || String(x.index) === want);
    if (!r) fail(`no prompt "${want}" in session ${session} (1..${reqs.length}).`);
    // `--response`: Claude's own prose in reply to this ask (its tool calls stripped) — the log a
    // reviewer expands to read. Fetched lazily because it can be large.
    if (args.includes('--response')) {
      const kept = archived?.responses.get(r!.id);
      const resp = archived
        ? { promptId: r!.id, index: r!.index, text: kept ?? '', turns: kept ? 1 : 0, bytes: Buffer.byteLength(kept ?? ''), truncated: 0 }
        : core.promptResponse(viewRoot, session, r!.id);
      if (args.includes('--json')) {
        emitJson({ session, response: resp, ...fromArchive });
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
      emitJson({ session, prompt: r, ...fromArchive });
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
      ...fromArchive,
    });
    return;
  }
  const sum = core.summarizePrompts(reqs);
  if (!reqs.length) {
    process.stdout.write(c.dim(`no user prompts recorded in session ${session}.\n`));
    return;
  }
  process.stdout.write(c.bold('Prompts') + c.dim(`  ${sum.total} asked · ${sum.withEdits} produced edits · ${sum.edits} edit(s) total · session ${session}\n`));
  process.stdout.write(archived ? c.dim(`  ${fromArchive.note}\n\n`) : '\n');
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
    if (s.description && s.agentType) process.stdout.write('   ' + c.dim(core.graphemeHead(s.description, 100)) + '\n');
    for (const a of s.actions.slice(0, limit)) {
      const mark = a.isError ? c.red('✗') : ' ';
      process.stdout.write(`   ${mark} ${c.dim(`[${a.category}]`.padEnd(9))} ${c.bold(a.tool)} ${core.graphemeHead(a.target || '', 56)}\n`);
    }
    if (s.actions.length > limit) process.stdout.write(c.dim(`   … ${s.actions.length - limit} more (\`--all\` to expand)\n`));
    process.stdout.write('\n');
  }
}

async function workerFleetValue(args: string[]) {
  const core = require('@oak-observatory/core') as Core;
  const cwd = flagValue(args, '--root') ?? process.cwd();
  const session = flagValue(args, '--session') ?? null;
  const result = await core.readWorkerFleet(cwd, session, { allRecent: args.includes('--workers') });
  const findings = core.findingsBoard();
  return { ...result, findings };
}

async function cmdWorkerFleet(args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as Core;
  const result = await workerFleetValue(args);
  const { findings } = result;
  if (args.includes('--json')) return emitJson(result);
  printFindingsBoard(findings);
  for (const w of result.workers) process.stdout.write(`${w.title} · ${w.machine} · ${w.kind} · ${w.state} · ${core.compactTokens(w.tokens)} tok · ${core.relTime(w.lastActiveMs)}\n`);
}

/** `siblings` — the other Claude Code sessions in THIS project: active/idle, pending
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
  // --repo: the other machines' sessions of this repository too, from the local index (their records), read-only here.
  const elsewhere = args.includes('--repo') ? core.repoSessionsElsewhere(process.cwd()) : [];
  if (args.includes('--json')) {
    const list = args.includes('--all') ? sessions : sessions.filter((s) => !s.self);
    emitJson({ session, summary: sum, siblings: list, ...(args.includes('--repo') ? { machines: elsewhere } : {}) });
    return;
  }
  const printElsewhere = (): void => {
    for (const m of elsewhere) {
      process.stdout.write(`\n${c.bold(m.machine)} ${c.dim(`· synced ${m.syncedAt ? core.relTime(m.syncedAt) : 'at a time not recorded'} · read-only here: its sessions are reviewed on ${m.machine}`)}\n`);
      // The whole id: `--session <id> --machine <label>` takes it exactly, there.
      for (const r of m.sessions) process.stdout.write(`${c.dim('○')} ${c.bold(r.id)}  ${r.title ?? ''}  ${c.dim(`${r.edits} edit(s) · ${r.pending} pending · ${core.relTime(r.lastMs)}`)}\n`);
    }
  };
  if (sessions.filter((s) => !s.self).length === 0) {
    process.stdout.write(c.dim(`no sibling sessions in this project (only ${session}).\n`));
    printElsewhere();
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
  printElsewhere();
}


/** `multitask` (§4) — the multi-agent bottom-panel view: one row per running agent across every
 *  worktree of this repo (live phase, sparkline, ±lines, risk), its nested subagents (phase + current
 *  task/todos + ±lines), and the cross-agent live file conflicts. One JSON payload; both editors render it
 *  thin, no client aggregation. Zero token, git-free, path-only. */
/** One session's Workers rows: each subagent's digest with the ±lines its edits made (from its change map). */
function subagentRows(core: Core, worktree: string, session: string, map: import('@oak-observatory/core').ChangeMap) {
  const subRoll = new Map(map.rollupBySubagent.map((r) => [r.subagentId, r])); // per-subagent ±lines
  // Digests, not full parses: a fleet row needs identity, plan and live phase — never the subagent's
  // action list, which is what made this the slowest remaining part of a refresh.
  return core.subagentDigests(worktree, session).map((s) => {
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
}

function cmdMultitask(args: string[]): void {
  const core = require('@oak-observatory/core') as Core;
  const session = getSessionId(args);
  const ri = args.indexOf('--root'); // repo-scoped: honor --root like changemap/tree (editors point it at the workspace)
  const cwd = flagValue(args, '--root') ?? process.cwd();
  // `--only-session`: the session's own row, as the full read carries it, and only what the terminal app's
  // Workers and Tasks draw from it. The full read builds every sibling's row and the session's actions,
  // and a saved machine sends all of it over ssh (5.2 MB, 6.7 s for a 300-worker session on the Mac).
  // Its worktree is the transcript's own cwd, as listRepoSiblings gives it, so both reads share one cache slot. A
  // transcript the root does not lead to gets the whole fleet, as before: the session may still be one of its rows.
  const own = args.includes('--only-session') ? core.findTranscript(cwd, session) : null;
  if (own) {
    const worktree = core.firstCwdLine(own)?.cwd ?? cwd;
    const view = core.siblingOverview(worktree, session, { root: worktree });
    emitJson({ agents: [{ session, subagents: subagentRows(core, worktree, session, view.map), todos: view.todos }] });
    return;
  }
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
    const subagents = subagentRows(core, sib.worktree, sib.id, map);
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
    // The agents OAK started from a brief, with their state and their workers (core delegated.ts): every surface's Workers
    // lists them beside the sessions above.
    delegated: core.listDelegated(),
    findings: core.findingsBoard(),
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
      '  Only `undo --from-prompt <id> --dry-run`, `clean --completed --dry-run` and `ignore --dry-run` can preview;\n' +
      '  every other scope would perform the change it was asked to describe.\n' +
      `  Drop --dry-run to ${verb} for real.`
  );
}

/** Editor handoffs are written on the session's machine through the ordinary --machine route. */
function cmdEditorReview(args: string[]): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const fs = require('fs'), path = require('path'), os = require('os');
  const sub = args[0], editor = flagValue(args, '--editor') ?? 'vscode';
  if (sub === 'consume') {
    const workspace = flagValue(args, '--workspace');
    if (!workspace) fail('editor-review consume needs --workspace');
    return emitJson({ request: core.consumeEditorReviewRequest(editor, workspace) });
  }
  if (sub === 'connection') {
    const target = flagValue(args, '--target');
    if (!target || target.startsWith('-') || /[\s\0]/.test(target)) fail('Invalid SSH target');
    const r = core.spawnToolSync('ssh', ['-G', target], { encoding: 'utf8', timeout: 5000, direct: true, env: core.machineSshEnv() });
    if (r.status !== 0) fail('Could not resolve the saved SSH target');
    const values = new Map(String(r.stdout).split('\n').map(l => { const i = l.indexOf(' '); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
    return emitJson({ host: values.get('hostname'), user: values.get('user'), port: Number(values.get('port')) });
  }
  if (sub === 'map') {
    const remote = JSON.parse(flagValue(args, '--remote') ?? '{}');
    const files = flagValue(args, '--files');
    const paths: string[] = files ? JSON.parse(files) : [flagValue(args, '--file') ?? ''];
    if (!Array.isArray(paths) || paths.length > 10 || paths.some(f => typeof f !== 'string')) fail('map accepts at most 10 file paths');
    const mounts = core.readMountTable();
    const roots = new Map<string, string>();
    const mapped = [...new Set(paths)].map(file => {
      const local = core.mapReviewPath(file, flagValue(args, '--target') ?? '', remote, mounts);
      const mount = local && mounts.filter(m => local.startsWith(m.mount + '/')).sort((a, b) => b.mount.length - a.mount.length)[0];
      try {
        if (local && mount && fs.existsSync(local)) {
          if (!roots.has(mount.mount)) roots.set(mount.mount, fs.realpathSync(mount.mount));
          if (fs.realpathSync(local).startsWith(roots.get(mount.mount)! + path.sep)) return { remote: file, file: local };
        }
      } catch { /* missing or unreachable share: use the recorded contents */ }
      return { remote: file, file: null };
    });
    return emitJson(files ? { files: mapped } : { file: mapped[0]?.file ?? null });
  }
  const session = getSessionId(args);
  const workspace = core.sessionWorkspace(session);
  if (!workspace || !path.isAbsolute(workspace)) fail('The session has no recorded workspace; open its project over SSH and select the session in OAK.');
  if (sub === 'snapshot') {
    const file = flagValue(args, '--file');
    const text = (sha: string | null): string => sha ? core.readBlob(session, sha).toString('utf8') : '';
    return emitJson({ records: core.readLog(session).filter(r => r.file === file).map(r => ({ ...r, before: text(r.beforeBlob), after: text(r.afterBlob) })) });
  }
  const home = os.homedir();
  let idePath: string | null = null;
  let ideDataDirectory: string | null = null;
  const dist = path.join(home, '.cache', 'JetBrains', 'RemoteDev', 'dist');
  const product = flagValue(args, '--product');
  try {
    for (const name of fs.readdirSync(dist).sort().reverse()) {
      const dir = path.join(dist, name);
      try {
        const info = JSON.parse(fs.readFileSync(path.join(dir, 'product-info.json'), 'utf8'));
        if ((!product || info.productCode === product) && fs.existsSync(path.join(dir, 'bin', 'remote-dev-server.sh'))) { idePath = dir; ideDataDirectory = info.dataDirectoryName ?? null; break; }
      } catch { /* not an installed backend */ }
    }
  } catch { /* Gateway has not deployed an IDE yet */ }
  const installed = editor === 'jetbrains'
    ? jetbrainsPluginDirs(true).some(d => {
      // Current backends use the product's data directory; legacy backends isolate plugins per project.
      const legacy = d.includes('RemoteDev-') && path.basename(path.dirname(d)) === workspace.replace(/\//g, '_') &&
        (!product || d.includes('RemoteDev-' + product));
      const shared = ideDataDirectory && path.basename(d) === ideDataDirectory;
      return (legacy || shared) && fs.existsSync(path.join(d, JB_PLUGIN_DIRNAME));
    })
    // A Remote-SSH window runs the extension from its server's own row (`cursor-server`, `code-server`, …).
    : vscodeEditors().some(e => e.server && e.cliName.startsWith(editor === 'cursor' ? 'cursor-server' : 'code-server') && e.version !== null);
  const selectedEdit = flagValue(args, '--edit');
  const info = { workspace, home, hostname: os.hostname(), user: os.userInfo().username, shares: core.readMountTable(), installed, idePath,
    file: selectedEdit ? core.findRecord(session, Number(selectedEdit))?.file ?? null : null };
  if (sub === 'info') return emitJson(info);
  if (sub !== 'prepare') fail('Use editor-review info, prepare, consume, snapshot, map or connection');
  const action = flagValue(args, '--action') as import('@oak-observatory/core').EditorReviewRequest['action'];
  const edit = flagValue(args, '--edit'), file = flagValue(args, '--file'), prompt = flagValue(args, '--prompt');
  const records = core.reviewEdits(session);
  if (action === 'edit' && (!edit || !records.some(r => r.id === Number(edit)) && !core.findRecord(session, Number(edit)))) fail('Requested edit is absent');
  if (action === 'file' && (!file || !core.readLog(session).some(r => r.file === file))) fail('Requested file is absent');
  const request = core.writeEditorReviewRequest({ editor: editor as 'vscode' | 'cursor' | 'jetbrains', workspace, session, action,
    ...(edit ? { edit: Number(edit) } : {}), ...(file ? { file } : {}), ...(prompt ? { prompt } : {}) });
  emitJson({ ...info, request });
}

function cmdDiff(args: string[]): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const session = getSessionId(args);
  const batch = flagValue(args, '--ids');
  const pending = args.includes('--pending');
  // `--ids … --patch`: each edit's patch exactly as `diff <id> --patch` prints it, keyed by id. The terminal app reads a
  // saved machine's previews this way, all in one ssh call; it made one call per edit before, 289 for one window of a
  // 2,600-edit session. There is no cap, since only that reader asks. An edit that cannot be read goes in `errors`
  // and does not fail the rest.
  if (batch !== undefined && !pending && args.includes('--patch')) {
    const ids = batch.split(',').map(Number);
    if (ids.some(id => !Number.isSafeInteger(id) || id < 1)) fail('diff --ids accepts positive edit ids');
    const byId = new Map(core.reviewEdits(session).map(rec => [rec.id, rec]));
    const patches: Record<number, string> = {}, errors: Record<number, string> = {};
    for (const id of ids) {
      try {
        const rec = byId.get(id) ?? core.findRecord(session, id);
        if (!rec) throw new Error(`no edit #${id} in session ${session}`);
        patches[id] = core.coloredDiff(session, rec as EditRecord, false) + '\n';
      } catch (error) { errors[id] = error instanceof Error ? error.message : String(error); }
    }
    return emitJson({ patches, errors });
  }
  if (batch !== undefined || pending) {
    if (pending && batch !== undefined) fail('Use either --pending or --ids');
    let ids = batch?.split(',').map(Number) ?? [];
    if (!pending && (!ids.length || ids.length > 10 || ids.some(id => !Number.isSafeInteger(id) || id < 1))) fail('diff --ids accepts 1–10 positive edit ids');
    const budget = Number(flagValue(args, '--preview-lines') ?? '50');
    if (!Number.isSafeInteger(budget) || budget < 0) fail('--preview-lines must be a nonnegative integer');
    const byId = new Map(core.reviewEdits(session).map(rec => [rec.id, rec]));
    let prompt: { index: number } | undefined;
    if (pending) {
      const promptId = flagValue(args, '--prompt');
      const ask = promptId ? core.promptWindows(core.sessionWorkspace(session) ?? process.cwd(), session).find(p => p.id === promptId) : undefined;
      const cancelled = core.cancelledGroups(session);
      ids = (ask ? ask.editIds : [...byId.keys()]).filter(id => byId.get(id)?.status === 'pending' && !cancelled.has(id));
      if (ask) prompt = { index: ask.index };
    }
    const requestedOffset = Number(flagValue(args, '--offset') ?? '0');
    if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0) fail('--offset must be a nonnegative integer');
    const offset = pending ? Math.min(requestedOffset, Math.floor(Math.max(0, ids.length - 1) / 10) * 10) : 0;
    const pageIds = pending ? ids.slice(offset, offset + 10) : ids;
    const records = pageIds.map(id => {
      const rec = byId.get(id) ?? core.findRecord(session, id);
      if (!rec) fail(`no edit #${id} in session ${session}`);
      const patch = core.coloredDiff(session, rec, false).split('\n');
      const start = patch.findIndex(l => l.startsWith('@@'));
      const lines = (start < 0 ? patch : patch.slice(start)).filter((l, i, a) => l.length > 0 || i < a.length - 1);
      const omittedLines = budget > 0 ? Math.max(0, lines.length - budget * 2) : 0;
      const text = (sha: string | null) => sha ? core.readBlob(session, sha).toString('utf8') : '';
      return { rec, ...core.lineDelta(session, rec), patch: (omittedLines ? lines.slice(0, budget * 2) : lines).join('\n'),
        ...(args.includes('--contents') ? budget > 0 ? core.previewPair(session, rec, budget) : { before: text(rec.beforeBlob), after: text(rec.afterBlob) } : {}), omittedLines };
    });
    const os = require('os');
    return emitJson({ records, ...(pending ? { ids, prompt, offset } : {}), ...(args.includes('--contents') ? { paths: { home: os.homedir(), hostname: os.hostname(), user: os.userInfo().username, shares: core.readMountTable() } } : {}) });
  }
  const id = requireId(args);
  // The DISPLAY record first: every list shows collapsed review units, and `diff <id>` on a unit's
  // row must render the unit's whole net change — not the raw last hop, which shows a slice of what
  // the row claims. An id no row shows (a pending member inside a unit) still answers raw, so a
  // hand-typed member id keeps meaning the single record it names.
  const rec = core.reviewEdits(session).find((r) => r.id === id) ?? core.findRecord(session, id);
  if (!rec) fail(`no edit #${id} in session ${session}`);
  if (args.includes('--json')) {
    const text = (sha: string | null): string => sha ? core.readBlob(session, sha).toString('utf8') : '';
    return emitJson({ session, id, file: rec.file, patch: core.coloredDiff(session, rec as EditRecord, false),
      ...(args.includes('--contents') ? { before: text(rec.beforeBlob), after: text(rec.afterBlob) } : {}) });
  }
  // A bidirectional control or zero-width character in the file shows as the mark that names it (`⟨U+202E⟩`) wherever
  // this output is filtered for a person, which drops them: on a terminal, and in a pipe unless it is `--patch`, which a
  // pipe gets byte for byte (the terminal app reads a saved machine's patch that way, and shows the marks itself).
  const patch = core.coloredDiff(session, rec as EditRecord, isTTY());
  process.stdout.write((!isTTY() && args.includes('--patch') ? patch : core.revealHidden(patch, isTTY())) + '\n');
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
    process.exitCode = res.status === 'conflict' ? 1 : res.ok ? 0 : 1;
    return;
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
    process.exitCode = res.status === 'conflict' ? 1 : res.ok ? 0 : 1;
    return;
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
  // The local index keeps what a cleanup removes: it records the sessions first, and says so when it could not.
  const archiveFirst = (ids: string[], opts: { archive: boolean }): void => {
    for (const p of core.indexBeforeCleanup(ids, opts)) process.stderr.write(c.yellow('! ') + p + '\n');
  };
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
      // The local index keeps the records a cleanup drops: it catches up on them first.
      archiveFirst([getSessionId(args)], { archive: false });
      const res = core.clearResolvedIds(getSessionId(args), ids);
      if (json) {
        emitJson({ cleared: res.cleared, ids: res.ids });
        return;
      }
      process.stdout.write(c.green('✓ ') + `cleared ${res.cleared} resolved edit(s)\n`);
      return;
    }
    archiveFirst([getSessionId(args)], { archive: false });
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
    if (core.isReservedStoreDir(id)) fail(`"${id}" is no session but a folder the store keeps for itself — refusing to delete.`);
    // Dropped is not forgotten: the local index keeps the session, archived as cleaned (`oak sessions --delete` forgets).
    archiveFirst([id], { archive: true });
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
    archiveFirst([sess], { archive: false });
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
    if (!dry && doomed.length) archiveFirst(doomed.map((s) => s.id), { archive: true });
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
    if (stale.length) archiveFirst(stale.map((s) => s.id), { archive: true });
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
    if (all.length) archiveFirst(all.map((s) => s.id), { archive: true });
    for (const s of all) core.removeSession(s.id);
    if (json) {
      emitJson({ dropped: all.map((s) => s.id) });
      return;
    }
    process.stdout.write(c.green('✓ ') + `dropped all ${all.length} session(s)\n`);
    // Dropped is not forgotten: say so where a person wiping everything would otherwise think it gone.
    if (all.length && core.indexFiles().some((f) => f.current))
      process.stdout.write(c.dim(`  the local database keeps what it recorded of them (\`oak query edits --all\`), and so does this machine's record log (${core.recordsRoot()}), from which a new database reads it back: \`oak sessions --delete <id>\` forgets a session\n`));
    return;
  }
  // Safe default: garbage-collect orphaned blobs (optionally scoped to --session <id>), then
  // reclaim stub-session husks — dirs with no log that hold only Bash-walk snapshots. Iterates the
  // store root directly: listSessions skips log-less dirs, which made stubs unreclaimable.
  // A missing value used to widen the scope from ONE session to the whole store — and this verb's sink
  // is pruneEmptySession → removeSession → recursive rm. Scope-widening on a typo is not a default, so a
  // bare `--session` and an empty `--session=` both fail (getSessionId), as does an unsafe id.
  const only = args.some((a) => a === '--session' || a.startsWith('--session=')) ? getSessionId(args) : undefined;
  const targets = only ? [only] : core.allStoreSessionIds();
  let removed = 0;
  let bytes = 0;
  let pruned = 0;
  let maps = 0;
  let cursors = 0;
  let indexFiles = 0;
  if (!only) {
    const normalized = core.pruneCodexDerivedCache();
    bytes += normalized.bytes;
    // The Stats caches of an earlier version (`stats-cache.json` and the like), which nothing in this build reads.
    const sc = core.pruneStaleStatsCaches();
    maps += sc.removed;
    bytes += sc.bytes;
    // Blind spots the store-id loop below cannot see (all three found live on a real store):
    // 1. Cache dirs for sessions with NO store dir — version-bump orphans survive there forever, since
    //    nothing else visits them. Superseded VERSIONS only: a live-version cache for a transcript-only
    //    session is a working cache, not garbage.
    const storeIds = new Set(targets);
    for (const id of core.cachedMapSessionIds()) {
      if (storeIds.has(id)) continue; // the main loop prunes these
      const m = core.pruneSupersededCaches(id);
      maps += m.removed;
      bytes += m.bytes;
    }
    // 2. Usage cursors whose transcript is gone (hash-keyed, unreachable from any session id), and those
    //    of an earlier version, which are superseded cache files.
    const uc = core.reapUsageCursors();
    cursors = uc.removed;
    maps += uc.superseded;
    bytes += uc.bytes;
    // 3. Superseded local index files (a new format, or the store moved) whose archive the current file carried and
    //    verified: the current file holds everything they did.
    for (const f of core.reclaimableIndexFiles()) {
      const size = core.indexFiles().find((x) => x.file === f)?.bytes ?? 0;
      if (core.removeIndexFile(f)) {
        indexFiles++;
        bytes += size;
      }
    }
    // 4. blob-memo.json: written only by an uncommitted 0.8.6-era build — no released version ever read
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
    // Cached map payloads, and the other derived caches, from an earlier cache version are unreachable but
    // never overwritten, because the version is part of the filename. The GC is where they get collected.
    const m = core.pruneSupersededCaches(id);
    maps += m.removed;
    bytes += m.bytes;
    // …and so are the search indexes this build never reads (an earlier version's, or one in the session's own folder).
    const si = core.pruneStaleSearchIndexes(id);
    maps += si.removed;
    bytes += si.bytes;
    if (core.pruneEmptySession(id)) pruned++;
  }
  if (json) {
    emitJson({ removed, bytes, pruned, staleMaps: maps, cursors, indexFiles });
    return;
  }
  process.stdout.write(
    c.green('✓ ') +
      `garbage-collected ${removed} orphaned blob(s), freed ${fmtBytes(bytes)}` +
      (maps ? `, dropped ${maps} superseded cache file(s)` : '') +
      (cursors ? `, reaped ${cursors} orphaned usage cursor(s)` : '') +
      (indexFiles ? `, removed ${indexFiles} superseded database file(s)` : '') +
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
  // `--session <id>` or `--session=<id>`, checked by getSessionId (computeStats derives a store path from it);
  // with neither, this directory's session, and with none, the global/default window.
  const sid = args.some((a) => a === '--session' || a.startsWith('--session=')) ? getSessionId(args) : core.resolveSessionId(process.cwd()) || undefined;
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
      process.exitCode = anyIgnored ? 0 : 1;
      return;
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
      process.exitCode = anyIgnored ? 0 : 1; // not exit(): it would cut a long answer off in a pipe (see emitJson)
      return;
    }

    // More than one path (or none, from an empty --stdin): one line each, like git's default. The
    // rich explanation below is for the single-path case, where there is room to say WHY.
    if (rows.length !== 1) {
      for (const r of rows) {
        if (!r.d.ignored && !nonMatching) continue;
        const tag = r.d.ignored ? c.yellow('ignored') : c.green('shown  ');
        process.stdout.write(`${tag} ${r.given}\n`);
      }
      process.exitCode = anyIgnored ? 0 : 1;
      return;
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
  // `--dry-run` counts what the sweep would drop and drops nothing: the terminal app's refresh asks it
  // first, so the one irreversible thing a refresh can do is confirmed with its real count.
  if (args.includes('--dry-run')) {
    const would = core.countIgnored(session);
    if (json) emitJson({ session, wouldDrop: would });
    else process.stdout.write(`${would} recorded edit(s) are now ignored and would be dropped\n`);
    return;
  }
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
  const log = core.readLog(session).filter(r => r.file === abs);
  const recs = log.filter(r => r.status === 'pending');
  const blob = (sha: string | null): string => (sha ? core.readBlob(session, sha).toString('utf8') : '');
  const placed = core.locateEditsInCurrent(
    recs.length,
    (i) => ({ before: blob(recs[i].beforeBlob), after: blob(recs[i].afterBlob) }),
    current
  );
  // An undone edit is no longer part of the pending chain. Locate its inverse independently for Redo.
  if (args.includes('--include-undone')) for (const rec of log.filter(r => r.status === 'undone')) {
    recs.push(rec);
    placed.push(core.locateEditsInCurrent(1, () => ({ before: blob(rec.afterBlob), after: blob(rec.beforeBlob) }), current)[0]);
  }
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
async function cmdViews(args: string[]): Promise<void> {
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
  emitJson(await buildViews(names, viewArgs));
}

/** One batch of views as a value — the shared engine of `views` (one shot) and `views --serve`. */
async function buildViews(names: string[], viewArgs: string[]): Promise<Record<string, unknown>> {
  // Fleet awaits herdr. Keep that wait outside stdout capture and the synchronous derived inventory.
  let fleet: unknown, fleetError: string | undefined;
  if (names.includes('fleet')) {
    try { fleet = await workerFleetValue(viewArgs); }
    catch (e) { fleetError = String((e as Error)?.message || e); }
  }
  const core = require('@oak-observatory/core') as Core;
  return core.withDerivedInventory(() => {
    const out: Record<string, unknown> = {};
    /** view -> why it is null. Emitted as `__problems` so a null can never pass for an empty answer. */
    const problems: Record<string, string> = {};
    const realWrite = process.stdout.write.bind(process.stdout);
    const realExit = process.exit.bind(process);
    for (const name of names) {
      if (name === 'fleet') {
        out[name] = fleet ?? null;
        if (fleetError) problems[name] = fleetError;
        continue;
      }
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
  let pending = Promise.resolve();
  rl.on('line', (line: string) => {
    pending = pending.then(async () => {
      let payload: Record<string, unknown>;
      try {
        const req = JSON.parse(line) as { views?: unknown; args?: unknown };
        const names = Array.isArray(req.views) ? req.views.map(String) : [];
        const reqArgs = Array.isArray(req.args) ? req.args.map(String) : [];
        if (!names.length) throw new Error('request carries no views');
        payload = await buildViews(names, reqArgs.includes('--json') ? reqArgs : [...reqArgs, '--json']);
      } catch (e) {
        payload = { __fatal: String((e as Error)?.message || e) };
      }
      // This worker's resident size leads every answer, where the dashboard reads it without parsing the
      // payload, to retire a worker grown too big. Asking `ps` instead spawned one every 5 s per worker
      // wherever /proc is absent (macOS), and Windows had no probe at all.
      realWrite(JSON.stringify({ __rss: process.memoryUsage.rss(), ...payload }) + '\n');
    });
  });
  rl.on('close', () => { void pending.then(() => process.exit(0)); });
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
    case 'review':
      return cmdReview(args);
    case 'tree':
      return cmdTree(args);
    case 'timeline':
      return cmdTimeline(args);
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
    // Read-only: an editor reads a saved machine's session's Actions through here, since `views` runs on that machine
    // with `--machine` and `actions` alone does not.
    case 'actions':
      return cmdActions(args);
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
    if (e.reasoning) process.stdout.write('     ' + c.dim(core.graphemeHead(e.reasoning.split('\n')[0], 140)) + '\n');
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
    if (core.noBackgroundChildren() || !core.dueAccountUsagePull()) return;
    core.spawnTool(process.execPath, [process.argv[1], 'usage', '--pull-account', '--json'], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* a failed kick only means the cache stays stale until the next poll */
  }
}


/** What the `sync` verbs (sync.ts) share with the rest of the CLI: its ssh options and wording, and its output. */
function syncDeps(): SyncCliDeps {
  return { sshOpts: SSH_OPTS, sshReason, stopSignals: SSH_STOP_SIGNALS, endBySignal, fail, emitJson, c };
}

/** The saved machines' ssh a `usage --pull-machines` has running (sshUsageBrief). */
const usageSsh = new Set<ReturnType<typeof import('@oak-observatory/core').spawnTool>>();

/** `usage --pull-machines`, hidden: the pollers start it detached (core kickMachineUsage) with `--if-due`,
 *  which honours the throttle; without it, it runs now. It reads herdr's saved machines and each enabled
 *  one's `oak __usage-brief`, in parallel, and exits at its deadline whatever an inherited handle is
 *  doing. It prints nothing: `oak usage --json` shows what it read. */
function pullMachineUsage(args: string[]): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  // Ended early, at its deadline or by a signal, it stops the ssh it started: ssh has no timeout of its own once
  // a server has sent its banner, and one left running ran on, reparented, for as long as that server stalled.
  const stop = (): void => { for (const child of usageSsh) child.kill(); };
  const deadline = setTimeout(() => { stop(); process.exit(1); }, core.machineUsageDeadlineMs());
  deadline.unref();
  for (const [sig, n] of SSH_STOP_SIGNALS) process.once(sig, () => { stop(); endBySignal(sig, n); });
  const list = async (): Promise<import('@oak-observatory/core').UsageMachine[] | null> => {
    const bin = core.findHerdrBin();
    if (!bin) return []; // no herdr here, so no saved machines
    try {
      return await core.herdrMachines({ binary: bin, timeoutMs: 15000 });
    } catch {
      return null; // the list could not be read: every machine keeps its last reading
    }
  };
  void core.refreshMachineUsage(list, sshUsageBrief, { force: !args.includes('--if-due') }).then(() => clearTimeout(deadline));
}

/** One saved machine's `oak __usage-brief --json` (what `oak usage --brief --json` prints), over OAK's own ssh as
 *  forwardToMachine reaches it (herdr's target, MACHINE_PATH, never an interactive shell): its stdout, or why
 *  there is none, for the cache and `oak doctor` to name (core MachineUsageAnswer): ssh's own reason when it
 *  could not connect, no answer within MACHINE_USAGE_ASK_MS, no `oak` there, or an OAK from before the verb,
 *  which refuses it. Such a build ignored `--brief` and ran its whole `oak usage`, which starts that machine's
 *  account-usage and title reads. With `ControlMaster=no` it shares a connection already open and never becomes
 *  one, so it asks no `ssh -G`, which runs the configuration's `Match exec` commands: asked in turn, before each
 *  machine's own deadline started, slow ones held every later machine's ask past the refresh's deadline. It
 *  keeps the last 16 KB of stderr, of which the cache keeps one sanitized line. */
function sshUsageBrief(m: { target: string }, how: import('@oak-observatory/core').MachineUsageAsk = { verb: 'brief', since: null }): Promise<import('@oak-observatory/core').MachineUsageAnswer> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  const verb = how.verb === 'records' ? `__usage-records --json${how.since ? ` --since ${quote(how.since)}` : ''}` : '__usage-brief --json';
  const remote = `env PATH="${core.MACHINE_PATH}" CLAUDE_OBSERVATORY_NO_UPDATE_CHECK=1 oak ${verb}`;
  return new Promise((resolve) => {
    let child: ReturnType<typeof core.spawnTool>;
    try {
      // windowsHide: the refresh runs detached, with no console, where on Windows an ssh started without it would open one.
      child = core.spawnTool('ssh', ['-T', ...SSH_OPTS, '-o', 'ControlMaster=no', m.target, remote], { stdio: ['ignore', 'pipe', 'pipe'], direct: true, windowsHide: true, env: core.machineSshEnv() });
    } catch (e) {
      resolve({ status: 'unreachable', detail: `ssh could not start: ${String((e as Error)?.message || e)}` });
      return;
    }
    usageSsh.add(child);
    const out: Buffer[] = [];
    let size = 0;
    let err = Buffer.alloc(0);
    // A brief is under 1 KB; a page of usage records at most a few MB.
    const room = how.verb === 'records' ? 64 * 1024 * 1024 : 65536;
    child.stdout?.on('data', (d: Buffer) => { if ((size += d.length) <= room) out.push(d); });
    child.stderr?.on('data', (d: Buffer) => { err = Buffer.concat([err, d]); if (err.length > 16384) err = err.subarray(err.length - 16384); });
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    const settle = (answer: import('@oak-observatory/core').MachineUsageAnswer): void => {
      if (settled) return;
      settled = true;
      usageSsh.delete(child);
      clearTimeout(timer);
      clearTimeout(drain);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(answer);
    };
    // What ssh's exit status and stderr say: 255 is ssh's own failure, 127 an `oak` the remote shell could not
    // find, and every release names a verb it does not know on stderr as it refuses it.
    const judge = (code: number | null): import('@oak-observatory/core').MachineUsageAnswer => {
      const stderr = err.toString('utf8');
      if (code === 0) return Buffer.concat(out).toString('utf8');
      if (code === 255) return { status: 'unreachable', detail: sshReason(stderr) };
      if (code === 127) return { status: 'no-oak' };
      if (stderr.includes('unknown command "__usage-brief"') || stderr.includes('unknown command "__usage-records"')) return { status: 'old-oak' };
      return { status: 'failed', detail: core.failureLines(stderr)[0] || (code === null ? 'ended by a signal' : `exited ${code}`) };
    };
    // Settled by the deadline itself, as sshUpdate is: a remote process that outlives ssh holds its pipe open.
    const timer = setTimeout(() => {
      child.kill();
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
      settle({ status: 'timeout' });
    }, core.MACHINE_USAGE_ASK_MS);
    child.on('error', (e: Error) => settle({ status: 'unreachable', detail: `ssh could not start: ${e.message}` }));
    // ssh has ended, but a process it left (a LocalCommand's) may hold its stdout open, so 'close' may not come
    // before the deadline, which lost a whole answer: what ssh wrote is judged once its pipes have had a second
    // to drain.
    child.on('exit', (code: number | null) => { if (!settled) drain = setTimeout(() => settle(judge(code)), 1000); });
    child.on('close', (code: number | null) => settle(judge(code)));
  });
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
    core.setAccountBillDay('claude', v);
    console.log(v === 0 ? 'Claude bill day cleared — Claude month figures use calendar months.' : `Claude bill day set to the ${v}${v === 1 ? 'st' : v === 2 ? 'nd' : v === 3 ? 'rd' : 'th'} — Claude month figures now follow your bill cycle (shared with saved machines through the database).`);
    return;
  }
  const gbi = args.indexOf('--gpt-bill-day');
  if (gbi >= 0) {
    // Separate from --bill-day: the OpenAI subscription renews on its own day, and codex sends no
    // date. Read by the gpt month segment (gptUsagePanel). 0 clears (calendar months).
    const v = Number(args[gbi + 1]);
    if (!Number.isInteger(v) || v < 0 || v > 31) fail('--gpt-bill-day takes a day of month 1-31 (0 clears it).');
    core.setAccountBillDay('codex', v);
    console.log(v === 0 ? 'GPT bill day cleared — GPT month figures use calendar months.' : `GPT bill day set to the ${v}${v === 1 ? 'st' : v === 2 ? 'nd' : v === 3 ? 'rd' : 'th'} — GPT month figures now follow your bill cycle (shared with saved machines through the database).`);
    return;
  }
  if (args.includes('--breakdown')) return cmdUsageBreakdown(args);
  if (args.includes('--window') || args.some((a) => a.startsWith('--window=')) || args.includes('--by') || args.some((a) => a.startsWith('--by='))) return cmdUsageWindow(args);
  // The detached account pull: one process fetches the account's own usage (pcts + resets +
  // fable) and merges it into the statusline cache — the numbers stay live with NO claude
  // session open. Hidden verb; every poller kicks it via the claim below.
  if (args.includes('--pull-account')) {
    return void core.pullProviderAccountUsage().then((ok) => {
      if (!args.includes('--json')) console.log(ok ? 'account usage pulled.' : 'nothing pulled (no credentials, or the account answered nothing).');
    });
  }
  // The saved machines' readings of the Claude account (core machine-usage.ts): the detached refresh the
  // pollers kick below, which reads each machine's `--brief` over ssh into the store's cache.
  if (args.includes('--pull-machines')) return pullMachineUsage(args);
  // What a saved machine's refresh reads from this one: this machine's own Claude shares, from its cache
  // alone. It starts nothing here, so a read from another machine has no effects on this one.
  if (args.includes('--brief')) return emitJson(core.machineUsageBrief(process.cwd()));
  kickAccountPull(); // …and the account pull that keeps 5h/wk live without a claude session
  core.kickRemoteTitles(); // …and the Remote Control titles, on the same pollers (throttled, detached)
  core.kickMachineUsage(); // …and the saved machines' readings, for when this machine has none (throttled, detached)
  // …and the month scan, so the bill-cycle $ stays live in editor-only use. Skip it when the caller
  // IS the statusline (OAK_STATUSLINE) — the statusline reads `oak usage --session` for its token line,
  // and kicking there would have it spawn itself in a throttled loop.
  if (!process.env.OAK_STATUSLINE) core.kickMonthRefresh(process.cwd());
  // `--session <id>` or `--session=<id>`, checked by getSessionId: usageLine derives a store path from it.
  const provided = args.some((a) => a === '--session' || a.startsWith('--session=')) ? getSessionId(args) : undefined;
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
    // The month's dollar figure as the status bars show it (core.monthUsd): `~$13` estimated, `$13` charged.
    claudeMonthUsd: core.monthUsd(acct),
    claudeMonthPct: acct.monthTokens != null && acct.monthTokensTotal ? Math.min(100, (acct.monthTokens / acct.monthTokensTotal) * 100) : null,
    claudeMonthReset: acct.monthReset,
    claudeWeekTokens: acct.weekTokens,
    claudeWeekTotal: acct.weekTotal,
    // The saved machine(s) the claude* figures came from, every window's; '' for this one.
    claudeMachineNote: acct.machineNote,
    // …and the same over the windows the JetBrains widget's bar shows (wk, mo), for the bar itself to name.
    claudeMachineBarNote: acct.machineBarNote,
    // …and over the windows its tooltip shows (wk, the per-model cap, mo), for the tooltip to name.
    claudeMachineTipNote: acct.machineTipNote,
    // …and true when this machine has no Claude Code login to match that machine's account against.
    claudeMachineUnmatched: acct.machineUnmatched,
    // …and when the oldest of those windows was measured there (epoch ms), every window's and the tooltip's.
    claudeMachineAt: acct.machineAt,
    claudeMachineTipAt: acct.machineTipAt,
    // The saved machines whose own usage the estimates add to this machine's ('' for none), for the widget's tooltip.
    claudeMeasuredMachines: acct.machineMeasured?.machines ?? '',
    claudeUsageFreshness: acct.usageFreshness ?? '',
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
    gptMonthUsd: gpt ? core.monthUsd(gpt) : null,
    gptMeasuredMachines: gpt?.measuredMachines ?? null,
    gptUsageSource: gpt?.usageSource ?? null,
    gptUsageFreshness: gpt?.usageFreshness ?? '',
    sessionTokens: core.sessionUsage(process.cwd(), sid),
    // …its own turns only. With every agent it started (its workers' transcripts, `agents` of them), the figure the index's
    // `oak query usage --by session` gives: each surface shows both, labelled, so the own figure never reads as the task's.
    sessionTreeTokens: core.sessionTreeUsage(process.cwd(), sid),
    vitals: core.sessionVitals(process.cwd(), sid),
    staleMs: core.USAGE_STALE_MS,
    // The account's 5-hour, weekly and bill-cycle windows from the local index, each message counted once across every
    // machine whose usage it holds, placed by the resets claudeAccount shows; null where there is no index. The index is
    // first brought up to date for this session and this machine's usage caches (a status line's render pays for no more),
    // and only for a status line render that will use them (statuslineWantsTotals).
    usageTotals: core.machineUsageEnabled() && (!process.env.OAK_STATUSLINE || statuslineWantsTotals())
      ? core.indexedUsageTotals({ fiveReset: acct.fiveReset, weekReset: acct.weekReset, session: sid || null,
        transcript: sid ? core.findTranscript(process.cwd(), sid) : null, rollout: sid ? core.findCodexRollout(sid) : null }) : null,
  });
}

/** The bundled status line's scan interval (install-statusline.sh THR). */
const STATUSLINE_SCAN_MS = 600_000;

/** Whether the status line rendering now uses `usageTotals`: its estimator takes them in place of the scan it runs once a
 *  scan interval (no state yet, an interval since its last, or a file map from a scan still to drop). Between two, the
 *  render draws the last figures, and `oak usage` opens no index for it. */
function statuslineWantsTotals(now = Date.now()): boolean {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  try {
    const file = path.join(core.claudeConfigDir(), 'statusline-usage.json');
    if (fs.statSync(file).size > 16_384) return true; // the file map a scan kept
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as { last_scan?: unknown; fc?: unknown };
    return typeof s.last_scan !== 'number' || now - s.last_scan * 1000 >= STATUSLINE_SCAN_MS || (!!s.fc && typeof s.fc === 'object' && Object.keys(s.fc).length > 0);
  } catch {
    return true;
  }
}

/**
 * `oak usage --window <5h|week|bill|month|day|all> [--by machine|model|session|day|agent|account] [--agent claude|codex]
 * [--json]`: the account's usage in a window from the local index (`oak query usage`), each message once however many
 * machines hold it: tokens (input + output + cache creation), cache reads apart, and list-price cost.
 */
function cmdUsageWindow(args: string[]): void {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const params: Record<string, unknown> = { window: flagValue(args, '--window') ?? 'week', by: flagValue(args, '--by') ?? 'machine' };
  for (const k of ['agent', 'since', 'until', 'limit'] as const) {
    const v = flagValue(args, `--${k}`);
    if (v !== undefined) params[k] = v;
  }
  if (args.includes('--all-accounts')) params.account = 'all';
  const answer = core.queryIndex('usage', params, { kick: true });
  if ('error' in answer) {
    if (args.includes('--json')) emitJson(answer);
    else process.stderr.write(`oak usage: ${answer.error.message}\n`);
    process.exit(core.failureExitCode(answer));
  }
  if (args.includes('--json')) return emitJson(answer);
  const p = answer.params as { start: number; end: number; by: string; window: string; since?: unknown };
  const human = (n: unknown): string => {
    const v = Number(n) || 0;
    return v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(Math.round(v));
  };
  // `--since` places the span itself, in place of the window.
  process.stdout.write(c.bold(`usage · ${typeof p.since === 'number' ? 'since' : p.window} · by ${p.by}`) + c.dim(`  ${new Date(p.start).toISOString().slice(0, 16)}Z to ${new Date(Math.min(p.end, Date.now())).toISOString().slice(0, 16)}Z\n`));
  process.stdout.write(c.dim('tokens are input + output + cache creation; cache reads are counted apart; ~$ is an estimate at today\'s API list prices, not a bill\n'));
  if (p.by === 'session') process.stdout.write(c.dim('a session counts every agent it started; the line under it, `own`, is its own turns\n'));
  process.stdout.write('\n');
  const line = (tokens: unknown, read: unknown, cost: unknown, name: string): void => {
    process.stdout.write(`${human(tokens).padStart(8)}  ${c.dim(`↺${human(read)}`.padEnd(9))} ${c.dim(`~$${Number(cost ?? 0).toFixed(2)}`.padEnd(10))} ${name}\n`);
  };
  for (const r of answer.rows as Record<string, unknown>[]) {
    // A session deleted on purpose keeps its usage without its id (index/ingest.ts keepUsageOf).
    const name = r.session === '' ? '(deleted sessions)' : String(r.title ?? r.label ?? r.key ?? '') || '(none)';
    const n = Number(r.agents) || 0;
    // A session that started agents: the figure with them, then its own, each labelled (its own unknown: the one line).
    const split = n > 0 && r.own_tokens != null && r.session !== '';
    line(r.tokens, r.cache_read, r.cost, split ? `${name} · with ${n} agent${n === 1 ? '' : 's'}` : name);
    if (split) line(r.own_tokens, r.own_cache_read, r.own_cost, c.dim('  own'));
  }
  if (!answer.rows.length) process.stdout.write(c.dim('no usage in this window\n'));
  if (!answer.freshness.caughtUp) process.stdout.write(c.dim('\nthe local database is catching up; these figures may grow\n'));
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
  if (agent !== 'claude') rows.push(core.codexBreakdown(by, sinceMs, core.gptUsagePanel()?.weekReset ?? null, undefined, core.gptBillDay()));
  const promo = core.activePromo();

  if (args.includes('--json')) {
    emitJson({ by, weeks, sinceMs, weekAnchorMs: anchorMs, promo, agents: rows });
    return;
  }

  const money = (v: number): string => (v >= 100 ? `$${Math.round(v)}` : v >= 10 ? `$${v.toFixed(0)}` : `$${v.toFixed(1)}`);
  const out: string[] = [];
  out.push(`usage breakdown · by ${by} · last ${weeks} week${weeks > 1 ? 's' : ''} · ${rows.every((r) => r.usageSource === 'database') ? 'account database across machines' : 'this machine alone'}`);
  out.push(`~$ are estimates at today's API list prices, not a bill (subscriptions are flat-rate)`);
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
    // By session, one that started agents is its own row, labelled so, with the figure with them under it.
    const labelOf = (b: import('@oak-observatory/core').BreakdownBucket): string => (b.tree ? `${b.label} · own` : b.label);
    const withAgents = (n: number): string => `  with ${n} agent${n === 1 ? '' : 's'}`;
    const w = Math.max(...r.buckets.map((b) => Math.max(labelOf(b).length, b.tree ? withAgents(b.tree.agents).length : 0)), 6);
    const line = (label: string, x: Omit<import('@oak-observatory/core').BreakdownBucket, 'key' | 'label'>): string =>
      `  ${label.padEnd(w)}  ${fmtTok(x.tokens).padStart(8)} tok  ${human(x.cacheRead).padStart(7)} reads  ${(x.usdKnown ? money(x.usd) : '—').padStart(7)}${x.usdApprox ? '*' : ' '}  ${String(x.messages).padStart(6)} msgs`;
    for (const b of r.buckets.slice(0, 40)) {
      out.push(line(labelOf(b), b));
      if (b.tree) out.push(line(withAgents(b.tree.agents), b.tree));
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
const VSCODE_EDITORS: { label: string; extDirs: string[]; cli: string; app: string; winApp: string; server?: string }[] = [
  { label: 'VS Code', extDirs: ['.vscode/extensions'], cli: 'code', app: 'Visual Studio Code', winApp: 'Microsoft VS Code' },
  // Insiders is a SEPARATE install with its own extensions dir and its own CLI name — omitting it
  // did not degrade anything gracefully, it made every Insiders user invisible to `update` and
  // `install-extensions`, which then reported "no editor detected" and did nothing, forever.
  { label: 'VS Code Insiders', extDirs: ['.vscode-insiders/extensions'], cli: 'code-insiders', app: 'Visual Studio Code - Insiders', winApp: 'Microsoft VS Code Insiders' },
  { label: 'Cursor', extDirs: ['.cursor/extensions'], cli: 'cursor', app: 'Cursor', winApp: 'cursor' },
  { label: 'VSCodium', extDirs: ['.vscodium/extensions'], cli: 'codium', app: 'VSCodium', winApp: 'VSCodium' },
  { label: 'Windsurf', extDirs: ['.windsurf/extensions'], cli: 'windsurf', app: 'Windsurf', winApp: 'Windsurf' },
  // The Remote-SSH backends. A remote window runs the extension from the SERVER's own extensions dir,
  // which the desktop CLI above never writes: these used to share a row with their desktop editor, so
  // `code --install-extension` updated ~/.vscode while the server kept running the old build, and a
  // server-only machine (no desktop CLI at all) was reported as "install the shell command". Each server
  // is its own row, driven by the server binary it ships (`server` names it; see serverCli). The
  // VS Code and Cursor names are what those servers install; the other three are best-effort, which
  // costs nothing, since a name that is not there is simply not found.
  { label: 'VS Code server', extDirs: ['.vscode-server/extensions'], cli: 'code-server', app: '', winApp: '', server: '.vscode-server' },
  { label: 'VS Code Insiders server', extDirs: ['.vscode-server-insiders/extensions'], cli: 'code-server-insiders', app: '', winApp: '', server: '.vscode-server-insiders' },
  { label: 'Cursor server', extDirs: ['.cursor-server/extensions'], cli: 'cursor-server', app: '', winApp: '', server: '.cursor-server' },
  { label: 'VSCodium server', extDirs: ['.vscodium-server/extensions'], cli: 'codium-server', app: '', winApp: '', server: '.vscodium-server' },
  { label: 'Windsurf server', extDirs: ['.windsurf-server/extensions'], cli: 'windsurf-server', app: '', winApp: '', server: '.windsurf-server' },
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

/** The source checkout a CLI package directory is part of: `<root>/packages/cli` in a git work tree (a
 *  `.git` directory, or the `.git` file of a worktree). Null for an npm install and for the copy
 *  `oak machine add` pushes. */
function checkoutOf(pkgDir: string): string | null {
  const fs = require('fs');
  const path = require('path');
  const root = path.dirname(path.dirname(pkgDir));
  return path.basename(pkgDir) === 'cli' && path.basename(path.dirname(pkgDir)) === 'packages' && fs.existsSync(path.join(root, '.git')) ? root : null;
}

/** The checkout this CLI runs from, or null. Node resolves a linked `oak` to its real path, so an npm link
 *  to a checkout lands here too. No process is started: the update nudge asks this on every command. */
function runningCheckout(): string | null {
  try {
    return checkoutOf(require('fs').realpathSync(require('path').join(__dirname, '..')));
  } catch {
    return null;
  }
}

/** Where `npm i -g` puts this package, or null when npm cannot say. Not `npm root -g`: npm 11 and later print
 *  a UUID-shaped path segment as ***. A script npm runs is handed the real global prefix, whose
 *  lib/node_modules (node_modules on Windows) holds the package. Without npm's own check for a newer npm,
 *  which would ask the registry. */
function npmGlobalPackageDir(): string | null {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const path = require('path');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    const prefix = String(core.spawnToolSync(npm, ['exec', '--no-update-notifier', '--silent', '-c', 'node -p process.env.npm_config_global_prefix'], { encoding: 'utf8', timeout: 30000 }).stdout ?? '').trim();
    return path.isAbsolute(prefix) ? path.join(prefix, process.platform === 'win32' ? '' : 'lib', 'node_modules', 'oak-observatory') : null;
  } catch {
    return null;
  }
}

/**
 * The source checkout the CLI that `oak update` would replace belongs to, or null. `npm i -g` of a release
 * over an npm link (`npm link`, `npm i -g ./packages/cli`, ./install.sh) replaces the link with a copy of
 * the release, and from then on every `oak`, the capture hooks' included, runs that copy while the checkout's
 * builds change nothing. A CLI run from a checkout is left alone too: its version says nothing about the
 * install npm would replace, and a release installed beside a checkout can shadow it on PATH.
 */
function linkedCli(): string | null {
  const here = runningCheckout();
  if (here) return here;
  const fs = require('fs');
  const global = npmGlobalPackageDir();
  try {
    if (global && fs.lstatSync(global).isSymbolicLink()) {
      const target = fs.realpathSync(global);
      return checkoutOf(target) ?? target;
    }
  } catch {
    /* no global package, or a link to nothing: there is no checkout to keep */
  }
  return null;
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
}

/**
 * Finish an update in the CLI npm just installed. This process is still the OLD release: its
 * compiled-in herdr pin is the old one, its idea of a complete hook install is the old one (an update
 * that adds a hook event is exactly the case), and npm has just re-extracted node-pty, which resets the
 * macOS spawn-helper's mode. Found through npm's global root rather than `oak` on PATH, which can be
 * another install (a linked checkout, a second Node).
 *
 * Returns whether that step ran and exited 0, and the new CLI's per-component results (it writes them
 * to OAK_UPDATE_REPORT), null when it wrote none: it failed, or it is a release older than the report
 * (a switch down to one).
 */
function finishInInstalledCli(): { ok: boolean; rows: UpdateComponent[] | null } {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  let entry: string | null = null;
  try {
    const pkg = npmGlobalPackageDir();
    const bin = pkg ? JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).bin?.oak : null;
    if (pkg && typeof bin === 'string') entry = path.join(pkg, bin);
  } catch {
    /* reported below */
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-update-'));
  const report = path.join(dir, 'components.json');
  try {
    const r = entry ? core.spawnToolSync(process.execPath, [entry, '__after-update'], { stdio: 'inherit', env: { ...process.env, OAK_UPDATE_REPORT: report } }) : null;
    let rows: UpdateComponent[] | null = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(report, 'utf8'));
      if (Array.isArray(parsed)) rows = parsed as UpdateComponent[];
    } catch {
      /* no report: handled by the caller */
    }
    return { ok: r?.status === 0, rows };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** `__after-update`: the half of `oak update` that belongs to the NEW release (see finishInInstalledCli). */
async function afterUpdate(): Promise<void> {
  const components = await applyComponents(await componentPlan());
  const tui = require('@oak-observatory/tui') as typeof import('@oak-observatory/tui');
  const pty = await tui.diagnoseNativeSpawn(true);
  if (pty.level !== 'ok') process.stdout.write(c.yellow('⚠ ') + `${pty.label}: ${pty.detail}\n` + (pty.fix ? c.dim(`  → ${pty.fix}\n`) : ''));
  else if (pty.detail.startsWith('repaired')) process.stdout.write(c.green('✓ ') + `${pty.detail}\n`);
  // A supported Node whose database is still unavailable (built without node:sqlite, or OAK_INDEX=off): say once, in
  // OAK's words, what that leaves out. An update onto an unsupported Node never gets here: the launcher refuses first.
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  if (!core.indexRuntime().ok) {
    const ix = core.diagnoseIndex();
    if (ix.level !== 'ok') process.stdout.write(c.yellow('⚠ ') + `${ix.label}: ${ix.detail}\n` + (ix.fix ? c.dim(`  → ${ix.fix}\n`) : ''));
  }
  const report = process.env.OAK_UPDATE_REPORT;
  if (report) require('fs').writeFileSync(report, JSON.stringify(components));
}

/** The bundled status line, for an update whose installed CLI reports no components (a release older
 *  than the report). Runs the freshly-installed GLOBAL binary (not this process, whose bundled copy is
 *  the old version), and only when ours is actually installed. */
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

/**
 * OAK's own setup on a machine that an update keeps in step with the CLI. These are not release assets
 * with a version: they are what the CLI writes (capture hooks, the status line, herdr and its
 * integrations, the focus server), so each is judged by the CLI that is RUNNING. A stale CLI therefore
 * plans them as `after-cli` and leaves them to the release it installs.
 *
 *   current    nothing to do        update    the plan will act on it   absent   not set up here, left alone
 *   after-cli  judged by the new CLI   updated / failed   what the run did
 *   manual     yours to do, never the update's (a project's own settings file): the detail names the command
 */
type ComponentState = 'current' | 'update' | 'absent' | 'after-cli' | 'updated' | 'failed' | 'manual';
interface UpdateComponent {
  id: 'hooks' | 'project-hooks' | 'codex-hooks' | 'statusline' | 'herdr' | 'focus-server' | 'setup' | 'agent-setup';
  label: string;
  state: ComponentState;
  detail: string;
}

/** The status line script this build installs: the installer's heredoc, byte for byte as bash writes it. */
function statuslineCurrent(): boolean {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const fs = require('fs');
  const path = require('path');
  try {
    const installer = fs.readFileSync(statuslineInstallerPath(), 'utf8');
    const open = "<<'STATUSLINE_EOF'\n";
    const start = installer.indexOf(open);
    const end = installer.indexOf('\nSTATUSLINE_EOF\n', start);
    if (start < 0 || end < 0) return false;
    const want = installer.slice(start + open.length, end + 1);
    return fs.readFileSync(path.join(core.claudeConfigDir(), 'statusline.sh'), 'utf8') === want;
  } catch {
    return false;
  }
}

/** What this CLI would change in OAK's own setup here. Reads only. */
async function componentPlan(): Promise<UpdateComponent[]> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const row = (id: UpdateComponent['id'], label: string) => (state: ComponentState, detail: string): UpdateComponent => ({ id, label, state, detail });
  const out: UpdateComponent[] = [];
  const setup = core.agentSetupStatus();
  const setupItems = setup.flatMap(p => p.items);
  if (setup.length) out.push(row('agent-setup', 'Agent delegation guidance')( setupItems.some(e => e.state === 'outdated' || e.state === 'missing') ? 'update' : setupItems.some(e => e.state === 'edited') ? 'manual' : 'current',
    setupItems.length ? setupItems.map(e => `${e.path}: ${e.state}`).join('; ') : 'not set up — oak agent setup opts in'));
  // The user's settings file, the one `oak init` writes. A file the user never installed into is not one
  // an update adds hooks to. A project's own .claude/settings.json is committed and shared, so an update
  // never writes there: each one that needs repair is a row naming the command to run in it.
  const hooks = row('hooks', 'Claude Code capture hooks');
  const installed = core.installStatus().filter((f) => f.exists && f.installed);
  const files = installed.filter((f) => f.scope === 'user');
  const short = files.filter((f) => f.entries !== core.HEALTHY_HOOK_ENTRIES);
  out.push(!files.length ? hooks('absent', 'not installed — `oak init` adds them')
    : short.length ? hooks('update', short.map((f) => `${f.path}: ${f.entries} of ${core.HEALTHY_HOOK_ENTRIES} events`).join('; '))
    : hooks('current', `all ${core.HEALTHY_HOOK_ENTRIES} events`));
  for (const f of installed.filter((f) => f.scope === 'project' && f.entries !== core.HEALTHY_HOOK_ENTRIES)) {
    const missing = core.missingHookEvents(f.path);
    const what = missing.length ? `is missing ${missing.join(', ')}` : `has ${f.entries} entries for its ${core.HEALTHY_HOOK_ENTRIES} events`;
    out.push(row('project-hooks', 'Claude Code project hooks')('manual', `${f.path} ${what} — run \`oak init --repair\` there`));
  }
  const codex = row('codex-hooks', 'Codex capture hooks');
  const cx = core.codexHooksStatus(core.isOurCommand);
  // A hook the user turned off in Codex is theirs to turn back on: only a missing or changed hash is work.
  out.push(!cx.installed ? codex('absent', 'not installed — `oak init --codex` adds them')
    : cx.disabled ? codex('current', 'turned off in codex config.toml — left alone')
    : cx.trust !== 'trusted' ? codex('update', `trust is ${cx.trust} — reinstall`)
    : cx.userDisabled.length ? codex('current', `${cx.userDisabled.join(', ')} turned off in Codex — left alone`)
    : codex('current', 'installed and trusted'));
  // Only OUR status line, never a foreign one: the installer refuses those without --force, and an
  // update never passes it.
  const sl = row('statusline', 'status line');
  out.push(!core.statuslineInstalled() ? sl('absent', 'not installed, or another tool’s — left alone')
    : statuslineCurrent() ? sl('current', 'this build’s script') : sl('update', 'older than this build’s script'));
  // herdr as `oak doctor --fix` keeps it: the pinned binary when it is missing or older (a newer one is
  // the user's), plus its Claude and Codex integrations and OAK's plugin, which ensureHerdr checks first
  // and installs only when not current. Where herdr ships no build (Windows on ARM, 32-bit ARM) there is
  // nothing to install, so a missing herdr is not work.
  const herdr = row('herdr', 'herdr');
  const pin = core.readHerdrLock().version;
  const h = core.probeHerdr();
  out.push(!h.bin && !core.herdrPlatformKey() ? herdr('absent', 'herdr publishes no build for this platform')
    : !h.bin ? herdr('update', `not installed — installs the pinned ${pin}, as \`oak doctor --fix\` does`)
    : !h.current ? herdr('update', `${h.version} → ${pin}`)
    : herdr('current', `${h.version}`));
  const focus = await core.diagnoseFocusServer(false);
  out.push(row('focus-server', 'focus server')(focus.level === 'ok' ? 'current' : 'update', focus.detail));
  return out;
}

/** Bring each component the plan marked `update` up to this build, through the installer that owns it
 *  (`oak init`'s hook upsert, the codex hook installer, the bundled status line installer, doctor's
 *  herdr repair and focus-server stop). herdr is always passed through ensureHerdr, which leaves a
 *  current install alone, because its integrations are only checked there; a platform herdr ships no
 *  build for is left out. */
async function applyComponents(plan: UpdateComponent[]): Promise<UpdateComponent[]> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const out: UpdateComponent[] = [];
  for (const p of plan) {
    const set = (state: ComponentState, detail: string): UpdateComponent => ({ ...p, state, detail });
    try {
      if (p.id === 'herdr' && p.state !== 'absent') out.push({ ...p, ...(await ensureHerdrPin()) });
      else if (p.state !== 'update') out.push(p);
      else if (p.id === 'agent-setup') {
        const plans = core.refreshAgentSetup();
        const edited = plans.flatMap(p => p.items).filter(e => e.state === 'edited');
        out.push(set(edited.length ? 'manual' : 'updated', edited.length ? edited.map(e => `${e.path}: user-edited; left unchanged`).join('; ') : 'managed delegation guidance refreshed'));
      } else if (p.id === 'hooks') {
        const bad: string[] = [];
        for (const f of core.installStatus().filter((f) => f.scope === 'user' && f.exists && f.installed && f.entries !== core.HEALTHY_HOOK_ENTRIES)) {
          try {
            core.installHooks(captureCommand(false), f.path);
          } catch (e) {
            bad.push(`${f.path}: ${String((e as Error)?.message || e)}`);
          }
        }
        out.push(bad.length ? set('failed', bad.join('; ')) : set('updated', `repaired to all ${core.HEALTHY_HOOK_ENTRIES} events`));
      } else if (p.id === 'codex-hooks') {
        core.installCodexHooks(`oak capture --agent codex #${core.HOOK_MARKER}`, core.isOurCommand);
        const trust = core.codexHooksStatus(core.isOurCommand).trust;
        out.push(trust === 'trusted' ? set('updated', 'reinstalled and trusted') : set('failed', `trust is ${trust} after a reinstall — run \`oak init --codex\``));
      } else if (p.id === 'statusline') {
        // `direct`: bash is a real executable (the same call cmdStatusline makes), never `--force`.
        const r = core.spawnToolSync('bash', [statuslineInstallerPath()], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', direct: true });
        const why = String(r.stderr ?? '').split('\n').find((l) => l.trim()) || r.error?.message || `the installer exited ${r.status ?? '?'}`;
        out.push(r.status === 0 && statuslineCurrent() ? set('updated', 'refreshed to this build') : set('failed', `${why} — run \`oak statusline\``));
      } else if (p.id === 'focus-server') {
        const f = await core.diagnoseFocusServer(true);
        out.push(set(f.level === 'ok' ? 'updated' : 'failed', f.detail));
      } else out.push(p);
    } catch (e) {
      out.push(set('failed', String((e as Error)?.message || e)));
    }
  }
  return out;
}

/** Editors in the VS Code family (code/cursor/…) on PATH that already have our extension, with the
 *  installed version parsed from `--list-extensions --show-versions` (ids are lowercased by VS Code). */
/** Resolve an editor's CLI to an absolute path: PATH first, else known app-bundle locations (macOS
 *  .app bundles, Windows Programs dirs, common Linux dirs). Returns null when not found — the extension
 *  is still DETECTED via its dir, so a null means "installed but we can't drive an update", which the
 *  caller must SURFACE, never swallow. Mirrors core.resolveBin (candidates → PATH fallback). */
function resolveEditorCli(cli: string, app: string, winApp: string): string | null {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  if (onPath(cli)) {
    if (cli !== 'cursor' || process.platform === 'win32') return cli; // bare name; the launcher routes it through cmd.exe on Windows
    // The editor's own command is the first `cursor` on PATH that is not the agent's shim (see isCursorAgentShim).
    const found = String(process.env.PATH || '').split(':').filter(Boolean).map((d) => path.join(d, cli))
      .filter((p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } });
    if (!found.length || !isCursorAgentShim(found[0])) return cli;
    const editor = found.find((p) => !isCursorAgentShim(p));
    if (editor) return editor;
  }
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
    try { if (fs.existsSync(p) && !isCursorAgentShim(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

const isCursorAgentShim = (file: string): boolean => (require('@oak-observatory/core') as typeof import('@oak-observatory/core')).isCursorAgentShim(file);

/**
 * What the editor itself says is installed in `dir`, from its own `extensions.json` registry:
 * `{ '<publisher>.<name>': { version, gallery } }`, where `gallery` says a marketplace installed it
 * (`metadata.source`, the same field the VS Code extension's own updater reads). Null when the file is absent or unreadable — then the
 * caller falls back to scanning folders.
 *
 * This has to come first, because a folder scan answers a DIFFERENT question. An editor leaves the
 * previous version's folder on disk after an install, and picking the newest folder made a downgrade
 * un-redoable: after a dev→stable switch the higher `…-0.10.0-dev.12` folder lingered, so the CLI
 * kept reporting the version it had just replaced, decided there was nothing to do, and left the
 * user on a build the registry no longer even loads. The registry lists what is LOADED, one row per
 * extension — which is the thing an update has to reason about.
 */
function registeredExtVersions(dir: string): Record<string, { version: string; gallery: boolean }> | null {
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
    const out: Record<string, { version: string; gallery: boolean }> = {};
    for (const e of list) {
      const id = String(e?.identifier?.id ?? '').toLowerCase();
      const v = e?.version;
      if (id && typeof v === 'string' && v) out[id] = { version: v, gallery: e?.metadata?.source === 'gallery' };
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
  /** The editor's registry says a marketplace installed our extension (see registeredExtVersions). */
  gallery: boolean;
  /** A Remote-SSH server dir, driven by the server binary it holds rather than a desktop CLI. */
  server: boolean;
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
    let gallery = false;
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
        const v = reg[VSCODE_EXT_ID]?.version;
        if (v && (best === null || core.isNewer(v, best))) best = v;
        if (reg[VSCODE_EXT_ID]?.gallery) gallery = true;
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
    const cli = ed.server ? serverCli(path.join(home, ed.server), ed.cli) : resolveEditorCli(ed.cli, ed.app, ed.winApp);
    out.push({ label: ed.label, extDirs: ed.extDirs, extRoots, cli, cliName: ed.cli, version: best, hasOld, gallery, server: Boolean(ed.server) });
  }
  return out;
}

/**
 * The newest `name` binary a Remote-SSH server dir holds, or null. Servers keep one build per editor
 * release, in two layouts: `bin/<commit>/bin/<name>` (older VS Code; Cursor adds a platform level,
 * `bin/linux-x64/<commit>/bin/<name>`) and `cli/servers/Stable-<commit>/server/bin/<name>` (current
 * VS Code). The newest by modification time is the build the editor connects to now. Bounded depth,
 * so a large server dir is never walked whole.
 */
function serverCli(serverDir: string, name: string): string | null {
  const fs = require('fs');
  const path = require('path');
  let best: { p: string; t: number } | null = null;
  const walk = (dir: string, depth: number): void => {
    let entries: import('fs').Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth > 0 && e.name !== 'node_modules' && e.name !== 'extensions') walk(p, depth - 1); continue; }
      if (e.name !== name || path.basename(dir) !== 'bin') continue;
      try {
        const t = fs.statSync(p).mtimeMs;
        if (!best || t > best.t) best = { p, t };
      } catch { /* vanished mid-walk */ }
    }
  };
  walk(path.join(serverDir, 'bin'), 4);
  walk(path.join(serverDir, 'cli', 'servers'), 4);
  return (best as { p: string; t: number } | null)?.p ?? null;
}

/** What makes an editor row actionable when its CLI was not found. A Remote-SSH server has no shell
 *  command to install: its binary arrives when the editor next connects. */
function noCliFix(e: EditorRow | undefined): string {
  if (e?.server) return `connect to this machine from ${e.label.slice(0, -' server'.length)} once, so it installs its server (${e.cliName})`;
  const label = e?.label ?? 'VS Code';
  return `in ${label}, ⇧⌘P → "Shell Command: Install '${e?.cliName || 'code'}' command in PATH"`;
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
  // The copy `oak machine add` pushed is updated by running that again, never by npm; a CLI linked to a
  // checkout is updated in the checkout.
  const bundle = machineBundle();
  const linked = bundle ? null : linkedCli();
  const out: InstalledSurface[] = [{ surface: 'cli', label: 'CLI', version: version(), ...(bundle ? { provisioned: true } : linked ? { linked } : {}) }];
  for (const e of vscodeEditors()) {
    if (!editorPresent(e)) continue;
    // An editor with no CLI is still reported — "installed but we cannot drive an update" has to be
    // said out loud, and the plan is what carries it to whoever prints.
    out.push({ surface: 'vscode', label: e.label, version: e.version, actionable: e.cli !== null, marketplace: e.gallery, ref: e });
  }
  for (const d of jetbrainsPluginDirs(true)) {
    const pluginDir = path.join(d, JB_PLUGIN_DIRNAME);
    if (!fs.existsSync(pluginDir)) continue;
    // The IDE's own folder: `<IDE>/plugins` on macOS, Windows and Remote Development, `<IDE>` itself
    // on Linux, where two IDEs were otherwise both labelled "JetBrains (JetBrains)".
    const ide = path.basename(d) === 'plugins' ? path.basename(path.dirname(d)) : path.basename(d);
    out.push({ surface: 'jetbrains', label: `JetBrains (${ide})`, version: jbInstalledVersion(pluginDir), ref: d });
  }
  return out;
}

/** Install `vsixPath` into each target with `--install-extension --force`, handle the 0.8.6 publisher
 *  cleanup, and report per editor. Returns how many succeeded. Shared by `update` (refresh what is
 *  there) and `install-extensions` (put it where it is missing) so the two cannot drift. */
function applyVsix(targets: EditorRow[], vsixPath: string, version: string): EditorRow[] {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const installed: EditorRow[] = [];
  for (const h of targets) {
    // `h.cli` is `code`/`cursor`/… — a bare name on PATH, or an explicit `…\bin\code.cmd` on
    // Windows. BOTH are unspawnable there without cmd.exe, which is why this never once worked
    // on Windows before the launcher: libuv only extension-searches .com/.exe.
    const r = core.spawnToolSync(h.cli as string, ['--install-extension', vsixPath, '--force'], { stdio: 'inherit' });
    if (r.status === 0) {
      process.stdout.write(c.green('✓ ') + `${h.label} extension ${h.version ?? '(new)'} → ${version}\n`);
      installed.push(h);
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
  if (installed.length) process.stdout.write(c.dim('  fully quit the editor (⌘Q) once so the activity-bar icon refreshes.\n'));
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

/** What happened to one surface the plan said needed work. Rows the plan left alone have no entry. */
type RowResult = { state: 'updated' | 'failed'; detail: string };

/** Refresh the VS Code-family extension in every editor that already has it (never installs into an
 *  editor that lacks it — that is `install-extensions`' job). Downloads the .vsix once and
 *  `--install-extension --force`s it. The DECISION of what is stale came from `resolveUpdatePlan`;
 *  this only applies it, and records each row's outcome in `results`. */
async function refreshVscodeExtension(assets: ReleaseAsset[], plan: UpdatePlan, results: Map<UpdateAction, RowResult>): Promise<void> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const stale = plan.actions.filter((s) => s.surface === 'vscode' && s.reason !== 'missing');
  if (!stale.length) return;
  // Installed but no CLI could be located: SURFACE it loudly with a fix — never skip in silence.
  for (const s of stale.filter((s) => !s.actionable)) {
    process.stdout.write(
      c.yellow('  ⚠ ') +
        `${s.label} extension ${s.from} is installed, but its CLI wasn't found — can't auto-update it.\n` +
        c.dim(`    Fix: ${noCliFix(s.ref as EditorRow)}, then re-run \`oak update\`;\n`) +
        c.dim(`    or install oak-observatory-vscode-v${plan.target}.vsix from the release manually.\n`)
    );
    results.set(s, { state: 'failed', detail: `no CLI found — ${noCliFix(s.ref as EditorRow)}` });
  }
  const actionable = stale.filter((s) => s.actionable);
  if (!actionable.length) return;
  const vsix = core.assetFor(assets, 'vscode');
  if (!vsix) {
    process.stdout.write(c.yellow(`  ⚠ release v${plan.target} has no .vsix asset — could not update the VS Code extension\n`));
    for (const s of actionable) results.set(s, { state: 'failed', detail: `release ${plan.target} has no .vsix asset` });
    return;
  }
  const dest = await downloadAsset(vsix);
  const done = applyVsix(actionable.map((s) => s.ref as EditorRow), dest, plan.target);
  for (const s of actionable)
    results.set(s, done.includes(s.ref as EditorRow)
      ? { state: 'updated', detail: `${s.from} → ${plan.target}` }
      : { state: 'failed', detail: '--install-extension failed — install the .vsix from the release by hand' });
}

/** JetBrains plugin dirs across platforms — ports the detection in scripts/install-jetbrains.sh so
 *  `update` also works on an SSH host serving JetBrains Remote Development. */
function jetbrainsPluginDirs(anyProduct = false): string[] {
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
      // `update` looks in EVERY JetBrains product dir (it only acts where our plugin already is, so CLion
      // or Rider with a hand-installed plugin is refreshed too); `install-extensions` keeps to the IDEs
      // the installers name.
      if (!anyProduct && !PRODUCTS.some((p) => e.startsWith(p))) continue;
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
 *  sentinel written beside the plugin. Records each row's outcome in `results`. */
async function refreshJetbrainsPlugin(assets: ReleaseAsset[], plan: UpdatePlan, results: Map<UpdateAction, RowResult>): Promise<void> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const stale = plan.actions.filter((s) => s.surface === 'jetbrains');
  if (!stale.length) return;
  const failAll = (detail: string) => { for (const s of stale) results.set(s, { state: 'failed', detail }); };
  if (!zipToolReady()) return failAll('`unzip` was not found');
  const zip = core.assetFor(assets, 'jetbrains');
  if (!zip) {
    process.stdout.write(c.yellow(`  ⚠ release v${plan.target} has no JetBrains .zip asset — could not update the plugin\n`));
    return failAll(`release ${plan.target} has no JetBrains .zip asset`);
  }
  const dest = await downloadAsset(zip);
  const done = applyJetbrainsZip(stale.map((s) => s.ref as string), dest, plan.target);
  for (const s of stale)
    results.set(s, done.includes(s.ref as string)
      ? { state: 'updated', detail: `${s.from} → ${plan.target}; restart the IDE to load it` }
      : { state: 'failed', detail: `could not unzip into ${s.ref as string}` });
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
function applyJetbrainsZip(dirs: string[], zipPath: string, version: string): string[] {
  const fs = require('fs');
  const path = require('path');
  const installed: string[] = [];
  for (const d of dirs) {
    const pluginDir = path.join(d, JB_PLUGIN_DIRNAME);
    try {
      fs.rmSync(pluginDir, { recursive: true, force: true }); // drop files gone from the new build
      fs.rmSync(path.join(d, JB_PLUGIN_DIRNAME_OLD), { recursive: true, force: true }); // remove the pre-rename plugin so a migrated IDE has one, not two
      if (!extractZip(zipPath, d)) throw new Error('extract failed');
      fs.writeFileSync(path.join(pluginDir, JB_VERSION_SENTINEL), version);
      process.stdout.write(c.green('✓ ') + `JetBrains plugin → ${version} (${d})\n`);
      installed.push(d);
    } catch (e: any) {
      process.stdout.write(c.yellow(`  ⚠ could not install the JetBrains plugin into ${d}: ${e?.message || e}\n`));
    }
  }
  if (installed.length) {
    process.stdout.write(c.dim('  fully restart the IDE (⌘Q → reopen) — a running JVM can’t hot-swap plugin classes.\n'));
    process.stdout.write(jetbrainsAutoUpdateHint());
  }
  return installed;
}

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
    // A Remote-SSH server dir whose server binary is gone (the editor removed an old build) holds
    // nothing to drive and nothing a person can fix from here; the editor reinstalls its server on the
    // next connection. Said, not counted as a failure, as when the dirs belonged to the desktop row.
    for (const e of editors.filter((e) => !e.cli && e.server))
      process.stdout.write(c.dim(`${e.label}: no server binary found — skipped; ${noCliFix(e)} to install into it.\n`));
    const noCli = editors.filter((e) => !e.cli && !e.server);
    for (const e of noCli) {
      // Never a silent skip: the editor is here, we just cannot drive it.
      process.stdout.write(
        c.yellow('  ⚠ ') +
          `${e.label} is installed but its CLI wasn't found — can't install into it.\n` +
          c.dim(`    Fix: ${noCliFix(e)}, then re-run.\n`)
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
      const n = applyVsix(actionable, src, target).length;
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
        const n = applyJetbrainsZip(targets, src, target).length;
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
async function ensureHerdrPin(): Promise<Pick<UpdateComponent, 'state' | 'detail'>> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  try {
    const report = await core.ensureHerdr({ startServer: false });
    const did: string[] = [];
    if (report.upgraded) {
      process.stdout.write(c.green('✓ ') + `herdr ${report.version} installed (pinned by herdr.lock)\n`);
      did.push(`installed ${report.version}`);
    }
    if (report.sidebarConfigured) {
      process.stdout.write(c.green('✓ ') + `herdr sidebar widths set in its config.toml (a backup sits beside it)\n`);
      did.push('sidebar widths set');
    }
    if (report.themeConfigured) {
      process.stdout.write(c.green('✓ ') + `herdr theme: gruvbox (set)\n`);
      did.push('theme set');
    }
    for (const w of report.warnings) process.stdout.write(c.yellow('⚠ ') + w + '\n');
    const integrations = Object.entries(report.integrations ?? {});
    const added = integrations.filter(([, v]) => v === 'installed').map(([k]) => k);
    if (added.length) did.push(`${added.join(' and ')} integration installed`);
    const failed = integrations.filter(([, v]) => v === 'failed').map(([k]) => k);
    if (failed.length) return { state: 'failed', detail: `the ${failed.join(' and ')} integration did not install — run \`oak doctor --fix\`` };
    return did.length ? { state: 'updated', detail: `${report.version}: ${did.join(', ')}` } : { state: 'current', detail: `${report.version}` };
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    process.stderr.write(c.yellow('⚠ ') + `could not verify herdr: ${msg} — run \`oak doctor --fix\`\n`);
    return { state: 'failed', detail: `${msg} — run \`oak doctor --fix\`` };
  }
}

/** A saved machine's part of `oak update`: its own `oak update --here`, run over ssh.
 *
 *   current     nothing to do there            update      its plan has work (plan only)
 *   updated     its update ran and succeeded   failed      it ran and failed, or its answer was unreadable
 *   no-oak      OAK is not installed there     old-oak     its OAK predates `update --here`
 *   unreachable ssh could not connect          timeout     no answer within the deadline
 *   disabled    disabled in herdr, skipped
 *   linked      its CLI is linked to a checkout, and its OAK predates leaving such a CLI alone: nothing ran
 *   provisioned its OAK is the copy `oak machine add` pushed, older than leaving such a copy alone: nothing ran
 */
type MachineState = 'current' | 'update' | 'updated' | 'failed' | 'no-oak' | 'old-oak' | 'linked' | 'provisioned' | 'unreachable' | 'timeout' | 'disabled';
interface MachineUpdate {
  label: string;
  target: string;
  state: MachineState;
  detail: string;
  /** The machine's own `update --here --json`: its plan, or after an update its state afterwards. */
  plan?: any;
}
/** The machine states an update counts as failed: something is installed there that it could not update. */
const MACHINE_FAILED: ReadonlySet<MachineState> = new Set(['failed', 'old-oak', 'unreachable', 'timeout']);
/** Reading a machine's plan is one ssh and one release-feed fetch; applying it can be an npm install
 *  and an editor install. With herdr's machine list (15 s), both leave most of the fifteen minutes the
 *  editors give a whole `oak update` to this machine's own installs (a gate test holds the sum).
 *  OAK_MACHINE_TIMEOUT_MS overrides both, as it does for `--machine`. */
const MACHINE_PLAN_TIMEOUT_MS = 45_000;
const MACHINE_APPLY_TIMEOUT_MS = 180_000;

/** The ssh children `oak update` has running on saved machines. Told to stop (an editor's deadline sends
 *  SIGTERM), it stops them too, as forwardToMachine stops its one, and ends as the signal ends it:
 *  otherwise each outlives this process, reparented, until its machine's update ends. While none is
 *  running, a signal ends the update as it always has. */
const updateSsh = new Set<ReturnType<typeof import('@oak-observatory/core').spawnTool>>();
const updateSshStops = SSH_STOP_SIGNALS.map(([sig, n]) => [sig, () => {
  for (const c of updateSsh) c.kill();
  endBySignal(sig, n);
}] as const);
/** Any other exit (an uncaught exception) stops each one no handler above has stopped already. */
const updateSshExit = (): void => { for (const c of updateSsh) if (!c.killed) c.kill(); };
function stopWithUpdate(child: ReturnType<typeof import('@oak-observatory/core').spawnTool>): void {
  if (!updateSsh.size) {
    for (const [sig, stop] of updateSshStops) process.once(sig, stop);
    process.once('exit', updateSshExit);
  }
  updateSsh.add(child);
  child.on('close', () => {
    updateSsh.delete(child);
    if (!updateSsh.size) {
      for (const [sig, stop] of updateSshStops) process.off(sig, stop);
      process.off('exit', updateSshExit);
    }
  });
}

/** Run `oak <body>` on a saved machine, the way forwardToMachine reaches it: herdr's ssh target, the
 *  shared MACHINE_PATH and ssh environment, never an interactive shell. Before the body runs, the
 *  remote is asked whether OAK is there and whether it speaks `update --here`, and a private stderr
 *  receipt separates its exit status from ssh's own 255. An OAK there from before level 2 installs the
 *  release with npm whatever it runs from: beside the copy `oak machine add` pushed, where nothing runs it,
 *  or over a CLI linked to a checkout. It is not run there at all. Never rejects. */
function sshUpdate(m: import('@oak-observatory/core').HerdrMachine, body: string, timeoutMs: number):
  Promise<{ state: 'ran' | 'no-oak' | 'old-oak' | 'linked' | 'provisioned' | 'unreachable' | 'timeout'; code: number | null; stdout: string; stderr: string; linked?: string }> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  const marker = 'OAK_EXIT_' + require('crypto').randomBytes(12).toString('hex') + ':';
  const script =
    `if ! command -v oak >/dev/null 2>&1; then printf '\\n${marker}missing\\n' >&2; exit 127; fi; ` +
    `level=$(oak __update-protocol --level 2>/dev/null); case "$level" in ''|*[!0-9]*) level=0 ;; esac; ` +
    // The launcher `oak machine add` writes is a script, where npm (a prefix of ~/.local) links its own.
    `if [ "$level" -lt 2 ] && [ "$(command -v oak)" = "$HOME/.local/bin/oak" ] && [ ! -L "$HOME/.local/bin/oak" ] && [ -f "$HOME/.local/lib/oak/index.js" ]; then printf '\\n${marker}bundle\\n' >&2; exit 78; fi; ` +
    `if [ "$level" -lt 1 ]; then printf '\\n${marker}old\\n' >&2; exit 78; fi; ` +
    `if [ "$level" -lt 2 ]; then g="$(npm exec --no-update-notifier --silent -c 'node -p process.env.npm_config_global_prefix' 2>/dev/null)/lib/node_modules/oak-observatory"; ` +
    `if [ -L "$g" ] && t=$(cd "$g" 2>/dev/null && pwd -P); then case "$t" in */packages/cli) [ -e "\${t%/packages/cli}/.git" ] && t="\${t%/packages/cli}" ;; esac; ` +
    `printf '\\n${marker}linked %s\\n' "$t" >&2; exit 78; fi; fi; ` +
    `${body}; oak_status=$?; printf '\\n${marker}%s\\n' "$oak_status" >&2; exit "$oak_status"`;
  const remote = `env PATH="${core.MACHINE_PATH}" CLAUDE_OBSERVATORY_NO_UPDATE_CHECK=1 sh -c ${quote(script)} oak`;
  return new Promise((resolve) => {
    let child: ReturnType<typeof core.spawnTool>;
    try {
      // In a session of its own (POSIX), as forwardToMachine's: a terminal's ctrl+c or hangup reaches this
      // process alone, whose handlers stop every ssh and end by the signal (stopWithUpdate).
      child = core.spawnTool('ssh', ['-T', ...SSH_OPTS, ...sshMux(m.target), m.target, remote], { stdio: ['ignore', 'pipe', 'pipe'], direct: true, env: core.machineSshEnv(), detached: process.platform !== 'win32', windowsHide: false });
    } catch (e) {
      resolve({ state: 'unreachable', code: null, stdout: '', stderr: String((e as Error)?.message || e) });
      return;
    }
    stopWithUpdate(child);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on('data', (d: Buffer) => out.push(d));
    child.stderr?.on('data', (d: Buffer) => err.push(d));
    let timedOut = false;
    // Settled by the deadline itself, not by 'close': a remote process that outlives the ssh client
    // keeps its pipes open, and waiting for them is the hang the deadline exists to end.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
      child.stdout?.destroy();
      child.stderr?.destroy();
      done(null);
    }, timeoutMs);
    let settled = false;
    const done = (code: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      let stderr = Buffer.concat(err).toString('utf8');
      if (error) return resolve({ state: 'unreachable', code, stdout, stderr: error.message });
      if (timedOut) return resolve({ state: 'timeout', code, stdout, stderr });
      const tail = stderr.match(new RegExp('\\n' + marker + '(missing|old|bundle|linked [^\\n]*|\\d+)\\n$'));
      if (tail) stderr = stderr.slice(0, -tail[0].length);
      if (tail?.[1] === 'missing') return resolve({ state: 'no-oak', code, stdout, stderr });
      if (tail?.[1] === 'old') return resolve({ state: 'old-oak', code, stdout, stderr });
      if (tail?.[1] === 'bundle') return resolve({ state: 'provisioned', code, stdout, stderr });
      if (tail?.[1].startsWith('linked ')) return resolve({ state: 'linked', code, stdout, stderr, linked: tail[1].slice('linked '.length) });
      // Without the receipt, 255 is ssh failing to connect, not the remote program's answer.
      if (!tail && code === 255) return resolve({ state: 'unreachable', code, stdout, stderr });
      resolve({ state: 'ran', code, stdout, stderr });
    };
    child.on('error', (e: Error) => done(null, e));
    child.on('close', (code: number | null) => done(code));
  });
}

/** One line naming what a machine's `update --here --json` plan would change. */
function machinePlanSummary(plan: any): string {
  const surfaces = (Array.isArray(plan?.surfaces) ? plan.surfaces : [])
    .filter((s: any) => !['current', 'managed', 'missing', 'linked', 'provisioned', 'local'].includes(s?.reason))
    .map((s: any) => `${s.label} ${s.from ?? '—'} → ${s.to}`);
  const components = (Array.isArray(plan?.components) ? plan.components : [])
    .filter((c: any) => c?.state === 'update' || c?.state === 'failed')
    .map((c: any) => `${c.label}: ${c.detail}`);
  return [...surfaces, ...components].join('; ');
}

/** Turn one ssh run into the machine's row. `applied` = the body ran an update, then printed the plan
 *  that is left afterwards. */
function machineRow(m: import('@oak-observatory/core').HerdrMachine, r: Awaited<ReturnType<typeof sshUpdate>>, applied: boolean, timeoutMs: number): MachineUpdate {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const row = (state: MachineState, detail: string, plan?: any): MachineUpdate => ({ label: m.label, target: m.target, state, detail, ...(plan ? { plan } : {}) });
  const reason = sshReason(r.stderr);
  switch (r.state) {
    case 'no-oak': return row('no-oak', `OAK is not installed there — \`oak machine add ${m.label} ${m.target}\` installs it`);
    case 'old-oak': return row('old-oak', `its OAK predates \`oak update --here\` — run \`oak update\` there once`);
    case 'linked': return row('linked', `its CLI is ${linkedText(r.linked ?? '')}; its OAK there predates leaving such a CLI alone, so nothing ran there`);
    case 'provisioned': return row('provisioned', `its OAK is a copy \`oak machine add\` pushed, from a release whose \`oak update\` installs a CLI that nothing there runs, so nothing ran there; \`oak machine add ${m.label} ${m.target}\` updates it`);
    case 'unreachable': return row('unreachable', `not reachable over ssh (${m.target})${reason ? `: ${reason}` : ''}`);
    case 'timeout': return row('timeout', `no answer within ${Math.round(timeoutMs / 1000)} s (OAK_MACHINE_TIMEOUT_MS)`);
  }
  let plan: any = null;
  try {
    plan = JSON.parse(r.stdout);
  } catch {
    /* judged below */
  }
  if (r.code !== 0) {
    // After an update its stderr is the whole run's log, so the plan it is left with names what failed;
    // without one, the log's own trouble lines do, or a crash's error line (core.failureLine).
    const left = applied && plan ? machinePlanSummary(plan) : '';
    if (left) return row('failed', `still to do: ${left}`, plan);
    return row('failed', core.failureLine(r.stderr) || (applied ? '' : core.failureLine(r.stdout)) || `exited ${r.code ?? '?'}`, plan ?? undefined);
  }
  if (!plan || typeof plan !== 'object') return row('failed', 'its `oak update --here --json` answer was not a plan');
  // What is left to the user there (a project's own settings, a CLI linked to a checkout or copied there by
  // `oak machine add`, a local build), on its row as this machine's table says it.
  const surfaces: any[] = Array.isArray(plan.surfaces) ? plan.surfaces : [];
  const yours = (Array.isArray(plan.components) ? plan.components : []).filter((c: any) => c?.state === 'manual').map((c: any) => `; ${c.detail}`).join('') +
    surfaces.filter((s) => s?.reason === 'linked').map((s) => `; ${s.label} ${linkedText(s.linked)}`).join('') +
    surfaces.filter((s) => s?.reason === 'provisioned').map((s) => `; ${s.label} ${provisionedText(m)}`).join('') +
    surfaces.filter((s) => s?.reason === 'local').map((s) => `; ${s.label} ${s.from} is ${LOCAL_BUILD_TEXT}`).join('');
  // The CLI the read after an update finds is the `oak` there: still behind, the update installed one that
  // `oak` does not run.
  const cli = surfaces.find((s) => s?.surface === 'cli' && !['current', 'managed', 'missing', 'linked', 'provisioned', 'local'].includes(s?.reason));
  if (applied && cli) return row('failed', `the update ran, but the CLI there still reports ${cli.from ?? '—'}; still to do: ${machinePlanSummary(plan)}${yours}`, plan);
  if (applied) return row('updated', (machinePlanSummary(plan) ? `updated; still to do: ${machinePlanSummary(plan)}` : `updated to ${plan.target}`) + yours, plan);
  return plan.upToDate ? row('current', `${plan.target}${yours}`, plan) : row('update', (machinePlanSummary(plan) || 'its plan has work') + yours, plan);
}

/** Every saved machine's plan, in parallel. Disabled machines are listed and skipped. A machine list
 *  herdr could not produce is one failed row, never a silent "no machines". Machines saved with the
 *  same ssh target (one per herdr session there) are one install: it is asked once, and its answer is
 *  each of their rows. */
async function planMachines(passArgs: string[]): Promise<{ machines: import('@oak-observatory/core').HerdrMachine[]; rows: MachineUpdate[] }> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const bin = core.findHerdrBin();
  if (!bin) return { machines: [], rows: [] }; // no herdr here, so no saved machines
  let machines: import('@oak-observatory/core').HerdrMachine[];
  try {
    machines = await core.herdrMachines({ binary: bin, timeoutMs: 15000 });
  } catch (e) {
    return { machines: [], rows: [{ label: '(saved machines)', target: '', state: 'failed', detail: `could not read herdr's machine list: ${String((e as Error)?.message || e)}` }] };
  }
  const timeout = machineTimeout(MACHINE_PLAN_TIMEOUT_MS);
  const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  const body = `oak update --here --json ${passArgs.map(quote).join(' ')}`;
  const asked = new Map<string, ReturnType<typeof sshUpdate>>();
  const rows = await Promise.all(machines.map(async (m) => {
    if (!m.enabled) return { label: m.label, target: m.target, state: 'disabled' as const, detail: 'disabled in herdr — skipped' };
    if (!m.target || m.target.startsWith('-')) return { label: m.label, target: m.target, state: 'failed' as const, detail: 'invalid ssh target' };
    if (!asked.has(m.target)) asked.set(m.target, sshUpdate(m, body, timeout));
    return machineRow(m, await asked.get(m.target)!, false, timeout);
  }));
  return { machines, rows };
}

function machineTimeout(fallback: number): number {
  const configured = Number(process.env.OAK_MACHINE_TIMEOUT_MS);
  return Number.isInteger(configured) && configured > 0 && configured <= 2147483647 ? configured : fallback;
}

/** Run the update on each machine whose plan has work (every reachable one under `--force`), in
 *  parallel, once per ssh target, as the plans were read. Its own output goes to its stderr, which is
 *  kept for a failure's reason; its stdout is the plan it is left with, read by a second, freshly
 *  started `oak` (the one the update installed). */
async function applyMachines(machines: import('@oak-observatory/core').HerdrMachine[], planned: MachineUpdate[], passArgs: string[], force: boolean): Promise<MachineUpdate[]> {
  const timeout = machineTimeout(MACHINE_APPLY_TIMEOUT_MS);
  const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  const a = passArgs.map(quote).join(' ');
  // The read afterwards takes the channel alone: under `--force` every surface reads as work left.
  const read = passArgs.filter((x) => x !== '--force').map(quote).join(' ');
  const body = `oak update --here ${a} >&2; s=$?; oak update --here --json ${read}; (exit "$s")`;
  const ran = new Map<string, ReturnType<typeof sshUpdate>>();
  return Promise.all(planned.map(async (row) => {
    const m = machines.find((x) => x.label === row.label && x.target === row.target);
    if (!m || !(row.state === 'update' || (force && row.state === 'current'))) return row;
    if (!ran.has(m.target)) ran.set(m.target, sshUpdate(m, body, timeout));
    return machineRow(m, await ran.get(m.target)!, true, timeout);
  }));
}

/** The one plan / one result table: a label column, then what is (or was) done. */
function printUpdateTable(title: string, rows: { label: string; text: string; tone: 'ok' | 'work' | 'dim' | 'bad' }[]): void {
  const w = Math.max(0, ...rows.map((r) => r.label.length));
  const paint = { ok: c.green, work: c.yellow, dim: c.dim, bad: c.red };
  process.stdout.write(c.bold(title) + '\n');
  for (const r of rows) process.stdout.write(`  ${r.label.padEnd(w)}  ${paint[r.tone](r.text)}\n`);
}

/** What a CLI linked to a checkout is, and the one thing that updates it. */
function linkedText(checkout: string | undefined): string {
  return `linked to the checkout at ${checkout}; update it there (git pull, then npm run build)`;
}

/** What a local build is (core.isLocalBuild), and what replaces it. */
const LOCAL_BUILD_TEXT = 'a local build, which no release carries: `oak update` leaves it alone, and `--force` or `--channel` replaces it';

/** What the copy `oak machine add` pushed is, and the one thing that updates it: run on the machine that
 *  added this one, which `m` names when this machine is the one asking. */
function provisionedText(m?: { label: string; target: string }): string {
  return m
    ? `copied there by \`oak machine add\`, which updates it: \`oak machine add ${m.label} ${m.target}\``
    : 'copied here by `oak machine add` from another machine; running it there again updates it';
}

/** A surface row of the plan, in words. `ahead` is its own sentence: reading "0.10.0 → 0.9.5" as an
 *  update is confusing; reading it as nothing at all is what stranded people for weeks. */
function surfacePlanText(s: UpdateAction, target: string): { text: string; tone: 'ok' | 'work' | 'dim' | 'bad' } {
  if (s.reason === 'current') return { text: `current (${s.from})`, tone: 'ok' };
  // `update` refreshes only what is ALREADY installed; a present-but-empty editor is not in its plan.
  if (s.reason === 'missing' && s.surface === 'vscode') return { text: 'not installed — `oak install-extensions` adds it', tone: 'dim' };
  if (s.reason === 'managed') return { text: `${s.from} · installed from a marketplace, which updates it (the editor's Extensions view)`, tone: 'dim' };
  if (s.reason === 'linked') return { text: `${s.from} · ${linkedText(s.linked)}`, tone: 'dim' };
  if (s.reason === 'provisioned') return { text: `${s.from} · ${provisionedText()}`, tone: 'dim' };
  if (s.reason === 'local') return { text: `${s.from} · ${LOCAL_BUILD_TEXT}`, tone: 'dim' };
  const how = s.reason === 'ahead' ? ' (not on this channel — will be replaced)' : '';
  const blocked = s.actionable ? '' : ` (no CLI found — ${noCliFix(s.ref as EditorRow)})`;
  return { text: `${s.from ?? '—'} → ${target}${how}${blocked}`, tone: s.actionable ? 'work' : 'bad' };
}

function componentText(cpt: UpdateComponent): { text: string; tone: 'ok' | 'work' | 'dim' | 'bad' } {
  switch (cpt.state) {
    case 'current': return { text: `current (${cpt.detail})`, tone: 'ok' };
    case 'update': return { text: cpt.detail, tone: 'work' };
    case 'absent': return { text: cpt.detail, tone: 'dim' };
    case 'after-cli': return { text: cpt.detail, tone: 'dim' };
    case 'updated': return { text: `updated — ${cpt.detail}`, tone: 'ok' };
    case 'failed': return { text: `failed — ${cpt.detail}`, tone: 'bad' };
    case 'manual': return { text: cpt.detail, tone: 'work' };
  }
}

function machineText(m: MachineUpdate): { text: string; tone: 'ok' | 'work' | 'dim' | 'bad' } {
  if (m.state === 'current') return { text: `current (${m.detail})`, tone: 'ok' };
  if (m.state === 'updated') return { text: m.detail, tone: 'ok' };
  if (m.state === 'update' || m.state === 'linked' || m.state === 'provisioned') return { text: m.detail, tone: 'work' };
  if (m.state === 'no-oak' || m.state === 'disabled') return { text: m.detail, tone: 'dim' };
  return { text: m.detail, tone: 'bad' };
}

/**
 * `update` — bring everything OAK installed up to the followed release channel: on this machine the CLI,
 * the editor extensions (every VS Code-family editor and Remote-SSH server, every JetBrains IDE), and
 * OAK's own setup (capture hooks, status line, herdr, focus server); then the same on every enabled saved
 * machine, each running its own `oak update --here` over ssh and downloading the release itself.
 *
 * `--here` stops at this machine; `--check` prints the plan; `--json` returns it, and changes nothing;
 * `--cli-only` is the CLI and its setup on this machine; `--force` reinstalls even if already current.
 */
async function cmdUpdate(args: string[]): Promise<void> {
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const current = version();
  const cliOnly = args.includes('--cli-only');
  const checkOnly = args.includes('--check');
  const force = args.includes('--force');
  const json = args.includes('--json');
  const here = cliOnly || args.includes('--here');
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
  // What every saved machine is asked to do: the same channel and the same --force.
  const passArgs = [...(requested ? ['--channel', requested] : []), ...(force ? ['--force'] : [])];

  const releases = await fetchReleases();
  // ONE decision for every surface, in core: a surface is acted on when its installed version
  // DIFFERS from the channel's newest — in either direction. `isNewer` could not express the
  // downgrade half of a channel switch, and it silently ignored anything sitting ABOVE the channel
  // line (a local build at 0.10.0 outranks every 0.10.0-dev.N the dev channel publishes).
  const surfaces = cliOnly ? installedSurfaces().filter((s) => s.surface === 'cli') : installedSurfaces();
  const plan = core.resolveUpdatePlan(releases, channel, surfaces, { switching, force, named: requested !== null });
  if (!plan.release) fail('no published release found for the repository.');
  const latest = plan.target;
  const assets: ReleaseAsset[] = (plan.release as any).assets || [];
  const cliSurface = plan.surfaces.find((s) => s.surface === 'cli');
  // A CLI linked to a checkout, copied here by `oak machine add`, or a local build left alone, is not replaced:
  // it stays, and owns the setup below.
  const cliStale = cliSurface !== undefined && !['current', 'linked', 'provisioned', 'local'].includes(cliSurface.reason);
  // OAK's own setup is judged by the CLI that will own it: this one when it is current, otherwise the
  // release it is about to install, which says what it did once it has run.
  const components: UpdateComponent[] = cliStale
    ? (await componentPlan()).map((cpt) => ({ ...cpt, state: 'after-cli', detail: 'checked by the new CLI once it is installed' }))
    : await componentPlan();
  const machinePlan = here ? null : await planMachines(passArgs);
  const machines = machinePlan?.rows ?? [];
  // A row left to the user (`manual`) is not work this command can do, so it never holds the plan open.
  const settled = (cpt: UpdateComponent) => cpt.state === 'current' || cpt.state === 'absent' || cpt.state === 'manual';
  // An editor without our extension is in the plan's actions (install-extensions acts on those), but
  // `update` never installs into one, so it is not work left undone here.
  const hereUpToDate = plan.actions.every((s) => s.surface === 'vscode' && s.reason === 'missing') && components.every(settled);
  const machinesUpToDate = machines.every((m) => m.state === 'current' || m.state === 'no-oak' || m.state === 'disabled');

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
        // Which IDE a JetBrains row is: its plugins folder, so an IDE marks only its own row.
        ...(s.surface === 'jetbrains' && typeof s.ref === 'string' ? { pluginsDir: s.ref } : {}),
        // Which editor a VS Code-family row is: its extensions folder, so a window tells its own row apart.
        ...(s.surface === 'vscode' && s.ref ? { extensionsDir: require('path').join(require('os').homedir(), (s.ref as EditorRow).extDirs[0]) } : {}),
        ...(s.linked ? { linked: s.linked } : {}),
      })),
      components,
      // Absent under --here: this machine only, and the shape a saved machine answers with.
      ...(here ? {} : { machines }),
      upToDate: hereUpToDate && machinesUpToDate,
    });
    return;
  }

  if (plan.degradedToStable)
    process.stdout.write(c.dim(releases.some((r: any) => r?.prerelease === true && !r?.draft)
      ? 'the stable release outranks the newest pre-release, so the pre-release channel serves it.\n'
      : 'no pre-release published yet — the stable release is the newest there is.\n'));
  // A PREVIEW is honest about being one: `--check --channel dev` shows what the switch WOULD do — it
  // never persists, and the closing hint names the command that actually applies it.
  process.stdout.write(
    c.dim(
      checkOnly && switching
        ? `channel: ${CHANNEL_LABEL[channel]} → ${latest} (previewing — you follow ${CHANNEL_LABEL[core.getUpdateChannel()]}; nothing switched)\n`
        : `channel: ${CHANNEL_LABEL[channel]} → ${latest}\n`
    )
  );
  const planRows = [
    ...plan.surfaces.map((s) => ({ label: s.label, ...surfacePlanText(s, latest) })),
    ...components.map((cpt) => ({ label: cpt.label, ...componentText(cpt) })),
    ...machines.map((m) => ({ label: `machine ${m.label}`, ...machineText(m) })),
  ];
  printUpdateTable('Plan', planRows);
  if (!cliOnly) {
    if (!plan.surfaces.some((s) => s.surface === 'vscode')) process.stdout.write(c.dim('  VS Code: extension not detected\n'));
    if (!plan.surfaces.some((s) => s.surface === 'jetbrains')) process.stdout.write(c.dim('  JetBrains: plugin not detected\n'));
  }

  if (checkOnly) {
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

  const results = new Map<UpdateAction, RowResult>();
  if (cliStale) await updateCliBinary(assets, latest, current);
  if (!cliOnly) {
    await refreshVscodeExtension(assets, plan, results);
    await refreshJetbrainsPlugin(assets, plan, results);
  }
  // Persist the switch AFTER the installs, not before. Doing it first meant a blocked install left
  // the config naming one channel while the binaries came from the other — the split-brain the
  // channel file is supposed to make impossible — and the failure toast made it look like nothing
  // had happened at all.
  persistChannel(requested);
  let componentResults: UpdateComponent[];
  if (cliStale) {
    const finished = finishInInstalledCli();
    // A setup step that failed, or that could not be found to run, may have set up nothing.
    if (!finished.ok)
      componentResults = [...(finished.rows ?? []), { id: 'setup', label: 'OAK setup', state: 'failed', detail: 'the installed CLI’s setup step failed — run `oak doctor --fix`' }];
    else if (finished.rows) componentResults = finished.rows;
    else {
      // A release older than the per-component report set itself up without saying how.
      refreshInstalledStatusline();
      componentResults = [{ id: 'setup', label: 'OAK setup', state: 'after-cli', detail: 'set up by the installed CLI, which reports no detail — `oak doctor` checks it' }];
    }
  } else componentResults = await applyComponents(components);
  const machineResults = machinePlan ? await applyMachines(machinePlan.machines, machines, passArgs, force) : [];

  const resultRows = [
    ...plan.surfaces.map((s) => {
      if (s.surface === 'cli' && cliStale) return { label: s.label, text: `updated — ${s.from} → ${latest}`, tone: 'ok' as const };
      const r = results.get(s);
      if (r) return { label: s.label, text: `${r.state} — ${r.detail}`, tone: r.state === 'updated' ? ('ok' as const) : ('bad' as const) };
      return { label: s.label, ...surfacePlanText(s, latest) };
    }),
    ...componentResults.map((cpt) => ({ label: cpt.label, ...componentText(cpt) })),
    ...machineResults.map((m) => ({ label: `machine ${m.label}`, ...machineText(m) })),
  ];
  printUpdateTable('Result', resultRows);

  // Each with its reason: the editors show stderr alone, so a name with no reason left the person a
  // table they never see.
  const failed = [
    ...plan.surfaces.filter((s) => results.get(s)?.state === 'failed').map((s) => `${s.label} (${results.get(s)?.detail})`),
    ...componentResults.filter((cpt) => cpt.state === 'failed').map((cpt) => `${cpt.label} (${cpt.detail})`),
    ...machineResults.filter((m) => MACHINE_FAILED.has(m.state)).map((m) => `machine ${m.label} (${m.detail})`),
  ];
  if (failed.length) {
    // Something is installed but couldn't be updated — never let this pass as success/silence.
    // On STDERR, not stdout: this is the failure reason, and an editor surfacing this run reads
    // stderr first. Reported as #45, where the only thing on stderr was a Node deprecation warning,
    // so the toast showed the warning and the person never saw this line at all.
    process.stderr.write(c.yellow('⚠ ') + `could not update ${failed.join('; ')} — see the table above.\n`);
    process.exitCode = 1;
    return;
  }
  const changed = cliStale || results.size > 0 || componentResults.some((cpt) => cpt.state === 'updated') || machineResults.some((m) => m.state === 'updated');
  // A repair left to the user, here or on a saved machine (whose row names it), is not "up to date", and
  // neither is a CLI linked to a checkout or copied by `oak machine add`, which is updated elsewhere, or a
  // local build, which no release carries.
  const elsewhere = (reason: unknown) => reason === 'linked' || reason === 'provisioned' || reason === 'local';
  const yours = componentResults.some((cpt) => cpt.state === 'manual') || plan.surfaces.some((s) => elsewhere(s.reason)) ||
    machineResults.some((m) => elsewhere(m.state) ||
      (Array.isArray(m.plan?.components) ? m.plan.components : []).some((cpt: any) => cpt?.state === 'manual') ||
      (Array.isArray(m.plan?.surfaces) ? m.plan.surfaces : []).some((s: any) => elsewhere(s?.reason)));
  if (!changed && !yours)
    process.stdout.write(c.green('✓ ') + `everything is up to date (${latest}${channel === 'dev' ? ', pre-release channel' : ''})\n`);
  if (!plan.surfaces.some((s) => s.surface !== 'cli') && !cliOnly)
    process.stdout.write(c.dim('  install the VS Code / JetBrains extensions with `oak install-extensions`.\n'));
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
      // `linked`: this CLI runs from a checkout; `provisioned`: it is the copy `oak machine add` pushed.
      // `oak update` leaves both alone. Asked without npm, so the chip paints at once; `--check` also
      // asks npm whether its global package is a link.
      const checkout = machineBundle() ? null : runningCheckout();
      emitJson({ current: cur, channel: core.getUpdateChannel(), ...(checkout ? { linked: checkout } : {}), ...(machineBundle() ? { provisioned: true } : {}) });
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
  // A CLI linked to a checkout, or copied here by `oak machine add`, is not on any channel: a release is no
  // update for it, since `oak update` leaves it alone and it is updated where it came from. Nor is a local
  // build (a version no release carries), which `oak update` leaves alone unless asked by name.
  const provisioned = machineBundle();
  const linked = provisioned ? null : linkedCli();
  const cmp = core.compareVersions(latest, cur);
  const local = cmp !== 0 && !linked && !provisioned && core.isLocalBuild(cur);
  const differs = cmp !== 0 && !linked && !provisioned && !local;
  const stranded = cmp < 0 && !linked && !provisioned && !local;
  if (json) {
    // The editors' version dropdown: one call answers the chip, the Update row, and both channel rows.
    // `--compare <version>` also places a build this CLI is not (JetBrains passes its own plugin's), in
    // the same words VS Code's menu uses, so both editors compare every surface with core's one rule.
    const other = flagValue(args, '--compare');
    if (args.some((a) => a === '--compare' || a.startsWith('--compare=')) && !other) fail('`--compare` requires a version');
    emitJson({
      current: cur, channel, latest, updateAvailable: differs, stranded, stableLatest, devLatest,
      ...(linked ? { linked } : {}),
      ...(provisioned ? { provisioned } : {}),
      ...(local ? { local } : {}),
      ...(other ? { compared: { version: other, reason: core.channelReason(latest, other) } } : {}),
    });
    return;
  }
  process.stdout.write(
    `installed   ${c.bold(cur)}   ${c.dim(`(${CHANNEL_LABEL[channel]} channel)`)}\n` +
      `latest      ${c.bold(latest)}${linked || provisioned || local ? '' : `   ${differs ? c.yellow(stranded ? '← not on this channel' : '← update available') : c.green('✓ up to date')}`}\n` +
      (channel === 'stable' && devLatest ? c.dim(`pre-release ${devLatest}   (switch: \`update --channel dev\`)\n`) : '')
  );
  if (linked || provisioned) {
    process.stdout.write(c.dim(`this CLI is ${linked ? linkedText(linked) : provisionedText()}; \`oak update\` leaves it alone.\n`));
  } else if (local) {
    process.stdout.write(c.dim(`this CLI is ${LOCAL_BUILD_TEXT}.\n`));
  } else if (stranded) {
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
    `oak — per-edit Keep/Undo for Claude Code and Codex\n\n` +
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
      `                       only this repo's file; --all also reverts the bundled status line, a\n` +
      `                       setup for the user that --project leaves, + prints teardown steps;\n` +
      `                       --all --purge-store also deletes the stored edits and forgets their\n` +
      `                       sessions in the local database and the record log)\n` +
      `  status               show hooks + hook-path health + session + edit counts\n` +
      `  integrity [--session <id>] [--json]  inspect capture gaps and unsafe history; read-only\n` +
      `  doctor [--json] [--fix]\n` +
      `                       diagnose setup (hooks, PATH, the \`oak\` a login shell runs, config dir,\n` +
      `                       session, status line, herdr, the herdr server's environment) with fixes;\n` +
      `                       --markdown (--md) emits the report as Markdown; --fix installs the pinned\n` +
      `                       herdr, its claude + codex integrations and OAK's plugin, sets missing\n` +
      `                       sidebar widths and theme defaults (gruvbox), starts its server, repairs\n` +
      `                       PTY helper permissions and stops outdated focus servers; reports slow SSH\n` +
      `                       forwarding for saved machines, and why one gave no Claude usage reading\n` +
      `  models [use <name>]\n` +
      `                       local models: list what ollama serves here and which one codex runs\n` +
      `                       (a fresh \`ollama pull\` appears with nothing to reinstall — capture is\n` +
      `                       model-independent); \`use\` pulls it if missing, wires codex to it\n` +
      `                       (surgical config edit + .bak), and verifies with one live turn\n` +
      `  install-extensions [--check] [--json] [--force] [--channel stable|dev]\n` +
      `                       install the editor extensions into whatever editors are on this machine\n` +
      `                       (VS Code family + JetBrains); --vsix/--jetbrains-zip use local build\n` +
      `                       outputs instead of the release; --check reports without installing\n` +
      `  update [--here] [--check] [--json] [--cli-only] [--force] [--channel stable|dev]\n` +
      `                       update everything OAK installed from the followed release channel: the\n` +
      `                       CLI; the extension in each VS Code-family editor and Remote-SSH server\n` +
      `                       that has it; the plugin in each JetBrains IDE that has it; the capture\n` +
      `                       hooks in your user settings (repaired as \`init --repair\` does; a project's\n` +
      `                       own .claude/settings.json is never written, and gets a row naming the\n` +
      `                       \`oak init --repair\` to run there); the bundled status line when it is\n` +
      `                       ours; herdr, its integrations and plugin (as \`doctor --fix\` does); and\n` +
      `                       an outdated focus server, which it stops. Then each enabled saved machine\n` +
      `                       runs its own \`oak update --here\` over ssh, in parallel. One plan, one\n` +
      `                       result table; what is current is left alone; exit 1 when anything,\n` +
      `                       on any machine, could not be updated. A surface is updated whenever it\n` +
      `                       DIFFERS from the channel's newest — including builds newer than it,\n` +
      `                       which is what makes switching channels work in both directions. --here\n` +
      `                       updates this machine only; --check reports only; --json reports the\n` +
      `                       plan as JSON and changes nothing; --cli-only is the CLI and its setup\n` +
      `                       here, without the extensions; --force reinstalls even if already\n` +
      `                       current (never over a marketplace install). A CLI linked to a source\n` +
      `                       checkout is never replaced: git pull and npm run build there update it;\n` +
      `                       nor is the copy \`oak machine add\` pushed, which running that again updates.\n` +
      `                       A local build (a version ending in -dev.0, which no release carries) is\n` +
      `                       left alone unless --force or --channel asks for the channel's build.\n` +
      `                       --channel switches between stable and the rolling pre-release (dev) and\n` +
      `                       installs that channel's newest in the same run, on every machine\n` +
      `  sessions [--all] [--synced] [--delete <id> [--force | --force-pending <n>] [--seen-through <edit>] | --undelete <id>]\n` +
      `                       this machine's sessions, grouped by workspace (● = this directory's), without\n` +
      `                       those in which nothing happened (no edit, no tokens, no reply) unless still running,\n` +
      `                       and without Codex's Auto-review threads unless --all or --session names one;\n` +
      `                       --synced adds every other machine's sessions the local database holds from its\n` +
      `                       records, by machine, with when oak sync last brought them (--json: machines[]);\n` +
      `                       --json --machine <label|id> lists one machine's own captured sessions: from the\n` +
      `                       local database when oak sync read that label in the last ten minutes and nothing there\n` +
      `                       may be running (no session active in two hours, as its records and that run's view\n` +
      `                       of its files say; no hand raised in the last day still up) (fromIndex, syncedAt,\n` +
      `                       publishedAt), else over SSH;\n` +
      `                       delete hides a session and purges stored edits (pending ones only with --force,\n` +
      `                       or with --force-pending <n> while no more than n are pending); --seen-through\n` +
      `                       <edit> also refuses while an edit newer than that id is pending;\n` +
      `                       undelete restores visibility; a backup folder can restore its saved edits on the next sync\n` +
      `  prompt --session <id> --text "…" [--machine <label>] [--json]  explicitly submit to its live pane;\n` +
      `                       without a live pane, retain the clipboard draft and print it, and exit 75\n` +
      `  comment add|list|rm|compose|send|mark-sent --session <id>  add --edit <n> [--line <n>] --text "…";\n` +
      `                       compose prints an unsent draft; send submits it and marks only acknowledged\n` +
      `                       comments sent (a draft it could not send exits 75); mark-sent --ids <a,b> records\n` +
      `                       a reply delivered another way.\n` +
      `                       --json reports the result; --text=--note preserves text beginning with dashes\n` +
      `  quote --session <id> [--text "note"] [--send] [--json]  quote the latest transcript reply;\n` +
      `                       default is a draft; --send explicitly submits it through herdr (75: kept as a draft)\n` +
      `  focus --session <id> --tab observatory|review|herdr  select a conversation in an attached OAK TUI\n` +
      `                       --pane <id> resolves a live herdr pane to its session\n` +
      `  server start|stop|status [--json]  local focus endpoint; herdr owns terminals and agents\n` +
      `  inbox [--json]       every session waiting on you, most urgent first — permission prompts, questions\n` +
      `                       (with their options), input waits, then finished turns; --next [--after <id>]\n` +
      `                       names the one to jump to. On both OAK tabs, i opens the inbox and h jumps to the\n` +
      `                       next session waiting on you; the inbox lists oak sync's open conflicts too, on every surface,\n` +
      `                       and the other machines' raised hands as their records brought them, each on its machine\n` +
      `                       (--json adds its machine's id and label, syncedAt and publishedAt); --next skips them\n` +
      `  search <words…>      every conversation on this machine, ranked: the asks you typed and the prose that\n` +
      `                       answered them, across sessions and workspaces (every word must appear; a hit in\n` +
      `                       the ask outranks one in the answer); --days <N>, --limit <N>, --json;\n` +
      `                       --per-session keeps each session's best hit, before the limit;\n` +
      `                       --machine <label> searches a saved machine's conversations: in its records here\n` +
      `                       when oak sync read it in the last ten minutes, there over SSH otherwise\n` +
      `  query <name> [--<param> <value>…] [--archived|--all] [--arrays|--table]\n` +
      `                       the local database in JSON: sessions, edits, files, prompts, search (asks and answers,\n` +
      `                       ranked; an ask outranks its answer), workers, delegated, findings, sync, notes (plans,\n` +
      `                       memories, skills), usage (tokens in a window by machine, model, session, day, agent or\n` +
      `                       account, each message once), readings (the shares each machine read, and the account's\n` +
      `                       answers on its five-hour limit) or schema; sessions lists every machine's the database holds;\n` +
      `                       the rows of sessions, edits, prompts, search, workers and notes name their machine by\n` +
      `                       id (machine, which a query's --machine takes, as it takes self and the label a saved\n` +
      `                       machine has here; any other name is refused) and by this machine's\n` +
      `                       name for it (machine_label: for a saved machine, the label the other verbs' --machine\n` +
      `                       takes); files are one row per path within a repository, every clone together;\n` +
      `                       edits --path takes that path (with --project), or an absolute path in this machine's clone;\n` +
      `                       sessions whose files are gone are archived and listed only with --archived or --all;\n` +
      `                       exit 2 = the query cannot run, 3 = no database here\n` +
      `  query sql "<SELECT…>" [--param <v>…] [--limit <N>] [--timeout <ms>]\n` +
      `                       one read-only statement, in a child process stopped at its deadline (exit 124);\n` +
      `                       \`query --serve\` answers one JSON request per line; \`query --status\` describes the database\n` +
      `  notify               desktop notifications for raised hands: --message <text> [--title <t>] [--sound]\n` +
      `                       pops one; --watch [--interval <s>] announces every hand raised on this machine\n` +
      `                       (from a plain terminal with no editor open), and every hand the other machines'\n` +
      `                       records bring, naming the machine; the editors announce in-process; each hand once\n` +
      `                       per machine\n` +
      `  agent setup [--yes|--check] [--json] [--project] [--remove]\n` +
      `  agent start --kind claude|codex [--cwd <dir>] [--machine <label>]  spin an agent up (add --machine to run it on a remote and attach)\n` +
      `  agent start --kind claude|codex --brief <file> [--name <id>] [--cwd <tree>] [--out <dir>] [--report <file>]\n` +
      `              [--agent <type>] [--permission-mode <mode>] [--model <m>] [--effort <e>] [--sandbox <s>] [--machine <label>] [--worktree [<base>]] [--writable-root <dir> …]\n` +
      `                       start an agent from a brief in its own herdr tab, labelled from the brief's # Title, here or on a\n` +
      `                       saved machine (its paths are that machine's); defaults from prefs.json "agents"; the report it is\n` +
      `                       told to write is <out>/report.md (out: <id>-out beside the tree)\n` +
      `  agent start … --after <id…> [--after-any]  record as queued; start after every dependency is done (after-any accepts gone)\n` +
      `  agent tell <id…> <text> [--file <path>] [--json]  send follow-up scope to each running agent, on its machine\n` +
      `  agent list [--all] [--json]  every agent started from a brief: OAK's own state (queued, starting, working, waiting, blocked,\n` +
      `                       errored, done, gone) and since when, kind, model and effort, machine, tab, tokens and cost, workers\n` +
      `  agent wait <id…> [--until done|blocked|any] [--timeout <s>] [--json]  return once reached (done: every agent done or\n` +
      `                       gone, exit 1 if one is gone; blocked: one blocked or errored; any: one no longer working); 124 at the timeout\n` +
      `  agent close <id…> [--remove-worktree] [--json]  close each agent's herdr tab, on its machine; its row stays (agent list --all)\n` +
      `  finding add "<text>" [--path <file>…] [--repo] [--session <id>]  post an untrusted fact\n` +
      `  finding list [--repo [<key>]] [--path <file>] [--session <id>] [--machine <id>] [--all] [--json]\n` +
      `  finding resolve <id> [--session <id>]  retire a finding through the record log\n` +
      `  attach [machine]          attach this terminal to herdr here, or on a saved machine over SSH (tmux-style)\n` +
      `  machine add <label> <ssh-target> | machine list [--json]\n` +
      `                       the machines herdr runs agents on: add installs the version pinned in herdr.lock\n` +
      `                       over ssh (checksum-verified) and saves it non-interactively; a newer local herdr is left alone.\n` +
      `                       list is herdr's own machine list\n` +
      `  sync now [--machine <label>]… [--json] [--quiet]\n` +
      `                       pull from each enabled saved machine what this machine keeps: memory, plans, skills,\n` +
      `                       agents and commands on every machine (merged three ways; changes to the same lines\n` +
      `                       keep both copies as a conflict), OAK's edit log, comments and agent record of each\n` +
      `                       session and each machine's record log (what its local database derives of its sessions) on\n` +
      `                       every machine too, and Claude Code and Codex sessions and OAK's snapshots on the machine\n` +
      `                       that made them and the backup (the others keep their inventories and fetch on demand).\n` +
      `                       It writes only this machine, and its own files, encrypted, in a backup folder when one is\n` +
      `                       set; a machine whose user name is not this machine's refuses and lists nothing. Once it\n` +
      `                       has run with a saved machine to sync with, or a backup folder, the capture hooks and the\n` +
      `                       pollers start it in the background at most every 5 minutes, and less often after a run that\n` +
      `                       stopped with an error. Each machine asked catches its local database up first (up to 5 s;\n` +
      `                       the rest in the background, for a later run), so its record log holds what it has done.\n` +
      `                       Exits 1 when every machine it asked failed and nothing was pulled\n` +
      `  sync plan [--machine <label>]… [--json]\n` +
      `                       preview what \`sync now\` would do on this machine and on each saved machine;\n` +
      `                       copies and changes nothing anywhere\n` +
      `  sync status [--root <folder>] [--json]\n` +
      `                       the last run per machine, open conflicts, the inventories of other machines' files and\n` +
      `                       the on-demand copies, from this machine alone; --json also names the project in --root\n` +
      `                       (this folder by default) as \`sync exclude\` keys it, and whether it is excluded here\n` +
      `  sync fetch <session> [--json]\n` +
      `                       bring one session here from the machine that made it, else the backup (an evictable copy)\n` +
      `  sync resolve <conflict> [--json]\n` +
      `                       keep this machine's file: delete the other machine's copy (to sync's trash) and close\n` +
      `                       the conflict now; \`sync status --json\` and \`inbox --json\` list each conflict's id\n` +
      `  sync include|exclude <machine|project>\n` +
      `                       sync with a saved machine, or a project (an identity key or a folder here), again or no more\n` +
      `  sync backup [<label> | --folder <path> | --none]\n` +
      `                       where every machine's sessions are kept besides the machine that made them: a saved\n` +
      `                       machine, or a folder (a share, a NAS, a disk; its path on this machine), encrypted on this\n` +
      `                       machine with a key the folder never holds\n` +
      `  sync setup [--none | --machine <label> | --folder <path>] [--key-from <machine> | --import-key] [--replace]\n` +
      `             [--restore]\n` +
      `                       choose the backup, make or bring the folder's key, and preview a first run; it asks on\n` +
      `                       a terminal. --restore takes over the folder's record under this machine's name (this\n` +
      `                       machine is a reinstall of the one that wrote it), and the next run restores from it\n` +
      `  sync key [--show | --import | --from <machine>] [--replace]\n` +
      `                       the backup folder's key here: its fingerprint; --show prints it, for a password\n` +
      `                       manager; --import takes one from standard input, or asks for it on a terminal (never\n` +
      `                       as an argument); --from copies one over ssh\n` +
      `  sync family <family> <everywhere|backup|on-demand|off>\n` +
      `                       where one family's files are kept on this machine\n` +
      `  <verb> … --machine <label>\n` +
      `                       fleet, views, review, list, sessions, prompts, conversation, feed, processes, multitask, subagents, diff,\n` +
      `                       keep, undo, redo, resolve, clean, task-keep, task-undo, task-clear, chat-context, comment, quote, ignore, search,\n` +
      `                       editor-review, locate and install-extensions run on that saved\n` +
      `                       machine over ssh.\n` +
      `                       Its own oak answers (from ~/.local/bin, /opt/homebrew/bin or\n` +
      `                       /usr/local/bin), in the session's own workspace there, with output and exit\n` +
      `                       status passed back unchanged (output is filtered when printed to a terminal).\n` +
      `                       Review (its session picker lists every saved machine's sessions; --session\n` +
      `                       and --once too) and Observatory read sessions on their owning machine.\n` +
      `                       OAK_MACHINE_TIMEOUT_MS overrides the 120-second command deadline; unit and\n` +
      `                       mark-sent operations, ignore --dry-run and conversations require a compatible\n` +
      `                       remote build.\n` +
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
      `  processes --follow <id> [--session <id>] [--machine <label>] [--json]  live plain-text output (JSON snapshots).\n` +
      `  prompts [--json]     the session as the list of things YOU asked for, each with the edits,\n` +
      `                       files, folders, tokens, agents, workflows, tasks and shells it produced;\n` +
      `                       --id <n> drills into one; --id <n> --response prints Claude’s reply to it\n` +
      `  review [--prompt <n>] the session's work as review units, each with its net patch — repeated\n` +
      `                       edits to the same code read as one change; --prompt <id|index> scopes to\n` +
      `                       one ask; --pending hides resolved units; --no-patch for metadata only\n` +
      `  feed [--json]        what ONE thing is doing now — a tail of its activity;\n` +
      `                       --kind session|agent|workflow|task|process --id <id> [--limit <n>]\n` +
      `                       --kind agent --id <worker> [--session <id>] --follow watches its live log;\n` +
      `                       --machine <label> reads it over ssh every 10 s; ends at recorded completion.\n` +
      `                       --json --follow prints one snapshot per line, with endedTs in milliseconds.\n` +
      `  subagents [--json]   every subagent this session spawned, each with its own action timeline + metrics (alias: agents)\n` +
      `  fleet [--json] [--machine LABEL]  named workers on this machine, including herdr and worktrees\n` +
      `  siblings [--json]    the other Claude Code sessions in THIS project (active/idle · pending · files · risk);\n` +
      `                       agent-facing digest for cross-agent awareness; --all includes self;\n` +
      `                       --repo widens to every WORKTREE of the repo (adds worktree/branch/phase + conflicts),\n` +
      `                       and lists the other machines' sessions of the repo from the local database, read-only\n` +
      `                       (--json: machines)\n` +
      `  multitask                the multi-agent view: one row per running agent across every worktree (live phase,\n` +
      `                       sparkline, ±lines, risk) + nested subagents (phase/current task) + live file conflicts\n` +
      `  tasklog                    cross-agent task log: one row per stable taskId, unioned across worktrees + subagents\n` +
      `  metrics [--json]     session numbers: ±lines, action/error counts, subagent duration/tokens, tool latency\n` +
      `  diff <id> [--json]   show before/after; JSON carries session, id, file and patch\n` +
      `  diff --ids <id,id,…> --json [--contents] [--preview-lines 50]  one page of at most ten edits; 0 shows full contents\n` +
      `  diff --pending --json [--prompt <id>] [--offset N]  pending scope ids and one preview page\n` +
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
      `  ignore --dry-run [--json]   how many recorded edits the ignore sweep would drop, dropping none\n` +
      `  ignore --check <p>... [-v] [-n] [-z] [-q] [--stdin] [--json]   why each path is shown / hidden /\n` +
      `                       refused — names the rule, its file and its line (and the excluded ancestor,\n` +
      `                       when that is what decided). Takes git check-ignore's flags and its exit\n` +
      `                       codes: 0 when a path is ignored, 1 when none are; -v prints git's\n` +
      `                       <source>:<line>:<pattern><TAB><path> machine format\n` +
      `  tui [--session <id>] [--root <d>] [--tick <s>] [--once] [--no-color] [--no-mouse]\n` +
      `       [--cols N] [--rows N]\n` +
      `                       herdr · Observatory · Review; --tab herdr|observatory|review selects a tab\n` +
      `                       Observatory: arrows preview (Review follows), Enter pins, c replies,\n` +
      `                       t focuses herdr, R resolves and X stops (both ask first), B includes\n` +
      `                       archived sessions.\n` +
      `                       Review: a keep, u undo, U redo, A keep all, D undo all.\n` +
      `                       : opens the palette: every command, and find anything.\n` +
      `                       Tab / shift+Tab switch OAK tabs. herdr's tab bar starts agents; on the\n` +
      `                       herdr tab, herdr's prefix (ctrl+b unless its config sets another) then m\n` +
      `                       returns to OAK and M pins herdr's focused session in the Observatory.\n` +
      `                       Ctrl+q twice quits OAK on every tab (repeat within two seconds); when\n` +
      `                       herdr's prefix is ctrl+q, the herdr tab passes it to herdr and OAK quits\n` +
      `                       from its own tabs.\n` +
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
      `                       stats and actions are accepted by name too, though nothing batches them by\n` +
      `                       default.\n` +
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
      `                       figures to your bill cycle, --gpt-bill-day N does the same for GPT (0 clears).\n` +
      `                       A Claude window with no current share here shows a saved machine's reading\n` +
      `                       of the same account, named (with no Claude Code login here, of the one account\n` +
      `                       the saved machines name; "machineUsage": false in prefs.json turns that off);\n` +
      `                       --window 5h|week|bill|month|day|all [--by machine|model|session|day|agent|account]\n` +
      `                       [--agent claude|codex] [--json] breaks a window down from the local database, each\n` +
      `                       message once across the machines whose usage it holds, as the token and dollar\n` +
      `                       estimates count it; --brief prints the shares and the usage this machine measured\n` +
      `                       itself, as an earlier pre-release reads them from a machine that saved this one\n` +
      `  titles [--json] [--refresh] [--off | --on]\n` +
      `                       Remote Control titles read from claude.ai, so sessions carry the names the\n` +
      `                       Claude app shows: the last refresh and what it cached; --refresh reads now;\n` +
      `                       --off stops the reads and drops the cache, --on resumes them\n\n` +
      `opt-in, token-spending (runs \`claude -p\`; returns the cached result unless --fresh):\n` +
      `  analyze <id>         deep-analyze one edit    [--json --fresh --claude-bin <path>]\n` +
      `  recap                one-line session recap   [--json --fresh --claude-bin <path>]\n` +
      `  suggest              next-steps + suggestions [--json --fresh --claude-bin <path>]\n\n` +
      `  --session <id>       target a specific session instead of the newest\n` +
      `  version [--check] [--json] [--compare <version>]\n` +
      `                       print the installed version (--json adds the channel); --check (or --latest)\n` +
      `                       also shows the newest release of BOTH channels (--json feeds the editors' chip);\n` +
      `                       --compare with --check --json also says how <version> stands against the channel\n` +
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
  // A checkout's build never matches a release, and `oak update` leaves it alone, as it leaves the copy
  // `oak machine add` pushed: a nudge to run it on every command is noise, and before the update left a
  // link alone it was the prompt that replaced one.
  if (runningCheckout() || machineBundle()) return;
  const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
  const cur = version();
  // Nor is a local build, which no release carries and `oak update` leaves alone unless asked by name.
  if (core.isLocalBuild(cur)) return;
  const cache = readUpdateCache();
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
  if ((!cache || Date.now() - cache.checkedMs > DAY) && !core.noBackgroundChildren()) {
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

/** Say once, after the command's own output, that oak sync's settings were put back in prefs.json from its copy (core
 *  keptPrefs, run by whichever process read them first): an OAK older than 0.11.0 rewrote the file. Only to a person at a
 *  terminal: a hook, the status line or an editor's call would take the one telling where nobody reads it. `oak doctor`
 *  says it on every surface, and the terminal app on its own status line. */
function sayKeptPrefsAtExit(cmd: string): void {
  if (!process.stderr.isTTY || cmd === 'capture' || cmd === 'tui' || cmd.startsWith('__') || ['version', '--version', '-v', 'help', '--help', '-h'].includes(cmd)) return;
  process.on('exit', () => {
    try {
      const text = (require('@oak-observatory/core') as typeof import('@oak-observatory/core')).takeKeptPrefsNotice();
      if (text) process.stderr.write(c.yellow('\n⚠ ') + text + '. Quit or update that OAK: `oak doctor` says where it may be running.\n');
    } catch {
      /* a notice never fails a command */
    }
  });
}

/** Every verb the dispatch below answers to, and the flags that take a VALUE — both used only
 *  to tell a swallowed command apart from a flag's argument at the front door. Derived from
 *  the same switch that runs them, so the two cannot drift. */
const KNOWN_VERBS = new Set([
  'actions', 'agent', 'agents', 'analyze', 'assign', 'attach', 'blob', 'capabilities', 'capture', 'changemap', 'chat-context', 'clean', 'comment', 'conversation', 'quote', 'demo', 'diff', 'doctor', 'editor-review', 'egress', 'export', 'feed', 'fleet', 'footprint', 'focus', 'help', 'ignore', 'inbox', 'init', 'integrity', 'insights', 'install-extensions', 'keep', 'list', 'locate', 'machine', 'metrics', 'models', 'multitask', 'notify', 'observations', 'observe', 'oplog', 'processes', 'prompt', 'prompts', 'query', 'recap', 'review', 'store', 'redo', 'resolve', 'risk', 'search', 'server', 'sessions', 'siblings', 'stats', 'status', 'statusline', 'subagents', 'sync', 'tui', 'suggest', 'summary', 'task-clear', 'task-keep', 'task-undo', 'tasklog', 'timeline', 'titles', 'trace', 'tree', 'undo', 'uninstall', 'update', 'usage', 'version', 'views', 'warm',
]);
// NOTE: this is the SECOND list of value-taking flags in this file (see `VALUE_FLAGS` above). They
// serve different parsers — that one strips flag/value pairs, this one decides whether a bare token
// is a verb — and a flag missing from EITHER fails in its own way. `--tab review` needs both: the
// first so the pair is consumed, this one so `review` is not mistaken for the review command.
const FLAGS_WITH_VALUES = new Set(['--offset', '--preview-lines', '--files', '--root', '--session', '--tick', '--cols', '--rows', '--out', '--under', '--ids', '--file', '--since', '--stale', '--drop', '--older-than', '--check', '--views', '--channel', '--prompt', '--agent', '--cwd', '--resume', '--tab', '--delete', '--undelete', '--after', '--kind', '--ts', '--title', '--message', '--interval', '--query', '--days', '--limit', '--text', '--edit', '--line', '--id', '--machine', '--comment-ids', '--pane', '--brief', '--name', '--report', '--model', '--effort', '--sandbox', '--permission-mode', '--until', '--timeout', '--workspace', '--parent', '--writable-root', '--worktree']);

/** Set while the terminal app runs interactive: a write that fails on its closed terminal (EIO) ends it as a hangup. */
let terminalApp = false;
/** runTui's own test: the app is interactive on a terminal, without `--once`. A one-shot frame is a command's output. */
const interactiveApp = (args: string[]): boolean => !args.includes('--once') && Boolean(process.stdin.isTTY && process.stdout.isTTY);

function main(): void {
  // Exit cleanly when output is piped to a consumer that closes early (`| head`, `| grep -q`, …)
  // instead of crashing with an unhandled EPIPE 'error' event, and, in the terminal app, when the terminal it
  // writes to has closed (EIO on a terminal, before or without its SIGHUP): the app restores and ends as on that
  // SIGHUP. Any other command ends on EIO as on any other write error, so one cut off part way never reports a
  // success. exit() without a status keeps one the verb has already set (a refused undo, `ignore --check` that
  // finds nothing ignored).
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE' || (err.code === 'EIO' && process.stdout.isTTY && terminalApp)) process.exit();
    throw err;
  });

  // Detached refreshes (`titles --refresh`) relaunch THIS file, the oak CLI, never whatever script started
  // the process: a harness can run the CLI in-process with its own argv[1]. Its own tiny module, so the
  // capture hook's hot path loads nothing more.
  require('@oak-observatory/core/dist/cli-entry').setOakCliEntry(__filename);

  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  if (cmd === 'agent' && rest[0] === 'tell') {
    void cmdAgentTell(rest.slice(1)).catch(e => fail(String(e?.message || e)));
    return;
  }
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
  // An empty `--root=` named no workspace: read as named, the verbs scoped to "" and `export` wrote
  // `"root": ""`, while the app read it as absent. Every verb and the app refuse it alike.
  if (argv.includes('--root=')) fail('`--root` requires a path');
  if (cmd === undefined || (cmd.startsWith('-') && !HELP_OR_VERSION.has(cmd))) {
    // A VERB typed after a flag is not a request to open the dashboard. `oak --root x
    // status` used to open the app and silently drop `status`, which reads as the flag being wrong.
    // Flags take a value, so only a token that is a known verb AND not the value of the flag before
    // it counts — otherwise `--session status` would be misread as the verb.
    const verb = argv.find((a, i) => !a.startsWith('-') && !(i > 0 && argv[i - 1].startsWith('-') && FLAGS_WITH_VALUES.has(argv[i - 1])) && KNOWN_VERBS.has(a));
    if (verb) {
      fail(`\`${verb}\` is a command, so it goes first: \`oak ${verb} ${argv.filter((a) => a !== verb).join(' ')}\``);
    }
    terminalApp = interactiveApp(argv);
    require('@oak-observatory/tui').runTui(require('@oak-observatory/core'), argv, getTuiSessionId);
    return;
  }
  if (!RAW_OUTPUT_VERBS.has(cmd) || (cmd === 'views' && isTTY())) {
    // `--json`, a patch and git's NUL-separated check-ignore format are for programs, byte for byte —
    // but printed to a terminal they are read by a person, and filtered like any other output.
    const exact = !isTTY() && (rest.includes('--json') || (cmd === 'diff' && rest.includes('--patch')) || (cmd === 'ignore' && rest.includes('-z')));
    guardHumanOutput(exact ? [process.stderr] : [process.stdout, process.stderr]);
  }
  // `oak agent` aimed at a saved machine by this CLI itself (agentOnMachine): the delegated agent's verb runs there.
  if (cmd === 'agent' && process.env.OAK_AGENT_FORWARD === '1' && rest.some(a => a === '--machine' || a.startsWith('--machine='))) {
    void forwardToMachine(cmd, rest).catch((e) => fail(String(e?.message || e)));
    return;
  }
  // A session verb aimed at a saved machine runs THERE, where the session's store and files are.
  if (MACHINE_VERBS.has(cmd) && rest.some(a => a === '--machine' || a.startsWith('--machine='))) {
    // A machine oak sync keeps current here lists its sessions from the local index, saying how fresh they are; any
    // other, and one with a session that may be running, is asked over ssh. A read that names a root or a session is
    // asked there; the terminal app asks its warm worker for the index's answer first (cmdSessions).
    if (cmd === 'sessions' && rest.includes('--json') && !rest.some((a) => /^--(delete|undelete|all|session|root|workers)(=|$)/.test(a))) {
      const at = rest.findIndex((a) => a === '--machine' || a.startsWith('--machine='));
      const label = rest[at].startsWith('--machine=') ? rest[at].slice('--machine='.length) : rest[at + 1];
      const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
      const listed = label ? core.indexedMachineSessions(label) : null;
      if (listed) {
        emitJson(listed);
        return;
      }
    }
    // Its conversations too: searched from its records here when oak sync read it lately, else over ssh.
    if (cmd === 'search') {
      const at = rest.findIndex((a) => a === '--machine' || a.startsWith('--machine='));
      const label = rest[at].startsWith('--machine=') ? rest[at].slice('--machine='.length) : rest[at + 1];
      const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
      const { query, opts } = searchRequest(rest);
      const found = label ? core.indexedMachineSearch(label, query, opts) : null;
      if (found) {
        printSearch(found, rest);
        return;
      }
    }
    if (cmd === 'processes' && flagValue(rest, '--follow')) { followMachineWorker(rest, flagValue(rest, '--follow')); return; }
    if (cmd === 'feed' && rest.includes('--follow')) { followMachineWorker(rest); return; }
    void forwardToMachine(cmd, rest).catch((e) => fail(String(e?.message || e)));
    return;
  }
  // …and arriving there, it runs where its session ran.
  if (process.env.OAK_FORWARDED === '1' && MACHINE_VERBS.has(cmd)) enterSessionWorkspace(rest);
  maybeCheckForUpdate(cmd, rest); // register a once-a-day "update available" nudge (never blocks)
  sayKeptPrefsAtExit(cmd);
  // A throw from a SYNC command should surface as `oak: <msg>`, not a raw Node stack.
  // process.exit() throws nothing, so a command's own exit is never caught here; async commands keep
  // their own .catch(fail) below.
  try {
  switch (cmd) {
    case 'editor-review':
      cmdEditorReview(rest);
      break;
    case '__conversation-protocol':
      process.stdout.write('1\n'); // bounded initial reads, remote byte cursors and replacement resets
      break;
    case '__update-protocol':
      // 1: `update --here` (this machine only) and `update --json`'s components. `oak update` on another
      // machine asks this first, so an older build there, which would ignore `--here` and plan nothing it
      // reports, is told to update rather than misread. 2: a CLI linked to a checkout is planned `linked`
      // and never replaced. Only `--level` is told 2, as `__review-protocol` does: a 0.10 caller checks for
      // exactly 1, and an older build asked with `--level` still answers 1.
      process.stdout.write(rest.includes('--level') ? '2\n' : '1\n');
      break;
    case '__review-protocol':
      // 1: units, sent-comment ledger, equals text values and JSON diffs. 2: `ignore --dry-run` counts and
      // drops nothing. Only `--level` is told 2: a 0.10 caller checks for exactly 1, and an older build
      // asked with `--level` still answers 1, so a caller that needs 2 refuses it.
      process.stdout.write(rest.includes('--level') ? '2\n' : '1\n');
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
      if (rest.includes('--workers')) cmdWorkerFleet(rest).catch((e) => fail(String(e.message || e)));
      else cmdSessions(rest);
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
    case 'query':
      cmdQuery(rest);
      break;
    case 'finding':
      try { cmdFinding(rest); } catch (e) { fail(String((e as Error).message)); }
      break;
    case '__query-sql':
      // Internal, hidden: the child that runs one guarded read for `oak query sql` (core index/sql.ts).
      cmdQuerySqlChild();
      break;
    case '__index-build':
      // Internal, hidden: started detached (by a reader whose catch-up was left undone, a capture hook, or a machine asked
      // to publish) to build or catch up the local index without waiting for it. A build that cannot open the index holds
      // the next off (core backOffIndexBuild). Another pass follows while a kick claimed a build since this pass began (a
      // hook that moved a hand, whose own build found this one holding the lease), and once a permission prompt it left
      // unpublished in its wait (5 s, or Codex Auto-review's 90) is due; four more passes at most. The wait ends, and the
      // build with it, once every such prompt is down (answered, or the reviewer's verdict came): the hook that lowered
      // it started a build of its own. One build a prompt slept out the whole wait, and they piled up (a Codex session
      // under Auto-review, a tool call every 2 s: 30 asleep at once, 2 GB).
      void (async () => {
        const core = require('@oak-observatory/core') as Core;
        let began = Date.now();
        let res = core.buildIndex();
        for (let pass = 0; pass < 4; pass++) {
          if ('ok' in res) {
            core.backOffIndexBuild();
            return;
          }
          const due = res.handsDueAt;
          if (!core.claimTouchedSince(began)) {
            if (due === undefined) return;
            const until = Date.now() + Math.min(Math.max(0, due - Date.now()) + 250, 95_000);
            const waited = res.handsDue ?? [];
            for (let left = until - Date.now(); left > 0; left = until - Date.now()) {
              await new Promise((done) => setTimeout(done, Math.min(left, 1000)));
              if (waited.length && !waited.some((h) => core.handStillUp(h.id, { kind: 'permission', ts: h.ts }))) return;
            }
          }
          began = Date.now();
          res = core.buildIndex();
        }
      })();
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
      deciding(() => cmdResolve(rest));
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
      cmdSiblings(rest);
      break;
    case 'fleet':
      cmdWorkerFleet(rest).catch((e) => fail(String(e.message || e)));
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
      deciding(() => cmdKeep(rest));
      break;
    case 'undo':
      deciding(() => cmdUndo(rest));
      break;
    case 'oplog':
      deciding(() => cmdOplog(rest));
      break;
    case 'assign':
      deciding(() => cmdAssign(rest));
      break;
    case 'redo':
      deciding(() => cmdRedo(rest));
      break;
    case 'task-keep':
      deciding(() => cmdTaskKeep(rest));
      break;
    case 'task-undo':
      deciding(() => cmdTaskUndo(rest));
      break;
    case 'task-clear':
      deciding(() => cmdTaskClear(rest));
      break;
    case 'demo':
      void cmdDemo(rest);
      break;
    case 'clean':
      deciding(() => cmdClean(rest));
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
      deciding(() => cmdIgnore(rest));
      break;
    case 'locate':
      cmdLocate(rest);
      break;
    case 'tree':
      cmdTree(rest);
      break;
    case 'views':
      cmdViews(rest).catch(e => fail(String(e?.message || e)));
      break;
    case 'tui':
      terminalApp = interactiveApp(rest);
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
    case '__usage-brief':
      // Internal, hidden: what an older OAK's `usage --pull-machines` reads from this one (sshUsageBrief): its readings.
      cmdUsage(['--brief', '--json']);
      break;
    case '__usage-records': {
      // Internal, hidden: what a saved machine's `usage --pull-machines` reads from this one: its own usage since a cursor.
      const core = require('@oak-observatory/core') as typeof import('@oak-observatory/core');
      emitJson(core.indexUsageRecords(flagValue(rest, '--since') ?? null));
      break;
    }
    case 'sync':
      void (require('./sync') as typeof import('./sync')).cmdSync(rest, syncDeps()).catch((e) => fail(String(e?.message || e)));
      break;
    case '__sync-inventory':
      // Internal, hidden: what another machine's `oak sync` reads from this one.
      (require('./sync') as typeof import('./sync')).cmdSyncInventory(rest, syncDeps());
      break;
    case '__sync-fetch':
      // Internal, hidden: the files another machine's `oak sync` pulls from this one, the request on stdin.
      void (require('./sync') as typeof import('./sync')).cmdSyncFetch(rest, syncDeps()).catch((e) => fail(String(e?.message || e)));
      break;
    case '__sync-key':
      // Internal, hidden: this machine's backup key, for `oak sync key --from` on another of the user's machines.
      (require('./sync') as typeof import('./sync')).cmdSyncKey(rest, syncDeps());
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
