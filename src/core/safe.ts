// Guards between untrusted input (cURL, HAR, OpenAPI, JSON samples, flags)
// and generated source code. Every value that ends up inside a string
// literal, a comment or a URL in generated code goes through one of these.
//
// Two layers: inputs are narrowed to safe characters where the meaning
// allows it (URL paths are percent-encoded, hosts are checked), and string
// literals are escaped for the target language anyway, so neither layer has
// to be perfect on its own.

import { ToolError } from './types.ts';

/** Characters kept as they are in a URL path segment; everything else is percent-encoded. */
const PATH_SAFE = /[A-Za-z0-9\-._~!&+,;=:@]/;

/** Percent-encodes a decoded path segment so it holds no quote, backtick, $, \, *, braces or spaces. */
export function encodePathSegment(seg: string): string {
  let out = '';
  for (const ch of seg) out += PATH_SAFE.test(ch) ? ch : [...Buffer.from(ch, 'utf8')].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
  return out;
}

/** A host as URLs allow it, narrowed to what DNS names and IP addresses use. */
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$|^\[[0-9A-Fa-f:.]+\]$/;

/** Throws unless the URL's host is a plain DNS name or IP address (no quotes, backticks, $ or braces). */
export function checkHost(url: URL, what = 'The URL'): void {
  if (!HOST.test(url.hostname)) throw new ToolError('bad_url', `${what} has a host devtool will not write into code: "${url.hostname.slice(0, 80)}".`, 'Use a normal host name such as api.example.com.');
}

/** A base URL that is safe to write into generated code and config files: http(s), plain host, optional port and plain path. */
const BASE_URL = /^https?:\/\/[^\s/?#]+(?::\d{1,5})?(?:\/[A-Za-z0-9\-._~!&+,;=:@%/]*)?$/;

/** Returns the base URL without a trailing slash, or throws a clear error. */
export function checkBaseUrl(value: string): string {
  const v = value.trim();
  let u: URL | null = null;
  try {
    u = new URL(v);
  } catch {
    u = null;
  }
  if (!u || !BASE_URL.test(v) || (u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) {
    throw new ToolError('bad_url', `"${v.slice(0, 120)}" is not a base URL devtool can use.`, 'Use something like https://api.example.com or https://api.example.com/v1 (no quotes, spaces, query or credentials).');
  }
  checkHost(u, 'The base URL');
  return v.replace(/\/+$/, '');
}

/** Same check as checkBaseUrl, as an interactive prompt validator (null = fine). */
export function baseUrlProblem(value: string): string | null {
  if (value === '') return null;
  try {
    checkBaseUrl(value);
    return null;
  } catch (e) {
    return e instanceof ToolError ? `${e.message} ${e.hint ?? ''}`.trim() : 'Not a valid URL.';
  }
}

/** A JavaScript/TypeScript string literal in the given quote (' " or `). */
export function jsString(s: string, q: string): string {
  let body = s.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  body = body.split(q).join(`\\${q}`);
  if (q === '`') body = body.replace(/\$\{/g, '\\${');
  return `${q}${body}${q}`;
}

/** The inside of a JavaScript template literal (no backticks around it): escapes \, ` and ${. */
export function jsTemplateText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/** A Kotlin string literal in double quotes: escapes \, ", $ and line breaks. */
export function ktString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
}

/** Text that is safe inside a block or doc comment in TS, Dart and Kotlin: no comment end and one line. */
export function commentText(s: string): string {
  return s.replace(/\*\//g, '*\u200b/').replace(/[\r\n]+/g, ' ');
}
