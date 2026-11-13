const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'packages/cli/dist/index.js');
const pin = JSON.parse(fs.readFileSync(path.join(root, 'herdr.lock'))).version;
const posix = process.platform === 'win32' && 'POSIX fake SSH server; Windows layouts simulated on Linux';

function remote(t, system = 'Linux') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oak-remote-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'local'), there = path.join(dir, "remote user's home $cash"), bin = path.join(home, 'bin');
  const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body, { mode: 0o755 }); };
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(there, 'tools'), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'),
    XDG_CONFIG_HOME: path.join(home, '.config'), PATH: bin + path.delimiter + process.env.PATH, REMOTE: there, LOG: path.join(dir, 'calls'), };
  write(path.join(bin, 'herdr'), `#!/bin/sh\necho "herdr $*" >> "$LOG"\ncase "$*" in '--version') echo 'herdr ${pin}' ;; 'machine list --json') echo '[]' ;; esac\n`);
  write(path.join(bin, 'ssh'), `#!/bin/sh
[ "$1" = -G ] && exit 0
for a in "$@"; do last="$a"; done
printf 'ssh %s\\n' "$*" >> "$LOG"
if [ "$last" = 'sh -s' ]; then
  case " $* " in *' -n '*) echo 'stdin disabled for script' >&2; exit 91 ;; esac
  script=$(cat)
  printf 'stdin %s\\n' "$script" >> "$LOG"
else
  # The reported WSL launcher loses double-quoted assignments on the command line.
  if [ -n "$MANGLE" ]; then last=$(printf '%s' "$last" | sed 's/[A-Za-z_][A-Za-z_0-9]*="[^"]*"//g'); fi
  case "$last" in x=*|*oak-shell-ok*) script="$last" ;; *) echo 'script was sent as an argument' >&2; exit 92 ;; esac
fi
cd "$REMOTE" || exit 1
printf '%s\\n' "$script" | /usr/bin/env -i HOME="$REMOTE" PATH="$REMOTE/tools:/usr/bin:/bin" /bin/sh -s
`);
  write(path.join(bin, 'scp'), `#!/bin/sh
r=; skip=; n=$#; i=0
for a in "$@"; do
  i=$((i+1))
  if [ -n "$skip" ]; then skip=; continue; fi
  case "$a" in -o) skip=1 ;; -r) r=-r ;; -*) ;; *) if [ "$i" -eq "$n" ]; then dest="$REMOTE/\${a#*:}"; else src="$a"; fi ;; esac
done
printf 'scp %s\\n' "$*" >> "$LOG"
cp $r "$src" "$dest" || exit 1
if [ -n "$FAIL_COPY" ]; then case "$src" in *"$FAIL_COPY") echo 'copy interrupted' >&2; exit 1 ;; esac; fi
`);
  write(path.join(there, 'tools', 'uname'), `#!/bin/sh\nif [ "$1" = -s ]; then printf '${system}\\r\\n'; else printf 'x86_64\\r\\n'; fi\n`);
  write(path.join(there, 'tools', 'node'), `#!/bin/sh\nif [ "$1" = --version ]; then echo v24.18.0; else shift; if [ "$1" = --version ]; then if [ -f "$HOME/fail-version" ]; then echo broken; else echo 'oak 9.9.9'; fi; fi; fi\n`);
  write(path.join(there, 'tools', 'mv'), `#!/bin/sh\ncase "$1" in *-new) if [ -f "$HOME/fail-launch" ]; then echo 'launcher move failed' >&2; exit 1; fi ;; esac\nexec /bin/mv "$@"\n`);
  const herdr = (where, version = pin) => write(path.join(there, where), `#!/bin/sh\necho 'herdr ${version}'\n`);
  const oak = (where = 'tools/oak') => write(path.join(there, where), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$HOME/oak-calls"\n[ "$1" = --version ] && echo "oak 9.9.9"\nexit 0\n');
  const add = (extra = {}) => cp.spawnSync(process.execPath, [cli, 'machine', 'add', 'box', 'fixture@box'], { cwd: home, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = () => fs.readFileSync(env.LOG, 'utf8');
  const leftovers = () => ['.local/bin', '.local/lib'].flatMap(p => { try { return fs.readdirSync(path.join(there, p)).filter(n => n.includes('.oak-')); } catch { return []; } });
  return { dir, there, write, herdr, oak, add, log, leftovers };
}

for (const system of ['MINGW64_NT-10.0-26100', 'MSYS_NT-10.0-26100', 'CYGWIN_NT-10.0']) {
  test(`machine remote: accepts Windows ${system} with herdr.exe in its directory and an installed oak`, { skip: posix }, t => {
    const f = remote(t, system);
    f.herdr('.local/bin/herdr/herdr.exe');
    f.oak();
    const r = f.add();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /already runs herdr/);
    assert.match(r.stdout, /already runs oak/);
    assert.doesNotMatch(f.log(), /scp |mkdir |export PATH=.*>>/);
    assert.deepEqual(fs.readFileSync(path.join(f.there, 'oak-calls'), 'utf8').trim().split('\n'), ['init --no-codex', 'init --codex', '--version']);
    assert.deepEqual(f.leftovers(), []);
  });
}

test('machine remote: existing herdr is checked on every platform, with PATH fallback', { skip: posix }, t => {
  for (const system of ['FreeBSD', 'MINGW64_NT-10.0']) {
    const f = remote(t, system); f.herdr('tools/herdr'); f.oak();
    const r = f.add();
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.doesNotMatch(f.log(), /scp /);
  }
});

test('machine remote: Windows missing or old herdr asks for its installer, and missing oak never gets a POSIX launcher', { skip: posix }, t => {
  for (const version of [null, '0.0.1', pin]) {
    const f = remote(t, 'MINGW64_NT-10.0');
    if (version) f.herdr('.local/bin/herdr/herdr.exe', version);
    const r = f.add();
    assert.equal(r.status, version === pin ? 0 : 1, r.stderr + r.stdout);
    assert.match(r.stderr + r.stdout, version === pin ? /install OAK on Windows/ : /Windows installer/);
    assert.doesNotMatch(f.log(), /scp |mkdir /);
  }
});

test('machine remote: quoting failure stops before saving or copying and names the distro sshd', { skip: posix }, t => {
  const f = remote(t); f.herdr('.local/bin/herdr');
  const r = f.add({ MANGLE: '1' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /does not preserve shell quoting.*Windows OpenSSH.*WSL launcher.*distro's own sshd/);
  assert.doesNotMatch(f.log(), /scp |herdr machine add|mkdir /);
});

test('machine remote: stdin scripts install in a home with spaces and shell characters', { skip: posix }, t => {
  const f = remote(t); f.herdr('.local/bin/herdr');
  const r = f.add();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(fs.existsSync(path.join(f.there, '.local/lib/oak/cli.js')));
  assert.match(fs.readFileSync(path.join(f.there, '.local/bin/oak'), 'utf8'), /"\$HOME\/\.local\/lib\/oak\/index.js"/);
  assert.match(f.log(), /ssh -T -n .*x="a b"/);
  assert.deepEqual(f.leftovers(), []);
});

for (const step of ['copy', 'launch', 'version']) test(`machine remote: failed ${step} removes this run and preserves an older installation`, { skip: posix }, t => {
  for (const old of [false, true]) {
    const f = remote(t); f.herdr('.local/bin/herdr');
    const launcher = '#!/bin/sh\n# /.local/lib/oak/index.js\necho old\n';
    if (old) {
      f.write(path.join(f.there, '.local/bin/oak'), launcher);
      f.write(path.join(f.there, '.local/lib/oak/old-data'), 'old bundle');
    }
    if (step !== 'copy') f.write(path.join(f.there, `fail-${step}`), '');
    const r = f.add(step === 'copy' ? { FAIL_COPY: 'capture.js' } : {});
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, step === 'copy' ? /copy interrupted/ : step === 'launch' ? /launcher move failed/ : /oak returned no version/);
    assert.deepEqual(f.leftovers(), [], r.stderr);
    if (old) {
      assert.equal(fs.readFileSync(path.join(f.there, '.local/bin/oak'), 'utf8'), launcher);
      assert.deepEqual(fs.readdirSync(path.join(f.there, '.local/lib/oak')), ['old-data']);
    } else {
      assert.equal(fs.existsSync(path.join(f.there, '.local/lib/oak')), false);
      assert.equal(fs.existsSync(path.join(f.there, '.local/bin/oak')), false);
    }
  }
});

test('machine remote: ssh scripts receive stdin; probes and scp receive none and bypass a local shell', { skip: posix }, t => {
  const f = remote(t); f.herdr('.local/bin/herdr');
  const preload = path.join(f.dir, 'spawns.cjs'), log = path.join(f.dir, 'spawns.jsonl');
  f.write(preload, `const cp = require('child_process'), fs = require('fs');
const original = cp.spawnSync;
cp.spawnSync = function(file, args, opts) {
  if (file === 'ssh' || file === 'scp') fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ file, args, stdio: opts.stdio, input: opts.input, shell: opts.shell }) + '\\n');
  return original.apply(this, arguments);
};`);
  const r = f.add({ NODE_OPTIONS: `--require=${preload}` });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.length > 8);
  for (const c of calls) {
    assert.equal(c.shell, false, JSON.stringify(c));
    if (c.args.at(-1) === 'sh -s') {
      assert.ok(c.input.endsWith('\n'), 'the script arrives on stdin');
      assert.equal(c.args.includes('-n'), false, 'ssh must read the script');
    } else {
      assert.equal(c.stdio[0], 'ignore', JSON.stringify(c));
      assert.equal(c.input, undefined);
    }
  }
});

test('machine remote: a partial herdr copy is removed without replacing the old binary', { skip: posix || (process.platform !== 'linux' && 'Linux herdr asset reuse') }, t => {
  const f = remote(t); f.herdr('.local/bin/herdr', '0.0.1');
  const file = path.join(f.there, '.local/bin/herdr'), before = fs.readFileSync(file);
  const r = f.add({ FAIL_COPY: 'herdr' });
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stderr, /copy interrupted/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(f.leftovers(), []);
});
