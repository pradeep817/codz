// Login for paid starters: the OAuth device-code flow (codz prints a short
// code, you approve it in the browser), a short-lived access token and a
// rotating refresh token in ~/.codz/auth.json (owner-only). CI uses
// CODZ_TOKEN instead. Tokens never appear in output, history or plans.

import { spawn } from 'node:child_process';
import { ToolError } from '../core/types.ts';
import { readHomeFile, removeHome, writeHomeFile } from './home.ts';
import { apiError, checkUrl, request } from './http.ts';
import { registryConfig } from './registry.ts';
import { parseStrictJson, printable } from './strictJson.ts';

interface StoredAuth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  account: string;
  registry: string;
}

const api = (path: string) => new URL(path, `${registryConfig().api.href.replace(/\/?$/, '/')}`);
const json = (b: Buffer, what: string) => parseStrictJson(b.toString('utf8'), what, { maxBytes: 64 * 1024 }) as Record<string, unknown>;

function load(): StoredAuth | null {
  const b = readHomeFile('auth.json');
  if (!b) return null;
  try {
    const a = JSON.parse(b.toString('utf8')) as StoredAuth;
    return a.registry === registryConfig().api.href ? a : null;
  } catch {
    return null;
  }
}

function save(a: StoredAuth): void {
  writeHomeFile(JSON.stringify(a), { secret: true }, 'auth.json');
}

function tokens(body: Record<string, unknown>, account: string): StoredAuth {
  const access = body.access_token;
  const refresh = body.refresh_token;
  const ttl = Number(body.expires_in ?? 900);
  if (typeof access !== 'string' || typeof refresh !== 'string' || !access || !refresh) throw new ToolError('login_failed', 'The login server did not return tokens.', 'Try codz login again.');
  return { accessToken: access, refreshToken: refresh, expiresAt: Date.now() + Math.max(30, ttl) * 1000, account: typeof body.account === 'string' ? printable(body.account).slice(0, 200) : account, registry: registryConfig().api.href };
}

export const auth = {
  /** A usable access token, refreshed when it is about to expire; null when not logged in. */
  async accessToken(): Promise<string | undefined> {
    if (process.env.CODZ_TOKEN) return process.env.CODZ_TOKEN;
    const a = load();
    if (!a) return undefined;
    if (a.expiresAt - 60_000 > Date.now()) return a.accessToken;
    const r = await request(api('v1/token/refresh'), { method: 'POST', json: { refresh_token: a.refreshToken }, maxBytes: 64 * 1024 });
    if (r.status === 400 || r.status === 401) {
      removeHome('auth.json');
      throw new ToolError('token_expired', 'Your session has expired.', 'Run codz login again.');
    }
    if (r.status !== 200) throw apiError(r, { hadToken: true, what: 'refreshing the login' });
    const next = tokens(json(r.body, 'the refresh answer'), a.account);
    save(next);
    return next.accessToken;
  },

  account(): string | null {
    if (process.env.CODZ_TOKEN) return 'CODZ_TOKEN';
    return load()?.account ?? null;
  },

  async login(opts: { print: (line: string) => void; browser: boolean; sleep?: (ms: number) => Promise<void> }): Promise<{ account: string }> {
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const r = await request(api('v1/device/code'), { method: 'POST', json: { client: 'codz-cli' }, maxBytes: 64 * 1024 });
    if (r.status !== 200) throw apiError(r, { hadToken: false, what: 'login' });
    const d = json(r.body, 'the login answer');
    const deviceCode = String(d.device_code ?? '');
    const userCode = printable(String(d.user_code ?? '')).slice(0, 20);
    const verify = checkUrl(String(d.verification_uri ?? ''), 'the login page');
    let interval = Math.max(0, Number(d.interval ?? 5));
    const deadline = Date.now() + Math.min(Number(d.expires_in ?? 900), 1800) * 1000;
    if (!deviceCode || !userCode) throw new ToolError('login_failed', 'The login server did not return a code.', 'Try codz login again.');
    // The page must be on the catalog's own hosts; codz never opens a link a server made up elsewhere.
    const cfg = registryConfig();
    if (verify.host !== cfg.api.host && verify.host !== cfg.base.host && !verify.host.endsWith(`.${cfg.base.host}`)) throw new ToolError('login_failed', `The login page ${verify.host} is not on the catalog's site.`, 'Do not continue; report it.');
    opts.print(`Open ${verify.href} and enter code: ${userCode}`);
    if (opts.browser) openBrowser(verify.href);
    opts.print('Waiting for approval...');
    for (;;) {
      if (Date.now() > deadline) throw new ToolError('login_expired', 'The login code expired before it was approved.', 'Run codz login again.');
      await sleep(interval * 1000);
      const p = await request(api('v1/device/token'), { method: 'POST', json: { device_code: deviceCode }, maxBytes: 64 * 1024 });
      const body = p.body.length ? json(p.body, 'the login answer') : {};
      if (p.status === 200) {
        const a = tokens(body, 'your account');
        save(a);
        return { account: a.account };
      }
      const err = String(body.error ?? '');
      if (err === 'authorization_pending') continue;
      if (err === 'slow_down') {
        interval += 5;
        continue;
      }
      if (err === 'access_denied') throw new ToolError('login_denied', 'The login was declined in the browser.', 'Run codz login again to retry.');
      if (err === 'expired_token') throw new ToolError('login_expired', 'The login code expired before it was approved.', 'Run codz login again.');
      throw apiError(p, { hadToken: false, what: 'login' });
    }
  },

  async logout(): Promise<{ revoked: boolean; removed: boolean }> {
    const a = load();
    let revoked = false;
    if (a) {
      try {
        const r = await request(api('v1/token/revoke'), { method: 'POST', json: { refresh_token: a.refreshToken }, maxBytes: 64 * 1024 });
        revoked = r.status === 200 || r.status === 204;
      } catch {
        // Offline: the local copy is still deleted; the token can be revoked from the web account.
      }
    }
    return { revoked, removed: removeHome('auth.json') };
  },

  async whoami(): Promise<{ account: string; owned: { id: string; updatesUntil?: string }[] }> {
    const token = await auth.accessToken();
    if (!token) throw new ToolError('not_logged_in', 'You are not logged in.', 'Run codz login.');
    const r = await request(api('v1/me'), { token, maxBytes: 256 * 1024 });
    if (r.status !== 200) throw apiError(r, { hadToken: true, what: 'your account' });
    const b = json(r.body, 'the account answer');
    const owned = Array.isArray(b.owned) ? (b.owned as Record<string, unknown>[]).filter((o) => typeof o?.id === 'string').map((o) => ({ id: printable(String(o.id)).slice(0, 64), updatesUntil: typeof o.updatesUntil === 'string' ? printable(o.updatesUntil).slice(0, 10) : undefined })) : [];
    return { account: printable(String(b.account ?? auth.account() ?? '')).slice(0, 200), owned };
  },
};

function openBrowser(url: string): void {
  if (process.env.CI || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && process.platform === 'linux')) return;
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // The URL is printed; the user can open it.
  }
}
