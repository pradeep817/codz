// Android adapter (Kotlin). Supported setup: an app module using Retrofit with
// suspend functions, data classes for models (kotlinx.serialization, Moshi or
// Gson), and Hilt, Koin or a hand-written service locator for registration;
// Jetpack Compose with Navigation Compose for screens.
//
// Kotlin is edited with brace-aware text edits, like Dart: a method at the end
// of an interface, a data class per model file, a provider in the network
// module. Gradle files are edited only by setup (dependencies and plugins).

import { join } from 'node:path';
import { detectEol, exists, isDir, readText, walk, withEol } from '../core/fsutil.ts';
import { ToolError, type Adapter, type AdapterContext, type Conventions, type EndpointSpec, type HttpMethod, type ModelInfo, type PlannedEdits, type ProjectMap } from '../core/types.ts';
import { pascal, singular } from '../input/naming.ts';
import { emptyMap, fileStats, scanLocales, specRelativePath } from './common.ts';
import { addKotlinImports, kotlinType, renderDataClass, renderRetrofitFun } from './kotlinGen.ts';
import { referencedModels, resolveModels } from './models.ts';
import { androidArchitectures, planAndroidSetup } from './androidSetup.ts';
import { matchBrace } from './source.ts';

export const ANDROID_VERSION = '0.1.0';

export const ANDROID_CONVENTION_DOCS: Record<string, string> = {
  module: 'the app module folder (usually app)',
  namespace: 'the app package (namespace in build.gradle)',
  srcDir: 'Kotlin source root of the app module',
  http: 'HTTP client: retrofit (supported), ktor or none',
  serialization: 'JSON library: kotlinx, moshi or gson',
  di: 'how API interfaces are registered: hilt, koin, manual or none',
  diFile: 'the Hilt module, Koin module or service locator that creates Retrofit',
  ui: 'compose or views',
  apiFolder: 'where Retrofit interfaces live',
  modelsFolder: 'where data classes for API data live',
  screensFolder: 'where Compose screens live',
  navFile: 'the file with the Compose NavHost',
  baseUrl: 'Retrofit base URL found in the code, if it is a literal',
  versionCatalog: 'gradle/libs.versions.toml, when the project uses one',
  indent: 'indentation used in Kotlin files',
};

const dirOf = (f: string) => f.slice(0, f.lastIndexOf('/'));
const mostCommon = (xs: string[], fallback: string) => {
  const n = new Map<string, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback;
};

/** The package a Kotlin file under srcDir belongs to. */
export function packageOf(srcDir: string, dir: string): string {
  return dir.slice(srcDir.length + 1).replace(/\//g, '.');
}

/** The app module: a folder whose build file applies the Android application plugin. */
export function findAppModule(root: string): string | null {
  for (const m of ['app', ...walk(root, '.', { exts: ['build.gradle.kts', 'build.gradle'], maxFiles: 2000 }).map(dirOf).filter((d) => d && !d.includes('/'))]) {
    const t = readText(join(root, m, 'build.gradle.kts')) ?? readText(join(root, m, 'build.gradle'));
    if (t && /com\.android\.application|android\.application/.test(t)) return m;
  }
  return null;
}

const RETROFIT_FUN = /@(GET|POST|PUT|PATCH|DELETE|HEAD)\(\s*"([^"]*)"\s*\)\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:suspend\s+)?fun\s+(\w+)\s*\(/g;

function parseDataClasses(text: string, file: string): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const m of text.matchAll(/\bdata\s+class\s+(\w+)\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchBrace(text, open, 'dart');
    if (close === -1) continue;
    const fields: ModelInfo['fields'] = [];
    for (const p of text.slice(open + 1, close).split(/,(?![^<(]*[>)])/)) {
      const json = /@(?:SerialName|SerializedName)\(\s*"([^"]+)"\s*\)|@Json\(\s*name\s*=\s*"([^"]+)"\s*\)/.exec(p);
      const f = /\b(?:val|var)\s+`?(\w+)`?\s*:\s*([\w<>?, .]+?)\s*(?:=|$)/.exec(p.replace(/\/\/[^\n]*/g, '').trim());
      if (!f) continue;
      const type = f[2].trim();
      fields.push({ name: json?.[1] ?? json?.[2] ?? f[1], type: type.replace(/\?$/, ''), nullable: type.endsWith('?') });
    }
    out.push({ name: m[1], file, fields });
  }
  return out;
}

async function scan(root: string, configConventions: Conventions): Promise<ProjectMap> {
  const map = emptyMap('android', `android@${ANDROID_VERSION}`);
  const files = walk(root, '.', { extraIgnored: ['build', '.gradle', '.idea'] });
  map.stats = fileStats(files);
  const c: Conventions = {};
  const module = findAppModule(root) ?? 'app';
  c.module = module;
  const buildFile = ['build.gradle.kts', 'build.gradle'].map((f) => `${module}/${f}`).find((f) => exists(join(root, f))) ?? `${module}/build.gradle.kts`;
  const build = readText(join(root, buildFile)) ?? '';
  const catalog = readText(join(root, 'gradle/libs.versions.toml')) ?? '';
  c.versionCatalog = catalog ? 'gradle/libs.versions.toml' : '';
  const manifest = readText(join(root, module, 'src/main/AndroidManifest.xml')) ?? '';
  c.namespace = /namespace\s*=?\s*["']([\w.]+)["']/.exec(build)?.[1] ?? /package\s*=\s*"([\w.]+)"/.exec(manifest)?.[1] ?? '';
  c.srcDir = [`${module}/src/main/kotlin`, `${module}/src/main/java`].find((d) => isDir(join(root, d)) && (!c.namespace || isDir(join(root, d, ...c.namespace.split('.'))))) ?? `${module}/src/main/java`;
  const pkgDir = c.namespace ? `${c.srcDir}/${c.namespace.replace(/\./g, '/')}` : c.srcDir;
  const deps = `${build}\n${catalog}`;
  c.http = /com\.squareup\.retrofit2/.test(deps) ? 'retrofit' : /io\.ktor/.test(deps) ? 'ktor' : 'none';
  c.serialization = /org\.jetbrains\.kotlinx[:"].*serialization|kotlinx-serialization-json/.test(deps) ? 'kotlinx' : /com\.squareup\.moshi/.test(deps) ? 'moshi' : /com\.google\.code\.gson|converter-gson/.test(deps) ? 'gson' : 'kotlinx';
  c.di = /com\.google\.dagger[:"].*hilt|com\.google\.dagger\.hilt\.android/.test(deps) ? 'hilt' : /io\.insert-koin/.test(deps) ? 'koin' : 'none';
  c.ui = /compose\s*=\s*true|androidx\.compose|compose-bom/.test(deps) ? 'compose' : 'views';

  const kt = files.filter((f) => f.startsWith(`${c.srcDir}/`) && f.endsWith('.kt'));
  const text = (f: string) => readText(join(root, f)) ?? '';
  const apiFiles = kt.filter((f) => /^\s*interface\s+\w+/m.test(text(f)) && RETROFIT_FUN.test(text(f)) && ((RETROFIT_FUN.lastIndex = 0), true));
  c.apiFolder = mostCommon(apiFiles.map(dirOf), `${pkgDir}/data/remote`);
  const modelFiles = kt.filter((f) => /\bdata\s+class\b/.test(text(f)) && /@Serializable|@JsonClass|@SerializedName|@SerialName/.test(text(f)));
  c.modelsFolder = mostCommon(modelFiles.map(dirOf), `${pkgDir}/data/model`);
  for (const f of modelFiles) map.models.push(...parseDataClasses(text(f), f));
  const retrofitFile = kt.find((f) => /Retrofit\.Builder\(\)/.test(text(f)));
  c.diFile =
    (c.di === 'hilt' ? kt.find((f) => /@Module\b/.test(text(f)) && /Retrofit/.test(text(f))) : c.di === 'koin' ? kt.find((f) => /\bmodule\s*\{/.test(text(f)) && /Retrofit/.test(text(f))) : retrofitFile) ?? '';
  if (c.di === 'none' && retrofitFile && /\bobject\s+\w+/.test(text(retrofitFile))) c.di = 'manual';
  c.baseUrl = retrofitFile ? /\.baseUrl\(\s*"([^"]+)"\s*\)/.exec(text(retrofitFile))?.[1] ?? /BASE_URL\s*=\s*"([^"]+)"/.exec(text(retrofitFile))?.[1] ?? '' : '';
  if (!c.baseUrl) for (const f of kt) {
    const m = /\bBASE_URL\s*=\s*"(https?:[^"]+)"/.exec(text(f));
    if (m) {
      c.baseUrl = m[1];
      break;
    }
  }
  if (!c.baseUrl) c.baseUrl = /buildConfigField\(\s*"String"\s*,\s*"BASE_URL"\s*,\s*"\\"([^"\\]+)\\""\s*\)/.exec(build)?.[1] ?? '';
  const screens = kt.filter((f) => /@Composable\s+fun\s+\w+Screen\s*\(/.test(text(f)));
  c.screensFolder = mostCommon(screens.map(dirOf), `${pkgDir}/ui/screens`);
  c.navFile = kt.find((f) => /\bNavHost\s*\(/.test(text(f))) ?? '';
  c.indent = /\n {2}\S/.test(kt.slice(0, 10).map(text).join('\n')) && !/\n {4}\S/.test(kt.slice(0, 10).map(text).join('\n')) ? '2' : '4';

  map.conventions = { ...c, ...configConventions };
  const conv = map.conventions;
  if (conv.http !== 'retrofit') map.notes.push(conv.http === 'ktor' ? 'This project uses Ktor; api add writes Retrofit interfaces only so far.' : 'No HTTP client found; codz setup adds Retrofit.');
  if (!conv.namespace) map.notes.push('No namespace found in the app build file, so package names cannot be worked out.');

  for (const f of apiFiles) {
    const t = text(f);
    for (const m of t.matchAll(RETROFIT_FUN)) {
      const close = matchBrace(t, m.index! + m[0].length - 1, 'dart');
      const ret = close === -1 ? '' : /^\s*:\s*([\w<>?, .]+)/.exec(t.slice(close + 1))?.[1]?.trim() ?? 'Unit';
      map.endpoints.push({ name: m[3], method: m[1] as HttpMethod, path: `/${m[2].replace(/^\//, '')}`, response: ret, file: f, calledFrom: [] });
    }
  }
  for (const f of kt) {
    const t = text(f);
    for (const ep of map.endpoints) if (ep.file !== f && new RegExp(`\\.${ep.name}\\s*\\(`).test(t)) ep.calledFrom.push(f);
  }
  // Compose routes: composable("orders/{id}") { ... }
  for (const f of kt) for (const m of text(f).matchAll(/\bcomposable\(\s*(?:route\s*=\s*)?"([^"]+)"/g)) map.routes.push({ name: m[1].split('/')[0], path: `/${m[1]}`, params: [...m[1].matchAll(/\{(\w+)\}/g)].map((x) => x[1]), file: f });
  map.locales = scanLocales(root, files);
  return map;
}

const resourceOf = (path: string) => path.split('/').filter((s) => s && !s.startsWith('{') && !/^(api|v\d+)$/i.test(s))[0] ?? 'root';

/** Registers a new Retrofit interface where Retrofit is created. */
function register(files: Map<string, string>, read: (p: string) => string | null, c: Conventions, iface: string, ifacePkg: string, summary: string[], warnings: string[]): void {
  const di = c.diFile;
  const text = di ? read(di) : null;
  if (!di || text === null) {
    warnings.push(`No ${c.di === 'none' ? 'Retrofit setup' : `${c.di} module`} was found, so ${iface} is not registered. Create it with retrofit.create(${iface}::class.java), or run codz setup.`);
    return;
  }
  const fn = iface[0].toLowerCase() + iface.slice(1);
  let t = text;
  if (new RegExp(`\\b${iface}::class`).test(t)) return;
  const pkg = /^package\s+([\w.]+)/m.exec(t)?.[1] ?? '';
  if (c.di === 'hilt') {
    const obj = /\bobject\s+\w+\s*\{/.exec(t);
    if (!obj) return void warnings.push(`Could not find the Hilt module object in ${di}; add @Provides fun provide${iface}(retrofit: Retrofit): ${iface} = retrofit.create(${iface}::class.java).`);
    const close = matchBrace(t, obj.index + obj[0].length - 1, 'dart');
    t = `${t.slice(0, close).replace(/\s*$/, '\n')}\n    @Provides\n    @Singleton\n    fun provide${iface}(retrofit: Retrofit): ${iface} = retrofit.create(${iface}::class.java)\n${t.slice(close)}`;
    t = addKotlinImports(t, [`${ifacePkg}.${iface}`, 'dagger.Provides', 'javax.inject.Singleton', 'retrofit2.Retrofit'], pkg);
  } else if (c.di === 'koin') {
    const singles = [...t.matchAll(/^([ \t]*)single(?:<[^>]*>)?\s*\{[^\n]*\}\s*$/gm)];
    if (!singles.length) return void warnings.push(`Could not find a single { } in ${di}; add single { get<Retrofit>().create(${iface}::class.java) }.`);
    const last = singles[singles.length - 1];
    const at = last.index! + last[0].length;
    t = `${t.slice(0, at)}\n${last[1]}single { get<Retrofit>().create(${iface}::class.java) }${t.slice(at)}`;
    t = addKotlinImports(t, [`${ifacePkg}.${iface}`, 'retrofit2.Retrofit'], pkg);
  } else {
    const obj = /\bobject\s+\w+\s*\{/.exec(t);
    const retrofitVal = /\bval\s+(\w+)\s*:\s*Retrofit\b/.exec(t)?.[1] ?? /\bval\s+(\w+)\s*=\s*Retrofit\.Builder/.exec(t)?.[1] ?? 'retrofit';
    if (!obj) return void warnings.push(`Could not find the service locator object in ${di}; add val ${fn}: ${iface} = retrofit.create(${iface}::class.java).`);
    const close = matchBrace(t, obj.index + obj[0].length - 1, 'dart');
    t = `${t.slice(0, close).replace(/\s*$/, '\n')}\n    val ${fn}: ${iface} by lazy { ${retrofitVal}.create(${iface}::class.java) }\n${t.slice(close)}`;
    t = addKotlinImports(t, [`${ifacePkg}.${iface}`], pkg);
  }
  files.set(di, withEol(t, detectEol(text)));
  summary.push(`Update ${di}: register ${iface} with ${c.di === 'manual' ? 'the service locator' : c.di}`);
}

async function planEndpoint(ctx: AdapterContext, input: EndpointSpec, overlay?: Map<string, string>, opts: { replaceModels?: boolean; targetFile?: string } = {}): Promise<PlannedEdits> {
  const { root, map } = ctx;
  const c = map.conventions;
  if (c.http !== 'retrofit') throw new ToolError('unsupported_setup', c.http === 'ktor' ? 'This project uses Ktor; the Android adapter writes Retrofit interfaces only so far.' : 'This project has no Retrofit yet.', 'Run codz setup to add Retrofit, or add it yourself.');
  if (!c.namespace) throw new ToolError('no_package', 'No namespace was found in the app build file, so package names cannot be written.', 'Set namespace in codz.config.yaml.');
  if (input.unwrapData) throw new ToolError('unsupported_setup', 'This response wraps its data in {"data": ...}, and a Retrofit method returns the whole body.', 'Run again with --no-unwrap to generate a model for the whole body.');
  const files = new Map<string, string>(overlay ?? []);
  const read = (p: string) => files.get(p) ?? readText(join(root, p));
  const summary: string[] = [];
  const warnings = [...input.warnings];
  const { spec, reused, replaced, notes } = resolveModels(input, map.models, (n) => n, { replace: opts.replaceModels });
  warnings.push(...notes);
  const srcDir = c.srcDir || 'app/src/main/java';

  // Path relative to the base URL.
  let path = spec.path;
  // Retrofit always has a base URL; an endpoint from an API spec is relative to it (the spec's server stands in for it).
  const fromSpec = specRelativePath(spec, c.baseUrl);
  if (fromSpec !== null) {
    path = fromSpec;
    if (c.baseUrl && !c.baseUrl.endsWith('/')) warnings.push(`Retrofit needs the base URL to end with "/" (${c.baseUrl}).`);
  } else if (c.baseUrl) {
    try {
      const b = new URL(c.baseUrl);
      const prefix = b.pathname.replace(/\/$/, '');
      if ((!spec.origin || spec.origin === b.origin) && prefix && path.startsWith(prefix)) path = path.slice(prefix.length) || '/';
      else if (spec.origin && spec.origin !== b.origin) {
        path = `${spec.origin}${spec.path}`;
        warnings.push(`The URL host ${spec.origin} differs from the Retrofit base URL (${c.baseUrl}), so the full URL is used for this call.`);
      }
    } catch {
      // Not a literal URL.
    }
    if (!c.baseUrl.endsWith('/')) warnings.push(`Retrofit needs the base URL to end with "/" (${c.baseUrl}).`);
  }

  const existing = map.endpoints.find((e) => e.name === spec.name);
  if (existing) {
    if (existing.method === spec.method && existing.path.replace(/\{\w+\}/g, '{}') === path.replace(/\{\w+\}/g, '{}')) return { files, summary: [`${spec.name} already exists in ${existing.file}; nothing to do.`], warnings: [], generated: [] };
    throw new ToolError('name_conflict', `A function called ${spec.name} already exists in ${existing.file} for ${existing.method} ${existing.path}.`, 'Pass --name <functionName> to use another name.');
  }

  // Models: one data class per file.
  const modelFile = new Map<string, string>();
  for (const [name, info] of reused) modelFile.set(name, info.file);
  const modelsPkg = packageOf(srcDir, c.modelsFolder || `${srcDir}/${c.namespace.replace(/\./g, '/')}/data/model`);
  for (const m of spec.models) {
    const file = replaced.get(m.name)?.file ?? `${c.modelsFolder}/${m.name}.kt`;
    modelFile.set(m.name, file);
    const prev = read(file);
    if (prev !== null && !replaced.has(m.name)) throw new ToolError('file_exists', `${file} already exists but does not define ${m.name}.`, 'Pass --model-name <Name> to use another name.');
    let content = renderDataClass(m, c, packageOf(srcDir, dirOf(file)));
    const deps = new Set<string>();
    for (const f of m.fields) referencedModels(f.type, deps);
    content = addKotlinImports(content, [...deps].map((d) => modelFile.get(d)).filter((f): f is string => !!f && dirOf(f) !== dirOf(file)).map((f) => `${packageOf(srcDir, dirOf(f))}.${f.slice(f.lastIndexOf('/') + 1, -3)}`), packageOf(srcDir, dirOf(file)));
    if (prev !== null && replaced.has(m.name)) {
      // Rewrite just this class, keeping the rest of the file.
      const start = prev.search(new RegExp(`(?:@\\w+(?:\\([^)]*\\))?\\s*\\n)*data\\s+class\\s+${m.name}\\b`));
      const open = prev.indexOf('(', start);
      const close = matchBrace(prev, open, 'dart');
      let end = close + 1;
      if (prev[end] === ' ' && prev[end + 1] === '{') end = matchBrace(prev, end + 1, 'dart') + 1;
      const cls = content.slice(content.search(/^(@Serializable|@JsonClass|data class)/m)).replace(/\n$/, '');
      content = addKotlinImports(prev.slice(0, start) + cls + prev.slice(end), [...content.matchAll(/^import\s+([\w.]+)/gm)].map((x) => x[1]), packageOf(srcDir, dirOf(file)));
    }
    files.set(file, content);
    summary.push(`${prev === null ? 'Create' : 'Update'} ${file}: data class ${m.name}${replaced.has(m.name) ? ' (rewritten)' : ''}`);
  }
  void modelsPkg;

  // Retrofit interface.
  const resource = resourceOf(spec.path);
  const iface = `${pascal(singular(resource))}Api`;
  const fromEndpoints = map.endpoints.find((e) => resourceOf(e.path) === resource)?.file;
  let apiFile = opts.targetFile ?? fromEndpoints ?? `${c.apiFolder}/${iface}.kt`;
  const apiPkg = packageOf(srcDir, dirOf(apiFile));
  let apiText = read(apiFile);
  const created = apiText === null;
  if (created) apiText = `package ${apiPkg}\n\ninterface ${iface} {\n}\n`;
  const ifaceName = /\binterface\s+(\w+)/.exec(apiText!)?.[1] ?? iface;
  const fun = renderRetrofitFun(spec, c, path);
  const head = /\binterface\s+\w+[^{]*\{/.exec(apiText!)!;
  const close = matchBrace(apiText!, head.index + head[0].length - 1, 'dart');
  const before = apiText!.slice(0, close).replace(/\s*$/, '');
  apiText = `${before}${before.endsWith('{') ? '\n' : '\n\n'}${fun.code}\n${apiText!.slice(close)}`;
  const typeRefs = new Set<string>();
  referencedModels(spec.response, typeRefs);
  referencedModels(spec.request, typeRefs);
  const modelImports = [...typeRefs].map((t) => modelFile.get(t) ?? map.models.find((m) => m.name === t)?.file).filter((f): f is string => !!f).map((f) => `${packageOf(srcDir, dirOf(f))}.${f.slice(f.lastIndexOf('/') + 1, -3)}`);
  apiText = addKotlinImports(apiText, [...fun.imports, ...modelImports], apiPkg);
  files.set(apiFile, apiText);
  summary.push(`${created ? 'Create' : 'Update'} ${apiFile}: ${ifaceName}.${spec.name}() for ${spec.method} ${spec.path}`);
  if (created) register(files, read, c, ifaceName, apiPkg, summary, warnings);
  void apiFile;

  return {
    files,
    summary,
    warnings,
    generated: [{ skill: 'api add', file: apiFile, symbol: spec.name, inputHash: '' }],
    endpoints: [{ name: spec.name, method: spec.method, path: `/${path.replace(/^\//, '')}`, response: spec.method === 'DELETE' || spec.method === 'HEAD' ? 'Unit' : spec.response ? kotlinType(spec.response, c) : 'Any', file: apiFile, calledFrom: [] }],
    models: spec.models.map((m) => ({ name: m.name, file: modelFile.get(m.name)!, fields: m.fields.map((f) => ({ name: f.jsonName, type: kotlinType(f.type, c), nullable: f.nullable })) })),
  };
}

export const androidAdapter: Adapter = {
  id: 'android',
  version: ANDROID_VERSION,
  capabilities: { explain: true, apiAdd: true },
  supportedSetup: 'Android (Kotlin): Retrofit with suspend functions; kotlinx.serialization, Moshi or Gson data classes; Hilt, Koin or a service locator; screens in Jetpack Compose (Navigation Compose) or XML Views (Activities). Not yet: Ktor, Java sources, Fragments.',
  scan,
  planEndpoint,
  architectures: androidArchitectures,
  planSetup: planAndroidSetup,
  afterSetup: () => null,
  formatCommand: () => null,
  verifyCommand: () => null,
};

