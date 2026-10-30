// Roadmap phase 2: doctor --fix, check, HAR import and filters, screen add,
// history show / undo --to, --commit, and deleting files through a change set.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import { loadMap } from '../src/core/cache.ts';
import { applyChangeSet, buildChangeSet, historyShow, undoLast, undoTo } from '../src/core/changeset.ts';
import type { ChangeSet } from '../src/core/types.ts';
import { changeSummaryLine } from '../src/core/workflow.ts';
import { listApiImport, pathMatches, planApiImport } from '../src/skills/apiImport.ts';
import { planApiAdd } from '../src/skills/apiAdd.ts';
import { planDoctorFix } from '../src/skills/doctorFix.ts';
import { planLocaleKey } from '../src/skills/locale.ts';
import { planScreenAdd } from '../src/skills/screen.ts';
import { planSetup } from '../src/skills/setup.ts';
import { cleanup, copyFixture, golden, INPUTS } from './helpers.ts';

const { nextjs, flutter } = ADAPTERS;
const HAR = join(INPUTS, 'shop.har');
const apply = (dir: string, cs: ChangeSet) => applyChangeSet(dir, cs, { allowDirty: true, verify: false, format: false });
const after = (cs: ChangeSet, path: string) => cs.changes.find((c) => c.path === path)?.after ?? '';

function record(step: string, cs: ChangeSet): void {
  golden(`${step}/_summary.txt`, [...cs.summary.map((x) => `• ${x}`), ...cs.warnings.map((w) => `! ${w}`)].join('\n') + '\n');
  for (const c of cs.changes) golden(`${step}/${c.path}${c.after === null ? '.deleted' : ''}`, c.after ?? '');
}

async function setup(fixture: string, architecture: string, adapter = flutter): Promise<string> {
  const dir = copyFixture(fixture);
  const { map } = await loadMap(dir, adapter, {});
  apply(dir, planSetup(dir, adapter, map, { architecture, baseUrl: 'https://api.shop.dev' }).changeSet);
  return dir;
}

describe('change sets can delete files', () => {
  it('apply deletes, the diff shows it, undo brings the file back', () => {
    const dir = copyFixture('nextjs-helper');
    try {
      const cs = buildChangeSet(dir, 'test', { files: new Map(), deletes: new Set(['types/user.ts', 'missing.ts']), summary: ['delete'], warnings: [], generated: [] });
      assert.equal(cs.changes.length, 1, 'deleting a file that does not exist is not a change');
      assert.equal(changeSummaryLine(cs), '1 file: 1 deleted (+0 −5 lines)');
      const original = readFileSync(join(dir, 'types/user.ts'), 'utf8');
      apply(dir, cs);
      assert.equal(existsSync(join(dir, 'types/user.ts')), false);
      assert.equal(historyShow(dir, cs.id).files[0].action, 'deleted');
      undoLast(dir);
      assert.equal(readFileSync(join(dir, 'types/user.ts'), 'utf8'), original);
    } finally {
      cleanup(dir);
    }
  });
});

describe('doctor --fix', () => {
  it('Next.js: missing keys, base-URL literal and an unused model in one change', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      writeFileSync(join(dir, 'messages/en.json'), JSON.stringify({ home: { title: 'Welcome', subtitle: 'Hi' }, profile: { title: 'Profile' }, cart: { empty: 'Empty' } }, null, 2) + '\n');
      writeFileSync(join(dir, 'types/team.ts'), 'export interface Team {\n  id: number;\n}\n');
      writeFileSync(join(dir, 'types/index.ts'), "export * from './user';\nexport * from './team';\n");
      writeFileSync(join(dir, 'components/hardcoded.tsx'), "'use client';\nexport async function load() {\n  return fetch('https://api.example.com/v1/items');\n}\nconst other = 'https://elsewhere.io/api/x';\n");
      const r = await planDoctorFix(dir, nextjs);
      record('phase2/doctor-fix/nextjs', r.changeSet);
      assert.equal(r.fixed, 3);
      assert.equal(r.manual.length, 1);
      assert.match(after(r.changeSet, 'components/hardcoded.tsx'), /fetch\(`\$\{process\.env\.NEXT_PUBLIC_API_URL\}\/v1\/items`\)/);
      assert.equal(r.changeSet.changes.find((c) => c.path === 'types/team.ts')!.after, null);
      // Applying and fixing again finds nothing left to repair automatically.
      apply(dir, r.changeSet);
      const again = await planDoctorFix(dir, nextjs);
      assert.equal(again.changeSet.changes.length, 0);
    } finally {
      cleanup(dir);
    }
  });

  it('GetX: missing keys go into the language map; Dio literals become relative paths', async () => {
    const dir = await setup('flutter-fresh', 'getx');
    try {
      apply(dir, await planLocaleKey(dir, flutter, 'home.title', 'Welcome'));
      const tf = 'lib/app/translations/app_translations.dart';
      const t = readFileSync(join(dir, tf), 'utf8').replace("'en_US': {", "'hi_IN': {\n        },\n        'en_US': {");
      writeFileSync(join(dir, tf), t);
      writeFileSync(join(dir, 'lib/app/data/raw.dart'), "import 'package:dio/dio.dart';\n\nFuture<void> f(Dio dio) async {\n  await dio.get<dynamic>('https://api.shop.dev/v1/health');\n}\n");
      const r = await planDoctorFix(dir, flutter);
      assert.match(after(r.changeSet, tf), /'hi_IN': \{\n {10}'home\.title': 'Welcome',\n {8}\}/);
      assert.match(after(r.changeSet, 'lib/app/data/raw.dart'), /dio\.get<dynamic>\('\/v1\/health'\)/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('api import: HAR and filters', () => {
  it('pathMatches: * one segment, ** any, {id} and :id are the same', () => {
    assert.ok(pathMatches('/v1/users/**', '/v1/users'));
    assert.ok(pathMatches('/v1/users/**', '/v1/users/{id}/orders'));
    assert.ok(pathMatches('/v1/*/{id}', '/v1/orders/{orderId}'));
    assert.ok(pathMatches('/v1/users/:id', '/v1/users/{userId}'));
    assert.ok(!pathMatches('/v1/users/*', '/v1/users'));
    assert.ok(!pathMatches('/v1/users', '/v1/users.json'));
  });

  it('reads JSON calls, groups them by normalized path and drops secrets and noise', () => {
    const l = listApiImport({ file: HAR });
    assert.equal(l.format, 'har');
    assert.deepEqual(l.operations.map((o) => `${o.method} ${o.path} ${o.name}`), ['GET /v1/users/{id} getUser', 'GET /v1/users getUsers', 'POST /v1/users createUser', 'GET /v1/orders/{id} getOrder', 'GET /config.json getConfig']);
    const w = l.warnings.join('\n');
    assert.match(w, /2 hosts/);
    assert.match(w, /query parameter "token"/);
    assert.match(w, /1 failed/);
    const filtered = listApiImport({ file: HAR, baseUrl: 'https://api.shop.dev', methods: ['GET'], paths: ['/v1/users/**'] });
    assert.deepEqual(filtered.operations.map((o) => o.name), ['getUser', 'getUsers']);
  });

  it('generated code has the types, the page parameter, and none of the values', async () => {
    const dir = await setup('nextjs-fresh', 'fetch-helper', nextjs);
    try {
      const r = await planApiImport(dir, nextjs, { file: HAR, baseUrl: 'https://api.shop.dev' });
      assert.deepEqual(r.added, ['getUser', 'getUsers', 'createUser', 'getOrder']);
      const code = r.changeSet.changes.map((c) => c.after).join('\n');
      assert.match(code, /getUsers\(params\?: \{ page\?: number \}\)/);
      assert.doesNotMatch(code, /asha|hunter2|abc123|sk_live|session=/i);
    } finally {
      cleanup(dir);
    }
  });

  it('conflicts stop the import unless --skip-conflicts; --max caps; large imports need --yes', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      await assert.rejects(planApiImport(dir, nextjs, { file: HAR, baseUrl: 'https://api.shop.dev' }), (e: { code?: string }) => e.code === 'import_conflicts');
      const r = await planApiImport(dir, nextjs, { file: HAR, baseUrl: 'https://api.shop.dev', skipConflicts: true });
      assert.deepEqual(r.added, ['getOrder']);
      assert.equal(r.skipped.length, 3);
      const capped = await planApiImport(dir, nextjs, { file: HAR, baseUrl: 'https://api.shop.dev', only: ['getOrder', 'getConfig'], max: 1 });
      assert.deepEqual(capped.added, ['getOrder']);
    } finally {
      cleanup(dir);
    }
  });
});

describe('screen add', () => {
  it('Next.js: page awaiting the endpoint, loading.tsx and error.tsx', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      const cs = await planScreenAdd(dir, nextjs, { name: 'user-profile', api: 'getUser', path: '/users/:id' });
      record('phase2/screen/nextjs', cs);
      assert.match(after(cs, 'app/users/[id]/page.tsx'), /const user = await getUser\(Number\(id\)\);/);
      assert.ok(after(cs, 'app/users/[id]/error.tsx').startsWith("'use client';"));
      await assert.rejects(planScreenAdd(dir, nextjs, { name: 'user-profile', api: 'getUser' }), (e: { code?: string }) => e.code === 'screen_args');
      await assert.rejects(planScreenAdd(dir, nextjs, { name: 'edit-user', api: 'updateUser', path: '/u/:id' }), (e: { code?: string }) => e.code === 'screen_needs_get');
    } finally {
      cleanup(dir);
    }
  });

  it('Riverpod + go_router: ConsumerStatefulWidget with FutureBuilder and the route', async () => {
    const dir = copyFixture('flutter-riverpod');
    try {
      const cs = await planScreenAdd(dir, flutter, { name: 'user-details', api: 'getUser', path: '/users/:id' });
      record('phase2/screen/riverpod', cs);
      const page = after(cs, 'lib/features/user_details/user_details_page.dart');
      assert.match(page, /ref\.read\(userRepositoryProvider\)\.getUser\(int\.parse\(widget\.id\)\)/);
      assert.match(page, /snapshot\.hasError/);
      assert.match(after(cs, 'lib/router.dart'), /UserDetailsPage\(id: state\.pathParameters\['id'\]!\)/);
    } finally {
      cleanup(dir);
    }
  });

  it('GetX: module with the endpoint wired and an Obx view', async () => {
    const dir = await setup('flutter-fresh', 'getx');
    try {
      apply(dir, (await planApiAdd(dir, flutter, { url: 'https://api.shop.dev/products', samples: [join(INPUTS, 'products.json')] })).changeSet);
      const cs = await planScreenAdd(dir, flutter, { name: 'catalog', api: 'getProducts' });
      record('phase2/screen/getx', cs);
      const view = after(cs, 'lib/app/modules/catalog/views/catalog_view.dart');
      assert.match(view, /controller\.isProductsLoading\.value/);
      assert.match(view, /TextButton\(onPressed: controller\.loadProducts/);
      assert.doesNotMatch(cs.summary.join('\n'), /In CatalogView: Obx/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('history and undo --to', () => {
  it('undoes back to a change, newest first', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      const a = (await planApiAdd(dir, nextjs, { url: 'https://api.example.com/orders' })).changeSet;
      apply(dir, a);
      const b = (await planApiAdd(dir, nextjs, { url: 'https://api.example.com/teams' })).changeSet;
      apply(dir, b);
      assert.equal(historyShow(dir, a.id).files.find((f) => f.path === 'lib/api/index.ts')!.state, 'edited since');
      const undone = undoTo(dir, a.id.slice(0, 15));
      assert.deepEqual(undone.map((u) => u.id), [b.id, a.id]);
      assert.equal(existsSync(join(dir, 'lib/api/orders.ts')), false);
    } finally {
      cleanup(dir);
    }
  });
});
