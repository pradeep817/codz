// codz test add --file: tests for one file, by what it is.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import { applyChangeSet } from '../src/core/changeset.ts';
import type { Adapter } from '../src/core/types.ts';
import { planFeatureAdd } from '../src/skills/feature.ts';
import { planTestFile } from '../src/skills/testFile.ts';
import { cleanup, copyFixture, REPO } from './helpers.ts';

async function withProducts(fixture: string, id: keyof typeof ADAPTERS, run: (dir: string, a: Adapter) => Promise<void>) {
  const dir = copyFixture(fixture);
  try {
    const a = ADAPTERS[id] as Adapter;
    applyChangeSet(dir, (await planFeatureAdd(dir, a, { name: 'products', spec: join(REPO, 'examples', 'openapi.yaml'), tests: false })).changeSet, { allowDirty: true, format: false, verify: false });
    await run(dir, a);
  } finally {
    cleanup(dir);
  }
}

describe('test add --file', () => {
  it('an API file gets endpoint tests; a screen gets the screen test', () =>
    withProducts('flutter-riverpod', 'flutter', async (dir, a) => {
      const api = await planTestFile(dir, a, 'lib/data/repositories/product_repository.dart');
      assert.ok(api.changes.some((c) => c.path === 'test/data/repositories/product_repository_test.dart'));
      const screen = await planTestFile(dir, a, './lib/features/product_detail/product_detail_page.dart');
      const t = screen.changes.find((c) => c.path === 'test/features/product_detail/product_detail_page_test.dart')?.after ?? '';
      assert.match(t, /const ProductDetailPage\(productId: '1'\)/, 'route parameters come from the widget');
      assert.match(t, /productRepositoryProvider\.overrideWithValue/);
      assert.match(screen.summary.join('\n'), /it calls getProduct\(\)/);
    }));

  it('an Android screen finds its ViewModel', () =>
    withProducts('android-app', 'android', async (dir, a) => {
      const cs = await planTestFile(dir, a, 'app/src/main/java/dev/fieldops/app/ui/jobs/ProductDetailScreen.kt');
      const t = cs.changes.find((c) => c.path.endsWith('ProductDetailViewModelTest.kt'))?.after ?? '';
      assert.match(t, /ProductDetailViewModel\(api, SavedStateHandle\(mapOf\("productId" to "1"\)\)\)/);
    }));

  it('other files: a test per exported function, expected values left as TODO', () =>
    withProducts('nextjs-helper', 'nextjs', async (dir, a) => {
      writeFileSync(join(dir, 'lib/format.ts'), "export function formatPrice(amount: number, currency: string): string {\n  return currency + amount.toFixed(2);\n}\nexport const isEmail = (value: string): boolean => /@/.test(value);\n");
      const cs = await planTestFile(dir, a, 'lib/format.ts');
      const t = cs.changes[0].after ?? '';
      assert.equal(cs.changes[0].path, 'lib/format.test.ts');
      assert.match(t, /const result = formatPrice\(1, "text"\);/);
      assert.match(t, /TODO: the value isEmail should return here/);
      await assert.rejects(planTestFile(dir, a, 'lib/nope.ts'), /No file lib\/nope\.ts/);
    }));
});
