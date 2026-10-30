// mock add: canned responses so screens can be built before the backend is ready.
//
// Flutter: lib/.../network/mocks/mock_responses.dart (the JSON) and
//          mock_interceptor.dart (a Dio interceptor), added to createDio()
//          and active only with: flutter run --dart-define=USE_MOCKS=true
// Next.js: lib/api/mocks.ts, checked at the top of the request helper when
//          NEXT_PUBLIC_USE_MOCKS=true
//
// The JSON comes from --sample, or is generated from the response model with
// fixed, readable values (same model, same mock).

import { join, posix } from 'node:path';
import { addDartImport, importUri } from '../adapters/flutter.ts';
import { matchBrace } from '../adapters/source.ts';
import { importPath } from '../adapters/nextjs.ts';
import { loadMap } from '../core/cache.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { loadConfig } from '../core/config.ts';
import { detectEol, hash, readText, withEol } from '../core/fsutil.ts';
import { ToolError, type Adapter, type ChangeSet, type EndpointInfo, type ModelInfo, type ProjectMap } from '../core/types.ts';
import { findDeclaration } from './apiEdit.ts';

export interface MockOptions {
  endpoints: string[];
  all?: boolean;
  sample?: string;
  /** Write --sample values exactly as given (no secret / personal-data scrubbing). */
  keepValues?: boolean;
  /** Regenerate mocks even when they were edited by hand. */
  force?: boolean;
}

/** Marker above each generated mock: the hash of the value devtool wrote, to notice hand edits. */
const markerFor = (value: string) => `// devtool:${hash(value.trim()).slice(0, 10)}`;
const MARKER = /^[ \t]*\/\/ devtool:([0-9a-f]{10})[ \t]*\n/;

/** Was the mock at `entryStart` edited since devtool wrote it? No marker counts as edited. */
function handEdited(text: string, entryStart: number, value: string): boolean {
  const lineStart = text.lastIndexOf('\n', entryStart - 1);
  const prevStart = text.lastIndexOf('\n', lineStart - 1) + 1;
  const m = MARKER.exec(text.slice(prevStart, lineStart + 1));
  return !m || m[1] !== hash(value.trim()).slice(0, 10);
}

const SECRET_KEY = /(token|secret|passw(or)?d|pwd|api[_-]?key|apikey|auth|cookie|session|jwt|otp|(^|_)pin$|ssn|card|cvv|cvc|iban|account[_-]?(no|number)|signature|private|credential)/i;
const PERSONAL_KEY = /(email|phone|mobile|address|street|city|zip|postal|birth|dob|first[_-]?name|last[_-]?name|full[_-]?name|^name$|user[_-]?name|display[_-]?name|national|passport|ip[_-]?addr|lat(itude)?$|lng$|lon(gitude)?$)/i;
const SECRET_VALUE = /^(eyJ[\w-]+\.[\w-]+\.[\w-]+|[A-Fa-f0-9]{32,}|[A-Za-z0-9+/_-]{40,}={0,2}|(sk|pk|rk)_(live|test)_\w+|gh[pousr]_\w{20,}|xox[abprs]-[\w-]+)$/;

/**
 * A copy of a real response that is safe to commit: values under secret-looking
 * keys, values that look like tokens, and personal data are replaced with
 * generated examples. Structure, types and every other value stay.
 */
export function scrubSample(value: unknown, map: ProjectMap, replaced: Set<string>, key = '', index = 1): unknown {
  if (Array.isArray(value)) return value.map((v, i) => scrubSample(v, map, replaced, key, i + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubSample(v, map, replaced, k, index);
    return out;
  }
  if (value === null || typeof value === 'boolean') return value;
  const sensitiveKey = SECRET_KEY.test(key) || PERSONAL_KEY.test(key);
  const sensitiveValue = typeof value === 'string' && SECRET_VALUE.test(value);
  if (!sensitiveKey && !sensitiveValue) return value;
  replaced.add(key || '(value)');
  if (typeof value === 'number') return SECRET_KEY.test(key) ? 0 : exampleFor(Number.isInteger(value) ? 'int' : 'double', map, key, 0, index);
  if (SECRET_KEY.test(key) || sensitiveValue) return `mock-${(key || 'value').replace(/[^\w-]/g, '').toLowerCase()}`;
  return exampleFor('string', map, key, 0, index);
}

/** Builds deterministic example data from a type name as the project writes it. */
export function exampleFor(type: string, map: ProjectMap, fieldName = '', depth = 0, index = 1): unknown {
  const t = type.replace(/\?$/, '').replace(/\s*\|\s*null$/, '').trim();
  const list = /^List<(.+)>$/.exec(t) ?? /^(.+)\[\]$/.exec(t) ?? /^Array<(.+)>$/.exec(t);
  if (list) return depth > 3 ? [] : [exampleFor(list[1], map, fieldName, depth + 1, 1), exampleFor(list[1], map, fieldName, depth + 1, 2)];
  const model = map.models.find((m) => m.name === t);
  if (model) return depth > 3 ? {} : exampleObject(model, map, depth + 1, index);
  const n = fieldName.toLowerCase();
  if (/^(int|number|num|Int|Long)$/.test(t)) {
    if (/(^|_)id$|^id$/.test(n) || n.endsWith('id')) return index;
    if (/(count|qty|quantity|total|page|limit|age)/.test(n)) return 2;
    return 10;
  }
  if (/^(double|Double|Float)$/.test(t)) return /(price|amount|total|cost|fee|balance)/.test(n) ? 19.99 : 4.5;
  if (/^(bool|boolean|Boolean)$/.test(t)) return true;
  if (t === 'DateTime' || (t === 'string' && /(_at|date|time)$/.test(n))) return '2026-01-01T09:00:00Z';
  if (/^(String|string)$/.test(t)) {
    if (/email/.test(n)) return `user${index}@example.com`;
    if (/(url|avatar|image|photo|link)/.test(n)) return 'https://example.com/image.png';
    if (/phone|mobile/.test(n)) return '+1 555 0100';
    if (/(^|_)id$|^id$/.test(n)) return `id_${index}`;
    if (/status|state/.test(n)) return 'active';
    if (/name|title/.test(n)) return `Sample ${fieldName.replace(/_/g, ' ')} ${index}`;
    return `Sample ${fieldName.replace(/_/g, ' ') || 'text'}`;
  }
  return null;
}

function exampleObject(model: ModelInfo, map: ProjectMap, depth: number, index: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of model.fields) out[f.name] = exampleFor(f.type, map, f.name, depth, index);
  return out;
}

function mockKey(ep: EndpointInfo): string {
  return `${ep.method} ${ep.path}`;
}

function bodyFor(root: string, ep: EndpointInfo, map: ProjectMap, sample: string | undefined, lang: 'ts' | 'dart', keepValues = false, warnings: string[] = []): unknown {
  if (sample) {
    const text = readText(join(root, sample)) ?? readText(sample);
    if (text === null) throw new ToolError('no_sample', `Cannot read the sample file ${sample}.`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new ToolError('bad_sample', `${sample} is not valid JSON: ${(e as Error).message}`);
    }
    if (keepValues) {
      warnings.push(`The mock for ${ep.name} holds the sample's values exactly as given (--keep-values). Check it for tokens or personal data before committing.`);
      return parsed;
    }
    const replaced = new Set<string>();
    const safe = scrubSample(parsed, map, replaced);
    if (replaced.size) warnings.push(`Replaced values that look like secrets or personal data in the ${ep.name} mock (${[...replaced].slice(0, 8).join(', ')}${replaced.size > 8 ? ', …' : ''}) with examples. Pass --keep-values to keep them.`);
    return safe;
  }
  const type = (ep.response ?? '').replace(/^Promise<(.*)>$/, '$1');
  if (!type || /^(void|unknown|dynamic)$/.test(type)) return ep.method === 'DELETE' ? null : {};
  const value = exampleFor(type, map);
  // Keep the envelope the code unwraps.
  const text = readText(join(root, ep.file)) ?? '';
  const decl = findDeclaration(text, ep.name, lang);
  const unwraps = decl && unwrapsData(text.slice(decl.start, decl.end), map.conventions);
  return unwraps ? { data: value } : value;
}

/** Does this function return the `data` field of a {"data": ...} envelope? (axios functions read res.data either way.) */
export function unwrapsData(declText: string, c: ProjectMap['conventions']): boolean {
  if (c.http === 'axios') return /res\.data\.data\b/.test(declText);
  return /res\.data\b|json\.data\b|\['data'\]/.test(declText);
}

// Path matching compares segments ({id} matches one segment), so dots and other
// characters in a path are literal. Older versions built a RegExp without escaping.
const tsMatcher = (q: string, semi: string) => [
  `    const want = pattern.split(${q}/${q})${semi}`,
  `    const got = pathname.split(${q}/${q})${semi}`,
  `    if (want.length === got.length && want.every((s, i) => /^\\{[^/{}]+\\}$/.test(s) || s === got[i])) return value${semi}`,
];
const OLD_TS_MATCHER = /^[ \t]*if \(new RegExp\(`\^\$\{pattern\.replace\(.*\)\.test\(pathname\)\) return value;?[ \t]*$/m;

const DART_MATCHER = [
  "      final want = entry.key.substring(space + 1).split('/');",
  "      final got = path.split('/');",
  '      if (want.length != got.length) continue;',
  '      var same = true;',
  '      for (var i = 0; i < want.length; i++) {',
  "        final param = want[i].startsWith('{') && want[i].endsWith('}');",
  '        if (!param && want[i] != got[i]) same = false;',
  '      }',
  '      if (same) return entry.value;',
];
const OLD_DART_MATCHER = /^[ \t]*final pattern = entry\.key\.substring\(space \+ 1\)\.replaceAll\(.*\n[ \t]*if \(RegExp\('\^\$pattern.*\.hasMatch\(path\)\) return entry\.value;[ \t]*$/m;

function indentJson(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).split('\n').join(`\n${indent}`);
}

// ---------------- Flutter ----------------

function flutterMocks(root: string, map: ProjectMap, eps: EndpointInfo[], sample: string | undefined, keepValues: boolean, force = false) {
  const kept: string[] = [];
  const c = map.conventions;
  const files = new Map<string, string>();
  const summary: string[] = [];
  const warnings: string[] = [];
  const network = c.networkFile || '';
  const dir = network ? `${posix.dirname(network)}/mocks` : 'lib/core/network/mocks';
  const responsesFile = `${dir}/mock_responses.dart`;
  const interceptorFile = `${dir}/mock_interceptor.dart`;

  let responses = readText(join(root, responsesFile)) ?? [
    '// Mock responses, used when the app runs with --dart-define=USE_MOCKS=true.',
    '// Managed by `devtool mock add`; edit the JSON freely.',
    'const mockResponses = <String, String>{',
    '};',
    '',
  ].join('\n');
  const eol = detectEol(responses);
  responses = responses.replace(/\r\n/g, '\n');
  for (const ep of eps) {
    const key = mockKey(ep);
    const escKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const existing = new RegExp(`(?:[ \\t]*// devtool:[0-9a-f]{10}[ \\t]*\\n)?  '${escKey}': r'''\\n([\\s\\S]*?)\\n''',`).exec(responses);
    if (existing && !sample && !force) {
      const at = responses.indexOf(`  '${key}': r`, existing.index);
      if (handEdited(responses, at, existing[1])) {
        kept.push(`${ep.name} (${key})`);
        continue;
      }
    }
    // Inside a Dart raw string r'''…''': a quote in the data is written as \u0027 (still valid JSON), so ''' can never end the string early.
    const json = JSON.stringify(bodyFor(root, ep, map, sample, 'dart', keepValues, warnings), null, 2).replace(/'/g, '\\u0027');
    const entry = `  ${markerFor(json)}\n  '${key}': r'''\n${json}\n''',`;
    if (existing) {
      responses = responses.slice(0, existing.index) + entry + responses.slice(existing.index + existing[0].length);
      summary.push(`Update the mock for ${ep.name} (${key})`);
    } else {
      const close = responses.lastIndexOf('};');
      responses = `${responses.slice(0, close)}${entry}\n${responses.slice(close)}`;
      summary.push(`Add a mock for ${ep.name} (${key})`);
    }
  }
  if (kept.length) warnings.push(`Kept mocks you edited by hand: ${kept.join(', ')}. Pass --force to regenerate them.`);
  files.set(responsesFile, withEol(responses, eol));

  const oldInterceptor = readText(join(root, interceptorFile));
  if (oldInterceptor !== null && OLD_DART_MATCHER.test(oldInterceptor.replace(/\r\n/g, '\n'))) {
    files.set(interceptorFile, withEol(oldInterceptor.replace(/\r\n/g, '\n').replace(OLD_DART_MATCHER, DART_MATCHER.join('\n')), detectEol(oldInterceptor)));
    summary.push(`Update ${interceptorFile}: match paths segment by segment (a "." in a path no longer matches any character)`);
  }
  if (oldInterceptor === null) {
    let interceptor = [
      '/// Answers requests from [mockResponses] instead of the network.',
      '///',
      '/// Turn it on with: flutter run --dart-define=USE_MOCKS=true',
      'class MockInterceptor extends Interceptor {',
      "  static const enabled = bool.fromEnvironment('USE_MOCKS');",
      '',
      '  @override',
      '  void onRequest(RequestOptions options, RequestInterceptorHandler handler) {',
      '    final body = _find(options.method, Uri.parse(options.path).path);',
      '    if (body == null) {',
      '      handler.next(options);',
      '      return;',
      '    }',
      '    handler.resolve(Response<dynamic>(requestOptions: options, statusCode: 200, data: jsonDecode(body)));',
      '  }',
      '',
      '  String? _find(String method, String path) {',
      '    for (final entry in mockResponses.entries) {',
      "      final space = entry.key.indexOf(' ');",
      '      if (entry.key.substring(0, space) != method.toUpperCase()) continue;',
      ...DART_MATCHER,
      '    }',
      '    return null;',
      '  }',
      '}',
    ].join('\n') + '\n';
    interceptor = addDartImport(interceptor, 'dart:convert');
    interceptor = addDartImport(interceptor, 'package:dio/dio.dart');
    interceptor = addDartImport(interceptor, importUri(interceptorFile, responsesFile, c));
    files.set(interceptorFile, interceptor);
    summary.push(`Create ${interceptorFile}: MockInterceptor, on only with --dart-define=USE_MOCKS=true`);

    const net = network ? readText(join(root, network)) : null;
    if (net !== null && !/MockInterceptor/.test(net)) {
      if (/^([ \t]*)return\s+dio\s*;/m.test(net)) {
        let t = net.replace(/\r\n/g, '\n');
        const r2 = /^([ \t]*)return\s+dio\s*;/m.exec(t)!;
        t = `${t.slice(0, r2.index)}${r2[1]}if (MockInterceptor.enabled) dio.interceptors.add(MockInterceptor());\n${t.slice(r2.index)}`;
        t = addDartImport(t, importUri(network, interceptorFile, c));
        files.set(network, withEol(t, detectEol(net)));
        summary.push(`Update ${network}: add MockInterceptor when USE_MOCKS is set`);
      } else if (/(?:=>|=)\s*Dio\s*\(/.test(net)) {
        // Dio created in an expression (a get_it factory, a field): add the interceptor with a cascade.
        let t = net.replace(/\r\n/g, '\n');
        const m = /(?:=>|=)\s*Dio\s*\(/.exec(t)!;
        const close = matchBrace(t, m.index + m[0].length - 1, 'dart');
        t = `${t.slice(0, close + 1)}..interceptors.addAll([if (MockInterceptor.enabled) MockInterceptor()])${t.slice(close + 1)}`;
        t = addDartImport(t, importUri(network, interceptorFile, c));
        files.set(network, withEol(t, detectEol(net)));
        summary.push(`Update ${network}: add MockInterceptor when USE_MOCKS is set`);
      } else {
        warnings.push(`Could not find "return dio;" in ${network}. Add this where Dio is created: if (MockInterceptor.enabled) dio.interceptors.add(MockInterceptor());`);
      }
    } else if (net === null) {
      warnings.push('No file that creates Dio was found. Add this where Dio is created: if (MockInterceptor.enabled) dio.interceptors.add(MockInterceptor());');
    }
  }
  summary.push('Run with mocks: flutter run --dart-define=USE_MOCKS=true');
  return { files, summary, warnings };
}

// ---------------- Next.js ----------------

function nextMocks(root: string, map: ProjectMap, eps: EndpointInfo[], sample: string | undefined, keepValues: boolean, force = false) {
  const kept: string[] = [];
  const c = map.conventions;
  const axiosMode = c.http === 'axios';
  if (axiosMode && !c.axiosInstanceFile) {
    throw new ToolError('not_supported', 'Mocks hook into a shared axios instance, and this project calls axios directly.', 'Create one (export const api = axios.create({ baseURL: ... })) and call it from your API functions, then run mock add again.');
  }
  const hookFile = axiosMode ? c.axiosInstanceFile : c.httpHelperFile;
  if (!axiosMode && (!c.httpHelper || c.httpHelper === 'fetch' || !c.httpHelperFile)) {
    throw new ToolError('not_supported', 'Mocks need a shared request helper (such as apiFetch) to hook into, and this project calls fetch directly.', 'A fresh project gets one with: devtool setup --architecture fetch-helper');
  }
  const files = new Map<string, string>();
  const summary: string[] = [];
  const warnings: string[] = [];
  const q = c.quote === 'double' ? '"' : "'";
  const semi = c.semicolons === 'false' ? '' : ';';
  const mocksFile = `${posix.dirname(hookFile)}/mocks.ts`;
  const rnFlag0 = map.framework === 'react-native' && !!c.configFile;
  // The env variable that turns mocks on: Next.js, Vite and Create React App each have their own prefix.
  const mockEnv = map.framework === 'react' ? (c.bundler === 'cra' ? 'REACT_APP_USE_MOCKS' : 'VITE_USE_MOCKS') : 'NEXT_PUBLIC_USE_MOCKS';
  const mockEnvRead = map.framework === 'react' && c.bundler !== 'cra' ? `import.meta.env.${mockEnv}` : `process.env.${mockEnv}`;
  let mocks = readText(join(root, mocksFile)) ?? [
    rnFlag0 ? '// Mock responses, used when USE_MOCKS is true.' : `// Mock responses, used when ${mockEnv}=true.`,
    '// Managed by `devtool mock add`; edit the values freely.',
    `export const mockResponses: Record<string, unknown> = {`,
    `}${semi}`,
    '',
    '/** Returns the mock for a request, or undefined when there is none. */',
    'export function findMock(method: string, path: string): unknown {',
    `  const pathname = path.split(${q}?${q})[0]${semi}`,
    '  for (const [key, value] of Object.entries(mockResponses)) {',
    `    const [m, pattern] = key.split(${q} ${q})${semi}`,
    `    if (m !== method.toUpperCase()) continue${semi}`,
    ...tsMatcher(q, semi),
    '  }',
    `  return undefined${semi}`,
    '}',
    '',
  ].join('\n');
  const eol = detectEol(mocks);
  mocks = mocks.replace(/\r\n/g, '\n');
  if (OLD_TS_MATCHER.test(mocks)) {
    mocks = mocks.replace(OLD_TS_MATCHER, tsMatcher(q, semi).join('\n'));
    summary.push(`Update ${mocksFile}: match paths segment by segment (a "." in a path no longer matches any character)`);
  }
  for (const ep of eps) {
    const key = mockKey(ep);
    const start = mocks.indexOf(`  ${q}${key}${q}: `);
    let vEnd = -1;
    if (start !== -1) {
      const vStart = start + `  ${q}${key}${q}: `.length;
      const ch = mocks[vStart];
      vEnd = ch === '{' || ch === '[' ? matchBrace(mocks, vStart) + 1 : mocks.indexOf('\n', vStart);
      if (mocks[vEnd - 1] === ',') vEnd--;
      if (!sample && !force && handEdited(mocks, start, mocks.slice(vStart, vEnd))) {
        kept.push(`${ep.name} (${key})`);
        continue;
      }
    }
    const value = indentJson(bodyFor(root, ep, map, sample, 'ts', keepValues, warnings), '  ');
    const entry = `  ${markerFor(value)}\n  ${q}${key}${q}: ${value},`;
    if (start !== -1) {
      // Replace the marker line above (if any), the key and the value.
      const lineStart = mocks.lastIndexOf('\n', start - 1);
      const prevStart = mocks.lastIndexOf('\n', lineStart - 1) + 1;
      const from = MARKER.test(mocks.slice(prevStart, lineStart + 1)) ? prevStart : start;
      let end = vEnd;
      if (mocks[end] === ',') end++;
      mocks = mocks.slice(0, from) + entry + mocks.slice(end);
      summary.push(`Update the mock for ${ep.name} (${key})`);
    } else {
      const open = mocks.indexOf('mockResponses: Record<string, unknown> = {');
      const close = matchBrace(mocks, mocks.indexOf('{', open));
      mocks = `${mocks.slice(0, close).replace(/\s*$/, '\n')}${entry}\n${mocks.slice(close)}`;
      summary.push(`Add a mock for ${ep.name} (${key})`);
    }
  }
  if (kept.length) warnings.push(`Kept mocks you edited by hand: ${kept.join(', ')}. Pass --force to regenerate them.`);
  files.set(mocksFile, withEol(mocks, eol));

  const helper = readText(join(root, hookFile)) ?? '';
  // React Native keeps the switch in its config file (USE_MOCKS); Next.js reads NEXT_PUBLIC_USE_MOCKS.
  const rnFlag = map.framework === 'react-native' && c.configFile ? c.configFile : '';
  const flag = rnFlag ? 'USE_MOCKS' : `${mockEnvRead} === ${q}true${q}`;
  const flagLabel = rnFlag ? `USE_MOCKS (${rnFlag}) is true` : `${mockEnv}=true`;
  const addImport = (t: string) => {
    const configPath = rnFlag ? importPath(hookFile, rnFlag, { ...c, importStyle: 'relative' }).replace(/\.tsx?$/, '') : '';
    let extra = '';
    if (rnFlag && !/import\s*\{[^}]*\bUSE_MOCKS\b/.test(t)) {
      // Join an existing import from the config file (import { API_URL } ...), or add one.
      const existing = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${configPath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}['"]`).exec(t);
      if (existing) t = t.replace(existing[0], existing[0].replace(existing[1], `${existing[1].trim()}, USE_MOCKS `.replace(/^/, ' ')));
      else extra = `\nimport { USE_MOCKS } from ${q}${configPath}${q}${semi}`;
    }
    const importLine = `import { findMock } from ${q}./mocks${q}${semi}${extra}`;
    const imports = [...t.matchAll(/^import[^\n]*\n/gm)];
    if (!imports.length) return `${importLine}\n\n${t}`;
    const at = imports[imports.length - 1].index! + imports[imports.length - 1][0].length;
    return t.slice(0, at) + importLine + '\n' + t.slice(at);
  };
  if (axiosMode && !/devtool: mock responses/.test(helper)) {
    // A request interceptor answers from the mocks (matched requests only) with a one-off adapter.
    const inst = (c.axiosInstance || '').replace(/^default:/, '');
    const create = new RegExp(`(?:export\\s+)?(?:const|let)\\s+${inst}\\s*=\\s*axios\\.create\\s*\\(`).exec(helper);
    const close = create ? matchBrace(helper, create.index + create[0].length - 1) : -1;
    if (!create || close === -1) {
      warnings.push(`Could not find ${inst} = axios.create(...) in ${hookFile}; add a request interceptor that calls findMock() yourself.`);
    } else {
      let t = helper.replace(/\r\n/g, '\n');
      let end = close + 1;
      if (t[end] === ';') end++;
      const block = [
        '',
        '',
        '// devtool: mock responses',
        `if (${flag}) {`,
        `  ${inst}.interceptors.request.use((config) => {`,
        `    const mock = findMock(config.method ?? ${q}get${q}, config.url ?? ${q}${q})${semi}`,
        `    if (mock !== undefined) config.adapter = async () => ({ data: mock, status: 200, statusText: ${q}OK${q}, headers: {}, config })${semi}`,
        `    return config${semi}`,
        `  })${semi}`,
        '}',
      ].join('\n');
      t = addImport(`${t.slice(0, end)}${block}${t.slice(end)}`);
      files.set(hookFile, withEol(t, detectEol(helper)));
      summary.push(`Update ${hookFile}: answer from mocks when ${flagLabel}`);
    }
  }
  if (!axiosMode && !/devtool: mock responses/.test(helper)) {
    const m = new RegExp(`export\\s+(?:async\\s+)?function\\s+${c.httpHelper}\\s*<[^>]*>\\s*\\(\\s*(\\w+)\\s*:[^,)]*(?:,\\s*(\\w+))?`).exec(helper);
    if (!m) {
      warnings.push(`Could not find ${c.httpHelper}() in ${c.httpHelperFile}; call findMock() from it yourself.`);
    } else {
      const method = m[2] ? `${m[2]}?.method ?? ${q}GET${q}` : `${q}GET${q}`;
      const block = [
        `  // devtool: mock responses`,
        `  if (${flag}) {`,
        `    const mock = findMock(${method}, ${m[1]})${semi}`,
        `    if (mock !== undefined) return mock as T${semi}`,
        '  }',
      ].join('\n');
      let t = helper.replace(/\r\n/g, '\n');
      const at = t.indexOf('{', matchBrace(t, t.indexOf('(', m.index)) + 1) + 1;
      t = `${t.slice(0, at)}\n${block}${t.slice(at)}`;
      t = addImport(t);
      files.set(c.httpHelperFile, withEol(t, detectEol(helper)));
      summary.push(`Update ${c.httpHelperFile}: answer from mocks when ${flagLabel}`);
    }
  }
  if (!rnFlag && !/devtool: mock responses/.test(helper)) {
    // .env.example only: devtool never writes .env.local, which may hold secrets.
    for (const envFile of ['.env.example']) {
      const env = readText(join(root, envFile));
      if (env !== null && !new RegExp(`${mockEnv}=`).test(env)) {
        files.set(envFile, `${env.replace(/\s*$/, '\n')}${mockEnv}=false\n`);
        summary.push(`Update ${envFile}: ${mockEnv}=false`);
      }
    }
  }
  summary.push(rnFlag ? (c.flavor === 'expo' ? 'Turn mocks on with EXPO_PUBLIC_USE_MOCKS=true in .env, then restart Expo.' : `Turn mocks on by setting USE_MOCKS = true in ${rnFlag}.`) : `Turn mocks on with ${mockEnv}=true in .env.local, then restart the dev server.`);
  return { files, summary, warnings };
}

export async function planMockAdd(root: string, adapter: Adapter, opts: MockOptions): Promise<ChangeSet> {
  if (adapter.id === 'generic') throw new ToolError('not_supported', 'mock add needs the Next.js, Flutter or React Native adapter.');
  if (adapter.id === 'android') throw new ToolError('not_supported', 'mock add does not support Android yet.', 'For offline tests, devtool test add writes MockWebServer tests; for the app, point ApiConfig.BASE_URL at a local mock server.');
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  let eps: EndpointInfo[];
  if (opts.all) eps = map.endpoints;
  else {
    eps = opts.endpoints.map((n) => {
      const ep = map.endpoints.find((e) => e.name === n) ?? map.endpoints.find((e) => e.name.toLowerCase() === n.toLowerCase());
      if (!ep) throw new ToolError('no_endpoint', `No endpoint called ${n} was found.`, `Endpoints in this project: ${map.endpoints.map((e) => e.name).join(', ') || 'none yet'}`);
      return ep;
    });
  }
  if (!eps.length) throw new ToolError('bad_args', 'Which endpoints? Usage: devtool mock add <endpoint> [<endpoint>...] or devtool mock add --all');
  if (opts.sample && eps.length > 1) throw new ToolError('bad_args', '--sample works with one endpoint at a time.');
  const r = adapter.id === 'flutter' ? flutterMocks(root, map, eps, opts.sample, opts.keepValues === true, opts.force === true) : nextMocks(root, map, eps, opts.sample, opts.keepValues === true, opts.force === true);
  return buildChangeSet(root, 'mock add', { ...r, generated: [] });
}
