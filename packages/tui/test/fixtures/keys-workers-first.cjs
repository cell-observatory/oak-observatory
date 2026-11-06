// Deliver Workers before the session catalog, as two independent CLI reads can finish under load.
// The fixture's empty transcript has no title: once Workers arrive its stable label is `ws`.
if (process.argv[2] === 'tui') {
  const cp = require('node:child_process');
  const spawn = cp.spawn;
  const held = [];
  let workers = false;
  const release = () => setImmediate(() => {
    workers = true;
    for (const stream of held.splice(0)) stream.resume();
  });
  cp.spawn = function (file, args, ...rest) {
    const child = spawn.call(this, file, args, ...rest);
    if (args[1] === 'views' && !workers) {
      child.stdout.pause(); held.push(child.stdout);
      if (child.stdin) {
        const write = child.stdin.write.bind(child.stdin);
        child.stdin.write = function (line, ...options) {
          if (String(line).includes('"fleet"')) {
            child.stdout.once('data', release);
            child.stdout.resume();
          }
          return write(line, ...options);
        };
      }
    }
    if (args[1] === 'fleet') child.once('close', release);
    return child;
  };
}
