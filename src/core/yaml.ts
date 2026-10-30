import { ToolError } from './types.ts';
// A deliberately small YAML subset for codz.config.yaml: nested maps,
// lists of scalars, quoted or plain scalars, and comments. Values are read
// back as strings; callers convert them.

export type YamlValue = string | YamlValue[] | { [key: string]: YamlValue };

const PLAIN = /^[A-Za-z0-9_./{}+-][A-Za-z0-9_ ./@{}:+-]*$/;

export function scalar(value: string): string {
  if (value === '') return "''";
  if (PLAIN.test(value) && !value.includes(': ') && !value.endsWith(':') && !/^(true|false|null|~|yes|no)$/i.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

export function stringify(value: { [key: string]: YamlValue }, comments: Record<string, string> = {}, indent = 0, prefix = ''): string {
  const pad = ' '.repeat(indent);
  let out = '';
  for (const [key, v] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (comments[path]) out += `${pad}# ${comments[path]}\n`;
    if (typeof v === 'string') {
      out += `${pad}${key}: ${scalar(v)}\n`;
    } else if (Array.isArray(v)) {
      if (v.length === 0) {
        out += `${pad}${key}: []\n`;
      } else {
        out += `${pad}${key}:\n`;
        for (const item of v) out += `${pad}  - ${scalar(String(item))}\n`;
      }
    } else {
      const entries = Object.keys(v);
      out += entries.length === 0 ? `${pad}${key}: {}\n` : `${pad}${key}:\n${stringify(v, comments, indent + 2, path)}`;
    }
  }
  return out;
}

function unquote(raw: string): string {
  const s = raw.trim();
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return s;
}

function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

interface Line {
  indent: number;
  text: string;
  no: number;
}

export function parse(source: string): { [key: string]: YamlValue } {
  const lines: Line[] = [];
  source.split(/\r?\n/).forEach((raw, i) => {
    const noComment = stripComment(raw).replace(/\s+$/, '');
    if (noComment.trim() === '') return;
    if (/\t/.test(noComment.match(/^\s*/)![0])) throw new ToolError('bad_config', `codz.config.yaml line ${i + 1}: use spaces, not tabs`);
    lines.push({ indent: noComment.length - noComment.trimStart().length, text: noComment.trim(), no: i + 1 });
  });
  let pos = 0;

  function parseMap(indent: number): { [key: string]: YamlValue } {
    const out: { [key: string]: YamlValue } = {};
    while (pos < lines.length && lines[pos].indent === indent && !lines[pos].text.startsWith('- ')) {
      const line = lines[pos];
      const m = line.text.match(/^([^:]+?):(?:\s+(.*))?$/);
      if (!m) throw new ToolError('bad_config', `codz.config.yaml line ${line.no}: expected "key: value"`);
      const key = unquote(m[1]);
      const rest = m[2];
      pos++;
      if (rest === undefined || rest === '') {
        if (pos < lines.length && lines[pos].indent > indent) {
          out[key] = lines[pos].text.startsWith('- ') ? parseList(lines[pos].indent) : parseMap(lines[pos].indent);
        } else {
          out[key] = '';
        }
      } else if (rest === '[]') {
        out[key] = [];
      } else if (rest === '{}') {
        out[key] = {};
      } else if (rest.startsWith('[') && rest.endsWith(']')) {
        out[key] = rest
          .slice(1, -1)
          .split(',')
          .map((s) => unquote(s))
          .filter((s) => s !== '');
      } else {
        out[key] = unquote(rest);
      }
    }
    if (pos < lines.length && lines[pos].indent > indent) {
      throw new ToolError('bad_config', `codz.config.yaml line ${lines[pos].no}: unexpected indentation`);
    }
    return out;
  }

  function parseList(indent: number): YamlValue[] {
    const out: YamlValue[] = [];
    while (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith('- ')) {
      out.push(unquote(lines[pos].text.slice(2)));
      pos++;
    }
    return out;
  }

  if (lines.length === 0) return {};
  const result = parseMap(lines[0].indent);
  if (pos < lines.length) throw new ToolError('bad_config', `codz.config.yaml line ${lines[pos].no}: could not parse`);
  return result;
}
