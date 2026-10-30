// HAR import: the requests a browser recorded (DevTools → Network → Save all as
// HAR). JSON API calls are grouped by method and normalized path, and every
// response of a group becomes a sample for the model.
//
// A HAR file holds cookies, auth headers and personal data. Headers are never
// read; secret query parameters are dropped; bodies are only used to infer
// types and are never written, cached or kept in history.

import { ToolError, type HttpMethod } from '../core/types.ts';
import { stripSecretQuery } from './curl.ts';
import { analyzePath, buildEndpoint } from './endpoint.ts';
import type { ImportedOperation, ImportResult } from './apiSpec.ts';

interface HarEntry {
  request?: { method?: string; url?: string; postData?: { mimeType?: string; text?: string } };
  response?: { status?: number; content?: { mimeType?: string; text?: string; encoding?: string } };
}

const ANALYTICS = /(google-analytics|googletagmanager|doubleclick|segment\.(io|com)|sentry\.io|hotjar|mixpanel|amplitude|datadoghq|newrelic|nr-data|intercom|facebook\.(com|net)|clarity\.ms|fullstory|launchdarkly|stripe\.network|cloudflareinsights|vercel-insights|posthog)/i;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export const isHar = (doc: unknown): boolean => !!doc && typeof doc === 'object' && !!(doc as { log?: { entries?: unknown } }).log && Array.isArray((doc as { log: { entries?: unknown } }).log.entries);

function bodyText(content: { text?: string; encoding?: string } | undefined): string | undefined {
  if (!content?.text) return undefined;
  return content.encoding === 'base64' ? Buffer.from(content.text, 'base64').toString('utf8') : content.text;
}

function json(text: string | undefined): unknown {
  if (text === undefined || text.trim() === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function readHar(doc: { log: { entries: HarEntry[]; creator?: { name?: string } } }, opts: { includeErrors?: boolean; baseUrl?: string } = {}): ImportResult {
  const warnings: string[] = [];
  const groups = new Map<string, { method: HttpMethod; url: URL; samples: unknown[]; request?: unknown; count: number; host: string }>();
  let skipped = { notJson: 0, errors: 0, analytics: 0, other: 0, outside: 0 };
  const removed: string[] = [];
  for (const e of doc.log.entries) {
    const method = String(e.request?.method ?? '').toUpperCase();
    const raw = e.request?.url ?? '';
    if (!METHODS.has(method) || !/^https?:\/\//.test(raw)) {
      skipped.other++;
      continue;
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      skipped.other++;
      continue;
    }
    if (ANALYTICS.test(url.hostname)) {
      skipped.analytics++;
      continue;
    }
    if (opts.baseUrl && !raw.startsWith(opts.baseUrl.replace(/\/$/, ''))) {
      skipped.outside++;
      continue;
    }
    const status = e.response?.status ?? 0;
    if ((status < 200 || status >= 300) && !opts.includeErrors) {
      skipped.errors++;
      continue;
    }
    const mime = e.response?.content?.mimeType ?? '';
    const body = json(bodyText(e.response?.content));
    const isDelete = method === 'DELETE' || status === 204;
    if (!/json/i.test(mime) && !(isDelete && !mime)) {
      skipped.notJson++;
      continue;
    }
    stripSecretQuery(url, removed);
    let path: string;
    try {
      path = analyzePath(url.pathname).path;
    } catch {
      skipped.other++;
      continue;
    }
    const key = `${method} ${url.host}${path}`;
    const g = groups.get(key) ?? { method: method as HttpMethod, url, samples: [], count: 0, host: url.host };
    g.count++;
    if (body !== undefined && g.samples.length < 10) g.samples.push(body);
    for (const [k, v] of url.searchParams) if (!g.url.searchParams.has(k)) g.url.searchParams.set(k, v);
    if (g.request === undefined && /json/i.test(e.request?.postData?.mimeType ?? 'json')) g.request = json(e.request?.postData?.text);
    groups.set(key, g);
  }
  if (!groups.size) {
    throw new ToolError('no_endpoints', 'The HAR file has no JSON API calls to import.', `Skipped: ${skipped.notJson} non-JSON, ${skipped.errors} failed (use --include-errors), ${skipped.analytics} analytics, ${skipped.outside} outside --base-url, ${skipped.other} other.`);
  }
  const hosts = [...new Set([...groups.values()].map((g) => g.host))];
  if (hosts.length > 1 && !opts.baseUrl) warnings.push(`Requests go to ${hosts.length} hosts (${hosts.join(', ')}). Pass --base-url https://<host> to import only your API.`);
  if (removed.length) warnings.push(`Removed from the URLs and never written anywhere: ${[...new Set(removed)].join(', ')}.`);
  const skippedTotal = skipped.notJson + skipped.errors + skipped.analytics + skipped.other + skipped.outside;
  if (skippedTotal) warnings.push(`Skipped ${skippedTotal} request${skippedTotal === 1 ? '' : 's'}: ${skipped.notJson} not JSON, ${skipped.errors} failed${skipped.errors ? ' (--include-errors keeps them)' : ''}, ${skipped.analytics} analytics, ${skipped.outside} outside --base-url, ${skipped.other} other.`);

  const operations: ImportedOperation[] = [];
  const used = new Set<string>();
  for (const g of groups.values()) {
    try {
      const spec = buildEndpoint({ method: g.method, url: g.url, responseSamples: g.samples, requestSample: g.request });
      if (used.has(spec.name)) {
        let n = 2;
        while (used.has(`${spec.name}${n}`)) n++;
        spec.name = `${spec.name}${n}`;
      }
      used.add(spec.name);
      operations.push({ spec, tags: [g.host], source: `${g.method} ${g.host}${spec.path} (${g.count} request${g.count === 1 ? '' : 's'})` });
    } catch (e) {
      warnings.push(`${g.method} ${g.url.pathname}: ${(e as Error).message}`);
    }
  }
  return { format: 'har', title: `HAR from ${doc.log.creator?.name ?? 'a browser'} (${doc.log.entries.length} requests)`, operations, warnings };
}
