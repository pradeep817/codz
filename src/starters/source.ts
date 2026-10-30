// A template source: the manifest, the license and the project files, read
// from a folder or an archive and verified against the manifest's hashes.
// The engine only ever sees a VerifiedTemplate, so a template from the
// catalog, the cache or the user's own disk goes through the same checks.

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToolError } from '../core/types.ts';
import { parseManifest, type Manifest } from './manifest.ts';
import { checkCollisions, checkRelPath, LIMITS } from './paths.ts';
import { sha256 } from './sign.ts';
import { readTarGz } from './tar.ts';

export interface VerifiedTemplate {
  manifest: Manifest;
  manifestBytes: Buffer;
  license: string;
  /** Project files by path, exactly as listed in the manifest. */
  files: Map<string, Buffer>;
  /** Where it came from, for messages and history ("catalog", "cache", or a folder). */
  origin: string;
  /** SHA-256 of the archive, when it came from one. */
  archiveSha256?: string;
}

/** Checks every listed file is present with the right size and hash, and nothing else is there. */
export function verifyFiles(m: Manifest, files: Map<string, Buffer>): void {
  const listed = new Set(m.files.map((f) => f.path));
  const extra = [...files.keys()].filter((p) => !listed.has(p));
  if (extra.length) throw new ToolError('checksum_mismatch', `The template has files its manifest does not list: ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ', ...' : ''}.`, 'Clear the cache with devtool starters cache --clear and retry; report it if it persists.');
  for (const f of m.files) {
    const data = files.get(f.path);
    if (!data) throw new ToolError('checksum_mismatch', `The template is missing ${f.path}.`, 'Clear the cache with devtool starters cache --clear and retry; report it if it persists.');
    if (data.length !== f.size || sha256(data) !== f.sha256) throw new ToolError('checksum_mismatch', `${f.path} does not match its hash in the manifest.`, 'Clear the cache with devtool starters cache --clear and retry; report it if it persists.');
  }
}

export function fromArchive(gz: Buffer, origin: string): VerifiedTemplate {
  const { files: all } = readTarGz(gz);
  const manifestBytes = all.get('manifest.json');
  const license = all.get('LICENSE');
  if (!manifestBytes) throw new ToolError('bad_template', 'The archive has no manifest.json.', 'Report it; the template is not usable as published.');
  if (!license) throw new ToolError('bad_template', 'The archive has no LICENSE.', 'Report it; the template is not usable as published.');
  const files = new Map<string, Buffer>();
  for (const [p, data] of all) {
    if (p === 'manifest.json' || p === 'LICENSE') continue;
    if (!p.startsWith('files/')) throw new ToolError('archive_unsafe', `The archive has an entry outside files/: "${p.slice(0, 120)}". Nothing was written.`, 'Do not use this template; report it.');
    files.set(p.slice('files/'.length), data);
  }
  const manifest = parseManifest(manifestBytes.toString('utf8'));
  verifyFiles(manifest, files);
  return { manifest, manifestBytes, license: license.toString('utf8'), files, origin, archiveSha256: sha256(gz) };
}

/** A template folder on disk: manifest.json, LICENSE and files/. Links and special files are refused. */
export function fromFolder(dir: string): VerifiedTemplate {
  const read = (name: string) => {
    try {
      const st = lstatSync(join(dir, name));
      if (!st.isFile()) throw new ToolError('archive_unsafe', `${name} in the template folder is not a regular file.`, 'Templates hold regular files only.');
      return readFileSync(join(dir, name));
    } catch (e) {
      if (e instanceof ToolError) throw e;
      throw new ToolError('template_not_found', `${join(dir, name)} was not found.`, 'A template folder has manifest.json, LICENSE and files/.');
    }
  };
  const manifestBytes = read('manifest.json');
  const license = read('LICENSE');
  const files = new Map<string, Buffer>();
  let total = 0;
  const walkDir = (rel: string) => {
    for (const name of readdirSync(join(dir, 'files', rel)).sort()) {
      const p = rel ? `${rel}/${name}` : name;
      checkRelPath(p, 'template folder');
      const st = lstatSync(join(dir, 'files', p));
      if (st.isSymbolicLink()) throw new ToolError('archive_unsafe', `The template folder has a link: files/${p}. Nothing was written.`, 'Templates hold regular files only.');
      if (st.isDirectory()) walkDir(p);
      else if (st.isFile()) {
        if (files.size >= LIMITS.entries) throw new ToolError('archive_too_large', `The template folder has more than ${LIMITS.entries} files.`);
        total += st.size;
        if (total > LIMITS.expandedBytes) throw new ToolError('archive_too_large', 'The template folder is larger than the safety limit.');
        files.set(p, readFileSync(join(dir, 'files', p)));
      } else throw new ToolError('archive_unsafe', `The template folder has a special file: files/${p}.`, 'Templates hold regular files only.');
    }
  };
  try {
    if (!lstatSync(join(dir, 'files')).isDirectory()) throw new Error('not a folder');
  } catch {
    throw new ToolError('bad_template', `${dir} has no files/ folder.`, 'A template folder has manifest.json, LICENSE and files/.');
  }
  walkDir('');
  checkCollisions([...files.keys()], 'template folder');
  const manifest = parseManifest(manifestBytes.toString('utf8'));
  verifyFiles(manifest, files);
  return { manifest, manifestBytes, license: license.toString('utf8'), files, origin: dir };
}
