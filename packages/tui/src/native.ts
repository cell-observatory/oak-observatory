/**
 * A native-CLI passthrough tab: run a real terminal program (codex, claude, a shell) under a PTY,
 * parse its output with @xterm/headless into a cell grid, and paint that grid in the tab body.
 *
 * TWO DEPENDENCIES, ONE OF THEM OPTIONAL AND NATIVE. `@xterm/headless` is pure JS (bundled). `node-pty`
 * ships a compiled binding, so it is an OPTIONAL dependency and is `require`d lazily: a machine with no
 * build toolchain has no node-pty, and that MUST NOT break `require('...tui')`. When it is absent the
 * native tab kind simply does not exist — `nativeAvailable()` is false and the caller says why. This is
 * the deliberate trade the authors deferred (node-pty vs the "no build toolchain" install promise), now
 * taken behind a gate that fails soft.
 */

import type { ColorDepth } from './glyphs';
import { StringDecoder } from 'string_decoder';
import * as fs from 'fs';
import * as path from 'path';
import type { Check } from '@oak-observatory/core';

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Memoize an OPTIONAL require: `null` (not absent) once loading fails, so a machine with no prebuild
 *  never re-tries and never lets the failure escape `require('...tui')`. */
function lazy<T>(load: () => T): () => T | null {
  let v: T | null | undefined;
  return () => {
    if (v === undefined) {
      try {
        v = load();
      } catch {
        v = null;
      }
    }
    return v;
  };
}
const pty = lazy(() => require('node-pty'));
const xterm = lazy(() => require('@xterm/headless').Terminal);

/** Is passthrough usable on this install? False when node-pty (native) did not build/download. */
export function nativeAvailable(): boolean {
  return !!pty() && !!xterm();
}

/** What to do when node-pty did not build. It ships no Linux prebuild, so Linux compiles it during the
 *  install; macOS and Windows load its prebuilt binaries. `oak attach` needs no PTY at all.
 *  `packageDir` is the installed node-pty, when there is one. `bundle` is the copy `oak machine add`
 *  pushes: no npm install and no node_modules, so reinstalling through npm would only add a second OAK. */
export function ptyBuildFix(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, packageDir?: string, bundle = false): string {
  const how = 're-run its installer, or `oak update --cli-only --force`';
  const attach = '`oak attach` opens herdr without it';
  if (bundle && !packageDir) return `\`oak machine add\` installs OAK without node-pty, so OAK's herdr tab has no terminal on this machine. ${attach}.`;
  if (platform !== 'linux') return `Reinstall OAK (${how}). Meanwhile ${attach}.`;
  const cxx = env.CXX?.trim().split(/\s+/)[0] || 'g++';
  const onPath = (bin: string) => bin.includes('/') ? fs.existsSync(bin)
    : String(env.PATH ?? '').split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, bin)));
  const missing = ['python3', 'make', cxx].filter((bin) => !onPath(bin));
  const tools = `python3, make and a C++ compiler (${cxx})`;
  // Installed but never built: node-gyp leaves a build/ directory even when it fails, so none at all
  // means npm skipped the install script. npm 12 does that to every script it was not told to allow,
  // with only a warning, and blaming the compiler then sent people to install what they had.
  if (packageDir && fs.existsSync(path.join(packageDir, 'package.json')) && !fs.existsSync(path.join(packageDir, 'build'))) {
    // Reinstalling does not run it again: npm keeps the unbuilt package. `npm rebuild` does, with
    // --ignore-scripts=false over an npmrc that set it: inside the checkout that holds node-pty (whose
    // package.json allows the script; npm 12 refuses --allow-scripts in a project), or across npm's
    // global packages for an installed OAK (where npm 12 needs it). Executed on npm 10.8–12.1, 2026-09-27.
    const owner = path.resolve(packageDir, '..', '..');
    let checkout = false;
    try { checkout = !!JSON.parse(fs.readFileSync(path.join(owner, 'package.json'), 'utf8')).workspaces; } catch { /* an installed package */ }
    const rebuild = checkout ? `\`npm rebuild node-pty --ignore-scripts=false\` in ${owner}` : '`npm rebuild -g node-pty --allow-scripts=node-pty --ignore-scripts=false`';
    return `npm installed node-pty without running its build script (npm 12 runs only the install scripts it is told to allow, and no npm runs them while ignore-scripts is set)` +
      `${missing.length ? `, and the build needs ${tools}; missing here: ${missing.join(', ')}. Install them, then build it` : '. Build it'} with ${rebuild}. Meanwhile ${attach}.`;
  }
  if (!missing.length) return `On Linux node-pty compiles from source with ${tools}, all of which are here: reinstall OAK (${how}), which runs its build again. Meanwhile ${attach}.`;
  return `On Linux node-pty compiles from source: it needs ${tools}; missing here: ${missing.join(', ')}. Install them, then reinstall OAK (${how}). Meanwhile ${attach}.`;
}

/** Loading node-pty does not prove its spawn helper can execute. Never opens a user shell. */
export async function diagnoseNativeSpawn(fix = false, opts: { timeoutMs?: number; packageDir?: string; bundle?: boolean } = {}): Promise<Check> {
  const row = { id: 'native-spawn', label: 'Native terminal PTY spawn' };
  let module: any;
  let packageDir = opts.packageDir;
  try {
    packageDir ??= path.dirname(require.resolve('node-pty/package.json'));
    module = require(packageDir);
  } catch (error) {
    // A warning, not a failure: only the herdr tab needs node-pty, and `oak machine add` installs never have it.
    // The cause's first line only: Node appends the whole `Require stack:` to a missing module.
    const cause = String((error as Error)?.message ?? error).split('\n')[0];
    return { ...row, level: 'warn', detail: `node-pty is not ${packageDir ? 'built' : 'installed'}, so OAK's herdr tab has no terminal here: ${cause}`,
      fix: ptyBuildFix(process.platform, process.env, packageDir, opts.bundle) };
  }
  const probe = (): Promise<void> => new Promise((resolve, reject) => {
    let child: any;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { try { child?.kill(); } catch { /* already exited */ } reject(error); }
      else resolve();
    };
    try {
      const windows = process.platform === 'win32';
      child = module.spawn(windows ? (process.env.ComSpec || 'cmd.exe') : '/bin/echo',
        windows ? ['/d', '/c', 'echo', 'oak-pty-check'] : ['oak-pty-check'],
        { name: 'xterm', cols: 40, rows: 2, cwd: process.cwd(), env: process.env });
      timer = setTimeout(() => finish(new Error('PTY spawn check timed out')), opts.timeoutMs ?? 3000);
      child.onData(() => {});
      child.onExit((event: { exitCode: number }) => finish(event.exitCode === 0 ? undefined : new Error(`PTY child exited ${event.exitCode}`)));
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
  try { await probe(); return { ...row, level: 'ok', detail: 'node-pty spawned and completed the echo check' }; }
  catch (error) {
    const failure = String(error);
    // `--fix` repairs only POSIX helper permissions, so on Windows it would return this same row.
    if (process.platform === 'win32') return { ...row, level: 'fail', detail: failure, fix: ptyBuildFix('win32') };
    const repaired: string[] = [];
    try {
      for (const dir of ['build/Release', 'build/Debug', `prebuilds/${process.platform}-${process.arch}`]) {
        const helper = path.join(packageDir, dir, 'spawn-helper');
        if (!fs.existsSync(helper)) continue;
        const stat = fs.statSync(helper);
        if (stat.isFile() && (stat.mode & 0o111) !== 0o111) {
          if (!fix) return { ...row, level: 'fail', detail: 'spawn-helper is not executable — run oak doctor --fix', fix: 'oak doctor --fix' };
          fs.chmodSync(helper, (stat.mode & 0o777) | 0o111);
          repaired.push(helper);
        }
      }
      if (!fix) return { ...row, level: 'fail', detail: failure, fix: 'oak doctor --fix' };
      if (!repaired.length) return { ...row, level: 'fail', detail: `${failure}; no helper permissions needed repair`, fix: 'Reinstall node-pty and check terminal permissions.' };
      await probe();
      return { ...row, level: 'ok', detail: `repaired spawn-helper executable permissions (${repaired.join(', ')}); PTY echo check passed` };
    } catch (retryError) {
      return { ...row, level: 'fail', detail: `${failure}; ${repaired.length ? 'helper permissions repaired, but retry failed' : 'helper repair failed'}: ${String(retryError)}`, fix: 'Reinstall node-pty and check terminal permissions.' };
    }
  }
}

export interface NativeSession {
  readonly label: string;
  readonly ended: boolean;
  /** The program's pid (null when unknown — a remote tab before its first listing). */
  readonly pid: number | null;
  /** Forward raw reader bytes to the child. A per-session decoder buffers partial multibyte across
   *  chunks, so a paste split mid-character is not corrupted into U+FFFD. */
  write(data: Buffer): void;
  /** Resize the PTY and the emulator together when the tab body changes size. */
  resize(cols: number, rows: number): void;
  /** The current screen as ANSI-styled lines, exactly `rows` tall — the tab body paints these. */
  grid(cols: number, rows: number, depth: ColorDepth): string[];
  /** Where the program's cursor is (viewport-relative) and whether the program is showing it. The
   *  tab paints the REAL terminal cursor there: a program that relies on the terminal cursor for its
   *  caret (Claude Code's prompt) had no cursor at all inside OAK (2026-09-23). */
  cursor?(): { x: number; y: number; visible: boolean };
  onUpdate(fn: () => void): void;
  onExit(fn: (code: number) => void): void;
  /** Mirror input modes only while this tab owns the host. The exit path supplies a sync writer. */
  setHostActive?(active: boolean, ownedModes?: readonly number[], write?: (data: string) => void): void;
  close(): void;
}

// Replies can arrive after a tab switch. Keep the requesting child, rather than routing to whichever
// tab happens to be active when stdin delivers the answer. Closed children consume their stale reply.
const hostKeyboardQueries: ((reply: string) => void)[] = [];
export function routeNativeHostReply(data: Buffer): boolean {
  const raw = data.toString('ascii');
  if (!/^\x1b\[\?\d+u$/.test(raw)) return false;
  hostKeyboardQueries.shift()?.(raw);
  return true;
}

/** xterm's parser handles split CSI and ignores CSI-looking text inside OSC/DCS for us. Keyboard
 * modes belong to the physical terminal, while the emulator still owns screen/cursor modes. */
function mirrorHostModes(term: any, reply: (data: string) => void) {
  const flags = [0]; // the child's baseline plus each pushed level
  let active = false, closed = false, hostDepth = 0, rootPushed = false, queries = 0;
  let owned = new Set([2004, 1004, 1003, 1006]);
  const requested = new Set<number>();
  const applied = new Set<number>();
  const write = (data: string) => { if (active && !closed) process.stdout.write(data); };
  const query = () => {
    hostKeyboardQueries.push(data => { if (!closed) reply(data); });
    write('\x1b[?u');
  };
  const modes = () => {
    const next = new Set([...requested].filter(n => !owned.has(n)));
    // Mouse tracking modes are mutually exclusive. OAK's any-motion tracking also supplies the
    // child's click/drag events; forwarding 1000/1002 would silently disable OAK's hover tracking.
    if (owned.has(1003)) { next.delete(1000); next.delete(1002); }
    else if (next.has(1003)) { next.delete(1000); next.delete(1002); }
    else if (next.has(1002)) next.delete(1000);
    for (const n of applied) if (!next.has(n)) write(`\x1b[?${n}l`);
    for (const n of next) if (!applied.has(n)) write(`\x1b[?${n}h`);
    applied.clear(); for (const n of next) applied.add(n);
  };
  for (const prefix of ['>', '<', '=', '?']) term.parser.registerCsiHandler({ prefix, final: 'u' }, (params: number[]) => {
    if (closed) return true;
    if (prefix === '?') {
      if (active) query(); else queries++;
    } else if (prefix === '>') {
      const value = params[0] || 0;
      flags.push(value);
      if (active) { write(`\x1b[>${value}u`); hostDepth++; }
    } else if (prefix === '<') {
      const count = params[0] || 1;
      const pop = Math.min(count, flags.length - 1);
      flags.splice(flags.length - pop, pop);
      if (active && pop) { write(`\x1b[<${pop}u`); hostDepth -= pop; }
      // An unmatched pop resets the child's baseline, never pops OAK's caller's stack.
      if (count > pop) {
        flags[0] = 0;
        if (active && rootPushed) write('\x1b[=0u');
      }
    } else {
      const value = params[0] || 0, mode = params[1] || 1;
      if (mode < 1 || mode > 3) return true;
      const i = flags.length - 1;
      flags[i] = mode === 2 ? flags[i] | value : mode === 3 ? flags[i] & ~value : value;
      if (active) {
        // A bare SET must not overwrite the terminal state beneath this session.
        if (!hostDepth) { write('\x1b[>0u'); hostDepth++; rootPushed = true; }
        write(`\x1b[=${value};${mode}u`);
      }
    }
    return true;
  });
  for (const final of ['h', 'l']) term.parser.registerCsiHandler({ prefix: '?', final }, (params: number[]) => {
    if (!closed) {
      for (const n of params) if ([2004, 1004, 1000, 1002, 1003, 1006].includes(n)) {
        if (final === 'h') requested.add(n); else requested.delete(n);
      }
      if (active) modes();
    }
    return false; // the emulator also needs its own mouse/focus/paste state
  });
  const setActive = (next: boolean, baseline?: readonly number[], output = (data: string) => { process.stdout.write(data); }) => {
    if (closed || next === active) return;
    if (!next) {
      if (hostDepth) output(`\x1b[<${hostDepth}u`);
      for (const n of applied) output(`\x1b[?${n}l`);
      applied.clear(); hostDepth = 0; rootPushed = false; active = false;
      return;
    }
    active = true;
    if (baseline) owned = new Set(baseline);
    if (flags[0]) { write(`\x1b[>${flags[0]}u`); hostDepth++; rootPushed = true; }
    for (const value of flags.slice(1)) { write(`\x1b[>${value}u`); hostDepth++; }
    modes();
    while (queries > 0) { queries--; query(); }
  };
  return { setActive, close() { setActive(false); closed = true; } };
}

/** A cwd a PTY child can actually start in: `preferred` when it is a directory on THIS machine, else
 *  `fallback`. A session's workspace root comes from its transcript, and a session synced over from
 *  another machine names a path that does not exist here (a Linux `/home/…` root on a Mac); node-pty's
 *  child chdir()s there BEFORE exec and dies with code 1, no output — which the tab reported as
 *  "herdr exited" (2026-09-18). */
export function spawnCwd(preferred: string | null | undefined, fallback: string = process.cwd()): string {
  try {
    if (preferred && fs.statSync(preferred).isDirectory()) return preferred;
  } catch { /* missing, or not reachable — fall through */ }
  return fallback;
}

/**
 * Spawn `command args` under a PTY sized to the tab body. Returns null when passthrough is unavailable
 * (node-pty absent), so the caller degrades rather than throws.
 */
export function spawnNative(command: string, args: string[], cols: number, rows: number, cwd: string, label: string, env: Record<string, string | undefined> = {}): NativeSession | null {
  const P = pty();
  const X = xterm();
  if (!P || !X) return null;
  const c = Math.max(2, cols);
  const r = Math.max(1, rows);
  const term = new X({ cols: c, rows: r, allowProposedApi: true, scrollback: 2000 });
  let proc: any;
  try {
    // `env` rides on top of ours — the app passes OAK_TAB so the agent's hooks can say which tab a
    // session runs in (the tab↔session link the auto-title reads). An overlay value of `undefined`
    // REMOVES the variable: the herdr tab must not hand a Claude Code session's identity to the
    // client it spawns (which auto-starts the server), and spread alone cannot delete a key.
    const merged: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...process.env, ...env })) if (value !== undefined) merged[key] = value;
    proc = P.spawn(command, args, { name: 'xterm-256color', cols: c, rows: r, cwd, env: merged });
  } catch {
    return null; // the command itself could not launch — treat as unavailable, the caller reports it
  }
  let ended = false;
  const hostModes = mirrorHostModes(term, data => { if (!ended) { try { proc.write(data); } catch { /* exited */ } } });
  let updateFn: (() => void) | null = null;
  let exitFn: ((code: number) => void) | null = null;
  const dec = new StringDecoder('utf8'); // buffers a partial multibyte char across raw stdin chunks
  let dirty = true;
  let cache: string[] | null = null;
  let cacheKey = '';
  let lastCols = c;
  let lastRows = r;
  proc.onData((d: string) => {
    // xterm's write() is ASYNCHRONOUS: it queues the bytes and parses them a tick (or more) later.
    // Marking dirty and announcing the update synchronously let the next paint serialize — and CACHE
    // — the screen from BEFORE the data was applied, with `dirty` already cleared. A program that
    // prints once and then goes quiet (`echo X; exec sleep 300`) sends no further byte, so nothing
    // ever announced again and both the attached client and this session's grid cache stayed stale.
    // The write callback runs once the emulator has applied the chunk, which is when it is true.
    term.write(d, () => {
      dirty = true; // the emulator screen changed — the next grid() must reserialize
      updateFn?.();
    });
  });
  proc.onExit((e: { exitCode: number }) => {
    hostModes.close();
    ended = true;
    exitFn?.(e.exitCode ?? 0);
  });
  return {
    label,
    get ended() {
      return ended;
    },
    get pid(): number | null {
      return typeof proc.pid === 'number' ? proc.pid : null;
    },
    write(data: Buffer) {
      if (!ended) {
        try {
          proc.write(dec.write(data));
        } catch {
          /* the child went away between the focus check and the write */
        }
      }
    },
    resize(nc: number, nr: number) {
      const cc = Math.max(2, nc);
      const rr = Math.max(1, nr);
      if (cc === lastCols && rr === lastRows) return; // node-pty's resize is an unguarded ioctl — skip
      lastCols = cc;
      lastRows = rr;
      dirty = true;
      try {
        if (!ended) proc.resize(cc, rr);
      } catch {
        /* a PTY that refuses a resize keeps its old size — harmless */
      }
      try {
        term.resize(cc, rr);
      } catch {
        /* same */
      }
    },
    grid(gc: number, gr: number, depth: ColorDepth) {
      // Reserialize only when the screen actually changed (onData/resize set `dirty`) — most paints
      // fire for unrelated reasons (hover, tick, toast) and would otherwise re-loop every cell for nothing.
      const key = `${gc}x${gr}x${depth}`;
      if (!dirty && cache && cacheKey === key) return cache;
      cache = serializeGrid(term, gc, gr, depth);
      cacheKey = key;
      dirty = false;
      return cache;
    },
    cursor() {
      const b = term.buffer.active;
      let visible = true;
      try {
        // xterm keeps DECTCEM on its core service; headless exposes the core but not a public getter.
        // Unknown reads as visible: a program that never touched the cursor expects to have one.
        const core = (term as any)._core;
        if (core?.coreService && typeof core.coreService.isCursorHidden === 'boolean') visible = !core.coreService.isCursorHidden;
      } catch { /* an xterm without that core shape — visible */ }
      return { x: b.cursorX, y: b.cursorY, visible };
    },
    onUpdate(fn: () => void) {
      updateFn = fn;
    },
    onExit(fn: (code: number) => void) {
      exitFn = fn;
    },
    setHostActive: hostModes.setActive,
    close() {
      hostModes.close();
      if (!ended) {
        try {
          proc.kill();
        } catch {
          /* already gone */
        }
      }
      ended = true;
    },
  };
}

/** One cell's SGR prefix — fg, bg and every text attribute — mapped from xterm's cell attributes to
 *  the ANSI the outer terminal already speaks. Default colours emit nothing (the frame's own ground
 *  shows through). Underline, inverse, italic and strikethrough ride along too: a program's status
 *  bar drawn with underlines, or a caret drawn as a reversed cell, came through this renderer as plain
 *  text (the underlines in the statusline bars were gone inside OAK's herdr tab). */
function cellSgr(cell: any, depth: ColorDepth): string {
  if (!cell || depth === 'none') return '';
  const p: string[] = [];
  if (cell.isBold && cell.isBold()) p.push('1');
  if (cell.isDim && cell.isDim()) p.push('2');
  if (cell.isItalic && cell.isItalic()) p.push('3');
  if (cell.isUnderline && cell.isUnderline()) p.push('4');
  if (cell.isInverse && cell.isInverse()) p.push('7');
  if (cell.isInvisible && cell.isInvisible()) p.push('8');
  if (cell.isStrikethrough && cell.isStrikethrough()) p.push('9');
  if (cell.isFgRGB && cell.isFgRGB()) {
    const c = cell.getFgColor();
    p.push(`38;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`);
  } else if (cell.isFgPalette && cell.isFgPalette()) {
    p.push(`38;5;${cell.getFgColor()}`);
  }
  if (cell.isBgRGB && cell.isBgRGB()) {
    const c = cell.getBgColor();
    p.push(`48;2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`);
  } else if (cell.isBgPalette && cell.isBgPalette()) {
    p.push(`48;5;${cell.getBgColor()}`);
  }
  return p.length ? `\x1b[${p.join(';')}m` : '';
}

/**
 * The emulator's VIEWPORT (the screen the program is drawing, following the cursor) as `rows` styled
 * lines. SGR is emitted only when the run of attributes CHANGES, and reset at each line end, so a
 * program's colours survive without bleeding into the frame around it.
 */
export function serializeGrid(term: any, cols: number, rows: number, depth: ColorDepth): string[] {
  const buf = term.buffer.active;
  const top = buf.baseY; // the first row of the live viewport (scrollback sits above it)
  // ONE reusable cell: `getLine().getCell(x, cell)` loads into it (loadCell) instead of allocating a
  // fresh CellData per cell — at 200×50 that is 10,000 allocations/serialize turned into one.
  const cell = buf.getNullCell();
  const out: string[] = [];
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(top + y);
    if (!line) {
      out.push('');
      continue;
    }
    let s = '';
    let cur = '';
    for (let x = 0; x < cols; x++) {
      line.getCell(x, cell); // loads position x into `cell` (a null cell when out of range)
      const seg = cellSgr(cell, depth);
      if (seg !== cur) {
        if (depth !== 'none') s += '\x1b[0m';
        s += seg;
        cur = seg;
      }
      s += cell.getChars() || ' ';
    }
    if (depth !== 'none' && cur) s += '\x1b[0m';
    out.push(s);
  }
  return out;
}
