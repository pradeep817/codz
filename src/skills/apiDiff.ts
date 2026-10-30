// api diff <old> <new>: what changed between two versions of an API spec,
// which changes break clients, and where this project uses each one.
//
//   breaking   an operation removed; a response field removed or changed type;
//              a new path parameter; a new required request field
//   warning    a response field that can now be null; a query parameter removed;
//              a request field changed type
//   info       operations, response fields and optional request fields added
//
// Inside a devtool project each change is matched to the project's endpoint
// and the lines that use it (the endpoint's callers, and the field in those
// files and the model). Output: text, Markdown (for a pull request comment),
// JSON, or SARIF (GitHub code scanning). Exit 1 at --fail-on (default breaking).

import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadMap } from '../core/cache.ts';
import { loadConfig } from '../core/config.ts';
import { readText } from '../core/fsutil.ts';
import { ToolError, type Adapter, type EndpointInfo, type InferredModel, type InferredType } from '../core/types.ts';
import { readApiFile, type ImportedOperation } from '../input/apiSpec.ts';
import { camel } from '../input/naming.ts';
import { pathMatches } from './apiImport.ts';

export type Severity = 'breaking' | 'warning' | 'info';

export interface SpecChange {
  severity: Severity;
  kind: string;
  /** "GET /users/{id}" */
  operation: string;
  /** Operation name in the new spec (or the old one, when removed). */
  name: string;
  message: string;
  /** Where in the payload: "response.address.city", "request.email". */
  at?: string;
  /** Lines in this project that use what changed. */
  usages: { file: string; line: number; text: string }[];
  /** The project's endpoint for this operation, when there is one. */
  endpoint?: string;
}

export interface DiffReport {
  oldTitle: string;
  newTitle: string;
  changes: SpecChange[];
  counts: Record<Severity, number>;
  /** Operations compared in both files. */
  compared: number;
  /** True when usages were looked up in a project. */
  inProject: boolean;
}

/** Path with parameters blanked, without scheme and host (some adapters keep the full URL). */
const shape = (p: string) => p.replace(/^\/?[a-z]+:\/\/[^/]+/i, '').replace(/\{[^/}]+\}|:[A-Za-z_]\w*|\$\{[^}]+\}|\$[A-Za-z_]\w*/g, '{}').replace(/\/+$/, '') || '/';
const key = (o: ImportedOperation) => `${o.spec.method} ${shape(o.spec.path)}`;
const label = (o: ImportedOperation) => `${o.spec.method} ${o.spec.path}`;

function typeName(t: InferredType | undefined): string {
  if (!t) return 'nothing';
  if (t.kind === 'array') return `${typeName(t.item)}[]`;
  if (t.kind === 'object') return 'object';
  return t.kind;
}

interface Ctx {
  oldModels: Map<string, InferredModel>;
  newModels: Map<string, InferredModel>;
  out: Omit<SpecChange, 'usages' | 'operation' | 'name'>[];
  seen: Set<string>;
}

/** Response side: what a client reads. Removing or retyping breaks it; null where there was none may crash it. */
function compareResponse(o: InferredType | undefined, n: InferredType | undefined, at: string, ctx: Ctx): void {
  if (!o || !n) {
    if (o && !n) ctx.out.push({ severity: 'breaking', kind: 'response-removed', at, message: `${at} is no longer returned` });
    return;
  }
  if (o.kind !== n.kind && !(o.kind === 'int' && n.kind === 'double') && o.kind !== 'unknown' && n.kind !== 'unknown') {
    ctx.out.push({ severity: 'breaking', kind: 'type-changed', at, message: `${at} changed type: ${typeName(o)} → ${typeName(n)}` });
    return;
  }
  if (o.kind === 'array' && n.kind === 'array') return compareResponse(o.item, n.item, `${at}[]`, ctx);
  if (o.kind === 'object' && n.kind === 'object') {
    const visit = `${at}:${o.model}:${n.model}`;
    if (ctx.seen.has(visit)) return;
    ctx.seen.add(visit);
    const om = ctx.oldModels.get(o.model);
    const nm = ctx.newModels.get(n.model);
    if (!om || !nm) return;
    for (const f of om.fields) {
      const g = nm.fields.find((x) => x.jsonName === f.jsonName);
      const p = `${at}.${f.jsonName}`;
      if (!g) {
        ctx.out.push({ severity: 'breaking', kind: 'field-removed', at: p, message: `${p} was removed` });
        continue;
      }
      if (!f.nullable && g.nullable) ctx.out.push({ severity: 'warning', kind: 'became-nullable', at: p, message: `${p} can now be null` });
      compareResponse(f.type, g.type, p, ctx);
    }
    for (const g of nm.fields) if (!om.fields.some((f) => f.jsonName === g.jsonName)) ctx.out.push({ severity: 'info', kind: 'field-added', at: `${at}.${g.jsonName}`, message: `${at}.${g.jsonName} was added (${typeName(g.type)}${g.nullable ? ', optional' : ''})` });
  }
}

/** Request side: what a client sends. A new required field breaks it; a dropped field is usually ignored by servers. */
function compareRequest(o: InferredType | undefined, n: InferredType | undefined, at: string, ctx: Ctx): void {
  if (!n) return;
  if (!o) {
    ctx.out.push({ severity: 'breaking', kind: 'request-added', at, message: `${at} body is now required` });
    return;
  }
  if (o.kind !== n.kind && o.kind !== 'unknown' && n.kind !== 'unknown') {
    ctx.out.push({ severity: 'warning', kind: 'request-type-changed', at, message: `${at} changed type: ${typeName(o)} → ${typeName(n)}` });
    return;
  }
  if (o.kind === 'array' && n.kind === 'array') return compareRequest(o.item, n.item, `${at}[]`, ctx);
  if (o.kind === 'object' && n.kind === 'object') {
    const visit = `req:${at}:${o.model}:${n.model}`;
    if (ctx.seen.has(visit)) return;
    ctx.seen.add(visit);
    const om = ctx.oldModels.get(o.model);
    const nm = ctx.newModels.get(n.model);
    if (!om || !nm) return;
    for (const g of nm.fields) {
      const f = om.fields.find((x) => x.jsonName === g.jsonName);
      const p = `${at}.${g.jsonName}`;
      if (!f) {
        ctx.out.push(g.nullable ? { severity: 'info', kind: 'request-field-added', at: p, message: `${p} was added (optional)` } : { severity: 'breaking', kind: 'request-field-required', at: p, message: `${p} is new and required` });
        continue;
      }
      if (f.nullable && !g.nullable) ctx.out.push({ severity: 'breaking', kind: 'request-field-required', at: p, message: `${p} is now required` });
      compareRequest(f.type, g.type, p, ctx);
    }
    for (const f of om.fields) if (!nm.fields.some((g) => g.jsonName === f.jsonName)) ctx.out.push({ severity: 'info', kind: 'request-field-removed', at: `${at}.${f.jsonName}`, message: `${at}.${f.jsonName} is no longer accepted (servers usually ignore it)` });
  }
}

export function diffSpecs(oldText: string, newText: string, opts: { tags?: string[]; paths?: string[] } = {}): { report: Omit<DiffReport, 'inProject'>; pairs: { change: Omit<SpecChange, 'usages'>; op: ImportedOperation }[] } {
  const filter = (ops: ImportedOperation[]) => {
    const wantTags = new Set((opts.tags ?? []).map((t) => t.toLowerCase()));
    return ops.filter((o) => (!wantTags.size || o.tags.some((t) => wantTags.has(t.toLowerCase()))) && (!opts.paths?.length || opts.paths.some((g) => pathMatches(g, o.spec.path))));
  };
  const a = readApiFile(oldText);
  const b = readApiFile(newText);
  const oldOps = new Map(filter(a.operations).map((o) => [key(o), o]));
  const newOps = new Map(filter(b.operations).map((o) => [key(o), o]));
  const pairs: { change: Omit<SpecChange, 'usages'>; op: ImportedOperation }[] = [];
  let compared = 0;
  for (const [k, o] of oldOps) {
    const n = newOps.get(k);
    if (!n) {
      pairs.push({ op: o, change: { severity: 'breaking', kind: 'operation-removed', operation: label(o), name: o.spec.name, message: `${label(o)} was removed` } });
      continue;
    }
    compared++;
    const ctx: Ctx = { oldModels: new Map(o.spec.models.map((m) => [m.name, m])), newModels: new Map(n.spec.models.map((m) => [m.name, m])), out: [], seen: new Set() };
    if (n.spec.pathParams.length !== o.spec.pathParams.length) ctx.out.push({ severity: 'breaking', kind: 'path-params-changed', message: `path parameters changed: ${o.spec.pathParams.length} → ${n.spec.pathParams.length}` });
    for (const q of o.spec.queryParams) if (!n.spec.queryParams.some((x) => x.name === q.name)) ctx.out.push({ severity: 'warning', kind: 'query-removed', at: `query.${q.name}`, message: `query parameter ${q.name} was removed` });
    for (const q of n.spec.queryParams) if (!o.spec.queryParams.some((x) => x.name === q.name)) ctx.out.push({ severity: 'info', kind: 'query-added', at: `query.${q.name}`, message: `query parameter ${q.name} was added` });
    compareResponse(o.spec.response, n.spec.response, 'response', ctx);
    compareRequest(o.spec.request, n.spec.request, 'request', ctx);
    for (const c of ctx.out) pairs.push({ op: n, change: { ...c, operation: label(n), name: n.spec.name, message: `${label(n)}: ${c.message}` } });
  }
  for (const [k, n] of newOps) if (!oldOps.has(k)) pairs.push({ op: n, change: { severity: 'info', kind: 'operation-added', operation: label(n), name: n.spec.name, message: `${label(n)} was added` } });
  const order: Record<Severity, number> = { breaking: 0, warning: 1, info: 2 };
  pairs.sort((x, y) => order[x.change.severity] - order[y.change.severity] || x.change.operation.localeCompare(y.change.operation));
  const counts: Record<Severity, number> = { breaking: 0, warning: 0, info: 0 };
  for (const p of pairs) counts[p.change.severity]++;
  return { report: { oldTitle: a.title, newTitle: b.title, changes: pairs.map((p) => ({ ...p.change, usages: [] })), counts, compared }, pairs };
}

/** The project's endpoint for a spec operation: same method, same path or the same path under a prefix (/v1). */
function matchEndpoint(op: ImportedOperation, endpoints: EndpointInfo[]): EndpointInfo | undefined {
  const same = endpoints.filter((e) => e.method === op.spec.method);
  const p = shape(op.spec.path);
  return same.find((e) => shape(e.path) === p) ?? same.find((e) => p.endsWith(shape(e.path)) && shape(e.path) !== '/');
}

export async function planApiDiff(root: string | null, adapter: Adapter | null, oldFile: string, newFile: string, opts: { tags?: string[]; paths?: string[] } = {}): Promise<DiffReport> {
  const read = (f: string) => {
    const p = root && readText(join(root, f)) !== null ? join(root, f) : f;
    const t = readText(p);
    if (t === null) throw new ToolError('no_file', `Cannot read ${f}.`);
    return t;
  };
  const { report, pairs } = diffSpecs(read(oldFile), read(newFile), opts);
  if (!root || !adapter || adapter.id === 'generic') return { ...report, inProject: false };

  // Where the project uses each change.
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  const fileCache = new Map<string, string[]>();
  const lines = (f: string) => {
    if (!fileCache.has(f)) {
      try {
        fileCache.set(f, readFileSync(join(root, f), 'utf8').split('\n'));
      } catch {
        fileCache.set(f, []);
      }
    }
    return fileCache.get(f)!;
  };
  const changes = pairs.map(({ change, op }) => {
    const ep = matchEndpoint(op, map.endpoints);
    const usages: SpecChange['usages'] = [];
    if (ep) {
      const field = change.at?.split('.').pop()?.replace(/\[\]$/, '');
      const files = [...new Set([...ep.calledFrom, ...(field ? map.models.filter((m) => m.fields.some((f) => f.name === field || f.name === camel(field))).map((m) => m.file) : [])])];
      if (change.kind === 'operation-removed' || change.kind === 'path-params-changed' || change.kind === 'request-added') {
        // Every call of the function.
        for (const f of ep.calledFrom) lines(f).forEach((l, i) => new RegExp(`\\b${ep.name}\\b`).test(l) && usages.push({ file: f, line: i + 1, text: l.trim() }));
      } else if (field && /^[A-Za-z_$][\w$]*$/.test(field)) {
        const names = [...new Set([field, camel(field)])].map((n) => n.replace(/\$/g, '\\$'));
        const re = new RegExp(`(\\.(${names.join('|')})\\b|['"](${names.join('|')})['"]|\\b(?:val|var)\\s+(${names.join('|')})\\b)`);
        for (const f of files) lines(f).forEach((l, i) => re.test(l) && usages.push({ file: f, line: i + 1, text: l.trim() }));
      }
    }
    return { ...change, endpoint: ep?.name, usages: usages.slice(0, 50) };
  });
  return { ...report, changes, inProject: true };
}

// ---------- Output ----------

const ICON: Record<Severity, string> = { breaking: '✗', warning: '!', info: '+' };

export function renderDiffText(r: DiffReport): string {
  const out = [`${r.oldTitle || 'old'} → ${r.newTitle || 'new'}: ${r.counts.breaking} breaking, ${r.counts.warning} warning${r.counts.warning === 1 ? '' : 's'}, ${r.counts.info} added (${r.compared} operations in both)`];
  for (const c of r.changes) {
    out.push(`${ICON[c.severity]} ${c.message}${c.endpoint ? `  [${c.endpoint}()]` : ''}`);
    for (const u of c.usages.slice(0, 8)) out.push(`    ${u.file}:${u.line}  ${u.text.slice(0, 100)}`);
    if (c.usages.length > 8) out.push(`    … ${c.usages.length - 8} more`);
  }
  if (!r.changes.length) out.push('No differences.');
  return out.join('\n');
}

export function renderDiffMarkdown(r: DiffReport): string {
  const head = r.counts.breaking ? `### API change: ${r.counts.breaking} breaking` : '### API change: nothing breaking';
  const out = [head, '', `${r.oldTitle || 'old'} → ${r.newTitle || 'new'}: **${r.counts.breaking}** breaking, **${r.counts.warning}** warnings, **${r.counts.info}** additions.`, ''];
  const section = (sev: Severity, title: string) => {
    const list = r.changes.filter((c) => c.severity === sev);
    if (!list.length) return;
    out.push(`#### ${title}`, '');
    for (const c of list) {
      out.push(`- ${c.message.replace(/`/g, "'")}${c.endpoint ? ` (\`${c.endpoint}()\`)` : ''}`);
      for (const u of c.usages.slice(0, 5)) out.push(`  - \`${u.file}:${u.line}\``);
      if (c.usages.length > 5) out.push(`  - … ${c.usages.length - 5} more`);
    }
    out.push('');
  };
  section('breaking', 'Breaking');
  section('warning', 'Check');
  section('info', 'Added');
  if (r.inProject && r.counts.breaking) out.push('Update the app with `devtool api sync <new spec>`, then fix the lines listed above.');
  return `${out.join('\n').trim()}\n`;
}

export function renderDiffSarif(r: DiffReport, root: string | null): string {
  const level = (s: Severity) => (s === 'breaking' ? 'error' : s === 'warning' ? 'warning' : 'note');
  const results = r.changes.flatMap((c) => {
    const base = { ruleId: `api/${c.kind}`, level: level(c.severity), message: { text: c.message } };
    if (!c.usages.length) return c.severity === 'info' ? [] : [base];
    return c.usages.map((u) => ({ ...base, locations: [{ physicalLocation: { artifactLocation: { uri: root ? relative(root, join(root, u.file)).split('\\').join('/') : u.file }, region: { startLine: u.line } } }] }));
  });
  const kinds = [...new Set(r.changes.map((c) => c.kind))];
  return `${JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [{ tool: { driver: { name: 'devtool api diff', informationUri: 'https://github.com/', rules: kinds.map((k) => ({ id: `api/${k}`, shortDescription: { text: k.replace(/-/g, ' ') } })) } }, results }],
    },
    null,
    2,
  )}\n`;
}

/** Exit code for --fail-on. */
export function diffFails(r: DiffReport, failOn: string): boolean {
  if (failOn === 'none') return false;
  if (failOn === 'any') return r.changes.length > 0;
  if (failOn === 'warning') return r.counts.breaking + r.counts.warning > 0;
  return r.counts.breaking > 0;
}
