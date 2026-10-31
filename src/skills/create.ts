// codz create: a new project, set up the way codz would set it up.
//
//   1. project type (Flutter, Next.js, ...) and its architecture
//   2. name and type-specific options (organization, Tailwind, ...)
//   3. the platform's own creator (flutter create, create-next-app) when it is
//      installed and reachable, otherwise a minimal project codz writes itself
//   4. the architecture applied with `setup`, codz.config.yaml written,
//      an optional theme color, dependencies installed, a first git commit
//
// Each type is one entry in PROJECT_TYPES, so more platforms plug in the same way.

import { checkBaseUrl } from '../core/safe.ts';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { addGradleWrapper, androidPackage, androidSkeleton } from './androidSkeleton.ts';
import { ADAPTERS } from '../adapters/index.ts';
import { applyChangeSet } from '../core/changeset.ts';
import { ToolError, type Adapter } from '../core/types.ts';
import { DART_RESERVED } from '../input/naming.ts';
import { detectProject, initFiles, writeInitFiles } from './init.ts';
import { planSetup } from './setup.ts';
import { planThemeSet } from './theme.ts';
import { runTool, toolMissing } from '../core/proc.ts';

export interface CreateOptions {
  type: string;
  name: string;
  /** Folder the project folder is created in. */
  parent: string;
  architecture: string;
  baseUrl: string;
  /** Reverse-domain organization (com.example), for app ids. */
  org: string;
  /** Next.js: Tailwind CSS. */
  tailwind?: boolean;
  /** React Native: expo (default) or bare (React Native CLI). */
  flavor?: 'expo' | 'bare';
  /** A primary color for the theme (#hex). */
  primary?: string;
  /** Do not run the platform creator; write codz's minimal project. */
  offline?: boolean;
  install?: boolean;
  git?: boolean;
}

export interface Architecture {
  id: string;
  label: string;
  description: string;
}

export interface ProjectType {
  id: string;
  label: string;
  description: string;
  architectures: Architecture[];
  /** null when the name is fine, else what is wrong with it. */
  checkName(name: string): string | null;
  needsOrg: boolean;
  /** Questions beyond the common ones, asked by the CLI. */
  options: ('tailwind' | 'flavor')[];
  /** The platform's own creator, run in the parent folder. */
  creator(o: CreateOptions): { cmd: string; args: string[]; label: string } | null;
  /** codz's own minimal project, when the creator is not available. */
  skeleton(o: CreateOptions): Map<string, string>;
  /** Installs dependencies in the new project. */
  install(o: CreateOptions): { cmd: string; args: string[]; label: string } | null;
  framework: keyof typeof ADAPTERS;
}

const NONE: Architecture = { id: 'none', label: 'None', description: 'No API layer yet; set one up later with codz setup' };

function flutterSkeleton(o: CreateOptions): Map<string, string> {
  const files = new Map<string, string>();
  files.set('pubspec.yaml', `name: ${o.name}\ndescription: "A new Flutter project."\npublish_to: 'none'\n\nversion: 1.0.0+1\n\nenvironment:\n  sdk: ^3.5.0\n\ndependencies:\n  flutter:\n    sdk: flutter\n\n  cupertino_icons: ^1.0.8\n\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n\n  flutter_lints: ^4.0.0\n\nflutter:\n  uses-material-design: true\n`);
  files.set('analysis_options.yaml', 'include: package:flutter_lints/flutter.yaml\n');
  files.set('.gitignore', '.dart_tool/\n.flutter-plugins\n.flutter-plugins-dependencies\nbuild/\n.idea/\n*.iml\n');
  const title = o.name.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  files.set(
    'lib/main.dart',
    [
      "import 'package:flutter/material.dart';",
      '',
      'void main() {',
      '  runApp(const MyApp());',
      '}',
      '',
      'class MyApp extends StatelessWidget {',
      '  const MyApp({super.key});',
      '',
      '  @override',
      '  Widget build(BuildContext context) {',
      '    return MaterialApp(',
      `      title: '${title}',`,
      '      theme: ThemeData(',
      '        colorScheme: ColorScheme.fromSeed(seedColor: Colors.deepPurple),',
      '        useMaterial3: true,',
      '      ),',
      `      home: const HomePage(title: '${title}'),`,
      '    );',
      '  }',
      '}',
      '',
      'class HomePage extends StatelessWidget {',
      '  const HomePage({super.key, required this.title});',
      '',
      '  final String title;',
      '',
      '  @override',
      '  Widget build(BuildContext context) {',
      '    return Scaffold(',
      '      appBar: AppBar(title: Text(title)),',
      "      body: const Center(child: Text('Hello')),",
      '    );',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  files.set('test/widget_test.dart', `import 'package:flutter_test/flutter_test.dart';\n\nimport 'package:${o.name}/main.dart';\n\nvoid main() {\n  testWidgets('shows the home page', (WidgetTester tester) async {\n    await tester.pumpWidget(const MyApp());\n    expect(find.text('Hello'), findsOneWidget);\n  });\n}\n`);
  return files;
}

function nextSkeleton(o: CreateOptions): Map<string, string> {
  const files = new Map<string, string>();
  const pkg = {
    name: o.name,
    version: '0.1.0',
    private: true,
    scripts: { dev: 'next dev', build: 'next build', start: 'next start', lint: 'next lint' },
    dependencies: { next: '^15.0.0', react: '^19.0.0', 'react-dom': '^19.0.0' },
    devDependencies: { '@types/node': '^20', '@types/react': '^19', '@types/react-dom': '^19', typescript: '^5', ...(o.tailwind ? { tailwindcss: '^4', '@tailwindcss/postcss': '^4' } : {}) },
  };
  files.set('package.json', JSON.stringify(pkg, null, 2) + '\n');
  files.set(
    'tsconfig.json',
    JSON.stringify(
      {
        compilerOptions: { target: 'ES2017', lib: ['dom', 'dom.iterable', 'esnext'], allowJs: true, skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true, module: 'esnext', moduleResolution: 'bundler', resolveJsonModule: true, isolatedModules: true, jsx: 'preserve', incremental: true, plugins: [{ name: 'next' }], paths: { '@/*': ['./*'] } },
        include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
        exclude: ['node_modules'],
      },
      null,
      2,
    ) + '\n',
  );
  files.set('next.config.mjs', '/** @type {import(\'next\').NextConfig} */\nconst nextConfig = {};\n\nexport default nextConfig;\n');
  files.set('next-env.d.ts', '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n');
  files.set('.gitignore', '/node_modules\n/.next/\n/out/\n.env*.local\nnext-env.d.ts\n*.tsbuildinfo\n');
  if (o.tailwind) {
    files.set('postcss.config.mjs', 'const config = {\n  plugins: { "@tailwindcss/postcss": {} },\n};\n\nexport default config;\n');
    files.set('app/globals.css', '@import "tailwindcss";\n');
  } else files.set('app/globals.css', ':root {\n  font-family: system-ui, sans-serif;\n}\n');
  files.set('app/layout.tsx', `import type { Metadata } from 'next';\nimport './globals.css';\n\nexport const metadata: Metadata = {\n  title: '${o.name}',\n};\n\nexport default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`);
  files.set('app/page.tsx', `export default function Home() {\n  return (\n    <main>\n      <h1>${o.name}</h1>\n    </main>\n  );\n}\n`);
  return files;
}

/** React Native: Expo (blank TypeScript template) or the React Native CLI template, without native folders. */
function reactNativeSkeleton(o: CreateOptions): Map<string, string> {
  const files = new Map<string, string>();
  const expo = o.flavor !== 'bare';
  const display = o.name.replace(/[-_.]+(\w)/g, (_m, c: string) => c.toUpperCase()).replace(/^\w/, (c) => c.toUpperCase());
  const pkg = expo
    ? {
        name: o.name,
        version: '1.0.0',
        main: 'index.ts',
        scripts: { start: 'expo start', android: 'expo start --android', ios: 'expo start --ios', test: 'jest' },
        dependencies: { expo: '~52.0.0', 'expo-status-bar': '~2.0.0', react: '18.3.1', 'react-native': '0.76.5' },
        devDependencies: { '@babel/core': '^7.25.0', '@types/react': '~18.3.12', typescript: '^5.3.3', jest: '^29.7.0', 'jest-expo': '~52.0.0' },
        jest: { preset: 'jest-expo' },
        private: true,
      }
    : {
        name: o.name,
        version: '0.0.1',
        private: true,
        scripts: { android: 'react-native run-android', ios: 'react-native run-ios', start: 'react-native start', test: 'jest', lint: 'eslint .' },
        dependencies: { react: '18.3.1', 'react-native': '0.76.5' },
        devDependencies: { '@babel/core': '^7.25.2', '@react-native/babel-preset': '0.76.5', '@react-native/metro-config': '0.76.5', '@react-native/typescript-config': '0.76.5', '@types/react': '^18.2.6', jest: '^29.6.3', typescript: '5.0.4' },
        jest: { preset: 'react-native' },
        engines: { node: '>=18' },
      };
  files.set('package.json', JSON.stringify(pkg, null, 2) + '\n');
  files.set('tsconfig.json', JSON.stringify(expo ? { extends: 'expo/tsconfig.base', compilerOptions: { strict: true, paths: { '@/*': ['./src/*'] } } } : { extends: '@react-native/typescript-config/tsconfig.json' }, null, 2) + '\n');
  files.set('app.json', JSON.stringify(expo ? { expo: { name: display, slug: o.name, version: '1.0.0', orientation: 'portrait', ios: { bundleIdentifier: `${o.org}.${o.name.replace(/[^a-zA-Z0-9]/g, '')}` }, android: { package: `${o.org}.${o.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}` } } } : { name: display, displayName: display }, null, 2) + '\n');
  files.set('App.tsx', `import { StyleSheet, Text, View } from 'react-native';\n\nexport default function App() {\n  return (\n    <View style={styles.container}>\n      <Text>${display}</Text>\n    </View>\n  );\n}\n\nconst styles = StyleSheet.create({\n  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },\n});\n`);
  if (expo) {
    files.set('index.ts', "import { registerRootComponent } from 'expo';\n\nimport App from './App';\n\nregisterRootComponent(App);\n");
    files.set('.gitignore', 'node_modules/\n.expo/\ndist/\nweb-build/\n.env*.local\n*.jks\n*.p8\n*.p12\n*.key\n*.mobileprovision\n');
  } else {
    files.set('index.js', `import { AppRegistry } from 'react-native';\nimport App from './App';\nimport { name as appName } from './app.json';\n\nAppRegistry.registerComponent(appName, () => App);\n`);
    files.set('babel.config.js', "module.exports = {\n  presets: ['module:@react-native/babel-preset'],\n};\n");
    files.set('metro.config.js', "const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');\n\nmodule.exports = mergeConfig(getDefaultConfig(__dirname), {});\n");
    files.set('.gitignore', 'node_modules/\n.DS_Store\nbuild/\n*.log\nios/Pods/\n.gradle/\nlocal.properties\n*.keystore\n!debug.keystore\n');
  }
  return files;
}

const npmName = (name: string) => (/^[a-z0-9][a-z0-9._-]*$/.test(name) && name.length <= 214 ? null : 'Use lowercase letters, digits, dots, dashes and underscores, starting with a letter or digit (for example my-app).');

export const PROJECT_TYPES: ProjectType[] = [
  {
    id: 'flutter',
    label: 'Flutter',
    description: 'Android, iOS, web and desktop from one Dart codebase',
    architectures: [
      { id: 'riverpod', label: 'Riverpod', description: 'Dio through dioProvider; a provider per repository' },
      { id: 'getx', label: 'GetX', description: 'GetX modules (binding, controller, view), Dio registered in an InitialBinding' },
      { id: 'bloc', label: 'Bloc', description: 'Cubits for screens, get_it for Dio and repositories' },
      { id: 'get_it', label: 'get_it', description: 'Service locator for Dio and repositories, no state library' },
      { ...NONE, label: 'Plain Flutter', description: 'No state library or API layer; add one later with codz setup' },
    ],
    checkName: (n) => (!/^[a-z][a-z0-9_]*$/.test(n) ? 'Use lowercase letters, digits and underscores, starting with a letter (for example my_app).' : DART_RESERVED.has(n) ? `"${n}" is a Dart keyword.` : null),
    needsOrg: true,
    options: [],
    creator: (o) => ({ cmd: 'flutter', args: ['create', '--org', o.org, '--project-name', o.name, o.name], label: 'flutter create' }),
    skeleton: flutterSkeleton,
    install: () => ({ cmd: 'flutter', args: ['pub', 'get'], label: 'flutter pub get' }),
    framework: 'flutter',
  },
  {
    id: 'nextjs',
    label: 'Next.js',
    description: 'React web app with the App Router and TypeScript',
    architectures: [
      { id: 'fetch-helper', label: 'Fetch helper', description: 'lib/api/client.ts with apiFetch<T>() and ApiError; API functions call it' },
      { id: 'plain-fetch', label: 'Plain fetch', description: 'Each API function calls fetch with the base URL from the environment' },
      NONE,
    ],
    checkName: npmName,
    needsOrg: false,
    options: ['tailwind'],
    creator: (o) => ({
      cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      args: ['--yes', 'create-next-app@latest', o.name, '--ts', '--app', '--eslint', o.tailwind ? '--tailwind' : '--no-tailwind', '--no-src-dir', '--import-alias', '@/*', '--use-npm', '--skip-install', '--yes'],
      label: 'create-next-app',
    }),
    skeleton: nextSkeleton,
    install: () => ({ cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['install'], label: 'npm install' }),
    framework: 'nextjs',
  },
  {
    id: 'react-native',
    label: 'React Native',
    description: 'Android and iOS apps in TypeScript, with Expo or the React Native CLI',
    architectures: [
      { id: 'fetch-helper', label: 'Fetch helper', description: 'apiFetch<T>() in src/api, API URL in src/config/env.ts, React Navigation' },
      { id: 'axios-react-query', label: 'axios + TanStack Query', description: 'An axios instance, a query hook per endpoint, React Navigation' },
      { id: 'axios', label: 'axios', description: 'An axios instance in src/api, React Navigation' },
      NONE,
    ],
    checkName: (n) => (/^[a-z][a-z0-9-]*$/.test(n) ? null : 'Use lowercase letters, digits and dashes, starting with a letter (for example shop-app).'),
    needsOrg: true,
    options: ['flavor'],
    creator: (o) =>
      o.flavor === 'bare'
        ? { cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx', args: ['--yes', '@react-native-community/cli@latest', 'init', o.name.replace(/-(\w)/g, (_m, c: string) => c.toUpperCase()).replace(/^\w/, (c) => c.toUpperCase()), '--directory', o.name, '--package-name', `${o.org}.${o.name.replace(/-/g, '')}`, '--skip-install', '--skip-git-init'], label: 'React Native CLI (init)' }
        : { cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx', args: ['--yes', 'create-expo-app@latest', o.name, '--template', 'blank-typescript', '--no-install'], label: 'create-expo-app' },
    skeleton: reactNativeSkeleton,
    install: () => ({ cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['install'], label: 'npm install' }),
    framework: 'react-native',
  },
  {
    id: 'android',
    label: 'Android (Kotlin)',
    description: 'Native Android app in Kotlin with Jetpack Compose and Navigation Compose',
    architectures: [
      { id: 'retrofit-hilt', label: 'Retrofit + Hilt', description: 'Retrofit, kotlinx.serialization and OkHttp provided by a Hilt NetworkModule' },
      { id: 'retrofit-koin', label: 'Retrofit + Koin', description: 'Retrofit and API interfaces in a Koin module, started in the Application class' },
      { id: 'retrofit', label: 'Retrofit only', description: 'A ServiceLocator object holds Retrofit and the API interfaces; no DI library' },
      { ...NONE, label: 'Plain Compose', description: 'Compose and Navigation only; add an API layer later with codz setup' },
    ],
    checkName: (n) => (/^[a-z][a-z0-9-]*$/.test(n) ? null : 'Use lowercase letters, digits and dashes, starting with a letter (for example shop-app).'),
    needsOrg: true,
    options: [],
    // Android has no command-line project creator; codz writes the Empty Activity template itself.
    creator: () => null,
    skeleton: (o) => androidSkeleton(o),
    install: () => null,
    framework: 'android',
  },
];

export function projectType(id: string): ProjectType {
  const t = PROJECT_TYPES.find((x) => x.id === id);
  if (!t) throw new ToolError('bad_type', `Unknown project type "${id}".`, `Types: ${PROJECT_TYPES.map((x) => x.id).join(', ')}`);
  return t;
}

export interface CreateReport {
  dir: string;
  type: string;
  architecture: string;
  created: 'creator' | 'skeleton';
  steps: string[];
  warnings: string[];
}

/** What create will do, without doing it (--dry-run). */
export function describeCreate(o: CreateOptions): string[] {
  const t = projectType(o.type);
  const dir = resolve(o.parent, o.name);
  const c = t.creator(o);
  const steps = [`Create ${dir}`, o.offline || !c ? `Write a minimal ${t.label} project (codz's own files)` : `Run ${c.label}: ${c.cmd} ${c.args.join(' ')}  (falls back to codz's minimal project if it is not available)`];
  if (o.architecture !== 'none') steps.push(`Set up the ${t.architectures.find((a) => a.id === o.architecture)?.label ?? o.architecture} architecture with base URL ${o.baseUrl || 'https://api.example.com'}`);
  steps.push('Write codz.config.yaml');
  if (o.primary) steps.push(`Set the theme's primary color to ${o.primary}`);
  if (o.install !== false) steps.push(`Install dependencies (${t.install(o)?.label ?? 'none'})`);
  if (o.git !== false) steps.push('git init and a first commit');
  return steps;
}

function validate(o: CreateOptions, t: ProjectType): void {
  const bad = t.checkName(o.name);
  if (bad) throw new ToolError('bad_name', `"${o.name}" cannot be a ${t.label} project name. ${bad}`);
  if (!t.architectures.some((a) => a.id === o.architecture)) throw new ToolError('bad_args', `Unknown architecture "${o.architecture}" for ${t.label}.`, `Choose one of: ${t.architectures.map((a) => a.id).join(', ')}`);
  if (t.needsOrg && !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(o.org)) throw new ToolError('bad_org', `"${o.org}" is not an organization id.`, 'Use reverse-domain form, for example com.example');
  if (o.baseUrl) o = { ...o, baseUrl: checkBaseUrl(o.baseUrl) };
  if (o.primary && !/^#?[0-9a-fA-F]{6}$/.test(o.primary)) throw new ToolError('bad_color', `"${o.primary}" is not a #rrggbb color.`);
}

function run(cmd: string, args: string[], cwd: string): { ok: boolean; missing: boolean; output: string } {
  const r = runTool(cmd, args, { cwd, timeout: 15 * 60_000 });
  const missing = toolMissing(r);
  return { ok: r.status === 0, missing, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

export async function createProject(o: CreateOptions, log: (line: string) => void = () => {}): Promise<CreateReport> {
  const t = projectType(o.type);
  validate(o, t);
  const parent = resolve(o.parent);
  const dir = join(parent, o.name);
  if (existsSync(dir) && readdirSync(dir).length) throw new ToolError('dir_not_empty', `${dir} already exists and is not empty.`, 'Pick another name, or remove that folder.');
  mkdirSync(parent, { recursive: true });
  const steps: string[] = [];
  const warnings: string[] = [];

  // 1. The project itself.
  let created: CreateReport['created'] = 'skeleton';
  const creator = o.offline ? null : t.creator(o);
  if (creator) {
    log(`Running ${creator.label}...`);
    const r = run(creator.cmd, creator.args, parent);
    if (r.ok) {
      created = 'creator';
      steps.push(`Created ${dir} with ${creator.label}`);
    } else {
      warnings.push(r.missing ? `${creator.label} is not installed, so codz wrote a minimal ${t.label} project instead.` : `${creator.label} failed (${r.output.split('\n').slice(-1)[0] || 'no output'}), so codz wrote a minimal ${t.label} project instead.`);
    }
  }
  if (created === 'skeleton') {
    for (const [path, content] of t.skeleton(o)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    steps.push(`Created ${dir} (codz's minimal ${t.label} project)`);
    if (t.id === 'react-native') warnings.push(o.flavor === 'bare' ? `There are no android/ or ios/ folders yet. With network access, create the project with the React Native CLI instead (codz create without --offline), or copy them from a fresh npx @react-native-community/cli init.` : 'Expo creates the android/ and ios/ folders when you need them: npx expo prebuild (or just run npx expo start with Expo Go).');
    if (t.id === 'android') {
      if (addGradleWrapper(dir)) steps.push('Added the Gradle wrapper (gradlew)');
      else warnings.push(`Gradle is not installed here, so there is no gradlew yet. Open the project in Android Studio (it adds the wrapper), or run gradle wrapper in ${o.name}/.`);
      steps.push(`Package ${androidPackage(o.org, o.name)}`);
    }
    if (t.id === 'flutter') warnings.push(`There are no android/ or ios/ folders yet. With Flutter installed, run this in ${o.name}/ to add them: flutter create --org ${o.org} --project-name ${o.name} .`);
  }

  // 2. Architecture and config.
  const d = await detectProject(dir, {});
  const adapter: Adapter = ADAPTERS[t.framework];
  if (o.architecture !== 'none') {
    const { changeSet, plan } = planSetup(dir, adapter, d.map, { architecture: o.architecture, baseUrl: o.baseUrl });
    applyChangeSet(dir, changeSet, { allowDirty: true, verify: false, format: false, adapter });
    steps.push(...plan.summary.filter((s) => !/^Save conventions/.test(s)));
    warnings.push(...plan.warnings);
  } else {
    writeInitFiles(dir, initFiles(dir, adapter, d.map.conventions), false);
  }
  steps.push('Wrote codz.config.yaml');

  // 3. Theme.
  if (o.primary && t.id === 'android') steps.push(`Theme: primary color ${o.primary}`);
  else if (o.primary) {
    const cs = await planThemeSet(dir, adapter, [{ name: 'primary', value: o.primary.startsWith('#') ? o.primary : `#${o.primary}` }]);
    applyChangeSet(dir, cs, { allowDirty: true, verify: false, format: false, adapter });
    steps.push(`Theme: primary color ${o.primary}`);
    warnings.push(...cs.warnings);
  }

  // 4. Dependencies.
  if (o.install !== false) {
    const cmd = t.install(o);
    if (cmd) {
      log(`Running ${cmd.label}...`);
      const r = run(cmd.cmd, cmd.args, dir);
      if (r.ok) steps.push(`Installed dependencies (${cmd.label})`);
      else warnings.push(`${cmd.label} ${r.missing ? 'is not available' : 'failed'}; run it yourself in ${o.name}/.`);
    }
  }

  // 5. Git.
  if (o.git !== false) {
    const g = (...a: string[]) => run('git', a, dir);
    if (existsSync(join(dir, '.git')) || g('init', '-q').ok) {
      g('add', '-A');
      // Your own git identity when one is set; a neutral one only when git has none.
      const identity = g('config', 'user.email').ok ? [] : ['-c', 'user.name=codz', '-c', 'user.email=codz@localhost'];
      const c = g(...identity, 'commit', '-qm', `Create ${o.name} with codz (${t.label}, ${o.architecture})`);
      if (c.ok) steps.push('git init and a first commit');
      else warnings.push('git init worked, but the first commit failed; commit yourself.');
    } else warnings.push('git is not available, so the project is not a repository yet.');
  }

  return { dir, type: t.id, architecture: o.architecture, created, steps, warnings };
}
