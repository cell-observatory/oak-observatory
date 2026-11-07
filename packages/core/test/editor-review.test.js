const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const core = require(process.env.RV3_CORE_MODULE || '../dist');
const { parseMountTable } = require('../dist/sync-identity');

test('editor handoff is scoped to workspace/editor, atomic once, and expires', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-'));
  const old = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    assert.equal(typeof core.writeEditorReviewRequest, 'function');
    const request = { editor: 'cursor', session: 'synthetic', workspace: dir, action: 'edit', edit: 7 };
    core.writeEditorReviewRequest(request, 1000);
    assert.equal(core.consumeEditorReviewRequest('vscode', dir, 1001), null);
    assert.equal(core.consumeEditorReviewRequest('cursor', dir + '/other', 1001), null);
    assert.equal(core.consumeEditorReviewRequest('cursor', dir, 1001).edit, 7);
    assert.equal(core.consumeEditorReviewRequest('cursor', dir, 1001), null);
    core.writeEditorReviewRequest(request, 1000);
    assert.equal(core.consumeEditorReviewRequest('cursor', dir, 601000), null);
    for (const action of ['file', 'all', 'workspace']) {
      core.writeEditorReviewRequest({ ...request, action, file: '/remote/f.ts', prompt: 'ask-2' }, 2000);
      const r = core.consumeEditorReviewRequest('cursor', dir, 2001);
      assert.equal(r.session, 'synthetic'); assert.equal(r.action, action); assert.equal(r.prompt, 'ask-2');
      assert.equal(core.consumeEditorReviewRequest('cursor', dir, 2001), null);
      core.writeEditorReviewRequest({ ...request, action }, 2000);
      assert.equal(core.consumeEditorReviewRequest('cursor', dir, 602000), null);
    }
  } finally { if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('mount mapping uses the saved host, homes share or matching remote share, never a lookalike', () => {
  assert.equal(typeof core.mapReviewPath, 'function');
  const remote = { home: '/home/fixture', hostname: 'lab-a', user: 'fixture', shares: [] };
  const mac = parseMountTable('//fixture@lab-a/fixture on /Volumes/fixture (smbfs, nodev)\n//fixture@lab-b/fixture on /Volumes/wrong (smbfs, nodev)', 'mac');
  assert.equal(core.mapReviewPath('/home/fixture/Github/app/a.ts', 'alias', remote, mac), '/Volumes/fixture/Github/app/a.ts');
  assert.equal(core.mapReviewPath('/home/fixture2/a', 'alias', remote, mac), null);
  assert.equal(core.mapReviewPath('/home/fixture/../secret', 'alias', remote, mac), null);
  assert.equal(core.mapReviewPath('/home/fixture/a', 'lab-a', remote, mac.slice(1)), null);
  const linux = parseMountTable('lab-a:/home/fixture /mnt/a nfs4 rw 0 0\n//files/team /mnt/team cifs rw 0 0', 'linux');
  assert.equal(core.mapReviewPath('/home/fixture/a', 'lab-a', remote, linux), '/mnt/a/a');
  remote.shares = parseMountTable('//files/team /groups/team cifs rw 0 0', 'linux');
  assert.equal(core.mapReviewPath('/groups/team/a', 'lab-a', remote, linux), '/mnt/team/a');
  assert.equal(core.mapReviewPath('/local/same.ts', 'lab-a', remote, linux), null);
});
