// Flutter code styles beyond hand-written Dio repositories:
//
//   freezed    models as `@freezed` classes with a const factory constructor
//              (freezed 3 wants `abstract class`, freezed 2 a plain `class`)
//   Retrofit   API clients as `@RestApi()` abstract classes whose methods are
//              annotated with the HTTP verb and path; build_runner writes the code

import { commentText } from '../core/safe.ts';
import type { EndpointSpec, HttpMethod, InferredModel, ModelInfo } from '../core/types.ts';
import { DART_RESERVED, identifier, snake } from '../input/naming.ts';
import { dartType, dq, fieldName, type DartGen } from './dartGen.ts';
import { matchBrace } from './source.ts';

// ---------------- freezed ----------------

export function renderFreezedModel(m: InferredModel, g: DartGen, fileBase: string): string {
  const cls = g.cls(m.name);
  const kw = g.c.freezedClass === 'plain' ? 'class' : 'abstract class';
  const L: string[] = [
    "import 'package:freezed_annotation/freezed_annotation.dart';",
    '',
    `part '${fileBase}.freezed.dart';`,
    `part '${fileBase}.g.dart';`,
    '',
    '@freezed',
    `${kw} ${cls} with _$${cls} {`,
    `  const factory ${cls}({`,
  ];
  for (const f of m.fields) {
    const name = fieldName(f);
    const unknown = f.type.kind === 'unknown' || (f.type.kind === 'array' && f.type.item.kind === 'unknown');
    if (unknown) L.push('    // codz: type unknown from the samples; set it by hand.');
    const key = name !== f.jsonName ? `@JsonKey(name: ${dq(f.jsonName)}) ` : '';
    const optional = f.nullable || f.type.kind === 'unknown';
    const type = dartType(f.type, g) + (f.nullable && f.type.kind !== 'unknown' ? '?' : '');
    L.push(`    ${key}${optional ? '' : 'required '}${type} ${name},`);
  }
  L.push(`  }) = _${cls};`, '', `  factory ${cls}.fromJson(Map<String, dynamic> json) => _$${cls}FromJson(json);`, '}');
  return L.join('\n');
}

/** Splits at top-level commas (outside brackets and strings). */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') cur += s[++i] ?? '';
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    if ('([{<'.includes(ch)) depth++;
    else if (')]}>'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Fields of a freezed class, read from its unnamed const factory constructor. */
export function parseFreezedFields(body: string, cls: string): ModelInfo['fields'] | null {
  const m = new RegExp(`\\bconst\\s+factory\\s+${cls}\\s*\\(`).exec(body);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = matchBrace(body, open, 'dart');
  if (close === -1) return null;
  const inner = body.slice(open + 1, close).trim().replace(/^\{([\s\S]*)\}$/, '$1');
  const fields: ModelInfo['fields'] = [];
  for (const raw of splitTop(inner.replace(/\/\/[^\n]*/g, ''))) {
    const key = raw.match(/@JsonKey\(\s*name:\s*['"]([^'"]+)['"]/)?.[1];
    const rest = raw
      .replace(/@\w+(?:\([^)]*\))?/g, '')
      .replace(/\brequired\b/, '')
      .trim();
    const pm = /^([\w<>?,\s]+?)\s+(\w+)$/.exec(rest);
    if (!pm) continue;
    const type = pm[1].replace(/\s+/g, ' ').trim();
    fields.push({ name: key ?? snake(pm[2]), type: type.replace(/\?$/, ''), nullable: type.endsWith('?') || type === 'dynamic' });
  }
  return fields;
}

// ---------------- Retrofit ----------------

export interface RetrofitEndpoint {
  name: string;
  method: HttpMethod;
  path: string;
  response: string;
}

/** Methods of `@RestApi()` classes: `@GET('/users/{id}') Future<User> getUser(...)`. */
export function scanRetrofit(text: string): RetrofitEndpoint[] {
  if (!/@RestApi\s*\(/.test(text)) return [];
  const out: RetrofitEndpoint[] = [];
  const re = /@(GET|POST|PUT|PATCH|DELETE|HEAD)\s*\(\s*(['"])([^'"]*)\2\s*\)\s*(?:@\w+(?:\([^)]*\))?\s*)*Future<(.+?)>\s+(\w+)\s*\(/g;
  for (const m of text.matchAll(re)) out.push({ method: m[1] as HttpMethod, path: m[3], response: m[4].trim(), name: m[5] });
  return out;
}

export function renderRetrofitMethod(spec: EndpointSpec, g: DartGen, path: string): string {
  const params: string[] = spec.pathParams.map((p) => `@Path(${dq(p.name)}) ${p.type === 'int' ? 'int' : 'String'} ${identifier(p.name, DART_RESERVED)}`);
  if (spec.request) params.push(`@Body() ${dartType(spec.request, g)} body`);
  const named = spec.queryParams.map((q) => `@Query(${dq(q.name)}) ${dartType(q.type, g)}? ${identifier(q.name, DART_RESERVED)}`);
  const sig = named.length ? `${params.join(', ')}${params.length ? ', ' : ''}{${named.join(', ')}}` : params.join(', ');
  const noBody = spec.method === 'DELETE' || spec.method === 'HEAD';
  const result = noBody ? 'void' : spec.response ? dartType(spec.response, g) : 'dynamic';
  // Retrofit paths are relative to the client's baseUrl; {name} placeholders match @Path names.
  return [`  /// ${spec.method} ${commentText(spec.path)}`, `  @${spec.method}(${dq(path)})`, `  Future<${result}> ${spec.name}(${sig});`].join('\n');
}

export function newRetrofitClient(cls: string, fileBase: string): string {
  return [
    "import 'package:dio/dio.dart';",
    "import 'package:retrofit/retrofit.dart';",
    '',
    `part '${fileBase}.g.dart';`,
    '',
    '@RestApi()',
    `abstract class ${cls} {`,
    `  factory ${cls}(Dio dio, {String? baseUrl}) = _${cls};`,
    '}',
    '',
  ].join('\n');
}
