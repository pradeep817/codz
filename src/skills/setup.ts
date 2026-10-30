// setup: creates an API layer (network client, registration, entry-point
// wiring, dependencies and conventions) for a project that has none, as one
// change set the developer previews and can undo.

import { checkBaseUrl } from '../core/safe.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { ToolError, type Adapter, type ChangeSet, type ProjectMap, type SetupChoice, type SetupPlan } from '../core/types.ts';
import { initFiles } from './init.ts';

export function planSetup(root: string, adapter: Adapter, map: ProjectMap, choice: SetupChoice): { changeSet: ChangeSet; plan: SetupPlan } {
  if (!adapter.planSetup || !adapter.architectures) {
    throw new ToolError('not_supported', `setup is not available for the ${adapter.id} adapter.`, 'Supported: Next.js and Flutter.');
  }
  const options = adapter.architectures(map);
  if (!options.length) {
    throw new ToolError('already_set_up', 'This project already has an API layer, so setup is not needed.', 'Run devtool explain to see it, then devtool api add.');
  }
  if (!options.some((o) => o.id === choice.architecture)) {
    throw new ToolError('bad_args', `Unknown architecture "${choice.architecture}". Choose one of: ${options.map((o) => o.id).join(', ')}.`);
  }
  // Checked strictly: the base URL is written into source files and config as a string literal.
  if (choice.baseUrl) choice = { ...choice, baseUrl: checkBaseUrl(choice.baseUrl) };
  const plan = adapter.planSetup({ root, map }, { ...choice, baseUrl: choice.baseUrl.replace(/\/+$/, '') });
  const files = new Map(plan.files);
  for (const [path, content] of initFiles(root, adapter, plan.conventions)) files.set(path, content);
  const changeSet = buildChangeSet(root, 'setup', { ...plan, files });
  return { changeSet, plan };
}
