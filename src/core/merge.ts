// Keeps hand-written code when codz regenerates a model.
//
// Dart: a regenerated class gets back every member codz does not generate
// (copyWith, ==, hashCode, toString, getters, other constructors and methods).
// TypeScript: doc comments above interface fields survive.

import { matchBrace, maskCode } from '../adapters/source.ts';

export interface MergeReport {
  /** Class name → names of hand-written members carried over. */
  kept: Map<string, string[]>;
  /** Class name → removed fields that kept members still mention. */
  mentionsRemoved: Map<string, { member: string; fields: string[] }[]>;
}

interface Member {
  text: string;
  /** Text with comments and strings blanked, for classification. */
  code: string;
  name: string;
}

function classBlocks(text: string, masked: string): Map<string, { open: number; close: number }> {
  const out = new Map<string, { open: number; close: number }>();
  for (const m of masked.matchAll(/\bclass\s+(\w+)[^{;]*\{/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchBrace(text, open, 'dart');
    if (close !== -1) out.set(m[1], { open, close });
  }
  return out;
}

/** Splits a Dart class body into members, each with the comments and annotations above it. */
export function splitDartMembers(body: string): Member[] {
  const masked = maskCode(body, 'dart');
  const out: Member[] = [];
  let start = 0;
  let i = 0;
  let depth = 0;
  const push = (end: number) => {
    const text = body.slice(start, end);
    if (text.trim()) {
      const code = masked.slice(start, end);
      out.push({ text, code, name: memberName(code) });
    }
    start = end;
  };
  while (i < body.length) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0 && c === '}') {
        // A block body ends the member unless an expression continues (`= {...};`, `}.foo`, `},`).
        let j = i + 1;
        while (j < body.length && /\s/.test(masked[j])) j++;
        if (masked[j] === ';') {
          i = j;
          push(i + 1);
        } else if (!/[.,)?:]/.test(masked[j] ?? '')) push(i + 1);
      }
    } else if (c === ';' && depth === 0) push(i + 1);
    i++;
  }
  if (body.slice(start).trim()) push(body.length);
  return out;
}

function memberName(code: string): string {
  const c = code.replace(/@\w+(\([^)]*\))?/g, '').trim();
  const getter = /\b(?:get|set)\s+(\w+)/.exec(c);
  if (getter) return getter[1];
  if (/\boperator\s*==/.test(c)) return 'operator ==';
  const call = /([\w.]+)\s*(?:<[^>]*>)?\s*\(/.exec(c);
  const field = /(\w+)\s*(?:=|;)/.exec(c);
  if (call && (!field || call.index < field.index)) return call[1];
  return field ? field[1] : c.split(/\s+/).slice(-1)[0];
}

/** True for members codz writes itself in a model class. */
function isGenerated(m: Member, cls: string): boolean {
  const c = m.code.replace(/@\w+(\([^)]*\))?/g, '').trim();
  if (new RegExp(`^(const\\s+)?${cls}\\s*\\(`).test(c)) return true; // unnamed constructor
  if (new RegExp(`^factory\\s+${cls}\\.fromJson\\b`).test(c)) return true;
  if (new RegExp(`^const\\s+factory\\s+${cls}\\s*\\(`).test(c)) return true; // freezed
  if (/^(Map<String,\s*dynamic>|Map<String,\s*Object\?>)\s+toJson\s*\(/.test(c)) return true;
  // A plain field: `final Type name;` (no initializer, no parentheses).
  if (/^(final\s+|late\s+final\s+|late\s+)?[\w<>?, ]+\s+\w+\s*;$/.test(c.replace(/\s+/g, ' '))) return true;
  return false;
}

function fieldNames(members: Member[], cls: string): Set<string> {
  return new Set(members.filter((m) => isGenerated(m, cls) && /;\s*$/.test(m.code) && !/\(/.test(m.code)).map((m) => m.name));
}

export function mergeDart(oldText: string, newText: string): { text: string; report: MergeReport } {
  const report: MergeReport = { kept: new Map(), mentionsRemoved: new Map() };
  const oldBlocks = classBlocks(oldText, maskCode(oldText, 'dart'));
  let text = newText;
  // From the last class down, so earlier offsets stay valid.
  const newBlocks = [...classBlocks(text, maskCode(text, 'dart')).entries()].sort((a, b) => b[1].open - a[1].open);
  for (const [cls, nb] of newBlocks) {
    const ob = oldBlocks.get(cls);
    if (!ob) continue;
    // freezed: @Default(...) values on factory parameters are yours; keep them.
    const oldBody = oldText.slice(ob.open + 1, ob.close);
    if (/\bconst\s+factory\b/.test(oldBody)) {
      let body = text.slice(nb.open + 1, nb.close);
      for (const d of oldBody.matchAll(/@Default\(((?:[^()]|\([^()]*\))*)\)\s+(?:required\s+)?[\w<>?, ]+?\s+(\w+)\s*[,)}]/g)) {
        body = body.replace(new RegExp(`\\brequired\\s+([\\w<>, ]+\\s+${d[2]}\\s*,)`), `@Default(${d[1]}) $1`);
      }
      text = text.slice(0, nb.open + 1) + body + text.slice(nb.close);
      nb.close = nb.open + 1 + body.length;
    }
    const oldMembers = splitDartMembers(oldText.slice(ob.open + 1, ob.close));
    const newMembers = splitDartMembers(text.slice(nb.open + 1, nb.close));
    const newNames = new Set(newMembers.map((m) => m.name));
    const keep = oldMembers.filter((m) => !isGenerated(m, cls) && !newNames.has(m.name));
    if (!keep.length) continue;
    const removed = [...fieldNames(oldMembers, cls)].filter((f) => !fieldNames(newMembers, cls).has(f));
    const mentions = keep
      .map((m) => ({ member: m.name, fields: removed.filter((f) => new RegExp(`\\b${f}\\b`).test(m.code)) }))
      .filter((x) => x.fields.length);
    if (mentions.length) report.mentionsRemoved.set(cls, mentions);
    report.kept.set(cls, keep.map((m) => m.name));
    const before = text.slice(0, nb.close).replace(/\s*$/, '');
    const block = keep.map((m) => m.text.replace(/^\n+/, '').replace(/\s+$/, '')).join('\n\n');
    text = `${before}\n\n${block}\n${text.slice(nb.close)}`;
  }
  return { text, report };
}

/** TypeScript: comments above interface fields come back after regeneration. */
export function mergeTsDocs(oldText: string, newText: string): string {
  const fieldRe = /^([ \t]*)(?:readonly\s+)?(['"]?[\w$-]+['"]?)\??\s*:/;
  const docs = new Map<string, string[]>();
  const oldLines = oldText.split('\n');
  for (let i = 0; i < oldLines.length; i++) {
    const m = fieldRe.exec(oldLines[i]);
    if (!m) continue;
    const doc: string[] = [];
    let j = i - 1;
    while (j >= 0 && /^\s*(\/\/|\/\*\*|\*|\*\/)/.test(oldLines[j])) doc.unshift(oldLines[j--].trim());
    if (doc.length) docs.set(m[2], doc);
  }
  if (!docs.size) return newText;
  const out: string[] = [];
  for (const line of newText.split('\n')) {
    const m = fieldRe.exec(line);
    const prev = out[out.length - 1] ?? '';
    if (m && docs.has(m[2]) && !/^\s*(\/\/|\*|\/\*\*)/.test(prev)) {
      for (const d of docs.get(m[2])!) out.push(`${m[1]}${d.startsWith('*') ? ' ' : ''}${d}`);
    }
    out.push(line);
  }
  return out.join('\n');
}
