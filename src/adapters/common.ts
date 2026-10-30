// Scanning helpers shared by adapters.

import { extname, join } from 'node:path';
import { readJson, readText, walk } from '../core/fsutil.ts';
import { MAP_SCHEMA_VERSION, type BaseUrlInfo, type EndpointSpec, type FrameworkId, type LocaleInfo, type ProjectMap } from '../core/types.ts';

export function emptyMap(framework: FrameworkId, adapter: string): ProjectMap {
  return {
    schema: MAP_SCHEMA_VERSION,
    framework,
    adapter,
    conventions: {},
    routes: [],
    endpoints: [],
    models: [],
    locales: { languages: [], files: [], keyCount: 0 },
    baseUrls: [],
    stats: { files: 0, byExtension: {} },
    notes: [],
  };
}

export function fileStats(files: string[]): { files: number; byExtension: Record<string, number> } {
  const byExtension: Record<string, number> = {};
  for (const f of files) {
    const ext = extname(f) || '(none)';
    byExtension[ext] = (byExtension[ext] ?? 0) + 1;
  }
  const sorted = Object.fromEntries(Object.entries(byExtension).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  return { files: files.length, byExtension: sorted };
}

const LANG = /^[a-z]{2,3}(?:[-_][A-Za-z]{2,4})?$/;

function countKeys(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  let n = 0;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k.startsWith('@')) continue; // ARB metadata
    if (v && typeof v === 'object' && !Array.isArray(v)) n += countKeys(v);
    else n++;
  }
  return n;
}

/** Finds locale files: <dir>/<lang>.json in common folders, and Flutter ARB files. */
export function scanLocales(root: string, files: string[]): LocaleInfo {
  const localeFiles: { file: string; lang: string }[] = [];
  for (const f of files) {
    const parts = f.split('/');
    const base = parts[parts.length - 1];
    const dir = parts.slice(0, -1).join('/');
    const json = base.match(/^([a-z]{2,3}(?:[-_][A-Za-z]{2,4})?)\.json$/);
    if (json && /(^|\/)(messages|locales|i18n|lang|translations)(\/|$)/.test(dir) && LANG.test(json[1])) {
      localeFiles.push({ file: f, lang: json[1] });
      continue;
    }
    const arb = base.match(/^(?:[a-z0-9_]+_)?([a-z]{2,3}(?:_[A-Z]{2})?)\.arb$/);
    if (arb) localeFiles.push({ file: f, lang: arb[1] });
  }
  if (!localeFiles.length) return { languages: [], files: [], keyCount: 0 };
  // Keep the folder with the most locale files.
  const byDir = new Map<string, typeof localeFiles>();
  for (const l of localeFiles) {
    const d = l.file.split('/').slice(0, -1).join('/');
    byDir.set(d, [...(byDir.get(d) ?? []), l]);
  }
  const [, chosen] = [...byDir.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
  const languages = chosen.map((l) => l.lang).sort();
  let keyCount = 0;
  for (const l of chosen) keyCount = Math.max(keyCount, countKeys(readJson(join(root, l.file))));
  const def = languages.includes('en') ? 'en' : languages[0];
  return { default: def, languages, files: chosen.map((l) => l.file).sort(), keyCount };
}

/** Reads URL-valued variables from .env files (names only for anything that is not a URL). */
export function scanEnvBaseUrls(root: string, files: string[]): BaseUrlInfo[] {
  const out: BaseUrlInfo[] = [];
  const envFiles = files.filter((f) => /(^|\/)\.env(\.[\w.-]+)?$/.test(f) && !f.includes('/'));
  for (const f of envFiles) {
    const text = readText(join(root, f)) ?? '';
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*['"]?(https?:\/\/[^'"\s#]+)['"]?/);
      if (m) out.push({ name: m[1], value: m[2], file: f });
    }
  }
  return out;
}

/** walk() skips dot-files' folders but not dot files; env files need an explicit listing. */
export function listRootEnvFiles(root: string): string[] {
  return walk(root, '.', { exts: ['.env', '.local', '.example', '.development', '.production', '.staging', '.test'] }).filter((f) => !f.includes('/') && f.startsWith('.env'));
}

/**
 * The path to call through an HTTP client that already has a base URL (Dio, Retrofit, a fetch
 * helper, an axios instance), for an endpoint that came from an API spec. The spec's host is a
 * stand-in for the app's own base URL (often another environment: test, staging), so it is never
 * written into the call. The spec's path prefix (/v1) stays unless the client's base URL already
 * ends with it. Returns null for other inputs (cURL, HAR, Postman), which keep their host rules.
 */
export function specRelativePath(spec: EndpointSpec, clientBaseUrl?: string): string | null {
  if (spec.serverPrefix === undefined) return null;
  let clientPrefix = '';
  try {
    if (clientBaseUrl) clientPrefix = new URL(clientBaseUrl).pathname.replace(/\/$/, '');
  } catch {
    // Not a literal URL: nothing to strip.
  }
  const p = spec.path;
  return clientPrefix && (p === clientPrefix || p.startsWith(`${clientPrefix}/`)) ? p.slice(clientPrefix.length) || '/' : p;
}
