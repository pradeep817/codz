// Stage C: more stacks. axios and TanStack Query (Next.js); freezed models,
// Retrofit clients and Cubit screens (Flutter).

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import { parseFreezedFields, scanRetrofit } from '../src/adapters/flutterStyles.ts';
import { hookName, splitTsParams } from '../src/adapters/reactQuery.ts';
import { loadMap } from '../src/core/cache.ts';
import type { ChangeSet } from '../src/core/types.ts';
import { planApiAdd } from '../src/skills/apiAdd.ts';
import { planApiRemove, planApiRename, planApiUpdate } from '../src/skills/apiEdit.ts';
import { planMockAdd } from '../src/skills/mock.ts';
import { planScreenAdd } from '../src/skills/screen.ts';
import { cleanup, copyFixture, INPUTS } from './helpers.ts';

const { flutter, nextjs } = ADAPTERS;
const after = (cs: ChangeSet, path: string) => cs.changes.find((c) => c.path === path)?.after ?? null;
const sample = (f: string) => join(INPUTS, f);

describe('stage C: Next.js with axios', () => {
  it('detects the axios instance and TanStack Query', async () => {
    const dir = copyFixture('nextjs-axios');
    try {
      const { map } = await loadMap(dir, nextjs, {});
      assert.equal(map.conventions.http, 'axios');
      assert.equal(map.conventions.axiosInstance, 'api');
      assert.equal(map.conventions.axiosInstanceFile, 'src/lib/api/client.ts');
      assert.equal(map.conventions.dataFetching, 'react-query');
      assert.equal(map.conventions.hooksFolder, 'src/hooks');
      assert.deepEqual(map.endpoints.map((e) => e.name).sort(), ['deleteContact', 'getContact']);
      assert.ok(!map.notes.some((n) => /axios/.test(n)), 'axios is no longer reported as unsupported');
    } finally {
      cleanup(dir);
    }
  });

  it('a default-exported instance is imported as a default', async () => {
    const dir = copyFixture('nextjs-axios');
    try {
      writeFileSync(join(dir, 'src/lib/api/client.ts'), "import axios from 'axios';\n\nconst http = axios.create({ baseURL: process.env.NEXT_PUBLIC_API_URL });\n\nexport default http;\n");
      writeFileSync(join(dir, 'src/lib/api/contacts.ts'), "import http from './client';\n\nexport async function getContact(id: number): Promise<unknown> {\n  const res = await http.get(`/contacts/${id}`);\n  return res.data;\n}\n");
      const { changeSet } = await planApiAdd(dir, nextjs, { url: 'https://api.crm.dev/v1/deals', samples: [sample('products.json')] });
      const t = after(changeSet, 'src/lib/api/deals.ts')!;
      assert.match(t, /^import http from '\.\/client';/m);
      assert.match(t, /await http\.get<Deal\[\]>\(`\/deals`\)/);
    } finally {
      cleanup(dir);
    }
  });

  it('axios itself (no instance): calls axios with the base URL from the environment', async () => {
    const dir = copyFixture('nextjs-axios');
    try {
      writeFileSync(join(dir, 'src/lib/api/client.ts'), 'export {};\n');
      writeFileSync(join(dir, 'src/lib/api/contacts.ts'), "import axios from 'axios';\n\nexport async function getContact(id: number): Promise<unknown> {\n  const res = await axios.get(`${process.env.NEXT_PUBLIC_API_URL}/contacts/${id}`);\n  return res.data;\n}\n");
      const { changeSet } = await planApiAdd(dir, nextjs, { url: 'https://api.crm.dev/v1/deals?page=1', samples: [sample('products.json')] });
      const t = after(changeSet, 'src/lib/api/deals.ts')!;
      assert.match(t, /^import axios from 'axios';/m);
      assert.match(t, /axios\.get<Deal\[\]>\(`\$\{process\.env\.NEXT_PUBLIC_API_URL\}\/deals`, \{ params \}\)/);
    } finally {
      cleanup(dir);
    }
  });

  it('mock add hooks a request interceptor into the instance; never touches .env.local', async () => {
    const dir = copyFixture('nextjs-axios');
    try {
      writeFileSync(join(dir, '.env.local'), 'SECRET=1\n');
      const cs = await planMockAdd(dir, nextjs, { endpoints: [], all: true });
      const client = after(cs, 'src/lib/api/client.ts')!;
      assert.match(client, /import \{ findMock \} from '\.\/mocks';/);
      assert.match(client, /api\.interceptors\.request\.use\(\(config\) => \{/);
      assert.ok(after(cs, 'src/lib/api/mocks.ts'));
      assert.match(after(cs, '.env.example')!, /NEXT_PUBLIC_USE_MOCKS=false/);
      assert.equal(after(cs, '.env.local'), null);
    } finally {
      cleanup(dir);
    }
  });
});

describe('stage C: TanStack Query hooks', () => {
  it('names and parameters', () => {
    assert.equal(hookName('getUser'), 'useUser');
    assert.equal(hookName('listUsers'), 'useListUsers');
    assert.equal(hookName('getaway'), 'useGetaway');
    assert.deepEqual(splitTsParams('id: number, params?: { a?: string; b?: number }'), [
      { name: 'id', type: 'number', optional: false },
      { name: 'params', type: '{ a?: string; b?: number }', optional: true },
    ]);
  });

  it('a query for GET, a mutation that invalidates the resource for the rest, added to the existing hooks file', async () => {
    const dir = copyFixture('nextjs-axios');
    try {
      const { changeSet: get } = await planApiAdd(dir, nextjs, { url: 'https://api.crm.dev/v1/contacts/{id}/notes?page=1', samples: [sample('products.json')], name: 'getContactNotes' });
      const hooks = after(get, 'src/hooks/use-contact.ts')!;
      assert.match(hooks, /export function useContactNotes\(id: string, params\?: \{ page\?: number \}\) \{\n  return useQuery\(\{\n    queryKey: \['contacts', id, params\],\n    queryFn: \(\) => getContactNotes\(id, params\),/);
      assert.match(hooks, /import \{ getContact, getContactNotes \} from '@\/lib\/api\/contacts';/);
      const { changeSet: del } = await planApiAdd(dir, nextjs, { curl: 'curl -X DELETE https://api.crm.dev/v1/contacts/4/notes/2', name: 'deleteContactNote' });
      assert.match(after(del, 'src/hooks/use-contact.ts')!, /mutationFn: \(\{ contactId, id \}: \{ contactId: number; id: number \}\) => deleteContactNote\(contactId, id\),\n    onSuccess: \(\) => queryClient\.invalidateQueries\(\{ queryKey: \['contacts'\] \}\),/);
    } finally {
      cleanup(dir);
    }
  });

  it('no hooks when the project does not use TanStack Query', async () => {
    const dir = copyFixture('nextjs-axios');
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      delete pkg.dependencies['@tanstack/react-query'];
      writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
      const { changeSet } = await planApiAdd(dir, nextjs, { url: 'https://api.crm.dev/v1/deals', samples: [sample('products.json')] });
      assert.ok(!changeSet.changes.some((c) => c.path.startsWith('src/hooks/')));
    } finally {
      cleanup(dir);
    }
  });
});

describe('stage C: freezed', () => {
  it('reads fields from the factory constructor, with JSON names, defaults and nullability', () => {
    const body = "\n  const Task._();\n  const factory Task({\n    required int id,\n    @JsonKey(name: 'due_at') DateTime? dueAt,\n    @Default(false) bool done,\n    @Default(<String>[]) List<String> tags,\n  }) = _Task;\n";
    assert.deepEqual(parseFreezedFields(body, 'Task'), [
      { name: 'id', type: 'int', nullable: false },
      { name: 'due_at', type: 'DateTime', nullable: true },
      { name: 'done', type: 'bool', nullable: false },
      { name: 'tags', type: 'List<String>', nullable: false },
    ]);
  });

  it('api add writes freezed models in the project style (freezed 2: plain class)', async () => {
    const dir = copyFixture('flutter-bloc-retrofit');
    try {
      const task = readFileSync(join(dir, 'lib/models/task.dart'), 'utf8').replace('abstract class Task', 'class Task');
      writeFileSync(join(dir, 'lib/models/task.dart'), task);
      const { changeSet } = await planApiAdd(dir, flutter, { url: 'https://api.taskboard.dev/v1/labels', samples: [sample('products.json')] });
      const label = after(changeSet, 'lib/models/label.dart')!;
      assert.match(label, /^@freezed\nclass Label with _\$Label \{/m);
      assert.match(label, /@JsonKey\(name: 'in_stock'\) required bool inStock,/);
      assert.match(label, /part 'label\.freezed\.dart';\npart 'label\.g\.dart';/);
    } finally {
      cleanup(dir);
    }
  });

  it('api update keeps @Default values and hand-written members', async () => {
    const dir = copyFixture('flutter-bloc-retrofit');
    try {
      writeFileSync(join(dir, 'task-v2.json'), JSON.stringify({ id: 1, title: 'x', due_at: '2026-01-01T00:00:00Z', done: true, priority: 2 }));
      const { changeSet: cs } = await planApiUpdate(dir, flutter, 'getTask', ['task-v2.json']);
      const t = after(cs, 'lib/models/task.dart')!;
      assert.match(t, /@Default\(false\) bool done,/);
      assert.match(t, /required int priority,/);
      assert.match(t, /const Task\._\(\);/);
      assert.match(t, /bool get overdue/);
      assert.equal((t.match(/const factory Task\(/g) ?? []).length, 1, 'the factory is regenerated, not kept twice');
      assert.match(after(cs, 'lib/data/api/task_api.dart')!, /Future<Task> getTask\(@Path\('id'\) int id\);/, 'the path parameter keeps its int type');
      assert.doesNotMatch(cs.warnings.join('\n'), /baseUrl ends in/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('stage C: Retrofit', () => {
  it('scans annotated methods', () => {
    const t = "@RestApi()\nabstract class A {\n  @GET('/a/{id}')\n  @Headers(<String, dynamic>{'x': 1})\n  Future<List<A>> getA(@Path('id') int id);\n  @DELETE(\"/a/{id}\")\n  Future<void> deleteA(@Path() int id);\n}\n";
    assert.deepEqual(scanRetrofit(t), [
      { method: 'GET', path: '/a/{id}', response: 'List<A>', name: 'getA' },
      { method: 'DELETE', path: '/a/{id}', response: 'void', name: 'deleteA' },
    ]);
  });

  it('api add: a method on the existing client, or a new client registered with get_it', async () => {
    const dir = copyFixture('flutter-bloc-retrofit');
    try {
      const { changeSet: same } = await planApiAdd(dir, flutter, { curl: `curl -X PATCH https://api.taskboard.dev/v1/tasks/3 -d '{"done":true}'`, name: 'updateTask', samples: [sample('user.json')], modelName: 'TaskResult' });
      const api = after(same, 'lib/data/api/task_api.dart')!;
      assert.match(api, /  @PATCH\('\/tasks\/\{id\}'\)\n  Future<TaskResult> updateTask\(@Path\('id'\) int id, @Body\(\) UpdateTaskRequest body\);/);
      assert.equal(after(same, 'lib/di.dart'), null);
      const { changeSet: fresh } = await planApiAdd(dir, flutter, { url: 'https://api.taskboard.dev/v1/projects/{projectId}/members?role=admin', samples: [sample('products.json')] });
      assert.match(after(fresh, 'lib/data/api/project_api.dart')!, /factory ProjectApi\(Dio dio, \{String\? baseUrl\}\) = _ProjectApi;/);
      assert.match(after(fresh, 'lib/di.dart')!, /getIt\.registerLazySingleton<ProjectApi>\(\(\) => ProjectApi\(getIt\(\)\)\);/);
      assert.match(fresh.warnings.join('\n'), /build_runner build/);
    } finally {
      cleanup(dir);
    }
  });

  it('a {"data": ...} envelope asks for --no-unwrap', async () => {
    const dir = copyFixture('flutter-bloc-retrofit');
    try {
      writeFileSync(join(dir, 'env.json'), JSON.stringify({ data: [{ id: 1 }] }));
      await assert.rejects(planApiAdd(dir, flutter, { url: 'https://api.taskboard.dev/v1/labels', samples: [join(dir, 'env.json')] }), (e: Error & { hint?: string }) => /--no-unwrap/.test(e.hint ?? ''));
    } finally {
      cleanup(dir);
    }
  });

  it('rename and remove handle abstract methods and their annotations', async () => {
    const dir = copyFixture('flutter-bloc-retrofit');
    try {
      const rn = await planApiRename(dir, flutter, 'getTasks', 'fetchTasks');
      assert.match(after(rn, 'lib/data/api/task_api.dart')!, /@GET\('\/tasks'\)\n  Future<List<Task>> fetchTasks\(\);/);
      assert.match(after(rn, 'lib/features/tasks/tasks_cubit.dart')!, /_api\.fetchTasks\(\)/);
      const rm = await planApiRemove(dir, flutter, 'getTask');
      const t = after(rm, 'lib/data/api/task_api.dart')!;
      assert.doesNotMatch(t, /getTask\b|@GET\('\/tasks\/\{id\}'\)/);
      assert.match(t, /Future<List<Task>> getTasks\(\);\n\}/);
    } finally {
      cleanup(dir);
    }
  });

  it('mock add hooks into Dio created inside a get_it registration', async () => {
    const dir = copyFixture('flutter-bloc-retrofit');
    try {
      const cs = await planMockAdd(dir, flutter, { endpoints: [], all: true });
      assert.match(after(cs, 'lib/di.dart')!, /Dio\(BaseOptions\(baseUrl: 'https:\/\/api\.taskboard\.dev\/v1'\)\)\.\.interceptors\.addAll\(\[if \(MockInterceptor\.enabled\) MockInterceptor\(\)\]\)\);/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('stage C: Bloc screens', () => {
  it('screen add writes a Cubit with sealed states and a BlocProvider page', async () => {
    const dir = copyFixture('flutter-bloc-retrofit');
    try {
      const cs = await planScreenAdd(dir, flutter, { name: 'task-details', api: 'getTask', path: '/tasks/:id' });
      const cubit = after(cs, 'lib/features/task_details/task_details_cubit.dart')!;
      assert.match(cubit, /sealed class TaskDetailsState \{/);
      assert.match(cubit, /emit\(TaskDetailsLoaded\(await _api\.getTask\(int\.parse\(id\)\)\)\);/);
      const page = after(cs, 'lib/features/task_details/task_details_page.dart')!;
      assert.match(page, /create: \(context\) => TaskDetailsCubit\(getIt<TaskApi>\(\), id: id\)\.\.load\(\),/);
      assert.match(page, /TaskDetailsFailure\(:final message\) =>/);
      assert.match(after(cs, 'lib/router.dart')!, /TaskDetailsPage\(id: state\.pathParameters\['id'\]!\)/);
    } finally {
      cleanup(dir);
    }
  });

  it('without get_it the page reads the API with context.read and says how to provide it', async () => {
    const dir = copyFixture('flutter-bloc-retrofit');
    try {
      writeFileSync(join(dir, 'lib/di.dart'), 'void setupDependencies() {}\n');
      const cs = await planScreenAdd(dir, flutter, { name: 'tasks-list', api: 'getTasks' });
      assert.match(after(cs, 'lib/features/tasks_list/tasks_list_page.dart')!, /TasksListCubit\(context\.read<TaskApi>\(\)\)\.\.load\(\)/);
      assert.match(cs.warnings.join('\n'), /RepositoryProvider/);
    } finally {
      cleanup(dir);
    }
  });
});
