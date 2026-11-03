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
import { splitTsParams } from '../adapters/reactQuery.ts';
import { dartPagingCall, dartSearchMatch, detectPaging, PAGE_SIZE, pagingSummary, pagingWarnings, tsPagingArgs, tsPagingParams, type Paging } from './paging.ts';
import { planModuleAdd } from './module.ts';
import { planRouteAdd } from './route.ts';

/** Dart: the text a Text widget shows for a field: a non-null String as it is, anything else interpolated (never a dead ?? on a field that turns out non-null). */
const dartShow = (expr: string, f?: { type: string; nullable: boolean }) => (f && f.type === 'String' && !f.nullable ? expr : `'\${${expr}}'`);
const fieldOf = (m: ModelInfo | undefined, name: string) => m?.fields.find((f) => f.name === name);

export interface ScreenOptions {
  name: string;
  api?: string;
  path?: string;
  initial?: boolean;
  /** A form that sends the endpoint's request body (POST, PUT, PATCH). */
  form?: boolean;
  /** Edit forms: a GET endpoint whose answer fills the inputs when the form opens. */
  load?: string;
  /** List screens: load page after page as the user scrolls (the endpoint needs a page or offset parameter). */
  paginate?: boolean;
  /** List screens: a search box (server search when the endpoint has a q/search parameter, otherwise over the loaded items). */
  search?: boolean;
  /** Write a test for the screen (default true). */
  tests?: boolean;
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
  if (!ep) throw new ToolError('no_endpoint', `No endpoint called ${name} was found.`, map.endpoints.length ? `Endpoints: ${map.endpoints.map((e) => e.name).join(', ')}` : 'Add one first with: codz api add');
  if (ep.method !== 'GET') throw new ToolError('screen_needs_get', `${ep.name} is a ${ep.method} endpoint; a screen loads data with a GET.`, `Wire it into a screen's controller instead: codz api wire ${ep.name} --into <module>`);
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
    `Give the route a matching parameter, for example: codz screen add ${name} --api ${ep.name} --path /${kebab(name)}/:${missing[0].name}${params.length ? ` (the route has ${params.join(', ')})` : ''}`,
  );
}

/** The item type of a Dart list type: List<ProductModel> → ProductModel. */
const itemType = (t: string) => /^List<(.+)>\??$/.exec(t.trim())?.[1] ?? 'dynamic';

/** Paging for a Dart list endpoint (Flutter screens). */
function dartPaging(shape: ReturnType<typeof responseShape>, args: Arg[], opts: ScreenOptions, name: string, returnType: string): Paging {
  if (!shape.list) throw new ToolError('screen_not_list', `${name}() returns ${returnType}, not a list; --paginate and --search are for list screens.`);
  return detectPaging(args.map((a) => ({ name: a.name, type: a.type })), { paginate: opts.paginate, search: opts.search, modelStringFields: (shape.model?.fields ?? []).filter((f) => f.type === 'String').map((f) => f.name), titleField: titleField(shape.model) });
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
  if (opts.paginate || opts.search) return getxPaged(root, map, opts, ep, cs, viewChange as { path: string; after: string }, ctrlChange as { path: string; after: string });
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
        `${I}if (controller.${base}.isEmpty) return const Center(child: Text('No items'));`,
        `${I}return RefreshIndicator(`,
        `${I}  onRefresh: ${needsArgs ? `() async {}` : `controller.${action}`},`,
        `${I}  child: ListView.builder(`,
        `${I}    itemCount: controller.${base}.length,`,
        `${I}    itemBuilder: (context, index) {`,
        `${I}      final item = controller.${base}[index];`,
        `${I}      return ListTile(title: Text(${title ? dartShow(`item.${camel(title)}`, fieldOf(shape.model, title)) : `item.toString()`}));`,
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
          ? shape.model.fields.map((f) => `${I}    ListTile(title: const Text('${f.name}'), subtitle: Text(${dartShow(`data.${camel(f.name)}`, f)})),`)
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

/** GetX: the module's controller holds items, isLoading, error, query (and hasMore), and its view lists them. */
function getxPaged(root: string, map: ProjectMap, opts: ScreenOptions, ep: EndpointInfo, cs: ChangeSet, view: { path: string; after: string }, ctrl: { path: string; after: string }): ChangeSet {
  const sig = readMethod(readText(join(root, ep.file)) ?? '', ep.name);
  if (!sig) throw new ToolError('no_endpoint', `Could not read ${ep.name} in ${ep.file}.`);
  const args = dartArgs(sig.params);
  const params = routeParams(opts.path);
  const missing = args.filter((a) => a.required && !params.includes(a.name));
  if (missing.length) throw missingArgsError(ep, missing, params, opts.name);
  const shape = responseShape(sig.returnType, map);
  const paging = dartPaging(shape, args, opts, ep.name, sig.returnType);
  const item = itemType(sig.returnType);
  const repoLine = /^ {2}final (\w+) (_\w+) = Get\.find<\w+>\(\);$/m.exec(ctrl.after);
  const cls = /class\s+(\w+)\s+extends\s+GetxController/.exec(ctrl.after)?.[1];
  if (!repoLine || !cls) throw new ToolError('not_supported', `Could not read the controller codz wrote (${ctrl.path}).`);
  const repo = repoLine[2];
  const searchable = Boolean(paging.search || paging.clientSearch);
  const pg = paging.paginate;
  const first = paging.page?.mode === 'offset' ? '0' : '1';
  const conv = (a: Arg, v: string) => (/^int\??$/.test(a.type) ? `int.parse(${v})` : /^double\??$/.test(a.type) ? `double.parse(${v})` : v);
  const routeVals = new Map(args.filter((a) => params.includes(a.name)).map((a) => [a.name, conv(a, `Get.parameters['${a.name}']!`)]));
  const call = dartPagingCall(args, paging, routeVals, { page: pg ? 'next' : undefined, search: paging.search ? 'query.value.isEmpty ? null : query.value' : undefined }, '_pageSize');
  const strFields = paging.searchFields.map((f) => ({ name: f, nullable: fieldOf(shape.model, f)?.nullable ?? true }));
  const imports = ctrl.after.split('\n').filter((l) => l.startsWith('import ') && !l.includes('package:get/get.dart'));
  ctrl.after = [
    ...(paging.search ? ["import 'dart:async';", ''] : []),
    "import 'package:get/get.dart';",
    '',
    ...imports,
    '',
    `class ${cls} extends GetxController {`,
    repoLine[0],
    '',
    ...(pg && paging.size ? [`  static const _pageSize = ${PAGE_SIZE};`, ''] : []),
    `  // GET ${ep.path} via ${repoLine[1]}.${ep.name}`,
    `  final items = <${item}>[].obs;`,
    '  final isLoading = false.obs;',
    '  final error = RxnString();',
    ...(pg ? ['  final hasMore = true.obs;'] : []),
    ...(searchable ? ["  final query = ''.obs;"] : []),
    ...(pg && paging.page!.mode === 'page' ? ['  int _page = 0;'] : []),
    '  int _request = 0;',
    ...(paging.search ? ['  Timer? _debounce;'] : []),
    '',
    ...(paging.clientSearch
      ? ['  /// The items that match the search.', `  List<${item}> get visible => query.value.isEmpty ? items : items.where((item) => ${dartSearchMatch(strFields, 'item', 'query.value', camel)}).toList();`, '']
      : []),
    `  /// Loads ${pg ? 'the first page again (reset) or the next one' : 'the list'}. Only the latest request counts.`,
    `  Future<void> load(${pg ? '{bool reset = false}' : ''}) async {`,
    ...(pg ? ['    if (!reset && (isLoading.value || !hasMore.value)) return;'] : []),
    '    final request = ++_request;',
    '    isLoading.value = true;',
    '    error.value = null;',
    '    try {',
    ...(pg ? [`      final next = reset ? ${first} : ${paging.page!.mode === 'offset' ? 'items.length' : '_page + 1'};`] : []),
    `      final rows = await ${repo}.${ep.name}(${call});`,
    '      if (request != _request) return;',
    ...(pg ? ['      if (reset) {', '        items.assignAll(rows);', '      } else {', '        items.addAll(rows);', '      }', ...(paging.page!.mode === 'page' ? ['      _page = next;'] : []), `      hasMore.value = ${paging.size ? 'rows.length == _pageSize' : 'rows.isNotEmpty'};`] : ['      items.assignAll(rows);']),
    '    } catch (e) {',
    '      if (request == _request) error.value = e.toString();',
    '    } finally {',
    '      if (request == _request) isLoading.value = false;',
    '    }',
    '  }',
    ...(paging.search
      ? ['', '  void search(String text) {', '    _debounce?.cancel();', '    _debounce = Timer(const Duration(milliseconds: 400), () {', '      query.value = text.trim();', `      load(${pg ? 'reset: true' : ''});`, '    });', '  }']
      : paging.clientSearch
        ? ['', '  void search(String text) => query.value = text.trim().toLowerCase();']
        : []),
    '',
    '  @override',
    '  void onInit() {',
    '    super.onInit();',
    `    load(${pg ? 'reset: true' : ''});`,
    '  }',
    ...(paging.search ? ['', '  @override', '  void onClose() {', '    _debounce?.cancel();', '    super.onClose();', '  }'] : []),
    '}',
    '',
  ].join('\n');
  const title = titleField(shape.model);
  const show = (v: string) => (title ? dartShow(`${v}.${camel(title)}`, fieldOf(shape.model, title)) : `${v}.toString()`);
  const reset = pg ? 'reset: true' : '';
  const I = '        ';
  const list = [
    'Obx(() {',
    `${I}final shown = controller.${paging.clientSearch ? 'visible' : 'items'};`,
    `${I}final error = controller.error.value;`,
    `${I}if (controller.items.isEmpty && controller.isLoading.value) return const Center(child: CircularProgressIndicator());`,
    `${I}if (controller.items.isEmpty && error != null) {`,
    `${I}  return Center(`,
    `${I}    child: Column(`,
    `${I}      mainAxisSize: MainAxisSize.min,`,
    `${I}      children: [`,
    `${I}        Text(error, textAlign: TextAlign.center),`,
    `${I}        TextButton(onPressed: () => controller.load(${reset}), child: const Text('Retry')),`,
    `${I}      ],`,
    `${I}    ),`,
    `${I}  );`,
    `${I}}`,
    `${I}if (shown.isEmpty${pg ? ' && !controller.hasMore.value' : ''}) return Center(child: Text(${searchable ? "controller.query.value.isEmpty ? 'No items' : 'No matches'" : "'No items'"}));`,
    `${I}return RefreshIndicator(`,
    `${I}  onRefresh: () => controller.load(${reset}),`,
    `${I}  child: ListView.builder(`,
    `${I}    physics: const AlwaysScrollableScrollPhysics(),`,
    `${I}    itemCount: shown.length${pg ? ' + (controller.hasMore.value || error != null ? 1 : 0)' : ''},`,
    `${I}    itemBuilder: (context, index) {`,
    ...(pg
      ? [
          `${I}      if (index == shown.length) {`,
          `${I}        if (error != null) return TextButton(onPressed: () => controller.load(), child: const Text('Retry'));`,
          `${I}        // The end of the list is on screen: ask for the next page.`,
          `${I}        if (!controller.isLoading.value) WidgetsBinding.instance.addPostFrameCallback((_) => controller.load());`,
          `${I}        return const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()));`,
          `${I}      }`,
        ]
      : []),
    `${I}      return ListTile(title: Text(${show('shown[index]')}));`,
    `${I}    },`,
    `${I}  ),`,
    `${I});`,
    '      })',
  ];
  const body = searchable
    ? [
        '      body: Column(',
        '        children: [',
        '          Padding(',
        '            padding: const EdgeInsets.all(12),',
        "            child: TextField(onChanged: controller.search, decoration: const InputDecoration(hintText: 'Search', prefixIcon: Icon(Icons.search), border: OutlineInputBorder())),",
        '          ),',
        `          Expanded(child: ${list.map((l, i) => (i === 0 ? l : `    ${l}`)).join('\n')}),`,
        '        ],',
        '      ),',
      ].join('\n')
    : `      body: ${list.join('\n')},`;
  const replaced = view.after.replace(/ {6}body: const Center\(child: Text\('\w+ is working'\)\),/, body);
  if (replaced === view.after) throw new ToolError('not_supported', `Could not fill the view codz wrote (${view.path}).`);
  view.after = replaced;
  cs.summary = cs.summary.filter((l) => !/^In \w+View: Obx|^Update .*controller\.dart: load|^Show /.test(l));
  cs.summary.push(`${ctrl.path}: items, isLoading, error${searchable ? ', query' : ''}${pg ? ', hasMore' : ''} and load()`, `${view.path} lists them and ${pagingSummary(paging)}`);
  cs.warnings.push(...pagingWarnings(paging));
  if (params.length) cs.warnings.push(`The controller reads ${params.join(', ')} from Get.parameters; open the page with Get.toNamed(Routes.X, parameters: {...}).`);
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
  if (!riverpod && !getIt) throw new ToolError('not_supported', `screen add needs a way to get ${sig.repoClass} (Riverpod, get_it or GetX); this project registers it with "${c.di || 'nothing'}".`, `Use codz route add ${opts.name}, then load ${ep.name}() in the page yourself.`);
  const providerName = `${camel(sig.repoClass)}Provider`;
  const repoExpr = riverpod ? `ref.read(${providerName})` : `${c.diInstance || 'getIt'}<${sig.repoClass}>()`;
  const shape = responseShape(sig.returnType, map);
  const title = titleField(shape.model);
  const fields = params.map((p) => `  final String ${p};\n`).join('');
  const ctor = params.length ? `const ${cls}({super.key, ${params.map((p) => `required this.${p}`).join(', ')}});` : `const ${cls}({super.key});`;
  const stateBase = riverpod ? 'ConsumerStatefulWidget' : 'StatefulWidget';
  const stateCls = riverpod ? `ConsumerState<${cls}>` : `State<${cls}>`;
  const titleText = page.after.match(/AppBar\(title: const Text\('([^']*)'\)\)/)?.[1] ?? pascal(opts.name);
  if (opts.paginate || opts.search) {
    const paging = dartPaging(shape, args, opts, ep.name, sig.returnType);
    const routeVals = new Map(args.filter((a) => params.includes(a.name)).map((a) => [a.name, /^int\??$/.test(a.type) ? `int.parse(widget.${a.name})` : /^double\??$/.test(a.type) ? `double.parse(widget.${a.name})` : `widget.${a.name}`]));
    const item = itemType(sig.returnType);
    const searchable = Boolean(paging.search || paging.clientSearch);
    const first = paging.page?.mode === 'offset' ? '0' : '1';
    const call = dartPagingCall(args, paging, routeVals, { page: paging.paginate ? 'next' : undefined, search: paging.search ? '_query.isEmpty ? null : _query' : undefined }, '_pageSize');
    const show = (v: string) => (title ? dartShow(`${v}.${camel(title)}`, fieldOf(shape.model, title)) : `${v}.toString()`);
    const strFields = paging.searchFields.map((n) => ({ name: n, nullable: fieldOf(shape.model, n)?.nullable ?? true }));
    let text = [
      ...(paging.search ? ["import 'dart:async';", ''] : []),
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
      ...(paging.paginate && paging.size ? [`  static const _pageSize = ${PAGE_SIZE};`, ''] : []),
      `  final _items = <${item}>[];`,
      ...(paging.search ? ['  Timer? _debounce;'] : []),
      ...(searchable ? ["  String _query = '';"] : []),
      ...(paging.paginate && paging.page!.mode === 'page' ? ['  int _page = 0;'] : []),
      ...(paging.paginate ? ['  bool _hasMore = true;'] : []),
      '  bool _loading = false;',
      '  Object? _error;',
      '  int _request = 0;',
      '',
      '  @override',
      '  void initState() {',
      '    super.initState();',
      `    _load(${paging.paginate ? 'reset: true' : ''});`,
      '  }',
      ...(paging.search ? ['', '  @override', '  void dispose() {', '    _debounce?.cancel();', '    super.dispose();', '  }'] : []),
      '',
      `  /// Loads ${paging.paginate ? 'the first page again (reset) or the next one' : 'the list'}.`,
      `  Future<void> _load(${paging.paginate ? '{bool reset = false}' : ''}) async {`,
      ...(paging.paginate ? ['    if (!reset && (_loading || !_hasMore)) return;'] : []),
      '    // Only the latest request counts: a new search or refresh replaces one still loading.',
      '    final request = ++_request;',
      '    setState(() {',
      '      _loading = true;',
      '      _error = null;',
      '    });',
      '    try {',
      ...(paging.paginate ? [`      final next = reset ? ${first} : ${paging.page!.mode === 'offset' ? '_items.length' : '_page + 1'};`] : []),
      `      final rows = await ${repoExpr}.${ep.name}(${call});`,
      '      if (!mounted || request != _request) return;',
      '      setState(() {',
      ...(paging.paginate ? ['        if (reset) _items.clear();'] : ['        _items.clear();']),
      '        _items.addAll(rows);',
      ...(paging.paginate ? [...(paging.page!.mode === 'page' ? ['        _page = next;'] : []), `        _hasMore = ${paging.size ? 'rows.length == _pageSize' : 'rows.isNotEmpty'};`] : []),
      '      });',
      '    } catch (e) {',
      '      if (mounted && request == _request) setState(() => _error = e);',
      '    } finally {',
      '      if (mounted && request == _request) setState(() => _loading = false);',
      '    }',
      '  }',
      ...(paging.search
        ? ['', '  void _onSearch(String text) {', '    _debounce?.cancel();', '    _debounce = Timer(const Duration(milliseconds: 400), () {', '      _query = text.trim();', `      _load(${paging.paginate ? 'reset: true' : ''});`, '    });', '  }']
        : paging.clientSearch
          ? ['', '  void _onSearch(String text) => setState(() => _query = text.trim().toLowerCase());']
          : []),
      '',
      '  @override',
      '  Widget build(BuildContext context) {',
      '    return Scaffold(',
      `      appBar: AppBar(title: const Text('${titleText}')),`,
      ...(searchable
        ? [
            '      body: Column(',
            '        children: [',
            '          Padding(',
            '            padding: const EdgeInsets.all(12),',
            "            child: TextField(onChanged: _onSearch, decoration: const InputDecoration(hintText: 'Search', prefixIcon: Icon(Icons.search), border: OutlineInputBorder())),",
            '          ),',
            '          Expanded(child: _list()),',
            '        ],',
            '      ),',
          ]
        : ['      body: _list(),']),
      '    );',
      '  }',
      '',
      '  Widget _list() {',
      `    final shown = ${paging.clientSearch ? `_query.isEmpty ? _items : _items.where((item) => ${dartSearchMatch(strFields, 'item', '_query', camel)}).toList()` : '_items'};`,
      '    if (_items.isEmpty && _loading) return const Center(child: CircularProgressIndicator());',
      '    if (_items.isEmpty && _error != null) {',
      '      return Center(',
      '        child: Column(',
      '          mainAxisSize: MainAxisSize.min,',
      '          children: [',
      "            Text('$_error', textAlign: TextAlign.center),",
      `            TextButton(onPressed: () => _load(${paging.paginate ? 'reset: true' : ''}), child: const Text('Retry')),`,
      '          ],',
      '        ),',
      '      );',
      '    }',
      `    if (shown.isEmpty${paging.paginate ? ' && !_hasMore' : ''}) return Center(child: Text(${searchable ? "_query.isEmpty ? 'No items' : 'No matches'" : "'No items'"}));`,
      '    return RefreshIndicator(',
      `      onRefresh: () => _load(${paging.paginate ? 'reset: true' : ''}),`,
      '      child: ListView.builder(',
      '        physics: const AlwaysScrollableScrollPhysics(),',
      `        itemCount: shown.length${paging.paginate ? ' + (_hasMore || _error != null ? 1 : 0)' : ''},`,
      '        itemBuilder: (context, index) {',
      ...(paging.paginate
        ? [
            '          if (index == shown.length) {',
            "            if (_error != null) return TextButton(onPressed: () => _load(), child: const Text('Retry'));",
            '            // The end of the list is on screen: ask for the next page.',
            '            if (!_loading) WidgetsBinding.instance.addPostFrameCallback((_) => _load());',
            '            return const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()));',
            '          }',
          ]
        : []),
      `          return ListTile(title: Text(${show('shown[index]')}));`,
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
    route.summary.push(`${page.path} lists ${ep.name}() and ${pagingSummary(paging)}`);
    route.warnings.push(...pagingWarnings(paging));
    return route;
  }
  const I = '          ';
  const dataView = shape.list
    ? [
        `${I}final items = snapshot.data!;`,
        `${I}if (items.isEmpty) return const Center(child: Text('No items'));`,
        `${I}return RefreshIndicator(`,
        `${I}  onRefresh: () async => _reload(),`,
        `${I}  child: ListView.builder(`,
        `${I}    itemCount: items.length,`,
        `${I}    itemBuilder: (context, index) => ListTile(title: Text(${title ? dartShow(`items[index].${camel(title)}`, fieldOf(shape.model, title)) : 'items[index].toString()'})),`,
        `${I}  ),`,
        `${I});`,
      ]
    : [
        `${I}final data = snapshot.data${/\?$/.test(sig.returnType) ? '' : '!'};`,
        ...(/\?$/.test(sig.returnType) ? [`${I}if (data == null) return const SizedBox.shrink();`] : []),
        `${I}return ListView(`,
        `${I}  children: [`,
        ...(shape.model?.fields.length ? shape.model.fields.map((f) => `${I}    ListTile(title: const Text('${f.name}'), subtitle: Text(${dartShow(`data.${camel(f.name)}`, f)})),`) : [`${I}    ListTile(title: Text(data.toString())),`]),
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
  if (opts.paginate || opts.search) return blocPagedScreen(root, route, page, cls, ep, sig, args, params, map, opts, { cubit, state, cubitFile, repoExpr, base });

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
        "    if (items.isEmpty) return const Center(child: Text('No items'));",
        '    return RefreshIndicator(',
        `      onRefresh: () => ${reload},`,
        '      child: ListView.builder(',
        '        itemCount: items.length,',
        `        itemBuilder: (context, index) => ListTile(title: Text(${title ? dartShow(`items[index].${camel(title)}`, fieldOf(shape.model, title)) : 'items[index].toString()'})),`,
        '      ),',
        '    );',
        '  }',
      ]
    : [
        `  Widget _data(BuildContext context, ${T} data) {`,
        ...(/\?$/.test(T) ? ['    if (data == null) return const SizedBox.shrink();'] : []),
        '    return ListView(',
        '      children: [',
        ...(shape.model?.fields.length ? shape.model.fields.map((f) => `        ListTile(title: const Text('${f.name}'), subtitle: Text(${dartShow(`data.${camel(f.name)}`, f)})),`) : ['        ListTile(title: Text(data.toString())),']),
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

/** Bloc: a Cubit with one state (items, loading, error, query, hasMore) for a paged or searchable list, and its page. */
function blocPagedScreen(
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
  n: { cubit: string; state: string; cubitFile: string; repoExpr: string; base: string },
): ChangeSet {
  const c = map.conventions;
  const T = sig.returnType;
  const shape = responseShape(T, map);
  const paging = dartPaging(shape, args, opts, ep.name, T);
  const item = itemType(T);
  const { cubit, state } = n;
  const searchable = Boolean(paging.search || paging.clientSearch);
  const pg = paging.paginate;
  const first = paging.page?.mode === 'offset' ? '0' : '1';
  const conv = (a: Arg, v: string) => (/^int\??$/.test(a.type) ? `int.parse(${v})` : /^double\??$/.test(a.type) ? `double.parse(${v})` : v);
  const routeVals = new Map(args.filter((a) => params.includes(a.name)).map((a) => [a.name, conv(a, a.name)]));
  const call = dartPagingCall(args, paging, routeVals, { page: pg ? 'next' : undefined, search: paging.search ? 'state.query.isEmpty ? null : state.query' : undefined }, '_pageSize');
  const title = titleField(shape.model);
  const show = (v: string) => (title ? dartShow(`${v}.${camel(title)}`, fieldOf(shape.model, title)) : `${v}.toString()`);
  const strFields = paging.searchFields.map((f) => ({ name: f, nullable: fieldOf(shape.model, f)?.nullable ?? true }));
  const stateFields = [
    { decl: `final List<${item}> items;`, param: 'this.items = const []', copy: `List<${item}>? items`, set: 'items: items ?? this.items' },
    { decl: 'final bool loading;', param: 'this.loading = false', copy: 'bool? loading', set: 'loading: loading ?? this.loading' },
    ...(pg ? [{ decl: 'final bool hasMore;', param: 'this.hasMore = true', copy: 'bool? hasMore', set: 'hasMore: hasMore ?? this.hasMore' }] : []),
    { decl: 'final String? error;', param: 'this.error', copy: 'String? error, bool clearError = false', set: 'error: clearError ? null : (error ?? this.error)' },
    ...(searchable ? [{ decl: 'final String query;', param: "this.query = ''", copy: 'String? query', set: 'query: query ?? this.query' }] : []),
  ];
  let cubitText = [
    ...(paging.search ? ["import 'dart:async';", ''] : []),
    "import 'package:flutter_bloc/flutter_bloc.dart';",
    '',
    `class ${state} {`,
    `  const ${state}({${stateFields.map((f) => f.param).join(', ')}});`,
    '',
    ...stateFields.map((f) => `  ${f.decl}`),
    '',
    `  ${state} copyWith({${stateFields.map((f) => f.copy).join(', ')}}) => ${state}(`,
    ...stateFields.map((f) => `        ${f.set},`),
    '      );',
    '}',
    '',
    `class ${cubit} extends Cubit<${state}> {`,
    `  ${cubit}(this._api${params.length ? `, {${params.map((p) => `required this.${p}`).join(', ')}}` : ''}) : super(const ${state}());`,
    '',
    ...(pg && paging.size ? [`  static const _pageSize = ${PAGE_SIZE};`, ''] : []),
    `  final ${sig.repoClass} _api;`,
    ...params.map((p) => `  final String ${p};`),
    ...(pg && paging.page!.mode === 'page' ? ['  int _page = 0;'] : []),
    '  int _request = 0;',
    ...(paging.search ? ['  Timer? _debounce;'] : []),
    '',
    `  /// Loads ${pg ? 'the first page again (reset) or the next one' : 'the list'}. Only the latest request counts.`,
    `  Future<void> load(${pg ? '{bool reset = false}' : ''}) async {`,
    ...(pg ? ['    if (!reset && (state.loading || !state.hasMore)) return;'] : []),
    '    final request = ++_request;',
    '    emit(state.copyWith(loading: true, clearError: true));',
    '    try {',
    ...(pg ? [`      final next = reset ? ${first} : ${paging.page!.mode === 'offset' ? 'state.items.length' : '_page + 1'};`] : []),
    `      final rows = await _api.${ep.name}(${call});`,
    '      if (request != _request || isClosed) return;',
    ...(pg && paging.page!.mode === 'page' ? ['      _page = next;'] : []),
    pg
      ? `      emit(state.copyWith(items: reset ? rows : [...state.items, ...rows], hasMore: ${paging.size ? 'rows.length == _pageSize' : 'rows.isNotEmpty'}, loading: false));`
      : '      emit(state.copyWith(items: rows, loading: false));',
    '    } catch (e) {',
    '      if (request == _request && !isClosed) emit(state.copyWith(loading: false, error: e.toString()));',
    '    }',
    '  }',
    ...(paging.search
      ? ['', '  void search(String text) {', '    _debounce?.cancel();', '    _debounce = Timer(const Duration(milliseconds: 400), () {', '      emit(state.copyWith(query: text.trim()));', `      load(${pg ? 'reset: true' : ''});`, '    });', '  }', '', '  @override', '  Future<void> close() {', '    _debounce?.cancel();', '    return super.close();', '  }']
      : paging.clientSearch
        ? ['', '  void search(String text) => emit(state.copyWith(query: text.trim().toLowerCase()));']
        : []),
    '}',
    '',
  ].join('\n');
  cubitText = addDartImport(cubitText, importUri(n.cubitFile, ep.file, c));
  if (shape.model && shape.model.file !== ep.file) cubitText = addDartImport(cubitText, importUri(n.cubitFile, shape.model.file, c));
  const reset = pg ? 'reset: true' : '';
  const titleText = page.after!.match(/AppBar\(title: const Text\('([^']*)'\)\)/)?.[1] ?? n.base;
  const ctor = params.length ? `const ${cls}({super.key, ${params.map((p) => `required this.${p}`).join(', ')}});` : `const ${cls}({super.key});`;
  const getIt = c.di === 'get_it';
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
    '    return BlocProvider(',
    `      create: (context) => ${cubit}(${n.repoExpr}${params.length ? `, ${params.map((p) => `${p}: ${p}`).join(', ')}` : ''})..load(${reset}),`,
    '      child: Scaffold(',
    `        appBar: AppBar(title: const Text('${titleText}')),`,
    `        body: BlocBuilder<${cubit}, ${state}>(`,
    ...(searchable
      ? [
          '          builder: (context, state) => Column(',
          '            children: [',
          '              Padding(',
          '                padding: const EdgeInsets.all(12),',
          `                child: TextField(onChanged: context.read<${cubit}>().search, decoration: const InputDecoration(hintText: 'Search', prefixIcon: Icon(Icons.search), border: OutlineInputBorder())),`,
          '              ),',
          '              Expanded(child: _list(context, state)),',
          '            ],',
          '          ),',
        ]
      : ['          builder: _list,']),
    '        ),',
    '      ),',
    '    );',
    '  }',
    '',
    `  Widget _list(BuildContext context, ${state} state) {`,
    `    final shown = ${paging.clientSearch ? `state.query.isEmpty ? state.items : state.items.where((item) => ${dartSearchMatch(strFields, 'item', 'state.query', camel)}).toList()` : 'state.items'};`,
    '    final error = state.error;',
    '    if (state.items.isEmpty && state.loading) return const Center(child: CircularProgressIndicator());',
    '    if (state.items.isEmpty && error != null) {',
    '      return Center(',
    '        child: Column(',
    '          mainAxisSize: MainAxisSize.min,',
    '          children: [',
    '            Text(error, textAlign: TextAlign.center),',
    `            TextButton(onPressed: () => context.read<${cubit}>().load(${reset}), child: const Text('Retry')),`,
    '          ],',
    '        ),',
    '      );',
    '    }',
    `    if (shown.isEmpty${pg ? ' && !state.hasMore' : ''}) return Center(child: Text(${searchable ? "state.query.isEmpty ? 'No items' : 'No matches'" : "'No items'"}));`,
    '    return RefreshIndicator(',
    `      onRefresh: () => context.read<${cubit}>().load(${reset}),`,
    '      child: ListView.builder(',
    '        physics: const AlwaysScrollableScrollPhysics(),',
    `        itemCount: shown.length${pg ? ' + (state.hasMore || error != null ? 1 : 0)' : ''},`,
    '        itemBuilder: (context, index) {',
    ...(pg
      ? [
          '          if (index == shown.length) {',
          `            if (error != null) return TextButton(onPressed: () => context.read<${cubit}>().load(), child: const Text('Retry'));`,
          '            // The end of the list is on screen: ask for the next page.',
          `            if (!state.loading) WidgetsBinding.instance.addPostFrameCallback((_) => context.read<${cubit}>().load());`,
          '            return const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()));',
          '          }',
        ]
      : []),
    `          return ListTile(title: Text(${show('shown[index]')}));`,
    '        },',
    '      ),',
    '    );',
    '  }',
    '}',
    '',
  ].join('\n');
  pageText = addDartImport(pageText, importUri(page.path, n.cubitFile, c));
  if (getIt && c.diFile) pageText = addDartImport(pageText, importUri(page.path, c.diFile, c));
  pageText = addDartImport(pageText, importUri(page.path, ep.file, c));
  page.after = pageText;
  const files = new Map<string, string>(route.changes.filter((ch) => ch.after !== null).map((ch) => [ch.path, ch.after as string]));
  if (exists(join(root, n.cubitFile))) throw new ToolError('file_exists', `${n.cubitFile} already exists.`, 'Pick another screen name.');
  files.set(n.cubitFile, cubitText);
  const summary = [...route.summary, `Create ${n.cubitFile}: ${cubit} with items, loading, error${searchable ? ', query' : ''}${pg ? ' and hasMore' : ''}, calling ${sig.repoClass}.${ep.name}()`, `${page.path} lists it and ${pagingSummary(paging)}`];
  return buildChangeSet(root, 'screen add', { files, summary, warnings: [...route.warnings, ...pagingWarnings(paging)], generated: [] });
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
  const pkgText = readText(join(root, 'package.json')) ?? '';
  const major = Number(/"next"\s*:\s*"[^\d]*(\d+)/.exec(pkgText)?.[1] ?? 15);
  let pagingInfo: { summary: string; warnings: string[] } | null = null;
  if (opts.paginate || opts.search) {
    if (!shape.list) throw new ToolError('screen_not_list', `${ep.name}() returns one ${shape.raw || 'value'}, not a list; --paginate and --search are for list screens.`);
    const ps = splitTsParams(decl.params);
    const paging = detectPaging(tsPagingParams(ps), { paginate: opts.paginate, search: opts.search, modelStringFields: (shape.model?.fields ?? []).filter((f) => f.type === 'string').map((f) => f.name), titleField: tf });
    const routeArgs = new Map(ps.filter((x) => params.includes(x.name)).map((x) => [x.name, /^number$/.test(x.type) ? `Number(${x.name})` : x.name]));
    const searchable = Boolean(paging.search || paging.clientSearch);
    const offset = paging.page?.mode === 'offset';
    const urlKeys = [...(paging.paginate ? [offset ? 'offset' : 'page'] : []), ...(searchable ? ['q'] : [])];
    const sp = urlKeys.map((k) => `${k}?: string`).join('; ');
    const props = [...(params.length ? [`params: ${major >= 15 ? 'Promise<' : ''}{ ${params.map((x) => `${x}: string`).join('; ')} }${major >= 15 ? '>' : ''}`] : []), `searchParams: ${major >= 15 ? 'Promise<' : ''}{ ${sp} }${major >= 15 ? '>' : ''}`];
    const aw = major >= 15 ? 'await ' : '';
    const call = tsPagingArgs(ps, paging, routeArgs, { page: paging.paginate ? (offset ? 'offset' : 'page') : undefined, search: paging.search ? 'q || undefined' : undefined });
    const access = (v: string, f: string) => (/^[A-Za-z_$][\w$]*$/.test(f) ? `${v}.${f}` : `${v}['${f}']`);
    const more = paging.size ? 'items.length === PAGE_SIZE' : 'items.length > 0';
    const qs = (pageExpr: string) => `\`?\${new URLSearchParams({ ${searchable ? '...(q ? { q } : {}), ' : ''}${offset ? 'offset' : 'page'}: String(${pageExpr}) })}\``;
    page.after = [
      ...(paging.paginate ? [`import Link from ${q}next/link${q}${semi}`] : []),
      `import { ${ep.name} } from ${q}${from}${q}${semi}`,
      '',
      '// Rendered on each request: the data, the page and the search come from the request.',
      `export const dynamic = ${q}force-dynamic${q}${semi}`,
      ...(paging.paginate && paging.size ? [`const PAGE_SIZE = ${20}${semi}`] : []),
      '',
      `export default async function ${comp}({ ${[...(params.length ? ['params'] : []), 'searchParams'].join(', ')} }: { ${props.join('; ')} }) {`,
      ...(params.length ? [`  const { ${params.join(', ')} } = ${aw}params${semi}`] : []),
      `  const { ${[...(paging.paginate ? [`${offset ? 'offset' : 'page'}: at`] : []), ...(searchable ? [`q = ${q}${q}`] : [])].join(', ')} } = ${aw}searchParams${semi}`,
      ...(paging.paginate ? [offset ? `  const offset = Math.max(0, Number(at) || 0)${semi}` : `  const page = Math.max(1, Number(at) || 1)${semi}`] : []),
      `  const items = await ${ep.name}(${call})${semi}`,
      ...(paging.clientSearch
        ? [`  const needle = q.trim().toLowerCase()${semi}`, `  const shown = needle ? items.filter((item) => [${paging.searchFields.map((f) => access('item', f)).join(', ')}].some((v) => String(v ?? ${q}${q}).toLowerCase().includes(needle))) : items${semi}`]
        : [`  const shown = items${semi}`]),
      '  return (',
      '    <main>',
      `      <h1>${title}</h1>`,
      ...(searchable ? ['      <form role="search">', '        <input type="search" name="q" defaultValue={q} placeholder="Search" aria-label="Search" />', '        <button type="submit">Search</button>', '      </form>'] : []),
      '      {shown.length === 0 ? (',
      `        <p>${searchable ? `{q ? 'No matches.' : 'Nothing here yet.'}` : 'Nothing here yet.'}</p>`,
      '      ) : (',
      '        <ul>',
      `          {shown.map((item${idf ? '' : ', index'}) => (`,
      `            <li key={${idf ? `String(item.${idf})` : 'index'}}>{${tf ? `String(item.${tf})` : 'JSON.stringify(item)'}}</li>`,
      '          ))}',
      '        </ul>',
      '      )}',
      ...(paging.paginate
        ? [
            '      <nav aria-label="Pages">',
            offset ? `        {offset > 0 ? <Link href={${qs('0')}}>First page</Link> : null}` : `        {page > 1 ? <Link href={${qs('page - 1')}}>Previous</Link> : null}`,
            `        {${more} ? <Link href={${qs(offset ? 'offset + items.length' : 'page + 1')}}>Next</Link> : null}`,
            '      </nav>',
          ]
        : []),
      '    </main>',
      `  )${semi}`,
      '}',
      '',
    ].join('\n');
    pagingInfo = { summary: `${page.path} lists ${ep.name}() on the server and ${pagingSummary(paging, 'links')}`, warnings: pagingWarnings(paging) };
  } else page.after = [
    `import { ${ep.name} } from ${q}${from}${q}${semi}`,
    '',
    // Without route parameters Next.js would render the page once at build time,
    // calling the API then (and failing the build when it is not reachable).
    ...(params.length ? [] : ['// Rendered on each request: the data comes from the API.', `export const dynamic = ${q}force-dynamic${q}${semi}`, '']),
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
  const nextMajor = major;
  if (!pagingInfo && nextMajor < 15 && params.length) page.after = page.after.replace(`params: Promise<{`, 'params: {').replace(/ }> }\) \{/, ' } }) {').replace(`= await params${semi}`, `= params${semi}`);
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
  const summary = [...route.summary, pagingInfo?.summary ?? `${page.path} awaits ${ep.name}() on the server and renders the result`, `Create ${folder}/loading.${ext} and ${folder}/error.${ext} (loading state, and an error with retry)`];
  return buildChangeSet(root, 'screen add', { files, summary, warnings: [...route.warnings, ...(pagingInfo?.warnings ?? [])], generated: [] });
}

export async function planScreenAdd(root: string, adapter: Adapter, opts: ScreenOptions): Promise<ChangeSet> {
  const cs = await planScreenOnly(root, adapter, opts);
  if (opts.tests === false || opts.form || !opts.api) return cs;
  return withScreenTest(root, adapter, opts, cs);
}

/** Adds a test for the new screen to the change, when codz can write one for this project. */
async function withScreenTest(root: string, adapter: Adapter, opts: ScreenOptions, cs: ChangeSet): Promise<ChangeSet> {
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  const ep = map.endpoints.find((e) => e.name === opts.api) ?? map.endpoints.find((e) => e.name.toLowerCase() === opts.api!.toLowerCase());
  if (!ep) return cs;
  const files = new Map<string, string>(cs.changes.filter((ch) => ch.after !== null).map((ch) => [ch.path, ch.after as string]));
  const input = { files, ep, params: routeParams(opts.path), paged: Boolean(opts.paginate) };
  const { flutterScreenTest } = await import('./screenTests.ts');
  const t = adapter.id === 'flutter' ? flutterScreenTest(root, map, input) : null;
  if (!t) return cs;
  if ('skip' in t) return { ...cs, warnings: [...cs.warnings, `No test for this screen: ${t.skip}.`] };
  if (exists(join(root, t.file)) || files.has(t.file)) return cs;
  files.set(t.file, t.text);
  const deletes = new Set(cs.changes.filter((ch) => ch.after === null).map((ch) => ch.path));
  return buildChangeSet(root, cs.skill, { files, deletes, summary: [...cs.summary, t.summary], warnings: [...cs.warnings, ...t.warnings], generated: cs.generated, rewrites: cs.rewrites });
}

async function planScreenOnly(root: string, adapter: Adapter, opts: ScreenOptions): Promise<ChangeSet> {
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
