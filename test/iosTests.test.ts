// test add for iOS: XCTest files and a unit-test target added to the Xcode project.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import { applyChangeSet } from '../src/core/changeset.ts';
import type { Adapter } from '../src/core/types.ts';
import { createProject, type CreateOptions } from '../src/skills/create.ts';
import { planFeatureAdd } from '../src/skills/feature.ts';
import { planTestAdd } from '../src/skills/testgen.ts';
import { REPO } from './helpers.ts';

describe('test add (iOS)', () => {
  it('adds a ShopAppTests target once and writes XCTest cases with a URLProtocol stub', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'codz-iostest-'));
    try {
      const r = await createProject({ parent, name: 'shop-app', type: 'ios', architecture: 'urlsession', baseUrl: 'https://api.example.com/v1', org: 'com.acme', install: false, git: false, offline: true } as CreateOptions);
      const dir = r.dir;
      const a = ADAPTERS.ios as Adapter;
      const apply = (cs: Parameters<typeof applyChangeSet>[1]) => applyChangeSet(dir, cs, { allowDirty: true, format: false, verify: false });
      apply((await planFeatureAdd(dir, a, { name: 'products', spec: join(REPO, 'examples', 'openapi.yaml'), tests: false })).changeSet);
      apply(await planTestAdd(dir, a, { endpoints: [], all: true }));
      const pbx = readFileSync(join(dir, 'ShopApp.xcodeproj/project.pbxproj'), 'utf8');
      assert.match(pbx, /productType = "com\.apple\.product-type\.bundle\.unit-test";/);
      assert.match(pbx, /TEST_HOST = "\$\(BUILT_PRODUCTS_DIR\)\/ShopApp\.app\/\$\(BUNDLE_EXECUTABLE_FOLDER_PATH\)\/ShopApp";/);
      assert.match(pbx, /path = ShopAppTests;/);
      const t = readFileSync(join(dir, 'ShopAppTests/ProductsAPITests.swift'), 'utf8');
      assert.match(t, /@testable import ShopApp/);
      assert.match(t, /XCTAssertEqual\(StubURLProtocol\.lastRequest\?\.url\?\.path, "\/products\/1"\)/);
      assert.match(t, /api\.createProduct\(body: ProductInput\(name: /);
      assert.match(t, /catch let error as APIError \{\n\s+XCTAssertEqual\(error\.status, 500\)/);
      assert.match(readFileSync(join(dir, 'ShopAppTests/StubURLProtocol.swift'), 'utf8'), /class StubURLProtocol: URLProtocol/);
      // A second run keeps the one target.
      const again = await planTestAdd(dir, a, { endpoints: [], all: true });
      assert.ok(!again.changes.some((c) => c.path.endsWith('project.pbxproj')));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
