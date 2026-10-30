// Detects what a pasted block contains: a cURL command, a URL, and JSON
// samples labelled as request or response. Decisions come from the shape of
// the data, never from free-text intent.

import { ToolError } from '../core/types.ts';

export interface PasteResult {
  curl?: string;
  url?: string;
  responseSamples: unknown[];
  requestSample?: unknown;
}

const REQUEST_LABEL = /^(request|request body|body|payload|input)\s*:?\s*$/i;
const RESPONSE_LABEL = /^(response|response body|sample response|result|output)\s*:?\s*$/i;

/** Splits text at newlines that are outside shell quotes. */
function splitOutsideQuotes(text: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== '\\') quote = null;
      cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === '\n') {
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts;
}

/** Reads consecutive JSON values from text, with optional label lines before each. */
function readJsonBlocks(text: string): { label: 'request' | 'response' | null; value: unknown }[] {
  const out: { label: 'request' | 'response' | null; value: unknown }[] = [];
  let rest = text.trim();
  let label: 'request' | 'response' | null = null;
  while (rest.length) {
    const firstLine = rest.split('\n', 1)[0].trim();
    if (REQUEST_LABEL.test(firstLine) || RESPONSE_LABEL.test(firstLine)) {
      label = REQUEST_LABEL.test(firstLine) ? 'request' : 'response';
      rest = rest.slice(rest.indexOf('\n') + 1 || rest.length).trim();
      continue;
    }
    if (rest[0] !== '{' && rest[0] !== '[') {
      throw new ToolError('paste_parse', `Could not understand this part of the pasted input: "${firstLine.slice(0, 60)}"`, 'Paste a cURL command, a URL, or JSON samples. Label JSON with a "request:" or "response:" line when it is not obvious.');
    }
    const end = matchingBracket(rest);
    const chunk = rest.slice(0, end + 1);
    try {
      out.push({ label, value: JSON.parse(chunk) });
    } catch (e) {
      throw new ToolError('paste_parse', `A pasted JSON block is not valid JSON: ${(e as Error).message}`);
    }
    label = null;
    rest = rest.slice(end + 1).trim();
  }
  return out;
}

function matchingBracket(text: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new ToolError('paste_parse', 'A pasted JSON block is not closed.');
}

export function detectPaste(input: string): PasteResult {
  const text = input.replace(/\r\n/g, '\n').trim();
  const result: PasteResult = { responseSamples: [] };
  if (!text) throw new ToolError('paste_empty', 'Nothing was pasted.');

  let jsonPart = text;
  if (/^curl\s/.test(text)) {
    const lines = splitOutsideQuotes(text);
    let cut = lines.length;
    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1].trimEnd();
      const t = lines[i].trim();
      if (prev.endsWith('\\')) continue;
      if (t === '' || t.startsWith('{') || t.startsWith('[') || REQUEST_LABEL.test(t) || RESPONSE_LABEL.test(t)) {
        cut = i;
        break;
      }
      if (t.startsWith('-')) continue; // a flag on its own line without a trailing backslash
      cut = i;
      break;
    }
    result.curl = lines.slice(0, cut).join('\n');
    jsonPart = lines.slice(cut).join('\n');
  } else {
    const firstLine = text.split('\n', 1)[0].trim();
    const urlMatch = firstLine.match(/^(?:(GET|POST|PUT|PATCH|DELETE)\s+)?(https?:\/\/\S+)$/i);
    if (urlMatch) {
      result.url = firstLine;
      jsonPart = text.slice(firstLine.length);
    }
  }

  for (const block of readJsonBlocks(jsonPart)) {
    if (block.label === 'request') {
      if (result.requestSample !== undefined) throw new ToolError('paste_parse', 'More than one request sample was pasted.');
      result.requestSample = block.value;
    } else {
      result.responseSamples.push(block.value);
    }
  }
  return result;
}
