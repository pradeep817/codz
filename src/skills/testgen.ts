// test add <endpoint>... | --all: unit tests for API functions, with the
// network faked so they run offline and fast.
//
//   Next.js   Vitest (or Jest when the project uses it): fetch, or the axios
//             instance's method, is replaced with a spy that answers example
//             data; the test checks the method, the URL and the parsed result,
//             and (for fetch) that a failed response throws.
//   Flutter   flutter_test: Dio gets a fake HttpClientAdapter; the test checks
//             the method, the path and the parsed result, and that a 500 throws
//             a DioException.
//
// Example data comes from the models, like mock add. One test file per API
// file; endpoints that already have a test are skipped.

import { join, posix } from 'node:path';
import { loadMap } from '../core/cache.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { loadConfig } from '../core/config.ts';
import { readJson, readText, walk } from '../core/fsutil.ts';
import { ToolError, type Adapter, type ChangeSet, type EndpointInfo, type ProjectMap } from '../core/types.ts';
import { readMethod, splitParams } from '../adapters/getx.ts';
import { importPath } from '../adapters/nextjs.ts';
import { findDeclaration } from './apiEdit.ts';
import { exampleFor, unwrapsData } from './mock.ts';

export interface TestOptions {
  endpoints: string[];
  all?: boolean;
}

function pick(map: ProjectMap, opts: TestOptions): EndpointInfo[] {
  if (opts.all) return map.endpoints;
  if (!opts.endpoints.length) throw new ToolError('bad_args', 'Which endpoints? Usage: devtool test add <endpoint>... or --all');
  return opts.endpoints.map((n) => {
    const ep = map.endpoints.find((e) => e.name === n) ?? map.endpoints.find((e) => e.name.toLowerCase() === n.toLowerCase());
    if (!ep) throw new ToolError('no_endpoint', `No endpoint called ${n} was found.`, `Endpoints: ${map.endpoints.map((e) => e.name).join(', ')}`);
    return ep;
  });
}

export async function planTestAdd(root: string, adapter: Adapter, opts: TestOptions): Promise<ChangeSet> {
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  const eps = pick(map, opts);
  if (!eps.length) throw new ToolError('no_endpoints', 'This project has no endpoints to test yet.', 'Add one with: devtool api add');
  if (adapter.id === 'nextjs' || adapter.id === 'react-native' || adapter.id === 'react') return nextTests(root, map, eps);
  if (adapter.id === 'flutter') return flutterTests(root, map, eps);
  if (adapter.id === 'android') return (await import('./androidTests.ts')).androidTests(root, map, eps);
  throw new ToolError('not_supported', `test add writes tests for Next.js, React, React Native, Flutter and Android; ${adapter.id === 'ios' ? 'iOS (XCTest) is not supported yet' : `this project uses the ${adapter.id} adapter`}.`, adapter.id === 'ios' ? 'Test the APIClient methods with XCTest and a URLProtocol stub for now; devtool will write these later.' : undefined);
}

/** Argument values for a call: path parameters get 1 or 'abc', the body gets example data. */
function exampleArg(type: string, name: string, map: ProjectMap): unknown {
  if (/^(number|int|double)$/.test(type)) return 1;
  if (/^(string|String)$/.test(type)) return name === 'id' || /Id$/.test(name) ? 'abc' : 'text';
  return exampleFor(type.replace(/^Partial<(.+)>$/, '$1'), map, name);
}

/** A JavaScript literal in the project's quote style. */
function tsLiteral(v: unknown, q: string): string {
  if (typeof v === 'string') return q === "'" ? `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : JSON.stringify(v);
  if (v === null || typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return `[${v.map((x) => tsLiteral(x, q)).join(', ')}]`;
  const IDENT = /^[A-Za-z_$][\w$]*$/;
  return `{ ${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${IDENT.test(k) ? k : tsLiteral(k, q)}: ${tsLiteral(x, q)}`).join(', ')} }`.replace('{  }', '{}');
}

const fill = (path: string, values: Map<string, unknown>) => path.replace(/\{([^/}]+)\}/g, (_m, n: string) => String(values.get(n) ?? values.get(n.replace(/[-_](\w)/g, (_x, ch: string) => ch.toUpperCase())) ?? 1));

// ---------------- Next.js ----------------

function nextTests(root: string, map: ProjectMap, eps: EndpointInfo[]): ChangeSet {
  const c = map.conventions;
  const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(join(root, 'package.json')) ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  // React Native apps test with Jest (jest-expo on Expo) even before it is installed; web apps default to Vitest.
  const rn = map.framework === 'react-native';
  const jest = !deps.vitest && (!!(deps.jest || deps['@types/jest'] || deps['jest-expo']) || rn);
  const spy = jest ? 'jest' : 'vi';
  const existingTests = walk(root, '.', { exts: ['.ts', '.tsx'] }).filter((f) => /\.(test|spec)\.tsx?$/.test(f));
  const inTestsFolder = existingTests.length > 0 && existingTests.filter((f) => f.includes('/__tests__/')).length * 2 > existingTests.length;
  const q = c.quote === 'double' ? '"' : "'";
  const semi = c.semicolons === 'false' ? '' : ';';
  const files = new Map<string, string>();
  const summary: string[] = [];
  const warnings: string[] = [];
  let warned204 = false;
  if (!deps.vitest && !jest) warnings.push('No test runner found in package.json; the tests are written for Vitest. Add it with: npm i -D vitest (then run npx vitest).');
  if (jest && !deps.jest && !deps['jest-expo']) warnings.push(c.flavor === 'expo' ? 'No test runner found in package.json; the tests are written for Jest. Add it with: npx expo install jest-expo jest (then run npx jest).' : 'No test runner found in package.json; the tests are written for Jest. Add it with: npm i -D jest (then run npx jest).');
  const axios = c.http === 'axios';
  const inst = (c.axiosInstance || 'axios').replace(/^default:/, '');

  const byFile = new Map<string, EndpointInfo[]>();
  for (const ep of eps) byFile.set(ep.file, [...(byFile.get(ep.file) ?? []), ep]);
  for (const [file, list] of byFile) {
    const dir = posix.dirname(file);
    const base = posix.basename(file).replace(/\.(tsx?|jsx?)$/, '');
    const testFile = inTestsFolder ? `${dir}/__tests__/${base}.test.ts` : `${dir}/${base}.test.ts`;
    let text = files.get(testFile) ?? readText(join(root, testFile)) ?? '';
    const src = readText(join(root, file)) ?? '';
    const helperText = c.httpHelperFile ? readText(join(root, c.httpHelperFile)) ?? files.get(c.httpHelperFile) ?? '' : '';
    const jsonOnly = /\.json\(\)/.test(helperText) && !/\b204\b|content-length|no content/i.test(helperText);
    const names: string[] = [];
    const blocks: string[] = [];
    for (const ep of list) {
      if (new RegExp(`describe\\(\\s*['"\`]${ep.name}['"\`]`).test(text)) continue;
      const decl = findDeclaration(src, ep.name, 'ts');
      if (!decl) {
        warnings.push(`Could not read ${ep.name} in ${file}; no test written for it.`);
        continue;
      }
      const args = splitParams(decl.params).map((p) => /^\s*(\w+)(\??)\s*:\s*([\s\S]+)$/.exec(p)).filter((m): m is RegExpExecArray => !!m);
      const values = new Map<string, unknown>();
      const callArgs: string[] = [];
      for (const [, name, optional, type] of args) {
        if (optional) continue;
        const v = exampleArg(type.trim(), name, map);
        values.set(name, v);
        callArgs.push(tsLiteral(v, q));
      }
      const type = (ep.response ?? '').replace(/^Promise<(.*)>$/, '$1');
      const voidish = !type || /^(void|unknown)$/.test(type) || ep.method === 'DELETE';
      const value = voidish ? null : exampleFor(type, map);
      const body = unwrapsData(src.slice(decl.start, decl.end), c) ? { data: value } : value;
      const url = fill(ep.path, values);
      const call = `${ep.name}(${callArgs.join(', ')})`;
      // A helper that always reads JSON throws on 204 No Content: test with an empty JSON reply, and say so once.
      const no204 = voidish && !axios && jsonOnly;
      if (no204 && !warned204) {
        warned204 = true;
        warnings.push(`${c.httpHelperFile}: ${c.httpHelper}() always reads the body as JSON, so a 204 No Content reply (common for DELETE) will throw "Unexpected end of JSON input". The tests reply 200 with null; to handle 204, return undefined when res.status === 204 before res.json().`);
      }
      const L: (string | null)[] = [`describe(${q}${ep.name}${q}, () => {`];
      if (axios) {
        const verb = ep.method.toLowerCase();
        L.push(
          `  it(${q}calls ${ep.method} ${ep.path} through ${inst} and returns the data${q}, async () => {`,
          `    const body = ${tsLiteral(body, q)}${semi}`,
          `    const request = ${spy}.spyOn(${inst}, ${q}${verb}${q}).mockResolvedValue({ data: body } as never)${semi}`,
          `    const result = await ${call}${semi}`,
          `    expect(String(request.mock.calls[0][0])).toContain(${q}${url}${q})${semi}`,
          voidish ? `    expect(result).toBeUndefined()${semi}` : `    expect(result).toEqual(${unwrapsData(src.slice(decl.start, decl.end), c) ? 'body.data' : 'body'})${semi}`,
          '  })' + semi,
        );
      } else {
        L.push(
          `  it(${q}calls ${ep.method} ${ep.path} and returns the parsed body${q}, async () => {`,
          `    const body = ${tsLiteral(body, q)}${semi}`,
          `    const fetchMock = ${spy}.spyOn(globalThis, ${q}fetch${q}).mockResolvedValue(new Response(${voidish ? (no204 ? `${q}null${q}` : 'null') : 'JSON.stringify(body)'}, { status: ${voidish && !no204 ? 204 : 200}, headers: { ${q}Content-Type${q}: ${q}application/json${q} } }))${semi}`,
          `    const result = await ${call}${semi}`,
          `    const [url, init] = fetchMock.mock.calls[0]${semi}`,
          `    expect(String(url)).toContain(${q}${url}${q})${semi}`,
          `    expect(init?.method ?? ${q}GET${q}).toBe(${q}${ep.method}${q})${semi}`,
          voidish ? null : `    expect(result).toEqual(${unwrapsData(src.slice(decl.start, decl.end), c) ? 'body.data' : 'body'})${semi}`,
          '  })' + semi,
          '',
          `  it(${q}throws when the server answers with an error${q}, async () => {`,
          `    ${spy}.spyOn(globalThis, ${q}fetch${q}).mockResolvedValue(new Response(${q}nope${q}, { status: 500 }))${semi}`,
          `    await expect(${call}).rejects.toThrow()${semi}`,
          '  })' + semi,
        );
      }
      L.push('})' + semi);
      blocks.push(L.filter((l) => l !== null).join('\n'));
      names.push(ep.name);
    }
    if (!names.length) continue;
    const own = inTestsFolder ? `../${base}` : `./${base}`;
    if (!text) {
      const header: string[] = [];
      // Jest's globals are imported from @jest/globals (installed with Jest), so they are typed without @types/jest.
      if (!jest || !deps['@types/jest'] || deps['@jest/globals']) header.push(`import { afterEach, describe, expect, it, ${spy} } from ${q}${jest ? '@jest/globals' : 'vitest'}${q}${semi}`);
      if (axios && inst !== 'axios' && c.axiosInstanceFile) {
        const p = importPath(testFile, c.axiosInstanceFile, { ...c, importStyle: 'relative' });
        header.push((c.axiosInstance ?? '').startsWith('default:') ? `import ${inst} from ${q}${p}${q}${semi}` : `import { ${inst} } from ${q}${p}${q}${semi}`);
      } else if (axios) header.push(`import axios from ${q}axios${q}${semi}`);
      header.push(`import { ${names.sort().join(', ')} } from ${q}${own}${q}${semi}`, '', `afterEach(() => {`, `  ${spy}.restoreAllMocks()${semi}`, `})${semi}`);
      text = header.join('\n');
    } else {
      // Add the tested functions to the import of the API file.
      const m = new RegExp(`import \\{([^}]*)\\} from ['"]${own.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}['"];?`).exec(text);
      if (m) {
        const have = m[1].split(',').map((x) => x.trim()).filter(Boolean);
        text = text.replace(m[0], `import { ${[...new Set([...have, ...names])].sort().join(', ')} } from ${q}${own}${q}${semi}`);
      } else text = `import { ${names.sort().join(', ')} } from ${q}${own}${q}${semi}\n${text}`;
    }
    text = `${text.replace(/\s*$/, '\n')}\n${blocks.join('\n\n')}\n`;
    files.set(testFile, text);
    summary.push(`${readText(join(root, testFile)) === null ? 'Create' : 'Update'} ${testFile}: tests for ${names.join(', ')}`);
  }
  if (!files.size) summary.push('Every chosen endpoint already has a test.');
  else summary.push(`Run them with: ${jest ? 'npx jest' : 'npx vitest run'}`);
  return buildChangeSet(root, 'test add', { files, summary, warnings, generated: [] });
}

// ---------------- Flutter ----------------

function dartLiteral(v: unknown, indent = ''): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$')}'`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const inner = `${indent}  `;
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => `${inner}${dartLiteral(x, inner)},`).join('\n')}\n${indent}]` : '[]';
  const entries = Object.entries(v as Record<string, unknown>);
  return entries.length ? `{\n${entries.map(([k, x]) => `${inner}${dartLiteral(k)}: ${dartLiteral(x, inner)},`).join('\n')}\n${indent}}` : '<String, dynamic>{}';
}

const FAKE_ADAPTER = [
  '/// Answers every request with [status] and [body], and remembers the request.',
  'class _FakeAdapter implements HttpClientAdapter {',
  '  _FakeAdapter(this.status, this.body);',
  '',
  '  final int status;',
  '  final Object? body;',
  '  RequestOptions? last;',
  '',
  '  @override',
  '  Future<ResponseBody> fetch(RequestOptions options, Stream<Uint8List>? requestStream, Future<void>? cancelFuture) async {',
  '    last = options;',
  '    return ResponseBody.fromString(jsonEncode(body), status, headers: {',
  '      Headers.contentTypeHeader: [Headers.jsonContentType],',
  '    });',
  '  }',
  '',
  '  @override',
  '  void close({bool force = false}) {}',
  '}',
].join('\n');

function flutterTests(root: string, map: ProjectMap, eps: EndpointInfo[]): ChangeSet {
  const c = map.conventions;
  const pkg = c.packageName;
  const files = new Map<string, string>();
  const summary: string[] = [];
  const warnings: string[] = [];
  const pubspec = readText(join(root, 'pubspec.yaml')) ?? '';
  if (!/^\s+flutter_test:/m.test(pubspec)) warnings.push('flutter_test is not in dev_dependencies; add it (it ships with the Flutter SDK): dev_dependencies: flutter_test: sdk: flutter');
  const byFile = new Map<string, EndpointInfo[]>();
  for (const ep of eps) byFile.set(ep.file, [...(byFile.get(ep.file) ?? []), ep]);
  for (const [file, list] of byFile) {
    const testFile = `test/${file.replace(/^lib\//, '').replace(/\.dart$/, '_test.dart')}`;
    const existing = files.get(testFile) ?? readText(join(root, testFile));
    const src = readText(join(root, file)) ?? '';
    const groups: string[] = [];
    const names: string[] = [];
    const modelFiles = new Set<string>();
    for (const ep of list) {
      const sig = readMethod(src, ep.name);
      if (!sig?.repoClass) {
        warnings.push(`Could not read ${ep.name} in ${file}; no test written for it.`);
        continue;
      }
      if (existing && new RegExp(`group\\(\\s*'${sig.repoClass}\\.${ep.name}'`).test(existing)) continue;
      const ctorTakesDio = new RegExp(`\\b${sig.repoClass}\\s*\\(\\s*(?:this\\.\\w+|Dio\\s+\\w+)\\s*[,)]|factory\\s+${sig.repoClass}\\s*\\(\\s*Dio\\b`).test(src);
      if (!ctorTakesDio) {
        warnings.push(`${sig.repoClass} does not take its Dio in the constructor, so ${ep.name} cannot be tested with a fake adapter; no test written.`);
        continue;
      }
      const values = new Map<string, unknown>();
      const args: string[] = [];
      for (const part of splitParams(sig.params.replace(/@\w+(?:\([^)]*\))?\s*/g, ''))) {
        if (part.startsWith('{') || part.startsWith('[')) continue; // optional query parameters
        const m = /^([\w<>?, ]+?)\s+(\w+)$/.exec(part.trim());
        if (!m) continue;
        const [type, name] = [m[1].trim(), m[2]];
        if (name === 'body') {
          const model = map.models.find((x) => x.name === type.replace(/\?$/, ''));
          if (model) {
            args.push(`${model.name}.fromJson(${dartLiteral(exampleFor(model.name, map), '        ')})`);
            if (model.file !== file) modelFiles.add(model.file);
          } else args.push(dartLiteral(exampleFor(type, map, name)));
          continue;
        }
        const v = /^int\??$/.test(type) ? 1 : /^double\??$/.test(type) ? 1.5 : 'abc';
        values.set(name, v);
        args.push(dartLiteral(v));
      }
      const type = sig.returnType;
      const voidish = /^void$/.test(type) || ep.method === 'DELETE';
      const value = voidish ? null : exampleFor(type, map);
      const decl = findDeclaration(src, ep.name, 'dart');
      const body = decl && unwrapsData(src.slice(decl.start, decl.end), c) ? { data: value } : value;
      const list2 = /^List<(.+)>$/.exec(type);
      const model = map.models.find((m) => m.name === (list2?.[1] ?? type).replace(/\?$/, ''));
      if (model && model.file !== file) modelFiles.add(model.file);
      const expectResult = voidish ? null : list2 ? `      expect(result, hasLength(${Array.isArray(value) ? value.length : 1}));` : model ? `      expect(result, isA<${model.name}>());` : '      expect(result, isNotNull);';
      const call = `${sig.repoClass}(dio).${ep.name}(${args.join(', ')})`;
      groups.push(
        [
          `  group('${sig.repoClass}.${ep.name}', () {`,
          `    test('calls ${ep.method} ${ep.path} and parses the response', () async {`,
          `      final adapter = _FakeAdapter(${voidish ? 204 : 200}, ${dartLiteral(body, '      ')});`,
          "      final dio = Dio(BaseOptions(baseUrl: 'https://api.test'))..httpClientAdapter = adapter;",
          `      ${voidish ? '' : 'final result = '}await ${call};`,
          `      expect(adapter.last!.method, '${ep.method}');`,
          `      expect(adapter.last!.uri.path, endsWith('${fill(ep.path, values).replace(/^https?:\/\/[^/]+/, '')}'));`,
          expectResult,
          '    });',
          '',
          "    test('throws when the server fails', () async {",
          "      final dio = Dio(BaseOptions(baseUrl: 'https://api.test'))..httpClientAdapter = _FakeAdapter(500, {'error': 'nope'});",
          `      await expectLater(${call}, throwsA(isA<DioException>()));`,
          '    });',
          '  });',
        ]
          .filter((l) => l !== null)
          .join('\n'),
      );
      names.push(ep.name);
    }
    if (!names.length) continue;
    let text: string;
    const uri = (f: string) => (pkg ? `package:${pkg}/${f.replace(/^lib\//, '')}` : posix.relative(posix.dirname(testFile), f));
    if (existing) {
      const close = existing.lastIndexOf('}');
      text = `${existing.slice(0, close).replace(/\s*$/, '\n')}\n${groups.join('\n\n')}\n}\n`;
      for (const f of modelFiles) if (!existing.includes(uri(f))) text = text.replace(/(import 'package:flutter_test\/flutter_test.dart';\n)/, `$1import '${uri(f)}';\n`);
    } else {
      const imports = ["import 'dart:convert';", "import 'dart:typed_data';", '', "import 'package:dio/dio.dart';", "import 'package:flutter_test/flutter_test.dart';", `import '${uri(file)}';`, ...[...modelFiles].sort().map((f) => `import '${uri(f)}';`)];
      text = [...imports, '', FAKE_ADAPTER, '', 'void main() {', groups.join('\n\n'), '}', ''].join('\n');
    }
    files.set(testFile, text);
    summary.push(`${existing ? 'Update' : 'Create'} ${testFile}: tests for ${names.join(', ')}`);
  }
  if (!files.size) summary.push('Every chosen endpoint already has a test.');
  else summary.push('Run them with: flutter test');
  return buildChangeSet(root, 'test add', { files, summary, warnings, generated: [] });
}
