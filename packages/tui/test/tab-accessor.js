/**
 * `state.panes` is an accessor onto the active tab, not storage.
 *
 * That is the whole reason real tabs landed without touching the ~28 sites that read and rebuild
 * `state.panes`, so it is the thing most worth pinning: if a refactor ever turns it back into a
 * plain property (a spread does exactly that, silently), every tab shares one workspace and the
 * product looks like tab switching does nothing.
 */
const assert = require('node:assert');

// The accessor pattern itself, exercised the way app.ts builds it. This is a MODEL of the runtime
// wiring rather than a reach into it — `runTui` needs a TTY, a store and a backend to construct.
function makeState(tabs) {
  let active = 0;
  return {
    get panes() {
      return tabs[active].panes;
    },
    set panes(v) {
      if (v) tabs[active].panes = v;
    },
    get tabs() {
      return tabs;
    },
    get activeTab() {
      return active;
    },
    set activeTab(i) {
      active = Math.max(0, Math.min(i, tabs.length - 1));
    },
  };
}

const tabs = [
  { id: 'observatory', kind: 'panes', name: 'observatory', panes: { focus: 'dashboards', sizes: {} } },
  { id: 'review', kind: 'panes', name: 'review', panes: { focus: 'traces', sizes: {} } },
  { id: 'agent', kind: 'agent', name: 'agent', panes: { focus: 'claude', sizes: {} } },
];
const state = makeState(tabs);

// READ-THROUGH: each tab shows its own workspace.
assert.strictEqual(state.panes.focus, 'dashboards', 'tab 0 is the observatory workspace');
state.activeTab = 1;
assert.strictEqual(state.panes.focus, 'traces', 'switching tabs switches workspace');
state.activeTab = 2;
assert.strictEqual(state.panes.focus, 'claude', 'the agent tab has its own focus');

// WRITE-THROUGH via the exact idiom every call site uses.
state.activeTab = 1;
state.panes = { ...state.panes, sizes: { traces: 50 } };
assert.deepStrictEqual(tabs[1].panes.sizes, { traces: 50 }, 'the write landed on the active tab');
assert.deepStrictEqual(tabs[0].panes.sizes, {}, 'and NOT on any other tab');
assert.deepStrictEqual(tabs[2].panes.sizes, {}, 'and NOT on any other tab');

// A drag in one tab must not move a pane in another — the failure that makes tabs feel fake.
state.activeTab = 0;
state.panes = { ...state.panes, sizes: { dashboards: 14 } };
assert.deepStrictEqual(tabs[1].panes.sizes, { traces: 50 }, 'review kept its own dragged width');

// activeTab clamps rather than throwing: a persisted index from a build with more tabs must not
// index off the end and blank the frame.
state.activeTab = 99;
assert.strictEqual(state.activeTab, tabs.length - 1, 'an out-of-range tab index clamps');
state.activeTab = -5;
assert.strictEqual(state.activeTab, 0, 'a negative tab index clamps');

// NEGATIVE CONTROL: prove the assertions above can fail. A spread copy is the realistic regression
// — it evaluates the getter once and freezes the value — and it must break read-through.
const frozen = { ...state };
state.activeTab = 1;
assert.notStrictEqual(
  frozen.panes.focus, state.panes.focus,
  'HARNESS IS BLIND: a spread-copied state should NOT track the active tab');

console.log('tab accessor: read-through, write-through, isolation, clamping, and the spread trap — all pinned');
