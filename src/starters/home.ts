// codz's per-user folder (~/.codz, or CODZ_HOME): the login token,
// the last signed catalog index and the cache of verified starter archives.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function codzHome(): string {
  return process.env.CODZ_HOME || join(homedir(), '.codz');
}

export function homePath(...parts: string[]): string {
  return join(codzHome(), ...parts);
}

export function readHomeFile(...parts: string[]): Buffer | null {
  try {
    return readFileSync(homePath(...parts));
  } catch {
    return null;
  }
}

/** Writes atomically (temporary name, then rename). `secret` files are readable by the owner only. */
export function writeHomeFile(data: Buffer | string, opts: { secret?: boolean }, ...parts: string[]): void {
  const path = homePath(...parts);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode: opts.secret ? 0o600 : 0o644 });
  if (opts.secret) {
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Windows has no POSIX modes; the file is in the user's profile folder.
    }
  }
  renameSync(tmp, path);
}

export function removeHome(...parts: string[]): boolean {
  const path = homePath(...parts);
  if (!existsSync(path)) return false;
  rmSync(path, { recursive: true, force: true });
  return true;
}
