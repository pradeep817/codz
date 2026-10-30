// React Native screens: route add, screen add (data) and screen add --form.
//
//   React Navigation   <Name>Screen.tsx in the screens folder, an entry in
//                      RootStackParamList and a <Stack.Screen> in the navigator;
//                      path parameters (:id) become route params
//   Expo Router        a file under app/ ([id] for parameters), read with
//                      useLocalSearchParams
//
// A data screen loads the endpoint (through its TanStack Query hook when the
// project has one) and shows loading, the error with Retry, and the data
// (FlatList for lists). A form screen has one input per request field.

import { join, posix } from 'node:path';
import { importPath } from '../adapters/nextjs.ts';
import { splitTsParams } from '../adapters/reactQuery.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { exists, readText, walk } from '../core/fsutil.ts';
import { ToolError, type ChangeSet, type EndpointInfo, type ModelInfo, type ProjectMap } from '../core/types.ts';
import { camel, kebab, pascal, words } from '../input/naming.ts';
import { findDeclaration } from './apiEdit.ts';
import { responseShape, titleField } from './screen.ts';
import { reactPrefill } from './prefill.ts';

interface Opts {
  name: string;
  path?: string;
  api?: string;
  form?: boolean;
  load?: string;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

function routeParamsOf(path?: string): string[] {
  return [...(path ?? '').matchAll(/[:{[]([\w-]+)[\]}]?/g)].map((m) => camel(m[1]));
}

function names(name: string) {
  const base = pascal(name.replace(/[-_ ]?screen$/i, ''));
  return { route: base, component: `${base}Screen`, title: words(base).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') };
}

interface Placement {
  file: string;
  /** How the screen reads its params. */
  paramsCode: (params: string[]) => { imports: string[]; lines: string[]; signature: string };
  navigator?: { file: string; text: string };
}

function place(root: string, map: ProjectMap, opts: Opts, warnings: string[]): Placement {
  const c = map.conventions;
  const params = routeParamsOf(opts.path);
  const n = names(opts.name);
  if (c.router === 'expo-router') {
    const dir = c.routerDir || 'app';
    const segs = (opts.path ?? `/${kebab(n.route)}`).split('/').filter(Boolean).map((s) => s.replace(/^:([\w-]+)$/, '[$1]').replace(/^\{([\w-]+)\}$/, '[$1]'));
    const file = posix.join(dir, ...segs) + '.tsx';
    return {
      file,
      paramsCode: (ps) => (ps.length ? { imports: [`import { useLocalSearchParams } from 'expo-router';`], lines: [`  const { ${ps.join(', ')} } = useLocalSearchParams<{ ${ps.map((p) => `${p}: string`).join('; ')} }>();`], signature: '' } : { imports: [], lines: [], signature: '' }),
    };
  }
  if (c.router !== 'react-navigation') throw new ToolError('not_supported', 'This project has no navigation library, so codz cannot add a screen to it.', 'Run codz setup (it adds React Navigation), or add @react-navigation/native or expo-router.');
  const navFile = c.navigatorFile;
  const navText = navFile ? readText(join(root, navFile)) : null;
  if (!navFile || navText === null) throw new ToolError('no_navigator', `The navigator ${navFile || '(none)'} was not found.`, 'Set navigatorFile in codz.config.yaml to the file with your Stack.Navigator.');
  const file = `${c.screensFolder || 'src/screens'}/${n.component}.tsx`;
  const typed = /RootStackParamList/.test(navText);
  if (!typed && params.length) warnings.push(`${navFile} has no RootStackParamList, so route.params is not typed.`);
  const navImport = importPath(file, navFile, { ...c, importStyle: 'relative' });
  return {
    file,
    navigator: { file: navFile, text: navText },
    paramsCode: (ps) =>
      ps.length
        ? typed
          ? { imports: [`import type { NativeStackScreenProps } from '@react-navigation/native-stack';`, `import type { RootStackParamList } from '${navImport}';`], lines: [`  const { ${ps.join(', ')} } = route.params;`], signature: `{ route }: NativeStackScreenProps<RootStackParamList, '${n.route}'>` }
          : { imports: [], lines: [`  const { ${ps.join(', ')} } = route.params as { ${ps.map((p) => `${p}: string`).join('; ')} };`], signature: '{ route }: { route: { params: unknown } }' }
        : { imports: [], lines: [], signature: '' },
  };
}

/** Adds the screen to RootStackParamList and the navigator. */
function register(nav: { file: string; text: string }, file: string, opts: Opts, map: ProjectMap): string {
  const n = names(opts.name);
  const params = routeParamsOf(opts.path);
  let t = nav.text;
  if (new RegExp(`name=["']${n.route}["']`).test(t)) throw new ToolError('route_exists', `${nav.file} already has a screen called ${n.route}.`);
  const semi = map.conventions.semicolons === 'false' ? '' : ';';
  const pl = /(export\s+type\s+RootStackParamList\s*=\s*\{)([\s\S]*?)(\n\}\s*;?)/.exec(t);
  if (pl) t = t.replace(pl[0], `${pl[1]}${pl[2]}\n  ${n.route}: ${params.length ? `{ ${params.map((p) => `${p}: string`).join('; ')} }` : 'undefined'}${semi}${pl[3]}`);
  const close = /\n([ \t]*)<\/(\w+)\.Navigator>/.exec(t);
  if (!close) throw new ToolError('no_navigator', `Could not find </...Navigator> in ${nav.file}.`);
  t = t.replace(close[0], `\n${close[1]}  <${close[2]}.Screen name="${n.route}" component={${n.component}} />${close[0]}`);
  const imp = `import ${n.component} from '${importPath(nav.file, file, { ...map.conventions, importStyle: 'relative' }).replace(/\.tsx$/, '')}'${semi}`;
  const imports = [...t.matchAll(/^import[^\n]*\n/gm)];
  const at = imports.length ? imports[imports.length - 1].index! + imports[imports.length - 1][0].length : 0;
  return t.slice(0, at) + imp + '\n' + t.slice(at);
}

function navHint(map: ProjectMap, opts: Opts): string {
  const n = names(opts.name);
  const params = routeParamsOf(opts.path);
  if (map.conventions.router === 'expo-router') return `Open it with: router.push(\`${(opts.path ?? `/${kebab(n.route)}`).replace(/:(\w+)/g, '${$1}')}\`)`;
  return `Open it with: navigation.navigate('${n.route}'${params.length ? `, { ${params.map((p) => `${p}: '...'`).join(', ')} }` : ''})`;
}

function finish(root: string, skill: string, files: Map<string, string>, summary: string[], warnings: string[]): ChangeSet {
  return buildChangeSet(root, skill, { files, summary, warnings, generated: [] });
}

export function planRnRoute(root: string, map: ProjectMap, opts: Opts): ChangeSet {
  const warnings: string[] = [];
  const p = place(root, map, opts, warnings);
  if (exists(join(root, p.file))) throw new ToolError('route_exists', `${p.file} already exists.`);
  const n = names(opts.name);
  const params = routeParamsOf(opts.path);
  const pc = p.paramsCode(params);
  const body = [
    `import { StyleSheet, Text, View } from 'react-native';`,
    ...pc.imports,
    '',
    `export default function ${n.component}(${pc.signature}) {`,
    ...pc.lines,
    '  return (',
    '    <View style={styles.container}>',
    `      <Text style={styles.title}>${n.title}${params.length ? ` {${params[0]}}` : ''}</Text>`,
    '    </View>',
    '  );',
    '}',
    '',
    'const styles = StyleSheet.create({',
    "  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },",
    "  title: { fontSize: 20, fontWeight: '600' },",
    '});',
    '',
  ].join('\n');
  const files = new Map([[p.file, body]]);
  const summary = [`Create ${p.file}: ${n.component}`];
  if (p.navigator) {
    files.set(p.navigator.file, register(p.navigator, p.file, opts, map));
    summary.push(`Update ${p.navigator.file}: add ${n.route} to RootStackParamList and the stack`);
  }
  summary.push(navHint(map, opts));
  return finish(root, 'route add', files, summary, warnings);
}

/** The endpoint's arguments, filled from route params by name (number params are converted). */
function callArgs(root: string, ep: EndpointInfo, params: string[], skip: (name: string) => boolean = () => false): { args: string; missing: string[]; decl: ReturnType<typeof findDeclaration> } {
  const decl = findDeclaration(readText(join(root, ep.file)) ?? '', ep.name, 'ts');
  if (!decl) throw new ToolError('no_endpoint', `Could not read ${ep.name} in ${ep.file}.`);
  const ps = splitTsParams(decl.params);
  const missing = ps.filter((p) => !p.optional && !skip(p.name) && !params.includes(p.name)).map((p) => p.name);
  const args = ps.filter((p) => !skip(p.name) && params.includes(p.name)).map((p) => (/^number$/.test(p.type) ? `Number(${p.name})` : p.name));
  return { args: args.join(', '), missing, decl };
}

function findEp(map: ProjectMap, name: string): EndpointInfo {
  const ep = map.endpoints.find((e) => e.name === name) ?? map.endpoints.find((e) => e.name.toLowerCase() === name.toLowerCase());
  if (!ep) throw new ToolError('no_endpoint', `No endpoint called ${name} was found.`, map.endpoints.length ? `Endpoints: ${map.endpoints.map((e) => e.name).join(', ')}` : 'Add one first with: codz api add');
  return ep;
}

/** The TanStack Query hook for an endpoint, if the project has one. */
function hookFor(root: string, map: ProjectMap, ep: EndpointInfo): { name: string; file: string } | null {
  if (map.conventions.dataFetching !== 'react-query' || !map.conventions.hooksFolder) return null;
  for (const f of walk(root, map.conventions.hooksFolder, { exts: ['.ts', '.tsx'] })) {
    const t = readText(join(root, f)) ?? '';
    const m = new RegExp(`export function (use\\w+)\\([^)]*\\)\\s*\\{\\s*return useQuery\\(\\{[^}]*?queryFn: \\(\\) => ${ep.name}\\(`).exec(t);
    if (m) return { name: m[1], file: f };
  }
  return null;
}

export function planRnScreen(root: string, map: ProjectMap, opts: Opts): ChangeSet {
  if (!opts.api) return planRnRoute(root, map, opts);
  const ep = findEp(map, opts.api);
  if (opts.form) return planRnForm(root, map, opts, ep);
  if (ep.method !== 'GET') throw new ToolError('screen_needs_get', `${ep.name} is a ${ep.method} endpoint; a screen loads data with a GET.`, `For a form that sends it, add --form.`);
  const warnings: string[] = [];
  const p = place(root, map, opts, warnings);
  if (exists(join(root, p.file))) throw new ToolError('route_exists', `${p.file} already exists.`);
  const n = names(opts.name);
  const params = routeParamsOf(opts.path);
  const { args, missing, decl } = callArgs(root, ep, params);
  if (missing.length) throw new ToolError('screen_args', `${ep.name}() needs ${missing.join(', ')}, which the screen does not have.`, `Give the route a matching parameter, for example: --path /${kebab(n.route)}/:${missing[0]}`);
  const shape = responseShape(decl!.returnType, map);
  const tf = titleField(shape.model);
  const idf = shape.model?.fields.find((f) => /^(id|uuid|key|slug)$/.test(f.name))?.name;
  const pc = p.paramsCode(params);
  const hook = hookFor(root, map, ep);
  const c = map.conventions;
  const dir = posix.dirname(ep.file);
  const barrel = [`${dir}/index.ts`].find((f) => exists(join(root, f)) && /export\s+\*\s+from/.test(readText(join(root, f)) ?? ''));
  const fromApi = importPath(p.file, barrel ?? ep.file, c).replace(/\.tsx?$/, '');
  const T = shape.raw || 'unknown';
  const access = (v: string, f: string) => (IDENT.test(f) ? `${v}.${f}` : `${v}['${f}']`);
  const dataView = shape.list
    ? [
        '    <FlatList',
        '      data={data}',
        `      keyExtractor={(item, index) => ${idf ? `String(${access('item', idf)})` : 'String(index)'}}`,
        '      refreshing={loading}',
        '      onRefresh={load}',
        "      ListEmptyComponent={<Text style={styles.empty}>Nothing here yet.</Text>}",
        `      renderItem={({ item }) => <Text style={styles.row}>{${tf ? `String(${access('item', tf)})` : 'JSON.stringify(item)'}}</Text>}`,
        '    />',
      ]
    : [
        '    <ScrollView contentContainerStyle={styles.details}>',
        ...(shape.model?.fields.length
          ? shape.model.fields.flatMap((f) => [`      <Text style={styles.label}>${f.name}</Text>`, `      <Text style={styles.value}>{String(${access('data', f.name)} ?? '')}</Text>`])
          : ['      <Text>{JSON.stringify(data, null, 2)}</Text>']),
        '    </ScrollView>',
      ];
  const stateLines = hook
    ? [`  const { data, isLoading: loading, error, refetch: load } = ${hook.name}(${args});`]
    : [
        `  const [data, setData] = useState<${T} | null>(null);`,
        '  const [loading, setLoading] = useState(true);',
        '  const [error, setError] = useState<unknown>(null);',
        '',
        '  const load = useCallback(async () => {',
        '    setLoading(true);',
        '    setError(null);',
        '    try {',
        `      setData(await ${ep.name}(${args}));`,
        '    } catch (e) {',
        '      setError(e);',
        '    } finally {',
        '      setLoading(false);',
        '    }',
        `  }, [${params.join(', ')}]);`,
        '',
        '  useEffect(() => {',
        '    load();',
        '  }, [load]);',
      ];
  const body = [
    ...(hook ? [] : [`import { useCallback, useEffect, useState } from 'react';`]),
    `import { ActivityIndicator, Button, ${shape.list ? 'FlatList' : 'ScrollView'}, StyleSheet, Text, View } from 'react-native';`,
    ...pc.imports,
    hook ? `import { ${hook.name} } from '${importPath(p.file, hook.file, c).replace(/\.tsx?$/, '')}';` : `import { ${ep.name} } from '${fromApi}';`,
    ...(shape.model && !hook ? [`import type { ${shape.model.name} } from '${importPath(p.file, shape.model.file, c).replace(/\.tsx?$/, '')}';`] : []),
    '',
    `export default function ${n.component}(${pc.signature}) {`,
    ...pc.lines,
    ...stateLines,
    '',
    '  if (loading && !data) {',
    '    return (',
    '      <View style={styles.center}>',
    '        <ActivityIndicator />',
    '      </View>',
    '    );',
    '  }',
    '  if (error) {',
    '    return (',
    '      <View style={styles.center}>',
    `        <Text style={styles.error}>{error instanceof Error ? error.message : String(error)}</Text>`,
    '        <Button title="Retry" onPress={() => load()} />',
    '      </View>',
    '    );',
    '  }',
    ...(shape.list ? [] : ['  if (!data) return null;']),
    '  return (',
    ...dataView,
    '  );',
    '}',
    '',
    'const styles = StyleSheet.create({',
    "  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },",
    "  error: { marginBottom: 12, textAlign: 'center' },",
    "  empty: { padding: 16, textAlign: 'center' },",
    "  row: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#ccc' },",
    "  details: { padding: 16 },",
    "  label: { fontSize: 12, color: '#666', marginTop: 12 },",
    "  value: { fontSize: 16 },",
    '});',
    '',
  ].join('\n');
  const files = new Map([[p.file, body]]);
  const summary = [`Create ${p.file}: ${n.component} loads ${hook ? `${hook.name}()` : `${ep.name}()`} and shows loading, the error with Retry, and the data`];
  if (p.navigator) {
    files.set(p.navigator.file, register(p.navigator, p.file, opts, map));
    summary.push(`Update ${p.navigator.file}: add ${n.route} to RootStackParamList and the stack`);
  }
  summary.push(navHint(map, opts));
  return finish(root, 'screen add', files, summary, warnings);
}

type Kind = 'text' | 'number' | 'bool' | 'strings';

function kind(type: string): Kind | null {
  const t = type.replace(/\s*\|\s*null$/, '').trim();
  if (t === 'string') return 'text';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'bool';
  if (t === 'string[]') return 'strings';
  return null;
}

function planRnForm(root: string, map: ProjectMap, opts: Opts, ep: EndpointInfo): ChangeSet {
  if (ep.method === 'GET' || ep.method === 'HEAD') throw new ToolError('form_needs_body', `${ep.name} is a ${ep.method} endpoint; a form sends data with POST, PUT or PATCH.`);
  const warnings: string[] = [];
  const p = place(root, map, opts, warnings);
  if (exists(join(root, p.file))) throw new ToolError('route_exists', `${p.file} already exists.`);
  const n = names(opts.name);
  const params = routeParamsOf(opts.path);
  const { args, missing, decl } = callArgs(root, ep, params, (x) => x === 'body');
  if (missing.length) throw new ToolError('screen_args', `${ep.name}() needs ${missing.join(', ')}, which the screen does not have.`, `Give the route a matching parameter, for example: --path /${kebab(n.route)}/:${missing[0]}`);
  const body = splitTsParams(decl!.params).find((x) => x.name === 'body');
  if (!body) throw new ToolError('form_needs_body', `${ep.name}() takes no request body, so there is nothing for a form to send.`);
  const partial = /^Partial</.test(body.type);
  const model: ModelInfo | undefined = map.models.find((m) => m.name === body.type.replace(/^Partial<(.+)>$/, '$1'));
  if (!model) throw new ToolError('form_fields', `The request type ${body.type} is not a model codz knows, so it cannot build the inputs.`);
  const fields = model.fields.map((f) => ({ f, k: kind(f.type), required: !partial && !f.nullable }));
  const cannot = fields.filter((x) => !x.k && x.required).map((x) => `${x.f.name} (${x.f.type})`);
  if (cannot.length) throw new ToolError('form_fields', `${model.name} has required fields a form cannot fill: ${cannot.join(', ')}.`, `Write the form for ${ep.name} by hand, or make those fields optional.`);
  const usable = fields.filter((x) => x.k);
  const key = (s: string) => (IDENT.test(s) ? s : `'${s}'`);
  const get = (s: string) => (IDENT.test(s) ? `values.${s}` : `values['${s}']`);
  const value = (x: (typeof usable)[number]) => {
    const v = get(x.f.name);
    const conv = x.k === 'number' ? `Number(${v})` : x.k === 'strings' ? `${v}.split(',').map((s) => s.trim()).filter(Boolean)` : v;
    if (x.k === 'bool' || x.required) return conv;
    return `${v} === '' ? undefined : ${conv}`;
  };
  const pc = p.paramsCode(params);
  const c = map.conventions;
  const dir = posix.dirname(ep.file);
  const barrel = [`${dir}/index.ts`].find((f) => exists(join(root, f)) && /export\s+\*\s+from/.test(readText(join(root, f)) ?? ''));
  const pre = reactPrefill(root, map, opts.load, usable.map((x) => ({ json: x.f.name, kind: x.k! })), params, key);
  const apiFrom = importPath(p.file, barrel ?? ep.file, c).replace(/\.tsx?$/, '');
  const preFrom = pre ? importPath(p.file, barrel ?? pre.ep.file, c).replace(/\.tsx?$/, '') : '';
  const text = [
    `import { ${pre ? 'useEffect, ' : ''}useState } from 'react';`,
    `import { Alert, Button, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';`,
    ...pc.imports,
    ...(pre && preFrom === apiFrom ? [`import { ${[ep.name, pre.ep.name].sort().join(', ')} } from '${apiFrom}';`] : [`import { ${ep.name} } from '${apiFrom}';`, ...(pre ? [`import { ${pre.ep.name} } from '${preFrom}';`] : [])]),
    `import type { ${model.name} } from '${importPath(p.file, model.file, c).replace(/\.tsx?$/, '')}';`,
    '',
    `export default function ${n.component}(${pc.signature}) {`,
    ...pc.lines,
    `  const [values, setValues] = useState({ ${usable.map((x) => `${key(x.f.name)}: ${x.k === 'bool' ? 'false' : "''"}`).join(', ')} });`,
    '  const [saving, setSaving] = useState(false);',
    ...(pre ? ['  const [error, setError] = useState<string | null>(null);', ...pre.lines] : []),
    '',
    '  async function submit() {',
    ...usable.filter((x) => x.required && x.k !== 'bool').map((x) => `    if (${get(x.f.name)}.trim() === '') return Alert.alert('${x.f.name} is required');`),
    '    setSaving(true);',
    '    try {',
    `      const body: ${partial ? `Partial<${model.name}>` : model.name} = {`,
    ...usable.map((x) => `        ${key(x.f.name)}: ${value(x)},`),
    '      };',
    `      await ${ep.name}(${[args, 'body'].filter(Boolean).join(', ')});`,
    "      Alert.alert('Saved');",
    '    } catch (e) {',
    "      Alert.alert('Could not save', e instanceof Error ? e.message : String(e));",
    '    } finally {',
    '      setSaving(false);',
    '    }',
    '  }',
    '',
    '  return (',
    '    <ScrollView contentContainerStyle={styles.form}>',
    ...usable.map((x) =>
      x.k === 'bool'
        ? `      <View style={styles.switchRow}>\n        <Text>${x.f.name}</Text>\n        <Switch value={${get(x.f.name)}} onValueChange={(v) => setValues({ ...values, ${key(x.f.name)}: v })} />\n      </View>`
        : `      <Text style={styles.label}>${x.f.name}${x.required ? ' *' : ''}</Text>\n      <TextInput\n        style={styles.input}\n        value={${get(x.f.name)}}\n        onChangeText={(v) => setValues({ ...values, ${key(x.f.name)}: v })}${x.k === 'number' ? '\n        keyboardType="numeric"' : /email/i.test(x.f.name) ? '\n        keyboardType="email-address"\n        autoCapitalize="none"' : ''}${x.k === 'strings' ? '\n        placeholder="a, b, c"' : ''}\n      />`,
    ),
    ...(pre ? ['      {error ? <Text style={styles.error}>{error}</Text> : null}'] : []),
    `      <Button title={saving ? 'Saving…' : 'Save'} onPress={submit} disabled={saving} />`,
    '    </ScrollView>',
    '  );',
    '}',
    '',
    'const styles = StyleSheet.create({',
    '  form: { padding: 16, gap: 8 },',
    ...(pre ? ["  error: { color: '#b3261e' },"] : []),
    "  label: { fontSize: 12, color: '#666', marginTop: 8 },",
    "  input: { borderWidth: StyleSheet.hairlineWidth, borderColor: '#999', borderRadius: 8, padding: 10 },",
    "  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },",
    '});',
    '',
  ].join('\n');
  const files = new Map([[p.file, text]]);
  const summary = [`Create ${p.file}: a form for ${model.name} (${usable.length} field${usable.length === 1 ? '' : 's'}) that calls ${ep.name}()`];
  if (p.navigator) {
    files.set(p.navigator.file, register(p.navigator, p.file, opts, map));
    summary.push(`Update ${p.navigator.file}: add ${n.route} to RootStackParamList and the stack`);
  }
  summary.push(navHint(map, opts));
  return finish(root, 'screen add', files, summary, warnings);
}
