/**
 * The key of oak sync's encrypted backup folder, and the sealing it does with it (sync-folder.ts).
 *
 * The key is 32 random bytes, made once (`oak sync setup`, or `oak sync backup --folder` on a new folder), kept in this
 * machine's OAK store at `sync/key` with mode 0600, and copied to the user's other machines over ssh (`oak sync key
 * --from <machine>`) or by hand (`oak sync key --show`, then `--import`). It is never written to the backup folder:
 * without it, the folder is ciphertext and names that reveal nothing.
 *
 * Two keys are derived from it with HKDF-SHA256: one seals each object and manifest with AES-256-GCM, under a random
 * 96-bit nonce of its own and with what it is (its name, or its machine and file) as associated data, so an object
 * moved to another name, or a manifest to another machine, fails to open; the other names each object by an HMAC-SHA256
 * of its content's hash, so equal content has one name (on any machine) and the name says nothing of the content.
 * Anything that fails to open, or opens to content other than its hash says, is an error that is reported and never
 * used: it was altered, or sealed under another key.
 */
import * as fs from 'fs';
import * as path from 'path';
import { createCipheriv, createDecipheriv, createHmac, createSecretKey, hkdfSync, randomBytes, timingSafeEqual, type KeyObject } from 'crypto';
import { syncDir, writeAtomic } from './sync-state';
import { keepFromOldClean } from './store';

export const SYNC_KEY_BYTES = 32;
/** How a key is written down: in its file, by `oak sync key --show`, and as `--import` takes it. */
const KEY_PREFIX = 'oak-sync-1:';
/** A sealed unit: a version byte, the nonce, the ciphertext, and the GCM tag. */
const SEAL_VERSION = 1;
const NONCE = 12;
const TAG = 16;
export const SEAL_OVERHEAD = 1 + NONCE + TAG;

/** A key that is not one, or a key file that cannot be read as one. */
export class SyncKeyError extends Error {}
/** Something sealed that does not open: altered, or sealed under another key. */
export class SyncSealError extends Error {}

export const syncKeyPath = (): string => path.join(syncDir(), 'key');

export function formatSyncKey(key: Buffer): string {
  return KEY_PREFIX + key.toString('base64url');
}

/** A key as `--show` prints it, or its 32 bytes in base64 or base64url; throws for anything else. */
export function parseSyncKey(text: string): Buffer {
  const t = String(text ?? '').trim();
  // Padding is dropped. The look-behind lets the match start only at the first `=` of the run, which keeps it linear.
  const body = (t.startsWith(KEY_PREFIX) ? t.slice(KEY_PREFIX.length) : t).replace(/(?<!=)=+$/, '');
  if (!/^[A-Za-z0-9_+/-]{43}$/.test(body)) throw new SyncKeyError('that is not an oak sync key: it is 32 bytes, as `oak sync key --show` prints them (oak-sync-1:…)');
  const key = Buffer.from(body.replace(/\+/g, '-').replace(/\//g, '_'), 'base64url');
  if (key.length !== SYNC_KEY_BYTES || key.toString('base64url') !== body.replace(/\+/g, '-').replace(/\//g, '_')) throw new SyncKeyError('that is not an oak sync key: it does not decode to 32 bytes');
  return key;
}

/** This machine's key, or null when it has none. A key file that is not one is an error, never taken for no key. */
export function readSyncKey(): Buffer | null {
  let text: string;
  try {
    text = fs.readFileSync(syncKeyPath(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new SyncKeyError(`the backup key at ${syncKeyPath()} cannot be read: ${String((e as Error).message)}`);
  }
  try {
    return parseSyncKey(text);
  } catch {
    throw new SyncKeyError(`${syncKeyPath()} does not hold an oak sync key: copy the key over it from a machine that has it (\`oak sync key --from <machine> --replace\`), or \`oak sync key --import --replace\``);
  }
}

export const newSyncKey = (): Buffer => randomBytes(SYNC_KEY_BYTES);

export function sameKey(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Keep `key` as this machine's, mode 0600. A different key already here is replaced only when asked (`replace`), and is
 * kept beside it then (`key.replaced-<time>`), since a backup sealed under it is readable with nothing else. So is a key
 * file that holds no key (cut short, edited by hand): it is no key, but may be what is left of one.
 */
export function writeSyncKey(key: Buffer, opts: { replace?: boolean } = {}): { replaced: string | null } {
  if (key.length !== SYNC_KEY_BYTES) throw new SyncKeyError('a key is 32 bytes');
  let was: Buffer | null = null;
  let unreadable = false;
  try {
    was = readSyncKey();
  } catch (e) {
    if (!(e instanceof SyncKeyError)) throw e;
    unreadable = true;
  }
  if (was && sameKey(was, key)) {
    fs.chmodSync(syncKeyPath(), 0o600);
    return { replaced: null };
  }
  let replaced: string | null = null;
  if (was || unreadable) {
    if (!opts.replace) {
      throw new SyncKeyError(was
        ? `a different backup key is already kept here (${keyFingerprint(was)}); a backup sealed under it opens with nothing else. Pass --replace to keep the new one, and the old one is kept beside it`
        : `${syncKeyPath()} holds no key OAK can read. Pass --replace to keep the new one, and that file is kept beside it`);
    }
    replaced = `${syncKeyPath()}.replaced-${Date.now()}`;
    fs.copyFileSync(syncKeyPath(), replaced);
    fs.chmodSync(replaced, 0o600);
  }
  writeAtomic(syncKeyPath(), formatSyncKey(key) + '\n', 0o600);
  fs.chmodSync(syncKeyPath(), 0o600);
  keepFromOldClean(syncDir());
  return { replaced };
}

/** A short name for a key, which tells two machines' keys apart and gives away nothing of it. */
export function keyFingerprint(key: Buffer): string {
  return createHmac('sha256', key).update('oak-sync key fingerprint').digest('hex').slice(0, 16).replace(/(.{4})(?!$)/g, '$1-');
}

/** The two keys the folder uses, derived from this machine's key. Held as KeyObjects: Node converts a raw key given to a
 *  cipher or an HMAC on every call, which took a quarter of a first push (100,000 objects named and sealed). */
export interface FolderKeys {
  enc: KeyObject;
  name: KeyObject;
}

export function folderKeys(key: Buffer): FolderKeys {
  const derive = (info: string): KeyObject => createSecretKey(Buffer.from(hkdfSync('sha256', key, Buffer.from('oak-sync-folder-v1'), Buffer.from(info), 32)));
  return { enc: derive('aes-256-gcm'), name: derive('hmac-sha256 names') };
}

/** A keyed name: lower-case hex, 64 characters. */
export function keyedName(keys: FolderKeys, what: string): string {
  return createHmac('sha256', keys.name).update(what).digest('hex');
}

/** The name of an object whose content hashes to `sha256`. */
export const objectName = (keys: FolderKeys, sha256: string): string => keyedName(keys, `object\0${sha256}`);

export function seal(keys: FolderKeys, plain: Buffer, aad: string): Buffer {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', keys.enc, nonce);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([SEAL_VERSION]), nonce, body, cipher.getAuthTag()]);
}

/** Open what `seal` made with the same `aad`; throws SyncSealError for anything altered or sealed under another key. */
export function unseal(keys: FolderKeys, sealed: Buffer, aad: string, what: string): Buffer {
  if (sealed.length < SEAL_OVERHEAD || sealed[0] !== SEAL_VERSION) throw new SyncSealError(`${what} is not something oak sync sealed: it was altered`);
  try {
    const decipher = createDecipheriv('aes-256-gcm', keys.enc, sealed.subarray(1, 1 + NONCE));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
    const plain = decipher.update(sealed.subarray(1 + NONCE, sealed.length - TAG));
    decipher.final(); // GCM: nothing more, and the tag checked
    return plain;
  } catch {
    throw new SyncSealError(`${what} does not open with this machine's key: it was altered, or sealed under another key`);
  }
}
