// Focused host/webview regressions, also loaded by smoke.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const os = require('node:os');
const { execSync } = require('node:child_process');

const source = fs.readFileSync(path.join(__dirname, '../src/extension.ts'), 'utf8');
const ast = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
const methods = new Map(), commands = new Map();
let script;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'vscode.commands.registerCommand' && ts.isStringLiteral(node.arguments[0]))
    commands.set(node.arguments[0].text, node.arguments[1].getText(ast));
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'TIMELINE_SCRIPT') script = node.initializer.text;
  if (ts.isMethodDeclaration(node) && node.parent.name?.getText(ast) === 'TimelineViewProvider')
    methods.set(node.name.getText(ast), node.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);

function timeline() {
  const nodes = new Map(), posted = [];
  let listener, bodyWrites = 0;
  const scrolls = [];
  function el(id) {
    if (nodes.has(id)) return nodes.get(id);
    let html = '';
    const style = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; }, getPropertyValue() { return ''; } };
    const node = {
      style, textContent: '', classes: new Set(), classList: { add(c) { node.classes.add(c); }, remove(c) { node.classes.delete(c); }, toggle() {}, contains(c) { return node.classes.has(c); } },
      addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
      querySelector: (s) => s[0] === '#' ? el(s.slice(1)) : null, querySelectorAll: (s) => s === '[data-ts]' ? [...el('tl-feed').innerHTML.matchAll(/data-ts="(\d+)"/g)].map(m => ({
        getAttribute: () => m[1], scrollIntoView: (options) => { scrolls.push({ ts: Number(m[1]), options }); node.scrollTop = 123; },
      })) : [],
      scrollTop: 0, clientHeight: 600, scrollHeight: 600, childNodes: [{}],
    };
    Object.defineProperty(node, 'innerHTML', { get: () => html, set: (v) => { html = v; if (id === 'tla-body') bodyWrites++; if (id === 'tl-feed') el('tlf-body').classes.clear(); } });
    nodes.set(id, node);
    return node;
  }
  const sandbox = {
    window: { addEventListener(type, cb) { if (type === 'message') listener = cb; } },
    document: { getElementById: el, querySelector: (s) => s[0] === '#' ? el(s.slice(1)) : null,
      querySelectorAll: () => [], addEventListener() {}, body: el('body'), documentElement: el('html') },
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m), getState: () => ({ tab: 'feed' }), setState() {} }),
    setTimeout() {}, clearTimeout() {}, getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  vm.runInNewContext(script, sandbox);
  return { el, posted, scrolls, post: (data) => listener({ data }), writes: () => bodyWrites };
}

test('Feed renders live/audit metadata, full recap, note, and working load more', () => {
  const view = timeline();
  view.post({ type: 'tab', tab: 'feed' });
  const feed = { mode: 'audit', title: 'Fixture activity', lastTs: 123456, entries: [],
    recap: 'Recap <keep all> '.repeat(30), recapSource: 'transcript', note: 'No captured activity <yet>', truncated: 12 };
  view.post({ type: 'agentFeed', session: 'fixture-session', feed, patches: {} });
  const host = view.el('tl-feed');
  assert.match(host.innerHTML, /▣ audit log/);
  assert.match(host.innerHTML, /last activity/);
  assert.match(host.innerHTML, /Fixture activity/);
  assert.ok(host.innerHTML.includes('Recap &lt;keep all&gt; '.repeat(30)), 'the entire recap is escaped, never truncated');
  assert.match(host.innerHTML, /from the transcript/);
  assert.match(host.innerHTML, /No captured activity &lt;yet&gt;/);
  assert.match(host.innerHTML, /12 earlier entries not shown — load more/);
  const button = { hasAttribute: (k) => k === 'data-feedmore', classList: { contains: () => false } };
  host.onclick({ target: { closest: () => button } });
  assert.equal(view.posted.at(-1).type, 'agentFeedMore');
  view.post({ type: 'agentFeed', session: 'fixture-session', feed: { ...feed, mode: 'live', truncated: 1 } });
  assert.match(host.innerHTML, /● live/);
  assert.match(host.innerHTML, /updated/);
  assert.match(host.innerHTML, /1 earlier entry not shown — load more/);
  view.post({ type: 'agentFeed', session: 'fixture-session', feed: { ...feed, lastTs: 0, truncated: 0 } });
  assert.match(host.innerHTML, /no activity recorded/);
  assert.doesNotMatch(host.innerHTML, /data-feedmore/);
  // Drive the production host handler and CLI request too: the button must increase the fetch limit.
  let receive;
  const requests = [];
  const sandbox = { timelineShell: () => '', workspaceRoot: () => '/workspace', currentSession: () => 'fixture-session',
    spawnCliJson: (args) => requests.push(args) };
  vm.runInNewContext(ts.transpile(`globalThis.Provider = class {
    ${methods.get('resolveWebviewView')}
    ${methods.get('fetchAgentFeed')}
  }`, { target: ts.ScriptTarget.ES2022 }), sandbox);
  const provider = new sandbox.Provider();
  Object.assign(provider, { showing: { feed: true }, conversationSelection: () => 'fixture-session', agentFeedLimit: 60 });
  provider.resolveWebviewView({ visible: true, webview: { onDidReceiveMessage(cb) { receive = cb; } }, onDidChangeVisibility() {} });
  receive({ type: 'agentFeedMore' });
  assert.equal(provider.agentFeedLimit, 260);
  assert.equal(requests.length, 1);
  assert.equal(requests[0][requests[0].indexOf('--feed-limit') + 1], '260');
});

test('\u2193 newest is offered only away from the tail of the Feed', () => {
  // The pill is the way BACK to the tail. Parked there permanently it does nothing and floats over
  // the last line of the transcript.
  const view = timeline();
  view.post({ type: 'tab', tab: 'feed' });
  view.post({ type: 'agentFeed', session: 'fixture-session', patches: {},
    feed: { mode: 'live', title: 'Fixture activity', lastTs: 1, entries: [] } });
  const feedHost = view.el('tl-feed'), fbody = view.el('tlf-body'), fjump = view.el('tlf-jump');
  assert.match(feedHost.innerHTML, /tlf-jump/, 'the Feed tab carries the affordance');
  assert.equal(typeof fbody.onscroll, 'function', 'the body drives it from its own scroll');
  assert.equal(fjump.style.display, 'none', 'at the tail the pill is hidden');
  fbody.scrollTop = 0; fbody.scrollHeight = 4000;
  fbody.onscroll();
  assert.equal(fjump.style.display, '', 'the Feed pill appears when the viewport leaves the tail');
  const jumpBtn = { hasAttribute: (k) => k === 'data-feedjump', classList: { contains: () => false } };
  feedHost.onclick({ target: { closest: () => jumpBtn } });
  assert.equal(fbody.scrollTop, 4000, 'clicking it returns to the newest entry');
  assert.equal(fjump.style.display, 'none', '\u2026and it stands down once it has');
});

test('Windows plugin PATH includes the herdr executable directory', () => {
  const ps = fs.readFileSync(path.join(__dirname, '../../herdr-plugin/open-in-oak.ps1'), 'utf8');
  const extra = ps.match(/\$extra = @\(([\s\S]*?)\n    \)/)[1];
  assert.ok(extra.includes('"$userDir\\.local\\bin\\herdr"'));
});

test('usage refresh tooltips describe local account usage', () => {
  assert.ok(source.includes('OAK: refresh usage now'));
  assert.ok(source.includes('Refresh now — pull your account usage'));
  assert.doesNotMatch(source, /also re-gathers the other machines|and any configured remote machines/);
  for (const file of ['ObservatoryUsageWidgetFactory.kt', 'stats/StatsPanel.kt']) {
    const text = fs.readFileSync(path.join(__dirname, '../../jetbrains/src/main/kotlin/com/cellobservatory/observatory/ui', file), 'utf8');
    assert.match(text, /Refresh usage now|Refresh now — pull your account usage/);
    assert.doesNotMatch(text, /also re-gathers the other machines|and any configured remote machines/);
  }
});

test('JetBrains review actions describe the dialog draft and the Feed tab', () => {
  const base = path.join(__dirname, '../../jetbrains/src/main/kotlin/com/cellobservatory/observatory');
  const actions = fs.readFileSync(path.join(base, 'actions/EditorActions.kt'), 'utf8');
  assert.doesNotMatch(actions, /DRAFT it into the Agent tab|Agent tab composer/);
  assert.match(actions, /editable dialog draft/);
  for (const file of ['PromptsPanel.kt', 'ChangeMapPanel.kt']) {
    const text = fs.readFileSync(path.join(base, 'ui', file), 'utf8');
    assert.doesNotMatch(text, /Agent tab|Conversation tab/);
    assert.match(text, /Feed tab/);
  }
});

test('VSIX prepublish stages the current complete root notices at the extension root', () => {
  const pkg = require('../package.json');
  assert.ok(pkg.scripts['vscode:prepublish'], 'direct vsce packaging must stage notices too');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-notices-'));
  try {
    const dir = path.join(root, 'packages/vscode');
    fs.mkdirSync(dir, { recursive: true });
    const notices = fs.readFileSync(path.join(__dirname, '../../../THIRD_PARTY_NOTICES.md'), 'utf8');
    fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), notices);
    execSync(pkg.scripts['vscode:prepublish'], { cwd: dir, stdio: 'inherit' });
    assert.equal(fs.readFileSync(path.join(dir, 'THIRD_PARTY_NOTICES.md'), 'utf8'), notices);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


function feedMessage(entries, extra = {}) {
  return { type: 'agentFeed', session: 'fixture-session', feed: { ref: { kind: 'session', id: '' }, mode: 'live', entries }, ...extra };
}
function clickFeed(view, key, kind = 'tlf-hrow') {
  const blob = { getAttribute: () => key };
  const target = { hasAttribute: k => kind === 'file' && k === 'data-openpath', getAttribute: () => 'src/fixture.ts',
    classList: { contains: c => c === kind }, closest: () => blob };
  view.el('tl-feed').onclick({ target: { closest: selectors => selectors.includes('.' + kind) || kind === 'file' ? target : null } });
}
const thought = (ts, words) => ({ ts, kind: 'reasoning', label: 'thinking', reasoningKind: 'thinking', reasoning: words });

test('Feed workflow reasoning is deduplicated per agent', () => {
  const view = timeline();
  view.post(feedMessage([
    { ...thought(1, 'Alpha words'), detail: 'alpha', reasoningKind: 'text' },
    { ...thought(2, 'Beta words'), detail: 'beta', reasoningKind: 'text' },
    { ts: 3, kind: 'action', label: 'Read', detail: 'alpha', reasoning: 'Alpha words' },
    { ts: 4, kind: 'action', label: 'Read', detail: 'beta', reasoning: 'Beta words' },
  ]));
  for (const words of ['Alpha words', 'Beta words']) assert.equal(view.el('tl-feed').innerHTML.split(words).length - 1, 1);
});

test('Feed prompt and response jumps land on timestamped rows ahead of tail-follow', () => {
  const view = timeline();
  const entries = [10, 20, 30].map(ts => ({ ...thought(ts, 'words'), reasoningKind: 'text' }));
  view.post(feedMessage(entries, { scrollTs: 20 }));
  assert.equal(view.scrolls.at(-1)?.ts, 20);
  assert.equal(view.scrolls.at(-1)?.options.block, 'start');
  assert.equal(view.el('tlf-body').scrollTop, 123, 'tail-follow does not overwrite the target');
  view.post(feedMessage(entries, { scrollTs: 30, scrollMode: 'end' }));
  assert.equal(view.scrolls.at(-1)?.ts, 20, 'response end lands on the last preceding row');
});

test('Feed folds survive a leading row and reset when the subject changes', () => {
  const view = timeline(), rows = [thought(20, 'Opened words'), thought(30, 'Still folded')];
  view.post(feedMessage(rows));
  const key = view.el('tl-feed').innerHTML.match(/data-fkey="([^"]+)"/)[1];
  clickFeed(view, key, 'tlf-twig');
  assert.match(view.el('tl-feed').innerHTML, /tlf-think[^>]*>.*Opened words/);
  view.post(feedMessage([thought(10, 'New leading row'), ...rows]));
  assert.match(view.el('tl-feed').innerHTML, /tlf-think[^>]*>.*Opened words/);
  assert.doesNotMatch(view.el('tl-feed').innerHTML, /tlf-think[^>]*>.*New leading row/);
  view.post(feedMessage(rows, { session: 'another-fixture' }));
  assert.doesNotMatch(view.el('tl-feed').innerHTML, /class="tlf-think/);
});

test('Feed head toggles the whole thought and file links keep their own action', () => {
  const view = timeline(); view.post(feedMessage([thought(10, 'Whole thought body')]));
  const key = view.el('tl-feed').innerHTML.match(/data-fkey="([^"]+)"/)[1];
  clickFeed(view, key);
  assert.match(view.el('tl-feed').innerHTML, /class="tlf-think/);
  const before = view.el('tl-feed').innerHTML;
  clickFeed(view, key, 'file');
  assert.equal(view.posted.at(-1).type, 'openPath');
  assert.equal(view.el('tl-feed').innerHTML, before);
});

test('Feed folded thought uses a word count and the tour ring survives a refresh', () => {
  const view = timeline(); view.post(feedMessage([thought(10, 'Three\u00a0complete\u202fwords')]));
  assert.match(view.el('tl-feed').innerHTML, /3 words/);
  assert.doesNotMatch(view.el('tl-feed').innerHTML, /Three complete words/);
  view.post({ type: 'tour', anchor: 'feed' });
  assert.ok(view.el('tlf-body').classes.has('ring'));
  view.post(feedMessage([thought(11, 'New thought')]));
  assert.ok(view.el('tlf-body').classes.has('ring'));
});

test('Open conversation fetches the session feed once', async () => {
  let fetches = 0;
  const sandbox = { core: { isSafeSessionId: () => true }, showTimelineTab: async () => {},
    promptsProvider: { connectSession: () => fetches++, fetchAgentFeed: () => fetches++ } };
  const command = vm.runInNewContext(ts.transpile('(' + commands.get('claudeObservatory.openConversation') + ')'), sandbox);
  await command('fixture-session');
  assert.equal(fetches, 1);
});

test('Next raised hand clears an Overview feed selection before showing the Feed', async () => {
  const calls = [];
  const sandbox = { core: { nextAttention: () => 'fixture-session' },
    vscode: { commands: { executeCommand: async (...args) => calls.push(args) }, window: {} } };
  vm.runInNewContext(ts.transpile(`globalThis.Provider = class { ${methods.get('jumpToNextHand')} }`), sandbox);
  const provider = new sandbox.Provider();
  Object.assign(provider, { sessRowsCache: [], followHead: ref => calls.push(['follow', ref]), setTab: tab => calls.push(['tab', tab]) });
  provider.jumpToNextHand();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.slice(-2), [['follow', null], ['tab', 'feed']]);
});

test('Feed tour ring survives a new payload independently of thought formatting', () => {
  const view = timeline(); view.post(feedMessage([]));
  view.post({ type: 'tour', anchor: 'feed' });
  assert.ok(view.el('tlf-body').classes.has('ring'));
  view.post(feedMessage([{ ts: 1, kind: 'action', label: 'Read' }]));
  assert.ok(view.el('tlf-body').classes.has('ring'));
});

test('Raised-hand toast Open clears an Overview selection before showing the conversation', async () => {
  const calls = [], rows = [{ id: 'fixture-session', title: 'Fixture', attention: { kind: 'input', ts: 1 } }];
  const sandbox = { readSessionListing: async () => ({ sessions: rows }), currentSession: () => 'fixture-session', allSessionRows: r => r, core: { sessionMeta: () => ({ sessions: rows }), isFleetActive: () => true, announceAttention() {}, HAND_RANK: {} },
    vscode: { commands: { executeCommand: async (...args) => calls.push(args) }, window: { showWarningMessage: async () => 'Open' } } };
  vm.runInNewContext(ts.transpile(`globalThis.Provider = class { ${methods.get('postSessions')} }`), sandbox);
  const provider = new sandbox.Provider();
  Object.assign(provider, { attnToasted: new Map(), reviewedSession: 'fixture-session',
    followHead: ref => calls.push(['follow', ref]), setTab: tab => calls.push(['tab', tab]) });
  await provider.postSessions('/workspace', 'fixture-session');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.slice(-2), [['follow', null], ['tab', 'feed']]);
});

test('Feed command and model contracts contain no retired display-only fields or command IDs', () => {
  const pkg = require('../package.json');
  assert.ok(pkg.contributes.commands.some(c => c.command === 'claudeObservatory.showFeed'));
  assert.ok(!pkg.contributes.commands.some(c => c.command === 'claudeObservatory.showAgent'));
  assert.ok(commands.has('claudeObservatory.showFeed'));
  const feed = fs.readFileSync(path.join(__dirname, '../../jetbrains/src/main/kotlin/com/cellobservatory/observatory/model/Feed.kt'), 'utf8');
  assert.doesNotMatch(feed, /lastMessage/);
  const panel = fs.readFileSync(path.join(__dirname, '../../jetbrains/src/main/kotlin/com/cellobservatory/observatory/ui/FeedPanel.kt'), 'utf8');
  assert.doesNotMatch(panel, /diffCache|fun diffPreview|"reasoning" ->/);
  const desc = /var TAB_DESC=\{([\s\S]*?)\n  \};/.exec(script)[1];
  assert.doesNotMatch(desc, /feed:/);
  assert.doesNotMatch(script, /All five side by side/);
});
