// Flutter adapter. Supported setup: Dio, called from repository/service
// classes or through Retrofit clients; models with hand-written fromJson,
// json_serializable or freezed; GetX, Riverpod providers or get_it for
// registration; go_router or auto_route for routes; ARB locales.
// Not yet: the http package, Chopper.
//
// Dart code is edited with brace-aware text edits at well-defined insertion
// points (end of class, import block, registration list). `dart format` and
// `dart analyze` run afterwards when the Dart SDK is installed, and a new
// analyzer error reverts the change.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { detectEol, exists, readText, walk, withEol } from '../core/fsutil.ts';
import { ToolError, type Adapter, type AdapterContext, type EndpointSpec, type PlannedEdits } from '../core/types.ts';
import { camel, singular, snake, typeName } from '../input/naming.ts';
import { specRelativePath } from './common.ts';
import { referencedModels, resolveModels } from './models.ts';
import { flutterArchitectures, planFlutterSetup } from './flutterSetup.ts';
import { planGetxModule, planGetxWire } from './getx.ts';
import { matchBrace } from './source.ts';
import { dartType, type DartGen } from './dartGen.ts';
import { applyTemplate } from '../core/templates.ts';
import { newRetrofitClient, renderRetrofitMethod } from './flutterStyles.ts';

import { scan, base, pubspecDeps } from './flutterScan.ts';
import { addDartImport, addToClass, importUri, indentStyled, insertGetxRegistration, r0, renderMethod, renderModel, resourceOf } from './flutterGen.ts';

// Other modules import these from here.
export { DIO_FIELD, pubspecDeps } from './flutterScan.ts';
export { addDartImport, addToClass, importUri, insertGetxRegistration } from './flutterGen.ts';

export const VERSION = '0.1.0';

export const FLUTTER_CONVENTION_DOCS: Record<string, string> = {
  templatesFolder: 'folder with custom templates (codz templates list)',
  packageName: 'package name from pubspec.yaml',
  http: 'HTTP client: dio or http',
  serialization: 'model serialization: manual (hand-written fromJson), json_serializable or freezed',
  freezedClass: 'freezed class declaration: abstract (freezed 3) or plain (freezed 2)',
  apiStyle: 'how API calls are written: repository (classes calling Dio) or retrofit (@RestApi clients)',
  jsonAnnotation: 'annotation used on json_serializable models',
  modelsFolder: 'where model classes live',
  modelFileSuffix: 'suffix in model file names, for example _model, or empty',
  modelClassSuffix: 'suffix in model class names, for example Model, or empty',
  repoFolder: 'where repository or service classes live',
  repoKind: 'class kind for API calls: repository, service or api',
  dioField: 'name of the Dio field inside repository classes',
  di: 'how repositories are registered: getx, riverpod, get_it or none',
  dioProvider: 'Riverpod provider that supplies Dio (riverpod only)',
  dioProviderFile: 'file that defines the Dio provider (riverpod only)',
  diFile: 'file where new classes are registered: the GetX binding or the get_it setup',
  diInstance: 'name of the get_it instance, for example getIt (get_it only)',
  baseUrl: 'Dio base URL found in the code, if it is a literal',
  importStyle: 'package or relative imports',
  stateManagement: 'state management library',
  router: 'router library',
  indent: 'indentation used in Dart files',
  networkFile: 'file that creates the Dio instance (mocks are registered there)',
  modulesFolder: 'where feature modules live (GetX CLI layout: <name>/bindings, controllers, views)',
  routesFile: 'GetX app_pages.dart with the GetPage list (app_routes.dart sits next to it)',
};


async function planEndpoint(ctx: AdapterContext, input: EndpointSpec, overlay?: Map<string, string>, opts: { replaceModels?: boolean; targetFile?: string } = {}): Promise<PlannedEdits> {
  const { root, map } = ctx;
  const c = map.conventions;
  if (c.http !== 'dio') throw new ToolError('unsupported_setup', `This project uses the ${c.http} package; the Flutter adapter supports Dio only so far.`);
  const missingDio = !pubspecDeps(readText(join(root, 'pubspec.yaml')) ?? '').has('dio');
  const retrofit = c.apiStyle === 'retrofit';
  if (retrofit && input.unwrapData) throw new ToolError('unsupported_setup', 'This response wraps its data in {"data": ...}, and a Retrofit method returns the whole body.', 'Run again with --no-unwrap to generate a model for the whole body.');
  const suffix = c.modelClassSuffix ?? '';
  const g: DartGen = { c, indent: c.indent === 'tab' ? '\t' : ' '.repeat(Number(c.indent) || 2), cls: (n) => (suffix && !n.endsWith(suffix) ? `${n}${suffix}` : n) };
  const files = new Map<string, string>(overlay ?? []);
  const read = (p: string) => files.get(p) ?? readText(join(root, p));
  const summary: string[] = [];
  const warnings = [...input.warnings];
  const { spec, reused, replaced, notes } = resolveModels(input, map.models, g.cls, { replace: opts.replaceModels });
  warnings.push(...notes);
  if (missingDio) warnings.push('dio is not in pubspec.yaml yet; the generated code needs it. Run `flutter pub add dio` (or `codz setup` for the whole networking layer).');

  // Base URL: keep only the path when the host matches Dio's baseUrl. An endpoint from an API spec is
  // always relative to Dio's baseUrl: the spec's server is a stand-in for it (another environment).
  let path = spec.path;
  const fromSpec = specRelativePath(spec, c.baseUrl);
  if (fromSpec !== null && (c.baseUrl || map.clientBaseUrl)) path = fromSpec;
  else if (c.baseUrl) {
    const b = new URL(c.baseUrl);
    const prefix = b.pathname.replace(/\/$/, '');
    if ((!spec.origin || spec.origin === b.origin) && path.startsWith(prefix)) path = path.slice(prefix.length) || '/';
    else if ((!spec.origin || spec.origin === b.origin) && prefix && !opts.targetFile) {
      warnings.push(`Dio's baseUrl ends in ${prefix}, so this call goes to ${prefix}${path}. If the API path is really ${path}, remove ${prefix} from the baseUrl.`);
    }
    else if (spec.origin && spec.origin !== b.origin) {
      path = `${spec.origin}${spec.path}`;
      warnings.push(`The URL host ${spec.origin} differs from Dio's baseUrl (${c.baseUrl}), so the full URL is used for this call.`);
    }
  }

  // Already there?
  const existingEp = map.endpoints.find((e) => e.name === spec.name);
  if (existingEp) {
    if (existingEp.method === spec.method && existingEp.path.replace(/\{\w+\}/g, '{}') === path.replace(/\{\w+\}/g, '{}')) {
      return { files, summary: [`${spec.name} already exists in ${existingEp.file}; nothing to do.`], warnings: [], generated: [] };
    }
    throw new ToolError('name_conflict', `A method called ${spec.name} already exists in ${existingEp.file} for ${existingEp.method} ${existingEp.path}.`, 'Pass --name <methodName> to use another name.');
  }

  // Models.
  const modelFile = new Map<string, string>();
  for (const [name, info] of reused) modelFile.set(name, info.file);
  for (const m of spec.models) modelFile.set(m.name, replaced.get(m.name)?.file ?? `${c.modelsFolder}/${snake(g.cls(m.name).replace(new RegExp(`${suffix}$`), ''))}${c.modelFileSuffix}.dart`);
  for (const m of spec.models) {
    const file = modelFile.get(m.name)!;
    const existingText = read(file);
    let content: string;
    if (replaced.has(m.name) && existingText !== null) {
      // Rewrite just this class; keep the rest of the file (other classes, part directives).
      const rendered = applyTemplate(root, 'model.dart', indentStyled(renderModel(m, g, base(file)), g), { name: g.cls(m.name) }, warnings);
      const classOnly = rendered.slice(rendered.search(/^(@JsonSerializable|@freezed|@Freezed|(?:abstract |sealed )?class )/m));
      const cm = new RegExp(`((?:^|\\n)(?:[ \\t]*(?:///[^\\n]*|@\\w+(?:\\([^)]*\\))?)\\n)*)[ \\t]*(?:abstract\\s+|sealed\\s+)?class\\s+${g.cls(m.name)}\\b[^{]*\\{`).exec(existingText);
      if (!cm) throw new ToolError('class_not_found', `Could not find class ${g.cls(m.name)} in ${file}.`);
      const start = cm.index + (cm[1].startsWith('\n') ? 1 : 0);
      const close = matchBrace(existingText, cm.index + cm[0].length - 1, 'dart');
      content = existingText.slice(0, start) + classOnly + existingText.slice(close + 1);
      if (c.serialization === 'json_serializable') content = addDartImport(content, 'package:json_annotation/json_annotation.dart');
      if (c.serialization === 'freezed') content = addDartImport(content, 'package:freezed_annotation/freezed_annotation.dart');
    } else {
      if (existingText !== null) throw new ToolError('file_exists', `${file} already exists but does not define ${g.cls(m.name)}.`, 'Pass --model-name <Name> to use another name.');
      content = applyTemplate(root, 'model.dart', indentStyled(renderModel(m, g, base(file)), g), { name: g.cls(m.name) }, warnings) + '\n';
    }
    const deps = new Set<string>();
    for (const f of m.fields) referencedModels(f.type, deps);
    for (const d of [...deps].sort()) {
      const df = modelFile.get(d);
      if (df && df !== file) content = addDartImport(content, importUri(file, df, c));
    }
    files.set(file, content);
    summary.push(`${replaced.has(m.name) ? 'Update' : 'Create'} ${file}: class ${g.cls(m.name)}${replaced.has(m.name) ? ' (rewritten)' : ''}`);
  }
  if ((c.serialization === 'json_serializable' || c.serialization === 'freezed') && spec.models.length) warnings.push(`Run \`dart run build_runner build\` to generate the ${c.serialization === 'freezed' ? '.freezed.dart and .g.dart' : '.g.dart'} files for the new models.`);

  // Repository.
  const resource = resourceOf(spec.path);
  const kind = retrofit ? 'api' : c.repoKind || 'repository';
  const clsWanted = typeName(`${singular(resource)} ${kind}`, 'Api');
  const fromEndpoints = map.endpoints.find((e) => resourceOf(e.path) === resource)?.file;
  const repoFiles = [...new Set([...walk(root, 'lib', { exts: ['.dart'] }), ...[...files.keys()].filter((f) => f.startsWith('lib/') && f.endsWith('.dart'))])].sort();
  const byClass = repoFiles.find((f) => new RegExp(`\\bclass\\s+${clsWanted}\\b`).test(read(f) ?? ''));
  let repoFile = opts.targetFile ?? fromEndpoints ?? byClass;
  let repoClass: string;
  let repoText: string;
  const field = c.dioField || '_dio';
  let created = false;
  if (repoFile) {
    repoText = read(repoFile)!;
    const classes = [...repoText.matchAll(/\bclass\s+(\w+)[^{]*\{/g)].map((m) => m[1]);
    repoClass = retrofit
      ? (/@RestApi\s*\([^)]*\)\s*abstract\s+class\s+(\w+)/.exec(repoText)?.[1] ?? classes[0])
      : (classes.find((n) => new RegExp(`class\\s+${n}\\b[^{]*\\{[\\s\\S]*\\bDio\\??\\s+\\w+\\s*[=;]`).test(repoText)) ?? classes[0]);
    if (new RegExp(`\\b${spec.name}\\s*\\(`).test(repoText)) throw new ToolError('name_conflict', `${repoFile} already has a member called ${spec.name}.`, 'Pass --name <methodName> to use another name.');
  } else {
    created = true;
    repoClass = clsWanted;
    repoFile = `${c.repoFolder}/${snake(clsWanted)}.dart`;
    const L: string[] = [];
    if (c.di === 'riverpod') {
      L.push(`final ${camel(repoClass)}Provider = Provider<${repoClass}>((ref) {`, `  return ${repoClass}(ref.watch(${c.dioProvider}));`, '});', '');
    }
    if (retrofit) {
      repoText = newRetrofitClient(repoClass, base(repoFile));
      if (L.length) repoText = repoText.replace(/\n@RestApi/, `\n${L.join('\n')}\n@RestApi`);
    } else {
      L.push(`class ${repoClass} {`, `  ${repoClass}(this.${field});`, '', `  final Dio ${field};`, '}');
      repoText = L.join('\n') + '\n';
    }
    repoText = addDartImport(repoText, 'package:dio/dio.dart');
    if (c.di === 'riverpod') {
      repoText = addDartImport(repoText, 'package:flutter_riverpod/flutter_riverpod.dart');
      repoText = addDartImport(repoText, importUri(repoFile, c.dioProviderFile, c));
    }
  }
  const eol = detectEol(repoText);
  const methodText = indentStyled(retrofit ? renderRetrofitMethod(spec, g, path) : renderMethod(spec, g, path, field), g);
  let newRepo = addToClass(repoText.replace(/\r\n/g, '\n'), repoClass, applyTemplate(root, 'api-method.dart', methodText, { name: spec.name, method: spec.method, path, returnType: r0(spec, g) }, warnings));
  if (retrofit) warnings.push(`Run \`dart run build_runner build\` to regenerate ${base(repoFile)}.g.dart after this change.`);
  const typeRefs = new Set<string>();
  referencedModels(spec.response, typeRefs);
  referencedModels(spec.request, typeRefs);
  for (const t of [...typeRefs].sort()) newRepo = addDartImport(newRepo, importUri(repoFile, modelFile.get(t)!, c));
  files.set(repoFile, withEol(newRepo, eol));
  summary.push(`${created ? 'Create' : 'Update'} ${repoFile}: ${repoClass}.${spec.name}() for ${spec.method} ${spec.path}`);

  // Registration for a new repository.
  if (created) {
    if (c.di === 'riverpod') {
      summary.push(`Register ${repoClass} with a Riverpod provider (${camel(repoClass)}Provider) in ${repoFile}`);
    } else if (c.di === 'get_it' && c.diFile) {
      const di = read(c.diFile)!;
      const inst = c.diInstance ?? 'getIt';
      const instRe = inst.replace(/\./g, '\\.');
      // After the last one-line registration (lazy singletons first, then any kind).
      const regs = [...di.matchAll(new RegExp(`^([ \\t]*)${instRe}\\.registerLazySingleton<.*\\);[ \\t]*$`, 'gm'))];
      if (!regs.length) regs.push(...di.matchAll(new RegExp(`^([ \\t]*)${instRe}\\.register\\w*<.*\\);[ \\t]*$`, 'gm')));
      const line = `${inst}.registerLazySingleton<${repoClass}>(() => ${repoClass}(${inst}()));`;
      if (regs.length) {
        const last = regs[regs.length - 1];
        const at = last.index! + last[0].length;
        const updated = addDartImport(`${di.slice(0, at)}\n${last[1]}${line}${di.slice(at)}`.replace(/\r\n/g, '\n'), importUri(c.diFile, repoFile, c));
        files.set(c.diFile, withEol(updated, detectEol(di)));
        summary.push(`Update ${c.diFile}: register ${repoClass} with get_it`);
        if (!new RegExp(`register\\w*<Dio>|register\\w*\\(\\s*(?:\\(\\)\\s*=>\\s*)?Dio\\(`).test(di)) {
          warnings.push(`No Dio is registered in ${c.diFile}, and ${repoClass} gets its Dio from get_it. Register one, for example ${inst}.registerLazySingleton<Dio>(() => Dio(BaseOptions(baseUrl: ...))).`);
        }
      } else {
        warnings.push(`Could not find where ${c.diFile} registers services with get_it; register ${repoClass} there by hand: ${line}`);
      }
    } else if (c.di === 'getx' && c.diFile) {
      const di = read(c.diFile);
      if (di === null) {
        warnings.push(`The GetX binding ${c.diFile} was not found; register ${repoClass} there by hand.`);
      } else {
        const line = `Get.lazyPut<${repoClass}>(() => ${repoClass}(Get.find<Dio>()), fenix: true);`;
        let updated = insertGetxRegistration(di.replace(/\r\n/g, '\n'), line);
        if (updated === null) {
          warnings.push(`Could not find where ${c.diFile} registers dependencies; register ${repoClass} there by hand.`);
        } else {
          updated = addDartImport(updated, 'package:dio/dio.dart');
          updated = addDartImport(updated, importUri(c.diFile, repoFile, c));
          files.set(c.diFile, withEol(updated, detectEol(di)));
          summary.push(`Update ${c.diFile}: register ${repoClass} with Get.lazyPut`);
        }
      }
    } else {
      warnings.push(`No dependency injection setup was detected, so ${repoClass} is not registered anywhere. Run \`codz setup\` to add one.`);
    }
  }

  return {
    files,
    summary,
    warnings,
    generated: [{ skill: 'api add', file: repoFile, symbol: spec.name, inputHash: '' }],
    endpoints: [{ name: spec.name, method: spec.method, path, response: r0(spec, g), file: repoFile, calledFrom: [] }],
    models: spec.models.map((m) => ({ name: g.cls(m.name), file: modelFile.get(m.name)!, fields: m.fields.map((f) => ({ name: f.jsonName, type: dartType(f.type, g), nullable: f.nullable })) })),
  };
}

export const flutterAdapter: Adapter = {
  id: 'flutter',
  version: VERSION,
  capabilities: { explain: true, apiAdd: true },
  supportedSetup: 'Flutter with Dio (repository classes or Retrofit clients); manual fromJson, json_serializable or freezed models; GetX, Riverpod or get_it. Not yet: http package, Chopper.',
  scan,
  planEndpoint,
  planModule: planGetxModule,
  planWire: planGetxWire,
  architectures: flutterArchitectures,
  planSetup: planFlutterSetup,
  afterSetup() {
    const probe = spawnSync('flutter', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
    if (probe.error || probe.status !== 0) return null;
    return { cmd: 'flutter', args: ['pub', 'get'], label: 'flutter pub get' };
  },
  formatCommand(_root, files) {
    const dart = files.filter((f) => f.endsWith('.dart'));
    return dart.length ? { cmd: 'dart', args: ['format', ...dart] } : null;
  },
  verifyCommand(root, files) {
    const dart = files.filter((f) => f.endsWith('.dart'));
    // Analysis is only meaningful after `flutter pub get`.
    if (!dart.length || !exists(join(root, '.dart_tool', 'package_config.json'))) return null;
    return { cmd: 'dart', args: ['analyze', '--no-fatal-warnings', ...dart] };
  },
};
