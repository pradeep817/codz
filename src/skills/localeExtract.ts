// codz locale extract [files...]: the text users see in screens moves into the
// locale files, and the code reads it back the project's way.
//
//   Flutter (ARB)   Text('Nothing here yet') → Text(AppLocalizations.of(context)!.productsNothingHereYet)
//                   (wires AppLocalizations into MaterialApp the first time)
//   Flutter (GetX)  Text('Nothing here yet') → Text('products.nothingHereYet'.tr)
//   next-intl       <p>Nothing here yet</p> → <p>{t('products.nothingHereYet')}</p>, with useTranslations / getTranslations
//   react-i18next   the same with useTranslation()
//   Compose         Text("Nothing here yet") → Text(stringResource(R.string.products_nothing_here_yet)), in strings.xml
//
// Text used in several screens goes under common.*, and text that already has a
// key reuses it. Only plain text is moved: strings in conditions, logs and
// error messages from code are left alone.

import { join, posix } from 'node:path';
import { addDartImport } from '../adapters/flutter.ts';
import { addKotlinImports } from '../adapters/kotlinGen.ts';
import { maskCode, matchBrace, skipString } from '../adapters/source.ts';
import { loadMap } from '../core/cache.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { loadConfig } from '../core/config.ts';
import { exists, readText, walk } from '../core/fsutil.ts';
import { ToolError, type Adapter, type ChangeSet, type ProjectMap } from '../core/types.ts';
import { camel, pascal, snake } from '../input/naming.ts';
import { localeKeyFiles, readLocales } from './locale.ts';

type Style = 'arb' | 'getx' | 'next-intl' | 'i18next' | 'next-i18next' | 'android';

/** One piece of text found in a file. */
interface Found {
  file: string;
  /** Range in the file to replace (the whole string literal, or the JSX text). */
  start: number;
  end: number;
  text: string;
  /** Interpolated values, in order: their names (for keys and placeholders) and expressions. */
  args: { name: string; expr: string }[];
  kind: 'dart-text' | 'dart-named' | 'jsx-text' | 'jsx-attr' | 'kt-text';
  /** JSX attribute: its name (placeholder="..." → placeholder={t(...)}). */
  attr?: string;
}

const LETTERS = /[A-Za-z\u00C0-\u024F\u0900-\u097F]/;
const looksLikeText = (s: string) => LETTERS.test(s.replace(/\{\w+\}/g, '')) && !/^[a-z]+(\.[a-z_]+)+$/i.test(s.trim()) && !/^(https?:|\/|#|@)/.test(s.trim()) && s.trim().length > 0 && s.length < 400;

// ---------- finding text ----------

/** A Dart or Kotlin string literal at `i`: its content with interpolations as {name}, or null for raw, triple or complex strings. */
function readLiteral(text: string, i: number, lang: 'dart' | 'kt'): { end: number; value: string; args: { name: string; expr: string }[] } | null {
  const q = text[i];
  if (q !== "'" && q !== '"') return null;
  if (lang === 'kt' && q === "'") return null;
  if (text.slice(i, i + 3) === q.repeat(3) || text[i - 1] === 'r') return null;
  const end = skipString(text, i, 'dart');
  const raw = text.slice(i + 1, end - 1);
  if (raw.includes('\n')) return null;
  const args: { name: string; expr: string }[] = [];
  let value = '';
  for (let k = 0; k < raw.length; k++) {
    const c = raw[k];
    if (c === '\\') {
      const n = raw[k + 1];
      value += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      k++;
      continue;
    }
    if (c === '$') {
      const brace = raw[k + 1] === '{';
      const m = brace ? /^\$\{([\w.]+(?:\(\))?)\}/.exec(raw.slice(k)) : /^\$([A-Za-z_]\w*)/.exec(raw.slice(k));
      if (!m) return null; // an expression codz should not move
      const expr = m[1];
      const name = camel(expr.replace(/\(\)$/, '').split('.').pop() ?? 'value') || 'value';
      const unique = args.some((a) => a.name === name) ? `${name}${args.length + 1}` : name;
      args.push({ name: unique, expr });
      value += `{${unique}}`;
      k += m[0].length - 1;
      continue;
    }
    value += c;
  }
  return { end, value, args };
}

function findDart(file: string, text: string): Found[] {
  const masked = maskCode(text, 'dart');
  const out: Found[] = [];
  for (const m of masked.matchAll(/(?<![\w.$])Text\(\s*/g)) {
    const at = m.index! + m[0].length;
    const lit = readLiteral(text, at, 'dart');
    if (lit && looksLikeText(lit.value)) out.push({ file, start: at, end: lit.end, text: lit.value, args: lit.args, kind: 'dart-text' });
  }
  for (const m of masked.matchAll(/\b(hintText|labelText|helperText|tooltip|semanticsLabel|semanticLabel|title)\s*:\s*/g)) {
    const at = m.index! + m[0].length;
    const lit = readLiteral(text, at, 'dart');
    if (lit && looksLikeText(lit.value)) out.push({ file, start: at, end: lit.end, text: lit.value, args: lit.args, kind: 'dart-named' });
  }
  return out;
}

function findKotlin(file: string, text: string): Found[] {
  if (!/@Composable/.test(text)) return [];
  const masked = maskCode(text, 'dart');
  const out: Found[] = [];
  for (const m of masked.matchAll(/(?<![\w.])Text\(\s*(?:text\s*=\s*)?/g)) {
    const at = m.index! + m[0].length;
    const lit = readLiteral(text, at, 'kt');
    if (lit && looksLikeText(lit.value)) out.push({ file, start: at, end: lit.end, text: lit.value, args: lit.args, kind: 'kt-text' });
  }
  return out;
}

const JSX_ATTRS = ['placeholder', 'title', 'alt', 'aria-label', 'label', 'accessibilityLabel'];

function findJsx(file: string, text: string): Found[] {
  const out: Found[] = [];
  // Text right before a closing tag: <p>Nothing here yet.</p>
  for (const m of text.matchAll(/>([^<>{}\n]*)<\//g)) {
    const raw = m[1];
    if (!looksLikeText(raw) || /[=;]|=>|&&/.test(raw)) continue;
    const lead = raw.length - raw.trimStart().length;
    const start = m.index! + 1 + lead;
    const value = raw.trim();
    out.push({ file, start, end: start + value.length, text: value.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'), args: [], kind: 'jsx-text' });
  }
  for (const m of text.matchAll(new RegExp(`\\s(${JSX_ATTRS.join('|')})="([^"{}\\n]*)"`, 'g'))) {
    if (!looksLikeText(m[2])) continue;
    const start = m.index! + m[0].indexOf(`${m[1]}=`);
    out.push({ file, start, end: m.index! + m[0].length, text: m[2], args: [], kind: 'jsx-attr', attr: m[1] });
  }
  return out;
}

// ---------- which files ----------

function screenFiles(root: string, map: ProjectMap, style: Style): string[] {
  if (style === 'arb' || style === 'getx') {
    return walk(root, 'lib', { exts: ['.dart'] }).filter((f) => !/\.(g|freezed)\.dart$|(^|\/)l10n\/|app_localizations/.test(f) && /\bWidget\s+build\s*\(|extends\s+GetView/.test(readText(join(root, f)) ?? ''));
  }
  if (style === 'android') {
    const src = map.conventions.srcDir || 'app/src/main/java';
    return walk(root, src, { exts: ['.kt'] }).filter((f) => /@Composable/.test(readText(join(root, f)) ?? ''));
  }
  const dirs = ['app', 'components', 'src'];
  return dirs.flatMap((d) => walk(root, d, { exts: ['.tsx', '.jsx'] })).filter((f) => !/\.(test|spec|stories)\.[jt]sx$|(^|\/)(__tests__|node_modules)\//.test(f));
}

// ---------- keys ----------

function prefixOf(file: string): string {
  const parts = file.split('/');
  let base = parts[parts.length - 1].replace(/\.\w+$/, '');
  if (/^(page|index|layout|_layout|loading|error|not-found)$/.test(base)) {
    // App Router: the route, without groups; a dynamic last segment is the detail page.
    const dirs = parts.slice(0, -1).filter((d) => !/^\(.*\)$|^(app|src|pages|screens)$/.test(d));
    const segs = dirs.map((d, i) => (/^\[.*\]$/.test(d) ? (i === dirs.length - 1 ? 'detail' : '') : d)).filter(Boolean);
    base = segs.join(' ') || 'home';
  }
  base = base.replace(/(_page|_view|_screen|Page|Screen|View|Activity)$/, '') || base;
  return camel(base) || 'app';
}

function slugOf(text: string): string {
  const words = text.replace(/\{\w+\}/g, ' ').match(/[A-Za-z0-9]+/g) ?? [];
  return camel(words.slice(0, 4).join(' ')) || 'text';
}

// ---------- code changes ----------

/** Dart: removes `const` from the constructor calls and list literals that enclose `pos`, since the text is no longer constant. */
function dropDartConsts(text: string, pos: number): string {
  const masked = maskCode(text, 'dart');
  const stack: number[] = [];
  for (let i = 0; i < pos; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') stack.push(i);
    else if (c === ')' || c === ']' || c === '}') stack.pop();
  }
  const cuts: [number, number][] = [];
  for (const open of stack) {
    const before = masked.slice(Math.max(0, open - 160), open);
    const m = masked[open] === '(' ? /\bconst\s+([A-Za-z_][\w.]*(?:<[^()]*>)?)\s*$/.exec(before) : /\bconst\s*(<[^()[\]]*>)?\s*$/.exec(before);
    if (m) {
      const at = open - before.length + m.index;
      cuts.push([at, at + /^const\s*/.exec(masked.slice(at))![0].length]);
    }
  }
  let out = text;
  for (const [a, b] of cuts.sort((x, y) => y[0] - x[0])) out = out.slice(0, a) + out.slice(b);
  return out;
}

/** Dart: is `pos` inside a function or closure that has a `context` parameter? */
function hasContext(text: string, pos: number): boolean {
  const masked = maskCode(text, 'dart');
  // A State class has a context getter in every method.
  for (const m of masked.matchAll(/class\s+\w+\s+extends\s+(?:State|ConsumerState)<[^{]*\{/g)) {
    const open = m.index! + m[0].length - 1;
    if (open < pos && matchBrace(text, open, 'dart') > pos) return true;
  }
  for (const m of masked.matchAll(/\(([^()]*\bcontext\b[^()]*)\)\s*(?:async\s*)?(\{|=>)/g)) {
    if (m.index! > pos) break;
    const bodyAt = m.index! + m[0].length - m[2].length;
    if (m[2] === '{') {
      const close = matchBrace(text, bodyAt, 'dart');
      if (close > pos) return true;
    } else {
      // An arrow body runs to the end of its expression.
      let depth = 0;
      for (let i = bodyAt + 2; i < masked.length; i++) {
        const c = masked[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
          if (depth === 0) {
            if (i > pos) return true;
            break;
          }
          depth--;
        } else if ((c === ';' || c === ',') && depth === 0) {
          if (i > pos) return true;
          break;
        }
      }
    }
  }
  return false;
}

/** TSX: the component function that contains `pos`: where its body starts, whether it is async, and whether it already has `t`. */
function componentAt(text: string, pos: number): { bodyOpen: number; async: boolean; hasT: boolean } | null {
  // JSX text can hold apostrophes, which a brace matcher would read as strings: blank it first.
  const safe = text.replace(/>([^<>{}\n]*)<\//g, (_m, inner: string) => `>${' '.repeat(inner.length)}</`);
  const heads = /(?:^|\n)[ \t]*(?:export\s+(?:default\s+)?)?(?:(async\s+)?function\s+[A-Z]\w*\s*(\()|const\s+[A-Z]\w*\s*(?::[^=\n]+)?=\s*(async\s*)?(\())/g;
  let best: { bodyOpen: number; async: boolean; hasT: boolean } | null = null;
  for (const m of safe.matchAll(heads)) {
    const paren = m.index! + m[0].length - 1;
    if (paren > pos) break;
    const close = matchBrace(safe, paren, 'ts');
    if (close < 0) continue;
    // After the parameters: an optional return type, then { (function) or => { (arrow).
    const rest = /^\s*(?::\s*[^{=]+?)?\s*(=>\s*)?\{/.exec(safe.slice(close + 1));
    if (!rest || (m[2] && rest[1]) || (m[4] && !rest[1])) continue;
    const open = close + rest[0].length;
    const end = matchBrace(safe, open, 'ts');
    if (open < pos && end > pos) best = { bodyOpen: open, async: Boolean(m[1] || m[3]), hasT: /\bconst\s+(?:t|\{\s*t\b[^}]*\})\s*=/.test(text.slice(open, end)) };
  }
  return best;
}

function addTsImport(text: string, names: string[], from: string): string {
  const existing = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${from.replace(/\//g, '\\/')}['"];?`).exec(text);
  const q = /from "/.test(text) && !/from '/.test(text) ? '"' : "'";
  const semi = /;[ \t]*$/m.test(text) ? ';' : '';
  if (existing) {
    const have = existing[1].split(',').map((x) => x.trim()).filter(Boolean);
    const all = [...new Set([...have, ...names])].sort();
    return text.replace(existing[0], `import { ${all.join(', ')} } from ${q}${from}${q}${semi}`);
  }
  const line = `import { ${names.join(', ')} } from ${q}${from}${q}${semi}`;
  // After 'use client' and the last import.
  const imports = [...text.matchAll(/^import[^;\n]*(?:;|\n|$)(?:[^\n]*from[^\n]*\n)?/gm)];
  if (imports.length) {
    const last = imports[imports.length - 1];
    const at = text.indexOf('\n', last.index!) + 1;
    return text.slice(0, at) + line + '\n' + text.slice(at);
  }
  const directive = /^(['"])use client\1;?\n/.exec(text);
  return directive ? text.slice(0, directive[0].length) + line + '\n' + text.slice(directive[0].length) : `${line}\n${text}`;
}

// ---------- Flutter AppLocalizations wiring ----------

function arbSetup(root: string, map: ProjectMap, files: Map<string, string>, summary: string[], warnings: string[]): { importUri: string; access: (ctx: string) => string } {
  const read = (f: string) => files.get(f) ?? readText(join(root, f));
  const dart = walk(root, 'lib', { exts: ['.dart'] });
  // An existing import tells where the generated class is.
  for (const f of dart) {
    const m = /import\s+'([^']*app_localizations\.dart)'/.exec(readText(join(root, f)) ?? '');
    if (m) {
      const ext = dart.map((x) => readText(join(root, x)) ?? '').find((t) => /extension\s+\w+\s+on\s+BuildContext\s*\{[^}]*AppLocalizations\s+get\s+(\w+)/.test(t));
      const getter = ext && /AppLocalizations\s+get\s+(\w+)/.exec(ext)?.[1];
      return { importUri: m[1], access: (ctx) => (getter ? `${ctx}.${getter}` : `AppLocalizations.of(${ctx})!`) };
    }
  }
  const pkgName = /^name:\s*(\S+)/m.exec(read('pubspec.yaml') ?? '')?.[1] ?? 'app';
  const arbFile = map.locales.files.find((f) => f.endsWith('.arb'))!;
  const arbDir = posix.dirname(arbFile);
  const template = posix.basename(map.locales.files.find((f) => /_en\.arb$/.test(f)) ?? arbFile);
  let yaml = read('l10n.yaml');
  if (yaml === null) {
    yaml = `arb-dir: ${arbDir}\ntemplate-arb-file: ${template}\noutput-localization-file: app_localizations.dart\n`;
    files.set('l10n.yaml', yaml);
    summary.push(`Create l10n.yaml: generate AppLocalizations from ${arbDir}/${template}`);
  }
  const outDir = /^output-dir:\s*(\S+)/m.exec(yaml)?.[1] ?? /^arb-dir:\s*(\S+)/m.exec(yaml)?.[1] ?? arbDir;
  const outFile = /^output-localization-file:\s*(\S+)/m.exec(yaml)?.[1] ?? 'app_localizations.dart';
  const importUri = /^synthetic-package:\s*true/m.test(yaml) ? `package:flutter_gen/gen_l10n/${outFile}` : `package:${pkgName}/${outDir.replace(/^lib\//, '')}/${outFile}`;
  // pubspec: flutter_localizations, intl, generate: true.
  let pub = read('pubspec.yaml') ?? '';
  const before = pub;
  if (!/^\s+flutter_localizations:/m.test(pub)) pub = pub.replace(/^dependencies:\s*\n/m, (m) => `${m}  flutter_localizations:\n    sdk: flutter\n`);
  if (!/^\s+intl:/m.test(pub)) pub = pub.replace(/^dependencies:\s*\n/m, (m) => `${m}  intl: any\n`);
  if (!/^\s+generate:\s*true/m.test(pub)) pub = /^flutter:\s*\n/m.test(pub) ? pub.replace(/^flutter:\s*\n/m, (m) => `${m}  generate: true\n`) : `${pub.replace(/\s*$/, '\n')}\nflutter:\n  generate: true\n`;
  if (pub !== before) {
    files.set('pubspec.yaml', pub);
    summary.push('Update pubspec.yaml: flutter_localizations, intl and generate: true (run flutter pub get, which generates AppLocalizations)');
  }
  // MaterialApp: the delegates and supported locales.
  for (const f of dart) {
    const t = read(f) ?? '';
    const m = /\b(?:MaterialApp|GetMaterialApp|CupertinoApp)(?:\.router)?\(/.exec(t);
    if (!m) continue;
    if (/localizationsDelegates\s*:/.test(t)) break;
    const open = m.index + m[0].length - 1;
    const close = matchBrace(t, open, 'dart');
    const inner = t.slice(open + 1, close);
    const ind = /\n([ \t]+)\w+\s*:/.exec(inner)?.[1] ?? '      ';
    let next = `${t.slice(0, open + 1)}\n${ind}localizationsDelegates: AppLocalizations.localizationsDelegates,\n${ind}supportedLocales: AppLocalizations.supportedLocales,${inner.startsWith('\n') ? '' : `\n${ind}`}${inner}${t.slice(close)}`;
    next = dropDartConsts(next, open + 2);
    next = addDartImport(next, importUri);
    files.set(f, next);
    summary.push(`Update ${f}: AppLocalizations delegates and supported locales on ${m[0].slice(0, -1)}`);
    break;
  }
  warnings.push('Run flutter pub get (or flutter gen-l10n) to generate AppLocalizations before building.');
  return { importUri, access: (ctx) => `AppLocalizations.of(${ctx})!` };
}

// ---------- the plan ----------

function styleOf(root: string, adapter: Adapter, map: ProjectMap): Style {
  if (adapter.id === 'android') return 'android';
  if (adapter.id === 'ios') throw new ToolError('not_needed', 'SwiftUI already localizes Text("…") literals: Xcode collects them into a String Catalog (Localizable.xcstrings) when you build.', 'Add a String Catalog (File → New → String Catalog) and translate there.');
  if (adapter.id === 'flutter') {
    const set = readLocales(root, map);
    if (set?.kind === 'getx' || (!set && (map.conventions.stateManagement === 'getx' || map.conventions.di === 'getx'))) return 'getx';
    if (set?.kind === 'arb') return 'arb';
    throw new ToolError('no_locales', 'No ARB files were found.', 'Create one first with: codz locale add en');
  }
  const pkg = readText(join(root, 'package.json')) ?? '';
  if (!readLocales(root, map)) throw new ToolError('no_locales', 'No locale files were found.', 'Create one first with: codz locale add en');
  if (/"next-intl"/.test(pkg)) return 'next-intl';
  if (/"next-i18next"/.test(pkg)) return 'next-i18next';
  if (/"react-i18next"/.test(pkg)) return 'i18next';
  throw new ToolError('not_supported', 'locale extract writes next-intl or react-i18next calls, and this project uses neither.', 'Add next-intl (Next.js) or react-i18next, then run this again.');
}

export async function planLocaleExtract(root: string, adapter: Adapter, only: string[] = []): Promise<ChangeSet> {
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  const style = styleOf(root, adapter, map);
  const files = new Map<string, string>();
  const summary: string[] = [];
  const warnings: string[] = [];
  const targets = only.length ? only.map((f) => f.replace(/\\/g, '/').replace(/^\.\//, '')) : screenFiles(root, map, style);
  for (const f of only) if (!exists(join(root, f))) throw new ToolError('not_found', `No file ${f}.`);
  // 1. Find the text.
  const found: Found[] = [];
  for (const f of targets) {
    const t = readText(join(root, f)) ?? '';
    const hits = style === 'arb' || style === 'getx' ? findDart(f, t) : style === 'android' ? findKotlin(f, t) : findJsx(f, t);
    if (style === 'arb') {
      for (const h of hits) {
        if (hasContext(t, h.start)) found.push(h);
        else warnings.push(`${f}: left "${h.text}" alone (no BuildContext there to read AppLocalizations from).`);
      }
    } else found.push(...hits);
  }
  if (!found.length) {
    summary.push(`No text to move${only.length ? ` in ${only.join(', ')}` : ' in the screens'}.`);
    return buildChangeSet(root, 'locale extract', { files, summary, warnings, generated: [] });
  }
  // 2. Keys: reuse a key with the same text; text in several files goes under common.
  const existing = new Map<string, string>();
  let stringsXml: string | null = null;
  const stringsFile = `${map.conventions.appModule || 'app'}/src/main/res/values/strings.xml`;
  if (style === 'android') {
    stringsXml = readText(join(root, stringsFile)) ?? '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n</resources>\n';
    for (const m of stringsXml.matchAll(/<string name="(\w+)">([^<]*)<\/string>/g)) if (!existing.has(xmlUnescape(m[2]))) existing.set(xmlUnescape(m[2]), m[1]);
  } else {
    const set = readLocales(root, map);
    for (const [k, v] of set?.keys.get(set.defaultLang) ?? []) if (!existing.has(fromStored(v, style))) existing.set(fromStored(v, style), k);
  }
  const filesByText = new Map<string, Set<string>>();
  for (const h of found) filesByText.set(h.text, (filesByText.get(h.text) ?? new Set()).add(h.file));
  const taken = new Set(existing.values());
  const keyOf = new Map<string, string>();
  const newKeys: { key: string; text: string }[] = [];
  const makeKey = (prefix: string, slug: string) => {
    const join2 = (n: number) => {
      const s = n === 1 ? slug : `${slug}${n}`;
      return style === 'arb' ? `${prefix}${pascal(s)}` : style === 'android' ? `${snake(prefix)}_${snake(s)}` : `${prefix}.${s}`;
    };
    let n = 1;
    while (taken.has(join2(n))) n++;
    taken.add(join2(n));
    return join2(n);
  };
  for (const h of found) {
    const id = `${filesByText.get(h.text)!.size > 1 ? '' : h.file}\u0000${h.text}`;
    if (keyOf.has(id)) continue;
    const reuse = existing.get(h.text);
    if (reuse) {
      keyOf.set(id, reuse);
      continue;
    }
    const key = makeKey(filesByText.get(h.text)!.size > 1 ? 'common' : prefixOf(h.file), slugOf(h.text));
    keyOf.set(id, key);
    newKeys.push({ key, text: h.text });
  }
  const key = (h: Found) => keyOf.get(`${filesByText.get(h.text)!.size > 1 ? '' : h.file}\u0000${h.text}`)!;
  // 3. Locale files.
  if (style === 'android') {
    const lines = newKeys.map((k) => `    <string name="${k.key}">${xmlEscape(toAndroid(k.text))}</string>`);
    if (lines.length) {
      files.set(stringsFile, stringsXml!.replace(/\s*<\/resources>\s*$/, `\n${lines.join('\n')}\n</resources>\n`));
      summary.push(`${readText(join(root, stringsFile)) === null ? 'Create' : 'Update'} ${stringsFile}: ${lines.length} string${lines.length === 1 ? '' : 's'}`);
    }
  } else {
    for (const k of newKeys) {
      const stored = style === 'getx' ? k.text.replace(/\{(\w+)\}/g, '@$1') : style === 'next-intl' ? k.text : style === 'arb' ? k.text : k.text.replace(/\{(\w+)\}/g, '{{$1}}');
      const r = await localeKeyFiles(root, adapter, map, k.key, stored, { overlay: files });
      for (const [f, t] of r.files) files.set(f, t);
      warnings.push(...r.warnings.filter((w) => !/uses the \w+ text for/.test(w)));
    }
    const set = readLocales(root, map);
    const others = [...(set?.files.keys() ?? [])].filter((l) => l !== set?.defaultLang);
    if (newKeys.length) summary.push(`Add ${newKeys.length} key${newKeys.length === 1 ? '' : 's'} to the locale files${others.length ? ` (${others.join(', ')} get the ${set!.defaultLang} text until translated; codz doctor lists them)` : ''}`);
  }
  // 4. Code.
  const arb = style === 'arb' ? arbSetup(root, map, files, summary, warnings) : null;
  const byFile = new Map<string, Found[]>();
  for (const h of found) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h]);
  for (const [f, hits] of byFile) {
    let t = files.get(f) ?? readText(join(root, f))!;
    const sorted = [...hits].sort((a, b) => b.start - a.start);
    const components = new Map<number, { async: boolean; hasT: boolean }>();
    let moved = 0;
    for (const h of sorted) {
      moved++;
      const k = key(h);
      if (style === 'arb' || style === 'getx') {
        const call = style === 'arb' ? `${arb!.access('context')}.${k}${h.args.length ? `(${h.args.map((a) => a.expr).join(', ')})` : ''}` : h.args.length ? `'${k}'.trParams({${h.args.map((a) => `'${a.name}': '\${${a.expr}}'`).join(', ')}})` : `'${k}'.tr`;
        t = t.slice(0, h.start) + call + t.slice(h.end);
        t = dropDartConsts(t, h.start);
      } else if (style === 'android') {
        t = t.slice(0, h.start) + `stringResource(R.string.${k}${h.args.length ? `, ${h.args.map((a) => a.expr).join(', ')}` : ''})` + t.slice(h.end);
      } else {
        const c = componentAt(t, h.start);
        if (!c) {
          warnings.push(`${f}: left "${h.text}" alone (not inside a component function codz recognizes).`);
          moved--;
          continue;
        }
        components.set(c.bodyOpen, { async: c.async, hasT: c.hasT });
        const q = h.text.includes("'") ? '"' : "'";
        const call = `t(${q}${k}${q})`;
        t = t.slice(0, h.start) + (h.kind === 'jsx-attr' ? `${h.attr}={${call}}` : `{${call}}`) + t.slice(h.end);
      }
    }
    if (style === 'arb') t = addDartImport(t, arb!.importUri);
    if (style === 'getx' && !/package:get\/get\.dart/.test(t)) t = addDartImport(t, 'package:get/get.dart');
    if (style === 'android') {
      const ns = map.conventions.namespace;
      const pkg = /^package\s+([\w.]+)/m.exec(t)?.[1] ?? '';
      t = addKotlinImports(t, ['androidx.compose.ui.res.stringResource', ...(ns ? [`${ns}.R`] : [])], pkg);
    }
    if (style === 'next-intl' || style === 'i18next' || style === 'next-i18next') {
      // A t for each component, top-down so earlier offsets stay valid... insert from the last one.
      let needsServer = false;
      let needsClient = false;
      for (const [open, c] of [...components].sort((a, b) => b[0] - a[0])) {
        if (c.hasT) continue;
        const ind = /\n([ \t]+)\S/.exec(t.slice(open))?.[1] ?? '  ';
        const semi = /;\s*\n/.test(t) ? ';' : '';
        const line = style === 'next-intl' ? (c.async ? `const t = await getTranslations()${semi}` : `const t = useTranslations()${semi}`) : `const { t } = useTranslation()${semi}`;
        if (style === 'next-intl' && c.async) needsServer = true;
        else needsClient = true;
        t = `${t.slice(0, open + 1)}\n${ind}${line}${t.slice(open + 1)}`;
      }
      if (style === 'next-intl') {
        if (needsServer) t = addTsImport(t, ['getTranslations'], 'next-intl/server');
        if (needsClient) t = addTsImport(t, ['useTranslations'], 'next-intl');
      } else if (needsClient) t = addTsImport(t, ['useTranslation'], style === 'next-i18next' ? 'next-i18next' : 'react-i18next');
    }
    if (!moved) continue;
    files.set(f, t);
    summary.push(`Update ${f}: ${moved} text${moved === 1 ? '' : 's'} → ${style === 'android' ? 'stringResource' : style === 'arb' ? 'AppLocalizations' : style === 'getx' ? '.tr' : 't()'}`);
  }
  if (style === 'getx' && newKeys.some((k) => /\{\w+\}/.test(k.text))) summary.push('Text with values uses trParams; GetX fills @name in the translation.');
  return buildChangeSet(root, 'locale extract', { files, summary, warnings, generated: [] });
}

/** The text a stored translation shows, in the form found in code ({name} placeholders). */
function fromStored(v: string, style: Style): string {
  if (style === 'getx') return v.replace(/@(\w+)/g, '{$1}');
  if (style === 'i18next' || style === 'next-i18next') return v.replace(/\{\{(\w+)\}\}/g, '{$1}');
  return v;
}

/** {name} → %1$s, %2$s for Android resources. */
function toAndroid(text: string): string {
  let n = 0;
  return text.replace(/%/g, '%%').replace(/\{\w+\}/g, () => `%${++n}$s`);
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/^([@?])/, '\\$1');
}

function xmlUnescape(s: string): string {
  return s.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/%%/g, '%');
}
