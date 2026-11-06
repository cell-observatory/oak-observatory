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
const methods = new Map(), commands = new Map(), functions = new Map();
let script, reviewScript, overviewScript;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'vscode.commands.registerCommand' && ts.isStringLiteral(node.arguments[0]))
    commands.set(node.arguments[0].text, node.arguments[1].getText(ast));
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'TIMELINE_SCRIPT') script = node.initializer.text;
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'OVERVIEW_SCRIPT') overviewScript = node.initializer.head.text + node.initializer.templateSpans.map(s => 'null' + s.literal.text).join('');
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'REVIEW_SCRIPT') reviewScript = node.initializer.text;
  if (ts.isMethodDeclaration(node) && node.parent.name?.getText(ast) === 'TimelineViewProvider')
    methods.set(node.name.getText(ast), node.getText(ast));
  if (ts.isFunctionDeclaration(node) && node.name && node.parent === ast) functions.set(node.name.text, node.getText(ast));
  ts.forEachChild(node, visit);
}
visit(ast);

test('worker log follows its owning session, remains fresh after an end, and skips unchanged polls', () => {
  let stamp = 'first';
  const calls = [], posts = [];
  const sandbox = { core: { workerFeedPaths: () => ['/worker', '/parent'], workerFeedStamp: () => stamp },
    workspaceRoot: () => '/workspace', currentSession: () => 'reviewed-parent', currentMachine: () => undefined, onMachine: () => [], Date,
    spawnCliJson: (args, cwd, done) => {
      calls.push(args);
      done({ entries: [{ ts: 1000, label: 'worker said' }], mode: 'audit', lastTs: 1000 });
    } };
  vm.runInNewContext(ts.transpile(`globalThis.Provider = class { ${methods.get('closeProcessFollow')}
    ${methods.get('fetchAgentFeed')} }`), sandbox);
  const p = new sandbox.Provider();
  Object.assign(p, { view: { visible: true, webview: { postMessage: m => posts.push(m) } }, showing: { feed: true },
    headRef: { kind: 'agent', id: 'worker-id', label: 'Worker', session: 'owning-parent', cwd: '/worker-project' }, agentFeedLimit: 60,
    agentFeedRequest: 0, conversationSelection: () => 'reviewed-parent', buildFeedPatches: () => ({}), sessRowsCache: [] });
  p.fetchAgentFeed();
  assert.equal(calls[0][calls[0].indexOf('--session') + 1], 'owning-parent');
  assert.equal(calls[0][calls[0].indexOf('--root') + 1], '/worker-project');
  p.fetchAgentFeed();
  assert.equal(calls.length, 1);
  stamp = 'resumed';
  p.fetchAgentFeed();
  assert.equal(calls.length, 2, 'a new worker turn after completion reopens its log');
  assert.equal(posts.length, 2);
});

test('remote worker log uses its saved machine without local paths or rapid polls', () => {
  const calls = [], posts = [];
  const sandbox = { core: { workerFeedPaths: () => assert.fail('remote log must not resolve a local transcript') },
    workspaceRoot: () => '/local/work', currentSession: () => 'local-parent', currentMachine: () => undefined, onMachine: () => [], Date,
    spawnCliJson: (args, cwd, done) => { calls.push(args); done({ workerLogVersion: 1, entries: [], mode: 'live' }); } };
  vm.runInNewContext(ts.transpile(`globalThis.Provider = class { ${methods.get('closeProcessFollow')}
    ${methods.get('fetchAgentFeed')} }`), sandbox);
  const p = new sandbox.Provider();
  Object.assign(p, { view: { visible: true, webview: { postMessage: m => posts.push(m) } }, showing: { feed: true },
    headRef: { kind: 'agent', id: 'w1', label: 'Worker', session: 'remote-parent', machine: 'build-box' }, agentFeedLimit: 60,
    agentFeedRequest: 0, conversationSelection: () => 'local-parent', buildFeedPatches: () => assert.fail('no local diff lookup') });
  p.fetchAgentFeed(); p.fetchAgentFeed();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][calls[0].indexOf('--machine') + 1], 'build-box');
  assert.equal(calls[0][calls[0].indexOf('--session') + 1], 'remote-parent');
  assert.ok(!calls[0].includes('--root'));
  assert.ok(p.agentFeedNextAt >= Date.now() + 9000);
  p.agentFeedNextAt = 0;
  p.fetchAgentFeed();
  assert.equal(calls.length, 2);
  assert.match(posts[0].followed, /build-box/);
});

function timeline(src = script) {
  const nodes = new Map(), posted = [];
  let listener, bodyWrites = 0;
  const scrolls = [];
  function el(id) {
    if (nodes.has(id)) return nodes.get(id);
    let html = '';
    const style = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; }, getPropertyValue() { return ''; } };
    const node = {
      style, textContent: '', classes: new Set(), classList: { add(c) { node.classes.add(c); }, remove(c) { node.classes.delete(c); }, toggle() {}, contains(c) { return node.classes.has(c); } },
      // Kept, so a test can fire what the script listens for (`on.click`, `on.input`).
      on: {}, addEventListener(type, cb) { (node.on[type] ||= []).push(cb); }, removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
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
  vm.runInNewContext(src.replace(/\}\)\(\);\s*$/, 'globalThis.evalSession = code => eval(code);})();'), sandbox);
  return { run: code => sandbox.evalSession(code), el, posted, scrolls, post: (data) => listener({ data }), writes: () => bodyWrites };
}

// Every other machine's sessions, from the local index (0.11.0): the list asks for them as it opens and draws them under
// each machine's name after this machine's, searched as these are; a pick asks the host to show one read-only.
test('Timeline session list: other machines\' sessions merged newest first; a pick asks the host for it', () => {
  const view = timeline();
  const fire = (id, type, ev) => (view.el(id).on[type] ?? []).forEach((cb) => cb({ stopPropagation() {}, preventDefault() {}, ...ev }));
  view.post({ type: 'sessions', rows: [{ id: 'here-1', title: 'Here and now', workspace: '/w', lastActiveMs: 1, edits: 0, tokens: 0 }], current: '' });
  fire('rq-schip', 'click', { target: { closest: () => null } });
  assert.ok(view.posted.some((m) => m.type === 'wantMachines'), 'asked for as the list opens');
  view.post({ type: 'machines', machines: [{ label: 'build-box', host: 'b0b0b0b0b0b0', syncedAt: Date.now(), sessions: [
    { id: 'remote-one', title: 'Tune the remote parser', workspace: '~/remote', lastActiveMs: 2, edits: 2, tokens: 120, durationMs: 0, agent: 'claude', model: 'Opus 4.8' }] }] });
  const html = view.el('rq-slist').innerHTML;
  assert.ok(html.indexOf('data-sid="here-1"') >= 0 && html.indexOf('data-msid="remote-one"') < html.indexOf('data-sid="here-1"'), 'newest across machines');
  assert.match(html, /build-box · synced \d\d:\d\d:\d\d \(1\)/, 'under its name, with when oak sync brought it');
  assert.match(html, /data-msid="remote-one" data-mhost="b0b0b0b0b0b0"/);
  // Searched as this machine's are: a match there alone is no "no session matches".
  fire('rq-slist', 'input', { target: { id: 'rq-sq', value: 'remote parser' } });
  assert.match(view.el('rq-srows').innerHTML, /data-msid="remote-one"/);
  assert.doesNotMatch(view.el('rq-srows').innerHTML, /no session matches/);
  fire('rq-slist', 'input', { target: { id: 'rq-sq', value: 'nothing like it' } });
  assert.match(view.el('rq-srows').innerHTML, /no session matches/, 'positive control');
  // A pick names the machine and the session; the host shows what is known of it.
  fire('rq-slist', 'click', { target: { closest: (sel) => sel === '[data-msid]' ? { getAttribute: (a) => ({ 'data-msid': 'remote-one', 'data-mhost': 'b0b0b0b0b0b0' })[a] } : null } });
  assert.deepEqual(JSON.parse(JSON.stringify(view.posted.at(-1))), { type: 'pickSynced', id: 'remote-one', host: 'b0b0b0b0b0b0' });
});

// Every saved machine's sessions (oak machine list): each under its label after this machine's, as the host's last read of
// it gave them, with when that was; one that could not be read says why and when it last was, one still being read says
// so, and none of it waits for a slow machine. A pick reviews the session there.
test('Timeline session list: each saved machine\'s sessions under its label with their age, or why they could not be read', () => {
  const view = timeline();
  const fire = (id, type, ev) => (view.el(id).on[type] ?? []).forEach((cb) => cb({ stopPropagation() {}, preventDefault() {}, ...ev }));
  view.post({ type: 'sessions', rows: [{ id: 'here-1', title: 'Here and now', workspace: '/w', lastActiveMs: 1, edits: 0, tokens: 0 }], current: '' });
  fire('rq-schip', 'click', { target: { closest: () => null } });
  const now = Date.now(), hms = (t) => new Date(t).toTimeString().slice(0, 8);
  view.post({ type: 'saved', error: null, machines: [
    { label: 'lab-a', readAt: now, error: null, reading: false, listing: { fromIndex: false, sessions: [
      { id: 'ra-1', title: 'Tidy the remote lexer', workspace: '~/lab', lastActiveMs: now, edits: 1, tokens: 10, active: true }] } },
    { label: 'lab-b', readAt: now - 1000, error: 'ssh: connect to host lab-b port 22: Connection refused', reading: false, listing: null },
    { label: 'lab-c', readAt: null, error: null, reading: true, listing: null },
    { label: 'lab-d', readAt: now, error: null, reading: false, listing: { fromIndex: true, syncedAt: now - 2000, sessions: [] } }] });
  // The index's records of lab-a are not listed again under it; another machine's still are.
  view.post({ type: 'machines', machines: [
    { label: 'lab-a', host: 'a0a0a0a0a0a0', syncedAt: now, sessions: [{ id: 'ra-old', title: 'From lab-a records', lastActiveMs: 1 }] },
    { label: 'far-box', host: 'f0f0f0f0f0f0', syncedAt: now, sessions: [{ id: 'fb-1', title: 'From far-box records', lastActiveMs: 1 }] }] });
  const html = view.el('rq-slist').innerHTML;
  assert.ok(html.indexOf('data-sid="here-1"') >= 0 && html.indexOf('data-rsid="ra-1"') < html.indexOf('data-sid="here-1"'), 'newest across machines');
  assert.ok(html.includes(`lab-a · read ${hms(now)} (1)`), 'under its label, with when it was read');
  assert.match(html, /data-rsid="ra-1" data-rmach="lab-a"/);
  assert.ok(html.includes(`lab-b · could not list sessions — ssh: connect to host lab-b port 22: Connection refused · last read ${hms(now - 1000)}`), 'why, and when it last was');
  assert.match(html, /lab-c · has not answered yet · reading again…/);
  assert.ok(html.includes(`lab-d · from its records, synced ${hms(now - 2000)} (0)`) && html.includes('no sessions'));
  assert.doesNotMatch(html, /data-msid="ra-old"/, 'listed once');
  assert.match(html, /data-msid="fb-1"/, 'control: a machine not read over ssh keeps its records\' group');
  // The pick names the machine; the chip then says the session under review is there.
  fire('rq-slist', 'click', { target: { closest: (sel) => sel === '[data-rsid]' ? { getAttribute: (a) => ({ 'data-rsid': 'ra-1', 'data-rmach': 'lab-a' })[a] } : null } });
  assert.deepEqual(JSON.parse(JSON.stringify(view.posted.at(-1))), { type: 'pickRemote', id: 'ra-1', machine: 'lab-a' });
  view.post({ type: 'sessions', rows: [], current: 'ra-1', machine: 'lab-a' });
  assert.equal(view.el('rq-sname').textContent, 'Tidy the remote lexer · on lab-a');
  // Saved machines that could not be listed at all say why.
  view.post({ type: 'saved', error: 'herdr could not read its machines', machines: [] });
  fire('rq-schip', 'click', { target: { closest: () => null } });
  assert.match(view.el('rq-slist').innerHTML, /could not read the saved machines — herdr could not read its machines/);
});

// A saved machine's Review retains its list beneath a short locality note.
test('Review panel: remote rows retain counts, actions and locality note', () => {
  const view = timeline(reviewScript);
  view.post({ type: 'review', machine: 'lab-<a>', data: { units: [{id:7, file:'/remote/a.ts', rel:'a.ts', status:'pending', added:3, removed:1, members:1}], pending:1, note:'Read on lab-<a>' } });
  const html = view.el('rv').innerHTML;
  assert.match(html, /data-open="7"/);
  assert.match(html, /matching mount first, then an SSH window/);
  assert.match(html, /on lab-&lt;a&gt;/);
  assert.ok(html.includes('data-act="openAllStacked"'));
  assert.ok(html.includes('data-diff="7"'));
  view.post({ type: 'review', data: null });
  assert.match(view.el('rv').innerHTML, /No session is under observation yet/);
});

// A saved machine's session: Stats shows what its listing says awaits review there, and none of this machine's counts.
test('Stats panel: a saved machine\'s session shows what awaits review there, named by its machine', () => {
  const sandbox = { getNonce: () => 'N', CODICON_STYLE: '', core: require('../../core/dist') };
  vm.runInNewContext(`${ts.transpileModule(functions.get('combinedShell'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}; globalThis.html = combinedShell();`, sandbox);
  // The plots need an SVG this fake DOM does not have: their load error is posted, and any other one fails the test.
  const view = timeline(`var setInterval = function(){}; try { ${/<script nonce="N">([\s\S]*?)<\/script>/.exec(sandbox.html)[1]} } catch (e) { acquireVsCodeApi().postMessage({ loadError: String(e.stack) }); }`);
  for (const m of view.posted.filter((x) => x.loadError)) assert.match(m.loadError, /at renderPlot /);
  view.post({ type: 'counts', c: { pending: 4, kept: 1, undone: 1 }, session: 's-here', sessionTitle: 'Here', t: null, v: null });
  assert.deepEqual([view.el('rv-pending').textContent, view.el('rv-kept').textContent, view.el('nb-session').textContent], [4, 1, 'Here'], 'control: this machine\'s counts');
  view.post({ type: 'counts', c: null, remote: { machine: 'lab-a', edits: 3, pending: 2 }, session: 'ra-1', sessionTitle: 'There', t: null, v: null });
  assert.deepEqual([view.el('rv-pending').textContent, view.el('rv-kept').textContent, view.el('rv-undone').textContent], [2, '—', '—'], 'the last session\'s counts are not left standing');
  assert.equal(view.el('rv-progress').textContent, 'on lab-a — 2 of 3 edits await review there; Keep and Undo run there, from the Overview and the Timeline');
  assert.equal(view.el('nb-session').textContent, 'There · on lab-a');
  view.post({ type: 'counts', c: null, remote: { machine: 'lab-a' }, session: 'ra-1', usageNote: 'Session usage on lab-a',
    t: { available: true, input: 900, output: 90 }, tt: { available: true, input: 1800, output: 180, agents: 1 } });
  assert.equal(view.el('tk-in').textContent, '900');
  assert.equal(view.el('tk-scope').textContent, 'Session usage on lab-a');
  assert.equal(view.el('tk-own-cap').style.display, '');
  assert.equal(view.el('tk-tree-cap').textContent, 'with 1 agent');
  assert.equal(view.el('tk-tin').textContent, '1.8k');
  assert.match(sandbox.html, /Account history · this machine/);
  assert.match(sandbox.html, /Account usage · local context/);
});

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
  const sandbox = { timelineShell: () => '', workspaceRoot: () => '/workspace', currentSession: () => 'fixture-session', currentMachine: () => undefined,
    spawnCliJson: (args) => requests.push(args) };
  vm.runInNewContext(ts.transpile(`globalThis.Provider = class {
    ${methods.get('resolveWebviewView')}
    ${methods.get('closeProcessFollow')}
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

// The deletion ghost cut its head at 59 UTF-16 units, so a removed line with an emoji there showed part of it, or half of
// a surrogate pair. It ends where a character does now, and reads byte for byte as JetBrains' ghostLabel (GhostLabelTest
// pins the same lines).
test('The deletion ghost cuts its head where a character ends, as JetBrains does', () => {
  const core = require('../../core/dist');
  const ghostText = vm.runInNewContext(`${ts.transpileModule(functions.get('ghostText'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}; ghostText`, { core });
  const fam = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}';
  assert.equal(ghostText(['a'.repeat(60)]), `− ${'a'.repeat(60)}`, 'a head of 60 is whole');
  assert.equal(ghostText(['b'.repeat(61)]), `− ${'b'.repeat(59)}…`, 'a head of 61 is 59 and the ellipsis');
  assert.equal(ghostText([`${'c'.repeat(52)}${fam}${'d'.repeat(20)}`]), `− ${'c'.repeat(52)}…`, 'a family across the cut is left out whole');
  assert.equal(ghostText([`${'c'.repeat(48)}${fam}${'d'.repeat(20)}`]), `− ${'c'.repeat(48)}${fam}…`, 'and one before it is kept whole');
  assert.equal(ghostText([`${'e'.repeat(58)}\u{1F1EF}\u{1F1F5}${'f'.repeat(9)}`, 'second']), `− ${'e'.repeat(58)}… …(+1)`, 'a flag across the cut too');
});

// A Trojan Source line: a right-to-left override and isolates make a check read as a comment, and a zero-width space hides
// in a name. Drawn as they are, the webview shows them as nothing and reorders the line around them. Where OAK renders a
// file's text itself (the review bubble, the Feed's inline diff, the deletion ghost) each shows as the mark naming it.
const TROJAN = '    /*\u202e } \u2066if (isAdmin)\u2069 \u2066 begin admins only */ ok\u200bname';
const TROJAN_SHOWN = '    /*⟨U+202E⟩ } ⟨U+2066⟩if (isAdmin)⟨U+2069⟩ ⟨U+2066⟩ begin admins only */ ok⟨U+200B⟩name';
const HIDDEN_RE = /[\u061c\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
test('A file\'s hidden characters show as marks in the review bubble, the Feed\'s inline diff and the deletion ghost', () => {
  const core = require('../../core/dist');
  const consts = {};
  (function find(node) {
    if (ts.isVariableDeclaration(node) && ['DIFF_SPAN', 'HIDDEN_SPAN'].includes(node.name.getText(ast)))
      consts[node.name.getText(ast)] = vm.runInNewContext(`(${node.initializer.getText(ast)})`);
    ts.forEachChild(node, find);
  })(ast);
  const fn = (name) => vm.runInNewContext(`${ts.transpileModule(functions.get(name), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}; ${name}`, { core, ...consts });
  // The review bubble (a MarkdownString with HTML on).
  const bubble = fn('diffHtml')(['--- a/x.js', '+++ b/x.js', '@@ -1 +1 @@', '-ok', `+${TROJAN}`].join('\n'));
  // …whose HTML is one block, so a line of the file is never read as Markdown (an image that loads, a link, emphasis).
  const readme = fn('diffHtml')(['--- a/README.md', '+++ b/README.md', '@@ -1 +1 @@', '-# x', '+# x ![build](https://img.example/b.svg) [docs](https://docs.example) **b** `c`'].join('\n'));
  assert.ok(readme.startsWith('<div>') && readme.endsWith('</div>') && !readme.includes('\n'), `one HTML block, on one line: ${readme}`);
  assert.ok(readme.includes('![build](https://img.example/b.svg) [docs](https://docs.example) **b** `c`'.replace(/ /g, '\u00a0')), 'the line is in it as written');
  assert.doesNotMatch(bubble, HIDDEN_RE, 'none is left to reorder the line');
  for (const mark of ['⟨U+202E⟩', '⟨U+2066⟩', '⟨U+2069⟩', '⟨U+200B⟩'])
    assert.ok(bubble.includes(`<span style="${consts.HIDDEN_SPAN}">${mark}</span>`), `${mark} shows, muted, in the bubble`);
  // The deletion ghost: marks after the cut, as JetBrains' ghostLabel.
  assert.equal(fn('ghostText')([TROJAN]), `− ${TROJAN_SHOWN.trim()}`);
  assert.equal(fn('ghostText')([`${'a'.repeat(58)}\u202e${'b'.repeat(10)}`]), `− ${'a'.repeat(58)}⟨U+202E⟩…`, 'a mark is never cut');
  // The Feed: the host sends the patch with marks, and the webview dims them.
  const sandbox = { core: { ...core, findRecord: () => ({ id: 7 }), coloredDiff: () => ['--- a/x.js', '+++ b/x.js', '@@ -1 +1 @@', '-ok', `+${TROJAN}`].join('\n') } };
  vm.runInNewContext(ts.transpile(`globalThis.Provider = class { ${methods.get('buildFeedPatches')} }`), sandbox);
  const patches = new sandbox.Provider().buildFeedPatches('fixture-session', [{ editId: 7 }]);
  assert.ok(patches[7].includes(TROJAN_SHOWN) && !HIDDEN_RE.test(patches[7]), `the host sends marks: ${JSON.stringify(patches[7])}`);
  const view = timeline();
  view.post({ type: 'tab', tab: 'feed' });
  view.post(feedMessage([{ ts: 1, kind: 'action', label: 'Edit', target: 'x.js', category: 'edit', editId: 7 }], { patches }));
  const feed = view.el('tl-feed').innerHTML;
  for (const mark of ['⟨U+202E⟩', '⟨U+2066⟩', '⟨U+2069⟩', '⟨U+200B⟩'])
    assert.ok(feed.includes(`<span class="tlf-hid">${mark}</span>`), `${mark} shows, dimmed, in the Feed: ${feed}`);
  // A joiner hidden inside an identifier shows too, on each of them; an emoji, an Indic conjunct and a Persian word keep theirs.
  const inIdentifier = ['if (is\u200dadmin) {}', 'foo\u200cbar = 1', 'a\u200d1 += 2', 'let isAdmin\u200d = true;'];
  const builtWith = ['f = "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}"', 'k = "\u0915\u094d\u200d\u0937"', 'p = "\u06a9\u062a\u0627\u0628\u200c\u0647\u0627"'];
  const marked = (l) => l.replace(/[\u200c\u200d]/g, (c) => core.hiddenMark(c));
  const joinedPatch = ['--- a/x.js', '+++ b/x.js', '@@ -1 +1,6 @@', ...[...inIdentifier, ...builtWith].map((l) => `+${l}`)].join('\n');
  const joinedBubble = fn('diffHtml')(joinedPatch);
  for (const l of inIdentifier) assert.ok(joinedBubble.includes(marked(l).replace(/ /g, '\u00a0').replace(/⟨U\+[0-9A-F]{4}⟩/g, (m) => `<span style="${consts.HIDDEN_SPAN}">${m}</span>`)), `the bubble shows the joiner in ${JSON.stringify(l)}: ${joinedBubble}`);
  for (const l of builtWith) assert.ok(joinedBubble.includes(l.replace(/ /g, '\u00a0').replace(/"/g, '"')), `the bubble keeps ${JSON.stringify(l)}`);
  for (const l of inIdentifier) assert.equal(fn('ghostText')([l]), `− ${marked(l)}`, 'the deletion ghost shows it');
  for (const l of builtWith) assert.equal(fn('ghostText')([l]), `− ${l}`, 'and keeps an emoji, a conjunct and a Persian word as they are');
  const joinedSandbox = { core: { ...core, findRecord: () => ({ id: 8 }), coloredDiff: () => joinedPatch } };
  vm.runInNewContext(ts.transpile(`globalThis.Provider = class { ${methods.get('buildFeedPatches')} }`), joinedSandbox);
  const joinedPatches = new joinedSandbox.Provider().buildFeedPatches('fixture-session', [{ editId: 8 }]);
  const joinedView = timeline();
  joinedView.post({ type: 'tab', tab: 'feed' });
  joinedView.post(feedMessage([{ ts: 1, kind: 'action', label: 'Edit', target: 'x.js', category: 'edit', editId: 8 }], { patches: joinedPatches }));
  const joinedFeed = joinedView.el('tl-feed').innerHTML;
  for (const l of inIdentifier) assert.ok(joinedFeed.includes(marked(l).replace(/⟨U\+[0-9A-F]{4}⟩/g, (m) => `<span class="tlf-hid">${m}</span>`)), `the Feed shows the joiner in ${JSON.stringify(l)}: ${joinedFeed}`);
  for (const l of builtWith) assert.ok(joinedFeed.includes(l.replace(/"/g, '&quot;')), `the Feed keeps ${JSON.stringify(l)}: ${joinedFeed}`);
});

// More characters a webview draws as nothing or as a blank (the soft hyphen, the Hangul fillers) and the tag characters,
// which spell out text no one sees unless they finish a flag: each shows as its mark in the bubble, the deletion ghost and
// the Feed, a tag's with five digits, and the usage view drops each from a machine's label. A flag and Hangul stay.
test('The soft hyphen, the Hangul fillers and stray tag characters show as marks, and the flags and Hangul stay', () => {
  const core = require('../../core/dist');
  const consts = {};
  (function find(node) {
    if (ts.isVariableDeclaration(node) && ['DIFF_SPAN', 'HIDDEN_SPAN'].includes(node.name.getText(ast)))
      consts[node.name.getText(ast)] = vm.runInNewContext(`(${node.initializer.getText(ast)})`);
    ts.forEachChild(node, find);
  })(ast);
  const fn = (name) => vm.runInNewContext(`${ts.transpileModule(functions.get(name), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}; ${name}`, { core, ...consts });
  const hidden = ['\u00ad', '\u3164', '\u{E0041}', '\u{E007F}'];
  const scotland = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
  const line = `let a${hidden.join('a')} = "${scotland} \u1112\u1161\u11ab";`;
  const marks = hidden.map((ch) => core.hiddenMark(ch));
  assert.deepEqual(marks, ['⟨U+00AD⟩', '⟨U+3164⟩', '⟨U+E0041⟩', '⟨U+E007F⟩'], 'control: core names each');
  const patch = ['--- a/x.js', '+++ b/x.js', '@@ -1 +1 @@', '-ok', `+${line}`].join('\n');
  const bubble = fn('diffHtml')(patch);
  for (const mark of marks) assert.ok(bubble.includes(`<span style="${consts.HIDDEN_SPAN}">${mark}</span>`), `${mark} shows, muted, in the bubble: ${bubble}`);
  assert.ok(bubble.includes(scotland) && bubble.includes('\u1112\u1161\u11ab'), 'the flag and the jamo stay');
  assert.equal(fn('ghostText')([line]), `− ${core.revealHidden(line)}`, 'the deletion ghost shows each');
  assert.ok(core.revealHidden(line).includes(scotland), 'control: with the flag as it is');
  const sandbox = { core: { ...core, findRecord: () => ({ id: 9 }), coloredDiff: () => patch } };
  vm.runInNewContext(ts.transpile(`globalThis.Provider = class { ${methods.get('buildFeedPatches')} }`), sandbox);
  const patches = new sandbox.Provider().buildFeedPatches('fixture-session', [{ editId: 9 }]);
  const view = timeline();
  view.post({ type: 'tab', tab: 'feed' });
  view.post(feedMessage([{ ts: 1, kind: 'action', label: 'Edit', target: 'x.js', category: 'edit', editId: 9 }], { patches }));
  const feed = view.el('tl-feed').innerHTML;
  for (const mark of marks) assert.ok(feed.includes(`<span class="tlf-hid">${mark}</span>`), `${mark} shows, dimmed, in the Feed: ${feed}`);
  assert.ok(feed.includes(scotland), 'and the flag stays');
  // The usage view's machine label: core's class, which needs the u flag.
  const decl = /function plainLabel\(s\)\{ return String\(s\)\.replace\(\/\$\{core\.PLAIN_LABEL_SOURCE\}\/(\w*),''\); \}/.exec(source);
  assert.ok(decl, 'the usage view cleans a machine\'s label with core\'s class');
  const label = vm.runInNewContext(`(function plainLabel(s){ return String(s).replace(/${core.PLAIN_LABEL_SOURCE}/${decl[1]},''); })`);
  assert.equal(label(`build${hidden.join('')}-box`), 'build-box');
  assert.equal(label(`box ${scotland} \ud55c\uad6d`), `box ${scotland} \ud55c\uad6d`);
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
    readSessionListing: async () => ({ sessions: [] }), workspaceRoot: () => '/workspace', currentSession: () => null,
    vscode: { commands: { executeCommand: async (...args) => calls.push(args) }, window: {} } };
  vm.runInNewContext(ts.transpile(`globalThis.Provider = class { ${methods.get('jumpToNextHand')} }`), sandbox);
  const provider = new sandbox.Provider();
  Object.assign(provider, { followHead: ref => calls.push(['follow', ref]), setTab: tab => calls.push(['tab', tab]) });
  await provider.jumpToNextHand();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.slice(-2), [['follow', null], ['tab', 'feed']]);
});

test('Next raised hand reads who is waiting now, not the Timeline cache', async () => {
  // The Timeline caches its listing only while it is visible. A session that answered since still holds its
  // hand in that cache; the key must act on a listing read when it is pressed.
  const said = [], pinned = [];
  let listing = { sessions: [{ id: 'fixture-answered', title: 'Answered', attention: null },
    { id: 'fixture-waiting', title: 'Waiting', attention: { kind: 'permission', message: 'Bash', ts: 5 } }] };
  const reads = [];
  const sandbox = { core: { nextAttention: (rows) => rows.find((r) => r.attention)?.id ?? null, attentionLabel: () => 'needs your permission',
    nobodyWaitingHere: require('../../core/dist').nobodyWaitingHere },
    readSessionListing: async (cwd, session) => { reads.push([cwd, session]); return listing; },
    workspaceRoot: () => '/workspace', currentSession: () => 'fixture-pinned',
    vscode: { commands: { executeCommand: async (...args) => { if (args[0] === 'claudeObservatory.pinSession') pinned.push(args[1]); } },
      window: { showWarningMessage: async (m) => said.push(['warn', m]), showInformationMessage: async (m) => said.push(['info', m]), setStatusBarMessage: () => {} } } };
  vm.runInNewContext(ts.transpile(`globalThis.Provider = class { ${methods.get('jumpToNextHand')} }`), sandbox);
  const provider = new sandbox.Provider();
  Object.assign(provider, { sessRowsCache: [{ id: 'fixture-answered', attention: { kind: 'permission', message: 'Bash', ts: 1 } }],
    sessionShown: null, followHead() {}, setTab() {} });
  await provider.jumpToNextHand();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reads, [['/workspace', 'fixture-pinned']], 'one listing, read for the workspace and the pinned session');
  assert.deepEqual(pinned, ['fixture-waiting'], 'it jumps to the session waiting now');
  // A listing that loaded with no hand says nobody is waiting; one that failed says it could not tell.
  listing = { sessions: [{ id: 'fixture-answered', title: 'Answered', attention: null }] };
  await provider.jumpToNextHand();
  listing = null;
  await provider.jumpToNextHand();
  // Another machine's hands are answered there, so the key never jumps to one: it says where they are listed (a turn's
  // end there aside).
  listing = { sessions: [{ id: 'fixture-answered', title: 'Answered', attention: null }],
    syncedHands: [{ id: 'fixture-remote', kind: 'permission', host: 'aaaaaaaaaaaa', machine: 'build-box' }, { id: 'fixture-done', kind: 'idle-done', host: 'aaaaaaaaaaaa', machine: 'build-box' }] };
  await provider.jumpToNextHand();
  assert.deepEqual(said, [['info', 'OAK: nobody is waiting on you'], ['warn', 'OAK: could not read which sessions are waiting — the session list did not load'],
    ['info', 'OAK: nobody here is waiting on you · 1 on other machine: the session selector lists it']]);
  assert.deepEqual(pinned, ['fixture-waiting'], 'and neither jumps');
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
  const sandbox = { readSessionListing: async () => ({ sessions: rows }), currentSession: () => 'fixture-session', allSessionRows: r => r, core: { sessionMeta: () => ({ sessions: rows }), isFleetActive: () => true, announceAttention() {}, HAND_RANK: {}, whenHandDue: (id, a, show) => show() },
    vscode: { commands: { executeCommand: async (...args) => calls.push(args) }, window: { showWarningMessage: async () => 'Open' } } };
  vm.runInNewContext(ts.transpile(`globalThis.Provider = class { ${methods.get('postSessions')} }`), sandbox);
  const provider = new sandbox.Provider();
  Object.assign(provider, { attnToasted: new Map(), reviewedSession: 'fixture-session',
    followHead: ref => calls.push(['follow', ref]), setTab: tab => calls.push(['tab', tab]) });
  await provider.postSessions('/workspace', 'fixture-session');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.slice(-2), [['follow', null], ['tab', 'feed']]);
});

test('A raised hand toasts when core says it is due, once, and not before', async () => {
  // core.whenHandDue holds a permission prompt for the desktop's wait (its own test covers the wait); the
  // toast must ride it rather than pop as soon as the listing shows the hand.
  const toasts = [], due = [];
  const rows = [{ id: 'fixture-waiting', title: 'Waiting', attention: { kind: 'permission', message: 'Bash', ts: 5 } }];
  const sandbox = { readSessionListing: async () => ({ sessions: rows }), currentSession: () => 'fixture-waiting', allSessionRows: r => r,
    core: { isFleetActive: () => true, announceAttention() {}, HAND_RANK: {}, whenHandDue: (id, a, show) => due.push({ id, a, show }) },
    vscode: { commands: { executeCommand: async () => {} }, window: { showWarningMessage: async (m) => { toasts.push(m); } } } };
  vm.runInNewContext(ts.transpile(`globalThis.Provider = class { ${methods.get('postSessions')} }`), sandbox);
  const provider = new sandbox.Provider();
  Object.assign(provider, { attnToasted: new Map(), reviewedSession: 'fixture-waiting', followHead() {}, setTab() {} });
  await provider.postSessions('/workspace', 'fixture-waiting');
  await provider.postSessions('/workspace', 'fixture-waiting');
  assert.deepEqual(toasts, [], 'nothing pops before core says the hand is due');
  assert.deepEqual(due.map(({ id, a }) => [id, a.kind, a.ts]), [['fixture-waiting', 'permission', 5]], 'the hand goes to core once, however many reads');
  due[0].show();
  assert.deepEqual(toasts, ['OAK: “Waiting” needs your permission — Bash']);
});

// Another machine's raised hand rides the listing (`syncedHands`, from that machine's records): announced naming its
// machine, toasted at once (it came with an oak sync run, and whether it stands is that machine's to say), counted, and
// posted to the list, where Open says what is known of the session there.
test('Another machine\'s raised hand is announced and toasted once, naming its machine, counted and listed', async () => {
  const toasts = [], announced = [], due = [], counts = [], posted = [], opened = [];
  const hand = { id: 'remote-wait', title: 'Remote', agent: 'claude', workspace: '~/app', machine: 'build-box', kind: 'permission', message: 'Bash', ts: 7,
    waitingMs: 1, waitedTodayMs: 1, question: null, current: false, origin: 'synced', host: 'aaaaaaaaaaaa', syncedAt: 8, publishedAt: 6 };
  const rows = [{ id: 'here', title: 'Here', attention: null }];
  const sandbox = { readSessionListing: async () => ({ sessions: rows, syncedHands: [hand] }), currentSession: () => 'here', currentMachine: () => undefined, allSessionRows: r => r,
    core: { isFleetActive: () => true, announceAttention: (r) => announced.push(r), HAND_RANK: { permission: 0 }, attentionLabel: () => 'needs your permission',
      whenHandDue: (id, a, show, now, host) => { due.push({ id, host }); if (host) show(); } },
    vscode: { commands: { executeCommand: async () => {} }, window: { showWarningMessage: async (m) => { toasts.push(m); return 'Open'; } } } };
  vm.runInNewContext(ts.transpile(`globalThis.Provider = class { ${methods.get('postSessions')} }`), sandbox);
  const provider = new sandbox.Provider();
  Object.assign(provider, { attnToasted: new Map(), reviewedSession: 'here', followHead() {}, setTab() {}, onHandsChanged: (n) => counts.push(n),
    view: { webview: { postMessage: (m) => posted.push(m) } }, openSyncedHand: async (host, id) => opened.push([host, id]) });
  await provider.postSessions('/workspace', 'here');
  await provider.postSessions('/workspace', 'here');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(announced.filter((r) => r.host).map((r) => [r.id, r.host, r.machine, r.attention.kind, r.attention.ts]), [['remote-wait', 'aaaaaaaaaaaa', 'build-box', 'permission', 7], ['remote-wait', 'aaaaaaaaaaaa', 'build-box', 'permission', 7]], 'core keeps it to once');
  assert.deepEqual(due, [{ id: 'remote-wait', host: 'aaaaaaaaaaaa' }], 'toasted once, however many reads');
  assert.deepEqual(toasts, ['OAK: “Remote” on build-box needs your permission — Bash']);
  assert.deepEqual(opened, [['aaaaaaaaaaaa', 'remote-wait']], 'Open says what is known of it there');
  assert.deepEqual(counts, [1, 1], 'the chip and the status bar count it');
  assert.deepEqual(posted.at(-1).syncedHands.map((h) => [h.id, h.machine, h.handRank]), [['remote-wait', 'build-box', 0]]);
});

test('Timeline session list: another machine\'s raised hand needs you, on its machine, and a pick asks the host for it', () => {
  const view = timeline();
  const fire = (id, type, ev) => (view.el(id).on[type] ?? []).forEach((cb) => cb({ stopPropagation() {}, preventDefault() {}, ...ev }));
  const now = Date.now();
  view.post({ type: 'sessions', rows: [{ id: 'here-1', title: 'Here and now', workspace: '/w', lastActiveMs: 1, edits: 0, tokens: 0, attention: { kind: 'input', message: '', ts: now }, handRank: 2 }], current: '',
    syncedHands: [{ id: 'remote-wait', title: 'Profile the import', agent: 'claude', workspace: '~/app', machine: 'build-box', host: 'aaaaaaaaaaaa', kind: 'permission', message: 'Bash', ts: now, handRank: 0, syncedAt: now }] });
  assert.equal(view.el('rq-swait').textContent, '⚠ 2', 'the chip counts both');
  fire('rq-schip', 'click', { target: { closest: () => null } });
  const html = view.el('rq-slist').innerHTML;
  assert.match(html, /needs you \(2\)/);
  assert.ok(html.indexOf('data-msid="remote-wait"') < html.indexOf('data-sid="here-1"'), 'ranked by kind: a permission prompt first');
  assert.match(html, /data-msid="remote-wait" data-mhost="aaaaaaaaaaaa"[^>]*>.*permission · Bash · .*<span class="rq-agentbadge" title="The machine this session waits on">build-box<\/span>/);
  assert.match(html, /data-msid="remote-wait" data-mhost="aaaaaaaaaaaa" data-mhand="1"/, 'marked as a hand');
  fire('rq-slist', 'click', { target: { closest: (sel) => sel === '[data-msid]' ? { getAttribute: (a) => ({ 'data-msid': 'remote-wait', 'data-mhost': 'aaaaaaaaaaaa', 'data-mhand': '1' })[a] } : null } });
  assert.deepEqual(JSON.parse(JSON.stringify(view.posted.at(-1))), { type: 'pickSynced', id: 'remote-wait', host: 'aaaaaaaaaaaa', hand: true });
});

// A pick of another machine's session (from the list, or from its raised hand) reads the machines' sessions again when the
// list last read before that session came; a hand whose session even that read lists not (one pulled here is listed with
// this machine's) says so, as JetBrains does; a pick from the list stays quiet.
test('Opening another machine\'s hand reads its sessions again when they predate it, and says when none lists it', async () => {
  const said = [], opened = [], reads = [];
  let listings = [];
  const sandbox = { workspaceRoot: () => '/workspace', process: { cwd: () => '/workspace' },
    readMachineListings: async (cwd) => { reads.push(cwd); return listings; },
    openSyncedSession: async (m, r) => opened.push([m.host, r.id]),
    vscode: { window: { showInformationMessage: async (m) => said.push(m) } } };
  vm.runInNewContext(ts.transpile(`globalThis.Provider = class { ${methods.get('openSyncedHand')} }`), sandbox);
  const provider = new sandbox.Provider();
  const machine = (sessions) => ({ host: 'aaaaaaaaaaaa', label: 'build-box', sessions: sessions.map((id) => ({ id })) });
  provider.machinesShown = [machine(['older'])];
  listings = [machine(['older', 'newer'])];
  await provider.openSyncedHand('aaaaaaaaaaaa', 'newer', { name: 'Newer', machine: 'build-box' });
  assert.deepEqual(reads, ['/workspace'], 'the machine was shown, the session was not: read again');
  assert.deepEqual(opened, [['aaaaaaaaaaaa', 'newer']]);
  listings = [machine(['older', 'newer'])];
  await provider.openSyncedHand('aaaaaaaaaaaa', 'pulled-here', { name: 'Pulled', machine: 'build-box' });
  assert.deepEqual(said, ['OAK: “Pulled” waits on build-box, whose records here do not list the session yet.']);
  await provider.openSyncedHand('aaaaaaaaaaaa', 'not-listed');
  assert.equal(said.length, 1, 'a pick from the list says nothing');
  assert.deepEqual(opened, [['aaaaaaaaaaaa', 'newer']]);
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

test('Update now leaves a local build of the extension alone, as `oak update` does, and still runs the CLI for the rest', async () => {
  // A local build (dev.0, which no release carries) was replaced by the channel's build, older or not.
  const core = require(path.join(__dirname, '../../core/dist/index.js'));
  const run = async (extensionVersion) => {
    const installs = [], said = [], cli = [];
    const sandbox = { core, extensionVersion, EXTENSIONS_DIR: '', versionInfoCache: null, UPDATE_TIMEOUT_MS: 1000,
      marketplaceManaged: () => false, fetchUpdatePlan: async () => ({ surfaces: [], components: [] }),
      fetchLatestRelease: async () => ({ tag_name: 'v9.9.9', assets: [{ name: 'oak-observatory-vscode-9.9.9.vsix', browser_download_url: 'https://example.invalid/oak.vsix' }] }),
      installVsix: async (url, latest) => { installs.push(latest); },
      cliVersionInfo: async () => ({ current: '9.9.9', channel: 'stable', linked: null, provisioned: false }),
      runCli: async (args) => { cli.push(args.join(' ')); return ''; },
      vscode: { ProgressLocation: { Notification: 15 }, commands: { executeCommand() {} },
        window: { withProgress: async (_o, task) => task(), showInformationMessage: (m) => { said.push(m); return Promise.resolve(undefined); },
          showWarningMessage: (m) => { said.push(m); return Promise.resolve(undefined); } } } };
    vm.runInNewContext(ts.transpile(['pendingRows', 'cliUpdateNote', 'runUpdate'].map((f) => `globalThis.${f} = ${functions.get(f).replace(/^export /, '')}`).join('\n')), sandbox);
    await sandbox.runUpdate(null);
    return { installs, said: said.join('\n'), cli };
  };
  const local = await run('9.9.9-dev.0');
  assert.deepEqual([local.installs, local.cli], [[], ['update']], 'the extension is left alone, and the CLI runs the update');
  assert.match(local.said, /extension 9\.9\.9-dev\.0 is a local build, left alone/);
  const released = await run('9.9.8');
  assert.deepEqual(released.installs, ['9.9.9'], 'control: a build a release carries is updated');
});

test("The update notification's Update now runs the same full update as the version chip", async () => {
  // It installed the .vsix alone, while the docs say Update now runs `oak update` for everything else.
  const runs = [], offered = [];
  const core = require(path.join(__dirname, '../../core/dist/index.js'));
  const release = { tag_name: 'v9.9.9', html_url: 'https://example.invalid/release',
    assets: [{ name: 'oak-observatory-vscode-9.9.9.vsix', browser_download_url: 'https://example.invalid/oak.vsix' }] };
  const sandbox = { core, marketplaceManaged: () => false, UPDATE_CHECK_INTERVAL_MS: 0, INSTALL_SOURCE: 'vsix',
    fetchLatestRelease: async () => release, applyUpdate: async (target) => { runs.push(target); },
    vscode: { window: { showInformationMessage: async (message, ...items) => { offered.push(items[0]); return items[0]; }, showWarningMessage: async () => undefined },
      env: { openExternal() {} }, Uri: { parse: (u) => u } } };
  vm.runInNewContext(ts.transpile(`globalThis.checkForUpdate = ${functions.get('checkForUpdate')}`), sandbox);
  const context = (version) => ({ extension: { packageJSON: { version } }, globalState: { get: () => undefined, update() {} } });
  await sandbox.checkForUpdate(context('9.9.8'), false); // the daily check, behind the channel
  await sandbox.checkForUpdate(context('9.9.10'), true); // OAK: Check for updates, on a build above it
  assert.deepEqual(offered, ['Update now', 'Install it']);
  assert.deepEqual(runs, [null, null], 'each runs applyUpdate, the full update the version chip runs');
  // A local build (dev.0, which no release carries) is offered nothing, and the release feed is not asked; asked
  // by hand, the notifier says so, and names the channel followed, which replaces what differs from it: `--force`
  // would reinstall every surface and saved machine too.
  const said = [];
  let fetched = 0;
  Object.assign(sandbox, { fetchLatestRelease: async () => { fetched++; return release; } });
  sandbox.vscode.window.showInformationMessage = async (message, ...items) => { said.push([message, ...items]); return undefined; };
  await sandbox.checkForUpdate(context('9.9.9-dev.0'), false);
  for (const channel of ['stable', 'dev']) {
    sandbox.core = { ...core, getUpdateChannel: () => channel };
    await sandbox.checkForUpdate(context('9.9.9-dev.0'), true);
  }
  sandbox.core = core;
  assert.deepEqual(said, ['stable', 'dev'].map((channel) => [`OAK 9.9.9-dev.0 is a local build, which no release carries, so no update is offered for it. \`oak update --channel ${channel}\` replaces it with your channel's newest release.`]));
  assert.deepEqual([fetched, runs.length], [0, 2]);
  await sandbox.checkForUpdate(context('9.9.9-dev.3'), false);
  assert.match(said.at(-1)[0], /^OAK 9\.9\.9 is available \(you have 9\.9\.9-dev\.3\)\./, 'control: a build a release carries is offered the newest');
});

// The worker and session consumers join the same in-flight remote reads, including an empty/failed
// machine. Reopening either consumer within ten seconds must not create another SSH-backed listing.
test('saved-machine sessions and worker listings share reads, arrivals and failures', async () => {
  let clock = 100_000;
  const calls = [], pending = new Map(), posted = [];
  const sandbox = {
    Date: { now: () => clock }, resolveObservatoryBin: () => '/fixture/oak', process: { env: {} },
    currentMachine: () => 'lab-b', currentSession: () => 'remote-lab-b',
    core: { workersByMachine: require('../../core/dist').workersByMachine, findHerdrBin: () => '/fixture/herdr', plainLabel: s => s, cliFailureMessage: (out, err, fallback) => err || fallback },
    runOak: (args, options) => {
      calls.push({ args, options });
      if (args[0] === 'machine') return Promise.resolve({ code: 0, stdout: '[{"label":"lab-a"},{"label":"lab-b"}]', stderr: '' });
      return new Promise(resolve => pending.set(args.at(-1), resolve));
    },
  };
  const cache = source.slice(source.indexOf('type SavedListing ='), source.indexOf('/** The sessions `oak sync fetch`'));
  let method, workerMethod;
  for (const node of ast.statements) if (ts.isClassDeclaration(node) && node.name?.text === 'ChangeMapViewProvider')
    { method = node.members.find(m => ts.isMethodDeclaration(m) && m.name.getText(ast) === 'postWorkerMachines')?.getText(ast);
      workerMethod = node.members.find(m => ts.isMethodDeclaration(m) && m.name.getText(ast) === 'postWorkers')?.getText(ast); }
  // The old worker consumer posted only the synced-index result. Keeping that control makes the
  // same test executable on the base and on the one-line mutation of the shared consumer below.
  method ||= "postWorkerMachines(machines) { this.view.webview.postMessage({ type: 'workerMachines', machines }); }";
  vm.runInNewContext(ts.transpile(`${cache}\nglobalThis.refresh = refreshSavedMachines; globalThis.snap = savedMachineSnapshot;
    globalThis.Provider = class { ${method} ${workerMethod || "postWorkers() {}"} };`, { target: ts.ScriptTarget.ES2022 }), sandbox);
  const p = new sandbox.Provider();
  Object.assign(p, { localWorkers: [], workerVisibility: new WeakMap(), view: { visible: true, webview: { postMessage: m => posted.push(m) } } });
  const synced = [{ label: 'lab-a', host: 'a', sessions: [{ id: 'old-synced' }] }, { label: 'archive', host: 'c', sessions: [{ id: 'archived' }] }];
  sandbox.refresh(); // session consumer
  p.postWorkerMachines(synced);
  await Promise.resolve();
  assert.equal(calls.filter(c => c.args[0] === 'sessions').length, 2);
  assert.equal(pending.size, 2, 'both machines start without waiting for either answer');
  assert.ok(calls.filter(c => c.args[0] === 'sessions').every(c => !c.args.includes('--workers')), 'Sessions alone omit Workers');
  for (const label of ['lab-a', 'lab-b']) pending.get(label)({ code: 0, stdout: JSON.stringify({ sessions: [{ id: label }] }), stderr: '' });
  await Promise.resolve();
  p.workerVisibility.set(p.view, true);
  p.postWorkerMachines(synced);
  assert.equal(calls.filter(c => c.args[0] === 'sessions').length, 4, 'opening Workers upgrades fresh session-only answers');
  for (const label of ['lab-a', 'lab-b']) pending.get(label)({ code: 0, stdout: JSON.stringify({ sessions: [{ id: label, activeWorkers: [{ agentId: 'w1' }] }], workers: [{ session: 'remote-'+label, title: 'Verify copper widgets', machine: 'owner', state: 'working', subagents: [] }] }), stderr: '' });
  await Promise.resolve();
  const latest = () => JSON.parse(JSON.stringify(posted.filter(p => p.type === 'workerMachines').at(-1).machines));
  assert.deepEqual(latest().map(m => [m.label, m.sessions[0].id]), [['archive', 'archived'], ['lab-a', 'lab-a'], ['lab-b', 'lab-b']]);
  const workers = posted.filter(p => p.type === 'workers').at(-1).workers;
  assert.deepEqual(Array.from(workers, w => [w.machine, w.title, w.self]), [['lab-b', 'Verify copper widgets', true], ['lab-a', 'Verify copper widgets', false]]);
  assert.ok(calls.filter(c => c.args[0] === 'sessions').slice(2).every(c => c.args.includes('--workers')));
  const first = calls.length;
  for (let i = 0; i < 5; i++) { sandbox.refresh(); p.postWorkerMachines(synced); }
  assert.equal(calls.length, first, 'two consumers, repeated refreshes: zero extra remote calls');
  clock += 10_001;
  p.postWorkerMachines(synced); sandbox.refresh();
  assert.equal(calls.filter(c => c.args[0] === 'sessions').length, 6, 'next eligible refresh: one call per machine');
  pending.get('lab-a')({ code: 255, stdout: '', stderr: 'connection refused' });
  pending.get('lab-b')({ code: 0, stdout: '{"sessions":[]}', stderr: '' });
  await Promise.resolve();
  assert.ok(!latest().some(m => m.label === 'lab-a'), 'failure hides its stale synced worker rows too');
  assert.equal(sandbox.snap().machines[0].readAt, 100_000, 'last successful read time remains available');
  assert.ok(calls.filter(c => c.args[0] === 'sessions').every(c => c.options.env.OAK_MACHINE_TIMEOUT_MS === '45000'));
  p.workerVisibility.set(p.view, false);
  clock += 10_001;
  sandbox.refresh();
  assert.ok(calls.slice(-2).every(c => !c.args.includes('--workers')), 'leaving Workers restores Sessions-only reads');
  for (const label of ['lab-a', 'lab-b']) pending.get(label)({ code: 0, stdout: '{"sessions":[]}', stderr: '' });
  await Promise.resolve();
});

test('Stats remote usage targets the saved machine and drops stale replies', () => {
  const statsMethods = [];
  function scan(n) {
    if (ts.isMethodDeclaration(n) && n.parent.name?.getText(ast) === 'StatsUsageViewProvider') statsMethods.push(n.getText(ast));
    ts.forEachChild(n, scan);
  }
  scan(ast);
  let machine = 'lab-a';
  const calls = [], posts = [], history = [];
  const sandbox = { Date, currentSession: () => 'same-id', currentMachine: () => machine,
    workspaceRoot: () => '/local/work', savedMachineSnapshot: () => ({ machines: [] }),
    resolveObservatoryBin: () => '/synthetic/oak',
    spawnCliJson: (args, cwd, cb) => calls.push({ args, cwd, cb }),
    core: { spawnTool: (bin, args) => { history.push(args); return { stdout: { on() {} }, on() {} }; } } };
  vm.runInNewContext(ts.transpile(`globalThis.Provider = class { ${statsMethods.join('\n')} }`), sandbox);
  const p = new sandbox.Provider();
  Object.assign(p, { view: { visible: true, webview: { postMessage: m => posts.push(m) } }, statsRun: 0 });
  p.postCounts();
  assert.equal(calls.length, 1, 'selected remote session usage is fetched');
  assert.deepEqual(Array.from(calls[0].args), ['usage', '--session', 'same-id', '--machine', 'lab-a']);
  const usage = { sessionTokens: { available: true, input: 900 }, sessionTreeTokens: { available: true, input: 1800, agents: 1 }, vitals: { model: 'Remote model' } };
  calls[0].cb(usage);
  assert.equal(posts.at(-1).remote.machine, 'lab-a');
  assert.equal(posts.at(-1).t.input, 900);
  assert.equal(posts.at(-1).tt.input, 1800);
  p.postCounts();
  assert.equal(calls.length, 1, 'ordinary count refreshes reuse the bounded remote read');
  machine = 'lab-b'; p.postCounts();
  assert.equal(posts.at(-1).t, null, 'same session id on a different machine clears the old totals');
  assert.equal(calls.length, 2);
  calls[0].cb(usage);
  assert.equal(posts.at(-1).remote.machine, 'lab-b', 'late reply from lab-a is discarded');
  calls[1].cb(null);
  assert.equal(posts.at(-1).t, null, 'a failed read cannot restore another machine\'s numbers');
  p.refreshStats();
  assert.deepEqual(Array.from(history[0]), ['stats', '--json'], 'account history stays local without the remote session id');
});

test('delegated worker selection keeps its own parent and saved machine', () => {
  const overview = source.slice(source.indexOf('  function delegatedBlock()'), source.indexOf('  // --- Workflows: the runs'));
  const js = ts.createSourceFile('overview.js', overview, ts.ScriptTarget.Latest, true);
  const parts = [];
  function pick(n) {
    if (ts.isFunctionDeclaration(n) && ['delegatedBlock', 'findingsBlock', 'workerData', 'renderFleet'].includes(n.name?.text)) parts.push(n.getText(js));
    ts.forEachChild(n, pick);
  }
  pick(js);
  for (const machine of [null, 'lab-a']) {
    let rows = [], selected;
    const host = { innerHTML: '', querySelector: () => null, querySelectorAll: selector => {
      if (selector !== '.mt-sub[data-agent]') return [];
      rows = [...host.innerHTML.matchAll(/<div[^>]*data-agent="[^"]+"[^>]*>/g)].map(m => {
        const attrs = Object.fromEntries([...m[0].matchAll(/(data-[\w-]+)="([^"]*)"/g)].map(a => [a[1], a[2]]));
        return { getAttribute: k => attrs[k], addEventListener(type, cb) { this.click = cb; } };
      });
      return rows;
    } };
    const sandbox = { MT: { delegated: [{ id: 'brief-a', session: 'parent-a', cwd: '/remote/project', machine,
      state: 'working', workers: [{ id: 'worker-a', title: 'Review lexer', state: 'working' }] }] },
      WORKERS: null, WORKER_NOTES: [], WORKER_FINDINGS: null, DONE_SUBS: {}, FEED: null, DELEGATED_PHASE: { working: 'working' }, phaseColor: () => 'blue', esc: String, relAge: () => 'now',
      paneHost: () => host, MTFILTER: () => ({ agents: [] }), fstate: () => ({}), syncControls() {},
      filterBar: () => '', prSlice: () => null, ACTIVE_ONLY: false, wireFilterBar() {},
      setFeed: (...args) => { selected = args; } };
    vm.runInNewContext(parts.join('\n') + '\nrenderFleet();', sandbox);
    assert.equal(rows.length, 1, 'the delegated worker is selectable');
    rows[0].click.call(rows[0], { stopPropagation() {} });
    assert.deepEqual(selected, ['agent', 'worker-a', 'Review lexer', 'parent-a', machine || '', '/remote/project']);
    Object.assign(sandbox, { WORKERS: [{ session: 'parent-a', title: 'Synthetic task', worktree: '/remote/project', remote: machine,
      machine: machine || 'local', state: 'working', phase: 'working', subagents: [{ agentId: 'worker-a', description: 'Review lexer', phase: 'working' }] }],
      MTFILTER: data => ({ agents: data.agents || [] }), agentCollisions: () => 0, selAgentSess: () => '', spark: () => '',
      riskCount: () => 0, outsideSuffix: () => '', fmtTok: String, fmtDur: String, phaseLabel: String, base: String });
    vm.runInNewContext(parts.join('\n') + '\nrenderFleet();', sandbox);
    assert.equal(rows.length, 1, 'the unified fleet worker is selectable');
    rows[0].click.call(rows[0], { stopPropagation() {} });
    assert.deepEqual(selected, ['agent', 'worker-a', 'Review lexer', 'parent-a', machine || '', '/remote/project']);
  }
});


const mergedFixture = () => ({
  local: Array.from({ length: 99 }, (_, i) => ({ id: `local-${i}`, title: `Middle ${String(i).padStart(2, '0')}`, lastActiveMs: 100 + i, workspace: '/synthetic', active: i === 0 })),
  saved: [{ label: 'box-a', readAt: 300, reading: false, listing: { sessions: [
    { id: 'remote-new', title: 'Alpha match', lastActiveMs: 300, active: true },
    { id: 'remote-old', title: 'Zulu match', lastActiveMs: 1, active: false }] } },
    { label: 'box-b', error: 'synthetic connection refused', reading: false }],
  machines: [{ label: 'box-c', host: 'cccccccccccc', syncedAt: 400, sessions: [{ id: 'indexed', title: 'Beta match', lastActiveMs: 250 }] }],
});
const sessionIds = html => [...html.matchAll(/data-(?:sid|rsid|msid|sess-switch)="([^"]+)"/g)].map(m => m[1]);
function mergedTimeline() {
  const f = mergedFixture(), v = timeline();
  v.post({ type: 'sessions', rows: f.local, current: 'local-0' });
  v.post({ type: 'saved', machines: f.saved });
  v.post({ type: 'machines', machines: f.machines });
  return v;
}
test('one session list, Timeline: newest remote precedes 99 local rows; machine failures lead', () => {
  const v = mergedTimeline(), html = v.run('sessRowsHtml()');
  assert.equal(sessionIds(html)[0], 'remote-new');
  assert.ok(html.indexOf('synthetic connection refused') < html.indexOf('data-rsid='));
  assert.equal((html.match(/box-b/g) || []).length, 1, 'one short state line');
});
test('one session list, Timeline: all four sorts, search and Active span all machines', () => {
  const v = mergedTimeline();
  for (const [sort, first, last] of [['new', 'remote-new', 'remote-old'], ['old', 'remote-old', 'remote-new'], ['az', 'remote-new', 'remote-old'], ['za', 'remote-old', 'remote-new']]) {
    const ids = sessionIds(v.run(`SESSSORT='${sort}'; sessRowsHtml()`));
    assert.equal(ids[0], first, sort); assert.equal(ids.at(-1), last, sort);
  }
  assert.deepEqual(sessionIds(v.run("SESSQ='match'; SESSSORT='new'; sessRowsHtml()")), ['remote-new', 'indexed', 'remote-old']);
  assert.deepEqual(sessionIds(v.run("SESSQ=''; SESSACT=true; sessRowsHtml()")), ['remote-new', 'local-0']);
});
function mergedOverview() {
  const f = mergedFixture(), host = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
  const sandbox = { SESS: { sessions: f.local, machines: f.machines }, OVSAVED: f.saved, OVSAVEDERR: '', OVSAVED_ASKED: Date.now(),
    WORKER_MACHINES: null, SELF_KEY: '', PINNED: '', OVMACH: '', FILTER: '', SORT: 'time', ACTIVE_ONLY: false, SHOW_OLDSESS: true,
    paneHost: () => host, document: { getElementById: () => null }, vscode: { postMessage() {} },
    esc: s => String(s ?? ''), ago: String, fmtTok: String, fmtDur: String, fmtBytes: String,
    workerGroup: () => '', bindSaved: () => {} };
  const parsed = ts.createSourceFile('overview.js', overviewScript, ts.ScriptTarget.Latest, true);
  const names = new Set(['renderSessions', 'savedGroupsHtml', 'savedSessionHtml', 'machineRows', 'machineStatusHtml', 'orderedSessionRows', 'sessionMatches', 'sessionWaiting', 'sessionVisible', 'wkState', 'activeWorkersOf']);
  const declarations = [];
  function collect(n) { if (ts.isFunctionDeclaration(n) && names.has(n.name.text)) declarations.push(n.getText(parsed)); else ts.forEachChild(n, collect); }
  collect(parsed);
  vm.runInNewContext('var SESSION_ORDER_CACHE=null, DONE_SESSIONS_OPEN=new Set();\n' + declarations.join('\n'), sandbox);
  return { host, sandbox, paint: () => { vm.runInNewContext('renderSessions()', sandbox); return host.innerHTML; } };
}
test('one session list, Overview: newest remote and failure state precede local rows', () => {
  const v = mergedOverview(), html = v.paint();
  assert.equal(sessionIds(html)[0], 'remote-new');
  assert.ok(html.indexOf('synthetic connection refused') < html.indexOf('data-rsid='));
  assert.ok(sessionIds(html).includes('indexed'));
});
test('one session list, Overview: search, Active and all sorts span machines', () => {
  const v = mergedOverview();
  for (const [sort, first] of [['time', 'remote-new'], ['time-asc', 'remote-old'], ['name', 'remote-new'], ['name-desc', 'remote-old']]) {
    v.sandbox.SORT = sort; assert.equal(sessionIds(v.paint())[0], first, sort);
  }
  v.sandbox.FILTER = 'match'; v.sandbox.SORT = 'time';
  assert.deepEqual(sessionIds(v.paint()), ['remote-new', 'indexed', 'remote-old']);
  v.sandbox.FILTER = ''; v.sandbox.ACTIVE_ONLY = true;
  assert.deepEqual(sessionIds(v.paint()), ['remote-new', 'local-0']);
});
test('one session list, QuickPick: newest across machines and failures above rows', async () => {
  const f = mergedFixture(); let qp;
  const sandbox = { workspaceRoot: () => '/synthetic', currentSession: () => '', readSessionListing: async () => ({ sessions: f.local }), readMachineListings: async () => f.machines,
    savedMachineSnapshot: () => ({ machines: f.saved }), savedListeners: new Set(), refreshSavedMachines() {}, remotePin: null,
    sessionBadgePrefix: () => '', workspaceWindowBtn: {}, revealStoreBtn: {}, deleteSessionBtn: {},
    core: { relTime: String }, vscode: { QuickPickItemKind: { Separator: -1 }, workspace: { getConfiguration: () => ({ get: () => '' }) }, window: { createQuickPick: () => qp = {
      activeItems: [], selectedItems: [], onDidAccept() {}, onDidHide() {}, onDidTriggerItemButton() {}, show() {}, dispose() {},
    } } } };
  // Run until the picker is shown; no user selection is needed to observe its items.
  vm.runInNewContext(ts.transpile('(' + commands.get('claudeObservatory.switchSession') + ')()'), sandbox);
  await new Promise(resolve => setImmediate(resolve));
  const rows = qp.items.filter(i => i.id && !i.note);
  assert.equal(rows[0].id, 'remote-new');
  assert.ok(qp.items.findIndex(i => i.label.includes('synthetic connection refused')) < qp.items.indexOf(rows[0]));
});

test('one session list, Timeline: machine failure stays at top even when search matches no session', () => {
  const v = mergedTimeline(), html = v.run("SESSQ='absent'; sessRowsHtml()");
  assert.ok(html.indexOf('synthetic connection refused') < html.indexOf('no session matches'));
});
test('one session list, Overview: failure state stays above matching local sessions', () => {
  const v = mergedOverview(); v.sandbox.FILTER = 'Middle';
  const html = v.paint();
  assert.ok(html.indexOf('synthetic connection refused') < html.indexOf('data-sess-switch='));
});
for (const [sort, first] of [['new', 'remote-new'], ['old', 'remote-old'], ['az', 'remote-new'], ['za', 'remote-old']]) {
  test(`one session list, Timeline sort ${sort} spans machines`, () => {
    const v = mergedTimeline();
    assert.equal(sessionIds(v.run(`SESSSORT='${sort}'; sessRowsHtml()`))[0], first);
  });
}
for (const [sort, first] of [['time', 'remote-new'], ['time-asc', 'remote-old'], ['name', 'remote-new'], ['name-desc', 'remote-old']]) {
  test(`one session list, Overview sort ${sort} spans machines`, () => {
    const v = mergedOverview(); v.sandbox.SORT = sort;
    assert.equal(sessionIds(v.paint())[0], first);
  });
}

test('one session list, Timeline: remote raised hands precede conflicts and ordinary sessions', () => {
  const v = mergedTimeline();
  const html = v.run(`
    SESSROWS=[{id:'local-hand',title:'Input',lastActiveMs:2,handRank:2,attention:{kind:'input',ts:1}}];
    SAVED=[{label:'box-a',readAt:1,listing:{sessions:[{id:'remote-hand',title:'Permission',lastActiveMs:1,attention:{kind:'permission',ts:2}},{id:'ordinary',title:'Newest',lastActiveMs:1000}]}}];
    MACHROWS=[]; SYNCROWS=[{id:'conflict',family:'plan',name:'synthetic',from:'box-b',resolution:'open',copy:'/synthetic/copy'}];
    sessRowsHtml()`);
  assert.deepEqual(sessionIds(html), ['remote-hand', 'local-hand', 'ordinary']);
  assert.ok(html.indexOf('data-sid="local-hand"') < html.indexOf('data-sync="conflict"'));
  assert.ok(html.indexOf('data-sync="conflict"') < html.indexOf('data-rsid="ordinary"'));
});

test('workspace window: Timeline row button keeps the owning machine and session', () => {
  const v = mergedTimeline(); v.run('SESSOPEN=true; renderSess()');
  assert.match(v.run('sessRowsHtml()'), /data-workspace-window="remote-new" data-machine="box-a"/);
  const node = { getAttribute: key => ({ 'data-workspace-window': 'remote-new', 'data-machine': 'box-a' })[key] };
  const target = { closest: selector => selector === '[data-workspace-window]' ? node : null };
  v.el('rq-slist').on.click?.forEach(fn => fn({ target, stopPropagation() {} }));
  assert.ok(v.posted.some(m => m.type === 'openWorkspaceWindow' && m.id === 'remote-new' && m.machine === 'box-a'));
});
test('workspace window: Observatory row buttons carry local and saved session identity', () => {
  const v = mergedOverview(), nodes = [], posted = [];
  v.sandbox.vscode.postMessage = m => posted.push(m);
  v.host.querySelectorAll = selector => {
    if (selector !== '[data-workspace-window]') return [];
    return [...v.host.innerHTML.matchAll(/<button[^>]*data-workspace-window="[^"]+"[^>]*>/g)].map(m => {
      const attrs = Object.fromEntries([...m[0].matchAll(/(data-[\w-]+)="([^"]*)"/g)].map(a => [a[1], a[2]]));
      const n = { getAttribute: key => attrs[key], addEventListener(type, fn) { this.click = fn; } }; nodes.push(n); return n;
    });
  };
  v.paint();
  for (const id of ['local-0', 'remote-new']) nodes.find(n => n.getAttribute('data-workspace-window') === id)?.click({ stopPropagation() {} });
  assert.deepEqual(posted.map(m => [m.id, m.machine]), [['local-0', ''], ['remote-new', 'box-a']]);
});

test('done sessions, Overview: closed per machine, click, workspaces, pin, pending counted in the fold, revival, search and Active', () => {
  const v = mergedOverview(), s = v.sandbox;
  const row = (id, workspace) => ({ id, title: id, workspace, lastActiveMs: 1, pending: 0,
    attention: { kind: 'idle-done', ts: 1 } });
  s.SESS = { sessions: [row('local-done', 'local-work')] };
  s.OVSAVED = [{ label: 'saved-box', listing: { sessions: [row('saved-done', 'saved-work')] } }];
  const clicks = new Map();
  v.host.querySelectorAll = selector => selector === '[data-done-sessions]' ?
    [...v.host.innerHTML.matchAll(/data-done-sessions="([^"]*)"/g)].map(m => ({ getAttribute: () => m[1],
      addEventListener: (event, fn) => clicks.set(m[1], () => fn.call({ getAttribute: () => m[1] })) })) : [];
  let html = v.paint();
  assert.deepEqual(sessionIds(html), []);
  assert.equal((html.match(/1 done/g) || []).length, 2);
  assert.ok(!html.includes('local-work') && !html.includes('saved-work'));
  clicks.get('')(); clicks.get('saved-box')();
  html = v.host.innerHTML;
  assert.deepEqual(sessionIds(html), ['local-done', 'saved-done']);
  assert.match(html, /local-work/); assert.match(html, /saved-work/);
  assert.deepEqual(sessionIds(v.paint()), ['local-done', 'saved-done'], 'open across refresh');
  clicks.get('')(); clicks.get('saved-box')();
  s.SELF_KEY = 'local-done';
  assert.deepEqual(sessionIds(v.paint()), ['local-done'], 'reviewed session survives folding');
  s.SELF_KEY = ''; s.OVSAVED[0].listing.sessions[0] = { ...s.OVSAVED[0].listing.sessions[0], pending: 1 };
  // A finished session with edits left to review folds too; its fold says how many (2026-11-05, the user's request).
  html = v.paint();
  assert.deepEqual(sessionIds(html), [], 'a done session with pending edits folds');
  assert.match(html, /1 done · 1 pending/, 'the fold counts the pending edits inside it');
  s.OVSAVED[0].listing.sessions[0] = { ...s.OVSAVED[0].listing.sessions[0], pending: 0 };
  // `current` is the watched session only on this machine: a saved machine's newest-in-its-folder still folds (2026-11-05).
  s.OVSAVED[0].listing.sessions[0] = { ...s.OVSAVED[0].listing.sessions[0], current: true };
  assert.deepEqual(sessionIds(v.paint()), [], 'another machine\'s current session folds when done');
  s.OVSAVED[0].listing.sessions[0] = { ...s.OVSAVED[0].listing.sessions[0], current: false };
  s.SESS.sessions[0].current = true;
  assert.deepEqual(sessionIds(v.paint()), ['local-done'], 'this machine\'s watched session stays visible');
  s.SESS.sessions[0].current = false;
  // A worker still at it keeps its finished session out of the fold, as in the terminal app.
  s.SESS.sessions[0].activeWorkers = [{ id: 'worker-1', phase: 'working' }];
  assert.deepEqual(sessionIds(v.paint()), ['local-done'], 'a done session with a working worker stays visible');
  s.SESS.sessions[0].activeWorkers = [{ id: 'worker-1', phase: 'done' }];
  assert.deepEqual(sessionIds(v.paint()), [], 'once its worker is done it folds');
  delete s.SESS.sessions[0].activeWorkers;
  s.SESS.sessions[0].attention = null; s.SESS.sessions[0].active = true;
  assert.deepEqual(sessionIds(v.paint()), ['local-done'], 'a new turn leaves the fold');
  s.FILTER = 'saved-done';
  assert.deepEqual(sessionIds(v.paint()), ['saved-done']);
  s.FILTER = ''; s.ACTIVE_ONLY = true;
  assert.deepEqual(sessionIds(v.paint()), ['local-done'], 'Active still hides finished sessions');
});
