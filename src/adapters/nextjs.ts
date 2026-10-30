// Next.js adapter. Supported setup: App Router, TypeScript, fetch (directly
// or through a shared helper such as apiFetch) or axios (an axios.create
// instance, or axios itself), optionally with TanStack Query hooks. The Pages
// Router is detected and reported as not supported yet.


import { join } from 'node:path';
import { detectEol, exists, readText, walk, withEol } from '../core/fsutil.ts';
import { ToolError, type Adapter, type AdapterContext, type EndpointSpec, type PlannedEdits } from '../core/types.ts';
import { fileName, plural, singular, type FileNaming } from '../input/naming.ts';
import { referencedModels, resolveModels } from './models.ts';
import { nextArchitectures, planNextSetup } from './nextjsSetup.ts';
import { renderQueryHook, splitTsParams } from './reactQuery.ts';
import { applyTemplate } from '../core/templates.ts';
import { addDefaultImport, addImports, appendBlock, chooseBase, findTsBlock, importPath, renderFunction, renderInterface, resourceOf, styled, tsType, type Gen } from './nextjsGen.ts';
import { baseNoExt, dirOf, scan } from './nextjsScan.ts';

// Other modules import these from here.
export { findTsBlock, importPath } from './nextjsGen.ts';
export { stripJsonc } from './nextjsScan.ts';

export const VERSION = '0.1.0';

export const NEXT_CONVENTION_DOCS: Record<string, string> = {
  templatesFolder: 'folder with custom templates (devtool templates list)',
  appDir: 'App Router folder',
  apiFolder: 'where API functions live',
  apiFileNaming: 'file naming in the API folder: kebab, camel, pascal or snake',
  apiFileSuffix: 'word after the resource in API file names (for example "service"), or empty',
  apiFileResource: 'resource form in API file names: plural (users.ts) or singular (user.ts)',
  httpHelper: 'shared request helper to call, or "fetch" to call fetch directly',
  httpHelperFile: 'file that exports the request helper',
  baseUrlEnv: 'environment variable that holds the API base URL',
  modelsFolder: 'where TypeScript interfaces for API data live',
  modelsLayout: 'per-file (one interface per file) or single (all in modelsFile)',
  modelsFile: 'the single models file, when modelsLayout is single',
  modelFileNaming: 'file naming in the models folder',
  importAlias: 'path alias prefix from tsconfig, for example @/',
  aliasBase: 'folder the alias points to ("." for the project root)',
  importStyle: 'how API files import models: alias or relative',
  quote: 'string quote: single or double',
  semicolons: 'true or false',
  indent: 'indentation: 2, 4 or tab',
  http: 'HTTP client: fetch or axios',
  axiosInstance: 'axios instance API functions call (axios: the name exported from axiosInstanceFile, or "axios")',
  axiosInstanceFile: 'file that creates the axios instance with axios.create (axios only)',
  dataFetching: 'react-query to also write a TanStack Query hook for each endpoint, or none',
  hooksFolder: 'where the query hooks go (react-query only)',
  i18n: 'internationalization library, if any',
  styling: 'styling library, if any',
};


async function planEndpoint(ctx: AdapterContext, input: EndpointSpec, overlay?: Map<string, string>, opts: { replaceModels?: boolean; targetFile?: string } = {}): Promise<PlannedEdits> {
  const { root, map } = ctx;
  const c = map.conventions;
  const files = new Map<string, string>(overlay ?? []);
  const read = (p: string) => files.get(p) ?? readText(join(root, p));
  const summary: string[] = [];
  const warnings: string[] = [...input.warnings];
  const { spec, reused, replaced, notes } = resolveModels(input, map.models, (n) => n, { replace: opts.replaceModels });
  warnings.push(...notes);

  // Same endpoint already present?
  const sameName = map.endpoints.find((e) => e.name === spec.name);
  if (sameName) {
    const base0 = chooseBase(spec, map, root);
    if (sameName.method === spec.method && sameName.path.replace(/\{\w+\}/g, '{}') === base0.path.replace(/\{\w+\}/g, '{}')) {
      return { files, summary: [`${spec.name} already exists in ${sameName.file}; nothing to do.`], warnings: [], generated: [] };
    }
    throw new ToolError('name_conflict', `A function called ${spec.name} already exists in ${sameName.file} for ${sameName.method} ${sameName.path}.`, 'Pass --name <functionName> to use another name.');
  }

  const quote = c.quote === 'double' ? '"' : "'";
  const indent = c.indent === 'tab' ? '\t' : ' '.repeat(Number(c.indent) || 2);
  const g: Gen = { c, style: { quote, semi: c.semicolons !== 'false', indent }, q: quote };

  // Where each model lives (new or reused).
  const modelFile = new Map<string, string>();
  for (const [name, info] of reused) modelFile.set(name, info.file);
  for (const m of spec.models) {
    modelFile.set(m.name, replaced.get(m.name)?.file ?? (c.modelsLayout === 'single' && c.modelsFile ? c.modelsFile : `${c.modelsFolder}/${fileName(m.name, c.modelFileNaming as FileNaming)}.ts`));
  }

  // Write models.
  const newModelFiles: string[] = [];
  for (const m of spec.models) {
    const file = modelFile.get(m.name)!;
    const existing = read(file);
    let content = existing ?? '';
    const block = existing ? findTsBlock(existing, m.name) : null;
    if (block && !replaced.has(m.name)) continue;
    const deps = new Set<string>();
    for (const f of m.fields) referencedModels(f.type, deps);
    const byFile = new Map<string, string[]>();
    for (const d of deps) {
      const df = modelFile.get(d);
      if (!df || df === file) continue;
      byFile.set(df, [...(byFile.get(df) ?? []), d]);
    }
    const rendered = applyTemplate(root, 'model.ts', styled(renderInterface(m, g), g), { name: m.name }, warnings);
    content = block ? content.slice(0, block.start) + rendered + content.slice(block.end) : appendBlock(content, rendered);
    for (const [df, names] of [...byFile.entries()].sort()) content = addImports(content, importPath(file, df, { ...c, importStyle: c.modelsLayout === 'single' ? c.importStyle : 'relative' }), names, true, g);
    if (existing === null) newModelFiles.push(file);
    files.set(file, existing === null ? content : withEol(content, detectEol(existing)));
    summary.push(`${existing === null ? 'Create' : 'Update'} ${file}: interface ${m.name}${block ? ' (rewritten)' : ''}`);
  }

  // Models barrel file.
  const modelsIndex = `${c.modelsFolder}/index.ts`;
  const modelsIndexText = read(modelsIndex);
  if (modelsIndexText && /export \* from/.test(modelsIndexText)) {
    let t = modelsIndexText;
    for (const f of newModelFiles) {
      const spec2 = `./${baseNoExt(f)}`;
      if (f === modelsIndex || t.includes(`'${spec2}'`) || t.includes(`"${spec2}"`)) continue;
      t = t.replace(/\s*$/, '\n') + `export * from ${quote}${spec2}${quote}${g.style.semi ? ';' : ''}\n`;
    }
    if (t !== modelsIndexText) {
      files.set(modelsIndex, withEol(t, detectEol(modelsIndexText)));
      summary.push(`Update ${modelsIndex}: export the new models`);
    }
  }

  // API function file.
  const resource = spec.resource;
  const existingForResource = map.endpoints.find((e) => resourceOf(e.path) === resourceOf(spec.path) && dirOf(e.file) === c.apiFolder);
  let apiFile: string;
  if (opts.targetFile) {
    apiFile = opts.targetFile;
  } else if (existingForResource) {
    apiFile = existingForResource.file;
  } else {
    const word = c.apiFileResource === 'singular' ? singular(resource) : plural(singular(resource));
    apiFile = `${c.apiFolder}/${fileName(c.apiFileSuffix ? `${word} ${c.apiFileSuffix}` : word, c.apiFileNaming as FileNaming)}.ts`;
  }
  const apiExisting = read(apiFile);
  if (apiExisting && new RegExp(`(function|const)\\s+${spec.name}\\b`).test(apiExisting)) {
    throw new ToolError('name_conflict', `${apiFile} already defines ${spec.name}.`, 'Pass --name <functionName> to use another name.');
  }
  const base = chooseBase(spec, map, root);
  warnings.push(...base.warnings);
  const fnText = styled(renderFunction(spec, base, g), g);
  const fnParams = new RegExp(`function\\s+${spec.name}\\s*\\(([^)]*)\\)`).exec(fnText)?.[1] ?? '';
  const fnReturn = fnText.match(/\):\s*Promise<(.+)>\s*\{/)?.[1] ?? '';
  let apiText = appendBlock(apiExisting ?? '', applyTemplate(root, 'api-function.ts', fnText, { name: spec.name, method: spec.method, path: base.path, params: fnParams, returnType: fnReturn }, warnings));
  const typeNames = new Set<string>();
  referencedModels(spec.response, typeNames);
  referencedModels(spec.request, typeNames);
  const typesByFile = new Map<string, string[]>();
  for (const t of typeNames) {
    const f = modelFile.get(t)!;
    typesByFile.set(f, [...(typesByFile.get(f) ?? []), t]);
  }
  for (const [f, names] of [...typesByFile.entries()].sort()) apiText = addImports(apiText, importPath(apiFile, f, c), names, true, g);
  if (c.http === 'axios') {
    const inst = c.axiosInstance || 'axios';
    if (inst === 'axios' || !c.axiosInstanceFile) apiText = addDefaultImport(apiText, 'axios', 'axios', g);
    else {
      let p = importPath(apiFile, c.axiosInstanceFile, { ...c, importStyle: 'relative' });
      if (dirOf(c.axiosInstanceFile) !== dirOf(apiFile)) p = importPath(apiFile, c.axiosInstanceFile, c);
      apiText = inst.startsWith('default:') ? addDefaultImport(apiText, p, inst.slice(8), g) : addImports(apiText, p, [inst], false, g);
    }
  } else if (base.kind === 'helper') {
    let helperPath = importPath(apiFile, c.httpHelperFile, { ...c, importStyle: 'relative' });
    if (dirOf(c.httpHelperFile) !== dirOf(apiFile)) helperPath = importPath(apiFile, c.httpHelperFile, c);
    apiText = addImports(apiText, helperPath, [c.httpHelper], false, g);
  }
  files.set(apiFile, apiExisting === null ? apiText : withEol(apiText, detectEol(apiExisting)));
  summary.push(`${apiExisting === null ? 'Create' : 'Update'} ${apiFile}: ${spec.name}() for ${spec.method} ${spec.path}`);

  // API barrel file.
  if (apiExisting === null) {
    const apiIndex = `${c.apiFolder}/index.ts`;
    const indexText = read(apiIndex);
    if (indexText !== null && /export \* from/.test(indexText)) {
      const spec2 = `./${baseNoExt(apiFile)}`;
      if (!indexText.includes(`'${spec2}'`) && !indexText.includes(`"${spec2}"`)) {
        const t = indexText.replace(/\s*$/, '\n') + `export * from ${quote}${spec2}${quote}${g.style.semi ? ';' : ''}\n`;
        files.set(apiIndex, withEol(t, detectEol(indexText)));
        summary.push(`Update ${apiIndex}: export ${spec2}`);
      }
    } else if (indexText !== null) {
      warnings.push(`${apiIndex} does not use "export * from", so the new file was not added to it.`);
    }
  }

  // TanStack Query hook.
  if (c.dataFetching === 'react-query') {
    const sig = new RegExp(`export\\s+(?:async\\s+)?function\\s+${spec.name}\\s*\\(([^)]*)\\)`).exec(apiText);
    const hooksFolder = c.hooksFolder || (c.appDir?.startsWith('src/') ? 'src/hooks' : 'hooks');
    const fromHook = (hf: string) => [importPath(hf, apiFile, c), importPath(hf, apiFile, { ...c, importStyle: 'relative' })];
    const hookFiles = [...new Set([...walk(root, hooksFolder, { exts: ['.ts', '.tsx'] }), ...[...files.keys()].filter((f) => dirOf(f) === hooksFolder)])].sort();
    let hookFile = hookFiles.find((hf) => fromHook(hf).some((ip) => new RegExp(`from\\s*['"]${ip.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}['"]`).test(read(hf) ?? '')));
    if (!hookFile) {
      const camelNames = hookFiles.some((hf) => /^use[A-Z]/.test(baseNoExt(hf)));
      const word = c.apiFileResource === 'singular' ? singular(resourceOf(base.path)) : plural(singular(resourceOf(base.path)));
      hookFile = `${hooksFolder}/${fileName(`use ${word}`, camelNames ? 'camel' : 'kebab')}.ts`;
    }
    const hookExisting = read(hookFile);
    const hook = renderQueryHook(spec, spec.name, splitTsParams(sig?.[1] ?? ''), resourceOf(base.path), { q: quote, semi: g.style.semi ? ';' : '', indent });
    if (sig && !new RegExp(`\\b(?:function|const)\\s+${hook.name}\\b`).test(hookExisting ?? '')) {
      let ht = appendBlock(hookExisting ?? '', hook.code);
      ht = addImports(ht, '@tanstack/react-query', hook.uses, false, g);
      ht = addImports(ht, importPath(hookFile, apiFile, c), [spec.name], false, g);
      const used = [...typesByFile.entries()].map(([f, names]) => [f, names.filter((n) => new RegExp(`\\b${n}\\b`).test(sig[1]))] as const).filter(([, n]) => n.length);
      for (const [f, names] of used) ht = addImports(ht, importPath(hookFile, f, c), [...names], true, g);
      files.set(hookFile, hookExisting === null ? ht : withEol(ht, detectEol(hookExisting)));
      summary.push(`${hookExisting === null ? 'Create' : 'Update'} ${hookFile}: ${hook.name}() (TanStack Query ${spec.method === 'GET' ? 'query' : 'mutation'})`);
    }
  }

  return {
    files,
    summary,
    warnings,
    generated: [{ skill: 'api add', file: apiFile, symbol: spec.name, inputHash: '' }],
    endpoints: [{ name: spec.name, method: spec.method, path: base.path, response: spec.response ? tsType(spec.response) : undefined, file: apiFile, calledFrom: [] }],
    models: spec.models.map((m) => ({ name: m.name, file: modelFile.get(m.name)!, fields: m.fields.map((f) => ({ name: f.jsonName, type: tsType(f.type), nullable: f.nullable })) })),
  };
}

export const nextjsAdapter: Adapter = {
  id: 'nextjs',
  version: VERSION,
  capabilities: { explain: true, apiAdd: true },
  supportedSetup: 'Next.js App Router, TypeScript, fetch (directly or through a shared helper) or axios, optionally with TanStack Query hooks. Not yet: Pages Router, SWR.',
  scan,
  planEndpoint,
  architectures: nextArchitectures,
  planSetup: planNextSetup,
  formatCommand(root, files) {
    const bin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'prettier.cmd' : 'prettier');
    if (!exists(bin)) return null;
    return { cmd: bin, args: ['--write', ...files] };
  },
  verifyCommand(root) {
    const bin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
    if (!exists(bin) || !exists(join(root, 'tsconfig.json'))) return null;
    return { cmd: bin, args: ['--noEmit', '-p', 'tsconfig.json', '--pretty', 'false'] };
  },
};

