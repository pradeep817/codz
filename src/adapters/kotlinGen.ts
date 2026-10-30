// Kotlin code generation for the Android adapter: data classes for models
// (kotlinx.serialization, Moshi or Gson), Retrofit interface methods, imports
// and package lines.

import { commentText, ktString } from '../core/safe.ts';
import type { Conventions, EndpointSpec, InferredModel, InferredType } from '../core/types.ts';
import { camel } from '../input/naming.ts';

export const KOTLIN_RESERVED = new Set([
  'as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for', 'fun', 'if', 'in', 'interface', 'is', 'null', 'object',
  'package', 'return', 'super', 'this', 'throw', 'true', 'try', 'typealias', 'typeof', 'val', 'var', 'when', 'while',
]);

export function kotlinName(jsonKey: string): string {
  let id = camel(jsonKey) || 'field';
  if (/^[0-9]/.test(id)) id = `n${id}`;
  return KOTLIN_RESERVED.has(id) ? `\`${id}\`` : id;
}

export function kotlinType(t: InferredType, c: Conventions): string {
  switch (t.kind) {
    case 'string':
    case 'date':
      return 'String';
    case 'int':
      return 'Int';
    case 'double':
      return 'Double';
    case 'bool':
      return 'Boolean';
    case 'unknown':
      return c.serialization === 'kotlinx' ? 'JsonElement' : 'Any';
    case 'object':
      return t.model;
    case 'array':
      return `List<${kotlinType(t.item, c)}>`;
  }
}

const usesUnknown = (t: InferredType): boolean => t.kind === 'unknown' || (t.kind === 'array' && usesUnknown(t.item));

export function renderDataClass(m: InferredModel, c: Conventions, pkg: string): string {
  const ser = c.serialization || 'kotlinx';
  const imports = new Set<string>();
  const fieldAnn = (json: string, name: string) => {
    if (name.replace(/`/g, '') === json) return '';
    if (ser === 'kotlinx') return `@SerialName(${ktString(json)}) `;
    if (ser === 'moshi') return `@Json(name = ${ktString(json)}) `;
    return `@SerializedName(${ktString(json)}) `;
  };
  if (ser === 'kotlinx') imports.add('kotlinx.serialization.Serializable');
  if (ser === 'moshi') imports.add('com.squareup.moshi.JsonClass');
  const lines = m.fields.map((f) => {
    const name = kotlinName(f.jsonName);
    const ann = fieldAnn(f.jsonName, name);
    if (ann) imports.add(ser === 'kotlinx' ? 'kotlinx.serialization.SerialName' : ser === 'moshi' ? 'com.squareup.moshi.Json' : 'com.google.gson.annotations.SerializedName');
    if (usesUnknown(f.type) && ser === 'kotlinx') imports.add('kotlinx.serialization.json.JsonElement');
    const optional = f.nullable || f.type.kind === 'unknown';
    const type = kotlinType(f.type, c) + (optional ? '?' : '');
    const unknown = usesUnknown(f.type) ? ' // codz: type unknown from the samples; set it by hand' : '';
    return `    ${ann}val ${name}: ${type}${optional ? ' = null' : ''},${unknown}`;
  });
  const classAnn = ser === 'kotlinx' ? '@Serializable\n' : ser === 'moshi' ? '@JsonClass(generateAdapter = true)\n' : '';
  const head = [`package ${pkg}`, '', ...[...imports].sort().map((i) => `import ${i}`), ...(imports.size ? [''] : [])];
  return [...head, `${classAnn}data class ${m.name}(`, ...lines, ')', ''].join('\n');
}

/** A Retrofit method. Paths are relative to the base URL (no leading slash), which must end in "/". */
export function renderRetrofitFun(spec: EndpointSpec, c: Conventions, path: string): { code: string; imports: string[] } {
  const imports = new Set<string>([`retrofit2.http.${spec.method}`]);
  const params: string[] = spec.pathParams.map((p) => {
    imports.add('retrofit2.http.Path');
    return `@Path(${ktString(p.name)}) ${kotlinName(p.name)}: ${p.type === 'int' ? 'Int' : 'String'}`;
  });
  if (spec.request) {
    imports.add('retrofit2.http.Body');
    params.push(`@Body body: ${kotlinType(spec.request, c)}`);
  }
  for (const q of spec.queryParams) {
    imports.add('retrofit2.http.Query');
    params.push(`@Query(${ktString(q.name)}) ${kotlinName(q.name)}: ${kotlinType(q.type, c)}? = null`);
  }
  const noBody = spec.method === 'DELETE' || spec.method === 'HEAD';
  const result = noBody ? 'Unit' : spec.response ? kotlinType(spec.response, c) : c.serialization === 'kotlinx' ? 'JsonElement' : 'Any';
  if (!noBody && spec.response && usesUnknown(spec.response) && c.serialization === 'kotlinx') imports.add('kotlinx.serialization.json.JsonElement');
  if (!noBody && !spec.response && c.serialization === 'kotlinx') imports.add('kotlinx.serialization.json.JsonElement');
  const rel = path.replace(/^\//, '');
  const sig = params.length > 2 ? `(\n        ${params.join(',\n        ')},\n    )` : `(${params.join(', ')})`;
  const code = [`    /** ${spec.method} ${commentText(spec.path)} */`, `    @${spec.method}(${ktString(rel)})`, `    suspend fun ${spec.name}${sig}${result === 'Unit' ? '' : `: ${result}`}`].join('\n');
  return { code, imports: [...imports] };
}

/** Adds `import x` lines to a Kotlin file, sorted, after the package line. */
export function addKotlinImports(text: string, imports: string[], pkg: string): string {
  const own = (i: string) => i.slice(0, i.lastIndexOf('.')) === pkg;
  const want = [...new Set(imports)].filter((i) => !own(i) && !new RegExp(`^import\\s+${i.replace(/\./g, '\\.')}\\s*$`, 'm').test(text));
  if (!want.length) return text;
  const lines = text.split('\n');
  const existing = lines.map((l, i) => ({ l, i })).filter((x) => /^import\s+/.test(x.l));
  if (existing.length) {
    const all = [...new Set([...existing.map((x) => x.l), ...want.map((w) => `import ${w}`)])].sort();
    lines.splice(existing[0].i, existing[existing.length - 1].i - existing[0].i + 1, ...all);
    return lines.join('\n');
  }
  const p = lines.findIndex((l) => /^package\s+/.test(l));
  lines.splice(p + 1, 0, '', ...want.sort().map((w) => `import ${w}`));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}
