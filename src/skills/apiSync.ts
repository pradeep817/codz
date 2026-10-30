// api sync <spec>: brings the project's endpoints in line with an OpenAPI,
// Swagger, Postman or HAR file in one change.
//
//   in both          rewritten from the spec (response and request models,
//                    parameters); unchanged ones are left alone
//   only in spec     listed; added with --add
//   only in project  listed; removed with --remove
//
// Breaking changes (a response field removed or changed type, a new required
// parameter) are reported with the lines that use them. --check plans
// everything and reports drift without writing (exit 1 when out of sync).

import { join } from 'node:path';
import { loadMap } from '../core/cache.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { loadConfig } from '../core/config.ts';
import { readText } from '../core/fsutil.ts';
import { ToolError, type Adapter, type ChangeSet, type EndpointInfo, type EndpointSpec, type InferredType } from '../core/types.ts';
import { readApiFile, type ImportedOperation } from '../input/apiSpec.ts';
import { findDeclaration, planApiRemove, planEndpointUpdate } from './apiEdit.ts';
import { pathMatches } from './apiImport.ts';

export interface SyncOptions {
  file: string;
  tags?: string[];
  paths?: string[];
  /** Add operations that are in the spec but not in the project. */
  add?: boolean;
  /** Remove endpoints that are in the project but not in the spec. */
  remove?: boolean;
  baseUrl?: string;
}

export interface SyncReport {
  changeSet: ChangeSet;
  updated: string[];
  unchanged: string[];
  added: string[];
  newInSpec: string[];
  removed: string[];
  missingFromSpec: string[];
  breaking: string[];
}

const shape = (p: string) => p.replace(/\{[^/}]+\}/g, '{}').replace(/\/+$/, '') || '/';

/** The spec operation for a project endpoint: same method, and the same path or the same path under a base prefix (/v1). */
function matchOperation(ep: EndpointInfo, ops: ImportedOperation[]): ImportedOperation | undefined {
  const same = ops.filter((o) => o.spec.method === ep.method);
  const p = shape(ep.path);
  return same.find((o) => shape(o.spec.path) === p) ?? same.find((o) => shape(o.spec.path).endsWith(p) && p !== '/');
}

function renameModel(t: InferredType | undefined, from: string, to: string): InferredType | undefined {
  if (!t) return t;
  if (t.kind === 'object') return t.model === from ? { kind: 'object', model: to } : t;
  if (t.kind === 'array') return { kind: 'array', item: renameModel(t.item, from, to)! };
  return t;
}

function rootModel(t: InferredType | undefined): string | undefined {
  if (!t) return undefined;
  if (t.kind === 'object') return t.model;
  if (t.kind === 'array') return rootModel(t.item);
  return undefined;
}

export async function planApiSync(root: string, adapter: Adapter, opts: SyncOptions): Promise<SyncReport> {
  if (!adapter.planEndpoint) throw new ToolError('not_supported', `api sync needs a framework adapter; this project uses the ${adapter.id} adapter.`);
  const file = readText(join(root, opts.file)) !== null ? join(root, opts.file) : opts.file;
  const text = readText(file);
  if (text === null) throw new ToolError('no_file', `Cannot read ${opts.file}.`);
  const doc = readApiFile(text, { baseUrl: opts.baseUrl });
  const wantTags = new Set((opts.tags ?? []).map((t) => t.toLowerCase()));
  const ops = doc.operations.filter((o) => (!wantTags.size || o.tags.some((t) => wantTags.has(t.toLowerCase()))) && (!opts.paths?.length || opts.paths.some((g) => pathMatches(g, o.spec.path))));
  if (!ops.length) throw new ToolError('no_endpoints', `No operations matched in ${opts.file}.`);

  const lang = adapter.id === 'flutter' ? 'dart' : 'ts';
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  const suffix = lang === 'dart' ? map.conventions.modelClassSuffix ?? '' : '';
  const working = structuredClone(map);
  let overlay = new Map<string, string>();
  const report: Omit<SyncReport, 'changeSet'> = { updated: [], unchanged: [], added: [], newInSpec: [], removed: [], missingFromSpec: [], breaking: [] };
  const summary: string[] = [];
  const warnings = new Set<string>(doc.warnings);
  const generated: ChangeSet['generated'] = [];
  const matched = new Set<ImportedOperation>();
  // Prefixes the project's paths leave out (/v1 when the base URL already has it), learned from matches.
  const prefixes = new Map<string, number>();
  // With path filters, only endpoints under those paths are compared.
  const inScope = (ep: EndpointInfo) => !opts.paths?.length || opts.paths.some((g) => pathMatches(g, ep.path) || ops.some((o) => shape(o.spec.path).endsWith(shape(ep.path))));

  for (const ep of map.endpoints.filter(inScope)) {
    const op = matchOperation(ep, ops);
    if (!op) {
      report.missingFromSpec.push(ep.name);
      continue;
    }
    matched.add(op);
    const specShape = shape(op.spec.path);
    const prefix = specShape.slice(0, specShape.length - shape(ep.path).length);
    prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
    const spec: EndpointSpec = structuredClone(op.spec);
    spec.name = ep.name;
    // The project's path (relative to its base URL) and parameter names stay; the spec decides types.
    const projectParams = [...ep.path.matchAll(/\{([^/}]+)\}/g)].map((m) => m[1]);
    if (projectParams.length === spec.pathParams.length) spec.pathParams = spec.pathParams.map((p, i) => ({ ...p, name: projectParams[i] }));
    spec.path = ep.path;
    spec.origin = '';
    delete spec.serverPrefix;
    // Fields the project already has keep their order, so the diff shows only what changed.
    for (const m of spec.models) {
      const old = map.models.find((x) => x.name === (suffix && !m.name.endsWith(suffix) ? m.name + suffix : m.name));
      if (!old) continue;
      const order = new Map(old.fields.map((f, i) => [f.name, i]));
      m.fields = [...m.fields].sort((a, b) => (order.get(a.jsonName) ?? 1e6) - (order.get(b.jsonName) ?? 1e6));
    }
    // The project's response class keeps its name (the spec may call it UserDto).
    const rootClass = (ep.response ?? '').replace(/^Promise<(.*)>$/, '$1').replace(/^List<(.*)>$/, '$1').replace(/\[\]$/, '').replace(/\?$/, '');
    const specRoot = rootModel(spec.response);
    const keep = rootClass && map.models.some((m) => m.name === rootClass) ? (suffix && rootClass.endsWith(suffix) ? rootClass.slice(0, -suffix.length) : rootClass) : undefined;
    if (specRoot && keep && specRoot !== keep && !spec.models.some((m) => m.name === keep)) {
      spec.response = renameModel(spec.response, specRoot, keep);
      for (const m of spec.models) {
        if (m.name === specRoot) m.name = keep;
        m.fields = m.fields.map((f) => ({ ...f, type: renameModel(f.type, specRoot, keep)! }));
      }
    }
    const before = new Map(overlay);
    try {
      const r = await planEndpointUpdate(root, adapter, working, overlay, ep, spec, rootClass, `from ${doc.format === 'har' ? 'the HAR file' : 'the spec'}`);
      const changedFiles = [...r.files].filter(([f, t]) => (before.get(f) ?? readText(join(root, f))) !== t);
      if (!changedFiles.length) {
        report.unchanged.push(ep.name);
        continue;
      }
      overlay = r.files;
      report.updated.push(ep.name);
      summary.push(...r.summary);
      for (const w of r.warnings) warnings.add(`${ep.name}: ${w}`);
      generated.push(...r.generated);
      for (const m of r.models) {
        const i = working.models.findIndex((x) => x.name === m.name);
        if (i === -1) working.models.push(m);
        else working.models[i] = m;
      }
      if (r.changes.removed.length) report.breaking.push(`${ep.name}: ${rootClass || 'response'} lost ${r.changes.removed.join(', ')}`);
      // A field that became non-nullable is not breaking for code that reads it; anything else is.
      const risky = r.changes.changed.filter((c) => {
        const m = /^[^:]+:\s*(.+?)\s*→\s*(.+)$/.exec(c);
        return !m || !(m[1].replace(/\?$/, '') === m[2].replace(/\?$/, '') && m[1].endsWith('?') && !m[2].endsWith('?'));
      });
      if (risky.length) report.breaking.push(`${ep.name}: ${risky.join('; ')}`);
      const oldText = readText(join(root, ep.file)) ?? '';
      const oldDecl = findDeclaration(oldText, ep.name, lang)?.params ?? '';
      const newPathParams = spec.pathParams.map((p) => p.name).filter((n) => !new RegExp(`\\b${n}\\b`).test(oldDecl));
      if (newPathParams.length) report.breaking.push(`${ep.name}: new required parameter${newPathParams.length === 1 ? '' : 's'} ${newPathParams.join(', ')}`);
      if (spec.request && !/\bbody\b/.test(oldDecl)) report.breaking.push(`${ep.name}: now takes a request body`);
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
      warnings.add(`Could not update ${ep.name}: ${e.message}`);
    }
  }

  // New in the spec.
  for (const op of ops) {
    if (matched.has(op)) continue;
    if (working.endpoints.some((e) => e.name === op.spec.name && e.method === op.spec.method)) continue;
    if (!opts.add) {
      report.newInSpec.push(op.spec.name);
      continue;
    }
    try {
      const spec: EndpointSpec = structuredClone(op.spec);
      const [prefix] = [...prefixes.entries()].sort((a, b) => b[1] - a[1])[0] ?? [''];
      if (prefix && spec.path.startsWith(`${prefix}/`)) {
        spec.path = spec.path.slice(prefix.length);
        spec.origin = '';
        delete spec.serverPrefix;
      }
      const edits = await adapter.planEndpoint({ root, map: working }, spec, overlay);
      if (!edits.endpoints) continue;
      overlay = edits.files;
      working.endpoints.push(...edits.endpoints);
      working.models.push(...(edits.models ?? []));
      generated.push(...edits.generated);
      report.added.push(op.spec.name);
      summary.push(`Add ${spec.name}() for ${spec.method} ${spec.path}`);
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
      warnings.add(`Could not add ${op.spec.name}: ${e.message}`);
    }
  }

  // Gone from the spec.
  if (opts.remove && report.missingFromSpec.length) {
    for (const name of report.missingFromSpec) {
      // Removal works on files as they are on disk; it is planned only when the file is not also being updated.
      const ep = map.endpoints.find((e) => e.name === name)!;
      if (overlay.has(ep.file)) {
        warnings.add(`${name} is not in the spec, but ${ep.file} also has updates; run api remove ${name} after this sync.`);
        continue;
      }
      const cs = await planApiRemove(root, adapter, name);
      for (const ch of cs.changes) if (ch.after !== null) overlay.set(ch.path, ch.after);
      summary.push(...cs.summary);
      for (const w of cs.warnings) warnings.add(w);
      report.removed.push(name);
    }
  }

  if (report.newInSpec.length) warnings.add(`In the spec but not in the project: ${report.newInSpec.join(', ')}. Pass --add to add them.`);
  const notRemoved = report.missingFromSpec.filter((n) => !report.removed.includes(n));
  if (notRemoved.length && !opts.remove) warnings.add(`In the project but not in the spec: ${notRemoved.join(', ')}. Pass --remove to delete them (only if they belong to this API).`);
  if (report.breaking.length) warnings.add(`Breaking changes for callers:\n${report.breaking.map((b) => `    ${b}`).join('\n')}`);
  if (!summary.length) summary.push(`Everything matches ${opts.file}: ${report.unchanged.length} endpoint${report.unchanged.length === 1 ? '' : 's'} checked.`);
  else summary.unshift(`Sync with ${doc.title || opts.file}: ${report.updated.length} updated, ${report.added.length} added, ${report.removed.length} removed, ${report.unchanged.length} unchanged`);
  const changeSet = buildChangeSet(root, 'api sync', { files: overlay, summary, warnings: [...warnings], generated });
  return { changeSet, ...report };
}
