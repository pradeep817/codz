// api import: every operation in an OpenAPI, Swagger, Postman or HAR file,
// planned one after another into a single change set. Each endpoint builds on
// the files and models planned before it, so shared schemas become one model
// and endpoints of one resource land in one file.
//
// Filters: --tag, --only, --path <glob>, --method, --max. --list shows what
// would be imported and stops. Endpoints that cannot be planned (a model name
// clash, say) stop the import unless --skip-conflicts applies the rest.

import { groupPlanned, modelLangOf } from '../core/modelGroup.ts';
import { join } from 'node:path';
import { loadMap } from '../core/cache.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { loadConfig } from '../core/config.ts';
import { readText } from '../core/fsutil.ts';
import { ToolError, type Adapter, type ChangeSet, type HttpMethod } from '../core/types.ts';
import { readApiFile, type ImportedOperation } from '../input/apiSpec.ts';

export interface ImportOptions {
  /** One file per model instead of nested models in their parent's file. */
  split?: boolean;
  file: string;
  /** Only operations with one of these tags (OpenAPI), folders (Postman) or hosts (HAR). */
  tags?: string[];
  /** Only these operation names. */
  only?: string[];
  /** Only paths matching one of these globs: * is one segment, ** any number. */
  paths?: string[];
  /** Only these methods. */
  methods?: string[];
  /** Import at most this many operations. */
  max?: number;
  /** Confirmed a large import (more than LARGE operations) without --max. */
  yes?: boolean;
  /** HAR: only requests under this URL. */
  baseUrl?: string;
  /** HAR: keep failed (non-2xx) responses. */
  includeErrors?: boolean;
  /** Plan the endpoints that work and report the others, instead of stopping. */
  skipConflicts?: boolean;
  /** Called before each operation is planned (progress display). */
  onProgress?: (done: number, total: number, name: string) => void;
}

export interface ImportReport {
  changeSet: ChangeSet;
  added: string[];
  existing: string[];
  skipped: { name: string; reason: string }[];
}

export interface ImportListing {
  format: string;
  title: string;
  total: number;
  operations: { name: string; method: HttpMethod; path: string; tags: string[]; source: string; response?: string }[];
  warnings: string[];
}

export const LARGE = 50;

/** Glob for API paths: * matches one segment, ** any number; {id} and :id match any parameter. */
export function pathMatches(glob: string, path: string): boolean {
  const norm = (p: string) => p.replace(/:([\w.-]+)/g, '{$1}').replace(/\/+$/, '') || '/';
  const g = norm(glob.startsWith('/') ? glob : `/${glob}`);
  const re = g
    .split('/')
    .map((seg) => (seg === '**' ? '\u0000' : seg === '*' ? '[^/]+' : /^\{[^/]+\}$/.test(seg) ? '\\{[^/]+\\}' : seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')))
    .join('/')
    .replace(/\/\u0000/g, '(?:/.*)?')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${re}$`).test(norm(path));
}

function readOperations(opts: ImportOptions): { doc: ReturnType<typeof readApiFile>; ops: ImportedOperation[] } {
  const text = readText(opts.file);
  if (text === null) throw new ToolError('no_file', `Cannot read ${opts.file}.`);
  const doc = readApiFile(text, { includeErrors: opts.includeErrors, baseUrl: opts.baseUrl });
  const wantTags = new Set((opts.tags ?? []).map((t) => t.toLowerCase()));
  const wantNames = new Set((opts.only ?? []).map((n) => n.toLowerCase()));
  const wantMethods = new Set((opts.methods ?? []).map((m) => m.toUpperCase()));
  let ops = doc.operations.filter(
    (o) =>
      (!wantTags.size || o.tags.some((t) => wantTags.has(t.toLowerCase()))) &&
      (!wantNames.size || wantNames.has(o.spec.name.toLowerCase())) &&
      (!wantMethods.size || wantMethods.has(o.spec.method)) &&
      (!opts.paths?.length || opts.paths.some((g) => pathMatches(g, o.spec.path))),
  );
  if (!ops.length) {
    const filtered = wantTags.size || wantNames.size || wantMethods.size || opts.paths?.length;
    throw new ToolError('no_endpoints', `No operations matched in ${opts.file} (${doc.operations.length} in the file).`, filtered ? 'Check the --tag, --only, --method and --path values, or see everything with --list.' : undefined);
  }
  if (opts.max !== undefined) {
    if (ops.length > opts.max) doc.warnings.push(`Importing the first ${opts.max} of ${ops.length} matching operations (--max ${opts.max}).`);
    ops = ops.slice(0, opts.max);
  }
  return { doc, ops };
}

/** --list: what the file holds after filters, without planning anything. */
export function listApiImport(opts: ImportOptions): ImportListing {
  const { doc, ops } = readOperations(opts);
  return {
    format: doc.format,
    title: doc.title,
    total: doc.operations.length,
    operations: ops.map((o) => ({ name: o.spec.name, method: o.spec.method, path: o.spec.path, tags: o.tags, source: o.source, response: o.spec.response ? (o.spec.response.kind === 'object' ? o.spec.response.model : o.spec.response.kind === 'array' && o.spec.response.item.kind === 'object' ? `${o.spec.response.item.model}[]` : o.spec.response.kind) : undefined })),
    warnings: doc.warnings,
  };
}

export async function planApiImport(root: string, adapter: Adapter, opts: ImportOptions): Promise<ImportReport> {
  if (!adapter.planEndpoint) throw new ToolError('not_supported', `api import needs a framework adapter; this project uses the ${adapter.id} adapter.`);
  const file = readText(join(root, opts.file)) !== null ? join(root, opts.file) : opts.file;
  const { doc, ops } = readOperations({ ...opts, file });
  if (ops.length > LARGE && opts.max === undefined && !opts.yes) {
    throw new ToolError('too_many_endpoints', `${ops.length} operations matched, more than ${LARGE} in one change.`, `Narrow it with --tag, --path or --method, cap it with --max <n>, or pass --yes to import all ${ops.length}. See them first with --list.`);
  }

  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  const working = structuredClone(map);
  let overlay = new Map<string, string>();
  const added: string[] = [];
  const existing: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const warnings = new Set<string>(doc.warnings);
  const generated = [];

  for (const [i, op] of ops.entries()) {
    opts.onProgress?.(i, ops.length, op.spec.name);
    try {
      const edits = await adapter.planEndpoint({ root, map: working }, op.spec, overlay);
      if (!edits.endpoints) {
        existing.push(op.spec.name);
        continue;
      }
      overlay = edits.files;
      working.endpoints.push(...edits.endpoints);
      working.models.push(...(edits.models ?? []));
      generated.push(...edits.generated);
      for (const w of edits.warnings) {
        // Per-endpoint reuse notes are noise in a bulk import.
        // Project-wide notes (a missing package, say) are shown once, not per operation.
        if (/^Reusing the existing model/.test(w)) continue;
        if (/is not in pubspec\.yaml|is not in package\.json/.test(w)) warnings.add(w);
        else warnings.add(`${op.spec.name}: ${w}`);
      }
      added.push(op.spec.name);
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
      skipped.push({ name: op.spec.name, reason: e.hint ? `${e.message} ${e.hint}` : e.message });
    }
  }
  opts.onProgress?.(ops.length, ops.length, '');

  if (skipped.length && !opts.skipConflicts) {
    throw new ToolError(
      'import_conflicts',
      `${skipped.length} of ${ops.length} operations cannot be added, so nothing was planned:\n${skipped.map((s) => `    ${s.name}: ${s.reason}`).join('\n')}`,
      `Pass --skip-conflicts to import the other ${ops.length - skipped.length}, or leave those out with --only / --path.`,
    );
  }

  const label = { openapi: 'OpenAPI', swagger: 'Swagger', postman: 'Postman', har: 'HAR' }[doc.format];
  const summary = [
    `Import ${ops.length} operation${ops.length === 1 ? '' : 's'} from "${doc.title}" (${label}): ${added.length} added, ${existing.length} already present, ${skipped.length} skipped`,
    ...added.map((n) => {
      const ep = working.endpoints.find((e) => e.name === n)!;
      return `  ${ep.method.padEnd(6)} ${ep.path}  →  ${n}()  in ${ep.file}`;
    }),
  ];
  for (const s of skipped) warnings.add(`Skipped ${s.name}: ${s.reason}`);
  if (doc.format === 'har') warnings.add('Response bodies from the HAR file were used only to work out types; none of their values were written.');
  const grouped = groupPlanned(root, overlay, generated, map, modelLangOf(adapter.id), opts.split);
  const changeSet = buildChangeSet(root, 'api import', { files: grouped.files, summary, warnings: [...warnings], generated: grouped.generated });
  return { changeSet, added, existing, skipped };
}
