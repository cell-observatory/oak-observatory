/**
 * `oak sync`: share the agents' state across the saved machines (core sync.ts, sync-engine.ts). The CLI is the API
 * every surface uses: `plan` previews, `now` pulls, `status` reads what the last run left, `fetch` brings one
 * session, `include`, `exclude`, `backup` and `family` change the settings in prefs.json, and `setup` and `key` choose
 * the backup and keep the backup folder's key. Each machine's state is read over OAK's own ssh with hidden commands
 * (`oak __sync-inventory`, `oak __sync-fetch`, `oak __sync-key`), which read, but for the writes a run asks of the
 * machine it reads: `__sync-inventory --publish` first records that machine's own session deletes and catches its own
 * local index up, which appends to its own record log, for its own user only (`oak sync plan` never asks it). Only this
 * machine's files are written by its run, with its own files in a backup folder when one is set.
 *
 * The helpers this file shares with the rest of the CLI (its ssh options, how ssh's failures are worded, the signals
 * that stop OAK's ssh) live in index.ts and are handed in, so there is one definition of each.
 */
import type { ChildProcess } from 'child_process';
import type {
  SyncPlan, SyncPlanMachine, SyncTransport, SyncChannel, SyncAskFailure, SyncNowResult, SyncStatusResult, SyncFetchResult, Prefs, SyncPlacementPref,
} from '@oak-observatory/core';

export interface SyncCliDeps {
  sshOpts: readonly string[];
  sshReason(stderr: string): string;
  stopSignals: readonly (readonly [NodeJS.Signals, number])[];
  endBySignal(sig: NodeJS.Signals, n: number): void;
  fail(msg: string): never;
  emitJson(v: unknown): void;
  c: Record<'dim' | 'bold' | 'green' | 'red' | 'yellow' | 'cyan', (s: string) => string>;
}

/** How long one machine's ssh and inventory may take: a large Claude config is read in seconds, a cold disk in more. */
export const SYNC_ASK_MS = 60_000;
/** A fetch that sends nothing for this long has stalled; one that streams may take as long as it needs. */
const SYNC_FETCH_IDLE_MS = 120_000;
/** An inventory is a few megabytes for thousands of sessions; an answer past this is not one. */
const SYNC_INVENTORY_MAX = 256 * 1024 * 1024;
/** A key's answer (`oak __sync-key`) is a line of JSON well under a kilobyte; past this it is not one. */
const SYNC_KEY_ANSWER_MAX = 64 * 1024;

type Core = typeof import('@oak-observatory/core');
const core = (): Core => require('@oak-observatory/core') as Core;

/** The ssh a running `oak sync` has started, stopped with it. */
const running = new Set<ChildProcess>();

/** Quote one word for the remote shell. */
const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** What a saved machine's ssh exit status and stderr say when it gave nothing usable: 255 is ssh's own failure, 127
 *  an `oak` its shell could not find, and every release names a verb it does not know as it refuses it. */
function judgeFailure(code: number | null, stderr: string, verb: string, deps: SyncCliDeps): SyncAskFailure | null {
  if (code === 0) return null;
  if (code === 255) return { status: 'unreachable', detail: deps.sshReason(stderr) };
  if (code === 127) return { status: 'no-oak' };
  if (stderr.includes(`unknown command "${verb}"`)) return { status: 'old-oak' };
  return { status: 'failed', detail: core().failureLines(stderr)[0] || (code === null ? 'ended by a signal' : `exited ${code}`) };
}

/** Start a saved machine's hidden sync command over OAK's own ssh as the usage readings reach it (herdr's target,
 *  MACHINE_PATH, never an interactive shell, `ControlMaster=no` so it never becomes a shared connection's master). */
function sshSync(target: string, verb: string, user: string, deps: SyncCliDeps, stdin: boolean, publish = false): ChildProcess {
  const remote = `env PATH="${core().MACHINE_PATH}" CLAUDE_OBSERVATORY_NO_UPDATE_CHECK=1 oak ${verb}${verb === '__sync-inventory' ? ` --json${publish ? ' --publish' : ''}` : ''} --user ${quote(user)}`;
  const child = core().spawnTool('ssh', ['-T', ...deps.sshOpts, '-o', 'ControlMaster=no', target, remote], {
    stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'], direct: true, windowsHide: true, env: core().machineSshEnv(),
  });
  running.add(child);
  child.on('close', () => running.delete(child));
  return child;
}

/** One saved machine's `oak __sync-inventory --json --user <name>`: its stdout, or why there is none (ssh's own
 *  reason when it could not connect, no answer within SYNC_ASK_MS, no `oak` there, or an OAK from before the verb).
 *  `publish` (a run, never a plan): that machine catches its index up first, so its record log holds what it has. An OAK
 *  from before the flag ignores it. */
function sshInventory(target: string, user: string, deps: SyncCliDeps, publish: boolean): Promise<{ text: string } | SyncAskFailure> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = sshSync(target, '__sync-inventory', user, deps, false, publish);
    } catch (e) {
      resolve({ status: 'unreachable', detail: `ssh could not start: ${String((e as Error)?.message || e)}` });
      return;
    }
    const out: Buffer[] = [];
    let size = 0;
    let err = Buffer.alloc(0);
    child.stdout?.on('data', (d: Buffer) => {
      size += d.length;
      if (size <= SYNC_INVENTORY_MAX) out.push(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      err = Buffer.concat([err, d]);
      if (err.length > 16384) err = err.subarray(err.length - 16384);
    });
    let settled = false;
    let drain: NodeJS.Timeout | undefined;
    const settle = (answer: { text: string } | SyncAskFailure): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(answer);
    };
    const judge = (code: number | null): { text: string } | SyncAskFailure => {
      const failed = judgeFailure(code, err.toString('utf8'), '__sync-inventory', deps);
      if (failed) return failed;
      return size > SYNC_INVENTORY_MAX ? { status: 'failed', detail: `its answer was larger than ${SYNC_INVENTORY_MAX / 1024 / 1024} MB` } : { text: Buffer.concat(out).toString('utf8') };
    };
    const timer = setTimeout(() => {
      child.kill();
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
      settle({ status: 'timeout' });
    }, SYNC_ASK_MS);
    child.on('error', (e: Error) => settle({ status: 'unreachable', detail: `ssh could not start: ${e.message}` }));
    // A process ssh left behind may hold its stdout open: what it wrote is judged once its pipes have had a second.
    child.on('exit', (code: number | null) => { if (!settled) drain = setTimeout(() => settle(judge(code)), 1000); });
    child.on('close', (code: number | null) => settle(judge(code)));
  });
}

/** One saved machine's `oak __sync-fetch --user <name>`, the request on its stdin: its stdout as it streams, and how
 *  it ended. A fetch that sends nothing for SYNC_FETCH_IDLE_MS is stopped, as is one the engine stops (its time for
 *  the machine is up), whose ending is then no failure of the machine's. */
function sshFetch(target: string, user: string, request: string, deps: SyncCliDeps): SyncChannel {
  const nothing = async function* (): AsyncGenerator<Buffer> { /* no output */ };
  let child: ChildProcess;
  try {
    child = sshSync(target, '__sync-fetch', user, deps, true);
  } catch (e) {
    return { stream: nothing(), done: Promise.resolve({ status: 'unreachable', detail: `ssh could not start: ${String((e as Error)?.message || e)}` }) };
  }
  let err = Buffer.alloc(0);
  child.stderr?.on('data', (d: Buffer) => {
    err = Buffer.concat([err, d]);
    if (err.length > 16384) err = err.subarray(err.length - 16384);
  });
  child.stdin?.on('error', () => { /* ssh closed first: its exit says why */ });
  child.stdin?.end(request);
  let idle: NodeJS.Timeout | undefined;
  let stalled = false;
  let stopped = false;
  const kill = (): void => {
    clearTimeout(idle);
    child.kill();
    setTimeout(() => child.kill('SIGKILL'), 1000).unref();
  };
  const poke = (): void => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      stalled = true;
      kill();
    }, SYNC_FETCH_IDLE_MS);
  };
  poke();
  child.stdout?.on('data', () => { if (!stopped) poke(); });
  const done = new Promise<SyncAskFailure | null>((resolve) => {
    child.on('error', (e: Error) => resolve({ status: 'unreachable', detail: `ssh could not start: ${e.message}` }));
    // Stopped, it is done once ssh is gone: a process it started may hold its pipes open longer.
    child.on('exit', () => { if (stopped) resolve(null); });
    child.on('close', (code: number | null) => {
      clearTimeout(idle);
      resolve(stalled ? { status: 'timeout' } : stopped ? null : judgeFailure(code, err.toString('utf8'), '__sync-fetch', deps));
    });
  });
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    kill();
    // Its streams end now, whatever else still holds the pipes, and leave nothing keeping this process alive.
    child.stdout?.destroy();
    child.stderr?.destroy();
  };
  return { stream: (child.stdout as AsyncIterable<Buffer> | null) ?? nothing(), done, stop };
}

/** The transport the engine reads machines through: herdr's list, and each machine's two commands over ssh. `publish`:
 *  each machine asked catches its index up before it answers (a run, never a plan, which changes nothing anywhere). */
function transport(deps: SyncCliDeps, publish = false): SyncTransport {
  return {
    machines: async () => {
      const bin = core().findHerdrBin();
      if (!bin) return null;
      return core().herdrMachines({ binary: bin, timeoutMs: 15000 });
    },
    inventory: (target, user) => sshInventory(target, user, deps, publish),
    fetch: (target, user, request) => sshFetch(target, user, request, deps),
  };
}

/** The values of every `--machine <label>` / `--machine=<label>`. */
function machineArgs(args: string[], deps: SyncCliDeps): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--machine=')) out.push(a.slice('--machine='.length));
    else if (a === '--machine') {
      const v = args[++i];
      if (!v || v.startsWith('-')) deps.fail('`--machine` needs a saved machine label — see `oak machine list`');
      out.push(v);
    }
  }
  if (out.some((v) => !v)) deps.fail('`--machine` needs a saved machine label — see `oak machine list`');
  return out;
}

/** This machine's user, which every machine must answer for. */
function userOrFail(deps: SyncCliDeps): string {
  const user = core().localUserName();
  if (!user) deps.fail('could not tell which user this machine runs as, which every machine must answer for');
  return user;
}

const FAMILY_LABELS: Record<string, string> = {
  transcripts: 'transcripts',
  'session-files': 'session files',
  memory: 'memory',
  plans: 'plans',
  skills: 'skills',
  agents: 'agents',
  commands: 'commands',
  rollouts: 'Codex rollouts',
  'oak-log': 'OAK edit logs',
  'oak-blobs': 'OAK snapshots',
  'oak-meta': 'OAK comments, agents',
  'oak-events': 'OAK hook events',
  'oak-records': 'OAK record logs',
};

/** Why a machine gave nothing, in a sentence. */
function statusLine(m: { status: string; detail?: string }): string {
  switch (m.status) {
    case 'shared': return 'refused: it runs under another user\'s account, so it listed nothing';
    case 'disabled': return 'not asked: it is disabled in herdr';
    case 'excluded': return 'not asked: excluded from sync here (`oak sync include` brings it back)';
    case 'duplicate': return `not asked again: ${m.detail ?? 'a machine already asked'}`;
    case 'unreachable': return `could not be reached over ssh${m.detail ? `: ${m.detail}` : ''}`;
    case 'timeout': return `gave no answer within ${SYNC_ASK_MS / 1000} s`;
    case 'no-oak': return 'OAK was not found there (`oak machine add` installs it)';
    case 'old-oak': return 'its OAK is older than this one and has no sync (run `oak update` there)';
    case 'not-inventory': return m.detail ?? 'its answer was not an inventory';
    case 'busy': return 'another sync is running here';
    default: return `failed${m.detail ? `: ${m.detail}` : ''}`;
  }
}

/** The plan for a person: per machine, what it would pull, by family, and what it would not, and why. */
function printPlan(plan: SyncPlan, deps: SyncCliDeps): void {
  const { c } = deps;
  const w = (s: string): boolean => process.stdout.write(s);
  w(`${c.bold('Sync plan')} ${c.dim('(preview: nothing is copied or changed on any machine)')}\n\n`);
  const width = Math.max(...plan.machines.map((m) => m.label.length + (m.local ? ' (this machine)'.length : 0))) + 3;
  for (const m of plan.machines) {
    const name = `${m.label}${m.local ? ' (this machine)' : ''}`;
    w(`  ${name.padEnd(width)}${m.passive ? c.green('the backup folder\'s copy') : m.status === 'ok' ? c.green(`inventoried${m.backup ? ', the backup' : ''}`) : c.yellow(statusLine(m))}\n`);
  }
  for (const m of plan.machines) if (m.status === 'ok' && m.summary && !m.passive) printMachinePlan(m, deps);
}

function printMachinePlan(m: SyncPlanMachine, deps: SyncCliDeps): void {
  const { c } = deps;
  const bytes = core().compactBytes;
  const w = (s: string): boolean => process.stdout.write(s);
  const total = (m.pulls ?? []).reduce((s, p) => s + p.bytes, 0);
  w(`\n${c.bold(m.label)} would pull ${m.pulls?.length ? `${m.pulls.length} file${m.pulls.length === 1 ? '' : 's'}, ${bytes(total)}` : 'nothing'}\n`);
  for (const [fam, t] of Object.entries(m.summary ?? {})) {
    if (!t.files) continue;
    const items = (m.pulls ?? []).filter((p) => p.family === fam);
    const missing = items.filter((p) => p.reason === 'missing').length;
    const longer = items.filter((p) => p.reason === 'longer').length;
    const merges = items.filter((p) => p.action === 'merge').length;
    const parts = [missing ? `${missing} ${items[0].action === 'copy' ? 'to copy' : 'new'}` : '', longer ? `${longer} longer elsewhere, whose first bytes are checked against these` : '', merges ? `${merges} to merge` : ''].filter(Boolean);
    w(`  ${(FAMILY_LABELS[fam] ?? fam).padEnd(16)}${String(t.files).padStart(6)} ${bytes(t.bytes).padStart(8)}  ${c.dim(parts.join(', '))}\n`);
  }
  const sk = m.skipped;
  const files = (n: number): string => `${n} file${n === 1 ? '' : 's'}`;
  if (sk?.retention.files) w(`  ${c.dim(`skipped: ${files(sk.retention.files)} (${bytes(sk.retention.bytes)}) older than the ${m.retentionDays}-day retention here`)}\n`);
  if (sk?.placement.files) w(`  ${c.dim(`listed only: ${files(sk.placement.files)} (${bytes(sk.placement.bytes)}) of sessions other machines keep; \`oak sync fetch <session>\` brings one here`)}\n`);
  if (sk?.deleted.files) w(`  ${c.dim(`skipped: ${files(sk.deleted.files)} of sessions deleted with \`oak sessions --delete\``)}\n`);
  if (sk?.excluded.files) w(`  ${c.dim(`skipped: ${files(sk.excluded.files)} of excluded projects`)}\n`);
  if (sk?.off.files) w(`  ${c.dim(`skipped: ${files(sk.off.files)} of families turned off here`)}\n`);
  if (sk?.large.files) w(`  ${c.yellow('skipped:')} ${files(sk.large.files)} of text too large to merge (over 16 MB)\n`);
  for (const u of m.unmapped ?? []) {
    const where = u.lands ? `lands under that machine's folder name, ${u.folder}; resuming it needs a checkout here` : 'not pulled';
    w(`  ${c.yellow('no place here:')} ${u.key ?? u.folder} from ${u.from}: ${u.reason}; ${where}; ${files(u.files)}, ${bytes(u.bytes)}\n`);
  }
  for (const d of m.diverged ?? []) w(`  ${c.yellow('check:')} ${FAMILY_LABELS[d.family] ?? d.family} ${d.to} (${bytes(d.localSize)} here, ${bytes(d.size)} on ${d.from}): ${d.note}\n`);
  for (const warning of m.warnings ?? []) w(`  ${c.yellow('warning:')} ${warning}\n`);
}

/** The plan of a run, as `oak sync plan` and `oak sync setup` show it: every machine asked, and a backup folder's copy
 *  of each machine it holds, read and never written. */
async function planRun(machines: string[], deps: SyncCliDeps): Promise<{ plan: SyncPlan; backupError?: string }> {
  const c = core();
  const settings = c.syncSettings();
  const nodes = await c.collectSyncNodes(transport(deps), { machines, exclude: settings.excludeMachines, user: userOrFail(deps) });
  const role = c.resolveSyncBackup(settings.backup, { nodes, local: nodes[0].inventory!, readOnly: true });
  nodes[0].role = { backup: role?.self === true };
  nodes.push(...(role?.nodes ?? []));
  const plan = c.planSync(nodes, Date.now(), { unmappedLands: true, policy: true });
  for (const w of role?.warnings ?? []) plan.machines[0].warnings?.push(w);
  for (const e of role?.errors ?? []) plan.machines[0].warnings?.push(`the backup folder: ${e}`);
  return { plan, ...(role?.error ? { backupError: role.error } : {}) };
}

/** `oak sync plan [--machine <label>]… [--json]`: what `oak sync now` would do on each machine, by its own settings. */
async function syncPlan(args: string[], deps: SyncCliDeps): Promise<void> {
  let r: { plan: SyncPlan; backupError?: string };
  try {
    r = await planRun(machineArgs(args, deps), deps);
  } catch (e) {
    deps.fail(String((e as Error)?.message || e));
  }
  if (r.backupError) r.plan.machines[0].warnings?.push(`the backup folder cannot be used: ${r.backupError}`);
  if (args.includes('--json')) deps.emitJson(r.plan);
  else printPlan(r.plan, deps);
}

/** `oak sync now [--machine <label>]… [--json] [--quiet] [--if-due]`. Exits 1 when every machine it asked failed and
 *  nothing was pulled (core syncNowFailed), as `oak sync fetch` does when no machine gave the session; 0 otherwise,
 *  nothing due and everything current included. */
async function syncNow(args: string[], deps: SyncCliDeps): Promise<void> {
  const quiet = args.includes('--quiet');
  let result: SyncNowResult;
  try {
    result = await core().syncNow(transport(deps, true), { machines: machineArgs(args, deps), ifDue: args.includes('--if-due') });
  } catch (e) {
    if (quiet) return; // a background run says nothing; `oak sync status` shows the last run
    deps.fail(String((e as Error)?.message || e));
  }
  if (core().syncNowFailed(result)) process.exitCode = 1;
  if (args.includes('--json')) {
    deps.emitJson(result);
    return;
  }
  if (quiet) return;
  const { c } = deps;
  const bytes = core().compactBytes;
  const w = (s: string): boolean => process.stdout.write(s);
  if (result.status === 'busy') {
    w(`${c.yellow('another oak sync is running on this machine;')} it pulls the same\n`);
    return;
  }
  if (result.status === 'not-due' || result.status === 'off') {
    w(c.dim(result.status === 'off' ? 'the background sync is turned off here\n' : 'synced moments ago; nothing due\n'));
    return;
  }
  const pulled = result.done.filter((d) => d.action !== 'conflict' && d.action !== 'skipped');
  // `nothing to pull` only when every machine answered: one that did not may hold what this machine lacks.
  w(`${c.bold('oak sync')}: ${pulled.length ? `pulled ${pulled.length} file${pulled.length === 1 ? '' : 's'}, ${bytes(pulled.reduce((s, d) => s + d.bytes, 0))}` : result.status === 'ok' ? 'nothing to pull' : 'nothing pulled'}${result.backup ? c.dim(`   backup: ${result.backup.label}${result.backup.self ? ' (this machine)' : ''}`) : ''}\n`);
  const width = Math.max(0, ...result.machines.map((m) => m.label.length)) + 3;
  for (const m of result.machines) {
    const files = (n: number): string => `${n} file${n === 1 ? '' : 's'}`;
    const got = m.pushed
      ? `${m.pulled.files ? `${files(m.pulled.files)} restored, ${bytes(m.pulled.bytes)}; ` : ''}${m.pushed.files ? `${files(m.pushed.files)} written, ${bytes(m.pushed.bytes)}` : 'up to date'}`
      : m.pulled.files ? `${files(m.pulled.files)}, ${bytes(m.pulled.bytes)}` : 'up to date';
    const line = m.status === 'ok'
      ? `${got}${m.conflicts ? c.yellow(`; ${m.conflicts} conflict${m.conflicts === 1 ? '' : 's'}`) : ''}${m.pending.files ? c.yellow(`; ${m.pending.files} left for the next run`) : ''}${m.errors.length ? c.yellow(`; ${m.errors[0]}`) : ''}`
      : c.yellow(statusLine(m));
    w(`  ${m.label.padEnd(width)}${line}\n`);
  }
  for (const d of result.done.filter((x) => x.action === 'conflict')) w(`  ${c.yellow('conflict:')} ${FAMILY_LABELS[d.family] ?? d.family} ${d.name} from ${d.from}: kept as ${d.to}\n`);
  if (result.tombstones.applied) w(`  ${c.dim(`${result.tombstones.applied} delete${result.tombstones.applied === 1 ? '' : 's'} made on other machines applied here`)}\n`);
  for (const warning of result.warnings) w(`  ${c.yellow('warning:')} ${warning}\n`);
}

/** One machine's line of the last run: what came from it (a backup folder's line, what was written there too) and what
 *  is left for the next run, or why nothing did and when it last gave something. `oak sync status` prints it after the
 *  machine's label, and its `--json` carries it as each line's `text`, so every surface says it in these words. */
function runLine(m: NonNullable<SyncStatusResult['last']>['machines'][number]): { ok: boolean; said: string; extra: string } {
  const { compactBytes: bytes, relTime } = core();
  const files = (n: number): string => `${n} file${n === 1 ? '' : 's'}`;
  if (m.status === 'ok' && !m.errors.length) {
    const got = m.pushed ? `${files(m.pulled.files)} restored, ${files(m.pushed.files)} written, ${bytes(m.pushed.bytes)}` : `${files(m.pulled.files)}, ${bytes(m.pulled.bytes)}`;
    return { ok: true, said: got, extra: m.pending.files ? `; ${m.pending.files} pending` : '' };
  }
  return { ok: false, said: m.errors[0] ?? statusLine(m), extra: m.lastOkAt ? ` (last pulled ${relTime(m.lastOkAt)})` : '' };
}

/** The project in [root] (else the folder this runs in), keyed as `oak sync exclude <folder>` keys it, and whether it is
 *  excluded here: an editor without core in its process (JetBrains) shows this project's state from it. Null when it
 *  cannot be keyed (the folder this runs in was removed, say). */
function projectHere(root: string | undefined, excluded: readonly string[]): { folder: string; key: string; excluded: boolean } | null {
  try {
    const c = core();
    const folder = require('path').resolve(root ?? process.cwd()) as string;
    const key = c.identityKey(folder, { home: (require('os') as typeof import('os')).homedir(), shares: c.readMountTable() }).key;
    return { folder, key, excluded: excluded.includes(key) };
  } catch {
    return null;
  }
}

/** `oak sync status [--json]`: what the last run left, from this machine's store alone. */
function syncStatus(args: string[], deps: SyncCliDeps): void {
  const st: SyncStatusResult = core().syncStatus();
  if (args.includes('--json')) {
    deps.emitJson({ ...(st.last ? { ...st, last: { ...st.last, machines: st.last.machines.map((m) => {
      const line = runLine(m);
      return { ...m, text: `${line.said}${line.extra}` };
    }) } } : st), project: projectHere(flagArg(args, '--root', deps), st.exclude.projects) });
    return;
  }
  const { c } = deps;
  const { compactBytes: bytes, relTime } = core();
  const w = (s: string): boolean => process.stdout.write(s);
  if (!st.last) {
    w(`${c.bold('oak sync')}: no run with a saved machine to sync with, or with a backup folder set, here yet. ${c.dim('`oak sync plan` previews one; `oak sync now` runs it, and the background runs follow.')}\n`);
    return;
  }
  const backup = st.backup ? ('label' in st.backup ? st.backup.label : `${st.backup.path} (folder, key ${st.key?.fingerprint ?? 'missing here'})`) : 'none set';
  w(`${c.bold('oak sync')}: last run ${relTime(st.last.at)} (${st.last.status})${st.running ? c.yellow(', one running now') : ''}   ${c.dim(`background: ${st.auto ? 'on' : 'off'}   backup: ${backup}`)}\n`);
  const width = Math.max(0, ...st.last.machines.map((m) => m.label.length)) + 3;
  for (const m of st.last.machines) {
    // A backup folder's line says what came back from it and what was written there.
    const line = runLine(m);
    w(`  ${m.label.padEnd(width)}${line.ok ? `${line.said}${line.extra ? c.yellow(line.extra) : ''}` : `${c.yellow(line.said)}${line.extra ? c.dim(line.extra) : ''}`}\n`);
  }
  if (st.conflicts.length) {
    w(`\n${c.yellow(`${st.conflicts.length} open conflict${st.conflicts.length === 1 ? '' : 's'}`)} ${c.dim('(resolve one by editing your file, or by deleting its copy with `oak sync resolve <id>`; a diverged session by deleting its copy)')}\n`);
    for (const x of st.conflicts) w(`  ${x.id}  ${FAMILY_LABELS[x.family] ?? x.family} ${x.name} from ${x.from}: ${x.copy}\n`);
  }
  if (st.index.length) w(`\n${c.dim(`inventories: ${st.index.map((x) => `${x.label} (${x.files} files, ${bytes(x.bytes)}, ${relTime(x.savedAt)})`).join(', ')}`)}\n`);
  w(c.dim(`on-demand copies: ${st.cache.files} file${st.cache.files === 1 ? '' : 's'}, ${bytes(st.cache.bytes)} of ${st.cache.capMB} MB\n`));
  for (const warning of st.last.warnings) w(`${c.yellow('warning:')} ${warning}\n`);
}

/** `oak sync fetch <session> [--json]`: bring one session here from the machine that made it, or the backup. */
async function syncFetch(args: string[], deps: SyncCliDeps): Promise<void> {
  const session = args.find((a) => !a.startsWith('-'));
  if (!session) deps.fail('usage: oak sync fetch <session> [--json]');
  let r: SyncFetchResult;
  try {
    r = await core().syncFetchSession(transport(deps), session);
  } catch (e) {
    deps.fail(String((e as Error)?.message || e));
  }
  if (args.includes('--json')) {
    deps.emitJson(r);
    if (!r.path) process.exitCode = 1;
    return;
  }
  const tried = r.tried.filter((t) => t.status !== 'ok').map((t) => `${t.label}: ${t.detail ?? t.status}`);
  if (!r.path) deps.fail(`could not fetch ${session}${tried.length ? `: ${tried.join('; ')}` : ''}`);
  const files = r.done.filter((d) => d.action === 'create' || d.action === 'append');
  process.stdout.write(`${files.length ? `${deps.c.green('fetched')} ${session} from ${r.from} (${files.length} file${files.length === 1 ? '' : 's'})` : `${session} is already here`}: ${r.path}\n`);
}

/** `oak sync resolve <conflict> [--json]`: keep this machine's file, deleting the other machine's copy into sync's
 *  trash, and close the conflict now (core resolveSyncConflict). The id is a conflict's, as `oak sync status` and
 *  `oak inbox` list it. */
function syncResolve(args: string[], deps: SyncCliDeps): void {
  const id = args.find((a) => !a.startsWith('-'));
  if (!id) deps.fail('usage: oak sync resolve <conflict> [--json] (`oak sync status --json` lists each conflict\'s id)');
  let r: ReturnType<Core['resolveSyncConflict']>;
  try {
    r = core().resolveSyncConflict(id);
  } catch (e) {
    deps.fail(String((e as Error)?.message || e));
  }
  if (args.includes('--json')) {
    deps.emitJson(r);
    return;
  }
  process.stdout.write(`${deps.c.green('resolved')} ${FAMILY_LABELS[r.family] ?? r.family} ${r.name}: the copy from ${r.from} ${r.trash ? `is in sync's trash (${r.trash})` : 'was gone already'}, and this machine's file stands\n`);
}

type SyncPrefs = NonNullable<Prefs['sync']>;

/** Change prefs.json `sync` with `edit`, keeping everything else in the file. */
function editSyncPrefs(edit: (s: SyncPrefs) => void, deps: SyncCliDeps): Prefs['sync'] {
  const c = core();
  // Settings an older OAK dropped are written back first, as a restore (keptPrefs), which the command then says.
  const prefs = c.keptPrefs(true);
  const sync: SyncPrefs = JSON.parse(JSON.stringify(prefs.sync ?? {}));
  edit(sync);
  try {
    c.writePrefs({ ...prefs, sync });
  } catch (e) {
    deps.fail(String((e as Error)?.message || e));
  }
  return c.readPrefs().sync;
}

/** `oak sync include|exclude <machine|project>`: a saved machine by its label, or a project by its identity key or a
 *  folder here, whose key it is. */
async function syncSelect(include: boolean, args: string[], deps: SyncCliDeps): Promise<void> {
  const what = args.find((a) => !a.startsWith('-'));
  if (!what) deps.fail(`usage: oak sync ${include ? 'include' : 'exclude'} <machine|project> [--json]`);
  const c = core();
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const os = require('os') as typeof import('os');
  let kind: 'machines' | 'projects' = 'projects';
  let value = what;
  if (!/^(?:git|home|share|path):/.test(what)) {
    const bin = c.findHerdrBin();
    const machines = bin ? await c.herdrMachines({ binary: bin, timeoutMs: 15000 }).catch(() => []) : [];
    const m = machines.find((x) => x.label === what || x.id === what);
    const asPath = path.resolve(what === '~' || what.startsWith('~/') ? path.join(os.homedir(), what.slice(1)) : what);
    if (m) {
      kind = 'machines';
      value = m.label;
    } else if (fs.existsSync(asPath) && fs.statSync(asPath).isDirectory()) {
      value = c.identityKey(asPath, { home: os.homedir(), shares: c.readMountTable() }).key;
    } else if (include && c.syncSettings().excludeMachines.includes(what)) {
      kind = 'machines'; // a machine excluded before it was removed from herdr
    } else deps.fail(`"${what}" is no saved machine (see \`oak machine list\`), project key (git:, home:, share:, path:) or folder here`);
  }
  const sync = editSyncPrefs((s) => {
    const list = new Set(s.exclude?.[kind] ?? []);
    if (include) list.delete(value);
    else list.add(value);
    s.exclude = { ...(s.exclude ?? {}), [kind]: [...list] };
  }, deps);
  if (args.includes('--json')) {
    deps.emitJson({ syncExclude: { machines: sync?.exclude?.machines ?? [], projects: sync?.exclude?.projects ?? [] } });
    return;
  }
  process.stdout.write(`${include ? 'included' : 'excluded'} ${kind === 'machines' ? 'machine' : 'project'} ${value}\n`);
}

/** The value after `flag`, or undefined; a flag with no value fails. */
function flagArg(args: string[], flag: string, deps: SyncCliDeps): string | undefined {
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  const v = args[at + 1];
  if (!v || v.startsWith('--')) deps.fail(`\`${flag}\` needs a value`);
  return v;
}

/** Where a folder backup's key comes from, when this machine has none, or another. */
type KeySource = { from: string } | { text: string } | null;

/** Read this machine's key, or fail saying why it cannot be. */
function keyOrNull(deps: SyncCliDeps): Buffer | null {
  try {
    return core().readSyncKey();
  } catch (e) {
    deps.fail(String((e as Error)?.message || e));
  }
}

/** A saved machine's backup key, over OAK's ssh (`oak __sync-key` there, which answers only this user). */
async function keyFromMachine(label: string, deps: SyncCliDeps): Promise<Buffer> {
  const c = core();
  const bin = c.findHerdrBin();
  if (!bin) deps.fail('herdr is not installed on this machine, so it has no saved machines — run `oak doctor --fix` first');
  const machines = await c.herdrMachines({ binary: bin, timeoutMs: 15000 });
  const m = machines.find((x) => x.label === label || x.id === label);
  if (!m) deps.fail(`no saved machine "${label}" — see \`oak machine list\``);
  if (!m.target || m.target.startsWith('-')) deps.fail(`${label}'s ssh target is not one OAK runs`);
  const user = userOrFail(deps);
  const answer = await new Promise<{ text: string } | SyncAskFailure>((resolve) => {
    let child: ChildProcess;
    try {
      child = sshSync(m.target, '__sync-key', user, deps, false);
    } catch (e) {
      resolve({ status: 'unreachable', detail: `ssh could not start: ${String((e as Error)?.message || e)}` });
      return;
    }
    const out: Buffer[] = [];
    let size = 0;
    let err = Buffer.alloc(0);
    // Read up to SYNC_KEY_ANSWER_MAX and no further: an answer past it is refused at once, not read until the timeout.
    child.stdout?.on('data', (d: Buffer) => {
      size += d.length;
      if (size <= SYNC_KEY_ANSWER_MAX) out.push(d);
      else {
        clearTimeout(timer);
        child.kill();
        resolve({ status: 'failed', detail: `its answer was larger than ${SYNC_KEY_ANSWER_MAX / 1024} KB, which no key's is: something there printed to standard output before OAK did, such as a shell startup file` });
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      err = Buffer.concat([err, d]);
      if (err.length > 16384) err = err.subarray(err.length - 16384);
    });
    const timer = setTimeout(() => { child.kill(); resolve({ status: 'timeout' }); }, SYNC_ASK_MS);
    child.on('error', (e: Error) => { clearTimeout(timer); resolve({ status: 'unreachable', detail: e.message }); });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve(judgeFailure(code, err.toString('utf8'), '__sync-key', deps) ?? { text: Buffer.concat(out).toString('utf8') });
    });
  });
  if (!('text' in answer)) deps.fail(`could not read the backup key from ${label}: ${statusLine(answer)}`);
  let o: { syncKey?: number; key?: string | null; shared?: boolean };
  try {
    o = JSON.parse(answer.text);
  } catch {
    deps.fail(`${label}'s answer was not a key: something there printed to standard output before OAK did, such as a shell startup file`);
  }
  if (o.shared) deps.fail(`${label} runs under another user's account, so it gives no key`);
  if (!o.key) deps.fail(`${label} has no backup key either: make one where the backup was set up, or set up a new backup with \`oak sync setup\``);
  return c.parseSyncKey(o.key);
}

/** A key from where `src` says. */
async function keyFrom(src: Exclude<KeySource, null>, deps: SyncCliDeps): Promise<Buffer> {
  if ('from' in src) return keyFromMachine(src.from, deps);
  try {
    return core().parseSyncKey(src.text);
  } catch (e) {
    deps.fail(String((e as Error)?.message || e));
  }
}

/** All of standard input, as text (a key piped in, kept out of the shell's history). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((n, b) => n + b.length, 0) > 4096) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Make `folder` this machine's backup: with its key (or one from `src`, or a new one for a folder that holds no backup
 * yet), the folder made an OAK backup (sync-folder.ts initBackupFolder), and prefs.json's `sync.backup` set. Fails, and
 * changes nothing, when the folder holds a backup this machine's key does not open, or other files. With `json` (setup's
 * `--json`), a backup another key opens is answered `{ syncSetup: 1, needsKey: true, folder, error }` with exit 1 and
 * null returned, so a surface asks where the key comes from, as setup asks on a terminal.
 */
async function useFolder(folder: string, src: KeySource, opts: { replace?: boolean; json?: boolean }, deps: SyncCliDeps): Promise<{ path: string; fingerprint: string; madeKey: boolean; importedKey: boolean; created: boolean } | null> {
  const c = core();
  const dir = c.backupFolderPath(folder);
  const keyNeeded = (error: string): null => {
    if (!opts.json) deps.fail(error);
    // `keyHere`: this machine's own key, which one brought for this folder replaces only with --replace.
    deps.emitJson({ syncSetup: 1, needsKey: true, folder: dir, error, keyHere: here ? c.keyFingerprint(here) : null });
    process.exitCode = 1;
    return null;
  };
  if (!require('path').isAbsolute(folder) && !folder.startsWith('~')) deps.fail(`"${folder}" is relative: give the folder's absolute path, which can differ on each machine`);
  let key = keyOrNull(deps);
  const here = key;
  let importedKey = false;
  let madeKey = false;
  if (src) {
    const k = await keyFrom(src, deps);
    importedKey = !key || !c.sameKey(key, k);
    key = k;
  }
  // A folder that holds a backup is opened with the key this machine has, or the one given; a new one gets this
  // machine's key, or a new key.
  const fs = require('fs') as typeof import('fs');
  let holdsBackup = false;
  try {
    holdsBackup = fs.existsSync(require('path').join(dir, 'oak-backup'));
  } catch {
    holdsBackup = false;
  }
  if (!key) {
    if (holdsBackup) return keyNeeded(`${dir} holds a backup sealed under a key this machine does not have: copy it from a machine that has it (\`oak sync key --from <machine>\`, or \`--key-from <machine>\` here), or \`oak sync key --import\`; if no copy of that key is left, nothing can read that backup: choose an empty folder for a new one`);
    key = c.newSyncKey();
    madeKey = true;
  }
  // A key brought here is checked against a backup there already, and kept (a different key here only with --replace)
  // before anything is sealed under it: a folder is never made under a key this machine does not keep.
  if (holdsBackup) {
    const opened = c.openBackupFolder(dir, key);
    if (!opened.ok) return opened.code === 'wrong-key' ? keyNeeded(opened.error) : deps.fail(opened.error);
  }
  const keep = (): void => {
    try {
      c.writeSyncKey(key!, { replace: opts.replace });
    } catch (e) {
      deps.fail(String((e as Error)?.message || e));
    }
  };
  if (importedKey) keep();
  let init: ReturnType<Core['initBackupFolder']>;
  try {
    init = c.initBackupFolder(dir, key);
  } catch (e) {
    // The file system's refusal (a folder this machine cannot write, a full disk), said with what to do.
    const err = e as NodeJS.ErrnoException;
    deps.fail(err?.code ? `${dir} cannot be made the backup folder: ${err.message}. Choose a folder this machine can write` : String(err?.message || e));
  }
  const { check, created } = init;
  if (!check.ok) {
    if (created) fs.rmSync(dir, { recursive: true, force: true });
    deps.fail(check.error);
  }
  // A new key is kept once the folder took it; a folder this made is unmade if the key cannot be kept.
  if (madeKey) {
    try {
      c.writeSyncKey(key);
    } catch (e) {
      if (created) fs.rmSync(dir, { recursive: true, force: true });
      else fs.rmSync(require('path').join(dir, 'oak-backup'), { force: true });
      deps.fail(String((e as Error)?.message || e));
    }
  }
  editSyncPrefs((s) => {
    s.backup = { kind: 'folder', path: dir };
  }, deps);
  return { path: dir, fingerprint: c.keyFingerprint(key), madeKey, importedKey, created };
}

/** What `oak sync backup --folder` and `oak sync setup` say of a key they made. Each other machine names this one by the
 *  label it saved it under, which this machine cannot know. */
function keyAdvice(deps: SyncCliDeps): string {
  return `${deps.c.yellow('a new backup key was made here.')} Keep a copy where you keep passwords (\`oak sync key --show\`): without it the backup cannot be read. On each of your other machines, run \`oak sync setup --folder <the folder's path there> --key-from <the label that machine saved this one under> --replace\` (\`oak machine list\` there shows the label; a key that machine kept for another folder is kept beside this one), or \`oak sync setup\` there.\n`;
}

/** `oak sync backup [<label> | --folder <path> | --none] [--json]`: where every machine's sessions are kept, besides the
 *  machine that made them: a saved machine, or an encrypted folder (its path on this machine). */
async function syncBackup(args: string[], deps: SyncCliDeps): Promise<void> {
  const folder = flagArg(args, '--folder', deps);
  const label = folder === undefined ? args.find((a) => !a.startsWith('-')) : undefined;
  const none = args.includes('--none');
  if (folder !== undefined) {
    const r = (await useFolder(folder, null, {}, deps))!;
    if (args.includes('--json')) {
      deps.emitJson({ syncBackup: core().syncSettings().backup, key: { fingerprint: r.fingerprint, made: r.madeKey } });
      return;
    }
    process.stdout.write(`backup: ${r.path} (an encrypted folder${r.created ? ', made now' : ''}; key ${r.fingerprint})\n`);
    if (r.madeKey) process.stdout.write(keyAdvice(deps));
    return;
  }
  if (!label && !none) {
    const b = core().syncSettings().backup;
    if (args.includes('--json')) deps.emitJson({ syncBackup: b });
    else process.stdout.write(b ? `${'label' in b ? b.label : b.path} (${b.kind})\n` : 'none set\n');
    return;
  }
  const sync = editSyncPrefs((s) => {
    if (none) delete s.backup;
    else s.backup = { kind: 'machine', label: label! };
  }, deps);
  if (args.includes('--json')) deps.emitJson({ syncBackup: sync?.backup ?? null });
  else process.stdout.write(none ? 'no backup set\n' : `backup: ${label}\n`);
}

/**
 * `oak sync key [--show | --import [--replace] | --from <machine> [--replace]] [--json]`: the backup folder's key here.
 * Bare, its fingerprint; `--show` prints the key itself, for a password manager; `--import` takes one from standard
 * input, or on a terminal at a prompt that shows nothing (never as an argument, which the shell's history and `ps`
 * keep), and `--from` copies one from a saved machine over ssh. A key that does not open the backup folder set here is
 * refused, and a different key here is only replaced with `--replace`.
 */
async function syncKey(args: string[], deps: SyncCliDeps): Promise<void> {
  const c = core();
  const json = args.includes('--json');
  const from = flagArg(args, '--from', deps);
  if (args.includes('--show')) {
    const key = keyOrNull(deps);
    if (!key) deps.fail('there is no backup key on this machine: `oak sync setup` makes one, or `oak sync key --from <machine>` copies one');
    process.stderr.write(`${deps.c.yellow('This is the key to your encrypted backup.')} Anyone who has it and the backup folder can read every session in it. Keep it in a password manager; never put it in the backup folder, a repository or a chat.\n`);
    if (json) deps.emitJson({ syncKey: { key: c.formatSyncKey(key), fingerprint: c.keyFingerprint(key) } });
    else process.stdout.write(`${c.formatSyncKey(key)}\n`);
    return;
  }
  if (args.includes('--import') || from !== undefined) {
    let src: Exclude<KeySource, null>;
    if (from !== undefined) src = { from };
    else {
      if (args.some((a) => !a.startsWith('-'))) {
        deps.fail('a key is not taken on the command line, where your shell\'s history and `ps` keep it: pass it on standard input (`oak sync key --import < file`), or run `oak sync key --import` on a terminal, which asks for it and shows nothing of what you paste');
      }
      src = { text: process.stdin.isTTY ? await askSecret('Paste the key (oak-sync-1:…), then press Enter: ') : await readStdin() };
    }
    const key = await keyFrom(src, deps);
    // Checked against the backup folder set here, when there is one: a key that does not open it is no key for it.
    const b = c.syncSettings().backup;
    if (b?.kind === 'folder') {
      const check = c.openBackupFolder(b.path, key);
      if (!check.ok && check.code === 'wrong-key') deps.fail(`that key does not open the backup folder set here (${c.backupFolderPath(b.path)}): it is another backup's key`);
    }
    let replaced: string | null = null;
    try {
      replaced = c.writeSyncKey(key, { replace: args.includes('--replace') }).replaced;
    } catch (e) {
      deps.fail(String((e as Error)?.message || e));
    }
    if (json) deps.emitJson({ syncKey: { present: true, fingerprint: c.keyFingerprint(key), path: c.syncKeyPath(), ...(replaced ? { replaced } : {}) } });
    else process.stdout.write(`${deps.c.green('kept')} the backup key ${c.keyFingerprint(key)} at ${c.syncKeyPath()}${replaced ? ` (the one it replaced is at ${replaced})` : ''}\n`);
    return;
  }
  const key = keyOrNull(deps);
  if (json) {
    deps.emitJson({ syncKey: key ? { present: true, fingerprint: c.keyFingerprint(key), path: c.syncKeyPath() } : { present: false } });
    return;
  }
  process.stdout.write(key ? `backup key ${c.keyFingerprint(key)}, kept at ${c.syncKeyPath()}\n` : `no backup key here. ${deps.c.dim('`oak sync setup` makes one for a backup folder; `oak sync key --from <machine>` copies one')}\n`);
}

/** Ask for a secret on the terminal, showing nothing of what is typed or pasted. */
function askSecret(question: string): Promise<string> {
  const rl = (require('readline') as typeof import('readline')).createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  let asked = false;
  out._writeToOutput = (str: string) => {
    if (!asked) {
      out.output.write(str);
      asked = true;
    }
  };
  return new Promise((resolve) => rl.question(question, (a) => {
    rl.close();
    process.stdout.write('\n');
    resolve(a.trim());
  }));
}

/** Ask one question on the terminal. */
function ask(question: string): Promise<string> {
  const rl = (require('readline') as typeof import('readline')).createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => {
    rl.close();
    resolve(a.trim());
  }));
}

/**
 * The backup folder's record under this machine's name (its host name and home folder): none yet, this machine's, or
 * one this machine has not written (a reinstall of the machine that wrote it, or another machine of the same name and
 * home), which no run restores from or writes until this machine takes it over. It is taken over with `--restore`, or
 * on a terminal when the person says this machine is a reinstall of the one that wrote it; the next run then restores.
 */
async function folderRecord(dir: string, restore: boolean, interactive: boolean, deps: SyncCliDeps): Promise<{ state: string; lastWrite?: string; claimed?: true }> {
  const c = core();
  const opened = c.openBackupFolder(dir);
  if (!opened.ok) return { state: 'none' };
  const host = c.machineHostTag();
  const owner = c.backupRecordOwner(opened.folder, host);
  if (owner.state === 'none' || owner.state === 'mine') return owner;
  let take = restore;
  if (!take && interactive) {
    process.stdout.write(`\n${dir} holds a record under this machine's name (its host name and home folder) that this machine has not written: ${owner.lastWrite}.\n`);
    take = /^y(es)?$/i.test(await ask('Is this machine a reinstall of that one (its sessions are then restored here, and it writes that record from now on)? [y/N] '));
  }
  if (!take) return owner;
  c.claimBackupRecord(opened.folder, host);
  return { ...owner, claimed: true };
}

/**
 * `oak sync setup`: choose where the sessions are backed up (none, a saved machine, or an encrypted folder whose path is
 * this machine's), make or bring the folder's key, and preview a first run (`plan`). On a terminal it asks; otherwise
 * `--none`, `--machine <label>` or `--folder <path>` say, with `--key-from <machine>` or `--import-key` (the key on
 * standard input) for a folder that holds a backup already, and `--restore` to take over the folder's record under
 * this machine's name, as a reinstall of the machine that wrote it.
 */
async function syncSetup(args: string[], deps: SyncCliDeps): Promise<void> {
  const c = core();
  const json = args.includes('--json');
  let choice: { kind: 'none' } | { kind: 'machine'; label: string } | { kind: 'folder'; path: string } | null = null;
  const machineFlag = flagArg(args, '--machine', deps);
  const folderFlag = flagArg(args, '--folder', deps);
  const keyFlag = flagArg(args, '--key-from', deps);
  if ([args.includes('--none'), machineFlag !== undefined, folderFlag !== undefined].filter(Boolean).length > 1) deps.fail('choose one of --none, --machine <label> and --folder <path>');
  if (args.includes('--restore') && (args.includes('--none') || machineFlag !== undefined)) deps.fail('`--restore` takes over a backup folder\'s record: give it with --folder <path>');
  if (args.includes('--none')) choice = { kind: 'none' };
  else if (machineFlag !== undefined) choice = { kind: 'machine', label: machineFlag };
  else if (folderFlag !== undefined) choice = { kind: 'folder', path: folderFlag };
  let src: KeySource = keyFlag !== undefined ? { from: keyFlag } : null;
  let replaceKey = args.includes('--replace');
  if (args.includes('--import-key')) src = { text: process.stdin.isTTY ? await askSecret('Paste the key (oak-sync-1:…), then press Enter: ') : await readStdin() };
  const bin = c.findHerdrBin();
  const saved = bin ? await c.herdrMachines({ binary: bin, timeoutMs: 15000 }).catch(() => []) : [];
  const interactive = !choice && !json && !!process.stdin.isTTY && !!process.stdout.isTTY;
  if (!choice && !interactive) deps.fail('usage: oak sync setup --none | --machine <label> | --folder <path> [--key-from <machine> | --import-key] [--restore] [--json] (or run it on a terminal, which asks)');
  const w = (t: string): boolean => process.stdout.write(t);
  if (interactive) {
    w(`${deps.c.bold('oak sync setup')}: where the agents' sessions are backed up. Memory, plans, skills, agents and commands go to every saved machine either way.\n\n`);
    w(`  1) nowhere else: each session stays on the machine that made it\n`);
    w(`  2) a saved machine, which keeps every machine's sessions${saved.length ? ` (${saved.map((m) => m.label).join(', ')})` : ': none is saved yet (`oak machine add`)'}\n`);
    w(`  3) a folder: a network share, a NAS or a disk, encrypted with a key only your machines hold\n\n`);
    const a = await ask('Choose 1, 2 or 3: ');
    if (a === '1') choice = { kind: 'none' };
    else if (a === '2') {
      if (!saved.length) deps.fail('no machine is saved here: `oak machine add <label> <ssh-target>` saves one');
      saved.forEach((m, i) => w(`  ${i + 1}) ${m.label} (${m.target})\n`));
      const n = Number(await ask('Which machine? '));
      const m = saved[n - 1];
      if (!m) deps.fail('no such machine');
      choice = { kind: 'machine', label: m.label };
    } else if (a === '3') {
      const p = await ask('The folder\'s path on this machine: ');
      if (!p) deps.fail('no folder given');
      choice = { kind: 'folder', path: p };
      const dir = c.backupFolderPath(p);
      const fs = require('fs') as typeof import('fs');
      const key = keyOrNull(deps);
      const holds = fs.existsSync(require('path').join(dir, 'oak-backup'));
      if (holds && (!key || !c.openBackupFolder(dir, key).ok)) {
        w(`${dir} holds a backup made with a key this machine ${key ? 'does not have' : 'lacks'}.\n`);
        saved.forEach((m, i) => w(`  ${i + 1}) copy it from ${m.label}\n`));
        w(`  p) paste it (from \`oak sync key --show\` on a machine that has it)\n`);
        const k = await ask('Where from? ');
        if (k === 'p') src = { text: await askSecret('The key (it is not shown as you paste it): ') };
        else if (saved[Number(k) - 1]) src = { from: saved[Number(k) - 1].label };
        else deps.fail('no key given');
        // Brought over this machine's own key (made for another folder), it replaces it once the reader says so; the old
        // one is kept beside it, since a backup sealed under it opens with nothing else.
        if (key && !replaceKey) {
          const yes = await ask(`This machine keeps another backup key (${c.keyFingerprint(key)}). Replace it with the folder's? The old one is kept beside it. [y/N] `);
          if (!/^y/i.test(yes)) deps.fail(`nothing changed: this machine keeps its backup key ${c.keyFingerprint(key)}, which does not open ${dir}`);
          replaceKey = true;
        }
      }
    } else deps.fail('no choice made');
  }
  let keyOut: { fingerprint: string; made: boolean; imported: boolean } | null = null;
  let record: Awaited<ReturnType<typeof folderRecord>> | null = null;
  if (choice!.kind === 'folder') {
    const r = await useFolder(choice!.path, src, { replace: replaceKey, json }, deps);
    if (!r) return;
    keyOut = { fingerprint: r.fingerprint, made: r.madeKey, imported: r.importedKey };
    record = await folderRecord(r.path, args.includes('--restore'), interactive, deps);
  } else {
    if (src) {
      // A key asked for with another backup: kept for a folder chosen later.
      const key = await keyFrom(src, deps);
      try {
        c.writeSyncKey(key, { replace: args.includes('--replace') });
      } catch (e) {
        deps.fail(String((e as Error)?.message || e));
      }
      keyOut = { fingerprint: c.keyFingerprint(key), made: false, imported: true };
    }
    const ch = choice!;
    editSyncPrefs((s) => {
      if (ch.kind === 'none') delete s.backup;
      else if (ch.kind === 'machine') s.backup = { kind: 'machine', label: ch.label };
    }, deps);
  }
  editSyncPrefs((s) => {
    s.setupAt = Date.now();
  }, deps);
  // A first plan: what a run would do now, copying nothing.
  let plan: SyncPlan | null = null;
  let planError: string | null = null;
  try {
    const r = await planRun([], deps);
    plan = r.plan;
    if (r.backupError) planError = r.backupError;
  } catch (e) {
    planError = String((e as Error)?.message || e);
  }
  // A backup machine that is neither saved here nor this machine (a typo) is said in the preview, as a run says it.
  const chosen = choice!;
  if (plan && chosen.kind === 'machine' && !saved.some((m) => c.plainLabel(m.label) === chosen.label) && !c.namesThisMachine(chosen.label)) {
    plan.machines[0].warnings?.push(`the backup "${chosen.label}" is no saved machine here and not this machine's name, so no machine keeps every session`);
  }
  if (json) {
    deps.emitJson({ syncSetup: 1, backup: c.syncSettings().backup ?? null, key: keyOut, ...(record ? { record } : {}), plan, ...(planError ? { planError } : {}) });
    return;
  }
  const b = c.syncSettings().backup;
  w(`\n${deps.c.green('set up:')} ${b ? (b.kind === 'machine' ? `the backup is ${b.label}` : `the backup is the encrypted folder ${b.path} (key ${keyOut?.fingerprint ?? c.keyFingerprint(c.readSyncKey()!)})`) : 'no backup: each session stays on the machine that made it'}\n`);
  if (keyOut?.made) w(keyAdvice(deps));
  if (keyOut?.imported) w(`the backup key ${keyOut.fingerprint} is kept here now\n`);
  const refused = !record?.claimed && (record?.state === 'unclaimed' || record?.state === 'other');
  if (record?.claimed) w(`this machine took over the folder's record under its name (${record.lastWrite}): the next run restores its sessions from it\n`);
  else if (refused) {
    w(`${deps.c.yellow('the folder holds a record under this machine\'s name (its host name and home folder) that this machine has not written:')} ${record!.lastWrite}. If this machine is a reinstall of that one, \`oak sync setup --folder ${b && b.kind === 'folder' ? b.path : '<path>'} --restore\` takes it over and restores from it; if it is another machine, give it another host name. Until then nothing is restored from the folder or written to it.\n`);
  }
  // A plan made without the backup folder says why among its warnings, as `oak sync plan` does, unless the line above said
  // all of it: a record this machine never wrote. Another machine's writer, or a copy of this one's, is said in the plan.
  // Only a plan that could not be made at all is said to be missing.
  if (planError && !plan) w(`${deps.c.yellow('the first plan could not be made:')} ${planError}\n`);
  else if (planError && !(refused && record?.state === 'unclaimed')) plan?.machines[0].warnings?.push(`the backup folder cannot be used: ${planError}`);
  if (plan) {
    w('\n');
    printPlan(plan, deps);
  }
  // The background runs start once a run has had a saved machine or a backup folder to sync with (sync-engine.ts).
  w(`\n${deps.c.dim(saved.length || b?.kind === 'folder'
    ? '`oak sync now` runs it; after that, the capture hooks keep it running in the background.'
    : 'nothing is set up to sync with yet: no machine is saved here (`oak machine add <label> <ssh-target>` saves one) and no backup folder is set.')}\n`);
}

/** `oak sync family <family> <everywhere|backup|on-demand|off> [--json]`: where one family's files are kept here. */
function syncFamilyPlacement(args: string[], deps: SyncCliDeps): void {
  const [id, placement] = args.filter((a) => !a.startsWith('-'));
  const c = core();
  const fam = id ? c.syncFamily(id) : undefined;
  if (!fam) deps.fail(`usage: oak sync family <${c.syncFamilies().map((f) => f.id).join('|')}> <${c.SYNC_PLACEMENTS.join('|')}>`);
  if (!(c.SYNC_PLACEMENTS as readonly string[]).includes(placement)) deps.fail(`a placement is one of ${c.SYNC_PLACEMENTS.join(', ')}`);
  if (fam.strategy === 'text' && placement !== 'everywhere' && placement !== 'off') deps.fail(`${fam.id} is text the agents read here: everywhere or off`);
  const sync = editSyncPrefs((s) => {
    const families: Record<string, SyncPlacementPref> = { ...(s.families ?? {}), [fam.id]: placement as SyncPlacementPref };
    if (placement === fam.placement) delete families[fam.id];
    s.families = families;
  }, deps);
  if (args.includes('--json')) deps.emitJson({ syncFamilies: sync?.families ?? {} });
  else process.stdout.write(`${fam.id}: ${placement}\n`);
}

const USAGE = 'usage: oak sync setup|plan|now|status|fetch <session>|resolve <conflict>|include <x>|exclude <x>|backup <label>|backup --folder <path>|key|family <family> <placement> [--machine <label>] [--json]';

/** `oak sync <…>`: the verb's dispatch. Ctrl+c, a hangup or a deadline's SIGTERM stops every ssh it started. */
export async function cmdSync(args: string[], deps: SyncCliDeps): Promise<void> {
  for (const [sig, n] of deps.stopSignals) {
    process.once(sig, () => {
      for (const child of running) child.kill();
      deps.endBySignal(sig, n);
    });
  }
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'plan': return syncPlan(rest, deps);
    case 'now': return syncNow(rest, deps);
    case 'status': return syncStatus(rest, deps);
    case 'fetch': return syncFetch(rest, deps);
    case 'resolve': return syncResolve(rest, deps);
    case 'include': return syncSelect(true, rest, deps);
    case 'exclude': return syncSelect(false, rest, deps);
    case 'backup': return syncBackup(rest, deps);
    case 'key': return syncKey(rest, deps);
    case 'setup': return syncSetup(rest, deps);
    case 'family': return syncFamilyPlacement(rest, deps);
    default: deps.fail(USAGE);
  }
}

/** `oak __sync-inventory --json [--publish] --user <name>`: what a machine's `oak sync` reads from this one (hidden). The
 *  user is compared before anything is read; a machine under another account answers that it is shared, and nothing
 *  else. `--publish` (another machine's `oak sync now`): this machine's session deletes are recorded (core
 *  recordSessionDeletes, as a run here records them: a machine that runs none of its own passes them on all the same) and
 *  its index is caught up, within a bounded time (core publishRecords), so its record log holds what it has done before
 *  the inventory lists it. */
export function cmdSyncInventory(args: string[], deps: SyncCliDeps): void {
  const at = args.indexOf('--user');
  const user = at >= 0 ? args[at + 1] : undefined;
  if (!user || user.startsWith('--')) deps.fail('__sync-inventory needs --user <name>');
  if (args.includes('--publish') && core().localUserName() === user) {
    core().recordSessionDeletes();
    core().publishRecords();
  }
  deps.emitJson(core().syncInventory({ user }));
}

/** `oak __sync-fetch --user <name>`: the files another machine's `oak sync` asks for, the request on stdin (hidden).
 *  Only reads, and refuses another account's caller before reading anything but the request. */
export async function cmdSyncFetch(args: string[], deps: SyncCliDeps): Promise<void> {
  const at = args.indexOf('--user');
  const user = at >= 0 ? args[at + 1] : undefined;
  if (!user || user.startsWith('--')) deps.fail('__sync-fetch needs --user <name>');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024 * 1024) deps.fail('the fetch request is larger than 64 MB');
    chunks.push(chunk as Buffer);
  }
  const write = (b: Buffer): Promise<void> => new Promise((resolve) => {
    if (process.stdout.write(b)) resolve();
    else process.stdout.once('drain', () => resolve());
  });
  await core().serveSyncFetch(Buffer.concat(chunks).toString('utf8'), user, write);
}

/** `oak __sync-key --user <name>`: this machine's backup key, for another of the user's machines that runs `oak sync
 *  key --from` (hidden). The user is compared first, as the inventory does: another account gets `{"shared":true}`. */
export function cmdSyncKey(args: string[], deps: SyncCliDeps): void {
  const at = args.indexOf('--user');
  const user = at >= 0 ? args[at + 1] : undefined;
  if (!user || user.startsWith('--')) deps.fail('__sync-key needs --user <name>');
  const c = core();
  const me = c.localUserName();
  if (!me || me !== user) {
    deps.emitJson({ shared: true });
    return;
  }
  let key: Buffer | null;
  try {
    key = c.readSyncKey();
  } catch (e) {
    deps.fail(String((e as Error)?.message || e));
  }
  deps.emitJson({ syncKey: 1, key: key ? c.formatSyncKey(key) : null });
}
