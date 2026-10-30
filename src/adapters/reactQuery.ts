// TanStack Query hooks for Next.js API functions (dataFetching: react-query).
//
//   GET      useQuery with a key of [resource, ...path params, query params]
//   others   useMutation whose success invalidates the resource's queries
//
// One hooks file per API file: the hooks file that already imports from it,
// otherwise use-<resource>.ts in the hooks folder.

import { commentText, jsString } from '../core/safe.ts';
import type { EndpointSpec } from '../core/types.ts';
import { pascal } from '../input/naming.ts';

export interface TsParam {
  name: string;
  type: string;
  optional: boolean;
}

/** Splits a TypeScript parameter list at top-level commas. */
export function splitTsParams(params: string): TsParam[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of params) {
    if ('{[(<'.includes(ch)) depth++;
    else if ('}])>'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = /^(\w+)(\??)\s*:\s*([\s\S]+)$/.exec(p);
      return m ? { name: m[1], optional: m[2] === '?', type: m[3].trim() } : { name: p, optional: false, type: 'unknown' };
    });
}

/** useUser for getUser, useUsers for listUsers? No: only a leading "get" is dropped (getUser → useUser, listUsers → useListUsers). */
export function hookName(fn: string): string {
  const rest = /^get[A-Z]/.test(fn) ? fn.slice(3) : fn;
  return `use${pascal(rest)}`;
}

export interface HookStyle {
  q: string;
  semi: string;
  indent: string;
}

export function renderQueryHook(spec: EndpointSpec, fn: string, params: TsParam[], resourceKey: string, s: HookStyle): { name: string; code: string; uses: string[] } {
  const name = hookName(fn);
  const { q, semi } = s;
  const i1 = s.indent;
  const i2 = s.indent.repeat(2);
  const sig = params.map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ');
  const names = params.map((p) => p.name);
  if (spec.method === 'GET') {
    const key = [jsString(resourceKey, q), ...names].join(', ');
    return {
      name,
      uses: ['useQuery'],
      code: [
        `/** ${spec.method} ${commentText(spec.path)} */`,
        `export function ${name}(${sig}) {`,
        `${i1}return useQuery({`,
        `${i2}queryKey: [${key}],`,
        `${i2}queryFn: () => ${fn}(${names.join(', ')}),`,
        `${i1}})${semi}`,
        '}',
      ].join('\n'),
    };
  }
  let vars = '()';
  let call = `${fn}()`;
  if (params.length === 1) {
    vars = `(${params[0].name}: ${params[0].type}${params[0].optional ? ' | undefined' : ''})`;
    call = `${fn}(${params[0].name})`;
  } else if (params.length > 1) {
    vars = `({ ${names.join(', ')} }: { ${params.map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join('; ')} })`;
    call = `${fn}(${names.join(', ')})`;
  }
  return {
    name,
    uses: ['useMutation', 'useQueryClient'],
    code: [
      `/** ${spec.method} ${commentText(spec.path)} */`,
      `export function ${name}() {`,
      `${i1}const queryClient = useQueryClient()${semi}`,
      `${i1}return useMutation({`,
      `${i2}mutationFn: ${vars} => ${call},`,
      `${i2}onSuccess: () => queryClient.invalidateQueries({ queryKey: [${jsString(resourceKey, q)}] }),`,
      `${i1}})${semi}`,
      '}',
    ].join('\n'),
  };
}
