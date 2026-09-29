// Small protocol-22 snapshots: local and remote pane ids deliberately overlap, and so do workspace ids,
// which each machine labels its own way.
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
module.exports = { fixture, pane, snapshot };
