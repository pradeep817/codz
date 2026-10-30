// Android `setup`: Retrofit, OkHttp and kotlinx.serialization for an app that
// has no API layer yet, registered one of three ways:
//
//   retrofit-hilt   NetworkModule (@Module @InstallIn(SingletonComponent)),
//                   @HiltAndroidApp application, @AndroidEntryPoint activity
//   retrofit-koin   networkModule = module { ... }, startKoin in the application
//   retrofit        ServiceLocator object (no DI library)
//
// Gradle: dependencies and plugins go into gradle/libs.versions.toml and the
// module's build.gradle.kts when the project uses a version catalog (new
// Android Studio projects do), otherwise straight into build.gradle.kts.

import { join } from 'node:path';
import { readText } from '../core/fsutil.ts';
import { ToolError, type AdapterContext, type ArchitectureOption, type Conventions, type ProjectMap, type SetupChoice, type SetupPlan } from '../core/types.ts';
import { addKotlinImports } from './kotlinGen.ts';

/** Versions known to work together (Kotlin 2.0, AGP 8.7). */
export const ANDROID_VERSIONS = {
  kotlin: '2.0.21',
  ksp: '2.0.21-1.0.28',
  retrofit: '2.11.0',
  okhttp: '4.12.0',
  serialization: '1.7.3',
  hilt: '2.52',
  hiltNavigationCompose: '1.2.0',
  koin: '4.0.0',
  lifecycle: '2.8.7',
  navigationCompose: '2.8.4',
};

interface Lib {
  key: string;
  coord: string;
  version: keyof typeof ANDROID_VERSIONS;
  config?: 'implementation' | 'ksp';
}
interface Plugin {
  key: string;
  id: string;
  version: keyof typeof ANDROID_VERSIONS;
  root?: boolean;
}

const LIBS: Record<string, Lib> = {
  retrofit: { key: 'retrofit', coord: 'com.squareup.retrofit2:retrofit', version: 'retrofit' },
  retrofitKotlinx: { key: 'retrofit-kotlinx-serialization', coord: 'com.squareup.retrofit2:converter-kotlinx-serialization', version: 'retrofit' },
  okhttpLogging: { key: 'okhttp-logging', coord: 'com.squareup.okhttp3:logging-interceptor', version: 'okhttp' },
  serialization: { key: 'kotlinx-serialization-json', coord: 'org.jetbrains.kotlinx:kotlinx-serialization-json', version: 'serialization' },
  hilt: { key: 'hilt-android', coord: 'com.google.dagger:hilt-android', version: 'hilt' },
  hiltCompiler: { key: 'hilt-compiler', coord: 'com.google.dagger:hilt-compiler', version: 'hilt', config: 'ksp' },
  hiltNav: { key: 'hilt-navigation-compose', coord: 'androidx.hilt:hilt-navigation-compose', version: 'hiltNavigationCompose' },
  koin: { key: 'koin-android', coord: 'io.insert-koin:koin-android', version: 'koin' },
  koinCompose: { key: 'koin-androidx-compose', coord: 'io.insert-koin:koin-androidx-compose', version: 'koin' },
  viewModelCompose: { key: 'androidx-lifecycle-viewmodel-compose', coord: 'androidx.lifecycle:lifecycle-viewmodel-compose', version: 'lifecycle' },
  navigationCompose: { key: 'androidx-navigation-compose', coord: 'androidx.navigation:navigation-compose', version: 'navigationCompose' },
};
const PLUGINS: Record<string, Plugin> = {
  serialization: { key: 'kotlin-serialization', id: 'org.jetbrains.kotlin.plugin.serialization', version: 'kotlin', root: true },
  hilt: { key: 'hilt', id: 'com.google.dagger.hilt.android', version: 'hilt', root: true },
  ksp: { key: 'ksp', id: 'com.google.devtools.ksp', version: 'ksp', root: true },
};

export function androidArchitectures(map: ProjectMap): ArchitectureOption[] {
  if (map.endpoints.length > 0 || map.conventions.http === 'retrofit') return [];
  return [
    { id: 'retrofit-hilt', label: 'Retrofit + Hilt', description: 'NetworkModule provides Retrofit and every API interface; @HiltAndroidApp', recommended: true },
    { id: 'retrofit-koin', label: 'Retrofit + Koin', description: 'networkModule with single { } definitions; startKoin in the Application class', recommended: false },
    { id: 'retrofit', label: 'Retrofit only', description: 'A ServiceLocator object holds Retrofit and the API interfaces; no DI library', recommended: false },
  ];
}

const tomlKey = (k: string) => k.replace(/-/g, '.');

/** Adds entries to a [section] of libs.versions.toml, unless the key is there. */
export function tomlAdd(text: string, section: string, entries: [string, string][]): string {
  let t = text;
  const head = new RegExp(`^\\[${section}\\]\\s*$`, 'm').exec(t);
  if (!head) t = `${t.replace(/\s*$/, '\n')}\n[${section}]\n`;
  for (const [k, v] of entries) {
    const h = new RegExp(`^\\[${section}\\]\\s*$`, 'm').exec(t)!;
    const next = t.slice(h.index + h[0].length).search(/^\[/m);
    const at = next === -1 ? t.length : h.index + h[0].length + next;
    // Only this section counts: [versions] often has a key with the same name.
    if (new RegExp(`^${k.replace(/[.-]/g, '[.-]')}\\s*=`, 'm').test(t.slice(h.index, at))) continue;
    const before = t.slice(0, at).replace(/\n*$/, '\n');
    t = `${before}${k} = ${v}\n${next === -1 ? '' : '\n'}${t.slice(at).replace(/^\n+/, '')}`;
  }
  return t;
}

/** Adds lines to the first `name { ... }` block of a Gradle Kotlin script. */
export function gradleBlockAdd(text: string, block: string, lines: string[]): string {
  const m = new RegExp(`^${block}\\s*\\{`, 'm').exec(text);
  const want = lines.filter((l) => !text.includes(l.trim()));
  if (!want.length) return text;
  if (!m) return `${text.replace(/\s*$/, '\n')}\n${block} {\n${want.map((l) => `    ${l}`).join('\n')}\n}\n`;
  let depth = 0;
  let i = m.index + m[0].length - 1;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) break;
  }
  const before = text.slice(0, i).replace(/\s*$/, '\n');
  return `${before}${want.map((l) => `    ${l}`).join('\n')}\n${text.slice(i)}`;
}

function networkFile(arch: string, pkg: string): string {
  const imports = ['kotlinx.serialization.json.Json', 'okhttp3.MediaType.Companion.toMediaType', 'okhttp3.OkHttpClient', 'okhttp3.logging.HttpLoggingInterceptor', 'retrofit2.Retrofit', 'retrofit2.converter.kotlinx.serialization.asConverterFactory'];
  const logging = 'HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BODY }';
  let body: string[];
  if (arch === 'retrofit-hilt') {
    imports.push('dagger.Module', 'dagger.Provides', 'dagger.hilt.InstallIn', 'dagger.hilt.components.SingletonComponent', 'javax.inject.Singleton');
    body = [
      '/** Creates Retrofit and every API interface. devtool api add adds a provider here for each new interface. */',
      '@Module',
      '@InstallIn(SingletonComponent::class)',
      'object NetworkModule {',
      '    @Provides',
      '    @Singleton',
      '    fun provideJson(): Json = Json { ignoreUnknownKeys = true }',
      '',
      '    @Provides',
      '    @Singleton',
      '    fun provideOkHttpClient(): OkHttpClient =',
      '        OkHttpClient.Builder()',
      `            .addInterceptor(${logging})`,
      '            .build()',
      '',
      '    @Provides',
      '    @Singleton',
      '    fun provideRetrofit(client: OkHttpClient, json: Json): Retrofit =',
      '        Retrofit.Builder()',
      '            .baseUrl(ApiConfig.BASE_URL)',
      '            .client(client)',
      '            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))',
      '            .build()',
      '}',
    ];
  } else if (arch === 'retrofit-koin') {
    imports.push('org.koin.dsl.module');
    body = [
      '/** Retrofit and every API interface. devtool api add adds a single { } here for each new interface. */',
      'val networkModule = module {',
      '    single { Json { ignoreUnknownKeys = true } }',
      `    single { OkHttpClient.Builder().addInterceptor(${logging}).build() }`,
      '    single { Retrofit.Builder().baseUrl(ApiConfig.BASE_URL).client(get<OkHttpClient>()).addConverterFactory(get<Json>().asConverterFactory("application/json".toMediaType())).build() }',
      '}',
    ];
  } else {
    body = [
      '/** Holds Retrofit and the API interfaces. devtool api add adds one val per new interface. */',
      'object ServiceLocator {',
      '    private val json = Json { ignoreUnknownKeys = true }',
      '',
      '    private val client: OkHttpClient by lazy {',
      `        OkHttpClient.Builder().addInterceptor(${logging}).build()`,
      '    }',
      '',
      '    val retrofit: Retrofit by lazy {',
      '        Retrofit.Builder()',
      '            .baseUrl(ApiConfig.BASE_URL)',
      '            .client(client)',
      '            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))',
      '            .build()',
      '    }',
      '}',
    ];
  }
  return addKotlinImports([`package ${pkg}`, '', ...body, ''].join('\n'), imports, pkg);
}

export function planAndroidSetup(ctx: AdapterContext, choice: SetupChoice): SetupPlan {
  const { root, map } = ctx;
  if (!['retrofit-hilt', 'retrofit-koin', 'retrofit'].includes(choice.architecture)) throw new ToolError('bad_args', `Unknown architecture "${choice.architecture}". Choose retrofit-hilt, retrofit-koin or retrofit.`);
  const c0 = map.conventions;
  if (!c0.namespace) throw new ToolError('no_package', 'No namespace was found in the app build file, so setup cannot write Kotlin packages.', 'Add namespace = "com.example.app" to the android { } block.');
  const files = new Map<string, string>();
  const summary: string[] = [];
  const warnings: string[] = [];
  const read = (p: string) => files.get(p) ?? readText(join(root, p));
  const module = c0.module || 'app';
  const srcDir = c0.srcDir || `${module}/src/main/java`;
  const pkg = c0.namespace;
  const pkgDir = `${srcDir}/${pkg.replace(/\./g, '/')}`;
  const baseUrl = (choice.baseUrl || 'https://api.example.com').replace(/\/?$/, '/');
  if (!choice.baseUrl) warnings.push(`No base URL was given, so ApiConfig.BASE_URL is https://api.example.com/. Change it before calling the API.`);
  const arch = choice.architecture;
  const create = (path: string, content: string, what: string) => {
    if (read(path) !== null) throw new ToolError('file_exists', `${path} already exists, so setup stopped without changing anything.`);
    files.set(path, content);
    summary.push(`Create ${path}: ${what}`);
  };

  const remotePkg = `${pkg}.data.remote`;
  const diPkg = `${pkg}.di`;
  create(`${pkgDir}/data/remote/ApiConfig.kt`, `package ${remotePkg}\n\nobject ApiConfig {\n    /** Must end with "/": Retrofit paths are relative to it. */\n    const val BASE_URL = "${baseUrl}"\n}\n`, `BASE_URL = ${baseUrl}`);
  const netFile = arch === 'retrofit' ? `${pkgDir}/data/remote/ServiceLocator.kt` : `${pkgDir}/di/NetworkModule.kt`;
  create(netFile, addKotlinImports(networkFile(arch, arch === 'retrofit' ? remotePkg : diPkg), arch === 'retrofit' ? [] : [`${remotePkg}.ApiConfig`], arch === 'retrofit' ? remotePkg : diPkg), arch === 'retrofit-hilt' ? 'Hilt NetworkModule: Json, OkHttpClient, Retrofit' : arch === 'retrofit-koin' ? 'Koin networkModule: Json, OkHttpClient, Retrofit' : 'ServiceLocator with Retrofit');

  // Application class and manifest.
  const manifestPath = `${module}/src/main/AndroidManifest.xml`;
  let manifest = read(manifestPath);
  if (arch !== 'retrofit') {
    const appFile = `${pkgDir}/App.kt`;
    const app =
      arch === 'retrofit-hilt'
        ? `package ${pkg}\n\nimport android.app.Application\nimport dagger.hilt.android.HiltAndroidApp\n\n@HiltAndroidApp\nclass App : Application()\n`
        : `package ${pkg}\n\nimport android.app.Application\nimport ${diPkg}.networkModule\nimport org.koin.android.ext.koin.androidContext\nimport org.koin.core.context.startKoin\n\nclass App : Application() {\n    override fun onCreate() {\n        super.onCreate()\n        startKoin {\n            androidContext(this@App)\n            modules(networkModule)\n        }\n    }\n}\n`;
    if (manifest && /android:name="\.?\w*App\w*"/.test(manifest.split('<activity')[0])) warnings.push(`${manifestPath} already names an Application class; ${arch === 'retrofit-hilt' ? 'annotate it with @HiltAndroidApp' : 'call startKoin { modules(networkModule) } from it'} instead of the new App.kt.`);
    else {
      create(appFile, app, arch === 'retrofit-hilt' ? '@HiltAndroidApp application' : 'application that starts Koin');
      if (manifest) manifest = manifest.replace(/<application\b/, '<application\n        android:name=".App"');
    }
    if (arch === 'retrofit-hilt') {
      const main = [`${pkgDir}/MainActivity.kt`].find((f) => read(f) !== null);
      // Hilt injects only into ComponentActivity subclasses (AppCompatActivity, FragmentActivity), not android.app.Activity.
      const hiltable = main ? /class\s+MainActivity\s*:\s*(ComponentActivity|AppCompatActivity|FragmentActivity)\b/.test(read(main)!) : false;
      if (main && !hiltable && !/@AndroidEntryPoint/.test(read(main)!)) warnings.push(`${main} extends a class Hilt cannot inject into; if it needs injected objects, make it extend ComponentActivity and add @AndroidEntryPoint.`);
      if (main && hiltable && !/@AndroidEntryPoint/.test(read(main)!)) {
        files.set(main, addKotlinImports(read(main)!.replace(/^class\s+MainActivity/m, '@AndroidEntryPoint\nclass MainActivity'), ['dagger.hilt.android.AndroidEntryPoint'], pkg));
        summary.push(`Update ${main}: @AndroidEntryPoint`);
      }
    }
  }
  if (manifest !== null) {
    if (!/android\.permission\.INTERNET/.test(manifest)) manifest = manifest.replace(/(<manifest\b[^>]*>)/, '$1\n\n    <uses-permission android:name="android.permission.INTERNET" />');
    if (manifest !== readText(join(root, manifestPath))) {
      files.set(manifestPath, manifest);
      summary.push(`Update ${manifestPath}: INTERNET permission${arch !== 'retrofit' ? ' and android:name=".App"' : ''}`);
    }
  }

  // Gradle.
  const libs = [LIBS.retrofit, LIBS.retrofitKotlinx, LIBS.okhttpLogging, LIBS.serialization, ...(c0.ui === 'compose' ? [LIBS.viewModelCompose, LIBS.navigationCompose] : []), ...(arch === 'retrofit-hilt' ? [LIBS.hilt, LIBS.hiltCompiler, ...(c0.ui === 'compose' ? [LIBS.hiltNav] : [])] : []), ...(arch === 'retrofit-koin' ? [LIBS.koin, ...(c0.ui === 'compose' ? [LIBS.koinCompose] : [])] : [])];
  const plugins = [PLUGINS.serialization, ...(arch === 'retrofit-hilt' ? [PLUGINS.ksp, PLUGINS.hilt] : [])];
  const catalogPath = c0.versionCatalog || '';
  const moduleBuild = [`${module}/build.gradle.kts`, `${module}/build.gradle`].find((f) => read(f) !== null);
  const rootBuild = ['build.gradle.kts', 'build.gradle'].find((f) => read(f) !== null);
  let catalog = catalogPath ? read(catalogPath) : null;
  const kotlinVersion = (catalog && /^kotlin\s*=\s*"([^"]+)"/m.exec(catalog)?.[1]) || ANDROID_VERSIONS.kotlin;
  const version = (k: keyof typeof ANDROID_VERSIONS) => (k === 'kotlin' ? kotlinVersion : ANDROID_VERSIONS[k]);
  if (moduleBuild && !moduleBuild.endsWith('.kts')) warnings.push(`${moduleBuild} is Groovy; add these dependencies yourself: ${libs.map((l) => `${l.coord}:${version(l.version)}`).join(', ')}.`);
  else if (moduleBuild) {
    let mb = read(moduleBuild)!;
    if (catalog !== null) {
      const versionKeys = [...new Set([...libs.map((l) => l.version), ...plugins.map((p) => p.version)])];
      catalog = tomlAdd(catalog, 'versions', versionKeys.map((k) => [k === 'kotlin' ? 'kotlin' : k.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`), `"${version(k)}"`]));
      catalog = tomlAdd(catalog, 'libraries', libs.map((l) => [l.key, `{ group = "${l.coord.split(':')[0]}", name = "${l.coord.split(':')[1]}", version.ref = "${l.version === 'kotlin' ? 'kotlin' : l.version.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}" }`]));
      catalog = tomlAdd(catalog, 'plugins', plugins.map((p) => [p.key, `{ id = "${p.id}", version.ref = "${p.version === 'kotlin' ? 'kotlin' : p.version}" }`]));
      files.set(catalogPath, catalog);
      summary.push(`Update ${catalogPath}: ${libs.length} libraries and ${plugins.length} plugin${plugins.length === 1 ? '' : 's'}`);
      mb = gradleBlockAdd(mb, 'plugins', plugins.map((p) => `alias(libs.plugins.${tomlKey(p.key)})`));
      mb = gradleBlockAdd(mb, 'dependencies', libs.map((l) => `${l.config ?? 'implementation'}(libs.${tomlKey(l.key)})`));
      if (rootBuild && rootBuild.endsWith('.kts')) {
        const rb = gradleBlockAdd(read(rootBuild)!, 'plugins', plugins.filter((p) => p.root).map((p) => `alias(libs.plugins.${tomlKey(p.key)}) apply false`));
        if (rb !== read(rootBuild)) {
          files.set(rootBuild, rb);
          summary.push(`Update ${rootBuild}: declare ${plugins.map((p) => p.key).join(', ')} (apply false)`);
        }
      }
    } else {
      mb = gradleBlockAdd(mb, 'plugins', plugins.map((p) => `id("${p.id}") version "${version(p.version)}"`));
      mb = gradleBlockAdd(mb, 'dependencies', libs.map((l) => `${l.config ?? 'implementation'}("${l.coord}:${version(l.version)}")`));
    }
    files.set(moduleBuild, mb);
    summary.push(`Update ${moduleBuild}: plugins (${plugins.map((p) => p.key).join(', ')}) and dependencies (Retrofit, OkHttp logging, kotlinx.serialization${arch === 'retrofit-hilt' ? ', Hilt' : arch === 'retrofit-koin' ? ', Koin' : ''})`);
  } else warnings.push(`No ${module}/build.gradle.kts was found; add Retrofit, the kotlinx.serialization converter and OkHttp logging yourself.`);

  const conventions: Conventions = {
    ...c0,
    http: 'retrofit',
    serialization: 'kotlinx',
    di: arch === 'retrofit-hilt' ? 'hilt' : arch === 'retrofit-koin' ? 'koin' : 'manual',
    diFile: netFile,
    apiFolder: `${pkgDir}/data/remote`,
    modelsFolder: `${pkgDir}/data/model`,
    screensFolder: c0.screensFolder || `${pkgDir}/ui/screens`,
    baseUrl,
  };
  summary.push(`Save conventions: Retrofit interfaces in ${pkg}.data.remote, data classes in ${pkg}.data.model, registration with ${conventions.di}`);
  return { files, summary, warnings, generated: [], conventions, dependenciesChanged: true };
}
