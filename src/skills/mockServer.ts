// mock serve: a local fake API so new screens show data before the backend exists.
//
// It answers every endpoint the project knows (or every operation in an
// OpenAPI / Swagger / Postman file) with sample data built from the response
// models, the same readable values mock add and test add use. Lists and items
// that share a path behave like a small in-memory database, so a create form
// adds a row the list then shows, an edit form changes it and delete removes
// it; restarting the server resets the data. Paths match by their trailing
// segments, so /v1/products and /products both reach GET /products.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { readText } from '../core/fsutil.ts';
import { ToolError, type HttpMethod, type InferredModel, type InferredType, type ModelInfo, type ProjectMap } from '../core/types.ts';
import { readApiFile } from '../input/apiSpec.ts';
import { findDeclaration } from './apiEdit.ts';
import { exampleFor, unwrapsData } from './mock.ts';

export interface MockRoute {
  method: HttpMethod;
  /** Path template with {param} placeholders. */
  path: string;
  /** Response type as written in code: Product, Product[], List<Product>, or '' for no body. */
  response: string;
  /** The response is wrapped in {"data": ...}. */
  envelope: boolean;
}

export interface MockApi {
  routes: MockRoute[];
  models: ModelInfo[];
  /** Where the routes came from, for the start-up message. */
  source: string;
}

// ------------------------------------------------------------ building the API

const typeOf = (t: InferredType | undefined): string => {
  if (!t) return '';
  switch (t.kind) {
    case 'string':
      return 'string';
    case 'date':
      return 'DateTime';
    case 'int':
      return 'int';
    case 'double':
      return 'double';
    case 'bool':
      return 'bool';
    case 'array':
      return `${typeOf(t.item) || 'string'}[]`;
    case 'object':
      return t.model;
    default:
      return '';
  }
};

const modelOf = (m: InferredModel): ModelInfo => ({ name: m.name, file: '', fields: m.fields.map((f) => ({ name: f.jsonName, type: typeOf(f.type) || 'string', nullable: f.nullable })) });

/** Routes from an OpenAPI, Swagger, Postman or HAR file. */
export function mockApiFromSpec(file: string): MockApi {
  const text = readText(file);
  if (text === null) throw new ToolError('no_file', `Cannot read ${file}.`, 'Give the path to an OpenAPI, Swagger, Postman or HAR file.');
  const r = readApiFile(text);
  const models = new Map<string, ModelInfo>();
  const routes: MockRoute[] = [];
  for (const op of r.operations) {
    for (const m of op.spec.models) if (!models.has(m.name)) models.set(m.name, modelOf(m));
    routes.push({ method: op.spec.method, path: op.spec.path, response: typeOf(op.spec.response), envelope: op.spec.unwrapData });
  }
  if (!routes.length) throw new ToolError('no_endpoints', `${file} has no operations to mock.`);
  return { routes, models: [...models.values()], source: `${file} (${r.title || r.format})` };
}

/** Routes from the endpoints and models codz found in the project. */
export function mockApiFromProject(root: string, map: ProjectMap, lang: 'ts' | 'dart' | 'kt' | 'swift'): MockApi {
  if (!map.endpoints.length) throw new ToolError('no_endpoints', 'This project has no endpoints yet, so there is nothing to mock.', 'Add some first (codz feature add <name> --spec api.yaml, or codz api add), or serve a spec directly: codz mock serve --spec api.yaml');
  const routes = map.endpoints.map((ep): MockRoute => {
    const response = (ep.response ?? '').replace(/^Promise<(.*)>$/, '$1').replace(/^(Future|Deferred)<(.*)>$/, '$2').replace(/^Response<(.*)>$/, '$1');
    let envelope = false;
    if (lang === 'ts' || lang === 'dart') {
      const text = readText(join(root, ep.file)) ?? '';
      const decl = findDeclaration(text, ep.name, lang);
      envelope = !!decl && unwrapsData(text.slice(decl.start, decl.end), map.conventions);
    }
    return { method: ep.method, path: ep.path.replace(/^https?:\/\/[^/]+/, ''), response: /^(void|Unit|unknown|dynamic)$/.test(response) ? '' : response, envelope };
  });
  return { routes, models: map.models, source: `the project's ${routes.length} endpoint${routes.length === 1 ? '' : 's'}` };
}

// ------------------------------------------------------------ the server

/** How the mock answers, to check each state of a screen. */
export const SCENARIOS = ['normal', 'empty', 'error', 'unauthorized', 'slow', 'offline'] as const;
export type Scenario = (typeof SCENARIOS)[number];
export const SCENARIO_HELP: Record<Scenario, string> = {
  normal: 'sample data',
  empty: 'lists come back empty (and their items 404)',
  error: 'every request fails with 500',
  unauthorized: 'every request fails with 401 (signed out)',
  slow: 'answers take 3 seconds',
  offline: 'the connection drops (a network error in the app)',
};

export interface LogEntry {
  id: number;
  time: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  scenario: Scenario;
  request?: unknown;
  response?: unknown;
}

export interface MockServerOptions {
  /** Start in this scenario (default normal). */
  scenario?: Scenario;
  port?: number;
  /** 127.0.0.1 (this computer, emulators and simulators) unless --lan asks for 0.0.0.0. */
  host?: string;
  /** Milliseconds before each answer, so loading states show (default 300). */
  delay?: number;
  /** Items in each list to start with (default 5). */
  items?: number;
  log?: (line: string) => void;
}

const segments = (p: string) => p.split('?')[0].split('/').filter(Boolean);
const isParam = (s: string) => /^\{[^/{}]+\}$/.test(s) || /^:\w+$/.test(s);
const listItemType = (t: string) => /^List<(.+)>$/.exec(t)?.[1] ?? /^(.+)\[\]$/.exec(t)?.[1] ?? /^Array<(.+)>$/.exec(t)?.[1];

interface Match {
  route: MockRoute;
  params: Record<string, string>;
}

/**
 * The route that matches the request path, comparing from the end: the extra
 * leading segments on either side (/v1, /api) are ignored. More matching
 * literal segments win; then the closer length.
 */
export function matchRoute(routes: MockRoute[], method: string, path: string): Match | null {
  const got = segments(path).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  let best: { m: Match; score: number } | null = null;
  for (const route of routes) {
    if (route.method !== method) continue;
    const want = segments(route.path);
    const n = Math.min(want.length, got.length);
    // Never match on parameters alone (GET /{id} for every path), and keep the item/collection difference.
    if (n === 0 || (got.length < want.length && isParam(want[want.length - n - 1] ?? ''))) continue;
    const w = want.slice(want.length - n);
    const g = got.slice(got.length - n);
    const params: Record<string, string> = {};
    let literals = 0;
    const ok = w.every((s, i) => {
      if (isParam(s)) {
        params[s.replace(/^\{|\}$|^:/g, '')] = g[i];
        return true;
      }
      if (s !== g[i]) return false;
      literals++;
      return true;
    });
    if (!ok || literals === 0) continue;
    const score = literals * 100 - Math.abs(want.length - got.length);
    if (!best || score > best.score) best = { m: { route, params }, score };
  }
  return best?.m ?? null;
}

interface Collection {
  model: string;
  idField: string | null;
  items: Record<string, unknown>[];
  nextId: number;
}

/** A running mock API: start() it, then stop() it. */
export class MockServer {
  readonly api: MockApi;
  private readonly opts: Required<Omit<MockServerOptions, 'log' | 'scenario'>> & { log: (line: string) => void };
  private readonly map: ProjectMap;
  private readonly collections = new Map<string, Collection>();
  private server: Server | null = null;
  /** The scenario for every route, and per-route overrides ("GET /v1/products"). */
  scenario: Scenario;
  readonly overrides = new Map<string, Scenario>();
  /** The last requests, newest last. */
  readonly logEntries: LogEntry[] = [];
  private nextLogId = 1;

  constructor(api: MockApi, opts: MockServerOptions = {}) {
    this.api = api;
    this.opts = { port: opts.port ?? 4010, host: opts.host ?? '127.0.0.1', delay: opts.delay ?? 300, items: opts.items ?? 5, log: opts.log ?? (() => {}) };
    this.map = { models: api.models, endpoints: [], conventions: {} } as unknown as ProjectMap;
    this.scenario = opts.scenario ?? 'normal';
  }

  /** The scenario a request gets: its route's override, else the global one. */
  scenarioFor(route: MockRoute | null): Scenario {
    return (route && this.overrides.get(`${route.method} ${route.path}`)) || this.scenario;
  }

  setScenario(scenario: Scenario, route?: string): void {
    if (!SCENARIOS.includes(scenario)) throw new ToolError('bad_args', `Unknown scenario "${scenario}". Choose: ${SCENARIOS.join(', ')}.`);
    if (!route) return void (this.scenario = scenario);
    if (!this.api.routes.some((r) => `${r.method} ${r.path}` === route)) throw new ToolError('bad_args', `No route "${route}".`);
    if (scenario === this.scenario) this.overrides.delete(route);
    else this.overrides.set(route, scenario);
  }

  /** Back to the starting data, scenario and an empty log. */
  reset(): void {
    this.collections.clear();
    this.scenario = 'normal';
    this.overrides.clear();
    this.logEntries.length = 0;
  }

  /** The collection a route belongs to: GET /products and GET|PUT|DELETE /products/{id} share one. */
  private collectionFor(route: MockRoute): { key: string; col: Collection } | null {
    const segs = segments(route.path);
    const itemRoute = segs.length > 0 && isParam(segs[segs.length - 1]);
    const key = (itemRoute ? segs.slice(0, -1) : segs).join('/');
    let col = this.collections.get(key);
    if (!col) {
      // Its item model: the list a GET on the collection returns, else what the item routes return.
      const listRoute = this.api.routes.find((r) => r.method === 'GET' && segments(r.path).join('/') === key && listItemType(r.response));
      const itemGet = this.api.routes.find((r) => r.method === 'GET' && segments(r.path).slice(0, -1).join('/') === key && isParam(segments(r.path).at(-1) ?? '') && r.response && !listItemType(r.response));
      const model = (listRoute && listItemType(listRoute.response)) || itemGet?.response;
      if (!model || !this.api.models.some((m) => m.name === model)) return null;
      const fields = this.api.models.find((m) => m.name === model)!.fields;
      const idField = fields.find((f) => f.name === 'id')?.name ?? fields.find((f) => /(^|_)id$|Id$/.test(f.name))?.name ?? null;
      const items = Array.from({ length: this.opts.items }, (_, i) => this.sample(model, i + 1, idField));
      col = { model, idField, items, nextId: this.opts.items + 1 };
      this.collections.set(key, col);
    }
    return { key, col };
  }

  private sample(model: string, index: number, idField: string | null): Record<string, unknown> {
    const value = vary(exampleFor(model, this.map, '', 0, index), index) as Record<string, unknown>;
    if (idField && value && typeof value === 'object') {
      const f = this.api.models.find((m) => m.name === model)?.fields.find((x) => x.name === idField);
      value[idField] = f && /string/i.test(f.type) ? String(index) : index;
    }
    return value;
  }

  /** The answer to one request: status and JSON body (undefined for no body). */
  handle(method: string, path: string, body: unknown): { status: number; body?: unknown } {
    const m = matchRoute(this.api.routes, method, path);
    const scenario = this.scenarioFor(m?.route ?? null);
    if (m && scenario === 'error') return { status: 500, body: { error: 'Internal server error (codz mock scenario: error)' } };
    if (m && scenario === 'unauthorized') return { status: 401, body: { error: 'Unauthorized (codz mock scenario: unauthorized)' } };
    if (!m) return { status: 404, body: { error: `No mock for ${method} ${segments(path).length ? '/' + segments(path).join('/') : '/'}`, routes: this.api.routes.map((r) => `${r.method} ${r.path}`) } };
    const { route, params } = m;
    const wrap = (v: unknown) => (route.envelope ? { data: v } : v);
    const segs = segments(route.path);
    const last = segs.at(-1) ?? '';
    const itemRoute = isParam(last);
    const id = itemRoute ? params[last.replace(/^\{|\}$|^:/g, '')] : undefined;
    const c = this.collectionFor(route);
    const input = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    if (c) {
      const { col } = c;
      const find = () => col.items.findIndex((it) => col.idField && String(it[col.idField]) === id);
      if (method === 'GET' && !itemRoute && listItemType(route.response)) return { status: 200, body: wrap(scenario === 'empty' ? [] : col.items) };
      if (method === 'GET' && itemRoute && route.response === col.model) {
        if (scenario === 'empty') return { status: 404, body: { error: `No ${col.model} with ${col.idField} ${id} (codz mock scenario: empty)` } };
        const i = find();
        return i >= 0 ? { status: 200, body: wrap(col.items[i]) } : { status: 404, body: { error: `No ${col.model} with ${col.idField} ${id}` } };
      }
      if (method === 'POST' && !itemRoute) {
        const created = { ...this.sample(col.model, col.nextId, col.idField), ...input };
        if (col.idField) created[col.idField] = this.sample(col.model, col.nextId, col.idField)[col.idField];
        col.nextId++;
        col.items.push(created);
        return route.response ? { status: 201, body: wrap(route.response === col.model ? created : this.responseFor(route, input)) } : { status: 201 };
      }
      if ((method === 'PUT' || method === 'PATCH') && itemRoute) {
        const i = find();
        if (i < 0) return { status: 404, body: { error: `No ${col.model} with ${col.idField} ${id}` } };
        col.items[i] = method === 'PUT' ? { ...this.sample(col.model, i + 1, col.idField), ...input, ...(col.idField ? { [col.idField]: col.items[i][col.idField] } : {}) } : { ...col.items[i], ...input, ...(col.idField ? { [col.idField]: col.items[i][col.idField] } : {}) };
        return route.response ? { status: 200, body: wrap(route.response === col.model ? col.items[i] : this.responseFor(route, input)) } : { status: 204 };
      }
      if (method === 'DELETE' && itemRoute) {
        const i = find();
        if (i < 0) return { status: 404, body: { error: `No ${col.model} with ${col.idField} ${id}` } };
        col.items.splice(i, 1);
        return route.response ? { status: 200, body: wrap(this.responseFor(route, input)) } : { status: 204 };
      }
    }
    // Anything else (an order's tracking, a search, an action): sample data of its response type.
    if (!route.response) return { status: method === 'POST' ? 201 : method === 'GET' ? 200 : 204, ...(method === 'GET' ? { body: wrap({}) } : {}) };
    return { status: method === 'POST' ? 201 : 200, body: wrap(this.responseFor(route, input)) };
  }

  private responseFor(route: MockRoute, input: Record<string, unknown>): unknown {
    const v = exampleFor(route.response, this.map, '', 0, 1);
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const k of Object.keys(v)) if (k in input) (v as Record<string, unknown>)[k] = input[k];
    return v;
  }

  async start(): Promise<number> {
    this.server = createServer((req, res) => void this.onRequest(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', (e: NodeJS.ErrnoException) => reject(e.code === 'EADDRINUSE' ? new ToolError('port_in_use', `Port ${this.opts.port} is already in use.`, `Stop what is using it, or pick another port: codz mock serve --port ${this.opts.port + 1}`) : e));
      this.server!.listen(this.opts.port, this.opts.host, () => resolve());
    });
    const addr = this.server.address();
    return typeof addr === 'object' && addr ? addr.port : this.opts.port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Web apps call it from another origin (localhost:3000, 5173).
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] ?? '*');
    const method = (req.method ?? 'GET').toUpperCase();
    const path = req.url ?? '/';
    if (method === 'OPTIONS') return void res.writeHead(204).end();
    if (path === '/__codz' || path.startsWith('/__codz/') || path.startsWith('/__codz?')) return this.control(req, res, method, path.split('?')[0]);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: unknown;
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
    }
    const started = Date.now();
    const scenario = this.scenarioFor(matchRoute(this.api.routes, method, path)?.route ?? null);
    const wait = scenario === 'slow' ? Math.max(3000, this.opts.delay) : this.opts.delay;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (scenario === 'offline') {
      this.record({ method, path, status: 0, ms: Date.now() - started, scenario, request: body });
      this.opts.log(`${method} ${path.split('?')[0]} → connection dropped (offline)`);
      return void req.socket.destroy();
    }
    const out = this.handle(method, path, body);
    const n = Array.isArray(out.body) ? ` (${out.body.length} items)` : out.body && typeof out.body === 'object' && Array.isArray((out.body as { data?: unknown }).data) ? ` (${((out.body as { data: unknown[] }).data).length} items)` : '';
    this.record({ method, path, status: out.status, ms: Date.now() - started, scenario, request: body, response: out.body });
    this.opts.log(`${method} ${path.split('?')[0]} → ${out.status}${n}${scenario !== 'normal' ? `  [${scenario}]` : ''}`);
    if (out.body === undefined) return void res.writeHead(out.status).end();
    res.writeHead(out.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(out.body));
  }

  private record(e: Omit<LogEntry, 'id' | 'time'>): void {
    this.logEntries.push({ id: this.nextLogId++, time: new Date().toISOString(), ...e });
    if (this.logEntries.length > 200) this.logEntries.shift();
  }

  /** The control page and its API: /__codz (page), /__codz/state, /__codz/scenario, /__codz/reset. */
  private async control(req: IncomingMessage, res: ServerResponse, method: string, path: string): Promise<void> {
    const json = (status: number, value: unknown) => void res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (method === 'GET' && (path === '/__codz' || path === '/__codz/')) return void res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(CONTROL_PAGE);
    if (method === 'GET' && path === '/__codz/state') return json(200, this.state());
    if (method === 'POST' && (path === '/__codz/scenario' || path === '/__codz/reset')) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let input: { scenario?: string; route?: string } = {};
      try {
        input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return json(400, { error: 'Send JSON: {"scenario": "error", "route": "GET /v1/products"}' });
      }
      try {
        if (path === '/__codz/reset') this.reset();
        else this.setScenario(input.scenario as Scenario, input.route);
      } catch (e) {
        return json(400, { error: (e as Error).message });
      }
      this.opts.log(path === '/__codz/reset' ? 'Reset: starting data, normal answers, empty log' : `Scenario: ${input.route ? `${input.route} → ` : ''}${input.scenario}`);
      return json(200, this.state());
    }
    return json(404, { error: 'Control routes: GET /__codz, GET /__codz/state, POST /__codz/scenario, POST /__codz/reset' });
  }

  state(): { scenario: Scenario; scenarios: { id: Scenario; help: string }[]; routes: { route: string; scenario: Scenario }[]; log: LogEntry[] } {
    return {
      scenario: this.scenario,
      scenarios: SCENARIOS.map((id) => ({ id, help: SCENARIO_HELP[id] })),
      routes: this.api.routes.map((r) => ({ route: `${r.method} ${r.path}`, scenario: this.scenarioFor(r) })),
      log: this.logEntries.slice(-100).reverse(),
    };
  }
}

/**
 * Makes rows of a list look different from each other: the sample values are
 * the same for every row of a model, so numbers, dates, flags and plain texts
 * get the row number worked in (ids are set separately).
 */
function vary(value: unknown, index: number, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => vary(v, index, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, vary(v, index, k)]));
  if (/(^|_)id$|Id$/.test(key)) return value;
  if (typeof value === 'number') return Number.isInteger(value) ? value + (index - 1) : Math.round((value + (index - 1) * (value < 10 ? 0.1 : 7.5)) * 100) / 100;
  if (typeof value === 'boolean') return index % 3 !== 0;
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return new Date(Date.parse(value) + (index - 1) * 86_400_000).toISOString().replace('.000Z', 'Z');
    if (/^Sample /.test(value) && !/\d$/.test(value)) return `${value} ${index}`;
  }
  return value;
}

/** This computer's address on the local network, for apps on a phone. */
export function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return null;
}

/** How to point the app at the mock server, by framework. */
export function connectHints(map: ProjectMap | null, framework: string | null, port: number, onLan = false): string[] {
  const local = `http://localhost:${port}`;
  const lan = onLan ? lanAddress() : null;
  const phone = lan ? `http://${lan}:${port}` : null;
  const c = map?.conventions ?? {};
  const where = map?.baseUrls?.[0]?.file;
  const lines = hintsFor();
  if (!onLan && ['react-native', 'flutter', 'android', 'ios'].includes(framework ?? '')) lines.push('To use it from a phone on the same Wi-Fi, start it with --lan (it then listens on your network, not only on this computer).');
  return lines;

  function hintsFor(): string[] {
  switch (framework) {
    case 'nextjs':
      return [`Start the app with: ${c.baseUrlEnv || 'NEXT_PUBLIC_API_URL'}=${local} npm run dev`];
    case 'react':
      return [`Start the app with: ${c.bundler === 'cra' ? 'REACT_APP_API_URL' : 'VITE_API_URL'}=${local} npm ${c.bundler === 'cra' ? 'start' : 'run dev'}`];
    case 'react-native':
      return [`Set the API URL${c.configFile ? ` in ${c.configFile}` : ''} to ${local} (iOS simulator), http://10.0.2.2:${port} (Android emulator)${phone ? ` or ${phone} (a phone on the same Wi-Fi)` : ''}.`];
    case 'flutter':
      return [
        `Set baseUrl${where ? ` in ${where}` : ''} to http://10.0.2.2:${port} (Android emulator), ${local} (iOS simulator, web, desktop)${phone ? ` or ${phone} (a phone on the same Wi-Fi)` : ''}.`,
        'Android blocks plain http by default: add android:usesCleartextTraffic="true" to <application> in android/app/src/main/AndroidManifest.xml while you use the mock.',
      ];
    case 'android':
      return [`Set the base URL${where ? ` in ${where}` : ''} to http://10.0.2.2:${port}/ (emulator)${phone ? ` or ${phone}/ (a phone on the same Wi-Fi)` : ''}.`, 'Android blocks plain http by default: add android:usesCleartextTraffic="true" to <application> in AndroidManifest.xml while you use the mock.'];
    case 'ios':
      return [`Set baseURL${where ? ` in ${where}` : ''} to ${local} (simulator)${phone ? ` or ${phone} (an iPhone on the same Wi-Fi; allow it under App Transport Security)` : ''}.`];
    default:
      return [`Point the app's API base URL at ${local}${phone ? ` (from a phone on the same Wi-Fi: ${phone})` : ''}.`];
  }
  }
}

/** The page at /__codz: switch scenarios (for every route or one) and watch requests. */
const CONTROL_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>codz mock</title>
<style>
  :root { --bg: #fff; --fg: #1d1d1f; --muted: #6e6e73; --line: #e5e5ea; --accent: #0f766e; --bad: #b42318; --chip: #f2f2f7; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161618; --fg: #f2f2f7; --muted: #a1a1a6; --line: #2c2c2e; --accent: #2dd4bf; --bad: #f97066; --chip: #232326; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px 16px 40px; font: 14px/1.45 system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 1000px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 8px; }
  p { margin: 0; color: var(--muted); }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  button { font: inherit; border: 1px solid var(--line); background: var(--chip); color: var(--fg); padding: 6px 12px; border-radius: 999px; cursor: pointer; }
  button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--bg); }
  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; }
  code { font: 12px/1.4 ui-monospace, Menlo, monospace; }
  select { font: inherit; background: var(--chip); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; padding: 2px 6px; }
  .bad { color: var(--bad); }
  details pre { margin: 6px 0 0; white-space: pre-wrap; word-break: break-word; font: 12px/1.4 ui-monospace, Menlo, monospace; background: var(--chip); padding: 8px; border-radius: 6px; max-height: 260px; overflow: auto; }
  .scroll { overflow-x: auto; }
</style>
</head>
<body>
<main>
  <h1>codz mock</h1>
  <p id="help">Switch how the mock answers, then use the app.</p>
  <div class="chips" id="scenarios"></div>
  <h2>Per endpoint</h2>
  <div class="scroll"><table><thead><tr><th>Endpoint</th><th>Answers with</th></tr></thead><tbody id="routes"></tbody></table></div>
  <h2>Requests <button id="reset" title="Starting data, normal answers, empty log">Reset</button></h2>
  <div class="scroll"><table><thead><tr><th>Time</th><th>Request</th><th>Status</th><th>ms</th></tr></thead><tbody id="log"></tbody></table></div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
let state = null;
let open = new Set();
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  state = await r.json();
  render();
}
function render() {
  if (!state || !state.scenarios) return;
  $('scenarios').innerHTML = state.scenarios.map((s) => '<button data-s="' + s.id + '" aria-pressed="' + (s.id === state.scenario) + '" title="' + esc(s.help) + '">' + s.id + '</button>').join('');
  const cur = state.scenarios.find((s) => s.id === state.scenario);
  $('help').textContent = 'Every endpoint: ' + state.scenario + ' (' + (cur ? cur.help : '') + '). Endpoints set differently below win.';
  $('routes').innerHTML = state.routes.map((r) => '<tr><td><code>' + esc(r.route) + '</code></td><td><select data-r="' + esc(r.route) + '">' + state.scenarios.map((s) => '<option' + (s.id === r.scenario ? ' selected' : '') + '>' + s.id + '</option>').join('') + '</select></td></tr>').join('');
  $('log').innerHTML = state.log.map((e) => {
    const body = (e.request !== undefined ? 'Request:\\n' + JSON.stringify(e.request, null, 2) + '\\n\\n' : '') + (e.response !== undefined ? 'Response:\\n' + JSON.stringify(e.response, null, 2) : '');
    const label = esc(e.method + ' ' + e.path);
    return '<tr><td>' + new Date(e.time).toLocaleTimeString() + '</td><td>' + (body ? '<details data-id="' + e.id + '"' + (open.has(String(e.id)) ? ' open' : '') + '><summary><code>' + label + '</code></summary><pre>' + esc(body) + '</pre></details>' : '<code>' + label + '</code>') + '</td><td class="' + (e.status >= 400 || e.status === 0 ? 'bad' : '') + '">' + (e.status || 'dropped') + (e.scenario !== 'normal' ? ' <small>(' + e.scenario + ')</small>' : '') + '</td><td>' + e.ms + '</td></tr>';
  }).join('') || '<tr><td colspan="4"><p>No requests yet. Use the app.</p></td></tr>';
}
document.addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-s]');
  if (b) post('/__codz/scenario', { scenario: b.dataset.s });
  if (ev.target.id === 'reset') post('/__codz/reset');
});
document.addEventListener('change', (ev) => { if (ev.target.dataset.r) post('/__codz/scenario', { scenario: ev.target.value, route: ev.target.dataset.r }); });
document.addEventListener('toggle', (ev) => { const d = ev.target; if (d.dataset && d.dataset.id) d.open ? open.add(d.dataset.id) : open.delete(d.dataset.id); }, true);
async function poll() { try { state = await (await fetch('/__codz/state')).json(); render(); } catch {} setTimeout(poll, 1000); }
poll();
</script>
</body>
</html>
`;
