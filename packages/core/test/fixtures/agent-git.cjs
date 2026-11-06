// A small repository assembled from synthetic Git objects. No git init/add/commit/worktree commands are run.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

module.exports = function agentGit(base) {
  const repository = path.join(base, 'repo'), tree = path.join(base, 'agent-x');
  const dir = path.join(repository, '.git'), admin = path.join(dir, 'worktrees', 'agent-x');
  for (const d of [path.join(dir, 'objects'), path.join(dir, 'refs/heads/oak'), admin, tree]) fs.mkdirSync(d, { recursive: true });
  const hash = b => crypto.createHash('sha1').update(b).digest();
  function object(type, data) {
    data = Buffer.from(data);
    const bytes = Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data]);
    const id = hash(bytes).toString('hex'), target = path.join(dir, 'objects', id.slice(0, 2), id.slice(2));
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, zlib.deflateSync(bytes));
    return id;
  }
  function commit(text, parent) {
    const blob = object('blob', text);
    const tree = object('tree', Buffer.concat([Buffer.from('100644 file.txt\0'), Buffer.from(blob, 'hex')]));
    const id = object('commit', `tree ${tree}\n${parent ? `parent ${parent}\n` : ''}author Fixture <fixture@example.test> 1700000000 +0000\ncommitter Fixture <fixture@example.test> 1700000000 +0000\n\nSynthetic change\n`);
    return { id, blob, text };
  }
  function checkout(c, working, index) {
    fs.writeFileSync(path.join(working, 'file.txt'), c.text);
    const name = Buffer.from('file.txt');
    const entry = Buffer.alloc(Math.ceil((62 + name.length + 1) / 8) * 8);
    entry.writeUInt32BE(0o100644, 24); entry.writeUInt32BE(Buffer.byteLength(c.text), 36);
    Buffer.from(c.blob, 'hex').copy(entry, 40); entry.writeUInt16BE(name.length, 60); name.copy(entry, 62);
    const header = Buffer.alloc(12); header.write('DIRC'); header.writeUInt32BE(2, 4); header.writeUInt32BE(1, 8);
    const bytes = Buffer.concat([header, entry]); fs.writeFileSync(index, Buffer.concat([bytes, hash(bytes)]));
  }
  const initial = commit('one\n');
  fs.writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(dir, 'refs/heads/main'), initial.id + '\n');
  fs.writeFileSync(path.join(dir, 'refs/heads/oak/agent-x'), initial.id + '\n');
  fs.writeFileSync(path.join(tree, '.git'), `gitdir: ${admin}\n`);
  fs.writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/oak/agent-x\n');
  fs.writeFileSync(path.join(admin, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(admin, 'gitdir'), path.join(tree, '.git') + '\n');
  checkout(initial, repository, path.join(dir, 'index')); checkout(initial, tree, path.join(admin, 'index'));
  return { repository, tree, initial, commit,
    agent(c) { fs.writeFileSync(path.join(dir, 'refs/heads/oak/agent-x'), c.id + '\n'); checkout(c, tree, path.join(admin, 'index')); },
    main(c) { fs.writeFileSync(path.join(dir, 'refs/heads/main'), c.id + '\n'); checkout(c, repository, path.join(dir, 'index')); },
  };
};
