// screen add <name> --api <endpoint> --form: a form that sends the endpoint's
// request body. One input per field of the request model, typed by field
// kind; submit calls the endpoint and shows saving, success and the error.
//
//   Next.js   a client page ('use client') with controlled inputs
//   Flutter   a StatefulWidget with a Form, validators and a SnackBar
//             (Riverpod, get_it, Bloc and GetX projects)
//
// Field kinds: text, number (int/double), checkbox (bool), date (ISO text),
// list of strings (comma separated). A required field of another kind (a
// nested object) stops the command, since a form cannot fill it.

import { join } from 'node:path';
import { readMethod } from '../adapters/getx.ts';
import { splitTsParams } from '../adapters/reactQuery.ts';
import { prefillFor, tsInitial } from './prefill.ts';
import { addDartImport, importUri } from '../adapters/flutter.ts';
import { importPath } from '../adapters/nextjs.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { exists, readText } from '../core/fsutil.ts';
import { ToolError, type Adapter, type ChangeSet, type EndpointInfo, type ModelInfo, type ProjectMap } from '../core/types.ts';
import { camel, DART_RESERVED, identifier, pascal } from '../input/naming.ts';
import { findDeclaration } from './apiEdit.ts';
import { planRouteAdd } from './route.ts';
import type { ScreenOptions } from './screen.ts';

type Kind = 'text' | 'int' | 'double' | 'bool' | 'date' | 'strings';

interface FormField {
  json: string;
  kind: Kind;
  required: boolean;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

function kindOf(type: string): Kind | null {
  const t = type.replace(/\?$/, '').replace(/\s*\|\s*null$/, '').trim();
  if (/^(string|String)$/.test(t)) return 'text';
  if (/^int$/.test(t)) return 'int';
  if (/^(double|num|number)$/.test(t)) return 'double';
  if (/^(bool|boolean)$/.test(t)) return 'bool';
  if (/^DateTime$/.test(t)) return 'date';
  if (/^(string\[\]|List<String>|Array<string>)$/.test(t)) return 'strings';
  return null;
}

function formFields(model: ModelInfo, endpoint: string): FormField[] {
  const out: FormField[] = [];
  const cannot: string[] = [];
  for (const f of model.fields) {
    const kind = kindOf(f.type);
    if (kind) out.push({ json: f.name, kind, required: !f.nullable });
    else if (!f.nullable) cannot.push(`${f.name} (${f.type})`);
  }
  if (cannot.length) throw new ToolError('form_fields', `${model.name} has required fields a form cannot fill: ${cannot.join(', ')}.`, `Write the form for ${endpoint} by hand, or make those fields optional.`);
  if (!out.length) throw new ToolError('form_fields', `${model.name} has no fields a form can fill.`);
  return out;
}

function findMutation(map: ProjectMap, name: string): EndpointInfo {
  const ep = map.endpoints.find((e) => e.name === name) ?? map.endpoints.find((e) => e.name.toLowerCase() === name.toLowerCase());
  if (!ep) throw new ToolError('no_endpoint', `No endpoint called ${name} was found.`, map.endpoints.length ? `Endpoints: ${map.endpoints.map((e) => e.name).join(', ')}` : 'Add one first with: devtool api add');
  if (ep.method === 'GET' || ep.method === 'HEAD') throw new ToolError('form_needs_body', `${ep.name} is a ${ep.method} endpoint; a form sends data with POST, PUT or PATCH.`, `For a screen that shows ${ep.name}'s data, leave out --form.`);
  return ep;
}

const routeParams = (path: string | undefined) => [...(path ?? '').matchAll(/[:{]([\w-]+)\}?/g)].map((m) => camel(m[1]));

export async function planFormScreen(root: string, adapter: Adapter, map: ProjectMap, opts: ScreenOptions): Promise<ChangeSet> {
  if (!opts.api) throw new ToolError('bad_args', '--form needs the endpoint to send to: --api <endpoint>.');
  const ep = findMutation(map, opts.api);
  if (adapter.id === 'nextjs') return nextForm(root, adapter, map, opts, ep);
  if (adapter.id === 'flutter') return flutterForm(root, adapter, map, opts, ep);
  throw new ToolError('not_supported', `screen add --form needs the Next.js or Flutter adapter; this project uses the ${adapter.id} adapter.`);
}

// ---------------- Next.js ----------------

async function nextForm(root: string, adapter: Adapter, map: ProjectMap, opts: ScreenOptions, ep: EndpointInfo): Promise<ChangeSet> {
  const c = map.conventions;
  const text = readText(join(root, ep.file)) ?? '';
  const decl = findDeclaration(text, ep.name, 'ts');
  if (!decl) throw new ToolError('no_endpoint', `Could not read ${ep.name} in ${ep.file}.`);
  const params = decl.params.split(/,(?![^{]*\})/).map((p) => p.trim()).filter(Boolean);
  const body = params.find((p) => /^body\s*:/.test(p));
  if (!body) throw new ToolError('form_needs_body', `${ep.name}() takes no request body, so there is nothing for a form to send.`);
  const bodyType = body.replace(/^body\s*:\s*/, '').trim();
  const model = map.models.find((m) => m.name === bodyType.replace(/^Partial<(.+)>$/, '$1'));
  if (!model) throw new ToolError('form_fields', `The request type ${bodyType} is not a model devtool knows, so it cannot build the inputs.`);
  const partial = /^Partial</.test(bodyType);
  const fields = formFields(model, ep.name).map((f) => (partial ? { ...f, required: false } : f));
  const pathArgs = params.filter((p) => !/^body\s*:/.test(p) && !/^params\??\s*:/.test(p)).map((p) => ({ name: p.split(/\??\s*:/)[0].trim(), number: /:\s*number$/.test(p) }));
  const routeP = routeParams(opts.path);
  const missing = pathArgs.filter((a) => !routeP.includes(a.name));
  if (missing.length) throw new ToolError('screen_args', `${ep.name}() needs ${missing.map((a) => a.name).join(', ')}, which the screen does not have.`, `Give the route a matching parameter, for example: --path /${opts.name}/:${missing[0].name}`);

  const route = await planRouteAdd(root, adapter, { name: opts.name, path: opts.path, initial: opts.initial });
  const page = route.changes.find((ch) => ch.before === null && /\/page\.(t|j)sx$/.test(ch.path));
  if (!page?.after) throw new ToolError('not_supported', 'screen add --form fills App Router pages only.');
  const q = c.quote === 'double' ? '"' : "'";
  const semi = c.semicolons === 'false' ? '' : ';';
  const key = (n: string) => (IDENT.test(n) ? n : `${q}${n}${q}`);
  const get = (n: string) => (IDENT.test(n) ? `values.${n}` : `values[${q}${n}${q}]`);
  const comp = /export default (?:async )?function (\w+)/.exec(page.after)?.[1] ?? `${pascal(opts.name)}Page`;
  const title = /<h1>([^<{]*)/.exec(page.after)?.[1]?.trim() ?? pascal(opts.name);
  const dir = ep.file.slice(0, ep.file.lastIndexOf('/'));
  const barrel = [`${dir}/index.ts`, `${dir}/index.js`].find((f) => exists(join(root, f)) && /export\s+\*\s+from|export\s*\{/.test(readText(join(root, f)) ?? ''));
  const initial = fields.map((f) => `${key(f.json)}: ${f.kind === 'bool' ? 'false' : `${q}${q}`}`).join(', ');
  const value = (f: FormField) => {
    const v = get(f.json);
    const conv = f.kind === 'int' || f.kind === 'double' ? `Number(${v})` : f.kind === 'strings' ? `${v}.split(${q},${q}).map((s) => s.trim()).filter(Boolean)` : v;
    if (f.kind === 'bool' || f.required) return conv;
    return `${v} === ${q}${q} ? undefined : ${conv}`;
  };
  const input = (f: FormField) => {
    const onChange = `(e) => setValues({ ...values, ${key(f.json)}: e.target.${f.kind === 'bool' ? 'checked' : 'value'} })`;
    const label = f.json;
    if (f.kind === 'bool') return `        <label>\n          <input type="checkbox" checked={${get(f.json)}} onChange={${onChange}} /> ${label}\n        </label>`;
    const type = f.kind === 'int' || f.kind === 'double' ? 'number' : f.kind === 'date' ? 'datetime-local' : /email/i.test(f.json) ? 'email' : 'text';
    const extra = [f.kind === 'double' ? ' step="any"' : '', f.required ? ' required' : '', f.kind === 'strings' ? ' placeholder="a, b, c"' : ''].join('');
    return `        <label>\n          ${label}\n          <input type="${type}" value={${get(f.json)}} onChange={${onChange}}${extra} />\n        </label>`;
  };
  const callArgs = [...pathArgs.map((a) => (a.number ? `Number(params.${a.name})` : `params.${a.name}`)), 'body'].join(', ');
  // Edit forms start with the current values (feature add passes the detail endpoint).
  const pre = prefillFor(root, map, opts.load, fields.map((f) => f.json), routeP, 'ts');
  const loadDecl = pre ? findDeclaration(readText(join(root, pre.ep.file)) ?? '', pre.ep.name, 'ts') : null;
  const loadParams = loadDecl ? splitTsParams(loadDecl.params).filter((p) => !p.optional) : [];
  const prefill = pre && loadDecl && loadParams.every((p) => routeP.includes(p.name)) ? pre : null;
  const loadArgs = loadParams.map((p) => (/^number$/.test(p.type) ? `Number(params.${p.name})` : `params.${p.name}`)).join(', ');
  const fromD = (f: FormField) => tsInitial(f.kind, IDENT.test(f.json) ? `d.${f.json}` : `d[${q}${f.json}${q}]`, prefill!.field(f.json)!.nullable, q);
  const prefillLines = prefill
    ? [
        '',
        '  useEffect(() => {',
        `    ${prefill.ep.name}(${loadArgs})`,
        `      .then((d) => setValues((v) => ({ ...v, ${fields.filter((f) => prefill.shared.has(f.json)).map((f) => `${key(f.json)}: ${fromD(f)}`).join(', ')} })))`,
        '      .catch((err) => {',
        `        setError(err instanceof Error ? err.message : String(err))${semi}`,
        `        setStatus(${q}error${q})${semi}`,
        `      })${semi}`,
        `  }, [${loadParams.map((p) => `params.${p.name}`).join(', ')}])${semi}`,
      ]
    : [];
  const sameModule = prefill && prefill.ep.file === ep.file;
  page.after = [
    `${q}use client${q}${semi}`,
    '',
    `import { ${prefill ? 'useEffect, ' : ''}useState, type FormEvent } from ${q}react${q}${semi}`,
    ...(pathArgs.length ? [`import { useParams } from ${q}next/navigation${q}${semi}`] : []),
    `import { ${[ep.name, ...(sameModule || (prefill && barrel) ? [prefill!.ep.name] : [])].sort().join(', ')} } from ${q}${importPath(page.path, barrel ?? ep.file, c)}${q}${semi}`,
    ...(prefill && !sameModule && !barrel ? [`import { ${prefill.ep.name} } from ${q}${importPath(page.path, prefill.ep.file, c)}${q}${semi}`] : []),
    `import type { ${model.name} } from ${q}${importPath(page.path, model.file, c)}${q}${semi}`,
    '',
    `export default function ${comp}() {`,
    ...(pathArgs.length ? [`  const params = useParams<{ ${pathArgs.map((a) => `${a.name}: string`).join('; ')} }>()${semi}`] : []),
    `  const [values, setValues] = useState({ ${initial} })${semi}`,
    `  const [status, setStatus] = useState<${q}idle${q} | ${q}saving${q} | ${q}saved${q} | ${q}error${q}>(${q}idle${q})${semi}`,
    `  const [error, setError] = useState(${q}${q})${semi}`,
    ...prefillLines,
    '',
    '  async function onSubmit(e: FormEvent<HTMLFormElement>) {',
    `    e.preventDefault()${semi}`,
    `    setStatus(${q}saving${q})${semi}`,
    '    try {',
    `      const body: ${partial ? `Partial<${model.name}>` : model.name} = {`,
    ...fields.map((f) => `        ${key(f.json)}: ${value(f)},`),
    `      }${semi}`,
    `      await ${ep.name}(${callArgs})${semi}`,
    `      setStatus(${q}saved${q})${semi}`,
    '    } catch (err) {',
    `      setError(err instanceof Error ? err.message : String(err))${semi}`,
    `      setStatus(${q}error${q})${semi}`,
    '    }',
    '  }',
    '',
    '  return (',
    '    <main>',
    `      <h1>${title}</h1>`,
    '      <form onSubmit={onSubmit}>',
    ...fields.map(input),
    `        <button type="submit" disabled={status === ${q}saving${q}}>`,
    `          {status === ${q}saving${q} ? ${q}Saving…${q} : ${q}Save${q}}`,
    '        </button>',
    `        {status === ${q}saved${q} && <p>Saved.</p>}`,
    `        {status === ${q}error${q} && <p role="alert">{error}</p>}`,
    '      </form>',
    '    </main>',
    `  )${semi}`,
    '}',
    '',
  ].join('\n');
  const files = new Map<string, string>(route.changes.filter((ch) => ch.after !== null).map((ch) => [ch.path, ch.after as string]));
  const summary = [...route.summary, `${page.path} is a form for ${model.name} (${fields.length} field${fields.length === 1 ? '' : 's'}) that calls ${ep.name}() and shows saving, saved and the error`];
  return buildChangeSet(root, 'screen add', { files, summary, warnings: route.warnings, generated: [] });
}

// ---------------- Flutter ----------------

async function flutterForm(root: string, adapter: Adapter, map: ProjectMap, opts: ScreenOptions, ep: EndpointInfo): Promise<ChangeSet> {
  const c = map.conventions;
  // GetX: the module (binding, controller, route) as usual; its view becomes the form, with route
  // parameters from Get.parameters and the repository from Get.find.
  const getx = c.router === 'getx' || c.di === 'getx' || c.stateManagement === 'getx';
  const repoText = readText(join(root, ep.file)) ?? '';
  const sig = readMethod(repoText, ep.name);
  if (!sig?.repoClass) throw new ToolError('no_endpoint', `Could not read ${ep.name} in ${ep.file}.`);
  const parts = sig.params.replace(/@Body\(\)\s*/g, '').replace(/@\w+\([^)]*\)\s*/g, '');
  const bodyMatch = /([\w<>?]+)\s+body\b/.exec(parts);
  if (!bodyMatch) throw new ToolError('form_needs_body', `${ep.name}() takes no request body, so there is nothing for a form to send.`);
  const model = map.models.find((m) => m.name === bodyMatch[1].replace(/\?$/, ''));
  if (!model) throw new ToolError('form_fields', `The request type ${bodyMatch[1]} is not a model devtool knows, so it cannot build the inputs.`);
  const fields = formFields(model, ep.name);
  const pathArgs = [...parts.replace(/\{[^}]*\}/, '').split(',')].map((p) => p.trim()).filter((p) => p && !/\bbody$/.test(p)).map((p) => {
    const m = /^([\w<>?]+)\s+(\w+)$/.exec(p);
    return { type: m?.[1] ?? 'String', name: m?.[2] ?? p };
  });
  const routeP = routeParams(opts.path);
  const missing = pathArgs.filter((a) => !routeP.includes(a.name));
  if (missing.length) throw new ToolError('screen_args', `${ep.name}() needs ${missing.map((a) => a.name).join(', ')}, which the screen does not have.`, `Give the route a matching parameter, for example: --path /${opts.name}/:${missing[0].name}`);

  const route = await planRouteAdd(root, adapter, { name: opts.name, path: opts.path, initial: opts.initial });
  const page = getx ? route.changes.find((ch) => ch.before === null && /\/views\/\w+_view\.dart$/.test(ch.path)) : route.changes.find((ch) => ch.before === null && ch.path.endsWith('.dart'));
  const cls = page?.after ? new RegExp(`class\\s+(\\w+)\\s+extends\\s+${getx ? 'GetView<\\w+>' : 'StatelessWidget'}`).exec(page.after)?.[1] : undefined;
  if (!page?.after || !cls) throw new ToolError('not_supported', 'Could not create the page for the form.');
  const riverpod = c.di === 'riverpod';
  const getIt = c.di === 'get_it';
  const repoExpr = getx ? `Get.find<${sig.repoClass}>()` : riverpod ? `ref.read(${camel(sig.repoClass)}Provider)` : getIt ? `${c.diInstance || 'getIt'}<${sig.repoClass}>()` : `context.read<${sig.repoClass}>()`;
  if (!getx && !riverpod && !getIt && c.stateManagement !== 'bloc') throw new ToolError('not_supported', `screen add --form needs a way to get ${sig.repoClass} (Riverpod, get_it or Bloc's RepositoryProvider); this project registers it with "${c.di || 'nothing'}".`);
  if (!getx && !riverpod && !getIt) route.warnings.push(`${page.path} reads ${sig.repoClass} with context.read, so provide it above this page with a RepositoryProvider.`);
  const titleText = page.after.match(/AppBar\(title: const Text\('([^']*)'\)\)/)?.[1] ?? pascal(opts.name);
  const prop = (f: FormField) => identifier(f.json, DART_RESERVED);
  const ctl = (f: FormField) => `_${camel(prop(f))}`;
  const texty = fields.filter((f) => f.kind !== 'bool');
  const bools = fields.filter((f) => f.kind === 'bool');
  const parse = (f: FormField) => {
    const t = `${ctl(f)}.text.trim()`;
    const conv = f.kind === 'int' ? `int.parse(${t})` : f.kind === 'double' ? `double.parse(${t})` : f.kind === 'date' ? `DateTime.parse(${t})` : f.kind === 'strings' ? `${t}.split(',').map((s) => s.trim()).where((s) => s.isNotEmpty).toList()` : t;
    return f.required ? conv : `${t}.isEmpty ? null : ${conv}`;
  };
  const validator = (f: FormField) => {
    const checks: string[] = [];
    if (f.required) checks.push("if (v == null || v.trim().isEmpty) return 'Required';");
    // After the required check, v is known to be non-null and non-empty (a second null check is an analyzer warning).
    const given = f.required ? '' : 'v != null && v.trim().isNotEmpty && ';
    if (f.kind === 'int') checks.push(`if (${given}int.tryParse(v.trim()) == null) return 'Enter a whole number';`);
    if (f.kind === 'double') checks.push(`if (${given}double.tryParse(v.trim()) == null) return 'Enter a number';`);
    if (f.kind === 'date') checks.push(`if (${given}DateTime.tryParse(v.trim()) == null) return 'Use YYYY-MM-DD';`);
    return checks.length ? `(v) {\n                  ${checks.join('\n                  ')}\n                  return null;\n                }` : '';
  };
  const argOf = (a: { name: string }) => (getx ? a.name : `widget.${a.name}`);
  const callArgs = [...pathArgs.map((a) => (/^int\??$/.test(a.type) ? `int.parse(${argOf(a)})` : argOf(a))), 'body'].join(', ');
  // Edit forms start with the current values: the detail endpoint, from the same repository.
  const pre = prefillFor(root, map, opts.load, fields.map((f) => f.json), routeP, 'dart');
  const loadSig = pre && pre.ep.file === ep.file ? readMethod(repoText, pre.ep.name) : null;
  const loadArgs = loadSig
    ? loadSig.params
        .replace(/@\w+\([^)]*\)\s*/g, '')
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x && !x.startsWith('{') && !x.startsWith('['))
        .map((x) => /^([\w<>?]+)\s+(\w+)$/.exec(x))
    : [];
  const prefill = pre && loadSig && loadSig.repoClass === sig.repoClass && loadArgs.every((m) => m && routeP.includes(m[2])) ? pre : null;
  const loadCall = prefill ? `${repoExpr}.${prefill.ep.name}(${loadArgs.map((m) => (/^int\??$/.test(m![1]) ? `int.parse(${argOf({ name: m![2] })})` : argOf({ name: m![2] }))).join(', ')})` : '';
  const fromD = (f: FormField) => {
    const n = prefill!.field(f.json)!.nullable;
    const d = `d.${camel(prop(f))}`;
    if (f.kind === 'bool') return n ? `${d} ?? false` : d;
    if (f.kind === 'strings') return n ? `(${d} ?? const []).join(', ')` : `${d}.join(', ')`;
    if (f.kind === 'date') return n ? `${d}?.toIso8601String() ?? ''` : `${d}.toIso8601String()`;
    if (f.kind === 'int' || f.kind === 'double') return n ? `${d}?.toString() ?? ''` : `'\${${d}}'`;
    return n ? `${d} ?? ''` : d;
  };
  const prefillLines = prefill
    ? [
        '  @override',
        '  void initState() {',
        '    super.initState();',
        '    _load();',
        '  }',
        '',
        '  /// Fills the form with the current values.',
        '  Future<void> _load() async {',
        ...(getx ? loadArgs.map((m) => `    final ${m![2]} = Get.parameters['${m![2]}']!;`) : []),
        '    try {',
        `      final d = await ${loadCall};`,
        '      if (!mounted) return;',
        '      setState(() {',
        ...fields.filter((f) => prefill.shared.has(f.json)).map((f) => (f.kind === 'bool' ? `        ${ctl(f)} = ${fromD(f)};` : `        ${ctl(f)}.text = ${fromD(f)};`)),
        '      });',
        '    } catch (e) {',
        "      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));",
        '    }',
        '  }',
        '',
      ]
    : [];
  const stateBase = riverpod ? 'ConsumerStatefulWidget' : 'StatefulWidget';
  const stateCls = riverpod ? `ConsumerState<${cls}>` : `State<${cls}>`;
  const ctor = pathArgs.length && !getx ? `const ${cls}({super.key, ${pathArgs.map((a) => `required this.${a.name}`).join(', ')}});` : `const ${cls}({super.key});`;
  let text = [
    "import 'package:flutter/material.dart';",
    '',
    `class ${cls} extends ${stateBase} {`,
    `  ${ctor}`,
    ...(pathArgs.length && !getx ? ['', ...pathArgs.map((a) => `  final String ${a.name};`)] : []),
    '',
    '  @override',
    `  ${stateCls.replace(/<.*/, '')}<${cls}> createState() => _${cls}State();`,
    '}',
    '',
    `class _${cls}State extends ${stateCls} {`,
    '  final _formKey = GlobalKey<FormState>();',
    ...texty.map((f) => `  final ${ctl(f)} = TextEditingController();`),
    ...bools.map((f) => `  bool ${ctl(f)} = false;`),
    '  bool _saving = false;',
    '',
    ...prefillLines,
    '  @override',
    '  void dispose() {',
    ...texty.map((f) => `    ${ctl(f)}.dispose();`),
    '    super.dispose();',
    '  }',
    '',
    '  Future<void> _submit() async {',
    '    if (!_formKey.currentState!.validate()) return;',
    ...(getx ? pathArgs.map((a) => `    final ${a.name} = Get.parameters['${a.name}']!;`) : []),
    '    setState(() => _saving = true);',
    '    final messenger = ScaffoldMessenger.of(context);',
    '    try {',
    `      final body = ${model.name}(`,
    ...fields.map((f) => `        ${camel(prop(f))}: ${f.kind === 'bool' ? ctl(f) : parse(f)},`),
    '      );',
    `      await ${repoExpr}.${ep.name}(${callArgs});`,
    "      messenger.showSnackBar(const SnackBar(content: Text('Saved')));",
    '    } catch (e) {',
    "      messenger.showSnackBar(SnackBar(content: Text('$e')));",
    '    } finally {',
    '      if (mounted) setState(() => _saving = false);',
    '    }',
    '  }',
    '',
    '  @override',
    '  Widget build(BuildContext context) {',
    '    return Scaffold(',
    `      appBar: AppBar(title: const Text('${titleText}')),`,
    '      body: Form(',
    '        key: _formKey,',
    '        child: ListView(',
    '          padding: const EdgeInsets.all(16),',
    '          children: [',
    ...fields.map((f) => {
      if (f.kind === 'bool') return `            SwitchListTile(\n              title: const Text('${f.json}'),\n              value: ${ctl(f)},\n              onChanged: (v) => setState(() => ${ctl(f)} = v),\n            ),`;
      const kb = f.kind === 'int' ? 'TextInputType.number' : f.kind === 'double' ? 'const TextInputType.numberWithOptions(decimal: true)' : f.kind === 'date' ? 'TextInputType.datetime' : '';
      const v = validator(f);
      return [
        '            TextFormField(',
        `              controller: ${ctl(f)},`,
        `              decoration: const InputDecoration(labelText: '${f.json}'${f.kind === 'strings' ? ", helperText: 'Separate items with commas'" : ''}),`,
        ...(kb ? [`              keyboardType: ${kb},`] : []),
        ...(v ? [`              validator: ${v},`] : []),
        '            ),',
      ].join('\n');
    }),
    '            const SizedBox(height: 24),',
    '            FilledButton(',
    '              onPressed: _saving ? null : _submit,',
    "              child: Text(_saving ? 'Saving…' : 'Save'),",
    '            ),',
    '          ],',
    '        ),',
    '      ),',
    '    );',
    '  }',
    '}',
    '',
  ].join('\n');
  if (getx) text = addDartImport(text, 'package:get/get.dart');
  if (riverpod) text = addDartImport(text, 'package:flutter_riverpod/flutter_riverpod.dart');
  if (!getx && !riverpod && !getIt) text = addDartImport(text, 'package:flutter_bloc/flutter_bloc.dart');
  text = addDartImport(text, importUri(page.path, ep.file, c));
  if (getIt && c.diFile) text = addDartImport(text, importUri(page.path, c.diFile, c));
  if (model.file !== ep.file) text = addDartImport(text, importUri(page.path, model.file, c));
  page.after = text;
  const files = new Map<string, string>(route.changes.filter((ch) => ch.after !== null).map((ch) => [ch.path, ch.after as string]));
  const summary = [...route.summary, `${page.path} is a form for ${model.name} (${fields.length} field${fields.length === 1 ? '' : 's'}, validated) that calls ${sig.repoClass}.${ep.name}()`];
  return buildChangeSet(root, 'screen add', { files, summary, warnings: route.warnings, generated: [] });
}
