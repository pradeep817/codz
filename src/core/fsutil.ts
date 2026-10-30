import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.codz',
  '.next',
  '.dart_tool',
  'build',
  'dist',
  'out',
  '.idea',
  '.vscode',
  'coverage',
  'Pods',
  '.gradle',
  '.turbo',
  '.vercel',
]);

/** Files the operating system or editors drop into folders; never part of a project. */
export const IGNORED_FILES = new Set(['.DS_Store', 'Thumbs.db', 'ehthumbs.db', 'desktop.ini', 'Icon\r', '.directory']);

const isJunkFile = (name: string) => IGNORED_FILES.has(name) || name.startsWith('._') || name.endsWith('~') || /\.sw[po]$/.test(name);

export function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export function toPosix(p: string): string {
  return p.split(sep).join('/');
}

export function rel(root: string, abs: string): string {
  return toPosix(relative(root, abs));
}

export function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function readJson<T = unknown>(path: string): T | null {
  const text = readText(path);
  if (text == null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function exists(path: string): boolean {
  return existsSync(path);
}

/**
 * Walks a directory and returns relative posix paths of files, sorted so scans
 * are deterministic. `extraIgnored` lets adapters skip more folders.
 */
export function walk(root: string, start = '.', opts: { exts?: string[]; extraIgnored?: string[]; maxFiles?: number } = {}): string[] {
  const out: string[] = [];
  const ignored = new Set([...IGNORED_DIRS, ...(opts.extraIgnored ?? [])]);
  const max = opts.maxFiles ?? 20000;
  const base = join(root, start);
  if (!isDir(base)) return out;
  const stack: string[] = [base];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      continue;
    }
    // Push directories in reverse so traversal order is alphabetical.
    const dirs: string[] = [];
    for (const name of entries) {
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!ignored.has(name) && !name.startsWith('.')) dirs.push(abs);
      } else if (isJunkFile(name)) {
        continue;
      } else if (!opts.exts || opts.exts.some((e) => name.endsWith(e))) {
        out.push(rel(root, abs));
        if (out.length >= max) return out.sort();
      }
    }
    for (let i = dirs.length - 1; i >= 0; i--) stack.push(dirs[i]);
  }
  return out.sort();
}

export function detectEol(text: string): '\n' | '\r\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/** Normalizes generated text (always \n) to the file's own line endings. */
export function withEol(text: string, eol: '\n' | '\r\n'): string {
  const normalized = text.replace(/\r\n/g, '\n');
  return eol === '\n' ? normalized : normalized.replace(/\n/g, '\r\n');
}
