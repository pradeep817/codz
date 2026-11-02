// Flutter adapter, part 1: reading a project (pubspec, conventions, models,
// endpoints, routes, locales) into a ProjectMap.

import { join } from 'node:path';
import { isDir, readText, walk } from '../core/fsutil.ts';
import { type Conventions, type HttpMethod, type ModelInfo, type ProjectMap } from '../core/types.ts';
import { snake } from '../input/naming.ts';
import { emptyMap, fileStats, scanLocales } from './common.ts';
import { detectIndent, matchBrace, skipString } from './source.ts';
import { parseFreezedFields, scanRetrofit } from './flutterStyles.ts';

import { VERSION } from './flutter.ts';

const PLATFORM_DIRS = ['android', 'ios', 'macos', 'windows', 'linux', 'web', 'test', 'integration_test'];

export const relDir = (f: string) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.');
export const base = (f: string) => f.slice(f.lastIndexOf('/') + 1).replace(/\.dart$/, '');

export function mostCommon(items: string[], fallback: string): string {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i, (counts.get(i) ?? 0) + 1);
  let best = fallback;
  let n = 0;
  for (const [k, v] of counts) if (v > n) [best, n] = [k, v];
  return best;
}

export function pubspecDeps(text: string): Set<string> {
  const deps = new Set<string>();
  let inDeps = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^(dependencies|dev_dependencies):\s*$/.test(line)) {
      inDeps = true;
      continue;
    }
    if (/^\s*(#|$)/.test(line)) continue; // comments and blank lines do not end a section
    if (/^\S/.test(line)) inDeps = false;
    const m = line.match(/^ {2}([a-z0-9_]+):/);
    if (inDeps && m) deps.add(m[1]);
  }
  return deps;
}

/** Converts a Dart string literal body with $x / ${x} into a path with {x}. */
export function dartPath(literal: string): string {
  return literal
    .replace(/\$\{([^}]*)\}/g, (_s, e: string) => `{${(e.match(/[A-Za-z_]\w*/g) ?? ['param']).pop()}}`)
    .replace(/\$([A-Za-z_]\w*)/g, '{$1}')
    .split('?')[0];
}

/** A class-level field declaration: `final String? name;`, `int? id;`, `late List<Item> items;`. */
const FIELD_LINE = /^\s*(?:late\s+)?(?:final\s+)?((?:[A-Z][\w]*|int|double|num|bool|dynamic)(?:<[\w<>, ?]*>)?\??)\s+(\w+)\s*;\s*(?:\/\/.*)?$/;
/** A Dio field in a class, in any of the common styles. */
export const DIO_FIELD = /\b(?:static\s+)?(?:late\s+)?(?:final\s+)?Dio\??\s+(\w+)\s*(?:=[^;]*)?;/;

export function parseDartModels(text: string, file: string): ModelInfo[] {
  const out: ModelInfo[] = [];
  const re = /\bclass\s+(\w+)(?:<[^>]*>)?[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(text, open, 'dart');
    if (close === -1) continue;
    const body = text.slice(open + 1, close);
    if (!/fromJson/.test(body)) {
      re.lastIndex = close;
      continue;
    }
    const freezed = parseFreezedFields(body, m[1]);
    if (freezed) {
      out.push({ name: m[1], file, fields: freezed });
      re.lastIndex = close;
      continue;
    }
    const fields: ModelInfo['fields'] = [];
    // Class-level fields only (depth 0 inside the class), final or not.
    // @JsonKey(name: ...) on the same or the previous line keeps the JSON name.
    let depth = 0;
    let jsonKey: string | undefined;
    for (const line of body.split('\n')) {
      if (depth === 0) {
        const key = line.match(/@JsonKey\(\s*name:\s*['"]([^'"]+)['"]/);
        if (key) jsonKey = key[1];
        const f = line.replace(/@JsonKey\([^)]*\)\s*/, '').match(FIELD_LINE);
        if (f) {
          const type = f[1].trim();
          fields.push({ name: jsonKey ?? snake(f[2]), type: type.replace(/\?$/, ''), nullable: type.endsWith('?') });
          jsonKey = undefined;
        } else if (!key && line.trim() !== '') {
          jsonKey = undefined;
        }
      }
      depth += (line.match(/[{(\[]/g) ?? []).length - (line.match(/[})\]]/g) ?? []).length;
    }
    out.push({ name: m[1], file, fields });
    re.lastIndex = close;
  }
  return out;
}

export async function scan(root: string, configConventions: Conventions): Promise<ProjectMap> {
  const map = emptyMap('flutter', `flutter@${VERSION}`);
  const files = walk(root, '.', { extraIgnored: PLATFORM_DIRS });
  map.stats = fileStats(files);
  const dart = files.filter((f) => f.startsWith('lib/') && f.endsWith('.dart') && !/\.(g|freezed|gr)\.dart$/.test(f));
  const texts = new Map<string, string>();
  const text = (f: string) => {
    if (!texts.has(f)) texts.set(f, readText(join(root, f)) ?? '');
    return texts.get(f)!;
  };
  const pubspec = readText(join(root, 'pubspec.yaml')) ?? '';
  const deps = pubspecDeps(pubspec);
  const c: Conventions = {};
  c.packageName = pubspec.match(/^name:\s*([\w]+)/m)?.[1] ?? '';
  c.http = deps.has('dio') ? 'dio' : deps.has('http') ? 'http' : 'dio';
  c.serialization = deps.has('freezed') && dart.some((f) => /@freezed/.test(text(f))) ? 'freezed' : deps.has('json_serializable') ? 'json_serializable' : 'manual';
  c.stateManagement = deps.has('flutter_riverpod') || deps.has('hooks_riverpod') || deps.has('riverpod') ? 'riverpod' : deps.has('flutter_bloc') ? 'bloc' : deps.has('get') ? 'getx' : deps.has('provider') ? 'provider' : 'none';
  if (c.serialization === 'freezed') {
    const styles = dart.flatMap((f) => [...text(f).matchAll(/@freezed\s+(abstract\s+|sealed\s+)?class\b/g)].map((x) => (x[1] ? 'abstract' : 'plain')));
    const major = Number(pubspec.match(/^\s+freezed:\s*\^?(\d+)/m)?.[1] ?? '3');
    c.freezedClass = styles.length ? mostCommon(styles, 'abstract') : major >= 3 ? 'abstract' : 'plain';
  }
  const restApiFiles = deps.has('retrofit') ? dart.filter((f) => /@RestApi\s*\(/.test(text(f))) : [];
  if (deps.has('retrofit') && (restApiFiles.length > 0 || !dart.some((f) => DIO_FIELD.test(text(f))))) c.apiStyle = 'retrofit';
  c.router = deps.has('go_router') ? 'go_router' : deps.has('auto_route') ? 'auto_route' : 'navigator';

  // Models.
  const modelFiles = dart.filter((f) => /\b\w+\.fromJson\s*\(\s*(?:Map|dynamic)/.test(text(f)) && /\bclass\s+\w+/.test(text(f)));
  // No models yet: an existing (empty) models folder says where they go, as starters and layered templates set up.
  const emptyModels = ['lib/data/models', 'lib/models', 'lib/domain/models', 'lib/core/models'].find((d) => isDir(join(root, d)));
  c.modelsFolder = mostCommon(modelFiles.map(relDir), emptyModels ?? 'lib/models');
  {
    // Feature-first projects keep models in many folders; no single one is "the" models folder.
    const dirs = new Set(modelFiles.map(relDir));
    const inBest = modelFiles.filter((f) => relDir(f) === c.modelsFolder).length;
    if (dirs.size >= 3 && inBest * 2 < modelFiles.length) {
      map.notes.push(`Models live in ${dirs.size} different folders, so new ones go to lib/models. Use --model-dir <folder> or set modelsFolder in codz.config.yaml to choose.`);
      c.modelsFolder = 'lib/models';
    }
  }
  const modelBases = modelFiles.filter((f) => relDir(f) === c.modelsFolder).map(base);
  c.modelFileSuffix = modelBases.length && modelBases.filter((b) => b.endsWith('_model')).length * 2 >= modelBases.length ? '_model' : '';
  for (const f of modelFiles) map.models.push(...parseDartModels(text(f), f));
  const classNames = map.models.map((m) => m.name);
  c.modelClassSuffix = classNames.length && classNames.filter((n) => n.endsWith('Model')).length * 2 >= classNames.length ? 'Model' : '';
  const annotations = modelFiles.flatMap((f) => text(f).match(/@JsonSerializable\([^)]*\)/g) ?? []);
  c.jsonAnnotation = c.serialization === 'json_serializable' ? mostCommon(annotations, '@JsonSerializable()') : '';

  // Repositories / services: classes holding a Dio.
  const repoFiles = dart.filter((f) => DIO_FIELD.test(text(f)) && /\bclass\s+\w+/.test(text(f)));
  c.repoFolder = c.apiStyle === 'retrofit' ? mostCommon(restApiFiles.map(relDir), 'lib/data/api') : mostCommon(repoFiles.map(relDir), 'lib/data/repositories');
  const repoClasses = repoFiles.flatMap((f) => [...text(f).matchAll(/\bclass\s+(\w+)/g)].map((m) => m[1]));
  c.repoKind = mostCommon(repoClasses.map((n) => (/Repository$/.test(n) ? 'repository' : /Service$/.test(n) ? 'service' : /Api$/.test(n) ? 'api' : '')).filter(Boolean), 'repository');
  c.dioField = mostCommon(repoFiles.map((f) => text(f).match(DIO_FIELD)?.[1] ?? ''), '_dio');

  // Registration.
  const dioProv = dart.map((f) => ({ f, m: text(f).match(/final\s+(\w+)\s*=\s*Provider<Dio>/) })).find((x) => x.m);
  const getItFile = dart.find((f) => /\.registerLazySingleton|\.registerSingleton|\.registerFactory/.test(text(f)));
  // GetX: a Bindings class that registers with Get.put / Get.lazyPut. Prefer the app-wide initial binding.
  // A binding that only registers its module's controller is not where app-wide services go.
  const registersService = (t: string) =>
    [...t.matchAll(/\bGet\.(?:lazyPut|put|putAsync)\s*(?:<\s*(\w+)\s*>)?\s*\(\s*(?:\(\)\s*=>\s*)?(\w+)?/g)].some((m) => {
      const type = m[1] ?? m[2] ?? '';
      return type !== '' && !/Controller$/.test(type);
    });
  const bindings = dart.filter((f) => /\b(?:extends|implements)\s+Bindings\b/.test(text(f)) && registersService(text(f)));
  const getxFile =
    bindings.find((f) => /initial|app_binding|global/i.test(f)) ??
    [...bindings].sort((a, b) => (text(b).match(/\bGet\.(?:lazyPut|put)/g) ?? []).length - (text(a).match(/\bGet\.(?:lazyPut|put)/g) ?? []).length)[0];
  if (dioProv && c.stateManagement === 'riverpod') {
    c.di = 'riverpod';
    c.dioProvider = dioProv.m![1];
    c.dioProviderFile = dioProv.f;
  } else if (getxFile) {
    c.di = 'getx';
    c.diFile = getxFile;
  } else if (getItFile) {
    c.di = 'get_it';
    c.diFile = getItFile;
    c.diInstance = text(getItFile).match(/((?:GetIt\.(?:I|instance))|\w+)\.register(?:LazySingleton|Singleton|Factory)/)?.[1] ?? 'getIt';
  } else {
    c.di = 'none';
  }

  // Base URL.
  const baseUrls = dart.flatMap((f) => [...text(f).matchAll(/baseUrl:\s*['"](https?:\/\/[^'"]+)['"]/g), ...(/baseUrl:\s*\w+/.test(text(f)) ? text(f).matchAll(/String\.fromEnvironment\(\s*'[A-Z_]+'\s*,\s*defaultValue:\s*['"](https?:\/\/[^'"]+)['"]/g) : [])].map((m) => ({ f, v: m[1] })));
  c.baseUrl = baseUrls[0]?.v ?? '';
  map.baseUrls = baseUrls.map((b) => ({ name: 'Dio baseUrl', value: b.v, file: b.f }));
  // Dio with a base URL codz cannot read (baseUrl: Env.apiUrl, dio.options.baseUrl = ...): calls still go relative to it.
  map.clientBaseUrl = baseUrls.length > 0 || dart.some((f) => /\b(?:BaseOptions|Dio)\s*\([^;]*?\bbaseUrl\s*:|\.options\.baseUrl\s*=|@RestApi\(\s*baseUrl\s*:/s.test(text(f)));

  // Import and code style.
  const imports = dart.flatMap((f) => text(f).match(/^import\s+'([^']+)'/gm) ?? []);
  const pkgImports = imports.filter((i) => c.packageName && i.includes(`package:${c.packageName}/`)).length;
  const relImports = imports.filter((i) => !i.includes('package:') && !i.includes('dart:')).length;
  c.importStyle = pkgImports > relImports ? 'package' : 'relative';
  const ind = detectIndent(dart.slice(0, 30).map(text).join('\n'));
  c.indent = ind === '\t' ? 'tab' : String(ind.length);

  map.conventions = { ...c, ...configConventions };
  const conv = map.conventions;
  if (conv.http !== 'dio') map.notes.push(`This project uses the ${conv.http} package. The supported setup is Dio, so \`api add\` is not available yet.`);
  // Retrofit clients: annotated abstract methods.
  for (const f of restApiFiles) for (const e of scanRetrofit(text(f))) map.endpoints.push({ name: e.name, method: e.method, path: e.path, response: e.response, file: f, calledFrom: [] });

  // Endpoints: Future-returning methods that call the Dio field.
  for (const f of repoFiles) {
    const t = text(f);
    const re = /Future<(.+?)>\s+(\w+)\s*\(([^)]*)\)\s*async\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      const open = m.index + m[0].length - 1;
      const close = matchBrace(t, open, 'dart');
      if (close === -1) continue;
      const body = t.slice(open, close + 1);
      const call = body.match(/\.(get|post|put|patch|delete|head)\s*(?:<[^(]*>)?\s*\(\s*/);
      if (!call) continue;
      const at = call.index! + call[0].length;
      const q = body[at];
      if (q !== "'" && q !== '"') continue;
      const end = skipString(body, at, 'dart');
      const path = dartPath(body.slice(at + 1, end - 1));
      if (!path.startsWith('/') && !/^https?:/.test(path)) continue;
      const response = m[1].trim();
      map.endpoints.push({ name: m[2], method: call[1].toUpperCase() as HttpMethod, path, response, file: f, calledFrom: [] });
      re.lastIndex = close;
    }
  }
  // Call sites: `.methodName(` in files that import the repository file.
  for (const f of dart) {
    const t = text(f);
    for (const ep of map.endpoints) {
      if (ep.file === f) continue;
      const imported = t.includes(base(ep.file) + '.dart');
      if (imported && new RegExp(`\\.${ep.name}\\s*\\(`).test(t)) ep.calledFrom.push(f);
    }
  }

  // Routes.
  for (const f of dart) {
    const t = text(f);
    for (const m of t.matchAll(/GoRoute\(/g)) {
      const open = m.index! + m[0].length - 1;
      const close = matchBrace(t, open, 'dart');
      const block = t.slice(open, close === -1 ? open + 400 : close);
      // Only the route's own arguments, not nested child routes.
      const own = block.split(/routes:\s*\[/)[0];
      const path = own.match(/path:\s*['"]([^'"]+)['"]/)?.[1];
      if (!path) continue;
      const name = own.match(/name:\s*['"]([^'"]+)['"]/)?.[1] ?? (path.replace(/[/:]/g, ' ').trim().split(/\s+/)[0] || 'home');
      const params = [...path.matchAll(/:(\w+)/g)].map((p) => p[1]);
      map.routes.push({ name, path: path.replace(/:(\w+)/g, '{$1}'), params, file: f });
    }
    for (const m of t.matchAll(/AutoRoute\(([^)]*)\)/g)) {
      const path = m[1].match(/path:\s*['"]([^'"]+)['"]/)?.[1];
      const page = m[1].match(/page:\s*(\w+)\.page/)?.[1];
      if (path || page) map.routes.push({ name: page ?? path!, path: (path ?? '').replace(/:(\w+)/g, '{$1}'), params: [...(path ?? '').matchAll(/:(\w+)/g)].map((p) => p[1]), file: f });
    }
  }
  // GetX pages: GetPage(name: _Paths.home / Routes.home / '/home', ...) with paths from app_routes.dart.
  const pathConsts = new Map<string, string>();
  for (const f of dart) for (const m of text(f).matchAll(/static\s+const\s+(\w+)\s*=\s*['"](\/[^'"]*)['"]/g)) pathConsts.set(m[1], m[2]);
  for (const f of dart) {
    for (const m of text(f).matchAll(/GetPage\s*\(/g)) {
      const t = text(f);
      const close = matchBrace(t, m.index! + m[0].length - 1, 'dart');
      const block = t.slice(m.index!, close === -1 ? m.index! + 300 : close);
      const own = block.split(/children:\s*\[/)[0];
      const name = own.match(/name:\s*(?:(?:_Paths|Routes)\.(\w+)|['"]([^'"]+)['"])/);
      if (!name) continue;
      const path = name[2] ?? pathConsts.get(name[1]) ?? `/${name[1]}`;
      const page = own.match(/page:\s*\(\)\s*=>\s*(?:const\s+)?(\w+)/)?.[1];
      map.routes.push({ name: page ?? name[1] ?? path, path: path.replace(/:(\w+)/g, '{$1}'), params: [...path.matchAll(/:(\w+)/g)].map((x) => x[1]), file: f });
    }
  }
  if (dart.some((f) => /GetPage\s*\(/.test(text(f)))) conv.router = configConventions.router ?? 'getx';
  if (!conv.networkFile) conv.networkFile = dart.find((f) => /\bBaseOptions\s*\(/.test(text(f)) && /\bDio\s*\(/.test(text(f))) ?? '';
  if (!conv.modulesFolder) conv.modulesFolder = dart.some((f) => f.startsWith('lib/app/modules/')) || conv.di === 'getx' ? 'lib/app/modules' : '';
  if (!conv.routesFile) conv.routesFile = dart.find((f) => /(^|\/)app_pages\.dart$/.test(f)) ?? (conv.di === 'getx' ? 'lib/app/routes/app_pages.dart' : '');
  map.routes.sort((a, b) => a.path.localeCompare(b.path));

  map.locales = scanLocales(root, files);
  if (!map.locales.files.length) {
    // GetX keeps texts in a Translations class: 'en_US': {'key': 'text'}.
    const tf = dart.find((f) => /\bextends\s+Translations\b/.test(text(f)));
    if (tf) {
      const langs = [...text(tf).matchAll(/['"]([a-z]{2,3})(?:[_-][A-Z]{2})?['"]\s*:\s*(?:\{|[A-Za-z_])/g)].map((m) => m[1]);
      const first = text(tf).match(/['"][a-z]{2,3}(?:[_-][A-Z]{2})?['"]\s*:\s*\{([^}]*)\}/)?.[1] ?? '';
      map.locales = {
        languages: [...new Set(langs)],
        default: langs.includes('en') ? 'en' : langs[0],
        files: [tf],
        keyCount: [...first.matchAll(/['"]\s*:\s*['"]/g)].length,
      };
    }
  }
  return map;
}

// ---------------- Generation ----------------

