// explain: prints how the project is put together, from the project map.

import type { Adapter, ProjectMap } from '../core/types.ts';

const pad = (s: string, n: number) => (s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length));

export function renderExplain(map: ProjectMap, adapter: Adapter, color: boolean): string {
  const b = (s: string) => (color ? `\x1b[1m${s}\x1b[0m` : s);
  const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  const names: Record<string, string> = { nextjs: 'Next.js', flutter: 'Flutter', generic: 'Generic' };
  const out: string[] = [];
  out.push(b(`${names[map.framework] ?? map.framework} project`) + dim(`  (adapter ${map.adapter})`));
  out.push(dim(`Supported setup: ${adapter.supportedSetup}`));

  const conv = Object.entries(map.conventions).filter(([, v]) => v !== '');
  if (conv.length) {
    out.push('', b('Conventions'));
    const w = Math.max(...conv.map(([k]) => k.length)) + 2;
    for (const [k, v] of conv) out.push(`  ${pad(k, w)}${v}`);
  }

  out.push('', b(`Routes (${map.routes.length})`));
  if (!map.routes.length) out.push(dim('  none found'));
  const rw = Math.max(0, ...map.routes.map((r) => r.path.length)) + 2;
  for (const r of map.routes) out.push(`  ${pad(r.path, rw)}${dim(r.file)}`);

  out.push('', b(`Endpoints (${map.endpoints.length})`));
  if (!map.endpoints.length) out.push(dim('  none found'));
  const pw = Math.max(0, ...map.endpoints.map((e) => e.path.length)) + 2;
  const nw = Math.max(0, ...map.endpoints.map((e) => e.name.length + (e.response ? e.response.length + 3 : 0))) + 2;
  for (const e of map.endpoints) {
    const used = e.calledFrom.length ? `  used in ${e.calledFrom.join(', ')}` : '  not called anywhere yet';
    out.push(`  ${pad(e.method, 7)}${pad(e.path, pw)}${pad(e.name + (e.response ? ` → ${e.response}` : ''), nw)}${dim(e.file + used)}`);
  }

  out.push('', b(`Models (${map.models.length})`));
  if (!map.models.length) out.push(dim('  none found'));
  const mw = Math.max(0, ...map.models.map((m) => m.name.length)) + 2;
  for (const m of map.models) {
    const fields = m.fields.map((f) => `${f.name}${f.nullable ? '?' : ''}`).join(', ');
    out.push(`  ${pad(m.name, mw)}${fields.length > 70 ? fields.slice(0, 67) + '...' : fields}  ${dim(m.file)}`);
  }

  out.push('', b('Locales'));
  if (map.locales.languages.length) {
    out.push(`  ${map.locales.languages.map((l) => (l === map.locales.default ? `${l} (default)` : l)).join(', ')}, ${map.locales.keyCount} keys`);
    out.push(dim(`  ${map.locales.files.join(', ')}`));
  } else out.push(dim('  none found'));

  out.push('', b('Base URLs'));
  if (map.baseUrls.length) for (const u of map.baseUrls) out.push(`  ${u.name} = ${u.value}  ${dim(u.file)}`);
  else out.push(dim('  none found in .env files'));

  const ext = Object.entries(map.stats.byExtension).slice(0, 6).map(([e, n]) => `${e} ${n}`).join(', ');
  out.push('', b('Files') + `  ${map.stats.files} (${ext})`);
  if (map.notes.length) {
    out.push('', b('Notes'));
    for (const n of map.notes) out.push(`  - ${n}`);
  }
  return out.join('\n');
}
