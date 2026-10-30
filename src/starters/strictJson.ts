// A strict JSON parser for data that comes from the network or a template:
// duplicate keys, deep nesting and oversized strings are errors, not
// "last one wins". JSON.parse silently keeps the last duplicate, which lets a
// tampered manifest say one thing to one reader and another to the next.

import { ToolError } from '../core/types.ts';

export interface StrictJsonLimits {
  maxDepth?: number;
  maxString?: number;
  maxBytes?: number;
}

export function parseStrictJson(text: string, what: string, limits: StrictJsonLimits = {}): unknown {
  const maxDepth = limits.maxDepth ?? 32;
  const maxString = limits.maxString ?? 64 * 1024;
  const maxBytes = limits.maxBytes ?? 8 * 1024 * 1024;
  if (text.length > maxBytes) throw bad(`${what} is larger than ${maxBytes} bytes.`);
  let i = 0;
  const fail = (msg: string): never => {
    throw bad(`${what} is not valid JSON: ${msg} at offset ${i}.`);
  };
  const ws = () => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i++;
  };
  const str = (): string => {
    if (text[i] !== '"') fail('expected a string');
    i++;
    let out = '';
    for (;;) {
      if (i >= text.length) fail('unterminated string');
      const c = text[i];
      if (c === '"') {
        i++;
        break;
      }
      if (c < ' ') fail('control character in a string');
      if (c === '\\') {
        const e = text[i + 1];
        const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (e in map) {
          out += map[e];
          i += 2;
        } else if (e === 'u') {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('bad \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else fail('bad escape');
      } else {
        out += c;
        i++;
      }
      if (out.length > maxString) fail(`a string longer than ${maxString} characters`);
    }
    return out;
  };
  const value = (depth: number): unknown => {
    if (depth > maxDepth) fail(`nesting deeper than ${maxDepth}`);
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const obj: Record<string, unknown> = Object.create(null);
      ws();
      if (text[i] === '}') {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        const key = str();
        if (Object.prototype.hasOwnProperty.call(obj, key)) fail(`duplicate key "${key}"`);
        ws();
        if (text[i] !== ':') fail('expected ":"');
        i++;
        obj[key] = value(depth + 1);
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return obj;
        }
        fail('expected "," or "}"');
      }
    }
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return arr;
        }
        fail('expected "," or "]"');
      }
    }
    if (c === '"') return str();
    if (text.startsWith('true', i)) return (i += 4), true;
    if (text.startsWith('false', i)) return (i += 5), false;
    if (text.startsWith('null', i)) return (i += 4), null;
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 40));
    if (!m) fail('unexpected character');
    i += m![0].length;
    return Number(m![0]);
  };
  // A BOM is tolerated; nothing else before or after the value.
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  const v = value(0);
  ws();
  if (i !== text.length) fail('extra text after the value');
  return v;
}

function bad(message: string): ToolError {
  return new ToolError('bad_template', message, 'Report it; this file is not usable as published.');
}

/** Strips control and escape characters from text shown in the terminal. */
export function printable(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '');
}
