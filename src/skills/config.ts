// codz config: view, get and set conventions, and check the config file.
// `config set` edits codz.config.yaml in place (comments and order stay) and
// goes through the usual preview → apply → undo pipeline.

import { join } from 'node:path';
import { loadMap } from '../core/cache.ts';
import { buildChangeSet } from '../core/changeset.ts';
import { CONFIG_FILE, loadConfig } from '../core/config.ts';
import { readText } from '../core/fsutil.ts';
import { ToolError, type Adapter, type ChangeSet } from '../core/types.ts';
import { ALLOWED, checkValue, closest, knownKeys, validateConfig, type ConfigIssue } from '../core/validateConfig.ts';
import { scalar } from '../core/yaml.ts';

export interface ConfigRow {
  key: string;
  value: string;
  /** "config" when codz.config.yaml sets it, "detected" when the scanner found it. */
  source: 'config' | 'detected';
  description: string;
  allowed?: string[];
}

export async function configView(root: string, adapter: Adapter): Promise<{ framework: string; file: string | null; rows: ConfigRow[] }> {
  const cfg = loadConfig(root);
  const { map } = await loadMap(root, adapter, cfg.conventions);
  const docs = knownKeys(adapter.id);
  const keys = [...new Set([...Object.keys(docs), ...Object.keys(map.conventions)])];
  const rows = keys
    .filter((k) => k in docs || map.conventions[k] !== undefined)
    .map((key) => ({
      key,
      value: cfg.conventions[key] ?? map.conventions[key] ?? '',
      source: (key in cfg.conventions ? 'config' : 'detected') as ConfigRow['source'],
      description: docs[key] ?? '',
      allowed: ALLOWED[adapter.id]?.[key],
    }));
  return { framework: adapter.id, file: cfg.exists ? CONFIG_FILE : null, rows };
}

export function configCheck(root: string): { issues: ConfigIssue[]; file: string } {
  const text = readText(join(root, CONFIG_FILE));
  if (text === null) throw new ToolError('no_config', `There is no ${CONFIG_FILE} here.`, 'Create one with: codz init');
  return { issues: validateConfig(text, root), file: CONFIG_FILE };
}

export function planConfigSet(root: string, adapter: Adapter, key: string, value: string, opts: { force?: boolean } = {}): ChangeSet {
  const text = readText(join(root, CONFIG_FILE));
  if (text === null) throw new ToolError('no_config', `There is no ${CONFIG_FILE} here.`, 'Create one with: codz init');
  const docs = knownKeys(adapter.id);
  if (!(key in docs) && !opts.force) {
    const close = closest(key, Object.keys(docs));
    throw new ToolError('unknown_key', `"${key}" is not a ${adapter.id} convention.`, close ? `Did you mean ${close}?` : `Known keys: ${Object.keys(docs).join(', ')}. Pass --force to set it anyway.`);
  }
  const issue = checkValue(adapter.id, key, value, root);
  if (issue?.level === 'error') throw new ToolError('bad_value', issue.message, issue.hint);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let convAt = lines.findIndex((l) => /^conventions:\s*(#.*)?$/.test(l) || /^conventions:\s*\{\}\s*$/.test(l));
  if (convAt === -1) {
    // No conventions block yet: add one at the end.
    if (lines[lines.length - 1] === '') lines.pop();
    lines.push('conventions:');
    convAt = lines.length - 1;
    lines.push('');
  } else if (/\{\}/.test(lines[convAt])) lines[convAt] = 'conventions:';
  // The block runs while lines are indented (or blank/comment lines inside it).
  let end = convAt + 1;
  let found = -1;
  let indent = '  ';
  while (end < lines.length && (/^\s+\S/.test(lines[end]) || lines[end].trim() === '')) {
    const m = /^(\s+)([^#\s][^:]*):/.exec(lines[end]);
    if (m) {
      indent = m[1];
      if (m[2].trim() === key) found = end;
    }
    end++;
  }
  // Do not swallow blank lines that follow the block.
  while (end > convAt + 1 && lines[end - 1].trim() === '') end--;
  const rendered = `${indent}${key}: ${scalar(value)}`;
  let before: string | null = null;
  if (found !== -1) {
    const old = /:\s*(.*)$/.exec(lines[found])?.[1] ?? '';
    before = old.replace(/^'(.*)'$/, '$1');
    const trailing = /\s+#.*$/.exec(lines[found].slice(lines[found].indexOf(':') + 1));
    lines[found] = rendered + (trailing && !/['"]/.test(trailing[0]) ? trailing[0] : '');
  } else {
    const insert = docs[key] ? [`${indent}# ${docs[key]}`, rendered] : [rendered];
    lines.splice(end, 0, ...insert);
  }
  const next = lines.join(eol);
  const summary = [found !== -1 ? `Set ${key}: ${before || "''"} → ${value || "'' (detect)"} in ${CONFIG_FILE}` : `Add ${key}: ${value || "''"} to ${CONFIG_FILE}`];
  const warnings = issue ? [issue.message + (issue.hint ? ` ${issue.hint}` : '')] : [];
  if (value === '') warnings.push(`An empty ${key} means codz detects it from the code again.`);
  return buildChangeSet(root, 'config set', { files: new Map([[CONFIG_FILE, next]]), summary, warnings, generated: [] });
}
