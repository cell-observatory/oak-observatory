const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('retired runtime and transport symbols do not survive in package sources', () => {
  const packages = path.resolve(__dirname, '../..');
  const forbidden = /@agentclientprotocol|openAcpDrive|remoteWire|--bridge|remoteRows/;
  for (const symbol of ['@agentclientprotocol', 'openAcpDrive', 'remoteWire', '--bridge', 'remoteRows'])
    assert.ok(forbidden.test(symbol), `source guard detects ${symbol}`);
  const violations = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, index) => { if (forbidden.test(line)) violations.push(`${path.relative(packages, file)}:${index + 1}`); });
      }
    }
  }
  for (const entry of fs.readdirSync(packages)) {
    const src = path.join(packages, entry, 'src');
    if (fs.existsSync(src)) walk(src);
  }
  assert.deepEqual(violations, []);
});

const retired = /oak (?:drive|send|wait|remotes)\b|--serve\b|--bridge\b|--remote |manageRemotes|DriveController|DriveService|Agent tab/;

function retiredLines(relative, text) {
  let historicalRelease = false;
  const hits = [];
  text.split('\n').forEach((line, index) => {
    // The changelog is a historical record. Only released version sections and the explicit
    // removal announcement may name the retired interfaces; current instructions may not.
    if (relative === 'CHANGELOG.md' && /^## \[\d+\.\d+\.\d+[^\]]*\]/.test(line)) historicalRelease = true;
    const removal = relative === 'CHANGELOG.md' && /^- Removed `oak drive` \(use `oak agent start` and `oak prompt`\), `oak remotes` \(use `oak machine`\)/.test(line);
    if (retired.test(line) && !historicalRelease && !removal) hits.push(`${relative}:${index + 1}: ${line.trim()}`);
  });
  return hits;
}

test('retirement guard detects every retired documentation symbol and limits historical exceptions', () => {
  for (const symbol of ['oak drive', 'oak send', 'oak wait', 'oak remotes', '--serve', '--bridge', '--remote host', 'manageRemotes', 'DriveController', 'DriveService', 'Agent tab']) {
    for (const file of ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'docs/REMOTE.md', 'docs/_content/cli.html', 'packages/cli/README.md', 'packages/vscode/package.json', 'packages/jetbrains/src/main/resources/META-INF/plugin.xml']) {
      assert.equal(retiredLines(file, `use ${symbol}`).length, 1, `${file} detects ${symbol}`);
    }
    assert.equal(retiredLines('CHANGELOG.md', `## [Unreleased]\n${symbol}`).length, 1);
    assert.deepEqual(retiredLines('CHANGELOG.md', `## [0.9.0] - 2026-01-01\n${symbol}`), []);
  }
  const removal = '- Removed `oak drive` (use `oak agent start` and `oak prompt`), `oak remotes` (use `oak machine`).';
  assert.deepEqual(retiredLines('CHANGELOG.md', removal), []);
  assert.equal(retiredLines('README.md', removal).length, 1, 'the removal exception is changelog-only');
  assert.equal(retiredLines('docs/_content/releases.html', 'oak drive').length, 1, 'the current release guide is not historical release notes');
});

test('retired commands and UI names do not survive in docs or shipped manifests', () => {
  const root = path.resolve(__dirname, '../../..');
  const files = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md',
    'packages/vscode/package.json', 'packages/jetbrains/src/main/resources/META-INF/plugin.xml'];
  for (const name of fs.readdirSync(path.join(root, 'docs'))) {
    if (name.endsWith('.md')) files.push(`docs/${name}`);
  }
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  walk('docs/_content');
  for (const name of fs.readdirSync(path.join(root, 'packages'))) {
    const file = `packages/${name}/README.md`;
    if (fs.existsSync(path.join(root, file))) files.push(file);
  }
  const violations = files.flatMap(file => retiredLines(file, fs.readFileSync(path.join(root, file), 'utf8')));
  assert.deepEqual(violations, []);
});
