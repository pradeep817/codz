// Publishing starters (internal): check a template folder against the
// publishing gates, refresh its file list, pack it into a deterministic
// archive, and build and sign the catalog index. Used by scripts/starters.ts
// and by the tests' fake registry. Nothing here runs on a user's `codz new`.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToolError } from '../core/types.ts';
import { planNew } from './engine.ts';
import { resolveAnswers, type Manifest } from './manifest.ts';
import type { CatalogIndex, IndexTemplate } from './registry.ts';
import { sha256, signatureFile } from './sign.ts';
import { fromFolder } from './source.ts';
import { parseStrictJson } from './strictJson.ts';
import { writeTarGz } from './tar.ts';

/** Rewrites manifest.json's file list (paths, hashes, sizes, executable bits) from files/. */
export function refreshFileList(dir: string): number {
  const files: { path: string; sha256: string; size: number; mode?: '755' }[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, 'files', rel)).sort()) {
      const p = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, 'files', p));
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        const data = readFileSync(join(dir, 'files', p));
        files.push({ path: p, sha256: sha256(data), size: data.length, ...(st.mode & 0o111 ? { mode: '755' as const } : {}) });
      } else throw new ToolError('archive_unsafe', `files/${p} is a link or special file; templates hold regular files only.`);
    }
  };
  walk('');
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  m.files = files;
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  return files.length;
}

export interface CheckReport {
  id: string;
  version: string;
  errors: string[];
  warnings: string[];
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'a GitHub token'],
  [/\bsk_(live|test)_[A-Za-z0-9]{16,}\b/, 'a Stripe key'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
];

/** The static and determinism gates: everything that can be checked without an SDK. */
export function checkTemplate(dir: string, codzVersion: string): CheckReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const t = fromFolder(dir); // manifest schema, paths, hashes, links
  const m = t.manifest;
  const keys = new Set(m.answers.flatMap((a) => (a.type === 'reverse-domain' ? [a.key, `${a.key}.path`] : [a.key])));
  for (const [path, data] of t.files) {
    for (const k of [...path.matchAll(/\{\{([^}]+)\}\}/g)].map((x) => x[1])) if (!keys.has(k)) errors.push(`${path}: the path uses {{${k}}}, which no answer fills in`);
    const text = data.includes(0) ? '' : data.toString('utf8');
    for (const [re, what] of SECRET_PATTERNS) if (re.test(text)) errors.push(`${path}: looks like it contains ${what}`);
    for (const k of new Set([...text.matchAll(/\{\{([a-zA-Z][a-zA-Z0-9]*(?:\.path)?)\}\}/g)].map((x) => x[1]))) if (!keys.has(k)) warnings.push(`${path}: {{${k}}} is not an answer, so it is left as written`);
  }
  if (!t.license.trim()) errors.push('LICENSE is empty');
  if (!m.extras?.length) warnings.push('No "extras": the catalog page will not say what this starter adds beyond codz create');
  if (!m.tested) warnings.push('No "tested" block: fill it from the CI matrix results');
  if (!Object.keys(m.expectedConventions ?? {}).length) errors.push('No expectedConventions: the init contract test has nothing to check');
  // Determinism: the same answers give the same files.
  const answers = resolveAnswers(m, {});
  const plan = () => planNew(t, answers, '/tmp/codz-check', codzVersion, null, { steps: true });
  const a = plan();
  const b = plan();
  const digest = (p: typeof a) => sha256(Buffer.concat(p.files.flatMap((f) => [Buffer.from(`${f.path}\0${f.mode}\0`), f.data])));
  if (digest(a) !== digest(b)) errors.push('Two builds with the same answers differ');
  return { id: m.id, version: m.version, errors, warnings };
}

/** Packs a checked template folder: <out>/v1/templates/<id>/<version>/{archive.tar.gz, manifest.json}. */
export function packTemplate(dir: string, out: string): { id: string; version: string; archiveSha256: string; manifestSha256: string; archive: string } {
  const t = fromFolder(dir);
  const m: Manifest = t.manifest;
  const entries = new Map<string, Buffer>([
    ['manifest.json', t.manifestBytes],
    ['LICENSE', Buffer.from(t.license)],
  ]);
  const exec = new Set<string>();
  for (const f of m.files) {
    entries.set(`files/${f.path}`, t.files.get(f.path)!);
    if (f.mode === '755') exec.add(`files/${f.path}`);
  }
  const gz = writeTarGz(entries, exec);
  const dest = join(out, 'v1', 'templates', m.id, m.version);
  mkdirSync(dest, { recursive: true });
  const archive = join(dest, 'archive.tar.gz');
  if (existsSync(archive) && sha256(readFileSync(archive)) !== sha256(gz)) throw new ToolError('version_exists', `${m.id} ${m.version} is already published with different contents.`, 'A published version never changes: raise the version number.');
  writeFileSync(archive, gz);
  writeFileSync(join(dest, 'manifest.json'), t.manifestBytes);
  return { id: m.id, version: m.version, archiveSha256: sha256(gz), manifestSha256: sha256(t.manifestBytes), archive };
}

export interface CatalogFile {
  templates: { id: string; title?: string; summary?: string; tier: 'free' | 'paid'; price?: string; yanked?: string[]; needsUpdate?: string[] }[];
  revoked?: { id: string; version: string; reason?: string; use?: string }[];
}

/** Builds v1/index.json from the packed versions and catalog.json, with seq + 1, and signs it. */
export function buildIndex(root: string, privatePems: string[], opts: { days?: number; now?: Date; timestampKeys?: string[] } = {}): CatalogIndex {
  const catalog = parseStrictJson(readFileSync(join(root, 'catalog.json'), 'utf8'), 'catalog.json') as CatalogFile;
  const prevPath = join(root, 'v1', 'index.json');
  const prevSeq = existsSync(prevPath) ? (JSON.parse(readFileSync(prevPath, 'utf8')) as CatalogIndex).seq : 0;
  const now = opts.now ?? new Date();
  const templates: IndexTemplate[] = [];
  for (const c of catalog.templates) {
    const base = join(root, 'v1', 'templates', c.id);
    if (!existsSync(base)) throw new ToolError('template_not_found', `catalog.json lists ${c.id}, but nothing is packed for it.`);
    const versions = readdirSync(base).filter((v) => statSync(join(base, v)).isDirectory()).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    let latestManifest: Manifest | null = null;
    const vs = versions.map((v) => {
      const archive = readFileSync(join(base, v, 'archive.tar.gz'));
      const manifestBytes = readFileSync(join(base, v, 'manifest.json'));
      const m = JSON.parse(manifestBytes.toString('utf8')) as Manifest;
      if (!c.yanked?.includes(v)) latestManifest = m;
      return { version: v, archive: { sha256: sha256(archive), size: archive.length }, manifest: { sha256: sha256(manifestBytes) }, tested: m.tested as Record<string, unknown> | undefined, ...(c.yanked?.includes(v) ? { yanked: true } : {}), ...(c.needsUpdate?.includes(v) ? { needsUpdate: true } : {}) };
    });
    const lm = (latestManifest ?? JSON.parse(readFileSync(join(base, versions[versions.length - 1], 'manifest.json'), 'utf8'))) as Manifest;
    templates.push({ id: c.id, title: c.title ?? lm.title, summary: c.summary ?? lm.summary, framework: lm.framework, tier: c.tier, price: c.price, provides: lm.provides, apiAdd: lm.apiAdd.supported, extras: lm.extras, latest: lm.version, versions: vs });
  }
  const index: CatalogIndex = { schema: 1, seq: prevSeq + 1, issued: now.toISOString(), expires: new Date(now.getTime() + (opts.days ?? 7) * 86_400_000).toISOString(), templates, revoked: catalog.revoked ?? [], ...(opts.timestampKeys?.length ? { timestampKeys: opts.timestampKeys } : {}) };
  const bytes = Buffer.from(JSON.stringify(index, null, 2) + '\n');
  mkdirSync(join(root, 'v1'), { recursive: true });
  writeFileSync(prevPath, bytes);
  writeFileSync(`${prevPath}.sig`, signatureFile(bytes, privatePems));
  return index;
}

/**
 * Signs v1/timestamp.json for the current v1/index.json with an online key: "this index
 * is current until <expires>". The store does this every few hours; this is the same
 * thing for a cron job or a static host.
 */
export function signTimestamp(root: string, privatePem: string, opts: { hours?: number; now?: Date } = {}): { seq: number; expires: string } {
  const bytes = readFileSync(join(root, 'v1', 'index.json'));
  const index = JSON.parse(bytes.toString('utf8')) as CatalogIndex;
  const now = opts.now ?? new Date();
  const ts = { schema: 1, index_sha256: sha256(bytes), seq: index.seq, issued: now.toISOString(), expires: new Date(now.getTime() + (opts.hours ?? 48) * 3_600_000).toISOString() };
  const out = Buffer.from(JSON.stringify(ts, null, 2) + '\n');
  writeFileSync(join(root, 'v1', 'timestamp.json'), out);
  writeFileSync(join(root, 'v1', 'timestamp.json.sig'), signatureFile(out, [privatePem]));
  return { seq: index.seq, expires: ts.expires };
}
