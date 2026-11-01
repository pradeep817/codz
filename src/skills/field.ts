// codz field add / field remove: one field in an existing model, everywhere
// the model spells it (TypeScript interfaces, Dart classes in plain,
// json_serializable or freezed style, Kotlin data classes, Swift Codable
// structs). Only the field's own lines change; everything else in the file,
// including code you wrote by hand, stays as it is. Then it lists the files
// that use the model, so you can show the new field (or see what breaks).

import { join } from 'node:path';
import { dartType, fieldName, type DartGen } from '../adapters/dartGen.ts';
import { renderModel } from '../adapters/flutterGen.ts';
import { renderFreezedModel } from '../adapters/flutterStyles.ts';
import { swiftName, swiftText, swiftType } from '../adapters/ios.ts';
import { addKotlinImports, kotlinName, renderDataClass } from '../adapters/kotlinGen.ts';
import { findTsBlock, renderInterface } from '../adapters/nextjsGen.ts';
import { matchBrace, maskCode } from '../adapters/source.ts';
import { loadMap } from '../core/cache.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { loadConfig } from '../core/config.ts';
import { readText, walk } from '../core/fsutil.ts';
import { ToolError, type Adapter, type ChangeSet, type Conventions, type InferredField, type InferredType, type ModelInfo, type ProjectMap } from '../core/types.ts';

export type FieldLang = 'ts' | 'dart' | 'kt' | 'swift';
export const fieldLangOf = (adapter: Adapter): FieldLang => (adapter.id === 'flutter' ? 'dart' : adapter.id === 'android' ? 'kt' : adapter.id === 'ios' ? 'swift' : 'ts');

const TYPE_WORDS: Record<string, InferredType> = {
  string: { kind: 'string' }, text: { kind: 'string' }, str: { kind: 'string' },
  int: { kind: 'int' }, integer: { kind: 'int' }, long: { kind: 'int' },
  double: { kind: 'double' }, float: { kind: 'double' }, number: { kind: 'double' }, num: { kind: 'double' }, decimal: { kind: 'double' },
  bool: { kind: 'bool' }, boolean: { kind: 'bool' },
  date: { kind: 'date' }, datetime: { kind: 'date' }, timestamp: { kind: 'date' },
  any: { kind: 'unknown' }, unknown: { kind: 'unknown' }, json: { kind: 'unknown' }, dynamic: { kind: 'unknown' },
};
export const FIELD_TYPES = 'string, int, double, bool, date, any, a model name, or a list: string[] / list<Model>';

/** Finds a model by name: exact, any case, or without the project's class suffix (Category → CategoryModel). */
export function findModel(map: ProjectMap, name: string): ModelInfo {
  const low = name.toLowerCase();
  const suffix = (map.conventions.modelClassSuffix ?? '').toLowerCase();
  const m =
    map.models.find((x) => x.name === name) ??
    map.models.find((x) => x.name.toLowerCase() === low) ??
    (suffix ? map.models.find((x) => x.name.toLowerCase() === low + suffix) : undefined);
  if (m) return m;
  const names = map.models.map((x) => x.name).sort();
  throw new ToolError('no_model', `No model called ${name}.`, names.length ? `Models: ${names.slice(0, 30).join(', ')}${names.length > 30 ? ', …' : ''}` : 'This project has no models codz can read yet.');
}

function parseType(raw: string, map: ProjectMap): InferredType {
  const t = raw.trim();
  const list = /^(?:list|array)<(.+)>$/i.exec(t) ?? /^\[(.+)\]$/.exec(t) ?? /^(.+)\[\]$/.exec(t);
  if (list) return { kind: 'array', item: parseType(list[1], map) };
  const word = TYPE_WORDS[t.toLowerCase()];
  if (word) return word;
  if (/^[A-Za-z_]\w*$/.test(t)) {
    try {
      return { kind: 'object', model: findModel(map, t).name };
    } catch {
      throw new ToolError('bad_args', `Unknown type "${t}": it is not a basic type or a model in this project.`, `Types: ${FIELD_TYPES}. Add the model first (api add, or by hand).`);
    }
  }
  throw new ToolError('bad_args', `Unknown type "${t}".`, `Types: ${FIELD_TYPES}.`);
}

/** "rating:double?", "rating?:double", "tags:string[]", "note" (a string). The name is the JSON key. */
export function parseFieldArg(arg: string, map: ProjectMap): InferredField {
  const m = /^([A-Za-z_$][\w$-]*)(\?)?(?::(.+?))?(\?)?$/.exec(arg.trim());
  if (!m) throw new ToolError('bad_args', `Cannot read the field "${arg}".`, 'Write name:type, with ? for an optional field: rating:double?  tags:string[]  category:Category');
  return { jsonName: m[1], type: m[3] ? parseType(m[3], map) : { kind: 'string' }, nullable: Boolean(m[2] || m[4]) };
}

// ---------- small text helpers ----------

const lineStart = (text: string, i: number) => text.lastIndexOf('\n', i - 1) + 1;
const indentAt = (text: string, i: number) => /^[ \t]*/.exec(text.slice(lineStart(text, i)))![0];

/** Inserts lines just before the line holding `close`, re-indented like the items above, with a comma after the previous item when `comma`. */
function insertBefore(text: string, close: number, lines: string[], opts: { comma: boolean; unit: string; what: string }): string {
  const ls = lineStart(text, close);
  if (text.slice(ls, close).trim()) throw new ToolError('not_supported', `The ${opts.what} is written on one line, so codz cannot add to it safely.`, 'Put each item on its own line, then run this again.');
  // The previous item: last non-blank, non-comment line before this one.
  let prevEnd = ls - 1;
  while (prevEnd > 0) {
    const s = lineStart(text, prevEnd);
    const line = text.slice(s, prevEnd).trim();
    if (line && !line.startsWith('//')) break;
    prevEnd = s - 1;
  }
  const prevLine = text.slice(lineStart(text, prevEnd), prevEnd);
  const opener = /[({[]\s*$/.test(prevLine);
  const ind = opener ? indentAt(text, close) + opts.unit : /^[ \t]*/.exec(prevLine)![0];
  const strip = Math.min(...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
  const block = lines.map((l) => (l.trim() ? ind + l.slice(strip) : '')).join('\n') + '\n';
  let out = text.slice(0, ls) + block + text.slice(ls);
  if (opts.comma && !opener && !/,\s*(\/\/.*)?$/.test(prevLine)) {
    const code = prevLine.replace(/\s*\/\/.*$/, '');
    const at = lineStart(text, prevEnd) + code.length;
    out = out.slice(0, at) + ',' + out.slice(at);
  }
  return out;
}

/** The lines strictly between the first line matching `open` and the next line matching `close`. */
function between(rendered: string, open: RegExp, close: RegExp): string[] {
  const L = rendered.split('\n');
  const a = L.findIndex((l) => open.test(l));
  if (a < 0) return [];
  const b = L.findIndex((l, i) => i > a && close.test(l));
  return L.slice(a + 1, b < 0 ? undefined : b);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- add, per language ----------

function addTs(text: string, model: string, f: InferredField, c: Conventions): string {
  const block = findTsBlock(text, model);
  if (!block) throw new ToolError('not_supported', `Could not find "export interface ${model}" or "export type ${model} = {".`);
  const q = c.quote === 'double' ? '"' : "'";
  const lines = between(renderInterface({ name: model, fields: [f] }, { c, q, style: { quote: q, semi: true, indent: '  ' } }), /\{$/, /^\}$/);
  // Match the separator the interface uses (; , or none).
  const inside = text.slice(block.start, block.end);
  const sep = /,\s*\n\s*\}/.test(inside) ? ',' : /;\s*\n/.test(inside) || !/\n[^\n]*\w[^\n]*\n/.test(inside) ? ';' : '';
  const fixed = lines.map((l) => (/^\s*(\/\/|\/\*\*)/.test(l) ? l : l.replace(/;$/, sep)));
  const close = text.lastIndexOf('}', block.end - 1);
  return insertBefore(text, close, fixed, { comma: false, unit: c.indent === 'tab' ? '\t' : ' '.repeat(Number(c.indent) || 2), what: `${model} interface` });
}

function ktSerialization(text: string, c: Conventions): string {
  if (/import\s+com\.squareup\.moshi\./.test(text)) return 'moshi';
  if (/import\s+com\.google\.gson\./.test(text)) return 'gson';
  if (/@Serializable\b|import\s+kotlinx\.serialization\./.test(text)) return 'kotlinx';
  return c.serialization || 'kotlinx';
}

function addKt(text: string, model: string, f: InferredField, c: Conventions): string {
  const m = new RegExp(`data\\s+class\\s+${esc(model)}\\s*(?:<[^>]*>)?\\s*\\(`).exec(text);
  if (!m) throw new ToolError('not_supported', `Could not find "data class ${model}(".`);
  const open = m.index + m[0].length - 1;
  const close = matchBrace(text, open, 'dart');
  const ser = ktSerialization(text, c);
  const pkg = /^package\s+([\w.]+)/m.exec(text)?.[1] ?? '';
  const rendered = renderDataClass({ name: model, fields: [f] }, { ...c, serialization: ser } as Conventions, pkg);
  const lines = between(rendered, /^data class /, /^\)$/);
  const imports = [...rendered.matchAll(/^import\s+([\w.]+)$/gm)].map((x) => x[1]);
  const out = insertBefore(text, close, lines, { comma: true, unit: '    ', what: `${model} constructor` });
  return addKotlinImports(out, imports, pkg);
}

function dartStyle(body: string, cls: string): 'freezed' | 'json_serializable' | 'plain' {
  if (new RegExp(`const\\s+factory\\s+${esc(cls)}\\s*\\(`).test(body)) return 'freezed';
  if (new RegExp(`_\\$${esc(cls)}FromJson`).test(body)) return 'json_serializable';
  return 'plain';
}

/** Index of the brace or paren that opens after `re` matches, or -1. */
function openAfter(text: string, masked: string, re: RegExp, from = 0): number {
  re.lastIndex = 0;
  const m = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  m.lastIndex = from;
  const hit = m.exec(masked);
  return hit ? hit.index + hit[0].length - 1 : -1;
}

function addDart(text: string, cls: string, f: InferredField, c: Conventions): string {
  const masked = maskCode(text, 'dart');
  const head = new RegExp(`class\\s+${esc(cls)}\\b[^{]*\\{`).exec(masked);
  if (!head) throw new ToolError('not_supported', `Could not find "class ${cls}".`);
  const bodyOpen = head.index + head[0].length - 1;
  const bodyClose = matchBrace(text, bodyOpen, 'dart');
  const style = dartStyle(text.slice(bodyOpen, bodyClose), cls);
  const g: DartGen = { c: { ...c, serialization: style === 'plain' ? 'manual' : style } as Conventions, indent: '  ', cls: (n) => n };
  const unit = c.indent === 'tab' ? '\t' : ' '.repeat(Number(c.indent) || 2);
  const fail = (part: string) => new ToolError('not_supported', `${cls} does not have the ${part} codz expects, so it was left alone.`, 'Add the field by hand, or regenerate the model with codz api update.');
  const one = { name: cls, fields: [f] };
  let out = text;
  // Work from the bottom up so earlier offsets stay valid.
  const steps: { at: number; lines: string[]; comma: boolean; what: string }[] = [];
  const m2 = maskCode(out, 'dart');
  if (style === 'freezed') {
    const rendered = renderFreezedModel(one, g, 'x');
    const open = openAfter(out, m2, new RegExp(`const\\s+factory\\s+${esc(cls)}\\s*\\(\\s*\\{`), bodyOpen);
    if (open < 0) throw fail('named parameters in its factory constructor');
    steps.push({ at: matchBrace(out, open, 'dart'), lines: between(rendered, /const factory .*\(\{$/, /^\s*\}\)/), comma: true, what: 'factory constructor' });
  } else {
    const rendered = renderModel(one, g, 'x');
    const ctor = openAfter(out, m2, new RegExp(`(?:const\\s+)?${esc(cls)}\\s*\\(\\s*\\{`), bodyOpen);
    if (ctor < 0 || ctor > bodyClose) throw fail('constructor with named parameters');
    steps.push({ at: matchBrace(out, ctor, 'dart'), lines: between(rendered, /^\s*const \w+\(\{$/, /^\s*\}\);$/), comma: true, what: 'constructor' });
    // Fields: after the last `final Type name;` of the class.
    const fieldLines = rendered.split('\n').filter((l, i, all) => /^\s*final /.test(l) || ((/^\s*@JsonKey/.test(l) || /^\s*\/\/ codz:/.test(l)) && /^\s*(final|@JsonKey)/.test(all[i + 1] ?? '')));
    const finals = [...m2.slice(bodyOpen, bodyClose).matchAll(/^[ \t]*(?:late\s+)?final\s+[^;=()]+;[ \t]*$/gm)];
    if (!finals.length) throw fail('final fields');
    const last = finals[finals.length - 1];
    const afterLast = bodyOpen + last.index! + last[0].length;
    steps.push({ at: -afterLast, lines: fieldLines, comma: false, what: 'fields' });
    if (style === 'plain') {
      const fromJson = openAfter(out, m2, new RegExp(`factory\\s+${esc(cls)}\\.fromJson\\s*\\([^)]*\\)\\s*(?:=>\\s*${esc(cls)}\\s*\\(|\\{[^]*?return\\s+${esc(cls)}\\s*\\()`), bodyOpen);
      if (fromJson < 0) throw fail('fromJson factory');
      steps.push({ at: matchBrace(out, fromJson, 'dart'), lines: between(rendered, /fromJson\(/, /^\s*\);$/), comma: true, what: 'fromJson' });
      const toJson = openAfter(out, m2, /toJson\s*\(\s*\)\s*(?:=>\s*(?:<[^>]*>\s*)?\{|\{\s*return\s*(?:<[^>]*>\s*)?\{)/, bodyOpen);
      if (toJson < 0) throw fail('toJson method');
      steps.push({ at: matchBrace(out, toJson, 'dart'), lines: between(rendered, /toJson\(\) => \{$/, /^\s*\};$/), comma: true, what: 'toJson' });
    }
  }
  for (const s of steps.sort((a, b) => Math.abs(b.at) - Math.abs(a.at))) {
    if (s.at < 0) {
      const at = -s.at;
      const ind = indentAt(out, at - 1);
      const strip = Math.min(...s.lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
      out = out.slice(0, at) + '\n' + s.lines.map((l) => ind + l.slice(strip)).join('\n') + out.slice(at);
    } else out = insertBefore(out, s.at, s.lines, { comma: s.comma, unit, what: `${cls} ${s.what}` });
  }
  void dartType;
  return out;
}

function addSwift(text: string, model: string, f: InferredField, current: ModelInfo, c: Conventions): string {
  const type = swiftType(f.type);
  if (!type) throw new ToolError('bad_args', `Swift needs a concrete type for ${f.jsonName}.`, `Types: ${FIELD_TYPES.replace('any, ', '')}.`);
  const head = new RegExp(`struct\\s+${esc(model)}\\b[^{]*\\{`).exec(maskCode(text, 'dart'));
  if (!head) throw new ToolError('not_supported', `Could not find "struct ${model}".`);
  const open = head.index + head[0].length - 1;
  const close = matchBrace(text, open, 'dart');
  const I = c.indent === 'tab' ? '\t' : ' '.repeat(Number(c.indent) || 4);
  const name = swiftName(f.jsonName);
  const bare = name.replace(/`/g, '');
  const body = text.slice(open, close);
  const lets = [...body.matchAll(/^[ \t]*(?:public\s+)?(?:let|var)\s+(`?\w+`?)\s*:[^\n]*$/gm)];
  const keys = /enum\s+CodingKeys\s*:\s*String[^{]*\{/.exec(body);
  let out = text;
  const edits: { at: number; insert: string }[] = [];
  const decl = `let ${name}: ${type}${f.nullable ? '?' : ''}`;
  if (lets.length) {
    const last = lets[lets.length - 1];
    const at = open + last.index! + last[0].length;
    edits.push({ at, insert: `\n${indentAt(text, at - 1)}${decl}` });
  } else edits.push({ at: open + 1, insert: `\n${I}${decl}` });
  const caseLine = bare === f.jsonName ? `case ${name}` : `case ${name} = "${swiftText(f.jsonName)}"`;
  if (keys) {
    const kOpen = open + keys.index + keys[0].length - 1;
    const kClose = matchBrace(text, kOpen, 'dart');
    edits.push({ at: lineStart(text, kClose), insert: `${indentAt(text, kClose)}${I}${caseLine}\n` });
  } else if (bare !== f.jsonName) {
    // A new snake_case key needs CodingKeys; list the existing properties too.
    const existing = lets.map((l) => l[1]).map((n) => {
      const json = current.fields.find((x) => swiftName(x.name) === n)?.name ?? n.replace(/`/g, '');
      return n.replace(/`/g, '') === json ? `case ${n}` : `case ${n} = "${swiftText(json)}"`;
    });
    const ind = indentAt(text, close) + I;
    edits.push({ at: lineStart(text, close), insert: `\n${ind}enum CodingKeys: String, CodingKey {\n${[...existing, caseLine].map((l) => `${ind}${I}${l}`).join('\n')}\n${ind}}\n` });
  }
  for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.insert + out.slice(e.at);
  return out;
}

// ---------- remove, per language ----------

/** Removes whole lines matching `re` inside [from, to), plus annotation or comment lines directly above them. */
function dropLines(text: string, from: number, to: number, re: RegExp, aboveRe = /^\s*(\/\/ codz:|\/\*\*.*\*\/\s*$|@JsonKey\b[^\n]*\)\s*$)/): { text: string; n: number } {
  const L = text.split('\n');
  let pos = 0;
  const drop = new Set<number>();
  L.forEach((l, i) => {
    const s = pos;
    pos += l.length + 1;
    if (s < from || s >= to || !re.test(l)) return;
    drop.add(i);
    for (let j = i - 1; j >= 0 && aboveRe.test(L[j]); j--) drop.add(j);
  });
  return { text: L.filter((_, i) => !drop.has(i)).join('\n'), n: [...drop].filter((i) => re.test(L[i])).length };
}

function removeField(text: string, lang: FieldLang, model: string, f: { jsonName: string }): { text: string; n: number } {
  const masked = maskCode(text, lang === 'ts' ? 'ts' : 'dart');
  const headRe = lang === 'ts' ? null : lang === 'kt' ? new RegExp(`data\\s+class\\s+${esc(model)}\\s*(?:<[^>]*>)?\\s*\\(`) : lang === 'swift' ? new RegExp(`struct\\s+${esc(model)}\\b[^{]*\\{`) : new RegExp(`class\\s+${esc(model)}\\b[^{]*\\{`);
  let from: number;
  let to: number;
  if (lang === 'ts') {
    const b = findTsBlock(text, model);
    if (!b) throw new ToolError('not_supported', `Could not find "export interface ${model}".`);
    [from, to] = [b.start, b.end];
  } else {
    const h = headRe!.exec(masked);
    if (!h) throw new ToolError('not_supported', `Could not find ${model}.`);
    from = h.index;
    to = matchBrace(text, h.index + h[0].length - 1, 'dart') + 1;
  }
  const j = esc(f.jsonName);
  if (lang === 'ts') return dropLines(text, from, to, new RegExp(`^\\s*(['"]?)${j}\\1\\??\\s*:`));
  if (lang === 'kt') {
    const n = esc(kotlinName(f.jsonName));
    return dropLines(text, from, to, new RegExp(`^\\s*(@\\w+\\([^)]*\\)\\s*)*(override\\s+)?va[lr]\\s+${n}\\s*:`), /^\s*\/\/ codz:/);
  }
  if (lang === 'swift') {
    const n = esc(swiftName(f.jsonName));
    return dropLines(text, from, to, new RegExp(`^\\s*((public|private)\\s+)?(let|var)\\s+${n}\\s*:|^\\s*case\\s+${n}\\b(\\s*=\\s*"[^"]*")?\\s*$`), /^\s*\/\/ codz:/);
  }
  const n = esc(fieldName({ jsonName: f.jsonName, type: { kind: 'string' }, nullable: true }));
  return dropLines(
    text,
    from,
    to,
    new RegExp(
      [
        `^\\s*(required\\s+)?this\\.${n}\\s*,?\\s*$`, // constructor
        `^\\s*(@\\w+\\([^)]*\\)\\s*)*(required\\s+)?[\\w<>?, ]+\\s+${n}\\s*,?\\s*$`, // freezed parameter
        `^\\s*${n}\\s*:.*,\\s*$`, // fromJson argument
        `^\\s*(late\\s+)?final\\s+[\\w<>?, ]+\\s+${n}\\s*;\\s*$`, // field
        `^\\s*['"]${j}['"]\\s*:.*,\\s*$`, // toJson entry
      ].join('|'),
    ),
  );
}

// ---------- plans ----------

/** Files outside the models that use the model, with the lines that use the given fields. */
function usages(root: string, map: ProjectMap, lang: FieldLang, model: ModelInfo, fields: string[], files: string[]): { users: string[]; hits: string[] } {
  const modelFiles = new Set(map.models.map((m) => m.file));
  const word = new RegExp(`\\b${esc(model.name)}\\b`);
  const users: string[] = [];
  const hits: string[] = [];
  const access = (json: string) => (lang === 'ts' ? json : lang === 'kt' ? kotlinName(json) : lang === 'swift' ? swiftName(json) : fieldName({ jsonName: json, type: { kind: 'string' }, nullable: true })).replace(/`/g, '');
  for (const f of files) {
    if (modelFiles.has(f)) continue;
    const t = readText(join(root, f)) ?? '';
    if (!word.test(t)) continue;
    users.push(f);
    t.split('\n').forEach((l, i) => {
      for (const field of fields) if (new RegExp(`\\.${esc(access(field))}\\b|\\[['"]${esc(field)}['"]\\]`).test(l)) hits.push(`    ${f}:${i + 1}  ${l.trim()}`);
    });
  }
  return { users, hits };
}

function codeFilesOf(root: string, lang: FieldLang): string[] {
  if (lang === 'dart') return walk(root, 'lib', { exts: ['.dart'] }).filter((f) => !/\.(g|freezed)\.dart$/.test(f));
  if (lang === 'kt') return walk(root, '.', { exts: ['.kt'], extraIgnored: ['build', '.gradle'] });
  if (lang === 'swift') return walk(root, '.', { exts: ['.swift'], extraIgnored: ['build', 'DerivedData'] });
  return walk(root, '.', { exts: ['.ts', '.tsx', '.js', '.jsx', '.mjs'] }).filter((f) => !f.endsWith('.d.ts'));
}

export async function planFieldAdd(root: string, adapter: Adapter, modelName: string, args: string[]): Promise<ChangeSet> {
  if (!args.length) throw new ToolError('bad_args', 'Which field? codz field add <Model> <name:type> ...', 'Example: codz field add Product rating:double? tags:string[]');
  const lang = fieldLangOf(adapter);
  const conventions = loadConfig(root).conventions;
  const { map } = await loadMap(root, adapter, conventions);
  const model = findModel(map, modelName);
  const fields = args.map((a) => parseFieldArg(a, map));
  let text = readText(join(root, model.file));
  if (text === null) throw new ToolError('not_found', `Cannot read ${model.file}.`);
  const summary: string[] = [];
  const warnings: string[] = [];
  const norm = (s: string) => s.replace(/[_\-\s]/g, '').toLowerCase();
  for (const f of fields) {
    if (model.fields.some((x) => norm(x.name) === norm(f.jsonName))) throw new ToolError('field_exists', `${model.name} already has ${f.jsonName}.`, `To change its type: codz field remove ${model.name} ${f.jsonName}, then add it again.`);
    const c = map.conventions;
    text = lang === 'ts' ? addTs(text, model.name, f, c) : lang === 'kt' ? addKt(text, model.name, f, c) : lang === 'swift' ? addSwift(text, model.name, f, model, c) : addDart(text, model.name, f, c);
    model.fields.push({ name: f.jsonName, type: '', nullable: f.nullable });
    summary.push(`Add ${f.jsonName}${f.nullable ? '?' : ''}: ${describe(f.type)} to ${model.name} (${model.file})`);
  }
  const required = fields.filter((f) => !f.nullable && f.type.kind !== 'unknown').map((f) => f.jsonName);
  if (required.length && lang !== 'ts') warnings.push(`${required.join(', ')} ${required.length === 1 ? 'is' : 'are'} required: responses without ${required.length === 1 ? 'it' : 'them'} will fail to parse. Add ? (rating:double?) if older responses may not have ${required.length === 1 ? 'it' : 'them'}.`);
  if (lang === 'dart' && /part\s+'[^']+\.(g|freezed)\.dart'/.test(text)) warnings.push('Run dart run build_runner build to regenerate the .g.dart / .freezed.dart files.');
  const { users } = usages(root, map, lang, model, [], codeFilesOf(root, lang));
  if (users.length) summary.push(`${model.name} is used in ${users.length} file${users.length === 1 ? '' : 's'}; show the new field where it belongs:`, ...users.slice(0, 12).map((u) => `  ${u}`), ...(users.length > 12 ? [`  … and ${users.length - 12} more`] : []));
  summary.push('codz mock serve picks the new field up with sample data.');
  return buildChangeSet(root, 'field add', { files: new Map([[model.file, text]]), summary, warnings, generated: [] });
}

export async function planFieldRemove(root: string, adapter: Adapter, modelName: string, names: string[]): Promise<ChangeSet> {
  if (!names.length) throw new ToolError('bad_args', 'Which field? codz field remove <Model> <field> ...');
  const lang = fieldLangOf(adapter);
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  const model = findModel(map, modelName);
  let text = readText(join(root, model.file));
  if (text === null) throw new ToolError('not_found', `Cannot read ${model.file}.`);
  const norm = (s: string) => s.replace(/[_\-\s]/g, '').toLowerCase();
  const summary: string[] = [];
  const removed: string[] = [];
  for (const raw of names) {
    const f = model.fields.find((x) => x.name === raw) ?? model.fields.find((x) => norm(x.name) === norm(raw));
    if (!f) throw new ToolError('no_field', `${model.name} has no field ${raw}.`, `Fields: ${model.fields.map((x) => x.name).join(', ')}`);
    const r = removeField(text, lang, model.name, { jsonName: f.name });
    if (!r.n) throw new ToolError('not_supported', `Could not find the lines for ${f.name} in ${model.file}; remove it by hand.`);
    text = r.text;
    removed.push(f.name);
    summary.push(`Remove ${f.name} from ${model.name} (${model.file})`);
  }
  const warnings: string[] = [];
  if (lang === 'dart' && /part\s+'[^']+\.(g|freezed)\.dart'/.test(text)) warnings.push('Run dart run build_runner build to regenerate the .g.dart / .freezed.dart files.');
  const { hits } = usages(root, map, lang, model, removed, codeFilesOf(root, lang));
  if (hits.length) warnings.push(`These lines still use ${removed.join(', ')}; update them:\n${hits.slice(0, 30).join('\n')}${hits.length > 30 ? `\n    … and ${hits.length - 30} more` : ''}`);
  else summary.push(`No code outside the model uses ${removed.join(', ')}.`);
  return buildChangeSet(root, 'field remove', { files: new Map([[model.file, text]]), summary, warnings, generated: [] });
}

function describe(t: InferredType): string {
  return t.kind === 'array' ? `${describe(t.item)}[]` : t.kind === 'object' ? t.model : t.kind === 'unknown' ? 'any' : t.kind;
}
