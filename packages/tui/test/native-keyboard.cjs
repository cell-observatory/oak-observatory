const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const { createNativeInput, decodeNativeKey } = require('../dist/native-input');

function fixture(t) {
  const filename = require.resolve('../dist/native');
  const fresh = new Module(filename, module); fresh.filename = filename; fresh.paths = module.paths;
  const load = fresh.require.bind(fresh);
  let data, exit;
  const input = [], output = [];
  fresh.require = name => name === 'node-pty' ? { spawn: () => ({ pid: 123,
    write: text => input.push(text), onData(fn) { data = fn; }, onExit(fn) { exit = fn; }, kill() {}, resize() {},
  }) } : load(name);
  fresh._compile(fs.readFileSync(filename, 'utf8'), filename);
  const session = fresh.exports.spawnNative('fixture', [], 40, 3, process.cwd(), 'fixture');
  const write = process.stdout.write;
  process.stdout.write = function(text, ...args) {
    if (typeof text === 'string' && text.startsWith('\x1b')) { output.push(text); return true; }
    return write.call(this, text, ...args);
  };
  t.after(() => { session.close(); process.stdout.write = write; });
  return { session, input, output, reply: fresh.exports.routeNativeHostReply, exit: () => exit({ exitCode: 0 }),
    emit: text => new Promise(resolve => { session.onUpdate(resolve); data(text); }) };
}

test('native keyboard: xterm mirrors split pushes, sets, bounded pops and replays the current stack', async t => {
  const f = fixture(t); f.session.setHostActive?.(true);
  await f.emit('\x1b[>3'); await f.emit('1u\x1b[>7u\x1b[=8;2u\x1b[=2;3u');
  assert.deepEqual(f.output.splice(0), ['\x1b[>31u', '\x1b[>7u', '\x1b[=8;2u', '\x1b[=2;3u']);
  f.session.setHostActive(false);
  assert.deepEqual(f.output.splice(0), ['\x1b[<2u']);
  await f.emit('\x1b[<u\x1b[=1;3u');
  assert.deepEqual(f.output, [], 'hidden output cannot change the host');
  f.session.setHostActive(true);
  assert.deepEqual(f.output.splice(0), ['\x1b[>30u']);
  await f.emit('\x1b[<999u');
  assert.deepEqual(f.output.splice(0), ['\x1b[<1u'], 'never pop the caller baseline');
  f.session.close(); assert.deepEqual(f.output, []);
});

test('native keyboard: bare SET saves baseline; exit and queued post-exit output cannot leak modes', async t => {
  const f = fixture(t); f.session.setHostActive?.(true);
  await f.emit('\x1b[=3u');
  assert.deepEqual(f.output.splice(0), ['\x1b[>0u', '\x1b[=3;1u']);
  f.session.setHostActive(false); assert.deepEqual(f.output.splice(0), ['\x1b[<1u']);
  f.session.setHostActive(true); assert.deepEqual(f.output.splice(0), ['\x1b[>3u']);
  await f.emit('\x1b[>31u'); f.output.length = 0;
  f.exit(); assert.deepEqual(f.output.splice(0), ['\x1b[<2u']);
  await f.emit('\x1b[>31u'); f.session.setHostActive(true); f.session.close();
  assert.deepEqual(f.output, []);
});

test('native keyboard: quit can synchronously restore all pushed levels', async t => {
  const f = fixture(t); f.session.setHostActive?.(true);
  await f.emit('\x1b[>7u\x1b[>31u'); f.output.length = 0;
  const sync = []; f.session.setHostActive(false, undefined, text => sync.push(text)); f.session.close();
  assert.deepEqual(sync, ['\x1b[<2u']); assert.deepEqual(f.output, []);
});

test('native keyboard: query forwards real capabilities and replies to its child after deactivation', async t => {
  const f = fixture(t);
  await f.emit('\x1b[?u'); assert.deepEqual(f.output, []);
  f.session.setHostActive(true); assert.deepEqual(f.output.splice(0), ['\x1b[?u']);
  f.session.setHostActive(false);
  assert.equal(f.reply(Buffer.from('\x1b[?0u')), true);
  assert.deepEqual(f.input.splice(0), ['\x1b[?0u']);
  f.session.setHostActive(true); await f.emit('\x1b[?u'); f.session.close();
  assert.equal(f.reply(Buffer.from('\x1b[?31u')), true); assert.deepEqual(f.input, []);
  assert.equal(f.reply(Buffer.from('\x1b[119;9u')), false);
});

test('native modes: child cannot disable OAK paste/focus/mouse or downgrade hover tracking', async t => {
  const f = fixture(t); f.session.setHostActive(true);
  await f.emit('\x1b[?2004;1004;1003;1006l\x1b[?1000h\x1b[?1002h');
  assert.deepEqual(f.output, []);
  f.session.setHostActive(false); f.session.setHostActive(true, [2004, 1004]);
  assert.deepEqual(f.output.splice(0), ['\x1b[?1002h']);
  await f.emit('\x1b[?1003;1006h');
  assert.deepEqual(f.output.splice(0), ['\x1b[?1002l', '\x1b[?1003h', '\x1b[?1006h']);
  f.session.close(); assert.deepEqual(f.output, ['\x1b[?1003l', '\x1b[?1006l']);
});

test('native modes: CSI-like text inside a control string never changes host keyboard modes', async t => {
  const f = fixture(t); f.session.setHostActive(true);
  await f.emit('\x1b]2;title >31u\x07plain >31u');
  assert.deepEqual(f.output, []);
});

test('native keys: plain, shift, ctrl, alt, super and event types retain the OAK key vocabulary', () => {
  for (const [raw, key, mods] of [
    ['\x1b[110u', 'n', {}], ['\x1b[110;1u', 'n', {}], ['\x1b[110;2u', 'N', { shift: true }],
    ['\x1b[110:78;2u', 'N', { shift: true }], ['\x1b[97;5u', 'a', { ctrl: true }],
    ['\x1b[113;5u', 'q', { ctrl: true }], ['\x1b[110;3u', 'n', { alt: true }],
    ['\x1b[119;9u', 'w', { super: true }], ['\x1b[119;17u', 'w', { hyper: true }],
    ['\x1b[119;33u', 'w', { meta: true }], ['\x1b[13u', 'enter', {}], ['\x1b[27u', 'escape', {}],
    ['\x1b[9;2u', 'backtab', { shift: true }], ['\x1b[1;5A', 'up', { ctrl: true }],
    ['\x1b[1;9Z', 'backtab', { super: true }],
    ['\x1b[57350u', 'left', {}], ['\x1b[128512u', '😀', {}],
    ['\x1b[119;9:2;119u', 'w', { super: true, event: 'repeat' }],
  ]) assert.deepEqual(decodeNativeKey(raw), { t: 'key', key, ctrl: false, alt: false, shift: false,
    super: false, hyper: false, meta: false, event: 'press', ...mods }, raw);
  for (const [code, event] of [[1, 'press'], [2, 'repeat'], [3, 'release']]) {
    assert.equal(decodeNativeKey(`\x1b[97;5:${code}u`).event, event);
    assert.equal(decodeNativeKey(`\x1b[1;5:${code}D`).event, event);
    assert.equal(decodeNativeKey(`\x1b[1;9:${code}Z`).event, event);
    assert.equal(decodeNativeKey(`\x1b[3;5:${code}~`).event, event);
  }
  for (const raw of ['\x1b[?31u', '\x1b[>31u', '\x1b[1114112u', '\x1b[55296u']) assert.equal(decodeNativeKey(raw), null);
});

test('native keys: all read boundaries preserve raw keys, leader following keys, paste and UTF-8', () => {
  const raw = Buffer.from('x\x01\x1b[97;5u\x1b[110u\x1b[119;9:3u\x1b[1;5:2Aλ😀\x1b[200~\x01\x11\x1b[113;5uλ\x1b[201~');
  const full = createNativeInput().push(raw);
  for (let split = 1; split < raw.length; split++) {
    const input = createNativeInput();
    const parts = [...input.push(raw.subarray(0, split)), ...input.push(raw.subarray(split))];
    assert.deepEqual(Buffer.concat(parts.map(p => p.bytes)), raw, `bytes at split ${split}`);
    assert.deepEqual(parts, full, `events at split ${split}`);
    assert.equal(input.pending(), '');
  }
  assert.equal(full.at(-1).events[0].t, 'paste', 'pasted hotkeys never become commands');
  assert.equal(full.filter(p => p.events[0]?.t === 'key' && p.events[0].key === 'q').length, 0);
});

test('native keys: lone escape flushes; unrelated control after it remains a separate hotkey', () => {
  const input = createNativeInput(); assert.deepEqual(input.push(Buffer.from('\x1b')), []);
  assert.equal(input.flush()[0].events[0].key, 'escape');
  input.push(Buffer.from('\x1b'));
  assert.deepEqual(input.push(Buffer.from('\x01n')).map(p => p.events[0].key), ['escape', 'a', 'n']);
});

test('built CLI PTY: CSI-u leader quit restores the host keyboard mode', { timeout: 25000 }, t => require('./fixtures/herdr-pty-probe.cjs')(t, 'leader-quit'));

test('native input frames ESC plus a WHOLE code point, at every read boundary', () => {
  const { createDecoder } = require('../dist/input');
  // Alt+e-acute arrives as ESC c3 a9. Framed as two BYTES it reached the decoder as half a character:
  // a corrupt Alt key, and then a loose continuation byte that became an ordinary unmodified key —
  // which the Observatory reply field typed straight into the draft.
  for (const text of ['\x1bé', '\x1bλ', '\x1b€', '\x1b😀', '\x1bf', '\x1b\t']) {
    const raw = Buffer.from(text, 'utf8');
    const full = createNativeInput().push(raw);
    assert.deepEqual(full.flatMap(p => p.events), createDecoder().push(raw), `one framer: ${JSON.stringify(text)}`);
    assert.deepEqual(Buffer.concat(full.map(p => p.bytes)), raw, `bytes: ${JSON.stringify(text)}`);
    for (let split = 1; split < raw.length; split++) {
      const input = createNativeInput();
      const parts = [...input.push(raw.subarray(0, split)), ...input.push(raw.subarray(split))];
      assert.deepEqual(Buffer.concat(parts.map(p => p.bytes)), raw, `bytes at split ${split}`);
      assert.deepEqual(parts, full, `events at split ${split} of ${JSON.stringify(text)}`);
      assert.equal(input.pending(), '');
    }
  }
  assert.deepEqual(createNativeInput().push(Buffer.from('\x1bé', 'utf8')).flatMap(p => p.events),
    [{ t: 'key', key: 'é', ctrl: false, alt: true, shift: false }], 'no unmodified key is manufactured from the tail bytes');
});

test('native input adapter preserves legacy Alt+Tab, Alt+Enter and Alt+Backspace', () => {
  const { createDecoder } = require('../dist/input');
  for (const raw of ['\x1b\t', '\x1b\r', '\x1b\n', '\x1b\b', '\x1b\x7f']) {
    const input = createNativeInput();
    const parts = [...input.push(Buffer.from(raw[0])), ...input.push(Buffer.from(raw[1]))];
    assert.deepEqual(parts.flatMap(p => p.events), createDecoder().push(raw), JSON.stringify(raw));
  }
});
