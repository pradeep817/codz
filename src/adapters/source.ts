// Small, careful source-text helpers for TypeScript and Dart. They skip
// strings, template literals and comments, so braces inside them never
// confuse the scanner or the editor.

export type Lang = 'ts' | 'dart';

/** Returns the index of the brace that closes the one at `open`, or -1. */
export function matchBrace(text: string, open: number, lang: Lang = 'ts'): number {
  const openCh = text[open];
  const closeCh = openCh === '{' ? '}' : openCh === '(' ? ')' : openCh === '[' ? ']' : '';
  if (!closeCh) return -1;
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '/' && n === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(text, i, lang);
      continue;
    }
    if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Returns the index just after the string starting at `start`. */
export function skipString(text: string, start: number, lang: Lang): number {
  const q = text[start];
  // Dart raw strings r'...' are handled by the caller treating r as a normal char; escapes in them are rare.
  const triple = lang === 'dart' && text.slice(start, start + 3) === q.repeat(3);
  const interp = q === '`' || lang === 'dart';
  let i = start + (triple ? 3 : 1);
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (interp && c === '$' && text[i + 1] === '{') {
      const end = matchBrace(text, i + 1, lang);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (triple ? text.slice(i, i + 3) === q.repeat(3) : c === q) return i + (triple ? 3 : 1);
    if (!triple && c === '\n' && q !== '`') return i; // unterminated single-line string
    i++;
  }
  return text.length;
}

/** Detects the indentation unit (two spaces, four spaces or a tab) used in a file. */
export function detectIndent(text: string): string {
  const counts = new Map<string, number>();
  for (const line of text.split('\n')) {
    const m = line.match(/^( +|\t+)\S/);
    if (!m) continue;
    const ws = m[1];
    if (ws[0] === '\t') counts.set('\t', (counts.get('\t') ?? 0) + 1);
    else if (ws.length % 4 === 0 && ws.length <= 8) counts.set('    ', (counts.get('    ') ?? 0) + 1);
    else if (ws.length % 2 === 0) counts.set('  ', (counts.get('  ') ?? 0) + 1);
  }
  if ((counts.get('\t') ?? 0) > (counts.get('  ') ?? 0) + (counts.get('    ') ?? 0)) return '\t';
  // Lines indented by 4 are also multiples of 2; prefer 2 when any 2-only line exists.
  return (counts.get('  ') ?? 0) > 0 ? '  ' : (counts.get('    ') ?? 0) > 0 ? '    ' : '  ';
}

export interface TsStyle {
  quote: "'" | '"';
  semi: boolean;
  indent: string;
}

export function detectTsStyle(samples: string[]): TsStyle {
  let single = 0;
  let double = 0;
  let semis = 0;
  let noSemis = 0;
  for (const text of samples) {
    single += (text.match(/^import .* from '/gm) ?? []).length + (text.match(/'[^'\n]*'/g) ?? []).length / 4;
    double += (text.match(/^import .* from "/gm) ?? []).length + (text.match(/"[^"\n]*"/g) ?? []).length / 4;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (/^(import|export|const|let|return|throw)\b/.test(t) && !t.endsWith('{') && !t.endsWith('(') && !t.endsWith(',') && !t.endsWith('[')) {
        if (t.endsWith(';')) semis++;
        else noSemis++;
      }
    }
  }
  const indent = samples.length ? detectIndent(samples.join('\n')) : '  ';
  return { quote: double > single ? '"' : "'", semi: noSemis <= semis, indent };
}

/**
 * The text with comments and string contents replaced by spaces (same length,
 * same line breaks), so searches for identifiers only hit real code. Quotes stay;
 * code inside `${...}` interpolation stays visible.
 */
export function maskCode(text: string, lang: Lang): string {
  const out = text.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '/' && n === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const end = skipString(text, i, lang);
      const triple = lang === 'dart' && text.slice(i, i + 3) === c.repeat(3);
      const q = triple ? 3 : 1;
      // Blank the contents, but keep ${...} expressions as code.
      let k = i + q;
      const stop = Math.max(k, end - q);
      while (k < stop) {
        if ((c === '`' || lang === 'dart') && text[k] === '$' && text[k + 1] === '{') {
          const close = matchBrace(text, k + 1, lang);
          if (close !== -1 && close < stop) {
            const inner = maskCode(text.slice(k + 2, close), lang);
            for (let j = 0; j < inner.length; j++) out[k + 2 + j] = inner[j];
            k = close + 1;
            continue;
          }
        }
        if (text[k] !== '\n') out[k] = ' ';
        k++;
      }
      i = end;
      continue;
    }
    i++;
  }
  return out.join('');
}
