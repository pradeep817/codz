// devtool new, starters list|show|cache, login, logout, whoami, and applying
// a saved `new` plan. The main CLI loads this file only when one of these
// commands runs, so the rest of devtool never loads network code.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { newId } from '../core/changeset.ts';
import { hash } from '../core/fsutil.ts';
import { ToolError } from '../core/types.ts';
import { auth } from './auth.ts';
import { applyNew, detectSdks, planNew, renderPlan, undoNew, type NewPlan } from './engine.ts';
import { homePath, readHomeFile, removeHome, writeHomeFile } from './home.ts';
import { setAnnouncer } from './http.ts';
import { checkAnswer, resolveAnswers, type Manifest } from './manifest.ts';
import { fetchManifest, fetchTemplate, latestUsable, loadIndex, resolveRef, type IndexTemplate } from './registry.ts';
import { fromFolder, type VerifiedTemplate } from './source.ts';
import { printable } from './strictJson.ts';

export interface Io {
  json: boolean;
  print(text: string): void;
  warn(text: string): void;
  result(obj: Record<string, unknown>): void;
  /** Questions; null when there is no terminal (or --yes / --json). */
  ask: ((q: string, validate: (v: string) => string | null) => Promise<string | null>) | null;
  choose: ((q: string, options: string[], def: number) => Promise<number | null>) | null;
  confirm: ((q: string) => Promise<boolean | null>) | null;
}

export interface Ctx {
  sub?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
  multi: Record<string, string[]>;
  cwd: string;
  version: string;
  io: Io;
}

const str = (flags: Ctx['flags'], k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : '');

function isFolderRef(ref: string, cwd: string): boolean {
  return /^(\.{1,2}[\\/]|[\\/]|~[\\/]|[a-zA-Z]:[\\/])/.test(ref) || /[\\/]/.test(ref) || (existsSync(resolve(cwd, ref)) && statSync(resolve(cwd, ref)).isDirectory());
}

// ---------- devtool new ----------

interface Loaded {
  template: VerifiedTemplate;
  ref: string;
  kind: 'folder' | 'catalog';
  warnings: string[];
}

async function loadTemplate(ref: string, ctx: Ctx, cached: boolean): Promise<Loaded> {
  if (isFolderRef(ref, ctx.cwd)) {
    const dir = resolve(ctx.cwd, ref.replace(/^~(?=[\\/])/, process.env.HOME ?? '~'));
    return { template: fromFolder(dir), ref: dir, kind: 'folder', warnings: [] };
  }
  const { index, warnings } = await loadIndex({ cached });
  const r = resolveRef(index, ref);
  const template = await fetchTemplate(index, r.template, r.version, { cached });
  return { template, ref: `${r.template.id}@${r.version.version}`, kind: 'catalog', warnings: [...warnings, ...r.warnings] };
}

async function pickFromCatalog(ctx: Ctx): Promise<string> {
  const { index, warnings } = await loadIndex({ cached: ctx.flags.cached === true });
  for (const w of warnings) ctx.io.warn(w);
  const f = (k: string) => str(ctx.flags, k);
  const list = index.templates.filter((t) => (!f('framework') || t.framework === f('framework')) && (['state', 'router', 'http'] as const).every((k) => !f(k) || t.provides?.[k] === f(k)));
  if (!list.length) throw new ToolError('template_not_found', 'No starter matches those choices.', 'See them all with: devtool starters list');
  if (!ctx.io.choose) throw new ToolError('bad_args', 'Which starter? Pass --template <id> (or a folder).', `Starters: ${list.map((t) => t.id).join(', ')}`);
  const i = await ctx.io.choose('Which starter?', list.map((t) => `${t.id}  ${printable(t.title)}${t.tier === 'paid' ? `  (paid${t.price ? `, ${printable(t.price)}` : ''})` : '  (free)'}`), 0);
  if (i === null) throw new ToolError('cancelled', 'No starter chosen.');
  const t = list[i];
  ctx.io.print(`Same choice in a script: devtool new <name> --template ${t.id}@${latestUsable(t, index)}`);
  return `${t.id}@${latestUsable(t, index)}`;
}

async function collectAnswers(m: Manifest, ctx: Ctx): Promise<Record<string, string>> {
  const given: Record<string, string> = {};
  for (const s of ctx.multi.set ?? []) {
    const eq = s.indexOf('=');
    if (eq <= 0) throw new ToolError('bad_args', `--set needs key=value, not "${s.slice(0, 60)}".`);
    given[s.slice(0, eq)] = s.slice(eq + 1);
  }
  if (ctx.positional[1]) given.appName = ctx.positional[1];
  if (str(ctx.flags, 'org') && m.answers.some((a) => a.key === 'org')) given.org = str(ctx.flags, 'org');
  if (ctx.io.ask) {
    for (const a of m.answers) {
      if (a.key in given) continue;
      if (a.type === 'boolean' && ctx.io.confirm) {
        const v = await ctx.io.confirm(printable(a.prompt));
        if (v !== null) given[a.key] = String(v);
        continue;
      }
      if (a.type === 'choice' && ctx.io.choose) {
        const def = Math.max(0, a.choices!.indexOf(String(a.default ?? '')));
        const i = await ctx.io.choose(printable(a.prompt), a.choices!.map(printable), def);
        if (i !== null) given[a.key] = a.choices![i];
        continue;
      }
      const v = await ctx.io.ask(`${printable(a.prompt)}${a.default !== undefined ? ` [${printable(String(a.default))}]` : ''}: `, (x) => (!x && a.default !== undefined ? null : checkAnswer(a, x)));
      if (v === null) throw new ToolError('cancelled', 'Not created.');
      if (v) given[a.key] = v;
    }
  }
  return given;
}

interface SavedPlan {
  id: string;
  ref: string;
  kind: 'folder' | 'catalog';
  parent: string;
  answers: Record<string, string>;
  steps: boolean;
  digest: string;
  archiveSha256?: string;
}

function planDigest(p: NewPlan): string {
  return hash(JSON.stringify([p.target, p.template.manifestSha256, p.template.archiveSha256 ?? '', p.files.map((f) => [f.path, f.mode, hash(f.data.toString('base64'))]), p.steps.map((s) => s.command), p.dependencies, p.devDependencies]));
}

function planJson(p: NewPlan) {
  return {
    template: { id: p.template.id, version: p.template.version, title: p.template.title, sha256: p.template.archiveSha256 ?? null, license: p.template.license },
    target: p.target,
    files: p.files.map((f) => ({ path: f.path, action: 'create', mode: f.mode })),
    steps: p.steps.map((s) => s.id),
    dependencies: p.dependencies,
    apiAdd: p.apiAdd,
    warnings: p.warnings,
  };
}

async function runNew(ctx: Ctx): Promise<number> {
  const { flags, io } = ctx;
  const cached = flags.cached === true;
  const ref = str(flags, 'template') || (await pickFromCatalog(ctx));
  const loaded = await loadTemplate(ref, ctx, cached);
  for (const w of loaded.warnings) io.warn(w);
  const m = loaded.template.manifest;
  const answers = resolveAnswers(m, await collectAnswers(m, ctx));
  const parent = resolve(ctx.cwd, str(flags, 'dir') || '.');
  const sdks = detectSdks(m.framework === 'flutter');
  const plan = planNew(loaded.template, answers, parent, ctx.version, sdks, { steps: flags['no-steps'] !== true });
  if (existsSync(plan.target) && readdirSync(plan.target).length) throw new ToolError('dir_not_empty', `${plan.target} already exists and is not empty.`, 'Pick another name, or an empty folder.');

  io.print(renderPlan(plan));
  for (const w of plan.warnings) io.warn(w);
  if (flags['dry-run'] === true) {
    io.result({ dryRun: true, ...planJson(plan) });
    return 0;
  }
  const yes = flags.yes === true || flags.y === true;
  if (flags.plan === true || (io.json && !yes)) {
    const id = newId();
    const saved: SavedPlan = { id, ref: loaded.ref, kind: loaded.kind, parent, answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, String(v)])), steps: flags['no-steps'] !== true, digest: planDigest(plan), archiveSha256: plan.template.archiveSha256 };
    writeHomeFile(JSON.stringify(saved, null, 2), {}, 'starters', 'plans', `${id}.json`);
    io.print(`\nSaved plan ${id}. Create exactly this with: devtool apply ${id}`);
    io.result({ planId: id, ...planJson(plan) });
    return 0;
  }
  if (!yes) {
    if (!io.confirm) throw new ToolError('needs_confirmation', 'Not created: pass --yes to create it without a question, or --plan to save it.');
    if (!(await io.confirm('\nCreate it?'))) {
      io.print('Not created.');
      return 0;
    }
  }
  return finishNew(plan, loaded, io);
}

function finishNew(plan: NewPlan, loaded: Loaded, io: Io): number {
  const r = applyNew(plan, (l) => io.print(l));
  for (const w of r.warnings) io.warn(w);
  const runs = readHomeFile('starters', 'runs.json');
  let list: unknown[] = [];
  try {
    list = runs ? (JSON.parse(runs.toString('utf8')) as unknown[]) : [];
  } catch {
    list = [];
  }
  list.push({ id: r.id, template: plan.template.id, version: plan.template.version, archiveSha256: plan.template.archiveSha256 ?? null, source: loaded.kind, target: r.target, at: new Date().toISOString() });
  writeHomeFile(JSON.stringify(list.slice(-200), null, 2), {}, 'starters', 'runs.json');
  const name = plan.target.split(/[\\/]/).pop();
  io.print(`\nCreated ${r.target} (${r.files} files).`);
  if (!plan.apiAdd.supported) io.warn(`devtool init and explain work on this project, but api add does not support it${plan.apiAdd.note ? ` (${plan.apiAdd.note})` : ''}.`);
  io.print(`Next: cd ${name} && devtool init`);
  io.print('Undo (inside the project, before you change it): devtool undo');
  io.result({ id: r.id, target: r.target, files: r.files, steps: r.steps, warnings: r.warnings, template: { id: plan.template.id, version: plan.template.version, sha256: plan.template.archiveSha256 ?? null } });
  return 0;
}

/** devtool apply <id> for a plan saved by devtool new --plan. Returns null when the id is not a starter plan. */
export async function applyStarterPlan(id: string, ctx: Ctx): Promise<number | null> {
  const b = readHomeFile('starters', 'plans', `${id}.json`);
  if (!b) return null;
  const saved = JSON.parse(b.toString('utf8')) as SavedPlan;
  const loaded = saved.kind === 'folder' ? { template: fromFolder(saved.ref), ref: saved.ref, kind: 'folder' as const, warnings: [] } : await loadTemplate(saved.ref, ctx, ctx.flags.cached === true);
  const answers = resolveAnswers(loaded.template.manifest, saved.answers);
  const plan = planNew(loaded.template, answers, saved.parent, ctx.version, detectSdks(loaded.template.manifest.framework === 'flutter'), { steps: saved.steps });
  if (planDigest(plan) !== saved.digest || (existsSync(plan.target) && readdirSync(plan.target).length)) throw new ToolError('changed_since_plan', 'The template or the target folder changed after the preview, so nothing was created.', 'Run devtool new again for a fresh preview.');
  const code = finishNew(plan, loaded, ctx.io);
  removeHome('starters', 'plans', `${id}.json`);
  return code;
}

export function isStarterPlan(id: string): boolean {
  return readHomeFile('starters', 'plans', `${id}.json`) !== null;
}

// ---------- starters list | show | cache ----------

function line(t: IndexTemplate, latest: string, owned: Set<string>): string {
  const tier = t.tier === 'paid' ? (owned.has(t.id) ? 'owned' : `paid${t.price ? ` ${printable(t.price)}` : ''}`) : 'free';
  return `${t.id.padEnd(36)} ${latest.padEnd(9)} ${t.framework.padEnd(13)} ${tier.padEnd(12)} ${t.apiAdd ? 'api add ✓' : 'api add ✗'}  ${printable(t.title)}`;
}

async function runStarters(ctx: Ctx): Promise<number> {
  const { sub, flags, io } = ctx;
  if (sub === 'cache') {
    const dir = homePath('starters', 'cache');
    const entries: { id: string; version: string }[] = [];
    if (existsSync(dir)) for (const id of readdirSync(dir)) for (const v of readdirSync(resolve(dir, id))) entries.push({ id, version: v });
    if (flags.clear === true) {
      removeHome('starters', 'cache');
      io.print(entries.length ? `Removed ${entries.length} downloaded starter${entries.length === 1 ? '' : 's'}.` : 'The cache was already empty.');
      io.result({ cleared: entries });
      return 0;
    }
    io.print(entries.length ? entries.map((e) => `${e.id} ${e.version}`).join('\n') : 'No starters downloaded yet.');
    io.print(`\nCache: ${dir}`);
    io.result({ cache: dir, entries });
    return 0;
  }
  const { index, warnings, fromCache } = await loadIndex({ refresh: flags.refresh === true, cached: flags.cached === true });
  for (const w of warnings) io.warn(w);
  if (sub === 'show') {
    const ref = ctx.positional[2];
    if (!ref) throw new ToolError('bad_args', 'Which starter? Usage: devtool starters show <id>[@version]');
    const r = resolveRef(index, ref);
    for (const w of r.warnings) io.warn(w);
    const m = fromCache ? null : await fetchManifest(r.template, r.version);
    const t = r.template;
    io.print(`${t.id} ${r.version.version}  ${printable(t.title)}`);
    if (t.summary) io.print(printable(t.summary));
    io.print(`Framework: ${t.framework}   Price: ${t.tier === 'paid' ? `paid${t.price ? ` (${printable(t.price)})` : ''}` : 'free'}   api add: ${t.apiAdd ? 'supported' : 'not supported'}`);
    if (t.provides) io.print(`Provides: ${Object.entries(t.provides).map(([k, v]) => `${k} ${printable(v)}`).join(', ')}`);
    if (t.extras?.length) io.print(`Beyond devtool create:\n${t.extras.map((e) => `  - ${printable(e)}`).join('\n')}`);
    if (m) {
      io.print(`Needs: ${Object.entries(m.requires).map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing special'}`);
      if (m.tested) io.print(`Tested with: ${[m.tested.flutter?.length ? `Flutter ${m.tested.flutter.join(', ')}` : '', m.tested.node?.length ? `Node ${m.tested.node.join(', ')}` : ''].filter(Boolean).join('; ')}${m.tested.date ? ` on ${m.tested.date}` : ''}`);
      io.print(`License: ${printable(m.license.kind)}   Files: ${m.files.length}   Questions: ${m.answers.map((a) => a.key).join(', ')}`);
    }
    io.print(`Versions: ${t.versions.map((v) => `${v.version}${v.yanked ? ' (replaced)' : ''}${index.revoked.some((x) => x.id === t.id && x.version === v.version) ? ' (withdrawn)' : ''}`).join(', ')}`);
    io.print(`\nCreate a project: devtool new <name> --template ${t.id}@${r.version.version}`);
    io.result({ template: t, version: r.version, manifest: m });
    return 0;
  }
  if (sub && sub !== 'list') throw new ToolError('bad_args', `Unknown command "starters ${sub}".`, 'Use: devtool starters list | show <id> | cache');
  let owned = new Set<string>();
  if (flags.owned === true) owned = new Set((await auth.whoami()).owned.map((o) => o.id));
  const f = (k: string) => str(flags, k);
  const list = index.templates.filter((t) => (!f('framework') || t.framework === f('framework')) && (['state', 'router', 'http'] as const).every((k) => !f(k) || t.provides?.[k] === f(k)) && (flags.free !== true || t.tier === 'free') && (flags.owned !== true || t.tier === 'free' || owned.has(t.id)));
  io.print(list.length ? list.map((t) => line(t, latestUsable(t, index), owned)).join('\n') : 'No starters match.');
  io.print(`\nDetails: devtool starters show <id>   Create: devtool new <name> --template <id>`);
  io.result({ templates: list.map((t) => ({ ...t, latest: latestUsable(t, index) })), catalog: { seq: index.seq, issued: index.issued, expires: index.expires, fromCache } });
  return 0;
}

// ---------- Entry ----------

export async function runStarterCommand(cmd: string, ctx: Ctx): Promise<number> {
  setAnnouncer((m) => ctx.io.warn(m));
  switch (cmd) {
    case 'new':
      return runNew(ctx);
    case 'starters':
      return runStarters(ctx);
    case 'login': {
      if (process.env.DEVTOOL_TOKEN) ctx.io.warn('DEVTOOL_TOKEN is set, so devtool uses it instead of a login.');
      const r = await auth.login({ print: (l) => ctx.io.print(l), browser: ctx.flags['no-browser'] !== true && !ctx.io.json });
      ctx.io.print(`Logged in as ${r.account}.`);
      ctx.io.result({ account: r.account });
      return 0;
    }
    case 'logout': {
      const r = await auth.logout();
      if (process.env.DEVTOOL_TOKEN) ctx.io.warn('DEVTOOL_TOKEN is still set in this environment; unset it, and revoke it from your web account if it leaked.');
      ctx.io.print(r.removed ? `Logged out${r.revoked ? '' : ' on this machine (the server could not be reached; revoke the session from your web account if needed)'}.` : 'You were not logged in.');
      ctx.io.result({ ...r });
      return 0;
    }
    case 'whoami': {
      const r = await auth.whoami();
      ctx.io.print(`${r.account}`);
      ctx.io.print(r.owned.length ? r.owned.map((o) => `  ${o.id}${o.updatesUntil ? `  (updates until ${o.updatesUntil})` : ''}`).join('\n') : '  No paid starters yet.');
      ctx.io.result({ ...r });
      return 0;
    }
  }
  throw new ToolError('bad_args', `Unknown command "${cmd}".`);
}

export { undoNew };
