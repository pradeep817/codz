// screen add --paginate --search: reading paging parameters, and the screens for each framework.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import { applyChangeSet } from '../src/core/changeset.ts';
import type { Adapter } from '../src/core/types.ts';
import { planApiAdd } from '../src/skills/apiAdd.ts';
import { planFeatureAdd } from '../src/skills/feature.ts';
import { dartPagingCall, detectPaging, tsPagingArgs, tsPagingParams } from '../src/skills/paging.ts';
import { planScreenAdd } from '../src/skills/screen.ts';
import { cleanup, copyFixture, REPO } from './helpers.ts';

const SAMPLE = join(REPO, 'test', 'inputs', 'products.json');
const apply = (dir: string, cs: Parameters<typeof applyChangeSet>[1]) => applyChangeSet(dir, cs, { allowDirty: true, format: false, verify: false });

describe('paging parameters', () => {
  const opts = { paginate: true, search: true, modelStringFields: ['name', 'sku'], titleField: 'name' };

  it('finds page, size and search parameters, in an options object or on their own', () => {
    const ps = tsPagingParams([{ name: 'params', type: '{ page?: number; limit?: number; q?: string; category?: string }' }]);
    const p = detectPaging(ps, opts);
    assert.equal(p.page?.name, 'page');
    assert.equal(p.page?.mode, 'page');
    assert.equal(p.size?.name, 'limit');
    assert.equal(p.search?.name, 'q');
    assert.equal(p.clientSearch, false);
    const o = detectPaging([{ name: 'offset', type: 'Int?' }, { name: 'status', type: 'String?' }], opts);
    assert.equal(o.page?.mode, 'offset');
    assert.equal(o.size, undefined);
    assert.equal(o.clientSearch, true);
    assert.deepEqual(o.searchFields, ['name', 'sku']);
  });

  it('refuses --paginate without a page parameter, and --search with nothing to search', () => {
    assert.throws(() => detectPaging([{ name: 'category', type: 'string' }], opts), /no page or offset parameter/);
    assert.throws(() => detectPaging([], { search: true, modelStringFields: [] }), /no text fields/);
    assert.equal(detectPaging([{ name: 'page', type: 'number' }], { search: true, modelStringFields: ['name'] }).page, undefined, 'page is used only with --paginate');
  });

  it('writes the call in TypeScript and Dart', () => {
    const ts = [{ name: 'id', type: 'number', optional: false }, { name: 'params', type: '{ page?: number; limit?: number; q?: string }', optional: true }];
    const p = detectPaging(tsPagingParams(ts), opts);
    assert.equal(tsPagingArgs(ts, p, new Map([['id', 'Number(id)']]), { page: 'next', search: 'search || undefined' }), 'Number(id), { page: next, limit: PAGE_SIZE, q: search || undefined }');
    assert.equal(tsPagingArgs(ts, p, new Map([['id', 'Number(id)']]), { search: 'q' }), 'Number(id), { q }');
    const dart = [{ name: 'page', type: 'int?', required: false, named: true }, { name: 'q', type: 'String?', required: false, named: true }];
    const pd = detectPaging(dart, opts);
    assert.equal(dartPagingCall(dart, pd, new Map(), { page: 'next', search: '_query' }, '_pageSize'), 'page: next, q: _query');
  });
});

/** A fixture with listCatalog (page, limit, q) and listShelf (no parameters). */
async function withCatalog(fixture: string, id: keyof typeof ADAPTERS, run: (dir: string, a: Adapter) => Promise<void>, prefix = 'https://api.example.com') {
  const dir = copyFixture(fixture);
  try {
    const a = ADAPTERS[id] as Adapter;
    apply(dir, (await planApiAdd(dir, a, { url: `${prefix}/catalog?page=1&limit=20&q=lamp`, samples: [SAMPLE], name: 'listCatalog' })).changeSet);
    apply(dir, (await planApiAdd(dir, a, { url: `${prefix}/shelf`, samples: [SAMPLE], name: 'listShelf' })).changeSet);
    await run(dir, a);
  } finally {
    cleanup(dir);
  }
}

/** A fixture with the products feature (listProducts takes page and search). */
async function withProducts(fixture: string, id: keyof typeof ADAPTERS, run: (dir: string, a: Adapter) => Promise<void>) {
  const dir = copyFixture(fixture);
  try {
    const a = ADAPTERS[id] as Adapter;
    apply(dir, (await planFeatureAdd(dir, a, { name: 'products', spec: join(REPO, 'examples', 'openapi.yaml'), tests: false })).changeSet);
    await run(dir, a);
  } finally {
    cleanup(dir);
  }
}

const text = (dir: string, cs: Awaited<ReturnType<typeof planScreenAdd>>, re: RegExp) => {
  const f = cs.changes.find((c) => re.test(c.path));
  assert.ok(f, `no file matching ${re}: ${cs.changes.map((c) => c.path).join(', ')}`);
  return f.after ?? readFileSync(join(dir, f.path), 'utf8');
};

describe('paged and searchable screens', () => {
  it('Next.js: page and search in the URL, Previous / Next links', () =>
    withCatalog('nextjs-helper', 'nextjs', async (dir, a) => {
      const page = text(dir, await planScreenAdd(dir, a, { name: 'catalog', api: 'listCatalog', paginate: true, search: true }), /catalog\/page\.tsx$/);
      assert.match(page, /listCatalog\(\{ page, limit: PAGE_SIZE, q: q \|\| undefined \}\)/);
      assert.match(page, /<input type="search" name="q"/);
      assert.match(page, /Previous<\/Link>/);
      const shelf = text(dir, await planScreenAdd(dir, a, { name: 'shelf', api: 'listShelf', search: true }), /shelf\/page\.tsx$/);
      assert.match(shelf, /items\.filter\(\(item\) => \[item\.name\]/);
      await assert.rejects(planScreenAdd(dir, a, { name: 'x', api: 'listShelf', paginate: true }), /no page or offset parameter/);
    }));

  it('React Native: FlatList with onEndReached and a search box', () =>
    withCatalog('rn-app', 'react-native', async (dir, a) => {
      const screen = text(dir, await planScreenAdd(dir, a, { name: 'catalog', api: 'listCatalog', paginate: true, search: true }), /CatalogScreen\.tsx$/);
      assert.match(screen, /onEndReached=\{loadMore\}/);
      assert.match(screen, /<TextInput/);
      assert.match(screen, /if \(id !== request\.current\) return;/);
    }));

  it('React: a Load more button', () =>
    withProducts('react-vite', 'react', async (dir, a) => {
      const cs = await planScreenAdd(dir, a, { name: 'catalog', api: 'listProducts', paginate: true });
      assert.match(text(dir, cs, /CatalogPage\.tsx$/), /Load more<\/button>/);
    }));

  it('Flutter: Riverpod page, Bloc cubit and GetX controller', async () => {
    await withCatalog('flutter-riverpod', 'flutter', async (dir, a) => {
      const page = text(dir, await planScreenAdd(dir, a, { name: 'catalog', api: 'listCatalog', paginate: true, search: true }), /catalog_page\.dart$/);
      assert.match(page, /listCatalog\(page: next, limit: _pageSize, q: _query\.isEmpty \? null : _query\)/);
      assert.match(page, /addPostFrameCallback/);
    });
    await withCatalog('flutter-bloc-retrofit', 'flutter', async (dir, a) => {
      const cs = await planScreenAdd(dir, a, { name: 'catalog', api: 'listCatalog', paginate: true, search: true });
      assert.match(text(dir, cs, /catalog_cubit\.dart$/), /void search\(String text\)/);
      assert.match(text(dir, cs, /catalog_page\.dart$/), /context\.read<CatalogCubit>\(\)\.search/);
    });
    await withCatalog('flutter-getx-cli', 'flutter', async (dir, a) => {
      const cs = await planScreenAdd(dir, a, { name: 'shelf', api: 'listShelf', search: true });
      assert.match(text(dir, cs, /shelf_controller\.dart$/), /List<Shelf> get visible =>/);
      assert.match(text(dir, cs, /shelf_view\.dart$/), /onChanged: controller\.search/);
    });
  });

  it('Android (Compose) and iOS', async () => {
    await withCatalog('android-app', 'android', async (dir, a) => {
      const cs = await planScreenAdd(dir, a, { name: 'catalog', api: 'listCatalog', paginate: true, search: true });
      assert.match(text(dir, cs, /CatalogViewModel\.kt$/), /api\.listCatalog\(page = next, limit = PAGE_SIZE, q = _state\.value\.query\.trim\(\)\.ifBlank \{ null \}\)/);
      assert.match(text(dir, cs, /CatalogScreen\.kt$/), /OutlinedTextField/);
    }, 'https://api.example.com/v1');
    await withProducts('ios-swiftui', 'ios', async (dir, a) => {
      const cs = await planScreenAdd(dir, a, { name: 'catalog', api: 'listProducts', paginate: true, search: true });
      assert.match(text(dir, cs, /CatalogViewModel\.swift$/), /api\.listProducts\(page: next, search: search\.isEmpty \? nil : search\)/);
      assert.match(text(dir, cs, /CatalogView\.swift$/), /\.searchable\(text: \$model\.query\)/);
    });
  });
});
