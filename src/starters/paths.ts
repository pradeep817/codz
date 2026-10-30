// Path rules for every file a starter writes. A path is checked when it is
// read from an archive or folder, and again after placeholders are filled in,
// because an answer can change a path.

import { ToolError } from '../core/types.ts';

export const LIMITS = {
  compressedBytes: 50 * 1024 * 1024,
  expandedBytes: 200 * 1024 * 1024,
  entries: 5000,
  pathLength: 240,
  depth: 32,
  fileBytes: 50 * 1024 * 1024,
};

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Throws archive_unsafe unless `p` is a safe relative path with forward slashes. */
export function checkRelPath(p: string, where: string): string {
  const unsafe = (why: string): never => {
    throw new ToolError('archive_unsafe', `The ${where} has an unsafe entry "${clip(p)}": ${why}. Nothing was written.`, 'Do not use this template; report it.');
  };
  if (!p) unsafe('an empty name');
  if (p.length > LIMITS.pathLength) unsafe(`a path longer than ${LIMITS.pathLength} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\:*?"<>|]/.test(p)) unsafe('a character that is not allowed in file names');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) unsafe('an absolute path');
  const segs = p.split('/');
  if (segs.length > LIMITS.depth) unsafe(`more than ${LIMITS.depth} nested folders`);
  for (const s of segs) {
    if (s === '' || s === '.') unsafe('an empty or "." path segment');
    if (s === '..') unsafe('a ".." segment');
    if (RESERVED.test(s)) unsafe(`a name reserved on Windows (${s})`);
    if (/[. ]$/.test(s)) unsafe('a name ending in a dot or a space');
    if (s === '.git') unsafe('a .git folder');
    if (s === '.codz') unsafe("codz's own folder");
  }
  return p;
}

/** Case- and Unicode-folded form: two paths with the same key collide on macOS and Windows. */
export function collisionKey(p: string): string {
  return p.normalize('NFC').toLowerCase();
}

/** Throws archive_unsafe when two file paths would land on the same file on some system, or a file is also used as a folder. */
export function checkCollisions(paths: string[], where: string): void {
  const files = new Map<string, string>();
  for (const p of paths) {
    const k = collisionKey(p);
    const prev = files.get(k);
    if (prev !== undefined) throw new ToolError('archive_unsafe', `The ${where} has two entries that are the same file on macOS and Windows: "${clip(prev)}" and "${clip(p)}". Nothing was written.`, 'Do not use this template; report it.');
    files.set(k, p);
  }
  for (const p of paths) {
    const segs = p.split('/');
    for (let n = 1; n < segs.length; n++) {
      const dir = segs.slice(0, n).join('/');
      if (files.has(collisionKey(dir))) throw new ToolError('archive_unsafe', `The ${where} uses "${clip(dir)}" as both a file and a folder. Nothing was written.`, 'Do not use this template; report it.');
    }
  }
}

const clip = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}...` : s).replace(/[\u0000-\u001f]/g, '?');
