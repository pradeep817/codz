// templates list | templates init [id...]: see which templates the project
// customizes, and start one from a file that reproduces codz's own output.

import { join } from 'node:path';
import { buildChangeSet } from '../core/changeset.ts';
import { exists } from '../core/fsutil.ts';
import { TEMPLATES, templatesFolder } from '../core/templates.ts';
import { ToolError, type ChangeSet } from '../core/types.ts';

export function listTemplates(root: string): { folder: string; templates: { id: string; about: string; custom: boolean; placeholders: string[] }[] } {
  const folder = templatesFolder(root);
  return { folder, templates: TEMPLATES.map((t) => ({ id: t.id, about: t.about, custom: exists(join(root, folder, `${t.id}.tmpl`)), placeholders: Object.keys(t.vars) })) };
}

export function planTemplatesInit(root: string, ids: string[]): ChangeSet {
  const folder = templatesFolder(root);
  const unknown = ids.filter((id) => !TEMPLATES.some((t) => t.id === id));
  if (unknown.length) throw new ToolError('bad_template', `Unknown template ${unknown.join(', ')}.`, `Templates: ${TEMPLATES.map((t) => t.id).join(', ')}`);
  const chosen = TEMPLATES.filter((t) => !ids.length || ids.includes(t.id));
  const files = new Map<string, string>();
  const summary: string[] = [];
  for (const t of chosen) {
    const file = `${folder}/${t.id}.tmpl`;
    if (exists(join(root, file))) continue;
    files.set(file, t.example);
    summary.push(`Create ${file}: ${t.about} (placeholders: ${Object.keys(t.vars).map((v) => `{{${v}}}`).join(', ')})`);
  }
  if (!files.size) summary.push(`Every chosen template already exists in ${folder}.`);
  else summary.push('Edit them and commit them; codz uses them from the next command on. {{default}} is what codz would write.');
  return buildChangeSet(root, 'templates init', { files, summary, warnings: [], generated: [] });
}
