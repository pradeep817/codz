// Android (Jetpack Compose) screens: route add, screen add (data) and
// screen add --form.
//
//   <Name>Screen.kt        a @Composable in the screens folder
//   <Name>ViewModel.kt     data and form screens: the API interface comes in
//                          through Hilt (@HiltViewModel), Koin (viewModelOf) or
//                          the service locator (a ViewModel factory); route
//                          parameters come from SavedStateHandle
//   UiState.kt             Loading / Success / Error, written once
//   NavHost                a composable("route/{id}") { } entry
//
// A data screen shows a spinner, the error with Retry, then a LazyColumn (for
// lists) or the fields of the model. A form screen has one field per request
// property and sends it through the ViewModel.

import { join } from 'node:path';
import { packageOf } from '../adapters/android.ts';
import { addKotlinImports, kotlinName } from '../adapters/kotlinGen.ts';
import { matchBrace } from '../adapters/source.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { readText } from '../core/fsutil.ts';
import { ToolError, type ChangeSet, type Conventions, type EndpointInfo, type ModelInfo, type ProjectMap } from '../core/types.ts';
import { camel, kebab, pascal, words } from '../input/naming.ts';
import { responseShape, titleField } from './screen.ts';
import { prefillFor } from './prefill.ts';
import { planViewsRoute, planViewsScreen } from './androidViews.ts';
import { detectPaging, namedPagingArgs, PAGE_SIZE, pagingSummary, pagingWarnings, type Paging } from './paging.ts';

interface Opts {
  name: string;
  path?: string;
  api?: string;
  form?: boolean;
  load?: string;
  paginate?: boolean;
  search?: boolean;
}

interface KtParam {
  name: string;
  type: string;
  annotation: string;
  wire?: string;
  optional: boolean;
}

/** A Kotlin `fun name(...)`: its parameters and return type. */
export function kotlinFun(text: string, name: string): { params: KtParam[]; returnType: string; start: number; end: number } | null {
  const m = new RegExp(`((?:^[ \\t]*(?:/\\*\\*(?:(?!\\*/)[^])*\\*/|//[^\\n]*|@\\w+(?:\\([^\\n]*\\))?)[ \\t]*\\n)*)[ \\t]*(?:suspend\\s+)?fun\\s+${name}\\s*\\(`, 'm').exec(text);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = matchBrace(text, open, 'dart');
  if (close === -1) return null;
  const rest = text.slice(close + 1);
  const ret = /^\s*:\s*([\w<>?, .]+?)\s*(?:\n|=|\{|$)/.exec(rest);
  const lineEnd = text.indexOf('\n', close);
  const params: KtParam[] = [];
  for (const raw of text.slice(open + 1, close).split(/,(?![^<(]*[>)])/)) {
    const p = /^\s*((?:@\w+(?:\([^)]*\))?\s*)*)(\w+|`\w+`)\s*:\s*([\w<>?, .]+?)\s*(=.*)?$/.exec(raw.replace(/\s+/g, ' '));
    if (!p) continue;
    const ann = /@(\w+)(?:\(\s*"([^"]*)"\s*\))?/.exec(p[1]);
    params.push({ name: p[2], type: p[3].trim(), annotation: ann?.[1] ?? '', wire: ann?.[2], optional: !!p[4] || p[3].trim().endsWith('?') });
  }
  return { params, returnType: ret?.[1]?.trim() ?? 'Unit', start: m.index, end: lineEnd === -1 ? text.length : lineEnd };
}

export function names(name: string) {
  const base = pascal(name.replace(/[-_ ]?screen$/i, ''));
  return { base, screen: `${base}Screen`, vm: `${base}ViewModel`, title: words(base).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') };
}

/** "/products/:id" → { route: "products/{id}", params: ["id"] } */
export function routeOf(name: string, path?: string): { route: string; params: string[] } {
  const segs = (path ?? `/${kebab(name.replace(/[-_ ]?screen$/i, ''))}`).split('/').filter(Boolean).map((s) => s.replace(/^:([\w-]+)$/, '{$1}').replace(/^\[([\w-]+)\]$/, '{$1}'));
  const route = segs.map((s) => s.replace(/^\{([\w-]+)\}$/, (_m, p: string) => `{${camel(p)}}`)).join('/');
  return { route, params: [...route.matchAll(/\{(\w+)\}/g)].map((x) => x[1]) };
}

export const fileOf = (dir: string, cls: string) => `${dir}/${cls}.kt`;
export const dirOf = (f: string) => f.slice(0, f.lastIndexOf('/'));
export const classOfFile = (srcDir: string, f: string) => `${packageOf(srcDir, dirOf(f))}.${f.slice(f.lastIndexOf('/') + 1, -3)}`;

export interface Ctx {
  root: string;
  map: ProjectMap;
  c: Conventions;
  srcDir: string;
  files: Map<string, string>;
  summary: string[];
  warnings: string[];
  read: (p: string) => string | null;
}

export function context(root: string, map: ProjectMap, ui: 'compose' | 'views' = 'compose'): Ctx {
  const c = map.conventions;
  if (ui === 'compose' && c.ui !== 'compose') throw new ToolError('not_supported', 'screen add and route add write Jetpack Compose screens, and this project uses Views.', 'Set ui: compose in codz.config.yaml if the app uses Compose.');
  if (!c.namespace) throw new ToolError('no_package', 'No namespace was found in the app build file.', 'Set namespace in codz.config.yaml.');
  const files = new Map<string, string>();
  return { root, map, c, srcDir: c.srcDir || 'app/src/main/java', files, summary: [], warnings: [], read: (p) => files.get(p) ?? readText(join(root, p)) };
}

/** Adds composable("route") { ... } to the NavHost. */
function registerRoute(x: Ctx, route: string, call: string, screenClass: string, params: string[], withArgs: boolean): void {
  const nav = x.c.navFile;
  const text = nav ? x.read(nav) : null;
  if (!nav || text === null) {
    x.warnings.push(`No NavHost was found, so the screen is not registered. Add composable("${route}") { ${call} } to your NavHost (or set navFile in codz.config.yaml).`);
    return;
  }
  if (new RegExp(`composable\\(\\s*(?:route\\s*=\\s*)?"${route.replace(/[{}]/g, '\\$&')}"`).test(text)) throw new ToolError('route_exists', `${nav} already has a route "${route}".`);
  const host = /\bNavHost\s*\(/.exec(text)!;
  const argsClose = matchBrace(text, host.index + host[0].length - 1, 'dart');
  const lambda = text.indexOf('{', argsClose);
  const close = matchBrace(text, lambda, 'dart');
  const indent = /\n([ \t]*)[^\n]*$/.exec(text.slice(0, close))?.[1] ?? '    ';
  const inner = `${indent}    `;
  const entry = withArgs && params.length ? `${inner}composable("${route}") { entry ->\n${inner}    ${call}\n${inner}}` : `${inner}composable("${route}") {\n${inner}    ${call}\n${inner}}`;
  const before = text.slice(0, close).replace(/\s*$/, '');
  let t = `${before}\n${entry}\n${indent}${text.slice(close)}`;
  t = addKotlinImports(t, [screenClass], /^package\s+([\w.]+)/m.exec(t)?.[1] ?? '');
  x.files.set(nav, t);
  x.summary.push(`Update ${nav}: composable("${route}")`);
}

function navHint(route: string, params: string[]): string {
  return `Open it with: navController.navigate("${route.replace(/\{(\w+)\}/g, '$$$1')}")${params.length ? '' : ''}`;
}

export function finish(x: Ctx, skill: string, hint: string): ChangeSet {
  x.summary.push(hint);
  return buildChangeSet(x.root, skill, { files: x.files, summary: x.summary, warnings: x.warnings, generated: [] });
}

export function planAndroidRoute(root: string, map: ProjectMap, opts: Opts): ChangeSet {
  if (map.conventions.ui === 'views') return planViewsRoute(root, map, opts);
  const x = context(root, map);
  const n = names(opts.name);
  const { route, params } = routeOf(opts.name, opts.path);
  const file = fileOf(x.c.screensFolder || `${x.srcDir}/${x.c.namespace!.replace(/\./g, '/')}/ui/screens`, n.screen);
  if (x.read(file) !== null) throw new ToolError('route_exists', `${file} already exists.`);
  const pkg = packageOf(x.srcDir, dirOf(file));
  const sig = params.map((p) => `${p}: String`).join(', ');
  x.files.set(
    file,
    [
      `package ${pkg}`,
      '',
      'import androidx.compose.foundation.layout.Column',
      'import androidx.compose.foundation.layout.fillMaxSize',
      'import androidx.compose.foundation.layout.padding',
      'import androidx.compose.material3.MaterialTheme',
      'import androidx.compose.material3.Scaffold',
      'import androidx.compose.material3.Text',
      'import androidx.compose.runtime.Composable',
      'import androidx.compose.ui.Modifier',
      'import androidx.compose.ui.unit.dp',
      '',
      '@Composable',
      `fun ${n.screen}(${sig}) {`,
      '    Scaffold { padding ->',
      '        Column(Modifier.fillMaxSize().padding(padding).padding(16.dp)) {',
      `            Text("${n.title}", style = MaterialTheme.typography.headlineSmall)`,
      ...params.map((p) => `            Text("${p}: $${p}")`),
      '        }',
      '    }',
      '}',
      '',
    ].join('\n'),
  );
  x.summary.push(`Create ${file}: ${n.screen}`);
  const call = `${n.screen}(${params.map((p) => `${p} = entry.arguments?.getString("${p}").orEmpty()`).join(', ')})`;
  registerRoute(x, route, call, `${pkg}.${n.screen}`, params, true);
  return finish(x, 'route add', navHint(route, params));
}

export interface ApiRef {
  ep: EndpointInfo;
  iface: string;
  ifaceClass: string;
  params: KtParam[];
  returnType: string;
}

export function apiRef(x: Ctx, name: string): ApiRef {
  const ep = x.map.endpoints.find((e) => e.name === name) ?? x.map.endpoints.find((e) => e.name.toLowerCase() === name.toLowerCase());
  if (!ep) throw new ToolError('no_endpoint', `No endpoint called ${name} was found.`, x.map.endpoints.length ? `Endpoints: ${x.map.endpoints.map((e) => e.name).join(', ')}` : 'Add one with codz api add.');
  const text = x.read(ep.file) ?? '';
  const iface = /\binterface\s+(\w+)/.exec(text)?.[1];
  const fun = kotlinFun(text, ep.name);
  if (!iface || !fun) throw new ToolError('no_endpoint', `Could not read ${ep.name} in ${ep.file}.`);
  return { ep, iface, ifaceClass: `${packageOf(x.srcDir, dirOf(ep.file))}.${iface}`, params: fun.params, returnType: fun.returnType };
}

export interface Injection {
  header: string[];
  imports: string[];
  companion: string[];
  screenDefault: string;
  screenImports: string[];
  /** Views: how an Activity gets the ViewModel. */
  activity: { annotations: string[]; delegate: string; imports: string[] };
}

/** How the ViewModel gets the API interface, per DI style. */
export function injection(x: Ctx, a: ApiRef, vm: string, vmPkg: string, needsHandle: boolean): Injection {
  const api = `private val api: ${a.iface}`;
  const handle = needsHandle ? ', savedStateHandle: SavedStateHandle' : '';
  const handleImports = needsHandle ? ['androidx.lifecycle.SavedStateHandle'] : [];
  const di = x.c.di;
  if (di === 'hilt') {
    return {
      header: ['@HiltViewModel', `class ${vm} @Inject constructor(${api}${handle}) : ViewModel() {`],
      imports: ['dagger.hilt.android.lifecycle.HiltViewModel', 'javax.inject.Inject', ...handleImports],
      companion: [],
      screenDefault: 'hiltViewModel()',
      screenImports: ['androidx.hilt.navigation.compose.hiltViewModel'],
      activity: { annotations: ['@AndroidEntryPoint'], delegate: 'by viewModels()', imports: ['dagger.hilt.android.AndroidEntryPoint', 'androidx.activity.viewModels'] },
    };
  }
  if (di === 'koin') {
    registerKoinViewModel(x, vm, `${vmPkg}.${vm}`);
    return { header: [`class ${vm}(${api}${handle}) : ViewModel() {`], imports: handleImports, companion: [], screenDefault: 'koinViewModel()', screenImports: ['org.koin.androidx.compose.koinViewModel'], activity: { annotations: [], delegate: 'by viewModel()', imports: ['org.koin.androidx.viewmodel.ext.android.viewModel'] } };
  }
  if (di === 'manual') {
    const locatorText = x.c.diFile ? x.read(x.c.diFile) : null;
    const locator = locatorText ? /\bobject\s+(\w+)/.exec(locatorText)?.[1] : undefined;
    const prop = locatorText ? new RegExp(`\\bval\\s+(\\w+)\\s*:\\s*${a.iface}\\b`).exec(locatorText)?.[1] : undefined;
    if (!locator || !prop) throw new ToolError('not_supported', `${a.iface} is not in the service locator${x.c.diFile ? ` (${x.c.diFile})` : ''}, so the ViewModel cannot get it.`, `Add val ${a.iface[0].toLowerCase()}${a.iface.slice(1)}: ${a.iface} by lazy { retrofit.create(${a.iface}::class.java) } to it.`);
    return {
      header: [`class ${vm}(${api}${handle}) : ViewModel() {`],
      imports: [...handleImports, 'androidx.lifecycle.ViewModelProvider', 'androidx.lifecycle.viewmodel.initializer', 'androidx.lifecycle.viewmodel.viewModelFactory', ...(needsHandle ? ['androidx.lifecycle.createSavedStateHandle'] : []), classOfFile(x.srcDir, x.c.diFile!)],
      companion: ['', '    companion object {', `        val Factory: ViewModelProvider.Factory = viewModelFactory {`, `            initializer { ${vm}(${locator}.${prop}${needsHandle ? ', createSavedStateHandle()' : ''}) }`, '        }', '    }'],
      screenDefault: `viewModel(factory = ${vm}.Factory)`,
      screenImports: ['androidx.lifecycle.viewmodel.compose.viewModel'],
      activity: { annotations: [], delegate: `by viewModels { ${vm}.Factory }`, imports: ['androidx.activity.viewModels'] },
    };
  }
  throw new ToolError('not_supported', `screen add needs a way to get ${a.iface} into a ViewModel (Hilt, Koin or a service locator); this project registers it with "${di || 'nothing'}".`, `Use codz route add ${x.map.endpoints[0]?.name ? '<name>' : ''} for a screen without data.`);
}

function registerKoinViewModel(x: Ctx, vm: string, vmClass: string): void {
  const di = x.c.diFile;
  const text = di ? x.read(di) : null;
  if (!di || text === null) return void x.warnings.push(`No Koin module was found; add viewModelOf(::${vm}) to one.`);
  if (new RegExp(`::${vm}\\b`).test(text)) return;
  const m = /\bmodule\s*\{/.exec(text);
  if (!m) return void x.warnings.push(`Could not find module { } in ${di}; add viewModelOf(::${vm}).`);
  const close = matchBrace(text, m.index + m[0].length - 1, 'dart');
  let t = `${text.slice(0, close).replace(/\s*$/, '')}\n    viewModelOf(::${vm})\n${text.slice(close)}`;
  t = addKotlinImports(t, ['org.koin.core.module.dsl.viewModelOf', vmClass], /^package\s+([\w.]+)/m.exec(t)?.[1] ?? '');
  x.files.set(di, t);
  x.summary.push(`Update ${di}: viewModelOf(::${vm})`);
}

/** ui/UiState.kt, shared by every screen codz writes. */
export function ensureUiState(x: Ctx, screensDir: string): string {
  const uiDir = dirOf(screensDir);
  const file = `${uiDir}/UiState.kt`;
  const pkg = packageOf(x.srcDir, uiDir);
  if (x.read(file) === null) {
    x.files.set(file, `package ${pkg}\n\n/** What a screen shows while it loads data, when it has it, and when loading failed. */\nsealed interface UiState<out T> {\n    data object Loading : UiState<Nothing>\n\n    data class Success<T>(val data: T) : UiState<T>\n\n    data class Error(val message: String) : UiState<Nothing>\n}\n`);
    x.summary.push(`Create ${file}: UiState (Loading, Success, Error)`);
  }
  return `${pkg}.UiState`;
}

export const access = (v: string, jsonName: string) => `${v}.${kotlinName(jsonName)}`;

export function planAndroidScreen(root: string, map: ProjectMap, opts: Opts): ChangeSet {
  if (map.conventions.ui === 'views') return planViewsScreen(root, map, opts);
  if (!opts.api) return planAndroidRoute(root, map, opts);
  const x = context(root, map);
  const a = apiRef(x, opts.api);
  if (opts.form) return planAndroidForm(x, opts, a);
  if (a.ep.method !== 'GET') throw new ToolError('screen_needs_get', `${a.ep.name} is a ${a.ep.method} endpoint; a screen loads data with a GET.`, 'For a form that sends it, add --form.');
  const n = names(opts.name);
  const { route, params } = routeOf(opts.name, opts.path);
  const required = a.params.filter((p) => !p.optional && p.annotation !== 'Body');
  const missing = required.filter((p) => !params.includes(p.name.replace(/`/g, '')));
  if (missing.length) throw new ToolError('screen_args', `${a.ep.name}() needs ${missing.map((p) => p.name).join(', ')}, which the screen does not have.`, `Give the route a matching parameter, for example: --path /${kebab(n.base)}/:${missing[0].name}`);
  const screensDir = x.c.screensFolder || `${x.srcDir}/${x.c.namespace!.replace(/\./g, '/')}/ui/screens`;
  const screenFile = fileOf(screensDir, n.screen);
  const vmFile = fileOf(screensDir, n.vm);
  for (const f of [screenFile, vmFile]) if (x.read(f) !== null) throw new ToolError('route_exists', `${f} already exists.`);
  const pkg = packageOf(x.srcDir, screensDir);
  const T = a.returnType;
  const shape = responseShape(T, map);
  const model: ModelInfo | undefined = shape.model;
  const modelImports = model ? [classOfFile(x.srcDir, model.file)] : [];
  const needsHandle = params.length > 0;
  const inj = injection(x, a, n.vm, pkg, needsHandle);
  const args = required.map((p) => {
    const v = p.name.replace(/`/g, '');
    return /^(Int|Long)$/.test(p.type) ? `${v}.to${p.type}()` : v;
  });

  if (opts.paginate || opts.search) {
    const paging = androidPaging(a, shape, opts, T);
    const item = /^List<(.+)>\??$/.exec(T)?.[1] ?? 'Any';
    const routeNamed = required.map((p, i) => `${p.name} = ${args[i]}`);
    x.files.set(vmFile, pagedViewModel(x, a, n.vm, pkg, params, routeNamed, inj, item, paging, modelImports));
    x.summary.push(`Create ${vmFile}: ${n.vm} with items, loading, error${paging.search || paging.clientSearch ? ', query' : ''}${paging.paginate ? ', hasMore' : ''}, calling ${a.iface}.${a.ep.name}()`);
    const tf = titleField(model);
    const searchable = Boolean(paging.search || paging.clientSearch);
    const pg = paging.paginate;
    const reset = pg ? 'reset = true' : '';
    const stringFields = paging.searchFields.map((f) => (model?.fields.find((m) => m.name === f)?.nullable ? `${access('item', f)}.orEmpty()` : access('item', f)));
    const screen = [
      `package ${pkg}`,
      '',
      '@Composable',
      `fun ${n.screen}(viewModel: ${n.vm} = ${inj.screenDefault}) {`,
      '    val s by viewModel.state.collectAsState()',
      ...(pg
        ? [
            '    val listState = rememberLazyListState()',
            '    // Near the end of the list: ask for the next page.',
            '    val nearEnd by remember {',
            '        derivedStateOf {',
            '            val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0',
            '            last >= listState.layoutInfo.totalItemsCount - 3',
            '        }',
            '    }',
            '    LaunchedEffect(nearEnd, s.items.size) {',
            '        if (nearEnd) viewModel.load()',
            '    }',
          ]
        : []),
      `    val shown = ${paging.clientSearch ? `if (s.query.isBlank()) s.items else s.items.filter { item -> listOf(${stringFields.join(', ')}).any { it.contains(s.query.trim(), ignoreCase = true) } }` : 's.items'}`,
      '    val error = s.error',
      '    Scaffold { padding ->',
      '        Column(Modifier.fillMaxSize().padding(padding)) {',
      ...(searchable ? ['            OutlinedTextField(', '                value = s.query,', '                onValueChange = viewModel::search,', '                placeholder = { Text("Search") },', '                singleLine = true,', '                modifier = Modifier.fillMaxWidth().padding(12.dp),', '            )'] : []),
      '            Box(Modifier.fillMaxSize()) {',
      '                when {',
      '                    s.items.isEmpty() && s.loading -> CircularProgressIndicator(Modifier.align(Alignment.Center))',
      '                    s.items.isEmpty() && error != null -> Column(Modifier.align(Alignment.Center).padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {',
      '                        Text(error, color = MaterialTheme.colorScheme.error)',
      `                        Button(onClick = { viewModel.load(${reset}) }) { Text("Retry") }`,
      '                    }',
      `                    shown.isEmpty() && !s.loading -> Text(${searchable ? 'if (s.query.isBlank()) "Nothing here yet." else "No matches."' : '"Nothing here yet."'}, Modifier.align(Alignment.Center))`,
      `                    else -> LazyColumn(Modifier.fillMaxSize()${pg ? ', state = listState' : ''}) {`,
      '                        items(shown) { item ->',
      `                            Text(${tf ? `${access('item', tf)}.toString()` : 'item.toString()'}, Modifier.fillMaxWidth().padding(16.dp))`,
      '                            HorizontalDivider()',
      '                        }',
      ...(pg
        ? [
            '                        if (s.loading) {',
            '                            item { Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() } }',
            '                        } else if (error != null) {',
            '                            item { TextButton(onClick = { viewModel.load() }, modifier = Modifier.fillMaxWidth()) { Text("Retry") } }',
            '                        }',
          ]
        : []),
      '                    }',
      '                }',
      '            }',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n');
    const composeImports = [
      'androidx.compose.foundation.layout.Box',
      'androidx.compose.foundation.layout.Column',
      'androidx.compose.foundation.layout.fillMaxSize',
      'androidx.compose.foundation.layout.fillMaxWidth',
      'androidx.compose.foundation.layout.padding',
      'androidx.compose.foundation.lazy.LazyColumn',
      'androidx.compose.foundation.lazy.items',
      'androidx.compose.material3.Button',
      'androidx.compose.material3.CircularProgressIndicator',
      'androidx.compose.material3.HorizontalDivider',
      'androidx.compose.material3.MaterialTheme',
      'androidx.compose.material3.Scaffold',
      'androidx.compose.material3.Text',
      'androidx.compose.runtime.Composable',
      'androidx.compose.runtime.collectAsState',
      'androidx.compose.runtime.getValue',
      'androidx.compose.ui.Alignment',
      'androidx.compose.ui.Modifier',
      'androidx.compose.ui.unit.dp',
      ...(searchable ? ['androidx.compose.material3.OutlinedTextField'] : []),
      ...(pg ? ['androidx.compose.foundation.lazy.rememberLazyListState', 'androidx.compose.material3.TextButton', 'androidx.compose.runtime.LaunchedEffect', 'androidx.compose.runtime.derivedStateOf', 'androidx.compose.runtime.remember'] : []),
    ];
    x.files.set(screenFile, addKotlinImports(screen, [...composeImports, ...inj.screenImports], pkg));
    x.summary.push(`Create ${screenFile}: ${n.screen} lists them and ${pagingSummary(paging)}`);
    x.warnings.push(...pagingWarnings(paging));
    registerRoute(x, route, `${n.screen}()`, `${pkg}.${n.screen}`, params, false);
    return finish(x, 'screen add', navHint(route, params));
  }

  const uiState = ensureUiState(x, screensDir);
  // ViewModel.
  x.files.set(vmFile, dataViewModel(x, a, n.vm, pkg, params, args, inj, uiState, T, modelImports));
  x.summary.push(`Create ${vmFile}: ${n.vm} loads ${a.iface}.${a.ep.name}()${params.length ? ` with ${params.join(', ')} from the route` : ''}`);

  // Screen.
  const tf = titleField(model);
  const success = shape.list
    ? [
        '                is UiState.Success -> if (s.data.isEmpty()) {',
        '                    Text("Nothing here yet.", Modifier.align(Alignment.Center))',
        '                } else {',
        '                    LazyColumn(Modifier.fillMaxSize()) {',
        '                        items(s.data) { item ->',
        `                            Text(${tf ? `${access('item', tf)}.toString()` : 'item.toString()'}, Modifier.fillMaxWidth().padding(16.dp))`,
        '                            HorizontalDivider()',
        '                        }',
        '                    }',
        '                }',
      ]
    : [
        '                is UiState.Success -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {',
        ...(model?.fields.length
          ? model.fields.flatMap((f) => [`                    Text("${f.name}", style = MaterialTheme.typography.labelMedium)`, `                    Text(${access('s.data', f.name)}?.toString().orEmpty(), Modifier.padding(bottom = 12.dp))`])
          : ['                    Text(s.data.toString())']),
        '                }',
      ];
  const screen = [
    `package ${pkg}`,
    '',
    '@Composable',
    `fun ${n.screen}(viewModel: ${n.vm} = ${inj.screenDefault}) {`,
    '    val state by viewModel.state.collectAsState()',
    '    Scaffold { padding ->',
    '        Box(Modifier.fillMaxSize().padding(padding)) {',
    '            when (val s = state) {',
    '                is UiState.Loading -> CircularProgressIndicator(Modifier.align(Alignment.Center))',
    '                is UiState.Error -> Column(Modifier.align(Alignment.Center).padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {',
    '                    Text(s.message, color = MaterialTheme.colorScheme.error)',
    '                    Button(onClick = viewModel::load) { Text("Retry") }',
    '                }',
    ...success,
    '            }',
    '        }',
    '    }',
    '}',
    '',
  ].join('\n');
  const composeImports = [
    'androidx.compose.foundation.layout.Box',
    'androidx.compose.foundation.layout.Column',
    'androidx.compose.foundation.layout.fillMaxSize',
    'androidx.compose.foundation.layout.padding',
    'androidx.compose.material3.Button',
    'androidx.compose.material3.CircularProgressIndicator',
    'androidx.compose.material3.MaterialTheme',
    'androidx.compose.material3.Scaffold',
    'androidx.compose.material3.Text',
    'androidx.compose.runtime.Composable',
    'androidx.compose.runtime.collectAsState',
    'androidx.compose.runtime.getValue',
    'androidx.compose.ui.Alignment',
    'androidx.compose.ui.Modifier',
    'androidx.compose.ui.unit.dp',
    ...(shape.list ? ['androidx.compose.foundation.layout.fillMaxWidth', 'androidx.compose.foundation.lazy.LazyColumn', 'androidx.compose.foundation.lazy.items', 'androidx.compose.material3.HorizontalDivider'] : ['androidx.compose.foundation.rememberScrollState', 'androidx.compose.foundation.verticalScroll']),
  ];
  x.files.set(screenFile, addKotlinImports(screen, [...composeImports, uiState, ...inj.screenImports], pkg));
  x.summary.push(`Create ${screenFile}: ${n.screen} (loading, error with Retry, ${shape.list ? 'LazyColumn' : 'details'})`);
  registerRoute(x, route, `${n.screen}()`, `${pkg}.${n.screen}`, params, false);
  return finish(x, 'screen add', navHint(route, params));
}

function planAndroidForm(x: Ctx, opts: Opts, a: ApiRef): ChangeSet {
  if (!['POST', 'PUT', 'PATCH'].includes(a.ep.method)) throw new ToolError('form_needs_body', `${a.ep.name} is a ${a.ep.method} endpoint; a form sends a request body (POST, PUT or PATCH).`);
  const body = a.params.find((p) => p.annotation === 'Body');
  if (!body) throw new ToolError('form_needs_body', `${a.ep.name}() takes no @Body, so there is nothing for a form to send.`);
  const bodyModel = x.map.models.find((m) => m.name === body.type.replace(/\?$/, ''));
  if (!bodyModel) throw new ToolError('form_needs_body', `The request type ${body.type} was not found among the data classes.`);
  const n = names(opts.name);
  const { route, params } = routeOf(opts.name, opts.path);
  const required = a.params.filter((p) => !p.optional && p.annotation !== 'Body');
  const missing = required.filter((p) => !params.includes(p.name.replace(/`/g, '')));
  if (missing.length) throw new ToolError('screen_args', `${a.ep.name}() needs ${missing.map((p) => p.name).join(', ')}, which the screen does not have.`, `Give the route a matching parameter, for example: --path /${kebab(n.base)}/:${missing[0].name}`);
  const screensDir = x.c.screensFolder || `${x.srcDir}/${x.c.namespace!.replace(/\./g, '/')}/ui/screens`;
  const screenFile = fileOf(screensDir, n.screen);
  const vmFile = fileOf(screensDir, n.vm);
  for (const f of [screenFile, vmFile]) if (x.read(f) !== null) throw new ToolError('route_exists', `${f} already exists.`);
  const pkg = packageOf(x.srcDir, screensDir);
  const uiState = ensureUiState(x, screensDir);
  const R = a.returnType;
  const inj = injection(x, a, n.vm, pkg, params.length > 0);
  const args = [...required.map((p) => (/^(Int|Long)$/.test(p.type) ? `${p.name}.to${p.type}()` : p.name)), 'body'];
  const bodyClass = classOfFile(x.srcDir, bodyModel.file);
  const result = responseShape(R, x.map).model;
  const prefill = androidPrefill(x, a, opts.load, bodyModel.fields.map((f) => f.name), params);
  x.files.set(vmFile, formViewModel(x, a, n.vm, pkg, params, args, inj, uiState, R, bodyModel.name, bodyClass, result ? [classOfFile(x.srcDir, result.file)] : [], prefill));
  x.summary.push(`Create ${vmFile}: ${n.vm}.submit() sends ${a.iface}.${a.ep.name}()${prefill ? `; the form starts with ${prefill.call.replace(/^api\./, `${a.iface}.`)}` : ''}`);

  // One state variable and one input per field.
  const fields = bodyModel.fields.map((f) => {
    const v = kotlinName(f.name).replace(/`/g, '');
    const t = f.type.replace(/\?$/, '');
    return { json: f.name, prop: kotlinName(f.name), v, t, nullable: f.nullable, bool: t === 'Boolean', num: /^(Int|Long|Double|Float)$/.test(t), text: t === 'String' };
  });
  const unsupported = fields.filter((f) => !f.bool && !f.num && !f.text);
  if (unsupported.length) x.warnings.push(`The form has no input for ${unsupported.map((f) => `${f.json} (${f.t})`).join(', ')}; ${unsupported.some((f) => !f.nullable) ? 'fill them in where the body is built' : 'they are sent as null'}.`);
  const stateLines = fields.filter((f) => f.bool || f.num || f.text).map((f) => `    var ${f.v} by remember { mutableStateOf(${f.bool ? 'false' : '""'}) }`);
  const value = (f: (typeof fields)[number]) => {
    if (f.bool || f.text) return f.text && f.nullable ? `${f.v}.ifBlank { null }` : f.v;
    if (f.num) return `${f.v}.to${f.t}OrNull()${f.nullable ? '' : ` ?: 0${f.t === 'Double' ? '.0' : f.t === 'Float' ? 'f' : f.t === 'Long' ? 'L' : ''}`}`;
    return f.nullable ? 'null' : `TODO("${f.json}")`;
  };
  const inputs = fields.flatMap((f) => {
    if (f.bool) return [`            Row(verticalAlignment = Alignment.CenterVertically) {`, `                Switch(checked = ${f.v}, onCheckedChange = { ${f.v} = it })`, `                Text("${f.json}", Modifier.padding(start = 8.dp))`, '            }'];
    if (f.num) return [`            OutlinedTextField(${f.v}, { ${f.v} = it }, label = { Text("${f.json}") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())`];
    if (f.text) return [`            OutlinedTextField(${f.v}, { ${f.v} = it }, label = { Text("${f.json}") }, modifier = Modifier.fillMaxWidth())`];
    return [];
  });
  const screen = [
    `package ${pkg}`,
    '',
    '@Composable',
    `fun ${n.screen}(viewModel: ${n.vm} = ${inj.screenDefault}, onDone: () -> Unit = {}) {`,
    '    val state by viewModel.state.collectAsState()',
    ...stateLines,
    ...(prefill
      ? [
          '    val initial by viewModel.initial.collectAsState()',
          '    LaunchedEffect(initial) {',
          '        initial?.let {',
          ...fields
            .filter((f) => (f.bool || f.num || f.text) && prefill.shared.has(f.json) && prefill.model.fields.find((m) => m.name === f.json)!.type.replace(/\?$/, '') === f.t)
            .map((f) => `            ${f.v} = ${ktInitial(f.bool ? 'bool' : f.num ? 'num' : 'text', `it.${kotlinName(f.json)}`, prefill.model.fields.find((m) => m.name === f.json)!.nullable)}`),
          '        }',
          '    }',
        ]
      : []),
    '    LaunchedEffect(state) {',
    '        if (state is UiState.Success) onDone()',
    '    }',
    '    Scaffold { padding ->',
    '        Column(',
    '            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),',
    '            verticalArrangement = Arrangement.spacedBy(12.dp),',
    '        ) {',
    `            Text("${n.title}", style = MaterialTheme.typography.headlineSmall)`,
    ...inputs,
    '            (state as? UiState.Error)?.let { Text(it.message, color = MaterialTheme.colorScheme.error) }',
    '            Button(',
    '                onClick = {',
    '                    viewModel.submit(',
    `                        ${bodyModel.name}(`,
    ...fields.map((f) => `                            ${f.prop} = ${value(f)},`),
    '                        ),',
    '                    )',
    '                },',
    '                enabled = state !is UiState.Loading,',
    '                modifier = Modifier.fillMaxWidth(),',
    '            ) {',
    '                if (state is UiState.Loading) CircularProgressIndicator(Modifier.size(18.dp)) else Text("Save")',
    '            }',
    '        }',
    '    }',
    '}',
    '',
  ].join('\n');
  const imports = [
    'androidx.compose.foundation.layout.Arrangement',
    'androidx.compose.foundation.layout.Column',
    'androidx.compose.foundation.layout.fillMaxSize',
    'androidx.compose.foundation.layout.fillMaxWidth',
    'androidx.compose.foundation.layout.padding',
    'androidx.compose.foundation.layout.size',
    'androidx.compose.foundation.rememberScrollState',
    'androidx.compose.foundation.verticalScroll',
    'androidx.compose.material3.Button',
    'androidx.compose.material3.CircularProgressIndicator',
    'androidx.compose.material3.MaterialTheme',
    'androidx.compose.material3.Scaffold',
    'androidx.compose.material3.Text',
    'androidx.compose.runtime.Composable',
    'androidx.compose.runtime.LaunchedEffect',
    'androidx.compose.runtime.collectAsState',
    'androidx.compose.runtime.getValue',
    'androidx.compose.ui.Modifier',
    'androidx.compose.ui.unit.dp',
    ...(stateLines.length ? ['androidx.compose.runtime.mutableStateOf', 'androidx.compose.runtime.remember', 'androidx.compose.runtime.setValue'] : []),
    ...(fields.some((f) => f.num || f.text) ? ['androidx.compose.material3.OutlinedTextField'] : []),
    ...(fields.some((f) => f.num) ? ['androidx.compose.foundation.text.KeyboardOptions', 'androidx.compose.ui.text.input.KeyboardType'] : []),
    ...(fields.some((f) => f.bool) ? ['androidx.compose.foundation.layout.Row', 'androidx.compose.material3.Switch', 'androidx.compose.ui.Alignment'] : []),
    uiState,
    bodyClass,
    ...inj.screenImports,
  ];
  x.files.set(screenFile, addKotlinImports(screen, imports, pkg));
  x.summary.push(`Create ${screenFile}: ${n.screen} with ${fields.length} field${fields.length === 1 ? '' : 's'} for ${bodyModel.name}`);
  registerRoute(x, route, `${n.screen}()`, `${pkg}.${n.screen}`, params, false);
  return finish(x, 'screen add', navHint(route, params));
}

/** Paging for a Kotlin list endpoint. */
export function androidPaging(a: ApiRef, shape: ReturnType<typeof responseShape>, opts: Opts, T: string): Paging {
  if (!shape.list) throw new ToolError('screen_not_list', `${a.ep.name}() returns ${T}, not a list; --paginate and --search are for list screens.`);
  return detectPaging(a.params.filter((p) => p.annotation !== 'Body').map((p) => ({ name: p.name.replace(/`/g, ''), type: p.type })), { paginate: opts.paginate, search: opts.search, modelStringFields: (shape.model?.fields ?? []).filter((f) => f.type === 'String').map((f) => f.name), titleField: titleField(shape.model) });
}

/** The ViewModel of a paged or searchable list (Compose and Views share it): one state, and load() / search(). A new search or refresh cancels the request still running. */
export function pagedViewModel(x: Ctx, a: ApiRef, vmName: string, pkg: string, params: string[], routeNamed: string[], inj: Injection, item: string, p: Paging, modelImports: string[]): string {
  const stateName = `${vmName.replace(/ViewModel$/, '')}ListState`;
  const searchable = Boolean(p.search || p.clientSearch);
  const pg = p.paginate;
  const first = p.page?.mode === 'offset' ? '0' : '1';
  const call = [...routeNamed, ...namedPagingArgs(p, { page: pg ? 'next' : undefined, search: p.search ? '_state.value.query.trim().ifBlank { null }' : undefined }, ' = ', 'PAGE_SIZE')].join(', ');
  const vm = [
    `package ${pkg}`,
    '',
    ...(pg && p.size ? [`private const val PAGE_SIZE = ${PAGE_SIZE}`, ''] : []),
    `data class ${stateName}(`,
    `    val items: List<${item}> = emptyList(),`,
    '    val loading: Boolean = false,',
    '    val error: String? = null,',
    ...(pg ? ['    val hasMore: Boolean = true,'] : []),
    ...(searchable ? ['    val query: String = "",'] : []),
    ')',
    '',
    ...inj.header,
    ...params.map((x) => `    private val ${x}: String = checkNotNull(savedStateHandle["${x}"])`),
    ...(params.length ? [''] : []),
    `    private val _state = MutableStateFlow(${stateName}())`,
    `    val state: StateFlow<${stateName}> = _state.asStateFlow()`,
    ...(pg && p.page!.mode === 'page' ? ['    private var page = 0'] : []),
    '    private var job: Job? = null',
    ...(p.search ? ['    private var searchJob: Job? = null'] : []),
    '',
    '    init {',
    `        load(${pg ? 'reset = true' : ''})`,
    '    }',
    '',
    `    /** Loads ${pg ? 'the first page again (reset) or the next one' : 'the list'}. */`,
    `    fun load(${pg ? 'reset: Boolean = false' : ''}) {`,
    ...(pg ? ['        val now = _state.value', '        if (!reset && (now.loading || !now.hasMore)) return'] : []),
    '        job?.cancel()',
    '        job = viewModelScope.launch {',
    '            _state.update { it.copy(loading = true, error = null) }',
    '            try {',
    ...(pg ? [`                val next = if (reset) ${first} else ${p.page!.mode === 'offset' ? '_state.value.items.size' : 'page + 1'}`] : []),
    `                val rows = api.${a.ep.name}(${call})`,
    ...(pg && p.page!.mode === 'page' ? ['                page = next'] : []),
    pg
      ? `                _state.update { it.copy(items = if (reset) rows else it.items + rows, hasMore = ${p.size ? 'rows.size == PAGE_SIZE' : 'rows.isNotEmpty()'}, loading = false) }`
      : '                _state.update { it.copy(items = rows, loading = false) }',
    '            } catch (e: CancellationException) {',
    '                throw e',
    '            } catch (e: Exception) {',
    '                _state.update { it.copy(loading = false, error = e.message ?: "Something went wrong") }',
    '            }',
    '        }',
    '    }',
    ...(p.search
      ? ['', '    /** Searches after a short pause in typing. */', '    fun search(text: String) {', '        _state.update { it.copy(query = text) }', '        searchJob?.cancel()', '        searchJob = viewModelScope.launch {', '            delay(400)', `            load(${pg ? 'reset = true' : ''})`, '        }', '    }']
      : p.clientSearch
        ? ['', '    fun search(text: String) {', '        _state.update { it.copy(query = text) }', '    }']
        : []),
    ...inj.companion,
    '}',
    '',
  ].join('\n');
  return addKotlinImports(vm, ['androidx.lifecycle.ViewModel', 'androidx.lifecycle.viewModelScope', 'kotlinx.coroutines.CancellationException', 'kotlinx.coroutines.Job', 'kotlinx.coroutines.flow.MutableStateFlow', 'kotlinx.coroutines.flow.StateFlow', 'kotlinx.coroutines.flow.asStateFlow', 'kotlinx.coroutines.flow.update', 'kotlinx.coroutines.launch', ...(p.search ? ['kotlinx.coroutines.delay'] : []), a.ifaceClass, ...modelImports, ...inj.imports], pkg);
}

/** The ViewModel of a data screen (Compose and Views share it): loads the endpoint into StateFlow<UiState<T>>. */
export function dataViewModel(x: Ctx, a: ApiRef, vmName: string, pkg: string, params: string[], args: string[], inj: Injection, uiState: string, T: string, modelImports: string[]): string {
  const vm = [
    `package ${pkg}`,
    '',
    ...inj.header,
    ...params.map((p) => `    private val ${p}: String = checkNotNull(savedStateHandle["${p}"])`),
    ...(params.length ? [''] : []),
    `    private val _state = MutableStateFlow<UiState<${T}>>(UiState.Loading)`,
    `    val state: StateFlow<UiState<${T}>> = _state.asStateFlow()`,
    '',
    '    init {',
    '        load()',
    '    }',
    '',
    '    fun load() {',
    '        viewModelScope.launch {',
    '            _state.value = UiState.Loading',
    '            _state.value = try {',
    `                UiState.Success(api.${a.ep.name}(${args.join(', ')}))`,
    '            } catch (e: Exception) {',
    '                UiState.Error(e.message ?: "Something went wrong")',
    '            }',
    '        }',
    '    }',
    ...inj.companion,
    '}',
    '',
  ].join('\n');
  return addKotlinImports(vm, ['androidx.lifecycle.ViewModel', 'androidx.lifecycle.viewModelScope', 'kotlinx.coroutines.flow.MutableStateFlow', 'kotlinx.coroutines.flow.StateFlow', 'kotlinx.coroutines.flow.asStateFlow', 'kotlinx.coroutines.launch', a.ifaceClass, uiState, ...modelImports, ...inj.imports], pkg);
}

/** The ViewModel of a form screen (Compose and Views share it): submit(body) sends the endpoint. */
export interface AndroidPrefill {
  /** api.getOrder(orderId.toInt()) */
  call: string;
  model: ModelInfo;
  modelClass: string;
  shared: Set<string>;
}

/**
 * Edit forms: the detail endpoint (feature add passes it as load) when it is on the
 * same Retrofit interface and takes only route parameters, so the form ViewModel
 * can load the current values. null when the form starts empty.
 */
export function androidPrefill(x: Ctx, a: ApiRef, loadName: string | undefined, bodyFields: string[], params: string[]): AndroidPrefill | null {
  const pre = prefillFor(x.root, x.map, loadName, bodyFields, params, 'kt');
  if (!pre) return null;
  let load: ApiRef;
  try {
    load = apiRef(x, pre.ep.name);
  } catch {
    return null;
  }
  if (load.ifaceClass !== a.ifaceClass) return null;
  const required = load.params.filter((p) => !p.optional);
  if (!required.every((p) => params.includes(p.name.replace(/`/g, '')))) return null;
  const args = required.map((p) => (/^(Int|Long)$/.test(p.type) ? `${p.name}.to${p.type}()` : p.name));
  return { call: `api.${pre.ep.name}(${args.join(', ')})`, model: pre.model, modelClass: classOfFile(x.srcDir, pre.model.file), shared: pre.shared };
}

/** Kotlin: the text (or Boolean) an input starts with, from the loaded object it. */
export function ktInitial(kind: 'text' | 'num' | 'bool', access: string, nullable: boolean): string {
  if (kind === 'bool') return nullable ? `${access} ?: false` : access;
  if (kind === 'num') return nullable ? `${access}?.toString().orEmpty()` : `${access}.toString()`;
  return nullable ? `${access}.orEmpty()` : access;
}

export function formViewModel(x: Ctx, a: ApiRef, vmName: string, pkg: string, params: string[], args: string[], inj: Injection, uiState: string, R: string, bodyName: string, bodyClass: string, resultImports: string[], prefill?: AndroidPrefill | null): string {
  const vm = [
    `package ${pkg}`,
    '',
    ...inj.header,
    ...params.map((p) => `    private val ${p}: String = checkNotNull(savedStateHandle["${p}"])`),
    ...(params.length ? [''] : []),
    `    /** null until the form is sent. */`,
    `    private val _state = MutableStateFlow<UiState<${R}>?>(null)`,
    `    val state: StateFlow<UiState<${R}>?> = _state.asStateFlow()`,
    ...(prefill
      ? [
          '',
          '    /** The current values, loaded once to fill the form (null until loaded, or when loading failed). */',
          `    private val _initial = MutableStateFlow<${prefill.model.name}?>(null)`,
          `    val initial: StateFlow<${prefill.model.name}?> = _initial.asStateFlow()`,
          '',
          '    init {',
          '        viewModelScope.launch {',
          `            _initial.value = try { ${prefill.call} } catch (e: Exception) { null }`,
          '        }',
          '    }',
        ]
      : []),
    '',
    `    fun submit(body: ${bodyName}) {`,
    '        viewModelScope.launch {',
    '            _state.value = UiState.Loading',
    '            _state.value = try {',
    `                UiState.Success(api.${a.ep.name}(${args.join(', ')}))`,
    '            } catch (e: Exception) {',
    '                UiState.Error(e.message ?: "Something went wrong")',
    '            }',
    '        }',
    '    }',
    ...inj.companion,
    '}',
    '',
  ].join('\n');
  return addKotlinImports(vm, ['androidx.lifecycle.ViewModel', 'androidx.lifecycle.viewModelScope', 'kotlinx.coroutines.flow.MutableStateFlow', 'kotlinx.coroutines.flow.StateFlow', 'kotlinx.coroutines.flow.asStateFlow', 'kotlinx.coroutines.launch', a.ifaceClass, uiState, bodyClass, ...resultImports, ...(prefill ? [prefill.modelClass] : []), ...inj.imports], pkg);
}
