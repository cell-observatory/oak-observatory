import * as core from '@oak-observatory/core';

/** An opt-in plan, with no writes until --yes or the terminal's final confirmation. */
export async function cmdAgentSetup(args: string[]): Promise<void> {
  const project = args.includes('--project') ? process.cwd() : undefined;
  const remove = args.includes('--remove');
  const check = args.includes('--check');
  const json = args.includes('--json');
  const yes = args.includes('--yes');
  const warnings: string[] = [];
  if (!core.findHerdrBin()) warnings.push('herdr is not installed; run oak doctor --fix');
  else try { await core.herdrSnapshot({ timeoutMs: 1000 }); } catch { warnings.push('herdr is not running or compatible; run oak doctor --fix'); }
  let plan = core.agentSetupPlan({ project, remove });
  const terminal = !!process.stdin.isTTY && !!process.stdout.isTTY && !json;
  if (!check && !remove && !yes && terminal && !require('fs').existsSync(plan.manifest)) {
    const defaults = core.agentSetupDefaults(project);
    const rl = require('node:readline/promises').createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (const kind of ['claude', 'codex'] as const) {
        const one = defaults[kind] ??= {};
        for (const key of ['model', 'effort'] as const) {
          const answer = (await rl.question(`${kind} ${key} [${one[key] ?? 'CLI default'}]: `)).trim();
          if (answer) one[key] = answer;
        }
      }
      const roots = defaults.codex?.writableRoots ?? [];
      process.stdout.write('Codex always receives the agent output folder as a writable root.\n');
      if (roots.length) {
        const answer = (await rl.question(`Allow these existing build caches: ${roots.join(', ')}? [Y/n] `)).trim();
        if (/^n/i.test(answer)) defaults.codex!.writableRoots = [];
      }
    } finally { rl.close(); }
    plan = core.agentSetupPlan({ project, defaults });
  }
  const output = () => {
    if (json) process.stdout.write(JSON.stringify({ ...plan, warnings }, null, 2) + '\n');
    else {
      for (const e of plan.items) process.stdout.write(`${e.state}: ${e.path} (${e.part})${e.state === 'edited' ? ' — user-edited; left unchanged' : ''}\n`);
      process.stdout.write(`${remove ? 'Remove managed entries from' : 'Manage ownership in'} ${plan.manifest}\n`);
      for (const warning of warnings) process.stdout.write(`${warning}\n`);
    }
  };
  if (check) { output(); return; }
  if (!yes) {
    output();
    if (!terminal) { process.stderr.write('No files written. Use --yes to apply this plan, or --check to inspect it.\n'); process.exitCode = 1; return; }
    const rl = require('node:readline/promises').createInterface({ input: process.stdin, output: process.stdout });
    let accepted = false;
    try { accepted = /^y(?:es)?$/i.test((await rl.question(`${remove ? 'Remove' : 'Write'} the listed OAK content? [y/N] `)).trim()); }
    finally { rl.close(); }
    if (!accepted) return;
  }
  core.applyAgentSetup(plan);
  output();
}
