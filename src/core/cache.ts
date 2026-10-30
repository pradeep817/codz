// The project map is a cache rebuilt from the code. It lives in .devtool/
// (git-ignored) and is refreshed before every skill when files changed.

import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, readJson, readText, walk } from './fsutil.ts';
import { MAP_SCHEMA_VERSION, type Adapter, type Conventions, type ProjectMap } from './types.ts';

export const TOOL_DIR = '.devtool';

const FINGERPRINT_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json', '.dart', '.yaml', '.yml', '.arb', '.env', '.example', '.local'];

/**
 * devtool's own source, so a map scanned by an older devtool is rebuilt after an
 * upgrade even when the version number did not change.
 */
let toolBuild: string | undefined;
function toolFingerprint(): string {
  if (toolBuild) return toolBuild;
  const src = join(dirname(fileURLToPath(import.meta.url)), '..');
  // src/*.ts when run from source, dist/*.js when installed from npm.
  const parts = walk(src, '.', { exts: import.meta.url.endsWith('.ts') ? ['.ts'] : ['.js'] }).map((f) => {
    const st = statSync(join(src, f));
    return `${f}:${st.size}:${Math.floor(st.mtimeMs)}`;
  });
  return (toolBuild = hash(parts.join('\n')));
}

/** Read-only runs (--dry-run, doctor) scan in memory and leave .devtool/ alone. */
let cacheWrites = true;
export function setCacheWrites(on: boolean): void {
  cacheWrites = on;
}

export function toolDir(root: string, ...parts: string[]): string {
  const dir = join(root, TOOL_DIR, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Cheap fingerprint of the project: path, size and modified time of relevant files. */
export function fingerprint(root: string, configText: string): string {
  const files = walk(root, '.', { exts: FINGERPRINT_EXTS });
  const parts: string[] = [configText];
  for (const f of files) {
    try {
      const st = statSync(join(root, f));
      parts.push(`${f}:${st.size}:${Math.floor(st.mtimeMs)}`);
    } catch {
      // File vanished during the walk; skip it.
    }
  }
  return hash(parts.join('\n'));
}

interface CacheFile {
  schema: number;
  adapter: string;
  /** devtool's own source fingerprint (see toolFingerprint). */
  tool?: string;
  fingerprint: string;
  map: ProjectMap;
}

export async function loadMap(root: string, adapter: Adapter, conventions: Conventions, opts: { force?: boolean } = {}): Promise<{ map: ProjectMap; fromCache: boolean }> {
  const cachePath = join(root, TOOL_DIR, 'cache', 'map.json');
  const configText = readText(join(root, 'devtool.config.yaml')) ?? '';
  const fp = fingerprint(root, configText);
  const cached = readJson<CacheFile>(cachePath);
  if (!opts.force && cached && cached.schema === MAP_SCHEMA_VERSION && cached.adapter === `${adapter.id}@${adapter.version}` && cached.tool === toolFingerprint() && cached.fingerprint === fp) {
    return { map: cached.map, fromCache: true };
  }
  // An old schema or adapter version is simply rebuilt, never migrated.
  const map = await adapter.scan(root, conventions);
  const file: CacheFile = { schema: MAP_SCHEMA_VERSION, adapter: `${adapter.id}@${adapter.version}`, tool: toolFingerprint(), fingerprint: fp, map };
  if (cacheWrites) {
    toolDir(root, 'cache');
    writeFileSync(cachePath, JSON.stringify(file, null, 2));
  }
  return { map, fromCache: false };
}

export function invalidateMap(root: string): void {
  const cachePath = join(root, TOOL_DIR, 'cache', 'map.json');
  try {
    writeFileSync(cachePath, '{}');
  } catch {
    // No cache yet.
  }
}
