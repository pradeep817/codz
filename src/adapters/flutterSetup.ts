// Flutter `setup`: creates an API layer for a project that has none yet.
// Three architectures, each wired end to end so `api add` works right after:
//   getx      Dio registered in an InitialBinding, used by GetMaterialApp
//   riverpod  Dio exposed through dioProvider, app wrapped in ProviderScope
//   get_it    Dio registered in setupDependencies(), called from main()

import { join } from 'node:path';
import { detectEol, readText, walk, withEol } from '../core/fsutil.ts';
import { ToolError, type AdapterContext, type ArchitectureOption, type Conventions, type ProjectMap, type SetupChoice, type SetupPlan } from '../core/types.ts';
import { addDartImport, importUri, pubspecDeps } from './flutter.ts';
import { matchBrace } from './source.ts';

/**
 * Lowest versions known to work with the generated code; pub resolves the
 * newest compatible release within each major version.
 */
const PACKAGES: Record<string, string> = {
  dio: '^5.7.0',
  get: '^4.6.6',
  flutter_riverpod: '^2.6.1',
  get_it: '^8.0.2',
  flutter_bloc: '^8.1.6',
};

interface Layout {
  packages: string[];
  networkFile: string;
  conventions: Conventions;
}

const LAYOUTS: Record<string, Layout> = {
  getx: {
    packages: ['dio', 'get'],
    networkFile: 'lib/app/data/network/api_client.dart',
    conventions: {
      modelsFolder: 'lib/app/data/models',
      repoFolder: 'lib/app/data/repositories',
      di: 'getx',
      diFile: 'lib/app/bindings/initial_binding.dart',
      stateManagement: 'getx',
      modulesFolder: 'lib/app/modules',
      routesFile: 'lib/app/routes/app_pages.dart',
    },
  },
  riverpod: {
    packages: ['dio', 'flutter_riverpod'],
    networkFile: 'lib/core/network/dio_provider.dart',
    conventions: {
      modelsFolder: 'lib/data/models',
      repoFolder: 'lib/data/repositories',
      di: 'riverpod',
      dioProvider: 'dioProvider',
      dioProviderFile: 'lib/core/network/dio_provider.dart',
      stateManagement: 'riverpod',
    },
  },
  get_it: {
    packages: ['dio', 'get_it'],
    networkFile: 'lib/core/network/api_client.dart',
    conventions: {
      modelsFolder: 'lib/data/models',
      repoFolder: 'lib/data/repositories',
      di: 'get_it',
      diFile: 'lib/core/di/injection.dart',
      diInstance: 'getIt',
    },
  },
};
// Bloc: get_it for Dio and repositories, flutter_bloc for screens (screen add writes Cubits).
LAYOUTS.bloc = { ...LAYOUTS.get_it, packages: ['dio', 'get_it', 'flutter_bloc'], conventions: { ...LAYOUTS.get_it.conventions, stateManagement: 'bloc' } };

export function flutterArchitectures(map: ProjectMap): ArchitectureOption[] {
  const c = map.conventions;
  if (map.endpoints.length > 0 || (c.di && c.di !== 'none')) return [];
  const sm = c.stateManagement ?? 'none';
  const recommended = sm === 'getx' ? 'getx' : sm === 'bloc' ? 'bloc' : sm === 'provider' ? 'get_it' : 'riverpod';
  const options: ArchitectureOption[] = [
    { id: 'getx', label: 'GetX', description: 'Dio registered in an InitialBinding; repositories with Get.lazyPut; GetMaterialApp', recommended: false },
    { id: 'riverpod', label: 'Riverpod', description: 'Dio through dioProvider; a provider per repository; ProviderScope', recommended: false },
    { id: 'get_it', label: 'get_it', description: 'Service locator for Dio and repositories; works with Bloc or Provider', recommended: false },
    { id: 'bloc', label: 'Bloc', description: 'flutter_bloc for screens (Cubits), get_it for Dio and repositories', recommended: false },
  ];
  for (const o of options) o.recommended = o.id === recommended;
  return options.sort((a, b) => Number(b.recommended) - Number(a.recommended));
}

function networkFile(arch: string, baseUrl: string): string {
  const L = [
    "import 'package:dio/dio.dart';",
    "import 'package:flutter/foundation.dart';",
  ];
  if (arch === 'riverpod') L.push("import 'package:flutter_riverpod/flutter_riverpod.dart';");
  L.push(
    '',
    '/// Creates the Dio instance that every repository uses.',
    '///',
    '/// Add auth headers or token refresh here with an interceptor.',
    'Dio createDio() {',
    '  final dio = Dio(',
    '    BaseOptions(',
    `      baseUrl: '${baseUrl.replace(/'/g, "\\'")}',`,
    '      connectTimeout: const Duration(seconds: 20),',
    '      receiveTimeout: const Duration(seconds: 20),',
    "      headers: {'Accept': 'application/json'},",
    '    ),',
    '  );',
    '  if (kDebugMode) {',
    '    dio.interceptors.add(LogInterceptor(requestBody: true, responseBody: true));',
    '  }',
    '  return dio;',
    '}',
  );
  if (arch === 'riverpod') L.push('', 'final dioProvider = Provider<Dio>((ref) => createDio());');
  return L.join('\n') + '\n';
}

/** Adds missing packages under `dependencies:`, after the Flutter SDK entry. */
export function addPubspecDeps(text: string, packages: string[]): { text: string; added: string[] } {
  const have = pubspecDeps(text);
  const missing = packages.filter((p) => !have.has(p)).sort();
  if (!missing.length) return { text, added: [] };
  const eol = detectEol(text);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const depIdx = lines.findIndex((l) => /^dependencies:\s*$/.test(l));
  const newLines = missing.map((p) => `  ${p}: ${PACKAGES[p] ?? 'any'}`);
  if (depIdx === -1) {
    lines.push('', 'dependencies:', ...newLines);
  } else {
    let at = depIdx + 1;
    // Keep `flutter: sdk: flutter` first.
    if (/^ {2}flutter:\s*$/.test(lines[at] ?? '') && /^ {4}sdk:\s*flutter/.test(lines[at + 1] ?? '')) at += 2;
    // Then skip any other SDK packages (flutter_localizations etc.) so the new ones follow them.
    while (/^ {2}\w+:\s*$/.test(lines[at] ?? '') && /^ {4}sdk:/.test(lines[at + 1] ?? '')) at += 2;
    lines.splice(at, 0, ...newLines);
  }
  return { text: withEol(lines.join('\n'), eol), added: missing };
}

function wireMain(arch: string, main: string, c: Conventions, warnings: string[]): string | null {
  let t = main.replace(/\r\n/g, '\n');
  if (arch === 'getx') {
    if (/initialBinding\s*:/.test(t)) return null;
    const m = /\b(?<!Get)MaterialApp(\.router)?\s*\(/.exec(t) ?? /\bGetMaterialApp(\.router)?\s*\(/.exec(t);
    if (!m) {
      warnings.push('lib/main.dart has no MaterialApp, so GetMaterialApp was not wired in. Use GetMaterialApp(initialBinding: InitialBinding(), ...) yourself.');
      return null;
    }
    const lineStart = t.lastIndexOf('\n', m.index) + 1;
    const indent = t.slice(lineStart).match(/^[ \t]*/)![0];
    const open = m.index + m[0].length;
    const replacement = `${m[0].startsWith('Get') ? m[0] : `Get${m[0]}`}\n${indent}  initialBinding: InitialBinding(),`;
    t = t.slice(0, m.index) + replacement + t.slice(open);
    t = addDartImport(t, 'package:get/get.dart');
    t = addDartImport(t, importUri('lib/main.dart', LAYOUTS.getx.conventions.diFile, c));
    return t;
  }
  if (arch === 'riverpod') {
    if (/\bProviderScope\s*\(/.test(t)) return null;
    const m = /\brunApp\s*\(/.exec(t);
    if (!m) {
      warnings.push('lib/main.dart has no runApp call, so the app was not wrapped in ProviderScope. Do that yourself.');
      return null;
    }
    const open = m.index + m[0].length - 1;
    const close = matchBrace(t, open, 'dart');
    if (close === -1) return null;
    const inner = t.slice(open + 1, close).trim().replace(/,\s*$/, '');
    const wrapped = inner.startsWith('const ') ? `const ProviderScope(child: ${inner.slice(6)})` : `ProviderScope(child: ${inner})`;
    t = `${t.slice(0, open + 1)}${wrapped}${t.slice(close)}`;
    return addDartImport(t, 'package:flutter_riverpod/flutter_riverpod.dart');
  }
  // get_it
  if (/\bsetupDependencies\s*\(/.test(t)) return null;
  const m = /^([ \t]*)runApp\s*\(/m.exec(t);
  if (!m) {
    warnings.push('lib/main.dart has no runApp call, so setupDependencies() was not called. Call it at the start of main() yourself.');
    return null;
  }
  t = `${t.slice(0, m.index)}${m[1]}setupDependencies();\n${t.slice(m.index)}`;
  return addDartImport(t, importUri('lib/main.dart', LAYOUTS.get_it.conventions.diFile, c));
}

export function planFlutterSetup(ctx: AdapterContext, choice: SetupChoice): SetupPlan {
  const { root, map } = ctx;
  const layout = LAYOUTS[choice.architecture];
  if (!layout) throw new ToolError('bad_args', `Unknown architecture "${choice.architecture}". Choose getx, riverpod, get_it or bloc.`);
  const files = new Map<string, string>();
  const summary: string[] = [];
  const warnings: string[] = [];
  const read = (p: string) => readText(join(root, p));
  const baseUrl = choice.baseUrl || 'https://api.example.com';
  if (!choice.baseUrl) warnings.push(`No base URL was given, so ${layout.networkFile} uses https://api.example.com. Change it there before calling the API.`);

  const conventions: Conventions = {
    ...map.conventions,
    http: 'dio',
    serialization: map.conventions.serialization === 'json_serializable' ? 'json_serializable' : 'manual',
    modelFileSuffix: '_model',
    modelClassSuffix: 'Model',
    repoKind: 'repository',
    dioField: '_dio',
    // Keep relative imports when the project already uses them (the GetX CLI does); otherwise package imports.
    importStyle: walk(root, 'lib', { exts: ['.dart'] }).some((f) => /^import\s+['"](?!package:|dart:)/m.test(readText(join(root, f)) ?? '')) ? 'relative' : 'package',
    baseUrl,
    networkFile: layout.networkFile,
    ...layout.conventions,
  };
  // Keys that belong to another DI style would confuse later runs.
  for (const k of ['diFile', 'diInstance', 'dioProvider', 'dioProviderFile', 'modulesFolder', 'routesFile']) if (!(k in layout.conventions)) delete conventions[k];
  if (!conventions.packageName) throw new ToolError('no_package', 'pubspec.yaml has no name, so package imports cannot be written.');

  const create = (path: string, content: string, what: string) => {
    if (read(path) !== null) throw new ToolError('file_exists', `${path} already exists, so setup stopped without changing anything.`, 'Remove or rename it, or set up the project by hand and run codz init again.');
    files.set(path, content);
    summary.push(`Create ${path}: ${what}`);
  };

  create(layout.networkFile, networkFile(choice.architecture, baseUrl), choice.architecture === 'riverpod' ? 'createDio() and dioProvider' : `createDio() with base URL ${baseUrl}`);

  if (choice.architecture === 'getx') {
    let binding = [
      'class InitialBinding extends Bindings {',
      '  @override',
      '  void dependencies() {',
      '    Get.put<Dio>(createDio(), permanent: true);',
      '  }',
      '}',
    ].join('\n') + '\n';
    binding = addDartImport(binding, 'package:dio/dio.dart');
    binding = addDartImport(binding, 'package:get/get.dart');
    binding = addDartImport(binding, importUri(layout.conventions.diFile, layout.networkFile, conventions));
    create(layout.conventions.diFile, binding, 'InitialBinding that registers Dio; new repositories are added here');
  } else if (choice.architecture === 'get_it' || choice.architecture === 'bloc') {
    let di = [
      'final getIt = GetIt.instance;',
      '',
      '/// Registers app-wide dependencies. Called once from main().',
      'void setupDependencies() {',
      '  getIt.registerLazySingleton<Dio>(createDio);',
      '}',
    ].join('\n') + '\n';
    di = addDartImport(di, 'package:dio/dio.dart');
    di = addDartImport(di, 'package:get_it/get_it.dart');
    di = addDartImport(di, importUri(layout.conventions.diFile, layout.networkFile, conventions));
    create(layout.conventions.diFile, di, 'setupDependencies() that registers Dio; new repositories are added here');
  }

  const main = read('lib/main.dart');
  if (main === null) {
    warnings.push('lib/main.dart was not found, so the app entry point was not wired.');
  } else {
    const wired = wireMain(choice.architecture, main, conventions, warnings);
    if (wired !== null) {
      files.set('lib/main.dart', withEol(wired, detectEol(main)));
      summary.push(
        `Update lib/main.dart: ${choice.architecture === 'getx' ? 'GetMaterialApp with initialBinding' : choice.architecture === 'riverpod' ? 'wrap the app in ProviderScope' : 'call setupDependencies() before runApp'}`,
      );
    }
  }

  let dependenciesChanged = false;
  const pubspec = read('pubspec.yaml');
  if (pubspec !== null) {
    const { text, added } = addPubspecDeps(pubspec, layout.packages);
    if (added.length) {
      files.set('pubspec.yaml', text);
      summary.push(`Update pubspec.yaml: add ${added.join(', ')}`);
      dependenciesChanged = true;
    }
  }

  summary.push(`Save conventions: models in ${conventions.modelsFolder}, repositories in ${conventions.repoFolder}, registration with ${choice.architecture}`);
  return { files, summary, warnings, generated: [], conventions, dependenciesChanged };
}
