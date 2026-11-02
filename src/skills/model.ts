// codz model <Name>: a model and its nested models from a JSON sample, with no
// endpoint. The adapter writes models exactly as it does for api add (same
// folder, naming, serialization style); only the model files are kept.

import { join, posix } from 'node:path';
import { loadMap } from '../core/cache.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { loadConfig } from '../core/config.ts';
import { exists } from '../core/fsutil.ts';
import { ToolError, type Adapter, type ChangeSet, type ProjectMap } from '../core/types.ts';
import { buildEndpoint } from '../input/endpoint.ts';
import { typeName } from '../input/naming.ts';

/** JSON from pasted text: tolerates a "response:" label, code fences, and text around one JSON value. */
export function parseJsonText(text: string, from: string): unknown {
  let t = text.trim().replace(/^```\w*\s*/, '').replace(/```\s*$/, '').replace(/^response\s*:\s*/i, '').trim();
  if (!t) throw new ToolError('no_sample', `${from} is empty.`, 'Copy the JSON (a response, or one object), then run this again.');
  try {
    return JSON.parse(t);
  } catch {
    const a = t.search(/[[{]/);
    const b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (a >= 0 && b > a) {
      t = t.slice(a, b + 1);
      try {
        return JSON.parse(t);
      } catch (e) {
        throw new ToolError('bad_sample', `${from} is not valid JSON: ${(e as Error).message}`);
      }
    }
    throw new ToolError('bad_sample', `${from} does not contain JSON.`, 'Copy a JSON object like {"id": 1, "name": "Lamp"}.');
  }
}

/** A --model-dir value: a folder inside the project, written with forward slashes. */
export function normalizeModelDir(dir: string, adapterId: string): string {
  const d = posix.normalize(dir.replace(/\\/g, '/')).replace(/^\.\//, '').replace(/\/+$/, '');
  if (!d || d === '.' || d.startsWith('../') || d === '..' || posix.isAbsolute(d) || /^[A-Za-z]:/.test(d)) throw new ToolError('bad_args', `--model-dir must be a folder inside the project, relative to it (got "${dir}").`, 'Example: --model-dir lib/features/orders/models');
  if (adapterId === 'flutter' && !d.startsWith('lib/')) throw new ToolError('bad_args', `Dart models must be under lib/ (got "${d}").`);
  if (adapterId === 'android' && !/\/(java|kotlin)\//.test(`/${d}/`)) throw new ToolError('bad_args', `Kotlin models must be in a source folder, like app/src/main/java/com/acme/app/feature/orders/model (got "${d}").`);
  return d;
}

export async function planModel(root: string, adapter: Adapter, name: string, sample: unknown, opts: { noUnwrap?: boolean; force?: boolean; split?: boolean } = {}): Promise<ChangeSet> {
  if (!adapter.planEndpoint) throw new ToolError('not_supported', `model needs a framework adapter; this project uses the ${adapter.id} adapter.`);
  if (!/^[A-Za-z][\w ]*$/.test(name)) throw new ToolError('bad_args', `"${name}" is not a model name.`, 'Example: codz model Order --from-clipboard');
  const { map } = await loadMap(root, adapter, loadConfig(root).conventions);
  const modelName = typeName(name);
  const suffix = adapter.id === 'flutter' ? map.conventions.modelClassSuffix ?? '' : '';
  const existing = map.models.find((m) => m.name === modelName || m.name === `${modelName}${suffix}`);
  if (existing && !opts.force) throw new ToolError('model_exists', `${existing.name} already exists (${existing.file}).`, `Add fields with codz field add ${existing.name} <name:type>, or pass --force to replace it from this JSON.`);
  // A stand-in GET endpoint carries the sample; its function is dropped below.
  const spec = buildEndpoint({ method: 'GET', url: new URL('https://api.invalid/codz-model-only'), responseSamples: [sample], name: 'codzModelOnly', modelName, unwrap: opts.noUnwrap ? 'never' : 'auto' });
  // The model is what is inside {"data": ...}; the stand-in endpoint returns it as is (Retrofit refuses envelopes).
  const unwrapped = spec.unwrapData;
  spec.unwrapData = false;
  spec.warnings = spec.warnings.filter((w) => !/wrapped in \{"data"/.test(w));
  if (!spec.models.length) throw new ToolError('bad_sample', 'The JSON has no object in it, so there is no model to write.', 'Copy an object like {"id": 1, "name": "Lamp"}, or a list of them.');
  // iOS writes methods into an APIClient extension and wants one to exist; the stand-in is dropped with the method.
  const overlay = adapter.id === 'ios' && !map.conventions.networkFile ? new Map([['codz-model-only/APIClient.swift', '']]) : undefined;
  const edits = await adapter.planEndpoint({ root, map: withoutEndpoint(map) }, spec, overlay, { replaceModels: opts.force });
  const keep = modelFiles(edits.models?.map((m) => m.file) ?? [], map, [...edits.files.keys()]);
  let files = new Map([...edits.files].filter(([f]) => keep.has(f)));
  if (!files.size) throw new ToolError('not_supported', 'codz could not tell which files hold the models; nothing was written.');
  // One file: the main model with its nested models below it (--split keeps one file each).
  const rootName = suffix && !modelName.endsWith(suffix) ? `${modelName}${suffix}` : modelName;
  const mainFile = edits.models?.find((m) => m.name === rootName)?.file ?? edits.models?.find((m) => m.name === modelName)?.file;
  if (!opts.split && mainFile && files.has(mainFile)) files = mergeModelFiles(root, files, mainFile, langOf(adapter.id));
  const names = spec.models.map((m) => (suffix && !m.name.endsWith(suffix) ? `${m.name}${suffix}` : m.name));
  const summary = [`Add model${names.length === 1 ? '' : 's'} ${names.join(', ')}`, ...[...files.keys()].map((f) => `  ${f}`)];
  const warnings = edits.warnings.filter((w) => !/codzModelOnly|codz_model_only|codz-model-only|build_runner|response type|base URL|api\.invalid|APIClient/i.test(w)).map((w) => w.replace(/^Response: /, '').replace(/^root\b/, modelName));
  if (unwrapped) warnings.unshift('The JSON is wrapped in {"data": ...}, so the model is the inner object. Use --no-unwrap for the whole JSON.');
  if (adapter.id === 'flutter' && [...files.values()].some((t) => /part\s+'[^']+\.(g|freezed)\.dart'/.test(t))) warnings.push('Run dart run build_runner build to generate the .g.dart / .freezed.dart files.');
  return buildChangeSet(root, 'model', { files, summary, warnings, generated: [], rewrites: opts.force ? [...files.keys()] : [] });
}

type MLang = 'ts' | 'dart' | 'kt' | 'swift';
const langOf = (id: string): MLang => (id === 'flutter' ? 'dart' : id === 'android' ? 'kt' : id === 'ios' ? 'swift' : 'ts');

/** The file's leading package/import/part lines, and the rest. */
function splitHeader(text: string, lang: MLang): { header: string[]; body: string } {
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

/**
 * Moves the new nested models into the main model's file: one file per JSON
 * sample. Only files this plan creates are merged; a model that already had a
 * file keeps it. Imports of the merged files go, and a models index stops
 * exporting them.
 */
function mergeModelFiles(root: string, files: Map<string, string>, mainFile: string, lang: MLang): Map<string, string> {
  const ext = posix.extname(mainFile);
  const isModel = (f: string) => posix.extname(f) === ext && !/(^|\/)index\.ts$/.test(f) && f !== mainFile;
  const merged = [...files.keys()].filter((f) => isModel(f) && !exists(join(root, f)));
  if (!merged.length) return files;
  const stem = (f: string) => posix.basename(f).replace(/\.[^.]+$/, '');
  const stems = new Set(merged.map(stem));
  const refersToMerged = (l: string) => {
    const m = /['"]([^'"]+)['"]/.exec(l);
    return !!m && stems.has(posix.basename(m[1]).replace(/\.(dart|ts|tsx|js)$/, '').replace(/\.(g|freezed)$/, ''));
  };
  const main = splitHeader(files.get(mainFile)!, lang);
  const header = [...main.header];
  const bodies = [main.body];
  for (const f of merged) {
    const part = splitHeader(files.get(f)!, lang);
    for (const l of part.header) {
      if (/^(package|part)\s/.test(l) || header.includes(l)) continue;
      header.push(l);
    }
    bodies.push(part.body);
  }
  const keptHeader = header.filter((l) => !refersToMerged(l) || /^part\s/.test(l));
  // Group the header: package, then imports (sorted for Kotlin, as written otherwise), then part lines.
  const pkg = keptHeader.filter((l) => /^package\s/.test(l));
  let imports = keptHeader.filter((l) => /^(import|export|library)\s/.test(l));
  if (lang === 'kt') imports = [...new Set(imports)].sort();
  const parts = keptHeader.filter((l) => /^part\s/.test(l));
  const head = [pkg, imports, parts].filter((g) => g.length).map((g) => g.join('\n')).join('\n\n');
  const out = new Map<string, string>();
  for (const [f, t] of files) {
    if (merged.includes(f)) continue;
    if (f === mainFile) out.set(f, `${head ? `${head}\n\n` : ''}${bodies.join('\n\n')}\n`);
    else if (/(^|\/)index\.ts$/.test(f)) out.set(f, t.split('\n').filter((l) => !refersToMerged(l)).join('\n'));
    else out.set(f, t);
  }
  return out;
}

function withoutEndpoint(map: ProjectMap): ProjectMap {
  return { ...map, endpoints: map.endpoints.filter((e) => e.name !== 'codzModelOnly') };
}

/** The model files of a plan: the files of its models, and anything else in the models folder (an index file). */
function modelFiles(modelFilesPlanned: string[], map: ProjectMap, changed: string[]): Set<string> {
  const c = map.conventions;
  const keep = new Set(modelFilesPlanned);
  for (const f of changed) {
    if (c.modelsFolder && f.startsWith(`${c.modelsFolder}/`)) keep.add(f);
    if (c.modelsFile && f === c.modelsFile) keep.add(f);
  }
  return keep;
}
