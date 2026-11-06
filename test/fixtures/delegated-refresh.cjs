// Exercise the CLI's refresh composition with the real core and synthetic remote answers, without starting main/ssh.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
let code;

module.exports = function delegatedRefresh(core, agents = []) {
  code ??= ts.transpileModule(fs.readFileSync(path.join(__dirname, '../../packages/cli/src/index.ts'), 'utf8')
    .replace(/main\(\);\s*$/, 'agentOnMachine = remoteReply; module.exports = { delegatedNow, refreshRemoteDelegated };'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const counts = { ids: 0, grouped: 0, ssh: 0 };
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, Buffer, Date, process,
    require: (name) => name === '@oak-observatory/core' ? core : require(name), counts,
    remoteReply: async () => { counts.ssh++; return { code: 0, stdout: JSON.stringify({ agents }), stderr: '' }; },
  });
  vm.runInContext(`
    const iterate = Array.prototype[Symbol.iterator];
    Array.prototype[Symbol.iterator] = function* () {
      for (const value of iterate.call(this)) {
        if (value && value.machine) counts.grouped++;
        yield value;
      }
    };
    const parse = JSON.parse;
    JSON.parse = function (text) {
      const result = parse(text);
      for (const agent of result.agents ?? []) {
        const id = agent.id;
        Object.defineProperty(agent, 'id', { get() { counts.ids++; return id; } });
      }
      return result;
    };
  `, context);
  vm.runInContext(code, context);
  return { ...module.exports, counts };
};
