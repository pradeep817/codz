// Tests for form screens (screen add --form, and the create and edit screens of
// feature add). Each fills the inputs with valid values and checks what the API
// was sent, checks the message when saving fails, and, where the form checks its
// inputs itself, that an empty required input stops it:
//
//   Flutter              widget test: TextFormFields filled, Save tapped, the request the fake Dio got
//   React, Next.js       Testing Library: inputs found by label, the mocked API function's argument
//   React Native         Testing Library: TextInputs filled, Alert.alert watched
//   Android              the form ViewModel's submit() against MockWebServer
//   iOS                  the form view model's submit() with StubURLProtocol
//
// Edit forms load the current values first: the detail endpoint is answered too,
// and the tests wait for those values before filling the inputs.

import { join, posix } from 'node:path';
import { readMethod } from '../adapters/getx.ts';
import { addKotlinImports } from '../adapters/kotlinGen.ts';
import { matchBrace } from '../adapters/source.ts';
import { readText } from '../core/fsutil.ts';
import type { EndpointInfo, ProjectMap } from '../core/types.ts';
import { camel } from '../input/naming.ts';
import { converter, ensureAndroidTestLibs } from './androidTests.ts';
import { findDeclaration } from './apiEdit.ts';
import * as iosHelpers from './iosTests.ts';
import { exampleFor, unwrapsData } from './mock.ts';
import { jsTestSetup, screenTestPath, type ScreenTest } from './screenTests.ts';
import { dartLiteral } from './testgen.ts';

export interface FormTestInput {
  /** The planned files of the change (the form only exists there), or the project's files for test add --file. */
  files: Map<string, string>;
  /** The endpoint the form sends to. */
  ep: EndpointInfo;
  /** Route parameters the screen takes. */
  params: string[];
  /** React Router path of the screen. */
  route?: string;
  /** test add --file: the form already exists. */
  existing?: boolean;
}

type Skip = { skip: string };

/** What a text input is given, by what it holds. */
const textValue = (name: string) => (/email/i.test(name) ? 'a@b.co' : `Typed ${name}`);
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const isNew = (root: string, input: FormTestInput, f: string) => input.existing || readText(join(root, f)) === null;

// ---------- React, Next.js, React Native ----------

interface JsInput {
  label: string;
  name: string;
  type: 'text' | 'number' | 'email' | 'date' | 'strings';
}

/** The inputs a form page shows, in order, read from the page codz wrote. */
function jsInputs(text: string, fw: string): JsInput[] {
  const out: JsInput[] = [];
  const typeOf = (t: string, rest: string): JsInput['type'] => (/placeholder="a, b, c"/.test(rest) ? 'strings' : t === 'number' || /keyboardType="numeric"/.test(rest) ? 'number' : t === 'email' ? 'email' : t === 'datetime-local' ? 'date' : 'text');
  if (fw === 'react-native') {
    for (const m of text.matchAll(/<Text style=\{styles\.label\}>([^<]*)<\/Text>\s*<TextInput([\s\S]*?)\/>/g)) {
      const name = m[1].replace(/ \*$/, '');
      out.push({ label: m[1], name, type: typeOf('', m[2]) });
    }
  } else if (fw === 'nextjs') {
    for (const m of text.matchAll(/<label>\s*([^<\n]+?)\s*<input type="([\w-]+)"([^\n]*)\/>/g)) if (m[2] !== 'checkbox') out.push({ label: m[1], name: m[1], type: typeOf(m[2], m[3]) });
  } else {
    for (const m of text.matchAll(/<label htmlFor="[^"]+">([^<]*)<\/label>\s*<input ([^\n]*)\/>/g)) {
      const t = /type="([\w-]+)"/.exec(m[2])?.[1] ?? 'text';
      if (t !== 'checkbox') out.push({ label: m[1], name: m[1].replace(/ \*$/, ''), type: typeOf(t, m[2]) });
    }
  }
  return out;
}

const jsTyped = (i: JsInput) => (i.type === 'number' ? '3' : i.type === 'date' ? '2026-01-02T10:00' : i.type === 'strings' ? 'a, b' : textValue(i.name));
const jsSent = (i: JsInput): unknown => (i.type === 'number' ? 3 : i.type === 'strings' ? ['a', 'b'] : jsTyped(i));

/** A Testing Library test for a form page: inputs filled, Save pressed, what the mocked API function was given. */
export function jsFormTest(root: string, map: ProjectMap, input: FormTestInput): ScreenTest | Skip {
  const fw = map.framework;
  const rn = fw === 'react-native';
  const page = [...input.files].find(([f, t]) => /\.(tsx|jsx)$/.test(f) && !/\.test\./.test(f) && isNew(root, input, f) && /export default function \w+/.test(t) && new RegExp(`\\b${input.ep.name}\\(`).test(t));
  if (!page) return { skip: 'no form component in the change' };
  const [pageFile, pageText] = page;
  const comp = /export default function (\w+)/.exec(pageText)![1];
  const inputs = jsInputs(pageText, fw);
  if (!inputs.length) return { skip: 'no text inputs codz can fill' };
  const pkgText = input.files.get('package.json') ?? readText(join(root, 'package.json')) ?? '{}';
  const pkg = JSON.parse(pkgText) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const jest = !deps.vitest && (Boolean(deps.jest || deps['@types/jest'] || deps['jest-expo']) || rn);
  const m = jest ? 'jest' : 'vi';
  const q = "'";
  const testFile = (rn && pageFile.startsWith('app/') ? `__tests__/${pageFile}` : pageFile).replace(/\.(tsx|jsx)$/, '.test.$1');
  const rel = (to: string) => {
    let r = posix.relative(posix.dirname(testFile), to.replace(/\.(tsx?|jsx?)$/, ''));
    if (!r.startsWith('.')) r = `./${r}`;
    return r;
  };
  // Edit forms: the detail endpoint the page loads first.
  const loadName = /useEffect\(\(\) => \{\s*(\w+)\(/.exec(pageText)?.[1];
  const load = loadName ? map.endpoints.find((e) => e.name === loadName) : undefined;
  const detail = load ? exampleFor((load.response ?? '').replace(/^Promise<(.*)>$/, '$1'), map, '') : undefined;
  if (load && (detail === null || detail === undefined || typeof detail !== 'object')) return { skip: `no example data for ${load.response}, which the form loads first` };
  const response = exampleFor((input.ep.response ?? '').replace(/^Promise<(.*)>$/, '$1'), map, '');
  const mocks = new Map<string, string[]>();
  for (const e of [input.ep, ...(load ? [load] : [])]) mocks.set(e.file, [...(mocks.get(e.file) ?? []), e.name]);
  const paramsObj = `{ ${input.params.map((p) => `${p}: '1'`).join(', ')} }`;
  // How the page is rendered: the router or navigation props it reads.
  let element = `<${comp} />`;
  const usesRouter = /from ['"]react-router(-dom)?['"]/.test(pageText);
  const usesNextNav = /from ['"]next\/navigation['"]/.test(pageText);
  const usesNav = /from ['"]@react-navigation\/native['"]/.test(pageText);
  const usesExpoRouter = /from ['"]expo-router['"]/.test(pageText);
  const takesRoute = /\(\{\s*route\b/.test(pageText) || /route\.params/.test(pageText);
  if (rn && takesRoute) element = `<${comp} {...({ route: { params: ${paramsObj} }, navigation: { navigate: ${m}.fn(), goBack: ${m}.fn(), addListener: () => () => {} } } as any)} />`;
  if (usesRouter) {
    const route = (input.route ?? '/').replace(/\{(\w+)\}/g, ':$1');
    const url = route.replace(/:(\w+)/g, '1');
    element = input.params.length ? `<MemoryRouter initialEntries={[${q}${url}${q}]}><Routes><Route path=${JSON.stringify(route)} element={${element}} /></Routes></MemoryRouter>` : `<MemoryRouter>${element}</MemoryRouter>`;
  }
  const routerPkg = /from ['"]react-router['"]/.test(pageText) ? 'react-router' : 'react-router-dom';
  const mock = (e: EndpointInfo) => `${e.name}Mock`;
  const sent = Object.fromEntries(inputs.map((i) => [i.name, jsSent(i)]));
  // The value an edit form shows once loaded: wait for it, so the loaded values do not land on top of the typed ones.
  const shown = load ? inputs.map((i) => ({ i, v: (detail as Record<string, unknown>)[i.name] })).find((x) => (x.i.type === 'text' || x.i.type === 'number' || x.i.type === 'email') && (typeof x.v === 'string' || typeof x.v === 'number')) : undefined;
  const waitLoaded = load ? (shown ? [`    await screen.findByDisplayValue(${JSON.stringify(String(shown.v))});`] : [`    await waitFor(() => expect(${mock(load)}.mock.calls.length).toBe(1));`]) : [];
  const required = rn ? /Alert\.alert\('([^']+) is required'\)/.exec(pageText)?.[1] : undefined;
  const fill = rn
    ? ['    const inputs = screen.UNSAFE_getAllByType(TextInput);', ...inputs.map((i, n) => `    fireEvent.changeText(inputs[${n}], ${JSON.stringify(jsTyped(i))});`)]
    : inputs.map((i) => `    fireEvent.change(screen.getByLabelText(/^${reEscape(i.name)}( \\*)?$/), { target: { value: ${JSON.stringify(jsTyped(i))} } });`);
  const press = rn ? `    fireEvent.press(screen.getByText(${q}Save${q}));` : `    fireEvent.click(screen.getByRole(${q}button${q}, { name: ${q}Save${q} }));`;
  const arrange = (ok: boolean) => [`    ${mock(input.ep)}.${ok ? `mockResolvedValue(${response === null || response === undefined ? 'undefined' : 'response'})` : `mockRejectedValue(new Error(${q}boom${q}))`};`, ...(load ? [`    ${mock(load)}.mockResolvedValue(detail);`] : [])];
  const successCheck = rn ? [`    await waitFor(() => expect(alert).toHaveBeenCalledWith(${q}Saved${q}));`] : /Saved\./.test(pageText) ? [`    expect(await screen.findByText(${q}Saved.${q})).toBeTruthy();`] : [];
  const tests = [
    `  it(${q}sends what was typed to ${input.ep.name}${q}, async () => {`,
    ...arrange(true),
    `    render(${element});`,
    ...waitLoaded,
    ...fill,
    press,
    `    await waitFor(() => expect(${mock(input.ep)}.mock.calls.length).toBe(1));`,
    `    const args = ${mock(input.ep)}.mock.calls[0];`,
    `    expect(args[args.length - 1]).toEqual(expect.objectContaining(${JSON.stringify(sent)}));`,
    ...successCheck,
    '  });',
    ...(required && !load
      ? ['', `  it(${q}asks for ${required} before sending${q}, async () => {`, ...arrange(true), `    render(${element});`, press, `    expect(alert).toHaveBeenCalledWith(${q}${required} is required${q});`, `    expect(${mock(input.ep)}.mock.calls.length).toBe(0);`, '  });']
      : []),
    '',
    `  it(${q}shows the error when saving fails${q}, async () => {`,
    ...arrange(false),
    `    render(${element});`,
    ...waitLoaded,
    ...fill,
    press,
    ...(rn ? [`    await waitFor(() => expect(alert).toHaveBeenCalledWith(${q}Could not save${q}, ${q}boom${q}));`] : [`    expect(await screen.findByText(${q}boom${q})).toBeTruthy();`]),
    '  });',
  ];
  const lines = [
    ...(jest ? (rn ? [] : ['/** @jest-environment jsdom */', '']) : ['// @vitest-environment jsdom', '']),
    `import { ${rn ? 'fireEvent, render, screen, waitFor' : 'cleanup, fireEvent, render, screen, waitFor'} } from ${q}${rn ? '@testing-library/react-native' : '@testing-library/react'}${q};`,
    ...(rn ? [`import { Alert, TextInput } from ${q}react-native${q};`] : []),
    ...(jest ? [] : [`import { afterEach, describe, expect, it, vi } from ${q}vitest${q};`]),
    ...(usesRouter ? [`import { MemoryRouter${input.params.length ? ', Route, Routes' : ''} } from ${q}${routerPkg}${q};`] : []),
    ...[...mocks.keys()].map((f, n) => `import * as api${n || ''} from ${q}${rel(f)}${q};`),
    `import ${comp} from ${q}${rel(pageFile)}${q};`,
    '',
    ...[...mocks].map(([f, fns]) => (jest ? `jest.mock(${q}${rel(f)}${q}, () => ({ ...jest.requireActual(${q}${rel(f)}${q}), ${fns.map((n) => `${n}: jest.fn()`).join(', ')} }));` : `vi.mock(${q}${rel(f)}${q}, async (importOriginal) => ({ ...(await importOriginal<object>()), ${fns.map((n) => `${n}: vi.fn()`).join(', ')} }));`)),
    ...(usesNextNav ? [`${m}.mock(${q}next/navigation${q}, () => ({ useParams: () => (${paramsObj}), useRouter: () => ({ push: ${m}.fn(), replace: ${m}.fn(), back: ${m}.fn(), refresh: ${m}.fn() }), usePathname: () => ${q}/${q}, useSearchParams: () => new URLSearchParams() }));`] : []),
    ...(usesNav ? [`jest.mock(${q}@react-navigation/native${q}, () => ({ ...jest.requireActual(${q}@react-navigation/native${q}), useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn(), addListener: () => () => {} }), useFocusEffect: () => {} }));`] : []),
    ...(usesExpoRouter ? [`jest.mock(${q}expo-router${q}, () => ({ ...jest.requireActual(${q}expo-router${q}), useLocalSearchParams: () => (${paramsObj}), useFocusEffect: () => {}, router: { push: jest.fn(), back: jest.fn() } }));`] : []),
    '',
    'type Mocked = { mockResolvedValue(value: unknown): unknown; mockRejectedValue(error: unknown): unknown; mock: { calls: unknown[][] } };',
    ...[...mocks].flatMap(([, fns], n) => fns.map((fn) => `const ${fn}Mock = api${n || ''}.${fn} as unknown as Mocked;`)),
    ...(response === null || response === undefined ? [] : [`const response = ${JSON.stringify(response)};`]),
    ...(load ? [`const detail = ${JSON.stringify(detail)};`] : []),
    ...(rn ? [`const alert = jest.spyOn(Alert, ${q}alert${q}).mockImplementation(() => {});`] : []),
    '',
    `describe(${q}${comp}${q}, () => {`,
    rn ? `  afterEach(() => jest.clearAllMocks());` : `  afterEach(() => {\n    cleanup();\n    ${m}.clearAllMocks();\n  });`,
    '',
    ...tests,
    '});',
    '',
  ];
  const setup = jsTestSetup(root, map, input.files, jest);
  if ('skip' in setup) return setup;
  return { file: testFile, text: lines.join('\n'), summary: `Create ${testFile}: ${comp} sends what was typed to ${input.ep.name}()${required && !load ? ', asks for required inputs' : ''}, and shows the error`, warnings: setup.warnings, extra: setup.extra, extraSummary: setup.extraSummary };
}

// ---------- Flutter ----------

interface DartInput {
  label: string;
  kind: 'text' | 'int' | 'double' | 'date' | 'strings';
  required: boolean;
}

/** The TextFormFields of a form codz wrote, in order. */
function dartInputs(text: string): DartInput[] {
  const out: DartInput[] = [];
  for (const m of text.matchAll(/TextFormField\(\s*controller: \w+,\s*decoration: const InputDecoration\(labelText: '([^']+)'(, helperText: 'Separate items with commas')?\),(?:\s*keyboardType: ([^\n]+),)?(\s*validator: \(v\) \{[^}]*?'Required')?/g)) {
    const kb = m[3] ?? '';
    const kind: DartInput['kind'] = m[2] ? 'strings' : /numberWithOptions/.test(kb) ? 'double' : /TextInputType\.number/.test(kb) ? 'int' : /datetime/.test(kb) ? 'date' : 'text';
    out.push({ label: m[1], kind, required: Boolean(m[4]) });
  }
  return out;
}

const dartTyped = (i: DartInput) => (i.kind === 'int' ? '3' : i.kind === 'double' ? '4.5' : i.kind === 'date' ? '2026-01-02' : i.kind === 'strings' ? 'a, b' : textValue(i.label));

const FORM_ADAPTER = [
  '/// Answers GET (the current values) with [load], and records every other request, answered with [status] and [body].',
  'class _FormApi implements HttpClientAdapter {',
  '  _FormApi(this.status, this.body, {this.load});',
  '',
  '  final int status;',
  '  final Object? body;',
  '  final Object? load;',
  '  final sent = <RequestOptions>[];',
  '',
  '  @override',
  '  Future<ResponseBody> fetch(RequestOptions options, Stream<Uint8List>? requestStream, Future<void>? cancelFuture) async {',
  "    if (options.method == 'GET') return _json(load, 200);",
  '    sent.add(options);',
  '    return _json(body, status);',
  '  }',
  '',
  '  ResponseBody _json(Object? value, int code) => ResponseBody.fromString(jsonEncode(value), code, headers: {',
  '        Headers.contentTypeHeader: [Headers.jsonContentType],',
  '      });',
  '',
  '  @override',
  '  void close({bool force = false}) {}',
  '}',
].join('\n');

/** A Flutter widget test for a form screen: required inputs, what Save sends, and the error. */
export function flutterFormTest(root: string, map: ProjectMap, input: FormTestInput): ScreenTest | Skip {
  const c = map.conventions;
  const pkg = c.packageName;
  if (!pkg) return { skip: 'pubspec.yaml has no name, so the test cannot import the app' };
  const read = (f: string) => input.files.get(f) ?? readText(join(root, f));
  const screen = [...input.files].find(([f, t]) => f.endsWith('.dart') && isNew(root, input, f) && /GlobalKey<FormState>/.test(t) && /TextFormField\(/.test(t));
  if (!screen) return { skip: 'no form widget in the change' };
  const [screenFile, screenText] = screen;
  const widget = /class\s+(\w+)\s+extends\s+(StatefulWidget|ConsumerStatefulWidget|GetView<(\w+)>)/.exec(screenText);
  if (!widget) return { skip: 'could not read the form widget' };
  const cls = widget[1];
  const getx = /Get\.find</.test(screenText);
  if (getx && input.params.length) return { skip: `${cls} reads ${input.params.join(', ')} from Get.parameters, which a widget test does not set` };
  const repoText = read(input.ep.file) ?? '';
  const sig = readMethod(repoText, input.ep.name);
  if (!sig?.repoClass) return { skip: `could not read ${input.ep.name}` };
  const repo = sig.repoClass;
  if (!new RegExp(`\\b${repo}\\s*\\(\\s*(?:this\\.\\w+|Dio\\s+\\w+)\\s*[,)]|factory\\s+${repo}\\s*\\(\\s*Dio\\b`).test(repoText)) return { skip: `${repo} does not take its Dio in the constructor, so it cannot be given a fake one` };
  const inputs = dartInputs(screenText);
  if (!inputs.length) return { skip: 'no text inputs codz can fill' };
  const riverpod = /ref\.read\(/.test(screenText);
  const getIt = !getx && !riverpod && new RegExp(`\\w+<${repo}>\\(\\)`).test(screenText) && !/context\.read</.test(screenText);
  const bloc = /context\.read</.test(screenText);
  const gi = c.diInstance || 'getIt';
  const wrapFor = (name: string, value: unknown) => {
    const d = findDeclaration(repoText, name, 'dart');
    return d && unwrapsData(repoText.slice(d.start, d.end), c) ? { data: value } : value;
  };
  const type = sig.returnType;
  const list = /^List<(.+)>\??$/.exec(type);
  const resp = /^(void|dynamic)?$/.test(type) ? {} : exampleFor(list ? `${list[1]}[]` : type, map);
  if (resp === null || resp === undefined) return { skip: `no example data for ${type}` };
  const loadLine = /final d = await ([^;\n]*);/.exec(screenText)?.[1] ?? '';
  const loadName = loadLine ? map.endpoints.find((e) => e.method === 'GET' && new RegExp(`\\.${e.name}\\(`).test(loadLine))?.name : undefined;
  let loadValue: unknown;
  if (loadName) {
    const lsig = readMethod(repoText, loadName);
    const v = lsig ? exampleFor(lsig.returnType, map) : null;
    if (v === null || v === undefined) return { skip: `no example data for ${loadName}, which the form loads first` };
    loadValue = wrapFor(loadName, v);
  }
  const uri = (f: string) => `package:${pkg}/${f.replace(/^lib\//, '')}`;
  const args = input.params.map((p) => `${p}: '1'`).join(', ');
  const app = (child: string) => (getx ? `GetMaterialApp(home: ${child})` : `MaterialApp(home: ${child})`);
  const make = `const ${cls}(${getx ? '' : args})`;
  const pump = (status: number, body: string) => {
    const api = `_FormApi(${status}, ${body}${loadName ? ', load: current' : ''})`;
    const repoExpr = `${repo}(Dio(BaseOptions(baseUrl: 'https://api.test'))..httpClientAdapter = api)`;
    return [
      `    final api = ${api};`,
      ...(getx ? [`    Get.put<${repo}>(${repoExpr});`] : getIt ? [`    ${gi}.registerSingleton<${repo}>(${repoExpr});`] : []),
      `    await tester.pumpWidget(${riverpod ? `ProviderScope(overrides: [${camel(repo)}Provider.overrideWithValue(${repoExpr})], child: ${app(make)})` : bloc ? `RepositoryProvider<${repo}>.value(value: ${repoExpr}, child: ${app(make)})` : app(make)});`,
      '    await tester.pumpAndSettle();',
    ];
  };
  const field = (i: DartInput) => `find.widgetWithText(TextFormField, '${i.label}')`;
  const fill = inputs.map((i) => `    await tester.enterText(${field(i)}, ${dartLiteral(dartTyped(i))});`);
  const save = ["    await tester.tap(find.widgetWithText(FilledButton, 'Save'));", '    await tester.pumpAndSettle();'];
  const texts = inputs.filter((i) => i.kind === 'text');
  const required = inputs.filter((i) => i.required);
  const big = ['    tester.view.physicalSize = const Size(1200, 4000);', '    tester.view.devicePixelRatio = 1.0;', '    addTearDown(tester.view.reset);'];
  const tests = [
    ...(required.length
      ? [
          `  testWidgets('${cls} asks for the required inputs', (tester) async {`,
          ...big,
          ...pump(200, 'response'),
          ...required.map((i) => `    await tester.enterText(${field(i)}, '');`),
          ...save,
          "    expect(find.text('Required'), findsWidgets);",
          '    expect(api.sent, isEmpty);',
          '  });',
          '',
        ]
      : []),
    `  testWidgets('${cls} sends what was typed', (tester) async {`,
    ...big,
    ...pump(200, 'response'),
    ...fill,
    ...save,
    '    expect(api.sent, hasLength(1));',
    `    expect(api.sent.single.method, '${input.ep.method}');`,
    ...(texts.length ? ['    final sent = jsonEncode(api.sent.single.data);', ...texts.map((i) => `    expect(sent, contains(${dartLiteral(textValue(i.label))}));`)] : []),
    "    expect(find.text('Saved'), findsOneWidget);",
    '  });',
    '',
    `  testWidgets('${cls} shows the error when saving fails', (tester) async {`,
    ...big,
    ...pump(500, "{'error': 'nope'}"),
    ...fill,
    ...save,
    '    expect(api.sent, hasLength(1));',
    "    expect(find.text('Saved'), findsNothing);",
    '    expect(find.byType(SnackBar), findsOneWidget);',
    '  });',
  ];
  const imports = [
    "import 'dart:convert';",
    "import 'dart:typed_data';",
    '',
    "import 'package:dio/dio.dart';",
    "import 'package:flutter/material.dart';",
    ...(riverpod ? ["import 'package:flutter_riverpod/flutter_riverpod.dart';"] : []),
    ...(bloc ? ["import 'package:flutter_bloc/flutter_bloc.dart';"] : []),
    "import 'package:flutter_test/flutter_test.dart';",
    ...(getx ? ["import 'package:get/get.dart';"] : []),
    ...[uri(screenFile), uri(input.ep.file), ...(getIt && c.diFile ? [uri(c.diFile)] : [])]
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort()
      .map((u) => `import '${u}';`),
  ];
  const setup = getx ? ['  setUp(() {', '    Get.testMode = true;', '    Get.reset();', '  });', '  tearDown(Get.reset);', ''] : getIt ? [`  setUp(() async => ${gi}.reset());`, ''] : [];
  const file = screenTestPath(screenFile);
  const text = [
    ...imports,
    '',
    FORM_ADAPTER,
    '',
    'void main() {',
    `  final response = ${dartLiteral(wrapFor(input.ep.name, resp), '  ')};`,
    ...(loadName ? [`  final current = ${dartLiteral(loadValue, '  ')};`] : []),
    ...setup,
    ...tests,
    '}',
    '',
  ].join('\n');
  return { file, text, summary: `Create ${file}: ${cls}${required.length ? ' asks for required inputs,' : ''} sends what was typed, and shows the error`, warnings: [] };
}

// ---------- Kotlin and Swift request bodies ----------

/** A Kotlin constructor call for a data class with example values, or a reason it cannot be made. */
function kotlinBody(text: string, name: string): { expr: string; texts: string[] } | Skip {
  const start = new RegExp(`data class ${name}\\s*\\(`).exec(text);
  if (!start) return { skip: `could not read the data class ${name}` };
  const open = start.index + start[0].length - 1;
  let depth = 0;
  let end = open;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) {
      end = i;
      break;
    }
  }
  const params: string[] = [];
  let cur = '';
  depth = 0;
  for (const ch of text.slice(open + 1, end)) {
    if ('(<['.includes(ch)) depth++;
    if (')>]'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      params.push(cur);
      cur = '';
    } else cur += ch;
  }
  params.push(cur);
  const args: string[] = [];
  const texts: string[] = [];
  for (const p of params.map((x) => x.trim()).filter(Boolean)) {
    const m = /(?:val|var)\s+(`?\w+`?)\s*:\s*([^=]+?)\s*(=.*)?$/s.exec(p.replace(/@\w+(\([^)]*\))?\s*/g, ''));
    if (!m) continue;
    const [, prop, type, dflt] = m;
    const t = type.replace(/\s+/g, '');
    let v: string | null;
    if (t.endsWith('?')) v = dflt ? null : 'null';
    else if (t === 'String') {
      v = JSON.stringify(textValue(prop.replace(/`/g, '')));
      texts.push(textValue(prop.replace(/`/g, '')));
    } else if (t === 'Int') v = '3';
    else if (t === 'Long') v = '3L';
    else if (t === 'Double') v = '4.5';
    else if (t === 'Float') v = '4.5f';
    else if (t === 'Boolean') v = 'true';
    else if (t === 'List<String>') v = 'listOf("a", "b")';
    else if (dflt) v = null;
    else return { skip: `the request body needs a ${t} (${prop}), which codz cannot make up` };
    if (v !== null) args.push(`${prop} = ${v}`);
  }
  return { expr: `${name}(${args.join(', ')})`, texts };
}

/** A Swift memberwise init call for a struct with example values, or a reason it cannot be made. */
function swiftBody(text: string, name: string): { expr: string } | Skip {
  const start = new RegExp(`struct ${name}\\b[^{]*\\{`).exec(text);
  if (!start) return { skip: `could not read the struct ${name}` };
  const close = matchBrace(text, start.index + start[0].length - 1);
  if (close < 0) return { skip: `could not read the struct ${name}` };
  const body = text.slice(start.index + start[0].length, close);
  // Only this struct's own properties (depth 0), not those of nested types.
  let depth = 0;
  const top: string[] = [];
  for (const line of body.split('\n')) {
    if (depth === 0) top.push(line);
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
  }
  if (top.some((l) => /^\s*init\(/.test(l))) return { skip: `${name} has its own init, so codz cannot build one with example values` };
  const args: string[] = [];
  for (const line of top) {
    const m = /^\s*(let|var)\s+(`?\w+`?)\s*:\s*([^={]+?)\s*(=.*)?$/.exec(line);
    if (!m) continue;
    const [, kw, prop, type, dflt] = m;
    if (kw === 'let' && dflt) continue;
    const t = type.trim();
    const label = prop.replace(/`/g, '');
    let v: string;
    if (t.endsWith('?')) v = 'nil';
    else if (t === 'String') v = JSON.stringify(textValue(label));
    else if (t === 'Int') v = '3';
    else if (t === 'Double') v = '4.5';
    else if (t === 'Bool') v = 'true';
    else if (t === '[String]') v = '["a", "b"]';
    else if (t === 'Date') v = 'Date(timeIntervalSince1970: 0)';
    else return { skip: `the request body needs a ${t} (${label}), which codz cannot make up` };
    args.push(`${label}: ${v}`);
  }
  return { expr: `${name}(${args.join(', ')})` };
}

// ---------- Android ----------

/** A JVM test for a form ViewModel: submit() with example values against MockWebServer. */
export function androidFormTest(root: string, map: ProjectMap, input: FormTestInput): ScreenTest | Skip {
  const c = map.conventions;
  const read = (f: string) => input.files.get(f) ?? readText(join(root, f));
  const vmEntry = [...input.files].find(([f, t]) => f.endsWith('ViewModel.kt') && isNew(root, input, f) && /fun submit\(body: \w+\)/.test(t));
  if (!vmEntry) return { skip: 'no form ViewModel in the change' };
  const [, vmText] = vmEntry;
  const vm = /class\s+(\w+)/.exec(vmText)![1];
  const pkg = /^package\s+([\w.]+)/m.exec(vmText)?.[1];
  const bodyName = /fun submit\(body: (\w+)\)/.exec(vmText)![1];
  const model = map.models.find((m) => m.name === bodyName);
  if (!pkg || !model) return { skip: `could not read the request model ${bodyName}` };
  const body = kotlinBody(read(model.file) ?? '', bodyName);
  if ('skip' in body) return body;
  const apiText = read(input.ep.file) ?? '';
  const iface = /\binterface\s+(\w+)/.exec(apiText)?.[1];
  const apiPkg = /^package\s+([\w.]+)/m.exec(apiText)?.[1];
  if (!iface || !apiPkg) return { skip: `could not read the Retrofit interface in ${input.ep.file}` };
  const ret = (input.ep.response ?? '').trim();
  const resp = !ret || /^Unit$|^Response<Unit>$/.test(ret) ? {} : exampleFor(ret.replace(/^Response<(.*)>$/, '$1'), map, '');
  if (resp === null || resp === undefined) return { skip: `no example data for ${ret}` };
  const loadCall = /_initial\.value = try \{ api\.(\w+)\(/.exec(vmText)?.[1];
  const load = loadCall ? map.endpoints.find((e) => e.name === loadCall) : undefined;
  const loadValue = load ? exampleFor((load.response ?? '').replace(/^Response<(.*)>$/, '$1'), map, '') : {};
  if (load && (loadValue === null || loadValue === undefined)) return { skip: `no example data for ${load.response}, which the form loads first` };
  const kt = (v: unknown) => JSON.stringify(JSON.stringify(v)).replace(/\$/g, '\\$');
  const handle = /savedStateHandle:\s*SavedStateHandle/.test(vmText);
  const make = `${vm}(api${handle ? `, SavedStateHandle(mapOf(${input.params.map((p) => `"${p}" to "1"`).join(', ')}))` : ''})`;
  const conv = converter(c.serialization || 'kotlinx');
  const uiState = /^import\s+([\w.]+\.UiState)$/m.exec(vmText)?.[1];
  const bodyImport = new RegExp(`^import\\s+([\\w.]+\\.${bodyName})$`, 'm').exec(vmText)?.[1];
  const settled = '{ it is UiState.Success || it is UiState.Error }';
  const tests = [
    '    @Test',
    `    fun \`sends the form\`() = runBlocking {`,
    '        server.dispatcher = answer(200)',
    `        val vm = ${make}`,
    `        vm.submit(${body.expr})`,
    '',
    `        val state = withTimeout(5_000) { vm.state.first ${settled} }`,
    '',
    '        assertTrue("$state", state is UiState.Success)',
    '        val request = sent.single()',
    `        assertEquals("${input.ep.method}", request.method)`,
    ...(body.texts.length ? ['        val json = request.body.readUtf8()', ...body.texts.map((t) => `        assertTrue(json, json.contains(${JSON.stringify(t)}))`)] : []),
    '    }',
    '',
    '    @Test',
    `    fun \`shows the error when saving fails\`() = runBlocking {`,
    '        server.dispatcher = answer(500)',
    `        val vm = ${make}`,
    `        vm.submit(${body.expr})`,
    '',
    `        val state = withTimeout(5_000) { vm.state.first ${settled} }`,
    '',
    '        assertTrue("$state", state is UiState.Error)',
    '    }',
  ];
  const srcDir = c.srcDir || 'app/src/main/java';
  const file = `${srcDir.replace(/\/main\//, '/test/')}/${pkg.replace(/\./g, '/')}/${vm}Test.kt`;
  let text = [
    `package ${pkg}`,
    '',
    '@OptIn(ExperimentalCoroutinesApi::class)',
    `class ${vm}Test {`,
    '    private val server = MockWebServer()',
    `    private lateinit var api: ${iface}`,
    '    /** The requests that were not GET (the form sending). */',
    '    private val sent = Collections.synchronizedList(mutableListOf<RecordedRequest>())',
    '',
    '    /** GET gets the current values; anything else is recorded and answered with [status]. */',
    '    private fun answer(status: Int) = object : Dispatcher() {',
    '        override fun dispatch(request: RecordedRequest): MockResponse {',
    `            if (request.method == "GET") return MockResponse().setHeader("Content-Type", "application/json").setBody(${kt(loadValue)})`,
    '            sent.add(request)',
    `            return MockResponse().setResponseCode(status).setHeader("Content-Type", "application/json").setBody(if (status < 400) ${kt(resp)} else "{}")`,
    '        }',
    '    }',
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
  text = addKotlinImports(
    text,
    [
      `${apiPkg}.${iface}`,
      ...conv.imports,
      ...(uiState ? [uiState] : []),
      ...(bodyImport ? [bodyImport] : []),
      ...(handle ? ['androidx.lifecycle.SavedStateHandle'] : []),
      'java.util.Collections',
      'kotlinx.coroutines.Dispatchers',
      'kotlinx.coroutines.ExperimentalCoroutinesApi',
      'kotlinx.coroutines.flow.first',
      'kotlinx.coroutines.runBlocking',
      'kotlinx.coroutines.test.UnconfinedTestDispatcher',
      'kotlinx.coroutines.test.resetMain',
      'kotlinx.coroutines.test.setMain',
      'kotlinx.coroutines.withTimeout',
      'okhttp3.mockwebserver.Dispatcher',
      'okhttp3.mockwebserver.MockResponse',
      'okhttp3.mockwebserver.MockWebServer',
      'okhttp3.mockwebserver.RecordedRequest',
      'org.junit.After',
      'org.junit.Assert.assertEquals',
      'org.junit.Assert.assertTrue',
      'org.junit.Before',
      'org.junit.Test',
      'retrofit2.Retrofit',
    ],
    pkg,
  );
  const extra = new Map<string, string>([[file, text]]);
  const extraSummary: string[] = [];
  ensureAndroidTestLibs(map, (p) => extra.get(p) ?? read(p), extra, extraSummary, []);
  extra.delete(file);
  return { file, text, summary: `Create ${file}: ${vm}.submit() sends the form, and the error when saving fails`, warnings: [], extra, extraSummary };
}

// ---------- iOS ----------

/** An XCTest for a form view model: submit() with example values, answered by StubURLProtocol. */
export function iosFormTest(root: string, map: ProjectMap, input: FormTestInput): ScreenTest | Skip {
  const read = (f: string) => input.files.get(f) ?? readText(join(root, f));
  const vmEntry = [...input.files].find(([f, t]) => f.endsWith('ViewModel.swift') && isNew(root, input, f) && /func submit\(_ body: \w+\) async -> Bool/.test(t));
  if (!vmEntry) return { skip: 'no form view model in the change' };
  const [, vmText] = vmEntry;
  const vm = /final class (\w+): ObservableObject/.exec(vmText)?.[1];
  const bodyName = /func submit\(_ body: (\w+)\)/.exec(vmText)![1];
  const model = map.models.find((m) => m.name === bodyName);
  if (!vm || !model) return { skip: `could not read the request model ${bodyName}` };
  const body = swiftBody(read(model.file) ?? '', bodyName);
  if ('skip' in body) return body;
  const init = /init\(([^)]*)\)/.exec(vmText)?.[1] ?? '';
  const args = init
    .split(',')
    .map((p) => /^\s*(\w+)\s*:\s*([\w?]+)/.exec(p))
    .filter((m): m is RegExpExecArray => !!m && m[1] !== 'api')
    .map((m) => `${m[1]}: ${/^Int\??$/.test(m[2]) ? '1' : /^Double\??$/.test(m[2]) ? '1.0' : '"1"'}`);
  const resp = /^(Void)?$/.test(input.ep.response ?? '') ? {} : exampleFor(input.ep.response ?? '', map, '');
  if (resp === null || resp === undefined) return { skip: `no example data for ${input.ep.response}` };
  const loadName = /func loadInitial\(\) async -> \w+\? \{\s*try\? await api\.(\w+)\(/.exec(vmText)?.[1];
  const load = loadName ? map.endpoints.find((e) => e.name === loadName) : undefined;
  const loadValue = load ? exampleFor(load.response ?? '', map, '') : null;
  const I = ' '.repeat(Number(map.conventions.indent) || 4);
  const files = new Map(input.files);
  const summary: string[] = [];
  let target: { folder: string; module: string };
  try {
    target = iosHelpers.ensureIosTestSetup(root, map, files, summary, I);
  } catch (e) {
    return { skip: (e as Error).message.replace(/\.$/, '') };
  }
  const make = `${vm}(${[...args, 'api: APIClient(baseURL: URL(string: "https://api.test")!, session: StubURLProtocol.session())'].join(', ')})`;
  const L = (d: number, s: string) => `${I.repeat(d)}${s}`;
  const json = (v: unknown) => `Data(#"${JSON.stringify(v)}"#.utf8)`;
  const text = [
    'import XCTest',
    `@testable import ${target.module}`,
    '',
    `/// ${vm} with the API answered by StubURLProtocol (codz screen add --form).`,
    '@MainActor',
    `final class ${vm}Tests: XCTestCase {`,
    ...(load && loadValue !== null && loadValue !== undefined
      ? [L(1, 'func testLoadsTheCurrentValues() async {'), L(2, 'StubURLProtocol.status = 200'), L(2, `StubURLProtocol.body = ${json(loadValue)}`), L(2, `let model = ${make}`), L(2, 'let current = await model.loadInitial()'), L(2, 'XCTAssertNotNil(current)'), L(1, '}'), '']
      : []),
    L(1, 'func testSendsTheForm() async {'),
    L(2, 'StubURLProtocol.status = 200'),
    L(2, `StubURLProtocol.body = ${json(resp)}`),
    L(2, `let model = ${make}`),
    L(2, `let saved = await model.submit(${body.expr})`),
    L(2, 'XCTAssertTrue(saved, model.error ?? "")'),
    L(2, `XCTAssertEqual(StubURLProtocol.lastRequest?.httpMethod, "${input.ep.method}")`),
    L(1, '}'),
    '',
    L(1, 'func testShowsTheErrorWhenSavingFails() async {'),
    L(2, 'StubURLProtocol.status = 500'),
    L(2, 'StubURLProtocol.body = Data(#"{"error":"boom"}"#.utf8)'),
    L(2, `let model = ${make}`),
    L(2, `let saved = await model.submit(${body.expr})`),
    L(2, 'XCTAssertFalse(saved)'),
    L(2, 'XCTAssertNotNil(model.error)'),
    L(1, '}'),
    '}',
    '',
  ].join('\n');
  const file = `${target.folder}/${vm}Tests.swift`;
  const extra = new Map([...files].filter(([f]) => !input.files.has(f) || input.files.get(f) !== files.get(f)));
  return { file, text, summary: `Create ${file}: ${vm}.submit() sends the form, and the error when saving fails`, warnings: [], extra, extraSummary: summary };
}

/** The form test for this project's framework. */
export function formTest(root: string, map: ProjectMap, input: FormTestInput): ScreenTest | Skip | null {
  switch (map.framework) {
    case 'flutter':
      return flutterFormTest(root, map, input);
    case 'android':
      return androidFormTest(root, map, input);
    case 'ios':
      return iosFormTest(root, map, input);
    case 'nextjs':
    case 'react':
    case 'react-native':
      return jsFormTest(root, map, input);
    default:
      return null;
  }
}
