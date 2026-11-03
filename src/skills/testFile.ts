// codz test add --file <path>: tests for one file, by what it is.
//
//   API / repository file   tests for its endpoints (as test add <endpoint>)
//   screen, page, view,     the screen test screen add writes: the screen (or its
//   ViewModel, controller   ViewModel) with the endpoint it calls answered by a fake
//   anything else           TypeScript and Dart: a test per exported function that
//                           calls it with example arguments; the expected values
//                           are left for you, marked TODO
//
// It reads the file (and the ViewModel, controller, Cubit or hook next to it) to
// find which endpoint the screen calls and which route parameters it takes.

import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { loadMap } from '../core/cache.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { loadConfig } from '../core/config.ts';
import { readText, walk } from '../core/fsutil.ts';
import { ToolError, type Adapter, type ChangeSet, type EndpointInfo, type ProjectMap } from '../core/types.ts';
import { exampleFor } from './mock.ts';
import { androidScreenTest, flutterScreenTest, iosScreenTest, jsScreenTest, type ScreenTest } from './screenTests.ts';
import { dartLiteral, planTestAdd } from './testgen.ts';

/** The files that hold a screen's state next to it: ViewModel, GetX controller or view, Cubit, SwiftUI view model. */
function companions(root: string, file: string): string[] {
  const dir = posix.dirname(file);
  const base = posix.basename(file);
  const out: string[] = [];
  const add = (f: string) => {
    if (f !== file && existsSync(join(root, f))) out.push(f);
  };
  let m: RegExpExecArray | null;
  if ((m = /^(\w+?)(Screen|Activity)\.kt$/.exec(base))) add(`${dir}/${m[1]}ViewModel.kt`);
  if ((m = /^(\w+?)View\.swift$/.exec(base))) add(`${dir}/${m[1]}ViewModel.swift`);
  if ((m = /^(\w+)_view\.dart$/.exec(base)) && /\/views$/.test(dir)) add(`${posix.dirname(dir)}/controllers/${m[1]}_controller.dart`);
  if ((m = /^(\w+)_controller\.dart$/.exec(base)) && /\/controllers$/.test(dir)) add(`${posix.dirname(dir)}/views/${m[1]}_view.dart`);
  if ((m = /^(\w+)_page\.dart$/.exec(base))) add(`${dir}/${m[1]}_cubit.dart`);
  if ((m = /^(\w+)ViewModel\.(kt|swift)$/.exec(base))) {
    if (m[2] === 'swift') add(`${dir}/${m[1]}View.swift`);
    else for (const s of ['Screen', 'Activity']) add(`${dir}/${m[1]}${s}.kt`);
  }
  return out;
}

/** Hook files a React component imports (they call the endpoint for it). */
function importedHooks(root: string, map: ProjectMap, text: string): string[] {
  const folder = map.conventions.hooksFolder;
  if (!folder) return [];
  const names = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*hooks[^'"]*['"]/g)].flatMap((m) => m[1].split(',').map((x) => x.trim()));
  if (!names.length) return [];
  return walk(root, folder, { exts: ['.ts', '.tsx'] }).filter((f) => names.some((n) => new RegExp(`export function ${n}\\b`).test(readText(join(root, f)) ?? '')));
}

/** Route parameters a screen reads. */
function routeParams(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(/const \{([^}]+)\} = (?:await params|params|useParams[^(]*\(\)|route\.params|useLocalSearchParams[^(]*\(\))/g)) for (const n of m[1].split(',')) out.add(n.trim().split(/[:\s]/)[0]);
    for (const m of t.matchAll(/savedStateHandle\["(\w+)"\]/g)) out.add(m[1]);
    const widget = /class\s+\w+\s+extends\s+(?:StatelessWidget|StatefulWidget|ConsumerStatefulWidget|ConsumerWidget)\s*\{\s*const\s+\w+\(\{([^}]*)\}\)/.exec(t);
    if (widget) for (const m of widget[1].matchAll(/required\s+this\.(\w+)/g)) out.add(m[1]);
  }
  return [...out].filter(Boolean);
}

export async function planTestFile(root: string, adapter: Adapter, fileArg: string): Promise<ChangeSet> {
  const file = posix.normalize(fileArg.replace(/\\/g, '/')).replace(/^\.\//, '');
  const text = readText(join(root, file));
  if (text === null) throw new ToolError('not_found', `No file ${file}.`);
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  // 1. An API file: its endpoints.
  const own = map.endpoints.filter((e) => e.file === file);
  if (own.length) return planTestAdd(root, adapter, { endpoints: own.map((e) => e.name), all: false });
  // 2. A screen or its state holder: the screen test.
  const related = [...companions(root, file), ...(/\.(tsx|jsx)$/.test(file) ? importedHooks(root, map, text) : [])];
  const texts = [text, ...related.map((f) => readText(join(root, f)) ?? '')];
  const ep = map.endpoints.find((e) => texts.some((t) => new RegExp(`\\b${e.name}\\s*\\(`).test(t)));
  if (ep) {
    const files = new Map<string, string>([[file, text], ...related.map((f): [string, string] => [f, readText(join(root, f)) ?? ''])]);
    const params = routeParams(texts);
    const input = { files, ep, params, paged: texts.some((t) => /\bhasMore\b|\bloadMore\b/.test(t)), existing: true };
    const t: ScreenTest | { skip: string } | null =
      adapter.id === 'flutter'
        ? flutterScreenTest(root, map, input)
        : adapter.id === 'android'
          ? androidScreenTest(root, map, input)
          : adapter.id === 'ios'
            ? iosScreenTest(root, map, input)
            : ['nextjs', 'react', 'react-native'].includes(adapter.id)
              ? jsScreenTest(root, map, { ...input, route: params.length ? `/screen/${params.map((p) => `:${p}`).join('/')}` : '/' })
              : null;
    if (!t) throw new ToolError('not_supported', `codz cannot write screen tests for the ${adapter.id} adapter.`);
    if ('skip' in t) throw new ToolError('not_supported', `No test for ${file}: ${t.skip}.`);
    if (readText(join(root, t.file)) !== null) throw new ToolError('test_exists', `${t.file} already exists.`, 'Delete it to write it again.');
    const out = new Map<string, string>([[t.file, t.text], ...(t.extra ?? [])]);
    return buildChangeSet(root, 'test add', { files: out, summary: [`${t.summary} (it calls ${ep.name}())`, ...(t.extraSummary ?? [])], warnings: t.warnings, generated: [] });
  }
  // 3. Anything else: one test per exported function.
  return scaffold(root, map, adapter, file, text);
}

// ---------- functions ----------

function tsArg(type: string, name: string, map: ProjectMap): string {
  const t = type.trim().replace(/\s*\|\s*undefined$/, '');
  if (/^string$/.test(t)) return JSON.stringify(/date|_at$|At$/.test(name) ? '2026-01-01T09:00:00Z' : /email/i.test(name) ? 'user@example.com' : 'text');
  if (/^number$/.test(t)) return '1';
  if (/^boolean$/.test(t)) return 'true';
  if (/\[\]$|^Array</.test(t)) return '[]';
  if (/^Date$/.test(t)) return "new Date('2026-01-01T09:00:00Z')";
  const model = map.models.find((m) => m.name === t);
  if (model) return `${JSON.stringify(exampleFor(model.name, map))} as never`;
  return '{} as never';
}

function dartArg(type: string, name: string, map: ProjectMap): string {
  const t = type.trim().replace(/\?$/, '');
  if (t === 'String') return /date|At$/.test(name) ? "'2026-01-01T09:00:00Z'" : "'text'";
  if (t === 'int') return '1';
  if (t === 'double' || t === 'num') return '1.5';
  if (t === 'bool') return 'true';
  if (t === 'DateTime') return "DateTime.utc(2026, 1, 1)";
  if (/^List</.test(t)) return 'const []';
  if (/^Map</.test(t)) return 'const {}';
  const model = map.models.find((m) => m.name === t);
  if (model) return `${t}.fromJson(${dartLiteral(exampleFor(model.name, map), '      ')})`;
  return '';
}

function scaffold(root: string, map: ProjectMap, adapter: Adapter, file: string, text: string): ChangeSet {
  const summary: string[] = [];
  const warnings: string[] = [];
  if (/\.(ts|tsx|js|jsx)$/.test(file)) {
    const fns: { name: string; params: { name: string; type: string; optional: boolean }[]; ret: string; isAsync: boolean }[] = [];
    for (const m of text.matchAll(/export\s+(async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\(([^)]*)\)\s*(?::\s*([^{]+))?\{/g)) fns.push({ name: m[2], params: splitTs(m[3]), ret: (m[4] ?? '').trim(), isAsync: Boolean(m[1]) });
    for (const m of text.matchAll(/export\s+const\s+(\w+)\s*=\s*(async\s+)?\(([^)]*)\)\s*(?::\s*([^=]+))?=>/g)) fns.push({ name: m[1], params: splitTs(m[3]), ret: (m[4] ?? '').trim(), isAsync: Boolean(m[2]) });
    if (!fns.length) throw new ToolError('no_functions', `${file} has no exported functions to test.`);
    const pkg = readText(join(root, 'package.json')) ?? '';
    const jest = !/"vitest"/.test(pkg) && (/"jest"|"jest-expo"/.test(pkg) || map.framework === 'react-native');
    const testFile = file.replace(/\.(tsx?|jsx?)$/, '.test.$1').replace(/\.test\.tsx$/, '.test.ts').replace(/\.test\.jsx$/, '.test.js');
    if (readText(join(root, testFile)) !== null) throw new ToolError('test_exists', `${testFile} already exists.`, 'Delete it to write it again.');
    const blocks = fns.map((f) => {
      const args = f.params.filter((p) => !p.optional).map((p) => tsArg(p.type, p.name, map)).join(', ');
      const voidish = /^(void|Promise<void>)$/.test(f.ret);
      const call = `${f.isAsync || /^Promise</.test(f.ret) ? 'await ' : ''}${f.name}(${args})`;
      return [
        `describe('${f.name}', () => {`,
        `  it('runs with example arguments', async () => {`,
        voidish ? `    ${call};` : `    const result = ${call};`,
        ...(voidish ? [] : ['    expect(result).toBeDefined();', `    // TODO: the value ${f.name} should return here, for example: expect(result).toEqual(...)`]),
        '  });',
        '});',
      ].join('\n');
    });
    const base = `./${posix.basename(file).replace(/\.(tsx?|jsx?)$/, '')}`;
    const content = [...(jest ? [] : ["import { describe, expect, it } from 'vitest';"]), `import { ${fns.map((f) => f.name).join(', ')} } from '${base}';`, '', blocks.join('\n\n'), ''].join('\n');
    summary.push(`Create ${testFile}: a test per exported function (${fns.map((f) => f.name).join(', ')}), called with example arguments`);
    warnings.push(`codz cannot know what ${fns.length === 1 ? 'the function returns' : 'these functions return'}: the tests check that ${fns.length === 1 ? 'it runs' : 'they run'}; fill in the expected values where it says TODO.`);
    return buildChangeSet(root, 'test add', { files: new Map([[testFile, content]]), summary, warnings, generated: [] });
  }
  if (file.endsWith('.dart')) {
    const fns: { name: string; params: { name: string; type: string }[]; ret: string; skip: boolean }[] = [];
    for (const m of text.matchAll(/^([\w<>?, ]+?)\s+(\w+)\s*\(([^)]*)\)\s*(?:async\s*)?(?:\{|=>)/gm)) {
      if (/^(class|return|if|for|while|switch|else|new)\b/.test(m[1]) || m[2].startsWith('_') || m[2] === 'main') continue;
      const params: { name: string; type: string }[] = [];
      let skip = false;
      for (const p of m[3].split(',').map((x) => x.trim()).filter(Boolean)) {
        const pm = /^([\w<>?, ]+?)\s+(\w+)$/.exec(p.replace(/^[{[]|[}\]]$/g, '').replace(/^required\s+/, ''));
        if (!pm) skip = true;
        else if (!/^[{[]/.test(p) || /required/.test(p)) params.push({ name: pm[2], type: pm[1] });
      }
      fns.push({ name: m[2], params, ret: m[1].trim(), skip });
    }
    const usable = fns.filter((f) => !f.skip && f.params.every((p) => dartArg(p.type, p.name, map)));
    if (!usable.length) throw new ToolError('no_functions', `${file} has no top-level functions codz can call (for widgets and screens, it needs the endpoint the screen calls).`);
    const pkg = map.conventions.packageName;
    const testFile = `test/${file.replace(/^lib\//, '').replace(/\.dart$/, '_test.dart')}`;
    if (readText(join(root, testFile)) !== null) throw new ToolError('test_exists', `${testFile} already exists.`, 'Delete it to write it again.');
    const tests = usable.map((f) => {
      const args = f.params.map((p) => dartArg(p.type, p.name, map)).join(', ');
      const voidish = /^(void|Future<void>)$/.test(f.ret);
      const call = `${/^Future</.test(f.ret) ? 'await ' : ''}${f.name}(${args})`;
      return [`  test('${f.name} runs with example arguments', () async {`, voidish ? `    ${call};` : `    final result = ${call};`, ...(voidish ? [] : ['    expect(result, isNotNull);', `    // TODO: the value ${f.name} should return here, for example: expect(result, equals(...));`]), '  });'].join('\n');
    });
    const content = ["import 'package:flutter_test/flutter_test.dart';", `import '${pkg ? `package:${pkg}/${file.replace(/^lib\//, '')}` : posix.relative('test', file)}';`, '', 'void main() {', tests.join('\n\n'), '}', ''].join('\n');
    summary.push(`Create ${testFile}: a test per top-level function (${usable.map((f) => f.name).join(', ')}), called with example arguments`);
    warnings.push('codz cannot know what the functions return: the tests check that they run; fill in the expected values where it says TODO.');
    return buildChangeSet(root, 'test add', { files: new Map([[testFile, content]]), summary, warnings, generated: [] });
  }
  void adapter;
  throw new ToolError('not_supported', `codz writes tests for screens, ViewModels and API files here; for other ${posix.extname(file)} files it does not yet.`, 'Point it at the screen, its ViewModel, or the API file.');
}

function splitTs(params: string): { name: string; type: string; optional: boolean }[] {
  const out: { name: string; type: string; optional: boolean }[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of params) {
    if ('{[(<'.includes(ch)) depth++;
    else if ('}])>'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      out.push(parseOne(cur));
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(parseOne(cur));
  return out.filter((p) => p.name);
}

function parseOne(p: string): { name: string; type: string; optional: boolean } {
  const m = /^\s*(\w+)(\?)?\s*(?::\s*([^=]+))?(=.*)?$/.exec(p.trim());
  return m ? { name: m[1], type: (m[3] ?? 'unknown').trim(), optional: Boolean(m[2] || m[4]) } : { name: '', type: '', optional: true };
}

export type { EndpointInfo };
