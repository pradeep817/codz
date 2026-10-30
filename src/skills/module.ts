// module add and api wire, as change sets.

import { loadMap } from '../core/cache.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { loadConfig } from '../core/config.ts';
import { ToolError, type Adapter, type ChangeSet, type PlannedEdits } from '../core/types.ts';

function merge(a: PlannedEdits, b: PlannedEdits): PlannedEdits {
  return { files: b.files, summary: [...a.summary, ...b.summary], warnings: [...a.warnings, ...b.warnings], generated: [...a.generated, ...b.generated] };
}

export async function planModuleAdd(root: string, adapter: Adapter, opts: { name: string; initial?: boolean; apis?: string[]; noLoad?: boolean }): Promise<ChangeSet> {
  if (!adapter.planModule || !adapter.planWire) throw new ToolError('not_supported', `module add is not available for the ${adapter.id} adapter yet.`, 'Supported: Flutter with GetX.');
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  let edits = adapter.planModule({ root, map }, { name: opts.name, initial: opts.initial });
  for (const endpoint of opts.apis ?? []) edits = merge(edits, adapter.planWire({ root, map }, { endpoint, module: opts.name, noLoad: opts.noLoad }, edits.files));
  return buildChangeSet(root, 'module add', edits);
}

export async function planApiWire(root: string, adapter: Adapter, opts: { endpoint: string; module: string; noLoad?: boolean }): Promise<ChangeSet> {
  if (!adapter.planWire) throw new ToolError('not_supported', `api wire is not available for the ${adapter.id} adapter yet.`, 'Supported: Flutter with GetX.');
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  return buildChangeSet(root, 'api wire', adapter.planWire({ root, map }, opts));
}
