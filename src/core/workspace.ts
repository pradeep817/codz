// A private copy of the project for commands that chain several generators
// (feature add, auth add). Each step plans and applies against the copy, so a
// later step sees what earlier steps wrote; at the end the copy is compared
// with the real project and the difference becomes ONE change set, previewed
// and undone like any other. The real project is never touched while planning.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { applyChangeSet, buildChangeSet } from './changeset.ts';
import { TOOL_DIR } from './cache.ts';
import type { ChangeSet, GeneratedRecord } from './types.ts';

/** Folders that are generated, installed or huge; never copied and never compared. */
const SKIP = new Set(['node_modules', '.git', '.dart_tool', 'build', '.gradle', '.next', 'Pods', '.expo', 'dist', 'out', '.idea', 'coverage', '.turbo', '.cache', TOOL_DIR, '.kotlin', '.cxx', '.externalNativeBuild']);
/** Files larger than this are copied but never read as text for the comparison. */
const MAX_TEXT = 2 * 1024 * 1024;

const keep = (root: string) => (src: string) => {
  const rel = relative(root, src);
  if (!rel) return true;
  return !rel.split(sep).some((part) => SKIP.has(part));
};

function walk(root: string, dir = root, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) walk(root, abs, out);
    else if (e.isFile()) out.push(relative(root, abs).split(sep).join('/'));
  }
  return out;
}

export interface Workspace {
  /** The copy's root: pass it to planners instead of the real root. */
  root: string;
  /** Applies one step's change set to the copy (no formatter, no git checks). Returns false when it changed nothing. */
  apply(cs: ChangeSet): boolean;
  /** Reads a file of the copy (null when missing). */
  read(rel: string): string | null;
  /** Writes a file of the copy directly (small follow-up edits between steps). */
  write(rel: string, text: string): void;
  /** Everything the steps changed, as one change set against the REAL project. */
  finish(skill: string, summary: string[], warnings: string[]): ChangeSet;
  /** Removes the copy. Always call it (finally). */
  dispose(): void;
}

export function openWorkspace(realRoot: string): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'codz-ws-'));
  cpSync(realRoot, root, { recursive: true, filter: keep(realRoot), verbatimSymlinks: true });
  const generated: GeneratedRecord[] = [];
  const rewrites = new Set<string>();
  return {
    root,
    apply(cs) {
      if (!cs.changes.length) return false;
      applyChangeSet(root, cs, { allowDirty: true, format: false, verify: false });
      generated.push(...cs.generated);
      for (const r of cs.rewrites ?? []) rewrites.add(r);
      return true;
    },
    read(rel) {
      const abs = join(root, rel);
      return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    },
    write(rel, text) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    },
    finish(skill, summary, warnings) {
      const files = new Map<string, string>();
      const deletes = new Set<string>();
      for (const rel of walk(root)) {
        const copy = join(root, rel);
        if (statSync(copy).size > MAX_TEXT) continue;
        const after = readFileSync(copy);
        const real = join(realRoot, rel);
        const before = existsSync(real) ? readFileSync(real) : null;
        if (before && before.equals(after)) continue;
        files.set(rel, after.toString('utf8'));
      }
      for (const rel of walk(realRoot)) if (!existsSync(join(root, rel))) deletes.add(rel);
      return buildChangeSet(realRoot, skill, { files, deletes, summary, warnings, generated, rewrites: [...rewrites] });
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
