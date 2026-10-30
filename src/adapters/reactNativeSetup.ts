// React Native `setup`: an API layer (and navigation, when there is none) for
// a project that has neither yet.
//
//   fetch-helper        src/api/client.ts with apiFetch<T>() and ApiError
//   axios               src/api/client.ts exporting an axios instance
//   axios-react-query   the axios instance plus TanStack Query (QueryClientProvider)
//
// The API URL and the mocks switch live in src/config/env.ts: read from
// EXPO_PUBLIC_API_URL in Expo, a constant in the React Native CLI (where
// react-native-config is the usual next step). Without navigation, React
// Navigation's native stack is added with a Home screen, so screen add works.

import { join } from 'node:path';
import { readJson, readText } from '../core/fsutil.ts';
import { ToolError, type AdapterContext, type ArchitectureOption, type Conventions, type ProjectMap, type SetupChoice, type SetupPlan } from '../core/types.ts';

/** Versions known to work with the generated code (React Native 0.76+ / Expo SDK 52+). */
const PACKAGES: Record<string, string> = {
  axios: '^1.7.7',
  '@tanstack/react-query': '^5.59.0',
  '@react-navigation/native': '^7.0.0',
  '@react-navigation/native-stack': '^7.0.0',
  'react-native-screens': '^4.0.0',
  'react-native-safe-area-context': '^4.12.0',
};

export function reactNativeArchitectures(map: ProjectMap): ArchitectureOption[] {
  const c = map.conventions;
  if (map.endpoints.length > 0 || (c.httpHelper && c.httpHelper !== 'fetch') || c.http === 'axios') return [];
  return [
    { id: 'fetch-helper', label: 'Fetch helper', description: 'src/api/client.ts with apiFetch<T>() and ApiError; API URL in src/config/env.ts', recommended: true },
    { id: 'axios', label: 'axios', description: 'An axios instance in src/api/client.ts; API functions call it', recommended: false },
    { id: 'axios-react-query', label: 'axios + TanStack Query', description: 'The axios instance, plus a query hook for every endpoint and QueryClientProvider around the app', recommended: false },
  ];
}

function envFile(expo: boolean, baseUrl: string, q: string, semi: string): string {
  const L = expo
    ? [
        '// App settings. Expo reads EXPO_PUBLIC_* variables from .env at build time.',
        `export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? ${q}${baseUrl}${q}${semi}`,
        '',
        '/** Answer API calls from mocks (devtool mock add). Set EXPO_PUBLIC_USE_MOCKS=true in .env. */',
        `export const USE_MOCKS = process.env.EXPO_PUBLIC_USE_MOCKS === ${q}true${q}${semi}`,
      ]
    : [
        '// App settings. For per-build values, move these to react-native-config.',
        `export const API_URL = ${q}${baseUrl}${q}${semi}`,
        '',
        '/** Answer API calls from mocks (devtool mock add). */',
        `export const USE_MOCKS = false${semi}`,
      ];
  return L.join('\n') + '\n';
}

export function fetchClient(q: string, semi: string): string {
  return [
    `import { API_URL } from ${q}../config/env${q}${semi}`,
    '',
    '/** Thrown when the API answers with a status outside 200-299. */',
    'export class ApiError extends Error {',
    `  status: number${semi}`,
    '',
    '  constructor(status: number, message: string) {',
    `    super(message)${semi}`,
    `    this.status = status${semi}`,
    '  }',
    '}',
    '',
    '/** Calls the API and parses the JSON response. Add auth headers here. */',
    'export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {',
    '  const res = await fetch(`${API_URL}${path}`, {',
    '    ...init,',
    `    headers: { ${q}Content-Type${q}: ${q}application/json${q}, ...init.headers },`,
    `  })${semi}`,
    `  if (!res.ok) throw new ApiError(res.status, await res.text())${semi}`,
    `  if (res.status === 204) return undefined as T${semi}`,
    `  return (await res.json()) as T${semi}`,
    '}',
    '',
  ].join('\n');
}

export function axiosClient(q: string, semi: string): string {
  return [
    `import axios from ${q}axios${q}${semi}`,
    `import { API_URL } from ${q}../config/env${q}${semi}`,
    '',
    '/** The axios instance every API function uses. Add auth headers with an interceptor. */',
    'export const api = axios.create({',
    '  baseURL: API_URL,',
    '  timeout: 20000,',
    `  headers: { ${q}Content-Type${q}: ${q}application/json${q} },`,
    `})${semi}`,
    '',
  ].join('\n');
}

function navigator(q: string, semi: string): string {
  return [
    `import { createNativeStackNavigator } from ${q}@react-navigation/native-stack${q}${semi}`,
    `import HomeScreen from ${q}../screens/HomeScreen${q}${semi}`,
    '',
    '/** Every screen and its parameters. devtool route add and screen add add entries here. */',
    'export type RootStackParamList = {',
    `  Home: undefined${semi}`,
    `}${semi}`,
    '',
    `const Stack = createNativeStackNavigator<RootStackParamList>()${semi}`,
    '',
    'export default function RootNavigator() {',
    '  return (',
    '    <Stack.Navigator>',
    `      <Stack.Screen name=${'"'}Home${'"'} component={HomeScreen} />`,
    '    </Stack.Navigator>',
    `  )${semi}`,
    '}',
    '',
  ].join('\n');
}

function homeScreen(semi: string): string {
  return [
    `import { StyleSheet, Text, View } from 'react-native'${semi}`,
    '',
    'export default function HomeScreen() {',
    '  return (',
    '    <View style={styles.container}>',
    '      <Text>Home</Text>',
    '    </View>',
    `  )${semi}`,
    '}',
    '',
    'const styles = StyleSheet.create({',
    "  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },",
    `})${semi}`,
    '',
  ].join('\n');
}

function appFile(nav: boolean, query: boolean, semi: string): string {
  const imports = [
    ...(nav ? [`import { NavigationContainer } from '@react-navigation/native'${semi}`] : [`import { Text, View } from 'react-native'${semi}`]),
    ...(query ? [`import { QueryClient, QueryClientProvider } from '@tanstack/react-query'${semi}`] : []),
    ...(nav ? [`import RootNavigator from './src/navigation/RootNavigator'${semi}`] : []),
  ];
  let body = nav ? '<NavigationContainer>\n      <RootNavigator />\n    </NavigationContainer>' : '<View style={{ flex: 1, alignItems: \'center\', justifyContent: \'center\' }}>\n      <Text>Home</Text>\n    </View>';
  if (query) body = `<QueryClientProvider client={queryClient}>\n      ${body.replace(/\n/g, '\n  ')}\n    </QueryClientProvider>`;
  return [...imports, '', ...(query ? [`const queryClient = new QueryClient()${semi}`, ''] : []), 'export default function App() {', '  return (', `    ${body}`, `  )${semi}`, '}', ''].join('\n');
}

export function planReactNativeSetup(ctx: AdapterContext, choice: SetupChoice): SetupPlan {
  const { root, map } = ctx;
  if (!['fetch-helper', 'axios', 'axios-react-query'].includes(choice.architecture)) throw new ToolError('bad_args', `Unknown architecture "${choice.architecture}". Choose fetch-helper, axios or axios-react-query.`);
  const c0 = map.conventions;
  const expo = c0.flavor === 'expo';
  const src = 'src';
  const q = c0.quote === 'double' ? '"' : "'";
  const semi = c0.semicolons === 'false' ? '' : ';';
  const baseUrl = choice.baseUrl || 'https://api.example.com';
  const files = new Map<string, string>();
  const rewrites: string[] = [];
  const summary: string[] = [];
  const warnings: string[] = [];
  if (!choice.baseUrl) warnings.push(`No base URL was given, so ${src}/config/env.ts uses https://api.example.com. Change it there before calling the API.`);
  const read = (p: string) => readText(join(root, p));
  const create = (path: string, content: string, what: string) => {
    if (read(path) !== null) throw new ToolError('file_exists', `${path} already exists, so setup stopped without changing anything.`, 'Remove or rename it, or set up the project by hand and run devtool init again.');
    files.set(path, content);
    summary.push(`Create ${path}: ${what}`);
  };
  const axios = choice.architecture !== 'fetch-helper';
  const query = choice.architecture === 'axios-react-query';
  const nav = c0.router === 'none' || !c0.router;

  create(`${src}/config/env.ts`, envFile(expo, baseUrl, q, semi), expo ? 'API_URL from EXPO_PUBLIC_API_URL, and USE_MOCKS' : 'API_URL and USE_MOCKS');
  create(`${src}/api/client.ts`, axios ? axiosClient(q, semi) : fetchClient(q, semi), axios ? 'the axios instance (baseURL from API_URL)' : 'apiFetch<T>() and ApiError');
  if (!axios) create(`${src}/api/index.ts`, `export * from ${q}./client${q}${semi}\n`, 'exports every API file');
  if (expo) {
    const env = read('.env.example');
    files.set('.env.example', `${env ? env.replace(/\s*$/, '\n') : ''}EXPO_PUBLIC_API_URL=${baseUrl}\nEXPO_PUBLIC_USE_MOCKS=false\n`);
    summary.push('Update .env.example: EXPO_PUBLIC_API_URL and EXPO_PUBLIC_USE_MOCKS');
  }
  if (nav) {
    create(`${src}/navigation/RootNavigator.tsx`, navigator(q, semi), 'React Navigation native stack with RootStackParamList');
    create(`${src}/screens/HomeScreen.tsx`, homeScreen(semi), 'the first screen');
  }
  if (nav || query) {
    const app = ['App.tsx', 'App.js'].find((f) => read(f) !== null) ?? 'App.tsx';
    if (c0.router === 'expo-router') {
      warnings.push(`This project uses Expo Router; wrap the root layout in <QueryClientProvider client={new QueryClient()}> yourself.`);
    } else {
      files.set(app, appFile(nav, query, semi));
      rewrites.push(app); // replaced on purpose; the previous App is in devtool undo
      summary.push(`${read(app) === null ? 'Create' : 'Replace'} ${app}: ${[nav && 'NavigationContainer with RootNavigator', query && 'QueryClientProvider'].filter(Boolean).join(' and ')}${read(app) !== null ? ' (the previous App is in devtool undo)' : ''}`);
    }
  }

  // Dependencies.
  const pkgText = read('package.json');
  let dependenciesChanged = false;
  if (pkgText !== null) {
    const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(join(root, 'package.json')) ?? {};
    const want = [...(axios ? ['axios'] : []), ...(query ? ['@tanstack/react-query'] : []), ...(nav ? ['@react-navigation/native', '@react-navigation/native-stack', 'react-native-screens', 'react-native-safe-area-context'] : [])];
    const missing = want.filter((p) => !pkg.dependencies?.[p] && !pkg.devDependencies?.[p]);
    if (missing.length) {
      const parsed = JSON.parse(pkgText);
      parsed.dependencies = { ...parsed.dependencies };
      for (const p of missing) parsed.dependencies[p] = PACKAGES[p];
      parsed.dependencies = Object.fromEntries(Object.entries(parsed.dependencies).sort(([a], [b]) => a.localeCompare(b)));
      files.set('package.json', JSON.stringify(parsed, null, 2) + '\n');
      summary.push(`Update package.json: add ${missing.join(', ')}`);
      dependenciesChanged = true;
      if (expo) warnings.push('Run npx expo install --fix after installing, so the native packages match your Expo SDK.');
      else if (nav) warnings.push('react-native-screens and react-native-safe-area-context are native: run cd ios && pod install after npm install.');
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
    screensFolder: `${src}/screens`,
    ...(axios ? { axiosInstance: 'api', axiosInstanceFile: `${src}/api/client.ts` } : {}),
    ...(query ? { dataFetching: 'react-query', hooksFolder: `${src}/hooks` } : {}),
    ...(nav ? { router: 'react-navigation', navigatorFile: `${src}/navigation/RootNavigator.tsx`, routerDir: '' } : {}),
  };
  if (!axios) for (const k of ['axiosInstance', 'axiosInstanceFile']) delete conventions[k];
  delete conventions.baseUrlEnv;
  summary.push(`Save conventions: API functions in ${src}/api, interfaces in ${src}/types, screens in ${src}/screens`);
  return { files, summary, warnings, generated: [], conventions, dependenciesChanged, rewrites };
}
