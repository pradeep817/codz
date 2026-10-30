// plans list / show / clean: the change sets saved with --plan.
//
// A plan is "ready" when every file it touches is still as it was when the plan
// was made, "applied" when history has it, and "stale" when a file changed since
// (codz apply would refuse it).

import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_DIR } from '../core/cache.ts';
import { loadPlan, readHistory } from '../core/changeset.ts';
import { hash, readText } from '../core/fsutil.ts';
import type { ChangeSet } from '../core/types.ts';

export type PlanStatus = 'ready' | 'applied' | 'stale';

export interface PlanRow {
  id: string;
  skill: string;
  created: string;
  status: PlanStatus;
  files: string[];
  summary: string;
}

const plansDir = (root: string) => join(root, TOOL_DIR, 'plans');

export function planStatus(root: string, cs: ChangeSet, applied: Set<string>): PlanStatus {
  if (applied.has(cs.id)) return 'applied';
  for (const c of cs.changes) {
    const now = readText(join(root, c.path));
    if ((now === null ? null : hash(now)) !== c.baseHash) return 'stale';
  }
  return 'ready';
}

export function listPlans(root: string): PlanRow[] {
  let names: string[] = [];
  try {
    names = readdirSync(plansDir(root)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const applied = new Set(readHistory(root).filter((h) => !h.undone).map((h) => h.id));
  const rows: PlanRow[] = [];
  for (const n of names) {
    let cs: ChangeSet;
    try {
      cs = loadPlan(root, n.slice(0, -5));
    } catch {
      continue;
    }
    rows.push({
      id: cs.id,
      skill: cs.skill,
      created: statSync(join(plansDir(root), n)).mtime.toISOString(),
      status: planStatus(root, cs, applied),
      files: cs.changes.map((c) => c.path),
      summary: cs.summary[0] ?? '',
    });
  }
  return rows.sort((a, b) => b.created.localeCompare(a.created));
}

export function showPlan(root: string, id: string): { plan: ChangeSet; status: PlanStatus } {
  const plan = loadPlan(root, id);
  const applied = new Set(readHistory(root).filter((h) => !h.undone).map((h) => h.id));
  return { plan, status: planStatus(root, plan, applied) };
}

/** Deletes plans that were applied or went stale (or every plan with all). */
export function cleanPlans(root: string, opts: { all?: boolean } = {}): string[] {
  const removed: string[] = [];
  for (const p of listPlans(root)) {
    if (opts.all || p.status !== 'ready') {
      rmSync(join(plansDir(root), `${p.id}.json`), { force: true });
      removed.push(p.id);
    }
  }
  return removed;
}
