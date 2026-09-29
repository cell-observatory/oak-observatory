// Plain child process with file-backed stdio: no sockets and no nested test runner.
const fs = require('node:fs');
const path = require('node:path');
const dist = process.env.OAK_DERIVE_TEST_DIST || path.resolve(__dirname, '../../dist');
if (process.env.OAK_DERIVE_FIXED_NOW) Date.now = () => Number(process.env.OAK_DERIVE_FIXED_NOW);
if (process.env.OAK_DERIVE_CWD) process.chdir(process.env.OAK_DERIVE_CWD);
const core = require(dist);
// Historical reference builds predate the batch scope; this shim changes no payload semantics.
core.withDerivedInventory ??= build => build();
if (process.env.OAK_DERIVE_REQUIRE_INVENTORY === '1') {
  let depth = 0;
  const scope = core.withDerivedInventory;
  const wrapped = build => scope(() => { depth++; try { return build(); } finally { depth--; } });
  require(path.join(dist, 'derived.js')).withDerivedInventory = wrapped;
  if (!Object.getOwnPropertyDescriptor(core, 'withDerivedInventory').get) core.withDerivedInventory = wrapped;
  for (const [file, name] of [['observe.js', 'sessionMeta'], ['processes.js', 'sessionProcesses']]) {
    const owner = require(path.join(dist, file)), read = owner[name];
    owner[name] = (...args) => { if (!depth) throw new Error(`${name} is outside the CLI inventory scope`); return read(...args); };
  }
}
if (process.env.OAK_DERIVE_NO_CACHE === '1') {
  const cache = require(path.join(dist, 'derived-transcript.js'));
  const read = cache.transcriptFacts;
  cache.transcriptFacts = (...args) => cache.withoutTranscriptFactsCache(() => read(...args));
}
if (process.argv[2] === 'cli') {
  const Module = require('node:module'), resolve = Module._resolveFilename;
  // Core is external to this CLI build: resolve the package and its `dist/` subpaths (the CLI requires
  // `dist/cli-entry` at startup, and `dist/capture` on the hook path) from the core under test.
  const sub = '@oak-observatory/core/dist/';
  Module._resolveFilename = function (name, ...args) {
    if (name === '@oak-observatory/core') return path.join(dist, 'index.js');
    if (name.startsWith(sub)) return resolve.call(this, path.join(dist, name.slice(sub.length)), ...args);
    return resolve.call(this, name, ...args);
  };
  const cli = process.argv[3];
  process.argv = [process.execPath, cli, ...process.argv.slice(4)];
  require(cli);
} else {
  const prompts = process.argv[2] === 'prompts', reasoning = process.argv[2] === 'reasoning';
  const dependents = process.argv[2] === 'dependents';
  const file = process.argv[prompts || reasoning || dependents ? 3 : 2];
  const open = fs.openSync, close = fs.closeSync, read = fs.readSync, readFile = fs.readFileSync;
  const fds = new Set(); let bytes = 0;
  fs.openSync = function (p, ...args) { const fd = open.call(this, p, ...args); if (String(p) === file) fds.add(fd); return fd; };
  fs.closeSync = function (fd) { fds.delete(fd); return close.call(this, fd); };
  fs.readSync = function (fd, ...args) { const n = read.call(this, fd, ...args); if (fds.has(fd)) bytes += n; return n; };
  fs.readFileSync = function (p, ...args) { if (String(p) === file) bytes += fs.statSync(file).size; return readFile.call(this, p, ...args); };
  const value = dependents ? core.withDerivedInventory(() => ({
    subagents: core.parseSubagents(process.argv[4], process.argv[5]),
    processes: core.sessionProcesses(process.argv[4], process.argv[5]),
    digests: core.subagentDigests(process.argv[4], process.argv[5]),
  })) : reasoning ? { reasoning: [...core.reasoningByEdit(process.argv[4], process.argv[5])] } : prompts ? { prompts: core.sessionPrompts(process.argv[4], process.argv[5]) } : { actions: core.parseTranscriptActions(file) };
  console.log(JSON.stringify({ bytes, ...value }));
}
