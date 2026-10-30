// Workflow helpers around a change: commit it, open its diff in an editor, read
// input from the clipboard, and summarize a change set in one line.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_DIR } from './cache.ts';
import { diffStats, unifiedDiff } from './diff.ts';
import { isGitRepo } from './git.ts';
import { ToolError, type ChangeSet } from './types.ts';

/** "3 files: 1 created, 2 changed, 0 deleted (+40 −3 lines)". */
export function changeSummaryLine(cs: ChangeSet): string {
  let created = 0;
  let changed = 0;
  let deleted = 0;
  let added = 0;
  let removed = 0;
  for (const c of cs.changes) {
    if (c.before === null) created++;
    else if (c.after === null) deleted++;
    else changed++;
    const s = diffStats(c.before, c.after);
    added += s.added;
    removed += s.removed;
  }
  const n = cs.changes.length;
  const parts = [created && `${created} created`, changed && `${changed} changed`, deleted && `${deleted} deleted`].filter(Boolean).join(', ');
  return `${n} file${n === 1 ? '' : 's'}: ${parts} (+${added} −${removed} lines)`;
}

/** Commits exactly the files of a change. Returns the commit hash. */
export function commitChange(root: string, cs: ChangeSet, message?: string): string {
  if (!isGitRepo(root)) throw new ToolError('not_a_repo', '--commit needs a git repository.', 'Run git init first, or leave out --commit.');
  const paths = cs.changes.map((c) => c.path);
  const add = spawnSync('git', ['add', '-A', '--', ...paths], { cwd: root, encoding: 'utf8' });
  if (add.status !== 0) throw new ToolError('commit_failed', `git add failed: ${add.stderr.trim()}`);
  const msg = message?.trim() || `devtool ${cs.skill}: ${cs.summary[0] ?? cs.id}`.slice(0, 200);
  const body = message?.trim() ? '' : `\n\n${cs.summary.slice(1, 15).map((s) => `- ${s.trim()}`).join('\n')}\n\ndevtool change ${cs.id}`;
  const commit = spawnSync('git', ['commit', '-m', msg + body, '--', ...paths], { cwd: root, encoding: 'utf8' });
  if (commit.status !== 0) throw new ToolError('commit_failed', `The change was applied, but git commit failed: ${(commit.stderr || commit.stdout).trim().split('\n')[0]}`, 'Commit it yourself, or undo it with devtool undo.');
  return spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
}

/** Writes the diff to a file and opens it in $VISUAL / $EDITOR; returns false when no editor is set. */
export function openDiffInEditor(root: string, cs: ChangeSet): boolean {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) return false;
  const dir = join(root, TOOL_DIR, 'tmp');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${cs.id}.diff`);
  writeFileSync(file, cs.changes.map((c) => unifiedDiff(c.path, c.before, c.after)).join('\n'));
  const r = spawnSync(editor, [file], { stdio: 'inherit', shell: true });
  return r.status === 0 || r.status === null;
}

/** Reads text from the system clipboard. */
export function readClipboard(): string {
  const tries: [string, string[]][] =
    process.platform === 'darwin'
      ? [['pbpaste', []]]
      : process.platform === 'win32'
        ? [['powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw']]]
        : [['wl-paste', ['--no-newline']], ['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['--clipboard', '--output']]];
  for (const [cmd, args] of tries) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0 && r.stdout.trim()) return r.stdout;
  }
  throw new ToolError('no_clipboard', 'Could not read the clipboard, or it is empty.', process.platform === 'linux' ? 'Install wl-clipboard, xclip or xsel, or paste on standard input instead.' : 'Copy the cURL command first, or paste it on standard input instead.');
}
