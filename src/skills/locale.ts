// locale add / locale key: keep every language file in sync.
//
// Formats: JSON message files (next-intl, i18next; nested keys with dots),
// Flutter ARB files (gen-l10n), and GetX Translations classes. A GetX project
// without translations gets lib/app/translations/app_translations.dart, wired
// into GetMaterialApp.

import { join, posix } from 'node:path';
import { addDartImport, importUri } from '../adapters/flutter.ts';
import { matchBrace } from '../adapters/source.ts';
import { loadMap } from '../core/cache.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { loadConfig } from '../core/config.ts';
import { jsonSet } from '../core/jsonEdit.ts';
import { detectEol, readText, walk, withEol } from '../core/fsutil.ts';
import { ToolError, type Adapter, type ChangeSet, type ProjectMap } from '../core/types.ts';
import { camel } from '../input/naming.ts';

export type LocaleKind = 'json' | 'arb' | 'getx';

export interface LocaleSet {
  kind: LocaleKind;
  defaultLang: string;
  /** Language code → file (json, arb) or the Dart file holding that language's map (getx). */
  files: Map<string, string>;
  /** Language code → flattened key → text. */
  keys: Map<string, Map<string, string>>;
  /** GetX only: the Translations class file. */
  translationsFile?: string;
}

const COUNTRY: Record<string, string> = { en: 'US', hi: 'IN', es: 'ES', fr: 'FR', de: 'DE', it: 'IT', pt: 'BR', ar: 'SA', zh: 'CN', ja: 'JP', ko: 'KR', ru: 'RU', bn: 'IN', ta: 'IN', te: 'IN', mr: 'IN', gu: 'IN', kn: 'IN', ml: 'IN', pa: 'IN', ur: 'PK', tr: 'TR', nl: 'NL', id: 'ID', th: 'TH', vi: 'VN' };

/** GetX keys are language_COUNTRY (en_US); codz talks in language codes (en). */
const getxKey = (lang: string) => (/[_-]/.test(lang) ? lang.replace('-', '_') : COUNTRY[lang] ? `${lang}_${COUNTRY[lang]}` : lang);
const fromGetxKey = (k: string) => k.split(/[_-]/)[0];

function flatten(obj: unknown, prefix = '', out = new Map<string, string>()): Map<string, string> {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k.startsWith('@')) continue;
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
      else out.set(key, String(v));
    }
  }
  return out;
}

function jsonIndent(text: string): string | number {
  const m = /\n([ \t]+)"/.exec(text);
  if (!m) return 2;
  return m[1][0] === '\t' ? '\t' : m[1].length;
}

/** Finds GetX `'en_US': {...}` blocks, following `'en_US': enUS` to `const enUS = {...}` in other files. */
export function getxBlocks(root: string, file: string): { lang: string; code: string; file: string; open: number; close: number; text: string }[] {
  const t = readText(join(root, file)) ?? '';
  const out: { lang: string; code: string; file: string; open: number; close: number; text: string }[] = [];
  const keysGetter = /get\s+keys\s*=>\s*(?:<[^>]*>\s*)?\{/.exec(t) ?? /get\s+keys\s*\{\s*return\s*(?:<[^>]*>\s*)?\{/.exec(t);
  if (!keysGetter) return out;
  const mapOpen = keysGetter.index + keysGetter[0].length - 1;
  const mapClose = matchBrace(t, mapOpen, 'dart');
  const body = t.slice(mapOpen, mapClose);
  for (const m of body.matchAll(/['"]([A-Za-z]{2,3}(?:[_-][A-Za-z]{2,4})?)['"]\s*:\s*(\{|[A-Za-z_]\w*)/g)) {
    if (m[2] === '{') {
      const open = mapOpen + m.index! + m[0].length - 1;
      out.push({ lang: fromGetxKey(m[1]), code: m[1], file, open, close: matchBrace(t, open, 'dart'), text: t });
    } else {
      // A map defined elsewhere: const Map<String, String> enUS = {...};
      for (const f of walk(root, 'lib', { exts: ['.dart'] })) {
        const ft = readText(join(root, f)) ?? '';
        const d = new RegExp(`\\b(?:const|final)\\s+(?:Map<String,\\s*String>\\s+)?${m[2]}\\s*=\\s*(?:<[^>]*>\\s*)?\\{`).exec(ft);
        if (d) {
          const open = d.index + d[0].length - 1;
          out.push({ lang: fromGetxKey(m[1]), code: m[1], file: f, open, close: matchBrace(ft, open, 'dart'), text: ft });
          break;
        }
      }
    }
  }
  return out;
}

function getxEntries(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(['"])((?:\\.|(?!\1).)*)\1\s*:\s*(['"])((?:\\.|(?!\3).)*)\3/g)) out.set(m[2], m[4].replace(/\\(['"$\\])/g, '$1'));
  return out;
}

export function readLocales(root: string, map: ProjectMap): LocaleSet | null {
  // GetX translations first: they live in Dart, not in locale files.
  if (map.framework === 'flutter') {
    const file = walk(root, 'lib', { exts: ['.dart'] }).find((f) => /\bextends\s+Translations\b/.test(readText(join(root, f)) ?? ''));
    if (file) {
      const blocks = getxBlocks(root, file);
      const files = new Map<string, string>();
      const keys = new Map<string, Map<string, string>>();
      for (const b of blocks) {
        files.set(b.lang, b.file);
        keys.set(b.lang, getxEntries(b.text.slice(b.open, b.close + 1)));
      }
      const langs = [...files.keys()];
      return { kind: 'getx', defaultLang: langs.includes('en') ? 'en' : langs[0] ?? 'en', files, keys, translationsFile: file };
    }
  }
  if (!map.locales.files.length) return null;
  const kind: LocaleKind = map.locales.files[0].endsWith('.arb') ? 'arb' : 'json';
  const files = new Map<string, string>();
  const keys = new Map<string, Map<string, string>>();
  for (const f of map.locales.files) {
    const base = f.slice(f.lastIndexOf('/') + 1);
    const lang = kind === 'arb' ? base.replace(/\.arb$/, '').replace(/^(?:[a-z0-9_]+_)?([a-z]{2,3}(?:_[A-Z]{2})?)$/, '$1') : base.replace(/\.json$/, '');
    files.set(lang, f);
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(readText(join(root, f)) ?? '{}');
    } catch {
      throw new ToolError('bad_locale', `${f} is not valid JSON.`);
    }
    keys.set(lang, flatten(parsed));
  }
  return { kind, defaultLang: map.locales.default ?? [...files.keys()][0], files, keys };
}

export function dartString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$')}'`;
}

// ---------------- GetX: create translations when there are none ----------------

function createGetxTranslations(root: string, map: ProjectMap, langs: string[], files: Map<string, string>, summary: string[], warnings: string[]): string {
  const c = map.conventions;
  const file = `${(c.modulesFolder || 'lib/app/modules').replace(/\/modules$/, '')}/translations/app_translations.dart`;
  const blocks = langs.map((l) => [`        '${getxKey(l)}': {`, '        },'].join('\n')).join('\n');
  let t = [
    "/// App texts per language. Use them as 'key'.tr in widgets.",
    'class AppTranslations extends Translations {',
    '  @override',
    '  Map<String, Map<String, String>> get keys => {',
    blocks,
    '      };',
    '}',
  ].join('\n') + '\n';
  t = addDartImport(t, 'package:get/get.dart');
  files.set(file, t);
  summary.push(`Create ${file}: AppTranslations with ${langs.map(getxKey).join(', ')}`);

  const main = files.get('lib/main.dart') ?? readText(join(root, 'lib/main.dart'));
  if (main !== null && !/\btranslations\s*:/.test(main)) {
    const m = /\bGetMaterialApp(?:\.router)?\s*\(/.exec(main);
    if (m) {
      const lineStart = main.lastIndexOf('\n', m.index) + 1;
      const indent = main.slice(lineStart).match(/^[ \t]*/)![0];
      const [lang, country] = getxKey(langs[0]).split('_');
      const loc = country ? `const Locale('${lang}', '${country}')` : `const Locale('${lang}')`;
      const insert = `\n${indent}  translations: AppTranslations(),\n${indent}  locale: ${loc},\n${indent}  fallbackLocale: ${loc},`;
      let nm = main.slice(0, m.index + m[0].length) + insert + main.slice(m.index + m[0].length);
      nm = addDartImport(nm.replace(/\r\n/g, '\n'), importUri('lib/main.dart', file, c));
      files.set('lib/main.dart', withEol(nm, detectEol(main)));
      summary.push('Update lib/main.dart: GetMaterialApp uses AppTranslations');
    } else warnings.push(`lib/main.dart has no GetMaterialApp; pass translations: AppTranslations() to it yourself.`);
  }
  return file;
}

// ---------------- locale add ----------------

export async function planLocaleAdd(root: string, adapter: Adapter, lang: string, opts: { from?: string } = {}): Promise<ChangeSet> {
  if (!/^[a-z]{2,3}([_-][A-Za-z]{2,4})?$/.test(lang)) throw new ToolError('bad_lang', `"${lang}" is not a language code.`, 'Use codes like hi, en, fr, pt_BR.');
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  const files = new Map<string, string>();
  const summary: string[] = [];
  const warnings: string[] = [];
  let set = readLocales(root, map);

  if (!set) {
    if (adapter.id === 'flutter' && (map.conventions.stateManagement === 'getx' || map.conventions.di === 'getx')) {
      const def = opts.from ?? 'en';
      createGetxTranslations(root, map, lang === def ? [def] : [def, lang], files, summary, warnings);
      return buildChangeSet(root, 'locale add', { files, summary, warnings, generated: [] });
    }
    if (adapter.id === 'nextjs') {
      const def = opts.from ?? 'en';
      for (const l of new Set([def, lang])) {
        files.set(`messages/${l}.json`, '{}\n');
        summary.push(`Create messages/${l}.json`);
      }
      warnings.push('Load these files with your i18n library (for example next-intl); codz keeps them in sync from now on.');
      return buildChangeSet(root, 'locale add', { files, summary, warnings, generated: [] });
    }
    throw new ToolError('no_locales', 'No locale files were found.', 'For Flutter, set up flutter_localizations with ARB files (lib/l10n/app_en.arb) first; codz then keeps them in sync.');
  }

  if (set.files.has(lang)) throw new ToolError('locale_exists', `The language ${lang} already exists (${set.files.get(lang)}).`);
  const from = opts.from ?? set.defaultLang;
  if (!set.files.has(from)) throw new ToolError('bad_lang', `There is no ${from} language to copy from.`, `Languages: ${[...set.files.keys()].join(', ')}`);
  const source = set.files.get(from)!;
  const count = set.keys.get(from)!.size;

  if (set.kind === 'json' || set.kind === 'arb') {
    const text = readText(join(root, source))!;
    const data = JSON.parse(text) as Record<string, unknown>;
    let target: string;
    if (set.kind === 'arb') {
      for (const k of Object.keys(data)) if (k.startsWith('@')) delete data[k];
      target = posix.join(posix.dirname(source), source.slice(source.lastIndexOf('/') + 1).replace(new RegExp(`${from}\\.arb$`), `${lang}.arb`));
      const out = { '@@locale': lang, ...data };
      files.set(target, JSON.stringify(out, null, jsonIndent(text)) + '\n');
    } else {
      target = posix.join(posix.dirname(source), `${lang}.json`);
      files.set(target, text);
    }
    summary.push(`Create ${target}: ${count} keys copied from ${from}`);
  } else {
    const blocks = getxBlocks(root, set.translationsFile!);
    const src = blocks.find((b) => b.lang === from)!;
    const t = (files.get(set.translationsFile!) ?? readText(join(root, set.translationsFile!)))!.replace(/\r\n/g, '\n');
    const fresh = getxBlocks(root, set.translationsFile!).find((b) => b.file === set!.translationsFile)!;
    const mapClose = (() => {
      const g = /get\s+keys\s*=>\s*(?:<[^>]*>\s*)?\{/.exec(t) ?? /get\s+keys\s*\{\s*return\s*(?:<[^>]*>\s*)?\{/.exec(t);
      return matchBrace(t, g!.index + g![0].length - 1, 'dart');
    })();
    const lineStart = t.lastIndexOf('\n', fresh ? fresh.open : mapClose) + 1;
    const indent = t.slice(lineStart).match(/^[ \t]*/)![0];
    const entries = [...set.keys.get(from)!.entries()].map(([k, v]) => `${indent}  ${dartString(k)}: ${dartString(v)},`).join('\n');
    const block = `${indent}'${getxKey(lang)}': {\n${entries}${entries ? '\n' : ''}${indent}},`;
    const before = t.slice(0, mapClose).replace(/\s*$/, '');
    const next = `${before}${before.endsWith(',') || before.endsWith('{') ? '' : ','}\n${block}\n${t.slice(t.lastIndexOf('\n', mapClose) + 1)}`;
    files.set(set.translationsFile!, withEol(next, detectEol(readText(join(root, set.translationsFile!))!)));
    summary.push(`Update ${set.translationsFile}: add '${getxKey(lang)}' with ${count} keys copied from ${from}`);
    void src;
  }
  if (count) warnings.push(`The ${count} ${lang} texts are copies of ${from}; translate them (codz doctor lists the untranslated ones).`);
  return buildChangeSet(root, 'locale add', { files, summary, warnings, generated: [] });
}

// ---------------- locale key ----------------

export async function planLocaleKey(root: string, adapter: Adapter, key: string, text: string, opts: { values?: Map<string, string>; force?: boolean; overlay?: Map<string, string> } = {}): Promise<ChangeSet> {
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  const r = await localeKeyFiles(root, adapter, map, key, text, opts);
  return buildChangeSet(root, 'locale key', { files: r.files, summary: r.summary, warnings: r.warnings, generated: [] });
}

/** The locale file edits for one key; `overlay` holds files already changed in this plan (locale extract adds many keys). */
export async function localeKeyFiles(root: string, adapter: Adapter, map: ProjectMap, key: string, text: string, opts: { values?: Map<string, string>; force?: boolean; overlay?: Map<string, string> } = {}): Promise<{ files: Map<string, string>; summary: string[]; warnings: string[]; key: string }> {
  const read = (f: string) => opts.overlay?.get(f) ?? readText(join(root, f));
  const files = new Map<string, string>();
  const summary: string[] = [];
  const warnings: string[] = [];
  let set = readLocales(root, map);
  const plannedGetx = [...(opts.overlay?.keys() ?? [])].find((f) => f.endsWith('app_translations.dart'));
  if (!set && plannedGetx) set = { kind: 'getx', defaultLang: 'en', files: new Map([['en', plannedGetx]]), keys: new Map([['en', new Map()]]), translationsFile: plannedGetx };
  if (!set) {
    if (adapter.id === 'flutter' && (map.conventions.stateManagement === 'getx' || map.conventions.di === 'getx')) {
      createGetxTranslations(root, map, ['en'], files, summary, warnings);
      // Re-read from the planned file.
      const file = [...files.keys()].find((f) => f.endsWith('app_translations.dart'))!;
      set = { kind: 'getx', defaultLang: 'en', files: new Map([['en', file]]), keys: new Map([['en', new Map()]]), translationsFile: file };
    } else {
      throw new ToolError('no_locales', 'No locale files were found.', 'Create a language first with: codz locale add en');
    }
  }
  let finalKey = key;
  if (set.kind === 'arb' && !/^[a-z][A-Za-z0-9]*$/.test(key)) {
    finalKey = camel(key);
    warnings.push(`ARB keys must be Dart identifiers, so "${key}" is saved as "${finalKey}".`);
  }
  const exists = [...set.keys.values()].some((k) => k.has(finalKey));
  if ([...set.keys.values()].some((k) => [...k.keys()].some((x) => x.startsWith(`${finalKey}.`)))) {
    throw new ToolError('key_conflict', `${finalKey} is a group of keys (${finalKey}.…), so it cannot hold a text.`, 'Pick another key name.');
  }
  if (exists && !opts.force) throw new ToolError('key_exists', `The key ${finalKey} already exists.`, 'Pass --force to replace its text.');
  const untranslated: string[] = [];
  const valueFor = (lang: string) => {
    const v = opts.values?.get(lang);
    if (v !== undefined) return v;
    if (lang !== set!.defaultLang) untranslated.push(lang);
    return text;
  };
  for (const lang of opts.values?.keys() ?? []) if (!set.files.has(lang)) throw new ToolError('bad_lang', `--value ${lang}=... names a language the project does not have.`, `Languages: ${[...set.files.keys()].join(', ')}`);

  if (set.kind === 'json' || set.kind === 'arb') {
    const placeholders = [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    for (const [lang, file] of set.files) {
      const raw = read(file)!;
      let next: string;
      if (set.kind === 'arb') {
        next = jsonSet(raw, [finalKey], valueFor(lang));
        if (lang === set.defaultLang && placeholders.length) {
          next = jsonSet(next, [`@${finalKey}`], { placeholders: Object.fromEntries(placeholders.map((p) => [p, { type: 'String' }])) });
        }
      } else next = jsonSet(raw, finalKey.split('.'), valueFor(lang));
      files.set(file, withEol(next.replace(/\r\n/g, '\n'), detectEol(raw)));
      summary.push(`${exists ? 'Update' : 'Add'} ${finalKey} in ${file}`);
    }
  } else {
    // GetX: one map per language, maybe in different files.
    const pending = new Map<string, string>([...(opts.overlay ?? []), ...files]);
    const byFile = new Map<string, { lang: string; open: number; close: number }[]>();
    for (const [lang, file] of set.files) {
      const t = pending.get(file) ?? readText(join(root, file))!;
      const blocks = pending.has(file) ? getxBlocksFromText(t, file) : getxBlocks(root, set.translationsFile!).filter((b) => b.file === file);
      const b = blocks.find((x) => x.lang === lang);
      if (b) byFile.set(file, [...(byFile.get(file) ?? []), { lang, open: b.open, close: b.close }]);
    }
    for (const [file, blocks] of byFile) {
      let t = (pending.get(file) ?? readText(join(root, file))!).replace(/\r\n/g, '\n');
      // Edit from the end so earlier offsets stay valid.
      for (const b of [...blocks].sort((a, z) => z.close - a.close)) {
        const inner = t.slice(b.open, b.close + 1);
        const value = valueFor(b.lang);
        const existingEntry = new RegExp(`(['"])${finalKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1\\s*:\\s*(['"])(?:\\\\.|(?!\\2).)*\\2,?`).exec(inner);
        if (existingEntry) {
          t = t.slice(0, b.open) + inner.replace(existingEntry[0], `${dartString(finalKey)}: ${dartString(value)},`) + t.slice(b.close + 1);
        } else {
          const lineStart = t.lastIndexOf('\n', b.close) + 1;
          const closeIndent = t.slice(lineStart, b.close).match(/^[ \t]*/)![0];
          const before = t.slice(0, b.close).replace(/\s*$/, '');
          t = `${before}${before.endsWith('{') || before.endsWith(',') ? '' : ','}\n${closeIndent}  ${dartString(finalKey)}: ${dartString(value)},\n${closeIndent}${t.slice(b.close)}`;
        }
      }
      const orig = readText(join(root, file));
      files.set(file, orig ? withEol(t, detectEol(orig)) : t);
      summary.push(`${exists ? 'Update' : 'Add'} '${finalKey}' in ${file} (${blocks.map((b) => getxKey(b.lang)).join(', ')})`);
    }
    summary.push(`Use it in a widget: Text('${finalKey}'.tr)`);
  }
  if (untranslated.length) warnings.push(`${finalKey} uses the ${set.defaultLang} text for ${untranslated.join(', ')}; translate it there, or pass --value ${untranslated[0]}="...".`);
  return { files, summary, warnings, key: finalKey };
}

function getxBlocksFromText(t: string, file: string): { lang: string; open: number; close: number }[] {
  const out: { lang: string; open: number; close: number }[] = [];
  const g = /get\s+keys\s*=>\s*(?:<[^>]*>\s*)?\{/.exec(t);
  if (!g) return out;
  const mapOpen = g.index + g[0].length - 1;
  const body = t.slice(mapOpen, matchBrace(t, mapOpen, 'dart'));
  for (const m of body.matchAll(/['"]([A-Za-z]{2,3}(?:[_-][A-Za-z]{2,4})?)['"]\s*:\s*\{/g)) {
    const open = mapOpen + m.index! + m[0].length - 1;
    out.push({ lang: fromGetxKey(m[1]), open, close: matchBrace(t, open, 'dart') });
  }
  void file;
  return out;
}
