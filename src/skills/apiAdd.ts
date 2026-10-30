// api add: cURL / URL / JSON samples → model, function and registration, as a change set.

import { join } from 'node:path';
import { loadMap } from '../core/cache.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { loadConfig } from '../core/config.ts';
import { hash, readText } from '../core/fsutil.ts';
import { ToolError, type Adapter, type ChangeSet, type EndpointSpec, type HttpMethod } from '../core/types.ts';
import { METHODS, parseCurl, parseUrl, stripSecretQuery } from '../input/curl.ts';
import { buildEndpoint } from '../input/endpoint.ts';
import { detectPaste } from '../input/paste.ts';

export interface ApiAddOptions {
  curl?: string;
  url?: string;
  method?: string;
  samples?: string[];
  requestSample?: string;
  paste?: string;
  name?: string;
  path?: string;
  modelName?: string;
  noUnwrap?: boolean;
  /** Also call the new endpoint from this module's controller (GetX). */
  into?: string;
  noLoad?: boolean;
}

function readSample(root: string, file: string): unknown {
  const text = readText(join(root, file)) ?? readText(file);
  if (text === null) throw new ToolError('no_sample', `Cannot read the sample file ${file}.`);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ToolError('bad_sample', `${file} is not valid JSON: ${(e as Error).message}`);
  }
}

export function specFromInput(root: string, opts: ApiAddOptions): EndpointSpec {
  const warnings: string[] = [];
  let curl = opts.curl;
  let url = opts.url;
  const responseSamples: unknown[] = (opts.samples ?? []).map((f) => readSample(root, f));
  let requestSample = opts.requestSample ? readSample(root, opts.requestSample) : undefined;

  if (opts.paste) {
    const p = detectPaste(opts.paste);
    curl ??= p.curl;
    url ??= p.url;
    responseSamples.push(...p.responseSamples);
    requestSample ??= p.requestSample;
  }

  if (opts.method !== undefined && !METHODS.includes(opts.method.toUpperCase() as HttpMethod)) {
    throw new ToolError('bad_method', `"${opts.method}" is not an HTTP method.`, `Use one of: ${METHODS.join(', ')}.`);
  }
  let method: HttpMethod;
  let parsedUrl: URL;
  let body: string | undefined;
  if (curl) {
    const r = parseCurl(curl);
    method = opts.method ? (opts.method.toUpperCase() as HttpMethod) : r.method;
    parsedUrl = r.url;
    body = r.body;
    if (r.removedSecrets.length) warnings.push(`Removed from the input and never written anywhere: ${r.removedSecrets.join(', ')}. Use your project's auth mechanism for these.`);
    warnings.push(...r.notes);
    if (r.ignoredHeaders.length) warnings.push(`These headers were not added to the code: ${r.ignoredHeaders.join(', ')}. Add them in your request helper if every call needs them.`);
  } else if (url) {
    const m = url.trim().match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i);
    method = (opts.method ?? m?.[1] ?? 'GET').toUpperCase() as HttpMethod;
    parsedUrl = parseUrl(m ? m[2] : url);
    const removed: string[] = [];
    stripSecretQuery(parsedUrl, removed);
    if (removed.length) warnings.push(`Removed from the input and never written anywhere: ${removed.join(', ')}.`);
  } else {
    throw new ToolError('no_input', 'No endpoint was given.', 'Pass --curl "<command>", --url <url>, or paste a cURL command (optionally followed by the response JSON) on standard input.');
  }

  return buildEndpoint({
    method,
    url: parsedUrl,
    body,
    responseSamples,
    requestSample,
    name: opts.name,
    path: opts.path,
    modelName: opts.modelName,
    unwrap: opts.noUnwrap ? 'never' : 'auto',
    warnings,
  });
}

export async function planApiAdd(root: string, adapter: Adapter, opts: ApiAddOptions): Promise<{ changeSet: ChangeSet; spec: EndpointSpec }> {
  if (!adapter.capabilities.apiAdd || !adapter.planEndpoint) {
    throw new ToolError('not_supported', `api add needs a framework adapter; this project uses the ${adapter.id} adapter.`, 'Supported setups: Next.js (App Router, fetch) and Flutter (Dio).');
  }
  const spec = specFromInput(root, opts);
  const cfg = loadConfig(root);
  const { map } = await loadMap(root, adapter, cfg.conventions);
  let edits = await adapter.planEndpoint({ root, map }, spec);
  const inputHash = hash(JSON.stringify({ m: spec.method, p: spec.path, r: spec.response, q: spec.request }));
  edits.generated = edits.generated.map((g) => ({ ...g, inputHash }));
  if (opts.into) {
    if (!adapter.planWire) throw new ToolError('not_supported', `--into is not available for the ${adapter.id} adapter yet.`, 'Supported: Flutter with GetX.');
    // The endpoint may only exist in this plan so far; describe it to the wiring step.
    const existing = map.endpoints.find((e) => e.name === spec.name);
    const file = existing?.file ?? edits.generated[0]?.file;
    const planned = existing ? map : { ...map, endpoints: [...map.endpoints, { name: spec.name, method: spec.method, path: spec.path, file, calledFrom: [] }] };
    const wire = adapter.planWire({ root, map: planned }, { endpoint: spec.name, module: opts.into, noLoad: opts.noLoad }, edits.files);
    edits = { files: wire.files, summary: [...edits.summary, ...wire.summary], warnings: [...edits.warnings, ...wire.warnings], generated: [...edits.generated, ...wire.generated] };
  }
  const changeSet = buildChangeSet(root, 'api add', edits);
  return { changeSet, spec };
}
