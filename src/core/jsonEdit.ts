// Small edits to JSON text that keep the rest of the file byte for byte:
// set one (possibly nested) key without reformatting anything else.

import { ToolError } from './types.ts';

interface Member {
  key: string;
  start: number; // start of the key string
  valueStart: number;
  valueEnd: number; // exclusive
  object?: JsonObject;
}

interface JsonObject {
  open: number;
  close: number;
  members: Member[];
}

function ws(t: string, i: number): number {
  while (i < t.length && /\s/.test(t[i])) i++;
  return i;
}

function parseString(t: string, i: number): [string, number] {
  let j = i + 1;
  while (j < t.length && t[j] !== '"') j += t[j] === '\\' ? 2 : 1;
  return [JSON.parse(t.slice(i, j + 1)) as string, j + 1];
}

function parseValue(t: string, i: number): { end: number; object?: JsonObject } {
  i = ws(t, i);
  const c = t[i];
  if (c === '{') {
    const object = parseObject(t, i);
    return { end: object.close + 1, object };
  }
  if (c === '"') return { end: parseString(t, i)[1] };
  if (c === '[') {
    let j = ws(t, i + 1);
    if (t[j] === ']') return { end: j + 1 };
    for (;;) {
      j = ws(t, parseValue(t, j).end);
      if (t[j] === ',') j++;
      else if (t[j] === ']') return { end: j + 1 };
      else throw new ToolError('bad_json', `Unexpected "${t[j]}" at offset ${j}.`);
    }
  }
  const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(t.slice(i));
  if (!m) throw new ToolError('bad_json', `Unexpected "${c}" at offset ${i}.`);
  return { end: i + m[0].length };
}

function parseObject(t: string, open: number): JsonObject {
  const members: Member[] = [];
  let i = ws(t, open + 1);
  if (t[i] === '}') return { open, close: i, members };
  for (;;) {
    if (t[i] !== '"') throw new ToolError('bad_json', `Expected a key at offset ${i}.`);
    const [key, afterKey] = parseString(t, i);
    let j = ws(t, afterKey);
    if (t[j] !== ':') throw new ToolError('bad_json', `Expected ":" at offset ${j}.`);
    const valueStart = ws(t, j + 1);
    const v = parseValue(t, valueStart);
    members.push({ key, start: i, valueStart, valueEnd: v.end, object: v.object });
    j = ws(t, v.end);
    if (t[j] === ',') i = ws(t, j + 1);
    else if (t[j] === '}') return { open, close: j, members };
    else throw new ToolError('bad_json', `Unexpected "${t[j]}" at offset ${j}.`);
  }
}

const lineIndent = (t: string, pos: number) => t.slice(t.lastIndexOf('\n', pos - 1) + 1).match(/^[ \t]*/)![0];

function indentUnit(t: string): string {
  const m = /\n([ \t]+)"/.exec(t);
  return m ? (m[1][0] === '\t' ? '\t' : ' '.repeat(Math.min(m[1].length, 8))) : '  ';
}

function render(value: unknown, indent: string, unit: string): string {
  return JSON.stringify(value, null, unit).replace(/\n/g, `\n${indent}`);
}

function insert(t: string, obj: JsonObject, key: string, value: unknown, unit: string): string {
  const oneLine = !t.slice(obj.open, obj.close).includes('\n') && obj.members.length > 0;
  if (oneLine) {
    const last = obj.members[obj.members.length - 1];
    return `${t.slice(0, last.valueEnd)}, ${JSON.stringify(key)}: ${JSON.stringify(value)}${t.slice(last.valueEnd)}`;
  }
  const indent = obj.members.length ? lineIndent(t, obj.members[0].start) : lineIndent(t, obj.close) + unit;
  const entry = `${JSON.stringify(key)}: ${render(value, indent, unit)}`;
  if (!obj.members.length) return `${t.slice(0, obj.open + 1)}\n${indent}${entry}\n${lineIndent(t, obj.close)}${t.slice(obj.close)}`;
  const last = obj.members[obj.members.length - 1];
  return `${t.slice(0, last.valueEnd)},\n${indent}${entry}${t.slice(last.valueEnd)}`;
}

/** Sets path (nested keys) to value, creating parent objects as needed. */
export function jsonSet(text: string, path: string[], value: unknown): string {
  const start = ws(text, 0);
  if (text[start] !== '{') throw new ToolError('bad_json', 'The file is not a JSON object.');
  const unit = indentUnit(text);
  let obj = parseObject(text, start);
  for (let i = 0; i < path.length; i++) {
    const m = obj.members.find((x) => x.key === path[i]);
    const last = i === path.length - 1;
    if (!m) {
      let v: unknown = value;
      for (const k of path.slice(i + 1).reverse()) v = { [k]: v };
      return insert(text, obj, path[i], v, unit);
    }
    if (last) {
      const indent = lineIndent(text, m.start);
      return text.slice(0, m.valueStart) + render(value, indent, unit) + text.slice(m.valueEnd);
    }
    if (!m.object) throw new ToolError('key_conflict', `${path.slice(0, i + 1).join('.')} is a text, so it cannot hold ${path.join('.')}.`, 'Pick another key name.');
    obj = m.object;
  }
  return text;
}
