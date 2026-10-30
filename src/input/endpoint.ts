// Builds the universal EndpointSpec from parsed input. Every rule here is
// framework-neutral; adapters turn the spec into code.

import { ToolError, type EndpointSpec, type HttpMethod, type InferredModel, type InferredType, type PathParam, type QueryParam } from '../core/types.ts';
import { inferModels, signature, unwrapEnvelope } from './infer.ts';
import { safeDecode } from './curl.ts';
import { checkHost, encodePathSegment } from '../core/safe.ts';
import { camel, functionName, pascal, singular, typeName } from './naming.ts';

export interface EndpointInput {
  method: HttpMethod;
  url: URL;
  body?: string;
  responseSamples: unknown[];
  requestSample?: unknown;
  /** Overrides the derived function name. */
  name?: string;
  /** Overrides the path, e.g. /users/{userId}. Must have the same number of segments. */
  path?: string;
  /** Overrides the root response model name. */
  modelName?: string;
  /** 'auto' unwraps {data: ...} envelopes; 'never' keeps them. */
  unwrap?: 'auto' | 'never';
  warnings?: string[];
}

const VERSION_SEGMENT = /^(api|v\d+(\.\d+)?|rest)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_ID = /^[0-9a-f]{24}$/i;

function isIdLike(seg: string): 'int' | 'string' | null {
  if (/^\d+$/.test(seg)) return 'int';
  if (UUID.test(seg) || OBJECT_ID.test(seg)) return 'string';
  return null;
}

interface PathAnalysis {
  path: string;
  params: PathParam[];
  /** Non-parameter segments, without version prefixes. */
  nouns: string[];
  endsWithParam: boolean;
}

export function analyzePath(rawPath: string, override?: string): PathAnalysis {
  const segs = rawPath.split('/').filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  const overrideSegs = override ? override.split('/').filter(Boolean) : null;
  if (overrideSegs && overrideSegs.length !== segs.length) {
    throw new ToolError('bad_path', `--path "${override}" has ${overrideSegs.length} segments but the URL has ${segs.length}.`);
  }
  const params: PathParam[] = [];
  const nouns: string[] = [];
  const out: string[] = [];
  const paramIndexes: number[] = [];
  segs.forEach((seg, i) => {
    const o = overrideSegs?.[i];
    const explicit = (o ?? seg).match(/^(?:\{([^/{}]+)\}|:([\w.-]+))$/);
    if (explicit) {
      paramIndexes.push(i);
      params.push({ name: camel(explicit[1] ?? explicit[2]), example: seg, type: isIdLike(seg) ?? 'string' });
      out.push(`{${camel(explicit[1] ?? explicit[2])}}`);
      return;
    }
    if (o && o !== seg) {
      throw new ToolError('bad_path', `--path segment "${o}" does not match the URL segment "${seg}".`);
    }
    const kind = overrideSegs ? null : isIdLike(seg);
    if (kind) {
      paramIndexes.push(i);
      params.push({ name: '', example: seg, type: kind });
      out.push('');
    } else {
      // Kept percent-encoded: a literal segment never carries quotes, backticks, $ or comment ends into code.
      out.push(encodePathSegment(seg));
      // Names come from the words: /config.json is "config", /user-settings is "user settings".
      const noun = seg.replace(/\.(json|xml|php|aspx?|html?|jsp|cgi|do)$/i, '');
      if (noun && (!VERSION_SEGMENT.test(seg) || nouns.length > 0)) nouns.push(noun);
    }
  });
  // Name inferred params: a parameter at the very end is "id"; any other is "<parent>Id".
  paramIndexes.forEach((segIndex, pi) => {
    const p = params[pi];
    if (p.name !== '') return;
    const prev = segIndex > 0 ? segs[segIndex - 1] : 'item';
    p.name = segIndex === segs.length - 1 ? 'id' : `${camel(singular(prev))}Id`;
    out[segIndex] = `{${p.name}}`;
  });
  const names = new Set<string>();
  for (const p of params) {
    if (names.has(p.name)) throw new ToolError('bad_path', `Two path parameters are both called "${p.name}". Use --path to name them.`);
    names.add(p.name);
  }
  return { path: '/' + out.join('/'), params, nouns, endsWithParam: paramIndexes.length > 0 && paramIndexes[paramIndexes.length - 1] === segs.length - 1 };
}

export function deriveName(method: HttpMethod, a: PathAnalysis): { name: string; target: string } {
  const nouns = a.nouns.length ? a.nouns : ['root'];
  const last = nouns[nouns.length - 1];
  const parents = nouns.slice(0, -1).map((n) => pascal(singular(n)));
  const prefix = parents.join('');
  const isPluralNoun = /s$/i.test(last) && !/(ss|us|is)$/i.test(last);
  // Action endpoints: POST /users/{id}/activate → activateUser
  if (method === 'POST' && !a.endsWithParam && !isPluralNoun && parents.length > 0) {
    return { name: camel(`${last} ${prefix}`), target: singular(nouns[nouns.length - 2]) };
  }
  const single = pascal(singular(last));
  switch (method) {
    case 'GET':
      return { name: camel(`get ${prefix} ${a.endsWithParam || !isPluralNoun ? single : pascal(last)}`), target: last };
    case 'POST':
      return { name: camel(`create ${prefix} ${single}`), target: last };
    case 'PUT':
    case 'PATCH':
      return { name: camel(`update ${prefix} ${single}`), target: last };
    case 'DELETE':
      return { name: camel(`delete ${prefix} ${single}`), target: last };
    default:
      return { name: camel(`${method.toLowerCase()} ${prefix} ${single}`), target: last };
  }
}

function queryType(value: string): InferredType {
  if (/^-?\d+$/.test(value)) return { kind: 'int' };
  if (/^-?\d*\.\d+$/.test(value)) return { kind: 'double' };
  if (/^(true|false)$/i.test(value)) return { kind: 'bool' };
  return { kind: 'string' };
}

function parseBody(body: string | undefined): unknown {
  if (body === undefined || body === '') return undefined;
  const t = body.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(t);
    } catch {
      throw new ToolError('bad_body', 'The request body in the cURL looks like JSON but does not parse.');
    }
  }
  // Form-encoded: a=1&b=two
  const obj: Record<string, string> = {};
  for (const pair of t.split('&')) {
    const eqAt = pair.indexOf('=');
    const k = eqAt === -1 ? pair : pair.slice(0, eqAt);
    const v = eqAt === -1 ? '' : pair.slice(eqAt + 1);
    if (k) obj[safeDecode(k)] = safeDecode(v);
  }
  return obj;
}

function renameIn(t: InferredType, from: string, to: string): InferredType {
  if (t.kind === 'object' && t.model === from) return { kind: 'object', model: to };
  if (t.kind === 'array') return { kind: 'array', item: renameIn(t.item, from, to) };
  return t;
}

export function buildEndpoint(input: EndpointInput): EndpointSpec {
  const warnings = [...(input.warnings ?? [])];
  if (input.url.hostname !== 'api.invalid') checkHost(input.url);
  const analysis = analyzePath(input.url.pathname, input.path);
  const derived = deriveName(input.method, analysis);
  const name = input.name ? functionName(input.name, input.method, derived.name) : derived.name;
  const resource = analysis.nouns[0] ?? 'root';

  const queryParams: QueryParam[] = [];
  for (const [k, v] of input.url.searchParams.entries()) {
    if (!queryParams.some((q) => q.name === k)) queryParams.push({ name: k, type: queryType(v) });
  }

  // Response.
  let samples = input.responseSamples;
  let unwrapData = false;
  if (input.unwrap !== 'never') {
    const inner = unwrapEnvelope(samples);
    if (inner) {
      samples = inner;
      unwrapData = true;
      warnings.push('The response is wrapped in {"data": ...}; the generated code returns the inner "data" value. Use --no-unwrap to keep the wrapper.');
    }
  }
  const rootModelName = input.modelName ? typeName(input.modelName) : typeName(singular(derived.target));
  let response: InferredType | undefined;
  const models: InferredModel[] = [];
  if (samples.length) {
    const r = inferModels(samples, rootModelName);
    response = r.root;
    models.push(...r.models);
    warnings.push(...r.warnings.map((w) => `Response: ${w.replace(/^\$/, 'root')}`));
  } else if (input.method !== 'DELETE' && input.method !== 'HEAD') {
    warnings.push('No response sample was given, so the response type is unknown. Pass --sample <file.json> or paste the response after the cURL.');
  }

  // Request.
  let request: InferredType | undefined;
  const bodySample = input.requestSample ?? parseBody(input.body);
  if (bodySample !== undefined) {
    const r = inferModels([bodySample], `${pascal(name)} Request`);
    let reqRoot = r.root;
    const reqModels = r.models;
    // Merge with response models: reuse identical shapes, rename clashes.
    for (const m of [...reqModels]) {
      const same = models.find((x) => x.name === m.name);
      if (!same) continue;
      if (signature(same.fields) === signature(m.fields)) {
        reqModels.splice(reqModels.indexOf(m), 1);
      } else {
        const to = `${m.name}Input`;
        for (const other of reqModels) other.fields = other.fields.map((f) => ({ ...f, type: renameIn(f.type, m.name, to) }));
        reqRoot = renameIn(reqRoot, m.name, to);
        m.name = to;
      }
    }
    request = reqRoot;
    models.push(...reqModels);
    warnings.push(...r.warnings.map((w) => `Request: ${w.replace(/^\$/, 'body')}`));
  }

  return {
    name,
    method: input.method,
    origin: input.url.hostname === 'api.invalid' ? '' : input.url.origin,
    path: analysis.path,
    resource,
    pathParams: analysis.params,
    queryParams,
    response,
    unwrapData,
    request,
    models,
    warnings,
  };
}
