// Parses a pasted cURL command into a neutral request description.
// Secrets (auth headers, cookies, credentials, tokens in the query) are
// detected here and never passed on to code generation.

import { ToolError, type HttpMethod } from '../core/types.ts';

export interface ParsedRequest {
  method: HttpMethod;
  url: URL;
  headers: { name: string; value: string }[];
  body?: string;
  /** Names of things that were removed because they look like secrets. */
  removedSecrets: string[];
  ignoredHeaders: string[];
  /** Multipart form fields from -F / --form (files are marked). */
  form: { name: string; file: boolean }[];
  /** Things the user should know about the parse. */
  notes: string[];
}

/** decodeURIComponent that keeps text such as "100%" as it is instead of throwing. */
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/** Splits a shell command line into words, handling quotes, escapes and line continuations. */
export function shellSplit(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let hasToken = false;
  let i = 0;
  const s = input.replace(/\\\r?\n/g, ' ');
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) throw new ToolError('curl_parse', 'Unclosed single quote in the cURL command.');
      cur += s.slice(i + 1, end);
      hasToken = true;
      i = end + 1;
    } else if (c === '$' && s[i + 1] === "'") {
      // ANSI-C quoting: $'...'
      let j = i + 2;
      while (j < s.length && s[j] !== "'") {
        if (s[j] === '\\' && j + 1 < s.length) {
          const n = s[j + 1];
          cur += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          j += 2;
        } else {
          cur += s[j++];
        }
      }
      hasToken = true;
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length && '"\\$`'.includes(s[j + 1])) {
          cur += s[j + 1];
          j += 2;
        } else {
          cur += s[j++];
        }
      }
      if (j >= s.length) throw new ToolError('curl_parse', 'Unclosed double quote in the cURL command.');
      hasToken = true;
      i = j + 1;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[i + 1];
      hasToken = true;
      i += 2;
    } else if (/\s/.test(c)) {
      if (hasToken) out.push(cur);
      cur = '';
      hasToken = false;
      i++;
    } else {
      cur += c;
      hasToken = true;
      i++;
    }
  }
  if (hasToken) out.push(cur);
  return out;
}

const SECRET_HEADERS = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token|x-amz-security-token)$/i;
const SECRET_QUERY = /^(api[_-]?key|key|token|access[_-]?token|auth|signature|sig|secret|password|client[_-]?secret)$/i;
const HARMLESS_HEADERS = /^(content-type|accept|accept-encoding|accept-language|user-agent|connection|cache-control|pragma|origin|referer|sec-.*|dnt|host|content-length|priority|if-none-match|if-modified-since)$/i;

/** Short options that take a value (so -XPOST means -X POST). */
const SHORT_WITH_VALUE = new Set(['X', 'H', 'd', 'F', 'u', 'b', 'o', 'w', 'm', 'A', 'e', 'x', 'r', 'c', 'T', 'E', 'K', 'Y', 'y', 'z', 'C', 'P', 'Q', 'U']);

export const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function asMethod(value: string): HttpMethod {
  const m = value.toUpperCase();
  if (!METHODS.includes(m as HttpMethod)) throw new ToolError('curl_parse', `Unsupported HTTP method "${value}".`);
  return m as HttpMethod;
}

export function parseUrl(raw: string): URL {
  let text = raw.trim();
  if (!/^https?:\/\//i.test(text)) {
    if (text.startsWith('/')) text = `https://api.invalid${text}`;
    else text = `https://${text}`;
  }
  try {
    return new URL(text);
  } catch {
    throw new ToolError('bad_url', `"${raw}" is not a valid URL.`);
  }
}

/** Strips secret query parameters from a URL, recording what was removed. */
export function stripSecretQuery(url: URL, removed: string[]): void {
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_QUERY.test(key)) {
      url.searchParams.delete(key);
      removed.push(`query parameter "${key}"`);
    }
  }
}

export function parseCurl(command: string): ParsedRequest {
  const words = shellSplit(command.trim());
  if (words[0] !== 'curl') throw new ToolError('curl_parse', 'Expected the command to start with "curl".');
  let method: HttpMethod | undefined;
  let url: string | undefined;
  const headers: { name: string; value: string }[] = [];
  const dataParts: string[] = [];
  let forceGet = false;
  const removedSecrets: string[] = [];
  const ignoredHeaders: string[] = [];

  const form: { name: string; file: boolean }[] = [];
  const notes: string[] = [];
  const takesValue = new Set(['-o', '--output', '-w', '--write-out', '-m', '--max-time', '--connect-timeout', '-A', '--user-agent', '-e', '--referer', '--retry', '-x', '--proxy', '--cacert', '--cert', '--key', '-r', '--range', '--limit-rate', '-c', '--cookie-jar']);

  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    const next = () => {
      const v = words[++i];
      if (v === undefined) throw new ToolError('curl_parse', `Missing value after ${w}.`);
      return v;
    };
    // Support --flag=value and short flags with the value attached (-XPOST, -HAccept:x, -sSX POST).
    const eq = w.startsWith('--') ? w.indexOf('=') : -1;
    let flag = eq > 0 ? w.slice(0, eq) : w;
    let inline = eq > 0 ? w.slice(eq + 1) : undefined;
    if (/^-[A-Za-z]{2,}/.test(w) || /^-[A-Za-z]./.test(w)) {
      // Walk the cluster: boolean letters first, then one letter that takes a value.
      let k = 1;
      while (k < w.length && !SHORT_WITH_VALUE.has(w[k])) k++;
      if (k < w.length) {
        flag = `-${w[k]}`;
        inline = w.length > k + 1 ? w.slice(k + 1) : undefined;
      }
    }
    const value = () => inline ?? next();

    switch (flag) {
      case '-X':
      case '--request':
        method = asMethod(value());
        break;
      case '-H':
      case '--header': {
        const h = value();
        const idx = h.indexOf(':');
        if (idx > 0) headers.push({ name: h.slice(0, idx).trim(), value: h.slice(idx + 1).trim() });
        break;
      }
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-binary':
      case '--data-ascii':
      case '--data-urlencode':
        dataParts.push(value());
        break;
      case '--json':
        dataParts.push(value());
        headers.push({ name: 'Content-Type', value: 'application/json' });
        break;
      case '-F':
      case '--form':
      case '--form-string': {
        const f = value();
        const i2 = f.indexOf('=');
        const name = i2 > 0 ? f.slice(0, i2) : f;
        const isFile = flag !== '--form-string' && i2 > 0 && /^[@<]/.test(f.slice(i2 + 1));
        form.push({ name, file: isFile });
        break;
      }
      case '-G':
      case '--get':
        forceGet = true;
        break;
      case '-u':
      case '--user':
        value();
        removedSecrets.push('basic auth credentials (-u)');
        break;
      case '-b':
      case '--cookie':
        value();
        removedSecrets.push('cookies (-b)');
        break;
      case '--oauth2-bearer':
        value();
        removedSecrets.push('bearer token (--oauth2-bearer)');
        break;
      case '--url':
        url = value();
        break;
      default:
        if (w.startsWith('-')) {
          if (takesValue.has(flag) && inline === undefined) i++;
          // Other flags (-s, -L, -k, -v, --compressed, -i) do not affect the endpoint.
        } else if (!url) {
          url = w;
        }
    }
  }
  if (!url) throw new ToolError('curl_parse', 'No URL found in the cURL command.');
  const parsed = parseUrl(url);

  const kept: { name: string; value: string }[] = [];
  for (const h of headers) {
    if (SECRET_HEADERS.test(h.name)) removedSecrets.push(`header "${h.name}"`);
    else if (HARMLESS_HEADERS.test(h.name)) kept.push(h);
    else ignoredHeaders.push(h.name);
  }
  stripSecretQuery(parsed, removedSecrets);

  let body: string | undefined = dataParts.length ? dataParts.join('&') : undefined;
  if (forceGet && body) {
    for (const pair of body.split('&')) {
      const eqAt = pair.indexOf('=');
      const k = eqAt === -1 ? pair : pair.slice(0, eqAt);
      const v = eqAt === -1 ? '' : pair.slice(eqAt + 1);
      if (k) parsed.searchParams.append(safeDecode(k), safeDecode(v));
    }
    stripSecretQuery(parsed, removedSecrets);
    body = undefined;
  }
  if (form.length) {
    if (body !== undefined) notes.push('The command has both -d and -F; only the -F form fields were used.');
    body = undefined;
    const files = form.filter((f) => f.file).map((f) => f.name);
    notes.push(`This is a multipart form upload (${form.map((f) => f.name + (f.file ? ' (file)' : '')).join(', ')}). The generated function sends no body yet${files.length ? `; send ${files.join(', ')} with FormData (Next.js) or Dio's FormData (Flutter)` : ''}.`);
  }
  const finalMethod = method ?? (forceGet ? 'GET' : body !== undefined || form.length ? 'POST' : 'GET');
  return { method: finalMethod, url: parsed, headers: kept, body, removedSecrets, ignoredHeaders, form, notes };
}
