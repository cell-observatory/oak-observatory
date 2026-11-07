// Preloaded only into the remote follower, not its snapshot children. The test advances the ten-second
// poll after writing the worker's end, so neither startup nor fixture writes race a wall-clock interval.
const setTimeoutReal = global.setTimeout;
global.setTimeout = function (fn, ms, ...args) {
  if (ms !== 10000) return setTimeoutReal.call(this, fn, ms, ...args);
  const timer = setTimeoutReal(fn, 2 ** 31 - 1, ...args);
  process.once('message', message => {
    require('node:assert/strict').equal(message, 'poll');
    clearTimeout(timer);
    setTimeoutReal(fn, 0, ...args);
  });
  process.channel.unref(); // completion or cancellation must still let the follower exit
  process.send({ pollMs: ms });
  return timer;
};
