// GetX modules and wiring: every step of a realistic session is a golden
// file, on a project set up by devtool and on a GetX CLI project.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import { loadMap } from '../src/core/cache.ts';
import { applyChangeSet } from '../src/core/changeset.ts';
import type { ChangeSet } from '../src/core/types.ts';
import { planApiAdd } from '../src/skills/apiAdd.ts';
import { planApiWire, planModuleAdd } from '../src/skills/module.ts';
import { planSetup } from '../src/skills/setup.ts';
import { cleanup, copyFixture, golden, INPUTS } from './helpers.ts';

const flutter = ADAPTERS.flutter;
const USER = `curl 'https://api.yourapp.com/users/42' -H 'Authorization: Bearer abc'
response:
{"id": 42, "name": "Pradeep", "email": "p@x.com"}`;

function record(step: string, cs: ChangeSet): void {
  golden(`${step}/_summary.txt`, [...cs.summary.map((x) => `• ${x}`), ...cs.warnings.map((w) => `! ${w}`)].join('\n') + '\n');
  for (const c of cs.changes) golden(`${step}/${c.path}`, c.after ?? "");
}

const apply = (dir: string, cs: ChangeSet) => applyChangeSet(dir, cs, { allowDirty: true, verify: false, format: false });

async function setupGetx(fixture: string): Promise<string> {
  const dir = copyFixture(fixture);
  const { map } = await loadMap(dir, flutter, {});
  apply(dir, planSetup(dir, flutter, map, { architecture: 'getx', baseUrl: 'https://api.yourapp.com' }).changeSet);
  return dir;
}

describe('GetX modules (golden)', () => {
  it('fresh project: setup, two modules, api add --into, api wire', async () => {
    const dir = await setupGetx('flutter-fresh');
    try {
      const g = 'getx/fresh';
      let cs = await planModuleAdd(dir, flutter, { name: 'home' });
      record(`${g}/1-module-home`, cs);
      apply(dir, cs);

      cs = await planModuleAdd(dir, flutter, { name: 'profile' });
      record(`${g}/2-module-profile`, cs);
      apply(dir, cs);

      cs = (await planApiAdd(dir, flutter, { paste: USER, into: 'profile' })).changeSet;
      record(`${g}/3-api-add-into-profile`, cs);
      apply(dir, cs);

      apply(dir, (await planApiAdd(dir, flutter, { url: 'https://api.yourapp.com/products', samples: [`${INPUTS}/products.json`] })).changeSet);
      cs = await planApiWire(dir, flutter, { endpoint: 'getProducts', module: 'home' });
      record(`${g}/4-wire-products-into-home`, cs);
      apply(dir, cs);

      // Wiring the same endpoint again changes nothing.
      const again = await planApiWire(dir, flutter, { endpoint: 'getProducts', module: 'home' });
      assert.equal(again.changes.length, 0);
      assert.match(again.summary[0], /already wired/);

      // explain sees the GetX routes.
      const { map } = await loadMap(dir, flutter, {}, { force: true });
      assert.deepEqual(map.routes.map((r) => r.path), ['/home', '/profile']);
    } finally {
      cleanup(dir);
    }
  });

  it('GetX CLI project: UPPER_CASE routes, relative imports, existing onInit', async () => {
    const dir = await setupGetx('flutter-getx-cli');
    try {
      const g = 'getx/cli';
      let cs = await planModuleAdd(dir, flutter, { name: 'order_details', initial: true });
      record(`${g}/1-module-order-details`, cs);
      apply(dir, cs);

      apply(dir, (await planApiAdd(dir, flutter, { url: 'https://api.yourapp.com/products', samples: [`${INPUTS}/products.json`] })).changeSet);
      cs = await planApiWire(dir, flutter, { endpoint: 'getProducts', module: 'home' });
      record(`${g}/2-wire-products-into-home`, cs);
      const ctrl = cs.changes.find((c) => c.path.endsWith('home_controller.dart'))!.after!;
      assert.match(ctrl, /super\.onInit\(\);\n {4}loadProducts\(\);/, 'load call goes into the existing onInit');
      assert.equal((ctrl.match(/void onInit\(\)/g) ?? []).length, 1);
    } finally {
      cleanup(dir);
    }
  });

  it('a module can be created with endpoints wired in one step', async () => {
    const dir = await setupGetx('flutter-fresh');
    try {
      apply(dir, (await planApiAdd(dir, flutter, { url: 'https://api.yourapp.com/products', samples: [`${INPUTS}/products.json`] })).changeSet);
      const cs = await planModuleAdd(dir, flutter, { name: 'catalog', apis: ['getProducts'] });
      const ctrl = cs.changes.find((c) => c.path.endsWith('catalog_controller.dart'))!.after!;
      assert.match(ctrl, /final products = <ProductModel>\[\]\.obs;/);
      assert.match(ctrl, /loadProducts\(\);/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('GetX rules', () => {
  it('refuses an existing module, an unknown endpoint and a missing module', async () => {
    const dir = await setupGetx('flutter-fresh');
    try {
      apply(dir, await planModuleAdd(dir, flutter, { name: 'home' }));
      await assert.rejects(planModuleAdd(dir, flutter, { name: 'home' }), /already exists/);
      await assert.rejects(planApiWire(dir, flutter, { endpoint: 'getNothing', module: 'home' }), /No endpoint called getNothing/);
      apply(dir, (await planApiAdd(dir, flutter, { paste: USER })).changeSet);
      await assert.rejects(planApiWire(dir, flutter, { endpoint: 'getUser', module: 'settings' }), /settings module was not found/);
      await assert.rejects(planModuleAdd(dir, flutter, { name: 'class' }), /cannot be used/);
    } finally {
      cleanup(dir);
    }
  });

  it('is only offered for GetX projects', async () => {
    const dir = copyFixture('flutter-riverpod');
    try {
      await assert.rejects(planModuleAdd(dir, flutter, { name: 'home' }), /GetX projects so far/);
    } finally {
      cleanup(dir);
    }
  });

  it('does not treat a controller-only module binding as the app-wide registration point', async () => {
    const dir = copyFixture('flutter-getx-cli');
    try {
      const { map } = await loadMap(dir, flutter, {});
      assert.equal(map.conventions.di, 'none');
      assert.equal(flutter.architectures!(map)[0].id, 'getx');
    } finally {
      cleanup(dir);
    }
  });
});
