// Render the current Observatory from the disposable demo store without a CLI child or live socket.
// This exercises the shipped frame renderer and transcript model; it does not claim live herdr state.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../packages/core/dist');
const tui = require('../packages/tui/dist');

export function demoFrame(cwd, session, cols, rows) {
  session ||= core.resolveSessionId(cwd);
  if (!session) return null;
  const panes = () => ({ minimized: new Set(), zoom: null, focus: 'dashboards', tab: {}, cursor: {}, scroll: {} });
  const sessions = core.sessionMeta(cwd, session);
  for (const row of sessions.sessions) row.machine = 'demo-host';
  const agents = sessions.sessions.map(row => {
    const view = core.siblingOverview(cwd, row.id, { root: cwd });
    return { session: row.id, worktree: cwd, title: row.title, todos: view.todos, subagents: core.subagentDigests(cwd, row.id) };
  });
  const normalize = value => JSON.parse(JSON.stringify(value), (_key, v) => typeof v === 'string'
    ? v.replaceAll(cwd, '/tmp/obs-demo').replaceAll(process.env.CLAUDE_CONFIG_DIR || '\0', '/tmp/obs-demo/config') : v);
  const tabs = [
    { id: 'herdr', name: 'herdr', kind: 'native', panes: panes() },
    { id: 'observatory', name: 'observatory', kind: 'panes', panes: panes(), root: tui.OBSERVATORY_TREE, treeFocus: 'obs-detail' },
    { id: 'review', name: 'review', kind: 'panes', panes: panes() },
  ];
  let state = {
    views: normalize({ sessions, multitask: { agents } }), tabs, activeTab: 1, panes: tabs[1].panes,
    screen: 'sessions-nav', session, sessionTitle: '', cursor: 0, scroll: 0, filter: '', sort: 'time',
    marked: new Set(), open: new Set(), syntax: true, keys: core.keymap(core.readPrefs()),
    status: 'demo · captured history', error: null, confirm: null, now: Date.now(),
    promptScope: null, scopeWorker: null, overlay: null,
    observatory: { machines: [{ id: 'local', label: 'demo-host (history)', local: true,
      snapshot: { version: '0.9.1', protocol: 22, panes: [], agents: [], workspaces: [], tabs: [], layouts: [] } }], details: {} },
  };
  state = tui.selectAndPin(state, session);
  const conversation = core.conversationEvents(session, { root: cwd });
  const previews = Object.fromEntries(core.readLog(session).map(record => [record.id, core.coloredDiff(session, record, false)]));
  state.observatory.details['obs-detail'] = {
    ...state.observatory.details['obs-detail'], ...normalize(conversation), loadedAt: state.now,
    loading: false, previews: normalize(previews), fleet: normalize(agents.find(a => a.session === session)),
  };
  // Normalize before measuring cells so shorter published paths cannot distort pane widths.
  return tui.renderDashFrame(state, { cols, rows, color: 'truecolor', glyphs: tui.glyphs('unicode') })
    .join('\n');
}
