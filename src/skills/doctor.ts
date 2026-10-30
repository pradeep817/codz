// doctor: read-only health checks over the project map.
//
//   locales     missing keys (error), extra keys, untranslated texts, unused keys
//   api         calls with no error handling, endpoints without a typed response
//   urls        hardcoded http(s) URLs outside config / network setup
//   models      models nothing uses
//
// Exit code 1 when any error is found (or any warning with --strict).

import { join } from 'node:path';
import { matchBrace } from '../adapters/source.ts';
import { loadMap } from '../core/cache.ts';
import { loadConfig } from '../core/config.ts';
import { readText, walk } from '../core/fsutil.ts';
import type { Adapter, ProjectMap } from '../core/types.ts';
import { readLocales } from './locale.ts';

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  check: 'locales' | 'api' | 'urls' | 'models';
  severity: Severity;
  message: string;
  file?: string;
  line?: number;
  fix?: string;
  /** What `doctor --fix` needs to repair this finding. */
  data?: { kind: 'missingKeys'; lang: string; keys: string[] } | { kind: 'url'; url: string; index: number } | { kind: 'unusedModel'; name: string } | { kind: 'untyped'; endpoint: string };
}

export interface DoctorReport {
  findings: Finding[];
  counts: Record<Severity, number>;
}

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

/** Code files with comments blanked (same length, so offsets and lines stay right). */
function codeFiles(root: string, map: ProjectMap): Map<string, string> {
  const exts = map.framework === 'flutter' ? ['.dart'] : map.framework === 'android' ? ['.kt'] : ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
  const start = map.framework === 'flutter' ? 'lib' : '.';
  const out = new Map<string, string>();
  for (const f of walk(root, start, { exts, extraIgnored: ['.codz', 'test', '__tests__', 'generated', 'build', '.gradle', 'androidTest'] })) {
    if (/\.(g|freezed|d)\.(dart|ts)$/.test(f) || /(^|\/)(next|tailwind|postcss|eslint|vitest|jest)\.config\./.test(f)) continue;
    out.set(f, stripComments(readText(join(root, f)) ?? ''));
  }
  return out;
}

function stripComments(t: string): string {
  let out = '';
  let i = 0;
  while (i < t.length) {
    const c = t[i];
    const n = t[i + 1];
    if (c === '/' && n === '/') {
      const end = t.indexOf('\n', i);
      const stop = end === -1 ? t.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (c === '/' && n === '*') {
      const end = t.indexOf('*/', i + 2);
      const stop = end === -1 ? t.length : end + 2;
      out += t.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < t.length && t[j] !== c && !(c !== '`' && t[j] === '\n')) j += t[j] === '\\' ? 2 : 1;
      out += t.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// ---------------- locales ----------------

function checkLocales(root: string, map: ProjectMap, code: Map<string, string>, findings: Finding[]): void {
  let set;
  try {
    set = readLocales(root, map);
  } catch (e) {
    findings.push({ check: 'locales', severity: 'error', message: (e as Error).message });
    return;
  }
  if (!set || !set.files.size) return;
  const def = set.keys.get(set.defaultLang) ?? new Map<string, string>();
  for (const [lang, keys] of set.keys) {
    if (lang === set.defaultLang) continue;
    const file = set.files.get(lang);
    const missing = [...def.keys()].filter((k) => !keys.has(k));
    const extra = [...keys.keys()].filter((k) => !def.has(k));
    const same = [...keys.entries()].filter(([k, v]) => def.get(k) === v && /[A-Za-z]{3,}/.test(v) && !/^[A-Z0-9_]+$/.test(v));
    if (missing.length) {
      findings.push({ check: 'locales', severity: 'error', file, message: `${lang} is missing ${missing.length} key${missing.length === 1 ? '' : 's'}: ${list(missing)}`, fix: `codz doctor --fix adds them with the ${set.defaultLang} text, or: codz locale key ${missing[0]} "${(def.get(missing[0]) ?? '').replace(/"/g, '\\"')}" --value ${lang}="<${lang} text>" --force`, data: { kind: 'missingKeys', lang, keys: missing } });
    }
    if (extra.length) findings.push({ check: 'locales', severity: 'warning', file, message: `${lang} has ${extra.length} key${extra.length === 1 ? '' : 's'} the ${set.defaultLang} file does not: ${list(extra)}` });
    if (same.length) findings.push({ check: 'locales', severity: 'info', file, message: `${same.length} ${lang} text${same.length === 1 ? ' is' : 's are'} the same as ${set.defaultLang} (not translated yet?): ${list(same.map(([k]) => k))}` });
  }

  // Unused keys: look for the key where the framework would use it.
  const localeFiles = new Set(set.files.values());
  const all = [...code.entries()].filter(([f]) => !localeFiles.has(f)).map(([, t]) => t).join('\n');
  // next-intl / i18next: useTranslations('home') / getTranslations('home') / useTranslation('home')
  // with t('title') in the same file uses home.title. Collected per file, so namespaces do not mix.
  const usedViaNamespace = new Set<string>();
  for (const [f, t] of code) {
    if (localeFiles.has(f)) continue;
    const namespaces = [...t.matchAll(/\b(?:useTranslations|getTranslations|useTranslation)\s*\(\s*(?:\{\s*namespace\s*:\s*)?['"`]([\w.-]+)['"`]/g)].map((m) => m[1]);
    const calls = [...t.matchAll(/\bt(?:\.rich|\.markup|\.raw)?\s*\(\s*['"`]([\w.-]+)['"`]/g)].map((m) => m[1]);
    for (const c of calls) {
      usedViaNamespace.add(c);
      for (const ns of namespaces) usedViaNamespace.add(`${ns}.${c}`);
    }
  }
  const unused = [...def.keys()].filter((key) => {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (set!.kind === 'arb') return !new RegExp(`\\.${esc}\\b`).test(all);
    if (usedViaNamespace.has(key)) return false;
    if (new RegExp(`['"\`]${esc}['"\`]`).test(all)) return false;
    // A whole namespace passed on (t used for a child component's keys) counts for its keys.
    return ![...usedViaNamespace].some((u) => key.startsWith(`${u}.`));
  });
  // A dynamic lookup (t(`x.${y}`), key.tr on a variable) makes "unused" unreliable.
  const dynamic = /\bt\(\s*`[^`]*\$\{|\b\w+\.tr\b(?!['"])/.test(all.replace(/['"][^'"\n]*['"]\.tr\b/g, ''));
  if (unused.length) {
    findings.push({
      check: 'locales',
      severity: 'info',
      file: set.files.get(set.defaultLang),
      message: `${unused.length} key${unused.length === 1 ? ' looks' : 's look'} unused: ${list(unused)}${dynamic ? ' (some keys are looked up dynamically, so check before deleting)' : ''}`,
    });
  }
}

function list(xs: string[], n = 6): string {
  return xs.slice(0, n).join(', ') + (xs.length > n ? `, … (${xs.length - n} more)` : '');
}

// ---------------- api ----------------

function insideTry(text: string, index: number): boolean {
  for (const m of text.slice(0, index).matchAll(/\btry\s*\{/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchBrace(text, open, 'dart');
    if (close === -1 || close > index) return true;
  }
  return false;
}

function enclosingFunctionHandles(text: string, index: number, framework: string): boolean {
  // Look at the statement: .catchError / .catch( / onError chained after the call.
  const after = text.slice(index, index + 400);
  const stmtEnd = after.search(/;\s*(\n|$)/);
  const stmt = stmtEnd === -1 ? after : after.slice(0, stmtEnd);
  if (framework === 'android' && /\brunCatching\s*\{/.test(text.slice(Math.max(0, index - 200), index))) return true;
  if (/\.catchError\(|\.catch\(|onError\s*:|\.then\([^)]*,\s*\(?\w*\)?\s*=>/.test(stmt)) return true;
  if (framework === 'flutter') {
    // Riverpod turns errors into AsyncValue.error; AsyncValue.guard catches too.
    const before = text.slice(Math.max(0, index - 1500), index);
    if (/AsyncValue\.guard\s*\(/.test(before.slice(-300))) return true;
    if (/\b(FutureProvider|StreamProvider)(\.\w+)*(<[^>]*>)?\s*\(/.test(before) || /extends\s+(_\$\w+|AsyncNotifier|FamilyAsyncNotifier|AutoDisposeAsyncNotifier)\b/.test(text)) return true;
  }
  return false;
}

function checkApi(root: string, map: ProjectMap, code: Map<string, string>, findings: Finding[]): void {
  const next = map.framework === 'nextjs';
  for (const ep of map.endpoints) {
    for (const f of new Set(ep.calledFrom)) {
      const t = code.get(f);
      if (t === undefined || f === ep.file) continue;
      // Next.js: server components and route handlers fall back to error.tsx; client code must handle errors.
      if (next && !/^\s*['"]use client['"]/.test(t)) continue;
      const re = new RegExp(`\\b${ep.name}\\s*\\(`, 'g');
      for (const m of t.matchAll(re)) {
        const lineStart = t.lastIndexOf('\n', m.index!) + 1;
        const lineText = t.slice(lineStart, t.indexOf('\n', m.index!) === -1 ? t.length : t.indexOf('\n', m.index!));
        if (/\b(import|export|function|Future<|async\s+\w+\s*\()/.test(lineText.slice(0, m.index! - lineStart)) && !/await|=/.test(lineText)) continue;
        if (insideTry(t, m.index!) || enclosingFunctionHandles(t, m.index!, map.framework)) continue;
        // FutureBuilder / StreamBuilder put the error in snapshot.error; only a builder that ignores it is a problem.
        const fb = /\b(FutureBuilder|StreamBuilder)\b[\s\S]{0,200}$/.exec(t.slice(Math.max(0, m.index! - 200), m.index!));
        if (fb) {
          const rest = t.slice(m.index!, m.index! + 1200);
          if (/hasError|\.error\b|ConnectionState/.test(rest)) continue;
          findings.push({
            check: 'api',
            severity: 'warning',
            file: f,
            line: lineOf(t, m.index!),
            message: `${ep.name}() runs in a ${fb[1]} whose builder never checks snapshot.hasError, so a failed request shows as empty data.`,
            fix: 'Handle snapshot.hasError in the builder (show an error message and a retry).',
          });
          continue;
        }
        // useQuery / useSWR report errors through their own state.
        if (next && /\b(useQuery|useSWR|useMutation|useSuspenseQuery)\s*\(/.test(t.slice(Math.max(0, m.index! - 300), m.index!))) continue;
        findings.push({
          check: 'api',
          severity: 'warning',
          file: f,
          line: lineOf(t, m.index!),
          message: `${ep.name}() is called without error handling; a failed request ${map.framework === 'flutter' ? 'throws a DioException' : map.framework === 'android' ? 'throws an HttpException or IOException (and crashes a coroutine without a handler)' : next ? 'throws in the browser' : 'throws'} here.`,
          fix: map.framework === 'flutter' ? 'Wrap the call in try { … } on DioException catch (e) { … } and show an error state.' : map.framework === 'android' ? 'Wrap the call in try { … } catch (e: Exception) { … } (or runCatching) and expose an error state.' : 'Wrap the call in try/catch (or use .catch) and show an error state.',
        });
      }
    }
    const r = (ep.response ?? '').replace(/\s/g, '');
    if (!r || /^(dynamic|any|unknown|Object|Object\?|Map<String,dynamic>|Record<string,any>|Record<string,unknown>|Response|Response<dynamic>|Future<dynamic>|Promise<any>|Promise<unknown>)$/.test(r)) {
      findings.push({
        check: 'api',
        severity: 'warning',
        file: ep.file,
        message: `${ep.name}() (${ep.method} ${ep.path}) returns ${r || 'an untyped value'}; callers get no type checking.`,
        fix: `codz api update ${ep.name} --sample response.json builds a typed model from a real response.`,
        data: { kind: 'untyped', endpoint: ep.name },
      });
    }
  }
}

// ---------------- urls ----------------

function checkUrls(map: ProjectMap, code: Map<string, string>, findings: Finding[]): void {
  const allowedFiles = new Set([map.conventions.networkFile, map.conventions.httpHelperFile, map.conventions.diFile].filter(Boolean));
  for (const [f, t] of code) {
    if (allowedFiles.has(f) || /(^|\/)(env|config|constants?|app_config|environment)s?\.(ts|js|dart)$/.test(f) || /(^|\/)(ApiConfig|Config|Constants|Env)\.kt$/.test(f) || /(^|\/)(config|env)\//.test(f)) continue;
    for (const m of t.matchAll(/(['"`])(https?:\/\/[^'"`\s]+)\1/g)) {
      const url = m[2];
      if (/^https?:\/\/(www\.)?(w3\.org|schema\.org|json-schema\.org|xmlns\.com)/.test(url)) continue;
      const isAsset = /\.(png|jpe?g|gif|svg|webp|ico|mp4|woff2?)(\?|$)/i.test(url) || /(fonts\.googleapis|images\.unsplash|picsum\.photos|placehold)/.test(url);
      const lineStart = t.lastIndexOf('\n', m.index!) + 1;
      const looksApi = /\/api\b|\/v\d+\b|localhost|127\.0\.0\.1|:\d{4}/.test(url) || /\b(fetch|axios|dio|http|get|post|put|patch|delete|baseUrl|BaseOptions)\b/i.test(t.slice(lineStart, m.index!));
      if (isAsset && !looksApi) continue;
      findings.push({
        check: 'urls',
        severity: looksApi ? 'warning' : 'info',
        file: f,
        line: lineOf(t, m.index!),
        message: `Hardcoded URL ${url}${looksApi ? ' looks like an API address' : ''}.`,
        fix: map.framework === 'flutter' ? 'Read it from the base URL in your network setup (or --dart-define) instead.' : map.framework === 'android' ? 'Keep it in one place (ApiConfig.BASE_URL or a buildConfigField) and use that.' : `Read it from ${map.conventions.baseUrlEnv || 'an env variable such as NEXT_PUBLIC_API_URL'} instead.`,
        data: { kind: 'url', url, index: m.index! + 1 },
      });
    }
  }
}

// ---------------- models ----------------

function checkModels(map: ProjectMap, code: Map<string, string>, findings: Finding[]): void {
  for (const model of map.models) {
    const re = new RegExp(`\\b${model.name}\\b`);
    const used = [...code.entries()].some(([f, t]) => {
      if (f !== model.file) return re.test(t);
      // In its own file, count uses beyond the declaration (and fromJson/toJson of itself).
      const n = [...t.matchAll(new RegExp(`\\b${model.name}\\b`, 'g'))].length;
      const self = [...t.matchAll(new RegExp(`(class|interface|type|enum)\\s+${model.name}\\b|${model.name}\\.(fromJson|_)|${model.name}\\s*\\(|factory\\s+${model.name}\\b|_\\$${model.name}`, 'g'))].length;
      return n > self;
    });
    if (!used) findings.push({ check: 'models', severity: 'info', file: model.file, message: `The model ${model.name} is not used anywhere.`, fix: 'Delete it if it is left over from a removed endpoint (codz doctor --fix does that).', data: { kind: 'unusedModel', name: model.name } });
  }
}

export async function runDoctor(root: string, adapter: Adapter, opts: { only?: string[] } = {}): Promise<DoctorReport> {
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions, { force: true });
  const code = codeFiles(root, map);
  const findings: Finding[] = [];
  const want = (c: string) => !opts.only?.length || opts.only.includes(c);
  if (want('locales')) checkLocales(root, map, code, findings);
  if (want('api')) checkApi(root, map, code, findings);
  if (want('urls')) checkUrls(map, code, findings);
  if (want('models')) checkModels(map, code, findings);
  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.check.localeCompare(b.check) || (a.file ?? '').localeCompare(b.file ?? '') || (a.line ?? 0) - (b.line ?? 0));
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return { findings, counts };
}

export function renderDoctor(r: DoctorReport, color: boolean): string {
  const paint = (s: Severity, t: string) => (!color ? t : s === 'error' ? `\x1b[31m${t}\x1b[0m` : s === 'warning' ? `\x1b[33m${t}\x1b[0m` : `\x1b[2m${t}\x1b[0m`);
  const icon = { error: '✗', warning: '!', info: 'i' };
  if (!r.findings.length) return 'No problems found.';
  const out: string[] = [];
  const titles: Record<Finding['check'], string> = { locales: 'Locales', api: 'API calls', urls: 'Hardcoded URLs', models: 'Models' };
  for (const check of ['locales', 'api', 'urls', 'models'] as const) {
    const fs = r.findings.filter((f) => f.check === check);
    if (!fs.length) continue;
    out.push(titles[check]);
    for (const f of fs) {
      const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}  ` : '';
      out.push(paint(f.severity, `  ${icon[f.severity]} ${where}${f.message}`));
      if (f.fix) out.push(`    → ${f.fix}`);
    }
    out.push('');
  }
  out.push(`${r.counts.error} error${r.counts.error === 1 ? '' : 's'}, ${r.counts.warning} warning${r.counts.warning === 1 ? '' : 's'}, ${r.counts.info} note${r.counts.info === 1 ? '' : 's'}`);
  return out.join('\n');
}
