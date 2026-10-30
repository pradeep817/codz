// doctor --fix: repairs what can be repaired safely, as one change set with a
// diff (preview, apply, undo as usual). Everything else is listed with the
// command or edit that fixes it.
//
//   missing locale keys   added to each language with the default language's text
//   hardcoded URLs        Next.js: `${process.env.<baseUrlEnv>}/path` when the URL starts
//                         with that env's value; Flutter: a relative path inside Dio calls
//                         when it starts with the Dio base URL
//   unused models         the declaration is removed; a file left empty is deleted, and its
//                         barrel export goes with it
//   untyped responses     not automatic: needs a real response (api update --sample)
//   unhandled API errors  not automatic: needs a decision about the error UI

import { join, posix } from 'node:path';
import { findTsBlock } from '../adapters/nextjs.ts';
import { matchBrace } from '../adapters/source.ts';
import { loadMap } from '../core/cache.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { loadConfig } from '../core/config.ts';
import { jsonSet } from '../core/jsonEdit.ts';
import { detectEol, readText, walk, withEol } from '../core/fsutil.ts';
import type { Adapter, ChangeSet, ProjectMap } from '../core/types.ts';
import { runDoctor, type Finding } from './doctor.ts';
import { dartString, getxBlocks, readLocales } from './locale.ts';

export interface FixReport {
  changeSet: ChangeSet;
  fixed: number;
  manual: Finding[];
}

type Files = Map<string, string>;
const read = (root: string, files: Files, f: string) => files.get(f) ?? readText(join(root, f));

// ---------------- locales ----------------

function fixMissingKeys(root: string, map: ProjectMap, finding: Finding & { data: { kind: 'missingKeys' } }, files: Files, summary: string[]): boolean {
  const set = readLocales(root, map);
  if (!set) return false;
  const { lang, keys } = finding.data;
  const def = set.keys.get(set.defaultLang)!;
  const file = set.files.get(lang);
  if (!file) return false;
  if (set.kind === 'getx') {
    const block = getxBlocks(root, set.translationsFile!).find((b) => b.lang === lang);
    if (!block) return false;
    let t = (files.get(block.file) ?? block.text).replace(/\r\n/g, '\n');
    const close = locateBlockClose(t, block.code);
    if (close === -1) return false;
    const closeIndent = t.slice(t.lastIndexOf('\n', close) + 1, close).match(/^[ \t]*/)![0];
    const before = t.slice(0, close).replace(/\s*$/, '');
    const lines = keys.map((k) => `${closeIndent}  ${dartString(k)}: ${dartString(def.get(k) ?? '')},`).join('\n');
    t = `${before}${before.endsWith('{') || before.endsWith(',') ? '' : ','}\n${lines}\n${closeIndent}${t.slice(close)}`;
    files.set(block.file, withEol(t, detectEol(block.text)));
  } else {
    const raw = read(root, files, file)!;
    let t = raw;
    for (const k of keys) t = jsonSet(t, set.kind === 'arb' ? [k] : k.split('.'), def.get(k) ?? '');
    files.set(file, t);
  }
  summary.push(`Add ${keys.length} missing key${keys.length === 1 ? '' : 's'} to ${file} (${lang}) with the ${set.defaultLang} text: ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', …' : ''}`);
  return true;
}

/** The closing brace of a GetX language map ('en_US': { … }) in text. */
function locateBlockClose(t: string, code: string): number {
  const m = new RegExp(`['"]${code}['"]\\s*:\\s*\\{`).exec(t);
  if (!m) return -1;
  return matchBrace(t, m.index + m[0].length - 1, 'dart');
}

// ---------------- URLs ----------------

function envValue(root: string, name: string): string | undefined {
  for (const f of ['.env.local', '.env.development', '.env', '.env.example', '.env.development.local']) {
    const m = new RegExp(`^\\s*${name}\\s*=\\s*['"]?([^'"\\n#]+)`, 'm').exec(readText(join(root, f)) ?? '');
    if (m && /^https?:\/\//.test(m[1].trim())) return m[1].trim().replace(/\/$/, '');
  }
  return undefined;
}

function fixUrl(root: string, map: ProjectMap, finding: Finding & { data: { kind: 'url' } }, files: Files, summary: string[]): boolean {
  const file = finding.file!;
  const { url } = finding.data;
  const t = read(root, files, file)!;
  const c = map.conventions;
  if (map.framework === 'nextjs') {
    const env = c.baseUrlEnv;
    const base = env ? envValue(root, env) : undefined;
    if (!env || !base || !url.startsWith(base)) {
      finding.fix = `It is not under ${env ? `${env} (${base ?? 'not set in any .env file'})` : 'a configured base URL'}; move it to an env variable by hand.`;
      return false;
    }
    const rest = url.slice(base.length);
    let next = t;
    for (const q of ["'", '"', '`']) next = next.split(`${q}${url}${q}`).join(`\`\${process.env.${env}}${rest}\``);
    if (next === t) return false;
    files.set(file, next);
    summary.push(`${file}: ${url} → \`\${process.env.${env}}${rest}\``);
    return true;
  }
  if (map.framework === 'react-native') {
    finding.fix = `Move it to API_URL in ${c.configFile || 'src/config/env.ts'} and call it through your API client.`;
    return false;
  }
  // Flutter: only inside Dio calls, where a relative path resolves against BaseOptions.baseUrl.
  const base = (c.baseUrl ?? '').replace(/\/$/, '');
  if (!base || !url.startsWith(base)) {
    finding.fix = `It does not start with the Dio base URL${base ? ` (${base})` : ''}; move it to your network setup by hand.`;
    return false;
  }
  const rest = url.slice(base.length) || '/';
  let changed = false;
  const next = t.replace(/(\b\w*[dD]io\w*\s*\.\s*(?:get|post|put|patch|delete|head|request|download)\s*(?:<[^>]*>)?\s*\(\s*)(['"])([^'"]+)\2/g, (m, pre: string, q: string, u: string) => {
    if (u !== url) return m;
    changed = true;
    return `${pre}${q}${rest}${q}`;
  });
  if (!changed) {
    finding.fix = 'It is not passed straight to a Dio call; move it to your network setup by hand.';
    return false;
  }
  files.set(file, next);
  summary.push(`${file}: ${url} → '${rest}' (Dio adds its base URL)`);
  return true;
}

// ---------------- models ----------------

function dartClassBlock(text: string, name: string): { start: number; end: number } | null {
  const m = new RegExp(`(^|\\n)((?:[ \\t]*(?:///[^\\n]*|@\\w+(?:\\([^)]*\\))?)\\n)*)[ \\t]*(?:@\\w+(?:\\([^)]*\\))?\\s+)*class\\s+${name}\\b[^{]*\\{`).exec(text);
  if (!m) return null;
  const close = matchBrace(text, m.index + m[0].length - 1, 'dart');
  return close === -1 ? null : { start: m.index + m[1].length, end: close + 1 };
}

function fixUnusedModel(root: string, map: ProjectMap, finding: Finding & { data: { kind: 'unusedModel' } }, files: Files, deletes: Set<string>, summary: string[], notes: string[]): boolean {
  const model = map.models.find((m) => m.name === finding.data.name);
  if (!model || deletes.has(model.file)) return false;
  const text = read(root, files, model.file);
  if (text === null) return false;
  const lang = model.file.endsWith('.dart') ? 'dart' : 'ts';
  const block = lang === 'dart' ? dartClassBlock(text, model.name) : findTsBlock(text, model.name);
  if (!block) {
    notes.push(`${model.file}: could not find the declaration of ${model.name}; delete it by hand.`);
    return false;
  }
  let rest = (text.slice(0, block.start) + text.slice(block.end)).replace(/\n{3,}/g, '\n\n');
  // Generated json_serializable glue for this class.
  if (lang === 'dart') rest = rest.replace(new RegExp(`^part '[^']*\\.g\\.dart';\\n?`, 'm'), (p) => (/\bclass\s+\w+/.test(rest) ? p : ''));
  const onlyImports = rest.replace(/^\s*(import|export)\b[^\n]*\n?/gm, '').replace(/^\s*part\b[^\n]*\n?/gm, '').trim() === '';
  if (onlyImports) {
    deletes.add(model.file);
    files.delete(model.file);
    summary.push(`Delete ${model.file}: ${model.name} was its only declaration and nothing uses it`);
    removeBarrelExport(root, model.file, files, summary);
  } else {
    files.set(model.file, rest.replace(/^\n+/, '').replace(/\n*$/, '\n'));
    summary.push(`Remove ${model.name} from ${model.file}: nothing uses it`);
  }
  return true;
}

function removeBarrelExport(root: string, deleted: string, files: Files, summary: string[]): void {
  const dir = posix.dirname(deleted);
  const base = posix.basename(deleted).replace(/\.(ts|tsx|dart)$/, '');
  const candidates = deleted.endsWith('.dart') ? walk(root, dir, { exts: ['.dart'] }).filter((f) => posix.dirname(f) === dir) : [`${dir}/index.ts`];
  for (const f of candidates) {
    if (f === deleted) continue;
    const t = read(root, files, f);
    if (t === null) continue;
    const re = deleted.endsWith('.dart') ? new RegExp(`^export\\s+'(?:\\./)?${base}\\.dart';[ \\t]*\\n?`, 'gm') : new RegExp(`^export\\s+(?:\\*|(?:type\\s+)?\\{[^}]*\\})\\s+from\\s+['"]\\./${base}(?:\\.js)?['"];?[ \\t]*\\n?`, 'gm');
    const next = t.replace(re, '');
    if (next !== t) {
      files.set(f, next);
      summary.push(`Update ${f}: drop the export of ${posix.basename(deleted)}`);
    }
  }
}

// ---------------- entry ----------------

export async function planDoctorFix(root: string, adapter: Adapter, opts: { only?: string[] } = {}): Promise<FixReport> {
  const report = await runDoctor(root, adapter, opts);
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  const files: Files = new Map();
  const deletes = new Set<string>();
  const summary: string[] = [];
  const notes: string[] = [];
  const manual: Finding[] = [];
  let fixed = 0;
  // URLs from the end of each file first, so earlier offsets stay valid (replacements are by value anyway).
  for (const f of report.findings) {
    let ok = false;
    const d = f.data;
    if (d?.kind === 'missingKeys') ok = fixMissingKeys(root, map, f as Finding & { data: typeof d }, files, summary);
    else if (d?.kind === 'url' && f.severity !== 'info') ok = fixUrl(root, map, f as Finding & { data: typeof d }, files, summary);
    else if (d?.kind === 'unusedModel') ok = fixUnusedModel(root, map, f as Finding & { data: typeof d }, files, deletes, summary, notes);
    if (ok) fixed++;
    else if (f.severity !== 'info') manual.push(f);
  }
  const warnings: string[] = [];
  if (fixed && report.findings.some((f) => f.data?.kind === 'missingKeys')) warnings.push('The added locale keys hold the default-language text; translate them (doctor lists them as untranslated).');
  warnings.push(...notes);
  if (manual.length) {
    warnings.push(`Still needs you (${manual.length}):\n${manual.map((m) => `    ${m.file ? `${m.file}${m.line ? `:${m.line}` : ''}  ` : ''}${m.message}${m.fix ? `\n      → ${m.fix}` : ''}`).join('\n')}`);
  }
  if (!summary.length) summary.push(report.findings.length ? 'Nothing here can be fixed automatically.' : 'No problems found.');
  const changeSet = buildChangeSet(root, 'doctor fix', { files, deletes, summary, warnings, generated: [] });
  return { changeSet, fixed, manual };
}
