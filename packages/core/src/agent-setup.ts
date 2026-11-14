/** Delegation guidance, set up for the user by default (`oak init`, `oak update`) and per repository on request. The
 *  manifest records the exact content OAK owns, including JSON fields. */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { claudeConfigDir } from './paths';
import { codexHome } from './codex';
import { prefsPath, readPrefs, type Prefs } from './prefs';
import { repoRoot } from './session';
import type { Check } from './diagnose';

export const AGENT_PERMISSION = 'Bash(oak agent:*)';
export const DELEGATE_BEGIN = '<!-- oak-delegate:start -->';
export const DELEGATE_END = '<!-- oak-delegate:end -->';
export const AGENT_HANDOFF = `## Check related work

Before starting work, and before editing a file other agents may touch, check related work in the database:

- oak query files: edits by repository path, across clones and worktrees.
- oak query search --text …: related asks and answers.
- oak query delegated --all: agents and their state.
- oak query findings: facts other agents have posted.

When another active agent has pending edits to a file you are about to edit, OAK adds a note to your context; coordinate before editing.
Post a fact others should know with oak finding add "<text>" [--path <file>], for example that a file is generated or tests need a build step.
The parent sends a running agent a message with oak agent tell <id> <text>. A delegated agent that needs its parent raises a hand instead.
The parent can use oak agent start … --after <id…> to start work once those agents are done.

## Hand-off and tracking

- Leave changes uncommitted in the worktree. Never commit, push or merge. The parent reviews the changes in OAK and merges them.
- Write report.md in the output folder with these headings: What changed; Tests (before and after results); Not verified.
- Write changes.diff beside the report: run git diff --binary, then append each untracked file with git diff --no-index --binary /dev/null <file>.
- Stay inside the assigned worktree and output folder. OAK flags writes outside them. Use only the explicitly granted build caches for build tools.
- Use synthetic data only. Never copy real session content, credentials or personal paths into tests, documentation or reports.
- When blocked, or when a decision belongs to the user, stop and ask. OAK shows the wait for input; a raised hand may appear as blocked.
- A delegated agent starts no agents of its own, through OAK or a built-in delegation tool.
- Prove each fix with a test that fails before and passes after. Run the project's checks once at the end and record their results.
- The parent reads the report, reviews the changes in OAK, merges, closes the tab and checks the round's cost.
`;

function guidance(kind: 'claude' | 'codex'): string {
  return `## Delegate work in OAK tabs

Use OAK for independent work, parallel work, and long tasks that need their own session. Do small or tightly coupled tasks yourself. Each agent runs its native CLI in a herdr tab with a chatbox, state, report and log. Built-in delegation stays inside the parent session.

If you are already a delegated agent (OAK_DELEGATED is set), do not delegate again. Otherwise, start agents of your own kind (${kind}), unless the brief or an explicit flag specifies another kind.

Write a brief whose first line is # Title; this title names the tab. Follow it with the goal, scope, constraints, required proof and deliverables. Keep the brief outside the clean repository used to create a worktree.

1. Run oak agent start --kind ${kind} --brief <file> --worktree. Save the returned id, worktree and output paths. Flags override the model and effort saved by oak agent setup.
2. Run oak agent wait <id> in the background using the harness's background execution facility, so it reports completion. Use --until any to return when an agent needs attention.
3. Read report.md in the returned output folder and inspect changes.diff.
4. Review the changes in OAK, including the tests and anything not verified.
5. Merge the reviewed changes into the parent branch. The delegated agent leaves them uncommitted; the parent applies the reviewed diff and commits following the project's own rules.
6. Run oak agent close <id>. Add --remove-worktree only after the changes are merged and the worktree is clean.
7. Run oak agent list --all and check the round's cost.

${AGENT_HANDOFF}`;
}

export const OAK_DELEGATE_SKILL = `---
name: oak-delegate
description: Delegate independent, parallel or long work to native CLI sessions in OAK herdr tabs, then review their reports and changes.
---

${guidance('claude')}`;
export const OAK_CODEX_BLOCK = `${DELEGATE_BEGIN}\n${guidance('codex')}${DELEGATE_END}\n`;
export const OAK_BUILDER = `---
name: oak-builder
description: Implements an assigned OAK brief in its worktree and reports evidence to the parent.
disallowedTools: Agent
---

Read the assigned brief and follow its scope and constraints. Complete the work directly; do not delegate.

${AGENT_HANDOFF}`;

interface Owned { path: string; part: string; value: string; before: string | null; created: boolean }
export interface AgentSetupItem extends Owned { state: 'missing' | 'current' | 'outdated' | 'edited' | 'kept'; observed: string | null }
export interface AgentSetupPlan { manifest: string; project?: string; remove: boolean; items: AgentSetupItem[] }
interface Manifest { version: 1; entries: Owned[] }
const read = (file: string): string | null => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } };
function json(file: string): Record<string, any> {
  const text = read(file);
  if (text === null) return {};
  const obj = JSON.parse(text);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${file} must contain a JSON object; left unchanged`);
  return obj;
}
function atomic(file: string, text: string): void {
  if (read(file) === text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function location(project?: string): { config: string; codex: string; prefs: string; manifest: string; project?: string } {
  const root = project ? repoRoot(path.resolve(project)) : null;
  if (project && !root) throw new Error('agent setup --project needs a Git repository');
  const config = root ? path.join(root, '.claude') : claudeConfigDir();
  return { config, codex: root ? path.join(root, 'AGENTS.md') : path.join(codexHome(), 'AGENTS.md'),
    prefs: root ? path.join(config, 'claude-observatory', 'prefs.json') : prefsPath(),
    manifest: path.join(config, 'oak-agent-setup.json'), ...(root ? { project: root } : {}) };
}
function owned(file: string): Owned[] {
  const m = json(file);
  if (!Object.keys(m).length) return [];
  if (m.version !== 1 || !Array.isArray(m.entries) || m.entries.some((x: any) => typeof x.path !== 'string' || typeof x.part !== 'string' || typeof x.value !== 'string'))
    throw new Error(`${file} is not an OAK setup manifest; left unchanged`);
  const config = path.dirname(file);
  const user = path.resolve(config) === path.resolve(claudeConfigDir());
  const allowed = (e: Owned): boolean => {
    const same = (p: string) => path.resolve(e.path) === path.resolve(p);
    if (e.part === 'file') return same(path.join(config, 'skills/oak-delegate/SKILL.md')) || same(path.join(config, 'agents/oak-builder.md'));
    if (e.part === 'block') return same(user ? path.join(codexHome(), 'AGENTS.md') : path.join(path.dirname(config), 'AGENTS.md'));
    if (e.part === 'permission') return same(path.join(config, 'settings.json'));
    return /^(claude|codex)\.(model|effort|agentType|sandbox|permissionMode|args|writableRoots)$/.test(e.part) && same(user ? prefsPath() : path.join(config, 'claude-observatory/prefs.json'));
  };
  if (m.entries.some((e: Owned) => !allowed(e))) throw new Error(`${file} names content outside its setup scope; left unchanged`);
  return m.entries;
}
function block(text: string): string | null {
  const start = text.indexOf(DELEGATE_BEGIN), end = text.indexOf(DELEGATE_END);
  if (start < 0 && end < 0) return null;
  if (start < 0 || end < start || text.indexOf(DELEGATE_BEGIN, start + 1) >= 0 || text.indexOf(DELEGATE_END, end + 1) >= 0) return text;
  const stop = end + DELEGATE_END.length;
  return text.slice(start, stop + (text[stop] === '\n' ? 1 : 0));
}
function valueOf(entry: Pick<Owned, 'path' | 'part'>): string | null {
  const text = read(entry.path);
  if (text === null || entry.part === 'file') return text;
  if (entry.part === 'block') return block(text);
  const obj = json(entry.path);
  if (entry.part === 'permission') {
    const allow = obj.permissions?.allow;
    if (allow !== undefined && !Array.isArray(allow)) throw new Error(`${entry.path}: permissions.allow is not an array; left unchanged`);
    return allow?.includes(AGENT_PERMISSION) ? AGENT_PERMISSION : null;
  }
  const [kind, key] = entry.part.split('.');
  const v = obj.agents?.[kind]?.[key];
  return v === undefined ? null : JSON.stringify(v);
}

/** The CLI's configured model and effort, with the user's saved OAK choices taking precedence. */
export function agentSetupDefaults(project?: string): NonNullable<Prefs['agents']> {
  const loc = location(project);
  const user = readPrefs().agents;
  const local = readPrefs(loc.prefs).agents;
  const saved = { claude: { ...user?.claude, ...local?.claude }, codex: { ...user?.codex, ...local?.codex } };
  const claude = { ...json(path.join(claudeConfigDir(), 'settings.json')), ...(project ? json(path.join(loc.config, 'settings.json')) : {}) };
  let codex: Record<string, unknown> = {};
  const text = read(path.join(codexHome(), 'config.toml'));
  if (text !== null) codex = (require('smol-toml') as { parse(s: string): Record<string, unknown> }).parse(text);
  if (typeof codex.profile === 'string') codex = { ...codex, ...(codex.profiles as Record<string, object> | undefined)?.[codex.profile] };
  const str = (x: unknown): string | undefined => typeof x === 'string' && x.trim() ? x : undefined;
  return {
    claude: { ...(str(claude.model) ? { model: str(claude.model) } : {}), ...(str(claude.effortLevel) ? { effort: str(claude.effortLevel) } : {}), agentType: 'oak-builder', ...saved.claude },
    codex: { sandbox: str(codex.sandbox_mode) ?? 'workspace-write', ...(str(codex.model) ? { model: str(codex.model) } : {}), ...(str(codex.model_reasoning_effort) ? { effort: str(codex.model_reasoning_effort) } : {}),
      writableRoots: ['.gradle', '.npm', '.cache'].map(p => path.join(os.homedir(), p)).filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }), ...saved.codex },
  };
}

export function agentSetupPlan(options: { project?: string; remove?: boolean; defaults?: Prefs['agents'] } = {}): AgentSetupPlan {
  const loc = location(options.project);
  const previous = owned(loc.manifest);
  const desired: Pick<Owned, 'path' | 'part' | 'value'>[] = options.remove ? previous : [
    { path: path.join(loc.config, 'skills/oak-delegate/SKILL.md'), part: 'file', value: OAK_DELEGATE_SKILL },
    { path: loc.codex, part: 'block', value: OAK_CODEX_BLOCK },
    { path: path.join(loc.config, 'agents/oak-builder.md'), part: 'file', value: OAK_BUILDER },
    { path: path.join(loc.config, 'settings.json'), part: 'permission', value: AGENT_PERMISSION },
    ...Object.entries(options.defaults ?? agentSetupDefaults(options.project)).flatMap(([kind, prefs]) => Object.entries(prefs ?? {}).map(([key, v]) => ({ path: loc.prefs, part: `${kind}.${key}`, value: JSON.stringify(v) }))),
  ];
  const items = desired.map(e => {
    const was = previous.find(p => p.path === e.path && p.part === e.part);
    const observed = valueOf(e);
    const shared = e.part !== 'file' && e.part !== 'block';
    const state: AgentSetupItem['state'] = was
      ? observed === was.value ? observed === e.value ? 'current' : 'outdated' : observed === null ? 'missing' : 'edited'
      : observed === null ? 'missing' : shared ? 'kept' : 'edited';
    return { ...e, before: was?.before ?? observed, created: was?.created ?? read(e.path) === null, observed, state };
  });
  return { manifest: loc.manifest, project: loc.project, remove: !!options.remove, items };
}

function writeValue(e: Owned, value: string | null): void {
  const text = read(e.path) ?? '';
  if (e.part === 'file') { if (value === null) fs.rmSync(e.path, { force: true }); else atomic(e.path, value); return; }
  if (e.part === 'block') {
    const old = block(text);
    const next = old === null ? (value ?? '') + text : text.replace(old, value ?? '');
    if (!next && e.created) fs.rmSync(e.path, { force: true }); else atomic(e.path, next);
    return;
  }
  const obj = json(e.path);
  if (e.part === 'permission') {
    const allow: string[] = obj.permissions?.allow ?? [];
    if (value === null) {
      obj.permissions.allow = allow.filter(x => x !== AGENT_PERMISSION);
      if (!obj.permissions.allow.length) delete obj.permissions.allow;
      if (!Object.keys(obj.permissions).length) delete obj.permissions;
    } else { obj.permissions ??= {}; obj.permissions.allow = [...allow.filter(x => x !== AGENT_PERMISSION), AGENT_PERMISSION]; }
  } else {
    const [kind, key] = e.part.split('.');
    // A kind names an agent. One that names an Object.prototype member would reach a shared object instead: `__proto__` is
    // Object.prototype itself and `constructor` is the global Object. The explicit `__proto__` test is the form CodeQL recognises.
    if (kind === '__proto__' || kind in Object.prototype) throw new Error(`${e.path}: ${e.part} is not an agent setting; left unchanged`);
    if (value === null) {
      if (obj.agents?.[kind]) {
        delete obj.agents[kind][key];
        if (!Object.keys(obj.agents[kind]).length) delete obj.agents[kind];
        if (!Object.keys(obj.agents).length) delete obj.agents;
      }
    } else { obj.agents ??= {}; obj.agents[kind] ??= {}; obj.agents[kind][key] = JSON.parse(value); }
  }
  if (!Object.keys(obj).length && e.created) fs.rmSync(e.path, { force: true });
  else atomic(e.path, JSON.stringify(obj, null, 2) + '\n');
}

/** Compare again at the write boundary. Edited content remains owned so a later check still explains it. */
export function applyAgentSetup(plan: AgentSetupPlan): AgentSetupPlan {
  let entries = owned(plan.manifest);
  for (const e of plan.items) {
    if (e.state === 'edited' || e.state === 'kept') continue;
    if (valueOf(e) !== e.observed) { e.state = 'edited'; continue; }
    const was = entries.find(p => p.path === e.path && p.part === e.part);
    if (plan.remove) {
      if (was && e.observed !== null) writeValue(was, was.before);
      entries = entries.filter(p => p !== was);
    } else {
      if (e.observed !== e.value) writeValue(e, e.value);
      const next: Owned = { path: e.path, part: e.part, value: e.value, before: was ? was.before : e.before, created: e.created };
      entries = [...entries.filter(p => p !== was), next];
    }
  }
  if (!entries.length) fs.rmSync(plan.manifest, { force: true });
  else atomic(plan.manifest, JSON.stringify({ version: 1, entries } satisfies Manifest, null, 2) + '\n');
  return plan;
}

/** Update/uninstall visit the user setup and this repository's setup; neither enrolls a new scope. */
export function refreshAgentSetup(cwd = process.cwd(), remove = false): AgentSetupPlan[] {
  const scopes = [undefined, ...(repoRoot(cwd) ? [cwd] : [])];
  return scopes.flatMap(project => {
    if (!fs.existsSync(location(project).manifest)) return [];
    const plan = agentSetupPlan({ project, remove });
    return [applyAgentSetup(plan)];
  });
}
/** The user removed the user-scope setup (`oak agent setup --remove`): a default setup leaves it removed until
 *  `oak agent setup` adds it back. Uninstalling OAK is not a removal the user chose for this. */
const declinedPath = (): string => path.join(path.dirname(prefsPath()), 'agent-setup-removed');
export function agentSetupDeclined(): boolean { return fs.existsSync(declinedPath()); }
export function setAgentSetupDeclined(declined: boolean): void {
  if (declined) atomic(declinedPath(), '1\n'); else fs.rmSync(declinedPath(), { force: true });
}
/** The user-scope setup OAK makes by default, with the CLIs' own models and efforts and no questions: applied when
 *  there is none and the user has not removed it. Null when there was nothing to do. */
export function defaultAgentSetupPending(): boolean { return !fs.existsSync(location().manifest) && !agentSetupDeclined(); }
export function applyDefaultAgentSetup(): AgentSetupPlan | null {
  return defaultAgentSetupPending() ? applyAgentSetup(agentSetupPlan()) : null;
}
export function agentSetupStatus(cwd = process.cwd()): AgentSetupPlan[] {
  return [undefined, ...(repoRoot(cwd) ? [cwd] : [])].flatMap(project => fs.existsSync(location(project).manifest) ? [agentSetupPlan({ project })] : []);
}
export function diagnoseAgentSetup(cwd = process.cwd()): Check {
  try {
    const plans = agentSetupStatus(cwd);
    const bad = plans.flatMap(p => p.items).filter(e => !['current', 'kept'].includes(e.state));
    if (!plans.length && agentSetupDeclined()) return { id: 'agent-setup', label: 'Agent delegation setup', level: 'ok', detail: 'Removed with oak agent setup --remove; oak agent setup adds it back.' };
    return { id: 'agent-setup', label: 'Agent delegation setup', level: plans.length && !bad.length ? 'ok' : 'warn',
      detail: bad.length ? bad.map(e => `${e.path}: ${e.state}`).join('; ') : plans.length ? 'Managed delegation guidance is current.' : 'Agents have no OAK delegation guidance.',
      ...(!plans.length || bad.length ? { fix: 'oak agent setup --check; oak agent setup' } : {}) };
  } catch (e) { return { id: 'agent-setup', label: 'Agent delegation setup', level: 'warn', detail: String((e as Error).message), fix: 'oak agent setup --check' }; }
}
export function takeAgentSetupNotice(cwd = process.cwd()): string | null {
  if (agentSetupStatus(cwd).length || agentSetupDeclined()) return null;
  const file = path.join(path.dirname(prefsPath()), 'agent-setup-suggested');
  if (fs.existsSync(file)) return null;
  atomic(file, '1\n');
  return 'oak agent setup: teach your agent to delegate in herdr tabs';
}
