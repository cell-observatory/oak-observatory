const fs = require('node:fs');
const path = require('node:path');

// The signatures Git requires, without invoking git init or changing the source checkout's index.
function gitDir(dir) {
  for (const name of ['objects', 'refs']) fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n');
}

module.exports = { gitDir };
