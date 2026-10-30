// React web `setup`: an API layer (and React Router, when there is none) for a
// Vite or Create React App project that has neither yet.
//
//   fetch-helper        src/api/client.ts with apiFetch<T>() and ApiError
//   axios               src/api/client.ts exporting an axios instance
//   axios-react-query   the axios instance plus TanStack Query (QueryClientProvider)
//
// The API URL lives in src/config/env.ts, read from VITE_API_URL (Vite) or
// REACT_APP_API_URL (Create React App). Without a router, React Router's
// createBrowserRouter is added in src/router.tsx with a Home page, and App
// renders it, so screen add works right away.

import { join } from 'node:path';
import { readJson, readText } from '../core/fsutil.ts';
import { ToolError, type AdapterContext, type ArchitectureOption, type Conventions, type ProjectMap, type SetupChoice, type SetupPlan } from '../core/types.ts';
import { axiosClient, fetchClient } from './reactNativeSetup.ts';

/** Versions known to work with the generated code (React 18/19). */
const PACKAGES: Record<string, string> = {
  axios: '^1.7.7',
  '@tanstack/react-query': '^5.59.0',
  'react-router-dom': '^6.28.0',
};

export function reactArchitectures(map: ProjectMap): ArchitectureOption[] {
  const c = map.conventions;
  if (map.endpoints.length > 0 || (c.httpHelper && c.httpHelper !== 'fetch') || c.http === 'axios') return [];
  return [
    { id: 'fetch-helper', label: 'Fetch helper', description: 'src/api/client.ts with apiFetch<T>() and ApiError; API URL in src/config/env.ts', recommended: true },
    { id: 'axios', label: 'axios', description: 'An axios instance in src/api/client.ts; API functions call it', recommended: false },
    { id: 'axios-react-query', label: 'axios + TanStack Query', description: 'The axios instance, plus a query hook for every endpoint and QueryClientProvider around the app', recommended: false },
  ];
}

function envFile(cra: boolean, baseUrl: string, q: string, semi: string): string {
  const v = cra ? 'process.env.REACT_APP_API_URL' : 'import.meta.env.VITE_API_URL';
  return [`// App settings, read from .env at build time (${cra ? 'REACT_APP_*' : 'VITE_*'} variables).`, `export const API_URL: string = ${v} ?? ${q}${baseUrl}${q}${semi}`, ''].join('\n');
}

function routerFile(q: string, semi: string): string {
  return [
    `import { createBrowserRouter } from ${q}react-router-dom${q}${semi}`,
    `import HomePage from ${q}./pages/HomePage${q}${semi}`,
    '',
    '/** Every page and its path. codz route add and screen add add entries here. */',
    'export const router = createBrowserRouter([',
    `  { path: ${q}/${q}, element: <HomePage /> },`,
    `])${semi}`,
    '',
  ].join('\n');
}

function homePage(semi: string): string {
  return ['export default function HomePage() {', '  return (', '    <main>', '      <h1>Home</h1>', '    </main>', `  )${semi}`, '}', ''].join('\n');
}

function appFile(nav: boolean, query: boolean, q: string, semi: string): string {
  const imports = [
    ...(nav ? [`import { RouterProvider } from ${q}react-router-dom${q}${semi}`] : []),
    ...(query ? [`import { QueryClient, QueryClientProvider } from ${q}@tanstack/react-query${q}${semi}`] : []),
    ...(nav ? [`import { router } from ${q}./router${q}${semi}`] : []),
  ];
  let body = nav ? '<RouterProvider router={router} />' : '<main>\n      <h1>Home</h1>\n    </main>';
  if (query) body = `<QueryClientProvider client={queryClient}>\n      ${body.replace(/\n/g, '\n  ')}\n    </QueryClientProvider>`;
  return [...imports, '', ...(query ? [`const queryClient = new QueryClient()${semi}`, ''] : []), 'export default function App() {', '  return (', `    ${body}`, `  )${semi}`, '}', ''].join('\n');
}

export function planReactSetup(ctx: AdapterContext, choice: SetupChoice): SetupPlan {
  const { root, map } = ctx;
  if (!['fetch-helper', 'axios', 'axios-react-query'].includes(choice.architecture)) throw new ToolError('bad_args', `Unknown architecture "${choice.architecture}". Choose fetch-helper, axios or axios-react-query.`);
  const c0 = map.conventions;
  const cra = c0.bundler === 'cra';
  const src = 'src';
  const q = c0.quote === 'double' ? '"' : "'";
  const semi = c0.semicolons === 'false' ? '' : ';';
  const baseUrl = choice.baseUrl || 'https://api.example.com';
  const files = new Map<string, string>();
  const rewrites: string[] = [];
  const summary: string[] = [];
  const warnings: string[] = [];
  if (!choice.baseUrl) warnings.push(`No base URL was given, so ${src}/config/env.ts uses https://api.example.com. Change it there or in .env before calling the API.`);
  const read = (p: string) => readText(join(root, p));
  const create = (path: string, content: string, what: string) => {
    if (read(path) !== null) throw new ToolError('file_exists', `${path} already exists, so setup stopped without changing anything.`, 'Remove or rename it, or set up the project by hand and run codz init again.');
    files.set(path, content);
    summary.push(`Create ${path}: ${what}`);
  };
  const axios = choice.architecture !== 'fetch-helper';
  const query = choice.architecture === 'axios-react-query';
  const nav = c0.router === 'none' || !c0.router;
  const envVar = cra ? 'REACT_APP_API_URL' : 'VITE_API_URL';

  create(`${src}/config/env.ts`, envFile(cra, baseUrl, q, semi), `API_URL from ${envVar}`);
  create(`${src}/api/client.ts`, axios ? axiosClient(q, semi) : fetchClient(q, semi), axios ? 'the axios instance (baseURL from API_URL)' : 'apiFetch<T>() and ApiError');
  if (!axios) create(`${src}/api/index.ts`, `export * from ${q}./client${q}${semi}\n`, 'exports every API file');
  const env = read('.env.example');
  if (!env || !env.includes(envVar)) {
    files.set('.env.example', `${env ? env.replace(/\s*$/, '\n') : ''}${envVar}=${baseUrl}\n`);
    summary.push(`${env ? 'Update' : 'Create'} .env.example: ${envVar}`);
  }
  if (!cra && read(`${src}/vite-env.d.ts`) === null) {
    files.set(`${src}/vite-env.d.ts`, '/// <reference types="vite/client" />\n');
    summary.push(`Create ${src}/vite-env.d.ts: types for import.meta.env`);
  }
  if (nav) {
    create(`${src}/router.tsx`, routerFile(q, semi), 'React Router (createBrowserRouter) with the Home page');
    create(`${src}/pages/HomePage.tsx`, homePage(semi), 'the first page');
  }
  if (nav || query) {
    const app = [`${src}/App.tsx`, `${src}/App.jsx`, `${src}/App.js`].find((f) => read(f) !== null) ?? `${src}/App.tsx`;
    files.set(app, appFile(nav, query, q, semi));
    rewrites.push(app); // replaced on purpose; the previous App is in codz undo
    summary.push(`${read(app) === null ? 'Create' : 'Replace'} ${app}: ${[nav && 'RouterProvider with the router', query && 'QueryClientProvider'].filter(Boolean).join(' and ')}${read(app) !== null ? ' (the previous App is in codz undo)' : ''}`);
  }

  // Dependencies.
  const pkgText = read('package.json');
  let dependenciesChanged = false;
  if (pkgText !== null) {
    const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(join(root, 'package.json')) ?? {};
    const want = [...(axios ? ['axios'] : []), ...(query ? ['@tanstack/react-query'] : []), ...(nav ? ['react-router-dom'] : [])];
    const missing = want.filter((p) => !pkg.dependencies?.[p] && !pkg.devDependencies?.[p]);
    if (missing.length) {
      const parsed = JSON.parse(pkgText);
      parsed.dependencies = { ...parsed.dependencies };
      for (const p of missing) parsed.dependencies[p] = PACKAGES[p];
      parsed.dependencies = Object.fromEntries(Object.entries(parsed.dependencies).sort(([a], [b]) => a.localeCompare(b)));
      files.set('package.json', JSON.stringify(parsed, null, 2) + '\n');
      summary.push(`Update package.json: add ${missing.join(', ')}`);
      dependenciesChanged = true;
    }
  }

  const conventions: Conventions = {
    ...c0,
    http: axios ? 'axios' : 'fetch',
    httpHelper: axios ? 'fetch' : 'apiFetch',
    httpHelperFile: axios ? '' : `${src}/api/client.ts`,
    apiFolder: `${src}/api`,
    modelsFolder: `${src}/types`,
    modelsLayout: 'per-file',
    configFile: `${src}/config/env.ts`,
    pagesFolder: `${src}/pages`,
    ...(axios ? { axiosInstance: 'api', axiosInstanceFile: `${src}/api/client.ts` } : {}),
    ...(query ? { dataFetching: 'react-query', hooksFolder: `${src}/hooks` } : {}),
    ...(nav ? { router: 'react-router', routerFile: `${src}/router.tsx`, routerStyle: 'data' } : {}),
  };
  if (!axios) for (const k of ['axiosInstance', 'axiosInstanceFile']) delete conventions[k];
  delete conventions.baseUrlEnv;
  summary.push(`Save conventions: API functions in ${src}/api, interfaces in ${src}/types, pages in ${src}/pages`);
  return { files, summary, warnings, generated: [], conventions, dependenciesChanged, rewrites };
}
