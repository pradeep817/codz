// Tests for the screens screen add writes: the screen with its API answered by
// a fake, checking what the user sees while loading, with data, with an empty
// list, and after an error (the Retry button).
//
//   Flutter   a widget test: the repository on a Dio with a fake adapter, put
//             where the screen gets it (Riverpod override, get_it, Bloc
//             RepositoryProvider, GetX Get.put).
//
// Other frameworks test the screen's state holder; see the functions below.

import { join, posix } from 'node:path';
import { readMethod } from '../adapters/getx.ts';
import { addKotlinImports } from '../adapters/kotlinGen.ts';
import { converter, ensureAndroidTestLibs } from './androidTests.ts';
import * as iosHelpers from './iosTests.ts';
import { readText } from '../core/fsutil.ts';
import type { EndpointInfo, ModelInfo, ProjectMap } from '../core/types.ts';
import { camel } from '../input/naming.ts';
import { exampleFor, unwrapsData } from './mock.ts';
import { dartLiteral } from './testgen.ts';
import { findDeclaration } from './apiEdit.ts';

export interface ScreenTestInput {
  /** The screen's file and the planned files of the change (the screen may only exist there). */
  files: Map<string, string>;
  ep: EndpointInfo;
  /** Route parameters the screen takes. */
  params: string[];
  paged: boolean;
}

export interface ScreenTest {
  file: string;
  text: string;
  summary: string;
  warnings: string[];
  /** Other files the test needs changed (build files for test libraries). */
  extra?: Map<string, string>;
  extraSummary?: string[];
}

/** What the first item shows: the title field's value as text, if there is one. */
function shownText(model: ModelInfo | undefined, value: unknown): string | null {
  if (!model || !value || typeof value !== 'object') return null;
  const pick = ['name', 'title', 'label', 'display_name', 'full_name', 'email', 'username', 'sku', 'id'].find((n) => model.fields.some((f) => f.name === n)) ?? model.fields[0]?.name;
  const v = pick ? (value as Record<string, unknown>)[pick] : undefined;
  if (v === undefined || v === null || typeof v === 'object') return null;
  // A DateTime field would show as Dart prints it; skip those.
  if (model.fields.find((f) => f.name === pick)?.type === 'DateTime') return null;
  return String(v);
}

const MULTI_ADAPTER = [
  '/// Answers requests in turn with [bodies] (the last one again after that), all with [status].',
  'class _FakeApi implements HttpClientAdapter {',
  '  _FakeApi(this.status, this.bodies);',
  '',
  '  final int status;',
  '  final List<Object?> bodies;',
  '  int calls = 0;',
  '',
  '  @override',
  '  Future<ResponseBody> fetch(RequestOptions options, Stream<Uint8List>? requestStream, Future<void>? cancelFuture) async {',
  '    final body = bodies[calls < bodies.length ? calls : bodies.length - 1];',
  '    calls++;',
  '    return ResponseBody.fromString(jsonEncode(body), status, headers: {',
  '      Headers.contentTypeHeader: [Headers.jsonContentType],',
  '    });',
  '  }',
  '',
  '  @override',
  '  void close({bool force = false}) {}',
  '}',
].join('\n');

/** A Flutter widget test for a data screen, or null (with a reason) when it cannot be written. */
export function flutterScreenTest(root: string, map: ProjectMap, input: ScreenTestInput): ScreenTest | { skip: string } {
  const c = map.conventions;
  const pkg = c.packageName;
  if (!pkg) return { skip: 'pubspec.yaml has no name, so the test cannot import the app' };
  const read = (f: string) => input.files.get(f) ?? readText(join(root, f));
  // The screen: a new Dart file with a widget class (a GetX module's view).
  const screen = [...input.files].find(([f, t]) => f.endsWith('.dart') && read(f) !== null && !readText(join(root, f)) && /class\s+\w+\s+extends\s+(StatelessWidget|StatefulWidget|ConsumerStatefulWidget|ConsumerWidget|GetView<\w+>)/.test(t) && !/_controller\.dart$|_binding\.dart$/.test(f));
  if (!screen) return { skip: 'no screen widget in the change' };
  const [screenFile, screenText] = screen;
  const widget = /class\s+(\w+)\s+extends\s+(StatelessWidget|StatefulWidget|ConsumerStatefulWidget|ConsumerWidget|GetView<(\w+)>)/.exec(screenText)!;
  const cls = widget[1];
  const controller = widget[3];
  const repoText = read(input.ep.file) ?? '';
  const sig = readMethod(repoText, input.ep.name);
  if (!sig?.repoClass) return { skip: `could not read ${input.ep.name}` };
  const repo = sig.repoClass;
  if (!new RegExp(`\\b${repo}\\s*\\(\\s*(?:this\\.\\w+|Dio\\s+\\w+)\\s*[,)]|factory\\s+${repo}\\s*\\(\\s*Dio\\b`).test(repoText)) return { skip: `${repo} does not take its Dio in the constructor, so it cannot be given a fake one` };
  const type = sig.returnType;
  const list = /^List<(.+)>\??$/.exec(type);
  const model = map.models.find((m) => m.name === (list?.[1] ?? type).replace(/\?$/, ''));
  const value = exampleFor(list ? `${list[1]}[]` : type, map);
  const decl = findDeclaration(repoText, input.ep.name, 'dart');
  const wrap = (v: unknown) => (decl && unwrapsData(repoText.slice(decl.start, decl.end), c) ? { data: v } : v);
  const first = list ? (Array.isArray(value) ? value[0] : null) : value;
  const expected = shownText(model, first);
  if (!expected) return { skip: 'nothing on the screen codz can check for (no text field to look for)' };
  const uri = (f: string) => `package:${pkg}/${f.replace(/^lib\//, '')}`;
  const getx = Boolean(controller);
  const riverpod = !getx && c.di === 'riverpod';
  const getIt = !getx && c.di === 'get_it';
  const bloc = !getx && c.stateManagement === 'bloc';
  if (getx && input.params.length) return { skip: `${cls} reads ${input.params.join(', ')} from Get.parameters, which a widget test does not set` };
  if (!getx && !riverpod && !getIt && !bloc) return { skip: `screens here get ${repo} through "${c.di || 'nothing'}", which the test cannot replace` };
  const gi = c.diInstance || 'getIt';
  const args = input.params.map((p) => `${p}: '1'`).join(', ');
  const make = getx ? `const ${cls}()` : `${widget[2] === 'StatelessWidget' || widget[2] === 'ConsumerWidget' ? 'const ' : 'const '}${cls}(${args})`;
  const app = (child: string) => (getx ? `GetMaterialApp(home: ${child})` : `MaterialApp(home: ${child})`);
  const host = (repoExpr: string) => {
    if (riverpod) return `ProviderScope(overrides: [${camel(repo)}Provider.overrideWithValue(${repoExpr})], child: ${app(make)})`;
    if (bloc && !getIt) return `RepositoryProvider<${repo}>.value(value: ${repoExpr}, child: ${app(make)})`;
    return app(make);
  };
  const setup = (bodiesVar: string, status: number) => {
    const repoExpr = `${repo}(Dio(BaseOptions(baseUrl: 'https://api.test'))..httpClientAdapter = _FakeApi(${status}, ${bodiesVar}))`;
    if (getx) return [`    Get.put<${repo}>(${repoExpr});`, `    Get.put(${controller}());`, `    await tester.pumpWidget(${host('')});`];
    if (getIt) return [`    ${gi}.registerSingleton<${repo}>(${repoExpr});`, `    await tester.pumpWidget(${host('')});`];
    return [`    await tester.pumpWidget(${host(repoExpr)});`];
  };
  const items = dartLiteral(wrap(value), '    ');
  const pagedBodies = (v: string) => (input.paged ? `[${v}, ${dartLiteral(wrap([]))}]` : `[${v}]`);
  const tests = [
    `  testWidgets('${cls} shows a spinner, then the data', (tester) async {`,
    `    final data = ${items};`,
    ...setup(pagedBodies('data'), 200),
    '    expect(find.byType(CircularProgressIndicator), findsWidgets);',
    '    await tester.pumpAndSettle();',
    `    expect(find.text(${dartLiteral(expected)}), findsWidgets);`,
    '  });',
    ...(list
      ? ['', `  testWidgets('${cls} says when there is nothing to show', (tester) async {`, ...setup(`[${dartLiteral(wrap([]))}]`, 200), '    await tester.pumpAndSettle();', "    expect(find.text('No items'), findsOneWidget);", '  });']
      : []),
    '',
    `  testWidgets('${cls} shows the error with Retry', (tester) async {`,
    ...setup("[{'error': 'nope'}]", 500),
    '    await tester.pumpAndSettle();',
    "    expect(find.text('Retry'), findsOneWidget);",
    '  });',
  ];
  const imports = [
    "import 'dart:convert';",
    "import 'dart:typed_data';",
    '',
    "import 'package:dio/dio.dart';",
    "import 'package:flutter/material.dart';",
    ...(riverpod ? ["import 'package:flutter_riverpod/flutter_riverpod.dart';"] : []),
    ...(bloc && !getIt ? ["import 'package:flutter_bloc/flutter_bloc.dart';"] : []),
    "import 'package:flutter_test/flutter_test.dart';",
    ...(getx ? ["import 'package:get/get.dart';"] : []),
    ...[uri(screenFile), uri(input.ep.file), ...(getIt && c.diFile ? [uri(c.diFile)] : []), ...(getx ? [uri(screenFile.replace(/\/views\/(\w+)_view\.dart$/, '/controllers/$1_controller.dart'))] : [])].filter((v, i, a) => a.indexOf(v) === i).sort().map((u) => `import '${u}';`),
  ];
  const teardown = getx ? ['  tearDown(Get.reset);', ''] : getIt ? [`  setUp(() async => ${gi}.reset());`, ''] : [];
  const file = `test/${screenFile.replace(/^lib\//, '').replace(/\.dart$/, '_test.dart')}`;
  const text = [...imports, '', MULTI_ADAPTER, '', 'void main() {', ...teardown, ...tests, '}', ''].join('\n');
  return { file, text, summary: `Create ${file}: ${cls} while loading, with data${list ? ', empty' : ''}, and after an error (Retry)`, warnings: [] };
}

export const screenTestPath = (screenFile: string) => `test/${posix.normalize(screenFile).replace(/^lib\//, '').replace(/\.dart$/, '_test.dart')}`;

// ---------- Android: the ViewModel ----------

/**
 * A JVM test for the ViewModel of an Android screen (Compose or Views): the real
 * Retrofit interface on a MockWebServer, the ViewModel made with it (and a
 * SavedStateHandle with the route parameters), and its states after a good and
 * a failed answer.
 */
export function androidScreenTest(root: string, map: ProjectMap, input: ScreenTestInput): ScreenTest | { skip: string } {
  const c = map.conventions;
  const read = (f: string) => input.files.get(f) ?? readText(join(root, f));
  const vmEntry = [...input.files].find(([f, t]) => f.endsWith('ViewModel.kt') && readText(join(root, f)) === null && /:\s*ViewModel\(\)/.test(t));
  if (!vmEntry) return { skip: 'no ViewModel in the change' };
  const [vmFile, vmText] = vmEntry;
  const vm = /class\s+(\w+)/.exec(vmText.replace(/^data class .*$/gm, ''))?.[1];
  const pkg = /^package\s+([\w.]+)/m.exec(vmText)?.[1];
  if (!vm || !pkg) return { skip: 'could not read the ViewModel' };
  const apiText = read(input.ep.file) ?? '';
  const iface = /\binterface\s+(\w+)/.exec(apiText)?.[1];
  const apiPkg = /^package\s+([\w.]+)/m.exec(apiText)?.[1];
  if (!iface || !apiPkg) return { skip: `could not read the Retrofit interface in ${input.ep.file}` };
  const ret = (input.ep.response ?? '').trim();
  const sample = exampleFor(ret, map, '');
  if (sample === null || sample === undefined) return { skip: `no example data for ${ret || 'the response'}` };
  const isList = Array.isArray(sample);
  const paged = /data class \w+ListState\(/.test(vmText);
  const handle = /savedStateHandle:\s*SavedStateHandle/.test(vmText);
  const make = `${vm}(api${handle ? `, SavedStateHandle(mapOf(${input.params.map((p) => `"${p}" to "1"`).join(', ')}))` : ''})`;
  const conv = converter(c.serialization || 'kotlinx');
  const body = JSON.stringify(JSON.stringify(sample)).replace(/\$/g, '\\$');
  const settled = paged ? '{ !it.loading && (it.items.isNotEmpty() || it.error != null) }' : '{ it !is UiState.Loading }';
  const tests = [
    '    @Test',
    `    fun \`shows the data\`() = runBlocking {`,
    `        server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody(${body}))`,
    `        val vm = ${make}`,
    '',
    `        val state = withTimeout(5_000) { vm.state.first ${settled} }`,
    '',
    ...(paged
      ? ['        assertNull(state.error)', `        assertEquals(${isList ? sample.length : 1}, state.items.size)`]
      : ['        assertTrue(state is UiState.Success)', ...(isList ? [`        assertEquals(${sample.length}, (state as UiState.Success).data.size)`] : [])]),
    '    }',
    '',
    '    @Test',
    `    fun \`shows the error when the server fails\`() = runBlocking {`,
    '        server.enqueue(MockResponse().setResponseCode(500))',
    `        val vm = ${make}`,
    '',
    `        val state = withTimeout(5_000) { vm.state.first ${settled} }`,
    '',
    ...(paged ? ['        assertNotNull(state.error)'] : ['        assertTrue(state is UiState.Error)']),
    '    }',
  ];
  const srcDir = c.srcDir || 'app/src/main/java';
  const testDir = srcDir.replace(/\/main\//, '/test/');
  const file = `${testDir}/${pkg.replace(/\./g, '/')}/${vm}Test.kt`;
  const uiState = paged ? [] : [classOfUiState(input.files, vmText, pkg)].filter((x): x is string => !!x);
  const imports = [
    `${apiPkg}.${iface}`,
    ...conv.imports,
    ...uiState,
    ...(handle ? ['androidx.lifecycle.SavedStateHandle'] : []),
    'kotlinx.coroutines.Dispatchers',
    'kotlinx.coroutines.ExperimentalCoroutinesApi',
    'kotlinx.coroutines.flow.first',
    'kotlinx.coroutines.runBlocking',
    'kotlinx.coroutines.test.UnconfinedTestDispatcher',
    'kotlinx.coroutines.test.resetMain',
    'kotlinx.coroutines.test.setMain',
    'kotlinx.coroutines.withTimeout',
    'okhttp3.mockwebserver.MockResponse',
    'okhttp3.mockwebserver.MockWebServer',
    'org.junit.After',
    'org.junit.Assert.assertEquals',
    'org.junit.Assert.assertNotNull',
    'org.junit.Assert.assertNull',
    'org.junit.Assert.assertTrue',
    'org.junit.Before',
    'org.junit.Test',
    'retrofit2.Retrofit',
  ];
  let text = [
    `package ${pkg}`,
    '',
    '@OptIn(ExperimentalCoroutinesApi::class)',
    `class ${vm}Test {`,
    '    private val server = MockWebServer()',
    `    private lateinit var api: ${iface}`,
    '',
    '    @Before',
    '    fun setUp() {',
    '        Dispatchers.setMain(UnconfinedTestDispatcher())',
    '        server.start()',
    '        api = Retrofit.Builder()',
    '            .baseUrl(server.url("/"))',
    `            .addConverterFactory(${conv.expr})`,
    '            .build()',
    `            .create(${iface}::class.java)`,
    '    }',
    '',
    '    @After',
    '    fun tearDown() {',
    '        server.shutdown()',
    '        Dispatchers.resetMain()',
    '    }',
    '',
    ...tests,
    '}',
    '',
  ].join('\n');
  text = addKotlinImports(text, imports, pkg);
  const body2 = text.replace(/^import .*$/gm, '');
  for (const [fn, imp] of [['assertEquals(', 'org.junit.Assert.assertEquals'], ['assertNotNull(', 'org.junit.Assert.assertNotNull'], ['assertNull(', 'org.junit.Assert.assertNull'], ['assertTrue(', 'org.junit.Assert.assertTrue']] as const) if (!body2.includes(fn)) text = text.replace(new RegExp(`^import ${imp.replace(/\./g, '\\.')}\\n`, 'm'), '');
  const extra = new Map<string, string>([[file, text]]);
  const extraSummary: string[] = [];
  ensureAndroidTestLibs(map, (p) => extra.get(p) ?? read(p), extra, extraSummary, []);
  extra.delete(file);
  return { file, text, summary: `Create ${file}: ${vm} with data and after a server error`, warnings: [], extra, extraSummary };
}

/** The UiState class the ViewModel uses (its import, when it is in another package). */
function classOfUiState(files: Map<string, string>, vmText: string, pkg: string): string | null {
  const imp = /^import\s+([\w.]+\.UiState)$/m.exec(vmText)?.[1];
  if (imp) return imp;
  void files;
  void pkg;
  return null;
}

// ---------- iOS: the view model ----------

/** An XCTest for the view model of a SwiftUI screen: load() with the API answered by StubURLProtocol, then its state. */
export function iosScreenTest(root: string, map: ProjectMap, input: ScreenTestInput): ScreenTest | { skip: string } {
  const vmEntry = [...input.files].find(([f, t]) => f.endsWith('ViewModel.swift') && readText(join(root, f)) === null && /final class \w+: ObservableObject/.test(t));
  if (!vmEntry) return { skip: 'no view model in the change' };
  const [, vmText] = vmEntry;
  const vm = /final class (\w+): ObservableObject/.exec(vmText)![1];
  const init = /init\(([^)]*)\)/.exec(vmText)?.[1] ?? '';
  const args = init
    .split(',')
    .map((p) => /^\s*(\w+)\s*:\s*([\w?]+)/.exec(p))
    .filter((m): m is RegExpExecArray => !!m && m[1] !== 'api')
    .map((m) => `${m[1]}: ${/^Int\??$/.test(m[2]) ? '1' : /^Double\??$/.test(m[2]) ? '1.0' : '"1"'}`);
  const sample = exampleFor(input.ep.response ?? '', map, '');
  if (sample === null || sample === undefined) return { skip: `no example data for ${input.ep.response}` };
  const paged = /@Published private\(set\) var items:/.test(vmText);
  const load = paged ? (/func load\(reset: Bool/.test(vmText) ? 'load(reset: true)' : 'load()') : 'load()';
  const I = ' '.repeat(Number(map.conventions.indent) || 4);
  const files = new Map(input.files);
  const summary: string[] = [];
  const { ensureIosTestSetup } = iosHelpers;
  let target: { folder: string; module: string };
  try {
    target = ensureIosTestSetup(root, map, files, summary, I);
  } catch (e) {
    return { skip: (e as Error).message.replace(/\.$/, '') };
  }
  const make = `${vm}(${[...args, 'api: APIClient(baseURL: URL(string: "https://api.test")!, session: StubURLProtocol.session())'].join(', ')})`;
  const isList = Array.isArray(sample);
  const L = (d: number, s: string) => `${I.repeat(d)}${s}`;
  const text = [
    'import XCTest',
    `@testable import ${target.module}`,
    '',
    `/// ${vm} with the API answered by StubURLProtocol (codz screen add).`,
    '@MainActor',
    `final class ${vm}Tests: XCTestCase {`,
    L(1, 'func testShowsTheData() async {'),
    L(2, 'StubURLProtocol.status = 200'),
    L(2, `StubURLProtocol.body = Data(#"${JSON.stringify(sample)}"#.utf8)`),
    L(2, `let model = ${make}`),
    L(2, `await model.${load}`),
    ...(paged
      ? [L(2, 'XCTAssertNil(model.error)'), L(2, `XCTAssertEqual(model.items.count, ${isList ? sample.length : 1})`)]
      : [L(2, 'guard case .loaded(let data) = model.state else {'), L(3, 'return XCTFail("Expected data, got \\(model.state)")'), L(2, '}'), L(2, isList ? `XCTAssertEqual(data.count, ${sample.length})` : '_ = data')]),
    L(1, '}'),
    '',
    L(1, 'func testShowsTheErrorWhenTheServerFails() async {'),
    L(2, 'StubURLProtocol.status = 500'),
    L(2, 'StubURLProtocol.body = Data(#"{"error":"boom"}"#.utf8)'),
    L(2, `let model = ${make}`),
    L(2, `await model.${load}`),
    ...(paged ? [L(2, 'XCTAssertNotNil(model.error)')] : [L(2, 'guard case .failed = model.state else {'), L(3, 'return XCTFail("Expected an error, got \\(model.state)")'), L(2, '}')]),
    L(1, '}'),
    '}',
    '',
  ].join('\n');
  const file = `${target.folder}/${vm}Tests.swift`;
  const extra = new Map([...files].filter(([f]) => !input.files.has(f) || input.files.get(f) !== files.get(f)));
  return { file, text, summary: `Create ${file}: ${vm} with data and after a server error`, warnings: [], extra, extraSummary: summary };
}

// ---------- React, React Native, Next.js: the screen with its API mocked ----------

const TL_VERSIONS = { '@testing-library/react': '^16.1.0', '@testing-library/dom': '^10.4.0', jsdom: '^25.0.1', 'jest-environment-jsdom': '^29.7.0', '@testing-library/react-native': '^12.9.0', '@vitejs/plugin-react': '^4.3.4', 'vite-tsconfig-paths': '^5.1.4' };

/**
 * A Testing Library test for a React, React Native or Next.js data screen: the
 * API module mocked (so fetch, axios and TanStack Query all work), the screen
 * rendered in the router or query provider it needs, and checks for the data,
 * the empty message and Retry (a Next.js server page throws instead, for its
 * error.tsx).
 */
export function jsScreenTest(root: string, map: ProjectMap, input: ScreenTestInput & { route?: string }): ScreenTest | { skip: string } {
  const c = map.conventions;
  const fw = map.framework;
  const page = [...input.files].find(([f, t]) => /\.(tsx|jsx)$/.test(f) && !/\.test\./.test(f) && readText(join(root, f)) === null && /export default (?:async )?function \w+/.test(t) && !/loading\.|error\./.test(posix.basename(f)));
  if (!page) return { skip: 'no screen component in the change' };
  const [pageFile, pageText] = page;
  const comp = /export default (async )?function (\w+)/.exec(pageText)!;
  const serverPage = fw === 'nextjs' && Boolean(comp[1]);
  const pkgText = readText(join(root, 'package.json')) ?? '{}';
  const pkg = JSON.parse(pkgText) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const rn = fw === 'react-native';
  const jest = !deps.vitest && (Boolean(deps.jest || deps['@types/jest'] || deps['jest-expo']) || rn);
  const m = jest ? 'jest' : 'vi';
  const ret = (input.ep.response ?? '').replace(/^Promise<(.*)>$/, '$1').trim();
  const sample = exampleFor(ret, map, '');
  if (sample === null || sample === undefined) return { skip: `no example data for ${ret || 'the response'}` };
  const isList = Array.isArray(sample);
  const model = map.models.find((x) => x.name === ret.replace(/\[\]$/, ''));
  const expected = shownText(model, isList ? sample[0] : sample);
  if (!expected) return { skip: 'nothing on the screen codz can check for (no text field to look for)' };
  // Expo Router would treat a test file under app/ as a route: those tests go in __tests__/.
  const testFile = (rn && pageFile.startsWith('app/') ? `__tests__/${pageFile}` : pageFile).replace(/\.(tsx|jsx)$/, '.test.$1');
  const rel = (to: string) => {
    let r = posix.relative(posix.dirname(testFile), to.replace(/\.(tsx?|jsx?)$/, ''));
    if (!r.startsWith('.')) r = `./${r}`;
    return r;
  };
  const apiPath = rel(input.ep.file);
  const pagePath = rel(pageFile);
  const q = "'";
  const fn = input.ep.name;
  const usesQuery = /@tanstack\/react-query/.test(pageText) || /\buse[A-Z]\w*\(/.test(pageText) && /from ['"][^'"]*hooks/.test(pageText);
  const usesRouter = /from ['"]react-router(-dom)?['"]/.test(pageText);
  const usesNav = /from ['"]@react-navigation\/native['"]/.test(pageText);
  const usesExpoRouter = /from ['"]expo-router['"]/.test(pageText);
  const takesRoute = /\(\{\s*route\b/.test(pageText) || /route\.params/.test(pageText);
  const paramsObj = `{ ${input.params.map((p) => `${p}: '1'`).join(', ')} }`;
  // How the screen is rendered.
  let element = `<${comp[2]} />`;
  if (rn && takesRoute) element = `<${comp[2]} {...({ route: { params: ${paramsObj} }, navigation: { navigate: ${m}.fn(), goBack: ${m}.fn(), addListener: () => () => {} } } as any)} />`;
  if (usesRouter) {
    const route = (input.route ?? '/').replace(/\{(\w+)\}/g, ':$1');
    const url = route.replace(/:(\w+)/g, '1');
    element = input.params.length
      ? `<MemoryRouter initialEntries={[${q}${url}${q}]}><Routes><Route path=${JSON.stringify(route)} element={${element}} /></Routes></MemoryRouter>`
      : `<MemoryRouter>${element}</MemoryRouter>`;
  }
  if (usesQuery) element = `<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>${element}</QueryClientProvider>`;
  const props = serverPage ? `{ ${[...(input.params.length ? [`params: Promise.resolve(${paramsObj})`] : []), ...(/searchParams/.test(pageText) ? ['searchParams: Promise.resolve({})'] : [])].join(', ')} }` : '';
  const callPage = serverPage ? `await ${comp[2]}(${props === '{  }' ? '' : `${props} as any`})` : '';
  const render = serverPage ? `render(${callPage})` : `render(${element})`;
  const mocked = `${fn}Mock`;
  const lines = [
    ...(jest ? (rn ? [] : ['/** @jest-environment jsdom */', '']) : ['// @vitest-environment jsdom', '']),
    `import { ${rn ? 'render, screen' : 'cleanup, render, screen'} } from ${q}${rn ? '@testing-library/react-native' : '@testing-library/react'}${q};`,
    ...(jest ? [] : [`import { afterEach, describe, expect, it, vi } from ${q}vitest${q};`]),
    ...(usesRouter ? [`import { MemoryRouter${input.params.length ? ', Route, Routes' : ''} } from ${q}react-router-dom${q};`] : []),
    ...(usesQuery ? [`import { QueryClient, QueryClientProvider } from ${q}@tanstack/react-query${q};`] : []),
    `import * as api from ${q}${apiPath}${q};`,
    `import ${comp[2]} from ${q}${pagePath}${q};`,
    '',
    jest
      ? `jest.mock(${q}${apiPath}${q}, () => ({ ...jest.requireActual(${q}${apiPath}${q}), ${fn}: jest.fn() }));`
      : `vi.mock(${q}${apiPath}${q}, async (importOriginal) => ({ ...(await importOriginal<object>()), ${fn}: vi.fn() }));`,
    ...(usesNav ? [`jest.mock(${q}@react-navigation/native${q}, () => ({ ...jest.requireActual(${q}@react-navigation/native${q}), useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn(), addListener: () => () => {} }), useFocusEffect: () => {} }));`] : []),
    ...(usesExpoRouter ? [`jest.mock(${q}expo-router${q}, () => ({ ...jest.requireActual(${q}expo-router${q}), useLocalSearchParams: () => (${paramsObj}), useFocusEffect: () => {}, router: { push: jest.fn(), back: jest.fn() } }));`] : []),
    `const ${mocked} = api.${fn} as unknown as { mockResolvedValue(value: unknown): unknown; mockRejectedValue(error: unknown): unknown };`,
    `const sample = ${JSON.stringify(sample)};`,
    '',
    `describe(${q}${comp[2]}${q}, () => {`,
    ...(rn ? [] : ['  afterEach(() => cleanup());', '']),
    `  it(${q}shows the data${q}, async () => {`,
    `    ${mocked}.mockResolvedValue(sample);`,
    `    ${render};`,
    `    expect((await screen.findAllByText(${JSON.stringify(expected)})).length).toBeGreaterThan(0);`,
    '  });',
    ...(isList
      ? ['', `  it(${q}says when there is nothing to show${q}, async () => {`, `    ${mocked}.mockResolvedValue([]);`, `    ${render};`, `    expect(await screen.findByText(${q}Nothing here yet.${q})).toBeTruthy();`, '  });']
      : []),
    '',
    serverPage ? `  it(${q}throws when the API fails, for error.tsx to show${q}, async () => {` : `  it(${q}shows the error with Retry${q}, async () => {`,
    `    ${mocked}.mockRejectedValue(new Error(${q}boom${q}));`,
    ...(serverPage ? [`    await expect(${comp[2]}(${props === '{  }' ? '' : `${props} as any`})).rejects.toThrow(${q}boom${q});`] : [`    ${render};`, `    expect(await screen.findByText(${q}Retry${q})).toBeTruthy();`]),
    '  });',
    '});',
    '',
  ];
  // Testing Library (and a DOM for web tests) in devDependencies.
  // Next.js has no Vite config: Vitest needs one with the React plugin (and the @/ paths) to render pages.
  const nextVitest = fw === 'nextjs' && !jest && !['vitest.config.ts', 'vitest.config.mts', 'vitest.config.js', 'vitest.config.mjs', 'vite.config.ts', 'vite.config.mts'].some((f) => readText(join(root, f)) !== null || input.files.has(f));
  if (fw === 'nextjs' && jest && !['jest.config.js', 'jest.config.ts', 'jest.config.mjs'].some((f) => readText(join(root, f)) !== null)) return { skip: 'the project tests with Jest but has no jest.config (next/jest), which rendering pages needs' };
  const want = rn ? ['@testing-library/react-native'] : ['@testing-library/react', '@testing-library/dom', jest ? 'jest-environment-jsdom' : 'jsdom', ...(nextVitest ? ['@vitejs/plugin-react', 'vite-tsconfig-paths'] : [])];
  const missing = want.filter((d) => !deps[d]);
  const extra = new Map<string, string>();
  const extraSummary: string[] = [];
  const warnings: string[] = [];
  if (missing.length) {
    const indent = /\n(\s+)"/.exec(pkgText)?.[1] ?? '  ';
    const next = { ...pkg, devDependencies: { ...(pkg.devDependencies ?? {}), ...Object.fromEntries(missing.map((d) => [d, TL_VERSIONS[d as keyof typeof TL_VERSIONS]])) } } as Record<string, unknown>;
    if (rn && !deps['react-test-renderer'] && deps.react) (next.devDependencies as Record<string, string>)['react-test-renderer'] = deps.react.replace(/^[\^~]/, '');
    extra.set('package.json', `${JSON.stringify(next, null, indent)}\n`);
    extraSummary.push(`Update package.json: ${missing.join(', ')}${rn && !deps['react-test-renderer'] ? ', react-test-renderer' : ''} in devDependencies (run npm install)`);
  }
  if (nextVitest) {
    extra.set('vitest.config.mts', ["import react from '@vitejs/plugin-react';", "import tsconfigPaths from 'vite-tsconfig-paths';", "import { defineConfig } from 'vitest/config';", '', '// Renders pages in tests: JSX with the React plugin, @/ imports from tsconfig paths (codz screen add).', 'export default defineConfig({', '  plugins: [tsconfigPaths(), react()],', '});', ''].join('\n'));
    extraSummary.push('Create vitest.config.mts: the React plugin and tsconfig paths, so Vitest can render pages');
  }
  if (rn && !deps.jest && !deps['jest-expo']) warnings.push(c.flavor === 'expo' ? 'Run the screen tests with Jest: npx expo install jest-expo jest, and set "jest": { "preset": "jest-expo" } in package.json.' : 'Run the screen tests with Jest (preset "react-native").');
  void c;
  return { file: testFile, text: lines.join('\n'), summary: `Create ${testFile}: ${comp[2]} with data${isList ? ', empty' : ''}, and ${serverPage ? 'a failing API' : 'after an error (Retry)'}`, warnings, extra, extraSummary };
}
