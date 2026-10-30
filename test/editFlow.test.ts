// feature add: the edit form starts with the current values, and the detail
// screen has an Edit button that opens it (and shows the saved values after).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import type { ChangeSet } from '../src/core/types.ts';
import { detectAt } from '../src/detector.ts';
import { planFeatureAdd } from '../src/skills/feature.ts';
import { cleanup, copyFixture, REPO } from './helpers.ts';

const EXAMPLE = join(REPO, 'examples', 'openapi.yaml');
const file = (cs: ChangeSet, re: RegExp) => {
  const c = cs.changes.find((x) => re.test(x.path));
  assert.ok(c, `no change matching ${re}`);
  return (c as { after?: string }).after ?? '';
};

// fixture, edit form file, what fills it, detail file, the Edit button
const CASES: [string, RegExp, RegExp, RegExp, RegExp][] = [
  ['nextjs-helper', /products\/\[productId\]\/edit\/page\.tsx$/, /getProduct\(/, /products\/\[productId\]\/page\.tsx$/, /<Link href=\{`\/products\/\$\{productId\}\/edit`\}>Edit<\/Link>/],
  ['react-router', /EditProductPage\.tsx$/, /getProduct\(Number\(productId\)\)/, /ProductDetailPage\.tsx$/, /<Link to=\{`\/products\/\$\{productId\}\/edit`\}>Edit<\/Link>/],
  ['rn-app', /EditProductScreen\.tsx$/, /getProduct\(Number\(productId\)\)/, /ProductDetailScreen\.tsx$/, /navigation\.addListener\('focus'[\s\S]*navigation\.navigate\('EditProduct', \{ productId \}\)/],
  ['rn-expo-router', /\[productId\]\/edit\.tsx$/, /getProduct\(Number\(productId\)\)/, /products\/\[productId\]\.tsx$/, /router\.push\(`\/products\/\$\{productId\}\/edit`\)/],
  ['flutter-riverpod', /edit_product_page\.dart$/, /_load\(\)/, /product_detail_page\.dart$/, /context\.push\('\/products\/\$\{widget\.productId\}\/edit'\)\.then\(\(_\) => _reload\(\)\)/],
  ['flutter-getit', /edit_product_page\.dart$/, /_load\(\)/, /product_detail_page\.dart$/, /MaterialPageRoute\(builder: \(_\) => EditProductPage\(productId: widget\.productId\)\)\)\.then\(\(_\) => _reload\(\)\)/],
  ['flutter-bloc-retrofit', /edit_product_page\.dart$/, /_load\(\)/, /product_detail_page\.dart$/, /Builder\(\n\s+builder: \(context\) => IconButton\([\s\S]*context\.read<ProductDetailCubit>\(\)\.load\(\)/],
  ['flutter-getx-cli', /edit_product_view\.dart$/, /getProduct\(/, /product_detail_view\.dart$/, /Get\.toNamed\(Routes\.\w+, parameters: \{'productId': id\}\)\?\.then\(\(_\) => controller\.loadProduct\(int\.parse\(id\)\)\)/],
  ['android-app', /EditProductViewModel\.kt$/, /_initial\.value = try \{ api\.getProduct\(productId\.toInt\(\)\) \}/, /NavHost\.kt$/, /ProductDetailScreen\(onEdit = \{ navController\.navigate\("products\/\$\{it\.arguments\?\.getString\("productId"\)\}\/edit"\) \}\)[\s\S]*EditProductScreen\(onDone = \{ navController\.popBackStack\(\) \}\)/],
  ['android-plain', /EditProductActivity\.kt$/, /viewModel\.initial\.filterNotNull\(\)\.first\(\)\.let \{\n\s+nameInput\.setText\(it\.name\)/, /ProductDetailActivity\.kt$/, /startActivity\(Intent\(this@ProductDetailActivity, EditProductActivity::class\.java\)\.putExtra\("productId", intent\.getStringExtra\("productId"\)\)\)[\s\S]*override fun onRestart\(\)/],
  ['ios-swiftui', /EditProductView\.swift$/, /guard !loaded, let d = await model\.loadInitial\(\) else \{ return \}\n\s+loaded = true\n\s+name = d\.name/, /ProductDetailView\.swift$/, /\.toolbar \{\n\s+NavigationLink\("Edit"\) \{\n\s+EditProductView\(productId: productId\)/],
];

describe('feature add: edit flow', () => {
  for (const [fixture, formRe, fills, detailRe, button] of CASES) {
    it(`${fixture}: the edit form loads the current values; Edit on the detail screen opens it`, async () => {
      const dir = copyFixture(fixture);
      try {
        const adapter = ADAPTERS[detectAt(dir)!.framework as keyof typeof ADAPTERS];
        const r = await planFeatureAdd(dir, adapter, { name: 'products', spec: EXAMPLE, tests: false });
        assert.match(file(r.changeSet, formRe), fills);
        assert.match(file(r.changeSet, detailRe), button);
        assert.ok(r.changeSet.summary.some((s) => /"Edit" on ProductDetail opens EditProduct/.test(s)), r.changeSet.summary.join('\n'));
      } finally {
        cleanup(dir);
      }
    });
  }

  it('the create form starts empty', async () => {
    const dir = copyFixture('react-router');
    try {
      const r = await planFeatureAdd(dir, ADAPTERS.react, { name: 'products', spec: EXAMPLE, tests: false });
      assert.doesNotMatch(file(r.changeSet, /NewProductPage\.tsx$/), /Start with the current values/);
    } finally {
      cleanup(dir);
    }
  });
});
