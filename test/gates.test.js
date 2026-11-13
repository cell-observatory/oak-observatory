const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const installerCalls = [
  ['install.sh', /^\s*"\$\{CO\[@\]\}"\s+doctor\s+--fix(?:\s|$)/m],
  ['install.ps1', /^\s*&\s+oak\s+doctor\s+--fix(?:\s|$)/m],
  ['scripts/bootstrap.sh', /^\s*oak\s+doctor\s+--fix(?:\s|$)/m],
];

for (const [file, call] of installerCalls) {
  function check(source) {
    assert.match(source, call, `${file} must execute doctor --fix (a comment does not install herdr)`);
  }
  test(`installer repair gate: ${file} calls doctor --fix`, () => check(read(file)));
  test(`installer repair gate: removal of --fix from a copy of ${file} fails`, () => {
    const baseline = read(file);
    check(baseline);
    const mutant = baseline.replace(call, match => match.replace('--fix', ''));
    assert.notEqual(mutant, baseline);
    assert.throws(() => check(mutant), /must execute doctor --fix/);
  });
}

// bootstrap.sh, run for real against fake curl/npm/oak. PATH holds those fakes plus the real tools the
// script uses, and nothing else, so a Linux run sees no python3, make or g++.
const cp = require('node:child_process');
const os = require('node:os');
const crypto = require('node:crypto');
function realTool(name) {
  for (const dir of String(process.env.PATH).split(path.delimiter)) {
    const file = path.join(dir, name);
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch { /* next */ }
  }
  throw new Error(`${name} is not on PATH`);
}
function runBootstrap(t, { npmFails = false, pty = false, digest, plugin = true, tools = false, args = [], pre = null, stableFails = false } = {}) {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-bootstrap-'));
  t.after(() => fs.rmSync(box, { recursive: true, force: true }));
  const bin = path.join(box, 'bin');
  fs.mkdirSync(bin);
  for (const tool of ['mktemp', 'rm', 'grep', 'head', 'sed', 'node', 'uname', 'cat', 'cp', 'mkdir', 'touch', 'basename']) fs.symlinkSync(realTool(tool), path.join(bin, tool));
  const tgz = path.join(box, 'release.tgz');
  fs.writeFileSync(tgz, 'fixture tarball bytes');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
  const json = path.join(box, 'release.json');
  // With a pre-release, the release's notes run past the 128 KiB one argument or environment variable holds on Linux,
  // as 0.11.0's do (131,125 bytes of JSON).
  fs.writeFileSync(json, JSON.stringify({ tag_name: 'v9.9.9', ...(pre ? { body: 'notes '.repeat(25000) } : {}), assets: [{ name: 'oak-observatory-9.9.9.tgz',
    digest: `sha256:${digest ?? sha}`, browser_download_url: 'https://fixture.invalid/oak-observatory-9.9.9.tgz' }] }));
  // The rolling pre-release, as dev-release.yml publishes it: a fixed tag, its version in the name.
  const preJson = path.join(box, 'pre.json');
  if (pre) fs.writeFileSync(preJson, JSON.stringify({ tag_name: 'dev-latest', name: `Pre-release ${pre} (rolling, from dev)`, prerelease: true,
    assets: [{ name: 'oak-observatory-cli-dev.tgz', digest: `sha256:${sha}`, browser_download_url: 'https://fixture.invalid/oak-observatory-cli-dev.tgz' }] }));
  // npm 11 and later print a UUID-shaped path segment as ***, `npm root -g` included; a script npm runs
  // is handed the real prefix.
  const npmPrefix = path.join(box, 'prefix-00000000-0000-4000-8000-000000000000');
  const npmRoot = path.join(npmPrefix, 'lib', 'node_modules');
  const log = path.join(box, 'calls.log');
  // What npm 12 leaves when it skips node-pty's build script: the package, with no build/ and no binary.
  if (pty === 'unbuilt') {
    const nodePty = path.join(npmRoot, 'oak-observatory', 'node_modules', 'node-pty');
    fs.mkdirSync(nodePty, { recursive: true });
    fs.writeFileSync(path.join(nodePty, 'package.json'), '{"name":"node-pty"}');
    fs.writeFileSync(path.join(nodePty, 'index.js'), 'throw new Error("no pty.node")');
  }
  if (tools) for (const tool of ['python3', 'make', 'g++']) fs.writeFileSync(path.join(bin, tool), '#!/bin/sh\n', { mode: 0o755 });
  const script = (body) => `#!/bin/sh\nprintf '%s\\n' "$(basename "$0") $*" >> "${log}"\n${body}\n`;
  fs.writeFileSync(path.join(bin, 'curl'), script(`out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -H) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac; done
case "$url" in *releases/tags/dev-latest) cat "${preJson}" ;; *releases/latest) ${stableFails ? 'exit 22' : `cat "${json}"`} ;; *api.github.com*) cat "${json}" ;; *) cp "${tgz}" "$out" ;; esac`), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), script(`case "$1" in
  ls) exit 1 ;;
  root) printf '%s\\n' "${npmRoot.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/, '***')}" ;;
  exec) while [ $# -gt 0 ] && [ "$1" != -c ]; do shift; done; npm_config_global_prefix="${npmPrefix}" /bin/sh -c "$2" ;;
  i) ${npmFails ? 'echo "npm error code EEXIST" >&2; exit 1' : `pkg="${npmRoot}/oak-observatory"; mkdir -p "$pkg/dist/herdr-plugin"; touch "$pkg/dist/THIRD_PARTY_NOTICES.md"
     ${plugin ? 'touch "$pkg/dist/herdr-plugin/herdr-plugin.toml"' : ''}
     ${pty === true ? 'mkdir -p "$pkg/node_modules/node-pty"; echo "module.exports = {}" > "$pkg/node_modules/node-pty/index.js"' : ''}`} ;;
esac`), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'oak'), script(''), { mode: 0o755 });
  const r = cp.spawnSync(realTool('bash'), [path.join(root, 'scripts/bootstrap.sh'), ...args], {
    encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: bin, HOME: box, TMPDIR: box },
  });
  return { ...r, out: r.stdout + r.stderr, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

test('bootstrap: verifies the tarball, installs with --allow-scripts=node-pty and npm errors visible, and says when node-pty did not build', { skip: process.platform === 'win32' && 'POSIX bash' }, t => {
  const r = runBootstrap(t);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /sha256 verified/);
  const install = r.calls.split('\n').find((l) => /^npm i -g /.test(l));
  assert.match(install, /--allow-scripts=node-pty/, 'npm 12 blocks node-pty\'s install script without it');
  assert.doesNotMatch(install, /--silent/, 'npm must be able to say EEXIST or why a build failed');
  assert.match(r.out, /node-pty did not build, so OAK's herdr tab has no terminal on this machine[^\n]*'oak attach' opens herdr without it/);
  if (process.platform === 'linux') assert.match(r.out, /needs python3, make and a C\+\+ compiler \(g\+\+\) — missing: python3 make g\+\+\. Install them, then re-run this script\./);
  assert.match(r.calls, /^oak doctor --fix$/m, 'the rest of the install still runs');
  const built = runBootstrap(t, { pty: true });
  assert.equal(built.status, 0, built.out);
  assert.doesNotMatch(built.out, /node-pty did not build/, 'a node-pty that loads is not reported');
});

test('bootstrap: the dev channel installs the newer of the pre-release and the latest release, as `oak update` does', { skip: process.platform === 'win32' && 'POSIX bash' }, t => {
  const fetched = (r) => (/^curl .*?(https:\/\/fixture\.invalid\/\S+\.tgz)/m.exec(r.calls) || [])[1];
  // Right after a release, before the next push to dev: 9.9.9 outranks 9.9.9-dev.4.
  const promoted = runBootstrap(t, { args: ['--channel', 'dev'], pre: '9.9.9-dev.4' });
  assert.equal(promoted.status, 0, promoted.out);
  assert.equal(fetched(promoted), 'https://fixture.invalid/oak-observatory-9.9.9.tgz');
  assert.match(promoted.out, /The latest release is newer than the pre-release, so the dev channel installs it\.[\s\S]*Release: v9\.9\.9  \(channel: dev\)/);
  // A pre-release ahead of the release, and one with no release to compare it with: the pre-release.
  for (const opts of [{ pre: '9.10.0-dev.1' }, { pre: '9.9.9-dev.4', stableFails: true }]) {
    const r = runBootstrap(t, { args: ['--channel', 'dev'], ...opts });
    assert.equal(r.status, 0, r.out);
    assert.equal(fetched(r), 'https://fixture.invalid/oak-observatory-cli-dev.tgz', JSON.stringify(opts));
    assert.match(r.out, /Release: dev-latest  \(channel: dev\)/);
  }
  // The stable channel asks for the release alone.
  const stable = runBootstrap(t, { pre: '9.10.0-dev.1' });
  assert.equal(fetched(stable), 'https://fixture.invalid/oak-observatory-9.9.9.tgz');
  assert.doesNotMatch(stable.calls, /dev-latest/);
});

test('bootstrap: an unbuilt node-pty is blamed on npm\'s script policy, and tools already here are not asked for', { skip: process.platform !== 'linux' && 'the build check is Linux-only' }, t => {
  const blocked = runBootstrap(t, { pty: 'unbuilt' });
  assert.equal(blocked.status, 0, blocked.out);
  // Re-running an install keeps the unbuilt package; the rebuild runs its script.
  assert.match(blocked.out, /npm installed node-pty without running its build script: npm 12 runs only the install scripts it is told to allow, and no npm runs them while ignore-scripts is set\. The build also needs python3, make and a C\+\+ compiler \(g\+\+\) — missing: python3 make g\+\+\. Install them, then build it with 'npm rebuild -g node-pty --allow-scripts=node-pty --ignore-scripts=false'\./);
  assert.match(runBootstrap(t, { pty: 'unbuilt', tools: true }).out, /while ignore-scripts is set\. Build it with 'npm rebuild -g node-pty --allow-scripts=node-pty --ignore-scripts=false'\./);
  const failed = runBootstrap(t, { tools: true });
  assert.match(failed.out, /compiles from source with python3, make and a C\+\+ compiler \(g\+\+\), all of which are here: re-run this script\./);
  assert.doesNotMatch(failed.out, /Install them/);
});

test('bootstrap: a failed global install names EEXIST, and a bad checksum or an incomplete release stops before anything runs', { skip: process.platform === 'win32' && 'POSIX bash' }, t => {
  const eexist = runBootstrap(t, { npmFails: true });
  assert.equal(eexist.status, 0, 'the other components still install');
  assert.match(eexist.out, /Global install failed\. If npm said EEXIST, another global package already owns one of OAK's commands \(oak, oak-observatory, claude-observatory\)/);
  assert.doesNotMatch(eexist.out, /node-pty did not build/, 'no second warning for a package that never installed');
  const tampered = runBootstrap(t, { digest: '0'.repeat(64) });
  assert.equal(tampered.status, 1, tampered.out);
  assert.match(tampered.out, /Integrity check FAILED for the CLI tarball/);
  assert.doesNotMatch(tampered.calls, /^npm i /m, 'npm never runs the install scripts of an unverified tarball');
  const partial = runBootstrap(t, { plugin: false });
  assert.equal(partial.status, 1, partial.out);
  assert.match(partial.out, /Missing release artifact: .*dist\/herdr-plugin\/herdr-plugin\.toml/);
});

test('installers: a failed or missing oak at the hooks prompt does not end the script before the health check', { skip: process.platform === 'win32' && 'POSIX bash' }, () => {
  // The prompt branch only runs at a TTY, so run the branch itself: the `case` block as each script has it.
  const branch = (file) => { const s = read(file); const at = s.indexOf('case "$ans" in'); return s.slice(at, s.indexOf('esac', at) + 4); };
  for (const [file, setup] of [['scripts/bootstrap.sh', 'true'], ['install.sh', 'CO=(oak-missing-fixture)']]) {
    const r = cp.spawnSync(realTool('bash'), ['-c', `set -euo pipefail; warn() { echo "warn: $1"; }; say() { :; }; ${setup}; ans=y\n${branch(file)}\necho reached-health-check`], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
    assert.equal(r.status, 0, `${file}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /warn: 'oak init' did not finish/, file);
    assert.match(r.stdout, /reached-health-check/, file);
  }
});

test('install.sh and bootstrap.sh stop on a Node.js older than 24, before they install anything', { skip: process.platform === 'win32' && 'POSIX bash' }, t => {
  // OAK supports Node.js 24 and later (core INDEX_NODES, which these checks agree with); 22.16 runs the index too, but is
  // not supported. Each script's npm here logs each call and fails, so a run ends at its first one; bootstrap.sh's curl
  // does the same.
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-install-node-'));
  t.after(() => fs.rmSync(box, { recursive: true, force: true }));
  fs.copyFileSync(path.join(root, 'install.sh'), path.join(box, 'install.sh'));
  fs.copyFileSync(path.join(root, 'scripts', 'bootstrap.sh'), path.join(box, 'bootstrap.sh'));
  const bin = path.join(box, 'bin'), log = path.join(box, 'npm.log');
  fs.mkdirSync(bin);
  for (const tool of ['dirname', 'mktemp', 'rm', 'uname']) fs.symlinkSync(realTool(tool), path.join(bin, tool));
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\necho "npm $*" >> '${log}'\nexit 1\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\necho "curl $*" >> '${log}'\nexit 1\n`, { mode: 0o755 });
  const run = (script, version) => {
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\n[ "$1" = -v ] && echo ${version}\n`, { mode: 0o755 });
    fs.rmSync(log, { force: true });
    const r = cp.spawnSync(realTool('bash'), [path.join(box, script)], { cwd: box, encoding: 'utf8', env: { PATH: bin } });
    return { status: r.status, out: r.stdout + r.stderr, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
  };
  const core = require(path.join(root, 'packages/core/dist/index.js'));
  const refused = ['v22.16.0', 'v22.23.4', 'v22.15.0', 'v20.19.0', 'v18.20.4', 'v23.0.0', 'v23.11.1'];
  const taken = ['v24.0.0', 'v24.18.0', 'v26.13.0'];
  for (const version of [...refused, ...taken]) assert.equal(core.nodeRunsIndex(version), taken.includes(version), `the index's own rule: ${version}`);
  // `engines`, which npm checks with this same semver, as npm calls it (npm-install-checks: includePrerelease), takes
  // exactly those. (semver is no dependency of this repository's own: npm hoists it from the toolchain's, and the require
  // fails loudly if it goes.)
  const engines = JSON.parse(read('packages/cli/package.json')).engines.node;
  for (const version of [...refused, ...taken]) assert.equal(require('semver').satisfies(version, engines, { includePrerelease: true }), taken.includes(version), `engines ${engines}: ${version}`);
  // install.ps1, which no run here executes (nor does CI), holds the same rule and words.
  assert.match(read('install.ps1'), /if \(\[int\]\(\$nodeParts\[0\]\) -lt 24\) \{/);
  assert.ok(read('install.ps1').includes('OAK needs Node.js 24 or newer, and this is Node.js $nodeVersion.'));
  for (const script of ['install.sh', 'bootstrap.sh']) {
    for (const version of refused) {
      const r = run(script, version);
      assert.equal(r.status, 1, `${script} ${version}: ${r.out}`);
      assert.ok(r.out.includes('needs Node.js 24 or newer') && r.out.includes(`this is Node.js ${version}.`), `${script} ${version}: ${r.out}`);
      assert.equal(r.log, '', `${script} ${version}: nothing is installed`);
    }
  }
  for (const version of taken) {
    assert.equal(run('install.sh', version).log, 'npm install --silent\n', `${version}: the install goes on`);
    assert.match(run('bootstrap.sh', version).log, /^curl /, `${version}: the bootstrap goes on to download the release`);
  }
});

test('release.sh tells recipients to install the tarball with --allow-scripts=node-pty, which npm 12 needs to build it', () => {
  const installs = read('scripts/release.sh').split('\n').filter((line) => /npm i(?:nstall)? -g/.test(line));
  assert.ok(installs.length > 0, 'release.sh names the install command');
  for (const line of installs) assert.match(line, /--allow-scripts=node-pty/, line);
});

test('install.sh: an unbuilt node-pty is built by a rebuild in the checkout, not by re-running the installer', { skip: process.platform !== 'linux' && 'the build check is Linux-only' }, t => {
  // Re-running ./install.sh runs `npm install` again, which keeps the unbuilt package (npm 10.9.9 and 12.1.0).
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-install-pty-'));
  t.after(() => fs.rmSync(box, { recursive: true, force: true }));
  // What an ignore-scripts `npm install` leaves: node-pty hoisted into the checkout, with no build/.
  const nodePty = path.join(box, 'node_modules', 'node-pty');
  fs.mkdirSync(nodePty, { recursive: true });
  fs.mkdirSync(path.join(box, 'packages', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(nodePty, 'package.json'), '{"name":"node-pty"}');
  fs.writeFileSync(path.join(nodePty, 'index.js'), 'throw new Error("no pty.node")');
  const s = read('install.sh'), at = s.indexOf('pty_check() {');
  const call = s.split('\n').find((l) => l.startsWith('pty_check "$PWD/packages/cli"'));
  const r = cp.spawnSync(realTool('bash'), ['-c', `set -euo pipefail; warn() { echo "$1"; }\n${s.slice(at, s.indexOf('\n}\n', at) + 3)}\n${call}`],
    { cwd: box, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`uild it with 'npm rebuild node-pty --ignore-scripts=false' in ${box}.`), r.stdout);
  assert.doesNotMatch(r.stdout, /re-run \.\/install\.sh/);
});

test('no product message installs oak-observatory from the npm registry, where it is not published', () => {
  // `npm view oak-observatory` answers E404: the releases ship GitHub assets only. Doctor's node-pty advice
  // and `oak init --project`'s note named `npm install -g … oak-observatory`, which fails there.
  const registry = /\bnpm (?:i|install) (?:[^\n'"`]* )?oak-observatory(?![\w./-])/;
  assert.match('Reinstall with `npm install -g --allow-scripts=node-pty oak-observatory`, or', registry, 'control: the base doctor text is caught');
  assert.doesNotMatch('npm i -g ./packages/cli', registry, 'control: a local package is not');
  const files = ['install.sh', 'install.ps1', 'scripts/bootstrap.sh'];
  for (const dir of ['packages/cli/src', 'packages/core/src', 'packages/tui/src', 'packages/vscode/src'])
    for (const f of fs.readdirSync(path.join(root, dir))) if (/\.ts$/.test(f)) files.push(`${dir}/${f}`);
  const kotlin = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? kotlin(`${dir}/${e.name}`) : /\.kt$/.test(e.name) ? [`${dir}/${e.name}`] : []);
  files.push(...kotlin('packages/jetbrains/src/main'));
  assert.ok(files.length > 50, `the scan reads the product's sources (${files.length} files)`);
  for (const f of files) assert.doesNotMatch(read(f), registry, f);
});

test('hand-install instructions download the release tarball before npm installs it, which npm 12 needs', () => {
  // npm 12 defaults allow-remote to none, so `npm install -g https://github.com/…/oak-observatory-X.Y.Z.tgz`
  // fails with EALLOWREMOTE, while the downloaded ./oak-observatory-X.Y.Z.tgz installs on every npm OAK
  // supports. The notes cannot change once tagged, so the whole CHANGELOG is scanned with the docs.
  const urlInstall = /\bnpm (?:i|install)\b[^\n`'"<]*?\bhttps?:\/\//;
  const joined = (text) => text.replace(/\\\r?\n\s*/g, ' '); // a shell line continued with a backslash
  assert.match(joined('npm install -g --allow-scripts=node-pty \\\n  https://github.com/o/r/releases/download/v1.0.0/p-1.0.0.tgz'), urlInstall, 'control: the base install page is caught');
  assert.doesNotMatch('npm install -g --allow-scripts=node-pty ./oak-observatory-X.Y.Z.tgz', urlInstall, 'control: a downloaded file is not');
  const files = ['CHANGELOG.md', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'install.sh', 'install.ps1', 'scripts/bootstrap.sh',
    'docs/devcontainer/README.md', 'docs/devcontainer/setup.sh', 'packages/cli/statusline/README.md'];
  for (const dir of ['docs', 'docs/_content']) for (const f of fs.readdirSync(path.join(root, dir))) if (/\.(?:html|md)$/.test(f)) files.push(`${dir}/${f}`);
  for (const pkg of fs.readdirSync(path.join(root, 'packages'))) if (fs.existsSync(path.join(root, 'packages', pkg, 'README.md'))) files.push(`packages/${pkg}/README.md`);
  assert.ok(files.includes('docs/_content/install.html') && files.length > 60, `the scan reads the docs (${files.length} files)`);
  for (const f of files) assert.doesNotMatch(joined(read(f)), urlInstall, f);
});

test('the hand upgrade downloads the tarball before it removes claude-observatory, and names curl.exe for Windows PowerShell 5.1', () => {
  // Uninstalling first left a person whose download then failed with no CLI at all, as the installers
  // never do. In Windows PowerShell 5.1 `curl` is an alias of Invoke-WebRequest, which takes none of curl's flags.
  const changelog = read('CHANGELOG.md').split('### Upgrading from claude-observatory')[1].split('\n### ')[0];
  const page = read('docs/_content/install.html');
  const upgrade = page.split('<h2 id="upgrading-from-claude-observatory">')[1].split('<h2')[0];
  for (const [name, text, download] of [['CHANGELOG.md', changelog, 'curl -fLO'], ['install.html', upgrade, 'download the release tarball']]) {
    const at = text.indexOf(download);
    assert.ok(at >= 0 && text.indexOf('npm uninstall -g claude-observatory') > at, `${name}: the download comes before the uninstall`);
  }
  for (const text of [changelog, page]) assert.match(text, /type <code>curl\.exe<\/code>|type `curl\.exe`/);
});

test('the docs state the first-phrase rule Codex titles are cut by: two words and 12 characters', () => {
  // "At least two words" alone promised `Fix CI` for "Fix CI: the Windows lane fails …", which stays whole.
  const least = /c\.length >= (\d+) && \/\\s\/\.test\(c\)/.exec(read('packages/core/src/codex.ts'));
  assert.ok(least, 'codex.ts firstPhrase still reads a phrase as 12 characters and a space');
  for (const file of ['docs/DEMO.md', 'docs/_content/sessions-agents.html'])
    assert.match(read(file).replace(/\s+/g, ' '), new RegExp(`first phrase, up to its first sentence end or clause break[^;]*at least two words and ${least[1]} characters;`), file);
});

test('the releases page summarizes the upgrade the install page gives: a reinstall and oak init', () => {
  const entry = read('docs/_content/releases.html').split('<h2 id="v0-10-0">')[1].split('<h2')[0];
  assert.doesNotMatch(entry, /one step by hand/);
  assert.match(entry, /reinstall[^.]*<code>oak init<\/code>/);
  assert.match(entry, /<strong>Install\.<\/strong>[^<]*<code>python3<\/code>/, 'Linux and macOS need python3, as the changelog says');
});

test('installers: install.sh and bootstrap.sh share one node-pty check', () => {
  const fn = (file) => { const s = read(file); const at = s.indexOf('pty_check() {'); return s.slice(at, s.indexOf('\n}\n', at)); };
  assert.ok(fn('install.sh').length > 100);
  assert.equal(fn('install.sh'), fn('scripts/bootstrap.sh'));
});

// A workflow step's `run: |` block, dedented, found by the step's name.
function stepRun(file, name) {
  const lines = read(file).split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(at >= 0, `${file} has a step named "${name}"`);
  const run = lines.findIndex((l, i) => i > at && /^\s+run: \|$/.test(l));
  const indent = lines[run].indexOf('run:') + 2;
  const body = [];
  for (const l of lines.slice(run + 1)) {
    if (l.trim() && l.search(/\S/) < indent) break;
    body.push(l.slice(indent));
  }
  return body.join('\n');
}
// Runs a step the way GitHub does (bash -eo pipefail) with a fake gh first on PATH, in the checkout or in [cwd].
function runStep(t, block, env, cwd = root) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-gh-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
case "$*" in
  "repo view --json nameWithOwner -q .nameWithOwner") echo "$FAKE_NWO" ;;
  "release view dev-latest --json name -q .name") [ -n "$FAKE_DEV" ] && echo "$FAKE_DEV" || { echo "release not found" >&2; exit 1; } ;;
  "release view --json tagName -q .tagName") [ -n "$FAKE_STABLE" ] && echo "$FAKE_STABLE" || { echo "release not found" >&2; exit 1; } ;;
  "release view dev-latest --json assets -q .assets[].name") printf '%s\\n' $FAKE_ASSETS ;;
  *) echo "unexpected gh $*" >&2; exit 2 ;;
esac
`, { mode: 0o755 });
  const r = cp.spawnSync(realTool('bash'), ['--noprofile', '--norc', '-eo', 'pipefail', '-c', block], {
    cwd, encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, ...env } });
  return { status: r.status, out: r.stdout + r.stderr };
}
const DEV = '.github/workflows/dev-release.yml';

test('dev-release: refuses to publish before the rename, ahead of every build and publish step', { skip: process.platform === 'win32' && 'POSIX bash' }, t => {
  const gate = stepRun(DEV, 'Refuse to publish until the GitHub repo is renamed');
  assert.equal(runStep(t, gate, { FAKE_NWO: 'cell-observatory/claude-observatory' }).status, 1);
  assert.equal(runStep(t, gate, { FAKE_NWO: 'cell-observatory/oak-observatory' }).status, 0);
  const src = read(DEV);
  const gateAt = src.indexOf('- name: Refuse to publish until the GitHub repo is renamed');
  for (const later of ['- run: npm ci', 'gh release delete-asset', 'gh release upload']) assert.ok(gateAt < src.indexOf(later), `the gate runs before ${later}`);
});

test('dev-release: the rolling version must outrank the published pre-release AND the newest stable release', { skip: process.platform === 'win32' && 'POSIX bash' }, t => {
  const guard = stepRun(DEV, 'The rolling version must outrank the published pre-release and stable release');
  const run = (VER, FAKE_DEV, FAKE_STABLE) => runStep(t, guard, { VER, FAKE_DEV, FAKE_STABLE });
  const unbumped = run('0.10.0-dev.15', 'Pre-release 0.10.0-dev.14 (rolling, from dev)', 'v0.10.0');
  assert.equal(unbumped.status, 1, 'a dev build below the promoted stable is never offered to dev installs');
  assert.match(unbumped.out, /does not outrank the published stable release 0\.10\.0/);
  assert.equal(run('0.11.0-dev.1', 'Pre-release 0.10.0-dev.14 (rolling, from dev)', 'v0.10.0').status, 0);
  const backwards = run('0.10.0-dev.13', 'Pre-release 0.10.0-dev.14 (rolling, from dev)', 'v0.9.5');
  assert.equal(backwards.status, 1);
  assert.match(backwards.out, /does not outrank the published pre-release 0\.10\.0-dev\.14/);
  assert.equal(run('0.10.0-dev.1', '', '').status, 0, 'nothing published yet');
});

test('release: a tag at a local build\'s version (-dev.0) is refused before anything is built or published', { skip: process.platform === 'win32' && 'POSIX bash' }, t => {
  // Every `dev` checkout carries X.Y.Z-dev.0, which OAK reads as a local build that no release carries: a
  // release at it would never be offered an update, so the tag check that passes it must refuse it.
  const name = 'Verify the tag matches the committed version';
  const gate = stepRun('.github/workflows/release.yml', name);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-tag-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tagged = (version, tag) => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
    return runStep(t, gate, { GITHUB_REF_NAME: tag }, dir);
  };
  const local = tagged('0.11.0-dev.0', 'v0.11.0-dev.0');
  assert.equal(local.status, 1, local.out);
  assert.match(local.out, /names a local build's version/);
  assert.equal(tagged('0.11.0', 'v0.11.0-dev.0').status, 1);
  for (const [version, tag] of [['0.11.0', 'v0.11.0'], ['0.11.0-dev.10', 'v0.11.0-dev.10']]) {
    const r = tagged(version, tag);
    assert.equal(r.status, 0, `${tag}: ${r.out}`);
  }
  assert.equal(tagged('0.11.0', 'v0.12.0').status, 1, 'a tag that is not the committed version');
  const src = read('.github/workflows/release.yml');
  for (const later of ['- run: npm ci', '- name: Create GitHub Release with artifacts']) assert.ok(src.indexOf(`- name: ${name}`) < src.indexOf(later), `the check runs before ${later}`);
});

test('dev-release: fails when a pre-rename asset is still attached after the upload', { skip: process.platform === 'win32' && 'POSIX bash' }, t => {
  const name = 'No pre-rename asset is left on the rolling release';
  const check = stepRun(DEV, name);
  assert.equal(runStep(t, check, { FAKE_ASSETS: 'oak-observatory-cli-dev.tgz claude-observatory-cli-dev.tgz' }).status, 1);
  assert.equal(runStep(t, check, { FAKE_ASSETS: 'oak-observatory-cli-dev.tgz updatePlugins.xml' }).status, 0);
  assert.ok(read(DEV).indexOf('gh release upload') < read(DEV).indexOf(`- name: ${name}`), 'it checks what the upload left');
});

test('workflows: every setup-node step is the current major, and Pages builds on a supported Node', () => {
  for (const file of fs.readdirSync(path.join(root, '.github/workflows'))) {
    for (const m of read(`.github/workflows/${file}`).matchAll(/actions\/setup-node@(v\d+)/g)) assert.equal(m[1], 'v7', file);
  }
  assert.match(read('.github/workflows/pages.yml'), /setup-node@v7\n\s+with:\n\s+node-version: 24\n/);
});

test('workflows: Gradle and the JDK are set up before release.sh builds the JetBrains plugin, and packaging runs on Node 24', () => {
  // Set up after `npm run release`, the wrapper downloaded Gradle uncached and with no retry. @vscode/vsce 4 and
  // its @azure dependencies need Node 22 or newer; OAK supports 24. vscode.yml runs on a self-hosted runner, which has no default JDK.
  assert.match(read('scripts/release.sh'), /gradlew buildPlugin/, 'release.sh builds the plugin itself');
  for (const [file, steps] of [['release.yml', ['actions/setup-java@', 'gradle/actions/setup-gradle@']],
    ['dev-release.yml', ['actions/setup-java@', 'gradle/actions/setup-gradle@']], ['vscode.yml', ['actions/setup-java@', 'gradle/actions/setup-gradle@']]]) {
    const src = read(`.github/workflows/${file}`), release = src.indexOf('- run: npm run release');
    assert.ok(release > 0, `${file} runs npm run release`);
    for (const step of steps) assert.ok(src.includes(step) && src.indexOf(step) < release, `${file}: ${step} comes before npm run release`);
    assert.match(src, /node-version: 24\n/, `${file} packages the VS Code extension on Node 24`);
  }
});

test('CLI package: ships oak, oak-observatory and the deprecated claude-observatory, and no generic command name', () => {
  // `observatory` belongs to Mozilla's observatory-cli, and npm refuses a whole install whose bin
  // collides with another package's (EEXIST).
  const want = { oak: 'dist/index.js', 'oak-observatory': 'dist/index.js', 'claude-observatory': 'dist/index.js' };
  assert.deepEqual(JSON.parse(read('packages/cli/package.json')).bin, want);
  assert.deepEqual(JSON.parse(read('package-lock.json')).packages['packages/cli'].bin, want);
});

// Every `oak` and every capture hook starts through the launcher (dist/index.js), which keeps Node's compile cache of the
// two bundles in this user's cache folder: a start after the first compiles neither again. Node checks each entry
// against its file's content, so a bundle an update replaced, of the same size and time, runs as it is now.
test('CLI launcher: Node\'s compile cache in this user\'s cache folder; a bundle an update replaced runs as it is, never from the cache', { skip: !require('node:module').enableCompileCache && 'no compile cache in this Node' }, (t) => {
  const launcher = path.join(root, 'packages/cli/dist/index.js');
  assert.ok(fs.statSync(launcher).size < 1000, `the launcher stays under 1,000 bytes (${fs.statSync(launcher).size})`);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oak-launcher-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'dist'));
  fs.copyFileSync(launcher, path.join(dir, 'dist', 'index.js'));
  const bundle = path.join(dir, 'dist', 'cli.js');
  const code = (word) => `process.stdout.write(${JSON.stringify(word)} + ' ' + require('node:module').getCompileCacheDir());\n`;
  fs.writeFileSync(bundle, code('older'));
  const env = { ...process.env, XDG_CACHE_HOME: path.join(dir, 'cache') };
  delete env.NODE_COMPILE_CACHE;
  delete env.NODE_DISABLE_COMPILE_CACHE;
  const run = () => cp.spawnSync(process.execPath, [path.join(dir, 'dist', 'index.js'), '--version'], { encoding: 'utf8', env });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const [word, cacheDir] = first.stdout.split(' ');
  assert.equal(word, 'older');
  assert.equal(path.dirname(cacheDir), path.join(dir, 'cache', 'oak', 'compile-cache'), 'in the cache folder of this user, never the store or a shared /tmp');
  assert.ok(fs.readdirSync(cacheDir).length > 0, 'an entry for the bundle, written at its exit');
  assert.equal(run().stdout.split(' ')[0], 'older', 'control: run again, from the cache');
  // An update: the same size and modification time, other code.
  const st = fs.statSync(bundle);
  fs.writeFileSync(bundle, code('newer'));
  fs.utimesSync(bundle, st.atime, st.mtime);
  assert.equal(fs.statSync(bundle).size, st.size, 'control: the same size');
  assert.equal(run().stdout.split(' ')[0], 'newer', 'the bundle as it is now, never the cached older one');
  // A relative XDG_CACHE_HOME names no cache folder (the XDG spec has it ignored): the home's, never the folder a command or a
  // hook runs in.
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const rel = cp.spawnSync(process.execPath, [path.join(dir, 'dist', 'index.js'), '--version'], { encoding: 'utf8', cwd: dir, env: { ...env, XDG_CACHE_HOME: 'rel-cache', HOME: home, USERPROFILE: home } });
  assert.equal(rel.status, 0, rel.stderr);
  assert.equal(path.dirname(rel.stdout.split(' ')[1]), path.join(home, '.cache', 'oak', 'compile-cache'));
  assert.equal(fs.existsSync(path.join(dir, 'rel-cache')), false, 'nothing in the folder it ran in');
  // Nor is an empty HOME a home: no cache, and nothing in the folder it ran in.
  const bare = cp.spawnSync(process.execPath, [path.join(dir, 'dist', 'index.js'), '--version'], { encoding: 'utf8', cwd: dir, env: { ...env, XDG_CACHE_HOME: '', HOME: '', USERPROFILE: '' } });
  assert.equal(bare.status, 0, bare.stderr);
  assert.equal(bare.stdout, 'newer undefined', 'no compile cache');
  assert.equal(fs.existsSync(path.join(dir, '.cache')), false, 'nothing in the folder it ran in');
  // A home Node cannot tell (os.homedir throws: no HOME, and no account entry for the user): no cache, and the start goes on.
  const homeless = path.join(dir, 'no-homedir.cjs');
  fs.writeFileSync(homeless, "require('os').homedir = () => { throw Object.assign(new Error('no home'), { code: 'ERR_SYSTEM_ERROR' }); };\n");
  const thrown = cp.spawnSync(process.execPath, ['--require', homeless, path.join(dir, 'dist', 'index.js'), '--version'], { encoding: 'utf8', env: { ...env, XDG_CACHE_HOME: '' } });
  assert.equal(thrown.status, 0, thrown.stderr);
  assert.equal(thrown.stdout, 'newer undefined', 'no compile cache');
  // A cache folder Node's recursive mkdir would never return under (a folder that answers ENOENT to a mkdir): no cache,
  // and the start goes on.
  if (process.platform === 'linux') {
    const proc = cp.spawnSync(process.execPath, [path.join(dir, 'dist', 'index.js'), '--version'], { encoding: 'utf8', env: { ...env, XDG_CACHE_HOME: '/proc/oak-no-cache-here' }, timeout: 15_000 });
    assert.equal(proc.status, 0, `it starts: ${proc.error?.message ?? proc.stderr}`);
    assert.equal(proc.stdout, 'newer undefined', 'no compile cache');
  }
});

test('installers: install.ps1 is ASCII, so Windows PowerShell 5.1 can parse it when it runs the file', () => {
  // 5.1 reads a script with no BOM in the ANSI code page, where the last byte of `—` or `✓` decodes to a
  // curly double quote that ends the string. A BOM is no fix: `irm … | iex` would start with U+FEFF.
  const bad = read('install.ps1').split('\n').map((l, i) => `${i + 1}: ${l}`).filter((l) => /[^\x00-\x7f]/.test(l));
  assert.deepEqual(bad, []);
});

test('installers: install.ps1 stops inside the Claude desktop app before it installs anything (Windows report §3)', () => {
  // No PowerShell runs here (nor in CI), so this holds the check's shape: core's claudeDesktopPackage, whose test plays
  // the package, makes the same one.
  const ps1 = read('install.ps1');
  const check = ps1.indexOf('# --- not inside the Claude desktop app');
  assert.ok(check > 0 && check < ps1.indexOf('$tmp = Join-Path') && check < ps1.search(/^\s*& npm i -g /m), 'before the download and the install');
  const block = ps1.slice(check, ps1.indexOf('$tmp = Join-Path'));
  assert.match(block, /\$probe = Join-Path \$env:APPDATA \$probeName/);
  assert.match(block, /-Filter 'Claude_\*'/);
  assert.match(block, /Test-Path -LiteralPath \(Join-Path \$_\.FullName "LocalCache\\Roaming\\\$probeName"\)/);
  assert.match(block, /finally \{\s*if \(\$probe\) \{ Remove-Item -LiteralPath \$probe /);
  assert.match(block, /if \(\$container\) \{[^}]*Run this installer from a normal terminal[^}]*exit 1\s*\}/);
});

test('the root build links node_modules/.bin/oak, which npm ci skips while the CLI is unbuilt (the smoke and JetBrains tests run it)', () => {
  assert.match(JSON.parse(read('package.json')).scripts.build, / && npm rebuild oak-observatory --ignore-scripts$/);
});

test('root gate approves node-pty\'s install script for npm 12 (the workspace install builds the TUI\'s PTY)', () => {
  assert.deepEqual(JSON.parse(read('package.json')).allowScripts, { 'node-pty': true });
});

test('a checkout\'s install makes node-pty\'s spawn-helper executable, which its macOS prebuilds ship without (2026-09-27)', { skip: process.platform === 'win32' && 'POSIX file modes' }, t => {
  // node-pty 1.1.0 packs prebuilds/darwin-*/spawn-helper at 0644 and never sets the bit, so on the first macOS
  // CI run every PTY test died with `posix_spawnp failed`. npm ci and npm install run the root postinstall.
  const [command, ...args] = (JSON.parse(read('package.json')).scripts.postinstall || '').split(' ');
  assert.equal(command, 'node', 'the root package.json has a node postinstall');
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-pty-postinstall-'));
  t.after(() => fs.rmSync(tree, { recursive: true, force: true }));
  // The checkout in miniature: the script postinstall names, and node-pty where npm hoists it, as npm
  // extracts it on a Mac.
  fs.mkdirSync(path.join(tree, path.dirname(args[0])), { recursive: true });
  fs.copyFileSync(path.join(root, args[0]), path.join(tree, args[0]));
  const pty = path.join(tree, 'node_modules', 'node-pty');
  const helper = path.join(pty, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(path.join(pty, 'package.json'), '{"name":"node-pty","version":"1.1.0"}');
  fs.writeFileSync(helper, '');
  fs.chmodSync(helper, 0o644);
  const install = () => cp.spawnSync(process.execPath, args, { cwd: tree, encoding: 'utf8' });
  let r = install();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.statSync(helper).mode & 0o777, 0o755, 'the helper is executable after the install');
  // node-pty is optional: where it did not install, the install still succeeds.
  fs.rmSync(path.join(tree, 'node_modules'), { recursive: true });
  r = install();
  assert.equal(r.status, 0, r.stderr);
});

test('the editors give `oak update` longer than its saved machines can take, with most of it left for this machine', () => {
  // The deadlines the CLI holds saved machines to: herdr's machine list, then each plan, then each update.
  const value = (src, name) => {
    const m = new RegExp(`\\b${name} = ([\\d_ *]+)`).exec(src);
    assert.ok(m, `${name} is declared`);
    return m[1].split('*').reduce((n, factor) => n * Number(factor.trim().replace(/_/g, '')), 1);
  };
  const cli = read('packages/cli/src/index.ts');
  const list = Number(/timeoutMs: (\d+)/.exec(cli.slice(cli.indexOf('async function planMachines')))[1]);
  const deadlines = [list, value(cli, 'MACHINE_PLAN_TIMEOUT_MS'), value(cli, 'MACHINE_APPLY_TIMEOUT_MS')];
  assert.ok(deadlines.every((ms) => Number.isInteger(ms) && ms >= 1000), `each deadline is read: ${deadlines}`);
  const machines = deadlines.reduce((a, b) => a + b);
  for (const [editor, file, call] of [
    ['VS Code', 'packages/vscode/src/extension.ts', /runCli\(target \? \['update', '--channel', target\] : \['update'\], UPDATE_TIMEOUT_MS\)/],
    ['JetBrains', 'packages/jetbrains/src/main/kotlin/com/cellobservatory/observatory/core/ObservatoryCli.kt', /fun update\([^]*?run\(args, workDir, timeoutMs = UPDATE_TIMEOUT_MS\)/],
  ]) {
    const src = read(file);
    const budget = value(src, 'UPDATE_TIMEOUT_MS');
    assert.ok(budget - machines >= 10 * 60_000, `${editor} leaves this machine's own installs ${(budget - machines) / 1000} s of its ${budget / 1000} s`);
    assert.match(src, call, `${editor} gives that budget to the update call`);
  }
});

test('CI installs the pinned herdr before the suite, so the real-binary herdr tests run there', () => {
  for (const file of ['.github/workflows/linux.yml', '.github/workflows/macos.yml']) {
    const src = read(file);
    const install = src.indexOf('ensureHerdr({ startServer: false, integrations: [], pluginDir: null })');
    assert.ok(install > 0 && install < src.indexOf('run: npm test'), `${file} installs herdr before npm test`);
    assert.match(src, /echo "\$HOME\/\.local\/bin" >> "\$GITHUB_PATH"/, `${file} puts it on PATH`);
  }
});

test('the generated herdr-lock.ts is ignored, while the committed herdr-api.d.ts is not', { skip: cp.spawnSync('git', ['--version']).status !== 0 && 'no git' }, t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-ignore-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  cp.spawnSync('git', ['init', '-q'], { cwd: repo });
  fs.copyFileSync(path.join(root, '.gitignore'), path.join(repo, '.gitignore'));
  const ignored = (file) => cp.spawnSync('git', ['check-ignore', '-q', file], { cwd: repo }).status === 0;
  assert.equal(ignored('packages/core/src/herdr-lock.ts'), true, 'every core build writes it from herdr.lock');
  assert.equal(ignored('packages/core/src/herdr-api.d.ts'), false, 'the build only copies this one, so it is source');
});

test('CONTRIBUTING names every function that reads the built-in herdr pin', () => {
  // It called ensureHerdr() the pin's only reader; readHerdrLock(), probeHerdr() and downloadHerdrAsset() read it too.
  const src = 'packages/core/src';
  const importers = fs.readdirSync(path.join(root, src)).filter((f) => /\.ts$/.test(f) && /from '\.\/herdr-lock'/.test(read(`${src}/${f}`)));
  assert.deepEqual(importers, ['herdr-install.ts']);
  const readers = read(`${src}/herdr-install.ts`).split(/\n(?=export )/).filter((chunk) => /\bHERDR_LOCK\b/.test(chunk))
    .map((chunk) => /^export (?:async )?function (\w+)/.exec(chunk)?.[1]).filter(Boolean);
  assert.ok(readers.length >= 4, `the pin's readers: ${readers.join(', ')}`);
  const pin = read('CONTRIBUTING.md').split('## Bumping the herdr pin')[1].split('To move the pin:')[0];
  for (const fn of readers) assert.ok(pin.includes(`\`${fn}()\``), `CONTRIBUTING names ${fn}()`);
  for (const dir of ['packages/cli/src', 'packages/tui/src', 'packages/vscode/src'])
    for (const f of fs.readdirSync(path.join(root, dir))) if (/\.ts$/.test(f)) assert.doesNotMatch(read(`${dir}/${f}`), /\bHERDR_LOCK\b/, `${dir}/${f}`);
});

test('a Windows checkout (core.autocrlf=true) gets text with LF, batch files with CRLF and binaries unchanged, after a renormalize too', { skip: cp.spawnSync('git', ['--version']).status !== 0 && 'no git' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-eol-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(dir, 'no-gitconfig') };
  const git = (cwd, ...args) => assert.equal(cp.spawnSync('git', args, { cwd, env }).status, 0, `git ${args.join(' ')}`);
  const repo = path.join(dir, 'repo');
  const commit = () => git(repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@fixture.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  // gradlew.bat went in with CRLF long before the attributes did. An old file keeps its blob when the next
  // add runs; one written in the same instant as the index would be read again under the new attributes.
  const bat = '@rem one\r\n@rem two\r\n';
  fs.writeFileSync(path.join(repo, 'gradlew.bat'), bat);
  const earlier = new Date(Date.now() - 3600000);
  fs.utimesSync(path.join(repo, 'gradlew.bat'), earlier, earlier);
  git(repo, 'add', '-A');
  commit();
  fs.copyFileSync(path.join(root, '.gitattributes'), path.join(repo, '.gitattributes'));
  const png = Buffer.from('media bytes that git would take for text\r\nwithout the attribute\n'); // real PNGs hold a NUL
  fs.writeFileSync(path.join(repo, 'install.sh'), 'echo one\necho two\n');
  fs.writeFileSync(path.join(repo, 'shot.png'), png);
  git(repo, 'add', '-A');
  commit();
  const checkout = (name) => {
    git(dir, '-c', 'core.autocrlf=true', 'clone', '-q', repo, name);
    const file = (f) => path.join(dir, name, f);
    assert.equal(fs.readFileSync(file('install.sh'), 'utf8'), 'echo one\necho two\n');
    assert.deepEqual(fs.readFileSync(file('shot.png')), png);
    assert.equal(fs.readFileSync(file('gradlew.bat'), 'utf8'), bat, `${name}: the batch file checks out with CRLF`);
    const later = new Date(Date.now() + 60000);
    fs.utimesSync(file('gradlew.bat'), later, later); // so git reads it again
    assert.equal(cp.spawnSync('git', ['status', '--porcelain'], { cwd: path.join(dir, name), env, encoding: 'utf8' }).stdout, '', `${name}: nothing reads as modified`);
  };
  checkout('windows');
  git(repo, 'add', '--renormalize', '.'); // the usual step after adding attributes: it re-reads gradlew.bat under them
  commit();
  checkout('renormalized');
});

test('root gate includes the shipped herdr plugin suite', () => {
  const script = JSON.parse(read('package.json')).scripts.test;
  assert.ok(script.split(/\s+/).includes('packages/core/test/herdr-plugin.test.js'));
});

// What runs a test file: `npm test`'s list, what those files load by a relative require, and e2e.sh's
// "$REPO/…" helpers. Paths, never basenames: CONTRIBUTING's table names core.test.js, and a TUI test shares
// its name with the module it requires. The manual checks are listed here by path.
const MANUAL_CHECKS = ['test/claude-hooks-probe.js', 'test/codex-config-probe.js', 'test/codex-performance.js', 'test/herdr-probe.js', 'test/vscode-host-smoke.cjs'];
function unrunTests(testScript) {
  const slash = (file) => file.split(path.sep).join('/');
  const reached = new Set();
  const visit = (file) => {
    if (reached.has(file)) return;
    reached.add(file);
    if (!/(^|\/)test\//.test(file)) return; // a built module a test requires runs no tests of its own
    for (const [, spec] of read(file).matchAll(/require\(\s*['"`](\.{1,2}\/[^'"`]+)['"`]\s*\)/g)) {
      try { visit(slash(path.relative(root, require.resolve(path.resolve(root, path.dirname(file), spec))))); } catch { /* not built */ }
    }
  };
  for (const arg of testScript.split(/\s+/).filter((a) => /\.c?js$/.test(a))) visit(slash(path.normalize(arg)));
  for (const [, file] of read('test/e2e.sh').matchAll(/\$REPO\/([\w./-]+\.c?js)\b/g)) visit(file);
  return ['test', 'packages/core/test', 'packages/tui/test', 'packages/vscode/test']
    .flatMap((dir) => fs.readdirSync(path.join(root, dir)).filter((name) => /\.c?js$/.test(name)).map((name) => `${dir}/${name}`))
    .filter((file) => !reached.has(file) && !MANUAL_CHECKS.includes(file));
}

test('every test file is run by a gate, loaded by one, or listed as a manual check', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  assert.deepEqual(unrunTests(scripts.test), [], 'a test file that nothing runs can never fail');
  const howTo = read('CONTRIBUTING.md') + JSON.stringify(scripts);
  for (const file of MANUAL_CHECKS) assert.ok(howTo.includes(file), `CONTRIBUTING or an npm script says how to run ${file}`);
});

test('the wiring gate compares paths: a suite dropped from npm test is caught though its name appears elsewhere', () => {
  const script = JSON.parse(read('package.json')).scripts.test;
  for (const file of ['packages/core/test/core.test.js', 'packages/tui/test/tree.js', 'packages/tui/test/doctor.js']) {
    assert.ok(script.includes(` ${file}`), `npm test runs ${file}`);
    assert.ok(unrunTests(script.replace(` ${file}`, '')).includes(file), `${file} dropped from npm test is reported`);
  }
});

test('TUI media scratch stays under /tmp/obs-demo, the one temp path the privacy gate admits', () => {
  for (const file of ['scripts/build-tui-demo.mjs', 'scripts/build-tui-shots.mjs']) {
    assert.match(read(file), /process\.platform === 'win32' \? path\.join\(os\.tmpdir\(\), 'obs-demo'\) : '\/tmp\/obs-demo'/, file);
  }
  assert.match(read('scripts/check-docs-privacy.mjs'), /\(\?!obs-demo\\b/, 'the gate still admits /tmp/obs-demo');
});

test('every headless Chrome the scripts, sources and tests start runs with its extensions off, through runChrome or capturePng', () => {
  // A system package can register an extension that Chrome installs into every new profile, and each
  // headless run starts with a new one: KDE's Plasma Integration does (from
  // /usr/share/google-chrome/extensions), and its native host aborts at once, so every launch left a crash
  // report on the desktop. --disable-extensions keeps it out. scripts/chrome.mjs's runChrome and capturePng
  // give Chrome a home of its own, with no bus, display or keyring: a launch of its own reads the person's.
  const code = /\.[cm]?[jt]s$/, shell = /\.(?:sh|ps1)$/;
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel); } else if (code.test(e.name) || shell.test(e.name)) files.push(rel);
    }
  };
  for (const dir of ['scripts', 'test', ...fs.readdirSync(path.join(root, 'packages')).flatMap((p) => ['src', 'test'].map((d) => path.join('packages', p, d)))])
    if (fs.existsSync(path.join(root, dir))) walk(dir);
  // Each launch in one file, whether it turns the extensions off, and whether it goes through runChrome or
  // capturePng. A flag that is a string of its own is read with the argument list it is in, from the unclosed
  // `[` before it to the `]` that closes it, which is handed to one of them or named by a variable that is; one
  // inside a longer string, a command a shell runs, with its line. A line that is a comment starts nothing.
  const launches = (file, text) => {
    if (!code.test(file)) return shell.test(file) && text.includes('--headless') ? [{ at: file, off: false, elsewhere: true }] : [];
    const found = [];
    for (const m of text.matchAll(/--headless\b/g)) {
      const from = text.lastIndexOf('\n', m.index) + 1, to = text.indexOf('\n', m.index);
      const line = text.slice(from, to < 0 ? text.length : to);
      if (/^\s*(?:\/\/|\/?\*)/.test(line)) continue;
      const q = text[m.index - 1];
      let args = null, via = false;
      if (/['"`]/.test(q) && new RegExp(`^--headless(?:=\\w+)?${q}`).test(text.slice(m.index))) {
        let open = m.index, close = m.index, depth = 0;
        while (open > 0) { const ch = text[--open]; if (ch === ']') depth++; else if (ch === '[' && !depth--) break; }
        depth = 0;
        while (close < text.length) { const ch = text[close++]; if (ch === '[') depth++; else if (ch === ']' && !depth--) break; }
        if (text[open] === '[') {
          args = text.slice(open, close);
          const before = text.slice(0, open), helper = '\\b(?:runChrome|capturePng)\\(\\s*[^,()]+,\\s*';
          const name = /\b(?:const|let|var)\s+(\w+)\s*=\s*$/.exec(before)?.[1];
          via = new RegExp(`${helper}$`).test(before) || (!!name && new RegExp(`${helper}${name}\\b`).test(text));
        }
      }
      found.push({ at: `${file}:${text.slice(0, m.index).split('\n').length}`, off: args ? /(['"`])--disable-extensions\1/.test(args) : /--disable-extensions\b/.test(line), via });
    }
    return found;
  };
  // The reader, tried before it is trusted: each of these starts Chrome with its extensions on.
  for (const [file, text] of [
    ['x.mts', "spawnSync(chrome, ['--headless', '--screenshot', 'page.html']);"],
    ['x.cts', "spawnSync(chrome, ['--headless=new', '--dump-dom', 'page.html']);"],
    ['x.mjs', 'execSync(`${chrome} --headless --screenshot=x.png page.html`);'],
    ['x.ts', "execSync(chrome + ' --headless --dump-dom page.html');"],
    ['x.sh', 'chrome --headless --disable-extensions page.html'],
  ]) assert.deepEqual(launches(file, text).map((l) => l.off), [false], `${file}: ${text}`);
  // …and each of these with its extensions off, through the helpers or not.
  for (const [text, via] of [
    ["capturePng(CHROME, ['--headless', '--disable-extensions', 'page.html']);", true],
    ["const dom = runChrome(chrome, [\n  '--headless', '--disable-extensions', '--dump-dom', 'page.html',\n], { timeout: 1 });", true],
    ["const shot = ['--headless', '--disable-extensions', 'page.html'];\ncapturePng('/fixture/browser', shot);", true],
    ["execFileSync(chrome, ['--headless', '--disable-extensions', 'page.html']);", false],
    ["const shot = ['--headless', '--disable-extensions', 'page.html'];\nexecFileSync(chrome, shot);", false],
    ["execSync(`${chrome} --headless --disable-extensions page.html`);", false],
  ]) assert.deepEqual(launches('x.mjs', text).map((l) => [l.off, l.via]), [[true, via]], text);
  assert.ok(files.includes(path.join('packages', 'core', 'src', 'spawn.ts')), 'the packages\' sources are read');
  const self = path.join('test', 'gates.test.js');
  const all = files.filter((f) => f !== self).flatMap((f) => launches(f, read(f)));
  assert.ok(all.length >= 5, `the launches were found: ${all.map((l) => l.at).join(', ')}`);
  assert.deepEqual(all.filter((l) => !l.off && !l.elsewhere).map((l) => l.at), [], 'these start Chrome with the extensions a system package registers');
  assert.deepEqual(all.filter((l) => !l.via && !l.elsewhere).map((l) => l.at), [], 'these start Chrome themselves: hand the arguments to runChrome or capturePng (scripts/chrome.mjs)');
  assert.deepEqual(all.filter((l) => l.elsewhere).map((l) => l.at), [], 'a launch outside JavaScript: give it --disable-extensions, then teach this test to read it');
});

// A text cut at a UTF-16 index ends inside a character as easily as anywhere else: a session title cut at 64 units showed
// `👨‍👩‍�…` in the terminal app's session picker, half a family and half of a surrogate pair. Every cut that ends in an
// ellipsis ends where a character does, through core's graphemeHead and graphemeTail or the JetBrains plugin's own.
test('no text is cut with an ellipsis at a UTF-16 index: each cut goes through graphemeHead or graphemeTail', () => {
  const cut = [
    /\.slice\(0, ?[^)]+\)(?:\.\w+\(\))*\s*\+\s*['"]…/, // s.slice(0, n) + '…'
    /\$\{[^}]*\.slice\(0, ?[^)]+\)(?:\.\w+\(\))*\}\s?…/, // `${s.slice(0, n)}…`
    /\.substring\(0, ?[^)]+\)\s*\+\s*['"]…/,
    /['"]…['"]\s*\+\s*[\w.]+\.slice\(-/, // '…' + s.slice(-n)
    /\.take\([^)]*\)\s*\+\s*"…"/, // Kotlin: s.take(n) + "…"
    /"…"\s*\+\s*[\w.]+\.takeLast\(/, // Kotlin: "…" + s.takeLast(n)
  ];
  // The forms the cuts had: each is seen.
  for (const old of ["title.slice(0, 63).trimEnd() + '…'", '`${one.slice(0, THOUGHT_LIMIT)}…`', "fon='…'+fon.slice(-23)", 's.take(47) + "…"', '"…" + name.takeLast(23)'])
    assert.ok(cut.some((re) => re.test(old)), `the gate sees ${old}`);
  const walk = (dir, ext) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), ext) : e.name.endsWith(ext) && !e.name.endsWith('.d.ts') ? [path.join(dir, e.name)] : []);
  const files = [...['packages/core/src', 'packages/tui/src', 'packages/cli/src', 'packages/vscode/src'].flatMap((d) => walk(d, '.ts')),
    ...walk('packages/jetbrains/src/main/kotlin', '.kt')];
  assert.ok(files.length > 100, `the gate reads every source (${files.length})`);
  const found = files.flatMap((f) => read(f).split('\n').map((l, i) => [f, i + 1, l]).filter(([, , l]) => cut.some((re) => re.test(l))))
    .map(([f, n, l]) => `${f}:${n}: ${l.trim()}`);
  assert.deepEqual(found, []);
});

// A cut at a fixed size with no ellipsis ends inside a character as easily: ^V's paste cap and the conversation search's
// index held the first half of an emoji's surrogate pair when their cap fell inside one, and `oak actions` printed it.
// Every string cut at a fixed size, from its head (`s.slice(0, N)`, `substring`, `substr`) or its tail (`s.slice(-N)`),
// goes through graphemeHead or graphemeTail, except where the text cannot hold such a character: a hash's hex digits, a
// date's ISO form, an id, a slug, or the text a hash is made of, whose cut must not move. The TypeScript checker says
// which receivers are strings, so an array's `slice(0, 40)` is not one; an id is known by its name, or listed below
// where its name does not say so. accountUsage.ts holds five cuts of an error message, left as they are by the change
// that added this check, and they are counted so that none is added there.
test('no text is cut at a fixed size at a UTF-16 index: each cut goes through graphemeHead or graphemeTail', () => {
  const ts = require('typescript');
  const fixedSize = (n) => ts.isNumericLiteral(n) || (ts.isIdentifier(n) && /^[A-Z][A-Z0-9_]*$/.test(n.text))
    || (ts.isParenthesizedExpression(n) && fixedSize(n.expression)) || (ts.isBinaryExpression(n) && fixedSize(n.left) && fixedSize(n.right));
  const ascii = (recv) => /\.digest\(|\.to(?:ISO|Time)String\(\)/.test(recv) || /\b(?:id|session|sess|sid|slug)\b|[a-z](?:Id|Ses|Session)\b|_session\b/.test(recv);
  const hashed = (n) => { for (let p = n.parent; p; p = p.parent) if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) && p.expression.name.text === 'update') return true; return false; };
  // Ids by another name: the session the terminal app's `--once` frame reviews.
  const ids = new Set(['packages/tui/src/app.ts: target.slice(0, 8)']);
  /** Each fixed-size string cut in `program`'s files under `dir`, as `file:line: cut`, with whether it may stay. */
  const cutsIn = (program, dir) => {
    const checker = program.getTypeChecker(), out = [];
    for (const sf of program.getSourceFiles()) {
      if (!path.resolve(sf.fileName).startsWith(dir + path.sep)) continue;
      (function visit(n) {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ['slice', 'substring', 'substr'].includes(n.expression.name.text)) {
          const a = n.arguments, recv = n.expression.expression;
          const head = a.length === 2 && ts.isNumericLiteral(a[0]) && a[0].text === '0' && fixedSize(a[1]);
          const tail = a.length === 1 && n.expression.name.text === 'slice' && ts.isPrefixUnaryExpression(a[0]) && a[0].operator === ts.SyntaxKind.MinusToken && fixedSize(a[0].operand);
          if ((head || tail) && checker.getTypeAtLocation(recv).flags & ts.TypeFlags.StringLike) {
            const file = path.relative(root, path.resolve(sf.fileName)).split(path.sep).join('/'), cut = n.getText(sf).replace(/\s+/g, ' ');
            const at = `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${cut}`;
            out.push({ at, stays: ascii(recv.getText(sf).replace(/\s+/g, ' ')) || hashed(n) || ids.has(`${file}: ${cut}`) });
          }
        }
        ts.forEachChild(n, visit);
      })(sf);
    }
    return out;
  };
  // The rule, on the forms the cuts had and the ones that may stay.
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'oak-cuts-'));
  try {
    const sample = path.join(dir, 'sample.ts');
    fs.writeFileSync(sample, [
      'declare const text: string, ask: string, err: string, id: string, slug: string, lines: string[], hash: { update(s: string): { digest(e: string): string } };',
      'const PASTE_MAX = 512, SLUG_MAX = 200;',
      'export const cut = [text.slice(0, PASTE_MAX), ask.length > 8192 ? ask.slice(0, 8192) : ask, err.slice(-16000), text.substring(0, 40), (text || "").slice(0, 80)];',
      'export const kept = [id.slice(0, 8), slug.slice(0, SLUG_MAX + 1), hash.update(text.slice(0, 200)).digest("hex").slice(0, 16), new Date().toISOString().slice(0, 10)];',
      'export const notCuts = [lines.slice(0, 40), text.slice(0, text.indexOf(":")), text.slice(0, -6)];',
    ].join('\n'));
    const seen = cutsIn(ts.createProgram([sample], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, lib: ['lib.es2022.d.ts'] }), dir);
    assert.deepEqual(seen.map((c) => [c.at.replace(/^.*?: /, ''), c.stays]), [
      ['text.slice(0, PASTE_MAX)', false], ['ask.slice(0, 8192)', false], ['err.slice(-16000)', false], ['text.substring(0, 40)', false], ['(text || "").slice(0, 80)', false],
      ['id.slice(0, 8)', true], ['slug.slice(0, SLUG_MAX + 1)', true], ['hash.update(text.slice(0, 200)).digest("hex").slice(0, 16)', true], ['text.slice(0, 200)', true], ['new Date().toISOString().slice(0, 10)', true],
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Each package as it is built, with the types of the packages it imports.
  const all = ['core', 'tui', 'cli', 'vscode'].flatMap((pkg) => {
    const cfg = ts.getParsedCommandLineOfConfigFile(path.join(root, 'packages', pkg, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => assert.fail(ts.flattenDiagnosticMessageText(d.messageText, '\n')) });
    return cutsIn(ts.createProgram({ rootNames: cfg.fileNames, options: { ...cfg.options, noEmit: true } }), path.join(root, 'packages', pkg, 'src'));
  });
  // The checker typed what it read: an id the CLI takes from core's types, and a slug core makes itself.
  for (const known of [/^packages\/cli\/src\/index\.ts:\d+: h\.session\.slice\(0, 8\)$/, /^packages\/core\/src\/session\.ts:\d+: slug\.slice\(0, SLUG_MAX\)$/])
    assert.ok(all.some((c) => known.test(c.at.split(path.sep).join('/')) && c.stays), `the scan sees ${known}`);
  const left = all.filter((c) => !c.stays).map((c) => c.at.split(path.sep).join('/'));
  assert.equal(left.filter((at) => at.startsWith('packages/core/src/accountUsage.ts:')).length, 5, left.join('\n'));
  assert.deepEqual(left.filter((at) => !at.startsWith('packages/core/src/accountUsage.ts:')), []);
  // The JetBrains plugin, which the checker does not read: a fixed-size take of a command's output or of text shown.
  const receiver = (line, at) => {
    let i = at, depth = 0;
    for (; i > 0; i--) {
      const ch = line[i - 1];
      if (')]}'.includes(ch)) depth++;
      else if ('([{'.includes(ch)) { if (!depth) break; depth--; }
      else if (!depth && !/[\w.?!]/.test(ch)) break;
    }
    return line.slice(i, at);
  };
  const ktCuts = (source) => source.split('\n').flatMap((line, n) => [...line.matchAll(/\.(?:take|takeLast)\((?:\d+|[A-Z][A-Z0-9_]*)\)|\.substring\(0, ?(?:\d+|[A-Z][A-Z0-9_]*)\)/g)]
    .map((m) => [n + 1, receiver(line, m.index)])
    .filter(([, r]) => /\b(?:stderr|stdout|message|text|title|label|reason|detail|snippet|prompt|summary)\b|joinToString\(/.test(r) && !/(?:lines|lineSequence|split)\([^()]*\)$/.test(r)));
  assert.deepEqual(ktCuts('notify(project, "Clean failed — ${r.stderr.take(160)}")\nval tail = (r.stdout.trim().lines().takeLast(6).joinToString("\\n")).take(600)\nval ids = row.id.take(8)')
    .map(([n]) => n), [1, 2], 'the plugin\'s rule sees the cuts it had, and not an id or a list of lines');
  const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.kt') ? [path.join(d, e.name)] : []);
  assert.deepEqual(walk('packages/jetbrains/src/main/kotlin').flatMap((f) => ktCuts(read(f)).map(([n, r]) => `${f}:${n}: ${r}`)), []);
});

test('SECURITY.md names what npm downloads when it installs the CLI', () => {
  // `oak update`, here and on each saved machine, runs `npm i -g` on the release's tarball, and npm fetches
  // the dependencies the CLI declares from the registry, and theirs: a network path of its own. One with an
  // install script is built where it ships no binary, and node-gyp fetches Node's headers to build it.
  const pkg = JSON.parse(read('packages/cli/package.json'));
  const declared = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies });
  assert.ok(declared.length, 'the CLI declares what npm installs with it');
  const locked = JSON.parse(read('package-lock.json')).packages;
  // Each as the CLI's workspace resolves it: nested under packages/cli when the workspace locks another version
  // there, otherwise at the root. One found nowhere would skip the checks below, so it must be found.
  const lockOf = (name) => {
    const entry = locked[`packages/cli/node_modules/${name}`] ?? locked[`node_modules/${name}`];
    assert.ok(entry, `package-lock.json locks ${name}, which the CLI declares`);
    return entry;
  };
  const theirs = declared.flatMap((name) => Object.keys(lockOf(name).dependencies ?? {}));
  const sentence = read('SECURITY.md').split(/(?<=\.)\s+/).find((s) => /npm registry/.test(s)) ?? '';
  assert.match(sentence, /npm i -g[\s\S]*here and on each saved machine/, sentence);
  for (const name of [...declared, ...theirs]) assert.ok(sentence.includes(name), `SECURITY.md says npm downloads ${name}: ${sentence}`);
  if (declared.some((name) => lockOf(name).hasInstallScript)) assert.match(sentence, /node-gyp downloads the Node\.js headers\s+from nodejs\.org/, sentence);
  // install.sh first installs its checkout's own dependencies, the tree package-lock.json locks.
  assert.match(read('install.sh'), /^npm install\b/m);
  const own = read('SECURITY.md').split(/(?<=\.)\s+/).find((s) => /`install\.sh` builds/.test(s)) ?? '';
  assert.match(own, /`npm install`[\s\S]*`package-lock\.json`[\s\S]*npm registry[\s\S]*node-gyp/, own);
});

test('SECURITY.md names what `./install.sh --jetbrains` downloads, and install.sh does not say nothing is', () => {
  // `--jetbrains` builds the plugin with the Gradle wrapper, which downloads Gradle (services.gradle.org sends that
  // download to GitHub's gradle-distributions), and Gradle then the build's plugins, the IntelliJ Platform, the
  // other dependencies and, on a machine with none, a JDK 21 that the foojay resolver looks up at foojay.io.
  assert.match(read('install.sh'), /^\s*if bash scripts\/install-jetbrains\.sh --build-only/m);
  assert.match(read('scripts/install-jetbrains.sh'), /\.\/gradlew buildPlugin/);
  assert.match(read('packages/jetbrains/settings.gradle.kts'), /id\("org\.gradle\.toolchains\.foojay-resolver-convention"\)/);
  const gradle = /^distributionUrl=https\\?:\/\/([^/]+)\//m.exec(read('packages/jetbrains/gradle/wrapper/gradle-wrapper.properties'))?.[1];
  const sentence = read('SECURITY.md').split(/(?<=\.)\s+/).find((s) => s.includes('`--jetbrains`')) ?? '';
  for (const named of [gradle, 'github.com/gradle/gradle-distributions', 'Gradle Plugin Portal', 'IntelliJ Platform', 'Maven Central', 'JDK 21', 'foojay.io']) {
    assert.ok(named && sentence.includes(named), `SECURITY.md names ${named}: ${sentence}`);
  }
  const installer = read('install.sh'), end = installer.indexOf('\nset -euo pipefail');
  assert.ok(end > 0, 'install.sh opens with its header comment, then set -euo pipefail');
  const header = installer.slice(0, end);
  assert.doesNotMatch(header, /nothing is downloaded/i, header);
  for (const named of ['npm', 'herdr', 'Gradle']) assert.match(header, new RegExp(named), header);
});

test('a release stamp turns [Unreleased] into the section release.yml publishes', { skip: process.platform === 'win32' && 'runs release.yml\'s awk' }, t => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'oak-stamp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = ['package.json', 'package-lock.json', 'README.md', 'scripts/version.mjs', 'packages/jetbrains/build.gradle.kts',
    ...['core', 'cli', 'tui', 'vscode'].map(p => `packages/${p}/package.json`),
    ...fs.readdirSync(path.join(root, 'docs')).filter(f => f.endsWith('.html')).map(f => `docs/${f}`)];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(dir, file));
  }
  const notes = '\n### Added\n\n- A new thing.\n\n';
  const changelog = `# Changelog\n\n## [Unreleased]\n${notes}## [0.9.5] — 2026-08-12\n\n### Fixed\n\n- An old thing.\n`;
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
  const cp = require('node:child_process');
  const stamp = version => cp.execFileSync(process.execPath, [path.join(dir, 'scripts/version.mjs'), version], { cwd: dir, encoding: 'utf8' });
  const program = /awk -v ver="\$VER" '([^']+)' CHANGELOG\.md/.exec(read('.github/workflows/release.yml'))[1];
  const published = version => cp.execFileSync('awk', ['-v', `ver=${version}`, program, 'CHANGELOG.md'], { cwd: dir, encoding: 'utf8' });

  stamp('9.9.0-dev.3');
  assert.equal(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'), changelog, 'a rolling dev stamp leaves the changelog alone');
  stamp('9.9.0');
  const stamped = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
  assert.match(stamped, /^## \[Unreleased\]\n\n## \[9\.9\.0\] — \d{4}-\d{2}-\d{2}\n/m, 'a fresh [Unreleased] above the dated release section');
  assert.equal(published('9.9.0'), notes, 'release.yml publishes exactly the notes that were unreleased');
  assert.ok(stamped.endsWith('## [0.9.5] — 2026-08-12\n\n### Fixed\n\n- An old thing.\n'), 'released sections are untouched');
  stamp('9.9.0');
  assert.equal(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'), stamped, 'stamping the same release twice renames nothing');
  stamp('9.9.1');
  assert.equal(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'), stamped, 'an empty [Unreleased] is not released (a hotfix writes its own section)');

  // The section carries the maintainer's date, not UTC's: at any moment one of these zones is on another day.
  const day = (timeZone) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const at = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return `${at.year}-${at.month}-${at.day}`;
  };
  for (const [TZ, version] of [['Etc/GMT-14', '9.9.2'], ['Etc/GMT+12', '9.9.3']]) {
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
    const before = day(TZ);
    cp.execFileSync(process.execPath, [path.join(dir, 'scripts/version.mjs'), version], { cwd: dir, env: { ...process.env, TZ } });
    const dated = new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\] — (\\S+)$`, 'm').exec(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'))?.[1];
    assert.ok([before, day(TZ)].includes(dated), `TZ=${TZ}: stamped ${dated}, where the date is ${before}`);
  }
});

test('release.yml publishes notes GitHub accepts: past its limit, whole entries and where the rest is', { skip: process.platform === 'win32' && 'runs release.yml\'s bash' }, t => {
  // GitHub refuses a release body over 125,000 characters ("body is too long"), and a refused `gh release create`
  // leaves the tag with no release and no assets. The step runs whole, with a gh that keeps the notes it is handed.
  const LIMIT = 125000;
  const step = stepRun('.github/workflows/release.yml', 'Create GitHub Release with artifacts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-notes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of ['release/oak-observatory.vsix', 'release/oak-observatory-9.9.0.tgz', 'packages/jetbrains/build/distributions/p.zip']) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), '');
  }
  // The fake gh, first on PATH and executable before anything runs: the real one would publish a release.
  const gh = path.join(dir, 'bin', 'gh');
  fs.mkdirSync(path.dirname(gh));
  fs.writeFileSync(gh, '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = --notes-file ] && cp "$2" "$KEPT"; shift; done\n');
  fs.chmodSync(gh, 0o755);
  const kept = path.join(dir, 'published.md');
  const publish = (notes) => {
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), `# Changelog\n\n## [Unreleased]\n\n## [9.9.0] — 2026-01-01\n${notes}## [9.8.0] — 2025-12-01\n\n- An older entry.\n`);
    fs.rmSync(kept, { force: true });
    const r = cp.spawnSync(realTool('bash'), ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step], { cwd: dir, encoding: 'utf8',
      env: { ...process.env, PATH: path.dirname(gh) + path.delimiter + process.env.PATH, GITHUB_REF_NAME: 'v9.9.0', GITHUB_REPOSITORY: 'o/r', KEPT: kept } });
    assert.equal(r.status, 0, r.stderr);
    return fs.readFileSync(kept, 'utf8');
  };
  const pointer = '\nGitHub keeps a release\'s notes to 125,000 characters: the rest of these notes are in [CHANGELOG.md](https://github.com/o/r/blob/v9.9.0/CHANGELOG.md).\n';
  // What is cut: a prefix of the notes that ends where an entry or heading begins, then the pointer.
  const cutWhole = (notes, out) => {
    assert.ok([...out].length <= LIMIT, `${[...out].length} characters published`);
    assert.ok(out.endsWith(pointer), 'the rest is named');
    const head = out.slice(0, -pointer.length);
    assert.ok(notes.startsWith(head), 'a prefix of the notes');
    assert.match(notes.slice(head.length), /^(?:- |#+ )/, 'cut before an entry or heading, never inside one');
  };
  assert.equal(publish('\n### Added\n\n- A new thing.\n\n'), '\n### Added\n\n- A new thing.\n\n', 'short notes go out as written');
  // 400 entries of two lines, with characters of two bytes: past the limit in characters as in bytes.
  const many = `\n### Fixed\n\n${Array.from({ length: 400 }, (_, i) => `- Entry ${i}: ${'é'.repeat(180)}\n  ${'x'.repeat(200)}\n`).join('')}\n`;
  cutWhole(many, publish(many));
  // The next release's notes as they stand.
  const next = /^## \[Unreleased\][^\n]*\n([\s\S]*?)(?=^## \[)/m.exec(read('CHANGELOG.md'))[1];
  const out = publish(next);
  if (Buffer.byteLength(next) > 120000) cutWhole(next, out);
  else assert.equal(out, next);
});

test('Cutting a release: steps 1 and 2 commit what the next step needs, and step 5 finds dev\'s new entries however the PR was merged', { skip: process.platform === 'win32' && 'POSIX sh' }, t => {
  const steps = read('CONTRIBUTING.md').split('**Cutting a release.**')[1].split('**Version numbering.**')[0].split(/\n(?=\d\. )/);
  assert.match(steps[1], /Commit the stamp/, 'git refuses to merge over the uncommitted stamp');
  assert.match(steps[1], /docs\/_content\/releases\.html[\s\S]*build-docs\.mjs/, 'the stamp leaves the releases page undated');
  assert.match(steps[2], /commit the merge with what the stamp changed/, 'the re-stamped build.gradle.kts belongs in the merge');
  assert.match(steps[3], /placeholder comment/, 'the diff also removes main\'s placeholder comment');
  const command = /`(git diff [^`]*origin\/dev[^`]*)`/.exec(steps[5])[1].replaceAll('X.Y.Z', '9.9.0');

  // main released 9.8.0; dev gained an entry, was cut and stamped; then dev gained one more entry.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(dir, 'no-gitconfig'), GIT_AUTHOR_NAME: 'fixture',
    GIT_AUTHOR_EMAIL: 'fixture@fixture.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@fixture.invalid' };
  const sh = (script) => {
    const r = cp.spawnSync('sh', ['-c', script], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `${script}: ${r.stderr}`);
    return r.stdout;
  };
  const commit = (unreleased, message) => {
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), `# Changelog\n\n## [Unreleased]\n${unreleased}## [9.8.0] — 2026-01-01\n\n- An entry of 9.8.0.\n`);
    sh(`git add -A && git commit -qm '${message}'`);
  };
  sh('git init -q -b main');
  commit('\n', 'release: 9.8.0');
  sh('git checkout -qb dev');
  commit('\n- An entry of 9.9.0.\n\n', 'dev: an entry');
  sh('git checkout -qb release/9.9.0');
  commit('\n## [9.9.0] — 2026-02-02\n\n- An entry of 9.9.0.\n\n', 'release: 9.9.0');
  sh('git checkout -q dev');
  commit('\n- An entry of 9.9.0.\n- An entry dev gained after the cut.\n\n', 'dev: an entry after the cut');
  sh('git update-ref refs/remotes/origin/dev dev');
  for (const [how, merge] of [['squash', 'git merge -q --squash release/9.9.0 && git commit -qm squash'], ['merge commit', 'git merge -q --no-ff -m merge release/9.9.0']]) {
    sh(`git checkout -q -B main dev~2 && ${merge} && git tag -f v9.9.0`);
    const diff = sh(command).split('\n');
    const lines = (sign) => diff.filter((l) => l.startsWith(sign) && !l.startsWith(sign.repeat(3))).map((l) => l.slice(1)).filter(Boolean);
    assert.deepEqual(lines('+'), ['- An entry dev gained after the cut.'], `${how}: the added lines are the entries to keep`);
    assert.deepEqual(lines('-'), ['## [9.9.0] — 2026-02-02'], `${how}: besides them, only the release's heading goes`);
  }
});

function checkPages(source) {
  const generate = source.indexOf('node scripts/build-docs.mjs');
  const verify = source.indexOf('git diff --exit-code -- docs');
  const upload = source.indexOf('uses: actions/upload-pages-artifact@');
  assert.ok(generate >= 0 && verify > generate && upload > verify, 'generate and verify docs before uploading Pages');
  assert.match(source, /paths:.*'scripts\/build-docs\.mjs'/, 'generator changes trigger Pages');
}

test('Pages gate generates docs and rejects stale committed pages before upload', () => checkPages(read('.github/workflows/pages.yml')));
test('the database explainer is included in generated navigation, search and related guides', () => {
  const slug = 'database-across-machines';
  const titles = { 'database-across-machines': 'The database across machines', 'database-and-sync': 'Database & sync' };
  const nav = [...read('scripts/build-docs.mjs').matchAll(/slug: '([^']+)'/g)].map(m => m[1]);
  for (const name of Object.keys(titles)) {
    assert.ok(nav.includes(name));
    const old = name.replace('database-', 'index-');
    for (const dir of ['docs', 'docs/_content']) assert.ok(!fs.existsSync(path.join(root, dir, `${old}.html`)), `${dir}: unpublished page has no redirect`);
  }
  for (const page of ['showcase', ...nav]) {
    const html = read(`docs/${page}.html`);
    const index = JSON.parse(html.match(/window\.__DOCS_INDEX__=(\[[\s\S]*?\]);/)[1]);
    assert.deepEqual(index.map(p => p.s), nav, `${page}: search covers every page`);
    for (const [name, title] of Object.entries(titles)) assert.equal(index.find(p => p.s === name)?.t, title, `${page}: search names ${name}`);
    assert.doesNotMatch(html, /index-(?:across-machines|and-sync)\.html|the-local-index|why-the-index-stays-local|index-versions-and-usage-display/);
    if (page !== 'showcase') assert.ok(html.includes(`href="${slug}.html"`), `${page}: navigation includes the explainer`);
  }
  for (const page of ['database-and-sync', 'agents-across-machines']) {
    assert.ok(read(`docs/_content/${page}.html`).includes(`href="${slug}.html"`), `${page}: body links to the explainer`);
    assert.ok(read(`docs/_content/${slug}.html`).includes(`href="${page}.html"`), `explainer links back to ${page}`);
  }
  const guide = read('docs/database-and-sync.html');
  assert.match(guide, /<h1>Database &amp; sync<\/h1>/);
  assert.match(guide, /id="the-local-database"/);
  assert.match(guide, /id="database-versions-and-usage-display"/);
  assert.match(guide, /database: \/tmp\/obs-demo\/laptop\/\.claude\/claude-observatory-index\/index-v1-/);
  for (const name of Object.keys(titles)) {
    const html = read(`docs/${name}.html`);
    assert.match(html, /rows? · \d+ ms · the database is current/);
    assert.doesNotMatch(html, /the index is current/);
  }
  assert.match(read(`docs/${slug}.html`), /<h1>The database across machines<\/h1>/);
  assert.match(read(`docs/${slug}.html`), /id="why-the-database-stays-local"/);
});
test('Pages gate detects removal of the freshness command from a copy', () => {
  const source = read('.github/workflows/pages.yml');
  checkPages(source);
  assert.throws(() => checkPages(source.replace('git diff --exit-code -- docs', 'true')), /generate and verify/);
});
test('the editor demo embed is what its generator makes from the homepage, as the Pages gate requires', t => {
  // The Pages gate also regenerates docs/embed-editor-demo.html, which copies the homepage's whole <style>
  // block, and fails the deploy when it differs; build-docs alone does not see it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-embed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of ['scripts/build-editor-demo-embed.mjs', 'docs/showcase.html']) {
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(dir, file));
  }
  const run = cp.spawnSync(process.execPath, [path.join(dir, 'scripts/build-editor-demo-embed.mjs')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fs.readFileSync(path.join(dir, 'docs/embed-editor-demo.html'), 'utf8') === read('docs/embed-editor-demo.html'),
    'docs/embed-editor-demo.html is stale; run node scripts/build-editor-demo-embed.mjs');
});

test('Feed docs and media describe four chronological Timeline tabs and actual consumers', () => {
  const media = read('scripts/render-media.mjs');
  assert.ok(media.includes("${tlTab('Feed', 0, false)}${tlTab('Prompts', '3 asks', true)}${tlTab('Observations', '9 edits', false)}${tlTab('Actions', '39 tool calls', false)}"));
  assert.ok(!media.includes("tlTab('Conversation'"));
  assert.match(media, /feed: '868,590'/);
  for (const name of ['feed', 'layout', 'sessions']) {
  const png = fs.readFileSync(path.join(root, 'docs/media', name + '.png'));
  const image = require('pngjs').PNG.sync.read(png);
  // The card ends in rounded corners. A viewport crop leaves a flat, full-width bottom edge.
  const widths = Array.from({ length: image.height }, (_, y) => {
    let width = 0;
    for (let x = 0; x < image.width; x++) {
      const at = (y * image.width + x) * 4;
      if (image.data[at] + image.data[at + 1] + image.data[at + 2] > 10) width++;
    }
    return width;
  });
  assert.ok(widths.findLast(width => width > 0) < Math.max(...widths), name + ' card has its complete rounded bottom edge');
  }
  for (const file of ['README.md', 'docs/DEMO.md']) {
    const alt = read(file).split('\n').find(line => line.includes('](media/layout.png)') || line.includes('](docs/media/layout.png)'));
    assert.match(alt, /\(Feed · Prompts · Observations · Actions\)/);
    assert.doesNotMatch(alt, /Conversation · Feed/);
  }
  assert.match(read('scripts/build-docs.mjs'), /slug: 'feed'.*oldest first/);
  assert.doesNotMatch(read('docs/_content/editors-overview.html'), /next prompt drives/);
  const arch = read('docs/ARCHITECTURE.md');
  assert.doesNotMatch(arch, /Timeline's five tabs|window's middle tab|Conversation pane in all three/);
  assert.ok(arch.includes('Both editors read their conversation through `feed --json`'));
  assert.match(read('docs/CODEX-SUPPORT.md'), /conversation-codex\.jsonl/);
  for (const file of ['packages/vscode/README.md', 'packages/jetbrains/README.md'])
    assert.doesNotMatch(read(file), /Existing saved Agent- and Conversation-tab layouts|three-column mode/);
  // The 0.10.0 notes, before their own Changed section: an [Unreleased] Changed section comes first.
  const changelog = read('CHANGELOG.md').split('## [0.10.0]')[1].split('### Changed')[0];
  assert.match(changelog, /Timeline gains a \*\*Feed\*\* tab/);
  assert.match(changelog, /session, agent, workflow and task/);
});

test('machine and Feed documentation matches shipped behavior', () => {
  const overview = read('docs/_content/editors-overview.html');
  assert.match(overview, /sessions from every machine in one list/);
  assert.match(overview, /Selecting a local session/);
  assert.match(overview, /VS Code and JetBrains also list the sessions of each machine saved in herdr/);
  assert.doesNotMatch(overview, /JetBrains does not read saved machines/);
  assert.match(overview, /session selectors, Sessions and Workers share each machine’s listing/);
  assert.match(overview, /to read that session's conversation/);
  for (const file of ['README.md', 'SECURITY.md']) {
    assert.match(read(file), /Saved herdr machines \(automatic\)/);
    assert.match(read(file), /terminal Observatory requests/);
    assert.doesNotMatch(read(file), /--gather-machines/);
    assert.doesNotMatch(read(file), /every view are local|zero-token and local/);
  }
  const changes = read('CHANGELOG.md');
  assert.match(changes, /Saved Timeline column widths reset once/);
  assert.doesNotMatch(changes, /Fable chip/);
  assert.match(changes, /cap \(`Fable`\) is not a status-bar item/);
  assert.doesNotMatch(changes, /Version 7 stores|status blob also reports|“· pinned”|"· pinned" chip left/);
  const demo = read('docs/DEMO.md'), tasks = demo.slice(demo.indexOf('#### Left nav → **Tasks**'), demo.indexOf('task was in progress, along'));
  assert.doesNotMatch(tasks, /while that task was in progress, along/);
  assert.match(demo, /task was in progress, along with the agent's replies/);
  assert.match(read('docs/_content/feed.html'), /thinking · N words/);
  for (const file of ['packages/vscode/README.md', 'packages/jetbrains/README.md', 'docs/_content/sessions-agents.html']) {
    assert.match(read(file), /sessions from every machine in one list/);
    assert.match(read(file), /[Ss]electing a local/);
  }
  const arch = read('docs/ARCHITECTURE.md');
  assert.doesNotMatch(arch, /machineSessionMeta|machine-sessions.json/);
  assert.match(arch, /workspace first|editor root first/);
  assert.match(read('packages/core/src/tour.ts'), /Sessions from every machine share one list/);
  for (const file of ['packages/cli/README.md', 'docs/_content/cli.html']) {
    assert.doesNotMatch(read(file), /--machines|--gather-machines/);
  }
  for (const file of ['packages/cli/README.md', 'docs/_content/cli.html', 'docs/_content/tui-herdr.html']) {
    assert.match(read(file), /missing sidebar widths/);
    assert.doesNotMatch(read(file), /unset sidebar widths/);
  }
  assert.match(read('docs/_content/tui-herdr.html'), /sets gruvbox as the default/);
  const media = read('scripts/render-media.mjs');
  assert.match(media, /layout: '1808,910'/);
  assert.doesNotMatch(media.slice(media.indexOf("'sessions': scene"), media.indexOf("'feed': scene")), /grouped by workspace|~\/projects\/[^<]+ · \d+ sessions?/);
});

test('the sync and database documentation says what a purge, the status line, a kept draft and the record log do', () => {
  const cli = read('packages/cli/src/index.ts');
  const flat = file => read(file).replace(/\s+/g, ' ');
  // `oak uninstall --purge-store` keeps sync/evicted.jsonl while sync has other state, so this machine's inventory lists
  // the purged sessions as cleaned up and the other machines let their copies go, as after any cleanup.
  assert.match(cli, /keep \$\{path\.join\(syncState, 'evicted\.jsonl'\)\} while oak sync runs on another of your machines/);
  for (const file of ['docs/_content/database-and-sync.html', 'SECURITY.md', 'docs/ARCHITECTURE.md', 'CHANGELOG.md']) {
    assert.doesNotMatch(flat(file), /keep oak sync.s copies of (?:those|the) stores/, file);
    assert.match(flat(file), /lets? (?:its|their) copies of (?:the|those) stores go, as after any cleanup/, file);
  }
  // A purge applied from another machine's record log, or a base without the session, is forgotten as a delete here is:
  // in every index file in the folder, then a checkpoint (ingest.ts noteForgotten).
  const ingest = read('packages/core/src/index/ingest.ts');
  const purgeApplied = ingest.slice(ingest.indexOf("if (t === 'purge'"), ingest.indexOf("if (typeof t !== 'string' || !Object.hasOwn(RECORD_TABLES, t))"));
  assert.ok(purgeApplied.includes('DELETE FROM') && purgeApplied.includes('noteForgotten(r, host, [rec.s])'), 'a purge applied from a record log is noted to be forgotten everywhere');
  assert.match(ingest, /forgetInLog\(db\);\s+for \(const \[host, ids\] of r\.forgotten\) if \(ids\.size\) forgetElsewhere\(\[\.\.\.ids\], undefined, host\);/);
  assert.match(flat('docs/ARCHITECTURE.md'), /is applied as a delete here is: the session's rows of that machine go from every database file in the folder \(the one applying it keeps their usage, without the session\), and the write-ahead log is checkpointed\./);
  // The status line's `oak usage` opens the index, and so publishes, only on the renders that ask for its totals: once a
  // scan interval, and every render while a scan's file map waits for whole totals.
  assert.match(cli, /const STATUSLINE_SCAN_MS = 600_000;/);
  assert.match(cli, /Object\.keys\(s\.fc\)\.length > 0/);
  assert.match(flat('docs/_content/agents-across-machines.html'), /<code>oak usage<\/code> call, on the renders that ask for the database’s totals \(every render until those totals are whole, then about every ten minutes\)/);
  assert.match(flat('docs/_content/database-and-sync.html'), /status line’s <code>oak usage<\/code> call, on each render that asks for the database’s totals \(about every ten minutes once those totals are whole\);/);
  // A kept draft exits 75 in every output mode, as the scripted-send reference says.
  assert.match(cli, /const DRAFT_KEPT_EXIT = 75;/);
  assert.match(flat('docs/REMOTE.md'), /`sent: false` in JSON and exit status 75 in every output mode/);
  // A reader passes over a record table, or a column, it does not know and reads on past it: a schema step reads again.
  assert.match(ingest, /!Object\.hasOwn\(RECORD_TABLES, t\)\) return;/);
  assert.match(flat('CONTRIBUTING.md'), /the schema step that adds a table, or a column the rows already read must have, also reads the other machines' record logs again from their start/);
  // The listing's rows carry lastEdit (observe.ts SessionCounts), as DEMO.md quotes them.
  assert.match(read('packages/core/src/observe.ts'), /lastEdit: number;/);
  assert.match(read('docs/DEMO.md'), /"removed":10,"lastEdit":9,"tokens":9280,/);
  // A worker's call with no result reads working unless its own permission prompt is up (actions.ts sessionHand).
  assert.match(read('packages/core/src/actions.ts'), /if \(hand === 'other'\) return \{ phase: 'working', confidence: 'high' \};/);
  assert.doesNotMatch(flat('docs/_content/tui-observatory.html'), /unless it stopped on a tool call or a question, which reads as waiting/);
  assert.match(flat('CHANGELOG.md'), /a long command\) in a session whose hooks OAK does not record, is marked `~`/);
  // A query's own --machine filter takes the machine id, `self` or a saved machine's label, and refuses any other name
  // (query.ts machineIds).
  assert.match(read('packages/core/src/index/query.ts'), /description: 'only this machine \(its id, "self", or the label a saved machine has here\)'/);
  assert.match(read('packages/core/src/index/query.ts'), /SELECT machine_id FROM machines WHERE saved_label = \?/);
  assert.match(cli, /id \(machine, which a query's --machine takes, as it takes self and the label a saved\\n/);
  assert.match(cli, /machine has here; any other name is refused\) and by this machine's\\n/);
  assert.match(flat('docs/_content/cli.html'), /which a query’s own <code>--machine<\/code> takes, as it takes <code>self<\/code> and the label a saved machine has here/);
  assert.match(flat('docs/_content/database-and-sync.html'), /A query’s own <code>--machine<\/code> takes the id, <code>self<\/code>, or the label you saved a machine under, and refuses any other name with <code>bad_param<\/code>\./);
  assert.match(flat('docs/_content/agents-across-machines.html'), /A query’s own <code>--machine<\/code> filter takes the id, <code>self<\/code>, or the label you saved the machine under/);
  // `oak notify --watch` announces every session's hand on this machine (sessionMeta lists them all, by workspace).
  for (const text of [cli, flat('docs/_content/cli.html')]) assert.doesNotMatch(text, /every hand this workspace raises/);
});

test('the docs say where a file, a machine, a hand and a phase come from, as the code does', () => {
  const flat = file => read(file).replace(/\s+/g, ' ');
  const agents = flat('docs/_content/agents-across-machines.html'), guide = flat('docs/_content/database-and-sync.html');
  const arch = flat('docs/ARCHITECTURE.md'), readme = flat('README.md'), changelog = flat('CHANGELOG.md');
  // `files` groups by the repository's part of the project key and the path from the repository's root.
  assert.match(read('packages/core/src/index/query.ts'), /GROUP BY CASE WHEN e\.project_key IS NOT NULL AND e\.rel_path IS NOT NULL THEN \$\{REPO_KEY\('e\.project_key'\)\}/);
  assert.match(arch, /`files` is one row per git repository \(the repository's part of the project key\) and path from the repository's root/);
  assert.match(guide, /A file in a git repository is its repository and its path from the repository’s root/);
  assert.match(agents, /groups edits the same way, by repository and path from the repository’s root/);
  // A hook that moved a hand starts the catch-up at once, whatever the once-a-minute claim says.
  assert.match(read('packages/cli/src/capture.ts'), /kickIndexBuild\(undefined, \{ hook: true, now: handMovedHere\(\) \}\);/);
  assert.match(readme, /at most once a minute and at once when a hook raised, changed or lowered a hand/);
  assert.match(guide, /at most once a minute and at once when it raised, changed or lowered a hand/);
  assert.match(changelog, /at most once a minute and at once when it moved a hand/);
  // Other machines' hands are read from the index as it stands, whichever way this machine's own were read.
  assert.match(read('packages/cli/src/index.ts'), /const synced = core\.readSyncedHands\(Date\.now\(\), includeDone\);/);
  assert.match(readme, /are read from it as it stands, caught up or not/);
  assert.match(guide, /read from it as it stands, caught up or not/);
  // `oak machine add` installs OAK only where it supports the Node: 24 and up.
  assert.match(read('packages/core/src/index/location.ts'), /return major >= 24;/);
  assert.doesNotMatch(agents, /Where the target has Node\.js 22\.16 or newer,/);
  // machine_label: the saved label, else the machine's own name; a query's --machine takes the id, self and a saved label
  // (query.ts machineIds), and refuses any other name.
  assert.match(read('packages/core/src/index/query.ts'), /SELECT machine_id FROM machines WHERE saved_label = \?/);
  assert.match(agents, /<code>coalesce\(m\.saved_label, m\.label\)<\/code> gives the name in <code>machine_label<\/code>/);
  assert.match(agents, /A query’s own <code>--machine<\/code> filter takes the id, <code>self<\/code>, or the label you saved the machine under, and refuses any other name/);
  assert.match(guide, /A query’s own <code>--machine<\/code> takes the id, <code>self<\/code>, or the label you saved a machine under, and refuses any other name with <code>bad_param<\/code>/);
  assert.match(flat('packages/cli/README.md'), /query's --machine takes, as it takes self and a saved machine's label, and refuses any other # name\) and by name \(machine_label: a saved machine's label/);
  assert.match(changelog, /id, which a query's own `--machine` takes, as it takes `self` and the label a saved machine has here \(any other name is refused with `bad_param`\), and by the name this machine knows it by/);
  // A machine's sessions come from the index only while no wait raised there in the last day is still open (api.ts).
  assert.match(read('packages/core/src/index/api.ts'), /w\.end_ms IS NULL\s+AND w\.start_ms >= \?/);
  assert.match(flat('packages/cli/src/index.ts'), /no hand raised in the last day still up\) \(fromIndex/);
  assert.match(arch, /none of which has a hand raised in the last day still up, is listed from the local database/);
  assert.match(agents, /as its records and the files the last run saw there say, and no hand raised there in the last day is still up/);
  // The demo cleanup and an uninstall's purge forget their sessions too; the demo's JSON lists its scratch dirs.
  assert.match(readme, /Only a deliberate delete forgets a session: `oak sessions --delete`, and `oak demo --clean` and `oak uninstall --purge-store`/);
  assert.match(read('packages/core/src/demo.ts'), /scratch: string\[\];/);
  assert.match(arch, /`--clean` → `\{ sessions\[\], workspaces\[\], scratch\[\] \}`/);
  // A call with no result under an input wait reads awaiting input (actions.ts).
  assert.match(read('packages/core/src/actions.ts'), /if \(hand === 'input'\) return \{ phase: 'awaiting-input', confidence: 'high' \};/);
  assert.match(agents, /as awaiting input while the hand is an input wait, and as working otherwise/);
});

test('Observations mocks match the rows and Sessions keeps Auto above session rows', () => {
  // Both editors give a ×N run its status icon and a plain tooltip. Auto precedes session rows, after machine state.
  const vscode = read('packages/vscode/src/extension.ts');
  const jb = 'packages/jetbrains/src/main/kotlin/com/cellobservatory/observatory/ui/';
  const run = vscode.slice(vscode.indexOf("if (node.kind === 'tlrun') {"));
  assert.match(run.slice(0, run.indexOf('return item;')), /item\.iconPath = aggregateIcon\(node\.edits\);/);
  assert.match(read(jb + 'ObservationsPanel.kt'), /val ob = if \(node\.count == 1\) .* else null/);
  assert.match(vscode, /var h=sv\+auto,/, 'machine state precedes Auto and all session rows');
  const repaint = read(jb + 'ChangeMapPanel.kt').split('private fun repaintSessions(')[1];
  assert.ok(repaint.indexOf('addElement(AutoSessionRow)') < repaint.indexOf('val merged = sessionOrder.rows('));
  const media = read('scripts/render-media.mjs');
  const col = media.slice(media.indexOf('const observationsCol'));
  const rows = col.slice(0, col.indexOf('`;')).split('\n').filter((l) => l.includes('class="obsrow"'));
  assert.ok(rows.some((r) => /×\d/.test(r)), 'the mock still shows a ×N run');
  for (const r of rows) if (/×\d/.test(r)) assert.doesNotMatch(r, /⚠/, 'a run leads with its status, never ⚠');
  const observations = media.slice(media.indexOf("'observations': scene"));
  assert.ok(observations.indexOf('${observationsCol}') < observations.indexOf('class="hovercard"'));
  assert.match(rows.at(-1), /⚠/, 'the hover card hangs under the ⚠ row');
  assert.doesNotMatch(rows.at(-1), /×\d/, 'which is a single edit');
  const sessions = require('node:vm').runInNewContext(media.slice(media.indexOf('const CSS ='), media.indexOf('// per-scene capture box')) + '\nscenes.sessions;');
  const states = [...sessions.matchAll(/<div class="mt-scope"[^>]*>([^<]+)<\/div>/g)];
  assert.equal(states.length, 2, 'one state line for each remote machine');
  assert.match(states[0][1], /^laptop · read /);
  assert.match(states[1][1], /^build-box · from its records, synced /);
  const auto = sessions.indexOf('Auto — newest session');
  assert.ok(states.every(s => s.index < auto), 'machine state precedes Auto');
  const sessionRows = [...sessions.matchAll(/<div class="mt-trow[^"]*"[^>]*>([\s\S]*?)<\/div>/g)].slice(1);
  assert.equal(sessionRows.length, 6);
  assert.ok(auto < sessionRows[0].index, 'Auto precedes all session rows');
  const times = sessionRows.map(r => /(?:Sep \d+ )?\d\d:\d\d(?::\d\d)?/.exec(r[1])[0]);
  assert.deepEqual(times, ['14:43:10', '14:38:22', '14:20:05', '13:10:44', '12:41:07', 'Sep 25 16:05'], 'one newest-first order across workspaces and machines');
  assert.deepEqual(sessionRows.map(r => /on (laptop|build-box)/.exec(r[1])?.[1] || 'local'),
    ['local', 'build-box', 'local', 'laptop', 'local', 'local'], 'remote rows carry badges in the merged list');
  assert.doesNotMatch(sessions, /grouped by workspace|~\/projects\/[^<]+ · \d+ sessions?/);
  assert.match(sessionRows[1][1], /~\/projects\/training/);
  assert.doesNotMatch(sessionRows[1][1], /conversation|resolve|🗑/, 'indexed rows offer no local actions');
  assert.match(sessionRows[3][1], /~\/projects\/data-tools/);
  assert.match(sessionRows[3][1], /resolve/);
  assert.doesNotMatch(sessionRows[3][1], /conversation|🗑/, 'saved-machine rows offer no local actions');
  for (const file of ['docs/_content/sessions-agents.html', 'docs/sessions-agents.html', 'docs/showcase.html', 'docs/DEMO.md']) {
    const figure = read(file).split('\n').find(line => line.includes('media/sessions.png'));
    assert.match(figure, /one list.*newest.*machine.*badge/i);
    assert.doesNotMatch(figure, /earlier Sessions view|workspace headers|grouped by workspace/);
  }
});

test('review pickers use local rows and stale comments and replay helper stay removed', () => {
  const jb = 'packages/jetbrains/src/main/kotlin/com/cellobservatory/observatory/';
  // Local listings exclude mirrored rows by default. Only a read explicitly addressed to a saved
  // machine accepts that machine’s indexed rows; both local pickers retain the default.
  assert.match(read(jb + 'model/Sessions.kt'), /localOnly: Boolean = true/);
  assert.match(read(jb + 'model/Sessions.kt'), /rows\.filter \{ !localOnly \|\| \(it\.get\("origin"\)\?\.asString \?: "local"\) == "local" \}/);
  assert.match(read(jb + 'core/SavedMachines.kt'), /SessionsParser\.parse\(r.stdout, localOnly = false\)/);
  for (const file of ['ui/TimelineSessionAction.kt', 'ui/ReviewOps.kt']) assert.match(read(jb + file), /SessionsParser\.parse\(/);
  assert.match(read(jb + 'ui/ChangeMapPanel.kt'), /WorkspaceHeaderRow/);
  assert.doesNotMatch(read(jb + 'ui/ChangeMapPanel.kt'), /MachineHeaderRow/);
  assert.doesNotMatch(read(jb + 'services/ObservatoryService.kt'), /SessionResolver/);
  assert.match(read(jb + 'services/ObservatoryService.kt'), /return \(peekSessions\(\) \?: sessionsFetch.get\(""\)\)\?\.active/);

  assert.doesNotMatch(read('packages/core/src/actions.ts'), /parseTranscriptProse/);
  assert.doesNotMatch(read('packages/core/src/index.ts'), /parseTranscriptProse/);
  assert.doesNotMatch(read('packages/core/src/notify.ts'), /the Agent tab/);
  assert.doesNotMatch(read('packages/vscode/src/extension.ts'), /whether the three sit side by side/);
  assert.doesNotMatch(read('packages/core/src/feed.ts'), /note\?: string;\n\n}/);
});

test('check:webview parses the script as it ships, after the template literal resolves its escapes: a planted \\\' fails it', t => {
  // `'it\'s'` in the source is a valid template escape that reaches the browser as `'it's'`, a syntax error.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-webview-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'packages/vscode/src'), { recursive: true });
  const gate = source => {
    fs.writeFileSync(path.join(dir, 'packages/vscode/src/extension.ts'), source);
    return cp.spawnSync(process.execPath, [path.join(root, 'scripts/check-webview-syntax.mjs')], { cwd: dir, encoding: 'utf8' });
  };
  const baseline = read('packages/vscode/src/extension.ts');
  const clean = gate(baseline);
  assert.equal(clean.status, 0, clean.stdout);
  assert.match(clean.stdout, /parsed: 5 {3}failed: 0/, 'control: the unchanged source parses');
  const opening = 'const TIMELINE_SCRIPT = `';
  assert.equal(baseline.split(opening).length, 2, 'one TIMELINE_SCRIPT literal to plant into');
  const planted = gate(baseline.replace(opening, opening + "\nvar planted = 'it\\'s';"));
  assert.equal(planted.status, 1, planted.stdout);
  assert.match(planted.stdout, /FAIL TIMELINE_SCRIPT/);
  // A backslash that survives the escape (`\\'` in the source ships as `\'`) is still valid, so it passes.
  const doubled = gate(baseline.replace(opening, opening + "\nvar planted = 'it\\\\'s';"));
  assert.equal(doubled.status, 0, doubled.stdout);
});

test('THIRD_PARTY_NOTICES names the version the lockfile installs for each npm package it lists, and exactly the bundles that hold it', () => {
  const lock = JSON.parse(read('package-lock.json')).packages;
  // The bundles OAK ships, and the packages each holds: esbuild keeps each bundled module's path in a comment
  // (`// ../../node_modules/diff/lib/index.js`). `npm test` builds them first; a missing one fails, never skips.
  const holds = new Map(['packages/cli/dist/cli.js', 'packages/cli/dist/capture.js', 'packages/vscode/dist/extension.js'].map((file) => {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} is not built: run npm run build and npm run build:vscode first`);
    return [file, new Set([...read(file).matchAll(/^\/\/ \S*node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//gm)].map(([, name]) => name))];
  }));
  const listed = new Set();
  let compared = 0;
  for (const section of read('THIRD_PARTY_NOTICES.md').split(/^## /m).slice(1)) {
    const name = section.split('\n')[0].trim();
    listed.add(name);
    const stated = /^- Version: ([^;\s]+);/m.exec(section)?.[1];
    if (name === 'herdr') { assert.equal(stated, undefined, 'herdr.lock pins herdr, which npm never installs'); continue; }
    // Every copy the lockfile installs, nested ones included: a notice for one it does not install fails too.
    const installed = [...new Set(Object.entries(lock).filter(([at]) => at === `node_modules/${name}` || at.endsWith(`/node_modules/${name}`)).map(([, entry]) => entry.version))];
    assert.deepEqual(installed, [stated], `THIRD_PARTY_NOTICES.md lists ${name} ${stated}; the lockfile installs ${installed.join(', ') || 'no copy of it'}`);
    // The bundles named here are exactly the shipped ones that hold the package, in both directions.
    const named = [...(/^- Bundled into ([\s\S]*?)(?=\n\n|\n- )/m.exec(section)?.[1] ?? '').matchAll(/`(packages\/[^`]+\.js)`/g)].map(([, file]) => file);
    for (const file of named) assert.ok(holds.has(file), `THIRD_PARTY_NOTICES.md says ${file} bundles ${name}; that is not a bundle OAK ships`);
    for (const [file, names] of holds) {
      assert.equal(named.includes(file), names.has(name), `THIRD_PARTY_NOTICES.md ${named.includes(file) ? 'says' : 'does not say'} ${file} bundles ${name}, which it ${names.has(name) ? 'does' : 'does not'}`);
    }
    compared++;
  }
  assert.ok(compared >= 7, `only ${compared} notices were compared with the lockfile`);
  // And every package a bundle holds has a notice.
  for (const [file, names] of holds) for (const name of names) assert.ok(listed.has(name), `${file} bundles ${name}, which THIRD_PARTY_NOTICES.md does not list`);
});


const docFlat = file => read(file).replace(/\s+/g, ' ');
test('final 0.11 docs: delegated walkthrough includes wait, worker log and integration', () => {
  const guide = docFlat('docs/_content/agents-across-machines.html');
  assert.match(guide, /oak agent wait docs login dates/);
  assert.match(guide, /oak feed --kind agent --id check-login/);
  assert.match(guide, /OAK does not merge/);
});
test('final 0.11 docs: database schema and derivation versions are current', () => {
  assert.match(docFlat('docs/ARCHITECTURE.md'), /Schema\*\* \(version 9/);
  assert.match(docFlat('docs/ARCHITECTURE.md'), /INGEST_VERSION.*5/);
  assert.match(docFlat('docs/_content/database-and-sync.html'), /CLI refuses unsupported Node.js/);
});
test('final 0.11 docs: saved-machine editor review is available', () => {
  const readme = docFlat('packages/vscode/README.md');
  assert.doesNotMatch(readme, /remote review runs only in the terminal|review requires the files and capture store on the editor backend/);
  assert.match(readme, /review actions run on that machine/);
});
test('final 0.11 docs: status bars distinguish window and dollar displays', () => {
  for (const file of ['docs/_content/stats-spotlight.html', 'packages/cli/README.md']) {
    assert.match(docFlat(file), /status bars omit the five-hour window/);
    assert.match(docFlat(file), /mo.*reset.*dollar/);
  }
  for (const file of ['scripts/render-media.mjs', 'docs/media/pyc-layout.src.html'])
    assert.match(read(file), /claude wk:.*mo:.*~\$18/);
});
test('final 0.11 docs: help names delegated and the backup undelete exception', () => {
  const cli = read('packages/cli/src/index.ts').slice(read('packages/cli/src/index.ts').indexOf('function usage('));
  assert.match(cli, /workers, delegated, findings, sync, notes/);
  assert.match(cli, /backup folder.*edits/);
});
