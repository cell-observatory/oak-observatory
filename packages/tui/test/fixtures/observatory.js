// Small protocol-22 snapshots: local and remote pane ids deliberately overlap, and so do workspace ids,
// which each machine labels its own way.
const { backupFolderPath } = require('../../../core/dist');
const pane = (id, session, status, agent = 'claude', workspace = 'w1') => ({
  pane_id: id, tab_id: 'tab', workspace_id: workspace, terminal_id: id, revision: 1, focused: id === 'p1',
  agent, agent_status: status, title: session, cwd: '/workspace',
  agent_session: { agent, kind: 'id', value: session, source: `herdr:${agent}` },
});
const workspaces = labels => Object.entries(labels).map(([id, label], i) => ({ workspace_id: id, label, number: i + 1,
  active_tab_id: 'tab', agent_status: 'unknown', focused: i === 0, pane_count: 1, tab_count: 1 }));
const snapshot = (panes, labels = { w1: 'demo', w2: 'docs' }) => ({ protocol: 22, version: '0.9.1', panes,
  agents: panes.map(p => ({ ...p, name: p.agent_session.value })), workspaces: workspaces(labels), tabs: [], layouts: [] });
function fixture() {
  const now = Date.parse('2026-09-18T14:01:00Z');
  const row = (id, title, pending, agent = 'claude') => ({ id, title, pending, agent, model: agent === 'claude' ? 'Opus' : 'GPT', tokens: 900, lastActiveMs: now - 60000, phase: 'idle', machine: 'laptop' });
  const panes = () => ({ minimized: new Set(), zoom: null, focus: 'traces', tab: {}, cursor: {}, scroll: {} });
  return {
    views: { sessions: { sessions: [row('claude-conversation', 'Fix the demo', 2), row('working', 'Run checks', 0), row('idle', 'Waiting for prompt', 0),
      row('remote-done', 'Remote review', 3, 'codex'), row('unknown', 'Unknown state', 0, 'codex'), row('unresolved', 'Recover edits', 4), row('archived', 'Finished yesterday', 0)] },
      multitask: { agents: [{ session: 'claude-conversation', title: 'Fix the demo', worktree: '/workspace', phase: 'idle', loaded: true,
        subagents: [{ agentId: 'scout', agentType: 'Explore', description: 'Inspect the grid', phase: 'done', ts: now - 60000, edits: 1, tokensIn: 120, tokensOut: 20, model: 'Haiku' }],
        todos: [{ content: 'Run checks', status: 'in_progress' }] }] } },
    observatory: { machines: [{ id: 'local', label: 'laptop', local: true, snapshot: snapshot([pane('p1', 'claude-conversation', 'blocked'), pane('p2', 'working', 'working'), pane('p3', 'idle', 'idle', 'claude', 'w2')]) },
      { id: 'build', label: 'build-box', sessions: { sessions: [row('remote-done', 'Remote review', 3, 'codex'), row('unknown', 'Unknown state', 0, 'codex')] }, snapshot: snapshot([pane('p1', 'remote-done', 'done', 'codex'), pane('p2', 'unknown', 'unknown', 'codex')], { w1: 'review' }) }], details: {} },
    screen: 'sessions-nav', cursor: 0, scroll: 0, session: 'claude-conversation', sessionTitle: '', filter: '', sort: 'time', now,
    open: new Set(), marked: new Set(), status: 'ready', error: null, confirm: null, promptScope: null, scopeWorker: null, overlay: null,
    tabs: [{ id: 'herdr', kind: 'native', name: 'herdr', panes: panes() }, { id: 'observatory', kind: 'panes', name: 'Observatory', panes: panes() }, { id: 'review', kind: 'panes', name: 'Review', panes: panes() }], activeTab: 0,
  };
}
/** `oak sync status --json` as the fixture's machines would answer it: a run at 14:00:30 that pulled from build-box, a
 *  backup folder whose record under this machine's name the run refused (with the CLI's sentence and next step), one
 *  open conflict and one warning. `over` replaces top-level fields. */
function syncView(over = {}) {
  const at = Date.parse('2026-09-18T14:00:30Z');
  const run = (label, status, extra = {}) => ({ label, status, pulled: { files: 0, bytes: 0 }, conflicts: 0, pending: { files: 0, bytes: 0 }, errors: [], ...extra });
  const refusal = 'the backup folder holds a record under this machine\'s name (its host name and home folder) that this machine has not written: last written 2026-09-17T10:00:00.000Z by laptop (home /home/u). If this machine is a reinstall of that one, `oak sync setup --restore` (or `oak sync setup` on a terminal) takes the record over and restores from it; if it is another machine, give it another host name, since the folder names each machine by its host name and home folder. Until then nothing is restored from the folder or written to it';
  return {
    syncStatus: 1, setUp: true, auto: true, running: false,
    last: { at, durationMs: 900, status: 'partial', warnings: ['cleanupPeriodDays is not set on laptop, so Claude Code there keeps transcripts and plans 30 days; older ones are not planned'],
      machines: [run('build-box', 'ok', { host: 'h1', pulled: { files: 3, bytes: 1200 }, conflicts: 1, lastOkAt: at, text: '3 files, 1KB' }),
        run(`backup (${backupFolderPath('/mnt/share/oak-backup')})`, 'failed', { detail: refusal, record: 'unclaimed', text: `failed: ${refusal}` })] },
    backup: { kind: 'folder', path: '/mnt/share/oak-backup' }, placements: {}, exclude: { machines: [], projects: [] },
    conflicts: [{ id: 'c0ffee000001', family: 'plans', name: 'm.md', from: 'build-box', host: 'h1', at, peerSha256: null, peerSize: 10,
      copy: '/home/u/.claude/claude-observatory/sync/conflicts/build-box/plans/m.md', localSha256: null, reason: 'overlap', file: '/home/u/.claude/plans/m.md' }],
    index: [], cache: { files: 0, bytes: 0, capMB: 2048 }, key: { present: true, fingerprint: 'a11b-f2dc-f733-a548' },
    ...over,
  };
}
module.exports = { fixture, pane, snapshot, syncView };
