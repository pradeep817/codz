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
