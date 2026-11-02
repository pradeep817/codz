// codz model: models from JSON with no endpoint, and --model-dir for a folder of your choice.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import { loadMap, setRunConventions } from '../src/core/cache.ts';
import { applyChangeSet } from '../src/core/changeset.ts';
import { loadConfig } from '../src/core/config.ts';
import type { Adapter } from '../src/core/types.ts';
import { normalizeModelDir, parseJsonText, planModel } from '../src/skills/model.ts';
import { cleanup, copyFixture } from './helpers.ts';

const ORDER = { data: { id: 12, status: 'shipped', total: 49.5, customer: { id: 3, name: 'Asha' }, items: [{ product_id: 7, qty: 2 }] } };
const apply = (dir: string, cs: Parameters<typeof applyChangeSet>[1]) => applyChangeSet(dir, cs, { allowDirty: true, format: false, verify: false });

async function inFixture(fixture: string, id: keyof typeof ADAPTERS, run: (dir: string, a: Adapter) => Promise<void>) {
  const dir = copyFixture(fixture);
  try {
    await run(dir, ADAPTERS[id] as Adapter);
  } finally {
    setRunConventions({});
    cleanup(dir);
  }
}

describe('model', () => {
  afterEach(() => setRunConventions({}));

  it('reads pasted JSON with a label, code fences or text around it', () => {
    assert.deepEqual(parseJsonText('response:\n{"a": 1}', 'x'), { a: 1 });
    assert.deepEqual(parseJsonText('```json\n[{"a": 1}]\n```', 'x'), [{ a: 1 }]);
    assert.deepEqual(parseJsonText('Here it is: {"a": {"b": 2}} thanks', 'x'), { a: { b: 2 } });
    assert.throws(() => parseJsonText('   ', 'The clipboard'), /The clipboard is empty/);
    assert.throws(() => parseJsonText('no json', 'x'), /does not contain JSON/);
  });

  it('checks --model-dir', () => {
    assert.equal(normalizeModelDir('./lib/features/orders/models/', 'flutter'), 'lib/features/orders/models');
    assert.equal(normalizeModelDir('src\\features\\orders\\types', 'nextjs'), 'src/features/orders/types');
    assert.throws(() => normalizeModelDir('../elsewhere', 'nextjs'), /inside the project/);
    assert.throws(() => normalizeModelDir('/abs/models', 'nextjs'), /inside the project/);
    assert.throws(() => normalizeModelDir('models', 'flutter'), /under lib\//);
    assert.throws(() => normalizeModelDir('app/models', 'android'), /source folder/);
  });

  it('writes only model files, nested models included, unwrapping {"data": ...} (Flutter, Retrofit)', () =>
    inFixture('flutter-bloc-retrofit', 'flutter', async (dir, a) => {
      const cs = await planModel(dir, a, 'Order', ORDER);
      assert.deepEqual(cs.changes.map((c) => c.path), ['lib/models/order.dart'], 'nested models go in the main file');
      const split = await planModel(dir, a, 'Order', ORDER, { split: true });
      assert.deepEqual(split.changes.map((c) => c.path).sort(), ['lib/models/customer.dart', 'lib/models/order.dart', 'lib/models/order_item.dart']);
      assert.match(cs.warnings.join('\n'), /inner object/);
      apply(dir, cs);
      const order = readFileSync(join(dir, 'lib/models/order.dart'), 'utf8');
      assert.match(order, /List<OrderItem> items/);
      assert.match(order, /abstract class Order with _\$Order[^]*abstract class Customer with _\$Customer[^]*abstract class OrderItem with _\$OrderItem/);
      assert.equal((order.match(/^part 'order\.g\.dart';$/gm) ?? []).length, 1);
      await assert.rejects(planModel(dir, a, 'Order', ORDER), /already exists/);
      const again = await planModel(dir, a, 'Order', { id: 1, code: 'X' }, { force: true });
      assert.ok(again.changes.some((c) => c.path === 'lib/models/order.dart'));
    }));

  it('--model-dir puts models (and api add models) in that folder, for that run only', () =>
    inFixture('flutter-riverpod', 'flutter', async (dir, a) => {
      setRunConventions({ modelsFolder: 'lib/features/orders/models' });
      apply(dir, await planModel(dir, a, 'Order', ORDER));
      assert.ok(existsSync(join(dir, 'lib/features/orders/models/order_model.dart')));
      setRunConventions({ modelsFolder: 'lib/zzz/models' });
      assert.equal((await loadMap(dir, a, loadConfig(dir).conventions)).map.conventions.modelsFolder, 'lib/zzz/models');
      setRunConventions({});
      assert.notEqual((await loadMap(dir, a, loadConfig(dir).conventions)).map.conventions.modelsFolder, 'lib/zzz/models', 'the override is not cached');
    }));

  it('works in Next.js, Kotlin and Swift (no API client needed)', async () => {
    await inFixture('nextjs-helper', 'nextjs', async (dir, a) => {
      const cs = await planModel(dir, a, 'order', [{ id: 1, tags: ['a'] }]);
      assert.ok(cs.changes.some((c) => c.path === 'types/order.ts'));
      assert.ok(cs.changes.every((c) => c.path.startsWith('types/')));
    });
    await inFixture('android-app', 'android', async (dir, a) => {
      setRunConventions({ modelsFolder: 'app/src/main/java/dev/fieldops/app/feature/orders/model' });
      const cs = await planModel(dir, a, 'Order', ORDER);
      apply(dir, cs);
      assert.match(readFileSync(join(dir, 'app/src/main/java/dev/fieldops/app/feature/orders/model/Order.kt'), 'utf8'), /^package dev\.fieldops\.app\.feature\.orders\.model/);
    });
    await inFixture('ios-swiftui', 'ios', async (dir, a) => {
      const cs = await planModel(dir, a, 'Order', ORDER);
      assert.deepEqual(cs.changes.map((c) => c.path), ['ShopApp/Models/Order.swift']);
      const swift = cs.changes[0].after ?? '';
      assert.match(swift, /^import Foundation\n\nstruct Order:[^]*struct Customer:[^]*struct OrderItem:/);
      assert.equal((swift.match(/^import Foundation$/gm) ?? []).length, 1);
    });
  });
});
