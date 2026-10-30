// auth add: sign-in for an existing project, in the project's own style, as
// one previewed change.
//
//   Next.js       server actions for login and logout, the API token in an HttpOnly
//                 cookie, middleware that sends signed-out visitors to /login, a
//                 login page, and withAuth() to send the token from server code
//   React Native  the token in secure storage (expo-secure-store or react-native-keychain),
//                 sent by the fetch helper or an axios interceptor, sign out on 401,
//                 an AuthProvider with useAuth(), and a login screen
//   Flutter       the token in flutter_secure_storage, a Dio interceptor (token on every
//                 request, refresh or sign out on 401), an AuthService the router
//                 listens to (go_router redirect), and a login page
//   Android       the token in EncryptedSharedPreferences, an OkHttp interceptor,
//                 a Retrofit AuthApi, an AuthRepository and a login screen with a
//                 Hilt ViewModel (Hilt projects)
//
// The login screen comes from route add (so it is registered the project's
// way) and is then filled in. Everything runs in a private copy of the project
// and comes back as ONE change set.

import { posix } from 'node:path';
import { loadMap } from '../core/cache.ts';
import { loadConfig } from '../core/config.ts';
import { exists } from '../core/fsutil.ts';
import { openWorkspace, type Workspace } from '../core/workspace.ts';
import { ToolError, type Adapter, type ChangeSet, type Conventions, type ProjectMap } from '../core/types.ts';
import { dq } from '../adapters/dartGen.ts';
import { importPath } from '../adapters/nextjs.ts';
import { addPubspecDeps } from '../adapters/flutterSetup.ts';
import { gradleBlockAdd, tomlAdd } from '../adapters/androidSetup.ts';
import { jsString, ktString } from '../core/safe.ts';
import { planRouteAdd } from './route.ts';
import { join } from 'node:path';

export interface AuthOptions {
  /** POST, with { email, password }; answers with the token (and optionally the user). */
  loginPath?: string;
  /** GET with the token; answers with the signed-in user. */
  mePath?: string;
  /** POST with the token; optional, called on sign out. */
  logoutPath?: string;
  /** POST with { refreshToken }; when given, a 401 tries one refresh before signing out (Flutter, React Native). */
  refreshPath?: string;
  /** Field of the login answer that holds the token. */
  tokenField?: string;
  /** Field of the login answer that holds the refresh token. */
  refreshField?: string;
  /** Next.js: paths that stay public (besides /login). */
  publicPaths?: string[];
}

export interface AuthReport {
  changeSet: ChangeSet;
  framework: string;
  files: string[];
}

interface Resolved {
  loginPath: string;
  mePath: string;
  logoutPath: string;
  refreshPath: string;
  tokenField: string;
  refreshField: string;
  publicPaths: string[];
}

const API_PATH = /^\/[A-Za-z0-9\-._~/]*$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

function resolve(o: AuthOptions): Resolved {
  const r: Resolved = {
    loginPath: o.loginPath ?? '/auth/login',
    mePath: o.mePath ?? '/auth/me',
    logoutPath: o.logoutPath ?? '/auth/logout',
    refreshPath: o.refreshPath ?? '',
    tokenField: o.tokenField ?? 'token',
    refreshField: o.refreshField ?? 'refreshToken',
    publicPaths: o.publicPaths ?? [],
  };
  for (const [k, v] of [['--login-path', r.loginPath], ['--me-path', r.mePath], ['--logout-path', r.logoutPath], ['--refresh-path', r.refreshPath]] as const) {
    if (v && !API_PATH.test(v)) throw new ToolError('bad_args', `${k} "${v}" is not an API path.`, 'Use a path such as /auth/login (letters, digits, - _ . ~ and /).');
  }
  for (const [k, v] of [['--token-field', r.tokenField], ['--refresh-field', r.refreshField]] as const) {
    if (!FIELD.test(v)) throw new ToolError('bad_args', `${k} "${v}" is not a field name.`, 'Use the JSON key, for example token or access_token.');
  }
  for (const p of r.publicPaths) if (!/^\/[A-Za-z0-9\-._~/]*$/.test(p)) throw new ToolError('bad_args', `--public "${p}" is not a page path.`, 'Use a path such as /about.');
  return r;
}

export async function planAuthAdd(root: string, adapter: Adapter, opts: AuthOptions): Promise<AuthReport> {
  const o = resolve(opts);
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  if (!['nextjs', 'react-native', 'flutter', 'android'].includes(adapter.id)) throw new ToolError('not_supported', `auth add supports Next.js, React Native, Flutter and Android; this project uses the ${adapter.id} adapter.`, adapter.id === 'react' || adapter.id === 'ios' ? `Sign-in for ${adapter.id === 'react' ? 'React web apps' : 'iOS'} is not written yet: add your login call with devtool api add, then a form with devtool screen add login --api <endpoint> --form.` : 'Run devtool init to check which framework devtool detects here.');
  const ws = openWorkspace(root);
  try {
    const summary: string[] = [];
    const warnings: string[] = [];
    let login: ChangeSet;
    try {
      login = await planRouteAdd(ws.root, adapter, { name: 'login', path: '/login' });
    } catch (e) {
      if (e instanceof ToolError && /already exists|already has/.test(e.message)) throw new ToolError('auth_exists', `This project already has a login screen (${e.message})`, 'auth add creates its own; remove or rename the existing one first, or wire it to your sign-in code by hand.');
      throw e;
    }
    if (!login.changes.length) throw new ToolError('auth_exists', 'This project already has a login route.', 'Remove it first, or wire your own screen to the generated auth code by hand.');
    ws.apply(login);
    // The page itself: a GetX module also creates a binding and a controller, which must stay as they are.
    const created = login.changes.filter((ch) => ch.before === null && ch.after !== null).map((ch) => ch.path);
    const page = created.find((p) => /\/views\/\w+_view\.dart$/.test(p)) ?? created.find((p) => /(page|screen|login)\.(dart|tsx|jsx|kt)$|\/page\.(tsx|jsx)$/i.test(p)) ?? created[0];
    if (!page) throw new ToolError('internal', 'route add did not create a login page.');
    if (adapter.id === 'nextjs') nextAuth(ws, map, page, o, summary, warnings);
    else if (adapter.id === 'react-native') rnAuth(ws, map, page, o, summary, warnings);
    else if (adapter.id === 'flutter') flutterAuth(ws, map, page, o, summary, warnings);
    else androidAuth(ws, map, page, o, summary, warnings);
    summary.unshift(`Sign-in for ${adapter.id === 'nextjs' ? 'Next.js' : adapter.id === 'react-native' ? 'React Native' : adapter.id === 'flutter' ? 'Flutter' : 'Android'}: POST ${o.loginPath} with { email, password } → { ${o.tokenField} }, GET ${o.mePath} for the user`);
    const changeSet = ws.finish('auth add', summary, warnings);
    return { changeSet, framework: adapter.id, files: changeSet.changes.map((c) => c.path) };
  } finally {
    ws.dispose();
  }
}

// ---------------------------------------------------------------------------
// Next.js

function nextAuth(ws: Workspace, map: ProjectMap, page: string, o: Resolved, summary: string[], warnings: string[]): void {
  const c = map.conventions;
  const q = c.quote === 'double' ? '"' : "'";
  const s = (v: string) => jsString(v, q);
  const appDir = c.appDir || 'app';
  const srcRoot = appDir.startsWith('src/') ? 'src' : '';
  const helperFile = c.httpHelperFile || '';
  const libDir = helperFile ? posix.dirname(posix.dirname(helperFile)) : posix.join(srcRoot, 'lib');
  const authDir = posix.join(libDir === '.' ? '' : libDir, 'auth');
  const env = c.baseUrlEnv && /^\w+$/.test(c.baseUrlEnv) ? c.baseUrlEnv : 'API_URL';
  const f = (name: string) => posix.join(authDir, name);
  const imp = (from: string, to: string) => importPath(from, to, c);

  ws.write(f('cookie.ts'), `/** The cookie that holds the API token. HttpOnly, so browser scripts cannot read it. */\nexport const SESSION_COOKIE = ${s('session')};\n`);

  ws.write(
    f('api.ts'),
    `// Calls to the sign-in endpoints. Change the paths here if your API uses others.
const BASE_URL = process.env.${env} ?? '';

export interface AuthUser {
  id?: string | number;
  name?: string;
  email?: string;
  [key: string]: unknown;
}

async function call<T>(path: string, init: RequestInit, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', \`Bearer \${token}\`);
  const res = await fetch(\`\${BASE_URL}\${path}\`, { cache: 'no-store', ...init, headers });
  if (!res.ok) throw Object.assign(new Error(\`\${init.method ?? 'GET'} \${path} failed (\${res.status})\`), { status: res.status });
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** POST ${o.loginPath} → the token from "${o.tokenField}". */
export async function requestLogin(email: string, password: string): Promise<string> {
  const data = await call<Record<string, unknown>>(${s(o.loginPath)}, { method: 'POST', body: JSON.stringify({ email, password }) });
  const token = data[${s(o.tokenField)}];
  if (typeof token !== 'string' || !token) throw new Error('The login answer has no ${o.tokenField} field.');
  return token;
}

/** GET ${o.mePath} with the token. */
export function requestMe(token: string): Promise<AuthUser> {
  return call<AuthUser>(${s(o.mePath)}, { method: 'GET' }, token);
}

/** POST ${o.logoutPath} with the token (errors are ignored: the cookie is removed either way). */
export async function requestLogout(token: string): Promise<void> {
  await call<void>(${s(o.logoutPath)}, { method: 'POST' }, token).catch(() => undefined);
}
`,
  );

  ws.write(
    f('session.ts'),
    `import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { requestMe, type AuthUser } from ${s(imp(f('session.ts'), f('api.ts')))};
import { SESSION_COOKIE } from ${s(imp(f('session.ts'), f('cookie.ts')))};

const MAX_AGE = 60 * 60 * 24 * 30;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

export async function getToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export async function setSession(token: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, { httpOnly: true, secure: IS_PRODUCTION, sameSite: 'lax', path: '/', maxAge: MAX_AGE });
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

/** The signed-in user, or null (also when the token has expired). */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const token = await getToken();
  if (!token) return null;
  try {
    return await requestMe(token);
  } catch (e) {
    if ((e as { status?: number }).status === 401) return null;
    throw e;
  }
}

/** For server pages behind sign-in: the user, or a redirect to /login. */
export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return user;
}

/**
 * Adds the signed-in user's token to a request made from server code, for the API functions devtool writes:
 *   const orders = await getOrders(await withAuth());      // when the function takes RequestInit
 *   await apiFetch('/orders', await withAuth({ method: 'POST', body }));
 */
export async function withAuth(init: RequestInit = {}): Promise<RequestInit> {
  const token = await getToken();
  if (!token) return init;
  const headers = new Headers(init.headers);
  headers.set('Authorization', \`Bearer \${token}\`);
  return { ...init, headers };
}
`,
  );

  ws.write(
    f('actions.ts'),
    `'use server';

import { redirect } from 'next/navigation';

import { requestLogin, requestLogout } from ${s(imp(f('actions.ts'), f('api.ts')))};
import { clearSession, getToken, setSession } from ${s(imp(f('actions.ts'), f('session.ts')))};

export interface LoginState {
  error?: string;
}

/** Signs in with the API and keeps the token in an HttpOnly cookie. */
export async function login(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');
  if (!email || !password) return { error: 'Enter your email and password.' };
  try {
    await setSession(await requestLogin(email, password));
  } catch (e) {
    const status = (e as { status?: number }).status;
    return { error: status === 401 || status === 400 ? 'That email and password do not match.' : 'Sign-in failed. Try again.' };
  }
  const next = String(form.get('next') ?? '');
  redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
}

export async function logout(): Promise<void> {
  const token = await getToken();
  if (token) await requestLogout(token);
  await clearSession();
  redirect('/login');
}
`,
  );

  const ext = page.endsWith('.jsx') ? 'jsx' : 'tsx';
  const formFile = posix.join(posix.dirname(page), `LoginForm.${ext}`);
  ws.write(
    formFile,
    `'use client';

import { useActionState } from 'react';

import { login, type LoginState } from ${s(imp(formFile, f('actions.ts')))};

export default function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});
  return (
    <form action={action} style={{ display: 'grid', gap: 12, maxWidth: 360 }}>
      <input type="hidden" name="next" value={next} />
      <label>
        Email
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label>
        Password
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {state.error ? <p role="alert">{state.error}</p> : null}
      <button disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
    </form>
  );
}
`,
  );
  ws.write(
    page,
    `import LoginForm from './LoginForm';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main>
      <h1>Sign in</h1>
      <LoginForm next={next ?? '/'} />
    </main>
  );
}
`,
  );

  const middleware = posix.join(srcRoot, 'middleware.ts');
  const publicList = ['/login', ...o.publicPaths];
  if (exists(join(ws.root, middleware)) || exists(join(ws.root, posix.join(srcRoot, 'middleware.js')))) {
    warnings.push(`${middleware} already exists, so it was left alone. To protect pages, redirect to /login there when the "session" cookie is missing.`);
  } else {
    ws.write(
      middleware,
      `import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE } from ${s(imp(middleware, f('cookie.ts')))};

/** Pages anyone may open. Every other page needs a session cookie (its token is checked by the API on each call). */
const PUBLIC = [${publicList.map((p) => s(p)).join(', ')}];

export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (PUBLIC.some((p) => path === p || path.startsWith(\`\${p}/\`)) || req.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  const url = new URL('/login', req.url);
  url.searchParams.set('next', path);
  return NextResponse.redirect(url);
}

export const config = {
  // Not for static files, images or API routes.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/|.*\\\\..*).*)'],
};
`,
    );
    summary.push(`${middleware}: every page except ${publicList.join(', ')} needs a session (add public pages with --public)`);
  }
  if (!c.baseUrlEnv) warnings.push(`No base URL setting was found; ${f('api.ts')} reads process.env.API_URL. Set it in .env.local.`);
  summary.push(`${f('api.ts')}, ${f('session.ts')}, ${f('actions.ts')}: sign in, sign out, getCurrentUser(), requireUser(), withAuth()`, `${page} and ${formFile}: the sign-in page`, 'From server code, send the token with withAuth(): apiFetch(path, await withAuth(init)). Sign out with the logout server action.');
}

// ---------------------------------------------------------------------------
// React Native

function rnAuth(ws: Workspace, map: ProjectMap, page: string, o: Resolved, summary: string[], warnings: string[]): void {
  const c = map.conventions;
  const q = c.quote === 'double' ? '"' : "'";
  const s = (v: string) => jsString(v, q);
  const srcRoot = c.aliasBase && c.aliasBase !== '.' ? c.aliasBase : posix.dirname(posix.dirname(page));
  const authDir = posix.join(srcRoot, 'auth');
  const f = (name: string) => posix.join(authDir, name);
  const rel = (from: string, to: string) => {
    const r = posix.relative(posix.dirname(from), to.replace(/\.(tsx?|jsx?)$/, ''));
    return r.startsWith('.') ? r : `./${r}`;
  };
  const expo = c.flavor !== 'bare';
  const axios = c.http === 'axios';

  // Secure storage.
  ws.write(
    f('tokenStore.ts'),
    expo
      ? `import * as SecureStore from 'expo-secure-store';

const ACCESS = 'auth_token';
const REFRESH = 'auth_refresh';
let cached: string | null | undefined;

/** The API tokens, in the Keychain (iOS) or the Keystore (Android), with an in-memory copy. */
export const tokenStore = {
  async get(): Promise<string | null> {
    if (cached === undefined) cached = await SecureStore.getItemAsync(ACCESS);
    return cached ?? null;
  },
  getRefresh: () => SecureStore.getItemAsync(REFRESH),
  async set(token: string, refresh?: string | null): Promise<void> {
    cached = token;
    await SecureStore.setItemAsync(ACCESS, token);
    if (refresh) await SecureStore.setItemAsync(REFRESH, refresh);
  },
  async clear(): Promise<void> {
    cached = null;
    await SecureStore.deleteItemAsync(ACCESS);
    await SecureStore.deleteItemAsync(REFRESH);
  },
};
`
      : `import * as Keychain from 'react-native-keychain';

let cached: { token: string | null; refresh: string | null } | undefined;

async function load() {
  if (cached === undefined) {
    const c = await Keychain.getGenericPassword({ service: 'auth' });
    cached = c ? (JSON.parse(c.password) as { token: string | null; refresh: string | null }) : { token: null, refresh: null };
  }
  return cached;
}

/** The API tokens, in the Keychain (iOS) or the Keystore (Android), with an in-memory copy. */
export const tokenStore = {
  get: async () => (await load()).token,
  getRefresh: async () => (await load()).refresh,
  async set(token: string, refresh?: string | null): Promise<void> {
    cached = { token, refresh: refresh ?? (await load()).refresh };
    await Keychain.setGenericPassword('auth', JSON.stringify(cached), { service: 'auth' });
  },
  async clear(): Promise<void> {
    cached = { token: null, refresh: null };
    await Keychain.resetGenericPassword({ service: 'auth' });
  },
};
`,
  );

  // Base URL: the config file's API_URL when it has one.
  const configText = c.configFile ? ws.read(c.configFile) : null;
  const hasApiUrl = !!configText && /export const API_URL\b/.test(configText);
  const baseImport = hasApiUrl ? `import { API_URL } from ${s(rel(f('session.ts'), c.configFile!))};\n` : '';
  const baseExpr = hasApiUrl ? 'API_URL' : "process.env.EXPO_PUBLIC_API_URL ?? ''";
  if (!hasApiUrl) warnings.push(`No API_URL export was found in the config file; ${f('session.ts')} uses EXPO_PUBLIC_API_URL.`);

  ws.write(
    f('session.ts'),
    `${baseImport}import { tokenStore } from './tokenStore';

// Calls to the sign-in endpoints. Change the paths here if your API uses others.
export interface AuthUser {
  id?: string | number;
  name?: string;
  email?: string;
  [key: string]: unknown;
}

async function call<T>(path: string, init: RequestInit, token?: string | null): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) };
  if (token) headers.Authorization = \`Bearer \${token}\`;
  const res = await fetch(\`\${${baseExpr}}\${path}\`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
  if (!res.ok) throw Object.assign(new Error(\`\${init.method ?? 'GET'} \${path} failed (\${res.status})\`), { status: res.status });
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function requestLogin(email: string, password: string): Promise<void> {
  const data = await call<Record<string, unknown>>(${s(o.loginPath)}, { method: 'POST', body: JSON.stringify({ email, password }) });
  const token = data[${s(o.tokenField)}];
  if (typeof token !== 'string' || !token) throw new Error('The login answer has no ${o.tokenField} field.');
  const refresh = data[${s(o.refreshField)}];
  await tokenStore.set(token, typeof refresh === 'string' ? refresh : null);
}

export const requestMe = async () => call<AuthUser>(${s(o.mePath)}, { method: 'GET' }, await tokenStore.get());

export async function requestLogout(): Promise<void> {
  await call<void>(${s(o.logoutPath)}, { method: 'POST' }, await tokenStore.get()).catch(() => undefined);
  await tokenStore.clear();
}
${
  o.refreshPath
    ? `
/** Exchanges the refresh token for a new access token. Returns false when that is not possible. */
export async function refreshSession(): Promise<boolean> {
  const refresh = await tokenStore.getRefresh();
  if (!refresh) return false;
  try {
    const data = await call<Record<string, unknown>>(${s(o.refreshPath)}, { method: 'POST', body: JSON.stringify({ refreshToken: refresh }) });
    const token = data[${s(o.tokenField)}];
    if (typeof token !== 'string') return false;
    const next = data[${s(o.refreshField)}];
    await tokenStore.set(token, typeof next === 'string' ? next : refresh);
    return true;
  } catch {
    return false;
  }
}
`
    : ''
}
let onUnauthorized: (() => void) | null = null;

/** AuthProvider registers this; a 401 from any API call signs the user out. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

export function notifyUnauthorized(): void {
  onUnauthorized?.();
}
`,
  );

  ws.write(
    f('AuthContext.tsx'),
    `import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { requestLogin, requestLogout, requestMe, setUnauthorizedHandler, type AuthUser } from './session';
import { tokenStore } from './tokenStore';

type Status = 'loading' | 'signedOut' | 'signedIn';

interface AuthValue {
  status: Status;
  user: AuthUser | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

/** Restores the session at launch; signIn and signOut for the screens. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      void tokenStore.clear();
      setUser(null);
      setStatus('signedOut');
    });
    (async () => {
      if (!(await tokenStore.get())) return setStatus('signedOut');
      try {
        setUser(await requestMe());
        setStatus('signedIn');
      } catch {
        setStatus('signedOut');
      }
    })();
    return () => setUnauthorizedHandler(null);
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    await requestLogin(email, password);
    setUser(await requestMe().catch(() => null));
    setStatus('signedIn');
  }, []);

  const signOut = useCallback(async () => {
    await requestLogout();
    setUser(null);
    setStatus('signedOut');
  }, []);

  const value = useMemo(() => ({ status, user, signIn, signOut }), [status, user, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>.');
  return ctx;
}
`,
  );

  // Token on every request.
  let wired = false;
  if (axios && c.axiosInstanceFile) {
    const t = ws.read(c.axiosInstanceFile);
    const inst = (c.axiosInstance || 'api').replace(/^default:/, '');
    if (t && /^\w+$/.test(inst) && new RegExp(`\\b${inst}\\b`).test(t) && !/tokenStore/.test(t)) {
      const refresh = o.refreshPath
        ? `\n    const original = error.config as (typeof error.config & { _retried?: boolean }) | undefined;\n    if (original && !original._retried && (await refreshSession())) {\n      original._retried = true;\n      return ${inst}(original);\n    }`
        : '';
      ws.write(
        c.axiosInstanceFile,
        `${t.replace(/\s*$/, '\n')}
// Sign-in (devtool auth add): the token on every request; a 401 ${o.refreshPath ? 'tries one refresh, then ' : ''}signs out.
${inst}.interceptors.request.use(async (config) => {
  const token = await tokenStore.get();
  if (token) config.headers.Authorization = \`Bearer \${token}\`;
  return config;
});

${inst}.interceptors.response.use(undefined, async (error: AxiosError) => {
  if (error.response?.status === 401) {${refresh}
    notifyUnauthorized();
  }
  return Promise.reject(error);
});
`.replace(/^/, '') ,
      );
      // Imports at the top.
      let t2 = ws.read(c.axiosInstanceFile)!;
      t2 = t2.replace(/import axios(,? ?\{?[^}\n]*\}?)? from ['"]axios['"];?/, (m) => (/AxiosError/.test(m) ? m : m.includes('{') ? m.replace('{', '{ AxiosError, ').replace(/,\s*,/, ',') : m.replace(/import axios/, 'import axios, { AxiosError }')));
      const authImports = `import { ${['notifyUnauthorized', ...(o.refreshPath ? ['refreshSession'] : [])].join(', ')} } from ${s(rel(c.axiosInstanceFile, f('session.ts')))};\nimport { tokenStore } from ${s(rel(c.axiosInstanceFile, f('tokenStore.ts')))};\n`;
      t2 = t2.replace(/(import [^\n]+\n)(?![\s\S]*\nimport )/, `$1${authImports}`);
      ws.write(c.axiosInstanceFile, t2);
      wired = true;
      summary.push(`${c.axiosInstanceFile}: interceptors send the token and sign out on 401`);
    }
  } else if (c.httpHelperFile) {
    const t = ws.read(c.httpHelperFile);
    const helper = c.httpHelper || 'apiFetch';
    if (t && !/tokenStore/.test(t)) {
      // The helper devtool writes builds headers in one object literal; the token goes into it.
      const re = /headers: \{ ('Content-Type': 'application\/json',[^}]*?)\.\.\.init\.headers \}/;
      if (re.test(t) && new RegExp(`export async function ${helper}`).test(t)) {
        let t2 = t.replace(re, (_m, before: string) => `headers: { ${before}...(token ? { Authorization: \`Bearer \${token}\` } : {}), ...init.headers }`);
        t2 = t2.replace(new RegExp(`(export async function ${helper}<T>\\([^)]*\\)[^{]*\\{\\n)`), `$1  const token = await tokenStore.get();\n`);
        // A 401 signs out: right before the error is thrown.
        t2 = t2.replace(/(\n(\s*)if \(!res\.ok\) throw new ApiError\(res\.status)/, `\n$2if (res.status === 401) notifyUnauthorized();$1`);
        t2 = t2.replace(/(import [^\n]+\n)(?![\s\S]*\nimport )/, `$1import { notifyUnauthorized } from ${s(rel(c.httpHelperFile, f('session.ts')))};\nimport { tokenStore } from ${s(rel(c.httpHelperFile, f('tokenStore.ts')))};\n`);
        if (!/^import /m.test(t)) t2 = `import { notifyUnauthorized } from ${s(rel(c.httpHelperFile, f('session.ts')))};\nimport { tokenStore } from ${s(rel(c.httpHelperFile, f('tokenStore.ts')))};\n\n${t2}`;
        ws.write(c.httpHelperFile, t2);
        wired = true;
        summary.push(`${c.httpHelperFile}: ${helper}() sends the token and signs out on 401`);
      }
    }
  }
  if (wired && o.refreshPath && !axios) warnings.push('--refresh-path is used by the axios interceptor; with the fetch helper a 401 signs out (call refreshSession() from session.ts yourself to retry).');
  if (!wired) warnings.push(`The HTTP client was not changed (its shape is not the one devtool writes). Send "Authorization: Bearer <await tokenStore.get()>" on each request, and call notifyUnauthorized() on a 401.`);

  // The provider around the app.
  const appFile = ['App.tsx', 'App.jsx', 'App.js'].find((p) => ws.read(p) !== null);
  const appText = appFile ? ws.read(appFile) : null;
  if (appFile && appText && /<NavigationContainer[\s>]/.test(appText) && !/AuthProvider/.test(appText)) {
    let t = appText.replace(/(\n(\s*))<NavigationContainer([\s\S]*?)<\/NavigationContainer>/, (_m, lead: string, indent: string, inner: string) => `${lead}<AuthProvider>${lead}  <NavigationContainer${inner.replace(/\n/g, '\n  ')}</NavigationContainer>${lead}</AuthProvider>`);
    t = t.replace(/(import [^\n]+\n)(?![\s\S]*\nimport )/, `$1import { AuthProvider } from ${s(rel(appFile, f('AuthContext.tsx')))};\n`);
    ws.write(appFile, t);
    summary.push(`${appFile}: the app is wrapped in <AuthProvider>`);
  } else {
    warnings.push(`Wrap your app's root in <AuthProvider> (from ${f('AuthContext.tsx')}); it was not found in App.tsx.`);
  }

  // The login screen.
  const nav = c.navigatorFile ? ws.read(c.navigatorFile) : null;
  const first = nav ? /<Stack\.Screen name="(\w+)"/.exec(nav)?.[1] : undefined;
  const expoRouter = c.router === 'expo-router';
  const after = expoRouter ? "router.replace('/')" : first && first !== 'Login' ? `navigation.reset({ index: 0, routes: [{ name: '${first}' }] })` : 'navigation.goBack()';
  const navImports = expoRouter
    ? "import { router } from 'expo-router';\n"
    : `import { useNavigation } from '@react-navigation/native';\nimport type { NativeStackNavigationProp } from '@react-navigation/native-stack';\n${c.navigatorFile ? `import type { RootStackParamList } from ${s(rel(page, c.navigatorFile))};\n` : ''}`;
  ws.write(
    page,
    `import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
${navImports}
import { useAuth } from ${s(rel(page, f('AuthContext.tsx')))};

export default function LoginScreen() {
  const { signIn } = useAuth();
${expoRouter ? '' : `  const navigation = useNavigation<NativeStackNavigationProp<${c.navigatorFile ? 'RootStackParamList' : 'Record<string, undefined>'}>>();\n`}  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!email.trim() || !password) return setError('Enter your email and password.');
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      ${after};
    } catch (e) {
      const status = (e as { status?: number; response?: { status?: number } }).status ?? (e as { response?: { status?: number } }).response?.status;
      setError(status === 401 || status === 400 ? 'That email and password do not match.' : 'Sign-in failed. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.screen}>
      <View style={styles.form}>
        <Text style={styles.title}>Sign in</Text>
        <Text style={styles.label}>Email</Text>
        <TextInput style={styles.input} value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="emailAddress" accessibilityLabel="Email" />
        <Text style={styles.label}>Password</Text>
        <TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" textContentType="password" accessibilityLabel="Password" onSubmitEditing={submit} />
        {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}
        <Pressable accessibilityRole="button" disabled={busy} onPress={submit} style={[styles.button, busy && styles.busy]}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in</Text>}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', padding: 24 },
  form: { gap: 8, width: '100%', maxWidth: 420, alignSelf: 'center' },
  title: { fontSize: 26, fontWeight: '700', marginBottom: 12 },
  label: { fontSize: 14, fontWeight: '600', marginTop: 8 },
  input: { minHeight: 48, borderWidth: 1, borderColor: '#ccc', borderRadius: 10, paddingHorizontal: 14, fontSize: 16 },
  error: { color: '#b3261e', marginTop: 8 },
  button: { minHeight: 48, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#3f51b5', marginTop: 16 },
  busy: { opacity: 0.7 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
`,
  );

  // Dependency.
  const pkgText = ws.read('package.json');
  const dep = expo ? ['expo-secure-store', '~14.0.0'] : ['react-native-keychain', '^9.2.2'];
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as { dependencies?: Record<string, string> };
      if (!pkg.dependencies?.[dep[0]]) {
        pkg.dependencies = Object.fromEntries(Object.entries({ ...(pkg.dependencies ?? {}), [dep[0]]: dep[1] }).sort(([a], [b]) => a.localeCompare(b)));
        const indent = /\n(\s+)"/.exec(pkgText)?.[1] ?? '  ';
        ws.write('package.json', `${JSON.stringify(pkg, null, indent)}\n`);
        summary.push(`package.json: ${dep[0]} (run npm install${expo ? ', then npx expo install --fix' : ''})`);
      }
    } catch {
      warnings.push(`Add ${dep[0]} to package.json.`);
    }
  }
  summary.push(`${f('tokenStore.ts')}, ${f('session.ts')}, ${f('AuthContext.tsx')}: secure token storage, sign-in calls, AuthProvider and useAuth()`, `${page}: the sign-in screen`, 'Show the login screen when useAuth().status is "signedOut" (for example, a conditional Stack.Screen).');
}

// ---------------------------------------------------------------------------
// Flutter

function flutterAuth(ws: Workspace, map: ProjectMap, page: string, o: Resolved, summary: string[], warnings: string[]): void {
  const c = map.conventions;
  const pkg = c.packageName || 'app';
  const dir = 'lib/core/auth';
  const f = (name: string) => `${dir}/${name}`;
  const uri = (file: string) => `package:${pkg}/${file.replace(/^lib\//, '')}`;
  const router = c.router === 'getx' || c.di === 'getx' || c.stateManagement === 'getx' ? 'getx' : c.router;

  ws.write(
    f('token_storage.dart'),
    `import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// The API tokens, in the Keychain (iOS) or the Keystore (Android), with an in-memory copy.
class TokenStorage {
  TokenStorage([FlutterSecureStorage? storage]) : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;
  String? _access;
  bool _loaded = false;

  static const _accessKey = 'access_token';
  static const _refreshKey = 'refresh_token';

  Future<String?> get accessToken async {
    if (!_loaded) {
      _access = await _storage.read(key: _accessKey);
      _loaded = true;
    }
    return _access;
  }

  Future<String?> get refreshToken => _storage.read(key: _refreshKey);

  Future<void> save({required String access, String? refresh}) async {
    _access = access;
    _loaded = true;
    await _storage.write(key: _accessKey, value: access);
    if (refresh != null) await _storage.write(key: _refreshKey, value: refresh);
  }

  Future<void> clear() async {
    _access = null;
    _loaded = true;
    await _storage.delete(key: _accessKey);
    await _storage.delete(key: _refreshKey);
  }
}

final tokenStorage = TokenStorage();
`,
  );

  ws.write(
    f('auth_service.dart'),
    `import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import '${uri(f('token_storage.dart'))}';

enum AuthStatus { unknown, signedOut, signedIn }

/// Signs in and out, and knows whether someone is signed in. The router listens to it.
/// Change the paths here if your API uses others.
class AuthService extends ChangeNotifier {
  AuthService(this._tokens) {
    _restore();
  }

  final TokenStorage _tokens;
  Dio? _dio;
  AuthStatus status = AuthStatus.unknown;
  Map<String, dynamic>? user;

  /// Called by attachAuth() with the app's Dio, so sign-in uses the same base URL and settings.
  void attach(Dio dio) => _dio = dio;

  /// True once the app's Dio exists (attachAuth ran).
  bool get attached => _dio != null;

  Dio get _api => _dio ?? (throw StateError('Call attachAuth(dio) where the app creates its Dio before signing in.'));

  Future<void> _restore() async {
    status = await _tokens.accessToken == null ? AuthStatus.signedOut : AuthStatus.signedIn;
    notifyListeners();
  }

  Future<void> signIn(String email, String password) async {
    final res = await _api.post<Map<String, dynamic>>(${dq(o.loginPath)}, data: {'email': email, 'password': password});
    final data = res.data ?? const {};
    final token = data[${dq(o.tokenField)}];
    if (token is! String || token.isEmpty) throw StateError('The login answer has no ${o.tokenField} field.');
    final refresh = data[${dq(o.refreshField)}];
    await _tokens.save(access: token, refresh: refresh is String ? refresh : null);
    try {
      user = (await _api.get<Map<String, dynamic>>(${dq(o.mePath)})).data;
    } on DioException {
      user = null;
    }
    status = AuthStatus.signedIn;
    notifyListeners();
  }

  Future<void> signOut() async {
    try {
      await _dio?.post<void>(${dq(o.logoutPath)});
    } on DioException {
      // Signed out on this device either way.
    }
    await expire();
  }

  /// The session ended (a 401 that could not be refreshed).
  Future<void> expire() async {
    await _tokens.clear();
    user = null;
    status = AuthStatus.signedOut;
    notifyListeners();
  }
}

final authService = AuthService(tokenStorage);
`,
  );

  const authPaths = [o.loginPath, ...(o.refreshPath ? [o.refreshPath] : [])];
  ws.write(
    f('auth_interceptor.dart'),
    `import 'package:dio/dio.dart';
import '${uri(f('auth_service.dart'))}';
import '${uri(f('token_storage.dart'))}';

/// Adds sign-in to a Dio instance: call it once where the app creates its Dio.
void attachAuth(Dio dio) {
  authService.attach(dio);
  dio.interceptors.add(AuthInterceptor(${o.refreshPath ? 'dio' : ''}));
}

/// Sends "Authorization: Bearer <token>". On a 401 it ${o.refreshPath ? 'refreshes the token once and repeats the request; if that fails, ' : ''}the session ends.
class AuthInterceptor extends QueuedInterceptor {
${o.refreshPath ? '  AuthInterceptor(this._dio);\n\n  /// Repeats the request after a token refresh.\n  final Dio _dio;\n' : ''}  static const _retried = 'auth_retried';
  static const _authPaths = [${authPaths.map((p) => dq(p)).join(', ')}];

  @override
  Future<void> onRequest(RequestOptions options, RequestInterceptorHandler handler) async {
    final token = await tokenStorage.accessToken;
    if (token != null) options.headers['Authorization'] = 'Bearer \$token';
    handler.next(options);
  }

  @override
  Future<void> onError(DioException err, ErrorInterceptorHandler handler) async {
    final request = err.requestOptions;
    if (err.response?.statusCode != 401 || _authPaths.any(request.path.startsWith) || request.extra[_retried] == true) {
      return handler.next(err);
    }
${
  o.refreshPath
    ? `    final refresh = await tokenStorage.refreshToken;
    if (refresh != null) {
      try {
        final plain = Dio(BaseOptions(baseUrl: _dio.options.baseUrl, headers: {'Accept': 'application/json'}));
        final res = await plain.post<Map<String, dynamic>>(${dq(o.refreshPath)}, data: {'refreshToken': refresh});
        final token = res.data?[${dq(o.tokenField)}];
        if (token is String) {
          final next = res.data?[${dq(o.refreshField)}];
          await tokenStorage.save(access: token, refresh: next is String ? next : refresh);
          request.extra[_retried] = true;
          return handler.resolve(await _dio.fetch<dynamic>(request));
        }
      } on DioException {
        // Falls through to sign out.
      }
    }
`
    : ''
}    await authService.expire();
    handler.next(err);
  }
}
`,
  );

  // Attach to the app's Dio.
  const net = c.networkFile ? ws.read(c.networkFile) : null;
  let attached = false;
  if (net && c.networkFile && !/attachAuth\(/.test(net)) {
    let t = net;
    if (/\n(\s*)return dio;/.test(t)) {
      t = t.replace(/\n(\s*)return dio;/, '\n$1attachAuth(dio);\n$1return dio;');
      attached = true;
    } else {
      const m = /\n(\s*)(final\s+)?(\w+)\s*=\s*Dio\(/.exec(t);
      if (m) {
        // `_dio = Dio(...)` in a constructor: attach right after the statement ends.
        const start = m.index + m[0].length;
        let depth = 1;
        let i = start;
        for (; i < t.length && depth; i++) {
          if (t[i] === '(') depth++;
          else if (t[i] === ')') depth--;
        }
        const semi = t.indexOf(';', i);
        if (semi !== -1) {
          t = `${t.slice(0, semi + 1)}\n${m[1]}attachAuth(${m[3]});${t.slice(semi + 1)}`;
          attached = true;
        }
      }
    }
    if (attached) {
      const line = `import '${uri(f('auth_interceptor.dart'))}';`;
      t = t.replace(/((?:^import [^\n]+\n)+)/m, (block: string) => `${block}${line}\n`);
      ws.write(c.networkFile, t);
      summary.push(`${c.networkFile}: attachAuth(dio) sends the token and handles 401`);
    }
  }
  if (!attached) warnings.push(`Call attachAuth(dio) (from ${f('auth_interceptor.dart')}) where the app creates its Dio; ${c.networkFile || 'the network file'} did not have a place devtool recognises.`);

  // The login page.
  const pageClass = /class (\w+) extends/.exec(ws.read(page) ?? '')?.[1] ?? 'LoginPage';
  const getxPages = router === 'getx' && c.routesFile && ws.read(c.routesFile) !== null && /\binitial\b/.test(ws.read(c.routesFile) ?? '') ? c.routesFile : '';
  const done = router === 'go_router' ? "context.go('/')" : router === 'getx' ? (getxPages ? 'Get.offAllNamed(AppPages.initial)' : "Get.offAllNamed('/')") : "Navigator.of(context).pushReplacementNamed('/')";
  const navImport = router === 'go_router' ? "import 'package:go_router/go_router.dart';\n" : router === 'getx' ? `import 'package:get/get.dart';\n${getxPages ? `import '${uri(getxPages)}';\n` : ''}` : '';
  // The app's Dio is often created lazily (a provider, get_it); signing in needs it, so the page creates it when it is not there yet.
  const netText = c.networkFile ? ws.read(c.networkFile) ?? '' : '';
  const ensure = /\bDio createDio\(/.test(netText) && attached ? `      if (!authService.attached) createDio();\n` : '';
  const ensureImport = ensure && c.networkFile ? `import '${uri(c.networkFile)}';\n` : '';
  ws.write(
    page,
    `import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
${navImport}${ensureImport}import '${uri(f('auth_service.dart'))}';

class ${pageClass} extends StatefulWidget {
  const ${pageClass}({super.key});

  @override
  State<${pageClass}> createState() => _${pageClass}State();
}

class _${pageClass}State extends State<${pageClass}> {
  final _form = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
${ensure}      await authService.signIn(_email.text.trim(), _password.text);
      if (mounted) ${done};
    } on DioException catch (e) {
      final status = e.response?.statusCode;
      setState(() => _error = status == 401 || status == 400 ? 'That email and password do not match.' : 'Sign-in failed. Check your connection and try again.');
    } catch (_) {
      setState(() => _error = 'Sign-in failed. Try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Sign in')),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Form(
              key: _form,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  TextFormField(
                    controller: _email,
                    decoration: const InputDecoration(labelText: 'Email'),
                    keyboardType: TextInputType.emailAddress,
                    autofillHints: const [AutofillHints.email],
                    validator: (v) => (v == null || !v.contains('@')) ? 'Enter your email address.' : null,
                  ),
                  const SizedBox(height: 16),
                  TextFormField(
                    controller: _password,
                    decoration: const InputDecoration(labelText: 'Password'),
                    obscureText: true,
                    autofillHints: const [AutofillHints.password],
                    onFieldSubmitted: (_) => _submit(),
                    validator: (v) => (v == null || v.isEmpty) ? 'Enter your password.' : null,
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 16),
                    Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
                  ],
                  const SizedBox(height: 24),
                  FilledButton(
                    onPressed: _busy ? null : _submit,
                    child: _busy ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('Sign in'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
`,
  );

  // go_router: signed-out visitors go to /login.
  if (router === 'go_router') {
    ws.write(
      f('auth_redirect.dart'),
      `import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';
import '${uri(f('auth_service.dart'))}';

/// Pages anyone may open without signing in.
const publicPaths = ['/login'];

/// go_router redirect: signed-out visitors go to /login; signed-in ones never see it.
String? authRedirect(BuildContext context, GoRouterState state) {
  if (authService.status == AuthStatus.unknown) return null;
  final atPublic = publicPaths.contains(state.matchedLocation);
  if (authService.status == AuthStatus.signedOut) return atPublic ? null : '/login';
  return state.matchedLocation == '/login' ? '/' : null;
}
`,
    );
    const routerFile = findGoRouterFile(ws, c);
    const rt = routerFile ? ws.read(routerFile) : null;
    if (routerFile && rt && /GoRouter\(\s*\n/.test(rt) && !/authRedirect/.test(rt)) {
      let t = rt.replace(/GoRouter\(\s*\n(\s*)/, (_m, indent: string) => `GoRouter(\n${indent}refreshListenable: authService,\n${indent}redirect: authRedirect,\n${indent}`);
      t = t.replace(/((?:^import [^\n]+\n)+)/m, (block: string) => `${block}import '${uri(f('auth_redirect.dart'))}';\nimport '${uri(f('auth_service.dart'))}';\n`);
      ws.write(routerFile, t);
      summary.push(`${routerFile}: go_router sends signed-out visitors to /login`);
    } else {
      warnings.push(`Add refreshListenable: authService and redirect: authRedirect (from ${f('auth_redirect.dart')}) to your GoRouter.`);
    }
  } else {
    warnings.push('This project does not use go_router, so pages are not guarded automatically: check authService.status before opening a page that needs sign-in.');
  }

  const pub = ws.read('pubspec.yaml');
  if (pub) {
    const r = addPubspecDeps(pub, ['flutter_secure_storage']);
    if (r.added.length) {
      ws.write('pubspec.yaml', r.text.replace(/flutter_secure_storage: any/, 'flutter_secure_storage: ^9.2.2'));
      summary.push('pubspec.yaml: flutter_secure_storage (run flutter pub get)');
    }
  }
  summary.push(`${f('token_storage.dart')}, ${f('auth_service.dart')}, ${f('auth_interceptor.dart')}: secure tokens, AuthService (signIn, signOut, status), the Dio interceptor`, `${page}: the sign-in page`);
}

function findGoRouterFile(ws: Workspace, c: Conventions): string | undefined {
  const candidates = [c.routesFile, 'lib/app/router.dart', 'lib/router.dart', 'lib/app_router.dart', 'lib/routes.dart', 'lib/main.dart', 'lib/app.dart'].filter((x): x is string => !!x);
  return candidates.find((p) => /GoRouter\(/.test(ws.read(p) ?? ''));
}

// ---------------------------------------------------------------------------
// Android

function androidAuth(ws: Workspace, map: ProjectMap, page: string, o: Resolved, summary: string[], warnings: string[]): void {
  const c = map.conventions;
  if (c.di !== 'hilt') throw new ToolError('not_supported', `auth add for Android needs Hilt (this project uses ${c.di || 'no DI library'}).`, 'Koin and manual DI are planned; for now add an OkHttp interceptor that sends the token by hand.');
  const pkg = c.namespace;
  if (!pkg || !c.srcDir) throw new ToolError('no_conventions', 'The app package or source folder is unknown.', 'Run devtool init first.');
  const base = `${c.srcDir}/${pkg.replace(/\./g, '/')}`;
  const dir = `${base}/data/auth`;
  const f = (name: string) => `${dir}/${name}`;

  ws.write(
    f('TokenStore.kt'),
    `package ${pkg}.data.auth

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/** The API tokens, encrypted with a key from the Android Keystore. */
@Singleton
class TokenStore @Inject constructor(@ApplicationContext context: Context) {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        "auth",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    var accessToken: String?
        get() = prefs.getString("access_token", null)
        set(value) = prefs.edit().putString("access_token", value).apply()

    fun clear() = prefs.edit().clear().apply()
}
`,
  );

  ws.write(
    f('AuthInterceptor.kt'),
    `package ${pkg}.data.auth

import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import okhttp3.Interceptor
import okhttp3.Response

/** Sends "Authorization: Bearer <token>"; a 401 clears the token and tells the app the session ended. */
@Singleton
class AuthInterceptor @Inject constructor(private val tokens: TokenStore) : Interceptor {
    private val _sessionExpired = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val sessionExpired: SharedFlow<Unit> = _sessionExpired

    override fun intercept(chain: Interceptor.Chain): Response {
        val token = tokens.accessToken
        val request = if (token != null) chain.request().newBuilder().header("Authorization", "Bearer $token").build() else chain.request()
        val response = chain.proceed(request)
        if (response.code == 401 && !request.url.encodedPath.endsWith(${ktString(o.loginPath.replace(/^\//, ''))})) {
            tokens.clear()
            _sessionExpired.tryEmit(Unit)
        }
        return response
    }
}
`,
  );

  ws.write(
    f('AuthApi.kt'),
    `package ${pkg}.data.auth

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST

@Serializable
data class LoginRequest(val email: String, val password: String)

@Serializable
data class LoginResponse(@SerialName(${ktString(o.tokenField)}) val token: String)

/** The sign-in endpoints. Change the paths here if your API uses others. */
interface AuthApi {
    @POST(${ktString(o.loginPath.replace(/^\//, ''))})
    suspend fun login(@Body body: LoginRequest): LoginResponse

    @GET(${ktString(o.mePath.replace(/^\//, ''))})
    suspend fun me(): JsonObject

    @POST(${ktString(o.logoutPath.replace(/^\//, ''))})
    suspend fun logout()
}
`,
  );

  ws.write(
    f('AuthRepository.kt'),
    `package ${pkg}.data.auth

import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

@Singleton
class AuthRepository @Inject constructor(
    private val api: AuthApi,
    private val tokens: TokenStore,
) {
    private val _signedIn = MutableStateFlow(tokens.accessToken != null)
    val signedIn: StateFlow<Boolean> = _signedIn

    suspend fun signIn(email: String, password: String) {
        tokens.accessToken = api.login(LoginRequest(email, password)).token
        _signedIn.value = true
    }

    suspend fun signOut() {
        runCatching { api.logout() }
        tokens.clear()
        _signedIn.value = false
    }

    fun sessionEnded() {
        tokens.clear()
        _signedIn.value = false
    }
}
`,
  );

  // NetworkModule: the interceptor on OkHttp, and a provider for AuthApi.
  const di = c.diFile ? ws.read(c.diFile) : null;
  if (di && c.diFile && /fun provideOkHttpClient\(\)/.test(di) && /OkHttpClient\.Builder\(\)/.test(di)) {
    let t = di.replace(/fun provideOkHttpClient\(\)/, 'fun provideOkHttpClient(authInterceptor: AuthInterceptor)');
    t = t.replace(/OkHttpClient\.Builder\(\)/, 'OkHttpClient.Builder()\n            .addInterceptor(authInterceptor)');
    if (!/provideAuthApi/.test(t)) {
      const end = t.lastIndexOf('}');
      t = `${t.slice(0, end).replace(/\s*$/, '\n')}\n    @Provides\n    @Singleton\n    fun provideAuthApi(retrofit: Retrofit): AuthApi = retrofit.create(AuthApi::class.java)\n}\n`;
    }
    t = t.replace(/(\nimport [^\n]+)(?![\s\S]*\nimport )/, `$1\nimport ${pkg}.data.auth.AuthApi\nimport ${pkg}.data.auth.AuthInterceptor`);
    t = sortKotlinImports(t);
    ws.write(c.diFile, t);
    summary.push(`${c.diFile}: AuthInterceptor on OkHttp, and AuthApi`);
  } else {
    warnings.push(`Add AuthInterceptor to your OkHttpClient and provide AuthApi in ${c.diFile || 'your Hilt module'}; it does not have the shape devtool writes.`);
  }

  // The login screen and its ViewModel.
  const screenName = /fun (\w+)\(/.exec(ws.read(page) ?? '')?.[1] ?? 'LoginScreen';
  const screenPkg = /^package ([\w.]+)/m.exec(ws.read(page) ?? '')?.[1] ?? `${pkg}.ui.screens`;
  ws.write(
    page,
    `package ${screenPkg}

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel

@Composable
fun ${screenName}(onSignedIn: () -> Unit = {}, viewModel: LoginViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()
    LaunchedEffect(state.signedIn) { if (state.signedIn) onSignedIn() }
    Scaffold { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        ) {
            Text("Sign in", style = MaterialTheme.typography.headlineMedium)
            OutlinedTextField(
                value = state.email,
                onValueChange = viewModel::onEmail,
                label = { Text("Email") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = state.password,
                onValueChange = viewModel::onPassword,
                label = { Text("Password") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                modifier = Modifier.fillMaxWidth(),
            )
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(onClick = viewModel::submit, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) {
                if (state.busy) CircularProgressIndicator(Modifier.padding(2.dp)) else Text("Sign in")
            }
        }
    }
}
`,
  );
  const vmFile = posix.join(posix.dirname(page), 'LoginViewModel.kt');
  ws.write(
    vmFile,
    `package ${screenPkg}

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import ${pkg}.data.auth.AuthRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import retrofit2.HttpException

data class LoginState(
    val email: String = "",
    val password: String = "",
    val busy: Boolean = false,
    val error: String? = null,
    val signedIn: Boolean = false,
)

@HiltViewModel
class LoginViewModel @Inject constructor(private val auth: AuthRepository) : ViewModel() {
    private val _state = MutableStateFlow(LoginState())
    val state: StateFlow<LoginState> = _state

    fun onEmail(value: String) = _state.update { it.copy(email = value, error = null) }

    fun onPassword(value: String) = _state.update { it.copy(password = value, error = null) }

    fun submit() {
        val s = _state.value
        if (!s.email.contains('@') || s.password.isEmpty()) {
            _state.update { it.copy(error = "Enter your email and password.") }
            return
        }
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                auth.signIn(s.email.trim(), s.password)
                _state.update { it.copy(busy = false, signedIn = true) }
            } catch (e: HttpException) {
                val message = if (e.code() == 401 || e.code() == 400) "That email and password do not match." else "Sign-in failed (\${e.code()})."
                _state.update { it.copy(busy = false, error = message) }
            } catch (e: Exception) {
                _state.update { it.copy(busy = false, error = "Sign-in failed. Check your connection and try again.") }
            }
        }
    }
}
`,
  );
  // NavHost: after sign-in, go to the start screen and drop the login screen from the back stack.
  const nav = c.navFile ? ws.read(c.navFile) : null;
  if (nav && c.navFile) {
    const start = /startDestination = "([^"]+)"/.exec(nav)?.[1];
    const t = nav.replace(new RegExp(`(\\n\\s*)${screenName}\\(\\)`), (_m, lead: string) => `${lead}${screenName}(onSignedIn = { navController.navigate("${start && start !== 'login' ? start : 'home'}") { popUpTo("login") { inclusive = true } } })`);
    if (t !== nav) ws.write(c.navFile, t);
  }

  // Dependency: androidx.security:security-crypto.
  const catalogPath = c.versionCatalog;
  const gradlePath = `${c.module || 'app'}/build.gradle.kts`;
  const gradle = ws.read(gradlePath);
  if (catalogPath && ws.read(catalogPath) !== null && gradle) {
    let toml = ws.read(catalogPath)!;
    toml = tomlAdd(toml, 'versions', [['security-crypto', '"1.1.0-alpha06"']]);
    toml = tomlAdd(toml, 'libraries', [['androidx-security-crypto', '{ group = "androidx.security", name = "security-crypto", version.ref = "security-crypto" }']]);
    ws.write(catalogPath, toml);
    ws.write(gradlePath, gradleBlockAdd(gradle, 'dependencies', ['implementation(libs.androidx.security.crypto)']));
    summary.push(`${catalogPath} and ${gradlePath}: androidx.security:security-crypto`);
  } else if (gradle) {
    ws.write(gradlePath, gradleBlockAdd(gradle, 'dependencies', ['implementation("androidx.security:security-crypto:1.1.0-alpha06")']));
  }
  summary.push(`${dir}: TokenStore (encrypted), AuthInterceptor, AuthApi, AuthRepository (signIn, signOut, signedIn)`, `${page} and ${vmFile}: the sign-in screen`, 'Collect AuthInterceptor.sessionExpired (or AuthRepository.signedIn) to send the user to the login screen when the session ends.');
}

function sortKotlinImports(text: string): string {
  return text.replace(/((?:^import [^\n]+\n)+)/m, (block: string) => {
    const lines = [...new Set(block.trim().split('\n'))].sort();
    return `${lines.join('\n')}\n`;
  });
}
