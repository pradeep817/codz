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
import { applyChangeSet, buildChangeSet } from '../core/changeset.ts';
import { ToolError, type Adapter } from '../core/types.ts';
import { DART_RESERVED } from '../input/naming.ts';
import { detectProject, initFiles, writeInitFiles } from './init.ts';
import { planSetup } from './setup.ts';
import { planDemo } from './createDemo.ts';
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

/** React web app with Vite and TypeScript (what npm create vite gives you, react-ts template). */
function reactSkeleton(o: CreateOptions): Map<string, string> {
  const files = new Map<string, string>();
  const title = o.name.split(/[-_.]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  files.set(
    'package.json',
    JSON.stringify(
      {
        name: o.name,
        private: true,
        version: '0.0.0',
        type: 'module',
        scripts: { dev: 'vite', build: 'tsc -b && vite build', preview: 'vite preview', test: 'vitest run' },
        dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
        devDependencies: { '@types/react': '^18.3.12', '@types/react-dom': '^18.3.1', '@vitejs/plugin-react': '^4.3.4', typescript: '~5.6.2', vite: '^6.0.1', vitest: '^2.1.8' },
      },
      null,
      2,
    ) + '\n',
  );
  files.set('index.html', `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${title}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`);
  files.set('vite.config.ts', `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\n\nexport default defineConfig({\n  plugins: [react()],\n})\n`);
  files.set('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2020', lib: ['ES2020', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'bundler', jsx: 'react-jsx', strict: true, noEmit: true, allowImportingTsExtensions: true, skipLibCheck: true, isolatedModules: true }, include: ['src'] }, null, 2) + '\n');
  files.set('src/vite-env.d.ts', '/// <reference types="vite/client" />\n');
  files.set('src/main.tsx', `import { StrictMode } from 'react'\nimport { createRoot } from 'react-dom/client'\nimport App from './App.tsx'\n\ncreateRoot(document.getElementById('root')!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n)\n`);
  files.set('src/App.tsx', `function App() {\n  return (\n    <main>\n      <h1>${title}</h1>\n    </main>\n  )\n}\n\nexport default App\n`);
  files.set('.gitignore', 'node_modules\ndist\n*.local\n.codz/\n');
  return files;
}

/** The Swift name of an iOS app: shop-app → ShopApp. */
export const iosAppName = (name: string) => name.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');

/**
 * A SwiftUI app as Xcode 16's App template makes it: one target whose sources
 * are a synchronized folder (new files are part of the app without editing the
 * project file), an asset catalog, and a generated Info.plist.
 */
function iosSkeleton(o: CreateOptions): Map<string, string> {
  const app = iosAppName(o.name);
  const bundle = `${o.org}.${o.name.replace(/[^a-zA-Z0-9]/g, '')}`;
  const files = new Map<string, string>();
  // Object ids: 24 hex digits, fixed so a project made twice is the same.
  const id = (n: number) => `C0DE${String(n).padStart(20, '0')}`;
  const [project, mainGroup, productsGroup, appGroup, target, product, sources, frameworks, resources, projectList, targetList, projDebug, projRelease, targetDebug, targetRelease] = Array.from({ length: 15 }, (_, i) => id(i + 1));
  const common = [
    'ALWAYS_SEARCH_USER_PATHS = NO;',
    'ASSETCATALOG_COMPILER_GENERATE_SWIFT_ASSET_SYMBOL_EXTENSIONS = YES;',
    'CLANG_ENABLE_MODULES = YES;',
    'CLANG_ENABLE_OBJC_ARC = YES;',
    'COPY_PHASE_STRIP = NO;',
    'ENABLE_STRICT_OBJC_MSGSEND = YES;',
    'ENABLE_USER_SCRIPT_SANDBOXING = YES;',
    'GCC_C_LANGUAGE_STANDARD = gnu17;',
    'IPHONEOS_DEPLOYMENT_TARGET = 17.0;',
    'LOCALIZATION_PREFERS_STRING_CATALOGS = YES;',
    'SDKROOT = iphoneos;',
  ];
  const projSettings = (debug: boolean) => [
    ...common,
    ...(debug
      ? ['DEBUG_INFORMATION_FORMAT = dwarf;', 'ENABLE_TESTABILITY = YES;', 'GCC_OPTIMIZATION_LEVEL = 0;', 'ONLY_ACTIVE_ARCH = YES;', 'SWIFT_ACTIVE_COMPILATION_CONDITIONS = "DEBUG $(inherited)";', 'SWIFT_OPTIMIZATION_LEVEL = "-Onone";', 'MTL_ENABLE_DEBUG_INFO = INCLUDE_SOURCE;']
      : ['DEBUG_INFORMATION_FORMAT = "dwarf-with-dsym";', 'ENABLE_NS_ASSERTIONS = NO;', 'SWIFT_COMPILATION_MODE = wholemodule;', 'VALIDATE_PRODUCT = YES;', 'MTL_ENABLE_DEBUG_INFO = NO;']),
  ];
  const targetSettings = [
    'ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;',
    'ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME = AccentColor;',
    'CODE_SIGN_STYLE = Automatic;',
    'CURRENT_PROJECT_VERSION = 1;',
    'ENABLE_PREVIEWS = YES;',
    'GENERATE_INFOPLIST_FILE = YES;',
    `INFOPLIST_KEY_CFBundleDisplayName = ${app};`,
    'INFOPLIST_KEY_UIApplicationSceneManifest_Generation = YES;',
    'INFOPLIST_KEY_UIApplicationSupportsIndirectInputEvents = YES;',
    'INFOPLIST_KEY_UILaunchScreen_Generation = YES;',
    'INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad = "UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight";',
    'INFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone = "UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight";',
    'LD_RUNPATH_SEARCH_PATHS = (\n\t\t\t\t\t"$(inherited)",\n\t\t\t\t\t"@executable_path/Frameworks",\n\t\t\t\t);',
    'MARKETING_VERSION = 1.0;',
    `PRODUCT_BUNDLE_IDENTIFIER = ${bundle};`,
    'PRODUCT_NAME = "$(TARGET_NAME)";',
    'SWIFT_EMIT_LOC_STRINGS = YES;',
    'SWIFT_VERSION = 5.0;',
    'TARGETED_DEVICE_FAMILY = "1,2";',
  ];
  const config = (key: string, name: string, settings: string[]) => [`\t\t${key} /* ${name} */ = {`, '\t\t\tisa = XCBuildConfiguration;', '\t\t\tbuildSettings = {', ...settings.map((x) => `\t\t\t\t${x}`), '\t\t\t};', `\t\t\tname = ${name};`, '\t\t};'];
  const phase = (key: string, isa: string, name: string) => [`\t\t${key} /* ${name} */ = {`, `\t\t\tisa = ${isa};`, '\t\t\tbuildActionMask = 2147483647;', '\t\t\tfiles = (', '\t\t\t);', '\t\t\trunOnlyForDeploymentPostprocessing = 0;', '\t\t};'];
  const pbx = [
    '// !$*UTF8*$!',
    '{',
    '\tarchiveVersion = 1;',
    '\tclasses = {',
    '\t};',
    '\tobjectVersion = 77;',
    '\tobjects = {',
    '',
    '/* Begin PBXFileReference section */',
    `\t\t${product} /* ${app}.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = ${app}.app; sourceTree = BUILT_PRODUCTS_DIR; };`,
    '/* End PBXFileReference section */',
    '',
    '/* Begin PBXFileSystemSynchronizedRootGroup section */',
    `\t\t${appGroup} /* ${app} */ = {`,
    '\t\t\tisa = PBXFileSystemSynchronizedRootGroup;',
    `\t\t\tpath = ${app};`,
    '\t\t\tsourceTree = "<group>";',
    '\t\t};',
    '/* End PBXFileSystemSynchronizedRootGroup section */',
    '',
    '/* Begin PBXFrameworksBuildPhase section */',
    ...phase(frameworks, 'PBXFrameworksBuildPhase', 'Frameworks'),
    '/* End PBXFrameworksBuildPhase section */',
    '',
    '/* Begin PBXGroup section */',
    `\t\t${mainGroup} = {`,
    '\t\t\tisa = PBXGroup;',
    '\t\t\tchildren = (',
    `\t\t\t\t${appGroup} /* ${app} */,`,
    `\t\t\t\t${productsGroup} /* Products */,`,
    '\t\t\t);',
    '\t\t\tsourceTree = "<group>";',
    '\t\t};',
    `\t\t${productsGroup} /* Products */ = {`,
    '\t\t\tisa = PBXGroup;',
    '\t\t\tchildren = (',
    `\t\t\t\t${product} /* ${app}.app */,`,
    '\t\t\t);',
    '\t\t\tname = Products;',
    '\t\t\tsourceTree = "<group>";',
    '\t\t};',
    '/* End PBXGroup section */',
    '',
    '/* Begin PBXNativeTarget section */',
    `\t\t${target} /* ${app} */ = {`,
    '\t\t\tisa = PBXNativeTarget;',
    `\t\t\tbuildConfigurationList = ${targetList} /* Build configuration list for PBXNativeTarget "${app}" */;`,
    '\t\t\tbuildPhases = (',
    `\t\t\t\t${sources} /* Sources */,`,
    `\t\t\t\t${frameworks} /* Frameworks */,`,
    `\t\t\t\t${resources} /* Resources */,`,
    '\t\t\t);',
    '\t\t\tbuildRules = (',
    '\t\t\t);',
    '\t\t\tdependencies = (',
    '\t\t\t);',
    '\t\t\tfileSystemSynchronizedGroups = (',
    `\t\t\t\t${appGroup} /* ${app} */,`,
    '\t\t\t);',
    `\t\t\tname = ${app};`,
    '\t\t\tpackageProductDependencies = (',
    '\t\t\t);',
    `\t\t\tproductName = ${app};`,
    `\t\t\tproductReference = ${product} /* ${app}.app */;`,
    '\t\t\tproductType = "com.apple.product-type.application";',
    '\t\t};',
    '/* End PBXNativeTarget section */',
    '',
    '/* Begin PBXProject section */',
    `\t\t${project} /* Project object */ = {`,
    '\t\t\tisa = PBXProject;',
    '\t\t\tattributes = {',
    '\t\t\t\tBuildIndependentTargetsInParallel = 1;',
    '\t\t\t\tLastSwiftUpdateCheck = 1600;',
    '\t\t\t\tLastUpgradeCheck = 1600;',
    '\t\t\t\tTargetAttributes = {',
    `\t\t\t\t\t${target} = {`,
    '\t\t\t\t\t\tCreatedOnToolsVersion = 16.0;',
    '\t\t\t\t\t};',
    '\t\t\t\t};',
    '\t\t\t};',
    `\t\t\tbuildConfigurationList = ${projectList} /* Build configuration list for PBXProject "${app}" */;`,
    '\t\t\tdevelopmentRegion = en;',
    '\t\t\thasScannedForEncodings = 0;',
    '\t\t\tknownRegions = (',
    '\t\t\t\ten,',
    '\t\t\t\tBase,',
    '\t\t\t);',
    `\t\t\tmainGroup = ${mainGroup};`,
    '\t\t\tminimizedProjectReferenceProxies = 1;',
    '\t\t\tpreferredProjectObjectVersion = 77;',
    `\t\t\tproductRefGroup = ${productsGroup} /* Products */;`,
    '\t\t\tprojectDirPath = "";',
    '\t\t\tprojectRoot = "";',
    '\t\t\ttargets = (',
    `\t\t\t\t${target} /* ${app} */,`,
    '\t\t\t);',
    '\t\t};',
    '/* End PBXProject section */',
    '',
    '/* Begin PBXResourcesBuildPhase section */',
    ...phase(resources, 'PBXResourcesBuildPhase', 'Resources'),
    '/* End PBXResourcesBuildPhase section */',
    '',
    '/* Begin PBXSourcesBuildPhase section */',
    ...phase(sources, 'PBXSourcesBuildPhase', 'Sources'),
    '/* End PBXSourcesBuildPhase section */',
    '',
    '/* Begin XCBuildConfiguration section */',
    ...config(projDebug, 'Debug', projSettings(true)),
    ...config(projRelease, 'Release', projSettings(false)),
    ...config(targetDebug, 'Debug', targetSettings),
    ...config(targetRelease, 'Release', targetSettings),
    '/* End XCBuildConfiguration section */',
    '',
    '/* Begin XCConfigurationList section */',
    `\t\t${projectList} /* Build configuration list for PBXProject "${app}" */ = {`,
    '\t\t\tisa = XCConfigurationList;',
    '\t\t\tbuildConfigurations = (',
    `\t\t\t\t${projDebug} /* Debug */,`,
    `\t\t\t\t${projRelease} /* Release */,`,
    '\t\t\t);',
    '\t\t\tdefaultConfigurationIsVisible = 0;',
    '\t\t\tdefaultConfigurationName = Release;',
    '\t\t};',
    `\t\t${targetList} /* Build configuration list for PBXNativeTarget "${app}" */ = {`,
    '\t\t\tisa = XCConfigurationList;',
    '\t\t\tbuildConfigurations = (',
    `\t\t\t\t${targetDebug} /* Debug */,`,
    `\t\t\t\t${targetRelease} /* Release */,`,
    '\t\t\t);',
    '\t\t\tdefaultConfigurationIsVisible = 0;',
    '\t\t\tdefaultConfigurationName = Release;',
    '\t\t};',
    '/* End XCConfigurationList section */',
    '\t};',
    `\trootObject = ${project} /* Project object */;`,
    '}',
    '',
  ].join('\n');
  files.set(`${app}.xcodeproj/project.pbxproj`, pbx);
  files.set(`${app}/${app}App.swift`, `import SwiftUI\n\n@main\nstruct ${app}App: App {\n    var body: some Scene {\n        WindowGroup {\n            ContentView()\n        }\n    }\n}\n`);
  files.set(`${app}/ContentView.swift`, `import SwiftUI\n\nstruct ContentView: View {\n    var body: some View {\n        Text("${app}")\n            .padding()\n    }\n}\n\n#Preview {\n    ContentView()\n}\n`);
  files.set(`${app}/Assets.xcassets/Contents.json`, '{\n  "info" : {\n    "author" : "xcode",\n    "version" : 1\n  }\n}\n');
  files.set(`${app}/Assets.xcassets/AccentColor.colorset/Contents.json`, '{\n  "colors" : [\n    {\n      "idiom" : "universal"\n    }\n  ],\n  "info" : {\n    "author" : "xcode",\n    "version" : 1\n  }\n}\n');
  files.set(`${app}/Assets.xcassets/AppIcon.appiconset/Contents.json`, '{\n  "images" : [\n    {\n      "idiom" : "universal",\n      "platform" : "ios",\n      "size" : "1024x1024"\n    }\n  ],\n  "info" : {\n    "author" : "xcode",\n    "version" : 1\n  }\n}\n');
  files.set('.gitignore', 'xcuserdata/\nDerivedData/\n.DS_Store\n.codz/\n');
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
  {
    id: 'react',
    label: 'React (Vite)',
    description: 'React web app with Vite, TypeScript and React Router',
    architectures: [
      { id: 'fetch-helper', label: 'Fetch helper', description: 'src/api/client.ts with apiFetch<T>() and ApiError; API URL in src/config/env.ts' },
      { id: 'axios', label: 'axios', description: 'An axios instance in src/api/client.ts; API functions call it' },
      { id: 'axios-react-query', label: 'axios + TanStack Query', description: 'The axios instance, a query hook per endpoint, QueryClientProvider around the app' },
      { ...NONE, label: 'Plain React', description: 'No API layer or router yet; add one later with codz setup' },
    ],
    checkName: npmName,
    needsOrg: false,
    options: [],
    // codz writes the react-ts template itself (npm create vite asks questions in some versions).
    creator: () => null,
    skeleton: reactSkeleton,
    install: () => ({ cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['install'], label: 'npm install' }),
    framework: 'react',
  },
  {
    id: 'ios',
    label: 'iOS (SwiftUI)',
    description: 'Native iPhone and iPad app in Swift with SwiftUI (open it in Xcode 16 or newer)',
    architectures: [
      { id: 'urlsession', label: 'URLSession + async/await', description: 'APIClient with send<T>() over URLSession and JSONDecoder; ObservableObject view models' },
      { ...NONE, label: 'Plain SwiftUI', description: 'No API layer yet; add one later with codz setup' },
    ],
    checkName: (n) => (/^[a-z][a-z0-9-]*$/.test(n) ? null : 'Use lowercase letters, digits and dashes, starting with a letter (for example shop-app); the app is then called ShopApp.'),
    needsOrg: true,
    options: [],
    // Xcode has no command-line project creator; codz writes the App template itself.
    creator: () => null,
    skeleton: iosSkeleton,
    install: () => null,
    framework: 'ios',
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

  // 2b. The first screen: a demo in the architecture just set up, instead of the template's counter.
  if (o.architecture !== 'none') {
    if (t.id === 'flutter' && o.architecture === 'getx') {
      // The GetX module (binding, controller, view and its route) comes from module add.
      const { planModuleAdd } = await import('./module.ts');
      const mod = await planModuleAdd(dir, adapter, { name: 'home', initial: true });
      applyChangeSet(dir, mod, { allowDirty: true, verify: false, format: false, adapter });
    }
    const demo = planDemo({ dir, type: t.id as 'flutter' | 'nextjs' | 'react-native' | 'android' | 'react' | 'ios', architecture: o.architecture, name: o.name, androidPackage: t.id === 'android' ? androidPackage(o.org, o.name) : undefined, iosApp: t.id === 'ios' ? iosAppName(o.name) : undefined });
    if (demo) {
      const cs = buildChangeSet(dir, 'create', { files: demo.files, summary: demo.summary, warnings: [], generated: [], rewrites: demo.rewrites, ...(demo.deletes ? { deletes: new Set(demo.deletes) } : {}) });
      applyChangeSet(dir, cs, { allowDirty: true, verify: false, format: false, adapter });
      steps.push(...demo.summary);
    }
  }

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
