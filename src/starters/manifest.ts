// The starter manifest: what a template is, what it asks, which allowlisted
// steps it needs and the hash of every file. It is data only; nothing in it is
// ever run. Unknown top-level fields are refused so a newer, stricter format
// cannot be half-understood by an older devtool.

import { ToolError } from '../core/types.ts';
import { parseStrictJson } from './strictJson.ts';
import { checkCollisions, checkRelPath, LIMITS } from './paths.ts';

export const SCHEMA = 1;

export type Framework = 'flutter' | 'nextjs' | 'react-native' | 'android';
export type StepId = 'flutter_create' | 'flutter_pub_get' | 'dart_format' | 'npm_install';
export type AnswerType = 'identifier' | 'npm-name' | 'reverse-domain' | 'string' | 'choice' | 'boolean';

/** Which steps each framework may use. Nothing outside this table can ever run. */
export const STEP_ALLOWLIST: Record<StepId, { frameworks: Framework[]; when: 'before-move' | 'after-move'; label: string }> = {
  flutter_create: { frameworks: ['flutter'], when: 'before-move', label: 'flutter create (the platform folders)' },
  flutter_pub_get: { frameworks: ['flutter'], when: 'after-move', label: 'flutter pub get' },
  dart_format: { frameworks: ['flutter'], when: 'after-move', label: 'dart format .' },
  npm_install: { frameworks: ['nextjs', 'react-native'], when: 'after-move', label: 'npm install --ignore-scripts (no package install scripts run)' },
};

export interface AnswerSpec {
  key: string;
  prompt: string;
  type: AnswerType;
  default?: string | boolean;
  choices?: string[];
  maxLength?: number;
}

export interface FileEntry {
  path: string;
  sha256: string;
  size: number;
  /** '755' for files that must be executable (gradlew); everything else is 644. */
  mode?: '644' | '755';
}

export interface Manifest {
  schema: number;
  id: string;
  version: string;
  title: string;
  summary?: string;
  framework: Framework;
  mode: 'overlay' | 'full';
  requires: { devtool?: string; flutter?: string; node?: string };
  tested?: { flutter?: string[]; node?: string[]; date?: string };
  provides?: Record<string, string>;
  /** What this starter gives beyond `devtool create`, for the catalog page and `starters show`. */
  extras?: string[];
  apiAdd: { supported: boolean; note?: string };
  answers: AnswerSpec[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  steps: StepId[];
  expectedConventions?: Record<string, string>;
  files: FileEntry[];
  license: { kind: string; file: 'LICENSE' };
}

const TOP_KEYS = new Set(['schema', 'id', 'version', 'title', 'summary', 'framework', 'mode', 'requires', 'tested', 'provides', 'extras', 'apiAdd', 'answers', 'dependencies', 'devDependencies', 'steps', 'expectedConventions', 'files', 'license']);
export const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
export const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9]*$/;
const PKG_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const RANGE_PART = /^(\^|~|>=|<=|>|<|=)?\d+(\.\d+){0,2}$/;

const bad = (msg: string): never => {
  throw new ToolError('bad_template', `The manifest is not valid: ${msg}.`, 'Report it; the template is not usable as published.');
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, name: string, max = 200): string => {
  if (typeof v !== 'string' || !v || v.length > max) bad(`${name} must be text of 1-${max} characters`);
  return v as string;
};
const strMap = (v: unknown, name: string, keyRe: RegExp, max = 100): Record<string, string> => {
  if (v === undefined) return {};
  if (!isObj(v)) bad(`${name} must be an object`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as object)) {
    if (!keyRe.test(k)) bad(`${name} has a bad key "${k.slice(0, 60)}"`);
    out[k] = str(val, `${name}.${k}`, max);
  }
  return out;
};

export function parseManifest(text: string): Manifest {
  const raw = parseStrictJson(text, 'manifest.json', { maxBytes: 4 * 1024 * 1024, maxString: 4096 });
  if (!isObj(raw)) return bad('it must be a JSON object');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!TOP_KEYS.has(k)) bad(`unknown field "${k.slice(0, 60)}" (a newer devtool may be needed)`);
  if (o.schema !== SCHEMA) throw new ToolError('template_incompatible', `This template uses manifest schema ${String(o.schema)}; this devtool reads schema ${SCHEMA}.`, 'Update devtool, or pick an older version of the template.');
  const id = str(o.id, 'id', 64);
  if (!ID_RE.test(id)) bad('id must be lowercase letters, digits and dashes');
  const version = str(o.version, 'version', 32);
  if (!VERSION_RE.test(version)) bad('version must be x.y.z');
  const framework = o.framework as Framework;
  if (!['flutter', 'nextjs', 'react-native', 'android'].includes(framework)) bad('framework must be flutter, nextjs, react-native or android');
  const mode = o.mode as Manifest['mode'];
  if (mode !== 'overlay' && mode !== 'full') bad('mode must be overlay or full');
  if (mode === 'overlay' && framework !== 'flutter') bad('overlay mode is only for Flutter (on flutter create)');

  if (!isObj(o.requires)) bad('requires must be an object');
  const requires = strMap(o.requires, 'requires', /^(devtool|flutter|node)$/);
  for (const [k, r] of Object.entries(requires)) if (!r.split(/\s+/).every((p) => RANGE_PART.test(p))) bad(`requires.${k} is not a version range`);

  let tested: Manifest['tested'];
  if (o.tested !== undefined) {
    if (!isObj(o.tested)) bad('tested must be an object');
    const t = o.tested as Record<string, unknown>;
    for (const k of Object.keys(t)) if (!['flutter', 'node', 'date'].includes(k)) bad(`tested has unknown field "${k.slice(0, 40)}"`);
    const list = (v: unknown, n: string) => {
      if (v === undefined) return undefined;
      if (!Array.isArray(v) || v.length > 20) bad(`tested.${n} must be a short list`);
      return (v as unknown[]).map((x) => str(x, `tested.${n}`, 20));
    };
    tested = { flutter: list(t.flutter, 'flutter'), node: list(t.node, 'node'), date: t.date === undefined ? undefined : str(t.date, 'tested.date', 10) };
  }

  if (!isObj(o.apiAdd) || typeof (o.apiAdd as Record<string, unknown>).supported !== 'boolean') bad('apiAdd.supported must be true or false');
  const apiAddRaw = o.apiAdd as Record<string, unknown>;
  const apiAdd = { supported: apiAddRaw.supported as boolean, note: apiAddRaw.note === undefined ? undefined : str(apiAddRaw.note, 'apiAdd.note', 300) };

  if (!Array.isArray(o.answers) || o.answers.length > 20) bad('answers must be a list of at most 20 questions');
  const answers: AnswerSpec[] = (o.answers as unknown[]).map((a, n) => {
    if (!isObj(a)) return bad(`answers[${n}] must be an object`);
    const r = a as Record<string, unknown>;
    for (const k of Object.keys(r)) if (!['key', 'prompt', 'type', 'default', 'choices', 'maxLength'].includes(k)) bad(`answers[${n}] has unknown field "${k.slice(0, 40)}"`);
    const key = str(r.key, `answers[${n}].key`, 40);
    if (!KEY_RE.test(key)) bad(`answers[${n}].key must be letters and digits`);
    const type = r.type as AnswerType;
    if (!['identifier', 'npm-name', 'reverse-domain', 'string', 'choice', 'boolean'].includes(type)) bad(`answers[${n}].type is not a known answer type`);
    const choices = r.choices === undefined ? undefined : Array.isArray(r.choices) && r.choices.length && r.choices.length <= 30 ? (r.choices as unknown[]).map((c) => str(c, `answers[${n}].choices`, 60)) : bad(`answers[${n}].choices must be a short list`);
    if (type === 'choice' && !choices) bad(`answers[${n}] is a choice without choices`);
    const def = r.default;
    if (def !== undefined && typeof def !== 'string' && typeof def !== 'boolean') bad(`answers[${n}].default must be text or true/false`);
    const maxLength = r.maxLength === undefined ? undefined : typeof r.maxLength === 'number' && r.maxLength > 0 && r.maxLength <= 500 ? r.maxLength : bad(`answers[${n}].maxLength must be 1-500`);
    return { key, prompt: str(r.prompt, `answers[${n}].prompt`, 120), type, default: def as string | boolean | undefined, choices, maxLength };
  });
  if (new Set(answers.map((a) => a.key)).size !== answers.length) bad('two answers use the same key');
  const appName = answers.find((a) => a.key === 'appName');
  if (!appName) bad('it needs an appName answer');
  if (framework === 'flutter' && appName!.type !== 'identifier') bad('a Flutter appName must be an identifier answer');
  if (mode === 'overlay' && answers.find((a) => a.key === 'org')?.type !== 'reverse-domain') bad('overlay mode needs an org answer of type reverse-domain (for flutter create --org)');

  if (!Array.isArray(o.steps)) bad('steps must be a list');
  const steps = (o.steps as unknown[]).map((s) => {
    if (typeof s !== 'string' || !(s in STEP_ALLOWLIST)) bad(`step "${String(s).slice(0, 40)}" is not on devtool's allowlist (${Object.keys(STEP_ALLOWLIST).join(', ')})`);
    if (!STEP_ALLOWLIST[s as StepId].frameworks.includes(framework)) bad(`step ${s} is not allowed for ${framework}`);
    return s as StepId;
  });
  if (new Set(steps).size !== steps.length) bad('a step is listed twice');
  if (mode === 'overlay' && !steps.includes('flutter_create')) bad('overlay mode needs the flutter_create step');

  if (!Array.isArray(o.files) || !o.files.length || o.files.length > LIMITS.entries) bad(`files must list 1-${LIMITS.entries} files`);
  const files: FileEntry[] = (o.files as unknown[]).map((f, n) => {
    if (!isObj(f)) return bad(`files[${n}] must be an object`);
    const r = f as Record<string, unknown>;
    for (const k of Object.keys(r)) if (!['path', 'sha256', 'size', 'mode'].includes(k)) bad(`files[${n}] has unknown field "${k.slice(0, 40)}"`);
    const path = checkRelPath(str(r.path, `files[${n}].path`, LIMITS.pathLength), 'manifest');
    const sha256 = str(r.sha256, `files[${n}].sha256`, 64);
    if (!/^[0-9a-f]{64}$/.test(sha256)) bad(`files[${n}].sha256 must be 64 lowercase hex characters`);
    if (typeof r.size !== 'number' || !Number.isInteger(r.size) || r.size < 0 || r.size > LIMITS.fileBytes) bad(`files[${n}].size is not a valid size`);
    if (r.mode !== undefined && r.mode !== '644' && r.mode !== '755') bad(`files[${n}].mode must be "644" or "755"`);
    return { path, sha256, size: r.size as number, mode: r.mode as FileEntry['mode'] };
  });
  checkCollisions(files.map((f) => f.path), 'manifest');
  if (files.reduce((n, f) => n + f.size, 0) > LIMITS.expandedBytes) throw new ToolError('archive_too_large', 'The template is larger than the safety limit.', 'Report it; nothing was written.');

  if (!isObj(o.license)) bad('license must be an object');
  const lic = o.license as Record<string, unknown>;
  if (lic.file !== 'LICENSE') bad('license.file must be "LICENSE"');
  const license = { kind: str(lic.kind, 'license.kind', 60), file: 'LICENSE' as const };

  const extras = o.extras === undefined ? undefined : Array.isArray(o.extras) && o.extras.length <= 30 ? (o.extras as unknown[]).map((e) => str(e, 'extras', 200)) : bad('extras must be a short list');

  return {
    schema: SCHEMA,
    id,
    version,
    title: str(o.title, 'title', 120),
    summary: o.summary === undefined ? undefined : str(o.summary, 'summary', 500),
    framework,
    mode,
    requires,
    tested,
    provides: strMap(o.provides, 'provides', /^[a-zA-Z]+$/, 60),
    extras,
    apiAdd,
    answers,
    dependencies: strMap(o.dependencies, 'dependencies', PKG_RE, 100),
    devDependencies: strMap(o.devDependencies, 'devDependencies', PKG_RE, 100),
    steps,
    expectedConventions: strMap(o.expectedConventions, 'expectedConventions', /^[a-zA-Z]+$/, 200),
    files,
    license,
  };
}

// ---------- Versions ----------

const parts = (v: string) => v.split('.').map((x) => Number(x));

export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** ">=3.24 <4.0", "^1.2.0", "~2.1", "=1.0.0": every part must hold. */
export function satisfies(version: string, range: string): boolean {
  const v = version.replace(/^v/, '').split(/[-+]/)[0];
  return range.trim().split(/\s+/).every((p) => {
    const m = /^(\^|~|>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/.exec(p);
    if (!m) return false;
    const [, op = '=', target] = m;
    const c = compareVersions(v, target);
    const t = parts(target);
    switch (op) {
      case '>=':
        return c >= 0;
      case '<=':
        return c <= 0;
      case '>':
        return c > 0;
      case '<':
        return c < 0;
      case '^':
        return c >= 0 && (t[0] > 0 ? parts(v)[0] === t[0] : parts(v)[1] === (t[1] ?? 0));
      case '~':
        return c >= 0 && parts(v)[0] === t[0] && parts(v)[1] === (t[1] ?? 0);
      default:
        return c === 0 || (t.length < 3 && parts(v).slice(0, t.length).join('.') === t.join('.'));
    }
  });
}

// ---------- Answers ----------

export type Answers = Record<string, string | boolean>;

export function checkAnswer(spec: AnswerSpec, value: string | boolean): string | null {
  if (spec.type === 'boolean') return typeof value === 'boolean' ? null : 'Use true or false.';
  if (typeof value !== 'string') return 'Use text.';
  const max = spec.maxLength ?? (spec.type === 'string' ? 100 : 64);
  if (value.length > max) return `Use at most ${max} characters.`;
  switch (spec.type) {
    case 'identifier':
      return /^[a-z][a-z0-9_]*$/.test(value) ? null : 'Use lowercase letters, digits and _, starting with a letter (for example shop_app).';
    case 'npm-name':
      return /^[a-z][a-z0-9-_]*$/.test(value) ? null : 'Use lowercase letters, digits, - and _, starting with a letter (for example shop-app).';
    case 'reverse-domain':
      return /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(value) ? null : 'Use reverse-domain form, for example com.acme.';
    case 'choice':
      return spec.choices!.includes(value) ? null : `Choose one of: ${spec.choices!.join(', ')}.`;
    case 'string':
      // Printable text only: no control characters, no placeholder braces, no backticks or $ (they mean something in code).
      // eslint-disable-next-line no-control-regex
      return value && !/[\u0000-\u001f\u007f{}`$\\"'<>]/.test(value) ? null : 'Use plain printable text without quotes, braces, angle brackets, backticks, $ or backslashes.';
  }
  return 'Unknown answer type.';
}

/** Fills in defaults and validates every answer. `given` comes from --set and the name argument. */
export function resolveAnswers(m: Manifest, given: Record<string, string>): Answers {
  for (const k of Object.keys(given)) if (!m.answers.some((a) => a.key === k)) throw new ToolError('bad_answer', `This template has no question "${k}".`, `Its questions: ${m.answers.map((a) => a.key).join(', ')}`);
  const out: Answers = {};
  for (const a of m.answers) {
    let v: string | boolean | undefined = given[a.key] ?? a.default;
    if (a.type === 'boolean' && typeof v === 'string') v = v === 'true' ? true : v === 'false' ? false : v;
    if (v === undefined) throw new ToolError('bad_answer', `No value for "${a.key}" (${a.prompt}).`, `Pass --set ${a.key}=<value>.`);
    const problem = checkAnswer(a, v);
    if (problem) throw new ToolError('bad_answer', `The value for ${a.key} is not valid. ${problem}`, `Pass --set ${a.key}=<value>.`);
    out[a.key] = v;
  }
  return out;
}

/** Placeholder values: every answer as {{key}}, and each reverse-domain answer as a path too ({{org.path}} = com/acme). */
export function placeholderValues(m: Manifest, answers: Answers): Map<string, string> {
  const vals = new Map<string, string>();
  for (const a of m.answers) {
    const v = answers[a.key];
    vals.set(a.key, String(v));
    if (a.type === 'reverse-domain') vals.set(`${a.key}.path`, String(v).replace(/\./g, '/'));
  }
  return vals;
}
