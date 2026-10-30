// Decides, for each inferred model, whether the project already has it.
// Same name + same field names → reuse the existing model (no new code).
// Same name + different fields → nested models get a prefixed name; the root
// model is a conflict the developer resolves with --model-name.

import { ToolError, type EndpointSpec, type InferredType, type ModelInfo } from '../core/types.ts';
import { pascal } from '../input/naming.ts';

export interface ModelResolution {
  spec: EndpointSpec;
  /** Inferred model name → existing project model. */
  reused: Map<string, ModelInfo>;
  /** Inferred model name → existing model whose definition is rewritten (api update). */
  replaced: Map<string, ModelInfo>;
  notes: string[];
}

const norm = (s: string) => s.replace(/[_\-\s]/g, '').toLowerCase();

function renameType(t: InferredType, from: string, to: string): InferredType {
  if (t.kind === 'object' && t.model === from) return { kind: 'object', model: to };
  if (t.kind === 'array') return { kind: 'array', item: renameType(t.item, from, to) };
  return t;
}

function rootModels(spec: EndpointSpec): Set<string> {
  const roots = new Set<string>();
  const add = (t?: InferredType) => {
    if (!t) return;
    if (t.kind === 'object') roots.add(t.model);
    if (t.kind === 'array') add(t.item);
  };
  add(spec.response);
  add(spec.request);
  return roots;
}

/**
 * @param className maps an inferred model name to the class/interface name the adapter would generate.
 */
export function resolveModels(input: EndpointSpec, existing: ModelInfo[], className: (name: string) => string, opts: { replace?: boolean } = {}): ModelResolution {
  const spec: EndpointSpec = structuredClone(input);
  const reused = new Map<string, ModelInfo>();
  const replaced = new Map<string, ModelInfo>();
  const notes: string[] = [];
  const roots = rootModels(spec);
  const byName = new Map(existing.map((m) => [m.name, m]));
  const generatedNames = new Set(spec.models.map((m) => className(m.name)));

  for (const model of [...spec.models]) {
    const cls = className(model.name);
    const found = byName.get(cls);
    if (!found) continue;
    const wanted = new Set(model.fields.map((f) => norm(f.jsonName)));
    const have = new Set(found.fields.map((f) => norm(f.name)));
    const same = wanted.size === have.size && [...wanted].every((f) => have.has(f));
    if (same) {
      reused.set(model.name, found);
      notes.push(`Reusing the existing model ${cls} (${found.file}).`);
      continue;
    }
    if (opts.replace) {
      replaced.set(model.name, found);
      notes.push(`Updating the model ${cls} (${found.file}).`);
      continue;
    }
    if (roots.has(model.name)) {
      throw new ToolError(
        'model_conflict',
        `The project already has a model called ${cls} (${found.file}) with different fields than this response.`,
        `Pass --model-name <Name> to generate the response model under another name, or update ${found.file} first.`,
      );
    }
    // Nested model: prefix with the root response model name.
    const rootName = [...roots][0] ?? spec.name;
    let to = pascal(`${rootName} ${model.name}`);
    let n = 2;
    while (byName.has(className(to)) || generatedNames.has(className(to))) to = `${pascal(`${rootName} ${model.name}`)}${n++}`;
    notes.push(`The project already has a different ${cls}; the new nested model is called ${className(to)}.`);
    for (const m of spec.models) m.fields = m.fields.map((f) => ({ ...f, type: renameType(f.type, model.name, to) }));
    if (spec.response) spec.response = renameType(spec.response, model.name, to);
    if (spec.request) spec.request = renameType(spec.request, model.name, to);
    generatedNames.add(className(to));
    model.name = to;
  }
  // Keep only models still reachable from the request/response without going
  // through a reused model (a reused model brings its own nested types).
  const byInferred = new Map(spec.models.map((m) => [m.name, m]));
  const reachable = new Set<string>();
  const visit = (name: string) => {
    if (reachable.has(name) || reused.has(name)) return;
    const m = byInferred.get(name);
    if (!m) return;
    reachable.add(name);
    for (const f of m.fields) for (const r of referencedModels(f.type)) visit(r);
  };
  for (const r of referencedModels(spec.response)) visit(r);
  for (const r of referencedModels(spec.request)) visit(r);
  spec.models = spec.models.filter((m) => reachable.has(m.name));
  // Types that refer to an existing model without describing it (api update keeps the request type) reuse it.
  for (const name of [...referencedModels(spec.response), ...referencedModels(spec.request)]) {
    if (byInferred.has(name) || reused.has(name)) continue;
    const found = byName.get(className(name));
    if (found) reused.set(name, found);
  }
  return { spec, reused, replaced, notes };
}

/** Collects the model names a type refers to. */
export function referencedModels(t: InferredType | undefined, out = new Set<string>()): Set<string> {
  if (!t) return out;
  if (t.kind === 'object') out.add(t.model);
  if (t.kind === 'array') referencedModels(t.item, out);
  return out;
}
