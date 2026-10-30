// The starter engine: from a verified template and validated answers to a new
// project folder. Offline and network-free; it cannot tell whether the
// template came from the catalog, the cache or a folder on disk.
//
// Order: check requirements → build every file in memory (placeholders in
// contents and paths, paths checked again) → preview → make a temporary folder
// next to the target → run the before-move steps there (flutter create) →
// write the files and the dependency entries → rename into place in one step →
// run the after-move steps (pub get, format, npm install) → record history.
// The target never exists half-built: any failure before the rename removes
// the temporary folder.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { appendHistory, newId, readHistory } from '../core/changeset.ts';
import { hash } from '../core/fsutil.ts';
import { jsonSet } from '../core/jsonEdit.ts';
import { ToolError } from '../core/types.ts';
import { placeholderValues, satisfies, STEP_ALLOWLIST, type Answers, type Manifest, type StepId } from './manifest.ts';
import { checkCollisions, checkRelPath } from './paths.ts';
import type { VerifiedTemplate } from './source.ts';

export interface PlannedFile {
  path: string;
  data: Buffer;
  mode: '644' | '755';
}

export interface NewPlan {
  template: { id: string; version: string; title: string; origin: string; archiveSha256?: string; manifestSha256: string; license: string };
  target: string;
  answers: Answers;
  files: PlannedFile[];
  steps: { id: StepId; label: string; when: 'before-move' | 'after-move'; command: string[] }[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  warnings: string[];
  apiAdd: { supported: boolean; note?: string };
}

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|icns|bmp|ttf|otf|woff2?|eot|jar|keystore|jks|zip|gz|pdf|mp3|mp4|wav|webm|riv|lottie)$/i;

export function isBinary(path: string, data: Buffer): boolean {
  if (BINARY_EXT.test(path)) return true;
  const n = Math.min(data.length, 8000);
  for (let i = 0; i < n; i++) if (data[i] === 0) return true;
  return false;
}

/** Plain string replacement of {{key}} for known keys only; anything else that looks like a placeholder is left alone. */
export function substitute(text: string, values: Map<string, string>): string {
  return text.replace(/\{\{([a-zA-Z][a-zA-Z0-9]*(?:\.path)?)\}\}/g, (m, key: string) => values.get(key) ?? m);
}

// ---------- SDKs ----------

export interface Sdks {
  flutter: string | null;
  node: string;
}

function run(cmd: string, args: string[], cwd: string, timeout = 15 * 60_000): { ok: boolean; missing: boolean; output: string } {
  // flutter and npm are .bat/.cmd files on Windows, which Node only starts through the shell. Every argument
  // here is a fixed word or an answer that passed the identifier / reverse-domain checks, so nothing a shell
  // would interpret can reach it.
  for (const a of args) if (!/^[A-Za-z0-9._\-=/]+$/.test(a)) throw new ToolError('internal', `Refusing to run ${cmd} with the argument "${a}".`);
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, shell: process.platform === 'win32' });
  const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' || (process.platform === 'win32' && r.status === 1 && /not recognized/i.test(r.stderr ?? ''));
  return { ok: r.status === 0, missing, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

export function detectSdks(needFlutter: boolean): Sdks {
  let flutter: string | null = null;
  if (needFlutter) {
    const r = run('flutter', ['--version', '--machine'], process.cwd(), 120_000);
    if (r.ok) {
      try {
        flutter = (JSON.parse(r.output.slice(r.output.indexOf('{'))) as { frameworkVersion?: string }).frameworkVersion ?? null;
      } catch {
        flutter = /Flutter (\d+\.\d+\.\d+)/.exec(r.output)?.[1] ?? null;
      }
    }
  }
  return { flutter, node: process.version.replace(/^v/, '') };
}

// ---------- Planning ----------

function stepCommand(id: StepId, answers: Answers): string[] {
  switch (id) {
    case 'flutter_create':
      return ['flutter', 'create', '--no-pub', '--org', String(answers.org), '--project-name', String(answers.appName), '.'];
    case 'flutter_pub_get':
      return ['flutter', 'pub', 'get'];
    case 'dart_format':
      return ['dart', 'format', '.'];
    case 'npm_install':
      return [process.platform === 'win32' ? 'npm.cmd' : 'npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'];
  }
}

/** `sdks` null skips the SDK checks (publishing checks run without Flutter). */
export function planNew(t: VerifiedTemplate, answers: Answers, parent: string, devtoolVersion: string, sdkInfo: Sdks | null, opts: { steps: boolean }): NewPlan {
  const sdks: Sdks = sdkInfo ?? { flutter: '0.0.0', node: process.version.replace(/^v/, '') };
  const checkSdks = sdkInfo !== null;
  const m = t.manifest;
  const warnings: string[] = [];
  const target = resolve(parent, String(answers.appName));

  if (m.requires.devtool && !satisfies(devtoolVersion, m.requires.devtool)) throw new ToolError('template_incompatible', `${m.id} ${m.version} needs devtool ${m.requires.devtool}; this is devtool ${devtoolVersion}.`, 'Update devtool, or pick an older version of the template.');
  if (checkSdks && m.requires.node && !satisfies(sdks.node, m.requires.node)) throw new ToolError('template_incompatible', `${m.id} ${m.version} needs Node ${m.requires.node}; this is Node ${sdks.node}.`, 'Install a matching Node version, or pick another template version.');
  const usesFlutter = m.framework === 'flutter';
  if (checkSdks && usesFlutter && m.steps.includes('flutter_create') && !sdks.flutter) throw new ToolError('sdk_missing', 'Flutter was not found, and this template is added on top of flutter create.', 'Install Flutter (flutter.dev), check it with devtool doctor --setup, then run this again.');
  if (checkSdks && usesFlutter && sdks.flutter && m.requires.flutter && !satisfies(sdks.flutter, m.requires.flutter)) throw new ToolError('template_incompatible', `${m.id} ${m.version} needs Flutter ${m.requires.flutter}; this is Flutter ${sdks.flutter}.`, 'Switch Flutter versions (for example with fvm), or pick another template version.');
  if (checkSdks && usesFlutter && sdks.flutter && m.tested?.flutter?.length && !m.tested.flutter.some((v) => sdks.flutter!.startsWith(v))) warnings.push(`This template was tested with Flutter ${m.tested.flutter.join(', ')}; you have ${sdks.flutter}.`);

  // Files, with placeholders filled in, and their paths checked again.
  const values = placeholderValues(m, answers);
  const files: PlannedFile[] = [];
  for (const f of m.files) {
    const data = t.files.get(f.path)!;
    const path = checkRelPath(substitute(f.path, values), 'template (after filling in answers)');
    const out = isBinary(f.path, data) ? data : Buffer.from(substitute(data.toString('utf8'), values), 'utf8');
    files.push({ path, data: out, mode: f.mode ?? '644' });
  }
  checkCollisions(files.map((f) => f.path), 'template (after filling in answers)');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const steps = m.steps
    .filter((id) => opts.steps || STEP_ALLOWLIST[id].when === 'before-move')
    .map((id) => ({ id, label: STEP_ALLOWLIST[id].label, when: STEP_ALLOWLIST[id].when, command: stepCommand(id, answers) }));
  if (checkSdks && usesFlutter && !sdks.flutter && steps.some((s) => s.id === 'flutter_pub_get' || s.id === 'dart_format')) warnings.push('Flutter was not found, so flutter pub get and dart format will be skipped; run them yourself.');

  return {
    template: { id: m.id, version: m.version, title: m.title, origin: t.origin, archiveSha256: t.archiveSha256, manifestSha256: hash(t.manifestBytes.toString('utf8')), license: m.license.kind },
    target,
    answers,
    files,
    steps,
    dependencies: m.dependencies ?? {},
    devDependencies: m.devDependencies ?? {},
    warnings,
    apiAdd: m.apiAdd,
  };
}

/** The preview: a folder tree of every file, the steps and the template identity. */
export function renderPlan(p: NewPlan): string {
  const lines = [
    `Template: ${p.template.id} ${p.template.version}${p.template.archiveSha256 ? ` (verified, archive ${p.template.archiveSha256.slice(0, 12)})` : ` (from ${p.template.origin}, files verified)`}`,
    `License: ${p.template.license}`,
    `Creates ${p.files.length} files in ${p.target}`,
    '',
  ];
  const seen = new Set<string>();
  for (const f of p.files) {
    const segs = f.path.split('/');
    for (let i = 0; i < segs.length - 1; i++) {
      const d = segs.slice(0, i + 1).join('/');
      if (!seen.has(d)) {
        seen.add(d);
        lines.push(`${'  '.repeat(i)}${segs[i]}/`);
      }
    }
    lines.push(`${'  '.repeat(segs.length - 1)}${segs[segs.length - 1]}${f.mode === '755' ? '  (executable)' : ''}`);
  }
  const deps = Object.entries(p.dependencies);
  if (deps.length) lines.push('', `Dependencies added: ${deps.map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (p.steps.length) lines.push('', 'Steps:', ...p.steps.map((s) => `  ${s.when === 'before-move' ? 'before' : 'after'}: ${s.command.join(' ')}`));
  if (!p.apiAdd.supported) lines.push('', `Note: devtool api add does not support this starter${p.apiAdd.note ? ` (${p.apiAdd.note})` : ''}.`);
  return lines.join('\n');
}

// ---------- Writing ----------

/** Adds dependencies under `dependencies:` (or `dev_dependencies:`) in pubspec.yaml, after the SDK entries. */
export function addPubspecEntries(text: string, section: 'dependencies' | 'dev_dependencies', deps: Record<string, string>): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const have = new Set<string>();
  let idx = lines.findIndex((l) => new RegExp(`^${section}:\\s*$`).test(l));
  if (idx !== -1) for (let i = idx + 1; i < lines.length && (/^\s/.test(lines[i]) || !lines[i].trim()); i++) {
    const k = /^ {2}([A-Za-z0-9_]+):/.exec(lines[i])?.[1];
    if (k) have.add(k);
  }
  const missing = Object.keys(deps).filter((k) => !have.has(k)).sort();
  if (!missing.length) return text;
  const entries = missing.map((k) => `  ${k}: ${/^[\^~<>=0-9]/.test(deps[k]) && !/[:#]/.test(deps[k]) ? deps[k] : JSON.stringify(deps[k])}`);
  if (idx === -1) {
    lines.push(...(lines[lines.length - 1] === '' ? [] : ['']), `${section}:`, ...entries, '');
    return lines.join('\n');
  }
  let at = idx + 1;
  while (/^ {2}\w+:\s*$/.test(lines[at] ?? '') && /^ {4}sdk:/.test(lines[at + 1] ?? '')) at += 2;
  lines.splice(at, 0, ...entries);
  return lines.join('\n');
}

function addPackageJsonEntries(text: string, section: string, deps: Record<string, string>): string {
  let t = text;
  const existing = (JSON.parse(text) as Record<string, Record<string, string> | undefined>)[section] ?? {};
  for (const k of Object.keys(deps).sort()) if (!(k in existing)) t = jsonSet(t, [section, k], deps[k]);
  return t;
}

/** Files that steps and later commands create and that never block undo. */
const GENERATED = [/^\.dart_tool(\/|$)/, /^build(\/|$)/, /^\.flutter-plugins(-dependencies)?$/, /^pubspec\.lock$/, /^node_modules(\/|$)/, /^package-lock\.json$/, /^\.next(\/|$)/, /^\.devtool(\/|$)/, /^devtool\.config\.yaml$/, /^\.idea(\/|$)/, /^ios\/Pods(\/|$)/, /^ios\/Podfile\.lock$/, /^\.packages$/, /^next-env\.d\.ts$/, /^android\/local\.properties$/, /^android\/\.gradle(\/|$)/, /^\.metadata$/, /^.*\.iml$/];

function listFiles(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, rel)).sort()) {
    const p = rel ? `${rel}/${name}` : name;
    if (GENERATED.some((g) => g.test(p))) continue;
    const st = lstatSync(join(root, p));
    if (st.isDirectory()) out.push(...listFiles(root, p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}

export interface NewResult {
  id: string;
  target: string;
  files: number;
  steps: { id: StepId; ok: boolean; note?: string }[];
  warnings: string[];
}

export function applyNew(p: NewPlan, log: (line: string) => void = () => {}): NewResult {
  if (existsSync(p.target) && readdirSync(p.target).length) throw new ToolError('dir_not_empty', `${p.target} already exists and is not empty.`, 'Pick another name, or remove that folder.');
  const parent = dirname(p.target);
  mkdirSync(parent, { recursive: true });
  const tmp = join(parent, `.${basename(p.target)}.devtool-new-${randomBytes(4).toString('hex')}`);
  mkdirSync(tmp);
  const warnings = [...p.warnings];
  const stepResults: NewResult['steps'] = [];
  try {
    for (const s of p.steps.filter((x) => x.when === 'before-move')) {
      log(`Running ${s.command.join(' ')}...`);
      const r = run(s.command[0], s.command.slice(1), tmp);
      if (!r.ok) throw new ToolError(r.missing ? 'sdk_missing' : 'step_failed', `${s.command.join(' ')} ${r.missing ? 'was not found' : 'failed'}, so nothing was created.${r.output ? `\n${r.output.split('\n').slice(-5).join('\n')}` : ''}`, r.missing ? 'Install the SDK; check it with devtool doctor --setup.' : 'Fix the problem above and run this again.');
      stepResults.push({ id: s.id, ok: true });
    }
    for (const f of p.files) {
      const abs = join(tmp, f.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.data);
      if (f.mode === '755') chmodSync(abs, 0o755);
    }
    const deps = p.dependencies;
    const dev = p.devDependencies;
    if (Object.keys(deps).length || Object.keys(dev).length) {
      const pubspec = join(tmp, 'pubspec.yaml');
      const pkg = join(tmp, 'package.json');
      if (existsSync(pubspec)) {
        let t = readFileSync(pubspec, 'utf8');
        t = addPubspecEntries(t, 'dependencies', deps);
        t = addPubspecEntries(t, 'dev_dependencies', dev);
        writeFileSync(pubspec, t);
      } else if (existsSync(pkg)) {
        let t = readFileSync(pkg, 'utf8');
        t = addPackageJsonEntries(t, 'dependencies', deps);
        t = addPackageJsonEntries(t, 'devDependencies', dev);
        writeFileSync(pkg, t);
      } else warnings.push('The template lists dependencies but has no pubspec.yaml or package.json to add them to.');
    }
    if (existsSync(p.target)) rmSync(p.target, { recursive: true, force: true }); // an empty folder only (checked above)
    renameSync(tmp, p.target);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }

  for (const s of p.steps.filter((x) => x.when === 'after-move')) {
    log(`Running ${s.command.join(' ')}...`);
    const r = run(s.command[0], s.command.slice(1), p.target);
    if (r.ok) stepResults.push({ id: s.id, ok: true });
    else {
      const note = `${s.command.join(' ')} ${r.missing ? 'was not found' : 'failed'}; the project was created. Run it yourself in ${basename(p.target)}/.`;
      stepResults.push({ id: s.id, ok: false, note });
      warnings.push(note);
    }
  }

  // History in the new project, so devtool undo there removes it again.
  const id = newId();
  const recorded = listFiles(p.target);
  appendHistory(p.target, {
    id,
    skill: 'new',
    summary: [`Create ${basename(p.target)} from ${p.template.id} ${p.template.version}`],
    files: recorded.map((f) => ({ path: f, created: true, afterHash: hash(readFileSync(join(p.target, f), 'utf8')) })),
    generated: [],
    undone: false,
    meta: { starter: { id: p.template.id, version: p.template.version, archiveSha256: p.template.archiveSha256 ?? null, manifestSha256: p.template.manifestSha256, origin: p.template.archiveSha256 ? 'catalog' : 'folder' }, answers: p.answers, target: p.target },
  });
  return { id, target: p.target, files: recorded.length, steps: stepResults, warnings };
}

// ---------- Undo ----------

/** The last change in this project, when it is the devtool new that created it. */
export function lastNewEntry(root: string) {
  const e = [...readHistory(root)].reverse().find((x) => !x.undone);
  return e && e.skill === 'new' ? e : null;
}

/**
 * Removes a project devtool new created, when nothing in it changed since.
 * Generated files (pub get, npm install, devtool init) do not count as changes;
 * any other edit or new file blocks it unless `force`.
 */
export function undoNew(root: string, opts: { force?: boolean } = {}): { id: string; removed: string } {
  const entry = lastNewEntry(root);
  if (!entry) throw new ToolError('nothing_to_undo', 'The last change here was not devtool new.');
  const target = resolve(String((entry.meta as { target?: string } | undefined)?.target ?? ''));
  if (target !== resolve(root)) throw new ToolError('changed_since_apply', `This project was created at ${target}, not here, so devtool will not delete it.`, 'Delete the folder yourself if you no longer want it.');
  const recorded = new Map(entry.files.map((f) => [f.path, f.afterHash]));
  const now = listFiles(root);
  const changed = [
    ...entry.files.filter((f) => !existsSync(join(root, f.path)) || hash(readFileSync(join(root, f.path), 'utf8')) !== f.afterHash).map((f) => f.path),
    ...now.filter((f) => !recorded.has(f) && !(f === '.gitignore')),
  ];
  // devtool init adds .devtool/ to .gitignore; that alone does not count.
  const gi = recorded.get('.gitignore');
  const idx = changed.indexOf('.gitignore');
  if (idx !== -1 && gi && existsSync(join(root, '.gitignore'))) {
    const t = readFileSync(join(root, '.gitignore'), 'utf8');
    const without = t.replace(/\n?# devtool cache, backups and history\n\.devtool\/\n$/, '');
    if (hash(without) === gi || hash(`${without}\n`) === gi) changed.splice(idx, 1);
  }
  if (changed.length && !opts.force) {
    throw new ToolError('changed_since_apply', `These files changed after devtool created the project: ${changed.slice(0, 8).join(', ')}${changed.length > 8 ? ', ...' : ''}. Undo would delete those edits.`, 'Keep your edits, or pass --force to delete the whole project anyway.');
  }
  rmSync(root, { recursive: true, force: true });
  return { id: entry.id, removed: root };
}
