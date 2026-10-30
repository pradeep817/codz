// Shared Dart code generation: types, JSON reading and writing expressions,
// string literals. Used by the Flutter adapter and its style variants
// (freezed models, Retrofit clients, Cubits).

import type { Conventions, InferredField, InferredType } from '../core/types.ts';
import { DART_RESERVED, identifier } from '../input/naming.ts';

export interface DartGen {
  c: Conventions;
  indent: string;
  cls: (n: string) => string;
}

export function dartType(t: InferredType, g: DartGen): string {
  switch (t.kind) {
    case 'string':
      return 'String';
    case 'date':
      return 'DateTime';
    case 'int':
      return 'int';
    case 'double':
      return 'double';
    case 'bool':
      return 'bool';
    case 'unknown':
      return 'dynamic';
    case 'object':
      return g.cls(t.model);
    case 'array':
      return `List<${dartType(t.item, g)}>`;
  }
}

/** Expression that reads a JSON value of type t from `v` (a dynamic). */
export function fromJsonExpr(t: InferredType, v: string, nullable: boolean, g: DartGen): string {
  const nn = nullable ? '?' : '';
  switch (t.kind) {
    case 'string':
    case 'int':
    case 'bool':
      return `${v} as ${dartType(t, g)}${nn}`;
    case 'double':
      return nullable ? `(${v} as num?)?.toDouble()` : `(${v} as num).toDouble()`;
    case 'date':
      return nullable ? `${v} == null ? null : DateTime.parse(${v} as String)` : `DateTime.parse(${v} as String)`;
    case 'unknown':
      return v;
    case 'object':
      return nullable ? `${v} == null ? null : ${g.cls(t.model)}.fromJson(${v} as Map<String, dynamic>)` : `${g.cls(t.model)}.fromJson(${v} as Map<String, dynamic>)`;
    case 'array': {
      const item = fromJsonExpr(t.item, 'e', false, g);
      if (t.item.kind === 'unknown') return `${v} as List<dynamic>${nn}`;
      return nullable ? `(${v} as List<dynamic>?)?.map((e) => ${item}).toList()` : `(${v} as List<dynamic>).map((e) => ${item}).toList()`;
    }
  }
}

export function toJsonExpr(t: InferredType, v: string, nullable: boolean): string {
  const q = nullable ? '?' : '';
  switch (t.kind) {
    case 'date':
      return `${v}${q}.toIso8601String()`;
    case 'object':
      return `${v}${q}.toJson()`;
    case 'array': {
      if (t.item.kind === 'object' || t.item.kind === 'date' || t.item.kind === 'array') return `${v}${q}.map((e) => ${toJsonExpr(t.item, 'e', false)}).toList()`;
      return v;
    }
    default:
      return v;
  }
}

export function dq(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}'`;
}

export function fieldName(f: InferredField): string {
  return identifier(f.jsonName, DART_RESERVED);
}

export function dartPathLiteral(path: string): string {
  // {id} → $id, or ${id} when followed by an identifier character.
  // Literal text is escaped (\\, ', $); only {param} placeholders become Dart interpolation.
  const esc = (t: string) => t.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$').replace(/[\r\n]/g, '');
  const parts = path.split(/(\{\w+\})/);
  const body = parts.map((part, i) => {
    const m = /^\{(\w+)\}$/.exec(part);
    if (!m) return esc(part);
    return /^[A-Za-z0-9_]/.test(parts[i + 1] ?? '') ? `\${${m[1]}}` : `$${m[1]}`;
  }).join('');
  return `'${body}'`;
}
