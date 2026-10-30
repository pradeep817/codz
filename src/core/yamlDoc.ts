// A YAML reader for OpenAPI and Swagger files: block maps and sequences,
// maps inside sequences, quoted and plain scalars, block scalars (| and >),
// single- and multi-line flow collections, anchors, aliases and `<<` merges.
// It returns plain JSON-like values. Tags and multiple documents are not supported.

import { ToolError } from './types.ts';

interface Line {
  indent: number;
  text: string;
  no: number;
}

function stripComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) {
        if (q === "'" && line[i + 1] === "'") i++;
        else if (q === '"' && line[i - 1] === '\\') continue;
        else q = null;
      }
    } else if (c === '"' || c === "'") {
      // Quotes only open a string at the start of a value.
      const before = line.slice(0, i).trimEnd();
      if (before === '' || /[:\-,[{]$/.test(before)) q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function plainScalar(s: string): unknown {
  const t = s.trim();
  if (t === '' || t === '~' || /^null$/i.test(t)) return null;
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
  if (/^[-+]?\d+$/.test(t)) return Number(t);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  return t;
}

function quoted(s: string): string {
  const q = s[0];
  const body = s.slice(1, -1);
  if (q === "'") return body.replace(/''/g, "'");
  return body.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (_m, e: string) => {
    const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
    return e.startsWith('u') ? String.fromCharCode(parseInt(e.slice(1), 16)) : map[e];
  });
}

/** Parses a flow collection or scalar such as [a, "b", {c: 1}]. */
function parseFlow(src: string, anchors: Map<string, unknown>): unknown {
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const value = (): unknown => {
    ws();
    const c = src[i];
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      for (;;) {
        ws();
        if (src[i] === ']') {
          i++;
          return arr;
        }
        arr.push(value());
        ws();
        if (src[i] === ',') i++;
        else if (src[i] === ']') {
          i++;
          return arr;
        } else throw new ToolError('yaml_parse', `Bad flow sequence near "${src.slice(i, i + 20)}"`);
      }
    }
    if (c === '{') {
      i++;
      const obj: Record<string, unknown> = {};
      for (;;) {
        ws();
        if (src[i] === '}') {
          i++;
          return obj;
        }
        const k = String(scalarToken(true));
        ws();
        let v: unknown = null;
        if (src[i] === ':') {
          i++;
          v = value();
        }
        obj[k] = v;
        ws();
        if (src[i] === ',') i++;
        else if (src[i] === '}') {
          i++;
          return obj;
        } else throw new ToolError('yaml_parse', `Bad flow mapping near "${src.slice(i, i + 20)}"`);
      }
    }
    if (c === '*') {
      i++;
      const m = /^[\w-]+/.exec(src.slice(i));
      if (!m) throw new ToolError('yaml_parse', `An alias (*) needs a name near "${src.slice(i - 1, i + 19)}"`);
      i += m[0].length;
      return structuredClone(anchors.get(m[0]) ?? null);
    }
    return scalarToken(false);
  };
  const scalarToken = (isKey: boolean): unknown => {
    ws();
    const c = src[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === c) {
          if (c === "'" && src[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        if (c === '"' && src[j] === '\\') j++;
        j++;
      }
      const s = quoted(src.slice(i, j + 1));
      i = j + 1;
      return s;
    }
    let j = i;
    while (j < src.length && !',]}'.includes(src[j]) && !(isKey && src[j] === ':' && (src[j + 1] === ' ' || src[j + 1] === undefined))) {
      if (!isKey && src[j] === ':' && src[j + 1] === ' ') break;
      j++;
    }
    const raw = src.slice(i, j);
    i = j;
    return isKey ? raw.trim() : plainScalar(raw);
  };
  const v = value();
  ws();
  if (i < src.length) throw new ToolError('yaml_parse', `Unexpected text after a flow value: "${src.slice(i, i + 20)}"`);
  return v;
}

/** Splits "key: value" at the first mapping colon outside quotes. */
function splitKey(text: string): [string, string] | null {
  if (text.startsWith('"') || text.startsWith("'")) {
    const q = text[0];
    let j = 1;
    while (j < text.length && text[j] !== q) j += text[j] === '\\' && q === '"' ? 2 : 1;
    const after = text.slice(j + 1);
    const m = /^\s*:(\s|$)/.exec(after);
    if (!m) return null;
    return [quoted(text.slice(0, j + 1)), after.slice(m[0].length).trim()];
  }
  if (/^[[{]/.test(text)) return null;
  const m = /^([^:#]*?[^\s:])?\s*:(\s+|$)/.exec(text);
  if (!m || m[1] === undefined) return null;
  return [m[1].trim(), text.slice(m[0].length).trim()];
}

export function parseYamlDocument(source: string): unknown {
  const raw = source.replace(/\r\n/g, '\n').replace(/^﻿/, '').split('\n');
  const lines: (Line | null)[] = raw.map((r, idx) => {
    const t = stripComment(r);
    if (t.trim() === '' || /^(---|\.\.\.)\s*$/.test(t)) return null;
    if (/^\t/.test(r)) throw new ToolError('yaml_parse', `Line ${idx + 1}: tabs are not allowed for indentation in YAML.`);
    return { indent: t.length - t.trimStart().length, text: t.trim(), no: idx + 1 };
  });
  const anchors = new Map<string, unknown>();
  let i = 0;
  const peek = (): Line | null => {
    while (i < lines.length && lines[i] === null) i++;
    return i < lines.length ? lines[i] : null;
  };

  const blockScalar = (header: string, parentIndent: number): string => {
    const style = header[0];
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    const body: string[] = [];
    let blockIndent = -1;
    while (i < raw.length) {
      const r = raw[i];
      if (r.trim() === '') {
        body.push('');
        i++;
        continue;
      }
      const ind = r.length - r.trimStart().length;
      if (ind <= parentIndent) break;
      if (blockIndent === -1) blockIndent = ind;
      if (ind < blockIndent) break;
      body.push(r.slice(blockIndent));
      i++;
    }
    while (body.length && body[body.length - 1] === '' && chomp !== 'keep') body.pop();
    let text = style === '|' ? body.join('\n') : body.reduce((acc, l, k) => (k === 0 ? l : l === '' ? acc + '\n' : acc.endsWith('\n') ? acc + l : `${acc} ${l}`), '');
    if (chomp !== 'strip' && text) text += '\n';
    return text;
  };

  const flowSpanning = (start: string): string => {
    let text = start;
    const balanced = (t: string) => {
      let d = 0;
      let q: string | null = null;
      for (const c of t) {
        if (q) {
          if (c === q) q = null;
        } else if (c === '"' || c === "'") q = c;
        else if (c === '[' || c === '{') d++;
        else if (c === ']' || c === '}') d--;
      }
      return d <= 0;
    };
    while (!balanced(text)) {
      const l = peek();
      if (!l) throw new ToolError('yaml_parse', 'A flow collection ([...] or {...}) is not closed.');
      text += ' ' + l.text;
      i++;
    }
    return text;
  };

  const value = (rest: string, parentIndent: number): unknown => {
    let r = rest;
    let anchor: string | undefined;
    const a = /^&([\w-]+)\s*/.exec(r);
    if (a) {
      anchor = a[1];
      r = r.slice(a[0].length);
    }
    let v: unknown;
    if (/^!\S*\s*/.test(r)) r = r.replace(/^!\S*\s*/, ''); // ignore tags
    if (r === '') {
      const next = peek();
      if (next && next.indent > parentIndent) v = node(next.indent);
      else if (next && next.indent === parentIndent && /^-(\s|$)/.test(next.text)) v = seq(parentIndent);
      else v = null;
    } else if (r.startsWith('*')) {
      v = structuredClone(anchors.get(r.slice(1).trim()) ?? null);
    } else if (/^[|>][-+0-9]*$/.test(r)) {
      v = blockScalar(r, parentIndent);
    } else if (r.startsWith('[') || r.startsWith('{')) {
      v = parseFlow(flowSpanning(r), anchors);
    } else if (r.startsWith('"') || r.startsWith("'")) {
      let t = r;
      // A double-quoted string may continue on the next lines.
      while (!(t.length > 1 && t.endsWith(t[0]) && !(t[0] === '"' && t.endsWith('\\"')))) {
        const l = peek();
        if (!l) break;
        t += ' ' + l.text;
        i++;
      }
      v = quoted(t);
    } else {
      let t = r;
      // Multi-line plain scalars.
      for (let l = peek(); l && l.indent > parentIndent && !splitKey(l.text) && !/^-(\s|$)/.test(l.text); l = peek()) {
        t += ' ' + l.text;
        i++;
      }
      v = plainScalar(t);
    }
    if (anchor) anchors.set(anchor, structuredClone(v));
    return v;
  };

  const map = (indent: number): Record<string, unknown> => {
    const obj: Record<string, unknown> = {};
    for (let l = peek(); l && l.indent === indent; l = peek()) {
      const kv = splitKey(l.text);
      if (!kv) throw new ToolError('yaml_parse', `Line ${l.no}: expected "key: value".`);
      i++;
      const v = value(kv[1], indent);
      if (kv[0] === '<<') {
        for (const src of Array.isArray(v) ? v : [v]) if (src && typeof src === 'object') Object.assign(obj, { ...(src as object), ...obj });
      } else obj[kv[0]] = v;
    }
    return obj;
  };

  const seq = (indent: number): unknown[] => {
    const arr: unknown[] = [];
    for (let l = peek(); l && l.indent === indent && /^-(\s|$)/.test(l.text); l = peek()) {
      const rest = l.text.slice(1).trimStart();
      if (rest === '') {
        i++;
        const next = peek();
        arr.push(next && next.indent > indent ? node(next.indent) : null);
      } else if (splitKey(rest) && !rest.startsWith('[') && !rest.startsWith('{')) {
        // "- key: value" starts a map indented at the column of "key".
        const col = indent + (l.text.length - rest.length);
        lines[i] = { indent: col, text: rest, no: l.no };
        arr.push(map(col));
      } else {
        i++;
        arr.push(value(rest, indent));
      }
    }
    return arr;
  };

  const node = (indent: number): unknown => {
    const l = peek();
    if (!l) return null;
    if (/^-(\s|$)/.test(l.text)) return seq(l.indent);
    if (splitKey(l.text)) return map(l.indent);
    i++;
    return value(l.text, indent - 1);
  };

  const first = peek();
  if (!first) return null;
  const result = node(first.indent);
  const left = peek();
  if (left) throw new ToolError('yaml_parse', `Line ${left.no}: could not read this line (check its indentation).`);
  return result;
}
