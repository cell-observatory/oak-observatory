/* Extension smoke test — loads the built bundle against a minimal `vscode` mock and drives its
   commands over an isolated store. Run with `node --test` (npm test builds the bundle first). */
const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('./editor-fixes.test');

// Fixtures below own their temporary HOMEs. An inherited custom config root would send the
// extension and its real CLI children to a different store/registry than the seeded fixtures.
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
// The CLI the extension spawns is THIS tree's, never whatever `oak` the machine has installed: with no
// pin it resolves an installed CLI first, then PATH, so a developer machine passed on its installed build
// while a clean CI runner, which has none, failed. The pin is the workspace's own bin link, which the root
// `npm run build` makes (npm's install skips it while the CLI is unbuilt), so every platform runs the
// tree's CLI the same way (a sub-test that simulates a missing CLI swaps it and restores it).
const TREE_OAK = path.resolve(__dirname, '../../../node_modules/.bin', process.platform === 'win32' ? 'oak.cmd' : 'oak');
process.env.CLAUDE_OBSERVATORY_BIN = TREE_OAK;

const core = require('../../core/dist/index.js');
const BUNDLE = process.env.OAK_VSCODE_TEST_BUNDLE || path.resolve(__dirname, '../dist/extension.js');

test('extension: three views, click commands, inline annotations, chat, status styling, undo', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ext-home-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ext-ws-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE on Windows, HOME elsewhere
  // Positive control for the pin: the tree's CLI answers through its bin link. A fresh build that left
  // packages/cli/dist/index.js non-executable fails HERE, by name, instead of as a missing session row.
  const treeOak = core.spawnToolSync(TREE_OAK, ['--version'], { encoding: 'utf8' });
  assert.equal(treeOak.status, 0, `the tree's oak runs through ${TREE_OAK} — ${treeOak.error || treeOak.stderr}`);
  assert.equal(treeOak.stdout.trim(), `oak ${require('../../cli/package.json').version}`, '…and it reports this tree’s version');
  const S = 'extSess';

  // seed: projects dir so resolveSessionId(ws) === S, and a store with 2 edits on one file
  const proj = path.join(home, '.claude', 'projects', ws.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  const F = path.join(ws, 'app.txt');
  const OUT = path.join(home, 'notes', 'outside.md'); // deliberately NOT under the workspace
  // transcript: the ai-title recap + two assistant messages whose Edit tool_uses on F carry the agent's
  // reasoning (correlated per-file to store edits #1/#2) — feeds the inline reasoning lens + blame.
  const AG = 'sa0000000001';
  // Longer than any row is wide: shown whole, and wrapped (cut at 99 characters with …).
  const LONG_WHY = 'Operation 2 — add a validate() method that rejects negative scales, empty inputs and NaN values before any feature scaling runs';
  fs.writeFileSync(path.join(proj, S + '.jsonl'), [
    JSON.stringify({ type: 'ai-title', aiTitle: 'Reviewing app.txt edits' }),
    // Two of the USER's asks, stamped in the same epoch-ms space as the seeded edits below (500 < 1000
    // and 1500 < 2000), so each ask owns exactly one edit. Without these the transcript has no user turn
    // at all — sessionPrompts returns [] — and nothing that reviews BY ASK (the prompt axis, the rewind)
    // can be tested.
    JSON.stringify({ timestamp: new Date(500).toISOString(), type: 'user', message: { role: 'user', content: 'introduce feature scaling' } }),
    JSON.stringify({ timestamp: new Date(1500).toISOString(), type: 'user', message: { role: 'user', content: 'add a validate() method' } }),
    // top-level type:'assistant' so resolution passes via hasAssistantRecord, not the all-stub fallback
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'Operation 1 — introduce feature scaling' },
      { type: 'tool_use', name: 'Edit', input: { file_path: F } },
    ] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: LONG_WHY },
      { type: 'tool_use', name: 'Edit', input: { file_path: F } },
    ] } }),
    // 0.8.7: one read and one edit that land OUTSIDE the workspace — the two facts the folded footprint
    // left behind, which the Actions tree's Egress (reach) and Risk (damage) sections must state.
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Read', input: { file_path: OUT } },
      { type: 'tool_use', name: 'Edit', input: { file_path: OUT } },
    ] } }),
    // Subagents (0.7.0): an Agent spawn + its result carrying the subagent's id + metrics.
    JSON.stringify({ timestamp: '2026-07-13T10:00:00.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tuAg', name: 'Agent', input: { description: 'review the diff', subagent_type: 'code-reviewer' } },
    ] } }),
    JSON.stringify({ timestamp: '2026-07-13T10:05:00.000Z',
      toolUseResult: { status: 'completed', agentId: AG, agentType: 'code-reviewer', totalDurationMs: 120000, totalTokens: 30000, totalToolUseCount: 4 },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tuAg', is_error: false }] } }),
  ].join('\n'));
  // the subagent's own transcript — its tool calls (0.7.0 nests these under the Subagents node)
  const subDir = path.join(proj, S, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, `agent-${AG}.jsonl`), [
    JSON.stringify({ isSidechain: true, agentId: AG, sessionId: S, timestamp: '2026-07-13T10:01:00.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'sa1', name: 'Read', input: { file_path: F } },
      { type: 'tool_use', id: 'sa2', name: 'Grep', input: { pattern: 'scale' } },
    ] } }),
  ].join('\n'));
  // a sibling session in the SAME project (0.7.0 fleet), backdated so resolveSessionId still returns S.
  const SIB = 'sibSess0002';
  fs.writeFileSync(path.join(proj, SIB + '.jsonl'), JSON.stringify({ message: { role: 'assistant', content: [] } }));
  const old = Math.floor(Date.now() / 1000) - 3600;
  fs.utimesSync(path.join(proj, SIB + '.jsonl'), old, old);
  // a NEWER command-only stub (an /effort run): must NOT hijack resolution away from S — the
  // whole extension smoke below only passes if the resolver demotes this assistant-less file.
  fs.writeFileSync(path.join(proj, 'stubEffort01.jsonl'), [
    JSON.stringify({ type: 'user', sessionId: 'stubEffort01', cwd: ws, message: { role: 'user', content: '<command-name>/effort</command-name>' } }),
    JSON.stringify({ type: 'user', sessionId: 'stubEffort01', cwd: ws, message: { role: 'user', content: '<local-command-stdout>Set effort level to xhigh</local-command-stdout>' } }),
  ].join('\n'));
  const fresh = Math.floor(Date.now() / 1000) + 60;
  fs.utimesSync(path.join(proj, 'stubEffort01.jsonl'), fresh, fresh);
  core.ensureStore(S);
  const b0 = core.writeBlob(S, Buffer.from('a\nb\nc\nd\n'));
  const a1 = core.writeBlob(S, Buffer.from('AAA\nb\nc\nd\n'));
  core.appendLog(S, { id: 1, ts: 1000, tool: 'Edit', file: F, beforeBlob: b0, afterBlob: a1, status: 'pending' });
  const a2 = core.writeBlob(S, Buffer.from('AAA\nb\nc\nZZZ\n'));
  core.appendLog(S, { id: 2, ts: 2000, tool: 'Edit', file: F, beforeBlob: a1, afterBlob: a2, status: 'pending' });
  fs.writeFileSync(F, 'AAA\nb\nc\nZZZ\n');

  // minimal vscode mock
  const commands = {};
  const diffCalls = [];
  const decoCalls = []; // { typeId, opts }
  const trees = {};
  const treeViewOpts = {};
  const contentProviders = {};
  const webviewProviders = {};
  const configWrites = []; // [key, value] — demo mode must never write claudeObservatory.session
  const configValues = {}; // live setting values, so a test can flip one and exercise its OFF path
  const folderChangeHandlers = []; // onDidChangeWorkspaceFolders subscribers, so a test can fire one
  let progressCancelled = false; // drives the demo replay's cancellation path without a 17s paced run
  const openTabs = []; // window.tabGroups contents — exitDemo must close the demo's editors
  const infoMessages = []; // every showInformationMessage — the first-run offer must not appear here
  const warnMessages = []; // every showWarningMessage — a refusal has to SAY why, not fail silently
  const fsWatchers = []; // every createFileSystemWatcher: { pattern, change: [its onDidChange handlers] }
  let infoPick; // what the mock reader clicks on the next showInformationMessage (undefined = dismiss)
  /**
   * The actions offered by a show*Message call, for BOTH of the API's overloads:
   * `(message, ...items)` and `(message, options, ...items)`. Assuming the second argument is always an
   * options object silently shifted every positional-items call by one — the extension has eleven of
   * them — so the mock returned the SECOND button while the code under test believed it had the first.
   * That is a mock that can only fail where the branch is rarely taken, which is the worst place for it.
   */
  const actionsOf = (rest) => {
    const [first] = rest;
    // An options object is an object WITHOUT a `title` — a MessageItem action has one. That is how the
    // real API tells the two overloads apart, so the mock must too; testing only `typeof === 'object'`
    // would swallow a MessageItem action the first time anyone used one.
    const isOptions = first !== null && typeof first === 'object' && !('title' in first);
    return isOptions ? rest.slice(1) : rest;
  };
  const webviewPanels = []; // createWebviewPanel calls — the tour is a detachable panel
  const changesCalls = []; // every vscode.changes (native multi-diff) invocation
  let quickPick = null; // what showQuickPick should return (the tour's track chooser)
  const openDialogAsks = []; // every native open-dialog ask (the Feed tab's + button)
  let openDialogAnswer; // what the dialog returns — set per test leg
  // createQuickPick (the session switch pickers): a test sets this to `(items) => item | undefined` to
  // choose what the picker accepts on show(); null hides it. Reset to null after each use.
  let createQuickPickChoose = null;
  // …and this to `(items) => ({ item, button }) | undefined` to press a ROW button first (the store
  // folder's reveal), the way onDidTriggerItemButton fires in the real picker. Reset to null after use.
  let createQuickPickButton = null;
  // The two ways a store folder opens: openExternal (the OS file manager, in a local window) and the
  // 'vscode.openFolder' command (a new window on the remote host, in a remote one). `env.remoteName`
  // below is what tells them apart; a test sets it to model a Remote-SSH window.
  const openExternalCalls = [];
  let openExternalAnswer = true; // what openExternal resolves to — false models an open that failed
  const openFolderCalls = [];
  let lensProvider = null;
  let hoverProvider = null;
  let decoProvider = null;
  let commentController = null;
  const commentThreads = [];
  const contextKeys = {}; // every setContext the extension publishes — the when-clauses' other half
  const configHandlers = []; // onDidChangeConfiguration subscribers, so a test can fire a real change
  /** Fire a settings change for exactly `key`, the way VS Code does. */
  const fireConfigChange = (key) =>
    configHandlers.forEach((cb) => cb({ affectsConfiguration: (k) => k === `claudeObservatory.${key}` }));
  const statusBarItems = []; // every createStatusBarItem() returns a distinct item (the nav bar has many)
  let clipboardText = '';
  const uninstalled = []; // workbench.extensions.uninstallExtension calls — the rename's retirement
  let decoCounter = 0;
  let opened = null;
  let lastShown = null;
  let inputBoxValue; // drives the Search edits input box
  class EventEmitter {
    constructor() { this._s = []; }
    get event() { return (cb) => { this._s.push(cb); return { dispose() {} }; }; }
    fire(v) { this._s.forEach((f) => f(v)); }
  }
  class TreeItem { constructor(label, s) { this.label = label; this.collapsibleState = s; } }
  class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
  ThemeIcon.File = new ThemeIcon('file');
  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  class Range {
    constructor(a, b, c, d) {
      if (typeof a === 'object') { this.start = a; this.end = b; }
      else { this.start = new Position(a, b); this.end = new Position(c, d); }
    }
  }
  class Selection { constructor(anchor, active) { this.anchor = anchor; this.active = active; } }
  class CodeLens { constructor(range, command) { this.range = range; this.command = command; } }
  class Hover { constructor(contents, range) { this.contents = contents; this.range = range; } }
  class MarkdownString {
    constructor(v) { this.value = v || ''; this.isTrusted = false; this.supportThemeIcons = false; }
    appendMarkdown(s) { this.value += s; return this; }
    appendText(s) { this.value += s.replace(/[\\`*_{}\[\]()#+.!<>-]/g, '\\$&'); return this; }
  }
  // Faithful to vscode-uri: `fsPath` LOWER-CASES a Windows drive letter (uriToFsPath with
  // keepDriveLetterCasing=false). On windows-latest this hands the extension the same skewed paths
  // real VS Code produces, so the star/CodeLens assertions below exercise the #43 canon boundary —
  // an identity mock here would let a missing canonFsPath() pass green on every OS.
  const toFsPath = (p) => (p && p.length >= 2 && p[1] === ':' && p[0] >= 'A' && p[0] <= 'Z' ? p[0].toLowerCase() + p.slice(1) : p);
  const Uri = {
    file: (p) => ({ scheme: 'file', path: p, fsPath: toFsPath(p) }),
    from: (o) => ({ scheme: o.scheme, path: o.path, query: o.query || '' }),
    joinPath: (base, ...parts) => ({ scheme: 'file', path: [base && base.path, ...parts].filter(Boolean).join('/'), fsPath: toFsPath([base && base.fsPath, ...parts].filter(Boolean).join('/')) }),
  };
  const doc = {
    uri: Uri.file(F),
    lineCount: 5,
    getText: () => 'AAA\nb\nc\nZZZ\n',
    lineAt: (n) => ({ range: new Range(n, 0, n, 3) }),
  };
  const mockEditor = { document: doc, selection: { active: { line: 0 } }, setDecorations: (t, opts) => decoCalls.push({ typeId: t.id, opts }), revealRange() {} };
  const vscode = {
    EventEmitter, TreeItem, ThemeIcon, Position, Range, Selection, MarkdownString, CodeLens, Hover,
    ThemeColor: class { constructor(id) { this.id = id; } },
    RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
    Uri,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    ProgressLocation: { Notification: 15, Window: 10, SourceControl: 1 },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    TextEditorRevealType: { InCenter: 2 },
    CommentMode: { Editing: 0, Preview: 1 },
    CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
    CommentThreadState: { Unresolved: 0, Resolved: 1 },
    workspace: {
      workspaceFolders: [{ uri: Uri.file(ws) }],
      textDocuments: [],
      asRelativePath: (f) => path.relative(ws, typeof f === 'string' ? f : f.fsPath),
      registerTextDocumentContentProvider: (s, p) => { contentProviders[s] = p; return { dispose() {} }; },
      // Each watcher's handlers, so a test can report a change another tool made.
      createFileSystemWatcher: (pattern) => {
        const w = { pattern: pattern && pattern.pattern !== undefined ? pattern.pattern : pattern, change: [] };
        fsWatchers.push(w);
        return { onDidChange: (f) => { w.change.push(f); }, onDidCreate() {}, onDidDelete() {}, dispose() {} };
      },
      onDidChangeTextDocument: () => ({ dispose() {} }),
      onDidChangeConfiguration: (cb) => { configHandlers.push(cb); return { dispose() {} }; },
      // Captured so the test can FIRE a folder change: `workspaceRoot()` is folders[0], so this
      // event is the only thing that tells the extension the session it is showing just changed.
      onDidChangeWorkspaceFolders: (cb) => { folderChangeHandlers.push(cb); return { dispose() {} }; },
      // Backed by a mutable map so a test can exercise a setting's OFF path. Returning the caller's
      // default unconditionally made every "…and with the setting off, nothing happens" assertion pass
      // while actually running the ON path.
      getConfiguration: () => ({
        get: (k, def) => (k in configValues ? configValues[k] : def),
        update: (k, v) => { configWrites.push([k, v]); configValues[k] = v; return Promise.resolve(); },
      }),
      openTextDocument: (uri) => Promise.resolve({ uri, lineCount: 5, getText: () => 'AAA\nb\nc\nZZZ\n', lineAt: (n) => ({ range: new Range(n, 0, n, 3) }) }),
    },
    window: {
      createTreeView: (id, opts) => {
        trees[id] = opts.treeDataProvider;
        treeViewOpts[id] = opts;
        return { badge: undefined, description: undefined, onDidChangeVisibility: () => ({ dispose() {} }), dispose() {} };
      },
      // `visible` and `priority` are recorded because a hidden item KEEPS its last text: without
      // them, "this window is not on the bar" is indistinguishable from "it was, a render ago",
      // and left-to-right order (which is priority order) cannot be asserted at all.
      createStatusBarItem: (_align, priority) => { const it = { text: '', tooltip: '', command: undefined, backgroundColor: undefined, priority, visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} }; statusBarItems.push(it); return it; },
      setStatusBarMessage: () => ({ dispose() {} }),
      createTextEditorDecorationType: () => ({ id: ++decoCounter, dispose() {} }),
      registerFileDecorationProvider: (p) => { decoProvider = p; return { dispose() {} }; },
      registerWebviewViewProvider: (id, p) => { webviewProviders[id] = p; return { dispose() {} }; },
      createWebviewPanel: (id, title) => {
        const panel = {
          id, title, disposed: false, revealed: 0,
          webview: { options: {}, html: '', posts: [], postMessage(m) { this.posts.push(m); return Promise.resolve(true); }, onDidReceiveMessage(cb) { panel.recv = cb; } },
          reveal() { panel.revealed++; },
          onDidDispose(cb) { panel.onDispose = cb; },
          dispose() { panel.disposed = true; panel.onDispose && panel.onDispose(); },
        };
        webviewPanels.push(panel);
        return panel;
      },
      // Real VS Code always hands a cancellation token to a `cancellable` task; the mock does too, so
      // the demo replay's stop path is exercised rather than mocked away.
      withProgress: (_o, task) => task({ report() {} }, { isCancellationRequested: progressCancelled, onCancellationRequested: () => ({ dispose() {} }) }),
      onDidChangeWindowState: () => ({ dispose() {} }),
      onDidChangeActiveTextEditor: () => ({ dispose() {} }),
      onDidChangeVisibleTextEditors: () => ({ dispose() {} }), // DiffBars syncs per-diff review bars on this
      activeColorTheme: { kind: 2 }, // Dark — exercises the dark clear-tint branch
      onDidChangeActiveColorTheme: () => ({ dispose() {} }),
      onDidChangeTextEditorSelection: () => ({ dispose() {} }),
      activeTextEditor: mockEditor,
      visibleTextEditors: [mockEditor],
      showTextDocument: (d) => { opened = d; lastShown = { document: d, selection: null, revealRange() {} }; return Promise.resolve(lastShown); },
      showInformationMessage: (m, ...rest) => {
        infoMessages.push(String(m));
        const items = actionsOf(rest);
        return Promise.resolve(items.includes(infoPick) ? infoPick : undefined);
      },
      showInputBox: () => Promise.resolve(inputBoxValue),
      // The Feed tab's + opens the NATIVE file dialog; the mock answers with
      // one workspace file so the round-trip back to an @mention is testable.
      showOpenDialog: (opts) => { openDialogAsks.push(opts || {}); return Promise.resolve(openDialogAnswer); },
      showQuickPick: (items) => Promise.resolve(quickPick === null ? undefined : items[quickPick]),
      // The session switch pickers use createQuickPick (for per-row buttons — the store-folder reveal).
      // The mock resolves the picker's own Promise on show(): it accepts the item `createQuickPickChoose`
      // returns (firing onDidAccept with it as selectedItems), or hides when that is null/undefined.
      createQuickPick: () => {
        const cbs = { accept: [], hide: [], btn: [] };
        const qp = {
          items: [], selectedItems: [], activeItems: [], value: '',
          title: '', placeholder: '', matchOnDetail: false, canSelectMany: false, busy: false,
          onDidAccept: (f) => cbs.accept.push(f),
          onDidHide: (f) => cbs.hide.push(f),
          onDidTriggerItemButton: (f) => cbs.btn.push(f),
          show: () => Promise.resolve().then(() => {
            const pressed = createQuickPickButton ? createQuickPickButton(qp.items) : undefined;
            if (pressed) cbs.btn.forEach((f) => f(pressed));
            const chosen = createQuickPickChoose ? createQuickPickChoose(qp.items) : undefined;
            if (chosen) { qp.selectedItems = [chosen]; cbs.accept.forEach((f) => f()); }
            else cbs.hide.forEach((f) => f());
          }),
          hide: () => {}, dispose: () => {},
        };
        return qp;
      },
      // The mock reader takes the FIRST action offered.
      showWarningMessage: (m, ...rest) => { warnMessages.push(String(m)); return Promise.resolve(actionsOf(rest)[0]); },
      // Real since VS Code 1.67 and the extension requires ^1.85, so the mock carries it: exitDemo
      // closes the demo's editors before deleting their folder, and that has to be testable.
      tabGroups: {
        all: [{ tabs: openTabs }],
        close: (tab) => { const i = openTabs.indexOf(tab); if (i >= 0) openTabs.splice(i, 1); return Promise.resolve(true); },
      },
    },
    commands: {
      registerCommand: (id, cb) => { commands[id] = cb; return { dispose() {} }; },
      executeCommand: (cmd, ...args) => {
        if (cmd === 'vscode.diff') { diffCalls.push(args); return Promise.resolve(); }
        // The native multi-diff — recorded so the stacked tab's one side-by-side entry point is testable.
        if (cmd === 'vscode.changes') { changesCalls.push(args); return Promise.resolve(); }
        // setContext has no registered handler in the host either — it is a message to the workbench.
        // Recording it is the only way a test can see the keys the package.json when-clauses read.
        if (cmd === 'setContext') { contextKeys[args[0]] = args[1]; return Promise.resolve(); }
        if (cmd === 'vscode.openFolder') { openFolderCalls.push(args); return Promise.resolve(); }
        if (cmd === 'workbench.extensions.uninstallExtension') { uninstalled.push(args[0]); return Promise.resolve(); }
        return Promise.resolve(commands[cmd] && commands[cmd](...args));
      },
    },
    // Only the running build's id is installed, so activation must retire nothing (the pre-rename ids
    // are driven by the retirement test at the end of this file).
    extensions: { getExtension: (id) => (id === 'cell-observatory.oak-observatory-vscode' ? { id } : undefined) },
    comments: {
      createCommentController: (id, label) => {
        commentController = {
          id, label, commentingRangeProvider: undefined,
          createCommentThread: (uri, range, comments) => {
            // `bornWith` records the body the thread was CONSTRUCTED with, which the real platform reads
            // once to pick the header's dismiss icon. The extension then empties `comments`, so without
            // capturing it here the test could not tell a bar built correctly from one built bodyless.
            const thread = { uri, range, comments, bornWith: comments, collapsibleState: undefined, canReply: undefined, contextValue: undefined, label: undefined, state: undefined, disposed: false, dispose() { thread.disposed = true; } };
            commentThreads.push(thread);
            return thread;
          },
          dispose() {},
        };
        return commentController;
      },
    },
    languages: {
      // Two providers register now: the inline-review lens (file documents — what this harness
      // exercises) and the claude-edit diff-action lens. Capture the INLINE one: taking "the last
      // registration" silently swapped providers when the diff lens landed, and every inline
      // assertion below ran against a provider that answers [] for file docs.
      registerCodeLensProvider: (sel, p) => { if (sel?.scheme !== 'claude-edit') lensProvider = p; return { dispose() {} }; },
      registerHoverProvider: (_sel, p) => { hoverProvider = p; return { dispose() {} }; },
    },
    env: {
      clipboard: { writeText: (t) => { clipboardText = t; return Promise.resolve(); } },
      remoteName: undefined, // a local window
      openExternal: (uri) => { openExternalCalls.push(uri); return Promise.resolve(openExternalAnswer); },
    },
  };
  const origLoad = Module._load;
  Module._load = function (req, ...rest) {
    return req === 'vscode' ? vscode : origLoad.call(this, req, ...rest);
  };
  try {
    const ext = require(BUNDLE);
    // globalState backs the tour's remembered float/dock preference.
    const globalState = new Map();
    ext.activate({
      subscriptions: [],
      extensionUri: Uri.file(ws),
      globalState: { get: (k, d) => (globalState.has(k) ? globalState.get(k) : d), update: (k, v) => { globalState.set(k, v); return Promise.resolve(); } },
    });

    assert.deepEqual(uninstalled, [], 'an install with no pre-rename id retires nothing, and never the running build');
    // 0.9.4 (N15): the Edits and Diffs trees are GONE — Review is the one review surface; the raw
    // records stay backend-only (File History still reads them per file).
    assert.ok(!trees['claudeObservatory.edits'] && !trees['claudeObservatory.diffs'],
      'the Edits and Diffs trees are no longer registered');
    assert.ok(trees['claudeObservatory.fileHistory'], 'File History remains a tree');
    // 0.8.0 panel consolidation: Timeline folded into Observations. Round 3: the standalone Multitasking
    // view is folded INTO the Overview (master–detail). Actions is now a SIDEBAR view (moved out of the
    // old bottom-panel Observations dock; 0.9.0 groups it with Prompts + Observations in the Timeline panel).
    assert.ok(!webviewProviders['claudeObservatory.multitask'] && !trees['claudeObservatory.multitask'], 'the standalone Multitasking view is gone (folded into the Overview)');
    // 0.10.0: Prompts, Actions and Observations are ONE webview with a real tab strip. A panel container
    // stacks its views under collapsible headers and has no tabs of its own, so the three stopped being
    // views at all — the two trees became rows the Timeline renders from the same providers.
    const tlProvider = webviewProviders['claudeObservatory.timeline'];
    assert.ok(tlProvider, 'the Timeline is registered as a webview view');
    for (const gone of ['claudeObservatory.actions', 'claudeObservatory.observations'])
      assert.ok(!trees[gone] && !webviewProviders[gone], `${gone} is no longer a view of its own`);
    assert.ok(!webviewProviders['claudeObservatory.prompts'], 'and the Prompts webview became the Timeline');

    // `workspaceRoot()` is folders[0] and every caller reads it live, so adding/removing/reordering
    // folders changes which session the whole extension is about — and nothing else announces it (the
    // store watcher is scoped to ~/.claude, so no file event fires when the WORKSPACE changes). Assert
    // the subscription exists AND that firing it survives: a handler that throws would take out the
    // event for every other listener in the host.
    assert.ok(folderChangeHandlers.length >= 1, 'the extension subscribes to workspace-folder changes');
    assert.doesNotThrow(() => folderChangeHandlers.forEach((cb) => cb({ added: [], removed: [] })),
      'a folder change refreshes without throwing');

    // The SIDEBAR ("Observatory Traces") is purely the review side — the Review webview (first, the
    // default surface) · File History — and the timeline-shaped surfaces (Prompts · Actions ·
    // Observations) live together in the "Observatory Timeline" panel container. The dock
    // ("Observatory Dashboards") keeps Overview · Stats.
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
    const sidebar = pkg.contributes.views.claudeObservatory;
    const dock = pkg.contributes.views.claudeObservatoryDock;
    const timeline = pkg.contributes.views.claudeObservatoryPrompts;
    assert.deepEqual(sidebar.map((v) => v.id),
      ['claudeObservatory.reviewList', 'claudeObservatory.fileHistory'],
      'the Traces sidebar is exactly Review (first — the ONE review surface) and File History');
    assert.equal(sidebar[0].type, 'webview', 'Review is a webview — an actionable list, not a tree');
    // Per-diff actions inside the "Open all in editor" rows ride as COMMENT-THREAD review bars on
    // the after documents (DiffBars) — the multi-diff row-toolbar menu is proposed API stable
    // builds ignore, and code lenses hid inside the hidden-unchanged folds. The bar's buttons are
    // the same diffKeep/diffUndo/diffChat commands, contributed on the diff-bar thread context.
    // Per-diff Keep/Undo/Chat ride a comment-thread REVIEW BAR on the after document, anchored at
    // the first changed line. The two placements that would sit in the row header or the divider
    // (multiDiffEditor/resource/title, diffEditor/gutter/hunk) are both PROPOSED api that stable
    // builds silently drop; code lenses were rejected. NO codeLens default rides along with the bar.
    assert.match(fs.readFileSync(path.resolve(__dirname, '../src/extension.ts'), 'utf8'),
      /createCommentController\('claudeObservatoryDiffBar'/,
      'the per-diff review-bar controller exists');
    for (const proposed of ['multiDiffEditor/resource/title', 'diffEditor/gutter/hunk'])
      assert.ok(!pkg.contributes.menus[proposed], `no contribution to the proposed ${proposed} menu`);
    const diffBarMenu = pkg.contributes.menus['comments/commentThread/title']
      .filter((m) => /claudeDiffEdit/.test(m.when || ''));
    assert.deepEqual(diffBarMenu.map((m) => m.command),
      ['claudeObservatory.diffKeep', 'claudeObservatory.diffUndo', 'claudeObservatory.diffChat',
        'claudeObservatory.diffOpenFull'],
      'the per-diff bar carries Keep/Undo/Chat, plus Open-full-diff on a previewed row');
    // Keep/Undo/Chat must match BOTH thread kinds (plain and preview); Open-full-diff only the
    // preview one — offering "open the full diff" on a diff that is already whole is noise.
    for (const m of diffBarMenu.filter((x) => x.command !== 'claudeObservatory.diffOpenFull'))
      assert.match(m.when, /claudeDiffEdit\//, 'the three verbs match previewed rows too');
    assert.match(diffBarMenu.find((m) => m.command === 'claudeObservatory.diffOpenFull').when,
      /claudeDiffEditPreview/, 'Open-full-diff is offered only where something was left out');
    assert.equal(pkg.contributes.configuration.properties['claudeObservatory.openAllPreviewLines'].default, 50,
      'the open-all preview budget has a default');
    assert.ok(diffBarMenu.every((m) => /claudeObservatoryDiffBar/.test(m.when)),
      'the bar entries are scoped to the diff-bar controller — never the floating review bar');
    assert.ok(!('diffEditor.codeLens' in pkg.contributes.configurationDefaults),
      'no code-lens default: the lenses are gone and nothing else here wants them on');

    // #5 line comments: a SECOND controller ('claudeObservatoryReview') opens the "+" on any line of
    // an after-doc and STORES each comment through core; "Send review comments" batches the unsent
    // ones into one DRAFTED prompt (never auto-sent) and marks the ledger. Declared, registered, wired.
    const extSrc = fs.readFileSync(path.resolve(__dirname, '../src/extension.ts'), 'utf8');
    assert.match(extSrc, /createCommentController\('claudeObservatoryReview'/, 'the per-line review-comment controller exists');
    assert.match(extSrc, /commentingRangeProvider[\s\S]{0,220}?\/after\//, 'it enables commenting ranges on after-docs — not the disabled [] of the button bar');
    assert.match(extSrc, /core\.addComment\(session, \{ unit: id, line, text: reply\.text \}\)/, 'the reply-submit stores the typed comment through core');
    assert.match(extSrc, /core\.composeCommentPrompt[\s\S]{0,320}?deliverChatPrompt[\s\S]{0,200}?markCommentsSent/, 'send composes → drafts (never auto-sends) → marks the ledger');
    const ctxMenu = (pkg.contributes.menus['comments/commentThread/context'] || []).filter((m) => /claudeObservatoryReview/.test(m.when || ''));
    assert.deepEqual(ctxMenu.map((m) => m.command), ['claudeObservatory.addReviewComment'], 'the reply button is addReviewComment, scoped to the review controller');
    for (const { command } of pkg.contributes.commands)
      assert.equal(typeof commands[command], 'function', `${command} is contributed and must be registered`);
    // #6/#7: quoting the agent's last reply drafts a `> ` block into the composer (never auto-sent).
    assert.match(extSrc, /core\.quoteAgentOutput\(session\)[\s\S]{0,700}?deliverChatPrompt/, 'quoteLastReply drafts the quoted reply into the Feed tab');
    assert.ok((pkg.contributes.menus.commandPalette || []).some((m) => m.command === 'claudeObservatory.addReviewComment' && m.when === 'false'),
      'the reply handler is hidden from the palette (it only makes sense from a comment thread)');
    assert.equal(pkg.contributes.configurationDefaults['diffEditor.hideUnchangedRegions.enabled'], true,
      'diffs read as hunks with expandable folds, not whole files');
    // …and a webview declared in the manifest must be REGISTERED, or it renders as an empty pane with
    // no error anywhere. The tree views are asserted the same way further down.
    assert.match(fs.readFileSync(path.resolve(__dirname, '../src/extension.ts'), 'utf8'),
      /registerWebviewViewProvider\('claudeObservatory\.reviewList'/,
      'the Review webview provider is registered under the declared id');
    assert.deepEqual(timeline.map((v) => v.id), ['claudeObservatory.timeline'],
      'the Timeline panel is ONE view — the webview that draws the three tabs itself');
    assert.equal(timeline[0].type, 'webview', 'and it is a webview, not a tree');
    assert.ok(!dock.some((v) => v.id === 'claudeObservatory.actions'), 'Actions is not in the Dashboards dock');
    const containerTitles = Object.fromEntries([...pkg.contributes.viewsContainers.activitybar, ...pkg.contributes.viewsContainers.panel].map((c) => [c.id, c.title]));
    assert.deepEqual(containerTitles,
      { claudeObservatory: 'Observatory Traces', claudeObservatoryDock: 'Observatory Dashboards', claudeObservatoryPrompts: 'Observatory Timeline' },
      'the three containers carry the 0.9.0 names');
    // A container down to ONE visible view is "merged with the container": ViewPaneContainer.getTitle()
    // then draws `${containerTitle}: ${paneTitle}` unless the two are equal. Timeline is permanently
    // single-view, so an unequal name renders the header as "OBSERVATORY TIMELINE: TIMELINE" — the pane
    // title is the manifest `name` verbatim (the provider never assigns webviewView.title), and
    // singleViewPaneContainerTitle, the platform's escape hatch, is not in the `views` contribution schema.
    assert.equal(timeline[0].name, containerTitles.claudeObservatoryPrompts,
      'the one Timeline view is named for its container, so the header reads the container title alone');
    // 0.9.0: the Timeline container is a separate draggable unit rather than tabs wedged beside
    // Overview and Stats. VS Code offers no manifest option to place a view in the secondary side bar,
    // but a container of its own is what makes dragging it there stick cleanly. (Its one view is
    // asserted above — the Timeline webview.)
    assert.deepEqual(dock.map((v) => v.id), ['claudeObservatory.changemap', 'claudeObservatory.stats'], 'the dock is Overview · Stats (0.9.0)');
    assert.ok(
      pkg.contributes.viewsContainers.panel.some((c) => c.id === 'claudeObservatoryPrompts'),
      'and that container is contributed'
    );
    // 0.9.0: the Overview can also live in an EDITOR TAB. The bottom panel stays the default, the two
    // hosts share one renderer (wire()), and exactly ONE of them drives refreshes — two ticking hosts
    // would double every CLI spawn, which is the cost this release spent itself reducing.
    {
      const src = fs.readFileSync(path.resolve(__dirname, '../dist/extension.js'), 'utf8');
      assert.ok(typeof commands['claudeObservatory.openOverviewInEditor'] === 'function', 'the command is registered');
      assert.ok(/createWebviewPanel\(\s*"claudeObservatory\.overviewEditor"/.test(src), 'it opens a webview EDITOR panel');
      assert.ok(/this\.wire\(panel\)/.test(src) && /this\.wire\(view\)/.test(src), 'both hosts go through the same wiring');
      assert.ok(/if \(!this\.editorPanel\) this\.view = view/.test(src), 'the panel view yields while a tab is open');
      assert.ok(/this\.view = this\.panelView/.test(src), '…and takes the wheel back when the tab closes');
      assert.ok(/this\.view === view/.test(src) && /this\.view === panel/.test(src), 'only the DRIVING host refreshes on visibility');
      const pkgCfg = pkg.contributes.configuration.properties || pkg.contributes.configuration[0].properties;
      assert.equal(pkgCfg['claudeObservatory.overviewLocation'].default, 'panel', 'the bottom panel remains the default');
    }
    // 0.9.0: the bulk verbs are scoped to exactly one of two things — the selected PROMPT, else the
    // selected SESSION. The session used to be implicit (the host resolved "the reviewed session"), so
    // picking a sibling agent in Fleet left Accept All accepting a different session than the toolbar
    // was labelled with. The webview now names it and the host VALIDATES it before it becomes a store
    // path: these verbs touch every pending edit in a session, so an unchecked id is not acceptable.
    const bundle = fs.readFileSync(path.resolve(__dirname, '../dist/extension.js'), 'utf8');
    assert.ok(/type:\s*sess,\s*session:\s*selAgentSess\(\)/.test(bundle), 'the toolbar posts the session it is scoped to');
    assert.ok(/function bulkSession[\s\S]{0,600}isSafeSessionId/.test(bundle), 'the host rejects an unsafe session id');
    assert.ok(/function bulkSession[\s\S]{0,700}sessionMeta/.test(bundle), 'and one that is not this workspace\'s');
    for (const cmd of ['keepAll', 'undoAll', 'clearResolved'])
      assert.ok(
        new RegExp(`registerCommand\\("claudeObservatory\\.${cmd}",\\s*\\(sess\\)`).test(bundle),
        `${cmd} takes the scoped session (the palette still passes nothing and gets the reviewed one)`
      );
    // BEHAVIOURAL, because the assertions above only pin the wiring's shape: an early `return cur` in
    // bulkSession satisfies every one of them while silently acting on the wrong session. Seed a SECOND
    // session in this workspace, accept-all scoped to IT, and check the edits that changed are its own.
    {
      const OTHER = 'scopedOther';
      core.ensureStore(OTHER);
      const g = path.join(ws, "scoped.ts");
      fs.writeFileSync(g, 'x\n');
      core.appendLog(OTHER, {
        id: 1, ts: 5000, tool: 'Edit', file: g, status: 'pending',
        beforeBlob: core.writeBlob(OTHER, Buffer.from('x\n')),
        afterBlob: core.writeBlob(OTHER, Buffer.from('x\ny\n')),
      });
      const otherTx = path.join(proj, OTHER + '.jsonl');
      fs.writeFileSync(otherTx,
        JSON.stringify({ timestamp: new Date(5000).toISOString(), type: "user", cwd: ws, message: { role: 'user', content: 'other' } }) + '\n');
      // Age it so the REVIEWED session stays S. Written last it would be the newest transcript and thus
      // the session `currentSession()` resolves to — which would make a broken scope hit the right
      // session by accident, and this whole block prove nothing.
      const old = (Date.now() - 3_600_000) / 1000;
      fs.utimesSync(otherTx, old, old);
      const pendingOf = (s) => core.readLog(s).filter((r) => r.status === 'pending').length;
      const beforeSelf = pendingOf(S);
      assert.equal(pendingOf(OTHER), 1, 'the second session starts with a pending edit');
      // Its one edit is named in the singular on Revert All's button ("Revert 1 edits").
      {
        const warn = vscode.window.showWarningMessage, offered = [];
        vscode.window.showWarningMessage = (m, opts, ...items) => { offered.push(...items); return Promise.resolve(undefined); };
        try { await commands['claudeObservatory.undoAll'](OTHER); } finally { vscode.window.showWarningMessage = warn; }
        assert.deepEqual(offered, ['Revert 1 edit']);
        assert.equal(pendingOf(OTHER), 1, 'cancelled, nothing was reverted');
        const src = fs.readFileSync(path.resolve(__dirname, '../src/extension.ts'), 'utf8');
        assert.match(src, /const verb = `Redo \$\{targets\.length\} edit\$\{targets\.length === 1 \? '' : 's'\}`;[\s\S]{0,400}if \(choice !== verb\) return;/, 'Redo All names its count the same way');
      }
      await commands['claudeObservatory.keepAll'](OTHER);
      assert.equal(pendingOf(OTHER), 0, 'Accept All scoped to the OTHER session accepted its edit');
      assert.equal(pendingOf(S), beforeSelf, '…and left the reviewed session untouched');
      // …and a traversing id must never become a store path. Asserted as "changed nothing here and did
      // not throw" rather than by accepting the reviewed session, which would wreck the fixture the rest
      // of this test depends on.
      const beforeOther = pendingOf(OTHER);
      await commands['claudeObservatory.keepAll']('../escape');
      assert.equal(pendingOf(OTHER), beforeOther, 'an unsafe id is refused, not followed');
      assert.equal(pendingOf(S), beforeSelf, '…and does not silently retarget another session either');
    }
    // 0.9.4 (N15): the collapsible trees are gone with the Edits/Diffs views — nothing left in the
    // sidebar deep enough to need Collapse All (File History is a flat list).
    // …and the palette commands that reveal each Timeline tab after a VS Code layout-persistence hide.
    // …plus the needs-you jump (2026-09-15): registered AND contributed, the same parity every palette door keeps.
    for (const c of ['showPrompts', 'showActions', 'showObservations', 'nextAttention']) {
      assert.ok(typeof commands[`claudeObservatory.${c}`] === 'function', `${c} is registered`);
      assert.ok(pkg.contributes.commands.some((x) => x.command === `claudeObservatory.${c}`), `${c} is contributed to the palette`);
    }
    // Demo mode (0.8.9): the tour view leads the sidebar and only exists while a tour runs, the five
    // commands are contributed, and — the one that decides whether anybody ever finds it — the empty
    // state offers the demo. That last one is the first-run path: the replay drives the capture pipeline
    // in-process, so it genuinely works before `claude-observatory init`.
    // The tour is NOT a sidebar view: a slot there sits in the very container whose other views the
    // tour keeps asking you to look at. It is a detachable webview panel, floating by default.
    assert.ok(!sidebar.some((v) => v.id === 'claudeObservatory.tour'), 'the tour takes no sidebar slot');
    assert.equal(sidebar[0].id, 'claudeObservatory.reviewList', 'so Review still leads the container — the default surface');
    for (const c of ['tourDock', 'tourFloat'])
      assert.ok(pkg.contributes.commands.some((x) => x.command === `claudeObservatory.${c}`), `${c} is contributed`);
    for (const c of ['startDemo', 'restartDemo', 'startTour', 'tourNext', 'tourBack', 'exitDemo'])
      assert.ok(pkg.contributes.commands.some((x) => x.command === `claudeObservatory.${c}`), `${c} is contributed`);
    // Cancel / reset / redo have to be reachable FROM a panel, not only the palette: Start before a
    // demo exists, Restart and Exit once one does. They live on the OVERVIEW's nav bar and nowhere else —
    // the sidebar's job is reviewing the session in front of you, and Exit/Restart sitting in it read as
    // review actions. The sidebar keeps its empty-state link, which is the first-run path.
    const titles = pkg.contributes.menus['view/title'].filter((m) => /claudeObservatory\.(start|restart|exit)Demo$/.test(m.command));
    assert.equal(titles.length, 3, 'Start, Restart and Exit each have a title-bar button');
    assert.match(titles.find((m) => m.command === 'claudeObservatory.startDemo').when, /!claudeObservatory\.demoPresent/, 'Start shows only when no demo is running');
    // Demo mode sits at the END of the title bar, and INLINE. Only the `navigation` group renders as
    // icons; anything else is swept into the "..." overflow, so a plain "put it last" group would have
    // removed these four from the row rather than moving them along it.
    const allTitles = pkg.contributes.menus['view/title'];
    const isDemo = (cmd) => /claudeObservatory\.(startDemo|restartDemo|exitDemo|startTour)$/.test(cmd);
    for (const m of allTitles.filter((x) => isDemo(x.command))) {
      assert.match(m.when || '', /view == claudeObservatory\.changemap/, `${m.command} is offered from the Overview`);
      assert.ok(!/claudeObservatory\.edits/.test(m.when || ''), `${m.command} is NOT in the sidebar's title bar`);
    }
    const nonDemoOrders = allTitles
      .filter((m) => !isDemo(m.command) && /^navigation@\d+$/.test(m.group || ''))
      .map((m) => Number(m.group.split('@')[1]));
    assert.ok(nonDemoOrders.length > 0, 'there are other inline title-bar actions to sort after');
    for (const m of allTitles.filter((x) => isDemo(x.command))) {
      assert.match(m.group || '', /^navigation@\d+$/, `${m.command} stays inline, not in the ... overflow`);
      assert.ok(
        Number(m.group.split('@')[1]) > Math.max(...nonDemoOrders),
        `${m.command} sorts after every other inline title-bar action`
      );
    }
    for (const c of ['restartDemo', 'exitDemo'])
      assert.match(titles.find((m) => m.command === `claudeObservatory.${c}`).when, /&& claudeObservatory\.demoPresent/, `${c} shows only while a demo is running`);
    // N15: welcome content lives on File History (the one remaining tree — a webview never renders
    // viewsWelcome), reduced to TWO variants whose claims are true on a PER-FILE host: the old
    // session-wide "No edits in this session yet" texts lied there (an untouched file empties File
    // History even mid-session), and VS Code stacks every matching entry. Both still offer the demo
    // — the first-run path must survive the tree removal.
    const welcome = pkg.contributes.viewsWelcome.filter((w) => w.view === 'claudeObservatory.fileHistory');
    assert.equal(welcome.length, 2, 'exactly the two per-file-truthful File History empty states');
    assert.ok(welcome.every((w) => /startDemo/.test(w.contents) && w.when), 'both offer the demo and are when-gated');
    assert.ok(!welcome.some((w) => /this session/.test(w.contents)), 'no session-wide claim on a per-file host');
    assert.ok(!pkg.contributes.viewsWelcome.some((w) => /claudeObservatory\.(edits|diffs)$/.test(w.view)),
      'no welcome content targets the removed trees');
    const palette = pkg.contributes.menus.commandPalette || [];
    assert.equal(palette.find((m) => m.command === 'claudeObservatory.tourGoto').when, 'false', 'tourGoto is panel-driven, not a palette command');
    for (const c of ['tourNext', 'tourBack'])
      assert.equal(palette.find((m) => m.command === `claudeObservatory.${c}`).when, 'claudeObservatory.demoTour', `${c} is offered only during a tour`);

    assert.ok(contentProviders['claude-edit'] && contentProviders['claude-observation'], 'blob + markdown content providers registered');
    assert.ok(decoProvider, 'status FileDecorationProvider registered');

    // N15: the Edits/Diffs trees are gone — the Review webview IS the review surface, so exercise
    // its REAL payload and a real mutation, not just the manifest: resolve → ready → grouped rows;
    // keepFile → the listed pending edits flip, group-safe.
    const rvProvider = webviewProviders['claudeObservatory.reviewList'];
    assert.ok(rvProvider, 'the Review webview provider is registered');
    // Its TITLE-BAR nav — the row the Edits view carried until it was removed, and the only home six
    // of these commands have. A webview view cannot draw its own toolbar, so if these entries go the
    // commands become palette-only and the panel looks actionless.
    {
      const titleFor = (c) => pkg.contributes.menus['view/title']
        .filter((e) => (e.when || '').includes('claudeObservatory.reviewList'))
        .some((e) => e.command === `claudeObservatory.${c}`);
      // Search / Filter / Sort are NOT on the title bar any more — they moved into the panel's own
      // inline toolbar (the compact search field + anchored dropdowns), so the title bar carries only
      // the step / bulk / utility commands.
      for (const c of ['reviewPrev', 'reviewNext', 'keepAll', 'undoAll', 'redoAll',
        'clearResolved', 'switchSession', 'refresh', 'toggleInline', 'cleanStore', 'exportSummary',
        'exportTrace', 'doctor']) {
        assert.ok(titleFor(c), `${c} is on the Review view's title bar`);
      }
      for (const c of ['searchEdits', 'filterMenu', 'cycleSort']) {
        assert.ok(!titleFor(c), `${c} is NOT on the title bar — it lives in the inline toolbar now`);
      }
    }
    const rvMsgs = [];
    let rvOnMsg;
    const rvView = {
      visible: true,
      webview: {
        options: null,
        html: '',
        onDidReceiveMessage: (cb) => { rvOnMsg = cb; return { dispose() {} }; },
        postMessage: (m) => { rvMsgs.push(m); return Promise.resolve(true); },
      },
      onDidChangeVisibility: () => ({ dispose() {} }),
      badge: undefined,
    };
    rvProvider.resolveWebviewView(rvView);
    rvOnMsg({ type: 'ready' });
    const rvData = rvMsgs.filter((m) => m.type === 'review').pop().data;
    assert.ok(rvData && Array.isArray(rvData.units) && rvData.units.length >= 2, 'the Review payload lists the units');
    assert.ok(rvData.units.every((u) => typeof u.file === 'string' && typeof u.rel === 'string' && !!u.status),
      'every row carries file, rel and status');
    assert.equal(rvData.scoped, false, 'no prompt picked — the list is session-wide');
    assert.ok(rvView.badge && rvView.badge.value >= 1, 'the pending badge rides the Review view');
    // N22: a chain that CANCELS OUT is not a row, at any status, and the badge beside it agrees.
    // Seeded on its own file so it really does net to nothing (on a file with later work it would
    // merge into that unit instead — correct, but it would prove nothing here).
    {
      const ghost = path.join(ws, 'ghost.txt');
      const gb = core.writeBlob(S, Buffer.from('gone\n'));
      const g1 = core.nextId(S);
      core.appendLog(S, { id: g1, ts: 9000, tool: 'Bash', file: ghost, beforeBlob: gb, afterBlob: null, status: 'pending' });
      const g2 = core.nextId(S);
      core.appendLog(S, { id: g2, ts: 9100, tool: 'Bash', file: ghost, beforeBlob: null, afterBlob: gb, status: 'pending' });
      const before = rvView.badge && rvView.badge.value;
      rvMsgs.length = 0;
      rvOnMsg({ type: 'ready' });
      const d = rvMsgs.filter((m) => m.type === 'review').pop().data;
      assert.ok(!d.units.some((u) => u.rel === 'ghost.txt'), 'the cancelled chain is not a row');
      assert.equal(d.cancelled, 1, 'it is counted in the footer instead');
      assert.deepEqual(d.cancelledIds, [g1, g2], 'whose Dismiss carries every member');
      assert.equal(rvView.badge && rvView.badge.value, before, 'and the badge does not count what the list refuses to show');
      // Dismiss keeps them — and they must STAY hidden, or one click turns the footer into N grey rows.
      rvOnMsg({ type: 'dismissCancelled', ids: d.cancelledIds });
      assert.ok(core.readLog(S).filter((r) => r.file === ghost).every((r) => r.status === 'kept'), 'Dismiss kept them');
      rvMsgs.length = 0;
      rvOnMsg({ type: 'ready' });
      const after = rvMsgs.filter((m) => m.type === 'review').pop().data;
      assert.ok(!after.units.some((u) => u.rel === 'ghost.txt'), 'a dismissed chain stays hidden');
      assert.equal(after.cancelled, 0, 'and there is nothing left to dismiss');
      core.clearResolvedIds(S, [g1, g2]); // restore the fixture for the assertions below
    }

    // Search narrows THIS list (the trees that used to carry the filter are gone), and while a filter
    // is on the bulk buttons hide — they act on the whole ask/session, which is wider than what the
    // filtered list shows. A filter that matches nothing says so instead of blaming the session.
    {
      inputBoxValue = 'app.txt';
      await commands['claudeObservatory.searchEdits']();
      rvMsgs.length = 0;
      rvOnMsg({ type: 'ready' });
      let d = rvMsgs.filter((m) => m.type === 'review').pop().data;
      assert.equal(d.filter, 'app.txt', 'the filter rides the payload');
      assert.ok(d.units.every((u) => u.rel.includes('app.txt')), 'and narrows the rows');
      inputBoxValue = 'zzz-no-such-file';
      await commands['claudeObservatory.searchEdits']();
      rvMsgs.length = 0;
      rvOnMsg({ type: 'ready' });
      d = rvMsgs.filter((m) => m.type === 'review').pop().data;
      assert.equal(d.units.length, 0, 'a filter matching nothing lists nothing');
      assert.equal(d.filter, 'zzz-no-such-file', '…and still names what it filtered by');
      inputBoxValue = ''; // restore for the assertions below
      await commands['claudeObservatory.searchEdits']();
      rvOnMsg({ type: 'ready' });
    }

    // Reset scope (2026-08-19): one exit from every narrowing, as a real command — a live Search
    // filter clears and the payload agrees. (The folder tile is webview state; the prompt scope
    // clears through clearPromptScope, which executeCommand dispatches for real here.)
    {
      inputBoxValue = 'app.txt';
      await commands['claudeObservatory.searchEdits']();
      rvMsgs.length = 0;
      rvOnMsg({ type: 'ready' });
      assert.equal(rvMsgs.filter((m) => m.type === 'review').pop().data.filter, 'app.txt', 'a filter is on before the reset');
      await commands['claudeObservatory.resetScope']();
      rvMsgs.length = 0;
      rvOnMsg({ type: 'ready' });
      assert.equal(rvMsgs.filter((m) => m.type === 'review').pop().data.filter, '', 'Reset scope cleared the Search filter');
    }

    // The Review panel's opener is ONE button: stacked is the default view and
    // the stacked tab's own bar carries the side-by-side switch — the sidebar must not offer two.
    assert.ok(rvView.webview.html.includes('Open all in editor'), 'the sidebar offers ONE opener');
    assert.ok(!rvView.webview.html.includes('Open all · side by side') && !rvView.webview.html.includes('Open all · stacked'),
      '…and the two-button split is gone');
    // Resolved rows: kept wears the ↺ revert arrow (not a second ✗), undone the ↻ redo arrow.
    assert.ok(rvView.webview.html.includes('Revert this kept edit">↺<') && rvView.webview.html.includes('Re-apply this reverted edit">↻<'),
      'kept rows revert with the undo arrow; undone rows redo with the forward arrow');

    // The STACKED open-all view (2026-08-19): one webview of inline blocks — added/context lines
    // classed apart (what Spotlight dims vs keeps), per-block ✓ Keep / ✗ Undo / 💬 Chat, syntax
    // tokens INSIDE the green/red bands, wrap-not-scroll lines with a bounded per-block box, and a
    // decided block that STAYS under its verdict with its remaining verb (kept → ↺ Revert,
    // reverted → ↻ Redo) instead of vanishing mid-read. Seeded on its own file, restored after.
    {
      const sf = path.join(ws, 'stacked.js');
      const b1 = core.writeBlob(S, Buffer.from('const one = 1;\nconst two = 2;\nconst three = 3;\n'));
      const b2 = core.writeBlob(S, Buffer.from('const one = 1;\nconst two = 22; // more\nconst three = 3;\n'));
      const sid = core.nextId(S);
      core.appendLog(S, { id: sid, ts: 9500, tool: 'Edit', file: sf, beforeBlob: b1, afterBlob: b2, status: 'pending' });
      fs.writeFileSync(sf, 'const one = 1;\nconst two = 22; // more\nconst three = 3;\n'); // on disk at `after`, so Undo/Redo rewrite cleanly
      // A HOSTILE block in the same page: the extension is `constructor` (an Object.prototype
      // member — the exact lookup that used to throw before the tab ever rendered) and the diff
      // carries live HTML. Its presence proves the plain-text fallback; its content pins escaping.
      const xf = path.join(ws, 'xss.constructor');
      const xb1 = core.writeBlob(S, Buffer.from('safe\n'));
      const xb2 = core.writeBlob(S, Buffer.from('safe\n<script>alert(1)</script>\n'));
      const xid = core.nextId(S);
      core.appendLog(S, { id: xid, ts: 9600, tool: 'Edit', file: xf, beforeBlob: xb1, afterBlob: xb2, status: 'pending' });
      const nPanels = webviewPanels.length;
      rvOnMsg({ type: 'openAllStacked' });
      await new Promise((r) => setImmediate(r)); // renderStacked is async (grammar resolution) — let the first render land
      assert.equal(webviewPanels.length, nPanels + 1, 'openAllStacked opens ONE webview panel');
      const sp = webviewPanels[webviewPanels.length - 1];
      assert.ok(/stacked/.test(sp.title), 'the tab is titled as the stacked view');
      assert.ok(sp.webview.html.includes(`class="id">#${sid}<`) && sp.webview.html.includes('stacked.js'), 'the seeded edit renders as a block');
      assert.ok(sp.webview.html.includes('body.spot .ln.ctx'), 'the Spotlight dim rule is in the page');
      assert.ok(sp.webview.html.includes('<body class="spot">'), '…and Spotlight is ON by default (server-rendered, no flash)');
      assert.ok(/id="spot" aria-pressed="true"/.test(sp.webview.html), '…with its toggle pressed in the bar');
      assert.ok(sp.webview.html.includes('>Side by side<'), '…and the side-by-side switch beside it');
      // One size for every button (the emoji-labelled ones drifted): a shared,
      // explicit line box — and no emoji left in any button label to inflate it.
      assert.ok(/\.bt\{[^}]*height:22px/.test(sp.webview.html), 'the buttons share one explicit size');
      assert.ok(!/<button[^>]*>[^<]*[💡◫💬]/u.test(sp.webview.html), 'no emoji inside button labels');
      assert.ok(/\.acts\{[^}]*gap:/.test(sp.webview.html), 'the action row spaces its own buttons (Keep/Undo touched without it)');
      // Same line, always: the header never wraps, the action row never shrinks,
      // the file path is the shrink absorber, and below the container threshold the .lbl words hide
      // so the ✓/✗ glyphs alone remain instead of wrapping or clipping.
      assert.ok(/\.blk header\{[^}]*flex-wrap:nowrap/.test(sp.webview.html), 'the block header never wraps');
      assert.ok(/\.acts\{[^}]*flex:none/.test(sp.webview.html), 'the action row never shrinks');
      assert.ok(/\.blk \.file\{[^}]*text-overflow:ellipsis/.test(sp.webview.html), 'the file path absorbs the shrink (full path on its tooltip)');
      assert.ok(/@container \(max-width:\d+px\)\{\.lbl\{display:none\}\}/.test(sp.webview.html), 'narrow blocks fall back to icon-only verbs');
      assert.ok(new RegExp('data-keep="' + sid + '"[^>]*>✓<span class="lbl"> Keep</span>').test(sp.webview.html),
        '…because the glyph and the word are separate spans');
      // Debug seam: CO_DUMP_STACKED=<path> writes the real rendered page for eyeball/layout probes.
      if (process.env.CO_DUMP_STACKED) fs.writeFileSync(process.env.CO_DUMP_STACKED, sp.webview.html);
      assert.ok(sp.webview.html.includes('class="ln ctx"') && sp.webview.html.includes('class="ln add"'),
        'context and changed lines are classed apart — the seam Spotlight dims across');
      // Syntax color INSIDE the bands: the band rules keep their backgrounds but no longer override
      // the foreground, and the code is tokenized (const → keyword span, 22 → number, // more → comment).
      assert.ok(sp.webview.html.includes('<span class="tk-k">const</span>'), 'keywords are tokenized');
      assert.ok(sp.webview.html.includes('<span class="tk-n">22</span>'), 'numbers are tokenized');
      assert.ok(/<span class="tk-c">\/\/ more<\/span>/.test(sp.webview.html), 'comments are tokenized');
      assert.ok(!/\.ln\.add\{[^}]*color:/.test(sp.webview.html) && !/\.ln\.del\{[^}]*color:/.test(sp.webview.html),
        'the add/del bands are BACKGROUNDS only — token colors survive inside them');
      // The hostile block: it RENDERED (the prototype-member extension takes the plain-text path
      // instead of throwing the whole tab away), and its payload is inert text, never markup.
      assert.ok(sp.webview.html.includes(`class="id">#${xid}<`), 'a *.constructor file still renders as a block');
      assert.ok(!sp.webview.html.includes('<script>alert(1)'), 'hostile diff content is never live markup');
      assert.ok(sp.webview.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), '…it is escaped text');
      // Wrap, never a horizontal bar; a tall block scrolls inside its own box.
      assert.ok(sp.webview.html.includes('white-space:pre-wrap') && sp.webview.html.includes('overflow-wrap:anywhere'),
        'lines wrap to the window');
      assert.ok(sp.webview.html.includes('max-height:60vh') && sp.webview.html.includes('overflow-y:auto'),
        'each block box is height-bounded with its own vertical scrollbar');
      assert.ok(!/overflow-x:\s*auto/.test(sp.webview.html), 'no horizontal scrollbar anywhere in the stacked page');
      assert.ok(new RegExp('data-keep="' + sid + '"').test(sp.webview.html), 'the block carries its own ✓ Keep');
      assert.ok(!sp.webview.html.includes('data-chat'), 'no per-block Chat button (dropped by request, 2026-08-20)');
      // The one side-by-side entry point (the sidebar's second opener is gone): the stacked bar's
      // button → the native multi-diff, fed every pending block.
      sp.recv({ type: 'sideBySide' });
      await new Promise((r) => setImmediate(r));
      assert.equal(changesCalls.length, 1, 'the Side-by-side button opens the native multi-diff');
      assert.match(String(changesCalls[0][0]), /change\(s\)/, '…titled with the scope');
      assert.ok(changesCalls[0][1].length >= 2, '…carrying a resource triple per pending block');
      // Decisions PATCH the one block (postMessage swaps its action row) — the document, its
      // scroll and its Spotlight are never reloaded. The page carries the swap handler…
      assert.ok(sp.webview.html.includes("m.type!=='acts'"), 'the page carries the acts-swap handler');
      const lastActs = () => sp.webview.posts.filter((p) => p.type === 'acts').pop();
      sp.recv({ type: 'keep', id: sid });
      assert.equal(core.readLog(S).filter((r) => r.id === sid).pop().status, 'kept', 'the block Keep landed in the store');
      let acts = lastActs();
      assert.ok(acts && acts.id === sid && acts.done === true, 'Keep patched exactly the decided block');
      assert.ok(/✓<span class="lbl"> kept<\/span>/.test(acts.html), 'the decided block wears its verdict');
      // A KEPT block keeps its one remaining verb: ↺ Revert (the undo arrow; glyph + hideable word).
      assert.ok(new RegExp('data-undo="' + sid + '"[^>]*>↺<span class="lbl"> Revert</span>').test(acts.html), 'a kept block offers ↺ Revert');
      sp.recv({ type: 'undo', id: sid });
      await new Promise((r) => setImmediate(r)); // undoOne is async — let the revert land and patch
      assert.equal(core.readLog(S).filter((r) => r.id === sid).pop().status, 'undone', 'Revert on a kept block reverted it');
      assert.equal(fs.readFileSync(sf, 'utf8'), 'const one = 1;\nconst two = 2;\nconst three = 3;\n', '…and the file is back to before');
      acts = lastActs();
      assert.ok(/✗<span class="lbl"> reverted<\/span>/.test(acts.html), 'the reverted block wears its verdict');
      assert.ok(new RegExp('data-redo="' + sid + '"[^>]*>↻<span class="lbl"> Redo</span>').test(acts.html), '…and offers ↻ Redo');
      sp.recv({ type: 'redo', id: sid });
      await new Promise((r) => setImmediate(r)); // redoOne is async too
      // Redo restores the PRE-REVERT decision: this block was KEPT before its
      // revert, so redo brings the decision back with the content — never a reopened 'pending'.
      assert.equal(core.readLog(S).filter((r) => r.id === sid).pop().status, 'kept', 'Redo restored the pre-revert decision');
      assert.equal(fs.readFileSync(sf, 'utf8'), 'const one = 1;\nconst two = 22; // more\nconst three = 3;\n', '…and the file carries the change again');
      acts = lastActs();
      assert.ok(acts.done === true && new RegExp('data-undo="' + sid + '"[^>]*>↺<span class="lbl"> Revert</span>').test(acts.html),
        'a redone kept block wears ✓ kept + ↺ Revert again');
      core.setStatusMany(S, [sid, xid], 'kept');
      core.clearResolvedIds(S, [sid, xid]); // restore the fixture for the assertions below
      fs.rmSync(sf, { force: true });
      sp.dispose(); // …and the panel ledger for the tour assertions (dispose also exercises the provider's cleared-ref path)
      webviewPanels.pop();
    }

    // A block one line past its preview budget says "+1 more diff line".
    {
      const pf = path.join(ws, 'budget.txt');
      const pid = core.nextId(S);
      core.appendLog(S, { id: pid, ts: 9700, tool: 'Edit', file: pf, beforeBlob: core.writeBlob(S, Buffer.from('x\ny\nz\n')),
        afterBlob: core.writeBlob(S, Buffer.from('x\nY\nz\n')), status: 'pending' });
      fs.writeFileSync(pf, 'x\nY\nz\n');
      configValues.openAllPreviewLines = 2; // four patch lines shown; this block has five (@@, x, -y, +Y, z)
      rvOnMsg({ type: 'openAllStacked' });
      await new Promise((r) => setImmediate(r));
      const bp = webviewPanels[webviewPanels.length - 1];
      assert.ok(bp.webview.html.includes('+1 more diff line — this block is previewed'), 'one line past the budget is "1 more diff line"');
      delete configValues.openAllPreviewLines;
      core.setStatusMany(S, [pid], 'kept');
      core.clearResolvedIds(S, [pid]);
      fs.rmSync(pf, { force: true });
      bp.dispose();
      webviewPanels.pop();
    }

    // keepFile acts on exactly the listed pending rows of that file (raw member ids, group-safe).
    rvOnMsg({ type: 'keepFile', file: F });
    assert.ok(core.readLog(S).filter((r) => r.file === F).every((r) => r.status === 'kept'),
      'keepFile kept the file’s pending edits');
    core.setStatusMany(S, core.readLog(S).map((r) => r.id), 'pending'); // restore for downstream assertions
    await commands['claudeObservatory.refresh'](); // re-render decorations from the RESTORED statuses — the star assertions below pop the LAST render

    // File History: a flat, chronological list of just the ACTIVE file's edits (follows the editor).
    const fileHistoryTree = trees['claudeObservatory.fileHistory'];
    assert.ok(fileHistoryTree, 'File History view registered');
    const fhRows = fileHistoryTree.getChildren();
    assert.equal(fhRows.length, 2, "file history lists the active file's edits");
    assert.equal(fhRows[0].rec.id, 1, 'file history is chronological (oldest first)');
    const fhItem = fileHistoryTree.getTreeItem(fhRows[0]);
    assert.match(fhItem.label, /#1/, 'file history row leads with the edit id');
    assert.equal(fhItem.command.command, 'claudeObservatory.openFileAtEdit', 'file history row click opens file at edit');
    assert.equal(fhItem.contextValue, 'edit', 'pending file-history row reuses the edit context menu');

    // ✨ gutter-star decorations: one at the START (first line) of each edit — #1 -> line 0, #2 -> line 3.
    // (These ranges get the star.svg gutterIconPath; no whole-line green fill anymore.)
    const starCall = decoCalls.filter((c) => c.typeId === 2).pop();
    assert.ok(starCall, 'gutter star decorations applied');
    assert.equal(starCall.opts.length, 2, 'one gutter star per edit');
    const starLines = new Set(starCall.opts.map((o) => o.start.line));
    assert.ok(starLines.has(0), 'edit #1 gets a gutter star at its first line (0)');
    assert.ok(starLines.has(3), 'edit #2 gets a gutter star at its first line (3)');

    // deletions render as red ghost text (decoration type 3); these edits only replace lines (even
    // swaps), so it must stay empty — a modification must never surface removed-line ghost text.
    const ghost = decoCalls.filter((c) => c.typeId === 3).pop();
    assert.ok(ghost, 'deletion ghost decoration applied');
    assert.equal(ghost.opts.length, 0, 'no ghost text for a pure modification');

    // inline CodeLens = the inline menu per edit: "🔬 #N +A −R · n/m" (opens the floating review bar)
    // + ✓ Keep · ✗ Undo · 💬 Chat · ⧉ Diff (full diff tab) · ⋯ Details (the bubble). Reasoning is NOT on
    // the CodeLens — it rides in the bubble instead.
    assert.ok(lensProvider, 'CodeLens provider registered');
    const lenses = lensProvider.provideCodeLenses(doc);
    assert.ok(lenses.length >= 12, 'enriched CodeLens rows (header + Keep/Undo/Chat/Diff/Details per edit)');
    const header = lenses.filter((l) => l.command.command === 'claudeObservatory.showReviewBar');
    assert.ok(header.length >= 2, 'each edit’s lens row leads with a header that opens the floating review bar');
    assert.ok(header.every((l) => /^🔬 #\d+\s+\+\d+\s+−\d+/.test(l.command.title)),
      'the header leads with the 🔬 brand emoji — per F5 the ONLY thing in a lens row that escapes the dim grey foreground');
    // A codicon in a lens is forced to `color: currentColor !important`, i.e. the same dim grey — so the
    // row must not spend its one coloured glyph on a `$(…)`. This is the assertion that keeps 4.3 true.
    assert.ok(!lenses.some((l) => /\$\(/.test(l.command.title || '')),
      'no $(codicon) anywhere in the lens row (they render as unstyleable dim grey)');
    // the Diff-axis position rides on the lens (the editor tab bar can't render live text); the File axis
    // moved to the review bar's label, where 13px leaves room for words.
    assert.ok(header.every((l) => /·\s+\d+\/\d+$/.test(l.command.title)), 'the header ends with the Diff-axis position (n/m)');
    assert.ok(!lenses.some((l) => /file \d+\/\d+/.test(l.command.title || '')), 'and the File axis is gone from the lens (it lives on the bar)');
    assert.ok(lenses.every((l) => typeof l.command.tooltip === 'string' && l.command.tooltip.length > 0),
      'every shortened lens carries a tooltip — VS Code renders it as a real title= on the link');
    assert.ok(header.every((l) => /edit \d+ of \d+ pending in this file/.test(l.command.tooltip)),
      'and the header’s tooltip spells out what "n/m" counts');
    assert.ok(lenses.some((l) => l.command.command === 'claudeObservatory.inlineKeep'), 'a Keep lens');
    assert.ok(lenses.some((l) => l.command.command === 'claudeObservatory.inlineUndo'), 'an Undo lens');
    assert.ok(lenses.some((l) => l.command.command === 'claudeObservatory.chatEdit'), 'a Chat lens');
    assert.ok(lenses.some((l) => l.command.command === 'claudeObservatory.openDiff' && /⧉ Diff/.test(l.command.title) && l.command.arguments[0].rec), 'a Diff lens opens the full diff tab');
    assert.ok(lenses.some((l) => l.command.command === 'claudeObservatory.viewChanges' && /⋯ Details/.test(l.command.title)), 'a Details lens opens the review bubble');
    assert.ok(!lenses.some((l) => l.command.command === 'claudeObservatory.showObservation'), 'no reasoning lens on the CodeLens (reasoning lives in the bubble)');
    // no editor hover provider (the hover card was removed earlier)
    assert.equal(hoverProvider, null, 'no editor hover provider');

    // "view changes" opens the inline review BUBBLE (Comment API) at the edit, its diff rendered in
    // git's own theme colors via sanitizer-safe <span style> (the technique GitLens uses). Toolbar
    // buttons (peekKeep/Undo/Chat/Prev/Next) act on the bubble; no clickable command links in the body.
    assert.ok(commentController && commentController.id === 'claudeObservatory', 'comment controller registered');
    for (const c of ['claudeObservatory.viewChanges', 'claudeObservatory.peekKeep', 'claudeObservatory.peekUndo',
      'claudeObservatory.peekChat', 'claudeObservatory.peekPrev', 'claudeObservatory.peekNext',
      'claudeObservatory.peekPrevFile', 'claudeObservatory.peekNextFile', 'claudeObservatory.peekAcceptFile',
      'claudeObservatory.peekRejectFile', 'claudeObservatory.diffPrevEdit', 'claudeObservatory.diffNextEdit']) {
      assert.ok(typeof commands[c] === 'function', `${c} registered`);
    }
    await commands['claudeObservatory.viewChanges'](1);
    const peek1 = commentThreads[commentThreads.length - 1];
    assert.ok(peek1, 'viewChanges opens a comment thread (the inline review bubble)');
    assert.equal(peek1.contextValue, 'claudeEdit', 'thread tagged for the bubble toolbar when-clause');
    assert.equal(peek1.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded, 'bubble opens expanded');
    assert.equal(peek1.canReply, false, 'bubble has no reply box');
    const body1 = peek1.comments[0].body;
    assert.equal(body1.supportHtml, true, 'body enables supportHtml (colored spans need it)');
    assert.match(body1.value, /#1\b/, 'bubble shows the edit number');
    assert.match(body1.value, /\+\d+ −\d+/, 'bubble shows the +A −B line counts');
    // the floating bubble is the full nav bar: its header carries the Diff-axis + File-axis counters
    assert.match(body1.value, /Diff 1\/2/, 'bubble header shows the Diff-axis counter (edit 1 of 2 in the file)');
    assert.match(body1.value, /File 1\/1/, 'bubble header shows the File-axis counter (file 1 of 1 pending)');
    assert.ok(body1.value.includes('<span style="color:var(--vscode-gitDecoration-addedResourceForeground);background-color:var(--vscode-diffEditor-insertedTextBackground);">'),
      "added lines use git's green text + translucent green line fill");
    assert.ok(body1.value.includes('<span style="color:var(--vscode-gitDecoration-deletedResourceForeground);background-color:var(--vscode-diffEditor-removedTextBackground);">'),
      "deleted lines use git's red text + translucent red line fill");
    assert.ok(!body1.value.includes('command:'), 'no clickable command links in the body (toolbar carries the actions)');
    // Prev/Next is our OWN nav: peekNext steps the bubble to edit #2.
    await commands['claudeObservatory.peekNext']();
    const peek2 = commentThreads[commentThreads.length - 1];
    assert.ok(peek2 !== peek1 && peek1.disposed, 'peekNext disposes the old thread and opens the next edit');
    assert.match(peek2.comments[0].body.value, /#2\b/, 'peekNext advanced the bubble to edit #2');
    // peekKeep marks the bubble's edit kept and closes it; restore pending for later assertions.
    await commands['claudeObservatory.peekKeep']();
    assert.equal(core.findRecord(S, 2).status, 'kept', 'peekKeep marks the peeked edit kept');
    assert.ok(peek2.disposed, 'peekKeep disposes the thread');
    core.setStatus(S, 2, 'pending'); // undo the mutation so the store stays at "2 pending" downstream
    // Prev/Next also live on diff TABS (Diffs tree / revision nav): from #1's diff URI, Next → #2's diff.
    await commands['claudeObservatory.openDiff']({ kind: 'edit', rec: core.findRecord(S, 1) });
    const dUri = diffCalls[diffCalls.length - 1][1];
    await commands['claudeObservatory.diffNextEdit'](dUri);
    assert.match(diffCalls[diffCalls.length - 1][2], /#2/, 'diffNextEdit opens the next pending edit in the file');
    diffCalls.length = 0; // reset so the later openDiff test still sees exactly one diff call

    // Observations view (0.8.0, Timeline folded in): timeline-STYLE — a recap on top, then the edit feed
    // with adjacent same-file edits coalesced into ×N runs (each carrying the agent's reasoning inline),
    // then a Next-steps group at the end. The two app.txt edits coalesce into one ×2 run.
    // 0.10.0: the VIEW is gone, the PROVIDER is not — the Timeline webview renders these exact rows. So
    // every assertion below still drives the shipped view-model; only where it draws changed.
    const obsTree = tlProvider.observations;
    assert.ok(obsTree, 'the Observations feed still has its provider (the Timeline renders it)');
    const obsChildren = obsTree.getChildren();
    assert.equal(obsChildren[0].kind, 'recap', 'first node is the recap line');
    const recapItem = obsTree.getTreeItem(obsChildren[0]);
    assert.equal(recapItem.label, 'Reviewing app.txt edits', 'recap shows the session title (aiTitle)');
    assert.ok(!recapItem.command, 'recap has no click command — refresh is a button');
    assert.equal(recapItem.contextValue, 'recap');
    // timeline-style coalescing: the two same-file edits become one ×2 run (combined delta).
    const obsRun = obsChildren.find((n) => n.kind === 'tlrun');
    assert.ok(obsRun, 'the two same-file edits coalesce into one ×N run');
    const runItem = obsTree.getTreeItem(obsRun);
    assert.match(runItem.label, /app\.txt\s+×2/, 'run row shows the file + ×2');
    assert.match(runItem.description, /^\+\d+ −\d+/, 'run row shows the combined delta');
    assert.equal(runItem.contextValue, 'file', 'run reuses the file Keep-all/Undo-all/Clear menus');
    // expand the run → per-edit rows, each showing the agent's reasoning inline, with Keep/Undo.
    const runEdits = obsTree.getChildren(obsRun);
    assert.equal(runEdits.length, 2, 'run expands to its per-edit rows');
    const eItem = obsTree.getTreeItem(runEdits[0]);
    assert.match(eItem.label, /#\d/, 'edit row leads with #id');
    assert.match(String(eItem.description), /Operation/, "edit row shows the agent's reasoning inline");
    assert.ok(runEdits.some((n) => String(obsTree.getTreeItem(n).description).endsWith(` · ${LONG_WHY}`)), 'a reasoning line longer than the row is shown whole, never cut with an ellipsis');
    assert.equal(eItem.contextValue, 'edit', 'per-edit rows reuse the edit context menu (Keep/Undo/Chat)');
    assert.equal(eItem.command.command, 'claudeObservatory.showObservation', 'edit row opens the combined report');
    // Next steps: the still-open to-dos + heuristic follow-ups, grouped at the end.
    assert.ok(obsChildren.some((n) => n.kind === 'steps'), 'the Next-steps group is present');
    assert.ok(obsChildren.some((n) => n.kind === 'suggestion'), 'next-steps suggestions are listed');
    // 0.8.7 review (P11): Context — what shaped this session — sits BEFORE Next steps and NESTS under its
    // own header, so a long list collapses as one unit instead of burying everything after it.
    fs.writeFileSync(path.join(ws, 'CLAUDE.md'), '# project instructions\n'); // one file-present source
    const obsCtx = obsTree.getChildren();
    const ctxHead = obsCtx.find((n) => n.kind === 'ctxhead');
    assert.ok(ctxHead, 'the Context section appears once this session has a context source');
    assert.ok(obsCtx.indexOf(ctxHead) < obsCtx.findIndex((n) => n.kind === 'steps'), 'Context is placed BEFORE Next steps');
    assert.ok(!obsCtx.some((n) => n.kind === 'ctxsrc'), 'context sources are no longer flat root-level siblings');
    const ctxKids = obsTree.getChildren(ctxHead);
    assert.ok(ctxKids.length >= 1 && ctxKids.every((n) => n.kind === 'ctxsrc'), 'the sources nest under the Context header');
    const ctxItem = obsTree.getTreeItem(ctxHead);
    assert.equal(ctxItem.collapsibleState, vscode.TreeItemCollapsibleState.Expanded, 'a short Context list opens');
    assert.match(String(ctxItem.description), new RegExp('^' + ctxKids.length + ' · '), 'the header states how many sources it holds');
    const bigCtx = obsTree.getTreeItem({ kind: 'ctxhead', note: ctxHead.note, sources: new Array(6).fill(ctxKids[0].src) });
    assert.equal(bigCtx.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed, 'a long Context list auto-folds — its header still carries the count');
    const obsMd = contentProviders['claude-observation'].provideTextDocumentContent({ authority: 'obs', path: '/edit-1.md', query: 's=' + S });
    assert.match(obsMd, /\*\*Summary:\*\*/, 'observation markdown has a summary');

    // Actions tab (0.8.0 round 3, moved out of Multitasking) — the session's tool-call timeline as the
    // second tab of the Observations panel: collapsible category subsections (from buildActionGroups),
    // each action TIMESTAMPED; an edit-action drills into its review. The Subagents (agent) category is
    // dropped (those are the Overview fleet). The two seeded Edits form the "Edits" subsection.
    const actTree = tlProvider.actions;
    assert.ok(actTree, 'the Actions feed still has its provider (the Timeline renders it)');
    const actGroups = actTree.getChildren();
    const editGroup = actGroups.find((n) => n.kind === 'agroup' && n.label === 'Edits');
    assert.ok(editGroup, 'the Actions timeline has a collapsible "Edits" category subsection');
    assert.equal(actTree.getTreeItem(editGroup).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed, 'category subsections are collapsed by default (user expands on demand)');
    assert.match(String(actTree.getTreeItem(editGroup).description), /3/, 'the Edits subsection counts the seeded edits (two in the workspace, one outside it)');
    assert.ok(!actGroups.some((n) => n.kind === 'agroup' && n.label === 'Subagents'), 'the Subagents category is dropped (those are the Overview fleet)');
    const actRows = actTree.getChildren(editGroup);
    assert.equal(actRows.length, 3, 'the Edits subsection expands to its action rows');
    // Rows are newest-first, so the head of the list is the out-of-workspace edit — which has no store
    // record to review. The linked one is the row that drills into its review.
    const aItem = actTree.getTreeItem(actRows.find((n) => n.rec.editId != null));
    assert.match(aItem.label, /Edit/, 'an action row shows the tool');
    assert.ok(/\d\d:\d\d|--:--/.test(aItem.label), 'an action row leads with a TIMESTAMP column');
    assert.equal(aItem.command.command, 'claudeObservatory.viewChanges', 'an edit-action links to its review (viewChanges)');
    assert.ok(typeof aItem.command.arguments[0] === 'number', 'the edit-action carries the store edit id to review');
    // 0.8.7 review (P6): a flagged command must say WHY in place — core already scored the reasons, and
    // making the user leave the panel to learn what "⚠ HIGH" meant is the whole cost of the flag.
    const riskItem = actTree.getTreeItem({ kind: 'arow', rec: {
      ts: Date.now(), tool: 'Bash', category: 'exec', target: 'rm -rf build', ok: false, isError: false,
      risk: { level: 'medium', reasons: ['recursive/forced delete (rm -rf)', 'writes outside the workspace'] },
    } });
    assert.match(String(riskItem.description), /⚠ medium/, 'a flagged row spells the level out ("medium", never "med")');
    assert.match(String(riskItem.tooltip), /⚠ medium risk: recursive\/forced delete \(rm -rf\) · writes outside the workspace/,
      'the tooltip states core’s own reasons for the flag');
    // 0.8.7: the footprint folded into the Risk + Egress audits, which live HERE — and both sections are
    // built from the SAME parsed action stream, so the seeded out-of-workspace read/edit must surface.
    const oLive = actGroups.find((n) => n.kind === 'ogroup');
    assert.ok(oLive, 'an edit outside the workspace grows its own section in the Actions tree');
    assert.deepEqual(oLive.writes.map((w) => w.file), ['~/notes/outside.md'], 'it names the file, home-shortened as core reports it');
    assert.deepEqual([oLive.files, oLive.edits], [1, 1], 'and counts the files and the edits that landed there');
    const eLive = actGroups.find((n) => n.kind === 'egroup');
    assert.ok(eLive && eLive.channels.some((ch) => ch.kind === 'file' && ch.scope === 'local' && ch.target === '~/notes/outside.md'),
      'a read from outside the workspace is an EGRESS channel — reach past the boundary, exactly like a fetch');
    assert.ok(actGroups.indexOf(oLive) < actGroups.indexOf(eLive) && actGroups.indexOf(oLive) > actGroups.findIndex((n) => n.kind === 'agroup'),
      'the audits sit after the action categories, risk before egress (the order the CLI reports them)');
    // Risk gains the edits that landed outside the workspace — the one fact the file ledger cannot state,
    // since it shows every path workspace-relative.
    const oGroup = actTree.getTreeItem({ kind: 'ogroup', writes: new Array(50).fill({ file: '~/notes/x.md', count: 2 }), files: 62, edits: 130 });
    assert.equal(oGroup.label, 'Outside the workspace', 'the out-of-workspace writes get their own section, after the command groups');
    assert.equal(String(oGroup.description), '50 of 62 files · 130 edits', 'the header counts files and edits, and says the list is partial');
    assert.match(String(oGroup.tooltip), /12 file\(s\) not shown/, 'a capped list says how many rows it hid — never reads as the whole story');
    assert.equal(String(actTree.getTreeItem({ kind: 'ogroup', writes: [{ file: '~/a.md', count: 1 }], files: 1, edits: 1 }).description), '1 file · 1 edit',
      'an uncapped list states its size plainly (no phantom "of"), one of each in the singular');
    const oRow = actTree.getTreeItem({ kind: 'orow', w: { file: '~/notes/x.md', count: 3 } });
    assert.equal(oRow.label, 'x.md', 'a row names the file');
    assert.match(String(oRow.description), /~\/notes · ×3/, '…with its directory and how many edits landed there');
    assert.equal(oRow.command.command, 'vscode.open', 'a row opens the file that was written outside the workspace');
    assert.ok(!oRow.command.arguments[0].fsPath.startsWith('~'), 'core’s ~-shortened display path is expanded before opening');
    // Egress gains `file` channels — files READ from outside the workspace. Their scope is 'local', which
    // renders as its own word ("outside", as the CLI prints it): 'unknown' means we could not classify a
    // destination, and printing a known fact as an admission would be a lie.
    const eLocal = actTree.getTreeItem({ kind: 'erow', ch: { kind: 'file', target: '~/.claude/CLAUDE.md', scope: 'local', count: 4 } });
    assert.equal(eLocal.label, 'CLAUDE.md', 'a file channel names the file it read');
    assert.match(String(eLocal.description), /file · outside ×4/, 'a local (out-of-workspace) read renders as "outside"');
    assert.ok(!/unknown/.test(String(eLocal.description) + String(eLocal.tooltip)), 'a local scope is never collapsed into "unknown"');
    assert.equal(eLocal.command.command, 'vscode.open', 'a file channel opens the file it names');
    const eUnknown = actTree.getTreeItem({ kind: 'erow', ch: { kind: 'mcp', target: 'some-server', scope: 'unknown', count: 1 } });
    assert.match(String(eUnknown.description), /mcp · unknown/, '…and an unclassifiable destination still says "unknown"');
    assert.equal(eUnknown.command, undefined, 'a non-file channel has nothing to open');
    assert.match(String(actTree.getTreeItem({ kind: 'egroup', channels: [] }).tooltip), /read from outside this workspace/,
      'the Egress header says it now covers out-of-workspace reads as well as the network');
    // 0.8.7 review (B16): the root feed — which walks every sibling worktree for live conflicts, ~100ms of
    // SYNCHRONOUS host work — is computed once per REFRESH CYCLE, not once per getChildren() call.
    const firstActions = (nodes) => (nodes.find((n) => n.kind === 'agroup') || {}).actions;
    const ag1 = firstActions(actTree.getChildren());
    assert.ok(ag1, 'the Actions root has at least one category group to compare');
    assert.ok(firstActions(actTree.getChildren()) === ag1, 'a second getChildren() in the same cycle reuses the computed feed (no second fleet scan)');
    actTree.refresh();
    assert.ok(firstActions(actTree.getChildren()) !== ag1, 'refresh() drops it — the fleet’s time-derived "active" flags are never frozen across cycles');

    // ---- host side: the two feeds, served a level at a time off the SAME providers -----------------
    // The rendering moved to a webview; the view-model did not. Every row below is the tree item the
    // provider already built, so a label, a description or a tooltip has exactly one implementation.
    {
      const posts = [];
      let tlMsg = null;
      const tlView = {
        webview: {
          options: {}, html: '',
          postMessage: (m) => { posts.push(m); return Promise.resolve(true); },
          onDidReceiveMessage: (cb) => { tlMsg = cb; return { dispose() {} }; },
        },
        onDidChangeVisibility: () => ({ dispose() {} }),
        visible: false, // no subprocess spawn while hidden
      };
      tlProvider.resolveWebviewView(tlView);
      // A tab that leaves the screen stops being served — the Actions root walks every sibling worktree
      // for live conflicts, and paying for that behind a tab nobody is looking at is what the tree's
      // visible-only refresh avoided. Coming back is served AT ONCE, not on the next store change.
      tlMsg({ type: 'view', tab: 'prompts', grouped: false, shows: { prompts: true, observations: false, actions: false } });
      posts.length = 0;
      tlMsg({ type: 'view', tab: 'observations', grouped: true, shows: { prompts: true, observations: true, actions: true } });
      const obsRoot = posts.find((m) => m.type === 'rows' && m.tab === 'observations' && m.parent === '');
      const actRoot = posts.find((m) => m.type === 'rows' && m.tab === 'actions' && m.parent === '');
      assert.ok(obsRoot && actRoot, 'a tab coming back on screen is served its root at once');
      // …and a tab that is NOT shown gets nothing.
      posts.length = 0;
      tlMsg({ type: 'view', tab: 'prompts', grouped: false, shows: { prompts: true, observations: false, actions: false } });
      tlMsg({ type: 'view', tab: 'observations', grouped: false, shows: { prompts: false, observations: true, actions: false } });
      assert.ok(!posts.some((m) => m.type === 'rows' && m.tab === 'actions'), 'a tab off screen is not built');
      tlMsg({ type: 'view', tab: 'observations', grouped: true, shows: { prompts: true, observations: true, actions: true } });

      // The rows ARE the tree items.
      assert.equal(obsRoot.rows[0].key, 'recap', 'the recap leads, on a stable key');
      {
        // The row IS the tree item — asserted against the provider itself, so re-deriving a label,
        // a description or a tooltip anywhere in the serializer breaks this.
        const live = obsTree.getChildren().map((n) => obsTree.getTreeItem(n));
        assert.deepEqual(obsRoot.rows.map((r) => r.label), live.map((i) => String(i.label)), 'every label is the tree item’s own');
        assert.deepEqual(obsRoot.rows.map((r) => r.desc), live.map((i) => (i.description === true ? '' : String(i.description ?? ''))),
          '…and every description');
        assert.ok(obsRoot.rows[0].tip.includes('Session recap'), 'the tooltip comes across too (a MarkdownString by its value)');
      }
      assert.equal(obsRoot.rows[0].open, null, 'a leaf reports no collapsible state');
      assert.deepEqual(obsRoot.rows[0].acts.map((a) => a.v), ['refreshRecap'],
        'and keeps the inline action its tree row had — a webview inherits no context menu');
      const runRow = obsRoot.rows.find((r) => /×2/.test(r.label));
      assert.ok(runRow, 'the coalesced ×2 run is a row');
      assert.equal(runRow.open, false, '…collapsed by default, exactly as the tree item said');
      // `redoFile` joined them in 0.10.0: undoing a whole file was a one-way door in this panel,
      // while the terminal and the per-edit row both offered redo.
      assert.deepEqual(runRow.acts.map((a) => a.v), ['keepFile', 'undoFile', 'redoFile', 'openFile'], 'with the file-scope actions');
      assert.match(runRow.desc, /^\+\d+ −\d+/, 'and the tree item’s description, unaltered');
      // The icon sentinel: '?' means a ThemeIcon nobody mapped, which would otherwise ship as a glyph
      // that says nothing. The instrument first — a mapping table that matched everything by accident
      // would report a clean sweep forever.
      assert.ok(obsRoot.rows.filter((r) => r.glyph).length >= 3 && actRoot.rows.filter((r) => r.glyph).length >= 2,
        'there are glyphs to check on both feeds');
      assert.deepEqual(obsRoot.rows.filter((r) => r.glyph === '?').map((r) => r.key), [], 'every Observations icon maps to a mark');
      assert.deepEqual(actRoot.rows.filter((r) => r.glyph === '?').map((r) => r.key), [], '…and every Actions one');
      const edGroup = actRoot.rows.find((r) => r.label === 'Edits');
      assert.ok(edGroup && edGroup.open === false, 'the Actions categories are rows, collapsed by default');
      // The tab badge counts ACTIONS, off the same roots that were just serialized — never a second parse.
      assert.equal(actRoot.count, actTree.getChildren().reduce((n, g) => n + (g.kind === 'agroup' ? g.count : 0), 0),
        'the Actions badge counts the tool calls the categories hold');
      assert.equal(actRoot.count, 3, '…which for this fixture is the three Edit calls (reads are a noisy category — only their failures leak through)');
      assert.equal(obsRoot.count, core.readLog(S).length, 'and the Observations badge counts the edits its feed shows');

      // CHILDREN, one level at a time — the whole point of not shipping a 1000-row payload per tick.
      posts.length = 0;
      tlMsg({ type: 'children', tab: 'actions', key: edGroup.key });
      const kids = posts.find((m) => m.type === 'rows' && m.parent === edGroup.key);
      assert.ok(kids && kids.rows.length === 3, 'the category serves exactly its own rows');
      assert.ok(kids.rows.every((r) => r.key.startsWith(edGroup.key + '/')), 'a child key is its parent’s plus its own');
      // A key from no payload at all resolves to nothing rather than throwing or serving the root.
      posts.length = 0;
      tlMsg({ type: 'children', tab: 'actions', key: 'nosuchrow' });
      assert.deepEqual(posts.filter((m) => m.type === 'rows'), [], 'an unknown key is answered with nothing, never with the root');

      // A row CLICK runs the tree item's own command — the webview posted only a key.
      const linked = kids.rows.find((r) => r.act);
      assert.ok(linked, 'the edit-action row is clickable');
      {
        const seen = [];
        const real = commands['claudeObservatory.viewChanges'];
        commands['claudeObservatory.viewChanges'] = (id) => { seen.push(id); };
        tlMsg({ type: 'row', tab: 'actions', key: linked.key });
        commands['claudeObservatory.viewChanges'] = real;
        assert.equal(seen.length, 1, 'a row click runs the command the tree item carried');
        assert.equal(typeof seen[0], 'number', '…with its arguments');
      }
      // A head edit item routes to the FILE-SCOPED STACKED opener,
      // resolved against the tab's CONNECTED session on the host.
      {
        const seenStacked = [];
        tlProvider.onOpenEditFile = (s, id) => { seenStacked.push([typeof s, id]); };
        tlMsg({ type: 'agentOpenEditFile', id: 7 });
        tlProvider.onOpenEditFile = undefined;
        assert.deepEqual(seenStacked, [['string', 7]], 'a head edit item opens the file-scoped stacked layout');
      }
      // A PER-ROW 🗑 delete on every session list/picker — same as JetBrains' Sessions
      // pane: remove a cluttering session straight from the list without connecting to it first. Source-
      // read like the Continue-delete above so the wiring is verified without a bundle rebuild. Every
      // surface routes through the ONE shared body `confirmAndDeleteSession` (verbatim the Agent-tab
      // confirm text + pinned-fallback), so the four affordances can never drift.
      {
        const src = fs.readFileSync(path.resolve(__dirname, '../src/extension.ts'), 'utf8');
        // The shared body + its QuickPick trash button.
        assert.match(src, /const deleteSessionBtn: vscode\.QuickInputButton = \{ iconPath: new vscode\.ThemeIcon\('trash'\)/,
          'the QuickPick per-row delete uses a trash ThemeIcon button');
        assert.match(src, /async function confirmAndDeleteSession\(id: string\): Promise<string \| null>/,
          'the shared confirm+delete body exists');
        assert.match(src, /confirmAndDeleteSession[\s\S]{0,1200}modal: true[\s\S]{0,300}NOT deleted[\s\S]{0,700}--undelete \$\{id\} lists the session again, without its edits/,
          '…behind a modal confirm that says the transcript is NOT deleted and what the undelete command brings back');
        assert.doesNotMatch(src, /[Rr]estore it any time|restore with:? +oak sessions --undelete/, 'no delete surface promises undelete restores the edits');
        assert.match(src, /core\.deleteSession\(id, \{ confirmedPending: pending, seenThrough \}\);[\s\S]{0,300}showErrorMessage[\s\S]{0,300}pinned === id[\s\S]{0,200}sessions\[0\]\?\.id[\s\S]{0,120}pinSession/,
          '…deletes through core.deleteSession, says so when core refuses, and re-pins the newest remaining when the pinned one is deleted');
        // Surface B — the Overview Sessions tab rows (the direct JetBrains parity target).
        assert.match(src, /data-sess-del="'\+esc\(r\.id\)\+'"[\s\S]{0,400}🗑<\/button>/,
          'each Overview Sessions-tab row carries a 🗑 delete button');
        assert.match(src, /querySelectorAll\('\[data-sess-del\]'\)[\s\S]{0,240}type:'deleteSession', id:this\.getAttribute\('data-sess-del'\)/,
          '…which posts the deleteSession gesture with the row id');
        assert.match(src, /m\.type === 'deleteSession' && typeof m\.id === 'string'\)\s*\n\s*void confirmAndDeleteSession\(m\.id\)/,
          'the Overview host handler deletes through the shared body');
        // Surface A — the Timeline top selector dropdown rows.
        assert.match(src, /data-sdel="'\+esc\(s\.id\)\+'"[\s\S]{0,400}🗑<\/span>/,
          'each Timeline selector row carries a 🗑 delete control');
        assert.match(src, /closest\('\[data-sdel\]'\)[\s\S]{0,220}type:'deleteSession', id:del\.getAttribute\('data-sdel'\)/,
          '…claimed before the row-switch so the click deletes rather than switches');
        assert.match(src, /m\.type === 'deleteSession' && typeof m\.id === 'string' && m\.id\)[\s\S]{0,420}confirmAndDeleteSession\(id\)/,
          'the Timeline host handler deletes through the shared body');
        // Surface C — BOTH command-palette QuickPicks (switchSession + switchActiveSession).
        assert.equal((src.match(/buttons: r\.storeBytes \? \[revealStoreBtn, deleteSessionBtn\] : \[deleteSessionBtn\]/g) || []).length, 2,
          'both session QuickPicks give every row the delete button');
        assert.equal((src.match(/e\.button !== deleteSessionBtn\) \{ revealStoreFolder\(it\.id\); return; \}[\s\S]{0,200}confirmAndDeleteSession\(it\.id\)[\s\S]{0,140}qp\.items = qp\.items\.filter/g) || []).length, 2,
          'both QuickPicks confirm+delete on the trash button and drop the row from the live list');
      }
      // The delete itself, driven from a Timeline row: the confirm names the edits still pending review and
      // says undelete lists the session again without them; the edits it named are purged with the session;
      // an edit that lands while the confirm is open is refused, not purged unseen (the
      // confirm promised a restore, and purged pending edits with no guard).
      {
        // Its own file and sessions (each with a transcript, so the listing names it as it names a real
        // one), removed after, so no later count or file memory sees them.
        const DF = path.join(ws, 'delete-fixture.txt');
        const seed = (id, status) => {
          const transcript = path.join(proj, `${id}.jsonl`);
          if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, [JSON.stringify({ type: 'ai-title', aiTitle: `Delete fixture ${id}` }),
            JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'edited the delete fixture' }] } })].join('\n') + '\n');
          core.ensureStore(id);
          core.appendLog(id, { id: core.nextId(id), ts: Date.now(), tool: 'Edit', file: DF, status,
            beforeBlob: core.writeBlob(id, Buffer.from('a\n')), afterBlob: core.writeBlob(id, Buffer.from('b\n')) });
        };
        const asked = [], errors = [];
        const warn = vscode.window.showWarningMessage, err = vscode.window.showErrorMessage;
        let whileOpen = null;
        vscode.window.showWarningMessage = (m, opts, ...items) => { asked.push({ detail: opts.detail, items }); whileOpen?.(); return Promise.resolve(items[0]); };
        vscode.window.showErrorMessage = (m) => { errors.push(String(m)); return Promise.resolve(undefined); };
        const settle = async (cond) => { for (let i = 0; i < 1500 && !cond(); i++) await new Promise((r) => setTimeout(r, 10)); };
        try {
          seed('fixture-del-pending', 'pending'); seed('fixture-del-pending', 'pending');
          tlMsg({ type: 'deleteSession', id: 'fixture-del-pending' });
          await settle(() => core.isSessionHidden('fixture-del-pending'));
          assert.equal(asked.length, 1, 'one confirm');
          assert.match(asked[0].detail, /purges its captured edits for good\.\n\n2 of those edits are still pending review: the purge drops their before-snapshots, so OAK can no longer undo those changes\./);
          assert.match(asked[0].detail, /\n\noak sessions --undelete fixture-del-pending lists the session again, without its edits\.$/);
          assert.deepEqual(asked[0].items, ['Delete and purge 2 pending edits'], 'the button names what it purges');
          assert.ok(!fs.existsSync(core.storeDir('fixture-del-pending')), 'confirmed, the session goes with the edits it named');
          // Nothing pending when asked; the agent writes one while the confirm is open.
          seed('fixture-del-late', 'kept');
          whileOpen = () => seed('fixture-del-late', 'pending');
          tlMsg({ type: 'deleteSession', id: 'fixture-del-late' });
          await settle(() => errors.length > 0);
          assert.deepEqual(asked[1].items, ['Delete'], 'control: nothing was pending when asked');
          assert.match(errors[0], /^OAK: could not delete “.*” — fixture-del-late has 1 edit pending review; deleting the session would purge it for good, so it was not deleted$/);
          assert.ok(!core.isSessionHidden('fixture-del-late') && core.readLog('fixture-del-late').length === 2, 'the edit that arrived is kept, and the session with it');
          // Two pending when asked, and the agent writes a third while the confirm is open: the confirm named
          // two, so the third is refused too, not purged with them.
          seed('fixture-del-more', 'pending'); seed('fixture-del-more', 'pending');
          whileOpen = () => seed('fixture-del-more', 'pending');
          tlMsg({ type: 'deleteSession', id: 'fixture-del-more' });
          await settle(() => errors.length > 1);
          assert.deepEqual(asked[2].items, ['Delete and purge 2 pending edits'], 'control: the confirm named two');
          assert.match(errors[1], /^OAK: could not delete “.*” — fixture-del-more has 3 edits pending review, more than the 2 this delete confirmed; deleting the session would purge the rest unseen, so it was not deleted$/);
          assert.ok(!core.isSessionHidden('fixture-del-more') && core.readLog('fixture-del-more').length === 3, 'all three edits are kept, and the session with them');
          // Two changes pending when asked, and the agent rewrites the lines of one of them again, in the same
          // ask, while the confirm is open: that edit JOINS the change, so the count stays at the two the confirm
          // named, and the delete refuses it as newer than the newest edit of the listing the confirm counted from
          // (it was purged unseen).
          const JF = path.join(ws, 'delete-join-fixture.py');
          const join = (before, after) => core.appendLog('fixture-del-join', { id: core.nextId('fixture-del-join'), ts: Date.now(), tool: 'Edit', file: JF,
            status: 'pending', promptId: 'ask-1', beforeBlob: core.writeBlob('fixture-del-join', Buffer.from(before)), afterBlob: core.writeBlob('fixture-del-join', Buffer.from(after)) });
          seed('fixture-del-join', 'pending'); join('def f():\n    return 1\n', 'def f():\n    return 2\n');
          whileOpen = () => join('def f():\n    return 2\n', 'def f():\n    return 3\n');
          tlMsg({ type: 'deleteSession', id: 'fixture-del-join' });
          await settle(() => errors.length > 2 || core.isSessionHidden('fixture-del-join'));
          assert.deepEqual(asked[3].items, ['Delete and purge 2 pending edits'], 'control: the confirm named two');
          assert.match(errors[2] ?? 'deleted', /^OAK: could not delete “.*” — fixture-del-join captured an edit after the listing this delete was confirmed from, still pending review; deleting the session would purge it unseen, so it was not deleted$/);
          assert.equal(core.sessionCounts('fixture-del-join').pending, 2, 'control: the edit joined a change the confirm named, so the count did not move');
          assert.ok(!core.isSessionHidden('fixture-del-join') && core.readLog('fixture-del-join').length === 3, 'all three edits are kept, and the session with them');
        } finally {
          vscode.window.showWarningMessage = warn;
          vscode.window.showErrorMessage = err;
          for (const id of ['fixture-del-pending', 'fixture-del-late', 'fixture-del-more', 'fixture-del-join']) { core.removeSession(id); core.unhideSession(id); fs.rmSync(path.join(proj, `${id}.jsonl`), { force: true }); }
        }
      }
      // A row ACTION runs its verb against the node — and a verb this row does not offer is refused,
      // which is what stops a webview naming any command it likes.
      posts.length = 0;
      tlMsg({ type: 'children', tab: 'observations', key: runRow.key });
      const editRows = posts.find((m) => m.type === 'rows' && m.parent === runRow.key).rows;
      assert.equal(editRows.length, 2, 'the run expands to its per-edit rows');
      assert.ok(editRows.some((r) => r.desc.endsWith(` · ${LONG_WHY}`)), 'the Observations row carries the whole reasoning line, which its column wraps');
      assert.deepEqual(editRows[0].acts.map((a) => a.v), ['keep', 'undo', 'analyzeEdit', 'chatEdit', 'openFile'],
        'each edit row carries the actions its tree row had inline');
      {
        const kept = [];
        const realKeep = commands['claudeObservatory.keep'];
        commands['claudeObservatory.keep'] = (n) => { kept.push(n); };
        tlMsg({ type: 'rowAct', tab: 'observations', key: editRows[0].key, verb: 'keep' });
        commands['claudeObservatory.keep'] = realKeep;
        assert.equal(kept.length, 1, 'the verb reaches its command');
        assert.equal(kept[0].rec.id, 2, '…with the NODE the tree would have passed it');
        const bulk = [];
        const realAll = commands['claudeObservatory.keepAll'];
        commands['claudeObservatory.keepAll'] = () => { bulk.push(1); };
        tlMsg({ type: 'rowAct', tab: 'observations', key: editRows[0].key, verb: 'keepAll' });
        commands['claudeObservatory.keepAll'] = realAll;
        assert.deepEqual(bulk, [], 'a verb this row does not offer is refused, not forwarded');
      }
      // The tour (and the palette) bring a TAB forward rather than revealing a view that no longer exists.
      posts.length = 0;
      tlProvider.setTab('observations');
      assert.deepEqual(posts.filter((m) => m.type === 'tab').map((m) => m.tab), ['observations'], 'setTab names the tab');
      // The same gate on the window's OWN refresh, not only on the message that reports the layout —
      // this is the path every store change takes. Pointing the CLI at a non-executable file keeps a
      // unit test from launching a real subprocess; the tree posts happen before the spawn either way.
      {
        const notABinTl = path.join(ws, 'not-a-binary-timeline');
        fs.writeFileSync(notABinTl, 'this is not executable\n');
        const wasBin = process.env.CLAUDE_OBSERVATORY_BIN;
        process.env.CLAUDE_OBSERVATORY_BIN = notABinTl;
        tlMsg({ type: 'view', tab: 'prompts', grouped: false, shows: { prompts: true, observations: false, actions: false } });
        posts.length = 0;
        tlView.visible = true;
        tlProvider.refresh(true);
        tlView.visible = false;
        if (wasBin === undefined) delete process.env.CLAUDE_OBSERVATORY_BIN; else process.env.CLAUDE_OBSERVATORY_BIN = wasBin;
        for (let i = 0; i < 100 && !posts.some((m) => m.type === 'sessions'); i++) await new Promise(r => setTimeout(r, 10));
        assert.ok(posts.some((m) => m.type === 'sessions'), 'the CLI listing replied asynchronously');
        assert.ok(!posts.some((m) => m.type === 'rows'), '…and built no feed for a tab that is off screen');
      }
      // A Claude-generated recap or edit analysis has to REPAINT. Dropping the provider's memo used to be
      // enough — the tree had its own change event — and now redraws nothing on its own. Asserted from
      // source because driving it would spawn Claude.
      {
        const src = fs.readFileSync(path.resolve(__dirname, '../src/extension.ts'), 'utf8');
        assert.match(src, /await core\.analyzeEdit\(s, id[\s\S]{0,500}?promptsProvider\.refresh\(true\)/,
          'analyzing an edit repaints the window that draws the row');
        assert.match(src, /await core\.analyzeRecap\(s[\s\S]{0,500}?promptsProvider\.refresh\(true\)/,
          '…and so does refreshing the recap');
      }

      // ---- 0.10.0: the Feed carries the session conversation and Overview selections --------
      {
        const html = tlView.webview.html;
        // Same dump hook as the other panels (below): the timeline page is where the Feed tab
        // lives, and a layout probe needs ITS shipped markup too.
        if (process.env.OBS_DUMP_HTML) {
          fs.mkdirSync(process.env.OBS_DUMP_HTML, { recursive: true });
          fs.writeFileSync(path.join(process.env.OBS_DUMP_HTML, 'timeline.html'), String(html));
        }
        assert.ok(/id="tl-pane-feed"/.test(html) && /\['feed','Feed'\]/.test(html), 'the Feed tab carries it');
        assert.ok(!/\['conversation','Conversation'\]/.test(html) && !/id="tl-pane-conversation"/.test(html), 'the Conversation tab is gone — the Feed is the one conversation surface (2026-09-23)');
        assert.ok(/e\.kind==='reasoning'/.test(html) && /tlf-verb agent/.test(html), 'the feed renderer draws the agent’s own words as rows (said · thinking)');
        // The blob renderer survived the fold-in whole: verb + target, shell calls as shell calls,
        // marks by shape, reasoning only where it changed, the full command never clipped.
        assert.ok(/function feedEntryHtml/.test(html), 'the feed blob renderer lives on for the head');
        assert.ok(/e\.category==='exec'/.test(html) && /tlf-verb exec/.test(html), 'a shell call renders as a shell call, from core’s category');
        assert.ok(/e\.ok===false/.test(html) && /tlf-mark err/.test(html) && /tlf-mark pend/.test(html), 'marks render by shape: error, ok, pending permission');
        assert.ok(/e\.reasoning && e\.reasoning!==prevReasoning/.test(html), 'reasoning renders only where it CHANGED');
        assert.ok(/reasoningKind==='thinking'/.test(html), '…labelled thinking vs said from core’s reasoningKind');
        assert.ok(/e\.cmd && e\.cmd!==e\.target/.test(html), 'an open exec blob shows the full multi-line command');
        assert.ok(/e\.kind==='output'/.test(html) && /tlf-out/.test(html), 'raw output lines render monospace, with no fabricated timestamp');
        assert.ok(/FCLOSED/.test(html), 'head blobs keep their fold set');
        assert.ok(/id="rq-swait"/.test(html), 'the session selector carries attention');
        assert.ok(/function shellHtml/.test(html) && /tlf-sh-prog/.test(html) && /tlf-sh-flag/.test(html) && /tlf-sh-str/.test(html) && /tlf-sh-op/.test(html),
          'shell commands are tokenized: program, flags, strings, operators');
        // Markdown in the prose — the core tokenizer's webview face, tables
        // included.
        assert.ok(/function mdSpansHtml/.test(html) && /function mdHtml/.test(html), 'the markdown renderer ships');
        assert.ok(/function mdIsTRow/.test(html) && /tla-mdt/.test(html) && /\.tla-mdt th/.test(html),
          'pipe rows build a real styled table');
        assert.ok(/AGPATCH/.test(html) && /\.tlf-dl\.add/.test(html) && /\.tlf-dl\.rem/.test(html) && /\.tlf-dl\.hunk/.test(html),
          'inline diff lines carry add/remove bands and hunk styling');
        assert.ok(/\.tlf-dl\.add \{ background: var\(--vscode-diffEditor-insertedTextBackground/.test(html)
          && /\.tlf-dl\.rem \{ background: var\(--vscode-diffEditor-removedTextBackground/.test(html),
          'diff add/remove render as background bands');
        assert.ok(/\.tlf-blob \{ border:1px solid/.test(html), 'head entries are bordered blocks');
        assert.ok(/more line/.test(html) && /view the full diff/.test(html), 'the inline diff is bounded, with a door to the full diff');
        assert.ok(/'agentOpenEditFile'/.test(html) && /data-openedit/.test(html), 'a head edit item opens that file’s changes stacked');
        assert.ok(/'agentOpenEdit'/.test(html) && /data-edit/.test(html), 'a head blob with an edit id links to its diff');
        assert.ok(/type:'openPath'/.test(html) && /data-openpath/.test(html), 'any path-like target opens the file');
        assert.ok(!/tla-said/.test(html), 'the pinned said block is GONE — the transcript itself ends with what the agent said');
        // Host side: the patches are built in-process; the fetch passes --root and BOTH depth flags.
        const fb2 = fs.readFileSync(BUNDLE, 'utf8');
        assert.ok(/coloredDiff\(session, rec, false\)/.test(fb2) && /buildFeedPatches/.test(fb2), 'the host rides bounded patches on the head payload');
        assert.ok(/"--feed-limit"/.test(fb2) && /"--root"/.test(fb2), 'the head fetch passes --root and --feed-limit');
        // Executable: a NON-SESSION Overview pick rides the head ref; ✕ clears it. (The view is
        // hidden here, so the follow spawns nothing — the fetch gate is the same as ever.)
        posts.length = 0;
        tlProvider.followHead({ kind: 'process', id: 'bg123', label: 'test shell' });
        assert.ok(tlProvider.headRef && tlProvider.headRef.kind === 'process' && tlProvider.headRef.id === 'bg123', 'the head follows the pick');
        tlMsg({ type: 'agentHeadClear' });
        assert.equal(tlProvider.headRef, null, 'the chip’s ✕ clears back to the connected session');
      }
    }

    // Combined Stats + Usage webview: one view — plots on top, usage bars below; both fed via postMessage.
    const stProvider = webviewProviders['claudeObservatory.stats'];
    assert.ok(stProvider && !webviewProviders['claudeObservatory.statusline'], 'single combined Stats view (Usage merged in)');
    let stMsgHandler = null;
    const stView = {
      webview: { options: {}, html: '', postMessage: () => {}, onDidReceiveMessage: (cb) => { stMsgHandler = cb; return { dispose() {} }; } },
      onDidChangeVisibility: () => ({ dispose() {} }),
      visible: false, // no subprocess spawn while hidden
    };
    stProvider.resolveWebviewView(stView);
    assert.match(stView.webview.html, /ctx/, 'usage bars present (ctx row)');
    assert.match(stView.webview.html, /5h/, 'usage bars present (5h row)');
    assert.match(stView.webview.html, />Today</, 'the Today/7d/30d range toggle is present');
    // live review scoreboard replaced the old Edits chart: counts + a progress bar, fed via postMessage.
    assert.match(stView.webview.html, /id="rv-pending"/, 'review scoreboard: pending count cell present');
    assert.match(stView.webview.html, /id="rv-fill"/, 'review scoreboard: progress bar present');
    const scMsgs = [];
    stView.webview.postMessage = (m) => scMsgs.push(m);
    stProvider.refresh();
    assert.ok(scMsgs.some((m) => m.type === 'counts' && m.c.pending === 2 && m.c.kept === 0 && m.c.undone === 0),
      'stats posts the live review counts (2 pending, 0 accepted, 0 reverted)');
    assert.match(stView.webview.html, /Gathering stats/i, 'stats placeholder present until the scan returns');
    // 2026-09-08: the stale banner moved onto the usage section's TOOLTIP; the ↻ beside the
    // title is the manual pull, wired through the one usageRefresh command.
    assert.doesNotMatch(stView.webview.html, /id="ustale"/, 'the stale-cache banner is gone — its story rides the section tooltip');
    assert.match(stView.webview.html, /id="uref"/, 'the manual refresh sits beside the Usage title');
    assert.match(stView.webview.html, /type:'usageRefresh'/, '…and posts the refresh message');
    // The `$` row prices the month at list prices and projects it over the whole month: both figures are
    // estimates, and each carries `~` on either tab (the projected total had none).
    for (const [utab, u, want] of [
      ['claude', { monthTokens: 1200000, monthTokensTotal: 4000000, monthCost: 18, monthCostTotal: 40 }, ['~$18.00', '~$40.00']],
      ['gpt', { gptWeekPct: 30, gptMonthTok: 900000, gptMonthTokTotal: 3000000, gptMonthCost: 12.5, gptMonthCostTotal: 41 }, ['~$12.50', '~$41.00']],
    ]) {
      const vm = require('node:vm');
      const els = new Map();
      const mk = () => ({ textContent: '', innerHTML: '', style: {}, parentElement: { style: {} }, addEventListener() {},
        classList: { toggle() {}, add() {}, remove() {} }, querySelector: () => mk(), getAttribute: () => null, setAttribute() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 40 }) });
      const elFor = (id) => { if (!els.has(id)) els.set(id, mk()); return els.get(id); };
      let listener = null;
      const sandbox = { console, setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
        window: { addEventListener: (t, cb) => { if (t === 'message') listener = cb; } },
        document: { getElementById: elFor, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, body: elFor('body') },
        acquireVsCodeApi: () => ({ postMessage() {}, getState: () => ({ utab }), setState() {} }) };
      vm.createContext(sandbox);
      const scripts = [...stView.webview.html.matchAll(/<script[^>]*>([\s\S]*?)<\/script[^>]*>/gi)];
      vm.runInContext(scripts[scripts.length - 1][1], sandbox);
      listener({ data: { type: 'usage', u } });
      assert.deepEqual([elFor('uc1-$').textContent, elFor('uc2-$').textContent], want, `${utab}: the $ row's spent and projected total are both marked estimates`);
    }
    // 0.8.7: the context-per-turn chart is GONE (core no longer emits the series) — and so is its scaffolding.
    assert.ok(!/tk-fill|renderFill|class="spark"/.test(stView.webview.html), 'the context-per-turn chart and its scaffolding are removed');
    assert.match(stView.webview.html, /id="nb-model"/, 'the model / effort chip stays (it is not part of the removed chart)');
    // 0.8.7 review (B23): removing the chart also removed every mention of compaction. The events still
    // ride vitals.compactions, so a one-line readout (count + last drop) is restored — no chart.
    assert.match(stView.webview.html, /id="nb-compact"/, 'the compaction readout chip is present');
    assert.ok(/function renderCompactions/.test(stView.webview.html) && /renderVitals\(m\.v\); renderCompactions\(m\.v\)/.test(stView.webview.html),
      'the compactions the host already posts are actually rendered');
    assert.ok(/' compaction'\+\(cs\.length===1\?'':'s'\)\+' · last dropped '/.test(stView.webview.html), 'the readout is count + the size of the LAST drop');
    assert.ok(/if\(!cs\.length\)\{ el\.style\.display='none'/.test(stView.webview.html), 'a session that never compacted shows no chip (absent data renders absent)');
    assert.ok(!/\$/.test('⤺ 1 compaction · last dropped 992k'), 'the readout carries no dollar amount');
    // CLI-missing hint: a failed scan (before any data) posts statsError so the webview shows install help
    const stMsgs = [];
    stView.webview.postMessage = (m) => stMsgs.push(m);
    stProvider.postStatsError();
    assert.ok(stMsgs.some((m) => m.type === 'statsError'), 'failed stats scan posts the CLI-missing hint');

    // Overview webview (0.8.0 round 3 — MASTER–DETAIL): the standalone Multitasking view is folded IN.
    // LEFT NAV = two sub-tabs Fleet · Workflows (rendered from multitask --json). RIGHT DETAIL = the
    // change-map (Folders strip · churn-ranked Files ledger) for the SELECTED nav item (from
    // changemap --json). The count/size toggle is GONE (always sizes by ± lines).
    const cmProvider = webviewProviders['claudeObservatory.changemap'];
    assert.ok(cmProvider, 'Overview view registered in the panel');
    let cmMsgHandler = null;
    const cmView = {
      webview: { options: {}, html: '', postMessage: () => {}, onDidReceiveMessage: (cb) => { cmMsgHandler = cb; return { dispose() {} }; } },
      onDidChangeVisibility: () => ({ dispose() {} }),
      visible: false, // no subprocess spawn while hidden
    };
    cmProvider.resolveWebviewView(cmView);
    // TOP NAVBAR: the session-wide review actions — Accept All · Reject All · Clear Resolved · Refresh —
    // each posting to the host command. No session picker: the Sessions tab below IS the selector (0.8.8),
    // and a dropdown over it would be the same control twice.
    assert.match(cmView.webview.html, /id="ov-toolbar"|class="ov-toolbar"/, 'Overview: a top navbar is present');
    assert.ok(!/id="ov-sess"/.test(cmView.webview.html), 'Overview: the session dropdown is gone');
    assert.ok(/data-sess-auto/.test(cmView.webview.html),
      '…and the Sessions tab offers the one thing only the dropdown could: going back to automatic resolution');
    assert.ok(/id="ov-keepall"/.test(cmView.webview.html) && /id="ov-undoall"/.test(cmView.webview.html) && /id="ov-clearres"/.test(cmView.webview.html) && /id="ov-refresh"/.test(cmView.webview.html),
      'the navbar carries Accept All · Reject All · Clear Resolved · Refresh');
    assert.ok(/Accept All/.test(cmView.webview.html) && /Reject All/.test(cmView.webview.html) && /Clear Resolved/.test(cmView.webview.html),
      'the navbar buttons are labelled to match the Observations toolbar');
    // LEFT NAV = 25% of the panel width (change-map detail gets the remaining 75%).
    // The split is the reader's to set (0.8.8): 25% is where it OPENS, not where it is stuck.
    assert.ok(/\.ov-nav \{[^}]*flex:0 0 var\(--ov-nav, 25%\)/.test(cmView.webview.html),
      'Overview: the left nav opens at 25%, sized by a variable rather than a constant');
    assert.ok(/id="ov-gutter"/.test(cmView.webview.html) && /addEventListener\('pointerdown'/.test(cmView.webview.html),
      '…and a draggable gutter sits between the panes');
    assert.ok(/navW:NAV_W, navH:NAV_H/.test(cmView.webview.html) && /--ov-navv/.test(cmView.webview.html),
      '…and the split is remembered per axis (a nav WIDTH side by side, a nav HEIGHT stacked)');
    assert.match(cmView.webview.html, /id="ov-navtabs"/, 'Overview: left-nav sub-tab bar present (Workers · Workflows)');
    assert.ok(/'Workers'/.test(cmView.webview.html) && /'Workflows'/.test(cmView.webview.html), 'the left nav labels Workers/Workflows');
    assert.ok(/renderNavTabs/.test(cmView.webview.html) && /function applyPanes/.test(cmView.webview.html), 'switching a nav tab toggles panes (renderNavTabs/applyPanes)');
    assert.match(cmView.webview.html, /id="ov-fleet"/, 'Overview: the Fleet list container is present');
    assert.match(cmView.webview.html, /id="ov-workflows"/, 'Overview: the Workflows list container is present');
    // Live conflicts MOVED to the Actions panel (0.8.3) — the Overview must no longer render them.
    assert.ok(!/ov-collisions/.test(cmView.webview.html), 'Overview: the live-collisions strip is gone (it lives in the Actions panel now)');
    // The Tasks tab: third nav pane, strict-rollup-joined rows, done-collapse toggle.
    assert.match(cmView.webview.html, /id="ov-tasks"/, 'Overview: the Tasks pane container is present');
    assert.ok(/'Tasks'/.test(cmView.webview.html) && /renderTasks/.test(cmView.webview.html), 'the left nav labels Tasks and renders it');
    assert.ok(/rollupByTask/.test(cmView.webview.html) && /mt-ttog/.test(cmView.webview.html), 'task rows join the strict rollup + completed tasks collapse behind a toggle');
    assert.ok(/awaiting permission/.test(cmView.webview.html), 'the awaiting-permission needs-attention phase is surfaced');
    assert.ok(/mt-spark/.test(cmView.webview.html) && /renderFleet/.test(cmView.webview.html), 'Fleet rows carry a per-agent activity sparkline (+ ±lines/tokens/time/risk)');
    assert.ok(/fmtTok/.test(cmView.webview.html) && /fmtDur/.test(cmView.webview.html), 'Fleet + Workflows show tokens/time (fmtTok/fmtDur)');
    assert.ok(/phaseSummary/.test(cmView.webview.html) && /phaseGroups/.test(cmView.webview.html) && /w\.description/.test(cmView.webview.html) && /a\.label/.test(cmView.webview.html), 'Workflows show the informative name + per-phase progress + per-agent label');
    // DISPLAY filters (Active-only + Clear-completed) over the SAME pure multitaskFilter, on the nav.
    assert.match(cmView.webview.html, /id="mt-active"/, 'Overview: the Active-only toggle is present');
    assert.ok(/Active only/.test(cmView.webview.html), 'the toggle is labelled "Active only"');
    assert.match(cmView.webview.html, /id="mt-clear"/, 'Overview: the Clear-completed control is present');
    assert.ok(/Clear completed/.test(cmView.webview.html), 'the control is labelled "Clear completed"');
    assert.ok(/ACTIVE_ONLY/.test(cmView.webview.html) && /MTFILTER/.test(cmView.webview.html), 'the toggle drives a client-side ACTIVE_ONLY filter over the payload');
    assert.ok(/DISMISS_AG/.test(cmView.webview.html) && /DISMISS_WF/.test(cmView.webview.html), 'Clear-completed keeps a client-side dismissed set (agents + workflows)');
    assert.ok(/show all/.test(cmView.webview.html), 'an "N hidden · show all" un-dismiss affordance is present');
    assert.ok(/agentActive/.test(cmView.webview.html), 'the pure multitaskFilter body is embedded verbatim into the webview (one source of truth for test + UI)');
    // RIGHT DETAIL: the change-map for the selected nav item.
    assert.ok(!/id="cm-ribbon"/.test(cmView.webview.html), 'Overview: the subtask ribbon is gone (0.8.8) — the detail is Folders + Files');
    assert.match(cmView.webview.html, /id="cm-strip"/, 'Overview: module proportion strip present');
    assert.match(cmView.webview.html, /id="cm-ledger"/, 'Overview: ranked file ledger present');
    // The folded folders EXPAND (0.8.8). A "+K more" that is only a label leaves the tail unreachable,
    // which is exactly the bug this replaced: the chip has to be a control, and it has to fold back.
    assert.ok(/data-more="1"/.test(cmView.webview.html) && /data-less="1"/.test(cmView.webview.html),
      'Overview: the strip\'s tail chip opens every folder, and a second chip folds them back');
    assert.ok(/getAttribute\('data-more'\)\)\{ STRIP_ALL=true/.test(cmView.webview.html)
      && /getAttribute\('data-less'\)\)\{ STRIP_ALL=false/.test(cmView.webview.html),
      '…and both chips are wired to the expansion state, not to the folder filter');
    assert.ok(/\.cm-strip \{[^}]*flex-wrap:wrap/.test(cmView.webview.html)
      && /\.cm-sg \{[^}]*flex:1 1 86px/.test(cmView.webview.html),
      'the strip wraps and its tiles hold a readable floor width (no slivers in a narrow panel)');
    assert.ok(/\.cm-strip\.open \{[^}]*max-height:[^}]*overflow-y:auto/.test(cmView.webview.html),
      'expanded, the strip is capped and scrolls — opening 90 folders cannot push the ledger off-screen');
    assert.match(cmView.webview.html, /id="cm-readout"/, 'Overview: footer readout present');
    assert.ok(!/id="cm-area"|data-area=/.test(cmView.webview.html), 'the count/size toggle is gone (always ± lines)');
    assert.ok(!/buildFiles|buildModules|buildChangeMap|listRepoSiblings|fleetConflicts|buildActionGroups/.test(cmView.webview.html), 'the client must not re-aggregate — core/CLI ship both payloads (changemap + multitask)');
    assert.ok(!/renderRibbon/.test(cmView.webview.html) && !/a\.subtasks/.test(cmView.webview.html), 'Overview: no ribbon renderer and no subtasks[] reads remain');
    // a WORKFLOW nav item renders a synthetic per-workflow detail slice (rollup → chips, files → ledger,
    // taskIds), joined to CM by workflow id.
    assert.ok(/function workflowSlice/.test(cmView.webview.html) && /kind==='workflow'/.test(cmView.webview.html), 'Overview: a selected workflow renders a per-workflow detail slice (workflowSlice)');
    assert.ok(/function detailSlice/.test(cmView.webview.html) && /cmAgent/.test(cmView.webview.html), 'Overview: the detail joins the nav selection to the changemap slice by session/workflowId');
    // 0.8.7: the footprint badge row and its drill-down are GONE — folded into the Risk and Egress audits
    // (Actions panel), which is now the ONE audit surface. `changemap --json` no longer emits the key, so a
    // renderer still reading it would paint a silent blank; nothing may read it, and no scaffolding survives.
    assert.ok(!/cm-caps|cm-capd|cm-cdr|renderCaps|renderCapDetail|capBadge|data-cap=|data-facet|--fp-/.test(cmView.webview.html),
      'the footprint badge row, its drill-down, its palette and its click-through are gone from the Overview');
    assert.ok(!/\.footprint|\['footprint'\]/.test(cmView.webview.html),
      'nothing in the Overview reads the removed footprint key (the comments explaining the fold are fine)');
    assert.ok(!/openPath/.test(cmView.webview.html), 'the drill-down’s openPath message went with it (the Actions tree opens its own file rows)');
    // 0.8.7: the fleet lists every sibling session, so a session switch must re-point the DETAIL selection.
    assert.ok(/SEL = k \? \{kind:'agent', session:k\} : null; PR_ID=null;/.test(cmView.webview.html), 'switching sessions re-points the Overview selection (and drops the old prompt scope)');
    // 0.8.7 (3) the PROCESSES tab: background shells left running. No pid column — the transcript records
    // no OS pid, so the harness's shell id is the identity.
    assert.match(cmView.webview.html, /id="ov-pane-processes"/, 'Overview: the Processes pane container is present');
    assert.match(cmView.webview.html, /id="ov-processes"/, 'Overview: the Processes list container is present');
    assert.ok(/'Processes'/.test(cmView.webview.html) && /function renderProcesses/.test(cmView.webview.html), 'the left nav labels Processes and renders it');
    assert.ok(/function procState/.test(cmView.webview.html) && /'exit '\+p\.exitCode/.test(cmView.webview.html) && /fmtBytes/.test(cmView.webview.html),
      'process rows show running / exit state, runtime and output volume');
    assert.ok(!/p\.pid|\bpid:/.test(cmView.webview.html) && /no OS pid/.test(cmView.webview.html), 'the Processes tab invents no pid — the harness’s shell id is the identity, and the code says why');
    // 0.8.7 fix: Active only must hide EXITED shells (fleet/workflows/tasks all honor the toggle; the
    // Processes pane was the outlier), and an emptied list must read as the filter's doing, not "none ran".
    assert.ok(/if\(ACTIVE_ONLY\)\{ var running=\[\];[^}]*\.running\)/.test(cmView.webview.html),
      'the Processes pane drops non-running shells when Active only is on');
    assert.ok(/No running shells/.test(cmView.webview.html) && /clear <b>Active only<\/b> to see the '\+exitedHidden/.test(cmView.webview.html),
      'an Active-only-emptied Processes pane says why it is empty and how many exited shells are hidden');
    // 0.8.7 review: the tab is ALWAYS present (JetBrains parity) — one that vanishes when the CLI can't
    // answer hides the failure. Its badge is running/total, tinted while a shell is still going, and the
    // three states it can be in (nothing read yet · no answer · genuinely none) get three sentences.
    assert.ok(/defs\.push\(\['processes'/.test(cmView.webview.html) && !/if\(PR\) defs\.push/.test(cmView.webview.html),
      'the Processes tab is always present, so a CLI that cannot answer is reported rather than hidden');
    assert.ok(/psum\? \(psum\.running\+'\/'\+psum\.total\) : ''/.test(cmView.webview.html), 'the Processes tab badge is running/total, and blank when there is no payload to count');
    assert.ok(/\.ov-tn\.hot \{ color: var\(--mt-done\)/.test(cmView.webview.html), 'the running/total badge is tinted with the same green the running row badge uses');
    assert.ok(/Reading this session’s background shells…/.test(cmView.webview.html), 'state 1: nothing has been read yet');
    assert.ok(/No answer for background shells/.test(cmView.webview.html), 'state 2: the CLI returned nothing — stated, not silently blamed on the session');
    assert.ok(/No background shells — Claude starts one only when it runs a command/.test(cmView.webview.html), 'state 3: this session genuinely started none');
    // 0.8.7 review (B21): Tasks + Processes are the ACTIVE session's payloads; selecting a sibling fleet
    // row re-points the change map and the feed but NOT these two, so both panes say so.
    assert.ok(/function offSession/.test(cmView.webview.html) && /function scopeNote/.test(cmView.webview.html), 'the session-scope note exists for the tabs the fleet selection does not re-point');
    assert.ok(/scopeNote\('Tasks'\)/.test(cmView.webview.html) && /scopeNote\('Background shells'\)/.test(cmView.webview.html), 'both session-scoped panes carry the note');
    // 0.9.0: "ACTIVE" became "REVIEWED" in the Tasks tooltip — the pane follows the session under review,
    // and calling that the active session read as "the one Claude is running in", which is a different
    // thing the moment you pin an older session.
    assert.ok(/REVIEWED session’s numbered task list/.test(cmView.webview.html) && /background shells the ACTIVE session launched/.test(cmView.webview.html),
      'the tab tooltips name the scope too');
    // …and both now say what happens to their BADGE while a sibling is selected, since neither pane can
    // be scoped to one: a count from the reviewed session beside a pane the reader believes they scoped
    // is the failure this release set out to remove.
    assert.ok(/no count is shown while one is selected/.test(cmView.webview.html), 'the tooltips explain the blanked badge');
    assert.ok(!/\.mt-scope \{[^}]*var\(--mt-attn\)/.test(cmView.webview.html), 'the scope note does not borrow the amber that means "outside the workspace"');
    // 0.8.7 (5) REQUESTS — its own WINDOW in the dock (left of the Overview), not a tab inside it, so
    // the list of asks and the view it scopes are visible at the same time. Picking one filters the
    // Overview beside it: fleet · runs · tasks · shells, and the whole change map.
    const rqProvider = tlProvider; // 0.10.0: Prompts is the Timeline's first TAB, not a view of its own
    assert.ok(rqProvider, 'the Timeline window is registered');
    let rqMsgHandler = null;
    const rqView = {
      webview: { options: {}, html: '', postMessage: () => {}, onDidReceiveMessage: (cb) => { rqMsgHandler = cb; return { dispose() {} }; } },
      onDidChangeVisibility: () => ({ dispose() {} }),
      visible: false, // no subprocess spawn while hidden
    };
    rqProvider.resolveWebviewView(rqView);
    assert.match(rqView.webview.html, /id="rq-list"/, 'Prompts: the list container is present');
    assert.ok(/#'\+r\.index/.test(rqView.webview.html) && /esc\(r\.text\|\|r\.title\)/.test(rqView.webview.html),
      'a row carries the ask’s own number and the ask itself');
    // NO TRUNCATION anywhere: the ask wraps over as many lines as it needs (user rule 2026-07-23). An
    // ellipsis or a line clamp would throw away the only copy of what the person actually said.
    assert.ok(/\.rq-ask \{[^}]*white-space:pre-wrap[^}]*\}/.test(rqView.webview.html), 'the ask wraps (pre-wrap), never clipped');
    assert.ok(!/\.rq-ask \{[^}]*text-overflow:ellipsis/.test(rqView.webview.html) && !/-webkit-line-clamp/.test(rqView.webview.html),
      'no ellipsis and no line clamp on the ask');
    assert.ok(/r\.edits\+' edit'/.test(rqView.webview.html) && /r\.agents\.length\+' subagent'/.test(rqView.webview.html)
      && /r\.workflows\.length\+' workflow run'/.test(rqView.webview.html) && /r\.processes\.length\+' shell'/.test(rqView.webview.html)
      && /r\.compactions/.test(rqView.webview.html) && /fmtDur\(r\.durationMs\)/.test(rqView.webview.html),
      'the facts are edits · subagents · workflow runs · shells · compactions · duration');
    // 0.8.7: each row also carries files, folders, tokens and tasks — the full per-request headline.
    assert.ok(/\(r\.files\|\|0\)\+'f · '\+\(r\.folders\|\|0\)\+'fo'/.test(rqView.webview.html), 'the edit line names files and folders touched');
    assert.ok(/r\.tokens\) f\.push/.test(rqView.webview.html) && /fmtTok\(r\.tokens\)\+' tok/.test(rqView.webview.html), 'a row shows the tokens spent answering');
    assert.ok(/r\.tasks\) w\.push\(r\.tasks\+' task'/.test(rqView.webview.html), 'a row shows the tasks worked');
    // A request with 0 edits is normal and common — rendered as itself, never hidden, never made to look wrong.
    assert.ok(/no edits — a question or a decision/.test(rqView.webview.html), 'an ask that produced no edits says so plainly');
    assert.ok(/r\.actions \? \('no edits · '\+r\.actions\+' tool call'/.test(rqView.webview.html),
      'an ask that ran tools but changed no files says THAT — calling it "a question" would be wrong');
    assert.ok(/if\(r\.added\|\|r\.removed\)/.test(rqView.webview.html), 'the ±lines cell is omitted when there are none, never a fabricated +0 −0');
    assert.ok(/\(r\.endTs\?''\:'~'\)\+fmtDur\(r\.durationMs\)/.test(rqView.webview.html), 'the in-flight ask’s duration is marked "~" (endTs 0 is not a finished number)');
    // The same three states every list in this product keeps apart.
    assert.ok(/Reading this session’s prompts…/.test(rqView.webview.html), 'state 1: nothing has been read yet');
    assert.ok(/No answer for <b>prompts<\/b>/.test(rqView.webview.html), 'state 2: the CLI returned nothing — stated, not blamed on the session');
    assert.ok(/No prompts recorded yet/.test(rqView.webview.html), 'state 3: this session genuinely has none');
    // A failed tool call is not a risk flag — it must not borrow ⚠ + the risk colour.
    assert.ok(/rq-err[^>]*>✗ '\+r\.errors/.test(rqView.webview.html) && /\.rq-err \{[^}]*var\(--mt-warn\)/.test(rqView.webview.html),
      'failed tool calls are marked ✗ in the warn colour');
    // Selecting: the WINDOW owns the pick, the host relays it, the Overview scopes to it.
    assert.ok(/type:'select', id:SEL/.test(rqView.webview.html), 'clicking a row posts the selection to the host');
    assert.ok(/SEL = \(SEL===id\)\? null : id/.test(rqView.webview.html), 'clicking the selected ask again clears the scope');
    assert.equal(typeof rqProvider.selection, 'object', 'the host holds the selection (null until something is picked)');
    rqMsgHandler({ type: 'select', id: 'abc123' });
    assert.equal(rqProvider.selection, 'abc123', 'the host records the picked ask');
    rqMsgHandler({ type: 'select', id: null });
    assert.equal(rqProvider.selection, null, '…and drops it again');
    // 0.8.7: each row expands to review the agent's reply — a caret that toggles the response, fetched
    // lazily from the host (the prose can be large, so it never rides the list payload) and rendered
    // wrapped, never clipped. The caret must NOT change the scope selection.
    assert.ok(/class="rq-exp/.test(rqView.webview.html) && /function toggleResp/.test(rqView.webview.html), 'each row has an expand-response caret');
    assert.ok(/type:'expand', id:id/.test(rqView.webview.html), 'expanding an unfetched response asks the host for it');
    assert.ok(/\.rq-rtext \{[^}]*white-space:pre-wrap/.test(rqView.webview.html), 'the response wraps and never clips');
    assert.ok(/closest\('\.rq-exp'\)/.test(rqView.webview.html) && /ev\.stopPropagation\(\); toggleResp/.test(rqView.webview.html),
      'a caret click toggles the response without changing the scope selection');
    // The Overview carries no Prompts tab — Prompts is the window beside it. It DOES carry the new
    // Sessions tab (0.8.8): this workspace's sessions, click to SWITCH the review.
    assert.ok(!/id="ov-pane-requests"/.test(cmView.webview.html) && !/id="ov-pane-prompts"/.test(cmView.webview.html),
      'the Overview has no prompts tab (it is a window)');
    assert.ok(/var ids=\['sessions','fleet','workflows','tasks','processes'\]/.test(cmView.webview.html),
      'the Overview’s panes are Sessions · Workers · Workflows · Tasks · Processes — Sessions leads, since which session you are reviewing precedes every other question');
    assert.ok(/NAV='sessions'/.test(cmView.webview.html), 'and the panel opens on it');
    assert.ok(/id="ov-pane-sessions"/.test(cmView.webview.html) && /function renderSessions/.test(cmView.webview.html),
      'the Sessions tab renders this workspace’s sessions');
    assert.ok(/switchToSession/.test(cmView.webview.html), 'selecting a Sessions row switches the review (a different selection semantic, stated in its desc)');
    // No scope banner IN the Overview: the Prompts window beside it already shows the picked ask.
    assert.ok(!/id="ov-reqbar"/.test(cmView.webview.html) && !/function renderReqBar/.test(cmView.webview.html),
      'the Overview carries no prompt-scope banner (the Prompts window shows the ask)');
    assert.ok(/function setPromptScope/.test(cmView.webview.html) && /m\.type==='prompt'/.test(cmView.webview.html),
      'the Overview still applies the ask scope the host relays');
    // The filtering itself: one helper, applied by every pane, over core's per-ask id sets.
    assert.ok(/function reqFilter/.test(cmView.webview.html) && /function prSlice/.test(cmView.webview.html),
      'one filter helper, reading core’s per-prompt slice (CM.prompts)');
    assert.ok(/reqFilter\(wf, 'workflowIds'/.test(cmView.webview.html)
      && /reqFilter\(all, 'processIds'/.test(cmView.webview.html) && /has\(rqf\.agentIds/.test(cmView.webview.html),
      'runs, shells and subagents each filter by the ask that STARTED them');
    assert.ok(/function promptSliceView/.test(cmView.webview.html) && /var rq=promptSliceView\(\); if\(rq\) return rq;/.test(cmView.webview.html),
      'the change map draws the ask’s own slice (files/folders aggregated in core)');
    assert.ok(/if\(!r\) return \{ rows:list, hidden:0, scoped:false \}/.test(cmView.webview.html),
      'with no slice to filter by (an older CLI), nothing is filtered — a scoped banner over unfiltered rows would be a lie');
    // OBS_DUMP_HTML=<dir> writes each panel's real HTML out, so a layout check can render the shipped
    // markup at several widths instead of guessing at it. Off by default; the assertions below are the test.
    if (process.env.OBS_DUMP_HTML) {
      fs.mkdirSync(process.env.OBS_DUMP_HTML, { recursive: true });
      for (const [name, view] of [['overview', cmView], ['prompts', rqView], ['stats', stView]])
        if (view) fs.writeFileSync(path.join(process.env.OBS_DUMP_HTML, name + '.html'), String(view.webview.html));
    }
    // The webview's scripts must PARSE. They are built as template literals in TS, so a bare apostrophe
    // inside a single-quoted JS string is invisible to tsc and to every string assertion here, yet it
    // kills the whole panel at runtime with a SyntaxError. Compile each <script> the page ships.
    for (const [label, view] of [['overview', cmView], ['prompts', rqView], ['stats', stView]]) {
      if (!view) continue;
      // Scanned, not regex-matched. A tag-matching regex has to be written case-insensitively AND to
      // tolerate `</script >`, and getting either wrong makes this guard silently vacuous: it would
      // find no blocks and still report that every shipped script parses. Index scanning has neither
      // failure mode (CodeQL flags the regex form as js/bad-tag-filter for exactly this reason).
      const html = String(view.webview.html);
      const hay = html.toLowerCase();
      const scripts = [];
      for (let at = hay.indexOf('<script'); at >= 0; ) {
        const bodyStart = hay.indexOf('>', at);
        if (bodyStart < 0) break;
        const bodyEnd = hay.indexOf('</script', bodyStart);
        if (bodyEnd < 0) break;
        scripts.push(html.slice(bodyStart + 1, bodyEnd));
        at = hay.indexOf('<script', bodyEnd);
      }
      assert.ok(scripts.length, `${label}: the panel ships at least one script`);
      for (const body of scripts) {
        assert.doesNotThrow(() => new Function(body), `${label}: every shipped script parses`);
      }
    }
    assert.ok(/hidden — not started by prompt #/.test(cmView.webview.html),
      'a pane whose rows dropped says how many and why — in prompt vocabulary (0.8.8), never "request"');
    assert.ok(!/request #/.test(cmView.webview.html), 'no user-visible copy still says "request"');
    assert.ok(/if\(PR_ID\) vscode\.postMessage\(\{type:pr, promptId:PR_ID\}\)/.test(cmView.webview.html),
      'the bulk actions retarget to the picked ask');
    // The bottom summary names the picked ask — and since core aggregates its files/folders, it reports them.
    assert.ok(/rq\.rollup\.pending/.test(cmView.webview.html) && /\(rq\.files\|\|\[\]\)\.length/.test(cmView.webview.html),
      'the bottom summary names the ask with its own review counts, files and folders');
    // 0.10.0: the feed pane MOVED to the Timeline's Feed tab — the Overview must not carry it any more,
    // and the change map takes the whole detail height. Its assertions live in the Feed-tab block below.
    assert.ok(!/id="ov-feed"/.test(cmView.webview.html), 'Overview: the below-map feed pane is GONE (it lives in the Timeline now)');
    assert.ok(!/function renderFeed/.test(cmView.webview.html) && !/FEEDDATA/.test(cmView.webview.html),
      '…and none of its renderer survives in the Overview script');
    assert.ok(/function setFeed/.test(cmView.webview.html) && /type:'feed', kind:FEED\.kind, id:FEED\.id, label:FEED\.label/.test(cmView.webview.html),
      'the Overview still NAMES the subject (setFeed posts kind/id/label for the row highlights + the Timeline)');
    // 0.8.7 review (P3), carried across every move (now the Feed tab's fetch): one failed
    // spawn (an older CLI on PATH) must not permanently disable the only re-fetch. Only a GOOD
    // 'audit' answer stops the polling; a forced refresh always re-attempts.
    const bundleSrc = fs.readFileSync(BUNDLE, 'utf8');
    assert.ok(!/feedLive/.test(bundleSrc), 'the "is it live" latch a failed fetch could never clear is gone');
    assert.ok(/agentFeedSettled = ok && d\.mode === "audit"/.test(bundleSrc), 'only a fetch that landed and reported audit settles the head');
    assert.ok(/force && this\.agentFeedKey === key && this\.agentFeedSettled/.test(bundleSrc), 'live heads, failed fetches and a forced refresh all re-attempt');
    // The Refresh command FORCES (a pane stuck on a failed spawn is recoverable from the UI) AND sweeps a
    // newly-added `.observatoryignore` first — a USER refresh is the safe place to apply it, since adding
    // the file fires no capture hook so the capture-time sweep never runs. Both live
    // in the one handler now; the sweep (`dropIgnored`) precedes the forced re-read (`refreshAll(true)`).
    assert.match(bundleSrc, /registerCommand\("claudeObservatory\.refresh", \(\) => \{[\s\S]{0,300}?core\.dropIgnored\(s\)[\s\S]{0,160}?refreshAll\(true\)/,
      'the Refresh command sweeps .observatoryignore then forces a re-read');
    // 0.8.8: the ribbon (and its compaction anchoring) is gone — compactions live in Actions + Stats.
    assert.ok(!/afterChapterId|afterSubtaskId/.test(cmView.webview.html), 'no ribbon compaction anchoring remains (the field shipped as afterChapterId)');
    // 0.8.7: the one footprint fact worth a glance survives on the fleet row — that the session reached
    // OUTSIDE the workspace — re-pointed at the multitask payload's `outside:{reads,writes}`.
    assert.ok(/function outsideSuffix/.test(cmView.webview.html) && /\(a&&a\.outside\)\|\|null/.test(cmView.webview.html),
      'the fleet row’s outside-touch suffix reads the payload’s outside{reads,writes}');
    assert.ok(/'↗ '\+bits\.join\(' · '\)\+' outside'/.test(cmView.webview.html), '…and renders it as "↗ 3 read · 20 written outside"');
    assert.ok(/read outside this workspace — Actions ▸ Egress names them/.test(cmView.webview.html) &&
      /written outside this workspace — Actions ▸ Risk names them/.test(cmView.webview.html),
      'reads and writes are never summed in the tooltip — a read out there is egress, a write is risk — and each points at the audit that names the files');
    assert.ok(!/\+'⚠'\+high|c\.mcp&&c\.mcp\.calls|c\.web&&c\.web\.calls/.test(cmView.webview.html),
      'the suffix no longer restates risk / mcp / web — the row has its own ⚠ cell and those are Egress’s answer');
    assert.ok(cmView.webview.html.includes(core.EXERCISED_NOTE),
      'the suffix still carries core’s single-sourced caveat — these are things the session EXERCISED, never things it was permitted');
    // …and it has to be VISIBLE: the row is the tail of a 25%-wide column, where an unwrapped flex line
    // renders its last items hundreds of pixels past the right edge (measured in the headless harness).
    assert.ok(/\.mt-arow \{[^}]*flex-wrap:wrap/.test(cmView.webview.html), 'a fleet row wraps instead of clipping the facts at its tail');
    // A hidden view must not shell out; and a failed scan (before any data) posts the CLI-missing hint.
    const cmMsgs = [];
    cmView.webview.postMessage = (m) => cmMsgs.push(m);
    cmProvider.refresh();
    assert.equal(cmMsgs.length, 0, 'a hidden Overview does not spawn the CLI or post');
    // A feed pick no longer fetches HERE at all — it routes to whoever activate() wired as the
    // listener (the Timeline provider). Asserted by spy: the ref crosses with kind, id AND label.
    {
      const crossed = [];
      cmProvider.onFeedSelect = (ref) => crossed.push(ref);
      cmMsgHandler({ type: 'feed', kind: 'process', id: 'bg123', label: 'test shell' });
      cmMsgHandler({ type: 'feed' }); // the bare form = a session switch cleared the subject
      assert.deepStrictEqual(crossed, [{ kind: 'process', id: 'bg123', label: 'test shell' }, null],
        'a feed pick crosses to the host listener with its label; the bare form crosses as null');
      cmProvider.onFeedSelect = undefined;
      assert.equal(cmMsgs.length, 0, 'and the Overview itself spawns and posts nothing for it');
    }
    cmProvider.postError();
    assert.ok(cmMsgs.some((m) => m.type === 'error'), 'a failed Overview scan posts the CLI-missing hint');
    assert.ok(typeof cmMsgHandler === 'function', 'the Overview registered a message handler');
    // a subagent chat button (in the Fleet nav) hands off a zero-token chat by agentId.
    const cmSubChat = [];
    const realSubChat = commands['claudeObservatory.chatAction'];
    commands['claudeObservatory.chatAction'] = (ref) => { cmSubChat.push(ref); };
    cmMsgHandler({ type: 'chatAction', ref: { agentId: 'sa1' } });
    commands['claudeObservatory.chatAction'] = realSubChat;
    assert.deepEqual(cmSubChat, [{ agentId: 'sa1' }], 'a Fleet subagent chat button hands off a zero-token chat by agentId');
    // clicking a ledger row drills to the real edit review via the existing command (spy on the
    // registered callback — executeCommand resolves commands[id] at call time)
    const cmOpened = [];
    const realViewChanges = commands['claudeObservatory.viewChanges'];
    commands['claudeObservatory.viewChanges'] = (id) => { cmOpened.push(id); };
    cmMsgHandler({ type: 'openEdit', id: 1 });
    commands['claudeObservatory.viewChanges'] = realViewChanges;
    assert.deepEqual(cmOpened, [1], 'a ledger row click opens that edit for review');
    // a task-ribbon click hands off a zero-token chat about that task (chatAction with a taskId ref)
    const cmChat = [];
    const realChatAction = commands['claudeObservatory.chatAction'];
    commands['claudeObservatory.chatAction'] = (ref) => { cmChat.push(ref); };
    cmMsgHandler({ type: 'chatAction', ref: { taskId: 'abc123' } });
    commands['claudeObservatory.chatAction'] = realChatAction;
    assert.deepEqual(cmChat, [{ taskId: 'abc123' }], 'a task-ribbon click hands off a zero-token chat by taskId');

    // Task review actions: the Tasks tab rows route to the STRICT task ops. The commands are
    // registered; verify the message handler routes each correctly.
    for (const [msg, cmd] of [
      ['taskKeep', 'claudeObservatory.taskKeep'],
      ['taskUndo', 'claudeObservatory.taskUndo'],
      ['taskClear', 'claudeObservatory.taskClear'],
    ]) {
      assert.ok(typeof commands[cmd] === 'function', `${cmd} registered`);
      const seen = [];
      const real = commands[cmd];
      commands[cmd] = (id) => { seen.push(id); };
      cmMsgHandler({ type: msg, taskId: 'chap1' });
      commands[cmd] = real;
      assert.deepEqual(seen, ['chap1'], `a chip ${msg} routes to ${cmd} with the taskId`);
    }
    assert.ok(typeof commands['claudeObservatory.clearCompletedTasks'] === 'function', 'clearCompletedTasks registered');
    const ccSeen = [];
    const realCC = commands['claudeObservatory.clearCompletedTasks'];
    commands['claudeObservatory.clearCompletedTasks'] = () => { ccSeen.push(1); };
    cmMsgHandler({ type: 'clearCompletedTasks' });
    commands['claudeObservatory.clearCompletedTasks'] = realCC;
    assert.equal(ccSeen.length, 1, 'the "clear completed tasks" control routes to its command');

    // Top-navbar review actions route to the existing session-wide commands (the same the Observations
    // toolbar drives): the session selector + Accept All / Reject All / Clear Resolved / Refresh.
    for (const [msg, cmd] of [
      ['switchSession', 'claudeObservatory.switchSession'],
      ['keepAll', 'claudeObservatory.keepAll'],
      ['undoAll', 'claudeObservatory.undoAll'],
      ['clearResolved', 'claudeObservatory.clearResolved'],
      ['refresh', 'claudeObservatory.refresh'],
    ]) {
      assert.ok(typeof commands[cmd] === 'function', `${cmd} registered`);
      let seen = 0;
      const real = commands[cmd];
      commands[cmd] = () => { seen++; };
      cmMsgHandler({ type: msg });
      commands[cmd] = real;
      assert.equal(seen, 1, `the Overview navbar "${msg}" control routes to ${cmd}`);
    }

    // (1) PROMPT-SCOPED BULK ACTIONS: a picked prompt scopes the title-bar Accept All / Reject All /
    // Clear Resolved buttons to that ask and relabels them "…in #N". Verified from the embedded
    // webview source (the smoke harness renders the shell but doesn't execute its script).
    assert.ok(/function relabelBulk/.test(cmView.webview.html), 'the bulk buttons relabel to the selected scope (relabelBulk)');
    assert.ok(/Accept All in /.test(cmView.webview.html) && /Reject All in /.test(cmView.webview.html) && /Clear in /.test(cmView.webview.html),
      'the scoped bulk buttons read "… in #N"');
    assert.ok(/bulk\('ov-keepall','keepAll','promptKeep'\)/.test(cmView.webview.html)
      && /bulk\('ov-undoall','undoAll','promptUndo'\)/.test(cmView.webview.html)
      && /bulk\('ov-clearres','clearResolved','promptClear'\)/.test(cmView.webview.html),
      'a selected prompt reroutes Accept All / Reject All / Clear to the prompt ops');

    // (2) STATUS-BAR REVIEW NAV BAR IN THE TITLE BAR: File ◄►, Diff ◄► with live n/m · i/k counters, plus
    // Keep, Undo, Accept File, Reject File, Spotlight, Search — the compact step-through controls, next to
    // the session selector, each posting to the existing nav commands.
    for (const id of ['ov-fileprev', 'ov-filecount', 'ov-filenext', 'ov-diffprev', 'ov-diffcount', 'ov-diffnext',
      'ov-navkeep', 'ov-navundo', 'ov-acceptfile', 'ov-rejectfile', 'ov-spotlight',
      // the inline filter/sort chrome: a search FIELD (not a button), the filter dropdown with its
      // state label, and the sort button with the mode in its label
      'ov-search-input', 'ov-filterdrop', 'ov-filter-lbl', 'ov-sort-lbl']) {
      assert.ok(cmView.webview.html.includes(`id="${id}"`), `Overview title bar carries the nav-bar control ${id}`);
    }
    assert.ok(/renderNavPos/.test(cmView.webview.html), 'the Diff n/m · File i/k position counters render from the pushed NAVPOS');
    // the nav-bar buttons route to the existing status-bar nav commands (same controls, same backend).
    for (const [msg, cmd] of [
      ['navFilePrev', 'claudeObservatory.navFilePrev'],
      ['navFileNext', 'claudeObservatory.navFileNext'],
      ['navDiffPrev', 'claudeObservatory.navDiffPrev'],
      ['navDiffNext', 'claudeObservatory.navDiffNext'],
      ['navKeep', 'claudeObservatory.navKeep'],
      ['navUndo', 'claudeObservatory.navUndo'],
      ['keepOpenFile', 'claudeObservatory.keepOpenFile'],
      ['undoOpenFile', 'claudeObservatory.undoOpenFile'],
      ['toggleHeatmap', 'claudeObservatory.toggleHeatmap'],
      ['searchEdits', 'claudeObservatory.searchEdits'],
      ['exportSummary', 'claudeObservatory.exportSummary'],
      ['exportMenu', 'claudeObservatory.exportMenu'],
      ['versionUpdate', 'claudeObservatory.updateNow'],
    ]) {
      assert.ok(typeof commands[cmd] === 'function', `${cmd} registered`);
      let seen = 0;
      const real = commands[cmd];
      commands[cmd] = () => { seen++; };
      cmMsgHandler({ type: msg });
      commands[cmd] = real;
      assert.equal(seen, 1, `the Overview nav-bar "${msg}" control routes to ${cmd}`);
    }
    // Export: the QuickPick menu routes to both documents, and exportTrace opens the FULL session
    // trace as a JSON document (core.buildSessionTrace — same shape the CLI `export` verb emits).
    assert.ok(typeof commands['claudeObservatory.exportTrace'] === 'function', 'exportTrace registered');
    quickPick = 1; // the menu's second row: "Full session trace"
    let traced = 0;
    const realTrace = commands['claudeObservatory.exportTrace'];
    commands['claudeObservatory.exportTrace'] = () => { traced++; };
    await commands['claudeObservatory.exportMenu']();
    commands['claudeObservatory.exportTrace'] = realTrace;
    assert.equal(traced, 1, 'the Export menu routes "Full session trace" to exportTrace');
    quickPick = null;
    await commands['claudeObservatory.exportTrace']();
    assert.ok(opened && opened.uri && typeof opened.uri.content === 'string', 'exportTrace opened a document');
    assert.ok(
      opened.uri.language === 'json' && opened.uri.content.includes('"edits"') && opened.uri.content.includes('"exportedAt"'),
      'the document is the session-trace JSON'
    );

    // The version chip (0.9.0): pinned at the controls row's right edge; its menu routes channel
    // switches to the switchChannel command (with the channel argument intact).
    assert.ok(/id="ov-version"/.test(bundleSrc), 'the version chip is in the Overview navbar markup');
    assert.ok(typeof commands['claudeObservatory.switchChannel'] === 'function', 'switchChannel registered');
    let switched = 0;
    const realSwitch = commands['claudeObservatory.switchChannel'];
    commands['claudeObservatory.switchChannel'] = (ch) => { switched++; assert.equal(ch, 'dev', 'the picked channel rides along'); };
    cmMsgHandler({ type: 'switchChannel', channel: 'dev' });
    assert.equal(switched, 1, 'the version menu routes channel switches to switchChannel');
    // The refusal check runs WHILE the spy is installed — restored first, a forwarded bad value
    // would hit the real command (which no-ops under the mock) and this assert could never fail.
    cmMsgHandler({ type: 'switchChannel', channel: 'evil' });
    assert.equal(switched, 1, 'an unknown channel value is refused, never forwarded');
    commands['claudeObservatory.switchChannel'] = realSwitch;

    // The webview's own display path, EXECUTED: markup + routing asserts cannot see a renderer whose
    // state lives in the wrong scope (the chip once rendered v— forever while every other assert was
    // green) — only running the real script against a DOM stub catches that class.
    {
      const vm = require('node:vm');
      // The close pattern is js/bad-tag-filter's canonical shape — case-insensitive, any junk before
      // the `>` — so the sanitizer-bypass scanner has nothing left to escalate on a parser that only
      // ever reads our own generated shell.
      const scripts = [...cmView.webview.html.matchAll(/<script[^>]*>([\s\S]*?)<\/script[^>]*>/gi)];
      assert.ok(scripts.length >= 1, 'the overview shell embeds its script');
      const mkEl = () => {
        // `style` models the API the script uses: the grouped column widths are written as a CSS custom
        // property, and a bare {} would swallow setProperty (it is not a plain assignment).
        const style = {
          setProperty(k, v) { style[k] = String(v); },
          removeProperty(k) { delete style[k]; },
          getPropertyValue: (k) => style[k] || '',
        };
        const el = {
          innerHTML: '', textContent: '', title: '', hidden: true, style, dataset: {}, value: '', checked: false, _ls: {},
          classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
          setAttribute() {}, getAttribute: () => null, hasAttribute: () => false, removeAttribute() {},
          addEventListener(t, cb) { (el._ls[t] || (el._ls[t] = [])).push(cb); },
          // Real, because the drag handlers detach themselves on pointerup — a missing method there would
          // throw inside the very interaction these assertions drive.
          removeEventListener(t, cb) { const l = el._ls[t]; if (l) { const i = l.indexOf(cb); if (i >= 0) l.splice(i, 1); } },
          appendChild() {}, removeChild() {}, contains: () => false,
          querySelectorAll: () => [], querySelector: () => null, parentNode: null, firstChild: null,
          getContext: () => null,
          // A NON-degenerate box: a divider computes its new split as a fraction of the pair it sits
          // between, and a zero-width rect would make every clamp trivially true.
          getBoundingClientRect: () => ({ width: 600, height: 300, left: 0, top: 0, right: 600, bottom: 300 }),
        };
        return el;
      };
      // ONE harness, run more than once: the panel's LAYOUT comes out of its persisted webview state, so
      // the grouped-nav assertions further down need a second context whose getState() hands back
      // groupedNav:true. Everything else about the two runs is identical, which is the point — the only
      // difference between five tabs and two is that one value.
      const runOverview = (persisted) => {
        const els = new Map();
        const elFor = (id) => { if (!els.has(id)) els.set(id, mkEl()); return els.get(id); };
        let msgListener = null;
        const winStub = {
          addEventListener: (t, cb) => { if (t === 'message') msgListener = cb; },
          matchMedia: () => ({ matches: false, addEventListener() {} }),
          setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
          requestAnimationFrame: () => 0, devicePixelRatio: 1, scrollY: 0,
        };
        const docStub = {
          getElementById: elFor, addEventListener() {}, createElement: mkEl,
          querySelectorAll: () => [], querySelector: () => null, body: mkEl(), documentElement: mkEl(),
        };
        const saved = []; // every vscode.setState — this panel's layout is what it persists
        const posts = []; // every message the page posts to the host — what a click actually asks for
        const sandbox = {
          window: winStub, document: docStub, console,
          acquireVsCodeApi: () => ({ postMessage: (m) => posts.push(m), getState: () => persisted || null, setState: (s) => saved.push(s) }),
          URLSearchParams, JSON, Math, Date, String, Number, Array, Object, RegExp, parseInt, parseFloat, isFinite, NaN, Infinity, undefined,
          getComputedStyle: () => ({ getPropertyValue: () => '' }),
          ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
          IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
          requestAnimationFrame: () => 0, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
          localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        };
        winStub.document = docStub;
        sandbox.globalThis = sandbox;
        vm.createContext(sandbox);
        assert.doesNotThrow(() => vm.runInContext(scripts[scripts.length - 1][1], sandbox), 'the overview script initializes under the DOM stub');
        assert.ok(typeof msgListener === 'function', 'the script listens for host messages');
        /** Invoke the LAST handler registered for an event — i.e. the one the current markup wired. */
        const fire = (node, type, ev) => {
          const l = node._ls[type] || [];
          const cb = l[l.length - 1];
          assert.ok(cb, `the stub node has a ${type} handler to fire`);
          return cb.call(node, ev || { target: node, stopPropagation() {}, preventDefault() {} });
        };
        return { elFor, fire, saved, posts, post: (data) => msgListener({ data }) };
      };
      const solo = runOverview(null);
      const elFor = solo.elFor;
      solo.post({ type: 'version', v: { current: '9.9.9', channel: 'stable', stableLatest: '9.9.10', devLatest: '9.10.0-dev.3', updateAvailable: true } });
      assert.match(elFor('ov-version').innerHTML, /9\.9\.9/, 'the chip RENDERS the version the host delivered');
      assert.match(elFor('ov-vermenu').innerHTML, /Pre-release/, 'the menu carries the channel rows');
      assert.match(elFor('ov-vermenu').innerHTML, /Update now<span class="vm-ver">v9\.9\.10/, 'the Update row NAMES the version it would install');
      assert.doesNotMatch(elFor('ov-vermenu').innerHTML, /up to date/, 'and never claims up to date while an update exists');
      // The Update row is ALWAYS present — up to date shows the affordance too, safely clickable.
      solo.post({ type: 'version', v: { current: '9.9.9', channel: 'stable', stableLatest: '9.9.9', devLatest: null, updateAvailable: false } });
      assert.match(elFor('ov-vermenu').innerHTML, /Update now/, 'the Update row survives being up to date');
      assert.match(elFor('ov-vermenu').innerHTML, /up to date/, 'and says so instead of hiding');
      // No release data (offline / first paint): the row stays, but claims nothing it has not checked.
      solo.post({ type: 'version', v: { current: '9.9.9', channel: 'stable', stableLatest: null, devLatest: null, updateAvailable: false, offline: true } });
      assert.match(elFor('ov-vermenu').innerHTML, /Update now<span class="vm-ver">—/, 'with no feed data the Update row shows an em-dash');
      assert.doesNotMatch(elFor('ov-vermenu').innerHTML, /up to date/, 'and does not assert up to date it never verified');

      // 0.9.5 — THE DROPDOWN MUST NAME WHAT IS ACTUALLY INSTALLED, per surface. "Update now" moves
      // the extension, the CLI and the JetBrains plugin, but the menu showed ONE number (the
      // extension's), so whenever they differed it described something other than what the button
      // changed. Each surface now carries its own version and its own verdict.
      solo.post({ type: 'version', v: { current: '0.10.0', channel: 'dev', stableLatest: '0.9.5', devLatest: '0.10.0-dev.12', updateAvailable: true,
        surfaces: [
          { label: 'Extension', version: '0.10.0', reason: 'not on this channel' },
          { label: 'CLI', version: '0.10.0-dev.12', reason: 'current' },
        ] } });
      let menu = elFor('ov-vermenu').innerHTML;
      assert.match(menu, /Extension<\/span><span class="vm-ver">v0\.10\.0 · not on this channel/, 'the extension row names its own version AND why it is wrong');
      assert.match(menu, /CLI<\/span><span class="vm-ver">v0\.10\.0-dev\.12</, 'the CLI row names the CLI version, which is a DIFFERENT number');
      assert.doesNotMatch(menu, /CLI<\/span><span class="vm-ver">v0\.10\.0-dev\.12 ·/, 'a current surface carries no verdict suffix');

      // A missing CLI is reported as missing — an extension-only install is supported, not broken.
      solo.post({ type: 'version', v: { current: '0.9.5', channel: 'stable', stableLatest: '0.9.5', devLatest: null, updateAvailable: false,
        surfaces: [{ label: 'Extension', version: '0.9.5', reason: 'current' }, { label: 'CLI', version: null, reason: 'not found' }] } });
      menu = elFor('ov-vermenu').innerHTML;
      assert.match(menu, /CLI<\/span><span class="vm-ver">— · not found/, 'a CLI that could not be located says so rather than showing the extension version');

      // After an install lands, the running host is still the OLD build. Saying nothing made the
      // update look like it had failed; the row says the new version is in, pending a reload.
      solo.post({ type: 'version', v: { current: '0.9.4', channel: 'stable', stableLatest: '0.9.5', devLatest: null, updateAvailable: false, pendingReload: '0.9.5',
        surfaces: [{ label: 'Extension', version: '0.9.5', reason: 'pending reload' }] } });
      assert.match(elFor('ov-vermenu').innerHTML, /Extension<\/span><span class="vm-ver">v0\.9\.5 · pending reload/, 'an installed-but-not-loaded build is named as such');

      // ---- Marketplace stand-down: classify how THIS install got here, from the editor's own registry --
      // The self-updater stands down when a marketplace manages the install, so it doesn't
      // fight the gallery over one extension. That hinges on classifyInstallSource reading
      // <extensionsDir>/extensions.json correctly; pin it against real fixtures. Anything it cannot
      // read maps to 'unknown' = the pre-marketplace status quo (self-updater active).
      {
        const reg = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-extreg-'));
        const ID = 'cell-observatory.oak-observatory-vscode', VER = '0.10.0-dev.0', BASE = 'cell-observatory.oak-observatory-vscode-0.10.0-dev.0';
        const write = (entries) => fs.writeFileSync(path.join(reg, 'extensions.json'), JSON.stringify(entries));
        // Matched by relativeLocation → gallery / vsix reported verbatim.
        write([{ identifier: { id: ID }, version: VER, relativeLocation: BASE, metadata: { source: 'gallery', pinned: false } }]);
        assert.equal(ext.classifyInstallSource(reg, BASE, ID, VER), 'gallery', 'a gallery-installed extension classifies as gallery');
        write([{ identifier: { id: ID }, version: VER, relativeLocation: BASE, metadata: { source: 'vsix', pinned: true } }]);
        assert.equal(ext.classifyInstallSource(reg, BASE, ID, VER), 'vsix', 'a sideloaded .vsix classifies as vsix');
        // Fallback match by id+version when relativeLocation differs.
        write([{ identifier: { id: ID }, version: VER, relativeLocation: 'somewhere-else', metadata: { source: 'gallery' } }]);
        assert.equal(ext.classifyInstallSource(reg, BASE, ID, VER), 'gallery', 'falls back to id+version match');
        // Fail-safe: our entry absent, unknown source, malformed JSON, missing file → unknown (= status quo).
        write([{ identifier: { id: 'someone.else' }, version: '1.0.0', relativeLocation: 'x', metadata: { source: 'gallery' } }]);
        assert.equal(ext.classifyInstallSource(reg, BASE, ID, VER), 'unknown', 'no matching entry → unknown');
        write([{ identifier: { id: ID }, version: VER, relativeLocation: BASE, metadata: {} }]);
        assert.equal(ext.classifyInstallSource(reg, BASE, ID, VER), 'unknown', 'a matched entry with no source → unknown');
        fs.writeFileSync(path.join(reg, 'extensions.json'), 'not json{');
        assert.equal(ext.classifyInstallSource(reg, BASE, ID, VER), 'unknown', 'malformed registry → unknown, never throws');
        assert.equal(ext.classifyInstallSource(path.join(reg, 'nope'), BASE, ID, VER), 'unknown', 'missing registry → unknown, never throws');
        fs.rmSync(reg, { recursive: true, force: true });
      }

      // ---- 0.10.0: the grouped left nav, EXECUTED both ways -----------------------------------------
      // Five tabs or two group tabs of side-by-side columns, decided by one persisted value. Asserted by
      // running the shipped script rather than by reading its source: the hazard here is a column whose
      // list never gets rendered into, and only execution can see that.
      const OVSESS = 'ovSess01';
      const ovPayload = (pr) => ({
        type: 'overview', cm: null, session: OVSESS, sessionTitle: 'the reviewed session', pinned: OVSESS, prompt: null, navPos: null, filter: '',
        mt: {
          agents: [{ session: OVSESS, worktree: '/w/repo', gitBranch: 'dev', self: true, phase: 'working', sparkline: [1, 2], diff: { added: 3, removed: 1 }, tokens: 900, durationMs: 5000, risk: 0, subagents: [] }],
          workflows: [{ id: 'wf1', name: 'wf1', description: 'the workflow run', running: true, agents: [], phaseGroups: [], added: 1, removed: 0, tokens: 10, durationMs: 10, edits: 1 }],
          tasks: [{ id: 7, subject: 'the planned task', status: 'in_progress', taskId: 'tk7' }],
          collisions: [],
        },
        pr,
        sessions: { active: OVSESS, sessions: [{ id: OVSESS, title: 'the reviewed session', lastActiveMs: Date.now(), current: true, edits: 1, pending: 1, files: 1, added: 3, removed: 1, tokens: 900, durationMs: 5000, model: '', effort: '' }] },
      });
      const shells = { processes: [{ id: 'bash_9', command: 'npm test', description: 'npm test', running: true, runtimeMs: 1000, outputBytes: 12 }], summary: { total: 1, running: 1, failed: 0 } };
      // Solo mode is the control: the same payload, five member tabs, no group tab anywhere.
      solo.post(ovPayload(shells));
      const soloTabs = elFor('ov-navtabs').innerHTML;
      assert.equal((soloTabs.match(/class="ov-tab/g) || []).length, 5, 'ungrouped: the five member tabs, exactly as before');
      assert.doesNotMatch(soloTabs, /data-nav="g:/, 'and no group tab');

      // Execute the built webview's workspace headers, zero stats, filters, folds and actions.
      const workspacePayload = {
        active: OVSESS,
        sessions: [
          { ...ovPayload(shells).sessions.sessions[0], workspace: '~/projects/app', origin: 'local' },
          { id: 'older-local', workspace: '~/projects/app', title: 'Older local', lastActiveMs: Date.now() - 8*86400000, pending: 2, edits: 2 },
          { id: 'other-local', workspace: '~/projects/tools', title: 'Native Codex title', agent: 'codex', lastActiveMs: Date.now(), edits: 0, tokens: 0, durationMs: 0, model: 'gpt-6' },
          { id: 'quiet-local', workspace: '~/projects/tools', title: 'Quiet conversation', lastActiveMs: Date.now() - 2*86400000, edits: 0 },
        ],
      };
      solo.post({ type: 'sessions', sessions: workspacePayload });
      const workspaceHtml = elFor('ov-sessions').innerHTML;
      assert.ok(workspaceHtml.indexOf('~/projects/app · 2 sessions') < workspaceHtml.indexOf('~/projects/tools · 2 sessions'));
      assert.match(workspaceHtml, /0 edits · 0 tok · 0s/);
      assert.match(workspaceHtml, /Native Codex title/);
      assert.match(workspaceHtml, /1 older sessions/);
      assert.match(workspaceHtml, /1 hidden by Active only/);
      assert.doesNotMatch(workspaceHtml, /data-sess-switch="older-local"|data-sess-switch="quiet-local"|on build-box|mt-machine/);
      for (const attr of ['data-sess-switch', 'data-conversation', 'data-sess-del'])
        assert.match(workspaceHtml, new RegExp(attr+'="other-local"'), 'row actions survive grouping');
      assert.match(elFor('ov-navtabs').innerHTML, /2\/4/);
      const allSessions = runOverview({ activeOnly: false });
      allSessions.post({ type: 'sessions', sessions: workspacePayload });
      assert.match(allSessions.elFor('ov-sessions').innerHTML, /data-sess-switch="quiet-local"/);
      assert.doesNotMatch(allSessions.elFor('ov-sessions').innerHTML, /hidden by Active only/);
      // Every refresh tick posts a payload, and each one re-rendered the list. A payload that changes
      // nothing must leave the rendered rows alone: a rebuild between a click's press and its release
      // swallowed the click.
      {
        const host = elFor('ov-sessions');
        let html = host.innerHTML, writes = 0;
        Object.defineProperty(host, 'innerHTML', { configurable: true, get: () => html, set: (v) => { writes++; html = v; } });
        solo.post({ type: 'sessions', sessions: workspacePayload });
        solo.post({ ...ovPayload(shells), sessions: workspacePayload });
        assert.equal(writes, 0, 'an unchanged listing is not rebuilt, by a sessions payload or an overview payload');
        solo.post({ type: 'sessions', sessions: { ...workspacePayload, sessions: workspacePayload.sessions.map((r) => (r.id === 'other-local' ? { ...r, title: 'Renamed conversation' } : r)) } });
        assert.equal(writes, 1, 'control: a changed listing does repaint');
        assert.match(html, /Renamed conversation/);
        // A pinned session the listing lacks is explained. The listing spans every workspace on this
        // machine, so it is never "another workspace's".
        solo.post({ ...ovPayload(shells), session: 'ghostPin01', pinned: 'ghostPin01' });
        assert.match(html, /reviewing ghostPin — not in this machine’s session list \(deleted, empty, or a copy mirrored from another machine\)/);
        assert.doesNotMatch(html, /another workspace/);
        solo.post(ovPayload(shells));
        assert.doesNotMatch(html, /not in this machine’s session list/, 'control: a listed pin gets no such line');
        delete host.innerHTML;
        host.innerHTML = html;
      }
      if (process.env.SESSIONS_SCREENSHOT_DIR) fs.writeFileSync(path.join(process.env.SESSIONS_SCREENSHOT_DIR, 'sessions-after.html'), '<!doctype html><meta charset="utf-8">'+[...cmView.webview.html.matchAll(/<style[^>]*>[\s\S]*?<\/style>/gi)].map(x=>x[0]).join('')+'<body style="background:#181818;color:#ddd;width:1100px;font-family:system-ui,sans-serif">'+workspaceHtml+'</body>');

      // ---- The store folder, EXECUTED end to end. A Sessions row's size and the
      // toolbar's Store button run through the real page script to the message they post, then through
      // the real host handler to the call that opens the folder. The stub's querySelectorAll answers []
      // everywhere, so the row wiring never ran here: the Sessions host answers attribute selectors from
      // its own markup — one stable node per match per render, what the script wires its handlers onto.
      {
        const sessHost = elFor('ov-sessions');
        let qsHtml = null, qsCache = {};
        sessHost.querySelectorAll = (sel) => {
          const m = /^\[([\w-]+)\]$/.exec(sel);
          if (!m) return [];
          if (qsHtml !== sessHost.innerHTML) { qsHtml = sessHost.innerHTML; qsCache = {}; }
          return qsCache[sel] || (qsCache[sel] = [...qsHtml.matchAll(new RegExp(m[1] + '="([^"]*)"', 'g'))].map((hit) => {
            const node = mkEl();
            node.getAttribute = (k) => (k === m[1] ? hit[1] : null);
            return node;
          }));
        };
        sessHost.querySelector = (sel) => sessHost.querySelectorAll(sel)[0] || null;
        const storeDir = core.storeDir(S);
        assert.ok(fs.existsSync(storeDir), 'control: the seeded session has a store folder on disk');
        solo.post({ type: 'sessions', sessions: { active: S, sessions: [
          { id: S, workspace: '~/projects/app', title: 'the seeded session', lastActiveMs: Date.now(), current: true, edits: 2, storeBytes: core.storeBytes(S), storePath: storeDir },
        ] } });
        const sizes = sessHost.querySelectorAll('[data-store]');
        assert.equal(sizes.length, 1, 'the row renders its store size as a click target');
        solo.posts.length = 0;
        solo.fire(sizes[0], 'click');
        assert.deepEqual(solo.posts, [{ type: 'openStore', id: S }], 'clicking the size asks the host to open THAT row’s store');
        // A local window: the OS file manager opens the folder itself.
        openExternalCalls.length = 0;
        openFolderCalls.length = 0;
        cmMsgHandler(solo.posts[0]);
        // `.path` is the exact string handed to Uri.file — the mock's fsPath lower-cases a Windows drive letter.
        assert.deepEqual(openExternalCalls.map((u) => [u.scheme, u.path]), [['file', storeDir]], 'locally, the store folder opens in the OS file manager');
        assert.equal(openFolderCalls.length, 0, '…and no editor window opens');
        // A remote window (Remote-SSH, WSL, a container): this extension runs on the remote host, so the
        // store is there, and openExternal would hand the UI machine a vscode-remote:// URL that nothing
        // opens — the reported failure. The folder opens in a new window on the remote host instead.
        vscode.env.remoteName = 'ssh-remote';
        try {
          openExternalCalls.length = 0;
          cmMsgHandler(solo.posts[0]);
          assert.equal(openExternalCalls.length, 0, 'in a remote window nothing is handed to the local OS');
          assert.equal(openFolderCalls.length, 1, 'the folder opens in an editor window instead');
          const [uri, opts] = openFolderCalls[0];
          assert.deepEqual([uri.scheme, uri.path], ['file', storeDir], '…on the store folder itself (the remote host maps file: to its own URI)');
          assert.deepEqual(opts, { forceNewWindow: true, noRecentEntry: true }, '…in a NEW window, kept out of the recent list');
        } finally {
          vscode.env.remoteName = undefined;
        }
        // The toolbar's Store button names no row: it opens the reviewed session's store.
        solo.posts.length = 0;
        solo.fire(elFor('ov-store'), 'click');
        assert.deepEqual(solo.posts, [{ type: 'openStore' }], 'the Store button posts openStore');
        openExternalCalls.length = 0;
        cmMsgHandler(solo.posts[0]);
        assert.deepEqual(openExternalCalls.map((u) => u.path), [storeDir], '…which opens the reviewed session’s store folder');
        // Never silent: a session with no folder yet, a row id that is not a session, and an open the
        // platform refused each SAY so — and none of them throws out of the host handler.
        const warnedBefore = warnMessages.length;
        openExternalCalls.length = 0;
        cmMsgHandler({ type: 'openStore', id: 'nostore01' });
        assert.equal(openExternalCalls.length, 0, 'a session with no store folder opens nothing');
        assert.match(warnMessages.slice(warnedBefore).join('\n'), /nostore0 has no store folder yet/, '…and says so');
        assert.doesNotThrow(() => cmMsgHandler({ type: 'openStore', id: '../escape' }), 'an id that is not a session cannot throw out of the handler');
        assert.equal(openExternalCalls.length, 0, '…nor open anything');
        openExternalAnswer = false;
        try {
          cmMsgHandler({ type: 'openStore', id: S });
          await new Promise((r) => setImmediate(r));
          assert.match(warnMessages.slice(warnedBefore).join('\n'), /could not open the store folder/, 'an open the platform refused is reported');
        } finally {
          openExternalAnswer = true;
        }
      }
      solo.post(ovPayload(shells));


      // The harness DOM mints elements on demand (getElementById never fails here), so the one
      // thing it can NOT catch is a missing container in the real page — which is exactly how
      // the one-group change shipped blank: the skeleton still carried the two old group divs.
      // Pin the STATIC html: the group container the script looks up must exist in the page.
      assert.ok(cmView.webview.html.includes('id="ov-group-all"'), 'the page ships the one-group container the script renders into');
      assert.ok(!cmView.webview.html.includes('id="ov-group-sf"') && !cmView.webview.html.includes('id="ov-group-wtp"'),
        'and the two-group era containers are gone');
      const grouped = runOverview({ groupedNav: true });
      // pr:null on the FIRST payload — an older CLI, or the answer not back yet. The Processes column must
      // still be there (a tab that vanishes when the CLI cannot answer hides the failure), badge blank.
      grouped.post(ovPayload(null));
      const gTabs = grouped.elFor('ov-navtabs').innerHTML;
      // ONE group: every member side by side, never split into two tabs.
      assert.equal((gTabs.match(/class="ov-tab/g) || []).length, 1, 'grouped: exactly one tab');
      assert.ok(gTabs.includes('>Sessions · Workers · Workflows · Tasks · Processes<'), 'named for all five members');
      const wtp = grouped.elFor('ov-group-all').innerHTML;
      assert.equal((wtp.match(/class="ov-groupcol"/g) || []).length, 5, 'the one group renders FIVE columns');
      for (const k of ['sessions', 'fleet', 'workflows', 'tasks', 'processes'])
        assert.ok(wtp.includes(`id="ov-g-${k}"`), `the ${k} column carries its own list node`);
      assert.equal(grouped.elFor('ov-gb-processes').textContent, '', 'with no shells payload the Processes badge is blank — the column is not');
      // The member lists are RENDERED INTO those columns — one renderer per member, writing wherever the
      // member's list currently lives.
      assert.match(grouped.elFor('ov-g-workflows').innerHTML, /the workflow run/, 'the Workflows column holds the workflow list');
      assert.match(grouped.elFor('ov-g-tasks').innerHTML, /the planned task/, 'the Tasks column holds the task list');
      assert.match(grouped.elFor('ov-g-sessions').innerHTML, /the reviewed session/, 'the Sessions column holds the session list');
      assert.match(grouped.elFor('ov-g-fleet').innerHTML, /repo/, 'the Fleet column holds the agent list');
      // …and the badge fills in the moment the payload arrives, without the columns being rebuilt.
      grouped.post(ovPayload(shells));
      assert.equal(grouped.elFor('ov-gb-processes').textContent, '1/1', 'the Processes badge appears once the CLI answers');
      assert.match(grouped.elFor('ov-g-processes').innerHTML, /bash_9/, 'and the Processes column lists the shell');
      // The tour names MEMBERS, always. Grouped, a step about any member lands on the ONE group —
      // resolveTab is the one place that knows the mapping, and both paths go through it.
      grouped.post({ type: 'tour', tab: 'fleet', anchor: 'nav-tabs' });
      assert.equal(grouped.elFor('ov-group-all').style.display, 'flex', 'a tour step naming fleet opens the group');
      grouped.post({ type: 'tour', tab: 'processes', anchor: 'nav-tabs' });
      assert.equal(grouped.elFor('ov-group-all').style.display, 'flex', 'and one naming processes lands on the same group');
      // Grouped mode drives the SAME split variables the master column already uses, so the reader's drag
      // and the vertical-responsive branch keep working — with its own remembered width. (documentElement
      // is a stub whose style writes are not observable, so this reads the shipped source.)
      assert.match(cmView.webview.html, /setProperty\('--ov-nav', \(GROUPNAV\?NAV_WG:NAV_W\)\+'%'\)/, 'the grouped width drives --ov-nav');
      assert.match(cmView.webview.html, /setProperty\('--ov-navv', \(GROUPNAV\?NAV_HG:NAV_H\)\+'%'\)/, '…and the stacked one drives --ov-navv');
      assert.match(cmView.webview.html, /groupedNav:GROUPNAV, navWG:NAV_WG, navHG:NAV_HG/, 'all three ride the webview state, not a workspace setting');

      // ---- 0.10.0: the COLUMNS inside a group are the reader's to size and to fold -----------------
      // Equal to start, dragged on the divider between a pair, and never past the floor that keeps a
      // name readable — this product wraps or tooltips, it does not clip.
      assert.equal(grouped.elFor('ov-gc-workflows').style['--ov-cw'], '1', 'columns start on an equal share');
      const ovDrag = (gutterId, clientX) => {
        const g = grouped.elFor(gutterId);
        grouped.fire(g, 'pointerdown', { preventDefault() {}, pointerId: 1, clientX });
        grouped.fire(g, 'pointermove', { clientX });
        grouped.fire(g, 'pointerup', {});
      };
      ovDrag('ov-cg-tasks', 100000); // drag the Workflows|Tasks divider as far right as it goes
      const wW = Number(grouped.elFor('ov-gc-workflows').style['--ov-cw']);
      const wT = Number(grouped.elFor('ov-gc-tasks').style['--ov-cw']);
      assert.ok(wW > 1 && wT < 1, 'the drag moved the split');
      assert.ok(Math.abs(wW + wT - 2) < 1e-9, '…without changing the pair’s combined share');
      // The pair spans 600px in the stub and the floor is 150px, so neither side may end below 150/600
      // of their combined share. A missing clamp puts the shrinking column at zero.
      assert.ok(wT >= 2 * (150 / 600) - 1e-9, 'and the shrinking column stopped at the 150px floor, never at zero');
      assert.equal(grouped.elFor('ov-gc-processes').style['--ov-cw'], '1', 'the third column is untouched by a drag between the other two');
      // The trap: the Processes column is ALWAYS present and its badge arrives on a later payload. That
      // payload must not reset a width (or a fold) the reader set seconds earlier.
      grouped.post(ovPayload(shells));
      assert.equal(Number(grouped.elFor('ov-gc-workflows').style['--ov-cw']), wW, 'a later payload leaves the dragged width alone');
      assert.equal(Number(grouped.elFor('ov-gc-tasks').style['--ov-cw']), wT, '…on both sides of the divider');
      assert.equal(grouped.elFor('ov-gb-processes').textContent, '1/1', 'while the badge it carried still lands');
      assert.deepEqual(grouped.saved[grouped.saved.length - 1].colW.all.map((n) => Math.round(n * 1000)),
        [1000, 1000, Math.round(wW * 1000), Math.round(wT * 1000), 1000], 'the widths are persisted on pointer-up');
      // FOLDING a column: a rail that still names itself, and a group that always keeps one open.
      grouped.fire(grouped.elFor('ov-cc-tasks'), 'click');
      const wtpFolded = grouped.elFor('ov-group-all').innerHTML;
      assert.match(wtpFolded, /class="ov-groupcol rail" id="ov-gc-tasks"/, 'the folded column becomes a rail');
      // …past the end of the opening tag, so the button's own title cannot satisfy this: the NAME has to
      // be in the rail's content, which is what the reader sees.
      assert.match(wtpFolded, /id="ov-cc-tasks"[^>]*>[\s\S]*?Tasks/, '…which still NAMES the member, so it can be clicked back');
      assert.ok(wtpFolded.includes('id="ov-gb-tasks"'), '…and still carries its badge');
      assert.ok(!wtpFolded.includes('id="ov-g-tasks"'), 'and its list is not drawn while folded');
      assert.equal((wtpFolded.match(/class="ov-groupcol"/g) || []).length, 4, 'four columns remain expanded');
      grouped.fire(grouped.elFor('ov-cc-processes'), 'click');
      grouped.fire(grouped.elFor('ov-cc-sessions'), 'click');
      grouped.fire(grouped.elFor('ov-cc-fleet'), 'click');
      assert.equal((grouped.elFor('ov-group-all').innerHTML.match(/class="ov-groupcol"/g) || []).length, 1, 'and then one');
      assert.ok(!grouped.elFor('ov-group-all').innerHTML.includes('id="ov-cc-workflows"'), 'the last expanded column offers no fold button');
      grouped.fire(grouped.elFor('ov-cc-workflows'), 'click'); // a click that raced the repaint
      assert.equal((grouped.elFor('ov-group-all').innerHTML.match(/class="ov-groupcol"/g) || []).length, 1,
        'and folding it is refused — a group with every column folded is an empty pane');
      assert.ok(grouped.saved[grouped.saved.length - 1].colC.tasks, 'the folded set is persisted');
      assert.ok(!grouped.saved[grouped.saved.length - 1].colC.workflows, '…and the refused fold is not in it');
      // A later payload must not un-fold anything either.
      grouped.post(ovPayload(shells));
      assert.equal((grouped.elFor('ov-group-all').innerHTML.match(/class="ov-groupcol"/g) || []).length, 1,
        'a later payload leaves the folded columns folded');
      // Restoring gives back the width that was SET, not an equal share — the whole reason a fold leaves
      // the weight alone. wT came from the drag above and is deliberately not 1.
      assert.ok(Math.abs(wT - 1) > 0.01, 'the dragged weight is distinguishable from an equal share');
      grouped.fire(grouped.elFor('ov-cc-tasks'), 'click');
      assert.equal((grouped.elFor('ov-group-all').innerHTML.match(/class="ov-groupcol"/g) || []).length, 2, 'clicking a rail brings the column back');
      assert.equal(Number(grouped.elFor('ov-gc-tasks').style['--ov-cw']), wT, '…at the width it had before it folded');
      // Double-click is the way back from a bad drag.
      grouped.fire(grouped.elFor('ov-cg-tasks'), 'dblclick', {});
      assert.equal(Number(grouped.elFor('ov-gc-workflows').style['--ov-cw']), 1, 'double-click splits that pair evenly again');
      assert.equal(Number(grouped.elFor('ov-gc-tasks').style['--ov-cw']), 1, '…on both sides');
      // And a reload comes back on the layout that was persisted.
      const reloaded = runOverview({ groupedNav: true, colC: { processes: 1 }, colW: { all: [1, 1, 1.7, 0.3, 1] } });
      reloaded.post(ovPayload(shells));
      assert.match(reloaded.elFor('ov-group-all').innerHTML, /class="ov-groupcol rail" id="ov-gc-processes"/, 'a reload restores the folded column');
      assert.equal(reloaded.elFor('ov-gc-workflows').style['--ov-cw'], '1.7', '…and the widths that went with it');
    }
    // 0.10.0: the Group-tabs toggle moved OUT of the top toolbar and onto the tab-strip row — the control
    // that rearranges the tabs belongs beside the tabs, not three rows away in a panel-wide toolbar.
    {
      const html = cmView.webview.html;
      const toolbarEnd = html.indexOf('<div class="ov">');
      const tabRow = html.indexOf('class="ov-navtabrow"');
      const groupnav = html.indexOf('id="ov-groupnav"');
      const ctl = html.indexOf('class="ov-ctl"');
      assert.ok(toolbarEnd > 0 && tabRow > toolbarEnd, 'the tab-strip row is below the toolbar');
      assert.ok(groupnav > tabRow && groupnav < ctl, 'the Group tabs toggle sits on that row, beside the tab strip');
      assert.ok(groupnav > toolbarEnd, '…and no longer inside the top toolbar');
      assert.ok(html.includes('title="Show every tab side by side in one group (Sessions · Workers · Workflows · Tasks · Processes)"'),
        'with the one-group title');
      assert.match(html, /groupedNav:GROUPNAV/, 'and its persisted state key unchanged');
    }
    // The toggle itself, with the copy the plan fixed on — a title that stops naming what it groups is a
    // control nobody can find.
    assert.ok(cmView.webview.html.includes('id="ov-groupnav"'), 'the Overview toolbar carries the grouping toggle');
    assert.ok(cmView.webview.html.includes('title="Show every tab side by side in one group (Sessions · Workers · Workflows · Tasks · Processes)"'),
      'and says exactly what it does');
    assert.ok(/id="ov-groupnav"[^>]*codicon-split-horizontal|codicon-split-horizontal/.test(cmView.webview.html), 'with the split-horizontal codicon');
    assert.match(fs.readFileSync(path.resolve(__dirname, '../src/codicon.ts'), 'utf8'), /codicon-split-horizontal:before/,
      'which is in the subsetted font — a non-whitelisted name renders a silent blank glyph');
    // …and the same check over EVERY name the extension writes, because that failure mode is invisible:
    // an unlisted codicon draws nothing at all — no error, no missing element, no build warning — so a
    // typo or a glyph added without touching the generator ships as a blank button. The per-glyph
    // assertions elsewhere in this file stay: the three names composed at runtime ('codicon-'+icon) are
    // unreachable from source text, so this sweep cannot see them.
    {
      const extSrc = fs.readFileSync(path.resolve(__dirname, '../src/extension.ts'), 'utf8');
      const styleSrc = fs.readFileSync(path.resolve(__dirname, '../src/codicon.ts'), 'utf8');
      const used = [...new Set([...extSrc.matchAll(/codicon-([a-z0-9-]+)/g)].map((m) => m[1]))];
      // The instrument first: a regex that silently matched nothing would report a clean font forever.
      assert.ok(used.includes('debug-step-back') && used.length >= 20,
        `the sweep found the glyph names it is meant to check (${used.length})`);
      assert.deepEqual(used.filter((n) => !styleSrc.includes('.codicon-' + n + ':before')), [],
        'every codicon the extension names is in the generated subset');
    }
    // Below the narrow breakpoint the columns STACK. Shrinking three columns into a side bar would clip
    // the names they exist to show, and this product never truncates content text.
    assert.match(cmView.webview.html, /@media \(max-width: 640px\)[\s\S]*\.ov-group \{ flex-direction:column; \}/,
      'the narrow layout stacks the group columns instead of squeezing them');
    assert.match(cmView.webview.html, /\.ov-groupcol \{[^}]*min-width:150px/, 'and each column has the same 150px floor the nav itself uses');

    // (3) THE PROMPT AXIS — the LAST axis on the review nav bar. Step/Review/Accept/Reject
    // affordances scoped to one of the user's own asks (the Subtask axis is gone in 0.8.8).
    for (const id of ['ov-promptprev', 'ov-promptcount', 'ov-promptnext', 'ov-reviewprompt', 'ov-acceptprompt', 'ov-rejectprompt']) {
      assert.ok(cmView.webview.html.includes(`id="${id}"`), `the review nav bar carries the Prompt-axis control ${id}`);
    }
    for (const gone of ['ov-chaptercount', 'ov-subtaskcount', 'ov-acceptchapter', 'ov-rejectchapter']) {
      assert.ok(!cmView.webview.html.includes(`id="${gone}"`), `the fifth axis is gone (${gone}) — four axes: Diff · File · Folder · Prompt`);
    }
    // The strict per-task ops must be REACHABLE, not merely registered: the Tasks rows post them.
    assert.ok(/data-tkeep/.test(cmView.webview.html) && /data-tundo/.test(cmView.webview.html) && /data-tclear/.test(cmView.webview.html),
      'Tasks tab: each row with edits offers Accept / Reject / Clear over its strict span');
    assert.ok(/type:'taskKeep'|type:msg/.test(cmView.webview.html), 'Tasks tab: the chips post the task ops to the host');
    assert.ok(/mt-tclrall/.test(cmView.webview.html), 'Tasks tab: a clear-resolved-in-completed-tasks affordance exists');
    assert.ok(/id="ov-promptcount"[^>]*>Prompt –\/–</.test(cmView.webview.html), 'the Prompt counter starts at –/– (no position is claimed before one is known)');
    assert.ok(/'Prompt '\+\(p\.prompt\.i\|\|'–'\)\+'\/'\+p\.prompt\.n/.test(cmView.webview.html) && /'\ · #'\+p\.prompt\.index/.test(cmView.webview.html),
      'the counter shows both the review position (i/n) and the ask’s OWN session number (#k) — they differ');
    // …and it routes to the host commands, which resolve the scope in core (never re-derived here).
    for (const [msg, cmd] of [
      ['navPromptPrev', 'claudeObservatory.navPromptPrev'],
      ['navPromptNext', 'claudeObservatory.navPromptNext'],
      ['reviewCurrentPrompt', 'claudeObservatory.reviewCurrentPrompt'],
      ['acceptCurrentPrompt', 'claudeObservatory.acceptCurrentPrompt'],
      ['rejectCurrentPrompt', 'claudeObservatory.rejectCurrentPrompt'],
    ]) {
      assert.ok(typeof commands[cmd] === 'function', `${cmd} registered`);
      let seen = 0;
      const real = commands[cmd];
      commands[cmd] = () => { seen++; };
      cmMsgHandler({ type: msg });
      commands[cmd] = real;
      assert.equal(seen, 1, `the Overview nav-bar "${msg}" control routes to ${cmd}`);
    }
    // the Prompts window's selected row drives the id-scoped ops directly (the same shape the task ops use).
    for (const [msg, cmd] of [
      ['promptKeep', 'claudeObservatory.promptKeep'],
      ['promptUndo', 'claudeObservatory.promptUndo'],
      ['promptClear', 'claudeObservatory.promptClear'],
      ['reviewPrompt', 'claudeObservatory.reviewPrompt'],
    ]) {
      assert.ok(typeof commands[cmd] === 'function', `${cmd} registered`);
      const seen = [];
      const real = commands[cmd];
      commands[cmd] = (id) => { seen.push(id); };
      cmMsgHandler({ type: msg, promptId: 'req7' });
      commands[cmd] = real;
      assert.deepEqual(seen, ['req7'], `a scoped ${msg} routes to ${cmd} with the prompt id`);
    }
    // The Prompts WINDOW fetches its own list (one spawn, its own visibility gate); the Overview does
    // NOT spawn `prompts --json` — the per-ask slices it filters by ride the changemap payload.
    assert.ok(/"prompts", "--json", "--session", session/.test(bundleSrc), 'the Prompts window fetches prompts --json for the active session');
    assert.ok(/rq = d && Array\.isArray\(d\.prompts\) && d\.summary \? d : null/.test(bundleSrc), 'a CLI that cannot answer prompts lands as null, not as a crash');
    assert.ok(/cm === void 0 \|\| mt === void 0 \|\| pr === void 0\)/.test(bundleSrc), 'the Overview paint waits for its three spawns (prompts is no longer one of them)');
    assert.ok(!/setInterval[^;]*prompts/.test(bundleSrc), 'the Prompts window adds no polling timer of its own');
    assert.ok(/"prompts", "--id", id, "--response", "--json", "--session", session/.test(bundleSrc),
      'a row expand fetches the agent’s reply via prompts --id --response --json');

    // 0.10.0: a prompt picked ON THE NAV BAR selects in the Prompts list too. Scoping the Overview and
    // leaving the list's own selection where it was left the two surfaces naming different asks — the
    // counter said one, the highlighted row said another.
    {
      // The push itself, the loop it must not start, and the same-id guard — which is only observable in
      // what reaches the WEBVIEW: `selection` reads the same either way, so asserting it alone would pass
      // with the guard deleted. Every prompt-scoped verb pushes the ask it resolved to, and refreshAll
      // runs on every store event, so an unguarded setSelection is a repaint per tick.
      let notified = 0;
      const realOnSelect = tlProvider.onSelect;
      tlProvider.onSelect = () => { notified++; };
      const pushed = [];
      const realPost = rqView.webview.postMessage;
      rqView.webview.postMessage = (m) => { pushed.push(m); return Promise.resolve(true); };
      try {
        tlProvider.setSelection('nav-picked');
        assert.equal(tlProvider.selection, 'nav-picked', 'a pick made outside the list becomes its selection');
        assert.equal(notified, 0, 'and does NOT notify back — that is the select → notify → select loop');
        assert.deepEqual(pushed.filter((m) => m.type === 'prompts').map((m) => m.selected), ['nav-picked'],
          '…and the list is told, so the highlighted row is the ask the nav bar picked');
        pushed.length = 0;
        tlProvider.setSelection('nav-picked');
        assert.equal(tlProvider.selection, 'nav-picked', 'setting the same id again is a no-op');
        assert.deepEqual(pushed, [], '…posting nothing: the same id must not repaint the list on every refresh');
        pushed.length = 0;
        tlProvider.setSelection(null);
        assert.deepEqual(pushed.filter((m) => m.type === 'prompts').map((m) => m.selected), [null],
          'clearing it IS a change, so that one does post');
      } finally {
        rqView.webview.postMessage = realPost;
        tlProvider.onSelect = realOnSelect;
      }
    }

    // the live position push: setNavPos posts a {navpos} message to a VISIBLE Overview so the counters update.
    assert.ok(typeof cmProvider.setNavPos === 'function', 'the Overview exposes setNavPos (the host pushes the live Diff/File position)');
    cmView.visible = true;
    const navPosMsgs = [];
    cmView.webview.postMessage = (m) => navPosMsgs.push(m);
    cmProvider.setNavPos({ diff: { i: 1, n: 3 }, file: { i: 2, n: 4 }, request: { i: 2, n: 5, index: 9, title: 'add the requests axis' } });
    cmView.visible = false;
    assert.ok(navPosMsgs.some((m) => m.type === 'navpos' && m.pos && m.pos.diff.n === 3 && m.pos.file.i === 2),
      'setNavPos pushes the Diff/File position to the visible Overview counters');
    assert.ok(navPosMsgs.some((m) => m.type === 'navpos' && m.pos && m.pos.request && m.pos.request.n === 5 && m.pos.request.index === 9),
      'setNavPos carries the Request-axis position too (review place i/n + the ask’s own number)');

    // 0.8.0 stabilization: the literal-tabs prototype (overviewTabs/OverviewTab) was superseded by the
    // Fleet/Workflows master–detail nav and removed — the export must stay gone (dead code guard).
    assert.equal(ext.overviewTabs, undefined, 'overviewTabs prototype removed — per-agent views are the Fleet nav rows');

    // 0.8.8: the display-subtask layer is gone entirely — strict per-task attribution only.
    assert.ok(!/label:'unassigned'/.test(cmView.webview.html), 'no "unassigned" ribbon row can render');
    assert.ok(!/w\.subtasks/.test(cmView.webview.html) && !/ch\.synthetic/.test(cmView.webview.html), 'no subtask reads remain in the webview');

    // Workflow auto-focus (0.8.0): a NEWLY-appeared running workflow switches the nav to Workflows,
    // selects it, and pulses its row; the FIRST payload only seeds the seen-set (no focus-steal on open).
    assert.ok(/SEEN_WF===null/.test(cmView.webview.html), 'first payload seeds the seen-set instead of stealing focus');
    assert.ok(/NAV='workflows'; SEL=\{kind:'workflow', id:freshWf\}/.test(cmView.webview.html), 'a new running workflow auto-focuses the Workflows nav + selects the run');
    assert.ok(/mt-wf\.flash/.test(cmView.webview.html), 'the new run pulses via the flash style');

    // multitaskFilter (unchanged, still exported): the ONE pure Active-only/Clear-completed filter the
    // Overview nav embeds verbatim. Driven off a fabricated payload — the webview runs this exact fn.
    assert.ok(typeof ext.multitaskFilter === 'function', 'multitaskFilter pure helper exported (unit-testable off the raw payload)');
    const mtPayload = {
      agents: [
        { session: 'aw', phase: 'working', subagents: [] }, // active (own phase)
        { session: 'ap', phase: 'awaiting-permission', subagents: [] }, // active (needs attention)
        { session: 'idleSub', phase: 'idle', subagents: [{ phase: 'working' }] }, // active via a live subagent
        { session: 'done1', phase: 'done', subagents: [] }, // completed
        { session: 'idle1', phase: 'idle', subagents: [{ phase: 'done' }] }, // completed
        { session: 'err1', phase: 'errored', subagents: [] }, // completed
      ],
      workflows: [{ id: 'wfRun', running: true }, { id: 'wfDone', running: false }],
    };
    const fAll = ext.multitaskFilter(mtPayload, {});
    assert.equal(fAll.agents.length, 6, 'no filter → every agent shows');
    assert.equal(fAll.workflows.length, 2, 'no filter → every workflow shows');
    assert.equal(fAll.activeAgents, 3, 'active = working + awaiting-permission + idle-with-a-live-subagent');
    assert.deepEqual(fAll.completedAgents.slice().sort(), ['done1', 'err1', 'idle1'], 'completed = idle/done/errored with no active subagent');
    assert.deepEqual(fAll.completedWorkflows, ['wfDone'], 'completed workflows = the non-running ones');
    const fActive = ext.multitaskFilter(mtPayload, { activeOnly: true });
    assert.deepEqual(fActive.agents.map((a) => a.session).slice().sort(), ['ap', 'aw', 'idleSub'], 'active-only keeps working/awaiting + agents with a live subagent, hides idle/done/errored');
    assert.deepEqual(fActive.workflows.map((w) => w.id), ['wfRun'], 'active-only keeps only running workflows');
    const dismissed = { dismissedAgents: { done1: 1, idle1: 1, err1: 1 }, dismissedWorkflows: { wfDone: 1 } };
    const fDismiss = ext.multitaskFilter(mtPayload, dismissed);
    assert.deepEqual(fDismiss.agents.map((a) => a.session).slice().sort(), ['ap', 'aw', 'idleSub'], 'Clear-completed hides the dismissed completed agents; actives remain');
    assert.equal(fDismiss.hiddenAgents, 3, 'the hidden-agent count feeds the "N hidden · show all" affordance');
    assert.deepEqual(fDismiss.workflows.map((w) => w.id), ['wfRun'], 'the dismissed finished workflow is hidden');
    assert.equal(fDismiss.hiddenWorkflows, 1, 'the hidden-workflow count is surfaced');
    // a dismissed item REAPPEARS the moment it goes active again (dismissal only bites while inactive).
    const revived = { agents: [{ session: 'done1', phase: 'working', subagents: [] }], workflows: [{ id: 'wfDone', running: true }] };
    const fRevive = ext.multitaskFilter(revived, dismissed);
    assert.equal(fRevive.agents.length, 1, 'a dismissed agent reappears once it is active again');
    assert.equal(fRevive.workflows.length, 1, 'a dismissed workflow reappears once it is running again');
    // The Workflows-tab cross-nav command is gone — selecting a workflow is now internal to the Overview.
    assert.ok(!commands['claudeObservatory.focusWorkflow'], 'focusWorkflow is gone (workflow selection is internal to the combined Overview)');

    // refreshAll refreshes the combined Overview + the Actions tab too — they ride the transcript watcher
    // for realtime updates (the Overview nav is live multi-agent state, mined from the transcript).
    let cmRefreshed = 0, actRefreshed = 0;
    const origCmRefresh = cmProvider.refresh.bind(cmProvider);
    const origActRefresh = actTree.refresh.bind(actTree);
    cmProvider.refresh = () => { cmRefreshed++; };
    actTree.refresh = () => { actRefreshed++; };
    await commands['claudeObservatory.refresh']();
    cmProvider.refresh = origCmRefresh;
    actTree.refresh = origActRefresh;
    assert.ok(cmRefreshed >= 1, 'refreshAll includes the combined Overview view');
    assert.ok(actRefreshed >= 1, 'refreshAll includes the Actions tab');

    // Dismissal retains the draft; it cannot submit or consume comments.
    assert.ok(typeof commands['claudeObservatory.chatAction'] === 'function');
    clipboardText = '';
    infoPick = undefined;
    const beforeDraft = infoMessages.length;
    await commands['claudeObservatory.chatAction']({ editId: 1 });
    assert.match(clipboardText, /app\.txt/);
    assert.ok(clipboardText.includes('AAA') && clipboardText.includes('a\nb\nc'));
    assert.ok(infoMessages.slice(beforeDraft).some(m => /Send it to this session/.test(typeof m === 'string' ? m : m.m)), 'explicit send is offered with a clipboard fallback');

    // Stats top navbar: active session + clickable pending count → first edit. (The Search-edits box
    // was removed in 0.7.5 — the Edits/Diffs title-bar `searchEdits` action is the one search entry.)
    assert.ok(!/id="nb-search"/.test(stView.webview.html), 'no search box in the Stats navbar');
    assert.match(stView.webview.html, /id="nb-session"/, 'stats navbar shows the active session');
    assert.match(stView.webview.html, /id="rv-pending-cell"/, 'the pending count is a clickable cell');
    assert.ok(typeof commands['claudeObservatory.reviewFirst'] === 'function', 'reviewFirst command registered');
    assert.ok(!commands['claudeObservatory.searchWith'], 'searchWith is gone — it existed only to drive the removed search box');
    // the counts post carries the session the navbar renders
    const nbMsgs = [];
    stView.webview.postMessage = (m) => nbMsgs.push(m);
    stProvider.refresh();
    assert.ok(nbMsgs.some((m) => m.type === 'counts' && m.session === S), 'counts post carries the active session');
    // …named the way every surface names it: a rename (custom-title) outranks Claude Code's own title.
    const txFile = path.join(proj, S + '.jsonl');
    const txBefore = fs.readFileSync(txFile);
    fs.appendFileSync(txFile, '\n' + JSON.stringify({ type: 'custom-title', customTitle: 'Renamed for review', sessionId: S }) + '\n'); // the fixture has no final newline
    nbMsgs.length = 0;
    stProvider.refresh();
    assert.ok(nbMsgs.some((m) => m.type === 'counts' && m.sessionTitle === 'Renamed for review'), 'the navbar names the session by its rename');
    fs.writeFileSync(txFile, txBefore);
    // The webview registers a handler for the one message it still sends (the pending cell → reviewFirst).
    // Deliberately not driven here: reviewFirst moves the review cursor, which later assertions depend on.
    assert.ok(typeof stMsgHandler === 'function', 'the stats webview registered a message handler');

    // BAR/BUBBLE PARITY, and parity with the JetBrains floating toolbar. The compact bar shipped
    // without Chat and Spotlight while JetBrains' bar had both (FloatingChat, FloatingSpotlight), and
    // JetBrains' bar shipped without the FILE axis while this one had it — each gap invisible from
    // inside the editor that had the feature.
    {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
      const bar = pkg.contributes.menus['comments/commentThread/title']
        .filter((m) => /claudeNavBar/.test(m.when || ''))
        .map((m) => m.command);
      for (const need of ['claudeObservatory.peekKeep', 'claudeObservatory.peekUndo',
        'claudeObservatory.peekPrev', 'claudeObservatory.peekNext',
        'claudeObservatory.peekPrevFile', 'claudeObservatory.peekNextFile',
        'claudeObservatory.peekViewDiff', 'claudeObservatory.peekChat',
        'claudeObservatory.toggleHeatmap', 'claudeObservatory.barDetails']) {
        assert.ok(bar.includes(need), `the compact review bar is missing ${need}`);
      }
    }

    // The status bar's 60-second usage poll claims the Remote Control titles refresh, in-host like the
    // account pull (the claim marker is the evidence; with no login in this HOME the refresh reads nothing).
    assert.ok(fs.existsSync(path.join(home, '.claude', 'claude-observatory', 'remote-cache', 'session-titles.json.kick')),
      'the status-bar poll claims a Remote Control titles refresh');

    // --- the usage readout: 5h · wk · mo, the PER-MODEL weekly cap in the tooltip only -------------
    // The account's scoped cap (its "Fable" row) is detail, not a window of the bar:
    // the status bar shows the three windows the TUI's one-line readout shows, and the cap stays named
    // in the tooltip, after the week it narrows, as it is in the Stats panel. The week keeps its own
    // countdown whether or not the cap reports the same reset.
    {
      const cache = path.join(home, '.claude', 'statusline-last.json');
      const sec = Math.floor(Date.now() / 1000);
      const weekReset = sec + 3 * 86400; // the account reports ONE instant for both weekly windows
      const month = { month_tok: 18_000_000, month_tok_total: 100_000_000, month_reset: sec + 19 * 86400 };
      const visibleUsage = (label) => statusBarItems.find((i) => i.visible && i.text.startsWith(label + ': '));
      // Left-to-right IS priority order, so the claude group is asserted as a sequence.
      const claudeSlots = () => statusBarItems
        .filter((i) => i.command === 'claudeObservatory.stats.focus' && i.priority > 4.6)
        .sort((a, b) => b.priority - a.priority);
      for (const fableReset of [weekReset, weekReset + 86400]) {
        fs.writeFileSync(cache, JSON.stringify({
          five_pct: 26, five_reset: sec + 3600, week_pct: 77, week_reset: weekReset, ...month,
          fable_pct: 93, fable_reset: fableReset, fable_label: 'Fable',
        }));
        await commands['claudeObservatory.usageRefresh']();
        const five = visibleUsage('5h'), wk = visibleUsage('wk'), mo = visibleUsage('mo');
        assert.ok(five && wk && mo, 'control: the claude windows render from this cache');
        assert.ok(!statusBarItems.some((i) => i.visible && /Fable|93%/.test(i.text)), 'the per-model cap is not a status-bar window');
        assert.match(wk.text, /^wk: 77% \d+d \d+h$/, 'the week keeps its own countdown');
        assert.match(five.text, /^5h: 26% \d+/, 'a window with its own reset keeps its countdown');
        assert.equal(claudeSlots().length, 4, 'the icon and THREE windows, with no slot for the cap');
        assert.deepEqual(claudeSlots().filter((i) => i.visible).map((i) => i.text.replace(/:.*$/, '')),
          ['\u2733', '5h', 'wk', 'mo'], 'left to right: the claude icon, then 5h · wk · mo');
        for (const item of [five, wk, mo]) {
          assert.match(String(item.tooltip), /\nwk 77% · resets in \d+d \d+h\nFable 93% · resets in \d+d \d+h\nmo 18% /,
            'the tooltip still names the cap and its reset, after the week it narrows');
        }
      }
      // An account that reports no scoped cap: the same three windows, and no cap line in the tooltip.
      fs.writeFileSync(cache, JSON.stringify({ five_pct: 26, five_reset: sec + 3600, week_pct: 77, week_reset: weekReset, ...month }));
      await commands['claudeObservatory.usageRefresh']();
      assert.match(visibleUsage('wk').text, /^wk: 77% \d+d \d+h$/, 'the week retains its countdown without a cap');
      assert.ok(visibleUsage('mo'), 'control: the month still renders');
      assert.doesNotMatch(String(visibleUsage('wk').tooltip), /Fable/, 'no cap reported, no cap line in the tooltip');
      // A quota-less plan (Enterprise/API) reports no window at all: the month slot carries the spend.
      fs.writeFileSync(cache, JSON.stringify({ month_cost: 42.5 }));
      await commands['claudeObservatory.usageRefresh']();
      assert.deepEqual(claudeSlots().filter((i) => i.visible).map((i) => i.text), ['\u2733', 'mo: ~$42.5'],
        'the spend takes the month slot and keeps the claude group visible');
      fs.rmSync(cache, { force: true });
    }

    // realtime observatory: status-bar microscope shows the pending count + the review scoreboard tooltip
    const microscope = statusBarItems.find((i) => /🔬/.test(i.text));
    assert.ok(microscope, 'status bar microscope present');
    assert.match(microscope.text, /2/, 'status bar shows 2 pending');
    assert.match(microscope.tooltip.value, /2 pending · 0 accepted · 0 reverted/, 'scoreboard lives in the microscope tooltip');
    // ONE MEANING FOR "PENDING", across every surface. The status bar and the activity-bar badge
    // counted RAW records while the Overview, the Sessions rows and the Stats scoreboard counted
    // collapsed review units — so one session read 3,067 in one place and 2,052 two panels away.
    // `keep`/`undo` resolve a whole same-code group, so the display units are the number of decisions.
    {
      const units = core.reviewEdits(S).filter((r) => r.status === 'pending').length;
      // This pins the SOURCE, not the collapse: this fixture's raw and collapsed counts happen to be
      // equal, so it cannot fail if the source regresses to the raw log. The collapse itself is
      // asserted where a fixture can force the two apart — core.test.js, "counts: pending means
      // DISPLAY units everywhere".
      assert.equal(Number((microscope.text.match(/(\d+)/) || [])[1]), units,
        'the status bar count agrees with the display units');
    }

    // --- nav bar: the two-tier review toolbar (Diff axis + File axis + per-edit / per-file actions) ---
    for (const c of ['claudeObservatory.navDiffPrev', 'claudeObservatory.navDiffNext',
      'claudeObservatory.navFilePrev', 'claudeObservatory.navFileNext',
      'claudeObservatory.navViewDiff', 'claudeObservatory.navKeep', 'claudeObservatory.navUndo']) {
      assert.ok(typeof commands[c] === 'function', `${c} registered`);
    }
    const diffCounter = statusBarItems.find((i) => /^Diff /.test(i.text));
    const fileCounter = statusBarItems.find((i) => /^File /.test(i.text));
    assert.equal(diffCounter && diffCounter.text, 'Diff 1/2', 'Diff axis: edit 1 of 2 in the active file');
    assert.equal(fileCounter && fileCounter.text, 'File 1/1', 'File axis: file 1 of 1 with pending edits');
    // Diff axis steps within the open file: #1 (line 0) → #2 (line 3) → back to #1.
    await commands['claudeObservatory.navDiffNext']();
    assert.equal(lastShown.selection.active.line, 3, 'navDiffNext reveals edit #2');
    assert.equal(diffCounter.text, 'Diff 2/2', 'Diff counter advanced to 2/2');
    await commands['claudeObservatory.navDiffPrev']();
    assert.equal(lastShown.selection.active.line, 0, 'navDiffPrev returns to edit #1');
    assert.equal(diffCounter.text, 'Diff 1/2', 'Diff counter back to 1/2');
    assert.ok(typeof commands['claudeObservatory.reviewNext'] === 'function', 'reviewNext registered');
    // reviewNext must step through EVERY pending edit, not always reopen the oldest: #1 (line 0) →
    // #2 (line 3) → wrap back to #1.
    await commands['claudeObservatory.reviewNext']();
    // `.path` (raw), not `.fsPath`: the faithful mock lower-cases the drive on Windows (#43).
    assert.ok(opened && opened.uri.path === F, 'reviewNext opened the file with the oldest pending edit');
    assert.equal(lastShown.selection.active.line, 0, 'first reviewNext lands on edit #1');
    await commands['claudeObservatory.reviewNext']();
    assert.equal(lastShown.selection.active.line, 3, 'second reviewNext advances to edit #2');
    await commands['claudeObservatory.reviewNext']();
    assert.equal(lastShown.selection.active.line, 0, 'third reviewNext wraps back to edit #1');
    // reviewPrev walks the other way: from #1 it wraps to #2, then back to #1.
    assert.ok(typeof commands['claudeObservatory.reviewPrev'] === 'function', 'reviewPrev registered');
    await commands['claudeObservatory.reviewPrev']();
    assert.equal(lastShown.selection.active.line, 3, 'reviewPrev steps back to edit #2');
    await commands['claudeObservatory.reviewPrev']();
    assert.equal(lastShown.selection.active.line, 0, 'reviewPrev steps back to edit #1');
    // Stats "pending count" click → reviewFirst jumps to the OLDEST pending edit regardless of the cursor.
    await commands['claudeObservatory.reviewNext'](); // move off the first edit (→ #2, line 3)
    assert.equal(lastShown.selection.active.line, 3, 'moved to edit #2 before testing reviewFirst');
    await commands['claudeObservatory.reviewFirst']();
    assert.equal(lastShown.selection.active.line, 0, 'reviewFirst jumps back to the oldest pending edit (#1)');
    opened = null;

    // N15: search used to filter the Edits tree; the command survives (porting its filter to the
    // Review list is an open follow-up recorded with the N15 work).
    assert.ok(typeof commands['claudeObservatory.searchEdits'] === 'function', 'searchEdits registered');

    // new commands exist
    for (const c of ['claudeObservatory.keepAll', 'claudeObservatory.undoAll', 'claudeObservatory.chatEdit',
      'claudeObservatory.showObservation', 'claudeObservatory.analyzeEdit', 'claudeObservatory.refreshRecap',
      'claudeObservatory.switchSession', 'claudeObservatory.exportSummary', 'claudeObservatory.doctor',
      'claudeObservatory.diffPrevRevision', 'claudeObservatory.diffNextRevision',
      'claudeObservatory.diffKeep', 'claudeObservatory.diffUndo', 'claudeObservatory.diffChat']) {
      assert.ok(typeof commands[c] === 'function', `${c} registered`);
    }

    // Setup Check runs doctor ASYNCHRONOUSLY. Doctor waits on every saved herdr machine in turn, and a
    // synchronous spawn froze the whole extension host for all of it. A slow fake doctor shows the host
    // keeps turning while it runs (POSIX only: the fake is a shell script).
    if (process.platform !== 'win32') {
      const slowDoctor = path.join(ws, 'slow-doctor');
      fs.writeFileSync(slowDoctor, '#!/bin/sh\nsleep 1\nprintf "# fake doctor report\\n"\nexit 1\n');
      fs.chmodSync(slowDoctor, 0o755);
      const realOpen = vscode.workspace.openTextDocument;
      const openedDocs = [];
      vscode.workspace.openTextDocument = (arg) => { openedDocs.push(arg); return realOpen(arg); };
      process.env.CLAUDE_OBSERVATORY_BIN = slowDoctor;
      try {
        const order = [];
        setTimeout(() => order.push('host turned'), 100);
        await commands['claudeObservatory.doctor']();
        order.push('doctor finished');
        assert.deepEqual(order, ['host turned', 'doctor finished'], 'the extension host keeps turning while doctor runs');
        assert.equal(openedDocs.at(-1)?.content, '# fake doctor report\n', '…and the report is opened although doctor exited 1 (a failed check)');
      } finally {
        vscode.workspace.openTextDocument = realOpen;
        process.env.CLAUDE_OBSERVATORY_BIN = TREE_OAK;
      }
    }

    // chat: copies a prompt (with the diff) to the clipboard
    await commands['claudeObservatory.chatEdit'](1);
    assert.match(clipboardText, /edit #1/, 'chat prompt names the edit');
    assert.ok(clipboardText.includes('AAA') && clipboardText.includes('a\nb\nc'), 'chat prompt carries before/after');
    // The draft is EDITABLE before it is sent, as JetBrains' dialog and the TUI's composer allow: "Edit
    // first…" opens it as a document, and Send takes what the document says then.
    {
      const realInfo = vscode.window.showInformationMessage;
      const realOpen = vscode.workspace.openTextDocument;
      const offered = [];
      let draftDoc = null;
      const picks = ['Edit first…', 'Send to agent'];
      vscode.window.showInformationMessage = (m, ...rest) => {
        const items = actionsOf(rest);
        offered.push(items);
        const next = picks.shift();
        return Promise.resolve(items.includes(next) ? next : undefined);
      };
      vscode.workspace.openTextDocument = (arg) => {
        draftDoc = { ...arg, text: arg.content + '\nOne more thing: keep the old name.', getText() { return this.text; } };
        return Promise.resolve(draftDoc);
      };
      try {
        await commands['claudeObservatory.chatEdit'](1);
      } finally {
        vscode.window.showInformationMessage = realInfo;
        vscode.workspace.openTextDocument = realOpen;
      }
      assert.deepEqual(offered[0], ['Send to agent', 'Edit first…'], 'the draft offers Send and Edit first…');
      assert.ok(draftDoc && /edit #1/.test(draftDoc.content), 'Edit first… opens the draft itself as a document');
      assert.deepEqual(offered[1], ['Send to agent'], '…and Send is offered again once it has been edited');
      assert.match(clipboardText, /One more thing: keep the old name\.$/, 'what goes out (and stays on the clipboard) is the EDITED draft');
    }

    // openFileAtEdit opens the real file
    await commands['claudeObservatory.openFileAtEdit']({ kind: 'edit', rec: core.findRecord(S, 1) });
    assert.ok(opened && opened.uri.path === F, 'openFileAtEdit opened the file');

    // diff still works (Diffs view / inline)
    await commands['claudeObservatory.openDiff']({ kind: 'edit', rec: core.findRecord(S, 1) });
    assert.equal(diffCalls.length, 1);
    const [left, right] = diffCalls[0];
    assert.equal(left.scheme, 'claude-edit');
    assert.equal(contentProviders['claude-edit'].provideTextDocumentContent(left), 'a\nb\nc\nd\n');
    assert.equal(contentProviders['claude-edit'].provideTextDocumentContent(right), 'AAA\nb\nc\nd\n');
    // the diff URIs carry the edit id so the diff's title-bar actions can resolve it
    assert.equal(new URLSearchParams(right.query).get('e'), '1', 'diff URI carries the edit id');
    clipboardText = '';
    await commands['claudeObservatory.diffChat'](right); // title-bar action gets the modified URI
    assert.match(clipboardText, /edit #1/, 'a diff title-bar action resolves the edit id from the diff URI');

    // revision navigation: step to the newest revision → a current-vs-revision diff (recorded blob ⟶ live file)
    await commands['claudeObservatory.diffNextRevision']();
    const revCall = diffCalls.find((c) => /⟶ \(this file\)/.test(c[2]));
    assert.ok(revCall, 'revision nav opens an "edit #N ⟶ (this file)" diff');
    assert.equal(revCall[0].scheme, 'claude-edit', 'revision diff LEFT is the recorded blob');
    assert.equal(revCall[1].scheme, 'file', 'revision diff RIGHT is the live current file');

    // keyboard review loop: keep the edit under the cursor (edit #2 lives on line 3, 'ZZZ')
    mockEditor.selection = new Selection(new Position(3, 0), new Position(3, 0));
    await commands['claudeObservatory.keepAtCursor']();
    assert.equal(core.findRecord(S, 2).status, 'kept', 'keepAtCursor kept the edit under the cursor');
    assert.ok(typeof commands['claudeObservatory.undoAtCursor'] === 'function', 'undoAtCursor registered');

    // The dirty-buffer guard must BLOCK the undo while the file has unsaved changes — and on
    // windows-latest the faithful Uri mock lower-cases the drive, so this exercises the #43
    // canonFsPath boundary the guard depends on (pre-fix it failed OPEN on Windows).
    vscode.workspace.textDocuments.push({ uri: Uri.file(F), isDirty: true });
    const warnsBefore = warnMessages.length;
    await commands['claudeObservatory.undo']({ kind: 'edit', rec: core.findRecord(S, 1) });
    assert.ok(
      warnMessages.length > warnsBefore && /unsaved changes/.test(warnMessages[warnMessages.length - 1]),
      'a dirty buffer blocks the undo with a warning'
    );
    assert.equal(core.findRecord(S, 1).status, 'pending', 'the record is untouched while the buffer is dirty');
    vscode.workspace.textDocuments.pop();

    await commands['claudeObservatory.undo']({ kind: 'edit', rec: core.findRecord(S, 1) });
    const after = fs.readFileSync(F, 'utf8');
    assert.ok(after.startsWith('a\n'), 'top reverted');
    assert.ok(after.includes('ZZZ'), 'later edit preserved');
    assert.equal(core.findRecord(S, 1).status, 'undone');
    assert.equal(
      decoProvider.provideFileDecoration({ scheme: 'claude-change', query: 'status=pending' }),
      undefined,
      'pending row not greyed'
    );

    // review memory: after the keep + undo above, the per-edit observation row carries the file's history.
    // The two app.txt edits still coalesce into one ×2 run — expand it to reach edit #1's row.
    const obsRunAfter = obsTree.getChildren().find((n) => n.kind === 'tlrun');
    const editRows = obsRunAfter ? obsTree.getChildren(obsRunAfter) : obsTree.getChildren().filter((n) => n.kind === 'edit');
    const memTip = obsTree.getTreeItem(editRows.find((n) => n.rec.id === 1)).tooltip;
    assert.match(memTip, /🧠 2 edits across sessions · 50% accepted/, 'observation tooltip carries cross-session file memory');
    const memMd = contentProviders['claude-observation'].provideTextDocumentContent({ authority: 'obs', path: '/edit-1.md', query: 's=' + S });
    assert.match(memMd, /## File history \(all sessions\)/, 'combined report has a File history section');

    // file-scoped accept: keepOpenFile (active editor = app.txt) touches ONLY that file's pending edits.
    const G = path.join(ws, 'other.txt');
    const fb = core.writeBlob(S, Buffer.from('p\n')), fa = core.writeBlob(S, Buffer.from('p\nq\n'));
    // appendLog now OWNS id allocation (S1) — capture the id it assigns instead of hardcoding one.
    const rF = core.appendLog(S, { ts: 9800, tool: 'Edit', file: F, beforeBlob: fb, afterBlob: fa, status: 'pending' });
    const gb = core.writeBlob(S, Buffer.from('x\n')), ga = core.writeBlob(S, Buffer.from('x\ny\n'));
    const rG = core.appendLog(S, { ts: 9900, tool: 'Edit', file: G, beforeBlob: gb, afterBlob: ga, status: 'pending' });
    assert.ok(typeof commands['claudeObservatory.keepOpenFile'] === 'function', 'keepOpenFile registered');
    await commands['claudeObservatory.keepOpenFile'](); // active editor's file is app.txt (F)
    const flog = core.readLog(S);
    assert.equal(flog.find((r) => r.id === rF.id).status, 'kept', 'keepOpenFile accepted the active file (app.txt)');
    assert.equal(flog.find((r) => r.id === rG.id).status, 'pending', 'keepOpenFile left the other file (other.txt) untouched');

    // The mock's own contract, pinned. Both overloads of show*Message must hand back the FIRST action;
    // getting this wrong makes the code under test take a branch it never asked for, and only on the
    // paths a local run happens not to exercise.
    assert.equal(await vscode.window.showWarningMessage('probe', 'First', 'Second'), 'First', 'positional-items overload returns the first action');
    assert.equal(await vscode.window.showWarningMessage('probe', { modal: true }, 'First', 'Second'), 'First', 'options-object overload returns the first action too');
    assert.deepEqual(await vscode.window.showWarningMessage('probe', { title: 'First' }, { title: 'Second' }), { title: 'First' }, 'a MessageItem action is an action, not an options object');

    // --- demo mode + the guided tour (0.8.9) ---
    // Re-point the Overview's sink: the nav-position block above claimed it, and the tour's messages to
    // this panel (tab, ring, show-all) are what the rest of this section asserts on.
    const cmTourMsgs = [];
    cmView.webview.postMessage = (m) => cmTourMsgs.push(m);
    // The install/update offer must NEVER fire in an automated run. Its guard is that
    // `context.extension` is absent under this mock — the same guard checkForUpdate already relies on —
    // so if it ever fires here it would also fire in every CI job and every headless host.
    assert.equal(infoMessages.filter((m) => /OAK is (installed|now )/.test(m)).length, 0, 'the first-run offer stays out of automated runs');

    for (const c of ['startDemo', 'restartDemo', 'startTour', 'tourNext', 'tourBack', 'tourGoto', 'exitDemo']) {
      assert.ok(typeof commands[`claudeObservatory.${c}`] === 'function', `${c} registered`);
    }
    // The tour is a detachable webview PANEL, not a sidebar view: a sidebar slot would sit in the very
    // container whose other views the tour keeps asking you to look at.
    assert.ok(!webviewProviders['claudeObservatory.tour'], 'the tour is not a sidebar view');
    assert.ok(!pkg.contributes.views.claudeObservatory.some((v) => v.id === 'claudeObservatory.tour'), 'and is not contributed as one');
    // The in-panel tip strip was removed: the step's text belongs in the tour, and repeating it inside
    // every panel cost vertical space in each of them to say the same sentence twice.
    assert.ok(!fs.readFileSync(BUNDLE, 'utf8').includes('ov-tourtip'), 'the in-panel tip strip is gone and stays gone');
    for (const id of ['id="count"', 'id="title"', 'id="body"', 'id="tip"', 'id="next"', 'id="back"', 'id="dock"', 'id="exit"', 'id="dots"', 'id="action"', 'id="actionlabel"', 'id="actionstate"']) {
      assert.ok(fs.readFileSync(BUNDLE, 'utf8').includes(id), `the tour panel renders ${id}`);
    }
    // Stats and Prompts ring their own controls now: an anchor is BROADCAST to every tour-aware panel
    // and each rings it only if its own map knows the name. Routing by view instead would send a
    // Stats-local anchor to the Overview, which rings nothing and reads as broken.
    for (const id of ['id="tk-sec"', 'id="usage-sec"', 'id="rv-sec"', 'TOUR_ANCHORS', "'stats-model'", "'prompts-list'"]) {
      assert.ok(fs.readFileSync(BUNDLE, 'utf8').includes(id), `the Stats/Prompts shells carry ${id}`);
    }

    // The Overview handles the tour message (tab + in-panel tip + the ring on the named control).
    const cmHtml = webviewProviders['claudeObservatory.changemap'];
    assert.ok(cmHtml, 'the Overview view is registered');

    // Replay, cancelled at the first beat: exercises the command, the progress wiring, the shouldStop
    // plumbing and the session override without paying for a ~17s paced run.
    progressCancelled = true;
    const cfgBefore = configWrites.length;
    await commands['claudeObservatory.startDemo']();
    // Stopping at the first beat is stopping BEFORE the first capture, so there are no store records —
    // what must exist is the seeded workspace, which is the thing Exit has to be able to reclaim.
    assert.ok(fs.existsSync(path.join(ws, 'observatory-demo', '.observatory-demo')), 'the demo workspace is seeded and marked');
    assert.equal(core.listSessions().filter((s) => core.isDemoSession(s.id)).length, 0, 'a replay stopped at beat one captured nothing');
    assert.deepEqual(
      configWrites.slice(cfgBefore).filter(([k]) => k === 'session'),
      [],
      'demo mode never writes claudeObservatory.session — that would dirty .vscode/settings.json in the user repo'
    );
    // A stopped replay deliberately does NOT open the tour — there would be nothing to tour.
    assert.equal(webviewPanels.length, 0, 'a cancelled replay does not open a tour');
    // …and neither does the tour COMMAND, because there is no demo session for it to act on. The tour
    // accepts and reverts edits, some of them on a nine-second timer, so it may only ever run against
    // the demo — a guard that has to hold whichever route reached it, not only the button.
    quickPick = 1; // "Everything"
    await commands['claudeObservatory.startTour']();
    assert.equal(webviewPanels.length, 0, 'the tour refuses to open with no demo session to act on');
    assert.match(
      warnMessages[warnMessages.length - 1] || '',
      /guided tour runs against the demo session/i,
      'and says why rather than opening onto a real session'
    );

    // Record a real one, unpaced, so the tour below walks a store with actual records in it.
    await core.runDemo({ cwd: ws, fast: true, fleet: false });
    quickPick = 1; // "Everything"
    await commands['claudeObservatory.startTour']();
    assert.equal(webviewPanels.length, 1, 'the tour opened as a webview panel, not a sidebar view');
    const tourView = webviewPanels[0];
    assert.match(tourView.title, /guided tour/i);
    const live = () => webviewPanels[webviewPanels.length - 1];
    // The tour panel got a step, and it is core's first step rather than one invented here.
    const stepMsgs = tourView.webview.posts.filter((m) => m.type === 'step');
    assert.ok(stepMsgs.length >= 1, 'the tour opened on a step');
    assert.equal(stepMsgs[stepMsgs.length - 1].step.id, core.demoTour()[0].id, 'and it is core’s script, not a local copy');
    assert.equal(stepMsgs[stepMsgs.length - 1].n, core.demoTour().length, 'with the full step count for its progress readout');
    // It plays by DEFAULT, and says how long the step has rather than moving without warning. Asserted
    // here, before any navigation: every manual control pauses, so this is the only moment it holds.
    const firstAuto = tourView.webview.posts.filter((m) => m.type === 'auto');
    assert.ok(firstAuto.length > 0, 'the tour reports its autoplay state');
    assert.equal(firstAuto[0].playing, true, 'and it plays by default');
    assert.ok(firstAuto[0].secs > 0, 'with seconds left on this step');
    await commands['claudeObservatory.tourNext']();
    assert.equal(tourView.webview.posts.filter((m) => m.type === 'step').pop().i, 1, 'Next advances a step');
    await commands['claudeObservatory.tourBack']();
    assert.equal(tourView.webview.posts.filter((m) => m.type === 'step').pop().i, 0, 'Back returns to the previous one');

    // --- the two views that became TABS -------------------------------------------------------------
    // Core's `view` set is closed and not ours to extend, so the `actions` and `observations` steps still
    // exist — they must now reveal the Timeline and bring the right TAB forward instead of revealing a
    // view that no longer exists. A step that silently landed nowhere would leave the reader staring at
    // whatever panel happened to be open while the text described another.
    for (const want of ['actions', 'observations', 'prompts']) {
      const idx = core.demoTour().findIndex((x) => x.view === want);
      assert.ok(idx >= 0, `core's script has a ${want} step to land`);
      const focused = [];
      const tabbed = [];
      const realFocus = commands['claudeObservatory.timeline.focus'];
      commands['claudeObservatory.timeline.focus'] = () => { focused.push(1); };
      const realTab = tlProvider.setTab.bind(tlProvider);
      tlProvider.setTab = (t) => { tabbed.push(t); };
      await commands['claudeObservatory.tourGoto'](idx);
      tlProvider.setTab = realTab;
      if (realFocus === undefined) delete commands['claudeObservatory.timeline.focus']; else commands['claudeObservatory.timeline.focus'] = realFocus;
      assert.deepEqual(focused, [1], `a ${want} step reveals the Timeline window`);
      assert.deepEqual(tabbed, [want], `…on the ${want} tab`);
    }
    // …and the views they used to be are gone from the tour's tree map, so nothing can still try to
    // reveal them.
    {
      const src = fs.readFileSync(path.resolve(__dirname, '../src/extension.ts'), 'utf8');
      const map = /const TOUR_TREES[^=]*=\s*\{([\s\S]*?)\};/.exec(src);
      assert.ok(map, 'the tour tree map is findable');
      assert.ok(!/actions|observations/.test(map[1]), 'the tour no longer reveals Actions/Observations as views');
    }

    // --- action steps: the wait/auto state machine, driven end to end ---
    // Arm a wait step, mutate the store the way a reader would, and assert the tour notices. This is
    // the whole interactive feature; nothing else in the suite covers it.
    const waitStep = core.demoTour().findIndex((x) => x.action?.mode === 'wait');
    assert.ok(waitStep >= 0, 'the script has a wait step to drive');
    await commands['claudeObservatory.tourGoto'](waitStep);
    const armed = live().webview.posts.filter((m) => m.type === 'step').pop();
    assert.equal(armed.actionState, 'waiting', 'a wait step arms as waiting');
    // Mutate the DEMO session — the one the tour pinned. The watch is keyed to that session precisely so
    // a count taken against one log is never compared with a count taken against another.
    const demoS = core.demoSessionsFor({ cwd: ws })[0];
    assert.ok(demoS, 'the replay left a demo session for the tour to act on');
    const pend = core.readLog(demoS).find((r) => r.status === 'pending');
    core.setStatus(demoS, pend.id, core.demoTour()[waitStep].action.kind === 'undo-edit' ? 'undone' : 'kept');
    await commands['claudeObservatory.refresh']();
    assert.equal(live().webview.posts.filter((m) => m.type === 'action').pop().state, 'satisfied', 'and notices when the reader does it');

    // --- autoplay ---
    const autoPosts = () => live().webview.posts.filter((m) => m.type === 'auto');
    // Any manual control hands over the wheel — the rule both of the site's demo engines use.
    await commands['claudeObservatory.tourNext']();
    assert.equal(autoPosts().pop().playing, false, 'Next pauses autoplay');
    await commands['claudeObservatory.tourBack']();
    assert.equal(autoPosts().pop().playing, false, 'and it stays paused');
    await commands['claudeObservatory.tourPlayPause']();
    assert.equal(autoPosts().pop().playing, true, 'the transport resumes it');
    await commands['claudeObservatory.tourPlayPause']();
    assert.equal(autoPosts().pop().playing, false, 'and pauses it again');

    // A WAIT step under autoplay really performs its action rather than skipping it — a reader who
    // only watches still sees Keep happen. Assert the STORE changed, not merely that a message flew.
    // Earlier assertions resolved everything, so seed a pending edit — otherwise the step correctly
    // reports there is nothing left to accept rather than accepting something.
    const ab = core.writeBlob(demoS, Buffer.from('a\n'));
    const aa = core.writeBlob(demoS, Buffer.from('a\nb\n'));
    core.appendLog(demoS, { ts: 9950, tool: 'Edit', file: F, beforeBlob: ab, afterBlob: aa, status: 'pending' });
    const keepStep = core.demoTour().findIndex((x) => x.action?.kind === 'keep-edit');
    await commands['claudeObservatory.tourGoto'](keepStep);
    const keptBefore = core.readLog(demoS).filter((r) => r.status === 'kept').length;
    await commands['claudeObservatory.tourPlayPause'](); // resume: arms the countdown
    await new Promise((r) => setTimeout(r, core.DEMO_ACTION_COUNTDOWN_MS + 600));
    assert.ok(core.readLog(demoS).filter((r) => r.status === 'kept').length > keptBefore, 'an unanswered ask applies itself rather than being skipped');
    // …and it advances exactly ONE step. Performing the action refreshes, which makes the watcher arm a
    // beat of its own — so two timers are in flight for the same moment. They are guarded today, but the
    // guards are what make that safe, and this pins the outcome rather than the guards.
    await new Promise((r) => setTimeout(r, 2200));
    const landed = live().webview.posts.filter((m) => m.type === 'step').pop().i;
    assert.equal(landed, keepStep + 1, 'the tour moved on by one, not two');
    await commands['claudeObservatory.tourPlayPause'](); // pause again so the rest of the test is stable

    // …and the other shape: with nothing pending, the step reports it instead of hanging.
    for (const r of core.readLog(demoS)) if (r.status === 'pending') core.setStatus(demoS, r.id, 'kept');
    await commands['claudeObservatory.tourGoto'](keepStep);
    assert.equal(
      live().webview.posts.filter((m) => m.type === 'step').pop().actionState,
      'vacated',
      'nothing left to accept is reported, not waited on'
    );

    // Moving on DISARMS: a later mutation must post nothing, or every step leaks a watcher.
    const plain = core.demoTour().findIndex((x) => !x.action);
    await commands['claudeObservatory.tourGoto'](plain);
    const actionsBefore = live().webview.posts.filter((m) => m.type === 'action').length;
    const pend2 = core.readLog(demoS).find((r) => r.status === 'pending');
    if (pend2) core.setStatus(demoS, pend2.id, 'kept');
    await commands['claudeObservatory.refresh']();
    assert.equal(live().webview.posts.filter((m) => m.type === 'action').length, actionsBefore, 'a step with no action watches nothing');

    // Floating is the default, and the choice is remembered for next time rather than re-asked.
    assert.equal(live().webview.posts.filter((m) => m.type === 'step').pop().docked, true, 'the tour is docked by default');
    await commands['claudeObservatory.tourFloat']();
    const floated = webviewPanels[webviewPanels.length - 1];
    assert.equal(floated.webview.posts.filter((m) => m.type === 'step').pop().docked, false, 'and it reports itself floating');
    // Stepping BETWEEN the toggles is the regression: setDocked disposes the panel to rebuild it, and
    // without a guard that dispose fires tourClosed -> endTour, leaving Next/Back dead.
    await commands['claudeObservatory.tourNext']();
    assert.ok(live().webview.posts.filter((m) => m.type === 'step').length > 0, 'the tour still steps after a float');
    await commands['claudeObservatory.tourDock']();
    await commands['claudeObservatory.tourNext']();
    const afterToggles = live().webview.posts.filter((m) => m.type === 'step').pop();
    assert.ok(afterToggles, 'and still steps after docking again — the toggle did not end the tour');

    // An AUTO step that could not run must not claim it did. Resolve everything the demo has, then land
    // on the accept-a-task step: with nothing pending there is no task to accept, and "✓ done" over a
    // screen where nothing moved is the exact failure this reports instead.
    for (const r of core.readLog(demoS)) if (r.status === 'pending') core.setStatus(demoS, r.id, 'kept');
    const autoStep = core.demoTour().findIndex((x) => x.action?.mode === 'auto' && x.action.kind === 'keep-task');
    await commands['claudeObservatory.tourGoto'](autoStep);
    assert.equal(
      live().webview.posts.filter((m) => m.type === 'step').pop().actionState,
      'vacated',
      'an auto step that did nothing says so rather than reporting done'
    );

    // Docking carries the action state across. Dropping it re-rendered a satisfied step as "waiting" —
    // invisible in a screenshot, and exactly the kind of thing only a state assertion catches.
    await commands['claudeObservatory.tourFloat']();
    await commands['claudeObservatory.tourDock']();
    assert.equal(
      live().webview.posts.filter((m) => m.type === 'step').pop().actionState,
      'vacated',
      'and the state survives a dock/float rebuild'
    );

    // The Overview's Active-only filter is held open for the tour, and handed back when it ends: the
    // demo leaves five of six tasks completed, which that filter hides.
    const showAlls = () => cmTourMsgs.filter((m) => m.type === 'showall');
    assert.equal(showAlls().at(-1)?.on, true, 'a running tour asks the Overview to show every row');

    // The short track is the same script, filtered — and choosing it really shortens the tour.
    // End the TOUR, not the demo: the demo has to survive, because the tour refuses to open without one.
    await commands['claudeObservatory.tourClosed']();
    quickPick = 0; // "Essentials"
    await commands['claudeObservatory.startTour']();
    const shortPanel = webviewPanels[webviewPanels.length - 1];
    const shortN = shortPanel.webview.posts.filter((m) => m.type === 'step').pop().n;
    assert.equal(shortN, core.demoTrackSizes().essentials, 'the short track walks the essential steps');
    assert.ok(shortN < core.demoTrackSizes().everything, 'and it is genuinely shorter');
    // Dismissing the chooser opens nothing at all.
    await commands['claudeObservatory.tourClosed']();
    const before = webviewPanels.length;
    quickPick = null;
    await commands['claudeObservatory.startTour']();
    assert.equal(webviewPanels.length, before, 'a dismissed chooser leaves no half-opened tour');
    quickPick = 1;
    await commands['claudeObservatory.startTour']();

    // Walk EVERY step. Each one activates a different view and, for the Overview, a different tab; a
    // branch that throws (an unknown view, an editor step with nothing pending, a provider that is not
    // resolved) would otherwise only show up when a reader reached that step in a real session.
    const tour = core.demoTour();
    for (let i = 0; i < tour.length; i++) {
      await commands['claudeObservatory.tourGoto'](i);
      const posted = live().webview.posts.filter((m) => m.type === 'step').pop();
      assert.equal(posted.i, i, `step ${i} (${tour[i].id}) posts its own index`);
      assert.equal(posted.step.id, tour[i].id, `step ${i} posts core's step, unchanged`);
    }
    // Past the end finishes the tour rather than throwing or wrapping.
    await commands['claudeObservatory.tourGoto'](tour.length - 1);
    const lastPanel = live();
    await commands['claudeObservatory.tourNext']();
    assert.equal(lastPanel.webview.posts.filter((m) => m.type === 'step').pop().i, tour.length - 1, 'Next on the last step ends the tour, leaving it on the last step');
    assert.ok(lastPanel.disposed, 'and the tour window closes with it');

    // …and hands the filter back the moment it ends, rather than leaving the reader's Overview changed.
    await commands['claudeObservatory.tourClosed']();
    assert.equal(showAlls().at(-1)?.on, false, 'and gives the filter back when the tour ends');

    // Finishing the SHORT track offers the other 28 rather than just closing — the only place a reader
    // who picked Essentials is told the rest exists.
    quickPick = 0; // "Essentials"
    await commands['claudeObservatory.startTour']();
    const shortTour = core.demoTour('essentials');
    await commands['claudeObservatory.tourGoto'](shortTour.length - 1);
    const infoBefore = infoMessages.length;
    infoPick = `See the other ${core.demoTrackSizes().remainder}`;
    await commands['claudeObservatory.tourNext']();
    assert.ok(
      infoMessages.slice(infoBefore).some((m) => /short track/i.test(m)),
      'the end of the short track offers the remainder'
    );
    const contd = live().webview.posts.filter((m) => m.type === 'step').pop();
    assert.equal(contd.n, core.demoTrackSizes().remainder, 'and accepting walks exactly the complement');
    assert.equal(contd.step.id, core.demoTour('remainder')[0].id, 'starting at its first step');
    infoPick = undefined;

    // Exit removes every trace — and still writes nothing to settings.
    // A demo file left open is the failure that makes the demo folder UNREMOVABLE: saving that buffer
    // after the folder is deleted recreates a file inside it, and the `.observatory-demo` sentinel that
    // authorizes deletion went with the tree. The tour deliberately opens one, so Exit closes them.
    const demoTab = { input: { uri: Uri.file(path.join(ws, 'observatory-demo', 'src', 'features.py')) } };
    const otherTab = { input: { uri: Uri.file(path.join(ws, 'app.txt')) } };
    openTabs.push(demoTab, otherTab);
    const cfgBeforeExit = configWrites.length;
    await commands['claudeObservatory.exitDemo']();
    assert.ok(!openTabs.includes(demoTab), 'exitDemo closes editors on demo files before deleting them');
    assert.ok(openTabs.includes(otherTab), 'and leaves the user’s own files open');
    assert.equal(core.listSessions().filter((s) => core.isDemoSession(s.id)).length, 0, 'exitDemo removed the demo session(s)');
    assert.ok(!fs.existsSync(path.join(ws, 'observatory-demo')), 'and the demo workspace folder');
    assert.deepEqual(configWrites.slice(cfgBeforeExit).filter(([k]) => k === 'session'), [], 'exitDemo writes no config either');
    progressCancelled = false;

    // ---- 0.10.0: the review bar's follow behaviour, auto-advance, and the Explorer badge -------------
    // A fresh two-file, two-edit session, because everything above has resolved the original fixture's
    // edits and "carry me to the next PENDING edit" needs two of them, in different files, to be a claim
    // about anything at all.
    const RS = 'reviewFollow';
    const RA = path.join(ws, 'follow-a.txt');
    const RB = path.join(ws, 'follow-b.txt');
    fs.writeFileSync(RA, 'A1\n');
    fs.writeFileSync(RB, 'B1\n');
    core.ensureStore(RS);
    const rb1 = core.writeBlob(RS, Buffer.from('A0\n'));
    const ra1 = core.writeBlob(RS, Buffer.from('A1\n'));
    core.appendLog(RS, { id: 1, ts: 1000, tool: 'Edit', file: RA, beforeBlob: rb1, afterBlob: ra1, status: 'pending' });
    const rb2 = core.writeBlob(RS, Buffer.from('B0\n'));
    const ra2 = core.writeBlob(RS, Buffer.from('B1\n'));
    core.appendLog(RS, { id: 2, ts: 2000, tool: 'Edit', file: RB, beforeBlob: rb2, afterBlob: ra2, status: 'pending' });
    configValues['session'] = RS;
    await commands['claudeObservatory.refresh']?.();

    // Auto-advance ON (its default): resolving edit #1 reveals edit #2 — in the OTHER file.
    opened = undefined;
    configValues['revealNextOnResolve'] = true;
    await commands['claudeObservatory.inlineKeep'](1);
    assert.equal(core.findRecord(RS, 1).status, 'kept', 'inlineKeep keeps the edit it was given');
    // canonPath both sides: on Windows the extension canonicalizes the drive letter to uppercase (#43)
    // while the temp path this fixture built keeps whatever case the OS handed back, so a raw compare
    // passes on macOS and fails on Windows for a product that is behaving correctly.
    assert.equal(
      core.canonPath(opened?.uri?.fsPath ?? ''),
      core.canonPath(RB),
      'and with revealNextOnResolve on, the next pending edit is revealed — across the file boundary'
    );

    // …and OFF, it resolves without moving the reader. This is the assertion the old mock could not make:
    // it returned the caller's default, so the "off" path was never actually exercised.
    opened = undefined;
    configValues['revealNextOnResolve'] = false;
    await commands['claudeObservatory.inlineKeep'](2);
    assert.equal(core.findRecord(RS, 2).status, 'kept', 'the edit is still kept');
    assert.equal(opened, undefined, 'but nothing is revealed when the setting is off');

    // The diff editor's own Keep opts out regardless of the setting — a diff tab is a viewer the reader
    // opened deliberately, and revealing something else behind it would be worse than doing nothing.
    core.appendLog(RS, { id: 3, ts: 3000, tool: 'Edit', file: RA, beforeBlob: ra1, afterBlob: core.writeBlob(RS, Buffer.from('A2\n')), status: 'pending' });
    core.appendLog(RS, { id: 4, ts: 4000, tool: 'Edit', file: RB, beforeBlob: ra2, afterBlob: core.writeBlob(RS, Buffer.from('B2\n')), status: 'pending' });
    opened = undefined;
    configValues['revealNextOnResolve'] = true;
    await commands['claudeObservatory.inlineKeep'](3, { advance: false });
    assert.equal(core.findRecord(RS, 3).status, 'kept', 'the diff-bar path still resolves the edit');
    assert.equal(opened, undefined, 'but it never navigates away from the diff the reader is reading');

    // The review bubble: PINNED it carries itself to the next edit; unpinned it closes, as it always has.
    const threadsBefore = commentThreads.length;
    configValues['pinnedPeek'] = true;
    await commands['claudeObservatory.viewChanges'](4);
    const opening = commentThreads.length;
    assert.ok(opening > threadsBefore, 'viewChanges opens the bubble');
    core.appendLog(RS, { id: 5, ts: 5000, tool: 'Edit', file: RA, beforeBlob: core.readLog(RS).find((r) => r.id === 3).afterBlob, afterBlob: core.writeBlob(RS, Buffer.from('A3\n')), status: 'pending' });
    // Precondition: without a SECOND pending edit there is no "next" to follow to, and the assertion
    // below would pass against a bubble that simply closed.
    assert.deepEqual(core.readLog(RS).filter((r) => r.status === 'pending').map((r) => r.id), [4, 5], 'two pending edits, so following is a claim about something');
    await commands['claudeObservatory.peekKeep']();
    assert.equal(core.findRecord(RS, 4).status, 'kept', 'a pinned Keep still keeps');
    assert.ok(commentThreads.length > opening, 'and the pinned bubble re-opens on the next pending edit instead of closing');
    assert.ok(commentThreads[opening - 1].disposed, 'the previous thread is disposed, so only one bubble is ever live');

    configValues['pinnedPeek'] = false;
    const beforeUnpinned = commentThreads.length;
    await commands['claudeObservatory.peekKeep']();
    assert.equal(commentThreads.length, beforeUnpinned, 'unpinned, Keep opens no new bubble');
    assert.ok(commentThreads[beforeUnpinned - 1].disposed, 'it just closes the one that was open');
    // The half of the pin that lives in the MANIFEST: two buttons share one toolbar slot, each shown by
    // the negation of the other's when-clause. Complements, not merely "both present" — a drifted pair
    // shows two pin buttons at once or none at all, and neither is visible to any code path under test.
    const threadTitle = pkg.contributes.menus['comments/commentThread/title'];
    // Scoped to the BUBBLE's block: the bar is a second thread flavour on the same controller and owns
    // its own inline@0, so a group filter alone would sweep its Keep button in here.
    const bubbleMenu = threadTitle.filter((m) => /commentThread == claudeEdit\b/.test(m.when));
    const pinSlot = bubbleMenu.filter((m) => m.group === 'inline@0');
    assert.deepEqual(pinSlot.map((m) => m.command).sort(),
      ['claudeObservatory.peekPin', 'claudeObservatory.peekUnpin'],
      'Pin and Unpin share the first slot of the bubble toolbar');
    const pinWhen = pinSlot.find((m) => m.command === 'claudeObservatory.peekPin').when;
    const unpinWhen = pinSlot.find((m) => m.command === 'claudeObservatory.peekUnpin').when;
    assert.match(pinWhen, /&& !claudeObservatory\.peekPinned$/, 'Pin is offered only while the bubble is unpinned');
    assert.equal(unpinWhen, pinWhen.replace('!claudeObservatory.peekPinned', 'claudeObservatory.peekPinned'),
      'and Unpin’s clause is its exact complement — exactly one of them is on the toolbar at any time');
    // …and the extension sets the very key those clauses read. A rename on either side is silent: the
    // manifest keeps parsing, the extension keeps running, and the button simply never appears.
    assert.ok(/"setContext",\s*"claudeObservatory\.peekPinned"/.test(bundle),
      'the bundle publishes claudeObservatory.peekPinned — the context key both when-clauses test');

    // ---- 0.10.0: the compact FLOATING REVIEW BAR ----------------------------------------------------
    // A comment thread with an EMPTY body and canReply:false — the widget collapses to its header row,
    // which is a real toolbar. It is the only interactive surface an extension can float over code (VS
    // Code exposes no overlay/inset API to the extension host at all), and it is the VS Code answer to
    // PyCharm's editorFloatingToolbarProvider bar.
    //
    // Its own session: three pending edits in one file and one in another, so "Diff n/m" and "File i/k"
    // are claims about something, and so the steppers have somewhere to step.
    const BS = 'reviewBar1';
    const BA = path.join(ws, 'bar-a.txt');
    const BB = path.join(ws, 'bar-b.txt');
    const BN = path.join(ws, 'bar-none.txt'); // a file Claude never touched
    // Each of BA's three edits touches a DIFFERENT line, so each is its own review group: `keepGroup`
    // keeps the whole same-code unit, and a chain of edits to one line would resolve all three at once —
    // which would make "the bar moved to the next edit" a claim about a session that had none left.
    const BA_TEXT = ['a\nb\nc\n', 'A\nb\nc\n', 'A\nB\nc\n', 'A\nB\nC\n'];
    fs.writeFileSync(BA, BA_TEXT[3]);
    fs.writeFileSync(BB, 'B1\n');
    fs.writeFileSync(BN, 'untouched\n');
    core.ensureStore(BS);
    for (const id of [1, 2, 3]) {
      core.appendLog(BS, {
        id, ts: 1000 * id, tool: 'Edit', file: BA,
        beforeBlob: core.writeBlob(BS, Buffer.from(BA_TEXT[id - 1])),
        afterBlob: core.writeBlob(BS, Buffer.from(BA_TEXT[id])),
        status: 'pending',
      });
    }
    core.appendLog(BS, { id: 4, ts: 4000, tool: 'Edit', file: BB, beforeBlob: core.writeBlob(BS, Buffer.from('b0\n')), afterBlob: core.writeBlob(BS, Buffer.from('b1\n')), status: 'pending' });
    configValues['session'] = BS;

    // Drive the extension the way the workbench does: an active editor, then a store refresh. The bar is
    // hung off updateStatusItem, and `show()` awaits openTextDocument, so a macrotask tick is what lets
    // the thread actually exist before anything is asserted about it.
    const barDoc = (file) => {
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split('\n');
      return { uri: Uri.file(file), lineCount: lines.length, getText: () => text, lineAt: (n) => ({ range: new Range(n, 0, n, (lines[n] || '').length) }) };
    };
    const focusFile = (file) => { vscode.window.activeTextEditor = { document: barDoc(file), selection: { active: { line: 0 } }, setDecorations() {}, revealRange() {} }; };
    const settle = async () => { await commands['claudeObservatory.refresh'](); await new Promise((r) => setTimeout(r, 0)); };
    const liveThreads = () => commentThreads.filter((t) => !t.disposed);
    const bar = () => liveThreads()[0];
    const restoreEditor = vscode.window.activeTextEditor;

    focusFile(BA);
    configValues['editorReviewSurface'] = 'floating';
    opened = undefined;
    await settle();

    // (1) It auto-shows, as the bar flavour, and NEVER steals focus: no showTextDocument, no revealRange.
    // Auto-showing by opening the file would fight whoever is typing in another editor, which is exactly
    // the failure that makes an auto-surface unusable.
    assert.equal(liveThreads().length, 1, 'a file with pending edits gets exactly one review surface');
    assert.equal(bar().contextValue, 'claudeNavBar', 'and it is the BAR flavour, not the bubble');
    assert.equal(bar().uri.fsPath, toFsPath(BA), 'anchored in the file being reviewed');
    assert.equal(opened, undefined, 'the auto-shown bar never opens/focuses a document — it must not fight the cursor');
    assert.equal(bar().canReply, false, 'canReply:false — this is what suppresses the reply box and the whole comment form');
    // BORN WITH A BODY, THEN EMPTIED — and both halves are load-bearing, so both are asserted.
    //
    // What the bar must END as is comment-less: that is what CommentThreadWidget renders at its
    // minimum — header only, no body, no reply form — which is what a review BAR is. But VS Code
    // picks the header's dismiss glyph from that same condition, once, at widget construction:
    //   function hOi(s){ return !!s && s.length > 0 }
    //   let o = hOi(comments) ? chevron : trashcan;
    // …so a thread CONSTRUCTED empty wears a trash can, on an action that deletes nothing and which
    // an extension cannot restyle. Nothing ever re-evaluates that choice (updateCommentThread re-reads
    // only the label), so the bar is constructed with one throwaway comment to win the chevron and
    // emptied immediately after. Drop the first half and the bin returns; drop the second and the
    // reader gets a permanent empty box about two editor lines tall under the header.
    assert.equal(bar().bornWith.length, 1, 'the bar is CONSTRUCTED with a body — that is what wins the chevron over the trash can');
    assert.equal(bar().comments.length, 0, 'and emptied right back out, so it renders at the one-row minimum');
    assert.equal(bar().state, vscode.CommentThreadState.Unresolved, 'Unresolved paints the frame + the arrow pointing at the edit');
    assert.equal(bar().collapsibleState, vscode.CommentThreadCollapsibleState.Expanded, 'and it opens expanded — a collapsed bar shows no toolbar at all');

    // (2) The counters. Both axes, off the same helpers the status bar reads, so the bar can never name a
    // different position than the counters beside it.
    assert.match(bar().label, /Agent edit #1\b/, 'the bar names the edit it is parked on');
    assert.match(bar().label, /\+\d+ −\d+/, 'with its line delta');
    assert.match(bar().label, /Diff 1\/3/, 'Diff n/m — position among THIS file’s pending edits');
    assert.match(bar().label, /File 1\/2/, 'File i/k — position among the files with pending edits');
    // The steppers hide when there is nowhere to step (JetBrains: FloatingDiffStep.applies). A dead
    // button on a widget that sits on top of code covers text for nothing.
    assert.equal(contextKeys['claudeObservatory.barMultiEdit'], true, 'three pending edits here — the ⌃⌄ steppers apply');
    assert.equal(contextKeys['claudeObservatory.barMultiFile'], true, 'two changed files — the ‹› steppers apply');

    // (3) It FOLLOWS a resolve, always — it is a navigation bar, and one that vanished when you used it
    // would be useless. `pinnedPeek` governs the bubble only, so prove the follow with it OFF.
    configValues['pinnedPeek'] = false;
    await commands['claudeObservatory.peekKeep']();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(core.findRecord(BS, 1).status, 'kept', 'the bar’s Keep keeps the edit it names');
    assert.equal(liveThreads().length, 1, 'and exactly one bar is still live — it carried itself, it did not clone');
    assert.equal(bar().contextValue, 'claudeNavBar', 'still the bar, not swapped to the bubble');
    assert.match(bar().label, /Agent edit #2\b/, 'parked on the next edit awaiting review');
    assert.match(bar().label, /Diff 1\/2/, 'with its counters recomputed — one fewer edit pending in this file');

    // (4) …and it closes when the file has nothing left to review. Assert against a file that EXISTS and
    // is simply untouched, not against "no session": the empty-session path proves nothing about this.
    focusFile(BN);
    await settle();
    assert.equal(liveThreads().length, 0, 'no bar over a file with no pending agent edits');
    assert.equal(contextKeys['claudeObservatory.barMultiEdit'], false, 'and the stepper keys go down with it');
    assert.equal(contextKeys['claudeObservatory.barMultiFile'], false);
    focusFile(BA);
    await settle();
    assert.equal(liveThreads().length, 1, 'coming back to a reviewable file brings it straight back');

    // (5) THE BAR AND THE BUBBLE ARE NEVER OPEN AT ONCE. They are two flavours of one thread on one
    // controller, and every path funnels through the same single `thread` field — this is the assertion
    // that keeps that true, in both directions and across a refresh.
    const barId = Number(/Agent edit #(\d+)/.exec(bar().label)[1]);
    await commands['claudeObservatory.barDetails']();
    assert.equal(liveThreads().length, 1, '⋯ Details leaves exactly one surface live');
    assert.equal(bar().contextValue, 'claudeEdit', 'and it is the bubble');
    assert.match(bar().label, new RegExp(`Agent edit #${barId}\\b`), 'at the SAME edit the bar was on');
    assert.equal(bar().comments.length, 1, 'the bubble does have a body (the reasoning + the git-coloured diff)');
    await settle();
    assert.equal(liveThreads().length, 1, 'a refresh does not open a bar beside the bubble the reader asked for');
    assert.equal(bar().contextValue, 'claudeEdit', '…and does not replace it either — the surface parked on the target edit is left alone, whichever it is');
    // …but it is keyed on the EDIT, not on the mode. Move to a different edit — here by moving to the
    // other changed file — and the surface the setting names takes over again. A mode-keyed guard would
    // instead strand this bubble and suppress the bar everywhere, with no way for the reader to dismiss
    // it: a programmatic comment thread has no close button.
    focusFile(BB);
    await settle();
    assert.equal(liveThreads().length, 1, 'moving to another changed file still leaves exactly one surface');
    assert.equal(bar().contextValue, 'claudeNavBar', 'and the bubble is released — the bar takes over on the new edit');
    assert.equal(bar().uri.fsPath, toFsPath(BB), 'over the file now being reviewed');
    assert.equal(contextKeys['claudeObservatory.barMultiEdit'], false, 'one pending edit here — the ⌃⌄ steppers hide (JetBrains: FloatingDiffStep.applies)');
    assert.equal(contextKeys['claudeObservatory.barMultiFile'], true, '…while the ‹› file steppers still apply');
    focusFile(BA);
    await settle();
    assert.equal(bar().contextValue, 'claudeNavBar', 'and coming back gives the bar, not the abandoned bubble');
    // The two collapse gestures mean DIFFERENT things, which is the whole point of having both.
    //
    // The platform's own `^` steps the bubble DOWN to the bar. There is no Comment API event for it,
    // but the collapse does reach us — the workbench pushes `{collapseState}` over
    // $updateCommentThread and the extension host assigns it to our thread object — so the extension
    // polls the value on the refresh it already runs. Driving it exactly that way here.
    await commands['claudeObservatory.barDetails']();
    assert.equal(bar().contextValue, 'claudeEdit', 'the bubble is up');
    bar().collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed; // ^ , as the platform sets it
    await settle();
    assert.equal(liveThreads().length, 1, '^ leaves exactly one surface live');
    assert.equal(bar().contextValue, 'claudeNavBar', 'and it is the review bar — one step down, not gone');
    assert.match(bar().label, new RegExp(`Agent edit #${barId}\\b`), 'still at the same edit');
    assert.equal(bar().collapsibleState, vscode.CommentThreadCollapsibleState.Expanded,
      'the bar it lands on is expanded — a collapsed one shows no toolbar at all');

    // ^ ACTS WHEN IT IS CLICKED, not whenever the store next happens to change.
    //
    // The API raises no event for a collapse, so this is polled — and the only caller of syncSurface
    // runs on store changes and tab switches. On a session with nothing writing (a finished review is
    // exactly that) `^` produced no refresh and therefore no poll, and the bubble sat there collapsed,
    // which on screen is indistinguishable from having been hidden. That is what was reported.
    //
    // So this drives the collapse and then does NOT call settle(): no refresh, no tab switch, nothing
    // but time. The surface has to notice on its own. The test above passes either way, because
    // settle() hand-delivers the tick that was missing.
    await commands['claudeObservatory.barDetails']();
    assert.equal(bar().contextValue, 'claudeEdit', 'the bubble is up again');
    bar().collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    await new Promise((r) => setTimeout(r, 600)); // no refresh — only the surface's own watch
    assert.equal(liveThreads().length, 1, '^ was noticed with no refresh to carry it');
    assert.equal(bar().contextValue, 'claudeNavBar', '…and it stepped DOWN to the bar rather than hiding');

    // …and on the BAR the same gesture hides it outright, because the bar is already the smallest
    // surface — there is no next step down. It stays hidden: a refresh is one tick away, so a dismissal
    // the next tick undoes is a button that does nothing.
    bar().collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    await settle();
    assert.equal(liveThreads().length, 0, '^ on the bar closes the surface outright');

    await settle();
    assert.equal(liveThreads().length, 0, '…and the next refresh does not put it straight back');

    // A DISMISSED BAR MUST NOT DISABLE THE BUBBLE'S STEP-DOWN AT THE SAME EDIT.
    //
    // The line above left `dismissed` set to this edit. `syncSurface` checked that flag BEFORE it
    // checked for a collapse, so from here on `^` on the bubble at this edit returned early and did
    // nothing — for the rest of the session. The reader sees a chevron that hides instead of stepping
    // down, which is exactly the report. Reopening explicitly is the reader saying they want the
    // surface, so the dismissal is stale by then.
    await commands['claudeObservatory.viewChanges'](barId);
    assert.equal(liveThreads().length, 1, 'viewChanges reopens at that edit despite the dismissal');
    assert.equal(bar().contextValue, 'claudeEdit', 'and it opens the bubble');
    bar().collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    await settle();
    assert.equal(liveThreads().length, 1, '^ still steps down rather than being swallowed by the old dismissal');
    assert.equal(bar().contextValue, 'claudeNavBar', '…and what is left is the bar');

    // It is scoped to THAT edit, not to the session: move to another changed file and the surface
    // returns. Without this a dismissal would suppress review chrome everywhere, with no way back —
    // a programmatic comment thread has no close button to un-press.
    focusFile(BB);
    await settle();
    assert.equal(liveThreads().length, 1, 'moving to another edit brings the surface back');
    focusFile(BA);
    await settle();
    assert.equal(liveThreads().length, 1, '…and returning re-opens it here too');
    assert.equal(bar().contextValue, 'claudeNavBar', 'as the bar, which is what the setting names');

    // Stepping the bar keeps it a BAR (a default-mode show() here would silently turn it into a bubble).
    await commands['claudeObservatory.peekNext']();
    assert.equal(liveThreads().length, 1, 'stepping opens no second surface');
    assert.equal(bar().contextValue, 'claudeNavBar', '⌄ Next Edit steps the bar without changing which surface you are on');

    // (5b) An open the reader triggered wins over the auto-sync. Both await a document, and the auto-sync
    // is re-entered by the very refresh a Keep causes — so without a guard a second thread is built
    // underneath the one being opened, on an edit resolved from a review cursor the in-flight open has
    // not parked yet. Whichever resumes last then wins, which is order-dependent in a real host; what is
    // NOT order-dependent, and is what this asserts, is that the redundant thread gets built at all.
    focusFile(BB); // one pending edit (#4) — so the auto-sync's target is not the edit opened below
    await settle();
    configValues['editorReviewSurface'] = 'none';
    fireConfigChange('editorReviewSurface'); // clear the screen: the "already parked here" guard must not mask this
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(liveThreads().length, 0, 'nothing live going into the race');
    configValues['editorReviewSurface'] = 'floating'; // …without firing, so nothing re-shows yet
    const builtBefore = commentThreads.length;
    const racing = commands['claudeObservatory.showReviewBar'](2); // an edit in the OTHER file — NOT awaited
    commands['claudeObservatory.refresh'](); // the auto-sync fires while that open is still in flight
    await racing;
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(commentThreads.length - builtBefore, 1, 'the auto-sync builds nothing underneath an open the reader triggered');
    assert.equal(liveThreads().length, 1, 'and exactly one surface is live afterwards');
    assert.match(bar().label, /Agent edit #2\b/, 'parked where the reader asked, not where the refresh would have put it');
    focusFile(BA);
    await settle();

    // (6) The setting. `floating`/`none` are spelled exactly as in JetBrains so the two shared words mean
    // the same thing in both editors; only the VS-Code-only bubble has a word of its own.
    configValues['editorReviewSurface'] = 'none';
    fireConfigChange('editorReviewSurface');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(liveThreads().length, 0, 'set to `none`, the editor review chrome goes away');
    await settle();
    assert.equal(liveThreads().length, 0, '…and stays away across refreshes');
    // …but the command is still the way in. `none` means "stop auto-showing", not "the bar is gone".
    opened = undefined;
    await commands['claudeObservatory.showReviewBar']();
    assert.equal(liveThreads().length, 1, 'the Show-review-bar command still opens it on demand');
    assert.equal(bar().contextValue, 'claudeNavBar', 'as the bar');
    assert.ok(opened, 'and an EXPLICIT open does reveal the edit — unlike the auto-show');

    configValues['editorReviewSurface'] = 'bubble';
    fireConfigChange('editorReviewSurface');
    await new Promise((r) => setTimeout(r, 0));
    await settle();
    assert.equal(liveThreads().length, 1, 'set to `bubble`, exactly one surface auto-shows');
    assert.equal(bar().contextValue, 'claudeEdit', 'and it is the bubble');
    // An unrecognized value reads as the DEFAULT, not as "nothing" — a hand-edited typo must not silently
    // strip every review control out of the editor with no way to notice (JetBrains: floatingSurface).
    configValues['editorReviewSurface'] = 'flaoting';
    fireConfigChange('editorReviewSurface');
    await new Promise((r) => setTimeout(r, 0));
    await settle();
    assert.equal(liveThreads().length, 1, 'a typo still leaves review controls in the editor');
    assert.equal(bar().contextValue, 'claudeNavBar', '…reading as the default `floating`');
    delete configValues['editorReviewSurface'];
    fireConfigChange('editorReviewSurface');
    await new Promise((r) => setTimeout(r, 0));
    await settle();
    assert.equal(bar().contextValue, 'claudeNavBar', 'and the shipped default is the bar');

    // (7) The half that lives in the MANIFEST. The bar's toolbar is a `comments/commentThread/title`
    // block gated on its OWN contextValue; a drifted command id or a missing declaration is invisible to
    // every code path above — the button simply never appears.
    const barMenu = threadTitle.filter((m) => /commentThread == claudeNavBar\b/.test(m.when));
    assert.deepEqual(barMenu.map((m) => `${m.group} ${m.command}`), [
      'inline@0 claudeObservatory.peekKeep',
      'inline@1 claudeObservatory.peekUndo',
      'inline@2 claudeObservatory.peekPrev',
      'inline@3 claudeObservatory.peekNext',
      'inline@4 claudeObservatory.peekPrevFile',
      'inline@5 claudeObservatory.peekNextFile',
      'inline@6 claudeObservatory.peekViewDiff',
      'inline@7 claudeObservatory.peekChat',
      'inline@8 claudeObservatory.toggleHeatmap',
      'inline@9 claudeObservatory.barDetails',
    ], 'the bar toolbar, in order: Keep · Undo · ⌃⌄ · ‹› · Diff · Chat · Spotlight · ⌄ expand');
    assert.ok(barMenu.every((m) => /commentController == claudeObservatory/.test(m.when)),
      'every bar button is scoped to our controller — these menus are global to the workbench');
    assert.ok(!barMenu.some((m) => /commentThread == claudeEdit\b/.test(m.when)) && !bubbleMenu.some((m) => /commentThread == claudeNavBar\b/.test(m.when)),
      'the two toolbars are disjoint: neither block leaks into the other');
    // ONE COLLAPSE CONTROL PER SURFACE, and it is the platform's.
    //
    // VS Code appends its own collapse action after every contributed one (`setActionBarActions` does
    // `push([...t, this._collapseAction])`), so nothing we contribute can sit after it and nothing can
    // suppress or restyle it. A contributed "hide" button therefore always renders BESIDE the
    // platform's, doing the same job twice — which is what the bar shipped with, and what this drops.
    //
    // What is left reads as one axis. The platform's `^` goes DOWN a step: bubble → bar, and from the
    // bar (already the smallest surface) → gone, which followPlatformCollapse implements. Our one
    // contributed control is its 180° flip, `⌄`, and goes UP: bar → bubble. Same glyph rotated, opposite
    // direction, one meaning.
    assert.ok(!JSON.stringify(pkg).includes('peekCollapse'),
      'peekCollapse is gone entirely — a second hide button beside the platform’s own is duplication, not a feature');
    assert.equal(barMenu[barMenu.length - 1].command, 'claudeObservatory.barDetails',
      'the LAST button we contribute to the bar is the expander, so only the platform’s own control follows it');
    assert.equal(pkg.contributes.commands.find((c) => c.command === 'claudeObservatory.barDetails').icon, '$(chevron-down)',
      'and it is chevron-DOWN — the platform’s chevron-up rotated, not $(arrow-down), which is the Diff stepper');
    assert.equal(pkg.contributes.commands.find((c) => c.command === 'claudeObservatory.peekNext').icon, '$(arrow-down)',
      'the Diff stepper keeps the tailed arrow, so the two never read as the same button');

    // The steppers' when-clauses and the keys the extension actually publishes must be the same strings.
    for (const [cmd, key] of [['claudeObservatory.peekPrev', 'barMultiEdit'], ['claudeObservatory.peekNext', 'barMultiEdit'],
      ['claudeObservatory.peekPrevFile', 'barMultiFile'], ['claudeObservatory.peekNextFile', 'barMultiFile']]) {
      assert.match(barMenu.find((m) => m.command === cmd).when, new RegExp(`&& claudeObservatory\\.${key}$`),
        `${cmd} on the bar is hidden unless ${key}`);
      assert.ok(new RegExp(`"setContext",\\s*"claudeObservatory\\.${key}"`).test(bundle),
        `the bundle publishes claudeObservatory.${key} — the key that clause reads`);
    }
    // Every button on these two toolbars is icon-only, and an icon id that is not in the shipped codicon
    // font renders as NOTHING — no error, no warning, no missing element. A blank square where Keep
    // should be is indistinguishable from a bar that has no Keep at all, so check the ids against the
    // real font rather than against a list written from memory.
    const codiconCss = path.resolve(__dirname, '../../../node_modules/@vscode/codicons/dist/codicon.css');
    assert.ok(fs.existsSync(codiconCss), `@vscode/codicons not found at ${codiconCss} — cannot verify toolbar icons`);
    const codiconIds = new Set([...fs.readFileSync(codiconCss, 'utf8').matchAll(/\.codicon-([a-z0-9-]+):before/g)].map((m) => m[1]));
    assert.ok(codiconIds.size > 100, 'the codicon font parsed');
    for (const m of [...barMenu, ...bubbleMenu]) {
      const icon = pkg.contributes.commands.find((c) => c.command === m.command)?.icon;
      assert.match(icon || '', /^\$\([a-z0-9-]+\)$/, `${m.command} on a comment-thread toolbar needs an icon (the toolbar shows no text)`);
      assert.ok(codiconIds.has(icon.slice(2, -1)), `${m.command}'s icon ${icon} is a real codicon (an unknown id draws a blank)`);
    }
    // Every command a menu names has to be DECLARED, or VS Code drops the entry silently.
    const declared = new Set(pkg.contributes.commands.map((c) => c.command));
    for (const m of [...barMenu, ...bubbleMenu]) assert.ok(declared.has(m.command), `${m.command} is declared in contributes.commands`);
    for (const c of ['claudeObservatory.showReviewBar', 'claudeObservatory.barDetails', 'claudeObservatory.peekViewDiff'])
      assert.ok(typeof commands[c] === 'function' && declared.has(c), `${c} is both registered and declared`);
    // Toolbar-only commands are hidden from the palette (they act on whatever surface is live, so they
    // are meaningless typed into a picker); `showReviewBar` deliberately is NOT — it takes no argument
    // and is the way back when editorReviewSurface is `none`.
    const barPalette = new Map(pkg.contributes.menus.commandPalette.map((m) => [m.command, m.when]));
    for (const c of ['claudeObservatory.barDetails', 'claudeObservatory.peekViewDiff'])
      assert.equal(barPalette.get(c), 'false', `${c} is toolbar-only`);
    assert.ok(!barPalette.has('claudeObservatory.showReviewBar'), 'showReviewBar stays in the palette on purpose');
    const surfaceCfg = pkg.contributes.configuration.properties['claudeObservatory.editorReviewSurface'];
    assert.deepEqual(surfaceCfg.enum, ['floating', 'bubble', 'none'], 'the surface setting offers exactly the three spellings');
    assert.equal(surfaceCfg.default, 'floating', 'and defaults to the floating bar');
    assert.equal(surfaceCfg.enumDescriptions.length, surfaceCfg.enum.length, 'each spelling says what it does');
    assert.match(pkg.contributes.configuration.properties['claudeObservatory.pinnedPeek'].description, /bubble only/i,
      'pinnedPeek says out loud that it governs the BUBBLE only — the bar is always pinned');

    vscode.window.activeTextEditor = restoreEditor;
    configValues['session'] = RS;
    delete configValues['editorReviewSurface'];
    await settle();

    // The Explorer/tab badge — the tour has always promised this in both editors; it was only ever true
    // of the synthetic tree scheme in VS Code.
    core.appendLog(RS, { id: 6, ts: 6000, tool: 'Edit', file: RA, beforeBlob: core.writeBlob(RS, Buffer.from('A3\n')), afterBlob: core.writeBlob(RS, Buffer.from('A4\n')), status: 'pending' });
    const badge = decoProvider.provideFileDecoration(Uri.file(RA));
    assert.equal(badge?.badge, String(core.readLog(RS).filter((r) => r.file === RA && r.status === 'pending').length), 'a file with pending edits carries their count');
    assert.match(badge?.tooltip ?? '', /pending agent edit/, 'and says what the number means');
    assert.equal(badge?.propagate, false, 'files only — folders are the Overview’s job');
    assert.equal(decoProvider.provideFileDecoration(Uri.file(path.join(ws, "never-edited.txt"))), undefined, 'an untouched file is undecorated');
    // The badge's colour is the other half that lives in the manifest: VS Code resolves a ThemeColor id
    // against `contributes.colors`, and an id with no contribution falls back to the default foreground —
    // the badge still renders, so nothing fails, it just stops being the amber the tour describes.
    const badgeColor = (pkg.contributes.colors || []).find((c) => c.id === 'claudeObservatory.pendingBadge');
    assert.ok(badgeColor, 'the pending-badge colour is contributed, so themes can restyle it');
    assert.equal(badge?.color?.id, badgeColor.id, '…and the decoration asks for exactly that id');

    // ---- the two auto-advance gates nothing above can see -------------------------------------------
    // Two pending edits, in DIFFERENT files, so "it did not navigate" is a claim about a session that had
    // somewhere to navigate to.
    core.appendLog(RS, { id: 7, ts: 7000, tool: 'Edit', file: RB, beforeBlob: core.writeBlob(RS, Buffer.from('B2\n')), afterBlob: core.writeBlob(RS, Buffer.from('B3\n')), status: 'pending' });
    assert.deepEqual(core.readLog(RS).filter((r) => r.status === 'pending').map((r) => r.id), [6, 7],
      'two pending edits, one in each file');
    configValues['revealNextOnResolve'] = true;

    // (a) advance is gated on the edit having actually LEFT pending. The dirty-buffer assertion earlier
    // drives `undo`, which never enters that path at all — so the gate itself was untested: without it a
    // refused undo throws the reader into another file having changed nothing.
    vscode.workspace.textDocuments.push({ uri: Uri.file(RA), isDirty: true });
    opened = undefined;
    const warnsBeforeInline = warnMessages.length;
    await commands['claudeObservatory.inlineUndo'](6);
    vscode.workspace.textDocuments.pop();
    assert.ok(warnMessages.slice(warnsBeforeInline).some((m) => /unsaved changes/.test(m)),
      'a dirty buffer refuses the inline Undo as well');
    assert.equal(core.findRecord(RS, 6).status, 'pending', 'the record never left pending');
    assert.equal(opened, undefined, '…so nothing was revealed — auto-advance follows a RESOLVE, not an attempt');

    // (b) the diff editor's opt-out, through the command its title bar actually invokes. Passing
    // `{ advance: false }` to inlineKeep by hand (above) says nothing about diffKeep — delete the option
    // at ITS call site and every other assertion here still passes.
    await commands['claudeObservatory.openDiff']({ kind: 'edit', rec: core.findRecord(RS, 7) });
    const dkUri = diffCalls[diffCalls.length - 1][1];
    assert.equal(new URLSearchParams(dkUri.query).get('e'), '7', 'the diff URI the title bar is handed carries the edit id');
    opened = undefined;
    await commands['claudeObservatory.diffKeep'](dkUri);
    // diffKeep fires inlineKeep without awaiting it, so drain the queue before claiming nothing moved.
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(core.findRecord(RS, 7).status, 'kept', 'diffKeep resolves the edit the diff is showing');
    assert.equal(opened, undefined, 'and never navigates away from the diff, auto-advance on or not');

    // ---- 0.10.0: rewind to before a prompt ---------------------------------------------------------
    // The BOUNDARY is the whole feature: rewinding from ask #2 takes that ask and everything after it and
    // leaves ask #1 standing. An assertion that only checked "something was reverted" would pass against
    // a plain reject-all, which is the thing rewind must not be.
    // Its own session and transcript: prompt boundaries come from the transcript, and the shared fixture's
    // own edits have been resolved by the assertions above.
    const RW = 'rewindSess1';
    const WA = path.join(ws, 'rewind-a.txt');
    const WB = path.join(ws, 'rewind-b.txt');
    fs.writeFileSync(path.join(proj, RW + '.jsonl'), [
      JSON.stringify({ timestamp: new Date(500).toISOString(), type: 'user', message: { role: 'user', content: 'ask one — scale the features' } }),
      JSON.stringify({ timestamp: new Date(1500).toISOString(), type: 'user', message: { role: 'user', content: 'ask two — add a validate() method' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'both asks answered' }] } }),
    ].join('\n'));
    core.ensureStore(RW);
    fs.writeFileSync(WA, 'A-after\n');
    fs.writeFileSync(WB, 'B-after\n');
    core.appendLog(RW, { id: 1, ts: 1000, tool: 'Edit', file: WA, beforeBlob: core.writeBlob(RW, Buffer.from('A-before\n')), afterBlob: core.writeBlob(RW, Buffer.from('A-after\n')), status: 'pending' });
    core.appendLog(RW, { id: 2, ts: 2000, tool: 'Edit', file: WB, beforeBlob: core.writeBlob(RW, Buffer.from('B-before\n')), afterBlob: core.writeBlob(RW, Buffer.from('B-after\n')), status: 'pending' });
    configValues['session'] = RW;
    await commands['claudeObservatory.refresh']?.();
    const rwAsks = core.sessionPrompts(ws, RW);
    assert.equal(rwAsks.length, 2, 'the fixture transcript carries two asks, one per edit');
    // DERIVED from core, never hard-coded: the test and the implementation must not be able to disagree
    // about which ids a boundary covers.
    const scope2 = core.checkpointScope(ws, RW, rwAsks[1].id);
    assert.deepEqual(scope2.ids, [2], 'the second ask owns the edit made after it, and only that one');
    assert.equal(scope2.pending, 1, 'which is pending, so the rewind has something to do');
    for (const c of ['claudeObservatory.promptRewind', 'claudeObservatory.rewindCurrentPrompt'])
      assert.ok(typeof commands[c] === 'function', `${c} registered`);
    const warnBefore = warnMessages.length;
    await commands['claudeObservatory.promptRewind'](rwAsks[1].id);
    // The mock reader takes the first offered action, so the modal path RAN — and the statuses below are
    // the proof, not the fact that the promise resolved.
    assert.ok(warnMessages.slice(warnBefore).some((m) => /^Rewind to before prompt #\d+\?/.test(m)),
      'the destructive op confirms before it touches anything, NAMING the ask it will rewind to');
    // Two counts, deliberately: raw pending records and review units. They legitimately differ, so the
    // dialog prints both rather than picking one and disagreeing with the row the reader clicked.
    assert.ok(warnMessages.slice(warnBefore).some((m) => /reverts \d+ pending edit\(s\) \(\d+ review units?\) across \d+ file/.test(m)),
      'and names the records, the review units and the files');
    assert.equal(core.findRecord(RW, 2).status, 'undone', 'the second ask’s edit is reverted');
    assert.equal(core.findRecord(RW, 1).status, 'pending', '…and the FIRST ask’s edit is left alone — the boundary, not a reject-all');
    assert.equal(fs.readFileSync(WB, 'utf8'), 'B-before\n', 'the file that ask changed is back to what it was before it');
    assert.equal(fs.readFileSync(WA, 'utf8'), 'A-after\n', 'and the earlier ask’s file is untouched on disk');
    // Nothing left from that ask onward: the honest nothing-to-do, and no status moves.
    const rwInfoBefore = infoMessages.length;
    await commands['claudeObservatory.promptRewind'](rwAsks[1].id);
    assert.ok(infoMessages.slice(rwInfoBefore).some((m) => /^Nothing to rewind/.test(m)), 'a second rewind says there is nothing to rewind');
    assert.equal(warnMessages.length, warnBefore + 1, 'and never asks for confirmation of a no-op');
    assert.equal(core.findRecord(RW, 1).status, 'pending', 'and moves nothing');
    // The Overview's Prompt-axis button resolves the ask ITSELF and then runs the same path.
    const rcpSeen = [];
    const realRewind = commands['claudeObservatory.promptRewind'];
    commands['claudeObservatory.promptRewind'] = (id) => { rcpSeen.push(id); };
    await commands['claudeObservatory.reviewNext'](); // parks the review cursor on the one pending edit
    await commands['claudeObservatory.rewindCurrentPrompt']();
    commands['claudeObservatory.promptRewind'] = realRewind;
    assert.deepEqual(rcpSeen, [rwAsks[0].id], 'rewindCurrentPrompt resolves the ask behind the current edit and rewinds from it');
    // …and from the FIRST ask it takes the whole tail, including the already-reverted later record.
    await commands['claudeObservatory.promptRewind'](rwAsks[0].id);
    assert.equal(core.findRecord(RW, 1).status, 'undone', 'rewinding from the first ask takes everything');
    assert.equal(fs.readFileSync(WA, 'utf8'), 'A-before\n', 'and the tree is back to before the session started');
    // The Redo the completion toast offers, TAKEN. The mock reader only clicks an action the test names,
    // and neither rewind above names one — so the restore branch, the escape hatch the confirmation dialog
    // promises by name ("Redo can restore them"), shipped without ever running. A THIRD rewind, on its own
    // fresh record: the two above have assertions that depend on the state they left behind.
    core.appendLog(RW, {
      id: 3, ts: 2500, tool: 'Edit', file: WA, status: 'pending',
      beforeBlob: core.writeBlob(RW, Buffer.from('A-before\n')),
      afterBlob: core.writeBlob(RW, Buffer.from('A-redone\n')),
    });
    fs.writeFileSync(WA, 'A-redone\n');
    assert.equal(core.checkpointScope(ws, RW, rwAsks[1].id).pending, 1, 'the new record is in the second ask’s scope, so the rewind has something to take');
    const pickWas = infoPick;
    infoPick = 'Redo'; // the mock reader clicks it on the "Rewound N edit(s)" toast
    await commands['claudeObservatory.promptRewind'](rwAsks[1].id);
    infoPick = pickWas;
    assert.equal(fs.readFileSync(WA, 'utf8'), 'A-redone\n', 'Redo puts back exactly what the rewind had just taken');
    assert.equal(core.findRecord(RW, 3).status, 'pending', '…as a pending edit again, awaiting review like before');
    assert.equal(core.findRecord(RW, 1).status, 'undone', 'and it restores only what MOVED — an edit undone earlier stays undone');
    // The webview route. The Prompt axis' Rewind button posts rewindCurrentPrompt (it has no id to send),
    // and that is the only sender that exists: Rewind is not in the Overview's bulk-retarget list and no
    // Prompts row posts one either. The host's `promptRewind` branch is therefore RESERVED — nothing can
    // reach it today — and the second tuple below pins its routing for the id-carrying sender that will.
    assert.ok(cmView.webview.html.includes('id="ov-rewindprompt"'), 'the Prompt axis carries a Rewind button');
    assert.ok(cmView.webview.html.includes("tbtn('ov-rewindprompt','rewindCurrentPrompt')"), 'wired to rewindCurrentPrompt');
    for (const [msg, cmd, arg] of [['rewindCurrentPrompt', 'claudeObservatory.rewindCurrentPrompt', undefined], ['promptRewind', 'claudeObservatory.promptRewind', 'ask9']]) {
      const seen = [];
      const real = commands[cmd];
      commands[cmd] = (a) => { seen.push(a); };
      cmMsgHandler({ type: msg, promptId: arg });
      commands[cmd] = real;
      assert.deepEqual(seen, [arg], `the Overview's ${msg} routes to ${cmd}`);
    }

    // ---- 0.10.0: the Timeline's active-session selector ---------------------------------------------
    assert.match(rqView.webview.html, /id="rq-sess"/, 'the Prompts window carries the session selector');
    assert.ok(rqView.webview.html.indexOf('id="rq-sess"') < rqView.webview.html.indexOf('class="rq-head"'),
      'above the Prompts heading — which session these asks belong to precedes every question about them');
    assert.match(rqView.webview.html, /'session-picker':'#rq-sess'/, 'and the tour anchor points at it');
    assert.match(rqView.webview.html, /type:'pickSession'/, 'picking a row posts pickSession');
    assert.match(rqView.webview.html, /type:'allSessions'/, 'and the last row posts allSessions');
    assert.ok(/\.rq-sname \{[^}]*overflow-wrap:anywhere/.test(rqView.webview.html) && !/\.rq-sname \{[^}]*text-overflow/.test(rqView.webview.html),
      'session names WRAP — core already capped the title at 64 characters, so clipping it here would lose the only copy');
    // Three sessions with known recency: one still being written, one quiet for an hour, one quiet for two
    // that we PIN. The selector's rule is "active, plus whatever I am reviewing" — all three cases at once.
    const LIVE = 'liveSess001', STALE = 'staleSess01', OLDPIN = 'oldPinned01';
    for (const [id, secsAgo] of [[LIVE, 0], [STALE, 3600], [OLDPIN, 7200]]) {
      // A store as well as a transcript: sessionMeta lists the sessions that HAVE one (plus the active and
      // the pinned), so a transcript alone would leave these three invisible to the listing under test.
      core.ensureStore(id);
      const jf = path.join(proj, id + '.jsonl');
      fs.writeFileSync(jf, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } }));
      const t = Math.floor(Date.now() / 1000) - secsAgo;
      fs.utimesSync(jf, t, t); // recency IS the transcript's mtime — the liveness rule reads exactly this
    }
    // The Timeline's own render path, EXECUTED. A chip stuck on "session —" forever — or a grouped
    // column whose list is never rendered into — would satisfy every source assertion above; only
    // running the shipped script against a DOM stub can see either.
    {
      const vm = require('node:vm');
      const rqScripts = [...rqView.webview.html.matchAll(/<script[^>]*>([\s\S]*?)<\/script[^>]*>/gi)];
      assert.ok(rqScripts.length >= 1, 'the Timeline shell embeds its script');
      const mk = () => {
        // `style` models the API the script uses: the column widths are written as a CSS custom
        // property, which a bare {} would swallow (setProperty is not a plain assignment).
        const style = {
          setProperty(k, v) { style[k] = String(v); },
          removeProperty(k) { delete style[k]; },
          getPropertyValue: (k) => style[k] || '',
        };
        // A RECORDING classList: the guided tour's highlight is a class on a node, and a no-op stub
        // would make "the ring is there" unfalsifiable.
        const cls = new Set();
        const node = {
          innerHTML: '', textContent: '', title: '', hidden: true, style, className: '', _ls: {},
          classList: { toggle() {}, add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) },
          setAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
          addEventListener(t, cb) { (node._ls[t] || (node._ls[t] = [])).push(cb); },
          // Real, because the drag handlers detach themselves on pointerup — a missing method there
          // would throw inside the very interaction these assertions drive.
          removeEventListener(t, cb) { const l = node._ls[t]; if (l) { const i = l.indexOf(cb); if (i >= 0) l.splice(i, 1); } },
          // Fired for real, so the HTML asserted below is the HTML a click actually produces.
          click() { (node._ls.click || []).forEach((cb) => cb.call(node, { target: node, stopPropagation() {} })); },
          // A NON-degenerate box: a divider computes its new split as a fraction of the pair it sits
          // between, and a zero-width rect would make every clamp trivially true.
          getBoundingClientRect: () => ({ width: 600, height: 300, left: 0, top: 0, right: 600, bottom: 300 }),
          querySelectorAll: () => [], querySelector: () => null, closest: () => null,
        };
        return node;
      };
      /** Run the shipped Timeline script against the stub, with a given persisted webview state. */
      const runTimeline = (persisted) => {
        const posted = [];
        const saved = [];
        const els = new Map();
        const el = (id) => {
          if (!els.has(id)) {
            const node = mk();
            node.querySelector = (selector) => selector[0] === '#' ? el(selector.slice(1)) : null;
            Object.assign(node, { scrollTop: 0, scrollHeight: 600, clientHeight: 300, childNodes: [] });
            els.set(id, node);
          }
          return els.get(id);
        };
        let listener = null;
        const win = { addEventListener: (t, cb) => { if (t === 'message') listener = cb; } };
        // `querySelector('#id')` resolves to the same node getElementById hands out, so the tour's
        // anchor lookup reaches something a test can then inspect.
        const docS = {
          getElementById: el, addEventListener() {}, createElement: mk,
          // `.ring` has to find what is actually ringed, or the "and it goes when the step moves on"
          // half of the tour assertion would be unfalsifiable against a stub that always answers empty.
          querySelectorAll: (sel) => (sel === '.ring' ? [...els.values()].filter((n) => n.classList.contains('ring')) : []),
          querySelector: (sel) => (typeof sel === 'string' && sel[0] === '#' ? el(sel.slice(1)) : null),
          body: mk(), documentElement: mk(),
        };
        const sb = {
          window: win, document: docS, console,
          acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m), getState: () => persisted || null, setState: (s) => saved.push(s) }),
          JSON, Math, Date, String, Number, Array, Object, RegExp, parseInt, parseFloat, isFinite, undefined,
          setTimeout: () => 0, clearTimeout() {}, getComputedStyle: () => ({ getPropertyValue: () => '' }),
        };
        sb.globalThis = sb;
        vm.createContext(sb);
        assert.doesNotThrow(() => vm.runInContext(rqScripts[rqScripts.length - 1][1], sb), 'the Timeline script initializes under the DOM stub');
        assert.ok(typeof listener === 'function', 'the script listens for host messages');
        /** Invoke the LAST handler registered for an event — i.e. the one the current markup wired. */
        const fire = (node, type, ev) => {
          const l = node._ls[type] || [];
          const cb = l[l.length - 1];
          assert.ok(cb, `the stub node has a ${type} handler to fire`);
          return cb.call(node, ev || { target: node, stopPropagation() {}, preventDefault() {} });
        };
        return { el, posted, saved, fire, post: (data) => listener({ data }) };
      };
      const migrated = runTimeline({ tab: 'conversation', groupedTabs: true, colC: { agent: true, conversation: true } });
      migrated.post({ type: 'tab', tab: 'feed' });
      assert.equal(migrated.saved.at(-1).tab, 'feed', 'a persisted Agent/Conversation pick lands on the Feed');
      assert.ok(!('agent' in migrated.saved.at(-1).colC) && !('conversation' in migrated.saved.at(-1).colC), 'new state drops the retired column ids');
      assert.ok(!migrated.saved.at(-1).colC.feed, '…without transferring their fold to the Feed column');
      const solo = runTimeline(null);
      const el = solo.el;
      const posted = solo.posted;
      const listener = (m) => solo.post(m.data);
      assert.equal(el('rq-sname').textContent, 'session —', 'before any listing arrives the chip claims nothing');
      listener({ data: { type: 'sessions', current: LIVE, rows: [
        { id: LIVE, title: 'the live conversation', lastActiveMs: Date.now(), active: true },
        { id: OLDPIN, title: null, lastActiveMs: Date.now() - 7200000, active: false },
      ] } });
      assert.equal(el('rq-sname').textContent, 'the live conversation', 'the chip NAMES the session under review');
      assert.equal(el('rq-sdot').textContent, '●', 'and marks it live');
      assert.match(el('rq-schip').title, new RegExp('session ' + LIVE), 'the tooltip carries the full session id');
      assert.match(el('rq-schip').title, /the live conversation/, 'the title core gave it');
      assert.match(el('rq-schip').title, /active/, 'and when it was last written to');
      assert.ok(el('rq-slist').hidden, 'the list starts closed');
      el('rq-schip').click();
      assert.equal(el('rq-slist').hidden, false, 'clicking the chip opens it');
      const listHtml = el('rq-slist').innerHTML;
      // The dropdown's own controls: search, sort, active-only — the full
      // listing needs them.
      assert.ok(listHtml.includes('id="rq-sq"') && listHtml.includes('id="rq-ssort"') && listHtml.includes('id="rq-sfilter"'),
        'the search/sort/filter bar rides the top of the dropdown');
      assert.ok(listHtml.includes('Sort: Newest') && listHtml.includes('data-ssort="az"') && listHtml.includes('data-sflt="act"'),
        'in the Traces navbar’s own control language — labeled sort menu, ✓-row filter menu');
      assert.ok(listHtml.includes('data-sid="' + LIVE + '"'), 'the active session is offered');
      assert.ok(listHtml.includes('data-sid="' + OLDPIN + '"'), '…and the reviewed-but-quiet one, marked ○');
      assert.match(listHtml, /session oldPinn/, 'a session with no title falls back to its short id, never to a blank row');
      assert.match(listHtml, /data-sall="1"[\s\S]*All sessions…/, 'and the last row is the way out to the full list');
      // A session under review the host could not list at all (a pin from another workspace, a listing
      // that threw): the chip still names the id it is showing.
      listener({ data: { type: 'sessions', current: 'ghostSess99', rows: [] } });
      assert.equal(el('rq-sname').textContent, 'session ghostSes', 'with no row for it, the chip still names what it is reviewing');
      assert.equal(el('rq-sdot').textContent, '○', 'and never claims it is live');
      // The list was left open, so this is what it renders with nothing to offer: the way out, and only it.
      assert.match(el('rq-slist').innerHTML, /All sessions…/, 'and the list still offers the full browser');
      assert.doesNotMatch(el('rq-slist').innerHTML, /data-sid=/, 'with no row to pick');
      // A conversation search that FAILED says so; only a search that ran may say nothing matches.
      solo.fire(el('rq-slist'), 'input', { target: { id: 'rq-sq', value: 'needle' } });
      solo.post({ type: 'searchResults', q: 'needle', hits: [], error: 'the index could not be read' });
      assert.match(el('rq-srows').innerHTML, /could not search the conversations — the index could not be read/, 'a failed search names its failure');
      assert.doesNotMatch(el('rq-srows').innerHTML, /nothing matches/, '…and never claims an empty result');
      solo.post({ type: 'searchResults', q: 'needle', hits: [] });
      assert.match(el('rq-srows').innerHTML, /nothing matches “needle” in any conversation/, 'control: a search that ran and found nothing says that');

      // The guided tour's ring SURVIVES a repaint, and lands even though the host broadcasts the anchor
      // before it names the tab. Both are real: the host's order is fixed (anchor to every panel, then
      // the view), and every payload rebuilds the node the ring was on.
      solo.post({ type: 'tour', anchor: 'prompts-list' });
      solo.post({ type: 'prompts', rq: { prompts: [], summary: { total: 0, withEdits: 0, edits: 0 } }, selected: null });
      assert.ok(el('rq-list').classList.contains('ring'), 'the tour ring is still on the list after a repaint replaced it');
      solo.post({ type: 'tour', anchor: null });
      solo.post({ type: 'prompts', rq: { prompts: [], summary: { total: 0, withEdits: 0, edits: 0 } }, selected: null });
      assert.ok(!el('rq-list').classList.contains('ring'), 'and it goes when the step moves on');
      // The RE-APPLY itself is a source assertion, and says why: this stub cannot model a node being
      // destroyed by an innerHTML assignment, so an executed check cannot tell "the ring was put back"
      // from "the ring was never lost". In a real DOM the repaint throws the old node away.
      assert.ok(rqView.webview.html.includes("vscode.postMessage({type:'select', id:null}); });\n    reTour();"),
        'the Prompts renderer re-applies the tour ring after every repaint');

      // ---- 0.10.0: the TAB STRIP ------------------------------------------------------------------
      // Four tabs (the Conversation tab folded INTO the Feed, 2026-09-23), drawn by the window
      // itself — a panel container stacks its views under collapsible headers and has no tabs.
      const tabsHtml = el('tl-tabs').innerHTML;
      assert.equal((tabsHtml.match(/class="tl-tab/g) || []).length, 4, 'ungrouped: four tabs');
      for (const k of ['feed', 'prompts', 'observations', 'actions'])
        assert.ok(tabsHtml.includes(`data-tab="${k}"`), `the ${k} tab is one of them`);
      assert.ok(!tabsHtml.includes('data-tab="conversation"'), 'and no Conversation tab');
      // The Feed LEADS: the conversation as it happened is the landing surface.
      assert.ok(tabsHtml.indexOf('data-tab="feed"') < tabsHtml.indexOf('data-tab="prompts"'), 'Feed is the first tab in the strip');
      assert.equal(el('tl-pane-feed').style.display, 'flex', 'Feed leads');
      assert.equal(el('tl-pane-actions').style.display, 'none', '…and the others are closed');
      assert.doesNotThrow(() => solo.post({ type: 'agentFeed', session: LIVE, patches: {}, feed: { mode: 'live', title: 'the live conversation', lastTs: 8, entries: [
        { ts: 1, kind: 'prompt', label: '#1', promptText: 'fix it' },
        { ts: 2, kind: 'reasoning', label: 'thinking', reasoning: 'checking the test first', reasoningKind: 'thinking' },
        { ts: 3, kind: 'reasoning', label: 'said', reasoning: 'I will run the tests.', reasoningKind: 'text' },
        { ts: 4, kind: 'action', label: 'Bash', target: 'npm test', category: 'exec', cmd: 'npm test', ok: true, reasoning: 'I will run the tests.', reasoningKind: 'text' },
        { ts: 8, kind: 'reasoning', label: 'said', reasoning: '**done** — all green', reasoningKind: 'text' },
      ] } }), 'a whole-conversation feed payload renders without throwing');
      const feedHtml = el('tl-feed').innerHTML;
      assert.match(feedHtml, /tlf-blob user[\s\S]*?class="tlf-user-text">fix it<\/div>/, 'the prompt bubble renders its text');
      assert.match(feedHtml, /tlf-verb agent">thinking<[\s\S]*?4 words/, 'a thought is a row, folded to its word-count label by default');
      assert.doesNotMatch(feedHtml, /tlf-think tla-md/, '…its body closed until the reader opens it');
      assert.match(feedHtml, /tlf-verb agent">said<[\s\S]*?class="tla-text tla-md"><div>I will run the tests\.<\/div>/, 'a reply is a row, open, rendered as markdown');
      assert.match(feedHtml, /tlf-verb exec">\$<[\s\S]*?npm/, 'the tool call renders its command');
      assert.equal((feedHtml.match(/I will run the tests\./g) || []).length, 1, 'the call does not repeat the reply above it (same reasoning string)');
      assert.match(feedHtml, /<b>done<\/b> — all green/, 'the closing reply is a row of its own, with its markdown');
      const feedSource = fs.readFileSync(path.resolve(__dirname, '../src/extension.ts'), 'utf8');
      assert.ok(!/function conversationEventHtml|function renderAgentTab|fetchConversation\(/.test(feedSource), 'the separate conversation renderer and its poll are gone');
      assert.equal(el('tl-group').style.display, 'none', 'with the grouped pane put away');
      // The session selector stays ABOVE the tabs, visible whichever one is forward.
      assert.ok(rqView.webview.html.indexOf('id="rq-sess"') < rqView.webview.html.indexOf('class="tl-tabrow"'),
        'the session selector row sits above the tab strip');
      // Only what is on screen is served: the Actions root walks every sibling worktree for conflicts.
      const view0 = posted.filter((m) => m.type === 'view').pop();
      assert.ok(view0 && view0.shows.feed === true && view0.shows.prompts === false && view0.shows.actions === false && view0.shows.observations === false,
        'the window tells the host which tabs are on screen, so it serves only those');

      // A tab message (the tour's path, and the palette's) brings that tab forward.
      solo.post({ type: 'tab', tab: 'actions' });
      assert.equal(el('tl-pane-actions').style.display, 'flex', 'a tab message brings Actions forward');
      assert.equal(el('tl-pane-feed').style.display, 'none', '…and closes the Feed');
      assert.ok(posted.filter((m) => m.type === 'view').pop().shows.actions === true, 'and the host is told to start serving it');

      // ---- the flattened trees --------------------------------------------------------------------
      // Rows render the provider's own label / description / tooltip; a collapsible row carries a twisty
      // and, when it opens, asks the host for exactly that level.
      solo.post({ type: 'rows', tab: 'actions', parent: '', count: 7, err: null, rows: [
        { key: 'gEdits', label: 'Edits', desc: '3', tip: 'the edit calls', glyph: '✎', tone: '', open: false, act: false, acts: [] },
        { key: 'cgroup', label: 'Live conflicts', desc: '1', tip: 'two agents in one file', glyph: '⚠', tone: 'attn', open: true, act: false, acts: [] },
      ] });
      const actHtml = el('tl-actions').innerHTML;
      assert.match(actHtml, /data-key="gEdits"/, 'a row keys on the id the host gave it');
      assert.match(actHtml, />Edits</, '…and shows the tree item’s label');
      assert.match(actHtml, /the edit calls/, 'the tree item’s tooltip rides the row');
      assert.match(actHtml, /▸/, 'a collapsed row shows a closed twisty');
      assert.match(actHtml, /▾/, '…and an expanded one an open twisty');
      assert.match(actHtml, /t-attn/, 'the ThemeColor becomes a tone class');
      assert.match(actHtml, /7 tool calls/, 'the header counts what the feed holds');
      // The DEFAULT-expanded row asked for its children, exactly once.
      const kidReqs = () => posted.filter((m) => m.type === 'children' && m.tab === 'actions' && m.key === 'cgroup').length;
      assert.equal(kidReqs(), 1, 'an open row asks the host for its level — once');
      solo.post({ type: 'rows', tab: 'actions', parent: 'cgroup', rows: [
        { key: 'cgroup/c0', label: 'app.txt', desc: '2 agents', tip: '/w/app.txt', glyph: '❐', tone: 'attn', open: null, act: true, acts: [] },
      ] });
      assert.match(el('tl-actions').innerHTML, /app\.txt/, 'the children render under the open row');
      // A ROOT payload replaces the tree: children built from the previous tick must not survive it.
      const before = kidReqs();
      solo.post({ type: 'rows', tab: 'actions', parent: '', count: 7, rows: [
        { key: 'cgroup', label: 'Live conflicts', desc: '1', tip: 't', glyph: '⚠', tone: 'attn', open: true, act: false, acts: [] },
      ] });
      assert.equal(kidReqs(), before + 1, 'a new root payload drops the children it held and asks again');
      assert.doesNotMatch(el('tl-actions').innerHTML, /app\.txt/, '…so no row from the previous tick is still on screen');

      // The empty states the two removed views carried as viewsWelcome entries, verbatim.
      solo.post({ type: 'rows', tab: 'actions', parent: '', count: 0, rows: [] });
      assert.match(el('tl-actions').innerHTML, /No tool calls in this session yet/, 'Actions keeps its welcome copy');
      assert.match(el('tl-actions').innerHTML, /Edits, commands, reads, searches, egress, and to-dos appear here as the agent works/, '…in full');
      solo.post({ type: 'rows', tab: 'observations', parent: '', count: 0, rows: [], hooks: true });
      assert.match(el('tl-observations').innerHTML, /No edits in this session yet/, 'Observations keeps the hooks-installed variant');
      solo.post({ type: 'rows', tab: 'observations', parent: '', count: 0, rows: [], hooks: false });
      assert.match(el('tl-observations').innerHTML, /No tracked agent edits in this workspace yet/, '…and the no-hooks one');
      assert.match(el('tl-observations').innerHTML, /Try the demo — no agent session needed/, 'with the demo offer, as a button');
      // A feed that could not be built SAYS so — an empty list would read as a session that did nothing.
      solo.post({ type: 'rows', tab: 'actions', parent: '', rows: [], err: 'transcript unreadable' });
      assert.match(el('tl-actions').innerHTML, /Could not read this session’s actions/, 'a failed read is stated, not swallowed');
      assert.match(el('tl-actions').innerHTML, /transcript unreadable/, '…with what went wrong');

      // ---- grouped mode: four columns, resizable and foldable --------------------------------------
      const grouped = runTimeline({ groupedTabs: true });
      const gEl = grouped.el;
      assert.equal(gEl('tl-group').style.display, 'flex', 'grouped: the one pane is on screen');
      assert.equal((gEl('tl-tabs').innerHTML.match(/class="tl-tab/g) || []).length, 1, 'and the strip carries a single tab');
      assert.match(gEl('tl-tabs').innerHTML, /Feed · Prompts · Observations · Actions/, 'naming all four, in column order');
      const gHtml = gEl('tl-group').innerHTML;
      assert.equal((gHtml.match(/class="tl-groupcol"/g) || []).length, 4, 'four columns');
      for (const k of ['feed', 'prompts', 'observations', 'actions'])
        assert.ok(gHtml.includes(`id="tl-g-${k}"`), `the ${k} column carries its own host node`);
      assert.ok(grouped.posted.filter((m) => m.type === 'view').pop().shows.actions === true, 'and the host is asked for all of them');
      // Members render INTO those columns — one renderer per member, writing wherever it currently lives.
      grouped.post({ type: 'rows', tab: 'actions', parent: '', count: 2, rows: [
        { key: 'gEdits', label: 'Edits', desc: '2', tip: 't', glyph: '✎', tone: '', open: false, act: false, acts: [] } ] });
      assert.match(gEl('tl-g-actions').innerHTML, />Edits</, 'the Actions column holds the Actions rows');
      assert.equal(gEl('tl-actions').innerHTML, '', '…and not the solo pane it is not using');

      // WIDTHS. Equal to start, then dragged — and the drag never lets a column past its floor.
      assert.equal(gEl('tl-gc-prompts').style['--tl-cw'], '1', 'columns start on an equal share');
      const drag = (gutterId, clientX) => {
        const g = gEl(gutterId);
        grouped.fire(g, 'pointerdown', { preventDefault() {}, pointerId: 1, clientX });
        grouped.fire(g, 'pointermove', { clientX });
        grouped.fire(g, 'pointerup', {});
      };
      // Drag the Prompts|Observations divider as far right as it will go. The pair spans 600px in the
      // stub and the floor is 190px, so neither side may end below 190/600 of their combined share.
      drag('tl-cg-observations', 100000);
      const wP = Number(gEl('tl-gc-prompts').style['--tl-cw']);
      const wO = Number(gEl('tl-gc-observations').style['--tl-cw']);
      assert.ok(wP > 1 && wO < 1, 'the drag moved the split');
      assert.ok(Math.abs(wP + wO - 2) < 1e-9, '…without changing the pair’s combined share');
      assert.ok(wO >= 2 * (190 / 600) - 1e-9, 'and the shrinking column stopped at the 190px floor, never at zero');
      assert.ok(gEl('tl-gc-actions').style['--tl-cw'] === '1' && gEl('tl-gc-feed').style['--tl-cw'] === '1',
        'the other columns are untouched by a drag between prompts and observations');
      // colW persists by TABS index — the Feed leads, so its untouched share is the FIRST slot.
      assert.deepEqual(grouped.saved[grouped.saved.length - 1].colW.map((n) => Math.round(n * 1000)),
        [1000, Math.round(wP * 1000), Math.round(wO * 1000), 1000], 'the widths are persisted on pointer-up');
      // A LATER PAYLOAD must not reset them — this is the case a naive implementation gets wrong, because
      // badges arrive on their own tick long after the reader has set a layout.
      grouped.post({ type: 'rows', tab: 'actions', parent: '', count: 99, rows: [] });
      grouped.post({ type: 'prompts', rq: { prompts: [], summary: { total: 0, withEdits: 0, edits: 0 } }, selected: null });
      assert.equal(Number(gEl('tl-gc-prompts').style['--tl-cw']), wP, 'a later payload leaves the dragged width alone');
      assert.equal(Number(gEl('tl-gc-observations').style['--tl-cw']), wO, '…on both sides of the divider');
      // FOLDING. A folded column becomes a rail that still names itself; the last one standing refuses.
      grouped.fire(gEl('tl-cc-observations'), 'click');
      const folded = gEl('tl-group').innerHTML;
      assert.match(folded, /class="tl-groupcol rail" id="tl-gc-observations"/, 'the folded column becomes a rail');
      assert.match(folded, /id="tl-cc-observations"[^>]*>[\s\S]*?Observations/, '…which still NAMES the member, so it can be clicked back');
      assert.ok(folded.includes('id="tl-gb-observations"'), '…and still carries its badge');
      assert.ok(!folded.includes('id="tl-g-observations"'), 'and its list is not drawn while folded');
      assert.equal((folded.match(/class="tl-groupcol"/g) || []).length, 3, 'three columns remain expanded');
      grouped.fire(gEl('tl-cc-actions'), 'click');
      grouped.fire(gEl('tl-cc-feed'), 'click');
      assert.equal((gEl('tl-group').innerHTML.match(/class="tl-groupcol"/g) || []).length, 1, 'and then one');
      assert.ok(!gEl('tl-group').innerHTML.includes('id="tl-cc-prompts"'), 'the last expanded column offers no fold button');
      grouped.fire(gEl('tl-cc-prompts'), 'click'); // a click that raced the repaint
      assert.equal((gEl('tl-group').innerHTML.match(/class="tl-groupcol"/g) || []).length, 1,
        'and folding it is refused — a group with every column folded is an empty pane');
      assert.ok(grouped.saved[grouped.saved.length - 1].colC.observations, 'the folded set is persisted');
      assert.ok(!grouped.saved[grouped.saved.length - 1].colC.prompts, '…and the refused fold is not in it');
      // Unfolding restores the width the reader had SET, not an equal share — wO came from the drag and
      // is deliberately not 1.
      assert.ok(Math.abs(wO - 1) > 0.01, 'the dragged weight is distinguishable from an equal share');
      grouped.fire(gEl('tl-cc-observations'), 'click');
      assert.equal((gEl('tl-group').innerHTML.match(/class="tl-groupcol"/g) || []).length, 2, 'clicking a rail brings the column back');
      assert.equal(Number(gEl('tl-gc-observations').style['--tl-cw']), wO, '…at the width it had before it folded');
      // Double-click splits that pair evenly again — the way back from a bad drag.
      grouped.fire(gEl('tl-cg-observations'), 'dblclick', {});
      assert.equal(Number(gEl('tl-gc-prompts').style['--tl-cw']), 1, 'double-click resets the pair');
      assert.equal(Number(gEl('tl-gc-observations').style['--tl-cw']), 1, '…on both sides');
      // A folded column restored from PERSISTED state comes back folded, with the widths it had.
      // (colW is by TABS index — Feed first, then Prompts.)
      const reload = runTimeline({ groupedTabs: true, colC: { actions: 1 }, colW: [1, 1.4, 0.6, 1] });
      assert.match(reload.el('tl-group').innerHTML, /class="tl-groupcol rail" id="tl-gc-actions"/, 'a reload restores the folded column');
      assert.equal(reload.el('tl-gc-prompts').style['--tl-cw'], '1.4', '…and the widths that went with it');
      // The persisted TAB is restored too.
      const onActions = runTimeline({ tab: 'actions' });
      assert.equal(onActions.el('tl-pane-actions').style.display, 'flex', 'a reload comes back on the tab it left on');
    }

    // The selector consumes the built CLI (the file's TREE_OAK pin) on the window's existing refresh.
    const sessionsPush = async (pin) => {
      configValues['session'] = pin;
      const posts = [];
      rqView.webview.postMessage = (m) => { posts.push(m); return Promise.resolve(true); };
      rqView.visible = true;
      // The window coalesces to one spawn at a time, and a failed spawn releases that gate on a later
      // tick — so wait for it rather than racing it. Twenty tries is ~200ms; the gate opens on the first.
      for (let i = 0; i < 200 && !posts.some((m) => m.type === 'sessions'); i++) {
        rqProvider.refresh(true);
        if (!posts.some((m) => m.type === 'sessions')) await new Promise((r) => setTimeout(r, 10));
      }
      rqView.visible = false;
      return posts.find((m) => m.type === 'sessions');
    };
    const sp = await sessionsPush(OLDPIN);
    assert.ok(sp, 'the Prompts window is fed the selector rows on its own refresh cadence — no second timer');
    assert.equal(sp.current, OLDPIN, 'and told which session is under review');
    const spIds = sp.rows.map((r) => r.id);
    assert.equal(sp.rows[0].id, OLDPIN, 'the reviewed session leads the list, whatever its age');
    assert.equal(sp.rows[0].active, false, 'and is marked NOT active — the pin is why it is listed, not liveness');
    assert.ok(spIds.includes(LIVE), 'a session still being written is listed');
    assert.equal(sp.rows.find((r) => r.id === LIVE).active, true, 'and marked active');
    // FULL listing now: the Timeline selector shows the same population the
    // Overview's Sessions pane does — the active-only cut read as missing sessions. The dropdown's
    // own search/sort/filter bar carries the long list.
    assert.ok(spIds.includes(STALE), 'a quiet old session IS listed — the selector matches the Overview');
    // Pinned to something this workspace has no row for: synthesized, so the selector can still name it
    // and switch away from it.
    const spGhost = await sessionsPush('ghostSess99');
    assert.ok(!spGhost.rows.some((r) => r.id === 'ghostSess99'),
      'an unavailable pin is named by the chip but never fabricated as a local row');
    // "Nobody is waiting" is a claim about every session, so it needs a listing that loaded. After one
    // that failed, the jump says it could not read them instead.
    {
      const pinWas = configValues['session'];
      configValues['session'] = OLDPIN; // postSessions keeps only a listing for the session current now
      const notExec = path.join(ws, 'not-a-binary-hands');
      fs.writeFileSync(notExec, 'this is not executable\n');
      process.env.CLAUDE_OBSERVATORY_BIN = notExec;
      await rqProvider.postSessions(ws, OLDPIN);
      process.env.CLAUDE_OBSERVATORY_BIN = TREE_OAK;
      const warnedBefore = warnMessages.length, toldBefore = infoMessages.length;
      rqProvider.jumpToNextHand();
      assert.match(warnMessages.slice(warnedBefore).join('\n'), /could not read which sessions are waiting/, 'a failed listing is not read as nobody waiting');
      assert.ok(!infoMessages.slice(toldBefore).some((m) => /nobody is waiting/.test(m)), '…and nobody-waiting is not claimed');
      await rqProvider.postSessions(ws, OLDPIN);
      rqProvider.jumpToNextHand();
      assert.ok(infoMessages.slice(toldBefore).some((m) => /nobody is waiting on you/.test(m)), 'control: after a listing that loaded, with no raised hand, it is');
      configValues['session'] = pinWas;
    }
    // ONE listing per refresh tick: with the Overview AND the Timeline on screen, the Timeline's own
    // `sessions --json` recomputed the listing the Overview's batch had just built. The CLI is wrapped in
    // a counter, so the spawns themselves are asserted (POSIX only: the counter is a shell script).
    if (process.platform !== 'win32') {
      const argvLog = path.join(ws, 'oak-argv.log');
      const counter = path.join(ws, 'oak-counter');
      fs.writeFileSync(counter, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(argvLog)}\nexec ${JSON.stringify(TREE_OAK)} "$@"\n`);
      fs.chmodSync(counter, 0o755);
      const spawned = (verb) => (fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8').split('\n') : []).filter((v) => v === verb).length;
      const settle = async (cond) => { for (let i = 0; i < 1500 && !cond(); i++) await new Promise((r) => setTimeout(r, 10)); };
      const wasPin = configValues['session'];
      const cmPost = cmView.webview.postMessage;
      const rqPost = rqView.webview.postMessage;
      process.env.CLAUDE_OBSERVATORY_BIN = counter;
      configValues['session'] = OLDPIN;
      try {
        // Drain the steps above first. A forced re-run they queued mid-spawn fires later, and a forced
        // refresh rightly retires every batch begun before it, which would make the count below race.
        for (let round = 0; round < 3; round++) {
          await settle(() => !rqProvider.running && !cmProvider.running);
          rqProvider.rerun = false;
          cmProvider.rerun = false;
          await new Promise((r) => setTimeout(r, 20));
        }
        cmView.webview.postMessage = () => Promise.resolve(true);
        cmView.visible = true;
        cmProvider.running = false;
        cmProvider.refresh(true);
        await settle(() => !cmProvider.running);
        assert.equal(spawned('views'), 1, 'control: the Overview batch ran, through the counter');
        const posts = [];
        rqView.webview.postMessage = (m) => { posts.push(m); return Promise.resolve(true); };
        rqView.visible = true;
        rqProvider.running = false;
        rqProvider.run = 0;
        rqProvider.refresh(false); // the watcher's tick, just after the batch landed
        await settle(() => posts.some((m) => m.type === 'sessions'));
        assert.ok(posts.find((m) => m.type === 'sessions')?.rows.some((r) => r.id === OLDPIN), 'the Timeline posted its selector rows…');
        assert.equal(spawned('sessions'), 0, '…from the listing the Overview batch built, with no sessions spawn of its own');
        // A forced refresh (every review verb) never reuses a listing gathered before it.
        posts.length = 0;
        await settle(() => !rqProvider.running);
        rqProvider.refresh(true);
        await settle(() => posts.some((m) => m.type === 'sessions'));
        assert.equal(spawned('sessions'), 1, 'a forced refresh reads a listing of its own');
        posts.length = 0;
        await settle(() => !rqProvider.running);
        rqProvider.run = 0;
        rqProvider.refresh(false);
        await settle(() => posts.some((m) => m.type === 'sessions'));
        assert.equal(spawned('sessions'), 2, '…and so does the tick after it: the batch on hand began before the change');
        await settle(() => !rqProvider.running && !cmProvider.running);
        // A change another tool made — a keep in the TUI, a hand raised in another session — reaches this
        // window only through the store watcher, whose refresh is unforced: the batch on hand began before
        // it, so the tick after it reads a listing of its own.
        cmProvider.running = false;
        cmProvider.refresh(true);
        await settle(() => !cmProvider.running);
        const store = fsWatchers.find((w) => String(w.pattern).includes('log.jsonl'));
        assert.ok(store && store.change.length, 'control: the store watcher is registered');
        store.change.forEach((f) => f(vscode.Uri.file(path.join(core.rootDir(), 'fixture-other-session', 'attention.json'))));
        posts.length = 0;
        rqProvider.run = 0;
        rqProvider.refresh(false);
        await settle(() => posts.some((m) => m.type === 'sessions'));
        assert.equal(spawned('sessions'), 3, 'the tick after an outside change reads a listing of its own');
        // Control: a batch begun after that change is reused again.
        await settle(() => !rqProvider.running && !cmProvider.running);
        cmProvider.running = false;
        cmProvider.refresh(true);
        await settle(() => !cmProvider.running);
        posts.length = 0;
        rqProvider.run = 0;
        rqProvider.refresh(false);
        await settle(() => posts.some((m) => m.type === 'sessions'));
        assert.equal(spawned('sessions'), 3, 'control: a batch begun after the change is reused');
        await settle(() => !rqProvider.running && !cmProvider.running);
      } finally {
        cmView.visible = false;
        rqView.visible = false;
        cmView.webview.postMessage = cmPost;
        rqView.webview.postMessage = rqPost;
        configValues['session'] = wasPin;
        process.env.CLAUDE_OBSERVATORY_BIN = TREE_OAK;
      }
    }
    // The two messages the selector posts, and where they land. 0.10.0: "All sessions…" goes to the
    // Overview's SESSIONS TAB — the full browser — not to the deprecated switchSession QuickPick.
    for (const [msg, cmd, arg] of [['pickSession', 'claudeObservatory.pinSession', LIVE], ['allSessions', 'claudeObservatory.showSessions', undefined]]) {
      const seen = [];
      const real = commands[cmd];
      commands[cmd] = (a) => { seen.push(a); };
      rqMsgHandler({ type: msg, id: arg });
      commands[cmd] = real;
      assert.deepEqual(seen, [arg], `the selector's ${msg} routes to ${cmd}`);
    }
    // …and it must not ALSO still reach the QuickPick: the whole point is that one row now has one
    // destination. (A branch that fired both would satisfy the assertion above.)
    {
      const qpSeen = [];
      const realQPCmd = commands['claudeObservatory.switchSession'];
      const realShow = commands['claudeObservatory.showSessions'];
      commands['claudeObservatory.switchSession'] = () => { qpSeen.push(1); };
      commands['claudeObservatory.showSessions'] = () => {};
      rqMsgHandler({ type: 'allSessions' });
      commands['claudeObservatory.switchSession'] = realQPCmd;
      commands['claudeObservatory.showSessions'] = realShow;
      assert.deepEqual(qpSeen, [], 'and no longer opens the deprecated session QuickPick');
    }
    // showSessions itself: reveal the Overview, then bring its Sessions tab forward — through the tour's
    // OWN path (setTour), so one mechanism moves that tab strip and the two can never disagree.
    {
      const focused = [];
      const realFocus = commands['claudeObservatory.changemap.focus'];
      commands['claudeObservatory.changemap.focus'] = () => { focused.push(1); };
      const tourCalls = [];
      const realSetTour = cmProvider.setTour.bind(cmProvider);
      cmProvider.setTour = (tab, anchor) => { tourCalls.push([tab, anchor]); };
      await commands['claudeObservatory.showSessions']();
      cmProvider.setTour = realSetTour;
      if (realFocus === undefined) delete commands['claudeObservatory.changemap.focus']; else commands['claudeObservatory.changemap.focus'] = realFocus;
      assert.deepEqual(focused, [1], 'showSessions reveals the Overview');
      assert.deepEqual(tourCalls, [['sessions', null]], '…and brings its Sessions tab forward through the tab-strip path the tour uses');
    }
    // The same active-only list as a command, so the Timeline selector and the palette drive one
    // implementation. Active-only, with the way out to the full browser as its last item.
    assert.ok(typeof commands['claudeObservatory.switchActiveSession'] === 'function', 'switchActiveSession registered');
    assert.equal(pkg.contributes.commands.find((c) => c.command === 'claudeObservatory.switchActiveSession').icon, '$(pulse)', 'with the pulse icon');
    configValues['session'] = OLDPIN;
    let qpItems = null;
    const realQP = vscode.window.showQuickPick;
    const pinSeen = [];
    const realPin = commands['claudeObservatory.pinSession'];
    commands['claudeObservatory.pinSession'] = (id) => { pinSeen.push(id); };
    createQuickPickChoose = (items) => { qpItems = items; return items[0]; };
    await commands['claudeObservatory.switchActiveSession']();
    assert.deepEqual(pinSeen, [OLDPIN], 'a pick routes through pinSession — so a switch made mid-demo never writes settings.json');
    assert.equal(qpItems[0].label.slice(0, 1), '○', 'the reviewed-but-quiet session leads, marked ○');
    assert.ok(qpItems.some((i) => i.label.startsWith('● ')), 'a live session is marked ●');
    assert.ok(!qpItems.some((i) => i.id === STALE), 'and the quiet stranger is absent');
    assert.match(qpItems[qpItems.length - 1].label, /All sessions…$/, 'the last item is the way out to the full list');
    // …and that last item falls THROUGH to the full browser rather than pinning an empty id. Same
    // destination as the webview row: the Overview's Sessions tab, never the deprecated QuickPick.
    const fallSeen = [];
    const qpFallSeen = [];
    const realFull = commands['claudeObservatory.showSessions'];
    const realQPFall = commands['claudeObservatory.switchSession'];
    commands['claudeObservatory.showSessions'] = () => { fallSeen.push(1); };
    commands['claudeObservatory.switchSession'] = () => { qpFallSeen.push(1); };
    createQuickPickChoose = (items) => items[items.length - 1];
    await commands['claudeObservatory.switchActiveSession']();
    assert.deepEqual(fallSeen, [1], 'All sessions… hands over to the Overview’s Sessions tab');
    assert.deepEqual(qpFallSeen, [], 'and not to the deprecated QuickPick');
    assert.deepEqual(pinSeen, [OLDPIN], 'and pins nothing on the way');
    commands['claudeObservatory.showSessions'] = realFull;
    commands['claudeObservatory.switchSession'] = realQPFall;
    commands['claudeObservatory.pinSession'] = realPin;
    vscode.window.showQuickPick = realQP;
    createQuickPickChoose = null;
    // The pickers' 📁 row button is the third store affordance, EXECUTED: press it on the seeded session's
    // row (it has a store, so it carries the button) and the same reveal opens that row's folder, without
    // switching the review to it. Both pickers share one handler (pinned above by source); this drives one.
    {
      let pressedRow = null;
      createQuickPickButton = (items) => {
        pressedRow = items.find((i) => i.id === S) || null;
        return pressedRow && { item: pressedRow, button: pressedRow.buttons[0] };
      };
      createQuickPickChoose = () => undefined; // then dismiss the picker
      openExternalCalls.length = 0;
      try {
        await commands['claudeObservatory.switchSession']();
      } finally {
        createQuickPickButton = null;
        createQuickPickChoose = null;
      }
      assert.ok(pressedRow && pressedRow.buttons.length === 2, 'control: the seeded session’s row carries the store button');
      assert.deepEqual(openExternalCalls.map((u) => u.path), [core.storeDir(S)], 'the picker’s folder button opens that row’s store folder');
    }

    // The Prompt AXIS moves BOTH surfaces. Left to the end of the run deliberately: it opens files and
    // moves the review cursor, which the axis assertions above read.
    {
      // Back to the seeded session, with its edits pending again: the axis steps between asks that still
      // have something to review, and the run above has been resolving them all the way down.
      configValues['session'] = S;
      const log = core.readLog(S);
      assert.ok(log.length >= 1, 'the seeded session still has records to step');
      for (const r of log) core.setStatus(S, r.id, 'pending');
      cmProvider.setPrompt(null);
      tlProvider.setSelection(null);
      await commands['claudeObservatory.navPromptNext']();
      assert.ok(tlProvider.selection, 'stepping the Prompt axis selects that ask in the Prompts list');
      assert.equal(cmProvider.getPrompt(), tlProvider.selection, '…and the Overview is scoped to the same one');
      // Review-prompt takes the same route.
      const other = core.promptWindows(ws, S).find((r) => r.id !== tlProvider.selection);
      if (other) {
        await commands['claudeObservatory.reviewPrompt'](other.id);
        assert.equal(tlProvider.selection, other.id, 'reviewing an ask selects it as well');
        assert.equal(cmProvider.getPrompt(), other.id, '…on both surfaces');
      }
      cmProvider.setPrompt(null);
      tlProvider.setSelection(null);
    }

    // A ×N run must survive the trip to the webview WITH OTHER FILES AROUND IT.
    //
    // The assertions further up drive a fixture whose whole feed is one run, so they cannot tell a
    // serializer that keeps the run from one that serves a run's per-edit children in its place — with a
    // single run either shape still yields "app.txt" rows. That is the exact failure a reader reports as
    // "the same file is not combined together any more", so the mixed case is pinned here: two adjacent
    // edits to one file, a third file's edit between them and the rest of the session, and the run's
    // members must reach the panel only by EXPANDING it.
    {
      configValues['session'] = S;
      const RUNF = path.join(ws, 'combined.txt'); // the file whose two edits must coalesce
      const LONEF = path.join(ws, 'apart.txt'); // a different file, newer, so it sits above the run
      // Newer than everything already in this store, so the three lead the newest-first feed in the order
      // they are written here — the run's two edits ADJACENT, the loner above them.
      const t0 = Date.now() + 60000;
      const c0 = core.writeBlob(S, Buffer.from('one\n'));
      const c1 = core.writeBlob(S, Buffer.from('one\ntwo\n'));
      const c2 = core.writeBlob(S, Buffer.from('one\ntwo\nthree\n'));
      const r1 = core.appendLog(S, { ts: t0, tool: 'Edit', file: RUNF, beforeBlob: c0, afterBlob: c1, status: 'pending' });
      const r2 = core.appendLog(S, { ts: t0 + 1000, tool: 'Edit', file: RUNF, beforeBlob: c1, afterBlob: c2, status: 'pending' });
      const lone = core.appendLog(S, { ts: t0 + 2000, tool: 'Edit', file: LONEF, beforeBlob: c0, afterBlob: c1, status: 'pending' });
      tlProvider.observations.refresh();
      // The view-model first: one run node for the pair, a plain edit node for the loner.
      const feed = tlProvider.observations.getChildren();
      const runNode = feed.find((n) => n.kind === 'tlrun' && n.file === RUNF);
      assert.ok(runNode, 'the two adjacent same-file edits are ONE run node, with another file in the feed');
      assert.deepEqual(runNode.edits.map((e) => e.id), [r2.id, r1.id], 'the run holds both of them, newest first');
      assert.ok(feed.some((n) => n.kind === 'edit' && n.rec.id === lone.id), 'the other file stays a row of its own');
      // …then the payload the webview draws. One row per node, in the same order: a serializer that
      // flattened the level would post more rows than the provider produced.
      const posts = [];
      let tlMsg2 = null;
      tlProvider.resolveWebviewView({
        webview: {
          options: {}, html: '',
          postMessage: (m) => { posts.push(m); return Promise.resolve(true); },
          onDidReceiveMessage: (f) => { tlMsg2 = f; return { dispose() {} }; },
        },
        onDidChangeVisibility: () => ({ dispose() {} }),
        visible: false, // no subprocess spawn while hidden
      });
      tlMsg2({ type: 'view', tab: 'observations', grouped: false, shows: { prompts: false, observations: true, actions: false } });
      const root = posts.find((m) => m.type === 'rows' && m.tab === 'observations' && m.parent === '');
      assert.ok(root && !root.err, 'the Observations root is served');
      assert.equal(root.rows.length, feed.length, 'the payload is one row per node — the level is never flattened');
      const runRow2 = root.rows.find((r) => /combined\.txt\s+×2/.test(r.label));
      assert.ok(runRow2, 'the run reaches the panel as ONE row carrying ×2');
      assert.match(runRow2.desc, /^\+2 −0/, '…with the two edits’ deltas combined, not one edit’s');
      assert.equal(runRow2.open, false, '…collapsed, so the file is on screen once');
      // The members are reachable only THROUGH it. Keys are the host's own (`e<id>`), so a row that
      // smuggled a run member up to the root level is caught by identity, not by counting labels.
      assert.deepEqual(root.rows.filter((r) => r.key === 'e' + r1.id || r.key === 'e' + r2.id), [],
        'neither member is also a root row — that is what "combined" means here');
      assert.ok(root.rows.some((r) => r.key === 'e' + lone.id), 'the unrelated file is still its own root row');
      assert.equal(root.rows.filter((r) => /combined\.txt/.test(r.label)).length, 1,
        'and the run’s file appears exactly once in the feed');
      // Expanding is what reveals them — and the badge counts the edits the run holds, not the row.
      posts.length = 0;
      tlMsg2({ type: 'children', tab: 'observations', key: runRow2.key });
      const runKids = posts.find((m) => m.type === 'rows' && m.parent === runRow2.key);
      assert.ok(runKids, 'the run serves its children when opened');
      assert.deepEqual(runKids.rows.map((r) => r.label), ['#' + r2.id, '#' + r1.id],
        'which are the per-edit rows, newest first');
      assert.equal(root.count, core.readLog(S).length, 'the badge counts EDITS, so coalescing never hides any');
    }

    // A ×N run whose NEWEST edit has no reasoning: a formatter's Bash rewrite right after the agent's Edit.
    // The run row speaks for its newest edit only, as JetBrains' run row does (runReasoningLine): that
    // edit's change summary, never an older edit's words beside the newest edit's time.
    {
      configValues['session'] = S;
      const FMT = path.join(ws, 'features.py');
      const WHY = 'Adding scale() so features share a range before training.';
      const t0 = Date.now() + 90000; // newer than the run above, older than the capped feed below
      fs.appendFileSync(path.join(proj, S + '.jsonl'), '\n' + JSON.stringify({ type: 'assistant', timestamp: new Date(t0 - 500).toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: WHY }, { type: 'tool_use', name: 'Edit', input: { file_path: FMT } }] } }));
      const f0 = core.writeBlob(S, Buffer.from('def f(x):\n    return x\n'));
      const f1 = core.writeBlob(S, Buffer.from('def f(x):\n    return (x - m) / s\n'));
      const f2 = core.writeBlob(S, Buffer.from('def f(x):\n    return (x - m) / s\n\n'));
      const edit = core.appendLog(S, { ts: t0, tool: 'Edit', file: FMT, beforeBlob: f0, afterBlob: f1, status: 'pending' });
      const bash = core.appendLog(S, { ts: t0 + 1000, tool: 'Bash', file: FMT, beforeBlob: f1, afterBlob: f2, status: 'pending' });
      const reasons = core.reasoningByEdit(ws, S);
      assert.deepEqual([reasons.get(edit.id), reasons.get(bash.id)], [WHY, undefined], 'fixture: the Edit has reasoning, the Bash rewrite none');
      tlProvider.observations.refresh();
      const fmtRun = tlProvider.observations.getChildren().find((n) => n.kind === 'tlrun' && n.file === FMT);
      assert.deepEqual(fmtRun?.edits.map((e) => e.id), [bash.id, edit.id], 'fixture: one ×2 run, the Bash rewrite newest');
      const fmtItem = tlProvider.observations.getTreeItem(fmtRun);
      assert.ok(String(fmtItem.description).endsWith(` · ${core.summarize(S, bash)}`), `the run row reads the newest edit's summary: ${fmtItem.description}`);
      assert.ok(!String(fmtItem.description).includes(WHY) && !String(fmtItem.tooltip).includes(WHY), '…and never the older edit\'s reasoning');
    }

    // A feed BIGGER THAN THE CAP: the bound is stated, the tail survives, and the badge is untouched.
    //
    // The ×N assertions above run on a two-edit fixture, so they would pass through any cap without
    // noticing — including one that sliced the level's head and deleted the Context section and Next
    // steps with it. This seeds past the cap deliberately. Written straight to the log (ids and uids
    // assigned here) because appendLog re-reads the file per record to allocate the next id, which is
    // quadratic at this size and would cost more than the case being tested.
    {
      configValues['session'] = S;
      const CAP = 300; // EDIT_FEED_CAP in the extension — asserted against the row's own numbers below
      const N = CAP + 120;
      const t0 = Date.now() + 120000; // newest, so these lead the newest-first feed
      const bb = core.writeBlob(S, Buffer.from('one\n'));
      const ab = core.writeBlob(S, Buffer.from('one\ntwo\n'));
      const before = core.readLog(S);
      let id = before.reduce((m, r) => Math.max(m, r.id), 0);
      const lines = [];
      // Adjacent edits are to DIFFERENT files, so nothing coalesces and each one is a root row — the
      // shape that makes the feed as long as the session. Three of the files are SOURCE files, which
      // grows the Next-steps list past one row: a tail of exactly one suggestion could not tell a
      // whole tail from a partly-delivered one.
      for (let i = 0; i < N; i++) {
        id++;
        lines.push(JSON.stringify({ id, uid: 'big' + id, ts: t0 + i * 1000, tool: 'Edit',
          file: path.join(ws, 'big', 'f' + (i % 40) + (i % 40 < 3 ? '.ts' : '.txt')), beforeBlob: bb, afterBlob: ab, status: 'pending' }));
      }
      fs.appendFileSync(core.logPath(S), lines.join('\n') + '\n');
      const totalEdits = core.readLog(S).length;
      assert.equal(totalEdits, before.length + N, 'the big fixture landed in the store');
      const posts = [];
      let msg = null;
      const bigView = {
        webview: { options: {}, html: '', postMessage: (m) => { posts.push(m); return Promise.resolve(true); },
          onDidReceiveMessage: (f) => { msg = f; return { dispose() {} }; } },
        onDidChangeVisibility: () => ({ dispose() {} }),
        visible: false, // no subprocess spawn while hidden
      };
      tlProvider.resolveWebviewView(bigView);
      const OFF = { prompts: false, observations: false, actions: false };
      const ON = { prompts: false, observations: true, actions: false };
      tlProvider.observations.refresh();
      msg({ type: 'view', tab: 'observations', grouped: false, shows: OFF });
      posts.length = 0;
      msg({ type: 'view', tab: 'observations', grouped: false, shows: ON });
      const big = posts.find((m) => m.type === 'rows' && m.tab === 'observations' && m.parent === '');
      assert.ok(big && !big.err, 'the oversized Observations root is served');
      // The provider still produces the WHOLE feed — the bound is on what crosses to the webview.
      const feed = tlProvider.observations.getChildren();
      const feedRows = feed.filter((n) => n.kind === 'edit' || n.kind === 'tlrun').length;
      assert.ok(feedRows > CAP, `the fixture is bigger than the cap (${feedRows} edit rows)`);
      const drawnEdits = big.rows.filter((r) => /^(e|run)\d/.test(r.key)).length;
      assert.equal(drawnEdits, CAP, 'exactly the cap’s worth of edit rows is serialized');
      assert.ok(big.rows.length < feed.length, 'the payload is shorter than the feed — something was left out');
      // …and it SAYS so, with the real total, in the place the rows were dropped from. The total is
      // EDITS, not rows, so the notice and the badge beside it are the same number rather than two
      // different counts both called "edits" (a coalesced ×N run is one row holding N of them).
      const grp = (n) => String(n).replace(/\B(?=(\d{3})+$)/g, ',');
      const more = big.rows.find((r) => r.key === 'more');
      assert.ok(more, 'a capped feed carries a row saying it is capped — a dropped row is never silent');
      assert.equal(more.label, `showing ${grp(CAP)} of ${grp(totalEdits)} edits`,
        'the row states how many are drawn and how many there are — the REAL total, the badge’s own number');
      assert.equal(more.acts.length, 0, 'it offers no verbs (there is no node behind it)');
      assert.equal(more.open, null, '…and nothing to expand');
      assert.equal(big.rows.indexOf(more), CAP + 1, 'it sits right after the last edit row kept (the recap leads)');
      // THE TAIL. These come after the edit run in the feed, so a head-N slice would have deleted them.
      const tailKeys = big.rows.slice(big.rows.indexOf(more) + 1).map((r) => r.key);
      assert.ok(tailKeys.includes('ctxhead'), 'the Context section survives the cap');
      assert.ok(tailKeys.includes('steps'), 'the Next steps header survives the cap');
      assert.ok(tailKeys.filter((k) => /^suggestion/.test(k)).length > 1, '…and so do its suggestion rows');
      const lastEdit = feed.map((n) => n.kind === 'edit' || n.kind === 'tlrun').lastIndexOf(true);
      assert.equal(tailKeys.length, feed.length - 1 - lastEdit,
        'the tail is served WHOLE — every node after the edit run reaches the panel, none dropped with it');
      // THE BADGE. Counted off the provider's kids, which the cap never touches: a reader who is shown
      // 300 rows must still be told the session has thousands.
      assert.equal(big.count, totalEdits, 'the badge counts every edit in the session, capped feed or not');
      assert.ok(big.count > drawnEdits, 'which is more than the feed draws — that is the whole point of saying so');
      // The cap is the OBSERVATIONS feed's, not a blanket row limit: Actions is category groups, and
      // capping it would drop the audit sections that follow them.
      posts.length = 0;
      msg({ type: 'view', tab: 'observations', grouped: false, shows: OFF });
      msg({ type: 'view', tab: 'actions', grouped: false, shows: { prompts: false, observations: false, actions: true } });
      const actBig = posts.find((m) => m.type === 'rows' && m.tab === 'actions' && m.parent === '');
      assert.equal(actBig.rows.length, tlProvider.actions.getChildren().length, 'the Actions root is never capped');
      assert.ok(!actBig.rows.some((r) => r.key === 'more'), '…so it never carries the notice row');

      // ---- the tree block's own throttle -------------------------------------------------------------
      // Both feeds used to ride EVERY refresh, forced or not, on the reasoning that they cost no spawn.
      // That was true of the trees, which VS Code virtualized; a webview pays a full build + post, and
      // the store watcher fires one refresh per 150ms burst while the agent works.
      const notABinBig = path.join(ws, 'not-a-binary-big');
      fs.writeFileSync(notABinBig, 'this is not executable\n');
      const wasBinBig = process.env.CLAUDE_OBSERVATORY_BIN;
      process.env.CLAUDE_OBSERVATORY_BIN = notABinBig;
      // `running`/`rerun` are driven DIRECTLY below (TS `private` is compile-time only, and the field
      // names survive the bundle). A spawn's timing is not a thing a unit test can hold still, and
      // "the tree block sits above the in-flight gate" is precisely a statement about that state —
      // reproducing it by racing a real subprocess would test the race, not the invariant.
      const wasRunning = tlProvider.running;
      const wasRerun = tlProvider.rerun;
      try {
        msg({ type: 'view', tab: 'observations', grouped: false, shows: ON });
        bigView.visible = true;
        tlProvider.running = false;
        tlProvider.refresh(true); // stamps both throttles
        posts.length = 0;
        tlProvider.running = false;
        tlProvider.refresh(false); // the watcher's own tick, inside the window
        assert.ok(!posts.some((m) => m.type === 'rows'),
          'an unforced tick inside the window rebuilds no feed — the cost the trees never had');
        posts.length = 0;
        tlProvider.running = false;
        tlProvider.refresh(true); // a review verb: it changed what the rows say, so it posts
        assert.ok(posts.some((m) => m.type === 'rows' && m.tab === 'observations'),
          'a forced refresh posts anyway — a Keep must repaint the row it resolved');
        // The gate the tree block must stay ABOVE. `running` returns early after arming `rerun`, so a
        // Keep landing mid-spawn would leave the feed on pre-Keep statuses until that spawn's callback
        // re-ran the refresh — seconds later, or never if the spawn fails.
        tlProvider.running = true;
        tlProvider.rerun = false;
        posts.length = 0;
        tlProvider.refresh(true);
        assert.ok(posts.some((m) => m.type === 'rows' && m.tab === 'observations'),
          'a forced refresh during an in-flight spawn still posts the feed (the tree block is above the gate)');
        assert.ok(!posts.some((m) => m.type === 'prompts'), '…and still leaves the spawn alone');
        assert.equal(tlProvider.rerun, true, 'the spawn is re-run once the in-flight one lands');
      } finally {
        tlProvider.running = wasRunning;
        tlProvider.rerun = wasRerun;
        bigView.visible = false;
        if (wasBinBig === undefined) delete process.env.CLAUDE_OBSERVATORY_BIN;
        else process.env.CLAUDE_OBSERVATORY_BIN = wasBinBig;
      }
    }

    // A store that stays busy after the files changed (a live holder, past the status write's budget).
    // The file-scoped revert still reverts, and its toast is a WARNING naming the edit it could not
    // record and the command that records it — never a bare "Undid 1 edit(s)".
    {
      const K = path.join(ws, 'held.txt');
      const kb = core.writeBlob(S, Buffer.from('k1\n')), ka = core.writeBlob(S, Buffer.from('k2\n'));
      const held = core.appendLog(S, { ts: 9990, tool: 'Edit', file: K, beforeBlob: kb, afterBlob: ka, status: 'pending' });
      fs.writeFileSync(K, 'k2\n');
      const wasSession = configValues['session'], wasEditor = vscode.window.activeTextEditor;
      configValues['session'] = S;
      vscode.window.activeTextEditor = { document: { uri: Uri.file(K), lineCount: 1, getText: () => 'k2\n', lineAt: () => ({ range: new Range(0, 0, 0, 2) }) }, selection: { active: { line: 0 } }, setDecorations() {}, revealRange() {} };
      const lock = path.join(core.storeDir(S), '.lock');
      fs.writeFileSync(lock, String(process.pid));
      const warnsBefore = warnMessages.length;
      try {
        await commands['claudeObservatory.undoOpenFile']();
      } finally {
        fs.rmSync(lock, { force: true });
        configValues['session'] = wasSession;
        vscode.window.activeTextEditor = wasEditor;
      }
      const toast = warnMessages.slice(warnsBefore).pop() ?? '';
      assert.equal(fs.readFileSync(K, 'utf8'), 'k1\n', 'the file was reverted');
      assert.match(toast, /^Undid 1 edit\(s\) in held\.txt\. .*not recorded as reverted/, toast);
      assert.ok(toast.includes(`\`oak undo --ids ${held.id} --record-only --session ${S}\``), toast);
      assert.equal(core.findRecord(S, held.id).status, 'pending', 'unrecorded, as the toast says');
      core.recordOnly(S, [held.id], 'undo');
      assert.equal(core.findRecord(S, held.id).status, 'undone');
    }
  } finally {
    Module._load = origLoad;
  }
});

// The rename's migration, EXECUTED: an install that still carries a pre-rename id retires it on
// activation — each old id uninstalled once, one reload offered — and registers nothing in that window,
// so the two builds never race for the same commands. The window after the reload, with the old id
// gone, retires nothing again: no uninstall/reload loop.
test('extension: a pre-rename install retires the old id once, then activates for real', async () => {
  const bundle = require.resolve(BUNDLE);
  const activateWith = async (installed) => {
    const calls = [];
    const registered = [];
    // Permissive stand-ins for everything this test does not look at. The bundle copies the module's OWN
    // keys into its `vscode` namespace, so every name it uses gets one.
    const any = () => new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : any()), apply: () => any(), construct: () => any() });
    const vscode = Object.fromEntries([...new Set([...fs.readFileSync(bundle, 'utf8').matchAll(/\bvscode\.([A-Za-z_]\w*)/g)].map((m) => m[1]))].map((k) => [k, any()]));
    vscode.extensions = { getExtension: (id) => (installed.has(id) ? { id } : undefined) };
    vscode.commands = {
      registerCommand: (id) => { registered.push(id); return { dispose() {} }; },
      executeCommand: (cmd, ...args) => { calls.push([cmd, ...args]); if (cmd === 'workbench.extensions.uninstallExtension') installed.delete(args[0]); return Promise.resolve(); },
    };
    vscode.window = new Proxy({}, { get: (_w, wk) => (wk === 'showInformationMessage' ? () => Promise.resolve('Reload Window') : any()) });
    const origLoad = Module._load;
    Module._load = function (req, ...rest) { return req === 'vscode' ? vscode : origLoad.call(this, req, ...rest); };
    delete require.cache[bundle];
    let threw = null;
    try {
      require(bundle).activate({ subscriptions: [], globalState: { get: (_k, d) => d, update: () => Promise.resolve() } });
    } catch (e) {
      threw = e; // the stand-ins cannot carry a full activation; how far it got is what is asserted
    } finally {
      Module._load = origLoad;
      delete require.cache[bundle];
    }
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5)); // the retirement runs async
    return { calls, registered, threw };
  };
  const installed = new Set(['cell-observatory.claude-observatory-vscode', 'cell-observatory.oak-observatory-vscode']);
  const first = await activateWith(installed);
  assert.deepEqual(first.calls.filter(([c]) => c === 'workbench.extensions.uninstallExtension').map(([, id]) => id),
    ['cell-observatory.claude-observatory-vscode'], 'the pre-rename id is uninstalled, once, and the running build is not');
  assert.equal(first.threw, null, 'the retirement window activates without error');
  assert.deepEqual(first.calls.filter(([c]) => c === 'workbench.action.reloadWindow').length, 1, 'one reload finishes the move');
  assert.deepEqual(first.registered, [], 'nothing is registered beside the old build');
  const second = await activateWith(installed);
  assert.ok(!second.calls.some(([c]) => c === 'workbench.extensions.uninstallExtension'), 'after the reload nothing is uninstalled again');
  assert.ok(second.registered.length > 0, 'and the new build goes on to register its commands');
});
