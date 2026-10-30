// Infers models from one or more JSON samples. Rules are fixed and
// documented, so the same samples always give the same models.
//
// - Several samples are merged: a field missing or null in any sample is nullable.
// - Integers become double when any sample has a fraction, or when the field
//   name suggests money, rates or coordinates (price, amount, lat, ...).
// - ISO 8601 strings become dates. Enums are never inferred.
// - A field that is only ever null, or an array that is only ever empty, gets
//   an "unknown" type and a warning instead of a guess.
// - Identical object shapes are reused; same name with a different shape gets
//   the parent name as a prefix.

import type { InferredField, InferredModel, InferredType } from '../core/types.ts';
import { pascal, singular } from './naming.ts';

interface Shape {
  seen: number;
  nulls: number;
  strings: number;
  dateStrings: number;
  ints: number;
  doubles: number;
  bools: number;
  objects: number;
  arrays: number;
  emptyArrays: number;
  fields: Map<string, Shape>;
  /** Insertion order of keys across samples, for deterministic field order. */
  keyOrder: string[];
  items: Shape | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const GENERIC_NAMES = new Set(['Item', 'Data', 'Detail', 'Details', 'Info', 'Meta', 'Value', 'Result', 'Attribute', 'Attributes', 'Entry', 'Node', 'Element', 'Record', 'Object', 'Option', 'Setting', 'Config']);
const DOUBLE_HINT = /(price|amount|total|subtotal|rate|ratio|lat|lng|lon|latitude|longitude|score|percent|percentage|balance|cost|fee|weight|height|width|discount|tax|rating)$/i;

function emptyShape(): Shape {
  return { seen: 0, nulls: 0, strings: 0, dateStrings: 0, ints: 0, doubles: 0, bools: 0, objects: 0, arrays: 0, emptyArrays: 0, fields: new Map(), keyOrder: [], items: null };
}

function add(shape: Shape, value: unknown): void {
  shape.seen++;
  if (value === null || value === undefined) shape.nulls++;
  else if (typeof value === 'string') {
    shape.strings++;
    if (ISO_DATE.test(value)) shape.dateStrings++;
  } else if (typeof value === 'number') {
    if (Number.isInteger(value)) shape.ints++;
    else shape.doubles++;
  } else if (typeof value === 'boolean') shape.bools++;
  else if (Array.isArray(value)) {
    shape.arrays++;
    if (value.length === 0) shape.emptyArrays++;
    shape.items ??= emptyShape();
    for (const item of value) add(shape.items, item);
  } else if (typeof value === 'object') {
    shape.objects++;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!shape.fields.has(k)) {
        shape.fields.set(k, emptyShape());
        shape.keyOrder.push(k);
      }
      add(shape.fields.get(k)!, v);
    }
  }
}

export interface InferResult {
  root: InferredType;
  models: InferredModel[];
  warnings: string[];
}

export function signature(fields: InferredField[]): string {
  return fields
    .map((f) => `${f.jsonName}:${typeKey(f.type)}${f.nullable ? '?' : ''}`)
    .sort()
    .join(',');
}

function typeKey(t: InferredType): string {
  if (t.kind === 'array') return `[${typeKey(t.item)}]`;
  if (t.kind === 'object') return `{${t.model}}`;
  return t.kind;
}

export function inferModels(samples: unknown[], rootName: string): InferResult {
  const shape = emptyShape();
  for (const s of samples) add(shape, s);
  const models: InferredModel[] = [];
  const bySignature = new Map<string, string>();
  const byName = new Map<string, InferredModel>();
  const warnings: string[] = [];

  function toType(s: Shape, path: string, nameHint: string, parentName: string, fieldName: string): { type: InferredType; nullable: boolean } {
    const nullable = s.nulls > 0;
    const nonNull = s.seen - s.nulls;
    if (nonNull === 0) {
      warnings.push(`${path} is null in every sample, so its type is unknown. Pass a sample where it has a value.`);
      return { type: { kind: 'unknown' }, nullable: true };
    }
    const kinds = [s.strings > 0, s.ints + s.doubles > 0, s.bools > 0, s.objects > 0, s.arrays > 0].filter(Boolean).length;
    if (kinds > 1) {
      warnings.push(`${path} has different types in the samples (for example text and number), so its type is unknown.`);
      return { type: { kind: 'unknown' }, nullable };
    }
    if (s.strings > 0) return { type: { kind: s.dateStrings === s.strings ? 'date' : 'string' }, nullable };
    if (s.ints + s.doubles > 0) {
      const isDouble = s.doubles > 0 || DOUBLE_HINT.test(fieldName);
      return { type: { kind: isDouble ? 'double' : 'int' }, nullable };
    }
    if (s.bools > 0) return { type: { kind: 'bool' }, nullable };
    if (s.arrays > 0) {
      const items = s.items!;
      if (items.seen === 0) {
        warnings.push(`${path} is an empty list in every sample, so its item type is unknown. Pass a sample with at least one item.`);
        return { type: { kind: 'array', item: { kind: 'unknown' } }, nullable };
      }
      // A list under a singular key ("checklist") holds "ChecklistItem"s.
      const itemHint = parentName !== '' && singular(nameHint) === nameHint && s.items!.objects > 0 ? `${nameHint} Item` : singular(nameHint);
      const item = toType(items, `${path}[]`, itemHint, parentName, singular(fieldName));
      if (item.nullable) warnings.push(`${path} contains null items; they are typed as non-null.`);
      return { type: { kind: 'array', item: item.type }, nullable };
    }
    // Object.
    const name = objectModel(s, path, nameHint, parentName);
    return { type: { kind: 'object', model: name }, nullable };
  }

  function objectModel(s: Shape, path: string, nameHint: string, parentName: string): string {
    let base = pascal(nameHint) || 'Item';
    if (GENERIC_NAMES.has(base) && parentName) base = pascal(`${parentName} ${base}`);
    const fields: InferredField[] = [];
    for (const key of s.keyOrder) {
      const f = s.fields.get(key)!;
      const childName = pascal(key);
      const { type, nullable } = toType(f, `${path}.${key}`, childName, base, key);
      fields.push({ jsonName: key, type, nullable: nullable || f.seen < s.objects });
    }
    const sig = signature(fields);
    const reuse = bySignature.get(sig);
    if (reuse) return reuse;
    let name = base;
    if (byName.has(name) && !parentName) {
      // The root model takes a "Response" suffix rather than a number.
      name = `${base}Response`;
      let n = 2;
      while (byName.has(name)) name = `${base}Response${n++}`;
    } else if (byName.has(name)) {
      name = pascal(`${parentName} ${base}`);
      let n = 2;
      while (byName.has(name)) name = `${pascal(`${parentName} ${base}`)}${n++}`;
    }
    const model: InferredModel = { name, fields };
    byName.set(name, model);
    bySignature.set(sig, name);
    models.push(model);
    return name;
  }

  const { type } = samples.length ? toType(shape, '$', rootName, '', rootName) : { type: { kind: 'unknown' } as InferredType };
  return { root: type, models, warnings };
}

const META_KEYS = new Set(['meta', 'status', 'message', 'success', 'code', 'errors', 'error', 'pagination', 'links', 'total', 'page', 'per_page', 'perPage', 'count', 'timestamp']);

/**
 * Detects a response envelope such as {"data": {...}, "meta": {...}}. Returns
 * the inner samples when every sample is an envelope, or null.
 */
export function unwrapEnvelope(samples: unknown[]): unknown[] | null {
  if (!samples.length) return null;
  const inner: unknown[] = [];
  for (const s of samples) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    const obj = s as Record<string, unknown>;
    if (!('data' in obj)) return null;
    if (!Object.keys(obj).every((k) => k === 'data' || META_KEYS.has(k))) return null;
    const d = obj.data;
    if (d === null || typeof d !== 'object') return null;
    inner.push(d);
  }
  return inner;
}
