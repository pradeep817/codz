// GetX features in the GetX CLI layout:
//
//   lib/app/modules/<name>/bindings/<name>_binding.dart
//   lib/app/modules/<name>/controllers/<name>_controller.dart
//   lib/app/modules/<name>/views/<name>_view.dart
//   lib/app/routes/app_pages.dart   (GetPage list)
//   lib/app/routes/app_routes.dart  (Routes and _Paths constants)
//
// `module add` creates a module and registers its route. `api wire` adds an
// endpoint call to a module's controller with loading, data and error state.

import { join } from 'node:path';
import { detectEol, readText, withEol } from '../core/fsutil.ts';
import { ToolError, type AdapterContext, type Conventions, type PlannedEdits } from '../core/types.ts';
import { camel, DART_RESERVED, kebab, pascal, snake } from '../input/naming.ts';
import { addDartImport, addToClass, importUri, insertGetxRegistration } from './flutter.ts';
import { matchBrace } from './source.ts';

export interface ModuleOptions {
  name: string;
  /** Make this module the first screen (AppPages.initial). The first module is always initial. */
  initial?: boolean;
}

export interface WireOptions {
  endpoint: string;
  module: string;
  /** Skip the automatic call in onInit. */
  noLoad?: boolean;
}

/** Files read from the plan so far first, then from disk, so steps can be chained in one change. */
type Reader = (path: string) => string | null;

export function getxPaths(c: Conventions, moduleName: string) {
  const s = snake(moduleName);
  const folder = `${c.modulesFolder || 'lib/app/modules'}/${s}`;
  const pages = c.routesFile || 'lib/app/routes/app_pages.dart';
  return {
    snake: s,
    pascal: pascal(moduleName),
    binding: `${folder}/bindings/${s}_binding.dart`,
    controller: `${folder}/controllers/${s}_controller.dart`,
    view: `${folder}/views/${s}_view.dart`,
    pages,
    routes: pages.replace(/[^/]+$/, 'app_routes.dart'),
  };
}

export function requireGetx(c: Conventions): void {
  if (c.di !== 'getx' && c.stateManagement !== 'getx') {
    throw new ToolError('not_supported', 'Modules are generated for GetX projects so far; this project does not use GetX.', 'For a fresh project, run: devtool setup --architecture getx');
  }
  if (!c.packageName) throw new ToolError('no_package', 'pubspec.yaml has no name, so imports cannot be written.');
}

function checkModuleName(name: string): void {
  const s = snake(name);
  if (!s || /^[0-9]/.test(s) || DART_RESERVED.has(s) || DART_RESERVED.has(camel(name))) {
    throw new ToolError('bad_name', `"${name}" cannot be used as a module name.`, 'Use letters, for example: profile, order_details, settings');
  }
}

/** Route constants follow the file: UPPER_CASE when it already uses that (GetX CLI default), else lowerCamel (lint-clean). */
function routeConst(name: string, upper: boolean): string {
  return upper ? snake(name).toUpperCase() : camel(name);
}

/** Inserts a line before the closing brace of a class, keeping one statement per line. */
function insertInClass(text: string, className: string, line: string): string {
  const m = new RegExp(`\\bclass\\s+${className}\\b[^{]*\\{`).exec(text);
  if (!m) throw new ToolError('class_not_found', `Could not find class ${className}.`);
  const close = matchBrace(text, m.index + m[0].length - 1, 'dart');
  const before = text.slice(0, close).replace(/\s*$/, '');
  return `${before}\n  ${line}\n${text.slice(close)}`;
}

function bindingFile(p: ReturnType<typeof getxPaths>, c: Conventions): string {
  let t = [
    `class ${p.pascal}Binding extends Bindings {`,
    '  @override',
    '  void dependencies() {',
    `    Get.lazyPut<${p.pascal}Controller>(() => ${p.pascal}Controller());`,
    '  }',
    '}',
  ].join('\n') + '\n';
  t = addDartImport(t, 'package:get/get.dart');
  return addDartImport(t, importUri(p.binding, p.controller, c));
}

function controllerFile(p: ReturnType<typeof getxPaths>): string {
  return addDartImport(`class ${p.pascal}Controller extends GetxController {}\n`, 'package:get/get.dart');
}

function viewFile(p: ReturnType<typeof getxPaths>, c: Conventions): string {
  const title = p.snake.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  let t = [
    `class ${p.pascal}View extends GetView<${p.pascal}Controller> {`,
    `  const ${p.pascal}View({super.key});`,
    '',
    '  @override',
    '  Widget build(BuildContext context) {',
    '    return Scaffold(',
    `      appBar: AppBar(title: const Text('${title.replace(/'/g, "\\'")}')),`,
    `      body: const Center(child: Text('${p.pascal}View is working')),`,
    '    );',
    '  }',
    '}',
  ].join('\n') + '\n';
  t = addDartImport(t, 'package:flutter/material.dart');
  t = addDartImport(t, 'package:get/get.dart');
  return addDartImport(t, importUri(p.view, p.controller, c));
}

function getPageEntry(p: ReturnType<typeof getxPaths>, constName: string, indent: string): string {
  return [`${indent}GetPage(`, `${indent}  name: _Paths.${constName},`, `${indent}  page: () => const ${p.pascal}View(),`, `${indent}  binding: ${p.pascal}Binding(),`, `${indent}),`].join('\n');
}

export function planGetxModule(ctx: AdapterContext, opts: ModuleOptions, overlay = new Map<string, string>()): PlannedEdits {
  const { root, map } = ctx;
  const c = map.conventions;
  requireGetx(c);
  checkModuleName(opts.name);
  const files = new Map<string, string>(overlay);
  const read: Reader = (path) => files.get(path) ?? readText(join(root, path));
  const summary: string[] = [];
  const warnings: string[] = [];
  const p = getxPaths(c, opts.name);

  for (const f of [p.binding, p.controller, p.view]) {
    if (read(f) !== null) {
      throw new ToolError('module_exists', `The ${p.snake} module already exists (${f}).`, 'Pick another name, or wire an API into it with: devtool api wire <endpoint> --into ' + p.snake);
    }
  }
  files.set(p.binding, bindingFile(p, c));
  files.set(p.controller, controllerFile(p));
  files.set(p.view, viewFile(p, c));
  summary.push(`Create ${p.binding}: ${p.pascal}Binding`, `Create ${p.controller}: ${p.pascal}Controller`, `Create ${p.view}: ${p.pascal}View`);

  // Routes.
  const pagesText = read(p.pages);
  const routesText = read(p.routes);
  const routePath = `/${kebab(opts.name)}`;
  if (pagesText === null || routesText === null) {
    if ((pagesText === null) !== (routesText === null)) {
      throw new ToolError('routes_incomplete', `Found only one of ${p.pages} and ${p.routes}.`, 'devtool needs both (the GetX CLI layout), or neither so it can create them.');
    }
    const k = routeConst(opts.name, false);
    let pages = [
      "part 'app_routes.dart';",
      '',
      'class AppPages {',
      '  AppPages._();',
      '',
      `  static const initial = Routes.${k};`,
      '',
      '  static final routes = [',
      getPageEntry(p, k, '    '),
      '  ];',
      '}',
    ].join('\n') + '\n';
    pages = addDartImport(pages, importUri(p.pages, p.view, c));
    pages = addDartImport(pages, importUri(p.pages, p.binding, c));
    pages = addDartImport(pages, 'package:get/get.dart');
    files.set(p.pages, pages);
    files.set(
      p.routes,
      [
        "part of 'app_pages.dart';",
        '',
        'abstract class Routes {',
        '  Routes._();',
        `  static const ${k} = _Paths.${k};`,
        '}',
        '',
        'abstract class _Paths {',
        '  _Paths._();',
        `  static const ${k} = '${routePath}';`,
        '}',
        '',
      ].join('\n'),
    );
    summary.push(`Create ${p.pages}: AppPages with the ${routePath} page, the first screen`, `Create ${p.routes}: Routes.${k} and its path`);

    // Point the app at the routes.
    const main = read('lib/main.dart');
    if (main === null) warnings.push('lib/main.dart was not found; use GetMaterialApp(initialRoute: AppPages.initial, getPages: AppPages.routes).');
    else {
      const wired = wireRoutesInMain(main, c, warnings);
      if (wired !== null) {
        files.set('lib/main.dart', withEol(wired, detectEol(main)));
        summary.push('Update lib/main.dart: GetMaterialApp uses initialRoute and getPages');
      }
    }
  } else {
    const upper = /static\s+const\s+[A-Z][A-Z0-9_]*\s*=/.test(routesText);
    const k = routeConst(opts.name, upper);
    if (new RegExp(`static\\s+const\\s+${k}\\s*=`).test(routesText)) {
      throw new ToolError('route_exists', `The route constant ${k} already exists in ${p.routes}.`, 'Pick another module name.');
    }
    let routes = routesText.replace(/\r\n/g, '\n');
    routes = insertInClass(routes, 'Routes', `static const ${k} = _Paths.${k};`);
    routes = insertInClass(routes, '_Paths', `static const ${k} = '${routePath}';`);
    files.set(p.routes, withEol(routes, detectEol(routesText)));

    let pages = pagesText.replace(/\r\n/g, '\n');
    const listStart = /\broutes\s*=\s*(?:<GetPage[^>]*>\s*)?\[/.exec(pages);
    if (!listStart) throw new ToolError('routes_unreadable', `Could not find the routes list in ${p.pages}.`, 'devtool expects: static final routes = [ GetPage(...), ... ];');
    const open = listStart.index + listStart[0].length - 1;
    const close = matchBrace(pages, open, 'dart');
    const lineStart = pages.lastIndexOf('\n', listStart.index) + 1;
    const indent = pages.slice(lineStart).match(/^[ \t]*/)![0];
    let body = pages.slice(open + 1, close).replace(/\s*$/, '');
    if (body.trim() && !body.trim().endsWith(',')) body += ',';
    pages = `${pages.slice(0, open + 1)}${body}\n${getPageEntry(p, k, indent + '  ')}\n${indent}${pages.slice(close)}`;
    if (opts.initial) {
      const ini = /(static\s+const\s+(?:INITIAL|initial)\s*=\s*)Routes\.\w+/.exec(pages);
      if (ini) pages = pages.replace(ini[0], `${ini[1]}Routes.${k}`);
      else warnings.push(`No initial route constant was found in ${p.pages}; set the first screen yourself.`);
    }
    pages = addDartImport(pages, importUri(p.pages, p.binding, c));
    pages = addDartImport(pages, importUri(p.pages, p.view, c));
    files.set(p.pages, withEol(pages, detectEol(pagesText)));
    summary.push(`Update ${p.routes}: Routes.${k} = '${routePath}'`, `Update ${p.pages}: GetPage for ${p.pascal}View${opts.initial ? ', now the first screen' : ''}`);
  }

  // Only report files that changed relative to the overlay passed in.
  return { files, summary, warnings, generated: [{ skill: 'module add', file: p.controller, symbol: `${p.pascal}Controller`, inputHash: '' }] };
}

function wireRoutesInMain(main: string, c: Conventions, warnings: string[]): string | null {
  let t = main.replace(/\r\n/g, '\n');
  if (/\bgetPages\s*:/.test(t)) return null;
  const m = /\bGetMaterialApp\s*\(/.exec(t);
  if (!m) {
    warnings.push('lib/main.dart has no GetMaterialApp; use GetMaterialApp(initialRoute: AppPages.initial, getPages: AppPages.routes).');
    return null;
  }
  const open = m.index + m[0].length - 1;
  const close = matchBrace(t, open, 'dart');
  const lineStart = t.lastIndexOf('\n', m.index) + 1;
  const indent = t.slice(lineStart).match(/^[ \t]*/)![0];
  let args = t.slice(open + 1, close);
  // `home:` would win over the routes; remove it when it is a simple one-line argument.
  const home = /\n([ \t]*)home:\s*([^\n]*),[ \t]*(?=\n)/.exec(args);
  if (home) {
    const value = home[2];
    const balanced = (value.match(/\(/g) ?? []).length === (value.match(/\)/g) ?? []).length;
    if (balanced) {
      args = args.replace(home[0], '');
      warnings.push(`Removed "home: ${value}" from GetMaterialApp: the app now starts at AppPages.initial. The old home widget is still in main.dart if you want to reuse it.${/\bMyHomePage\b/.test(value) ? ' The counter test from flutter create (test/widget_test.dart) checks that page and will fail now; update it or delete it.' : ''}`);
    } else {
      warnings.push('GetMaterialApp has a multi-line home: argument; remove it so the app starts at AppPages.initial.');
    }
  }
  const insert = `\n${indent}  initialRoute: AppPages.initial,\n${indent}  getPages: AppPages.routes,`;
  // After initialBinding when present, else first.
  const ib = /\n[ \t]*initialBinding:[^\n]*,/.exec(args);
  args = ib ? args.slice(0, ib.index + ib[0].length) + insert + args.slice(ib.index + ib[0].length) : insert + args;
  t = t.slice(0, open + 1) + args + t.slice(close);
  return addDartImport(t, importUri('lib/main.dart', c.routesFile || 'lib/app/routes/app_pages.dart', c));
}

// ---------------- api wire ----------------

/** Splits a parameter list at top-level commas. */
export function splitParams(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if ('<({['.includes(ch)) depth++;
    if ('>)}]'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

interface MethodSig {
  repoClass: string;
  returnType: string;
  /** The parameter list exactly as declared, for the controller method. */
  params: string;
  /** Arguments that forward every parameter to the repository call. */
  args: string;
  hasRequired: boolean;
  types: string[];
}

export function readMethod(text: string, method: string): MethodSig | null {
  const re = new RegExp(`Future<([^\\n]*)>\\s+${method}\\s*\\(`);
  const m = re.exec(text);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = matchBrace(text, open, 'dart');
  const params = text.slice(open + 1, close).trim().replace(/,\s*$/, '');
  // Which class holds it?
  let repoClass = '';
  for (const cm of text.matchAll(/\bclass\s+(\w+)[^{]*\{/g)) {
    const o = cm.index! + cm[0].length - 1;
    const cl = matchBrace(text, o, 'dart');
    if (o < m.index && m.index < cl) repoClass = cm[1];
  }
  const positional: string[] = [];
  const named: string[] = [];
  let hasRequired = false;
  const nameOf = (p: string) => p.replace(/=.*$/, '').trim().split(/\s+/).pop()!.replace(/^this\./, '');
  const types: string[] = [m[1]];
  for (const part of splitParams(params)) {
    if (part.startsWith('{') || part.startsWith('[')) {
      const optional = part.startsWith('[');
      for (const np of splitParams(part.slice(1, -1))) {
        if (optional) positional.push(nameOf(np));
        else {
          named.push(nameOf(np));
          if (/^required\s/.test(np)) hasRequired = true;
        }
        types.push(np);
      }
    } else {
      positional.push(nameOf(part));
      hasRequired = true;
      types.push(part);
    }
  }
  const args = [...positional, ...named.map((n) => `${n}: ${n}`)].join(', ');
  return { repoClass, returnType: m[1].trim(), params, args, hasRequired, types };
}

export function planGetxWire(ctx: AdapterContext, opts: WireOptions, overlay = new Map<string, string>()): PlannedEdits {
  const { root, map } = ctx;
  const c = map.conventions;
  requireGetx(c);
  const files = new Map<string, string>(overlay);
  const read: Reader = (path) => files.get(path) ?? readText(join(root, path));
  const summary: string[] = [];
  const warnings: string[] = [];

  const ep = map.endpoints.find((e) => e.name === opts.endpoint) ?? map.endpoints.find((e) => e.name.toLowerCase() === opts.endpoint.toLowerCase());
  if (!ep) {
    const names = map.endpoints.map((e) => e.name);
    throw new ToolError('no_endpoint', `No endpoint called ${opts.endpoint} was found.`, names.length ? `Endpoints in this project: ${names.join(', ')}` : 'Add one first with: devtool api add');
  }
  const repoText = read(ep.file);
  const sig = repoText && readMethod(repoText, ep.name);
  if (!sig || !sig.repoClass) throw new ToolError('no_endpoint', `Could not read ${ep.name} in ${ep.file}.`);

  const p = getxPaths(c, opts.module);
  const ctrlText = read(p.controller);
  if (ctrlText === null) {
    throw new ToolError('no_module', `The ${p.snake} module was not found (${p.controller}).`, `Create it with: devtool module add ${p.snake}`);
  }
  const ctrlClass = `${p.pascal}Controller`;
  if (!new RegExp(`\\bclass\\s+${ctrlClass}\\b`).test(ctrlText)) throw new ToolError('class_not_found', `${p.controller} does not define ${ctrlClass}.`);

  // Names: getUser → loadUser / user; createOrder → createOrder / createOrderResult.
  const isRead = ep.method === 'GET';
  const stripped = ep.name.replace(/^(get|fetch|load)(?=[A-Z])/, '');
  const baseName = isRead && stripped !== ep.name ? camel(stripped) : ep.name;
  const action = isRead ? `load${pascal(baseName)}` : ep.name;
  const rt = sig.returnType;
  const isVoid = rt === 'void';
  const list = /^List<(.+)>$/.exec(rt);
  const dataField = isVoid ? '' : isRead ? baseName : `${baseName}Result`;
  const loading = `is${pascal(baseName)}Loading`;
  const errorField = `${baseName}Error`;
  const marker = `// ${ep.method} ${ep.path} via ${sig.repoClass}.${ep.name}`;

  if (ctrlText.includes(marker)) {
    return { files: new Map(overlay), summary: [`${ep.name} is already wired into ${ctrlClass}; nothing to do.`], warnings: [], generated: [] };
  }
  for (const name of [action, dataField, loading, errorField].filter(Boolean)) {
    if (new RegExp(`\\b${name}\\b`).test(ctrlText.replace(/\/\/.*$/gm, ''))) {
      throw new ToolError('name_conflict', `${ctrlClass} already has a member called ${name}.`, 'Rename it, or wire the endpoint into another module.');
    }
  }

  // Repository field, reused when the controller already has one.
  let text = ctrlText.replace(/\r\n/g, '\n');
  const existingField = new RegExp(`\\b${sig.repoClass}\\s+(\\w+)\\s*=`).exec(text);
  const repoField = existingField ? existingField[1] : `_${camel(sig.repoClass)}`;

  const L: string[] = [`  ${marker}`];
  if (!isVoid) L.push(list ? `  final ${dataField} = <${list[1]}>[].obs;` : `  final ${dataField} = Rxn<${rt}>();`);
  L.push(`  final ${loading} = false.obs;`, `  final ${errorField} = RxnString();`, '');
  L.push(`  Future<void> ${action}(${sig.params}) async {`, `    ${loading}.value = true;`, `    ${errorField}.value = null;`, '    try {');
  const call = `await ${repoField}.${ep.name}(${sig.args})`;
  if (isVoid) L.push(`      ${call};`);
  else if (list) L.push(`      ${dataField}.assignAll(${call});`);
  else L.push(`      ${dataField}.value = ${call};`);
  L.push('    } catch (e) {', `      ${errorField}.value = e.toString();`, '    } finally {', `      ${loading}.value = false;`, '    }', '  }');
  text = addToClass(text, ctrlClass, L.join('\n'));

  if (!existingField) {
    const head = new RegExp(`(\\bclass\\s+${ctrlClass}\\b[^{]*\\{)\\n*`).exec(text)!;
    text = `${text.slice(0, head.index)}${head[1]}\n  final ${sig.repoClass} ${repoField} = Get.find<${sig.repoClass}>();\n\n${text.slice(head.index + head[0].length)}`;
  }
  text = text.replace(new RegExp(`(\\bclass\\s+${ctrlClass}\\b[^{]*\\{)\\n\\n`), '$1\n');

  // Load on start when the call needs no arguments.
  const autoLoad = isRead && !sig.hasRequired && !opts.noLoad;
  if (autoLoad) {
    const onInit = /void\s+onInit\s*\(\s*\)\s*\{/.exec(text);
    if (onInit) {
      const close = matchBrace(text, onInit.index + onInit[0].length - 1, 'dart');
      const before = text.slice(0, close).replace(/\s*$/, '');
      text = `${before}\n    ${action}();\n  ${text.slice(close)}`;
    } else {
      text = addToClass(text, ctrlClass, ['  @override', '  void onInit() {', '    super.onInit();', `    ${action}();`, '  }'].join('\n'));
    }
  }

  // Imports: Get, the repository, and models in the signature.
  text = addDartImport(text, 'package:get/get.dart');
  text = addDartImport(text, importUri(p.controller, ep.file, c));
  const typeNames = new Set(sig.types.join(' ').match(/\b[A-Z]\w*/g) ?? []);
  // Models already in the project, or created earlier in this same change.
  const modelFileOf = (t: string) =>
    map.models.find((m) => m.name === t)?.file ??
    [...files.entries()].find(([f, txt]) => f.startsWith((c.modelsFolder || 'lib') + '/') && f.endsWith('.dart') && new RegExp(`\\bclass\\s+${t}\\b`).test(txt))?.[0];
  for (const t of [...typeNames].sort()) {
    const mf = modelFileOf(t);
    if (mf) text = addDartImport(text, importUri(p.controller, mf, c));
  }
  files.set(p.controller, withEol(text, detectEol(ctrlText)));
  summary.push(`Update ${p.controller}: ${action}()${dataField ? `, ${dataField}` : ''}, ${loading} and ${errorField}${autoLoad ? '; loads in onInit' : ''}`);

  // Make sure the repository can be found.
  const diText = c.diFile ? read(c.diFile) : null;
  const registered = new RegExp(`Get\\.(?:lazyPut|put|putAsync|create)\\s*<\\s*${sig.repoClass}\\s*>`);
  const bindingText = read(p.binding);
  if (!(diText && registered.test(diText)) && !(bindingText && registered.test(bindingText))) {
    if (bindingText && repoText && new RegExp(`${sig.repoClass}\\s*\\(\\s*this\\.\\w+\\s*\\)`).test(repoText) && /\bDio\b/.test(repoText)) {
      let b = insertGetxRegistration(bindingText.replace(/\r\n/g, '\n'), `Get.lazyPut<${sig.repoClass}>(() => ${sig.repoClass}(Get.find<Dio>()));`);
      if (b) {
        b = addDartImport(b, 'package:dio/dio.dart');
        b = addDartImport(b, importUri(p.binding, ep.file, c));
        files.set(p.binding, withEol(b, detectEol(bindingText)));
        summary.push(`Update ${p.binding}: register ${sig.repoClass} for this module`);
      }
    } else {
      warnings.push(`${sig.repoClass} is not registered with GetX; register it (Get.lazyPut) so Get.find<${sig.repoClass}>() works.`);
    }
  }

  const show = isVoid ? '' : list ? `controller.${dataField}.length` : `controller.${dataField}.value`;
  summary.push(
    `In ${p.pascal}View: Obx(() => controller.${loading}.value ? const CircularProgressIndicator() : Text(controller.${errorField}.value ?? ${show ? `'\${${show}}'` : "'Done'"}))`,
  );
  if (!autoLoad && isRead) summary.push(`Call controller.${action}(${sig.args.replace(/(\w+): \w+/g, '$1: ...')}) when the screen needs the data.`);

  // Return only files that differ from the overlay given.
  return { files, summary, warnings, generated: [{ skill: 'api wire', file: p.controller, symbol: action, inputHash: '' }] };
}
