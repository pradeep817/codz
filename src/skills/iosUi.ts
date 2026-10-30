// iOS (SwiftUI) screens: route add, screen add (data) and screen add --form.
//
//   <Name>View.swift        a SwiftUI view in the screens folder
//   <Name>ViewModel.swift   data and form screens: a @MainActor ObservableObject
//                           that calls APIClient; route parameters (:id) become
//                           init parameters typed like the API method's
//   LoadState.swift         loading / loaded / failed, written once
//
// SwiftUI has no route table: screens are opened with NavigationLink, so a new
// screen is not registered anywhere, except --initial, which makes it the
// first screen of the app inside a NavigationStack. A data screen shows a
// ProgressView, the error with Retry, then a List (lists) or the fields, and
// reloads when it appears again and on pull to refresh. A form screen has one
// input per request field and closes after saving.

import { join } from 'node:path';
import { swiftClose, swiftName, swiftText } from '../adapters/ios.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { readText } from '../core/fsutil.ts';
import { ToolError, type ChangeSet, type EndpointInfo, type ModelInfo, type ProjectMap } from '../core/types.ts';
import { camel, kebab, pascal, words } from '../input/naming.ts';
import { prefillFor } from './prefill.ts';

interface Opts {
  name: string;
  path?: string;
  api?: string;
  form?: boolean;
  initial?: boolean;
  load?: string;
}

interface SwiftParam {
  label: string;
  type: string;
  optional: boolean;
}

function names(name: string) {
  const base = pascal(name.replace(/[-_ ]?(view|screen|page)$/i, ''));
  return { base, view: `${base}View`, vm: `${base}ViewModel`, title: words(base).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') };
}

const routeParams = (path?: string) => [...(path ?? '').matchAll(/[:{]([\w-]+)\}?/g)].map((m) => camel(m[1]));

/** func getOrder(orderId: Int, page: Int? = nil) async throws -> Order */
export function swiftMethod(text: string, name: string): { params: SwiftParam[]; returns: string } | null {
  const m = new RegExp(`\\bfunc\\s+${name}\\s*\\(([^)]*)\\)\\s*async\\s+throws(?:\\s*->\\s*([^{]+?))?\\s*\\{`).exec(text);
  if (!m) return null;
  const params = m[1]
    .split(',')
    .map((p) => /^\s*`?(\w+)`?\s*:\s*([^=]+?)\s*(=.*)?$/.exec(p))
    .filter((p): p is RegExpExecArray => !!p)
    .map((p) => ({ label: p[1], type: p[2].trim(), optional: !!p[3] }));
  return { params, returns: m[2]?.trim() ?? 'Void' };
}

interface Ctx {
  root: string;
  map: ProjectMap;
  I: string;
  dir: string;
  files: Map<string, string>;
  summary: string[];
  warnings: string[];
  read: (p: string) => string | null;
}

function context(root: string, map: ProjectMap): Ctx {
  const c = map.conventions;
  if (c.ui !== 'swiftui') throw new ToolError('not_supported', 'codz writes SwiftUI screens, and this project has no SwiftUI App (@main struct ...: App).', 'Screens for UIKit apps are not supported yet; api add works.');
  const files = new Map<string, string>();
  return { root, map, I: ' '.repeat(Number(c.indent) || 4), dir: c.screensFolder || `${c.sourceDir || '.'}/Views`, files, summary: [], warnings: [], read: (p) => files.get(p) ?? readText(join(root, p)) };
}

function ensureLoadState(x: Ctx): void {
  const file = `${x.dir}/LoadState.swift`;
  if (x.read(file) !== null) return;
  x.files.set(file, ['/// What a screen shows while it loads, when it has the data, and when loading failed.', 'enum LoadState<Value> {', `${x.I}case loading`, `${x.I}case loaded(Value)`, `${x.I}case failed(String)`, '}', ''].join('\n'));
  x.summary.push(`Create ${file}: LoadState (loading, loaded, failed)`);
}

/** --initial: the app opens on this screen, inside a NavigationStack. */
function makeInitial(x: Ctx, view: string, args: string): void {
  const appFile = x.map.conventions.appFile;
  const text = appFile ? x.read(appFile) : null;
  const m = text ? /\bWindowGroup\s*\{/.exec(text) : null;
  if (!appFile || !text || !m) return void x.warnings.push(`Could not find WindowGroup { } in the App file; show ${view}(${args}) in a NavigationStack yourself.`);
  const open = m.index + m[0].length - 1;
  const close = swiftClose(text, open);
  const indent = /\n([ \t]*)[^\n]*$/.exec(text.slice(0, close))?.[1] ?? '        ';
  const I = x.I;
  x.files.set(appFile, `${text.slice(0, open + 1)}\n${indent}${I}NavigationStack {\n${indent}${I}${I}${view}(${args})\n${indent}${I}}\n${indent}${text.slice(close)}`);
  x.summary.push(`Update ${appFile}: the app opens on ${view} in a NavigationStack`);
}

function finish(x: Ctx, skill: string, view: string, params: { label: string; type: string }[], opts: Opts): ChangeSet {
  if (opts.initial) makeInitial(x, view, params.map((p) => `${p.label}: ${p.type === 'Int' ? '0' : '""'}`).join(', '));
  else x.summary.push(`Open it with: NavigationLink { ${view}(${params.map((p) => `${p.label}: ...`).join(', ')}) } label: { Text("...") }`);
  const created = [...x.files.keys()].filter((f) => readText(join(x.root, f)) === null);
  if (x.map.conventions.fileSync === 'groups' && created.length) x.warnings.push(`Add ${created.join(', ')} to the ${x.map.conventions.appName || 'app'} target in Xcode (this project does not use synchronized folders).`);
  return buildChangeSet(x.root, skill, { files: x.files, summary: x.summary, warnings: x.warnings, generated: [] });
}

export function planIosRoute(root: string, map: ProjectMap, opts: Opts): ChangeSet {
  const x = context(root, map);
  const n = names(opts.name);
  const file = `${x.dir}/${n.view}.swift`;
  if (x.read(file) !== null) throw new ToolError('route_exists', `${file} already exists.`);
  const params = routeParams(opts.path).map((p) => ({ label: p, type: 'String' }));
  const I = x.I;
  x.files.set(
    file,
    [
      'import SwiftUI',
      '',
      `struct ${n.view}: View {`,
      ...params.map((p) => `${I}let ${swiftName(p.label)}: String`),
      ...(params.length ? [''] : []),
      `${I}var body: some View {`,
      `${I}${I}Text("${n.title}${params.length ? ` \\(${swiftName(params[0].label)})` : ''}")`,
      `${I}${I}${I}.navigationTitle("${n.title}")`,
      `${I}}`,
      '}',
      '',
    ].join('\n'),
  );
  x.summary.push(`Create ${file}: ${n.view}`);
  return finish(x, 'route add', n.view, params, opts);
}

function findEp(map: ProjectMap, name: string): EndpointInfo {
  const ep = map.endpoints.find((e) => e.name === name) ?? map.endpoints.find((e) => e.name.toLowerCase() === name.toLowerCase());
  if (!ep) throw new ToolError('no_endpoint', `No endpoint called ${name} was found.`, map.endpoints.length ? `Endpoints: ${map.endpoints.map((e) => e.name).join(', ')}` : 'Add one first with: codz api add');
  return ep;
}

/** "[Product]" → list of Product; "Product" → one. */
function shapeOf(type: string, map: ProjectMap): { list: boolean; model?: ModelInfo } {
  const list = /^\[.+\]$/.test(type.trim());
  const inner = type.trim().replace(/^\[(.+)\]$/, '$1').replace(/\?$/, '');
  return { list, model: map.models.find((m) => m.name === inner) };
}

function titleOf(model: ModelInfo | undefined) {
  if (!model?.fields.length) return undefined;
  const ns = model.fields.map((f) => f.name);
  const pick = ['name', 'title', 'label', 'display_name', 'displayName', 'full_name', 'fullName', 'email', 'username', 'sku', 'id'].find((x) => ns.includes(x)) ?? ns[0];
  return model.fields.find((f) => f.name === pick);
}

const show = (v: string, f: { name: string; nullable: boolean }) => (f.nullable ? `${v}.${swiftName(f.name)}.map { String(describing: $0) } ?? ""` : `String(describing: ${v}.${swiftName(f.name)})`);

interface Call {
  sig: { params: SwiftParam[]; returns: string };
  /** init parameters of the view and view model (route parameters, typed like the API's). */
  inits: { label: string; type: string }[];
  args: string;
}

function callFor(x: Ctx, ep: EndpointInfo, opts: Opts, skip: (label: string) => boolean = () => false): Call {
  const sig = swiftMethod(x.read(ep.file) ?? '', ep.name);
  if (!sig) throw new ToolError('no_endpoint', `Could not read ${ep.name} in ${ep.file}.`);
  const route = routeParams(opts.path);
  const required = sig.params.filter((p) => !p.optional && !skip(p.label));
  const missing = required.filter((p) => !route.includes(p.label));
  if (missing.length) throw new ToolError('screen_args', `${ep.name}() needs ${missing.map((p) => p.label).join(', ')}, which the screen does not have.`, `Give the route a matching parameter, for example: --path /${kebab(names(opts.name).base)}/:${missing[0].label}`);
  const inits = required.map((p) => ({ label: p.label, type: p.type }));
  return { sig, inits, args: inits.map((p) => `${p.label}: ${swiftName(p.label)}`).join(', ') };
}

function viewModelHead(x: Ctx, vm: string, inits: { label: string; type: string }[]): string[] {
  const I = x.I;
  return [
    ...inits.map((p) => `${I}private let ${swiftName(p.label)}: ${p.type}`),
    `${I}private let api: APIClient`,
    '',
    `${I}init(${[...inits.map((p) => `${swiftName(p.label)}: ${p.type}`), 'api: APIClient = .shared'].join(', ')}) {`,
    ...inits.map((p) => `${I}${I}self.${swiftName(p.label)} = ${swiftName(p.label)}`),
    `${I}${I}self.api = api`,
    `${I}}`,
  ];
}

function viewInit(x: Ctx, vm: string, inits: { label: string; type: string }[]): string[] {
  const I = x.I;
  if (!inits.length) return [`${I}@StateObject private var model = ${vm}()`];
  return [`${I}@StateObject private var model: ${vm}`, '', `${I}init(${inits.map((p) => `${swiftName(p.label)}: ${p.type}`).join(', ')}) {`, `${I}${I}_model = StateObject(wrappedValue: ${vm}(${inits.map((p) => `${p.label}: ${swiftName(p.label)}`).join(', ')}))`, `${I}}`];
}

const sample = (type: string) => (/^Int$/.test(type) ? '1' : /^Double$/.test(type) ? '1.0' : '"1"');

export function planIosScreen(root: string, map: ProjectMap, opts: Opts): ChangeSet {
  if (!opts.api) return planIosRoute(root, map, opts);
  const x = context(root, map);
  const ep = findEp(map, opts.api);
  if (opts.form) return planIosForm(x, ep, opts);
  if (ep.method !== 'GET') throw new ToolError('screen_needs_get', `${ep.name} is a ${ep.method} endpoint; a screen loads data with a GET.`, 'For a form that sends it, add --form.');
  const n = names(opts.name);
  const viewFile = `${x.dir}/${n.view}.swift`;
  const vmFile = `${x.dir}/${n.vm}.swift`;
  for (const f of [viewFile, vmFile]) if (x.read(f) !== null) throw new ToolError('route_exists', `${f} already exists.`);
  const call = callFor(x, ep, opts);
  const T = call.sig.returns;
  if (T === 'Void') throw new ToolError('screen_needs_data', `${ep.name}() returns nothing, so there is no data to show.`);
  const shape = shapeOf(T, map);
  const I = x.I;
  ensureLoadState(x);
  x.files.set(
    vmFile,
    [
      'import Foundation',
      '',
      '@MainActor',
      `final class ${n.vm}: ObservableObject {`,
      `${I}@Published private(set) var state: LoadState<${T}> = .loading`,
      ...viewModelHead(x, n.vm, call.inits),
      '',
      `${I}func load() async {`,
      `${I}${I}do {`,
      `${I}${I}${I}state = .loaded(try await api.${ep.name}(${call.args}))`,
      `${I}${I}} catch {`,
      `${I}${I}${I}state = .failed(error.localizedDescription)`,
      `${I}${I}}`,
      `${I}}`,
      '}',
      '',
    ].join('\n'),
  );
  x.summary.push(`Create ${vmFile}: ${n.vm} loads APIClient.${ep.name}()${call.inits.length ? ` with ${call.inits.map((p) => p.label).join(', ')}` : ''}`);
  const model = shape.model;
  const tf = titleOf(model);
  const identifiable = !!model?.fields.some((f) => f.name === 'id' && !f.nullable);
  const L = (depth: number, s: string) => `${I.repeat(depth)}${s}`;
  const loaded = shape.list
    ? [
        L(2, 'case .loaded(let items):'),
        L(3, 'if items.isEmpty {'),
        L(4, 'Text("Nothing here yet.")'),
        L(5, '.foregroundStyle(.secondary)'),
        L(3, '} else {'),
        ...(identifiable
          ? [L(4, 'List(items) { item in'), L(5, `Text(${tf ? show('item', tf) : 'String(describing: item)'})`), L(4, '}')]
          : [L(4, 'List(Array(items.enumerated()), id: \\.offset) { _, item in'), L(5, `Text(${tf ? show('item', tf) : 'String(describing: item)'})`), L(4, '}')]),
        L(3, '}'),
      ]
    : [
        L(2, 'case .loaded(let data):'),
        L(3, 'List {'),
        ...(model?.fields.length ? model.fields.map((f) => L(4, `LabeledContent("${swiftText(f.name)}", value: ${show('data', f)})`)) : [L(4, 'Text(String(describing: data))')]),
        L(3, '}'),
      ];
  x.files.set(
    viewFile,
    [
      'import SwiftUI',
      '',
      `struct ${n.view}: View {`,
      ...viewInit(x, n.vm, call.inits),
      '',
      `${I}var body: some View {`,
      `${I}${I}content`,
      `${I}${I}${I}.navigationTitle("${n.title}")`,
      `${I}${I}${I}.task { await model.load() }`,
      `${I}${I}${I}.refreshable { await model.load() }`,
      `${I}}`,
      '',
      `${I}@ViewBuilder`,
      `${I}private var content: some View {`,
      `${I}${I}switch model.state {`,
      `${I}${I}case .loading:`,
      `${I}${I}${I}ProgressView()`,
      `${I}${I}case .failed(let message):`,
      `${I}${I}${I}VStack(spacing: 12) {`,
      `${I}${I}${I}${I}Text(message)`,
      `${I}${I}${I}${I}${I}.multilineTextAlignment(.center)`,
      `${I}${I}${I}${I}Button("Retry") {`,
      `${I}${I}${I}${I}${I}Task { await model.load() }`,
      `${I}${I}${I}${I}}`,
      `${I}${I}${I}}`,
      `${I}${I}${I}.padding()`,
      ...loaded,
      `${I}${I}}`,
      `${I}}`,
      '}',
      '',
      '#Preview {',
      `${I}NavigationStack {`,
      `${I}${I}${n.view}(${call.inits.map((p) => `${swiftName(p.label)}: ${sample(p.type)}`).join(', ')})`,
      `${I}}`,
      '}',
      '',
    ].join('\n'),
  );
  x.summary.push(`Create ${viewFile}: ${n.view} (loading, error with Retry, ${shape.list ? 'List' : 'details'}; reloads on appear and pull to refresh)`);
  return finish(x, 'screen add', n.view, call.inits, opts);
}

function planIosForm(x: Ctx, ep: EndpointInfo, opts: Opts): ChangeSet {
  if (!['POST', 'PUT', 'PATCH'].includes(ep.method)) throw new ToolError('form_needs_body', `${ep.name} is a ${ep.method} endpoint; a form sends a request body (POST, PUT or PATCH).`);
  const n = names(opts.name);
  const viewFile = `${x.dir}/${n.view}.swift`;
  const vmFile = `${x.dir}/${n.vm}.swift`;
  for (const f of [viewFile, vmFile]) if (x.read(f) !== null) throw new ToolError('route_exists', `${f} already exists.`);
  const call = callFor(x, ep, opts, (l) => l === 'body');
  const bodyParam = call.sig.params.find((p) => p.label === 'body');
  if (!bodyParam) throw new ToolError('form_needs_body', `${ep.name}() takes no body, so there is nothing for a form to send.`);
  const model = x.map.models.find((m) => m.name === bodyParam.type);
  if (!model) throw new ToolError('form_fields', `The request type ${bodyParam.type} is not a model codz knows, so it cannot build the inputs.`);
  const kindOf = (t: string) => (t === 'String' ? 'text' : t === 'Int' ? 'int' : t === 'Double' ? 'double' : t === 'Bool' ? 'bool' : t === '[String]' ? 'strings' : null);
  const reserved = new Set(['body', 'model', 'dismiss', 'canSave', 'save']);
  const fields = model.fields.map((f) => {
    const prop = swiftName(f.name);
    const bare = prop.replace(/`/g, '');
    return { f, prop, state: reserved.has(bare) ? `${bare}Value` : bare, kind: kindOf(f.type) };
  });
  const cannot = fields.filter((x) => !x.kind && !x.f.nullable);
  if (cannot.length) throw new ToolError('form_fields', `${model.name} has required fields a form cannot fill: ${cannot.map((c) => `${c.f.name} (${c.f.type})`).join(', ')}.`, `Write the form for ${ep.name} by hand, or make those fields optional.`);
  const usable = fields.filter((x) => x.kind);
  if (fields.length > usable.length) x.warnings.push(`The form has no input for ${fields.filter((f) => !f.kind).map((f) => `${f.f.name} (${f.f.type})`).join(', ')}; they are sent as nil.`);
  const I = x.I;
  const trim = (s: string) => `${s}.trimmingCharacters(in: .whitespaces)`;
  const value = (y: (typeof fields)[number]) => {
    const s = y.state;
    switch (y.kind) {
      case 'text':
        return y.f.nullable ? `${s}.isEmpty ? nil : ${trim(s)}` : trim(s);
      case 'int':
        return y.f.nullable ? `Int(${trim(s)})` : `Int(${trim(s)}) ?? 0`;
      case 'double':
        return y.f.nullable ? `Double(${trim(s)})` : `Double(${trim(s)}) ?? 0`;
      case 'bool':
        return s;
      case 'strings': {
        const list = `${s}.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }`;
        return y.f.nullable ? `${s}.isEmpty ? nil : ${list}` : list;
      }
      default:
        return 'nil';
    }
  };
  const checks = usable
    .filter((y) => !y.f.nullable && y.kind !== 'bool')
    .map((y) => (y.kind === 'int' ? `Int(${trim(y.state)}) != nil` : y.kind === 'double' ? `Double(${trim(y.state)}) != nil` : `!${trim(y.state)}.isEmpty`));
  const returnsVoid = call.sig.returns === 'Void';
  // Edit forms: load the detail endpoint first and start with its values.
  const pre = (() => {
    const p = prefillFor(x.root, x.map, opts.load, usable.map((y) => y.f.name), routeParams(opts.path), 'swift');
    if (!p) return null;
    const sig = swiftMethod(x.read(p.ep.file) ?? '', p.ep.name);
    if (!sig) return null;
    const req = sig.params.filter((q) => !q.optional);
    if (!req.every((q) => call.inits.some((i) => i.label === q.label && i.type === q.type))) return null;
    const set = usable.filter((y) => p.shared.has(y.f.name) && p.field(y.f.name)!.type.replace(/\?$/, '') === y.f.type.replace(/\?$/, ''));
    if (!set.length) return null;
    return { p, args: req.map((q) => `${q.label}: ${swiftName(q.label)}`).join(', '), set };
  })();
  const startValue = (y: (typeof usable)[number]) => {
    const nullable = pre!.p.field(y.f.name)!.nullable;
    const a = `d.${y.prop}`;
    switch (y.kind) {
      case 'bool':
        return nullable ? `${a} ?? false` : a;
      case 'int':
      case 'double':
        return nullable ? `${a}.map { String($0) } ?? ""` : `String(${a})`;
      case 'strings':
        return nullable ? `(${a} ?? []).joined(separator: ", ")` : `${a}.joined(separator: ", ")`;
      default:
        return nullable ? `${a} ?? ""` : a;
    }
  };
  x.files.set(
    vmFile,
    [
      'import Foundation',
      '',
      '@MainActor',
      `final class ${n.vm}: ObservableObject {`,
      `${I}@Published private(set) var saving = false`,
      `${I}@Published private(set) var error: String?`,
      ...viewModelHead(x, n.vm, call.inits),
      ...(pre
        ? [
            '',
            `${I}/// The current values to start the form with (nil when they could not be loaded).`,
            `${I}func loadInitial() async -> ${pre.p.model.name}? {`,
            `${I}${I}try? await api.${pre.p.ep.name}(${pre.args})`,
            `${I}}`,
          ]
        : []),
      '',
      `${I}/// Sends the form; true when it was saved.`,
      `${I}func submit(_ body: ${model.name}) async -> Bool {`,
      `${I}${I}saving = true`,
      `${I}${I}error = nil`,
      `${I}${I}defer { saving = false }`,
      `${I}${I}do {`,
      `${I}${I}${I}${returnsVoid ? '' : '_ = '}try await api.${ep.name}(${[call.args, 'body: body'].filter(Boolean).join(', ')})`,
      `${I}${I}${I}return true`,
      `${I}${I}} catch {`,
      `${I}${I}${I}self.error = error.localizedDescription`,
      `${I}${I}${I}return false`,
      `${I}${I}}`,
      `${I}}`,
      '}',
      '',
    ].join('\n'),
  );
  x.summary.push(`Create ${vmFile}: ${n.vm}.submit() sends APIClient.${ep.name}()${pre ? `; the form starts with APIClient.${pre.p.ep.name}()` : ''}`);
  const input = (y: (typeof usable)[number]) => {
    const label = `${swiftText(y.f.name)}${y.f.nullable ? '' : ' *'}`;
    if (y.kind === 'bool') return [`${I}${I}${I}${I}Toggle("${label}", isOn: $${y.state})`];
    const extra = y.kind === 'int' ? ['.keyboardType(.numberPad)'] : y.kind === 'double' ? ['.keyboardType(.decimalPad)'] : /email/i.test(y.f.name) ? ['.keyboardType(.emailAddress)', '.textInputAutocapitalization(.never)'] : [];
    return [`${I}${I}${I}${I}TextField("${label}${y.kind === 'strings' ? ' (comma separated)' : ''}", text: $${y.state})`, ...extra.map((e) => `${I}${I}${I}${I}${I}${e}`)];
  };
  x.files.set(
    viewFile,
    [
      'import SwiftUI',
      '',
      `struct ${n.view}: View {`,
      ...viewInit(x, n.vm, call.inits).slice(0, 1),
      `${I}@Environment(\\.dismiss) private var dismiss`,
      ...usable.map((y) => `${I}@State private var ${y.state}${y.kind === 'bool' ? ' = false' : ' = ""'}`),
      ...(pre ? [`${I}@State private var loaded = false`] : []),
      ...viewInit(x, n.vm, call.inits).slice(1),
      '',
      `${I}var body: some View {`,
      `${I}${I}Form {`,
      `${I}${I}${I}Section {`,
      ...usable.flatMap(input),
      `${I}${I}${I}}`,
      `${I}${I}${I}if let error = model.error {`,
      `${I}${I}${I}${I}Text(error)`,
      `${I}${I}${I}${I}${I}.foregroundStyle(.red)`,
      `${I}${I}${I}}`,
      `${I}${I}${I}Button(model.saving ? "Saving…" : "Save") {`,
      `${I}${I}${I}${I}Task { await save() }`,
      `${I}${I}${I}}`,
      `${I}${I}${I}.disabled(model.saving || !canSave)`,
      `${I}${I}}`,
      `${I}${I}.navigationTitle("${n.title}")`,
      ...(pre
        ? [
            `${I}${I}.task {`,
            `${I}${I}${I}guard !loaded, let d = await model.loadInitial() else { return }`,
            `${I}${I}${I}loaded = true`,
            ...pre.set.map((y) => `${I}${I}${I}${y.state} = ${startValue(y)}`),
            `${I}${I}}`,
          ]
        : []),
      `${I}}`,
      '',
      `${I}private var canSave: Bool {`,
      `${I}${I}${checks.length ? checks.join(' && ') : 'true'}`,
      `${I}}`,
      '',
      `${I}private func save() async {`,
      `${I}${I}let body = ${model.name}(`,
      ...fields.map((y, i) => `${I}${I}${I}${y.prop.replace(/`/g, '')}: ${value(y)}${i < fields.length - 1 ? ',' : ''}`),
      `${I}${I})`,
      `${I}${I}if await model.submit(body) { dismiss() }`,
      `${I}}`,
      '}',
      '',
      '#Preview {',
      `${I}NavigationStack {`,
      `${I}${I}${n.view}(${call.inits.map((p) => `${swiftName(p.label)}: ${sample(p.type)}`).join(', ')})`,
      `${I}}`,
      '}',
      '',
    ].join('\n'),
  );
  x.summary.push(`Create ${viewFile}: ${n.view}, a form with ${usable.length} field${usable.length === 1 ? '' : 's'} for ${model.name}; it closes after saving`);
  return finish(x, 'screen add', n.view, call.inits, opts);
}

/** feature add: rows open the detail view, a + button opens the create form; the list reloads when it appears again. */
export function linkIosList(text: string, t: { detail?: { view: string; param: string; type: string }; create?: { view: string }; id?: { name: string; type: string }; I: string }): string | null {
  let out = text;
  let changed = false;
  const I = t.I;
  if (t.detail && t.id) {
    const re = new RegExp(`(\\{ (?:_, )?item in\\n)([ \\t]*)(Text\\([^\\n]*\\))\\n`);
    const m = re.exec(out);
    if (m) {
      const idExpr = `item.${swiftName(t.id.name)}`;
      const arg = t.id.type === t.detail.type ? idExpr : t.detail.type === 'String' ? `String(${idExpr})` : t.detail.type === 'Int' ? `Int(${idExpr}) ?? 0` : idExpr;
      const ind = m[2];
      out = out.replace(re, `${m[1]}${ind}NavigationLink {\n${ind}${I}${t.detail.view}(${t.detail.param}: ${arg})\n${ind}} label: {\n${ind}${I}${m[3]}\n${ind}}\n`);
      changed = true;
    }
  }
  if (t.create) {
    const re = /\n([ \t]*)(\.navigationTitle\("[^"\n]*"\))\n/;
    const m = re.exec(out);
    if (m) {
      const ind = m[1];
      out = out.replace(re, `\n${ind}${m[2]}\n${ind}.toolbar {\n${ind}${I}NavigationLink {\n${ind}${I}${I}${t.create.view}()\n${ind}${I}} label: {\n${ind}${I}${I}Image(systemName: "plus")\n${ind}${I}}\n${ind}}\n`);
      changed = true;
    }
  }
  return changed ? out : null;
}
