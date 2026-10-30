// React Native adapter (Expo or the React Native CLI). API code is TypeScript
// like in Next.js, so scanning and generating endpoints reuse the Next.js
// adapter: fetch (directly or through a helper), axios, TanStack Query hooks,
// interfaces for models. On top of that this adapter knows React Native's own
// parts: the flavor (Expo or bare), navigation (React Navigation or Expo
// Router), the screens folder, and the config file that holds the API URL.

import { join } from 'node:path';
import { exists, isDir, readJson, readText, walk } from '../core/fsutil.ts';
import type { Adapter, Conventions, ProjectMap, RouteInfo } from '../core/types.ts';
import { NEXT_CONVENTION_DOCS, nextjsAdapter } from './nextjs.ts';
import { mostCommon } from './nextjsScan.ts';
import { planReactNativeSetup, reactNativeArchitectures } from './reactNativeSetup.ts';

export const RN_VERSION = '0.1.0';

const { appDir: _appDir, ...SHARED_DOCS } = NEXT_CONVENTION_DOCS;
export const RN_CONVENTION_DOCS: Record<string, string> = {
  ...SHARED_DOCS,
  flavor: 'expo or bare (React Native CLI)',
  router: 'react-navigation, expo-router or none',
  screensFolder: 'where screen components live',
  navigatorFile: 'the React Navigation stack that lists the screens (react-navigation only)',
  routerDir: 'the Expo Router app folder (expo-router only)',
  configFile: 'file that exports API_URL and USE_MOCKS',
};

interface Pkg {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const NAVIGATOR = /create(?:NativeStack|Stack|BottomTab|Drawer)Navigator\s*(?:<[^>]*>)?\s*\(/;

/** React Navigation screens: <Stack.Screen name="Orders" component={OrdersScreen} />. */
function navigationRoutes(file: string, text: string): RouteInfo[] {
  const out: RouteInfo[] = [];
  for (const m of text.matchAll(/<\w+\.Screen\b([^>]*?)\/?>/g)) {
    const name = /\bname\s*=\s*["'{]\s*["']?([\w-]+)/.exec(m[1])?.[1];
    if (!name) continue;
    const params = new RegExp(`\\b${name}\\s*:\\s*\\{([^}]*)\\}`).exec(text)?.[1]?.split(/[;,]/).map((p) => p.split(':')[0].replace(/\?$/, '').trim()).filter(Boolean) ?? [];
    out.push({ name, path: name, params, file });
  }
  return out;
}

/** Expo Router: every file under app/ except layouts is a route; [id] segments are parameters. */
function expoRoutes(routerDir: string, files: string[]): RouteInfo[] {
  return files
    .filter((f) => f.startsWith(`${routerDir}/`) && /\.(tsx|jsx|ts|js)$/.test(f) && !/(^|\/)(_layout|\+[\w-]+)\.\w+$/.test(f))
    .map((f) => {
      const segs = f.slice(routerDir.length + 1).replace(/\.\w+$/, '').split('/').filter((s) => !/^\(.*\)$/.test(s));
      if (segs[segs.length - 1] === 'index') segs.pop();
      const params = segs.filter((s) => s.startsWith('[')).map((s) => s.replace(/[[\].]/g, ''));
      const path = '/' + segs.map((s) => (s.startsWith('[') ? `{${s.replace(/[[\].]/g, '')}}` : s)).join('/');
      return { name: segs.filter((s) => !s.startsWith('[')).join('-') || 'home', path: path === '/' ? '/' : path, params, file: f };
    });
}

async function scan(root: string, configConventions: Conventions): Promise<ProjectMap> {
  const map = await nextjsAdapter.scan(root, configConventions);
  map.framework = 'react-native';
  map.adapter = `react-native@${RN_VERSION}`;
  map.notes = map.notes.filter((n) => !/app folder|Pages Router/.test(n));
  map.routes = [];
  const pkg = readJson<Pkg>(join(root, 'package.json')) ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const files = walk(root, '.', { exts: ['.ts', '.tsx', '.js', '.jsx'], extraIgnored: ['android', 'ios'] });
  const text = (f: string) => readText(join(root, f)) ?? '';
  const src = isDir(join(root, 'src')) ? 'src/' : '';
  const c: Conventions = {};
  c.flavor = deps.expo ? 'expo' : 'bare';
  const routerDir = isDir(join(root, 'src/app')) ? 'src/app' : isDir(join(root, 'app')) ? 'app' : '';
  const navigatorFile = files.find((f) => NAVIGATOR.test(text(f)) && /\.Navigator\b/.test(text(f))) ?? '';
  c.router = deps['expo-router'] && routerDir ? 'expo-router' : deps['@react-navigation/native'] ? 'react-navigation' : 'none';
  c.routerDir = c.router === 'expo-router' ? routerDir : '';
  c.navigatorFile = c.router === 'react-navigation' ? navigatorFile || `${src}navigation/RootNavigator.tsx` : '';
  const screenFiles = files.filter((f) => /Screen\.(tsx|jsx)$/.test(f));
  c.screensFolder = mostCommon(screenFiles.map((f) => f.slice(0, f.lastIndexOf('/'))), `${src}screens`);
  c.configFile = files.find((f) => /export\s+const\s+API_URL\b/.test(text(f))) ?? `${src}config/env.ts`;
  // An API folder that was only guessed follows React Native layouts (src/api), not Next.js (lib/api).
  const guessed = !map.endpoints.length && !configConventions.apiFolder && !exists(join(root, map.conventions.apiFolder ?? ''));
  if (guessed) c.apiFolder = `${src}api`;
  if (!map.models.length && !configConventions.modelsFolder && !exists(join(root, map.conventions.modelsFolder ?? ''))) c.modelsFolder = `${src}types`;
  if (map.conventions.dataFetching === 'react-query' && !configConventions.hooksFolder && !exists(join(root, map.conventions.hooksFolder ?? ''))) c.hooksFolder = `${src}hooks`;
  const conv = (map.conventions = { ...map.conventions, ...c, ...configConventions });
  delete conv.appDir;

  // The API URL in the config file (a literal, or the fallback after ??) is a base URL too.
  const cfgText = conv.configFile ? readText(join(root, conv.configFile)) ?? '' : '';
  const cfgUrl = /export\s+const\s+API_URL\s*=\s*(?:[^'"\n]*\?\?\s*)?['"](https?:\/\/[^'"]+)['"]/.exec(cfgText)?.[1];
  if (cfgUrl && !map.baseUrls.some((b) => b.value === cfgUrl)) map.baseUrls.push({ name: 'API_URL', value: cfgUrl, file: conv.configFile });

  if (conv.router === 'expo-router' && conv.routerDir) map.routes = expoRoutes(conv.routerDir, files);
  else if (conv.router === 'react-navigation') for (const f of files.filter((x) => /\.Screen\b/.test(text(x)))) map.routes.push(...navigationRoutes(f, text(f)));
  map.routes.sort((a, b) => a.path.localeCompare(b.path));
  if (conv.router === 'none') map.notes.push('No navigation library found; screen add and route add need React Navigation or Expo Router (codz setup adds React Navigation).');
  return map;
}

export const reactNativeAdapter: Adapter = {
  id: 'react-native',
  version: RN_VERSION,
  capabilities: { explain: true, apiAdd: true },
  supportedSetup: 'React Native (Expo or React Native CLI), TypeScript, fetch (directly or through a helper) or axios, optionally TanStack Query; React Navigation or Expo Router.',
  scan,
  planEndpoint: nextjsAdapter.planEndpoint,
  architectures: reactNativeArchitectures,
  planSetup: planReactNativeSetup,
  afterSetup(root) {
    return exists(join(root, 'package.json')) ? { cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['install'], label: 'npm install' } : null;
  },
  formatCommand: nextjsAdapter.formatCommand,
  verifyCommand: nextjsAdapter.verifyCommand,
};
