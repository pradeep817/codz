// Edit forms that start with the current values: feature add passes the detail
// endpoint (getOrder) to the edit form (updateOrder), and the form loads it on
// open and fills every input whose field is in both models. These helpers work
// out the call and the field mapping; each form generator writes them in its
// own language.

import { join } from 'node:path';
import { readText } from '../core/fsutil.ts';
import type { EndpointInfo, ModelInfo, ProjectMap } from '../core/types.ts';
import { splitTsParams } from '../adapters/reactQuery.ts';
import { findDeclaration } from './apiEdit.ts';
import { responseShape } from './screen.ts';

export interface Prefill {
  ep: EndpointInfo;
  /** The loaded model (the detail response). */
  model: ModelInfo;
  /** JSON names that are in both the loaded model and the form's body. */
  shared: Set<string>;
  /** Field of the loaded model by JSON name. */
  field: (json: string) => ModelInfo['fields'][number] | undefined;
}

/**
 * The detail endpoint to load into a form, when it can be called with the
 * form's route parameters and returns a model sharing fields with the body.
 * Returns null otherwise (the form then starts empty).
 */
export function prefillFor(root: string, map: ProjectMap, loadName: string | undefined, bodyFields: string[], routeParams: string[], lang: 'ts' | 'dart' | 'kt' | 'swift'): Prefill | null {
  if (!loadName) return null;
  const ep = map.endpoints.find((e) => e.name === loadName);
  if (!ep || ep.method !== 'GET') return null;
  let returnType = ep.response ?? '';
  if (lang === 'ts' || lang === 'dart') {
    const decl = findDeclaration(readText(join(root, ep.file)) ?? '', ep.name, lang === 'ts' ? 'ts' : 'dart');
    if (decl?.returnType) returnType = decl.returnType;
  }
  const shape = responseShape(returnType, map);
  if (shape.list || !shape.model) return null;
  // Its path parameters must all be route parameters of the form.
  const params = [...ep.path.matchAll(/\{([^/}]+)\}/g)].map((m) => m[1]);
  if (params.length !== routeParams.length) return null;
  const model = shape.model;
  const have = new Set(model.fields.map((f) => f.name));
  const shared = new Set(bodyFields.filter((f) => have.has(f)));
  if (!shared.size) return null;
  return { ep, model, shared, field: (json) => model.fields.find((f) => f.name === json) };
}

/** TypeScript: the value an input starts with, from the loaded object d. */
export function tsInitial(kind: string, access: string, nullable: boolean, q = "'"): string {
  const empty = `${q}${q}`;
  if (kind === 'bool') return `Boolean(${access})`;
  if (kind === 'strings') return `(${access} ?? []).join(${q}, ${q})`;
  if (kind === 'int' || kind === 'double' || kind === 'number') return `${access} == null ? ${empty} : String(${access})`;
  if (kind === 'date') return `String(${access} ?? ${empty}).slice(0, 16)`;
  return nullable ? `${access} ?? ${empty}` : `String(${access} ?? ${empty})`;
}

/**
 * React and React Native forms: a useEffect that loads the detail endpoint
 * with the route parameters (plain variables named like them) and fills the
 * inputs. Returns null when there is nothing to load.
 */
export function reactPrefill(root: string, map: ProjectMap, loadName: string | undefined, fields: { json: string; kind: string }[], params: string[], key: (json: string) => string): { ep: EndpointInfo; lines: string[] } | null {
  const pre = prefillFor(root, map, loadName, fields.map((f) => f.json), params, 'ts');
  if (!pre) return null;
  const decl = findDeclaration(readText(join(root, pre.ep.file)) ?? '', pre.ep.name, 'ts');
  if (!decl) return null;
  const ps = splitTsParams(decl.params).filter((p) => !p.optional);
  if (!ps.every((p) => params.includes(p.name))) return null;
  const args = ps.map((p) => (/^number$/.test(p.type) ? `Number(${p.name})` : p.name)).join(', ');
  const set = fields.filter((f) => pre.shared.has(f.json)).map((f) => `${key(f.json)}: ${tsInitial(f.kind, /^[A-Za-z_$][\w$]*$/.test(f.json) ? `d.${f.json}` : `d['${f.json}']`, pre.field(f.json)!.nullable)}`);
  return {
    ep: pre.ep,
    lines: [
      '',
      '  // Start with the current values.',
      '  useEffect(() => {',
      `    ${pre.ep.name}(${args})`,
      `      .then((d) => setValues((v) => ({ ...v, ${set.join(', ')} })))`,
      '      .catch((e) => setError(e instanceof Error ? e.message : String(e)));',
      `  }, [${ps.map((p) => p.name).join(', ')}]);`,
    ],
  };
}
