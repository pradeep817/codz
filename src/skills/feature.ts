// feature add <name>: a whole feature in one previewed change.
//
//   devtool feature add orders --spec api.yaml          endpoints from the spec whose path or tag is "orders"
//   devtool feature add orders --spec api.yaml --tag Orders
//   devtool feature add orders --api getOrders --api getOrder --api createOrder   (endpoints already in the project)
//
// It runs the existing generators in order, in a private copy of the project
// (src/core/workspace.ts), so each step builds on the last:
//
//   1. api import       the endpoints, models and DI registration
//   2. screen add       a list screen (GET returning a list), a detail screen (GET with an id),
//                       a create form (POST with a body) and an edit form (PUT/PATCH with a body)
//   3. test add         tests for the new endpoints
//
// The difference between the copy and the project is returned as ONE change
// set: one preview, one apply, one undo. Nothing in the project changes until
// it is applied.

import { loadMap } from '../core/cache.ts';
import { loadConfig } from '../core/config.ts';
import { readText, walk } from '../core/fsutil.ts';
import { openWorkspace } from '../core/workspace.ts';
import { ToolError, type Adapter, type ChangeSet, type Conventions, type HttpMethod } from '../core/types.ts';
import { readApiFile } from '../input/apiSpec.ts';
import { camel, kebab, pascal, singular, snake, words } from '../input/naming.ts';
import { pathMatches, planApiImport } from './apiImport.ts';
import { planSetup } from './setup.ts';
import { linkViewsList } from './androidViews.ts';
import { linkIosList } from './iosUi.ts';
import { planScreenAdd } from './screen.ts';
import { planTestAdd } from './testgen.ts';
import { idField, responseShape } from './screen.ts';
import { linkAndroidList, linkFlutterList, linkNextList, linkReactList, linkRnList, type LinkTargets } from './featureLinks.ts';
import { editComposeDetail, editFlutterDetail, editIosDetail, editNextDetail, editReactDetail, editRnDetail, editViewsDetail, type EditTarget } from './featureEdit.ts';
import type { Workspace } from '../core/workspace.ts';
import { join } from 'node:path';

export interface FeatureOptions {
  name: string;
  /** OpenAPI, Swagger, Postman or HAR file to take the endpoints from. */
  spec?: string;
  tags?: string[];
  paths?: string[];
  /** Endpoints already in the project (instead of, or as well as, a spec). */
  apis?: string[];
  forms?: boolean;
  tests?: boolean;
  /** Make the list screen the first screen of the app. */
  initial?: boolean;
  baseUrl?: string;
  /** Add the endpoints that work and leave out the ones that clash, instead of stopping. */
  skipConflicts?: boolean;
  /** Architecture to set up first when the project has no API layer yet (default: the recommended one). */
  architecture?: string;
}

export interface FeatureReport {
  changeSet: ChangeSet;
  endpoints: string[];
  screens: { name: string; kind: ScreenKind; route: string; api: string; load?: string }[];
  tests: boolean;
  /** Set when the project had no API layer and this change sets one up first. */
  setup?: { architecture: string; dependenciesChanged: boolean };
}

type ScreenKind = 'list' | 'detail' | 'create' | 'edit';

/** What a screen needs to know about an endpoint, whether it came from a spec or from the project. */
interface Candidate {
  name: string;
  method: HttpMethod;
  path: string;
  params: string[];
  list: boolean;
  body: boolean;
}

/** Endpoints in a spec that belong to the feature: an explicit --tag/--path filter, else paths or tags that name it. */
export function featureOperations(specText: string, opts: Pick<FeatureOptions, 'name' | 'tags' | 'paths' | 'baseUrl'>) {
  const doc = readApiFile(specText, { baseUrl: opts.baseUrl });
  const wantTags = new Set((opts.tags ?? []).map((t) => t.toLowerCase()));
  const explicit = wantTags.size > 0 || (opts.paths?.length ?? 0) > 0;
  const nameForms = new Set([opts.name, kebab(opts.name), words(opts.name).join('_'), camel(opts.name), singular(kebab(opts.name))].map((s) => s.toLowerCase()));
  const ops = doc.operations.filter((o) => {
    if (explicit) return (!wantTags.size || o.tags.some((t) => wantTags.has(t.toLowerCase()))) && (!opts.paths?.length || opts.paths.some((g) => pathMatches(g, o.spec.path)));
    const segs = o.spec.path.split('/').filter((s) => s && !s.startsWith('{')).map((s) => s.toLowerCase());
    return segs.some((s) => nameForms.has(s)) || o.tags.some((t) => nameForms.has(t.toLowerCase()) || nameForms.has(kebab(t)));
  });
  return { doc, ops };
}

const isListType = (t: string | undefined) => !!t && /(\[\]|^List<.*>|^Array<.*>)\??$/.test(t.replace(/^Promise<(.*)>$/, '$1').replace(/^Future<(.*)>$/, '$1').replace(/^Flow<(.*)>$/, '$1').trim());

/** Picks at most one endpoint per screen kind and names the screens and routes. */
export function planScreens(feature: string, cands: Candidate[], forms: boolean): { name: string; kind: ScreenKind; route: string; api: string; load?: string }[] {
  const plural = pascal(feature);
  const one = pascal(singular(kebab(feature)));
  const base = `/${kebab(feature)}`;
  const routeOf = (c: Candidate, suffix = '') => {
    // Parameters that come before the resource (a parent id) and the resource id, in path order.
    const parts = c.params.map((p) => `:${p}`);
    return [base, ...parts].join('/') + suffix;
  };
  const picks: { name: string; kind: ScreenKind; route: string; api: string; load?: string }[] = [];
  // Order matters for routers that match in order (go_router, React Navigation linking): /orders/new before /orders/:id.
  const list = cands.find((c) => c.method === 'GET' && c.list);
  if (list) picks.push({ name: plural, kind: 'list', route: routeOf(list), api: list.name });
  const create = forms ? cands.find((c) => c.method === 'POST' && c.body) : undefined;
  if (create) picks.push({ name: `New${one}`, kind: 'create', route: `${routeOf(create)}/new`.replace(/\/\/+/g, '/'), api: create.name });
  const detail = cands.find((c) => c.method === 'GET' && !c.list && c.params.length > 0);
  if (detail) picks.push({ name: `${one}Detail`, kind: 'detail', route: routeOf(detail), api: detail.name });
  const edit = forms ? cands.find((c) => (c.method === 'PUT' || c.method === 'PATCH') && c.body) : undefined;
  if (edit) picks.push({ name: `Edit${one}`, kind: 'edit', route: routeOf(edit, '/edit'), api: edit.name, ...(detail ? { load: detail.name } : {}) });
  return picks;
}

export async function planFeatureAdd(root: string, adapter: Adapter, opts: FeatureOptions): Promise<FeatureReport> {
  if (!adapter.planEndpoint) throw new ToolError('not_supported', 'feature add works in Next.js, React Native, Flutter and Android projects, and this folder is not one of them.', 'For iOS, use a Flutter or React Native project (they build for iOS and Android). Run devtool init to see what devtool detects here.');
  if (!/^[A-Za-z][A-Za-z0-9 _-]{0,40}$/.test(opts.name)) throw new ToolError('bad_name', `"${opts.name}" is not a feature name.`, 'Use letters, digits, - or _, for example orders or user-profile.');
  if (!opts.spec && !opts.apis?.length) throw new ToolError('bad_args', 'Where do the endpoints come from?', `Pass --spec <openapi.yaml> (endpoints whose path or tag is "${opts.name}"), or --api <endpoint> for endpoints already in the project.`);
  const forms = opts.forms !== false;
  const warnings: string[] = [];
  const summary: string[] = [];
  const cands: Candidate[] = [];
  const endpointNames: string[] = [];

  let specFile: string | undefined;
  let specBase = '';
  if (opts.spec) {
    specFile = readText(join(root, opts.spec)) !== null ? join(root, opts.spec) : opts.spec;
    const text = readText(specFile);
    if (text === null) throw new ToolError('no_file', `Cannot read ${opts.spec}.`);
    const { ops, doc } = featureOperations(text, opts);
    if (!ops.length) {
      throw new ToolError('no_endpoints', `No operations in ${opts.spec} belong to "${opts.name}" (${doc.operations.length} in the file).`, 'Name the feature after a path segment (orders for /orders/{id}), or pass --tag or --path. See the operations with: devtool api import <file> --list');
    }
    const first = ops.find((o) => o.spec.origin);
    if (first) specBase = `${first.spec.origin}${first.spec.serverPrefix ?? ''}`;
    for (const o of ops) {
      cands.push({ name: o.spec.name, method: o.spec.method, path: o.spec.path, params: o.spec.pathParams.map((p) => p.name), list: o.spec.response?.kind === 'array', body: !!o.spec.request });
      endpointNames.push(o.spec.name);
    }
  }

  const ws = openWorkspace(root);
  try {
    // 0. No API layer yet (a fresh project): set one up first, in the same change, so the
    // endpoints, screens and tests below are written in that architecture.
    const before = (await loadMap(ws.root, adapter, loadConfig(ws.root).conventions, { force: true })).map;
    const options = adapter.architectures?.(before) ?? [];
    let setup: FeatureReport['setup'];
    if (options.length) {
      const pick = opts.architecture ? options.find((o) => o.id === opts.architecture) : (options.find((o) => o.recommended) ?? options[0]);
      if (!pick) throw new ToolError('bad_args', `Unknown architecture "${opts.architecture}".`, `Choose one of: ${options.map((o) => o.id).join(', ')}.`);
      const baseUrl = opts.baseUrl ?? (specBase || 'https://api.example.com');
      const { changeSet: setupCs, plan } = planSetup(ws.root, adapter, before, { architecture: pick.id, baseUrl });
      ws.apply(setupCs);
      setup = { architecture: pick.id, dependenciesChanged: plan.dependenciesChanged };
      summary.push(`Set up first: ${pick.label}, base URL ${baseUrl.replace(/\/+$/, '')} (the project had no API layer${opts.architecture ? '' : `; choose another with --architecture ${options.map((o) => o.id).join('|')}`})`);
    } else if (opts.architecture) {
      warnings.push(`This project already has an API layer, so --architecture ${opts.architecture} was not used.`);
    }

    // 1. Endpoints.
    if (specFile) {
      // A half-built feature is worse than none: by default a clash stops everything (nothing is written).
      const imp = await planApiImport(ws.root, adapter, { file: specFile, only: endpointNames, baseUrl: opts.baseUrl, skipConflicts: opts.skipConflicts === true, yes: true });
      ws.apply(imp.changeSet);
      summary.push(`Endpoints: ${imp.added.length} added${imp.existing.length ? `, ${imp.existing.length} already in the project` : ''}${imp.skipped.length ? `, ${imp.skipped.length} skipped` : ''}`);
      for (const s of imp.skipped) warnings.push(`Skipped ${s.name}: ${s.reason}`);
      warnings.push(...imp.changeSet.warnings.filter((w) => !/^Skipped /.test(w)));
    }

    // Endpoints given by name come from the project as it is (plus the ones just imported).
    const { map } = await loadMap(ws.root, adapter, loadConfig(ws.root).conventions, { force: true });
    for (const n of opts.apis ?? []) {
      const ep = map.endpoints.find((e) => e.name === n) ?? map.endpoints.find((e) => e.name.toLowerCase() === n.toLowerCase());
      if (!ep) throw new ToolError('no_endpoint', `No endpoint called ${n} was found.`, `Endpoints: ${map.endpoints.map((e) => e.name).slice(0, 30).join(', ')}`);
      cands.push({ name: ep.name, method: ep.method, path: ep.path, params: [...ep.path.matchAll(/\{([^/}]+)\}/g)].map((m) => m[1]), list: isListType(ep.response), body: ep.method !== 'GET' && ep.method !== 'DELETE' });
      endpointNames.push(ep.name);
    }
    // Spec endpoints that the project already had under another name keep the project's name.
    for (const c of cands) {
      if (map.endpoints.some((e) => e.name === c.name)) continue;
      const same = map.endpoints.find((e) => e.method === c.method && e.path.replace(/\{[^/}]+\}/g, '{}') === c.path.replace(/\{[^/}]+\}/g, '{}'));
      if (same) c.name = same.name;
    }

    // 2. Screens.
    const screens = planScreens(opts.name, cands, forms);
    if (!screens.length) warnings.push('None of these endpoints suits a screen (a GET for lists and details, a POST, PUT or PATCH with a body for forms); only the endpoints were added.');
    const made: FeatureReport['screens'] = [];
    const createdBy = new Map<string, string[]>();
    for (const [i, s] of screens.entries()) {
      try {
        const cs = await planScreenAdd(ws.root, adapter, { name: s.name, api: s.api, path: s.route, form: s.kind === 'create' || s.kind === 'edit', initial: opts.initial === true && i === 0, ...(s.load ? { load: s.load } : {}) });
        ws.apply(cs);
        createdBy.set(s.name, cs.changes.filter((ch) => ch.before === null && ch.after !== null).map((ch) => ch.path));
        made.push(s);
        warnings.push(...cs.warnings);
      } catch (e) {
        if (!(e instanceof ToolError)) throw e;
        warnings.push(`No ${s.kind} screen (${s.name}): ${e.message}`);
      }
    }
    for (const s of made) summary.push(`Screen ${s.name} (${s.kind}) at ${s.route}, using ${s.api}()`);
    if (made.some((s) => s.kind === 'list')) {
      const linked = await linkScreens(ws, adapter, opts.name, made, createdBy);
      if (linked) {
        summary.push(linked);
        // The row now pushes the detail page itself, so the "open it with Navigator.push" hint is done.
        const detail = made.find((s) => s.kind === 'detail');
        if (detail && /a row opens/.test(linked)) for (let i = warnings.length - 1; i >= 0; i--) if (new RegExp(`open ${detail.name}Page with Navigator\\.push`).test(warnings[i])) warnings.splice(i, 1);
      }
      else if (made.length > 1) warnings.push('The list screen was not linked to the other screens (its layout is not the one devtool writes); add the navigation by hand.');
    }
    // SwiftUI: titles and NavigationLinks need a NavigationStack above the list.
    const listScreen = made.find((s) => s.kind === 'list');
    if (adapter.id === 'ios' && listScreen && !opts.initial) {
      const swift = walk(ws.root, '.', { exts: ['.swift'], extraIgnored: ['Pods', 'DerivedData', 'build'] });
      if (!swift.some((f) => /\bNavigation(Stack|View|SplitView)\b/.test((ws.read(f) ?? '').split('#Preview')[0]))) warnings.push(`Nothing in the app uses a NavigationStack yet, so ${listScreen.name}View's title and links will not work until one is above it. Run again with --initial to open the app on it inside a NavigationStack, or wrap it yourself.`);
    }
    const unused = cands.filter((c) => !made.some((s) => s.api === c.name)).map((c) => `${c.name}()`);
    if (unused.length) summary.push(`Also available for your own screens: ${unused.join(', ')}`);

    // 3. Tests.
    let tested = false;
    if (opts.tests !== false) {
      try {
        const names = [...new Set(cands.map((c) => c.name))];
        const cs = await planTestAdd(ws.root, adapter, { endpoints: names });
        tested = ws.apply(cs);
        if (tested) summary.push(`Tests for ${names.length} endpoint${names.length === 1 ? '' : 's'}`);
        warnings.push(...cs.warnings);
      } catch (e) {
        if (!(e instanceof ToolError)) throw e;
        warnings.push(`No tests: ${e.message}`);
      }
    }

    summary.unshift(`Feature "${opts.name}": ${new Set(endpointNames).size} endpoint${new Set(endpointNames).size === 1 ? '' : 's'}, ${made.length} screen${made.length === 1 ? '' : 's'}${tested ? ', tests' : ''}`);
    const changeSet = ws.finish('feature add', summary, [...new Set(warnings)]);
    return { changeSet, endpoints: [...new Set(endpointNames)], screens: made, tests: tested, setup };
  } finally {
    ws.dispose();
  }
}

/** Rows of the list open the detail screen; a "New" button opens the create form. Returns a summary line, or null. */
async function linkScreens(ws: Workspace, adapter: Adapter, feature: string, made: FeatureReport['screens'], createdBy: Map<string, string[]>): Promise<string | null> {
  const list = made.find((s) => s.kind === 'list')!;
  const detail = made.find((s) => s.kind === 'detail');
  const create = made.find((s) => s.kind === 'create');
  const edit = made.find((s) => s.kind === 'edit');
  if (!detail && !create) return null;
  const { map } = await loadMap(ws.root, adapter, loadConfig(ws.root).conventions, { force: true });
  const c = map.conventions;
  const ep = map.endpoints.find((e) => e.name === list.api);
  const model = ep ? responseShape(ep.response, map).model : undefined;
  const params = detail ? [...detail.route.matchAll(/:(\w+)/g)].map((m) => m[1]) : [];
  const t: LinkTargets = {
    // A detail route with one parameter (the item's id) can be opened from a row.
    detail: detail && params.length === 1 && !/:/.test(list.route) ? { route: detail.route, param: params[0], screen: detail.name } : undefined,
    create: create ? { route: create.route, screen: create.name } : undefined,
    idField: idField(model),
    noun: singular(kebab(feature)).replace(/-/g, ' '),
  };
  const files = createdBy.get(list.name) ?? [];
  const pick = (re: RegExp) => files.find((f) => re.test(f));
  // GetX: modules keep their own route names, so links go by the Routes constant.
  if (adapter.id === 'flutter' && (c.router === 'getx' || c.di === 'getx' || c.stateManagement === 'getx') && c.packageName) {
    const konst = (screen: string) => konstFor(ws, c, screen);
    if (t.detail) t.detail = { ...t.detail, routeConst: konst(t.detail.screen) };
    if (t.create) t.create = { ...t.create, routeConst: konst(t.create.screen) };
    t.routesImport = `package:${c.packageName}/${(c.routesFile || 'lib/app/routes/app_pages.dart').replace(/^lib\//, '')}`;
  }
  // Flutter with Navigator: the detail page is pushed by its class, so the list imports it.
  if (adapter.id === 'flutter' && t.detail && detail) {
    const page = (createdBy.get(detail.name) ?? []).find((f) => /^lib\/.*\.dart$/.test(f) && /class \w+ extends \w*(Stateful|Stateless)Widget/.test(ws.read(f) ?? ''));
    const widget = page ? /class (\w+) extends \w*(?:Stateful|Stateless)Widget/.exec(ws.read(page) ?? '')?.[1] : undefined;
    if (page && widget && c.packageName) t.detail = { ...t.detail, widget, dartImport: `package:${c.packageName}/${page.slice(4)}` };
  }
  let done = false;
  if (adapter.id === 'nextjs') {
    const f = pick(/(^|\/)page\.(tsx|jsx)$/);
    const text = f ? ws.read(f) : null;
    const out = text ? linkNextList(text, t) : null;
    if (f && out) (ws.write(f, out), (done = true));
  } else if (adapter.id === 'ios') {
    const f = pick(new RegExp(`${list.name}View\\.swift$`));
    const text = f ? ws.read(f) : null;
    const detailFile = detail ? (createdBy.get(detail.name) ?? []).find((p) => new RegExp(`${detail.name}View\\.swift$`).test(p)) : undefined;
    const init = detailFile ? /\binit\((\w+): (\w+)\)/.exec(ws.read(detailFile) ?? '') : null;
    const idInfo = model?.fields.find((x) => x.name === t.idField);
    const out = text
      ? linkIosList(text, {
          detail: t.detail && init ? { view: `${t.detail.screen}View`, param: init[1], type: init[2] } : undefined,
          create: t.create ? { view: `${t.create.screen}View` } : undefined,
          id: idInfo ? { name: idInfo.name, type: idInfo.type } : undefined,
          I: ' '.repeat(Number(c.indent) || 4),
        })
      : null;
    if (f && out) (ws.write(f, out), (done = true));
  } else if (adapter.id === 'react') {
    const f = pick(new RegExp(`${list.name}Page\\.(tsx|jsx)$`)) ?? pick(/\.(tsx|jsx)$/);
    const text = f ? ws.read(f) : null;
    const out = text ? linkReactList(text, t) : null;
    if (f && out) (ws.write(f, out), (done = true));
  } else if (adapter.id === 'react-native') {
    const f = pick(new RegExp(`${list.name}Screen\\.(tsx|jsx)$`)) ?? pick(/\.(tsx|jsx)$/);
    const text = f ? ws.read(f) : null;
    const out = text && f ? linkRnList(text, t, c, f) : null;
    if (f && out) (ws.write(f, out), (done = true));
  } else if (adapter.id === 'flutter') {
    const f = pick(/_(page|view|screen)\.dart$/);
    const text = f ? ws.read(f) : null;
    const out = text ? linkFlutterList(text, t, c) : null;
    if (f && out) (ws.write(f, out), (done = true));
  } else if (adapter.id === 'android' && c.ui === 'views') {
    const f = pick(new RegExp(`${list.name}Activity\\.kt$`));
    const text = f ? ws.read(f) : null;
    const pkg = text ? /^package\s+([\w.]+)/m.exec(text)?.[1] ?? '' : '';
    const out = text ? linkViewsList(text, pkg, { detail: t.detail ? { activity: `${t.detail.screen}Activity`, param: t.detail.param } : undefined, create: t.create ? { activity: `${t.create.screen}Activity`, noun: t.noun } : undefined, idField: t.idField }) : null;
    if (f && out) (ws.write(f, out), (done = true));
  } else if (adapter.id === 'android') {
    const f = pick(new RegExp(`${list.name}Screen\\.kt$`));
    const navFile = c.navFile;
    const screen = f ? ws.read(f) : null;
    const nav = navFile ? ws.read(navFile) : null;
    const out = screen && nav ? linkAndroidList(screen, nav, `${list.name}Screen`, t) : null;
    if (f && navFile && out) {
      ws.write(f, out.screen);
      ws.write(navFile, out.navHost);
      done = true;
    }
  }
  const edited = linkEdit(ws, adapter, c, { detail, edit, create }, createdBy, t);
  if (!done && !edited) return null;
  return `Linked the screens: ${[done && t.detail ? `a row opens ${t.detail.screen}` : '', done && t.create ? `"New ${t.noun}" opens ${t.create.screen}` : '', edited].filter(Boolean).join(', ')}`;
}

type Made = FeatureReport['screens'][number];

/** GetX: the project's own constant for a module's route (Routes.PRODUCT_DETAIL or Routes.productDetail). */
function konstFor(ws: Workspace, c: Conventions, screen: string): string {
  const pages = c.routesFile || 'lib/app/routes/app_pages.dart';
  const routesText = `${ws.read(pages) ?? ''}\n${ws.read(pages.replace(/[^/]+$/, 'app_routes.dart')) ?? ''}`;
  const pathsBlock = /abstract\s+class\s+_Paths\b[^{]*\{([\s\S]*?)\n\}/.exec(routesText)?.[1] ?? '';
  const routesBlock = /abstract\s+class\s+Routes\b[^{]*\{([\s\S]*?)\n\}/.exec(routesText)?.[1] ?? '';
  const path = `/${kebab(screen)}`;
  const pathName = [...pathsBlock.matchAll(/static\s+const\s+(\w+)\s*=\s*'([^']*)'/g)].find((m) => m[2] === path)?.[1];
  const route = pathName ? [...routesBlock.matchAll(/static\s+const\s+(\w+)\s*=\s*_Paths\.(\w+)/g)].find((m) => m[2] === pathName)?.[1] : undefined;
  return route ?? snake(screen).toUpperCase();
}

/** The Edit button on the detail screen (and, on Compose, going back from the forms). Returns what it did, or null. */
function linkEdit(ws: Workspace, adapter: Adapter, c: Conventions, s: { detail?: Made; edit?: Made; create?: Made }, createdBy: Map<string, string[]>, t: LinkTargets): string | null {
  const { detail, edit, create } = s;
  const detailParams = detail ? [...detail.route.matchAll(/:(\w+)/g)].map((m) => m[1]) : [];
  const editParams = edit ? [...edit.route.matchAll(/:(\w+)/g)].map((m) => m[1]) : [];
  // The form opens for the same item: one shared parameter.
  const e: EditTarget | undefined = detail && edit && detailParams.length === 1 && editParams.length === 1 && detailParams[0] === editParams[0] ? { route: edit.route, param: editParams[0], screen: edit.name } : undefined;
  const filesOf = (m: Made | undefined) => (m ? createdBy.get(m.name) ?? [] : []);
  const find = (m: Made | undefined, re: RegExp) => filesOf(m).find((f) => re.test(f));
  const update = (f: string | undefined, fn: (text: string) => string | null): boolean => {
    const text = f ? ws.read(f) : null;
    const out = text ? fn(text) : null;
    if (f && out && out !== text) {
      ws.write(f, out);
      return true;
    }
    return false;
  };
  const msg = e ? `"Edit" on ${detail!.name} opens ${edit!.name}` : null;
  if (adapter.id === 'android' && c.ui !== 'views') {
    const f = find(detail, new RegExp(`${detail?.name}Screen\\.kt$`));
    const navFile = c.navFile;
    const screen = f ? ws.read(f) : null;
    const nav = navFile ? ws.read(navFile) : null;
    if (!nav || !navFile) return null;
    const forms = [create, edit].filter((m): m is Made => !!m).map((m) => `${m.name}Screen`);
    const pkg = screen ? /^package\s+([\w.]+)/m.exec(screen)?.[1] ?? '' : '';
    const out = editComposeDetail(screen ?? '', nav, `${detail?.name}Screen`, forms, screen ? e : undefined, pkg);
    if (!out) return null;
    if (f && out.screen !== screen) ws.write(f, out.screen);
    ws.write(navFile, out.navHost);
    const backs = forms.filter((x) => out.navHost.includes(`${x}(onDone = `));
    return [out.screen !== screen ? msg : null, backs.length ? `${backs.map((b) => b.replace(/Screen$/, '')).join(' and ')} go back when saved` : null].filter(Boolean).join(', ') || null;
  }
  if (!e || !detail || !edit) return null;
  let ok = false;
  if (adapter.id === 'nextjs') ok = update(find(detail, /(^|\/)page\.(tsx|jsx)$/), (x) => editNextDetail(x, e));
  else if (adapter.id === 'react') ok = update(find(detail, new RegExp(`${detail.name}Page\\.(tsx|jsx)$`)), (x) => editReactDetail(x, e));
  else if (adapter.id === 'react-native') ok = update(find(detail, new RegExp(`(${detail.name}Screen|\\[${e.param}\\])\\.(tsx|jsx)$`)), (x) => editRnDetail(x, e, c));
  else if (adapter.id === 'flutter') {
    const getx = c.router === 'getx' || c.di === 'getx' || c.stateManagement === 'getx';
    let target = e;
    if (getx) target = { ...e, routeConst: c.packageName ? konstFor(ws, c, edit.name) : undefined, routesImport: t.routesImport };
    else if (c.router === 'navigator') {
      const page = filesOf(edit).find((f) => /^lib\/.*\.dart$/.test(f) && /class \w+ extends \w*(Stateful|Stateless)Widget/.test(ws.read(f) ?? ''));
      const widget = page ? /class (\w+) extends \w*(?:Stateful|Stateless)Widget/.exec(ws.read(page) ?? '')?.[1] : undefined;
      if (page && widget && c.packageName) target = { ...e, widget, dartImport: `package:${c.packageName}/${page.slice(4)}` };
    }
    const controller = getx ? find(detail, /_controller\.dart$/) : undefined;
    ok = update(find(detail, /_(page|view|screen)\.dart$/), (x) => editFlutterDetail(x, target, c, controller ? ws.read(controller) ?? undefined : undefined));
  } else if (adapter.id === 'android') {
    const f = find(detail, new RegExp(`${detail.name}Activity\\.kt$`));
    ok = update(f, (x) => editViewsDetail(x, /^package\s+([\w.]+)/m.exec(x)?.[1] ?? '', { activity: `${edit.name}Activity`, param: e.param }));
  } else if (adapter.id === 'ios') {
    const df = find(detail, new RegExp(`${detail.name}View\\.swift$`));
    const ef = find(edit, new RegExp(`${edit.name}View\\.swift$`));
    const init = df ? /\binit\((\w+): ([\w?[\]]+)\)/.exec(ws.read(df) ?? '') : null;
    const einit = ef ? /\binit\((\w+): ([\w?[\]]+)\)/.exec(ws.read(ef) ?? '') : null;
    if (init && einit && init[1] === einit[1] && init[2] === einit[2]) ok = update(df, (x) => editIosDetail(x, { view: `${edit.name}View`, param: init[1], type: init[2] }, ' '.repeat(Number(c.indent) || 4)));
  }
  return ok ? msg : null;
}
