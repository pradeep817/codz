// codz.config.yaml: the only file codz asks you to commit. It holds the
// conventions you confirmed, which override what the scanner detects.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readText } from './fsutil.ts';
import { ToolError, type Conventions, type FrameworkId } from './types.ts';
import { parse, stringify, type YamlValue } from './yaml.ts';

export const CONFIG_FILE = 'codz.config.yaml';

export interface ToolConfig {
  framework?: FrameworkId;
  conventions: Conventions;
  exists: boolean;
}

export function loadConfig(root: string): ToolConfig {
  const text = readText(join(root, CONFIG_FILE));
  if (text == null) return { conventions: {}, exists: false };
  let data: ReturnType<typeof parse>;
  try {
    data = parse(text);
  } catch (e) {
    throw new ToolError('bad_config', (e as Error).message, 'Fix that line, or see every problem with: codz config check');
  }
  const conventions: Conventions = {};
  const raw = data.conventions;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v !== '') conventions[k] = v;
  }
  const framework = typeof data.framework === 'string' ? (data.framework as FrameworkId) : undefined;
  return { framework, conventions, exists: true };
}

export function renderConfig(framework: FrameworkId, conventions: Conventions, descriptions: Record<string, string>): string {
  const header = [
    '# codz configuration. Commit this file.',
    '# Values below were detected by `codz init` (or chosen in `codz setup`).',
    '# Correct any that are wrong: codz always uses these values instead of guessing again.',
    '',
  ].join('\n');
  const comments: Record<string, string> = {};
  for (const [k, d] of Object.entries(descriptions)) comments[`conventions.${k}`] = d;
  const body: { [key: string]: YamlValue } = { framework, conventions: { ...conventions } };
  return header + stringify(body, comments);
}

export function writeConfig(root: string, framework: FrameworkId, conventions: Conventions, descriptions: Record<string, string>): void {
  writeFileSync(join(root, CONFIG_FILE), renderConfig(framework, conventions, descriptions));
}
