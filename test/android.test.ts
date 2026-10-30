// Android (Kotlin): detection, endpoints (Retrofit + Moshi/kotlinx), api
// rename/remove/update, Compose screens, setup and create.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import { renderDataClass, renderRetrofitFun } from '../src/adapters/kotlinGen.ts';
import { loadMap } from '../src/core/cache.ts';
import { applyChangeSet } from '../src/core/changeset.ts';
import { loadConfig } from '../src/core/config.ts';
import type { ChangeSet } from '../src/core/types.ts';
import { detectAt } from '../src/detector.ts';
import { planApiAdd } from '../src/skills/apiAdd.ts';
import { planApiRemove, planApiRename, planApiUpdate } from '../src/skills/apiEdit.ts';
import { createProject } from '../src/skills/create.ts';
import { planRouteAdd } from '../src/skills/route.ts';
import { planScreenAdd } from '../src/skills/screen.ts';
import { planSetup } from '../src/skills/setup.ts';
import { planTestAdd } from '../src/skills/testgen.ts';
import { planThemeSet } from '../src/skills/theme.ts';
import { cleanup, copyFixture, golden, INPUTS } from './helpers.ts';

const android = ADAPTERS.android;
const after = (cs: ChangeSet, path: string) => cs.changes.find((c) => c.path === path)?.after ?? null;
const apply = (dir: string, cs: ChangeSet) => applyChangeSet(dir, cs, { allowDirty: true, verify: false, format: false });
const P = 'app/src/main/java/dev/fieldops/app';

describe('Android: Kotlin generation', () => {
  it('data classes per serialization library, with optional fields defaulting to null', () => {
    const m = { name: 'Job', fields: [{ jsonName: 'id', type: { kind: 'int' as const }, nullable: false }, { jsonName: 'created_at', type: { kind: 'string' as const }, nullable: true }, { jsonName: 'object', type: { kind: 'bool' as const }, nullable: false }] };
    const k = renderDataClass(m, { serialization: 'kotlinx' }, 'a.b');
    assert.match(k, /@Serializable\ndata class Job\(/);
    assert.match(k, /@SerialName\("created_at"\) val createdAt: String\? = null,/);
    assert.match(k, /val `object`: Boolean,/);
    assert.match(renderDataClass(m, { serialization: 'moshi' }, 'a.b'), /@JsonClass\(generateAdapter = true\)[\s\S]*@Json\(name = "created_at"\)/);
    assert.match(renderDataClass(m, { serialization: 'gson' }, 'a.b'), /@SerializedName\("created_at"\)/);
  });

  it('Retrofit methods: relative path, @Path, @Query with null default, Unit for DELETE', () => {
    const spec = { method: 'DELETE' as const, path: '/jobs/{id}', name: 'deleteJob', pathParams: [{ name: 'id', type: 'int' as const }], queryParams: [], models: [], warnings: [] } as never;
    const { code, imports } = renderRetrofitFun(spec, {}, '/jobs/{id}');
    assert.match(code, /@DELETE\("jobs\/\{id\}"\)\n {4}suspend fun deleteJob\(@Path\("id"\) id: Int\)$/);
    assert.deepEqual(imports.sort(), ['retrofit2.http.DELETE', 'retrofit2.http.Path']);
  });
});

describe('Android: detection and scan', () => {
  it('Hilt + Moshi + Compose project (golden map)', async () => {
    const dir = copyFixture('android-app');
    try {
      assert.equal(detectAt(dir)?.framework, 'android');
      const { map } = await loadMap(dir, android, {});
      const c = map.conventions;
      assert.equal(c.namespace, 'dev.fieldops.app');
      assert.equal(c.serialization, 'moshi');
      assert.equal(c.di, 'hilt');
      assert.equal(c.baseUrl, 'https://api.fieldops.dev/v1/');
      assert.deepEqual(map.endpoints.map((e) => `${e.name} ${e.response}`), ['getJobs List<Job>', 'getJob Job']);
      assert.deepEqual(map.models[0].fields.map((f) => f.name), ['id', 'title', 'created_at', 'notes']);
      assert.deepEqual(map.endpoints[0].calledFrom, [`${P}/ui/jobs/JobsViewModel.kt`]);
      golden('maps/android-app.json', JSON.stringify(map, null, 2) + '\n');
    } finally {
      cleanup(dir);
    }
  });

  it('an Android project without Retrofit is still detected as Android', () => {
    const dir = copyFixture('android-plain');
    try {
      assert.equal(detectAt(dir)?.framework, 'android');
    } finally {
      cleanup(dir);
    }
  });
});

describe('Android: endpoints', () => {
  it('api add: Moshi data class, path relative to the base URL, new interface provided by Hilt', async () => {
    const dir = copyFixture('android-app');
    try {
      const { changeSet } = await planApiAdd(dir, android, { url: 'https://api.fieldops.dev/v1/crews/{crewId}/members', samples: [join(INPUTS, 'products.json')] });
      const model = after(changeSet, `${P}/data/model/Member.kt`)!;
      assert.match(model, /^package dev\.fieldops\.app\.data\.model\n/);
      assert.match(model, /@JsonClass\(generateAdapter = true\)\ndata class Member\(/);
      assert.match(model, /@Json\(name = "in_stock"\) val inStock: Boolean,/);
      const api = after(changeSet, `${P}/data/api/CrewApi.kt`)!;
      assert.match(api, /interface CrewApi \{\n {4}\/\*\* GET \/v1\/crews\/\{crewId\}\/members \*\/\n {4}@GET\("crews\/\{crewId\}\/members"\)\n {4}suspend fun getCrewMembers\(@Path\("crewId"\) crewId: String\): List<Member>\n\}/);
      assert.match(api, /import dev\.fieldops\.app\.data\.model\.Member/);
      const di = after(changeSet, `${P}/di/NetworkModule.kt`)!;
      assert.match(di, /fun provideCrewApi\(retrofit: Retrofit\): CrewApi = retrofit\.create\(CrewApi::class\.java\)\n\}/);
      assert.match(di, /import dev\.fieldops\.app\.data\.api\.CrewApi/);
    } finally {
      cleanup(dir);
    }
  });

  it('api add to an existing interface; a {"data": ...} envelope needs --no-unwrap', async () => {
    const dir = copyFixture('android-app');
    try {
      const { changeSet } = await planApiAdd(dir, android, { curl: `curl -X POST https://api.fieldops.dev/v1/jobs -d '{"title":"x"}'`, name: 'createJob', samples: [join(INPUTS, 'user.json')], modelName: 'CreatedJob' });
      const api = after(changeSet, `${P}/data/api/JobApi.kt`)!;
      assert.match(api, /suspend fun getJob\(@Path\("id"\) id: Int\): Job\n\n {4}\/\*\* POST \/v1\/jobs \*\/\n {4}@POST\("jobs"\)\n {4}suspend fun createJob\(@Body body: CreateJobRequest\): CreatedJob\n\}/);
      assert.equal(after(changeSet, `${P}/di/NetworkModule.kt`), null, 'JobApi is already provided');
      writeFileSync(join(dir, 'wrapped.json'), '{"data": [{"id": 1, "name": "Core"}]}');
      await assert.rejects(planApiAdd(dir, android, { url: 'https://api.fieldops.dev/v1/teams', samples: [join(dir, 'wrapped.json')] }), /wraps its data/);
    } finally {
      cleanup(dir);
    }
  });

  it('api rename follows the call in the ViewModel; remove drops the method and its unused import', async () => {
    const dir = copyFixture('android-app');
    try {
      const rn = await planApiRename(dir, android, 'getJobs', 'fetchJobs');
      assert.match(after(rn, `${P}/data/api/JobApi.kt`)!, /suspend fun fetchJobs\(@Query\("page"\) page: Int\? = null\): List<Job>/);
      assert.match(after(rn, `${P}/ui/jobs/JobsViewModel.kt`)!, /val jobs = api\.fetchJobs\(\)/);
      const rm = await planApiRemove(dir, android, 'getJob');
      const t = after(rm, `${P}/data/api/JobApi.kt`)!;
      assert.doesNotMatch(t, /getJob\(/);
      assert.doesNotMatch(t, /import retrofit2\.http\.Path/);
      assert.match(t, /import retrofit2\.http\.Query/);
      assert.match(t, /\/\*\* All jobs, newest first\. \*\//);
    } finally {
      cleanup(dir);
    }
  });

  it('api update rewrites the model in place, keeps @Query, and reports uses of removed fields', async () => {
    const dir = copyFixture('android-app');
    try {
      const { changeSet, changes } = await planApiUpdate(dir, android, 'getJobs', [join(INPUTS, 'products.json')]);
      assert.ok(changes.removed.includes('created_at'), JSON.stringify(changes));
      assert.match(after(changeSet, `${P}/data/api/JobApi.kt`)!, /suspend fun getJobs\(@Query\("page"\) page: Int\? = null\): List<Job>/);
      assert.match(after(changeSet, `${P}/data/model/Job.kt`)!, /@Json\(name = "in_stock"\) val inStock: Boolean,/);
      assert.match(changeSet.warnings.join('\n'), /JobsViewModel\.kt:\d+ +println\(jobs\.first\(\)\.createdAt\)/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('Android: Compose screens', () => {
  it('screen add (list): Hilt ViewModel with StateFlow, LazyColumn, NavHost entry', async () => {
    const dir = copyFixture('android-app');
    try {
      const cs = await planScreenAdd(dir, android, { name: 'job-list', api: 'getJobs' });
      const vm = after(cs, `${P}/ui/jobs/JobListViewModel.kt`)!;
      assert.match(vm, /@HiltViewModel\nclass JobListViewModel @Inject constructor\(private val api: JobApi\) : ViewModel\(\) \{/);
      assert.match(vm, /MutableStateFlow<UiState<List<Job>>>\(UiState\.Loading\)/);
      assert.match(vm, /UiState\.Success\(api\.getJobs\(\)\)/);
      const screen = after(cs, `${P}/ui/jobs/JobListScreen.kt`)!;
      assert.match(screen, /fun JobListScreen\(viewModel: JobListViewModel = hiltViewModel\(\)\)/);
      assert.match(screen, /Text\(item\.title\.toString\(\)/);
      assert.match(screen, /Button\(onClick = viewModel::load\) \{ Text\("Retry"\) \}/);
      assert.ok(after(cs, `${P}/ui/UiState.kt`));
      const nav = after(cs, `${P}/ui/FieldOpsNavHost.kt`)!;
      assert.match(nav, /composable\("jobs"\) \{ JobsScreen\(\) \}\n {8}composable\("job-list"\) \{\n {12}JobListScreen\(\)\n {8}\}\n {4}\}/);
      assert.match(nav, /import dev\.fieldops\.app\.ui\.jobs\.JobListScreen/);
    } finally {
      cleanup(dir);
    }
  });

  it('screen add (details): the route parameter comes from SavedStateHandle and is converted to Int', async () => {
    const dir = copyFixture('android-app');
    try {
      const cs = await planScreenAdd(dir, android, { name: 'job', api: 'getJob', path: '/jobs/:id' });
      const vm = after(cs, `${P}/ui/jobs/JobViewModel.kt`)!;
      assert.match(vm, /constructor\(private val api: JobApi, savedStateHandle: SavedStateHandle\)/);
      assert.match(vm, /private val id: String = checkNotNull\(savedStateHandle\["id"\]\)/);
      assert.match(vm, /api\.getJob\(id\.toInt\(\)\)/);
      assert.match(after(cs, `${P}/ui/jobs/JobScreen.kt`)!, /Text\(s\.data\.createdAt\?\.toString\(\)\.orEmpty\(\)/);
      assert.match(after(cs, `${P}/ui/FieldOpsNavHost.kt`)!, /composable\("jobs\/\{id\}"\)/);
      await assert.rejects(planScreenAdd(dir, android, { name: 'job2', api: 'getJob' }), /needs id/);
    } finally {
      cleanup(dir);
    }
  });

  it('screen add --form: a field per property, numbers parsed, submit through the ViewModel', async () => {
    const dir = copyFixture('android-app');
    try {
      apply(dir, (await planApiAdd(dir, android, { curl: `curl -X POST https://api.fieldops.dev/v1/jobs -d '{"title":"x","priority":2,"urgent":true}'`, name: 'createJob', samples: [join(INPUTS, 'user.json')], modelName: 'CreatedJob' })).changeSet);
      const cs = await planScreenAdd(dir, android, { name: 'new-job', api: 'createJob', form: true });
      const screen = after(cs, `${P}/ui/jobs/NewJobScreen.kt`)!;
      assert.match(screen, /priority = priority\.toIntOrNull\(\) \?: 0,/);
      assert.match(screen, /Switch\(checked = urgent, onCheckedChange = \{ urgent = it \}\)/);
      assert.match(screen, /KeyboardOptions\(keyboardType = KeyboardType\.Number\)/);
      const vm = after(cs, `${P}/ui/jobs/NewJobViewModel.kt`)!;
      assert.match(vm, /fun submit\(body: CreateJobRequest\)/);
      assert.match(vm, /import dev\.fieldops\.app\.data\.model\.CreatedJob/);
    } finally {
      cleanup(dir);
    }
  });

  it('route add: a screen with String parameters read from the back stack entry', async () => {
    const dir = copyFixture('android-app');
    try {
      const cs = await planRouteAdd(dir, android, { name: 'crew', path: '/crews/:crewId' });
      assert.match(after(cs, `${P}/ui/jobs/CrewScreen.kt`)!, /fun CrewScreen\(crewId: String\)/);
      assert.match(after(cs, `${P}/ui/FieldOpsNavHost.kt`)!, /composable\("crews\/\{crewId\}"\) \{ entry ->\n {12}CrewScreen\(crewId = entry\.arguments\?\.getString\("crewId"\)\.orEmpty\(\)\)/);
      apply(dir, cs);
      await assert.rejects(planRouteAdd(dir, android, { name: 'crew2', path: '/crews/:crewId' }), /already has a route/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('Android: tests and theme', () => {
  it('test add writes MockWebServer tests with the Moshi converter and adds test dependencies', async () => {
    const dir = copyFixture('android-app');
    try {
      const cs = await planTestAdd(dir, android, { endpoints: [], all: true });
      const t = after(cs, 'app/src/test/java/dev/fieldops/app/data/api/JobApiTest.kt')!;
      assert.match(t, /\.addConverterFactory\(MoshiConverterFactory\.create\(Moshi\.Builder\(\)\.build\(\)\)\)/);
      assert.match(t, /val result = api\.getJob\(id = 1\)\n\n {8}val request = server\.takeRequest\(\)\n {8}assertEquals\("GET", request\.method\)\n {8}assertEquals\("\/jobs\/1", request\.path\?\.substringBefore\('\?'\)\)/);
      assert.match(t, /"created_at\\":/);
      assert.match(t, /fun `getJobs throws HttpException on a server error`\(\) = runTest/);
      assert.match(after(cs, 'gradle/libs.versions.toml')!, /okhttp-mockwebserver = \{ group = "com\.squareup\.okhttp3"/);
      assert.match(after(cs, 'app/build.gradle.kts')!, /testImplementation\(libs\.okhttp\.mockwebserver\)/);
      apply(dir, cs);
      const again = await planTestAdd(dir, android, { endpoints: ['getJob'] });
      assert.equal(again.changes.length, 0);
    } finally {
      cleanup(dir);
    }
  });

  it('theme set writes Color.kt and Dimens.kt', async () => {
    const dir = copyFixture('android-app');
    try {
      const cs = await planThemeSet(dir, android, [{ name: 'primary', value: '#0F766E' }, { name: 'radius', value: '12' }]);
      assert.match(after(cs, `${P}/ui/theme/Color.kt`)!, /^package dev\.fieldops\.app\.ui\.theme\n\nimport androidx\.compose\.ui\.graphics\.Color\n\nval Primary = Color\(0xFF0F766E\)\n$/);
      assert.match(after(cs, `${P}/ui/theme/Dimens.kt`)!, /val Radius = 12\.dp/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('Android: setup and create', () => {
  it('setup without a version catalog adds plugins and dependencies straight into build.gradle.kts', async () => {
    const dir = copyFixture('android-plain');
    try {
      const { map } = await loadMap(dir, android, {});
      const { changeSet } = planSetup(dir, android, map, { architecture: 'retrofit', baseUrl: 'https://api.notes.dev' });
      const build = after(changeSet, 'app/build.gradle.kts')!;
      assert.match(build, /id\("org\.jetbrains\.kotlin\.plugin\.serialization"\) version "2\.0\.21"/);
      assert.match(build, /implementation\("com\.squareup\.retrofit2:retrofit:2\.11\.0"\)/);
      assert.match(after(changeSet, 'app/src/main/AndroidManifest.xml')!, /<uses-permission android:name="android\.permission\.INTERNET" \/>/);
      assert.match(after(changeSet, 'app/src/main/java/com/example/notes/data/remote/ApiConfig.kt')!, /const val BASE_URL = "https:\/\/api\.notes\.dev\/"/);
      assert.match(after(changeSet, 'app/src/main/java/com/example/notes/data/remote/ServiceLocator.kt')!, /object ServiceLocator \{/);
    } finally {
      cleanup(dir);
    }
  });

  for (const architecture of ['retrofit-hilt', 'retrofit-koin', 'retrofit']) {
    it(`create ${architecture}: catalog, network module, then api add and screen add`, async () => {
      const parent = mkdtempSync(join(tmpdir(), 'devtool-android-'));
      try {
        const r = await createProject({ type: 'android', name: 'shop-app', parent, architecture, baseUrl: 'https://api.shop.dev/v1', org: 'com.acme', primary: '#0F766E', install: false, git: false });
        const S = 'app/src/main/java/com/acme/shopapp';
        const read = (p: string) => readFileSync(join(r.dir, p), 'utf8');
        assert.equal(loadConfig(r.dir).framework, 'android');
        const catalog = read('gradle/libs.versions.toml');
        for (const lib of ['retrofit = {', 'retrofit-kotlinx-serialization = {', 'kotlinx-serialization-json = {']) assert.ok(catalog.includes(lib), lib);
        assert.match(catalog, /kotlin-serialization = \{ id = "org\.jetbrains\.kotlin\.plugin\.serialization"/);
        assert.match(read(`${S}/ui/theme/Color.kt`), /Color\(0xFF0F766E\)/);
        assert.match(read(`${S}/data/remote/ApiConfig.kt`), /BASE_URL = "https:\/\/api\.shop\.dev\/v1\/"/);
        if (architecture === 'retrofit-hilt') {
          assert.match(catalog, /^hilt = \{ id = "com\.google\.dagger\.hilt\.android"/m);
          assert.match(read(`${S}/MainActivity.kt`), /@AndroidEntryPoint\nclass MainActivity/);
          assert.match(read('app/src/main/AndroidManifest.xml'), /android:name="\.App"/);
        }
        if (architecture === 'retrofit-koin') assert.match(read(`${S}/App.kt`), /modules\(networkModule\)/);
        const add = await planApiAdd(r.dir, android, { url: 'https://api.shop.dev/v1/products', samples: [join(INPUTS, 'products.json')] });
        assert.match(after(add.changeSet, `${S}/data/remote/ProductApi.kt`)!, /@GET\("products"\)/);
        apply(r.dir, add.changeSet);
        const screen = await planScreenAdd(r.dir, android, { name: 'products', api: 'getProducts' });
        const def = architecture === 'retrofit-hilt' ? 'hiltViewModel()' : architecture === 'retrofit-koin' ? 'koinViewModel()' : 'viewModel(factory = ProductsViewModel.Factory)';
        assert.ok(after(screen, `${S}/ui/screens/ProductsScreen.kt`)!.includes(`viewModel: ProductsViewModel = ${def}`));
        if (architecture === 'retrofit') assert.match(after(screen, `${S}/ui/screens/ProductsViewModel.kt`)!, /initializer \{ ProductsViewModel\(ServiceLocator\.productApi\) \}/);
        if (architecture === 'retrofit-koin') assert.match(after(screen, `${S}/di/NetworkModule.kt`)!, /viewModelOf\(::ProductsViewModel\)/);
        assert.match(after(screen, `${S}/ui/navigation/AppNavHost.kt`)!, /composable\("products"\)/);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    });
  }

  it('create with no architecture is plain Compose with navigation', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'devtool-android-'));
    try {
      const r = await createProject({ type: 'android', name: 'notes', parent, architecture: 'none', baseUrl: '', org: 'com.acme', install: false, git: false });
      assert.ok(existsSync(join(r.dir, 'app/src/main/java/com/acme/notes/ui/navigation/AppNavHost.kt')));
      assert.doesNotMatch(readFileSync(join(r.dir, 'gradle/libs.versions.toml'), 'utf8'), /retrofit/);
      await assert.rejects(createProject({ type: 'android', name: 'Notes App', parent, architecture: 'none', baseUrl: '', org: 'com.acme', install: false, git: false }), /cannot be a/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
