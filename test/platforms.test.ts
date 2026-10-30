// Plain React (Vite / Create React App), Android with XML Views, and native iOS
// (SwiftUI): detection, setup, endpoints, screens and feature add.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import { applyChangeSet } from '../src/core/changeset.ts';
import type { ChangeSet } from '../src/core/types.ts';
import { detectAt } from '../src/detector.ts';
import { planApiImport } from '../src/skills/apiImport.ts';
import { planFeatureAdd } from '../src/skills/feature.ts';
import { planScreenAdd } from '../src/skills/screen.ts';
import { cleanup, copyFixture, REPO } from './helpers.ts';

const EXAMPLE = join(REPO, 'examples', 'openapi.yaml');
const apply = (dir: string, cs: ChangeSet) => applyChangeSet(dir, cs, { allowDirty: true, format: false, verify: false });
const after = (cs: ChangeSet, path: string) => {
  const c = cs.changes.find((x) => x.path === path);
  assert.ok(c, `no change to ${path}; changed: ${cs.changes.map((x) => x.path).join(', ')}`);
  return c.after ?? '';
};

describe('React (Vite)', () => {
  const react = ADAPTERS.react;

  it('is detected, and a Next.js or React Native app is not mistaken for it', () => {
    const dir = copyFixture('react-vite');
    try {
      assert.equal(detectAt(dir)?.framework, 'react');
      assert.equal(detectAt(join(REPO, 'fixtures', 'nextjs-fresh'))?.framework, 'nextjs');
      assert.equal(detectAt(join(REPO, 'fixtures', 'rn-app'))?.framework, 'react-native');
    } finally {
      cleanup(dir);
    }
  });

  it('a fresh app: setup (fetch helper, React Router, VITE_API_URL), then 4 linked pages', async () => {
    const dir = copyFixture('react-vite');
    try {
      const r = await planFeatureAdd(dir, react, { name: 'products', spec: EXAMPLE });
      assert.equal(r.setup?.architecture, 'fetch-helper');
      assert.deepEqual(r.screens.map((s) => s.kind), ['list', 'create', 'detail', 'edit']);
      const cs = r.changeSet;
      assert.match(after(cs, 'src/config/env.ts'), /import\.meta\.env\.VITE_API_URL \?\? 'https:\/\/api\.example\.com\/v1'/);
      assert.match(after(cs, 'src/App.tsx'), /<RouterProvider router=\{router\} \/>/);
      const router = after(cs, 'src/router.tsx');
      assert.match(router, /\{ path: '\/products\/:productId', element: <ProductDetailPage \/> \},/);
      assert.doesNotMatch(router, /\},\n\n/, 'no blank lines between routes');
      assert.match(after(cs, 'package.json'), /"react-router-dom"/);
      assert.match(after(cs, 'src/api/products.ts'), /apiFetch<Product\[\]>\(`\/products/);
      const list = after(cs, 'src/pages/ProductsPage.tsx');
      assert.match(list, /import \{ Link \} from 'react-router-dom';/);
      assert.match(list, /<Link to=\{`\/products\/\$\{item\.id\}`\}>/);
      assert.match(list, /<Link to="\/products\/new">New product<\/Link>/);
      assert.match(list, /data\.map\(\(item\) =>/);
      const edit = after(cs, 'src/pages/EditProductPage.tsx');
      assert.match(edit, /const \{ productId = '' \} = useParams\(\);/);
      assert.match(edit, /await updateProduct\(Number\(productId\), body\);\n {6}navigate\(-1\);/);
    } finally {
      cleanup(dir);
    }
  });

  it('an app with <Routes>: pages go into the JSX tree next to the others', async () => {
    const dir = copyFixture('react-router');
    try {
      apply(dir, (await planApiImport(dir, react, { file: EXAMPLE, only: ['getOrder'] })).changeSet);
      const cs = await planScreenAdd(dir, react, { name: 'order-details', api: 'getOrder', path: '/orders/:orderId' });
      const main = after(cs, 'src/main.tsx');
      assert.match(main, / {8}<Route path="\/team\/:teamId" element=\{<TeamPage \/>\} \/>\n {8}<Route path="\/orders\/:orderId" element=\{<OrderDetailsPage \/>\} \/>\n {6}<\/Routes>/);
      assert.match(main, /import OrderDetailsPage from '\.\/pages\/OrderDetailsPage';/);
      assert.match(after(cs, 'src/pages/OrderDetailsPage.tsx'), /setData\(await getOrder\(orderId\)\)/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('Android with XML Views', () => {
  const android = ADAPTERS.android;
  const ui = 'app/src/main/java/com/example/notes/ui/screens';

  it('feature add: setup, Activities with layouts, manifest entries, links and Gradle libraries', async () => {
    const dir = copyFixture('android-plain');
    try {
      const r = await planFeatureAdd(dir, android, { name: 'products', spec: EXAMPLE });
      assert.equal(r.setup?.architecture, 'retrofit-hilt');
      assert.deepEqual(r.screens.map((s) => s.kind), ['list', 'create', 'detail', 'edit']);
      const cs = r.changeSet;
      const list = after(cs, `${ui}/ProductsActivity.kt`);
      assert.match(list, /@AndroidEntryPoint\nclass ProductsActivity : ComponentActivity\(\) \{\n {4}private val viewModel: ProductsViewModel by viewModels\(\)/);
      assert.match(list, /startActivity\(Intent\(this, ProductDetailActivity::class\.java\)\.putExtra\("productId", item\.id\.toString\(\)\)\)/);
      assert.match(list, /startActivity\(Intent\(this, NewProductActivity::class\.java\)\)/);
      assert.match(list, /text = "New product"\n {12}isVisible = true/);
      assert.match(after(cs, 'app/src/main/res/layout/activity_products.xml'), /<androidx\.recyclerview\.widget\.RecyclerView\n {12}android:id="@\+id\/list"/);
      assert.match(after(cs, `${ui}/ProductDetailViewModel.kt`), /private val productId: String = checkNotNull\(savedStateHandle\["productId"\]\)/);
      const form = after(cs, `${ui}/EditProductActivity.kt`);
      assert.match(form, /priceInput\.text\.toString\(\)\.trim\(\)\.toDoubleOrNull\(\) \?: 0\.0/);
      assert.match(form, /setResult\(RESULT_OK\)\n {24}finish\(\)/);
      const manifest = after(cs, 'app/src/main/AndroidManifest.xml');
      for (const a of ['ProductsActivity', 'NewProductActivity', 'ProductDetailActivity', 'EditProductActivity']) assert.match(manifest, new RegExp(`<activity android:name="\\.ui\\.screens\\.${a}" android:exported="false" />`));
      const build = after(cs, 'app/build.gradle.kts');
      for (const lib of ['androidx.recyclerview:recyclerview', 'androidx.activity:activity-ktx', 'androidx.lifecycle:lifecycle-runtime-ktx']) assert.ok(build.includes(lib), lib);
      // MainActivity extends android.app.Activity, which Hilt cannot inject into: left alone, with a warning.
      assert.ok(!cs.changes.some((c) => c.path.endsWith('MainActivity.kt')));
    } finally {
      cleanup(dir);
    }
  });

  it('Koin and the service locator get the matching ViewModel delegate', async () => {
    for (const [arch, delegate] of [['retrofit-koin', 'by viewModel()'], ['retrofit', 'by viewModels { ProductsViewModel.Factory }']] as const) {
      const dir = copyFixture('android-plain');
      try {
        const r = await planFeatureAdd(dir, android, { name: 'products', spec: EXAMPLE, architecture: arch, tests: false });
        assert.ok(after(r.changeSet, `${ui}/ProductsActivity.kt`).includes(`private val viewModel: ProductsViewModel ${delegate}`), arch);
      } finally {
        cleanup(dir);
      }
    }
  });
});

describe('iOS (SwiftUI)', () => {
  const ios = ADAPTERS.ios;

  it('an Xcode project is detected; a Flutter app with ios/Runner.xcodeproj is still Flutter', () => {
    assert.equal(detectAt(join(REPO, 'fixtures', 'ios-swiftui'))?.framework, 'ios');
    assert.equal(detectAt(join(REPO, 'fixtures', 'flutter-fresh'))?.framework, 'flutter');
  });

  it('feature add: APIClient, Codable structs, SwiftUI views, links and --initial', async () => {
    const dir = copyFixture('ios-swiftui');
    try {
      const r = await planFeatureAdd(dir, ios, { name: 'products', spec: EXAMPLE, initial: true });
      assert.equal(r.setup?.architecture, 'urlsession');
      assert.deepEqual(r.screens.map((s) => s.kind), ['list', 'create', 'detail', 'edit']);
      const cs = r.changeSet;
      assert.match(after(cs, 'ShopApp/Networking/APIClient.swift'), /init\(baseURL: URL = URL\(string: "https:\/\/api\.example\.com\/v1"\)!/);
      const api = after(cs, 'ShopApp/Networking/APIClient+Products.swift');
      assert.match(api, /func getProduct\(productId: Int\) async throws -> Product \{\n {8}try await send\("GET", "\/products\/\\\(productId\)"\)/);
      assert.match(api, /func listProducts\(page: Int\? = nil, search: String\? = nil, category: String\? = nil\) async throws -> \[Product\]/);
      assert.match(api, /func deleteProduct\(productId: Int\) async throws \{\n {8}try await sendEmpty\("DELETE"/);
      const model = after(cs, 'ShopApp/Models/Product.swift');
      assert.match(model, /struct Product: Codable, Hashable, Identifiable \{/);
      assert.match(model, /case createdAt = "created_at"/);
      const list = after(cs, 'ShopApp/Views/ProductsView.swift');
      assert.match(list, /NavigationLink \{\n {24}ProductDetailView\(productId: item\.id\)\n {20}\} label: \{/);
      assert.match(list, /\.toolbar \{\n {16}NavigationLink \{\n {20}NewProductView\(\)/);
      assert.match(after(cs, 'ShopApp/Views/ProductDetailViewModel.swift'), /state = \.loaded\(try await api\.getProduct\(productId: productId\)\)/);
      const edit = after(cs, 'ShopApp/Views/EditProductView.swift');
      assert.match(edit, /price: Double\(price\.trimmingCharacters\(in: \.whitespaces\)\) \?\? 0,/);
      assert.match(edit, /if await model\.submit\(body\) \{ dismiss\(\) \}/);
      assert.match(after(cs, 'ShopApp/ShopAppApp.swift'), /WindowGroup \{\n {12}NavigationStack \{\n {16}ProductsView\(\)\n {12}\}/);
      assert.ok(cs.changes.some((c) => c.path === 'ShopApp/Views/LoadState.swift'));
    } finally {
      cleanup(dir);
    }
  });

  it('without --initial and no NavigationStack, says how to show the list', async () => {
    const dir = copyFixture('ios-swiftui');
    try {
      const r = await planFeatureAdd(dir, ios, { name: 'products', spec: EXAMPLE });
      assert.ok(r.changeSet.warnings.some((w) => /no.*NavigationStack|NavigationStack yet/.test(w)));
    } finally {
      cleanup(dir);
    }
  });

  it('a project without Xcode 16 synchronized folders is told which files to add to the target', async () => {
    const dir = copyFixture('ios-swiftui');
    try {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(dir, 'ShopApp.xcodeproj', 'project.pbxproj'), '// !$*UTF8*$!\n{\n\tobjects = {\n\t};\n}\n');
      const r = await planFeatureAdd(dir, ios, { name: 'products', spec: EXAMPLE });
      assert.ok(r.changeSet.warnings.some((w) => /to the ShopApp target in Xcode/.test(w)));
    } finally {
      cleanup(dir);
    }
  });

  it('scans endpoints and models back from the Swift files', async () => {
    const dir = copyFixture('ios-swiftui');
    try {
      apply(dir, (await planFeatureAdd(dir, ios, { name: 'products', spec: EXAMPLE, tests: false })).changeSet);
      const map = await ios.scan(dir, {});
      assert.deepEqual(map.endpoints.map((e) => `${e.method} ${e.path}`).sort(), ['DELETE /products/{productId}', 'GET /products', 'GET /products/{productId}', 'POST /products', 'PUT /products/{productId}']);
      const product = map.models.find((m) => m.name === 'Product')!;
      assert.ok(product.fields.some((f) => f.name === 'created_at' && f.type === 'String'));
      assert.ok(map.endpoints.find((e) => e.name === 'getProduct')!.calledFrom.includes('ShopApp/Views/ProductDetailViewModel.swift'));
    } finally {
      cleanup(dir);
    }
  });
});
