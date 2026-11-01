// mock serve: a local fake API from a spec or from the project's endpoints.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ADAPTERS } from '../src/adapters/index.ts';
import { applyChangeSet } from '../src/core/changeset.ts';
import { loadMap } from '../src/core/cache.ts';
import { loadConfig } from '../src/core/config.ts';
import { planFeatureAdd } from '../src/skills/feature.ts';
import { matchRoute, MockServer, mockApiFromProject, mockApiFromSpec, type MockRoute } from '../src/skills/mockServer.ts';
import { cleanup, copyFixture, REPO } from './helpers.ts';

const SPEC = join(REPO, 'examples', 'openapi.yaml');

describe('mock serve', () => {
  it('matches paths by their last segments, preferring literal matches', () => {
    const routes: MockRoute[] = [
      { method: 'GET', path: '/v1/products', response: 'Product[]', envelope: false },
      { method: 'GET', path: '/v1/products/{id}', response: 'Product', envelope: false },
      { method: 'GET', path: '/v1/orders/{id}/tracking', response: 'Tracking', envelope: false },
    ];
    assert.equal(matchRoute(routes, 'GET', '/products')?.route.path, '/v1/products');
    assert.equal(matchRoute(routes, 'GET', '/v1/products')?.route.path, '/v1/products');
    assert.equal(matchRoute(routes, 'GET', '/api/v1/products?page=2')?.route.path, '/v1/products');
    assert.deepEqual(matchRoute(routes, 'GET', '/products/7')?.params, { id: '7' });
    assert.equal(matchRoute(routes, 'GET', '/orders/3/tracking')?.route.path, '/v1/orders/{id}/tracking');
    assert.equal(matchRoute(routes, 'GET', '/users'), null);
    assert.equal(matchRoute(routes, 'POST', '/products'), null);
  });

  it('a list and its items share data: create, read, edit and delete', () => {
    const s = new MockServer(mockApiFromSpec(SPEC), { items: 3 });
    const list = s.handle('GET', '/v1/products', undefined);
    assert.equal(list.status, 200);
    assert.equal((list.body as unknown[]).length, 3);
    const rows = list.body as { id: number; name: string; price: number }[];
    assert.deepEqual(rows.map((r) => r.id), [1, 2, 3]);
    assert.notEqual(rows[0].price, rows[1].price, 'rows differ from each other');

    const created = s.handle('POST', '/products', { name: 'Chair', price: 49.5, category: 'home' });
    assert.equal(created.status, 201);
    assert.equal((created.body as { id: number }).id, 4);
    assert.equal((created.body as { name: string }).name, 'Chair');
    assert.equal((s.handle('GET', '/products', undefined).body as unknown[]).length, 4);

    const edited = s.handle('PUT', '/products/2', { name: 'Desk', price: 120, category: 'office' });
    assert.equal((edited.body as { name: string; id: number }).name, 'Desk');
    assert.equal((edited.body as { id: number }).id, 2);
    assert.equal((s.handle('GET', '/products/2', undefined).body as { name: string }).name, 'Desk');

    assert.equal(s.handle('DELETE', '/products/1', undefined).status, 204);
    assert.equal(s.handle('GET', '/products/1', undefined).status, 404);
    assert.equal((s.handle('GET', '/products', undefined).body as unknown[]).length, 3);
  });

  it('other endpoints answer with sample data; unknown paths list the routes', () => {
    const s = new MockServer(mockApiFromSpec(SPEC));
    const tracking = s.handle('GET', '/orders/9/tracking', undefined);
    assert.equal(tracking.status, 200);
    assert.ok('events' in (tracking.body as object));
    const missing = s.handle('GET', '/nope', undefined);
    assert.equal(missing.status, 404);
    assert.ok((missing.body as { routes: string[] }).routes.includes('GET /v1/products'));
  });

  it("serves a project's own endpoints over HTTP, with CORS for web apps", async () => {
    const dir = copyFixture('nextjs-helper');
    const server = { stop: async () => {} } as { stop: () => Promise<void> };
    try {
      const adapter = ADAPTERS.nextjs;
      const r = await planFeatureAdd(dir, adapter, { name: 'products', spec: SPEC, tests: false });
      applyChangeSet(dir, r.changeSet, { allowDirty: true, format: false, verify: false });
      const { map } = await loadMap(dir, adapter, loadConfig(dir).conventions, { force: true });
      const s = new MockServer(mockApiFromProject(dir, map, 'ts'), { port: 0, host: '127.0.0.1', delay: 0 });
      server.stop = () => s.stop();
      const port = await s.start();
      const res = await fetch(`http://127.0.0.1:${port}/products`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      assert.equal(((await res.json()) as unknown[]).length, 5);
      const pre = await fetch(`http://127.0.0.1:${port}/products`, { method: 'OPTIONS' });
      assert.equal(pre.status, 204);
    } finally {
      await server.stop();
      cleanup(dir);
    }
  });
});
