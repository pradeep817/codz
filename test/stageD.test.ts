// Stage D: bigger features. api sync, screen add --form, test generation, custom templates.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import { applyChangeSet } from '../src/core/changeset.ts';
import type { ChangeSet } from '../src/core/types.ts';
import { planApiSync } from '../src/skills/apiSync.ts';
import { planScreenAdd } from '../src/skills/screen.ts';
import { planTestAdd } from '../src/skills/testgen.ts';
import { planApiAdd } from '../src/skills/apiAdd.ts';
import { listTemplates, planTemplatesInit } from '../src/skills/templatesCmd.ts';
import { clearTemplateCache, render } from '../src/core/templates.ts';
import { mkdirSync } from 'node:fs';
import { cleanup, copyFixture, INPUTS } from './helpers.ts';

const { flutter, nextjs } = ADAPTERS;
const after = (cs: ChangeSet, path: string) => cs.changes.find((c) => c.path === path)?.after ?? null;
const apply = (dir: string, cs: ChangeSet) => applyChangeSet(dir, cs, { allowDirty: true, verify: false, format: false });
const SPEC = join(INPUTS, 'shop-openapi.yaml');

describe('stage D: api sync', () => {
  it('updates matched endpoints in place, keeping the project path, parameter names and field order', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      const r = await planApiSync(dir, nextjs, { file: SPEC });
      assert.deepEqual(r.updated, ['getUser']);
      assert.deepEqual(r.missingFromSpec, ['updateUser']);
      assert.deepEqual(r.newInSpec.sort(), ['createUser', 'deleteUser', 'getOrder', 'listUsers']);
      assert.match(after(r.changeSet, 'lib/api/users.ts') ?? '', /export function getUser\(id: number\): Promise<User> \{\n  return apiFetch<User>\(`\/users\/\$\{id\}`\);/, 'same path, same parameter name');
      const user = after(r.changeSet, 'types/user.ts')!;
      assert.match(user, /^export interface User \{\n  id: number;\n  name: string;\n  email: string;/);
      assert.match(user, /created_at: string;/);
      assert.deepEqual(r.breaking, [], 'a field becoming non-nullable is not breaking');
    } finally {
      cleanup(dir);
    }
  });

  it('--add adds the rest under the same base prefix; a second sync finds nothing to do', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      const r = await planApiSync(dir, nextjs, { file: SPEC, add: true });
      assert.deepEqual(r.added.sort(), ['createUser', 'deleteUser', 'getOrder', 'listUsers']);
      assert.match(after(r.changeSet, 'lib/api/orders.ts')!, /apiFetch<Order>\(`\/orders\/\$\{orderId\}`\)/);
      apply(dir, r.changeSet);
      const again = await planApiSync(dir, nextjs, { file: SPEC });
      assert.equal(again.changeSet.changes.length, 0);
      assert.equal(again.unchanged.length, 5);
    } finally {
      cleanup(dir);
    }
  });

  it('reports a removed response field as breaking, with the lines that use it', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      writeFileSync(join(dir, 'components/user-card.tsx'), "import type { User } from '@/types/user';\n\nexport function UserCard({ user }: { user: User }) {\n  return <div>{user.name}</div>;\n}\n");
      const spec = readFileSync(SPEC, 'utf8').replace('required: [name, email]', 'required: [email]').replace('        name: { type: string }\n', '');
      writeFileSync(join(dir, 'spec.yaml'), spec);
      const r = await planApiSync(dir, nextjs, { file: 'spec.yaml' });
      assert.ok(r.breaking.some((b) => /getUser: User lost name/.test(b)), r.breaking.join('\n'));
      assert.match(r.changeSet.warnings.join('\n'), /components\/user-card\.tsx:4/);
    } finally {
      cleanup(dir);
    }
  });

  it('--remove deletes endpoints that left the spec', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      const r = await planApiSync(dir, nextjs, { file: SPEC, remove: true, add: true });
      assert.ok(r.removed.includes('updateUser') || r.changeSet.warnings.some((w) => /run api remove updateUser after this sync/.test(w)));
    } finally {
      cleanup(dir);
    }
  });

  it('works for Flutter too, and is idempotent', async () => {
    const dir = copyFixture('flutter-riverpod');
    try {
      const r = await planApiSync(dir, flutter, { file: SPEC, add: true });
      assert.ok(r.added.length >= 3);
      apply(dir, r.changeSet);
      const again = await planApiSync(dir, flutter, { file: SPEC });
      assert.equal(again.changeSet.changes.length, 0, again.changeSet.summary.join('\n'));
    } finally {
      cleanup(dir);
    }
  });
});

describe('stage D: screen add --form', () => {
  it('Next.js: a client page with one input per field, calling the endpoint with path params', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      apply(dir, (await planApiSync(dir, nextjs, { file: SPEC, add: true })).changeSet);
      const create = await planScreenAdd(dir, nextjs, { name: 'new-user', api: 'createUser', form: true });
      const page = after(create, 'app/new-user/page.tsx')!;
      assert.match(page, /^'use client';/);
      assert.match(page, /<input type="email" value=\{values\.email\}/);
      assert.match(page, /const body: NewUser = \{\n        name: values\.name,/);
      assert.match(page, /await createUser\(body\);/);
      const edit = await planScreenAdd(dir, nextjs, { name: 'edit-user', api: 'updateUser', path: '/users/:id/edit', form: true });
      const ep = after(edit, 'app/users/[id]/edit/page.tsx')!;
      assert.match(ep, /const params = useParams<\{ id: string \}>\(\);/);
      assert.match(ep, /name: values\.name === '' \? undefined : values\.name,/, 'Partial<User>: every field is optional');
      assert.match(ep, /await updateUser\(Number\(params\.id\), body\);/);
    } finally {
      cleanup(dir);
    }
  });

  it('refuses GET endpoints, missing path params, and required fields a form cannot fill', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      await assert.rejects(planScreenAdd(dir, nextjs, { name: 'x', api: 'getUser', form: true }), /form sends data/);
      await assert.rejects(planScreenAdd(dir, nextjs, { name: 'x', api: 'updateUser', form: true }), /needs id/);
      writeFileSync(join(dir, 'types/user.ts'), 'export interface Address { city: string }\nexport interface User {\n  id: number;\n  address: Address;\n}\n');
      writeFileSync(join(dir, 'lib/api/users.ts'), readFileSync(join(dir, 'lib/api/users.ts'), 'utf8').replace('body: Partial<User>', 'body: User'));
      await assert.rejects(planScreenAdd(dir, nextjs, { name: 'x', api: 'updateUser', path: '/u/:id', form: true }), /address \(Address\)/);
    } finally {
      cleanup(dir);
    }
  });

  it('Flutter (Riverpod): a validated Form that builds the request model and calls the repository', async () => {
    const dir = copyFixture('flutter-riverpod');
    try {
      apply(dir, (await planApiSync(dir, flutter, { file: SPEC, add: true })).changeSet);
      const cs = await planScreenAdd(dir, flutter, { name: 'new-user', api: 'createUser', form: true });
      const page = after(cs, 'lib/features/new_user/new_user_page.dart')!;
      assert.match(page, /class NewUserPage extends ConsumerStatefulWidget/);
      assert.match(page, /final body = NewUserModel\(\n        name: _name\.text\.trim\(\),/);
      assert.match(page, /await ref\.read\(userRepositoryProvider\)\.createUser\(body\);/);
      assert.match(page, /if \(v == null \|\| v\.trim\(\)\.isEmpty\) return 'Required';/);
      assert.match(after(cs, 'lib/router.dart')!, /NewUserPage\(\)/);
    } finally {
      cleanup(dir);
    }
  });

  it('GetX: the module view becomes the form, with the repository from Get.find', async () => {
    const dir = copyFixture('flutter-getx-cli');
    try {
      apply(dir, (await planApiSync(dir, flutter, { file: SPEC, add: true })).changeSet);
      const cs = await planScreenAdd(dir, flutter, { name: 'new-user', api: 'createUser', form: true });
      const view = cs.changes.find((c) => c.path.endsWith('/views/new_user_view.dart'))!.after!;
      assert.match(view, /class NewUserView extends StatefulWidget/);
      assert.match(view, /await Get\.find<\w+>\(\)\.createUser\(body\);/);
      assert.ok(cs.changes.some((c) => c.path.endsWith('app_pages.dart')));
    } finally {
      cleanup(dir);
    }
  });
});

describe('stage D: test add', () => {
  it('Next.js + fetch helper: Vitest tests that fake fetch, check method, URL, result and errors', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      const cs = await planTestAdd(dir, nextjs, { endpoints: ['getUser'] });
      const t = after(cs, 'lib/api/users.test.ts')!;
      assert.match(t, /^import \{ afterEach, describe, expect, it, vi \} from 'vitest';\nimport \{ getUser \} from '\.\/users';/);
      assert.match(t, /vi\.spyOn\(globalThis, 'fetch'\)\.mockResolvedValue\(new Response\(JSON\.stringify\(body\)/);
      assert.match(t, /const body = \{ id: 1, name: 'Sample name 1', email: 'user1@example\.com' \};/);
      assert.match(t, /expect\(String\(url\)\)\.toContain\('\/users\/1'\);/);
      assert.match(t, /await expect\(getUser\(1\)\)\.rejects\.toThrow\(\);/);
      assert.match(cs.warnings.join('\n'), /No test runner found/);
      // A second run adds only what is missing, to the same file and import.
      apply(dir, cs);
      const more = await planTestAdd(dir, nextjs, { endpoints: [], all: true });
      const t2 = after(more, 'lib/api/users.test.ts')!;
      assert.match(t2, /import \{ getUser, updateUser \} from '\.\/users';/);
      assert.equal((t2.match(/describe\('getUser'/g) ?? []).length, 1);
      assert.match(t2, /describe\('updateUser'/);
    } finally {
      cleanup(dir);
    }
  });

  it('Jest projects get jest.spyOn; axios projects spy on the instance', async () => {
    const dir = copyFixture('nextjs-axios');
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      pkg.devDependencies.jest = '29.7.0';
      writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
      const cs = await planTestAdd(dir, nextjs, { endpoints: ['getContact'] });
      const t = after(cs, 'src/lib/api/contacts.test.ts')!;
      assert.doesNotMatch(t, /from 'vitest'/);
      assert.match(t, /import \{ api \} from '\.\/client';/);
      assert.match(t, /jest\.spyOn\(api, 'get'\)\.mockResolvedValue\(\{ data: body \} as never\);/);
    } finally {
      cleanup(dir);
    }
  });

  it('Flutter: a fake Dio adapter, method and path checks, typed results, and a DioException on 500', async () => {
    const dir = copyFixture('flutter-bloc-retrofit');
    try {
      const cs = await planTestAdd(dir, flutter, { endpoints: [], all: true });
      const t = after(cs, 'test/data/api/task_api_test.dart')!;
      assert.match(t, /class _FakeAdapter implements HttpClientAdapter \{/);
      assert.match(t, /group\('TaskApi\.getTask', \(\) \{/);
      assert.match(t, /final result = await TaskApi\(dio\)\.getTask\(1\);/);
      assert.match(t, /expect\(adapter\.last!\.uri\.path, endsWith\('\/tasks\/1'\)\);/);
      assert.match(t, /expect\(result, isA<Task>\(\)\);/);
      assert.match(t, /throwsA\(isA<DioException>\(\)\)/);
      assert.match(t, /import 'package:task_board\/models\/task\.dart';/);
      assert.equal(cs.warnings.length, 0, cs.warnings.join('\n'));
    } finally {
      cleanup(dir);
    }
  });

  it('Flutter request bodies are built with fromJson', async () => {
    const dir = copyFixture('flutter-riverpod');
    try {
      apply(dir, (await planApiSync(dir, flutter, { file: SPEC, add: true })).changeSet);
      const cs = await planTestAdd(dir, flutter, { endpoints: ['createUser'] });
      assert.match(after(cs, 'test/data/repositories/user_repository_test.dart')!, /\.createUser\(NewUserModel\.fromJson\(\{/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('stage D: custom templates', () => {
  it('render fills placeholders and reports unknown ones', () => {
    assert.deepEqual(render('{{a}}-{{ b }}-{{c}}', { a: '1', b: '2' }), { text: '1-2-{{c}}', unknown: ['c'] });
  });

  it('templates init writes files that reproduce the default output; list shows them', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      clearTemplateCache();
      const cs = planTemplatesInit(dir, ['api-function.ts']);
      assert.equal(after(cs, 'devtool/templates/api-function.ts.tmpl'), '{{default}}\n');
      apply(dir, cs);
      clearTemplateCache();
      assert.ok(listTemplates(dir).templates.find((t) => t.id === 'api-function.ts')!.custom);
      const plain = copyFixture('nextjs-helper');
      try {
        const opts = { url: 'https://api.example.com/orders', samples: [join(INPUTS, 'products.json')] };
        const a = (await planApiAdd(dir, nextjs, opts)).changeSet;
        const b = (await planApiAdd(plain, nextjs, opts)).changeSet;
        assert.equal(after(a, 'lib/api/orders.ts'), after(b, 'lib/api/orders.ts'));
      } finally {
        cleanup(plain);
      }
      await assert.rejects(async () => planTemplatesInit(dir, ['nope']), /Unknown template nope/);
    } finally {
      cleanup(dir);
    }
  });

  it('api function, Dart method and model templates wrap the output; file headers go on new files only', async () => {
    const dir = copyFixture('nextjs-helper');
    const fl = copyFixture('flutter-riverpod');
    try {
      clearTemplateCache();
      mkdirSync(join(dir, 'devtool/templates'), { recursive: true });
      writeFileSync(join(dir, 'devtool/templates/api-function.ts.tmpl'), '// {{method}} {{path}} → {{returnType}} ({{params}}) {{oops}}\n{{default}}\n');
      writeFileSync(join(dir, 'devtool/templates/file-header.ts.tmpl'), '// {{file}}\n');
      const { changeSet } = await planApiAdd(dir, nextjs, { url: 'https://api.example.com/orders/{id}', samples: [join(INPUTS, 'products.json')] });
      const api = after(changeSet, 'lib/api/orders.ts')!;
      assert.match(api, /^\/\/ lib\/api\/orders\.ts\n/);
      assert.match(api, /\/\/ GET \/orders\/\{id\} → Order\[\] \(id: string\) \{\{oops\}\}\n\/\*\* GET \/orders\/\{id\} \*\/\nexport function getOrder/);
      assert.match(changeSet.warnings.join('\n'), /unknown placeholders: \{\{oops\}\}/);
      assert.doesNotMatch(after(changeSet, 'types/index.ts') ?? '', /^\/\/ types/, 'existing files get no header');
      mkdirSync(join(fl, 'devtool/templates'), { recursive: true });
      writeFileSync(join(fl, 'devtool/templates/api-method.dart.tmpl'), '  // {{name}}: {{method}} {{path}}\n{{default}}\n');
      writeFileSync(join(fl, 'devtool/templates/model.dart.tmpl'), '// Model {{name}}\n{{default}}\n');
      const f = (await planApiAdd(fl, flutter, { url: 'https://api.example.com/orders', samples: [join(INPUTS, 'products.json')] })).changeSet;
      assert.ok(f.changes.some((c) => /\/\/ getOrders: GET \/orders\n  \/\/\/ GET \/orders/.test(c.after ?? '')));
      assert.ok(f.changes.some((c) => /^\/\/ Model OrderModel\n/.test(c.after ?? '')));
    } finally {
      clearTemplateCache();
      cleanup(dir);
      cleanup(fl);
    }
  });
});
