// field add / field remove: one field in an existing model, in each language's model styles.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import { applyChangeSet } from '../src/core/changeset.ts';
import { loadMap } from '../src/core/cache.ts';
import { loadConfig } from '../src/core/config.ts';
import type { Adapter } from '../src/core/types.ts';
import { planFeatureAdd } from '../src/skills/feature.ts';
import { parseFieldArg, planFieldAdd, planFieldRemove } from '../src/skills/field.ts';
import { cleanup, copyFixture, REPO } from './helpers.ts';

const SPEC = join(REPO, 'examples', 'openapi.yaml');
const apply = (dir: string, cs: Parameters<typeof applyChangeSet>[1]) => applyChangeSet(dir, cs, { allowDirty: true, format: false, verify: false });

/** A fixture with the products feature, the Product model's file, and the adapter. */
async function withProducts(fixture: string, id: keyof typeof ADAPTERS, run: (dir: string, a: Adapter, file: string) => Promise<void>) {
  const dir = copyFixture(fixture);
  try {
    const a = ADAPTERS[id] as Adapter;
    apply(dir, (await planFeatureAdd(dir, a, { name: 'products', spec: SPEC, tests: false })).changeSet);
    const { map } = await loadMap(dir, a, loadConfig(dir).conventions, { force: true });
    const m = map.models.find((x) => x.name === 'Product' || x.name === 'ProductModel')!;
    await run(dir, a, m.file);
  } finally {
    cleanup(dir);
  }
}

describe('field add / remove', () => {
  it('reads name:type with ? for optional, lists and models', async () => {
    const map = { models: [{ name: 'CategoryModel', file: 'x', fields: [] }], conventions: { modelClassSuffix: 'Model' } } as never;
    assert.deepEqual(parseFieldArg('rating:double?', map), { jsonName: 'rating', type: { kind: 'double' }, nullable: true });
    assert.deepEqual(parseFieldArg('note', map), { jsonName: 'note', type: { kind: 'string' }, nullable: false });
    assert.deepEqual(parseFieldArg('tags?:string[]', map).type, { kind: 'array', item: { kind: 'string' } });
    assert.deepEqual(parseFieldArg('cats:list<category>', map).type, { kind: 'array', item: { kind: 'object', model: 'CategoryModel' } });
    assert.throws(() => parseFieldArg('x:Widget', map), /Unknown type "Widget"/);
  });

  it('TypeScript: adds properties in the interface style, removes one and lists the lines that use it', () =>
    withProducts('nextjs-helper', 'nextjs', async (dir, a, file) => {
      const cs = await planFieldAdd(dir, a, 'product', ['discount_price:double?', 'seller']);
      apply(dir, cs);
      const t = readFileSync(join(dir, file), 'utf8');
      assert.match(t, /  discount_price\?: number \| null;\n  seller: string;\n\}/);
      assert.ok(cs.summary.some((s) => /used in \d+ files/.test(s)));
      await assert.rejects(planFieldAdd(dir, a, 'Product', ['seller']), /already has seller/);
      await assert.rejects(planFieldAdd(dir, a, 'Nope', ['x']), /No model called Nope/);
      const rm = await planFieldRemove(dir, a, 'Product', ['in_stock']);
      apply(dir, rm);
      assert.doesNotMatch(readFileSync(join(dir, file), 'utf8'), /in_stock/);
      assert.match(rm.warnings.join('\n'), /still use in_stock/);
    }));

  it('Dart (plain): constructor, fromJson, field and toJson', () =>
    withProducts('flutter-riverpod', 'flutter', async (dir, a, file) => {
      apply(dir, await planFieldAdd(dir, a, 'Product', ['discount_price:double?', 'released_at:date']));
      const t = readFileSync(join(dir, file), 'utf8');
      assert.match(t, /    this\.discountPrice,\n    required this\.releasedAt,\n  \}\);/);
      assert.match(t, /discountPrice: \(json\['discount_price'\] as num\?\)\?\.toDouble\(\),\n        releasedAt: DateTime\.parse\(json\['released_at'\] as String\),\n      \);/);
      assert.match(t, /  final double\? discountPrice;\n  final DateTime releasedAt;\n/);
      assert.match(t, /'released_at': releasedAt\.toIso8601String\(\),\n      \};/);
      apply(dir, await planFieldRemove(dir, a, 'ProductModel', ['released_at']));
      assert.doesNotMatch(readFileSync(join(dir, file), 'utf8'), /releasedAt|released_at/);
    }));

  it('Dart (freezed and json_serializable): parameters and @JsonKey', async () => {
    await withProducts('flutter-bloc-retrofit', 'flutter', async (dir, a, file) => {
      const cs = await planFieldAdd(dir, a, 'Product', ['discount_price:double?']);
      apply(dir, cs);
      assert.match(readFileSync(join(dir, file), 'utf8'), /    @JsonKey\(name: 'discount_price'\) double\? discountPrice,\n  \}\) = _Product;/);
      assert.match(cs.warnings.join('\n'), /build_runner/);
      apply(dir, await planFieldRemove(dir, a, 'Product', ['discount_price', 'in_stock']));
      assert.doesNotMatch(readFileSync(join(dir, file), 'utf8'), /discount|inStock|in_stock/);
    });
    await withProducts('flutter-getit', 'flutter', async (dir, a, file) => {
      apply(dir, await planFieldAdd(dir, a, 'Product', ['discount_price:double?']));
      assert.match(readFileSync(join(dir, file), 'utf8'), /  @JsonKey\(name: 'discount_price'\)\n  final double\? discountPrice;/);
    });
  });

  it('Kotlin: a constructor parameter with the serializer annotation', () =>
    withProducts('android-plain', 'android', async (dir, a, file) => {
      apply(dir, await planFieldAdd(dir, a, 'Product', ['discount_price:double?', 'seller']));
      const t = readFileSync(join(dir, file), 'utf8');
      assert.match(t, /    @SerialName\("discount_price"\) val discountPrice: Double\? = null,\n    val seller: String,\n\)/);
      apply(dir, await planFieldRemove(dir, a, 'Product', ['seller']));
      assert.doesNotMatch(readFileSync(join(dir, file), 'utf8'), /seller/);
    }));

  it('Swift: a property and its CodingKeys case, creating CodingKeys when a key needs one', () =>
    withProducts('ios-swiftui', 'ios', async (dir, a, file) => {
      apply(dir, await planFieldAdd(dir, a, 'Product', ['discount_price:double?']));
      let t = readFileSync(join(dir, file), 'utf8');
      assert.match(t, /    let discountPrice: Double\?\n/);
      assert.match(t, /        case discountPrice = "discount_price"\n    \}/);
      await assert.rejects(planFieldAdd(dir, a, 'Product', ['meta:any']), /concrete type/);
      // A struct without CodingKeys gets them, listing the existing properties.
      writeFileSync(join(dir, file), 'import Foundation\n\nstruct Product: Codable, Hashable, Identifiable {\n    let id: Int\n    let name: String\n}\n');
      apply(dir, await planFieldAdd(dir, a, 'Product', ['released_at:date']));
      t = readFileSync(join(dir, file), 'utf8');
      assert.match(t, /    let releasedAt: String\n/);
      assert.match(t, /enum CodingKeys: String, CodingKey \{\n        case id\n        case name\n        case releasedAt = "released_at"\n    \}/);
    }));
});
