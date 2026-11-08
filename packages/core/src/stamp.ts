/**
 * How old a stamp is, when the clock that wrote it may have been stepped back since: a claim's or lock's file time, a
 * refresh's attempt time. A stamp dated more than a few seconds after now was taken before the step, so its age says
 * nothing; read as recent, it held its claim, lock or throttle until the clock caught up, which can be hours. The few
 * seconds allow for a just-written mtime's fraction of a millisecond. A file's time is the clock of the file system it is
 * on, which is not always this machine's: fileDatedAhead reads it against that clock. No OAK imports: the installer's
 * modules use it too.
 */
import * as fs from 'fs';

const AHEAD_SLACK_MS = 5_000;

/** `stampMs` lies more than a few seconds after `now`: taken before the clock was stepped back. */
export function datedAhead(stampMs: number, now = Date.now()): boolean {
  return stampMs - now >= AHEAD_SLACK_MS;
}

/** `stampMs` was taken within the last `windowMs`; one dated ahead (datedAhead) was not, whatever its window. */
export function withinLast(stampMs: number, windowMs: number, now = Date.now()): boolean {
  return now - stampMs < windowMs && !datedAhead(stampMs, now);
}

/** `mtimeMs`, the time `file` was written by the clock of the file system it is on, lies more than a few seconds
 *  after now by that clock: written before that clock was stepped back. It is not always this machine's clock: a
 *  network share's, or a host's under a virtual machine's shared folder, can run ahead of this one by any amount, and
 *  every file just written there then reads as dated ahead of this clock, a live holder's lock and a fresh claim
 *  included. So a time dated ahead of this clock is read against a file written beside it now, which the same clock
 *  dates; where none can be written, it is not dated ahead, as before. */
export function fileDatedAhead(file: string, mtimeMs: number, now = Date.now()): boolean {
  if (!datedAhead(mtimeMs, now)) return false;
  const probe = `${file}.${process.pid}.clock.tmp`;
  try {
    fs.writeFileSync(probe, '', { mode: 0o600 });
    return datedAhead(mtimeMs, fs.statSync(probe).mtimeMs);
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(probe); } catch { /* none was written */ }
  }
}

/** withinLast for a file's time, which fileDatedAhead reads by its file system's clock. */
export function fileWithinLast(file: string, mtimeMs: number, windowMs: number, now = Date.now()): boolean {
  return now - mtimeMs < windowMs && !fileDatedAhead(file, mtimeMs, now);
}
