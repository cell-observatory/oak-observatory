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
function runBootstrap(t, { npmFails = false, pty = false, digest, plugin = true, tools = false } = {}) {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-bootstrap-'));
  t.after(() => fs.rmSync(box, { recursive: true, force: true }));
  const bin = path.join(box, 'bin');
  fs.mkdirSync(bin);
  for (const tool of ['mktemp', 'rm', 'grep', 'head', 'sed', 'node', 'uname', 'cat', 'cp', 'mkdir', 'touch', 'basename']) fs.symlinkSync(realTool(tool), path.join(bin, tool));
  const tgz = path.join(box, 'release.tgz');
  fs.writeFileSync(tgz, 'fixture tarball bytes');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
  const json = path.join(box, 'release.json');
  fs.writeFileSync(json, JSON.stringify({ tag_name: 'v9.9.9', assets: [{ name: 'oak-observatory-9.9.9.tgz',
    digest: `sha256:${digest ?? sha}`, browser_download_url: 'https://fixture.invalid/oak-observatory-9.9.9.tgz' }] }));
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
case "$url" in *api.github.com*) cat "${json}" ;; *) cp "${tgz}" "$out" ;; esac`), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), script(`case "$1" in
  ls) exit 1 ;;
  root) printf '%s\\n' "${npmRoot.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/, '***')}" ;;
  exec) while [ $# -gt 0 ] && [ "$1" != -c ]; do shift; done; npm_config_global_prefix="${npmPrefix}" /bin/sh -c "$2" ;;
  i) ${npmFails ? 'echo "npm error code EEXIST" >&2; exit 1' : `pkg="${npmRoot}/oak-observatory"; mkdir -p "$pkg/dist/herdr-plugin"; touch "$pkg/dist/THIRD_PARTY_NOTICES.md"
     ${plugin ? 'touch "$pkg/dist/herdr-plugin/herdr-plugin.toml"' : ''}
     ${pty === true ? 'mkdir -p "$pkg/node_modules/node-pty"; echo "module.exports = {}" > "$pkg/node_modules/node-pty/index.js"' : ''}`} ;;
esac`), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'oak'), script(''), { mode: 0o755 });
  const r = cp.spawnSync(realTool('bash'), [path.join(root, 'scripts/bootstrap.sh')], {
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
// Runs a step the way GitHub does (bash -eo pipefail) with a fake gh first on PATH.
function runStep(t, block, env) {
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
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, ...env } });
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
  assert.match(read('.github/workflows/pages.yml'), /setup-node@v7\n\s+with:\n\s+node-version: 22\n/);
});

test('CLI package: ships oak, oak-observatory and the deprecated claude-observatory, and no generic command name', () => {
  // `observatory` belongs to Mozilla's observatory-cli, and npm refuses a whole install whose bin
  // collides with another package's (EEXIST).
  const want = { oak: 'dist/index.js', 'oak-observatory': 'dist/index.js', 'claude-observatory': 'dist/index.js' };
  assert.deepEqual(JSON.parse(read('packages/cli/package.json')).bin, want);
  assert.deepEqual(JSON.parse(read('package-lock.json')).packages['packages/cli'].bin, want);
});

test('installers: install.ps1 is ASCII, so Windows PowerShell 5.1 can parse it when it runs the file', () => {
  // 5.1 reads a script with no BOM in the ANSI code page, where the last byte of `—` or `✓` decodes to a
  // curly double quote that ends the string. A BOM is no fix: `irm … | iex` would start with U+FEFF.
  const bad = read('install.ps1').split('\n').map((l, i) => `${i + 1}: ${l}`).filter((l) => /[^\x00-\x7f]/.test(l));
  assert.deepEqual(bad, []);
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
test('Pages gate detects removal of the freshness command from a copy', () => {
  const source = read('.github/workflows/pages.yml');
  checkPages(source);
  assert.throws(() => checkPages(source.replace('git diff --exit-code -- docs', 'true')), /generate and verify/);
});

test('Feed docs and media describe four chronological Timeline tabs and actual consumers', () => {
  const media = read('scripts/render-media.mjs');
  assert.ok(media.includes("${tlTab('Feed', 0, false)}${tlTab('Prompts', 3, true)}${tlTab('Observations', 9, false)}${tlTab('Actions', 39, false)}"));
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
  const changelog = read('CHANGELOG.md').split('### Changed')[0];
  assert.match(changelog, /Timeline gains a \*\*Feed\*\* tab/);
  assert.match(changelog, /session, agent, workflow and task/);
});

test('machine and Feed documentation matches shipped behavior', () => {
  const overview = read('docs/_content/editors-overview.html');
  assert.match(overview, /sessions grouped by workspace/);
  assert.match(overview, /Selecting a local session/);
  assert.match(overview, /do not gather other machines/);
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
    assert.match(read(file), /group(?:s|ed) .*by workspace/);
    assert.match(read(file), /[Ss]electing a local/);
  }
  const arch = read('docs/ARCHITECTURE.md');
  assert.doesNotMatch(arch, /machineSessionMeta|machine-sessions.json/);
  assert.match(arch, /workspace first|editor root first/);
  assert.match(read('packages/core/src/tour.ts'), /Sessions are grouped by workspace/);
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
  assert.match(media.slice(media.indexOf("'sessions': scene")), /~\/projects\/training · 3 sessions/);
});

test('the Observations and Sessions mocks draw the rows both editors draw', () => {
  // Both editors give a ×N run its status icon and a plain tooltip, and list the Auto row above every workspace.
  const vscode = read('packages/vscode/src/extension.ts');
  const jb = 'packages/jetbrains/src/main/kotlin/com/cellobservatory/observatory/ui/';
  const run = vscode.slice(vscode.indexOf("if (node.kind === 'tlrun') {"));
  assert.match(run.slice(0, run.indexOf('return item;')), /item\.iconPath = aggregateIcon\(node\.edits\);/);
  assert.match(read(jb + 'ObservationsPanel.kt'), /val ob = if \(node\.count == 1\) .* else null/);
  assert.match(vscode, /var h=auto,/);
  const repaint = read(jb + 'ChangeMapPanel.kt').split('private fun repaintSessions(')[1];
  assert.ok(repaint.indexOf('addElement(AutoSessionRow)') < repaint.indexOf('overviewSessionGroups('));
  const media = read('scripts/render-media.mjs');
  const col = media.slice(media.indexOf('const observationsCol'));
  const rows = col.slice(0, col.indexOf('`;')).split('\n').filter((l) => l.includes('class="obsrow"'));
  assert.ok(rows.some((r) => /×\d/.test(r)), 'the mock still shows a ×N run');
  for (const r of rows) if (/×\d/.test(r)) assert.doesNotMatch(r, /⚠/, 'a run leads with its status, never ⚠');
  const observations = media.slice(media.indexOf("'observations': scene"));
  assert.ok(observations.indexOf('${observationsCol}') < observations.indexOf('class="hovercard"'));
  assert.match(rows.at(-1), /⚠/, 'the hover card hangs under the ⚠ row');
  assert.doesNotMatch(rows.at(-1), /×\d/, 'which is a single edit');
  const sessions = media.slice(media.indexOf("'sessions': scene"));
  assert.ok(sessions.indexOf('Auto — newest session') < sessions.indexOf('~/projects/training · 3 sessions'), 'Auto leads the list');
});

test('review pickers use local rows and stale comments and replay helper stay removed', () => {
  const jb = 'packages/jetbrains/src/main/kotlin/com/cellobservatory/observatory/';
  // Local rows only: the listing parser is the one guard (it drops any non-local row), and both pickers
  // read what it parsed.
  assert.match(read(jb + 'model/Sessions.kt'), /rows\.filter \{ \(it\.get\("origin"\)\?\.asString \?: "local"\) == "local" \}/);
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
