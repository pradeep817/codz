// Change sets: plan, preview, apply (with hash checks, atomic writes,
// backups, formatting and verification) and undo.

import { fileHeader } from './templates.ts';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { invalidateMap, toolDir, TOOL_DIR } from './cache.ts';
import { diffStats, unifiedDiff } from './diff.ts';
import { exists, hash, readJson, readText } from './fsutil.ts';
import { dirtyFiles, isGitRepo } from './git.ts';
import { ToolError, type Adapter, type ChangeSet, type FileChange, type GeneratedRecord, type PlannedEdits } from './types.ts';

export function newId(): string {
  const d = new Date();
  const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}`;
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

function safePath(root: string, relPath: string): string {
  const abs = resolve(root, relPath);
  const r = resolve(root);
  if (abs !== r && !abs.startsWith(r + '/') && !abs.startsWith(r + '\\')) {
    throw new ToolError('outside_root', `Refusing to touch ${relPath}: it is outside the project root.`);
  }
  if (relPath.split(/[\\/]/).includes(TOOL_DIR)) throw new ToolError('outside_root', `Refusing to edit devtool's own folder (${relPath}).`);
  // Lexical checks are not enough: a symbolic link inside the project (for example lib -> ~/.ssh) would carry the
  // write outside it. Resolve the deepest folder that exists and check that it is still inside the real root.
  const realRoot = realpathSync(r);
  let probe = abs;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) throw new ToolError('outside_root', `Refusing to touch ${relPath}: it is a symbolic link.`, 'Replace the link with a real file, or run devtool on the folder it points to.');
  const realProbe = realpathSync(probe);
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + sep)) {
    throw new ToolError('outside_root', `Refusing to touch ${relPath}: a symbolic link takes it outside the project root.`);
  }
  return abs;
}

export function buildChangeSet(root: string, skill: string, edits: PlannedEdits): ChangeSet {
  const changes: FileChange[] = [];
  const entries: [string, string | null][] = [...edits.files.entries(), ...[...(edits.deletes ?? [])].filter((p) => !edits.files.has(p)).map((p): [string, null] => [p, null])];
  for (let [path, after] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    const abs = safePath(root, path);
    const before = readText(abs);
    if (before === after) continue; // also skips deleting a file that does not exist
    // New files start with the project's header template, if it has one.
    if (before === null && after !== null) {
      const header = fileHeader(root, path);
      if (header && !after.startsWith(header)) after = header + after;
    }
    changes.push({ path, baseHash: before === null ? null : hash(before), before, after });
  }
  const rewrites = (edits.rewrites ?? []).filter((p) => changes.some((c) => c.path === p));
  return { id: newId(), skill, summary: edits.summary, warnings: edits.warnings, changes, generated: edits.generated, ...(rewrites.length ? { rewrites } : {}) };
}

/** Lines that say something (not blank, not a lone bracket), trimmed. */
const meaningful = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 3);

/**
 * Files an edit would mostly replace: an existing file where less than half of
 * its lines survive. Commands edit existing files at known places (an import,
 * a route, a dependency) and keep the rest, so this means a generator wrote a
 * whole new file over one it should only have edited (as when a login page once
 * replaced a GetX binding). Files a command replaces on purpose are listed in
 * cs.rewrites and allowed.
 */
export function rewriteProblems(cs: ChangeSet): string[] {
  const allowed = new Set(cs.rewrites ?? []);
  const out: string[] = [];
  for (const c of cs.changes) {
    if (c.before === null || c.after === null || allowed.has(c.path)) continue;
    const before = meaningful(c.before);
    if (before.length < 4) continue;
    const after = new Set(meaningful(c.after));
    const kept = before.filter((l) => after.has(l)).length;
    if (kept / before.length < 0.5) out.push(c.path);
  }
  return out;
}

export function renderDiff(cs: ChangeSet, color: boolean): string {
  return cs.changes.map((c) => unifiedDiff(c.path, c.before, c.after, { color })).join('\n');
}

export function changeSetJson(cs: ChangeSet, includeDiff = true) {
  return {
    id: cs.id,
    skill: cs.skill,
    summary: cs.summary,
    warnings: cs.warnings,
    files: cs.changes.map((c) => ({
      path: c.path,
      action: c.before === null ? 'create' : c.after === null ? 'delete' : 'modify',
      ...diffStats(c.before, c.after),
      ...(includeDiff ? { diff: unifiedDiff(c.path, c.before, c.after) } : {}),
    })),
  };
}

// ---------- Plans (preview now, apply exactly this later) ----------

export function savePlan(root: string, cs: ChangeSet): string {
  const dir = toolDir(root, 'plans');
  writeFileSync(join(dir, `${cs.id}.json`), JSON.stringify(cs, null, 2));
  return cs.id;
}

export function loadPlan(root: string, id: string): ChangeSet {
  const cs = readJson<ChangeSet>(join(root, TOOL_DIR, 'plans', `${id}.json`));
  if (!cs) throw new ToolError('no_plan', `No saved plan with id "${id}".`, 'Run the skill again with --plan to create one.');
  return cs;
}

// ---------- History ----------

interface HistoryFile {
  path: string;
  created: boolean;
  /** devtool deleted this file; undo writes it back. */
  deleted?: boolean;
  afterHash: string;
}

export interface HistoryEntry {
  id: string;
  skill: string;
  summary: string[];
  files: HistoryFile[];
  generated: GeneratedRecord[];
  undone: boolean;
  /** Extra details a command keeps with its change (devtool new: template id, version, archive hash). */
  meta?: Record<string, unknown>;
}

function historyPath(root: string): string {
  return join(toolDir(root), 'history.json');
}

export function readHistory(root: string): HistoryEntry[] {
  return readJson<HistoryEntry[]>(historyPath(root)) ?? [];
}

function writeHistory(root: string, entries: HistoryEntry[]): void {
  writeFileSync(historyPath(root), JSON.stringify(entries, null, 2));
}

/** Records a change made outside applyChangeSet (devtool new writes a whole project). */
export function appendHistory(root: string, entry: HistoryEntry): void {
  writeHistory(root, [...readHistory(root), entry]);
}

/** Marks a history entry as undone. */
export function markUndone(root: string, id: string): void {
  const h = readHistory(root);
  const e = h.find((x) => x.id === id);
  if (e) {
    e.undone = true;
    writeHistory(root, h);
  }
}

// ---------- Apply ----------

export interface ApplyOptions {
  /** Skip the guard against replacing most of an existing file (rewriteProblems). */
  allowRewrite?: boolean;
  allowDirty?: boolean;
  adapter?: Adapter;
  format?: boolean;
  verify?: boolean;
}

export interface ApplyResult {
  files: string[];
  formatted: boolean;
  formatNote?: string;
  verified: boolean;
  verifyNote?: string;
}

function run(cmd: string, args: string[], cwd: string): { ok: boolean; output: string; missing: boolean } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 180_000, shell: process.platform === 'win32' });
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, output: '', missing: true };
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}`, missing: false };
}

/** Counts analyzer error lines per changed file. */
function errorCounts(output: string, files: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of output.split('\n')) {
    if (!/error/i.test(line)) continue;
    for (const f of files) {
      if (line.includes(f)) counts.set(f, (counts.get(f) ?? 0) + 1);
    }
  }
  return counts;
}

/** A lock older than this is from a run that died; it is taken over. */
const LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * Runs fn holding .devtool/lock, so two devtool runs on one project (a person and
 * an AI agent, two terminals) cannot apply or undo at the same time and mix their
 * files and backups. A lock left by a process that is gone, or an old one, is taken over.
 */
export function withProjectLock<T>(root: string, fn: () => T): T {
  const dir = join(root, TOOL_DIR);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'lock');
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new ToolError('busy', 'Another devtool change is being applied or undone in this project.', 'Wait for it to finish and try again.');
        throw e;
      }
      let held: { pid?: number; started?: string } = {};
      try {
        held = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        held = {};
      }
      const alive = (() => {
        if (!held.pid || held.pid === process.pid) return held.pid === process.pid;
        try {
          process.kill(held.pid, 0);
          return true;
        } catch (err) {
          return (err as NodeJS.ErrnoException).code === 'EPERM';
        }
      })();
      const old = !held.started || Date.now() - Date.parse(held.started) > LOCK_STALE_MS;
      if (alive && !old) throw new ToolError('busy', `Another devtool run (process ${held.pid}) is applying or undoing a change in this project.`, 'Wait for it to finish and try again.');
      rmSync(file, { force: true });
    }
  }
  try {
    return fn();
  } finally {
    rmSync(file, { force: true });
  }
}

export function applyChangeSet(root: string, cs: ChangeSet, opts: ApplyOptions = {}): ApplyResult {
  if (cs.changes.length === 0) return { files: [], formatted: false, verified: false };
  return withProjectLock(root, () => applyLocked(root, cs, opts));
}

function applyLocked(root: string, cs: ChangeSet, opts: ApplyOptions): ApplyResult {

  if (!opts.allowDirty && isGitRepo(root)) {
    const dirty = dirtyFiles(root).filter((f) => f !== 'devtool.config.yaml');
    if (dirty.length) {
      throw new ToolError('dirty_git', `The working tree has uncommitted changes (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', ...' : ''}).`, 'Commit or stash them first, or pass --allow-dirty. Undo still works either way, from devtool backups.');
    }
  }

  // A generator must not write a whole new file over one it should only edit.
  const replaced = rewriteProblems(cs);
  if (replaced.length && !opts.allowRewrite) {
    throw new ToolError('unsafe_rewrite', `This change would replace most of ${replaced.join(', ')} instead of editing ${replaced.length === 1 ? 'it' : 'them'}, so nothing was applied.`, 'This is a devtool bug: please report it with the command you ran. Check the preview with --dry-run.');
  }

  // Every target must be exactly as it was when the change set was planned.
  for (const c of cs.changes) {
    const current = readText(safePath(root, c.path));
    const currentHash = current === null ? null : hash(current);
    if (currentHash !== c.baseHash) {
      throw new ToolError('changed_since_plan', `${c.path} changed after the preview was made, so nothing was applied.`, 'Run the skill again to get a fresh preview.');
    }
  }

  const files = cs.changes.filter((c) => c.after !== null).map((c) => c.path);
  const verifyCmd = opts.verify !== false ? opts.adapter?.verifyCommand?.(root, files) : null;
  let baseline = new Map<string, number>();
  if (verifyCmd) {
    const existing = cs.changes.filter((c) => c.before !== null).map((c) => c.path);
    if (existing.length) {
      const before = run(verifyCmd.cmd, verifyCmd.args, root);
      if (!before.missing) baseline = errorCounts(before.output, files);
    }
  }

  // Back up originals.
  const backupDir = toolDir(root, 'backups', cs.id);
  for (const c of cs.changes) {
    if (c.before !== null) {
      const dest = join(backupDir, c.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, c.before);
    }
  }

  // Write all files to temporary names first, then swap them in.
  const temps: { tmp: string; abs: string }[] = [];
  try {
    for (const c of cs.changes) {
      if (c.after === null) continue;
      const abs = safePath(root, c.path);
      mkdirSync(dirname(abs), { recursive: true });
      const tmp = `${abs}.devtool-tmp`;
      writeFileSync(tmp, c.after);
      temps.push({ tmp, abs });
    }
    for (const t of temps) renameSync(t.tmp, t.abs);
    for (const c of cs.changes) if (c.after === null) unlinkSync(safePath(root, c.path));
  } catch (e) {
    for (const t of temps) if (exists(t.tmp)) rmSync(t.tmp, { force: true });
    restore(root, cs.id, cs.changes.map((c) => ({ path: c.path, created: c.before === null, deleted: c.after === null })));
    throw new ToolError('write_failed', `Writing files failed, and everything was restored: ${(e as Error).message}`);
  }

  const result: ApplyResult = { files, formatted: false, verified: false };

  if (opts.format !== false) {
    const fmt = opts.adapter?.formatCommand?.(root, files);
    if (fmt) {
      const r = run(fmt.cmd, fmt.args, root);
      if (r.missing) result.formatNote = `Formatter "${fmt.cmd}" was not found, so files were left as generated.`;
      else if (!r.ok) result.formatNote = `Formatter "${fmt.cmd}" reported a problem; files were left as generated. ${r.output.trim().split('\n')[0] ?? ''}`;
      else result.formatted = true;
    }
  }

  if (verifyCmd) {
    const after = run(verifyCmd.cmd, verifyCmd.args, root);
    if (after.missing) {
      result.verifyNote = `Analyzer "${verifyCmd.cmd}" was not found, so the result was not checked.`;
    } else {
      const counts = errorCounts(after.output, files);
      const worse = files.filter((f) => (counts.get(f) ?? 0) > (baseline.get(f) ?? 0));
      if (worse.length) {
        restore(root, cs.id, cs.changes.map((c) => ({ path: c.path, created: c.before === null, deleted: c.after === null })));
        const lines = after.output.split('\n').filter((l) => worse.some((f) => l.includes(f)) && /error/i.test(l)).slice(0, 8);
        throw new ToolError('verify_failed', `The analyzer found new errors in ${worse.join(', ')}, so the change was reverted.\n${lines.join('\n')}`, 'Run with --no-verify to apply anyway and fix the errors by hand.');
      }
      result.verified = true;
    }
  }

  const history = readHistory(root);
  history.push({
    id: cs.id,
    skill: cs.skill,
    summary: cs.summary,
    files: cs.changes.map((c) => (c.after === null ? { path: c.path, created: false, deleted: true, afterHash: '' } : { path: c.path, created: c.before === null, afterHash: hash(readText(safePath(root, c.path)) ?? '') })),
    generated: cs.generated,
    undone: false,
  });
  writeHistory(root, history);
  invalidateMap(root);
  return result;
}

function restore(root: string, id: string, files: { path: string; created: boolean; deleted?: boolean }[]): void {
  const backupDir = join(root, TOOL_DIR, 'backups', id);
  for (const f of files) {
    const abs = safePath(root, f.path);
    if (f.created) {
      if (exists(abs)) unlinkSync(abs);
      // Folders the change created (lib/features/orders/) go too, once they are empty; never the project root.
      for (let dir = dirname(abs); dir.startsWith(resolve(root) + sep); dir = dirname(dir)) {
        try {
          if (readdirSync(dir).length) break;
          rmdirSync(dir);
        } catch {
          break;
        }
      }
    } else {
      const original = readText(join(backupDir, f.path));
      if (original !== null) {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, original);
      }
    }
  }
}

// ---------- Undo ----------

export interface UndoResult {
  id: string;
  skill: string;
  files: string[];
}

export function undoLast(root: string, opts: { force?: boolean } = {}): UndoResult {
  return withProjectLock(root, () => undoLastLocked(root, opts));
}

function undoLastLocked(root: string, opts: { force?: boolean }): UndoResult {
  const history = readHistory(root);
  const entry = [...history].reverse().find((e) => !e.undone);
  if (!entry) throw new ToolError('nothing_to_undo', 'There is nothing to undo.');
  const changed = entry.files.filter((f) => {
    const current = readText(safePath(root, f.path));
    if (f.deleted) return current !== null; // something new was written where devtool deleted a file
    return current === null || hash(current) !== f.afterHash;
  });
  if (changed.length && !opts.force) {
    throw new ToolError('changed_since_apply', `These files changed after devtool wrote them: ${changed.map((f) => f.path).join(', ')}. Undo would lose those edits.`, 'Pass --force to undo anyway.');
  }
  restore(root, entry.id, entry.files);
  entry.undone = true;
  writeHistory(root, history);
  invalidateMap(root);
  return { id: entry.id, skill: entry.skill, files: entry.files.map((f) => f.path) };
}

/** Undoes changes from the newest back to (and including) `id`. Stops at the first conflict. */
export function undoTo(root: string, id: string, opts: { force?: boolean } = {}): UndoResult[] {
  const history = readHistory(root);
  const target = history.find((e) => e.id === id || e.id.startsWith(id));
  if (!target) throw new ToolError('no_change', `No applied change with id "${id}".`, 'List them with: devtool history');
  if (target.undone) throw new ToolError('already_undone', `${target.id} is already undone.`);
  const done: UndoResult[] = [];
  for (;;) {
    const r = undoLast(root, opts);
    done.push(r);
    if (r.id === target.id) return done;
  }
}

export interface HistoryDetail {
  entry: HistoryEntry;
  files: { path: string; action: 'created' | 'changed' | 'deleted'; state: 'as applied' | 'edited since' | 'missing'; diff?: string }[];
}

/** One applied change: its files, whether each still matches what devtool wrote, and the diff it made. */
export function historyShow(root: string, id: string): HistoryDetail {
  const entry = readHistory(root).find((e) => e.id === id || e.id.startsWith(id));
  if (!entry) throw new ToolError('no_change', `No applied change with id "${id}".`, 'List them with: devtool history');
  const backupDir = join(root, TOOL_DIR, 'backups', entry.id);
  const files = entry.files.map((f) => {
    const current = readText(safePath(root, f.path));
    const before = f.created ? null : readText(join(backupDir, f.path));
    const action: 'created' | 'changed' | 'deleted' = f.created ? 'created' : f.deleted ? 'deleted' : 'changed';
    const state: 'as applied' | 'edited since' | 'missing' = f.deleted ? (current === null ? 'as applied' : 'edited since') : current === null ? 'missing' : hash(current) === f.afterHash ? 'as applied' : 'edited since';
    const after = f.deleted ? null : state === 'as applied' ? current : null;
    return { path: f.path, action, state, diff: state === 'as applied' || f.deleted ? unifiedDiff(f.path, before, after) : undefined };
  });
  return { entry, files };
}
