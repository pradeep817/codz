// codz command line. Every command supports --json for scripts and AI agents.

import { baseUrlProblem } from './core/safe.ts';
import { existsSync, openSync, writeFileSync } from 'node:fs';
import { ReadStream } from 'node:tty';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { adapterFor } from './adapters/index.ts';
import { loadMap, setCacheWrites } from './core/cache.ts';
import { applyChangeSet, changeSetJson, historyShow, loadPlan, readHistory, renderDiff, savePlan, undoLast, undoTo, type ApplyResult } from './core/changeset.ts';
import { changeSummaryLine, commitChange, openDiffInEditor, readClipboard } from './core/workflow.ts';
import { CONFIG_FILE, loadConfig } from './core/config.ts';
import { ToolError, type Adapter, type ArchitectureOption, type ChangeSet, type ProjectMap } from './core/types.ts';
import { planApiAdd, type ApiAddOptions } from './skills/apiAdd.ts';
import { renderExplain } from './skills/explain.ts';
import { detectProject, initFiles, writeInitFiles, type Detected } from './skills/init.ts';
import { planSetup } from './skills/setup.ts';
import { planApiWire, planModuleAdd } from './skills/module.ts';
import { listApiImport, planApiImport } from './skills/apiImport.ts';
import { planApiSync } from './skills/apiSync.ts';
import { planTestAdd } from './skills/testgen.ts';
import { listTemplates, planTemplatesInit } from './skills/templatesCmd.ts';
import { serveMcp } from './skills/mcp.ts';
import { createProject, describeCreate, PROJECT_TYPES, projectType, type CreateOptions } from './skills/create.ts';
import { planApiRemove, planApiRename, planApiUpdate } from './skills/apiEdit.ts';
import { planMockAdd } from './skills/mock.ts';
import { planLocaleAdd, planLocaleKey } from './skills/locale.ts';
import { planThemeSet } from './skills/theme.ts';
import { planRouteAdd } from './skills/route.ts';
import { planScreenAdd } from './skills/screen.ts';
import { planFeatureAdd } from './skills/feature.ts';
import { planAuthAdd } from './skills/auth.ts';
import { diffFails, planApiDiff, renderDiffMarkdown, renderDiffSarif, renderDiffText } from './skills/apiDiff.ts';
import { renderDoctor, runDoctor } from './skills/doctor.ts';
import { renderSetupDoctor, runSetupDoctor } from './skills/setupDoctor.ts';
import { planDoctorFix } from './skills/doctorFix.ts';
import { configCheck, configView, planConfigSet } from './skills/config.ts';
import { apiList, apiShow } from './skills/apiList.ts';
import { cleanPlans, listPlans, showPlan } from './skills/plans.ts';
import { complete, completionScript, SHELLS } from './skills/completion.ts';
import { genericAdapter } from './adapters/generic.ts';
import { allowedFlags, BOOLEAN_FLAGS, findCommand, FLAGS, renderCommandHelp, renderHelp, REPEATABLE_FLAGS } from './core/commands.ts';
import { closest } from './core/validateConfig.ts';
import { recordEvent } from './core/events.ts';
import { buildReport, renderReport } from './skills/report.ts';
import { homedir } from 'node:os';
import { runTool } from './core/proc.ts';
import { connectHints, MockServer, mockApiFromProject, mockApiFromSpec, type MockApi } from './skills/mockServer.ts';

/** Operating-system errors that are not codz bugs, with what to do about them. */
const SYSTEM_ERRORS: Record<string, { code: string; say: string; hint: string }> = {
  ENOSPC: { code: 'disk_full', say: 'The disk is full, so codz could not write its files.', hint: 'Free some disk space and run the command again.' },
  EACCES: { code: 'permission_denied', say: 'codz is not allowed to write here.', hint: 'Check the folder permissions (or that the files are not read-only) and run the command again.' },
  EPERM: { code: 'permission_denied', say: 'The operating system did not allow the change.', hint: 'Check the folder permissions, and that no other app (an editor or antivirus) has the files locked.' },
  EROFS: { code: 'read_only', say: 'This folder is on a read-only disk.', hint: 'Run codz in a writable copy of the project.' },
  EMFILE: { code: 'too_many_files', say: 'Too many files are open at once.', hint: 'Close other programs or raise the limit (ulimit -n 4096), then run the command again.' },
};

export const VERSION = '0.1.0';

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
  multi: Record<string, string[]>;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { positional: [], flags: {}, multi: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      args.positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('-') && a.length > 1) {
      const body = a.replace(/^--?/, '');
      const eq = body.indexOf('=');
      const name = eq >= 0 ? body.slice(0, eq) : body;
      let value: string | boolean;
      if (eq >= 0) value = body.slice(eq + 1);
      else if (BOOLEAN_FLAGS.has(name) || !(name in FLAGS)) value = true;
      else {
        const next = argv[i + 1];
        if (next === undefined) throw new ToolError('bad_args', `--${name} needs a value.`);
        value = next;
        i++;
      }
      if (REPEATABLE_FLAGS.has(name)) (args.multi[name] ??= []).push(String(value));
      else args.flags[name] = value;
    } else {
      args.positional.push(a);
    }
  }
  return args;
}

const HELP = renderHelp(VERSION, CONFIG_FILE);

function findRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function readPasteInteractive(): Promise<string> {
  process.stderr.write('Paste a cURL command or URL. You can add "response:" and a JSON sample after it.\nFinish with Ctrl-D (Ctrl-Z then Enter on Windows).\n');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  // Ctrl-D leaves the cursor at the end of the pasted text.
  process.stderr.write('\n');
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Opens the terminal directly. Standard input may already be used up (a paste
 * ended with Ctrl-D, or input piped from a file), so questions are asked on
 * the terminal itself.
 */
function openTerminal(): ReadStream | null {
  try {
    const fd = openSync(process.platform === 'win32' ? 'CONIN$' : '/dev/tty', 'r');
    return new ReadStream(fd);
  } catch {
    return null;
  }
}

/** Asks a yes/no question on the terminal. Returns null when there is no terminal to ask on. */
async function confirm(question: string): Promise<boolean | null> {
  const input = openTerminal();
  if (!input) return null;
  const rl = createInterface({ input, output: process.stderr });
  try {
    const answer = await new Promise<string | null>((resolve) => {
      rl.on('close', () => resolve(null));
      rl.question(`${question} (y/N) `).then(resolve, () => resolve(null));
    });
    if (answer === null) {
      process.stderr.write('\n');
      return false;
    }
    const a = answer.trim().toLowerCase();
    return a === 'y' || a === 'yes';
  } finally {
    rl.close();
    input.destroy();
  }
}

/** Asks the user to pick one option on the terminal. Returns the index, or null without a terminal. */
async function choose(question: string, options: string[], defaultIndex: number): Promise<number | null> {
  const input = openTerminal();
  if (!input) return null;
  const rl = createInterface({ input, output: process.stderr });
  try {
    process.stderr.write(`${question}\n`);
    options.forEach((o, i) => process.stderr.write(`  ${i + 1}) ${o}\n`));
    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = await new Promise<string | null>((resolve) => {
        rl.on('close', () => resolve(null));
        rl.question(`Choose 1-${options.length} [${defaultIndex + 1}]: `).then(resolve, () => resolve(null));
      });
      if (answer === null) return null;
      const t = answer.trim();
      if (t === '') return defaultIndex;
      const n = Number(t);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
      process.stderr.write(`Please type a number from 1 to ${options.length}.\n`);
    }
    return null;
  } finally {
    rl.close();
    input.destroy();
  }
}

/** Asks for a line of text on the terminal. Returns null without a terminal. */
async function ask(question: string, validate: (v: string) => string | null): Promise<string | null> {
  const input = openTerminal();
  if (!input) return null;
  const rl = createInterface({ input, output: process.stderr });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = await new Promise<string | null>((resolve) => {
        rl.on('close', () => resolve(null));
        rl.question(question).then(resolve, () => resolve(null));
      });
      if (answer === null) return null;
      const problem = validate(answer.trim());
      if (!problem) return answer.trim();
      process.stderr.write(`${problem}\n`);
    }
    return null;
  } finally {
    rl.close();
    input.destroy();
  }
}

const interactive = (out: { json: boolean }) => !out.json && !!process.stderr.isTTY;

interface Out {
  json: boolean;
  color: boolean;
  print(text: string): void;
  warn(text: string): void;
  result(obj: Record<string, unknown>): void;
}

function makeOut(flags: Args['flags']): Out {
  const json = flags.json === true;
  const color = !json && !flags['no-color'] && !!process.stdout.isTTY && !process.env.NO_COLOR;
  return {
    json,
    color,
    print: (t) => {
      if (!json) process.stdout.write(t.endsWith('\n') ? t : t + '\n');
    },
    warn: (t) => {
      if (!json) process.stderr.write((color ? `\x1b[33m! ${t}\x1b[0m` : `! ${t}`) + '\n');
    },
    result: (obj) => {
      if (json) process.stdout.write(JSON.stringify({ ok: true, ...obj }, null, 2) + '\n');
    },
  };
}

function printChangeSet(out: Out, cs: ChangeSet): void {
  for (const s of cs.summary) out.print(`• ${s}`);
  for (const w of cs.warnings) out.warn(w);
  if (cs.changes.length) out.print(`\n${changeSummaryLine(cs)}\n\n${renderDiff(cs, out.color)}`);
}

function printApplied(out: Out, r: ApplyResult): void {
  out.print(`Applied: ${r.files.join(', ')}`);
  if (r.formatted) out.print('Formatted with the project formatter.');
  if (r.formatNote) out.warn(r.formatNote);
  if (r.verified) out.print('Checked with the project analyzer: no new errors.');
  if (r.verifyNote) out.warn(r.verifyNote);
  out.print('Undo with: codz undo');
}

interface ChangeOptions {
  allowDirty?: boolean;
  verify?: boolean;
  /** Runs after a successful apply; returns extra fields for --json output. */
  afterApply?: () => Record<string, unknown>;
}

async function handleChange(root: string, out: Out, flags: Args['flags'], cs: ChangeSet, adapter: Adapter, opts: ChangeOptions = {}): Promise<number> {
  if (cs.changes.length === 0) {
    out.print(cs.summary.length ? cs.summary.join('\n') : 'Nothing to change.');
    for (const w of cs.warnings) out.warn(w);
    out.result({ applied: false, changeSet: changeSetJson(cs) });
    return 0;
  }
  if (flags['dry-run']) {
    printChangeSet(out, cs);
    out.result({ applied: false, dryRun: true, changeSet: changeSetJson(cs) });
    return 0;
  }
  if (flags.plan) {
    savePlan(root, cs);
    printChangeSet(out, cs);
    out.print(`\nSaved plan ${cs.id}. Apply exactly this change with: codz apply ${cs.id}`);
    out.result({ applied: false, planId: cs.id, changeSet: changeSetJson(cs) });
    return 0;
  }
  printChangeSet(out, cs);
  if (flags.open === true && !out.json && !openDiffInEditor(root, cs)) out.warn('Set $EDITOR (or $VISUAL) to open the diff in your editor.');
  let go = flags.yes === true || flags.y === true;
  if (!go && !out.json && process.stderr.isTTY) go = (await confirm('\nApply these changes?')) ?? false;
  if (!go) {
    savePlan(root, cs);
    out.print(`\nNot applied. To apply exactly this diff later: codz apply ${cs.id}  (or re-run with --yes)`);
    out.result({ applied: false, planId: cs.id, changeSet: changeSetJson(cs) });
    return 0;
  }
  const r = applyChangeSet(root, cs, { allowDirty: opts.allowDirty || flags['allow-dirty'] === true, adapter, format: !flags['no-format'], verify: opts.verify ?? !flags['no-verify'] });
  printApplied(out, r);
  let commit: string | undefined;
  if (flags.commit === true) {
    commit = commitChange(root, cs, typeof flags['commit-message'] === 'string' ? flags['commit-message'] : undefined);
    out.print(`Committed ${commit}. Undo with: codz undo (then git reset --soft HEAD~1 if you want the commit gone too)`);
  }
  const extra = opts.afterApply?.() ?? {};
  out.result({ applied: true, id: cs.id, ...r, ...(commit ? { commit } : {}), ...extra, changeSet: changeSetJson(cs, false) });
  return 0;
}

const URL_CHECK = (v: string) => baseUrlProblem(v);

/** Installs dependencies a change added (flutter pub get, npm install), or says how. Returns the command that ran. */
function installDependencies(root: string, adapter: Adapter, out: Out): string | undefined {
  const cmd = adapter.afterSetup?.(root);
  if (cmd) {
    out.print(`Running ${cmd.label}...`);
    const r = runTool(cmd.cmd, cmd.args, { cwd: root });
    if (r.status === 0) {
      out.print(`${cmd.label}: done.`);
      return cmd.label;
    }
    out.warn(`${cmd.label} failed. Run it yourself: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-1)[0] ?? ''}`);
    return undefined;
  }
  out.warn(adapter.id === 'android' ? 'Gradle dependencies and plugins were added. Sync the project in Android Studio (or run ./gradlew build).' : adapter.id === 'flutter' ? 'Dependencies were added. Install them with `flutter pub get`.' : 'Dependencies were added. Install them with `npm install` (or your package manager).');
  return undefined;
}

/** Runs setup as one change set, then installs dependencies when they changed. */
async function runSetup(d: Detected, out: Out, flags: Args['flags'], architecture: string, baseUrl: string): Promise<number> {
  const { changeSet, plan } = planSetup(d.root, d.adapter, d.map, { architecture, baseUrl });
  return handleChange(d.root, out, flags, changeSet, d.adapter, {
    // A fresh project is often not committed yet; undo still works from codz's backups.
    allowDirty: true,
    // New packages are not installed until after apply, so the analyzer would fail on their imports.
    verify: false,
    afterApply: () => {
      const installed = plan.dependenciesChanged ? installDependencies(d.root, d.adapter, out) : undefined;
      out.print('\nReady. Add your first endpoint with: codz api add');
      return { installed };
    },
  });
}

/** codz create: asks what it needs (or takes flags), then creates and sets up the project. */
/** What the starter commands need from the CLI: flags, output and (in a terminal) questions. */
function starterCtx(args: Args, out: Out, cwd: string) {
  const canAsk = interactive(out) && args.flags.yes !== true && args.flags.y !== true;
  return {
    sub: args.positional[0] === 'apply' ? undefined : args.positional[1],
    positional: args.positional,
    flags: args.flags,
    multi: args.multi,
    cwd,
    version: VERSION,
    io: { json: out.json, print: out.print, warn: out.warn, result: out.result, ask: canAsk ? ask : null, choose: canAsk ? choose : null, confirm: canAsk ? confirm : null },
  };
}

async function runCreate(nameArg: string | undefined, flags: Args['flags'], out: Out, parent: string): Promise<number> {
  const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : '');
  const canAsk = interactive(out) && flags.yes !== true && flags.y !== true;
  const need = (what: string, flag: string) => new ToolError('bad_args', `Which ${what}? Pass --${flag}, or run codz create in a terminal to be asked.`);
  let typeId = str('type');
  if (!typeId) {
    if (!canAsk) throw need('project type', 'type');
    const i = await choose('Which project do you want to create?', PROJECT_TYPES.map((t) => `${t.label}: ${t.description}`), 0);
    if (i === null) return 1;
    typeId = PROJECT_TYPES[i].id;
  }
  const type = projectType(typeId);
  let architecture = str('architecture');
  if (!architecture) {
    if (!canAsk) throw need('architecture', 'architecture');
    const i = await choose(`Which architecture for ${type.label}?`, type.architectures.map((a) => `${a.label}: ${a.description}`), 0);
    if (i === null) return 1;
    architecture = type.architectures[i].id;
  }
  let name = nameArg ?? '';
  if (!name) {
    if (!canAsk) throw need('project name', 'name (codz create <name>)');
    name = (await ask(`Project name: `, (v) => type.checkName(v))) ?? '';
    if (!name) return 1;
  }
  let org = str('org') || 'com.example';
  if (type.needsOrg && !str('org') && canAsk) org = (await ask(`Organization (reverse domain) [com.example]: `, (v) => (!v || /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(v) ? null : 'Use reverse-domain form, for example com.mycompany'))) || 'com.example';
  let baseUrl = str('base-url');
  if (!baseUrl && architecture !== 'none' && canAsk) baseUrl = (await ask('API base URL (Enter to skip): ', URL_CHECK)) ?? '';
  let tailwind = flags.tailwind === true;
  if (type.options.includes('tailwind') && flags.tailwind === undefined && canAsk) tailwind = (await confirm('Use Tailwind CSS?')) ?? false;
  let flavor: 'expo' | 'bare' = str('flavor') === 'bare' ? 'bare' : 'expo';
  if (type.options.includes('flavor') && !str('flavor') && canAsk) flavor = (await choose('Expo or the React Native CLI?', ['Expo (recommended): runs in Expo Go, native folders when you need them', 'React Native CLI: android/ and ios/ folders from the start'], 0)) === 1 ? 'bare' : 'expo';
  let primary = str('primary');
  if (!primary && canAsk) primary = (await ask('Primary color, #rrggbb (Enter to skip): ', (v) => (!v || /^#?[0-9a-fA-F]{6}$/.test(v) ? null : 'Use a color like #6750A4'))) ?? '';
  const opts: CreateOptions = { type: type.id, name, parent, architecture, baseUrl, org, tailwind, flavor, primary: primary || undefined, offline: flags.offline === true, install: flags['no-install'] !== true, git: flags['no-git'] !== true };
  const plan = describeCreate(opts);
  if (flags['dry-run'] === true) {
    out.print(plan.map((s) => `• ${s}`).join('\n'));
    out.result({ dryRun: true, steps: plan, options: opts });
    return 0;
  }
  if (canAsk) {
    out.print(`\n${plan.map((s) => `• ${s}`).join('\n')}`);
    if (!(await confirm('\nCreate it?'))) {
      out.print('Not created.');
      return 0;
    }
  }
  const r = await createProject(opts, (l) => out.print(l));
  out.print(r.steps.map((s) => `• ${s}`).join('\n'));
  for (const w of r.warnings) out.warn(w);
  out.print(`\nNext: cd ${name} && codz api add`);
  out.result({ ...r });
  return 0;
}

/** Picks an architecture and base URL from flags or by asking. Returns null when the user skips. */
async function chooseSetup(options: ArchitectureOption[], out: Out, flags: Args['flags'], defaultBaseUrl: string, onlyOne = false): Promise<{ architecture: string; baseUrl: string } | null> {
  let architecture = typeof flags.architecture === 'string' ? flags.architecture : '';
  let baseUrl = typeof flags['base-url'] === 'string' ? flags['base-url'] : '';
  // With only one architecture there is nothing to choose.
  if (onlyOne && !architecture && options.length === 1 && !interactive(out)) architecture = options[0].id;
  if (!architecture) {
    if (!interactive(out)) return null;
    const labels = [...options.map((o) => `${o.label}${o.recommended ? ' (recommended)' : ''}: ${o.description}`), 'Skip: set it up myself'];
    const picked = await choose('\nNo API layer was found in this project. Which architecture should codz set up?', labels, 0);
    if (picked === null || picked === options.length) return null;
    architecture = options[picked].id;
    if (!baseUrl) {
      const hint = defaultBaseUrl ? ` [${defaultBaseUrl}]` : ' (Enter to skip)';
      const answer = await ask(`API base URL${hint}: `, URL_CHECK);
      baseUrl = answer || defaultBaseUrl;
    }
  }
  return { architecture, baseUrl };
}

export async function main(argv: string[]): Promise<number> {
  // Shell completion: the words may be half-typed flags, so they skip normal parsing.
  if (argv[0] === '__complete') {
    try {
      const words = argv.slice(1);
      const cwdAt = words.indexOf('--cwd');
      const root = findRoot(resolve(cwdAt !== -1 && words[cwdAt + 1] ? words[cwdAt + 1] : process.cwd()));
      let adapter = genericAdapter;
      try {
        adapter = adapterFor(root).adapter;
      } catch {
        // Broken config: commands and flags still complete.
      }
      const out = await complete(words.length ? words : [''], root, adapter);
      if (out.length) process.stdout.write(out.join('\n') + '\n');
    } catch {
      // Completion never prints errors.
    }
    return 0;
  }
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }
  const out = makeOut(args.flags);
  const started = Date.now();
  const event = (ok: boolean, code?: string) => {
    const [cmd, sub] = args.positional;
    if (!cmd || ['report', 'completion', 'help', 'mcp'].includes(cmd) || args.flags.help || args.flags.version) return;
    const spec = findCommand(cmd, sub);
    const name = spec ? (spec.sub ? `${spec.cmd} ${spec.sub}` : spec.cmd) : 'unknown';
    const start = resolve(typeof args.flags.cwd === 'string' ? args.flags.cwd : process.cwd());
    recordEvent(typeof args.flags.root === 'string' ? resolve(args.flags.root) : findRoot(start), { t: new Date().toISOString(), cmd: name, ok, ...(code ? { code } : {}), ms: Date.now() - started, v: VERSION });
  };
  try {
    const code = await run(args, out);
    event(code === 0, code === 0 ? undefined : `exit_${code}`);
    return code;
  } catch (e) {
    event(false, e instanceof ToolError ? e.code : 'internal');
    if (e instanceof ToolError) {
      // Every refusal says what to do next; errors written without their own hint get one by kind.
      const [c0, c1] = args.positional;
      const spec = c0 ? findCommand(c0, c1) : undefined;
      const usage = spec ? `codz ${spec.cmd}${spec.sub ? ` ${spec.sub}` : ''} --help` : 'codz --help';
      const hint = e.hint ?? (e.code === 'not_supported' || e.code === 'unsupported_setup' ? `codz explain shows what codz found in this project; README "What it supports" lists the setups each command handles.` : `See the options and examples with: ${usage}`);
      if (out.json) process.stdout.write(JSON.stringify({ ok: false, error: { code: e.code, message: e.message, hint } }, null, 2) + '\n');
      else {
        process.stderr.write((out.color ? `\x1b[31m✗ ${e.message}\x1b[0m` : `✗ ${e.message}`) + '\n');
        process.stderr.write(`  ${hint}\n`);
      }
      return 1;
    }
    // Problems with the machine, not codz: say what to do instead of calling it a bug.
    const sys = SYSTEM_ERRORS[(e as NodeJS.ErrnoException)?.code ?? ''];
    if (sys) {
      const message = e instanceof Error ? e.message : String(e);
      if (out.json) process.stdout.write(JSON.stringify({ ok: false, error: { code: sys.code, message, hint: sys.hint } }, null, 2) + '\n');
      else {
        process.stderr.write((out.color ? `\x1b[31m✗ ${sys.say}\x1b[0m` : `✗ ${sys.say}`) + '\n');
        process.stderr.write(`  ${sys.hint}\n  (${message})\n`);
      }
      return 1;
    }
    // An unexpected error still answers in the format the caller asked for.
    const message = e instanceof Error ? e.message : String(e);
    if (out.json) process.stdout.write(JSON.stringify({ ok: false, error: { code: 'internal', message, hint: 'This is a codz bug. Run again with CODZ_DEBUG=1 for the stack trace and report it.' } }, null, 2) + '\n');
    else {
      process.stderr.write((out.color ? `\x1b[31m✗ ${message}\x1b[0m` : `✗ ${message}`) + '\n');
      process.stderr.write(process.env.CODZ_DEBUG && e instanceof Error && e.stack ? `${e.stack}\n` : '  This is a codz bug. Run again with CODZ_DEBUG=1 for the stack trace and report it.\n');
    }
    return 1;
  }
}

async function run(args: Args, out: Out): Promise<number> {
  const { flags, positional } = args;
  if (flags.version || flags.v) {
    out.print(VERSION);
    out.result({ version: VERSION });
    return 0;
  }
  const [cmd, sub] = positional;
  if (cmd === 'help' && positional[1]) {
    const spec = findCommand(positional[1], positional[2]);
    if (!spec) throw new ToolError('bad_args', `Unknown command "${positional.slice(1).join(' ')}".`, 'See every command with: codz --help');
    out.print(renderCommandHelp(spec));
    return 0;
  }
  if (cmd && (flags.help || flags.h)) {
    const spec = findCommand(cmd, sub);
    if (spec) {
      out.print(renderCommandHelp(spec));
      return 0;
    }
  }
  if (!cmd || flags.help || flags.h || cmd === 'help') {
    out.print(HELP);
    return cmd || flags.help || flags.h ? 0 : 1;
  }
  // A mistyped option (--dryrun) must not be ignored: it could apply a change the user meant to preview.
  const spec = findCommand(cmd, sub);
  if (spec) {
    const allowed = allowedFlags(spec);
    for (const name of [...Object.keys(flags), ...Object.keys(args.multi)]) {
      if (allowed.includes(name)) continue;
      const near = closest(name, allowed);
      throw new ToolError('bad_args', `codz ${spec.cmd}${spec.sub ? ` ${spec.sub}` : ''} has no option --${name}.`, near ? `Did you mean --${near}? (codz ${spec.cmd}${spec.sub ? ` ${spec.sub}` : ''} --help lists the options)` : `See its options with: codz ${spec.cmd}${spec.sub ? ` ${spec.sub}` : ''} --help`);
    }
  }
  const start = resolve(typeof flags.cwd === 'string' ? flags.cwd : process.cwd());
  // A preview or a health check must not leave files behind, not even the scan cache.
  setCacheWrites(!(flags['dry-run'] === true || cmd === 'check' || (cmd === 'doctor' && flags.fix !== true)));

  if (cmd === 'create') return runCreate(positional[1], flags, out, start);

  // Starter commands: the only ones with network code, loaded only when used.
  if (cmd === 'new' || cmd === 'starters' || cmd === 'login' || cmd === 'logout' || cmd === 'whoami') {
    const starters = await import('./starters/commands.ts');
    return starters.runStarterCommand(cmd, starterCtx(args, out, start));
  }
  if (cmd === 'apply' && sub && /^[\w-]+$/.test(sub) && existsSync(join(process.env.CODZ_HOME || join(homedir(), '.codz'), 'starters', 'plans', `${sub}.json`))) {
    const starters = await import('./starters/commands.ts');
    return (await starters.applyStarterPlan(sub, starterCtx(args, out, start))) ?? 1;
  }

  if (cmd === 'init' || cmd === 'setup') {
    const d = await detectProject(start, { root: typeof flags.root === 'string' ? flags.root : undefined, force: flags.force === true });
    const m = d.map;
    const options = d.adapter.architectures?.(m) ?? [];
    const defaultBaseUrl = m.baseUrls[0]?.value ?? '';
    if (cmd === 'setup') {
      if (!options.length) {
        throw new ToolError('already_set_up', d.adapter.architectures ? 'This project already has an API layer, so setup is not needed.' : `setup is not available for the ${d.adapter.id} adapter.`, 'Run codz explain to see it, then codz api add.');
      }
      const choice = await chooseSetup(options, out, flags, defaultBaseUrl, true);
      if (!choice) {
        throw new ToolError('bad_args', 'Which architecture?', `Pass --architecture with one of: ${options.map((o) => o.id).join(', ')} (and --base-url <url>).`);
      }
      return runSetup(d, out, flags, choice.architecture, choice.baseUrl);
    }

    out.print(`Detected ${d.label} → ${d.adapter.id} adapter${d.adapter.id === 'generic' ? ' (structure, locales and config only)' : ''}`);
    out.print(`Project root: ${d.root}`);
    out.print(`Found ${m.routes.length} routes, ${m.endpoints.length} endpoints, ${m.models.length} models, ${m.locales.languages.length} languages.`);
    for (const n of m.notes) out.warn(n);

    // A project with no API layer: offer to create one, in the same change as the config file.
    if (options.length && (!d.configExists || flags.force || typeof flags.architecture === 'string')) {
      const choice = await chooseSetup(options, out, flags, defaultBaseUrl);
      if (choice) return runSetup(d, out, flags, choice.architecture, choice.baseUrl);
    }

    const files = initFiles(d.root, d.adapter, m.conventions);
    const keepConfig = d.configExists && !flags.force;
    const w = writeInitFiles(d.root, files, keepConfig);
    if (w.configWritten) out.print(`Wrote ${CONFIG_FILE}. Review the detected conventions once and correct anything wrong, then commit it.`);
    else out.print(`${CONFIG_FILE} already exists; kept your values (use --force to detect again).`);
    if (w.gitignoreUpdated) out.print('Added .codz/ to .gitignore.');
    if (options.length) {
      out.print(`\nNo API layer was found. Create one with: codz setup --architecture ${options[0].id} --base-url https://api.example.com`);
      out.print(`Architectures: ${options.map((o) => o.id).join(', ')}`);
    } else {
      out.print('Next: codz explain');
    }
    out.result({
      root: d.root,
      framework: d.adapter.id,
      detected: d.label,
      configWritten: w.configWritten,
      gitignoreUpdated: w.gitignoreUpdated,
      counts: { routes: m.routes.length, endpoints: m.endpoints.length, models: m.models.length, languages: m.locales.languages.length },
      conventions: m.conventions,
      architectures: options,
      notes: m.notes,
    });
    return 0;
  }

  const root = typeof flags.root === 'string' ? resolve(flags.root) : findRoot(start);

  // Commands that must work even when the config file is broken.
  if (cmd === 'completion') {
    if (!sub || !(SHELLS as readonly string[]).includes(sub)) throw new ToolError('bad_args', 'Which shell? Usage: codz completion bash|zsh|fish', 'bash: eval "$(codz completion bash)" in ~/.bashrc; zsh: source <(codz completion zsh) in ~/.zshrc; fish: codz completion fish > ~/.config/fish/completions/codz.fish');
    process.stdout.write(completionScript(sub));
    return 0;
  }
  if (cmd === 'mcp') return serveMcp(root, VERSION);
  if (cmd === 'doctor' && flags.setup === true) {
    let a = genericAdapter;
    try {
      a = adapterFor(root).adapter;
    } catch {
      // A broken config is reported by the config_valid check.
    }
    const r = runSetupDoctor(root, a);
    out.print(renderSetupDoctor(r, `codz doctor --setup  (${a.id}@${a.version}, ${root})`, out.color));
    out.result({ checks: r.checks, summary: r.summary });
    return r.summary.fail ? 1 : 0;
  }
  if (cmd === 'config' && sub === 'check') {
    const r = configCheck(root);
    if (!r.issues.length) out.print(`${r.file}: no problems found.`);
    for (const i of r.issues) out.print(`${i.level === 'error' ? '✗' : '!'} ${i.key ? `${i.key}: ` : ''}${i.message}${i.hint ? `\n    → ${i.hint}` : ''}`);
    const errors = r.issues.filter((i) => i.level === 'error').length;
    out.result({ file: r.file, issues: r.issues, valid: errors === 0 });
    return errors ? 1 : 0;
  }

  // api diff compares two files; it works anywhere and uses the project only for the impact lines.
  if (cmd === 'api' && sub === 'diff') {
    const [oldFile, newFile] = [positional[2], positional[3]];
    if (!oldFile || !newFile) throw new ToolError('bad_args', 'Usage: codz api diff <old spec> <new spec> [--format text|md|json|sarif] [--report <file>] [--fail-on breaking|warning|any|none]');
    const format = typeof flags.format === 'string' ? flags.format : 'text';
    if (!['text', 'md', 'markdown', 'json', 'sarif'].includes(format)) throw new ToolError('bad_args', `--format must be text, md, json or sarif, got "${format}".`);
    const failOn = typeof flags['fail-on'] === 'string' ? flags['fail-on'] : 'breaking';
    if (!['breaking', 'warning', 'any', 'none'].includes(failOn)) throw new ToolError('bad_args', `--fail-on must be breaking, warning, any or none, got "${failOn}".`);
    let projectAdapter: Adapter | null = null;
    if (existsSync(join(root, CONFIG_FILE))) {
      try {
        projectAdapter = adapterFor(root).adapter;
      } catch {
        projectAdapter = null;
      }
    }
    const split = (xs?: (string | boolean | undefined)[]) => xs?.flatMap((x) => (typeof x === 'string' ? x.split(',') : [])).map((x) => x.trim()).filter(Boolean) ?? [];
    const report = await planApiDiff(projectAdapter ? root : null, projectAdapter, resolve(oldFile), resolve(newFile), { tags: split(args.multi.tag), paths: split(args.multi.path) });
    const text = format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : format === 'sarif' ? renderDiffSarif(report, projectAdapter ? root : null) : format === 'text' ? `${renderDiffText(report)}\n` : renderDiffMarkdown(report);
    if (typeof flags.report === 'string') {
      writeFileSync(resolve(flags.report), text);
      out.print(renderDiffText(report));
      out.print(`Report written to ${flags.report}`);
    } else if (format === 'text') out.print(text.trimEnd());
    else process.stdout.write(text);
    out.result({ ...report, failed: diffFails(report, failOn) });
    return diffFails(report, failOn) ? 1 : 0;
  }

  // mock serve: a local fake API; with --spec it works anywhere, without a project.
  if (cmd === 'mock' && sub === 'serve') {
    const num = (k: string, def: number) => {
      const v = flags[k];
      if (v === undefined) return def;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw new ToolError('bad_args', `--${k} must be a whole number, got "${v}".`);
      return n;
    };
    const port = num('port', 4010);
    let api: MockApi;
    let framework: string | null = null;
    let map: ProjectMap | null = null;
    const hasProject = existsSync(join(root, CONFIG_FILE));
    if (hasProject) {
      try {
        const a = adapterFor(root).adapter;
        framework = a.id;
        map = (await loadMap(root, a, loadConfig(root).conventions)).map;
      } catch {
        framework = null;
      }
    }
    if (typeof flags.spec === 'string') api = mockApiFromSpec(resolve(flags.spec));
    else if (map && framework) api = mockApiFromProject(root, map, framework === 'flutter' ? 'dart' : framework === 'android' ? 'kt' : framework === 'ios' ? 'swift' : 'ts');
    else throw new ToolError('bad_args', 'No codz project here, so there are no endpoints to mock.', 'Serve an API file instead: codz mock serve --spec api.yaml (or run codz init in your app first).');
    const lan = flags.lan === true;
    const server = new MockServer(api, { port, host: lan ? '0.0.0.0' : '127.0.0.1', delay: num('delay', 300), items: num('items', 5), log: (line) => out.print(`  ${line}`) });
    const actual = await server.start();
    out.print(`Mock API on http://localhost:${actual}, from ${api.source}:`);
    for (const r of api.routes.slice(0, 40)) out.print(`  ${r.method.padEnd(6)} ${r.path}`);
    if (api.routes.length > 40) out.print(`  … and ${api.routes.length - 40} more`);
    out.print('');
    for (const h of connectHints(map, framework, actual, lan)) out.print(h);
    out.print('Lists, create, edit and delete share in-memory data (restart to reset). Press Ctrl+C to stop.');
    out.print('');
    await new Promise<void>((done) => {
      process.once('SIGINT', () => done());
      process.once('SIGTERM', () => done());
    });
    await server.stop();
    return 0;
  }

  const { adapter } = adapterFor(root);

  switch (cmd) {
    case 'report': {
      const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
      const r = buildReport(root, adapter, map, VERSION);
      out.print(renderReport(r));
      out.result({ ...r });
      return 0;
    }
    case 'explain': {
      const cfg = loadConfig(root);
      if (!cfg.exists) out.warn(`No ${CONFIG_FILE} yet; showing detected values. Run codz init to save them.`);
      const { map } = await loadMap(root, adapter, cfg.conventions, { force: flags.rescan === true });
      out.print(renderExplain(map, adapter, out.color));
      out.result({ map, supportedSetup: adapter.supportedSetup });
      return 0;
    }
    case 'mock': {
      if (sub !== 'add') throw new ToolError('bad_args', `Unknown command "mock ${sub ?? ''}".`, 'Usage: codz mock add <endpoint> [--sample file.json] | codz mock add --all | codz mock serve [--spec api.yaml] [--port 4010]');
      const cs = await planMockAdd(root, adapter, { endpoints: positional.slice(2), all: flags.all === true, sample: typeof flags.sample === 'string' ? flags.sample : args.multi.sample?.[0], keepValues: flags['keep-values'] === true, force: flags.force === true });
      return handleChange(root, out, flags, cs, adapter);
    }
    case 'locale': {
      if (sub === 'add') {
        const lang = positional[2];
        if (!lang) throw new ToolError('bad_args', 'Usage: codz locale add <lang> [--from <lang>]');
        const cs = await planLocaleAdd(root, adapter, lang, { from: typeof flags.from === 'string' ? flags.from : undefined });
        return handleChange(root, out, flags, cs, adapter);
      }
      if (sub === 'key') {
        const key = positional[2];
        const text = positional.slice(3).join(' ');
        if (!key || !text) throw new ToolError('bad_args', 'Usage: codz locale key <key> "<text>" [--value hi="..."]');
        const values = new Map<string, string>();
        for (const v of args.multi.value ?? []) {
          const i = v.indexOf('=');
          if (i < 1) throw new ToolError('bad_args', `--value needs lang=text, got "${v}".`);
          values.set(v.slice(0, i), v.slice(i + 1));
        }
        const cs = await planLocaleKey(root, adapter, key, text, { values, force: flags.force === true });
        return handleChange(root, out, flags, cs, adapter);
      }
      throw new ToolError('bad_args', `Unknown command "locale ${sub ?? ''}".`, 'Usage: codz locale add <lang> | codz locale key <key> "<text>"');
    }
    case 'config': {
      if (!sub || sub === 'show' || sub === 'list') {
        const v = await configView(root, adapter);
        out.print(`${v.file ?? `(no ${CONFIG_FILE} yet: showing detected values)`}  framework: ${v.framework}`);
        const w = Math.max(0, ...v.rows.map((r) => r.key.length));
        for (const r of v.rows) out.print(`  ${r.key.padEnd(w)}  ${r.value === '' ? "''" : r.value}${r.source === 'detected' ? '   (detected)' : ''}`);
        out.result(v);
        return 0;
      }
      if (sub === 'get') {
        const key = positional[2];
        if (!key) throw new ToolError('bad_args', 'Usage: codz config get <key>');
        const v = await configView(root, adapter);
        const row = v.rows.find((r) => r.key === key);
        if (!row) throw new ToolError('unknown_key', `"${key}" is not a ${adapter.id} convention.`, `Known keys: ${v.rows.map((r) => r.key).join(', ')}`);
        out.print(row.value);
        out.result({ ...row });
        return 0;
      }
      if (sub === 'set') {
        const key = positional[2];
        const value = positional.length > 3 ? positional.slice(3).join(' ') : undefined;
        if (!key || value === undefined) throw new ToolError('bad_args', 'Usage: codz config set <key> <value>', 'Use \'\' as the value to go back to detecting it.');
        const cs = planConfigSet(root, adapter, key, value === "''" || value === '""' ? '' : value, { force: flags.force === true });
        return handleChange(root, out, flags, cs, adapter, { allowDirty: true, verify: false });
      }
      throw new ToolError('bad_args', `Unknown command "config ${sub}".`, 'Usage: codz config [show] | get <key> | set <key> <value> | check');
    }
    case 'plans': {
      if (!sub || sub === 'list') {
        const rows = listPlans(root);
        if (!rows.length) out.print('No saved plans. Make one with --plan on any command that changes code.');
        for (const p of rows) out.print(`${p.id}  ${p.status.padEnd(7)}  ${p.skill.padEnd(12)}  ${p.summary}`);
        out.result({ plans: rows });
        return 0;
      }
      if (sub === 'show') {
        const id = positional[2];
        if (!id) throw new ToolError('bad_args', 'Which plan? Usage: codz plans show <plan-id>', 'List them with: codz plans list');
        const { plan, status } = showPlan(root, id);
        out.print(`${plan.id}  ${plan.skill}  (${status}${status === 'stale' ? ': a file changed since; run the command again' : status === 'ready' ? `: apply with codz apply ${plan.id}` : ''})`);
        printChangeSet(out, plan);
        out.result({ status, ...changeSetJson(plan) });
        return 0;
      }
      if (sub === 'clean') {
        const removed = cleanPlans(root, { all: flags.all === true });
        out.print(removed.length ? `Removed ${removed.length} plan${removed.length === 1 ? '' : 's'}: ${removed.join(', ')}` : 'Nothing to remove (only applied or stale plans are removed; --all removes every plan).');
        out.result({ removed });
        return 0;
      }
      throw new ToolError('bad_args', `Unknown command "plans ${sub}".`, 'Usage: codz plans [list] | show <plan-id> | clean [--all]');
    }
    case 'doctor': {
      const only = (args.multi.only ?? []).flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean);
      const bad = only.find((o) => !['locales', 'api', 'urls', 'models'].includes(o));
      if (bad) throw new ToolError('bad_args', `Unknown check "${bad}".`, 'Checks: locales, api, urls, models');
      if (flags.fix === true) {
        const fx = await planDoctorFix(root, adapter, { only });
        return handleChange(root, out, flags, fx.changeSet, adapter);
      }
      const r = await runDoctor(root, adapter, { only });
      out.print(renderDoctor(r, out.color));
      out.result({ findings: r.findings, counts: r.counts });
      return r.counts.error || (flags.strict === true && r.counts.warning) ? 1 : 0;
    }
    case 'check': {
      // CI gate: the config file is valid and doctor finds no errors or warnings (fresh scan).
      let configErrors = 0;
      let configIssues: unknown[] = [];
      if (loadConfig(root).exists) {
        const c = configCheck(root);
        configIssues = c.issues;
        configErrors = c.issues.filter((i) => i.level === 'error').length;
        for (const i of c.issues) out.print(`${i.level === 'error' ? '✗' : '!'} ${c.file}: ${i.key ? `${i.key}: ` : ''}${i.message}`);
      }
      const r = await runDoctor(root, adapter, {});
      out.print(renderDoctor(r, out.color));
      const failed = configErrors > 0 || r.counts.error > 0 || r.counts.warning > 0;
      out.print(failed ? 'check failed' : 'check passed');
      out.result({ passed: !failed, config: configIssues, findings: r.findings, counts: r.counts });
      return failed ? 1 : 0;
    }
    case 'templates': {
      if (sub === 'init') return handleChange(root, out, flags, planTemplatesInit(root, positional.slice(2)), adapter);
      if (sub && sub !== 'list') throw new ToolError('bad_args', `Unknown command "templates ${sub}".`, 'Usage: codz templates list | templates init [id...]');
      const l = listTemplates(root);
      out.print(`Templates in ${l.folder}:`);
      for (const t of l.templates) out.print(`  ${t.custom ? '✓' : ' '} ${t.id.padEnd(18)} ${t.about}`);
      out.print(`\nStart one with: codz templates init <id>   (placeholders are listed in the file's summary)`);
      out.result({ ...l });
      return 0;
    }
    case 'test': {
      if (sub !== 'add') throw new ToolError('bad_args', `Unknown command "test ${sub ?? ''}".`, 'Usage: codz test add <endpoint>... | --all');
      const cs = await planTestAdd(root, adapter, { endpoints: positional.slice(2), all: flags.all === true });
      return handleChange(root, out, flags, cs, adapter);
    }
    case 'screen': {
      if (sub !== 'add') throw new ToolError('bad_args', `Unknown command "screen ${sub ?? ''}".`, 'Usage: codz screen add <name> --api <endpoint> [--path /orders/:id]');
      const name = positional[2];
      if (!name) throw new ToolError('bad_args', 'Which screen? Usage: codz screen add <name> --api <endpoint> [--path /orders/:id]');
      const cs = await planScreenAdd(root, adapter, { name, api: args.multi.api?.[0], path: typeof flags.path === 'string' ? flags.path : undefined, initial: flags.initial === true, form: flags.form === true });
      return handleChange(root, out, flags, cs, adapter);
    }
    case 'route': {
      if (sub !== 'add') throw new ToolError('bad_args', `Unknown command "route ${sub ?? ''}".`, 'Usage: codz route add <name> [--path /orders/:id]');
      const name = positional[2];
      if (!name) throw new ToolError('bad_args', 'Which route? Usage: codz route add <name> [--path /orders/:id]');
      const cs = await planRouteAdd(root, adapter, { name, path: typeof flags.path === 'string' ? flags.path : undefined, initial: flags.initial === true });
      return handleChange(root, out, flags, cs, adapter);
    }
    case 'theme': {
      if (sub !== 'set') throw new ToolError('bad_args', `Unknown command "theme ${sub ?? ''}".`, 'Usage: codz theme set primary "#6750A4" radius 12 font Inter');
      const rest = positional.slice(2);
      const tokens: { name: string; value: string }[] = [];
      for (const r of rest) {
        const eq = r.indexOf('=');
        if (eq > 0) tokens.push({ name: r.slice(0, eq), value: r.slice(eq + 1) });
        else if (tokens.length && tokens[tokens.length - 1].value === '') tokens[tokens.length - 1].value = r;
        else tokens.push({ name: r, value: '' });
      }
      const missing = tokens.find((t) => !t.value);
      if (!tokens.length || missing) throw new ToolError('bad_args', missing ? `${missing.name} needs a value.` : 'Usage: codz theme set <name> <value>', 'Example: codz theme set primary "#6750A4" radius 12 font Inter');
      const cs = await planThemeSet(root, adapter, tokens);
      return handleChange(root, out, flags, cs, adapter);
    }
    case 'feature': {
      if (sub !== 'add') throw new ToolError('bad_args', `Unknown command "feature ${sub ?? ''}".`, 'Usage: codz feature add <name> --spec <file> | --api <endpoint>...');
      const name = positional[2];
      if (!name) throw new ToolError('bad_args', 'Which feature? Usage: codz feature add <name> --spec <openapi.yaml>', 'Example: codz feature add orders --spec api.yaml');
      const split = (xs?: (string | boolean | undefined)[]) => xs?.flatMap((x) => (typeof x === 'string' ? x.split(',') : [])).map((x) => x.trim()).filter(Boolean) ?? [];
      const r = await planFeatureAdd(root, adapter, {
        name,
        spec: typeof flags.spec === 'string' ? flags.spec : undefined,
        tags: split(args.multi.tag),
        paths: split([flags.path]),
        apis: args.multi.api,
        baseUrl: typeof flags['base-url'] === 'string' ? flags['base-url'] : undefined,
        initial: flags.initial === true,
        forms: flags['no-forms'] !== true,
        tests: flags['no-tests'] !== true,
        skipConflicts: flags['skip-conflicts'] === true,
        architecture: typeof flags.architecture === 'string' ? flags.architecture : undefined,
      });
      if (!r.setup) return handleChange(root, out, flags, r.changeSet, adapter);
      const setupDone = r.setup;
      return handleChange(root, out, flags, r.changeSet, adapter, {
        // The new packages are installed after apply, so the analyzer would fail on their imports.
        verify: false,
        afterApply: () => {
          if (setupDone.dependenciesChanged && flags['no-install'] === true) out.warn('Dependencies were added; install them yourself (npm install, flutter pub get or a Gradle sync).');
          return { installed: setupDone.dependenciesChanged && flags['no-install'] !== true ? installDependencies(root, adapter, out) : undefined };
        },
      });
    }
    case 'auth': {
      if (sub !== 'add') throw new ToolError('bad_args', `Unknown command "auth ${sub ?? ''}".`, 'Usage: codz auth add [--login-path /auth/login] [--me-path /auth/me]');
      const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined);
      const r = await planAuthAdd(root, adapter, {
        loginPath: str('login-path'),
        mePath: str('me-path'),
        logoutPath: str('logout-path'),
        refreshPath: str('refresh-path'),
        tokenField: str('token-field'),
        refreshField: str('refresh-field'),
        publicPaths: args.multi.public,
      });
      return handleChange(root, out, flags, r.changeSet, adapter);
    }
    case 'module': {
      if (sub !== 'add') throw new ToolError('bad_args', `Unknown command "module ${sub ?? ''}".`, 'Did you mean: codz module add <name>');
      const name = positional[2];
      if (!name) throw new ToolError('bad_args', 'Which module? Usage: codz module add <name>');
      const cs = await planModuleAdd(root, adapter, { name, initial: flags.initial === true, apis: args.multi.api, noLoad: flags['no-load'] === true });
      return handleChange(root, out, flags, cs, adapter);
    }
    case 'api': {
      if (sub === 'list') {
        const rows = await apiList(root, adapter, { filter: positional[2] });
        if (!rows.length) out.print(positional[2] ? `No endpoints match "${positional[2]}".` : 'No endpoints found yet. Add one with: codz api add');
        const w = Math.max(0, ...rows.map((r) => r.name.length));
        const pw = Math.max(0, ...rows.map((r) => r.path.length));
        for (const r of rows) out.print(`${r.method.padEnd(6)} ${r.path.padEnd(pw)}  ${r.name.padEnd(w)}  ${(r.response ?? '?').padEnd(14)}  ${r.file}${r.uses ? '' : '  (not called yet)'}`);
        out.result({ endpoints: rows });
        return 0;
      }
      if (sub === 'show') {
        const name = positional[2];
        if (!name) throw new ToolError('bad_args', 'Which endpoint? Usage: codz api show <name>', 'List them with: codz api list');
        const d = await apiShow(root, adapter, name);
        const e = d.endpoint;
        out.print(`${e.name}  ${e.method} ${e.path}`);
        out.print(`  declared   ${e.file}${d.declLine ? `:${d.declLine}` : ''}`);
        if (d.signature) out.print(`  signature  ${d.signature}`);
        out.print(`  returns    ${e.response ?? 'unknown'}`);
        for (const m of d.models) out.print(`  model      ${m.name} (${m.file}): ${m.fields.map((f) => `${f.name}${f.nullable ? '?' : ''}: ${f.type}`).join(', ')}`);
        if (!d.uses.length) out.print('  used by    nothing yet');
        for (const u of d.uses) out.print(`  used by    ${u.file}:${u.line}  ${u.text}`);
        out.result({ ...d });
        return 0;
      }
      if (sub === 'wire') {
        const endpoint = positional[2];
        const into = typeof flags.into === 'string' ? flags.into : positional[3];
        if (!endpoint || !into) throw new ToolError('bad_args', 'Usage: codz api wire <endpoint> --into <module>');
        const cs = await planApiWire(root, adapter, { endpoint, module: into, noLoad: flags['no-load'] === true });
        return handleChange(root, out, flags, cs, adapter);
      }
      if (sub === 'import') {
        const file = positional[2];
        if (!file) throw new ToolError('bad_args', 'Usage: codz api import <openapi.yaml|swagger.json|postman.json|file.har> [--tag t] [--only name] [--path /users/**] [--method GET] [--max n] [--list]');
        const split = (xs?: (string | boolean | undefined)[]) => xs?.flatMap((x) => (typeof x === 'string' ? x.split(',') : [])).map((x) => x.trim()).filter(Boolean) ?? [];
        const max = typeof flags.max === 'string' ? Number(flags.max) : undefined;
        if (max !== undefined && (!Number.isInteger(max) || max < 1)) throw new ToolError('bad_args', `--max needs a whole number, got "${flags.max}".`);
        const importOpts = {
          file,
          tags: split(args.multi.tag),
          only: split(args.multi.only),
          paths: split([flags.path]),
          methods: split([flags.method]),
          max,
          yes: flags.yes === true || flags.y === true,
          baseUrl: typeof flags['base-url'] === 'string' ? flags['base-url'] : undefined,
          includeErrors: flags['include-errors'] === true,
          skipConflicts: flags['skip-conflicts'] === true,
        };
        const bad = importOpts.methods.find((m) => !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m.toUpperCase()));
        if (bad) throw new ToolError('bad_method', `"${bad}" is not an HTTP method.`, 'Use GET, POST, PUT, PATCH or DELETE.');
        if (flags.list === true) {
          const l = listApiImport({ ...importOpts, file: existsSync(join(root, file)) ? join(root, file) : file });
          out.print(`${l.title}: ${l.operations.length} of ${l.total} operations`);
          const w = Math.max(0, ...l.operations.map((o) => o.path.length));
          for (const o of l.operations) out.print(`  ${o.method.padEnd(6)} ${o.path.padEnd(w)}  ${o.name}${o.response ? `  → ${o.response}` : ''}${o.tags.length ? `  [${o.tags.join(', ')}]` : ''}`);
          for (const wn of l.warnings) out.warn(wn);
          out.result({ ...l });
          return 0;
        }
        const showProgress = !out.json && process.stderr.isTTY === true;
        const r = await planApiImport(root, adapter, {
          ...importOpts,
          onProgress: showProgress
            ? (done, total, name) => {
                if (total < 10) return;
                process.stderr.write(done >= total ? '\r\x1b[K' : `\r\x1b[K  Planning ${done + 1}/${total}  ${name}`);
              }
            : undefined,
        });
        return handleChange(root, out, flags, r.changeSet, adapter);
      }
      if (sub === 'sync') {
        const file = positional[2];
        if (!file) throw new ToolError('bad_args', 'Usage: codz api sync <openapi.yaml|swagger.json|postman.json|file.har> [--add] [--remove] [--check] [--tag t] [--path /users/**]');
        const split = (xs?: (string | boolean | undefined)[]) => xs?.flatMap((x) => (typeof x === 'string' ? x.split(',') : [])).map((x) => x.trim()).filter(Boolean) ?? [];
        if (flags.check === true) setCacheWrites(false);
        const r = await planApiSync(root, adapter, {
          file,
          tags: split(args.multi.tag),
          paths: split([flags.path]),
          add: flags.add === true,
          remove: flags.remove === true,
          baseUrl: typeof flags['base-url'] === 'string' ? flags['base-url'] : undefined,
        });
        if (flags.check === true) {
          // CI: report drift without writing anything.
          // Endpoints only in the project may belong to another API, so they are reported but are not drift unless --remove was asked for.
          const drift = r.changeSet.changes.length > 0 || r.newInSpec.length > 0 || (flags.remove === true && r.missingFromSpec.length > 0);
          out.print(r.changeSet.summary.join('\n'));
          for (const w of r.changeSet.warnings) out.warn(w);
          if (drift) out.print(`\nOut of sync with ${file}. Run codz api sync ${file}${r.newInSpec.length ? ' --add' : ''} to update.`);
          out.result({ inSync: !drift, updated: r.updated, unchanged: r.unchanged, newInSpec: r.newInSpec, missingFromSpec: r.missingFromSpec, breaking: r.breaking, files: r.changeSet.changes.map((c) => c.path) });
          return drift ? 1 : 0;
        }
        return handleChange(root, out, flags, r.changeSet, adapter);
      }
      if (sub === 'update') {
        const name = positional[2];
        if (!name) throw new ToolError('bad_args', 'Usage: codz api update <endpoint> --sample <file.json>');
        const r = await planApiUpdate(root, adapter, name, args.multi.sample ?? [], { noUnwrap: flags['no-unwrap'] === true });
        return handleChange(root, out, flags, r.changeSet, adapter);
      }
      if (sub === 'remove') {
        const name = positional[2];
        if (!name) throw new ToolError('bad_args', 'Usage: codz api remove <endpoint>');
        return handleChange(root, out, flags, await planApiRemove(root, adapter, name), adapter);
      }
      if (sub === 'rename') {
        const [from, to] = [positional[2], positional[3]];
        if (!from || !to) throw new ToolError('bad_args', 'Usage: codz api rename <endpoint> <newName>');
        return handleChange(root, out, flags, await planApiRename(root, adapter, from, to), adapter);
      }
      if (sub !== 'add') throw new ToolError('bad_args', `Unknown command "api ${sub ?? ''}".`, 'Commands: api add, import, sync, update, remove, rename, wire, list, show');
      const opts: ApiAddOptions = {
        curl: typeof flags.curl === 'string' ? flags.curl : undefined,
        url: typeof flags.url === 'string' ? flags.url : positional[2],
        method: typeof flags.method === 'string' ? flags.method : undefined,
        samples: args.multi.sample,
        requestSample: typeof flags['request-sample'] === 'string' ? flags['request-sample'] : undefined,
        name: typeof flags.name === 'string' ? flags.name : undefined,
        path: typeof flags.path === 'string' ? flags.path : undefined,
        modelName: typeof flags['model-name'] === 'string' ? flags['model-name'] : undefined,
        noUnwrap: flags['no-unwrap'] === true,
        into: typeof flags.into === 'string' ? flags.into : undefined,
        noLoad: flags['no-load'] === true,
      };
      if (flags.clipboard === true && !opts.curl && !opts.url) opts.paste = readClipboard();
      if (!opts.curl && !opts.url && !opts.paste) {
        const piped = await readStdin();
        if (piped.trim()) opts.paste = piped;
        else if (process.stdin.isTTY && !out.json) opts.paste = await readPasteInteractive();
      }
      if (!loadConfig(root).exists) out.warn(`No ${CONFIG_FILE} yet; using detected conventions. Run codz init to review them.`);
      const { changeSet } = await planApiAdd(root, adapter, opts);
      return handleChange(root, out, flags, changeSet, adapter);
    }
    case 'apply': {
      if (!sub) throw new ToolError('bad_args', 'Which plan? Usage: codz apply <plan-id>');
      const cs = loadPlan(root, sub);
      const r = applyChangeSet(root, cs, { allowDirty: flags['allow-dirty'] === true, adapter, format: !flags['no-format'], verify: !flags['no-verify'] });
      printApplied(out, r);
      out.result({ applied: true, id: cs.id, ...r });
      return 0;
    }
    case 'undo': {
      if (typeof flags.to === 'string') {
        const rs = undoTo(root, flags.to, { force: flags.force === true });
        for (const r of rs) out.print(`Undid ${r.skill} (${r.id}): ${r.files.join(', ')}`);
        out.result({ undone: rs });
        return 0;
      }
      const last = [...readHistory(root)].reverse().find((e) => !e.undone);
      if (last?.skill === 'new') {
        // The project itself was made by codz new: undo removes the whole folder.
        const { undoNew } = await import('./starters/engine.ts');
        const r = undoNew(root, { force: flags.force === true });
        out.print(`Undid new (${r.id}): removed ${r.removed}`);
        out.result({ undone: { id: r.id, skill: 'new', removed: r.removed } });
        return 0;
      }
      const r = undoLast(root, { force: flags.force === true });
      out.print(`Undid ${r.skill} (${r.id}): ${r.files.join(', ')}`);
      out.result({ undone: r });
      return 0;
    }
    case 'history': {
      if (sub === 'show') {
        const id = positional[2];
        if (!id) throw new ToolError('bad_args', 'Which change? Usage: codz history show <id>', 'List them with: codz history');
        const d = historyShow(root, id);
        out.print(`${d.entry.id}  ${d.entry.skill}${d.entry.undone ? '  (undone)' : ''}`);
        for (const l of d.entry.summary) out.print(`  • ${l}`);
        for (const f of d.files) out.print(`  ${f.action.padEnd(8)} ${f.path}${f.state === 'as applied' ? '' : `  (${f.state})`}`);
        const diffs = d.files.map((f) => f.diff).filter(Boolean);
        if (diffs.length && !d.entry.undone) out.print('\n' + diffs.join('\n'));
        out.result({ ...d });
        return 0;
      }
      const h = readHistory(root);
      if (!h.length) out.print('No changes applied yet.');
      for (const e of h) out.print(`${e.id}  ${e.skill.padEnd(12)}${e.undone ? '  (undone)' : ''}  ${e.summary[0] ?? ''}`);
      if (h.length) out.print('\nDetails: codz history show <id>   Undo back to one: codz undo --to <id>');
      out.result({ history: h });
      return 0;
    }
    default:
      throw new ToolError('bad_args', `Unknown command "${cmd}".`, 'Run codz --help.');
  }
}
