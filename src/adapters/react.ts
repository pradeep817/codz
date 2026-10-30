// React web adapter (Vite or Create React App, TypeScript), for apps that are
// not Next.js. API code is TypeScript like in Next.js, so scanning and writing
// endpoints reuse the Next.js adapter: fetch (directly or through a helper),
// axios, TanStack Query hooks, interfaces for models. On top of that this
// adapter knows the web app's own parts: the bundler (for the env variable
// prefix), React Router (a <Routes> tree or createBrowserRouter), the pages
// folder, and the config file that holds the API URL.

import { join } from 'node:path';
import { exists, isDir, readJson, readText, walk } from '../core/fsutil.ts';
import type { Adapter, Conventions, ProjectMap, RouteInfo } from '../core/types.ts';
import { NEXT_CONVENTION_DOCS, nextjsAdapter } from './nextjs.ts';
import { mostCommon } from './nextjsScan.ts';
import { planReactSetup, reactArchitectures } from './reactSetup.ts';

export const REACT_VERSION = '0.1.0';

const { appDir: _appDir, ...SHARED_DOCS } = NEXT_CONVENTION_DOCS;
export const REACT_CONVENTION_DOCS: Record<string, string> = {
  ...SHARED_DOCS,
  bundler: 'vite or cra (Create React App): decides the env variable prefix',
  router: 'react-router or none',
  routerStyle: 'jsx (<Routes><Route .../></Routes>) or data (createBrowserRouter([...]))',
  routerFile: 'the file that lists the routes',
  pagesFolder: 'where page components live',
  configFile: 'file that exports API_URL',
};

interface Pkg {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** <Route path="/team/:teamId" element={<TeamPage />} /> and { path: '/x', element: <X /> }. */
function reactRoutes(file: string, text: string): RouteInfo[] {
  const out: RouteInfo[] = [];
  const add = (path: string, comp: string) => out.push({ name: comp.replace(/Page$/, '') || 'home', path: path.replace(/:(\w+)/g, '{$1}'), params: [...path.matchAll(/:(\w+)/g)].map((m) => m[1]), file });
  for (const m of text.matchAll(/<Route\b[^>]*?\bpath=["']([^"']+)["'][^>]*?element=\{<(\w+)/g)) add(m[1], m[2]);
  for (const m of text.matchAll(/\{\s*path:\s*["']([^"']+)["']\s*,\s*element:\s*<(\w+)/g)) add(m[1], m[2]);
  return out;
}

async function scan(root: string, configConventions: Conventions): Promise<ProjectMap> {
  const map = await nextjsAdapter.scan(root, configConventions);
  map.framework = 'react';
  map.adapter = `react@${REACT_VERSION}`;
  map.notes = map.notes.filter((n) => !/app folder|Pages Router|App Router/.test(n));
  map.routes = [];
  const pkg = readJson<Pkg>(join(root, 'package.json')) ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const files = walk(root, '.', { exts: ['.ts', '.tsx', '.js', '.jsx'], extraIgnored: ['public', 'build', 'dist'] });
  const text = (f: string) => readText(join(root, f)) ?? '';
  const src = isDir(join(root, 'src')) ? 'src/' : '';
  const c: Conventions = {};
  c.bundler = deps['react-scripts'] ? 'cra' : 'vite';
  const routerFile = files.find((f) => /createBrowserRouter\s*\(/.test(text(f))) ?? files.find((f) => /<Routes\b/.test(text(f))) ?? '';
  c.router = deps['react-router-dom'] || deps['react-router'] ? 'react-router' : 'none';
  c.routerFile = c.router === 'react-router' ? routerFile || `${src}router.tsx` : '';
  c.routerStyle = routerFile && /createBrowserRouter\s*\(/.test(text(routerFile)) ? 'data' : c.router === 'react-router' && routerFile ? 'jsx' : 'data';
  const pageFiles = files.filter((f) => /(Page|View)\.(tsx|jsx)$/.test(f));
  c.pagesFolder = mostCommon(pageFiles.map((f) => f.slice(0, f.lastIndexOf('/'))), `${src}pages`);
  c.configFile = files.find((f) => /export\s+const\s+API_URL\b/.test(text(f))) ?? `${src}config/env.ts`;
  // A guessed API folder follows web-app layouts (src/api), not Next.js (lib/api).
  if (!map.endpoints.length && !configConventions.apiFolder && !exists(join(root, map.conventions.apiFolder ?? ''))) c.apiFolder = `${src}api`;
  if (!map.models.length && !configConventions.modelsFolder && !exists(join(root, map.conventions.modelsFolder ?? ''))) c.modelsFolder = `${src}types`;
  if (map.conventions.dataFetching === 'react-query' && !configConventions.hooksFolder && !exists(join(root, map.conventions.hooksFolder ?? ''))) c.hooksFolder = `${src}hooks`;
  const conv = (map.conventions = { ...map.conventions, ...c, ...configConventions });
  delete conv.appDir;

  // The API URL in the config file (a literal, or the fallback after ??) is a base URL too.
  const cfgText = conv.configFile ? readText(join(root, conv.configFile)) ?? '' : '';
  const cfgUrl = /export\s+const\s+API_URL\s*=\s*(?:[^'"\n]*\?\?\s*)?['"](https?:\/\/[^'"]+)['"]/.exec(cfgText)?.[1];
  if (cfgUrl && !map.baseUrls.some((b) => b.value === cfgUrl)) map.baseUrls.push({ name: 'API_URL', value: cfgUrl, file: conv.configFile });

  if (conv.routerFile && exists(join(root, conv.routerFile))) map.routes = reactRoutes(conv.routerFile, text(conv.routerFile));
  map.routes.sort((a, b) => a.path.localeCompare(b.path));
  if (conv.router === 'none') map.notes.push('No React Router found; screen add and route add need it (devtool setup adds React Router).');
  return map;
}

export const reactAdapter: Adapter = {
  id: 'react',
  version: REACT_VERSION,
  capabilities: { explain: true, apiAdd: true },
  supportedSetup: 'React web apps (Vite or Create React App), TypeScript, fetch (directly or through a helper) or axios, optionally TanStack Query; React Router.',
  scan,
  planEndpoint: nextjsAdapter.planEndpoint,
  architectures: reactArchitectures,
  planSetup: planReactSetup,
  afterSetup(root) {
    return exists(join(root, 'package.json')) ? { cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['install'], label: 'npm install' } : null;
  },
  formatCommand: nextjsAdapter.formatCommand,
  verifyCommand: nextjsAdapter.verifyCommand,
};
