// Preloaded (`node --require`) into `oak usage --pull-machines`: a saved machine's 30-second deadline
// (MACHINE_USAGE_ASK_MS) passes after 1.5 s, so a test can watch it stop an ssh that stalls.
const setTimeoutReal = global.setTimeout;
global.setTimeout = function (fn, ms, ...args) {
  return setTimeoutReal.call(this, fn, ms === 30_000 ? 1_500 : ms, ...args);
};
