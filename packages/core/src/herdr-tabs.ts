/**
 * Keep herdr's own tabs tidy from OAK: a `btop` tab kept running a system monitor in each machine's
 * `home` workspace, and every other tab named by the session its pane runs — but never a tab the user
 * renamed themselves.
 *
 * The decision is a PURE function (`reconcileHerdrTabs`) over a herdr snapshot; the driver runs the
 * actions over the socket (local) or the CLI (a saved machine) and persists which labels OAK owns, so
 * it can tell its own naming from the user's. Everything here is best-effort: a tidy tab bar is never
 * worth blocking or crashing the dashboard for. OAK never closes a tab, and it types only into the
 * monitor's own pane while its shell is idle at the prompt. At every server start, before any OAK runs,
 * OAK's herdr plugin restarts the monitor by the same rule (`packages/herdr-plugin/herdr-startup.py`).
 */
import * as fs from 'fs';
import * as path from 'path';
import { rootDir } from './store';
import { snapshotFromCli, type HerdrOptions, type HerdrTransport } from './herdr';
import { readHerdrPaneLink } from './herdr-link';
import { listedSessionTitle } from './observe';
import type { PaneProcessInfo, SessionSnapshot } from './herdr-api';

/** The monitor's tab, and the monitor's pane inside it: herdr keeps a pane's label across restarts and
 *  a split leaves it on the original pane, so a person's own pane in that tab is never taken for it. */
export const BTOP_LABEL = 'btop';
/** The workspace the btop tab belongs in (matched case-insensitively); a machine without one uses its
 *  first workspace. */
export const HOME_WORKSPACE = 'home';

/**
 * Launch a system monitor in a herdr pane's OWN shell, alias-safe. herdr's `tab.create` ignores a
 * `command` (verified against 0.9.1 — the pane just stays a shell), so OAK makes the tab, then execs
 * a monitor into it. `command -v btop` prints an ALIAS definition (e.g. `btop=bpytop`), not a path,
 * when btop is aliased, so we take the first line that is an absolute path and skip the alias — then
 * `exec` replaces the shell so the monitor owns the pane. If none is installed the shell is left as-is
 * rather than exec-ing a non-existent command. Runs the same in the local (socket) and remote (CLI)
 * paths, resolved in the pane's interactive shell where the user's full PATH lives. The plugin's
 * `herdr-startup.py` sends the same line; a test keeps the two identical.
 */
export const MONITOR_LAUNCH = 'm=$({ command -v btop; command -v bpytop; command -v htop; } 2>/dev/null | grep -m1 "^/"); [ -n "$m" ] && exec "$m"\n';

/** The system monitor to run in the `btop` tab: btop if present, else the common fallbacks. Null when
 *  none is installed — then no monitor tab is created rather than a tab whose command 127s on exec. */
export function resolveMonitor(env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const name of ['btop', 'bpytop', 'htop']) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
    }
  }
  return null;
}

/** Shells whose syntax MONITOR_LAUNCH is written in. */
const POSIX_SHELLS = new Set(['sh', 'ash', 'bash', 'dash', 'ksh', 'mksh', 'zsh']);

/**
 * What holds a pane's terminal, from herdr's `pane.process_info` — the signal herdr's own `agent start`
 * checks before it types into a pane:
 *  - `idle`: the shell itself holds the foreground and runs no command; the only state OAK types into;
 *  - `replaced`: the shell's own process now runs something else (`exec`: OAK's monitor, or whatever a
 *    person exec'd; on macOS a Python monitor reports as `python3.x`), which lasts as long as the terminal;
 *  - `busy`: anything else, including a command the shell is running and missing information.
 */
export function paneForeground(info: PaneProcessInfo | null | undefined): 'idle' | 'replaced' | 'busy' {
  const shell = info?.shell_pid;
  const procs = info?.foreground_processes ?? [];
  if (shell == null || info?.foreground_process_group_id !== shell || !procs.length || procs.some(p => p.pid !== shell)) return 'busy';
  return POSIX_SHELLS.has(path.basename(String(procs[0].name ?? '')).replace(/^-/, '')) ? 'idle' : 'replaced';
}

type WorkspaceLike = { workspace_id: string; label?: string | null };
type TabLike = { tab_id: string; workspace_id: string; number: number; label: string };
type PaneLike = { pane_id: string; tab_id: string; agent?: string | null; label?: string | null; terminal_title_stripped?: string | null };
type AgentLike = { pane_id?: string; agent?: string | null; agent_session?: { value?: string | null } | null };

export interface HerdrTabAction {
  kind: 'create-btop' | 'adopt-monitor' | 'launch-monitor' | 'rename';
  /** create-btop, adopt-monitor (made instead when the pane is not the monitor's) */ workspace_id?: string;
  /** adopt-monitor / launch-monitor / rename */ tab_id?: string;
  /** adopt-monitor / launch-monitor: the monitor's pane — typed into only while its shell is idle */ pane_id?: string;
  label: string;
}

/**
 * @param owned  the label OAK last wrote per tab id — a tab is OAK's to (re)name only while its label
 *               is still a placeholder (herdr's generated position number, an agent kind, `btop` on a
 *               tab an agent took over, or the agent's own terminal title), the exact value OAK last
 *               set, or already its session's name. Anything else is the user's choice and is left alone.
 * @param opts.btop  false leaves the btop tab alone on this machine (the local server has no monitor).
 * @param opts.claimedAt  when the title each claim in `owned` names was read (a claim may have none).
 * @param opts.listedAt  when the titles `titleOf` gives were read. A tab whose claim names a title read
 *               after that is left as it is: the list is older than what the tab wears.
 * @returns the actions to take and the NEW `owned` map to persist (tabs no longer OAK's drop out).
 */
export function reconcileHerdrTabs(
  snapshot: { workspaces?: WorkspaceLike[]; tabs?: TabLike[]; panes?: PaneLike[]; agents?: AgentLike[] },
  titleOf: (session: string) => string | null | undefined,
  owned: Record<string, string>,
  opts: { btop?: boolean; claimedAt?: Record<string, number>; listedAt?: number } = {},
): { actions: HerdrTabAction[]; owned: Record<string, string> } {
  const tabs = snapshot.tabs ?? [];
  const panes = snapshot.panes ?? [];
  const actions: HerdrTabAction[] = [];
  const nextOwned: Record<string, string> = {};

  // Each pane's agent (herdr's detection or a joined agent; '' when the kind is unknown) and session.
  const agentByPane = new Map<string, string>();
  for (const p of panes) if (p.agent) agentByPane.set(p.pane_id, p.agent);
  const sessionByPane = new Map<string, string>();
  for (const a of snapshot.agents ?? []) {
    if (!a.pane_id) continue;
    if (!agentByPane.has(a.pane_id)) agentByPane.set(a.pane_id, a.agent ?? '');
    if (a.agent_session?.value) sessionByPane.set(a.pane_id, a.agent_session.value);
  }
  // herdr's own label for an unnamed tab is its position among its workspace's tabs (snapshot order).
  const position = new Map<string, number>();
  const count = new Map<string, number>();
  for (const t of tabs) { count.set(t.workspace_id, (count.get(t.workspace_id) ?? 0) + 1); position.set(t.tab_id, count.get(t.workspace_id)!); }
  const panesByTab = new Map<string, string[]>();
  for (const p of panes) panesByTab.set(p.tab_id, [...(panesByTab.get(p.tab_id) ?? []), p.pane_id]);
  const agentOf = (tab: TabLike): string | undefined => panesByTab.get(tab.tab_id)?.map(p => agentByPane.get(p)).find(a => a !== undefined);
  const sessionOf = (tab: TabLike): string | undefined => panesByTab.get(tab.tab_id)?.map(p => sessionByPane.get(p)).find(Boolean);
  // The agent's own name for its session: the terminal title of the pane that holds it (Claude Code
  // titles its terminal with its ai-title). A tab labelled with it was named by OAK before a better
  // title arrived, and OAK's record of that can be lost; no person chose it (the
  // tab kept the ai-title while the status line and the Claude app showed claude.ai's title).
  const terminalTitle = new Map<string, string>();
  for (const p of panes) { const t = p.terminal_title_stripped?.trim(); if (t) terminalTitle.set(p.pane_id, t); }
  const agentTitleOf = (tab: TabLike): string | undefined => {
    const pane = panesByTab.get(tab.tab_id)?.find(p => sessionByPane.has(p));
    return pane ? terminalTitle.get(pane) : undefined;
  };
  // The monitor runs in the pane labelled `btop` (BTOP_LABEL). An agent in that pane, or in any pane of
  // a `btop` tab without one, has taken the tab over.
  const monitorOf = (tab: TabLike): string | undefined => panes.find(p => p.tab_id === tab.tab_id && p.label === BTOP_LABEL)?.pane_id;
  const takenBy = (tab: TabLike): string | undefined => { const m = monitorOf(tab); return m ? agentByPane.get(m) : agentOf(tab); };

  // The monitor's tab is the first `btop` tab in the home workspace whose monitor pane no agent holds.
  // Missing — never created, closed, or its monitor quit (the pane closes with it) — it is made again
  // on every pass; present, the driver starts the monitor in it if its shell sits idle. A `btop` tab
  // from before OAK labelled the monitor's pane is adopted when its one pane visibly runs the monitor.
  if (opts.btop !== false) {
    const workspaces = snapshot.workspaces ?? [];
    const home = (workspaces.find(w => w.label?.trim().toLowerCase() === HOME_WORKSPACE) ?? workspaces[0])?.workspace_id ?? tabs[0]?.workspace_id;
    const btops = tabs.filter(t => t.workspace_id === home && t.label === BTOP_LABEL && takenBy(t) === undefined);
    const live = btops.find(t => monitorOf(t));
    const unlabelled = btops.find(t => !monitorOf(t) && panesByTab.get(t.tab_id)?.length === 1);
    if (live) actions.push({ kind: 'launch-monitor', tab_id: live.tab_id, pane_id: monitorOf(live)!, label: BTOP_LABEL });
    else if (unlabelled) actions.push({ kind: 'adopt-monitor', workspace_id: home, tab_id: unlabelled.tab_id, pane_id: panesByTab.get(unlabelled.tab_id)![0], label: BTOP_LABEL });
    else if (home) actions.push({ kind: 'create-btop', workspace_id: home, label: BTOP_LABEL });
  }

  for (const tab of tabs) {
    const btop = tab.label === BTOP_LABEL;
    const agent = btop ? takenBy(tab) : undefined;
    if (btop && agent === undefined) continue; // a monitor's tab keeps its name
    // A tab OAK named stays OAK's while it still wears that name — even while its pane has no session
    // or a session with no title yet (an agent just restarted there). Dropping the claim in that gap
    // left the tab wearing the old session's title forever. A placeholder
    // keeps the claim too: nobody chose it, and it is what a snapshot taken before OAK's own rename
    // shows. The terminal app's pass over such a snapshot, for a session its list did not show yet,
    // dropped the claim that session's own sync had just made, and the tab kept its first name.
    const placeholder = isPlaceholderLabel(tab.label, position.get(tab.tab_id));
    if (owned[tab.tab_id] !== undefined && (owned[tab.tab_id] === tab.label || placeholder)) nextOwned[tab.tab_id] = owned[tab.tab_id];
    // A claim made from a title newer than this pass's list (a session's own sync renamed the tab after
    // the terminal app last read its list) is left as it is until the list catches up: renaming by the
    // older list put the old title back until the list refreshed.
    if (nextOwned[tab.tab_id] !== undefined && opts.listedAt !== undefined && (opts.claimedAt?.[tab.tab_id] ?? -Infinity) > opts.listedAt) continue;
    const sid = sessionOf(tab);
    // An agent took over a btop tab: its kind names the tab until the session has a title, so it never
    // passes for the monitor's tab (and is never typed into as one).
    const name = (sid ? titleOf(sid)?.trim() : undefined) || (btop ? agent : undefined);
    if (!name) continue;
    // A label that already reads the session's name is OAK's too: another OAK named it, or a rename that
    // reported failure landed after all.
    if (btop || tab.label === name || owned[tab.tab_id] === tab.label || placeholder
      || tab.label.trim() === agentTitleOf(tab)) {
      if (tab.label !== name) actions.push({ kind: 'rename', tab_id: tab.tab_id, label: name });
      nextOwned[tab.tab_id] = name;
    }
  }
  return { actions, owned: nextOwned };
}

/** Tab labels that name an agent kind rather than a session — placeholders OAK replaces with the title. */
const AGENT_KIND_LABELS = new Set(['claude', 'codex', 'gpt', 'agent']);

/**
 * A label nobody chose. herdr names an unnamed tab by its POSITION in the workspace and renumbers it as
 * tabs close and move (herdr 0.9.1), so its label is the tab's position, not its `number` (its id
 * ordinal): tab #8 in second place read `2` and was never renamed (2026-09-24). A number that is not
 * the position (`2024`) is a name somebody chose. `oak agent start` labels the tab it opens with the
 * agent KIND until the session has a title, and a person typing `claude` into a tab and naming it so
 * wants the same thing.
 */
function isPlaceholderLabel(label: string, position: number | undefined): boolean {
  return label === String(position) || AGENT_KIND_LABELS.has(label.trim().toLowerCase());
}

const sidecar = (): string => path.join(rootDir(), 'herdr-tabs.json');
/** When the title each claim names was read, per machine and tab, in a file of its own beside the record
 *  (written under the record's lock). The record keeps its format, so an OAK from before claims carried a
 *  time still reads and keeps every claim: given `{label, at}` in the record, it read no claim at all and
 *  renamed nothing. A time only ever holds a pass back, and one such an OAK left behind belongs to an
 *  older claim of the tab, so it holds back less, never wrongly. */
const claimTimes = (): string => path.join(rootDir(), 'herdr-tabs.at.json');
const mapOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
function readRecord(file: string): Record<string, unknown> {
  try { return mapOf(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return {}; }
}
type Claims = { owned: Record<string, string>; at: Record<string, number> };
function loadOwned(machine: string): Claims {
  const claims: Claims = { owned: {}, at: {} };
  for (const [tab, label] of Object.entries(mapOf(readRecord(sidecar())[machine]))) if (typeof label === 'string') claims.owned[tab] = label;
  if (!Object.keys(claims.owned).length) return claims;
  // A time still ahead of the clock was taken before the clock was set back: it holds nothing back.
  const now = Date.now();
  for (const [tab, at] of Object.entries(mapOf(readRecord(claimTimes())[machine]))) {
    if (typeof at === 'number' && at <= now && claims.owned[tab] !== undefined) claims.at[tab] = at;
  }
  return claims;
}
/** Write `value` to `file` whole: a reader sees the old content or the new, never a torn file. */
function replaceFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}
/** The longest wait for another process's hold on the ownership record: a hold lasts one read and one
 *  write, so a longer one is a holder that is stuck, and the record is written through it. */
const OWNED_LOCK_MS = 2000;
/**
 * Record the claims this pass changed on one machine, and no others. The terminal app's pass (one per
 * machine) and each session's own sync (`syncSessionTab`) write this file, every one from what it read
 * when it began: writing a machine's whole map back erased the claims the others made meanwhile, and a
 * lost claim left its tab stuck on an old OAK-given title. So the file is read again under its lock and
 * only the tabs whose claim moved from `before` to `after` are written, of `tabs` alone when the pass
 * speaks for no others. A claim written carries `at`, when the title it names was read; none when the
 * pass could not say.
 */
async function saveOwned(machine: string, before: Record<string, string>, after: Record<string, string>, tabs?: string[], at?: number): Promise<void> {
  const has = (map: Record<string, string>, tab: string): boolean => Object.prototype.hasOwnProperty.call(map, tab);
  const changed = (tabs ?? [...new Set([...Object.keys(before), ...Object.keys(after)])])
    .filter(tab => has(before, tab) !== has(after, tab) || before[tab] !== after[tab]);
  if (!changed.length) return;
  const write = (): true => {
    const all = readRecord(sidecar());
    const mine = { ...mapOf(all[machine]) };
    const allTimes = readRecord(claimTimes());
    const held = JSON.stringify(allTimes[machine] ?? null);
    const times = { ...mapOf(allTimes[machine]) };
    for (const tab of changed) {
      if (has(after, tab)) mine[tab] = after[tab];
      else delete mine[tab];
      if (has(after, tab) && at !== undefined) times[tab] = at;
      else delete times[tab];
    }
    for (const tab of Object.keys(times)) if (typeof mine[tab] !== 'string') delete times[tab];
    all[machine] = mine;
    if (Object.keys(times).length) allTimes[machine] = times;
    else delete allTimes[machine];
    // The times first: a pass that reads between the two writes then sees a new claim only with its new
    // time. The other way round it saw the new claim with the old time, and put the old title back.
    if (JSON.stringify(allTimes[machine] ?? null) !== held) replaceFile(claimTimes(), allTimes);
    replaceFile(sidecar(), all);
    return true;
  };
  try { if (await withStoreLock(`${sidecar()}.lock`, OWNED_LOCK_MS, write) === undefined) write(); }
  catch { /* a tidy tab bar is never worth failing a refresh */ }
}

/** When OAK last made a machine's btop tab: a monitor that dies at start (a broken install) closes its
 *  tab again at once, so the tab is made at most once per `recreateMs`. */
const lastCreated = new Map<string, number>();
/** Machines with a pass in flight: the TUI starts one per herdr event and per remote poll, and two at
 *  once could both find the btop shell idle and both type the launch line — the second into the monitor. */
const inflight = new Set<string>();
/** `${machine}\n${pane}` → the terminal OAK typed the launch line into, or found the shell replaced in:
 *  never checked or typed into again. herdr gives a restored pane a new terminal id, which re-arms it. */
const settledMonitor = new Map<string, string>();
/** `${machine}\n${tab}\n${terminal}` → when this OAK first saw that `btop` tab's one unlabelled pane NOT
 *  running the monitor. That is also how another OAK's tab looks between its `tab.create` and the
 *  `pane.rename` that labels it — seconds on a saved machine — so it is taken for a person's only after
 *  `recreateMs` (see `tidy`). */
const unlabelledSince = new Map<string, number>();
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Hold this store's lock on making a machine's btop tab while `action` runs; undefined when another OAK
 * process here held it throughout. Two OAKs reconciling one server — two terminals here, or this one and
 * `oak attach`'s — each made a btop tab from the same snapshot, and OAK never closes one.
 */
function withCreateLock<T>(machineKey: string, waitMs: number, action: () => Promise<T>): Promise<T | undefined> {
  return withStoreLock(path.join(rootDir(), `herdr-btop.${machineKey.replace(/[^A-Za-z0-9_.-]/g, '_')}.lock`), waitMs, action);
}

/** Hold the lock file `file` in this store while `action` runs; undefined when another OAK process held
 *  it throughout `waitMs`. A holder that died, or one older than any holder here takes, gives it up. */
async function withStoreLock<T>(file: string, waitMs: number, action: () => Promise<T> | T): Promise<T | undefined> {
  const token = `${process.pid}:${Math.random()}`;
  for (const until = Date.now() + waitMs; ;) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, token, { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      // Only a lock another pass holds is waited for. A store that refuses the file itself (full,
      // read-only) runs the action unlocked, as before the lock existed: retrying it never yielded, and
      // froze the TUI.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return action();
      let stale = false;
      try {
        const owner = fs.readFileSync(file, 'utf8');
        const pid = Number(owner.split(':')[0]);
        // An empty file is a lock its holder is writing right now, not a dead one.
        stale = Date.now() - fs.statSync(file).mtimeMs > 30000 || (owner !== '' && (!Number.isSafeInteger(pid) || pid <= 0 || !alive(pid)));
      } catch { /* released meanwhile, or unreadable: wait as for a held lock */ }
      if (stale) { try { fs.unlinkSync(file); continue; } catch { /* taken meanwhile, or it cannot go: wait */ } }
      if (Date.now() >= until) return undefined;
      await sleep(100);
    }
  }
  try { return await action(); }
  finally { try { if (fs.readFileSync(file, 'utf8') === token) fs.unlinkSync(file); } catch { /* gone */ } }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** The herdr verbs a pass needs, over the socket (local) or the CLI (a saved machine) — the caller's
 *  transport, never this module's own import: a test that ran the pass with a fake core otherwise sent
 *  these verbs to whatever server HERDR_SOCKET_PATH named, and made btop tabs on a person's live one. */
function herdrCalls(machine: string | undefined, options: HerdrOptions | undefined, { herdrRequest, herdrOnMachine }: HerdrTransport) {
  if (machine) {
    const cli = (argv: string[]) => herdrOnMachine(machine, argv, options) as Promise<{ result?: Record<string, unknown> } | null>;
    return {
      snapshot: async () => snapshotFromCli(await herdrOnMachine(machine, ['api', 'snapshot'], options), options),
      processInfo: async (pane: string) => (await cli(['pane', 'process-info', '--pane', pane]))?.result?.process_info as PaneProcessInfo | undefined,
      sendText: (pane: string, text: string) => cli(['pane', 'send-text', pane, text]),
      labelPane: (pane: string, label: string) => cli(['pane', 'rename', pane, label]),
      createBtop: async (workspace: string) => (await cli(['tab', 'create', '--workspace', workspace, '--label', BTOP_LABEL]))?.result as TabCreated | undefined,
      moveFirst: async (_tab: string) => { /* herdr's CLI has no `tab move`: a saved machine's btop keeps its place */ },
      rename: (tab: string, label: string) => cli(['tab', 'rename', tab, label]),
    };
  }
  return {
    snapshot: async () => snapshotFromCli((await herdrRequest('session.snapshot', {}, options)).snapshot, options),
    processInfo: async (pane: string) => (await herdrRequest('pane.process_info', { pane_id: pane }, options)).process_info,
    sendText: (pane: string, text: string) => herdrRequest('pane.send_text', { pane_id: pane, text }, options),
    labelPane: (pane: string, label: string) => herdrRequest('pane.rename', { pane_id: pane, label }, options),
    createBtop: (workspace: string) => herdrRequest('tab.create', { workspace_id: workspace, label: BTOP_LABEL }, options) as Promise<TabCreated>,
    // btop is the FIRST tab; move the new tab to the front (best-effort).
    moveFirst: (tab: string) => herdrRequest('tab.move', { tab_id: tab, insert_index: 0 }, options).then(() => {}, () => {}),
    rename: (tab: string, label: string) => herdrRequest('tab.rename', { tab_id: tab, label }, options),
  };
}
type TabCreated = { tab?: { tab_id?: string }; root_pane?: { pane_id?: string; terminal_id?: string } };

/**
 * Reconcile one machine's herdr tabs. `machine` undefined = the local server (socket); a label = a
 * saved machine (CLI over ssh). Best-effort throughout; returns the actions carried out (a
 * `launch-monitor` only when the launch line was typed).
 */
export async function ensureHerdrTabs(opts: {
  machine?: string;
  titleOf: (session: string) => string | null | undefined;
  /** The resolved local monitor binary (see `resolveMonitor`); null/undefined skips btop on the LOCAL
   *  server. A saved machine resolves its own monitor over its shell, so this is not consulted there. */
  monitor?: string | null;
  /** The machine's snapshot, as the caller just read it. */
  snapshot: SessionSnapshot;
  /** Every verb goes through this: the caller's own herdr transport (the core module, or its fake). */
  transport: HerdrTransport;
  herdrOptions?: HerdrOptions;
  /** How long a new btop tab's shell may take to reach its prompt, how long an existing btop shell must
   *  stay idle before OAK types into it (herdr's startup hook or another OAK may be starting the monitor
   *  at that moment), the poll interval, the least time between two btop tabs made on one machine (and
   *  how long a `btop` tab whose one pane is unlabelled and not the monitor is taken for another OAK's,
   *  still being made), and the longest wait for another OAK's create lock — in milliseconds. */
  timing?: { readyMs?: number; confirmMs?: number; pollMs?: number; recreateMs?: number; lockMs?: number };
  /** One tab: the pass names that tab, by the same rules, and leaves btop and every other tab alone
   *  (`syncSessionTab`). */
  only?: string;
  /** When the titles `titleOf` gives were read (the start of the read that listed them): a tab whose
   *  claim names a title read later is left alone, and the claims this pass makes carry this time. */
  listedAt?: number;
  /** False: the pass names no session's tab and keeps no record of names on this machine, because that
   *  machine's own OAK names them (the terminal app asks it to). btop is kept as ever. */
  names?: boolean;
  /** With `only`: the name the terminal app on another machine recorded giving that tab, before this
   *  machine named its own tabs. While the tab still wears it, it is OAK's here, and this record takes it on. */
  adopt?: string;
}): Promise<HerdrTabAction[]> {
  const machineKey = opts.machine ?? 'local';
  if (inflight.has(machineKey)) return [];
  inflight.add(machineKey);
  try { return await tidy(opts, machineKey); }
  finally { inflight.delete(machineKey); }
}

async function tidy(opts: Parameters<typeof ensureHerdrTabs>[0], machineKey: string): Promise<HerdrTabAction[]> {
  const snapshot = opts.snapshot;
  // On the local server, only manage btop when a monitor actually exists; a saved machine falls back
  // over its own shell (MONITOR_LAUNCH leaves the shell as-is when none is installed).
  const btop = opts.only === undefined && (opts.machine ? true : !!opts.monitor);
  const names = opts.names !== false;
  const { owned, at: claimedAt } = names ? loadOwned(machineKey) : { owned: {}, at: {} };
  // `adopt` holds while the tab wears it, over a claim of this record's own, which the app's rename followed.
  const adopted = opts.adopt !== undefined && opts.only !== undefined && snapshot.tabs.find(t => t.tab_id === opts.only)?.label === opts.adopt
    ? { [opts.only]: opts.adopt } : {};
  const { actions, owned: nextOwned } = reconcileHerdrTabs(
    snapshot as unknown as Parameters<typeof reconcileHerdrTabs>[0], names ? opts.titleOf : () => undefined, { ...owned, ...adopted },
    { btop, claimedAt, listedAt: opts.listedAt },
  );
  const call = herdrCalls(opts.machine, opts.herdrOptions, opts.transport);
  const timing = { readyMs: opts.timing?.readyMs ?? 10000, confirmMs: opts.timing?.confirmMs ?? 1000,
    pollMs: opts.timing?.pollMs ?? 250, recreateMs: opts.timing?.recreateMs ?? 60000, lockMs: opts.timing?.lockMs ?? 15000 };
  const done: HerdrTabAction[] = [];

  /** Type the launch line into `pane` once its shell is idle — never into anything else. A pane OAK
   *  just created is waited on until its shell reaches the prompt; an existing one is checked once per
   *  pass and must still be idle `confirmMs` later. */
  async function launch(tab: string, pane: string, terminal: string, fresh: boolean): Promise<void> {
    const key = `${machineKey}\n${pane}`;
    if (settledMonitor.get(key) === terminal) return;
    const deadline = Date.now() + (fresh ? timing.readyMs : 0);
    for (;;) {
      let state = paneForeground(await call.processInfo(pane));
      if (state === 'idle' && !fresh) {
        await sleep(timing.confirmMs);
        state = paneForeground(await call.processInfo(pane));
      }
      if (state === 'idle') {
        settledMonitor.set(key, terminal);
        await call.sendText(pane, MONITOR_LAUNCH);
        done.push({ kind: 'launch-monitor', tab_id: tab, pane_id: pane, label: BTOP_LABEL });
        return;
      }
      if (state === 'replaced') { settledMonitor.set(key, terminal); return; }
      if (Date.now() >= deadline) return;
      await sleep(timing.pollMs);
    }
  }

  const btopTabs = (s: SessionSnapshot, workspace: string): number => s.tabs.filter(t => t.workspace_id === workspace && t.label === BTOP_LABEL).length;
  async function create(workspace: string): Promise<void> {
    if (Date.now() - (lastCreated.get(machineKey) ?? -Infinity) < timing.recreateMs) return;
    lastCreated.set(machineKey, Date.now());
    // The pass decided from a snapshot that can be seconds old — a forwarded one tens of seconds. Under
    // the lock, ask again: a btop tab that appeared since was another OAK's, and one is enough.
    const created = await withCreateLock(machineKey, timing.lockMs, async () => {
      if (btopTabs(await call.snapshot(), workspace) > btopTabs(snapshot, workspace)) return undefined;
      const made = await call.createBtop(workspace);
      done.push({ kind: 'create-btop', workspace_id: workspace, label: BTOP_LABEL });
      // Best-effort: a pane left unlabelled is adopted once the monitor runs in it.
      if (made?.root_pane?.pane_id) await call.labelPane(made.root_pane.pane_id, BTOP_LABEL).catch(() => {});
      return made;
    });
    const tab = created?.tab?.tab_id;
    const pane = created?.root_pane?.pane_id;
    if (!tab || !pane) return;
    await call.moveFirst(tab);
    await launch(tab, pane, created?.root_pane?.terminal_id ?? '', true);
  }
  const terminalOf = (pane: string): string => snapshot.panes.find(p => p.pane_id === pane)?.terminal_id ?? '';

  for (const action of actions) {
    if (opts.only !== undefined && action.tab_id !== opts.only) continue;
    try {
      if (action.kind === 'create-btop') await create(action.workspace_id!);
      else if (action.kind === 'adopt-monitor') {
        // Only a pane whose shell was replaced — by the monitor OAK started there before it labelled
        // panes — becomes the monitor's pane. Anything else there may be a person's: make a new tab —
        // but only once it has stayed that way for `recreateMs`. Until then it may be another OAK's new
        // tab, not labelled yet (its pane is labelled, or runs the monitor, well within that), and a tab
        // made here was a second btop tab that nothing ever closes.
        const seen = `${machineKey}\n${action.tab_id}\n${terminalOf(action.pane_id!)}`;
        if (paneForeground(await call.processInfo(action.pane_id!)) === 'replaced') {
          unlabelledSince.delete(seen);
          await call.labelPane(action.pane_id!, BTOP_LABEL);
          settledMonitor.set(`${machineKey}\n${action.pane_id}`, terminalOf(action.pane_id!));
          done.push(action);
        } else {
          if (!unlabelledSince.has(seen)) unlabelledSince.set(seen, Date.now());
          if (Date.now() - unlabelledSince.get(seen)! >= timing.recreateMs) {
            unlabelledSince.delete(seen);
            await create(action.workspace_id!);
          }
        }
      } else if (action.kind === 'launch-monitor') {
        await launch(action.tab_id!, action.pane_id!, terminalOf(action.pane_id!), false);
      } else {
        try {
          await call.rename(action.tab_id!, action.label);
          done.push(action);
        } catch {
          // Failed, or timed out and may still land: the label the tab wears stays OAK's, so the next
          // pass tries again (a label that reads the new name is OAK's anyway).
          const wearing = snapshot.tabs.find(t => t.tab_id === action.tab_id)?.label;
          if (wearing !== undefined) nextOwned[action.tab_id!] = wearing;
        }
      }
    } catch { /* one action failing must not stop the others */ }
  }
  if (names) await saveOwned(machineKey, owned, nextOwned, opts.only === undefined ? undefined : [opts.only], opts.listedAt);
  return done;
}

/**
 * Name the herdr tab that holds one session's pane after that session's title, by the rules above
 * applied to that tab alone, and do nothing else: no btop, no other tab. The capture hooks and the Claude
 * Code status line start it (`oak __tab-sync`, herdr-link.ts `kickTabSync`) when the title may have
 * changed, so a tab follows its session while the terminal app is closed. The server is the one the
 * session's capture link names; the tab is found through the server's own record of the session, since a
 * pane id recorded earlier goes stale when its tab moves. `title` is the session's listed title
 * (`listedSessionTitle`, read here when omitted); a session with none, or with no link, reads nothing.
 * The terminal app on another machine asks for this too (`oak __tab-sync --machine`), so OAK's names for
 * a server's tabs are recorded once, on the machine that runs it.
 */
export async function syncSessionTab(opts: {
  session: string;
  title?: string | null;
  /** The name the asking terminal app recorded giving this session's tab before this machine named its
   *  own (`oak __tab-sync --claimed`): see `ensureHerdrTabs` `adopt`. */
  claimed?: string;
  /** Every verb goes through this: the caller's own herdr transport (the core module, or its fake). */
  transport: HerdrTransport;
  herdrOptions?: HerdrOptions;
}): Promise<HerdrTabAction[]> {
  const link = readHerdrPaneLink(opts.session);
  if (!link) return [];
  const listedAt = Date.now();
  const title = (opts.title === undefined ? listedSessionTitle(opts.session) : opts.title)?.trim();
  if (!title) return [];
  const herdrOptions = link.socketPath ? { ...opts.herdrOptions, socketPath: link.socketPath } : opts.herdrOptions;
  const snapshot = await herdrCalls(undefined, herdrOptions, opts.transport).snapshot();
  const pane = snapshot.agents?.find(a => a.agent_session?.value === opts.session)?.pane_id;
  const tab = pane === undefined ? undefined : snapshot.panes.find(p => p.pane_id === pane)?.tab_id;
  if (!tab) return [];
  return ensureHerdrTabs({ snapshot, titleOf: id => (id === opts.session ? title : undefined), only: tab, listedAt, adopt: opts.claimed,
    transport: opts.transport, herdrOptions });
}

/** The names this OAK's record says it gave the tabs of one machine's server (`local`: this machine's). */
export function herdrTabClaims(machine: string): Record<string, string> {
  return loadOwned(machine).owned;
}
