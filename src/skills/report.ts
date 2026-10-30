// codz report: what codz did in this project, for beta feedback. It is
// built from codz's own records (.codz/history.json and events.jsonl) and
// holds counts, dates and the setup (framework, HTTP client, router, ...), never
// code, file names, endpoint paths or URLs, so it can be pasted into a form.

import { readEvents } from '../core/events.ts';
import { readHistory } from '../core/changeset.ts';
import type { Adapter, ProjectMap } from '../core/types.ts';

/** Conventions that describe the setup without naming anything in the project. */
const SETUP_KEYS = ['http', 'dataFetching', 'stateManagement', 'di', 'router', 'ui', 'flavor', 'bundler', 'serialization', 'apiStyle', 'fileSync', 'routerStyle'];

export interface UsageReport {
  codz: string;
  node: string;
  os: string;
  framework: string;
  setup: Record<string, string>;
  size: { endpoints: number; models: number; routes: number };
  activity: { first?: string; last?: string; activeDays: number };
  commands: { name: string; runs: number; failed: number }[];
  errors: { code: string; count: number }[];
  changes: { applied: number; undone: number; undoRate: string; bySkill: { skill: string; applied: number; undone: number }[] };
}

const day = (iso: string) => iso.slice(0, 10);
/** History ids start with the UTC time: 20261029-143012-ab12cd. */
const idDay = (id: string) => (/^(\d{4})(\d{2})(\d{2})-/.exec(id) ? id.replace(/^(\d{4})(\d{2})(\d{2})-.*$/, '$1-$2-$3') : '');

export function buildReport(root: string, adapter: Adapter, map: ProjectMap, version: string): UsageReport {
  const events = readEvents(root);
  const history = readHistory(root);
  const setup: Record<string, string> = {};
  for (const k of SETUP_KEYS) {
    const v = map.conventions[k];
    if (typeof v === 'string' && v && /^[\w-]+$/.test(v)) setup[k] = v;
  }
  const byCmd = new Map<string, { runs: number; failed: number }>();
  const byCode = new Map<string, number>();
  for (const e of events) {
    const c = byCmd.get(e.cmd) ?? { runs: 0, failed: 0 };
    c.runs++;
    if (!e.ok) {
      c.failed++;
      byCode.set(e.code ?? 'unknown', (byCode.get(e.code ?? 'unknown') ?? 0) + 1);
    }
    byCmd.set(e.cmd, c);
  }
  const bySkill = new Map<string, { applied: number; undone: number }>();
  for (const h of history) {
    const s = bySkill.get(h.skill) ?? { applied: 0, undone: 0 };
    s.applied++;
    if (h.undone) s.undone++;
    bySkill.set(h.skill, s);
  }
  const days = new Set([...events.map((e) => day(e.t)), ...history.map((h) => idDay(h.id)).filter(Boolean)]);
  const sorted = [...days].sort();
  const applied = history.length;
  const undone = history.filter((h) => h.undone).length;
  return {
    codz: version,
    node: process.versions.node,
    os: process.platform,
    framework: adapter.id,
    setup,
    size: { endpoints: map.endpoints.length, models: map.models.length, routes: map.routes.length },
    activity: { first: sorted[0], last: sorted.at(-1), activeDays: sorted.length },
    commands: [...byCmd].map(([name, c]) => ({ name, ...c })).sort((a, b) => b.runs - a.runs),
    errors: [...byCode].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
    changes: { applied, undone, undoRate: applied ? `${Math.round((undone / applied) * 100)}%` : '-', bySkill: [...bySkill].map(([skill, s]) => ({ skill, ...s })).sort((a, b) => b.applied - a.applied) },
  };
}

export function renderReport(r: UsageReport): string {
  const out = [
    `codz ${r.codz} · Node ${r.node} · ${r.os}`,
    `Project: ${r.framework}${Object.keys(r.setup).length ? ` (${Object.entries(r.setup).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`,
    `Size: ${r.size.endpoints} endpoints, ${r.size.models} models, ${r.size.routes} routes`,
    `Used on ${r.activity.activeDays} day${r.activity.activeDays === 1 ? '' : 's'}${r.activity.first ? `, ${r.activity.first} to ${r.activity.last}` : ''}`,
    '',
    `Changes: ${r.changes.applied} applied, ${r.changes.undone} undone (undo rate ${r.changes.undoRate})`,
    ...r.changes.bySkill.map((s) => `  ${s.skill.padEnd(16)} ${String(s.applied).padStart(4)} applied  ${String(s.undone).padStart(3)} undone`),
    '',
    'Commands:',
    ...(r.commands.length ? r.commands.map((c) => `  ${c.name.padEnd(16)} ${String(c.runs).padStart(4)} runs  ${c.failed ? `${c.failed} failed` : ''}`.trimEnd()) : ['  none recorded yet']),
    ...(r.errors.length ? ['', 'Errors:', ...r.errors.map((e) => `  ${e.code.padEnd(24)} ${e.count}`)] : []),
    '',
    'This report has counts and setup names only: no code, file names, endpoint paths or URLs.',
    'Paste it into the beta feedback form, or share the JSON from codz report --json.',
  ];
  return out.join('\n');
}
