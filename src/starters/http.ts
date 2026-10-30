// The only network code in devtool. Every request goes to the catalog or its
// API, announces itself once per run, has a timeout and a size cap, and maps
// failures to devtool error codes. Tokens go in the Authorization header and
// are never part of a message.

import { ToolError } from '../core/types.ts';

let announced = false;
let announcer: (msg: string) => void = (m) => process.stderr.write(`${m}\n`);

export function setAnnouncer(fn: (msg: string) => void): void {
  announcer = fn;
  announced = false;
}

function announce(url: URL): void {
  if (announced) return;
  announced = true;
  announcer(`Contacting the starter catalog at ${url.host} (devtool new and starters commands only; nothing about your projects is sent).`);
}

/** https only, except a local test server. */
export function checkUrl(raw: string, what: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ToolError('bad_registry', `${what} is not a URL: ${raw.slice(0, 100)}`);
  }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new ToolError('bad_registry', `${what} must use https: ${u.origin}`);
  if (u.username || u.password) throw new ToolError('bad_registry', `${what} must not contain a user name or password.`);
  return u;
}

export interface HttpResult {
  status: number;
  body: Buffer;
  headers: Headers;
}

export async function request(url: URL, opts: { method?: string; json?: unknown; token?: string; etag?: string; maxBytes: number; timeoutMs?: number }): Promise<HttpResult> {
  announce(url);
  const headers: Record<string, string> = { 'user-agent': 'devtool', accept: 'application/json, application/octet-stream' };
  if (opts.json !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.etag) headers['if-none-match'] = opts.etag;
  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? 'GET', headers, body: opts.json === undefined ? undefined : JSON.stringify(opts.json), redirect: 'error', signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
  } catch (e) {
    const timeout = (e as Error).name === 'TimeoutError';
    throw new ToolError('network_unavailable', `Could not reach the starter catalog (${url.host}): ${timeout ? 'timed out' : 'connection failed'}.`, 'Check the connection, or use a starter that is already downloaded with --cached.');
  }
  const len = Number(res.headers.get('content-length') ?? '0');
  if (len > opts.maxBytes) throw new ToolError('archive_too_large', `The response from ${url.host} is larger than the safety limit.`, 'Report it; nothing was written.');
  // Read with a running cap, so a server that lies about the length cannot fill memory.
  const chunks: Buffer[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > opts.maxBytes) {
        await reader.cancel();
        throw new ToolError('archive_too_large', `The response from ${url.host} is larger than the safety limit.`, 'Report it; nothing was written.');
      }
      chunks.push(Buffer.from(value));
    }
  }
  return { status: res.status, body: Buffer.concat(chunks), headers: res.headers };
}

/** Turns a failed API answer into the matching devtool error. */
export function apiError(r: HttpResult, ctx: { hadToken: boolean; what: string }): ToolError {
  let code = '';
  try {
    code = String((JSON.parse(r.body.toString('utf8')) as { error?: string }).error ?? '');
  } catch {
    // Not JSON.
  }
  if (r.status === 401) return ctx.hadToken ? new ToolError('token_expired', 'Your session has expired.', 'Run devtool login again.') : new ToolError('not_logged_in', `${ctx.what} needs an account.`, 'Run devtool login.');
  if (r.status === 403) return new ToolError('no_entitlement', `This account does not own ${ctx.what}.`, 'Buy it in the gallery, then run devtool whoami to refresh.');
  if (r.status === 404) return new ToolError(code === 'version_not_found' ? 'version_not_found' : 'template_not_found', `${ctx.what} was not found in the catalog.`, 'Check the id with devtool starters list.');
  if (r.status === 429) {
    const after = r.headers.get('retry-after');
    return new ToolError('rate_limited', 'Too many download requests.', `Wait${after ? ` ${after} seconds` : ' a while'} and try again.`);
  }
  return new ToolError('network_unavailable', `The starter catalog answered ${r.status} for ${ctx.what}.`, 'Try again later; report it if it persists.');
}
