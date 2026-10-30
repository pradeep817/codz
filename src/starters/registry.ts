// The catalog client: a signed index on a static host, public manifests,
// free archives as public files and paid archives through a short-lived
// download URL. Everything it returns has been checked against the signed
// index; the engine only ever receives a VerifiedTemplate.
//
// The index is refused when its signature fails, when its sequence number is
// lower than one this machine has seen (or equal with different contents), and
// when it has expired, so a mirror cannot replay or freeze an old catalog to
// hide a revocation. A revoked version is refused even from the cache.

import { ToolError } from '../core/types.ts';
import { auth } from './auth.ts';
import { readHomeFile, removeHome, writeHomeFile } from './home.ts';
import { apiError, checkUrl, request } from './http.ts';
import { compareVersions, ID_RE, parseManifest, VERSION_RE, type Manifest } from './manifest.ts';
import { LIMITS } from './paths.ts';
import { keyId, OFFICIAL_KEYS, sha256, verifySignature } from './sign.ts';
import { fromArchive, type VerifiedTemplate } from './source.ts';
import { parseStrictJson } from './strictJson.ts';

/** The official catalog. Empty until it is live; CODZ_REGISTRY points at another one (staging, tests). */
export const OFFICIAL_REGISTRY = { base: '', api: '' };

export interface RegistryConfig {
  base: URL;
  api: URL;
  keys: Record<string, string>;
  official: boolean;
}

export function registryConfig(): RegistryConfig {
  const env = process.env.CODZ_REGISTRY;
  if (env) {
    const keys: Record<string, string> = {};
    for (const k of (process.env.CODZ_REGISTRY_KEYS ?? '').split(',').map((x) => x.trim()).filter(Boolean)) keys[keyId(k)] = k;
    return { base: checkUrl(env, 'CODZ_REGISTRY'), api: checkUrl(process.env.CODZ_REGISTRY_API || env, 'CODZ_REGISTRY_API'), keys, official: false };
  }
  if (!OFFICIAL_REGISTRY.base) throw new ToolError('catalog_unavailable', 'The starter catalog is not online yet.', 'Use a template folder: codz new <name> --template ./my-starter');
  return { base: checkUrl(OFFICIAL_REGISTRY.base, 'registry'), api: checkUrl(OFFICIAL_REGISTRY.api || OFFICIAL_REGISTRY.base, 'registry API'), keys: OFFICIAL_KEYS, official: true };
}

const join = (base: URL, path: string) => new URL(path.replace(/^\//, ''), base.href.endsWith('/') ? base : new URL(`${base.href}/`));

// ---------- Index ----------

export interface IndexVersion {
  version: string;
  archive: { sha256: string; size: number };
  manifest: { sha256: string };
  tested?: Record<string, unknown>;
  yanked?: boolean;
  needsUpdate?: boolean;
}

export interface IndexTemplate {
  id: string;
  title: string;
  summary?: string;
  framework: string;
  tier: 'free' | 'paid';
  price?: string;
  provides?: Record<string, string>;
  apiAdd: boolean;
  extras?: string[];
  latest: string;
  versions: IndexVersion[];
}

export interface CatalogIndex {
  schema: number;
  seq: number;
  issued: string;
  expires: string;
  templates: IndexTemplate[];
  revoked: { id: string; version: string; reason?: string; use?: string }[];
  /**
   * Online keys (Ed25519, base64) that may sign v1/timestamp.json. When present, the
   * catalog's freshness comes from that short-lived file, re-signed by the server every
   * few hours, and the index itself (signed offline) can live for months.
   */
  timestampKeys?: string[];
}

/** v1/timestamp.json: "this exact index is still current", signed by an online key. */
export interface CatalogTimestamp {
  schema: 1;
  index_sha256: string;
  seq: number;
  issued: string;
  expires: string;
}

const badIndex = (why: string) => new ToolError('bad_template', `The catalog index is not valid: ${why}.`, 'Try again later; report it if it persists.');

export function parseIndex(text: string): CatalogIndex {
  const raw = parseStrictJson(text, 'the catalog index', { maxBytes: 8 * 1024 * 1024 }) as CatalogIndex;
  if (!raw || typeof raw !== 'object' || raw.schema !== 1) throw badIndex('unknown schema');
  if (!Number.isInteger(raw.seq) || raw.seq < 0) throw badIndex('bad sequence number');
  if (Number.isNaN(Date.parse(raw.issued)) || Number.isNaN(Date.parse(raw.expires))) throw badIndex('bad dates');
  if (!Array.isArray(raw.templates) || !Array.isArray(raw.revoked)) throw badIndex('missing lists');
  if (raw.timestampKeys !== undefined && (!Array.isArray(raw.timestampKeys) || raw.timestampKeys.length > 8 || !raw.timestampKeys.every((k) => typeof k === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(k)))) throw badIndex('bad timestamp keys');
  for (const t of raw.templates) {
    if (!ID_RE.test(t?.id ?? '') || typeof t.title !== 'string' || !Array.isArray(t.versions) || !VERSION_RE.test(t.latest ?? '')) throw badIndex(`a bad entry ${String(t?.id).slice(0, 40)}`);
    if (t.tier !== 'free' && t.tier !== 'paid') throw badIndex(`${t.id} has no price tier`);
    for (const v of t.versions) if (!VERSION_RE.test(v?.version ?? '') || !/^[0-9a-f]{64}$/.test(v.archive?.sha256 ?? '') || !/^[0-9a-f]{64}$/.test(v.manifest?.sha256 ?? '')) throw badIndex(`${t.id} has a bad version entry`);
  }
  return raw;
}

interface IndexState {
  seq: number;
  sha256: string;
  etag?: string;
  registry: string;
  /** The newest timestamp.json this machine has accepted (rollback protection). */
  tsIssued?: string;
}

export function parseTimestamp(text: string): CatalogTimestamp {
  const t = parseStrictJson(text, 'the catalog timestamp', { maxBytes: 16 * 1024 }) as CatalogTimestamp;
  if (!t || t.schema !== 1 || !/^[0-9a-f]{64}$/.test(t.index_sha256 ?? '') || !Number.isInteger(t.seq) || Number.isNaN(Date.parse(t.issued)) || Number.isNaN(Date.parse(t.expires))) throw badIndex('the timestamp file is not valid');
  return t;
}

/** Checks timestamp.json against the index it must pin. Returns it, or throws index_expired / index_rollback. */
function checkTimestamp(index: CatalogIndex, digest: string, tsBytes: Buffer, tsSig: Buffer, state: IndexState | undefined): CatalogTimestamp {
  const keys: Record<string, string> = {};
  for (const k of index.timestampKeys ?? []) keys[keyId(k)] = k;
  verifySignature(tsBytes, tsSig, keys, 'the catalog timestamp');
  const ts = parseTimestamp(tsBytes.toString('utf8'));
  if (ts.index_sha256 !== digest || ts.seq !== index.seq) throw new ToolError('index_expired', 'The catalog\'s freshness note is for a different catalog, so it may be out of date.', 'Retry in a minute; report it if it persists.');
  if (state?.tsIssued && Date.parse(ts.issued) < Date.parse(state.tsIssued) && state.sha256 === digest) throw new ToolError('index_rollback', 'The catalog\'s freshness note is older than one this machine has already seen.', 'Retry later; report it if it persists. Nothing was downloaded.');
  if (Date.parse(ts.expires) < Date.now()) throw new ToolError('index_expired', `The catalog has not been confirmed as current since ${ts.issued.slice(0, 16).replace('T', ' ')} UTC, so it may be hiding withdrawn versions.`, 'Retry later; report it if it persists.');
  return ts;
}

export interface LoadedIndex {
  index: CatalogIndex;
  warnings: string[];
  fromCache: boolean;
}

function stored(cfg: RegistryConfig): { bytes: Buffer; sig: Buffer; state: IndexState } | null {
  const bytes = readHomeFile('starters', 'index.json');
  const sig = readHomeFile('starters', 'index.json.sig');
  const st = readHomeFile('starters', 'state.json');
  if (!bytes || !sig || !st) return null;
  try {
    const state = JSON.parse(st.toString('utf8')) as IndexState;
    if (state.registry !== cfg.base.href) return null;
    return { bytes, sig, state };
  } catch {
    return null;
  }
}

export async function loadIndex(opts: { refresh?: boolean; cached?: boolean } = {}): Promise<LoadedIndex> {
  const cfg = registryConfig();
  const warnings: string[] = cfg.official ? [] : [`Using the catalog at ${cfg.base.host} from CODZ_REGISTRY, not the official one.`];
  const have = stored(cfg);
  if (opts.cached) {
    if (!have) throw new ToolError('offline_not_cached', 'There is no downloaded catalog on this machine.', 'Run once online, or use a template folder.');
    verifySignature(have.bytes, have.sig, cfg.keys, 'the catalog index');
    const index = parseIndex(have.bytes.toString('utf8'));
    let current = Date.parse(index.expires);
    if (index.timestampKeys?.length) {
      const tb = readHomeFile('starters', 'timestamp.json');
      const tsig = readHomeFile('starters', 'timestamp.json.sig');
      let ts: CatalogTimestamp | null = null;
      try {
        if (tb && tsig) {
          const keys: Record<string, string> = {};
          for (const k of index.timestampKeys) keys[keyId(k)] = k;
          verifySignature(tb, tsig, keys, 'the catalog timestamp');
          ts = parseTimestamp(tb.toString('utf8'));
        }
      } catch {
        ts = null;
      }
      current = Math.min(current, ts && ts.index_sha256 === sha256(have.bytes) ? Date.parse(ts.expires) : 0);
    }
    if (current < Date.now()) warnings.push('The downloaded catalog is no longer confirmed as current; withdrawals announced since then are not known on this machine.');
    return { index, warnings, fromCache: true };
  }
  const r = await request(join(cfg.base, 'v1/index.json'), { etag: !opts.refresh ? have?.state.etag : undefined, maxBytes: 8 * 1024 * 1024 });
  let bytes: Buffer;
  let sig: Buffer;
  if (r.status === 304 && have) {
    bytes = have.bytes;
    sig = have.sig;
  } else if (r.status === 200) {
    bytes = r.body;
    const s = await request(join(cfg.base, 'v1/index.json.sig'), { maxBytes: 16 * 1024 });
    if (s.status !== 200) throw apiError(s, { hadToken: false, what: 'the catalog signature' });
    sig = s.body;
  } else throw apiError(r, { hadToken: false, what: 'the catalog index' });

  verifySignature(bytes, sig, cfg.keys, 'the catalog index');
  const index = parseIndex(bytes.toString('utf8'));
  const digest = sha256(bytes);
  if (have) {
    if (index.seq < have.state.seq || (index.seq === have.state.seq && digest !== have.state.sha256)) {
      throw new ToolError('index_rollback', `The catalog (number ${index.seq}) is older than one this machine has already seen (number ${have.state.seq}).`, 'Retry later; report it if it persists. Nothing was downloaded.');
    }
  }
  if (Date.parse(index.expires) < Date.now()) throw new ToolError('index_expired', `The catalog expired on ${index.expires.slice(0, 10)}, so it may be hiding withdrawn versions.`, 'Retry later; report it if it persists.');
  // Two-key catalogs: the offline-signed index names online keys, and one of them confirms every few hours that this index is current.
  let ts: { bytes: Buffer; sig: Buffer; parsed: CatalogTimestamp } | null = null;
  if (index.timestampKeys?.length) {
    const t = await request(join(cfg.base, 'v1/timestamp.json'), { maxBytes: 16 * 1024 });
    const ts2 = await request(join(cfg.base, 'v1/timestamp.json.sig'), { maxBytes: 16 * 1024 });
    if (t.status !== 200 || ts2.status !== 200) throw new ToolError('index_expired', 'The catalog\'s freshness note is missing, so it may be out of date.', 'Retry later; report it if it persists.');
    ts = { bytes: t.body, sig: ts2.body, parsed: checkTimestamp(index, digest, t.body, ts2.body, have?.state) };
  }
  writeHomeFile(bytes, {}, 'starters', 'index.json');
  writeHomeFile(sig, {}, 'starters', 'index.json.sig');
  if (ts) {
    writeHomeFile(ts.bytes, {}, 'starters', 'timestamp.json');
    writeHomeFile(ts.sig, {}, 'starters', 'timestamp.json.sig');
  }
  writeHomeFile(JSON.stringify({ seq: index.seq, sha256: digest, etag: r.headers.get('etag') ?? undefined, registry: cfg.base.href, tsIssued: ts?.parsed.issued ?? (have?.state.sha256 === digest ? have?.state.tsIssued : undefined) } satisfies IndexState), {}, 'starters', 'state.json');
  return { index, warnings, fromCache: false };
}

// ---------- Resolving and downloading ----------

export function parseRef(ref: string): { id: string; version?: string } {
  const [id, version] = ref.split('@');
  if (!ID_RE.test(id ?? '') || (version !== undefined && !VERSION_RE.test(version))) throw new ToolError('bad_args', `"${ref.slice(0, 80)}" is not a starter id (use id or id@x.y.z), or a folder.`, 'List starters with: codz starters list');
  return { id, version };
}

export function resolveRef(index: CatalogIndex, ref: string): { template: IndexTemplate; version: IndexVersion; warnings: string[] } {
  const { id, version } = parseRef(ref);
  const t = index.templates.find((x) => x.id === id);
  if (!t) throw new ToolError('template_not_found', `No starter called ${id}.`, 'Check the id with codz starters list.');
  const want = version ?? t.latest;
  const v = t.versions.find((x) => x.version === want);
  if (!v) throw new ToolError('version_not_found', `No version ${want} of ${id}.`, `Versions: ${t.versions.map((x) => x.version).join(', ')}`);
  const revoked = index.revoked.find((x) => x.id === id && x.version === want);
  if (revoked) throw new ToolError('template_revoked', `${id} ${want} was withdrawn${revoked.reason ? `: ${revoked.reason}` : ''}.`, revoked.use ? `Use ${id}@${revoked.use}.` : `Use a newer version (latest: ${t.latest}).`);
  const warnings: string[] = [];
  if (v.yanked) warnings.push(`${id} ${want} was replaced by a newer version (latest: ${t.latest}).`);
  if (v.needsUpdate) warnings.push(`${id} ${want} is marked "needs update": it did not pass the latest SDK tests.`);
  return { template: t, version: v, warnings };
}

export function latestUsable(t: IndexTemplate, index: CatalogIndex): string {
  const ok = t.versions.filter((v) => !v.yanked && !index.revoked.some((r) => r.id === t.id && r.version === v.version)).map((v) => v.version);
  return ok.sort(compareVersions).pop() ?? t.latest;
}

/** The archive for one index entry, from the cache or the catalog, checked against the signed index. */
export async function fetchTemplate(index: CatalogIndex, t: IndexTemplate, v: IndexVersion, opts: { cached?: boolean } = {}): Promise<VerifiedTemplate> {
  const cfg = registryConfig();
  const cachePath = ['starters', 'cache', t.id, v.version, 'archive.tar.gz'] as const;
  let gz = readHomeFile(...cachePath);
  let origin = 'cache';
  if (gz && sha256(gz) !== v.archive.sha256) {
    removeHome('starters', 'cache', t.id, v.version);
    gz = null;
    if (opts.cached) throw new ToolError('checksum_mismatch', `The downloaded copy of ${t.id} ${v.version} does not match the catalog, so it was removed.`, 'Run again without --cached to download it again.');
  }
  if (!gz) {
    if (opts.cached) throw new ToolError('offline_not_cached', `${t.id} ${v.version} is not downloaded on this machine.`, 'Run once online, or use a template folder.');
    let url: URL;
    let token: string | undefined;
    if (t.tier === 'paid') {
      // Downloading a paid starter uses the account's entitlement: only a person at a terminal starts that.
      if (process.env.CODZ_MCP === '1') throw new ToolError('needs_approval', `${t.id} is a paid starter and is not downloaded on this machine yet.`, `Ask the user to run codz new <name> --template ${t.id}@${v.version} in a terminal (or --dry-run to only download it); then it can be planned here.`);
      token = await auth.accessToken();
      if (!token) throw new ToolError('not_logged_in', `${t.id} needs an account.`, 'Run codz login (or set CODZ_TOKEN in CI).');
      const r = await request(join(cfg.api, 'v1/download-url'), { method: 'POST', json: { id: t.id, version: v.version }, token, maxBytes: 64 * 1024 });
      if (r.status !== 200) throw apiError(r, { hadToken: true, what: `${t.id} ${v.version}` });
      const u = (parseStrictJson(r.body.toString('utf8'), 'the download answer') as { url?: string }).url;
      url = checkUrl(String(u ?? ''), 'the download URL');
    } else url = join(cfg.base, `v1/templates/${t.id}/${v.version}/archive.tar.gz`);
    const r = await request(url, { maxBytes: LIMITS.compressedBytes, timeoutMs: 120_000 });
    if (r.status !== 200) throw apiError(r, { hadToken: !!token, what: `${t.id} ${v.version}` });
    gz = r.body;
    if (sha256(gz) !== v.archive.sha256) throw new ToolError('checksum_mismatch', `The download of ${t.id} ${v.version} does not match the signed catalog.`, 'Retry; if it persists, do not use the template and report it.');
    writeHomeFile(gz, {}, ...cachePath);
    origin = 'catalog';
  }
  const verified = fromArchive(gz, origin);
  if (verified.manifest.id !== t.id || verified.manifest.version !== v.version) throw new ToolError('bad_template', `The archive says it is ${verified.manifest.id} ${verified.manifest.version}, not ${t.id} ${v.version}.`, 'Do not use it; report it.');
  if (sha256(verified.manifestBytes) !== v.manifest.sha256) throw new ToolError('checksum_mismatch', `The manifest of ${t.id} ${v.version} does not match the signed catalog.`, 'Do not use it; report it.');
  return verified;
}

/** A public manifest, checked against the signed index (for starters show). */
export async function fetchManifest(t: IndexTemplate, v: IndexVersion): Promise<Manifest> {
  const cfg = registryConfig();
  const r = await request(join(cfg.base, `v1/templates/${t.id}/${v.version}/manifest.json`), { maxBytes: 4 * 1024 * 1024 });
  if (r.status !== 200) throw apiError(r, { hadToken: false, what: `${t.id} ${v.version}` });
  if (sha256(r.body) !== v.manifest.sha256) throw new ToolError('checksum_mismatch', `The manifest of ${t.id} ${v.version} does not match the signed catalog.`, 'Retry later; report it if it persists.');
  return parseManifest(r.body.toString('utf8'));
}
