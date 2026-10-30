// Checks devtool.config.yaml: it parses, uses spaces, names a known framework,
// has known keys with allowed values, and its paths exist inside the project.
// Used by `devtool config check`, `devtool config set` and `devtool doctor --setup`.

import { isAbsolute, join, relative, resolve } from 'node:path';
import { FLUTTER_CONVENTION_DOCS } from '../adapters/flutter.ts';
import { NEXT_CONVENTION_DOCS } from '../adapters/nextjs.ts';
import { RN_CONVENTION_DOCS } from '../adapters/reactNative.ts';
import { REACT_CONVENTION_DOCS } from '../adapters/react.ts';
import { IOS_CONVENTION_DOCS } from '../adapters/ios.ts';
import { ANDROID_CONVENTION_DOCS } from '../adapters/android.ts';
import { exists } from './fsutil.ts';
import type { FrameworkId } from './types.ts';
import { parse, type YamlValue } from './yaml.ts';

export interface ConfigIssue {
  level: 'error' | 'warning';
  key?: string;
  message: string;
  hint?: string;
}

const FRAMEWORKS: FrameworkId[] = ['nextjs', 'flutter', 'react-native', 'react', 'android', 'ios', 'generic'];

/** Allowed values for keys that take one of a few words. Empty is always allowed (= detect). */
export const ALLOWED: Record<string, Record<string, string[]>> = {
  nextjs: {
    apiFileNaming: ['kebab', 'camel', 'pascal', 'snake'],
    modelFileNaming: ['kebab', 'camel', 'pascal', 'snake'],
    apiFileResource: ['plural', 'singular'],
    modelsLayout: ['per-file', 'single'],
    importStyle: ['alias', 'relative'],
    quote: ['single', 'double'],
    semicolons: ['true', 'false'],
    indent: ['2', '4', 'tab'],
    http: ['fetch', 'axios'],
    dataFetching: ['react-query', 'none'],
  },
  'react-native': {
    apiFileNaming: ['kebab', 'camel', 'pascal', 'snake'],
    modelFileNaming: ['kebab', 'camel', 'pascal', 'snake'],
    apiFileResource: ['plural', 'singular'],
    modelsLayout: ['per-file', 'single'],
    importStyle: ['alias', 'relative'],
    quote: ['single', 'double'],
    semicolons: ['true', 'false'],
    indent: ['2', '4', 'tab'],
    http: ['fetch', 'axios'],
    dataFetching: ['react-query', 'none'],
    flavor: ['expo', 'bare'],
    router: ['react-navigation', 'expo-router', 'none'],
  },
  react: {
    apiFileNaming: ['kebab', 'camel', 'pascal', 'snake'],
    modelFileNaming: ['kebab', 'camel', 'pascal', 'snake'],
    apiFileResource: ['plural', 'singular'],
    modelsLayout: ['per-file', 'single'],
    importStyle: ['alias', 'relative'],
    quote: ['single', 'double'],
    semicolons: ['true', 'false'],
    indent: ['2', '4', 'tab'],
    http: ['fetch', 'axios'],
    dataFetching: ['react-query', 'none'],
    bundler: ['vite', 'cra'],
    router: ['react-router', 'none'],
    routerStyle: ['jsx', 'data'],
  },
  ios: {
    ui: ['swiftui', 'uikit'],
    fileSync: ['synchronized', 'groups'],
    indent: ['2', '4'],
  },
  android: {
    http: ['retrofit', 'ktor', 'none'],
    serialization: ['kotlinx', 'moshi', 'gson'],
    di: ['hilt', 'koin', 'manual', 'none'],
    ui: ['compose', 'views'],
    indent: ['2', '4'],
  },
  flutter: {
    http: ['dio', 'http'],
    serialization: ['manual', 'json_serializable', 'freezed'],
    freezedClass: ['abstract', 'plain'],
    apiStyle: ['repository', 'retrofit'],
    repoKind: ['repository', 'service', 'api'],
    di: ['getx', 'riverpod', 'get_it', 'none'],
    importStyle: ['package', 'relative'],
    indent: ['2', '4'],
  },
};

/** Keys whose values are paths inside the project. */
export const PATH_KEYS = new Set(['appDir', 'apiFolder', 'httpHelperFile', 'modelsFolder', 'modelsFile', 'repoFolder', 'dioProviderFile', 'diFile', 'networkFile', 'modulesFolder', 'routesFile', 'axiosInstanceFile', 'hooksFolder', 'templatesFolder', 'screensFolder', 'navigatorFile', 'routerDir', 'configFile', 'srcDir', 'navFile', 'module']);

/** Path keys that devtool creates when missing (a fresh project), so a missing one is fine. */
const CREATED_ON_DEMAND = new Set(['screensFolder', 'navigatorFile', 'configFile', 'templatesFolder', 'hooksFolder', 'apiFolder', 'modelsFolder', 'repoFolder', 'modulesFolder', 'routesFile', 'modelsFile']);

/** The candidate closest to a misspelled word (at most two edits away), if any. */
export function closest(word: string, candidates: string[]): string | undefined {
  const dist = (a: string, b: string) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1] ? d[i - 2][j - 2] + 1 : Infinity);
    return d[a.length][b.length];
  };
  let best: string | undefined;
  let bestD = 3;
  for (const c of candidates) {
    const n = dist(word.toLowerCase(), c.toLowerCase());
    if (n < bestD) [best, bestD] = [c, n];
  }
  return best;
}

export function knownKeys(framework: string): Record<string, string> {
  return framework === 'nextjs' ? NEXT_CONVENTION_DOCS : framework === 'flutter' ? FLUTTER_CONVENTION_DOCS : framework === 'react-native' ? RN_CONVENTION_DOCS : framework === 'react' ? REACT_CONVENTION_DOCS : framework === 'ios' ? IOS_CONVENTION_DOCS : framework === 'android' ? ANDROID_CONVENTION_DOCS : {};
}

/** Checks one value; returns an issue or null. */
export function checkValue(framework: string, key: string, value: string, root?: string): ConfigIssue | null {
  if (value === '') return null;
  const allowed = ALLOWED[framework]?.[key];
  if (allowed && !allowed.includes(value)) {
    return { level: 'error', key, message: `${key} is "${value}", which is not one of: ${allowed.join(', ')}.`, hint: `devtool config set ${key} ${allowed[0]}` };
  }
  if (PATH_KEYS.has(key) && root) {
    if (isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
      const outside = relative(resolve(root), resolve(root, value)).startsWith('..') || isAbsolute(value);
      if (outside) return { level: 'error', key, message: `${key} (${value}) points outside the project.`, hint: 'Use a path relative to the folder that holds devtool.config.yaml.' };
    }
    if (!exists(join(root, value)) && !CREATED_ON_DEMAND.has(key)) {
      return { level: 'warning', key, message: `${key} (${value}) does not exist.`, hint: `Fix it with devtool config set ${key} <path>, or rescan with devtool init --force.` };
    }
  }
  return null;
}

export function validateConfig(text: string, root?: string): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const tabLine = text.split(/\r?\n/).findIndex((l) => /^\s*\t/.test(l));
  if (tabLine !== -1) {
    return [{ level: 'error', message: `Line ${tabLine + 1} is indented with a tab.`, hint: 'YAML needs spaces; replace the tab with two spaces.' }];
  }
  let data: { [key: string]: YamlValue };
  try {
    data = parse(text);
  } catch (e) {
    return [{ level: 'error', message: (e as Error).message.replace(/^devtool\.config\.yaml /, ''), hint: 'Fix the line, or recreate the file with devtool init --force.' }];
  }
  for (const key of Object.keys(data)) {
    if (key !== 'framework' && key !== 'conventions') issues.push({ level: 'warning', key, message: `Unknown top-level key "${key}"; devtool ignores it.` });
  }
  const framework = typeof data.framework === 'string' ? data.framework : '';
  if (!framework) issues.push({ level: 'error', key: 'framework', message: 'framework is missing.', hint: 'Add framework: nextjs or framework: flutter.' });
  else if (!FRAMEWORKS.includes(framework as FrameworkId)) issues.push({ level: 'error', key: 'framework', message: `framework "${framework}" is not one of: ${FRAMEWORKS.join(', ')}.` });

  const conv = data.conventions;
  if (conv === undefined) return issues;
  if (typeof conv !== 'object' || Array.isArray(conv)) {
    issues.push({ level: 'error', key: 'conventions', message: 'conventions must be a list of key: value lines.' });
    return issues;
  }
  const known = knownKeys(framework);
  for (const [key, value] of Object.entries(conv)) {
    if (typeof value !== 'string') {
      issues.push({ level: 'error', key, message: `${key} must be a single value.` });
      continue;
    }
    if (Object.keys(known).length && !(key in known)) {
      const close = closest(key, Object.keys(known));
      issues.push({ level: 'warning', key, message: `Unknown convention "${key}"; devtool ignores it.`, hint: close ? `Did you mean ${close}?` : undefined });
      continue;
    }
    const issue = checkValue(framework, key, value, root);
    if (issue) issues.push(issue);
  }
  return issues;
}
