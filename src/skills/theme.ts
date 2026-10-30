// theme set <token> <value>: one place for colors, sizes and the font.
//
// The kind comes from the value: #hex → color, a number → size, anything else
// (or the token "font") → font family.
//
// Flutter: AppColors / AppSizes classes and an AppTheme built from the seed
// color (lib/app/theme for GetX, lib/core/theme otherwise, or wherever the
// project already keeps AppColors), wired into MaterialApp / GetMaterialApp.
// Next.js: Tailwind v4 @theme variables, Tailwind v3 theme.extend, or plain
// CSS variables in globals.css.

import { importPath } from '../adapters/nextjs.ts';
import { join, posix } from 'node:path';
import { addDartImport, importUri } from '../adapters/flutter.ts';
import { matchBrace } from '../adapters/source.ts';
import { loadMap } from '../core/cache.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { loadConfig } from '../core/config.ts';
import { detectEol, exists, readText, walk, withEol } from '../core/fsutil.ts';
import { ToolError, type Adapter, type ChangeSet, type ProjectMap } from '../core/types.ts';
import { camel, kebab } from '../input/naming.ts';

/** CSS hex is RRGGBB or RRGGBBAA; Flutter's Color(0x...) is AARRGGBB. */
export function dartArgb(hex: string): string {
  return hex.length === 8 ? `${hex.slice(6)}${hex.slice(0, 6)}` : `FF${hex}`;
}

export type TokenKind = 'color' | 'size' | 'font';

export interface ThemeToken {
  name: string;
  kind: TokenKind;
  value: string;
}

export function parseToken(name: string, value: string): ThemeToken {
  const v = value.trim();
  if (/^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) && (v.startsWith('#') || /color|primary|secondary|accent|background|surface|error|text/i.test(name))) {
    let hex = v.replace('#', '').toUpperCase();
    if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((c) => c + c).join('');
    return { name, kind: 'color', value: hex };
  }
  if (/^\d+(\.\d+)?(px)?$/.test(v)) return { name, kind: 'size', value: v.replace(/px$/, '') };
  if (/^(font|fontFamily|font-family|font-sans)$/i.test(name) || /^[A-Za-z][\w '-]*$/.test(v)) return { name, kind: 'font', value: v.replace(/^['"]|['"]$/g, '') };
  throw new ToolError('bad_value', `Cannot tell what "${value}" is.`, 'Use a hex color (#6750A4), a number (12) or a font name (Inter).');
}

// ---------------- Flutter ----------------

function dartReplaceOrAdd(text: string, cls: string, decl: RegExp, line: string): string {
  const head = new RegExp(`class\\s+${cls}\\b[^{]*\\{`).exec(text)!;
  const open = head.index + head[0].length - 1;
  const close = matchBrace(text, open, 'dart');
  const body = text.slice(open, close);
  const m = decl.exec(body);
  if (m) return text.slice(0, open + m.index) + line.trim() + text.slice(open + m.index + m[0].length);
  const before = text.slice(0, close).replace(/\s*$/, '');
  return `${before}\n  ${line.trim()}\n${text.slice(close)}`;
}

function findClassFile(root: string, files: Map<string, string>, cls: string): string | undefined {
  for (const [f, t] of files) if (new RegExp(`class\\s+${cls}\\b`).test(t)) return f;
  return walk(root, 'lib', { exts: ['.dart'] }).find((f) => new RegExp(`class\\s+${cls}\\b`).test(readText(join(root, f)) ?? ''));
}

function planFlutterTheme(root: string, map: ProjectMap, token: ThemeToken, files: Map<string, string>, summary: string[], warnings: string[]): void {
  const c = map.conventions;
  const read = (p: string) => files.get(p) ?? readText(join(root, p));
  const existingColors = findClassFile(root, files, 'AppColors');
  const folder = existingColors
    ? posix.dirname(existingColors)
    : c.modulesFolder || c.di === 'getx' || c.stateManagement === 'getx'
      ? `${(c.modulesFolder || 'lib/app/modules').replace(/\/modules$/, '')}/theme`
      : 'lib/core/theme';
  const colorsFile = existingColors ?? `${folder}/app_colors.dart`;
  const sizesFile = findClassFile(root, files, 'AppSizes') ?? `${folder}/app_sizes.dart`;
  const themeFile = findClassFile(root, files, 'AppTheme') ?? `${folder}/app_theme.dart`;
  const name = camel(token.name);

  const ensure = (file: string, cls: string, doc: string) => {
    const t = read(file);
    if (t !== null) return t.replace(/\r\n/g, '\n');
    summary.push(`Create ${file}: ${cls}`);
    return `${cls === 'AppColors' ? "import 'package:flutter/material.dart';\n\n" : ''}/// ${doc}\nclass ${cls} {\n  ${cls}._();\n}\n`;
  };
  const save = (file: string, text: string) => {
    const orig = readText(join(root, file));
    files.set(file, orig ? withEol(text, detectEol(orig)) : text);
  };

  if (token.kind === 'color') {
    const t = ensure(colorsFile, 'AppColors', 'App colors. Change them with: devtool theme set <name> <#hex>');
    const had = new RegExp(`\\bstatic\\s+const\\s+(?:Color\\s+)?${name}\\s*=`).test(t);
    save(colorsFile, dartReplaceOrAdd(t, 'AppColors', new RegExp(`static\\s+const\\s+(?:Color\\s+)?${name}\\s*=[^;]*;`), `static const Color ${name} = Color(0x${dartArgb(token.value)});`));
    summary.push(`${had ? 'Update' : 'Add'} AppColors.${name} = #${token.value} in ${colorsFile}`);
  } else if (token.kind === 'size') {
    const t = ensure(sizesFile, 'AppSizes', 'Spacing, radius and other sizes. Change them with: devtool theme set <name> <number>');
    const had = new RegExp(`\\bstatic\\s+const\\s+(?:double\\s+)?${name}\\s*=`).test(t);
    const v = token.value.includes('.') ? token.value : `${token.value}.0`;
    save(sizesFile, dartReplaceOrAdd(t, 'AppSizes', new RegExp(`static\\s+const\\s+(?:double\\s+)?${name}\\s*=[^;]*;`), `static const double ${name} = ${v};`));
    summary.push(`${had ? 'Update' : 'Add'} AppSizes.${name} = ${v} in ${sizesFile}`);
  }

  // AppTheme: seed color from AppColors.primary (or the first color), and the font.
  const themeExists = read(themeFile) !== null;
  if (token.kind === 'font' || !themeExists) {
    let t = read(themeFile)?.replace(/\r\n/g, '\n');
    if (t === undefined || t === null) {
      const colorsText = files.get(colorsFile) ?? read(colorsFile) ?? '';
      const seed = /static\s+const\s+(?:Color\s+)?primary\b/.test(colorsText) ? 'primary' : colorsText.match(/static\s+const\s+(?:Color\s+)?(\w+)\s*=/)?.[1];
      t = [
        "import 'package:flutter/material.dart';",
        '',
        '/// The app theme. Colors come from AppColors; change them with devtool theme set.',
        'class AppTheme {',
        '  AppTheme._();',
        '',
        '  static ThemeData get light => ThemeData(',
        `        colorScheme: ColorScheme.fromSeed(seedColor: ${seed ? `AppColors.${seed}` : 'Colors.deepPurple'}),`,
        '        useMaterial3: true,',
        '      );',
        '',
        '  static ThemeData get dark => ThemeData(',
        `        colorScheme: ColorScheme.fromSeed(seedColor: ${seed ? `AppColors.${seed}` : 'Colors.deepPurple'}, brightness: Brightness.dark),`,
        '        useMaterial3: true,',
        '      );',
        '}',
        '',
      ].join('\n');
      if (seed) t = addDartImport(t, importUri(themeFile, colorsFile, c));
      summary.push(`Create ${themeFile}: AppTheme.light / AppTheme.dark${seed ? ` seeded from AppColors.${seed}` : ''}`);
      if (!seed) warnings.push('AppTheme uses Colors.deepPurple until you set a color: devtool theme set primary #6750A4');
    }
    if (token.kind === 'font') {
      const font = `fontFamily: '${token.value.replace(/'/g, "\\'")}',`;
      if (/fontFamily:\s*'[^']*',/.test(t)) t = t.replace(/fontFamily:\s*'[^']*',/g, font);
      else t = t.replace(/(ThemeData\(\n)([ \t]*)/g, (_m, a: string, ind: string) => `${a}${ind}${font}\n${ind}`);
      summary.push(`Use the font ${token.value} in ${themeFile}`);
      warnings.push(`Add the ${token.value} font files under fonts: in pubspec.yaml (or use the google_fonts package), or Flutter falls back to the default font.`);
    }
    save(themeFile, t);
  } else if (token.kind === 'color') {
    // An AppTheme that seeds from a literal color switches to this one when it is the primary.
    const t = read(themeFile)!;
    if (name === 'primary' && /seedColor:\s*Colors\.\w+/.test(t)) {
      let next = t.replace(/seedColor:\s*Colors\.\w+/g, 'seedColor: AppColors.primary');
      next = addDartImport(next.replace(/\r\n/g, '\n'), importUri(themeFile, colorsFile, c));
      save(themeFile, next);
      summary.push(`Seed ${themeFile} from AppColors.primary`);
    }
  }

  // Wire AppTheme into the app.
  const mainFile = 'lib/main.dart';
  const main = read(mainFile);
  if (main === null) return;
  if (/\bAppTheme\.light\b/.test(main)) return;
  const app = /\b(?:GetMaterialApp|MaterialApp)(?:\.router)?\s*\(/.exec(main);
  if (!app) {
    warnings.push(`No MaterialApp in ${mainFile}; pass theme: AppTheme.light to it yourself.`);
    return;
  }
  const open = app.index + app[0].length - 1;
  const close = matchBrace(main, open, 'dart');
  const args = main.slice(open, close);
  const indent = main.slice(main.lastIndexOf('\n', app.index) + 1).match(/^[ \t]*/)![0];
  let next = main.replace(/\r\n/g, '\n');
  const themeArg = /\n?([ \t]*)theme:\s*/.exec(args);
  if (themeArg) {
    // Only the template theme (fromSeed + useMaterial3) is replaced; a hand-built one stays.
    const vStart = open + themeArg.index + themeArg[0].length;
    const vEnd = /^ThemeData\s*\(/.test(main.slice(vStart)) ? matchBrace(main, main.indexOf('(', vStart), 'dart') + 1 : -1;
    const value = vEnd > 0 ? main.slice(vStart, vEnd) : '';
    const stripped = value.replace(/\s+/g, '');
    if (/^ThemeData\(colorScheme:ColorScheme\.fromSeed\(seedColor:[\w.]+\),(useMaterial3:true,?)?\)$/.test(stripped)) {
      next = main.slice(0, vStart) + 'AppTheme.light' + main.slice(vEnd);
      next = next.replace(/\r\n/g, '\n');
      summary.push(`Update ${mainFile}: theme: AppTheme.light (replaces the template theme)`);
    } else {
      warnings.push(`${mainFile} already builds its own theme; switch it to theme: AppTheme.light to use these tokens.`);
      return;
    }
  } else {
    const inner = main.slice(open + 1, close);
    const add = `\n${indent}  theme: AppTheme.light,\n${indent}  darkTheme: AppTheme.dark,`;
    next = inner.includes('\n')
      ? main.slice(0, open + 1) + add + main.slice(open + 1)
      : `${main.slice(0, open + 1)}${add}${inner.trim() ? `\n${indent}  ${inner.trim().replace(/,$/, '')},` : ''}\n${indent}${main.slice(close)}`;
    next = next.replace(/\r\n/g, '\n');
    summary.push(`Update ${mainFile}: theme: AppTheme.light, darkTheme: AppTheme.dark`);
  }
  next = addDartImport(next, importUri(mainFile, themeFile, c));
  files.set(mainFile, withEol(next, detectEol(main)));
}

// ---------------- Next.js ----------------

const CSS_CANDIDATES = ['app/globals.css', 'src/app/globals.css', 'styles/globals.css', 'src/styles/globals.css'];

function tailwindConfig(root: string): string | undefined {
  return ['tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.mjs', 'tailwind.config.cjs'].find((f) => exists(join(root, f)));
}

function cssVarName(token: ThemeToken, v4: boolean): string {
  const k = kebab(token.name).replace(/^(color|font|radius|spacing)-/, '');
  if (token.kind === 'color') return `--color-${k}`;
  if (token.kind === 'font') return v4 ? `--font-${/^(font|font-family|fontfamily)$/i.test(token.name) ? 'sans' : k}` : `--font-${/^(font|font-family|fontfamily)$/i.test(token.name) ? 'sans' : k}`;
  if (/radius/i.test(token.name)) return `--radius-${k === 'radius' ? 'DEFAULT' : k}`.replace('--radius-DEFAULT', '--radius');
  return `--spacing-${k}`;
}

function cssValue(token: ThemeToken): string {
  if (token.kind === 'color') return `#${token.value.toLowerCase()}`;
  if (token.kind === 'size') return `${token.value}px`;
  return `"${token.value}", ui-sans-serif, system-ui, sans-serif`;
}

/** Sets a custom property inside the block that starts at `open`. */
function setCssVar(css: string, open: number, name: string, value: string): { text: string; updated: boolean } {
  const close = css.indexOf('}', open);
  const body = css.slice(open, close);
  const re = new RegExp(`(^|\\n)([ \\t]*)${name.replace(/[-]/g, '\\-')}\\s*:[^;]*;`);
  const m = re.exec(body);
  if (m) return { text: css.slice(0, open + m.index) + `${m[1]}${m[2]}${name}: ${value};` + css.slice(open + m.index + m[0].length), updated: true };
  const indent = /\n([ \t]+)\S/.exec(body)?.[1] ?? '  ';
  const before = css.slice(0, close).replace(/[ \t]*$/, '');
  return { text: `${before}${before.endsWith('\n') ? '' : '\n'}${indent}${name}: ${value};\n${css.slice(close)}`, updated: false };
}

function planNextTheme(root: string, map: ProjectMap, token: ThemeToken, files: Map<string, string>, summary: string[], warnings: string[]): void {
  const cssFile = CSS_CANDIDATES.find((f) => exists(join(root, f))) ?? (exists(join(root, 'src/app')) ? 'src/app/globals.css' : 'app/globals.css');
  const orig = readText(join(root, cssFile));
  const created = orig === null && !files.has(cssFile);
  let css = (files.get(cssFile) ?? orig ?? '').replace(/\r\n/g, '\n');
  const v4 = /@import\s+["']tailwindcss["']/.test(css);
  const twConfig = !v4 ? tailwindConfig(root) : undefined;

  if (twConfig) {
    // Tailwind v3: theme.extend.<group>.<name>
    const group = token.kind === 'color' ? 'colors' : token.kind === 'font' ? 'fontFamily' : /radius/i.test(token.name) ? 'borderRadius' : 'spacing';
    const key = token.kind === 'font' && /^(font|font-family|fontfamily)$/i.test(token.name) ? 'sans' : camel(token.name).replace(/Radius$|^radius$/, (m) => (m === 'radius' ? 'DEFAULT' : ''));
    const value = token.kind === 'color' ? `'#${token.value.toLowerCase()}'` : token.kind === 'size' ? `'${token.value}px'` : `['${token.value}', 'ui-sans-serif', 'system-ui', 'sans-serif']`;
    const t = (files.get(twConfig) ?? readText(join(root, twConfig))!).replace(/\r\n/g, '\n');
    const theme = /\btheme\s*:\s*\{/.exec(t);
    if (!theme) throw new ToolError('no_theme', `${twConfig} has no theme: {} section.`, 'Add theme: { extend: {} } to it, then run this again.');
    let next = t;
    const ensureObj = (text: string, open: number, prop: string): [string, number] => {
      const close = matchBrace(text, open, 'ts');
      const inner = text.slice(open, close);
      const m = new RegExp(`\\b${prop}\\s*:\\s*\\{`).exec(inner);
      if (m) return [text, open + m.index + m[0].length - 1];
      const indent = text.slice(text.lastIndexOf('\n', open) + 1).match(/^[ \t]*/)![0] + '  ';
      const ins = `\n${indent}${prop}: {\n${indent}},`;
      const n = text.slice(0, open + 1) + ins + text.slice(open + 1);
      return [n, open + 1 + ins.indexOf('{')];
    };
    let pos: number;
    [next, pos] = ensureObj(next, theme.index + theme[0].length - 1, 'extend');
    [next, pos] = ensureObj(next, pos, group);
    const close = matchBrace(next, pos, 'ts');
    const inner = next.slice(pos, close);
    const keyRe = new RegExp(`(\\n[ \\t]*)['"]?${key}['"]?\\s*:\\s*(\\[[^\\]]*\\]|'[^']*'|"[^"]*"|[^,\\n]+),?`);
    const m = keyRe.exec(inner);
    const prop = /^[A-Za-z_]\w*$/.test(key) ? key : `'${key}'`;
    if (m) next = next.slice(0, pos + m.index) + `${m[1]}${prop}: ${value},` + next.slice(pos + m.index + m[0].length);
    else {
      const indent = next.slice(next.lastIndexOf('\n', pos) + 1).match(/^[ \t]*/)![0];
      const before = next.slice(0, close).replace(/\s*$/, '');
      next = `${before}${before.endsWith('{') || before.endsWith(',') ? '' : ','}\n${indent}  ${prop}: ${value},\n${indent}${next.slice(close)}`;
    }
    files.set(twConfig, withEol(next, detectEol(readText(join(root, twConfig))!)));
    summary.push(`${m ? 'Update' : 'Add'} theme.extend.${group}.${key} = ${value} in ${twConfig}`);
    summary.push(`Use it as a class: ${token.kind === 'color' ? `bg-${kebab(token.name)} text-${kebab(token.name)}` : token.kind === 'font' ? `font-${key === 'sans' ? 'sans' : kebab(key)}` : group === 'borderRadius' ? (key === 'DEFAULT' ? 'rounded' : `rounded-${kebab(key)}`) : `p-${kebab(key)} gap-${kebab(key)}`}`);
    return;
  }

  const name = cssVarName(token, v4);
  const value = cssValue(token);
  let updated = false;
  if (v4) {
    // Tailwind v4: @theme { --color-primary: ... } makes bg-primary, text-primary, etc.
    let theme = /@theme(?:\s+inline)?\s*\{/.exec(css);
    if (!theme) {
      const imp = /@import\s+["']tailwindcss["'];?\n?/.exec(css)!;
      const at = imp.index + imp[0].length;
      css = `${css.slice(0, at)}${imp[0].endsWith('\n') ? '' : '\n'}\n@theme {\n}\n${css.slice(at)}`;
      theme = /@theme\s*\{/.exec(css)!;
    }
    ({ text: css, updated } = setCssVar(css, theme.index + theme[0].length - 1, name, value));
    summary.push(`${updated ? 'Update' : 'Add'} ${name}: ${value} in the @theme block of ${cssFile}`);
    const util = name.replace(/^--color-/, 'bg-').replace(/^--font-/, 'font-').replace(/^--radius-?/, 'rounded-').replace(/^--spacing-/, 'p-').replace(/-$/, '');
    summary.push(`Use it as a class: ${util}`);
  } else {
    let rootSel = /:root\s*\{/.exec(css);
    if (!rootSel) {
      css = `:root {\n}\n${css ? `\n${css}` : ''}`;
      rootSel = /:root\s*\{/.exec(css)!;
    }
    ({ text: css, updated } = setCssVar(css, rootSel.index + rootSel[0].length - 1, name, value));
    summary.push(`${created ? `Create ${cssFile}: ` : `${updated ? 'Update' : 'Add'} `}${name}: ${value} in :root`);
    summary.push(`Use it in CSS: var(${name})`);
    if (created) {
      const layout = ['app/layout.tsx', 'src/app/layout.tsx', 'app/layout.jsx', 'src/app/layout.jsx'].find((f) => exists(join(root, f)));
      if (layout) {
        const lt = files.get(layout) ?? readText(join(root, layout))!;
        if (!/globals\.css/.test(lt)) {
          const rel = posix.relative(posix.dirname(layout), cssFile);
          const imp = `import '${rel.startsWith('.') ? rel : `./${rel}`}';\n`;
          const lastImport = [...lt.matchAll(/^import[^\n]*\n/gm)].pop();
          const at = lastImport ? lastImport.index! + lastImport[0].length : 0;
          files.set(layout, lt.slice(0, at) + imp + lt.slice(at));
          summary.push(`Update ${layout}: import the global styles`);
        }
      }
    }
  }
  if (token.kind === 'font') warnings.push(`Load ${token.value} too (next/font/google or a <link>), or the browser uses the fallback font.`);
  files.set(cssFile, orig ? withEol(css, detectEol(orig)) : css);
  void map;
}

// ---------------- React Native ----------------

/** src/theme/index.ts: colors, sizes and fonts objects that screens import. */
function planRnTheme(root: string, map: ProjectMap, token: ThemeToken, files: Map<string, string>, summary: string[]): void {
  const src = map.conventions.screensFolder?.startsWith('src/') || exists(join(root, 'src')) ? 'src/' : '';
  const file = `${src}theme/index.ts`;
  const semi = map.conventions.semicolons === 'false' ? '' : ';';
  let t = files.get(file) ?? readText(join(root, file)) ?? `export const colors = {\n}${semi}\n\nexport const sizes = {\n}${semi}\n\nexport const fonts = {\n}${semi}\n`;
  const obj = token.kind === 'color' ? 'colors' : token.kind === 'size' ? 'sizes' : 'fonts';
  const key = token.kind === 'font' && /^(font|fontFamily|font-family|font-sans)$/i.test(token.name) ? 'body' : token.name.replace(/[-_](\w)/g, (_m, ch: string) => ch.toUpperCase());
  const value = token.kind === 'color' ? `'#${token.value}'` : token.kind === 'size' ? token.value : `'${token.value}'`;
  const block = new RegExp(`(export const ${obj}\\s*=\\s*\\{)([\\s\\S]*?)(\\n\\}\\s*(?:as const)?;?)`).exec(t);
  if (!block) t = `${t.replace(/\s*$/, '\n')}\nexport const ${obj} = {\n  ${key}: ${value},\n}${semi}\n`;
  else {
    const line = new RegExp(`^(\\s*)${key}\\s*:.*$`, 'm');
    const inner = line.test(block[2]) ? block[2].replace(line, `$1${key}: ${value},`) : `${block[2]}\n  ${key}: ${value},`;
    t = t.replace(block[0], `${block[1]}${inner}${block[3]}`);
  }
  files.set(file, t);
  summary.push(`${readText(join(root, file)) === null ? 'Create' : 'Update'} ${file}: ${obj}.${key} = ${value}`);
  summary.push(`Use it in a screen: import { ${obj} } from '${importPath(`${map.conventions.screensFolder || `${src}screens`}/X.tsx`, file, { ...map.conventions, importStyle: 'relative' }).replace(/\.ts$/, '')}'`);
}

/** Android: Color.kt / Dimens.kt values in ui/theme; primary also feeds the color scheme when Theme.kt uses Primary. */
function planAndroidTheme(root: string, map: ProjectMap, token: ThemeToken, files: Map<string, string>, summary: string[], warnings: string[]): void {
  const c = map.conventions;
  if (token.kind === 'font') return void warnings.push(`Fonts are not set by devtool on Android yet; add a FontFamily for ${token.value} to ui/theme/Type.kt.`);
  const srcDir = c.srcDir || 'app/src/main/java';
  const dir = `${srcDir}/${(c.namespace || 'app').replace(/\./g, '/')}/ui/theme`;
  const pkg = `${c.namespace}.ui.theme`;
  const file = `${dir}/${token.kind === 'color' ? 'Color' : 'Dimens'}.kt`;
  const before = files.get(file) ?? readText(join(root, file));
  let t = before ?? (token.kind === 'color' ? `package ${pkg}\n\nimport androidx.compose.ui.graphics.Color\n` : `package ${pkg}\n\nimport androidx.compose.ui.unit.dp\n`);
  const name = token.name.replace(/[-_](\w)/g, (_m, ch: string) => ch.toUpperCase()).replace(/^\w/, (ch) => ch.toUpperCase());
  const value = token.kind === 'color' ? `Color(0xFF${token.value.toUpperCase()})` : `${token.value}.dp`;
  const line = new RegExp(`^val\\s+${name}\\s*=.*$`, 'm');
  t = line.test(t) ? t.replace(line, `val ${name} = ${value}`) : `${t.replace(/\s*$/, '\n')}\nval ${name} = ${value}\n`;
  if (token.kind === 'size' && !/import androidx\.compose\.ui\.unit\.dp/.test(t)) t = t.replace(/^(package [^\n]+\n)/, '$1\nimport androidx.compose.ui.unit.dp\n');
  files.set(file, t);
  summary.push(`${before === null ? 'Create' : 'Update'} ${file}: ${name} = ${value}`);
  const themeKt = readText(join(root, dir, 'Theme.kt'));
  if (token.kind === 'color' && name === 'Primary' && themeKt !== null && !/\bprimary\s*=\s*Primary\b/.test(themeKt)) warnings.push(`${dir}/Theme.kt does not use Primary in its color scheme; pass primary = Primary to lightColorScheme(...).`);
}

export async function planThemeSet(root: string, adapter: Adapter, tokens: { name: string; value: string }[]): Promise<ChangeSet> {
  if (!tokens.length) throw new ToolError('bad_args', 'Usage: devtool theme set <name> <value> [<name> <value> ...]');
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  const files = new Map<string, string>();
  const summary: string[] = [];
  const warnings: string[] = [];
  // Colors first so a new AppTheme seeds from them.
  const parsed = tokens.map((t) => parseToken(t.name, t.value)).sort((a, b) => (a.kind === 'color' ? -1 : 0) - (b.kind === 'color' ? -1 : 0));
  for (const token of parsed) {
    if (adapter.id === 'flutter') planFlutterTheme(root, map, token, files, summary, warnings);
    else if (adapter.id === 'nextjs') planNextTheme(root, map, token, files, summary, warnings);
    else if (adapter.id === 'react-native') planRnTheme(root, map, token, files, summary);
    else if (adapter.id === 'android') planAndroidTheme(root, map, token, files, summary, warnings);
    else throw new ToolError('not_supported', `theme set needs the Next.js, Flutter, React Native or Android adapter; this project uses the ${adapter.id} adapter.`, adapter.id === 'react' ? 'For React web apps, set the color in your CSS (a :root variable) or your Tailwind config; theme set does not edit them yet.' : adapter.id === 'ios' ? 'For iOS, set the color in Assets.xcassets (AccentColor); theme set does not edit it yet.' : undefined);
  }
  return buildChangeSet(root, 'theme set', { files, summary: [...new Set(summary)], warnings: [...new Set(warnings)], generated: [] });
}
