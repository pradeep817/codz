// route add <name> [--path /x/:id]: a new screen and its route.
//
// GetX → a module (binding, controller, view, GetPage). go_router → a page
// widget plus a GoRoute in the router's routes list. Navigator → a page plus an
// entry in MaterialApp routes: {}. Next.js → app/<path>/page.tsx (or pages/).

import { join, posix } from 'node:path';
import { addDartImport, importUri } from '../adapters/flutter.ts';
import { matchBrace } from '../adapters/source.ts';
import { loadMap } from '../core/cache.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { loadConfig } from '../core/config.ts';
import { detectEol, exists, readJson, readText, walk, withEol } from '../core/fsutil.ts';
import { ToolError, type Adapter, type ChangeSet, type ProjectMap } from '../core/types.ts';
import { camel, kebab, pascal, snake, words } from '../input/naming.ts';
import { planModuleAdd } from './module.ts';

export interface RouteAddOptions {
  name: string;
  path?: string;
  initial?: boolean;
}

function normPath(name: string, path?: string): { path: string; params: string[] } {
  let p = path ?? `/${kebab(name)}`;
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\[(\w+)\]/g, ':$1').replace(/\{([^/{}]+)\}/g, ':$1');
  return { path: p, params: [...p.matchAll(/:(\w+)/g)].map((m) => m[1]) };
}

// ---------------- Flutter ----------------

function pageSuffix(map: ProjectMap): 'Page' | 'Screen' {
  const screens = map.routes.filter((r) => /Screen$/.test(r.name)).length;
  const pages = map.routes.filter((r) => /Page$/.test(r.name)).length;
  return screens > pages ? 'Screen' : 'Page';
}

/** Where pages live: next to an existing page as features/<name>/ or screens/. */
function pageFile(root: string, map: ProjectMap, cls: string, base: string): string {
  const dart = walk(root, 'lib', { exts: ['.dart'] });
  for (const r of map.routes) {
    const f = dart.find((x) => new RegExp(`class\\s+${r.name}\\s+extends`).test(readText(join(root, x)) ?? ''));
    if (!f) continue;
    const dir = posix.dirname(f);
    const parent = posix.dirname(dir);
    // features/home/home_page.dart → features/<name>/<name>_page.dart
    if (/\/(features|modules|pages|screens|views)$/.test(parent) || parent.endsWith('/features')) return `${parent}/${base}/${snake(cls)}.dart`;
    return `${dir}/${snake(cls)}.dart`;
  }
  return exists(join(root, 'lib/features')) ? `lib/features/${base}/${snake(cls)}.dart` : `lib/screens/${snake(cls)}.dart`;
}

function pageWidget(cls: string, title: string, params: string[]): string {
  const fields = params.map((p) => `  final String ${camel(p)};\n`).join('');
  const ctor = params.length ? `const ${cls}({super.key, ${params.map((p) => `required this.${camel(p)}`).join(', ')}});` : `const ${cls}({super.key});`;
  return [
    "import 'package:flutter/material.dart';",
    '',
    `class ${cls} extends StatelessWidget {`,
    `  ${ctor}`,
    fields ? `\n${fields.trimEnd()}` : '',
    '',
    '  @override',
    '  Widget build(BuildContext context) {',
    '    return Scaffold(',
    `      appBar: AppBar(title: const Text('${title}')),`,
    `      body: ${params.length ? `Center(child: Text('${title} \$${camel(params[0])}'))` : `const Center(child: Text('${title}'))`},`,
    '    );',
    '  }',
    '}',
    '',
  ]
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
    .join('\n');
}

function planFlutterRoute(root: string, map: ProjectMap, opts: RouteAddOptions, files: Map<string, string>, summary: string[], warnings: string[]): void {
  const c = map.conventions;
  const { path, params } = normPath(opts.name, opts.path);
  const cls = pascal(`${opts.name} ${pageSuffix(map)}`).replace(/(Page|Screen)(Page|Screen)$/, '$1');
  if (map.routes.some((r) => r.path.replace(/\{([^/{}]+)\}/g, ':$1') === path)) throw new ToolError('route_exists', `There is already a route for ${path}.`);
  const file = pageFile(root, map, cls, snake(opts.name.replace(/(page|screen)$/i, '')) || snake(opts.name));
  if (exists(join(root, file))) throw new ToolError('file_exists', `${file} already exists.`);
  const title = words(opts.name.replace(/(page|screen)$/i, '')).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  files.set(file, pageWidget(cls, title, params));
  summary.push(`Create ${file}: ${cls}`);
  const args = params.map((p) => `${camel(p)}: state.pathParameters['${p}']!`).join(', ');

  if (c.router === 'go_router') {
    const dart = walk(root, 'lib', { exts: ['.dart'] });
    const rf = dart.find((f) => /\bGoRouter\s*\(/.test(readText(join(root, f)) ?? ''));
    if (!rf) {
      warnings.push(`No GoRouter(...) found; add GoRoute(path: '${path}', builder: (context, state) => ${params.length ? '' : 'const '}${cls}(${args})) to your routes.`);
      return;
    }
    const orig = readText(join(root, rf))!;
    let t = orig.replace(/\r\n/g, '\n');
    const g = /\bGoRouter\s*\(/.exec(t)!;
    const gClose = matchBrace(t, g.index + g[0].length - 1, 'dart');
    const routes = /\broutes\s*:\s*(?:<[^>]*>\s*)?\[/.exec(t.slice(g.index, gClose));
    if (!routes) {
      warnings.push(`${rf} has no routes: [...] list; add the GoRoute for ${path} yourself.`);
      return;
    }
    const open = g.index + routes.index + routes[0].length - 1;
    const close = matchBrace(t, open, 'dart');
    const closeIndent = t.slice(t.lastIndexOf('\n', close) + 1, close).match(/^[ \t]*/)![0];
    const ind = `${closeIndent}  `;
    const name = camel(opts.name.replace(/(page|screen)$/i, '')) || camel(opts.name);
    const entry = [
      `${ind}GoRoute(`,
      `${ind}  path: '${path}',`,
      `${ind}  name: '${name}',`,
      `${ind}  builder: (context, state) => ${params.length ? '' : 'const '}${cls}(${args}),`,
      `${ind}),`,
    ].join('\n');
    const before = t.slice(0, close).replace(/\s*$/, '');
    t = `${before}${before.endsWith('[') || before.endsWith(',') ? '' : ','}\n${entry}\n${closeIndent}${t.slice(close)}`;
    t = addDartImport(t, importUri(rf, file, c));
    files.set(rf, withEol(t, detectEol(orig)));
    summary.push(`Update ${rf}: GoRoute '${path}' → ${cls}`);
    summary.push(`Open it with: context.go('${path.replace(/:(\w+)/g, '\${$1}')}')  or  context.goNamed('${name}'${params.length ? `, pathParameters: {${params.map((p) => `'${p}': ${camel(p)}`).join(', ')}}` : ''})`);
    return;
  }

  if (c.router === 'auto_route') {
    warnings.push(`auto_route needs @RoutePage() and a build_runner run; add ${cls} to your AppRouter routes and run dart run build_runner build.`);
    return;
  }

  // Navigator: MaterialApp(routes: {...}).
  const mainFile = 'lib/main.dart';
  const orig = readText(join(root, mainFile));
  if (orig === null) return;
  let t = orig.replace(/\r\n/g, '\n');
  if (params.length) {
    warnings.push(`Navigator named routes cannot read ${params.map((p) => `:${p}`).join(', ')} from the path; open ${cls} with Navigator.push(context, MaterialPageRoute(builder: (_) => ${cls}(...))).`);
    return;
  }
  const app = /\bMaterialApp\s*\(/.exec(t);
  if (!app) return;
  const aClose = matchBrace(t, app.index + app[0].length - 1, 'dart');
  const routes = /\broutes\s*:\s*(?:<[^>]*>\s*)?\{/.exec(t.slice(app.index, aClose));
  const entry = `'${path}': (context) => const ${cls}(),`;
  if (routes) {
    const open = app.index + routes.index + routes[0].length - 1;
    const close = matchBrace(t, open, 'dart');
    const closeIndent = t.slice(t.lastIndexOf('\n', close) + 1, close).match(/^[ \t]*/)![0];
    const before = t.slice(0, close).replace(/\s*$/, '');
    t = `${before}${before.endsWith('{') || before.endsWith(',') ? '' : ','}\n${closeIndent}  ${entry}\n${closeIndent}${t.slice(close)}`;
  } else {
    const indent = t.slice(t.lastIndexOf('\n', app.index) + 1).match(/^[ \t]*/)![0];
    const at = app.index + app[0].length;
    t = `${t.slice(0, at)}\n${indent}  routes: {\n${indent}    ${entry}\n${indent}  },${t.slice(at)}`;
  }
  t = addDartImport(t, importUri(mainFile, file, c));
  files.set(mainFile, withEol(t, detectEol(orig)));
  summary.push(`Update ${mainFile}: route '${path}' → ${cls}`);
  summary.push(`Open it with: Navigator.pushNamed(context, '${path}')`);
}

// ---------------- Next.js ----------------

function nextMajor(root: string): number {
  const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(join(root, 'package.json'));
  const v = pkg?.dependencies?.next ?? pkg?.devDependencies?.next ?? '';
  return Number(/\d+/.exec(v)?.[0] ?? 15);
}

function planNextRoute(root: string, map: ProjectMap, opts: RouteAddOptions, files: Map<string, string>, summary: string[]): void {
  const { path, params } = normPath(opts.name, opts.path);
  const appDir = ['src/app', 'app'].find((d) => exists(join(root, d)));
  const pagesDir = ['src/pages', 'pages'].find((d) => exists(join(root, d)));
  const segs = path.split('/').filter(Boolean).map((s) => s.replace(/^:(\w+)$/, '[$1]'));
  const comp = pascal(`${opts.name} page`).replace(/PagePage$/, 'Page');
  const title = words(opts.name.replace(/page$/i, '')).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  const tsx = exists(join(root, 'tsconfig.json'));
  const typed = (s: string) => (tsx ? s : '');
  let file: string;
  let body: string;
  if (appDir || !pagesDir) {
    file = posix.join(appDir ?? 'app', ...segs, `page.${tsx ? 'tsx' : 'jsx'}`);
    if (!params.length) {
      body = `export default function ${comp}() {\n  return (\n    <main>\n      <h1>${title}</h1>\n    </main>\n  );\n}\n`;
    } else if (nextMajor(root) >= 15) {
      const t = `{ ${params.map((p) => `${p}: string`).join('; ')} }`;
      body = `export default async function ${comp}({ params }${typed(`: { params: Promise<${t}> }`)}) {\n  const { ${params.join(', ')} } = await params;\n  return (\n    <main>\n      <h1>${title} {${params[0]}}</h1>\n    </main>\n  );\n}\n`;
    } else {
      const t = `{ ${params.map((p) => `${p}: string`).join('; ')} }`;
      body = `export default function ${comp}({ params }${typed(`: { params: ${t} }`)}) {\n  return (\n    <main>\n      <h1>${title} {params.${params[0]}}</h1>\n    </main>\n  );\n}\n`;
    }
  } else {
    file = posix.join(pagesDir, ...(segs.length ? segs : ['index'])) + `.${tsx ? 'tsx' : 'jsx'}`;
    body = params.length
      ? `import { useRouter } from 'next/router';\n\nexport default function ${comp}() {\n  const { ${params.join(', ')} } = useRouter().query;\n  return (\n    <main>\n      <h1>${title} {${params[0]}}</h1>\n    </main>\n  );\n}\n`
      : `export default function ${comp}() {\n  return (\n    <main>\n      <h1>${title}</h1>\n    </main>\n  );\n}\n`;
  }
  if (exists(join(root, file))) throw new ToolError('route_exists', `${file} already exists.`);
  const clash = map.routes.find((r) => r.path.replace(/\{([^/{}]+)\}/g, ':$1').replace(/\[(\w+)\]/g, ':$1') === path);
  if (clash) throw new ToolError('route_exists', `There is already a page for ${path} (${clash.file}).`);
  files.set(file, body);
  summary.push(`Create ${file}: ${comp} at ${path.replace(/:(\w+)/g, '[$1]')}`);
  summary.push(params.length ? `Link to it with: <Link href={\`${path.replace(/:(\w+)/g, '${$1}')}\`}>` : `Link to it with: <Link href="${path}">`);
}

export async function planRouteAdd(root: string, adapter: Adapter, opts: RouteAddOptions): Promise<ChangeSet> {
  if (!/^[A-Za-z][\w-]*$/.test(opts.name)) throw new ToolError('bad_args', `"${opts.name}" is not a valid route name.`, 'Use letters, digits, - or _, e.g. order-details.');
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  const c = map.conventions;
  if (adapter.id === 'flutter' && (c.router === 'getx' || c.di === 'getx' || c.stateManagement === 'getx')) {
    const cs = await planModuleAdd(root, adapter, { name: opts.name, initial: opts.initial });
    cs.skill = 'route add';
    if (opts.path && /:/.test(opts.path)) cs.warnings.push(`GetX routes are /${kebab(opts.name)}; pass ${normPath(opts.name, opts.path).params.join(', ')} with Get.toNamed(Routes.X, parameters: {...}) and read Get.parameters in the controller.`);
    return cs;
  }
  if (adapter.id === 'android') return (await import('./androidUi.ts')).planAndroidRoute(root, map, opts);
  if (adapter.id === 'react-native') return (await import('./reactNativeUi.ts')).planRnRoute(root, map, opts);
  if (adapter.id === 'react') return (await import('./reactUi.ts')).planReactRoute(root, map, opts);
  if (adapter.id === 'ios') return (await import('./iosUi.ts')).planIosRoute(root, map, opts);
  const files = new Map<string, string>();
  const summary: string[] = [];
  const warnings: string[] = [];
  if (adapter.id === 'flutter') planFlutterRoute(root, map, opts, files, summary, warnings);
  else if (adapter.id === 'nextjs') planNextRoute(root, map, opts, files, summary);
  else throw new ToolError('not_supported', `route add needs the Next.js, Flutter, React Native or Android adapter; this project uses the ${adapter.id} adapter.`);
  return buildChangeSet(root, 'route add', { files, summary, warnings, generated: [] });
}
