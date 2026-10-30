import { spawnSync } from 'node:child_process';

export function isGitRepo(root: string): boolean {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === 'true';
}

/**
 * Files with uncommitted changes under `root`, relative to `root` (not to the
 * repository), excluding codz's own folder. Works when the project is a
 * subfolder of a larger repository, and with renames and unusual file names.
 */
export function dirtyFiles(root: string): string[] {
  const prefix = spawnSync('git', ['rev-parse', '--show-prefix'], { cwd: root, encoding: 'utf8' });
  if (prefix.status !== 0) return [];
  const sub = prefix.stdout.trim(); // "" at the repo root, "apps/web/" in a subfolder
  const r = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=normal', '--', '.'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return [];
  const out: string[] = [];
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    // A rename or copy is followed by its original path; skip that.
    if (status[0] === 'R' || status[0] === 'C') i++;
    const rel = sub && path.startsWith(sub) ? path.slice(sub.length) : path;
    if (rel === '.codz' || rel.startsWith('.codz/')) continue;
    out.push(rel);
  }
  return out;
}
