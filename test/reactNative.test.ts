// React Native: detection, endpoints, screens (React Navigation and Expo
// Router), forms, mocks, tests, theme, setup and create.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import { loadMap } from '../src/core/cache.ts';
import { applyChangeSet } from '../src/core/changeset.ts';
import { loadConfig } from '../src/core/config.ts';
import type { ChangeSet } from '../src/core/types.ts';
import { detectAt } from '../src/detector.ts';
import { planApiAdd } from '../src/skills/apiAdd.ts';
import { planApiRename } from '../src/skills/apiEdit.ts';
import { planApiSync } from '../src/skills/apiSync.ts';
import { createProject } from '../src/skills/create.ts';
import { planMockAdd } from '../src/skills/mock.ts';
import { planRouteAdd } from '../src/skills/route.ts';
import { planScreenAdd } from '../src/skills/screen.ts';
import { planTestAdd } from '../src/skills/testgen.ts';
import { planThemeSet } from '../src/skills/theme.ts';
import { cleanup, copyFixture, golden, INPUTS } from './helpers.ts';

const rn = ADAPTERS['react-native'];
const after = (cs: ChangeSet, path: string) => cs.changes.find((c) => c.path === path)?.after ?? null;
const apply = (dir: string, cs: ChangeSet) => applyChangeSet(dir, cs, { allowDirty: true, verify: false, format: false });

describe('React Native: detection and scan', () => {
  it('bare React Native with React Navigation (golden map)', async () => {
    const dir = copyFixture('rn-app');
    try {
      assert.equal(detectAt(dir)?.framework, 'react-native');
      const { map } = await loadMap(dir, rn, {});
      assert.equal(map.conventions.flavor, 'bare');
      assert.equal(map.conventions.router, 'react-navigation');
      assert.equal(map.conventions.httpHelper, 'apiFetch');
      assert.equal(map.conventions.configFile, 'src/config/env.ts');
      assert.deepEqual(map.routes.map((r) => r.name), ['Home']);
      assert.deepEqual(map.endpoints.map((e) => e.name).sort(), ['getJob', 'getJobs']);
      golden('maps/rn-app.json', JSON.stringify(map, null, 2) + '\n');
    } finally {
      cleanup(dir);
    }
  });

  it('Expo with Expo Router and an axios instance', async () => {
    const dir = copyFixture('rn-expo-router');
    try {
      assert.match(detectAt(dir)!.label, /Expo/);
      const { map } = await loadMap(dir, rn, {});
      assert.equal(map.conventions.flavor, 'expo');
      assert.equal(map.conventions.router, 'expo-router');
      assert.equal(map.conventions.axiosInstance, 'http');
      assert.deepEqual(map.routes.map((r) => r.path), ['/', '/jobs/{id}']);
    } finally {
      cleanup(dir);
    }
  });
});

describe('React Native: endpoints', () => {
  it('api add goes through the existing helper, relative imports, and rename follows the screen', async () => {
    const dir = copyFixture('rn-app');
    try {
      const { changeSet } = await planApiAdd(dir, rn, { url: 'https://api.fieldops.dev/v1/crews/{crewId}/members', samples: [join(INPUTS, 'products.json')] });
      const t = after(changeSet, 'src/api/crews.ts')!;
      assert.match(t, /import \{ apiFetch \} from '\.\/client';/);
      assert.match(t, /import type \{ Member \} from '\.\.\/types\/member';/);
      assert.match(t, /return apiFetch<Member\[\]>\(`\/crews\/\$\{crewId\}\/members`\);/);
      const rn2 = await planApiRename(dir, rn, 'getJobs', 'fetchJobs');
      assert.match(after(rn2, 'src/screens/HomeScreen.tsx')!, /fetchJobs\(\)\.then\(setJobs\)/);
    } finally {
      cleanup(dir);
    }
  });

  it('api sync works the same way', async () => {
    const dir = copyFixture('rn-app');
    try {
      const r = await planApiSync(dir, rn, { file: join(INPUTS, 'shop-openapi.yaml'), add: true });
      assert.ok(r.added.length >= 4, r.changeSet.summary.join('\n'));
    } finally {
      cleanup(dir);
    }
  });
});

describe('React Native: screens and routes', () => {
  it('route add with React Navigation: a screen, a typed param, and a Stack.Screen entry', async () => {
    const dir = copyFixture('rn-app');
    try {
      const cs = await planRouteAdd(dir, rn, { name: 'job-details', path: '/jobs/:id' });
      const screen = after(cs, 'src/screens/JobDetailsScreen.tsx')!;
      assert.match(screen, /export default function JobDetailsScreen\(\{ route \}: NativeStackScreenProps<RootStackParamList, 'JobDetails'>\)/);
      assert.match(screen, /const \{ id \} = route\.params;/);
      const nav = after(cs, 'src/navigation/RootNavigator.tsx')!;
      assert.match(nav, /  JobDetails: \{ id: string \};\n\};/);
      assert.match(nav, /<Stack\.Screen name="JobDetails" component=\{JobDetailsScreen\} \/>\n    <\/Stack\.Navigator>/);
      assert.match(nav, /import JobDetailsScreen from '\.\.\/screens\/JobDetailsScreen';/);
      apply(dir, cs);
      await assert.rejects(planRouteAdd(dir, rn, { name: 'job-details' }), /already exists|already has a screen/);
    } finally {
      cleanup(dir);
    }
  });

  it('screen add loads the endpoint with loading, error + Retry and a FlatList', async () => {
    const dir = copyFixture('rn-app');
    try {
      const list = await planScreenAdd(dir, rn, { name: 'jobs', api: 'getJobs' });
      const t = after(list, 'src/screens/JobsScreen.tsx')!;
      assert.match(t, /setData\(await getJobs\(\)\);/);
      assert.match(t, /<FlatList/);
      assert.match(t, /keyExtractor=\{\(item, index\) => String\(item\.id\)\}/);
      assert.match(t, /<Button title="Retry" onPress=\{\(\) => load\(\)\} \/>/);
      const one = await planScreenAdd(dir, rn, { name: 'job', api: 'getJob', path: '/jobs/:id' });
      assert.match(after(one, 'src/screens/JobScreen.tsx')!, /await getJob\(Number\(id\)\)/);
      await assert.rejects(planScreenAdd(dir, rn, { name: 'job2', api: 'getJob' }), /needs id/);
    } finally {
      cleanup(dir);
    }
  });

  it('Expo Router: files under app/ with useLocalSearchParams', async () => {
    const dir = copyFixture('rn-expo-router');
    try {
      apply(dir, (await planApiAdd(dir, rn, { url: 'https://api.crew.dev/crews/{id}', samples: [join(INPUTS, 'user.json')] })).changeSet);
      const cs = await planScreenAdd(dir, rn, { name: 'crew', api: 'getCrew', path: '/crews/:id' });
      const t = after(cs, 'app/crews/[id].tsx')!;
      assert.match(t, /const \{ id \} = useLocalSearchParams<\{ id: string \}>\(\);/);
      assert.match(t, /await getCrew\(id\)/);
      assert.equal(cs.changes.length, 1, 'no navigator to update');
    } finally {
      cleanup(dir);
    }
  });

  it('screen add --form: inputs per field, numbers converted, Alert on result', async () => {
    const dir = copyFixture('rn-app');
    try {
      apply(dir, (await planApiAdd(dir, rn, { curl: `curl -X POST https://api.fieldops.dev/v1/jobs -d '{"title":"x","priority":2,"urgent":true}'`, name: 'createJob', samples: [join(INPUTS, 'user.json')], modelName: 'CreatedJob' })).changeSet);
      const cs = await planScreenAdd(dir, rn, { name: 'new-job', api: 'createJob', form: true });
      const t = after(cs, 'src/screens/NewJobScreen.tsx')!;
      assert.match(t, /priority: Number\(values\.priority\),/);
      assert.match(t, /<Switch value=\{values\.urgent\}/);
      assert.match(t, /keyboardType="numeric"/);
      assert.match(t, /await createJob\(body\);/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('React Native: mocks, tests, theme', () => {
  it('mock add uses USE_MOCKS from the config file', async () => {
    const dir = copyFixture('rn-app');
    try {
      const cs = await planMockAdd(dir, rn, { endpoints: [], all: true });
      const client = after(cs, 'src/api/client.ts')!;
      assert.match(client, /import \{ API_URL, USE_MOCKS \} from '\.\.\/config\/env';/);
      assert.match(client, /if \(USE_MOCKS\) \{/);
      assert.ok(after(cs, 'src/api/mocks.ts'));
      assert.match(cs.summary.join('\n'), /setting USE_MOCKS = true in src\/config\/env\.ts/);
    } finally {
      cleanup(dir);
    }
  });

  it('test add writes Jest tests (the React Native default)', async () => {
    const dir = copyFixture('rn-app');
    try {
      const cs = await planTestAdd(dir, rn, { endpoints: ['getJob'] });
      const t = after(cs, 'src/api/jobs.test.ts')!;
      assert.doesNotMatch(t, /vitest/);
      assert.match(t, /jest\.spyOn\(globalThis, 'fetch'\)/);
    } finally {
      cleanup(dir);
    }
  });

  it('theme set writes src/theme/index.ts', async () => {
    const dir = copyFixture('rn-app');
    try {
      const cs = await planThemeSet(dir, rn, [{ name: 'primary', value: '#0F766E' }, { name: 'radius', value: '12' }]);
      assert.equal(after(cs, 'src/theme/index.ts'), "export const colors = {\n  primary: '#0F766E',\n};\n\nexport const sizes = {\n  radius: 12,\n};\n\nexport const fonts = {\n};\n");
    } finally {
      cleanup(dir);
    }
  });
});

describe('React Native: setup and create', () => {
  for (const flavor of ['expo', 'bare'] as const) {
    for (const architecture of ['fetch-helper', 'axios', 'axios-react-query']) {
      it(`create ${flavor} + ${architecture}: navigation, config, API client; then api add and screen add work`, async () => {
        const parent = mkdtempSync(join(tmpdir(), 'codz-rn-'));
        try {
          const r = await createProject({ type: 'react-native', name: 'shop-app', parent, architecture, baseUrl: 'https://api.shop.dev', org: 'com.acme', flavor, offline: true, install: false, git: false });
          const env = readFileSync(join(r.dir, 'src/config/env.ts'), 'utf8');
          assert.match(env, flavor === 'expo' ? /process\.env\.EXPO_PUBLIC_API_URL \?\? 'https:\/\/api\.shop\.dev'/ : /export const API_URL = 'https:\/\/api\.shop\.dev';/);
          assert.match(readFileSync(join(r.dir, 'App.tsx'), 'utf8'), /<NavigationContainer>/);
          if (architecture === 'axios-react-query') assert.match(readFileSync(join(r.dir, 'App.tsx'), 'utf8'), /<QueryClientProvider client=\{queryClient\}>/);
          const pkg = JSON.parse(readFileSync(join(r.dir, 'package.json'), 'utf8'));
          assert.ok(pkg.dependencies['@react-navigation/native-stack']);
          assert.equal(Boolean(pkg.dependencies.axios), architecture !== 'fetch-helper');
          assert.equal(loadConfig(r.dir).framework, 'react-native');
          const add = await planApiAdd(r.dir, rn, { url: 'https://api.shop.dev/products', samples: [join(INPUTS, 'products.json')] });
          apply(r.dir, add.changeSet);
          const screen = await planScreenAdd(r.dir, rn, { name: 'products', api: 'getProducts' });
          assert.ok(after(screen, 'src/screens/ProductsScreen.tsx'));
          if (architecture === 'axios-react-query') assert.match(after(screen, 'src/screens/ProductsScreen.tsx')!, /useProducts\(\)/);
        } finally {
          rmSync(parent, { recursive: true, force: true });
        }
      });
    }
  }
});
