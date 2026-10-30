// Next.js adapter, part 2: writing code (types, interfaces, imports, the API
// function for each HTTP client style, and where its base URL comes from).

import { commentText, jsString, jsTemplateText } from '../core/safe.ts';
import { join, posix } from 'node:path';
import { readText } from '../core/fsutil.ts';
import { type Conventions, type EndpointSpec, type InferredModel, type InferredType, type ProjectMap } from '../core/types.ts';
import { specRelativePath } from './common.ts';
import { matchBrace, type TsStyle } from './source.ts';
import { dirOf } from './nextjsScan.ts';

export interface Gen {
  c: Conventions;
  style: TsStyle;
  q: string;
}

export function tsType(t: InferredType | undefined): string {
  if (!t) return 'unknown';
  switch (t.kind) {
    case 'string':
    case 'date':
      return 'string';
    case 'int':
    case 'double':
      return 'number';
    case 'bool':
      return 'boolean';
    case 'unknown':
      return 'unknown';
    case 'object':
      return t.model;
    case 'array': {
      const inner = tsType(t.item);
      return /[\s|]/.test(inner) ? `(${inner})[]` : `${inner}[]`;
    }
  }
}

export const IDENT = /^[A-Za-z_$][\w$]*$/;

export function propKey(key: string, q: string): string {
  return IDENT.test(key) ? key : jsString(key, q);
}

/** Applies the project's semicolon and indent style to generated text (written with 2 spaces and semicolons). */
export function styled(code: string, g: Gen): string {
  return code
    .split('\n')
    .map((line) => {
      let l = line;
      if (!g.style.semi) l = l.replace(/;(\s*)$/, '$1');
      const m = l.match(/^( +)/);
      if (m && g.style.indent !== '  ') l = g.style.indent.repeat(m[1].length / 2) + l.slice(m[1].length);
      return l;
    })
    .join('\n');
}

export function renderInterface(m: InferredModel, g: Gen): string {
  const lines = [`export interface ${m.name} {`];
  for (const f of m.fields) {
    if (f.type.kind === 'date') lines.push(`  /** ISO 8601 date string. */`);
    if (f.type.kind === 'unknown' || (f.type.kind === 'array' && f.type.item.kind === 'unknown')) lines.push(`  // codz: type unknown from the samples; set it by hand.`);
    const t = tsType(f.type);
    lines.push(`  ${propKey(f.jsonName, g.q)}${f.nullable ? '?' : ''}: ${f.nullable && t !== 'unknown' ? `${t} | null` : t};`);
  }
  lines.push('}');
  return lines.join('\n');
}

export function importPath(fromFile: string, toFile: string, c: Conventions): string {
  const toNoExt = toFile.replace(/\.(tsx?|jsx?|mjs)$/, '').replace(/\/index$/, '');
  const base = c.aliasBase === '.' ? '' : c.aliasBase + '/';
  if (c.importStyle === 'alias' && c.importAlias && (base === '' || toNoExt.startsWith(base))) {
    return c.importAlias + toNoExt.slice(base.length);
  }
  let r = posix.relative(dirOf(fromFile), toNoExt);
  if (!r.startsWith('.')) r = `./${r}`;
  return r;
}

/** Adds named imports to a file, merging into an existing import from the same path. */
export function addImports(text: string, path: string, names: string[], typeOnly: boolean, g: Gen): string {
  if (!names.length) return text;
  const q = g.q;
  const esc = path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const existing = new RegExp(`import\\s+${typeOnly ? 'type\\s+' : ''}\\{([^}]*)\\}\\s*from\\s*['"]${esc}['"];?`).exec(text);
  if (existing) {
    const have = existing[1].split(',').map((s) => s.trim()).filter(Boolean);
    const merged = [...new Set([...have, ...names])].sort();
    if (merged.length === have.length) return text;
    const line = `import ${typeOnly ? 'type ' : ''}{ ${merged.join(', ')} } from ${q}${path}${q}${g.style.semi ? ';' : ''}`;
    return text.slice(0, existing.index) + line + text.slice(existing.index + existing[0].length);
  }
  const line = `import ${typeOnly ? 'type ' : ''}{ ${[...names].sort().join(', ')} } from ${q}${path}${q}${g.style.semi ? ';' : ''}`;
  const imports = [...text.matchAll(/^import[\s\S]*?from\s*['"][^'"]+['"];?[ \t]*$/gm)];
  if (imports.length) {
    const last = imports[imports.length - 1];
    const at = last.index! + last[0].length;
    return `${text.slice(0, at)}\n${line}${text.slice(at)}`;
  }
  return text.length ? `${line}\n\n${text}` : `${line}\n`;
}

/** Adds `import name from 'path'` unless the file already imports that default. */
export function addDefaultImport(text: string, path: string, name: string, g: Gen): string {
  const esc = path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  if (new RegExp(`import\\s+${name}\\b[^;\\n]*from\\s*['"]${esc}['"]`).test(text)) return text;
  const line = `import ${name} from ${g.q}${path}${g.q}${g.style.semi ? ';' : ''}`;
  const imports = [...text.matchAll(/^import[\s\S]*?from\s*['"][^'"]+['"];?[ \t]*$/gm)];
  if (imports.length) return `${line}\n${text}`;
  return text.length ? `${line}\n\n${text}` : `${line}\n`;
}

/** Finds `export interface Name {...}` or `export type Name = {...};` (with a doc comment above it). */
export function findTsBlock(text: string, name: string): { start: number; end: number } | null {
  const m = new RegExp(`(^|\\n)((?:[ \\t]*(?:/\\*\\*(?:(?!\\*/)[^])*\\*/|//[^\\n]*)\\n)*)[ \\t]*export\\s+(?:interface\\s+${name}\\b[^{]*|type\\s+${name}\\b[^=]*=\\s*)\\{`).exec(text);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = matchBrace(text, open);
  if (close === -1) return null;
  let end = close + 1;
  if (text[end] === ';') end++;
  return { start: m.index + m[1].length, end };
}

export function appendBlock(text: string, block: string): string {
  if (!text.trim()) return block + '\n';
  return text.replace(/\s*$/, '') + '\n\n' + block + '\n';
}

export interface BaseChoice {
  kind: 'helper' | 'env' | 'literal';
  env?: string;
  origin?: string;
  path: string;
  warnings: string[];
}

export function chooseBase(input: EndpointSpec, map: ProjectMap, root = '.'): BaseChoice {
  const c = map.conventions;
  const warnings: string[] = [];
  // An endpoint from an API spec goes relative to the project's base URL when there is one: the spec's
  // server (https://api.example.com/v1) is a stand-in for it, usually another environment.
  const usesHelper = (c.http === 'axios' && !!c.axiosInstanceFile && /\bbaseURL\s*:/.test(readText(join(root, c.axiosInstanceFile)) ?? '')) || (c.http !== 'axios' && !!c.httpHelper && c.httpHelper !== 'fetch');
  const projectBase = map.baseUrls.find((b) => b.name === c.baseUrlEnv)?.value ?? map.baseUrls[0]?.value;
  const fromSpec = specRelativePath(input, projectBase);
  const spec = fromSpec !== null && (usesHelper || projectBase || c.baseUrlEnv) ? { ...input, origin: '', path: fromSpec } : input;
  const prefixOf = (value: string) => {
    try {
      return new URL(value).pathname.replace(/\/$/, '');
    } catch {
      return '';
    }
  };
  const originOf = (value: string) => {
    try {
      return new URL(value).origin;
    } catch {
      return '';
    }
  };
  const candidates = map.baseUrls.filter((b) => !spec.origin || originOf(b.value) === spec.origin);
  const matched = candidates.find((b) => b.name === c.baseUrlEnv && spec.path.startsWith(prefixOf(b.value))) ?? candidates.find((b) => spec.path.startsWith(prefixOf(b.value)));
  const path = matched ? spec.path.slice(prefixOf(matched.value).length) || '/' : spec.path;
  if (spec.origin && !matched) {
    const known = map.baseUrls.map((b) => `${b.name}=${b.value}`).join(', ');
    if (known) warnings.push(`The URL host ${spec.origin} does not match any configured base URL (${known}).`);
  }
  if (c.http === 'axios' && c.axiosInstanceFile && /\bbaseURL\s*:/.test(readText(join(root, c.axiosInstanceFile)) ?? '')) {
    if (spec.origin && !matched && warnings.length) warnings[warnings.length - 1] += ` The call goes through the ${c.axiosInstance.replace(/^default:/, '')} axios instance, which uses its own baseURL; check that this endpoint lives on the same server.`;
    return { kind: 'helper', path, warnings };
  }
  if (c.http !== 'axios' && c.httpHelper && c.httpHelper !== 'fetch') {
    if (spec.origin && !matched) warnings[warnings.length - 1] += ` The call goes through ${c.httpHelper}, which uses its own base URL; check that this endpoint lives on the same server.`;
    return { kind: 'helper', path, warnings };
  }
  if (matched && /^\w+$/.test(matched.name)) return { kind: 'env', env: matched.name, path, warnings };
  if (c.baseUrlEnv && /^\w+$/.test(c.baseUrlEnv)) return { kind: 'env', env: c.baseUrlEnv, path, warnings };
  if (spec.origin) {
    warnings.push(`No base URL setting was found, so the host ${spec.origin} is written into the code. Consider moving it to an environment variable.`);
    return { kind: 'literal', origin: spec.origin, path, warnings };
  }
  return { kind: 'literal', origin: '', path, warnings };
}

export function renderFunction(spec: EndpointSpec, base: BaseChoice, g: Gen): string {
  const q = g.q;
  const params: string[] = spec.pathParams.map((p) => `${p.name}: ${p.type === 'int' ? 'number' : 'string'}`);
  if (spec.request) params.push(`body: ${tsType(spec.request)}`);
  if (spec.queryParams.length) {
    params.push(`params?: { ${spec.queryParams.map((p) => `${propKey(p.name, q)}?: ${tsType(p.type)}`).join('; ')} }`);
  }
  const hasResponse = !!spec.response && spec.method !== 'DELETE' && spec.method !== 'HEAD';
  const resultType = hasResponse ? tsType(spec.response) : spec.method === 'DELETE' || spec.method === 'HEAD' ? 'void' : 'unknown';
  // Literal text is escaped for a template literal; only {param} placeholders become ${param}.
  const pathExpr = base.path.split(/(\{\w+\})/).map((part) => (/^\{\w+\}$/.test(part) ? `\${${part.slice(1, -1)}}` : jsTemplateText(part))).join('');
  const lines: string[] = [];
  lines.push(`/** ${spec.method} ${commentText(spec.path)} */`);
  const needsQuery = spec.queryParams.length > 0;
  const urlTail = needsQuery ? '${queryString ? `?${queryString}` : \'\'}'.replace(/'/g, q) : '';
  const queryLines = needsQuery
    ? [
        '  const searchParams = new URLSearchParams();',
        ...spec.queryParams.map((p) => {
          const check = IDENT.test(p.name) ? `params?.${p.name}` : `params?.[${jsString(p.name, q)}]`;
          const access = IDENT.test(p.name) ? `params.${p.name}` : `params[${jsString(p.name, q)}]`;
          return `  if (${check} !== undefined) searchParams.set(${jsString(p.name, q)}, String(${access}));`;
        }),
        '  const queryString = searchParams.toString();',
      ]
    : [];
  if (g.c.http === 'axios') {
    // axios serializes params (skipping undefined) and parses JSON itself.
    const client = (g.c.axiosInstance || 'axios').replace(/^default:/, '');
    const prefix = base.kind === 'env' ? `\${process.env.${base.env}}` : base.kind === 'literal' ? jsTemplateText(base.origin ?? '') : '';
    const genericType = spec.unwrapData ? `{ data: ${resultType} }` : resultType;
    const verb = spec.method.toLowerCase();
    const config = needsQuery ? '{ params }' : '';
    const withBody = ['post', 'put', 'patch'].includes(verb);
    const args = [`\`${prefix}${pathExpr}\``];
    if (withBody) args.push(spec.request ? 'body' : config ? 'undefined' : '');
    if (config) args.push(config);
    const callArgs = args.filter((a, i) => a !== '' || i === 0).join(', ');
    lines.push(`export async function ${spec.name}(${params.join(', ')}): Promise<${resultType}> {`);
    if (resultType === 'void') lines.push(`  await ${client}.${verb}(${callArgs});`);
    else {
      lines.push(`  const res = await ${client}.${verb}<${genericType}>(${callArgs});`);
      lines.push(spec.unwrapData ? '  return res.data.data;' : '  return res.data;');
    }
    lines.push('}');
    return lines.join('\n');
  }
  const init: string[] = [];
  if (spec.method !== 'GET') init.push(`method: ${q}${spec.method}${q}`);
  if (spec.request) init.push('body: JSON.stringify(body)');

  if (base.kind === 'helper') {
    const helper = g.c.httpHelper;
    const genericType = spec.unwrapData ? `{ data: ${resultType} }` : resultType;
    const call = `${helper}<${genericType}>(\`${pathExpr}${urlTail}\`${init.length ? `, { ${init.join(', ')} }` : ''})`;
    if (!needsQuery && !spec.unwrapData) {
      lines.push(`export function ${spec.name}(${params.join(', ')}): Promise<${resultType}> {`);
      lines.push(`  return ${call};`);
    } else {
      lines.push(`export async function ${spec.name}(${params.join(', ')}): Promise<${resultType}> {`);
      lines.push(...queryLines);
      if (spec.unwrapData) {
        lines.push(`  const res = await ${call};`);
        lines.push('  return res.data;');
      } else {
        lines.push(`  return ${call};`);
      }
    }
    lines.push('}');
    return lines.join('\n');
  }

  const prefix = base.kind === 'env' ? `\${process.env.${base.env}}` : jsTemplateText(base.origin ?? '');
  const headers = spec.request ? [`headers: { ${q}Content-Type${q}: ${q}application/json${q} }`] : [];
  const fetchInit = [`method: ${q}${spec.method}${q}`, ...headers, ...(spec.request ? ['body: JSON.stringify(body)'] : [])];
  lines.push(`export async function ${spec.name}(${params.join(', ')}): Promise<${resultType}> {`);
  lines.push(...queryLines);
  lines.push(`  const res = await fetch(\`${prefix}${pathExpr}${urlTail}\`, {`);
  for (const f of fetchInit) lines.push(`    ${f},`);
  lines.push('  });');
  lines.push(`  if (!res.ok) throw new Error(\`${spec.name} failed: \${res.status}\`);`);
  if (resultType === 'void') {
    // Nothing to parse.
  } else if (spec.unwrapData) {
    lines.push(`  const json = (await res.json()) as { data: ${resultType} };`);
    lines.push('  return json.data;');
  } else {
    lines.push(`  return (await res.json()) as ${resultType};`);
  }
  lines.push('}');
  return lines.join('\n');
}

export const resourceOf = (path: string) =>
  path
    .split('/')
    .filter((s) => s && !s.startsWith('{') && !/^(api|v\d+(\.\d+)?|rest)$/i.test(s))[0] ?? 'root';

