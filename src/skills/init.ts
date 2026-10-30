// init: detect the framework and scan. The CLI then either writes
// codz.config.yaml directly, or, for a project with no API layer yet,
// offers `setup` so the config and the new files land in one change.

import { RN_CONVENTION_DOCS } from '../adapters/reactNative.ts';
import { REACT_CONVENTION_DOCS } from '../adapters/react.ts';
import { IOS_CONVENTION_DOCS } from '../adapters/ios.ts';
import { ANDROID_CONVENTION_DOCS } from '../adapters/android.ts';
import { join, resolve } from 'node:path';
import { ADAPTERS } from '../adapters/index.ts';
import { FLUTTER_CONVENTION_DOCS } from '../adapters/flutter.ts';
import { NEXT_CONVENTION_DOCS } from '../adapters/nextjs.ts';
import { loadMap } from '../core/cache.ts';
import { CONFIG_FILE, loadConfig, renderConfig } from '../core/config.ts';
import { exists, readText } from '../core/fsutil.ts';
import { isGitRepo } from '../core/git.ts';
import { ToolError, type Adapter, type Conventions, type ProjectMap } from '../core/types.ts';
import { detect } from '../detector.ts';
import { writeFileSync } from 'node:fs';

export interface Detected {
  root: string;
  adapter: Adapter;
  label: string;
  map: ProjectMap;
  configExists: boolean;
}

export async function detectProject(start: string, opts: { root?: string; force?: boolean }): Promise<Detected> {
  let root = resolve(start, opts.root ?? '.');
  const found = detect(root);
  const supported = found.filter((d) => d.supported);
  if (!opts.root && supported.length > 1) {
    throw new ToolError(
      'many_projects',
      `Found ${supported.length} projects here:\n${supported.map((d) => `  ${d.root}  (${d.label})`).join('\n')}`,
      'Run `codz init --root <folder>` for the one you want; each project gets its own codz.config.yaml.',
    );
  }
  const pick = supported[0] ?? found[0];
  let adapter: Adapter = ADAPTERS.generic;
  if (pick) {
    root = resolve(root, pick.root);
    adapter = ADAPTERS[pick.framework];
  }
  const cfg = loadConfig(root);
  if (cfg.exists && cfg.framework && !opts.force) adapter = ADAPTERS[cfg.framework] ?? adapter;
  const conventions = cfg.exists && !opts.force ? cfg.conventions : {};
  const { map } = await loadMap(root, adapter, conventions, { force: true });
  return { root, adapter, label: pick?.label ?? 'unknown', map, configExists: cfg.exists };
}

export function conventionDocs(adapter: Adapter): Record<string, string> {
  return adapter.id === 'nextjs' ? NEXT_CONVENTION_DOCS : adapter.id === 'flutter' ? FLUTTER_CONVENTION_DOCS : adapter.id === 'react-native' ? RN_CONVENTION_DOCS : adapter.id === 'react' ? REACT_CONVENTION_DOCS : adapter.id === 'ios' ? IOS_CONVENTION_DOCS : adapter.id === 'android' ? ANDROID_CONVENTION_DOCS : {};
}

/** The config file and .gitignore change that init makes, as file contents. */
export function initFiles(root: string, adapter: Adapter, conventions: Conventions): Map<string, string> {
  const files = new Map<string, string>();
  files.set(CONFIG_FILE, renderConfig(adapter.id, conventions, conventionDocs(adapter)));
  const gi = join(root, '.gitignore');
  if (isGitRepo(root) || exists(gi)) {
    const text = readText(gi) ?? '';
    if (!/^\/?\.codz\/?$/m.test(text)) files.set('.gitignore', `${text}${text && !text.endsWith('\n') ? '\n' : ''}# codz cache, backups and history\n.codz/\n`);
  }
  return files;
}

/** Writes init's files directly (no API layer to create, or the user skipped setup). */
export function writeInitFiles(root: string, files: Map<string, string>, keepConfig: boolean): { configWritten: boolean; gitignoreUpdated: boolean } {
  let configWritten = false;
  for (const [path, content] of files) {
    if (path === CONFIG_FILE && keepConfig) continue;
    writeFileSync(join(root, path), content);
    if (path === CONFIG_FILE) configWritten = true;
  }
  return { configWritten, gitignoreUpdated: files.has('.gitignore') };
}

export { CONFIG_FILE };
