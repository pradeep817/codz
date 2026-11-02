// React web pages: route add, screen add (data) and screen add --form.
//
//   <Name>Page.tsx in the pages folder, registered in the router file:
//     data style   { path: '/orders/:id', element: <OrderPage /> } in createBrowserRouter([...])
//     jsx style    <Route path="/orders/:id" element={<OrderPage />} /> inside <Routes>
//   Path parameters (:id) are read with useParams().
//
// A data page loads the endpoint (through its TanStack Query hook when the
// project has one) and shows loading, the error with Retry, and the data (a
// list, or the fields). A form page has one input per request field and goes
// back after saving.

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
import { detectPaging, pagingSummary, pagingWarnings, tsPagedLogic, tsPagingArgs, tsPagingParams } from './paging.ts';

interface Opts {
  name: string;
  path?: string;
  api?: string;
  form?: boolean;
  initial?: boolean;
  load?: string;
  paginate?: boolean;
  search?: boolean;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

function routeParamsOf(path?: string): string[] {
  return [...(path ?? '').matchAll(/[:{]([\w-]+)\}?/g)].map((m) => camel(m[1]));
}

function names(name: string) {
  const base = pascal(name.replace(/[-_ ]?(page|screen)$/i, ''));
  return { base, component: `${base}Page`, title: words(base).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') };
}

/** Index of the bracket that closes the one at `open`, skipping strings and template literals. */
function closing(text: string, open: number): number {
  const pairs: Record<string, string> = { '[': ']', '(': ')', '{': '}' };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i;
    }
  }
  return -1;
}

interface Placement {
  file: string;
  route: string;
  routerFile: string;
  routerText: string;
}

function place(root: string, map: ProjectMap, opts: Opts): Placement {
  const c = map.conventions;
  if (c.router !== 'react-router') throw new ToolError('not_supported', 'This project has no React Router, so codz cannot add a page to it.', 'Run codz setup (it adds React Router), or add react-router-dom.');
  const routerFile = c.routerFile;
  const routerText = routerFile ? readText(join(root, routerFile)) : null;
  if (!routerFile || routerText === null) throw new ToolError('no_router', `The router file ${routerFile || '(none)'} was not found.`, 'Set routerFile in codz.config.yaml to the file with createBrowserRouter or <Routes>.');
  const n = names(opts.name);
  const route = (opts.path ?? `/${kebab(n.base)}`).replace(/\{([\w-]+)\}/g, ':$1');
  return { file: `${c.pagesFolder || 'src/pages'}/${n.component}.tsx`, route, routerFile, routerText };
}

/** Adds the page to the router file (createBrowserRouter array or <Routes>). */
function register(p: Placement, map: ProjectMap, opts: Opts): string {
  const n = names(opts.name);
  const c = map.conventions;
  const q = c.quote === 'double' ? '"' : "'";
  const semi = c.semicolons === 'false' ? '' : ';';
  let t = p.routerText;
  if (new RegExp(`path[=:]\\s*\\{?["'\`]${p.route.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}["'\`]`).test(t)) throw new ToolError('route_exists', `${p.routerFile} already has a route for ${p.route}.`);
  const data = /createBrowserRouter\s*\(/.exec(t);
  if (data) {
    const open = t.indexOf('[', data.index);
    const close = open >= 0 ? closing(t, open) : -1;
    if (close < 0) throw new ToolError('no_router', `Could not read the route list in ${p.routerFile}.`);
    const before = t.slice(0, close).replace(/\s*$/, '');
    const indent = /\n([ \t]+)\{\s*path/.exec(t.slice(open))?.[1] ?? '  ';
    const comma = /[,[]\s*$/.test(before) ? '' : ',';
    const entry = `{ path: ${q}${p.route}${q}, element: <${n.component} /> },`;
    t = opts.initial ? t.slice(0, open + 1) + `\n${indent}${entry}` + t.slice(open + 1) : `${before}${comma}\n${indent}${entry}\n` + t.slice(close);
  } else {
    const end = t.lastIndexOf('</Routes>');
    if (end < 0) throw new ToolError('no_router', `Could not find createBrowserRouter or </Routes> in ${p.routerFile}.`);
    const lineStart = t.lastIndexOf('\n', end) + 1;
    const indent = /\n([ \t]+)<Route\b[^\n]*\n[ \t]*<\/Routes>/.exec(t)?.[1] ?? `${t.slice(lineStart, end)}  `;
    t = `${t.slice(0, lineStart)}${indent}<Route path="${p.route}" element={<${n.component} />} />\n${t.slice(lineStart)}`;
  }
  const imp = `import ${n.component} from ${q}${importPath(p.routerFile, p.file, { ...c, importStyle: 'relative' }).replace(/\.tsx$/, '')}${q}${semi}`;
  const imports = [...t.matchAll(/^import[^\n]*\n/gm)];
  const at = imports.length ? imports[imports.length - 1].index! + imports[imports.length - 1][0].length : 0;
  return t.slice(0, at) + imp + '\n' + t.slice(at);
}

function paramsCode(params: string[]): { imports: string[]; lines: string[] } {
  if (!params.length) return { imports: [], lines: [] };
  return { imports: [`import { useParams } from 'react-router-dom';`], lines: [`  const { ${params.map((p) => `${p} = ''`).join(', ')} } = useParams();`] };
}

function finish(root: string, skill: string, p: Placement, page: string, map: ProjectMap, opts: Opts, summary: string[], warnings: string[]): ChangeSet {
  const files = new Map([
    [p.file, page],
    [p.routerFile, register(p, map, opts)],
  ]);
  summary.push(`Update ${p.routerFile}: add ${p.route}`);
  summary.push(`Open it with: <Link to=${p.route.includes(':') ? `{\`${p.route.replace(/:(\w+)/g, '${$1}')}\`}` : `"${p.route}"`}> or navigate(...)`);
  return buildChangeSet(root, skill, { files, summary, warnings, generated: [] });
}

export function planReactRoute(root: string, map: ProjectMap, opts: Opts): ChangeSet {
  const p = place(root, map, opts);
  if (exists(join(root, p.file))) throw new ToolError('route_exists', `${p.file} already exists.`);
  const n = names(opts.name);
  const params = routeParamsOf(p.route);
  const pc = paramsCode(params);
  const page = [...pc.imports, ...(pc.imports.length ? [''] : []), `export default function ${n.component}() {`, ...pc.lines, '  return (', '    <main>', `      <h1>${n.title}${params.length ? ` {${params[0]}}` : ''}</h1>`, '    </main>', '  );', '}', ''].join('\n');
  return finish(root, 'route add', p, page, map, opts, [`Create ${p.file}: ${n.component}`], []);
}

/** The installed TanStack Query major version (5 when it cannot be read). */
export function queryMajor(root: string): number {
  const pkg = readText(join(root, 'package.json')) ?? '';
  return Number(/"@tanstack\/react-query"\s*:\s*"[^\d]*(\d+)/.exec(pkg)?.[1] ?? 5);
}

function findEp(map: ProjectMap, name: string): EndpointInfo {
  const ep = map.endpoints.find((e) => e.name === name) ?? map.endpoints.find((e) => e.name.toLowerCase() === name.toLowerCase());
  if (!ep) throw new ToolError('no_endpoint', `No endpoint called ${name} was found.`, map.endpoints.length ? `Endpoints: ${map.endpoints.map((e) => e.name).join(', ')}` : 'Add one first with: codz api add');
  return ep;
}

function callArgs(root: string, ep: EndpointInfo, params: string[], skip: (name: string) => boolean = () => false) {
  const decl = findDeclaration(readText(join(root, ep.file)) ?? '', ep.name, 'ts');
  if (!decl) throw new ToolError('no_endpoint', `Could not read ${ep.name} in ${ep.file}.`);
  const ps = splitTsParams(decl.params);
  const missing = ps.filter((x) => !x.optional && !skip(x.name) && !params.includes(x.name)).map((x) => x.name);
  const args = ps.filter((x) => !skip(x.name) && params.includes(x.name)).map((x) => (/^number$/.test(x.type) ? `Number(${x.name})` : x.name));
  return { args: args.join(', '), missing, decl, ps };
}

function hookFor(root: string, map: ProjectMap, ep: EndpointInfo): { name: string; file: string } | null {
  if (map.conventions.dataFetching !== 'react-query' || !map.conventions.hooksFolder) return null;
  for (const f of walk(root, map.conventions.hooksFolder, { exts: ['.ts', '.tsx'] })) {
    const t = readText(join(root, f)) ?? '';
    const m = new RegExp(`export function (use\\w+)\\([^)]*\\)\\s*\\{\\s*return useQuery\\(\\{[^}]*?queryFn: \\(\\) => ${ep.name}\\(`).exec(t);
    if (m) return { name: m[1], file: f };
  }
  return null;
}

function apiImport(root: string, map: ProjectMap, from: string, ep: EndpointInfo): string {
  const dir = posix.dirname(ep.file);
  const barrel = [`${dir}/index.ts`].find((f) => exists(join(root, f)) && /export\s+\*\s+from/.test(readText(join(root, f)) ?? ''));
  return importPath(from, barrel ?? ep.file, map.conventions).replace(/\.tsx?$/, '');
}

export function planReactScreen(root: string, map: ProjectMap, opts: Opts): ChangeSet {
  if (!opts.api) return planReactRoute(root, map, opts);
  const ep = findEp(map, opts.api);
  if (opts.form) return planReactForm(root, map, opts, ep);
  if (ep.method !== 'GET') throw new ToolError('screen_needs_get', `${ep.name} is a ${ep.method} endpoint; a page loads data with a GET.`, 'For a form that sends it, add --form.');
  const p = place(root, map, opts);
  if (exists(join(root, p.file))) throw new ToolError('route_exists', `${p.file} already exists.`);
  const n = names(opts.name);
  const params = routeParamsOf(p.route);
  const { args, missing, decl } = callArgs(root, ep, params);
  if (missing.length) throw new ToolError('screen_args', `${ep.name}() needs ${missing.join(', ')}, which the page does not have.`, `Give the route a matching parameter, for example: --path /${kebab(n.base)}/:${missing[0]}`);
  const shape = responseShape(decl!.returnType, map);
  const tf = titleField(shape.model);
  const idf = shape.model?.fields.find((f) => /^(id|uuid|key|slug)$/.test(f.name))?.name;
  const pc = paramsCode(params);
  const hook = hookFor(root, map, ep);
  const c = map.conventions;
  const T = shape.raw || 'unknown';
  const access = (v: string, f: string) => (IDENT.test(f) ? `${v}.${f}` : `${v}['${f}']`);
  if (opts.paginate || opts.search) {
    if (!shape.list) throw new ToolError('screen_not_list', `${ep.name}() returns one ${T}, not a list; --paginate and --search are for list screens.`);
    const ps = splitTsParams(decl!.params);
    const paging = detectPaging(tsPagingParams(ps), { paginate: opts.paginate, search: opts.search, modelStringFields: (shape.model?.fields ?? []).filter((f) => f.type === 'string').map((f) => f.name), titleField: tf });
    const routeArgs = new Map(ps.filter((x) => params.includes(x.name)).map((x) => [x.name, /^number$/.test(x.type) ? `Number(${x.name})` : x.name]));
    const item = shape.model?.name ?? T.replace(/\[\]$/, '');
    const logic = tsPagedLogic(paging, { T: item, call: (v) => `${ep.name}(${tsPagingArgs(ps, paging, routeArgs, v)})`, key: kebab(ep.name), deps: params, reactQuery: c.dataFetching === 'react-query' && queryMajor(root) >= 5, refresh: false, hasMore: true, access });
    const searchable = paging.search || paging.clientSearch;
    const pagedPage = [
      ...(logic.imports.react.length ? [`import { ${logic.imports.react.sort().join(', ')} } from 'react';`] : []),
      ...(logic.imports.query.length ? [`import { ${logic.imports.query.join(', ')} } from '@tanstack/react-query';`] : []),
      ...pc.imports,
      `import { ${ep.name} } from '${apiImport(root, map, p.file, ep)}';`,
      ...(shape.model ? [`import type { ${shape.model.name} } from '${importPath(p.file, shape.model.file, c).replace(/\.tsx?$/, '')}';`] : []),
      '',
      ...logic.top,
      `export default function ${n.component}() {`,
      ...pc.lines,
      ...logic.body,
      '',
      '  return (',
      '    <main>',
      `      <h1>${n.title}</h1>`,
      ...(searchable ? ['      <input type="search" placeholder="Search" aria-label="Search" value={query} onChange={(e) => setQuery(e.target.value)} />'] : []),
      '      {error ? (',
      '        <div role="alert">',
      '          <p>{error instanceof Error ? error.message : String(error)}</p>',
      '          <button type="button" onClick={() => retry()}>Retry</button>',
      '        </div>',
      '      ) : null}',
      '      {shown.length === 0 ? (',
      `        loading || error ? null : <p>${searchable ? `{query.trim() ? 'No matches.' : 'Nothing here yet.'}` : 'Nothing here yet.'}</p>`,
      '      ) : (',
      '        <ul>',
      `          {shown.map((${idf ? 'item' : 'item, index'}) => (`,
      `            <li key={${idf ? `String(${access('item', idf)})` : 'index'}}>{${tf ? `String(${access('item', tf)})` : 'JSON.stringify(item)'}}</li>`,
      '          ))}',
      '        </ul>',
      '      )}',
      '      {loading ? <p>Loading…</p> : null}',
      ...(paging.paginate ? ['      {hasMore && !loading && !error ? (', '        <button type="button" onClick={loadMore}>Load more</button>', '      ) : null}'] : []),
      '    </main>',
      '  );',
      '}',
      '',
    ].join('\n');
    return finish(root, 'screen add', p, pagedPage, map, opts, [`Create ${p.file}: ${n.component} lists ${ep.name}() and ${pagingSummary(paging, 'button')}`], pagingWarnings(paging));
  }
  const view = shape.list
    ? [
        '      {data.length === 0 ? (',
        '        <p>Nothing here yet.</p>',
        '      ) : (',
        '        <ul>',
        `          {data.map((${idf ? 'item' : 'item, index'}) => (`,
        `            <li key={${idf ? `String(${access('item', idf)})` : 'index'}}>{${tf ? `String(${access('item', tf)})` : 'JSON.stringify(item)'}}</li>`,
        '          ))}',
        '        </ul>',
        '      )}',
      ]
    : [
        '      <dl>',
        ...(shape.model?.fields.length ? shape.model.fields.flatMap((f) => [`        <dt>${f.name}</dt>`, `        <dd>{String(${access('data', f.name)} ?? '')}</dd>`]) : ['        <pre>{JSON.stringify(data, null, 2)}</pre>']),
        '      </dl>',
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
  const page = [
    ...(hook ? [] : [`import { useCallback, useEffect, useState } from 'react';`]),
    ...pc.imports,
    hook ? `import { ${hook.name} } from '${importPath(p.file, hook.file, c).replace(/\.tsx?$/, '')}';` : `import { ${ep.name} } from '${apiImport(root, map, p.file, ep)}';`,
    ...(shape.model && !hook ? [`import type { ${shape.model.name} } from '${importPath(p.file, shape.model.file, c).replace(/\.tsx?$/, '')}';`] : []),
    '',
    `export default function ${n.component}() {`,
    ...pc.lines,
    ...stateLines,
    '',
    '  if (loading && !data) return <p>Loading…</p>;',
    '  if (error) {',
    '    return (',
    '      <div role="alert">',
    '        <p>{error instanceof Error ? error.message : String(error)}</p>',
    '        <button type="button" onClick={() => load()}>Retry</button>',
    '      </div>',
    '    );',
    '  }',
    '  if (!data) return null;',
    '  return (',
    '    <main>',
    `      <h1>${n.title}</h1>`,
    ...view,
    '    </main>',
    '  );',
    '}',
    '',
  ].join('\n');
  return finish(root, 'screen add', p, page, map, opts, [`Create ${p.file}: ${n.component} loads ${hook ? `${hook.name}()` : `${ep.name}()`} and shows loading, the error with Retry, and the data`], []);
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

function planReactForm(root: string, map: ProjectMap, opts: Opts, ep: EndpointInfo): ChangeSet {
  if (ep.method === 'GET' || ep.method === 'HEAD') throw new ToolError('form_needs_body', `${ep.name} is a ${ep.method} endpoint; a form sends data with POST, PUT or PATCH.`);
  const p = place(root, map, opts);
  if (exists(join(root, p.file))) throw new ToolError('route_exists', `${p.file} already exists.`);
  const n = names(opts.name);
  const params = routeParamsOf(p.route);
  const { args, missing, ps } = callArgs(root, ep, params, (x) => x === 'body');
  if (missing.length) throw new ToolError('screen_args', `${ep.name}() needs ${missing.join(', ')}, which the page does not have.`, `Give the route a matching parameter, for example: --path /${kebab(n.base)}/:${missing[0]}`);
  const body = ps.find((x) => x.name === 'body');
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
  const pc = paramsCode(params);
  const c = map.conventions;
  const input = (x: (typeof usable)[number]) => {
    const id = kebab(x.f.name);
    if (x.k === 'bool') return [`        <label>`, `          <input type="checkbox" checked={${get(x.f.name)}} onChange={(e) => setValues({ ...values, ${key(x.f.name)}: e.target.checked })} />`, `          ${x.f.name}`, '        </label>'].join('\n');
    const type = x.k === 'number' ? 'number' : /email/i.test(x.f.name) ? 'email' : 'text';
    return [
      `        <label htmlFor="${id}">${x.f.name}${x.required ? ' *' : ''}</label>`,
      `        <input id="${id}" type="${type}"${x.required ? ' required' : ''}${x.k === 'strings' ? ' placeholder="a, b, c"' : ''} value={${get(x.f.name)}} onChange={(e) => setValues({ ...values, ${key(x.f.name)}: e.target.value })} />`,
    ].join('\n');
  };
  const pre = reactPrefill(root, map, opts.load, usable.map((x) => ({ json: x.f.name, kind: x.k! })), params, key);
  const apiFrom = apiImport(root, map, p.file, ep);
  const preFrom = pre ? apiImport(root, map, p.file, pre.ep) : '';
  const page = [
    `import { ${pre ? 'useEffect, ' : ''}useState, type FormEvent } from 'react';`,
    `import { ${params.length ? 'useNavigate, useParams' : 'useNavigate'} } from 'react-router-dom';`,
    ...(pre && preFrom === apiFrom ? [`import { ${[ep.name, pre.ep.name].sort().join(', ')} } from '${apiFrom}';`] : [`import { ${ep.name} } from '${apiFrom}';`, ...(pre ? [`import { ${pre.ep.name} } from '${preFrom}';`] : [])]),
    `import type { ${model.name} } from '${importPath(p.file, model.file, c).replace(/\.tsx?$/, '')}';`,
    '',
    `export default function ${n.component}() {`,
    ...pc.lines,
    '  const navigate = useNavigate();',
    `  const [values, setValues] = useState({ ${usable.map((x) => `${key(x.f.name)}: ${x.k === 'bool' ? 'false' : "''"}`).join(', ')} });`,
    '  const [saving, setSaving] = useState(false);',
    '  const [error, setError] = useState<string | null>(null);',
    ...(pre?.lines ?? []),
    '',
    '  async function submit(e: FormEvent<HTMLFormElement>) {',
    '    e.preventDefault();',
    '    setSaving(true);',
    '    setError(null);',
    '    try {',
    `      const body: ${partial ? `Partial<${model.name}>` : model.name} = {`,
    ...usable.map((x) => `        ${key(x.f.name)}: ${value(x)},`),
    '      };',
    `      await ${ep.name}(${[args, 'body'].filter(Boolean).join(', ')});`,
    '      navigate(-1);',
    '    } catch (err) {',
    '      setError(err instanceof Error ? err.message : String(err));',
    '    } finally {',
    '      setSaving(false);',
    '    }',
    '  }',
    '',
    '  return (',
    '    <main>',
    `      <h1>${n.title}</h1>`,
    '      <form onSubmit={submit}>',
    ...usable.map(input),
    '        {error && <p role="alert">{error}</p>}',
    `        <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>`,
    '      </form>',
    '    </main>',
    '  );',
    '}',
    '',
  ].join('\n');
  return finish(root, 'screen add', p, page, map, opts, [`Create ${p.file}: a form for ${model.name} (${usable.length} field${usable.length === 1 ? '' : 's'}) that calls ${ep.name}() and goes back after saving`], []);
}
