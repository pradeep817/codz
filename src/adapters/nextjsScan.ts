// Next.js adapter, part 1: reading a project (conventions, endpoints, models,
// routes, locales) into a ProjectMap.

import { join, posix } from 'node:path';
import { isDir, readJson, readText, walk } from '../core/fsutil.ts';
import { type Conventions, type HttpMethod, type ModelInfo, type ProjectMap, type RouteInfo } from '../core/types.ts';
import { detectFileNaming } from '../input/naming.ts';
import { emptyMap, fileStats, listRootEnvFiles, scanEnvBaseUrls, scanLocales } from './common.ts';
import { detectTsStyle, matchBrace, skipString } from './source.ts';
import { VERSION } from './nextjs.ts';

const CODE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];

interface Pkg {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Removes comments and trailing commas from JSONC (tsconfig.json), leaving strings untouched. */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] !== '}' && text[j] !== ']') out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function readTsconfig(root: string): { paths?: Record<string, string[]>; baseUrl?: string } {
  const text = readText(join(root, 'tsconfig.json'));
  if (!text) return {};
  const cleaned = stripJsonc(text);
  try {
    const json = JSON.parse(cleaned) as { compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string } };
    return json.compilerOptions ?? {};
  } catch {
    return {};
  }
}

export const dirOf = (f: string) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.');
export const baseNoExt = (f: string) => f.slice(f.lastIndexOf('/') + 1).replace(/\.(tsx?|jsx?|mjs)$/, '');

export function mostCommon<T>(items: T[], fallback: T): T {
  const counts = new Map<T, number>();
  for (const i of items) counts.set(i, (counts.get(i) ?? 0) + 1);
  let best = fallback;
  let n = 0;
  for (const [k, v] of counts) if (v > n) [best, n] = [k, v];
  return best;
}

/** Resolves an import specifier to a project-relative path without extension. */
export function resolveImport(fromFile: string, spec: string, alias: string, aliasBase: string): string | null {
  if (alias && spec.startsWith(alias)) return posix.normalize(posix.join(aliasBase === '.' ? '' : aliasBase, spec.slice(alias.length)));
  if (spec.startsWith('.')) return posix.normalize(posix.join(dirOf(fromFile), spec));
  return null;
}

interface FunctionBlock {
  name: string;
  params: string;
  returnType: string;
  body: string;
}

function exportedFunctions(text: string): FunctionBlock[] {
  const out: FunctionBlock[] = [];
  const re = /export\s+(?:async\s+)?function\s+(\w+)\s*(?:<[^>()]*>)?\s*\(|export\s+const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:<[^>()]*>)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const name = m[1] ?? m[2];
    const open = m.index + m[0].length - 1;
    const close = matchBrace(text, open);
    if (close === -1) continue;
    const params = text.slice(open + 1, close);
    let i = close + 1;
    const arrow = text.indexOf('=>', i);
    const brace = text.indexOf('{', i);
    let returnType = '';
    let bodyStart: number;
    if (m[2] !== undefined) {
      if (arrow === -1) continue;
      returnType = text.slice(i, arrow).replace(/^\s*:\s*/, '').trim();
      i = arrow + 2;
      while (/\s/.test(text[i])) i++;
      bodyStart = i;
    } else {
      if (brace === -1) continue;
      returnType = text.slice(i, brace).replace(/^\s*:\s*/, '').trim();
      bodyStart = brace;
    }
    let bodyEnd: number;
    if (text[bodyStart] === '{') bodyEnd = matchBrace(text, bodyStart);
    else {
      const nl = text.indexOf('\n\n', bodyStart);
      bodyEnd = nl === -1 ? text.length : nl;
    }
    if (bodyEnd === -1) continue;
    out.push({ name, params, returnType, body: text.slice(bodyStart, bodyEnd + 1) });
    re.lastIndex = bodyEnd;
  }
  return out;
}

/** Finds the URL argument of a fetch/helper call and turns it into a path with {params}. */
function callPath(body: string, callee: RegExp): string | null {
  const m = callee.exec(body);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (/\s/.test(body[i])) i++;
  const q = body[i];
  if (q !== '`' && q !== "'" && q !== '"') return null;
  const end = skipString(body, i, 'ts');
  const literal = body.slice(i + 1, end - 1);
  // Walk interpolations with brace matching, so nested template literals are handled.
  let raw = '';
  let j = 0;
  let first = true;
  while (j < literal.length) {
    if (q === '`' && literal[j] === '$' && literal[j + 1] === '{') {
      const close = matchBrace(literal, j + 1);
      if (close === -1) return null;
      const expr = literal.slice(j + 2, close).trim();
      if (first && raw === '') {
        // A leading interpolation is the base URL.
      } else if (/^[A-Za-z_$][\w$]*(\??\.[A-Za-z_$][\w$]*)*$/.test(expr)) {
        raw += `{${expr.split('.').pop()!.replace('?', '')}}`;
      } else {
        // Anything else (a ternary, a call) builds the query string; it is not part of the path.
      }
      first = false;
      j = close + 1;
      continue;
    }
    raw += literal[j];
    first = false;
    j++;
  }
  raw = raw.split('?')[0];
  if (!raw.startsWith('/')) return null;
  return raw;
}

function parseInterfaces(text: string, file: string): ModelInfo[] {
  const out: ModelInfo[] = [];
  const re = /export\s+(?:interface\s+(\w+)(?:<[^>]*>)?(?:\s+extends\s+[^{]+)?|type\s+(\w+)(?:<[^>]*>)?\s*=)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(text, open);
    if (close === -1) continue;
    const body = text.slice(open + 1, close);
    const fields: ModelInfo['fields'] = [];
    let depth = 0;
    for (const line of body.split('\n')) {
      if (depth === 0) {
        const f = line.match(/^\s*(?:readonly\s+)?['"]?([\w$-]+)['"]?(\?)?\s*:\s*([^;\n]+?)\s*[;,]?\s*$/);
        if (f) fields.push({ name: f[1], type: f[3].replace(/\s*\|\s*null/, '').replace(/\{$/, 'object').trim(), nullable: !!f[2] || /\|\s*null/.test(f[3]) });
      }
      depth += (line.match(/[{(]/g) ?? []).length - (line.match(/[})]/g) ?? []).length;
    }
    out.push({ name: m[1] ?? m[2], file, fields });
    re.lastIndex = close;
  }
  return out;
}

export async function scan(root: string, configConventions: Conventions): Promise<ProjectMap> {
  const map = emptyMap('nextjs', `nextjs@${VERSION}`);
  const files = walk(root);
  map.stats = fileStats(files);
  const code = files.filter((f) => CODE_EXTS.some((e) => f.endsWith(e)) && !f.endsWith('.d.ts') && !/(^|\/)(next|tailwind|postcss|eslint)\.config\./.test(f));
  const texts = new Map<string, string>();
  const text = (f: string) => {
    if (!texts.has(f)) texts.set(f, readText(join(root, f)) ?? '');
    return texts.get(f)!;
  };
  const pkg = readJson<Pkg>(join(root, 'package.json')) ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const c: Conventions = {};

  // App Router.
  c.appDir = isDir(join(root, 'src/app')) ? 'src/app' : isDir(join(root, 'app')) ? 'app' : '';
  if (!c.appDir) map.notes.push(isDir(join(root, 'pages')) || isDir(join(root, 'src/pages')) ? 'This project uses the Pages Router, which is not supported yet; routes are not mapped.' : 'No app folder found; routes are not mapped.');
  const src = c.appDir.startsWith('src/') || isDir(join(root, 'src')) ? 'src/' : '';
  const isUi = (f: string) => (c.appDir && f.startsWith(c.appDir + '/')) || /(^|\/)(components|hooks|pages|public|styles)\//.test(f) || /\.(tsx|jsx)$/.test(f);

  // Path alias.
  const tsc = readTsconfig(root);
  const aliasKey = Object.keys(tsc.paths ?? {}).find((k) => k.endsWith('/*'));
  c.importAlias = aliasKey ? aliasKey.slice(0, -1) : '';
  c.aliasBase = aliasKey ? posix.normalize(posix.join(tsc.baseUrl ?? '.', (tsc.paths![aliasKey][0] ?? './*').replace(/\/?\*$/, ''))) : '.';
  if (c.aliasBase === '') c.aliasBase = '.';

  // HTTP client and helper.
  c.http = deps.axios && code.some((f) => /from ['"]axios['"]/.test(text(f))) ? 'axios' : 'fetch';
  // axios: the shared instance (export const api = axios.create(...), or a default export).
  if (c.http === 'axios') {
    c.axiosInstance = '';
    c.axiosInstanceFile = '';
    for (const f of code) {
      const t = text(f);
      const m = t.match(/(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*axios\.create\s*\(/);
      if (!m) continue;
      const exported = new RegExp(`export\\s+(?:const|let)\\s+${m[1]}\\b|export\\s*\\{[^}]*\\b${m[1]}\\b[^}]*\\}`).test(t);
      const asDefault = new RegExp(`export\\s+default\\s+${m[1]}\\b`).test(t);
      if (!exported && !asDefault) continue;
      c.axiosInstance = exported ? m[1] : `default:${m[1]}`;
      c.axiosInstanceFile = f;
      break;
    }
    if (!c.axiosInstance) c.axiosInstance = 'axios';
  }
  const axiosName = (c.axiosInstance ?? '').replace(/^default:/, '');
  // TanStack Query: hooks next to the API functions when the project already uses it.
  const queryUsers = code.filter((f) => /from ['"]@tanstack\/react-query['"]/.test(text(f)));
  if (deps['@tanstack/react-query'] && queryUsers.some((f) => /\buse(?:Query|Mutation|SuspenseQuery)\s*[<(]/.test(text(f)))) {
    c.dataFetching = 'react-query';
    const hookFiles = queryUsers.filter((f) => /\bexport\s+(?:function|const)\s+use[A-Z]/.test(text(f)));
    c.hooksFolder = mostCommon(hookFiles.map(dirOf), `${src}hooks`);
    // Feature-first projects keep hooks in many feature folders; none of them is "the" hooks folder.
    const hookDirs = new Set(hookFiles.map(dirOf));
    if (hookDirs.size >= 3 && hookFiles.filter((f) => dirOf(f) === c.hooksFolder).length * 2 < hookFiles.length) c.hooksFolder = `${src}hooks`;
  }
  const axiosCall = axiosName && axiosName !== 'axios' ? new RegExp(`\\b${axiosName}\\.(?:get|post|put|patch|delete|head|request)\\s*[<(]`) : null;
  const fetchFiles = code.filter((f) => !isUi(f) && f !== c.axiosInstanceFile && (/\bfetch\s*\(|\baxios\b/.test(text(f)) || (axiosCall?.test(text(f)) ?? false)));
  let helper = '';
  let helperFile = '';
  for (const f of fetchFiles) {
    const m = text(f).match(/export\s+(?:async\s+)?function\s+(\w+)\s*<[^>]*>\s*\(\s*(\w+)\s*:\s*string|export\s+const\s+(\w+)\s*=\s*(?:async\s*)?<[^>]*>\s*\(\s*(\w+)\s*:\s*string/);
    if (m && /\bfetch\s*\(/.test(text(f))) {
      helper = m[1] ?? m[3];
      helperFile = f;
      break;
    }
  }
  c.httpHelper = helper || 'fetch';
  c.httpHelperFile = helperFile;
  const callerFiles = helper ? code.filter((f) => f !== helperFile && !isUi(f) && new RegExp(`\\b${helper}\\s*[<(]`).test(text(f))) : [];
  const apiFiles = [...new Set([...fetchFiles, ...callerFiles])].filter((f) => f !== helperFile || !helper);
  c.apiFolder = mostCommon(apiFiles.map(dirOf), helperFile ? dirOf(helperFile) : `${src}lib/api`);

  const apiFolderFiles = code.filter((f) => dirOf(f) === c.apiFolder && !/\/index\.[tj]s$/.test('/' + f) && f !== helperFile && f !== c.axiosInstanceFile);
  const apiBases = apiFolderFiles.map(baseNoExt);
  c.apiFileNaming = detectFileNaming(apiBases, 'kebab');
  const lastWords = apiBases.map((b) => b.split(/[-_]|(?=[A-Z])/).pop()!.toLowerCase());
  const suffix = mostCommon(lastWords.filter((w) => ['service', 'api', 'client', 'requests', 'endpoints'].includes(w)), '');
  const withSuffix = lastWords.filter((w) => w === suffix).length;
  // One file called client.ts next to users.ts is not a naming pattern; two of three is.
  c.apiFileSuffix = suffix && withSuffix * 2 >= lastWords.length && (withSuffix >= 2 || lastWords.length === 1) ? suffix : '';
  const resourceWords = apiBases.map((b) => (c.apiFileSuffix ? b.replace(new RegExp(`[-_]?${c.apiFileSuffix}$`, 'i'), '') : b));
  c.apiFileResource = resourceWords.length && resourceWords.filter((w) => /s$/i.test(w)).length * 2 < resourceWords.length ? 'singular' : 'plural';

  // Base URL.
  const envUse = apiFiles.concat(helperFile ? [helperFile] : []).map((f) => text(f).match(/process\.env\.(\w+)/)?.[1]).filter((x): x is string => !!x);
  c.baseUrlEnv = mostCommon(envUse, '');
  map.baseUrls = scanEnvBaseUrls(root, listRootEnvFiles(root));

  // Models.
  const modelFiles = code.filter((f) => !isUi(f) && /export\s+(interface|type)\s+\w+/.test(text(f)));
  const modelDirs = modelFiles.map(dirOf);
  const preferred = modelDirs.filter((d) => /(^|\/)(types|models|interfaces|entities)$/.test(d));
  c.modelsFolder = mostCommon(preferred.length ? preferred : modelDirs, `${src}types`);
  const inFolder = modelFiles.filter((f) => dirOf(f) === c.modelsFolder);
  const multi = inFolder.find((f) => (text(f).match(/export\s+(interface|type)\s+\w+/g) ?? []).length >= 2);
  c.modelsLayout = multi && inFolder.length <= 2 ? 'single' : 'per-file';
  c.modelsFile = c.modelsLayout === 'single' ? multi! : '';
  c.modelFileNaming = detectFileNaming(inFolder.map(baseNoExt).filter((b) => b !== 'index'), 'kebab');
  for (const f of modelFiles) map.models.push(...parseInterfaces(text(f), f));

  // Import style and code style.
  const apiTexts = apiFiles.map(text);
  const aliasImports = c.importAlias ? apiTexts.join('\n').split(`from '${c.importAlias}`).length + apiTexts.join('\n').split(`from "${c.importAlias}`).length - 2 : 0;
  const relImports = (apiTexts.join('\n').match(/from ['"]\.\.\//g) ?? []).length;
  c.importStyle = c.importAlias && (aliasImports >= relImports || apiTexts.length === 0) ? 'alias' : 'relative';
  const style = detectTsStyle(apiTexts.length ? apiTexts : code.slice(0, 20).map(text));
  c.quote = style.quote === '"' ? 'double' : 'single';
  c.semicolons = String(style.semi);
  c.indent = style.indent === '\t' ? 'tab' : String(style.indent.length);
  c.i18n = deps['next-intl'] ? 'next-intl' : deps['next-i18next'] ? 'next-i18next' : deps.i18next ? 'i18next' : '';
  c.styling = deps.tailwindcss ? 'tailwind' : deps['styled-components'] ? 'styled-components' : '';

  // Confirmed values in devtool.config.yaml win.
  map.conventions = { ...c, ...configConventions };
  const conv = map.conventions;

  // Endpoints.
  const callee = new RegExp(`(?:\\bfetch|\\b${conv.httpHelper !== 'fetch' ? conv.httpHelper : 'fetch'}|\\b\\w+\\.(?:get|post|put|patch|delete))\\s*(?:<[^>]*>)?\\(`);
  for (const f of apiFiles) {
    for (const fn of exportedFunctions(text(f))) {
      if (fn.name === conv.httpHelper) continue;
      const path = callPath(fn.body, new RegExp(callee.source));
      if (!path || /^\/\{\w+\}$/.test(path)) continue;
      const method = (fn.body.match(/method:\s*['"`](\w+)['"`]/)?.[1] ?? fn.body.match(/\.(get|post|put|patch|delete)\s*[<(]/)?.[1] ?? 'GET').toUpperCase() as HttpMethod;
      const response = fn.returnType.match(/^Promise<(.+)>$/)?.[1]?.trim();
      map.endpoints.push({ name: fn.name, method, path, response, file: f, calledFrom: [] });
    }
  }
  // Call sites.
  for (const f of code) {
    const t = text(f);
    const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      const target = resolveImport(f, m[2], conv.importAlias, conv.aliasBase);
      if (!target) continue;
      const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, ''));
      for (const ep of map.endpoints) {
        if (ep.file === f || !names.includes(ep.name)) continue;
        const epNoExt = ep.file.replace(/\.(tsx?|jsx?|mjs)$/, '');
        if (target === epNoExt || target === dirOf(ep.file)) ep.calledFrom.push(f);
      }
    }
  }

  // Routes.
  if (conv.appDir) {
    for (const f of files.filter((x) => x.startsWith(conv.appDir + '/') && /\/page\.(tsx|ts|jsx|js)$/.test(x))) {
      const segs = f.slice(conv.appDir.length + 1).split('/').slice(0, -1);
      const urlSegs = segs.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@'));
      const params = urlSegs.filter((s) => s.startsWith('[')).map((s) => s.replace(/[[\].]/g, ''));
      const path = '/' + urlSegs.map((s) => (s.startsWith('[') ? `{${s.replace(/[[\].]/g, '')}}` : s)).join('/');
      const named = urlSegs.filter((s) => !s.startsWith('['));
      const route: RouteInfo = { name: named.length ? named.join('-') : 'home', path: path === '/' ? '/' : path, params, file: f };
      map.routes.push(route);
    }
    map.routes.sort((a, b) => a.path.localeCompare(b.path));
  }

  map.locales = scanLocales(root, files);
  return map;
}

// ---------------- Generation ----------------

