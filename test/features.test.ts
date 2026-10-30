// Golden tests for api import / update / remove / rename, mocks, locales,
// theme, route add and doctor. Each step's summary and changed files are
// golden files, applied in order like a real session.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import { loadMap } from '../src/core/cache.ts';
import { applyChangeSet } from '../src/core/changeset.ts';
import { planSetup } from '../src/skills/setup.ts';
import { jsonSet } from '../src/core/jsonEdit.ts';
import { ToolError, type ChangeSet } from '../src/core/types.ts';
import { planApiRemove, planApiRename, planApiUpdate } from '../src/skills/apiEdit.ts';
import { planApiImport } from '../src/skills/apiImport.ts';
import { renderDoctor, runDoctor } from '../src/skills/doctor.ts';
import { planLocaleAdd, planLocaleKey } from '../src/skills/locale.ts';
import { planMockAdd } from '../src/skills/mock.ts';
import { planRouteAdd } from '../src/skills/route.ts';
import { parseToken, planThemeSet } from '../src/skills/theme.ts';
import { cleanup, copyFixture, golden, INPUTS } from './helpers.ts';

const { flutter, nextjs } = ADAPTERS;

function record(step: string, cs: ChangeSet): void {
  golden(`${step}/_summary.txt`, [...cs.summary.map((x) => `• ${x}`), ...cs.warnings.map((w) => `! ${w}`)].join('\n') + '\n');
  for (const c of cs.changes) golden(`${step}/${c.path}`, c.after ?? "");
}

const apply = (dir: string, cs: ChangeSet) => applyChangeSet(dir, cs, { allowDirty: true, verify: false, format: false });

async function rejects(p: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => e instanceof ToolError && e.code === code);
}

describe('api import / update / remove / rename (golden)', () => {
  it('GetX CLI project: OpenAPI import, then edit endpoints', async () => {
    const dir = copyFixture('flutter-getx-cli');
    try {
      const g = 'features/getx-api';
      const r = await planApiImport(dir, flutter, { file: join(INPUTS, 'shop-openapi.yaml') });
      record(`${g}/1-import-openapi`, r.changeSet);
      assert.ok(r.added.includes('listUsers') && r.added.includes('getUser'));
      apply(dir, r.changeSet);

      // Importing again adds nothing.
      const again = await planApiImport(dir, flutter, { file: join(INPUTS, 'shop-openapi.yaml') });
      assert.equal(again.added.length, 0);

      writeFileSync(join(dir, 'user-v2.json'), JSON.stringify({ id: 7, name: 'Bo', email: 'b@x.com', created_at: '2026-01-02T00:00:00Z', role: 'admin', phone: '+91 99999' }));
      const up = await planApiUpdate(dir, flutter, 'getUser', [join(dir, 'user-v2.json')]);
      record(`${g}/2-update-getUser`, up.changeSet);
      assert.deepEqual(up.changes.added, ['phone']);
      apply(dir, up.changeSet);

      let cs = await planApiRename(dir, flutter, 'listUsers', 'fetchUsers');
      record(`${g}/3-rename-listUsers`, cs);
      apply(dir, cs);

      cs = await planApiRemove(dir, flutter, 'deleteUser');
      record(`${g}/4-remove-deleteUser`, cs);
      apply(dir, cs);
      await rejects(planApiRemove(dir, flutter, 'deleteUser'), 'no_endpoint');
    } finally {
      cleanup(dir);
    }
  });

  it('Next.js: Swagger 2 and Postman imports', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      let r = await planApiImport(dir, nextjs, { file: join(INPUTS, 'petstore-swagger.json') });
      record('features/nextjs-api/1-import-swagger', r.changeSet);
      apply(dir, r.changeSet);
      r = await planApiImport(dir, nextjs, { file: join(INPUTS, 'shop-postman.json') });
      record('features/nextjs-api/2-import-postman', r.changeSet);
      apply(dir, r.changeSet);
    } finally {
      cleanup(dir);
    }
  });

  it('import filters by tag and name', async () => {
    const dir = copyFixture('flutter-getx-cli');
    try {
      const r = await planApiImport(dir, flutter, { file: join(INPUTS, 'shop-openapi.yaml'), only: ['getOrder'] });
      assert.deepEqual(r.added, ['getOrder']);
      await rejects(planApiImport(dir, flutter, { file: join(INPUTS, 'shop-openapi.yaml'), tags: ['nope'] }), 'no_endpoints');
    } finally {
      cleanup(dir);
    }
  });
});

describe('mock add (golden)', () => {
  it('GetX: interceptor + responses for every endpoint', async () => {
    const dir = copyFixture('flutter-fresh');
    try {
      const { map } = await loadMap(dir, flutter, {});
      apply(dir, planSetup(dir, flutter, map, { architecture: 'getx', baseUrl: 'https://api.yourapp.com' }).changeSet);
      apply(dir, (await planApiImport(dir, flutter, { file: join(INPUTS, 'shop-openapi.yaml') })).changeSet);
      const cs = await planMockAdd(dir, flutter, { endpoints: [], all: true });
      record('features/mock/getx-all', cs);
      apply(dir, cs);
      // Adding again only re-plans responses; the interceptor is registered once.
      const again = await planMockAdd(dir, flutter, { endpoints: ['getUser'], all: false });
      const client = again.changes.find((c) => c.path.endsWith('api_client.dart'));
      assert.equal(client, undefined);
    } finally {
      cleanup(dir);
    }
  });

  it('Next.js: mocks.ts + apiFetch hook, sample as the response', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      const cs = await planMockAdd(dir, nextjs, { endpoints: ['getUser'], all: false, sample: join(INPUTS, 'user.json') });
      record('features/mock/nextjs-getUser', cs);
    } finally {
      cleanup(dir);
    }
  });
});

describe('locale add / key (golden)', () => {
  it('next-intl JSON: nested keys keep the file format', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      let cs = await planLocaleKey(dir, nextjs, 'cart.empty', 'Your cart is empty', { values: new Map([['hi', 'आपकी कार्ट खाली है']]) });
      record('features/locale/json-1-key', cs);
      apply(dir, cs);
      cs = await planLocaleAdd(dir, nextjs, 'fr');
      record('features/locale/json-2-add-fr', cs);
      apply(dir, cs);
      await rejects(planLocaleKey(dir, nextjs, 'cart.empty', 'x'), 'key_exists');
      await rejects(planLocaleKey(dir, nextjs, 'cart', 'x'), 'key_conflict');
      await rejects(planLocaleAdd(dir, nextjs, 'fr'), 'locale_exists');
    } finally {
      cleanup(dir);
    }
  });

  it('Flutter ARB: identifier keys and placeholders', async () => {
    const dir = copyFixture('flutter-riverpod');
    try {
      let cs = await planLocaleKey(dir, flutter, 'welcome-user', 'Welcome {name}');
      record('features/locale/arb-1-key', cs);
      apply(dir, cs);
      cs = await planLocaleAdd(dir, flutter, 'fr');
      record('features/locale/arb-2-add-fr', cs);
    } finally {
      cleanup(dir);
    }
  });

  it('GetX: creates AppTranslations and wires GetMaterialApp', async () => {
    const dir = copyFixture('flutter-getx-cli');
    try {
      let cs = await planLocaleKey(dir, flutter, 'home.title', 'Welcome');
      record('features/locale/getx-1-first-key', cs);
      apply(dir, cs);
      cs = await planLocaleAdd(dir, flutter, 'hi');
      record('features/locale/getx-2-add-hi', cs);
      apply(dir, cs);
      cs = await planLocaleKey(dir, flutter, 'cart.empty', "It's empty", { values: new Map([['hi', 'कार्ट खाली है']]) });
      record('features/locale/getx-3-key-with-value', cs);
      apply(dir, cs);
      cs = await planLocaleKey(dir, flutter, 'home.title', 'Welcome back', { force: true });
      record('features/locale/getx-4-replace', cs);
    } finally {
      cleanup(dir);
    }
  });
});

describe('theme set (golden)', () => {
  it('reads the kind from the value', () => {
    assert.equal(parseToken('primary', '#6750A4').kind, 'color');
    assert.equal(parseToken('primary', 'abc').value, 'AABBCC');
    assert.equal(parseToken('radius', '12').kind, 'size');
    assert.equal(parseToken('font', 'Inter').kind, 'font');
    assert.throws(() => parseToken('x', '!!'), ToolError);
  });

  it('Flutter template app: AppColors, AppSizes, AppTheme replaces the template theme', async () => {
    const dir = copyFixture('flutter-fresh');
    try {
      let cs = await planThemeSet(dir, flutter, [{ name: 'primary', value: '#6750A4' }, { name: 'radius', value: '12' }, { name: 'font', value: 'Inter' }]);
      record('features/theme/flutter-fresh-1', cs);
      apply(dir, cs);
      cs = await planThemeSet(dir, flutter, [{ name: 'primary', value: '#0F766E' }]);
      record('features/theme/flutter-fresh-2-update', cs);
    } finally {
      cleanup(dir);
    }
  });

  it('GetX and go_router apps get theme: AppTheme.light', async () => {
    for (const fixture of ['flutter-getx-cli', 'flutter-riverpod']) {
      const dir = copyFixture(fixture);
      try {
        record(`features/theme/${fixture}`, await planThemeSet(dir, flutter, [{ name: 'primary', value: '#0F766E' }]));
      } finally {
        cleanup(dir);
      }
    }
  });

  it('Next.js: Tailwind v4 @theme, Tailwind v3 config, plain CSS variables', async () => {
    const dir = copyFixture('nextjs-fresh');
    try {
      record('features/theme/nextjs-css', await planThemeSet(dir, nextjs, [{ name: 'primary', value: '#6750A4' }, { name: 'radius', value: '8' }]));

      writeFileSync(join(dir, 'app/globals.css'), '@import "tailwindcss";\n\n:root {\n  --background: #ffffff;\n}\n');
      record('features/theme/nextjs-tailwind4', await planThemeSet(dir, nextjs, [{ name: 'primary', value: '#6750A4' }, { name: 'font', value: 'Inter' }]));

      writeFileSync(join(dir, 'app/globals.css'), '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n');
      writeFileSync(join(dir, 'tailwind.config.ts'), "import type { Config } from 'tailwindcss';\n\nconst config: Config = {\n  content: ['./app/**/*.{ts,tsx}'],\n  theme: {\n    extend: {},\n  },\n  plugins: [],\n};\nexport default config;\n");
      record('features/theme/nextjs-tailwind3', await planThemeSet(dir, nextjs, [{ name: 'primary', value: '#6750A4' }, { name: 'radius', value: '12' }]));
    } finally {
      cleanup(dir);
    }
  });
});

describe('route add (golden)', () => {
  it('go_router: page + GoRoute with a path parameter', async () => {
    const dir = copyFixture('flutter-riverpod');
    try {
      const cs = await planRouteAdd(dir, flutter, { name: 'order-details', path: '/orders/:orderId' });
      record('features/route/go-router', cs);
      apply(dir, cs);
      await rejects(planRouteAdd(dir, flutter, { name: 'order-details', path: '/orders/:orderId' }), 'route_exists');
    } finally {
      cleanup(dir);
    }
  });

  it('Navigator: page + MaterialApp routes', async () => {
    const dir = copyFixture('flutter-fresh');
    try {
      record('features/route/navigator', await planRouteAdd(dir, flutter, { name: 'settings' }));
    } finally {
      cleanup(dir);
    }
  });

  it('GetX: a module', async () => {
    const dir = copyFixture('flutter-getx-cli');
    try {
      const cs = await planRouteAdd(dir, flutter, { name: 'settings' });
      assert.equal(cs.skill, 'route add');
      assert.ok(cs.changes.some((c) => c.path === 'lib/app/modules/settings/views/settings_view.dart'));
    } finally {
      cleanup(dir);
    }
  });

  it('Next.js App Router pages', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      record('features/route/nextjs-dynamic', await planRouteAdd(dir, nextjs, { name: 'order-details', path: '/orders/:id' }));
      record('features/route/nextjs-static', await planRouteAdd(dir, nextjs, { name: 'settings' }));
    } finally {
      cleanup(dir);
    }
  });
});

describe('doctor', () => {
  it('finds locale gaps, unhandled calls, hardcoded URLs and unused models', async () => {
    const dir = copyFixture('nextjs-helper');
    try {
      const en = join(dir, 'messages/en.json');
      writeFileSync(en, jsonSet(readFileSync(en, 'utf8'), ['cart', 'empty'], 'Empty'));
      writeFileSync(join(dir, 'components/Hardcoded.tsx'), "'use client';\nexport async function load() {\n  return fetch('https://api.example.com/v1/items');\n}\n");
      const r = await runDoctor(dir, nextjs);
      golden('features/doctor/nextjs-helper.txt', renderDoctor(r, false) + '\n');
      assert.ok(r.counts.error >= 1, 'missing hi key is an error');
      assert.ok(r.findings.some((f) => f.check === 'urls' && f.file === 'components/Hardcoded.tsx'));
    } finally {
      cleanup(dir);
    }
  });

  it('Flutter: FutureBuilder without error handling', async () => {
    const dir = copyFixture('flutter-getit');
    try {
      const r = await runDoctor(dir, flutter);
      golden('features/doctor/flutter-getit.txt', renderDoctor(r, false) + '\n');
      assert.equal(r.counts.error, 0);
    } finally {
      cleanup(dir);
    }
  });

  it('a try/catch call is not reported', async () => {
    const dir = copyFixture('flutter-getit');
    try {
      writeFileSync(join(dir, 'lib/screens/jobs_screen.dart'), "import 'package:field_ops/di.dart';\nimport 'package:field_ops/services/job_service.dart';\n\nFuture<void> load() async {\n  try {\n    await getIt<JobService>().getJobs();\n  } catch (e) {\n    print(e);\n  }\n}\n");
      const r = await runDoctor(dir, flutter, { only: ['api'] });
      assert.equal(r.findings.filter((f) => f.check === 'api' && f.file === 'lib/screens/jobs_screen.dart').length, 0);
    } finally {
      cleanup(dir);
    }
  });
});

describe('jsonSet', () => {
  it('keeps formatting and nests new keys', () => {
    const t = '{\n    "a": { "b": "x" },\n    "c": 1\n}\n';
    assert.equal(jsonSet(t, ['a', 'd'], 'y'), '{\n    "a": { "b": "x", "d": "y" },\n    "c": 1\n}\n');
    assert.equal(jsonSet(t, ['c'], 2), '{\n    "a": { "b": "x" },\n    "c": 2\n}\n');
    assert.equal(jsonSet('{}', ['k'], 'v'), '{\n  "k": "v"\n}');
    assert.throws(() => jsonSet(t, ['c', 'x'], 'v'), ToolError);
  });
});
