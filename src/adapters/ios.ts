// iOS adapter (Swift, SwiftUI): an Xcode project with a SwiftUI App.
//
//   API layer   APIClient (URLSession, async/await, JSONDecoder) in Networking/;
//               each endpoint is a method in an `extension APIClient` file per
//               resource (APIClient+Orders.swift)
//   Models      Codable structs, one per file in Models/, with CodingKeys for
//               JSON names that are not Swift names (created_at → createdAt)
//   Screens     SwiftUI views and @MainActor ObservableObject view models
//               (see skills/iosUi.ts)
//
// Xcode 16 projects keep their files in synchronized folders, so new files are
// part of the app as soon as they exist. Older projects list every file in
// project.pbxproj; devtool does not edit that file, and says which files to add
// to the target in Xcode.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { commentText, encodePathSegment } from '../core/safe.ts';
import { exists, readText, walk } from '../core/fsutil.ts';
import { ToolError, type Adapter, type AdapterContext, type ArchitectureOption, type Conventions, type EndpointInfo, type EndpointSpec, type InferredModel, type InferredType, type ModelInfo, type PlannedEdits, type ProjectMap, type SetupChoice, type SetupPlan } from '../core/types.ts';
import { camel, pascal } from '../input/naming.ts';
import { emptyMap, fileStats, specRelativePath } from './common.ts';
import { resourceOf } from './flutterGen.ts';
import { referencedModels, resolveModels } from './models.ts';
import { mostCommon } from './nextjsScan.ts';

export const IOS_VERSION = '0.1.0';

export const IOS_CONVENTION_DOCS: Record<string, string> = {
  appName: 'the Xcode project (and app target) name',
  sourceDir: 'the folder with the app sources (where the @main App is)',
  appFile: 'the file with the @main SwiftUI App',
  ui: 'swiftui (screens are written as SwiftUI views)',
  fileSync: 'synchronized (Xcode 16 folders: new files join the target by themselves) or groups (add new files to the target in Xcode)',
  networkFile: 'the file that defines APIClient',
  apiFolder: 'where the APIClient extensions with the endpoints live',
  modelsFolder: 'where Codable model structs live',
  screensFolder: 'where SwiftUI screens and their view models live',
  baseUrl: "APIClient's base URL",
  indent: 'indentation: 2 or 4',
};

const SWIFT_KEYWORDS = new Set(['associatedtype', 'class', 'deinit', 'enum', 'extension', 'fileprivate', 'func', 'import', 'init', 'inout', 'internal', 'let', 'open', 'operator', 'private', 'protocol', 'public', 'rethrows', 'static', 'struct', 'subscript', 'typealias', 'var', 'break', 'case', 'continue', 'default', 'defer', 'do', 'else', 'fallthrough', 'for', 'guard', 'if', 'in', 'repeat', 'return', 'switch', 'where', 'while', 'as', 'catch', 'false', 'is', 'nil', 'super', 'self', 'Self', 'throw', 'throws', 'true', 'try', 'Type', 'Any', 'await', 'async']);

/** A Swift identifier for a JSON key: created_at → createdAt, `default` in backticks. */
export function swiftName(json: string): string {
  let n = camel(json.replace(/[^A-Za-z0-9_]+/g, '_'));
  if (!n || /^[0-9]/.test(n)) n = `_${n}`;
  return SWIFT_KEYWORDS.has(n) ? `\`${n}\`` : n;
}

/** A Swift string literal's content: escapes \ and " and line breaks. */
export function swiftText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

export function swiftType(t: InferredType | undefined): string | null {
  if (!t) return null;
  switch (t.kind) {
    case 'string':
    case 'date':
      return 'String';
    case 'int':
      return 'Int';
    case 'double':
      return 'Double';
    case 'bool':
      return 'Bool';
    case 'array': {
      const inner = swiftType(t.item);
      return inner ? `[${inner}]` : null;
    }
    case 'object':
      return t.model;
    default:
      return null;
  }
}

const dirOf = (f: string) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.');

/** Index of the brace that closes the one at `open` (Swift strings and comments skipped). */
export function swiftClose(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      if (i < 0) return -1;
      continue;
    }
    if (ch === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

export function xcodeProject(root: string): string | null {
  try {
    return readdirSync(root).find((n) => n.endsWith('.xcodeproj') && exists(join(root, n, 'project.pbxproj'))) ?? null;
  } catch {
    return null;
  }
}

/** Codable structs: name, fields (JSON name from CodingKeys), file. */
function parseModels(file: string, text: string): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const m of text.matchAll(/\bstruct\s+(\w+)\s*:\s*([^{]*)\{/g)) {
    if (!/\b(Codable|Decodable|Encodable)\b/.test(m[2])) continue;
    const open = m.index! + m[0].length - 1;
    const close = swiftClose(text, open);
    if (close < 0) continue;
    const body = text.slice(open + 1, close);
    const keys = new Map<string, string>();
    const ck = /enum\s+CodingKeys\s*:\s*String[^{]*\{([^}]*)\}/.exec(body)?.[1] ?? '';
    for (const line of ck.split('\n')) {
      const c = /^\s*case\s+(.+)$/.exec(line);
      if (!c) continue;
      for (const part of c[1].split(',')) {
        const kv = /^\s*`?(\w+)`?\s*(?:=\s*"([^"]*)")?\s*$/.exec(part);
        if (kv) keys.set(kv[1], kv[2] ?? kv[1]);
      }
    }
    const fields = [];
    // Only stored properties at the struct's own level.
    let depth = 0;
    for (const line of body.split('\n')) {
      if (depth === 0) {
        const f = /^\s*(?:public\s+|private\(set\)\s+)?(?:let|var)\s+`?(\w+)`?\s*:\s*([^=\n{]+?)\s*(?:=.*)?$/.exec(line);
        if (f) fields.push({ name: keys.get(f[1]) ?? f[1], type: f[2].replace(/\?$/, '').trim(), nullable: f[2].trim().endsWith('?') });
      }
      depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
    }
    out.push({ name: m[1], file, fields });
  }
  return out;
}

/** func getOrder(orderId: Int) async throws -> Order { try await send("GET", "/orders/\(orderId)") } */
function parseEndpoints(file: string, text: string): EndpointInfo[] {
  const out: EndpointInfo[] = [];
  for (const m of text.matchAll(/\bfunc\s+(\w+)\s*\(([^)]*)\)\s*async\s+throws(?:\s*->\s*([^{]+?))?\s*\{/g)) {
    const open = m.index! + m[0].length - 1;
    const close = swiftClose(text, open);
    const body = close > 0 ? text.slice(open, close) : '';
    const call = /\bsend(?:Empty)?\s*\(\s*"(GET|POST|PUT|PATCH|DELETE|HEAD)"\s*,\s*"((?:[^"\\]|\\.)*)"/.exec(body);
    if (!call) continue;
    const path = call[2].replace(/\\\((\w+)\)/g, '{$1}');
    out.push({ name: m[1], method: call[1] as EndpointInfo['method'], path: path.startsWith('/') || /^https?:/.test(path) ? path : `/${path}`, response: m[3]?.trim() ?? 'Void', file, calledFrom: [] });
  }
  return out;
}

async function scan(root: string, configConventions: Conventions): Promise<ProjectMap> {
  const map = emptyMap('ios', `ios@${IOS_VERSION}`);
  const files = walk(root, '.', { exts: ['.swift'], extraIgnored: ['Pods', 'DerivedData', 'build', '.build', 'Carthage'] });
  map.stats = fileStats(walk(root));
  const text = (f: string) => readText(join(root, f)) ?? '';
  const proj = xcodeProject(root);
  const c: Conventions = {};
  c.appName = proj ? proj.replace(/\.xcodeproj$/, '') : '';
  const appFile = files.find((f) => /@main\b[\s\S]{0,200}?\bstruct\s+\w+\s*:\s*App\b/.test(text(f))) ?? '';
  c.appFile = appFile;
  c.ui = appFile ? 'swiftui' : 'uikit';
  c.sourceDir = appFile ? dirOf(appFile) : c.appName && exists(join(root, c.appName)) ? c.appName : '.';
  const pbx = proj ? readText(join(root, proj, 'project.pbxproj')) ?? '' : '';
  c.fileSync = /PBXFileSystemSynchronizedRootGroup/.test(pbx) ? 'synchronized' : 'groups';
  const networkFile = files.find((f) => /\b(?:final\s+)?(?:class|struct|actor)\s+APIClient\b/.test(text(f))) ?? '';
  c.networkFile = networkFile;
  c.apiFolder = networkFile ? dirOf(networkFile) : `${c.sourceDir}/Networking`;
  c.baseUrl = networkFile ? /URL\(string:\s*"(https?:\/\/[^"]+)"\)/.exec(text(networkFile))?.[1] ?? '' : '';
  const sample = text(files[0] ?? '');
  c.indent = /\n {2}\S/.test(sample) && !/\n {4}\S/.test(sample) ? '2' : '4';

  for (const f of files) {
    const t = text(f);
    map.models.push(...parseModels(f, t));
    if (/\bextension\s+APIClient\b|\b(?:class|struct|actor)\s+APIClient\b/.test(t)) map.endpoints.push(...parseEndpoints(f, t));
  }
  c.modelsFolder = mostCommon(map.models.map((m) => dirOf(m.file)), `${c.sourceDir}/Models`);
  c.screensFolder = `${c.sourceDir}/Views`;
  for (const ep of map.endpoints) ep.calledFrom = files.filter((f) => f !== ep.file && new RegExp(`\\.${ep.name}\\(`).test(text(f)));
  for (const f of files) for (const v of text(f).matchAll(/\bstruct\s+(\w+)\s*:\s*View\b/g)) map.routes.push({ name: v[1], path: v[1], params: [], file: f });
  if (c.baseUrl) map.baseUrls.push({ name: 'APIClient baseURL', value: c.baseUrl, file: networkFile });
  map.conventions = { ...c, ...configConventions };
  if (!proj) map.notes.push('No .xcodeproj was found next to the sources; run devtool from the folder that holds YourApp.xcodeproj.');
  if (map.conventions.ui !== 'swiftui') map.notes.push('No SwiftUI App (@main struct ...: App) was found; screens are written for SwiftUI, so screen add and feature add will not add views.');
  if (map.conventions.fileSync === 'groups') map.notes.push('This Xcode project lists its files in project.pbxproj (not Xcode 16 synchronized folders); add the files devtool creates to the app target in Xcode.');
  return map;
}

// ---------- Setup ----------

export function iosArchitectures(map: ProjectMap): ArchitectureOption[] {
  if (map.conventions.networkFile || map.endpoints.length) return [];
  return [{ id: 'urlsession', label: 'URLSession + async/await', description: 'APIClient with send<T>() over URLSession and JSONDecoder; endpoints in extensions', recommended: true }];
}

function apiClientFile(baseUrl: string, I: string): string {
  const L = [
    'import Foundation',
    '',
    '/// Thrown when the API answers with a status outside 200-299.',
    'struct APIError: LocalizedError {',
    `${I}let status: Int`,
    `${I}let body: String`,
    '',
    `${I}var errorDescription: String? { "HTTP \\(status): \\(body)" }`,
    '}',
    '',
    '/// Calls the API with URLSession and decodes JSON. Endpoints are methods in',
    '/// `extension APIClient` files (devtool api add writes them). Add auth headers in `send`.',
    'final class APIClient {',
    `${I}static let shared = APIClient()`,
    '',
    `${I}let baseURL: URL`,
    `${I}private let session: URLSession`,
    `${I}private let decoder = JSONDecoder()`,
    `${I}private let encoder = JSONEncoder()`,
    '',
    `${I}init(baseURL: URL = URL(string: "${swiftText(baseUrl)}")!, session: URLSession = .shared) {`,
    `${I}${I}self.baseURL = baseURL`,
    `${I}${I}self.session = session`,
    `${I}}`,
    '',
    `${I}/// Sends a request and decodes the JSON answer.`,
    `${I}func send<T: Decodable>(_ method: String, _ path: String, query: [String: String?] = [:], body: Data? = nil) async throws -> T {`,
    `${I}${I}let data = try await data(method, path, query: query, body: body)`,
    `${I}${I}return try decoder.decode(T.self, from: data)`,
    `${I}}`,
    '',
    `${I}/// Sends a request whose answer has no body (204, or one that is not needed).`,
    `${I}func sendEmpty(_ method: String, _ path: String, query: [String: String?] = [:], body: Data? = nil) async throws {`,
    `${I}${I}_ = try await data(method, path, query: query, body: body)`,
    `${I}}`,
    '',
    `${I}/// JSON for a request body.`,
    `${I}func encode<B: Encodable>(_ body: B) throws -> Data {`,
    `${I}${I}try encoder.encode(body)`,
    `${I}}`,
    '',
    `${I}private func data(_ method: String, _ path: String, query: [String: String?], body: Data?) async throws -> Data {`,
    `${I}${I}// A path is relative to baseURL; a full URL (another host) is used as it is.`,
    `${I}${I}let base = path.hasPrefix("http") ? URL(string: path)! : baseURL.appendingPathComponent(path)`,
    `${I}${I}var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!`,
    `${I}${I}let items = query.compactMap { key, value in value.map { URLQueryItem(name: key, value: $0) } }`,
    `${I}${I}if !items.isEmpty { components.queryItems = items }`,
    `${I}${I}var request = URLRequest(url: components.url!)`,
    `${I}${I}request.httpMethod = method`,
    `${I}${I}request.setValue("application/json", forHTTPHeaderField: "Accept")`,
    `${I}${I}if let body {`,
    `${I}${I}${I}request.httpBody = body`,
    `${I}${I}${I}request.setValue("application/json", forHTTPHeaderField: "Content-Type")`,
    `${I}${I}}`,
    `${I}${I}let (data, response) = try await session.data(for: request)`,
    `${I}${I}let status = (response as? HTTPURLResponse)?.statusCode ?? 0`,
    `${I}${I}guard (200..<300).contains(status) else {`,
    `${I}${I}${I}throw APIError(status: status, body: String(decoding: data, as: UTF8.self))`,
    `${I}${I}}`,
    `${I}${I}return data`,
    `${I}}`,
    '}',
    '',
  ];
  return L.join('\n');
}

export function planIosSetup(ctx: AdapterContext, choice: SetupChoice): SetupPlan {
  const { root, map } = ctx;
  if (choice.architecture !== 'urlsession') throw new ToolError('bad_args', `Unknown architecture "${choice.architecture}". Choose urlsession.`);
  const c0 = map.conventions;
  if (!c0.appName) throw new ToolError('no_project', 'No .xcodeproj was found here.', 'Run devtool from the folder that holds YourApp.xcodeproj.');
  const I = ' '.repeat(Number(c0.indent) || 4);
  const src = c0.sourceDir || c0.appName;
  const baseUrl = (choice.baseUrl || 'https://api.example.com').replace(/\/+$/, '');
  const files = new Map<string, string>();
  const summary: string[] = [];
  const warnings: string[] = [];
  if (!choice.baseUrl) warnings.push('No base URL was given, so APIClient uses https://api.example.com. Change it in APIClient.swift before calling the API.');
  const networkFile = `${src}/Networking/APIClient.swift`;
  if (readText(join(root, networkFile)) !== null) throw new ToolError('file_exists', `${networkFile} already exists, so setup stopped without changing anything.`);
  files.set(networkFile, apiClientFile(baseUrl, I));
  summary.push(`Create ${networkFile}: APIClient (URLSession, async/await, JSON), baseURL ${baseUrl}`);
  if (c0.fileSync === 'groups') warnings.push(`Add ${networkFile} to the ${c0.appName} target in Xcode (this project does not use synchronized folders).`);
  const conventions: Conventions = { ...c0, networkFile, apiFolder: `${src}/Networking`, modelsFolder: `${src}/Models`, screensFolder: `${src}/Views`, baseUrl };
  summary.push(`Save conventions: endpoints in ${src}/Networking, models in ${src}/Models, screens in ${src}/Views`);
  return { files, summary, warnings, generated: [], conventions, dependenciesChanged: false };
}

// ---------- Endpoints ----------

function renderStruct(m: InferredModel, I: string, warnings: string[]): string {
  const fields = m.fields.map((f) => ({ f, type: swiftType(f.type), name: swiftName(f.jsonName) }));
  for (const x of fields.filter((x) => !x.type)) warnings.push(`${m.name}.${x.f.jsonName} has no type devtool can map to Swift, so it is left out of the struct.`);
  const kept = fields.filter((x) => x.type);
  const bare = (n: string) => n.replace(/`/g, '');
  const identifiable = kept.some((x) => bare(x.name) === 'id' && !x.f.nullable);
  const needKeys = kept.some((x) => bare(x.name) !== x.f.jsonName);
  return [
    'import Foundation',
    '',
    `struct ${m.name}: Codable, Hashable${identifiable ? ', Identifiable' : ''} {`,
    ...kept.map((x) => `${I}let ${x.name}: ${x.type}${x.f.nullable ? '?' : ''}`),
    ...(needKeys
      ? ['', `${I}enum CodingKeys: String, CodingKey {`, ...kept.map((x) => (bare(x.name) === x.f.jsonName ? `${I}${I}case ${x.name}` : `${I}${I}case ${x.name} = "${swiftText(x.f.jsonName)}"`)), `${I}}`]
      : []),
    '}',
    '',
  ].join('\n');
}

/** "/orders/{orderId}/items" → "/orders/\(orderId)/items" with literal parts escaped. */
function swiftPath(path: string, params: Map<string, string>): string {
  return path
    .split('/')
    .map((seg) => {
      const p = /^\{([^}]+)\}$/.exec(seg);
      if (p) return `\\(${params.get(p[1]) ?? swiftName(p[1])})`;
      return swiftText(seg.includes('%') ? seg : encodePathSegment(seg));
    })
    .join('/');
}

async function planEndpoint(ctx: AdapterContext, input: EndpointSpec, overlay?: Map<string, string>, opts: { replaceModels?: boolean; targetFile?: string } = {}): Promise<PlannedEdits> {
  const { root, map } = ctx;
  const c = map.conventions;
  if (!c.networkFile && !(overlay && [...overlay.keys()].some((k) => /APIClient\.swift$/.test(k)))) throw new ToolError('unsupported_setup', 'This project has no APIClient yet.', 'Run devtool setup (it writes Networking/APIClient.swift), or devtool feature add, which sets it up first.');
  const I = ' '.repeat(Number(c.indent) || 4);
  const files = new Map<string, string>(overlay ?? []);
  const read = (p: string) => files.get(p) ?? readText(join(root, p));
  const summary: string[] = [];
  const warnings = [...input.warnings];
  const { spec, reused, replaced, notes } = resolveModels(input, map.models, (n) => n, { replace: opts.replaceModels });
  warnings.push(...notes);

  // Path relative to APIClient.baseURL.
  let path = spec.path;
  const fromSpec = specRelativePath(spec, c.baseUrl);
  if (fromSpec !== null) path = fromSpec;
  else if (c.baseUrl) {
    try {
      const b = new URL(c.baseUrl);
      const prefix = b.pathname.replace(/\/$/, '');
      if ((!spec.origin || spec.origin === b.origin) && prefix && path.startsWith(`${prefix}/`)) path = path.slice(prefix.length);
      else if (spec.origin && spec.origin !== b.origin) {
        path = `${spec.origin}${spec.path}`;
        warnings.push(`The URL host ${spec.origin} differs from APIClient's baseURL (${c.baseUrl}), so the full URL is used for this call.`);
      }
    } catch {
      // Not a literal URL.
    }
  }

  const existing = map.endpoints.find((e) => e.name === spec.name);
  if (existing) {
    if (existing.method === spec.method && existing.path.replace(/\{\w+\}/g, '{}') === path.replace(/\{\w+\}/g, '{}')) return { files, summary: [`${spec.name} already exists in ${existing.file}; nothing to do.`], warnings: [], generated: [] };
    throw new ToolError('name_conflict', `A method called ${spec.name} already exists in ${existing.file} for ${existing.method} ${existing.path}.`, 'Pass --name <methodName> to use another name.');
  }

  // Models: one struct per file.
  const modelFile = new Map<string, string>();
  for (const [name, info] of reused) modelFile.set(name, info.file);
  for (const m of spec.models) {
    const file = replaced.get(m.name)?.file ?? `${c.modelsFolder}/${m.name}.swift`;
    modelFile.set(m.name, file);
    const prev = read(file);
    if (prev !== null && !replaced.has(m.name)) throw new ToolError('file_exists', `${file} already exists but does not define ${m.name}.`, 'Pass --model-name <Name> to use another name.');
    files.set(file, renderStruct(m, I, warnings));
    summary.push(`${prev === null ? 'Create' : 'Update'} ${file}: struct ${m.name}${replaced.has(m.name) ? ' (rewritten)' : ''}`);
  }

  // The method, in the resource's APIClient extension.
  const resource = resourceOf(spec.path);
  const fromEndpoints = map.endpoints.find((e) => resourceOf(e.path) === resource)?.file;
  const apiFile = opts.targetFile ?? fromEndpoints ?? `${c.apiFolder}/APIClient+${pascal(resource)}.swift`;
  let apiText = read(apiFile);
  const created = apiText === null;
  if (created) apiText = 'import Foundation\n\nextension APIClient {\n}\n';
  const params = new Map(spec.pathParams.map((p) => [p.name, swiftName(p.name)]));
  const sig = [
    ...spec.pathParams.map((p) => `${swiftName(p.name)}: ${p.type === 'int' ? 'Int' : 'String'}`),
    ...spec.queryParams.map((q) => `${swiftName(q.name)}: ${swiftType(q.type) ?? 'String'}? = nil`),
    ...(spec.request ? [`body: ${swiftType(spec.request) ?? 'Data'}`] : []),
  ];
  const resp = spec.method === 'DELETE' || spec.method === 'HEAD' ? null : swiftType(spec.response);
  if (spec.response && !resp && spec.method !== 'DELETE' && spec.method !== 'HEAD') warnings.push(`${spec.name}: the response has no type devtool can map to Swift, so the method returns nothing. Change it to return a model when you know the shape.`);
  const query = spec.queryParams.length ? `, query: [${spec.queryParams.map((q) => `"${swiftText(q.name)}": ${(swiftType(q.type) ?? 'String') === 'String' ? swiftName(q.name) : `${swiftName(q.name)}.map { String(describing: $0) }`}`).join(', ')}]` : '';
  const body = spec.request ? ', body: try encode(body)' : '';
  const call = `${resp ? 'try await send' : 'try await sendEmpty'}("${spec.method}", "${swiftPath(path, params)}"${query}${body})`;
  const fun = [`${I}/// ${spec.method} ${commentText(spec.path)}`, `${I}func ${spec.name}(${sig.join(', ')}) async throws${resp ? ` -> ${resp}` : ''} {`, `${I}${I}${call}`, `${I}}`].join('\n');
  const head = /\bextension\s+APIClient\b[^{]*\{/.exec(apiText!) ?? /\b(?:class|struct|actor)\s+APIClient\b[^{]*\{/.exec(apiText!);
  if (!head) throw new ToolError('no_api_client', `${apiFile} has no extension APIClient { }.`);
  const close = swiftClose(apiText!, head.index + head[0].length - 1);
  const before = apiText!.slice(0, close).replace(/\s*$/, '');
  apiText = `${before}${before.endsWith('{') ? '\n' : '\n\n'}${fun}\n${apiText!.slice(close)}`;
  files.set(apiFile, apiText);
  summary.push(`${created ? 'Create' : 'Update'} ${apiFile}: APIClient.${spec.name}() for ${spec.method} ${spec.path}`);
  const added = [...files.keys()].filter((f) => f.endsWith('.swift') && readText(join(root, f)) === null && !(overlay?.has(f)));
  if (c.fileSync === 'groups' && added.length) warnings.push(`Add ${added.join(', ')} to the ${c.appName || 'app'} target in Xcode (this project does not use synchronized folders).`);
  const refs = new Set<string>();
  referencedModels(spec.response, refs);
  return {
    files,
    summary,
    warnings,
    generated: [{ skill: 'api add', file: apiFile, symbol: spec.name, inputHash: '' }],
    endpoints: [{ name: spec.name, method: spec.method, path: path.startsWith('/') || /^https?:/.test(path) ? path : `/${path}`, response: resp ?? 'Void', file: apiFile, calledFrom: [] }],
    models: spec.models.map((m) => ({ name: m.name, file: modelFile.get(m.name)!, fields: m.fields.filter((f) => swiftType(f.type)).map((f) => ({ name: f.jsonName, type: swiftType(f.type)!, nullable: f.nullable })) })),
  };
}

export const iosAdapter: Adapter = {
  id: 'ios',
  version: IOS_VERSION,
  capabilities: { explain: true, apiAdd: true },
  supportedSetup: 'iOS apps in Swift with SwiftUI: an APIClient over URLSession with async/await, Codable structs, SwiftUI views with ObservableObject view models. Not yet: UIKit screens, Alamofire, tests.',
  scan,
  planEndpoint,
  architectures: iosArchitectures,
  planSetup: planIosSetup,
};

