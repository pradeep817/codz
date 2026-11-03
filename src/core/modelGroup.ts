// One file per top-level model: nested models a change creates go into the
// file of the model that uses them (order.dart holds Order, Customer,
// OrderItem), instead of one file each. A nested model that several top-level
// models use keeps its own file. Only files the change creates are touched;
// imports of the merged files in the other planned files point at the main
// file instead.
//
// Turn it off with --split, or modelFiles: split in codz.config.yaml.

import { join, posix } from 'node:path';
import { exists } from './fsutil.ts';
import type { ProjectMap } from './types.ts';

export type ModelLang = 'ts' | 'dart' | 'kt' | 'swift';
export const modelLangOf = (adapterId: string): ModelLang => (adapterId === 'flutter' ? 'dart' : adapterId === 'android' ? 'kt' : adapterId === 'ios' ? 'swift' : 'ts');

const EXT: Record<ModelLang, RegExp> = { ts: /\.tsx?$/, dart: /\.dart$/, kt: /\.kt$/, swift: /\.swift$/ };
const DECL: Record<ModelLang, RegExp> = {
  ts: /^export\s+(?:interface|type)\s+(\w+)/gm,
  dart: /^(?:abstract\s+|sealed\s+|final\s+)*class\s+(\w+)/gm,
  kt: /^(?:@\w+(?:\([^)]*\))?\s*)*data\s+class\s+(\w+)/gm,
  swift: /^(?:public\s+)?struct\s+(\w+)/gm,
};

/** The file's leading package/import/part lines, and the rest. */
function splitHeader(text: string, lang: ModelLang): { header: string[]; body: string } {
  const lines = text.split('\n');
  const isHead = (l: string) => (lang === 'ts' ? /^import\s/.test(l) : lang === 'dart' ? /^(import|part|export|library)\s/.test(l) : lang === 'kt' ? /^(package|import)\s/.test(l) : /^import\s/.test(l));
  let i = 0;
  const header: string[] = [];
  while (i < lines.length && (isHead(lines[i]) || lines[i].trim() === '')) {
    if (lines[i].trim()) header.push(lines[i]);
    i++;
  }
  return { header, body: lines.slice(i).join('\n').replace(/\s+$/, '') };
}

const stem = (f: string) => posix.basename(f).replace(/\.[^.]+$/, '');
const importTarget = (l: string) => /['"]([^'"]+)['"]/.exec(l)?.[1];
const targetStem = (t: string) => posix.basename(t).replace(/\.(dart|ts|tsx|js)$/, '').replace(/\.(g|freezed)$/, '');

/** Is this a file of models the project keeps models in? */
function inModelsFolder(f: string, map: ProjectMap): boolean {
  const c = map.conventions;
  return Boolean((c.modelsFolder && f.startsWith(`${c.modelsFolder}/`)) || (c.modelsFile && f === c.modelsFile));
}

/**
 * Groups the new model files of a planned change (--model-dir has already set
 * modelsFolder for this run).
 */
export function groupNewModels(root: string, files: Map<string, string>, map: ProjectMap, lang: ModelLang, split = false): Map<string, string> {
  if (split || map.conventions.modelFiles === 'split' || (lang === 'ts' && map.conventions.modelsLayout === 'single')) return files;
  // New model files and the models each declares.
  const declared = new Map<string, string[]>();
  for (const [f, t] of files) {
    if (!EXT[lang].test(f) || /(^|\/)index\.ts$/.test(f) || exists(join(root, f)) || !inModelsFolder(f, map)) continue;
    const names = [...t.matchAll(DECL[lang])].map((m) => m[1]).filter((n) => !n.startsWith('_'));
    if (names.length) declared.set(f, names);
  }
  if (declared.size < 2) return files;
  const fileOf = new Map<string, string>();
  for (const [f, ns] of declared) for (const n of ns) fileOf.set(n, f);
  // Which new files each new file uses.
  const uses = new Map<string, Set<string>>();
  for (const f of declared.keys()) {
    const body = splitHeader(files.get(f)!, lang).body;
    const own = new Set(declared.get(f));
    const used = new Set<string>();
    for (const [n, g] of fileOf) if (g !== f && !own.has(n) && new RegExp(`\\b${n}\\b`).test(body)) used.add(g);
    uses.set(f, used);
  }
  const usedBy = new Map<string, Set<string>>();
  for (const [f, us] of uses) for (const u of us) usedBy.set(u, (usedBy.get(u) ?? new Set()).add(f));
  // Top-level: new files no other new file uses.
  const tops = [...declared.keys()].filter((f) => !usedBy.has(f));
  const reach = new Map<string, Set<string>>();
  for (const t of tops) {
    const seen = new Set<string>();
    const stack = [...(uses.get(t) ?? [])];
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f) || tops.includes(f)) continue;
      seen.add(f);
      stack.push(...(uses.get(f) ?? []));
    }
    for (const f of seen) reach.set(f, (reach.get(f) ?? new Set()).add(t));
  }
  // Each nested file reached by exactly one top-level file goes into it.
  const into = new Map<string, string>();
  for (const [f, owners] of reach) if (owners.size === 1) into.set(f, [...owners][0]);
  if (!into.size) return files;
  const groups = new Map<string, string[]>();
  for (const [f, main] of into) groups.set(main, [...(groups.get(main) ?? []), f]);
  // Keep the order the models were planned in.
  const order = [...files.keys()];
  for (const list of groups.values()) list.sort((a, b) => order.indexOf(a) - order.indexOf(b));

  const out = new Map(files);
  const mergedStem = new Map<string, string>(); // merged file stem → main file stem
  for (const [main, nested] of groups) {
    const head = splitHeader(out.get(main)!, lang);
    const header = [...head.header];
    const bodies = [head.body];
    const nestedStems = new Set(nested.map(stem));
    for (const f of nested) {
      const part = splitHeader(out.get(f)!, lang);
      for (const l of part.header) if (!/^(package|part)\s/.test(l) && !header.includes(l)) header.push(l);
      bodies.push(part.body);
      out.delete(f);
      mergedStem.set(stem(f), stem(main));
    }
    const kept = header.filter((l) => /^part\s/.test(l) || !nestedStems.has(targetStem(importTarget(l) ?? '')) || !importTarget(l));
    const pkg = kept.filter((l) => /^package\s/.test(l));
    let imports = kept.filter((l) => /^(import|export|library)\s/.test(l));
    if (lang === 'kt') imports = [...new Set(imports)].sort();
    const parts = kept.filter((l) => /^part\s/.test(l));
    const top = [pkg, imports, parts].filter((g) => g.length).map((g) => g.join('\n')).join('\n\n');
    out.set(main, `${top ? `${top}\n\n` : ''}${bodies.join('\n\n')}\n`);
  }
  // Other planned files: imports of a merged file point at its main file; a models index stops exporting it.
  for (const [f, t] of out) {
    const lines = t.split('\n');
    let changed = false;
    const seen = new Set<string>();
    const next: string[] = [];
    for (const l of lines) {
      const target = /^(import|export)\s/.test(l) ? importTarget(l) : undefined;
      const s = target ? targetStem(target) : '';
      if (target && mergedStem.has(s) && !/\.(g|freezed)\.dart$/.test(target)) {
        changed = true;
        if (/(^|\/)index\.ts$/.test(f) && /^export\s+\*/.test(l)) continue;
        const repl = l.replace(target, target.replace(new RegExp(`${s}(\\.(?:dart|ts|tsx|js))?$`), `${mergedStem.get(s)}$1`));
        const key = repl.replace(/\s+/g, ' ');
        if (lang === 'dart' && seen.has(key)) continue;
        seen.add(key);
        next.push(repl);
        continue;
      }
      if (target) seen.add(l.replace(/\s+/g, ' '));
      next.push(l);
    }
    if (!changed) continue;
    // A file that imported two merged files now imports the main file twice.
    const once = new Set<string>();
    out.set(f, next.filter((l) => !/^import\s/.test(l) || (once.has(l.trim()) ? false : (once.add(l.trim()), true))).join('\n'));
  }
  return out;
}

/** groupNewModels for a whole plan: generated-code records follow their model into its new file. */
export function groupPlanned<G extends { file: string; symbol: string }>(root: string, files: Map<string, string>, generated: G[], map: ProjectMap, lang: ModelLang, split = false): { files: Map<string, string>; generated: G[] } {
  const out = groupNewModels(root, files, map, lang, split);
  if (out === files) return { files, generated };
  const declares = (t: string, sym: string) => new RegExp(`\\b(?:interface|type|class|struct)\\s+${sym}\\b`).test(t);
  return {
    files: out,
    generated: generated.map((g) => {
      if (out.has(g.file) || exists(join(root, g.file))) return g;
      const home = [...out].find(([, t]) => declares(t, g.symbol))?.[0];
      return home ? { ...g, file: home } : g;
    }),
  };
}
