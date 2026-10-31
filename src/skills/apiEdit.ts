// api update, api remove and api rename: changing endpoints that already exist.
//
// update  rebuilds the response model from new samples (in place, same file),
//         rewrites the function or method where it was, and reports which
//         files use fields that were removed or changed type.
// remove  deletes the function or method, drops imports it alone needed, and
//         lists callers that will break.
// rename  renames the declaration and its call sites.

import { join, posix } from 'node:path';
import { loadMap } from '../core/cache.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { loadConfig } from '../core/config.ts';
import { readText, walk } from '../core/fsutil.ts';
import { ToolError, type Adapter, type ChangeSet, type EndpointInfo, type EndpointSpec, type HttpMethod, type InferredType, type ModelInfo, type ProjectMap, type QueryParam } from '../core/types.ts';
import { maskCode, matchBrace } from '../adapters/source.ts';
import { mergeDart, mergeTsDocs } from '../core/merge.ts';
import { loadTypeScript, tsIdentifierUses } from '../core/tsAst.ts';
import { buildEndpoint } from '../input/endpoint.ts';
import { camel, DART_RESERVED, TS_RESERVED } from '../input/naming.ts';
import { KOTLIN_RESERVED } from '../adapters/kotlinGen.ts';

type Lang = 'ts' | 'dart' | 'kt';
const langOf = (adapter: Adapter): Lang => (adapter.id === 'flutter' ? 'dart' : adapter.id === 'android' ? 'kt' : 'ts');
/** Kotlin strings and comments mask like Dart (string templates, line and block comments). */
const ml = (lang: Lang): 'ts' | 'dart' => (lang === 'kt' ? 'dart' : lang);

function findEndpoint(map: ProjectMap, name: string): EndpointInfo {
  const ep = map.endpoints.find((e) => e.name === name) ?? map.endpoints.find((e) => e.name.toLowerCase() === name.toLowerCase());
  if (!ep) {
    const names = map.endpoints.map((e) => e.name);
    throw new ToolError('no_endpoint', `No endpoint called ${name} was found.`, names.length ? `Endpoints in this project: ${names.join(', ')}` : undefined);
  }
  return ep;
}

/** Locates a function (TS) or method (Dart) declaration, including the doc comment above it. */
export function findDeclaration(text: string, name: string, lang: Lang): { start: number; end: number; params: string; returnType: string } | null {
  if (lang === 'kt') return findKotlinDeclaration(text, name);
  const re =
    lang === 'ts'
      ? new RegExp(`(^|\\n)((?:[ \\t]*(?:/\\*\\*(?:(?!\\*/)[^])*\\*/|//[^\\n]*)\\n)*)[ \\t]*export\\s+(?:async\\s+)?function\\s+${name}\\s*(?:<[^>()]*>)?\\s*\\(`)
      : new RegExp(`(^|\\n)((?:[ \\t]*(?:///[^\\n]*|@\\w+(?:\\([^\\n]*\\))?)\\n)*)[ \\t]*Future<([^\\n]*)>\\s+${name}\\s*\\(`);
  const m = re.exec(text);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const closeParams = matchBrace(text, open, ml(lang));
  if (closeParams === -1) return null;
  const params = text.slice(open + 1, closeParams);
  let i = closeParams + 1;
  // An abstract method (Retrofit) ends right after its parameters.
  if (lang === 'dart' && /^\s*;/.test(text.slice(i))) return { start: m.index + (m[1] ? 1 : 0), end: text.indexOf(';', i) + 1, params, returnType: m[3].trim() };
  // Return type (TS) and async (Dart) up to the body.
  const bodyOpen = text.indexOf('{', i);
  const arrow = text.indexOf('=>', i);
  let end: number;
  let returnType = lang === 'dart' ? m[3].trim() : '';
  if (arrow !== -1 && (bodyOpen === -1 || arrow < bodyOpen)) {
    end = text.indexOf(';', arrow);
  } else {
    if (lang === 'ts') returnType = text.slice(i, bodyOpen).replace(/^\s*:\s*/, '').trim();
    end = matchBrace(text, bodyOpen, ml(lang));
  }
  if (end === -1) return null;
  return { start: m.index + (m[1] ? 1 : 0), end: end + 1, params, returnType };
}

/** A Kotlin `fun` (an abstract Retrofit method ends with its line), with the doc comment and annotations above it. */
function findKotlinDeclaration(text: string, name: string): { start: number; end: number; params: string; returnType: string } | null {
  const m = new RegExp(`(^|\\n)((?:[ \\t]*(?:/\\*\\*(?:(?!\\*/)[^])*\\*/|//[^\\n]*|@\\w+(?:\\([^\\n]*\\))?)[ \\t]*\\n)*)[ \\t]*(?:(?:override|suspend|public|internal)\\s+)*fun\\s+${name}\\s*\\(`).exec(text);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = matchBrace(text, open, 'dart');
  if (close === -1) return null;
  const params = text.slice(open + 1, close);
  const lineEnd = text.indexOf('\n', close) === -1 ? text.length : text.indexOf('\n', close);
  const tail = text.slice(close + 1, lineEnd);
  const returnType = /^\s*:\s*([^={]+?)\s*(?:[={]|$)/.exec(tail)?.[1]?.trim() ?? 'Unit';
  let end = lineEnd;
  const brace = tail.indexOf('{');
  if (brace !== -1) end = matchBrace(text, close + 1 + brace, 'dart') + 1;
  return { start: m.index + (m[1] ? 1 : 0), end, params, returnType };
}

/** Removes a block and tidies the blank lines around it. */
function cut(text: string, start: number, end: number): string {
  const before = text.slice(0, start).replace(/\n[ \t]*\n[ \t]*$/, '\n').replace(/[ \t]*$/, '');
  let after = text.slice(end).replace(/^[ \t]*\n/, '');
  if (!before.endsWith('\n') && after) after = '\n' + after;
  return (before + after).replace(/\n{3,}/g, '\n\n');
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The local name an import specifier binds: `type User` → User, `User as U` → U. */
function localName(spec: string): string {
  return spec.replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim();
}

/**
 * Drops imports that the removal left unused. An import that was already unused
 * before the change is not touched (that is not this command's business), and
 * usage is only counted in code, never in strings or comments.
 */
function pruneImports(before: string, after: string, lang: Lang, file: string, map: ProjectMap): string {
  if (lang === 'ts') {
    const re = /^import\s+(type\s+)?\{([^}]*)\}\s*from\s*(['"][^'"]+['"]);?[ \t]*\n/gm;
    const usedIn = (text: string, line: string, name: string) => new RegExp(`\\b${esc(name)}\\b`).test(maskCode(text.replace(line, ''), 'ts'));
    return after.replace(re, (line, _typeKw: string | undefined, names: string) => {
      const specs = names.split(',').map((n) => n.trim()).filter(Boolean);
      const keep = specs.filter((sp) => {
        const local = localName(sp);
        // Unused before too: leave it alone.
        if (!before.includes(line) || !usedIn(before, line, local)) return true;
        return usedIn(after, line, local);
      });
      if (keep.length === specs.length) return line;
      if (!keep.length) return '';
      return line.replace(/\{[^}]*\}/, `{ ${keep.join(', ')} }`);
    });
  }
  if (lang === 'kt') {
    // import pkg.Class: unused when Class no longer appears (and it did before).
    return after.replace(/^import\s+([\w.]+)\.(\w+)[ \t]*\n/gm, (line, _pkg: string, cls: string) => {
      const used = (text: string) => new RegExp(`\\b${esc(cls)}\\b`).test(maskCode(text.replace(line, ''), 'dart'));
      if (!used(before)) return line;
      return used(after) ? line : '';
    });
  }
  // Dart: an import of a model file is unused when none of its classes appear.
  return after.replace(/^import\s+'([^']+)';[ \t]*\n/gm, (line, uri: string) => {
    let target: string | null = null;
    const pkg = map.conventions.packageName;
    if (pkg && uri.startsWith(`package:${pkg}/`)) target = `lib/${uri.slice(pkg.length + 9)}`;
    else if (!uri.includes(':')) target = posix.normalize(posix.join(posix.dirname(file), uri));
    if (!target) return line;
    const classes = map.models.filter((m) => m.file === target).map((m) => m.name);
    if (!classes.length) return line;
    const used = (text: string) => classes.some((c) => new RegExp(`\\b${esc(c)}\\b`).test(maskCode(text.replace(line, ''), 'dart')));
    if (!used(before)) return line;
    return used(after) ? line : '';
  });
}

function codeFiles(root: string, adapter: Adapter): string[] {
  if (adapter.id === 'android') return walk(root, '.', { exts: ['.kt'], extraIgnored: ['build', '.gradle'] });
  return adapter.id === 'flutter'
    ? walk(root, 'lib', { exts: ['.dart'] }).filter((f) => !/\.(g|freezed)\.dart$/.test(f))
    : walk(root, '.', { exts: ['.ts', '.tsx', '.js', '.jsx', '.mjs'] }).filter((f) => !f.endsWith('.d.ts'));
}

interface Site {
  file: string;
  /** Offset of the name in the file. */
  index: number;
  line: number;
  text: string;
}

/** Offset of the declared name in a declaration (the name right before its parameter list). */
function declNameIndex(masked: string, name: string, decl: { start: number; end: number }): number {
  const m = new RegExp(`\\b${esc(name)}(?=\\s*(?:<[^>()]*>)?\\s*\\()`).exec(masked.slice(decl.start, decl.end));
  return m ? decl.start + m.index : -1;
}

/** The Dart class that declares the endpoint (the last `class X` before the method). */
function enclosingClass(text: string, at: number): string | undefined {
  return [...text.slice(0, at).matchAll(/\b(?:class|interface)\s+(\w+)/g)].pop()?.[1];
}

/**
 * Every place that refers to the endpoint: calls, tear-offs, imports and named
 * re-exports, including other functions in the declaring file. The declaration
 * itself is not included. Strings and comments never count.
 *
 * TypeScript: bare `name` (not `.name` on some other object).
 * Dart: `.name` only in files that use the declaring class or its provider, and
 * bare `name(` / `this.name` inside the declaring class's own file.
 */
function sites(root: string, adapter: Adapter, ep: EndpointInfo, declText: string, decl: { start: number; end: number }): Site[] {
  const out: Site[] = [];
  const lang = langOf(adapter);
  const cls = lang !== 'ts' ? enclosingClass(declText, decl.start) : undefined;
  const clsRefs = cls ? new RegExp(`\\b(${esc(cls)}|${esc(cls[0].toLowerCase() + cls.slice(1))}Provider)\\b`) : null;
  const lineText = (t: string, i: number) => {
    const lineStart = t.lastIndexOf('\n', i) + 1;
    const lineEnd = t.indexOf('\n', i);
    return t.slice(lineStart, lineEnd === -1 ? t.length : lineEnd).trim();
  };
  // With the project's TypeScript compiler, uses come from the syntax tree:
  // shadowing locals, object keys and other objects' members are told apart
  // exactly, and other files only count when they import the name.
  const ts = lang === 'ts' ? loadTypeScript(root) : null;
  for (const f of codeFiles(root, adapter)) {
    const t = f === ep.file ? declText : readText(join(root, f)) ?? '';
    if (!t.includes(ep.name)) continue;
    const masked = maskCode(t, ml(lang));
    const own = f === ep.file;
    if (ts) {
      let uses;
      try {
        uses = tsIdentifierUses(ts, f, t, ep.name, own ? { declStart: declNameIndex(masked, ep.name, decl) } : {});
      } catch {
        uses = null;
      }
      if (uses) {
        // In another file, a bare name that is not imported is that file's own binding.
        const imported = own || uses.some((u) => u.kind === 'import' || u.kind === 'export') || /\bimport\s+\*\s+as\b/.test(masked);
        if (imported) for (const u of uses) out.push({ file: f, index: u.index, line: u.line, text: lineText(t, u.index) });
        continue;
      }
    }
    if (lang !== 'ts' && !own && !(clsRefs && clsRefs.test(masked))) continue;
    for (const m of masked.matchAll(new RegExp(`\\b${esc(ep.name)}\\b`, 'g'))) {
      const i = m.index!;
      if (own && i === declNameIndex(masked, ep.name, decl)) continue;
      const before = masked.slice(0, i).replace(/\s+$/, '');
      const dotted = before.endsWith('.') || before.endsWith('?.');
      if (lang === 'ts') {
        // obj.getUser is some other object's member, unless obj is a namespace import.
        if (dotted && !/\b\w+\s*\.$/.test(before)) continue;
        if (dotted) {
          const obj = /(\w+)\s*\??\.$/.exec(before)?.[1];
          if (!obj || !new RegExp(`import\\s+\\*\\s+as\\s+${esc(obj)}\\b`).test(masked)) continue;
        }
        // Property keys in object literals / types: { getUser: ... } that are not shorthand references.
        if (/^\s*\??:(?!:)/.test(masked.slice(i + ep.name.length)) && /[{,]\s*$/.test(before) && !/\bexport\s*\{[^}]*$/.test(before) && !/\bimport\s*(type\s*)?\{[^}]*$/.test(before)) continue;
      } else {
        if (own) {
          if (dotted && !/\bthis\s*\.$/.test(before)) continue;
        } else if (!dotted) continue;
      }
      out.push({ file: f, index: i, line: t.slice(0, i).split('\n').length, text: lineText(t, i) });
    }
  }
  return out;
}

// ---------------- remove ----------------

export async function planApiRemove(root: string, adapter: Adapter, name: string): Promise<ChangeSet> {
  const lang = langOf(adapter);
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  const ep = findEndpoint(map, name);
  const text = readText(join(root, ep.file)) ?? '';
  const decl = findDeclaration(text, ep.name, lang);
  if (!decl) throw new ToolError('no_endpoint', `Could not find the declaration of ${ep.name} in ${ep.file}.`);
  let next = cut(text, decl.start, decl.end);
  next = pruneImports(text, next, lang, ep.file, map);
  const files = new Map([[ep.file, next]]);
  const summary = [`Remove ${ep.name}() (${ep.method} ${ep.path}) from ${ep.file}`];
  const warnings: string[] = [];
  const calls = sites(root, adapter, ep, text, decl);
  if (calls.length) {
    warnings.push(`These places still use ${ep.name} and will stop compiling until you change them:\n${calls.map((c) => `    ${c.file}:${c.line}  ${c.text}`).join('\n')}`);
  }
  // Models only this endpoint used.
  const others = map.endpoints.filter((e) => e !== ep).map((e) => e.response ?? '').join(' ');
  for (const m of map.models) {
    if (ep.response && new RegExp(`\\b${m.name}\\b`).test(ep.response) && !new RegExp(`\\b${m.name}\\b`).test(others)) {
      warnings.push(`${m.name} (${m.file}) is no longer returned by any endpoint. Delete it if nothing else uses it.`);
    }
  }
  return buildChangeSet(root, 'api remove', { files, summary, warnings, generated: [] });
}

// ---------------- rename ----------------

export async function planApiRename(root: string, adapter: Adapter, from: string, to: string): Promise<ChangeSet> {
  const lang = langOf(adapter);
  const newName = camel(to);
  if (!newName || /^[0-9]/.test(newName) || TS_RESERVED.has(newName) || DART_RESERVED.has(newName) || KOTLIN_RESERVED.has(newName)) throw new ToolError('bad_name', `"${to}" cannot be used as a function name.`);
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  const ep = findEndpoint(map, from);
  if (map.endpoints.some((e) => e.name === newName)) throw new ToolError('name_conflict', `An endpoint called ${newName} already exists.`);
  const declText = readText(join(root, ep.file)) ?? '';
  const d = findDeclaration(declText, ep.name, lang);
  if (!d) throw new ToolError('no_endpoint', `Could not find the declaration of ${ep.name} in ${ep.file}.`);

  // Edit positions: the declaration's name plus every site, per file, from the end.
  const edits = new Map<string, number[]>();
  const headAt = declNameIndex(maskCode(declText, ml(lang)), ep.name, d);
  if (headAt !== -1) edits.set(ep.file, [headAt]);
  const found = sites(root, adapter, ep, declText, d);
  for (const s of found) edits.set(s.file, [...(edits.get(s.file) ?? []), s.index]);

  const files = new Map<string, string>();
  for (const [f, positions] of edits) {
    let t = f === ep.file ? declText : readText(join(root, f)) ?? '';
    for (const i of [...new Set(positions)].sort((a, b) => b - a)) t = t.slice(0, i) + newName + t.slice(i + ep.name.length);
    // Generated doc comments name the call ("via userRepository.getUser").
    t = t.replace(new RegExp(`(via \\w+\\.)${esc(ep.name)}\\b`, 'g'), `$1${newName}`);
    files.set(f, t);
  }
  const others = [...files.keys()].filter((f) => f !== ep.file);
  const sameFile = found.filter((s) => s.file === ep.file).length;
  const summary = [
    `Rename ${ep.name}() to ${newName}() in ${ep.file}${sameFile ? ` (and ${sameFile} use${sameFile === 1 ? '' : 's'} in the same file)` : ''}`,
    ...others.map((c) => `Update ${c}: ${found.filter((s) => s.file === c).length} use${found.filter((s) => s.file === c).length === 1 ? '' : 's'} of ${ep.name}`),
  ];
  return buildChangeSet(root, 'api rename', { files, summary, warnings: [], generated: [] });
}

// ---------------- update ----------------

export interface FieldChange {
  added: string[];
  removed: string[];
  changed: string[];
}

function diffFields(before: ModelInfo | undefined, after: ModelInfo | undefined): FieldChange {
  const norm = (s: string) => s.replace(/[_\-\s]/g, '').toLowerCase();
  const b = new Map((before?.fields ?? []).map((f) => [norm(f.name), f]));
  const a = new Map((after?.fields ?? []).map((f) => [norm(f.name), f]));
  const simplify = (t: string) => t.replace(/\s|\?|\|null/g, '').replace(/^(int|double|num)$/, 'number').toLowerCase();
  return {
    added: [...a.keys()].filter((k) => !b.has(k)).map((k) => a.get(k)!.name),
    removed: [...b.keys()].filter((k) => !a.has(k)).map((k) => b.get(k)!.name),
    changed: [...a.keys()].filter((k) => b.has(k) && (simplify(b.get(k)!.type) !== simplify(a.get(k)!.type) || b.get(k)!.nullable !== a.get(k)!.nullable)).map((k) => `${a.get(k)!.name}: ${b.get(k)!.type}${b.get(k)!.nullable ? '?' : ''} → ${a.get(k)!.type}${a.get(k)!.nullable ? '?' : ''}`),
  };
}

/** Reads path-parameter types, query parameters and the body type from an existing declaration. */
function readSignature(params: string, lang: Lang): { pathTypes: Map<string, 'int' | 'string'>; query: QueryParam[]; bodyType?: string } {
  const pathTypes = new Map<string, 'int' | 'string'>();
  const query: QueryParam[] = [];
  let bodyType: string | undefined;
  const kind = (t: string): InferredType => (/^(int|number)$/.test(t) ? { kind: 'int' } : /^double$/.test(t) ? { kind: 'double' } : /^(bool|boolean)$/.test(t) ? { kind: 'bool' } : { kind: 'string' });
  if (lang === 'ts') {
    const q = /params\?\s*:\s*\{([^}]*)\}/.exec(params);
    if (q) for (const part of q[1].split(';')) {
      const m = /^\s*['"]?([\w-]+)['"]?\??\s*:\s*(\w+)/.exec(part);
      if (m) query.push({ name: m[1], type: kind(m[2]) });
    }
    for (const m of params.replace(/params\?\s*:\s*\{[^}]*\}/, '').matchAll(/(\w+)\s*:\s*([\w[\]<>]+)/g)) {
      if (m[1] === 'body') bodyType = m[2];
      else pathTypes.set(m[1], m[2] === 'number' ? 'int' : 'string');
    }
  } else if (lang === 'kt') {
    // @Path("id") id: Int, @Query("page") page: Int? = null, @Body body: CreateUser
    for (const part of params.split(/,(?![^<(]*[>)])/)) {
      const m = /^\s*@(\w+)(?:\(\s*"([^"]*)"\s*\))?\s*`?(\w+)`?\s*:\s*([\w<>?, .]+?)\s*(?:=.*)?$/.exec(part.replace(/\s+/g, ' '));
      if (!m) continue;
      const t = m[4].replace(/\?$/, '');
      if (m[1] === 'Body') bodyType = t;
      else if (m[1] === 'Path') pathTypes.set(m[2] ?? m[3], /^(Int|Long)$/.test(t) ? 'int' : 'string');
      else if (m[1] === 'Query') query.push({ name: m[2] ?? m[3], type: /^(Int|Long)$/.test(t) ? { kind: 'int' } : t === 'Double' ? { kind: 'double' } : t === 'Boolean' ? { kind: 'bool' } : { kind: 'string' } });
    }
  } else {
    // Retrofit annotations (@Path('id'), @Query('page'), @Body()) carry the wire names.
    const strip = (x: string) => x.replace(/@\w+(?:\([^)]*\))?\s*/g, '');
    const named = /\{([^}]*)\}/.exec(params);
    if (named) for (const part of named[1].split(',')) {
      const key = /@Query\(\s*['"]([^'"]+)['"]/.exec(part)?.[1];
      const m = /^\s*([\w<>]+)\??\s+(\w+)/.exec(strip(part).trim());
      if (m) query.push({ name: key ?? m[2], type: kind(m[1]) });
    }
    for (const part of params.replace(/\{[^}]*\}/, '').split(',')) {
      const m = /^\s*([\w<>]+)\s+(\w+)\s*$/.exec(strip(part));
      if (!m) continue;
      if (m[2] === 'body') bodyType = m[1];
      else pathTypes.set(m[2], m[1] === 'int' ? 'int' : 'string');
    }
  }
  return { pathTypes, query, bodyType };
}

function readSample(root: string, file: string): unknown {
  const text = readText(join(root, file)) ?? readText(file);
  if (text === null) throw new ToolError('no_sample', `Cannot read the sample file ${file}.`);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ToolError('bad_sample', `${file} is not valid JSON: ${(e as Error).message}`);
  }
}

export async function planApiUpdate(root: string, adapter: Adapter, name: string, samples: string[], opts: { noUnwrap?: boolean } = {}): Promise<{ changeSet: ChangeSet; changes: FieldChange }> {
  if (!adapter.planEndpoint) throw new ToolError('not_supported', `api update needs a framework adapter; this project uses the ${adapter.id} adapter.`);
  if (!samples.length) throw new ToolError('no_sample', 'api update needs at least one new response sample.', 'Pass --sample <file.json> (repeat it for several samples).');
  const lang = langOf(adapter);
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  const ep = findEndpoint(map, name);
  const text = readText(join(root, ep.file)) ?? '';
  const decl = findDeclaration(text, ep.name, lang);
  if (!decl) throw new ToolError('no_endpoint', `Could not find the declaration of ${ep.name} in ${ep.file}.`);
  const sig = readSignature(decl.params, lang);

  // The existing response model keeps its name.
  const { rootClass, modelName } = responseModelName(map, ep, lang);
  const loaded = samples.map((f) => readSample(root, f));
  const url = new URL(`https://api.invalid${ep.path.replace(/\{([^/{}]+)\}/g, ':$1')}`);
  const spec = buildEndpoint({ method: ep.method as HttpMethod, url, responseSamples: loaded, name: ep.name, modelName, unwrap: opts.noUnwrap ? 'never' : 'auto' });
  spec.pathParams = spec.pathParams.map((p) => ({ ...p, type: sig.pathTypes.get(p.name) ?? p.type }));
  spec.queryParams = sig.query;
  // A sample shows a field present, not that it always is: a field that was optional stays optional
  // (making it required would also break code that checks it, like dueAt?.isBefore(...)).
  const before = map.models.find((m) => m.name === rootClass);
  const inferred = spec.models.find((m) => m.name === modelName) ?? spec.models[spec.models.length - 1];
  if (before && inferred) for (const f of inferred.fields) if (before.fields.find((b) => b.name === f.jsonName)?.nullable) f.nullable = true;
  if (sig.bodyType) {
    const suffix = lang === 'dart' ? map.conventions.modelClassSuffix ?? '' : '';
    const bodyModel = suffix && sig.bodyType.endsWith(suffix) ? sig.bodyType.slice(0, -suffix.length) : sig.bodyType;
    spec.request = { kind: 'object', model: bodyModel };
  }
  const r = await planEndpointUpdate(root, adapter, map, new Map(), ep, spec, rootClass, `from ${samples.length} new sample${samples.length === 1 ? '' : 's'}`);
  const changeSet = buildChangeSet(root, 'api update', { files: r.files, summary: r.summary, warnings: r.warnings, generated: r.generated });
  return { changeSet, changes: r.changes };
}

/** The class an endpoint returns (User for Promise<User[]>), and the inferred-model name that maps to it. */
function responseModelName(map: ProjectMap, ep: EndpointInfo, lang: Lang): { rootClass: string; modelName?: string } {
  const suffix = lang === 'dart' ? map.conventions.modelClassSuffix ?? '' : '';
  const rootClass = (ep.response ?? '').replace(/^Promise<(.*)>$/, '$1').replace(/^List<(.*)>$/, '$1').replace(/\[\]$/, '');
  const oldModel = map.models.find((m) => m.name === rootClass);
  return { rootClass, modelName: oldModel ? (suffix && rootClass.endsWith(suffix) ? rootClass.slice(0, -suffix.length) : rootClass) : undefined };
}

export interface EndpointUpdate {
  files: Map<string, string>;
  summary: string[];
  warnings: string[];
  generated: ChangeSet['generated'];
  changes: FieldChange;
  models: ModelInfo[];
}

/**
 * Rewrites one endpoint from a new spec, in place: the declaration where it
 * was, its models with hand-written members kept, and a report of fields that
 * were added, removed or changed type with the lines that use them. `overlay`
 * holds files already planned (api sync chains several updates).
 */
export async function planEndpointUpdate(root: string, adapter: Adapter, map: ProjectMap, overlay: Map<string, string>, ep: EndpointInfo, spec: EndpointSpec, rootClass: string, label: string): Promise<EndpointUpdate> {
  const lang = langOf(adapter);
  const current = (f: string) => overlay.get(f) ?? readText(join(root, f));
  const text = current(ep.file) ?? '';
  const decl = findDeclaration(text, ep.name, lang);
  if (!decl) throw new ToolError('no_endpoint', `Could not find the declaration of ${ep.name} in ${ep.file}.`);
  const oldModel = map.models.find((m) => m.name === rootClass);

  // Take the old declaration out, plan the new one, then put it back where the old one was.
  const nextDecl = findNextDeclarationName(text, decl.end, lang);
  const working = structuredClone(map);
  working.endpoints = working.endpoints.filter((e) => e.name !== ep.name);
  const edits = await adapter.planEndpoint!({ root, map: working }, spec, new Map([...overlay, [ep.file, cut(text, decl.start, decl.end)]]), { replaceModels: true, targetFile: ep.file });
  const planned = edits.files.get(ep.file);
  if (planned && nextDecl) {
    const nd = findDeclaration(planned, ep.name, lang)!;
    const block = planned.slice(nd.start, nd.end);
    const without = cut(planned, nd.start, nd.end);
    const anchor = findDeclaration(without, nextDecl, lang);
    if (anchor) edits.files.set(ep.file, `${without.slice(0, anchor.start)}${block}\n\n${without.slice(anchor.start)}`.replace(/\n{3,}/g, '\n\n'));
  }

  // Hand-written members of regenerated models come back (Dart), and field comments stay (TypeScript).
  const keptNotes: string[] = [];
  for (const [f, next] of edits.files) {
    const before = current(f);
    if (before === null || f === ep.file || before === next) continue;
    if (lang === 'dart') {
      const r = mergeDart(before, next);
      edits.files.set(f, r.text);
      for (const [cls, names] of r.report.kept) keptNotes.push(`Kept your members of ${cls}: ${names.join(', ')}`);
      for (const [cls, list] of r.report.mentionsRemoved) for (const x of list) keptNotes.push(`! ${cls}.${x.member} still uses removed field${x.fields.length === 1 ? '' : 's'} ${x.fields.join(', ')}; update it by hand.`);
    } else if (lang === 'ts') edits.files.set(f, mergeTsDocs(before, next));
  }
  const newModel = edits.models?.find((m) => m.name === rootClass) ?? edits.models?.[edits.models.length - 1];
  const changes = diffFields(oldModel, newModel);
  const summary = [`Update ${ep.name}() (${ep.method} ${ep.path}) ${label}`];
  if (changes.added.length) summary.push(`Fields added to ${rootClass || 'the response'}: ${changes.added.join(', ')}`);
  if (changes.removed.length) summary.push(`Fields removed from ${rootClass || 'the response'}: ${changes.removed.join(', ')}`);
  if (changes.changed.length) summary.push(`Fields that changed type: ${changes.changed.join('; ')}`);
  if (!changes.added.length && !changes.removed.length && !changes.changed.length && oldModel) summary.push(`${rootClass} has the same fields as before.`);
  summary.push(...edits.summary.filter((s) => /^(Create|Update) .*(interface|class) /.test(s)));
  const warnings = edits.warnings.filter((w) => !/^Updating the model|^Reusing the existing model/.test(w));
  summary.push(...keptNotes.filter((n) => !n.startsWith('! ')));
  warnings.push(...keptNotes.filter((n) => n.startsWith('! ')).map((n) => n.slice(2)));

  // Who uses what disappeared or changed?
  const broken = [...changes.removed, ...changes.changed.map((c) => c.split(':')[0])];
  if (broken.length) {
    const hits: string[] = [];
    for (const f of codeFiles(root, adapter)) {
      if (map.models.some((m) => m.file === f)) continue;
      const t = current(f) ?? '';
      // Only files that can hold this model: they name it or call the endpoint.
      if (!new RegExp(`\\b(${[rootClass, ep.name].filter(Boolean).join('|')})\\b`).test(t)) continue;
      t.split('\n').forEach((l, i) => {
        for (const field of broken) {
          const access = lang !== 'ts' ? camel(field) : field;
          if (new RegExp(`\\.${access}\\b|\\[['"]${field}['"]\\]`).test(l)) hits.push(`    ${f}:${i + 1}  ${l.trim()}  (${field})`);
        }
      });
    }
    if (hits.length) warnings.push(`These lines use fields that were removed or changed type:\n${hits.slice(0, 30).join('\n')}${hits.length > 30 ? `\n    ... and ${hits.length - 30} more` : ''}`);
    else warnings.push(`No code outside the models uses the removed or changed fields (${broken.join(', ')}).`);
  }
  return { files: edits.files, summary, warnings, generated: edits.generated, changes, models: edits.models ?? [] };
}

function findNextDeclarationName(text: string, from: number, lang: Lang): string | null {
  const rest = text.slice(from);
  const m = lang === 'ts' ? /export\s+(?:async\s+)?function\s+(\w+)/.exec(rest) : lang === 'kt' ? /\bfun\s+(\w+)\s*\(/.exec(rest) : /Future<[^\n]*>\s+(\w+)\s*\(/.exec(rest);
  return m ? m[1] : null;
}

/** Where an endpoint is declared and every place that uses it (for `api show`). */
export function endpointUses(root: string, adapter: Adapter, ep: EndpointInfo): { declLine?: number; signature?: string; uses: { file: string; line: number; text: string }[] } {
  const lang = langOf(adapter);
  const text = readText(join(root, ep.file)) ?? '';
  const decl = findDeclaration(text, ep.name, lang);
  if (!decl) return { uses: [] };
  const at = declNameIndex(maskCode(text, ml(lang)), ep.name, decl);
  const lineStart = text.lastIndexOf('\n', at) + 1;
  const signature = text.slice(lineStart, text.indexOf('\n', at)).trim().replace(/\s*\{$/, '');
  return {
    declLine: text.slice(0, at).split('\n').length,
    signature,
    uses: sites(root, adapter, ep, text, decl).map(({ file, line, text: t }) => ({ file, line, text: t })),
  };
}
