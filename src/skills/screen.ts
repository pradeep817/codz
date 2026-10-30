// screen add <name> --api <endpoint> [--path /orders/:id]: a working screen in
// one change. The route, the page, the call to the endpoint, and the loading,
// error (with retry) and data states.
//
//   GetX         module (binding, controller, view, route) + api wire + an Obx view
//   Flutter      route add + a page that loads the endpoint in a FutureBuilder
//                (riverpod: ConsumerStatefulWidget reading the provider; get_it: getIt<Repo>())
//   Next.js      route add + an async server page awaiting the endpoint, loading.tsx, error.tsx
//
// Path parameters feed the endpoint's arguments by name (--path /orders/:id → getOrder(id)).

import { join, posix } from 'node:path';
import { readMethod, splitParams } from '../adapters/getx.ts';
import { addDartImport, importUri } from '../adapters/flutter.ts';
import { importPath } from '../adapters/nextjs.ts';
import { loadMap } from '../core/cache.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { loadConfig } from '../core/config.ts';
import { exists, readText } from '../core/fsutil.ts';
import { ToolError, type Adapter, type ChangeSet, type EndpointInfo, type ModelInfo, type ProjectMap } from '../core/types.ts';
import { camel, kebab, pascal, snake } from '../input/naming.ts';
import { findDeclaration } from './apiEdit.ts';
import { planModuleAdd } from './module.ts';
import { planRouteAdd } from './route.ts';

export interface ScreenOptions {
  name: string;
  api?: string;
  path?: string;
  initial?: boolean;
  /** A form that sends the endpoint's request body (POST, PUT, PATCH). */
  form?: boolean;
  /** Edit forms: a GET endpoint whose answer fills the inputs when the form opens. */
  load?: string;
}

export interface Arg {
  name: string;
  type: string;
  required: boolean;
  /** Dart named parameter ({...}). */
  named?: boolean;
}

/** The model a response type names (User, User[], List<UserModel>, Promise<…>), and whether it is a list. */
export function responseShape(type: string | undefined, map: ProjectMap): { list: boolean; model?: ModelInfo; raw: string } {
  const raw = (type ?? '').replace(/^Promise<(.*)>$/, '$1').replace(/^Future<(.*)>$/, '$1').trim();
  // Dart List<T>, TypeScript T[] / Array<T>, Swift [T].
  const list = /^List<.+>$|\[\]$|^Array<.+>$|^\[[^\]:]+\]$/.test(raw);
  const inner = raw.replace(/^List<(.+)>$/, '$1').replace(/^Array<(.+)>$/, '$1').replace(/\[\]$/, '').replace(/^\[([^\]:]+)\]$/, '$1').replace(/\?$/, '');
  return { list, model: map.models.find((m) => m.name === inner), raw };
}

/** The field to show as a list item's title. */
export function titleField(model: ModelInfo | undefined): string | undefined {
  if (!model?.fields.length) return undefined;
  const names = model.fields.map((f) => f.name);
  return ['name', 'title', 'label', 'displayName', 'display_name', 'fullName', 'full_name', 'email', 'username', 'sku', 'id'].find((n) => names.includes(n)) ?? names[0];
}

export function idField(model: ModelInfo | undefined): string | undefined {
  return model?.fields.find((f) => /^(id|uuid|key|slug)$/.test(f.name))?.name;
}

/** Required arguments of a TypeScript function declaration. */
export function tsArgs(params: string): Arg[] {
  const out: Arg[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of params) {
    if ('{[(<'.includes(ch)) depth++;
    if ('}])>'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      out.push(parseTsParam(cur));
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(parseTsParam(cur));
  return out;
}

function parseTsParam(p: string): Arg {
  const m = /^\s*(\w+)(\?)?\s*:\s*([\s\S]+?)\s*(=.*)?$/.exec(p);
  return m ? { name: m[1], type: m[3].trim(), required: !m[2] && !m[4] } : { name: p.trim(), type: 'unknown', required: true };
}

function dartArgs(params: string): Arg[] {
  const out: Arg[] = [];
  // Retrofit annotations (@Path('id'), @Query('page'), @Body()) are not part of the type.
  for (const part of splitParams(params.replace(/@\w+(?:\([^)]*\))?\s*/g, ''))) {
    if (part.startsWith('{') || part.startsWith('[')) {
      for (const np of splitParams(part.slice(1, -1))) {
        const m = /^(required\s+)?([\w<>?, ]+?)\s+(\w+)\s*(=.*)?$/.exec(np.trim());
        if (m) out.push({ name: m[3], type: m[2].trim(), required: !!m[1], named: part.startsWith('{') });
      }
    } else {
      const m = /^([\w<>?, ]+?)\s+(\w+)$/.exec(part.trim());
      if (m) out.push({ name: m[2], type: m[1].trim(), required: true });
    }
  }
  return out;
}

function findEndpoint(map: ProjectMap, name: string): EndpointInfo {
  const ep = map.endpoints.find((e) => e.name === name) ?? map.endpoints.find((e) => e.name.toLowerCase() === name.toLowerCase());
  if (!ep) throw new ToolError('no_endpoint', `No endpoint called ${name} was found.`, map.endpoints.length ? `Endpoints: ${map.endpoints.map((e) => e.name).join(', ')}` : 'Add one first with: devtool api add');
  if (ep.method !== 'GET') throw new ToolError('screen_needs_get', `${ep.name} is a ${ep.method} endpoint; a screen loads data with a GET.`, `Wire it into a screen's controller instead: devtool api wire ${ep.name} --into <module>`);
  return ep;
}

/** Route params available to the screen, from --path. */
export function routeParams(path: string | undefined): string[] {
  return [...(path ?? '').matchAll(/[:{]([\w-]+)\}?/g)].map((m) => camel(m[1]));
}

function missingArgsError(ep: EndpointInfo, missing: Arg[], params: string[], name: string): ToolError {
  return new ToolError(
    'screen_args',
    `${ep.name}() needs ${missing.map((a) => a.name).join(', ')}, which the screen does not have.`,
    `Give the route a matching parameter, for example: devtool screen add ${name} --api ${ep.name} --path /${kebab(name)}/:${missing[0].name}${params.length ? ` (the route has ${params.join(', ')})` : ''}`,
  );
}

// ---------------- GetX ----------------

async function getxScreen(root: string, adapter: Adapter, map: ProjectMap, opts: ScreenOptions): Promise<ChangeSet> {
  const ep = opts.api ? findEndpoint(map, opts.api) : undefined;
  const cs = await planModuleAdd(root, adapter, { name: opts.name, initial: opts.initial, apis: ep ? [ep.name] : [] });
  cs.skill = 'screen add';
  if (!ep) return cs;
  const viewChange = cs.changes.find((c) => c.path.endsWith(`/views/${snake(opts.name)}_view.dart`));
  const ctrlChange = cs.changes.find((c) => c.path.endsWith(`/controllers/${snake(opts.name)}_controller.dart`));
  if (!viewChange?.after || !ctrlChange?.after) return cs;
  // The names api wire chose: getProducts → products / isProductsLoading / productsError / loadProducts().
  const stripped = ep.name.replace(/^(get|fetch|load)(?=[A-Z])/, '');
  const base = stripped !== ep.name ? camel(stripped) : ep.name;
  const action = `load${pascal(base)}`;
  const loading = `is${pascal(base)}Loading`;
  const error = `${base}Error`;
  const sig = readMethod(readText(join(root, ep.file)) ?? '', ep.name);
  const shape = responseShape(sig?.returnType ?? ep.response, map);
  const title = titleField(shape.model);
  const needsArgs = sig?.hasRequired ?? false;
  const I = '        ';
  const dataLines = shape.list
    ? [
        `${I}if (controller.${base}.isEmpty) return const Center(child: Text('Nothing here yet.'));`,
        `${I}return RefreshIndicator(`,
        `${I}  onRefresh: ${needsArgs ? `() async {}` : `controller.${action}`},`,
        `${I}  child: ListView.builder(`,
        `${I}    itemCount: controller.${base}.length,`,
        `${I}    itemBuilder: (context, index) {`,
        `${I}      final item = controller.${base}[index];`,
        `${I}      return ListTile(title: Text(${title ? `'\${item.${camel(title)}}'` : `item.toString()`}));`,
        `${I}    },`,
        `${I}  ),`,
        `${I});`,
      ]
    : [
        `${I}final data = controller.${base}.value;`,
        `${I}if (data == null) return const SizedBox.shrink();`,
        `${I}return ListView(`,
        `${I}  children: [`,
        ...(shape.model?.fields.length
          ? shape.model.fields.map((f) => `${I}    ListTile(title: const Text('${f.name}'), subtitle: Text('\${data.${camel(f.name)}}')),`)
          : [`${I}    ListTile(title: Text(data.toString())),`]),
        `${I}  ],`,
        `${I});`,
      ];
  const body = [
    '      body: Obx(() {',
    `${I}if (controller.${loading}.value) return const Center(child: CircularProgressIndicator());`,
    `${I}final error = controller.${error}.value;`,
    `${I}if (error != null) {`,
    `${I}  return Center(`,
    `${I}    child: Column(`,
    `${I}      mainAxisSize: MainAxisSize.min,`,
    `${I}      children: [`,
    `${I}        Text(error, textAlign: TextAlign.center),`,
    ...(needsArgs ? [] : [`${I}        TextButton(onPressed: controller.${action}, child: const Text('Retry')),`]),
    `${I}      ],`,
    `${I}    ),`,
    `${I}  );`,
    `${I}}`,
    ...dataLines,
    '      }),',
  ].join('\n');
  const view = viewChange.after.replace(/ {6}body: const Center\(child: Text\('\w+ is working'\)\),/, body);
  viewChange.after = view;
  cs.summary = cs.summary.filter((l) => !/^In \w+View: Obx/.test(l));
  cs.summary.push(`Show ${base} in ${viewChange.path}: loading, error with retry, and the data`);
  if (needsArgs) {
    // Route parameters arrive in Get.parameters (Get.toNamed(Routes.X, parameters: {...})): load from onInit.
    const args = dartArgs(sig?.params ?? '');
    const params = routeParams(opts.path);
    const required = args.filter((a) => a.required);
    if (required.length && required.every((a) => params.includes(a.name)) && ctrlChange.after.includes(`  Future<void> ${action}(`)) {
      const conv = (a: Arg) => (/^int\??$/.test(a.type) ? `int.parse(${a.name})` : /^double\??$/.test(a.type) ? `double.parse(${a.name})` : a.name);
      const call = required.map((a) => (a.named ? `${a.name}: ${conv(a)}` : conv(a))).join(', ');
      const onInit = ['  @override', '  void onInit() {', '    super.onInit();', ...required.map((a) => `    final ${a.name} = Get.parameters['${a.name}'];`), `    if (${required.map((a) => `${a.name} != null`).join(' && ')}) ${action}(${call});`, '  }', '', ''].join('\n');
      ctrlChange.after = ctrlChange.after.replace(`  Future<void> ${action}(`, `${onInit}  Future<void> ${action}(`);
      cs.summary.push(`${ctrlChange.path} reads ${required.map((a) => a.name).join(', ')} from Get.parameters and calls ${action}() on start`);
    } else {
      cs.warnings.push(`${ep.name}() needs arguments, so ${action}() is not called on start. Call controller.${action}(...) with the values (for example from Get.parameters) in the controller's onInit.`);
    }
  }
  return cs;
}

// ---------------- Flutter (riverpod, get_it) ----------------

async function flutterScreen(root: string, adapter: Adapter, map: ProjectMap, opts: ScreenOptions): Promise<ChangeSet> {
  const route = await planRouteAdd(root, adapter, { name: opts.name, path: opts.path, initial: opts.initial });
  route.skill = 'screen add';
  if (!opts.api) return route;
  const ep = findEndpoint(map, opts.api);
  const c = map.conventions;
  const page = route.changes.find((ch) => ch.before === null && ch.path.endsWith('.dart'));
  if (!page?.after) return route;
  const cls = /class\s+(\w+)\s+extends\s+StatelessWidget/.exec(page.after)?.[1];
  if (!cls) return route;
  const repoText = readText(join(root, ep.file)) ?? '';
  const sig = readMethod(repoText, ep.name);
  if (!sig?.repoClass) throw new ToolError('no_endpoint', `Could not read ${ep.name} in ${ep.file}.`);
  const args = dartArgs(sig.params);
  const params = routeParams(opts.path);
  const missing = args.filter((a) => a.required && !params.includes(a.name));
  if (missing.length) throw missingArgsError(ep, missing, params, opts.name);
  const callArgs = args
    .filter((a) => params.includes(a.name))
    .map((a) => {
      const v = /^int\??$/.test(a.type) ? `int.parse(widget.${a.name})` : /^double\??$/.test(a.type) ? `double.parse(widget.${a.name})` : `widget.${a.name}`;
      return a.named ? `${a.name}: ${v}` : v;
    })
    .join(', ');
  if (c.stateManagement === 'bloc') return blocScreen(root, route, page, cls, ep, sig, args, params, map, opts);
  const riverpod = c.di === 'riverpod';
  const getIt = c.di === 'get_it';
  if (!riverpod && !getIt) throw new ToolError('not_supported', `screen add needs a way to get ${sig.repoClass} (Riverpod, get_it or GetX); this project registers it with "${c.di || 'nothing'}".`, `Use devtool route add ${opts.name}, then load ${ep.name}() in the page yourself.`);
  const providerName = `${camel(sig.repoClass)}Provider`;
  const repoExpr = riverpod ? `ref.read(${providerName})` : `${c.diInstance || 'getIt'}<${sig.repoClass}>()`;
  const shape = responseShape(sig.returnType, map);
  const title = titleField(shape.model);
  const fields = params.map((p) => `  final String ${p};\n`).join('');
  const ctor = params.length ? `const ${cls}({super.key, ${params.map((p) => `required this.${p}`).join(', ')}});` : `const ${cls}({super.key});`;
  const stateBase = riverpod ? 'ConsumerStatefulWidget' : 'StatefulWidget';
  const stateCls = riverpod ? `ConsumerState<${cls}>` : `State<${cls}>`;
  const titleText = page.after.match(/AppBar\(title: const Text\('([^']*)'\)\)/)?.[1] ?? pascal(opts.name);
  const I = '          ';
  const dataView = shape.list
    ? [
        `${I}final items = snapshot.data!;`,
        `${I}if (items.isEmpty) return const Center(child: Text('Nothing here yet.'));`,
        `${I}return RefreshIndicator(`,
        `${I}  onRefresh: () async => _reload(),`,
        `${I}  child: ListView.builder(`,
        `${I}    itemCount: items.length,`,
        `${I}    itemBuilder: (context, index) => ListTile(title: Text(${title ? `'\${items[index].${camel(title)}}'` : 'items[index].toString()'})),`,
        `${I}  ),`,
        `${I});`,
      ]
    : [
        `${I}final data = snapshot.data${/\?$/.test(sig.returnType) ? '' : '!'};`,
        ...(/\?$/.test(sig.returnType) ? [`${I}if (data == null) return const SizedBox.shrink();`] : []),
        `${I}return ListView(`,
        `${I}  children: [`,
        ...(shape.model?.fields.length ? shape.model.fields.map((f) => `${I}    ListTile(title: const Text('${f.name}'), subtitle: Text('\${data.${camel(f.name)}}')),`) : [`${I}    ListTile(title: Text(data.toString())),`]),
        `${I}  ],`,
        `${I});`,
      ];
  let text = [
    "import 'package:flutter/material.dart';",
    '',
    `class ${cls} extends ${stateBase} {`,
    `  ${ctor}`,
    ...(fields ? ['', fields.trimEnd()] : []),
    '',
    '  @override',
    `  ${stateCls.replace(/<.*/, '')}<${cls}> createState() => _${cls}State();`,
    '}',
    '',
    `class _${cls}State extends ${stateCls} {`,
    `  late Future<${sig.returnType}> _future;`,
    '',
    '  @override',
    '  void initState() {',
    '    super.initState();',
    '    _future = _load();',
    '  }',
    '',
    `  Future<${sig.returnType}> _load() => ${repoExpr}.${ep.name}(${callArgs});`,
    '',
    '  void _reload() => setState(() => _future = _load());',
    '',
    '  @override',
    '  Widget build(BuildContext context) {',
    '    return Scaffold(',
    `      appBar: AppBar(title: const Text('${titleText}')),`,
    `      body: FutureBuilder<${sig.returnType}>(`,
    '        future: _future,',
    '        builder: (context, snapshot) {',
    '          if (snapshot.connectionState != ConnectionState.done) {',
    '            return const Center(child: CircularProgressIndicator());',
    '          }',
    '          if (snapshot.hasError) {',
    '            return Center(',
    '              child: Column(',
    '                mainAxisSize: MainAxisSize.min,',
    '                children: [',
    "                  Text('${snapshot.error}', textAlign: TextAlign.center),",
    "                  TextButton(onPressed: _reload, child: const Text('Retry')),",
    '                ],',
    '              ),',
    '            );',
    '          }',
    ...dataView,
    '        },',
    '      ),',
    '    );',
    '  }',
    '}',
    '',
  ].join('\n');
  if (riverpod) text = addDartImport(text, 'package:flutter_riverpod/flutter_riverpod.dart');
  text = addDartImport(text, importUri(page.path, ep.file, c));
  if (getIt && c.diFile) text = addDartImport(text, importUri(page.path, c.diFile, c));
  if (shape.model && shape.model.file !== ep.file) text = addDartImport(text, importUri(page.path, shape.model.file, c));
  page.after = text;
  route.summary.push(`${page.path} loads ${ep.name}() and shows loading, error with retry, and the data`);
  return route;
}

// ---------------- Flutter (Bloc) ----------------

/**
 * A Cubit with sealed loading / loaded / failure states next to the page, and
 * a page that provides it (BlocProvider) and switches on its state (BlocBuilder).
 * The API class comes from get_it when the project uses it, otherwise from
 * context.read (a RepositoryProvider above the page).
 */
function blocScreen(
  root: string,
  route: ChangeSet,
  page: ChangeSet['changes'][number],
  cls: string,
  ep: EndpointInfo,
  sig: NonNullable<ReturnType<typeof readMethod>>,
  args: Arg[],
  params: string[],
  map: ProjectMap,
  opts: ScreenOptions,
): ChangeSet {
  const c = map.conventions;
  if (/^void$/.test(sig.returnType)) throw new ToolError('screen_needs_data', `${ep.name}() returns nothing, so there is nothing for a screen to show.`);
  const base = pascal(opts.name);
  const [cubit, state] = [`${base}Cubit`, `${base}State`];
  const [loading, loaded, failure] = [`${base}Loading`, `${base}Loaded`, `${base}Failure`];
  const cubitFile = `${posix.dirname(page.path)}/${snake(opts.name)}_cubit.dart`;
  const T = sig.returnType;
  const conv = (a: Arg, v: string) => (/^int\??$/.test(a.type) ? `int.parse(${v})` : /^double\??$/.test(a.type) ? `double.parse(${v})` : v);
  const callArgs = args
    .filter((a) => params.includes(a.name))
    .map((a) => (a.named ? `${a.name}: ${conv(a, a.name)}` : conv(a, a.name)))
    .join(', ');
  const getIt = c.di === 'get_it';
  const repoExpr = getIt ? `${c.diInstance || 'getIt'}<${sig.repoClass}>()` : `context.read<${sig.repoClass}>()`;
  if (!getIt) route.warnings.push(`${page.path} reads ${sig.repoClass} with context.read, so provide it above this page: RepositoryProvider(create: (_) => ${sig.repoClass}(...), child: ...).`);

  let cubitText = [
    "import 'package:flutter_bloc/flutter_bloc.dart';",
    '',
    `sealed class ${state} {`,
    `  const ${state}();`,
    '}',
    '',
    `final class ${loading} extends ${state} {`,
    `  const ${loading}();`,
    '}',
    '',
    `final class ${loaded} extends ${state} {`,
    `  const ${loaded}(this.data);`,
    '',
    `  final ${T} data;`,
    '}',
    '',
    `final class ${failure} extends ${state} {`,
    `  const ${failure}(this.message);`,
    '',
    '  final String message;',
    '}',
    '',
    `class ${cubit} extends Cubit<${state}> {`,
    `  ${cubit}(this._api${params.length ? `, {${params.map((p) => `required this.${p}`).join(', ')}}` : ''}) : super(const ${loading}());`,
    '',
    `  final ${sig.repoClass} _api;`,
    ...params.map((p) => `  final String ${p};`),
    '',
    '  Future<void> load() async {',
    `    emit(const ${loading}());`,
    '    try {',
    `      emit(${loaded}(await _api.${ep.name}(${callArgs})));`,
    '    } catch (e) {',
    `      emit(${failure}(e.toString()));`,
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
  cubitText = addDartImport(cubitText, importUri(cubitFile, ep.file, c));
  const shape = responseShape(T, map);
  if (shape.model && shape.model.file !== ep.file) cubitText = addDartImport(cubitText, importUri(cubitFile, shape.model.file, c));

  const title = titleField(shape.model);
  const titleText = page.after!.match(/AppBar\(title: const Text\('([^']*)'\)\)/)?.[1] ?? base;
  const reload = `context.read<${cubit}>().load()`;
  const dataView = shape.list
    ? [
        `  Widget _data(BuildContext context, ${T} items) {`,
        "    if (items.isEmpty) return const Center(child: Text('Nothing here yet.'));",
        '    return RefreshIndicator(',
        `      onRefresh: () => ${reload},`,
        '      child: ListView.builder(',
        '        itemCount: items.length,',
        `        itemBuilder: (context, index) => ListTile(title: Text(${title ? `'\${items[index].${camel(title)}}'` : 'items[index].toString()'})),`,
        '      ),',
        '    );',
        '  }',
      ]
    : [
        `  Widget _data(BuildContext context, ${T} data) {`,
        ...(/\?$/.test(T) ? ['    if (data == null) return const SizedBox.shrink();'] : []),
        '    return ListView(',
        '      children: [',
        ...(shape.model?.fields.length ? shape.model.fields.map((f) => `        ListTile(title: const Text('${f.name}'), subtitle: Text('\${data.${camel(f.name)}}')),`) : ['        ListTile(title: Text(data.toString())),']),
        '      ],',
        '    );',
        '  }',
      ];
  const ctor = params.length ? `const ${cls}({super.key, ${params.map((p) => `required this.${p}`).join(', ')}});` : `const ${cls}({super.key});`;
  let pageText = [
    "import 'package:flutter/material.dart';",
    "import 'package:flutter_bloc/flutter_bloc.dart';",
    '',
    `class ${cls} extends StatelessWidget {`,
    `  ${ctor}`,
    ...(params.length ? ['', ...params.map((p) => `  final String ${p};`)] : []),
    '',
    '  @override',
    '  Widget build(BuildContext context) {',
    `    return BlocProvider(`,
    `      create: (context) => ${cubit}(${repoExpr}${params.length ? `, ${params.map((p) => `${p}: ${p}`).join(', ')}` : ''})..load(),`,
    '      child: Scaffold(',
    `        appBar: AppBar(title: const Text('${titleText}')),`,
    `        body: BlocBuilder<${cubit}, ${state}>(`,
    '          builder: (context, state) => switch (state) {',
    `            ${loading}() => const Center(child: CircularProgressIndicator()),`,
    `            ${failure}(:final message) => Center(`,
    '                child: Column(',
    '                  mainAxisSize: MainAxisSize.min,',
    '                  children: [',
    '                    Text(message, textAlign: TextAlign.center),',
    `                    TextButton(onPressed: () => ${reload}, child: const Text('Retry')),`,
    '                  ],',
    '                ),',
    '              ),',
    `            ${loaded}(:final data) => _data(context, data),`,
    '          },',
    '        ),',
    '      ),',
    '    );',
    '  }',
    '',
    ...dataView,
    '}',
    '',
  ].join('\n');
  pageText = addDartImport(pageText, importUri(page.path, cubitFile, c));
  if (getIt && c.diFile) pageText = addDartImport(pageText, importUri(page.path, c.diFile, c));
  else pageText = addDartImport(pageText, importUri(page.path, ep.file, c));
  if (shape.model && shape.model.file !== ep.file) pageText = addDartImport(pageText, importUri(page.path, shape.model.file, c));
  if (getIt) pageText = addDartImport(pageText, importUri(page.path, ep.file, c));
  page.after = pageText;
  const files = new Map<string, string>(route.changes.filter((ch) => ch.after !== null).map((ch) => [ch.path, ch.after as string]));
  if (exists(join(root, cubitFile))) throw new ToolError('file_exists', `${cubitFile} already exists.`, 'Pick another screen name.');
  files.set(cubitFile, cubitText);
  const summary = [...route.summary, `Create ${cubitFile}: ${cubit} with loading, loaded and failure states, calling ${sig.repoClass}.${ep.name}()`, `${page.path} provides ${cubit} and shows loading, error with retry, and the data`];
  return buildChangeSet(root, 'screen add', { files, summary, warnings: route.warnings, generated: [] });
}

// ---------------- Next.js ----------------

async function nextScreen(root: string, adapter: Adapter, map: ProjectMap, opts: ScreenOptions): Promise<ChangeSet> {
  const route = await planRouteAdd(root, adapter, { name: opts.name, path: opts.path, initial: opts.initial });
  route.skill = 'screen add';
  if (!opts.api) return route;
  const ep = findEndpoint(map, opts.api);
  const c = map.conventions;
  const page = route.changes.find((ch) => ch.before === null && /\/page\.(t|j)sx$/.test(ch.path));
  if (!page?.after) {
    route.warnings.push('screen add fills App Router pages only; the Pages Router page was created without the data call.');
    return route;
  }
  const text = readText(join(root, ep.file)) ?? '';
  const decl = findDeclaration(text, ep.name, 'ts');
  if (!decl) throw new ToolError('no_endpoint', `Could not read ${ep.name} in ${ep.file}.`);
  const args = tsArgs(decl.params);
  const params = routeParams(opts.path);
  const missing = args.filter((a) => a.required && !params.includes(a.name));
  if (missing.length) throw missingArgsError(ep, missing, params, opts.name);
  const callArgs = args
    .filter((a) => params.includes(a.name) || a.required)
    .map((a) => (/^number$/.test(a.type) ? `Number(${a.name})` : a.name))
    .join(', ');
  const comp = /export default (?:async )?function (\w+)/.exec(page.after)?.[1] ?? `${pascal(opts.name)}Page`;
  const title = /<h1>([^<{]*)/.exec(page.after)?.[1]?.trim() ?? pascal(opts.name);
  const shape = responseShape(decl.returnType, map);
  const tf = titleField(shape.model);
  const idf = idField(shape.model);
  const dataVar = shape.list ? 'items' : camel(shape.model?.name ?? 'data');
  // Import the endpoint from the barrel when the API folder has one that re-exports it.
  const dir = posix.dirname(ep.file);
  const barrel = [`${dir}/index.ts`, `${dir}/index.js`].find((f) => exists(join(root, f)) && /export\s+\*\s+from|export\s*\{/.test(readText(join(root, f)) ?? ''));
  const from = importPath(page.path, barrel ?? ep.file, c);
  const q = c.quote === 'double' ? '"' : "'";
  const semi = c.semicolons === 'false' ? '' : ';';
  const render = shape.list
    ? [
        `      {${dataVar}.length === 0 ? (`,
        '        <p>Nothing here yet.</p>',
        '      ) : (',
        '        <ul>',
        `          {${dataVar}.map((item${idf ? '' : ', index'}) => (`,
        `            <li key={${idf ? `item.${idf}` : 'index'}}>{${tf ? `String(item.${tf})` : 'JSON.stringify(item)'}}</li>`,
        '          ))}',
        '        </ul>',
        '      )}',
      ]
    : shape.model?.fields.length
      ? ['      <dl>', ...shape.model.fields.flatMap((f) => [`        <dt>${f.name}</dt>`, `        <dd>{String(${dataVar}.${f.name} ?? '')}</dd>`]), '      </dl>']
      : [`      <pre>{JSON.stringify(${dataVar}, null, 2)}</pre>`];
  const sigParams = params.length ? `{ params }: { params: Promise<{ ${params.map((p) => `${p}: string`).join('; ')} }> }` : '';
  page.after = [
    `import { ${ep.name} } from ${q}${from}${q}${semi}`,
    '',
    `export default async function ${comp}(${sigParams}) {`,
    ...(params.length ? [`  const { ${params.join(', ')} } = await params${semi}`] : []),
    `  const ${dataVar} = await ${ep.name}(${callArgs})${semi}`,
    '  return (',
    '    <main>',
    `      <h1>${title}</h1>`,
    ...render,
    '    </main>',
    `  )${semi}`,
    '}',
    '',
  ].join('\n');
  // Next 14 passes params directly, not as a promise.
  const pkg = readText(join(root, 'package.json')) ?? '';
  const nextMajor = Number(/"next"\s*:\s*"[^\d]*(\d+)/.exec(pkg)?.[1] ?? 15);
  if (nextMajor < 15 && params.length) page.after = page.after.replace(`params: Promise<{`, 'params: {').replace(/ }> }\) \{/, ' } }) {').replace(`= await params${semi}`, `= params${semi}`);
  const folder = posix.dirname(page.path);
  const ext = page.path.endsWith('.tsx') ? 'tsx' : 'jsx';
  const extra = new Map<string, string>([
    [`${folder}/loading.${ext}`, `export default function Loading() {\n  return <p>Loading…</p>${semi}\n}\n`],
    [
      `${folder}/error.${ext}`,
      [
        `${q}use client${q}${semi}`,
        '',
        ext === 'tsx' ? 'export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {' : 'export default function Error({ error, reset }) {',
        '  return (',
        '    <main>',
        `      <p>Could not load this page: {error.message}</p>`,
        '      <button onClick={() => reset()}>Retry</button>',
        '    </main>',
        `  )${semi}`,
        '}',
        '',
      ].join('\n'),
    ],
  ]);
  const files = new Map<string, string>(route.changes.filter((ch) => ch.after !== null).map((ch) => [ch.path, ch.after as string]));
  for (const [f, t] of extra) if (!exists(join(root, f))) files.set(f, t);
  const summary = [...route.summary, `${page.path} awaits ${ep.name}() on the server and renders the result`, `Create ${folder}/loading.${ext} and ${folder}/error.${ext} (loading state, and an error with retry)`];
  return buildChangeSet(root, 'screen add', { files, summary, warnings: route.warnings, generated: [] });
}

export async function planScreenAdd(root: string, adapter: Adapter, opts: ScreenOptions): Promise<ChangeSet> {
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  const c = map.conventions;
  if (adapter.id === 'android') return (await import('./androidUi.ts')).planAndroidScreen(root, map, opts);
  if (adapter.id === 'react-native') return (await import('./reactNativeUi.ts')).planRnScreen(root, map, opts);
  if (adapter.id === 'react') return (await import('./reactUi.ts')).planReactScreen(root, map, opts);
  if (adapter.id === 'ios') return (await import('./iosUi.ts')).planIosScreen(root, map, opts);
  if (opts.form) return (await import('./screenForm.ts')).planFormScreen(root, adapter, map, opts);
  if (adapter.id === 'flutter' && (c.router === 'getx' || c.di === 'getx' || c.stateManagement === 'getx')) return getxScreen(root, adapter, map, opts);
  if (adapter.id === 'flutter') return flutterScreen(root, adapter, map, opts);
  if (adapter.id === 'nextjs') return nextScreen(root, adapter, map, opts);
  throw new ToolError('not_supported', `screen add needs the Next.js, Flutter, React Native or Android adapter; this project uses the ${adapter.id} adapter.`);
}
