// Reads API description files and turns every operation into the same
// EndpointSpec that `api add` builds from a cURL command.
//
//   OpenAPI 3.x   schemas become models directly (components and inline)
//   Swagger 2.0   the same, from definitions
//   Postman 2.x   requests plus their saved example responses (as samples)

import { parseYamlDocument } from '../core/yamlDoc.ts';
import { ToolError, type EndpointSpec, type HttpMethod, type InferredField, type InferredModel, type InferredType, type PathParam, type QueryParam } from '../core/types.ts';
import { stripSecretQuery } from './curl.ts';
import { analyzePath, buildEndpoint, deriveName } from './endpoint.ts';
import { signature } from './infer.ts';
import { isHar, readHar } from './har.ts';
import { camel, functionName, pascal, singular, typeName } from './naming.ts';

export interface ImportedOperation {
  spec: EndpointSpec;
  tags: string[];
  /** Where it came from, for messages: "GET /users/{id}" or a Postman item name. */
  source: string;
}

export interface ImportResult {
  format: 'openapi' | 'swagger' | 'postman' | 'har';
  title: string;
  operations: ImportedOperation[];
  warnings: string[];
}

type Json = Record<string, unknown>;
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

export function readApiFile(text: string, opts: { includeErrors?: boolean; baseUrl?: string } = {}): ImportResult {
  let doc: unknown;
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      doc = JSON.parse(t);
    } catch (e) {
      throw new ToolError('bad_spec', `The file looks like JSON but does not parse: ${(e as Error).message}`);
    }
  } else {
    doc = parseYamlDocument(text);
  }
  if (!isObj(doc)) throw new ToolError('bad_spec', 'The file is not an OpenAPI, Swagger or Postman document.');
  if (isHar(doc)) return readHar(doc as Parameters<typeof readHar>[0], opts);
  if (typeof doc.openapi === 'string') return readOpenApi(doc, 'openapi');
  if (doc.swagger === '2.0' || doc.swagger === 2) return readOpenApi(doc, 'swagger');
  if (isObj(doc.info) && Array.isArray(doc.item)) return readPostman(doc);
  throw new ToolError('bad_spec', 'Could not tell what this file is.', 'Supported: OpenAPI 3.x and Swagger 2.0 (JSON or YAML), Postman collections (v2.0 or v2.1 JSON) and HAR files from browser DevTools.');
}

// ---------------- OpenAPI / Swagger ----------------

class SchemaConverter {
  models = new Map<string, InferredModel>();
  order: string[] = [];
  private refNames = new Map<string, string>();
  private inProgress = new Set<string>();
  warnings: string[] = [];
  private doc: Json;
  constructor(doc: Json) {
    this.doc = doc;
  }

  private resolve(ref: string): { name: string; schema: Json } | null {
    if (!ref.startsWith('#/')) {
      this.warnings.push(`External reference ${ref} is not supported; its type is unknown.`);
      return null;
    }
    let cur: unknown = this.doc;
    for (const part of ref.slice(2).split('/')) cur = isObj(cur) ? cur[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
    if (!isObj(cur)) {
      this.warnings.push(`Reference ${ref} was not found; its type is unknown.`);
      return null;
    }
    return { name: ref.split('/').pop()!, schema: cur };
  }

  private uniqueName(base: string): string {
    let name = typeName(base);
    if (!this.models.has(name) && !this.inProgress.has(name)) return name;
    let n = 2;
    while (this.models.has(`${name}${n}`) || this.inProgress.has(`${name}${n}`)) n++;
    return `${name}${n}`;
  }

  /** Converts a schema; `nameHint` names inline object models. Returns the type and whether it is nullable. */
  type(schema: unknown, nameHint: string): { type: InferredType; nullable: boolean } {
    if (!isObj(schema)) return { type: { kind: 'unknown' }, nullable: true };
    if (typeof schema.$ref === 'string') {
      const ref = schema.$ref;
      const known = this.refNames.get(ref);
      if (known) return { type: { kind: 'object', model: known }, nullable: false };
      const r = this.resolve(ref);
      if (!r) return { type: { kind: 'unknown' }, nullable: true };
      const target = Array.isArray(r.schema.allOf) && (r.schema.allOf as unknown[]).length > 1 ? this.mergeAllOf(r.schema.allOf as unknown[]) : r.schema;
      // A referenced schema that is not an object (an enum, a string alias) is inlined.
      if (!this.isObjectSchema(target)) return this.type(target, r.name);
      const name = this.uniqueName(r.name);
      this.refNames.set(ref, name);
      this.objectModel(target, name, false);
      return { type: { kind: 'object', model: name }, nullable: !!r.schema.nullable };
    }
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : schema.type ? [String(schema.type)] : [];
    const nullable = !!schema.nullable || types.includes('null') || schema['x-nullable'] === true;
    const t = types.filter((x) => x !== 'null')[0];
    for (const key of ['oneOf', 'anyOf'] as const) {
      if (Array.isArray(schema[key])) {
        const opts = (schema[key] as unknown[]).filter((o) => !(isObj(o) && o.type === 'null'));
        if (opts.length === 1) {
          const inner = this.type(opts[0], nameHint);
          return { type: inner.type, nullable: true };
        }
        this.warnings.push(`${nameHint} uses ${key} with several options; its type is unknown.`);
        return { type: { kind: 'unknown' }, nullable: true };
      }
    }
    if (Array.isArray(schema.allOf)) {
      const parts = schema.allOf as unknown[];
      if (parts.length === 1) return this.type(parts[0], nameHint);
      const merged = this.mergeAllOf(parts);
      return { type: { kind: 'object', model: this.objectModel(merged, this.uniqueName(singular(pascal(nameHint))), true) }, nullable };
    }
    if (t === 'array' || schema.items) {
      const item = this.type(schema.items, singular(nameHint) === nameHint ? `${nameHint} Item` : singular(nameHint));
      return { type: { kind: 'array', item: item.type }, nullable };
    }
    if (this.isObjectSchema(schema)) {
      if (!isObj(schema.properties) || Object.keys(schema.properties).length === 0) return { type: { kind: 'unknown' }, nullable };
      return { type: { kind: 'object', model: this.objectModel(schema, this.uniqueName(singular(pascal(nameHint))), true) }, nullable };
    }
    if (t === 'string') return { type: { kind: schema.format === 'date-time' || schema.format === 'date' ? 'date' : 'string' }, nullable };
    if (t === 'integer') return { type: { kind: 'int' }, nullable };
    if (t === 'number') return { type: { kind: 'double' }, nullable };
    if (t === 'boolean') return { type: { kind: 'bool' }, nullable };
    return { type: { kind: 'unknown' }, nullable: true };
  }

  /** Merges allOf parts (resolving references, including nested allOf) into one object schema. */
  private mergeAllOf(parts: unknown[], depth = 0): Json {
    const merged: Json = { type: 'object', properties: {}, required: [] };
    for (const part of parts) {
      let p = isObj(part) && typeof part.$ref === 'string' ? this.resolve(part.$ref)?.schema : part;
      if (isObj(p) && Array.isArray(p.allOf) && depth < 5) p = this.mergeAllOf(p.allOf as unknown[], depth + 1);
      if (!isObj(p)) continue;
      Object.assign(merged.properties as Json, p.properties ?? {});
      (merged.required as string[]).push(...((p.required as string[]) ?? []));
    }
    return merged;
  }

  private isObjectSchema(s: Json): boolean {
    return s.type === 'object' || isObj(s.properties) || (Array.isArray(s.type) && (s.type as string[]).includes('object'));
  }

  /** `inline` models may merge into an identical earlier model; named (component) models never do. */
  private objectModel(schema: Json, name: string, inline: boolean): string {
    if (this.models.has(name) || this.inProgress.has(name)) return name;
    this.inProgress.add(name);
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    const fields: InferredField[] = [];
    for (const [key, prop] of Object.entries(isObj(schema.properties) ? schema.properties : {})) {
      const generic = ['item', 'data', 'detail', 'info', 'meta', 'value', 'result', 'attribute', 'entry', 'option', 'setting'].includes(singular(key.toLowerCase()));
      const hint = generic ? `${name} ${key}` : key;
      const { type, nullable } = this.type(prop, hint);
      fields.push({ jsonName: key, type, nullable: nullable || !required.has(key) });
    }
    this.inProgress.delete(name);
    // Identical inline shapes share one model.
    const sig = signature(fields);
    if (inline) for (const [other, m] of this.models) if (other !== name && signature(m.fields) === sig) return other;
    this.models.set(name, { name, fields });
    this.order.push(name);
    return name;
  }

  /** Models needed by the given types, dependencies first. */
  modelsFor(types: (InferredType | undefined)[]): InferredModel[] {
    const need = new Set<string>();
    const visit = (t?: InferredType) => {
      if (!t) return;
      if (t.kind === 'array') return visit(t.item);
      if (t.kind !== 'object' || need.has(t.model)) return;
      need.add(t.model);
      for (const f of this.models.get(t.model)?.fields ?? []) visit(f.type);
    };
    types.forEach(visit);
    return this.order.filter((n) => need.has(n)).map((n) => structuredClone(this.models.get(n)!));
  }
}

function serverBase(doc: Json, format: 'openapi' | 'swagger'): { origin: string; prefix: string } {
  let url = '';
  if (format === 'openapi' && Array.isArray(doc.servers) && isObj(doc.servers[0])) {
    url = String(doc.servers[0].url ?? '');
    const vars = isObj(doc.servers[0].variables) ? doc.servers[0].variables : {};
    url = url.replace(/\{([^/{}]+)\}/g, (_m, v: string) => String(isObj(vars[v]) ? (vars[v] as Json).default ?? '' : ''));
  } else if (format === 'swagger') {
    const scheme = Array.isArray(doc.schemes) && doc.schemes.length ? String(doc.schemes.includes('https') ? 'https' : doc.schemes[0]) : 'https';
    url = doc.host ? `${scheme}://${doc.host}${doc.basePath ?? ''}` : String(doc.basePath ?? '');
  }
  if (/^https?:\/\//.test(url)) {
    try {
      const u = new URL(url);
      // A host with quotes, backticks or $ is never written into code: treat the paths as relative instead.
      if (!/^[A-Za-z0-9.-]+$|^\[[0-9A-Fa-f:.]+\]$/.test(u.hostname)) return { origin: '', prefix: '' };
      return { origin: u.origin, prefix: u.pathname.replace(/\/$/, '') };
    } catch {
      // A server URL that is not a URL: treat the paths as relative.
      return { origin: '', prefix: '' };
    }
  }
  return { origin: '', prefix: url.replace(/\/$/, '') };
}

function jsonContent(content: unknown): unknown {
  if (!isObj(content)) return undefined;
  const key = Object.keys(content).find((k) => /json/.test(k)) ?? Object.keys(content).find((k) => k === '*/*');
  return key && isObj(content[key]) ? (content[key] as Json).schema : undefined;
}

function readOpenApi(doc: Json, format: 'openapi' | 'swagger'): ImportResult {
  const conv = new SchemaConverter(doc);
  const warnings: string[] = [];
  const { origin, prefix } = serverBase(doc, format);
  const operations: ImportedOperation[] = [];
  const usedNames = new Set<string>();
  const paths = isObj(doc.paths) ? doc.paths : {};
  for (const [rawPath, item] of Object.entries(paths)) {
    if (!isObj(item)) continue;
    const shared = Array.isArray(item.parameters) ? (item.parameters as unknown[]) : [];
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      const source = `${method.toUpperCase()} ${rawPath}`;
      const params = [...shared, ...(Array.isArray(op.parameters) ? (op.parameters as unknown[]) : [])]
        .map((p) => (isObj(p) && typeof p.$ref === 'string' ? (() => {
          let cur: unknown = doc;
          for (const part of (p.$ref as string).slice(2).split('/')) cur = isObj(cur) ? cur[part] : undefined;
          return cur;
        })() : p))
        .filter(isObj);
      const fullPath = `${prefix}${rawPath}`;
      const analysis = analyzePath(fullPath.replace(/\{([^/{}]+)\}/g, ':$1'));
      const derived = deriveName(method.toUpperCase() as HttpMethod, analysis).name;
      let name = typeof op.operationId === 'string' && op.operationId ? functionName(op.operationId, method, derived) : derived;
      if (usedNames.has(name)) {
        let n = 2;
        while (usedNames.has(`${name}${n}`)) n++;
        warnings.push(`${source}: the name ${name} is used twice; this one is ${name}${n}.`);
        name = `${name}${n}`;
      }
      usedNames.add(name);

      const pathParams: PathParam[] = analysis.params.map((pp) => {
        const decl = params.find((p) => p.in === 'path' && camel(String(p.name)) === pp.name);
        const schema = isObj(decl?.schema) ? decl!.schema : decl;
        const kind = isObj(schema) && (schema.type === 'integer' || schema.type === 'number') ? 'int' : 'string';
        return { name: pp.name, example: '', type: kind };
      });
      const queryParams: QueryParam[] = params
        .filter((p) => p.in === 'query' && typeof p.name === 'string')
        .map((p) => ({ name: String(p.name), type: conv.type(isObj(p.schema) ? p.schema : p, String(p.name)).type }))
        .filter((q) => q.type.kind !== 'object' && q.type.kind !== 'array');
      const base = pascal(name);

      // Request body.
      let requestSchema: unknown;
      if (format === 'openapi' && isObj(op.requestBody)) {
        const rb = typeof (op.requestBody as Json).$ref === 'string' ? undefined : op.requestBody;
        requestSchema = jsonContent((rb as Json | undefined)?.content);
        if (!requestSchema && isObj((op.requestBody as Json).content)) warnings.push(`${source}: the request body is not JSON (for example a file upload); add it by hand.`);
      } else if (format === 'swagger') {
        requestSchema = params.find((p) => p.in === 'body')?.schema;
        if (params.some((p) => p.in === 'formData')) warnings.push(`${source}: form data parameters are not generated; add them by hand.`);
      }
      const request = requestSchema ? conv.type(requestSchema, `${base} Request`).type : undefined;

      // Response: the first 2xx with JSON.
      const responses = isObj(op.responses) ? op.responses : {};
      const okKey = Object.keys(responses).sort().find((k) => /^2\d\d$|^2XX$/i.test(k)) ?? (responses.default ? 'default' : undefined);
      let responseSchema: unknown;
      if (okKey && isObj(responses[okKey])) {
        const r = responses[okKey] as Json;
        responseSchema = format === 'openapi' ? jsonContent(r.content) : r.schema;
      }
      const resourceName = analysis.nouns[analysis.nouns.length - 1] ?? 'item';
      // A list response is named from the plural resource so its items are singular (users → User).
      const response = responseSchema ? conv.type(responseSchema, resourceName).type : undefined;

      const spec: EndpointSpec = {
        name,
        method: method.toUpperCase() as HttpMethod,
        origin,
        serverPrefix: prefix,
        path: analysis.path,
        resource: analysis.nouns[0] ?? 'root',
        pathParams,
        queryParams,
        response,
        unwrapData: false,
        request,
        models: conv.modelsFor([response, request]),
        warnings: [],
      };
      operations.push({ spec, tags: Array.isArray(op.tags) ? (op.tags as string[]).map(String) : [], source });
    }
  }
  const title = isObj(doc.info) ? String(doc.info.title ?? 'API') : 'API';
  return { format, title, operations, warnings: [...warnings, ...new Set(conv.warnings)] };
}

// ---------------- Postman ----------------

interface PostmanItem {
  name?: string;
  item?: PostmanItem[];
  request?: Json | string;
  response?: Json[];
}

function readPostman(doc: Json): ImportResult {
  const vars = new Map<string, string>();
  for (const v of Array.isArray(doc.variable) ? (doc.variable as Json[]) : []) if (v.key) vars.set(String(v.key), String(v.value ?? ''));
  const warnings: string[] = [];
  const operations: ImportedOperation[] = [];
  const used = new Set<string>();

  const visit = (items: PostmanItem[], folder: string[]) => {
    for (const it of items) {
      if (Array.isArray(it.item)) {
        visit(it.item, [...folder, String(it.name ?? '')]);
        continue;
      }
      if (!it.request) continue;
      const req: Json = typeof it.request === 'string' ? { url: it.request, method: 'GET' } : it.request;
      const method = String(req.method ?? 'GET').toUpperCase() as HttpMethod;
      const urlRaw = typeof req.url === 'string' ? req.url : isObj(req.url) ? String(req.url.raw ?? '') : '';
      const source = `${it.name ?? method} (${method} ${urlRaw})`;
      // Resolve {{variables}}; an unresolved leading variable is the base URL.
      let resolved = urlRaw.replace(/\{\{(\w+)\}\}/g, (m, v: string) => vars.get(v) ?? m);
      resolved = resolved.replace(/^\{\{\w+\}\}/, '');
      if (/\{\{\w+\}\}/.test(resolved)) warnings.push(`${source}: unresolved variables were left in the URL.`);
      resolved = resolved.replace(/\{\{(\w+)\}\}/g, ':$1');
      let url: URL;
      try {
        url = new URL(/^https?:\/\//.test(resolved) ? resolved : `https://api.invalid${resolved.startsWith('/') ? '' : '/'}${resolved}`);
      } catch {
        warnings.push(`${source}: the URL could not be read, so it was skipped.`);
        continue;
      }
      stripSecretQuery(url, []);
      const body = isObj(req.body) && req.body.mode === 'raw' ? String(req.body.raw ?? '') : undefined;
      const samples: unknown[] = [];
      for (const r of it.response ?? []) {
        const code = Number(r.code ?? 200);
        if (code < 200 || code >= 300 || typeof r.body !== 'string') continue;
        try {
          samples.push(JSON.parse(r.body));
        } catch {
          // Not JSON; ignore.
        }
      }
      const nameFromItem = it.name && /[A-Za-z]/.test(it.name) ? camel(it.name) : undefined;
      let name = nameFromItem && nameFromItem.length <= 40 ? nameFromItem : undefined;
      if (name && used.has(name)) name = undefined;
      try {
        const spec = buildEndpoint({ method, url, body: body && body.trim() ? body : undefined, responseSamples: samples, name });
        if (used.has(spec.name)) {
          let n = 2;
          while (used.has(`${spec.name}${n}`)) n++;
          spec.name = `${spec.name}${n}`;
        }
        used.add(spec.name);
        if (!samples.length && method !== 'DELETE') {
          spec.warnings = spec.warnings.filter((w) => !w.startsWith('No response sample'));
          spec.warnings.push(`The collection has no saved example response, so the response type is unknown. Save an example in Postman, or run devtool api update ${spec.name} --sample <file> later.`);
        }
        operations.push({ spec, tags: folder.filter(Boolean), source });
      } catch (e) {
        warnings.push(`${source}: ${(e as Error).message}`);
      }
    }
  };
  visit(doc.item as PostmanItem[], []);
  return { format: 'postman', title: isObj(doc.info) ? String(doc.info.name ?? 'Collection') : 'Collection', operations, warnings };
}
