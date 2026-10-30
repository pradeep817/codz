// Flutter adapter, part 2: writing Dart (models, repository methods, imports,
// class members, GetX registrations).

import { commentText } from '../core/safe.ts';
import { ToolError, type Conventions, type EndpointSpec, type InferredModel } from '../core/types.ts';
import { DART_RESERVED, identifier } from '../input/naming.ts';
import { referencedModels } from './models.ts';
import { matchBrace } from './source.ts';
import { dartPathLiteral, dartType, dq, fieldName, fromJsonExpr, toJsonExpr, type DartGen } from './dartGen.ts';
import { renderFreezedModel } from './flutterStyles.ts';
import { relDir } from './flutterScan.ts';

export function renderModel(m: InferredModel, g: DartGen, fileBase: string): string {
  if (g.c.serialization === 'freezed') return renderFreezedModel(m, g, fileBase);
  const cls = g.cls(m.name);
  const fields = m.fields.map((f) => ({ f, name: fieldName(f), type: dartType(f.type, g) + (f.nullable && f.type.kind !== 'unknown' ? '?' : '') }));
  const L: string[] = [];
  const json = g.c.serialization === 'json_serializable';
  if (json) {
    L.push(`import 'package:json_annotation/json_annotation.dart';`, '', `part '${fileBase}.g.dart';`, '');
    const nested = m.fields.some((f) => referencedModels(f.type).size > 0);
    let ann = g.c.jsonAnnotation || '@JsonSerializable()';
    if (nested && !/explicitToJson/.test(ann)) ann = ann === '@JsonSerializable()' ? '@JsonSerializable(explicitToJson: true)' : ann.replace(/\)$/, ', explicitToJson: true)');
    L.push(ann);
  }
  L.push(`class ${cls} {`);
  const required = fields.map((x) => (x.f.nullable || x.f.type.kind === 'unknown' ? `    this.${x.name},` : `    required this.${x.name},`));
  L.push(`  const ${cls}({`, ...required, '  });', '');
  if (json) {
    L.push(`  factory ${cls}.fromJson(Map<String, dynamic> json) => _$${cls}FromJson(json);`, '');
    for (const x of fields) {
      if (x.f.type.kind === 'unknown' || (x.f.type.kind === 'array' && x.f.type.item.kind === 'unknown')) L.push('  // devtool: type unknown from the samples; set it by hand.');
      if (x.name !== x.f.jsonName) L.push(`  @JsonKey(name: ${dq(x.f.jsonName)})`);
      L.push(`  final ${x.type} ${x.name};`);
    }
    L.push('', `  Map<String, dynamic> toJson() => _$${cls}ToJson(this);`);
  } else {
    L.push(`  factory ${cls}.fromJson(Map<String, dynamic> json) => ${cls}(`);
    for (const x of fields) L.push(`        ${x.name}: ${fromJsonExpr(x.f.type, `json[${dq(x.f.jsonName)}]`, x.f.nullable, g)},`);
    L.push('      );', '');
    for (const x of fields) {
      if (x.f.type.kind === 'unknown' || (x.f.type.kind === 'array' && x.f.type.item.kind === 'unknown')) L.push('  // devtool: type unknown from the samples; set it by hand.');
      L.push(`  final ${x.type} ${x.name};`);
    }
    L.push('', '  Map<String, dynamic> toJson() => {');
    for (const x of fields) L.push(`        ${dq(x.f.jsonName)}: ${toJsonExpr(x.f.type, x.name, x.f.nullable)},`);
    L.push('      };');
  }
  L.push('}');
  return L.join('\n');
}

export function indentStyled(code: string, g: DartGen): string {
  if (g.indent === '  ') return code;
  return code
    .split('\n')
    .map((l) => {
      const m = l.match(/^( +)/);
      return m ? g.indent.repeat(Math.floor(m[1].length / 2)) + ' '.repeat(m[1].length % 2) + l.slice(m[1].length) : l;
    })
    .join('\n');
}

/** Import URI for `toFile` as seen from `fromFile`. */
export function importUri(fromFile: string, toFile: string, c: Conventions): string {
  if (c.importStyle === 'package' && c.packageName && toFile.startsWith('lib/')) return `package:${c.packageName}/${toFile.slice(4)}`;
  const from = relDir(fromFile).split('/');
  const to = toFile.split('/');
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  const up = from.length - i;
  return [...Array(up).fill('..'), ...to.slice(i)].join('/');
}

/** Adds `import '<uri>';` keeping Dart's grouping (dart:, package:, relative) and alphabetical order. */
export function addDartImport(text: string, uri: string): string {
  if (new RegExp(`^import\\s+['"]${uri.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}['"]`, 'm').test(text)) return text;
  const line = `import '${uri}';`;
  const kind = (u: string) => (u.startsWith('dart:') ? 0 : u.startsWith('package:') ? 1 : 2);
  const lines = text.split('\n');
  const importIdx = lines.map((l, i) => ({ l, i })).filter((x) => /^import\s+['"]/.test(x.l));
  if (!importIdx.length) {
    // After a library/part directive if present, else at the top.
    const lib = lines.findIndex((l) => /^(library|part of)\b/.test(l));
    lines.splice(lib + 1, 0, ...(lib >= 0 ? [''] : []), line, '');
    return lines.join('\n');
  }
  const same = importIdx.filter((x) => kind(x.l.match(/['"]([^'"]+)['"]/)![1]) === kind(uri));
  if (same.length) {
    const uris = same.map((x) => x.l.match(/['"]([^'"]+)['"]/)![1]);
    const sorted = uris.every((u, i) => i === 0 || uris[i - 1] <= u);
    // Keep alphabetical order when the file already uses it; otherwise append to the group.
    const after = sorted ? same.find((x) => x.l.match(/['"]([^'"]+)['"]/)![1] > uri) : undefined;
    if (after) lines.splice(after.i, 0, line);
    else lines.splice(same[same.length - 1].i + 1, 0, line);
    return lines.join('\n');
  }
  // New group: place after the last import of a lower kind, separated by a blank line.
  const lower = importIdx.filter((x) => kind(x.l.match(/['"]([^'"]+)['"]/)![1]) < kind(uri));
  if (lower.length) {
    lines.splice(lower[lower.length - 1].i + 1, 0, '', line);
  } else {
    lines.splice(importIdx[0].i, 0, line, '');
  }
  return lines.join('\n');
}

/** Inserts `member` before the closing brace of `class name`. */
export function addToClass(text: string, className: string, member: string): string {
  const m = new RegExp(`\\bclass\\s+${className}\\b[^{]*\\{`).exec(text);
  if (!m) throw new ToolError('class_not_found', `Could not find class ${className}.`);
  const close = matchBrace(text, m.index + m[0].length - 1, 'dart');
  if (close === -1) throw new ToolError('class_not_found', `Could not find the end of class ${className}.`);
  const before = text.slice(0, close).replace(/\s*$/, '');
  return `${before}\n\n${member}\n${text.slice(close)}`;
}

export function renderMethod(spec: EndpointSpec, g: DartGen, path: string, field: string): string {
  const params: string[] = spec.pathParams.map((p) => `${p.type === 'int' ? 'int' : 'String'} ${p.name}`);
  if (spec.request) params.push(`${dartType(spec.request, g)} body`);
  const named = spec.queryParams.map((q) => ({ key: q.name, name: identifier(q.name, DART_RESERVED), type: dartType(q.type, g) }));
  const sig = named.length ? `${params.join(', ')}${params.length ? ', ' : ''}{${named.map((n) => `${n.type}? ${n.name}`).join(', ')}}` : params.join(', ');
  const verb = spec.method.toLowerCase();
  const r = spec.response;
  const noBody = spec.method === 'DELETE' || spec.method === 'HEAD' || !r;
  const resultType = noBody ? (spec.method === 'DELETE' || spec.method === 'HEAD' ? 'void' : 'dynamic') : dartType(r!, g);
  const isList = r?.kind === 'array';
  const typeArg = noBody ? (resultType === 'void' ? 'void' : 'dynamic') : spec.unwrapData ? 'Map<String, dynamic>' : isList ? 'List<dynamic>' : r!.kind === 'object' ? 'Map<String, dynamic>' : 'dynamic';
  const args = [dartPathLiteral(path)];
  if (spec.request) args.push(`data: ${toJsonExpr(spec.request, 'body', false)}`);
  if (named.length) args.push(`queryParameters: {${named.map((n) => `if (${n.name} != null) ${dq(n.key)}: ${n.name}`).join(', ')}}`);
  const L: string[] = [];
  L.push(`  /// ${spec.method} ${commentText(spec.path)}`);
  L.push(`  Future<${resultType}> ${spec.name}(${sig}) async {`);
  const call = `${field}.${verb}<${typeArg}>(${args.length > 1 ? `\n      ${args.join(',\n      ')},\n    ` : args[0]})`;
  if (resultType === 'void') {
    L.push(`    await ${call};`);
  } else {
    L.push(`    final response = await ${call};`);
    const raw = spec.unwrapData ? `response.data!['data']` : 'response.data';
    if (noBody || r!.kind === 'unknown') L.push(`    return ${raw};`);
    else if (r!.kind === 'object') L.push(`    return ${g.cls(r!.model)}.fromJson(${spec.unwrapData ? `${raw} as Map<String, dynamic>` : `${raw}!`});`);
    else if (isList) {
      const list = spec.unwrapData ? `(${raw} as List<dynamic>)` : `${raw}!`;
      L.push(`    return ${list}.map((e) => ${fromJsonExpr(r!.kind === 'array' ? r!.item : r!, 'e', false, g)}).toList();`);
    } else L.push(`    return ${fromJsonExpr(r!, spec.unwrapData ? raw : `${raw}`, false, g)};`);
  }
  L.push('  }');
  return L.join('\n');
}

/**
 * Adds a registration line after the last Get.put / Get.lazyPut statement, or
 * at the end of `dependencies()` when there is none. Returns null if neither exists.
 */
export function insertGetxRegistration(text: string, line: string): string | null {
  const calls = [...text.matchAll(/\bGet\.(?:lazyPut|put|putAsync|create)\s*(?:<[^>(]*>)?\s*\(/g)];
  if (calls.length) {
    const last = calls[calls.length - 1];
    const open = last.index! + last[0].length - 1;
    const close = matchBrace(text, open, 'dart');
    if (close !== -1) {
      const semi = text.indexOf(';', close);
      if (semi !== -1) {
        const lineStart = text.lastIndexOf('\n', last.index!) + 1;
        const indent = text.slice(lineStart, last.index!).match(/^[ \t]*/)![0];
        return `${text.slice(0, semi + 1)}\n${indent}${line}${text.slice(semi + 1)}`;
      }
    }
  }
  const dep = /void\s+dependencies\s*\(\s*\)\s*\{/.exec(text);
  if (!dep) return null;
  const close = matchBrace(text, dep.index + dep[0].length - 1, 'dart');
  if (close === -1) return null;
  const before = text.slice(0, close).replace(/\s*$/, '');
  return `${before}\n    ${line}\n  ${text.slice(close)}`;
}

export function resourceOf(path: string): string {
  return path.split('/').filter((s) => s && !s.startsWith('{') && !/^(api|v\d+(\.\d+)?|rest)$/i.test(s))[0] ?? 'root';
}

export function r0(spec: EndpointSpec, g: DartGen): string {
  if (spec.method === 'DELETE' || spec.method === 'HEAD') return 'void';
  return spec.response ? dartType(spec.response, g) : 'dynamic';
}

