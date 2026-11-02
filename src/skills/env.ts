// codz env add <name> --base-url <url>, and codz env list: named API
// environments (staging, qa, ...) in each platform's own way.
//
//   Next.js      .env.<name> + dev:<name> / build:<name> scripts (dotenv-cli; development, production and test need none)
//   React (Vite) .env.<name> + dev:<name> / build:<name> with --mode <name>
//   Expo         .env.<name> + start:<name> (dotenv-cli)
//   RN CLI       an API_URLS table in src/config/env.ts; APP_ENV picks one
//   Flutter      env/<name>.json for --dart-define-from-file; the Dio base URL reads API_BASE_URL
//   Android      an apiUrls table in app/build.gradle(.kts); -PapiEnv=<name> picks one, into BuildConfig.BASE_URL
//   iOS          an AppEnvironment enum; the scheme's APP_ENV variable picks one
//
// The URL you have now becomes the "default" environment. Never touches
// .env.local; base URLs are not secrets, so the files are meant to be committed.

import { join, posix } from 'node:path';
import { loadMap } from '../core/cache.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { loadConfig } from '../core/config.ts';
import { exists, readText, walk } from '../core/fsutil.ts';
import { ToolError, type Adapter, type ChangeSet, type ProjectMap } from '../core/types.ts';

export interface EnvInfo {
  name: string;
  baseUrl: string;
  where: string;
}

const DOTENV_CLI = '^7.4.2';

function checkName(name: string): void {
  if (!/^[a-z][a-z0-9]{0,30}$/.test(name)) throw new ToolError('bad_args', `"${name}" is not an environment name.`, 'Use lower-case letters and digits, starting with a letter: staging, qa, dev2.');
  if (name === 'default' || name === 'local' || name === 'example') throw new ToolError('bad_args', `"${name}" is reserved.`, name === 'default' ? 'default is the base URL you have now.' : 'Pick another name, like staging or qa.');
}

function checkUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ToolError('bad_args', `"${url}" is not a URL.`, 'Example: --base-url https://staging.example.com');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ToolError('bad_args', 'The base URL must start with https:// or http://.');
  if (u.username || u.password) throw new ToolError('bad_args', 'The base URL contains a user name or password; codz never writes those into code.', 'Use the project\'s auth setup for credentials.');
  return url.replace(/\/+$/, '');
}

const isEnvFile = (f: string) => /^\.env\.[a-z][a-z0-9]*$/.test(f) && !/\.(example|local|sample|template)$/.test(f);

/** The env variable the app reads its base URL from (Next.js, Vite, Expo), from the config or the env files. */
function envVar(map: ProjectMap, prefix: RegExp): string | null {
  const fromConfig = map.conventions.baseUrlEnv;
  if (fromConfig && prefix.test(fromConfig)) return fromConfig;
  return map.baseUrls.find((b) => prefix.test(b.name) && /^\.env/.test(posix.basename(b.file)))?.name ?? null;
}

function setEnvLine(text: string | null, key: string, value: string): string {
  const line = `${key}=${value}`;
  if (text === null || !text.trim()) return `# API base URL for this environment (codz env add). Not for secrets: this file is meant to be committed.\n${line}\n`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, '\n')}${line}\n`;
}

/** package.json with scripts (and devDependencies) added, keeping its indentation; null when nothing changes. */
function withScripts(text: string, scripts: Record<string, string>, devDeps: Record<string, string> = {}): string | null {
  let pkg: { scripts?: Record<string, string>; devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(text);
  } catch {
    throw new ToolError('bad_config', 'package.json is not valid JSON.');
  }
  const indent = /\n(\s+)"/.exec(text)?.[1] ?? '  ';
  let changed = false;
  pkg.scripts ??= {};
  for (const [k, v] of Object.entries(scripts)) {
    if (pkg.scripts[k] === v) continue;
    pkg.scripts[k] = v;
    changed = true;
  }
  for (const [k, v] of Object.entries(devDeps)) {
    if (pkg.devDependencies?.[k] || pkg.dependencies?.[k]) continue;
    pkg.devDependencies = { ...(pkg.devDependencies ?? {}), [k]: v };
    changed = true;
  }
  return changed ? `${JSON.stringify(pkg, null, indent)}\n` : null;
}

interface Plan {
  files: Map<string, string>;
  summary: string[];
  warnings: string[];
}

// ---------- env files: Next.js, Vite, Expo ----------

function planDotenv(root: string, map: ProjectMap, kind: 'nextjs' | 'vite' | 'expo', name: string, url: string, force: boolean, p: Plan): void {
  const prefix = kind === 'nextjs' ? /^NEXT_PUBLIC_\w+$/ : kind === 'vite' ? /^VITE_\w+$/ : /^EXPO_PUBLIC_\w+$/;
  const key = envVar(map, prefix);
  if (!key) {
    const want = kind === 'nextjs' ? 'NEXT_PUBLIC_API_URL' : kind === 'vite' ? 'VITE_API_URL' : 'EXPO_PUBLIC_API_URL';
    throw new ToolError('no_base_url', `codz could not find the env variable your app reads its base URL from (like ${want}).`, 'Run codz setup, or set baseUrlEnv in codz.config.yaml to its name.');
  }
  const file = `.env.${name}`;
  const before = readText(join(root, file));
  const old = before && new RegExp(`^${key}=(.*)$`, 'm').exec(before)?.[1];
  if (old && old !== url && !force) throw new ToolError('env_exists', `${file} already sets ${key}=${old}.`, 'Pass --force to change it.');
  const after = setEnvLine(before, key, url);
  if (after !== before) {
    p.files.set(file, after);
    p.summary.push(`${before === null ? 'Create' : 'Update'} ${file}: ${key}=${url}`);
  }
  const builtIn = kind === 'nextjs' ? ['development', 'production', 'test'] : kind === 'vite' ? ['development', 'production'] : [];
  const pkgText = readText(join(root, 'package.json'));
  if (builtIn.includes(name)) {
    p.summary.push(kind === 'nextjs' ? `Next.js reads ${file} by itself in ${name === 'development' ? 'next dev' : name === 'production' ? 'next build and next start' : 'tests'}; no script needed.` : `Vite reads ${file} by itself in ${name === 'development' ? 'vite (dev)' : 'vite build'}; no script needed.`);
  } else if (pkgText !== null) {
    const pkg = JSON.parse(pkgText) as { scripts?: Record<string, string> };
    let scripts: Record<string, string>;
    let deps: Record<string, string> = {};
    if (kind === 'vite') {
      const build = pkg.scripts?.build && /\bvite build\b/.test(pkg.scripts.build) ? pkg.scripts.build.replace(/\bvite build\b/, `vite build --mode ${name}`) : `vite build --mode ${name}`;
      scripts = { [`dev:${name}`]: `vite --mode ${name}`, [`build:${name}`]: build };
    } else if (kind === 'nextjs') {
      scripts = { [`dev:${name}`]: `dotenv -e ${file} -- next dev`, [`build:${name}`]: `dotenv -e ${file} -- next build` };
      deps = { 'dotenv-cli': DOTENV_CLI };
    } else {
      scripts = { [`start:${name}`]: `dotenv -e ${file} -- expo start` };
      deps = { 'dotenv-cli': DOTENV_CLI };
    }
    const next = withScripts(pkgText, scripts, deps);
    if (next) {
      p.files.set('package.json', next);
      p.summary.push(`Update package.json: ${Object.keys(scripts).join(', ')}${Object.keys(deps).length && !/"dotenv-cli"/.test(pkgText) ? ' (and dotenv-cli, to load the file)' : ''}`);
      if (Object.keys(deps).length && !/"dotenv-cli"/.test(pkgText)) p.warnings.push('Run npm install to get dotenv-cli.');
    }
    const run = kind === 'expo' ? `npm run start:${name}` : `npm run dev:${name}`;
    p.summary.push(`Run against ${name}: ${run}`);
  }
  if (kind === 'nextjs' && exists(join(root, '.env.local'))) p.warnings.push(`.env.local overrides ${file} in next dev when it sets ${key} too; the ${name} scripts set ${key} before Next.js starts, so they win.`);
}

function listDotenv(root: string, map: ProjectMap, prefix: RegExp): EnvInfo[] {
  const key = envVar(map, prefix);
  if (!key) return [];
  const out: EnvInfo[] = [];
  const def = map.baseUrls.find((b) => b.name === key);
  if (def) out.push({ name: 'default', baseUrl: def.value, where: def.file });
  for (const f of walk(root, '.', { maxFiles: 400 }).filter((x) => !x.includes('/') && isEnvFile(x))) {
    const v = new RegExp(`^${key}=(.*)$`, 'm').exec(readText(join(root, f)) ?? '')?.[1];
    if (v) out.push({ name: f.slice(5), baseUrl: v, where: f });
  }
  return out;
}

// ---------- React Native CLI: a table in env.ts ----------

function planRnTable(root: string, map: ProjectMap, name: string, url: string, force: boolean, p: Plan): void {
  const file = map.baseUrls.find((b) => b.name === 'API_URL')?.file ?? `${map.conventions.srcDir ?? 'src'}/config/env.ts`;
  const text = readText(join(root, file));
  if (text === null) throw new ToolError('no_base_url', `Cannot read ${file}, where the API URL should be.`, 'Run codz setup first.');
  const q = /'/.test(text) ? "'" : '"';
  let next: string;
  const table = /const API_URLS = \{([^}]*)\}/.exec(text);
  if (table) {
    const has = new RegExp(`^\\s*${name}:\\s*['"]([^'"]*)['"]`, 'm').exec(table[1]);
    if (has && has[1] !== url && !force) throw new ToolError('env_exists', `${name} is already ${has[1]}.`, 'Pass --force to change it.');
    const body = has ? table[1].replace(has[0], has[0].replace(has[1], url)) : `${table[1].replace(/\s*$/, '')}\n  ${name}: ${q}${url}${q},\n`;
    next = text.replace(table[0], `const API_URLS = {${body}}`);
  } else {
    const m = /^export const API_URL(?::\s*string)?\s*=\s*['"]([^'"]*)['"];?[ \t]*$/m.exec(text);
    if (!m) throw new ToolError('not_supported', `${file} does not set API_URL to a plain string, so codz left it alone.`, `Add the table yourself: const API_URLS = { default: '...', ${name}: '${url}' }.`);
    const semi = m[0].trimEnd().endsWith(';') ? ';' : '';
    next = text.replace(
      m[0],
      [
        `/** The API for each environment (codz env add). APP_ENV picks one. */`,
        `const API_URLS = {`,
        `  default: ${q}${m[1]}${q},`,
        `  ${name}: ${q}${url}${q},`,
        `} as const${semi}`,
        '',
        `export type AppEnv = keyof typeof API_URLS${semi}`,
        `export const APP_ENV: AppEnv = ${q}default${q}${semi}`,
        `export const API_URL: string = API_URLS[APP_ENV]${semi}`,
      ].join('\n'),
    );
  }
  if (next !== text) {
    p.files.set(file, next);
    p.summary.push(`Update ${file}: ${name} → ${url} in API_URLS`);
  }
  p.summary.push(`Switch with: codz env use ${name} (sets APP_ENV in ${file})`);
}

function listRnTable(root: string, map: ProjectMap): EnvInfo[] {
  const b = map.baseUrls.find((x) => x.name === 'API_URL');
  const file = b?.file ?? 'src/config/env.ts';
  const text = readText(join(root, file)) ?? '';
  const table = /const API_URLS = \{([^}]*)\}/.exec(text);
  if (!table) return b ? [{ name: 'default', baseUrl: b.value, where: file }] : [];
  return [...table[1].matchAll(/^\s*(\w+):\s*['"]([^'"]*)['"]/gm)].map((m) => ({ name: m[1], baseUrl: m[2], where: file }));
}

// ---------- Flutter: env/<name>.json and String.fromEnvironment ----------

const FLUTTER_KEY = 'API_BASE_URL';

function planFlutter(root: string, map: ProjectMap, name: string, url: string, force: boolean, p: Plan): void {
  const b = map.baseUrls.find((x) => /baseUrl/i.test(x.name) && x.file.endsWith('.dart'));
  const dioFile = b?.file ?? map.conventions.networkFile;
  const text = dioFile ? readText(join(root, dioFile)) : null;
  if (!dioFile || text === null) throw new ToolError('no_base_url', 'codz could not find where Dio gets its base URL.', 'Run codz setup, or set networkFile in codz.config.yaml.');
  let key = /String\.fromEnvironment\(\s*'(\w+)'/.exec(text)?.[1];
  if (!key) {
    const m = /baseUrl:\s*(['"])([^'"]+)\1/.exec(text);
    if (!m) throw new ToolError('not_supported', `${dioFile} does not set baseUrl to a plain string, so codz left it alone.`, `Make it read the environment: baseUrl: const String.fromEnvironment('${FLUTTER_KEY}', defaultValue: '...').`);
    key = FLUTTER_KEY;
    p.files.set(dioFile, text.replace(m[0], `baseUrl: const String.fromEnvironment('${key}', defaultValue: ${m[1]}${m[2]}${m[1]})`));
    p.summary.push(`Update ${dioFile}: the base URL comes from ${key} (default ${m[2]})`);
  }
  const file = `env/${name}.json`;
  const before = readText(join(root, file));
  let data: Record<string, unknown> = {};
  if (before !== null) {
    try {
      data = JSON.parse(before);
    } catch {
      throw new ToolError('bad_config', `${file} is not valid JSON.`);
    }
    if (typeof data[key] === 'string' && data[key] !== url && !force) throw new ToolError('env_exists', `${file} already sets ${key} to ${data[key]}.`, 'Pass --force to change it.');
  }
  const after = `${JSON.stringify({ ...data, [key]: url }, null, 2)}\n`;
  if (after !== before) {
    p.files.set(file, after);
    p.summary.push(`${before === null ? 'Create' : 'Update'} ${file}: ${key}=${url}`);
  }
  // A VS Code launch configuration, when there is no launch.json yet or it is plain JSON.
  const launchPath = '.vscode/launch.json';
  const launchText = readText(join(root, launchPath));
  const entry = { name: `${posix.basename(root)} (${name})`, request: 'launch', type: 'dart', args: [`--dart-define-from-file=${file}`] };
  try {
    const launch = launchText === null ? { version: '0.2.0', configurations: [] as { args?: string[] }[] } : (JSON.parse(launchText) as { configurations?: { args?: string[] }[] });
    launch.configurations ??= [];
    if (!launch.configurations.some((c) => c.args?.includes(`--dart-define-from-file=${file}`))) {
      launch.configurations.push(entry);
      p.files.set(launchPath, `${JSON.stringify(launch, null, 2)}\n`);
      p.summary.push(`${launchText === null ? 'Create' : 'Update'} ${launchPath}: a "${entry.name}" run configuration`);
    }
  } catch {
    p.warnings.push(`${launchPath} has comments, so codz did not change it. Add "args": ["--dart-define-from-file=${file}"] to a configuration for ${name}.`);
  }
  p.summary.push(`Run against ${name}: flutter run --dart-define-from-file=${file} (Flutter 3.7 or newer)`);
}

function listFlutter(root: string, map: ProjectMap): EnvInfo[] {
  const out: EnvInfo[] = [];
  const b = map.baseUrls.find((x) => /baseUrl/i.test(x.name) && x.file.endsWith('.dart'));
  if (b) out.push({ name: 'default', baseUrl: b.value, where: b.file });
  for (const f of walk(root, 'env', { exts: ['.json'] })) {
    try {
      const v = (JSON.parse(readText(join(root, f)) ?? '{}') as Record<string, unknown>)[FLUTTER_KEY];
      if (typeof v === 'string') out.push({ name: posix.basename(f, '.json'), baseUrl: v, where: f });
    } catch {
      // not ours
    }
  }
  return out;
}

// ---------- Android: an apiUrls table in the app build file ----------

function androidFiles(root: string, map: ProjectMap): { gradle: string; apiConfig: string | null } {
  const module = map.conventions.appModule || 'app';
  const gradle = [`${module}/build.gradle.kts`, `${module}/build.gradle`].find((f) => exists(join(root, f)));
  if (!gradle) throw new ToolError('not_supported', `No ${module}/build.gradle(.kts) was found.`);
  const src = map.conventions.srcDir || `${module}/src/main/java`;
  const apiConfig = walk(root, src, { exts: ['.kt'] }).find((f) => /^\s*(const\s+)?val\s+BASE_URL(\s*:\s*String)?\s*=/m.test(readText(join(root, f)) ?? '')) ?? null;
  return { gradle, apiConfig };
}

function planAndroid(root: string, map: ProjectMap, name: string, url: string, force: boolean, p: Plan): void {
  const { gradle, apiConfig } = androidFiles(root, map);
  const kts = gradle.endsWith('.kts');
  let g = readText(join(root, gradle))!;
  const withSlash = `${url}/`;
  const table = kts ? /val apiUrls = mapOf\(([^)]*)\)/.exec(g) : /def apiUrls = \[([^\]]*)\]/.exec(g);
  if (table) {
    const entryRe = kts ? new RegExp(`"${name}" to "([^"]*)"`) : new RegExp(`'${name}'\\s*:\\s*'([^']*)'`);
    const has = entryRe.exec(table[1]);
    if (has && has[1] !== withSlash && !force) throw new ToolError('env_exists', `${name} is already ${has[1]}.`, 'Pass --force to change it.');
    const line = kts ? `    "${name}" to "${withSlash}",` : `    '${name}': '${withSlash}',`;
    const body = has ? table[1].replace(has[0], kts ? `"${name}" to "${withSlash}"` : `'${name}': '${withSlash}'`) : `${table[1].replace(/\s*$/, '')}\n${line}\n`;
    g = g.replace(table[0], kts ? `val apiUrls = mapOf(${body})` : `def apiUrls = [${body}]`);
  } else {
    if (!apiConfig) throw new ToolError('no_base_url', 'codz could not find BASE_URL in your Kotlin code (like ApiConfig.BASE_URL).', 'Run codz setup, which writes data/remote/ApiConfig.kt.');
    const cfg = readText(join(root, apiConfig))!;
    const m = /^(\s*)(?:const\s+)?val\s+BASE_URL(?:\s*:\s*String)?\s*=\s*"([^"]*)"\s*$/m.exec(cfg);
    if (!m) throw new ToolError('not_supported', `BASE_URL in ${apiConfig} is not a plain string, so codz left it alone.`);
    const ns = map.conventions.namespace || /namespace\s*=?\s*["']([\w.]+)["']/.exec(g)?.[1];
    if (!ns) throw new ToolError('no_package', 'No namespace was found in the app build file.', 'Set namespace in codz.config.yaml.');
    const current = m[2].endsWith('/') ? m[2] : `${m[2]}/`;
    const head = kts
      ? ['// API base URLs (codz env add). Pick one with -PapiEnv=staging, or apiEnv=staging in gradle.properties.', 'val apiUrls = mapOf(', `    "default" to "${current}",`, `    "${name}" to "${withSlash}",`, ')', 'val apiEnv = (findProperty("apiEnv") as String?) ?: "default"']
      : ['// API base URLs (codz env add). Pick one with -PapiEnv=staging, or apiEnv=staging in gradle.properties.', 'def apiUrls = [', `    'default': '${current}',`, `    '${name}': '${withSlash}',`, ']', "def apiEnv = project.findProperty('apiEnv') ?: 'default'"];
    const plugins = /^plugins\s*\{[^]*?^\}\s*$/m.exec(g);
    if (!plugins) throw new ToolError('not_supported', `${gradle} has no plugins { } block where codz expects one.`);
    g = g.replace(plugins[0], `${plugins[0].trimEnd()}\n\n${head.join('\n')}\n\n`);
    const field = kts ? `        buildConfigField("String", "BASE_URL", "\\"\${apiUrls.getValue(apiEnv)}\\"")` : `        buildConfigField 'String', 'BASE_URL', "\\"\${apiUrls[apiEnv]}\\""`;
    const dc = /^(\s*)defaultConfig\s*\{\s*$/m.exec(g);
    if (!dc) throw new ToolError('not_supported', `${gradle} has no defaultConfig { } block.`);
    g = g.replace(dc[0], `${dc[0]}\n${field}`);
    const bf = /^(\s*)buildFeatures\s*\{\s*$/m.exec(g);
    if (bf) {
      if (!/buildConfig\s*=?\s*true/.test(g)) g = g.replace(bf[0], `${bf[0]}\n${bf[1]}    buildConfig ${kts ? '= ' : ''}true`);
    } else {
      const android = /^android\s*\{\s*$/m.exec(g);
      if (!android) throw new ToolError('not_supported', `${gradle} has no android { } block.`);
      g = g.replace(android[0], `${android[0]}\n    buildFeatures {\n        buildConfig ${kts ? '= ' : ''}true\n    }`);
    }
    let nextCfg = cfg.replace(m[0], `${m[1]}val BASE_URL: String = BuildConfig.BASE_URL`);
    if (!new RegExp(`^import ${ns.replace(/\./g, '\\.')}\\.BuildConfig$`, 'm').test(nextCfg)) nextCfg = nextCfg.replace(/^(package [\w.]+)\s*\n/m, `$1\n\nimport ${ns}.BuildConfig\n\n`);
    p.files.set(apiConfig, nextCfg);
    p.summary.push(`Update ${apiConfig}: BASE_URL comes from BuildConfig.BASE_URL (default ${current})`);
  }
  p.files.set(gradle, g);
  p.summary.push(`Update ${gradle}: ${name} → ${withSlash} in apiUrls`);
  p.summary.push(`Build against ${name}: ./gradlew installDebug -PapiEnv=${name} (or put apiEnv=${name} in gradle.properties for Android Studio)`);
}

function listAndroid(root: string, map: ProjectMap): EnvInfo[] {
  const { gradle, apiConfig } = androidFiles(root, map);
  const g = readText(join(root, gradle)) ?? '';
  const table = /val apiUrls = mapOf\(([^)]*)\)/.exec(g) ?? /def apiUrls = \[([^\]]*)\]/.exec(g);
  if (table) return [...table[1].matchAll(/["'](\w+)["']\s*(?:to|:)\s*["']([^"']*)["']/g)].map((m) => ({ name: m[1], baseUrl: m[2], where: gradle }));
  const v = apiConfig && /BASE_URL(?:\s*:\s*String)?\s*=\s*"([^"]*)"/.exec(readText(join(root, apiConfig)) ?? '')?.[1];
  return v ? [{ name: 'default', baseUrl: v, where: apiConfig! }] : [];
}

// ---------- iOS: an AppEnvironment enum ----------

function planIos(root: string, map: ProjectMap, name: string, url: string, force: boolean, p: Plan): void {
  const client = map.conventions.networkFile || map.baseUrls.find((b) => /baseURL/.test(b.name))?.file;
  const text = client ? readText(join(root, client)) : null;
  if (!client || text === null) throw new ToolError('no_base_url', 'codz could not find APIClient.swift.', 'Run codz setup, which writes Networking/APIClient.swift.');
  const envFile = `${posix.dirname(client)}/AppEnvironment.swift`;
  const I = /\n( +)\S/.exec(text)?.[1] ?? '    ';
  let env = readText(join(root, envFile));
  if (env === null) {
    const m = /URL\(string:\s*"([^"]+)"\)!/.exec(text);
    if (!m) throw new ToolError('not_supported', `${client} does not set its base URL with URL(string: "...")!, so codz left it alone.`);
    p.files.set(client, text.replace(m[0], 'AppEnvironment.current.baseURL'));
    p.summary.push(`Update ${client}: the base URL comes from AppEnvironment.current (default ${m[1]})`);
    env = [
      'import Foundation',
      '',
      '/// The API each environment talks to (codz env add). Pick one with the APP_ENV environment variable',
      '/// (Product → Scheme → Edit Scheme → Run → Arguments → Environment Variables), or change `fallback`.',
      'enum AppEnvironment: String, CaseIterable {',
      `${I}case \`default\``,
      '',
      `${I}static let fallback: AppEnvironment = .default`,
      '',
      `${I}static var current: AppEnvironment {`,
      `${I}${I}ProcessInfo.processInfo.environment["APP_ENV"].flatMap(AppEnvironment.init(rawValue:)) ?? fallback`,
      `${I}}`,
      '',
      `${I}var baseURL: URL {`,
      `${I}${I}switch self {`,
      `${I}${I}case .default: return URL(string: "${m[1]}")!`,
      `${I}${I}}`,
      `${I}}`,
      '}',
      '',
    ].join('\n');
  }
  const has = new RegExp(`case \\.${name}: return URL\\(string: "([^"]*)"\\)!`).exec(env);
  if (has && has[1] !== url && !force) throw new ToolError('env_exists', `${name} is already ${has[1]}.`, 'Pass --force to change it.');
  let next = env;
  if (has) next = env.replace(has[0], `case .${name}: return URL(string: "${url}")!`);
  else {
    const lastCase = [...env.matchAll(/^( +)case [`\w, ]+$/gm)].pop();
    const lastReturn = [...env.matchAll(/^( +)case \.\w+: return URL\(string: "[^"]*"\)!$/gm)].pop();
    if (!lastCase || !lastReturn) throw new ToolError('not_supported', `${envFile} is not laid out the way codz writes it; add the ${name} case yourself.`);
    // Later positions first, so the earlier offset stays valid.
    next = next.slice(0, lastReturn.index! + lastReturn[0].length) + `\n${lastReturn[1]}case .${name}: return URL(string: "${url}")!` + next.slice(lastReturn.index! + lastReturn[0].length);
    next = next.slice(0, lastCase.index! + lastCase[0].length) + `\n${lastCase[1]}case ${name}` + next.slice(lastCase.index! + lastCase[0].length);
  }
  if (next !== readText(join(root, envFile))) {
    p.files.set(envFile, next);
    p.summary.push(`${readText(join(root, envFile)) === null ? 'Create' : 'Update'} ${envFile}: ${name} → ${url}`);
  }
  p.summary.push(`Run against ${name}: set APP_ENV=${name} in the scheme's environment variables (Run → Arguments), or codz env use ${name}`);
}

function listIos(root: string, map: ProjectMap): EnvInfo[] {
  const client = map.conventions.networkFile || map.baseUrls.find((b) => /baseURL/.test(b.name))?.file;
  if (!client) return [];
  const envFile = `${posix.dirname(client)}/AppEnvironment.swift`;
  const env = readText(join(root, envFile));
  if (env === null) {
    const b = map.baseUrls.find((x) => /baseURL/.test(x.name));
    return b ? [{ name: 'default', baseUrl: b.value, where: b.file }] : [];
  }
  return [...env.matchAll(/case \.(\w+): return URL\(string: "([^"]*)"\)!/g)].map((m) => ({ name: m[1], baseUrl: m[2], where: envFile }));
}

// ---------- entry points ----------

type Kind = 'nextjs' | 'vite' | 'expo' | 'rn-cli' | 'flutter' | 'android' | 'ios';

function kindOf(adapter: Adapter, map: ProjectMap): Kind {
  if (adapter.id === 'nextjs') return 'nextjs';
  if (adapter.id === 'react') return 'vite';
  if (adapter.id === 'react-native') return envVar(map, /^EXPO_PUBLIC_\w+$/) ? 'expo' : 'rn-cli';
  if (adapter.id === 'flutter' || adapter.id === 'android' || adapter.id === 'ios') return adapter.id;
  throw new ToolError('not_supported', `env add needs a framework adapter; this project uses the ${adapter.id} adapter.`);
}

export async function planEnvAdd(root: string, adapter: Adapter, name: string, baseUrl: string | undefined, opts: { force?: boolean } = {}): Promise<ChangeSet> {
  if (!name) throw new ToolError('bad_args', 'Which environment? codz env add <name> --base-url <url>', 'Example: codz env add staging --base-url https://staging.example.com');
  checkName(name);
  if (!baseUrl) throw new ToolError('bad_args', `Give the base URL for ${name}: --base-url https://...`);
  const url = checkUrl(baseUrl);
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  const kind = kindOf(adapter, map);
  const p: Plan = { files: new Map(), summary: [], warnings: [] };
  const force = Boolean(opts.force);
  if (kind === 'nextjs' || kind === 'vite' || kind === 'expo') planDotenv(root, map, kind, name, url, force, p);
  else if (kind === 'rn-cli') planRnTable(root, map, name, url, force, p);
  else if (kind === 'flutter') planFlutter(root, map, name, url, force, p);
  else if (kind === 'android') planAndroid(root, map, name, url, force, p);
  else planIos(root, map, name, url, force, p);
  if (!p.files.size) p.summary.unshift(`${name} is already set to ${url}; nothing to change.`);
  return buildChangeSet(root, 'env add', { files: p.files, summary: p.summary, warnings: p.warnings, generated: [] });
}

export async function listEnvs(root: string, adapter: Adapter): Promise<EnvInfo[]> {
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  const kind = kindOf(adapter, map);
  if (kind === 'nextjs') return listDotenv(root, map, /^NEXT_PUBLIC_\w+$/);
  if (kind === 'vite') return listDotenv(root, map, /^VITE_\w+$/);
  if (kind === 'expo') return listDotenv(root, map, /^EXPO_PUBLIC_\w+$/);
  if (kind === 'rn-cli') return listRnTable(root, map);
  if (kind === 'flutter') return listFlutter(root, map);
  if (kind === 'android') return listAndroid(root, map);
  return listIos(root, map);
}

/** codz env use <name>: where the choice lives in the code (RN CLI's APP_ENV, iOS's fallback, Android's gradle.properties). */
export async function planEnvUse(root: string, adapter: Adapter, name: string): Promise<ChangeSet> {
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  const kind = kindOf(adapter, map);
  const envs = await listEnvs(root, adapter);
  if (!envs.some((e) => e.name === name)) throw new ToolError('no_env', `No environment called ${name}.`, envs.length ? `Environments: ${envs.map((e) => e.name).join(', ')}` : 'Add one with: codz env add <name> --base-url <url>');
  const files = new Map<string, string>();
  const summary: string[] = [];
  if (kind === 'rn-cli') {
    const file = envs[0].where;
    const text = readText(join(root, file))!;
    const next = text.replace(/(export const APP_ENV: AppEnv = )(['"])\w+\2/, `$1$2${name}$2`);
    if (next === text && !new RegExp(`APP_ENV: AppEnv = ['"]${name}['"]`).test(text)) throw new ToolError('not_supported', `Could not find APP_ENV in ${file}.`);
    if (next !== text) files.set(file, next);
    summary.push(`The app now uses ${name} (APP_ENV in ${file}). Reload the app.`);
  } else if (kind === 'ios') {
    const file = envs[0].where;
    const text = readText(join(root, file))!;
    const next = text.replace(/(static let fallback: AppEnvironment = )\.[`\w]+/, `$1.${name}`);
    if (next !== text) files.set(file, next);
    summary.push(`Builds now use ${name} unless the scheme sets APP_ENV (fallback in ${file}).`);
  } else if (kind === 'android') {
    const before = readText(join(root, 'gradle.properties'));
    const line = `apiEnv=${name}`;
    const next = before === null ? `${line}\n` : /^apiEnv=.*$/m.test(before) ? before.replace(/^apiEnv=.*$/m, line) : `${before.replace(/\s*$/, '\n')}${line}\n`;
    if (next !== before) files.set('gradle.properties', next);
    summary.push(`Builds now use ${name} (apiEnv in gradle.properties); -PapiEnv=<name> still overrides it. Sync Gradle in Android Studio.`);
  } else {
    const hint = kind === 'flutter' ? `flutter run --dart-define-from-file=env/${name}.json` : kind === 'expo' ? `npm run start:${name}` : `npm run dev:${name}`;
    throw new ToolError('not_needed', `In this project the environment is chosen when you run the app, not in the code.`, `Run: ${hint}`);
  }
  return buildChangeSet(root, 'env use', { files, summary, warnings: [], generated: [] });
}
