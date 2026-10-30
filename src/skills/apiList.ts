// api list and api show: what endpoints the project has, read from the project map.

import { loadMap } from '../core/cache.ts';
import { loadConfig } from '../core/config.ts';
import { ToolError, type Adapter, type EndpointInfo, type ModelInfo } from '../core/types.ts';
import { endpointUses } from './apiEdit.ts';

export interface EndpointRow extends EndpointInfo {
  uses: number;
}

export async function apiList(root: string, adapter: Adapter, opts: { filter?: string } = {}): Promise<EndpointRow[]> {
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  const f = opts.filter?.toLowerCase();
  return map.endpoints
    .filter((e) => !f || e.name.toLowerCase().includes(f) || e.path.toLowerCase().includes(f) || e.method.toLowerCase() === f)
    .map((e) => ({ ...e, uses: new Set(e.calledFrom).size }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

export interface EndpointDetail {
  endpoint: EndpointInfo;
  declLine?: number;
  signature?: string;
  models: ModelInfo[];
  uses: { file: string; line: number; text: string }[];
}

export async function apiShow(root: string, adapter: Adapter, name: string): Promise<EndpointDetail> {
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  const ep = map.endpoints.find((e) => e.name === name) ?? map.endpoints.find((e) => e.name.toLowerCase() === name.toLowerCase());
  if (!ep) {
    const close = map.endpoints.filter((e) => e.name.toLowerCase().includes(name.toLowerCase())).map((e) => e.name);
    throw new ToolError('no_endpoint', `No endpoint called ${name} was found.`, close.length ? `Did you mean: ${close.join(', ')}?` : 'List them with: devtool api list');
  }
  // Models the response mentions, and the models those refer to.
  const models: ModelInfo[] = [];
  const visit = (type: string) => {
    for (const m of map.models) {
      if (models.includes(m) || !new RegExp(`\\b${m.name}\\b`).test(type)) continue;
      models.push(m);
      for (const f of m.fields) visit(f.type);
    }
  };
  visit(ep.response ?? '');
  const u = endpointUses(root, adapter, ep);
  return { endpoint: ep, declLine: u.declLine, signature: u.signature, models, uses: u.uses };
}
