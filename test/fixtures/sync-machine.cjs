// Preloaded (`node --require`) into each fake machine's `oak` in the sync tests: it stands in for what one test host
// cannot vary per machine, and records what the process touched.
// - OAK_TEST_USER: the account the machine runs as (os.userInfo().username), so one can be a shared lab account.
// - OAK_TEST_MOUNTS_FILE: the machine's mount table, in /proc/mounts form; read in place of /proc/mounts, and printed
//   in macOS's `mount` form when OAK asks `/sbin/mount` there.
// - OAK_TEST_ACCESS_LOG: every path the process opened, read, listed, stat'ed or resolved is appended here at exit,
//   one per line as `<call> <path>`, so a test can show what a command never touched.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const user = process.env.OAK_TEST_USER;
if (user) {
  const real = os.userInfo;
  os.userInfo = function (opts) { return { ...real.call(os, opts), username: user }; };
}

const mountsFile = process.env.OAK_TEST_MOUNTS_FILE;
const origRead = fs.readFileSync;
if (mountsFile) {
  const table = () => origRead.call(fs, mountsFile, 'utf8');
  fs.readFileSync = function (p, ...rest) {
    if (p === '/proc/mounts' || p === '/proc/self/mounts') {
      const enc = typeof rest[0] === 'string' ? rest[0] : rest[0] && rest[0].encoding;
      return enc ? table() : Buffer.from(table());
    }
    return origRead.call(fs, p, ...rest);
  };
  const origSpawnSync = cp.spawnSync;
  cp.spawnSync = function (file, ...rest) {
    if (file === '/sbin/mount') {
      const out = table().split('\n').filter(Boolean).map((l) => {
        const [source, mount, type] = l.split(/\s+/);
        return `${source} on ${mount} (${type === 'cifs' ? 'smbfs' : type}, nodev, nosuid)`;
      }).join('\n') + '\n';
      return { status: 0, stdout: out, stderr: '', pid: 0, output: [null, out, ''], signal: null };
    }
    return origSpawnSync.call(cp, file, ...rest);
  };
}

const log = process.env.OAK_TEST_ACCESS_LOG;
if (log) {
  const seen = [];
  const note = (call, p) => {
    try {
      if (typeof p === 'number') return;
      seen.push(`${call} ${path.resolve(Buffer.isBuffer(p) ? p.toString() : p instanceof URL ? p.pathname : String(p))}`);
    } catch { /* not a path */ }
  };
  for (const name of ['openSync', 'readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'accessSync', 'opendirSync', 'readlinkSync', 'realpathSync']) {
    const orig = fs[name];
    const wrapped = function (p, ...rest) { note(name, p); return orig.call(fs, p, ...rest); };
    if (orig.native) wrapped.native = function (p, ...rest) { note(name, p); return orig.native.call(fs, p, ...rest); };
    fs[name] = wrapped;
  }
  for (const name of ['open', 'readFile', 'readdir', 'stat', 'lstat', 'access', 'opendir', 'realpath']) {
    const orig = fs.promises[name];
    fs.promises[name] = function (p, ...rest) { note(name, p); return orig.call(fs.promises, p, ...rest); };
  }
  const append = fs.appendFileSync;
  process.on('exit', () => {
    try { append.call(fs, log, seen.map((s) => `${s}\n`).join('')); } catch { /* the log's folder is gone */ }
  });
}
